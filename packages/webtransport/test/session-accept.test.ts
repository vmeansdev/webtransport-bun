/**
 * P0-A: session accept callback is invoked and session.closed settles
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer, WebTransport } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

async function connectWithRetry(
	url: string,
	opts: Parameters<typeof connect>[1],
	timeoutMs = 6000,
): Promise<Awaited<ReturnType<typeof connect>>> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return await connect(url, opts);
		} catch (err) {
			lastErr = err;
			await Bun.sleep(100);
		}
	}
	throw lastErr ?? new Error("connectWithRetry: timed out");
}

async function waitUntil(
	condition: () => boolean,
	timeoutMs: number,
	intervalMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(intervalMs);
	}
	return condition();
}

async function openWTWithRetry(
	url: string,
	opts: ConstructorParameters<typeof WebTransport>[1],
	timeoutMs = 10000,
): Promise<WebTransport> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		const wt = new WebTransport(url, opts);
		try {
			await wt.ready;
			return wt;
		} catch (err) {
			lastErr = err;
			wt.close();
			await Bun.sleep(100);
		}
	}
	throw lastErr ?? new Error("openWTWithRetry: timed out");
}

describe("session accept (P0-A)", () => {
	it("onSession called when client connects", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const seen = await waitUntil(() => sessions.length >= 1, 8000);
			expect(seen).toBe(true);
			expect(sessions[0]).toBeDefined();
			expect(sessions[0].id).toBeDefined();
			expect(typeof sessions[0].id).toBe("string");
		} finally {
			client.close();
			await server.close();
		}
	}, 30000);

	it("closed promise settles when session ends", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const accepted = await waitUntil(() => sessions.length >= 1, 8000);
			expect(accepted).toBe(true);

			const closedPromise = sessions[0].closed.then((info: any) => ({
				ok: true,
				info,
			}));
			client.close();
			const closedResult = await Promise.race([
				closedPromise,
				Bun.sleep(5000).then(() => ({ ok: false })),
			]);
			expect(closedResult.ok).toBe(true);
			expect((closedResult as any).info).toBeDefined();
		} finally {
			client.close();
			await server.close();
		}
	}, 20000);

	it("client-initiated close propagates code and reason to server session.closed", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const accepted = await waitUntil(() => sessions.length >= 1, 8000);
			expect(accepted).toBe(true);
			const closedInfoPromise = sessions[0].closed;
			client.close({ code: 4999, reason: "Done streaming." });
			const closeInfo = await Promise.race([
				closedInfoPromise,
				Bun.sleep(5000).then(() => ({ code: -1, reason: "timeout" })),
			]);
			expect((closeInfo as any).code).toBe(4999);
			expect((closeInfo as any).reason).toBe("Done streaming.");
		} finally {
			client.close();
			await server.close();
		}
	}, 20000);

	it("client-initiated close code/reason propagate reliably across repeated sessions", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const runs = 20;
		try {
			for (let i = 0; i < runs; i++) {
				const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				});
				const accepted = await waitUntil(() => sessions.length > i, 8000);
				expect(accepted).toBe(true);
				const session = sessions[i];
				const closedInfoPromise = session.closed;
				client.close({ code: 4999, reason: "Done streaming." });
				const closeInfo = await Promise.race([
					closedInfoPromise,
					Bun.sleep(5000).then(() => ({ code: -1, reason: "timeout" })),
				]);
				expect((closeInfo as any).code).toBe(4999);
				expect((closeInfo as any).reason).toBe("Done streaming.");
			}
		} finally {
			await server.close();
		}
	}, 120000);

	it("writer.close before read still preserves session close code/reason", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
				void (async () => {
					for await (const duplex of s.incomingBidirectionalStreams) {
						void (async () => {
							const reader = duplex.readable.getReader();
							const chunks: Uint8Array[] = [];
							while (true) {
								const { done, value } = await Promise.race([
									reader.read(),
									Bun.sleep(4000).then(() => ({
										done: true,
										value: undefined,
									})),
								]);
								if (done) break;
								if (!value) break;
								chunks.push(value);
							}
							const writer = duplex.writable.getWriter();
							if (chunks.length > 0) {
								await writer.write(
									Buffer.concat(chunks.map((c) => Buffer.from(c))),
								);
							}
							await writer.close();
						})().catch(() => {});
					}
				})().catch(() => {});
			},
		});

		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const accepted = await waitUntil(() => sessions.length >= 1, 8000);
			expect(accepted).toBe(true);
			const serverClosedPromise = sessions[0].closed;

			const { readable, writable } = await wt.createBidirectionalStream();
			const writer = writable.getWriter();
			await writer.write(new Uint8Array([1, 2, 3, 4]));
			await writer.ready;
			await writer.close();

			const reader = readable.getReader();
			const readResult = await Promise.race([
				reader.read(),
				Bun.sleep(5000).then(() => ({ done: true, value: undefined })),
			]);
			expect(readResult.done).toBe(false);
			expect(
				new Uint8Array(
					readResult.value!.buffer,
					readResult.value!.byteOffset,
					readResult.value!.byteLength,
				),
			).toEqual(new Uint8Array([1, 2, 3, 4]));
			reader.releaseLock();

			wt.close({ closeCode: 4999, reason: "Done streaming." });
			const clientCloseInfo = await Promise.race([
				wt.closed,
				Bun.sleep(5000).then(() => ({ closeCode: -1, reason: "timeout" })),
			]);
			expect((clientCloseInfo as any).closeCode).toBe(4999);
			expect((clientCloseInfo as any).reason).toBe("Done streaming.");

			const serverCloseInfo = await Promise.race([
				serverClosedPromise,
				Bun.sleep(5000).then(() => ({ code: -1, reason: "timeout" })),
			]);
			expect((serverCloseInfo as any).code).toBe(4999);
			expect((serverCloseInfo as any).reason).toBe("Done streaming.");
		} finally {
			wt.close();
			await server.close();
		}
	}, 30000);
});
