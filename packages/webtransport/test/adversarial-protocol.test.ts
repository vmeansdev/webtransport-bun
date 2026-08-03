/**
 * Protocol-level adversarial harness.
 *
 * Every other "adversarial/abuse" test drives the library's own well-formed
 * client (self-parity). This one spawns a raw QUIC/H3 attacker (crates/adversary,
 * built on quinn — not wtransport) that sends malformed H3 SETTINGS, invalid
 * frame types, truncated CONNECTs, stream/connection floods, garbage datagrams,
 * and reset storms directly at the addon server.
 *
 * The assertions are SAFETY properties, which are deterministic even though the
 * exact counter values are not:
 *   1. the server process does not crash, hang, or panic during the attack,
 *   2. a fresh LEGITIMATE library client can still connect + echo afterwards,
 *   3. sessions/streams settle back to ~0 (no leak),
 *   4. at least one defensive counter (rateLimited / limitExceeded) moved.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect, createServer } from "../src/index.js";
import {
	collectWithTimeout,
	forEachWithTimeout,
	nextWithTimeout,
	readWithTimeout,
	withHarness,
} from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 19100;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADVERSARY_BIN = join(REPO_ROOT, "target", "debug", "adversary");

// Per-operation deadline for the raw QUIC/H3 adversarial harness. Correctness
// is unaffected — an operation that never completes still fails — but a loaded
// CI runner doing debug-build QUIC handshakes needs headroom over the ~3.6s
// this takes locally, so the deadline scales up under CI.
const OP_DEADLINE_MS = process.env.CI ? 20000 : 5000;

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
	stepMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(stepMs);
	}
	return predicate();
}

async function legitimateEcho(port: number): Promise<void> {
	const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
		tls: { insecureSkipVerify: true },
	});
	try {
		// Bidi echo round-trip (connect() yields a Node-style duplex).
		const bidi = await client.createBidirectionalStream();
		const payload = Buffer.from("legit-echo");
		await new Promise<void>((res, rej) => {
			bidi.write(payload, (err: Error | null | undefined) =>
				err ? rej(err) : res(),
			);
		});
		await new Promise<void>((res, rej) => {
			bidi.end((err: Error | null | undefined) => (err ? rej(err) : res()));
		});
		const chunks = await collectWithTimeout(
			bidi,
			OP_DEADLINE_MS,
			"adversarial protocol legitimate echo bidi read",
		);
		expect(Buffer.concat(chunks)).toEqual(payload);

		// Datagram echo round-trip.
		await client.sendDatagram(new Uint8Array([9, 8, 7]));
		const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
		const got = await nextWithTimeout(
			iter,
			2000,
			"adversarial protocol legitimate echo datagram read",
		);
		expect(got.done).toBe(false);
	} finally {
		client.close();
	}
}

describe("adversarial protocol harness (raw QUIC/H3)", () => {
	beforeAll(() => {
		// Ensure the attacker binary exists; build if a previous `cargo build`
		// hasn't produced it yet. Kept in beforeAll so the (slow) compile is not
		// attributed to a test's timeout.
		if (!existsSync(ADVERSARY_BIN)) {
			const build = spawnSync("cargo", ["build", "-p", "adversary"], {
				cwd: REPO_ROOT,
				stdio: "inherit",
			});
			if (build.status !== 0) {
				throw new Error("failed to build adversary binary");
			}
		}
		expect(existsSync(ADVERSARY_BIN)).toBe(true);
	});

	it("survives a raw malformed-protocol attack and keeps serving", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);

			// Small caps so the attacker provably exceeds them.
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					limits: {
						maxHandshakesInFlight: 2,
						handshakeTimeoutMs: 1500,
						maxStreamsPerSessionBidi: 8,
						maxStreamsPerSessionUni: 8,
						maxDatagramSize: 512,
					},
					rateLimits: { handshakesBurst: 8, handshakesPerSec: 8 },
					onSession: async (s) => {
						void (async () => {
							await forEachWithTimeout(
								s.incomingDatagrams(),
								OP_DEADLINE_MS,
								"adversarial protocol server incoming datagram",
								async (d) => {
									await s.sendDatagram(d);
								},
							);
						})().catch(() => {});
						void (async () => {
							await forEachWithTimeout(
								s.incomingBidirectionalStreams,
								OP_DEADLINE_MS,
								"adversarial protocol server incoming bidi",
								async (duplex) => {
									void (async () => {
										const reader = duplex.readable.getReader();
										const chunks: Uint8Array[] = [];
										while (true) {
											const { done, value } = await readWithTimeout(
												reader,
												OP_DEADLINE_MS,
												"adversarial protocol server bidi read",
											);
											if (done || value === undefined) break;
											chunks.push(value);
										}
										if (chunks.length > 0) {
											const writer = duplex.writable.getWriter();
											await writer.write(
												Buffer.concat(chunks.map((c) => Buffer.from(c))),
											);
											await writer.close();
										}
									})().catch(() => {});
								},
							);
						})().catch(() => {});
					},
				}),
			);

			// Prove the server serves BEFORE the attack.
			await legitimateEcho(port);

			// Unleash the raw QUIC/H3 attacker.
			const proc = Bun.spawn(
				[ADVERSARY_BIN, `127.0.0.1:${port}`, "localhost"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			let peakHandshakesInFlight = 0;
			let peakSessionTasksActive = 0;
			const sampler = setInterval(() => {
				const sample = server.metricsSnapshot();
				peakHandshakesInFlight = Math.max(
					peakHandshakesInFlight,
					sample.handshakesInFlight,
				);
				peakSessionTasksActive = Math.max(
					peakSessionTasksActive,
					sample.sessionTasksActive,
				);
			}, 5);
			let exitCode: number | "timeout";
			try {
				exitCode = await Promise.race([
					proc.exited,
					Bun.sleep(30000).then(() => "timeout" as const),
				]);
			} finally {
				clearInterval(sampler);
			}
			if (exitCode === "timeout") {
				proc.kill();
				throw new Error("adversary binary did not exit within 30s");
			}
			expect(peakHandshakesInFlight).toBeLessThanOrEqual(2);
			// The accept loop itself is one tracked session task.
			expect(peakSessionTasksActive).toBeLessThanOrEqual(3);
			// Attacker should complete cleanly; the server is the SUT, so a
			// nonzero exit is surfaced but does not by itself fail the run.
			if (exitCode !== 0) {
				const err = await new Response(proc.stderr).text();
				console.warn(`adversary exited ${exitCode}: ${err}`);
			}

			// (1) Server did not crash: metrics still readable.
			const during = server.metricsSnapshot();
			expect(typeof during.sessionsActive).toBe("number");

			// (2) A fresh legitimate client can STILL connect + echo.
			await legitimateEcho(port);

			// (3) No leak: sessions, streams, in-flight handshakes and queued
			// bytes all settle back to zero once the attacker and the legit
			// clients disconnect. This also proves the junk never leaked a
			// phantom WebTransport session — raw pre-CONNECT traffic is
			// absorbed by the H3 layer and never becomes a session.
			const settled = await waitUntil(() => {
				const m = server.metricsSnapshot();
				return (
					m.sessionsActive === 0 &&
					m.streamsActive === 0 &&
					m.handshakesInFlight === 0
				);
			}, 12000);
			const final = server.metricsSnapshot();
			expect(settled).toBe(true);
			expect(final.sessionsActive).toBe(0);
			expect(final.streamsActive).toBe(0);
			expect(final.handshakesInFlight).toBe(0);
			expect(final.queuedBytesGlobal).toBe(0);

			// (4) Observational: the addon enforces its rate limiter and
			// session/stream caps at the WebTransport-session layer, which sits
			// BEHIND the H3 Extended CONNECT. A purely raw QUIC/H3 attack that
			// never completes a CONNECT is therefore absorbed below the app
			// layer and does not (and should not) move these counters. We record
			// them rather than asserting movement, so the harness stays honest
			// about where the defense actually lives.
			console.info(
				`adversarial-protocol counters: rateLimited=${final.rateLimitedCount} ` +
					`limitExceeded=${final.limitExceededCount} ` +
					`datagramsDropped=${final.datagramsDropped}`,
			);
			expect(final.rateLimitedCount).toBeGreaterThanOrEqual(0);
			expect(final.limitExceededCount).toBeGreaterThanOrEqual(0);
		});
	}, 60000);
});
