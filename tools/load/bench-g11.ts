#!/usr/bin/env bun

/**
 * Gate G11's conductor: the server, and the driver of every cell.
 *
 * Contract: `docs/research/preregistrations/gate-g11-bidi.md`, committed before
 * any harness code existed; build spec `docs/research/2026-08-19-g11-harness-spec.md`.
 * Every threshold lives in `g11-plan.ts`, every clause and falsifier in
 * `g11-classify.ts`. **This file drives and records; it computes no verdict.**
 * It calls `rollUpTunnelGate`, `rollUpExchangeArm` and `readCouplingArm` and
 * prints what they say.
 *
 * Four arms, from §2 of the registration:
 *
 *   T  the tunnel arm — N sessions, one bidi stream each, 3 Mbps paced in *both*
 *      directions simultaneously, reference generator. `T-100` is the gate cell.
 *   X  the acceptance arm — the collab/RPC shape, one bidi stream per exchange.
 *   J  the addon on both ends at the 50 rung (Amendment 3). Verdict-free.
 *   D  the cross-direction budget probe (Amendment 2). Grades nothing.
 *
 * **One process, one knob state.** `WEBTRANSPORT_STREAM_BATCH_BYTES` is read
 * once at module init inside the package, so a knob-off cell and a knob-on cell
 * cannot share a process. The conductor refuses to run a cell whose registered
 * knob state differs from its own — a cell whose knob state is not what its
 * label says is exactly what V-K exists to reject, and refusing before the run
 * is better than invalidating after it.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { cpus, hostname } from "node:os";
import { join } from "node:path";
import {
	createServer,
	DEFAULT_LIMITS,
} from "../../packages/webtransport/src/index.ts";
import {
	resetStreamBatchDiagnostics,
	streamBatchConfig,
	streamBatchDiagnosticsSnapshot,
} from "../../packages/webtransport/src/stream-chunk-batch.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	cellDeadlineMs,
	DEADLINE_REAP_GRACE_MS,
	valueOrAfter,
	waitForChildWithDeadline,
} from "./bench-child-deadline.ts";
import {
	closeBounded,
	finishRun,
	writeArtifactDurable,
} from "./bench-shutdown.ts";
import {
	type CouplingCellFacts,
	type CrossingFacts,
	type ExchangeCellFacts,
	type FloorReport,
	readCouplingArm,
	rollUpExchangeArm,
	rollUpTunnelGate,
	type StreamEnd,
	type TunnelCellFacts,
} from "./g11-classify.ts";
import {
	createWallClockWithSource,
	Deframer,
	encodeFrame,
	FrameClass,
} from "./g11-frame.ts";
import {
	emptySnapshot,
	G11Histogram,
	type LatencySnapshot,
	percentileMs,
} from "./g11-histogram.ts";
import { runPacedStream } from "./g11-pacer.ts";
import {
	backlogTargetBytes,
	bytesPerSecPerDirection,
	consumptionDelayMsForBacklog,
	EXCHANGE_REQUEST_BYTES,
	EXCHANGE_RESPONSE_BYTES,
	EXCHANGES_PER_SESSION_PER_SEC,
	emitterOffsetMs,
	FRAME_BYTES,
	SHIPPED_MAX_STREAMS_PER_SESSION_BIDI,
} from "./g11-plan.ts";
import {
	type CpuSnapshot,
	HAS_PROC,
	hostCpuPct,
	pidCpuPct,
	readHostCpu,
	readPidCpuTicks,
	readUdpStats,
	socketStatsForPort,
	udpDelta,
} from "./g11-procfs.ts";

const ROOT = process.cwd();
const TUNNEL_BIN =
	process.env.G11_TUNNEL_BIN ?? `${ROOT}/target/release/tunnel-client`;
const CLIENT_DRIVER = `${ROOT}/tools/load/g11-client.ts`;
const OUT_JSON = process.env.G11_OUT ?? join(ROOT, "tools/load/bench-g11.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");
const SAMPLE_INTERVAL_MS = Number(process.env.G11_SAMPLE_INTERVAL_MS ?? 2000);
const RUN_ID = process.env.G11_RUN_ID ?? `g11-${Date.now()}`;
const HOST = process.env.G11_HOST ?? hostname();

// Populations and windows are inputs. Thresholds never are (G6's rule).
const STEP_SECONDS = Number(process.env.G11_STEP_SECONDS ?? 60);
const EXCHANGE_STEP_SECONDS = Number(
	process.env.G11_EXCHANGE_STEP_SECONDS ?? 30,
);
const COUPLING_STEP_SECONDS = Number(
	process.env.G11_COUPLING_STEP_SECONDS ?? 30,
);
const GATE_REPEATS = Number(process.env.G11_REPEATS ?? 2);
const BASE_PORT = Number(process.env.G11_BASE_PORT ?? 4520);
/** Total connect ramp. Sessions spread evenly across it — K2, T02's mechanism. */
const CONNECT_STAGGER_MS = Number(process.env.G11_STAGGER_MS ?? 2000);

const SETTLE_POLL_MS = 250;
const SETTLE_QUIET_POLLS = 4;
const SETTLE_MAX_MS = 30_000;
const DRAIN_GRACE_MS = 3000;

/**
 * The wiring-check mode. K16 is a permanent gotcha — a local macOS bench number
 * is never a result — and a smoke run also has to shrink populations far below
 * the registered ladder, which would make its cells unreadable as the cells
 * their labels name. So the mode is explicit, it is stamped into the artifact,
 * and **it suppresses the roll-up entirely**: a smoke artifact cannot carry a
 * gate verdict at all, rather than carrying one that has to be remembered to be
 * ignored.
 */
const SMOKE = process.env.G11_SMOKE === "1";
const SMOKE_SESSIONS = Number(process.env.G11_SMOKE_SESSIONS ?? 2);
const SMOKE_SECONDS = Number(process.env.G11_SMOKE_SECONDS ?? 4);

const KNOB = streamBatchConfig();
const CPU_CORES = cpus().length;

/** Which clock the last cell stamped with; recorded in the artifact. */
let wallClockSource = "unset";

/**
 * Cells whose server did not close cleanly. Not a falsifier: a cell's numbers
 * are all taken before its teardown, so a stuck close cannot move one. It is
 * recorded because a non-zero count is the retained-N-API-reference signature,
 * and the reason this run needed an explicit exit rather than getting one.
 */
let serverCloseFailures = 0;

let portCursor = BASE_PORT;
const nextPort = () => portCursor++;

// ---------------------------------------------------------------------------
// The cell table — §2 of the registration, verbatim
// ---------------------------------------------------------------------------

type CellSpec = {
	name: string;
	arm: "T" | "X" | "J" | "D";
	sessions: number;
	/** The knob state this cell is registered at. */
	knobBytes: number;
	stepSeconds: number;
	repeats: number;
	/** Arm D only. */
	end?: StreamEnd;
	backlogFraction?: number;
	/** Registered as exploratory: it produces no gate verdict either way (§6). */
	exploratory?: boolean;
};

const KNOB_ON = 65536;

const CELLS: CellSpec[] = [
	{
		name: "T-25",
		arm: "T",
		sessions: 25,
		knobBytes: 0,
		stepSeconds: STEP_SECONDS,
		repeats: 1,
	},
	{
		name: "T-50",
		arm: "T",
		sessions: 50,
		knobBytes: 0,
		stepSeconds: STEP_SECONDS,
		repeats: 1,
	},
	{
		name: "T-100",
		arm: "T",
		sessions: 100,
		knobBytes: 0,
		stepSeconds: STEP_SECONDS,
		repeats: GATE_REPEATS,
	},
	{
		name: "T-100-batch",
		arm: "T",
		sessions: 100,
		knobBytes: KNOB_ON,
		stepSeconds: STEP_SECONDS,
		repeats: 1,
	},
	{
		name: "T-200",
		arm: "T",
		sessions: 200,
		knobBytes: 0,
		stepSeconds: STEP_SECONDS,
		repeats: 1,
		exploratory: true,
	},
	{
		name: "J-control",
		arm: "J",
		sessions: 50,
		knobBytes: 0,
		stepSeconds: STEP_SECONDS,
		repeats: 1,
	},
	{
		name: "J-batch",
		arm: "J",
		sessions: 50,
		knobBytes: KNOB_ON,
		stepSeconds: STEP_SECONDS,
		repeats: 1,
	},
	{
		name: "X-250",
		arm: "X",
		sessions: 250,
		knobBytes: 0,
		stepSeconds: EXCHANGE_STEP_SECONDS,
		repeats: 1,
	},
	{
		name: "X-500",
		arm: "X",
		sessions: 500,
		knobBytes: 0,
		stepSeconds: EXCHANGE_STEP_SECONDS,
		repeats: 1,
	},
	{
		name: "X-1000",
		arm: "X",
		sessions: 1000,
		knobBytes: 0,
		stepSeconds: EXCHANGE_STEP_SECONDS,
		repeats: 1,
	},
];

for (const fraction of [0, 0.25, 0.75, 0.95]) {
	const label = String(Math.round(fraction * 100)).padStart(2, "0");
	for (const end of ["client-opened", "server-accepted"] as StreamEnd[]) {
		CELLS.push({
			name: `D-${label}-${end === "client-opened" ? "client" : "server"}`,
			arm: "D",
			sessions: 4,
			knobBytes: 0,
			stepSeconds: COUPLING_STEP_SECONDS,
			repeats: 1,
			end,
			backlogFraction: fraction,
		});
	}
}

if (SMOKE) {
	for (const cell of CELLS) {
		cell.sessions = Math.min(cell.sessions, SMOKE_SESSIONS);
		cell.stepSeconds = Math.min(cell.stepSeconds, SMOKE_SECONDS);
		cell.repeats = 1;
	}
}

/** The gate cell. Every clause in §5 is about this one, at both repeats. */
const GATE_CELL = "T-100";

function cellByName(name: string): CellSpec {
	const cell = CELLS.find((c) => c.name === name);
	if (!cell) throw new Error(`g11: unknown cell '${name}'`);
	return cell;
}

// ---------------------------------------------------------------------------
// Server-side record
// ---------------------------------------------------------------------------

type ServerRecord = {
	sessions: number;
	streamsAccepted: number;
	/** V-C's harness-side count: read resolutions that carried bytes. */
	readCrossings: number;
	upBytes: number;
	upFrames: number;
	perSessionUpBytes: Map<number, number>;
	downBytes: number;
	downFrames: number;
	streamErrors: number;
	streamResets: number;
	backpressureTimeouts: number;
	streamsFinBothHalves: number;
	upLatency: G11Histogram;
	writeLatency: G11Histogram;
	peakSessionQueuedBytes: number;
	/** Arm X. */
	acceptedExchangeStreams: number;
	/**
	 * Arm X's own completion count. Separate from `streamsFinBothHalves` because
	 * that one is C4's, and C4 means "this end saw the peer's FIN" — which the
	 * exchange responder never observes. Folding the two would put a number in
	 * C4's detail string that C4 does not describe.
	 */
	completedExchangeStreams: number;
	peakConcurrentBidiPerSession: number;
};

function newRecord(): ServerRecord {
	return {
		sessions: 0,
		streamsAccepted: 0,
		readCrossings: 0,
		upBytes: 0,
		upFrames: 0,
		perSessionUpBytes: new Map(),
		downBytes: 0,
		downFrames: 0,
		streamErrors: 0,
		streamResets: 0,
		backpressureTimeouts: 0,
		streamsFinBothHalves: 0,
		upLatency: new G11Histogram(),
		writeLatency: new G11Histogram(),
		peakSessionQueuedBytes: 0,
		acceptedExchangeStreams: 0,
		completedExchangeStreams: 0,
		peakConcurrentBidiPerSession: 0,
	};
}

function recordTotal(r: ServerRecord): number {
	return (
		r.upFrames +
		r.downFrames +
		r.streamsFinBothHalves +
		r.completedExchangeStreams +
		r.streamErrors
	);
}

/**
 * The settle barrier (§4 V-D). A step that hits `SETTLE_MAX_MS` is
 * `drain-unsettled`, which is INVALID — not a number with a caveat.
 */
async function settleRecord(
	r: ServerRecord,
): Promise<{ settleSec: number; timedOut: boolean }> {
	const startedAt = Date.now();
	let last = recordTotal(r);
	let quiet = 0;
	while (Date.now() - startedAt < SETTLE_MAX_MS) {
		await Bun.sleep(SETTLE_POLL_MS);
		const now = recordTotal(r);
		quiet = now === last ? quiet + 1 : 0;
		last = now;
		if (quiet >= SETTLE_QUIET_POLLS)
			return { settleSec: (Date.now() - startedAt) / 1000, timedOut: false };
	}
	return { settleSec: (Date.now() - startedAt) / 1000, timedOut: true };
}

// ---------------------------------------------------------------------------
// Structural views of the product's server surface
// ---------------------------------------------------------------------------

type AcceptedBidi = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
};

type ServerSession = {
	incomingBidirectionalStreams: ReadableStream<AcceptedBidi>;
	metricsSnapshot?: () => { queuedBytes?: number };
};

function errorCodeOf(err: unknown): string {
	if (err && typeof err === "object" && "code" in err)
		return String((err as { code: unknown }).code);
	return err instanceof Error ? err.message : String(err);
}

/**
 * Count a server-side stream failure, and say what it was.
 *
 * C4 gates on these being zero, so a silent increment would leave a MISS with
 * no attribution — the counter would say a stream failed and nothing would say
 * which failure it was. Every increment prints once, and the label travels with
 * it.
 */
function noteWriteError(
	record: ServerRecord,
	err: unknown,
	where: string,
): void {
	const code = errorCodeOf(err);
	record.streamErrors += 1;
	if (code.includes("BACKPRESSURE_TIMEOUT")) record.backpressureTimeouts += 1;
	if (code.includes("RESET")) record.streamResets += 1;
	console.error(`g11: server stream error at ${where}: ${code}`);
}

// ---------------------------------------------------------------------------
// Arm T / J / D — the tunnel server
// ---------------------------------------------------------------------------

/**
 * One accepted bidi stream: an independently paced downstream emitter and a
 * reader draining the upstream, running at the same time on the same stream.
 * They are deliberately **not** an echo — an echo would couple the directions
 * and destroy the simultaneity that is the whole point of this gate.
 */
function driveTunnelStream(
	stream: AcceptedBidi,
	index: number,
	cell: CellSpec,
	record: ServerRecord,
	wallNs: () => bigint,
): void {
	const slowHere = cell.arm === "D" && cell.end === "server-accepted";
	const targetBytes = backlogTargetBytes(cell.backlogFraction ?? 0);
	const withholdMs =
		slowHere && (cell.backlogFraction ?? 0) > 0
			? consumptionDelayMsForBacklog(targetBytes)
			: 0;
	const framesPerDrain = Math.max(1, Math.floor(targetBytes / FRAME_BYTES));

	let sawEof = false;
	const reader = (async () => {
		const r = stream.readable.getReader();
		const deframer = new Deframer();
		let sinceWithhold = 0;
		if (withholdMs > 0) await Bun.sleep(withholdMs);
		for (;;) {
			const { done, value } = await r.read();
			if (done) {
				sawEof = true;
				break;
			}
			if (!value) continue;
			const arrival = wallNs();
			record.readCrossings += 1;
			record.upBytes += value.byteLength;
			const frames = deframer.push(value);
			for (const frame of frames) {
				record.upFrames += 1;
				record.upLatency.recordNs(arrival - frame.sendWallNs);
				record.perSessionUpBytes.set(
					frame.session,
					(record.perSessionUpBytes.get(frame.session) ?? 0) +
						frame.totalLength,
				);
			}
			if (withholdMs > 0) {
				// Frames, not read() resolutions. One read after a withhold routinely
				// carries dozens of frames, so counting crossings drains a batch many
				// times the intended size and the backlog never sustains at the
				// registered fraction — the client-opened end (g11-client.ts) has
				// always counted frames, and the two ends have to mean the same thing.
				sinceWithhold += frames.length;
				if (sinceWithhold >= framesPerDrain) {
					sinceWithhold = 0;
					await Bun.sleep(withholdMs);
				}
			}
		}
	})().catch((err) => {
		record.streamErrors += 1;
		console.error(`g11: tunnel reader failed: ${err}`);
	});

	const writer = (async () => {
		const w = stream.writable.getWriter();
		// G6's lesson on this gate's egress side: N sessions on one shared tick
		// would be an N-frame impulse every 3.739 ms, which is T02's mechanism
		// pointed the other way. Each session's virtual clock is offset instead.
		// `index % sessions` rather than `index`: a session count above the cell's
		// own is a harness fault, and a thrown offset would silence this stream's
		// whole downstream instead of letting the ledger show the fault.
		await Bun.sleep(emitterOffsetMs(index % cell.sessions, cell.sessions));
		let sequence = 0;
		const result = await runPacedStream({
			write: async (chunk) => {
				const startedAt = performance.now();
				await w.write(chunk);
				record.writeLatency.record(performance.now() - startedAt);
			},
			writeBytes: FRAME_BYTES,
			bytesPerSec: bytesPerSecPerDirection(),
			durationMs: cell.stepSeconds * 1000,
			sliceQuantum: 1,
			now: () => performance.now(),
			sleep: (ms) => Bun.sleep(ms),
			// One memset per stream (the pacer allocates once), and it keeps this
			// end byte-comparable with the Rust generator's `vec![b'x'; n]`
			// instead of shipping whatever the pool last held.
			allocChunk: (n) => Buffer.alloc(n),
			fill: (chunk) => {
				encodeFrame(chunk, {
					totalLength: FRAME_BYTES,
					frameClass: FrameClass.TunnelDown,
					session: index,
					sequence,
					sendWallNs: wallNs(),
				});
				sequence += 1;
			},
		});
		record.downFrames += result.settles;
		record.downBytes += result.bytes;
		if (result.errors > 0) {
			noteWriteError(
				record,
				{ code: result.firstError ?? "E_UNKNOWN" },
				"paced write",
			);
		}
		try {
			await w.close();
		} catch (err) {
			noteWriteError(record, err, "writable close");
			return;
		}
		const graceUntil = Date.now() + DRAIN_GRACE_MS;
		while (!sawEof && Date.now() < graceUntil) await Bun.sleep(50);
		await reader;
		// C4 is counted at the server: it saw the inbound FIN and closed its own
		// outbound half cleanly. The client's own view travels in the artifact
		// beside it rather than being merged into one number.
		if (sawEof) record.streamsFinBothHalves += 1;
	})().catch((err) => {
		noteWriteError(record, err, "downstream emitter");
	});
	void writer;
}

// ---------------------------------------------------------------------------
// Arm X — the acceptance server
// ---------------------------------------------------------------------------

function driveExchangeStream(
	stream: AcceptedBidi,
	record: ServerRecord,
	wallNs: () => bigint,
	live: { count: number },
): void {
	record.acceptedExchangeStreams += 1;
	live.count += 1;
	if (live.count > record.peakConcurrentBidiPerSession)
		record.peakConcurrentBidiPerSession = live.count;

	void (async () => {
		const r = stream.readable.getReader();
		const deframer = new Deframer();
		let request: number | null = null;
		for (;;) {
			const { done, value } = await r.read();
			if (done) break;
			if (!value) continue;
			record.readCrossings += 1;
			record.upBytes += value.byteLength;
			const frames = deframer.push(value);
			for (const frame of frames) {
				record.upFrames += 1;
				record.upLatency.recordNs(wallNs() - frame.sendWallNs);
				if (request === null) request = frame.sequence;
			}
		}
		// Read to EOF rather than breaking on the first frame. Breaking left the
		// reader locked on an undrained stream for the rest of the cell — at
		// X-1000 that is 60,000 held native handles, the tail this file's closing
		// comment describes. Cancelling instead is NOT the fix: it puts
		// STOP_SENDING on a request half the generator has already finished, and
		// the generator then abandons the exchange — measured on a wiring smoke as
		// 1 of 12 completed against 12 of 12, with E_STOP_SENDING and
		// E_STREAM_RESET on this very path. The generator writes one request frame
		// and finishes immediately, so the FIN rides with the request and this
		// loop exits on the read after it.
		const w = stream.writable.getWriter();
		const chunk = Buffer.alloc(EXCHANGE_RESPONSE_BYTES);
		encodeFrame(chunk, {
			totalLength: EXCHANGE_RESPONSE_BYTES,
			frameClass: FrameClass.Response,
			session: 0,
			sequence: request ?? 0,
			sendWallNs: wallNs(),
		});
		await w.write(chunk);
		record.downFrames += 1;
		record.downBytes += EXCHANGE_RESPONSE_BYTES;
		await w.close();
		record.completedExchangeStreams += 1;
	})()
		.catch((err) => {
			noteWriteError(record, err, "exchange response");
		})
		.finally(() => {
			live.count -= 1;
		});
}

// ---------------------------------------------------------------------------
// One cell repeat
// ---------------------------------------------------------------------------

type ClientSummary = {
	runId: string;
	host: string;
	drivingSessions: number;
	sessionsOk?: number;
	sessionsErr?: number;
	streamsErr?: number;
	streamErrors?: number;
	streamsClosedBothHalves: number;
	framesWritten?: number;
	bytesWritten: number;
	framesRead?: number;
	bytesRead: number;
	exchangesAttempted?: number;
	exchangesCompleted?: number;
	streamsOpened?: number;
	peakConcurrentBidiPerSession?: number;
	perSession: {
		index: number;
		bytesWritten: number;
		framesWritten: number;
		bytesRead: number;
		framesRead: number;
	}[];
	latency: LatencySnapshot;
	schedulerLag: LatencySnapshot;
	/** Rust generator only: write call → write settled. Disclosure, not a bar. */
	writeSettle?: LatencySnapshot;
	writeLatency?: LatencySnapshot;
	writeLatencyP99Ms?: number;
	backpressureTimeouts?: number;
	peakSessionQueuedBytes?: number | null;
	crossings?: CrossingFacts & { meanBytesPerCrossing: number };
};

type StepEnvelope = {
	cell: CellSpec;
	repeat: number;
	record: ServerRecord;
	client: ClientSummary | null;
	childDriveSec: number;
	settleTimedOut: boolean;
	/** The child outlived its pre-registered deadline and was killed. INVALID. */
	deadlineBreached: boolean;
	deadlineMs: number;
	/** `null` only when a killed child never reaped. */
	exitCode: number | null;
	hostCpuMedianPct: number | null;
	clientCpuPct: number | null;
	serverCpuPct: number | null;
	serverRssMb: number;
	serverSocketDrops: number | null;
	udp: ReturnType<typeof udpDelta>;
	rateLimitedDelta: number;
	limitExceededDelta: number;
	serverCrossings: CrossingFacts;
};

function median(values: number[]): number | null {
	const usable = values.filter((v) => Number.isFinite(v));
	if (usable.length === 0) return null;
	const sorted = [...usable].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function parseSummary(stdout: string, prefix: string): ClientSummary | null {
	const line = stdout.split("\n").find((l) => l.startsWith(prefix));
	if (!line) return null;
	try {
		return JSON.parse(line.slice(prefix.length)) as ClientSummary;
	} catch (err) {
		console.error(`g11: could not parse the generator summary: ${err}`);
		return null;
	}
}

function childCommand(
	cell: CellSpec,
	port: number,
): { cmd: string[]; prefix: string } {
	const url = `https://127.0.0.1:${port}`;
	if (cell.arm === "T") {
		return {
			prefix: "tunnel-client-summary: ",
			cmd: [
				TUNNEL_BIN,
				"--url",
				url,
				"--arm",
				"tunnel",
				"--sessions",
				String(cell.sessions),
				"--duration-secs",
				String(cell.stepSeconds),
				"--connect-stagger-ms",
				String(CONNECT_STAGGER_MS),
				"--frame-bytes",
				String(FRAME_BYTES),
				"--target-bytes-per-sec",
				String(bytesPerSecPerDirection()),
				"--run-id",
				RUN_ID,
				"--host",
				HOST,
			],
		};
	}
	if (cell.arm === "X") {
		return {
			prefix: "tunnel-client-summary: ",
			cmd: [
				TUNNEL_BIN,
				"--url",
				url,
				"--arm",
				"exchange",
				"--sessions",
				String(cell.sessions),
				"--duration-secs",
				String(cell.stepSeconds),
				"--connect-stagger-ms",
				String(CONNECT_STAGGER_MS),
				"--frame-bytes",
				String(EXCHANGE_REQUEST_BYTES),
				"--exchanges-per-sec",
				String(EXCHANGES_PER_SESSION_PER_SEC),
				"--run-id",
				RUN_ID,
				"--host",
				HOST,
			],
		};
	}
	return {
		prefix: "g11-client-summary: ",
		cmd: [
			"bun",
			CLIENT_DRIVER,
			"--url",
			url,
			"--arm",
			cell.arm === "J" ? "J" : "D",
			"--sessions",
			String(cell.sessions),
			"--duration-secs",
			String(cell.stepSeconds),
			"--connect-stagger-ms",
			String(CONNECT_STAGGER_MS),
			"--frame-bytes",
			String(FRAME_BYTES),
			"--target-bytes-per-sec",
			String(bytesPerSecPerDirection()),
			"--slow-reader",
			cell.arm === "D" && cell.end === "client-opened"
				? "client"
				: cell.arm === "D"
					? "server"
					: "none",
			"--backlog-fraction",
			String(cell.backlogFraction ?? 0),
			"--run-id",
			RUN_ID,
			"--host",
			HOST,
		],
	};
}

async function runStep(
	cell: CellSpec,
	repeat: number,
	tls: { certPem: string; keyPem: string },
): Promise<StepEnvelope> {
	const record = newRecord();
	const port = nextPort();
	const clock = createWallClockWithSource();
	const wallNs = clock.now;
	wallClockSource = clock.source;
	const liveSessions = new Set<ServerSession>();
	let sessionIndex = 0;

	// §3, verbatim. maxStreamsPerSessionBidi stays at the shipped 200 because
	// V-X2 is about that exact number; the governors stay shipped because the
	// gate is about the shipped governors.
	const server = createServer({
		port,
		tls,
		limits: {
			maxSessions: cell.sessions + 100,
			maxHandshakesInFlight: cell.sessions + 100,
			maxStreamsPerSessionBidi: SHIPPED_MAX_STREAMS_PER_SESSION_BIDI,
			maxStreamsGlobal: 200_000,
		} as never,
		rateLimits: {
			handshakesPerSec: Math.max(cell.sessions * 4, 2000),
			handshakesBurst: Math.max(cell.sessions * 8, 4000),
			handshakesBurstPerPrefix: Math.max(cell.sessions * 8, 4000),
			// The bench measures the host, not the limiter. A cell that trips one
			// is INVALID by V-L, never reported.
			streamsPerSec: 10_000_000,
			streamsBurst: 10_000_000,
			datagramsPerSec: 10_000_000,
			datagramsBurst: 20_000_000,
		},
		onSession: (session: unknown) => {
			const s = session as ServerSession;
			liveSessions.add(s);
			const myIndex = sessionIndex++;
			record.sessions += 1;
			const live = { count: 0 };
			void (async () => {
				const incoming = s.incomingBidirectionalStreams.getReader();
				for (;;) {
					const next = await incoming.read();
					if (next.done || !next.value) break;
					record.streamsAccepted += 1;
					if (cell.arm === "X")
						driveExchangeStream(next.value, record, wallNs, live);
					else driveTunnelStream(next.value, myIndex, cell, record, wallNs);
				}
			})().catch(() => {
				// A session going away closes its accept loop; that is not an error
				// of its own, and every stream-level failure is counted where it
				// happens.
			});
		},
	});
	await Bun.sleep(1500);

	// The counter's window is this cell's drive window (§4's instrument note).
	resetStreamBatchDiagnostics();
	const metricsBefore = server.metricsSnapshot() as unknown as Record<
		string,
		number
	>;
	const cpu0 = process.cpuUsage();
	const udp0 = readUdpStats();
	const startedAt = Date.now();

	const { cmd, prefix } = childCommand(cell, port);
	const child = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();

	const clientTicks0 = readPidCpuTicks(child.pid);
	let clientTicksLast = clientTicks0;
	const hostSamples: number[] = [];
	let prevHost: CpuSnapshot | null = readHostCpu();
	const deadlineMs = cellDeadlineMs({
		driveMs: cell.stepSeconds * 1000,
		connectStaggerMs: CONNECT_STAGGER_MS,
		settleMaxMs: SETTLE_MAX_MS,
	});
	const wait = await waitForChildWithDeadline(child, {
		deadlineMs,
		sampleIntervalMs: SAMPLE_INTERVAL_MS,
		onSample: () => {
			const nextHost = readHostCpu();
			const host = hostCpuPct(prevHost, nextHost);
			prevHost = nextHost;
			if (host !== null) hostSamples.push(host);
			const ticks = readPidCpuTicks(child.pid);
			if (ticks !== null) clientTicksLast = ticks;
			for (const s of liveSessions) {
				const queued = s.metricsSnapshot?.().queuedBytes ?? 0;
				if (queued > record.peakSessionQueuedBytes)
					record.peakSessionQueuedBytes = queued;
			}
			appendFileSync(
				OUT_CSV,
				`${cell.name},${repeat},${Date.now()},${host?.toFixed(1) ?? ""},${record.upFrames},${record.downFrames},${record.peakSessionQueuedBytes}\n`,
			);
		},
		onBreach: (phase) =>
			console.error(
				`g11: ${cell.name}#${repeat} passed its ${(deadlineMs / 1000).toFixed(0)} s deadline — ${phase}; this cell is INVALID`,
			),
	});

	const exitCode = wait.exitCode;
	const [stdout, stderr] = wait.deadlineBreached
		? await Promise.all([
				valueOrAfter(stdoutPromise, DEADLINE_REAP_GRACE_MS, ""),
				valueOrAfter(stderrPromise, DEADLINE_REAP_GRACE_MS, ""),
			])
		: [await stdoutPromise, await stderrPromise];
	const childDriveSec = (Date.now() - startedAt) / 1000;
	const settle = await settleRecord(record);
	const cpu1 = process.cpuUsage(cpu0);
	const serverCpuPct =
		childDriveSec > 0
			? ((cpu1.user + cpu1.system) / 1000 / (childDriveSec * 1000)) * 100
			: null;
	// Read the socket tap while the server's socket is still open: after
	// close() its /proc row is gone and the reading would be null, which V-B
	// correctly refuses to treat as zero — but it would refuse a measurable cell.
	const socket = socketStatsForPort(port);
	const udp1 = readUdpStats();
	const metricsAfter = server.metricsSnapshot() as unknown as Record<
		string,
		number
	>;
	const serverCrossings = streamBatchDiagnosticsSnapshot();
	const serverRssMb = process.memoryUsage().rss / (1024 * 1024);
	if (exitCode !== 0) console.error(stderr.slice(-2000));
	// The client summary of a killed child is a truncated window, not a short
	// cell: parsing it would put half-measured numbers into the artifact beside
	// the flag that says they are not measurements.
	const clientSummary = wait.deadlineBreached
		? null
		: parseSummary(stdout, prefix);

	// Bounded, and never thrown. A cell's close rejects with
	// `E_BACKPRESSURE_TIMEOUT: ... asyncOpsPending=N` when the native drain
	// cannot reach idle — sessions whose peer was killed and never reaped. That
	// is a fact about this cell's teardown, not a reason to lose the fifteen
	// cells behind it, and the count travels in the artifact.
	const close = await closeBounded(() => server.close?.() ?? Promise.resolve());
	if (close.closeState !== "closed") {
		serverCloseFailures += 1;
		console.error(
			`g11: ${cell.name}#${repeat} server close ${close.closeState} after ${close.closeMs} ms${
				close.closeError ? `: ${close.closeError}` : ""
			}`,
		);
	}

	return {
		cell,
		repeat,
		record,
		client: clientSummary,
		childDriveSec,
		settleTimedOut: settle.timedOut,
		deadlineBreached: wait.deadlineBreached,
		deadlineMs,
		exitCode,
		hostCpuMedianPct: median(hostSamples),
		clientCpuPct: pidCpuPct(clientTicks0, clientTicksLast, childDriveSec),
		serverCpuPct,
		serverRssMb,
		serverSocketDrops: socket ? socket.drops : null,
		udp: udpDelta(udp0, udp1),
		rateLimitedDelta:
			(metricsAfter.rateLimitedCount ?? 0) -
			(metricsBefore.rateLimitedCount ?? 0),
		limitExceededDelta:
			(metricsAfter.limitExceededCount ?? 0) -
			(metricsBefore.limitExceededCount ?? 0),
		serverCrossings,
	};
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

function floorOf(env: StepEnvelope): FloorReport {
	const c = env.client;
	const lag = c?.schedulerLag ?? emptySnapshot();
	const settle = c?.writeSettle ?? null;
	return {
		runId: c?.runId ?? "missing",
		host: c?.host ?? "missing",
		drivingSessions: c?.drivingSessions ?? 0,
		schedulerLagP99Ms: percentileMs(lag, 0.99),
		schedulerLagMaxMs: lag.maxMs,
		writeSettleP99Ms: settle ? percentileMs(settle, 0.99) : null,
		writeSettleMaxMs: settle ? settle.maxMs : null,
	};
}

function crossingFactsOf(
	snapshot: CrossingFacts & { meanBytesPerCrossing?: number },
): CrossingFacts {
	return {
		dataCrossings: snapshot.dataCrossings,
		batchedCrossings: snapshot.batchedCrossings,
		terminalCrossings: snapshot.terminalCrossings,
		bytes: snapshot.bytes,
		maxBatchBytes: snapshot.maxBatchBytes,
	};
}

function tunnelFacts(env: StepEnvelope): TunnelCellFacts {
	const { cell, record, client } = env;
	const perSessionUp = [...record.perSessionUpBytes.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, bytes]) => bytes);
	const perSessionDown = (client?.perSession ?? [])
		.slice()
		.sort((a, b) => a.index - b.index)
		.map((s) => s.bytesRead);
	const downSnapshot = client?.latency ?? emptySnapshot();
	const upSnapshot = record.upLatency.snapshot();

	return {
		cell: cell.name,
		sessions: cell.sessions,
		repeat: env.repeat,
		knobBytes: KNOB.batchBytes,
		windowSec: cell.stepSeconds,
		runId: RUN_ID,
		host: HOST,

		offeredBytes: {
			up: client?.bytesWritten ?? 0,
			down: record.downBytes,
		},
		deliveredBytes: {
			up: record.upBytes,
			down: client?.bytesRead ?? 0,
		},
		writtenBytes: {
			up: client?.bytesWritten ?? 0,
			down: record.downBytes,
		},
		perSessionDeliveredBytes: { up: perSessionUp, down: perSessionDown },
		oneWayP99Ms: {
			up: percentileMs(upSnapshot, 0.99),
			down: percentileMs(downSnapshot, 0.99),
		},
		oneWaySamples: {
			up: record.upFrames,
			down: client?.framesRead ?? 0,
		},
		negativeSamples: {
			up: upSnapshot.negativeCount,
			down: downSnapshot.negativeCount,
		},

		streamErrors: record.streamErrors,
		streamResets: record.streamResets,
		backpressureTimeouts:
			record.backpressureTimeouts + (client?.backpressureTimeouts ?? 0),
		streamsClosedBothHalves: record.streamsFinBothHalves,

		floor: floorOf(env),
		hostCpuMedianPctOfBox: env.hostCpuMedianPct ?? Number.NaN,
		// NaN, not 0: an unsampled client is un-evaluable, and V-S2 fires on it.
		// A 0 here is the idlest possible client, which clears every ceiling by
		// construction.
		clientCpuPctOfOneCore: env.clientCpuPct ?? Number.NaN,
		// The generator is multi-threaded tokio, so its honest ceiling is every
		// core on the box. Stated rather than assumed: V-S2 only means anything
		// against the ceiling the process can actually reach.
		clientCpuCeilingPctOfOneCore: CPU_CORES * 100,
		serverCpuPctOfOneCore: env.serverCpuPct ?? 0,
		serverRssMb: env.serverRssMb,

		crossings: {
			server: crossingFactsOf(env.serverCrossings),
			// Amendment 3: `null` is "no addon ran on this end", which is a
			// different finding from `0`, and the conductor must not substitute one.
			client: client?.crossings ? crossingFactsOf(client.crossings) : null,
		},
		harnessServerReadCrossings: record.readCrossings,

		serverSocketDrops: env.serverSocketDrops,
		rateLimitedCount: env.rateLimitedDelta,
		limitExceededCount: env.limitExceededDelta,
		settled: !env.settleTimedOut,
		deadlineBreached: env.deadlineBreached,
		generatorExitCode: env.exitCode ?? null,

		maxQueuedBytesPerSession: DEFAULT_LIMITS.maxQueuedBytesPerSession,
		maxQueuedBytesGlobal: DEFAULT_LIMITS.maxQueuedBytesGlobal,
	};
}

function exchangeFacts(env: StepEnvelope): ExchangeCellFacts {
	const { cell, record, client } = env;
	const rtt = client?.latency ?? emptySnapshot();
	return {
		cell: cell.name,
		sessions: cell.sessions,
		windowSec: cell.stepSeconds,
		runId: RUN_ID,
		host: HOST,
		attemptedExchanges: client?.exchangesAttempted ?? 0,
		completedExchanges: client?.exchangesCompleted ?? 0,
		serverAcceptedStreams: record.acceptedExchangeStreams,
		clientOpenedStreams: client?.streamsOpened ?? 0,
		peakConcurrentBidiPerSession: record.peakConcurrentBidiPerSession,
		exchangeRttP99Ms: percentileMs(rtt, 0.99),
		rttSamples: client?.exchangesCompleted ?? 0,
		negativeSamples: rtt.negativeCount,
		floor: floorOf(env),
		hostCpuMedianPctOfBox: env.hostCpuMedianPct ?? Number.NaN,
		rateLimitedCount: env.rateLimitedDelta,
		limitExceededCount: env.limitExceededDelta,
		settled: !env.settleTimedOut,
		deadlineBreached: env.deadlineBreached,
	};
}

function couplingFacts(env: StepEnvelope): CouplingCellFacts {
	const { cell, record, client } = env;
	const end = cell.end ?? "client-opened";
	// The write half measured is the one on the handle whose reader is slow: on
	// a client-opened cell that is the client's writer, on a server-accepted
	// cell the server's. Measuring the other one would answer a question nobody
	// asked (Amendment 2).
	const writeP99 =
		end === "client-opened"
			? (client?.writeLatencyP99Ms ?? 0)
			: percentileMs(record.writeLatency.snapshot(), 0.99);
	return {
		cell: cell.name,
		end,
		backlogFraction: cell.backlogFraction ?? 0,
		downstreamWriteP99Ms: writeP99,
		backpressureTimeouts:
			record.backpressureTimeouts + (client?.backpressureTimeouts ?? 0),
		streamErrors: record.streamErrors + (client?.streamErrors ?? 0),
		// Always the server's session governor, on both ends, and the artifact
		// says which end it belongs to. A client-opened cell's own budget has no
		// JS reader in the tree (see `g11-client.ts`), so substituting a zero
		// there would report "no backlog" for a quantity that was never read —
		// the all-cells-drop-disclosure lesson, applied to a byte counter.
		peakSessionQueuedBytes: record.peakSessionQueuedBytes,
		deadlineBreached: env.deadlineBreached,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function selectedCells(): CellSpec[] {
	const requested = (process.env.G11_CELLS ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	const arms = (process.env.G11_ARMS ?? "T,X,J,D")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	// An explicitly named cell at the wrong knob state is a mistake and is
	// refused. An arm selection is a *shape* selection, so its cells at the
	// other knob state are skipped and named — the workflow runs each knob
	// state in its own invocation, and neither one should have to enumerate.
	if (requested.length > 0) {
		const chosen = requested.map(cellByName);
		const mismatched = chosen.filter((c) => c.knobBytes !== KNOB.batchBytes);
		if (mismatched.length > 0) {
			throw new Error(
				`g11: this process has WEBTRANSPORT_STREAM_BATCH_BYTES=${KNOB.batchBytes} ` +
					`but ${mismatched.map((c) => `${c.name} (knob ${c.knobBytes})`).join(", ")} ` +
					"is registered at another knob state. The knob is read once at module " +
					"init, so a cell cannot change it — run those cells in their own " +
					"invocation. Refusing rather than producing a cell whose label lies.",
			);
		}
		return chosen;
	}
	const inArms = CELLS.filter((c) => arms.includes(c.arm));
	const chosen = inArms.filter((c) => c.knobBytes === KNOB.batchBytes);
	const skipped = inArms.filter((c) => c.knobBytes !== KNOB.batchBytes);
	if (skipped.length > 0) {
		console.log(
			`g11: skipping ${skipped.map((c) => c.name).join(",")} — registered at ` +
				`another knob state than this process's ${KNOB.batchBytes} B; they run ` +
				"in their own invocation.",
		);
	}
	return chosen;
}

/**
 * Build the reference generator in release, the way `bench-stream.ts` does.
 * A debug generator would be a *slower* generator, and on a co-resident rig the
 * generator's cost is charged against the same 4 vCPU the capacity number is
 * about — so this is part of the measurement, not a convenience.
 */
async function buildTunnelClient(): Promise<void> {
	if (process.env.G11_SKIP_BUILD === "1") return;
	console.log("g11: building tunnel-client (release)...");
	const proc = Bun.spawn(
		[
			"cargo",
			"build",
			"-p",
			"reference",
			"--bin",
			"tunnel-client",
			"--release",
		],
		{
			cwd: ROOT,
			env: { ...process.env, CARGO_TARGET_DIR: `${ROOT}/target` },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const code = await proc.exited;
	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(
			`g11: cargo build of tunnel-client failed (${code}). No cell can run ` +
				`without the generator.\n${stderr.slice(-2000)}`,
		);
	}
}

async function main(): Promise<void> {
	if (!KNOB.diagnosticsEnabled) {
		throw new Error(
			"g11: WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS is not 1. The crossing " +
				"counters would read zero everywhere, which V-K would mistake for " +
				"'an addon ran and batched nothing' on a knob-off cell. Refusing to " +
				"run an uninstrumented gate.",
		);
	}
	if (!HAS_PROC && !SMOKE) {
		throw new Error(
			"g11: procfs is absent, so host CPU and the kernel drop tap cannot be " +
				"read. V-S would then compare against an unmeasured host and silently " +
				"not fire, and V-B's per-cell drop figure would be null for every " +
				"cell. Both are preconditions of this gate, not optional instruments " +
				"— run on the Linux runner, or set G11_SMOKE=1 for a wiring check " +
				"that grades nothing.",
		);
	}
	writeFileSync(
		OUT_CSV,
		"cell,repeat,tsMs,hostCpuPct,upFrames,downFrames,peakSessionQueuedBytes\n",
	);
	await buildTunnelClient();
	const tls = await generateLocalhostCert();
	if (!tls) throw new Error("g11: could not generate a localhost certificate");

	const cells = selectedCells();
	console.log(
		`g11: run ${RUN_ID} on ${HOST}, knob ${KNOB.batchBytes} B, procfs ${
			HAS_PROC ? "present" : "ABSENT (host CPU and drop taps read null)"
		}, cells ${cells.map((c) => c.name).join(",")}`,
	);

	const tunnelCells: Record<string, TunnelCellFacts[]> = {};
	const exchangeCells: ExchangeCellFacts[] = [];
	const couplingCells: CouplingCellFacts[] = [];
	const raw: Record<string, unknown> = {};

	for (const cell of cells) {
		for (let r = 1; r <= cell.repeats; r += 1) {
			console.log(`g11: ${cell.name} repeat ${r}/${cell.repeats}`);
			const env = await runStep(cell, r, tls);
			if (cell.arm === "X") {
				const facts = exchangeFacts(env);
				exchangeCells.push(facts);
				raw[`${cell.name}#${r}`] = facts;
			} else if (cell.arm === "D") {
				const facts = couplingFacts(env);
				couplingCells.push(facts);
				raw[`${cell.name}#${r}`] = {
					...facts,
					// Both ends' governor readings travel, not just the slow end's:
					// the client end's counter is the one that has never been read
					// on a bidi handle before, and an unverified instrument must be
					// visible as such rather than summarised into one number.
					peakQueuedBytesBothEnds: {
						client: env.client?.peakSessionQueuedBytes ?? null,
						server: env.record.peakSessionQueuedBytes,
					},
					clientWriteLatency: env.client?.writeLatency ?? null,
					serverWriteLatency: env.record.writeLatency.snapshot(),
				};
			} else {
				const facts = tunnelFacts(env);
				const bucket = tunnelCells[cell.name] ?? [];
				bucket.push(facts);
				tunnelCells[cell.name] = bucket;
				raw[`${cell.name}#${r}`] = facts;
			}
			console.log(
				`g11:   exit ${env.exitCode ?? "unreaped"}, settled ${!env.settleTimedOut}${
					env.deadlineBreached
						? `, DEADLINE BREACHED (${(env.deadlineMs / 1000).toFixed(0)} s) — INVALID`
						: ""
				}, host CPU ${env.hostCpuMedianPct?.toFixed(1) ?? "n/a"}%`,
			);
		}
	}

	// "Suppresses the roll-up entirely" has to mean all three. A smoke X-1000 is
	// a 2-session 4-second cell wearing the label of a 1,000-session one, and an
	// `exchange: { verdict: "PASS" }` beside `wiringCheckOnly: true` is a verdict
	// that has to be remembered to be ignored — which is the thing this mode
	// exists not to produce.
	const gateRepeats = SMOKE ? [] : (tunnelCells[GATE_CELL] ?? []);
	const gate = rollUpTunnelGate(gateRepeats, GATE_REPEATS);
	const exchangeGate = SMOKE
		? undefined
		: exchangeCells.find((c) => c.cell === "X-1000");
	const exchange = exchangeGate ? rollUpExchangeArm(exchangeGate) : null;
	const coupling =
		!SMOKE && couplingCells.length > 0 ? readCouplingArm(couplingCells) : null;

	const artifact = {
		registration: "docs/research/preregistrations/gate-g11-bidi.md",
		wiringCheckOnly: SMOKE,
		runId: RUN_ID,
		serverCloseFailures,
		host: HOST,
		candidateSha: process.env.G11_CANDIDATE_SHA ?? null,
		stagingBaseSha: process.env.G11_STAGING_BASE_SHA ?? null,
		environment: {
			knobBytes: KNOB.batchBytes,
			diagnosticsEnabled: KNOB.diagnosticsEnabled,
			streamBatchBytesEnv: process.env.WEBTRANSPORT_STREAM_BATCH_BYTES ?? null,
			datagramBatchSizeEnv: process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? null,
			datagramSendSyncEnv: process.env.WEBTRANSPORT_DATAGRAM_SEND_SYNC ?? null,
			bunVersion: Bun.version,
			wallClockSource,
			cpuCores: CPU_CORES,
			hasProc: HAS_PROC,
			stepSeconds: STEP_SECONDS,
			exchangeStepSeconds: EXCHANGE_STEP_SECONDS,
			couplingStepSeconds: COUPLING_STEP_SECONDS,
			connectStaggerMs: CONNECT_STAGGER_MS,
			// The repeat count the roll-up was held to. Without it in the artifact a
			// reader has to count `cells` keys by hand to tell a two-repeat gate from
			// a one-repeat one, and the two used to read identically.
			gateRepeats: GATE_REPEATS,
			shippedLimits: {
				maxQueuedBytesPerStream: DEFAULT_LIMITS.maxQueuedBytesPerStream,
				maxQueuedBytesPerSession: DEFAULT_LIMITS.maxQueuedBytesPerSession,
				maxQueuedBytesGlobal: DEFAULT_LIMITS.maxQueuedBytesGlobal,
				maxStreamsPerSessionBidi: SHIPPED_MAX_STREAMS_PER_SESSION_BIDI,
			},
		},
		gate: gateRepeats.length > 0 ? gate : null,
		gateCellRan: gateRepeats.length > 0,
		exchange,
		coupling,
		cells: raw,
	};
	writeArtifactDurable(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

	if (gateRepeats.length > 0) {
		console.log(`\ng11 gate (${GATE_CELL}): ${gate.verdict} — ${gate.reason}`);
	} else if (SMOKE) {
		console.log(
			"\ng11: WIRING CHECK ONLY (G11_SMOKE=1) — populations and windows are " +
				"not the registered ones and no verdict was computed. K16: a local " +
				"macOS number is never a result.",
		);
	} else {
		console.log(
			"\ng11: no gate cell in this invocation — this run grades nothing.",
		);
	}
	if (exchange)
		console.log(`g11 arm X: ${exchange.verdict} — ${exchange.reason}`);
	if (coupling)
		console.log(
			`g11 arm D: ${coupling.verdictFreeReading} — ${coupling.detail}`,
		);
	console.log(`g11: wrote ${OUT_JSON} and ${OUT_CSV}`);
}

await main();

// Every cell's server was already closed inside `runStep`, and the artifact is
// fsynced. What is left is the part the runtime cannot be asked to do: the
// unsettled N-API promises of sessions whose peers were killed keep Bun's event
// loop referenced with nothing running, which is the 18 minutes invocation 1
// spent past a complete artifact. The exit is taken rather than awaited.
await finishRun({
	closeServer: async () => {},
	onNote: (note) => console.log(`g11 shutdown: ${note}`),
});
