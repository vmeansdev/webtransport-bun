import { describe, expect, test } from "bun:test";
import { resolveVR, rollUpShardedArms } from "./g6-sharded-arms-evaluate.ts";
import type { ShardedArmsCellVerdict } from "./g6-sharded-arms-grade.ts";
import { SHARDED_ARMS_CELLS } from "./g6-sharded-arms-grade.ts";

function cell(
	id: string,
	verdict: ShardedArmsCellVerdict["verdict"],
): ShardedArmsCellVerdict {
	const spec = SHARDED_ARMS_CELLS.find((c) => c.id === id);
	if (spec === undefined) throw Error(id);
	return {
		schema: "g6-sharded-arms-cell/1",
		preregistrationId: "g6-sharded-arms/1",
		cell: spec.id,
		arm: spec.arm,
		role: spec.role,
		verdict,
		verdictForce: spec.role !== "characterization",
		invalidReasons: [],
		clauses: [],
		reportedBeside: [],
		falsifiers: [],
		characterization: {},
		disclosures: [],
		vR: null,
	};
}
const official = { authoritative: true, rehearsalOverrides: [] };

describe("g6-sharded-arms stamp roll-up", () => {
	test("a complete run: hotspot from H40k, storm from its three gate cells", () => {
		const stamp = rollUpShardedArms(
			[
				cell("H5k", "MISS"),
				cell("H40k", "PASS"),
				cell("S1-5k", "PASS"),
				cell("S2-5k", "PASS"),
				cell("S1-40k", "MISS"),
				cell("S2-40k", "MISS"),
			],
			official,
		);
		expect(stamp.run).toBe("COMPLETE");
		expect(stamp.preregistrationId).toBe("g6-sharded-arms/1");
		expect(stamp.arms.hotspot).toEqual({
			verdict: "PASS",
			gateCell: "H40k",
			bridge: "MISS",
		});
		expect(stamp.arms.storm.verdict).toBe("MISS");
		expect(stamp.arms.storm.gateCells).toEqual(["S1-5k", "S2-5k", "S1-40k"]);
		// S2-40k never carries the storm verdict.
		expect(stamp.arms.storm.characterization).toBe("MISS");
		const allPass = rollUpShardedArms(
			[
				cell("H5k", "PASS"),
				cell("H40k", "PASS"),
				cell("S1-5k", "PASS"),
				cell("S2-5k", "PASS"),
				cell("S1-40k", "PASS"),
				cell("S2-40k", "MISS"),
			],
			official,
		);
		expect(allPass.arms.storm.verdict).toBe("PASS");
	});

	test("a storm INVALID stops INCOMPLETE without voiding stamped hotspot cells", () => {
		const stamp = rollUpShardedArms(
			[cell("H5k", "PASS"), cell("H40k", "MISS"), cell("S1-5k", "INVALID")],
			official,
		);
		expect(stamp.run).toBe("INCOMPLETE");
		expect(stamp.arms.hotspot.verdict).toBe("MISS");
		expect(stamp.arms.storm.verdict).toBe("INVALID");
		expect(stamp.arms.storm.characterization).toBe("NOT RUN");
	});

	test("an INVALID hotspot gate leaves the storm arm not run", () => {
		const stamp = rollUpShardedArms(
			[cell("H5k", "PASS"), cell("H40k", "INVALID")],
			official,
		);
		expect(stamp.arms.hotspot.verdict).toBe("INVALID");
		expect(stamp.arms.storm.verdict).toBe("INCOMPLETE");
	});

	test("order and the INVALID stop are enforced", () => {
		expect(() => rollUpShardedArms([cell("H40k", "PASS")], official)).toThrow(
			"prefix",
		);
		expect(() =>
			rollUpShardedArms(
				[cell("H5k", "INVALID"), cell("H40k", "PASS")],
				official,
			),
		).toThrow("after an INVALID");
		expect(() =>
			rollUpShardedArms([cell("H5k", "INVALID"), cell("H40k", "PASS")], {
				...official,
				continueAfterInvalid: true,
			}),
		).toThrow("rehearsal-only");
		const dry = rollUpShardedArms(
			[cell("H5k", "INVALID"), cell("H40k", "PASS")],
			{
				authoritative: false,
				rehearsalOverrides: ["x"],
				continueAfterInvalid: true,
			},
		);
		expect(dry.authoritative).toBe(false);
	});

	test("a clause INCOMPLETE stops the roll-up like INVALID", () => {
		expect(() =>
			rollUpShardedArms(
				[
					cell("H5k", "PASS"),
					cell("H40k", "INCOMPLETE"),
					cell("S1-5k", "PASS"),
				],
				official,
			),
		).toThrow("after an INVALID or INCOMPLETE");
		// A last-cell INCOMPLETE (even the characterization cell) is not COMPLETE.
		const stamp = rollUpShardedArms(
			[
				cell("H5k", "PASS"),
				cell("H40k", "PASS"),
				cell("S1-5k", "PASS"),
				cell("S2-5k", "PASS"),
				cell("S1-40k", "PASS"),
				cell("S2-40k", "INCOMPLETE"),
			],
			official,
		);
		expect(stamp.run).toBe("INCOMPLETE");
		expect(stamp.arms.storm.verdict).toBe("PASS");
		expect(stamp.sources).toEqual([]);
	});
});

describe("V-R's R in the stamp", () => {
	test("the frozen 500 ms R is used when no rehearsal R is given", () => {
		const overrides: string[] = [];
		expect(resolveVR(null, overrides)).toEqual({ ms: 500, source: "frozen" });
		expect(overrides).toEqual([]);
	});

	test("a frozen R wins: a rehearsal R is refused, never substituted", () => {
		const overrides: string[] = [];
		expect(() => resolveVR("100", overrides)).toThrow("R is frozen at 500 ms");
		expect(overrides).toEqual([]);
	});

	test("before R is frozen a rehearsal R grades, non-authoritatively", () => {
		const overrides: string[] = [];
		expect(resolveVR("250", overrides, null)).toEqual({
			ms: 250,
			source: "rehearsal",
		});
		expect(overrides).toEqual(["V-R R = 250 ms (rehearsal; R not frozen)"]);
		expect(() => resolveVR("2.5", [], null)).toThrow("integer");
	});
});
