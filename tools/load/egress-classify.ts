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
	| "sample-starvation";

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

export type Fragment = {
	shape: "ladder" | "fanout" | "generator";
	profile?: EgressProfile;
	clock: { calibrationResidualNs: number; source: string };
	config?: Record<string, unknown>;
	generator?: {
		ceilingPerSec: number;
		rungs: Array<Record<string, unknown>>;
	};
	steps?: RawStep[];
};

type RawStep = {
	shape: "ladder" | "fanout";
	profile: EgressProfile;
	perSessionRate: number;
	sessionsRequested: number;
	sessionsConnected: number;
	aggregateRate: number;
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
		effectiveRatePerSession: number;
	};
	clientReceived: number;
	client: {
		egressOneWay: LatencyHistogramJson;
		endToEnd: LatencyHistogramJson;
		recvUnstamped: number;
	} | null;
	downDeliveryRatio: number | null;
	hostCpuPctMedian: number | null;
	serverCpuPct: number;
	ingested: number;
	forwardLag: LatencyHistogramJson | null;
};

export type ClassifiedStep = {
	shape: "ladder" | "fanout";
	profile: EgressProfile;
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
	serverCpuPct: number;
	deliveredPerSec: number;
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
	const events = step.originator.sendEventsScheduled;
	if (events > 0 && step.originator.sendEventsSkipped >= 0.1 * events) {
		return "generator-saturation";
	}
	if (lagFloorNs > 0 && lag.p99Ns >= 4 * lagFloorNs) {
		return "generator-saturation";
	}

	const scheduled = step.originator.scheduledDatagrams;
	if (scheduled > 0 && step.originator.sent < 0.9 * scheduled) {
		return "offered-shortfall";
	}
	if (step.sessionsConnected < 0.95 * step.sessionsRequested) {
		return "offered-shortfall";
	}

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
		const key = `${step.shape}:${step.profile}`;
		floors.set(key, Math.min(floors.get(key) ?? p99, p99));
	}

	return steps.map((step) => {
		const oneWay = summarize(step.client?.egressOneWay ?? null);
		const endToEnd = summarize(step.client?.endToEnd ?? null);
		const lag =
			summarize(step.originator.originationLag) ??
			new LatencyHistogram().summary();
		const floor = floors.get(`${step.shape}:${step.profile}`) ?? 0;
		const stop = stopFor(step, residualNs, floor, oneWay, endToEnd, lag);
		const complete = stop === null;
		const resolved = oneWay ?? new LatencyHistogram().summary();
		const isFrameArm =
			step.profile === "frame-bursty" ||
			step.profile === "keyframe-aligned" ||
			step.profile === "desktop-share";
		return {
			shape: step.shape,
			profile: step.profile,
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
			coResidenceBound:
				(step.hostCpuPctMedian ?? 0) >= 97 &&
				(step.downDeliveryRatio ?? 1) < 0.95,
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
			serverCpuPct: step.serverCpuPct,
			deliveredPerSec:
				step.elapsedSec > 0 ? step.clientReceived / step.elapsedSec : 0,
		};
	});
}

export type ProfileVerdict = {
	profile: EgressProfile;
	armComplete: boolean;
	/** Highest complete aggregate rate under each gate, or null if none. */
	capacityRealtimePerSec: number | null;
	capacityFramePerSec: number | null;
	/** True when the top rung still cleared the gate: the number is a floor. */
	realtimeIsFloor: boolean;
	frameIsFloor: boolean;
};

/** A profile whose every rung at or above 32,600 /s stopped contributes nothing. */
const ARM_FLOOR_AGGREGATE = 32_600;

export function verdictForProfile(
	profile: EgressProfile,
	steps: ClassifiedStep[],
): ProfileVerdict {
	const own = steps.filter(
		(s) => s.profile === profile && s.shape === "ladder",
	);
	const atOrAboveFloor = own.filter(
		(s) => s.aggregateRate >= ARM_FLOOR_AGGREGATE,
	);
	const armComplete =
		own.length > 0 &&
		(atOrAboveFloor.length === 0 || atOrAboveFloor.some((s) => s.complete));

	const complete = own.filter((s) => s.complete);
	const top = own.reduce(
		(a, b) => (b.aggregateRate > a ? b.aggregateRate : a),
		0,
	);
	const under = (gate: number) =>
		complete
			.filter((s) => s.oneWay.p99Ns < gate)
			.reduce<number | null>(
				(a, b) => (a === null || b.aggregateRate > a ? b.aggregateRate : a),
				null,
			);
	const realtime = under(GATE_REALTIME_NS);
	const frame = under(GATE_FRAME_NS);
	return {
		profile,
		armComplete,
		capacityRealtimePerSec: armComplete ? realtime : null,
		capacityFramePerSec: armComplete ? frame : null,
		realtimeIsFloor: realtime !== null && realtime === top,
		frameIsFloor: frame !== null && frame === top,
	};
}

export type AlignmentComparison = {
	aggregateRate: number;
	deltaMs: number;
	bucket: AlignmentBucket;
	abConfounded: boolean;
};

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
		const b = bursty.find((s) => s.perSessionRate === a.perSessionRate);
		if (!b) continue;
		const delta = a.oneWay.p99Ns - b.oneWay.p99Ns;
		out.push({
			aggregateRate: b.aggregateRate,
			deltaMs: delta / MS,
			bucket: alignmentBucketFor(delta),
			abConfounded:
				Math.abs((a.downDeliveryRatio ?? 1) - (b.downDeliveryRatio ?? 1)) >
				0.02,
		});
	}
	return out;
}

export type FanoutVerdict = {
	subscribers: number;
	complete: boolean;
	stop: StopReason | null;
	p99Ms: number;
	bucket: EgressBucket | null;
	/** p99(N) / p99(smallest N). Reported raw: no expectation was registered. */
	scaling: number | null;
};

export function summarizeFanout(steps: ClassifiedStep[]): FanoutVerdict[] {
	const fan = steps
		.filter((s) => s.shape === "fanout")
		.sort((a, b) => a.sessionsConnected - b.sessionsConnected);
	const base = fan[0]?.oneWay.p99Ns ?? 0;
	return fan.map((s) => ({
		subscribers: s.sessionsConnected,
		complete: s.complete,
		stop: s.stop,
		p99Ms: s.oneWay.p99Ns / MS,
		bucket: s.bucket,
		scaling: base > 0 ? s.oneWay.p99Ns / base : null,
	}));
}

export type RunVerdict = {
	complete: boolean;
	stop: "generator-headroom" | "constant-arm-incomplete" | null;
	generatorCeilingPerSec: number;
	maxDeliveredPerSec: number;
	headroomRatio: number | null;
};

/**
 * The run-level gate the maintainer made non-negotiable: unless the JS
 * originator demonstrably offers materially more than the transport delivered,
 * the ladder measured the generator and the stamp is `incomplete`.
 */
export function verdictForRun(
	steps: ClassifiedStep[],
	generatorCeilingPerSec: number,
	profiles: ProfileVerdict[],
): RunVerdict {
	const maxDelivered = steps.reduce(
		(a, s) => Math.max(a, s.deliveredPerSec),
		0,
	);
	const ratio = maxDelivered > 0 ? generatorCeilingPerSec / maxDelivered : null;
	if (ratio !== null && ratio < 1.5) {
		return {
			complete: false,
			stop: "generator-headroom",
			generatorCeilingPerSec,
			maxDeliveredPerSec: maxDelivered,
			headroomRatio: ratio,
		};
	}
	const constant = profiles.find((p) => p.profile === "constant");
	if (constant && !constant.armComplete) {
		return {
			complete: false,
			stop: "constant-arm-incomplete",
			generatorCeilingPerSec,
			maxDeliveredPerSec: maxDelivered,
			headroomRatio: ratio,
		};
	}
	return {
		complete: true,
		stop: null,
		generatorCeilingPerSec,
		maxDeliveredPerSec: maxDelivered,
		headroomRatio: ratio,
	};
}

export function classify(fragments: Fragment[]) {
	const generator = fragments.find((f) => f.shape === "generator")?.generator;
	const residualNs = fragments.reduce(
		(a, f) => Math.max(a, f.clock?.calibrationResidualNs ?? 0),
		0,
	);
	const raw = fragments.flatMap((f) => f.steps ?? []);
	const steps = classifySteps(raw, residualNs);
	const profiles = [
		...new Set(steps.filter((s) => s.shape === "ladder").map((s) => s.profile)),
	].map((p) => verdictForProfile(p, steps));
	const run = verdictForRun(steps, generator?.ceilingPerSec ?? 0, profiles);

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		preregistration: "docs/research/preregistrations/egress.md",
		gates: {
			realtimeMs: GATE_REALTIME_NS / MS,
			frameMs: GATE_FRAME_NS / MS,
		},
		clockResidualNs: residualNs,
		generator: generator ?? null,
		run,
		profiles,
		alignment: compareAlignment(steps),
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
	console.log(
		`egress-classify: generator ceiling=${result.run.generatorCeilingPerSec}/s maxDelivered=${result.run.maxDeliveredPerSec.toFixed(0)}/s headroom=${result.run.headroomRatio?.toFixed(2) ?? "n/a"}x`,
	);
	for (const p of result.profiles) {
		console.log(
			`egress-classify: ${p.profile} armComplete=${p.armComplete} capacity(p99<5ms)=${p.capacityRealtimePerSec ?? "none"}${p.realtimeIsFloor ? "+" : ""}/s capacity(p99<33.3ms)=${p.capacityFramePerSec ?? "none"}${p.frameIsFloor ? "+" : ""}/s`,
		);
	}
	for (const s of result.steps) {
		console.log(
			`egress-classify: ${s.shape}/${s.profile} agg=${s.aggregateRate}/s ${s.complete ? (s.bucket ?? "") : `INCOMPLETE(${s.stop})`} p50=${(s.oneWay.p50Ns / MS).toFixed(2)}ms p99=${(s.oneWay.p99Ns / MS).toFixed(2)}ms p999=${(s.oneWay.p999Ns / MS).toFixed(2)}ms down=${s.downDeliveryRatio?.toFixed(3) ?? "n/a"}`,
		);
	}
	console.log(`egress-classify: wrote ${out}`);
}
