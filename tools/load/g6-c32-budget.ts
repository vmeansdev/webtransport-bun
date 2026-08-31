import { createHash } from "node:crypto";

export const G6_C32_BUDGET_POLICY_SCHEMA = "g6-c32-budget-policy/1";
export const G6_C32_SPEND_LEDGER_ENTRY_SCHEMA = "g6-c32-spend-ledger-entry/1";

export type BudgetLifecycle = "rca-only" | "post-fix-only";

export type PriorSpendLedger = Readonly<{
	path: string;
	sha256: string;
	sealedSpentMicrousd: number;
}>;

export type BudgetPolicy = Readonly<{
	schema: typeof G6_C32_BUDGET_POLICY_SCHEMA;
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

export type SpendLedgerEntry = Readonly<{
	schema: typeof G6_C32_SPEND_LEDGER_ENTRY_SCHEMA;
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

export type SpendLedgerSummary = Readonly<{
	entries: readonly SpendLedgerEntry[];
	sealedTotalMicrousd: number | null;
}>;

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
		],
		"policy",
	);
	if (value.schema !== G6_C32_BUDGET_POLICY_SCHEMA) {
		fail(`schema must be ${G6_C32_BUDGET_POLICY_SCHEMA}`);
	}
	if (value.currency !== "USD") fail("currency must be USD");
	if (value.lifecycle !== "rca-only" && value.lifecycle !== "post-fix-only") {
		fail("lifecycle must be rca-only or post-fix-only");
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
	if (value.lifecycle === "rca-only") {
		if (spentBeforeMicrousd !== 0 || priorLedger !== null) {
			fail("rca-only policy must have zero prior spend and no priorLedger");
		}
	} else if (
		priorLedger === null ||
		priorLedger.sealedSpentMicrousd !== spentBeforeMicrousd
	) {
		fail("post-fix-only priorLedger must bind spentBeforeMicrousd");
	}
	if (
		BigInt(spentBeforeMicrousd) + BigInt(maximumLifecycleCostMicrousd) >
		BigInt(totalBudgetMicrousd)
	) {
		fail(
			"spentBeforeMicrousd plus maximum lifecycle cost exceeds total budget",
		);
	}
	return {
		schema: G6_C32_BUDGET_POLICY_SCHEMA,
		campaignId: requireIdentifier(value.campaignId, "campaignId"),
		runId: requireIdentifier(value.runId, "runId"),
		currency: "USD",
		lifecycle: value.lifecycle,
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
	if (
		remainingDeadlineSeconds < requiredDeadlineSeconds ||
		elapsedLifecycleSeconds + requiredDeadlineSeconds >
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
	SpendLedgerEntry,
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
		],
		"spend ledger entry",
	);
	if (value.schema !== G6_C32_SPEND_LEDGER_ENTRY_SCHEMA) {
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
	return {
		schema: G6_C32_SPEND_LEDGER_ENTRY_SCHEMA,
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
}

export function appendSpendLedgerEntry(
	previous: SpendLedgerEntry | null,
	input: SpendLedgerEntryInput,
): SpendLedgerEntry {
	const prior = previous === null ? null : validateSpendLedgerEntry(previous);
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
	options: { requireSeal?: boolean } = {},
): SpendLedgerSummary {
	if (!Array.isArray(value) || value.length === 0) {
		fail("spend ledger must be a non-empty array");
	}
	const entries: SpendLedgerEntry[] = [];
	for (const [index, raw] of value.entries()) {
		const entry = validateSpendLedgerEntry(raw);
		const prior = entries.at(-1) ?? null;
		if (entry.sequence !== index + 1) {
			fail("spend ledger sequence must be contiguous");
		}
		const expectedPrevious =
			prior === null ? null : spendLedgerEntryArtifactSha256(prior);
		if (entry.previousEntryArtifactSha256 !== expectedPrevious) {
			fail("previousEntryArtifactSha256 does not match predecessor");
		}
		if (prior !== null) {
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
	return {
		entries,
		sealedTotalMicrousd:
			seal?.event === "SEAL" ? seal.totalAuthorizedMicrousd : null,
	};
}
