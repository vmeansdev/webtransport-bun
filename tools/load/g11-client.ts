#!/usr/bin/env bun
/**
 * G11's addon client driver — Arm J and Arm D only.
 *
 * Contract: `docs/research/preregistrations/gate-g11-bidi.md`; build spec
 * `docs/research/2026-08-19-g11-harness-spec.md` §2. It exists because of
 * Amendment 3 and Amendment 2, and for no other reason:
 *
 * - **Amendment 3.** Arm T's generator is `crates/reference`, which speaks QUIC
 *   directly and has no JS boundary, so "bytes per receive-side crossing on the
 *   client end" is not a small number there — it is *not a number*. Arm J puts
 *   the addon on both ends at the 50-tunnel rung so that quantity exists at all.
 * - **Amendment 2.** The read-ahead bridge whose reservations the coupling
 *   prediction is about (`spawn_bidi_bridge_on`) exists only on an
 *   **addon-opened** handle. A reference-client Arm D would have exercised
 *   neither of the two paths the amendment separates.
 *
 * This process runs one cell and exits. That is deliberate: both chunk-batch
 * knobs are read once at module init (`stream-chunk-batch.ts`), so a knob-on
 * cell and a knob-off cell cannot share a process, and a per-cell process also
 * makes the process-global diagnostics counter unambiguous.
 *
 * Nothing here decides anything. It drives, it counts, and it prints one JSON
 * line; every clause and falsifier lives in `g11-classify.ts`.
 */

import { connect } from "../../packages/webtransport/src/index.ts";
import {
	resetStreamBatchDiagnostics,
	streamBatchConfig,
	streamBatchDiagnosticsSnapshot,
} from "../../packages/webtransport/src/stream-chunk-batch.ts";
import {
	createWallClockWithSource,
	Deframer,
	encodeFrame,
	FrameClass,
} from "./g11-frame.ts";
import { G11Histogram, percentileMs } from "./g11-histogram.ts";
import { runPacedStream } from "./g11-pacer.ts";
import {
	backlogTargetBytes,
	bytesPerSecPerDirection,
	consumptionDelayMsForBacklog,
	FRAME_BYTES,
} from "./g11-plan.ts";

type Args = {
	url: string;
	arm: "J" | "D";
	sessions: number;
	durationSecs: number;
	connectStaggerMs: number;
	frameBytes: number;
	targetBytesPerSec: number;
	slowReader: "client" | "server" | "none";
	backlogFraction: number;
	runId: string;
	host: string;
};

function parseArgs(argv: string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const num = (flag: string, fallback: number): number => {
		const raw = get(flag);
		if (raw === undefined) return fallback;
		const v = Number(raw);
		if (!Number.isFinite(v))
			throw new Error(`g11-client: ${flag} is not a number: ${raw}`);
		return v;
	};
	const arm = get("--arm") ?? "J";
	if (arm !== "J" && arm !== "D")
		throw new Error(`g11-client: --arm must be J or D, got ${arm}`);
	const slow = get("--slow-reader") ?? "none";
	if (slow !== "client" && slow !== "server" && slow !== "none")
		throw new Error(`g11-client: --slow-reader must be client|server|none`);
	return {
		url: get("--url") ?? "https://127.0.0.1:4433",
		arm,
		sessions: num("--sessions", 4),
		durationSecs: num("--duration-secs", 60),
		connectStaggerMs: num("--connect-stagger-ms", 0),
		frameBytes: num("--frame-bytes", FRAME_BYTES),
		targetBytesPerSec: num("--target-bytes-per-sec", bytesPerSecPerDirection()),
		slowReader: slow,
		backlogFraction: num("--backlog-fraction", 0),
		runId: get("--run-id") ?? "unset",
		host: get("--host") ?? "unset",
	};
}

/** A Node Duplex, as much of it as this driver uses. */
type BidiDuplex = {
	write(chunk: Uint8Array, cb: (err?: Error | null) => void): boolean;
	end(cb?: () => void): void;
	[Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
};

/**
 * `BidiStream`'s default readable buffer (`streams.ts:77`). Recorded as a
 * constant so the artifact can state the figure the withhold arithmetic used.
 */
const READABLE_HIGH_WATER_MARK = 256 * 1024;

/** See the call site: teardown hygiene, outside every measured window. */
const SESSION_CLOSE_QUIESCE_MS = 500;

type SessionTotals = {
	index: number;
	bytesWritten: number;
	framesWritten: number;
	bytesRead: number;
	framesRead: number;
};

const totals: SessionTotals[] = [];
const downLatency = new G11Histogram();
const schedulerLag = new G11Histogram();
/** Every `write()` on a handle whose peer-facing reader may be slow (Arm D). */
const writeLatency = new G11Histogram();
let backpressureTimeouts = 0;
let streamErrors = 0;
let sessionsOk = 0;
let sessionsErr = 0;
let streamsClosedBothHalves = 0;
/**
 * The client end's session *governor* reading is still structurally
 * unobservable, and still reported as `null` rather than as a zero.
 *
 * Found by smoking Arm D, and then confirmed in the tree: a client session's
 * stream budget is built over a `SessionMetrics` created fresh at
 * `client.rs:1321` and shared only with `make_budget`, while `queuedBytes` on
 * the snapshot reads `ClientMetrics.queued_bytes` — a different counter,
 * charged by the datagram budget.
 *
 * Amendment 10 closes the half of that gap Arm D actually needs. The handle now
 * carries the same `SessionMetrics` its stream budgets are charged against, and
 * the snapshot exposes the `inbound*` counters off it, so the bytes the
 * read-ahead bridge holds against the shared per-handle budget do have a reader
 * on this end. What is still missing is only the outbound governor, which Arm D
 * never asked for.
 */
const peakSessionQueuedBytes: number | null = null;
/**
 * Amendment 10's counters for this end, folded across the driving sessions.
 *
 * The peaks are native high-water marks, so reading them once per session at
 * teardown carries the worst moment of the drive; the totals are cumulative and
 * summed. A generator that saw no counter at all reports `null` — the classifier
 * distinguishes "no instrument" from "no backlog", and a zero here would erase
 * that distinction.
 */
let peakInboundStreamBytes: number | null = null;
let peakInboundSessionBytes: number | null = null;
let inboundReservedTotalBytes: number | null = null;
let inboundReserveTimeouts: number | null = null;

type InboundSnapshot = {
	inboundStreamPeakBytes?: number;
	inboundReservedPeakBytes?: number;
	inboundReservedTotalBytes?: number;
	inboundReserveTimeouts?: number;
};

function foldInboundCounters(snapshot: InboundSnapshot | undefined): void {
	if (!snapshot || snapshot.inboundReservedTotalBytes === undefined) return;
	peakInboundStreamBytes = Math.max(
		peakInboundStreamBytes ?? 0,
		snapshot.inboundStreamPeakBytes ?? 0,
	);
	peakInboundSessionBytes = Math.max(
		peakInboundSessionBytes ?? 0,
		snapshot.inboundReservedPeakBytes ?? 0,
	);
	inboundReservedTotalBytes =
		(inboundReservedTotalBytes ?? 0) + snapshot.inboundReservedTotalBytes;
	inboundReserveTimeouts =
		(inboundReserveTimeouts ?? 0) + (snapshot.inboundReserveTimeouts ?? 0);
}

function errorCodeOf(err: unknown): string {
	if (err && typeof err === "object" && "code" in err)
		return String((err as { code: unknown }).code);
	return err instanceof Error ? err.message : String(err);
}

async function driveSession(args: Args, index: number, wallNs: () => bigint) {
	let session: Awaited<ReturnType<typeof connect>>;
	try {
		session = await connect(args.url, {
			tls: { insecureSkipVerify: true },
		});
	} catch (err) {
		sessionsErr += 1;
		console.error(`g11-client: session ${index} connect failed: ${err}`);
		return;
	}
	sessionsOk += 1;

	let duplex: BidiDuplex;
	try {
		duplex =
			(await session.createBidirectionalStream()) as unknown as BidiDuplex;
	} catch (err) {
		streamErrors += 1;
		console.error(`g11-client: session ${index} open_bi failed: ${err}`);
		await session.close?.();
		return;
	}

	const totalsForSession: SessionTotals = {
		index,
		bytesWritten: 0,
		framesWritten: 0,
		bytesRead: 0,
		framesRead: 0,
	};

	// The slow reader, when this cell places it here. The cycle is: withhold for
	// the registered delay, then drain exactly the frames that accumulated. The
	// average consumption rate therefore equals the arrival rate and the backlog
	// oscillates between zero and the target — a permanently-stalled reader
	// would measure the flow-control window, not the budget interaction.
	const targetBytes = backlogTargetBytes(args.backlogFraction);
	// Harness correction, found by smoking the arm rather than after a run: a
	// `BidiStream` is a Node Duplex with a 256 KiB `readableHighWaterMark`
	// (streams.ts:77), and that buffer sits *in front of* the native budget.
	// Bytes it absorbs have already been consumed as far as the bridge is
	// concerned, so their reservations are released — a reader withholding only
	// `consumptionDelayMsForBacklog(target)` fills the JS buffer and never
	// touches the budget the arm exists to load. The withhold therefore covers
	// the JS buffer *and then* the registered target. No registered quantity
	// moves: the backlog fractions are unchanged and still name a fraction of
	// the shipped `maxQueuedBytesPerStream`; what changes is that the driver now
	// actually reaches them.
	const withholdMs =
		args.slowReader === "client" && args.backlogFraction > 0
			? consumptionDelayMsForBacklog(targetBytes + READABLE_HIGH_WATER_MARK)
			: 0;
	const framesPerDrain = Math.max(
		1,
		Math.floor((targetBytes + READABLE_HIGH_WATER_MARK) / FRAME_BYTES),
	);

	let readerEofSeen = false;
	const reader = (async () => {
		const deframer = new Deframer();
		let sinceWithhold = 0;
		if (withholdMs > 0) await Bun.sleep(withholdMs);
		for await (const chunk of duplex) {
			const arrival = wallNs();
			totalsForSession.bytesRead += chunk.byteLength;
			let frames: ReturnType<Deframer["push"]>;
			try {
				frames = deframer.push(chunk);
			} catch (err) {
				streamErrors += 1;
				console.error(`g11-client: session ${index} deframe failed: ${err}`);
				break;
			}
			for (const frame of frames) {
				totalsForSession.framesRead += 1;
				downLatency.recordNs(arrival - frame.sendWallNs);
			}
			if (withholdMs > 0) {
				sinceWithhold += frames.length;
				if (sinceWithhold >= framesPerDrain) {
					sinceWithhold = 0;
					await Bun.sleep(withholdMs);
				}
			}
		}
		readerEofSeen = true;
	})().catch((err) => {
		streamErrors += 1;
		console.error(`g11-client: session ${index} reader failed: ${err}`);
	});

	let sequence = 0;
	const result = await runPacedStream({
		write: (chunk) =>
			new Promise<void>((resolve, reject) => {
				const startedAt = performance.now();
				duplex.write(chunk, (err) => {
					writeLatency.record(performance.now() - startedAt);
					if (err) {
						if (errorCodeOf(err).includes("BACKPRESSURE_TIMEOUT"))
							backpressureTimeouts += 1;
						reject(err);
					} else resolve();
				});
			}),
		writeBytes: args.frameBytes,
		bytesPerSec: args.targetBytesPerSec,
		durationMs: args.durationSecs * 1000,
		sliceQuantum: 1,
		now: () => performance.now(),
		sleep: (ms) => Bun.sleep(ms),
		// alloc, not allocUnsafe: the pacer allocates once per stream, so the
		// memset is per-stream, and the Rust generator fills its frame body with
		// b'x'. Shipping uninitialized pool bytes made the two ends
		// byte-incomparable for the sake of an allocation nobody repeats.
		allocChunk: (n) => Buffer.alloc(n),
		fill: (chunk) => {
			encodeFrame(chunk, {
				totalLength: args.frameBytes,
				frameClass: FrameClass.TunnelUp,
				session: index,
				sequence,
				sendWallNs: wallNs(),
			});
			sequence += 1;
		},
	});

	totalsForSession.bytesWritten = result.bytes;
	totalsForSession.framesWritten = result.settles;
	streamErrors += result.errors;
	if (result.firstError?.includes("BACKPRESSURE_TIMEOUT"))
		backpressureTimeouts += 1;
	schedulerLag.merge(result.lateness.snapshot());

	await new Promise<void>((resolve) => duplex.end(() => resolve()));
	// Give the read half a bounded grace to reach EOF rather than declaring the
	// stream half-closed because we stopped waiting.
	const graceUntil = Date.now() + 3000;
	while (!readerEofSeen && Date.now() < graceUntil) await Bun.sleep(50);
	await reader;
	if (readerEofSeen) streamsClosedBothHalves += 1;

	totals.push(totalsForSession);
	// Teardown quiesce, not a measurement window: the peer's own `close()` on
	// its write half is still in flight when this end observes EOF, and closing
	// the session under it makes that close fail with `E_STREAM_RESET` — which
	// C4 would count as a stream error the run did not actually suffer. Found by
	// smoking the arm; the delay sits entirely after the drive window and after
	// every counter this driver reports.
	// Read the counters before the session goes: they live on the native
	// session, and a closed handle has none.
	foldInboundCounters(
		(
			session as { metricsSnapshot?: () => InboundSnapshot }
		).metricsSnapshot?.(),
	);
	await Bun.sleep(SESSION_CLOSE_QUIESCE_MS);
	await session.close?.();
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const config = streamBatchConfig();
	if (!config.diagnosticsEnabled) {
		throw new Error(
			"g11-client: WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS is not 1, so " +
				"crossings.client would be all zeros — which V-K would read as 'an " +
				"addon ran and batched nothing'. Refusing to drive an uninstrumented cell.",
		);
	}
	const clock = createWallClockWithSource();
	const wallNs = clock.now;

	// The counter's window is the drive window, not the process lifetime.
	resetStreamBatchDiagnostics();

	const gap =
		args.sessions > 1 ? args.connectStaggerMs / (args.sessions - 1) : 0;
	const drivers: Promise<void>[] = [];
	for (let i = 0; i < args.sessions; i += 1) {
		if (gap > 0 && i > 0) await Bun.sleep(gap);
		drivers.push(driveSession(args, i, wallNs));
	}
	await Promise.all(drivers);

	totals.sort((a, b) => a.index - b.index);
	const sum = (pick: (t: SessionTotals) => number) =>
		totals.reduce((acc, t) => acc + pick(t), 0);
	const summary = {
		arm: args.arm,
		runId: args.runId,
		host: args.host,
		drivingSessions: args.sessions,
		frameBytes: args.frameBytes,
		targetBytesPerSec: args.targetBytesPerSec,
		durationSec: args.durationSecs,
		slowReader: args.slowReader,
		backlogFraction: args.backlogFraction,
		readableHighWaterMarkBytes: READABLE_HIGH_WATER_MARK,
		knobBytes: config.batchBytes,
		wallClockSource: clock.source,
		sessionsOk,
		sessionsErr,
		streamErrors,
		backpressureTimeouts,
		streamsClosedBothHalves,
		peakSessionQueuedBytes,
		peakInboundStreamBytes,
		peakInboundSessionBytes,
		inboundReservedTotalBytes,
		inboundReserveTimeouts,
		bytesWritten: sum((t) => t.bytesWritten),
		framesWritten: sum((t) => t.framesWritten),
		bytesRead: sum((t) => t.bytesRead),
		framesRead: sum((t) => t.framesRead),
		perSession: totals,
		latency: downLatency.snapshot(),
		schedulerLag: schedulerLag.snapshot(),
		writeLatency: writeLatency.snapshot(),
		writeLatencyP99Ms: percentileMs(writeLatency.snapshot(), 0.99),
		crossings: streamBatchDiagnosticsSnapshot(),
	};
	console.log(`g11-client-summary: ${JSON.stringify(summary)}`);
}

await main();
