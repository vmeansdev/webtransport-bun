import { describe, expect, test } from "bun:test";
import * as budget from "./g6-c32-budget.ts";
import { makeCapacityLadderWorkPlan } from "./g6-c32-capacity-work.ts";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import {
	workPolicyFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";

function requiredFixture<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw Error("missing settlement fixture value");
	return value;
}

function fixture() {
	const policy = workPolicyFixture();
	const base = {
		recordedAt: "2026-09-05T00:00:00.000Z",
		campaignId: policy.campaignId,
		runId: policy.runId,
		budgetPolicySha256: budget.budgetPolicyArtifactSha256(policy),
		accruedLifecycleMicrousd: 0,
		prospectiveCellMicrousd: 0,
		teardownReserveMicrousd: 649800,
		totalAuthorizedMicrousd: policy.spentBeforeMicrousd,
		remainingBudgetMicrousd:
			policy.totalBudgetMicrousd - policy.spentBeforeMicrousd,
		decision: null,
	};
	const price = budget.appendSpendLedgerEntry(null, {
		...base,
		event: "PRICE_VERIFIED",
	});
	const intent = budget.appendSpendLedgerEntry(price, {
		...base,
		event: "CREATE_INTENT",
		rigJournalEventArtifactSha256: "e".repeat(64),
	});
	const admission = budget.appendSpendLedgerEntry(intent, {
		...base,
		event: "CELL_ADMISSION",
		recordedAt: "2026-09-05T00:10:00.000Z",
		accruedLifecycleMicrousd: 649800,
		prospectiveCellMicrousd: 3703860,
		totalAuthorizedMicrousd: policy.spentBeforeMicrousd + 4353660,
		remainingBudgetMicrousd: 7189796,
		decision: "ADMIT",
	});
	return {
		policy,
		entries: [price, intent, admission],
		recordedAt: "2026-09-05T00:12:01.000Z",
		verifiedAbsentAt: "2026-09-05T00:12:00.000Z",
		hourlyMicrousdByRole: policy.maximumRoleHourlyMicrousd,
	};
}

describe("work spend settlement", () => {
	test("late emergency observation preserves the earlier committed absence without authorizing work", () => {
		const input = fixture();
		const prior = input.entries.at(-1);
		if (!prior) throw Error("missing synthetic ledger predecessor");
		const late = budget.appendSpendLedgerEntry(prior, {
			...prior,
			recordedAt: "2026-09-05T00:12:00.100Z",
			event: "EMERGENCY_RECONCILIATION",
			prospectiveCellMicrousd: 0,
			decision: null,
		});
		const entries = [...input.entries, late];
		const seal = budget.sealWorkSpendLedger({ ...input, entries });
		expect(seal.settlement.verifiedAbsentAt).toBe(input.verifiedAbsentAt);
		expect(seal.settlement.paidLifecycleMicrousd).toBe(779760);
		expect(
			budget.validateSpendLedger([...entries, seal], { policy: input.policy })
				.sealedTotalMicrousd,
		).toBe(input.policy.spentBeforeMicrousd + 779760);
		const active = budget.appendSpendLedgerEntry(prior, {
			...late,
			event: "CELL_ADMISSION",
			decision: "ADMIT",
		});
		expect(() =>
			budget.sealWorkSpendLedger({
				...input,
				entries: [...input.entries, active],
			}),
		).toThrow(/absence precedes/);
	});

	test("seals exact paid liability without changing the prefix or authorization", () => {
		expect(typeof budget.sealWorkSpendLedger).toBe("function");
		const input = fixture(),
			before = JSON.stringify(input.entries);
		const seal = budget.sealWorkSpendLedger(input);
		expect(seal.schema).toBe("g6-c32-spend-ledger-entry/2");
		expect(seal.totalAuthorizedMicrousd).toBe(
			requiredFixture(input.entries.at(-1)).totalAuthorizedMicrousd,
		);
		expect(seal.settlement.paidLifecycleMicrousd).toBe(779760);
		expect(
			budget.validateSpendLedger([...input.entries, seal]).sealedTotalMicrousd,
		).toBe(input.policy.spentBeforeMicrousd + 779760);
		expect(JSON.stringify(input.entries)).toBe(before);
	});

	test("publishes zero available plus explicit overrun without granting more authority", () => {
		expect(typeof budget.sealWorkSpendLedger).toBe("function");
		const input = {
			...fixture(),
			verifiedAbsentAt: "2026-09-05T04:00:00.000Z",
			recordedAt: "2026-09-05T04:00:01.000Z",
		};
		const seal = budget.sealWorkSpendLedger(input);
		const actual = 240 * 64980;
		expect(seal.remainingBudgetMicrousd).toBe(0);
		expect(seal.settlement.overrunMicrousd).toBe(
			input.policy.spentBeforeMicrousd +
				actual -
				input.policy.totalBudgetMicrousd,
		);
		expect(seal.settlement.paidLifecycleMicrousd).toBe(actual);
		expect(seal.totalAuthorizedMicrousd).toBe(
			requiredFixture(input.entries.at(-1)).totalAuthorizedMicrousd,
		);
		expect(
			budget.validateSpendLedger([...input.entries, seal]).sealedTotalMicrousd,
		).toBe(input.policy.spentBeforeMicrousd + actual);
		expect(() =>
			budget.appendSpendLedgerEntry(seal, {
				...requiredFixture(input.entries.at(-1)),
				event: "CELL_ADMISSION",
				decision: "ADMIT",
			}),
		).toThrow(/terminal/);
	});

	test("uses verified prices below the ceiling and stops charging at committed absence", () => {
		expect(typeof budget.sealWorkSpendLedger).toBe("function");
		const input = {
			...fixture(),
			hourlyMicrousdByRole: { server: 600000, generator: 600000 },
		};
		const seal = budget.sealWorkSpendLedger(input);
		expect(seal.settlement.paidLifecycleMicrousd).toBe(240000);
		expect(seal.accruedLifecycleMicrousd).toBe(240000);
		expect(
			budget.sealWorkSpendLedger({
				...input,
				recordedAt: "2026-09-06T04:00:00.000Z",
			}).settlement,
		).toEqual(seal.settlement);
	});

	test("uncreated runs settle zero, while uncertain creates require verified prices", () => {
		expect(typeof budget.sealWorkSpendLedger).toBe("function");
		const input = fixture();
		const seal = budget.sealWorkSpendLedger({
			...input,
			entries: input.entries.slice(0, 1),
			hourlyMicrousdByRole: null,
		});
		expect(seal.settlement.paidLifecycleMicrousd).toBe(0);
		expect(seal.settlement.paidTotalMicrousd).toBe(
			input.policy.spentBeforeMicrousd,
		);
		expect(() =>
			budget.sealWorkSpendLedger({ ...input, hourlyMicrousdByRole: null }),
		).toThrow(/price/);
		expect(() =>
			budget.sealWorkSpendLedger({ ...input, verifiedAbsentAt: null }),
		).toThrow(/absence/);
	});

	test("replays an existing settlement byte-identically and refuses changed authority", () => {
		expect(typeof budget.sealWorkSpendLedger).toBe("function");
		const input = fixture(),
			seal = budget.sealWorkSpendLedger(input);
		const replay = {
			...input,
			entries: [...input.entries, seal],
			recordedAt: "2026-09-06T00:00:00.000Z",
		};
		expect(budget.sealWorkSpendLedger(replay)).toEqual(seal);
		for (const change of [
			{ verifiedAbsentAt: "2026-09-05T00:13:00.000Z" },
			{ hourlyMicrousdByRole: { server: 600000, generator: 600000 } },
			{ policy: { ...input.policy, runId: "different-run" } },
		])
			expect(() =>
				budget.sealWorkSpendLedger({ ...replay, ...change }),
			).toThrow();
	});

	test("recomputes money and rejects malformed, downgraded or nonterminal settlement records", () => {
		expect(typeof budget.sealWorkSpendLedger).toBe("function");
		const input = fixture(),
			seal = budget.sealWorkSpendLedger(input);
		for (const change of [
			{ schema: "g6-c32-spend-ledger-entry/3" },
			{ schema: "g6-c32-spend-ledger-entry/1" },
			{
				settlement: { ...seal.settlement, schema: "g6-c32-work-settlement/2" },
			},
			{ settlement: { ...seal.settlement, extra: true } },
			{ settlement: { ...seal.settlement, paidLifecycleMicrousd: 0 } },
			{ settlement: { ...seal.settlement, overrunMicrousd: 1 } },
			{
				settlement: {
					...seal.settlement,
					hourlyMicrousdByRole: { server: 0, generator: 1949400 },
				},
			},
			{
				settlement: {
					...seal.settlement,
					hourlyMicrousdByRole: { server: Infinity, generator: 1949400 },
				},
			},
			{
				settlement: {
					...seal.settlement,
					hourlyMicrousdByRole: { server: 1949401, generator: 1949400 },
				},
			},
			{
				settlement: {
					...seal.settlement,
					policy: { ...input.policy, runId: "other-run" },
				},
			},
			{ remainingBudgetMicrousd: -1 },
			{ remainingBudgetMicrousd: 0 },
			{ totalAuthorizedMicrousd: seal.totalAuthorizedMicrousd + 1 },
			{ totalAuthorizedMicrousd: seal.totalAuthorizedMicrousd - 1 },
			{ prospectiveCellMicrousd: 1 },
			{ teardownReserveMicrousd: 1 },
			{ event: "CELL_ADMISSION", decision: "ADMIT" },
		])
			expect(() =>
				budget.validateSpendLedger([...input.entries, { ...seal, ...change }]),
			).toThrow();
		const forged = {
			...seal,
			accruedLifecycleMicrousd: 1,
			remainingBudgetMicrousd:
				input.policy.totalBudgetMicrousd - input.policy.spentBeforeMicrousd - 1,
			settlement: {
				...seal.settlement,
				paidLifecycleMicrousd: 1,
				paidTotalMicrousd: input.policy.spentBeforeMicrousd + 1,
			},
		};
		expect(() =>
			budget.validateSpendLedger([...input.entries, forged]),
		).toThrow(/recomputed/);
	});

	test("known work policy rejects a stripped legacy seal and policy substitution", () => {
		const input = fixture(),
			seal = budget.sealWorkSpendLedger(input);
		const { settlement: _settlement, ...legacyFields } = seal;
		const downgraded = [
			...input.entries,
			{ ...legacyFields, schema: "g6-c32-spend-ledger-entry/1" },
		];
		expect(() =>
			budget.validateSpendLedger(downgraded, { policy: input.policy }),
		).toThrow(/settlement/);
		expect(() =>
			budget.validateSpendLedger([...input.entries, seal], {
				policy: { ...input.policy, runId: "other-run" },
			}),
		).toThrow(/authority/);
	});

	test("committed absence cannot precede a later active ledger observation", () => {
		const input = fixture();
		expect(() =>
			budget.sealWorkSpendLedger({
				...input,
				verifiedAbsentAt: "2026-09-05T00:09:00.000Z",
			}),
		).toThrow(/absence/);
	});

	test("campaign B chains A's actual settlement, never its allocation or a legacy-shaped work seal", () => {
		expect(typeof budget.sealWorkSpendLedger).toBe("function");
		expect(typeof budget.validatePriorSpendLedger).toBe("function");
		const input = fixture(),
			seal = budget.sealWorkSpendLedger(input),
			prior = [...input.entries, seal];
		const workPlan = makeCapacityLadderWorkPlan();
		const successor = budget.validateBudgetPolicy({
			...input.policy,
			runId: "test-work-b",
			lifecycle: "ladder-only",
			maximumLifecycleSeconds: 5760,
			maximumLifecycleCostMicrousd: 6887880,
			cellMaximumSeconds: { ladder: 480, companion: 480 },
			allowedStages: ["ladder", "companion"],
			workPlan,
			workProfiles: { candidate: workProfileFixture },
			spentBeforeMicrousd: seal.settlement.paidTotalMicrousd,
			priorLedger: {
				path: "actual-a.json",
				sha256: canonicalArtifactSha256(prior),
				sealedSpentMicrousd: seal.settlement.paidTotalMicrousd,
			},
		});
		expect(
			budget.validatePriorSpendLedger(successor, prior).sealedTotalMicrousd,
		).toBe(seal.settlement.paidTotalMicrousd);
		expect(() =>
			budget.validatePriorSpendLedger(
				{
					...successor,
					spentBeforeMicrousd: seal.totalAuthorizedMicrousd,
					priorLedger: {
						...requiredFixture(successor.priorLedger),
						sealedSpentMicrousd: seal.totalAuthorizedMicrousd,
					},
				},
				prior,
			),
		).toThrow(/seal|paid/);
		const { settlement: _settlement, ...legacyFields } = seal;
		const legacy = [
			...input.entries,
			{ ...legacyFields, schema: "g6-c32-spend-ledger-entry/1" },
		];
		expect(() =>
			budget.validatePriorSpendLedger(
				{
					...successor,
					spentBeforeMicrousd: seal.totalAuthorizedMicrousd,
					priorLedger: {
						...requiredFixture(successor.priorLedger),
						sha256: canonicalArtifactSha256(legacy),
						sealedSpentMicrousd: seal.totalAuthorizedMicrousd,
					},
				},
				legacy,
			),
		).toThrow(/settlement/);
	});
});
