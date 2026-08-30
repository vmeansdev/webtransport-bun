import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	type ArtifactIdentity,
	canonicalArtifactSha256,
	canonicalJson,
	makeAuthorityRecord,
	type SemanticFreezeAuthority,
	type SemanticFreezeRecord,
	validateRecordSequence,
	validateReviewReceipt,
	validateSemanticApprovalRecord,
	validateSemanticFreezeRecord,
} from "./g6-c32-freeze-model.ts";

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

if (import.meta.main) {
	try {
		runFreezeCli(Bun.argv.slice(2));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
