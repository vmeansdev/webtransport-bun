#!/usr/bin/env bun
/**
 * Turn interleaved A/B fragments into verdicts, mechanically.
 *
 * Every rule here is transcribed from
 * `docs/research/preregistrations/latency-ab.md` and its parent
 * `latency.md`, both committed before the harness for this dispatch existed.
 * Nothing decides anything at read time: a cell either trips a pre-registered
 * STOP and contributes nothing, or it enters a median; a Δ either lands in a
 * pre-registered band or is labelled advisory by a pre-registered rule; the
 * cross-check reports exactly one of four readings fixed before the run.
 *
 * It is a separate program from the conductor for the same reason the ladder's
 * classifier is: it can be re-run on the same fragments by someone who does not
 * trust whoever ran them.
 *
 * Usage:
 *   bun tools/load/latency-ab-classify.ts <out.json> <fragment.json> [...]
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { LatencyStep } from "./bench-latency.ts";
import { AB_GATE_RUNG, AB_REPLICATES } from "./latency-ab-schedule.ts";
import {
	type ArmFragment,
	type ClassifiedStep,
	classifyStep,
} from "./latency-classify.ts";
import { LatencyHistogram, quantizationNs } from "./latency-histogram.ts";

const MS = 1e6;

/** An A/B fragment is a ladder fragment of exactly one step, plus cell identity. */
type AbFragment = ArmFragment & {
	rung: string | null;
	replicate: number | null;
	cellIndex: number | null;
};

export type HonestyFailure = "H1" | "H2" | "H3" | "H4" | "H5";

export type AbCellResult = {
	index: number;
	arm: string;
	rung: string;
	replicate: number;
	isFloor: boolean;
	aggregateRate: number;
	complete: boolean;
	stop: string | null;
	/** Which of the five honesty conditions this cell failed. Empty is honest. */
	honestyFailures: HonestyFailure[];
	ingestP99Ns: number;
	egressP99Ns: number | null;
	turnaroundP99Ns: number;
	rttP99Ns: number | null;
	scheduleLagP99Ns: number | null;
	upDeliveryRatio: number | null;
	echoReturnRatio: number | null;
	hostCpuPctMedian: number | null;
	serverCpuPct: number;
	stampedSamples: number;
	egressSamples: number;
	/** Server's first two legs as the client measured them, for the clock check. */
	clientUpstreamPlusTurnaroundP50Ns: number | null;
	serverIngestPlusTurnaroundP50Ns: number;
};

/* ---------------------------------------------------------------------- *
 * Statistics: medians and distribution-free order-statistic intervals.
 * Registered estimator — no normality assumption, no bootstrap, no seed.
 * ---------------------------------------------------------------------- */

export type Interval = {
	n: number;
	median: number | null;
	lo: number | null;
	hi: number | null;
	/** Exact coverage of `[lo, hi]`; null when no interval qualifies. */
	coverage: number | null;
	/** `k` from the registered rule; null when n is too small for any k ≥ 1. */
	k: number | null;
};

/** Exact binomial CDF at p = 1/2. n stays small here, so exactness is free. */
function binomCdfHalf(k: number, n: number): number {
	if (k < 0) return 0;
	if (k >= n) return 1;
	let coefficient = 1;
	let sum = 1;
	for (let i = 1; i <= k; i += 1) {
		coefficient = (coefficient * (n - i + 1)) / i;
		sum += coefficient;
	}
	return sum / 2 ** n;
}

/**
 * Registered interval: `[x₍ₖ₎, x₍ₙ₊₁₋ₖ₎]` for the largest k ≥ 1 with
 * `2·BinomCDF(k−1; n, ½) ≤ 0.05`. Its true coverage is reported alongside,
 * because it is discrete and is not 95%. When no k qualifies — n ≤ 5 — the
 * median is reported bare and the interval says so.
 */
export function medianInterval(values: number[]): Interval {
	const n = values.length;
	if (n === 0)
		return { n, median: null, lo: null, hi: null, coverage: null, k: null };
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(n / 2);
	const median =
		n % 2 === 1
			? (sorted[mid] as number)
			: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;

	let k: number | null = null;
	for (let candidate = 1; candidate <= Math.floor(n / 2); candidate += 1) {
		if (2 * binomCdfHalf(candidate - 1, n) <= 0.05) k = candidate;
		else break;
	}
	if (k === null) {
		return { n, median, lo: null, hi: null, coverage: null, k: null };
	}
	return {
		n,
		median,
		lo: sorted[k - 1] as number,
		hi: sorted[n - k] as number,
		coverage: 1 - 2 * binomCdfHalf(k - 1, n),
		k,
	};
}

/* ---------------------------------------------------------------------- *
 * Cells
 * ---------------------------------------------------------------------- */

function summaryOf(json: Parameters<typeof LatencyHistogram.fromJson>[0]) {
	return LatencyHistogram.fromJson(json).summary();
}

/**
 * The five honesty conditions, computed for every cell and reported everywhere;
 * at the gate rung they are a precondition and a failure excludes the cell.
 */
function honestyFailures(
	step: LatencyStep,
	classified: ClassifiedStep,
	targetAggregate: number,
	floorLagP99Ns: number,
): HonestyFailure[] {
	const failures: HonestyFailure[] = [];
	if (Math.abs(step.aggregateRate - targetAggregate) > 0.02 * targetAggregate)
		failures.push("H1");
	if (classified.offeredFraction < 0.98) failures.push("H2");
	const client = step.client;
	if (client && client.ticksSkipped > 0.001 * Math.max(client.sendEvents, 1))
		failures.push("H3");
	if (
		classified.scheduleLag === null ||
		(floorLagP99Ns > 0 && classified.scheduleLag.p99Ns > 2 * floorLagP99Ns)
	)
		failures.push("H4");
	if ((step.upDeliveryRatio ?? 0) < 0.995) failures.push("H5");
	return failures;
}

function toCell(
	fragment: AbFragment,
	step: LatencyStep,
	floorLagP99Ns: number,
	targetAggregate: number,
): AbCellResult {
	const isFloor = fragment.rung === "F";
	// A floor arm's own schedule lag *is* the floor, so STOP 1 cannot be evaluated
	// against it without circularity; it is evaluated against itself, which the
	// rule passes trivially, and STOPs 2–5 do the work. Registered as the
	// floor-arm clause in latency-ab.md.
	const classified = classifyStep(
		step,
		fragment,
		isFloor ? Number.POSITIVE_INFINITY : floorLagP99Ns,
	);
	const ingest = summaryOf(step.ingest);
	const turnaround = summaryOf(step.turnaround);
	const egress = step.client ? summaryOf(step.client.egressOneWay) : null;
	const upstream = step.client
		? summaryOf(step.client.upstreamPlusTurnaround)
		: null;
	return {
		index: fragment.cellIndex ?? -1,
		arm: fragment.arm,
		rung: fragment.rung ?? "?",
		replicate: fragment.replicate ?? 0,
		isFloor,
		aggregateRate: step.aggregateRate,
		complete: classified.complete,
		stop: classified.stop,
		honestyFailures: honestyFailures(
			step,
			classified,
			targetAggregate,
			floorLagP99Ns,
		),
		ingestP99Ns: ingest.p99Ns,
		egressP99Ns: egress && egress.count > 0 ? egress.p99Ns : null,
		turnaroundP99Ns: turnaround.p99Ns,
		rttP99Ns: classified.rtt?.p99Ns ?? null,
		scheduleLagP99Ns: classified.scheduleLag?.p99Ns ?? null,
		upDeliveryRatio: step.upDeliveryRatio,
		echoReturnRatio:
			step.echoSent > 0 ? step.clientReceived / step.echoSent : null,
		hostCpuPctMedian: step.hostCpuPctMedian,
		serverCpuPct: step.serverCpuPct,
		stampedSamples: step.serverStamped,
		egressSamples: egress?.count ?? 0,
		clientUpstreamPlusTurnaroundP50Ns: upstream?.p50Ns ?? null,
		serverIngestPlusTurnaroundP50Ns: ingest.p50Ns + turnaround.p50Ns,
	};
}

/* ---------------------------------------------------------------------- *
 * The pinned floor rule
 * ---------------------------------------------------------------------- */

export type FloorReport = {
	arms: number;
	ingestP99Ns: number | null;
	lagP99Ns: number | null;
	/** max/min across the floor arms' ingest p99 — the drift check's statistic. */
	ingestSpread: number | null;
	notQuiet: boolean;
	drifted: boolean;
	exceedsSignal: boolean;
	/** False when `floor-not-quiet` fired: no adjusted figure is produced at all. */
	adjustmentProduced: boolean;
	/** True when the adjustment stands but may not carry a gate. */
	adjustmentAdvisory: boolean;
};

function floorReport(
	floorCells: AbCellResult[],
	lowestRungRawMedianNs: number | null,
): FloorReport {
	const usable = floorCells.filter((c) => c.complete);
	const ingest = medianInterval(usable.map((c) => c.ingestP99Ns));
	const lag = medianInterval(
		usable.flatMap((c) =>
			c.scheduleLagP99Ns === null ? [] : [c.scheduleLagP99Ns],
		),
	);
	const ingests = usable.map((c) => c.ingestP99Ns);
	const spread =
		ingests.length > 0 && Math.min(...ingests) > 0
			? Math.max(...ingests) / Math.min(...ingests)
			: null;
	// A floor arm at 1,000/s that reports a millisecond of tail is not measuring a
	// floor, and fewer than three survivors is not a median.
	const notQuiet = ingests.some((v) => v >= 1 * MS) || usable.length < 3;
	const drifted = spread !== null && spread > 2;
	const exceedsSignal =
		ingest.median !== null &&
		lowestRungRawMedianNs !== null &&
		ingest.median > 0.5 * lowestRungRawMedianNs;
	return {
		arms: usable.length,
		ingestP99Ns: ingest.median,
		lagP99Ns: lag.median,
		ingestSpread: spread,
		notQuiet,
		drifted,
		exceedsSignal,
		adjustmentProduced: !notQuiet,
		adjustmentAdvisory: !notQuiet && (drifted || exceedsSignal),
	};
}

/* ---------------------------------------------------------------------- *
 * Rungs, pairs, the A/B, and the cross-check
 * ---------------------------------------------------------------------- */

export type AbRungResult = {
	rung: string;
	aggregateRate: number | null;
	/** Cells that tripped no STOP, per arm. */
	completeByArm: Record<string, number>;
	honestByArm: Record<string, number>;
	measured: boolean;
	ingestP99ByArm: Record<string, Interval>;
	egressP99ByArm: Record<string, Interval>;
	adjustedIngestP99ByArm: Record<string, Interval>;
	upDeliveryByArm: Record<string, Interval>;
	hostCpuByArm: Record<string, Interval>;
	/** Paired Δ = default − batch0, on raw ingest p99. */
	delta: Interval;
	deltaBucket:
		| "batch-helps"
		| "batch-free"
		| "batch-cheap"
		| "batch-expensive"
		| null;
	deltaUncertaintyMs: number | null;
	labels: string[];
	/** median ingest p99 / median egress p99, per arm. */
	asymmetryRatioByArm: Record<string, number | null>;
	asymmetryRatioBoundsByArm: Record<string, [number, number] | null>;
	/** Cells whose echo return ratio fell below 0.98 — egress advisory. */
	egressSurvivorshipAdvisory: boolean;
};

function bandOf(deltaMs: number): NonNullable<AbRungResult["deltaBucket"]> {
	if (deltaMs <= -0.2) return "batch-helps";
	if (deltaMs < 0.2) return "batch-free";
	if (deltaMs < 1) return "batch-cheap";
	return "batch-expensive";
}

const ARMS = ["default", "batch0"] as const;

function byArm<T>(
	cells: AbCellResult[],
	f: (arm: string, cells: AbCellResult[]) => T,
): Record<string, T> {
	const out: Record<string, T> = {};
	for (const arm of ARMS)
		out[arm] = f(
			arm,
			cells.filter((c) => c.arm === arm),
		);
	return out;
}

function classifyRung(
	rung: string,
	cells: AbCellResult[],
	floor: FloorReport,
): AbRungResult {
	const gate = rung === AB_GATE_RUNG;
	// At the gate rung honesty is a precondition; elsewhere it is a diagnostic and
	// does not remove a cell from a median.
	const usable = cells.filter(
		(c) => c.complete && (!gate || c.honestyFailures.length === 0),
	);
	const completeByArm = byArm(
		cells,
		(_, a) => a.filter((c) => c.complete).length,
	);
	const honestByArm = byArm(
		cells,
		(_, a) =>
			a.filter((c) => c.complete && c.honestyFailures.length === 0).length,
	);
	const measured = ARMS.every(
		(arm) => ((gate ? honestByArm[arm] : completeByArm[arm]) ?? 0) >= 8,
	);

	const ingestP99ByArm = byArm(usable, (_, a) =>
		medianInterval(a.map((c) => c.ingestP99Ns)),
	);
	const egressP99ByArm = byArm(usable, (_, a) =>
		medianInterval(
			a.flatMap((c) => (c.egressP99Ns === null ? [] : [c.egressP99Ns])),
		),
	);
	const adjustedIngestP99ByArm = byArm(usable, (_, a) =>
		floor.adjustmentProduced && floor.ingestP99Ns !== null
			? medianInterval(
					a.map((c) =>
						Math.max(0, c.ingestP99Ns - (floor.ingestP99Ns as number)),
					),
				)
			: medianInterval([]),
	);
	const upDeliveryByArm = byArm(usable, (_, a) =>
		medianInterval(
			a.flatMap((c) => (c.upDeliveryRatio === null ? [] : [c.upDeliveryRatio])),
		),
	);
	const hostCpuByArm = byArm(usable, (_, a) =>
		medianInterval(
			a.flatMap((c) =>
				c.hostCpuPctMedian === null ? [] : [c.hostCpuPctMedian],
			),
		),
	);

	// Pairing is by replicate index: the two members ran back-to-back, which is
	// the only thing that makes the pairing worth anything. A pair with one
	// unusable member is not a pair.
	const deltas: number[] = [];
	for (let r = 1; r <= AB_REPLICATES; r += 1) {
		const def = usable.find((c) => c.arm === "default" && c.replicate === r);
		const zero = usable.find((c) => c.arm === "batch0" && c.replicate === r);
		if (def && zero) deltas.push(def.ingestP99Ns - zero.ingestP99Ns);
	}
	const delta = medianInterval(deltas);

	const labels: string[] = [];
	let deltaBucket: AbRungResult["deltaBucket"] = null;
	let deltaUncertaintyMs: number | null = null;
	if (delta.median !== null) {
		const deltaMs = delta.median / MS;
		deltaBucket = bandOf(deltaMs);
		deltaUncertaintyMs =
			(quantizationNs(ingestP99ByArm.default?.median ?? 0) +
				quantizationNs(ingestP99ByArm.batch0?.median ?? 0)) /
			MS;
		if (Math.abs(deltaMs) <= deltaUncertaintyMs) labels.push("ab-unresolvable");
		if (
			delta.lo !== null &&
			delta.hi !== null &&
			bandOf(delta.lo / MS) !== bandOf(delta.hi / MS)
		)
			labels.push("ab-ci-spans-bands");
		const upGap = Math.abs(
			(upDeliveryByArm.default?.median ?? 0) -
				(upDeliveryByArm.batch0?.median ?? 0),
		);
		if (upGap > 0.02) labels.push("ab-confounded");
		const cpuA = hostCpuByArm.default?.median;
		const cpuB = hostCpuByArm.batch0?.median;
		if (
			cpuA !== null &&
			cpuA !== undefined &&
			cpuB !== null &&
			cpuB !== undefined
		) {
			if (Math.abs(cpuA - cpuB) > 10) labels.push("ab-cpu-asymmetric");
		}
	}

	const asymmetryRatioByArm: Record<string, number | null> = {};
	const asymmetryRatioBoundsByArm: Record<string, [number, number] | null> = {};
	for (const arm of ARMS) {
		const ing = ingestP99ByArm[arm];
		const egr = egressP99ByArm[arm];
		asymmetryRatioByArm[arm] =
			ing?.median != null && egr?.median ? ing.median / egr.median : null;
		asymmetryRatioBoundsByArm[arm] =
			ing?.lo != null && ing.hi != null && egr?.lo && egr.hi
				? [ing.lo / egr.hi, ing.hi / egr.lo]
				: null;
	}

	return {
		rung,
		aggregateRate: medianInterval(cells.map((c) => c.aggregateRate)).median,
		completeByArm,
		honestByArm,
		measured,
		ingestP99ByArm,
		egressP99ByArm,
		adjustedIngestP99ByArm,
		upDeliveryByArm,
		hostCpuByArm,
		delta,
		deltaBucket,
		deltaUncertaintyMs,
		labels,
		asymmetryRatioByArm,
		asymmetryRatioBoundsByArm,
		egressSurvivorshipAdvisory: usable.some(
			(c) => c.echoReturnRatio !== null && c.echoReturnRatio < 0.98,
		),
	};
}

export type CrossCheck = {
	reading:
		| "R1"
		| "R2"
		| "R3"
		| "R4"
		| "crosscheck-clock-invalid"
		| "crosscheck-no-data";
	statement: string;
	gateRungRatios: Record<string, number | null>;
	/** Worst disagreement between the client's and server's view of two legs. */
	clockDisagreementMs: number | null;
	advisory: string[];
};

const READINGS: Record<CrossCheck["reading"], string> = {
	R1: "The ingest/egress asymmetry is the H7 batch fill wait: it is present with the shipped default and gone with the batch path off. The H7 default decision must price it, and G3's egress figures are not comparable to G2's ingest figures without it.",
	R2: "The asymmetry belongs to the receive direction as a whole — loopback, decrypt, native queue, N-API, event loop — versus a direct send. It survives with the batch path off, so H7 is not its cause; each gate keeps its own units.",
	R3: "The ~6.6x asymmetry does not reproduce inside one dispatch on one clock. It is withdrawn as an artifact of comparing two harnesses across two runs, and the cross-axis tension is closed.",
	R4: "No pre-registered reading matched. No mechanism claim is made; the numbers stand and the cross-axis tension stays open, which the G2 and G3 stamps must say.",
	"crosscheck-clock-invalid":
		"The client's and the server's measurements of the same two legs disagree by more than 0.2 ms, so the two processes are not describing the same datagrams. The cross-check produces nothing.",
	"crosscheck-no-data":
		"No cell survived its STOPs, so there is nothing to cross-check. This is a statement about the dispatch, not about the clock and not about the asymmetry.",
};

function crossCheck(rungs: AbRungResult[], cells: AbCellResult[]): CrossCheck {
	const advisory: string[] = [];
	const disagreements = cells
		.filter((c) => c.complete && c.clientUpstreamPlusTurnaroundP50Ns !== null)
		.map((c) =>
			Math.abs(
				(c.clientUpstreamPlusTurnaroundP50Ns as number) -
					c.serverIngestPlusTurnaroundP50Ns,
			),
		);
	const worst =
		disagreements.length > 0 ? Math.max(...disagreements) / MS : null;
	const gateRung = rungs.find((r) => r.rung === AB_GATE_RUNG);
	const gateRungRatios = gateRung?.asymmetryRatioByArm ?? {};

	if (worst === null || worst > 0.2) {
		// An empty set is not a clock finding — the dispatch simply produced
		// nothing to check, and saying "clock invalid" would blame the instrument
		// for the run's failure.
		const reading =
			worst === null ? "crosscheck-no-data" : "crosscheck-clock-invalid";
		return {
			reading,
			statement: READINGS[reading],
			gateRungRatios,
			clockDisagreementMs: worst,
			advisory,
		};
	}
	if (rungs.some((r) => r.egressSurvivorshipAdvisory))
		advisory.push("egress-survivorship");

	const a = gateRungRatios.default ?? null;
	const b = gateRungRatios.batch0 ?? null;
	let reading: CrossCheck["reading"] = "R4";
	if (a !== null && b !== null) {
		const allLow = rungs.every((r) =>
			ARMS.every((arm) => {
				const v = r.asymmetryRatioByArm[arm];
				return v === null || v === undefined || v <= 2;
			}),
		);
		if (a >= 3 && b <= 1.5) reading = "R1";
		else if (a >= 3 && b >= 3 && Math.abs(a - b) <= 0.25 * Math.max(a, b))
			reading = "R2";
		else if (a <= 2 && b <= 2 && allLow) reading = "R3";
	}
	return {
		reading,
		statement: READINGS[reading],
		gateRungRatios,
		clockDisagreementMs: worst,
		advisory,
	};
}

/* ---------------------------------------------------------------------- *
 * Run
 * ---------------------------------------------------------------------- */

export function classifyAbRun(fragments: AbFragment[]) {
	const withStep = fragments.flatMap((f) => {
		const step = f.steps[0];
		return step ? [{ fragment: f, step }] : [];
	});
	const targetOf = (rung: string | null) =>
		rung === "F"
			? 1_000
			: rung === "A"
				? 10_000
				: rung === "B"
					? 15_000
					: rung === "C"
						? 20_000
						: 25_000;

	// Two passes: the floor arms give the lag floor every other cell's STOP 1 and
	// honesty condition H4 are judged against, so they are classified first with
	// STOP 1 inert (see the floor-arm clause).
	const floorFirst = withStep.filter((x) => x.fragment.rung === "F");
	const floorCellsForLag = floorFirst.map((x) =>
		toCell(x.fragment, x.step, 0, targetOf(x.fragment.rung)),
	);
	const lagFloorNs =
		medianInterval(
			floorCellsForLag
				.filter((c) => c.complete)
				.flatMap((c) =>
					c.scheduleLagP99Ns === null ? [] : [c.scheduleLagP99Ns],
				),
		).median ?? 0;

	const cells = withStep
		.map((x) =>
			toCell(x.fragment, x.step, lagFloorNs, targetOf(x.fragment.rung)),
		)
		.sort((p, q) => p.index - q.index);

	const floorCells = cells.filter((c) => c.isFloor);
	const measurementCells = cells.filter((c) => !c.isFloor);
	const rungNames = [...new Set(measurementCells.map((c) => c.rung))].sort();

	// `floor-exceeds-signal` compares the floor against the easiest rung's raw
	// median, so that median is computed with no adjustment first.
	const lowestRung = rungNames[0];
	const lowestRaw = medianInterval(
		measurementCells
			.filter((c) => c.rung === lowestRung && c.complete)
			.map((c) => c.ingestP99Ns),
	).median;
	const floor = floorReport(floorCells, lowestRaw);

	const rungs = rungNames.map((rung) =>
		classifyRung(
			rung,
			measurementCells.filter((c) => c.rung === rung),
			floor,
		),
	);
	const gateRung = rungs.find((r) => r.rung === AB_GATE_RUNG) ?? null;

	return {
		version: 1,
		classifiedAt: new Date().toISOString(),
		preregistration: "docs/research/preregistrations/latency-ab.md",
		/** The dispatch is complete only when the gate rung is `measured`. */
		dispatchComplete: gateRung?.measured === true,
		floor,
		rungs,
		crossCheck: crossCheck(rungs, measurementCells),
		cells,
	};
}

/* ---------------------------------------------------------------------- *
 * Rendering
 * ---------------------------------------------------------------------- */

function ms(ns: number | null | undefined): string {
	return ns === null || ns === undefined ? "n/a" : (ns / MS).toFixed(3);
}

function interval(i: Interval): string {
	if (i.median === null) return "n/a";
	if (i.lo === null || i.hi === null)
		return `${ms(i.median)} (n=${i.n}, ci-unavailable)`;
	return `${ms(i.median)} [${ms(i.lo)}, ${ms(i.hi)}] (n=${i.n}, ${((i.coverage ?? 0) * 100).toFixed(1)}%)`;
}

function render(result: ReturnType<typeof classifyAbRun>): string {
	const lines: string[] = [];
	lines.push(`dispatchComplete=${result.dispatchComplete}`);
	lines.push("");
	const f = result.floor;
	lines.push(
		`floor: arms=${f.arms} ingestP99=${ms(f.ingestP99Ns)}ms lagP99=${ms(f.lagP99Ns)}ms spread=${f.ingestSpread?.toFixed(2) ?? "n/a"}x` +
			`${f.notQuiet ? " floor-not-quiet (NO adjusted figure)" : ""}${f.drifted ? " floor-drift" : ""}${f.exceedsSignal ? " floor-exceeds-signal" : ""}` +
			`${f.adjustmentAdvisory ? " — adjusted figures ADVISORY, raw stands" : ""}`,
	);

	for (const r of result.rungs) {
		lines.push("");
		lines.push(
			`rung ${r.rung} @ ${r.aggregateRate ?? "?"}/s effective — measured=${r.measured} complete(default/batch0)=${r.completeByArm.default}/${r.completeByArm.batch0} honest=${r.honestByArm.default}/${r.honestByArm.batch0}`,
		);
		for (const arm of ARMS) {
			lines.push(
				`  ${arm.padEnd(8)} ingestP99=${interval(r.ingestP99ByArm[arm] as Interval)}ms  egressP99=${interval(r.egressP99ByArm[arm] as Interval)}ms  ratio=${r.asymmetryRatioByArm[arm]?.toFixed(2) ?? "n/a"}x`,
			);
			const adjusted = r.adjustedIngestP99ByArm[arm] as Interval;
			if (adjusted.median !== null)
				lines.push(
					`  ${arm.padEnd(8)} adjustedIngestP99=${interval(adjusted)}ms`,
				);
		}
		lines.push(
			`  delta (default-batch0) = ${interval(r.delta)}ms ± ${r.deltaUncertaintyMs?.toFixed(3) ?? "n/a"}ms quantization → ${r.deltaBucket ?? "no pairs"}${r.labels.length > 0 ? ` [${r.labels.join(", ")}]` : ""}`,
		);
	}

	const cc = result.crossCheck;
	lines.push("");
	lines.push(
		`cross-check: ${cc.reading} (gate-rung ratios default=${cc.gateRungRatios.default?.toFixed(2) ?? "n/a"}x batch0=${cc.gateRungRatios.batch0?.toFixed(2) ?? "n/a"}x, clock disagreement ${ms((cc.clockDisagreementMs ?? 0) * MS)}ms)${cc.advisory.length > 0 ? ` [${cc.advisory.join(", ")}]` : ""}`,
	);
	lines.push(`  ${cc.statement}`);

	const stopped = result.cells.filter((c) => !c.complete);
	if (stopped.length > 0) {
		lines.push("");
		lines.push(`${stopped.length} cell(s) tripped a STOP:`);
		for (const c of stopped)
			lines.push(
				`  #${c.index} rung=${c.rung} r=${c.replicate} ${c.arm}: ${c.stop}`,
			);
	}
	const dishonest = result.cells.filter(
		(c) => c.complete && c.honestyFailures.length > 0,
	);
	if (dishonest.length > 0) {
		lines.push("");
		lines.push(
			`${dishonest.length} complete cell(s) failed a honesty condition:`,
		);
		for (const c of dishonest)
			lines.push(
				`  #${c.index} rung=${c.rung} r=${c.replicate} ${c.arm}: ${c.honestyFailures.join(",")}`,
			);
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const [outPath, ...inputs] = process.argv.slice(2);
	if (!outPath || inputs.length === 0) {
		console.error(
			"usage: bun tools/load/latency-ab-classify.ts <out.json> <fragment.json> [...]",
		);
		process.exit(2);
	}
	const fragments = inputs.map(
		(p) => JSON.parse(readFileSync(p, "utf8")) as AbFragment,
	);
	const result = classifyAbRun(fragments);
	writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(render(result));
	console.log(`\nlatency-ab-classify: wrote ${outPath}`);
}
