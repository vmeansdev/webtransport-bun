import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	evaluateAdmission,
	type SpendLedgerEntryInput,
	spendLedgerEntryArtifactSha256,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";

function fail(message: string): never {
	throw new Error(`g6-c32-budget-cli: ${message}`);
}

function parsePairs(
	args: readonly string[],
	allowed: ReadonlySet<string>,
): Record<string, string> {
	if (args.length % 2 !== 0) fail("options must be explicit name/value pairs");
	const values: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (!option || !allowed.has(option)) {
			fail(`unknown option ${option ?? "<missing>"}`);
		}
		if (!value || value.startsWith("--")) {
			fail(`option ${option} requires an explicit value`);
		}
		if (Object.hasOwn(values, option)) fail(`option ${option} was repeated`);
		values[option] = value;
	}
	return values;
}

function required(values: Record<string, string>, option: string): string {
	const value = values[option];
	if (!value) fail(`required option ${option} is missing`);
	return value;
}

async function readJson(path: string, label: string): Promise<unknown> {
	const file = Bun.file(path);
	if (!(await file.exists())) fail(`${label} does not exist`);
	try {
		return await file.json();
	} catch {
		fail(`${label} must contain valid JSON`);
	}
}

function atomicWriteJson(path: string, value: unknown): void {
	const staging = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
	const descriptor = openSync(staging, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(staging, path);
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function requireRequestRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail("request must be an object");
	}
	const record = value as Record<string, unknown>;
	const expected = [
		"recordedAt",
		"stage",
		"accruedLifecycleMicrousd",
		"prospectiveCellMicrousd",
		"teardownReserveMicrousd",
		"elapsedLifecycleSeconds",
		"remainingDeadlineSeconds",
	].sort();
	const actual = Object.keys(record).sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		fail(`request keys must be exactly ${expected.join(",")}`);
	}
	if (
		typeof record.recordedAt !== "string" ||
		!Number.isFinite(Date.parse(record.recordedAt))
	) {
		fail("request.recordedAt must be RFC3339");
	}
	if (typeof record.stage !== "string") fail("request.stage must be a string");
	return record;
}

export async function runBudgetCli(args: readonly string[]): Promise<number> {
	const [mode, ...rest] = args;
	if (mode === "validate-policy") {
		const values = parsePairs(rest, new Set(["--policy"]));
		const policy = validateBudgetPolicy(
			await readJson(required(values, "--policy"), "policy"),
		);
		process.stdout.write(
			`${JSON.stringify({
				schema: "g6-c32-budget-policy-validation/1",
				status: "VALID",
				campaignId: policy.campaignId,
				runId: policy.runId,
				lifecycle: policy.lifecycle,
			})}\n`,
		);
		return 0;
	}
	if (
		mode === "append-intent" ||
		mode === "append-observation" ||
		mode === "seal"
	) {
		const values = parsePairs(rest, new Set(["--ledger", "--entry", "--out"]));
		const ledger = validateSpendLedger(
			await readJson(required(values, "--ledger"), "ledger"),
			{ requireSeal: false },
		);
		const previous = ledger.entries.at(-1);
		if (!previous || previous.event === "SEAL") {
			fail("ledger must be active before append");
		}
		const rawEntry = await readJson(required(values, "--entry"), "entry");
		if (
			typeof rawEntry !== "object" ||
			rawEntry === null ||
			Array.isArray(rawEntry)
		) {
			fail("entry must be an object");
		}
		const event = (rawEntry as { event?: unknown }).event;
		const permitted =
			mode === "append-intent"
				? event === "CREATE_INTENT" || event === "DESTROY_INTENT"
				: mode === "append-observation"
					? event === "CREATE_OBSERVED" || event === "DESTROY_CONFIRMED"
					: event === "SEAL";
		if (!permitted) fail(`${mode} does not permit event ${String(event)}`);
		const entry = appendSpendLedgerEntry(
			previous,
			rawEntry as SpendLedgerEntryInput,
		);
		atomicWriteJson(required(values, "--ledger"), [...ledger.entries, entry]);
		atomicWriteJson(required(values, "--out"), entry);
		return 0;
	}
	if (mode !== "admit-cell") fail(`unknown mode ${mode ?? "<missing>"}`);
	const values = parsePairs(
		rest,
		new Set(["--policy", "--request", "--ledger", "--out"]),
	);
	const policy = validateBudgetPolicy(
		await readJson(required(values, "--policy"), "policy"),
	);
	const request = requireRequestRecord(
		await readJson(required(values, "--request"), "request"),
	);
	const ledger = validateSpendLedger(
		await readJson(required(values, "--ledger"), "ledger"),
		{ requireSeal: false },
	);
	const previous = ledger.entries.at(-1);
	if (!previous || previous.event === "SEAL") {
		fail("ledger must be active before cell admission");
	}
	const policySha256 = budgetPolicyArtifactSha256(policy);
	if (
		previous.campaignId !== policy.campaignId ||
		previous.runId !== policy.runId ||
		previous.budgetPolicySha256 !== policySha256
	) {
		fail("ledger authority does not match policy");
	}
	const result = evaluateAdmission({
		policy,
		stage: request.stage as string,
		accruedLifecycleMicrousd: request.accruedLifecycleMicrousd as number,
		prospectiveCellMicrousd: request.prospectiveCellMicrousd as number,
		teardownReserveMicrousd: request.teardownReserveMicrousd as number,
		elapsedLifecycleSeconds: request.elapsedLifecycleSeconds as number,
		remainingDeadlineSeconds: request.remainingDeadlineSeconds as number,
	});
	const authorizedWithoutReserve =
		result.decision === "ADMIT"
			? policy.spentBeforeMicrousd +
				result.accruedLifecycleMicrousd +
				result.prospectiveCellMicrousd
			: previous.totalAuthorizedMicrousd;
	const entry = appendSpendLedgerEntry(previous, {
		recordedAt: request.recordedAt as string,
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
			authorizedWithoutReserve,
		),
		remainingBudgetMicrousd: result.remainingAfterMicrousd,
		decision: result.decision,
	});
	atomicWriteJson(required(values, "--ledger"), [...ledger.entries, entry]);
	atomicWriteJson(required(values, "--out"), {
		schema: "g6-c32-cell-admission/1",
		recordedAt: request.recordedAt,
		campaignId: policy.campaignId,
		runId: policy.runId,
		budgetPolicySha256: policySha256,
		ledgerEntryArtifactSha256: spendLedgerEntryArtifactSha256(entry),
		...result,
	});
	return result.decision === "ADMIT" ? 0 : 3;
}

if (import.meta.main) {
	try {
		process.exitCode = await runBudgetCli(Bun.argv.slice(2));
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
