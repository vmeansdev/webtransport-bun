import { spawnSync } from "node:child_process";
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
	statSync,
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
	type ArtifactIdentity,
	type ArtifactManifestEntry,
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	type DispatchFreezeRecord,
	type GeneratedViewContext,
	type HostBindingAuthority,
	type HostBindingHost,
	type HostBindingRecord,
	makeArtifactManifestRecord,
	makeAuthorityRecord,
	makeDispatchFreezeRecord,
	makeHostBindingRecord,
	type OperationReceipt,
	renderExactIdentitySheet,
	renderRegistration,
	renderRunbook,
	type SemanticFreezeAuthority,
	type SemanticFreezeRecord,
	shellQuote,
	validateArtifactManifestRecord,
	validateDispatchFreezeRecord,
	validateHostBindingRecord,
	validateOperationReceipt,
	validateRecordSequence,
	validateReviewReceipt,
	validateSemanticApprovalRecord,
	validateSemanticFreezeRecord,
} from "./g6-c32-freeze-model.ts";
import {
	G6_C32_GATE_CATALOG,
	type GateReceipt,
	validateGateCatalog,
	validateGateReceipt,
} from "./g6-c32-gates.ts";
import {
	type HostIdentityPacket,
	validateHostIdentityPacket,
	validateHostPreparationReceipt,
	validateKnownHostsReceipt,
} from "./g6-c32-host.ts";
import { type CampaignClock, recordOperation } from "./g6-c32-operation.ts";
import { appendRigJournalEvent, readRigJournal } from "./g6-c32-rig-journal.ts";

export const SEMANTIC_FREEZE_SCHEMA_VERSION = "g6-c32-semantic-freeze/1";
export const SEMANTIC_FREEZE_GENERATOR_PATH = "tools/load/g6-c32-freeze.ts";
export const FORBIDDEN_MISE_NODE_PATH =
	"/Users/vmeansdev/.local/share/mise/installs/node/23.9.0/bin/node";

export const DEFAULT_CAMPAIGN_INPUT_PATHS = [
	"tools/load/g6-sharded-scan.ts",
	"tools/load/g6-sharded-diagnostic.ts",
	"tools/load/g6-linux-probe.ts",
	"tools/load/g6-c32-rca-evaluate.ts",
	"tools/load/g6-c32-successor-grade.ts",
	"tools/load/g6-sharded-grade.ts",
	"tools/offbox/linux-generator-entry-g6.sh",
	"tools/load/g6-shard-bpf-setup.sh",
] as const;

export type CreateSemanticFreezeInput = {
	runId: string;
	planPath: string;
	controllerPath: string;
	registrationTemplatePath: string;
	runbookTemplatePath: string;
	gateCatalogPath: string;
	runtimePath?: string;
	sequence?: number;
};

type GitResult = {
	status: number;
	stdout: string;
	stderr: string;
};

export type SemanticFreezeDependencies = {
	repositoryPath: string;
	now: () => string;
	runGit: (cwd: string, args: readonly string[]) => GitResult;
	readBytes: (path: string) => Uint8Array;
	writeStdout: (value: string) => void;
	atomicWrite: (path: string, value: string) => void;
};

export type SemanticFreezeDependencyOverrides =
	Partial<SemanticFreezeDependencies>;

const verifiedSemanticApprovalBrand: unique symbol = Symbol(
	"verifiedSemanticApproval",
);

export type VerifiedSemanticApproval = Readonly<{
	kind: "g6-c32-verified-semantic-approval/1";
	semanticFreezeAuthoritySha256: string;
	semanticApprovalAuthoritySha256: string;
	semanticApprovalArtifactSha256: string;
	architectReceiptArtifactSha256: string;
	criticReceiptArtifactSha256: string;
	[verifiedSemanticApprovalBrand]: true;
}>;

export type BindHostFreezeInput = {
	runId: string;
	repositoryPath: string;
	provisioningRoot: string;
	outputName: string;
	semanticFreezePath: string;
	semanticApprovalPath: string;
	rigJournalPath: string;
	knownHostsPath: string;
	knownHostsReceiptPath: string;
	preparationReceiptPath: string;
	bundlePath: string;
	retainedNativePath: string;
	retainedGeneratorPath: string;
	identityPacketPaths: { server: string; generator: string };
	identityOperationReceiptPaths: { server: string; generator: string };
	gateReceiptPaths: readonly string[];
	sequenceStart: number;
};

export type BindHostFreezeDependencies = {
	clock: CampaignClock;
	randomId: () => string;
	renderers: Partial<{
		registration: (context: GeneratedViewContext) => string;
		runbook: (context: GeneratedViewContext) => string;
		exactIdentity: (context: GeneratedViewContext) => string;
	}>;
};

export type VerifiedBoundFreeze = Readonly<{
	runId: string;
	root: string;
	semanticFreeze: SemanticFreezeRecord;
	hostBinding: HostBindingRecord;
	dispatchFreeze: DispatchFreezeRecord;
	shellEnvironment: string;
}>;

export type BindHostFreezeResult = Readonly<{
	root: string;
	hostBinding: HostBindingRecord;
	dispatchFreeze: DispatchFreezeRecord;
	verificationReceipt: OperationReceipt;
	verificationReceiptPath: string;
}>;

function fail(message: string): never {
	throw new Error(`g6-c32-freeze: ${message}`);
}

function defaultRunGit(cwd: string, args: readonly string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return {
		status: result.status ?? 1,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function atomicWrite(path: string, value: string): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	if (existsSync(path)) fail(`refusing to replace existing output ${path}`);
	const stagingPath = `${path}.staging-${process.pid}-${randomUUID()}`;
	let stagingFd: number | null = null;
	try {
		stagingFd = openSync(stagingPath, "wx", 0o600);
		writeFileSync(stagingFd, value, "utf8");
		fsyncSync(stagingFd);
		closeSync(stagingFd);
		stagingFd = null;
		renameSync(stagingPath, path);
		const parentFd = openSync(parent, "r");
		try {
			fsyncSync(parentFd);
		} finally {
			closeSync(parentFd);
		}
	} catch (error) {
		if (stagingFd !== null) closeSync(stagingFd);
		if (existsSync(stagingPath)) unlinkSync(stagingPath);
		throw error;
	}
}

function dependencies(
	overrides: SemanticFreezeDependencyOverrides,
): SemanticFreezeDependencies {
	return {
		repositoryPath: overrides.repositoryPath ?? process.cwd(),
		now: overrides.now ?? (() => new Date().toISOString()),
		runGit: overrides.runGit ?? defaultRunGit,
		readBytes: overrides.readBytes ?? ((path) => readFileSync(path)),
		writeStdout:
			overrides.writeStdout ?? ((value) => process.stdout.write(value)),
		atomicWrite: overrides.atomicWrite ?? atomicWrite,
	};
}

function gitText(
	deps: SemanticFreezeDependencies,
	cwd: string,
	args: readonly string[],
): string {
	const result = deps.runGit(cwd, args);
	if (result.status !== 0) {
		fail(
			`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`,
		);
	}
	return result.stdout.trim();
}

function repositoryRoot(deps: SemanticFreezeDependencies): string {
	const rawRoot = gitText(deps, deps.repositoryPath, [
		"rev-parse",
		"--show-toplevel",
	]);
	if (rawRoot.includes("\0") || rawRoot.includes("\n")) {
		fail("Git returned an invalid repository root");
	}
	return realpathSync(rawRoot);
}

function portableRepositoryPath(
	root: string,
	value: string,
	label: string,
): { absolute: string; relative: string } {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r") ||
		value.includes("\t")
	) {
		fail(`${label} must be a nonempty single-line path`);
	}
	const absolute = resolve(root, value);
	const repositoryRelative = relative(root, absolute);
	if (
		repositoryRelative === "" ||
		repositoryRelative === ".." ||
		repositoryRelative.startsWith(`..${sep}`) ||
		isAbsolute(repositoryRelative) ||
		repositoryRelative.includes("\\")
	) {
		fail(`${label} must remain inside the repository`);
	}
	const parts = repositoryRelative.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) {
		fail(`${label} is not a portable repository-relative path`);
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(absolute);
	} catch {
		fail(`${label} does not exist: ${repositoryRelative}`);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		fail(`${label} must be a regular non-symlink file: ${repositoryRelative}`);
	}
	return { absolute, relative: repositoryRelative };
}

function requireTrackedPathClean(
	root: string,
	path: string,
	deps: SemanticFreezeDependencies,
): void {
	const tracked = deps.runGit(root, [
		"ls-files",
		"--error-unmatch",
		"--",
		path,
	]);
	if (tracked.status !== 0) return;
	const headEntry = deps.runGit(root, ["ls-tree", "HEAD", "--", path]);
	const indexEntry = deps.runGit(root, ["ls-files", "--stage", "--", path]);
	const workingBlob = deps.runGit(root, [
		"hash-object",
		"--no-filters",
		"--",
		path,
	]);
	if (
		headEntry.status !== 0 ||
		indexEntry.status !== 0 ||
		workingBlob.status !== 0
	) {
		fail(`could not resolve exact tracked identity for ${path}`);
	}
	const headMatch = /^([0-9]{6}) blob ([0-9a-f]{40})\t/.exec(headEntry.stdout);
	const indexMatch = /^([0-9]{6}) ([0-9a-f]{40}) 0\t/.exec(indexEntry.stdout);
	const workingOid = workingBlob.stdout.trim();
	if (!headMatch || !indexMatch || !/^[0-9a-f]{40}$/.test(workingOid)) {
		fail(`could not parse exact tracked identity for ${path}`);
	}
	const [, headMode, headOid] = headMatch;
	const [, indexMode, indexOid] = indexMatch;
	const workingExecutable = (lstatSync(resolve(root, path)).mode & 0o111) !== 0;
	const headExecutable = headMode === "100755";
	if (
		headOid !== indexOid ||
		headOid !== workingOid ||
		headMode !== indexMode ||
		headExecutable !== workingExecutable
	) {
		fail(`authority-bound tracked path differs from HEAD: ${path}`);
	}
	const clean = deps.runGit(root, ["diff", "--quiet", "HEAD", "--", path]);
	if (clean.status === 1) {
		fail(`authority-bound tracked path differs from HEAD: ${path}`);
	}
	if (clean.status !== 0) {
		fail(`could not verify tracked path ${path}: ${clean.stderr.trim()}`);
	}
}

function hashIdentity(
	root: string,
	value: string,
	label: string,
	deps: SemanticFreezeDependencies,
): ArtifactIdentity {
	const path = portableRepositoryPath(root, value, label);
	requireTrackedPathClean(root, path.relative, deps);
	return {
		path: path.relative,
		sha256: createHash("sha256")
			.update(deps.readBytes(path.absolute))
			.digest("hex"),
	};
}

function requireAllowedRuntime(runtimePath: string | undefined): void {
	if (runtimePath === undefined) return;
	const normalized = resolve(runtimePath);
	if (
		normalized === FORBIDDEN_MISE_NODE_PATH ||
		normalized.endsWith("/.local/share/mise/installs/node/23.9.0/bin/node")
	) {
		fail("forbidden mise Node runtime was supplied");
	}
}

function collectSemanticAuthority(
	input: CreateSemanticFreezeInput,
	deps: SemanticFreezeDependencies,
): SemanticFreezeAuthority {
	requireAllowedRuntime(input.runtimePath);
	const root = repositoryRoot(deps);
	const commit = gitText(deps, root, ["rev-parse", "HEAD^{commit}"]);
	const tree = gitText(deps, root, ["rev-parse", "HEAD^{tree}"]);
	return {
		candidate: { commit, tree },
		plan: hashIdentity(root, input.planPath, "plan", deps),
		controller: hashIdentity(root, input.controllerPath, "controller", deps),
		freezeGenerator: {
			...hashIdentity(
				root,
				SEMANTIC_FREEZE_GENERATOR_PATH,
				"freeze generator",
				deps,
			),
			schemaVersion: SEMANTIC_FREEZE_SCHEMA_VERSION,
		},
		templates: {
			registration: hashIdentity(
				root,
				input.registrationTemplatePath,
				"registration template",
				deps,
			),
			runbook: hashIdentity(
				root,
				input.runbookTemplatePath,
				"runbook template",
				deps,
			),
		},
		campaignInputs: DEFAULT_CAMPAIGN_INPUT_PATHS.map((path) =>
			hashIdentity(root, path, `campaign input ${path}`, deps),
		),
		gateCatalog: hashIdentity(
			root,
			input.gateCatalogPath,
			"gate catalog",
			deps,
		),
	};
}

export function createSemanticFreeze(
	input: CreateSemanticFreezeInput,
	overrides: SemanticFreezeDependencyOverrides = {},
): SemanticFreezeRecord {
	const deps = dependencies(overrides);
	const record = makeAuthorityRecord(
		SEMANTIC_FREEZE_SCHEMA_VERSION,
		{
			recordedAt: deps.now(),
			sequence: input.sequence ?? 1,
			runId: input.runId,
			phase: "SEMANTIC_FREEZE",
			operationId: "semantic-freeze",
			clockSource: "offrunner",
		},
		collectSemanticAuthority(input, deps),
	);
	return validateSemanticFreezeRecord(record);
}

function sameCampaignInputPaths(record: SemanticFreezeRecord): boolean {
	return (
		record.authority.campaignInputs.length ===
			DEFAULT_CAMPAIGN_INPUT_PATHS.length &&
		record.authority.campaignInputs.every(
			(identity, index) =>
				identity.path === DEFAULT_CAMPAIGN_INPUT_PATHS[index],
		)
	);
}

export function verifySemanticFreeze(
	value: unknown,
	overrides: SemanticFreezeDependencyOverrides = {},
): SemanticFreezeRecord {
	const record = validateSemanticFreezeRecord(value);
	if (record.envelope.phase !== "SEMANTIC_FREEZE") {
		fail("semantic freeze envelope phase must be SEMANTIC_FREEZE");
	}
	if (
		record.authority.freezeGenerator.schemaVersion !==
		SEMANTIC_FREEZE_SCHEMA_VERSION
	) {
		fail("semantic freeze generator schema version is not supported");
	}
	if (
		record.authority.freezeGenerator.path !== SEMANTIC_FREEZE_GENERATOR_PATH ||
		!sameCampaignInputPaths(record)
	) {
		fail("semantic freeze does not contain the complete fixed input set");
	}
	const deps = dependencies(overrides);
	const current = collectSemanticAuthority(
		{
			runId: record.envelope.runId,
			planPath: record.authority.plan.path,
			controllerPath: record.authority.controller.path,
			registrationTemplatePath: record.authority.templates.registration.path,
			runbookTemplatePath: record.authority.templates.runbook.path,
			gateCatalogPath: record.authority.gateCatalog.path,
		},
		deps,
	);
	if (canonicalJson(current) !== canonicalJson(record.authority)) {
		fail(
			"semantic freeze authority differs from current Git identity or bytes",
		);
	}
	return record;
}

function requireEqual(actual: string, expected: string, label: string): void {
	if (actual !== expected) fail(`${label} digest mismatch`);
}

function requirePhase(
	record: { envelope: { phase: string } },
	phase: string,
	label: string,
): void {
	if (record.envelope.phase !== phase) {
		fail(`${label} envelope phase must be ${phase}`);
	}
}

export function verifySemanticApproval(
	freezeValue: unknown,
	approvalValue: unknown,
	architectValue: unknown,
	criticValue: unknown,
): VerifiedSemanticApproval {
	const freeze = validateSemanticFreezeRecord(freezeValue);
	const approval = validateSemanticApprovalRecord(approvalValue);
	const architect = validateReviewReceipt(architectValue);
	const critic = validateReviewReceipt(criticValue);
	requirePhase(freeze, "SEMANTIC_FREEZE", "semantic freeze");
	requirePhase(architect, "ARCHITECT_REVIEW", "Architect receipt");
	requirePhase(critic, "CRITIC_REVIEW", "Critic receipt");
	requirePhase(approval, "SEMANTIC_APPROVAL", "semantic approval");
	validateRecordSequence([
		freeze.envelope,
		architect.envelope,
		critic.envelope,
		approval.envelope,
	]);
	if (architect.authority.role !== "architect") {
		fail("Architect receipt role must be architect");
	}
	if (critic.authority.role !== "critic") {
		fail("Critic receipt role must be critic");
	}
	for (const [label, digest] of [
		[
			"Architect receipt semantic freeze",
			architect.authority.semanticFreezeAuthoritySha256,
		],
		[
			"Critic receipt semantic freeze",
			critic.authority.semanticFreezeAuthoritySha256,
		],
		[
			"semantic approval freeze",
			approval.authority.semanticFreezeAuthoritySha256,
		],
	] as const) {
		requireEqual(digest, freeze.authoritySha256, label);
	}
	const architectArtifactSha256 = canonicalArtifactSha256(architect);
	const criticArtifactSha256 = canonicalArtifactSha256(critic);
	requireEqual(
		critic.authority.afterArchitectReceiptArtifactSha256 ?? "",
		architectArtifactSha256,
		"Critic after-Architect receipt",
	);
	requireEqual(
		approval.authority.architect.receiptArtifactSha256,
		architectArtifactSha256,
		"semantic approval Architect receipt",
	);
	requireEqual(
		approval.authority.critic.receiptArtifactSha256,
		criticArtifactSha256,
		"semantic approval Critic receipt",
	);
	requireEqual(
		approval.authority.critic.afterArchitectReceiptArtifactSha256,
		architectArtifactSha256,
		"semantic approval Critic after-Architect receipt",
	);
	return Object.freeze({
		kind: "g6-c32-verified-semantic-approval/1" as const,
		semanticFreezeAuthoritySha256: freeze.authoritySha256,
		semanticApprovalAuthoritySha256: approval.authoritySha256,
		semanticApprovalArtifactSha256: canonicalArtifactSha256(approval),
		architectReceiptArtifactSha256: architectArtifactSha256,
		criticReceiptArtifactSha256: criticArtifactSha256,
		[verifiedSemanticApprovalBrand]: true as const,
	});
}

const SAFE_OUTPUT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function requireRegularFile(path: string, label: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		fail(`${label} does not exist: ${path}`);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		fail(`${label} must be a regular non-symlink file: ${path}`);
	}
}

function parseJsonFile(path: string, label: string): unknown {
	requireRegularFile(path, label);
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		fail(
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function requireDirectory(path: string, label: string): string {
	if (
		typeof path !== "string" ||
		path === "" ||
		path.includes("\0") ||
		path.includes("\n") ||
		path.includes("\r")
	) {
		fail(`${label} must be a nonempty NUL-free single-line path`);
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		fail(`${label} does not exist: ${path}`);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		fail(`${label} must be a non-symlink directory: ${path}`);
	}
	return realpathSync(path);
}

function inside(root: string, path: string, label: string): string {
	const absolute = resolve(path);
	const fromRoot = relative(root, absolute);
	if (
		fromRoot === "" ||
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		isAbsolute(fromRoot)
	) {
		fail(`${label} must remain below ${root}`);
	}
	return absolute;
}

function resolveEvidencePath(
	provisioningRoot: string,
	value: string,
	label: string,
): string {
	if (typeof value !== "string" || value === "" || value.includes("\0")) {
		fail(`${label} must be a nonempty NUL-free path`);
	}
	const candidate = isAbsolute(value)
		? value
		: resolve(provisioningRoot, value);
	requireRegularFile(candidate, label);
	return inside(provisioningRoot, realpathSync(candidate), label);
}

function requirePortableArtifactPath(value: string, label: string): string {
	if (
		typeof value !== "string" ||
		value === "" ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.includes("\n") ||
		value
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		fail(`${label} must be a portable relative path`);
	}
	return value;
}

function writeDurableExclusive(
	root: string,
	relativePath: string,
	bytes: string | Uint8Array,
): string {
	const portable = requirePortableArtifactPath(relativePath, "artifact path");
	const path = inside(root, resolve(root, portable), "artifact output");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return path;
}

function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function copyArtifact(
	sourcePath: string,
	stagingRoot: string,
	relativePath: string,
): ArtifactIdentity {
	requireRegularFile(sourcePath, `source for ${relativePath}`);
	const bytes = readFileSync(sourcePath);
	writeDurableExclusive(stagingRoot, relativePath, bytes);
	return { path: relativePath, sha256: hashBytes(bytes) };
}

function artifactAt(root: string, relativePath: string): ArtifactIdentity {
	const portable = requirePortableArtifactPath(
		relativePath,
		"artifact identity",
	);
	const path = inside(root, resolve(root, portable), "artifact identity");
	requireRegularFile(path, `artifact ${portable}`);
	return { path: portable, sha256: hashBytes(readFileSync(path)) };
}

function assertArtifact(
	root: string,
	identity: ArtifactIdentity,
	label: string,
): Uint8Array {
	const path = inside(root, resolve(root, identity.path), label);
	requireRegularFile(path, label);
	const bytes = readFileSync(path);
	const actual = hashBytes(bytes);
	if (actual !== identity.sha256) {
		fail(
			`${label} digest mismatch; expected ${identity.sha256}; got ${actual}`,
		);
	}
	return bytes;
}

function bindingDependencies(
	overrides: Partial<BindHostFreezeDependencies>,
): BindHostFreezeDependencies {
	let monotonic = process.hrtime.bigint();
	return {
		clock:
			overrides.clock ??
			({
				wallNow: () => new Date().toISOString(),
				monotonicNowNs: () => {
					monotonic += 1n;
					return monotonic;
				},
			} satisfies CampaignClock),
		randomId: overrides.randomId ?? randomUUID,
		renderers: overrides.renderers ?? {},
	};
}

function hostFromPacket(packet: HostIdentityPacket): HostBindingHost {
	const { role: _role, ...provider } = packet.provider;
	if (
		packet.provider.role !== "server" &&
		packet.provider.role !== "generator"
	) {
		fail("host identity packet role is not concrete");
	}
	return {
		role: packet.provider.role,
		provider,
		bootId: packet.bootId,
		source: { commit: packet.source.commit, tree: packet.source.tree },
		runtime: { ...packet.runtime },
		binary: { ...packet.binary },
		identityPacket: { path: "placeholder", sha256: "0".repeat(64) },
		identityOperationReceipt: {
			path: "placeholder",
			sha256: "0".repeat(64),
		},
	};
}

function sameHostBinding(
	packet: HostIdentityPacket,
	binding: HostBindingHost,
): boolean {
	const expected = hostFromPacket(packet);
	return (
		canonicalJson({
			...expected,
			identityPacket: binding.identityPacket,
			identityOperationReceipt: binding.identityOperationReceipt,
		}) === canonicalJson(binding)
	);
}

function readGateEvidence(
	provisioningRoot: string,
	paths: readonly string[],
): Array<{
	receipt: GateReceipt;
	receiptSourcePath: string;
	operation: OperationReceipt;
	operationSourcePath: string;
}> {
	const expected = G6_C32_GATE_CATALOG.gates.filter(
		({ phase }) => phase === "LOCAL" || phase === "PREPARED_HOST",
	);
	const byId = new Map<string, ReturnType<typeof readGateEvidence>[number]>();
	for (const sourcePath of paths) {
		const receiptSourcePath = resolveEvidencePath(
			provisioningRoot,
			sourcePath,
			"gate receipt",
		);
		const receipt = validateGateReceipt(
			parseJsonFile(receiptSourcePath, "gate receipt"),
		);
		if (receipt.result.verdict !== "PASS") {
			fail(`gate ${receipt.gate.id} is ${receipt.result.verdict}`);
		}
		if (byId.has(receipt.gate.id)) fail(`duplicate gate ${receipt.gate.id}`);
		const operationSourcePath = resolveEvidencePath(
			provisioningRoot,
			receipt.result.operationReceiptPath,
			`gate ${receipt.gate.id} operation receipt`,
		);
		const operation = validateOperationReceipt(
			parseJsonFile(
				operationSourcePath,
				`gate ${receipt.gate.id} operation receipt`,
			),
		);
		if (
			operation.status.outcome !== "SUCCEEDED" ||
			canonicalArtifactSha256(operation) !==
				receipt.result.operationReceiptArtifactSha256
		) {
			fail(
				`gate ${receipt.gate.id} operation receipt is incomplete or drifted`,
			);
		}
		byId.set(receipt.gate.id, {
			receipt,
			receiptSourcePath,
			operation,
			operationSourcePath,
		});
	}
	if (
		byId.size !== expected.length ||
		expected.some(({ id, phase }) => byId.get(id)?.receipt.gate.phase !== phase)
	) {
		fail("complete LOCAL and PREPARED_HOST gate receipts are required");
	}
	return expected.map(({ id }) => {
		const evidence = byId.get(id);
		if (!evidence) fail(`required gate receipt is missing: ${id}`);
		return evidence;
	});
}

function listFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (directory: string, prefix: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const absolute = join(directory, name);
			const relativePath = prefix === "" ? name : posix.join(prefix, name);
			const stat = lstatSync(absolute);
			if (stat.isSymbolicLink()) fail(`symlink is forbidden: ${relativePath}`);
			if (stat.isDirectory()) {
				walk(absolute, relativePath);
				continue;
			}
			if (!stat.isFile())
				fail(`non-regular artifact is forbidden: ${relativePath}`);
			files.push(relativePath);
		}
	};
	walk(root, "");
	return files.sort();
}

function sha256Sums(root: string, paths: readonly string[]): string {
	return `${paths
		.map((path) => `${hashBytes(readFileSync(join(root, path)))}  ${path}`)
		.join("\n")}\n`;
}

function parseSha256Sums(value: string): Map<string, string> {
	if (!value.endsWith("\n")) fail("SHA256SUMS must end with a newline");
	const entries = new Map<string, string>();
	const lines = value.slice(0, -1).split("\n");
	if (lines.length === 0 || lines.some((line) => line === "")) {
		fail("SHA256SUMS must contain nonempty records");
	}
	let previous = "";
	for (const line of lines) {
		const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
		if (!match?.[1] || !match[2])
			fail("SHA256SUMS contains a malformed record");
		const path = requirePortableArtifactPath(match[2], "SHA256SUMS path");
		if (path === "SHA256SUMS" || path === "RUN_STATUS") {
			fail(`SHA256SUMS must exclude ${path}`);
		}
		if (entries.has(path) || (previous !== "" && path <= previous)) {
			fail("SHA256SUMS paths must be unique and strictly sorted");
		}
		entries.set(path, match[1]);
		previous = path;
	}
	return entries;
}

function parseCanonicalRecord<T>(
	root: string,
	path: string,
	label: string,
	validate: (value: unknown) => T,
): T {
	const bytes = readFileSync(join(root, path), "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes) as unknown;
	} catch {
		fail(`${label} is not valid JSON`);
	}
	const checked = validate(parsed);
	if (canonicalJson(checked) !== bytes) fail(`${label} is not canonical JSON`);
	return checked;
}

function requireAuthorityReference(
	root: string,
	reference: { path: string; authoritySha256: string; artifactSha256: string },
	record: { authoritySha256: string },
	label: string,
): void {
	if (
		reference.authoritySha256 !== record.authoritySha256 ||
		reference.artifactSha256 !==
			hashBytes(
				assertArtifact(
					root,
					{ path: reference.path, sha256: reference.artifactSha256 },
					label,
				),
			)
	) {
		fail(`${label} authority or artifact reference mismatch`);
	}
}

function shellEnvironment(
	root: string,
	repositoryPath: string,
	semanticFreeze: SemanticFreezeRecord,
	hostBinding: HostBindingRecord,
	dispatchFreeze: DispatchFreezeRecord,
): string {
	const { server, generator } = hostBinding.authority.hosts;
	const values: Record<string, string> = {
		G6_C32_RUN_ID: hostBinding.envelope.runId,
		G6_C32_BOUND_ROOT: root,
		G6_C32_DISPATCH_FREEZE_SHA256: canonicalArtifactSha256(dispatchFreeze),
		G6_C32_SEMANTIC_FREEZE_AUTHORITY_SHA256: semanticFreeze.authoritySha256,
		G6_C32_HOST_BINDING_AUTHORITY_SHA256: hostBinding.authoritySha256,
		G6_C32_CONTROLLER_PATH: resolve(
			repositoryPath,
			semanticFreeze.authority.controller.path,
		),
		G6_C32_KNOWN_HOSTS_PATH: resolve(
			root,
			hostBinding.authority.knownHosts.file.path,
		),
		G6_C32_CANDIDATE_BUNDLE_PATH: resolve(
			root,
			hostBinding.authority.bundle.path,
		),
		G6_C32_SERVER_ID: String(server.provider.id),
		G6_C32_SERVER_PUBLIC_IPV4: server.provider.publicIpv4,
		G6_C32_SERVER_PRIVATE_IPV4: server.provider.privateIpv4,
		G6_C32_SERVER_BOOT_ID: server.bootId,
		G6_C32_SERVER_BINARY_SHA256: server.binary.sha256,
		G6_C32_SERVER_BINARY_PATH: server.binary.path,
		G6_C32_GENERATOR_ID: String(generator.provider.id),
		G6_C32_GENERATOR_PUBLIC_IPV4: generator.provider.publicIpv4,
		G6_C32_GENERATOR_PRIVATE_IPV4: generator.provider.privateIpv4,
		G6_C32_GENERATOR_BOOT_ID: generator.bootId,
		G6_C32_GENERATOR_BINARY_SHA256: generator.binary.sha256,
		G6_C32_GENERATOR_BINARY_PATH: generator.binary.path,
	};
	return `${Object.keys(values)
		.sort()
		.map((key) => `${key}=${shellQuote(values[key] ?? "")}`)
		.join("\n")}\n`;
}

export function verifyBoundFreeze(
	rootPath: string,
	options: {
		repositoryPath?: string;
		expectedStatus?: "INCOMPLETE" | "BOUND";
	} = {},
): VerifiedBoundFreeze {
	const root = requireDirectory(rootPath, "bound freeze root");
	const repositoryPath = requireDirectory(
		options.repositoryPath ?? process.cwd(),
		"repository root",
	);
	const expectedStatus = options.expectedStatus ?? "BOUND";
	const files = listFiles(root);
	if (!files.includes("SHA256SUMS") || !files.includes("RUN_STATUS")) {
		fail("bound freeze is missing SHA256SUMS or RUN_STATUS");
	}
	const status = readFileSync(join(root, "RUN_STATUS"), "utf8");
	if (status !== `${expectedStatus}\n`) {
		fail(`RUN_STATUS must be ${expectedStatus}`);
	}
	const sums = parseSha256Sums(readFileSync(join(root, "SHA256SUMS"), "utf8"));
	const expectedFiles = [...sums.keys(), "RUN_STATUS", "SHA256SUMS"].sort();
	if (canonicalJson(files) !== canonicalJson(expectedFiles)) {
		fail("fresh disk walk differs from SHA256SUMS");
	}
	for (const [path, expected] of sums) {
		const actual = hashBytes(readFileSync(join(root, path)));
		if (actual !== expected) fail(`SHA256SUMS mismatch for ${path}`);
	}

	const manifest = parseCanonicalRecord(
		root,
		"artifact-manifest.json",
		"artifact manifest",
		validateArtifactManifestRecord,
	);
	const manifestPaths = manifest.entries.map(({ path }) => path);
	const sumPathsWithoutManifest = [...sums.keys()].filter(
		(path) => path !== "artifact-manifest.json",
	);
	if (canonicalJson(manifestPaths) !== canonicalJson(sumPathsWithoutManifest)) {
		fail("artifact manifest path set differs from SHA256SUMS");
	}
	for (const entry of manifest.entries) {
		const path = join(root, entry.path);
		const stat = statSync(path);
		if (
			stat.size !== entry.bytes ||
			hashBytes(readFileSync(path)) !== entry.sha256
		) {
			fail(`artifact manifest mismatch for ${entry.path}`);
		}
	}

	const semanticFreeze = parseCanonicalRecord(
		root,
		"semantic/semantic-freeze.json",
		"semantic freeze",
		(value) => verifySemanticFreeze(value, { repositoryPath }),
	);
	const semanticApproval = parseCanonicalRecord(
		root,
		"semantic/semantic-approval.json",
		"semantic approval",
		validateSemanticApprovalRecord,
	);
	const architect = parseCanonicalRecord(
		root,
		"semantic/architect.json",
		"Architect receipt",
		validateReviewReceipt,
	);
	const critic = parseCanonicalRecord(
		root,
		"semantic/critic.json",
		"Critic receipt",
		validateReviewReceipt,
	);
	verifySemanticApproval(semanticFreeze, semanticApproval, architect, critic);
	const hostBinding = parseCanonicalRecord(
		root,
		"host-binding.json",
		"host binding",
		validateHostBindingRecord,
	);
	const dispatchFreeze = parseCanonicalRecord(
		root,
		"dispatch-freeze.json",
		"dispatch freeze",
		validateDispatchFreezeRecord,
	);
	validateRecordSequence([
		semanticFreeze.envelope,
		semanticApproval.envelope,
		hostBinding.envelope,
		dispatchFreeze.envelope,
		manifest.envelope,
	]);
	if (
		hostBinding.envelope.runId !== semanticFreeze.envelope.runId ||
		dispatchFreeze.envelope.runId !== semanticFreeze.envelope.runId
	) {
		fail("bound record run IDs differ");
	}
	requireAuthorityReference(
		root,
		hostBinding.authority.semantic.freeze,
		semanticFreeze,
		"host binding semantic freeze",
	);
	requireAuthorityReference(
		root,
		hostBinding.authority.semantic.approval,
		semanticApproval,
		"host binding semantic approval",
	);
	assertArtifact(
		root,
		hostBinding.authority.semantic.architectReceipt,
		"Architect receipt artifact",
	);
	assertArtifact(
		root,
		hostBinding.authority.semantic.criticReceipt,
		"Critic receipt artifact",
	);
	readRigJournal(join(root, hostBinding.authority.rigJournal.path));
	const knownHostsBytes = assertArtifact(
		root,
		hostBinding.authority.knownHosts.file,
		"known_hosts",
	);
	const knownReceipt = validateKnownHostsReceipt(
		JSON.parse(
			new TextDecoder().decode(
				assertArtifact(
					root,
					hostBinding.authority.knownHosts.receipt,
					"known_hosts receipt",
				),
			),
		),
	);
	if (knownReceipt.knownHostsSha256 !== hashBytes(knownHostsBytes)) {
		fail("known_hosts receipt digest mismatch");
	}
	const preparation = validateHostPreparationReceipt(
		JSON.parse(
			new TextDecoder().decode(
				assertArtifact(
					root,
					hostBinding.authority.preparationReceipt,
					"preparation receipt",
				),
			),
		),
	);
	const serverPacket = validateHostIdentityPacket(
		JSON.parse(
			new TextDecoder().decode(
				assertArtifact(
					root,
					hostBinding.authority.hosts.server.identityPacket,
					"server identity packet",
				),
			),
		),
	);
	const generatorPacket = validateHostIdentityPacket(
		JSON.parse(
			new TextDecoder().decode(
				assertArtifact(
					root,
					hostBinding.authority.hosts.generator.identityPacket,
					"generator identity packet",
				),
			),
		),
	);
	if (
		!sameHostBinding(serverPacket, hostBinding.authority.hosts.server) ||
		!sameHostBinding(generatorPacket, hostBinding.authority.hosts.generator)
	) {
		fail("host binding differs from exact identity packets");
	}
	if (
		preparation.hostIds.server !== serverPacket.provider.id ||
		preparation.hostIds.generator !== generatorPacket.provider.id ||
		preparation.binaryHashes.nativeAddonSha256 !== serverPacket.binary.sha256 ||
		preparation.binaryHashes.generatorSha256 !==
			generatorPacket.binary.sha256 ||
		knownReceipt.entries[0]?.dropletId !== serverPacket.provider.id ||
		knownReceipt.entries[1]?.dropletId !== generatorPacket.provider.id
	) {
		fail("preparation or known_hosts receipt differs from exact pair");
	}
	for (const host of [
		hostBinding.authority.hosts.server,
		hostBinding.authority.hosts.generator,
	]) {
		const operation = validateOperationReceipt(
			JSON.parse(
				new TextDecoder().decode(
					assertArtifact(
						root,
						host.identityOperationReceipt,
						`${host.role} identity operation receipt`,
					),
				),
			),
		);
		if (operation.status.outcome !== "SUCCEEDED") {
			fail(`${host.role} identity operation did not succeed`);
		}
	}
	assertArtifact(root, hostBinding.authority.bundle, "candidate bundle");
	const nativeBytes = assertArtifact(
		root,
		hostBinding.authority.retainedBinaries.nativeAddon,
		"retained native addon",
	);
	const generatorBytes = assertArtifact(
		root,
		hostBinding.authority.retainedBinaries.generator,
		"retained generator",
	);
	if (
		hashBytes(nativeBytes) !== serverPacket.binary.sha256 ||
		hashBytes(generatorBytes) !== generatorPacket.binary.sha256
	) {
		fail("retained binaries differ from host identity packets");
	}

	validateGateCatalog(G6_C32_GATE_CATALOG);
	const expectedGateIds = G6_C32_GATE_CATALOG.gates
		.filter(({ phase }) => phase === "LOCAL" || phase === "PREPARED_HOST")
		.map(({ id }) => id);
	if (
		hostBinding.authority.gates.catalogAuthoritySha256 !==
			canonicalAuthoritySha256(G6_C32_GATE_CATALOG) ||
		canonicalJson(hostBinding.authority.gates.receipts.map(({ id }) => id)) !==
			canonicalJson(expectedGateIds)
	) {
		fail("host binding does not contain the complete exact gate set");
	}
	for (const reference of hostBinding.authority.gates.receipts) {
		const receipt = validateGateReceipt(
			JSON.parse(
				new TextDecoder().decode(
					assertArtifact(root, reference.receipt, `gate ${reference.id}`),
				),
			),
		);
		const operationBytes = assertArtifact(
			root,
			reference.operationReceipt,
			`gate ${reference.id} operation`,
		);
		const operation = validateOperationReceipt(
			JSON.parse(new TextDecoder().decode(operationBytes)),
		);
		if (
			receipt.gate.id !== reference.id ||
			receipt.gate.phase !== reference.phase ||
			receipt.result.verdict !== "PASS" ||
			receipt.result.operationReceiptArtifactSha256 !==
				canonicalArtifactSha256(operation) ||
			operation.status.outcome !== "SUCCEEDED"
		) {
			fail(`gate ${reference.id} evidence is incomplete or mismatched`);
		}
	}

	requireAuthorityReference(
		root,
		dispatchFreeze.authority.semanticFreeze,
		semanticFreeze,
		"dispatch semantic freeze",
	);
	requireAuthorityReference(
		root,
		dispatchFreeze.authority.semanticApproval,
		semanticApproval,
		"dispatch semantic approval",
	);
	requireAuthorityReference(
		root,
		dispatchFreeze.authority.hostBinding,
		hostBinding,
		"dispatch host binding",
	);
	const viewContext: GeneratedViewContext = {
		recordedAt: hostBinding.envelope.recordedAt,
		runId: hostBinding.envelope.runId,
		controllerPath: semanticFreeze.authority.controller.path,
		semanticFreezeArtifactSha256: canonicalArtifactSha256(semanticFreeze),
		semanticApprovalArtifactSha256: canonicalArtifactSha256(semanticApproval),
		hostBindingArtifactSha256: canonicalArtifactSha256(hostBinding),
		hostBinding,
	};
	for (const [name, reference, rendered] of [
		[
			"registration",
			dispatchFreeze.authority.views.registration,
			renderRegistration(viewContext),
		],
		[
			"runbook",
			dispatchFreeze.authority.views.runbook,
			renderRunbook(viewContext),
		],
		[
			"exact identity",
			dispatchFreeze.authority.views.exactIdentity,
			renderExactIdentitySheet(viewContext),
		],
	] as const) {
		const bytes = assertArtifact(root, reference, `${name} view`);
		if (new TextDecoder().decode(bytes) !== rendered) {
			fail(`${name} view is not the deterministic rendering`);
		}
	}

	return {
		runId: semanticFreeze.envelope.runId,
		root,
		semanticFreeze,
		hostBinding,
		dispatchFreeze,
		shellEnvironment: shellEnvironment(
			root,
			repositoryPath,
			semanticFreeze,
			hostBinding,
			dispatchFreeze,
		),
	};
}

export async function bindHostFreeze(
	input: BindHostFreezeInput,
	overrides: Partial<BindHostFreezeDependencies> = {},
): Promise<BindHostFreezeResult> {
	if (!SAFE_OUTPUT_RE.test(input.runId)) fail("bind runId is not safe");
	if (
		!SAFE_OUTPUT_RE.test(input.outputName) ||
		input.outputName.includes("..")
	) {
		fail("bind outputName must be one safe path segment");
	}
	if (!Number.isSafeInteger(input.sequenceStart) || input.sequenceStart < 1) {
		fail("bind sequenceStart must be a positive safe integer");
	}
	const deps = bindingDependencies(overrides);
	const repositoryPath = requireDirectory(input.repositoryPath, "repository");
	const provisioningRoot = requireDirectory(
		input.provisioningRoot,
		"provisioning root",
	);
	const finalRoot = inside(
		provisioningRoot,
		resolve(provisioningRoot, input.outputName),
		"bound output",
	);
	if (existsSync(finalRoot)) fail(`bound output already exists: ${finalRoot}`);
	const randomId = deps.randomId();
	if (!SAFE_OUTPUT_RE.test(randomId)) fail("bind random ID is not safe");
	const stagingRoot = inside(
		provisioningRoot,
		resolve(provisioningRoot, `${input.outputName}.staging-${randomId}`),
		"bound staging output",
	);
	if (existsSync(stagingRoot))
		fail(`bound staging output exists: ${stagingRoot}`);

	const semanticFreeze = verifySemanticFreeze(
		parseJsonFile(input.semanticFreezePath, "semantic freeze"),
		{ repositoryPath },
	);
	const semanticApproval = validateSemanticApprovalRecord(
		parseJsonFile(input.semanticApprovalPath, "semantic approval"),
	);
	if (
		semanticFreeze.envelope.runId !== input.runId ||
		semanticApproval.envelope.runId !== input.runId
	) {
		fail("semantic records do not match bind runId");
	}
	const architectSourcePath = resolve(
		repositoryPath,
		semanticApproval.authority.architect.receiptPath,
	);
	const criticSourcePath = resolve(
		repositoryPath,
		semanticApproval.authority.critic.receiptPath,
	);
	const architect = validateReviewReceipt(
		parseJsonFile(architectSourcePath, "Architect receipt"),
	);
	const critic = validateReviewReceipt(
		parseJsonFile(criticSourcePath, "Critic receipt"),
	);
	verifySemanticApproval(semanticFreeze, semanticApproval, architect, critic);
	const rigSnapshot = readRigJournal(input.rigJournalPath);
	if (
		rigSnapshot.envelope.runId !== input.runId ||
		rigSnapshot.events.at(-1)?.state !== "PREPARED"
	) {
		fail("bind requires the exact PREPARED rig journal");
	}
	const knownHostsBytes = readFileSync(input.knownHostsPath);
	const knownHostsReceipt = validateKnownHostsReceipt(
		parseJsonFile(input.knownHostsReceiptPath, "known_hosts receipt"),
	);
	if (
		knownHostsReceipt.envelope.runId !== input.runId ||
		knownHostsReceipt.knownHostsSha256 !== hashBytes(knownHostsBytes)
	) {
		fail("known_hosts receipt does not match exact bytes or run");
	}
	const preparation = validateHostPreparationReceipt(
		parseJsonFile(input.preparationReceiptPath, "preparation receipt"),
	);
	if (preparation.envelope.runId !== input.runId) {
		fail("preparation receipt does not match bind runId");
	}
	for (const [index, path] of preparation.operationReceipts.entries()) {
		const source = resolveEvidencePath(
			provisioningRoot,
			path,
			`preparation operation ${index}`,
		);
		const operation = validateOperationReceipt(
			parseJsonFile(source, `preparation operation ${index}`),
		);
		if (operation.status.outcome !== "SUCCEEDED") {
			fail(`preparation operation ${index} did not succeed`);
		}
	}
	const serverPacket = validateHostIdentityPacket(
		parseJsonFile(input.identityPacketPaths.server, "server identity packet"),
	);
	const generatorPacket = validateHostIdentityPacket(
		parseJsonFile(
			input.identityPacketPaths.generator,
			"generator identity packet",
		),
	);
	for (const [role, packet] of [
		["server", serverPacket],
		["generator", generatorPacket],
	] as const) {
		if (
			packet.provider.role !== role ||
			packet.envelope.runId !== input.runId ||
			packet.source.commit !== semanticFreeze.authority.candidate.commit ||
			packet.source.tree !== semanticFreeze.authority.candidate.tree
		) {
			fail(`${role} identity does not match approved source or role`);
		}
	}
	if (
		serverPacket.provider.id === generatorPacket.provider.id ||
		serverPacket.bootId === generatorPacket.bootId
	) {
		fail("bind requires two distinct exact host identities");
	}
	const nativeBytes = readFileSync(input.retainedNativePath);
	const generatorBytes = readFileSync(input.retainedGeneratorPath);
	if (
		hashBytes(nativeBytes) !== serverPacket.binary.sha256 ||
		hashBytes(generatorBytes) !== generatorPacket.binary.sha256 ||
		preparation.binaryHashes.nativeAddonSha256 !== serverPacket.binary.sha256 ||
		preparation.binaryHashes.generatorSha256 !==
			generatorPacket.binary.sha256 ||
		preparation.hostIds.server !== serverPacket.provider.id ||
		preparation.hostIds.generator !== generatorPacket.provider.id
	) {
		fail("retained binaries or preparation receipt differ from exact hosts");
	}
	const gateEvidence = readGateEvidence(
		provisioningRoot,
		input.gateReceiptPaths,
	);

	mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });
	writeDurableExclusive(stagingRoot, "RUN_STATUS", "INCOMPLETE\n");
	appendRigJournalEvent(
		input.rigJournalPath,
		{
			state: "BINDING",
			kind: "TRANSITION",
			operationId: "begin-host-binding",
			details: { stagingRoot: basename(stagingRoot) },
		},
		{ clock: deps.clock, randomId: deps.randomId },
	);

	const semanticFreezeIdentity = copyArtifact(
		input.semanticFreezePath,
		stagingRoot,
		"semantic/semantic-freeze.json",
	);
	const semanticApprovalIdentity = copyArtifact(
		input.semanticApprovalPath,
		stagingRoot,
		"semantic/semantic-approval.json",
	);
	const architectIdentity = copyArtifact(
		architectSourcePath,
		stagingRoot,
		"semantic/architect.json",
	);
	const criticIdentity = copyArtifact(
		criticSourcePath,
		stagingRoot,
		"semantic/critic.json",
	);
	const rigJournalIdentity = copyArtifact(
		input.rigJournalPath,
		stagingRoot,
		"lifecycle/rig-state.json",
	);
	const knownHostsIdentity = copyArtifact(
		input.knownHostsPath,
		stagingRoot,
		"host/known_hosts",
	);
	const knownHostsReceiptIdentity = copyArtifact(
		input.knownHostsReceiptPath,
		stagingRoot,
		"host/known-hosts-receipt.json",
	);
	const preparationIdentity = copyArtifact(
		input.preparationReceiptPath,
		stagingRoot,
		"host/preparation-receipt.json",
	);
	for (const [index, path] of preparation.operationReceipts.entries()) {
		copyArtifact(
			resolveEvidencePath(
				provisioningRoot,
				path,
				`preparation operation ${index}`,
			),
			stagingRoot,
			`host/preparation-operations/${String(index + 1).padStart(3, "0")}.json`,
		);
	}
	const bundleIdentity = copyArtifact(
		input.bundlePath,
		stagingRoot,
		"candidate/candidate.bundle",
	);
	const nativeIdentity = copyArtifact(
		input.retainedNativePath,
		stagingRoot,
		"candidate/native-addon.node",
	);
	const generatorIdentity = copyArtifact(
		input.retainedGeneratorPath,
		stagingRoot,
		"candidate/mmo-client",
	);
	const serverPacketIdentity = copyArtifact(
		input.identityPacketPaths.server,
		stagingRoot,
		"host/server-identity.json",
	);
	const generatorPacketIdentity = copyArtifact(
		input.identityPacketPaths.generator,
		stagingRoot,
		"host/generator-identity.json",
	);
	const serverOperationIdentity = copyArtifact(
		input.identityOperationReceiptPaths.server,
		stagingRoot,
		"host/server-identity-operation.json",
	);
	const generatorOperationIdentity = copyArtifact(
		input.identityOperationReceiptPaths.generator,
		stagingRoot,
		"host/generator-identity-operation.json",
	);
	const gateReferences: HostBindingAuthority["gates"]["receipts"] = [];
	for (const evidence of gateEvidence) {
		const receiptIdentity = copyArtifact(
			evidence.receiptSourcePath,
			stagingRoot,
			`gates/${evidence.receipt.gate.id}.json`,
		);
		const operationIdentity = copyArtifact(
			evidence.operationSourcePath,
			stagingRoot,
			`gates/${evidence.receipt.gate.id}.operation.json`,
		);
		gateReferences.push({
			id: evidence.receipt.gate.id,
			phase: evidence.receipt.gate.phase as "LOCAL" | "PREPARED_HOST",
			receipt: receiptIdentity,
			operationReceipt: operationIdentity,
		});
	}

	const server = hostFromPacket(serverPacket);
	server.identityPacket = serverPacketIdentity;
	server.identityOperationReceipt = serverOperationIdentity;
	const generator = hostFromPacket(generatorPacket);
	generator.identityPacket = generatorPacketIdentity;
	generator.identityOperationReceipt = generatorOperationIdentity;
	const hostBinding = makeHostBindingRecord(
		{
			recordedAt: deps.clock.wallNow(),
			sequence: input.sequenceStart,
			runId: input.runId,
			phase: "HOST_BINDING",
			operationId: "host-binding",
			clockSource: "offrunner",
		},
		{
			semantic: {
				freeze: {
					path: semanticFreezeIdentity.path,
					authoritySha256: semanticFreeze.authoritySha256,
					artifactSha256: semanticFreezeIdentity.sha256,
				},
				approval: {
					path: semanticApprovalIdentity.path,
					authoritySha256: semanticApproval.authoritySha256,
					artifactSha256: semanticApprovalIdentity.sha256,
				},
				architectReceipt: architectIdentity,
				criticReceipt: criticIdentity,
			},
			rigJournal: rigJournalIdentity,
			knownHosts: {
				file: knownHostsIdentity,
				receipt: knownHostsReceiptIdentity,
			},
			preparationReceipt: preparationIdentity,
			bundle: bundleIdentity,
			retainedBinaries: {
				nativeAddon: nativeIdentity,
				generator: generatorIdentity,
			},
			hosts: { server, generator },
			gates: {
				catalogAuthoritySha256: canonicalAuthoritySha256(G6_C32_GATE_CATALOG),
				receipts: gateReferences,
			},
		},
	);
	writeDurableExclusive(
		stagingRoot,
		"host-binding.json",
		canonicalJson(hostBinding),
	);
	const viewContext: GeneratedViewContext = {
		recordedAt: hostBinding.envelope.recordedAt,
		runId: input.runId,
		controllerPath: semanticFreeze.authority.controller.path,
		semanticFreezeArtifactSha256: semanticFreezeIdentity.sha256,
		semanticApprovalArtifactSha256: semanticApprovalIdentity.sha256,
		hostBindingArtifactSha256: canonicalArtifactSha256(hostBinding),
		hostBinding,
	};
	writeDurableExclusive(
		stagingRoot,
		"views/registration.md",
		(overrides.renderers?.registration ?? renderRegistration)(viewContext),
	);
	writeDurableExclusive(
		stagingRoot,
		"views/runbook.md",
		(overrides.renderers?.runbook ?? renderRunbook)(viewContext),
	);
	writeDurableExclusive(
		stagingRoot,
		"views/exact-identity.md",
		(overrides.renderers?.exactIdentity ?? renderExactIdentitySheet)(
			viewContext,
		),
	);
	const dispatchFreeze = makeDispatchFreezeRecord(
		{
			recordedAt: deps.clock.wallNow(),
			sequence: input.sequenceStart + 1,
			runId: input.runId,
			phase: "DISPATCH_FREEZE",
			operationId: "dispatch-freeze",
			clockSource: "offrunner",
		},
		{
			semanticFreeze: hostBinding.authority.semantic.freeze,
			semanticApproval: hostBinding.authority.semantic.approval,
			hostBinding: {
				path: "host-binding.json",
				authoritySha256: hostBinding.authoritySha256,
				artifactSha256: canonicalArtifactSha256(hostBinding),
			},
			views: {
				registration: artifactAt(stagingRoot, "views/registration.md"),
				runbook: artifactAt(stagingRoot, "views/runbook.md"),
				exactIdentity: artifactAt(stagingRoot, "views/exact-identity.md"),
			},
		},
	);
	writeDurableExclusive(
		stagingRoot,
		"dispatch-freeze.json",
		canonicalJson(dispatchFreeze),
	);

	const manifestEntries: ArtifactManifestEntry[] = listFiles(stagingRoot)
		.filter((path) => path !== "RUN_STATUS")
		.map((path) => {
			const bytes = readFileSync(join(stagingRoot, path));
			return {
				path,
				sha256: hashBytes(bytes),
				bytes: bytes.byteLength,
				recordedAt: deps.clock.wallNow(),
			};
		});
	const manifest = makeArtifactManifestRecord(
		{
			recordedAt: deps.clock.wallNow(),
			sequence: input.sequenceStart + 2,
			runId: input.runId,
			phase: "BINDING",
			operationId: "artifact-manifest",
			clockSource: "offrunner",
		},
		manifestEntries,
	);
	writeDurableExclusive(
		stagingRoot,
		"artifact-manifest.json",
		canonicalJson(manifest),
	);
	const sumPaths = listFiles(stagingRoot).filter(
		(path) => path !== "RUN_STATUS" && path !== "SHA256SUMS",
	);
	writeDurableExclusive(
		stagingRoot,
		"SHA256SUMS",
		sha256Sums(stagingRoot, sumPaths),
	);
	syncDirectory(stagingRoot);

	const verification = await recordOperation(
		{
			runId: input.runId,
			sequence: input.sequenceStart + 3,
			attempt: 1,
			artifactDirectory: join(provisioningRoot, "operations"),
			artifactPathPrefix: "operations",
			spec: {
				operationId: "verify-bound-freeze",
				phase: "BINDING",
				command: process.execPath,
				args: [SEMANTIC_FREEZE_GENERATOR_PATH, "verify", "--root", stagingRoot],
				cwd: ".",
				env: {},
				timeoutMs: 300_000,
				stdin: "ignore",
			},
		},
		{
			clock: deps.clock,
			executionRoot: repositoryPath,
			adapter: {
				execute: async () => {
					try {
						const verified = verifyBoundFreeze(stagingRoot, {
							repositoryPath,
							expectedStatus: "INCOMPLETE",
						});
						return {
							stdout: verified.shellEnvironment,
							stderr: "",
							status: {
								outcome: "SUCCEEDED",
								exitCode: 0,
								signal: null,
							},
						};
					} catch (error) {
						return {
							stdout: "",
							stderr: `${error instanceof Error ? error.message : String(error)}\n`,
							status: {
								outcome: "FAILED",
								exitCode: 1,
								signal: null,
							},
						};
					}
				},
			},
		},
	);
	appendRigJournalEvent(
		input.rigJournalPath,
		{
			state: "BINDING",
			kind: "RESULT",
			operationId: "record-bind-verification",
			details: {
				receiptPath: relative(provisioningRoot, verification.receiptPath),
				receiptArtifactSha256: canonicalArtifactSha256(verification.receipt),
				outcome: verification.receipt.status.outcome,
			},
		},
		{ clock: deps.clock, randomId: deps.randomId },
	);
	if (verification.receipt.status.outcome !== "SUCCEEDED") {
		fail(`independent staging verification failed; preserved ${stagingRoot}`);
	}

	const statusPath = join(stagingRoot, "RUN_STATUS");
	const statusFd = openSync(statusPath, "w");
	try {
		writeFileSync(statusFd, "BOUND\n", "utf8");
		fsyncSync(statusFd);
	} finally {
		closeSync(statusFd);
	}
	syncDirectory(stagingRoot);
	renameSync(stagingRoot, finalRoot);
	syncDirectory(provisioningRoot);
	appendRigJournalEvent(
		input.rigJournalPath,
		{
			state: "BOUND",
			kind: "TRANSITION",
			operationId: "publish-bound-freeze",
			details: {
				root: basename(finalRoot),
				hostBindingArtifactSha256: canonicalArtifactSha256(hostBinding),
				dispatchFreezeArtifactSha256: canonicalArtifactSha256(dispatchFreeze),
			},
		},
		{ clock: deps.clock, randomId: deps.randomId },
	);
	return {
		root: finalRoot,
		hostBinding,
		dispatchFreeze,
		verificationReceipt: verification.receipt,
		verificationReceiptPath: verification.receiptPath,
	};
}

const SEMANTIC_FLAGS = new Set([
	"--run-id",
	"--plan",
	"--controller",
	"--registration-template",
	"--runbook-template",
	"--gate-catalog",
	"--out",
]);

function parseSemanticArgs(args: readonly string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag || !SEMANTIC_FLAGS.has(flag)) {
			fail(`unknown semantic option ${flag ?? "<missing>"}`);
		}
		if (!value || value.startsWith("--")) {
			fail(`option ${flag} requires an explicit value`);
		}
		if (Object.hasOwn(values, flag)) fail(`option ${flag} was repeated`);
		values[flag] = value;
	}
	for (const flag of SEMANTIC_FLAGS) {
		if (!values[flag]) fail(`required option ${flag} is missing`);
	}
	return values;
}

function flag(values: Record<string, string>, name: string): string {
	const value = values[name];
	if (!value) fail(`required option ${name} is missing`);
	return value;
}

export function runFreezeCli(
	args: readonly string[],
	overrides: SemanticFreezeDependencyOverrides = {},
): SemanticFreezeRecord {
	const [mode, ...modeArgs] = args;
	if (mode !== "semantic") {
		fail(`mode must be semantic; got ${mode ?? "<missing>"}`);
	}
	const values = parseSemanticArgs(modeArgs);
	const deps = dependencies(overrides);
	const root = repositoryRoot(deps);
	const record = createSemanticFreeze(
		{
			runId: flag(values, "--run-id"),
			planPath: flag(values, "--plan"),
			controllerPath: flag(values, "--controller"),
			registrationTemplatePath: flag(values, "--registration-template"),
			runbookTemplatePath: flag(values, "--runbook-template"),
			gateCatalogPath: flag(values, "--gate-catalog"),
		},
		deps,
	);
	verifySemanticFreeze(record, deps);
	const output = resolve(root, flag(values, "--out"));
	const outputRelative = relative(root, output);
	if (
		outputRelative === "" ||
		outputRelative === ".." ||
		outputRelative.startsWith(`..${sep}`) ||
		isAbsolute(outputRelative)
	) {
		fail("--out must remain inside the repository");
	}
	deps.atomicWrite(output, canonicalJson(record));
	deps.writeStdout(
		`authoritySha256=${record.authoritySha256}\nartifactSha256=${canonicalArtifactSha256(record)}\n`,
	);
	return record;
}

export function runBoundVerifyCli(
	args: readonly string[],
	overrides: SemanticFreezeDependencyOverrides = {},
): VerifiedBoundFreeze {
	if (args[0] !== "verify") {
		fail(`mode must be verify; got ${args[0] ?? "<missing>"}`);
	}
	let root: string | undefined;
	let repositoryPath = overrides.repositoryPath;
	let manifestOnlySeen = false;
	for (let index = 1; index < args.length; index += 1) {
		const flag = args[index];
		if (flag === "--manifest-only") {
			if (manifestOnlySeen) fail("--manifest-only was repeated");
			manifestOnlySeen = true;
			continue;
		}
		if (flag !== "--root" && flag !== "--repository") {
			fail(`unknown verify option ${flag ?? "<missing>"}`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--")) {
			fail(`option ${flag} requires an explicit value`);
		}
		index += 1;
		if (flag === "--root") {
			if (root !== undefined) fail("--root was repeated");
			root = value;
		} else {
			if (repositoryPath !== undefined) fail("--repository was repeated");
			repositoryPath = value;
		}
	}
	if (!root) fail("required option --root is missing");
	const verified = verifyBoundFreeze(root, {
		repositoryPath,
		expectedStatus: "BOUND",
	});
	(overrides.writeStdout ?? ((value) => process.stdout.write(value)))(
		verified.shellEnvironment,
	);
	return verified;
}

if (import.meta.main) {
	try {
		const args = Bun.argv.slice(2);
		if (args[0] === "verify") {
			runBoundVerifyCli(args);
		} else {
			runFreezeCli(args);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
