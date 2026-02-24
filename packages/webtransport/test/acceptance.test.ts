/**
 * Acceptance tests for Task.md gates.
 * - P0-2: Sustained multi-stream traffic; streams opened/accepted repeatedly with limits enforced
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

const BASE_PORT = 14600;

function nextPort(): number {
	return BASE_PORT + Math.floor(Math.random() * 500);
}

async function waitUntil(
	condition: () => boolean,
	timeoutMs: number,
	intervalMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(intervalMs);
	}
	return condition();
}

async function readDatagramWithTimeout(
	iter: AsyncIterator<Uint8Array>,
	timeoutMs: number,
): Promise<IteratorResult<Uint8Array>> {
	return (await Promise.race([
		iter.next(),
		Bun.sleep(timeoutMs).then(() => ({
			done: true as const,
			value: undefined,
		})),
	])) as IteratorResult<Uint8Array>;
}

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

describe("acceptance (Task gates)", () => {
	it("P0-2: sustained multi-stream and datagram traffic", async () => {
		const port = nextPort();
		let streamsAccepted = 0;
		let datagramsEchoed = 0;

		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					for await (const d of s.incomingDatagrams()) {
						await s.sendDatagram(d);
						datagramsEchoed++;
					}
				})().catch(() => {});
				void (async () => {
					for await (const _ of s.incomingBidirectionalStreams) {
						streamsAccepted++;
					}
				})().catch(() => {});
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		// Open multiple bidi streams (write-only; server accepts but doesn't echo)
		const streamPromises = Array.from({ length: 5 }, async () => {
			const stream = await client.createBidirectionalStream();
			stream.write(Buffer.from("ping"));
			await new Promise<void>((r) => stream.end(r));
		});
		await Promise.all(streamPromises);

		// Send many datagrams and verify echo
		for (let i = 0; i < 10; i++) {
			await client.sendDatagram(new Uint8Array([i]));
		}
		let received = 0;
		const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
		while (received < 10) {
			const next = await readDatagramWithTimeout(iter, 1200);
			if (next.done) break;
			received++;
		}
		expect(received).toBe(10);

		await server.close();
		expect(streamsAccepted).toBe(5);
		expect(datagramsEchoed).toBeGreaterThanOrEqual(10);
	}, 15000);

	it("P1-4: metricsSnapshot reflects activity", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					for await (const d of s.incomingDatagrams()) {
						await s.sendDatagram(d);
					}
				})().catch(() => {});
			},
		});
		try {
			await Bun.sleep(2000);

			const client = await connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			await client.sendDatagram(new Uint8Array([1, 2, 3]));

			const observed = await waitUntil(() => {
				const m = server.metricsSnapshot();
				return m.datagramsIn >= 1;
			}, 3000);
			expect(observed).toBe(true);

			const metrics = server.metricsSnapshot();
			expect(metrics).toBeDefined();
			expect(typeof metrics.sessionsActive).toBe("number");
			expect(typeof metrics.datagramsIn).toBe("number");
			expect(typeof metrics.datagramsOut).toBe("number");
			client.close();
		} finally {
			await server.close();
		}
	}, 15000);

	it("P1-6: repeated open/close cycles do not hang", async () => {
		for (let i = 0; i < 3; i++) {
			const port = nextPort();
			const server = createServer({
				port,
				tls: { certPem: "", keyPem: "" },
				onSession: () => {},
			});
			await Bun.sleep(1500);
			const client = await connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			client.close();
			await server.close();
		}
	}, 25000);

	it("P3-10: moderate load completes without panic", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					for await (const d of s.incomingDatagrams()) {
						await s.sendDatagram(d);
					}
				})().catch(() => {});
			},
		});
		await Bun.sleep(2000);

		const clients = await Promise.all(
			Array.from({ length: 4 }, () =>
				connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			),
		);
		const metrics = server.metricsSnapshot();
		expect(metrics.sessionsActive).toBe(4);

		await Promise.all(
			clients.flatMap((c) =>
				Array.from({ length: 20 }, () =>
					c.sendDatagram(new Uint8Array(100)).catch(() => {}),
				),
			),
		);
		clients.forEach((c) => c.close());
		await server.close();
	}, 20000);

	it("P3-1: latency histograms populated and metricsToPrometheus emits them", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					for await (const d of s.incomingDatagrams()) {
						await s.sendDatagram(d);
					}
				})().catch(() => {});
				void (async () => {
					const stream = await s.createBidirectionalStream();
					stream.write(Buffer.from("hi"));
					stream.end();
				})().catch(() => {});
			},
		});
		await Bun.sleep(2000);

		const client = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await client.sendDatagram(new Uint8Array([1, 2, 3]));
		const dgIter = client.incomingDatagrams()[Symbol.asyncIterator]();
		const dgNext = await readDatagramWithTimeout(dgIter, 1500);
		expect(dgNext.done).toBe(false);
		const iter = client.incomingBidirectionalStreams()[Symbol.asyncIterator]();
		const streamNext = (await Promise.race([
			iter.next(),
			Bun.sleep(2000).then(() => ({ done: true as const, value: undefined })),
		])) as IteratorResult<unknown>;
		expect(streamNext.done).toBe(false);
		await Bun.sleep(500);

		const m = server.metricsSnapshot() as Record<string, any>;
		const handshake = m.handshakeLatency ?? m.handshake_latency;
		const datagram = m.datagramEnqueueLatency ?? m.datagram_enqueue_latency;
		const streamOpen = m.streamOpenLatency ?? m.stream_open_latency;
		expect(handshake).toBeDefined();
		expect(handshake.count).toBeGreaterThanOrEqual(1);
		expect(datagram.count).toBeGreaterThanOrEqual(1);
		expect(streamOpen.count).toBeGreaterThanOrEqual(1);

		const { metricsToPrometheus } = await import("../src/index.js");
		const prom = metricsToPrometheus(m as any);
		expect(prom).toContain("handshake_latency_seconds_bucket");
		expect(prom).toContain("datagram_enqueue_latency_seconds_bucket");
		expect(prom).toContain("stream_open_latency_seconds_bucket");

		await server.close();
	}, 15000);
});
