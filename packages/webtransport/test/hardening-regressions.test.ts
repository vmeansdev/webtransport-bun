/**
 * Regression tests for the production-hardening fixes.
 *
 * Each test is written so it FAILS against the pre-fix code:
 *  1. Per-stream send scheduling (no cross-stream head-of-line blocking).
 *  2. close() during connect settles `closed` and releases the session.
 *  3. Session Closed events survive a churn burst (old 512-slot batcher).
 *  4. Receive-side backpressure is bounded (client does not drain eagerly).
 *  5. getStats() reports real QUIC wire stats (not datagram-count relabels).
 */

import { describe, expect, it } from "bun:test";
import {
	createServer,
	type ServerSession,
	WebTransport,
} from "../src/index.js";
import {
	connectWithRetry,
	nextPort,
	openWTWithRetry,
} from "./helpers/network.js";

const EMPTY_TLS = { certPem: "", keyPem: "" };
const INSECURE = { tls: { insecureSkipVerify: true } } as const;

// Rate limits high enough that a burst of connects/streams is never throttled.
const NO_RATE_LIMIT = {
	handshakesPerSec: 100_000,
	handshakesBurst: 100_000,
	handshakesBurstPerPrefix: 100_000,
	streamsPerSec: 100_000,
	streamsBurst: 100_000,
	datagramsPerSec: 100_000,
	datagramsBurst: 100_000,
};

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`timeout after ${ms}ms: ${label}`)),
			ms,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
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

describe("hardening regressions", () => {
	it("1. no cross-stream head-of-line blocking (per-stream scheduling)", async () => {
		const port = nextPort(24600, 500);
		const STALL_TAG = 0xaa;
		const DRAIN_TAG = 0xbb;
		const seen = { stall: false, drain: false };

		const server = createServer({
			port,
			tls: EMPTY_TLS,
			rateLimits: NO_RATE_LIMIT,
			onSession: (s: ServerSession) => {
				void (async () => {
					for await (const duplex of s.incomingBidirectionalStreams) {
						void (async () => {
							const reader = duplex.readable.getReader();
							const first = await reader.read();
							const tag = first.value?.[0];
							if (tag === DRAIN_TAG) {
								seen.drain = true;
								// Keep reading so this stream never backpressures.
								while (true) {
									const { done } = await reader.read();
									if (done) break;
								}
							} else {
								// Stall stream: identify it, then never read again so the
								// client's writes to it park on flow control.
								seen.stall = true;
							}
						})().catch(() => {});
					}
				})().catch(() => {});
			},
		});

		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			// Small per-stream client queue so the stalled stream parks quickly.
			limits: { maxQueuedBytesPerStream: 32 * 1024 },
		});

		let floodStop = false;
		try {
			const streamA = await wt.createBidirectionalStream();
			const streamB = await wt.createBidirectionalStream();
			const wA = streamA.writable.getWriter();
			const wB = streamB.writable.getWriter();

			await wA.write(new Uint8Array([STALL_TAG]));
			await wB.write(new Uint8Array([DRAIN_TAG]));

			const classified = await waitUntil(() => seen.stall && seen.drain, 5000);
			expect(classified).toBe(true);

			// Flood stream A. The server never reads it, so this loop parks on
			// wA.ready and occupies the send path's head.
			const flood = (async () => {
				const chunk = new Uint8Array(64 * 1024);
				try {
					while (!floodStop) {
						await wA.ready;
						await wA.write(chunk);
					}
				} catch {
					// Writer errors on close; expected.
				}
			})();
			flood.catch(() => {});

			// Let the flood reach its stall point.
			await Bun.sleep(150);

			// While A is stalled, a small write on B and a datagram must both
			// complete promptly. Pre-fix, the shared SendScheduler serialized
			// them behind A's parked flush and this timed out.
			const dgWriter = wt.datagrams.writable.getWriter();
			await withTimeout(
				Promise.all([
					wB.write(new Uint8Array(16)),
					dgWriter.write(new Uint8Array([1, 2, 3])),
				]),
				2500,
				"stream B write / datagram stuck behind stalled stream A",
			);
		} finally {
			floodStop = true;
			wt.close();
			await server.close();
		}
	}, 30000);

	it("2. close() during connect settles closed and releases the session", async () => {
		const port = nextPort(24610, 500);
		const server = createServer({
			port,
			tls: EMPTY_TLS,
			rateLimits: NO_RATE_LIMIT,
			onSession: () => {},
		});

		try {
			const runs = 20;
			for (let i = 0; i < runs; i++) {
				const wt = new WebTransport(`https://127.0.0.1:${port}`, INSECURE);

				// Vary how far the connect has progressed before close() races it.
				switch (i % 6) {
					case 0:
						break; // synchronous close, still "connecting"
					case 1:
						await Promise.resolve();
						break;
					case 2:
						await Promise.resolve();
						await Promise.resolve();
						break;
					case 3:
						await Promise.resolve();
						await Promise.resolve();
						await Promise.resolve();
						break;
					case 4:
						await new Promise((r) => setTimeout(r, 0));
						break;
					default:
						await new Promise((r) => setTimeout(r, 0));
						await new Promise((r) => setTimeout(r, 0));
						break;
				}

				wt.close();

				// closed must settle (pre-fix it hung when close raced connect success).
				const info = await withTimeout(
					wt.closed,
					5000,
					`closed did not settle after close() during connect (iter ${i})`,
				);
				expect(info).toBeDefined();
			}

			// Every session that was actually established must be torn down, not
			// leaked until idle timeout.
			const drained = await waitUntil(
				() => server.metricsSnapshot().sessionsActive === 0,
				15000,
			);
			expect(server.metricsSnapshot().sessionsActive).toBe(0);
			expect(drained).toBe(true);
		} finally {
			await server.close();
		}
	}, 60000);

	it("3. Closed events survive a churn burst (>512 sessions)", async () => {
		const port = nextPort(24620, 500);
		const acceptedIds = new Set<string>();
		const closedIds = new Set<string>();

		const server = createServer({
			port,
			tls: EMPTY_TLS,
			rateLimits: NO_RATE_LIMIT,
			limits: { maxSessions: 100_000 },
			onSession: (s: ServerSession) => {
				acceptedIds.add(s.id);
				void s.closed.then(() => {
					closedIds.add(s.id);
				});
			},
		});

		try {
			const waves = 14; // 14 * 50 = 700 > old 512-slot batcher capacity
			const perWave = 50;
			for (let w = 0; w < waves; w++) {
				await Promise.all(
					Array.from({ length: perWave }, async () => {
						const c = await connectWithRetry(
							`https://127.0.0.1:${port}`,
							INSECURE,
							8000,
						);
						c.close();
					}),
				);
			}

			expect(acceptedIds.size).toBeGreaterThan(600);

			// Every accepted session must eventually emit its Closed event.
			// Pre-fix, Closed events were silently dropped under burst.
			const allClosed = await waitUntil(
				() => closedIds.size === acceptedIds.size && acceptedIds.size > 600,
				30000,
			);
			const missing = [...acceptedIds].filter((id) => !closedIds.has(id));
			expect(missing).toEqual([]);
			expect(allClosed).toBe(true);
		} finally {
			await server.close();
		}
	}, 120000);

	it("4. receive-side backpressure is bounded (client does not drain eagerly)", async () => {
		const port = nextPort(24630, 500);
		const CHUNKS = 300;
		const CHUNK_SIZE = 64 * 1024;

		// 300 x 64KiB = ~18.75 MiB, far larger than any default receive window, so
		// an eager (pre-fix) client draining the wire would let the server push all
		// CHUNKS, while a backpressured client bounds it to a small prefix.
		const state = { sent: 0 };
		const server = createServer({
			port,
			tls: EMPTY_TLS,
			rateLimits: NO_RATE_LIMIT,
			onSession: (s: ServerSession) => {
				void (async () => {
					const writable = await s.createUnidirectionalStream();
					writable.on("error", () => {});
					const chunk = new Uint8Array(CHUNK_SIZE).fill(7);
					// The write callback fires only once the chunk clears the send
					// budget, i.e. the peer granted flow-control credit. A stalled
					// client grants none, so this parks and `sent` stops climbing.
					const writeChunk = () =>
						new Promise<void>((resolve, reject) => {
							writable.write(chunk, (err: Error | null | undefined) =>
								err ? reject(err) : resolve(),
							);
						});
					for (let i = 0; i < CHUNKS; i++) {
						await writeChunk();
						state.sent = i + 1;
					}
				})().catch(() => {});
			},
		});

		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, INSECURE);

		try {
			// Obtain the incoming stream object but never consume it.
			const outer = wt.incomingUnidirectionalStreams.getReader();
			const { value: recvStream } = await withTimeout(
				outer.read(),
				8000,
				"incoming unidirectional stream never arrived",
			);
			expect(recvStream).toBeDefined();

			// Let the server push against a non-reading client. Receive backpressure
			// bounds it to a small prefix; pre-fix the client drained the wire
			// eagerly and the server reached CHUNKS with no pushback.
			await Bun.sleep(1500);
			expect(state.sent).toBeGreaterThan(0); // transfer actually started
			expect(state.sent).toBeLessThan(CHUNKS);
			expect(state.sent).toBeLessThan(100);
		} finally {
			wt.close();
			await server.close();
		}
	}, 45000);

	it("5. getStats returns real wire stats for stream-only transfers", async () => {
		const port = nextPort(24640, 500);
		const server = createServer({
			port,
			tls: EMPTY_TLS,
			rateLimits: NO_RATE_LIMIT,
			onSession: (s: ServerSession) => {
				void (async () => {
					for await (const duplex of s.incomingBidirectionalStreams) {
						void (async () => {
							const reader = duplex.readable.getReader();
							const writer = duplex.writable.getWriter();
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								if (value) await writer.write(value);
							}
							await writer.close();
						})().catch(() => {});
					}
				})().catch(() => {});
			},
		});

		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, INSECURE);

		try {
			// STREAMS ONLY, no datagrams: pre-fix packet counters were datagram
			// relabels and would read 0 here.
			const { readable, writable } = await wt.createBidirectionalStream();
			const writer = writable.getWriter();
			const reader = readable.getReader();

			// Drain the echo concurrently so the receive queue never fills.
			let received = 0;
			const readAll = (async () => {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) received += value.byteLength;
				}
			})();

			const payload = new Uint8Array(16 * 1024).fill(9);
			for (let i = 0; i < 8; i++) {
				await writer.write(payload);
			}
			await writer.close();
			await readAll;
			expect(received).toBe(8 * 16 * 1024);

			const stats = await wt.getStats();
			expect(stats.bytesSent ?? 0).toBeGreaterThan(0);
			expect(stats.bytesReceived ?? 0).toBeGreaterThan(0);
			expect(stats.packetsSent ?? 0).toBeGreaterThan(0);
			expect(stats.packetsReceived ?? 0).toBeGreaterThan(0);
			expect(stats.smoothedRtt).toBeDefined();
			expect(stats.smoothedRtt ?? -1).toBeGreaterThanOrEqual(0);
		} finally {
			wt.close();
			await server.close();
		}
	}, 30000);

	it("6. receive-side backpressure is lossless: stall then resume delivers all bytes", async () => {
		const port = nextPort(24650, 500);
		const CHUNKS = 200;
		const CHUNK_SIZE = 64 * 1024; // 200 x 64KiB = 12.5 MiB >> receive window
		const server = createServer({
			port,
			tls: EMPTY_TLS,
			rateLimits: NO_RATE_LIMIT,
			onSession: (s: ServerSession) => {
				void (async () => {
					const writable = await s.createUnidirectionalStream();
					writable.on("error", () => {});
					const chunk = new Uint8Array(CHUNK_SIZE).fill(0xab);
					for (let i = 0; i < CHUNKS; i++) {
						await new Promise<void>((resolve, reject) => {
							writable.write(chunk, (err: Error | null | undefined) =>
								err ? reject(err) : resolve(),
							);
						});
					}
					await new Promise<void>((resolve) => writable.end(resolve));
				})().catch(() => {});
			},
		});

		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, INSECURE);
		try {
			const outer = wt.incomingUnidirectionalStreams.getReader();
			const { value: recvStream } = await withTimeout(
				outer.read(),
				8000,
				"incoming unidirectional stream never arrived",
			);
			expect(recvStream).toBeDefined();

			// Stall: let the sender park against QUIC flow control for a while.
			await Bun.sleep(1500);

			// Resume: drain fully. A lossless implementation delivers every byte
			// the sender parked on; the pre-lossless code RESET the stream on
			// budget overflow and truncated the transfer.
			const reader = (recvStream as ReadableStream<Uint8Array>).getReader();
			let received = 0;
			while (true) {
				const { done, value } = await withTimeout(
					reader.read(),
					20000,
					"stalled receive stream did not resume delivering",
				);
				if (done) break;
				if (value) received += value.byteLength;
			}
			expect(received).toBe(CHUNKS * CHUNK_SIZE);
		} finally {
			wt.close();
			await server.close();
		}
	}, 60000);
});
