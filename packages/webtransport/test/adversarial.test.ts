/**
 * P3.2: Adversarial transport tests — malformed/fuzz-like sequences, churn patterns.
 * Verifies server withstands abuse without panic; metrics and drain behavior remain sane.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import {
	forEachWithTimeout,
	nextWithTimeout,
	withHarness,
} from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 14800;

describe("adversarial transport (P3.2)", () => {
	it("connection churn: rapid connect/disconnect does not panic, metrics drain", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: () => {},
				}),
			);
			const cycles = 20;
			for (let i = 0; i < cycles; i++) {
				const client = h.track(
					await connectWithRetry(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
					}),
				);
				client.close();
				await Bun.sleep(30);
			}

			await Bun.sleep(2000);
			const m = server.metricsSnapshot();
			expect(m.sessionsActive).toBe(0);
			expect(m.streamsActive).toBe(0);
		});
	}, 30000);

	it("stream churn: rapid stream open/close under limit does not panic", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					limits: { maxStreamsPerSessionBidi: 10, maxStreamsPerSessionUni: 10 },
					onSession: () => {},
				}),
			);
			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);

			for (let i = 0; i < 8; i++) {
				const stream = await client.createBidirectionalStream();
				stream.write(Buffer.from([i]));
				stream.end();
			}

			await Bun.sleep(500);
			const mDuring = server.metricsSnapshot();
			expect(mDuring.streamsActive).toBeLessThanOrEqual(10);

			client.close();
			await Bun.sleep(2000);
			const mAfter = server.metricsSnapshot();
			expect(mAfter.streamsActive).toBe(0);
			expect(mAfter.sessionsActive).toBe(0);
		});
	}, 25000);

	it("mixed churn: concurrent connect/disconnect + stream + datagram stress", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					limits: { maxSessions: 8, maxStreamsPerSessionBidi: 5 },
					onSession: async (s) => {
						void (async () => {
							await forEachWithTimeout(
								s.incomingDatagrams(),
								5000,
								"adversarial mixed churn incoming datagram",
								async (d) => {
									await s.sendDatagram(d);
								},
							);
						})().catch(() => {});
						void (async () => {
							await forEachWithTimeout(
								s.incomingBidirectionalStreams,
								5000,
								"adversarial mixed churn incoming bidi",
								async () => undefined,
							);
						})().catch(() => {});
					},
				}),
			);
			const connectDisconnect = async () => {
				const c = h.track(
					await connectWithRetry(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
					}),
				);
				await c.sendDatagram(new Uint8Array(64));
				const stream = await c.createBidirectionalStream();
				stream.write(Buffer.alloc(100));
				stream.end();
				c.close();
			};

			await Promise.all([
				...Array.from({ length: 6 }, () => connectDisconnect().catch(() => {})),
			]);

			await Bun.sleep(2000);
			const m = server.metricsSnapshot();
			expect(m.sessionsActive).toBe(0);
			expect(m.streamsActive).toBe(0);
		});
	}, 25000);

	it("edge payloads: empty datagram and max-size datagram accepted cleanly", async () => {
		const port = nextPort(BASE_PORT, 400);
		const maxSize = 256;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxDatagramSize: maxSize },
			onSession: async (s) => {
				void (async () => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						5000,
						"adversarial edge payload incoming datagram",
						async (d) => {
							await s.sendDatagram(d);
						},
					);
				})().catch(() => {});
			},
		});
		let client: Awaited<ReturnType<typeof connect>> | null = null;
		try {
			client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});

			await client.sendDatagram(new Uint8Array(0));
			const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const r0 = await nextWithTimeout(
				iter,
				2000,
				"adversarial edge payload empty datagram echo",
			);
			if (r0.done || r0.value === undefined) {
				throw new Error("timed out waiting for echoed datagram");
			}
			expect(r0).toBeDefined();
			expect(r0.value.length).toBe(0);

			await client.sendDatagram(new Uint8Array(maxSize).fill(0x41));
			const r1 = await nextWithTimeout(
				iter,
				2000,
				"adversarial edge payload max datagram echo",
			);
			if (r1.done || r1.value === undefined) {
				throw new Error("timed out waiting for echoed datagram");
			}
			expect(r1).toBeDefined();
			expect(r1.value.length).toBe(maxSize);
		} finally {
			client?.close();
			await server.close();
		}
	}, 15000);
});
