import { describe, expect, test } from "bun:test";
import {
	enumerateWorkPlanBranches,
	evaluateWorkPlanTimeAdmission,
	validateWorkPlan,
	type WorkPlan,
} from "./g6-c32-work-plan.ts";

function chain(length: number, maximumSeconds = 480): WorkPlan {
	return {
		schema: "g6-c32-work-plan/1",
		id: "capacity-test",
		setupMaximumSeconds: 840,
		controlMaximumSeconds: 120,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 840 + 120 + length * maximumSeconds,
		profiles: ["candidate"],
		entry: "cell-1",
		nodes: Array.from({ length }, (_, index) => ({
			id: `cell-${index + 1}`,
			label: `L${index + 1}`,
			kind: "ladder" as const,
			profile: "candidate",
			requestedSessions: 40_000,
			activeWorkloadSessions: 40_000,
			maximumSeconds,
			next: {
				PASS:
					index + 1 < length
						? `cell-${index + 2}`
						: { terminal: "COMPLETE" as const },
				MISS: { terminal: "INCOMPLETE" as const },
				INVALID: { terminal: "INCOMPLETE" as const },
			},
		})),
	};
}

function repeated50kMiss(): WorkPlan {
	const plan = chain(10);
	const rungs = [
		5_000, 10_000, 20_000, 30_000, 40_000, 40_000, 50_000, 50_000, 50_000,
		50_000,
	];
	const labels = [
		"L5000-1",
		"L10000-1",
		"L20000-1",
		"L30000-1",
		"L40000-1",
		"L40000-2",
		"L50000-1",
		"L50000-2",
		"C1",
		"C2",
	];
	return {
		...plan,
		nodes: plan.nodes.map((node, index) => ({
			...node,
			label: labels[index]!,
			kind: index >= 8 ? "companion" : "ladder",
			requestedSessions: rungs[index]!,
			activeWorkloadSessions: index >= 8 ? 40_000 : rungs[index]!,
			next:
				index === 7
					? {
							PASS: { terminal: "COMPLETE" },
							MISS: "cell-9",
							INVALID: { terminal: "INCOMPLETE" },
						}
					: index >= 8
						? { ...node.next, MISS: node.next.PASS }
						: node.next,
		})),
	};
}

describe("G6 executable work-plan timing", () => {
	test("counts paid setup exactly once and includes the ten-cell repeated-50k-MISS suffix", () => {
		const plan = repeated50kMiss();
		const branches = enumerateWorkPlanBranches(plan);
		const longest = branches.toSorted(
			(a, b) => b.cellSeconds - a.cellSeconds,
		)[0]!;
		expect(longest.steps).toHaveLength(10);
		expect(longest.steps[7]).toEqual({ nodeId: "cell-8", outcome: "MISS" });
		expect(longest.cellSeconds).toBe(4_800);
		expect(longest.activeSeconds).toBe(5_760);
		expect(longest.totalSeconds).toBe(6_360);
		expect(longest.terminal).toBe("COMPLETE");
	});

	test("rejects the old nine-cell active ceiling before dispatch", () => {
		expect(() =>
			validateWorkPlan({ ...repeated50kMiss(), activeMaximumSeconds: 5_400 }),
		).toThrow(/activeMaximumSeconds/);
	});

	test("models all eight attribution cells even when ACK results are MISS", () => {
		const base = chain(8, 420);
		const plan: WorkPlan = {
			...base,
			controlMaximumSeconds: 60,
			activeMaximumSeconds: 4_260,
			profiles: [
				"stock-probe-off",
				"stock-probe-on",
				"batch-no-hint",
				"batch-hint",
			],
			nodes: base.nodes.map((node, index) => ({
				...node,
				kind: "attribution",
				profile: [
					"stock-probe-off",
					"stock-probe-on",
					"batch-no-hint",
					"batch-hint",
					"batch-hint",
					"batch-no-hint",
					"stock-probe-on",
					"stock-probe-off",
				][index]!,
				next: { ...node.next, MISS: node.next.PASS },
			})),
		};
		const branches = enumerateWorkPlanBranches(plan);
		const allMiss = branches.find(
			(branch) =>
				branch.steps.length === 8 &&
				branch.steps.every(({ outcome }) => outcome === "MISS"),
		)!;
		expect(allMiss.totalSeconds).toBe(4_860);
		expect(allMiss.terminal).toBe("COMPLETE");
	});

	test("rejects the r117 remaining repeat-plus-two-companions at 20:28:41 with a20:50 deadline", () => {
		const plan = chain(3);
		const decision = evaluateWorkPlanTimeAdmission({
			plan,
			completed: [],
			setupComplete: true,
			elapsedPaidSeconds: 0,
			controlUsedSeconds: 0,
			remainingDeadlineSeconds: 1_278,
		});
		expect(decision.decision).toBe("REFUSED_DEADLINE");
		expect(decision.requiredDeadlineSeconds).toBe(2_160);
	});

	test("pre-create admission reserves setup, the full longest branch, control and teardown", () => {
		const input = {
			plan: repeated50kMiss(),
			completed: [],
			setupComplete: false,
			elapsedPaidSeconds: 0,
			controlUsedSeconds: 0,
			remainingDeadlineSeconds: 6_359,
		};
		expect(evaluateWorkPlanTimeAdmission(input).decision).toBe(
			"REFUSED_DEADLINE",
		);
		expect(
			evaluateWorkPlanTimeAdmission({
				...input,
				remainingDeadlineSeconds: 6_360,
			}),
		).toMatchObject({
			decision: "FEASIBLE",
			requiredExecutionSeconds: 5_760,
			requiredDeadlineSeconds: 6_360,
			nextNodeId: "cell-1",
		});
	});

	test("does not count elapsed paid setup twice and refuses unfinished setup at its bound", () => {
		const plan = chain(1);
		plan.setupMaximumSeconds = 10;
		plan.controlMaximumSeconds = 5;
		plan.teardownReserveSeconds = 2;
		plan.nodes[0]!.maximumSeconds = 3;
		plan.activeMaximumSeconds = 18;
		const input = {
			plan,
			completed: [],
			setupComplete: false,
			elapsedPaidSeconds: 4,
			controlUsedSeconds: 0,
			remainingDeadlineSeconds: 16,
		};
		expect(evaluateWorkPlanTimeAdmission(input)).toMatchObject({
			decision: "FEASIBLE",
			requiredExecutionSeconds: 14,
			requiredDeadlineSeconds: 16,
		});
		expect(
			evaluateWorkPlanTimeAdmission({ ...input, remainingDeadlineSeconds: 15 })
				.decision,
		).toBe("REFUSED_DEADLINE");
		for (const elapsedPaidSeconds of [10, 11])
			expect(
				evaluateWorkPlanTimeAdmission({
					...input,
					elapsedPaidSeconds,
					remainingDeadlineSeconds: 100,
				}).decision,
			).toBe("REFUSED_DEADLINE");
	});

	test("before the50k repeat reserves its possible MISS plus both companions", () => {
		const completed = Array.from({ length: 7 }, (_, i) => ({
			nodeId: `cell-${i + 1}`,
			outcome: "PASS" as const,
		}));
		const result = evaluateWorkPlanTimeAdmission({
			plan: repeated50kMiss(),
			completed,
			setupComplete: true,
			elapsedPaidSeconds: 3_000,
			controlUsedSeconds: 20,
			remainingDeadlineSeconds: 2_139,
		});
		expect(result).toMatchObject({
			decision: "REFUSED_DEADLINE",
			nextNodeId: "cell-8",
			requiredExecutionSeconds: 1_540,
			requiredDeadlineSeconds: 2_140,
		});
	});

	test("active time exhaustion refuses even if wall deadline has room", () => {
		expect(
			evaluateWorkPlanTimeAdmission({
				plan: chain(1),
				completed: [],
				setupComplete: true,
				elapsedPaidSeconds: 841,
				controlUsedSeconds: 0,
				remainingDeadlineSeconds: 100_000,
			}).decision,
		).toBe("REFUSED_DEADLINE");
	});

	test("invalid outcome forces teardown and cannot admit another cell", () => {
		const plan = chain(2);
		const completed = [{ nodeId: "cell-1", outcome: "INVALID" as const }];
		expect(
			evaluateWorkPlanTimeAdmission({
				plan,
				completed,
				setupComplete: true,
				elapsedPaidSeconds: 1_000,
				controlUsedSeconds: 0,
				remainingDeadlineSeconds: 2_000,
			}),
		).toMatchObject({
			decision: "TEARDOWN",
			terminal: "INCOMPLETE",
			nextNodeId: null,
		});
		expect(() =>
			evaluateWorkPlanTimeAdmission({
				plan,
				completed: [...completed, { nodeId: "cell-2", outcome: "PASS" }],
				setupComplete: true,
				elapsedPaidSeconds: 1_000,
				controlUsedSeconds: 0,
				remainingDeadlineSeconds: 2_000,
			}),
		).toThrow(/terminal/);
	});

	test("rejects skipped, replayed, and unknown completed cells", () => {
		for (const completed of [
			[{ nodeId: "cell-2", outcome: "PASS" }],
			[
				{ nodeId: "cell-1", outcome: "PASS" },
				{ nodeId: "cell-1", outcome: "PASS" },
			],
			[{ nodeId: "cell-1", outcome: "CLEAN" }],
		])
			expect(() =>
				evaluateWorkPlanTimeAdmission({
					plan: chain(2),
					completed,
					setupComplete: true,
					elapsedPaidSeconds: 0,
					controlUsedSeconds: 0,
					remainingDeadlineSeconds: 10_000,
				}),
			).toThrow();
	});

	test("rejects zero, negative, nonfinite, fractional and unsafe durations", () => {
		const zeroControl = chain(1);
		zeroControl.activeMaximumSeconds -= zeroControl.controlMaximumSeconds;
		zeroControl.controlMaximumSeconds = 0;
		expect(() => validateWorkPlan(zeroControl)).toThrow();
		for (const value of [
			0,
			-1,
			Infinity,
			NaN,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			for (const key of [
				"setupMaximumSeconds",
				"controlMaximumSeconds",
				"teardownReserveSeconds",
				"activeMaximumSeconds",
			])
				expect(() => validateWorkPlan({ ...chain(1), [key]: value })).toThrow();
			const plan = chain(1);
			expect(() =>
				validateWorkPlan({
					...plan,
					nodes: [{ ...plan.nodes[0], maximumSeconds: value }],
				}),
			).toThrow();
		}
	});

	test("rejects unknown schema, profiles, missing nodes, cycles and unreachable nodes", () => {
		const plan = chain(2);
		for (const invalid of [
			{ ...plan, schema: "g6-c32-work-plan/2" },
			{ ...plan, profiles: ["other"] },
			{ ...plan, nodes: plan.nodes.slice(0, 1) },
			{
				...plan,
				nodes: [
					plan.nodes[0],
					{
						...plan.nodes[1],
						next: { ...plan.nodes[1]!.next, PASS: "cell-1" },
					},
				],
			},
			{ ...plan, nodes: [...plan.nodes, { ...plan.nodes[1], id: "unused" }] },
		])
			expect(() => validateWorkPlan(invalid)).toThrow();
	});

	test("rejects hidden fields, invalid INVALID branches and duplicate labels on a path", () => {
		const plan = chain(2);
		for (const invalid of [
			{ ...plan, skipBudget: true },
			{
				...plan,
				nodes: [
					{
						...plan.nodes[0],
						next: { ...plan.nodes[0]!.next, INVALID: "cell-2" },
					},
					plan.nodes[1],
				],
			},
			{ ...plan, nodes: [plan.nodes[0], { ...plan.nodes[1], label: "L1" }] },
		])
			expect(() => validateWorkPlan(invalid)).toThrow();
	});

	test("companions cannot masquerade as full-rate cells or use invalid session counts", () => {
		for (const override of [
			{ kind: "companion", activeWorkloadSessions: 40_000 },
			{ kind: "ladder", activeWorkloadSessions: 30_000 },
			{ requestedSessions: 0 },
			{ requestedSessions: Infinity },
		]) {
			const plan = chain(1);
			expect(() =>
				validateWorkPlan({
					...plan,
					nodes: [{ ...plan.nodes[0], ...override }],
				}),
			).toThrow();
		}
	});
});
