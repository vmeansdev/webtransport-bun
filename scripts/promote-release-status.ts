#!/usr/bin/env bun
/**
 * Promote docs/release-status.json readiness only when every gaRequired claim
 * is passed with evidence that verifies end to end:
 *
 *   - each claim's evidenceIds name entries of docs/release-evidence-manifest.json
 *     that are `passed`, list the claim, and are bound to the manifest candidate;
 *   - the candidate tag resolves (on GitHub) to the candidate commit and its
 *     release is a pre-release;
 *   - every manifest entry's asset is downloaded from that release and matches
 *     the recorded size, sha256 and file list, passes the privacy backstop, and
 *     does not record a failed outcome or a different commit.
 *
 * Claims with `gaRequired: false` (e.g. scale-10k-multisource) are tracked but
 * do not block GA.
 *
 * The working tree may be the candidate itself or a descendant that only
 * changed the evidence record (the manifest and release-status.json); anything
 * else needs --allow-stale-candidate.
 *
 * Usage:
 *   bun scripts/promote-release-status.ts [--dry-run] [--assets-dir <dir>]
 *        [--commit <40-hex>] [--allow-stale-candidate] [--root <dir>]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	DEFAULT_ROOT,
	EVIDENCE_RECORD_PATHS,
	loadManifest,
	loadStatus,
	MANIFEST_RELATIVE_PATH,
	runGit,
	SHA40,
	STATUS_RELATIVE_PATH,
	verifyRelease,
} from "./release-evidence-lib.ts";

function parseArgs(argv: string[]) {
	let commit: string | null = null;
	let dryRun = false;
	let allowStale = false;
	let assetsDir: string | undefined;
	let root = DEFAULT_ROOT;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") dryRun = true;
		else if (a === "--allow-stale-candidate") allowStale = true;
		else if (a === "--commit") commit = argv[++i] ?? null;
		else if (a === "--assets-dir") assetsDir = argv[++i];
		else if (a === "--root") root = resolve(argv[++i] ?? ".");
		else {
			console.error(`promote-release-status: unknown argument ${a}`);
			process.exit(2);
		}
	}
	return { commit, dryRun, allowStale, assetsDir, root };
}

function refuse(failures: string[]): never {
	console.error("promote-release-status: refused");
	for (const f of failures) console.error(` - ${f}`);
	process.exit(1);
}

function main() {
	const {
		commit: argCommit,
		dryRun,
		allowStale,
		assetsDir,
		root,
	} = parseArgs(process.argv.slice(2));
	let manifestCommit: string | null;
	try {
		manifestCommit = loadManifest(join(root, MANIFEST_RELATIVE_PATH)).candidate
			.commit;
	} catch (error) {
		refuse([error instanceof Error ? error.message : String(error)]);
	}
	const commit = argCommit ?? manifestCommit;
	if (!commit || !SHA40.test(commit))
		refuse([
			`need a bound candidate: ${MANIFEST_RELATIVE_PATH} has no candidate commit`,
		]);
	if (commit !== manifestCommit)
		refuse([
			`--commit ${commit} is not the manifest candidate ${manifestCommit ?? "<unbound>"}`,
		]);
	if (runGit(["cat-file", "-e", `${commit}^{commit}`], root).status !== 0)
		refuse([`commit ${commit} does not exist in this repository`]);

	// Promotion certifies the candidate tree. The checkout may only differ from
	// it by the evidence record itself; certifying a tree that moved on would
	// silently bless code no evidence was produced for.
	const head = runGit(["rev-parse", "HEAD"], root).stdout.trim();
	if (head !== commit && !allowStale) {
		if (
			runGit(["merge-base", "--is-ancestor", commit, "HEAD"], root).status !== 0
		)
			refuse([
				`candidate ${commit} is not an ancestor of HEAD ${head}; pass --allow-stale-candidate to promote it deliberately`,
			]);
		const changed = runGit(["diff", "--name-only", commit, "HEAD"], root)
			.stdout.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const foreign = changed.filter(
			(path) => !(EVIDENCE_RECORD_PATHS as readonly string[]).includes(path),
		);
		if (foreign.length > 0)
			refuse([
				`HEAD ${head} changed ${foreign.length} file(s) beyond the evidence record since candidate ${commit} (first: ${foreign[0]}); pass --allow-stale-candidate to promote it deliberately`,
			]);
	}

	const report = verifyRelease({
		root,
		assetsDir: assetsDir ? resolve(assetsDir) : undefined,
	});
	const status = loadStatus(root);
	const failures = [...report.failures];
	const iwa = status.claims.find((c) => c.id === "iwa-direct-sockets");
	if (!iwa || iwa.status !== "passed" || !iwa.evidenceIds.length)
		failures.push("iwa-direct-sockets must be passed with bound evidence");
	for (const warning of report.warnings)
		console.warn(`promote-release-status: warning: ${warning}`);
	if (failures.length > 0) refuse(failures);

	status.candidate.commit = commit;
	status.candidate.readiness = "ready";

	if (dryRun) {
		console.log(
			JSON.stringify(
				{
					wouldWrite: true,
					commit,
					tag: report.tag,
					verifiedAssets: report.verifiedEntries,
					readiness: "ready",
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	const statusPath = join(root, STATUS_RELATIVE_PATH);
	writeFileSync(statusPath, `${JSON.stringify(status, null, "\t")}\n`);
	console.log(
		`promote-release-status: readiness=ready commit=${commit} tag=${report.tag}`,
	);

	// The documentation truth check validates the real checkout; a --root test
	// tree does not carry the documentation it reads.
	if (root !== DEFAULT_ROOT) return;
	const check = spawnSync("bun", ["scripts/check-doc-truth.ts"], {
		cwd: root,
		encoding: "utf8",
	});
	if (check.status !== 0) {
		console.error(check.stdout);
		console.error(check.stderr);
		console.error(
			"promote-release-status: check-doc-truth failed after write; reverting readiness",
		);
		status.candidate.readiness = "pending";
		writeFileSync(statusPath, `${JSON.stringify(status, null, "\t")}\n`);
		process.exit(1);
	}
}

main();
