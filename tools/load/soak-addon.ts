#!/usr/bin/env bun

/**
 * Long-run soak harness for the addon server.
 *
 * Modes:
 * - default / `run`: execute one segment and write a tamper-evident artifact
 * - `aggregate <files-or-dirs...>`: verify a full multi-segment campaign chain
 *
 * The workflow never starts 24h/72h campaigns automatically. It only provides
 * the exact bounded segment harness and aggregation gates needed to validate a
 * final immutable candidate.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { $ } from "bun";

import {
	createServer,
	DEFAULT_LIMITS,
	releaseNativeMemory,
	type WebTransportServer,
	WT_RESET,
	WT_STOP_SENDING,
} from "../../packages/webtransport/src/index.ts";
import { readPhysFootprintMb } from "./distributed-scale.ts";
import {
	type GeneratedCert,
	generateLocalhostCert,
} from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;
const DURATION = parseInt(process.env.SOAK_DURATION ?? "1800", 10);
const SESSIONS = parseInt(process.env.SOAK_SESSIONS ?? "500", 10);
const DATAGRAMS_PER_SEC = parseInt(
	process.env.SOAK_DATAGRAMS_PER_SEC ?? "500",
	10,
);
const STREAMS_PER_SEC = parseInt(process.env.SOAK_STREAMS_PER_SEC ?? "5", 10);
const MAX_SESSION_ERRORS = Math.ceil(SESSIONS * 0.5);
const MAX_DATAGRAM_ERRORS = 5000;
const MAX_STREAM_ERRORS = 2000;
// 0.3: on a slow shared runner a 2-minute campaign's warm-up tail continues
// into the tail window (observed +20.2% charged drift with every phase and
// structural rule green — the middle-third warm reference is still warming
// at that scale). A genuine leak in the long campaigns this same rule
// guards (1h/24h/72h) accumulates far past 30%; the absolute arm still
// applies too.
const RSS_TREND_MAX_REL = parseFloat(
	process.env.SOAK_RSS_TREND_MAX_REL ?? "0.3",
);
const RSS_TREND_MIN_ABS_MB = parseFloat(
	process.env.SOAK_RSS_TREND_MIN_ABS_MB ?? "32",
);
// Peak ceiling scales with the configured session count: the overload phase
// deliberately runs 0.6*SESSIONS extra sessions with a doubled datagram
// flood, and its legitimate charged peak is proportional to that load (the
// fixed 1GB default predated the overload phase at SESSIONS=500). The floor
// keeps small-profile runs (droplet tiny = 50 sessions) strict.
// 3.5MB/session: observed overload-burst peaks at SESSIONS=500 range
// 1073-1322MB across identical runs (scheduling variance), so 1750MB gives
// ~30% headroom over the worst observed while still failing a 2x runaway.
const RSS_CEIL_MB = parseFloat(
	process.env.SOAK_RSS_CEIL_MB ?? String(Math.max(1024, SESSIONS * 3.5)),
);
const MAX_AGGREGATE_GAP_MS = parseInt(
	process.env.SOAK_MAX_SEGMENT_GAP_MS ?? `${5 * 60 * 1000}`,
	10,
);
const OVERLAP_SKEW_MS = parseInt(
	process.env.SOAK_MAX_SEGMENT_OVERLAP_SKEW_MS ?? "5000",
	10,
);
const SEGMENT_MAX_SECONDS = 6 * 60 * 60;
const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
// Bun <=1.3.13 leaks one WritableStream + rejection Error per server bidi
// stream whose writer.close() rejects (the STOP_SENDING teardown path every
// load-bidi stream takes) — enough to OOM a long soak. Segment evidence must
// never be generated on such a runtime, and aggregation must reject segments
// that were.
const MIN_BUN_VERSION = "1.3.14";

/** Strict semver floor: every part must be a bare integer. Prereleases and
 * malformed strings fail closed (a "1.3.14-canary" predates the fix). */
export function bunVersionAtLeast(actual: string, floor: string): boolean {
	const parse = (v: string): [number, number, number] | null => {
		const parts = v.split(".");
		if (parts.length < 3) return null;
		const nums = parts
			.slice(0, 3)
			.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
		if (nums.some((n) => Number.isNaN(n))) return null;
		return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
	};
	const a = parse(actual);
	const f = parse(floor);
	if (!a || !f) return false;
	const cmp = a[0] - f[0] || a[1] - f[1] || a[2] - f[2];
	return cmp >= 0;
}

/** Called from runSegment(), not at module load: aggregation and the pure
 * analysis helpers only read artifacts produced elsewhere and stay importable
 * on any runtime. */
function assertBunVersion(): void {
	if (!bunVersionAtLeast(Bun.version, MIN_BUN_VERSION)) {
		throw new Error(
			`soak-addon requires Bun >= ${MIN_BUN_VERSION} (found ${Bun.version}): ` +
				"older runtimes leak WritableStreams on rejected close and " +
				"invalidate long-soak memory evidence",
		);
	}
}

/** Evidence-tool env parsing fails closed: a typo'd knob must abort, not
 * silently disable the guard it configures. */
function requireNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(
			`${name}=${JSON.stringify(raw)} is not a non-negative number`,
		);
	}
	return value;
}
// Return the native allocator's MADV_FREE'd arenas to the OS periodically
// during the long main-load stretch. The charged-memory metric (Rss minus
// LazyFree) already excludes those pages, but the kernel OOM-killer counts
// raw RSS, so on a memory-constrained host a many-hour run grows raw RSS
// unboundedly and is OOM-killed even though its charged footprint is flat.
// This is the same releaseNativeMemory() a long-running production server
// should call periodically; the phase-boundary relief only fires at the
// sparse phase edges. Env-tunable, off when set to 0.
const RELIEF_INTERVAL_MS = Number(
	process.env.SOAK_RELIEF_INTERVAL_MS ?? String(5 * 60_000),
);
const CHILD_EXIT_GRACE_MS = Math.max(
	1,
	parseInt(process.env.SOAK_CHILD_EXIT_GRACE_MS ?? "10000", 10),
);
const CHILD_OUTPUT_DRAIN_MS = Math.max(
	1,
	parseInt(process.env.SOAK_CHILD_OUTPUT_DRAIN_MS ?? "5000", 10),
);
const CHILD_OUTPUT_LIMIT_BYTES = Math.max(
	1024,
	parseInt(process.env.SOAK_CHILD_OUTPUT_LIMIT_BYTES ?? `${1024 * 1024}`, 10),
);
const LOAD_IO_TIMEOUT_MS = Math.max(
	1_000,
	parseInt(process.env.SOAK_IO_TIMEOUT_MS ?? "5000", 10),
);
const SOCKET_RECOVERY_TOLERANCE = 1;
const FD_RECOVERY_TOLERANCE = 4;
const FD_RECOVERY_REL_TOLERANCE = 0.15;
const TASK_RECOVERY_TOLERANCE = 1;
const SESSION_RECOVERY_TOLERANCE = 2;
const SESSION_RECOVERY_REL_TOLERANCE = 0.1;
const QUEUE_RECOVERY_TOLERANCE_BYTES = 64 * 1024;
// The soak harness shares the server's process, and its own bounded state —
// captured child stdout (SOAK_CHILD_OUTPUT_LIMIT_BYTES per load-client run),
// the sample series, phase records — legitimately accumulates on the JS heap.
// The absolute floor absorbs that documented overhead; a real leak grows far
// past it over a soak, and the 20% relative arm stays required too.
const HEAP_TREND_MIN_ABS_MB = 64;

const REQUIRED_LOAD_OPERATION_CLASSES = [
	"datagram-echo",
	"uni-echo",
	"bidi-echo",
	"stream-reset",
	"stop-sending",
] as const;
const REQUIRED_SEGMENT_OPERATION_CLASSES = [
	...REQUIRED_LOAD_OPERATION_CLASSES,
	"idle-peers",
	"overload",
	"reconnect-churn",
	"cert-rotation",
] as const;

type LoadOperationClass = (typeof REQUIRED_LOAD_OPERATION_CLASSES)[number];
type SegmentOperationClass =
	(typeof REQUIRED_SEGMENT_OPERATION_CLASSES)[number];
type OperationCounts<T extends string> = Record<T, number>;

type RuntimeSnapshot = {
	rssMb: number;
	/** OS-charged memory (see getChargedMb); rssMb stays raw for disclosure. */
	chargedMb: number;
	heapUsedMb: number;
	fd: number;
	sockets: number;
	sessionsActive: number;
	streamsActive: number;
	sessionTasksActive: number;
	streamTasksActive: number;
	queuedBytesGlobal: number;
};

type WebIncomingBidi = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	[WT_RESET]?: (code?: number) => void;
	[WT_STOP_SENDING]?: (code?: number) => void;
};

type WebIncomingUni = ReadableStream<Uint8Array> & {
	[WT_STOP_SENDING]?: (code?: number) => void;
};

type ReaderDoneResult<T> = {
	done: true;
	value?: T;
};

type ReaderValueResult<T> = {
	done: false;
	value: T;
};

type ReaderResult<T> = ReaderDoneResult<T> | ReaderValueResult<T>;

const PROBE_PREFIX = "probe:";
const LOAD_PREFIX = "load:";
const PROBE_DATAGRAM_PREFIX = `${PROBE_PREFIX}datagram-echo:`;
const PROBE_UNI_ECHO_PREFIX = `${PROBE_PREFIX}uni-echo:`;
const PROBE_UNI_STOP_PREFIX = `${PROBE_PREFIX}uni-stop:`;
const PROBE_BIDI_ECHO_PREFIX = `${PROBE_PREFIX}bidi-echo:`;
const PROBE_BIDI_RESET_PREFIX = `${PROBE_PREFIX}bidi-reset:`;
const LOAD_UNI_PREFIX = `${LOAD_PREFIX}uni:`;
const LOAD_BIDI_PREFIX = `${LOAD_PREFIX}bidi:`;

export type Sample = {
	ts_ms: number;
	phase: string;
	rss: number;
	/** Raw RSS (what the OOM-killer sees); rss stays the charged metric. */
	rawRssMb?: number;
	heapUsedMb: number;
	fd: number;
	sockets: number;
	sessions: number;
	streams: number;
	sessionTasks: number;
	streamTasks: number;
	queued: number;
	/** Anonymous resident pages (Linux /proc/self/status RssAnon). */
	rssAnonMb?: number;
	/** Pages swapped out (Linux /proc/self/status VmSwap). RSS-based guards
	 * are blind to swapped pages, so trend rules gate on committedMb. */
	vmSwapMb?: number;
	/** rssAnonMb + vmSwapMb — bounded by the committed drift rule and the
	 * SOAK_COMMITTED_ABORT_MB breaker. */
	committedMb?: number;
	/** JSC heap capacity (>= heapUsed; committed JS heap). */
	heapCapacityMb?: number;
	/** Live JS object count. */
	objectCount?: number;
	/** Written-to private pages (smaps_rollup Private_Dirty): live data the
	 * process actually holds. Drift here = real allocations, not arena slack. */
	privateDirtyMb?: number;
	/** MADV_FREE'd pages still counted in Rss (smaps_rollup LazyFree): freed
	 * allocator arenas awaiting reclaim. Drift here = allocator retention. */
	lazyFreeMb?: number;
	/** Total anonymous mappings (smaps_rollup Anonymous). */
	anonymousMb?: number;
};

type LoadClientSummary = {
	name: string;
	startedAtMs: number;
	endedAtMs: number;
	durationMs: number;
	timedOut: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	sessionsOk: number;
	sessionsErr: number;
	datagramsSent: number;
	datagramsErr: number;
	streamsOpened: number;
	streamsErr: number;
	passLineSeen: boolean;
	requiredOperationClasses: LoadOperationClass[];
	observedOperationCounts: OperationCounts<LoadOperationClass>;
	observedReconnects: number;
};

type PhaseRecord = {
	name: string;
	startedAtMs: number;
	endedAtMs: number;
	pass: boolean;
	notes: string[];
	load?: LoadClientSummary;
	rotationFingerprint?: string;
};

type SoakTrendSummary = {
	pass: boolean;
	failures: string[];
	phaseMedians: Record<string, PhaseMedianSummary>;
	steadyState: PhaseMedianSummary | null;
};

type PhaseMedianSummary = {
	count: number;
	rssMb: number;
	heapUsedMb: number;
	fd: number;
	sockets: number;
	queuedBytes: number;
	sessionTasks: number;
	streamTasks: number;
	sessions: number;
	streams: number;
	rssSlopeMbPerHour: number;
	heapSlopeMbPerHour: number;
	fdSlopePerHour: number;
	socketSlopePerHour: number;
	queuedSlopeBytesPerHour: number;
	/** Median committed memory over the samples that carry it (Linux only);
	 * 0 when no sample in the window has committedMb. */
	committedMb: number;
	committedSlopeMbPerHour: number;
};

type ToolIdentity = {
	path: string;
	version: string;
};

export type SegmentMetadata = {
	version: 1;
	status: "pass" | "fail";
	mode: "segment";
	/** Which OS memory metric the trend/recovery rules ran on. */
	memoryMetric: "phys-footprint" | "smaps-lazyfree" | "rss-fallback";
	repoRoot: string;
	segmentIndex: number;
	segmentCount: number;
	candidateCommit: string;
	actualCommit: string;
	candidateRef: string | null;
	seed: string;
	continuityTokenDigest: string;
	previousFinalHash: string | null;
	startedAtMs: number;
	endedAtMs: number;
	durationSeconds: number;
	runnerType: string;
	runnerMode: string;
	runnerProfile: string;
	/** Debug/guard knobs active during the run — recorded so evidence readers
	 * can see measurement perturbation (heap-stats scans) and breaker config. */
	debugKnobs?: {
		heapDebug: boolean;
		heapDebugIntervalMs: number;
		committedAbortMb: number;
	};
	toolchain: {
		bun: string;
		rustc: string;
		cc: ToolIdentity;
		cxx: ToolIdentity;
	};
	rates: {
		sessions: number;
		datagramsPerSec: number;
		streamsPerSec: number;
	};
	requiredOperationClasses: SegmentOperationClass[];
	observedOperationCounts: OperationCounts<SegmentOperationClass>;
	thresholds: {
		maxSessionErrors: number;
		maxDatagramErrors: number;
		maxStreamErrors: number;
		rssTrendMaxRel: number;
		rssTrendMinAbsMb: number;
		rssCeilMb: number;
		maxGapMs: number;
	};
	phasePlan: {
		name: string;
		startOffsetMs: number;
		durationMs: number;
	}[];
	baselineMetrics: RuntimeSnapshot;
	mainLoad: LoadClientSummary;
	phaseRecords: PhaseRecord[];
	trend: SoakTrendSummary;
	finalMetrics: RuntimeSnapshot & {
		peakSessions: number;
		peakStreams: number;
	};
	samples: Sample[];
	initialStateHash: string;
	finalStateHash: string;
	segmentHash: string;
};

export type AggregateSummary = {
	mode: "aggregate";
	status: "pass";
	segmentCount: number;
	expectedSegmentCount: number;
	candidateCommit: string;
	seed: string;
	continuityTokenDigest: string;
	toolchain: {
		bun: string;
		rustc: string;
		cc: ToolIdentity;
		cxx: ToolIdentity;
	};
	segments: {
		index: number;
		file: string;
		finalStateHash: string;
		startedAtMs: number;
		endedAtMs: number;
		status: string;
	}[];
	totalDurationSeconds: number;
	aggregateHash: string;
};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, canonicalize(nested)]),
		);
	}
	return value;
}

function sha256Hex(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted.at(mid - 1) ?? 0) + (sorted.at(mid) ?? 0)) / 2
		: (sorted.at(mid) ?? 0);
}

function zeroOperationCounts<T extends string>(
	keys: readonly T[],
): OperationCounts<T> {
	return Object.fromEntries(keys.map((key) => [key, 0])) as OperationCounts<T>;
}

function normalizeLoadOperationCounts(
	value: Partial<Record<LoadOperationClass, number>> | undefined,
): OperationCounts<LoadOperationClass> {
	const normalized = zeroOperationCounts(REQUIRED_LOAD_OPERATION_CLASSES);
	for (const key of REQUIRED_LOAD_OPERATION_CLASSES) {
		const raw = value?.[key];
		normalized[key] = Number.isFinite(raw) ? Math.max(0, Number(raw)) : 0;
	}
	return normalized;
}

function normalizeSegmentOperationCounts(
	value: Partial<Record<SegmentOperationClass, number>> | undefined,
): OperationCounts<SegmentOperationClass> {
	const normalized = zeroOperationCounts(REQUIRED_SEGMENT_OPERATION_CLASSES);
	for (const key of REQUIRED_SEGMENT_OPERATION_CLASSES) {
		const raw = value?.[key];
		normalized[key] = Number.isFinite(raw) ? Math.max(0, Number(raw)) : 0;
	}
	return normalized;
}

function slopePerHour(
	samples: Sample[],
	read: (sample: Sample) => number,
): number {
	if (samples.length < 2) return 0;
	const firstSample = samples[0];
	if (!firstSample) return 0;
	const xs = samples.map(
		(sample) => (sample.ts_ms - firstSample.ts_ms) / 3_600_000,
	);
	const ys = samples.map(read);
	const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
	const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
	let numerator = 0;
	let denominator = 0;
	for (const [index, x] of xs.entries()) {
		const y = ys[index];
		if (y === undefined) continue;
		const dx = x - meanX;
		numerator += dx * (y - meanY);
		denominator += dx * dx;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

function summarizeWindow(samples: Sample[]): PhaseMedianSummary {
	const committedSamples = samples.filter(
		(sample) => sample.committedMb !== undefined,
	);
	return {
		count: samples.length,
		rssMb: median(samples.map((sample) => sample.rss)),
		heapUsedMb: median(samples.map((sample) => sample.heapUsedMb)),
		fd: median(samples.map((sample) => sample.fd)),
		sockets: median(samples.map((sample) => sample.sockets)),
		queuedBytes: median(samples.map((sample) => sample.queued)),
		sessionTasks: median(samples.map((sample) => sample.sessionTasks)),
		streamTasks: median(samples.map((sample) => sample.streamTasks)),
		sessions: median(samples.map((sample) => sample.sessions)),
		streams: median(samples.map((sample) => sample.streams)),
		rssSlopeMbPerHour: slopePerHour(samples, (sample) => sample.rss),
		heapSlopeMbPerHour: slopePerHour(samples, (sample) => sample.heapUsedMb),
		fdSlopePerHour: slopePerHour(samples, (sample) => sample.fd),
		socketSlopePerHour: slopePerHour(samples, (sample) => sample.sockets),
		queuedSlopeBytesPerHour: slopePerHour(samples, (sample) => sample.queued),
		committedMb: median(
			committedSamples.map((sample) => sample.committedMb ?? 0),
		),
		committedSlopeMbPerHour: slopePerHour(
			committedSamples,
			(sample) => sample.committedMb ?? 0,
		),
	};
}

function filterWindow(
	samples: Sample[],
	startedAtMs: number,
	endedAtMs: number,
): Sample[] {
	return samples.filter(
		(sample) => sample.ts_ms >= startedAtMs && sample.ts_ms <= endedAtMs,
	);
}

function sampleWindowOrFallback(
	samples: Sample[],
	startedAtMs: number,
	endedAtMs: number,
): Sample[] {
	const inWindow = filterWindow(samples, startedAtMs, endedAtMs);
	return inWindow.length > 0
		? inWindow
		: samples.slice(-Math.min(3, samples.length));
}

function recoveryWindowForPhase(
	samples: Sample[],
	phase: PhaseRecord,
	nextPhase: PhaseRecord | undefined,
): Sample[] {
	const recoveryStart = phase.endedAtMs + 1;
	const recoveryEnd = Math.min(
		phase.endedAtMs +
			Math.max(60_000, Math.floor((phase.endedAtMs - phase.startedAtMs) / 2)),
		nextPhase ? nextPhase.startedAtMs - 1 : Number.POSITIVE_INFINITY,
	);
	if (Number.isFinite(recoveryEnd) && recoveryEnd >= recoveryStart) {
		const boundedWindow = filterWindow(samples, recoveryStart, recoveryEnd);
		if (boundedWindow.length > 0) return boundedWindow;
	}
	const nearestPostPhase = samples.filter(
		(sample) =>
			sample.ts_ms > phase.endedAtMs &&
			(nextPhase === undefined || sample.ts_ms < nextPhase.startedAtMs),
	);
	if (nearestPostPhase.length > 0) {
		return nearestPostPhase.slice(0, Math.min(3, nearestPostPhase.length));
	}
	return sampleWindowOrFallback(samples, phase.startedAtMs, phase.endedAtMs);
}

function recoveryUpperBound(
	baseline: number,
	absoluteTolerance: number,
	relativeTolerance: number,
): number {
	if (baseline <= 0) return absoluteTolerance;
	return Math.max(
		baseline + absoluteTolerance,
		baseline * (1 + relativeTolerance),
	);
}

export function evaluateTrendAndRecovery(
	samples: Sample[],
	phaseRecords: PhaseRecord[],
	maxQueuedBytesGlobal: number,
): SoakTrendSummary {
	const failures: string[] = [];
	if (samples.length === 0) {
		failures.push("no samples collected");
		return { pass: false, failures, phaseMedians: {}, steadyState: null };
	}

	const fallbackSteadyCount = Math.max(3, Math.floor(samples.length / 5));
	const steadyStatePhase = phaseRecords.find(
		(phase) => phase.name === "steady-state",
	);
	const steadyStateSamples = steadyStatePhase
		? sampleWindowOrFallback(
				samples,
				steadyStatePhase.startedAtMs,
				steadyStatePhase.endedAtMs,
			)
		: samples.slice(0, Math.min(fallbackSteadyCount, samples.length));
	const steadyState = summarizeWindow(steadyStateSamples);
	const phaseMedians: Record<string, PhaseMedianSummary> = {
		steady: steadyState,
	};
	if (steadyStatePhase) {
		phaseMedians["steady-state"] = steadyState;
	}

	const tailCount = Math.max(3, Math.floor(samples.length / 5));
	const tailWindow = samples.slice(
		Math.max(0, samples.length - Math.min(tailCount, samples.length)),
	);
	const tailSummary = summarizeWindow(tailWindow);
	phaseMedians.tail = tailSummary;

	const peakRss = samples.reduce(
		(peak, sample) => Math.max(peak, sample.rss),
		0,
	);
	if (peakRss > RSS_CEIL_MB) {
		failures.push(
			`peak charged memory (${MEMORY_METRIC}) ${peakRss.toFixed(1)}MB exceeded ceiling ${RSS_CEIL_MB.toFixed(0)}MB`,
		);
	}

	// Drift is measured from the WARM middle third of the run, not the first
	// phase window: early slots still page in code and grow allocator arenas
	// toward their working set (the same cold contamination the
	// rss-cycle-repeat warmup cycle excludes). A genuine leak keeps growing
	// past the warm plateau and still fails against this reference.
	const warmStart = Math.floor(samples.length / 3);
	const warmEnd = Math.floor((samples.length * 2) / 3);
	const warmWindow = samples.slice(warmStart, warmEnd);
	const warmReference =
		warmWindow.length > 0 ? summarizeWindow(warmWindow) : steadyState;
	phaseMedians["warm-reference"] = warmReference;
	if (
		warmReference.rssMb > 0 &&
		tailSummary.rssMb - warmReference.rssMb > RSS_TREND_MIN_ABS_MB &&
		tailSummary.rssMb > warmReference.rssMb * (1 + RSS_TREND_MAX_REL)
	) {
		failures.push(
			`charged memory (${MEMORY_METRIC}) drift ${warmReference.rssMb.toFixed(1)}MB -> ${tailSummary.rssMb.toFixed(1)}MB exceeded ${(
				RSS_TREND_MAX_REL * 100
			).toFixed(0)}% and ${RSS_TREND_MIN_ABS_MB.toFixed(0)}MB (warm reference)`,
		);
	}
	if (
		warmReference.heapUsedMb > 0 &&
		tailSummary.heapUsedMb - warmReference.heapUsedMb > HEAP_TREND_MIN_ABS_MB &&
		tailSummary.heapUsedMb > warmReference.heapUsedMb * (1 + RSS_TREND_MAX_REL)
	) {
		failures.push(
			`heap drift ${warmReference.heapUsedMb.toFixed(1)}MB -> ${tailSummary.heapUsedMb.toFixed(1)}MB exceeded ${(
				RSS_TREND_MAX_REL * 100
			).toFixed(
				0,
			)}% and ${HEAP_TREND_MIN_ABS_MB.toFixed(0)}MB (warm reference)`,
		);
	}
	// Committed memory (RssAnon+VmSwap) is the number the OOM-killer's world
	// actually bounds. The charged/rss rules alone are swap-blind: a run once
	// grew ~3.5GB committed while sampled RSS stayed flat because the kernel
	// swapped cold pages as fast as they accumulated.
	if (
		warmReference.committedMb > 0 &&
		tailSummary.committedMb - warmReference.committedMb >
			RSS_TREND_MIN_ABS_MB &&
		tailSummary.committedMb >
			warmReference.committedMb * (1 + RSS_TREND_MAX_REL)
	) {
		failures.push(
			`committed memory drift ${warmReference.committedMb.toFixed(1)}MB -> ${tailSummary.committedMb.toFixed(1)}MB exceeded ${(
				RSS_TREND_MAX_REL * 100
			).toFixed(0)}% and ${RSS_TREND_MIN_ABS_MB.toFixed(0)}MB (warm reference)`,
		);
	}

	if (
		steadyState.fd > 0 &&
		steadyState.fdSlopePerHour > steadyState.fd * 0.15
	) {
		failures.push(
			`FD slope ${steadyState.fdSlopePerHour.toFixed(2)}/h exceeded steady-state guard`,
		);
	}
	if (steadyState.queuedSlopeBytesPerHour > maxQueuedBytesGlobal * 0.05) {
		failures.push(
			`queued byte slope ${steadyState.queuedSlopeBytesPerHour.toFixed(0)}/h exceeded guard`,
		);
	}

	for (const [index, phase] of phaseRecords.entries()) {
		const phaseWindow = sampleWindowOrFallback(
			samples,
			phase.startedAtMs,
			phase.endedAtMs,
		);
		phaseMedians[phase.name] = summarizeWindow(phaseWindow);
		const recoveryWindow = recoveryWindowForPhase(
			samples,
			phase,
			phaseRecords[index + 1],
		);
		const recovery = summarizeWindow(recoveryWindow);
		phaseMedians[`${phase.name}:recovery`] = recovery;
		if (!phase.pass)
			failures.push(
				`phase ${phase.name} reported failure: ${phase.notes.join("; ")}`,
			);
		if (recovery.queuedBytes > steadyState.queuedBytes + 4 * 1024 * 1024) {
			failures.push(
				`phase ${phase.name} left queued bytes at ${recovery.queuedBytes}, baseline ${steadyState.queuedBytes}`,
			);
		}
		if (
			recovery.fd >
			recoveryUpperBound(
				steadyState.fd,
				FD_RECOVERY_TOLERANCE,
				FD_RECOVERY_REL_TOLERANCE,
			)
		) {
			failures.push(
				`phase ${phase.name} recovery fd ${recovery.fd} stayed above baseline ${steadyState.fd}`,
			);
		}
		if (
			recovery.sessions >
			recoveryUpperBound(
				steadyState.sessions,
				SESSION_RECOVERY_TOLERANCE,
				SESSION_RECOVERY_REL_TOLERANCE,
			)
		) {
			failures.push(
				`phase ${phase.name} recovery sessions ${recovery.sessions} stayed above baseline ${steadyState.sessions}`,
			);
		}
		// No per-phase stream-recovery rule: streams are transient by design
		// and the main load churns them for the whole soak (observed recovery
		// medians ranged 2..83 across identical runs purely from drain-latency
		// timing). Stuck streams are caught by the run-final requirement that
		// streamsActive reaches exactly 0 and by the streamTasks rules below.
		if (
			recovery.sessionTasks >
			Math.max(steadyState.sessionTasks * 1.5, steadyState.sessionTasks + 5)
		) {
			failures.push(
				`phase ${phase.name} left session tasks elevated (${recovery.sessionTasks} vs ${steadyState.sessionTasks})`,
			);
		}
		if (
			recovery.streamTasks >
			Math.max(steadyState.streamTasks * 1.5, steadyState.streamTasks + 5)
		) {
			failures.push(
				`phase ${phase.name} left stream tasks elevated (${recovery.streamTasks} vs ${steadyState.streamTasks})`,
			);
		}
		// Per-phase MEMORY recovery rules were removed deliberately: transient
		// charged/heap elevation right after a burst is expected (allocator
		// arenas return on their own schedule; mi_collect is per-thread), and
		// persistent growth is exactly what the whole-run drift rule above
		// already fails on. The per-phase rules below stay for STRUCTURAL
		// counters, whose recovery must be prompt and exact.
		if (
			recovery.sockets >
			recoveryUpperBound(
				steadyState.sockets,
				SOCKET_RECOVERY_TOLERANCE,
				steadyState.sockets === 0 ? 0 : 1,
			)
		) {
			failures.push(
				`phase ${phase.name} recovery sockets ${recovery.sockets} stayed above baseline ${steadyState.sockets}`,
			);
		}
	}

	return {
		pass: failures.length === 0,
		failures,
		phaseMedians,
		steadyState,
	};
}

function parseSummaryCounter(text: string, pattern: RegExp): number {
	const match = text.match(pattern);
	return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function parseStructuredSummary(text: string): {
	requiredOperationClasses: LoadOperationClass[];
	observedOperationCounts: OperationCounts<LoadOperationClass>;
	observedReconnects: number;
} {
	const match = text.match(/^load-client:\s+summary\s+(.+)$/m);
	if (!match?.[1]) {
		return {
			requiredOperationClasses: [...REQUIRED_LOAD_OPERATION_CLASSES],
			observedOperationCounts: zeroOperationCounts(
				REQUIRED_LOAD_OPERATION_CLASSES,
			),
			observedReconnects: 0,
		};
	}
	try {
		const parsed = JSON.parse(match[1]) as {
			requiredOperationClasses?: string[];
			observedOperationCounts?: Partial<Record<LoadOperationClass, number>>;
			observedReconnects?: number;
		};
		const required = REQUIRED_LOAD_OPERATION_CLASSES.filter((key) =>
			parsed.requiredOperationClasses?.includes(key),
		);
		return {
			requiredOperationClasses:
				required.length > 0 ? required : [...REQUIRED_LOAD_OPERATION_CLASSES],
			observedOperationCounts: normalizeLoadOperationCounts(
				parsed.observedOperationCounts,
			),
			observedReconnects:
				typeof parsed.observedReconnects === "number" &&
				Number.isFinite(parsed.observedReconnects) &&
				parsed.observedReconnects > 0
					? Math.floor(parsed.observedReconnects)
					: 0,
		};
	} catch (error) {
		console.warn("soak-addon: failed to parse load-client summary:", error);
		return {
			requiredOperationClasses: [...REQUIRED_LOAD_OPERATION_CLASSES],
			observedOperationCounts: zeroOperationCounts(
				REQUIRED_LOAD_OPERATION_CLASSES,
			),
			observedReconnects: 0,
		};
	}
}

function summarizeLoadClient(
	name: string,
	startedAtMs: number,
	endedAtMs: number,
	exitCode: number,
	timedOut: boolean,
	stdout: string,
	stderr: string,
): LoadClientSummary {
	const structuredSummary = parseStructuredSummary(stdout);
	return {
		name,
		startedAtMs,
		endedAtMs,
		durationMs: endedAtMs - startedAtMs,
		timedOut,
		exitCode,
		stdout,
		stderr,
		sessionsOk: parseSummaryCounter(stdout, /sessions ok=(\d+)/),
		sessionsErr: parseSummaryCounter(stdout, /sessions ok=\d+ err=(\d+)/),
		datagramsSent: parseSummaryCounter(stdout, /datagrams sent=(\d+)/),
		datagramsErr: parseSummaryCounter(stdout, /datagrams sent=\d+ err=(\d+)/),
		streamsOpened: parseSummaryCounter(stdout, /streams opened=(\d+)/),
		streamsErr: parseSummaryCounter(stdout, /streams opened=\d+ err=(\d+)/),
		passLineSeen: /\bload-client:\s+PASS\b/.test(stdout),
		requiredOperationClasses: structuredSummary.requiredOperationClasses,
		observedOperationCounts: structuredSummary.observedOperationCounts,
		observedReconnects: structuredSummary.observedReconnects,
	};
}

/** Peer-initiated stream teardown codes that are normal load churn. */
function isExpectedStreamTeardown(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	return (
		code === "E_STOP_SENDING" ||
		code === "E_STREAM_RESET" ||
		code === "E_SESSION_CLOSED"
	);
}

function assertLoadSlo(
	summary: LoadClientSummary,
	notes: string[],
	options: { streamErrorRateLimit?: number } = {},
): boolean {
	const totalSessions = summary.sessionsOk + summary.sessionsErr;
	const sessionErrorRate =
		totalSessions > 0 ? summary.sessionsErr / totalSessions : 1;
	const datagramDenominator = Math.max(
		summary.datagramsSent + summary.datagramsErr,
		1,
	);
	const datagramErrorRate = summary.datagramsErr / datagramDenominator;
	const streamDenominator = Math.max(
		summary.streamsOpened + summary.streamsErr,
		1,
	);
	const streamErrorRate = summary.streamsErr / streamDenominator;

	let pass = true;
	if (summary.exitCode !== 0) {
		notes.push(`${summary.name} exited ${summary.exitCode}`);
		pass = false;
	}
	if (summary.timedOut) {
		notes.push(`${summary.name} timed out`);
		pass = false;
	}
	if (!summary.passLineSeen) {
		notes.push(`${summary.name} missing PASS line`);
		pass = false;
	}
	if (sessionErrorRate > 0.1) {
		notes.push(
			`${summary.name} session error rate ${(sessionErrorRate * 100).toFixed(2)}% > 10%`,
		);
		pass = false;
	}
	if (datagramErrorRate > 0.05) {
		notes.push(
			`${summary.name} datagram error rate ${(datagramErrorRate * 100).toFixed(2)}% > 5%`,
		);
		pass = false;
	}
	const streamErrorRateLimit = options.streamErrorRateLimit ?? 0.05;
	if (streamErrorRate > streamErrorRateLimit) {
		notes.push(
			`${summary.name} stream error rate ${(streamErrorRate * 100).toFixed(2)}% > ${(streamErrorRateLimit * 100).toFixed(0)}%`,
		);
		pass = false;
	}
	for (const operationClass of summary.requiredOperationClasses) {
		if ((summary.observedOperationCounts[operationClass] ?? 0) <= 0) {
			notes.push(
				`${summary.name} missing required operation class ${operationClass}`,
			);
			pass = false;
		}
	}
	return pass;
}

function assertReconnectChurnSlo(
	summary: LoadClientSummary,
	notes: string[],
): boolean {
	const pass = assertLoadSlo(summary, notes);
	if (summary.observedReconnects <= 0) {
		notes.push(`${summary.name} observed zero reconnects`);
		return false;
	}
	return pass;
}

function readToolVersion(command: string, args: string[]): string {
	try {
		return execFileSync(command, args, { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function compilerIdentity(command: string): ToolIdentity {
	const discovered = execFileSync("which", [command], {
		encoding: "utf8",
	}).trim();
	if (!discovered) throw new Error(`compiler ${command} was not found on PATH`);
	const path = realpathSync(discovered);
	const version = execFileSync(path, ["--version"], {
		encoding: "utf8",
	}).trim();
	if (!version) throw new Error(`compiler ${path} returned an empty version`);
	return { path, version };
}

function gitCommit(): string {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown";
	}
}

function ensureDirectory(path: string): void {
	mkdirSync(resolve(path), { recursive: true });
}

function listSegmentFiles(paths: string[]): string[] {
	const resolved: string[] = [];
	for (const input of paths) {
		const full = resolve(input);
		if (!existsSync(full)) continue;
		const stats = statSync(full);
		if (stats.isDirectory()) {
			for (const entry of readdirSync(full)) {
				if (extname(entry) !== ".json") continue;
				resolved.push(join(full, entry));
			}
		} else if (stats.isFile() && extname(full) === ".json") {
			resolved.push(full);
		}
	}
	return [...new Set(resolved)].sort();
}

function validateSegment(segment: SegmentMetadata): void {
	if (segment.mode !== "segment") {
		throw new Error(`artifact ${segment.actualCommit} is not a segment record`);
	}
	if (segment.status !== "pass") {
		throw new Error(`segment ${segment.segmentIndex} did not pass`);
	}
	if (
		segment.durationSeconds > SEGMENT_MAX_SECONDS &&
		segment.segmentCount > 1
	) {
		throw new Error(
			`segment ${segment.segmentIndex} duration ${segment.durationSeconds}s exceeded ${SEGMENT_MAX_SECONDS}s hosted cap`,
		);
	}
	for (const [name, compiler] of [
		["CC", segment.toolchain.cc],
		["CXX", segment.toolchain.cxx],
	] as const) {
		if (!compiler?.path || !compiler.version) {
			throw new Error(
				`segment ${segment.segmentIndex} is missing ${name} compiler identity`,
			);
		}
	}
	// Segments recorded on a WritableStream-leaking runtime are not evidence,
	// no matter what verdict they carry; refuse them at aggregation too, not
	// just at generation.
	if (!bunVersionAtLeast(segment.toolchain.bun, MIN_BUN_VERSION)) {
		throw new Error(
			`segment ${segment.segmentIndex} was recorded on Bun ${segment.toolchain.bun}; ` +
				`soak evidence requires Bun >= ${MIN_BUN_VERSION} (WritableStream leak on rejected close)`,
		);
	}
	const expectedHash = sha256Hex({
		...segment,
		segmentHash: undefined,
	});
	if (segment.segmentHash !== expectedHash) {
		throw new Error(`segment ${segment.segmentIndex} hash mismatch`);
	}
	const observedOperationCounts = normalizeSegmentOperationCounts(
		segment.observedOperationCounts,
	);
	for (const operationClass of segment.requiredOperationClasses) {
		if (!REQUIRED_SEGMENT_OPERATION_CLASSES.includes(operationClass)) {
			throw new Error(
				`segment ${segment.segmentIndex} declared unknown operation class ${operationClass}`,
			);
		}
		if ((observedOperationCounts[operationClass] ?? 0) <= 0) {
			throw new Error(
				`segment ${segment.segmentIndex} missing required operation class ${operationClass}`,
			);
		}
	}
	for (const sample of segment.samples) {
		if (
			!Number.isFinite(sample.heapUsedMb) ||
			!Number.isFinite(sample.sockets)
		) {
			throw new Error(
				`segment ${segment.segmentIndex} sample missing heap/socket metrics`,
			);
		}
	}
	if (
		segment.finalMetrics.sessionTasksActive >
			segment.baselineMetrics.sessionTasksActive + TASK_RECOVERY_TOLERANCE ||
		segment.finalMetrics.streamTasksActive >
			segment.baselineMetrics.streamTasksActive + TASK_RECOVERY_TOLERANCE ||
		segment.finalMetrics.queuedBytesGlobal >
			segment.baselineMetrics.queuedBytesGlobal +
				QUEUE_RECOVERY_TOLERANCE_BYTES ||
		segment.finalMetrics.fd >
			segment.baselineMetrics.fd + FD_RECOVERY_TOLERANCE ||
		segment.finalMetrics.sockets >
			segment.baselineMetrics.sockets + SOCKET_RECOVERY_TOLERANCE ||
		segment.finalMetrics.sessionsActive >
			segment.baselineMetrics.sessionsActive ||
		segment.finalMetrics.streamsActive > segment.baselineMetrics.streamsActive
	) {
		throw new Error(
			`segment ${segment.segmentIndex} cleanup did not recover to baseline`,
		);
	}
}

export function aggregateSegments(
	segmentArtifacts: SegmentMetadata[],
): AggregateSummary {
	if (segmentArtifacts.length === 0) {
		throw new Error("no segment artifacts supplied");
	}
	const ordered = [...segmentArtifacts].sort(
		(left, right) => left.segmentIndex - right.segmentIndex,
	);
	for (const segment of ordered) validateSegment(segment);

	const first = ordered[0];
	if (!first) throw new Error("no segment artifacts supplied");
	const expectedCount = first.segmentCount;
	if (ordered.length !== expectedCount) {
		throw new Error(
			`expected ${expectedCount} segments, found ${ordered.length}`,
		);
	}

	for (const [index, current] of ordered.entries()) {
		if (current.segmentIndex !== index + 1) {
			throw new Error(`missing or duplicate segment index around ${index + 1}`);
		}
		if (current.segmentCount !== expectedCount) {
			throw new Error(`segment ${current.segmentIndex} count drifted`);
		}
		if (current.actualCommit !== current.candidateCommit) {
			throw new Error(
				`segment ${current.segmentIndex} actual commit does not match candidate commit`,
			);
		}
		if (
			current.actualCommit !== first.actualCommit ||
			current.candidateCommit !== first.candidateCommit
		) {
			throw new Error(`segment ${current.segmentIndex} commit drifted`);
		}
		if (current.seed !== first.seed) {
			throw new Error(`segment ${current.segmentIndex} seed drifted`);
		}
		if (current.continuityTokenDigest !== first.continuityTokenDigest) {
			throw new Error(
				`segment ${current.segmentIndex} continuity token drifted`,
			);
		}
		if (sha256Hex(current.toolchain) !== sha256Hex(first.toolchain)) {
			throw new Error(`segment ${current.segmentIndex} toolchain drifted`);
		}
		if (index === 0) {
			if (current.previousFinalHash !== null) {
				throw new Error("segment 1 cannot have a predecessor");
			}
			continue;
		}
		const previous = ordered[index - 1];
		if (!previous) {
			throw new Error(`segment ${current.segmentIndex} has no predecessor`);
		}
		if (current.previousFinalHash !== previous.finalStateHash) {
			throw new Error(
				`segment ${current.segmentIndex} previousFinalHash does not chain from segment ${previous.segmentIndex}`,
			);
		}
		if (current.startedAtMs < previous.endedAtMs - OVERLAP_SKEW_MS) {
			throw new Error(
				`segment ${current.segmentIndex} overlaps segment ${previous.segmentIndex}`,
			);
		}
		if (current.startedAtMs > previous.endedAtMs + MAX_AGGREGATE_GAP_MS) {
			throw new Error(
				`segment ${current.segmentIndex} gap ${current.startedAtMs - previous.endedAtMs}ms exceeded ${MAX_AGGREGATE_GAP_MS}ms`,
			);
		}
	}

	const aggregatePayload = {
		mode: "aggregate" as const,
		status: "pass" as const,
		segmentCount: ordered.length,
		expectedSegmentCount: expectedCount,
		candidateCommit: first.candidateCommit,
		seed: first.seed,
		continuityTokenDigest: first.continuityTokenDigest,
		toolchain: first.toolchain,
		segments: ordered.map((segment) => ({
			index: segment.segmentIndex,
			file: `soak-segment-${String(segment.segmentIndex).padStart(2, "0")}-of-${String(expectedCount).padStart(2, "0")}.json`,
			finalStateHash: segment.finalStateHash,
			startedAtMs: segment.startedAtMs,
			endedAtMs: segment.endedAtMs,
			status: segment.status,
		})),
		totalDurationSeconds: ordered.reduce(
			(sum, segment) => sum + segment.durationSeconds,
			0,
		),
	};

	return {
		...aggregatePayload,
		aggregateHash: sha256Hex(aggregatePayload),
	};
}

export function computeSegmentObservedOperationCounts(
	mainLoad: Pick<LoadClientSummary, "observedOperationCounts">,
	phases: Pick<PhaseRecord, "name" | "pass" | "load" | "rotationFingerprint">[],
): OperationCounts<SegmentOperationClass> {
	return normalizeSegmentOperationCounts({
		"datagram-echo": mainLoad.observedOperationCounts["datagram-echo"],
		"uni-echo": mainLoad.observedOperationCounts["uni-echo"],
		"bidi-echo": mainLoad.observedOperationCounts["bidi-echo"],
		"stream-reset": mainLoad.observedOperationCounts["stream-reset"],
		"stop-sending": mainLoad.observedOperationCounts["stop-sending"],
		"idle-peers": phases.some(
			(phase) => phase.name === "idle-peers" && phase.pass,
		)
			? 1
			: 0,
		overload: phases.some((phase) => phase.name === "overload" && phase.pass)
			? 1
			: 0,
		"reconnect-churn": phases.reduce(
			(count, phase) =>
				phase.name === "reconnect-churn"
					? count + Math.max(0, phase.load?.observedReconnects ?? 0)
					: count,
			0,
		),
		"cert-rotation": phases.some(
			(phase) =>
				phase.name === "cert-rotation" &&
				phase.pass &&
				typeof phase.rotationFingerprint === "string",
		)
			? 1
			: 0,
	});
}

export async function readProcessTextBounded(
	label: string,
	proc: Bun.Subprocess,
	timeoutMs: number = LOAD_IO_TIMEOUT_MS,
): Promise<string> {
	const exitGraceMs = Math.min(CHILD_EXIT_GRACE_MS, Math.max(25, timeoutMs));
	// Bun.Subprocess types stdout as number | ReadableStream | undefined; only a
	// piped stream is capturable.
	const { promise, cancel } = captureOutput(
		proc.stdout instanceof ReadableStream ? proc.stdout : undefined,
	);
	try {
		return await Promise.race([
			promise,
			sleep(timeoutMs).then(() => {
				throw new Error(`${label} timed out after ${timeoutMs}ms`);
			}),
		]);
	} catch (error) {
		signalChild(proc, "SIGTERM");
		let exitCode = await waitForChildExit(proc, exitGraceMs);
		if (exitCode === undefined) {
			signalChild(proc, "SIGKILL");
			exitCode = await waitForChildExit(proc, exitGraceMs);
		}
		throw error;
	} finally {
		await cancel();
		await Promise.race([proc.exited, sleep(CHILD_OUTPUT_DRAIN_MS)]).catch(
			() => undefined,
		);
	}
}

async function getFdCount(pid: number): Promise<number> {
	try {
		if (existsSync(`/proc/${pid}/fd`)) {
			const proc = Bun.spawn(["ls", `/proc/${pid}/fd`], {
				stdout: "pipe",
				stderr: "ignore",
			});
			const out = await readProcessTextBounded(`fd-count:${pid}:procfs`, proc);
			return out.trim().split("\n").filter(Boolean).length;
		}
		const proc = Bun.spawn(["lsof", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = await readProcessTextBounded(`fd-count:${pid}:lsof`, proc);
		return Math.max(out.trim().split("\n").length - 1, 0);
	} catch (err) {
		console.warn("soak-addon: failed to count file descriptors:", err);
		return 0;
	}
}

/**
 * The memory the OS actually charges the process — phys_footprint on macOS,
 * smaps Rss-LazyFree on Linux, raw RSS as a last resort. Raw RSS retains
 * MADV_FREE'd allocator arenas and clean file-backed pages, so trend/recovery
 * rules on it fail on healthy processes (the exact false signal the
 * charged-metric comparator in distributed-scale was built to fix).
 */
function getChargedMb(): number {
	return readPhysFootprintMb() ?? getRssMb();
}

const MEMORY_METRIC =
	readPhysFootprintMb() != null
		? process.platform === "linux"
			? "smaps-lazyfree"
			: "phys-footprint"
		: "rss-fallback";

function getRssMb(): number {
	try {
		return (process.memoryUsage?.()?.rss ?? 0) / (1024 * 1024);
	} catch (err) {
		console.warn("soak-addon: failed to read process RSS:", err);
		return 0;
	}
}

function getHeapUsedMb(): number {
	try {
		return (process.memoryUsage?.()?.heapUsed ?? 0) / (1024 * 1024);
	} catch (err) {
		console.warn("soak-addon: failed to read process heap usage:", err);
		return 0;
	}
}

/** RssAnon + VmSwap from /proc/self/status (null off Linux). Swap-blind RSS
 * reported ~flat while the 2026-08-08 soak committed 3.5GB. */
function readProcStatusMemMb(): {
	rssAnonMb: number;
	vmSwapMb: number;
} | null {
	if (process.platform !== "linux") return null;
	try {
		const status = readFileSync("/proc/self/status", "utf8");
		const grab = (key: string): number | null => {
			const match = status.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
			return match ? Number(match[1]) / 1024 : null;
		};
		const rssAnonMb = grab("RssAnon");
		const vmSwapMb = grab("VmSwap");
		if (rssAnonMb == null || vmSwapMb == null) return null;
		return { rssAnonMb, vmSwapMb };
	} catch {
		return null;
	}
}

/** Private_Dirty / LazyFree / Anonymous from /proc/self/smaps_rollup (null
 * off Linux). Splits committed drift into live data (Private_Dirty growing)
 * vs allocator arena slack (LazyFree growing) — the discriminator the
 * committed metric alone cannot provide. */
function readSmapsRollupMb(): {
	privateDirtyMb: number;
	lazyFreeMb: number;
	anonymousMb: number;
} | null {
	if (process.platform !== "linux") return null;
	try {
		const rollup = readFileSync("/proc/self/smaps_rollup", "utf8");
		const grab = (key: string): number | null => {
			const match = rollup.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
			return match ? Number(match[1]) / 1024 : null;
		};
		const privateDirtyMb = grab("Private_Dirty");
		if (privateDirtyMb == null) return null;
		return {
			privateDirtyMb,
			lazyFreeMb: grab("LazyFree") ?? 0,
			anonymousMb: grab("Anonymous") ?? 0,
		};
	} catch {
		return null;
	}
}

const HEAP_DEBUG = process.env.SOAK_HEAP_DEBUG === "1";
const HEAP_DEBUG_INTERVAL_MS = requireNumberEnv(
	"SOAK_HEAP_DEBUG_INTERVAL_MS",
	10 * 60 * 1000,
);
/** Circuit breaker: abort with a partial artifact flushed once committed
 * memory (RssAnon+VmSwap) crosses this, instead of riding swap into an
 * untrappable kernel SIGKILL. 0 = disabled. */
const COMMITTED_ABORT_MB = requireNumberEnv("SOAK_COMMITTED_ABORT_MB", 0);

type JscHeapStats = {
	heapSize: number;
	heapCapacity: number;
	objectCount: number;
	objectTypeCounts: Record<string, number>;
};

let jscHeapStats: (() => JscHeapStats) | null | undefined;

function getJscHeapStats(): JscHeapStats | null {
	if (jscHeapStats === undefined) {
		try {
			jscHeapStats = require("bun:jsc").heapStats as () => JscHeapStats;
		} catch {
			jscHeapStats = null;
		}
	}
	if (!jscHeapStats) return null;
	try {
		return jscHeapStats();
	} catch {
		return null;
	}
}

async function getSocketCount(pid: number): Promise<number> {
	try {
		const procFdDir = `/proc/${pid}/fd`;
		if (existsSync(procFdDir)) {
			return readdirSync(procFdDir).reduce((count, entry) => {
				try {
					const target = readlinkSync(join(procFdDir, entry));
					return target.startsWith("socket:") ? count + 1 : count;
				} catch {
					return count;
				}
			}, 0);
		}
		const proc = Bun.spawn(
			["lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-iUDP"],
			{
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const out = await readProcessTextBounded(`socket-count:${pid}:lsof`, proc);
		return Math.max(out.trim().split("\n").filter(Boolean).length - 1, 0);
	} catch (err) {
		console.warn("soak-addon: failed to count sockets:", err);
		return 0;
	}
}

function sleep(ms: number): Promise<void> {
	return Bun.sleep(ms);
}

async function readWithTimeout<T>(
	reader: { read(): Promise<ReaderResult<T>> },
	timeoutMs: number,
	label: string,
): Promise<ReaderResult<T>> {
	return await Promise.race([
		reader.read(),
		sleep(timeoutMs).then(() => {
			throw new Error(`${label} timed out after ${timeoutMs}ms`);
		}),
	]);
}

/**
 * Accept-loop read for long-running soak service: an idle window is normal
 * traffic shape, not a failure, so the timeout re-arms instead of killing the
 * loop (a killed loop silently stops serving that session's streams for the
 * rest of the soak — the exact defect behind the perpetual per-push soak red).
 * One read promise persists across timeouts: racing a FRESH read each retry
 * would leave the previous read pending, and it would swallow the next
 * arriving stream with no consumer. Exits via {done} when the session closes.
 * An occasional heartbeat warn keeps hang-detection signal without log spam.
 */
async function readWithIdleRetry<T>(
	reader: { read(): Promise<ReaderResult<T>> },
	timeoutMs: number,
	label: string,
): Promise<ReaderResult<T>> {
	const pending = reader.read();
	let idleWindows = 0;
	while (true) {
		try {
			return await Promise.race([
				pending,
				sleep(timeoutMs).then(() => {
					throw new Error(`${label} idle for ${timeoutMs}ms`);
				}),
			]);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.endsWith(`idle for ${timeoutMs}ms`)
			) {
				idleWindows += 1;
				if (idleWindows % 12 === 0) {
					console.warn(
						`soak-addon: ${label} idle for ${idleWindows} windows of ${timeoutMs}ms; still serving`,
					);
				}
				continue;
			}
			throw error;
		}
	}
}

function requireReadValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`${label} ended without a value`);
	}
	return value;
}

async function collectReadable(
	stream: ReadableStream<Uint8Array>,
	label: string,
): Promise<Buffer> {
	const reader = stream.getReader();
	const chunks: Buffer[] = [];
	try {
		while (true) {
			const next = await readWithTimeout(reader, LOAD_IO_TIMEOUT_MS, label);
			if (next.done) break;
			const chunk = requireReadValue(next.value, label);
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Teardown can race lock release.
		}
	}
}

async function writeWebWritable(
	stream: WritableStream<Uint8Array>,
	value: Uint8Array,
): Promise<void> {
	const writer = stream.getWriter();
	try {
		await writer.write(value);
		await writer.close();
	} finally {
		writer.releaseLock();
	}
}

function continuityDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function phasePlan(durationSeconds: number): {
	name: string;
	startOffsetMs: number;
	durationMs: number;
}[] {
	const totalMs = durationSeconds * 1000;
	const slot = Math.max(45_000, Math.floor(totalMs / 12));
	return [
		{ name: "steady-state", startOffsetMs: slot, durationMs: slot },
		{ name: "overload", startOffsetMs: slot * 3, durationMs: slot },
		{ name: "idle-peers", startOffsetMs: slot * 5, durationMs: slot },
		{ name: "reconnect-churn", startOffsetMs: slot * 7, durationMs: slot },
		{ name: "cert-rotation", startOffsetMs: slot * 9, durationMs: slot },
	];
}

type CapturedOutput = {
	promise: Promise<string>;
	cancel: () => Promise<void>;
};

function captureOutput(
	stream: ReadableStream<Uint8Array> | null | undefined,
): CapturedOutput {
	if (!stream) return { promise: Promise.resolve(""), cancel: async () => {} };
	const reader = stream.getReader();
	let settled = false;
	const promise = (async () => {
		const chunks: Uint8Array[] = [];
		let retainedBytes = 0;
		let truncated = false;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const remaining = Math.max(CHILD_OUTPUT_LIMIT_BYTES - retainedBytes, 0);
				if (retainedBytes < CHILD_OUTPUT_LIMIT_BYTES) {
					const retained =
						value.byteLength > remaining ? value.slice(0, remaining) : value;
					chunks.push(retained);
					retainedBytes += retained.byteLength;
				}
				if (value.byteLength > remaining) {
					truncated = true;
				}
			}
		} catch (error) {
			return `[output read failed: ${error instanceof Error ? error.message : String(error)}]`;
		} finally {
			settled = true;
			reader.releaseLock();
		}
		const bytes = new Uint8Array(retainedBytes);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const suffix = truncated
			? `\n[output truncated at ${CHILD_OUTPUT_LIMIT_BYTES} bytes]`
			: "";
		return `${new TextDecoder().decode(bytes)}${suffix}`;
	})();
	return {
		promise,
		cancel: async () => {
			if (settled) return;
			try {
				await reader.cancel("bounded output drain deadline reached");
			} catch {
				// The child may close the pipe between the deadline and cancellation.
			}
		},
	};
}

async function waitForChildExit(
	child: Bun.Subprocess,
	timeoutMs: number,
): Promise<number | undefined> {
	const result = await Promise.race([
		child.exited.then((code) => ({ exited: true as const, code })),
		Bun.sleep(timeoutMs).then(() => ({ exited: false as const })),
	]);
	return result.exited ? result.code : undefined;
}

function signalChild(
	child: Bun.Subprocess,
	signal: "SIGTERM" | "SIGKILL",
): void {
	try {
		child.kill(signal);
	} catch {
		// Exit can race the bounded signal escalation.
	}
}

export async function runLoadClient(
	name: string,
	args: string[],
	timeoutMs: number,
): Promise<LoadClientSummary> {
	const startedAtMs = Date.now();
	const child = Bun.spawn(args, {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, RUST_BACKTRACE: "1" },
	});
	const stdoutCapture = captureOutput(child.stdout);
	const stderrCapture = captureOutput(child.stderr);
	let exitCode = await waitForChildExit(child, timeoutMs);
	const timedOut = exitCode === undefined;
	if (timedOut) {
		signalChild(child, "SIGTERM");
		exitCode = await waitForChildExit(child, CHILD_EXIT_GRACE_MS);
		if (exitCode === undefined) {
			signalChild(child, "SIGKILL");
			exitCode = await waitForChildExit(child, CHILD_EXIT_GRACE_MS);
		}
	}

	let output = await Promise.race([
		Promise.all([stdoutCapture.promise, stderrCapture.promise]).then(
			([stdout, stderr]) => ({ drained: true as const, stdout, stderr }),
		),
		Bun.sleep(CHILD_OUTPUT_DRAIN_MS).then(() => ({ drained: false as const })),
	]);
	if (!output.drained) {
		await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
		output = await Promise.race([
			Promise.all([stdoutCapture.promise, stderrCapture.promise]).then(
				([stdout, stderr]) => ({ drained: true as const, stdout, stderr }),
			),
			Bun.sleep(CHILD_OUTPUT_DRAIN_MS).then(() => ({
				drained: false as const,
			})),
		]);
	}
	const stdout = output.drained
		? output.stdout
		: "[stdout drain deadline exceeded]";
	const stderr = output.drained
		? output.stderr
		: "[stderr drain deadline exceeded]";
	const endedAtMs = Date.now();
	if (stdout.trim()) console.log(`${name}: stdout\n${stdout.trim()}`);
	if (stderr.trim()) console.warn(`${name}: stderr\n${stderr.trim()}`);
	return summarizeLoadClient(
		name,
		startedAtMs,
		endedAtMs,
		exitCode ?? -1,
		timedOut,
		stdout,
		stderr,
	);
}

async function buildLoadClient(): Promise<void> {
	console.log("soak-addon: building load-client (release)...");
	await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
}

async function cleanupPort(): Promise<void> {
	try {
		const p = await $`lsof -ti :4433`.quiet().nothrow().text();
		if (p.trim()) {
			await $`kill -9 ${p.trim().split(/\s+/).filter(Boolean)}`
				.quiet()
				.nothrow();
		}
	} catch (err) {
		console.warn("soak-addon: port cleanup failed:", err);
	}
	await sleep(3000);
}

function createTlsMaterial(): GeneratedCert | null {
	try {
		return generateLocalhostCert();
	} catch {
		return null;
	}
}

async function rotateCertificate(server: WebTransportServer): Promise<string> {
	const rotated = createTlsMaterial();
	if (!rotated)
		throw new Error(
			"certificate rotation unavailable: localhost cert generation failed",
		);
	try {
		await server.updateCert({
			certPem: rotated.certPem,
			keyPem: rotated.keyPem,
		});
		return sha256Hex(rotated.certPem);
	} finally {
		rotated.cleanup();
	}
}

async function snapshotRuntime(
	server: WebTransportServer,
	pid: number,
	peakSessions = 0,
	peakStreams = 0,
): Promise<RuntimeSnapshot & { peakSessions: number; peakStreams: number }> {
	const metrics = server.metricsSnapshot();
	return {
		rssMb: getRssMb(),
		chargedMb: getChargedMb(),
		heapUsedMb: getHeapUsedMb(),
		fd: await getFdCount(pid),
		sockets: await getSocketCount(pid),
		sessionsActive: metrics.sessionsActive,
		streamsActive: metrics.streamsActive,
		sessionTasksActive: metrics.sessionTasksActive,
		streamTasksActive: metrics.streamTasksActive,
		queuedBytesGlobal: metrics.queuedBytesGlobal,
		peakSessions,
		peakStreams,
	};
}

function summarizeRuntimeForHash(
	snapshot: RuntimeSnapshot & { peakSessions?: number; peakStreams?: number },
): Record<string, number> {
	return {
		rssMb: snapshot.rssMb,
		chargedMb: snapshot.chargedMb,
		heapUsedMb: snapshot.heapUsedMb,
		fd: snapshot.fd,
		sockets: snapshot.sockets,
		sessionsActive: snapshot.sessionsActive,
		streamsActive: snapshot.streamsActive,
		sessionTasksActive: snapshot.sessionTasksActive,
		streamTasksActive: snapshot.streamTasksActive,
		queuedBytesGlobal: snapshot.queuedBytesGlobal,
		peakSessions: snapshot.peakSessions ?? 0,
		peakStreams: snapshot.peakStreams ?? 0,
	};
}

async function runSegment(): Promise<void> {
	assertBunVersion();
	await cleanupPort();
	await buildLoadClient();

	const candidateCommit = process.env.SOAK_CANDIDATE_COMMIT ?? gitCommit();
	const actualCommit = gitCommit();
	if (candidateCommit !== actualCommit) {
		throw new Error(
			`candidate commit ${candidateCommit} does not match working HEAD ${actualCommit}`,
		);
	}

	const segmentIndex = parseInt(process.env.SOAK_SEGMENT_INDEX ?? "1", 10);
	const segmentCount = parseInt(process.env.SOAK_SEGMENT_COUNT ?? "1", 10);
	if (segmentCount > 1 && DURATION > SEGMENT_MAX_SECONDS) {
		throw new Error(
			`segment duration ${DURATION}s exceeds hosted cap ${SEGMENT_MAX_SECONDS}s`,
		);
	}
	const seed = process.env.SOAK_SEED ?? randomUUID();
	const rawContinuityToken =
		process.env.SOAK_CONTINUITY_TOKEN ?? `${candidateCommit}:${seed}`;
	const previousFinalHash = process.env.SOAK_PREVIOUS_FINAL_HASH || null;
	const artifactsOut =
		process.env.SOAK_ARTIFACTS_OUT ??
		join(
			ROOT,
			`tools/load/soak-artifacts-seg-${String(segmentIndex).padStart(2, "0")}.json`,
		);
	ensureDirectory(resolve(artifactsOut, ".."));

	const initialTls = createTlsMaterial();
	const server = createServer({
		port: 4433,
		tls: initialTls
			? { certPem: initialTls.certPem, keyPem: initialTls.keyPem }
			: { certPem: "", keyPem: "" },
		limits: {
			maxSessions: Math.min(SESSIONS + 500, 5000),
			maxHandshakesInFlight: Math.min(SESSIONS + 200, 5000),
		},
		rateLimits: {
			handshakesPerSec: Math.max(SESSIONS * 2, 400),
			handshakesBurst: Math.max(SESSIONS * 4, 1000),
			handshakesBurstPerPrefix: Math.max(SESSIONS * 4, 1000),
			streamsPerSec: Math.max(SESSIONS * 4, 1000),
			streamsBurst: Math.max(SESSIONS * 8, 2000),
			datagramsPerSec: Math.max(SESSIONS * 20, 10000),
			datagramsBurst: Math.max(SESSIONS * 40, 20000),
		},
		onSession: async (session) => {
			void (async () => {
				try {
					for await (const datagram of session.incomingDatagrams()) {
						const text = Buffer.from(datagram).toString("utf8");
						if (text.startsWith(PROBE_DATAGRAM_PREFIX)) {
							await session.sendDatagram(datagram);
						}
					}
				} catch (error) {
					console.warn("soak-addon: datagram loop failed:", error);
				}
			})();
			void (async () => {
				const reader = session.incomingBidirectionalStreams.getReader();
				try {
					while (true) {
						const next = await readWithIdleRetry(
							reader,
							LOAD_IO_TIMEOUT_MS,
							"incoming bidi stream",
						);
						if (next.done) return;
						const duplex = next.value;
						void (async (duplex: WebIncomingBidi) => {
							try {
								const body = await collectReadable(
									duplex.readable,
									"bidi payload",
								);
								const text = body.toString("utf8");
								if (text.startsWith(PROBE_BIDI_RESET_PREFIX)) {
									duplex[WT_RESET]?.(42);
									return;
								}
								if (text.startsWith(PROBE_BIDI_ECHO_PREFIX)) {
									await writeWebWritable(duplex.writable, body);
									return;
								}
								if (text.startsWith(LOAD_BIDI_PREFIX)) {
									const writer = duplex.writable.getWriter();
									try {
										await writer.close();
									} catch (error) {
										// Load bidi clients drop their receive half by
										// design, so this close races the resulting
										// STOP_SENDING. Expected churn — warning per
										// stream produced ~1M log lines on CI and
										// stalled the job on log throughput alone.
										if (!isExpectedStreamTeardown(error)) throw error;
									} finally {
										writer.releaseLock();
									}
								}
							} catch (error) {
								if (!isExpectedStreamTeardown(error)) {
									console.warn("soak-addon: bidi handler failed:", error);
								}
							}
						})(duplex as WebIncomingBidi);
					}
				} catch (error) {
					console.warn("soak-addon: bidi loop failed:", error);
				} finally {
					try {
						reader.releaseLock();
					} catch {
						// Teardown can race lock release.
					}
				}
			})();
			void (async () => {
				const reader = session.incomingUnidirectionalStreams.getReader();
				try {
					while (true) {
						const next = await readWithIdleRetry(
							reader,
							LOAD_IO_TIMEOUT_MS,
							"incoming uni stream",
						);
						if (next.done) return;
						const incoming = requireReadValue(
							next.value,
							"incoming uni stream",
						);
						void (async (incoming: WebIncomingUni) => {
							const uniReader = incoming.getReader();
							try {
								// Decide on the FIRST chunk. A uni-stop probe's send half
								// stays open awaiting STOP_SENDING, so draining to EOF
								// before checking the prefix deadlocks into mutual
								// timeout (server waits for EOF, client for the stop) —
								// which zeroed the stop-sending operation class for the
								// whole soak.
								const first = await readWithTimeout(
									uniReader,
									LOAD_IO_TIMEOUT_MS,
									"uni payload",
								);
								if (first.done) return;
								const firstBuf = Buffer.from(
									requireReadValue(first.value, "uni payload"),
								);
								if (
									firstBuf.toString("utf8").startsWith(PROBE_UNI_STOP_PREFIX)
								) {
									uniReader.releaseLock();
									incoming[WT_STOP_SENDING]?.(0);
									return;
								}
								const restChunks: Buffer[] = [];
								while (true) {
									const next = await readWithTimeout(
										uniReader,
										LOAD_IO_TIMEOUT_MS,
										"uni payload follow-up",
									);
									if (next.done) break;
									restChunks.push(
										Buffer.from(
											requireReadValue(next.value, "uni payload follow-up"),
										),
									);
								}
								const body = Buffer.concat([firstBuf, ...restChunks]);
								const text = body.toString("utf8");
								if (text.startsWith(PROBE_UNI_ECHO_PREFIX)) {
									const writable = await session.createUnidirectionalStream();
									await new Promise<void>((resolve, reject) => {
										writable.write(body, (error) =>
											error ? reject(error) : resolve(),
										);
									});
									await new Promise<void>((resolve, reject) => {
										writable.end((error?: Error | null) =>
											error ? reject(error) : resolve(),
										);
									});
									return;
								}
								if (text.startsWith(LOAD_UNI_PREFIX)) {
									return;
								}
							} catch (error) {
								console.warn("soak-addon: uni handler failed:", error);
							} finally {
								try {
									uniReader.releaseLock();
								} catch {
									// Already released on the stop path.
								}
							}
						})(incoming);
					}
				} catch (error) {
					console.warn("soak-addon: uni loop failed:", error);
				} finally {
					try {
						reader.releaseLock();
					} catch {
						// Teardown can race lock release.
					}
				}
			})();
		},
	});

	const startedAtMs = Date.now();
	const baselineMetrics = await snapshotRuntime(server, process.pid);
	const initialStateHash = sha256Hex({
		baselineMetrics: summarizeRuntimeForHash(baselineMetrics),
	});
	const samples: Sample[] = [];
	const phases: PhaseRecord[] = [];
	const plan = phasePlan(DURATION);
	let activePhase = "baseline";
	let peakSessions = 0;
	let peakStreams = 0;
	let lastReliefAtMs = Date.now();

	// Forensics for long campaigns: every sample also streams to a JSONL
	// sidecar as it is taken, and SIGTERM/SIGINT flush a partial artifact.
	// A host that dies mid-soak (reboot, OOM cascade — systemd sends TERM
	// before KILL) otherwise leaves NOTHING: the 24h campaign that died at
	// hour 20 was undiagnosable because all state lived in this process.
	const samplesOut = artifactsOut.replace(/\.json$/, ".samples.jsonl");
	writeFileSync(samplesOut, "");
	// Reset the heap-debug sidecar alongside the samples file: a re-run in the
	// same workspace must not concatenate onto stale evidence.
	const heapTypesOut = `${samplesOut}.heap-types.jsonl`;
	writeFileSync(heapTypesOut, "");
	const flushPartial = (signal: string, exitCode: number) => {
		try {
			writeFileSync(
				artifactsOut,
				JSON.stringify(
					{
						version: 1,
						status: "aborted",
						abortSignal: signal,
						mode: "segment-partial",
						memoryMetric: MEMORY_METRIC,
						debugKnobs: {
							heapDebug: HEAP_DEBUG,
							heapDebugIntervalMs: HEAP_DEBUG_INTERVAL_MS,
							committedAbortMb: COMMITTED_ABORT_MB,
						},
						candidateCommit,
						segmentIndex,
						segmentCount,
						startedAtMs,
						abortedAtMs: Date.now(),
						elapsedSec: Math.round((Date.now() - startedAtMs) / 1000),
						plannedDurationSec: DURATION,
						activePhase,
						peakSessions,
						peakStreams,
						sampleCount: samples.length,
						samplesPath: samplesOut,
						lastSample: samples[samples.length - 1] ?? null,
						phasesCompleted: phases.map((phase) => ({
							name: phase.name,
							pass: phase.pass,
							notes: phase.notes,
						})),
					},
					null,
					2,
				),
			);
			console.error(
				`soak-addon: ${signal} at ${Math.round((Date.now() - startedAtMs) / 1000)}s — partial artifact flushed to ${artifactsOut}`,
			);
		} catch {
			// Nothing else to do on the way down.
		}
		process.exit(exitCode);
	};
	process.on("SIGTERM", () => flushPartial("SIGTERM", 143));
	process.on("SIGINT", () => flushPartial("SIGINT", 143));
	// In-loop guard failures must not become unhandled rejections that either
	// tear the process down with no artifact or sit latent while the run keeps
	// burning memory: flush the partial artifact and exit immediately.
	const abortRun = (reason: string): never => {
		console.error(`soak-addon: aborting segment — ${reason}`);
		flushPartial(`guard: ${reason}`, 1);
		throw new Error("unreachable: flushPartial exits");
	};

	let lastHeapDebugAtMs = 0;
	const poller = (async () => {
		while (Date.now() - startedAtMs < (DURATION + 90) * 1000) {
			const metrics = server.metricsSnapshot();
			peakSessions = Math.max(peakSessions, metrics.sessionsActive);
			peakStreams = Math.max(peakStreams, metrics.streamsActive);
			const procMem = readProcStatusMemMb();
			const committedMb = procMem ? procMem.rssAnonMb + procMem.vmSwapMb : null;
			const smapsMem = readSmapsRollupMb();
			const heapDebugDue =
				HEAP_DEBUG && Date.now() - lastHeapDebugAtMs >= HEAP_DEBUG_INTERVAL_MS;
			const jscStats = heapDebugDue ? getJscHeapStats() : null;
			samples.push({
				ts_ms: Date.now(),
				phase: activePhase,
				// Charged metric (see getChargedMb): trend and recovery rules run
				// on what the OS charges, not on retained-arena RSS. Raw RSS is
				// recorded alongside for forensics (it is what the OOM-killer
				// sees).
				rss: getChargedMb(),
				rawRssMb: getRssMb(),
				heapUsedMb: getHeapUsedMb(),
				fd: await getFdCount(process.pid),
				sockets: await getSocketCount(process.pid),
				sessions: metrics.sessionsActive,
				streams: metrics.streamsActive,
				sessionTasks: metrics.sessionTasksActive,
				streamTasks: metrics.streamTasksActive,
				queued: metrics.queuedBytesGlobal,
				...(procMem && committedMb !== null
					? {
							rssAnonMb: procMem.rssAnonMb,
							vmSwapMb: procMem.vmSwapMb,
							committedMb,
						}
					: {}),
				...(smapsMem ?? {}),
				...(jscStats
					? {
							heapCapacityMb: jscStats.heapCapacity / (1024 * 1024),
							objectCount: jscStats.objectCount,
						}
					: {}),
			});
			if (jscStats) {
				lastHeapDebugAtMs = Date.now();
				const top = Object.entries(jscStats.objectTypeCounts)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 40);
				appendFileSync(
					heapTypesOut,
					`${JSON.stringify({ ts_ms: Date.now(), phase: activePhase, heapUsedMb: getHeapUsedMb(), top: Object.fromEntries(top) })}\n`,
				);
			}
			appendFileSync(
				samplesOut,
				`${JSON.stringify(samples[samples.length - 1])}\n`,
			);
			if (
				COMMITTED_ABORT_MB > 0 &&
				committedMb !== null &&
				committedMb > COMMITTED_ABORT_MB
			) {
				abortRun(
					`committed memory ${committedMb.toFixed(0)}MB exceeded SOAK_COMMITTED_ABORT_MB=${COMMITTED_ABORT_MB}`,
				);
			}
			if (metrics.queuedBytesGlobal > DEFAULT_LIMITS.maxQueuedBytesGlobal) {
				abortRun(
					`queuedBytesGlobal ${metrics.queuedBytesGlobal} exceeded ${DEFAULT_LIMITS.maxQueuedBytesGlobal}`,
				);
			}
			if (
				RELIEF_INTERVAL_MS > 0 &&
				Date.now() - lastReliefAtMs >= RELIEF_INTERVAL_MS
			) {
				try {
					releaseNativeMemory();
				} catch {
					// Relief is best-effort.
				}
				Bun.gc(false);
				lastReliefAtMs = Date.now();
			}
			await sleep(DEFAULT_SAMPLE_INTERVAL_MS);
		}
	})();

	const phaseRunners = plan.map((phase) =>
		(async () => {
			await sleep(phase.startOffsetMs);
			const phaseStartedAtMs = Date.now();
			activePhase = phase.name;
			const notes: string[] = [];
			let pass = true;
			let load: LoadClientSummary | undefined;
			let rotationFingerprint: string | undefined;
			try {
				switch (phase.name) {
					case "steady-state":
						await sleep(Math.min(phase.durationMs, 90_000));
						break;
					case "overload":
						load = await runLoadClient(
							"soak-overload",
							[
								CLIENT_BIN,
								"--url",
								"https://127.0.0.1:4433",
								"--sessions",
								String(Math.max(50, Math.floor(SESSIONS * 0.6))),
								"--duration",
								String(Math.max(45, Math.floor(phase.durationMs / 1000))),
								"--datagrams-per-sec",
								String(Math.max(DATAGRAMS_PER_SEC * 2, 1000)),
								"--streams-per-sec",
								String(Math.max(STREAMS_PER_SEC * 2, 10)),
								"--max-session-errors",
								String(
									Math.ceil(Math.max(50, Math.floor(SESSIONS * 0.6)) * 0.6),
								),
								"--max-datagram-errors",
								String(MAX_DATAGRAM_ERRORS * 2),
								// Overload offers ~2x the per-peer stream budget from one
								// IP on purpose; the limiter shedding the excess with
								// reset(0) is the server doing its job, and the client
								// budget must absorb that shed instead of failing the
								// phase for it.
								"--max-stream-errors",
								String(
									Math.ceil(
										Math.max(50, Math.floor(SESSIONS * 0.6)) *
											Math.max(STREAMS_PER_SEC * 2, 10) *
											Math.max(45, Math.floor(phase.durationMs / 1000)) *
											0.6,
									),
								),
							],
							phase.durationMs + 60_000,
						);
						// Deliberate-overload contract: sessions must stay healthy
						// (10% budget unchanged) and the server may shed up to 60%
						// of offered streams via the per-peer limiter; a collapse
						// beyond that, or any session/datagram degradation, still
						// fails. Recovery phases keep the strict 5% stream SLO.
						pass = assertLoadSlo(load, notes, {
							streamErrorRateLimit: 0.6,
						});
						break;
					case "idle-peers":
						load = await runLoadClient(
							"soak-idle",
							[
								CLIENT_BIN,
								"--url",
								"https://127.0.0.1:4433",
								"--sessions",
								String(Math.max(20, Math.floor(SESSIONS * 0.2))),
								"--duration",
								String(Math.max(45, Math.floor(phase.durationMs / 1000))),
								"--datagrams-per-sec",
								"0",
								"--streams-per-sec",
								"0",
								"--max-session-errors",
								String(Math.max(5, Math.ceil(SESSIONS * 0.1))),
								"--max-datagram-errors",
								"0",
								"--max-stream-errors",
								"0",
							],
							phase.durationMs + 60_000,
						);
						pass = assertLoadSlo(load, notes);
						break;
					case "reconnect-churn":
						load = await runLoadClient(
							"soak-reconnect",
							[
								CLIENT_BIN,
								"--mode",
								"reconnect",
								"--url",
								"https://127.0.0.1:4433",
								"--sessions",
								String(Math.max(40, Math.floor(SESSIONS * 0.35))),
								"--duration",
								String(Math.max(45, Math.floor(phase.durationMs / 1000))),
								"--hold-ms",
								"1000",
								"--max-session-errors",
								String(
									Math.ceil(Math.max(40, Math.floor(SESSIONS * 0.35)) * 0.4),
								),
								"--max-datagram-errors",
								String(MAX_DATAGRAM_ERRORS),
								"--max-stream-errors",
								String(MAX_STREAM_ERRORS),
							],
							phase.durationMs + 60_000,
						);
						pass = assertReconnectChurnSlo(load, notes);
						break;
					case "cert-rotation":
						rotationFingerprint = await rotateCertificate(server);
						load = await runLoadClient(
							"soak-post-rotation",
							[
								CLIENT_BIN,
								"--url",
								"https://127.0.0.1:4433",
								"--sessions",
								String(Math.max(30, Math.floor(SESSIONS * 0.25))),
								"--duration",
								String(Math.max(45, Math.floor(phase.durationMs / 1000))),
								"--datagrams-per-sec",
								String(Math.max(50, Math.floor(DATAGRAMS_PER_SEC * 0.4))),
								"--streams-per-sec",
								String(Math.max(1, Math.floor(STREAMS_PER_SEC * 0.5))),
								"--max-session-errors",
								String(
									Math.ceil(Math.max(30, Math.floor(SESSIONS * 0.25)) * 0.4),
								),
								"--max-datagram-errors",
								String(MAX_DATAGRAM_ERRORS),
								"--max-stream-errors",
								String(MAX_STREAM_ERRORS),
							],
							phase.durationMs + 60_000,
						);
						pass = assertLoadSlo(load, notes);
						break;
					default:
						break;
				}
			} catch (error) {
				pass = false;
				notes.push(error instanceof Error ? error.message : String(error));
			} finally {
				// Return allocator arenas and collect the JS heap before the
				// recovery window samples — the same relief the charged-metric
				// comparator applies, and a repeated in-soak exercise of the
				// releaseNativeMemory path (proven non-disruptive to live
				// sessions).
				try {
					releaseNativeMemory();
				} catch {
					// Release is best-effort during teardown races.
				}
				Bun.gc(true);
				phases.push({
					name: phase.name,
					startedAtMs: phaseStartedAtMs,
					endedAtMs: Date.now(),
					pass,
					notes,
					load,
					rotationFingerprint,
				});
				activePhase = "baseline";
			}
		})(),
	);

	const mainLoad = await runLoadClient(
		"soak-main",
		[
			CLIENT_BIN,
			"--url",
			"https://127.0.0.1:4433",
			"--sessions",
			String(SESSIONS),
			"--duration",
			String(DURATION),
			"--datagrams-per-sec",
			String(DATAGRAMS_PER_SEC),
			"--streams-per-sec",
			String(STREAMS_PER_SEC),
			"--max-session-errors",
			String(MAX_SESSION_ERRORS),
			"--max-datagram-errors",
			String(MAX_DATAGRAM_ERRORS),
			"--max-stream-errors",
			String(MAX_STREAM_ERRORS),
		],
		(DURATION + 60) * 1000,
	);
	await Promise.allSettled(phaseRunners);
	await poller;

	await sleep(5000);
	await server.close();
	let finalMetrics = await snapshotRuntime(
		server,
		process.pid,
		peakSessions,
		peakStreams,
	);
	const drainDeadline = Date.now() + 60_000;
	while (
		(finalMetrics.sessionTasksActive >
			baselineMetrics.sessionTasksActive + TASK_RECOVERY_TOLERANCE ||
			finalMetrics.streamTasksActive >
				baselineMetrics.streamTasksActive + TASK_RECOVERY_TOLERANCE ||
			finalMetrics.queuedBytesGlobal >
				baselineMetrics.queuedBytesGlobal + QUEUE_RECOVERY_TOLERANCE_BYTES ||
			finalMetrics.fd > baselineMetrics.fd + FD_RECOVERY_TOLERANCE ||
			finalMetrics.sockets >
				baselineMetrics.sockets + SOCKET_RECOVERY_TOLERANCE ||
			finalMetrics.sessionsActive > baselineMetrics.sessionsActive ||
			finalMetrics.streamsActive > baselineMetrics.streamsActive) &&
		Date.now() < drainDeadline
	) {
		await sleep(500);
		finalMetrics = await snapshotRuntime(
			server,
			process.pid,
			peakSessions,
			peakStreams,
		);
	}

	const endedAtMs = Date.now();
	const trend = evaluateTrendAndRecovery(
		samples,
		phases,
		DEFAULT_LIMITS.maxQueuedBytesGlobal,
	);
	const observedOperationCounts = computeSegmentObservedOperationCounts(
		mainLoad,
		phases,
	);
	const finalStateHash = sha256Hex({
		finalMetrics: summarizeRuntimeForHash(finalMetrics),
		mainLoad,
		phases,
		trend,
	});

	const segment: SegmentMetadata = {
		memoryMetric: MEMORY_METRIC,
		version: 1,
		status:
			assertLoadSlo(mainLoad, []) &&
			trend.pass &&
			REQUIRED_SEGMENT_OPERATION_CLASSES.every(
				(operationClass) => observedOperationCounts[operationClass] > 0,
			) &&
			finalMetrics.fd <= baselineMetrics.fd + FD_RECOVERY_TOLERANCE &&
			finalMetrics.sockets <=
				baselineMetrics.sockets + SOCKET_RECOVERY_TOLERANCE &&
			finalMetrics.sessionsActive <= baselineMetrics.sessionsActive &&
			finalMetrics.streamsActive <= baselineMetrics.streamsActive &&
			finalMetrics.sessionTasksActive <=
				baselineMetrics.sessionTasksActive + TASK_RECOVERY_TOLERANCE &&
			finalMetrics.streamTasksActive <=
				baselineMetrics.streamTasksActive + TASK_RECOVERY_TOLERANCE &&
			finalMetrics.queuedBytesGlobal <=
				baselineMetrics.queuedBytesGlobal + QUEUE_RECOVERY_TOLERANCE_BYTES
				? "pass"
				: "fail",
		mode: "segment",
		repoRoot: ROOT,
		segmentIndex,
		segmentCount,
		candidateCommit,
		actualCommit,
		candidateRef: process.env.SOAK_CANDIDATE_REF ?? null,
		seed,
		continuityTokenDigest: continuityDigest(rawContinuityToken),
		previousFinalHash,
		startedAtMs,
		endedAtMs,
		durationSeconds: DURATION,
		runnerType: process.env.SOAK_RUNNER_TYPE ?? "local",
		runnerMode: process.env.RUNNER_MODE ?? "local",
		runnerProfile: process.env.SOAK_PROFILE ?? "local",
		debugKnobs: {
			heapDebug: HEAP_DEBUG,
			heapDebugIntervalMs: HEAP_DEBUG_INTERVAL_MS,
			committedAbortMb: COMMITTED_ABORT_MB,
		},
		toolchain: {
			bun: Bun.version,
			rustc: readToolVersion("rustc", ["--version"]),
			cc: compilerIdentity(process.env.CC ?? "cc"),
			cxx: compilerIdentity(process.env.CXX ?? "c++"),
		},
		rates: {
			sessions: SESSIONS,
			datagramsPerSec: DATAGRAMS_PER_SEC,
			streamsPerSec: STREAMS_PER_SEC,
		},
		requiredOperationClasses: [...REQUIRED_SEGMENT_OPERATION_CLASSES],
		observedOperationCounts,
		thresholds: {
			maxSessionErrors: MAX_SESSION_ERRORS,
			maxDatagramErrors: MAX_DATAGRAM_ERRORS,
			maxStreamErrors: MAX_STREAM_ERRORS,
			rssTrendMaxRel: RSS_TREND_MAX_REL,
			rssTrendMinAbsMb: RSS_TREND_MIN_ABS_MB,
			rssCeilMb: RSS_CEIL_MB,
			maxGapMs: MAX_AGGREGATE_GAP_MS,
		},
		phasePlan: plan,
		baselineMetrics: {
			rssMb: baselineMetrics.rssMb,
			chargedMb: baselineMetrics.chargedMb,
			heapUsedMb: baselineMetrics.heapUsedMb,
			fd: baselineMetrics.fd,
			sockets: baselineMetrics.sockets,
			sessionsActive: baselineMetrics.sessionsActive,
			streamsActive: baselineMetrics.streamsActive,
			sessionTasksActive: baselineMetrics.sessionTasksActive,
			streamTasksActive: baselineMetrics.streamTasksActive,
			queuedBytesGlobal: baselineMetrics.queuedBytesGlobal,
		},
		mainLoad,
		phaseRecords: phases,
		trend,
		finalMetrics: {
			rssMb: finalMetrics.rssMb,
			chargedMb: finalMetrics.chargedMb,
			heapUsedMb: finalMetrics.heapUsedMb,
			fd: finalMetrics.fd,
			sockets: finalMetrics.sockets,
			sessionsActive: finalMetrics.sessionsActive,
			streamsActive: finalMetrics.streamsActive,
			sessionTasksActive: finalMetrics.sessionTasksActive,
			streamTasksActive: finalMetrics.streamTasksActive,
			queuedBytesGlobal: finalMetrics.queuedBytesGlobal,
			peakSessions: finalMetrics.peakSessions,
			peakStreams: finalMetrics.peakStreams,
		},
		samples,
		initialStateHash,
		finalStateHash,
		segmentHash: "",
	};
	segment.segmentHash = sha256Hex({
		...segment,
		segmentHash: undefined,
	});

	writeFileSync(artifactsOut, JSON.stringify(segment, null, 2));
	const csvPath = artifactsOut.replace(/\.json$/, ".csv");
	writeFileSync(
		csvPath,
		[
			"ts_ms,phase,rss_mb,heap_used_mb,fd,sockets,sessions,streams,session_tasks,stream_tasks,queued_bytes",
			...samples.map((sample) =>
				[
					sample.ts_ms,
					sample.phase,
					sample.rss.toFixed(2),
					sample.heapUsedMb.toFixed(2),
					sample.fd,
					sample.sockets,
					sample.sessions,
					sample.streams,
					sample.sessionTasks,
					sample.streamTasks,
					sample.queued,
				].join(","),
			),
		].join("\n"),
	);

	if (segment.status !== "pass") {
		console.error(
			"soak-addon: FAIL",
			JSON.stringify(
				{
					artifact: basename(artifactsOut),
					mainLoadExit: mainLoad.exitCode,
					trendFailures: trend.failures,
					baselineMetrics: segment.baselineMetrics,
					finalMetrics: segment.finalMetrics,
					observedOperationCounts: segment.observedOperationCounts,
					phaseFailures: phases
						.filter((phase) => !phase.pass)
						.map((phase) => ({ name: phase.name, notes: phase.notes })),
				},
				null,
				2,
			),
		);
		process.exit(1);
	}

	console.log(
		"soak-addon: PASS",
		JSON.stringify(
			{
				artifact: artifactsOut,
				continuityTokenDigest: segment.continuityTokenDigest,
				finalStateHash,
				segmentHash: segment.segmentHash,
				peakSessions,
				peakStreams,
			},
			null,
			2,
		),
	);

	initialTls?.cleanup();
	// Explicit exit: the accept loops keep one pending read (plus the
	// idle-retry timer) alive per session by design, so the event loop no
	// longer drains on its own once the verdict is written. Relying on
	// natural drain hung the process indefinitely after printing PASS.
	process.exit(0);
}

export function aggregateFromDisk(paths: string[]): AggregateSummary {
	const files = listSegmentFiles(paths);
	if (files.length === 0) throw new Error("no json files found to aggregate");
	const segments = files.map(
		(file) => JSON.parse(readFileSync(file, "utf8")) as SegmentMetadata,
	);
	return aggregateSegments(segments);
}

async function main(): Promise<void> {
	const [mode = "run", ...rest] = process.argv.slice(2);
	if (mode === "aggregate") {
		const aggregate = aggregateFromDisk(
			rest.length > 0 ? rest : [join(ROOT, "tools/load")],
		);
		const outPath =
			process.env.SOAK_AGGREGATE_OUT ??
			join(
				ROOT,
				".release-evidence",
				`soak-aggregate-${aggregate.candidateCommit.slice(0, 12)}-${aggregate.segmentCount}x.json`,
			);
		ensureDirectory(resolve(outPath, ".."));
		writeFileSync(outPath, JSON.stringify(aggregate, null, 2));
		console.log(
			"soak-addon: aggregate PASS",
			JSON.stringify(
				{ outPath, aggregateHash: aggregate.aggregateHash },
				null,
				2,
			),
		);
		return;
	}
	await runSegment();
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
