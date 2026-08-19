#!/usr/bin/env bun
/**
 * Mechanical classifier for the egress axis.
 *
 * Reads the per-shape fragments `bench-egress.ts` writes and applies
 * `docs/research/preregistrations/egress.md` to them — STOP conditions first, in
 * the registered order, then buckets, then the capacity numbers under the two
 * registered gates. Nothing here decides anything: every rule in this file is a
 * transcription of a rule that was written down before the run.
 *
 * Usage: bun tools/load/egress-classify.ts <out.json> <fragment.json...>
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { EgressEmitter } from "./egress-emitter.ts";
import type { EgressProfile } from "./egress-schedule.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
	type LatencySummary,
} from "./latency-histogram.ts";

const MS = 1e6;

export type StopReason =
	| "generator-saturation"
	| "offered-shortfall"
	| "clock-invalid"
	| "delivery-collapse"
	| "sample-starvation"
	// Fan-out only, all registered by amendment 8. The first two are the shape's
	// two falsifiers; the last two are its generator and capacity STOPs, which
	// sit on the publisher side and the forward side respectively.
	| "sink-saturation"
	| "sink-precheck-inconclusive"
	| "ingest-unreal"
	| "publisher-shortfall"
	| "forward-shortfall";

export type EgressBucket =
	| "ok-realtime"
	| "ok-interactive"
	| "ok-frame"
	| "degraded"
	| "unusable";

export type AlignmentBucket =
	| "alignment-free"
	| "alignment-cheap"
	| "alignment-expensive"
	| "alignment-fatal";

/** Gate bounds, in nanoseconds. Registered before the run; do not touch. */
export const GATE_REALTIME_NS = 5 * MS;
export const GATE_FRAME_NS = 33.3 * MS;
const FRAME_PERIOD_NS = 33.3333 * MS;
const CLOCK_RESIDUAL_LIMIT_NS = 50_000;
const MIN_SAMPLES = 10_000;

/**
 * The loaded-server headroom arm, per pre-registration amendment 1. `burnNs` is
 * the falsifier's synthetic per-datagram cost: any non-zero value means the run
 * exists to prove the STOP fires, and it may never carry a capacity number.
 */
export type HeadroomFragment = {
	ceilingPerSec: number;
	burnNs?: number;
	/** The arm whose ceiling this is. Absent on pre-G3 fragments (serial). */
	emitter?: EgressEmitter;
	rungs: Array<Record<string, unknown>>;
};

export type Fragment = {
	shape: "ladder" | "fanout" | "headroom" | "gate";
	profile?: EgressProfile;
	clock: { calibrationResidualNs: number; source: string };
	config?: Record<string, unknown>;
	/** quinn-udp capability read, once per fragment. Never a per-send count. */
	gso?: { maxGsoSegments: number | null; groSegments: number | null } | null;
	headroom?: HeadroomFragment | null;
	steps?: RawStep[];
};

/** Host UDP counter deltas across one step's drive window. */
export type UdpDeltaJson = {
	inDatagrams: number;
	outDatagrams: number;
	inErrors: number;
	rcvbufErrors: number;
	sndbufErrors: number;
};

type RawStep = {
	shape: "ladder" | "fanout" | "gate";
	profile: EgressProfile;
	/** Which originator arm drove the step. Absent on pre-G3 fragments. */
	emitter?: EgressEmitter;
	/** Replicate block, and position inside it. Gate shape only. */
	block?: number | null;
	positionInBlock?: number | null;
	udp?: UdpDeltaJson | null;
	perSessionRate: number;
	sessionsRequested: number;
	sessionsConnected: number;
	aggregateRate: number;
	/** Wall clock across the step. Disclosure only: no rate divides by it. */
	elapsedSec: number;
	originator: {
		sent: number;
		sendErrors: number;
		sendEventsScheduled: number;
		sendEventsSkipped: number;
		scheduledDatagrams: number;
		originationLag: LatencyHistogramJson;
		sendIssueSpread: LatencyHistogramJson;
		peakWindowDatagrams: number;
		/** The send grid's period. On fan-out, the publisher's frame interval. */
		gridPeriodNs?: number;
		/** The interval the originator was driving. Every rate divides by this. */
		driveWindowSec: number;
	};
	clientReceived: number;
	client: {
		egressOneWay: LatencyHistogramJson;
		endToEnd: LatencyHistogramJson;
		recvUnstamped: number;
	} | null;
	downDeliveryRatio: number | null;
	/** Percent of one core, so the threshold below scales with `hostCpuCount`. */
	hostCpuPctMedian: number | null;
	hostCpuCount?: number;
	serverCpuPct: number;
	ingested: number;
	forwardLag: LatencyHistogramJson | null;
	fanout?: FanoutRecordJson | null;
};

/** Steps without an emitter field predate G3 and were the serial-await arm. */
function emitterOf(step: { emitter?: EgressEmitter }): EgressEmitter {
	return step.emitter ?? "serial";
}

/**
 * The fan-out shape's own record. Only the fields the classifier reads are
 * named here; `bench-egress.ts` writes considerably more, and the artifact
 * keeps all of it.
 */
export type FanoutRecordJson = {
	mode: "per-subscriber" | "constant-aggregate";
	publisherRatePerSec: number;
	datagramsPerTick: number;
	ingested: number;
	publisherStamped: number;
	forwarded: number;
	forwardDeliveryRatio: number | null;
	frameGapFraction: number;
	ingestToForward: LatencyHistogramJson;
	forwardIssueSpread: LatencyHistogramJson;
	forwardSettle: LatencyHistogramJson;
	ingestReality: { real: boolean; reasons: string[] };
	publisherShortfall: boolean;
	forwardShortfall: boolean;
	precheck: {
		outcome: "pass" | "sink-saturation" | "sink-precheck-inconclusive";
	};
};

/** Co-residence advisory: host CPU at this fraction of total host capacity. */
const CO_RESIDENCE_HOST_FRACTION = 0.97;
const CO_RESIDENCE_DELIVERY = 0.95;

export type ClassifiedStep = {
	shape: "ladder" | "fanout" | "gate";
	profile: EgressProfile;
	emitter: EgressEmitter;
	block: number | null;
	positionInBlock: number | null;
	udp: UdpDeltaJson | null;
	perSessionRate: number;
	aggregateRate: number;
	sessionsConnected: number;
	complete: boolean;
	stop: StopReason | null;
	bucket: EgressBucket | null;
	burstBucket: "burst-absorbed" | "burst-overrun" | null;
	burstSpreadMs: number | null;
	coResidenceBound: boolean;
	oneWay: LatencySummary;
	endToEnd: LatencySummary | null;
	originationLag: LatencySummary;
	originationLagFloorNs: number;
	peakWindowDatagrams: number;
	sent: number;
	scheduled: number;
	offeredFraction: number;
	clientReceived: number;
	downDeliveryRatio: number | null;
	sendEventsSkipped: number;
	sendEventsScheduled: number;
	hostCpuPctMedian: number | null;
	hostCpuCount: number | null;
	serverCpuPct: number;
	/** The interval the rates below divide by. */
	driveWindowSec: number;
	/** Wall clock across the step, for disclosure of the overshoot. */
	elapsedSec: number;
	deliveredPerSec: number;
	/**
	 * The load the step *demanded*, from the profile generator's own arithmetic.
	 * The headroom STOP divides by this rather than by `deliveredPerSec`: a
	 * generator-bound run depresses what was delivered, and a rule that divides
	 * by a depressed number passes exactly when it should fire.
	 */
	offeredPerSec: number;
	/** Fan-out only: everything the shape's instruments and falsifiers produced. */
	fanout: FanoutRecordJson | null;
	/**
	 * Fan-out only, and a **label rather than a STOP**: the server could not
	 * finish fanning one frame out before the next one arrived. That is a
	 * capacity finding at that N, and marking the step incomplete over it would
	 * be discarding the answer.
	 */
	forwardOverrun: boolean | null;
};

function summarize(json: LatencyHistogramJson | null): LatencySummary | null {
	if (!json) return null;
	return LatencyHistogram.fromJson(json).summary();
}

export function bucketFor(p99Ns: number): EgressBucket {
	const ms = p99Ns / MS;
	if (ms < 5) return "ok-realtime";
	if (ms < 20) return "ok-interactive";
	if (ms < 33.3) return "ok-frame";
	if (ms < 100) return "degraded";
	return "unusable";
}

export function alignmentBucketFor(deltaNs: number): AlignmentBucket {
	const ms = deltaNs / MS;
	if (ms < 1) return "alignment-free";
	if (ms < 10) return "alignment-cheap";
	if (ms < 33.3) return "alignment-expensive";
	return "alignment-fatal";
}

/**
 * STOP conditions, in the registered order. First match wins.
 *
 * `lagFloorNs` is the minimum origination-lag p99 across the same profile's
 * steps — a within-arm control, so the platform's fixed timer-wake granularity
 * is subtracted rather than mistaken for load.
 */
export function stopFor(
	step: RawStep,
	residualNs: number,
	lagFloorNs: number,
	oneWay: LatencySummary | null,
	endToEnd: LatencySummary | null,
	lag: LatencySummary,
): StopReason | null {
	// The fan-out shape has no JS scheduler and no rate ladder, so the ladder's
	// first two STOPs do not describe it. Its own four run first, in the order
	// amendment 8 registered, and then the three shared ones apply unchanged.
	if (step.shape === "fanout") {
		const fan = step.fanout;
		if (!fan) return "ingest-unreal";
		if (fan.precheck.outcome !== "pass") return fan.precheck.outcome;
		if (!fan.ingestReality.real) return "ingest-unreal";
		if (fan.publisherShortfall) return "publisher-shortfall";
		if (fan.forwardShortfall) return "forward-shortfall";
		return sharedStops(step, residualNs, oneWay, endToEnd);
	}

	// `sendEventsScheduled` is every grid event the plan put inside the step,
	// run and skipped alike, so this ratio is the registered `skipped/scheduled`
	// and not `skipped/ran`.
	const events = step.originator.sendEventsScheduled;
	if (events > 0 && step.originator.sendEventsSkipped >= 0.1 * events) {
		return "generator-saturation";
	}
	if (lagFloorNs > 0 && lag.p99Ns >= 4 * lagFloorNs) {
		return "generator-saturation";
	}

	// Both halves of `offered-shortfall` (amendment 2): a rung driven into fewer
	// than 95% of its registered sessions is not the registered shape, and a rung
	// that issued under 90% of the plan's own count did not offer it.
	const scheduled = step.originator.scheduledDatagrams;
	if (scheduled > 0 && step.originator.sent < 0.9 * scheduled) {
		return "offered-shortfall";
	}
	if (step.sessionsConnected < 0.95 * step.sessionsRequested) {
		return "offered-shortfall";
	}

	return sharedStops(step, residualNs, oneWay, endToEnd);
}

/**
 * The three STOPs both shapes share, in the registered order: a run whose clock
 * cannot be trusted, one whose delivery collapsed far enough to make an
 * arrival-conditioned tail survivorship-biased, and one with too few samples to
 * read a p99 off.
 */
function sharedStops(
	step: RawStep,
	residualNs: number,
	oneWay: LatencySummary | null,
	endToEnd: LatencySummary | null,
): StopReason | null {
	if (residualNs > CLOCK_RESIDUAL_LIMIT_NS) return "clock-invalid";
	if (!oneWay) return "clock-invalid";
	const stamped = oneWay.count + oneWay.negative;
	if (oneWay.negative > 0.001 * Math.max(stamped, 1)) return "clock-invalid";
	if (step.clientReceived > 0 && stamped < 0.99 * step.clientReceived) {
		return "clock-invalid";
	}
	if (endToEnd && oneWay.p99Ns > endToEnd.p99Ns) return "clock-invalid";

	if (step.downDeliveryRatio !== null && step.downDeliveryRatio < 0.8) {
		return "delivery-collapse";
	}
	if (oneWay.count < MIN_SAMPLES) return "sample-starvation";
	return null;
}

export function classifySteps(
	steps: RawStep[],
	residualNs: number,
): ClassifiedStep[] {
	// Floor per profile, computed across that profile's whole ladder.
	const floors = new Map<string, number>();
	for (const step of steps) {
		const p99 = summarize(step.originator.originationLag)?.p99Ns ?? 0;
		if (p99 <= 0) continue;
		// The floor never crosses an arm (gate-g3 §H3): taking it across arms
		// would let a cheap arm's floor make an expensive arm's honest behaviour
		// read as saturation, or the reverse.
		const key = `${step.shape}:${step.profile}:${emitterOf(step)}`;
		floors.set(key, Math.min(floors.get(key) ?? p99, p99));
	}

	return steps.map((step) => {
		const oneWay = summarize(step.client?.egressOneWay ?? null);
		const endToEnd = summarize(step.client?.endToEnd ?? null);
		const lag =
			summarize(step.originator.originationLag) ??
			new LatencyHistogram().summary();
		const floor =
			floors.get(`${step.shape}:${step.profile}:${emitterOf(step)}`) ?? 0;
		const stop = stopFor(step, residualNs, floor, oneWay, endToEnd, lag);
		// Rates divide by the drive window, never by the step's wall clock, which
		// also contains the CPU sampler, the client's exit and (on fan-out) a
		// process spawn. Older fragments without the field fall back to it.
		const window =
			step.originator.driveWindowSec > 0
				? step.originator.driveWindowSec
				: step.elapsedSec;
		const complete = stop === null;
		const resolved = oneWay ?? new LatencyHistogram().summary();
		const isFrameArm =
			step.profile === "frame-bursty" ||
			step.profile === "keyframe-aligned" ||
			step.profile === "desktop-share";
		return {
			shape: step.shape,
			profile: step.profile,
			emitter: emitterOf(step),
			block: step.block ?? null,
			positionInBlock: step.positionInBlock ?? null,
			udp: step.udp ?? null,
			perSessionRate: step.perSessionRate,
			aggregateRate: step.aggregateRate,
			sessionsConnected: step.sessionsConnected,
			complete,
			stop,
			bucket: complete ? bucketFor(resolved.p99Ns) : null,
			burstBucket:
				complete && isFrameArm
					? resolved.p99Ns < FRAME_PERIOD_NS
						? "burst-absorbed"
						: "burst-overrun"
					: null,
			burstSpreadMs: complete ? (resolved.p99Ns - resolved.p50Ns) / MS : null,
			// Host CPU arrives as percent-of-one-core, so the registered "≥ 97% of
			// the host" is 97% of `100 × cores` — 388 on the 4 vCPU rig. Reading a
			// bare 97 against that unit would fire on almost every step.
			coResidenceBound:
				(step.hostCpuPctMedian ?? 0) >=
					CO_RESIDENCE_HOST_FRACTION * 100 * (step.hostCpuCount ?? 1) &&
				(step.downDeliveryRatio ?? 1) < CO_RESIDENCE_DELIVERY,
			oneWay: resolved,
			endToEnd,
			originationLag: lag,
			originationLagFloorNs: floor,
			peakWindowDatagrams: step.originator.peakWindowDatagrams,
			sent: step.originator.sent,
			scheduled: step.originator.scheduledDatagrams,
			offeredFraction:
				step.originator.scheduledDatagrams > 0
					? step.originator.sent / step.originator.scheduledDatagrams
					: 0,
			clientReceived: step.clientReceived,
			downDeliveryRatio: step.downDeliveryRatio,
			sendEventsSkipped: step.originator.sendEventsSkipped,
			sendEventsScheduled: step.originator.sendEventsScheduled,
			hostCpuPctMedian: step.hostCpuPctMedian,
			hostCpuCount: step.hostCpuCount ?? null,
			serverCpuPct: step.serverCpuPct,
			driveWindowSec: window,
			elapsedSec: step.elapsedSec,
			deliveredPerSec: window > 0 ? step.clientReceived / window : 0,
			offeredPerSec:
				window > 0 ? step.originator.scheduledDatagrams / window : 0,
			fanout: step.fanout ?? null,
			forwardOverrun:
				step.shape === "fanout" && step.fanout
					? (summarize(step.fanout.forwardSettle)?.p99Ns ?? 0) >=
						(step.originator.gridPeriodNs ?? 0)
					: null,
		};
	});
}

export type ProfileVerdict = {
	profile: EgressProfile;
	emitter: EgressEmitter;
	armComplete: boolean;
	/** Highest complete aggregate rate under each gate, or null if none. */
	capacityRealtimePerSec: number | null;
	capacityFramePerSec: number | null;
	/**
	 * True when no complete rung above the capacity was ever seen to *fail* the
	 * gate — the pre-registration's own "no crossing observed" clause. A rung
	 * excluded by a STOP is evidence of nothing and neither establishes nor
	 * refutes a crossing, so it cannot turn a floor into a point estimate.
	 */
	realtimeIsFloor: boolean;
	frameIsFloor: boolean;
};

/** A profile whose every rung at or above 32,600 /s stopped contributes nothing. */
const ARM_FLOOR_AGGREGATE = 32_600;

export function verdictForProfile(
	profile: EgressProfile,
	emitter: EgressEmitter,
	steps: ClassifiedStep[],
): ProfileVerdict {
	const own = steps.filter(
		(s) =>
			s.profile === profile && s.shape === "ladder" && s.emitter === emitter,
	);
	const atOrAboveFloor = own.filter(
		(s) => s.aggregateRate >= ARM_FLOOR_AGGREGATE,
	);
	const armComplete =
		own.length > 0 &&
		(atOrAboveFloor.length === 0 || atOrAboveFloor.some((s) => s.complete));

	const complete = own.filter((s) => s.complete);
	const under = (gate: number) =>
		complete
			.filter((s) => s.oneWay.p99Ns < gate)
			.reduce<number | null>(
				(a, b) => (a === null || b.aggregateRate > a ? b.aggregateRate : a),
				null,
			);
	/** No crossing observed: nothing complete above the capacity failed the gate. */
	const isFloor = (gate: number, capacity: number | null) =>
		capacity !== null &&
		!complete.some((s) => s.aggregateRate > capacity && s.oneWay.p99Ns >= gate);
	const realtime = under(GATE_REALTIME_NS);
	const frame = under(GATE_FRAME_NS);
	return {
		profile,
		emitter,
		armComplete,
		capacityRealtimePerSec: armComplete ? realtime : null,
		capacityFramePerSec: armComplete ? frame : null,
		realtimeIsFloor: isFloor(GATE_REALTIME_NS, realtime),
		frameIsFloor: isFloor(GATE_FRAME_NS, frame),
	};
}

/**
 * CPU-symmetry tolerance between two compared arms, registered in
 * `docs/research/preregistrations/gate-g3.md` §7 before any CPU reading from
 * this gate existed. Both numbers are percent-of-one-core, the unit the effort
 * spec binds every axis to (a 4 vCPU box reads up to 400).
 */
export const CPU_SYMMETRY_SERVER_PCT = 10;
export const CPU_SYMMETRY_HOST_PCT = 20;
/** Delivery-ratio gap past which a paired comparison is confounded. */
export const AB_CONFOUND_DELIVERY = 0.02;

export type PairSymmetry = {
	serverCpuGapPct: number;
	hostCpuGapPct: number | null;
	cpuSymmetric: boolean;
	abConfounded: boolean;
};

/**
 * Is a paired comparison between two arms measurable, or only disclosable?
 *
 * The spec allows the alignment cost to be re-measured "only with CPU symmetry
 * between compared arms (or disclosed asymmetry + tolerance)". An asymmetric
 * pair is not discarded — it is published with both CPU numbers and the gap,
 * and it carries no bucket verdict.
 */
export function pairSymmetry(
	a: ClassifiedStep,
	b: ClassifiedStep,
): PairSymmetry {
	const serverGap = Math.abs(a.serverCpuPct - b.serverCpuPct);
	const hostGap =
		a.hostCpuPctMedian !== null && b.hostCpuPctMedian !== null
			? Math.abs(a.hostCpuPctMedian - b.hostCpuPctMedian)
			: null;
	return {
		serverCpuGapPct: serverGap,
		hostCpuGapPct: hostGap,
		cpuSymmetric:
			serverGap <= CPU_SYMMETRY_SERVER_PCT &&
			(hostGap === null || hostGap <= CPU_SYMMETRY_HOST_PCT),
		abConfounded:
			Math.abs((a.downDeliveryRatio ?? 1) - (b.downDeliveryRatio ?? 1)) >
			AB_CONFOUND_DELIVERY,
	};
}

export type AlignmentComparison = {
	emitter: EgressEmitter;
	block: number | null;
	aggregateRate: number;
	deltaMs: number;
	/** Null when the pair is CPU-asymmetric: disclosed, never bucketed. */
	bucket: AlignmentBucket | null;
	abConfounded: boolean;
	cpuSymmetric: boolean;
	serverCpuGapPct: number;
	hostCpuGapPct: number | null;
};

/**
 * `keyframe-aligned` minus `frame-bursty` at equal offered rate, **inside one
 * emitter arm and paired inside one replicate block**.
 *
 * Pairing across arms would compare alignment against an originator change, and
 * pairing across blocks would let the box's drift into the number; both are the
 * confounds this gate's block design exists to remove.
 */
export function compareAlignment(
	steps: ClassifiedStep[],
): AlignmentComparison[] {
	const bursty = steps.filter(
		(s) => s.profile === "frame-bursty" && s.complete,
	);
	const aligned = steps.filter(
		(s) => s.profile === "keyframe-aligned" && s.complete,
	);
	const out: AlignmentComparison[] = [];
	for (const a of aligned) {
		const b = bursty.find(
			(s) =>
				s.perSessionRate === a.perSessionRate &&
				s.emitter === a.emitter &&
				s.block === a.block,
		);
		if (!b) continue;
		const delta = a.oneWay.p99Ns - b.oneWay.p99Ns;
		const sym = pairSymmetry(a, b);
		out.push({
			emitter: a.emitter,
			block: a.block,
			aggregateRate: b.aggregateRate,
			deltaMs: delta / MS,
			bucket: sym.cpuSymmetric ? alignmentBucketFor(delta) : null,
			abConfounded: sym.abConfounded,
			cpuSymmetric: sym.cpuSymmetric,
			serverCpuGapPct: sym.serverCpuGapPct,
			hostCpuGapPct: sym.hostCpuGapPct,
		});
	}
	return out;
}

/**
 * Median with the distribution-free order-statistic interval `[min, max]`.
 *
 * For `n` replicates the pair `(k=1, k=n)` covers the true median with
 * probability `1 − 2^(1−n)` — 93.75 % at the registered n = 5. There is no
 * distributional assumption anywhere in it, which is why the pre-registration
 * chose it over anything with a standard error in it.
 */
export function orderStatistic(values: number[]): {
	n: number;
	median: number | null;
	low: number | null;
	high: number | null;
	coverage: number | null;
} {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0)
		return { n, median: null, low: null, high: null, coverage: null };
	const mid =
		n % 2 === 1
			? (sorted[(n - 1) / 2] as number)
			: ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2;
	return {
		n,
		median: mid,
		low: sorted[0] as number,
		high: sorted[n - 1] as number,
		coverage: n > 1 ? 1 - 2 ** (1 - n) : null,
	};
}

export type LeverReading =
	| "lever-positive"
	| "lever-negative"
	| "lever-inconclusive";

export type EmitterComparison = {
	profile: EgressProfile;
	aggregateRate: number;
	/** The arm under test, and the arm it is stated against. */
	emitter: EgressEmitter;
	against: EgressEmitter;
	/** Blocks where both arms were complete. */
	pairedBlocks: number[];
	/** Blocks dropped from the median because the pair was confounded. */
	confoundedBlocks: number[];
	/** Blocks whose pair was CPU-asymmetric — disclosed, still counted. */
	asymmetricBlocks: number[];
	deltaMsByBlock: Array<{
		block: number | null;
		deltaMs: number;
		abConfounded: boolean;
		cpuSymmetric: boolean;
		serverCpuGapPct: number;
		hostCpuGapPct: number | null;
	}>;
	medianDeltaMs: number | null;
	lowDeltaMs: number | null;
	highDeltaMs: number | null;
	coverage: number | null;
	reading: LeverReading | null;
	/** True when ≥ 2 blocks were confounded: the whole reading is advisory. */
	advisory: boolean;
};

/**
 * The lever value, paired inside a block: `p99(emitter) − p99(against)`.
 *
 * Negative means the arm under test is faster. A median on the good side of
 * zero whose interval crosses zero is `lever-inconclusive`, in those words —
 * the pre-registration fixed that reading before the run so it could not be
 * argued into a win afterwards.
 */
export function compareEmitters(
	steps: ClassifiedStep[],
	profile: EgressProfile,
	emitter: EgressEmitter,
	against: EgressEmitter,
): EmitterComparison {
	const own = steps.filter((s) => s.profile === profile && s.complete);
	const rows: EmitterComparison["deltaMsByBlock"] = [];
	const paired: number[] = [];
	const confounded: number[] = [];
	const asymmetric: number[] = [];
	let aggregateRate = 0;
	for (const a of own.filter((s) => s.emitter === emitter)) {
		const b = own.find(
			(s) =>
				s.emitter === against &&
				s.block === a.block &&
				s.perSessionRate === a.perSessionRate,
		);
		if (!b) continue;
		const sym = pairSymmetry(a, b);
		aggregateRate = Math.max(aggregateRate, a.aggregateRate);
		if (a.block !== null) paired.push(a.block);
		if (sym.abConfounded && a.block !== null) confounded.push(a.block);
		if (!sym.cpuSymmetric && a.block !== null) asymmetric.push(a.block);
		rows.push({
			block: a.block,
			deltaMs: (a.oneWay.p99Ns - b.oneWay.p99Ns) / MS,
			abConfounded: sym.abConfounded,
			cpuSymmetric: sym.cpuSymmetric,
			serverCpuGapPct: sym.serverCpuGapPct,
			hostCpuGapPct: sym.hostCpuGapPct,
		});
	}
	// A confounded block's delta is published and excluded from the median: an
	// arm that dropped more shows a better tail for free.
	const stat = orderStatistic(
		rows.filter((r) => !r.abConfounded).map((r) => r.deltaMs),
	);
	const reading: LeverReading | null =
		stat.low === null || stat.high === null
			? null
			: stat.high < 0
				? "lever-positive"
				: stat.low > 0
					? "lever-negative"
					: "lever-inconclusive";
	return {
		profile,
		aggregateRate,
		emitter,
		against,
		pairedBlocks: paired,
		confoundedBlocks: confounded,
		asymmetricBlocks: asymmetric,
		deltaMsByBlock: rows,
		medianDeltaMs: stat.median,
		lowDeltaMs: stat.low,
		highDeltaMs: stat.high,
		coverage: stat.coverage,
		reading,
		advisory: confounded.length >= 2,
	};
}

export type FanoutVerdict = {
	/** Which registered sweep this rung belongs to. Rungs never cross sweeps. */
	mode: "per-subscriber" | "constant-aggregate" | "unknown";
	subscribers: number;
	publisherRatePerSec: number;
	/** Forward egress the server had to originate: publisher rate × N. */
	forwardAggregatePerSec: number;
	complete: boolean;
	stop: StopReason | null;
	p99Ms: number;
	bucket: EgressBucket | null;
	forwardDeliveryRatio: number | null;
	forwardOverrun: boolean | null;
	/** Publisher actual-send → first forward issue. Falsifier 1 reads its p50. */
	ingestToForwardP50Ms: number | null;
	/** The send-cost instrument the retracted run left hardcoded empty. */
	forwardIssueSpreadP99Ms: number | null;
	forwardIssuePerTargetNs: number | null;
	ingestReal: boolean | null;
	ingestUnrealReasons: string[];
	precheck: "pass" | "sink-saturation" | "sink-precheck-inconclusive" | null;
	/**
	 * p99(N) / p99(smallest **complete** N of the same sweep). Reported raw, with
	 * no bucket, because no expectation for its shape was registered and
	 * inventing one after the fact is what the pre-registration exists to
	 * prevent. Null until a complete rung exists to divide by — a scaling curve
	 * anchored on an incomplete rung is a curve about nothing.
	 */
	scaling: number | null;
};

/**
 * One entry per fan-out rung, grouped by sweep.
 *
 * The grouping is not cosmetic: a `per-subscriber` rung and a
 * `constant-aggregate` rung at the same N carry different forward load, so a
 * scaling ratio computed across them would be the rate effect wearing N's name
 * — the confound that got the original fan-out arm retracted.
 */
export function summarizeFanout(steps: ClassifiedStep[]): FanoutVerdict[] {
	const fan = steps
		.filter((s) => s.shape === "fanout")
		.sort((a, b) => a.sessionsConnected - b.sessionsConnected);
	const baselines = new Map<string, number>();
	for (const s of fan) {
		if (!s.complete) continue;
		const key = s.fanout?.mode ?? "unknown";
		if (!baselines.has(key)) baselines.set(key, s.oneWay.p99Ns);
	}
	return fan.map((s) => {
		const mode = s.fanout?.mode ?? "unknown";
		const base = baselines.get(mode) ?? 0;
		const issue = summarize(s.fanout?.forwardIssueSpread ?? null);
		const perTarget =
			issue && s.sessionsConnected > 0
				? issue.meanNs / s.sessionsConnected
				: null;
		return {
			mode,
			subscribers: s.sessionsConnected,
			publisherRatePerSec: s.fanout?.publisherRatePerSec ?? s.perSessionRate,
			forwardAggregatePerSec: s.aggregateRate,
			complete: s.complete,
			stop: s.stop,
			p99Ms: s.oneWay.p99Ns / MS,
			bucket: s.bucket,
			forwardDeliveryRatio: s.fanout?.forwardDeliveryRatio ?? null,
			forwardOverrun: s.forwardOverrun,
			ingestToForwardP50Ms: s.fanout
				? (summarize(s.fanout.ingestToForward)?.p50Ns ?? 0) / MS
				: null,
			forwardIssueSpreadP99Ms: issue ? issue.p99Ns / MS : null,
			forwardIssuePerTargetNs: perTarget,
			ingestReal: s.fanout?.ingestReality.real ?? null,
			ingestUnrealReasons: s.fanout?.ingestReality.reasons ?? [],
			precheck: s.fanout?.precheck.outcome ?? null,
			// Only a complete rung anchors the curve, and only within its sweep.
			scaling: s.complete && base > 0 ? s.oneWay.p99Ns / base : null,
		};
	});
}

export type RunVerdict = {
	complete: boolean;
	stop:
		| "harness-falsifier"
		| "generator-headroom"
		| "constant-arm-incomplete"
		/**
		 * No ladder step was present to set the headroom rule's denominator — a
		 * fan-out-only fragment set, for instance. The rule is about the JS
		 * scheduler and there was no scheduler arm to hold to it, so it was not
		 * evaluated. The run still claims nothing; it just says so accurately
		 * instead of reporting a STOP that never ran.
		 */
		| "headroom-not-evaluated"
		| null;
	generatorCeilingPerSec: number;
	/** The denominator of the headroom rule: offered load, not delivered. */
	maxOfferedPerSec: number;
	/** Reported beside it, so the gap between demanded and delivered is visible. */
	maxDeliveredPerSec: number;
	headroomRatio: number | null;
	headroomBurnNs: number;
	/** Which originator arm this verdict is about. A ceiling never crosses arms. */
	emitter: EgressEmitter;
};

/** The registered headroom factor. Do not touch. */
export const HEADROOM_FACTOR = 1.5;

/**
 * The run-level gate the maintainer made non-negotiable, as amended.
 *
 * The originator must demonstrably have been able to source materially more
 * than the ladder *asked of it*, measured on the loaded box. Two properties do
 * the work, and the arm this replaced had neither: the ceiling comes from a
 * loaded-server arm rather than an idle one, and the denominator is the profile
 * generator's own offered rate rather than delivered throughput — a
 * generator-bound run depresses delivered, so dividing by it made the rule pass
 * precisely when it should have fired.
 */
export function verdictForRun(
	allSteps: ClassifiedStep[],
	headroom: HeadroomFragment | null,
	profiles: ProfileVerdict[],
	emitter: EgressEmitter = "serial",
): RunVerdict {
	// Per arm (gate-g3 §H2): an arm that could not honestly source its own load
	// contributes nothing, and holding it to another arm's ceiling — or lending
	// it one — would be the failure this rule exists to catch.
	const steps = allSteps.filter((s) => s.emitter === emitter);
	const generatorCeilingPerSec = headroom?.ceilingPerSec ?? 0;
	const burnNs = headroom?.burnNs ?? 0;
	// Offered, over the complete rungs only: an incomplete rung supports no
	// capacity claim, so it sets no bar for the generator either.
	// Ladder steps only, exactly as amendment 1 words it ("across the run's
	// complete *ladder* steps"). The headroom arm measured the JS scheduler; the
	// fan-out's originator is a forward loop driven by arrivals, and holding the
	// scheduler to a bar set by a different originator would compare two things.
	// The JS-scheduler shapes only — the ladder and the gate's block arms. The
	// fan-out's originator is a forward loop driven by arrivals, and holding the
	// scheduler to a bar set by a different originator would compare two things.
	const maxOffered = steps.reduce(
		(a, s) =>
			s.complete && (s.shape === "ladder" || s.shape === "gate")
				? Math.max(a, s.offeredPerSec)
				: a,
		0,
	);
	const maxDelivered = steps.reduce(
		(a, s) => Math.max(a, s.deliveredPerSec),
		0,
	);
	const ratio = maxOffered > 0 ? generatorCeilingPerSec / maxOffered : null;
	const base = {
		emitter,
		generatorCeilingPerSec,
		maxOfferedPerSec: maxOffered,
		maxDeliveredPerSec: maxDelivered,
		headroomRatio: ratio,
		headroomBurnNs: burnNs,
	};
	// A starved originator is a proof that the STOP fires, never a measurement.
	if (burnNs > 0) {
		return { complete: false, stop: "harness-falsifier", ...base };
	}
	// The two run-level STOPs are unordered in the pre-registration; the control
	// arm is checked first because a run whose control collapsed has no offered
	// load for the headroom rule to divide by, and would otherwise be reported
	// under the less specific of the two names.
	const constant = profiles.find(
		(p) => p.profile === "constant" && p.emitter === emitter,
	);
	if (constant && !constant.armComplete) {
		return { complete: false, stop: "constant-arm-incomplete", ...base };
	}
	if (maxOffered === 0) {
		return { complete: false, stop: "headroom-not-evaluated", ...base };
	}
	if (ratio === null || ratio < HEADROOM_FACTOR) {
		return { complete: false, stop: "generator-headroom", ...base };
	}
	return { complete: true, stop: null, ...base };
}

/**
 * Gate G3's own verdict, transcribed from
 * `docs/research/preregistrations/gate-g3.md` §6. Nothing here decides
 * anything; every threshold and every name below was fixed before the run.
 */
export type GateG3Verdict = {
	rungAggregatePerSec: number;
	profile: EgressProfile;
	/** C1 — every block of the batch arm complete. */
	c1: {
		verdict: "PASS" | "INCOMPLETE";
		blocks: number;
		completeBlocks: number;
		stops: Array<{ block: number | null; stop: StopReason | null }>;
	};
	/** C2 — egressOneWay p99 under the frame gate, on the batch arm. */
	c2: {
		verdict: "PASS" | "INCONCLUSIVE-AT-BAR" | "FAIL" | "INCOMPLETE";
		medianP99Ms: number | null;
		lowP99Ms: number | null;
		highP99Ms: number | null;
		coverage: number | null;
		barMs: number;
	};
	/** C3 — the lever value, stated as (c) vs (b), never (c) vs (a). */
	c3: {
		verdict:
			| "MEASURED"
			| "CEILING-MOVED"
			| "CEILING-MOVED-AGAINST"
			| "INCOMPLETE";
		statedAgainst: EgressEmitter;
		comparison: EmitterComparison | null;
		/** Published as a diagnostic only, per the spec's explicit instruction. */
		diagnosticVsSerial: EmitterComparison | null;
		ceilings: Partial<Record<EgressEmitter, number>>;
		headroomRatios: Partial<Record<EgressEmitter, number | null>>;
	};
	/** C4 — the instrumentation obligation. */
	c4: {
		verdict: "PASS" | "INCOMPLETE";
		gsoRead: boolean;
		stepsWithUdpCounters: number;
		steps: number;
	};
	/** Inherited from G2's stamp and carried on this gate's face. */
	crossCheckR4: "open";
};

export function gateVerdictG3(
	steps: ClassifiedStep[],
	runs: RunVerdict[],
	gsoRead: boolean,
	profile: EgressProfile = "frame-bursty",
): GateG3Verdict {
	const gateSteps = steps.filter(
		(s) => s.shape === "gate" && s.profile === profile,
	);
	const batch = gateSteps.filter((s) => s.emitter === "batch");
	const blocks = new Set(batch.map((s) => s.block)).size;
	const completeBlocks = batch.filter((s) => s.complete).length;
	const c1Pass = blocks > 0 && completeBlocks === batch.length;

	const p99s = batch.filter((s) => s.complete).map((s) => s.oneWay.p99Ns / MS);
	const stat = orderStatistic(p99s);
	const barMs = GATE_FRAME_NS / MS;
	const c2Verdict = !c1Pass
		? "INCOMPLETE"
		: stat.median === null || stat.high === null
			? "INCOMPLETE"
			: stat.median >= barMs
				? "FAIL"
				: stat.high < barMs
					? "PASS"
					: "INCONCLUSIVE-AT-BAR";

	const honest = (emitter: EgressEmitter) => {
		const run = runs.find((r) => r.emitter === emitter);
		const own = gateSteps.filter((s) => s.emitter === emitter);
		return (
			(run?.complete ?? false) && own.length > 0 && own.every((s) => s.complete)
		);
	};
	const ceilings: Partial<Record<EgressEmitter, number>> = {};
	const headroomRatios: Partial<Record<EgressEmitter, number | null>> = {};
	for (const r of runs) {
		ceilings[r.emitter] = r.generatorCeilingPerSec;
		headroomRatios[r.emitter] = r.headroomRatio;
	}

	// §H5, registered before the run: if one side of the pair could not honestly
	// source the load and the other could, the lever's value is that the
	// originator's ceiling moved — and the gate reports that instead of a tail
	// delta it has no honest pair for.
	const batchHonest = honest("batch");
	const pipelinedHonest = honest("pipelined");
	const c3Verdict =
		batchHonest && pipelinedHonest
			? "MEASURED"
			: batchHonest && !pipelinedHonest
				? "CEILING-MOVED"
				: !batchHonest && pipelinedHonest
					? "CEILING-MOVED-AGAINST"
					: "INCOMPLETE";

	const withUdp = gateSteps.filter((s) => s.udp !== null).length;

	return {
		rungAggregatePerSec: Math.max(0, ...gateSteps.map((s) => s.aggregateRate)),
		profile,
		c1: {
			verdict: c1Pass ? "PASS" : "INCOMPLETE",
			blocks,
			completeBlocks,
			stops: batch.map((s) => ({ block: s.block, stop: s.stop })),
		},
		c2: {
			verdict: c2Verdict,
			medianP99Ms: stat.median,
			lowP99Ms: stat.low,
			highP99Ms: stat.high,
			coverage: stat.coverage,
			barMs,
		},
		c3: {
			verdict: c3Verdict,
			statedAgainst: "pipelined",
			comparison:
				c3Verdict === "MEASURED"
					? compareEmitters(steps, profile, "batch", "pipelined")
					: null,
			diagnosticVsSerial: honest("serial")
				? compareEmitters(steps, profile, "batch", "serial")
				: null,
			ceilings,
			headroomRatios,
		},
		c4: {
			verdict:
				gsoRead && gateSteps.length > 0 && withUdp === gateSteps.length
					? "PASS"
					: "INCOMPLETE",
			gsoRead,
			stepsWithUdpCounters: withUdp,
			steps: gateSteps.length,
		},
		// G2's stamp records R4 inconclusive; this gate inherits it and does not
		// close it. Its egress p99 and G2's ingest p99 are not comparable units.
		crossCheckR4: "open",
	};
}

export function classify(fragments: Fragment[]) {
	// One headroom fragment per arm: the ceiling never crosses arms, so neither
	// does the fragment that carries it.
	const headroomByEmitter = new Map<EgressEmitter, HeadroomFragment>();
	for (const f of fragments) {
		if (f.shape !== "headroom" || !f.headroom) continue;
		headroomByEmitter.set(f.headroom.emitter ?? "serial", f.headroom);
	}
	const headroom = headroomByEmitter.get("serial") ?? null;
	const gso = fragments.find((f) => f.gso)?.gso ?? null;
	const residualNs = fragments.reduce(
		(a, f) => Math.max(a, f.clock?.calibrationResidualNs ?? 0),
		0,
	);
	const raw = fragments.flatMap((f) => f.steps ?? []);
	const steps = classifySteps(raw, residualNs);
	const emitters = [
		...new Set([...steps.map((s) => s.emitter), ...headroomByEmitter.keys()]),
	];
	const profiles = emitters.flatMap((emitter) =>
		[
			...new Set(
				steps
					.filter((s) => s.shape === "ladder" && s.emitter === emitter)
					.map((s) => s.profile),
			),
		].map((p) => verdictForProfile(p, emitter, steps)),
	);
	const runs = emitters.map((emitter) =>
		verdictForRun(
			steps,
			headroomByEmitter.get(emitter) ?? null,
			profiles,
			emitter,
		),
	);
	// The run-level statement over every arm: complete only if every arm that ran
	// cleared its own headroom rule, and named by the first arm that did not.
	const failed = runs.find((r) => !r.complete);
	const run = failed ?? runs[0] ?? verdictForRun(steps, headroom, profiles);
	const gateSteps = steps.filter((s) => s.shape === "gate");
	const gateProfiles = [...new Set(gateSteps.map((s) => s.profile))];

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		preregistration: "docs/research/preregistrations/egress.md",
		gatePreregistration: "docs/research/preregistrations/gate-g3.md",
		gates: {
			realtimeMs: GATE_REALTIME_NS / MS,
			frameMs: GATE_FRAME_NS / MS,
		},
		clockResidualNs: residualNs,
		gso,
		headroom,
		headroomByEmitter: Object.fromEntries(headroomByEmitter),
		run,
		runs,
		profiles,
		alignment: compareAlignment(steps),
		emitterComparisons: gateProfiles.flatMap((p) => [
			compareEmitters(steps, p, "batch", "pipelined"),
			compareEmitters(steps, p, "batch", "serial"),
			compareEmitters(steps, p, "pipelined", "serial"),
		]),
		gateG3:
			gateSteps.length > 0 ? gateVerdictG3(steps, runs, gso !== null) : null,
		fanout: summarizeFanout(steps),
		steps,
	};
}

if (import.meta.main) {
	const [out, ...inputs] = process.argv.slice(2);
	if (!out || inputs.length === 0) {
		console.error(
			"usage: bun tools/load/egress-classify.ts <out.json> <fragment.json...>",
		);
		process.exit(2);
	}
	const fragments = inputs.map(
		(p) => JSON.parse(readFileSync(p, "utf8")) as Fragment,
	);
	const result = classify(fragments);
	writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);

	console.log(
		`egress-classify: run complete=${result.run.complete} stop=${result.run.stop ?? "none"}`,
	);
	if (result.gso) {
		console.log(
			`egress-classify: quinn-udp maxGsoSegments=${result.gso.maxGsoSegments ?? "n/a"} groSegments=${result.gso.groSegments ?? "n/a"} (capability, not a per-send segment count)`,
		);
	}
	for (const r of result.runs) {
		console.log(
			`egress-classify: arm ${r.emitter} complete=${r.complete} stop=${r.stop ?? "none"} ceiling=${r.generatorCeilingPerSec.toFixed(0)}/s (loaded) maxOffered=${r.maxOfferedPerSec.toFixed(0)}/s maxDelivered=${r.maxDeliveredPerSec.toFixed(0)}/s headroom=${r.headroomRatio?.toFixed(2) ?? "n/a"}x`,
		);
	}
	if (result.run.headroomBurnNs > 0) {
		console.log(
			`egress-classify: EGRESS_HEADROOM_BURN_NS=${result.run.headroomBurnNs} — falsifier artifact, no capacity number may be read from this run`,
		);
	}
	if (result.gateG3) {
		const g = result.gateG3;
		console.log(
			`egress-classify: G3 rung=${g.rungAggregatePerSec}/s ${g.profile} C1=${g.c1.verdict} (${g.c1.completeBlocks}/${g.c1.stops.length} batch arms complete, ${g.c1.blocks} blocks)`,
		);
		console.log(
			`egress-classify: G3 C2=${g.c2.verdict} batch p99 median=${g.c2.medianP99Ms?.toFixed(3) ?? "n/a"}ms [${g.c2.lowP99Ms?.toFixed(3) ?? "n/a"}, ${g.c2.highP99Ms?.toFixed(3) ?? "n/a"}] coverage=${g.c2.coverage?.toFixed(4) ?? "n/a"} bar=${g.c2.barMs}ms`,
		);
		const c = g.c3.comparison;
		console.log(
			`egress-classify: G3 C3=${g.c3.verdict} lever (batch vs pipelined)=` +
				(c
					? `${c.reading} median=${c.medianDeltaMs?.toFixed(3) ?? "n/a"}ms [${c.lowDeltaMs?.toFixed(3) ?? "n/a"}, ${c.highDeltaMs?.toFixed(3) ?? "n/a"}] n=${c.pairedBlocks.length}${c.advisory ? " ADVISORY" : ""}`
					: "not available — one side of the pair is not a measurement") +
				` ceilings=${JSON.stringify(g.c3.ceilings)}`,
		);
		console.log(
			`egress-classify: G3 C4=${g.c4.verdict} udpCounters=${g.c4.stepsWithUdpCounters}/${g.c4.steps} gsoRead=${g.c4.gsoRead}; cross-check R4 is ${g.crossCheckR4} — G2 ingest p99 and this egress p99 are NOT comparable units`,
		);
	}
	for (const c of result.emitterComparisons) {
		if (c.deltaMsByBlock.length === 0) continue;
		console.log(
			`egress-classify: ${c.profile} ${c.emitter} vs ${c.against}: ${c.reading ?? "n/a"} median=${c.medianDeltaMs?.toFixed(3) ?? "n/a"}ms [${c.lowDeltaMs?.toFixed(3) ?? "n/a"}, ${c.highDeltaMs?.toFixed(3) ?? "n/a"}] paired=${c.pairedBlocks.length} confounded=${c.confoundedBlocks.length} cpuAsymmetric=${c.asymmetricBlocks.length}`,
		);
	}
	for (const a of result.alignment) {
		console.log(
			`egress-classify: alignment ${a.emitter} block=${a.block ?? "n/a"} agg=${a.aggregateRate}/s delta=${a.deltaMs.toFixed(3)}ms ${a.bucket ?? "cpu-asymmetric (disclosed, no bucket)"} serverCpuGap=${a.serverCpuGapPct.toFixed(1)} hostCpuGap=${a.hostCpuGapPct?.toFixed(1) ?? "n/a"}${a.abConfounded ? " ab-confounded" : ""}`,
		);
	}
	for (const p of result.profiles) {
		console.log(
			`egress-classify: ${p.profile}/${p.emitter} armComplete=${p.armComplete} capacity(p99<5ms)=${p.capacityRealtimePerSec ?? "none"}${p.realtimeIsFloor ? "+" : ""}/s capacity(p99<33.3ms)=${p.capacityFramePerSec ?? "none"}${p.frameIsFloor ? "+" : ""}/s`,
		);
	}
	for (const f of result.fanout) {
		console.log(
			`egress-classify: fanout/${f.mode} N=${f.subscribers} pub=${f.publisherRatePerSec}/s forward=${f.forwardAggregatePerSec}/s ` +
				`${f.complete ? (f.bucket ?? "") : `INCOMPLETE(${f.stop})`} p99=${f.p99Ms.toFixed(2)}ms ` +
				`fwdDelivery=${f.forwardDeliveryRatio?.toFixed(4) ?? "n/a"} scaling=${f.scaling?.toFixed(2) ?? "n/a"} ` +
				`ingestToForward p50=${f.ingestToForwardP50Ms?.toFixed(3) ?? "n/a"}ms issueSpread p99=${f.forwardIssueSpreadP99Ms?.toFixed(3) ?? "n/a"}ms ` +
				`perTarget=${f.forwardIssuePerTargetNs?.toFixed(0) ?? "n/a"}ns precheck=${f.precheck ?? "n/a"} ` +
				`ingestReal=${f.ingestReal ?? "n/a"}${f.ingestUnrealReasons.length > 0 ? ` (${f.ingestUnrealReasons.join(",")})` : ""}` +
				`${f.forwardOverrun ? " forward-overrun" : ""}`,
		);
	}
	for (const s of result.steps) {
		console.log(
			`egress-classify: ${s.shape}/${s.profile}/${s.emitter}${s.block !== null ? ` block=${s.block}` : ""} agg=${s.aggregateRate}/s ${s.complete ? (s.bucket ?? "") : `INCOMPLETE(${s.stop})`} p50=${(s.oneWay.p50Ns / MS).toFixed(2)}ms p99=${(s.oneWay.p99Ns / MS).toFixed(2)}ms p999=${(s.oneWay.p999Ns / MS).toFixed(2)}ms down=${s.downDeliveryRatio?.toFixed(3) ?? "n/a"}`,
		);
	}
	console.log(`egress-classify: wrote ${out}`);
}
