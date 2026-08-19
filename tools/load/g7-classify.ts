/**
 * Gate G7's clauses and validity falsifiers, as pure functions over recorded
 * fields.
 *
 * The contract is `docs/research/preregistrations/gate-g7-stream-egress.md`.
 * Every threshold here is quoted from that document or from `g7-plan.ts`, and
 * nothing here looks at a number to decide which question to ask of it.
 *
 * Two properties this file exists to have, both learned the hard way:
 *
 * - **Every falsifier is computed here**, not derived by hand at stamp time.
 *   G3b's V1 lived only in a hand derivation, and a reader taking the
 *   classifier's booleans at face value would have stamped a PASS on a run its
 *   own registration declared invalid. `rollUp` can return INVALID over a set
 *   of clauses that all computed PASS, and there is a test that it does.
 * - **It runs off-runner.** It imports nothing from the harness, touches no
 *   filesystem and no process state, so a downloaded artifact can be re-graded
 *   on any machine.
 */

import {
	BULK_GATE_CELL,
	BULK_TARGET_GBPS,
	type BulkCellName,
	L1_DENOMINATOR_CELL,
	L1_LEVER_LICENSE_RATIO,
	L1_NUMERATOR_CELL,
	PACE_OVERSHOOT_RATIO,
	PACE_SHORTFALL_RATIO,
	SHIPPED_QUEUED_BYTES_PER_SESSION,
	SHIPPED_QUEUED_BYTES_PER_STREAM,
	TOKEN_GATE_CELL,
	type TokenCellName,
	tokenCellPlan,
} from "./g7-plan.ts";

// --- Standing bars ----------------------------------------------------------

/** The axis's pre-existing saturation rule. A saturated arm is NO-VERDICT. */
export const HOST_SATURATION_PCT = 90;
/** V3: above this fraction of non-positive samples the clock domain is broken. */
export const NEGATIVE_FRACTION_LIMIT = 0.001;
/** V5: below this decoded fraction the payload contract is not being honoured. */
export const STAMP_PROVENANCE_FLOOR = 0.99;
/** §6 disclosure band on wire bytes vs application bytes. Not a clause. */
export const WIRE_OVERHEAD_DISCLOSURE_RATIO = 1.1;

// --- Latency samples --------------------------------------------------------

/**
 * A latency distribution as the harness records it.
 *
 * `negativeCount` is the number of non-positive samples. They are **ranked**,
 * never dropped: G3b's second, invisible defect was a percentile taken over the
 * positive samples only, where the negative fraction was itself 47-85% and
 * arm-dependent, so the reported "p99" was not the same order statistic in the
 * columns being compared.
 */
export type LatencySamples = {
	negativeCount: number;
	/** Upper edge of each bucket in milliseconds, ascending. */
	bucketUpperMs: number[];
	/** Count in each bucket; same length as `bucketUpperMs`. */
	bucketCounts: number[];
	/** Largest observed sample, for the tail the buckets clamp. */
	maxMs: number;
};

export function sampleCount(s: LatencySamples): number {
	let total = s.negativeCount;
	for (const c of s.bucketCounts) total += c;
	return total;
}

export function negativeFraction(s: LatencySamples): number {
	const total = sampleCount(s);
	return total === 0 ? 0 : s.negativeCount / total;
}

/**
 * Percentile over **all** samples, with non-positive ones ranked at the bottom.
 * Returns null for an empty distribution rather than a zero — an absent
 * measurement is never a passing one.
 */
export function percentileMs(s: LatencySamples, q: number): number | null {
	const total = sampleCount(s);
	if (total === 0) return null;
	const rank = q * total;
	let seen = s.negativeCount;
	if (seen >= rank) return 0;
	for (let i = 0; i < s.bucketCounts.length; i += 1) {
		seen += s.bucketCounts[i] ?? 0;
		if (seen >= rank) return s.bucketUpperMs[i] ?? null;
	}
	return s.maxMs;
}

// --- Recorded facts ---------------------------------------------------------

/** Facts common to every step, whatever arm produced it. */
export type CommonFacts = {
	bucket: string;
	incomplete: boolean;
	hostCpuPctMedian: number | null;
	sinkCpuPctMedian: number | null;
	rateLimitedDelta: number | null;
	limitExceededDelta: number | null;
	sessionsErr: number;
	exitCode: number;
	/** Must be 0/unset: the receive knob is irrelevant here and may not be on. */
	streamBatchBytesEnv: number;
	/** Kernel counters, both directions. Null means "not measured", never zero. */
	clientRcvbufErrors: number | null;
	serverSndbufErrors: number | null;
	/**
	 * Last writer's end minus the first writer's start: the interval the pacer
	 * was actually running, and the binding rate denominator (K14, Amendment 1b).
	 */
	writeWindowSec: number;
	/** Sink spawn to sink exit. Published, the most conservative, never binding. */
	childDriveSec: number;
	/** The nominal step seconds. Published for comparability, binding on nothing. */
	windowSec: number;
};

export type BulkRepeatFacts = CommonFacts & {
	cell: BulkCellName;
	repeat: number;
	writeBytes: number;
	paceBytesPerSec: number;
	/** Server write bytes over `writeWindowSec`: what was actually offered. */
	offeredBytesPerSecWriteWindow: number | null;
	/** Sink read bytes over `writeWindowSec`. The binding denominator (K14). */
	deliveredBytesPerSecWriteWindow: number | null;
	/** Sink read bytes over the nominal window. Reported for comparability. */
	deliveredBytesPerSecNominal: number | null;
	serverBytesWritten: number;
	sinkBytesRead: number;
	writeCalls: number;
	writeSettles: number;
	streamsOpened: number;
	streamsAccepted: number;
	streamsFinished: number;
	serverStreamErrors: number;
	sinkStreamErrors: number;
	pacerLateness: LatencySamples;
	writeSettle: LatencySamples;
	/** The pacer's own interval for this cell, in ms: V2b's comparison point. */
	writeIntervalMs: number;
	serverCpuMs: number | null;
	wireBytesSent: number | null;
	explicitWindowFieldsSet: boolean;
	queuedBytesPerStream: number;
	queuedBytesPerSession: number;
};

export type TokenRepeatFacts = CommonFacts & {
	cell: TokenCellName;
	repeat: number;
	sessions: number;
	writeBytes: number;
	writesIssued: number;
	writesReceived: number;
	writeSettles: number;
	stampsDecoded: number;
	stampsUndecodable: number;
	sequenceGaps: number;
	outOfOrder: number;
	streamsOpened: number;
	streamsAccepted: number;
	streamsFinished: number;
	serverStreamErrors: number;
	sinkStreamErrors: number;
	oneWay: LatencySamples;
	pacerLateness: LatencySamples;
	writeSettle: LatencySamples;
	/** The inter-token interval for this cell, in ms. */
	intervalMs: number;
	serverCpuMs: number | null;
};

// --- Falsifiers -------------------------------------------------------------

export type FalsifierId =
	| "V1-sink"
	| "V2-overshoot"
	| "V2b-originator"
	| "V3-negative"
	| "V4-ledger"
	| "V5-stamp"
	| "V6-quiescence"
	| "V7-saturation";

export type FalsifierResult = {
	id: FalsifierId;
	fired: boolean;
	/** What firing means for the run: INVALID kills the claim outright. */
	effect: "INVALID" | "INCOMPLETE" | "NO-VERDICT" | "DISCLOSURE";
	detail: string;
};

function ok(
	id: FalsifierId,
	effect: FalsifierResult["effect"],
): FalsifierResult {
	return { id, fired: false, effect, detail: "" };
}

/** V1: the sink must not be what the run measured. */
export function v1Sink(f: CommonFacts): FalsifierResult {
	if (f.sinkCpuPctMedian === null)
		return {
			id: "V1-sink",
			fired: true,
			effect: "INCOMPLETE",
			detail: "sink CPU not measured; an unmeasured sink is never a clean one",
		};
	if (f.sinkCpuPctMedian >= HOST_SATURATION_PCT)
		return {
			id: "V1-sink",
			fired: true,
			effect: "INCOMPLETE",
			detail: `sink CPU ${f.sinkCpuPctMedian}% >= ${HOST_SATURATION_PCT}%: the arm measured the sink`,
		};
	return ok("V1-sink", "INCOMPLETE");
}

/** V2: the cumulative-deadline pacer cannot write ahead of its clock. */
export function v2Overshoot(f: {
	offeredBytesPerSecWriteWindow: number | null;
	paceBytesPerSec: number;
}): FalsifierResult {
	if (f.paceBytesPerSec <= 0) return ok("V2-overshoot", "INVALID");
	if (f.offeredBytesPerSecWriteWindow === null)
		return {
			id: "V2-overshoot",
			fired: true,
			effect: "INVALID",
			detail: "pace-unmeasurable: no server-side write-byte counter",
		};
	const ratio = f.offeredBytesPerSecWriteWindow / f.paceBytesPerSec;
	if (ratio > PACE_OVERSHOOT_RATIO)
		return {
			id: "V2-overshoot",
			fired: true,
			effect: "INVALID",
			detail: `offered/pace ${ratio.toFixed(5)} > ${PACE_OVERSHOOT_RATIO}: the writer was not the registered pacer`,
		};
	return ok("V2-overshoot", "INVALID");
}

/**
 * V2b: a shortfall the originator caused is an INCOMPLETE cell, not a product
 * miss.
 *
 * The rule needs a second condition that the first draft of the registration
 * did not have, and Amendment 1 adds it. On this gate the pacer runs on the
 * server's own event loop — it *is* the server — so a slow write path delays
 * the next wake and shows up as pacer lateness. Without the second condition, a
 * genuine product shortfall could be excused as originator-bound, which is
 * precisely the direction a gate must never lean.
 *
 * So lateness only counts as the *originator's* when the write call is not what
 * produced it: `p99(writeSettle) < 0.5 x p99(pacerLateness)`. If the write call
 * accounts for half or more of the lateness, the lateness is the product's cost
 * and the shortfall is the product's finding.
 */
export const ORIGINATOR_SETTLE_SHARE = 0.5;

export function v2bOriginator(f: {
	offeredBytesPerSecWriteWindow: number | null;
	paceBytesPerSec: number;
	pacerLateness: LatencySamples;
	writeSettle: LatencySamples;
	writeIntervalMs: number;
}): FalsifierResult {
	if (f.offeredBytesPerSecWriteWindow === null || f.paceBytesPerSec <= 0)
		return ok("V2b-originator", "INCOMPLETE");
	const ratio = f.offeredBytesPerSecWriteWindow / f.paceBytesPerSec;
	if (ratio >= PACE_SHORTFALL_RATIO) return ok("V2b-originator", "INCOMPLETE");
	const lateP99 = percentileMs(f.pacerLateness, 0.99);
	if (lateP99 === null)
		return {
			id: "V2b-originator",
			fired: true,
			effect: "INCOMPLETE",
			detail: `shortfall ${ratio.toFixed(3)} with pacer lateness unmeasured`,
		};
	if (lateP99 <= f.writeIntervalMs) return ok("V2b-originator", "INCOMPLETE");
	const settleP99 = percentileMs(f.writeSettle, 0.99);
	if (settleP99 === null)
		return {
			id: "V2b-originator",
			fired: true,
			effect: "INCOMPLETE",
			detail: `shortfall ${ratio.toFixed(3)} with write settle time unmeasured: the lateness cannot be attributed`,
		};
	if (settleP99 >= ORIGINATOR_SETTLE_SHARE * lateP99)
		return {
			id: "V2b-originator",
			fired: false,
			effect: "INCOMPLETE",
			detail: `PRODUCT-BOUND shortfall ${ratio.toFixed(3)}: write settle p99 ${settleP99} ms is ${((settleP99 / lateP99) * 100).toFixed(0)}% of pacer lateness p99 ${lateP99} ms, so the lateness is the write path's own cost`,
		};
	return {
		id: "V2b-originator",
		fired: true,
		effect: "INCOMPLETE",
		detail: `ORIGINATOR-BOUND: offered/pace ${ratio.toFixed(3)}, pacer lateness p99 ${lateP99} ms > one write interval ${f.writeIntervalMs} ms, and write settle p99 ${settleP99} ms accounts for under half of it`,
	};
}

/** V3: one clock, one box — a negative one-way is a broken clock domain. */
export function v3Negative(samples: LatencySamples): FalsifierResult {
	const frac = negativeFraction(samples);
	if (frac > NEGATIVE_FRACTION_LIMIT)
		return {
			id: "V3-negative",
			fired: true,
			effect: "INVALID",
			detail: `non-positive sample fraction ${frac.toFixed(5)} > ${NEGATIVE_FRACTION_LIMIT}: clock domain violated`,
		};
	return ok("V3-negative", "INVALID");
}

/** V4: two processes that disagree about how many bytes exist measured nothing. */
export function v4Ledger(f: {
	serverBytesWritten: number;
	sinkBytesRead: number;
	writeCalls: number;
	writeSettles: number;
	writeBytes: number;
	streamsOpened: number;
	streamsAccepted: number;
	streamsFinished: number;
}): FalsifierResult {
	const problems: string[] = [];
	if (f.serverBytesWritten !== f.sinkBytesRead)
		problems.push(
			`bytes written ${f.serverBytesWritten} != bytes read ${f.sinkBytesRead}`,
		);
	if (f.writeCalls !== f.writeSettles)
		problems.push(`write calls ${f.writeCalls} != settles ${f.writeSettles}`);
	if (f.writeCalls * f.writeBytes !== f.serverBytesWritten)
		problems.push(
			`writeCalls x writeBytes ${f.writeCalls * f.writeBytes} != bytes written ${f.serverBytesWritten}`,
		);
	if (
		f.streamsOpened !== f.streamsAccepted ||
		f.streamsAccepted !== f.streamsFinished
	)
		problems.push(
			`streams opened/accepted/finished ${f.streamsOpened}/${f.streamsAccepted}/${f.streamsFinished}`,
		);
	if (problems.length > 0)
		return {
			id: "V4-ledger",
			fired: true,
			effect: "INCOMPLETE",
			detail: `drain-incomplete: ${problems.join("; ")}`,
		};
	return ok("V4-ledger", "INCOMPLETE");
}

/** V5: the two ends must agree about the payload contract. */
export function v5Stamp(f: {
	stampsDecoded: number;
	writesReceived: number;
}): FalsifierResult {
	if (f.writesReceived === 0)
		return {
			id: "V5-stamp",
			fired: true,
			effect: "INCOMPLETE",
			detail: "no writes received",
		};
	const frac = f.stampsDecoded / f.writesReceived;
	if (frac < STAMP_PROVENANCE_FLOOR)
		return {
			id: "V5-stamp",
			fired: true,
			effect: "INCOMPLETE",
			detail: `decoded stamp fraction ${frac.toFixed(4)} < ${STAMP_PROVENANCE_FLOOR}`,
		};
	return ok("V5-stamp", "INCOMPLETE");
}

/** V6: the axis's standing quiescence STOP, plus the knob-is-off requirement. */
export function v6Quiescence(f: CommonFacts): FalsifierResult {
	const problems: string[] = [];
	if (f.rateLimitedDelta === null || f.limitExceededDelta === null)
		problems.push("limiter deltas not measured");
	else if (f.rateLimitedDelta !== 0 || f.limitExceededDelta !== 0)
		problems.push(
			`limiter engaged: rateLimited ${f.rateLimitedDelta}, limitExceeded ${f.limitExceededDelta}`,
		);
	if (f.sessionsErr !== 0) problems.push(`sessionsErr ${f.sessionsErr}`);
	if (f.exitCode !== 0) problems.push(`exitCode ${f.exitCode}`);
	if (f.streamBatchBytesEnv !== 0)
		problems.push(
			`receive-side batch knob set to ${f.streamBatchBytesEnv}: no G7 cell may run with it on`,
		);
	if (problems.length > 0)
		return {
			id: "V6-quiescence",
			fired: true,
			effect: "INCOMPLETE",
			detail: problems.join("; "),
		};
	return ok("V6-quiescence", "INCOMPLETE");
}

/** V7: a saturated host is NO-VERDICT, never a MISS. */
export function v7Saturation(f: CommonFacts): FalsifierResult {
	if (f.hostCpuPctMedian === null)
		return {
			id: "V7-saturation",
			fired: true,
			effect: "NO-VERDICT",
			detail: "host CPU not measured",
		};
	if (f.hostCpuPctMedian >= HOST_SATURATION_PCT)
		return {
			id: "V7-saturation",
			fired: true,
			effect: "NO-VERDICT",
			detail: `host CPU ${f.hostCpuPctMedian}% >= ${HOST_SATURATION_PCT}%`,
		};
	return ok("V7-saturation", "NO-VERDICT");
}

export function bulkFalsifiers(f: BulkRepeatFacts): FalsifierResult[] {
	return [
		v6Quiescence(f),
		v7Saturation(f),
		v1Sink(f),
		v2Overshoot(f),
		v2bOriginator(f),
		v3Negative(f.pacerLateness),
		v4Ledger(f),
	];
}

export function tokenFalsifiers(f: TokenRepeatFacts): FalsifierResult[] {
	return [
		v6Quiescence(f),
		v7Saturation(f),
		v1Sink(f),
		v3Negative(f.oneWay),
		v5Stamp(f),
		v4Ledger({
			serverBytesWritten: f.writesIssued * f.writeBytes,
			sinkBytesRead: f.writesReceived * f.writeBytes,
			writeCalls: f.writesIssued,
			writeSettles: f.writeSettles,
			writeBytes: f.writeBytes,
			streamsOpened: f.streamsOpened,
			streamsAccepted: f.streamsAccepted,
			streamsFinished: f.streamsFinished,
		}),
	];
}

// --- Cell medians -----------------------------------------------------------

export function median(values: number[]): number | null {
	const usable = values.filter((v) => Number.isFinite(v));
	if (usable.length === 0) return null;
	const sorted = [...usable].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export type CellStatus = "usable" | "INCOMPLETE" | "INVALID" | "NO-VERDICT";

export type CellSummary<C extends string> = {
	cell: C;
	repeats: number;
	status: CellStatus;
	firedFalsifiers: FalsifierResult[];
	/** Per-repeat drop counts, both directions, never elsewhere (K15). */
	dropDisclosure: {
		repeat: number;
		clientRcvbufErrors: number | null;
		serverSndbufErrors: number | null;
	}[];
	deliveredIsLowerBound: boolean;
};

function worstStatus(fired: FalsifierResult[]): CellStatus {
	if (fired.some((f) => f.effect === "INVALID")) return "INVALID";
	if (fired.some((f) => f.effect === "NO-VERDICT")) return "NO-VERDICT";
	if (fired.some((f) => f.effect === "INCOMPLETE")) return "INCOMPLETE";
	return "usable";
}

export type BulkCellSummary = CellSummary<BulkCellName> & {
	deliveredGbpsWriteWindow: number | null;
	deliveredGbpsNominal: number | null;
	/** The same bytes over the sink child's whole lifetime: the floor figure. */
	deliveredGbpsChildDrive: number | null;
	offeredOverPace: number | null;
	writesPerSec: number | null;
	writeSettleP50Ms: number | null;
	writeSettleP99Ms: number | null;
	pacerLatenessP99Ms: number | null;
	serverCpuMsPerGbit: number | null;
	serverCpuMsPerMillionWrites: number | null;
	wireOverheadRatio: number | null;
	insideShippedBudgets: boolean;
};

export function summariseBulkCell(
	cell: BulkCellName,
	repeats: BulkRepeatFacts[],
): BulkCellSummary {
	const fired = repeats.flatMap((r) =>
		bulkFalsifiers(r).filter((v) => v.fired),
	);
	const deliveredDrive = repeats.map((r) =>
		r.deliveredBytesPerSecWriteWindow === null
			? Number.NaN
			: (r.deliveredBytesPerSecWriteWindow * 8) / 1e9,
	);
	const deliveredWindow = repeats.map((r) =>
		r.deliveredBytesPerSecNominal === null
			? Number.NaN
			: (r.deliveredBytesPerSecNominal * 8) / 1e9,
	);
	const cpuPerGbit = repeats.map((r) => {
		if (r.serverCpuMs === null) return Number.NaN;
		const gbit = (r.sinkBytesRead * 8) / 1e9;
		return gbit > 0 ? r.serverCpuMs / gbit : Number.NaN;
	});
	const cpuPerMillionWrites = repeats.map((r) =>
		r.serverCpuMs === null || r.writeCalls === 0
			? Number.NaN
			: (r.serverCpuMs * 1e6) / r.writeCalls,
	);
	const writesPerSec = repeats.map((r) =>
		r.writeWindowSec > 0 ? r.writeCalls / r.writeWindowSec : Number.NaN,
	);
	const dropDisclosure = repeats.map((r) => ({
		repeat: r.repeat,
		clientRcvbufErrors: r.clientRcvbufErrors,
		serverSndbufErrors: r.serverSndbufErrors,
	}));
	const deliveredIsLowerBound = dropDisclosure.some(
		(d) => (d.clientRcvbufErrors ?? 0) > 0 || (d.serverSndbufErrors ?? 0) > 0,
	);
	return {
		cell,
		repeats: repeats.length,
		status: worstStatus(fired),
		firedFalsifiers: fired,
		dropDisclosure,
		deliveredIsLowerBound,
		deliveredGbpsWriteWindow: median(deliveredDrive),
		deliveredGbpsNominal: median(deliveredWindow),
		deliveredGbpsChildDrive: median(
			repeats.map((r) =>
				r.childDriveSec > 0
					? (r.sinkBytesRead * 8) / 1e9 / r.childDriveSec
					: Number.NaN,
			),
		),
		offeredOverPace: median(
			repeats.map((r) =>
				r.offeredBytesPerSecWriteWindow === null || r.paceBytesPerSec <= 0
					? Number.NaN
					: r.offeredBytesPerSecWriteWindow / r.paceBytesPerSec,
			),
		),
		writesPerSec: median(writesPerSec),
		writeSettleP50Ms: median(
			repeats.map((r) => percentileMs(r.writeSettle, 0.5) ?? Number.NaN),
		),
		writeSettleP99Ms: median(
			repeats.map((r) => percentileMs(r.writeSettle, 0.99) ?? Number.NaN),
		),
		pacerLatenessP99Ms: median(
			repeats.map((r) => percentileMs(r.pacerLateness, 0.99) ?? Number.NaN),
		),
		serverCpuMsPerGbit: median(cpuPerGbit),
		serverCpuMsPerMillionWrites: median(cpuPerMillionWrites),
		wireOverheadRatio: median(
			repeats.map((r) =>
				r.wireBytesSent === null || r.serverBytesWritten === 0
					? Number.NaN
					: r.wireBytesSent / r.serverBytesWritten,
			),
		),
		insideShippedBudgets: repeats.every(
			(r) =>
				!r.explicitWindowFieldsSet &&
				r.queuedBytesPerStream === SHIPPED_QUEUED_BYTES_PER_STREAM &&
				r.queuedBytesPerSession === SHIPPED_QUEUED_BYTES_PER_SESSION,
		),
	};
}

export type TokenCellSummary = CellSummary<TokenCellName> & {
	sessions: number;
	oneWayP50Ms: number | null;
	oneWayP99Ms: number | null;
	oneWayNegativeFraction: number;
	pacerLatenessP99Ms: number | null;
	writeSettleP50Ms: number | null;
	writeSettleP99Ms: number | null;
	writesPerSec: number | null;
	deliveryExact: boolean;
	serverCpuMsPerMillionWrites: number | null;
};

export function summariseTokenCell(
	cell: TokenCellName,
	repeats: TokenRepeatFacts[],
): TokenCellSummary {
	const fired = repeats.flatMap((r) =>
		tokenFalsifiers(r).filter((v) => v.fired),
	);
	const dropDisclosure = repeats.map((r) => ({
		repeat: r.repeat,
		clientRcvbufErrors: r.clientRcvbufErrors,
		serverSndbufErrors: r.serverSndbufErrors,
	}));
	return {
		cell,
		repeats: repeats.length,
		status: worstStatus(fired),
		firedFalsifiers: fired,
		dropDisclosure,
		deliveredIsLowerBound: dropDisclosure.some(
			(d) => (d.clientRcvbufErrors ?? 0) > 0 || (d.serverSndbufErrors ?? 0) > 0,
		),
		sessions: repeats[0]?.sessions ?? 0,
		oneWayP50Ms: median(
			repeats.map((r) => percentileMs(r.oneWay, 0.5) ?? Number.NaN),
		),
		oneWayP99Ms: median(
			repeats.map((r) => percentileMs(r.oneWay, 0.99) ?? Number.NaN),
		),
		oneWayNegativeFraction: Math.max(
			0,
			...repeats.map((r) => negativeFraction(r.oneWay)),
		),
		pacerLatenessP99Ms: median(
			repeats.map((r) => percentileMs(r.pacerLateness, 0.99) ?? Number.NaN),
		),
		writeSettleP50Ms: median(
			repeats.map((r) => percentileMs(r.writeSettle, 0.5) ?? Number.NaN),
		),
		writeSettleP99Ms: median(
			repeats.map((r) => percentileMs(r.writeSettle, 0.99) ?? Number.NaN),
		),
		writesPerSec: median(
			repeats.map((r) =>
				r.writeWindowSec > 0 ? r.writesIssued / r.writeWindowSec : Number.NaN,
			),
		),
		deliveryExact: repeats.every(
			(r) =>
				r.writesIssued === r.writesReceived &&
				r.sequenceGaps === 0 &&
				r.outOfOrder === 0 &&
				r.serverStreamErrors === 0 &&
				r.sinkStreamErrors === 0,
		),
		serverCpuMsPerMillionWrites: median(
			repeats.map((r) =>
				r.serverCpuMs === null || r.writesIssued === 0
					? Number.NaN
					: (r.serverCpuMs * 1e6) / r.writesIssued,
			),
		),
	};
}

// --- Clauses ----------------------------------------------------------------

export type ClauseResult = {
	id: "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8";
	verdict: "PASS" | "MISS" | "NOT-EVALUATED";
	detail: string;
};

function notEvaluated(id: ClauseResult["id"], why: string): ClauseResult {
	return { id, verdict: "NOT-EVALUATED", detail: why };
}

export function evaluateClauses(
	bulk: Map<BulkCellName, BulkCellSummary>,
	tokens: Map<TokenCellName, TokenCellSummary>,
): ClauseResult[] {
	const gate = bulk.get(BULK_GATE_CELL);
	const tokenGate = tokens.get(TOKEN_GATE_CELL);
	const clauseBearing = [
		...(gate ? [gate.status] : []),
		...(tokenGate ? [tokenGate.status] : []),
	];
	const results: ClauseResult[] = [];

	results.push(
		clauseBearing.length < 2
			? notEvaluated("C1", "a clause-bearing cell is missing from the run")
			: clauseBearing.every((s) => s === "usable")
				? { id: "C1", verdict: "PASS", detail: "both gate cells usable" }
				: {
						id: "C1",
						verdict: "MISS",
						detail: `gate cell statuses: ${clauseBearing.join(", ")}`,
					},
	);

	if (!gate) {
		results.push(
			notEvaluated("C2", "no gate cell"),
			notEvaluated("C3", "no gate cell"),
			notEvaluated("C4", "no gate cell"),
			notEvaluated("C5", "no gate cell"),
			notEvaluated("C6", "no gate cell"),
		);
	} else {
		results.push(
			gate.deliveredGbpsWriteWindow === null
				? notEvaluated("C2", "delivered rate not measured")
				: {
						id: "C2",
						verdict:
							gate.deliveredGbpsWriteWindow >= BULK_TARGET_GBPS
								? "PASS"
								: "MISS",
						detail: `${gate.deliveredGbpsWriteWindow.toFixed(4)} Gbps on writeWindowSec vs bar ${BULK_TARGET_GBPS}; same bytes over the sink child's whole lifetime ${gate.deliveredGbpsChildDrive?.toFixed(4) ?? "n/a"} Gbps, over the nominal window ${gate.deliveredGbpsNominal?.toFixed(4) ?? "n/a"} Gbps`,
					},
		);
		const ledgerFired = gate.firedFalsifiers.some((v) => v.id === "V4-ledger");
		results.push({
			id: "C3",
			verdict: ledgerFired ? "MISS" : "PASS",
			detail: ledgerFired
				? gate.firedFalsifiers
						.filter((v) => v.id === "V4-ledger")
						.map((v) => v.detail)
						.join("; ")
				: "byte and stream ledgers close exactly",
		});
		const unmeasured = gate.dropDisclosure.some(
			(d) => d.clientRcvbufErrors === null,
		);
		const drops = gate.dropDisclosure.reduce(
			(sum, d) => sum + (d.clientRcvbufErrors ?? 0),
			0,
		);
		results.push(
			unmeasured
				? notEvaluated(
						"C4",
						"client rcvbuf counter unmeasured; an unmeasured drop count is never a zero",
					)
				: {
						id: "C4",
						verdict: drops === 0 ? "PASS" : "MISS",
						detail: `client rcvbuf errors on the gate arm: ${gate.dropDisclosure.map((d) => d.clientRcvbufErrors).join(", ")}`,
					},
		);
		results.push(
			gate.offeredOverPace === null
				? notEvaluated("C5", "offer not measured")
				: {
						id: "C5",
						verdict:
							gate.offeredOverPace >= PACE_SHORTFALL_RATIO &&
							gate.offeredOverPace <= PACE_OVERSHOOT_RATIO
								? "PASS"
								: "MISS",
						detail: `offered/pace ${gate.offeredOverPace.toFixed(5)} vs [${PACE_SHORTFALL_RATIO}, ${PACE_OVERSHOOT_RATIO}]`,
					},
		);
		results.push({
			id: "C6",
			verdict: gate.insideShippedBudgets ? "PASS" : "MISS",
			detail: gate.insideShippedBudgets
				? "shipped governors, no explicit window field"
				: "the gate arm did not run on the shipped governors",
		});
	}

	if (!tokenGate) {
		results.push(
			notEvaluated("C7", "no token gate cell"),
			notEvaluated("C8", "no token gate cell"),
		);
	} else {
		const bound = tokenCellPlan(TOKEN_GATE_CELL).oneWayBoundMs;
		results.push(
			tokenGate.oneWayP99Ms === null
				? notEvaluated("C7", "one-way distribution empty")
				: {
						id: "C7",
						verdict: tokenGate.oneWayP99Ms <= bound ? "PASS" : "MISS",
						detail: `raw one-way p99 ${tokenGate.oneWayP99Ms} ms vs bound ${bound} ms (pacer lateness p99 ${tokenGate.pacerLatenessP99Ms} ms, reported beside it and never subtracted)`,
					},
		);
		results.push({
			id: "C8",
			verdict: tokenGate.deliveryExact ? "PASS" : "MISS",
			detail: tokenGate.deliveryExact
				? "every issued write arrived, gapless and in order, every stream finished"
				: "delivery/drain ledger did not close",
		});
	}
	return results;
}

// --- L1, the lever-scout reading (§6) ---------------------------------------

export type L1Reading = {
	ratio: number | null;
	numeratorCell: BulkCellName;
	denominatorCell: BulkCellName;
	threshold: number;
	verdict: "LEVER-LICENSED" | "LEVER-REFUTED" | "NOT-MEASURABLE";
	detail: string;
};

export function evaluateL1(
	bulk: Map<BulkCellName, BulkCellSummary>,
): L1Reading {
	const num = bulk.get(L1_NUMERATOR_CELL);
	const den = bulk.get(L1_DENOMINATOR_CELL);
	const base = {
		numeratorCell: L1_NUMERATOR_CELL,
		denominatorCell: L1_DENOMINATOR_CELL,
		threshold: L1_LEVER_LICENSE_RATIO,
	};
	if (
		!num ||
		!den ||
		num.serverCpuMsPerGbit === null ||
		den.serverCpuMsPerGbit === null ||
		den.serverCpuMsPerGbit === 0
	)
		return {
			...base,
			ratio: null,
			verdict: "NOT-MEASURABLE",
			detail: "CPU-per-Gbit missing on one of the two cells",
		};
	if (num.status !== "usable" || den.status !== "usable")
		return {
			...base,
			ratio: null,
			verdict: "NOT-MEASURABLE",
			detail: `cell status ${num.status}/${den.status}: a lever reading needs two usable cells`,
		};
	const ratio = num.serverCpuMsPerGbit / den.serverCpuMsPerGbit;
	return {
		...base,
		ratio,
		verdict:
			ratio >= L1_LEVER_LICENSE_RATIO ? "LEVER-LICENSED" : "LEVER-REFUTED",
		detail: `CPU-ms/Gbit ${num.serverCpuMsPerGbit.toFixed(1)} at ${L1_NUMERATOR_CELL} vs ${den.serverCpuMsPerGbit.toFixed(1)} at ${L1_DENOMINATOR_CELL} = ${ratio.toFixed(3)} (threshold ${L1_LEVER_LICENSE_RATIO}); a design question only, never a build order`,
	};
}

// --- Roll-up ----------------------------------------------------------------

export type GateVerdict = {
	runValid: boolean;
	verdict: "PASS" | "MISS" | "INCOMPLETE" | "INVALID" | "NO-VERDICT";
	clauses: ClauseResult[];
	firedFalsifiers: FalsifierResult[];
	l1: L1Reading;
	/** Printed before any clause line, so a reader cannot skip it. */
	headline: string;
};

/**
 * The roll-up, with the property G3b's classifier lacked: validity is decided
 * **before** the clauses are read, and a fired INVALID falsifier stamps INVALID
 * over a set of clauses that all computed PASS.
 */
export function rollUp(
	bulk: Map<BulkCellName, BulkCellSummary>,
	tokens: Map<TokenCellName, TokenCellSummary>,
): GateVerdict {
	const clauses = evaluateClauses(bulk, tokens);
	const l1 = evaluateL1(bulk);
	const clauseBearing = [
		bulk.get(BULK_GATE_CELL),
		tokens.get(TOKEN_GATE_CELL),
	].filter((c): c is BulkCellSummary | TokenCellSummary => c !== undefined);
	const fired = clauseBearing.flatMap((c) => c.firedFalsifiers);

	if (fired.some((v) => v.effect === "INVALID"))
		return {
			runValid: false,
			verdict: "INVALID",
			clauses,
			firedFalsifiers: fired,
			l1,
			headline:
				"INVALID: a registered validity falsifier fired on a clause-bearing cell. No gate verdict is stamped, whatever the clauses computed.",
		};
	if (fired.some((v) => v.effect === "NO-VERDICT"))
		return {
			runValid: false,
			verdict: "NO-VERDICT",
			clauses,
			firedFalsifiers: fired,
			l1,
			headline:
				"NO-VERDICT: a clause-bearing cell was host-saturated. Saturation is never a MISS.",
		};
	if (
		fired.some((v) => v.effect === "INCOMPLETE") ||
		clauseBearing.length < 2 ||
		clauses.some((c) => c.verdict === "NOT-EVALUATED")
	)
		return {
			runValid: false,
			verdict: "INCOMPLETE",
			clauses,
			firedFalsifiers: fired,
			l1,
			headline: "INCOMPLETE: the run did not produce a gradeable set of cells.",
		};
	const missed = clauses.filter((c) => c.verdict === "MISS");
	return {
		runValid: true,
		verdict: missed.length === 0 ? "PASS" : "MISS",
		clauses,
		firedFalsifiers: fired,
		l1,
		headline:
			missed.length === 0
				? "PASS: every registered clause cleared on a valid run."
				: `MISS: ${missed.map((c) => c.id).join(", ")} on a valid run. Final for the effort.`,
	};
}
