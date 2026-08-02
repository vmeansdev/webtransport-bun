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
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
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
	type ServerSession,
	type WebTransportServer,
	WT_RESET,
	WT_STOP_SENDING,
} from "../../packages/webtransport/src/index.ts";
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
const RSS_TREND_MAX_REL = parseFloat(
	process.env.SOAK_RSS_TREND_MAX_REL ?? "0.2",
);
const RSS_TREND_MIN_ABS_MB = parseFloat(
	process.env.SOAK_RSS_TREND_MIN_ABS_MB ?? "32",
);
const RSS_CEIL_MB = parseFloat(process.env.SOAK_RSS_CEIL_MB ?? "1024");
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
const STREAM_RECOVERY_TOLERANCE = 4;
const STREAM_RECOVERY_REL_TOLERANCE = 0.1;
const QUEUE_RECOVERY_TOLERANCE_BYTES = 64 * 1024;
const HEAP_TREND_MIN_ABS_MB = 16;
const HEAP_RECOVERY_TOLERANCE_MB = 8;

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

const UTF8_ENCODER = new TextEncoder();
const PROBE_DATAGRAM_PREFIX_BYTES = UTF8_ENCODER.encode(PROBE_DATAGRAM_PREFIX);
const PROBE_UNI_ECHO_PREFIX_BYTES = UTF8_ENCODER.encode(PROBE_UNI_ECHO_PREFIX);
const PROBE_UNI_STOP_PREFIX_BYTES = UTF8_ENCODER.encode(PROBE_UNI_STOP_PREFIX);
const PROBE_BIDI_ECHO_PREFIX_BYTES = UTF8_ENCODER.encode(
	PROBE_BIDI_ECHO_PREFIX,
);
const PROBE_BIDI_RESET_PREFIX_BYTES = UTF8_ENCODER.encode(
	PROBE_BIDI_RESET_PREFIX,
);
const LOAD_UNI_PREFIX_BYTES = UTF8_ENCODER.encode(LOAD_UNI_PREFIX);
const LOAD_BIDI_PREFIX_BYTES = UTF8_ENCODER.encode(LOAD_BIDI_PREFIX);

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
	if (value.byteLength < prefix.byteLength) return false;
	for (let index = 0; index < prefix.byteLength; index += 1) {
		if (value[index] !== prefix[index]) return false;
	}
	return true;
}

function isExpectedLoadTeardownError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	const code = String((error as { code?: unknown }).code);
	return (
		code === "E_SESSION_CLOSED" ||
		code === "E_STREAM_RESET" ||
		code === "E_STOP_SENDING"
	);
}

function reportLoadHandlerError(
	logPrefix: string,
	label: string,
	error: unknown,
): void {
	if (
		process.env.WEBTRANSPORT_SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS === "1" &&
		isExpectedLoadTeardownError(error)
	) {
		return;
	}
	console.warn(`${logPrefix}: ${label}:`, error);
}

export type Sample = {
	ts_ms: number;
	phase: string;
	rss: number;
	heapUsedMb: number;
	fd: number;
	sockets: number;
	sessions: number;
	streams: number;
	sessionTasks: number;
	streamTasks: number;
	queued: number;
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
	diagnosticFailures: string[];
	phaseMedians: Record<string, PhaseMedianSummary>;
	steadyState: PhaseMedianSummary | null;
};

type SoakTrendOptions = {
	enforceTrend?: boolean;
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
};

type ToolIdentity = {
	path: string;
	version: string;
};

export type SegmentMetadata = {
	version: 1;
	status: "pass" | "fail";
	mode: "segment";
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
	options: SoakTrendOptions = {},
): SoakTrendSummary {
	const failures: string[] = [];
	const diagnosticFailures: string[] = [];
	const reportTrendFailure = (failure: string): void => {
		if (options.enforceTrend === false) {
			diagnosticFailures.push(failure);
			return;
		}
		failures.push(failure);
	};
	if (samples.length === 0) {
		failures.push("no samples collected");
		return {
			pass: false,
			failures,
			diagnosticFailures,
			phaseMedians: {},
			steadyState: null,
		};
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
		reportTrendFailure(
			`peak RSS ${peakRss.toFixed(1)}MB exceeded ceiling ${RSS_CEIL_MB.toFixed(0)}MB`,
		);
	}

	if (
		steadyState.rssMb > 0 &&
		tailSummary.rssMb - steadyState.rssMb > RSS_TREND_MIN_ABS_MB &&
		tailSummary.rssMb > steadyState.rssMb * (1 + RSS_TREND_MAX_REL)
	) {
		reportTrendFailure(
			`RSS drift ${steadyState.rssMb.toFixed(1)}MB -> ${tailSummary.rssMb.toFixed(1)}MB exceeded ${(
				RSS_TREND_MAX_REL * 100
			).toFixed(0)}% and ${RSS_TREND_MIN_ABS_MB.toFixed(0)}MB`,
		);
	}
	if (
		steadyState.heapUsedMb > 0 &&
		tailSummary.heapUsedMb - steadyState.heapUsedMb > HEAP_TREND_MIN_ABS_MB &&
		tailSummary.heapUsedMb > steadyState.heapUsedMb * (1 + RSS_TREND_MAX_REL)
	) {
		reportTrendFailure(
			`heap drift ${steadyState.heapUsedMb.toFixed(1)}MB -> ${tailSummary.heapUsedMb.toFixed(1)}MB exceeded ${(
				RSS_TREND_MAX_REL * 100
			).toFixed(0)}% and ${HEAP_TREND_MIN_ABS_MB.toFixed(0)}MB`,
		);
	}

	if (
		steadyState.fd > 0 &&
		steadyState.fdSlopePerHour > steadyState.fd * 0.15
	) {
		reportTrendFailure(
			`FD slope ${steadyState.fdSlopePerHour.toFixed(2)}/h exceeded steady-state guard`,
		);
	}
	if (steadyState.queuedSlopeBytesPerHour > maxQueuedBytesGlobal * 0.05) {
		reportTrendFailure(
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
			reportTrendFailure(
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
		if (
			recovery.streams >
			recoveryUpperBound(
				steadyState.streams,
				STREAM_RECOVERY_TOLERANCE,
				STREAM_RECOVERY_REL_TOLERANCE,
			)
		) {
			failures.push(
				`phase ${phase.name} recovery streams ${recovery.streams} stayed above baseline ${steadyState.streams}`,
			);
		}
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
		if (
			steadyState.rssMb > 0 &&
			recovery.rssMb > steadyState.rssMb * (1 + RSS_TREND_MAX_REL) &&
			recovery.rssMb - steadyState.rssMb > RSS_TREND_MIN_ABS_MB
		) {
			reportTrendFailure(
				`phase ${phase.name} recovery RSS ${recovery.rssMb.toFixed(1)}MB stayed above baseline ${steadyState.rssMb.toFixed(1)}MB`,
			);
		}
		if (
			steadyState.heapUsedMb > 0 &&
			recovery.heapUsedMb > steadyState.heapUsedMb * (1 + RSS_TREND_MAX_REL) &&
			recovery.heapUsedMb - steadyState.heapUsedMb > HEAP_RECOVERY_TOLERANCE_MB
		) {
			reportTrendFailure(
				`phase ${phase.name} recovery heap ${recovery.heapUsedMb.toFixed(1)}MB stayed above baseline ${steadyState.heapUsedMb.toFixed(1)}MB`,
			);
		}
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
		diagnosticFailures,
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

function assertLoadSlo(summary: LoadClientSummary, notes: string[]): boolean {
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
	if (streamErrorRate > 0.05) {
		notes.push(
			`${summary.name} stream error rate ${(streamErrorRate * 100).toFixed(2)}% > 5%`,
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

async function readUniWithPeek(
	stream: ReadableStream<Uint8Array>,
	label: string,
): Promise<{ first: Buffer | null; rest: Buffer }> {
	const reader = stream.getReader();
	try {
		const first = await readWithTimeout(reader, LOAD_IO_TIMEOUT_MS, label);
		if (first.done) return { first: null, rest: Buffer.alloc(0) };
		const firstChunk = requireReadValue(first.value, label);
		const firstBuffer = Buffer.from(firstChunk);
		// The stop-sending probe intentionally waits for the peer signal before
		// finishing its send stream, so do not wait for FIN before handling it.
		if (startsWithBytes(firstBuffer, PROBE_UNI_STOP_PREFIX_BYTES)) {
			return { first: firstBuffer, rest: Buffer.alloc(0) };
		}
		const restChunks: Buffer[] = [];
		while (true) {
			const next = await readWithTimeout(
				reader,
				LOAD_IO_TIMEOUT_MS,
				`${label} follow-up`,
			);
			if (next.done) break;
			const chunk = requireReadValue(next.value, `${label} follow-up`);
			restChunks.push(Buffer.from(chunk));
		}
		return {
			first: firstBuffer,
			rest: Buffer.concat(restChunks),
		};
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

export type LoadSessionHandlerOptions = {
	onDatagramEcho?: () => void;
};

export function createLoadSessionHandler(
	logPrefix = "soak-addon",
	options: LoadSessionHandlerOptions = {},
): (session: ServerSession) => Promise<void> {
	return async (session) => {
		const tasks = new Set<Promise<void>>();
		const trackTask = (task: Promise<void>): Promise<void> => {
			tasks.add(task);
			void task.finally(() => {
				tasks.delete(task);
			});
			return task;
		};
		trackTask(
			(async () => {
				try {
					for await (const datagram of session.incomingDatagrams()) {
						if (startsWithBytes(datagram, PROBE_DATAGRAM_PREFIX_BYTES)) {
							await session.sendDatagram(datagram);
							options.onDatagramEcho?.();
						}
					}
				} catch (error) {
					reportLoadHandlerError(logPrefix, "datagram loop failed", error);
				}
			})(),
		);
		trackTask(
			(async () => {
				const reader = session.incomingBidirectionalStreams.getReader();
				try {
					while (true) {
						const next = await readWithTimeout(
							reader,
							LOAD_IO_TIMEOUT_MS,
							"incoming bidi stream",
						);
						if (next.done) return;
						const duplex = next.value;
						trackTask(
							(async (duplex: WebIncomingBidi) => {
								try {
									const body = await collectReadable(
										duplex.readable,
										"bidi payload",
									);
									if (startsWithBytes(body, PROBE_BIDI_RESET_PREFIX_BYTES)) {
										duplex[WT_RESET]?.(42);
										return;
									}
									if (startsWithBytes(body, PROBE_BIDI_ECHO_PREFIX_BYTES)) {
										await writeWebWritable(duplex.writable, body);
										return;
									}
									if (startsWithBytes(body, LOAD_BIDI_PREFIX_BYTES)) {
										const writer = duplex.writable.getWriter();
										try {
											await writer.close();
										} finally {
											writer.releaseLock();
										}
									}
								} catch (error) {
									reportLoadHandlerError(
										logPrefix,
										"bidi handler failed",
										error,
									);
								}
							})(duplex as WebIncomingBidi),
						);
					}
				} catch (error) {
					reportLoadHandlerError(logPrefix, "bidi loop failed", error);
				} finally {
					try {
						reader.releaseLock();
					} catch {
						// Teardown can race lock release.
					}
				}
			})(),
		);
		trackTask(
			(async () => {
				const reader = session.incomingUnidirectionalStreams.getReader();
				try {
					while (true) {
						const next = await readWithTimeout(
							reader,
							LOAD_IO_TIMEOUT_MS,
							"incoming uni stream",
						);
						if (next.done) return;
						const incoming = requireReadValue(
							next.value,
							"incoming uni stream",
						);
						trackTask(
							(async (incoming: WebIncomingUni) => {
								try {
									const { first, rest } = await readUniWithPeek(
										incoming,
										"uni payload",
									);
									if (!first) return;
									if (startsWithBytes(first, PROBE_UNI_STOP_PREFIX_BYTES)) {
										incoming[WT_STOP_SENDING]?.(0);
										return;
									}
									const body = Buffer.concat([first, rest]);
									if (startsWithBytes(body, PROBE_UNI_ECHO_PREFIX_BYTES)) {
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
									if (startsWithBytes(body, LOAD_UNI_PREFIX_BYTES)) return;
								} catch (error) {
									reportLoadHandlerError(
										logPrefix,
										"uni handler failed",
										error,
									);
								}
							})(incoming),
						);
					}
				} catch (error) {
					reportLoadHandlerError(logPrefix, "uni loop failed", error);
				} finally {
					try {
						reader.releaseLock();
					} catch {
						// Teardown can race lock release.
					}
				}
			})(),
		);
		while (tasks.size > 0) {
			await Promise.allSettled([...tasks]);
		}
	};
}

function continuityDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function phasePlan(durationSeconds: number): {
	name: string;
	startOffsetMs: number;
	durationMs: number;
}[] {
	const totalMs = durationSeconds * 1000;
	// Long campaigns retain a 45s minimum phase; short CI smoke runs scale
	// phases down so all five phases finish within the bounded job timeout. The
	// short-run clients still execute five bounded probes before their load
	// window, so leave two slot-length recovery gaps between phase starts rather
	// than allowing the probes and cleanup to overlap the next phase.
	const minimumSlotMs = durationSeconds >= 3600 ? 45_000 : 5_000;
	const slot = Math.max(minimumSlotMs, Math.floor(totalMs / 12));
	const phaseStride = durationSeconds >= 3600 ? slot * 2 : slot * 4;
	return [
		{ name: "steady-state", startOffsetMs: slot, durationMs: slot },
		{
			name: "overload",
			startOffsetMs: slot + phaseStride,
			durationMs: slot,
		},
		{
			name: "idle-peers",
			startOffsetMs: slot + phaseStride * 2,
			durationMs: slot,
		},
		{
			name: "reconnect-churn",
			startOffsetMs: slot + phaseStride * 3,
			durationMs: slot,
		},
		{
			name: "cert-rotation",
			startOffsetMs: slot + phaseStride * 4,
			durationMs: slot,
		},
	];
}

/**
 * Return the sampling deadline needed to observe the final phase's bounded
 * recovery window. The legacy duration+90s floor is retained for long runs,
 * but short schedules can place their final phase after that floor.
 */
export function phaseSamplingHorizonMs(durationSeconds: number): number {
	const minimumHorizonMs = (durationSeconds + 90) * 1000;
	const lastPhase = phasePlan(durationSeconds).at(-1);
	if (!lastPhase) return minimumHorizonMs;
	const lastPhaseEndMs = lastPhase.startOffsetMs + lastPhase.durationMs;
	const recoveryWindowMs = Math.max(
		60_000,
		Math.floor(lastPhase.durationMs / 2),
	);
	return Math.max(minimumHorizonMs, lastPhaseEndMs + recoveryWindowMs);
}

export function soakStreamRateLimitPerSec(
	sessions: number,
	streamsPerSec: number,
): number {
	const safeSessions = Math.max(0, sessions);
	const safeStreamsPerSec = Math.max(0, streamsPerSec);
	const mainStreamRate = safeSessions * safeStreamsPerSec;
	const overloadSessions = Math.max(50, Math.floor(safeSessions * 0.6));
	const overloadStreamsPerSec = Math.max(safeStreamsPerSec * 2, 10);
	const overlappingOverloadRate = overloadSessions * overloadStreamsPerSec;
	return Math.max(1_000, mainStreamRate + overlappingOverloadRate);
}

export function soakDatagramRateLimitPerSec(
	sessions: number,
	datagramsPerSec: number,
): number {
	const safeSessions = Math.max(0, sessions);
	const safeDatagramsPerSec = Math.max(0, datagramsPerSec);
	const mainDatagramRate = safeSessions * safeDatagramsPerSec;
	const overloadSessions = Math.max(50, Math.floor(safeSessions * 0.6));
	const overloadDatagramsPerSec = Math.max(safeDatagramsPerSec * 2, 1_000);
	const overlappingOverloadRate = overloadSessions * overloadDatagramsPerSec;
	return Math.max(10_000, mainDatagramRate + overlappingOverloadRate);
}

export function soakPhaseSessionCount(
	sessions: number,
	fraction: number,
	minimum: number,
	durationSeconds: number,
): number {
	const safeSessions = Math.max(0, sessions);
	const safeFraction = Math.max(0, fraction);
	const safeMinimum = Math.max(0, Math.floor(minimum));
	const requested = Math.max(
		safeMinimum,
		Math.floor(safeSessions * safeFraction),
	);
	// Short hosted smoke campaigns share a CPU-sensitive probe window with the
	// main workload. Keep their phase operation classes intact while halving
	// only phase peer counts; long campaigns retain the full requested scale.
	return durationSeconds < 3_600
		? Math.max(safeMinimum, Math.floor(requested / 2))
		: requested;
}

export function phaseLoadDurationSeconds(durationMs: number): number {
	const minimumDurationSeconds = durationMs >= 45_000 ? 45 : 5;
	return Math.max(minimumDurationSeconds, Math.floor(durationMs / 1000));
}

export function sampleIntervalMs(durationSeconds: number): number {
	return durationSeconds < 3_600 ? 5_000 : DEFAULT_SAMPLE_INTERVAL_MS;
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
	const streamRateLimitPerSec = soakStreamRateLimitPerSec(
		SESSIONS,
		STREAMS_PER_SEC,
	);
	const datagramRateLimitPerSec = soakDatagramRateLimitPerSec(
		SESSIONS,
		DATAGRAMS_PER_SEC,
	);
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
			streamsPerSec: streamRateLimitPerSec,
			streamsBurst: Math.max(streamRateLimitPerSec * 2, 2000),
			datagramsPerSec: datagramRateLimitPerSec,
			datagramsBurst: Math.max(datagramRateLimitPerSec * 2, 20000),
		},
		onSession: createLoadSessionHandler(),
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

	const poller = (async () => {
		while (Date.now() - startedAtMs < phaseSamplingHorizonMs(DURATION)) {
			const metrics = server.metricsSnapshot();
			peakSessions = Math.max(peakSessions, metrics.sessionsActive);
			peakStreams = Math.max(peakStreams, metrics.streamsActive);
			samples.push({
				ts_ms: Date.now(),
				phase: activePhase,
				rss: getRssMb(),
				heapUsedMb: getHeapUsedMb(),
				fd: await getFdCount(process.pid),
				sockets: await getSocketCount(process.pid),
				sessions: metrics.sessionsActive,
				streams: metrics.streamsActive,
				sessionTasks: metrics.sessionTasksActive,
				streamTasks: metrics.streamTasksActive,
				queued: metrics.queuedBytesGlobal,
			});
			if (metrics.queuedBytesGlobal > DEFAULT_LIMITS.maxQueuedBytesGlobal) {
				throw new Error(
					`queuedBytesGlobal ${metrics.queuedBytesGlobal} exceeded ${DEFAULT_LIMITS.maxQueuedBytesGlobal}`,
				);
			}
			await sleep(sampleIntervalMs(DURATION));
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
								String(soakPhaseSessionCount(SESSIONS, 0.6, 50, DURATION)),
								"--duration",
								String(phaseLoadDurationSeconds(phase.durationMs)),
								"--datagrams-per-sec",
								String(Math.max(DATAGRAMS_PER_SEC * 2, 1000)),
								"--streams-per-sec",
								String(Math.max(STREAMS_PER_SEC * 2, 10)),
								"--max-session-errors",
								String(
									Math.ceil(
										soakPhaseSessionCount(SESSIONS, 0.6, 50, DURATION) * 0.6,
									),
								),
								"--max-datagram-errors",
								String(MAX_DATAGRAM_ERRORS * 2),
								"--max-stream-errors",
								String(MAX_STREAM_ERRORS * 2),
							],
							phase.durationMs + 60_000,
						);
						pass = assertLoadSlo(load, notes);
						break;
					case "idle-peers":
						load = await runLoadClient(
							"soak-idle",
							[
								CLIENT_BIN,
								"--url",
								"https://127.0.0.1:4433",
								"--sessions",
								String(soakPhaseSessionCount(SESSIONS, 0.2, 20, DURATION)),
								"--duration",
								String(phaseLoadDurationSeconds(phase.durationMs)),
								"--datagrams-per-sec",
								"0",
								"--streams-per-sec",
								"0",
								"--max-session-errors",
								String(
									Math.max(
										5,
										Math.ceil(
											soakPhaseSessionCount(SESSIONS, 0.2, 20, DURATION) * 0.1,
										),
									),
								),
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
								String(soakPhaseSessionCount(SESSIONS, 0.35, 40, DURATION)),
								"--duration",
								String(phaseLoadDurationSeconds(phase.durationMs)),
								"--hold-ms",
								"1000",
								"--max-session-errors",
								String(
									Math.ceil(
										soakPhaseSessionCount(SESSIONS, 0.35, 40, DURATION) * 0.4,
									),
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
								String(soakPhaseSessionCount(SESSIONS, 0.25, 30, DURATION)),
								"--duration",
								String(phaseLoadDurationSeconds(phase.durationMs)),
								"--datagrams-per-sec",
								String(Math.max(50, Math.floor(DATAGRAMS_PER_SEC * 0.4))),
								"--streams-per-sec",
								String(Math.max(1, Math.floor(STREAMS_PER_SEC * 0.5))),
								"--max-session-errors",
								String(
									Math.ceil(
										soakPhaseSessionCount(SESSIONS, 0.25, 30, DURATION) * 0.4,
									),
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
		// Option 2+3 keeps short-run in-process residency diagnostic; long
		// campaigns retain the authoritative trend gate.
		{ enforceTrend: DURATION >= 3600 },
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
