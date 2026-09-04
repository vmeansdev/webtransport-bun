import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	canonicalArtifactSha256,
	validateArtifactManifestRecord,
	validateReviewReceipt,
} from "./g6-c32-freeze-model.ts";
import {
	spendLedgerEntryArtifactSha256,
	validateSpendLedger,
	validateSpendLedgerEntry,
} from "./g6-c32-budget.ts";
import {
	evaluateSessionScale,
	evaluateSuccessorRung,
} from "./g6-c32-rca-evaluate.ts";

export const G6_CAPACITY_GOAL_CONTRACT_SCHEMA = "g6-capacity-goal-contract/1";
export const G6_CAPACITY_GOAL_EVALUATION_SCHEMA =
	"g6-capacity-goal-evaluation/1";
export const G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA =
	"g6-capacity-execution-receipt/1";

type EvaluationStatus = "PASS" | "MISS" | "INCOMPLETE";
type LiveTargetStatus = "PASS" | "MISS" | "UNPROVEN";

type JsonRecord = Record<string, unknown>;

type LocalReceiptKind =
	| "candidate-local-native"
	| "candidate-local-linux"
	| "harness-lifecycle"
	| "bounded-overload";

type PendingAdapterName =
	| "diagnostics"
	| "waiterSafety"
	| "sameHostA"
	| "finalTeardown";

type PendingAdapterSchema =
	| "g6-capacity-diagnostic-coverage/1"
	| "g6-capacity-waiter-safety/1"
	| "g6-capacity-same-host-audit/1"
	| "g6-capacity-final-teardown/1";

type LocalReceiptCommand = Readonly<{
	argv: readonly string[];
	exitCode: number;
	passed?: number;
	failed?: number;
	skipped?: number;
	todo?: number;
	durationMs?: number;
	stdoutPath?: string;
	stderrPath?: string;
	signal?: string | null;
}>;

export type CapacityExecutionReceipt = Readonly<{
	schema: typeof G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA;
	kind: LocalReceiptKind;
	sourceSha: string;
	phase: string;
	commands: readonly LocalReceiptCommand[];
	liveEvidence: boolean;
	note: string;
	executionSessionId?: string;
	platform?: string;
	linuxCoverage?: string;
}>;

type ContractPathBinding = Readonly<{
	label: string;
	receiptKind: LocalReceiptKind;
	path: string;
}>;

type PendingAdapterBinding = Readonly<{
	schema: PendingAdapterSchema;
	path: string;
}>;

type LadderRunBinding = Readonly<{
	label: string;
	rung: number;
	rcaPath: string;
	gradePath: string;
}>;

export type CapacityGoalContract = Readonly<{
	schema: typeof G6_CAPACITY_GOAL_CONTRACT_SCHEMA;
	objective: Readonly<{
		slug: "g6-40k-capacity-closure";
		sourceSha: string;
		planSha256: string;
		specSha256: string;
		evidenceRoot: string;
		targetSessions: 40_000;
		ceilingProbeSessions: 50_000;
		aggregateBudgetMicrousd: number;
		sealedPriorSpendMicrousd: number;
		headroomMicrousd: number;
	}>;
	approvals: Readonly<{
		semanticFreezeAuthoritySha256: string | null;
		architectPath: string;
		criticPath: string;
	}>;
	localVerification: Readonly<{
		receipts: readonly ContractPathBinding[];
	}>;
	pendingAdapters?: Readonly<
		Partial<Record<PendingAdapterName, PendingAdapterBinding>>
	>;
	ladder: Readonly<{
		runs: readonly LadderRunBinding[];
		companionRoot: string;
	}>;
	finalAudit: Readonly<{
		spendLedgerPath: string;
		sealReceiptPath: string;
		artifactManifestPath: string;
	}>;
}>;

export type CapacityGoalEvaluation = Readonly<{
	schema: typeof G6_CAPACITY_GOAL_EVALUATION_SCHEMA;
	status: EvaluationStatus;
	liveTargetStatus: LiveTargetStatus;
	exitCode: 0 | 1 | 2;
	sourceSha: string | null;
	reasons: string[];
}>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
	throw new Error(message);
}

function requireExactKeys(
	value: JsonRecord,
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

function requireOptionalKeysOnly(
	value: JsonRecord,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	const allowed = new Set([...required, ...optional]);
	const actual = Object.keys(value).sort();
	const requiredSet = new Set(required);
	if (actual.some((key) => !allowed.has(key))) {
		fail(`${label} contains unsupported keys`);
	}
	if ([...requiredSet].some((key) => !actual.includes(key))) {
		fail(`${label} is missing required keys`);
	}
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${label} must be a non-empty string`);
	}
	return value;
}

function requireSha1(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
		fail(`${label} must be a lowercase SHA-1 digest`);
	}
	return value;
}

function requireSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		fail(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function requireNullableSha256(value: unknown, label: string): string | null {
	return value === null ? null : requireSha256(value, label);
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

function requireRelativePath(value: unknown, label: string): string {
	const text = requireString(value, label);
	if (
		text.startsWith("/") ||
		text
			.split(/[\\/]+/)
			.some(
				(segment) =>
					segment.length === 0 || segment === "." || segment === "..",
			)
	) {
		fail(`${label} must be a portable relative path`);
	}
	return text;
}

function pathWithin(base: string, target: string): boolean {
	const delta = relative(base, target);
	return delta === "" || (!delta.startsWith("..") && delta !== "..");
}

function checkedStat(path: string, label: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		fail(code === "ENOENT" ? `${label} is missing` : `${label} is unreadable`);
	}
}

function assertNoSymlinkDescendants(
	base: string,
	target: string,
	label: string,
): void {
	const delta = relative(base, target);
	const segments = delta.split(sep).filter(Boolean);
	let current = base;
	for (const segment of segments) {
		current = join(current, segment);
		const stat = checkedStat(current, label);
		if (stat.isSymbolicLink()) fail(`${label} must not traverse symlinks`);
	}
}

function resolveCliFile(path: string, label: string): string {
	const absolute = resolve(path);
	const stat = checkedStat(absolute, label);
	if (!stat.isFile() || stat.isSymbolicLink())
		fail(`${label} must be a regular file`);
	return realpathSync.native(absolute);
}

function resolveCliDirectory(path: string, label: string): string {
	const absolute = resolve(path);
	const stat = checkedStat(absolute, label);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		fail(`${label} must be a directory`);
	return realpathSync.native(absolute);
}

function resolveRepoFile(
	repoRoot: string,
	relPath: string,
	label: string,
): string {
	const absolute = resolve(repoRoot, requireRelativePath(relPath, label));
	if (!pathWithin(repoRoot, absolute))
		fail(`${label} escapes the repository root`);
	assertNoSymlinkDescendants(repoRoot, absolute, label);
	const stat = checkedStat(absolute, label);
	if (!stat.isFile() || stat.isSymbolicLink())
		fail(`${label} must be a regular file`);
	return realpathSync.native(absolute);
}

function resolveRepoDirectory(
	repoRoot: string,
	relPath: string,
	label: string,
): string {
	const absolute = resolve(repoRoot, requireRelativePath(relPath, label));
	if (!pathWithin(repoRoot, absolute))
		fail(`${label} escapes the repository root`);
	assertNoSymlinkDescendants(repoRoot, absolute, label);
	const stat = checkedStat(absolute, label);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		fail(`${label} must be a directory`);
	return realpathSync.native(absolute);
}

function resolveEvidenceFile(
	evidenceRoot: string,
	relPath: string,
	label: string,
): string {
	const absolute = resolve(evidenceRoot, requireRelativePath(relPath, label));
	if (!pathWithin(evidenceRoot, absolute))
		fail(`${label} escapes the evidence root`);
	assertNoSymlinkDescendants(evidenceRoot, absolute, label);
	const stat = checkedStat(absolute, label);
	if (!stat.isFile() || stat.isSymbolicLink())
		fail(`${label} must be a regular file`);
	return realpathSync.native(absolute);
}

function resolveEvidenceDirectory(
	evidenceRoot: string,
	relPath: string,
	label: string,
): string {
	const absolute = resolve(evidenceRoot, requireRelativePath(relPath, label));
	if (!pathWithin(evidenceRoot, absolute))
		fail(`${label} escapes the evidence root`);
	assertNoSymlinkDescendants(evidenceRoot, absolute, label);
	const stat = checkedStat(absolute, label);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		fail(`${label} must be a directory`);
	return realpathSync.native(absolute);
}

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonFileSafe(path: string, label: string): unknown {
	try {
		return readJsonFile(path);
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${label} is malformed`);
		fail(`${label} is unreadable`);
	}
}

function validateExecutionCommand(
	value: unknown,
	label: string,
): LocalReceiptCommand {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireOptionalKeysOnly(
		value,
		["argv", "exitCode"],
		[
			"passed",
			"failed",
			"skipped",
			"todo",
			"durationMs",
			"stdoutPath",
			"stderrPath",
			"signal",
		],
		label,
	);
	if (
		!Array.isArray(value.argv) ||
		value.argv.length === 0 ||
		value.argv.some((entry) => typeof entry !== "string" || entry.length === 0)
	) {
		fail(`${label}.argv must be a non-empty string array`);
	}
	const exitCode = requireSafeInteger(value.exitCode, `${label}.exitCode`);
	const command: {
		argv: string[];
		exitCode: number;
		passed?: number;
		failed?: number;
		skipped?: number;
		todo?: number;
		durationMs?: number;
		stdoutPath?: string;
		stderrPath?: string;
		signal?: string | null;
	} = {
		argv: value.argv as string[],
		exitCode,
	};
	for (const key of [
		"passed",
		"failed",
		"skipped",
		"todo",
		"durationMs",
	] as const) {
		if (value[key] !== undefined) {
			command[key] = requireSafeInteger(value[key], `${label}.${key}`);
		}
	}
	for (const key of ["stdoutPath", "stderrPath"] as const) {
		if (value[key] !== undefined) {
			command[key] = requireString(value[key], `${label}.${key}`);
		}
	}
	if (value.signal !== undefined) {
		if (value.signal !== null && typeof value.signal !== "string") {
			fail(`${label}.signal must be a string or null`);
		}
		command.signal = value.signal as string | null;
	}
	return command;
}

export function validateExecutionReceipt(
	value: unknown,
): CapacityExecutionReceipt {
	if (!isRecord(value)) fail("execution receipt must be an object");
	requireOptionalKeysOnly(
		value,
		[
			"schema",
			"kind",
			"sourceSha",
			"phase",
			"commands",
			"liveEvidence",
			"note",
		],
		["executionSessionId", "platform", "linuxCoverage"],
		"execution receipt",
	);
	if (value.schema !== G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA) {
		fail(
			`execution receipt schema must be ${G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA}`,
		);
	}
	const kind = requireString(value.kind, "execution receipt.kind");
	if (
		kind !== "candidate-local-native" &&
		kind !== "candidate-local-linux" &&
		kind !== "harness-lifecycle" &&
		kind !== "bounded-overload"
	) {
		fail("execution receipt.kind is invalid");
	}
	if (!Array.isArray(value.commands) || value.commands.length === 0) {
		fail("execution receipt.commands must be a non-empty array");
	}
	if (typeof value.liveEvidence !== "boolean") {
		fail("execution receipt.liveEvidence must be a boolean");
	}
	const receipt: {
		schema: typeof G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA;
		kind: LocalReceiptKind;
		sourceSha: string;
		phase: string;
		commands: readonly LocalReceiptCommand[];
		liveEvidence: boolean;
		note: string;
		executionSessionId?: string;
		platform?: string;
		linuxCoverage?: string;
	} = {
		schema: G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA,
		kind,
		sourceSha: requireSha1(value.sourceSha, "execution receipt.sourceSha"),
		phase: requireString(value.phase, "execution receipt.phase"),
		commands: value.commands.map((command, index) =>
			validateExecutionCommand(command, `execution receipt.commands[${index}]`),
		),
		liveEvidence: value.liveEvidence,
		note: requireString(value.note, "execution receipt.note"),
	};
	if (value.executionSessionId !== undefined) {
		receipt.executionSessionId = requireString(
			value.executionSessionId,
			"execution receipt.executionSessionId",
		);
	}
	if (value.platform !== undefined) {
		receipt.platform = requireString(
			value.platform,
			"execution receipt.platform",
		);
	}
	if (value.linuxCoverage !== undefined) {
		receipt.linuxCoverage = requireString(
			value.linuxCoverage,
			"execution receipt.linuxCoverage",
		);
	}
	return receipt;
}

function validateContractPathBinding(
	value: unknown,
	label: string,
): ContractPathBinding {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(value, ["label", "receiptKind", "path"], label);
	const entry = {
		label: requireString(value.label, `${label}.label`),
		receiptKind: requireString(value.receiptKind, `${label}.receiptKind`),
		path: requireRelativePath(value.path, `${label}.path`),
	};
	if (entry.label !== entry.receiptKind)
		fail(`${label} label must equal receiptKind`);
	if (
		entry.receiptKind !== "candidate-local-native" &&
		entry.receiptKind !== "candidate-local-linux" &&
		entry.receiptKind !== "harness-lifecycle" &&
		entry.receiptKind !== "bounded-overload"
	) {
		fail(`${label}.receiptKind is invalid`);
	}
	return entry as ContractPathBinding;
}

function validatePendingAdapterBinding(
	value: unknown,
	label: string,
	expectedSchema: PendingAdapterSchema,
): PendingAdapterBinding {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(value, ["schema", "path"], label);
	const schema = requireString(value.schema, `${label}.schema`);
	if (schema !== expectedSchema) fail(`${label}.schema is invalid`);
	return {
		schema,
		path: requireRelativePath(value.path, `${label}.path`),
	};
}

function validateLadderRun(value: unknown, label: string): LadderRunBinding {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(value, ["label", "rung", "rcaPath", "gradePath"], label);
	return {
		label: requireString(value.label, `${label}.label`),
		rung: requireSafeInteger(value.rung, `${label}.rung`, 1),
		rcaPath: requireRelativePath(value.rcaPath, `${label}.rcaPath`),
		gradePath: requireRelativePath(value.gradePath, `${label}.gradePath`),
	};
}

export function validateCapacityGoalContract(
	value: unknown,
): CapacityGoalContract {
	if (!isRecord(value)) fail("contract must be an object");
	requireOptionalKeysOnly(
		value,
		[
			"schema",
			"objective",
			"approvals",
			"localVerification",
			"ladder",
			"finalAudit",
		],
		["pendingAdapters"],
		"contract",
	);
	if (value.schema !== G6_CAPACITY_GOAL_CONTRACT_SCHEMA) {
		fail(`contract schema must be ${G6_CAPACITY_GOAL_CONTRACT_SCHEMA}`);
	}
	const objective = value.objective;
	const approvals = value.approvals;
	const localVerification = value.localVerification;
	const ladder = value.ladder;
	const finalAudit = value.finalAudit;
	if (!isRecord(objective)) fail("contract.objective must be an object");
	requireExactKeys(
		objective,
		[
			"slug",
			"sourceSha",
			"planSha256",
			"specSha256",
			"evidenceRoot",
			"targetSessions",
			"ceilingProbeSessions",
			"aggregateBudgetMicrousd",
			"sealedPriorSpendMicrousd",
			"headroomMicrousd",
		],
		"contract.objective",
	);
	if (objective.slug !== "g6-40k-capacity-closure") {
		fail("contract.objective.slug is invalid");
	}
	const targetSessions = requireSafeInteger(
		objective.targetSessions,
		"contract.objective.targetSessions",
		1,
	);
	const ceilingProbeSessions = requireSafeInteger(
		objective.ceilingProbeSessions,
		"contract.objective.ceilingProbeSessions",
		1,
	);
	if (targetSessions !== 40_000 || ceilingProbeSessions !== 50_000) {
		fail("contract objective sessions are invalid");
	}
	const aggregateBudgetMicrousd = requireSafeInteger(
		objective.aggregateBudgetMicrousd,
		"contract.objective.aggregateBudgetMicrousd",
	);
	const sealedPriorSpendMicrousd = requireSafeInteger(
		objective.sealedPriorSpendMicrousd,
		"contract.objective.sealedPriorSpendMicrousd",
	);
	const headroomMicrousd = requireSafeInteger(
		objective.headroomMicrousd,
		"contract.objective.headroomMicrousd",
	);
	if (sealedPriorSpendMicrousd + headroomMicrousd > aggregateBudgetMicrousd) {
		fail("contract budget headroom exceeds aggregate budget");
	}
	if (!isRecord(approvals)) fail("contract.approvals must be an object");
	requireExactKeys(
		approvals,
		["semanticFreezeAuthoritySha256", "architectPath", "criticPath"],
		"contract.approvals",
	);
	if (!isRecord(localVerification)) {
		fail("contract.localVerification must be an object");
	}
	requireExactKeys(
		localVerification,
		["receipts"],
		"contract.localVerification",
	);
	if (
		!Array.isArray(localVerification.receipts) ||
		localVerification.receipts.length !== 4
	) {
		fail("contract.localVerification.receipts must contain four receipts");
	}
	if (!isRecord(ladder)) fail("contract.ladder must be an object");
	requireExactKeys(ladder, ["runs", "companionRoot"], "contract.ladder");
	if (!Array.isArray(ladder.runs) || ladder.runs.length < 4) {
		fail("contract.ladder.runs must be a non-empty array");
	}
	if (!isRecord(finalAudit)) fail("contract.finalAudit must be an object");
	requireExactKeys(
		finalAudit,
		["spendLedgerPath", "sealReceiptPath", "artifactManifestPath"],
		"contract.finalAudit",
	);
	const parsed: {
		schema: typeof G6_CAPACITY_GOAL_CONTRACT_SCHEMA;
		objective: CapacityGoalContract["objective"];
		approvals: CapacityGoalContract["approvals"];
		localVerification: CapacityGoalContract["localVerification"];
		pendingAdapters?: CapacityGoalContract["pendingAdapters"];
		ladder: CapacityGoalContract["ladder"];
		finalAudit: CapacityGoalContract["finalAudit"];
	} = {
		schema: G6_CAPACITY_GOAL_CONTRACT_SCHEMA,
		objective: {
			slug: "g6-40k-capacity-closure",
			sourceSha: requireSha1(
				objective.sourceSha,
				"contract.objective.sourceSha",
			),
			planSha256: requireSha256(
				objective.planSha256,
				"contract.objective.planSha256",
			),
			specSha256: requireSha256(
				objective.specSha256,
				"contract.objective.specSha256",
			),
			evidenceRoot: requireRelativePath(
				objective.evidenceRoot,
				"contract.objective.evidenceRoot",
			),
			targetSessions: 40_000,
			ceilingProbeSessions: 50_000,
			aggregateBudgetMicrousd,
			sealedPriorSpendMicrousd,
			headroomMicrousd,
		},
		approvals: {
			semanticFreezeAuthoritySha256: requireNullableSha256(
				approvals.semanticFreezeAuthoritySha256,
				"contract.approvals.semanticFreezeAuthoritySha256",
			),
			architectPath: requireRelativePath(
				approvals.architectPath,
				"contract.approvals.architectPath",
			),
			criticPath: requireRelativePath(
				approvals.criticPath,
				"contract.approvals.criticPath",
			),
		},
		localVerification: {
			receipts: localVerification.receipts.map((entry, index) =>
				validateContractPathBinding(
					entry,
					`contract.localVerification.receipts[${index}]`,
				),
			),
		},
		ladder: {
			runs: ladder.runs.map((entry, index) =>
				validateLadderRun(entry, `contract.ladder.runs[${index}]`),
			),
			companionRoot: requireRelativePath(
				ladder.companionRoot,
				"contract.ladder.companionRoot",
			),
		},
		finalAudit: {
			spendLedgerPath: requireRelativePath(
				finalAudit.spendLedgerPath,
				"contract.finalAudit.spendLedgerPath",
			),
			sealReceiptPath: requireRelativePath(
				finalAudit.sealReceiptPath,
				"contract.finalAudit.sealReceiptPath",
			),
			artifactManifestPath: requireRelativePath(
				finalAudit.artifactManifestPath,
				"contract.finalAudit.artifactManifestPath",
			),
		},
	};
	const receiptKinds = new Set(
		parsed.localVerification.receipts.map(({ receiptKind }) => receiptKind),
	);
	if (receiptKinds.size !== 4)
		fail("contract.localVerification receipts must be unique");
	for (const required of [
		"candidate-local-native",
		"candidate-local-linux",
		"harness-lifecycle",
		"bounded-overload",
	] as const) {
		if (!receiptKinds.has(required)) {
			fail(`contract.localVerification is missing ${required}`);
		}
	}
	const rungLabels = new Set(parsed.ladder.runs.map(({ label }) => label));
	if (rungLabels.size !== parsed.ladder.runs.length)
		fail("contract.ladder labels must be unique");
	if (value.pendingAdapters !== undefined) {
		if (!isRecord(value.pendingAdapters))
			fail("contract.pendingAdapters must be an object");
		const pending = value.pendingAdapters;
		requireOptionalKeysOnly(
			pending,
			[],
			["diagnostics", "waiterSafety", "sameHostA", "finalTeardown"],
			"contract.pendingAdapters",
		);
		parsed.pendingAdapters = {
			...(pending.diagnostics === undefined
				? {}
				: {
						diagnostics: validatePendingAdapterBinding(
							pending.diagnostics,
							"contract.pendingAdapters.diagnostics",
							"g6-capacity-diagnostic-coverage/1",
						),
					}),
			...(pending.waiterSafety === undefined
				? {}
				: {
						waiterSafety: validatePendingAdapterBinding(
							pending.waiterSafety,
							"contract.pendingAdapters.waiterSafety",
							"g6-capacity-waiter-safety/1",
						),
					}),
			...(pending.sameHostA === undefined
				? {}
				: {
						sameHostA: validatePendingAdapterBinding(
							pending.sameHostA,
							"contract.pendingAdapters.sameHostA",
							"g6-capacity-same-host-audit/1",
						),
					}),
			...(pending.finalTeardown === undefined
				? {}
				: {
						finalTeardown: validatePendingAdapterBinding(
							pending.finalTeardown,
							"contract.pendingAdapters.finalTeardown",
							"g6-capacity-final-teardown/1",
						),
					}),
		};
	}
	return parsed;
}

function evaluateApprovals(
	repoRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
): void {
	if (contract.approvals.semanticFreezeAuthoritySha256 === null) {
		reasons.push("approval semantic freeze authority digest is unbound");
	}
	try {
		const architectPath = resolveRepoFile(
			repoRoot,
			contract.approvals.architectPath,
			"architect receipt",
		);
		const criticPath = resolveRepoFile(
			repoRoot,
			contract.approvals.criticPath,
			"critic receipt",
		);
		const architect = validateReviewReceipt(
			readJsonFileSafe(architectPath, "architect receipt"),
		);
		const critic = validateReviewReceipt(
			readJsonFileSafe(criticPath, "critic receipt"),
		);
		if (
			contract.approvals.semanticFreezeAuthoritySha256 !== null &&
			architect.authority.semanticFreezeAuthoritySha256 !==
				contract.approvals.semanticFreezeAuthoritySha256
		) {
			reasons.push(
				"architect review receipt semantic freeze digest differs from contract",
			);
		}
		if (
			contract.approvals.semanticFreezeAuthoritySha256 !== null &&
			critic.authority.semanticFreezeAuthoritySha256 !==
				contract.approvals.semanticFreezeAuthoritySha256
		) {
			reasons.push(
				"critic review receipt semantic freeze digest differs from contract",
			);
		}
		const architectArtifactSha = canonicalArtifactSha256(architect);
		if (
			critic.authority.afterArchitectReceiptArtifactSha256 !==
			architectArtifactSha
		) {
			reasons.push(
				"critic review receipt does not bind the architect receipt artifact",
			);
		}
	} catch {
		reasons.push("approval receipts are malformed");
	}
}

function evaluateLocalVerification(
	repoRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
): void {
	for (const entry of contract.localVerification.receipts) {
		try {
			const path = resolveRepoFile(
				repoRoot,
				entry.path,
				`local receipt ${entry.label}`,
			);
			const receipt = validateExecutionReceipt(
				readJsonFileSafe(path, `local receipt ${entry.label}`),
			);
			if (receipt.kind !== entry.receiptKind) {
				reasons.push(`local receipt ${entry.label} kind differs from contract`);
				continue;
			}
			if (receipt.sourceSha !== contract.objective.sourceSha) {
				reasons.push(
					`local receipt ${entry.label} sourceSha differs from contract sourceSha`,
				);
			}
			if (receipt.commands.some((command) => command.exitCode !== 0)) {
				reasons.push(
					`local receipt ${entry.label} contains a non-zero command exit`,
				);
			}
		} catch {
			reasons.push(`local receipt ${entry.label} is malformed`);
		}
	}
}

function evaluatePendingAdapters(
	evidenceRoot: string,
	contract: CapacityGoalContract,
	fatalReasons: string[],
	pendingReasons: string[],
): void {
	if (!contract.pendingAdapters) return;
	for (const [name, binding] of Object.entries(contract.pendingAdapters)) {
		if (!binding) continue;
		try {
			const path = resolveEvidenceFile(
				evidenceRoot,
				binding.path,
				`pending adapter ${name}`,
			);
			const value = readJsonFileSafe(path, `pending adapter ${name}`);
			if (!isRecord(value) || value.schema !== binding.schema) {
				fatalReasons.push(`pending adapter ${name} is malformed`);
				continue;
			}
			pendingReasons.push(
				`future adapter ${binding.schema} is not yet supported`,
			);
		} catch {
			fatalReasons.push(`pending adapter ${name} is malformed`);
		}
	}
}

function findRun(
	runs: ReadonlyMap<string, LadderRunBinding>,
	label: string,
): LadderRunBinding | null {
	return runs.get(label) ?? null;
}

function rungDecision(
	evidenceRoot: string,
	run: LadderRunBinding,
	expectedRung: number,
	reasons: string[],
): ReturnType<typeof evaluateSuccessorRung> | null {
	if (run.rung !== expectedRung) {
		reasons.push(
			`required rung receipt ${run.label} has unexpected rung ${run.rung}`,
		);
		return null;
	}
	try {
		const rcaPath = resolveEvidenceFile(
			evidenceRoot,
			run.rcaPath,
			`${run.label} RCA`,
		);
		const gradePath = resolveEvidenceFile(
			evidenceRoot,
			run.gradePath,
			`${run.label} grade`,
		);
		return evaluateSuccessorRung({
			label: run.label,
			rung: run.rung,
			rca: readJsonFileSafe(rcaPath, `${run.label} RCA`),
			grade: readJsonFileSafe(gradePath, `${run.label} grade`),
		});
	} catch {
		reasons.push(`required rung receipt ${run.label} is malformed`);
		return null;
	}
}

function requireRung(
	evidenceRoot: string,
	runs: ReadonlyMap<string, LadderRunBinding>,
	label: string,
	rung: number,
	reasons: string[],
): ReturnType<typeof evaluateSuccessorRung> | null {
	const run = findRun(runs, label);
	if (!run) {
		reasons.push(`missing required rung receipt ${label}`);
		return null;
	}
	return rungDecision(evidenceRoot, run, rung, reasons);
}

function evaluateCompanions(
	evidenceRoot: string,
	companionRoot: string,
	reasons: string[],
): { complete: boolean; pass: boolean } {
	try {
		const companionAbs = resolveEvidenceDirectory(
			evidenceRoot,
			companionRoot,
			"companion root",
		);
		const summary = evaluateSessionScale(companionAbs);
		reasons.push(...summary.reasons);
		return {
			complete: summary.status !== "INCOMPLETE",
			pass: summary.status === "SESSION_SCALE_PASS",
		};
	} catch {
		reasons.push("companion root is malformed");
		return { complete: false, pass: false };
	}
}

function evaluateLadder(
	evidenceRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
): {
	goalStatus: EvaluationStatus;
	liveTargetStatus: LiveTargetStatus;
} {
	const runs = new Map(
		contract.ladder.runs.map((entry) => [entry.label, entry]),
	);
	for (const [label, rung] of [
		["L5000-1", 5_000],
		["L10000-1", 10_000],
		["L20000-1", 20_000],
		["L30000-1", 30_000],
	] as const) {
		const decision = requireRung(evidenceRoot, runs, label, rung, reasons);
		if (!decision)
			return { goalStatus: "INCOMPLETE", liveTargetStatus: "UNPROVEN" };
		if (decision.status !== "CLEAN") {
			reasons.push(`${label} is not clean`);
			return { goalStatus: "INCOMPLETE", liveTargetStatus: "UNPROVEN" };
		}
	}
	const first40 = requireRung(evidenceRoot, runs, "L40000-1", 40_000, reasons);
	if (!first40)
		return { goalStatus: "INCOMPLETE", liveTargetStatus: "UNPROVEN" };
	if (first40.status === "INCOMPLETE") {
		return { goalStatus: "INCOMPLETE", liveTargetStatus: "UNPROVEN" };
	}
	if (first40.status === "UNCLEAN") {
		return { goalStatus: "MISS", liveTargetStatus: "MISS" };
	}
	const second40 = requireRung(evidenceRoot, runs, "L40000-2", 40_000, reasons);
	if (!second40)
		return { goalStatus: "INCOMPLETE", liveTargetStatus: "UNPROVEN" };
	if (second40.status === "INCOMPLETE") {
		return { goalStatus: "INCOMPLETE", liveTargetStatus: "UNPROVEN" };
	}
	if (second40.status === "UNCLEAN") {
		return { goalStatus: "MISS", liveTargetStatus: "MISS" };
	}

	const first50 = requireRung(evidenceRoot, runs, "L50000-1", 50_000, reasons);
	if (!first50) return { goalStatus: "INCOMPLETE", liveTargetStatus: "PASS" };
	if (first50.status === "INCOMPLETE") {
		return { goalStatus: "INCOMPLETE", liveTargetStatus: "PASS" };
	}
	if (first50.status === "UNCLEAN") {
		const companions = evaluateCompanions(
			evidenceRoot,
			contract.ladder.companionRoot,
			reasons,
		);
		return companions.complete
			? { goalStatus: "PASS", liveTargetStatus: "PASS" }
			: { goalStatus: "INCOMPLETE", liveTargetStatus: "PASS" };
	}

	const second50 = requireRung(evidenceRoot, runs, "L50000-2", 50_000, reasons);
	if (!second50) return { goalStatus: "INCOMPLETE", liveTargetStatus: "PASS" };
	if (second50.status === "INCOMPLETE") {
		return { goalStatus: "INCOMPLETE", liveTargetStatus: "PASS" };
	}
	if (second50.status === "UNCLEAN") {
		const companions = evaluateCompanions(
			evidenceRoot,
			contract.ladder.companionRoot,
			reasons,
		);
		return companions.complete
			? { goalStatus: "PASS", liveTargetStatus: "PASS" }
			: { goalStatus: "INCOMPLETE", liveTargetStatus: "PASS" };
	}
	reasons.push("missing first measured ceiling miss above replicated 40k");
	return { goalStatus: "INCOMPLETE", liveTargetStatus: "PASS" };
}

function evaluateFinalAudit(
	evidenceRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
): void {
	try {
		const spendLedgerPath = resolveEvidenceFile(
			evidenceRoot,
			contract.finalAudit.spendLedgerPath,
			"spend ledger",
		);
		const sealReceiptPath = resolveEvidenceFile(
			evidenceRoot,
			contract.finalAudit.sealReceiptPath,
			"seal receipt",
		);
		const artifactManifestPath = resolveEvidenceFile(
			evidenceRoot,
			contract.finalAudit.artifactManifestPath,
			"artifact manifest",
		);
		const spend = validateSpendLedger(
			readJsonFileSafe(spendLedgerPath, "spend ledger"),
		);
		const seal = validateSpendLedgerEntry(
			readJsonFileSafe(sealReceiptPath, "seal receipt"),
		);
		const last = spend.entries.at(-1);
		if (
			!last ||
			spendLedgerEntryArtifactSha256(last) !==
				spendLedgerEntryArtifactSha256(seal)
		) {
			reasons.push(
				"seal receipt does not match the terminal spend ledger entry",
			);
		}
		const sealedTotal = spend.sealedTotalMicrousd;
		if (sealedTotal === null) {
			reasons.push("spend ledger is missing a terminal seal");
		} else {
			const cumulativeAuthorized =
				sealedTotal <= contract.objective.headroomMicrousd
					? contract.objective.sealedPriorSpendMicrousd + sealedTotal
					: sealedTotal;
			const campaignDelta =
				cumulativeAuthorized - contract.objective.sealedPriorSpendMicrousd;
			if (
				!Number.isSafeInteger(cumulativeAuthorized) ||
				!Number.isSafeInteger(campaignDelta) ||
				campaignDelta < 0
			) {
				reasons.push("sealed spend is inconsistent with contract prior spend");
			}
			if (cumulativeAuthorized > contract.objective.aggregateBudgetMicrousd) {
				reasons.push("sealed spend exceeds the aggregate campaign budget");
			}
			if (campaignDelta > contract.objective.headroomMicrousd) {
				reasons.push("sealed spend exceeds the contract headroom");
			}
			const expectedRemaining =
				contract.objective.aggregateBudgetMicrousd - cumulativeAuthorized;
			if (seal.remainingBudgetMicrousd !== expectedRemaining) {
				reasons.push(
					"seal receipt remainingBudgetMicrousd disagrees with the contract budget",
				);
			}
		}
		const manifest = validateArtifactManifestRecord(
			readJsonFileSafe(artifactManifestPath, "artifact manifest"),
		);
		for (const entry of manifest.entries) {
			const path = resolveEvidenceFile(
				evidenceRoot,
				entry.path,
				`artifact manifest entry ${entry.path}`,
			);
			const bytes = readFileSync(path);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			if (sha256 !== entry.sha256) {
				reasons.push(`artifact manifest entry ${entry.path} hash mismatch`);
			}
			if (bytes.byteLength !== entry.bytes) {
				reasons.push(
					`artifact manifest entry ${entry.path} byte length mismatch`,
				);
			}
		}
	} catch {
		reasons.push("spend ledger is malformed");
	}
}

function uniq(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function parseArg(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (!value) fail(`${name} is required`);
	return value;
}

export function evaluateCapacityGoal(input: {
	repoRoot: string;
	evidenceRoot: string;
	contractPath: string;
}): CapacityGoalEvaluation {
	const fatalReasons: string[] = [];
	const pendingReasons: string[] = [];
	let contract: CapacityGoalContract;
	let evidenceRoot = "";
	try {
		const repoRoot = resolveCliDirectory(input.repoRoot, "repository root");
		const contractPath = resolveCliFile(input.contractPath, "contract");
		contract = validateCapacityGoalContract(
			readJsonFileSafe(contractPath, "contract"),
		);
		evidenceRoot = resolveCliDirectory(input.evidenceRoot, "evidence root");
		const contractEvidenceRoot = resolveRepoDirectory(
			repoRoot,
			contract.objective.evidenceRoot,
			"contract evidence root",
		);
		if (contractEvidenceRoot !== evidenceRoot) {
			fail("contract evidenceRoot differs from CLI evidence root");
		}
	} catch {
		return {
			schema: G6_CAPACITY_GOAL_EVALUATION_SCHEMA,
			status: "INCOMPLETE",
			liveTargetStatus: "UNPROVEN",
			exitCode: 2,
			sourceSha: null,
			reasons: ["contract is malformed"],
		};
	}

	try {
		const repoRoot = resolveCliDirectory(input.repoRoot, "repository root");
		const expectedEvidenceRoot = resolveRepoDirectory(
			repoRoot,
			contract.objective.evidenceRoot,
			"contract evidence root",
		);
		if (expectedEvidenceRoot !== evidenceRoot) {
			fatalReasons.push("contract evidenceRoot differs from CLI evidence root");
		}
		evaluateApprovals(repoRoot, contract, fatalReasons);
		evaluateLocalVerification(repoRoot, contract, fatalReasons);
		evaluateFinalAudit(evidenceRoot, contract, fatalReasons);
		evaluatePendingAdapters(
			evidenceRoot,
			contract,
			fatalReasons,
			pendingReasons,
		);
		const ladder = evaluateLadder(evidenceRoot, contract, fatalReasons);
		const status =
			fatalReasons.length === 0 &&
			pendingReasons.length === 0 &&
			ladder.goalStatus === "PASS"
				? "PASS"
				: ladder.goalStatus === "MISS"
					? "MISS"
					: "INCOMPLETE";
		const exitCode =
			fatalReasons.length > 0
				? 2
				: status === "PASS"
					? 0
					: status === "MISS"
						? 1
						: 2;
		return {
			schema: G6_CAPACITY_GOAL_EVALUATION_SCHEMA,
			status,
			liveTargetStatus: ladder.liveTargetStatus,
			exitCode,
			sourceSha: contract.objective.sourceSha,
			reasons: uniq([...fatalReasons, ...pendingReasons]),
		};
	} catch {
		return {
			schema: G6_CAPACITY_GOAL_EVALUATION_SCHEMA,
			status: "INCOMPLETE",
			liveTargetStatus: "UNPROVEN",
			exitCode: 2,
			sourceSha: contract.objective.sourceSha,
			reasons: ["contract is malformed"],
		};
	}
}

if (import.meta.main) {
	const decision = evaluateCapacityGoal({
		repoRoot: process.cwd(),
		evidenceRoot: parseArg("--evidence-root"),
		contractPath: parseArg("--contract"),
	});
	process.stdout.write(`${JSON.stringify(decision)}\n`);
	process.exit(decision.exitCode);
}
