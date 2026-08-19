/**
 * Gate G7's arithmetic, as functions over scenario constants.
 *
 * The contract is `docs/research/preregistrations/gate-g7-stream-egress.md`,
 * committed before this file existed. Every constant here is either quoted from
 * that document or derived by a function in it — mechanising the arithmetic is
 * what catches a page that does not produce its own numbers (G6 found a wrong
 * AoI constant exactly this way).
 *
 * Nothing in this file looks at a measurement. It answers "what will be
 * offered" only.
 */

// --- Shipped configuration facts (K7) ---------------------------------------

/** `DEFAULT_LIMITS.maxQueuedBytesPerStream` on the base tree. */
export const SHIPPED_QUEUED_BYTES_PER_STREAM = 256 * 1024;
/** `DEFAULT_LIMITS.maxQueuedBytesPerSession` on the base tree. */
export const SHIPPED_QUEUED_BYTES_PER_SESSION = 2 * 1024 * 1024;
/** `DEFAULT_LIMITS.maxQueuedBytesGlobal` on the base tree. */
export const SHIPPED_QUEUED_BYTES_GLOBAL = 512 * 1024 * 1024;
/** `DEFAULT_LIMITS.maxDatagramSize`. Enters the per-session memory math only. */
export const SHIPPED_MAX_DATAGRAM_SIZE = 1200;

/**
 * The write pipelining depth the gate write size is derived for.
 *
 * `write_bytes` reserves the whole write against the per-stream governor before
 * enqueueing it, so a write equal to the governor serialises: park, write, park.
 * Four is the smallest depth that makes the governor a queue rather than a
 * mutex, and 256 KiB / 4 lands on a CMAF-shaped 64 KiB.
 */
export const WRITE_PIPELINE_DEPTH = 4;

/** §3.1: the largest write that still pipelines at depth 4. */
export function gateWriteBytes(
	queuedBytesPerStream = SHIPPED_QUEUED_BYTES_PER_STREAM,
	depth = WRITE_PIPELINE_DEPTH,
): number {
	return Math.floor(queuedBytesPerStream / depth);
}

// --- Arm S-bulk (K1, K2) ----------------------------------------------------

/** The spec's bulk target, direction-flipped. The C2 bar. */
export const BULK_TARGET_GBPS = 1.0;
/** The axis's integrity band, in five independent places. */
export const INTEGRITY_BAND = 0.05;
/** §3.2: bar + 5 x the band. Derived from the bar, never from a measurement. */
export const PACE_TARGET_GBPS = BULK_TARGET_GBPS * (1 + 5 * INTEGRITY_BAND);

/** Pacing bands (K4). */
export const PACE_SHORTFALL_RATIO = 0.95;
export const PACE_OVERSHOOT_RATIO = 1.02;

/** G5b's operating point, kept so the two directions are comparable. */
export const BULK_SESSIONS = 4;
export const BULK_STREAMS_PER_SESSION = 4;

/** Timer granularity the slice quantum is derived from. */
export const TIMER_GRANULARITY_MS = 1;

export type BulkCellName = "B-64k" | "B-16k" | "B-4k" | "B-1k";

/** The gate arm. Every S-bulk clause is about this cell and no other. */
export const BULK_GATE_CELL: BulkCellName = "B-64k";

export const BULK_CELLS: readonly BulkCellName[] = [
	"B-64k",
	"B-16k",
	"B-4k",
	"B-1k",
];

/** The cell whose CPU-per-Gbit is L1's numerator (§6). */
export const L1_NUMERATOR_CELL: BulkCellName = "B-4k";
/** L1's denominator cell. */
export const L1_DENOMINATOR_CELL: BulkCellName = "B-64k";
/**
 * §6: below this ratio the crossings are under ~1/8 of the path's cost and no
 * send-side batching lever is licensed. Derived from the receive-side lever's
 * measured 2.68x across a 33x crossing change.
 */
export const L1_LEVER_LICENSE_RATIO = 2.0;

const BULK_WRITE_BYTES: Record<BulkCellName, number> = {
	"B-64k": 64 * 1024,
	"B-16k": 16 * 1024,
	"B-4k": 4 * 1024,
	"B-1k": 1024,
};

export type BulkCellPlan = {
	cell: BulkCellName;
	writeBytes: number;
	sessions: number;
	streamsPerSession: number;
	streams: number;
	/** Aggregate offer in bytes/s. Identical across the ladder by design. */
	paceBytesPerSec: number;
	/** Per-stream offer in bytes/s: the pacer's unit. */
	perStreamBytesPerSec: number;
	/** Aggregate write calls per second at the offer: the crossing rate. */
	writesPerSec: number;
	/** Seconds between writes on one stream. */
	writeIntervalMs: number;
	/**
	 * Writes a paced stream may issue at one wake: one timer tick of bytes,
	 * never more. At or above the granularity this is 1 and no burst exists.
	 */
	sliceQuantum: number;
	/** True when the interval is under the timer granularity (§3.3). */
	subTickPaced: boolean;
	/** Registered as expected-to-miss; licenses nothing (P3). */
	expectedToMiss: boolean;
	gateBearing: boolean;
};

export function bulkCellPlan(
	cell: BulkCellName,
	paceGbps = PACE_TARGET_GBPS,
	sessions = BULK_SESSIONS,
	streamsPerSession = BULK_STREAMS_PER_SESSION,
): BulkCellPlan {
	const writeBytes = BULK_WRITE_BYTES[cell];
	const streams = sessions * streamsPerSession;
	const paceBytesPerSec = (paceGbps * 1e9) / 8;
	const perStreamBytesPerSec = paceBytesPerSec / streams;
	const writesPerSec = paceBytesPerSec / writeBytes;
	const writeIntervalMs = (writeBytes / perStreamBytesPerSec) * 1000;
	const sliceQuantum = Math.max(
		1,
		Math.ceil(
			(TIMER_GRANULARITY_MS / 1000) * (perStreamBytesPerSec / writeBytes),
		),
	);
	return {
		cell,
		writeBytes,
		sessions,
		streamsPerSession,
		streams,
		paceBytesPerSec,
		perStreamBytesPerSec,
		writesPerSec,
		writeIntervalMs,
		sliceQuantum,
		subTickPaced: writeIntervalMs < TIMER_GRANULARITY_MS,
		expectedToMiss: cell === "B-1k",
		gateBearing: cell === BULK_GATE_CELL,
	};
}

// --- Arm S-tokens -----------------------------------------------------------

/** §3.1: the 28-byte stamp plus 12 bytes of token text. */
export const TOKEN_STAMP_BYTES = 28;
export const TOKEN_TEXT_BYTES = 12;
export const TOKEN_WRITE_BYTES = TOKEN_STAMP_BYTES + TOKEN_TEXT_BYTES;

/** Interactive completion serving: ~5x adult reading speed. */
export const TOKENS_PER_SEC = 25;

/** The C7 fraction of the inter-token interval. */
export const TOKEN_LATENCY_FRACTION = 0.25;

export type TokenCellName = "T-250" | "T-1k" | "T-2.5k";

export const TOKEN_GATE_CELL: TokenCellName = "T-1k";

export const TOKEN_CELLS: readonly TokenCellName[] = [
	"T-250",
	"T-1k",
	"T-2.5k",
];

const TOKEN_SESSIONS: Record<TokenCellName, number> = {
	"T-250": 250,
	"T-1k": 1000,
	"T-2.5k": 2500,
};

/**
 * Slices per inter-token interval. The emitter spreads a tick's sessions across
 * these instead of issuing one aligned impulse — the egress mirror of T02's
 * confirmed synchronized-arrival mechanism. 20 slices of a 40 ms interval is a
 * 2 ms slice, above the timer granularity by 2x.
 */
export const TOKEN_SLICES_PER_INTERVAL = 20;

export type TokenCellPlan = {
	cell: TokenCellName;
	sessions: number;
	tokensPerSec: number;
	writeBytes: number;
	/** Aggregate write calls per second: the crossing rate this arm probes. */
	writesPerSec: number;
	/** Aggregate payload rate. Small by design — this arm is not about bytes. */
	bytesPerSec: number;
	/** Milliseconds between two tokens of one session. */
	intervalMs: number;
	/** The C7 bar in milliseconds, derived from the interval. */
	oneWayBoundMs: number;
	slices: number;
	sliceMs: number;
	sessionsPerSlice: number;
	gateBearing: boolean;
	/** Above the gate rung: scout data, licenses nothing (§7.1). */
	scoutOnly: boolean;
};

export function tokenCellPlan(
	cell: TokenCellName,
	tokensPerSec = TOKENS_PER_SEC,
	writeBytes = TOKEN_WRITE_BYTES,
): TokenCellPlan {
	const sessions = TOKEN_SESSIONS[cell];
	const intervalMs = 1000 / tokensPerSec;
	const slices = TOKEN_SLICES_PER_INTERVAL;
	return {
		cell,
		sessions,
		tokensPerSec,
		writeBytes,
		writesPerSec: sessions * tokensPerSec,
		bytesPerSec: sessions * tokensPerSec * writeBytes,
		intervalMs,
		oneWayBoundMs: intervalMs * TOKEN_LATENCY_FRACTION,
		slices,
		sliceMs: intervalMs / slices,
		sessionsPerSlice: Math.ceil(sessions / slices),
		gateBearing: cell === TOKEN_GATE_CELL,
		scoutOnly: TOKEN_SESSIONS[cell] > TOKEN_SESSIONS[TOKEN_GATE_CELL],
	};
}

// --- Memory math (C6, K8) ---------------------------------------------------

export type SessionMemoryMath = {
	receiveWindow: number;
	sendWindow: number;
	datagramChannelBytes: number;
	perSessionWorstCaseBytes: number;
	/** Multiple of the rig's 8 GB at the configured session ceiling. */
	rigMultipleAtMaxSessions: number;
};

/**
 * The advertised per-session worst case, from the same formula the shipped
 * doc comment states. Windows are advertised limits, not allocations —
 * `maxQueuedBytesGlobal` does not bound them (K8), which is why this is
 * computed against `maxSessions` and the rig's RAM rather than against the
 * global governor.
 */
export function sessionMemoryMath(opts: {
	queuedBytesPerStream?: number;
	queuedBytesPerSession?: number;
	maxDatagramSize?: number;
	datagramChannelDepth?: number;
	maxSessions: number;
	rigBytes: number;
}): SessionMemoryMath {
	const perSession =
		opts.queuedBytesPerSession ?? SHIPPED_QUEUED_BYTES_PER_SESSION;
	const maxDatagramSize = opts.maxDatagramSize ?? SHIPPED_MAX_DATAGRAM_SIZE;
	// transport_memory.rs derives the datagram channel depth from the session
	// governor and clamps it at 2048 (spec §Lever contracts, T08/T09).
	const channelDepth =
		opts.datagramChannelDepth ??
		Math.min(2048, Math.ceil(perSession / maxDatagramSize));
	const datagramChannelBytes = channelDepth * maxDatagramSize;
	const perSessionWorstCaseBytes =
		perSession + perSession + datagramChannelBytes;
	return {
		receiveWindow: perSession,
		sendWindow: perSession,
		datagramChannelBytes,
		perSessionWorstCaseBytes,
		rigMultipleAtMaxSessions:
			(perSessionWorstCaseBytes * opts.maxSessions) / opts.rigBytes,
	};
}

// --- Pre-flight requirements (§8) -------------------------------------------

export type PreflightRequirements = {
	/** Bytes/s the sink must sustain: 1.5 x the gate arm's byte rate. */
	sinkBytesPerSec: number;
	/** Write-events/s the sink must sustain: 1.5 x the token gate rung. */
	sinkEventsPerSec: number;
	headroomFactor: number;
	/** The G6 refusal rule: two clocks further apart than this is no dispatch. */
	clockAgreementMs: number;
};

export const PREFLIGHT_HEADROOM = 1.5;

export function preflightRequirements(): PreflightRequirements {
	const bulk = bulkCellPlan(BULK_GATE_CELL);
	const tokens = tokenCellPlan(TOKEN_GATE_CELL);
	return {
		sinkBytesPerSec: bulk.paceBytesPerSec * PREFLIGHT_HEADROOM,
		sinkEventsPerSec: tokens.writesPerSec * PREFLIGHT_HEADROOM,
		headroomFactor: PREFLIGHT_HEADROOM,
		clockAgreementMs: 50,
	};
}

export type PreflightReport = {
	sinkBytesPerSecObserved: number | null;
	sinkEventsPerSecObserved: number | null;
	/** The pre-check's own source: a saturated source is a failure, not a pass. */
	sourceHostCpuPctMedian: number | null;
	sourceShortfall: boolean;
	clockDeltaMs: number | null;
	sameDay: boolean;
	loopback: boolean;
};

export type PreflightVerdict = {
	ok: boolean;
	reasons: string[];
};

/**
 * K16's rule, mechanised: a pre-check whose own source saturated is a failure,
 * and a missing measurement is never a pass.
 */
export function evaluatePreflight(
	report: PreflightReport,
	req: PreflightRequirements = preflightRequirements(),
): PreflightVerdict {
	const reasons: string[] = [];
	if (!report.sameDay) reasons.push("pre-check is not from the run's own day");
	if (!report.loopback) reasons.push("pre-check did not run on loopback");
	if (report.sinkBytesPerSecObserved === null)
		reasons.push("sink byte rate not measured");
	else if (report.sinkBytesPerSecObserved < req.sinkBytesPerSec)
		reasons.push(
			`sink byte rate ${report.sinkBytesPerSecObserved} < required ${req.sinkBytesPerSec}`,
		);
	if (report.sinkEventsPerSecObserved === null)
		reasons.push("sink event rate not measured");
	else if (report.sinkEventsPerSecObserved < req.sinkEventsPerSec)
		reasons.push(
			`sink event rate ${report.sinkEventsPerSecObserved} < required ${req.sinkEventsPerSec}`,
		);
	if (report.sourceHostCpuPctMedian === null)
		reasons.push("pre-check source CPU not measured");
	else if (report.sourceHostCpuPctMedian >= 90)
		reasons.push(
			`pre-check source saturated (host CPU ${report.sourceHostCpuPctMedian}%) — a failure, not a pass`,
		);
	if (report.sourceShortfall)
		reasons.push("pre-check source did not source its own offer");
	if (report.clockDeltaMs === null)
		reasons.push("clock agreement not measured");
	else if (Math.abs(report.clockDeltaMs) > req.clockAgreementMs)
		reasons.push(
			`clock domains disagree by ${report.clockDeltaMs} ms > ${req.clockAgreementMs} ms`,
		);
	return { ok: reasons.length === 0, reasons };
}
