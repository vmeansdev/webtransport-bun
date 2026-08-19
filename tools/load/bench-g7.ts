#!/usr/bin/env bun
/**
 * Gate G7's conductor: the server originates, the Rust sink reads.
 *
 * Contract: `docs/research/preregistrations/gate-g7-stream-egress.md`, committed
 * before this file existed. Every threshold lives in `g7-plan.ts`; every clause
 * and falsifier lives in `g7-classify.ts`; this file only *drives* and
 * *records*. Nothing here decides a verdict, and no threshold is a CLI input —
 * populations and windows are, thresholds never.
 *
 * Two arms:
 *
 *   S-bulk    server-opened uni streams, paced to 1.25 Gbps, at four write
 *             sizes that vary the crossing rate and nothing else.
 *   S-tokens  client-opened bidi streams, 25 stamped 40 B tokens/s per session,
 *             emitted on a slice-spread grid rather than an aligned tick.
 *
 * The two arms deliberately exercise the two server-side write surfaces the
 * product actually has, and they are *not* cost-comparable to each other:
 * S-bulk writes through the Node `Writable` (`createUnidirectionalStream`),
 * S-tokens through the WHATWG writer of an accepted bidi stream, whose adapter
 * adds one `Buffer.from(chunk)` copy per write (index.ts
 * `nodeWritableToWebWritable`). Recorded here, disclosed in the artifact, and
 * read by no clause: L1 compares cells *within* the bulk ladder.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createServer,
	DEFAULT_LIMITS,
} from "../../packages/webtransport/src/index.ts";
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
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	type BulkRepeatFacts,
	rollUp,
	summariseBulkCell,
	summariseTokenCell,
	type TokenRepeatFacts,
} from "./g7-classify.ts";
import { emptySamples, G7Histogram } from "./g7-histogram.ts";
import { runPacedStream, sliceOffsetMs } from "./g7-pacer.ts";
import {
	BULK_CELLS,
	type BulkCellName,
	bulkCellPlan,
	PACE_TARGET_GBPS,
	sessionMemoryMath,
	TOKEN_CELLS,
	TOKEN_SLICES_PER_INTERVAL,
	TOKEN_STAMP_BYTES,
	type TokenCellName,
	tokenCellPlan,
} from "./g7-plan.ts";
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
} from "./g7-procfs.ts";
import { createMonotonicClock } from "./latency-clock.ts";

const ROOT = process.cwd();
const SINK_BIN = process.env.G7_SINK_BIN ?? `${ROOT}/target/release/g7-sink`;
const OUT_JSON = process.env.G7_OUT ?? join(ROOT, "tools/load/bench-g7.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");
const SAMPLE_INTERVAL_MS = Number(process.env.G7_SAMPLE_INTERVAL_MS ?? 2000);

// Populations and windows only. No threshold is an input.
const STEP_SECONDS = Number(process.env.G7_STEP_SECONDS ?? 60);
const REPEATS = Number(process.env.G7_REPEATS ?? 2);
const ARMS = (process.env.G7_ARMS ?? "bulk,tokens")
	.split(",")
	.map((v) => v.trim())
	.filter(Boolean);
const BULK_LADDER = (process.env.G7_BULK_CELLS ?? BULK_CELLS.join(","))
	.split(",")
	.map((v) => v.trim())
	.filter(Boolean) as BulkCellName[];
const TOKEN_LADDER = (process.env.G7_TOKEN_CELLS ?? TOKEN_CELLS.join(","))
	.split(",")
	.map((v) => v.trim())
	.filter(Boolean) as TokenCellName[];
const BASE_PORT = Number(process.env.G7_BASE_PORT ?? 4490);
/** Milliseconds between session connects. G1's lesson; T02's mechanism. */
const CONNECT_STAGGER_MS = Number(process.env.G7_STAGGER_MS ?? 2);

const SETTLE_POLL_MS = 250;
const SETTLE_QUIET_POLLS = 4;
const SETTLE_MAX_MS = 30_000;

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
// Server-side recording
// ---------------------------------------------------------------------------

type ServerRecord = {
	streamsOpened: number;
	streamsFinished: number;
	streamErrors: number;
	writeCalls: number;
	writeSettles: number;
	bytesWritten: number;
	firstWriteNs: number | null;
	lastWriteEndNs: number | null;
	lateness: G7Histogram;
	settle: G7Histogram;
	/** 1 Hz samples of the session governor's queued bytes. */
	queuedBytesMax: number;
	wireBytesSent: number;
	sessions: number;
};

function newServerRecord(): ServerRecord {
	return {
		streamsOpened: 0,
		streamsFinished: 0,
		streamErrors: 0,
		writeCalls: 0,
		writeSettles: 0,
		bytesWritten: 0,
		firstWriteNs: null,
		lastWriteEndNs: null,
		lateness: new G7Histogram(),
		settle: new G7Histogram(),
		queuedBytesMax: 0,
		wireBytesSent: 0,
		sessions: 0,
	};
}

/** Total the settle poller watches: a step is over when nothing moves. */
function recordTotal(r: ServerRecord): number {
	return r.writeSettles + r.streamsFinished + r.streamErrors;
}

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
// Sink child
// ---------------------------------------------------------------------------

type SinkSummary = {
	mode: string;
	sessionsOk: number;
	sessionsErr: number;
	streamsAccepted: number;
	streamsCompleted: number;
	streamsErr: number;
	bytesRead: number;
	reads: number;
	records: number;
	stampsDecoded: number;
	stampsUndecodable: number;
	sequenceGaps: number;
	outOfOrder: number;
	coalescedReads: number;
	udpRxDatagrams: number;
	udpRxBytes: number;
	oneWay: ReturnType<G7Histogram["snapshot"]>;
};

function parseSinkSummary(stdout: string): SinkSummary | null {
	const line = stdout
		.split("\n")
		.find((l) => l.startsWith("g7-sink-summary: "));
	if (!line) return null;
	try {
		return JSON.parse(line.slice("g7-sink-summary: ".length)) as SinkSummary;
	} catch {
		return null;
	}
}

function parseSinkPort(stdout: string): number | null {
	const line = stdout
		.split("\n")
		.find((l) => l.startsWith("g7-sink-local-port: "));
	if (!line) return null;
	const port = Number(line.slice("g7-sink-local-port: ".length).trim());
	return Number.isFinite(port) ? port : null;
}

// ---------------------------------------------------------------------------
// One cell repeat
// ---------------------------------------------------------------------------

type StepEnvelope = {
	record: ServerRecord;
	sink: SinkSummary | null;
	sinkPort: number | null;
	childDriveSec: number;
	settleSec: number;
	settleTimedOut: boolean;
	/** The sink outlived its pre-registered deadline and was killed. INVALID. */
	deadlineBreached: boolean;
	deadlineMs: number;
	/** `null` only when a killed sink never reaped. */
	exitCode: number | null;
	hostCpuPctMedian: number | null;
	sinkCpuPctMedian: number | null;
	serverCpuMs: number;
	udp: ReturnType<typeof udpDelta>;
	sinkSocketDrops: number | null;
	rateLimitedDelta: number;
	limitExceededDelta: number;
};

function median(values: number[]): number | null {
	const usable = values.filter((v) => Number.isFinite(v));
	if (usable.length === 0) return null;
	const sorted = [...usable].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function serverCpuMsNow(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

type CellDriver = {
	port: number;
	sessions: number;
	sinkArgs: string[];
	/** Wires the server up. Resolves when every session's writers are launched. */
	start: (session: unknown, record: ServerRecord) => void;
	limits: Record<string, number>;
};

async function runStep(
	label: string,
	driver: CellDriver,
	tls: { certPem: string; keyPem: string },
	csvIndex: number,
): Promise<StepEnvelope> {
	const record = newServerRecord();
	const server = createServer({
		port: driver.port,
		tls,
		limits: driver.limits as never,
		rateLimits: {
			handshakesPerSec: Math.max(driver.sessions * 8, 2000),
			handshakesBurst: Math.max(driver.sessions * 16, 4000),
			handshakesBurstPerPrefix: Math.max(driver.sessions * 16, 4000),
			// The bench measures the host, not the limiter. A step that trips one
			// is discarded by the classifier (V6), never reported.
			streamsPerSec: 10_000_000,
			streamsBurst: 10_000_000,
			datagramsPerSec: 10_000_000,
			datagramsBurst: 20_000_000,
		},
		onSession: (session) => {
			record.sessions += 1;
			driver.start(session, record);
		},
	});
	await Bun.sleep(1500);

	const metricsBefore = server.metricsSnapshot() as unknown as Record<
		string,
		number
	>;
	const cpuMs0 = serverCpuMsNow();
	const udp0 = readUdpStats();
	const startedAt = Date.now();

	const child = Bun.spawn([SINK_BIN, ...driver.sinkArgs], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();

	const sinkTicks0 = readPidCpuTicks(child.pid);
	let sinkTicksLast = sinkTicks0;
	const hostSamples: number[] = [];
	let prevHost: CpuSnapshot | null = readHostCpu();
	// The deadline this gate lost a 117-minute run without. Its formula is
	// pre-registered in ticket 01: drive + total connect stagger + settle +
	// margin. G7 staggers *per session*, so the ramp term is the whole ramp.
	const deadlineMs = cellDeadlineMs({
		driveMs: STEP_SECONDS * 1000,
		connectStaggerMs: CONNECT_STAGGER_MS * driver.sessions,
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
			if (ticks !== null) sinkTicksLast = ticks;
			appendFileSync(
				OUT_CSV,
				`${label},${csvIndex},${Date.now()},${host?.toFixed(1) ?? ""},${(
					((serverCpuMsNow() - cpuMs0) / Math.max(Date.now() - startedAt, 1)) *
						100
				).toFixed(1)},${record.writeCalls},${record.bytesWritten}\n`,
			);
		},
		onBreach: (phase) =>
			console.error(
				`g7: ${label} passed its ${(deadlineMs / 1000).toFixed(0)} s deadline — ${phase}; this cell is INVALID`,
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
	const serverCpuMs = serverCpuMsNow() - cpuMs0;
	const udp1 = readUdpStats();
	const metricsAfter = server.metricsSnapshot() as unknown as Record<
		string,
		number
	>;
	const sinkPort = parseSinkPort(stdout);
	const sinkSocket = sinkPort === null ? null : socketStatsForPort(sinkPort);
	if (exitCode !== 0) console.error(stderr.slice(-2000));

	// Bounded, and never thrown. A wedged sink is exactly the peer whose sessions
	// the native drain cannot reap, so this is the cell where `close()` rejects
	// with `E_BACKPRESSURE_TIMEOUT: ... asyncOpsPending=N` — one cell's teardown,
	// not a reason to lose the cells behind it. The count travels in the artifact.
	const close = await closeBounded(() => server.close?.() ?? Promise.resolve());
	if (close.closeState !== "closed") {
		serverCloseFailures += 1;
		console.error(
			`g7: server close ${close.closeState} after ${close.closeMs} ms${
				close.closeError ? `: ${close.closeError}` : ""
			}`,
		);
	}

	return {
		record,
		// A killed sink's summary is a truncated window, not a short cell:
		// parsing it would put half-measured numbers into the artifact beside the
		// flag that says they are not measurements.
		sink: wait.deadlineBreached ? null : parseSinkSummary(stdout),
		sinkPort,
		childDriveSec,
		settleSec: settle.settleSec,
		settleTimedOut: settle.timedOut,
		deadlineBreached: wait.deadlineBreached,
		deadlineMs,
		exitCode,
		hostCpuPctMedian: median(hostSamples),
		sinkCpuPctMedian: pidCpuPct(sinkTicks0, sinkTicksLast, childDriveSec),
		serverCpuMs,
		udp: udpDelta(udp0, udp1),
		// The sink's socket is read after it exits, so the row is usually gone:
		// null is "unmeasured", which the classifier refuses to grade as zero.
		sinkSocketDrops: sinkSocket ? sinkSocket.drops : null,
		rateLimitedDelta:
			(metricsAfter.rateLimitedCount ?? 0) -
			(metricsBefore.rateLimitedCount ?? 0),
		limitExceededDelta:
			(metricsAfter.limitExceededCount ?? 0) -
			(metricsBefore.limitExceededCount ?? 0),
	};
}

// ---------------------------------------------------------------------------
// Arm S-bulk
// ---------------------------------------------------------------------------

async function runBulkRepeat(
	cell: BulkCellName,
	repeat: number,
	tls: { certPem: string; keyPem: string },
	clock: { now: () => number },
	csvIndex: number,
): Promise<BulkRepeatFacts> {
	const plan = bulkCellPlan(cell);
	const port = nextPort();
	const nowMs = () => clock.now() / 1e6;

	const driver: CellDriver = {
		port,
		sessions: plan.sessions,
		sinkArgs: [
			"--url",
			`https://127.0.0.1:${port}`,
			"--sessions",
			String(plan.sessions),
			"--duration",
			String(STEP_SECONDS),
			"--mode",
			"bulk",
			"--streams-per-session",
			String(plan.streamsPerSession),
			"--stagger-ms",
			String(CONNECT_STAGGER_MS),
		],
		limits: {
			maxSessions: plan.sessions + 100,
			maxHandshakesInFlight: plan.sessions + 100,
			maxStreamsPerSessionUni: Math.max(
				plan.streamsPerSession * 4,
				DEFAULT_LIMITS.maxStreamsPerSessionUni,
			),
			maxStreamsGlobal: 200_000,
			// C6: the governors stay at their shipped values and no explicit
			// window field is set. This is the clause, not a convenience.
		},
		start: (session, record) => {
			void (async () => {
				for (let i = 0; i < plan.streamsPerSession; i += 1) {
					try {
						const writable = await (
							session as {
								createUnidirectionalStream: () => Promise<{
									write: (
										chunk: Uint8Array,
										cb: (err?: Error | null) => void,
									) => boolean;
									end: (cb?: (err?: Error | null) => void) => void;
								}>;
							}
						).createUnidirectionalStream();
						record.streamsOpened += 1;
						void runOnePacedStream(writable, plan, record, nowMs);
					} catch (err) {
						record.streamErrors += 1;
						console.error(`bulk: createUnidirectionalStream failed: ${err}`);
					}
				}
			})();
		},
	};

	const env = await runStep(`${cell}#${repeat}`, driver, tls, csvIndex);
	return bulkFacts(cell, repeat, plan, env);
}

async function runOnePacedStream(
	writable: {
		write: (chunk: Uint8Array, cb: (err?: Error | null) => void) => boolean;
		end: (cb?: (err?: Error | null) => void) => void;
	},
	plan: ReturnType<typeof bulkCellPlan>,
	record: ServerRecord,
	nowMs: () => number,
): Promise<void> {
	// One application write is one native `handle.write(chunk)` because the
	// callback fires when that promise settles, so at most one chunk is ever in
	// the Writable's own queue. That equality is what the byte ledger checks.
	const write = (chunk: Uint8Array) =>
		new Promise<void>((resolve, reject) => {
			writable.write(chunk, (err) => (err ? reject(err) : resolve()));
		});

	const startNs = nowMs() * 1e6;
	if (record.firstWriteNs === null || startNs < record.firstWriteNs)
		record.firstWriteNs = startNs;

	const result = await runPacedStream({
		write,
		writeBytes: plan.writeBytes,
		bytesPerSec: plan.perStreamBytesPerSec,
		durationMs: STEP_SECONDS * 1000,
		sliceQuantum: plan.sliceQuantum,
		now: nowMs,
		sleep: (ms) => Bun.sleep(ms),
		allocChunk: (n) => Buffer.allocUnsafe(n),
	});

	record.writeCalls += result.writes;
	record.writeSettles += result.settles;
	record.bytesWritten += result.bytes;
	record.streamErrors += result.errors;
	record.lateness.merge(result.lateness.snapshot());
	record.settle.merge(result.settle.snapshot());
	const endNs = nowMs() * 1e6;
	if (record.lastWriteEndNs === null || endNs > record.lastWriteEndNs)
		record.lastWriteEndNs = endNs;

	await new Promise<void>((resolve) => {
		writable.end(() => resolve());
	});
	record.streamsFinished += 1;
}

function bulkFacts(
	cell: BulkCellName,
	repeat: number,
	plan: ReturnType<typeof bulkCellPlan>,
	env: StepEnvelope,
): BulkRepeatFacts {
	const writeWindowSec =
		env.record.firstWriteNs !== null && env.record.lastWriteEndNs !== null
			? (env.record.lastWriteEndNs - env.record.firstWriteNs) / 1e9
			: env.childDriveSec;
	const sink = env.sink;
	return {
		cell,
		repeat,
		bucket: env.deadlineBreached
			? "deadline-breached"
			: env.settleTimedOut
				? "drain-unsettled"
				: "paced-cell",
		incomplete: env.settleTimedOut || env.deadlineBreached,
		deadlineBreached: env.deadlineBreached,
		hostCpuPctMedian: env.hostCpuPctMedian,
		sinkCpuPctMedian: env.sinkCpuPctMedian,
		rateLimitedDelta: env.rateLimitedDelta,
		limitExceededDelta: env.limitExceededDelta,
		sessionsErr: sink?.sessionsErr ?? 0,
		exitCode: env.exitCode,
		streamBatchBytesEnv: Number(
			process.env.WEBTRANSPORT_STREAM_BATCH_BYTES ?? 0,
		),
		clientRcvbufErrors: env.sinkSocketDrops,
		serverSndbufErrors: env.udp ? env.udp.sndbufErrors : null,
		writeWindowSec,
		childDriveSec: env.childDriveSec,
		windowSec: STEP_SECONDS,
		writeBytes: plan.writeBytes,
		paceBytesPerSec: plan.paceBytesPerSec,
		offeredBytesPerSecWriteWindow:
			writeWindowSec > 0 ? env.record.bytesWritten / writeWindowSec : null,
		deliveredBytesPerSecWriteWindow:
			sink && writeWindowSec > 0 ? sink.bytesRead / writeWindowSec : null,
		deliveredBytesPerSecNominal: sink ? sink.bytesRead / STEP_SECONDS : null,
		serverBytesWritten: env.record.bytesWritten,
		sinkBytesRead: sink?.bytesRead ?? 0,
		writeCalls: env.record.writeCalls,
		writeSettles: env.record.writeSettles,
		streamsOpened: env.record.streamsOpened,
		streamsAccepted: sink?.streamsAccepted ?? 0,
		streamsFinished: env.record.streamsFinished,
		serverStreamErrors: env.record.streamErrors,
		sinkStreamErrors: sink?.streamsErr ?? 0,
		pacerLateness: env.record.lateness.snapshot(),
		writeSettle: env.record.settle.snapshot(),
		writeIntervalMs: plan.writeIntervalMs,
		serverCpuMs: env.serverCpuMs,
		wireBytesSent:
			env.record.wireBytesSent > 0 ? env.record.wireBytesSent : null,
		explicitWindowFieldsSet: false,
		queuedBytesPerStream: DEFAULT_LIMITS.maxQueuedBytesPerStream,
		queuedBytesPerSession: DEFAULT_LIMITS.maxQueuedBytesPerSession,
	};
}

// ---------------------------------------------------------------------------
// Arm S-tokens
// ---------------------------------------------------------------------------

async function runTokenRepeat(
	cell: TokenCellName,
	repeat: number,
	tls: { certPem: string; keyPem: string },
	clock: { now: () => number },
	csvIndex: number,
): Promise<TokenRepeatFacts> {
	const plan = tokenCellPlan(cell);
	const port = nextPort();
	const nowMs = () => clock.now() / 1e6;
	let sessionIndex = 0;

	const driver: CellDriver = {
		port,
		sessions: plan.sessions,
		sinkArgs: [
			"--url",
			`https://127.0.0.1:${port}`,
			"--sessions",
			String(plan.sessions),
			"--duration",
			String(STEP_SECONDS),
			"--mode",
			"tokens",
			"--record-bytes",
			String(plan.writeBytes),
			"--stagger-ms",
			String(CONNECT_STAGGER_MS),
		],
		limits: {
			maxSessions: plan.sessions + 200,
			maxHandshakesInFlight: plan.sessions + 200,
			maxStreamsPerSessionBidi: 16,
			maxStreamsGlobal: 200_000,
		},
		start: (session, record) => {
			const mySlice = sessionIndex % TOKEN_SLICES_PER_INTERVAL;
			sessionIndex += 1;
			void (async () => {
				const reader = (
					session as {
						incomingBidirectionalStreams: ReadableStream<{
							readable: ReadableStream<Uint8Array>;
							writable: WritableStream<Uint8Array>;
						}>;
					}
				).incomingBidirectionalStreams.getReader();
				const next = await reader.read();
				if (next.done || !next.value) return;
				record.streamsOpened += 1;
				// Drain the prompt so the client's write half never parks.
				void (async () => {
					const r = next.value.readable.getReader();
					try {
						while (!(await r.read()).done) {
							// The prompt is a few bytes; nothing is measured on this half.
						}
					} catch {
						// A closed request half is the client going away, not an error.
					}
				})();
				await runTokenEmitter(
					next.value.writable,
					plan,
					mySlice,
					record,
					nowMs,
				);
			})().catch((err) => {
				record.streamErrors += 1;
				console.error(`tokens: session driver failed: ${err}`);
			});
		},
	};

	const env = await runStep(`${cell}#${repeat}`, driver, tls, csvIndex);
	return tokenFacts(cell, repeat, plan, env);
}

async function runTokenEmitter(
	writable: WritableStream<Uint8Array>,
	plan: ReturnType<typeof tokenCellPlan>,
	slice: number,
	record: ServerRecord,
	nowMs: () => number,
): Promise<void> {
	const writer = writable.getWriter();
	// Slice-spreading, not jitter: a session's offset inside the interval is a
	// function of its index, so the emission grid is reproducible and no tick
	// carries the whole fleet.
	await Bun.sleep(sliceOffsetMs(slice, plan.slices, plan.intervalMs));

	const startNs = nowMs() * 1e6;
	if (record.firstWriteNs === null || startNs < record.firstWriteNs)
		record.firstWriteNs = startNs;

	let sequence = 0;
	const result = await runPacedStream({
		write: (chunk) => writer.write(chunk),
		writeBytes: plan.writeBytes,
		bytesPerSec: plan.writeBytes * plan.tokensPerSec,
		durationMs: STEP_SECONDS * 1000,
		sliceQuantum: 1,
		now: nowMs,
		sleep: (ms) => Bun.sleep(ms),
		allocChunk: (n) => Buffer.allocUnsafe(n),
		fill: (chunk, _index, intendedMs) => {
			// `actual` is read here, immediately before the write call, so the
			// one-way interval the sink computes starts at the write and contains
			// the whole product path and nothing before it.
			writeStamp(chunk, intendedMs * 1e6, nowMs() * 1e6, sequence);
			sequence += 1;
		},
	});

	record.writeCalls += result.writes;
	record.writeSettles += result.settles;
	record.bytesWritten += result.bytes;
	record.streamErrors += result.errors;
	record.lateness.merge(result.lateness.snapshot());
	record.settle.merge(result.settle.snapshot());
	const endNs = nowMs() * 1e6;
	if (record.lastWriteEndNs === null || endNs > record.lastWriteEndNs)
		record.lastWriteEndNs = endNs;

	try {
		await writer.close();
		record.streamsFinished += 1;
	} catch {
		record.streamErrors += 1;
	}
}

const STAMP_MAGIC = 0x4c54;
const STAMP_VERSION = 1;

/** The 28-byte v1 stamp, written in place. Mirrors `latency_probe.rs`. */
function writeStamp(
	chunk: Uint8Array,
	intendedNs: number,
	actualNs: number,
	sequence: number,
): void {
	const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	view.setUint16(0, STAMP_MAGIC, true);
	view.setUint16(2, STAMP_VERSION, true);
	writeU64(view, 4, intendedNs);
	writeU64(view, 12, actualNs);
	writeU64(view, 20, sequence);
}

function writeU64(view: DataView, offset: number, value: number): void {
	const low = value % 4294967296;
	view.setUint32(offset, low, true);
	view.setUint32(offset + 4, (value - low) / 4294967296, true);
}

function tokenFacts(
	cell: TokenCellName,
	repeat: number,
	plan: ReturnType<typeof tokenCellPlan>,
	env: StepEnvelope,
): TokenRepeatFacts {
	const writeWindowSec =
		env.record.firstWriteNs !== null && env.record.lastWriteEndNs !== null
			? (env.record.lastWriteEndNs - env.record.firstWriteNs) / 1e9
			: env.childDriveSec;
	const sink = env.sink;
	return {
		cell,
		repeat,
		bucket: env.deadlineBreached
			? "deadline-breached"
			: env.settleTimedOut
				? "drain-unsettled"
				: "token-cell",
		incomplete: env.settleTimedOut || env.deadlineBreached,
		deadlineBreached: env.deadlineBreached,
		hostCpuPctMedian: env.hostCpuPctMedian,
		sinkCpuPctMedian: env.sinkCpuPctMedian,
		rateLimitedDelta: env.rateLimitedDelta,
		limitExceededDelta: env.limitExceededDelta,
		sessionsErr: sink?.sessionsErr ?? 0,
		exitCode: env.exitCode,
		streamBatchBytesEnv: Number(
			process.env.WEBTRANSPORT_STREAM_BATCH_BYTES ?? 0,
		),
		clientRcvbufErrors: env.sinkSocketDrops,
		serverSndbufErrors: env.udp ? env.udp.sndbufErrors : null,
		writeWindowSec,
		childDriveSec: env.childDriveSec,
		windowSec: STEP_SECONDS,
		sessions: plan.sessions,
		writeBytes: plan.writeBytes,
		writesIssued: env.record.writeCalls,
		writesReceived: sink?.records ?? 0,
		writeSettles: env.record.writeSettles,
		stampsDecoded: sink?.stampsDecoded ?? 0,
		stampsUndecodable: sink?.stampsUndecodable ?? 0,
		sequenceGaps: sink?.sequenceGaps ?? 0,
		outOfOrder: sink?.outOfOrder ?? 0,
		streamsOpened: env.record.streamsOpened,
		streamsAccepted: sink?.streamsAccepted ?? 0,
		streamsFinished: env.record.streamsFinished,
		serverStreamErrors: env.record.streamErrors,
		sinkStreamErrors: sink?.streamsErr ?? 0,
		oneWay: sink?.oneWay ?? emptySamples(),
		pacerLateness: env.record.lateness.snapshot(),
		writeSettle: env.record.settle.snapshot(),
		intervalMs: plan.intervalMs,
		serverCpuMs: env.serverCpuMs,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	writeFileSync(
		OUT_CSV,
		"label,step,tsMs,hostCpuPct,serverCpuPct,writeCalls,bytesWritten\n",
	);
	const tls = await generateLocalhostCert();
	if (!tls)
		throw new Error(
			"g7: could not generate a localhost certificate; no cell can run",
		);
	const clock = await createMonotonicClock(false);
	console.log(
		`g7: clock source ${clock.source}, procfs ${HAS_PROC ? "present" : "ABSENT (every cell will classify INCOMPLETE)"}`,
	);
	console.log(
		`g7: pace ${PACE_TARGET_GBPS} Gbps, step ${STEP_SECONDS}s x ${REPEATS} repeats, sink ${SINK_BIN}`,
	);

	const bulk = new Map<BulkCellName, BulkRepeatFacts[]>();
	const tokens = new Map<TokenCellName, TokenRepeatFacts[]>();
	let csvIndex = 0;

	if (ARMS.includes("bulk"))
		for (const cell of BULK_LADDER) {
			const reps: BulkRepeatFacts[] = [];
			for (let r = 1; r <= REPEATS; r += 1) {
				console.log(`g7: bulk ${cell} repeat ${r}`);
				reps.push(await runBulkRepeat(cell, r, tls, clock, csvIndex++));
			}
			bulk.set(cell, reps);
		}

	if (ARMS.includes("tokens"))
		for (const cell of TOKEN_LADDER) {
			const reps: TokenRepeatFacts[] = [];
			for (let r = 1; r <= REPEATS; r += 1) {
				console.log(`g7: tokens ${cell} repeat ${r}`);
				reps.push(await runTokenRepeat(cell, r, tls, clock, csvIndex++));
			}
			tokens.set(cell, reps);
		}

	const bulkSummaries = new Map(
		[...bulk].map(([cell, reps]) => [cell, summariseBulkCell(cell, reps)]),
	);
	const tokenSummaries = new Map(
		[...tokens].map(([cell, reps]) => [cell, summariseTokenCell(cell, reps)]),
	);
	const verdict = rollUp(bulkSummaries, tokenSummaries);

	const artifact = {
		registration: "docs/research/preregistrations/gate-g7-stream-egress.md",
		config: {
			stepSeconds: STEP_SECONDS,
			repeats: REPEATS,
			paceGbps: PACE_TARGET_GBPS,
			connectStaggerMs: CONNECT_STAGGER_MS,
			stampBytes: TOKEN_STAMP_BYTES,
			clockSource: clock.source,
			hasProc: HAS_PROC,
			streamBatchBytesEnv: process.env.WEBTRANSPORT_STREAM_BATCH_BYTES ?? null,
			datagramSendSyncEnv: process.env.WEBTRANSPORT_DATAGRAM_SEND_SYNC ?? null,
			shippedMemoryMath: sessionMemoryMath({
				maxSessions: DEFAULT_LIMITS.maxSessions,
				rigBytes: 8 * 1024 ** 3,
			}),
			surfaceNote:
				"S-bulk writes through the Node Writable; S-tokens through the WHATWG " +
				"writer, whose adapter adds one Buffer.from(chunk) copy per write. The " +
				"two arms are not cost-comparable to each other and no clause compares them.",
		},
		serverCloseFailures,
		verdict,
		bulk: Object.fromEntries(bulkSummaries),
		tokens: Object.fromEntries(tokenSummaries),
		rawBulk: Object.fromEntries(bulk),
		rawTokens: Object.fromEntries(tokens),
	};
	writeArtifactDurable(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

	console.log(`\n${verdict.headline}`);
	for (const clause of verdict.clauses)
		console.log(`  ${clause.id} ${clause.verdict}: ${clause.detail}`);
	console.log(`  L1 ${verdict.l1.verdict}: ${verdict.l1.detail}`);
	console.log(`\ng7: wrote ${OUT_JSON} and ${OUT_CSV}`);
}

await main();

// Every cell's server was already closed inside the step, and the artifact is
// fsynced. What is left is the part the runtime cannot be asked to do: the
// unsettled N-API promises of sessions whose sink was killed keep Bun's event
// loop referenced with nothing running. The 117-minute wedge was the sink; this
// is the tail that outlives it. The exit is taken rather than awaited.
await finishRun({
	closeServer: async () => {},
	onNote: (note) => console.log(`g7 shutdown: ${note}`),
});
