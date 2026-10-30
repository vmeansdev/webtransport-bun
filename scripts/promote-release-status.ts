#!/usr/bin/env bun
/**
 * Promote docs/release-status.json readiness only when the candidate's
 * evidence verifies end to end against the release itself:
 *
 *   - the GA gate set is the pinned registry (docs/release-claims.json) read
 *     from the candidate commit; release-status.json cannot downgrade it;
 *   - every gaRequired claim cites manifest entries that are `passed`, list
 *     the claim, are bound to the candidate, and carry the registered positive
 *     proof;
 *   - the candidate tag resolves (on GitHub) to the candidate commit and its
 *     release is a pre-release;
 *   - every evidence asset is downloaded from that release (never read from a
 *     local directory) and matches its recorded size, sha256 and file list;
 *   - every GitHub Actions producer is re-read and built the candidate.
 *
 * The checkout must be the candidate itself or a descendant that changed only
 * the evidence record (the manifest and release-status.json). There is no
 * override.
 *
 * On success it records a promotion lock in the manifest -- the tag commit and
 * the sha256 of every evidence asset on the release -- and sets readiness
 * `ready`. `release-evidence.ts verify` (scheduled, and in the GA release
 * job) fails if the tag or any evidence asset changes afterwards.
 *
 * Usage:
 *   bun scripts/promote-release-status.ts [--dry-run] [--root <dir>]
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
	STATUS_RELATIVE_PATH,
	verifyRelease,
	writeManifest,
} from "./release-evidence-lib.ts";

function parseArgs(argv: string[]) {
	let dryRun = false;
	let root = DEFAULT_ROOT;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") dryRun = true;
		else if (a === "--root") root = resolve(argv[++i] ?? ".");
		else {
			console.error(`promote-release-status: unknown argument ${a}`);
			process.exit(2);
		}
	}
	return { dryRun, root };
}

function refuse(failures: string[]): never {
	console.error("promote-release-status: refused");
	for (const f of failures) console.error(` - ${f}`);
	process.exit(1);
}

function main() {
	const { dryRun, root } = parseArgs(process.argv.slice(2));
	const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
	let manifest: ReturnType<typeof loadManifest>;
	try {
		manifest = loadManifest(manifestPath);
	} catch (error) {
		refuse([error instanceof Error ? error.message : String(error)]);
	}
	const commit = manifest.candidate.commit;
	if (!commit)
		refuse([
			`need a bound candidate: ${MANIFEST_RELATIVE_PATH} has no candidate commit`,
		]);
	if (runGit(["cat-file", "-e", `${commit}^{commit}`], root).status !== 0)
		refuse([`commit ${commit} does not exist in this repository`]);

	// Promotion certifies the candidate tree. The checkout may only differ from
	// it by the evidence record itself.
	const head = runGit(["rev-parse", "HEAD"], root).stdout.trim();
	if (head !== commit) {
		if (
			runGit(["merge-base", "--is-ancestor", commit, "HEAD"], root).status !== 0
		)
			refuse([`candidate ${commit} is not an ancestor of HEAD ${head}`]);
		const changed = runGit(["diff", "--name-only", commit, "HEAD"], root)
			.stdout.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const foreign = changed.filter(
			(path) => !(EVIDENCE_RECORD_PATHS as readonly string[]).includes(path),
		);
		if (foreign.length > 0)
			refuse([
				`HEAD ${head} changed ${foreign.length} file(s) beyond the evidence record since candidate ${commit} (first: ${foreign[0]})`,
			]);
	}

	const report = verifyRelease({ root });
	if (report.mode !== "release")
		refuse(["promotion requires assets downloaded from the release"]);
	const status = loadStatus(root);
	const failures = [...report.failures];
	if (manifest.promotion)
		failures.push(
			"the manifest is already promoted; bind a new candidate to start over",
		);
	for (const warning of report.warnings)
		console.warn(`promote-release-status: warning: ${warning}`);
	if (failures.length > 0) refuse(failures);

	status.candidate.commit = commit;
	status.candidate.readiness = "ready";
	manifest.promotion = {
		tag: manifest.candidate.tag as string,
		tagCommit: commit,
		verifiedAt: new Date().toISOString(),
		assets: report.releaseAssets,
	};

	if (dryRun) {
		console.log(
			JSON.stringify(
				{
					wouldWrite: true,
					commit,
					tag: report.tag,
					verifiedAssets: report.verifiedEntries,
					lockedAssets: report.releaseAssets.length,
					readiness: "ready",
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	const statusPath = join(root, STATUS_RELATIVE_PATH);
	writeManifest(manifestPath, manifest);
	writeFileSync(statusPath, `${JSON.stringify(status, null, "\t")}\n`);
	console.log(
		`promote-release-status: readiness=ready commit=${commit} tag=${report.tag} (${report.releaseAssets.length} assets locked)`,
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
		manifest.promotion = null;
		writeManifest(manifestPath, manifest);
		writeFileSync(statusPath, `${JSON.stringify(status, null, "\t")}\n`);
		process.exit(1);
	}
}

main();
