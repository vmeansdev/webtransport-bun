#!/usr/bin/env bun
/**
 * Classifier for the off-box RTT dispatch — it turns fragments into G2's verdict.
 *
 * Every rule here is pre-registered in
 * `docs/research/preregistrations/gate-g2-offbox-rtt.md`; the section numbers in
 * the comments are that document's. Nothing in this file may decide anything the
 * document left open, and a reader who does not trust the run can re-run this
 * over the downloaded fragments and get the same bytes back.
 *
 * The three things this classifier exists to prevent, in order of how easily
 * they would otherwise happen:
 *
 *   1. **A number that was never off-box.** §6's four marks are checked per
 *      cell; a gate cell that cannot prove it was off-box is excluded.
 *   2. **A tail flattered by loss.** A datagram that never returns leaves no RTT
 *      sample, so loss silently improves a p99. §7's censoring correction reads
 *      the quantile the missing samples push the real one to, and can only move
 *      the figure up.
 *   3. **A cross-host interval.** §6 requires the off-box fragments to carry no
 *      ingest, egress or upstream histogram at all; this asserts it rather than
 *      trusting it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { medianInterval } from "./latency-ab-classify.ts";
import { LatencyHistogram, quantizationNs } from "./latency-histogram.ts";
import {
	RTT_BOUND_MS,
	RTT_GATE_RUNG,
	RTT_RUNGS,
} from "./latency-rtt-schedule.ts";

/* ---------------------------------------------------------------------- *
 * Registered numerics — all fixed before the run, none derived from it.
 * ---------------------------------------------------------------------- */

/** §7 — 1% missing makes a 99th percentile undefined. */
export const MAX_MISSING_FRACTION = 0.01;
/** §7 — delivery-collapse STOP: the path is unusable, not the product. */
export const DELIVERY_COLLAPSE_FRACTION = 0.05;
/** §7 — a majority-share threshold, T02's, for attributing a gap in-host. */
export const IN_HOST_DROP_SHARE = 0.1;
/** §8 — a floor above this is not a floor; the path is not quiet. */
export const FLOOR_NOT_QUIET_MS = 4.0;
/** §8 — spread across the dispatch's three floor arms. */
export const FLOOR_DRIFT_RATIO = 2.0;
/** §8 — the idle path eating a quarter of the budget is disclosed. */
export const FLOOR_HEAVY_SHARE = 0.25;
/** §8 — H4's multiplier, inherited verbatim from latency-ab.md. */
export const LAG_FLOOR_MULTIPLE = 2;
/** §8 — H1 tolerance, inherited. */
export const RATE_TOLERANCE = 0.02;
/** §8 — H2, inherited. */
export const MIN_OFFERED_FRACTION = 0.98;
/** §8 — H3, inherited. */
export const MAX_SKIPPED_SHARE = 0.001;
/** §8 — the gate rung needs this many good cells to be evaluable. */
export const MIN_GATE_CELLS = 8;
/** §6 — presence/absence assertions, deliberately loose (GRO, framing). */
export const LAN_RX_MIN_SHARE = 0.5;
export const LO_RX_MAX_SHARE = 0.1;

export type HonestyFailure = "H1" | "H2" | "H3" | "H4" | "H5";
export type IntegrityFailure = "O1" | "O2" | "O3" | "O4";

export type LossAttribution = "none" | "in-host" | "off-host";

export type RttCellResult = {
	index: number | null;
	rung: string;
	placement: "onbox" | "offbox";
	replicate: number | null;
	aggregateRate: number;
	complete: boolean;
	/** §6 — cross-host histograms must be empty on an off-box fragment. */
	crossHostClean: boolean;
	integrityFailures: IntegrityFailure[];
	honestyFailures: HonestyFailure[];
	rttP99RawNs: number | null;
	/** §7 — the gate's statistic. Null when the cell is censored past p99. */
	rttP99CensoredNs: number | null;
	missingFraction: number | null;
	scheduleLagP99Ns: number | null;
	upDeliveryRatio: number | null;
	upGap: number;
	downGap: number;
	kernelDrops: number;
	lossAttribution: LossAttribution;
	hostCpuPctMedian: number | null;
	serverCpuPct: number | null;
	clientSent: number;
	sessionsOk: number;
};

type HistogramJson = Parameters<typeof LatencyHistogram.fromJson>[0];

export type RttFragment = {
	rung?: string | null;
	replicate?: number | null;
	cellIndex?: number | null;
	config?: {
		generatorMode?: string;
		sharedClock?: boolean;
		offboxUrlHost?: string | null;
		datagramBatchEnv?: string | null;
		payloadBytes?: number;
		sessions?: number;
	};
	steps?: Array<{
		aggregateRate: number;
		requestedDatagrams: number;
		clientSent: number;
		clientReceived: number;
		serverRx: number;
		echoSent: number;
		upDeliveryRatio: number | null;
		ingest: HistogramJson;
		turnaround: HistogramJson;
		client: {
			rtt: HistogramJson;
			scheduleLag: HistogramJson;
			egressOneWay: HistogramJson;
			upstreamPlusTurnaround: HistogramJson;
			echoMissingEchoInstant: number;
			ticksSkipped: number;
			sendEvents: number;
		} | null;
		hostCpuPctMedian: number | null;
		serverCpuPct: number;
		sessionsOk: number;
		generator?: { mode: string; ssh: string | null; urlHost: string };
		netRxDelta?: Record<string, { rxBytes: number; rxPackets: number }> | null;
		udpDelta?: {
			inDatagrams: number;
			inErrors: number;
			rcvbufErrors: number;
		} | null;
	}>;
};

/**
 * §7 — the p99 over *all* sends, given that a fraction `f` of them produced no
 * sample at all. Survivors occupy the bottom `1 − f` of the distribution, so the
 * all-sends 0.99 quantile is the survivors' `0.99 / (1 − f)` quantile. At
 * `f ≥ 0.01` that quantile is past the top of the survivors: the true p99 is
 * unbounded and the cell cannot carry a pass.
 */
export function censoredP99Ns(
	histogram: LatencyHistogram,
	missingFraction: number,
): number | null {
	if (!Number.isFinite(missingFraction) || missingFraction < 0) return null;
	if (missingFraction >= MAX_MISSING_FRACTION) return null;
	return histogram.percentile(0.99 / (1 - missingFraction));
}

function summaryOf(json: HistogramJson) {
	return LatencyHistogram.fromJson(json).summary();
}

function integrityFailures(
	step: NonNullable<RttFragment["steps"]>[number],
	placement: "onbox" | "offbox",
	payloadBytes: number,
): IntegrityFailure[] {
	const failures: IntegrityFailure[] = [];
	const generator = step.generator;
	if (!generator || generator.mode !== placement) failures.push("O1");
	if (placement === "offbox") {
		if (!generator || !/^192\.168\.2\./.test(generator.urlHost)) {
			failures.push("O2");
		}
	}
	const net = step.netRxDelta;
	const expectedBytes = step.clientSent * payloadBytes;
	if (!net || expectedBytes <= 0) {
		// No taps means the marks cannot be checked, which is not the same as
		// passing them.
		failures.push("O3");
		failures.push("O4");
		return failures;
	}
	const lo = net.lo?.rxBytes ?? 0;
	const lan = Object.entries(net)
		.filter(([iface]) => iface !== "lo")
		.reduce((acc, [, v]) => acc + v.rxBytes, 0);
	if (placement === "offbox") {
		if (lan < LAN_RX_MIN_SHARE * expectedBytes) failures.push("O3");
		if (lo > LO_RX_MAX_SHARE * expectedBytes) failures.push("O4");
	} else {
		if (lo < LAN_RX_MIN_SHARE * expectedBytes) failures.push("O4");
	}
	return failures;
}

/** §6 — off-box fragments must carry no cross-host interval at all. */
export function crossHostClean(
	step: NonNullable<RttFragment["steps"]>[number],
	placement: "onbox" | "offbox",
): boolean {
	if (placement === "onbox") return true;
	const client = step.client;
	if (!client) return false;
	return (
		summaryOf(step.ingest).count === 0 &&
		summaryOf(client.egressOneWay).count === 0 &&
		summaryOf(client.upstreamPlusTurnaround).count === 0 &&
		client.echoMissingEchoInstant === step.clientReceived
	);
}

export function toCell(
	fragment: RttFragment,
	options: { payloadBytes: number; lagFloorNs: number | null },
): RttCellResult | null {
	const step = fragment.steps?.[0];
	if (!step) return null;
	const rung = fragment.rung ?? "unknown";
	const placement: "onbox" | "offbox" =
		step.generator?.mode === "offbox" ||
		fragment.config?.generatorMode === "offbox"
			? "offbox"
			: "onbox";
	const client = step.client;
	const complete = client != null && step.sessionsOk > 0;

	const rttHistogram = client ? LatencyHistogram.fromJson(client.rtt) : null;
	const rttCount = rttHistogram?.summary().count ?? 0;
	const missingFraction =
		step.clientSent > 0 ? 1 - rttCount / step.clientSent : null;
	const rttP99RawNs = rttHistogram ? rttHistogram.percentile(0.99) : null;
	const rttP99CensoredNs =
		rttHistogram && missingFraction !== null
			? censoredP99Ns(rttHistogram, missingFraction)
			: null;

	const upGap = step.clientSent - step.serverRx;
	const downGap = step.echoSent - step.clientReceived;
	const kernelDrops =
		(step.udpDelta?.rcvbufErrors ?? 0) + (step.udpDelta?.inErrors ?? 0);
	let lossAttribution: LossAttribution = "none";
	if (missingFraction !== null && missingFraction >= MAX_MISSING_FRACTION) {
		lossAttribution =
			upGap > 0 && kernelDrops >= IN_HOST_DROP_SHARE * upGap
				? "in-host"
				: "off-host";
	}

	const scheduleLagP99Ns = client ? summaryOf(client.scheduleLag).p99Ns : null;
	const honesty: HonestyFailure[] = [];
	// The rate a rung is *registered* to offer. `aggregateRate` in the fragment
	// is what the generator actually produced, so comparing it to itself would
	// pass H1 by construction — the check only means something against the
	// registered number.
	const registeredAggregate =
		Object.values(RTT_RUNGS).find((r) => r.rung === rung)?.aggregate ?? null;
	if (!client) {
		honesty.push("H1", "H2", "H3", "H4", "H5");
	} else {
		if (
			registeredAggregate === null ||
			Math.abs(step.aggregateRate - registeredAggregate) >
				RATE_TOLERANCE * registeredAggregate
		) {
			honesty.push("H1");
		}
		const offeredFraction =
			step.requestedDatagrams > 0
				? step.clientSent / step.requestedDatagrams
				: 0;
		if (offeredFraction < MIN_OFFERED_FRACTION) honesty.push("H2");
		if (
			client.ticksSkipped >
			MAX_SKIPPED_SHARE * Math.max(client.sendEvents, 1)
		) {
			honesty.push("H3");
		}
		if (
			options.lagFloorNs !== null &&
			scheduleLagP99Ns !== null &&
			scheduleLagP99Ns > LAG_FLOOR_MULTIPLE * options.lagFloorNs
		) {
			honesty.push("H4");
		}
		if (missingFraction === null || missingFraction >= MAX_MISSING_FRACTION) {
			honesty.push("H5");
		}
	}

	return {
		index: fragment.cellIndex ?? null,
		rung,
		placement,
		replicate: fragment.replicate ?? null,
		aggregateRate: step.aggregateRate,
		complete,
		crossHostClean: crossHostClean(step, placement),
		integrityFailures: integrityFailures(step, placement, options.payloadBytes),
		honestyFailures: honesty,
		rttP99RawNs,
		rttP99CensoredNs,
		missingFraction,
		scheduleLagP99Ns,
		upDeliveryRatio: step.upDeliveryRatio,
		upGap,
		downGap,
		kernelDrops,
		lossAttribution,
		hostCpuPctMedian: step.hostCpuPctMedian,
		serverCpuPct: step.serverCpuPct,
		clientSent: step.clientSent,
		sessionsOk: step.sessionsOk,
	};
}

export type FloorReport = {
	cells: number;
	floorRttP99Ns: number | null;
	floorLagP99Ns: number | null;
	floorRttOnboxP99Ns: number | null;
	wireCostP99Ns: number | null;
	rttSpread: number | null;
	notQuiet: boolean;
	drift: boolean;
	heavy: boolean;
};

const median = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
};

export function floorReport(cells: RttCellResult[]): FloorReport {
	const off = cells.filter((c) => c.rung === "F-off" && c.complete);
	const on = cells.filter((c) => c.rung === "F-on" && c.complete);
	const offRtt = off
		.map((c) => c.rttP99RawNs)
		.filter((v): v is number => v !== null);
	const onRtt = on
		.map((c) => c.rttP99RawNs)
		.filter((v): v is number => v !== null);
	const offLag = off
		.map((c) => c.scheduleLagP99Ns)
		.filter((v): v is number => v !== null);
	const floorRttP99Ns = median(offRtt);
	const floorRttOnboxP99Ns = median(onRtt);
	const lo = offRtt.length > 0 ? Math.min(...offRtt) : null;
	const hi = offRtt.length > 0 ? Math.max(...offRtt) : null;
	const rttSpread = lo && hi && lo > 0 ? hi / lo : null;
	return {
		cells: off.length,
		floorRttP99Ns,
		floorLagP99Ns: median(offLag),
		floorRttOnboxP99Ns,
		wireCostP99Ns:
			floorRttP99Ns !== null && floorRttOnboxP99Ns !== null
				? floorRttP99Ns - floorRttOnboxP99Ns
				: null,
		rttSpread,
		notQuiet: offRtt.some((v) => v >= FLOOR_NOT_QUIET_MS * 1e6),
		drift: rttSpread !== null && rttSpread > FLOOR_DRIFT_RATIO,
		heavy:
			floorRttP99Ns !== null &&
			floorRttP99Ns > FLOOR_HEAVY_SHARE * RTT_BOUND_MS * 1e6,
	};
}

export type GateVerdict = "PASS" | "MISS" | "INCOMPLETE";

export type RttRunResult = {
	version: 1;
	preregistration: string;
	classifiedAt: string;
	boundMs: number;
	verdict: GateVerdict;
	/** The registered row of §10 that decided it. */
	decidedBy: string;
	labels: string[];
	floor: FloorReport;
	gate: {
		cellsTotal: number;
		cellsEvaluable: number;
		medianRttP99CensoredNs: number | null;
		intervalLoNs: number | null;
		intervalHiNs: number | null;
		coverage: number | null;
		quantizationNs: number | null;
		medianRttP99RawNs: number | null;
		medianMissingFraction: number | null;
	};
	context: {
		rung: string;
		cells: number;
		medianRttP99CensoredNs: number | null;
		medianRttP99RawNs: number | null;
	}[];
	cells: RttCellResult[];
};

export function classifyRttRun(fragments: RttFragment[]): RttRunResult {
	const payloadBytes = fragments[0]?.config?.payloadBytes ?? 1150;
	// The floor's lag figure feeds H4, so the floor cells are classified first
	// with no lag bar of their own — a floor arm cannot be dishonest against
	// itself.
	const provisional = fragments
		.map((f) => toCell(f, { payloadBytes, lagFloorNs: null }))
		.filter((c): c is RttCellResult => c !== null);
	const floor = floorReport(provisional);
	const cells = fragments
		.map((f) => toCell(f, { payloadBytes, lagFloorNs: floor.floorLagP99Ns }))
		.filter((c): c is RttCellResult => c !== null);

	const gateCells = cells.filter((c) => c.rung === RTT_GATE_RUNG);
	const evaluable = gateCells.filter(
		(c) =>
			c.complete &&
			c.crossHostClean &&
			c.integrityFailures.length === 0 &&
			c.honestyFailures.length === 0 &&
			c.rttP99CensoredNs !== null,
	);
	const values = evaluable
		.map((c) => c.rttP99CensoredNs)
		.filter((v): v is number => v !== null);
	const interval = medianInterval(values);
	const rawInterval = medianInterval(
		evaluable.map((c) => c.rttP99RawNs).filter((v): v is number => v !== null),
	);
	const missing = gateCells
		.map((c) => c.missingFraction)
		.filter((v): v is number => v !== null);
	const medianMissing = median(missing);

	const labels: string[] = [];
	if (floor.heavy) labels.push("floor-heavy");

	let verdict: GateVerdict = "INCOMPLETE";
	let decidedBy = "row 5 — fewer than 8 evaluable gate cells";

	const contaminated = cells.filter(
		(c) => c.placement === "offbox" && !c.crossHostClean,
	);

	if (contaminated.length > 0) {
		verdict = "INCOMPLETE";
		decidedBy = "row 2 — crosshost-contamination";
	} else if (floor.notQuiet) {
		verdict = "INCOMPLETE";
		decidedBy = "row 3 — path-not-quiet";
	} else if (floor.drift) {
		verdict = "INCOMPLETE";
		decidedBy = "row 3 — floor-drift";
	} else if (
		medianMissing !== null &&
		medianMissing >= DELIVERY_COLLAPSE_FRACTION
	) {
		verdict = "INCOMPLETE";
		decidedBy = "row 4 — delivery-collapse";
	} else if (gateCells.some((c) => c.lossAttribution === "in-host")) {
		verdict = "MISS";
		decidedBy = "row 6 — in-host loss above 1%";
	} else if (evaluable.length < MIN_GATE_CELLS) {
		verdict = "INCOMPLETE";
		decidedBy = `row 5 — ${evaluable.length}/${gateCells.length} evaluable gate cells`;
	} else if (interval.median === null || interval.median > RTT_BOUND_MS * 1e6) {
		verdict = "MISS";
		decidedBy = "row 7 — median censored RTT p99 above the bound";
	} else {
		verdict = "PASS";
		decidedBy = "row 8";
	}

	if (
		(verdict === "PASS" || decidedBy.startsWith("row 7")) &&
		interval.lo !== null &&
		interval.hi !== null &&
		interval.lo > RTT_BOUND_MS * 1e6 !== interval.hi > RTT_BOUND_MS * 1e6
	) {
		labels.push("gate-ci-spans-bound");
	}

	const contextRungs = ["A-off", "G-on", "F-off", "F-on"];
	const context = contextRungs.map((rung) => {
		const rows = cells.filter((c) => c.rung === rung && c.complete);
		return {
			rung,
			cells: rows.length,
			medianRttP99CensoredNs: median(
				rows
					.map((c) => c.rttP99CensoredNs)
					.filter((v): v is number => v !== null),
			),
			medianRttP99RawNs: median(
				rows.map((c) => c.rttP99RawNs).filter((v): v is number => v !== null),
			),
		};
	});

	return {
		version: 1,
		preregistration: "docs/research/preregistrations/gate-g2-offbox-rtt.md",
		classifiedAt: new Date().toISOString(),
		boundMs: RTT_BOUND_MS,
		verdict,
		decidedBy,
		labels,
		floor,
		gate: {
			cellsTotal: gateCells.length,
			cellsEvaluable: evaluable.length,
			medianRttP99CensoredNs: interval.median,
			intervalLoNs: interval.lo,
			intervalHiNs: interval.hi,
			coverage: interval.coverage,
			quantizationNs:
				interval.median !== null ? quantizationNs(interval.median) : null,
			medianRttP99RawNs: rawInterval.median,
			medianMissingFraction: medianMissing,
		},
		context,
		cells,
	};
}

const ms = (ns: number | null | undefined): string =>
	ns == null ? "n/a" : `${(ns / 1e6).toFixed(3)}ms`;

export function render(result: RttRunResult): string {
	const lines: string[] = [];
	lines.push(
		`G2 (off-box RTT) — ${result.verdict} [${result.decidedBy}]` +
			(result.labels.length > 0 ? ` labels=${result.labels.join(",")}` : ""),
	);
	lines.push(
		`bound=${result.boundMs.toFixed(1)}ms  gate cells evaluable=${result.gate.cellsEvaluable}/${result.gate.cellsTotal}`,
	);
	lines.push(
		`median censored RTT p99 = ${ms(result.gate.medianRttP99CensoredNs)} ` +
			`[${ms(result.gate.intervalLoNs)}, ${ms(result.gate.intervalHiNs)}] ` +
			`coverage=${result.gate.coverage !== null ? `${(result.gate.coverage * 100).toFixed(2)}%` : "ci-unavailable"} ` +
			`(raw ${ms(result.gate.medianRttP99RawNs)}, quantization ±${ms(result.gate.quantizationNs)})`,
	);
	lines.push(
		`floor: offbox rtt p99 ${ms(result.floor.floorRttP99Ns)} lag p99 ${ms(result.floor.floorLagP99Ns)} ` +
			`onbox rtt p99 ${ms(result.floor.floorRttOnboxP99Ns)} wire ${ms(result.floor.wireCostP99Ns)} ` +
			`spread=${result.floor.rttSpread?.toFixed(2) ?? "n/a"} notQuiet=${result.floor.notQuiet} drift=${result.floor.drift}`,
	);
	for (const row of result.context) {
		lines.push(
			`context ${row.rung}: n=${row.cells} censored p99 ${ms(row.medianRttP99CensoredNs)} raw ${ms(row.medianRttP99RawNs)}`,
		);
	}
	for (const cell of result.cells) {
		lines.push(
			`  cell ${String(cell.index ?? "?").padStart(2)} ${cell.rung.padEnd(6)} r${cell.replicate ?? "?"} ` +
				`${cell.placement} rtt99=${ms(cell.rttP99CensoredNs ?? cell.rttP99RawNs)} ` +
				`miss=${cell.missingFraction !== null ? cell.missingFraction.toFixed(5) : "n/a"} ` +
				`lag99=${ms(cell.scheduleLagP99Ns)} ` +
				`O=[${cell.integrityFailures.join(",")}] H=[${cell.honestyFailures.join(",")}] ` +
				`loss=${cell.lossAttribution} drops=${cell.kernelDrops}`,
		);
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const [outPath, ...fragmentPaths] = process.argv.slice(2);
	if (!outPath || fragmentPaths.length === 0) {
		console.error(
			"usage: bun tools/load/latency-rtt-classify.ts <out.json> <fragment.json...>",
		);
		process.exit(1);
	}
	const fragments = fragmentPaths.map(
		(p) => JSON.parse(readFileSync(p, "utf8")) as RttFragment,
	);
	const result = classifyRttRun(fragments);
	writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(render(result));
	console.log(`latency-rtt-classify: wrote ${outPath}`);
}
