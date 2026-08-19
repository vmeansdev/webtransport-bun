/**
 * The liveness contract for `server.close()`.
 *
 * A server whose peers vanished mid-backlog must still let its process end.
 * The failure this guards against is not an error — it is silence: `close()`
 * resolves, the endpoint is gone, no socket is open, and the process stays
 * alive because an unsettled N-API promise still references the host event
 * loop. Only a real process can prove the absence of that reference, so the
 * regression runs in a child and asserts the child exits on its own.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, E_SERVER_CLOSING } from "../src/index.js";
import {
	createServerCloseContract,
	SERVER_CLOSING_CLOSE_CODE,
	SERVER_CLOSING_CLOSE_REASON,
} from "../src/server-close.js";
import type { CloseInfo } from "../src/types.js";
import { generateCertForNames } from "./helpers/certs.js";

const ROOT = new URL("../../..", import.meta.url).pathname;
const PUBLIC_MODULE = new URL("../src/index.ts", import.meta.url).pathname;
const CERTS_MODULE = new URL("./helpers/certs.ts", import.meta.url).pathname;
// Native close spends at most 5s draining plus 5s aborting; the JS callback
// drain adds at most 5s. A process that has not exited well past that is
// pinned, not slow.
const CHILD_EXIT_BUDGET_MS = 40_000;

function childClientScript(): string {
	return `
import { connect } from ${JSON.stringify(PUBLIC_MODULE)};

const port = Number(process.env.LIVENESS_PORT);
const payload = new Uint8Array(1150);
for (let i = 0; i < 8; i++) {
	const session = await connect("https://127.0.0.1:" + port + "/liveness", {
		tls: { insecureSkipVerify: true },
	});
	void (async () => {
		for (;;) await session.sendDatagram(payload);
	})().catch(() => {});
}
setInterval(() => {}, 1000);
`;
}

function childServerScript(clientScript: string): string {
	return `
import { createServer } from ${JSON.stringify(PUBLIC_MODULE)};
import { generateCertForNames } from ${JSON.stringify(CERTS_MODULE)};

const cert = generateCertForNames(["localhost", "127.0.0.1"]);
if (!cert) throw new Error("cert generation failed");

let received = 0;
const server = createServer({
	port: 0,
	host: "127.0.0.1",
	tls: { certPem: cert.certPem, keyPem: cert.keyPem },
	limits: { maxSessions: 64, maxHandshakesInFlight: 64 },
	onSession: (session) => {
		void (async () => {
			for await (const _dg of session.incomingDatagrams()) received++;
		})().catch(() => {});
	},
});

const client = Bun.spawn([process.execPath, ${JSON.stringify(clientScript)}], {
	env: {
		...process.env,
		LIVENESS_PORT: String(server.address.port),
		WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
	},
	stdout: "ignore",
	stderr: "ignore",
});

// Let a real backlog build, then take the peer away without a close frame.
await Bun.sleep(2500);
client.kill(9);
await client.exited;

await server.close();
const snap = server.metricsSnapshot();
cert.cleanup();
console.log("__RESULT__" + JSON.stringify({
	received,
	nativeAsyncOpsPending: snap.nativeAsyncOpsPending ?? null,
	nativeSessionRegistryEntries: snap.nativeSessionRegistryEntries ?? null,
	sessionsClosedByReap: snap.sessionsClosedByReap ?? null,
}));
// Deliberately no process.exit(): the point of the test is that nothing is
// left holding the event loop.
`;
}

describe("server close terminal contract", () => {
	it("lets the process exit after a peer vanishes mid-backlog", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wt-liveness-"));
		const script = join(dir, "server.ts");
		const clientScript = join(dir, "client.ts");
		await Bun.write(clientScript, childClientScript());
		await Bun.write(script, childServerScript(clientScript));
		const proc = Bun.spawn([process.execPath, script], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
			},
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const exited = await Promise.race([
				proc.exited,
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), CHILD_EXIT_BUDGET_MS);
				}),
			]);
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			if (exited === "timeout") {
				proc.kill(9);
				throw new Error(
					`server process did not exit within ${CHILD_EXIT_BUDGET_MS}ms after close()\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				);
			}
			expect(exited).toBe(0);
			const line = stdout
				.split("\n")
				.find((l) => l.startsWith("__RESULT__"))
				?.slice("__RESULT__".length);
			expect(line).toBeDefined();
			const result = JSON.parse(line as string) as {
				received: number;
				nativeAsyncOpsPending: number | null;
				nativeSessionRegistryEntries: number | null;
				sessionsClosedByReap: number | null;
			};
			expect(result.received).toBeGreaterThan(0);
			// close() resolved, so by contract nothing this server owned is
			// still unsettled — the exit above is the same statement observed
			// from outside.
			expect(result.nativeAsyncOpsPending).toBe(0);
			expect(result.nativeSessionRegistryEntries).toBe(0);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("pins the documented shutdown close pair", () => {
		// These two values are wire-visible and documented in docs/SPEC.md
		// ("Server shutdown close semantics"). Every other assertion in this
		// file compares against the constants, which would happily follow a
		// silent edit; this one is the literal the peer actually reads, so
		// moving it fails here and forces the SPEC/CHANGELOG entry to move too.
		expect(SERVER_CLOSING_CLOSE_CODE).toBe(3993);
		expect(SERVER_CLOSING_CLOSE_REASON).toBe("E_SERVER_CLOSING");
		// The reason string is also the stable code exported from the root
		// entrypoint — one source, not two strings that happen to match.
		expect(SERVER_CLOSING_CLOSE_REASON).toBe(E_SERVER_CLOSING);
	});

	it("reports reaped sessions with a distinct close reason", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		expect(cert).not.toBeNull();
		if (!cert) return;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			onSession: () => {},
		});
		try {
			const session = await connect(
				`https://127.0.0.1:${server.address.port}/reap`,
				{ tls: { insecureSkipVerify: true } },
			);
			const closed = session.closed;
			await server.close();
			const info = await closed;
			expect(info.code).toBe(SERVER_CLOSING_CLOSE_CODE);
			expect(info.reason).toBe(SERVER_CLOSING_CLOSE_REASON);
			const snap = server.metricsSnapshot();
			expect(snap.sessionsClosedByReap ?? 0).toBeGreaterThan(0);
			expect(snap.sessionsClosedByIdle ?? 0).toBe(0);
			expect(snap.nativeAsyncOpsPending ?? 0).toBe(0);
		} finally {
			await server.close();
			cert.cleanup();
		}
	}, 30_000);
});

describe("promise-free datagram send", () => {
	/**
	 * Round 2's finding, as an assertion: a send that has queue budget must not
	 * create an N-API promise. Each of those promises is a ThreadsafeFunction,
	 * which is a reference on the host event loop that this addon can neither
	 * see nor release — the class that kept a driver alive for two hours after
	 * `close()` had already reported a clean shutdown. `datagramSendsAsync` is
	 * the exposure meter, and on a healthy echo it has to read zero.
	 */
	it("echoes without taking the parking N-API path", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		expect(cert).not.toBeNull();
		if (!cert) return;
		let echoed = 0;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			onSession: (session) => {
				void (async () => {
					for await (const datagram of session.incomingDatagrams()) {
						await session.sendDatagram(datagram);
						echoed++;
					}
				})().catch(() => {});
			},
		});
		try {
			const session = await connect(
				`https://127.0.0.1:${server.address.port}/echo`,
				{ tls: { insecureSkipVerify: true } },
			);
			const payload = new Uint8Array(512);
			for (let i = 0; i < 200; i++) await session.sendDatagram(payload);
			const deadline = Date.now() + 10_000;
			while (echoed < 50 && Date.now() < deadline) await Bun.sleep(20);
			expect(echoed).toBeGreaterThan(0);
			const snap = server.metricsSnapshot();
			expect(snap.datagramSendsAsync ?? -1).toBe(0);
			session.close();
		} finally {
			await server.close();
			cert.cleanup();
		}
	}, 30_000);

	/**
	 * The batched send takes the promise path by construction — it is a
	 * `spawn_future`, not a synchronous quinn call — so it is exactly the
	 * exposure `datagramSendsAsync` exists to report. It counted nothing,
	 * leaving a batching server reading a flat zero while every one of its
	 * datagrams held an N-API promise.
	 */
	it("counts batched sends on the exposure meter", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		expect(cert).not.toBeNull();
		if (!cert) return;
		let sent = 0;
		const BATCH = 300;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			onSession: (session) => {
				void (async () => {
					const batch = Array.from({ length: BATCH }, () => new Uint8Array(64));
					const res = await session.sendDatagramBatch(batch);
					sent = res.sent;
				})().catch(() => {});
			},
		});
		try {
			const session = await connect(
				`https://127.0.0.1:${server.address.port}/batch`,
				{ tls: { insecureSkipVerify: true } },
			);
			const deadline = Date.now() + 10_000;
			while (sent === 0 && Date.now() < deadline) await Bun.sleep(20);
			expect(sent).toBeGreaterThan(0);
			const snap = server.metricsSnapshot();
			// One per element, matching how the single-send path counts, and
			// the array was long enough to be split across crossings.
			expect(snap.datagramSendsAsync ?? 0).toBeGreaterThanOrEqual(sent);
			session.close();
		} finally {
			await server.close();
			cert.cleanup();
		}
	}, 30_000);
});

describe("createServerCloseContract", () => {
	it("resolves sessions only after the native close and drains callbacks", async () => {
		const order: string[] = [];
		let pending = 1;
		let releaseDrain!: () => void;
		const close = createServerCloseContract({
			closeNative: async () => {
				await Bun.sleep(10);
				order.push("native");
			},
			resolveOwnedSessions: (info) => {
				order.push(`sessions:${info.code}:${info.reason}`);
			},
			pendingOnSessionCallbacks: () => pending,
			awaitOnSessionDrain: () =>
				new Promise<void>((resolve) => {
					releaseDrain = () => {
						pending = 0;
						order.push("drained");
						resolve();
					};
				}),
			drainTimeoutMs: 5000,
		});
		const closing = close();
		await Bun.sleep(40);
		releaseDrain();
		await closing;
		expect(order).toEqual([
			"native",
			`sessions:${SERVER_CLOSING_CLOSE_CODE}:${SERVER_CLOSING_CLOSE_REASON}`,
			"drained",
		]);
	});

	it("is bounded when callbacks never return", async () => {
		const close = createServerCloseContract({
			closeNative: async () => {},
			resolveOwnedSessions: () => {},
			pendingOnSessionCallbacks: () => 1,
			awaitOnSessionDrain: () => new Promise<void>(() => {}),
			drainTimeoutMs: 50,
		});
		const started = Date.now();
		await close();
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("runs once however often it is called", async () => {
		let nativeCloses = 0;
		const close = createServerCloseContract({
			closeNative: async () => {
				nativeCloses++;
				await Bun.sleep(10);
			},
			resolveOwnedSessions: () => {},
			pendingOnSessionCallbacks: () => 0,
			awaitOnSessionDrain: () => Promise.resolve(),
		});
		await Promise.all([close(), close()]);
		await close();
		expect(nativeCloses).toBe(1);
	});

	/**
	 * A failing native close used to be terminal in two ways at once: it
	 * skipped `resolveOwnedSessions`, so every session's `closed` promise hung
	 * forever, and the rejected promise was memoized, so `close()` could never
	 * be retried. Adding `pending_async_ops` to the idle predicate made that
	 * rejection reachable for any never-settling handle promise, which is a
	 * strictly larger set of cases than before.
	 */
	it("resolves owned sessions and stays retryable when the native close fails", async () => {
		let attempts = 0;
		const resolved: CloseInfo[] = [];
		const close = createServerCloseContract({
			closeNative: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("still draining: 2 pending");
			},
			resolveOwnedSessions: (info) => {
				resolved.push(info);
			},
			pendingOnSessionCallbacks: () => 0,
			awaitOnSessionDrain: () => Promise.resolve(),
		});

		// The failure is reported, not swallowed.
		await expect(close()).rejects.toThrow("still draining");
		// ...but the app's sessions are not left waiting on a promise that can
		// never settle: the endpoint has stopped accepting either way.
		expect(resolved).toEqual([
			{
				code: SERVER_CLOSING_CLOSE_CODE,
				reason: SERVER_CLOSING_CLOSE_REASON,
			},
		]);

		// And the caller can try again — the rejection was not memoized.
		await close();
		expect(attempts).toBe(2);
		expect(resolved).toHaveLength(2);

		// A success is still memoized: retryable must not mean "re-runs forever".
		await close();
		expect(attempts).toBe(2);
	});
});
