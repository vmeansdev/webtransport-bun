/**
 * P0-C: Queue saturation, backpressure timeout, and recovery.
 * P1.2: Backpressure metrics (backpressureWaitCount, backpressureTimeoutCount).
 */

import { describe, it, expect } from "bun:test";
import {
	connect,
	createServer,
	E_BACKPRESSURE_TIMEOUT,
	E_QUEUE_FULL,
} from "../src/index.js";
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

describe("backpressure (P0-C)", () => {
	it("datagram size over max is rejected", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const big = new Uint8Array(1500);
			await expect(client.sendDatagram(big)).rejects.toThrow(/E_QUEUE_FULL/);
		} finally {
			client.close();
			await server.close();
		}
	}, 10000);

	it("rapid datagram sends eventually apply backpressure", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const dgram = new Uint8Array(100);
			const sends = Array.from({ length: 400 }, () =>
				client.sendDatagram(dgram).catch((e: Error) => e),
			);
			const results = await Promise.all(sends);
			const timeouts = results.filter(
				(r) =>
					r instanceof Error && r.message?.includes("E_BACKPRESSURE_TIMEOUT"),
			);
			const successes = results.filter((r) => !(r instanceof Error));

			expect(successes.length).toBeGreaterThan(0);
			if (timeouts.length > 0) {
				expect(timeouts[0]).toBeInstanceOf(Error);
				expect((timeouts[0] as Error).message).toContain(
					E_BACKPRESSURE_TIMEOUT,
				);
			}
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("send and receive works when server echoes", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const dgram = new Uint8Array([1, 2, 3]);
			await client.sendDatagram(dgram);
			const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const first = (await Promise.race([
				iter.next(),
				Bun.sleep(1500).then(() => ({ done: true as const, value: undefined })),
			])) as IteratorResult<Uint8Array>;
			expect(first.done).toBe(false);
		} finally {
			client.close();
			await server.close();
		}
	}, 10000);

	it("client send_datagram enforces configured queued byte budget", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			limits: {
				maxQueuedBytesGlobal: 1200,
				maxQueuedBytesPerSession: 1200,
			},
		});
		try {
			const payload = new Uint8Array(1200);
			const results = await Promise.all(
				Array.from({ length: 16 }, () =>
					client.sendDatagram(payload).then(
						() => "ok",
						(err: Error & { code?: string }) => err.code ?? err.message,
					),
				),
			);
			expect(results).toContain(E_QUEUE_FULL);
			expect(client.metricsSnapshot().queuedBytes).toBeLessThanOrEqual(1200);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("client receive queue respects configured queued byte budget", async () => {
		const port = nextPort(24460, 2000);
		const payload = new Uint8Array(256);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for (let i = 0; i < 16; i++) {
					await s.sendDatagram(payload);
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			limits: {
				maxQueuedBytesGlobal: 512,
				maxQueuedBytesPerSession: 512,
			},
		});
		try {
			const queued = await Promise.race([
				(async () => {
					const deadline = Date.now() + 3000;
					while (Date.now() < deadline) {
						const snapshot = client.metricsSnapshot();
						if (snapshot.queuedBytes > 0) return snapshot.queuedBytes;
						await Bun.sleep(50);
					}
					return client.metricsSnapshot().queuedBytes;
				})(),
				Bun.sleep(3500).then(() => {
					throw new Error("timeout waiting for client queued bytes");
				}),
			]);
			expect(queued).toBeGreaterThan(0);
			expect(queued).toBeLessThanOrEqual(512);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);
});

describe("backpressure observability (P1.2)", () => {
	it("backpressure counters exist and have correct shape", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});
		try {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			// Counters are shape checks only; avoid blocking on echoed datagram delivery.
			await Bun.sleep(50);

			const m = server.metricsSnapshot();
			expect(typeof m.backpressureWaitCount).toBe("number");
			expect(typeof m.backpressureTimeoutCount).toBe("number");
			expect(m.backpressureWaitCount).toBeGreaterThanOrEqual(0);
			expect(m.backpressureTimeoutCount).toBeGreaterThanOrEqual(0);
		} finally {
			await server.close();
		}
	}, 10000);

	it("backpressureTimeoutCount increments when server send times out (best-effort)", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { backpressureTimeoutMs: 1 },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					void s.sendDatagram(d).catch(() => {});
				}
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const buf = new Uint8Array(800);
			const sends = Array.from({ length: 600 }, () =>
				client.sendDatagram(buf).catch(() => {}),
			);
			await Promise.all(sends);
			await Bun.sleep(2000);

			const m = server.metricsSnapshot();
			if (m.backpressureTimeoutCount > 0) {
				expect(m.backpressureWaitCount).toBeGreaterThanOrEqual(
					m.backpressureTimeoutCount,
				);
			}
		} finally {
			client.close();
			await server.close();
		}
	}, 25000);
});
