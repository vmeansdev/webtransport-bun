#!/usr/bin/env bun
/**
 * Turn latency arm fragments into verdicts, mechanically.
 *
 * Every rule in this file is transcribed from
 * `docs/research/preregistrations/latency.md`, which was committed before the
 * harness existed. Nothing here decides anything at read time: a step either
 * trips a pre-registered STOP and contributes nothing, or it lands in a
 * pre-registered bucket. The point of separating this from the bench driver is
 * that the classifier can be run again on the same artifacts by someone who
 * does not trust the person who ran them.
 *
 * Usage: `bun tools/load/latency-classify.ts out.json arm1.json arm2.json ...`
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { LatencyStep } from "./bench-latency.ts";
import {
	LatencyHistogram,
	type LatencySummary,
	quantizationNs,
} from "./latency-histogram.ts";

const MS = 1e6;

export type StopReason =
	| "generator-saturation"
	| "offered-shortfall"
	| "clock-invalid"
	| "delivery-collapse"
	| "sample-starvation";

export type LatencyBucket =
	| "ok-realtime"
	| "ok-interactive"
	| "degraded"
	| "unusable";

export type ArmFragment = {
	arm: string;
	clock: { calibrationResidualNs: number; source: string };
	config: {
		sessions: number;
		payloadBytes: number;
		stepSeconds: number;
		arrival: string;
		tickHz: number;
		echo: boolean;
		datagramBatchEnv: string | null;
	};
	steps: LatencyStep[];
};

export type ClassifiedStep = {
	arm: string;
	/** Effective offered rate — the label every curve and every A/B pairs on. */
	aggregateRate: number;
	perSessionRate: number;
	/** What the ladder asked for. Never a label, only a disclosure. */
	nominalAggregateRate: number;
	complete: boolean;
	stop: StopReason | null;
	bucket: LatencyBucket | null;
	tickBucket: "tick-absorbed" | "tick-overrun" | null;
	intraTickSpreadMs: number | null;
	ingest: LatencySummary;
	rtt: LatencySummary | null;
	scheduleLag: LatencySummary | null;
	burstSpread: LatencySummary | null;
	/** The arm's minimum scheduleLag p99 — the platform's timer-wake floor. */
	scheduleLagFloorNs: number;
	ticksSkipped: number;
	sendEvents: number;
	upDeliveryRatio: number | null;
	/**
	 * Largest snapshot skew among this step's histograms — samples a producer
	 * counted but whose buckets its snapshot did not carry. Zero for a quiesced
	 * producer; reported, never a STOP, because it is not a registered rule.
	 */
	histogramSkew: number;
	offeredFraction: number;
	stampedSamples: number;
	hostCpuPctMedian: number | null;
	serverCpuPct: number;
};

/** One 64 Hz period, the tick-absorption boundary. */
const TICK_PERIOD_MS = 15.625;

function bucketFor(p99Ns: number): LatencyBucket {
	const ms = p99Ns / MS;
	if (ms < 1) return "ok-realtime";
	if (ms < 5) return "ok-interactive";
	if (ms < 20) return "degraded";
	return "unusable";
}

/**
 * STOP conditions, in the registered order. First match wins.
 *
 * A missing client latency block maps to `clock-invalid`: rule 3 requires the
 * one-way figure to be bounded by the round trip, and a check that cannot be
 * run has not been passed.
 */
function stopFor(
	step: LatencyStep,
	fragment: ArmFragment,
	ingest: LatencySummary,
	rtt: LatencySummary | null,
	lag: LatencySummary | null,
	lagFloorNs: number,
): StopReason | null {
	if (lag === null || step.client === null) return "clock-invalid";
	// Amendment 1: skipped send events are unambiguous saturation, and lag is
	// judged against this arm's own idle floor so timer-wake granularity is not
	// read as queueing.
	if (
		step.client.ticksSkipped >= 0.1 * Math.max(step.client.sendEvents, 1) ||
		lag.p99Ns >= 4 * Math.max(lagFloorNs, 1)
	) {
		return "generator-saturation";
	}
	if (step.clientSent < 0.9 * step.requestedDatagrams)
		return "offered-shortfall";
	if (
		ingest.negative > 0.001 * Math.max(step.serverStamped, 1) ||
		fragment.clock.calibrationResidualNs > 50_000 ||
		rtt === null ||
		ingest.p99Ns > rtt.p99Ns
	) {
		return "clock-invalid";
	}
	if ((step.upDeliveryRatio ?? 0) < 0.8) return "delivery-collapse";
	if (step.serverStamped < 10_000) return "sample-starvation";
	return null;
}

/**
 * The arm's timer-wake floor: the smallest schedule-lag p99 any of its steps
 * managed. Measured, never assumed, and reported on every row.
 */
export function scheduleLagFloorNs(steps: LatencyStep[]): number {
	const p99s = steps
		.filter((s) => s.client !== null)
		.map((s) =>
			LatencyHistogram.fromJson(
				(s.client as NonNullable<LatencyStep["client"]>).scheduleLag,
			).percentile(0.99),
		);
	return p99s.length > 0 ? Math.min(...p99s) : 0;
}

export function classifyStep(
	step: LatencyStep,
	fragment: ArmFragment,
	lagFloorNs = scheduleLagFloorNs([step]),
): ClassifiedStep {
	const ingest = LatencyHistogram.fromJson(step.ingest).summary();
	const rtt = step.client
		? LatencyHistogram.fromJson(step.client.rtt).summary()
		: null;
	const lag = step.client
		? LatencyHistogram.fromJson(step.client.scheduleLag).summary()
		: null;
	const burstSpread = step.client
		? LatencyHistogram.fromJson(step.client.burstSpread).summary()
		: null;
	const stop = stopFor(step, fragment, ingest, rtt, lag, lagFloorNs);
	const complete = stop === null;
	const isTick = fragment.config.arrival === "tick";
	return {
		arm: fragment.arm,
		aggregateRate: step.aggregateRate,
		perSessionRate: step.perSessionRate,
		nominalAggregateRate: step.nominalAggregateRate,
		complete,
		stop,
		bucket: complete ? bucketFor(ingest.p99Ns) : null,
		tickBucket:
			complete && isTick
				? ingest.p99Ns / MS < TICK_PERIOD_MS
					? "tick-absorbed"
					: "tick-overrun"
				: null,
		intraTickSpreadMs:
			complete && isTick ? (ingest.p99Ns - ingest.p50Ns) / MS : null,
		ingest,
		rtt,
		scheduleLag: lag,
		burstSpread,
		scheduleLagFloorNs: lagFloorNs,
		ticksSkipped: step.client?.ticksSkipped ?? 0,
		sendEvents: step.client?.sendEvents ?? 0,
		upDeliveryRatio: step.upDeliveryRatio,
		histogramSkew: Math.max(
			ingest.skew,
			rtt?.skew ?? 0,
			lag?.skew ?? 0,
			burstSpread?.skew ?? 0,
		),
		offeredFraction:
			step.requestedDatagrams > 0
				? step.clientSent / step.requestedDatagrams
				: 0,
		stampedSamples: step.serverStamped,
		hostCpuPctMedian: step.hostCpuPctMedian,
		serverCpuPct: step.serverCpuPct,
	};
}

export type BatchAbEntry = {
	aggregateRate: number;
	defaultP99Ms: number;
	batch0P99Ms: number;
	deltaMs: number;
	bucket: "batch-helps" | "batch-free" | "batch-cheap" | "batch-expensive";
	confounded: boolean;
	/**
	 * Worst-case histogram quantization on Δ: half a bucket on each arm's p99.
	 * Reported so the bucket can never be quoted more precisely than the
	 * instrument resolves (Amendment 2).
	 */
	deltaUncertaintyMs: number;
	/** `false` when |Δ| is inside its own quantization — the bucket is advisory. */
	resolvable: boolean;
	defaultUpDeliveryRatio: number | null;
	batch0UpDeliveryRatio: number | null;
};

function batchBucket(deltaMs: number): BatchAbEntry["bucket"] {
	if (deltaMs <= -0.2) return "batch-helps";
	if (deltaMs < 0.2) return "batch-free";
	if (deltaMs < 1) return "batch-cheap";
	return "batch-expensive";
}

/**
 * The H7 tail price, only where both arms produced a complete step. An arm that
 * drops more datagrams gets a better tail for free, so a delivery-ratio gap
 * wider than 0.02 marks the comparison confounded and the bucket advisory.
 */
export function classifyBatchAb(steps: ClassifiedStep[]): BatchAbEntry[] {
	const byRate = new Map<
		number,
		{ def?: ClassifiedStep; zero?: ClassifiedStep }
	>();
	for (const step of steps) {
		if (!step.complete) continue;
		// Paired on the effective rate, per the registered "at equal offered
		// rate": two arms that were asked for the same rung but produced
		// different loads are not a comparison.
		const key = Math.round(step.aggregateRate);
		const slot = byRate.get(key) ?? {};
		if (step.arm === "default") slot.def = step;
		if (step.arm === "batch0") slot.zero = step;
		byRate.set(key, slot);
	}
	const out: BatchAbEntry[] = [];
	for (const [aggregateRate, slot] of [...byRate.entries()].sort(
		(a, b) => a[0] - b[0],
	)) {
		if (!slot.def || !slot.zero) continue;
		const defaultP99Ms = slot.def.ingest.p99Ns / MS;
		const batch0P99Ms = slot.zero.ingest.p99Ns / MS;
		const deltaMs = defaultP99Ms - batch0P99Ms;
		const deltaUncertaintyMs =
			(quantizationNs(slot.def.ingest.p99Ns) +
				quantizationNs(slot.zero.ingest.p99Ns)) /
			MS;
		out.push({
			aggregateRate,
			defaultP99Ms,
			batch0P99Ms,
			deltaMs,
			deltaUncertaintyMs,
			resolvable: Math.abs(deltaMs) > deltaUncertaintyMs,
			bucket: batchBucket(deltaMs),
			confounded:
				Math.abs(
					(slot.def.upDeliveryRatio ?? 0) - (slot.zero.upDeliveryRatio ?? 0),
				) > 0.02,
			defaultUpDeliveryRatio: slot.def.upDeliveryRatio,
			batch0UpDeliveryRatio: slot.zero.upDeliveryRatio,
		});
	}
	return out;
}

export type ArmVerdict = {
	arm: string;
	arrival: string;
	datagramBatchEnv: string | null;
	complete: boolean;
	steps: ClassifiedStep[];
	/** Highest complete aggregate rate whose p99 is still under 1 ms. */
	highestRealtimeRate: number | null;
	/** First aggregate rate whose p99 crosses each threshold, complete steps only. */
	crossings: { thresholdMs: number; aggregateRate: number | null }[];
};

function armVerdict(fragment: ArmFragment): ArmVerdict {
	const floorNs = scheduleLagFloorNs(fragment.steps);
	const steps = fragment.steps.map((s) => classifyStep(s, fragment, floorNs));
	// Arm-level STOP: nothing complete at or above 50k means the arm says nothing.
	const complete = steps.some((s) => s.complete && s.aggregateRate >= 50_000);
	const ordered = [...steps].sort((a, b) => a.aggregateRate - b.aggregateRate);
	const realtime = ordered.filter(
		(s) => s.complete && s.bucket === "ok-realtime",
	);
	return {
		arm: fragment.arm,
		arrival: fragment.config.arrival,
		datagramBatchEnv: fragment.config.datagramBatchEnv,
		complete,
		steps: ordered,
		highestRealtimeRate: realtime.at(-1)?.aggregateRate ?? null,
		crossings: [1, 5, 20].map((thresholdMs) => ({
			thresholdMs,
			aggregateRate:
				ordered.find((s) => s.complete && s.ingest.p99Ns / MS >= thresholdMs)
					?.aggregateRate ?? null,
		})),
	};
}

export function classifyRun(fragments: ArmFragment[]) {
	const arms = fragments.map(armVerdict);
	const defaultArm = arms.find((a) => a.arm === "default");
	return {
		version: 1,
		classifiedAt: new Date().toISOString(),
		preregistration: "docs/research/preregistrations/latency.md",
		// Run-level STOP: without a usable `default` arm there is no curve, and
		// therefore no claim.
		runComplete: defaultArm?.complete === true,
		arms,
		batchAb: classifyBatchAb(arms.flatMap((a) => a.steps)),
	};
}

function fmt(ns: number): string {
	return (ns / MS).toFixed(3);
}

function render(result: ReturnType<typeof classifyRun>): string {
	const lines: string[] = [];
	lines.push(`runComplete=${result.runComplete}`);
	for (const arm of result.arms) {
		lines.push("");
		lines.push(
			`arm=${arm.arm} arrival=${arm.arrival} batchEnv=${arm.datagramBatchEnv ?? "(default)"} complete=${arm.complete} highestRealtimeRate=${arm.highestRealtimeRate ?? "none"} lagFloor=${fmt(arm.steps[0]?.scheduleLagFloorNs ?? 0)}ms`,
		);
		lines.push(
			"eff agg/s |     p50 |     p90 |     p99 |    p999 |     max |  lagP99 |  rttP99 |    up | n       | verdict",
		);
		for (const s of arm.steps) {
			const verdict = s.complete ? s.bucket : `STOP:${s.stop}`;
			lines.push(
				`${String(s.aggregateRate).padStart(9)} | ${fmt(s.ingest.p50Ns).padStart(7)} | ${fmt(s.ingest.p90Ns).padStart(7)} | ${fmt(s.ingest.p99Ns).padStart(7)} | ${fmt(s.ingest.p999Ns).padStart(7)} | ${fmt(s.ingest.maxNs).padStart(7)} | ${(s.scheduleLag ? fmt(s.scheduleLag.p99Ns) : "n/a").padStart(7)} | ${(s.rtt ? fmt(s.rtt.p99Ns) : "n/a").padStart(7)} | ${(s.upDeliveryRatio ?? 0).toFixed(3)} | ${String(s.stampedSamples).padStart(7)} | ${verdict}`,
			);
		}
		const skewed = arm.steps.filter((s) => s.histogramSkew > 0);
		if (skewed.length > 0) {
			lines.push(
				`  histogram snapshot skew on ${skewed.length} step(s), max ${Math.max(...skewed.map((s) => s.histogramSkew))} samples — a producer was still recording when its fragment was written`,
			);
		}
		for (const crossing of arm.crossings) {
			lines.push(
				`  p99 crosses ${crossing.thresholdMs}ms at ${crossing.aggregateRate ?? "no complete step"} datagrams/s effective`,
			);
		}
	}
	if (result.batchAb.length > 0) {
		lines.push("");
		lines.push("H7 batch tail cost (default - batch0), complete steps only:");
		for (const ab of result.batchAb) {
			lines.push(
				`${String(ab.aggregateRate).padStart(7)} | default=${ab.defaultP99Ms.toFixed(3)}ms batch0=${ab.batch0P99Ms.toFixed(3)}ms delta=${ab.deltaMs.toFixed(3)}±${ab.deltaUncertaintyMs.toFixed(3)}ms ${ab.bucket}${ab.resolvable ? "" : " ab-unresolvable"}${ab.confounded ? " ab-confounded" : ""}`,
			);
		}
	} else {
		lines.push("");
		lines.push("H7 batch tail cost: no rate had a complete step in both arms.");
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const [outPath, ...inputs] = process.argv.slice(2);
	if (!outPath || inputs.length === 0) {
		console.error(
			"usage: bun tools/load/latency-classify.ts <out.json> <arm.json> [arm.json ...]",
		);
		process.exit(2);
	}
	const fragments = inputs.map(
		(p) => JSON.parse(readFileSync(p, "utf8")) as ArmFragment,
	);
	const result = classifyRun(fragments);
	writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(render(result));
	console.log(`\nlatency-classify: wrote ${outPath}`);
}
