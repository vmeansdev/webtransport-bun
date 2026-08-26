/**
 * Stream sink churn soak (RFC_STREAM_SINK §9.5): open/close sinks across
 * sessions in a loop, watching RSS and the process-wide sink gauge for the
 * napi-reference leak class the repo has been bitten by before. Local runs
 * are smoke-length; the gate is SOAK_SINK_DURATION=86400 on the Linux
 * dedicated runner (local macOS soak results are not a valid gate — standing
 * repo rule).
 *
 * Usage: bun tools/load/soak-sink.ts
 * Env: SOAK_SINK_DURATION (seconds, default 120), SOAK_SINK_STREAMS (8),
 *      SOAK_SINK_BYTES per stream (65536), SOAK_SINK_JSON (summary path).
 */

import {
	connect,
	createServer,
	openReadSink,
	WT_RESET,
} from "../../packages/webtransport/src/index.js";

const env = (name: string, fallback: number): number => {
	const raw = process.env[name];
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
};

const DURATION_S = env("SOAK_SINK_DURATION", 120);
const STREAMS = env("SOAK_SINK_STREAMS", 8);
const BYTES = env("SOAK_SINK_BYTES", 65536);

// ---------------------------------------------------------------------------
// Worker role: drain rings to their terminal and report record counts.
// ---------------------------------------------------------------------------
if (!Bun.isMainThread) {
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
		const { sinks, deadlineMs } = event.data as {
			sinks: { sab: SharedArrayBuffer; descriptor: never }[];
			deadlineMs: number;
		};
		const readers = sinks.map(
			(s) => new SinkReader(s.descriptor, s.sab, { wakeTimeoutMs: 1 }),
		);
		let bytes = 0;
		let terminals = 0;
		const deadline = Date.now() + deadlineMs;
		let active = readers.length;
		while (active > 0 && Date.now() < deadline) {
			for (const reader of readers) {
				if (reader.state === "ended") continue;
				const record = reader.next(1);
				if (!record) continue;
				if (record.type === "data" || record.type === "message") {
					bytes += record.payload.length;
				} else if (record.type !== "drops") {
					terminals += 1;
					active -= 1;
				}
			}
		}
		postMessage({ bytes, terminals });
	};
	for (const event of queued.splice(0)) handler(event);
}

// ---------------------------------------------------------------------------
// Main role: churn loop.
// ---------------------------------------------------------------------------
if (Bun.isMainThread) {
	type SinkCarrier = {
		sab: SharedArrayBuffer;
		descriptor: unknown;
		close: () => Promise<void>;
		releaseWire: () => void;
	};
	let pendingSinks: SinkCarrier[] = [];
	let streamsArmed = Promise.withResolvers<void>();
	let armed = 0;

	const server = createServer({
		port: 0,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		// Churn far above the product default stream-open rate: the limiter
		// is not what this soak measures.
		rateLimits: { streamsPerSec: 100_000, streamsBurst: 100_000 },
		onSession: async (session: any) => {
			const iterator =
				session.incomingBidirectionalStreams[Symbol.asyncIterator]();
			for (;;) {
				const next = await iterator.next().catch(() => ({ done: true }));
				if (next.done) return;
				const pair = next.value;
				const handle = openReadSink(pair, { ringBytes: 256 * 1024 });
				pendingSinks.push({
					sab: handle.buffer,
					descriptor: handle.descriptor,
					close: () => handle.close(),
					// The server never writes, so its send half must be reset
					// or the QUIC stream never fully closes and MAX_STREAMS
					// credit never replenishes for the client.
					releaseWire: () => pair[WT_RESET]?.(0),
				});
				armed += 1;
				if (armed >= STREAMS) streamsArmed.resolve();
			}
		},
	});
	await Bun.sleep(300);
	const url = `https://127.0.0.1:${server.address.port}/`;

	const rssMb = () => process.memoryUsage.rss() / (1024 * 1024);
	const samples: { t: number; rssMb: number; iterations: number }[] = [];
	const startedAt = Date.now();
	const endAt = startedAt + DURATION_S * 1000;
	let iterations = 0;
	let drainedBytes = 0;
	let failures = 0;
	let lastHeap = { sharedArrayBuffers: 0, heapMb: 0 };

	// One session for the whole soak: the churn under test is the sink
	// lifecycle (SAB rings, napi references, tasks), and per-iteration
	// session churn would trip the session-open rate limit long before the
	// sink path is exercised (session churn has its own soaks).
	// ONE worker for the whole soak: Bun leaks ~212 KB of runtime residue per
	// spawned-and-terminated Worker (measured on the Linux runner: worker-per-
	// iteration grew 102->986 MB over 4180 iterations while this shape held
	// 92->130 MB over 9773), which is a Worker-churn property of the runtime,
	// not sink retention -- the sink gauges and SAB heap counts stay at zero
	// either way.
	const sharedWorker = new Worker(import.meta.url);
	const client = await connect(url, { tls: { insecureSkipVerify: true } });
	while (Date.now() < endAt) {
		pendingSinks = [];
		streamsArmed = Promise.withResolvers<void>();
		armed = 0;
		const streams = await Promise.all(
			Array.from({ length: STREAMS }, () => client.createBidirectionalStream()),
		);
		const payload = Buffer.alloc(BYTES, 11);
		for (const stream of streams) {
			stream.write(payload);
			stream.end();
		}
		await streamsArmed.promise;
		const report = await new Promise<{ bytes: number; terminals: number }>(
			(resolve) => {
				sharedWorker.onmessage = (e) => resolve(e.data);
				sharedWorker.postMessage({
					sinks: pendingSinks.map((s) => ({
						sab: s.sab,
						descriptor: s.descriptor,
					})),
					deadlineMs: 15_000,
				});
			},
		);
		if (report.terminals !== STREAMS || report.bytes !== STREAMS * BYTES) {
			failures += 1;
			console.error(
				`soak-sink: iteration ${iterations} short: ${report.terminals}/${STREAMS} terminals, ${report.bytes}/${STREAMS * BYTES} bytes`,
			);
		}
		drainedBytes += report.bytes;
		for (const sink of pendingSinks) await sink.close();
		for (const sink of pendingSinks) sink.releaseWire();
		// The server never writes back, so the client Duplexes would otherwise
		// stay half-open and exhaust per-session stream capacity.
		for (const stream of streams) stream.destroy();
		iterations += 1;
		await Bun.sleep(10);
		if (iterations % 50 === 0) {
			// Retention truth on macOS is the heap, not RSS: freed SAB pages
			// stay resident-counted (MADV_FREE), so a growing RSS with a flat
			// SharedArrayBuffer count is accounting, not a leak.
			Bun.gc(true);
			const { heapStats } = await import("bun:jsc");
			const counts = heapStats().objectTypeCounts as Record<string, number>;
			lastHeap = {
				sharedArrayBuffers: counts.SharedArrayBuffer ?? 0,
				heapMb: Math.round(heapStats().heapSize / 1048576),
			};
			if (lastHeap.sharedArrayBuffers > STREAMS * 2) {
				failures += 1;
				console.error(
					`soak-sink: ${lastHeap.sharedArrayBuffers} SharedArrayBuffers retained at iteration ${iterations}`,
				);
			}
		}
		if (iterations % 10 === 0) {
			const gauge = server.metricsSnapshot() as { sinksActive?: number };
			if ((gauge.sinksActive ?? 0) !== 0) {
				failures += 1;
				console.error(
					`soak-sink: sinksActive=${gauge.sinksActive} after close at iteration ${iterations}`,
				);
			}
			samples.push({
				t: Math.round((Date.now() - startedAt) / 1000),
				rssMb: Math.round(rssMb() * 10) / 10,
				iterations,
			});
			console.log(JSON.stringify(samples.at(-1)));
		}
	}

	sharedWorker.terminate();
	const finalGauge = server.metricsSnapshot() as { sinksActive?: number };
	client.close();
	await server.close();
	const summary = {
		durationS: DURATION_S,
		iterations,
		drainedMb: Math.round(drainedBytes / (1024 * 1024)),
		failures,
		sinksActiveAtEnd: finalGauge.sinksActive ?? 0,
		lastHeap,
		rssFirstMb: samples[0]?.rssMb ?? Math.round(rssMb() * 10) / 10,
		rssLastMb: Math.round(rssMb() * 10) / 10,
		samples,
	};
	console.log(JSON.stringify(summary));
	const out = process.env.SOAK_SINK_JSON;
	if (out) await Bun.write(out, JSON.stringify(summary, null, 2));
	const pass = failures === 0 && summary.sinksActiveAtEnd === 0;
	console.log(pass ? "soak-sink: PASS" : "soak-sink: FAIL");
	process.exit(pass ? 0 : 1);
}
