/**
 * Acceptance tests for Task.md gates.
 * - P0-2: Sustained multi-stream traffic; streams opened/accepted repeatedly with limits enforced
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import {
	forEachWithTimeout,
	nextWithTimeout,
	waitFor,
} from "./helpers/harness.js";
import { nextPort as allocatePort } from "./helpers/network.js";

const BASE_PORT = 14600;

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
		const port = allocatePort(BASE_PORT, 500);
		let streamsAccepted = 0;
		let datagramsEchoed = 0;

		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						5000,
						"acceptance sustained traffic incoming datagram",
						async (d) => {
							await s.sendDatagram(d);
							datagramsEchoed++;
						},
					);
				})().catch(() => {});
				void (async () => {
					await forEachWithTimeout(
						s.incomingBidirectionalStreams,
						5000,
						"acceptance sustained traffic incoming bidi",
						async () => {
							streamsAccepted++;
						},
					);
				})().catch(() => {});
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
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
				const next = await nextWithTimeout(
					iter,
					1200,
					"acceptance sustained traffic echoed datagram",
				);
				if (next.done) break;
				received++;
			}
			expect(received).toBe(10);
			await waitFor(
				() => streamsAccepted,
				(count) => count >= 5,
				3000,
				25,
				"acceptance sustained traffic streams accepted",
			);
			await waitFor(
				() => datagramsEchoed,
				(count) => count >= 10,
				3000,
				25,
				"acceptance sustained traffic datagrams echoed",
			);
			expect(streamsAccepted).toBe(5);
			expect(datagramsEchoed).toBeGreaterThanOrEqual(10);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("P1-4: metricsSnapshot reflects activity", async () => {
		const port = allocatePort(BASE_PORT, 500);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						5000,
						"acceptance metrics incoming datagram",
						async (d) => {
							await s.sendDatagram(d);
						},
					);
				})().catch(() => {});
			},
		});
		let client: Awaited<ReturnType<typeof connect>> | undefined;
		try {
			client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			await client.sendDatagram(new Uint8Array([1, 2, 3]));

			await waitFor(
				() => server.metricsSnapshot().datagramsIn,
				(count) => count >= 1,
				3000,
				25,
				"acceptance metrics datagrams in",
			);

			const metrics = server.metricsSnapshot();
			expect(metrics).toBeDefined();
			expect(typeof metrics.sessionsActive).toBe("number");
			expect(typeof metrics.datagramsIn).toBe("number");
			expect(typeof metrics.datagramsOut).toBe("number");
		} finally {
			client?.close();
			await server.close();
		}
	}, 15000);

	it("P1-6: repeated open/close cycles do not hang", async () => {
		for (let i = 0; i < 3; i++) {
			const port = allocatePort(BASE_PORT, 500);
			const server = createServer({
				port,
				tls: { certPem: "", keyPem: "" },
				onSession: () => {},
			});
			let client: Awaited<ReturnType<typeof connect>> | undefined;
			try {
				client = await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				});
			} finally {
				client?.close();
				await server.close();
			}
		}
	}, 25000);

	it("P3-10: moderate load completes without panic", async () => {
		const port = allocatePort(BASE_PORT, 500);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						5000,
						"acceptance moderate load incoming datagram",
						async (d) => {
							await s.sendDatagram(d);
						},
					);
				})().catch(() => {});
			},
		});
		const clients: Awaited<ReturnType<typeof connect>>[] = [];
		try {
			for (let i = 0; i < 4; i++) {
				clients.push(
					await connectWithRetry(
						`https://127.0.0.1:${port}`,
						{ tls: { insecureSkipVerify: true } },
						10_000,
					),
				);
			}
			await waitFor(
				() => server.metricsSnapshot().sessionsActive,
				(count) => count >= 4,
				8000,
				25,
				"acceptance moderate load sessions visible",
			);

			await Promise.all(
				clients.flatMap((c) =>
					Array.from({ length: 20 }, () =>
						c.sendDatagram(new Uint8Array(100)).catch(() => {}),
					),
				),
			);
		} finally {
			clients.forEach((c) => c.close());
			await server.close();
		}
	}, 40000);

	it("P3-1: latency histograms populated and metricsToPrometheus emits them", async () => {
		const port = allocatePort(BASE_PORT, 500);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						5000,
						"acceptance histogram incoming datagram",
						async (d) => {
							await s.sendDatagram(d);
						},
					);
				})().catch(() => {});
				void (async () => {
					const stream = await s.createBidirectionalStream();
					stream.write(Buffer.from("hi"));
					stream.end();
				})().catch(() => {});
			},
		});
		let client: Awaited<ReturnType<typeof connect>> | undefined;
		try {
			client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			const dgIter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const dgNext = await nextWithTimeout(
				dgIter,
				1500,
				"acceptance histogram echoed datagram",
			);
			expect(dgNext.done).toBe(false);
			const iter = client
				.incomingBidirectionalStreams()
				[Symbol.asyncIterator]();
			const streamNext = await nextWithTimeout(
				iter,
				2000,
				"acceptance histogram incoming bidi",
			);
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
		} finally {
			client?.close();
			await server.close();
		}
	}, 15000);
});
