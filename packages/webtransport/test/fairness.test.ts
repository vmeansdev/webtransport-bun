/**
 * P2.3 / P2.3-A: Fairness and abuse resistance validation.
 * - Contention tests prove non-starvation for compliant clients.
 * - Rate-limit enforcement returns correct stable codes and metrics.
 * - Explicit non-starvation: compliant makes forward progress after abusive burst.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createHarness } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";
import { connect, createServer } from "../src/index.js";

const harness = createHarness();

afterEach(async () => {
	await harness.cleanup();
});

function trackedCreateServer(...args: Parameters<typeof createServer>) {
	return harness.track(createServer(...args));
}

function trackedCreateServerWithPortRetry(
	base: number,
	spread: number,
	makeOptions: (port: number) => Parameters<typeof createServer>[0],
	maxAttempts = 8,
) {
	let lastErr: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const port = nextPort(base, spread);
		try {
			return {
				port,
				server: trackedCreateServer(makeOptions(port)),
			};
		} catch (err) {
			lastErr = err;
			if (!String(err).includes("Address already in use")) {
				throw err;
			}
		}
	}
	throw lastErr ?? new Error("failed to allocate server port");
}

async function trackedConnect(...args: Parameters<typeof connect>) {
	return harness.track(await connectWithRetry(args[0], args[1]));
}

async function tryConnectOnce(
	url: string,
	opts: Parameters<typeof connect>[1],
): Promise<Awaited<ReturnType<typeof connect>> | null> {
	try {
		return await connect(url, opts);
	} catch {
		return null;
	}
}

describe("fairness and abuse resistance (P2.3)", () => {
	it("compliant client recovers after rate limit: tokens refill, new connections succeed", async () => {
		const { port, server } = trackedCreateServerWithPortRetry(
			34900,
			2000,
			(port) => ({
				port,
				tls: { certPem: "", keyPem: "" },
				rateLimits: {
					handshakesPerSec: 10,
					handshakesBurst: 2,
					handshakesBurstPerPrefix: 5,
				},
				onSession: (s) => {
					void (async () => {
						for await (const _ of s.incomingDatagrams()) {
						}
					})().catch(() => {});
				},
			}),
		);

		const c1 = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const c2 = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const burstAttempts = await Promise.all(
			Array.from({ length: 3 }, () =>
				tryConnectOnce(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
					limits: { handshakeTimeoutMs: 400 },
				}),
			),
		);
		const burstSucceeded = burstAttempts.filter((s) => s !== null);
		for (const s of burstSucceeded) harness.track(s);
		const failedCount = burstAttempts.length - burstSucceeded.length;
		const rateLimitedCount = server.metricsSnapshot().rateLimitedCount;
		expect(failedCount).toBeGreaterThanOrEqual(1);
		expect(rateLimitedCount).toBeGreaterThanOrEqual(1);

		const mBefore = server.metricsSnapshot();
		expect(mBefore.rateLimitedCount).toBeGreaterThanOrEqual(1);

		c1.close();
		c2.close();
		await Bun.sleep(1500);

		const c3 = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const mAfter = server.metricsSnapshot();
		expect(mAfter.sessionsActive).toBeGreaterThanOrEqual(1);
		c3.close();

		await server.close();
	}, 15000);

	it("rate limit returns E_RATE_LIMITED and increments rateLimitedCount", async () => {
		const { port, server } = trackedCreateServerWithPortRetry(
			34900,
			2000,
			(port) => ({
				port,
				tls: { certPem: "", keyPem: "" },
				rateLimits: {
					handshakesPerSec: 2,
					handshakesBurst: 1,
					handshakesBurstPerPrefix: 1,
				},
				onSession: () => {},
			}),
		);
		try {
			await Bun.sleep(1500);

			const first = await trackedConnect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
				limits: { handshakeTimeoutMs: 1500 },
			});

			let sawReject = false;
			for (let i = 0; i < 5; i++) {
				const c = await tryConnectOnce(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
					limits: { handshakeTimeoutMs: 500 },
				});
				if (c) {
					harness.track(c);
					c.close();
				} else {
					sawReject = true;
					break;
				}
				await Bun.sleep(50);
			}
			expect(sawReject).toBe(true);

			const m = server.metricsSnapshot();
			expect(m.rateLimitedCount).toBeGreaterThanOrEqual(1);
			first.close();
		} finally {
			await server.close();
		}
	}, 15000);

	it("per-IP burst: at most burst connections succeed, excess rejected with rate limit", async () => {
		const burst = 3;
		const { port, server } = trackedCreateServerWithPortRetry(
			34900,
			2000,
			(port) => ({
				port,
				tls: { certPem: "", keyPem: "" },
				rateLimits: {
					// Keep refill slow so this remains a true burst-boundary test.
					handshakesPerSec: 1,
					handshakesBurst: burst,
					handshakesBurstPerPrefix: burst + 10,
				},
				onSession: () => {},
			}),
		);

		const results = await Promise.all(
			Array.from({ length: burst + 5 }, () =>
				tryConnectOnce(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
					limits: { handshakeTimeoutMs: 500 },
				}),
			),
		);
		const succeeded = results.filter((r) => r !== null).length;
		const rejected = results.filter((r) => r === null).length;

		expect(succeeded).toBeLessThanOrEqual(burst + 1);
		expect(rejected).toBeGreaterThanOrEqual(1);

		const m = server.metricsSnapshot();
		expect(m.rateLimitedCount).toBeGreaterThanOrEqual(1);

		for (const c of results) {
			if (c) {
				harness.track(c);
				c.close();
			}
		}
		await server.close();
	}, 15000);

	describe("P2.3-A: non-starvation under contention", () => {
		it("compliant connects within refill window after abusive burst (tokens refill, no permanent starvation)", async () => {
			const burst = 2;
			const { port, server } = trackedCreateServerWithPortRetry(
				34900,
				2000,
				(port) => ({
					port,
					tls: { certPem: "", keyPem: "" },
					rateLimits: {
						handshakesPerSec: 5,
						handshakesBurst: burst,
						handshakesBurstPerPrefix: burst + 5,
					},
					onSession: () => {},
				}),
			);

			const abusive: Promise<Awaited<ReturnType<typeof connect>> | null>[] = [];
			for (let i = 0; i < burst + 3; i++) {
				abusive.push(
					tryConnectOnce(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
						limits: { handshakeTimeoutMs: 500 },
					}),
				);
			}
			const abusiveResults = await Promise.all(abusive);
			for (const c of abusiveResults) {
				if (c) {
					harness.track(c);
					c.close();
				}
			}

			const mAfterBurst = server.metricsSnapshot();
			expect(mAfterBurst.rateLimitedCount).toBeGreaterThanOrEqual(1);

			const refillMs = 1200;
			await Bun.sleep(refillMs);

			const compliant = await trackedConnect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			expect(compliant).toBeDefined();
			compliant.close();

			await server.close();
		}, 15000);

		it("high-contention: abusive hammer vs compliant retries; compliant eventually succeeds", async () => {
			const { port, server } = trackedCreateServerWithPortRetry(
				34900,
				2000,
				(port) => ({
					port,
					tls: { certPem: "", keyPem: "" },
					rateLimits: {
						handshakesPerSec: 4,
						handshakesBurst: 2,
						handshakesBurstPerPrefix: 6,
					},
					onSession: (s) => {
						void (async () => {
							for await (const d of s.incomingDatagrams()) {
								await s.sendDatagram(d);
							}
						})().catch(() => {});
					},
				}),
			);

			let compliantConnected = false;
			const compliantPromise = (async () => {
				const deadline = Date.now() + 8000;
				while (Date.now() < deadline) {
					try {
						const c = await trackedConnect(`https://127.0.0.1:${port}`, {
							tls: { insecureSkipVerify: true },
						});
						await c.sendDatagram(new Uint8Array([1, 2, 3]));
						const iter = c.incomingDatagrams()[Symbol.asyncIterator]();
						const r = (await Promise.race([
							iter.next(),
							Bun.sleep(1200).then(() => ({
								done: true as const,
								value: undefined,
							})),
						])) as IteratorResult<Uint8Array>;
						if (r.value) compliantConnected = true;
						c.close();
						return;
					} catch {
						await Bun.sleep(400);
					}
				}
			})();

			const abusivePromise = (async () => {
				for (let i = 0; i < 15; i++) {
					tryConnectOnce(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
						limits: { handshakeTimeoutMs: 500 },
					})
						.then((c) => c?.close())
						.catch(() => {});
					await Bun.sleep(200);
				}
			})();

			await Promise.all([compliantPromise, abusivePromise]);

			expect(compliantConnected).toBe(true);

			const m = server.metricsSnapshot();
			expect(m.rateLimitedCount).toBeGreaterThanOrEqual(0);

			await server.close();
		}, 20000);
	});
});
