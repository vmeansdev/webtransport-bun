export const G6_C32_BUDGET_POLICY_SCHEMA = "g6-c32-budget-policy/1";

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
	remainingDeadlineSeconds: number;
	requiredDeadlineSeconds: number | null;
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
	const billedMinutes = ceilDiv(
		BigInt(requireSafeInteger(input.executionSeconds, "executionSeconds", 1)) +
			BigInt(
				requireSafeInteger(
					input.teardownReserveSeconds,
					"teardownReserveSeconds",
					1,
				),
			),
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
	if (remainingDeadlineSeconds < requiredDeadlineSeconds) {
		return {
			...common,
			decision: "REFUSED_DEADLINE",
			requiredDeadlineSeconds,
		};
	}
	if (totalAfter > BigInt(policy.totalBudgetMicrousd)) {
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
