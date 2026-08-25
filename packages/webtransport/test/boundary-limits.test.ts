/**
 * P0.4: Boundary correctness for limits/rate gates.
 * Tests exact semantics: at limit succeeds, at limit+1 fails.
 */
import { describe, it, expect } from "bun:test";
import { connect, createServer, E_LIMIT_EXCEEDED } from "../src/index.js";
import { forEachWithTimeout } from "./helpers/harness.js";
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

describe("limit boundaries (P0.4)", () => {
	it("maxHandshakesInFlight: excess concurrent handshakes are rejected, capacity recovers", async () => {
		const port = nextPort(25480, 3000);
		const limit = 2;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxHandshakesInFlight: limit, maxSessions: 100 },
			onSession: () => {},
		});

		try {
			// A tiny in-flight cap (2) against a large concurrent burst forces the
			// server to reject the overflow: many handshakes are simultaneously past
			// incoming_session.await before any complete, so in-flight exceeds the cap.
			// Single-shot connects (no retry) with a short timeout so rejected attempts
			// — which the server silently drops — fail fast instead of retrying.
			const attempts = 24;
			const results = await Promise.all(
				Array.from({ length: attempts }, () =>
					connect(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
						limits: { handshakeTimeoutMs: 1500 },
					}).then(
						(s) => ({ ok: true as const, session: s }),
						(e) => ({ ok: false as const, err: e }),
					),
				),
			);

			const succeeded = results.filter(
				(r): r is { ok: true; session: Awaited<ReturnType<typeof connect>> } =>
					r.ok,
			);
			const failed = results.filter((r) => !r.ok);
			for (const s of succeeded) s.session.close();

			// Rejections must occur, and the server must account for them.
			expect(failed.length).toBeGreaterThan(0);
			const m = server.metricsSnapshot();
			expect(m.limitExceededCount).toBeGreaterThanOrEqual(1);

			// Successes complete: once the burst drains and in-flight returns to zero,
			// a fresh handshake proceeds normally, proving the cap is not permanent.
			const late = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			expect(late).toBeDefined();
			late.close();
		} finally {
			await server.close();
		}
	}, 15000);

	it("maxHandshakesInFlight: a refused burst fully establishes under jittered retry — refusal is load-shaping, not rejection", async () => {
		// The documented client contract (OPERATIONS.md "Admission control"):
		// CONNECTION_REFUSED from this server is a transient admission signal.
		// A synchronized wave deeper than the cap must fully establish once
		// every dial retries with jittered backoff — the same event that reads
		// as an outage to single-shot clients (the test above) is a sub-second
		// hiccup to retrying ones. Measured here so the semantics cannot drift
		// silently: refusals MUST occur AND every client MUST get in.
		const port = nextPort(25480, 3000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxHandshakesInFlight: 2, maxSessions: 100 },
			onSession: () => {},
		});

		const dialWithJitteredRetry = async (): Promise<
			Awaited<ReturnType<typeof connect>>
		> => {
			const attempts = 8;
			let lastErr: unknown;
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				try {
					return await connect(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
						limits: { handshakeTimeoutMs: 1500 },
					});
				} catch (err) {
					lastErr = err;
					// Jitter is load-bearing: a fixed timer re-arrives as the
					// same synchronized wave the server just refused.
					const base = 100 * attempt;
					await Bun.sleep(base * (0.5 + Math.random()));
				}
			}
			throw lastErr;
		};

		try {
			const burst = 24;
			const started = performance.now();
			const sessions = await Promise.all(
				Array.from({ length: burst }, () => dialWithJitteredRetry()),
			);
			const elapsedMs = performance.now() - started;

			// Every client established — zero terminal failures.
			expect(sessions.length).toBe(burst);
			// The wave really was refused at the boundary (the retry path was
			// exercised, not bypassed by a lucky drain).
			const m = server.metricsSnapshot();
			expect(m.limitExceededCount).toBeGreaterThanOrEqual(1);
			// "Hiccup, not outage": the whole burst clears well inside the
			// retry schedule's own worst case.
			expect(elapsedMs).toBeLessThan(10_000);

			for (const s of sessions) s.close();
		} finally {
			await server.close();
		}
	}, 20000);

	it("maxSessions: exactly limit sessions accepted, limit+1 rejected", async () => {
		const port = nextPort(25480, 3000);
		const limit = 2;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxSessions: limit, maxHandshakesInFlight: 10 },
			onSession: () => {},
		});

		try {
			const accepted = [];
			for (let i = 0; i < limit; i++) {
				accepted.push(
					await connectWithRetry(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
					}),
				);
			}
			expect(accepted.length).toBe(limit);

			await expect(
				connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			).rejects.toMatchObject({ code: E_LIMIT_EXCEEDED });

			for (const session of accepted) session.close();

			const m = server.metricsSnapshot();
			expect(m.limitExceededCount).toBeGreaterThanOrEqual(1);
		} finally {
			await server.close();
		}
	}, 15000);

	it("maxStreamsPerSessionBidi: exactly limit streams succeed, limit+1 returns E_LIMIT_EXCEEDED", async () => {
		const port = nextPort(25480, 3000);
		const cap = 3;
		let serverSession: any = null;
		let resolveServerReady!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxStreamsPerSessionBidi: cap, maxStreamsGlobal: 50000 },
			onSession: async (s) => {
				serverSession = s;
				resolveServerReady();
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"boundary limits server bidi incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await serverReady;
			expect(serverSession).not.toBeNull();

			const opened: any[] = [];
			for (let i = 0; i < cap; i++) {
				opened.push(await serverSession.createBidirectionalStream());
			}
			expect(opened.length).toBe(cap);

			await expect(
				serverSession.createBidirectionalStream(),
			).rejects.toMatchObject({
				code: E_LIMIT_EXCEEDED,
			});
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("maxStreamsPerSessionUni: exactly limit streams succeed, limit+1 returns E_LIMIT_EXCEEDED", async () => {
		const port = nextPort(25480, 3000);
		const cap = 3;
		let serverSession: any = null;
		let resolveServerReady!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxStreamsPerSessionUni: cap, maxStreamsGlobal: 50000 },
			onSession: async (s) => {
				serverSession = s;
				resolveServerReady();
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"boundary limits server uni incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await serverReady;
			expect(serverSession).not.toBeNull();

			const opened: any[] = [];
			for (let i = 0; i < cap; i++) {
				opened.push(await serverSession.createUnidirectionalStream());
			}
			expect(opened.length).toBe(cap);

			await expect(
				serverSession.createUnidirectionalStream(),
			).rejects.toMatchObject({
				code: E_LIMIT_EXCEEDED,
			});
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("waitUntilAvailable: createBidirectionalStream waits for capacity and succeeds before timeout", async () => {
		const port = nextPort(25480, 3000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: {
				maxStreamsPerSessionBidi: 1,
				maxStreamsGlobal: 50000,
				backpressureTimeoutMs: 1500,
			},
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"boundary limits waitUntilAvailable incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			limits: { backpressureTimeoutMs: 1500 },
		});
		try {
			const first = await client.createBidirectionalStream();
			const secondPromise = client.createBidirectionalStream({
				waitUntilAvailable: true,
			});
			await Bun.sleep(100);
			first.destroy();
			const second = await Promise.race([
				secondPromise,
				Bun.sleep(2000).then(() => {
					throw new Error("timeout waiting for waitUntilAvailable stream");
				}),
			]);
			expect(second).toBeDefined();
			second.destroy();
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("server session datagram limits are isolated per server instance", async () => {
		const portA = nextPort(25520, 3000);
		const portB = nextPort(25820, 3000);
		const serverA = createServer({
			port: portA,
			tls: { certPem: "", keyPem: "" },
			limits: { maxDatagramSize: 8 },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"boundary limits serverA incoming datagram",
					async () => undefined,
				);
			},
		});

		let serverBSession: any = null;
		let resolveServerBReady!: () => void;
		const serverBReady = new Promise<void>((r) => {
			resolveServerBReady = r;
		});
		const serverB = createServer({
			port: portB,
			tls: { certPem: "", keyPem: "" },
			limits: { maxDatagramSize: 1200 },
			onSession: async (s) => {
				serverBSession = s;
				resolveServerBReady();
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"boundary limits serverB incoming datagram",
					async () => undefined,
				);
			},
		});

		const clientB = await connectWithRetry(`https://127.0.0.1:${portB}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await Promise.race([
				serverBReady,
				Bun.sleep(2000).then(() => {
					throw new Error("timeout waiting for server B session");
				}),
			]);
			await expect(
				serverBSession.sendDatagram(new Uint8Array(64)),
			).resolves.toBe(undefined);
		} finally {
			clientB.close();
			await serverB.close();
			await serverA.close();
		}
	}, 15000);

	it("server.close only closes sessions owned by that server instance", async () => {
		const portA = nextPort(26120, 2000);
		const portB = nextPort(26420, 2000);
		const serverA = createServer({
			port: portA,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"boundary limits server close A incoming datagram",
					async () => undefined,
				);
			},
		});

		let serverBSession: any = null;
		let resolveServerBReady!: () => void;
		const serverBReady = new Promise<void>((r) => {
			resolveServerBReady = r;
		});
		const serverB = createServer({
			port: portB,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				serverBSession = s;
				resolveServerBReady();
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"boundary limits server close B incoming datagram",
					async () => undefined,
				);
			},
		});

		const clientB = await connectWithRetry(`https://127.0.0.1:${portB}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await Promise.race([
				serverBReady,
				Bun.sleep(2000).then(() => {
					throw new Error("timeout waiting for server B session");
				}),
			]);
			await serverA.close();
			await expect(
				serverBSession.sendDatagram(new Uint8Array(64)),
			).resolves.toBe(undefined);
		} finally {
			clientB.close();
			await serverB.close();
		}
	}, 15000);
});
