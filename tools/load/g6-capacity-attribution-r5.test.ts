import { describe, expect, test } from "bun:test";
import {
	evaluateR5Attribution,
	median,
	R5_ATTRIBUTION_ORDER,
	type R5CellSummary,
} from "./g6-capacity-attribution-r5.ts";

const SHA = "a".repeat(40);
type Arm = "Xon" | "Xoff" | "A0" | "XB";
const ARM: Record<
	Arm,
	{ pump: "pump" | "legacy"; batch: number; probe: boolean }
> = {
	Xon: { pump: "pump", batch: 0, probe: true },
	Xoff: { pump: "pump", batch: 0, probe: false },
	A0: { pump: "legacy", batch: 0, probe: false },
	XB: { pump: "pump", batch: 64, probe: false },
};
const clauses = (s2 = 1, s4 = 20, pass = true) => ({
	S1: { value: 1, pass: true },
	S2: { value: s2, pass: s2 >= 0.995 },
	S3: { value: 1, pass: true },
	S4: { value: s4, pass: s4 <= 25 && pass },
	S5: { value: 0, pass: true },
});
function cell(
	nodeId: string,
	o: Partial<R5CellSummary> & { genCpu?: number; srvCpu?: number } = {},
	index = 0,
): R5CellSummary {
	const arm = nodeId.split("-")[0] as Arm;
	const b = ARM[arm];
	const s4 = o.ackP99Ms ?? 20;
	return {
		nodeId,
		outcome: s4 <= 25 ? "PASS" : "MISS",
		startedAt: new Date(Date.UTC(2026, 9, 2, 10, index * 7)).toISOString(),
		sourceSha: SHA,
		pairId: "srv:1/boot-a|gen:2/boot-b",
		datagramPump: b.pump,
		udpSendBatch: b.batch,
		detailedProbe: b.probe,
		serverSteadyCpuMs: o.srvCpu ?? 4_000_000,
		generatorSteadyCpuMs: o.genCpu ?? 2_500_000,
		snapshotIssued: 72_000_000,
		ackIssued: 2_400_000,
		serverRxTotal: 19_200_000,
		offeredMoves: 19_180_000,
		snapshotDue: 72_000_000,
		ackP50Ms: 2,
		ackP99Ms: s4,
		serverHoldP99Ms: 0.01,
		clauses: clauses(1, s4),
		...o,
	};
}
/** A0 = baseline costs; X* = 30% cheaper generator, 5% cheaper server. */
function run(
	over: Partial<
		Record<
			string,
			Partial<R5CellSummary> & { genCpu?: number; srvCpu?: number }
		>
	> = {},
): R5CellSummary[] {
	return R5_ATTRIBUTION_ORDER.map((id, i) => {
		const arm = id.split("-")[0] as Arm;
		const defaults =
			arm === "A0"
				? { genCpu: 3_500_000, srvCpu: 4_200_000, ackP99Ms: 150 }
				: {
						genCpu: 2_450_000,
						srvCpu: 4_000_000,
						ackP99Ms: arm === "XB" ? 19 : 20,
					};
		const merged = { ...defaults, ...over[id] };
		const c = cell(id, merged, i);
		return {
			...c,
			outcome: merged.outcome ?? c.outcome,
			clauses: merged.clauses ?? clauses(1, merged.ackP99Ms),
		};
	});
}
const evaluate = (cells: R5CellSummary[], batch = true) =>
	evaluateR5Attribution({
		cells,
		expectedSourceSha: SHA,
		batchOwnershipTestsPassed: batch,
	});

describe("r5 attribution decision", () => {
	test("median handles even and odd counts", () => {
		expect(median([3, 1])).toBe(2);
		expect(median([5, 1, 3])).toBe(3);
	});

	test("selects C-PUMP, stock send path, probe on, and B go when the rule is met", () => {
		const d = evaluate(run());
		expect(d.status).toBe("SELECTED");
		expect(d.candidate).toBe("C-PUMP");
		expect(d.sendPath).toBe("stock"); // XB 19 ms is not <= 0.85 x 20 ms
		expect(d.calibration.disposition).toBe("non-interference");
		expect(d.probeInB).toBe(true);
		expect(d.bGo).toBe(true);
		expect(d.disclosure.generatorCpuDeltaPct).toBeCloseTo(-30, 5);
		expect(d.disclosure.serverCpuDeltaPct).toBeCloseTo(
			(4.0 / 4.2 - 1) * 100,
			5,
		);
		expect(d.disclosure.resultScope).toBe("server+generator pair with C-PUMP");
	});

	test("an A0 delivery collapse does not skew per-offered ratios (offered, not delivered)", () => {
		const d = evaluate(
			run({
				"A0-1": {
					clauses: clauses(0.97, 2250),
					ackP99Ms: 2250,
					outcome: "MISS",
				},
			}),
		);
		expect(d.status).toBe("SELECTED");
		expect(d.medians.A0?.generatorUsPerOffered).toBeCloseTo(
			(3_500_000 * 1000) / 74_400_000,
			6,
		);
	});

	test("no candidate when the generator gain is under 10%", () => {
		const d = evaluate(
			run({ "Xoff-1": { genCpu: 3_300_000 }, "Xoff-2": { genCpu: 3_300_000 } }),
		);
		expect(d.status).toBe("NO_CANDIDATE");
		expect(d.bGo).toBe(false);
	});

	test("no candidate when the server side regresses", () => {
		const d = evaluate(
			run({ "Xoff-1": { srvCpu: 4_300_000 }, "Xoff-2": { srvCpu: 4_300_000 } }),
		);
		expect(d.status).toBe("NO_CANDIDATE");
	});

	test("no candidate when an Xoff cell loses delivery", () => {
		const d = evaluate(run({ "Xoff-2": { clauses: clauses(0.99, 20) } }));
		expect(d.status).toBe("NO_CANDIDATE");
	});

	test("batch64 needs a 15% ACK edge, no server regression and passing ownership receipts", () => {
		const better = { "XB-1": { ackP99Ms: 12 }, "XB-2": { ackP99Ms: 12 } };
		expect(evaluate(run(better)).sendPath).toBe("batch64");
		expect(evaluate(run(better), false).sendPath).toBe("stock");
		expect(
			evaluate(
				run({
					...better,
					"XB-1": { ackP99Ms: 12, srvCpu: 4_500_000 },
					"XB-2": { ackP99Ms: 12, srvCpu: 4_500_000 },
				}),
			).sendPath,
		).toBe("stock");
	});

	test("probe interference moves B to probe-off and binds go/no-go to Xoff", () => {
		const d = evaluate(
			run({ "Xon-1": { srvCpu: 4_400_000 }, "Xon-2": { srvCpu: 4_400_000 } }),
		);
		expect(d.calibration.disposition).toBe("interference");
		expect(d.probeInB).toBe(false);
		expect(d.bGo).toBe(true);
	});

	test("B no-go when the B arm misses S4 in either replicate", () => {
		// Xoff-2 missing also shifts calibration to "interference", so B would
		// run probe-off on Xoff, whose second replicate missed: no B.
		const d = evaluate(
			run({
				"Xoff-2": { ackP99Ms: 40 },
				"XB-1": { ackP99Ms: 30 },
				"XB-2": { ackP99Ms: 30 },
			}),
		);
		expect(d.status).toBe("SELECTED");
		expect(d.probeInB).toBe(false);
		expect(d.bGo).toBe(false);
		expect(d.bGoReasons[0]).toContain("Xoff");
	});

	test("B no-go on the probe-on arm when calibration holds but Xon misses S4", () => {
		const d = evaluate(
			run({
				"Xon-2": {
					ackP99Ms: 20.5,
					clauses: {
						S1: { value: 1, pass: true },
						S2: { value: 1, pass: true },
						S3: { value: 1, pass: true },
						S4: { value: 20.5, pass: false },
						S5: { value: 0, pass: true },
					},
				},
			}),
		);
		expect(d.calibration.disposition).toBe("non-interference");
		expect(d.bGo).toBe(false);
		expect(d.bGoReasons[0]).toContain("Xon");
	});

	test("an XB INVALID at the end only removes batch64", () => {
		const cells = run({ "XB-1": { outcome: "INVALID" } }).slice(0, 7);
		const d = evaluate(cells);
		expect(d.status).toBe("SELECTED");
		expect(d.sendPath).toBe("stock");
	});

	test("incomplete when a selection-critical arm is missing", () => {
		expect(evaluate(run().slice(0, 4)).status).toBe("INCOMPLETE");
	});

	test("refuses wrong order, mixed hosts, mixed source, mislabeled arms and cells after INVALID", () => {
		const r = run();
		expect(() =>
			evaluate([r[1] as R5CellSummary, r[0] as R5CellSummary, ...r.slice(2)]),
		).toThrow("expected Xon-1");
		expect(() =>
			evaluate(r.map((c, i) => (i === 3 ? { ...c, pairId: "other" } : c))),
		).toThrow("different host pair");
		expect(() =>
			evaluate(
				r.map((c, i) => (i === 2 ? { ...c, sourceSha: "b".repeat(40) } : c)),
			),
		).toThrow("source differs");
		expect(() =>
			evaluate(r.map((c, i) => (i === 2 ? { ...c, datagramPump: "pump" } : c))),
		).toThrow("profile echo");
		expect(() =>
			evaluate(r.map((c, i) => (i === 1 ? { ...c, outcome: "INVALID" } : c))),
		).toThrow("continue after an INVALID");
		expect(() =>
			evaluate(
				r.map((c, i) =>
					i === 5 ? { ...c, startedAt: r[0]?.startedAt as string } : c,
				),
			),
		).toThrow("not increasing");
	});

	test("parity violation makes the decision incomplete", () => {
		const d = evaluate(run({ "A0-2": { offeredMoves: 18_000_000 } }));
		expect(d.status).toBe("INCOMPLETE");
		expect(d.reasons.join(" ")).toContain("parity");
	});
});
