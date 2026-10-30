/**
 * The pinned release claim registry (`docs/release-claims.json`) and the
 * per-claim proof validators it names.
 *
 * The registry fixes, for the 1.0 release, which claims exist, which surface
 * each belongs to, whether it blocks GA, and what positive proof a `passed`
 * evidence entry must carry. `docs/release-status.json` only records progress
 * against it: doc-truth refuses a status file whose claim set or `gaRequired`
 * flags differ from the registry, and verification reads the registry from
 * the candidate commit itself, so changing a gate is a code change that
 * invalidates the candidate.
 *
 * A validator accepts an entry only on positive proof in the producing tool's
 * own output format: the recorded outcome is a success, the counts that make
 * the gate meaningful are non-zero, and the commit is the candidate (either
 * recorded in the content, or, for tools whose output carries no commit,
 * through a GitHub Actions producer whose head SHA verification re-checks).
 * Anything else -- an unknown document, `{}`, a text-only bundle -- is refused.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	CONTENT_SCHEMA_NAMES,
	contentProblems,
	type DeclaredFile,
} from "./release-evidence-content.ts";

export const CLAIM_REGISTRY_RELATIVE_PATH = "docs/release-claims.json";

export type ProofSpec = ProofKind & {
	/** The files a bundle for this proof may contain, each with its content
	 * schema (scripts/release-evidence-content.ts). Anything else is refused. */
	files: DeclaredFile[];
};

/** Proof kinds a local (operator-run) producer may carry: human records
 * (a review verdict, a freeze confirmation). Everything else is tool output
 * and must come from a registered GitHub Actions producer through `fetch`. */
export const LOCAL_PROOF_KINDS: ReadonlySet<string> = new Set([
	"review-record",
	"no-change-confirmation",
]);

/**
 * Where a machine-produced claim's evidence may come from. A run is accepted
 * only when its workflow file (by repository path, as the Actions API reports
 * it) is `workflow`, that file at the candidate commit hashes to
 * `workflowSha256` (the reviewed workflow; doc-truth keeps the hash current),
 * one of `jobs` ran in it and every run of those jobs succeeded, and the
 * artifact's name matches the `artifact` glob.
 */
export type ProducerPolicy = {
	workflow: string;
	workflowSha256: string;
	jobs: string[];
	artifact: string;
};

export type ProofKind =
	| {
			kind: "command-records";
			minRecords?: number;
			commandPatterns?: string[];
			platforms?: string[];
	  }
	| { kind: "playwright-report"; minExpected?: number }
	| { kind: "fault-matrix"; profiles: string[] }
	| { kind: "fuzz-release-smoke" }
	| { kind: "llvm-cov-floors" }
	| { kind: "distributed-scale"; minSessions: number }
	| { kind: "npm-publish-identity" }
	| { kind: "soak-aggregate"; hours: number }
	| { kind: "iwa-proof" }
	| { kind: "review-record" }
	| { kind: "no-change-confirmation" };

export type RegisteredClaim = {
	id: string;
	surface: "native" | "wasm" | "release";
	gaRequired: boolean;
	proof: ProofSpec;
	/** Required for every machine proof kind; absent for local kinds. */
	producers?: ProducerPolicy[];
};

export type ClaimRegistry = { schemaVersion: 1; claims: RegisteredClaim[] };

export type ProofMember = { name: string; data: Uint8Array };

export type ProofContext = {
	commit: string;
	producerKind: "github-actions" | "local";
	members: ProofMember[];
	/** Repository root holding the floor checker used by `llvm-cov-floors`. */
	root: string;
};

const PROOF_KINDS = new Set([
	"command-records",
	"playwright-report",
	"fault-matrix",
	"fuzz-release-smoke",
	"llvm-cov-floors",
	"distributed-scale",
	"npm-publish-identity",
	"soak-aggregate",
	"iwa-proof",
	"review-record",
	"no-change-confirmation",
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registrySha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function validateRegistry(value: unknown): string[] {
	const errors: string[] = [];
	if (!isObject(value)) return ["claim registry: must be an object"];
	if (value.schemaVersion !== 1)
		errors.push("claim registry: schemaVersion must be 1");
	if (!Array.isArray(value.claims) || value.claims.length === 0) {
		errors.push("claim registry: claims must be a non-empty array");
		return errors;
	}
	const ids = new Set<string>();
	value.claims.forEach((claim, index) => {
		const at = `claim registry claims[${index}]`;
		if (!isObject(claim)) {
			errors.push(`${at}: must be an object`);
			return;
		}
		const keys = Object.keys(claim)
			.filter((key) => key !== "producers")
			.sort()
			.join(",");
		if (keys !== "gaRequired,id,proof,surface")
			errors.push(
				`${at}: must have exactly id, surface, gaRequired, proof (and producers)`,
			);
		if (isObject(claim.proof) && typeof claim.proof.kind === "string") {
			const local = LOCAL_PROOF_KINDS.has(claim.proof.kind);
			if (local && claim.producers !== undefined)
				errors.push(
					`${at}.producers: a ${claim.proof.kind} record is human work and has no CI producer`,
				);
			if (!local)
				errors.push(
					...producerPolicyErrors(claim.producers, `${at}.producers`),
				);
		}
		if (typeof claim.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(claim.id))
			errors.push(`${at}.id: invalid`);
		else if (ids.has(claim.id)) errors.push(`${at}.id: duplicate ${claim.id}`);
		else ids.add(claim.id);
		if (!["native", "wasm", "release"].includes(claim.surface as string))
			errors.push(`${at}.surface: must be native, wasm or release`);
		if (typeof claim.gaRequired !== "boolean")
			errors.push(`${at}.gaRequired: must be a boolean`);
		if (!isObject(claim.proof) || !PROOF_KINDS.has(claim.proof.kind as string))
			errors.push(`${at}.proof: unknown proof kind`);
		else {
			const profiles = claim.proof.profiles;
			if (
				claim.proof.kind === "fault-matrix" &&
				(!Array.isArray(profiles) ||
					profiles.length === 0 ||
					!profiles.every((p) => typeof p === "string" && p.length > 0))
			)
				errors.push(`${at}.proof.profiles: must list the fault profiles`);
			const files = claim.proof.files;
			if (!Array.isArray(files) || files.length === 0)
				errors.push(
					`${at}.proof.files: must declare the files a bundle may contain`,
				);
			else
				files.forEach((file, fileIndex) => {
					if (
						!isObject(file) ||
						Object.keys(file).sort().join(",") !== "match,schema" ||
						typeof file.match !== "string" ||
						!/^[A-Za-z0-9._*/-]+$/.test(file.match) ||
						typeof file.schema !== "string" ||
						!CONTENT_SCHEMA_NAMES.has(file.schema)
					)
						errors.push(
							`${at}.proof.files[${fileIndex}]: must be {match: <glob>, schema: <known content schema>}`,
						);
				});
		}
	});
	return errors;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

function producerPolicyErrors(value: unknown, at: string): string[] {
	if (!Array.isArray(value) || value.length === 0)
		return [
			`${at}: a machine-produced claim must name its CI producer(s) (workflow, workflowSha256, jobs, artifact)`,
		];
	const errors: string[] = [];
	value.forEach((policy, index) => {
		const where = `${at}[${index}]`;
		if (
			!isObject(policy) ||
			Object.keys(policy).sort().join(",") !==
				"artifact,jobs,workflow,workflowSha256"
		) {
			errors.push(
				`${where}: must be exactly {workflow, workflowSha256, jobs, artifact}`,
			);
			return;
		}
		if (
			typeof policy.workflow !== "string" ||
			!WORKFLOW_PATH.test(policy.workflow)
		)
			errors.push(`${where}.workflow: must be a .github/workflows/<file> path`);
		if (
			typeof policy.workflowSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(policy.workflowSha256)
		)
			errors.push(`${where}.workflowSha256: must be a sha256 hex digest`);
		if (
			!Array.isArray(policy.jobs) ||
			policy.jobs.length === 0 ||
			!policy.jobs.every(
				(job) => typeof job === "string" && /^[A-Za-z0-9_-]+$/.test(job),
			)
		)
			errors.push(`${where}.jobs: must list workflow job ids`);
		if (
			typeof policy.artifact !== "string" ||
			!/^[A-Za-z0-9._*-]+$/.test(policy.artifact)
		)
			errors.push(`${where}.artifact: must be an artifact name glob`);
	});
	return errors;
}

// ---------------------------------------------------------------------------
// Producer policy

export function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** An artifact-name glob (`*` = any run of name characters) as a RegExp. */
export function artifactGlob(glob: string): RegExp {
	return new RegExp(
		`^${glob
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join("[A-Za-z0-9._-]*")}$`,
	);
}

/** A workflow string template: each `${{ expression }}` stands for any text. */
export function templatePattern(template: string): RegExp {
	return new RegExp(
		`^${template
			.split(/\$\{\{[^}]*\}\}/)
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".+")}$`,
	);
}

type WorkflowJob = {
	name?: unknown;
	steps?: { uses?: unknown; with?: Record<string, unknown> }[];
};

export function parseWorkflow(text: string): Record<string, WorkflowJob> {
	const parsed = Bun.YAML.parse(text) as unknown;
	const jobs = isObject(parsed) ? parsed.jobs : undefined;
	return isObject(jobs) ? (jobs as Record<string, WorkflowJob>) : {};
}

/** How the Actions API names a job's runs: its `name:` (or id), with a
 * ` (matrix values)` suffix for matrix jobs whose name has no expression. */
export function jobDisplayPattern(id: string, job: WorkflowJob): RegExp {
	const base = typeof job.name === "string" ? job.name : id;
	const core = templatePattern(base).source.slice(1, -1);
	return new RegExp(`^${core}(?: \\(.+\\))?$`);
}

/** Names of the artifacts a job uploads (workflow templates). */
export function jobArtifactTemplates(job: WorkflowJob): string[] {
	return (Array.isArray(job.steps) ? job.steps : [])
		.filter(
			(step) =>
				isObject(step) &&
				typeof step.uses === "string" &&
				step.uses.startsWith("actions/upload-artifact@"),
		)
		.map((step) => step.with?.name)
		.filter((name): name is string => typeof name === "string");
}

export type ProducingRun = {
	/** The run's workflow file as the Actions API reports it (`path`). */
	path: string;
	artifact: string;
	jobs: { name?: string; status?: string; conclusion?: string }[];
};

/** Normalise the API's `path` (`.github/workflows/x.yml@refs/...`). */
export function workflowPathOf(path: string): string {
	const at = path.indexOf("@");
	return at === -1 ? path : path.slice(0, at);
}

/**
 * Why `run` is not an accepted producer for `claim`, or [] when one of the
 * claim's registered producers accepts it. `workflowAt` returns a workflow
 * file's text at the candidate commit (undefined when it does not exist).
 */
export function producerPolicyProblems(
	claim: RegisteredClaim,
	run: ProducingRun,
	workflowAt: (path: string) => string | undefined,
): string[] {
	const policies = claim.producers ?? [];
	if (policies.length === 0)
		return [`claim ${claim.id} has no registered CI producer`];
	const path = workflowPathOf(run.path);
	const rejected: string[] = [];
	for (const policy of policies) {
		const why: string[] = [];
		if (path !== policy.workflow)
			why.push(
				`run workflow is ${path || "<unknown>"}, not ${policy.workflow}`,
			);
		if (!artifactGlob(policy.artifact).test(run.artifact))
			why.push(`artifact ${run.artifact} does not match ${policy.artifact}`);
		const text = why.length === 0 ? workflowAt(policy.workflow) : undefined;
		if (why.length === 0 && text === undefined)
			why.push(`${policy.workflow} does not exist at the candidate`);
		if (text !== undefined) {
			if (sha256Text(text) !== policy.workflowSha256)
				why.push(
					`${policy.workflow} at the candidate is not the reviewed workflow (sha256 differs from the registry)`,
				);
			const jobs = parseWorkflow(text);
			const ran: typeof run.jobs = [];
			for (const id of policy.jobs) {
				const job = jobs[id];
				if (!job) {
					why.push(`${policy.workflow} has no job ${id}`);
					continue;
				}
				const pattern = jobDisplayPattern(id, job);
				ran.push(...run.jobs.filter((j) => pattern.test(String(j.name ?? ""))));
			}
			if (ran.length === 0)
				why.push(`no ${policy.jobs.join("/")} job ran in the run`);
			else if (
				ran.some(
					(job) => job.status !== "completed" || job.conclusion !== "success",
				)
			)
				why.push(
					`a ${policy.jobs.join("/")} job did not complete successfully`,
				);
		}
		if (why.length === 0) return [];
		rejected.push(`${policy.workflow}: ${why.join("; ")}`);
	}
	return [
		`claim ${claim.id} does not accept this producer (${rejected.join(" | ")})`,
	];
}

export function parseRegistry(text: string): ClaimRegistry {
	const value = JSON.parse(text) as unknown;
	const errors = validateRegistry(value);
	if (errors.length > 0)
		throw new Error(`invalid claim registry:\n - ${errors.join("\n - ")}`);
	return value as ClaimRegistry;
}

// ---------------------------------------------------------------------------
// helpers

function parsedJson(members: ProofMember[]): { name: string; doc: unknown }[] {
	const out: { name: string; doc: unknown }[] = [];
	for (const member of members) {
		if (!member.name.endsWith(".json")) continue;
		try {
			out.push({
				name: member.name,
				doc: JSON.parse(new TextDecoder().decode(member.data)),
			});
		} catch {
			// unparseable JSON is reported by the privacy scan
		}
	}
	return out;
}

function positiveInt(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function requireProvenance(ctx: ProofContext, what: string): string[] {
	return ctx.producerKind === "github-actions"
		? []
		: [
				`${what} is tool output; it must be fetched from the GitHub Actions run that produced it (release-evidence.ts fetch), whose head SHA binds it to the candidate`,
			];
}

// ---------------------------------------------------------------------------
// validators

type CommandRecord = {
	schemaVersion: number;
	kind: string;
	commit: string;
	command: string[];
	exitCode: number;
	platform?: { os?: string };
};

function commandRecords(
	ctx: ProofContext,
	spec: Extract<ProofSpec, { kind: "command-records" }>,
): string[] {
	const problems: string[] = [];
	const docs = parsedJson(ctx.members);
	const records = docs.filter(
		(d) => isObject(d.doc) && d.doc.kind === "command",
	) as { name: string; doc: CommandRecord }[];
	const minRecords = spec.minRecords ?? 1;
	if (records.length < minRecords)
		problems.push(
			`expected at least ${minRecords} command record(s) (scripts/generate-release-evidence.ts), found ${records.length}`,
		);
	for (const { name, doc } of records) {
		if (doc.schemaVersion !== 1)
			problems.push(`${name}: schemaVersion must be 1`);
		if (doc.commit !== ctx.commit)
			problems.push(
				`${name}: records commit ${String(doc.commit)}, not the candidate`,
			);
		if (doc.exitCode !== 0)
			problems.push(`${name}: exitCode ${String(doc.exitCode)}`);
		if (!Array.isArray(doc.command) || doc.command.length === 0)
			problems.push(`${name}: no command`);
	}
	for (const { name, doc } of docs) {
		if (!isObject(doc) || doc.kind !== "summary") continue;
		if (doc.commit !== ctx.commit)
			problems.push(`${name}: summary records another commit`);
		if (doc.recordCount !== records.length)
			problems.push(
				`${name}: summary recordCount does not match the bundled records`,
			);
	}
	const joined = records.map((r) =>
		Array.isArray(r.doc.command) ? r.doc.command.join(" ") : "",
	);
	for (const pattern of spec.commandPatterns ?? []) {
		if (!joined.some((command) => command.includes(pattern)))
			problems.push(`no command record runs ${JSON.stringify(pattern)}`);
	}
	for (const os of spec.platforms ?? []) {
		if (!records.some((r) => r.doc.platform?.os === os))
			problems.push(`no command record from platform ${os}`);
	}
	return problems;
}

type Spec = {
	ok?: unknown;
	specs?: unknown;
	suites?: unknown;
	tests?: unknown;
};

function collectSpecs(suites: unknown, into: Spec[]): void {
	if (!Array.isArray(suites)) return;
	for (const suite of suites) {
		if (!isObject(suite)) continue;
		if (Array.isArray(suite.specs))
			for (const spec of suite.specs) if (isObject(spec)) into.push(spec);
		collectSpecs(suite.suites, into);
	}
}

function playwrightReport(
	ctx: ProofContext,
	spec: Extract<ProofSpec, { kind: "playwright-report" }>,
): string[] {
	const reports = parsedJson(ctx.members).filter(
		(d) =>
			isObject(d.doc) && isObject(d.doc.stats) && Array.isArray(d.doc.suites),
	);
	if (reports.length === 0)
		return ["no Playwright JSON report (config/suites/stats)"];
	const problems = requireProvenance(ctx, "a Playwright report");
	for (const { name, doc } of reports) {
		const report = doc as Record<string, unknown>;
		const stats = report.stats as Record<string, unknown>;
		const minExpected = spec.minExpected ?? 1;
		if (
			!positiveInt(stats.expected) ||
			(stats.expected as number) < minExpected
		)
			problems.push(`${name}: stats.expected must be at least ${minExpected}`);
		if (stats.unexpected !== 0)
			problems.push(`${name}: stats.unexpected is not 0`);
		if (stats.flaky !== 0) problems.push(`${name}: stats.flaky is not 0`);
		if (Array.isArray(report.errors) && report.errors.length > 0)
			problems.push(`${name}: reporter recorded errors`);
		const specs: Spec[] = [];
		collectSpecs(report.suites, specs);
		if (specs.length === 0) problems.push(`${name}: no test specs`);
		if (specs.some((s) => s.ok !== true))
			problems.push(`${name}: a spec is not ok`);
	}
	return problems;
}

/**
 * The seeded UDP fault matrix (tools/interop/tests/fault-matrix.spec.ts):
 * its own evidence record must show every registered profile ran, recovered
 * (the bidi payload round-tripped) and actually injected its fault, bound to
 * the candidate; the run's Playwright report must show the case passed.
 */
function faultMatrix(
	ctx: ProofContext,
	spec: Extract<ProofSpec, { kind: "fault-matrix" }>,
): string[] {
	const docs = parsedJson(ctx.members);
	const records = docs.filter(
		(d) =>
			isObject(d.doc) &&
			Array.isArray((d.doc as Record<string, unknown>).scenarios),
	);
	if (records.length !== 1)
		return ["expected exactly one fault-matrix evidence record"];
	const report = playwrightReport(
		{ ...ctx, members: ctx.members.filter((m) => m.name !== records[0]?.name) },
		{ kind: "playwright-report", minExpected: 1, files: [] },
	);
	const problems = report.map((problem) => `report: ${problem}`);
	const record = records[0]?.doc as Record<string, unknown>;
	if (record.status !== "passed")
		problems.push("fault matrix status is not passed");
	if (record.sourceCommit !== ctx.commit)
		problems.push("fault matrix sourceCommit is not the candidate");
	const scenarios = (record.scenarios as unknown[]).filter(isObject);
	const names = scenarios.map((s) =>
		isObject(s.profile) ? s.profile.name : undefined,
	);
	if (JSON.stringify(names) !== JSON.stringify(spec.profiles))
		problems.push(
			`fault matrix scenarios are not exactly ${spec.profiles.join(", ")}`,
		);
	for (const scenario of scenarios) {
		const profile = isObject(scenario.profile) ? scenario.profile : {};
		const stats = isObject(scenario.stats) ? scenario.stats : {};
		const name = String(profile.name);
		if (scenario.payload !== `fault-matrix-${name}`)
			problems.push(`${name}: payload did not round-trip`);
		const injected = (key: string) =>
			typeof stats[key] === "number" && (stats[key] as number) > 0;
		if (profile.lossRate && !injected("dropped"))
			problems.push(`${name}: no loss injected`);
		if (profile.duplicateRate && !injected("duplicated"))
			problems.push(`${name}: no duplication injected`);
		if (profile.reorderRate && !injected("reordered"))
			problems.push(`${name}: no reordering injected`);
		if ((profile.delayMs || profile.jitterMs) && !injected("delayed"))
			problems.push(`${name}: no delay injected`);
		if (profile.burstLoss && !injected("burstDropped"))
			problems.push(`${name}: no burst loss injected`);
		if (profile.blackHole && !injected("blackHoled"))
			problems.push(`${name}: no black hole injected`);
		if (!injected("forwarded")) problems.push(`${name}: nothing was forwarded`);
	}
	return problems;
}

function fuzzReleaseSmoke(ctx: ProofContext): string[] {
	const docs = parsedJson(ctx.members).filter(
		(d) => basename(d.name) === "release-smoke.json",
	);
	if (docs.length !== 1) return ["expected exactly one release-smoke.json"];
	const problems = requireProvenance(ctx, "the fuzz release smoke");
	const doc = docs[0]?.doc;
	if (!isObject(doc))
		return [...problems, "release-smoke.json is not an object"];
	if (!Array.isArray(doc.failures) || doc.failures.length !== 0)
		problems.push("release-smoke.json records failures");
	if (!Array.isArray(doc.commandResults) || doc.commandResults.length === 0)
		problems.push("release-smoke.json ran no commands");
	else
		doc.commandResults.forEach((result, index) => {
			if (
				!isObject(result) ||
				result.exitCode !== 0 ||
				result.timedOut !== false
			)
				problems.push(
					`release-smoke.json commandResults[${index}] did not exit 0 in time`,
				);
		});
	if (
		!Array.isArray(doc.corpora) ||
		doc.corpora.length === 0 ||
		doc.corpora.some(
			(c) => !isObject(c) || !Array.isArray(c.files) || c.files.length === 0,
		)
	)
		problems.push("release-smoke.json lists an empty or missing corpus");
	if (!positiveInt(doc.fixedDurationSecs))
		problems.push("release-smoke.json has no positive fuzz duration");
	return problems;
}

/** Re-runs the real floor gate (scripts/check-llvm-cov-floors.py) over the
 * bundled reports instead of trusting a recorded verdict. */
function llvmCovFloors(ctx: ProofContext): string[] {
	const problems = requireProvenance(ctx, "the coverage report");
	const find = (file: string) =>
		ctx.members.filter((m) => basename(m.name) === file);
	const needed = {
		"native-coverage.json": "coverage/native-coverage.json",
		"wasm-coverage.json": "coverage/wasm-coverage.json",
		"lcov.info": "coverage/bun/lcov.info",
	} as const;
	const work = mkdtempSync(join(tmpdir(), "release-claims-coverage-"));
	try {
		for (const [file, target] of Object.entries(needed)) {
			const found = find(file);
			if (found.length !== 1) {
				problems.push(`expected exactly one ${file}`);
				continue;
			}
			const path = join(work, target);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, found[0]?.data as Uint8Array);
		}
		if (problems.length > 0) return problems;
		const python = process.platform === "win32" ? "python" : "python3";
		const result = spawnSync(
			python,
			[join(ctx.root, "scripts", "check-llvm-cov-floors.py")],
			{ cwd: work, encoding: "utf8" },
		);
		if (result.error)
			problems.push(
				`coverage floor gate could not run: ${result.error.message}`,
			);
		else if (result.status !== 0)
			problems.push(
				`coverage floor gate failed: ${(result.stdout || result.stderr).trim().split("\n")[0] ?? ""}`,
			);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return problems;
}

function distributedScale(
	ctx: ProofContext,
	spec: Extract<ProofSpec, { kind: "distributed-scale" }>,
): string[] {
	const docs = parsedJson(ctx.members).filter(
		(d) =>
			isObject(d.doc) &&
			"promotable" in (d.doc as object) &&
			isObject((d.doc as Record<string, unknown>).summary),
	);
	if (docs.length !== 1)
		return ["expected exactly one distributed-scale artifact"];
	const doc = docs[0]?.doc as Record<string, unknown>;
	const summary = doc.summary as Record<string, unknown>;
	const source = isObject(doc.source) ? doc.source : {};
	const problems: string[] = [];
	if (doc.promotable !== true) problems.push("artifact is not promotable");
	if (doc.acknowledgedReviewRequired !== false)
		problems.push("artifact acknowledges review-required diagnostics");
	if (source.sha !== ctx.commit)
		problems.push("artifact source.sha is not the candidate");
	if (!Array.isArray(summary.failures) || summary.failures.length !== 0)
		problems.push("summary records failures");
	if (
		!Array.isArray(summary.reviewRequired) ||
		summary.reviewRequired.length !== 0
	)
		problems.push("summary records review-required diagnostics");
	if (
		typeof summary.totalOkSessions !== "number" ||
		summary.totalOkSessions < spec.minSessions
	)
		problems.push(`summary.totalOkSessions is below ${spec.minSessions}`);
	return problems;
}

function npmPublishIdentity(ctx: ProofContext): string[] {
	const docs = parsedJson(ctx.members).filter(
		(d) => basename(d.name) === "candidate-identity.json",
	);
	if (docs.length !== 1)
		return ["expected exactly one candidate-identity.json"];
	const doc = docs[0]?.doc;
	if (!isObject(doc)) return ["candidate-identity.json is not an object"];
	const problems: string[] = [];
	if (doc.schemaVersion !== 1)
		problems.push("candidate-identity.json schemaVersion must be 1");
	if (doc.candidateCommit !== ctx.commit)
		problems.push("candidate-identity.json is bound to another commit");
	if (doc.workflowPath !== ".github/workflows/release.yml")
		problems.push(
			"candidate-identity.json was not produced by the release workflow",
		);
	if (!positiveInt(doc.releaseRunId) || !positiveInt(doc.releaseRunAttempt))
		problems.push("candidate-identity.json has no release run identity");
	if (
		typeof doc.tarballSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(doc.tarballSha256)
	)
		problems.push("candidate-identity.json has no tarball digest");
	if (
		typeof doc.tag !== "string" ||
		!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(doc.tag)
	)
		problems.push("candidate-identity.json has no release tag");
	// The published version is stamped from the tag at build time.
	else if (doc.packageVersion !== doc.tag.slice(1))
		problems.push(
			"candidate-identity.json packageVersion is not the version stamped from its tag",
		);
	return problems;
}

function soakAggregate(
	ctx: ProofContext,
	spec: Extract<ProofSpec, { kind: "soak-aggregate" }>,
): string[] {
	const docs = parsedJson(ctx.members).filter(
		(d) =>
			isObject(d.doc) &&
			(d.doc as Record<string, unknown>).mode === "aggregate",
	);
	if (docs.length !== 1)
		return ["expected exactly one soak aggregate (mode=aggregate)"];
	const doc = docs[0]?.doc as Record<string, unknown>;
	const problems: string[] = [];
	if (doc.status !== "pass") problems.push("aggregate status is not pass");
	if (doc.candidateCommit !== ctx.commit)
		problems.push("aggregate candidateCommit is not the candidate");
	if (
		!positiveInt(doc.segmentCount) ||
		doc.segmentCount !== doc.expectedSegmentCount
	)
		problems.push("aggregate segment count is incomplete");
	const segments = Array.isArray(doc.segments) ? doc.segments : [];
	if (
		segments.length !== doc.segmentCount ||
		segments.some((s) => !isObject(s) || s.status !== "pass")
	)
		problems.push("aggregate lists a missing or failed segment");
	// Segments run their workload for the full planned share of the campaign;
	// a 2% allowance covers setup/teardown rounding, nothing more.
	const required = spec.hours * 3600 * 0.98;
	if (
		typeof doc.totalDurationSeconds !== "number" ||
		doc.totalDurationSeconds < required
	)
		problems.push(`aggregate covers less than ${spec.hours}h of soak`);
	if (!positiveInt(doc.datagramsSent))
		problems.push("aggregate sent no datagrams");
	if (typeof doc.aggregateHash !== "string")
		problems.push("aggregate has no aggregateHash");
	return problems;
}

/** The fields of run-iwa.mjs evidence the validator reads; all untrusted. */
type IwaEvidence = {
	schemaVersion?: unknown;
	status?: unknown;
	executionIdentity?: unknown;
	protocol?: unknown;
	crossOriginIsolated?: unknown;
	directSockets?: unknown;
	functional?: {
		datagram?: unknown;
		bidi?: unknown;
		uni?: unknown;
		resetCode?: unknown;
		stopSendingCode?: unknown;
		peerClose?: { code?: unknown };
	};
	reconnects?: unknown;
	certificateRotation?: {
		oldPinRejected?: unknown;
		oldHash?: unknown;
		newHash?: unknown;
		payload?: unknown;
	};
	sourceCommit?: unknown;
};

/** Mirrors validateEvidence in tools/interop/run-iwa.mjs, plus the commit. */
function iwaProof(ctx: ProofContext): string[] {
	const docs = parsedJson(ctx.members).filter(
		(d) =>
			isObject(d.doc) &&
			(d.doc as Record<string, unknown>).executionIdentity !== undefined,
	);
	if (docs.length === 0)
		return ["no IWA proof document (run-iwa.mjs evidence.json)"];
	const problems: string[] = [];
	for (const { name, doc } of docs) {
		const e = doc as IwaEvidence;
		const fail = (message: string) => problems.push(`${name}: ${message}`);
		if (e.schemaVersion !== 1) fail("schemaVersion must be 1");
		if (e.status !== "passed") fail("status is not passed");
		if (e.executionIdentity !== "browser-iwa-direct-sockets")
			fail("wrong execution identity");
		if (e.protocol !== "isolated-app:") fail("page was not an installed IWA");
		if (e.crossOriginIsolated !== true) fail("IWA was not isolated");
		if (e.directSockets !== true) fail("Direct Sockets was not exercised");
		if (e.functional?.datagram !== "iwa-datagram") fail("datagram failed");
		if (e.functional?.bidi !== "iwa-bidi") fail("bidi failed");
		if (e.functional?.uni !== "iwa-uni") fail("uni failed");
		if (e.functional?.resetCode !== 37) fail("RESET_STREAM code failed");
		if (e.functional?.stopSendingCode !== 41) fail("STOP_SENDING code failed");
		if (e.functional?.peerClose?.code !== 4100) fail("peer close failed");
		const reconnects = Array.isArray(e.reconnects) ? e.reconnects : [];
		if (
			reconnects.length !== 8 ||
			reconnects.some(
				(r: { attempt?: unknown; payload?: unknown } | null, i: number) =>
					r?.attempt !== i + 1 || r?.payload !== `iwa-reconnect-${i + 1}`,
			)
		)
			fail("expected eight successful reconnects");
		if (e.certificateRotation?.oldPinRejected !== true)
			fail("stale certificate pin was not rejected");
		if (
			typeof e.certificateRotation?.oldHash !== "string" ||
			e.certificateRotation.oldHash === e.certificateRotation?.newHash
		)
			fail("certificate hash did not rotate");
		if (e.certificateRotation?.payload !== "iwa-rotated-cert")
			fail("rotated certificate path did not exchange a payload");
		if (e.sourceCommit !== ctx.commit)
			fail("sourceCommit is not the candidate");
	}
	return problems;
}

const SEVERITIES = ["P0", "P1", "P2", "P3", "P4"] as const;

/** Release review record: `{schemaVersion: 1, kind: "review", commit,
 * reviewer, scope, verdict: "pass", findings: {P0..P4: 0}}`. */
function reviewRecord(ctx: ProofContext): string[] {
	const docs = parsedJson(ctx.members).filter(
		(d) =>
			isObject(d.doc) && (d.doc as Record<string, unknown>).kind === "review",
	);
	if (docs.length === 0) return ["no review record (kind=review)"];
	const problems: string[] = [];
	for (const { name, doc } of docs) {
		const r = doc as Record<string, unknown>;
		if (r.schemaVersion !== 1)
			problems.push(`${name}: schemaVersion must be 1`);
		if (r.commit !== ctx.commit)
			problems.push(`${name}: reviewed another commit`);
		if (r.verdict !== "pass") problems.push(`${name}: verdict is not pass`);
		if (typeof r.reviewer !== "string" || r.reviewer.length === 0)
			problems.push(`${name}: no reviewer`);
		if (typeof r.scope !== "string" || r.scope.length === 0)
			problems.push(`${name}: no scope`);
		const findings = isObject(r.findings) ? r.findings : undefined;
		for (const severity of SEVERITIES)
			if (findings?.[severity] !== 0)
				problems.push(`${name}: ${severity} findings are not 0`);
	}
	return problems;
}

/** Final freeze record: `{schemaVersion: 1, kind: "no-change-confirmation",
 * commit, frozenAt, verdict: "pass", changedFilesSinceFreeze: []}`. */
function noChangeConfirmation(ctx: ProofContext): string[] {
	const docs = parsedJson(ctx.members).filter(
		(d) =>
			isObject(d.doc) &&
			(d.doc as Record<string, unknown>).kind === "no-change-confirmation",
	);
	if (docs.length !== 1)
		return ["expected exactly one no-change-confirmation record"];
	const r = docs[0]?.doc as Record<string, unknown>;
	const problems: string[] = [];
	if (r.schemaVersion !== 1) problems.push("schemaVersion must be 1");
	if (r.commit !== ctx.commit) problems.push("confirms another commit");
	if (r.verdict !== "pass") problems.push("verdict is not pass");
	if (
		!Array.isArray(r.changedFilesSinceFreeze) ||
		r.changedFilesSinceFreeze.length !== 0
	)
		problems.push("files changed since the freeze");
	if (
		typeof r.frozenAt !== "string" ||
		!Number.isFinite(Date.parse(r.frozenAt))
	)
		problems.push("no frozenAt timestamp");
	return problems;
}

/** Positive-proof check of one passed entry for one registered claim. */
export function validateClaimProof(
	claim: RegisteredClaim,
	ctx: ProofContext,
): string[] {
	const spec = claim.proof;
	// Content is allowlisted before any outcome is read: undeclared files,
	// unknown fields and untyped values are refused outright.
	const content = contentProblems(ctx.members, spec.files);
	if (content.length > 0) return content;
	// Tool output is only evidence when an Actions run produced it.
	if (!LOCAL_PROOF_KINDS.has(spec.kind)) {
		const provenance = requireProvenance(ctx, spec.kind);
		if (provenance.length > 0) return provenance;
	}
	switch (spec.kind) {
		case "command-records":
			return commandRecords(ctx, spec);
		case "playwright-report":
			return playwrightReport(ctx, spec);
		case "fault-matrix":
			return faultMatrix(ctx, spec);
		case "fuzz-release-smoke":
			return fuzzReleaseSmoke(ctx);
		case "llvm-cov-floors":
			return llvmCovFloors(ctx);
		case "distributed-scale":
			return distributedScale(ctx, spec);
		case "npm-publish-identity":
			return npmPublishIdentity(ctx);
		case "soak-aggregate":
			return soakAggregate(ctx, spec);
		case "iwa-proof":
			return iwaProof(ctx);
		case "review-record":
			return reviewRecord(ctx);
		case "no-change-confirmation":
			return noChangeConfirmation(ctx);
	}
}
