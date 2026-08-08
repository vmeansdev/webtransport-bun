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
	forEachWithTimeout,
	readWithTimeout,
	waitFor,
	withTimeout,
} from "./helpers/harness.js";
import {
	connectWithRetry,
	nextPort,
	openWTWithRetry,
} from "./helpers/network.js";

const EMPTY_TLS = { certPem: "", keyPem: "" };

// Per-wave drain deadline for the churn-burst test. Correctness is unaffected
// — a leaked permit/task/registry entry NEVER returns the gauges to floor and
// fails at any deadline — but 50 concurrent TLS handshakes + teardowns can
// exceed 10s of wall clock on the slowest shared lane (macOS + Bun 1.3.14,
// ~50% of runs there). Same CI scaling the adversarial harness already uses.
const WAVE_DEADLINE_MS = process.env.CI ? 30_000 : 10_000;
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
					await forEachWithTimeout(
						s.incomingBidirectionalStreams,
						5000,
						"hardening regressions scheduling incoming bidi",
						async (duplex) => {
							void (async () => {
								const reader = duplex.readable.getReader();
								const first = await readWithTimeout(
									reader,
									5000,
									"stream scheduling classification read",
								);
								const tag = first.value?.[0];
								if (tag === DRAIN_TAG) {
									seen.drain = true;
									// Keep reading so this stream never backpressures.
									while (true) {
										const { done } = await readWithTimeout(
											reader,
											5000,
											"drain stream classification follow-up read",
										);
										if (done) break;
									}
								} else {
									// Stall stream: identify it, then never read again so the
									// client's writes to it park on flow control.
									seen.stall = true;
								}
							})().catch(() => {});
						},
					);
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

			await waitFor(
				() => seen.stall && seen.drain,
				Boolean,
				5000,
				25,
				"stall/drain stream classification",
			);

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
			await waitFor(
				() => server.metricsSnapshot().sessionsActive === 0,
				Boolean,
				15000,
				25,
				"sessionsActive drain after close/connect race",
			);
			expect(server.metricsSnapshot().sessionsActive).toBe(0);
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
				const acceptedBefore = acceptedIds.size;
				await Promise.all(
					Array.from({ length: perWave }, async () => {
						const c = await connectWithRetry(
							`https://127.0.0.1:${port}`,
							INSECURE,
							3000,
						);
						c.close();
					}),
				);

				// Per-wave lifecycle gauges. A leaked handshake permit, registry
				// entry or session task shows up here as a gauge that never returns
				// to its floor, waves before the workload as a whole times out.
				const wave = await waitFor(
					() => server.metricsSnapshot(),
					(m) =>
						m.handshakesInFlight === 0 &&
						m.sessionsActive === 0 &&
						m.sessionTasksActive === 0 &&
						m.streamsActive === 0 &&
						m.queuedBytesGlobal === 0,
					WAVE_DEADLINE_MS,
					25,
					`wave ${w} lifecycle gauges did not return to floor`,
				);
				expect(wave.handshakesInFlight).toBe(0);
				expect(wave.sessionsActive).toBe(0);
				expect(wave.sessionTasksActive).toBe(0);
				expect(wave.streamsActive).toBe(0);
				expect(wave.queuedBytesGlobal).toBe(0);
				// Admission must keep making progress: each wave has to accept new
				// sessions, otherwise the server is starving new handshakes.
				expect(acceptedIds.size).toBeGreaterThan(acceptedBefore);

				// Closed delivery must keep pace with acceptance rather than
				// accumulating an unbounded backlog across waves.
				await waitFor(
					() => closedIds.size,
					(n) => n === acceptedIds.size,
					WAVE_DEADLINE_MS,
					25,
					`wave ${w} closed events delivered (${closedIds.size}/${acceptedIds.size})`,
				);
			}

			expect(acceptedIds.size).toBeGreaterThan(600);

			// Every accepted session must eventually emit its Closed event.
			// Pre-fix, Closed events were silently dropped under burst.
			await waitFor(
				() => closedIds.size === acceptedIds.size && acceptedIds.size > 600,
				Boolean,
				30000,
				25,
				"closed event burst drain",
			);
			const missing = [...acceptedIds].filter((id) => !closedIds.has(id));
			expect(missing).toEqual([]);

			const drained = await waitFor(
				() => server.metricsSnapshot(),
				(m) =>
					m.sessionsActive === 0 &&
					m.sessionTasksActive === 0 &&
					m.handshakesInFlight === 0 &&
					m.queuedBytesGlobal === 0,
				15000,
				25,
				"post-churn lifecycle drain",
			);
			expect(drained.sessionsActive).toBe(0);
			expect(drained.sessionTasksActive).toBe(0);
			expect(drained.handshakesInFlight).toBe(0);
			expect(drained.queuedBytesGlobal).toBe(0);
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
			const { value: recvStream } = await readWithTimeout(
				outer,
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
					await forEachWithTimeout(
						s.incomingBidirectionalStreams,
						5000,
						"hardening regressions wire stats incoming bidi",
						async (duplex) => {
							void (async () => {
								const reader = duplex.readable.getReader();
								const writer = duplex.writable.getWriter();
								while (true) {
									const { done, value } = await readWithTimeout(
										reader,
										10000,
										"stream-only stats echo read",
									);
									if (done) break;
									if (value) await writer.write(value);
								}
								await writer.close();
							})().catch(() => {});
						},
					);
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
					const { done, value } = await readWithTimeout(
						reader,
						10000,
						"stream-only stats client read",
					);
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

	it("7. many concurrent streams under shared byte-budget pressure all complete (no cross-stream notify starvation)", async () => {
		const port = nextPort(24660, 500);
		const STREAMS = 12;
		const CHUNKS_PER = 10;
		const CHUNK_SIZE = 32 * 1024; // 12 * 10 * 32KiB = ~3.75 MiB total, above the
		// 2 MiB per-session byte budget, so streams contend for shared session/global
		// budget and some park in reserve_or_wait / the recv budget loop. Kept modest
		// so the test stays fast and stable under full-suite CPU contention while
		// still forcing the cross-stream contention the fix addresses.
		const server = createServer({
			port,
			tls: EMPTY_TLS,
			rateLimits: NO_RATE_LIMIT,
			onSession: (s: ServerSession) => {
				void (async () => {
					const chunk = new Uint8Array(CHUNK_SIZE).fill(0x5c);
					const writers = Array.from({ length: STREAMS }, async () => {
						const w = await s.createUnidirectionalStream();
						w.on("error", () => {});
						for (let i = 0; i < CHUNKS_PER; i++) {
							await new Promise<void>((resolve, reject) => {
								w.write(chunk, (err: Error | null | undefined) =>
									err ? reject(err) : resolve(),
								);
							});
						}
						await new Promise<void>((resolve) => w.end(resolve));
					});
					await Promise.all(writers);
				})().catch(() => {});
			},
		});

		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, INSECURE);
		try {
			const reader = wt.incomingUnidirectionalStreams.getReader();
			const drained: Promise<number>[] = [];
			for (let s = 0; s < STREAMS; s++) {
				const { value: recvStream, done } = await readWithTimeout(
					reader,
					30000,
					`incoming stream ${s} never arrived`,
				);
				if (done || !recvStream) break;
				// Drain each stream concurrently; a starved stream would hang here.
				drained.push(
					(async () => {
						const r = (recvStream as ReadableStream<Uint8Array>).getReader();
						let got = 0;
						while (true) {
							const { done: d, value } = await readWithTimeout(
								r,
								30000,
								"a concurrent stream stalled (budget-notify starvation)",
							);
							if (d) break;
							if (value) got += value.byteLength;
						}
						return got;
					})(),
				);
			}
			const totals = await Promise.all(drained);
			expect(totals.length).toBe(STREAMS);
			for (const got of totals) {
				expect(got).toBe(CHUNKS_PER * CHUNK_SIZE);
			}
		} finally {
			wt.close();
			await server.close();
		}
	}, 60000);

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
			const { value: recvStream } = await readWithTimeout(
				outer,
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
				const { done, value } = await readWithTimeout(
					reader,
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
