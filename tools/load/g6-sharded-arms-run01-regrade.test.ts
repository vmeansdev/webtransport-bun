/**
 * Regression against run 01's sealed raw cells (g6-sharded-arms-20261007-01,
 * read-only): at this candidate the sealed hotspot cells still grade PASS, the
 * storm cell whose sealed grade was the coverage defect (pre-registration §11)
 * becomes gradeable, and the stamp refuses to disagree with a sealed grade.
 * Skipped when the sealed run is not on this machine (it is not in git).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	budgetPolicyArtifactSha256,
	maximumLifecycleCost,
	validateBudgetPolicy,
	validatePriorSpendLedger,
} from "./g6-c32-budget.ts";
import {
	makeShardedArmsStormWorkPlan,
	makeShardedArmsWorkPlan,
} from "./g6-c32-capacity-work.ts";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import { readWorkCellEvidence } from "./g6-c32-work-execution.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import { readWorkAuthority } from "./g6-capacity-work-authority.ts";
import { stampFromSealedRuns } from "./g6-sharded-arms-evaluate.ts";

const RUN = "g6-sharded-arms-20261007-01";
function findRun(): string | null {
	const fromEnv = process.env.G6_ARMS_RUN01_ROOT;
	if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
	for (let dir = import.meta.dir; dir !== dirname(dir); dir = dirname(dir)) {
		const root = join(dir, ".scratch/bare-metal-campaign/provisioning", RUN);
		if (existsSync(join(root, "RUN_STATUS"))) return root;
	}
	return null;
}
const root = findRun();
const COVERAGE_RED =
	"g6-capacity-diagnostic-coverage: native steady phase does not span the rated window";
const ARGV = {
	shards: 24,
	clientProcesses: 4,
	endpoints: 128,
	fixedSourcePortBase: 20000,
};

describe.skipIf(root === null)(`${RUN} sealed cells at this candidate`, () => {
	const run = root as string;
	const campaign = join(run, `campaign-${RUN}`);
	const sealed = (id: string) =>
		JSON.parse(
			readFileSync(join(campaign, "work", id, "work-grade.json"), "utf8"),
		);
	const regrade = (id: string) => {
		const policy = validateBudgetPolicy(
			JSON.parse(
				readFileSync(
					join(
						run,
						"bound/semantic/inputs/.scratch/bare-metal-campaign/plans",
						`${RUN}-budget.json`,
					),
					"utf8",
				),
			),
		);
		if (policy.schema !== "g6-c32-budget-policy/2") throw Error("policy");
		const node = policy.workPlan.nodes.find((n) => n.id === id);
		if (node === undefined) throw Error(id);
		const profile = policy.workProfiles[node.profile];
		if (profile === undefined) throw Error(node.profile);
		return gradeWorkCell(
			readWorkCellEvidence(
				campaign,
				node,
				profile,
				readWorkAuthority(campaign),
			),
		);
	};

	test("the sealed grades are the ones the readout reported", () => {
		expect(sealed("H5k").outcome).toBe("PASS");
		expect(sealed("H40k").outcome).toBe("PASS");
		expect(sealed("S1-5k")).toEqual({
			schema: "g6-c32-work-grade/1",
			nodeId: "S1-5k",
			outcome: "INVALID",
			reasons: [COVERAGE_RED],
		});
	});

	test.each(["H5k", "H40k"])("%s stays PASS", (id) => {
		expect(regrade(id)).toEqual(sealed(id));
	}, 120_000);

	test("S1-5k is gradeable: the coverage defect is gone", () => {
		const grade = regrade("S1-5k");
		expect(grade.reasons).not.toContain(COVERAGE_RED);
		expect(grade.outcome).toBe("PASS");
	}, 120_000);

	test("the stamp takes the sealed hotspot cells and refuses the superseded-less run", () => {
		// Run 01's S1-5k: the re-grade disagrees with the sealed INVALID.
		expect(() =>
			stampFromSealedRuns(
				["H5k", "H40k", "S1-5k"].map((id) => ({ id, root: run })),
				ARGV,
			),
		).toThrow("disagrees with the sealed work grade INVALID");
		// Hotspot alone leaves the sealed S1-5k unaccounted for.
		expect(() =>
			stampFromSealedRuns(
				["H5k", "H40k"].map((id) => ({ id, root: run })),
				ARGV,
			),
		).toThrow("S1-5k: sealed cell omitted without a superseding run");
	}, 240_000);

	test("the stamp argv is pinned to the registered deployment and sealed profile", () => {
		const cells = [{ id: "H5k", root: run }];
		for (const bad of [
			{ ...ARGV, shards: 2 },
			{ ...ARGV, clientProcesses: 1 },
			{ ...ARGV, endpoints: 4 },
		])
			expect(() => stampFromSealedRuns(cells, bad)).toThrow(
				"stamp argv must be",
			);
		expect(() =>
			stampFromSealedRuns(cells, { ...ARGV, fixedSourcePortBase: null }),
		).toThrow("--fixed-source-port-base is required");
		expect(() =>
			stampFromSealedRuns(cells, { ...ARGV, fixedSourcePortBase: 20001 }),
		).toThrow("differs from the sealed profile");
	});
});

/**
 * The combined gate stamp: run 01's sealed hotspot cells plus a storm-only
 * rerun's cells. The rerun here is synthetic (a copy-on-write clone of run 01's S1-5k evidence
 * under a storm-only policy and authority in a temporary root, with a stub grade),
 * exercising only the evaluator's run-combination rules.
 */
describe.skipIf(root === null)(
	"combined stamp across a storm-only rerun",
	() => {
		const run = root as string;
		const tmp = mkdtempSync(join(tmpdir(), "g6-arms-combine-"));
		afterAll(() => rmSync(tmp, { recursive: true, force: true }));
		const RERUN = "g6-sharded-arms-storm-20261007-99";
		const rerun = join(tmp, RERUN);
		const plans = join(
			rerun,
			"bound/semantic/inputs/.scratch/bare-metal-campaign/plans",
		);
		const campaign = join(rerun, `campaign-${RERUN}`);
		mkdirSync(plans, { recursive: true });
		mkdirSync(join(campaign, "work/S1-5k"), { recursive: true });
		writeFileSync(join(rerun, "RUN_STATUS"), "DESTROYED\n");
		const base = JSON.parse(
			readFileSync(
				join(
					run,
					"bound/semantic/inputs/.scratch/bare-metal-campaign/plans",
					`${RUN}-budget.json`,
				),
				"utf8",
			),
		);
		const active = 4560;
		const policy = validateBudgetPolicy({
			...base,
			runId: RERUN,
			workPlan: makeShardedArmsStormWorkPlan(),
			allowedStages: ["storm"],
			cellMaximumSeconds: { storm: 600 },
			maximumLifecycleSeconds: active,
			maximumLifecycleCostMicrousd: maximumLifecycleCost({
				hourlyMicrousdByRole: base.maximumRoleHourlyMicrousd,
				executionSeconds: active,
				teardownReserveSeconds: base.teardownReserveSeconds,
			}),
		});
		writeFileSync(join(plans, `${RERUN}-budget.json`), JSON.stringify(policy));
		const authority = JSON.parse(
			readFileSync(join(run, `campaign-${RUN}`, "work-authority.json"), "utf8"),
		);
		authority.runId = RERUN;
		authority.policySha256 = budgetPolicyArtifactSha256(policy);
		// A second, fresh pair (pre-registration §11 item 5).
		for (const role of ["server", "generator"]) {
			authority.pair[role].envelope.runId = RERUN;
			authority.pair[role].provider.id += 1_000_000;
		}
		writeFileSync(
			join(campaign, "work-authority.json"),
			JSON.stringify(authority),
		);
		const source = join(run, `campaign-${RUN}`, "work/S1-5k");
		for (const name of readdirSync(source))
			if (name !== "work-grade.json")
				copyFileSync(
					join(source, name),
					join(campaign, "work/S1-5k", name),
					constants.COPYFILE_FICLONE,
				);
		const sums = (dir: string, paths: readonly string[]) =>
			writeFileSync(
				join(dir, "SHA256SUMS"),
				paths
					.map(
						(p) =>
							`${createHash("sha256")
								.update(readFileSync(join(dir, p)))
								.digest("hex")}  ${p}\n`,
					)
					.join(""),
			);
		const reseal = () => {
			sums(join(rerun, "bound"), [
				`semantic/inputs/.scratch/bare-metal-campaign/plans/${RERUN}-budget.json`,
			]);
			sums(campaign, [
				"work-authority.json",
				...readdirSync(join(campaign, "work/S1-5k"))
					.filter((name) => name !== "SHA256SUMS")
					.map((name) => `work/S1-5k/${name}`),
			]);
		};
		const writeGrade = (text: string) => {
			writeFileSync(join(campaign, "work/S1-5k/work-grade.json"), text);
			reseal();
		};
		const pass = {
			schema: "g6-c32-work-grade/1" as const,
			nodeId: "S1-5k",
			outcome: "PASS" as const,
			reasons: [],
		};
		writeGrade(JSON.stringify(pass));
		const grade: typeof gradeWorkCell = (input) =>
			input.runId === RERUN ? pass : gradeWorkCell(input);

		test("the stamp refuses a run whose sealed files differ from SHA256SUMS", () => {
			const path = join(campaign, "work/S1-5k/scan.stdout");
			const original = readFileSync(path);
			writeFileSync(path, Buffer.concat([original, Buffer.from("x")]));
			try {
				expect(() =>
					stampFromSealedRuns(
						[
							{ id: "H5k", root: run },
							{ id: "H40k", root: run },
							{ id: "S1-5k", root: rerun },
						],
						ARGV,
						grade,
					),
				).toThrow("sealed work/S1-5k/scan.stdout differs from SHA256SUMS");
			} finally {
				writeFileSync(path, original);
			}
		}, 240_000);

		test("hotspot from run 01, storm from the rerun, both run ids disclosed", () => {
			const stamp = stampFromSealedRuns(
				[
					{ id: "H5k", root: run },
					{ id: "H40k", root: run },
					{ id: "S1-5k", root: rerun },
				],
				ARGV,
				grade,
			);
			expect(stamp.authoritative).toBe(true);
			expect(stamp.cells.map((c) => [c.cell, c.verdict])).toEqual([
				["H5k", "PASS"],
				["H40k", "PASS"],
				["S1-5k", "PASS"],
			]);
			expect(stamp.arms.hotspot.verdict).toBe("PASS");
			// Only a prefix of the storm gate cells: the arm is not yet complete.
			expect(stamp.arms.storm.verdict).toBe("INCOMPLETE");
			expect(stamp.sources.map((s) => [s.runId, s.planId, s.cells])).toEqual([
				[RUN, "g6-sharded-arms", ["H5k", "H40k"]],
				[RERUN, "g6-sharded-arms-storm", ["S1-5k"]],
			]);
			expect(stamp.sources[0]?.superseded).toEqual([
				{
					cell: "S1-5k",
					sealedOutcome: "INVALID",
					sealedReasons: [COVERAGE_RED],
					supersededBy: RERUN,
				},
			]);
			expect(stamp.notes.join(" ")).toContain(`${RUN} (H5k, H40k); ${RERUN}`);
			// The arms come from different droplet pairs, and the stamp says so.
			const [first, second] = stamp.sources;
			expect(first?.pair).not.toEqual(second?.pair);
			expect(second?.pair).toEqual({
				server: Number(first?.pair.server) + 1_000_000,
				generator: Number(first?.pair.generator) + 1_000_000,
			});
			const note = stamp.notes.find((n) =>
				n.includes("different droplet pairs"),
			);
			expect(note).toContain(
				`hotspot cells H5k, H40k on ${RUN}'s pair (server ${first?.pair.server}, generator ${first?.pair.generator})`,
			);
			expect(note).toContain(`storm cells S1-5k on ${RERUN}'s pair`);
			expect(note).toContain("no clause compares cells across pairs");
		}, 240_000);

		test("a run must supply a prefix of its own plan", () => {
			expect(() =>
				stampFromSealedRuns(
					[
						{ id: "H5k", root: run },
						{ id: "H40k", root: rerun },
					],
					ARGV,
					grade,
				),
			).toThrow("no cell H40k");
		}, 240_000);

		test("a stamp verdict that disagrees with the grade refuses", () => {
			const miss: typeof gradeWorkCell = (input) =>
				input.runId === RERUN
					? { ...pass, outcome: "MISS" }
					: gradeWorkCell(input);
			writeGrade(JSON.stringify({ ...pass, outcome: "MISS" }));
			try {
				expect(() =>
					stampFromSealedRuns(
						[
							{ id: "H5k", root: run },
							{ id: "H40k", root: run },
							{ id: "S1-5k", root: rerun },
						],
						ARGV,
						miss,
					),
				).toThrow("stamp verdict PASS disagrees with the sealed grade MISS");
			} finally {
				writeGrade(JSON.stringify(pass));
			}
		}, 240_000);

		test("a sealed INVALID raw cell forces the stamped cell INVALID", () => {
			const invalid: typeof gradeWorkCell = (input) =>
				input.runId === RERUN
					? { ...pass, outcome: "INVALID", reasons: ["receipt differs"] }
					: gradeWorkCell(input);
			writeGrade(
				JSON.stringify({
					...pass,
					outcome: "INVALID",
					reasons: ["receipt differs"],
				}),
			);
			try {
				const stamp = stampFromSealedRuns(
					[
						{ id: "H5k", root: run },
						{ id: "H40k", root: run },
						{ id: "S1-5k", root: rerun },
					],
					ARGV,
					invalid,
				);
				const cell = stamp.cells[2];
				expect(cell?.verdict).toBe("INVALID");
				expect(cell?.invalidReasons).toContain(
					"V-C (sealed gradeWorkCell): receipt differs",
				);
				expect(stamp.run).toBe("INCOMPLETE");
				expect(stamp.arms.storm.verdict).toBe("INVALID");
			} finally {
				writeGrade(JSON.stringify(pass));
			}
		}, 240_000);
	},
);

describe.skipIf(root === null)(
	"the storm-only rerun chains on run 01's sealed ledger",
	() => {
		const run = root as string;
		const ledger = JSON.parse(
			readFileSync(join(run, "terminal/final-spend-ledger.json"), "utf8"),
		);
		const base = JSON.parse(
			readFileSync(
				join(
					run,
					"bound/semantic/inputs/.scratch/bare-metal-campaign/plans",
					`${RUN}-budget.json`,
				),
				"utf8",
			),
		);
		const SEALED = 119_114_204;
		const policy = (
			workPlan: ReturnType<typeof makeShardedArmsWorkPlan>,
			stages: Record<string, number>,
		) => {
			const active = workPlan.activeMaximumSeconds;
			return validateBudgetPolicy({
				...base,
				runId: "g6-sharded-arms-storm-20261007-02",
				spentBeforeMicrousd: SEALED,
				workPlan,
				allowedStages: Object.keys(stages),
				cellMaximumSeconds: stages,
				maximumLifecycleSeconds: active,
				maximumLifecycleCostMicrousd: maximumLifecycleCost({
					hourlyMicrousdByRole: base.maximumRoleHourlyMicrousd,
					executionSeconds: active,
					teardownReserveSeconds: base.teardownReserveSeconds,
				}),
				priorLedger: {
					path: `.scratch/bare-metal-campaign/provisioning/${RUN}/terminal/final-spend-ledger.json`,
					sha256: canonicalArtifactSha256(ledger),
					sealedSpentMicrousd: SEALED,
				},
			});
		};

		test("run 01's sealed total is 119,114,204 (in-chain spend 2,033,384)", () => {
			const storm = policy(makeShardedArmsStormWorkPlan(), { storm: 600 });
			expect(storm.maximumLifecycleCostMicrousd).toBe(4_996_314);
			expect(validatePriorSpendLedger(storm, ledger).sealedTotalMicrousd).toBe(
				SEALED,
			);
			expect(SEALED - 117_080_820).toBe(2_033_384);
		});

		test("the run-01 chain is admitted for run g6-sharded-arms-storm-20261007-02 only", () => {
			const storm = policy(makeShardedArmsStormWorkPlan(), { storm: 600 });
			// A later storm-plan run must chain on the latest seal, not run 01's.
			expect(() =>
				validatePriorSpendLedger(
					{ ...storm, runId: "g6-sharded-arms-storm-20261008-03" },
					ledger,
				),
			).toThrow("campaign B requires A's versioned paid settlement");
		});

		test("only the storm-only arms plan may chain on a ladder-only seal", () => {
			// The full six-cell arms plan (a second full run) may not.
			const full = policy(makeShardedArmsWorkPlan(), {
				hotspot: 480,
				storm: 600,
			});
			expect(() => validatePriorSpendLedger(full, ledger)).toThrow(
				"campaign B requires A's versioned paid settlement",
			);
		});
	},
);
