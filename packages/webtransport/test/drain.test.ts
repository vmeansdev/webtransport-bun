/**
 * P1.1: Promise/task/resource drain guarantees.
 * Validates that sessionTasksActive, streamTasksActive, queuedBytesGlobal
 * return to baseline after close, and that repeated stress loops do not hang.
 */

import { describe, it, expect } from "bun:test";
import { createServer } from "../src/index.js";
import { withHarness } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 15200;

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

describe("drain guarantees (P1.1)", () => {
	it("stream + datagram stress burst drains to baseline after close", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						void (async () => {
							for await (const d of s.incomingDatagrams()) {
								await s.sendDatagram(d);
							}
						})().catch(() => {});
						void (async () => {
							for await (const bidi of s.incomingBidirectionalStreams) {
								for await (const _ of bidi.readable) {
									/* consume */
								}
							}
						})().catch(() => {});
						void (async () => {
							for await (const _ of s.incomingUnidirectionalStreams) {
								/* consume */
							}
						})().catch(() => {});
					},
				}),
			);
			const NUM_CLIENTS = 3;
			const clients = await Promise.all(
				Array.from({ length: NUM_CLIENTS }, () =>
					connectWithRetry(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
					}).then((c) => h.track(c)),
				),
			);

			// Datagrams
			for (const c of clients) {
				for (let i = 0; i < 5; i++) {
					await c.sendDatagram(new Uint8Array([i, i + 1]));
				}
			}

			// Bidi streams
			for (const c of clients) {
				const streams = await Promise.all(
					Array.from({ length: 3 }, () => c.createBidirectionalStream()),
				);
				for (const st of streams) {
					st.write(Buffer.alloc(100, "x"), () => {});
					st.end();
				}
			}

			// Uni streams
			for (const c of clients) {
				const st = await c.createUnidirectionalStream();
				st.write(Buffer.alloc(50, "y"), () => {});
				st.end();
			}

			await Bun.sleep(500);

			const mDuring = server.metricsSnapshot();
			expect(mDuring.sessionsActive).toBe(NUM_CLIENTS);

			for (const c of clients) {
				c.close();
			}

			const drained = await waitUntil(() => {
				const m = server.metricsSnapshot();
				return (
					m.sessionTasksActive === 0 &&
					m.streamTasksActive === 0 &&
					m.queuedBytesGlobal <= 4 * 1024
				);
			}, 7000);
			expect(drained).toBe(true);
		});
	}, 25000);

	it("abandoned stream iterators drain on close", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						// Start iterators but close session before consuming all
						const dgramIter = s.incomingDatagrams()[Symbol.asyncIterator]();
						await dgramIter.next();
						const bidiIter =
							s.incomingBidirectionalStreams[Symbol.asyncIterator]();
						await bidiIter.next();
						// Session closes below; iterators should terminate
					},
				}),
			);
			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			const stream = await client.createBidirectionalStream();
			stream.write(Buffer.alloc(10), () => {});

			await Bun.sleep(500);

			client.close();
			const drained = await waitUntil(() => {
				const m = server.metricsSnapshot();
				return (
					m.sessionTasksActive === 0 &&
					m.streamTasksActive === 0 &&
					m.queuedBytesGlobal <= 4 * 1024
				);
			}, 7000);
			expect(drained).toBe(true);
		});
	}, 15000);

	it("repeated open/close stress loop does not hang", async () => {
		// Keep this under strict CI per-test timeout budgets while still exercising
		// repeated setup/teardown behavior.
		const CYCLES = 6;
		for (let i = 0; i < CYCLES; i++) {
			const port = nextPort(BASE_PORT + 1000, 1000);
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
				const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				});
				await client.sendDatagram(new Uint8Array([1, 2, 3]));
				client.close();
			} finally {
				await server.close();
			}
		}
	}, 10000);

	it("server close while clients active drains tasks", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						for await (const d of s.incomingDatagrams()) {
							await s.sendDatagram(d);
						}
					},
				}),
			);
			const clients = await Promise.all(
				Array.from({ length: 2 }, () =>
					connectWithRetry(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
					}).then((c) => h.track(c)),
				),
			);
			for (const c of clients) {
				c.sendDatagram(new Uint8Array([1])).catch(() => {});
			}
			await Bun.sleep(300);

			await server.close();

			const mAfter = server.metricsSnapshot();
			expect(mAfter.sessionTasksActive).toBe(0);
			expect(mAfter.streamTasksActive).toBe(0);
		});
	}, 15000);
});
