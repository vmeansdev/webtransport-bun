/**
 * Gate G5b's rules, exercised before the dispatch they adjudicate.
 *
 * The contract is docs/research/preregistrations/gate-g5b.md. Every case here
 * is a clause, a STOP or an integrity rule from that document, run against
 * synthetic cells so the rules are known to execute — and to refuse — before a
 * runner ever produces a number for them.
 */

import { describe, expect, test } from "bun:test";
import {
	ALL_CELLS,
	CLAUSE_BEARING_CELLS,
	evaluateGateG5b,
	GATE_BATCH_BYTES,
	GATE_CROSSING_BYTES,
	GATE_MATCH_RATIO,
	GATE_THROUGHPUT_GBPS,
	isPacedShortfall,
	PACE_OVERSHOOT_RATIO,
	PACE_SHORTFALL_RATIO,
	PACE_TARGET_GBPS,
	type PacedCellName,
	type PacedRepeatFacts,
	paceBucket,
} from "./gate-g5b.ts";

const SHIPPED_PER_STREAM = 256 * 1024;
const SHIPPED_PER_SESSION = 2 * 1024 * 1024;
const RAISED_PER_STREAM = 16 * 1024 * 1024;
const RAISED_PER_SESSION = 64 * 1024 * 1024;

type Overrides = Partial<PacedRepeatFacts>;

function repeat(
	cell: PacedCellName,
	r: number,
	over: Overrides = {},
): PacedRepeatFacts {
	const raised = cell === "P-window-ref" || cell === "A6-raised";
	const paced = cell.startsWith("P-");
	const batched = cell === "P-batch";
	return {
		cell,
		repeat: r,
		bucket: paced ? "paced-cell" : "gate-cell",
		incomplete: false,
		paceTargetGbps: paced ? PACE_TARGET_GBPS : 0,
		offeredGbps: paced ? PACE_TARGET_GBPS : null,
		deliveredMbps: 1240,
		packageMeanBytesPerCrossing: batched ? 20000 : 1388,
		harnessMeanBytesPerCrossing: batched ? 20000 : 1388,
		crossingsPerSecond: batched ? 7800 : 74000,
		maxBatchBytes: batched ? GATE_BATCH_BYTES : 1422,
		batchedCrossings: batched ? 500000 : 0,
		serverSocketDrops: 0,
		coResidentDrops: 0,
		coResidentDropVerdict: "IMMATERIAL",
		serverSocketRxQueueBytesAtEnd: 0,
		queuedBytesPerStream: raised ? RAISED_PER_STREAM : SHIPPED_PER_STREAM,
		queuedBytesPerSession: raised ? RAISED_PER_SESSION : SHIPPED_PER_SESSION,
		explicitWindowFieldsSet: false,
		insideShippedPerSessionBudget: !raised,
		batchBytesConfigured: batched ? GATE_BATCH_BYTES : 0,
		hostCpuPctMedian: 40,
		serverCpuPct: 60,
		clientCpuPct: 50,
		serverCpuMsPerGbit: 500,
		rssMbPeak: 300,
		...over,
	};
}

/** A run in which every clause passes; individual tests spoil one thing. */
function passingRun(spoil: Partial<Record<PacedCellName, Overrides>> = {}) {
	const out: PacedRepeatFacts[] = [];
	for (const cell of ALL_CELLS) {
		for (const r of [1, 2]) {
			const base: Overrides = {};
			// The unpaced A6 pair: the raised cell beats the shipped one, which is
			// the axis's long-standing WINDOW-BOUND reading.
			if (cell === "A6-shipped") base.deliveredMbps = 880;
			if (cell === "A6-raised") base.deliveredMbps = 1142;
			// The paced control falls short of the offer without the lever: the
			// registered expectation.
			if (cell === "P-control") {
				base.deliveredMbps = 890;
				base.offeredGbps = 0.89;
			}
			out.push(repeat(cell, r, { ...base, ...(spoil[cell] ?? {}) }));
		}
	}
	return out;
}

describe("pacing rules", () => {
	test("the pacer's own falsifier fires only above the overshoot band", () => {
		const at = PACE_TARGET_GBPS * PACE_OVERSHOOT_RATIO;
		expect(
			paceBucket({ paceTargetGbps: PACE_TARGET_GBPS, offeredGbps: at }),
		).toBeNull();
		expect(
			paceBucket({
				paceTargetGbps: PACE_TARGET_GBPS,
				offeredGbps: at + 0.001,
			}),
		).toBe("paced-overshoot");
	});

	test("an unmeasured offer on a paced cell is not a pass", () => {
		expect(
			paceBucket({ paceTargetGbps: PACE_TARGET_GBPS, offeredGbps: null }),
		).toBe("pace-unmeasurable");
	});

	test("unpaced cells are exempt from both pacing rules", () => {
		expect(paceBucket({ paceTargetGbps: 0, offeredGbps: 99 })).toBeNull();
		expect(isPacedShortfall({ paceTargetGbps: 0, offeredGbps: 0.1 })).toBe(
			false,
		);
	});

	test("shortfall is measured against the registered band, not eyeballed", () => {
		const edge = PACE_TARGET_GBPS * PACE_SHORTFALL_RATIO;
		expect(
			isPacedShortfall({ paceTargetGbps: PACE_TARGET_GBPS, offeredGbps: edge }),
		).toBe(false);
		expect(
			isPacedShortfall({
				paceTargetGbps: PACE_TARGET_GBPS,
				offeredGbps: edge - 0.001,
			}),
		).toBe(true);
	});
});

describe("the six clauses", () => {
	test("a clean run passes all six", () => {
		const v = evaluateGateG5b(passingRun());
		expect(v.verdict).toBe("PASS");
		expect(v.failedClauses).toEqual([]);
		expect(v.stops).toEqual([]);
		expect(v.clauses).toHaveLength(6);
	});

	test("clause 2 misses when the gate arm delivers under the bar", () => {
		const v = evaluateGateG5b(
			passingRun({ "P-batch": { deliveredMbps: 999 } }),
		);
		expect(v.verdict).toBe("MISS");
		expect(v.failedClauses.join()).toContain("2 throughput");
		expect(v.clauses[1]?.detail).toContain(GATE_THROUGHPUT_GBPS.toFixed(3));
	});

	test("clause 3 misses when the gate arm leaves the shipped governors", () => {
		const v = evaluateGateG5b(
			passingRun({
				"P-batch": {
					queuedBytesPerStream: RAISED_PER_STREAM,
					queuedBytesPerSession: RAISED_PER_SESSION,
					insideShippedPerSessionBudget: false,
				},
			}),
		);
		expect(v.verdict).toBe("MISS");
		expect(v.failedClauses.join()).toContain("3 inside shipped budgets");
	});

	test("clause 3 misses on an explicit window field even inside the budget", () => {
		const v = evaluateGateG5b(
			passingRun({ "P-batch": { explicitWindowFieldsSet: true } }),
		);
		expect(v.failedClauses.join()).toContain("3 inside shipped budgets");
	});

	test("clause 4 misses when the paced rate leaves crossings under 8 KiB", () => {
		const v = evaluateGateG5b(
			passingRun({
				"P-batch": {
					packageMeanBytesPerCrossing: GATE_CROSSING_BYTES - 1,
					harnessMeanBytesPerCrossing: GATE_CROSSING_BYTES - 1,
				},
			}),
		);
		expect(v.verdict).toBe("MISS");
		expect(v.failedClauses.join()).toContain("4 crossing");
	});

	test("clause 5 misses when the raised-window cell outruns the gate arm", () => {
		const v = evaluateGateG5b(
			passingRun({
				"P-batch": { deliveredMbps: 1000 },
				"P-window-ref": { deliveredMbps: 1240 },
			}),
		);
		expect(v.verdict).toBe("MISS");
		expect(v.failedClauses.join()).toContain(
			"5 matched to the raised-window control",
		);
		expect(v.clauses[4]?.detail).toContain(String(GATE_MATCH_RATIO));
	});

	test("clause 6 binds on the gate arm, not on the control", () => {
		const onBatch = evaluateGateG5b(
			passingRun({ "P-batch": { serverSocketDrops: 1 } }),
		);
		expect(onBatch.verdict).toBe("MISS");
		expect(onBatch.failedClauses.join()).toContain("6 server-side rcvbuf");

		// Phase-1 bound the clause on the control; G5b binds it on the cell the
		// claim is made of and discloses the rest.
		const elsewhere = evaluateGateG5b(
			passingRun({
				"P-control": { serverSocketDrops: 1975 },
				"P-window-ref": { serverSocketDrops: 1777 },
				"A6-raised": { serverSocketDrops: 523 },
			}),
		);
		expect(elsewhere.verdict).toBe("PASS");
	});

	test("clause 6 does not read an unmeasurable drop count as a zero", () => {
		const v = evaluateGateG5b(
			passingRun({ "P-batch": { serverSocketDrops: null } }),
		);
		expect(v.verdict).toBe("MISS");
		expect(v.failedClauses.join()).toContain("not measurable");
	});
});

describe("completeness and the STOPs", () => {
	test("P-STOP-A fires on an unusable clause-bearing cell and issues no verdict", () => {
		for (const cell of CLAUSE_BEARING_CELLS) {
			const v = evaluateGateG5b(
				passingRun({ [cell]: { incomplete: true, bucket: "host-saturated" } }),
			);
			expect(v.verdict).toBe("NO-VERDICT");
			expect(v.stops.join()).toContain("P-STOP-A");
			expect(v.stops.join()).toContain(cell);
		}
	});

	test("P-control is disclosed, not gating: an incomplete control still passes", () => {
		const v = evaluateGateG5b(
			passingRun({
				"P-control": { incomplete: true, bucket: "drain-incomplete" },
			}),
		);
		expect(v.verdict).toBe("PASS");
		expect(v.clauses[0]?.detail).toContain("drain-incomplete");
	});

	test("P-STOP-B blocks the crossing claim for the whole arm", () => {
		const v = evaluateGateG5b(
			passingRun({
				"A6-shipped": {
					incomplete: true,
					bucket: "crossing-instrument-disagreement",
				},
			}),
		);
		expect(v.stops.join()).toContain("P-STOP-B");
		expect(v.clauses[3]?.pass).toBe(false);
		expect(v.clauses[3]?.detail).toContain("no crossing claim");
	});

	test("P-STOP-1 fires when the pacing mechanism's falsifier fired", () => {
		const v = evaluateGateG5b(
			passingRun({
				"P-batch": { incomplete: true, bucket: "paced-overshoot" },
			}),
		);
		expect(v.verdict).toBe("NO-VERDICT");
		expect(v.stops.join()).toContain("P-STOP-1");
		expect(v.stops.join()).toContain("P-batch-r1");
	});

	test("an INCOMPLETE repeat is never silently dropped from a median", () => {
		const repeats = passingRun();
		const spoiled = repeats.map((r) =>
			r.cell === "P-batch" && r.repeat === 2
				? {
						...r,
						incomplete: true,
						bucket: "host-saturated",
						deliveredMbps: 4000,
					}
				: r,
		);
		const v = evaluateGateG5b(spoiled);
		expect(v.verdict).toBe("NO-VERDICT");
		const batch = v.cells.find((c) => c.cell === "P-batch");
		expect(batch?.usable).toBe(false);
		// The unusable cell still reports both samples; it just grades nothing.
		expect(batch?.deliveredGbpsSamples).toHaveLength(2);
		expect(v.clauses[1]?.pass).toBe(false);
	});
});

describe("shortfall handling, registered before the run", () => {
	test("a shortfall on the gate arm does not block clause 2", () => {
		// Both paced cells fall short of the 1.25 Gbps offer; the gate arm still
		// sustained more than the 1.000 Gbps bar, which is the product statement
		// the bar was written to license.
		const v = evaluateGateG5b(
			passingRun({
				"P-batch": { deliveredMbps: 1050, offeredGbps: 1.06 },
				"P-window-ref": { deliveredMbps: 1020, offeredGbps: 1.03 },
			}),
		);
		expect(v.verdict).toBe("PASS");
		expect(v.clauses[1]?.detail).toContain("paced-shortfall");
		expect(v.cells.find((c) => c.cell === "P-batch")?.pacedShortfall).toBe(
			true,
		);
	});

	test("a shortfall in one repeat of two still qualifies the cell", () => {
		const repeats = passingRun().map((r) =>
			r.cell === "P-window-ref" && r.repeat === 1
				? { ...r, offeredGbps: 1.0 }
				: r,
		);
		const v = evaluateGateG5b(repeats);
		expect(v.cells.find((c) => c.cell === "P-window-ref")?.pacedShortfall).toBe(
			true,
		);
	});
});

describe("the A6 falsifier and the disclosures", () => {
	test("A6 is read off the unpaced pair and reproduces WINDOW-BOUND", () => {
		const v = evaluateGateG5b(passingRun());
		expect(v.a6AtChosenDefault.verdict).toBe("WINDOW-BOUND");
		expect(v.a6AtChosenDefault.ratio).toBeCloseTo(1142 / 880, 3);
		expect(v.a6AtChosenDefault.unpaced).toBe(true);
	});

	test("A6 flips to WINDOWS-NOT-BINDING inside the 10% band", () => {
		const v = evaluateGateG5b(
			passingRun({ "A6-raised": { deliveredMbps: 900 } }),
		);
		expect(v.a6AtChosenDefault.verdict).toBe("WINDOWS-NOT-BINDING");
	});

	test("A6 knob-ON is a registered non-measurement, never an unknown", () => {
		const v = evaluateGateG5b(passingRun());
		expect(v.a6AtKnobOn.verdict).toBe("not-measurable");
		expect(v.a6AtKnobOn.reason).toContain("92.3%");
	});

	test("every cell's drops sit beside every cell's delivered figure", () => {
		const v = evaluateGateG5b(
			passingRun({ "P-window-ref": { serverSocketDrops: 1777 } }),
		);
		expect(v.dropDisclosure.map((d) => d.cell).sort()).toEqual(
			[...ALL_CELLS].sort(),
		);
		const ref = v.dropDisclosure.find((d) => d.cell === "P-window-ref");
		expect(ref?.serverSocketDropsSamples).toEqual([1777, 1777]);
		expect(ref?.deliveredIsLowerBound).toBe(true);
		expect(ref?.deliveredGbpsSamples).toHaveLength(2);
		const batch = v.dropDisclosure.find((d) => d.cell === "P-batch");
		expect(batch?.deliveredIsLowerBound).toBe(false);
	});

	test("the lever effect is refused when either of its cells is unusable", () => {
		const v = evaluateGateG5b(
			passingRun({
				"P-control": { incomplete: true, bucket: "host-saturated" },
			}),
		);
		expect(v.derived.leverEffectBatchOverControl).toBeNull();
	});

	test("the verdict names its registration and what it supersedes", () => {
		const v = evaluateGateG5b(passingRun());
		expect(v.preregistration).toBe(
			"docs/research/preregistrations/gate-g5b.md",
		);
		expect(v.supersedes).toContain("NO-VERDICT");
		expect(v.paceTargetGbps).toBe(PACE_TARGET_GBPS);
		expect(v.notes.rerun).toContain("forbidden");
	});
});
