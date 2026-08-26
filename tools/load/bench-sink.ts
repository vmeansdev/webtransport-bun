/**
 * Stream sink latency gate (RFC_STREAM_SINK §9.4): the productized successor
 * of the g11 native-sink harness cell. Measures app-observed message latency
 * (client send stamp → consume, wall clock, same host) for the two read
 * paths under a saturated receiver event loop:
 *
 *   - facade: Node stream reads on the main JS loop (the path whose tail is
 *     a queueing function of loop utilization — docs/OPERATIONS.md).
 *   - sink:   native sink → SharedArrayBuffer ring → SinkReader in a Worker.
 *
 * The sender runs in a child process so the receiver-side saturator cannot
 * throttle it. The saturator busy-spins the receiver main loop at a duty
 * cycle; the sink path's latency should stay flat where the facade degrades.
 *
 * Usage: bun tools/load/bench-sink.ts
 * Env: SINK_BENCH_STREAMS (8), SINK_BENCH_RATE_HZ (100 msgs/s/stream),
 *      SINK_BENCH_PAYLOAD (1024 B), SINK_BENCH_DURATION_S (15),
 *      SINK_BENCH_SATURATE_PCT (0), SINK_BENCH_MODES (facade,sink),
 *      SINK_BENCH_WAKE_MS (0.5), SINK_BENCH_JSON (path for the summary).
 * The authoritative gate runs on the Linux dedicated runner; local macOS
 * numbers are indicative only.
 */

import {
	connect,
	createServer,
	openReadSink,
} from "../../packages/webtransport/src/index.js";
import type { StreamSinkFraming } from "../../packages/webtransport/src/sink-layout.js";

const FRAME_HEADER_BYTES = 16; // u32 totalLen (incl header) | u32 seq | f64 sendWallMs
const FRAMING: StreamSinkFraming = {
	headerBytes: FRAME_HEADER_BYTES,
	lengthOffset: 0,
	lengthWidth: 4,
	lengthIncludesHeader: true,
	maxFrameBytes: 64 * 1024,
};

const env = (name: string, fallback: number): number => {
	const raw = process.env[name];
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
};

const STREAMS = env("SINK_BENCH_STREAMS", 8);
const RATE_HZ = env("SINK_BENCH_RATE_HZ", 100);
const PAYLOAD = env("SINK_BENCH_PAYLOAD", 1024);
const DURATION_S = env("SINK_BENCH_DURATION_S", 15);
const SATURATE_PCT = env("SINK_BENCH_SATURATE_PCT", 0);
const WAKE_MS = env("SINK_BENCH_WAKE_MS", 0.5);
const MODES = (process.env.SINK_BENCH_MODES ?? "facade,sink")
	.split(",")
	.map((m) => m.trim())
	.filter((m) => m === "facade" || m === "sink");

/** Wall-anchored milliseconds with sub-ms precision, comparable across
 * processes on one host. */
function wallNowMs(): number {
	return performance.timeOrigin + performance.now();
}

function quantiles(sorted: number[]): Record<string, number> {
	const pick = (q: number) =>
		sorted.length === 0
			? Number.NaN
			: (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ??
				Number.NaN);
	return { p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), max: pick(1) };
}

// ---------------------------------------------------------------------------
// Role: sender child process. Opens STREAMS bidi streams and writes stamped
// frames at RATE_HZ per stream for DURATION_S, then finishes them.
// ---------------------------------------------------------------------------
if (process.argv[2] === "sender") {
	const url = process.argv[3];
	if (!url) throw new Error("sender needs a url");
	const client = await connect(url, { tls: { insecureSkipVerify: true } });
	const streams = await Promise.all(
		Array.from({ length: STREAMS }, () => client.createBidirectionalStream()),
	);
	const intervalMs = 1000 / RATE_HZ;
	const endAt = Date.now() + DURATION_S * 1000;
	let seq = 0;
	const frame = Buffer.alloc(FRAME_HEADER_BYTES + PAYLOAD, 7);
	frame.writeUInt32LE(frame.length, 0);
	while (Date.now() < endAt) {
		const tick = wallNowMs();
		for (const stream of streams) {
			frame.writeUInt32LE(seq++, 4);
			frame.writeDoubleLE(wallNowMs(), 8);
			stream.write(Buffer.from(frame));
		}
		const elapsed = wallNowMs() - tick;
		await Bun.sleep(Math.max(0, intervalMs - elapsed));
	}
	for (const stream of streams) stream.end();
	await Bun.sleep(500);
	client.close();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Role: sink worker. Consumes rings, records send→consume latency per frame.
// ---------------------------------------------------------------------------
if (!Bun.isMainThread) {
	// Register the listener synchronously: a message posted while the module
	// is still past its top-level await would otherwise be dropped.
	const queued: MessageEvent[] = [];
	let handler: ((event: MessageEvent) => void) | null = null;
	globalThis.addEventListener("message", (event) => {
		if (handler) handler(event as MessageEvent);
		else queued.push(event as MessageEvent);
	});
	const { SinkReader } = await import(
		"../../packages/webtransport/src/sink-reader.js"
	);
	handler = (event: MessageEvent) => {
		const { sinks, wakeTimeoutMs, deadlineMs } = event.data as {
			sinks: { sab: SharedArrayBuffer; descriptor: never }[];
			wakeTimeoutMs: number;
			deadlineMs: number;
		};
		const readers = sinks.map(
			(s) => new SinkReader(s.descriptor, s.sab, { wakeTimeoutMs }),
		);
		const latencies: number[] = [];
		const deadline = Date.now() + deadlineMs;
		let active = readers.length;
		while (active > 0 && Date.now() < deadline) {
			for (const reader of readers) {
				if (reader.state === "ended") continue;
				// Round-robin with a short per-reader park: one worker serves
				// all rings, so the park bounds cross-ring head-of-line time.
				const record = reader.next(wakeTimeoutMs);
				if (!record) continue;
				if (record.type === "message") {
					const p = record.payload;
					const sent = new DataView(
						p.buffer,
						p.byteOffset,
						p.byteLength,
					).getFloat64(8, true);
					latencies.push(performance.timeOrigin + performance.now() - sent);
				} else if (record.type !== "data" && record.type !== "drops") {
					active -= 1;
				}
			}
		}
		postMessage(latencies);
	};
	for (const event of queued.splice(0)) handler(event);
}

// ---------------------------------------------------------------------------
// Role: orchestrator + receiver.
// ---------------------------------------------------------------------------
if (Bun.isMainThread && process.argv[2] !== "sender") {
	const results: Record<string, unknown>[] = [];
	for (const mode of MODES) {
		const latencies: number[] = [];
		const sinkHandles: {
			sab: SharedArrayBuffer;
			descriptor: unknown;
			close: () => Promise<void>;
		}[] = [];
		const streamsReady = Promise.withResolvers<void>();
		let acceptedStreams = 0;

		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: "", keyPem: "" },
			onSession: async (session: any) => {
				const iterator =
					session.incomingBidirectionalStreams[Symbol.asyncIterator]();
				for (;;) {
					const next = await iterator.next().catch(() => ({ done: true }));
					if (next.done) return;
					acceptedStreams += 1;
					if (acceptedStreams === STREAMS) streamsReady.resolve();
					const stream = next.value;
					if (mode === "sink") {
						const handle = openReadSink(stream, {
							ringBytes: 4 * 1024 * 1024,
							framing: FRAMING,
							clock: "wall",
						});
						sinkHandles.push({
							sab: handle.buffer,
							descriptor: handle.descriptor,
							close: () => handle.close(),
						});
					} else {
						// Facade path: cut frames on the main loop, stamp on consume.
						void (async () => {
							const reader = stream.readable.getReader();
							let staging = Buffer.alloc(0);
							for (;;) {
								const { done, value } = await reader
									.read()
									.catch(() => ({ done: true, value: undefined }));
								if (done) return;
								staging = staging.length
									? Buffer.concat([staging, Buffer.from(value!)])
									: Buffer.from(value!);
								while (staging.length >= FRAME_HEADER_BYTES) {
									const total = staging.readUInt32LE(0);
									if (staging.length < total) break;
									const sent = staging.readDoubleLE(8);
									latencies.push(wallNowMs() - sent);
									staging = staging.subarray(total);
								}
							}
						})();
					}
				}
			},
		});
		await Bun.sleep(300);
		const port = server.address.port;

		// Receiver-loop saturator: busy-spin SATURATE_PCT of every 10ms slice.
		let saturator: ReturnType<typeof setInterval> | null = null;
		if (SATURATE_PCT > 0) {
			const sliceMs = 10;
			const busyMs = (SATURATE_PCT / 100) * sliceMs;
			saturator = setInterval(() => {
				const start = performance.now();
				while (performance.now() - start < busyMs) {
					// spin
				}
			}, sliceMs);
		}

		const sender = Bun.spawn(
			["bun", import.meta.path, "sender", `https://127.0.0.1:${port}/`],
			{
				env: {
					...process.env,
					WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
				},
				stdout: "inherit",
				stderr: "inherit",
			},
		);

		let workerLatencies: number[] = [];
		if (mode === "sink") {
			await streamsReady.promise;
			const worker = new Worker(import.meta.url);
			workerLatencies = await new Promise<number[]>((resolve) => {
				worker.onmessage = (e) => resolve(e.data as number[]);
				worker.postMessage({
					sinks: sinkHandles.map((h) => ({
						sab: h.sab,
						descriptor: h.descriptor,
					})),
					wakeTimeoutMs: WAKE_MS,
					deadlineMs: (DURATION_S + 10) * 1000,
				});
			});
			worker.terminate();
		}
		await sender.exited;
		await Bun.sleep(500);
		if (saturator) clearInterval(saturator);
		for (const handle of sinkHandles) await handle.close();
		await server.close();

		const all = (mode === "sink" ? workerLatencies : latencies)
			.filter((v) => Number.isFinite(v))
			.sort((a, b) => a - b);
		const summary = {
			mode,
			streams: STREAMS,
			rateHz: RATE_HZ,
			payloadBytes: PAYLOAD,
			durationS: DURATION_S,
			saturatePct: SATURATE_PCT,
			wakeTimeoutMs: WAKE_MS,
			samples: all.length,
			latencyMs: quantiles(all),
		};
		results.push(summary);
		console.log(JSON.stringify(summary));
	}
	const out = process.env.SINK_BENCH_JSON;
	if (out) await Bun.write(out, JSON.stringify(results, null, 2));
	process.exit(0);
}
