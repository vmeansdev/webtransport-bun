import { describe, expect, test } from "bun:test";
import {
	type BudgetPolicy,
	evaluateAdmission,
	G6_C32_BUDGET_POLICY_SCHEMA,
	maximumLifecycleCost,
	validateBudgetPolicy,
} from "./g6-c32-budget.ts";

const validRcaPolicy = (): BudgetPolicy => ({
	schema: G6_C32_BUDGET_POLICY_SCHEMA,
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
});

describe("G6 c-32 budget policy", () => {
	test("rejects a policy whose declared maximum understates rounded role cost", () => {
		expect(() =>
			validateBudgetPolicy({
				...validRcaPolicy(),
				maximumLifecycleCostMicrousd: 4_552_099,
			}),
		).toThrow("maximumLifecycleCostMicrousd");
	});

	test("rejects malformed or ambiguous authority fields", () => {
		const cases: Array<[string, unknown]> = [
			["policy keys", { ...validRcaPolicy(), extra: true }],
			["schema", { ...validRcaPolicy(), schema: "g6-c32-budget-policy/0" }],
			["currency", { ...validRcaPolicy(), currency: "EUR" }],
			["campaignId", { ...validRcaPolicy(), campaignId: "../campaign" }],
			["runId", { ...validRcaPolicy(), runId: "UPPERCASE" }],
			["lifecycle", { ...validRcaPolicy(), lifecycle: "full-campaign" }],
			[
				"totalBudgetMicrousd",
				{ ...validRcaPolicy(), totalBudgetMicrousd: 10_000_000.5 },
			],
			[
				"maximumRoleHourlyMicrousd keys",
				{
					...validRcaPolicy(),
					maximumRoleHourlyMicrousd: {
						server: 1_300_600,
						generator: 1_300_600,
						third: 1,
					},
				},
			],
			[
				"allowedStages must be unique",
				{
					...validRcaPolicy(),
					allowedStages: [
						"probe",
						"probe",
						"matrix",
						"interaction",
						"transfer",
					],
				},
			],
			[
				"cellMaximumSeconds keys",
				{
					...validRcaPolicy(),
					cellMaximumSeconds: {
						...validRcaPolicy().cellMaximumSeconds,
						extra: 1,
					},
				},
			],
		];

		for (const [message, value] of cases) {
			expect(() => validateBudgetPolicy(value), message).toThrow(message);
		}
	});

	test("binds prior spend only for a post-fix lifecycle that still fits", () => {
		expect(() =>
			validateBudgetPolicy({
				...validRcaPolicy(),
				spentBeforeMicrousd: 1,
			}),
		).toThrow("rca-only");

		expect(() =>
			validateBudgetPolicy({
				...validRcaPolicy(),
				lifecycle: "post-fix-only",
				spentBeforeMicrousd: 4_552_100,
				maximumLifecycleSeconds: 4_500,
				maximumLifecycleCostMicrousd: 3_685_034,
				priorLedger: null,
			}),
		).toThrow("priorLedger");

		const postFix = validateBudgetPolicy({
			...validRcaPolicy(),
			lifecycle: "post-fix-only",
			spentBeforeMicrousd: 4_552_100,
			maximumLifecycleSeconds: 4_500,
			maximumLifecycleCostMicrousd: 3_685_034,
			priorLedger: {
				path: ".scratch/bare-metal-campaign/rca/spend-ledger.json",
				sha256: "a".repeat(64),
				sealedSpentMicrousd: 4_552_100,
			},
		});
		expect(postFix.lifecycle).toBe("post-fix-only");

		expect(() =>
			validateBudgetPolicy({
				...postFix,
				totalBudgetMicrousd: 8_237_133,
			}),
		).toThrow("exceeds total budget");
	});

	test("rounds each role upward using the lifecycle minute ceiling", () => {
		expect(
			maximumLifecycleCost({
				hourlyMicrousdByRole: { server: 1_300_600, generator: 1_300_600 },
				executionSeconds: 5_700,
				teardownReserveSeconds: 600,
			}),
		).toBe(4_552_100);
		expect(
			maximumLifecycleCost({
				hourlyMicrousdByRole: { server: 1_300_600, generator: 1_300_600 },
				executionSeconds: 4_500,
				teardownReserveSeconds: 600,
			}),
		).toBe(3_685_034);
		expect(
			maximumLifecycleCost({
				hourlyMicrousdByRole: { server: 1, generator: 1 },
				executionSeconds: 1,
				teardownReserveSeconds: 1,
			}),
		).toBe(2);
		expect(() =>
			maximumLifecycleCost({
				hourlyMicrousdByRole: {
					server: Number.MAX_SAFE_INTEGER,
					generator: Number.MAX_SAFE_INTEGER,
				},
				executionSeconds: Number.MAX_SAFE_INTEGER,
				teardownReserveSeconds: Number.MAX_SAFE_INTEGER,
			}),
		).toThrow("Number.MAX_SAFE_INTEGER");
	});

	test("admits only an authorized cell whose worst case preserves teardown", () => {
		const policy = validRcaPolicy();
		const exactlyAtCeiling = evaluateAdmission({
			policy,
			stage: "probe",
			accruedLifecycleMicrousd: 9_935_000,
			prospectiveCellMicrousd: 65_000,
			teardownReserveMicrousd: 0,
			remainingDeadlineSeconds: 780,
		});
		expect(exactlyAtCeiling.decision).toBe("ADMIT");
		expect(exactlyAtCeiling.remainingAfterMicrousd).toBe(0);

		expect(
			evaluateAdmission({
				policy,
				stage: "probe",
				accruedLifecycleMicrousd: 9_935_001,
				prospectiveCellMicrousd: 65_000,
				teardownReserveMicrousd: 0,
				remainingDeadlineSeconds: 780,
			}).decision,
		).toBe("REFUSED_BUDGET");
		expect(
			evaluateAdmission({
				policy,
				stage: "ladder",
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 1,
				teardownReserveMicrousd: 1,
				remainingDeadlineSeconds: 780,
			}).decision,
		).toBe("REFUSED_SCOPE");
		expect(
			evaluateAdmission({
				policy,
				stage: "probe",
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 1,
				teardownReserveMicrousd: 1,
				remainingDeadlineSeconds: 779,
			}).decision,
		).toBe("REFUSED_DEADLINE");
	});
});
