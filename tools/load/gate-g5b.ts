/**
 * Gate G5b (paced bulk throughput): the pacing integrity rules and the gate's
 * verdict rules, separated from the harness that drives them so they run
 * without a runner.
 *
 * The contract is docs/research/preregistrations/gate-g5b.md, committed before
 * this file existed. Every threshold here — 1 Gbps, 8192 B per crossing, the
 * 0.95 match band, the 1.25 Gbps pace point, the 0.95 shortfall and 1.02
 * overshoot bands, the A6 10% rule — is quoted from that document, and nothing
 * here looks at a number to decide which question to ask of it.
 *
 * The per-socket drop parsers, the crossing-instrument band and the two Arm G
 * integrity rules are imported from gate-g5.ts rather than restated: they are
 * the same instruments under a different arm, and a second copy would be a
 * second place for them to drift.
 */

import {
	A6_WINDOW_BOUND_RATIO,
	CROSSING_CLAUSE_NOTE,
	GATE_BATCH_BYTES,
	GATE_CROSSING_BYTES,
	GATE_MATCH_RATIO,
	GATE_THROUGHPUT_GBPS,
	SERVER_SOCKET_DROP_NOTE,
	SHIPPED_QUEUED_BYTES_PER_SESSION,
	SHIPPED_QUEUED_BYTES_PER_STREAM,
} from "./gate-g5.ts";

export {
	GATE_BATCH_BYTES,
	GATE_CROSSING_BYTES,
	GATE_MATCH_RATIO,
	GATE_THROUGHPUT_GBPS,
	A6_WINDOW_BOUND_RATIO,
};

// --- Pacing, all pre-registered ---------------------------------------------

/**
 * The registered offer: the 1.000 Gbps bar plus five times the axis's own 5%
 * integrity band. Derived from the bar, not from any measured rate.
 */
export const PACE_TARGET_GBPS = 1.25;
/** Below this share of the offer, the cell is flagged `paced-shortfall`. */
export const PACE_SHORTFALL_RATIO = 0.95;
/**
 * Above this share of the offer, the step is `paced-overshoot` = INCOMPLETE.
 * The load client's cumulative-deadline pacer sleeps `max(0, due - elapsed)` and
 * so cannot write ahead of its virtual clock; this band is a falsifier on that
 * mechanism, not a design tolerance.
 */
export const PACE_OVERSHOOT_RATIO = 1.02;

export const PACE_NOTE =
	"Arm P paces the client with the load client's pre-existing " +
	"--stream-target-bytes-per-sec (crates/reference/src/load_client.rs, " +
	"run_bulk_stream_worker), a cumulative-deadline pacer: after the n-th write " +
	"the worker sleeps until the absolute time at which n writes were due, " +
	"measured from the step's start. It cannot overshoot (the sleep is " +
	"max(0, due - elapsed)), its timer-granularity error does not accumulate " +
	"(bounded by one 26.8 ms write interval over a 60 s step = 0.045%), and a " +
	"block in write_all is absorbed rather than repaid as a burst. offeredGbps " +
	"is the client's own streamBytesWritten over windowSec, the same window " +
	"every delivered figure uses. The A6 pair is unpaced by design: a ratio " +
	"between two cells held at one offer measures the pacer, not the window";

export const A6_KNOB_ON_NOT_MEASURABLE =
	"A6 with the knob ON requires two unpaced knob-ON cells. Gate G5's first " +
	"run measured exactly those two at 92.3% and 92.9% host CPU median, both " +
	"over the axis's 90% saturation bar in both repeats with no overlap against " +
	"the knob-off group, so on this rig they cannot produce a gradeable ratio. " +
	"Registered as not measurable and not run, rather than run again for a " +
	"second `unknown` from a contaminated cell";

// --- Cells ------------------------------------------------------------------

export type PacedCellName =
	| "P-batch"
	| "P-control"
	| "P-window-ref"
	| "A6-shipped"
	| "A6-raised";

/** Cells whose usability gates clause 1. `P-control` is disclosed, not gating. */
export const CLAUSE_BEARING_CELLS: PacedCellName[] = [
	"P-batch",
	"P-window-ref",
	"A6-shipped",
	"A6-raised",
];

export const ALL_CELLS: PacedCellName[] = [
	"P-batch",
	"P-control",
	"P-window-ref",
	"A6-shipped",
	"A6-raised",
];

/** One repeat of one cell: the facts the verdict rules are allowed to see. */
export type PacedRepeatFacts = {
	cell: PacedCellName;
	repeat: number;
	bucket: string;
	incomplete: boolean;
	/** 0 for the unpaced A6 pair. */
	paceTargetGbps: number;
	/** client.streamBytesWritten * 8 / windowSec, in Gbps. */
	offeredGbps: number | null;
	deliveredMbps: number;
	packageMeanBytesPerCrossing: number | null;
	harnessMeanBytesPerCrossing: number | null;
	crossingsPerSecond: number | null;
	maxBatchBytes: number | null;
	batchedCrossings: number | null;
	serverSocketDrops: number | null;
	coResidentDrops: number | null;
	coResidentDropVerdict: string;
	serverSocketRxQueueBytesAtEnd: number | null;
	queuedBytesPerStream: number;
	queuedBytesPerSession: number;
	explicitWindowFieldsSet: boolean;
	insideShippedPerSessionBudget: boolean;
	batchBytesConfigured: number;
	hostCpuPctMedian: number | null;
	serverCpuPct: number | null;
	clientCpuPct: number | null;
	serverCpuMsPerGbit: number | null;
	rssMbPeak: number;
};

// --- The two pacing integrity rules -----------------------------------------

/**
 * P-STOP-1 and the shortfall disclosure, in one place.
 *
 * Overshoot is INCOMPLETE: the pacer cannot write ahead of its clock, so an
 * overshoot means the step was not paced whatever its flag said. Shortfall is a
 * disclosure: on the control cells it is the registered expectation, and on the
 * gate arm it qualifies the delivered figure rather than voiding it — a
 * reliable stream that delivered its bytes and drained delivered them, whatever
 * the offer was.
 */
export function paceBucket(facts: {
	paceTargetGbps: number;
	offeredGbps: number | null;
}): "paced-overshoot" | "pace-unmeasurable" | null {
	if (facts.paceTargetGbps <= 0) return null;
	if (facts.offeredGbps === null) return "pace-unmeasurable";
	if (facts.offeredGbps > PACE_OVERSHOOT_RATIO * facts.paceTargetGbps) {
		return "paced-overshoot";
	}
	return null;
}

export function isPacedShortfall(facts: {
	paceTargetGbps: number;
	offeredGbps: number | null;
}): boolean {
	if (facts.paceTargetGbps <= 0 || facts.offeredGbps === null) return false;
	return facts.offeredGbps < PACE_SHORTFALL_RATIO * facts.paceTargetGbps;
}

// --- Cell summaries ----------------------------------------------------------

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	if (s.length % 2 === 1) return s[mid] ?? null;
	return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export type PacedCellSummary = {
	cell: PacedCellName;
	repeats: number;
	usable: boolean;
	buckets: string[];
	paceTargetGbps: number;
	offeredGbpsSamples: number[];
	offeredGbpsMedian: number | null;
	pacedShortfall: boolean;
	deliveredGbpsMedian: number | null;
	deliveredGbpsSamples: number[];
	/** Set by any non-zero server-socket drop count in any repeat. */
	deliveredIsLowerBound: boolean;
	packageMeanBytesPerCrossingMedian: number | null;
	harnessMeanBytesPerCrossingMedian: number | null;
	crossingsPerSecondMedian: number | null;
	maxBatchBytes: number | null;
	/** Per repeat, always reported — the phase-1 omission this gate corrects. */
	serverSocketDropsSamples: Array<number | null>;
	serverSocketDropsMax: number | null;
	coResidentDropVerdicts: string[];
	serverSocketRxQueueBytesAtEndMax: number | null;
	hostCpuPctMedian: number | null;
	serverCpuPctMedian: number | null;
	clientCpuPctMedian: number | null;
	serverCpuMsPerGbitMedian: number | null;
	rssMbPeakMax: number | null;
	config: {
		queuedBytesPerStream: number;
		queuedBytesPerSession: number;
		explicitWindowFieldsSet: boolean;
		insideShippedPerSessionBudget: boolean;
		batchBytesConfigured: number;
	} | null;
};

function summarizeCell(
	cell: PacedCellName,
	repeats: PacedRepeatFacts[],
): PacedCellSummary {
	// A cell is usable only if EVERY repeat is complete: an INCOMPLETE repeat
	// silently dropped from a median is the same defect as reporting it.
	const usable = repeats.length > 0 && repeats.every((r) => !r.incomplete);
	const nums = (pick: (r: PacedRepeatFacts) => number | null): number[] =>
		repeats.map(pick).filter((v): v is number => v !== null);
	const first = repeats[0];
	const dropSamples = repeats.map((r) => r.serverSocketDrops);
	const dropsKnown = dropSamples.filter((d): d is number => d !== null);
	return {
		cell,
		repeats: repeats.length,
		usable,
		buckets: repeats.map((r) => r.bucket),
		paceTargetGbps: first?.paceTargetGbps ?? 0,
		offeredGbpsSamples: nums((r) => r.offeredGbps),
		offeredGbpsMedian: median(nums((r) => r.offeredGbps)),
		// A shortfall in any repeat qualifies the cell: the median of a short
		// repeat and a full one is not a rate the arm sustained.
		pacedShortfall: repeats.some((r) => isPacedShortfall(r)),
		deliveredGbpsMedian: median(repeats.map((r) => r.deliveredMbps / 1000)),
		deliveredGbpsSamples: repeats.map((r) => r.deliveredMbps / 1000),
		deliveredIsLowerBound: dropsKnown.some((d) => d > 0),
		packageMeanBytesPerCrossingMedian: median(
			nums((r) => r.packageMeanBytesPerCrossing),
		),
		harnessMeanBytesPerCrossingMedian: median(
			nums((r) => r.harnessMeanBytesPerCrossing),
		),
		crossingsPerSecondMedian: median(nums((r) => r.crossingsPerSecond)),
		maxBatchBytes: repeats.length
			? Math.max(...repeats.map((r) => r.maxBatchBytes ?? 0))
			: null,
		serverSocketDropsSamples: dropSamples,
		// A missing sample is not a zero: it means the clause could not be
		// checked for that repeat, which the integrity bucket already caught.
		serverSocketDropsMax:
			dropsKnown.length === repeats.length && dropsKnown.length > 0
				? Math.max(...dropsKnown)
				: null,
		coResidentDropVerdicts: [
			...new Set(repeats.map((r) => r.coResidentDropVerdict)),
		],
		serverSocketRxQueueBytesAtEndMax: (() => {
			const q = nums((r) => r.serverSocketRxQueueBytesAtEnd);
			return q.length > 0 ? Math.max(...q) : null;
		})(),
		hostCpuPctMedian: median(nums((r) => r.hostCpuPctMedian)),
		serverCpuPctMedian: median(nums((r) => r.serverCpuPct)),
		clientCpuPctMedian: median(nums((r) => r.clientCpuPct)),
		serverCpuMsPerGbitMedian: median(nums((r) => r.serverCpuMsPerGbit)),
		rssMbPeakMax: repeats.length
			? Math.max(...repeats.map((r) => r.rssMbPeak))
			: null,
		config: first
			? {
					queuedBytesPerStream: first.queuedBytesPerStream,
					queuedBytesPerSession: first.queuedBytesPerSession,
					explicitWindowFieldsSet: first.explicitWindowFieldsSet,
					insideShippedPerSessionBudget: first.insideShippedPerSessionBudget,
					batchBytesConfigured: first.batchBytesConfigured,
				}
			: null,
	};
}

export type GateClause = {
	clause: number;
	name: string;
	pass: boolean;
	detail: string;
};

/**
 * G5b's verdict: the six clauses restated for the paced shape, the A6 falsifier
 * on the unpaced pair, and the derived figures that make a miss interpretable.
 * A miss names its clause and is final for the effort (spec §Rerun policy);
 * nothing here aggregates a failure into a softer word.
 */
export function evaluateGateG5b(repeats: PacedRepeatFacts[]) {
	const cells = new Map<PacedCellName, PacedCellSummary>(
		ALL_CELLS.map((n) => [
			n,
			summarizeCell(
				n,
				repeats.filter((r) => r.cell === n),
			),
		]),
	);
	const get = (n: PacedCellName) => cells.get(n) as PacedCellSummary;
	const batch = get("P-batch");
	const control = get("P-control");
	const windowRef = get("P-window-ref");
	const a6Shipped = get("A6-shipped");
	const a6Raised = get("A6-raised");

	const stops: string[] = [];
	const unusable = CLAUSE_BEARING_CELLS.filter((n) => !get(n).usable);
	if (unusable.length > 0) {
		stops.push(
			`P-STOP-A: clause-bearing cells not usable (${unusable
				.map((n) => `${n}=[${get(n).buckets.join(",") || "no repeats"}]`)
				.join(" ")}); no gate verdict`,
		);
	}
	if (repeats.some((r) => r.bucket === "crossing-instrument-disagreement")) {
		stops.push(
			"P-STOP-B: crossing-instrument-disagreement fired; no crossing claim is made for Arm P",
		);
	}
	const overshot = repeats.filter((r) => r.bucket === "paced-overshoot");
	if (overshot.length > 0) {
		stops.push(
			`P-STOP-1: paced-overshoot on ${overshot
				.map((r) => `${r.cell}-r${r.repeat}`)
				.join(
					", ",
				)}; the pacing mechanism's own falsifier fired and no paced claim is made`,
		);
	}

	const clauses: GateClause[] = [];
	const push = (
		clause: number,
		name: string,
		pass: boolean,
		detail: string,
	) => {
		clauses.push({ clause, name, pass, detail });
	};

	push(
		1,
		"completeness",
		unusable.length === 0,
		unusable.length === 0
			? `all clause-bearing cells usable, every repeat complete (P-control is disclosed, not gating: bucket ${control.buckets.join(",") || "no repeats"})`
			: `unusable: ${unusable.join(", ")}`,
	);

	const batchGbps = batch.usable ? batch.deliveredGbpsMedian : null;
	const offerNote =
		batch.offeredGbpsMedian === null
			? "offer unmeasured"
			: `offered ${batch.offeredGbpsMedian.toFixed(3)} Gbps of a registered ${batch.paceTargetGbps.toFixed(2)} Gbps${batch.pacedShortfall ? " (paced-shortfall: this is the rate sustained under that offer, not the offer)" : ""}`;
	push(
		2,
		"throughput",
		batchGbps !== null && batchGbps >= GATE_THROUGHPUT_GBPS,
		batchGbps === null
			? "P-batch is not usable; no throughput number"
			: `P-batch median ${batchGbps.toFixed(3)} Gbps vs bar ${GATE_THROUGHPUT_GBPS.toFixed(3)} Gbps (samples ${batch.deliveredGbpsSamples.map((v) => v.toFixed(3)).join(", ")}; ${offerNote})`,
	);

	const cfg = batch.config;
	const insideBudgets =
		cfg?.insideShippedPerSessionBudget === true &&
		cfg.queuedBytesPerStream === SHIPPED_QUEUED_BYTES_PER_STREAM &&
		cfg.queuedBytesPerSession === SHIPPED_QUEUED_BYTES_PER_SESSION &&
		!cfg.explicitWindowFieldsSet;
	push(
		3,
		"inside shipped budgets",
		insideBudgets,
		cfg === null
			? "P-batch has no config recorded"
			: `perStream=${cfg.queuedBytesPerStream} perSession=${cfg.queuedBytesPerSession} explicitWindowFields=${cfg.explicitWindowFieldsSet} insideShippedPerSessionBudget=${cfg.insideShippedPerSessionBudget}`,
	);

	const crossing = batch.usable
		? batch.packageMeanBytesPerCrossingMedian
		: null;
	const crossingBlocked = stops.some((s) => s.startsWith("P-STOP-B"));
	push(
		4,
		"crossing at the paced rate",
		!crossingBlocked && crossing !== null && crossing >= GATE_CROSSING_BYTES,
		crossingBlocked
			? "P-STOP-B fired; no crossing claim"
			: crossing === null
				? "P-batch is not usable; no crossing number"
				: `P-batch median ${crossing.toFixed(0)} B/crossing vs bar ${GATE_CROSSING_BYTES} B at ${batchGbps?.toFixed(3) ?? "n/a"} Gbps delivered (maxBatchBytes ${batch.maxBatchBytes ?? "n/a"}, paced control ${control.packageMeanBytesPerCrossingMedian?.toFixed(0) ?? "n/a"} B)`,
	);

	const refGbps = windowRef.usable ? windowRef.deliveredGbpsMedian : null;
	const matchRatio =
		batchGbps !== null && refGbps !== null && refGbps > 0
			? batchGbps / refGbps
			: null;
	push(
		5,
		"matched to the raised-window control",
		matchRatio !== null && matchRatio >= GATE_MATCH_RATIO,
		matchRatio === null
			? "P-batch or P-window-ref is not usable; no match ratio"
			: `P-batch/P-window-ref = ${matchRatio.toFixed(3)} vs bar ${GATE_MATCH_RATIO} (${batchGbps?.toFixed(3)} / ${refGbps?.toFixed(3)} Gbps, both offered ${windowRef.paceTargetGbps.toFixed(2)} Gbps)`,
	);

	const batchDrops = batch.serverSocketDropsMax;
	push(
		6,
		"server-side rcvbuf drops on the gate arm",
		batchDrops === 0,
		batchDrops === null
			? "P-batch server socket drops were not measurable in every repeat"
			: `P-batch serverSocketDrops per repeat [${batch.serverSocketDropsSamples.map((d) => (d === null ? "unmeasurable" : d)).join(", ")}]`,
	);

	const failed = clauses.filter((c) => !c.pass);

	const a6 = (() => {
		if (!a6Raised.usable || !a6Shipped.usable) {
			return {
				verdict: "unknown",
				reason: "A6 at the chosen default: an unpaced A6 cell is not usable",
			};
		}
		const n = a6Raised.deliveredGbpsMedian;
		const d = a6Shipped.deliveredGbpsMedian;
		if (n === null || d === null || d <= 0) {
			return {
				verdict: "unknown",
				reason: "A6 at the chosen default: no ratio",
			};
		}
		const ratio = n / d;
		return {
			verdict:
				ratio > A6_WINDOW_BOUND_RATIO ? "WINDOW-BOUND" : "WINDOWS-NOT-BINDING",
			ratio,
			raisedGbps: n,
			shippedGbps: d,
			unpaced: true,
			reason:
				ratio > A6_WINDOW_BOUND_RATIO
					? "A6 at the chosen default (knob unset, unpaced): raised windows beat the shipped ones by >10%, so that configuration is flow-control bound and its delivered figure bounds the N-API boundary from below"
					: "A6 at the chosen default (knob unset, unpaced): raised windows made no material difference; the shipped windows are not the binding constraint there",
		};
	})();

	const leverEffect =
		batch.usable &&
		control.usable &&
		batch.deliveredGbpsMedian !== null &&
		control.deliveredGbpsMedian !== null &&
		control.deliveredGbpsMedian > 0
			? batch.deliveredGbpsMedian / control.deliveredGbpsMedian
			: null;

	return {
		gate: "G5b",
		preregistration: "docs/research/preregistrations/gate-g5b.md",
		supersedes:
			"docs/research/preregistrations/gate-g5-bulk.md returned NO-VERDICT via its host-saturation STOP; this is the paced gate it prescribed, a new registration and not a rerun",
		paceTargetGbps: PACE_TARGET_GBPS,
		verdict:
			stops.length > 0 ? "NO-VERDICT" : failed.length === 0 ? "PASS" : "MISS",
		failedClauses: failed.map((c) => `${c.clause} ${c.name}: ${c.detail}`),
		clauses,
		stops,
		cells: ALL_CELLS.map((n) => get(n)),
		// Every cell's drops beside every cell's delivered figure, in one place.
		// Phase-1 put them in two documents and the review found it.
		dropDisclosure: ALL_CELLS.map((n) => ({
			cell: n,
			deliveredGbpsSamples: get(n).deliveredGbpsSamples,
			serverSocketDropsSamples: get(n).serverSocketDropsSamples,
			coResidentDropVerdicts: get(n).coResidentDropVerdicts,
			deliveredIsLowerBound: get(n).deliveredIsLowerBound,
		})),
		a6AtChosenDefault: a6,
		a6AtKnobOn: {
			verdict: "not-measurable",
			reason: A6_KNOB_ON_NOT_MEASURABLE,
		},
		derived: {
			leverEffectBatchOverControl: leverEffect,
			controlCrossingBytes: control.packageMeanBytesPerCrossingMedian,
			batchCrossingBytes: batch.packageMeanBytesPerCrossingMedian,
			controlCrossingsPerSecond: control.crossingsPerSecondMedian,
			batchCrossingsPerSecond: batch.crossingsPerSecondMedian,
			controlServerCpuMsPerGbit: control.serverCpuMsPerGbitMedian,
			batchServerCpuMsPerGbit: batch.serverCpuMsPerGbitMedian,
			batchHostCpuPctMedian: batch.hostCpuPctMedian,
		},
		notes: {
			pacing: PACE_NOTE,
			crossingClause: CROSSING_CLAUSE_NOTE,
			serverSocketDrops: SERVER_SOCKET_DROP_NOTE,
			clause6Scope:
				"Clause 6 binds on P-batch, the cell the gate's claim is made of. It does not bind on the unpaced A6 pair (running the path until something binds is their function, so drops there are a ceiling's signature, not a falsifier) nor on P-control / P-window-ref (both offered more than their unpaced ceilings by registered expectation). Every cell's per-repeat drops are disclosed above and a non-zero count marks that cell's delivered figure a lower bound",
			pacedShortfall:
				"A paced-shortfall on P-batch does not block clause 2: the clause asks whether >= 1.000 Gbps was delivered, and a reliable stream whose bytes arrived and drained delivered them whatever the offer was. The shortfall is disclosed beside the figure. INCOMPLETE buckets — including paced-overshoot — do block it",
			a6: "A6 is a disclosure, not a gate clause. It is re-run on the unpaced pair because two cells held at one offer deliver the same rate and their ratio would measure the pacer. WINDOW-BOUND moves the axis's bulkCeilingIsLowerBoundOnly flag",
			rerun:
				"A miss on a valid run is final for the effort and routes to its mechanism ticket (07 for clauses 2 and 4, 09 for clauses 3 and 5, the rig for clause 6). Re-running P-batch at another batch budget or at another pace point to clear the bar is forbidden by the pre-registration",
		},
	};
}
