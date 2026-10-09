import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	sealWorkSpendLedger,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import { runBudgetCli } from "./g6-c32-budget-cli.ts";
import { makeCapacityLadderWorkPlan } from "./g6-c32-capacity-work.ts";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import { startWorkCell } from "./g6-c32-work-execution.ts";
import {
	cleanupWorkFixtures,
	executionFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";

const roots: string[] = [];

afterEach(() => {
	cleanupWorkFixtures();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-budget-cli-"));
	roots.push(root);
	return root;
}

function validPolicy() {
	return {
		schema: "g6-c32-budget-policy/1",
		campaignId: "g6-c32-rca-fix-01",
		runId: "g6-c32-rca-fix-01-d22c3fd4",
		currency: "USD",
		lifecycle: "rca-only",
		totalBudgetMicrousd: 10_000_000,
		spentBeforeMicrousd: 0,
		maximumRoleHourlyMicrousd: {
			server: 1_300_600,
			generator: 1_300_600,
		},
		maximumLifecycleSeconds: 5_700,
		teardownReserveSeconds: 600,
		maximumLifecycleCostMicrousd: 4_552_100,
		cellMaximumSeconds: {
			probe: 180,
			matrix: 180,
			interaction: 180,
			transfer: 180,
		},
		allowedStages: ["probe", "matrix", "interaction", "transfer"],
		priorLedger: null,
	};
}

describe("g6-c32-budget CLI", () => {
	test("validates B's exact prior paid settlement without writing either authority", () => {
		const fixture = executionFixture();
		const seal = sealWorkSpendLedger({
			policy: fixture.policy,
			entries: fixture.ledger,
			recordedAt: "2026-09-05T00:12:01.000Z",
			verifiedAbsentAt: "2026-09-05T00:12:00.000Z",
			hourlyMicrousdByRole: fixture.policy.maximumRoleHourlyMicrousd,
		});
		const ledger = [...fixture.ledger, seal];
		const policy = validateBudgetPolicy({
			...fixture.policy,
			runId: "test-work-b",
			lifecycle: "ladder-only",
			maximumLifecycleSeconds: 7020,
			maximumLifecycleCostMicrousd: 8252460,
			cellMaximumSeconds: { ladder: 480, companion: 480 },
			allowedStages: ["ladder", "companion"],
			workPlan: makeCapacityLadderWorkPlan(),
			workProfiles: { candidate: workProfileFixture },
			spentBeforeMicrousd: seal.settlement.paidTotalMicrousd,
			priorLedger: {
				path: "prior-a.json",
				sha256: canonicalArtifactSha256(ledger),
				sealedSpentMicrousd: seal.settlement.paidTotalMicrousd,
			},
		});
		const policyPath = join(fixture.root, "successor-policy.json"),
			ledgerPath = join(fixture.root, "prior-a.json");
		const policyBytes = `${JSON.stringify(policy)}\n`,
			ledgerBytes = `${JSON.stringify(ledger)}\n`;
		writeFileSync(policyPath, policyBytes);
		writeFileSync(ledgerPath, ledgerBytes);
		const run = () =>
			Bun.spawnSync({
				cmd: [
					process.execPath,
					join(import.meta.dir, "g6-c32-budget-cli.ts"),
					"validate-prior",
					"--policy",
					policyPath,
					"--ledger",
					ledgerPath,
				],
				stdout: "pipe",
				stderr: "pipe",
				timeout: 5000,
			});
		const result = run();
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(JSON.parse(result.stdout.toString())).toEqual({
			schema: "g6-c32-prior-spend-validation/1",
			status: "VALID",
			campaignId: policy.campaignId,
			runId: policy.runId,
			sealedTotalMicrousd: seal.settlement.paidTotalMicrousd,
		});
		expect(readFileSync(policyPath, "utf8")).toBe(policyBytes);
		expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBytes);
		writeFileSync(
			ledgerPath,
			JSON.stringify([
				...fixture.ledger,
				{ ...seal, recordedAt: "2026-09-05T00:12:02.000Z" },
			]),
		);
		expect(run().exitCode).toBe(1);
		expect(readFileSync(policyPath, "utf8")).toBe(policyBytes);
	}, 15000);

	test("policy/2 derives whole DAG liability from earliest intent and verified progress", async () => {
		const fixture = executionFixture(),
			now = "2026-09-05T00:02:10.000Z";
		startWorkCell({ ...fixture, nodeId: "A0-1", now, monotonicNs: "1" });
		const policyPath = join(fixture.root, "policy.json"),
			ledgerPath = join(fixture.root, "ledger.json"),
			requestPath = join(fixture.root, "request.json"),
			out = join(fixture.root, "admission.json");
		writeFileSync(policyPath, JSON.stringify(fixture.policy));
		writeFileSync(ledgerPath, JSON.stringify(fixture.ledger));
		writeFileSync(
			requestPath,
			JSON.stringify({
				schema: "g6-c32-work-admission-request/1",
				evidenceRoot: fixture.root,
				nodeId: "A0-1",
			}),
		);
		const args = [
			"admit-cell",
			"--policy",
			policyPath,
			"--ledger",
			ledgerPath,
			"--request",
			requestPath,
			"--out",
			out,
		];
		expect(await runBudgetCli(args, () => now)).toBe(0);
		expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
			schema: "g6-c32-cell-admission/2",
			nextNodeId: "A0-1",
			decision: "ADMIT",
			elapsedLifecycleSeconds: 130,
			requiredDeadlineSeconds: 4010,
		});
		for (const injected of [
			{ completed: [{ nodeId: "A0-1", outcome: "PASS" }] },
			{ accruedLifecycleMicrousd: 0 },
			{ elapsedLifecycleSeconds: 0 },
		]) {
			writeFileSync(
				requestPath,
				JSON.stringify({
					schema: "g6-c32-work-admission-request/1",
					evidenceRoot: fixture.root,
					nodeId: "A0-1",
					...injected,
				}),
			);
			await expect(runBudgetCli(args, () => now)).rejects.toThrow();
		}
	});
	test("validates an exact policy with machine-only output", () => {
		const root = tempRoot();
		const policyPath = join(root, "policy.json");
		writeFileSync(policyPath, JSON.stringify(validPolicy()));
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				join(import.meta.dir, "g6-c32-budget-cli.ts"),
				"validate-policy",
				"--policy",
				policyPath,
			],
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(JSON.parse(result.stdout.toString())).toEqual({
			schema: "g6-c32-budget-policy-validation/1",
			status: "VALID",
			campaignId: "g6-c32-rca-fix-01",
			runId: "g6-c32-rca-fix-01-d22c3fd4",
			lifecycle: "rca-only",
		});
	}, 15_000);

	test("atomically persists a budget refusal before exiting nonzero", () => {
		const root = tempRoot();
		const policyPath = join(root, "policy.json");
		const requestPath = join(root, "request.json");
		const ledgerPath = join(root, "ledger.json");
		const outputPath = join(root, "admission.json");
		writeFileSync(policyPath, JSON.stringify(validPolicy()));
		writeFileSync(
			requestPath,
			JSON.stringify({
				recordedAt: "2026-08-31T10:01:00.000Z",
				stage: "probe",
				accruedLifecycleMicrousd: 3_988_509,
				prospectiveCellMicrousd: 130_060,
				teardownReserveMicrousd: 433_532,
				elapsedLifecycleSeconds: 5_520,
				remainingDeadlineSeconds: 780,
			}),
		);
		const policy = validateBudgetPolicy(validPolicy());
		const price = appendSpendLedgerEntry(null, {
			recordedAt: "2026-08-31T10:00:00.000Z",
			campaignId: validPolicy().campaignId,
			runId: validPolicy().runId,
			budgetPolicySha256: budgetPolicyArtifactSha256(policy),
			event: "PRICE_VERIFIED",
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 216_768,
			totalAuthorizedMicrousd: 0,
			remainingBudgetMicrousd: 10_000_000,
			decision: null,
		});
		writeFileSync(ledgerPath, JSON.stringify([price]));
		writeFileSync(outputPath, "sentinel");

		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				join(import.meta.dir, "g6-c32-budget-cli.ts"),
				"admit-cell",
				"--policy",
				policyPath,
				"--request",
				requestPath,
				"--ledger",
				ledgerPath,
				"--out",
				outputPath,
			],
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).toBe(3);
		expect(result.stdout.toString()).toBe("");
		const receipt = JSON.parse(readFileSync(outputPath, "utf8"));
		expect(receipt.decision).toBe("REFUSED_BUDGET");
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		expect(ledger).toHaveLength(2);
		expect(ledger[1].decision).toBe("REFUSED_BUDGET");
	}, 15_000);

	test("appends provider intents and observations before sealing", () => {
		const root = tempRoot();
		const ledgerPath = join(root, "ledger.json");
		const entryPath = join(root, "entry.json");
		const outputPath = join(root, "entry-receipt.json");
		const policy = validateBudgetPolicy(validPolicy());
		const policySha256 = budgetPolicyArtifactSha256(policy);
		const price = appendSpendLedgerEntry(null, {
			recordedAt: "2026-08-31T10:00:00.000Z",
			campaignId: policy.campaignId,
			runId: policy.runId,
			budgetPolicySha256: policySha256,
			event: "PRICE_VERIFIED",
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 216_768,
			totalAuthorizedMicrousd: 0,
			remainingBudgetMicrousd: 10_000_000,
			decision: null,
		});
		writeFileSync(ledgerPath, JSON.stringify([price]));

		const runAppend = (mode: string, event: string, recordedAt: string) => {
			writeFileSync(
				entryPath,
				JSON.stringify({
					recordedAt,
					campaignId: policy.campaignId,
					runId: policy.runId,
					budgetPolicySha256: policySha256,
					event,
					rigJournalEventArtifactSha256:
						event === "SEAL" ? null : "d".repeat(64),
					accruedLifecycleMicrousd: 43_354,
					prospectiveCellMicrousd: 0,
					teardownReserveMicrousd: 216_768,
					totalAuthorizedMicrousd: 43_354,
					remainingBudgetMicrousd: 9_739_878,
					decision: null,
				}),
			);
			return Bun.spawnSync({
				cmd: [
					process.execPath,
					join(import.meta.dir, "g6-c32-budget-cli.ts"),
					mode,
					"--ledger",
					ledgerPath,
					"--entry",
					entryPath,
					"--out",
					outputPath,
				],
				stdout: "pipe",
				stderr: "pipe",
			});
		};

		expect(
			runAppend("append-intent", "CREATE_INTENT", "2026-08-31T10:01:00.000Z")
				.exitCode,
		).toBe(0);
		expect(
			runAppend(
				"append-observation",
				"CREATE_OBSERVED",
				"2026-08-31T10:02:00.000Z",
			).exitCode,
		).toBe(0);
		expect(runAppend("seal", "SEAL", "2026-08-31T10:03:00.000Z").exitCode).toBe(
			0,
		);
		const validated = validateSpendLedger(
			JSON.parse(readFileSync(ledgerPath, "utf8")),
		);
		expect(validated.entries.map((entry) => entry.event)).toEqual([
			"PRICE_VERIFIED",
			"CREATE_INTENT",
			"CREATE_OBSERVED",
			"SEAL",
		]);
	}, 15_000);

	test("leaves ledger and receipt unchanged when an append is invalid", () => {
		const root = tempRoot();
		const ledgerPath = join(root, "ledger.json");
		const entryPath = join(root, "entry.json");
		const outputPath = join(root, "entry-receipt.json");
		const policy = validateBudgetPolicy(validPolicy());
		const price = appendSpendLedgerEntry(null, {
			recordedAt: "2026-08-31T10:00:00.000Z",
			campaignId: policy.campaignId,
			runId: policy.runId,
			budgetPolicySha256: budgetPolicyArtifactSha256(policy),
			event: "PRICE_VERIFIED",
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 216_768,
			totalAuthorizedMicrousd: 0,
			remainingBudgetMicrousd: 10_000_000,
			decision: null,
		});
		const originalLedger = `${JSON.stringify([price])}\n`;
		writeFileSync(ledgerPath, originalLedger);
		writeFileSync(outputPath, "sentinel\n");
		writeFileSync(
			entryPath,
			JSON.stringify({
				...price,
				sequence: 99,
				previousEntrySha256: null,
				event: "CREATE_OBSERVED",
			}),
		);

		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				join(import.meta.dir, "g6-c32-budget-cli.ts"),
				"append-intent",
				"--ledger",
				ledgerPath,
				"--entry",
				entryPath,
				"--out",
				outputPath,
			],
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			"append-intent does not permit event CREATE_OBSERVED",
		);
		expect(readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
		expect(readFileSync(outputPath, "utf8")).toBe("sentinel\n");
	}, 15_000);
});
