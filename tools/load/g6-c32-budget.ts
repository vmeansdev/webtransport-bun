import { createHash } from "node:crypto";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import {
	evaluateWorkPlanTimeAdmission,
	validateWorkPlan,
	type WorkPlan,
	type WorkTerminal,
} from "./g6-c32-work-plan.ts";
import {
	validateWorkProfiles,
	type WorkProfiles,
} from "./g6-c32-work-profile.ts";

export const G6_C32_BUDGET_POLICY_SCHEMA = "g6-c32-budget-policy/1";
export const G6_C32_WORK_BUDGET_POLICY_SCHEMA = "g6-c32-budget-policy/2";
export const G6_C32_SPEND_LEDGER_ENTRY_SCHEMA = "g6-c32-spend-ledger-entry/1";
export const G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA =
	"g6-c32-spend-ledger-entry/2";
export const G6_C32_WORK_SETTLEMENT_SCHEMA = "g6-c32-work-settlement/1";

export type BudgetLifecycle =
	| "rca-only"
	| "post-fix-only"
	| "ladder-only"
	| "attribution-only";

export type PriorSpendLedger = Readonly<{
	path: string;
	sha256: string;
	sealedSpentMicrousd: number;
}>;

type CommonBudgetPolicy = Readonly<{
	campaignId: string;
	runId: string;
	currency: "USD";
	lifecycle: BudgetLifecycle;
	totalBudgetMicrousd: number;
	spentBeforeMicrousd: number;
	maximumRoleHourlyMicrousd: Readonly<{
		server: number;
		generator: number;
	}>;
	maximumLifecycleSeconds: number;
	teardownReserveSeconds: number;
	maximumLifecycleCostMicrousd: number;
	cellMaximumSeconds: Readonly<Record<string, number>>;
	allowedStages: readonly string[];
	priorLedger: PriorSpendLedger | null;
}>;
export type BudgetPolicy = CommonBudgetPolicy &
	(
		| Readonly<{ schema: typeof G6_C32_BUDGET_POLICY_SCHEMA }>
		| Readonly<{
				schema: typeof G6_C32_WORK_BUDGET_POLICY_SCHEMA;
				workPlan: WorkPlan;
				workProfiles: WorkProfiles;
		  }>
	);
export type WorkBudgetPolicy = Extract<
	BudgetPolicy,
	{ schema: typeof G6_C32_WORK_BUDGET_POLICY_SCHEMA }
>;

export type AdmissionDecision =
	| "ADMIT"
	| "REFUSED_BUDGET"
	| "REFUSED_SCOPE"
	| "REFUSED_DEADLINE";

export type AdmissionResult = Readonly<{
	decision: AdmissionDecision;
	stage: string;
	spentBeforeMicrousd: number;
	accruedLifecycleMicrousd: number;
	prospectiveCellMicrousd: number;
	teardownReserveMicrousd: number;
	totalAfterMicrousd: number;
	remainingAfterMicrousd: number;
	elapsedLifecycleSeconds: number;
	remainingDeadlineSeconds: number;
	requiredDeadlineSeconds: number | null;
}>;

export type SpendLedgerEvent =
	| "PRICE_VERIFIED"
	| "CREATE_INTENT"
	| "CREATE_OBSERVED"
	| "DESTROY_INTENT"
	| "DESTROY_CONFIRMED"
	| "EMERGENCY_RECONCILIATION"
	| "CELL_ADMISSION"
	| "DEADLINE"
	| "ABORT"
	| "SEAL";

type CommonSpendLedgerEntry = Readonly<{
	sequence: number;
	recordedAt: string;
	campaignId: string;
	runId: string;
	budgetPolicySha256: string;
	previousEntryArtifactSha256: string | null;
	rigJournalEventArtifactSha256: string | null;
	event: SpendLedgerEvent;
	accruedLifecycleMicrousd: number;
	prospectiveCellMicrousd: number;
	teardownReserveMicrousd: number;
	totalAuthorizedMicrousd: number;
	remainingBudgetMicrousd: number;
	decision: AdmissionDecision | null;
}>;

type LegacySpendLedgerEntry = CommonSpendLedgerEntry &
	Readonly<{
		schema: typeof G6_C32_SPEND_LEDGER_ENTRY_SCHEMA;
	}>;

export type WorkSpendSettlement = Readonly<{
	schema: typeof G6_C32_WORK_SETTLEMENT_SCHEMA;
	policy: WorkBudgetPolicy;
	verifiedAbsentAt: string;
	hourlyMicrousdByRole: Readonly<{ server: number; generator: number }> | null;
	paidLifecycleMicrousd: number;
	paidTotalMicrousd: number;
	overrunMicrousd: number;
}>;

/** Only the terminal record changes version; historical active entries stay byte-identical. */
export type WorkSpendLedgerSeal = CommonSpendLedgerEntry &
	Readonly<{
		schema: typeof G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA;
		event: "SEAL";
		decision: null;
		settlement: WorkSpendSettlement;
	}>;

export type SpendLedgerEntry = LegacySpendLedgerEntry | WorkSpendLedgerSeal;

export type SpendLedgerSummary = Readonly<{
	entries: readonly SpendLedgerEntry[];
	sealedTotalMicrousd: number | null;
}>;

export function observedLifecycleCost(
	input: Readonly<{
		entries: readonly SpendLedgerEntry[];
		sealedAt: string;
		hourlyMicrousdByRole: Readonly<{ server: number; generator: number }>;
	}>,
): number {
	const observed = input.entries
		.filter(({ event }) => event === "CREATE_OBSERVED")
		.map(({ recordedAt }) => Date.parse(recordedAt));
	if (observed.length === 0) return 0;
	const sealedAt = Date.parse(input.sealedAt);
	const startedAt = Math.min(...observed);
	if (!Number.isFinite(sealedAt) || !Number.isFinite(startedAt)) {
		fail("observed lifecycle timestamps are invalid");
	}
	return maximumLifecycleCost({
		hourlyMicrousdByRole: input.hourlyMicrousdByRole,
		executionSeconds: Math.max(0, Math.ceil((sealedAt - startedAt) / 1_000)),
		teardownReserveSeconds: 0,
	});
}

/** New campaigns reserve both roles from CREATE_INTENT, including uncertain creates.
 * Keep observedLifecycleCost unchanged for historical /1 ledger interpretation. */
export function paidLifecycleCost(
	input: Readonly<{
		entries: readonly Pick<SpendLedgerEntry, "event" | "recordedAt">[];
		sealedAt: string;
		hourlyMicrousdByRole: Readonly<{ server: number; generator: number }>;
	}>,
): number {
	const sealedAt = Date.parse(
		requireRfc3339Millis(input.sealedAt, "paid sealedAt"),
	);
	const intents = input.entries
		.filter((entry) => entry.event === "CREATE_INTENT")
		.map((entry) =>
			Date.parse(
				requireRfc3339Millis(entry.recordedAt, "CREATE_INTENT recordedAt"),
			),
		);
	const observed = input.entries
		.filter((entry) => entry.event === "CREATE_OBSERVED")
		.map((entry) =>
			Date.parse(
				requireRfc3339Millis(entry.recordedAt, "CREATE_OBSERVED recordedAt"),
			),
		);
	if (intents.length === 0) {
		if (observed.length > 0)
			fail("paid lifecycle requires CREATE_INTENT before observation");
		return 0;
	}
	const startedAt = Math.min(...intents);
	if (
		sealedAt < startedAt ||
		observed.some((at) => at < startedAt || at > sealedAt) ||
		intents.some((at) => at > sealedAt)
	)
		fail("paid lifecycle timestamps are out of order");
	return maximumLifecycleCost({
		hourlyMicrousdByRole: input.hourlyMicrousdByRole,
		executionSeconds: Math.ceil((sealedAt - startedAt) / 1_000),
		teardownReserveSeconds: 0,
	});
}

/** Publication can be replayed later; new-policy liability stops at verified absence. */
export function lifecycleCostAtTeardown(
	input: Readonly<{
		schema: BudgetPolicy["schema"];
		entries:
			| readonly SpendLedgerEntry[]
			| readonly Pick<SpendLedgerEntry, "event" | "recordedAt">[];
		recordedAt: string;
		verifiedAbsentAt: string | null;
		hourlyMicrousdByRole: Readonly<{
			server: number;
			generator: number;
		}> | null;
	}>,
): number {
	const workPolicy = input.schema === G6_C32_WORK_BUDGET_POLICY_SCHEMA;
	let sealedAt = input.recordedAt;
	if (workPolicy) {
		sealedAt = requireRfc3339Millis(
			input.verifiedAbsentAt,
			"committed absence timestamp",
		);
		if (
			Date.parse(requireRfc3339Millis(input.recordedAt, "seal recordedAt")) <
			Date.parse(sealedAt)
		)
			fail("spend publication is before committed absence");
	}
	if (!input.hourlyMicrousdByRole) {
		if (
			input.entries.some(
				({ event }) =>
					event === "CREATE_OBSERVED" ||
					(workPolicy && event === "CREATE_INTENT"),
			)
		)
			fail("paid lifecycle lacks price authority");
		return 0;
	}
	return workPolicy
		? paidLifecycleCost({
				entries: input.entries,
				sealedAt,
				hourlyMicrousdByRole: input.hourlyMicrousdByRole,
			})
		: observedLifecycleCost({
				entries: input.entries as readonly SpendLedgerEntry[],
				sealedAt,
				hourlyMicrousdByRole: input.hourlyMicrousdByRole,
			});
}

function fail(message: string): never {
	throw new Error(`g6-c32-budget: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		fail(`${label} keys must be exactly ${wanted.join(",")}`);
	}
}

function requireIdentifier(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 128 ||
		!/^[a-z0-9][a-z0-9-]*$/.test(value)
	) {
		fail(`${label} must be a lowercase hyphenated identifier`);
	}
	return value;
}

function requireStage(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 64 ||
		!/^[a-z][a-z0-9-]*$/.test(value)
	) {
		fail(`${label} must be a lowercase stage identifier`);
	}
	return value;
}

function requireSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		fail(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function requireRfc3339Millis(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(
			value,
		) ||
		!Number.isFinite(Date.parse(value))
	) {
		fail(`${label} must be RFC3339 with millisecond precision`);
	}
	return value;
}

function canonicalize(value: unknown): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			fail("canonical JSON rejects non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalize(item)).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
			.join(",")}}`;
	}
	fail("canonical JSON rejects unsupported values");
}

function validatePriorLedger(value: unknown): PriorSpendLedger {
	if (!isRecord(value)) fail("priorLedger must be an object");
	requireExactKeys(
		value,
		["path", "sha256", "sealedSpentMicrousd"],
		"priorLedger",
	);
	if (typeof value.path !== "string" || value.path.length === 0) {
		fail("priorLedger.path must be a non-empty string");
	}
	if (
		typeof value.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.sha256)
	) {
		fail("priorLedger.sha256 must be a lowercase SHA-256 digest");
	}
	return {
		path: value.path,
		sha256: value.sha256,
		sealedSpentMicrousd: requireSafeInteger(
			value.sealedSpentMicrousd,
			"priorLedger.sealedSpentMicrousd",
		),
	};
}

function requireSafeInteger(
	value: unknown,
	label: string,
	minimum = 0,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		fail(`${label} must be a safe integer >= ${minimum}`);
	}
	return value as number;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
	return (numerator + denominator - 1n) / denominator;
}

export function maximumLifecycleCost(input: {
	hourlyMicrousdByRole: Readonly<{ server: number; generator: number }>;
	executionSeconds: number;
	teardownReserveSeconds: number;
}): number {
	const executionSeconds = requireSafeInteger(
		input.executionSeconds,
		"executionSeconds",
	);
	const teardownReserveSeconds = requireSafeInteger(
		input.teardownReserveSeconds,
		"teardownReserveSeconds",
	);
	if (executionSeconds === 0 && teardownReserveSeconds === 0) return 0;
	const billedMinutes = ceilDiv(
		BigInt(executionSeconds) + BigInt(teardownReserveSeconds),
		60n,
	);
	const total = Object.values(input.hourlyMicrousdByRole).reduce(
		(sum, rawPrice) =>
			sum +
			ceilDiv(
				BigInt(requireSafeInteger(rawPrice, "hourlyMicrousd", 1)) *
					billedMinutes,
				60n,
			),
		0n,
	);
	if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
		fail("maximum lifecycle cost exceeds Number.MAX_SAFE_INTEGER");
	}
	return Number(total);
}

export function validateBudgetPolicy(value: unknown): BudgetPolicy {
	if (!isRecord(value)) fail("policy must be an object");
	const hasWorkPlan = value.schema === G6_C32_WORK_BUDGET_POLICY_SCHEMA;
	requireExactKeys(
		value,
		[
			"schema",
			"campaignId",
			"runId",
			"currency",
			"lifecycle",
			"totalBudgetMicrousd",
			"spentBeforeMicrousd",
			"maximumRoleHourlyMicrousd",
			"maximumLifecycleSeconds",
			"teardownReserveSeconds",
			"maximumLifecycleCostMicrousd",
			"cellMaximumSeconds",
			"allowedStages",
			"priorLedger",
			...(hasWorkPlan ? ["workPlan", "workProfiles"] : []),
		],
		"policy",
	);
	if (!hasWorkPlan && value.schema !== G6_C32_BUDGET_POLICY_SCHEMA) {
		fail(`schema must be ${G6_C32_BUDGET_POLICY_SCHEMA}`);
	}
	if (value.currency !== "USD") fail("currency must be USD");
	if (
		hasWorkPlan
			? value.lifecycle !== "attribution-only" &&
				value.lifecycle !== "ladder-only"
			: value.lifecycle !== "rca-only" &&
				value.lifecycle !== "post-fix-only" &&
				value.lifecycle !== "ladder-only"
	) {
		fail("lifecycle does not belong to this policy schema");
	}
	if (!isRecord(value.maximumRoleHourlyMicrousd)) {
		fail("maximumRoleHourlyMicrousd must be an object");
	}
	requireExactKeys(
		value.maximumRoleHourlyMicrousd,
		["server", "generator"],
		"maximumRoleHourlyMicrousd",
	);
	const rolePrices = {
		server: requireSafeInteger(
			value.maximumRoleHourlyMicrousd.server,
			"maximumRoleHourlyMicrousd.server",
			1,
		),
		generator: requireSafeInteger(
			value.maximumRoleHourlyMicrousd.generator,
			"maximumRoleHourlyMicrousd.generator",
			1,
		),
	};
	if (!Array.isArray(value.allowedStages) || value.allowedStages.length === 0) {
		fail("allowedStages must be a non-empty array");
	}
	const allowedStages = value.allowedStages.map((stage, index) =>
		requireStage(stage, `allowedStages[${index}]`),
	);
	if (new Set(allowedStages).size !== allowedStages.length) {
		fail("allowedStages must be unique");
	}
	if (!isRecord(value.cellMaximumSeconds)) {
		fail("cellMaximumSeconds must be an object");
	}
	const cellMaximumSeconds: Record<string, number> = {};
	for (const [stage, seconds] of Object.entries(value.cellMaximumSeconds)) {
		const checkedStage = requireStage(stage, "cellMaximumSeconds key");
		cellMaximumSeconds[checkedStage] = requireSafeInteger(
			seconds,
			`cellMaximumSeconds.${checkedStage}`,
			1,
		);
	}
	const actualCellStages = Object.keys(cellMaximumSeconds).sort();
	const expectedCellStages = [...allowedStages].sort();
	if (
		actualCellStages.length !== expectedCellStages.length ||
		actualCellStages.some((stage, index) => stage !== expectedCellStages[index])
	) {
		fail("cellMaximumSeconds keys must exactly match allowedStages");
	}
	const maximumLifecycleSeconds = requireSafeInteger(
		value.maximumLifecycleSeconds,
		"maximumLifecycleSeconds",
		1,
	);
	const teardownReserveSeconds = requireSafeInteger(
		value.teardownReserveSeconds,
		"teardownReserveSeconds",
		1,
	);
	const calculatedMaximum = maximumLifecycleCost({
		hourlyMicrousdByRole: rolePrices,
		executionSeconds: maximumLifecycleSeconds,
		teardownReserveSeconds,
	});
	const maximumLifecycleCostMicrousd = requireSafeInteger(
		value.maximumLifecycleCostMicrousd,
		"maximumLifecycleCostMicrousd",
		1,
	);
	if (maximumLifecycleCostMicrousd !== calculatedMaximum) {
		fail(
			`maximumLifecycleCostMicrousd must equal calculated cost ${calculatedMaximum}`,
		);
	}
	const totalBudgetMicrousd = requireSafeInteger(
		value.totalBudgetMicrousd,
		"totalBudgetMicrousd",
		1,
	);
	const spentBeforeMicrousd = requireSafeInteger(
		value.spentBeforeMicrousd,
		"spentBeforeMicrousd",
	);
	const priorLedger =
		value.priorLedger === null ? null : validatePriorLedger(value.priorLedger);
	if (
		(value.lifecycle !== "rca-only" && spentBeforeMicrousd === 0) ||
		(spentBeforeMicrousd === 0 && priorLedger !== null) ||
		(spentBeforeMicrousd > 0 &&
			(priorLedger === null ||
				priorLedger.sealedSpentMicrousd !== spentBeforeMicrousd))
	) {
		fail("priorLedger must exactly bind nonzero spentBeforeMicrousd");
	}
	if (
		BigInt(spentBeforeMicrousd) + BigInt(maximumLifecycleCostMicrousd) >
		BigInt(totalBudgetMicrousd)
	) {
		fail(
			"spentBeforeMicrousd plus maximum lifecycle cost exceeds total budget",
		);
	}
	const common: CommonBudgetPolicy = {
		campaignId: requireIdentifier(value.campaignId, "campaignId"),
		runId: requireIdentifier(value.runId, "runId"),
		currency: "USD",
		lifecycle: value.lifecycle as BudgetLifecycle,
		totalBudgetMicrousd,
		spentBeforeMicrousd,
		maximumRoleHourlyMicrousd: rolePrices,
		maximumLifecycleSeconds,
		teardownReserveSeconds,
		maximumLifecycleCostMicrousd,
		cellMaximumSeconds,
		allowedStages,
		priorLedger,
	};
	if (!hasWorkPlan) return { ...common, schema: G6_C32_BUDGET_POLICY_SCHEMA };
	const workPlan = validateWorkPlan(value.workPlan);
	if (
		workPlan.activeMaximumSeconds !== maximumLifecycleSeconds ||
		workPlan.teardownReserveSeconds !== teardownReserveSeconds
	)
		fail("work-plan timing disagrees with policy bounds");
	const kinds = [...new Set(workPlan.nodes.map((node) => node.kind))].sort();
	if (
		kinds.length !== expectedCellStages.length ||
		kinds.some((kind, index) => kind !== expectedCellStages[index])
	)
		fail("work-plan kinds must exactly match allowedStages");
	if (
		workPlan.nodes.some(
			(node) => node.maximumSeconds !== cellMaximumSeconds[node.kind],
		)
	)
		fail("work-plan cell durations disagree with policy");
	if (
		value.lifecycle === "attribution-only"
			? kinds.some(
					(kind) => kind !== "attribution" && kind !== "attribution-r4",
				)
			: kinds.includes("attribution") || kinds.includes("attribution-r4")
	)
		fail("work-plan kinds disagree with lifecycle");
	return {
		...common,
		schema: G6_C32_WORK_BUDGET_POLICY_SCHEMA,
		workPlan,
		workProfiles: validateWorkProfiles(workPlan, value.workProfiles),
	};
}

export function evaluateAdmission(input: {
	policy: BudgetPolicy;
	stage: string;
	accruedLifecycleMicrousd: number;
	prospectiveCellMicrousd: number;
	teardownReserveMicrousd: number;
	elapsedLifecycleSeconds: number;
	remainingDeadlineSeconds: number;
}): AdmissionResult {
	const policy = validateBudgetPolicy(input.policy);
	if (policy.schema === G6_C32_WORK_BUDGET_POLICY_SCHEMA)
		fail(
			"work-plan policy requires whole-branch admission, not legacy one-cell estimates",
		);
	const stage = requireStage(input.stage, "stage");
	const accruedLifecycleMicrousd = requireSafeInteger(
		input.accruedLifecycleMicrousd,
		"accruedLifecycleMicrousd",
	);
	const prospectiveCellMicrousd = requireSafeInteger(
		input.prospectiveCellMicrousd,
		"prospectiveCellMicrousd",
	);
	const teardownReserveMicrousd = requireSafeInteger(
		input.teardownReserveMicrousd,
		"teardownReserveMicrousd",
	);
	const elapsedLifecycleSeconds = requireSafeInteger(
		input.elapsedLifecycleSeconds,
		"elapsedLifecycleSeconds",
	);
	const remainingDeadlineSeconds = requireSafeInteger(
		input.remainingDeadlineSeconds,
		"remainingDeadlineSeconds",
	);
	const totalAfter =
		BigInt(policy.spentBeforeMicrousd) +
		BigInt(accruedLifecycleMicrousd) +
		BigInt(prospectiveCellMicrousd) +
		BigInt(teardownReserveMicrousd);
	const totalAfterMicrousd =
		totalAfter > BigInt(Number.MAX_SAFE_INTEGER)
			? Number.MAX_SAFE_INTEGER
			: Number(totalAfter);
	const remaining = BigInt(policy.totalBudgetMicrousd) - totalAfter;
	const remainingAfterMicrousd = remaining < 0n ? 0 : Number(remaining);
	const common = {
		stage,
		spentBeforeMicrousd: policy.spentBeforeMicrousd,
		accruedLifecycleMicrousd,
		prospectiveCellMicrousd,
		teardownReserveMicrousd,
		totalAfterMicrousd,
		remainingAfterMicrousd,
		elapsedLifecycleSeconds,
		remainingDeadlineSeconds,
	};
	if (!policy.allowedStages.includes(stage)) {
		return {
			...common,
			decision: "REFUSED_SCOPE",
			requiredDeadlineSeconds: null,
		};
	}
	const requiredDeadlineSeconds =
		(policy.cellMaximumSeconds[stage] ??
			fail(`cellMaximumSeconds missing authorized stage ${stage}`)) +
		policy.teardownReserveSeconds;
	const cellMaximumSeconds =
		requiredDeadlineSeconds - policy.teardownReserveSeconds;
	if (
		remainingDeadlineSeconds < requiredDeadlineSeconds ||
		elapsedLifecycleSeconds + cellMaximumSeconds >
			policy.maximumLifecycleSeconds
	) {
		return {
			...common,
			decision: "REFUSED_DEADLINE",
			requiredDeadlineSeconds,
		};
	}
	const lifecycleAfter =
		BigInt(accruedLifecycleMicrousd) +
		BigInt(prospectiveCellMicrousd) +
		BigInt(teardownReserveMicrousd);
	if (
		lifecycleAfter > BigInt(policy.maximumLifecycleCostMicrousd) ||
		totalAfter > BigInt(policy.totalBudgetMicrousd)
	) {
		return {
			...common,
			decision: "REFUSED_BUDGET",
			requiredDeadlineSeconds,
		};
	}
	return {
		...common,
		decision: "ADMIT",
		requiredDeadlineSeconds,
	};
}

export type WorkAdmissionResult = Omit<AdmissionResult, "decision"> &
	Readonly<{
		decision: AdmissionDecision | "TEARDOWN";
		nextNodeId: string | null;
		terminal: WorkTerminal | null;
	}>;

/** Derive liability from the frozen DAG; no caller-declared money or cell duration. */
export function evaluateWorkAdmission(input: {
	policy: BudgetPolicy;
	stage: string;
	completed: unknown;
	setupComplete: boolean;
	elapsedPaidSeconds: number;
	controlUsedSeconds: number;
	remainingDeadlineSeconds: number;
}): WorkAdmissionResult {
	const policy = validateBudgetPolicy(input.policy);
	if (policy.schema !== G6_C32_WORK_BUDGET_POLICY_SCHEMA)
		fail("whole-branch admission requires work-plan policy");
	const stage = requireStage(input.stage, "stage");
	const time = evaluateWorkPlanTimeAdmission({
		plan: policy.workPlan,
		completed: input.completed,
		setupComplete: input.setupComplete,
		elapsedPaidSeconds: input.elapsedPaidSeconds,
		controlUsedSeconds: input.controlUsedSeconds,
		remainingDeadlineSeconds: input.remainingDeadlineSeconds,
	});
	const cost = (seconds: number) =>
		maximumLifecycleCost({
			hourlyMicrousdByRole: policy.maximumRoleHourlyMicrousd,
			executionSeconds: seconds,
			teardownReserveSeconds: 0,
		});
	const endExecution = requireSafeInteger(
		input.elapsedPaidSeconds + time.requiredExecutionSeconds,
		"end execution",
	);
	const endTeardown = requireSafeInteger(
		endExecution + policy.teardownReserveSeconds,
		"end teardown",
	);
	const accrued = cost(input.elapsedPaidSeconds);
	const executionCost = cost(endExecution);
	const totalLifecycle = cost(endTeardown);
	const totalAfterMicrousd = requireSafeInteger(
		policy.spentBeforeMicrousd + totalLifecycle,
		"total after",
	);
	const nextNode = policy.workPlan.nodes.find(
		(node) => node.id === time.nextNodeId,
	);
	const decision =
		time.decision === "TEARDOWN"
			? "TEARDOWN"
			: !policy.allowedStages.includes(stage) || nextNode?.kind !== stage
				? "REFUSED_SCOPE"
				: time.decision === "REFUSED_DEADLINE"
					? "REFUSED_DEADLINE"
					: totalLifecycle > policy.maximumLifecycleCostMicrousd ||
							totalAfterMicrousd > policy.totalBudgetMicrousd
						? "REFUSED_BUDGET"
						: "ADMIT";
	return {
		decision,
		stage,
		nextNodeId: time.nextNodeId,
		terminal: time.terminal,
		spentBeforeMicrousd: policy.spentBeforeMicrousd,
		accruedLifecycleMicrousd: accrued,
		prospectiveCellMicrousd: executionCost - accrued,
		teardownReserveMicrousd: totalLifecycle - executionCost,
		totalAfterMicrousd,
		remainingAfterMicrousd: Math.max(
			0,
			policy.totalBudgetMicrousd - totalAfterMicrousd,
		),
		elapsedLifecycleSeconds: input.elapsedPaidSeconds,
		remainingDeadlineSeconds: input.remainingDeadlineSeconds,
		requiredDeadlineSeconds: time.requiredDeadlineSeconds,
	};
}

export function spendLedgerEntryArtifactSha256(
	entry: SpendLedgerEntry,
): string {
	return createHash("sha256").update(canonicalize(entry)).digest("hex");
}

export function budgetPolicyArtifactSha256(policy: BudgetPolicy): string {
	return createHash("sha256")
		.update(canonicalize(validateBudgetPolicy(policy)))
		.digest("hex");
}

export type SpendLedgerEntryInput = Omit<
	LegacySpendLedgerEntry,
	| "schema"
	| "sequence"
	| "previousEntryArtifactSha256"
	| "rigJournalEventArtifactSha256"
> & { rigJournalEventArtifactSha256?: string | null };

function validateSpendLedgerEvent(value: unknown): SpendLedgerEvent {
	if (
		value !== "PRICE_VERIFIED" &&
		value !== "CREATE_INTENT" &&
		value !== "CREATE_OBSERVED" &&
		value !== "DESTROY_INTENT" &&
		value !== "DESTROY_CONFIRMED" &&
		value !== "EMERGENCY_RECONCILIATION" &&
		value !== "CELL_ADMISSION" &&
		value !== "DEADLINE" &&
		value !== "ABORT" &&
		value !== "SEAL"
	) {
		fail("spend ledger event is invalid");
	}
	return value;
}

function validateDecision(value: unknown): AdmissionDecision | null {
	if (
		value !== null &&
		value !== "ADMIT" &&
		value !== "REFUSED_BUDGET" &&
		value !== "REFUSED_SCOPE" &&
		value !== "REFUSED_DEADLINE"
	) {
		fail("spend ledger decision is invalid");
	}
	return value;
}

export function validateSpendLedgerEntry(value: unknown): SpendLedgerEntry {
	if (!isRecord(value)) fail("spend ledger entry must be an object");
	const workSeal = value.schema === G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA;
	requireExactKeys(
		value,
		[
			"schema",
			"sequence",
			"recordedAt",
			"campaignId",
			"runId",
			"budgetPolicySha256",
			"previousEntryArtifactSha256",
			"rigJournalEventArtifactSha256",
			"event",
			"accruedLifecycleMicrousd",
			"prospectiveCellMicrousd",
			"teardownReserveMicrousd",
			"totalAuthorizedMicrousd",
			"remainingBudgetMicrousd",
			"decision",
			...(workSeal ? ["settlement"] : []),
		],
		"spend ledger entry",
	);
	if (!workSeal && value.schema !== G6_C32_SPEND_LEDGER_ENTRY_SCHEMA) {
		fail(`spend ledger schema must be ${G6_C32_SPEND_LEDGER_ENTRY_SCHEMA}`);
	}
	const event = validateSpendLedgerEvent(value.event);
	const decision = validateDecision(value.decision);
	if ((event === "CELL_ADMISSION") !== (decision !== null)) {
		fail("only CELL_ADMISSION entries carry a decision");
	}
	const rigJournalEventArtifactSha256 =
		value.rigJournalEventArtifactSha256 === null
			? null
			: requireSha256(
					value.rigJournalEventArtifactSha256,
					"rigJournalEventArtifactSha256",
				);
	if (
		(event === "CREATE_INTENT" ||
			event === "CREATE_OBSERVED" ||
			event === "DESTROY_INTENT" ||
			event === "DESTROY_CONFIRMED") &&
		rigJournalEventArtifactSha256 === null
	) {
		fail("provider spend entries must bind a rig journal event");
	}
	const common: CommonSpendLedgerEntry = {
		sequence: requireSafeInteger(value.sequence, "spend ledger sequence", 1),
		recordedAt: requireRfc3339Millis(value.recordedAt, "recordedAt"),
		campaignId: requireIdentifier(value.campaignId, "campaignId"),
		runId: requireIdentifier(value.runId, "runId"),
		budgetPolicySha256: requireSha256(
			value.budgetPolicySha256,
			"budgetPolicySha256",
		),
		previousEntryArtifactSha256:
			value.previousEntryArtifactSha256 === null
				? null
				: requireSha256(
						value.previousEntryArtifactSha256,
						"previousEntryArtifactSha256",
					),
		rigJournalEventArtifactSha256,
		event,
		accruedLifecycleMicrousd: requireSafeInteger(
			value.accruedLifecycleMicrousd,
			"accruedLifecycleMicrousd",
		),
		prospectiveCellMicrousd: requireSafeInteger(
			value.prospectiveCellMicrousd,
			"prospectiveCellMicrousd",
		),
		teardownReserveMicrousd: requireSafeInteger(
			value.teardownReserveMicrousd,
			"teardownReserveMicrousd",
		),
		totalAuthorizedMicrousd: requireSafeInteger(
			value.totalAuthorizedMicrousd,
			"totalAuthorizedMicrousd",
		),
		remainingBudgetMicrousd: requireSafeInteger(
			value.remainingBudgetMicrousd,
			"remainingBudgetMicrousd",
		),
		decision,
	};
	if (!workSeal) return { schema: G6_C32_SPEND_LEDGER_ENTRY_SCHEMA, ...common };
	if (
		event !== "SEAL" ||
		decision !== null ||
		common.prospectiveCellMicrousd !== 0 ||
		common.teardownReserveMicrousd !== 0 ||
		rigJournalEventArtifactSha256 !== null
	)
		fail(
			"work settlement is terminal-only and cannot authorize work or reserves",
		);
	const raw = value.settlement;
	if (!isRecord(raw)) fail("work settlement must be an object");
	requireExactKeys(
		raw,
		[
			"schema",
			"policy",
			"verifiedAbsentAt",
			"hourlyMicrousdByRole",
			"paidLifecycleMicrousd",
			"paidTotalMicrousd",
			"overrunMicrousd",
		],
		"work settlement",
	);
	if (raw.schema !== G6_C32_WORK_SETTLEMENT_SCHEMA)
		fail("unsupported work settlement schema");
	const policy = validateBudgetPolicy(raw.policy);
	if (
		policy.schema !== G6_C32_WORK_BUDGET_POLICY_SCHEMA ||
		policy.campaignId !== common.campaignId ||
		policy.runId !== common.runId ||
		budgetPolicyArtifactSha256(policy) !== common.budgetPolicySha256
	)
		fail("work settlement policy differs from ledger authority");
	let hourlyMicrousdByRole: WorkSpendSettlement["hourlyMicrousdByRole"] = null;
	if (raw.hourlyMicrousdByRole !== null) {
		if (!isRecord(raw.hourlyMicrousdByRole))
			fail("settlement prices must be an object or null");
		requireExactKeys(
			raw.hourlyMicrousdByRole,
			["server", "generator"],
			"settlement prices",
		);
		hourlyMicrousdByRole = {
			server: requireSafeInteger(
				raw.hourlyMicrousdByRole.server,
				"settlement server price",
				1,
			),
			generator: requireSafeInteger(
				raw.hourlyMicrousdByRole.generator,
				"settlement generator price",
				1,
			),
		};
		for (const role of ["server", "generator"] as const)
			if (hourlyMicrousdByRole[role] > policy.maximumRoleHourlyMicrousd[role])
				fail("settlement price exceeds frozen authority");
	}
	const settlement: WorkSpendSettlement = {
		schema: G6_C32_WORK_SETTLEMENT_SCHEMA,
		policy,
		verifiedAbsentAt: requireRfc3339Millis(
			raw.verifiedAbsentAt,
			"committed absence timestamp",
		),
		hourlyMicrousdByRole,
		paidLifecycleMicrousd: requireSafeInteger(
			raw.paidLifecycleMicrousd,
			"paid lifecycle",
		),
		paidTotalMicrousd: requireSafeInteger(raw.paidTotalMicrousd, "paid total"),
		overrunMicrousd: requireSafeInteger(
			raw.overrunMicrousd,
			"overrun liability",
		),
	};
	const total = requireSafeInteger(
		policy.spentBeforeMicrousd + settlement.paidLifecycleMicrousd,
		"settled total",
	);
	if (
		settlement.paidTotalMicrousd !== total ||
		settlement.overrunMicrousd !==
			Math.max(0, total - policy.totalBudgetMicrousd) ||
		common.remainingBudgetMicrousd !==
			Math.max(0, policy.totalBudgetMicrousd - total) ||
		common.accruedLifecycleMicrousd !== settlement.paidLifecycleMicrousd
	)
		fail("work settlement paid totals, available budget or overrun disagree");
	return {
		...common,
		schema: G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA,
		event: "SEAL",
		decision: null,
		settlement,
	};
}

export function appendSpendLedgerEntry(
	previous: SpendLedgerEntry | null,
	input: SpendLedgerEntryInput,
): SpendLedgerEntry {
	const prior = previous === null ? null : validateSpendLedgerEntry(previous);
	if (prior?.schema === G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA)
		fail("work settlement is terminal; no further authorization is permitted");
	const entry = validateSpendLedgerEntry({
		...input,
		schema: G6_C32_SPEND_LEDGER_ENTRY_SCHEMA,
		sequence: prior === null ? 1 : prior.sequence + 1,
		previousEntryArtifactSha256:
			prior === null ? null : spendLedgerEntryArtifactSha256(prior),
		rigJournalEventArtifactSha256: input.rigJournalEventArtifactSha256 ?? null,
	});
	if (prior !== null) {
		if (
			entry.campaignId !== prior.campaignId ||
			entry.runId !== prior.runId ||
			entry.budgetPolicySha256 !== prior.budgetPolicySha256
		) {
			fail("spend ledger authority must remain constant");
		}
		if (
			Date.parse(entry.recordedAt) < Date.parse(prior.recordedAt) ||
			entry.accruedLifecycleMicrousd < prior.accruedLifecycleMicrousd ||
			entry.totalAuthorizedMicrousd < prior.totalAuthorizedMicrousd
		) {
			fail("spend ledger time and conservative totals must be monotonic");
		}
	}
	return entry;
}

export function validateSpendLedger(
	value: unknown,
	options: { requireSeal?: boolean; policy?: BudgetPolicy } = {},
): SpendLedgerSummary {
	if (!Array.isArray(value) || value.length === 0) {
		fail("spend ledger must be a non-empty array");
	}
	const policy =
		options.policy === undefined ? null : validateBudgetPolicy(options.policy);
	const policySha256 =
		policy === null ? null : budgetPolicyArtifactSha256(policy);
	const entries: SpendLedgerEntry[] = [];
	for (const [index, raw] of value.entries()) {
		const entry = validateSpendLedgerEntry(raw);
		if (
			policy &&
			(entry.campaignId !== policy.campaignId ||
				entry.runId !== policy.runId ||
				entry.budgetPolicySha256 !== policySha256)
		)
			fail("spend ledger differs from expected policy authority");
		const prior = entries.at(-1) ?? null;
		if (entry.sequence !== index + 1) {
			fail("spend ledger sequence must be contiguous");
		}
		const expectedPrevious =
			prior === null ? null : spendLedgerEntryArtifactSha256(prior);
		if (entry.previousEntryArtifactSha256 !== expectedPrevious) {
			fail("previousEntryArtifactSha256 does not match predecessor");
		}
		if (entry.schema === G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA) {
			if (
				prior === null ||
				entry.campaignId !== prior.campaignId ||
				entry.runId !== prior.runId ||
				entry.budgetPolicySha256 !== prior.budgetPolicySha256 ||
				Date.parse(entry.recordedAt) < Date.parse(prior.recordedAt)
			)
				fail(
					"work settlement lacks a monotonic predecessor with the same authority",
				);
			if (entry.totalAuthorizedMicrousd !== prior.totalAuthorizedMicrousd)
				fail(
					"work settlement must preserve authorization without increasing it",
				);
			// A final provider response can cross the funded cutoff before its
			// emergency callback is recorded. That observation is not new work:
			// preserve the earlier exact absence instead of charging until logging.
			if (
				entries.some(
					(observation) =>
						Date.parse(observation.recordedAt) >
							Date.parse(entry.settlement.verifiedAbsentAt) &&
						observation.event !== "EMERGENCY_RECONCILIATION",
				)
			)
				fail("committed absence precedes an active ledger observation");
			const paid = lifecycleCostAtTeardown({
				schema: entry.settlement.policy.schema,
				entries,
				recordedAt: entry.recordedAt,
				verifiedAbsentAt: entry.settlement.verifiedAbsentAt,
				hourlyMicrousdByRole: entry.settlement.hourlyMicrousdByRole,
			});
			if (entry.settlement.paidLifecycleMicrousd !== paid)
				fail("work settlement differs from recomputed paid liability");
		} else if (prior !== null) {
			appendSpendLedgerEntry(prior, {
				recordedAt: entry.recordedAt,
				campaignId: entry.campaignId,
				runId: entry.runId,
				budgetPolicySha256: entry.budgetPolicySha256,
				rigJournalEventArtifactSha256: entry.rigJournalEventArtifactSha256,
				event: entry.event,
				accruedLifecycleMicrousd: entry.accruedLifecycleMicrousd,
				prospectiveCellMicrousd: entry.prospectiveCellMicrousd,
				teardownReserveMicrousd: entry.teardownReserveMicrousd,
				totalAuthorizedMicrousd: entry.totalAuthorizedMicrousd,
				remainingBudgetMicrousd: entry.remainingBudgetMicrousd,
				decision: entry.decision,
			});
		}
		entries.push(entry);
	}
	const seal = entries.at(-1);
	const requireSeal = options.requireSeal ?? true;
	if (requireSeal && seal?.event !== "SEAL") {
		fail("spend ledger must end with SEAL");
	}
	if (entries.slice(0, -1).some((entry) => entry.event === "SEAL")) {
		fail("spend ledger may contain only one terminal SEAL");
	}
	if (
		policy &&
		seal?.event === "SEAL" &&
		(policy.schema === G6_C32_WORK_BUDGET_POLICY_SCHEMA) !==
			(seal.schema === G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA)
	)
		fail("spend settlement version differs from expected policy authority");
	return {
		entries,
		sealedTotalMicrousd:
			seal?.schema === G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA
				? seal.settlement.paidTotalMicrousd
				: seal?.event === "SEAL"
					? seal.totalAuthorizedMicrousd
					: null,
	};
}

/** Append, or replay, a /2 settlement using committed absence and verified prices.
 * The caller must bind those inputs to the destruction journal and price receipt.
 * No authorization ceiling is raised, including when cleanup exceeded the budget. */
export function sealWorkSpendLedger(
	input: Readonly<{
		policy: BudgetPolicy;
		entries: readonly SpendLedgerEntry[];
		recordedAt: string;
		verifiedAbsentAt: string | null;
		hourlyMicrousdByRole: WorkSpendSettlement["hourlyMicrousdByRole"];
	}>,
): WorkSpendLedgerSeal {
	const policy = validateBudgetPolicy(input.policy);
	if (policy.schema !== G6_C32_WORK_BUDGET_POLICY_SCHEMA)
		fail("work settlement requires policy/2");
	const ledger = validateSpendLedger(input.entries, {
		requireSeal: false,
		policy,
	});
	const previous = ledger.entries.at(-1);
	if (!previous) fail("work settlement requires an active ledger");
	if (
		previous.campaignId !== policy.campaignId ||
		previous.runId !== policy.runId ||
		previous.budgetPolicySha256 !== budgetPolicyArtifactSha256(policy)
	)
		fail("work settlement policy differs from active ledger authority");
	const recordedAt = requireRfc3339Millis(input.recordedAt, "seal recordedAt");
	const verifiedAbsentAt = requireRfc3339Millis(
		input.verifiedAbsentAt,
		"committed absence timestamp",
	);
	if (previous.event === "SEAL") {
		if (previous.schema !== G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA)
			fail("work ledger lacks a versioned paid settlement");
		if (
			Date.parse(recordedAt) < Date.parse(previous.recordedAt) ||
			previous.settlement.verifiedAbsentAt !== verifiedAbsentAt ||
			canonicalize(previous.settlement.hourlyMicrousdByRole) !==
				canonicalize(input.hourlyMicrousdByRole)
		)
			fail("work settlement replay changed committed authority");
		return previous;
	}
	const paidLifecycleMicrousd = lifecycleCostAtTeardown({
		schema: policy.schema,
		entries: ledger.entries,
		recordedAt,
		verifiedAbsentAt,
		hourlyMicrousdByRole: input.hourlyMicrousdByRole,
	});
	const paidTotalMicrousd = requireSafeInteger(
		policy.spentBeforeMicrousd + paidLifecycleMicrousd,
		"settled total",
	);
	const seal = validateSpendLedgerEntry({
		schema: G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA,
		sequence: previous.sequence + 1,
		recordedAt,
		campaignId: policy.campaignId,
		runId: policy.runId,
		budgetPolicySha256: previous.budgetPolicySha256,
		previousEntryArtifactSha256: spendLedgerEntryArtifactSha256(previous),
		rigJournalEventArtifactSha256: null,
		event: "SEAL",
		decision: null,
		accruedLifecycleMicrousd: paidLifecycleMicrousd,
		prospectiveCellMicrousd: 0,
		teardownReserveMicrousd: 0,
		totalAuthorizedMicrousd: previous.totalAuthorizedMicrousd,
		remainingBudgetMicrousd: Math.max(
			0,
			policy.totalBudgetMicrousd - paidTotalMicrousd,
		),
		settlement: {
			schema: G6_C32_WORK_SETTLEMENT_SCHEMA,
			policy,
			verifiedAbsentAt,
			hourlyMicrousdByRole: input.hourlyMicrousdByRole,
			paidLifecycleMicrousd,
			paidTotalMicrousd,
			overrunMicrousd: Math.max(
				0,
				paidTotalMicrousd - policy.totalBudgetMicrousd,
			),
		},
	});
	if (seal.schema !== G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA)
		fail("work settlement has an invalid version");
	validateSpendLedger([...ledger.entries, seal]);
	return seal;
}

/** A successor binds the exact prior artifact and its schema-defined sealed spend.
 * B specifically requires A's paid settlement; /1 retains its conservative total. */
export function validatePriorSpendLedger(
	policyValue: BudgetPolicy,
	value: unknown,
): SpendLedgerSummary {
	const policy = validateBudgetPolicy(policyValue);
	const prior = policy.priorLedger;
	if (!prior) fail("policy does not authorize a prior spend ledger");
	if (canonicalArtifactSha256(value) !== prior.sha256)
		fail("prior spend ledger artifact digest differs from policy");
	const ledger = validateSpendLedger(value);
	const seal = ledger.entries.at(-1);
	if (!seal) fail("prior spend ledger requires a terminal seal");
	if (
		policy.schema === G6_C32_WORK_BUDGET_POLICY_SCHEMA &&
		policy.lifecycle === "ladder-only" &&
		(seal.schema !== G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA ||
			seal.settlement.policy.lifecycle !== "attribution-only")
	)
		fail("campaign B requires A's versioned paid settlement");
	if (
		ledger.sealedTotalMicrousd !== prior.sealedSpentMicrousd ||
		ledger.sealedTotalMicrousd !== policy.spentBeforeMicrousd
	)
		fail("prior spend ledger paid seal differs from policy");
	return ledger;
}
