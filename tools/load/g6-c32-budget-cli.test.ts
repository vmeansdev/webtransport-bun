import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";

const roots: string[] = [];

afterEach(() => {
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
	});

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
				accruedLifecycleMicrousd: 9_935_001,
				prospectiveCellMicrousd: 65_000,
				teardownReserveMicrousd: 0,
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
	});

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
	});

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
	});
});
