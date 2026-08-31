import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	maximumLifecycleCost,
	observedLifecycleCost,
	spendLedgerEntryArtifactSha256,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import {
	destroyDigitalOceanRig,
	ensureDigitalOceanRig,
	inventoryDigitalOcean,
	loadRigStateFromJournal,
	type ProviderMutationRecord,
	RecordedDigitalOceanProvider,
} from "./g6-c32-digitalocean.ts";
import {
	bindHostFreeze,
	verifyBoundFreeze,
	verifySemanticApproval,
	verifySemanticFreeze,
} from "./g6-c32-freeze.ts";
import {
	type ArtifactManifestEntry,
	canonicalArtifactSha256,
	canonicalJson,
	makeArtifactManifestRecord,
	type OperationReceipt,
	shellQuote,
	validateArtifactManifestRecord,
	validateDeadline,
	validateReviewReceipt,
	validateRfc3339Millis,
	validateSemanticApprovalRecord,
} from "./g6-c32-freeze-model.ts";
import {
	G6_C32_GATE_CATALOG,
	type GateExecutionRequest,
	type GateOperationRunner,
	type GatePhase,
	runGatePhase,
	validateGateReceipt,
} from "./g6-c32-gates.ts";
import {
	captureKnownHosts,
	collectHostIdentityPacket,
	type HostIdentityPacket,
	type HostPreparationAuthority,
	prepareHosts,
	RecordedHostOperationRunner,
	strictScpArgs,
	strictSshArgs,
	validateHostIdentityPair,
	validateHostPreparationReceipt,
	waitForSshReadiness,
} from "./g6-c32-host.ts";
import {
	BunCommandAdapter,
	type CampaignClock,
	type CommandAdapter,
	type RecordedOperation,
	recordOperation,
} from "./g6-c32-operation.ts";
import type {
	PrepareRigRunInput,
	RigBackend,
	RigBackendActionRequest,
	RigCommandOperationRecord,
	RigRunContext,
} from "./g6-c32-rig.ts";
import { makeDesiredRig, resolveCampaignInputPath } from "./g6-c32-rig.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
	type RigLifecycleState,
	readRigJournal,
} from "./g6-c32-rig-journal.ts";
import {
	assertBeforeDeadline,
	type DesiredRig,
	type DropletIdentity,
	type RigState,
	validateDesiredRig,
	validateDropletIdentity,
	validateRigState,
} from "./g6-c32-rig-model.ts";

const RUN_AUTHORITY_SCHEMA = "g6-c32-rig-run-authority/1" as const;
const GATE_INDEX_SCHEMA = "g6-c32-gate-index/1" as const;
const LOCK_SCHEMA = "g6-c32-orchestrator-lock/1" as const;
const CONTROLLER_LAUNCH_SCHEMA = "g6-c32-controller-launch/1" as const;
const PREPARATION_AUTHORITY_SCHEMA = "g6-c32-preparation-authority/1" as const;
const SEAL_RECEIPT_SCHEMA = "g6-c32-offrunner-seal/1" as const;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TERMINAL_CAMPAIGN_STATUSES = new Set([
	"RCA_CONFIRMED",
	"RCA_INTERACTION",
	"RCA_UNRESOLVED",
]);

type RunAuthority = Readonly<{
	schema: typeof RUN_AUTHORITY_SCHEMA;
	envelope: {
		recordedAt: string;
		sequence: number;
		runId: string;
		phase: "ABSENT";
		operationId: "initialize-run-authority";
		clockSource: "offrunner";
	};
	repositoryPath: string;
	campaignRoot: string;
	context: RigRunContext;
	desired: DesiredRig;
	semantic: {
		freezePath: string;
		approvalPath: string;
		architectReceiptPath: string;
		criticReceiptPath: string;
		freezeAuthoritySha256: string;
		freezeArtifactSha256: string;
		approvalAuthoritySha256: string;
		approvalArtifactSha256: string;
	};
}>;

type GateIndex = Readonly<{
	schema: typeof GATE_INDEX_SCHEMA;
	envelope: {
		recordedAt: string;
		sequence: number;
		runId: string;
		phase: GatePhase;
		operationId: string;
		clockSource: "offrunner";
	};
	complete: boolean;
	receiptPaths: string[];
}>;

type ControllerLaunch = Readonly<{
	schema: typeof CONTROLLER_LAUNCH_SCHEMA;
	envelope: {
		recordedAt: string;
		sequence: number;
		runId: string;
		phase: "QUALIFYING";
		operationId: "controller-launch";
		clockSource: "offrunner";
	};
	pid: number;
	command: string;
	args: string[];
	cwd: string;
	deadline: string;
	startedAt: string;
	startedMonotonicNs: string;
	operationSequence: number;
	evidenceRoot: string;
}>;

type PreparationAuthorityRecord = Readonly<{
	schema: typeof PREPARATION_AUTHORITY_SCHEMA;
	envelope: {
		recordedAt: string;
		sequence: number;
		runId: string;
		phase: "PREPARING";
		operationId: "preparation-authority";
		clockSource: "offrunner";
	};
	authority: HostPreparationAuthority;
}>;

export type ProductionRigBackendOptions = Readonly<{
	repositoryPath?: string;
	campaignRoot?: string;
	clock?: CampaignClock;
	commandAdapter?: CommandAdapter;
	randomId?: () => string;
	environment?: Readonly<Record<string, string>>;
}>;

export class SystemCampaignClock implements CampaignClock {
	wallNow(): string {
		return new Date().toISOString();
	}

	monotonicNowNs(): bigint {
		return process.hrtime.bigint();
	}
}

function fail(message: string): never {
	throw new Error(`g6-c32-rig-production: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(path: string, label: string): unknown {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		fail(`${label} is not valid JSON: ${String(error)}`);
	}
	return value;
}

function requireRegular(path: string, label: string): string {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		fail(`${label} does not exist: ${path}`);
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		fail(`${label} must be a regular non-symlink file`);
	}
	return realpathSync(path);
}

function requireDirectory(path: string, label: string): string {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		fail(`${label} does not exist: ${path}`);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		fail(`${label} must be a non-symlink directory`);
	}
	return realpathSync(path);
}

function inside(root: string, candidate: string, label: string): string {
	const absolute = resolve(candidate);
	const below = relative(root, absolute);
	if (
		below === "" ||
		below === ".." ||
		below.startsWith(`..${sep}`) ||
		isAbsolute(below)
	) {
		fail(`${label} must remain below ${root}`);
	}
	return absolute;
}

function syncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function writeExclusive(path: string, bytes: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	syncDirectory(dirname(path));
}

function writeReplacing(
	path: string,
	bytes: string | Uint8Array,
	randomId: () => string,
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const staging = join(
		dirname(path),
		`.${basename(path)}.staged-${randomId()}`,
	);
	writeExclusive(staging, bytes);
	renameSync(staging, path);
	syncDirectory(dirname(path));
}

function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function productionEnvironment(): Readonly<Record<string, string>> {
	const allowed = [
		"PATH",
		"HOME",
		"USER",
		"TMPDIR",
		"CARGO_HOME",
		"RUSTUP_HOME",
		"DO_API_TOKEN",
		"DIGITALOCEAN_ACCESS_TOKEN",
		"G6_C32_DO_SSH_KEY_ID",
		"G6_C32_SSH_IDENTITY_PATH",
		"CI",
	] as const;
	const result: Record<string, string> = {};
	for (const key of allowed) {
		const value = process.env[key];
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function timestampToken(value: string): string {
	return value.replaceAll(/[^0-9]/g, "");
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

function validateRunAuthority(value: unknown): RunAuthority {
	if (!isRecord(value) || value.schema !== RUN_AUTHORITY_SCHEMA) {
		fail("run authority schema is invalid");
	}
	if (!isRecord(value.envelope) || value.envelope.phase !== "ABSENT") {
		fail("run authority envelope is invalid");
	}
	const recordedAt = validateRfc3339Millis(
		value.envelope.recordedAt,
		"run authority recordedAt",
	);
	const runId = String(value.envelope.runId ?? "");
	if (!SAFE_RUN_ID.test(runId)) fail("run authority runId is unsafe");
	if (!isRecord(value.context) || !isRecord(value.semantic)) {
		fail("run authority context or semantic identity is invalid");
	}
	const context: RigRunContext = {
		runId: String(value.context.runId ?? ""),
		root: String(value.context.root ?? ""),
		deadline: validateRfc3339Millis(
			value.context.deadline,
			"run authority deadline",
		),
	};
	if (context.runId !== runId) fail("run authority context runId mismatch");
	const digest = (entry: unknown, label: string): string => {
		if (typeof entry !== "string" || !HASH_RE.test(entry)) {
			fail(`${label} is not a SHA-256 digest`);
		}
		return entry;
	};
	const path = (entry: unknown, label: string): string => {
		if (typeof entry !== "string" || entry === "" || entry.includes("\0")) {
			fail(`${label} is invalid`);
		}
		return entry;
	};
	const desired = validateDesiredRig(value.desired);
	if (desired.runId !== runId || desired.deadline !== context.deadline) {
		fail("run authority desired rig mismatch");
	}
	return {
		schema: RUN_AUTHORITY_SCHEMA,
		envelope: {
			recordedAt,
			sequence: 1,
			runId,
			phase: "ABSENT",
			operationId: "initialize-run-authority",
			clockSource: "offrunner",
		},
		repositoryPath: path(value.repositoryPath, "repositoryPath"),
		campaignRoot: path(value.campaignRoot, "campaignRoot"),
		context,
		desired,
		semantic: {
			freezePath: path(value.semantic.freezePath, "freezePath"),
			approvalPath: path(value.semantic.approvalPath, "approvalPath"),
			architectReceiptPath: path(
				value.semantic.architectReceiptPath,
				"architectReceiptPath",
			),
			criticReceiptPath: path(
				value.semantic.criticReceiptPath,
				"criticReceiptPath",
			),
			freezeAuthoritySha256: digest(
				value.semantic.freezeAuthoritySha256,
				"freezeAuthoritySha256",
			),
			freezeArtifactSha256: digest(
				value.semantic.freezeArtifactSha256,
				"freezeArtifactSha256",
			),
			approvalAuthoritySha256: digest(
				value.semantic.approvalAuthoritySha256,
				"approvalAuthoritySha256",
			),
			approvalArtifactSha256: digest(
				value.semantic.approvalArtifactSha256,
				"approvalArtifactSha256",
			),
		},
	};
}

function portablePath(root: string, path: string, label: string): string {
	const value = relative(root, path).split(sep).join(posix.sep);
	if (
		value === "" ||
		value === ".." ||
		value.startsWith("../") ||
		isAbsolute(value)
	) {
		fail(`${label} must remain below ${root}`);
	}
	return value;
}

function readCanonicalRecord<T>(
	path: string,
	label: string,
	validate: (value: unknown) => T,
): T {
	const raw = readFileSync(path, "utf8");
	const checked = validate(parseJson(path, label));
	if (canonicalJson(checked) !== raw) fail(`${label} is not canonical JSON`);
	return checked;
}

function successful(receipt: OperationReceipt): boolean {
	return (
		receipt.status.outcome === "SUCCEEDED" && receipt.status.exitCode === 0
	);
}

function listRegularFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const result: string[] = [];
	const visit = (directory: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) fail(`refusing symlink evidence: ${path}`);
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) result.push(path);
			else fail(`refusing non-file evidence: ${path}`);
		}
	};
	visit(root);
	return result.sort();
}

function validateGateIndex(value: unknown): GateIndex {
	if (!isRecord(value) || value.schema !== GATE_INDEX_SCHEMA) {
		fail("gate index schema is invalid");
	}
	if (!isRecord(value.envelope)) fail("gate index envelope is invalid");
	const phase = value.envelope.phase;
	if (
		phase !== "LOCAL" &&
		phase !== "PREPARED_HOST" &&
		phase !== "LOCKED_PAIR" &&
		phase !== "FINAL"
	) {
		fail("gate index phase is invalid");
	}
	if (value.complete !== true && value.complete !== false) {
		fail("gate index complete flag is invalid");
	}
	if (!Array.isArray(value.receiptPaths)) {
		fail("gate index receiptPaths must be an array");
	}
	const receiptPaths = value.receiptPaths.map((entry, index) => {
		if (
			typeof entry !== "string" ||
			entry === "" ||
			entry.includes("\0") ||
			entry.includes("\n")
		) {
			fail(`gate index receiptPaths[${index}] is invalid`);
		}
		return entry;
	});
	return {
		schema: GATE_INDEX_SCHEMA,
		envelope: {
			recordedAt: validateRfc3339Millis(
				value.envelope.recordedAt,
				"gate index recordedAt",
			),
			sequence: Number(value.envelope.sequence),
			runId: String(value.envelope.runId ?? ""),
			phase,
			operationId: String(value.envelope.operationId ?? ""),
			clockSource: "offrunner",
		},
		complete: value.complete,
		receiptPaths,
	};
}

function validateControllerLaunch(value: unknown): ControllerLaunch {
	if (!isRecord(value) || value.schema !== CONTROLLER_LAUNCH_SCHEMA) {
		fail("controller launch schema is invalid");
	}
	if (!isRecord(value.envelope)) fail("controller launch envelope is invalid");
	const pid = Number(value.pid);
	const operationSequence = Number(value.operationSequence);
	if (!Number.isSafeInteger(pid) || pid < 1) fail("controller PID is invalid");
	if (!Number.isSafeInteger(operationSequence) || operationSequence < 1) {
		fail("controller operation sequence is invalid");
	}
	if (
		!Array.isArray(value.args) ||
		value.args.some((item) => typeof item !== "string")
	) {
		fail("controller launch args are invalid");
	}
	return {
		schema: CONTROLLER_LAUNCH_SCHEMA,
		envelope: {
			recordedAt: validateRfc3339Millis(
				value.envelope.recordedAt,
				"controller launch recordedAt",
			),
			sequence: Number(value.envelope.sequence),
			runId: String(value.envelope.runId ?? ""),
			phase: "QUALIFYING",
			operationId: "controller-launch",
			clockSource: "offrunner",
		},
		pid,
		command: String(value.command ?? ""),
		args: value.args as string[],
		cwd: String(value.cwd ?? ""),
		deadline: validateRfc3339Millis(value.deadline, "controller deadline"),
		startedAt: validateRfc3339Millis(value.startedAt, "controller startedAt"),
		startedMonotonicNs: String(value.startedMonotonicNs ?? ""),
		operationSequence,
		evidenceRoot: String(value.evidenceRoot ?? ""),
	};
}

export class ProductionRigBackend implements RigBackend {
	readonly #repositoryPath: string;
	readonly #campaignRoot: string;
	readonly #clock: CampaignClock;
	readonly #adapter: CommandAdapter;
	readonly #randomId: () => string;
	readonly #environment: Readonly<Record<string, string>>;
	readonly #locks = new Map<string, string>();

	constructor(options: ProductionRigBackendOptions = {}) {
		this.#repositoryPath = requireDirectory(
			options.repositoryPath ?? resolve(import.meta.dir, "../.."),
			"repository",
		);
		this.#campaignRoot = requireDirectory(
			options.campaignRoot ??
				join(this.#repositoryPath, ".scratch", "bare-metal-campaign"),
			"campaign root",
		);
		this.#clock = options.clock ?? new SystemCampaignClock();
		this.#adapter =
			options.commandAdapter ?? new BunCommandAdapter(this.#repositoryPath);
		this.#randomId = options.randomId ?? randomUUID;
		this.#environment = options.environment ?? productionEnvironment();
	}

	async prepareRun(input: PrepareRigRunInput): Promise<RigRunContext> {
		const freezePath = resolveCampaignInputPath({
			repositoryPath: this.#repositoryPath,
			campaignRoot: this.#campaignRoot,
			inputPath: input.semanticFreezePath,
			label: "semantic freeze",
		});
		const approvalPath = resolveCampaignInputPath({
			repositoryPath: this.#repositoryPath,
			campaignRoot: this.#campaignRoot,
			inputPath: input.semanticApprovalPath,
			label: "semantic approval",
		});
		const freeze = verifySemanticFreeze(
			parseJson(freezePath, "semantic freeze"),
			{
				repositoryPath: this.#repositoryPath,
			},
		);
		const approval = validateSemanticApprovalRecord(
			parseJson(approvalPath, "semantic approval"),
		);
		if (approval.envelope.runId !== freeze.envelope.runId) {
			fail("semantic approval runId differs from semantic freeze");
		}
		const architectReceiptPath = resolveCampaignInputPath({
			repositoryPath: this.#repositoryPath,
			campaignRoot: this.#campaignRoot,
			inputPath: approval.authority.architect.receiptPath,
			label: "Architect receipt",
		});
		const criticReceiptPath = resolveCampaignInputPath({
			repositoryPath: this.#repositoryPath,
			campaignRoot: this.#campaignRoot,
			inputPath: approval.authority.critic.receiptPath,
			label: "Critic receipt",
		});
		const architect = validateReviewReceipt(
			parseJson(architectReceiptPath, "Architect receipt"),
		);
		const critic = validateReviewReceipt(
			parseJson(criticReceiptPath, "Critic receipt"),
		);
		verifySemanticApproval(freeze, approval, architect, critic);
		if (!SAFE_RUN_ID.test(freeze.envelope.runId)) {
			fail("semantic runId must be a lowercase DigitalOcean-safe identifier");
		}
		const recordedAt = validateRfc3339Millis(
			this.#clock.wallNow(),
			"run recordedAt",
		);
		const deadline = validateDeadline(recordedAt, input.deadline);
		const provisioningRoot = join(this.#campaignRoot, "provisioning");
		mkdirSync(provisioningRoot, { recursive: true, mode: 0o700 });
		const root = inside(
			provisioningRoot,
			join(provisioningRoot, freeze.envelope.runId),
			"provisioning run root",
		);
		const context: RigRunContext = {
			runId: freeze.envelope.runId,
			root,
			deadline,
		};
		const policy = validateBudgetPolicy(
			parseJson(
				resolve(this.#repositoryPath, freeze.authority.budgetPolicy.path),
				"budget policy",
			),
		);
		if (policy.spentBeforeMicrousd > 0) {
			const prior = policy.priorLedger;
			if (!prior) fail("prior spend requires a sealed spend ledger");
			const priorPath = requireRegular(
				inside(
					this.#repositoryPath,
					resolve(this.#repositoryPath, prior.path),
					"prior spend ledger",
				),
				"prior spend ledger",
			);
			const priorRaw = parseJson(priorPath, "prior spend ledger");
			if (canonicalArtifactSha256(priorRaw) !== prior.sha256) {
				fail("prior spend ledger artifact digest differs from budget policy");
			}
			const sealed = validateSpendLedger(priorRaw, { requireSeal: true });
			const seal = sealed.entries.at(-1);
			if (
				!seal ||
				seal.event !== "SEAL" ||
				seal.totalAuthorizedMicrousd !== prior.sealedSpentMicrousd
			) {
				fail("prior spend ledger seal differs from budget policy");
			}
		}
		if (policy.runId !== context.runId) {
			fail("budget policy runId differs from semantic runId");
		}
		const desired = makeDesiredRig({
			runId: context.runId,
			recordedAt,
			deadline,
			sshKeyId: (() => {
				const raw = process.env.G6_C32_DO_SSH_KEY_ID;
				if (raw === undefined) return undefined;
				const value = Number(raw);
				if (!Number.isSafeInteger(value) || value <= 0) {
					fail("G6_C32_DO_SSH_KEY_ID must be a positive integer");
				}
				return value;
			})(),
			freezeAuthoritySha256: freeze.authoritySha256,
			freezeArtifactSha256: canonicalArtifactSha256(freeze),
			approvalAuthoritySha256: approval.authoritySha256,
			approvalArtifactSha256: canonicalArtifactSha256(approval),
			budget: {
				campaignId: policy.campaignId,
				lifecycle: policy.lifecycle,
				policyPath: freeze.authority.budgetPolicy.path,
				policySha256: budgetPolicyArtifactSha256(policy),
				totalBudgetMicrousd: policy.totalBudgetMicrousd,
				spentBeforeMicrousd: policy.spentBeforeMicrousd,
				priorLedgerArtifactSha256: policy.priorLedger?.sha256 ?? null,
				maximumLifecycleCostMicrousd: policy.maximumLifecycleCostMicrousd,
				maximumLifecycleSeconds: policy.maximumLifecycleSeconds,
				teardownReserveSeconds: policy.teardownReserveSeconds,
				rolePriceCeilingMicrousd: policy.maximumRoleHourlyMicrousd,
			},
		});
		const authority: RunAuthority = {
			schema: RUN_AUTHORITY_SCHEMA,
			envelope: {
				recordedAt,
				sequence: 1,
				runId: context.runId,
				phase: "ABSENT",
				operationId: "initialize-run-authority",
				clockSource: "offrunner",
			},
			repositoryPath: this.#repositoryPath,
			campaignRoot: this.#campaignRoot,
			context,
			desired,
			semantic: {
				freezePath,
				approvalPath,
				architectReceiptPath,
				criticReceiptPath,
				freezeAuthoritySha256: freeze.authoritySha256,
				freezeArtifactSha256: canonicalArtifactSha256(freeze),
				approvalAuthoritySha256: approval.authoritySha256,
				approvalArtifactSha256: canonicalArtifactSha256(approval),
			},
		};

		if (!existsSync(root)) {
			mkdirSync(root, { recursive: false, mode: 0o700 });
			writeExclusive(
				join(root, "run-authority.json"),
				canonicalJson(authority),
			);
			writeExclusive(join(root, "RUN_STATUS"), "INCOMPLETE\n");
		} else {
			requireDirectory(root, "existing provisioning run root");
			const existing = validateRunAuthority(
				parseJson(join(root, "run-authority.json"), "run authority"),
			);
			if (
				canonicalJson(existing.semantic) !==
					canonicalJson(authority.semantic) ||
				existing.context.deadline !== authority.context.deadline
			) {
				fail(
					"existing run root binds different semantic authority or deadline",
				);
			}
			if (
				existing.desired.runId !== authority.desired.runId ||
				canonicalJson(existing.desired.profile) !==
					canonicalJson(authority.desired.profile) ||
				canonicalJson(existing.desired.roles) !==
					canonicalJson(authority.desired.roles)
			) {
				fail("existing run root binds a different desired rig");
			}
			this.#acquire(existing.context);
			return existing.context;
		}
		const journalPath = join(root, "rig-state.json");
		if (!existsSync(journalPath)) {
			initializeRigJournal(
				{
					path: journalPath,
					runId: context.runId,
					desiredRigAuthority: desired,
				},
				{ clock: this.#clock, randomId: this.#randomId },
			);
		}
		this.#acquire(context);
		return context;
	}

	async openRoot(rootValue: string): Promise<RigRunContext> {
		if (!rootValue || rootValue.includes("\0")) fail("--root is invalid");
		const unresolved = isAbsolute(rootValue)
			? resolve(rootValue)
			: resolve(this.#repositoryPath, rootValue);
		const root = requireDirectory(unresolved, "provisioning run root");
		const provisioningRoot = requireDirectory(
			join(this.#campaignRoot, "provisioning"),
			"provisioning root",
		);
		if (dirname(root) !== provisioningRoot) {
			fail("--root must be one direct child of the fixed provisioning root");
		}
		const authority = validateRunAuthority(
			parseJson(join(root, "run-authority.json"), "run authority"),
		);
		if (
			authority.context.root !== root ||
			authority.repositoryPath !== this.#repositoryPath ||
			authority.campaignRoot !== this.#campaignRoot
		) {
			fail("run authority paths differ from the current fixed roots");
		}
		readRigJournal(join(root, "rig-state.json"));
		this.#acquire(authority.context);
		return authority.context;
	}

	async readState(context: RigRunContext): Promise<RigLifecycleState> {
		this.#authority(context);
		const state = readRigJournal(
			join(context.root, "rig-state.json"),
		).events.at(-1)?.state;
		if (!state) fail("rig journal has no latest state");
		return state;
	}

	async nextOperationSequence(context: RigRunContext): Promise<number> {
		this.#authority(context);
		const directory = join(context.root, "orchestrator-operations");
		if (!existsSync(directory)) return 1;
		const sequences = readdirSync(directory)
			.map((name) => /^(\d{6})-/.exec(name)?.[1])
			.filter((value): value is string => value !== undefined)
			.map(Number);
		return sequences.length === 0 ? 1 : Math.max(...sequences) + 1;
	}

	async persistOperation(
		recordValue: RigCommandOperationRecord,
		context: RigRunContext,
	): Promise<void> {
		this.#authority(context);
		const sequence = recordValue.envelope.sequence;
		const expected = await this.nextOperationSequence(context);
		if (sequence !== expected) {
			fail(`orchestrator operation sequence ${sequence} should be ${expected}`);
		}
		const name = `${String(sequence).padStart(6, "0")}-${recordValue.action.toLowerCase().replaceAll("_", "-")}.json`;
		writeExclusive(
			join(context.root, "orchestrator-operations", name),
			canonicalJson(recordValue),
		);
		const streamPath = join(context.root, "orchestrator-operations.jsonl");
		const descriptor = openSync(streamPath, "a", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(recordValue)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		syncDirectory(context.root);
	}

	async execute(request: RigBackendActionRequest): Promise<void> {
		this.#authority(request.context);
		try {
			switch (request.action) {
				case "VERIFY_SEMANTIC":
					this.#verifySemantic(request.context, request.cleanupOnly);
					return;
				case "LOCAL_GATES":
					await this.#localGates(request);
					return;
				case "INVENTORY":
					await this.#inventory(request);
					return;
				case "ENSURE":
					await this.#ensure(request);
					return;
				case "PREPARE":
					await this.#prepare(request);
					return;
				case "BIND":
					await this.#bind(request);
					return;
				case "DISPATCH":
					await this.#dispatch(request);
					return;
				case "RECOVER_LIVE":
					await this.#recoverLive(request);
					return;
				case "SEAL":
					await this.#seal(request);
					return;
				case "DESTROY":
					await this.#destroy(request);
					return;
			}
		} catch (error) {
			const state = await this.readState(request.context);
			if (
				state !== "ABSENT" &&
				state !== "CREATING" &&
				state !== "FAILED" &&
				state !== "DESTROYING" &&
				state !== "DESTROYED" &&
				request.action !== "RECOVER_LIVE" &&
				!(
					request.action === "DISPATCH" &&
					(state === "QUALIFYING" || state === "RUNNING")
				)
			) {
				this.#markFailed(request.context, error);
			}
			throw error;
		}
	}

	async release(context: RigRunContext): Promise<void> {
		const token = this.#locks.get(context.root);
		if (!token) return;
		const lockPath = join(context.root, "orchestrator-lock.json");
		if (existsSync(lockPath)) {
			const lock = parseJson(lockPath, "orchestrator lock");
			if (!isRecord(lock) || lock.token !== token) {
				fail("orchestrator lock ownership changed before release");
			}
			const recordedAt = this.#clock.wallNow();
			writeExclusive(
				join(
					context.root,
					"locks",
					`released-${timestampToken(recordedAt)}-${token}.json`,
				),
				canonicalJson({
					schema: "g6-c32-orchestrator-lock-release/1",
					envelope: {
						recordedAt,
						sequence: 1,
						runId: context.runId,
						phase: await this.readState(context),
						operationId: "release-orchestrator-lock",
						clockSource: "offrunner",
					},
					token,
					pid: process.pid,
				}),
			);
			unlinkSync(lockPath);
			syncDirectory(context.root);
		}
		this.#locks.delete(context.root);
	}

	#authority(context: RigRunContext): RunAuthority {
		const root = requireDirectory(context.root, "run root");
		const authority = validateRunAuthority(
			parseJson(join(root, "run-authority.json"), "run authority"),
		);
		if (canonicalJson(authority.context) !== canonicalJson(context)) {
			fail("runtime context differs from run authority");
		}
		return authority;
	}

	#acquire(context: RigRunContext): void {
		if (this.#locks.has(context.root)) return;
		const lockPath = join(context.root, "orchestrator-lock.json");
		if (existsSync(lockPath)) {
			const prior = parseJson(lockPath, "orchestrator lock");
			if (!isRecord(prior) || prior.schema !== LOCK_SCHEMA) {
				fail("existing orchestrator lock is malformed");
			}
			const pid = Number(prior.pid);
			if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
				fail(`another orchestrator is active as PID ${pid}`);
			}
			const staleAt = this.#clock.wallNow();
			mkdirSync(join(context.root, "locks"), { recursive: true, mode: 0o700 });
			const staleToken = sha256(String(prior.token ?? "unknown")).slice(0, 16);
			renameSync(
				lockPath,
				join(
					context.root,
					"locks",
					`stale-${timestampToken(staleAt)}-${staleToken}.json`,
				),
			);
		}
		const token = this.#randomId();
		const recordedAt = this.#clock.wallNow();
		writeExclusive(
			lockPath,
			canonicalJson({
				schema: LOCK_SCHEMA,
				envelope: {
					recordedAt,
					sequence: 1,
					runId: context.runId,
					phase: readRigJournal(join(context.root, "rig-state.json")).events.at(
						-1,
					)?.state,
					operationId: "acquire-orchestrator-lock",
					clockSource: "offrunner",
				},
				token,
				pid: process.pid,
			}),
		);
		this.#locks.set(context.root, token);
	}

	#verifySemantic(context: RigRunContext, cleanupOnly: boolean): void {
		if (!cleanupOnly) this.#beforeDeadline(context, "verify-semantic");
		const authority = this.#authority(context);
		const freeze = verifySemanticFreeze(
			parseJson(authority.semantic.freezePath, "semantic freeze"),
			{ repositoryPath: this.#repositoryPath },
		);
		const approval = validateSemanticApprovalRecord(
			parseJson(authority.semantic.approvalPath, "semantic approval"),
		);
		const architect = validateReviewReceipt(
			parseJson(authority.semantic.architectReceiptPath, "Architect receipt"),
		);
		const critic = validateReviewReceipt(
			parseJson(authority.semantic.criticReceiptPath, "Critic receipt"),
		);
		verifySemanticApproval(freeze, approval, architect, critic);
		if (
			freeze.authoritySha256 !== authority.semantic.freezeAuthoritySha256 ||
			canonicalArtifactSha256(freeze) !==
				authority.semantic.freezeArtifactSha256 ||
			approval.authoritySha256 !== authority.semantic.approvalAuthoritySha256 ||
			canonicalArtifactSha256(approval) !==
				authority.semantic.approvalArtifactSha256
		) {
			fail("semantic authority differs from initialized run authority");
		}
	}

	#beforeDeadline(context: RigRunContext, operation: string): string {
		return assertBeforeDeadline(
			this.#authority(context).desired,
			this.#clock.wallNow(),
			operation,
		);
	}

	#journalPath(context: RigRunContext): string {
		return join(context.root, "rig-state.json");
	}

	#spendLedgerPath(context: RigRunContext): string {
		return join(context.root, "spend-ledger.json");
	}

	#recordProviderMutation(
		context: RigRunContext,
		mutation: ProviderMutationRecord,
	): void {
		const ledgerPath = this.#spendLedgerPath(context);
		if (!existsSync(ledgerPath)) {
			const state = this.#state(context);
			const price = state.preCreateBudgetAuthority?.priceReceipt;
			if (!price) {
				fail("provider mutation requires fresh pre-create budget authority");
			}
			const reserve = maximumLifecycleCost({
				hourlyMicrousdByRole: {
					server: price.serverHourlyMicrousd,
					generator: price.generatorHourlyMicrousd,
				},
				executionSeconds: 0,
				teardownReserveSeconds: state.desired.budget.teardownReserveSeconds,
			});
			const initial = appendSpendLedgerEntry(null, {
				recordedAt: price.recordedAt,
				campaignId: state.desired.budget.campaignId,
				runId: state.desired.runId,
				budgetPolicySha256: state.desired.budget.policySha256,
				event: "PRICE_VERIFIED",
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 0,
				teardownReserveMicrousd: reserve,
				totalAuthorizedMicrousd: 0,
				remainingBudgetMicrousd:
					state.desired.budget.totalBudgetMicrousd -
					state.desired.budget.spentBeforeMicrousd,
				decision: null,
			});
			writeReplacing(ledgerPath, canonicalJson([initial]), this.#randomId);
		}
		const ledger = validateSpendLedger(parseJson(ledgerPath, "spend ledger"), {
			requireSeal: false,
		});
		const previous = ledger.entries.at(-1);
		if (!previous || previous.event === "SEAL") {
			fail("provider mutation requires an active spend ledger");
		}
		const appendLinkedEntry = (
			journalEvent: ReturnType<typeof readRigJournal>["events"][number],
		): void => {
			const entry = appendSpendLedgerEntry(previous, {
				recordedAt: journalEvent.envelope.recordedAt,
				campaignId: previous.campaignId,
				runId: previous.runId,
				budgetPolicySha256: previous.budgetPolicySha256,
				event: mutation.kind,
				rigJournalEventArtifactSha256: canonicalArtifactSha256(journalEvent),
				accruedLifecycleMicrousd: previous.accruedLifecycleMicrousd,
				prospectiveCellMicrousd: 0,
				teardownReserveMicrousd: previous.teardownReserveMicrousd,
				totalAuthorizedMicrousd: previous.totalAuthorizedMicrousd,
				remainingBudgetMicrousd: previous.remainingBudgetMicrousd,
				decision: null,
			});
			writeReplacing(
				ledgerPath,
				canonicalJson([...ledger.entries, entry]),
				this.#randomId,
			);
		};
		const priorJournal = readRigJournal(this.#journalPath(context));
		const priorMatches = priorJournal.events.filter(
			(event) => event.envelope.operationId === mutation.operationId,
		);
		if (priorMatches.length > 1) {
			fail("provider mutation operationId is duplicated in the rig journal");
		}
		const priorMatch = priorMatches[0];
		if (priorMatch) {
			if (priorMatch.kind !== mutation.kind) {
				fail("provider mutation operationId changed event kind");
			}
			const digest = canonicalArtifactSha256(priorMatch);
			const linked = ledger.entries.filter(
				(entry) => entry.rigJournalEventArtifactSha256 === digest,
			);
			if (linked.length === 1 && linked[0]?.event === mutation.kind) return;
			if (
				linked.length === 0 &&
				priorMatch.spendLedgerHeadArtifactSha256 ===
					spendLedgerEntryArtifactSha256(previous)
			) {
				appendLinkedEntry(priorMatch);
				return;
			}
			fail("provider mutation journal replay lacks one spend-ledger link");
		}
		const snapshot = appendRigJournalEvent(
			this.#journalPath(context),
			{
				state: this.#state(context).lifecycle,
				kind: mutation.kind,
				operationId: mutation.operationId,
				spendLedgerHeadArtifactSha256: spendLedgerEntryArtifactSha256(previous),
				details: {
					role: mutation.role,
					providerId: mutation.providerId,
				},
			},
			{
				clock: { wallNow: () => mutation.recordedAt },
				randomId: this.#randomId,
			},
		);
		const journalEvent = snapshot.events.at(-1);
		if (!journalEvent)
			fail("provider mutation journal append produced no event");
		appendLinkedEntry(journalEvent);
	}

	#recordEmergencyReconciliation(
		context: RigRunContext,
		recordedAt: string,
	): void {
		const state = this.#state(context);
		const price = state.preCreateBudgetAuthority?.priceReceipt;
		if (!price || state.ownedResources.length !== 2) {
			fail("emergency reconciliation lacks exact paid lifecycle authority");
		}
		const startedAt = Math.min(
			...state.ownedResources.map(({ recordedAt: value }) => Date.parse(value)),
		);
		const observedAt = Date.parse(recordedAt);
		if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt)) {
			fail("emergency reconciliation timestamps are invalid");
		}
		const elapsedSeconds = Math.max(
			0,
			Math.ceil((observedAt - startedAt) / 1_000),
		);
		const ledgerPath = this.#spendLedgerPath(context);
		const ledger = validateSpendLedger(parseJson(ledgerPath, "spend ledger"), {
			requireSeal: false,
		});
		const previous = ledger.entries.at(-1);
		if (!previous || previous.event === "SEAL") {
			fail("emergency reconciliation requires an active spend ledger");
		}
		const entry = appendSpendLedgerEntry(previous, {
			recordedAt,
			campaignId: previous.campaignId,
			runId: previous.runId,
			budgetPolicySha256: previous.budgetPolicySha256,
			event: "EMERGENCY_RECONCILIATION",
			accruedLifecycleMicrousd: maximumLifecycleCost({
				hourlyMicrousdByRole: {
					server: price.serverHourlyMicrousd,
					generator: price.generatorHourlyMicrousd,
				},
				executionSeconds: elapsedSeconds,
				teardownReserveSeconds: 0,
			}),
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: previous.teardownReserveMicrousd,
			// Post-reserve liability is observed, not newly authorized work.
			totalAuthorizedMicrousd: previous.totalAuthorizedMicrousd,
			remainingBudgetMicrousd: previous.remainingBudgetMicrousd,
			decision: null,
		});
		writeReplacing(
			ledgerPath,
			canonicalJson([...ledger.entries, entry]),
			this.#randomId,
		);
	}

	#sealSpendLedger(context: RigRunContext): void {
		const ledgerPath = this.#spendLedgerPath(context);
		if (!existsSync(ledgerPath)) return;
		const ledger = validateSpendLedger(parseJson(ledgerPath, "spend ledger"), {
			requireSeal: false,
		});
		const previous = ledger.entries.at(-1);
		if (!previous || previous.event === "SEAL") return;
		const state = this.#state(context);
		const budget = state.desired.budget;
		const price = state.preCreateBudgetAuthority?.priceReceipt;
		const recordedAt = this.#clock.wallNow();
		if (
			!price &&
			ledger.entries.some(({ event }) => event === "CREATE_OBSERVED")
		) {
			fail("spend-ledger seal lacks paid lifecycle price authority");
		}
		const accruedLifecycleMicrousd = Math.max(
			previous.accruedLifecycleMicrousd,
			previous.totalAuthorizedMicrousd - budget.spentBeforeMicrousd,
			price
				? observedLifecycleCost({
						entries: ledger.entries,
						sealedAt: recordedAt,
						hourlyMicrousdByRole: {
							server: price.serverHourlyMicrousd,
							generator: price.generatorHourlyMicrousd,
						},
					})
				: 0,
		);
		const totalAuthorizedMicrousd = Math.max(
			previous.totalAuthorizedMicrousd,
			budget.spentBeforeMicrousd + accruedLifecycleMicrousd,
		);
		const entry = appendSpendLedgerEntry(previous, {
			recordedAt,
			campaignId: previous.campaignId,
			runId: previous.runId,
			budgetPolicySha256: previous.budgetPolicySha256,
			event: "SEAL",
			accruedLifecycleMicrousd,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 0,
			totalAuthorizedMicrousd,
			remainingBudgetMicrousd:
				budget.totalBudgetMicrousd - totalAuthorizedMicrousd,
			decision: null,
		});
		writeReplacing(
			ledgerPath,
			canonicalJson([...ledger.entries, entry]),
			this.#randomId,
		);
	}

	#state(context: RigRunContext): RigState {
		const base = loadRigStateFromJournal(this.#journalPath(context));
		const latest = readRigJournal(this.#journalPath(context)).events.at(
			-1,
		)?.state;
		if (!latest) fail("rig journal has no latest event");
		return validateRigState({ ...base, lifecycle: latest });
	}

	#appendState(
		context: RigRunContext,
		stateValue: RigState,
		kind: "INTENT" | "RESULT" | "TRANSITION" | "RECOVERY",
		operationId: string,
		details: unknown,
	): RigState {
		const state = validateRigState(stateValue);
		appendRigJournalEvent(
			this.#journalPath(context),
			{
				state: state.lifecycle,
				kind,
				operationId,
				details: { rigState: state, result: details },
			},
			{ clock: this.#clock, randomId: this.#randomId },
		);
		return state;
	}

	#operationsDirectory(context: RigRunContext): string {
		return join(context.root, "operations");
	}

	#operationPathPrefix(context: RigRunContext): string {
		return portablePath(
			join(this.#campaignRoot, "provisioning"),
			this.#operationsDirectory(context),
			"operation artifact path",
		);
	}

	#nextEvidenceSequence(context: RigRunContext): number {
		let maximum = 0;
		const operations = this.#operationsDirectory(context);
		if (existsSync(operations)) {
			for (const name of readdirSync(operations)) {
				const match = /^(\d{6})-/.exec(name);
				if (match?.[1]) maximum = Math.max(maximum, Number(match[1]));
			}
		}
		const gates = join(context.root, "gates");
		for (const path of listRegularFiles(gates)) {
			if (!path.endsWith(".json")) continue;
			try {
				const value = parseJson(path, "gate sequence record");
				if (isRecord(value) && isRecord(value.envelope)) {
					const sequence = Number(value.envelope.sequence);
					if (Number.isSafeInteger(sequence))
						maximum = Math.max(maximum, sequence);
				}
			} catch {
				// A malformed retained record is rejected when its phase index is read.
			}
		}
		return maximum + 1;
	}

	async #record(
		context: RigRunContext,
		input: {
			sequence?: number;
			attempt?: number;
			operationId: string;
			phase: string;
			command: string;
			args: readonly string[];
			cwd?: string;
			timeoutMs: number;
			signal?: AbortSignal;
			adapter?: CommandAdapter;
		},
	): Promise<RecordedOperation> {
		return recordOperation(
			{
				runId: context.runId,
				sequence: input.sequence ?? this.#nextEvidenceSequence(context),
				attempt: input.attempt ?? 1,
				artifactDirectory: this.#operationsDirectory(context),
				artifactPathPrefix: this.#operationPathPrefix(context),
				spec: {
					operationId: input.operationId,
					phase: input.phase,
					command: input.command,
					args: [...input.args],
					cwd: input.cwd ?? ".",
					env: this.#environment,
					timeoutMs: input.timeoutMs,
					stdin: "ignore",
				},
				...(input.signal ? { signal: input.signal } : {}),
			},
			{
				clock: this.#clock,
				adapter: input.adapter ?? this.#adapter,
				executionRoot: this.#repositoryPath,
			},
		);
	}

	#provider(
		context: RigRunContext,
		signal?: AbortSignal,
	): RecordedDigitalOceanProvider {
		return new RecordedDigitalOceanProvider({
			runId: context.runId,
			artifactDirectory: this.#operationsDirectory(context),
			artifactPathPrefix: this.#operationPathPrefix(context),
			cwd: ".",
			env: this.#environment,
			timeoutMs: 120_000,
			startingSequence: this.#nextEvidenceSequence(context),
			...(signal ? { signal } : {}),
			operationDependencies: {
				clock: this.#clock,
				adapter: this.#adapter,
				executionRoot: this.#repositoryPath,
			},
		});
	}

	#hostRunner(
		context: RigRunContext,
		signal?: AbortSignal,
	): RecordedHostOperationRunner {
		return new RecordedHostOperationRunner({
			runId: context.runId,
			artifactDirectory: this.#operationsDirectory(context),
			artifactPathPrefix: this.#operationPathPrefix(context),
			cwd: ".",
			env: this.#environment,
			timeoutMs: 300_000,
			startingSequence: this.#nextEvidenceSequence(context),
			...(signal ? { signal } : {}),
			operationDependencies: {
				clock: this.#clock,
				adapter: this.#adapter,
				executionRoot: this.#repositoryPath,
			},
		});
	}

	#deadlineSignal(
		context: RigRunContext,
		external: AbortSignal | undefined,
		cleanupOnly: boolean,
	): { signal?: AbortSignal; dispose: () => void } {
		if (cleanupOnly && !external) return { dispose: () => {} };
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = (): void => controller.abort("campaign cancelled");
		if (external) {
			if (external.aborted) abort();
			else external.addEventListener("abort", abort, { once: true });
		}
		if (!cleanupOnly) {
			const remaining = Date.parse(context.deadline) - Date.now();
			if (remaining <= 0) controller.abort("campaign deadline expired");
			else timer = setTimeout(abort, Math.min(remaining, 2_147_483_647));
		}
		return {
			signal: controller.signal,
			dispose: () => {
				if (timer) clearTimeout(timer);
				if (external) external.removeEventListener("abort", abort);
			},
		};
	}

	#ownedPair(stateValue: RigState): [DropletIdentity, DropletIdentity] {
		const state = validateRigState(stateValue);
		if (state.ownedResources.length !== 2) {
			fail("operation requires exactly two journal-owned resources");
		}
		const byRole = new Map(
			state.ownedResources.map((resource) => [
				resource.role,
				validateDropletIdentity(resource.recordedIdentity),
			]),
		);
		const server = byRole.get("server");
		const generator = byRole.get("generator");
		if (!server || !generator)
			fail("owned server/generator pair is incomplete");
		return [server, generator];
	}

	#gateIndex(context: RigRunContext, phase: GatePhase): GateIndex | null {
		const path = join(
			context.root,
			"gates",
			phase.toLowerCase(),
			"latest.json",
		);
		if (!existsSync(path)) return null;
		const index = readCanonicalRecord(
			path,
			`${phase} gate index`,
			validateGateIndex,
		);
		if (
			index.envelope.runId !== context.runId ||
			index.envelope.phase !== phase ||
			index.envelope.clockSource !== "offrunner"
		) {
			fail(`${phase} gate index authority mismatch`);
		}
		for (const receiptPath of index.receiptPaths) {
			const resolved = requireRegular(receiptPath, `${phase} gate receipt`);
			inside(context.root, resolved, `${phase} gate receipt`);
			const receipt = readCanonicalRecord(
				resolved,
				`${phase} gate receipt`,
				validateGateReceipt,
			);
			if (
				receipt.envelope.runId !== context.runId ||
				receipt.gate.phase !== phase
			) {
				fail(`${phase} gate receipt authority mismatch`);
			}
		}
		return index;
	}

	async #runGates(
		context: RigRunContext,
		phase: GatePhase,
		inputs: Readonly<Record<string, string>>,
		runner: GateOperationRunner,
	): Promise<GateIndex> {
		const existing = this.#gateIndex(context, phase);
		if (existing?.complete) return existing;
		const sequenceStart = this.#nextEvidenceSequence(context);
		const token = `${timestampToken(this.#clock.wallNow())}-${sha256(this.#randomId()).slice(0, 12)}`;
		const directory = join(
			context.root,
			"gates",
			phase.toLowerCase(),
			`run-${token}`,
		);
		mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
		mkdirSync(directory, { recursive: false, mode: 0o700 });
		const receiptPaths: string[] = [];
		const result = await runGatePhase({
			runId: context.runId,
			phase,
			catalog: G6_C32_GATE_CATALOG,
			sequenceStart,
			inputs,
			clock: this.#clock,
			runner,
			onReceipt: (receipt) => {
				const checked = validateGateReceipt(receipt);
				const path = join(directory, `${checked.gate.id}.json`);
				writeExclusive(path, canonicalJson(checked));
				receiptPaths.push(path);
			},
		});
		const index: GateIndex = {
			schema: GATE_INDEX_SCHEMA,
			envelope: {
				recordedAt: validateRfc3339Millis(
					this.#clock.wallNow(),
					`${phase} gate index recordedAt`,
				),
				sequence: sequenceStart + result.receipts.length,
				runId: context.runId,
				phase,
				operationId: `index-${phase.toLowerCase().replaceAll("_", "-")}-gates`,
				clockSource: "offrunner",
			},
			complete: result.complete,
			receiptPaths,
		};
		writeExclusive(join(directory, "index.json"), canonicalJson(index));
		writeReplacing(
			join(context.root, "gates", phase.toLowerCase(), "latest.json"),
			canonicalJson(index),
			this.#randomId,
		);
		return index;
	}

	#gateRunner(
		context: RigRunContext,
		options: {
			signal?: AbortSignal;
			hosts?: readonly [DropletIdentity, DropletIdentity];
			knownHostsPath?: string;
			remoteCheckoutPath?: string;
		},
	): GateOperationRunner {
		return {
			execute: async (request: GateExecutionRequest) => {
				let command = request.command;
				let args = [...request.args];
				let cwd = request.cwd;
				if (request.requiredHost === "offrunner") {
					if (command === "bun") command = process.execPath;
					else if (command === "bunx") {
						command = process.execPath;
						args = ["x", ...args];
					}
				} else if (
					request.requiredHost === "server" ||
					request.requiredHost === "generator"
				) {
					const hosts = options.hosts;
					const knownHostsPath = options.knownHostsPath;
					const remoteCheckoutPath = options.remoteCheckoutPath;
					if (!hosts || !knownHostsPath || !remoteCheckoutPath) {
						fail(`${request.gate.id} is missing prepared-host authority`);
					}
					const host = hosts.find(({ role }) => role === request.requiredHost);
					if (!host) fail(`${request.requiredHost} host is missing`);
					const remoteCommand = [command, ...args]
						.map((value) => shellQuote(value))
						.join(" ");
					const remoteCwd =
						request.cwd === "."
							? remoteCheckoutPath
							: `${remoteCheckoutPath}/${request.cwd}`;
					command = "ssh";
					args = strictSshArgs(knownHostsPath, host.publicIpv4, [
						"bash",
						"-lc",
						shellQuote(
							`set -euo pipefail; cd ${shellQuote(remoteCwd)}; exec ${remoteCommand}`,
						),
					]);
					cwd = ".";
				} else {
					fail(`pair gate ${request.gate.id} requires the controller runner`);
				}
				const recorded = await this.#record(context, {
					sequence: request.sequence,
					operationId: `gate-${request.gate.id}`,
					phase: request.gate.phase,
					command,
					args,
					cwd,
					timeoutMs: request.timeoutMs,
					...(options.signal ? { signal: options.signal } : {}),
				});
				return {
					receipt: recorded.receipt,
					receiptPath: recorded.receiptPath,
				};
			},
		};
	}

	async #localGates(request: RigBackendActionRequest): Promise<void> {
		this.#beforeDeadline(request.context, "local-gates");
		const bounded = this.#deadlineSignal(
			request.context,
			request.signal,
			request.cleanupOnly,
		);
		try {
			const index = await this.#runGates(
				request.context,
				"LOCAL",
				{},
				this.#gateRunner(request.context, { signal: bounded.signal }),
			);
			this.#appendState(
				request.context,
				this.#state(request.context),
				"RESULT",
				"local-gates-recorded",
				{
					complete: index.complete,
					indexPath: portablePath(
						request.context.root,
						join(request.context.root, "gates", "local", "latest.json"),
						"local gate index",
					),
				},
			);
			if (!index.complete) fail("complete LOCAL gate phase did not pass");
		} finally {
			bounded.dispose();
		}
	}

	async #inventory(request: RigBackendActionRequest): Promise<void> {
		if (!request.cleanupOnly) {
			this.#beforeDeadline(request.context, "provider-inventory");
		}
		const state = this.#state(request.context);
		const bounded = this.#deadlineSignal(
			request.context,
			request.signal,
			request.cleanupOnly,
		);
		try {
			const inventory = await inventoryDigitalOcean({
				desired: state.desired,
				provider: this.#provider(request.context, bounded.signal),
				attempt: Math.max(1, state.creationAttempt),
				exactIds: state.ownedResources.map(({ id }) => id),
				allowMissingExact: state.lifecycle === "DESTROYING",
			});
			this.#appendState(
				request.context,
				state,
				"RESULT",
				"provider-inventory-recorded",
				{
					observedAt: inventory.observedAt,
					managementIds: inventory.managementInventory.map(({ id }) => id),
					currentRunIds: inventory.currentRunInventory.map(({ id }) => id),
					exactIds: inventory.exactInventory.map(({ id }) => id),
				},
			);
		} finally {
			bounded.dispose();
		}
	}

	async #ensure(request: RigBackendActionRequest): Promise<void> {
		const bounded = this.#deadlineSignal(
			request.context,
			request.signal,
			request.cleanupOnly,
		);
		try {
			const result = await ensureDigitalOceanRig({
				journalPath: this.#journalPath(request.context),
				intentPath: join(request.context.root, "create-intent.json"),
				provider: this.#provider(request.context, bounded.signal),
				clock: this.#clock,
				randomNonce: this.#randomId,
				randomId: this.#randomId,
				cleanupOnly: request.cleanupOnly,
				recordProviderMutation: (mutation) =>
					this.#recordProviderMutation(request.context, mutation),
			});
			if (result.kind === "INVENTORY_AMBIGUOUS") {
				fail(
					`DigitalOcean inventory is ambiguous: ${(result.reasons ?? []).join("; ")}`,
				);
			}
			if (
				result.kind !== "FAILED" &&
				result.state.lifecycle !== "PROVISIONED"
			) {
				fail(`ensure returned unexpected state ${result.state.lifecycle}`);
			}
		} finally {
			bounded.dispose();
		}
	}

	#attemptRoot(context: RigRunContext, attempt: number): string {
		if (attempt !== 1 && attempt !== 2)
			fail("preparation attempt must be 1 or 2");
		return join(context.root, "attempts", `attempt-${attempt}`);
	}

	async #freshPair(
		context: RigRunContext,
		stateValue: RigState,
		signal?: AbortSignal,
	): Promise<[DropletIdentity, DropletIdentity]> {
		const state = validateRigState(stateValue);
		const recorded = this.#ownedPair(state);
		const inventory = await inventoryDigitalOcean({
			desired: state.desired,
			provider: this.#provider(context, signal),
			attempt: Math.max(1, state.creationAttempt),
			exactIds: recorded.map(({ id }) => id),
		});
		if (
			inventory.managementInventory.length !== 2 ||
			inventory.currentRunInventory.length !== 2 ||
			inventory.exactInventory.length !== 2
		) {
			fail("fresh provider inventory is not the exact owned pair");
		}
		const freshById = new Map(
			inventory.exactInventory.map((identity) => [identity.id, identity]),
		);
		for (const expected of recorded) {
			const fresh = freshById.get(expected.id);
			if (!fresh || canonicalJson(fresh) !== canonicalJson(expected)) {
				fail(`fresh provider identity changed for Droplet ${expected.id}`);
			}
		}
		const server = inventory.exactInventory.find(
			({ role }) => role === "server",
		);
		const generator = inventory.exactInventory.find(
			({ role }) => role === "generator",
		);
		if (!server || !generator) fail("fresh exact pair has missing roles");
		return [server, generator];
	}

	async #buildCandidateBundle(
		context: RigRunContext,
		attemptRoot: string,
		commit: string,
		signal?: AbortSignal,
	): Promise<string> {
		const repository = join(attemptRoot, "bundle-repository.git");
		const bundle = join(attemptRoot, "candidate.bundle");
		if (existsSync(repository) || existsSync(bundle)) {
			fail("partial candidate-bundle workspace already exists");
		}
		mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
		const commands = [
			{
				id: "bundle-init-bare",
				args: ["init", "--bare", repository],
			},
			{
				id: "bundle-fetch-exact-head",
				args: [
					"--git-dir",
					repository,
					"fetch",
					"--no-tags",
					this.#repositoryPath,
					`+${commit}:refs/heads/g6-c32-candidate`,
				],
			},
			{
				id: "bundle-create-exact-head",
				args: [
					"--git-dir",
					repository,
					"bundle",
					"create",
					bundle,
					"refs/heads/g6-c32-candidate",
				],
			},
			{ id: "bundle-verify-local", args: ["bundle", "verify", bundle] },
			{
				id: "bundle-list-exact-head",
				args: ["bundle", "list-heads", bundle, "refs/heads/g6-c32-candidate"],
			},
		] as const;
		let listHeads = "";
		for (const command of commands) {
			const recorded = await this.#record(context, {
				operationId: command.id,
				phase: "PREPARING",
				command: "git",
				args: command.args,
				timeoutMs: 300_000,
				...(signal ? { signal } : {}),
			});
			if (!successful(recorded.receipt)) {
				fail(`${command.id} failed while constructing the candidate bundle`);
			}
			if (command.id === "bundle-list-exact-head") {
				listHeads = readFileSync(recorded.stdoutPath, "utf8");
			}
		}
		const fields = listHeads.trim().split(/\s+/);
		if (
			fields.length < 2 ||
			fields[0] !== commit ||
			fields[1] !== "refs/heads/g6-c32-candidate"
		) {
			fail("candidate bundle does not expose the exact approved transfer ref");
		}
		return requireRegular(bundle, "candidate bundle");
	}

	async #preparationAuthority(
		context: RigRunContext,
		state: RigState,
		attemptRoot: string,
		signal?: AbortSignal,
	): Promise<HostPreparationAuthority> {
		const authority = this.#authority(context);
		const freeze = verifySemanticFreeze(
			parseJson(authority.semantic.freezePath, "semantic freeze"),
			{ repositoryPath: this.#repositoryPath },
		);
		const bundlePath = await this.#buildCandidateBundle(
			context,
			attemptRoot,
			freeze.authority.candidate.commit,
			signal,
		);
		const remoteRoot = `/opt/g6/run/${context.runId}-attempt-${state.creationAttempt}`;
		const remoteCheckoutPath = `${remoteRoot}/source`;
		const retainedRoot = join(attemptRoot, "retained");
		const sharedProbePath = `${remoteCheckoutPath}/tools/load/g6-c32-linux-smoke-probe.sh`;
		const value: HostPreparationAuthority = {
			packages: {
				common: [
					"ca-certificates",
					"curl",
					"git",
					"unzip",
					"jq",
					"rsync",
					"iperf3",
					"build-essential",
					"clang",
					"llvm",
					"libbpf-dev",
					"ethtool",
					"iproute2",
					"openssl",
					"pkg-config",
					"linux-tools-common",
					"linux-tools-generic",
					"cmake",
					"ninja-build",
				],
				server: [],
				generator: [],
			},
			bun: {
				version: "1.3.14",
				binaryPath: "/opt/g6/bin/bun",
				archiveUrl:
					"https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip",
				archiveSha256:
					"951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
			},
			rust: {
				toolchain: "1.95.0",
				rustcVersion: "rustc 1.95.0 (59807616e 2026-04-14)",
				cargoVersion: "cargo 1.95.0 (f2d3ce0bd 2026-03-21)",
				installerUrl:
					"https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init",
				installerSha256:
					"4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10",
			},
			source: {
				commit: freeze.authority.candidate.commit,
				tree: freeze.authority.candidate.tree,
				bundlePath,
				bundleSha256: sha256(readFileSync(bundlePath)),
				remoteBundlePath: `${remoteRoot}/candidate.bundle`,
				remoteCheckoutPath,
				transferRef: "refs/heads/g6-c32-candidate",
			},
			artifacts: {
				nativeRemotePath: `${remoteCheckoutPath}/crates/native/webtransport-native.linux-x64-gnu.node`,
				generatorRemotePath: `${remoteCheckoutPath}/target/release/mmo-client`,
				nativeRetainedPath: join(retainedRoot, "native-addon.node"),
				generatorRetainedPath: join(retainedRoot, "mmo-client"),
			},
			linuxSmoke: {
				remoteScriptPath: `${remoteCheckoutPath}/tools/load/g6-c32-linux-smoke.sh`,
				remoteEvidenceRoot: `${remoteRoot}/linux-smoke`,
				retainedEvidenceRoot: join(attemptRoot, "linux-smoke"),
				unameBinaryPath: "/usr/bin/uname",
				timeoutBinaryPath: "/usr/bin/timeout",
				server: {
					boundedProbePath: sharedProbePath,
					steeringProbePath: sharedProbePath,
					bpfProbePath: sharedProbePath,
				},
				generator: {
					fixedPortProbePath: sharedProbePath,
					boundedProbePath: sharedProbePath,
				},
			},
		};
		const record: PreparationAuthorityRecord = {
			schema: PREPARATION_AUTHORITY_SCHEMA,
			envelope: {
				recordedAt: validateRfc3339Millis(
					this.#clock.wallNow(),
					"preparation authority recordedAt",
				),
				sequence: this.#nextEvidenceSequence(context),
				runId: context.runId,
				phase: "PREPARING",
				operationId: "preparation-authority",
				clockSource: "offrunner",
			},
			authority: value,
		};
		writeExclusive(
			join(attemptRoot, "preparation-authority.json"),
			canonicalJson(record),
		);
		return value;
	}

	#readPreparationAuthority(attemptRoot: string): HostPreparationAuthority {
		const path = join(attemptRoot, "preparation-authority.json");
		const raw = readFileSync(path, "utf8");
		const value = parseJson(path, "preparation authority");
		if (
			!isRecord(value) ||
			value.schema !== PREPARATION_AUTHORITY_SCHEMA ||
			!isRecord(value.envelope) ||
			!isRecord(value.authority)
		) {
			fail("preparation authority record is invalid");
		}
		validateRfc3339Millis(
			value.envelope.recordedAt,
			"preparation authority recordedAt",
		);
		if (canonicalJson(value) !== raw) {
			fail("preparation authority record is not canonical JSON");
		}
		return value.authority as HostPreparationAuthority;
	}

	async #captureKnownHostsWithRetry(
		context: RigRunContext,
		hosts: readonly [DropletIdentity, DropletIdentity],
		knownHostsPath: string,
		receiptPath: string,
		signal?: AbortSignal,
	): Promise<void> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= 30; attempt += 1) {
			if (signal?.aborted) fail("host-key capture was cancelled");
			this.#beforeDeadline(context, `host-key-capture-${attempt}`);
			try {
				await captureKnownHosts({
					runId: context.runId,
					hosts,
					knownHostsPath,
					receiptPath,
					runner: this.#hostRunner(context, signal),
					clock: this.#clock,
					randomId: this.#randomId,
				});
				return;
			} catch (error) {
				lastError = error;
				if (existsSync(knownHostsPath) || existsSync(receiptPath)) throw error;
				if (attempt < 30) await Bun.sleep(5_000);
			}
		}
		throw lastError;
	}

	async #replacePreparationPair(
		context: RigRunContext,
		signal?: AbortSignal,
	): Promise<RigState> {
		const result = await ensureDigitalOceanRig({
			journalPath: this.#journalPath(context),
			intentPath: join(context.root, "create-intent.json"),
			provider: this.#provider(context, signal),
			clock: this.#clock,
			randomNonce: this.#randomId,
			randomId: this.#randomId,
			forceRecreate: true,
		});
		if (
			(result.kind !== "PROVISIONED" && result.kind !== "REUSED") ||
			result.state.lifecycle !== "PROVISIONED"
		) {
			fail(`preparation replacement failed with ${result.kind}`);
		}
		return result.state;
	}

	async #prepareAttempt(
		context: RigRunContext,
		state: RigState,
		signal?: AbortSignal,
	): Promise<void> {
		const attemptRoot = this.#attemptRoot(context, state.creationAttempt);
		const preparationReceiptPath = join(
			attemptRoot,
			"preparation-receipt.json",
		);
		let preparationAuthority: HostPreparationAuthority;
		if (existsSync(preparationReceiptPath)) {
			readCanonicalRecord(
				preparationReceiptPath,
				"host preparation receipt",
				validateHostPreparationReceipt,
			);
			preparationAuthority = this.#readPreparationAuthority(attemptRoot);
		} else {
			if (existsSync(attemptRoot)) {
				fail("partial preparation attempt requires pair replacement");
			}
			const hosts = await this.#freshPair(context, state, signal);
			mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
			const knownHostsPath = join(attemptRoot, "known_hosts");
			const knownHostsReceiptPath = join(
				attemptRoot,
				"known-hosts-receipt.json",
			);
			await this.#captureKnownHostsWithRetry(
				context,
				hosts,
				knownHostsPath,
				knownHostsReceiptPath,
				signal,
			);
			await waitForSshReadiness({
				runId: context.runId,
				hosts,
				knownHostsPath,
				runner: this.#hostRunner(context, signal),
				maxAttempts: 45,
				waitBetweenAttempts: async () => {
					if (signal?.aborted) fail("SSH readiness was cancelled");
					this.#beforeDeadline(context, "ssh-readiness-wait");
					await Bun.sleep(5_000);
				},
			});
			preparationAuthority = await this.#preparationAuthority(
				context,
				state,
				attemptRoot,
				signal,
			);
			await prepareHosts({
				runId: context.runId,
				hosts,
				knownHostsPath,
				authority: preparationAuthority,
				runner: this.#hostRunner(context, signal),
				clock: this.#clock,
				receiptPath: preparationReceiptPath,
				randomId: this.#randomId,
			});
		}

		const hosts = await this.#freshPair(context, this.#state(context), signal);
		const knownHostsPath = join(attemptRoot, "known_hosts");
		const gateIndex = await this.#runGates(
			context,
			"PREPARED_HOST",
			{
				G6_C32_REMOTE_BUNDLE_PATH: preparationAuthority.source.remoteBundlePath,
				G6_C32_REMOTE_SMOKE_SCRIPT:
					preparationAuthority.linuxSmoke.remoteScriptPath,
				G6_C32_REMOTE_SMOKE_SERVER_EVIDENCE: `${preparationAuthority.linuxSmoke.remoteEvidenceRoot}/gate-server`,
				G6_C32_REMOTE_SMOKE_GENERATOR_EVIDENCE: `${preparationAuthority.linuxSmoke.remoteEvidenceRoot}/gate-generator`,
				G6_C32_REMOTE_ROLLBACK_SCRIPT: `${preparationAuthority.source.remoteCheckoutPath}/tools/load/g6-c32-rollback.sh`,
				G6_C32_REMOTE_ROLLBACK_EVIDENCE: `${preparationAuthority.linuxSmoke.remoteEvidenceRoot}/rollback-gate`,
			},
			this.#gateRunner(context, {
				signal,
				hosts,
				knownHostsPath,
				remoteCheckoutPath: preparationAuthority.source.remoteCheckoutPath,
			}),
		);
		if (!gateIndex.complete)
			fail("complete PREPARED_HOST gate phase did not pass");
	}

	async #prepare(request: RigBackendActionRequest): Promise<void> {
		if (request.cleanupOnly || request.signal?.aborted) {
			fail("host preparation is disabled during cleanup or cancellation");
		}
		const bounded = this.#deadlineSignal(
			request.context,
			request.signal,
			false,
		);
		try {
			let state = this.#state(request.context);
			if (
				state.lifecycle !== "PROVISIONED" &&
				state.lifecycle !== "PREPARING"
			) {
				fail(`prepare is not valid from ${state.lifecycle}`);
			}
			if (state.lifecycle === "PROVISIONED") {
				state = this.#appendState(
					request.context,
					validateRigState({ ...state, lifecycle: "PREPARING" }),
					"TRANSITION",
					"begin-host-preparation",
					{ attempt: state.creationAttempt },
				);
			}

			for (;;) {
				const attemptRoot = this.#attemptRoot(
					request.context,
					state.creationAttempt,
				);
				const receiptPath = join(attemptRoot, "preparation-receipt.json");
				if (existsSync(attemptRoot) && !existsSync(receiptPath)) {
					if (state.creationAttempt >= 2) {
						fail(
							"second preparation attempt was interrupted before its receipt",
						);
					}
					state = await this.#replacePreparationPair(
						request.context,
						bounded.signal,
					);
					state = this.#appendState(
						request.context,
						validateRigState({ ...state, lifecycle: "PREPARING" }),
						"RECOVERY",
						"retry-interrupted-preparation",
						{ attempt: state.creationAttempt },
					);
					continue;
				}
				try {
					this.#beforeDeadline(request.context, "prepare-hosts");
					await this.#prepareAttempt(request.context, state, bounded.signal);
					this.#appendState(
						request.context,
						validateRigState({
							...this.#state(request.context),
							lifecycle: "PREPARED",
						}),
						"TRANSITION",
						"host-preparation-complete",
						{
							attempt: state.creationAttempt,
							preparationReceiptPath: receiptPath,
						},
					);
					return;
				} catch (error) {
					this.#appendState(
						request.context,
						this.#state(request.context),
						"RESULT",
						"host-preparation-attempt-failed",
						{
							attempt: state.creationAttempt,
							error: error instanceof Error ? error.message : String(error),
						},
					);
					if (
						bounded.signal?.aborted ||
						Date.now() >= Date.parse(request.context.deadline) ||
						state.creationAttempt >= 2
					) {
						throw error;
					}
					state = await this.#replacePreparationPair(
						request.context,
						bounded.signal,
					);
					state = this.#appendState(
						request.context,
						validateRigState({ ...state, lifecycle: "PREPARING" }),
						"RECOVERY",
						"retry-failed-preparation",
						{ attempt: state.creationAttempt },
					);
				}
			}
		} finally {
			bounded.dispose();
		}
	}

	#remoteIdentityCommand(
		authority: HostPreparationAuthority,
		role: "server" | "generator",
	): string[] {
		const binaryPath =
			role === "server"
				? authority.artifacts.nativeRemotePath
				: authority.artifacts.generatorRemotePath;
		const kind = role === "server" ? "native-addon" : "mmo-client";
		const program = `
import { readFileSync } from "node:fs";
const [checkout, binary, kind] = process.argv.slice(1);
const text = (command, args, cwd) => {
  const result = Bun.spawnSync([command, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};
const osRelease = Object.fromEntries(readFileSync("/etc/os-release", "utf8").split("\\n").filter(Boolean).map((line) => { const index=line.indexOf("="); const key=line.slice(0,index); let value=line.slice(index+1); if(value.startsWith('"')&&value.endsWith('"')) value=value.slice(1,-1); return [key,value]; }));
const record = {
  schema: "g6-c32-remote-host-identity/1",
  observedAt: new Date().toISOString(),
  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  source: { commit: text("git", ["rev-parse", "HEAD"], checkout), tree: text("git", ["rev-parse", "HEAD^{tree}"], checkout), statusPorcelain: text("git", ["status", "--porcelain", "--untracked-files=all"], checkout) },
  runtime: { os: text("uname", ["-s"], checkout), osRelease: osRelease.PRETTY_NAME ?? "unknown", kernel: text("uname", ["-r"], checkout), bunVersion: text("/opt/g6/bin/bun", ["--version"], checkout), rustcVersion: text("/root/.cargo/bin/rustc", ["--version"], checkout), cargoVersion: text("/root/.cargo/bin/cargo", ["--version"], checkout) },
  binary: { kind, path: binary, sha256: text("sha256sum", [binary], checkout).split(/\\s+/)[0] },
};
process.stdout.write(JSON.stringify(record) + "\\n");
`.trim();
		const command = [
			authority.bun.binaryPath,
			"-e",
			program,
			authority.source.remoteCheckoutPath,
			binaryPath,
			kind,
		]
			.map((value) => shellQuote(value))
			.join(" ");
		return ["bash", "-lc", shellQuote(`set -euo pipefail; exec ${command}`)];
	}

	async #bind(request: RigBackendActionRequest): Promise<void> {
		if (request.cleanupOnly || request.signal?.aborted) {
			fail("host binding is disabled during cleanup or cancellation");
		}
		this.#beforeDeadline(request.context, "host-binding");
		const bounded = this.#deadlineSignal(
			request.context,
			request.signal,
			false,
		);
		try {
			let state = this.#state(request.context);
			if (state.lifecycle !== "PREPARED" && state.lifecycle !== "BINDING") {
				fail(`bind is not valid from ${state.lifecycle}`);
			}
			const hosts = await this.#freshPair(
				request.context,
				state,
				bounded.signal,
			);
			const attemptRoot = this.#attemptRoot(
				request.context,
				state.creationAttempt,
			);
			const preparationAuthority = this.#readPreparationAuthority(attemptRoot);
			const preparationReceiptPath = requireRegular(
				join(attemptRoot, "preparation-receipt.json"),
				"preparation receipt",
			);
			const knownHostsPath = requireRegular(
				join(attemptRoot, "known_hosts"),
				"known_hosts",
			);
			const knownHostsReceiptPath = requireRegular(
				join(attemptRoot, "known-hosts-receipt.json"),
				"known_hosts receipt",
			);
			const identityRoot = join(attemptRoot, "identity");
			const identityIndexPath = join(identityRoot, "identity-index.json");
			let packets: {
				server: HostIdentityPacket;
				generator: HostIdentityPacket;
			};
			let operationPaths: { server: string; generator: string };
			if (existsSync(identityIndexPath)) {
				const index = parseJson(identityIndexPath, "identity index");
				if (
					!isRecord(index) ||
					!isRecord(index.envelope) ||
					!isRecord(index.packetPaths) ||
					!isRecord(index.operationReceiptPaths)
				) {
					fail("identity index is invalid");
				}
				validateRfc3339Millis(
					index.envelope.recordedAt,
					"identity index recordedAt",
				);
				const serverPacketPath = String(index.packetPaths.server ?? "");
				const generatorPacketPath = String(index.packetPaths.generator ?? "");
				packets = {
					server: parseJson(
						serverPacketPath,
						"server identity",
					) as HostIdentityPacket,
					generator: parseJson(
						generatorPacketPath,
						"generator identity",
					) as HostIdentityPacket,
				};
				operationPaths = {
					server: String(index.operationReceiptPaths.server ?? ""),
					generator: String(index.operationReceiptPaths.generator ?? ""),
				};
			} else {
				mkdirSync(identityRoot, { recursive: true, mode: 0o700 });
				const runner = this.#hostRunner(request.context, bounded.signal);
				const sequence = this.#nextEvidenceSequence(request.context);
				const server = await collectHostIdentityPacket({
					runId: request.context.runId,
					sequence,
					host: hosts[0],
					knownHostsPath,
					runner,
					remoteIdentityCommand: this.#remoteIdentityCommand(
						preparationAuthority,
						"server",
					),
					maxClockSkewMilliseconds: 30_000,
				});
				const generator = await collectHostIdentityPacket({
					runId: request.context.runId,
					sequence: sequence + 1,
					host: hosts[1],
					knownHostsPath,
					runner,
					remoteIdentityCommand: this.#remoteIdentityCommand(
						preparationAuthority,
						"generator",
					),
					maxClockSkewMilliseconds: 30_000,
				});
				packets = { server: server.packet, generator: generator.packet };
				operationPaths = {
					server: server.operationReceiptPath,
					generator: generator.operationReceiptPath,
				};
				const packetPaths = {
					server: join(identityRoot, "server.json"),
					generator: join(identityRoot, "generator.json"),
				};
				writeExclusive(packetPaths.server, canonicalJson(packets.server));
				writeExclusive(packetPaths.generator, canonicalJson(packets.generator));
				writeExclusive(
					identityIndexPath,
					canonicalJson({
						schema: "g6-c32-host-identity-index/1",
						envelope: {
							recordedAt: this.#clock.wallNow(),
							sequence: sequence + 2,
							runId: request.context.runId,
							phase: "BINDING",
							operationId: "host-identity-index",
							clockSource: "offrunner",
						},
						packetPaths,
						operationReceiptPaths: operationPaths,
					}),
				);
			}

			validateHostIdentityPair({
				runId: request.context.runId,
				packets: [packets.server, packets.generator],
				expectedHosts: hosts,
				expectedSource: {
					commit: preparationAuthority.source.commit,
					tree: preparationAuthority.source.tree,
				},
				expectedRuntime: {
					os: "Linux",
					bunVersion: preparationAuthority.bun.version,
					rustcVersion: preparationAuthority.rust.rustcVersion,
					cargoVersion: preparationAuthority.rust.cargoVersion,
				},
				retainedBinaries: {
					server: preparationAuthority.artifacts.nativeRetainedPath,
					generator: preparationAuthority.artifacts.generatorRetainedPath,
				},
				expectedBinaryPaths: {
					server: preparationAuthority.artifacts.nativeRemotePath,
					generator: preparationAuthority.artifacts.generatorRemotePath,
				},
				maxClockSkewMilliseconds: 30_000,
			});

			const boundRoot = join(request.context.root, "bound");
			if (existsSync(boundRoot)) {
				const verified = verifyBoundFreeze(boundRoot, {
					repositoryPath: this.#repositoryPath,
				});
				if (
					verified.runId !== request.context.runId ||
					verified.hostBinding.authority.hosts.server.provider.id !==
						hosts[0].id ||
					verified.hostBinding.authority.hosts.generator.provider.id !==
						hosts[1].id
				) {
					fail("existing bound freeze differs from the current exact pair");
				}
			} else {
				const localIndex = this.#gateIndex(request.context, "LOCAL");
				const preparedIndex = this.#gateIndex(request.context, "PREPARED_HOST");
				if (!localIndex?.complete || !preparedIndex?.complete) {
					fail(
						"host binding requires complete local and prepared gate indices",
					);
				}
				await bindHostFreeze(
					{
						runId: request.context.runId,
						repositoryPath: this.#repositoryPath,
						provisioningRoot: request.context.root,
						outputName: "bound",
						semanticFreezePath: this.#authority(request.context).semantic
							.freezePath,
						semanticApprovalPath: this.#authority(request.context).semantic
							.approvalPath,
						rigJournalPath: this.#journalPath(request.context),
						knownHostsPath,
						knownHostsReceiptPath,
						preparationReceiptPath,
						bundlePath: preparationAuthority.source.bundlePath,
						retainedNativePath:
							preparationAuthority.artifacts.nativeRetainedPath,
						retainedGeneratorPath:
							preparationAuthority.artifacts.generatorRetainedPath,
						identityPacketPaths: {
							server: join(identityRoot, "server.json"),
							generator: join(identityRoot, "generator.json"),
						},
						identityOperationReceiptPaths: operationPaths,
						gateReceiptPaths: [
							...localIndex.receiptPaths,
							...preparedIndex.receiptPaths,
						],
						sequenceStart: this.#nextEvidenceSequence(request.context),
					},
					{ clock: this.#clock, randomId: this.#randomId },
				);
			}
			state = this.#state(request.context);
			this.#appendState(
				request.context,
				validateRigState({ ...state, lifecycle: "BOUND" }),
				"TRANSITION",
				"host-bound-freeze-ready",
				{ boundRoot },
			);
		} finally {
			bounded.dispose();
		}
	}

	#controllerLaunchPath(context: RigRunContext): string {
		return join(context.root, "controller-launch.json");
	}

	#campaignEvidenceRoot(context: RigRunContext): string {
		return join(context.root, `campaign-${context.runId}`);
	}

	#readControllerLaunch(context: RigRunContext): ControllerLaunch {
		const path = requireRegular(
			this.#controllerLaunchPath(context),
			"controller launch",
		);
		const launch = readCanonicalRecord(
			path,
			"controller launch",
			validateControllerLaunch,
		);
		if (
			launch.envelope.runId !== context.runId ||
			launch.cwd !== this.#repositoryPath ||
			launch.deadline !== context.deadline ||
			launch.evidenceRoot !== this.#campaignEvidenceRoot(context)
		) {
			fail("controller launch authority mismatch");
		}
		return launch;
	}

	#validateDispatchAuthorization(
		context: RigRunContext,
		verified: ReturnType<typeof verifyBoundFreeze>,
	): void {
		const path = join(
			this.#campaignEvidenceRoot(context),
			"qualification",
			"dispatch-authorization.json",
		);
		const value = parseJson(path, "dispatch authorization");
		if (!isRecord(value) || !isRecord(value.envelope)) {
			fail("dispatch authorization is invalid");
		}
		validateRfc3339Millis(
			value.envelope.recordedAt,
			"dispatch authorization recordedAt",
		);
		if (
			value.schema !== "g6-c32-dispatch-authorization/1" ||
			value.envelope.runId !== context.runId ||
			value.envelope.phase !== "QUALIFIED" ||
			value.status !== "DISPATCHABLE" ||
			value.dispatchFreezeArtifactSha256 !==
				canonicalArtifactSha256(verified.dispatchFreeze) ||
			value.hostBindingAuthoritySha256 !==
				verified.hostBinding.authoritySha256 ||
			!Array.isArray(value.receipts) ||
			value.receipts.length === 0
		) {
			fail("dispatch authorization does not bind the exact frozen pair");
		}
	}

	#verifyCampaignEvidence(context: RigRunContext): string {
		const root = requireDirectory(
			this.#campaignEvidenceRoot(context),
			"campaign evidence root",
		);
		const status = readFileSync(join(root, "RUN_STATUS"), "utf8").trim();
		if (!TERMINAL_CAMPAIGN_STATUSES.has(status)) {
			fail(`campaign RUN_STATUS is not terminal: ${status || "<empty>"}`);
		}
		const manifestPath = requireRegular(
			join(root, "artifact-manifest.json"),
			"campaign artifact manifest",
		);
		const manifest = readCanonicalRecord(
			manifestPath,
			"campaign artifact manifest",
			validateArtifactManifestRecord,
		);
		if (manifest.envelope.runId !== context.runId) {
			fail("campaign artifact manifest runId mismatch");
		}
		for (const entry of manifest.entries) {
			const path = inside(root, join(root, entry.path), "manifest artifact");
			const bytes = readFileSync(requireRegular(path, "manifest artifact"));
			if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
				fail(`campaign manifest mismatch for ${entry.path}`);
			}
		}
		const sums = readFileSync(join(root, "SHA256SUMS"), "utf8");
		const seen = new Set<string>();
		for (const line of sums.trimEnd().split("\n")) {
			const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
			if (!match?.[1] || !match[2] || seen.has(match[2])) {
				fail("campaign SHA256SUMS is malformed or duplicated");
			}
			seen.add(match[2]);
			const path = inside(root, join(root, match[2]), "SHA256SUMS artifact");
			if (
				sha256(readFileSync(requireRegular(path, "SHA256SUMS artifact"))) !==
				match[1]
			) {
				fail(`campaign SHA256SUMS mismatch for ${match[2]}`);
			}
		}
		const expected = listRegularFiles(root)
			.map((path) => portablePath(root, path, "campaign evidence"))
			.filter((path) => path !== "SHA256SUMS")
			.sort();
		if (canonicalJson([...seen].sort()) !== canonicalJson(expected)) {
			fail("campaign SHA256SUMS does not cover the fresh evidence walk");
		}
		return status;
	}

	#controllerAdapter(
		context: RigRunContext,
		verified: ReturnType<typeof verifyBoundFreeze>,
		sequence: number,
	): CommandAdapter {
		return {
			execute: async (spec, signal) => {
				let child: ReturnType<typeof Bun.spawn>;
				try {
					child = Bun.spawn([spec.command, ...spec.args], {
						cwd: this.#repositoryPath,
						env: { ...spec.env },
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					});
				} catch (error) {
					return {
						stdout: "",
						stderr: `controller start failed: ${String(error)}\n`,
						status: { outcome: "FAILED", exitCode: null, signal: null },
					};
				}
				const startedAt = validateRfc3339Millis(
					this.#clock.wallNow(),
					"controller launch startedAt",
				);
				const launch: ControllerLaunch = {
					schema: CONTROLLER_LAUNCH_SCHEMA,
					envelope: {
						recordedAt: startedAt,
						sequence,
						runId: context.runId,
						phase: "QUALIFYING",
						operationId: "controller-launch",
						clockSource: "offrunner",
					},
					pid: child.pid,
					command: spec.command,
					args: [...spec.args],
					cwd: this.#repositoryPath,
					deadline: context.deadline,
					startedAt,
					startedMonotonicNs: this.#clock.monotonicNowNs().toString(10),
					operationSequence: sequence,
					evidenceRoot: this.#campaignEvidenceRoot(context),
				};
				writeExclusive(
					this.#controllerLaunchPath(context),
					canonicalJson(launch),
				);
				const stdoutPromise = new Response(
					child.stdout as ReadableStream<Uint8Array>,
				).arrayBuffer();
				const stderrPromise = new Response(
					child.stderr as ReadableStream<Uint8Array>,
				).arrayBuffer();
				let exitCode: number | undefined;
				let terminationSignal: string | null = null;
				let runningRecorded = false;
				while (exitCode === undefined) {
					const marker = await Promise.race([
						child.exited.then((code) => ({ kind: "exit" as const, code })),
						Bun.sleep(250).then(() => ({ kind: "tick" as const })),
					]);
					if (marker.kind === "exit") {
						exitCode = marker.code;
						break;
					}
					const authorizationPath = join(
						this.#campaignEvidenceRoot(context),
						"qualification",
						"dispatch-authorization.json",
					);
					if (!runningRecorded && existsSync(authorizationPath)) {
						this.#validateDispatchAuthorization(context, verified);
						const state = this.#state(context);
						this.#appendState(
							context,
							validateRigState({ ...state, lifecycle: "RUNNING" }),
							"TRANSITION",
							"controller-dispatch-authorized",
							{ authorizationPath },
						);
						runningRecorded = true;
					}
					if (signal?.aborted) {
						terminationSignal = "SIGTERM";
						child.kill("SIGTERM");
						const terminated = await Promise.race([
							child.exited.then((code) => ({ exited: true as const, code })),
							Bun.sleep(10_000).then(() => ({ exited: false as const })),
						]);
						if (terminated.exited) exitCode = terminated.code;
						else {
							terminationSignal = "SIGKILL";
							child.kill("SIGKILL");
							exitCode = await child.exited;
						}
					}
				}
				const [stdout, stderr] = await Promise.all([
					stdoutPromise,
					stderrPromise,
				]);
				const state = this.#state(context);
				this.#appendState(
					context,
					validateRigState({
						...state,
						evidence: {
							...state.evidence,
							controllerExited: true,
							cleanupDisposition: "CLEANUP_COMPLETE",
						},
					}),
					"RESULT",
					"controller-process-exited",
					{ pid: child.pid, exitCode, terminationSignal },
				);
				if (signal?.aborted) {
					return {
						stdout: new Uint8Array(stdout),
						stderr: new Uint8Array(stderr),
						status: {
							outcome: "CANCELLED",
							exitCode: null,
							signal: terminationSignal,
						},
					};
				}
				return {
					stdout: new Uint8Array(stdout),
					stderr: new Uint8Array(stderr),
					status:
						exitCode === 0
							? { outcome: "SUCCEEDED", exitCode: 0, signal: null }
							: {
									outcome: "FAILED",
									exitCode: exitCode ?? null,
									signal: terminationSignal,
								},
				};
			},
		};
	}

	async #dispatch(request: RigBackendActionRequest): Promise<void> {
		if (request.cleanupOnly || request.signal?.aborted) {
			fail("controller dispatch is disabled during cleanup or cancellation");
		}
		this.#beforeDeadline(request.context, "controller-dispatch");
		const boundRoot = join(request.context.root, "bound");
		const verified = verifyBoundFreeze(boundRoot, {
			repositoryPath: this.#repositoryPath,
		});
		if (existsSync(this.#controllerLaunchPath(request.context))) {
			fail(
				"controller launch intent already exists; use resume, never redispatch",
			);
		}
		const bounded = this.#deadlineSignal(
			request.context,
			request.signal,
			false,
		);
		try {
			const current = this.#state(request.context);
			this.#appendState(
				request.context,
				validateRigState({
					...current,
					lifecycle: "QUALIFYING",
					evidence: {
						...current.evidence,
						controllerExited: false,
						cleanupDisposition: null,
					},
				}),
				"INTENT",
				"launch-locked-controller",
				{ boundRoot, deadline: request.context.deadline },
			);
			const controller = resolve(
				this.#repositoryPath,
				verified.semanticFreeze.authority.controller.path,
			);
			const budgetPolicy = resolve(
				this.#repositoryPath,
				verified.semanticFreeze.authority.budgetPolicy.path,
			);
			const spendLedger = this.#spendLedgerPath(request.context);
			const gateRunner: GateOperationRunner = {
				execute: async (gateRequest) => {
					if (gateRequest.requiredHost !== "pair") {
						fail("controller runner received a non-pair gate");
					}
					const args = [
						controller,
						"run",
						"--bound-root",
						boundRoot,
						"--repository",
						this.#repositoryPath,
						"--budget-policy",
						budgetPolicy,
						"--spend-ledger",
						spendLedger,
						"--deadline",
						request.context.deadline,
					];
					const recorded = await this.#record(request.context, {
						sequence: gateRequest.sequence,
						operationId: `gate-${gateRequest.gate.id}`,
						phase: gateRequest.gate.phase,
						command: "bash",
						args,
						timeoutMs: gateRequest.timeoutMs,
						...(bounded.signal ? { signal: bounded.signal } : {}),
						adapter: this.#controllerAdapter(
							request.context,
							verified,
							gateRequest.sequence,
						),
					});
					return {
						receipt: recorded.receipt,
						receiptPath: recorded.receiptPath,
					};
				},
			};
			const index = await this.#runGates(
				request.context,
				"LOCKED_PAIR",
				{
					G6_C32_BOUND_ROOT: boundRoot,
					G6_C32_REPOSITORY_PATH: this.#repositoryPath,
				},
				gateRunner,
			);
			if (!index.complete) fail("locked controller gate did not complete");
			this.#validateDispatchAuthorization(request.context, verified);
			const campaignStatus = this.#verifyCampaignEvidence(request.context);
			const state = this.#state(request.context);
			this.#appendState(
				request.context,
				validateRigState({
					...state,
					lifecycle: "TERMINAL",
					evidence: {
						...state.evidence,
						controllerExited: true,
						cleanupDisposition: "CLEANUP_COMPLETE",
					},
				}),
				"TRANSITION",
				"campaign-terminal-evidence-verified",
				{ campaignStatus },
			);
		} finally {
			bounded.dispose();
		}
	}

	async #localProcessCommand(
		context: RigRunContext,
		pid: number,
	): Promise<string | null> {
		const result = await this.#record(context, {
			operationId: "recover-controller-process-identity",
			phase: "RECOVERY",
			command: "/bin/ps",
			args: ["-p", String(pid), "-o", "command="],
			timeoutMs: 10_000,
		});
		if (!successful(result.receipt)) return null;
		const command = readFileSync(result.stdoutPath, "utf8").trim();
		return command === "" ? null : command;
	}

	#expectedControllerCommand(
		context: RigRunContext,
		launch: ControllerLaunch,
	): void {
		const verified = verifyBoundFreeze(join(context.root, "bound"), {
			repositoryPath: this.#repositoryPath,
		});
		const controller = resolve(
			this.#repositoryPath,
			verified.semanticFreeze.authority.controller.path,
		);
		const budgetPolicy = resolve(
			this.#repositoryPath,
			verified.semanticFreeze.authority.budgetPolicy.path,
		);
		const expected = [
			controller,
			"run",
			"--bound-root",
			join(context.root, "bound"),
			"--repository",
			this.#repositoryPath,
			"--budget-policy",
			budgetPolicy,
			"--spend-ledger",
			this.#spendLedgerPath(context),
			"--deadline",
			context.deadline,
		];
		if (
			launch.command !== "bash" ||
			canonicalJson(launch.args) !== canonicalJson(expected)
		) {
			fail("recorded controller command differs from the exact frozen launch");
		}
	}

	async #terminateRecordedController(
		context: RigRunContext,
		launch: ControllerLaunch,
	): Promise<void> {
		for (const [signal, waitMilliseconds] of [
			["TERM", 10_000],
			["KILL", 5_000],
		] as const) {
			if (!processAlive(launch.pid)) return;
			const command = await this.#localProcessCommand(context, launch.pid);
			if (command === null) return;
			if (!launch.args.every((argument) => command.includes(argument))) {
				fail(
					"controller PID was reused by a different process; refusing signal",
				);
			}
			const result = await this.#record(context, {
				operationId: `recover-controller-sig${signal.toLowerCase()}`,
				phase: "RECOVERY",
				command: "/bin/kill",
				args: [`-${signal}`, String(launch.pid)],
				timeoutMs: 10_000,
			});
			if (!successful(result.receipt)) {
				fail(`could not signal recorded controller PID ${launch.pid}`);
			}
			const until = Date.now() + waitMilliseconds;
			while (processAlive(launch.pid) && Date.now() < until) {
				await Bun.sleep(250);
			}
		}
		if (processAlive(launch.pid)) fail("recorded controller did not exit");
	}

	async #recoverHost(
		context: RigRunContext,
		host: DropletIdentity,
		expectedBootId: string,
		knownHostsPath: string,
		role: "server" | "generator",
	): Promise<{ reachable: boolean; bootMatches: boolean; cleanup: boolean }> {
		const runner = this.#hostRunner(context);
		const boot = await runner.execute({
			operationId: `recover-${role}-boot-id`,
			phase: "RECOVERY",
			attempt: 1,
			command: "ssh",
			args: strictSshArgs(knownHostsPath, host.publicIpv4, [
				"cat",
				"/proc/sys/kernel/random/boot_id",
			]),
			timeoutMs: 30_000,
		});
		if (boot.status.outcome !== "SUCCEEDED" || boot.status.exitCode !== 0) {
			return { reachable: false, bootMatches: false, cleanup: false };
		}
		const bootMatches = boot.stdout.trim() === expectedBootId;
		const remoteRoot = `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${context.runId}`;
		const pidFiles =
			role === "server"
				? [
						`${remoteRoot}/qualification/r-up.pid`,
						`${remoteRoot}/qualification/loaded-up.pid`,
					]
				: [
						`${remoteRoot}/qualification/r-down.pid`,
						`${remoteRoot}/qualification/loaded-down.pid`,
					];
		const cleanupFunction = [
			"set -euo pipefail",
			'stop_recorded() { path=$1; needle=$2; [ -f "$path" ] || return 0; pid=$(cat "$path"); case "$pid" in \'\'|*[!0-9]*) return 90;; esac; if [ -r "/proc/$pid/cmdline" ]; then command=$(tr \'\\0\' \' \' <"/proc/$pid/cmdline"); case "$command" in *"$needle"*) kill "$pid" 2>/dev/null || true;; *) return 91;; esac; fi; rm -f "$path"; }',
			...pidFiles.map(
				(path) => `stop_recorded ${shellQuote(path)} ${shellQuote("iperf3")}`,
			),
			"rm -f /etc/security/limits.d/99-g6-rca-nofile.conf",
		];
		if (role === "server") {
			const snapshotPath = join(
				this.#campaignEvidenceRoot(context),
				"qualification",
				"d-sysctls.before",
			);
			if (existsSync(snapshotPath)) {
				for (const line of readFileSync(snapshotPath, "utf8")
					.trim()
					.split("\n")) {
					const [key, value] = line.trim().split(/\s+/);
					if (
						(key === "net.core.rmem_max" ||
							key === "net.core.rmem_default" ||
							key === "net.ipv4.udp_rmem_min") &&
						value &&
						/^\d+$/.test(value)
					) {
						cleanupFunction.push(`sysctl -w ${key}=${value} >/dev/null`);
					}
				}
			}
			cleanupFunction.push(
				`if [ -f /tmp/bench.lock.owner ]; then owner_run=$(jq -r .runId /tmp/bench.lock.owner 2>/dev/null || true); owner_pid=$(jq -r .pid /tmp/bench.lock.owner 2>/dev/null || true); if [ "$owner_run" = ${shellQuote(context.runId)} ]; then case "$owner_pid" in ''|*[!0-9]*) exit 92;; esac; if [ -r "/proc/$owner_pid/cmdline" ]; then owner_command=$(tr '\\0' ' ' <"/proc/$owner_pid/cmdline"); case "$owner_command" in *${shellQuote(context.runId)}*) kill "$owner_pid" 2>/dev/null || true;; *) exit 93;; esac; fi; rm -f /tmp/bench.lock.owner; fi; fi`,
				"flock -n /tmp/bench.lock true",
			);
		}
		const cleanup = await runner.execute({
			operationId: `recover-${role}-cleanup`,
			phase: "RECOVERY",
			attempt: 1,
			command: "ssh",
			args: strictSshArgs(knownHostsPath, host.publicIpv4, [
				"bash",
				"-lc",
				shellQuote(cleanupFunction.join("; ")),
			]),
			timeoutMs: 120_000,
		});
		return {
			reachable: true,
			bootMatches,
			cleanup:
				cleanup.status.outcome === "SUCCEEDED" && cleanup.status.exitCode === 0,
		};
	}

	async #collectRecoveryEvidence(
		context: RigRunContext,
		hosts: readonly [DropletIdentity, DropletIdentity],
		knownHostsPath: string,
	): Promise<boolean> {
		const recoveryRoot = join(
			context.root,
			"recovery",
			`${timestampToken(this.#clock.wallNow())}-${sha256(this.#randomId()).slice(0, 12)}`,
		);
		mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
		let complete = true;
		const remoteRoot = `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${context.runId}`;
		for (const host of hosts) {
			if (host.role !== "server" && host.role !== "generator") {
				fail("recovery host role is missing");
			}
			const destination = join(recoveryRoot, host.role);
			const result = await this.#record(context, {
				operationId: `recover-${host.role}-artifacts`,
				phase: "RECOVERY",
				command: "scp",
				args: strictScpArgs(knownHostsPath, [
					"-r",
					`root@${host.publicIpv4}:${remoteRoot}`,
					destination,
				]),
				timeoutMs: 180_000,
			});
			if (!successful(result.receipt)) complete = false;
		}
		return complete;
	}

	async #recoverLive(request: RigBackendActionRequest): Promise<void> {
		const initial = this.#state(request.context);
		if (initial.lifecycle !== "QUALIFYING" && initial.lifecycle !== "RUNNING") {
			fail(`live recovery is not valid from ${initial.lifecycle}`);
		}
		const verified = verifyBoundFreeze(join(request.context.root, "bound"), {
			repositoryPath: this.#repositoryPath,
		});
		const hosts = await this.#freshPair(request.context, initial);
		const knownHostsPath = join(
			request.context.root,
			"bound",
			"host",
			"known_hosts",
		);
		this.#appendState(
			request.context,
			initial,
			"RECOVERY",
			"begin-live-controller-recovery",
			{ deadline: request.context.deadline },
		);
		let deadlineReached = Date.now() >= Date.parse(request.context.deadline);
		if (existsSync(this.#controllerLaunchPath(request.context))) {
			const launch = this.#readControllerLaunch(request.context);
			this.#expectedControllerCommand(request.context, launch);
			let command = processAlive(launch.pid)
				? await this.#localProcessCommand(request.context, launch.pid)
				: null;
			if (
				command !== null &&
				!launch.args.every((argument) => command?.includes(argument))
			) {
				// A reused PID is not the recorded controller and must never be signalled.
				command = null;
			}
			while (
				command !== null &&
				processAlive(launch.pid) &&
				Date.now() < Date.parse(request.context.deadline)
			) {
				const authorizationPath = join(
					this.#campaignEvidenceRoot(request.context),
					"qualification",
					"dispatch-authorization.json",
				);
				if (
					this.#state(request.context).lifecycle === "QUALIFYING" &&
					existsSync(authorizationPath)
				) {
					this.#validateDispatchAuthorization(request.context, verified);
					const state = this.#state(request.context);
					this.#appendState(
						request.context,
						validateRigState({ ...state, lifecycle: "RUNNING" }),
						"RECOVERY",
						"recover-dispatch-authorization",
						{ authorizationPath },
					);
				}
				await Bun.sleep(1_000);
			}
			deadlineReached = Date.now() >= Date.parse(request.context.deadline);
			if (command !== null && processAlive(launch.pid)) {
				await this.#terminateRecordedController(request.context, launch);
			}
		}

		const serverRecovery = await this.#recoverHost(
			request.context,
			hosts[0],
			verified.hostBinding.authority.hosts.server.bootId,
			knownHostsPath,
			"server",
		);
		const generatorRecovery = await this.#recoverHost(
			request.context,
			hosts[1],
			verified.hostBinding.authority.hosts.generator.bootId,
			knownHostsPath,
			"generator",
		);
		const artifactsCollected = await this.#collectRecoveryEvidence(
			request.context,
			hosts,
			knownHostsPath,
		);
		const reachable = serverRecovery.reachable && generatorRecovery.reachable;
		const clean =
			reachable &&
			serverRecovery.cleanup &&
			generatorRecovery.cleanup &&
			artifactsCollected;
		const disposition = !reachable
			? "RECOVERY_UNREACHABLE"
			: deadlineReached || !clean
				? "RECOVERY_TIMED_OUT"
				: "RECOVERY_CLEAN";
		const state = this.#state(request.context);
		this.#appendState(
			request.context,
			validateRigState({
				...state,
				lifecycle: "TERMINAL",
				evidence: {
					...state.evidence,
					controllerExited: true,
					cleanupDisposition: disposition,
				},
			}),
			"RECOVERY",
			"live-controller-recovery-complete",
			{
				disposition,
				server: serverRecovery,
				generator: generatorRecovery,
				artifactsCollected,
			},
		);
	}

	async #seal(request: RigBackendActionRequest): Promise<void> {
		let state = this.#state(request.context);
		if (state.lifecycle !== "TERMINAL" && state.lifecycle !== "FAILED") {
			state = validateRigState({ ...state, lifecycle: "FAILED" });
			this.#appendState(
				request.context,
				state,
				"TRANSITION",
				"seal-nonterminal-failure",
				{ priorLifecycle: this.#state(request.context).lifecycle },
			);
		}
		if (!state.evidence.controllerExited) {
			fail("cannot seal teardown evidence while the controller may still run");
		}

		let finalGatesComplete = false;
		let finalGateError: string | null = null;
		const boundRoot = join(request.context.root, "bound");
		if (existsSync(boundRoot)) {
			try {
				const index = await this.#runGates(
					request.context,
					"FINAL",
					{
						G6_C32_CANDIDATE_BUNDLE_PATH: join(
							boundRoot,
							"candidate",
							"candidate.bundle",
						),
						G6_C32_BOUND_ROOT: boundRoot,
					},
					this.#gateRunner(request.context, {}),
				);
				finalGatesComplete = index.complete;
			} catch (error) {
				finalGateError = error instanceof Error ? error.message : String(error);
			}
		}
		if (!finalGatesComplete && state.lifecycle === "TERMINAL") {
			state = validateRigState({ ...state, lifecycle: "FAILED" });
		}

		const sealRoot = join(
			request.context.root,
			"seals",
			`${timestampToken(this.#clock.wallNow())}-${sha256(this.#randomId()).slice(0, 12)}`,
		);
		mkdirSync(sealRoot, { recursive: true, mode: 0o700 });
		const recordedAt = validateRfc3339Millis(
			this.#clock.wallNow(),
			"offrunner seal recordedAt",
		);
		const entries: ArtifactManifestEntry[] = [];
		for (const path of listRegularFiles(request.context.root)) {
			const relativePath = portablePath(
				request.context.root,
				path,
				"sealed artifact",
			);
			if (
				relativePath === "RUN_STATUS" ||
				relativePath === "rig-state.json" ||
				relativePath === "create-intent.json" ||
				relativePath === "orchestrator-lock.json" ||
				relativePath === "orchestrator-operations.jsonl" ||
				relativePath.startsWith("seals/")
			) {
				continue;
			}
			const bytes = readFileSync(path);
			entries.push({
				path: `run/${relativePath}`,
				sha256: sha256(bytes),
				bytes: bytes.byteLength,
				recordedAt,
			});
		}
		entries.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		);
		const sequence = this.#nextEvidenceSequence(request.context);
		const manifest = makeArtifactManifestRecord(
			{
				recordedAt,
				sequence,
				runId: request.context.runId,
				phase: "FINAL",
				operationId: "offrunner-artifact-manifest",
				clockSource: "offrunner",
			},
			entries,
		);
		const manifestPath = join(sealRoot, "artifact-manifest.json");
		writeExclusive(manifestPath, canonicalJson(manifest));
		const campaignStatus = existsSync(
			this.#campaignEvidenceRoot(request.context),
		)
			? readFileSync(
					join(this.#campaignEvidenceRoot(request.context), "RUN_STATUS"),
					"utf8",
				).trim()
			: "INCOMPLETE";
		const receipt = {
			schema: SEAL_RECEIPT_SCHEMA,
			envelope: {
				recordedAt: validateRfc3339Millis(
					this.#clock.wallNow(),
					"offrunner seal receipt recordedAt",
				),
				sequence: sequence + 1,
				runId: request.context.runId,
				phase: "FINAL",
				operationId: "offrunner-evidence-seal",
				clockSource: "offrunner",
			},
			status: TERMINAL_CAMPAIGN_STATUSES.has(campaignStatus)
				? campaignStatus
				: "INCOMPLETE",
			finalGatesComplete,
			finalGateError,
			manifestArtifactSha256: canonicalArtifactSha256(manifest),
		};
		const receiptPath = join(sealRoot, "seal-receipt.json");
		writeExclusive(receiptPath, canonicalJson(receipt));
		const sums = [manifestPath, receiptPath]
			.map(
				(path) =>
					`${sha256(readFileSync(path))}  ${portablePath(sealRoot, path, "seal file")}`,
			)
			.join("\n");
		writeExclusive(join(sealRoot, "SHA256SUMS"), `${sums}\n`);
		for (const line of sums.split("\n")) {
			const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
			if (
				!match?.[1] ||
				!match[2] ||
				sha256(readFileSync(join(sealRoot, match[2]))) !== match[1]
			) {
				fail("offrunner seal verification failed");
			}
		}
		state = validateRigState({
			...state,
			evidence: { ...state.evidence, offrunnerEvidenceSealed: true },
		});
		this.#appendState(
			request.context,
			state,
			"RESULT",
			"offrunner-evidence-sealed",
			{
				sealRoot,
				manifestArtifactSha256: canonicalArtifactSha256(manifest),
				finalGatesComplete,
			},
		);
		writeReplacing(
			join(request.context.root, "RUN_STATUS"),
			`${receipt.status}\n`,
			this.#randomId,
		);
	}

	async #destroy(request: RigBackendActionRequest): Promise<void> {
		const result = await destroyDigitalOceanRig({
			journalPath: this.#journalPath(request.context),
			intentPath: join(request.context.root, "create-intent.json"),
			provider: this.#provider(request.context),
			clock: this.#clock,
			randomId: this.#randomId,
			destructionReceiptPath: join(
				request.context.root,
				"destruction-receipt.json",
			),
			recordProviderMutation: (mutation) =>
				this.#recordProviderMutation(request.context, mutation),
			recordEmergencyReconciliation: (recordedAt) =>
				this.#recordEmergencyReconciliation(request.context, recordedAt),
		});
		if (result.state.lifecycle !== "DESTROYED") {
			fail(`destroy returned unexpected state ${result.state.lifecycle}`);
		}
		writeReplacing(
			join(request.context.root, "RUN_STATUS"),
			"DESTROYED\n",
			this.#randomId,
		);
		this.#sealSpendLedger(request.context);
	}

	#markFailed(context: RigRunContext, error: unknown): void {
		const state = this.#state(context);
		if (state.lifecycle === "FAILED" || state.lifecycle === "DESTROYED") return;
		this.#appendState(
			context,
			validateRigState({ ...state, lifecycle: "FAILED" }),
			"TRANSITION",
			"orchestrator-action-failed",
			{ error: error instanceof Error ? error.message : String(error) },
		);
	}
}
