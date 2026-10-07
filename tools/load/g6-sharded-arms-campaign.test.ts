import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { maximumLifecycleCost, validateBudgetPolicy } from "./g6-c32-budget.ts";
import {
	makeCapacityLadderWorkPlan,
	makeShardedArmsStormWorkPlan,
	makeShardedArmsWorkPlan,
} from "./g6-c32-capacity-work.ts";
import { workCellArguments } from "./g6-c32-work-cli.ts";
import {
	workGradeFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import { enumerateWorkPlanBranches } from "./g6-c32-work-plan.ts";
import {
	makeShardedArmsWorkProfiles,
	validateWorkProfiles,
	type WorkProfile,
} from "./g6-c32-work-profile.ts";
import { armsRawShape } from "./g6-capacity-raw-cell.ts";

/** The closed 40k deployment: r5 probe-off ladder candidate, 24 x 4. */
const closed40k: WorkProfile = {
	...workProfileFixture,
	datagramPump: "pump",
	detailedProbe: false,
	clientProcesses: 4,
};
const ROLE_PRICE = 1_742_900;

describe("sharded-arms campaign plan (g6-sharded-arms/1)", () => {
	test("cells, order, maxima and continuation edges are registered", () => {
		const plan = makeShardedArmsWorkPlan();
		expect(plan.id).toBe("g6-sharded-arms");
		expect(
			plan.nodes.map((n) => [
				n.id,
				n.kind,
				n.requestedSessions,
				n.maximumSeconds,
			]),
		).toEqual([
			["H5k", "hotspot", 5000, 480],
			["H40k", "hotspot", 40000, 480],
			["S1-5k", "storm", 5000, 600],
			["S2-5k", "storm", 5000, 600],
			["S1-40k", "storm", 40000, 600],
			["S2-40k", "storm", 40000, 600],
		]);
		for (const node of plan.nodes) {
			expect(node.activeWorkloadSessions).toBe(node.requestedSessions);
			expect(node.next.INVALID).toEqual({ terminal: "INCOMPLETE" });
			expect(node.next.PASS).toEqual(node.next.MISS);
		}
		// setup 2100 + control 60 + 2 x 480 + 4 x 600.
		expect(plan.activeMaximumSeconds).toBe(5520);
		expect(plan.teardownReserveSeconds).toBe(600);
		const branches = enumerateWorkPlanBranches(plan);
		expect(Math.max(...branches.map((b) => b.totalSeconds))).toBe(6120);
	});

	test("the paid-run budget check carries ~5.93 M uUSD on one v5 pair", () => {
		const cost = maximumLifecycleCost({
			hourlyMicrousdByRole: { server: ROLE_PRICE, generator: ROLE_PRICE },
			executionSeconds: 5520,
			teardownReserveSeconds: 600,
		});
		expect(cost).toBe(5_925_860);
		const policy = validateBudgetPolicy({
			schema: "g6-c32-budget-policy/2",
			campaignId: "g6-sharded-arms",
			runId: "g6-sharded-arms-1",
			currency: "USD",
			lifecycle: "ladder-only",
			totalBudgetMicrousd: 143_544_166,
			spentBeforeMicrousd: 123_300_000,
			maximumRoleHourlyMicrousd: { server: ROLE_PRICE, generator: ROLE_PRICE },
			maximumLifecycleSeconds: 5520,
			teardownReserveSeconds: 600,
			maximumLifecycleCostMicrousd: 5_925_860,
			cellMaximumSeconds: { hotspot: 480, storm: 600 },
			allowedStages: ["hotspot", "storm"],
			priorLedger: {
				path: "prior.json",
				sha256: "b".repeat(64),
				sealedSpentMicrousd: 123_300_000,
			},
			workPlan: makeShardedArmsWorkPlan(),
			workProfiles: makeShardedArmsWorkProfiles(closed40k),
		});
		expect(policy.maximumLifecycleCostMicrousd).toBe(5_925_860);
	});

	test("storm-only rerun plan: the four storm cells, same maxima and stop rules", () => {
		const full = makeShardedArmsWorkPlan();
		const plan = makeShardedArmsStormWorkPlan();
		expect(plan.id).toBe("g6-sharded-arms-storm");
		expect(plan.entry).toBe("S1-5k");
		expect(plan.nodes.map((n) => n.id)).toEqual([
			"S1-5k",
			"S2-5k",
			"S1-40k",
			"S2-40k",
		]);
		for (const node of plan.nodes) {
			const same = full.nodes.find((n) => n.id === node.id);
			// Identical storm cells (ids, sessions, maxima, edges) to the
			// registered plan; only the hotspot prefix is absent.
			expect(node).toEqual(same as never);
		}
		expect([
			plan.setupMaximumSeconds,
			plan.controlMaximumSeconds,
			plan.teardownReserveSeconds,
			plan.activeMaximumSeconds,
		]).toEqual([2100, 60, 600, 4560]);
		const branches = enumerateWorkPlanBranches(plan);
		expect(Math.max(...branches.map((b) => b.totalSeconds))).toBe(5160);
		// Liability as registered (§9 method): ceil(1,742,900 x 5,160 / 3,600) x 2.
		const cost = maximumLifecycleCost({
			hourlyMicrousdByRole: { server: ROLE_PRICE, generator: ROLE_PRICE },
			executionSeconds: 4560,
			teardownReserveSeconds: 600,
		});
		expect(cost).toBe(4_996_314);
		const policy = validateBudgetPolicy({
			schema: "g6-c32-budget-policy/2",
			campaignId: "g6-sharded-arms",
			runId: "g6-sharded-arms-storm-1",
			currency: "USD",
			lifecycle: "ladder-only",
			totalBudgetMicrousd: 143_544_166,
			spentBeforeMicrousd: 119_114_204,
			maximumRoleHourlyMicrousd: { server: ROLE_PRICE, generator: ROLE_PRICE },
			maximumLifecycleSeconds: 4560,
			teardownReserveSeconds: 600,
			maximumLifecycleCostMicrousd: cost,
			cellMaximumSeconds: { storm: 600 },
			allowedStages: ["storm"],
			priorLedger: {
				path: "prior.json",
				sha256: "b".repeat(64),
				sealedSpentMicrousd: 119_114_204,
			},
			workPlan: plan,
			workProfiles: makeShardedArmsWorkProfiles(closed40k),
		});
		expect(policy.maximumLifecycleCostMicrousd).toBe(4_996_314);
		expect(validateWorkProfiles(plan, { candidate: closed40k })).toEqual({
			candidate: closed40k,
		});
		expect(() =>
			validateWorkProfiles(plan, {
				candidate: { ...closed40k, detailedProbe: true },
			}),
		).toThrow("closed 40k deployment");
	});

	test("only the closed 40k deployment profile is accepted", () => {
		const plan = makeShardedArmsWorkPlan();
		expect(validateWorkProfiles(plan, { candidate: closed40k })).toEqual({
			candidate: closed40k,
		});
		for (const bad of [
			{ ...closed40k, detailedProbe: true },
			{ ...closed40k, clientProcesses: 1 },
			{ ...closed40k, shards: 16 },
			{ ...closed40k, udpSendBatch: 64 as const },
			{ ...closed40k, serverUdpSendBufferBytes: 4_194_304 },
		])
			expect(() => validateWorkProfiles(plan, { candidate: bad })).toThrow(
				"closed 40k deployment",
			);
		// Hotspot / storm kinds never ride another plan.
		const ladder = makeCapacityLadderWorkPlan();
		const smuggled = {
			...ladder,
			nodes: ladder.nodes.map((n, i) =>
				i === 0 ? { ...n, kind: "storm" as const } : n,
			),
		};
		expect(() =>
			validateWorkProfiles(smuggled, {
				candidate: { ...workProfileFixture, shards: 1 },
			}),
		).toThrow("only in a sharded-arms plan");
	});

	test("controller argv adds the registered arm, cohort and raid slot", () => {
		const plan = makeShardedArmsWorkPlan();
		const args = (id: string) =>
			workCellArguments(
				plan.nodes.find((n) => n.id === id) as never,
				closed40k,
			);
		expect(args("H40k").slice(25)).toEqual(["4", "hotspot", "0", "0"]);
		expect(args("S1-40k").slice(25)).toEqual(["4", "storm", "8000", "0"]);
		expect(args("S2-5k").slice(26)).toEqual(["storm", "5000", "0"]);
		// Steady-path cells keep their 26 positional arguments.
		const ladder = makeCapacityLadderWorkPlan("g6-capacity-ladder-b-r5");
		expect(
			workCellArguments(ladder.nodes[0] as never, {
				...closed40k,
				detailedProbe: true,
			}),
		).toHaveLength(26);
	});

	test("raw-cell shape per kind: storm steady 60 s, hotspot 120 s", () => {
		const plan = makeShardedArmsWorkPlan();
		const node = (id: string) => plan.nodes.find((n) => n.id === id) as never;
		expect(armsRawShape(node("H5k"))).toEqual({
			arm: "hotspot",
			cohort: 0,
			raidTargetSlot: 0,
			steadySeconds: 120,
			drainToIdleMs: null,
		});
		expect(armsRawShape(node("S1-5k"))).toEqual({
			arm: "storm",
			cohort: 1000,
			raidTargetSlot: 0,
			steadySeconds: 60,
			drainToIdleMs: 182_000,
		});
		expect(armsRawShape(makeCapacityLadderWorkPlan().nodes[0] as never)).toBe(
			null,
		);
	});

	test("the controller passes the arm env to the scan only for arms cells", () => {
		const source = readFileSync(
			new URL("./g6-c32-rca-controller.sh", import.meta.url),
			"utf8",
		);
		expect(source).toContain(
			`local arm=\${27:-steady} storm_cohort=\${28:-0} raid_target_slot=\${29:-0}`,
		);
		expect(source).toContain(
			'hotspot) arms_env="SCAN_ARM=hotspot SCAN_RAID_TARGET_SLOT=$raid_target_slot" ;;',
		);
		expect(source).toContain(
			'storm) arms_env="SCAN_ARM=storm SCAN_STORM_COHORT=$storm_cohort" ;;',
		);
		expect(source).toContain(
			`SCAN_CLIENT_PROCESSES=$client_processes \${arms_env:+$arms_env }G6_BPF_READY_RECEIPT=`,
		);
	});

	test("the raw cell binds the scan env to the registered arm, both ways", () => {
		const plan = makeShardedArmsWorkPlan();
		const node = plan.nodes.find((n) => n.id === "S1-5k");
		// An arms node whose scan ran without the arm env is INVALID.
		const missing = gradeWorkCell(
			workGradeFixture({ node: node as never, profile: closed40k }),
		);
		expect(missing.outcome).toBe("INVALID");
		expect(missing.reasons.join(" ")).toContain("SCAN_ARM");
		// A steady-path cell that carries an arm env is INVALID too.
		const input = workGradeFixture();
		const operation = input.operation as {
			action: { args: string[] };
		};
		operation.action.args[3] = `SCAN_ARM=storm ${operation.action.args[3]}`;
		const smuggled = gradeWorkCell(input);
		expect(smuggled.outcome).toBe("INVALID");
		expect(smuggled.reasons.join(" ")).toContain("unregistered workload");
	});
});
