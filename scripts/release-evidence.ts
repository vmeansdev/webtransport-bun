#!/usr/bin/env bun
/**
 * Release evidence lifecycle: package -> upload -> import -> verify.
 *
 * Evidence files are GitHub Release assets of the candidate pre-release; the
 * repository only carries the checksum manifest
 * (`docs/release-evidence-manifest.json`). See docs/RELEASE_CHECKLIST.md.
 *
 *   bind     --commit <sha> --tag <vX.Y.Z-rc.N> [--package-version <v>] [--reset]
 *   package  --claim <id>... --input <path>... --local <description>   (local producers only)
 *            [--id <entry-id>] [--status passed|failed] [--bundle] [--out-dir <dir>]
 *            [--fragment <file> --commit <sha> [--tag <tag>]] [--repo-root <path>...]
 *            [--redact-host-paths] [--forbid <literal>...]
 *   fetch    --run <id> --artifact <name> [--workflow <name>] [--select <subpath>...] --claim <id>...
 *            [--fragment <file> --commit <sha> [--tag <tag>]] [--out-dir <dir>] [--repo-root <path>...]
 *            [--redact-host-paths]   (CI evidence: the run is read back from the Actions API --
 *            same repository/workflow, head SHA = candidate, concluded success, or the in-progress
 *            run packaging its own evidence from inside itself -- and the bytes are the named
 *            artifact's, whose id/name/digest are recorded and re-checked by verify)
 *   import   --fragment <file>... | --from-release
 *   upload   [--tag <tag>] [--assets-dir <dir>] [--fragment <file>] [--create-prerelease] [--execute]
 *   verify   [--ga-tag <vX.Y.Z>] [--require-ready | --integrity-only] [--json]
 *            [--assets-dir <dir>]   (audit only: reads assets from disk; never promotable)
 *
 * Every command takes `--root <dir>` (default: this checkout) and `--repo
 * <owner/name>` (default: the manifest's repository). `upload` is a dry run
 * unless `--execute` is given, and never creates a release unless
 * `--create-prerelease` is also given. Nothing here creates tags.
 *
 * Every `passed` entry must carry the positive proof its claim's entry in
 * docs/release-claims.json requires (scripts/release-claims.ts); packaging
 * and verification both enforce it.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { registrySha256 } from "./release-claims.ts";
import {
	ASSET_NAME,
	type BundleFile,
	CLAIM_ID,
	collectInputs,
	createTarGz,
	DEFAULT_ROOT,
	ENTRY_ID,
	type EvidenceStatus,
	FRAGMENT_ASSET_NAME,
	FRAGMENT_KIND,
	type Fragment,
	type GithubActionsProducer,
	ghJson,
	inspectMembers,
	listRunArtifacts,
	loadManifest,
	loadWorkingRegistry,
	MANIFEST_RELATIVE_PATH,
	type Manifest,
	type ManifestEntry,
	mergeEntries,
	type Producer,
	packageVersionAt,
	RELEASE_TAG,
	REPOSITORY,
	type ReleaseStatus,
	readJsonFile,
	registryTextAt,
	remoteTagCommit,
	runGh,
	SHA40,
	STATUS_RELATIVE_PATH,
	scrubFile,
	sha256Hex,
	tagMatchesVersion,
	validateFragment,
	verifyRelease,
	viewRelease,
	writeManifest,
} from "./release-evidence-lib.ts";

type Args = {
	command: string;
	values: Map<string, string[]>;
	flags: Set<string>;
};

const BOOLEAN_FLAGS = new Set([
	"--bundle",
	"--redact-host-paths",
	"--execute",
	"--create-prerelease",
	"--from-release",
	"--reset",
	"--json",
	"--require-ready",
	"--integrity-only",
]);

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
	const [command = "", ...rest] = argv;
	const values = new Map<string, string[]>();
	const flags = new Set<string>();
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index] as string;
		if (!arg.startsWith("--"))
			throw new UsageError(`unexpected argument ${arg}`);
		if (BOOLEAN_FLAGS.has(arg)) {
			flags.add(arg);
			continue;
		}
		const value = rest[index + 1];
		if (value === undefined || value.startsWith("--"))
			throw new UsageError(`${arg} needs a value`);
		index += 1;
		values.set(arg, [...(values.get(arg) ?? []), value]);
	}
	return { command, values, flags };
}

function one(args: Args, name: string): string | undefined {
	const list = args.values.get(name);
	if (!list) return undefined;
	if (list.length > 1) throw new UsageError(`${name} may be given once`);
	return list[0];
}

function many(args: Args, name: string): string[] {
	return args.values.get(name) ?? [];
}

function required(args: Args, name: string): string {
	const value = one(args, name);
	if (!value) throw new UsageError(`${name} is required`);
	return value;
}

function rootOf(args: Args): string {
	return resolve(one(args, "--root") ?? DEFAULT_ROOT);
}

function manifestPath(root: string): string {
	return join(root, MANIFEST_RELATIVE_PATH);
}

function defaultAssetsDir(root: string): string {
	return join(root, ".release-evidence", "assets");
}

function log(message: string): void {
	console.log(`release-evidence: ${message}`);
}

// --------------------------------------------------------------------------- bind

function bind(args: Args): void {
	const root = rootOf(args);
	const path = manifestPath(root);
	const manifest = loadManifest(path);
	const commit = required(args, "--commit");
	const tag = required(args, "--tag");
	if (!SHA40.test(commit))
		throw new UsageError("--commit must be a 40-character commit");
	if (!RELEASE_TAG.test(tag))
		throw new UsageError("--tag must look like v1.0.0-rc.2");
	const packageVersion =
		one(args, "--package-version") ?? packageVersionAt(root, commit);
	if (!tag.includes("-"))
		throw new UsageError(
			"--tag must be the candidate pre-release tag (vX.Y.Z-rc.N); the GA tag is checked with verify --ga-tag",
		);
	if (!tagMatchesVersion(tag, packageVersion))
		throw new Error(
			`tag ${tag} does not name the candidate package version ${packageVersion}`,
		);
	// The gate set is whatever the candidate commit pinned.
	const claimRegistrySha256 = registrySha256(registryTextAt(root, commit));
	const rebinding =
		manifest.candidate.commit !== null && manifest.candidate.commit !== commit;
	if (rebinding && manifest.entries.length > 0 && !args.flags.has("--reset"))
		throw new Error(
			`manifest holds ${manifest.entries.length} entries for ${manifest.candidate.commit}; pass --reset to drop them and bind a new candidate`,
		);
	const dropping = rebinding || args.flags.has("--reset");
	if (dropping) manifest.entries = [];
	manifest.candidate = { commit, tag };
	manifest.packageVersion = packageVersion;
	manifest.claimRegistrySha256 = claimRegistrySha256;
	manifest.promotion = null;
	// release-status.json names the same candidate; a new candidate starts
	// every claim over, because no evidence carries across commits.
	const statusPath = join(root, STATUS_RELATIVE_PATH);
	const status = readJsonFile(statusPath) as ReleaseStatus;
	status.candidate = { commit, readiness: "pending" };
	if (dropping)
		for (const claim of status.claims) {
			claim.status = "pending";
			claim.evidenceIds = [];
		}
	writeManifest(path, manifest);
	writeFileSync(statusPath, `${JSON.stringify(status, null, "\t")}\n`);
	log(
		`bound candidate ${commit} (${tag}, package ${packageVersion})${dropping ? "; claims reset to pending" : ""}`,
	);
}

// --------------------------------------------------------------------------- package

type PackageTarget =
	| { kind: "manifest"; path: string; manifest: Manifest }
	| { kind: "fragment"; path: string; fragment: Fragment };

function loadTarget(
	args: Args,
	root: string,
	repoOverride?: string,
): PackageTarget {
	const fragmentPath = one(args, "--fragment");
	if (fragmentPath) {
		const path = resolve(fragmentPath);
		if (!FRAGMENT_ASSET_NAME.test(basename(path)))
			throw new UsageError(
				`fragment file name must match ${FRAGMENT_ASSET_NAME}`,
			);
		if (existsSync(path)) {
			const fragment = readJsonFile(path);
			const errors = validateFragment(fragment);
			if (errors.length > 0)
				throw new Error(`invalid fragment:\n - ${errors.join("\n - ")}`);
			return { kind: "fragment", path, fragment: fragment as Fragment };
		}
		const commit = required(args, "--commit");
		if (!SHA40.test(commit))
			throw new UsageError("--commit must be a 40-character commit");
		const tag = one(args, "--tag") ?? null;
		if (tag !== null && !RELEASE_TAG.test(tag))
			throw new UsageError("--tag must look like v1.0.0-rc.2");
		const repository =
			repoOverride ??
			process.env.GITHUB_REPOSITORY ??
			loadManifest(manifestPath(root)).repository;
		return {
			kind: "fragment",
			path,
			fragment: {
				schemaVersion: 1,
				kind: FRAGMENT_KIND,
				repository,
				commit,
				tag,
				entries: [],
			},
		};
	}
	const path = manifestPath(root);
	return { kind: "manifest", path, manifest: loadManifest(path) };
}

function targetCommit(target: PackageTarget): string {
	if (target.kind === "fragment") return target.fragment.commit;
	const commit = target.manifest.candidate.commit;
	if (!commit)
		throw new Error(
			"manifest has no bound candidate; run `release-evidence.ts bind` first",
		);
	return commit;
}

function targetRepository(target: PackageTarget): string {
	return target.kind === "fragment"
		? target.fragment.repository
		: target.manifest.repository;
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9.-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function utcStamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "z")
		.toLowerCase();
}

type PackageInput = {
	inputs: string[];
	producer: Producer;
	forbidden: string[];
	defaultId?: string;
};

function packageEvidence(
	args: Args,
	root: string,
	target: PackageTarget,
	input: PackageInput,
): ManifestEntry {
	const commit = targetCommit(target);
	const explicitCommit = one(args, "--commit");
	if (explicitCommit && explicitCommit !== commit)
		throw new Error(
			`--commit ${explicitCommit} differs from the bound candidate ${commit}`,
		);
	const claimIds = many(args, "--claim");
	if (claimIds.length === 0)
		throw new UsageError("at least one --claim is required");
	for (const claim of claimIds)
		if (!CLAIM_ID.test(claim))
			throw new UsageError(`invalid claim id ${claim}`);
	const status = (one(args, "--status") ?? "passed") as EvidenceStatus;
	if (status !== "passed" && status !== "failed")
		throw new UsageError("--status must be passed or failed");
	const createdAt = one(args, "--created-at") ?? new Date().toISOString();
	if (new Date(Date.parse(createdAt)).toISOString() !== createdAt)
		throw new UsageError("--created-at must be an ISO-8601 UTC timestamp");

	const producer = input.producer;
	const defaultId =
		producer.kind === "github-actions"
			? `${claimIds[0]}-${slug(producer.workflow)}-${producer.runId}-${producer.runAttempt}`
			: `${claimIds[0]}-local-${utcStamp(new Date(createdAt))}`;
	const id = one(args, "--id") ?? input.defaultId ?? defaultId;
	if (!ENTRY_ID.test(id))
		throw new UsageError(`entry id ${id} must match ${ENTRY_ID}`);

	const repoRoots = [...many(args, "--repo-root"), root].map((p) =>
		resolve(p).replace(/[\\/]+$/, ""),
	);
	const members = collectInputs(input.inputs);
	const problems: string[] = [];
	const scrubbed = members.map((member) => {
		const result = scrubFile(member.name, member.data, {
			repoRoots,
			redactHostPaths: args.flags.has("--redact-host-paths"),
			forbiddenLiterals: input.forbidden,
		});
		if (!result.ok) {
			problems.push(...result.problems);
			return member;
		}
		return { name: member.name, data: result.data };
	});
	if (problems.length > 0)
		throw new Error(
			`evidence refused by the privacy scan:\n - ${problems.join("\n - ")}`,
		);
	const registry = loadWorkingRegistry(
		root,
		target.kind === "manifest" ? target.manifest.claimRegistrySha256 : null,
	);
	const contentProblems = inspectMembers(
		scrubbed,
		{ commit, status, claimIds, producerKind: producer.kind },
		registry,
		root,
	);
	if (contentProblems.length > 0)
		throw new Error(
			`evidence content does not support status=${status}:\n - ${contentProblems.join("\n - ")}`,
		);

	const single =
		scrubbed.length === 1 &&
		scrubbed[0]?.name.endsWith(".json") &&
		!args.flags.has("--bundle");
	const asset = single ? `evidence-${id}.json` : `evidence-${id}.tar.gz`;
	if (!ASSET_NAME.test(asset))
		throw new Error(`asset name ${asset} is not publishable`);
	const data = single
		? (scrubbed[0]?.data as Uint8Array)
		: createTarGz(scrubbed);
	const files: BundleFile[] = scrubbed
		.map((member) => ({
			name: member.name,
			size: member.data.length,
			sha256: sha256Hex(member.data),
		}))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const outDir = resolve(one(args, "--out-dir") ?? defaultAssetsDir(root));
	mkdirSync(outDir, { recursive: true });
	const assetPath = join(outDir, asset);
	if (
		existsSync(assetPath) &&
		sha256Hex(new Uint8Array(readFileSync(assetPath))) !== sha256Hex(data)
	)
		throw new Error(
			`${asset} already exists in the output directory with different content`,
		);
	writeFileSync(assetPath, data);

	const entry: ManifestEntry = {
		id,
		claimIds,
		asset,
		size: data.length,
		sha256: sha256Hex(data),
		commit,
		status,
		producer,
		createdAt,
		files,
	};
	if (target.kind === "manifest") {
		mergeEntries(target.manifest, [entry]);
		writeManifest(target.path, target.manifest);
	} else {
		const existing = target.fragment.entries.find((e) => e.id === entry.id);
		if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
			throw new Error(`fragment already has a different entry ${entry.id}`);
		if (!existing) target.fragment.entries.push(entry);
		const errors = validateFragment(target.fragment);
		if (errors.length > 0)
			throw new Error(`invalid fragment:\n - ${errors.join("\n - ")}`);
		mkdirSync(dirname(target.path), { recursive: true });
		writeFileSync(
			target.path,
			`${JSON.stringify(target.fragment, null, "\t")}\n`,
		);
	}
	log(
		`packaged ${asset} (${entry.size} bytes, sha256 ${entry.sha256}) for ${claimIds.join(", ")}`,
	);
	return entry;
}

/** The operator's login and machine name must not reach published evidence.
 * The repository owner is already public (it is in every asset URL), so it is
 * not treated as a leak when the login happens to be the same word; host paths
 * under a home directory are still refused by the path rules. */
function localForbiddenLiterals(args: Args, repository: string): string[] {
	const owner = repository.split("/")[0]?.toLowerCase();
	const literals = [...many(args, "--forbid")];
	try {
		literals.push(userInfo().username);
	} catch {
		// no passwd entry; nothing to add
	}
	const host = hostname();
	literals.push(host, host.split(".")[0] ?? host);
	return literals.filter(
		(literal) => literal.length >= 3 && literal.toLowerCase() !== owner,
	);
}

type RunJob = { name?: string; status?: string; conclusion?: string };

/**
 * Provenance for CI evidence: the run is read back from the Actions API,
 * never self-attested. It must be in this repository, be the expected
 * workflow (when one is named), have built the candidate, and have succeeded.
 * The one exception is the run packaging its own evidence (the release
 * workflow's evidence-assets job): it is still in progress, so it must be this
 * very process's run (GITHUB_RUN_ID/GITHUB_SHA/GITHUB_REPOSITORY) and every
 * job that has finished so far must have succeeded. The named artifact must
 * be listed on the run exactly once, with a digest; that identity is recorded
 * and re-checked by verify.
 */
function verifiedRunProducer(
	root: string,
	repository: string,
	runId: string,
	workflow: string | undefined,
	commit: string,
	status: string,
	artifactName: string,
): GithubActionsProducer {
	const run = ghJson(
		[
			"run",
			"view",
			runId,
			"--repo",
			repository,
			"--json",
			"databaseId,headSha,status,conclusion,workflowName,attempt,jobs",
		],
		root,
	) as {
		databaseId: number;
		headSha: string;
		status: string;
		conclusion: string;
		workflowName: string;
		attempt: number;
		jobs?: RunJob[];
	};
	if (String(run.databaseId) !== runId)
		throw new Error(`run ${runId} could not be read back`);
	if (workflow !== undefined && run.workflowName !== workflow)
		throw new Error(
			`run ${runId} is workflow ${run.workflowName}, not ${workflow}`,
		);
	if (run.headSha !== commit)
		throw new Error(
			`run ${runId} built ${run.headSha}, not the candidate ${commit}`,
		);
	if (run.status === "completed") {
		if (status === "passed" && run.conclusion !== "success")
			throw new Error(
				`run ${runId} concluded ${run.conclusion}; it cannot be passed evidence`,
			);
	} else {
		const self =
			process.env.GITHUB_RUN_ID === runId &&
			process.env.GITHUB_SHA === commit &&
			process.env.GITHUB_REPOSITORY === repository;
		if (!self)
			throw new Error(
				`run ${runId} is ${run.status}; only a completed run, or the run packaging its own evidence, can be a producer`,
			);
		const failed = (run.jobs ?? []).filter(
			(job) =>
				job.status === "completed" &&
				job.conclusion !== "success" &&
				job.conclusion !== "skipped",
		);
		if (failed.length > 0)
			throw new Error(`run ${runId} has ${failed.length} unsuccessful job(s)`);
	}
	const listed = listRunArtifacts(repository, runId, root).filter(
		(artifact) => artifact.name === artifactName,
	);
	const artifact = listed[0];
	if (listed.length !== 1 || !artifact)
		throw new Error(
			`run ${runId} lists ${listed.length} artifact(s) named ${artifactName}; expected exactly one`,
		);
	if (artifact.expired) throw new Error(`artifact ${artifactName} has expired`);
	if (!artifact.digest || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest))
		throw new Error(`artifact ${artifactName} has no sha256 digest`);
	return {
		kind: "github-actions",
		repository,
		workflow: run.workflowName,
		runId: Number(runId),
		runAttempt: run.attempt,
		url: `https://github.com/${repository}/actions/runs/${runId}`,
		headSha: run.headSha,
		artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
	};
}

/** `package` is for local producers only. CI evidence must be the bytes of a
 * named artifact of the producing run, so it comes in through `fetch`. */
function packageCommand(args: Args): void {
	const root = rootOf(args);
	const target = loadTarget(args, root, one(args, "--repo"));
	const inputs = many(args, "--input");
	if (inputs.length === 0)
		throw new UsageError("at least one --input is required");
	if (one(args, "--run-id") !== undefined)
		throw new UsageError(
			"package --run-id is not accepted: CI evidence must be downloaded from the run's artifact with `fetch --run <id> --artifact <name>`",
		);
	const local = one(args, "--local");
	if (local === undefined)
		throw new UsageError("name the local producer with --local <description>");
	packageEvidence(args, root, target, {
		inputs,
		producer: { kind: "local", description: local },
		forbidden: localForbiddenLiterals(args, targetRepository(target)),
	});
}

// --------------------------------------------------------------------------- fetch

function fetchCommand(args: Args): void {
	const root = rootOf(args);
	const target = loadTarget(args, root, one(args, "--repo"));
	const commit = targetCommit(target);
	const repository = one(args, "--repo") ?? targetRepository(target);
	if (!REPOSITORY.test(repository))
		throw new UsageError("--repo must be owner/name");
	const runId = required(args, "--run");
	if (!/^\d+$/.test(runId))
		throw new UsageError("--run must be a numeric run id");
	const artifact = required(args, "--artifact");
	if (!/^[A-Za-z0-9._-]+$/.test(artifact))
		throw new UsageError("--artifact must be a plain artifact name");
	const producer = verifiedRunProducer(
		root,
		repository,
		runId,
		one(args, "--workflow"),
		commit,
		one(args, "--status") ?? "passed",
		artifact,
	);

	const work = mkdtempSync(join(tmpdir(), "release-evidence-fetch-"));
	try {
		const into = join(work, artifact);
		const download = runGh(
			[
				"run",
				"download",
				runId,
				"--repo",
				repository,
				"--name",
				artifact,
				"--dir",
				into,
			],
			root,
		);
		if (download.status !== 0)
			throw new Error(
				`could not download artifact ${artifact} from run ${runId}`,
			);
		const selects = many(args, "--select");
		const inputs =
			selects.length === 0
				? [into]
				: selects.map((select) => {
						const path = resolve(into, select);
						if (isAbsolute(select) || relative(into, path).startsWith(".."))
							throw new UsageError("--select must stay inside the artifact");
						return path;
					});
		packageEvidence(args, root, target, {
			inputs,
			producer,
			forbidden: many(args, "--forbid"),
			// One run can upload several artifacts (a soak segment and its
			// aggregate), so the artifact name is part of the default id.
			defaultId:
				`${many(args, "--claim")[0] ?? "evidence"}-${slug(artifact)}-${runId}-${producer.runAttempt}`.slice(
					0,
					120,
				),
		});
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// --------------------------------------------------------------------------- import

function importCommand(args: Args): void {
	const root = rootOf(args);
	const path = manifestPath(root);
	const manifest = loadManifest(path);
	const { commit, tag } = manifest.candidate;
	if (!commit || !tag)
		throw new Error(
			"manifest has no bound candidate; run `release-evidence.ts bind` first",
		);
	let files = many(args, "--fragment").map((file) => resolve(file));
	let work: string | undefined;
	if (args.flags.has("--from-release")) {
		work = mkdtempSync(join(tmpdir(), "release-evidence-fragments-"));
		const download = runGh(
			[
				"release",
				"download",
				tag,
				"--repo",
				manifest.repository,
				"--dir",
				work,
				"--pattern",
				"release-evidence-fragment-*.json",
			],
			root,
		);
		if (download.status !== 0)
			throw new Error(`could not download fragments from ${tag}`);
		files = [
			...files,
			...readdirSync(work)
				.filter((name) => FRAGMENT_ASSET_NAME.test(name))
				.map((name) => join(work as string, name)),
		];
	}
	if (files.length === 0)
		throw new UsageError("give --fragment <file> or --from-release");
	try {
		let added = 0;
		for (const file of files) {
			const fragment = readJsonFile(file);
			const errors = validateFragment(fragment);
			if (errors.length > 0)
				throw new Error(
					`${basename(file)} is invalid:\n - ${errors.join("\n - ")}`,
				);
			const typed = fragment as Fragment;
			if (typed.repository !== manifest.repository)
				throw new Error(
					`${basename(file)} is for ${typed.repository}, not ${manifest.repository}`,
				);
			if (typed.commit !== commit)
				throw new Error(
					`${basename(file)} is bound to ${typed.commit}, not ${commit}`,
				);
			if (typed.tag !== null && typed.tag !== tag)
				throw new Error(`${basename(file)} targets ${typed.tag}, not ${tag}`);
			added += mergeEntries(manifest, typed.entries);
		}
		writeManifest(path, manifest);
		log(
			`imported ${added} new entr${added === 1 ? "y" : "ies"} from ${files.length} fragment(s)`,
		);
	} finally {
		if (work) rmSync(work, { recursive: true, force: true });
	}
}

// --------------------------------------------------------------------------- upload

function uploadCommand(args: Args): void {
	const root = rootOf(args);
	const execute = args.flags.has("--execute");
	const fragmentPath = one(args, "--fragment");
	let entries: ManifestEntry[];
	let repository: string;
	let tag: string | null;
	/** The commit the evidence being uploaded is bound to. */
	let boundCommit: string | null;
	const extraFiles: string[] = [];
	if (fragmentPath) {
		const fragment = readJsonFile(resolve(fragmentPath));
		const errors = validateFragment(fragment);
		if (errors.length > 0)
			throw new Error(`invalid fragment:\n - ${errors.join("\n - ")}`);
		if (!FRAGMENT_ASSET_NAME.test(basename(fragmentPath)))
			throw new UsageError(
				`fragment file name must match ${FRAGMENT_ASSET_NAME}`,
			);
		const typed = fragment as Fragment;
		entries = typed.entries;
		repository = typed.repository;
		tag = typed.tag;
		boundCommit = typed.commit;
		extraFiles.push(resolve(fragmentPath));
	} else {
		const manifest = loadManifest(manifestPath(root));
		entries = manifest.entries;
		repository = manifest.repository;
		tag = manifest.candidate.tag;
		boundCommit = manifest.candidate.commit;
	}
	repository = one(args, "--repo") ?? repository;
	tag = one(args, "--tag") ?? tag;
	if (!tag || !RELEASE_TAG.test(tag))
		throw new UsageError("no candidate tag: pass --tag or bind the manifest");
	if (!tag.includes("-"))
		throw new Error(
			`evidence is attached to a candidate pre-release; ${tag} is not a pre-release tag`,
		);
	// Evidence goes only to the pre-release of the commit it is bound to: the
	// tag is resolved on GitHub, never trusted from the command line.
	const tagCommit = remoteTagCommit(repository, tag, root);
	if (boundCommit === null || tagCommit !== boundCommit)
		throw new Error(
			`tag ${tag} points to ${tagCommit}, not the evidence candidate ${boundCommit ?? "<unbound>"}`,
		);
	for (const entry of entries)
		if (entry.commit !== tagCommit)
			throw new Error(
				`${entry.asset} is bound to ${entry.commit}, but tag ${tag} points to ${tagCommit}`,
			);
	const assetsDir = resolve(
		one(args, "--assets-dir") ?? defaultAssetsDir(root),
	);

	const local: { name: string; path: string; sha256: string; size: number }[] =
		[];
	for (const entry of entries) {
		const path = join(assetsDir, entry.asset);
		if (!existsSync(path))
			throw new Error(
				`${entry.asset} is missing from ${relative(root, assetsDir) || "."}`,
			);
		const data = new Uint8Array(readFileSync(path));
		if (data.length !== entry.size || sha256Hex(data) !== entry.sha256)
			throw new Error(
				`${entry.asset} on disk does not match its manifest entry`,
			);
		local.push({
			name: entry.asset,
			path,
			sha256: entry.sha256,
			size: entry.size,
		});
	}
	for (const path of extraFiles) {
		const data = new Uint8Array(readFileSync(path));
		local.push({
			name: basename(path),
			path,
			sha256: sha256Hex(data),
			size: data.length,
		});
	}

	const release = viewRelease(repository, tag, root);
	if (!release) {
		if (!args.flags.has("--create-prerelease"))
			throw new Error(
				`release ${tag} does not exist; pass --create-prerelease to create it (the tag must already exist)`,
			);
		if (execute) {
			const created = runGh(
				[
					"release",
					"create",
					tag,
					"--repo",
					repository,
					"--prerelease",
					"--verify-tag",
					"--title",
					tag,
					"--notes",
					`Release candidate ${tag}. Evidence assets are recorded in ${MANIFEST_RELATIVE_PATH}.`,
				],
				root,
			);
			if (created.status !== 0)
				throw new Error(`could not create pre-release ${tag}`);
			log(`created pre-release ${tag}`);
		} else log(`would create pre-release ${tag}`);
	} else {
		if (!release.isPrerelease)
			throw new Error(
				`release ${tag} is not a pre-release; refusing to attach evidence`,
			);
		if (release.isImmutable)
			throw new Error(`release ${tag} is immutable and cannot take new assets`);
	}

	const pending: string[] = [];
	for (const file of local) {
		const remote = release?.assets.find((asset) => asset.name === file.name);
		if (remote) {
			// Without a digest the attached bytes are downloaded and hashed;
			// a matching size proves nothing.
			const same = remote.digest
				? remote.digest === `sha256:${file.sha256}`
				: remoteSha256(repository, tag, file.name, root) === file.sha256;
			if (!same)
				throw new Error(
					`${file.name} is already attached to ${tag} with different content; assets are immutable`,
				);
			log(`${file.name} already attached`);
			continue;
		}
		pending.push(file.path);
		log(
			`${execute ? "uploading" : "would upload"} ${file.name} (${file.size} bytes)`,
		);
	}
	if (!execute) {
		log(
			`dry run: ${pending.length} asset(s) to attach to ${tag}; pass --execute to upload`,
		);
		return;
	}
	if (pending.length === 0) {
		log(`nothing to upload to ${tag}`);
		return;
	}
	const uploaded = runGh(
		["release", "upload", tag, "--repo", repository, ...pending],
		root,
	);
	if (uploaded.status !== 0)
		throw new Error(
			`gh release upload failed: ${uploaded.stderr.trim().split("\n")[0] ?? ""}`,
		);
	log(`attached ${pending.length} asset(s) to ${tag}`);
}

function remoteSha256(
	repository: string,
	tag: string,
	name: string,
	root: string,
): string | undefined {
	const work = mkdtempSync(join(tmpdir(), "release-evidence-check-"));
	try {
		const result = runGh(
			[
				"release",
				"download",
				tag,
				"--repo",
				repository,
				"--dir",
				work,
				"--pattern",
				name,
			],
			root,
		);
		const path = join(work, name);
		if (result.status !== 0 || !existsSync(path)) return undefined;
		return sha256Hex(new Uint8Array(readFileSync(path)));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// --------------------------------------------------------------------------- verify

function verifyCommand(args: Args): void {
	const root = rootOf(args);
	const assetsDir = one(args, "--assets-dir");
	const report = verifyRelease({
		root,
		assetsDir: assetsDir ? resolve(assetsDir) : undefined,
		gaTag: one(args, "--ga-tag"),
		requireReady: args.flags.has("--require-ready"),
		integrityOnly: args.flags.has("--integrity-only"),
	});
	if (args.flags.has("--json")) console.log(JSON.stringify(report, null, 2));
	for (const warning of report.warnings)
		console.warn(`release-evidence: warning: ${warning}`);
	if (report.failures.length > 0) {
		console.error("release-evidence: verify FAILED");
		for (const failure of report.failures) console.error(` - ${failure}`);
		process.exit(1);
	}
	log(
		report.mode === "release"
			? `verify passed: ${report.verifiedEntries} asset(s) for ${report.tag} at ${report.commit}`
			: `audit passed for ${report.verifiedEntries} local asset(s); this is not release verification`,
	);
}

// --------------------------------------------------------------------------- main

const COMMANDS: Record<string, (args: Args) => void> = {
	bind,
	package: packageCommand,
	fetch: fetchCommand,
	import: importCommand,
	upload: uploadCommand,
	verify: verifyCommand,
};

if (import.meta.main) {
	try {
		const args = parseArgs(Bun.argv.slice(2));
		const run = COMMANDS[args.command];
		if (!run)
			throw new UsageError(
				`unknown command ${JSON.stringify(args.command)}; expected ${Object.keys(COMMANDS).join(", ")}`,
			);
		run(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`release-evidence: ${message}`);
		process.exit(error instanceof UsageError ? 2 : 1);
	}
}
