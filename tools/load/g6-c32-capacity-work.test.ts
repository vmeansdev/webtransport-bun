import { expect, test } from "bun:test";
import {
	makeAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
} from "./g6-c32-capacity-work.ts";
import {
	canonicalAuthoritySha256,
	requireDefined,
} from "./g6-c32-freeze-model.ts";
import {
	enumerateWorkPlanBranches,
	evaluateWorkPlanTimeAdmission,
} from "./g6-c32-work-plan.ts";

test("A executes exact A0 A1 B C C B A1 A0 under either valid ACK verdict", () => {
	const plan = makeAttributionWorkPlan();
	const complete = enumerateWorkPlanBranches(plan).filter(
		(branch) => branch.terminal === "COMPLETE",
	);
	expect(complete).toHaveLength(256);
	const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
	for (const branch of complete) {
		expect(
			branch.steps.map(
				(step) => requireDefined(nodes.get(step.nodeId)).profile,
			),
		).toEqual([
			"stock-probe-off",
			"stock-probe-on",
			"batch-no-hint",
			"batch-hint",
			"batch-hint",
			"batch-no-hint",
			"stock-probe-on",
			"stock-probe-off",
		]);
		expect(branch.totalSeconds).toBe(6120);
	}
});

test("B first5k MISS completes without follow-on work while INVALID stays incomplete", () => {
	const plan = makeCapacityLadderWorkPlan();
	const branches = enumerateWorkPlanBranches(plan);
	for (const outcome of ["MISS", "INVALID"] as const) {
		const completed = [{ nodeId: "L5000-1", outcome }];
		const terminal = outcome === "MISS" ? "COMPLETE" : "INCOMPLETE";
		expect(
			branches.filter((branch) => branch.steps[0]?.outcome === outcome),
		).toEqual([
			{
				steps: completed,
				terminal,
				cellSeconds: 480,
				activeSeconds: 2700,
				totalSeconds: 3300,
			},
		]);
		const admission = {
			plan,
			completed,
			setupComplete: true,
			elapsedPaidSeconds: 1320,
			controlUsedSeconds: 0,
			remainingDeadlineSeconds: 600,
		};
		expect(evaluateWorkPlanTimeAdmission(admission)).toEqual({
			decision: "TEARDOWN",
			nextNodeId: null,
			terminal,
			requiredExecutionSeconds: 0,
			requiredDeadlineSeconds: 600,
		});
		expect(() =>
			evaluateWorkPlanTimeAdmission({
				...admission,
				completed: [...completed, { nodeId: "L10000-1", outcome: "PASS" }],
			}),
		).toThrow(/terminal/);
	}
	// Normalize only the repaired edge and approved timing delta to the r2 DAG.
	const r2Plan = {
		...plan,
		setupMaximumSeconds: 840,
		activeMaximumSeconds: 5760,
		nodes: plan.nodes.map((node) =>
			node.id === "L5000-1"
				? { ...node, next: { ...node.next, MISS: { terminal: "INCOMPLETE" } } }
				: node,
		),
	};
	expect(canonicalAuthoritySha256(r2Plan)).toBe(
		"0390735409507870b76974b5d62f53bd5fc99dc9ccd5c60c684661b40ec0f6f7",
	);
});

test("B repeats40 before50 and admits all valid MISS branches with the exact suffix", () => {
	const plan = makeCapacityLadderWorkPlan();
	const branches = enumerateWorkPlanBranches(plan);
	expect(Math.max(...branches.map((branch) => branch.totalSeconds))).toBe(7620);
	const clean = requireDefined(
		branches.find((branch) =>
			branch.steps.every((step) => step.outcome === "PASS"),
		),
	);
	expect(clean.steps.map((step) => step.nodeId)).toEqual([
		"L5000-1",
		"L10000-1",
		"L20000-1",
		"L30000-1",
		"L40000-1",
		"L40000-2",
		"L50000-1",
		"L50000-2",
	]);
	expect(clean.terminal).toBe("COMPLETE");
	const repeatedMiss = requireDefined(
		branches.find(
			(branch) =>
				branch.steps.length === 10 &&
				branch.steps[7]?.outcome === "MISS" &&
				branch.steps.slice(0, 7).every((step) => step.outcome === "PASS") &&
				branch.steps.slice(8).every((step) => step.outcome === "MISS"),
		),
	);
	expect(repeatedMiss.terminal).toBe("COMPLETE");
	for (const step of repeatedMiss.steps.slice(8)) {
		const node = requireDefined(
			plan.nodes.find((entry) => entry.id === step.nodeId),
		);
		expect(node).toMatchObject({
			kind: "companion",
			requestedSessions: 50000,
			activeWorkloadSessions: 40000,
		});
	}
	const after40 = evaluateWorkPlanTimeAdmission({
		plan,
		completed: clean.steps.slice(0, 5),
		setupComplete: true,
		elapsedPaidSeconds: 3240,
		controlUsedSeconds: 0,
		remainingDeadlineSeconds: 3120,
	});
	expect(after40).toMatchObject({
		decision: "FEASIBLE",
		nextNodeId: "L40000-2",
		requiredDeadlineSeconds: 3120,
	});
	const earlyMiss = requireDefined(
		branches.find(
			(branch) =>
				branch.steps[1]?.outcome === "MISS" &&
				branch.steps[2]?.outcome === "PASS" &&
				branch.terminal === "COMPLETE",
		),
	);
	expect(earlyMiss.steps.map((step) => step.nodeId)).toEqual([
		"L5000-1",
		"L10000-1",
		"L5000-2",
		"C10000-1",
		"C10000-2",
	]);
	for (const branch of branches) {
		const invalid = branch.steps.findIndex(
			(step) => step.outcome === "INVALID",
		);
		if (invalid >= 0) {
			expect(invalid).toBe(branch.steps.length - 1);
			expect(branch.terminal).toBe("INCOMPLETE");
		}
	}
});
