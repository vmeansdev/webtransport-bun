import { expect, test } from "bun:test";
import { evaluateWorkAdmission } from "./g6-c32-budget.ts";
import {
	createCellAdmission,
	validateCellAdmission,
} from "./g6-c32-cell-admission.ts";
import {
	cleanupWorkFixtures,
	executionFixture,
} from "./g6-c32-work-fixture.test-helper.ts";

const valid = {
	schema: "g6-c32-cell-admission/2",
	recordedAt: "2026-09-05T00:00:00.000Z",
	campaignId: "campaign-a",
	runId: "run-a",
	budgetPolicySha256: "a".repeat(64),
	ledgerEntryArtifactSha256: "b".repeat(64),
	decision: "ADMIT",
	stage: "attribution",
	nextNodeId: "A0-1",
	terminal: null,
	spentBeforeMicrousd: 1,
	accruedLifecycleMicrousd: 2,
	prospectiveCellMicrousd: 3,
	teardownReserveMicrousd: 4,
	totalAfterMicrousd: 10,
	remainingAfterMicrousd: 20,
	elapsedLifecycleSeconds: 2,
	remainingDeadlineSeconds: 300,
	requiredDeadlineSeconds: 200,
} as const;
test("derived budget refusal results round-trip the shared producer contract", () => {
	try {
		const input = executionFixture(),
			previous = input.ledger.at(-1);
		if (!previous) throw Error("missing fixture ledger");
		for (const decision of ["REFUSED_SCOPE", "REFUSED_DEADLINE"] as const) {
			const policy = input.policy;
			const result = evaluateWorkAdmission({
				policy,
				stage: decision === "REFUSED_SCOPE" ? "ladder" : "attribution",
				completed: [],
				setupComplete: true,
				elapsedPaidSeconds: 130,
				controlUsedSeconds: 10,
				remainingDeadlineSeconds: decision === "REFUSED_DEADLINE" ? 1 : 7000,
			});
			expect(result.decision).toBe(decision);
			const output = createCellAdmission({
				policy,
				previous,
				recordedAt: "2026-09-05T00:02:10.000Z",
				result,
			});
			expect(output.receipt.decision).toBe(decision);
			expect(output.entry.totalAuthorizedMicrousd).toBe(
				previous.totalAuthorizedMicrousd,
			);
		}
		// /2 feasible-time policies pre-fund their maximum cost, so budget refusal
		// is compatibility coverage, not claimed as a reachable evaluator branch.
		const result = evaluateWorkAdmission({
			policy: input.policy,
			stage: "attribution",
			completed: [],
			setupComplete: true,
			elapsedPaidSeconds: 130,
			controlUsedSeconds: 10,
			remainingDeadlineSeconds: 7000,
		});
		expect(
			createCellAdmission({
				policy: input.policy,
				previous,
				recordedAt: "2026-09-05T00:02:10.000Z",
				result: { ...result, decision: "REFUSED_BUDGET" },
			}).receipt.decision,
		).toBe("REFUSED_BUDGET");
	} finally {
		cleanupWorkFixtures();
	}
});
test("strict19-field admission contract preserves legitimate refusal variants", () => {
	expect(validateCellAdmission(valid)).toEqual(valid);
	expect(
		validateCellAdmission({ ...valid, nextNodeId: "A_0" }).nextNodeId,
	).toBe("A_0");
	expect(
		validateCellAdmission({ ...valid, nextNodeId: "A".repeat(96) }).nextNodeId,
	).toHaveLength(96);
	expect(() =>
		validateCellAdmission({ ...valid, nextNodeId: "A".repeat(97) }),
	).toThrow();
	for (const decision of [
		"REFUSED_SCOPE",
		"REFUSED_DEADLINE",
		"REFUSED_BUDGET",
	] as const)
		expect(
			validateCellAdmission({
				...valid,
				decision,
				requiredDeadlineSeconds: null,
			}).decision,
		).toBe(decision);
	expect(
		validateCellAdmission({
			...valid,
			decision: "TEARDOWN",
			nextNodeId: null,
			terminal: "COMPLETE",
		}).terminal,
	).toBe("COMPLETE");
});
test("strict admission rejects keys, identities, types, numeric and nullability drift", () => {
	const mutations: Record<string, unknown>[] = [
		{ extra: 1 },
		{ schema: "g6-c32-cell-admission/1" },
		{ recordedAt: "yesterday" },
		{ campaignId: "../a" },
		{ runId: false },
		{ nextNodeId: "../A" },
		{ stage: [] },
		{ budgetPolicySha256: "A".repeat(64) },
		{ ledgerEntryArtifactSha256: null },
		{ decision: "DENY" },
		{ terminal: "COMPLETE" },
		{ nextNodeId: null },
		{ requiredDeadlineSeconds: null },
	];
	for (const field of Object.keys(valid).filter(
		(key) => key.endsWith("Microusd") || key.endsWith("Seconds"),
	))
		for (const value of [
			-1,
			0.5,
			Number.MAX_SAFE_INTEGER + 1,
			"1",
			NaN,
			Infinity,
		])
			mutations.push({ [field]: value });
	for (const patch of mutations)
		expect(() => validateCellAdmission({ ...valid, ...patch })).toThrow();
	for (const key of Object.keys(valid)) {
		const missing: Record<string, unknown> = { ...valid };
		delete missing[key];
		expect(() => validateCellAdmission(missing)).toThrow();
	}
});
