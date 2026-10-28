/** Exact producer/consumer wire contract; no dependency on execution or CLI state. */
import {
	appendSpendLedgerEntry,
	type BudgetPolicy,
	budgetPolicyArtifactSha256,
	type SpendLedgerEntry,
	spendLedgerEntryArtifactSha256,
	type WorkAdmissionResult,
} from "./g6-c32-budget.ts";
import { validateRfc3339Millis } from "./g6-c32-freeze-model.ts";

export type CellAdmission = WorkAdmissionResult &
	Readonly<{
		schema: "g6-c32-cell-admission/2";
		recordedAt: string;
		campaignId: string;
		runId: string;
		budgetPolicySha256: string;
		ledgerEntryArtifactSha256: string;
	}>;
const numeric = [
	"spentBeforeMicrousd",
	"accruedLifecycleMicrousd",
	"prospectiveCellMicrousd",
	"teardownReserveMicrousd",
	"totalAfterMicrousd",
	"remainingAfterMicrousd",
	"elapsedLifecycleSeconds",
	"remainingDeadlineSeconds",
	"requiredDeadlineSeconds",
] as const;
const keys = [
	"schema",
	"recordedAt",
	"campaignId",
	"runId",
	"budgetPolicySha256",
	"ledgerEntryArtifactSha256",
	"decision",
	"stage",
	"nextNodeId",
	"terminal",
	...numeric,
];
function fail(field: string): never {
	throw Error(`g6-c32-cell-admission: invalid ${field}`);
}
export function validateCellAdmission(value: unknown): CellAdmission {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("receipt");
	const raw = value as Record<string, unknown>;
	if (
		Object.keys(raw).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(raw, key))
	)
		fail("receipt fields");
	if (raw.schema !== "g6-c32-cell-admission/2") fail("schema");
	validateRfc3339Millis(raw.recordedAt, "admission recordedAt");
	for (const key of ["campaignId", "runId"])
		if (
			typeof raw[key] !== "string" ||
			raw[key].length > 128 ||
			!/^[a-z0-9][a-z0-9-]*$/.test(raw[key])
		)
			fail(key);
	if (
		typeof raw.stage !== "string" ||
		raw.stage.length > 64 ||
		!/^[a-z][a-z0-9-]*$/.test(raw.stage)
	)
		fail("stage");
	for (const key of ["budgetPolicySha256", "ledgerEntryArtifactSha256"])
		if (typeof raw[key] !== "string" || !/^[a-f0-9]{64}$/.test(raw[key]))
			fail(key);
	if (
		![
			"ADMIT",
			"REFUSED_SCOPE",
			"REFUSED_DEADLINE",
			"REFUSED_BUDGET",
			"TEARDOWN",
		].some((value) => raw.decision === value)
	)
		fail("decision");
	if (raw.decision === "TEARDOWN") {
		if (
			raw.nextNodeId !== null ||
			(raw.terminal !== "COMPLETE" && raw.terminal !== "INCOMPLETE")
		)
			fail("terminal");
	} else if (
		raw.terminal !== null ||
		typeof raw.nextNodeId !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(raw.nextNodeId)
	)
		fail("next node/terminal");
	for (const key of numeric) {
		if (
			key === "requiredDeadlineSeconds" &&
			raw[key] === null &&
			raw.decision !== "ADMIT"
		)
			continue;
		if (
			typeof raw[key] !== "number" ||
			!Number.isSafeInteger(raw[key]) ||
			raw[key] < 0
		)
			fail(key);
	}
	return raw as CellAdmission;
}

/** Preserve the writer's monotonic max envelopes, including refusal semantics. */
export function createCellAdmission(input: {
	policy: BudgetPolicy;
	previous: SpendLedgerEntry;
	recordedAt: string;
	result: WorkAdmissionResult;
}) {
	const { policy, previous, recordedAt, result } = input;
	if (result.decision === "TEARDOWN") fail("terminal ledger admission");
	const policySha256 = budgetPolicyArtifactSha256(policy);
	const entry = appendSpendLedgerEntry(previous, {
		recordedAt,
		campaignId: policy.campaignId,
		runId: policy.runId,
		budgetPolicySha256: policySha256,
		event: "CELL_ADMISSION",
		accruedLifecycleMicrousd: Math.max(
			previous.accruedLifecycleMicrousd,
			result.accruedLifecycleMicrousd,
		),
		prospectiveCellMicrousd: result.prospectiveCellMicrousd,
		teardownReserveMicrousd: result.teardownReserveMicrousd,
		totalAuthorizedMicrousd: Math.max(
			previous.totalAuthorizedMicrousd,
			result.decision === "ADMIT"
				? policy.spentBeforeMicrousd +
						result.accruedLifecycleMicrousd +
						result.prospectiveCellMicrousd
				: previous.totalAuthorizedMicrousd,
		),
		remainingBudgetMicrousd: result.remainingAfterMicrousd,
		decision: result.decision,
	});
	const receipt = validateCellAdmission({
		schema: "g6-c32-cell-admission/2",
		recordedAt,
		campaignId: policy.campaignId,
		runId: policy.runId,
		budgetPolicySha256: policySha256,
		ledgerEntryArtifactSha256: spendLedgerEntryArtifactSha256(entry),
		...result,
	});
	return { entry, receipt };
}
