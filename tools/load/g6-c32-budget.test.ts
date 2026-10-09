import { describe, expect, test } from "bun:test";
import {
	appendSpendLedgerEntry,
	type BudgetPolicy,
	budgetPolicyArtifactSha256,
	evaluateAdmission,
	evaluateWorkAdmission,
	G6_C32_BUDGET_POLICY_SCHEMA,
	lifecycleCostAtTeardown,
	maximumLifecycleCost,
	observedLifecycleCost,
	paidLifecycleCost,
	spendLedgerEntryArtifactSha256,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import { makeAttributionWorkPlan } from "./g6-c32-capacity-work.ts";
import { makeAttributionWorkProfiles } from "./g6-c32-work-profile.ts";

function requiredFixture<T>(value: T | undefined): T {
	if (value === undefined) throw Error("missing budget fixture value");
	return value;
}

test("new teardown accounting ends at committed absence, not delayed receipt publication", () => {
	const input = {
		schema: "g6-c32-budget-policy/2" as const,
		entries: [
			{
				event: "CREATE_INTENT" as const,
				recordedAt: "2026-09-05T00:00:00.000Z",
			},
		],
		verifiedAbsentAt: "2026-09-05T00:10:00.000Z",
		recordedAt: "2026-09-05T00:10:01.000Z",
		hourlyMicrousdByRole: { server: 1949400, generator: 1949400 },
	};
	expect(lifecycleCostAtTeardown(input)).toBe(649800);
	expect(
		lifecycleCostAtTeardown({
			...input,
			recordedAt: "2026-09-06T00:10:01.000Z",
		}),
	).toBe(649800);
	expect(() =>
		lifecycleCostAtTeardown({ ...input, verifiedAbsentAt: null }),
	).toThrow(/absence/);
	expect(() =>
		lifecycleCostAtTeardown({ ...input, hourlyMicrousdByRole: null }),
	).toThrow(/price/);
	expect(() =>
		lifecycleCostAtTeardown({
			...input,
			recordedAt: "2026-09-05T00:09:00.000Z",
		}),
	).toThrow(/before/);
	expect(
		lifecycleCostAtTeardown({
			...input,
			entries: [],
			hourlyMicrousdByRole: null,
		}),
	).toBe(0);
	const legacy = {
		...input,
		schema: "g6-c32-budget-policy/1" as const,
		entries: [
			{
				event: "CREATE_OBSERVED" as const,
				recordedAt: "2026-09-05T00:00:00.000Z",
			},
		],
	};
	expect(lifecycleCostAtTeardown(legacy)).toBe(714780);
});

function workPolicy() {
	const workPlan = makeAttributionWorkPlan();
	const workProfiles = makeAttributionWorkProfiles({
		shards: 24,
		endpoints: 128,
		connectConcurrency: 50,
		connectRatePerSec: 250,
		fixedSourcePortBase: 20000,
		receiveBufferBytes: 26214400,
		gradeMode: "rca-only",
		ackReflector: "native",
		serverWorkers: 3,
		serverGro: "off",
		serverRecvRuntime: "shared",
		ackCadence: "default",
		pacerPps: 0,
		udpSendBatch: 0,
		serverUdpSendBufferBytes: 0,
		serverUdpSendEagainMode: "wait",
		reflectRingBypass: "off",
		detailedProbe: true,
		nativeDiagnostics: true,
	});
	return {
		...validRcaPolicy(),
		schema: "g6-c32-budget-policy/2",
		lifecycle: "attribution-only",
		totalBudgetMicrousd: 103544166,
		spentBeforeMicrousd: 91350910,
		maximumRoleHourlyMicrousd: { server: 1949400, generator: 1949400 },
		maximumLifecycleSeconds: 5520,
		teardownReserveSeconds: 600,
		maximumLifecycleCostMicrousd: 6627960,
		cellMaximumSeconds: { attribution: 420 },
		allowedStages: ["attribution"],
		priorLedger: {
			path: "prior.json",
			sha256: "b".repeat(64),
			sealedSpentMicrousd: 91350910,
		},
		workPlan,
		workProfiles,
	};
}

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
	test("v2 binds the executable work plan and rejects drift or legacy admission", () => {
		const policy = validateBudgetPolicy(workPolicy());
		expect(policy.schema).toBe("g6-c32-budget-policy/2");
		for (const change of [
			{ workPlan: undefined },
			{ workProfiles: undefined },
			{ workProfiles: {} },
			{ allowedStages: ["ladder"], cellMaximumSeconds: { ladder: 420 } },
			{ cellMaximumSeconds: { attribution: 419 } },
			{ lifecycle: "ladder-only" },
			{ maximumLifecycleSeconds: 4200, maximumLifecycleCostMicrousd: 5198400 },
		])
			expect(() =>
				validateBudgetPolicy({ ...workPolicy(), ...change }),
			).toThrow();
		expect(() =>
			evaluateAdmission({
				policy,
				stage: "attribution",
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 0,
				teardownReserveMicrousd: 0,
				elapsedLifecycleSeconds: 0,
				remainingDeadlineSeconds: 6120,
			}),
		).toThrow(/work-plan/);
	});
	test("v2 reserves all still possible cells and rounds cumulative cost only once", () => {
		const policy = validateBudgetPolicy(workPolicy());
		const input = {
			policy,
			stage: "attribution",
			completed: [],
			setupComplete: false,
			elapsedPaidSeconds: 0,
			controlUsedSeconds: 0,
			remainingDeadlineSeconds: 6120,
		};
		const initial = evaluateWorkAdmission(input);
		expect(initial).toMatchObject({
			decision: "ADMIT",
			nextNodeId: "A0-1",
			requiredDeadlineSeconds: 6120,
			totalAfterMicrousd: 97978870,
		});
		const partial = evaluateWorkAdmission({
			...input,
			elapsedPaidSeconds: 61,
			remainingDeadlineSeconds: 6059,
		});
		expect(partial.totalAfterMicrousd).toBe(initial.totalAfterMicrousd);
		expect(partial.accruedLifecycleMicrousd).toBe(129960);
		expect(
			evaluateWorkAdmission({ ...input, remainingDeadlineSeconds: 6119 })
				.decision,
		).toBe("REFUSED_DEADLINE");
		expect(evaluateWorkAdmission({ ...input, stage: "ladder" }).decision).toBe(
			"REFUSED_SCOPE",
		);
		const after = evaluateWorkAdmission({
			...input,
			completed: [{ nodeId: "A0-1", outcome: "MISS" }],
			setupComplete: true,
			elapsedPaidSeconds: 1260,
			remainingDeadlineSeconds: 3600,
		});
		expect(after).toMatchObject({
			decision: "ADMIT",
			nextNodeId: "A1-1",
			requiredDeadlineSeconds: 3600,
		});
		expect(() =>
			evaluateWorkAdmission({
				...input,
				completed: [{ nodeId: "A1-1", outcome: "PASS" }],
				setupComplete: true,
			}),
		).toThrow(/sequence/);
		const stop = evaluateWorkAdmission({
			...input,
			completed: [{ nodeId: "A0-1", outcome: "INVALID" }],
			setupComplete: true,
			elapsedPaidSeconds: 1260,
			remainingDeadlineSeconds: 3600,
		});
		expect(stop).toMatchObject({
			decision: "TEARDOWN",
			terminal: "INCOMPLETE",
			nextNodeId: null,
		});
	});
	test("new paid clock starts at earliest CREATE_INTENT and rounds through teardown", () => {
		const price = { server: 1_949_400, generator: 1_949_400 };
		const entries = [
			{
				event: "CREATE_INTENT" as const,
				recordedAt: "2026-09-05T00:00:00.001Z",
			},
			{
				event: "CREATE_INTENT" as const,
				recordedAt: "2026-09-05T00:00:01.000Z",
			},
			{
				event: "CREATE_OBSERVED" as const,
				recordedAt: "2026-09-05T00:00:30.000Z",
			},
		];
		expect(
			paidLifecycleCost({
				entries,
				sealedAt: "2026-09-05T00:01:00.002Z",
				hourlyMicrousdByRole: price,
			}),
		).toBe(129_960);
		expect(
			paidLifecycleCost({
				entries: entries.slice(0, 1),
				sealedAt: "2026-09-05T00:00:30.000Z",
				hourlyMicrousdByRole: price,
			}),
		).toBe(64_980);
		expect(
			paidLifecycleCost({
				entries: [],
				sealedAt: "2026-09-05T00:00:30.000Z",
				hourlyMicrousdByRole: price,
			}),
		).toBe(0);
		for (const invalid of [
			{ entries: entries.slice(2), sealedAt: "2026-09-05T00:01:00.002Z" },
			{ entries, sealedAt: "2026-09-05T00:00:00.000Z" },
			{
				entries: [{ ...requiredFixture(entries[0]), recordedAt: "invalid" }],
				sealedAt: "2026-09-05T00:01:00.002Z",
			},
		])
			expect(() =>
				paidLifecycleCost({ ...invalid, hourlyMicrousdByRole: price }),
			).toThrow();
	});
	test("charges an observed pre-admission lifecycle through teardown", () => {
		const policy = validRcaPolicy();
		const first = appendSpendLedgerEntry(null, {
			recordedAt: "2026-08-31T17:34:15.048Z",
			campaignId: policy.campaignId,
			runId: policy.runId,
			budgetPolicySha256: "a".repeat(64),
			event: "CREATE_OBSERVED",
			rigJournalEventArtifactSha256: "b".repeat(64),
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 0,
			totalAuthorizedMicrousd: 0,
			remainingBudgetMicrousd: policy.totalBudgetMicrousd,
			decision: null,
		});
		expect(
			observedLifecycleCost({
				entries: [first],
				sealedAt: "2026-08-31T17:41:05.879Z",
				hourlyMicrousdByRole: {
					server: 1_300_600,
					generator: 1_300_600,
				},
			}),
		).toBe(303_474);
	}, 15_000);
	test("rejects a policy whose declared maximum understates rounded role cost", () => {
		expect(() =>
			validateBudgetPolicy({
				...validRcaPolicy(),
				maximumLifecycleCostMicrousd: 4_552_099,
			}),
		).toThrow("maximumLifecycleCostMicrousd");
	}, 15_000);

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
	}, 15_000);

	test("binds prior spend for retries and post-fix lifecycles that still fit", () => {
		const retriedRca = validateBudgetPolicy({
			...validRcaPolicy(),
			spentBeforeMicrousd: 1,
			priorLedger: {
				path: ".scratch/bare-metal-campaign/rca/spend-ledger.json",
				sha256: "b".repeat(64),
				sealedSpentMicrousd: 1,
			},
		});
		expect(retriedRca.lifecycle).toBe("rca-only");

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

		const ladderOnly = validateBudgetPolicy({
			...validRcaPolicy(),
			lifecycle: "ladder-only",
			allowedStages: ["ladder", "companion"],
			cellMaximumSeconds: { ladder: 480, companion: 480 },
			spentBeforeMicrousd: 4_552_100,
			maximumLifecycleSeconds: 4_500,
			maximumLifecycleCostMicrousd: 3_685_034,
			priorLedger: {
				path: ".scratch/bare-metal-campaign/rca/spend-ledger.json",
				sha256: "a".repeat(64),
				sealedSpentMicrousd: 4_552_100,
			},
		});
		expect(ladderOnly.lifecycle).toBe("ladder-only");

		expect(() =>
			validateBudgetPolicy({
				...validRcaPolicy(),
				lifecycle: "ladder-only",
				allowedStages: ["ladder", "companion"],
				cellMaximumSeconds: { ladder: 480, companion: 480 },
			}),
		).toThrow("priorLedger");

		expect(() =>
			validateBudgetPolicy({
				...postFix,
				totalBudgetMicrousd: 8_237_133,
			}),
		).toThrow("exceeds total budget");
	}, 15_000);

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
				hourlyMicrousdByRole: { server: 1_300_600, generator: 1_300_600 },
				executionSeconds: 0,
				teardownReserveSeconds: 600,
			}),
		).toBe(433_534);
		expect(
			maximumLifecycleCost({
				hourlyMicrousdByRole: { server: 1_300_600, generator: 1_300_600 },
				executionSeconds: 180,
				teardownReserveSeconds: 0,
			}),
		).toBe(130_060);
		expect(
			maximumLifecycleCost({
				hourlyMicrousdByRole: { server: 1, generator: 1 },
				executionSeconds: 0,
				teardownReserveSeconds: 0,
			}),
		).toBe(0);
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
	}, 15_000);

	test("admits only an authorized cell whose worst case preserves teardown", () => {
		const policy = validRcaPolicy();
		const exactlyAtCeiling = evaluateAdmission({
			policy,
			stage: "probe",
			accruedLifecycleMicrousd: 3_988_508,
			prospectiveCellMicrousd: 130_060,
			teardownReserveMicrousd: 433_532,
			elapsedLifecycleSeconds: 5_520,
			remainingDeadlineSeconds: 780,
		});
		expect(exactlyAtCeiling.decision).toBe("ADMIT");
		expect(exactlyAtCeiling.remainingAfterMicrousd).toBe(5_447_900);

		expect(
			evaluateAdmission({
				policy,
				stage: "probe",
				accruedLifecycleMicrousd: 3_988_509,
				prospectiveCellMicrousd: 130_060,
				teardownReserveMicrousd: 433_532,
				elapsedLifecycleSeconds: 5_520,
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
				elapsedLifecycleSeconds: 0,
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
				elapsedLifecycleSeconds: 0,
				remainingDeadlineSeconds: 779,
			}).decision,
		).toBe("REFUSED_DEADLINE");
		expect(
			evaluateAdmission({
				policy,
				stage: "probe",
				accruedLifecycleMicrousd: 1,
				prospectiveCellMicrousd: 1,
				teardownReserveMicrousd: 1,
				elapsedLifecycleSeconds: 5_521,
				remainingDeadlineSeconds: 780,
			}).decision,
		).toBe("REFUSED_DEADLINE");
	}, 15_000);
});

describe("G6 c-32 spend ledger", () => {
	test("versioned work settlement reports actual paid liability instead of the unused authorization ceiling", () => {
		const policy = validateBudgetPolicy(workPolicy());
		const common = {
			campaignId: policy.campaignId,
			runId: policy.runId,
			budgetPolicySha256: budgetPolicyArtifactSha256(policy),
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 649800,
			totalAuthorizedMicrousd: policy.spentBeforeMicrousd,
			remainingBudgetMicrousd:
				policy.totalBudgetMicrousd - policy.spentBeforeMicrousd,
			decision: null,
		};
		const intent = appendSpendLedgerEntry(null, {
			...common,
			event: "CREATE_INTENT",
			recordedAt: "2026-09-05T00:00:00.000Z",
			rigJournalEventArtifactSha256: "e".repeat(64),
		});
		const admission = appendSpendLedgerEntry(intent, {
			...common,
			event: "CELL_ADMISSION",
			recordedAt: "2026-09-05T00:10:00.000Z",
			accruedLifecycleMicrousd: 649800,
			prospectiveCellMicrousd: 3703860,
			totalAuthorizedMicrousd: policy.spentBeforeMicrousd + 4353660,
			remainingBudgetMicrousd: 7189796,
			decision: "ADMIT",
		});
		const original = JSON.stringify([intent, admission]);
		const seal = {
			...admission,
			schema: "g6-c32-spend-ledger-entry/2",
			sequence: 3,
			event: "SEAL",
			recordedAt: "2026-09-05T00:12:01.000Z",
			previousEntryArtifactSha256: spendLedgerEntryArtifactSha256(admission),
			accruedLifecycleMicrousd: 779760,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 0,
			remainingBudgetMicrousd:
				policy.totalBudgetMicrousd - policy.spentBeforeMicrousd - 779760,
			decision: null,
			settlement: {
				schema: "g6-c32-work-settlement/1",
				policy,
				verifiedAbsentAt: "2026-09-05T00:12:00.000Z",
				hourlyMicrousdByRole: policy.maximumRoleHourlyMicrousd,
				paidLifecycleMicrousd: 779760,
				paidTotalMicrousd: policy.spentBeforeMicrousd + 779760,
				overrunMicrousd: 0,
			},
		};
		const result = validateSpendLedger([intent, admission, seal]);
		expect(result.sealedTotalMicrousd).toBe(
			policy.spentBeforeMicrousd + 779760,
		);
		expect(requiredFixture(result.entries.at(-1)).totalAuthorizedMicrousd).toBe(
			admission.totalAuthorizedMicrousd,
		);
		expect(JSON.stringify([intent, admission])).toBe(original);
	});

	test("links each provider ledger entry to the preceding rig journal event", () => {
		const common = {
			campaignId: "g6-c32-rca-fix-01",
			runId: "g6-c32-journal-ledger-test",
			budgetPolicySha256: "b".repeat(64),
		};
		const price = appendSpendLedgerEntry(null, {
			...common,
			recordedAt: "2026-08-31T10:00:00.000Z",
			event: "PRICE_VERIFIED",
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 216_768,
			totalAuthorizedMicrousd: 0,
			remainingBudgetMicrousd: 10_000_000,
			decision: null,
		});
		const journalDigest = "c".repeat(64);
		const create = appendSpendLedgerEntry(price, {
			...common,
			recordedAt: "2026-08-31T10:01:00.000Z",
			event: "CREATE_INTENT",
			rigJournalEventArtifactSha256: journalDigest,
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 216_768,
			totalAuthorizedMicrousd: 0,
			remainingBudgetMicrousd: 9_783_232,
			decision: null,
		});

		expect(create.rigJournalEventArtifactSha256).toBe(journalDigest);
		expect(() =>
			appendSpendLedgerEntry(price, {
				...create,
				recordedAt: "2026-08-31T10:01:01.000Z",
				rigJournalEventArtifactSha256: null,
			}),
		).toThrow(/journal/i);
	}, 15_000);

	test("hash-links monotonic entries and seals the conservative lifecycle total", () => {
		const common = {
			campaignId: "g6-c32-rca-fix-01",
			runId: "g6-c32-rca-fix-01-d22c3fd4",
			budgetPolicySha256: "b".repeat(64),
		};
		const price = appendSpendLedgerEntry(null, {
			...common,
			recordedAt: "2026-08-31T10:00:00.000Z",
			event: "PRICE_VERIFIED",
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 216_768,
			totalAuthorizedMicrousd: 0,
			remainingBudgetMicrousd: 10_000_000,
			decision: null,
		});
		const admission = appendSpendLedgerEntry(price, {
			...common,
			recordedAt: "2026-08-31T10:01:00.000Z",
			event: "CELL_ADMISSION",
			accruedLifecycleMicrousd: 43_354,
			prospectiveCellMicrousd: 130_060,
			teardownReserveMicrousd: 216_768,
			totalAuthorizedMicrousd: 173_414,
			remainingBudgetMicrousd: 9_609_818,
			decision: "ADMIT",
		});
		const seal = appendSpendLedgerEntry(admission, {
			...common,
			recordedAt: "2026-08-31T10:02:00.000Z",
			event: "SEAL",
			accruedLifecycleMicrousd: 173_414,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 0,
			totalAuthorizedMicrousd: 173_414,
			remainingBudgetMicrousd: 9_826_586,
			decision: null,
		});

		expect(admission.sequence).toBe(2);
		expect(admission.previousEntryArtifactSha256).toBe(
			spendLedgerEntryArtifactSha256(price),
		);
		const validated = validateSpendLedger([price, admission, seal]);
		expect(validated.sealedTotalMicrousd).toBe(173_414);

		const tampered = {
			...admission,
			accruedLifecycleMicrousd: admission.accruedLifecycleMicrousd + 1,
		};
		expect(() => validateSpendLedger([price, tampered, seal])).toThrow(
			"previousEntryArtifactSha256",
		);
		expect(() =>
			appendSpendLedgerEntry(admission, {
				...common,
				recordedAt: "2026-08-31T10:01:30.000Z",
				event: "CELL_ADMISSION",
				accruedLifecycleMicrousd: 40_000,
				prospectiveCellMicrousd: 1,
				teardownReserveMicrousd: 1,
				totalAuthorizedMicrousd: 40_001,
				remainingBudgetMicrousd: 9_959_998,
				decision: "ADMIT",
			}),
		).toThrow("monotonic");
	}, 15_000);
});
