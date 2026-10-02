import { createHash } from "node:crypto";
import {
	type CapacityR5LadderBinding,
	evaluateCapacityGoalAdapters,
} from "./g6-capacity-goal-adapters.ts";
import { assertNativeProofOutput } from "./g6-capacity-proof-catalog.ts";
import {
	validateClientPorts,
	validateRawLifecycle,
	validateRawNumbers,
	validateScanCommand,
} from "./g6-capacity-raw-work.ts";

export {
	validateClientPorts,
	validateRawLifecycle,
	validateRawNumbers,
	validateScanCommand,
} from "./g6-capacity-raw-work.ts";

import {
	type CapacityExecutionReceipt,
	capacityLocalProofArgv,
	G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA,
	type LocalReceiptCommand,
	type LocalReceiptKind,
} from "./g6-capacity-proof-catalog.ts";

export {
	CAPACITY_HARNESS_PROOF_FILES,
	CAPACITY_LINUX_PROOF_TESTS,
	CAPACITY_NATIVE_PROOF_TESTS,
	type CapacityExecutionReceipt,
	capacityLocalProofArgv,
	G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA,
	type LocalReceiptKind,
} from "./g6-capacity-proof-catalog.ts";

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	spendLedgerEntryArtifactSha256,
	validateSpendLedger,
	validateSpendLedgerEntry,
} from "./g6-c32-budget.ts";
import {
	canonicalArtifactSha256,
	validateArtifactManifestRecord,
	validateOperationReceipt,
	validateReviewReceipt,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import {
	type HostIdentityPacket,
	validateHostIdentityPacket,
} from "./g6-c32-host.ts";
import {
	evaluateCell,
	evaluateSessionScaleCell,
} from "./g6-c32-rca-evaluate.ts";
import {
	gradeSuccessorRung,
	type SuccessorGradeRequest,
} from "./g6-c32-successor-grade.ts";
import { assertGeneratorDatagramDriver } from "./g6-datagram-driver.ts";
import type { ParsedLinuxProbeJsonl } from "./g6-sharded-diagnostic.ts";
import { G6_SHARDED_VALIDITY, steeredTotal } from "./g6-sharded-grade.ts";

// /2 replaces stored verdict paths with sealed raw inputs and ordered operations.
export const G6_CAPACITY_GOAL_CONTRACT_SCHEMA = "g6-capacity-goal-contract/2";
export const G6_CAPACITY_GOAL_EVALUATION_SCHEMA =
	"g6-capacity-goal-evaluation/1";

type EvaluationStatus = "PASS" | "MISS" | "INCOMPLETE";
type LiveTargetStatus = "PASS" | "MISS" | "UNPROVEN";

type JsonRecord = Record<string, unknown>;

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

type ContractPathBinding = Readonly<{
	label: string;
	receiptKind: LocalReceiptKind;
	path: string;
}>;

type PendingAdapterBinding = Readonly<{
	schema: PendingAdapterSchema;
	path: string;
}>;

type RawRunPaths = Readonly<{
	label: string;
	scanPath: string;
	diagnosticPath: string;
	postRunSteeringPath: string;
	identityPath: string;
	operationReceiptPath: string;
	probePath: string;
}>;

type LadderRunBinding = RawRunPaths & Readonly<{ rung: number }>;

type CompanionRunBinding = RawRunPaths &
	Readonly<{
		label: "C1" | "C2";
		requestedSessions: number;
		activeWorkloadSessions: number;
	}>;

/** r5 ladders add the wtransport datagram read path; it is never defaulted. */
type LadderProfile = Readonly<
	Required<SuccessorGradeRequest["profile"]> & { datagramPump?: "pump" }
>;

const FIXED_PROFILE = {
	shards: 24,
	endpoints: 128,
	connectConcurrency: 50,
	connectRatePerSec: 250,
	fixedSourcePortBase: 20_000,
	ackReflector: "native",
	serverWorkers: 3,
	serverGro: "off",
	serverRecvRuntime: "shared",
	ackCadence: "default",
	serverUdpSendBufferBytes: 0,
	serverUdpSendEagainMode: "wait",
	reflectRingBypass: "off",
	pacerPps: 0,
} as const;

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
		runId: string;
		runs: readonly LadderRunBinding[];
		registrationSha256: string;
		probeProducerSha256: string;
		pairIdentityPath: string;
		profile: LadderProfile;
		companions?: readonly CompanionRunBinding[];
		companionRoot?: string;
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
	/** r5 only: the reviewed, recompute-equal A' decision binding B. */
	r5?: CapacityR5LadderBinding & {
		/** Evaluator-recorded E2 disposition: probe-off B makes no mechanism claim. */
		claims: readonly string[];
	};
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
			"stdoutSha256",
			"stderrSha256",
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
		stdoutSha256?: string;
		stderrSha256?: string;
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
	for (const key of [
		"stdoutPath",
		"stderrPath",
		"stdoutSha256",
		"stderrSha256",
	] as const) {
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
	requireExactKeys(value, ["rung", ...RAW_PATH_KEYS], label);
	return {
		...validateRawRunPaths(value, label),
		rung: requireSafeInteger(value.rung, `${label}.rung`, 1),
	};
}

const RAW_PATH_KEYS = [
	"label",
	"scanPath",
	"diagnosticPath",
	"postRunSteeringPath",
	"identityPath",
	"operationReceiptPath",
	"probePath",
] as const;

function validateRawRunPaths(value: JsonRecord, label: string): RawRunPaths {
	return {
		label: requireString(value.label, `${label}.label`),
		scanPath: requireRelativePath(value.scanPath, `${label}.scanPath`),
		diagnosticPath: requireRelativePath(
			value.diagnosticPath,
			`${label}.diagnosticPath`,
		),
		postRunSteeringPath: requireRelativePath(
			value.postRunSteeringPath,
			`${label}.postRunSteeringPath`,
		),
		identityPath: requireRelativePath(
			value.identityPath,
			`${label}.identityPath`,
		),
		operationReceiptPath: requireRelativePath(
			value.operationReceiptPath,
			`${label}.operationReceiptPath`,
		),
		probePath: requireRelativePath(value.probePath, `${label}.probePath`),
	};
}

function validateCompanionRun(
	value: unknown,
	label: string,
): CompanionRunBinding {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(
		value,
		["requestedSessions", "activeWorkloadSessions", ...RAW_PATH_KEYS],
		label,
	);
	const paths = validateRawRunPaths(value, label);
	if (paths.label !== "C1" && paths.label !== "C2")
		fail(`${label} is not C1 or C2`);
	return {
		...paths,
		label: paths.label,
		requestedSessions: requireSafeInteger(
			value.requestedSessions,
			`${label}.requestedSessions`,
			1,
		),
		activeWorkloadSessions: requireSafeInteger(
			value.activeWorkloadSessions,
			`${label}.activeWorkloadSessions`,
			1,
		),
	};
}

function validateLadderProfile(value: unknown): LadderProfile {
	if (!isRecord(value)) fail("contract.ladder.profile must be an object");
	requireExactKeys(
		value,
		[
			...Object.keys(FIXED_PROFILE),
			"udpSendBatch",
			...(Object.hasOwn(value, "datagramPump") ? ["datagramPump"] : []),
		],
		"contract.ladder.profile",
	);
	if (Object.hasOwn(value, "datagramPump") && value.datagramPump !== "pump")
		fail("contract.ladder.profile.datagramPump must be the pump candidate");
	for (const [field, expected] of Object.entries(FIXED_PROFILE)) {
		if (value[field] !== expected)
			fail(
				`contract.ladder.profile.${field} differs from approved fixed profile`,
			);
	}
	if (value.udpSendBatch !== 0 && value.udpSendBatch !== 64)
		fail(
			"contract.ladder.profile.udpSendBatch is not an approved candidate mode",
		);
	return {
		...FIXED_PROFILE,
		udpSendBatch: value.udpSendBatch,
		...(value.datagramPump === "pump" ? { datagramPump: "pump" as const } : {}),
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
	requireOptionalKeysOnly(
		ladder,
		[
			"runId",
			"registrationSha256",
			"probeProducerSha256",
			"pairIdentityPath",
			"profile",
			"runs",
		],
		["companions", "companionRoot"],
		"contract.ladder",
	);
	if (!Array.isArray(ladder.runs)) {
		fail("contract.ladder.runs must be an array");
	}
	if (ladder.companions !== undefined && !Array.isArray(ladder.companions))
		fail("contract.ladder.companions must be an array");
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
			runId: requireString(ladder.runId, "contract.ladder.runId"),
			registrationSha256: requireSha256(
				ladder.registrationSha256,
				"contract.ladder.registrationSha256",
			),
			probeProducerSha256: requireSha256(
				ladder.probeProducerSha256,
				"contract.ladder.probeProducerSha256",
			),
			pairIdentityPath: requireRelativePath(
				ladder.pairIdentityPath,
				"contract.ladder.pairIdentityPath",
			),
			profile: validateLadderProfile(ladder.profile),
			runs: ladder.runs.map((entry, index) =>
				validateLadderRun(entry, `contract.ladder.runs[${index}]`),
			),
			...(Array.isArray(ladder.companions)
				? {
						companions: ladder.companions.map((entry, index) =>
							validateCompanionRun(
								entry,
								`contract.ladder.companions[${index}]`,
							),
						),
					}
				: {}),
			...(ladder.companionRoot === undefined
				? {}
				: {
						companionRoot: requireRelativePath(
							ladder.companionRoot,
							"contract.ladder.companionRoot",
						),
					}),
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
	evidenceRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
	verified: ReadonlyMap<string, string>,
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
		for (const path of [architectPath, criticPath])
			evidenceReader(
				evidenceRoot,
				verified,
			)(relative(evidenceRoot, path).split(sep).join("/"));
		const architect = validateReviewReceipt(
			readJsonFileSafe(architectPath, "architect receipt"),
		);
		const critic = validateReviewReceipt(
			readJsonFileSafe(criticPath, "critic receipt"),
		);
		if (
			architect.authority.role !== "architect" ||
			critic.authority.role !== "critic"
		)
			reasons.push("approval receipt roles must be Architect then Critic");
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
	evidenceRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
	verified: ReadonlyMap<string, string>,
): void {
	const read = evidenceReader(evidenceRoot, verified);
	const retained = (path: string): string =>
		read(
			relative(
				evidenceRoot,
				resolveRepoFile(repoRoot, path, "local proof artifact"),
			)
				.split(sep)
				.join("/"),
		);
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
			retained(entry.path);
			if (receipt.commands.some((command) => command.exitCode !== 0)) {
				reasons.push(
					`local receipt ${entry.label} contains a non-zero command exit`,
				);
			}
			const expectedCommands = capacityLocalProofArgv(receipt.kind);
			if (
				receipt.commands.some(
					(command) =>
						!command.stdoutPath ||
						!command.stderrPath ||
						!command.stdoutSha256 ||
						!command.stderrSha256,
				)
			)
				reasons.push(
					`local receipt ${entry.label} lacks hash-bound test output`,
				);
			if (receipt.commands.length !== expectedCommands.length)
				fail(
					"local proof lacks the required suite, platform and source commands",
				);
			let commandIndex = 0;
			for (const command of receipt.commands) {
				if (
					!command.stdoutPath ||
					!command.stderrPath ||
					!command.stdoutSha256 ||
					!command.stderrSha256
				) {
					reasons.push(
						`local receipt ${entry.label} lacks hash-bound test output`,
					);
					continue;
				}
				const expected = expectedCommands[commandIndex++];
				if (!expected) fail("local proof command exceeds the required catalog");
				const argv = [
					command.argv[0]?.split("/").at(-1),
					...command.argv.slice(1),
				];
				if (JSON.stringify(argv) !== JSON.stringify(expected))
					fail("local proof command differs from the frozen category catalog");
				const outputs = [
					[command.stdoutPath, command.stdoutSha256],
					[command.stderrPath, command.stderrSha256],
				] as const;
				const outputText = outputs.map(([path, digest]) => {
					const bytes = Buffer.from(retained(path));
					if (
						createHash("sha256").update(bytes).digest("hex") !==
						requireSha256(digest, "test output digest")
					)
						fail("test output digest mismatch");
					return bytes.toString("utf8");
				});
				const stdout = outputText[0] ?? "",
					stderr = outputText[1] ?? "";
				const prepared =
					receipt.kind === "candidate-local-linux" &&
					receipt.phase === "PREPARED_HOST";
				const markers = [
					...stderr.matchAll(
						/^g6-prepared-boot-id=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/gm,
					),
				];
				if (
					prepared &&
					(markers.length !== 1 || stdout.includes("g6-prepared-boot-id="))
				)
					fail("prepared proof lacks its unique boot witness");
				// This only parses the control marker. The mandatory waiter adapter
				// independently replays its exact boot, command and source origin.
				const text = outputText
					.join("\n")
					// biome-ignore lint/suspicious/noControlCharactersInRegex: strip only ANSI SGR escapes from retained runner output.
					.replace(/\x1b\[[0-9;]*m/g, "");
				const runner = command.argv[0]?.split("/").at(-1);
				if (command.signal || command.exitCode !== 0)
					fail("local proof command failed or was interrupted");
				if (
					(runner === "uname" || runner === "git") &&
					stderr.trim() !== (prepared ? markers[0]?.[0] : "")
				)
					fail("unexpected local identity stderr");
				if (runner === "uname") {
					const platform = stdout.trim();
					if (
						!["Linux", "Darwin"].includes(platform) ||
						receipt.platform !== platform ||
						(receipt.kind === "candidate-local-linux" && platform !== "Linux")
					)
						fail(
							"local proof platform lacks matching native execution evidence",
						);
					continue;
				}
				if (runner === "git") {
					if (stdout.trim() !== contract.objective.sourceSha)
						fail("retained source command differs from candidate SHA");
					continue;
				}
				let passed = 0;
				let failed = 0;
				if (runner === "cargo" && command.argv[1] === "test") {
					({ passed, failed } = assertNativeProofOutput(
						text,
						receipt.kind === "candidate-local-linux",
					));
				} else if (runner === "bun" && command.argv[1] === "test") {
					if (
						/^\s*[1-9]\d* (?:skip|todo)\s*$/m.test(text) ||
						/^\((?:skip|todo)\)/m.test(text)
					)
						fail("required Bun proof contains skipped tests");
					for (const file of expected.slice(2)) {
						const section = text
							.split(`${file}:\n`)[1]
							?.split(/\n[^\n]+\.test\.[cm]?[jt]s:\n/)[0];
						if (!section || !/^\(pass\) /m.test(section))
							fail(`required harness file did not execute: ${file}`);
					}
					const pass = text.match(/^\s*(\d+) pass\s*$/m);
					const failure = text.match(/^\s*(\d+) fail\s*$/m);
					if (pass && failure) {
						passed = Number(pass[1]);
						failed = Number(failure[1]);
					}
				} else {
					fail("unsupported local proof command");
				}
				if (
					!Number.isSafeInteger(passed) ||
					passed < 1 ||
					failed !== 0 ||
					(command.passed !== undefined && command.passed !== passed) ||
					(command.failed !== undefined && command.failed !== failed) ||
					command.signal
				)
					fail("retained test output does not prove a passing run");
			}
		} catch {
			reasons.push(`local receipt ${entry.label} is malformed`);
		}
	}
}

type EvidenceReader = (path: string) => string;
type OperationOrder = {
	sequence: number;
	finishedAt: number;
	starts: Set<string>;
};

function evidenceReader(
	evidenceRoot: string,
	verified: ReadonlyMap<string, string>,
): EvidenceReader {
	return (path) => {
		const bytes = readFileSync(resolveEvidenceFile(evidenceRoot, path, path));
		if (
			verified.get(path) !== createHash("sha256").update(bytes).digest("hex")
		) {
			fail(`${path} is not hash-verified by the final manifest`);
		}
		return bytes.toString("utf8");
	};
}

function requireRecord(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) fail(`${label} must be an object`);
	return value;
}

export type RawPairIdentity = Record<
	"server" | "generator",
	HostIdentityPacket
>;

function pairIdentity(
	value: unknown,
	contract: CapacityGoalContract,
): RawPairIdentity {
	const identity = requireRecord(value, "pair identity");
	if (
		identity.schema !== "g6-capacity-pair-identity/1" ||
		!isRecord(identity.server) ||
		!isRecord(identity.generator)
	)
		fail("raw role identity packets are required");
	requireExactKeys(
		identity,
		["schema", "server", "generator"],
		"pair identity",
	);
	const pair = {
		server: validateHostIdentityPacket(identity.server),
		generator: validateHostIdentityPacket(identity.generator),
	};
	for (const role of ["server", "generator"] as const) {
		const host = pair[role];
		if (host.source.commit !== contract.objective.sourceSha)
			fail(`${role}.sourceSha differs from candidate`);
		if (
			host.provider.role !== role ||
			host.envelope.runId !== contract.ladder.runId
		)
			fail(`${role} identity belongs to another role or run`);
		if (
			host.provider.region !== "lon1" ||
			host.provider.size !== "c-48" ||
			host.provider.vcpus !== 48 ||
			host.provider.memoryMiB !== 98_304 ||
			host.runtime.os !== "Linux"
		)
			fail(`${role} identity differs from the approved host shape`);
		if (
			host.binary.kind !== (role === "server" ? "native-addon" : "mmo-client")
		)
			fail(`${role} identity binary kind differs from its role`);
	}
	const { server, generator } = pair;
	if (
		server.provider.id === generator.provider.id ||
		server.provider.publicIpv4 === generator.provider.publicIpv4 ||
		server.provider.privateIpv4 === generator.provider.privateIpv4 ||
		server.bootId === generator.bootId ||
		server.provider.vpcUuid !== generator.provider.vpcUuid ||
		server.source.tree !== generator.source.tree
	)
		fail("identity is not an exact two-host pair");
	return pair;
}

function loadRawRun(
	read: EvidenceReader,
	run: RawRunPaths,
	contract: CapacityGoalContract,
	exactPair: RawPairIdentity,
	order: OperationOrder,
	sessions: number,
	active: number,
	workNodeId = run.label,
	probeRequired = true,
) {
	const scan = requireRecord(
		JSON.parse(read(run.scanPath)),
		`${run.label} scan`,
	);
	const diagnostic = requireRecord(
		JSON.parse(read(run.diagnosticPath)),
		`${run.label} diagnostic`,
	);
	const identity = pairIdentity(JSON.parse(read(run.identityPath)), contract);
	for (const role of ["server", "generator"] as const) {
		for (const field of [
			"bootId",
			"provider",
			"source",
			"binary",
			"runtime",
		] as const) {
			if (
				canonicalArtifactSha256(identity[role][field]) !==
				canonicalArtifactSha256(exactPair[role][field])
			)
				fail(`${role}.${field} differs from exact pair`);
		}
	}
	const operation = validateOperationReceipt(
		JSON.parse(read(run.operationReceiptPath)),
	);
	// Work nodes have immutable IDs; companion display labels are only C1/C2.
	// Legacy producers keep their original display-label operation identities.
	const operationLabel =
		operation.action.command === "work_scan" ? workNodeId : run.label;
	// Work receipts retain paths relative to their immutable campaign work root.
	// Infer that root only from the exact receipt suffix; never rebase arbitrary paths.
	let operationRoot = "";
	if (operation.action.command === "work_scan") {
		const suffix = `work/${operationLabel}/scan.receipt.json`;
		if (
			(run.operationReceiptPath !== suffix &&
				!run.operationReceiptPath.endsWith(`/${suffix}`)) ||
			operation.stdoutPath !== `work/${operationLabel}/scan.stdout` ||
			operation.stderrPath !== `work/${operationLabel}/scan.stderr`
		)
			fail(
				"work scan receipt and output paths do not share the exact cell root",
			);
		operationRoot = run.operationReceiptPath.slice(0, -suffix.length);
	}
	if (
		operation.envelope.runId !== contract.ladder.runId ||
		operation.envelope.operationId !== `${operationLabel}-scan` ||
		operation.attempt !== 1 ||
		operation.status.outcome !== "SUCCEEDED" ||
		operation.status.exitCode !== 0 ||
		operation.status.signal !== null
	)
		fail("scan operation does not bind this successful first-attempt cell");
	if (
		operation.envelope.sequence <= order.sequence ||
		Date.parse(operation.startedAt) < order.finishedAt
	)
		fail("operation order is invalid");
	if (BigInt(operation.durationMonotonicNs) < 120_000_000_000n)
		fail("scan operation does not cover the full steady duration");
	const startedAt = validateRfc3339Millis(scan.startedAt, "scan.startedAt");
	if (
		Date.parse(startedAt) < Date.parse(operation.startedAt) ||
		Date.parse(startedAt) > Date.parse(operation.finishedAt) ||
		diagnostic.startedAt !== startedAt ||
		order.starts.has(startedAt)
	)
		fail("scan/diagnostic start identity is missing, mixed or reused");
	validateScanCommand(
		operation,
		read(`${operationRoot}${operation.stdoutPath}`),
		contract,
		exactPair,
		sessions,
		active,
		startedAt,
		probeRequired,
	);
	read(`${operationRoot}${operation.stderrPath}`);
	order.sequence = operation.envelope.sequence;
	order.finishedAt = Date.parse(operation.finishedAt);
	order.starts.add(startedAt);
	if (
		scan.schema !== "g6-sharded-scan/3" ||
		diagnostic.schema !== "g6-sharded-diagnostic/3"
	)
		fail("raw scan/diagnostic schemas are unsupported");
	const config = requireRecord(scan.config, "scan.config");
	const dispatch = requireRecord(diagnostic.dispatch, "diagnostic.dispatch");
	for (const [field, expected] of Object.entries({
		...contract.ladder.profile,
		sessions,
		activeWorkloadSessions: active,
		paced: false,
		emitterMode: "native-mirror",
	})) {
		// The producer records an unpaced request as null, 0, or the env string 0.
		const observed =
			field === "pacerPps" && (config[field] === null || config[field] === "0")
				? 0
				: config[field];
		if (observed !== expected)
			fail(`scan ${field} differs from registered profile`);
		if (field !== "pacerPps" && dispatch[field] !== expected)
			fail(`diagnostic ${field} differs from registered profile`);
	}
	if (config.steadySeconds !== 120)
		fail("scan steadySeconds differs from registered profile");
	const marker = "mmo-client: json ";
	const lines = requireString(scan.clientStdout, "scan.clientStdout")
		.split(/\r?\n/)
		.filter((line) => line.startsWith(marker));
	const line = lines[0];
	if (lines.length !== 1 || !line)
		fail("client report is missing or ambiguous");
	const report = requireRecord(
		JSON.parse(line.slice(marker.length)),
		"client report",
	);
	if (report.startedAt !== startedAt)
		fail("client startedAt differs from this scan identity");
	if (
		report.schema !== "mmo-client/2" ||
		report.activeWorkloadSessions !== active ||
		report.sessionsRequested !== sessions
	)
		fail(
			"client schema/requested/active workload differs from registered cell",
		);
	if (
		requireRecord(report.preRegistration, "client preRegistration").sha256 !==
		contract.ladder.registrationSha256
	)
		fail("client registration differs from contract");
	for (const field of ["connectConcurrency", "connectRatePerSec"] as const) {
		if (report[field] !== contract.ladder.profile[field])
			fail(`client ${field} differs from registered profile`);
	}
	if (
		requireRecord(report.config, "client config").fixedSourcePortBase !==
		contract.ladder.profile.fixedSourcePortBase
	)
		fail("client fixedSourcePortBase differs from registered profile");
	validateClientPorts(report, contract.ladder.profile);
	const datagramPump = contract.ladder.profile.datagramPump;
	if (datagramPump !== undefined) {
		// Both roles must prove the registered datagram read path carried traffic.
		assertGeneratorDatagramDriver(report, datagramPump);
		const spawned = requireRecord(
			requireRecord(
				requireRecord(scan.aggregate, "scan aggregate").lifetime,
				"scan lifetime aggregate",
			).metrics,
			"scan lifetime metrics",
		).datagramPumpsSpawned;
		if (
			typeof spawned !== "number" ||
			!Number.isSafeInteger(spawned) ||
			spawned < 1
		)
			fail("server datagram pump counters contradict the registered profile");
	}
	validateRawNumbers(scan, report);
	validateRawLifecycle(
		diagnostic,
		scan,
		operation,
		contract.ladder.profile.shards,
	);
	const postRunSteeringText = read(run.postRunSteeringPath);
	const rawSteered = steeredTotal(postRunSteeringText);
	const postRun = requireRecord(
		diagnostic.postRunSteering,
		"diagnostic post-run steering",
	);
	if (
		typeof postRun.capturedAtMs !== "number" ||
		!Number.isFinite(postRun.capturedAtMs) ||
		postRun.capturedAtMs < Date.parse(operation.startedAt) ||
		postRun.capturedAtMs > Date.parse(operation.finishedAt) ||
		typeof rawSteered !== "number" ||
		requireRecord(postRun.steerStatsSum, "diagnostic steering counters")
			.steered !== rawSteered
	)
		fail("diagnostic post-run steering differs from raw witness");
	// E2 probe-off B retains no detailed probe; never read a stale artifact.
	const probe = probeRequired ? read(run.probePath) : "";
	return {
		scan: scan as unknown as SuccessorGradeRequest["scan"],
		diagnostic,
		postRunSteeringText,
		probe,
		operation,
	};
}

function validateProbeEvidence(
	probe: ParsedLinuxProbeJsonl | undefined,
	contract: CapacityGoalContract,
	raw: ReturnType<typeof loadRawRun>,
): void {
	if (!probe)
		fail("rated cell requires raw phase-aware Linux probe /2 evidence");
	if (probe.producerSha256 !== contract.ladder.probeProducerSha256)
		fail("probe producer differs from contract");
	// The shared parser already validated these wall timestamps. Read just the
	// header, then enclose the whole artifact in this nonoverlapping operation.
	const header = requireRecord(
		JSON.parse(raw.probe.slice(0, raw.probe.indexOf("\n"))),
		"probe header",
	);
	const probeStart = Date.parse(
		requireString(header.startedAt, "probe startedAt"),
	);
	const probeEnd = Date.parse(
		requireString(probe.summary.endedAt, "probe endedAt"),
	);
	if (
		probeStart < Date.parse(raw.operation.startedAt) ||
		probeEnd > Date.parse(raw.operation.finishedAt)
	)
		fail("probe wall timestamps are outside the ordered scan operation");
	const start = BigInt(probe.phaseBoundaries.steady.monotonicNs);
	const end = BigInt(probe.phaseBoundaries.drain.monotonicNs);
	const spanMs = Number(end - start) / 1_000_000;
	if (
		Math.abs(spanMs - G6_SHARDED_VALIDITY.steadySeconds * 1000) >
		G6_SHARDED_VALIDITY.steadyWallMsTolerance
	)
		fail("probe steady phase does not cover the rated 120-second window");
	for (const kind of ["queue", "sched"] as const) {
		const extent = probe.phaseSampleExtents.steady[kind];
		const cadenceNs =
			BigInt(
				requireSafeInteger(
					probe.summary[`${kind}CadenceMs`],
					`probe ${kind} cadence`,
					1,
				),
			) * 1_000_000n;
		if (
			extent.firstNs === null ||
			extent.lastNs === null ||
			BigInt(extent.firstNs) - start > cadenceNs ||
			end - BigInt(extent.lastNs) > cadenceNs
		)
			fail(`probe ${kind} samples do not span the rated steady window`);
	}
}

function rungDecision(
	read: EvidenceReader,
	run: LadderRunBinding,
	contract: CapacityGoalContract,
	pair: RawPairIdentity,
	order: OperationOrder,
	reasons: string[],
	probeRequired = true,
): "CLEAN" | "UNCLEAN" | "INCOMPLETE" {
	try {
		const raw = loadRawRun(
			read,
			run,
			contract,
			pair,
			order,
			run.rung,
			run.rung,
			run.label,
			probeRequired,
		);
		const profile = contract.ladder.profile;
		const grade = gradeSuccessorRung({
			rung: run.rung,
			scan: raw.scan,
			postRunSteeringText: raw.postRunSteeringText,
			expectCandidate: contract.objective.sourceSha,
			registrationSha256: contract.ladder.registrationSha256,
			profile,
		});
		const rca = evaluateCell({
			cell: run.label,
			gradeMode: "rca-only",
			expectedShards: profile.shards,
			qualityRequest: {
				rung: run.rung,
				scan: raw.scan,
				postRunSteeringText: raw.postRunSteeringText,
				expectCandidate: contract.objective.sourceSha,
				registrationSha256: contract.ladder.registrationSha256,
				expectedEndpoints: profile.endpoints,
				expectedConnectConcurrency: profile.connectConcurrency,
				expectedConnectRate: profile.connectRatePerSec,
				expectedFixedSourcePortBase: profile.fixedSourcePortBase,
				expectedAckReflector: profile.ackReflector,
				expectedServerWorkers: profile.serverWorkers,
				expectedServerGro: profile.serverGro,
				expectedServerRecvRuntime: profile.serverRecvRuntime,
				expectedAckCadence: profile.ackCadence,
				expectedServerUdpSendBufferBytes: profile.serverUdpSendBufferBytes,
				expectedServerUdpSendEagainMode: profile.serverUdpSendEagainMode,
				expectedReflectRingBypass: profile.reflectRingBypass,
				expectedPacerPps: profile.pacerPps,
				expectedUdpSendBatch: profile.udpSendBatch,
			},
			diagnostic: raw.diagnostic,
			probe: probeRequired ? raw.probe : null,
			probeRequired,
		});
		if (probeRequired)
			validateProbeEvidence(rca.probePhaseEvidence, contract, raw);
		const invalid = [...grade.invalidReasons, ...rca.reasons];
		if (!Number.isFinite(rca.connectWallSec) || rca.connectWallSec <= 0)
			invalid.push("connect wall time must be positive");
		if (
			Object.values(grade.clauses).some(
				(clause) => !Number.isFinite(clause.value),
			)
		)
			invalid.push("non-finite clause value");
		if (!grade.valid || !rca.complete || invalid.length > 0) {
			reasons.push(...invalid.map((reason) => `${run.label}: ${reason}`));
			return "INCOMPLETE";
		}
		return rca.functionalPass && rca.ingressCleanPass && grade.gate === "PASS"
			? "CLEAN"
			: "UNCLEAN";
	} catch (error) {
		reasons.push(
			`${run.label}: ${error instanceof Error ? error.message : "raw evidence is malformed"}`,
		);
		return "INCOMPLETE";
	}
}

function evaluateCompanions(
	read: EvidenceReader,
	contract: CapacityGoalContract,
	pair: RawPairIdentity,
	order: OperationOrder,
	requested: number,
	active: number,
	reasons: string[],
	probeRequired = true,
): boolean {
	const companions = contract.ladder.companions ?? [];
	if (contract.ladder.companionRoot && companions.length === 0) {
		reasons.push(
			"raw companion bindings are required; summary-only companionRoot is unsupported",
		);
		return false;
	}
	if (
		companions.length !== 2 ||
		companions[0]?.label !== "C1" ||
		companions[1]?.label !== "C2"
	) {
		reasons.push("both ordered raw companion cells C1 and C2 are required");
		return false;
	}
	let complete = true;
	for (const run of companions) {
		try {
			if (
				run.requestedSessions !== requested ||
				run.activeWorkloadSessions !== active
			)
				fail(
					"companion workload differs from first MISS and replicated clean rung",
				);
			const raw = loadRawRun(
				read,
				run,
				contract,
				pair,
				order,
				requested,
				active,
				`C${requested}-${run.label.slice(1)}`,
				probeRequired,
			);
			const result = evaluateSessionScaleCell({
				label: run.label,
				scan: raw.scan,
				diagnostic: raw.diagnostic,
				probe: probeRequired ? raw.probe : null,
				probeRequired,
				expectCandidate: contract.objective.sourceSha,
				expectedShards: contract.ladder.profile.shards,
				expectedRequestedSessions: requested,
				expectedActiveWorkloadSessions: active,
			});
			if (probeRequired)
				validateProbeEvidence(result.probePhaseEvidence, contract, raw);
			if (
				!result.complete ||
				![result.ingestRatio, result.deliveryRatio, result.dutyRatio].every(
					Number.isFinite,
				)
			)
				fail(result.reasons.join("; ") || "companion evidence is incomplete");
			// A measured companion MISS completes this branch; PASS is not required.
		} catch (error) {
			complete = false;
			reasons.push(
				`${run.label}: ${error instanceof Error ? error.message : "raw evidence is malformed"}`,
			);
		}
	}
	return complete;
}

function evaluateLadder(
	evidenceRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
	verified: ReadonlyMap<string, string>,
	probeRequired = true,
): {
	goalStatus: EvaluationStatus;
	liveTargetStatus: LiveTargetStatus;
} {
	let liveTargetStatus: LiveTargetStatus = "UNPROVEN";
	const incomplete = () => ({
		goalStatus: "INCOMPLETE" as const,
		liveTargetStatus,
	});
	const read = evidenceReader(evidenceRoot, verified);
	let pair: RawPairIdentity;
	try {
		pair = pairIdentity(
			JSON.parse(read(contract.ladder.pairIdentityPath)),
			contract,
		);
	} catch (error) {
		reasons.push(
			`exact pair: ${error instanceof Error ? error.message : "malformed"}`,
		);
		return incomplete();
	}
	const order: OperationOrder = {
		sequence: 0,
		finishedAt: 0,
		starts: new Set(),
	};
	const expected = [
		5_000, 10_000, 20_000, 30_000, 40_000, 40_000, 50_000, 50_000,
	];
	const runs = contract.ladder.runs;
	for (let index = 0; index < expected.length; index++) {
		const rung = expected[index];
		if (!rung) fail("internal ladder catalog is missing a rung");
		const label = `L${rung}-${expected[index - 1] === rung ? 2 : 1}`;
		const run = runs[index];
		if (!run) {
			reasons.push(`missing required rung receipt ${label}`);
			return incomplete();
		}
		if (run.label !== label || run.rung !== rung) {
			reasons.push("contract ladder run order is invalid");
			return incomplete();
		}
		const status = rungDecision(
			read,
			run,
			contract,
			pair,
			order,
			reasons,
			probeRequired,
		);
		if (status === "INCOMPLETE") return incomplete();
		if (status === "UNCLEAN") {
			if (rung <= 40_000) liveTargetStatus = "MISS";
			let consumed = index + 1;
			const lower = expected
				.slice(0, index)
				.filter((value) => value < rung)
				.at(-1);
			if (lower === undefined) {
				if (
					runs.length !== consumed ||
					(contract.ladder.companions?.length ?? 0) !== 0
				) {
					reasons.push("full-rate run after first MISS is forbidden");
					return incomplete();
				}
				return { goalStatus: "MISS", liveTargetStatus };
			}
			if (
				expected.slice(0, index).filter((value) => value === lower).length < 2
			) {
				const repeatLabel = `L${lower}-2`;
				const repeat = runs[consumed];
				if (!repeat) {
					reasons.push(`missing required lower-rung repeat ${repeatLabel}`);
					return incomplete();
				}
				if (repeat.label !== repeatLabel || repeat.rung !== lower) {
					reasons.push("full-rate run after first MISS is forbidden");
					return incomplete();
				}
				if (
					rungDecision(
						read,
						repeat,
						contract,
						pair,
						order,
						reasons,
						probeRequired,
					) !== "CLEAN"
				) {
					reasons.push(
						`required lower-rung repeat ${repeatLabel} is not clean`,
					);
					return incomplete();
				}
				consumed++;
			}
			if (runs.length !== consumed) {
				reasons.push("full-rate run after first MISS is forbidden");
				return incomplete();
			}
			const complete = evaluateCompanions(
				read,
				contract,
				pair,
				order,
				rung,
				lower,
				reasons,
				probeRequired,
			);
			return {
				goalStatus: complete
					? liveTargetStatus === "PASS"
						? "PASS"
						: "MISS"
					: "INCOMPLETE",
				liveTargetStatus,
			};
		}
		if (label === "L40000-2") liveTargetStatus = "PASS";
	}
	if (
		runs.length !== expected.length ||
		(contract.ladder.companions?.length ?? 0) !== 0 ||
		contract.ladder.companionRoot
	) {
		reasons.push("unexpected evidence after the clean 50k repeat");
		return incomplete();
	}
	return { goalStatus: "PASS", liveTargetStatus };
}

function evaluateFinalAudit(
	evidenceRoot: string,
	contract: CapacityGoalContract,
	reasons: string[],
): Map<string, string> {
	const verified = new Map<string, string>();
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
			// /1 retains its cumulative authorization meaning. Validated terminal
			// /2 settlements expose actual cumulative paid liability instead.
			const cumulativeAuthorized = sealedTotal;
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
			if (sha256 === entry.sha256 && bytes.byteLength === entry.bytes)
				verified.set(entry.path, sha256);
		}
	} catch {
		reasons.push("spend ledger is malformed");
	}
	return verified;
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
		const verified = evaluateFinalAudit(evidenceRoot, contract, fatalReasons);
		evaluateApprovals(repoRoot, evidenceRoot, contract, fatalReasons, verified);
		evaluateLocalVerification(
			repoRoot,
			evidenceRoot,
			contract,
			fatalReasons,
			verified,
		);
		const adapters = evaluateCapacityGoalAdapters({
			repoRoot,
			evidenceRoot,
			contract,
			verified,
		});
		fatalReasons.push(...adapters.fatalReasons);
		pendingReasons.push(...adapters.pendingReasons);
		// E2: only a reviewed recompute recording "interference" with the exact
		// probe-off r5 plan relaxes the rated-cell detailed-probe requirement.
		const r5 = adapters.r5;
		const probeOff =
			r5 !== undefined &&
			!r5.probeInB &&
			r5.calibrationDisposition === "interference";
		const ladder = evaluateLadder(
			evidenceRoot,
			contract,
			fatalReasons,
			verified,
			!probeOff,
		);
		const status =
			fatalReasons.length === 0 && pendingReasons.length === 0
				? ladder.goalStatus
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
			...(r5
				? {
						r5: {
							...r5,
							claims: probeOff
								? [
										"no mechanism claim: B ran probe-off after A' recorded detailed-probe interference",
									]
								: [],
						},
					}
				: {}),
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
