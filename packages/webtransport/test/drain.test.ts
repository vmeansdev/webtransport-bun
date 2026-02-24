/**
 * P1.1: Promise/task/resource drain guarantees.
 * Validates that sessionTasksActive, streamTasksActive, queuedBytesGlobal
 * return to baseline after close, and that repeated stress loops do not hang.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

const BASE_PORT = 15200;

function nextPort(): number {
	return BASE_PORT + Math.floor(Math.random() * 400);
}

describe("drain guarantees (P1.1)", () => {
	it("stream + datagram stress burst drains to baseline after close", async () => {
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
		});
		await Bun.sleep(2000);

		const NUM_CLIENTS = 3;
		const clients = await Promise.all(
			Array.from({ length: NUM_CLIENTS }, () =>
				connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
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

		await Bun.sleep(4000);

		const mAfter = server.metricsSnapshot();
		expect(mAfter.sessionTasksActive).toBe(0);
		expect(mAfter.streamTasksActive).toBe(0);
		expect(mAfter.queuedBytesGlobal).toBeLessThanOrEqual(4 * 1024);

		await server.close();
	}, 25000);

	it("abandoned stream iterators drain on close", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				// Start iterators but close session before consuming all
				const dgramIter = s.incomingDatagrams()[Symbol.asyncIterator]();
				await dgramIter.next();
				const bidiIter = s.incomingBidirectionalStreams[Symbol.asyncIterator]();
				await bidiIter.next();
				// Session closes below; iterators should terminate
			},
		});
		await Bun.sleep(2000);

		const client = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await client.sendDatagram(new Uint8Array([1, 2, 3]));
		const stream = await client.createBidirectionalStream();
		stream.write(Buffer.alloc(10), () => {});

		await Bun.sleep(500);

		client.close();
		await Bun.sleep(3000);

		const mAfter = server.metricsSnapshot();
		expect(mAfter.sessionTasksActive).toBe(0);
		expect(mAfter.streamTasksActive).toBe(0);
		expect(mAfter.queuedBytesGlobal).toBeLessThanOrEqual(4 * 1024);

		await server.close();
	}, 15000);

	it("repeated open/close stress loop does not hang", async () => {
		const CYCLES = 20;
		for (let i = 0; i < CYCLES; i++) {
			// Use deterministic unique ports in-loop to avoid accidental
			// same-run port reuse/races from random selection.
			const port = BASE_PORT + i;
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
			await Bun.sleep(1000);

			const client = await connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			client.close();
			await server.close();
		}
	}, 120000);

	it("server close while clients active drains tasks", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});
		await Bun.sleep(2000);

		const clients = await Promise.all(
			Array.from({ length: 2 }, () =>
				connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
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
	}, 15000);
});
