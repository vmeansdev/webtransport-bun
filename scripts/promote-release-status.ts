#!/usr/bin/env bun
/**
 * Promote docs/release-status.json readiness only when every gaRequired claim
 * is passed with commit-bound evidence that check-doc-truth would accept.
 * Claims with `gaRequired: false` (e.g. scale-10k-multisource) are tracked but
 * do not block GA.
 *
 * Usage:
 *   bun scripts/promote-release-status.ts --commit <40-hex>
 *   bun scripts/promote-release-status.ts --dry-run
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const STATUS_PATH = resolve(ROOT, "docs/release-status.json");

type Claim = {
	id: string;
	status: string;
	evidenceIds: string[];
	gaRequired?: boolean;
};

type Evidence = {
	id: string;
	path: string;
	commit: string;
	status: string;
};

type Status = {
	candidate: { commit: string | null; readiness: "pending" | "ready" };
	evidence: Evidence[];
	claims: Claim[];
};

function gitHead(): string | null {
	const r = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: ROOT,
		encoding: "utf8",
	});
	return r.status === 0 ? r.stdout.trim() : null;
}

function parseArgs() {
	const args = process.argv.slice(2);
	let commit: string | null = null;
	let dryRun = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--dry-run") dryRun = true;
		else if (a === "--commit") {
			commit = args[++i] ?? null;
		}
	}
	return { commit, dryRun };
}

function main() {
	const { commit: argCommit, dryRun } = parseArgs();
	const status = JSON.parse(readFileSync(STATUS_PATH, "utf8")) as Status;
	const commit = argCommit ?? status.candidate.commit ?? gitHead();
	if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
		console.error("promote-release-status: need a 40-char commit");
		process.exit(1);
	}

	const evidenceById = new Map(status.evidence.map((e) => [e.id, e]));
	const failures: string[] = [];

	for (const claim of status.claims) {
		const blocksGa = claim.gaRequired !== false;
		if (!blocksGa) continue;
		if (claim.status !== "passed") {
			failures.push(`claim ${claim.id} status=${claim.status}`);
			continue;
		}
		if (!claim.evidenceIds?.length) {
			failures.push(`claim ${claim.id} has no evidenceIds`);
			continue;
		}
		for (const eid of claim.evidenceIds) {
			const ev = evidenceById.get(eid);
			if (!ev) {
				failures.push(`claim ${claim.id} references missing evidence ${eid}`);
				continue;
			}
			if (ev.status !== "passed") {
				failures.push(`evidence ${eid} status=${ev.status}`);
			}
			if (ev.commit !== commit) {
				failures.push(
					`evidence ${eid} commit ${ev.commit} != candidate ${commit}`,
				);
			}
		}
	}

	const iwa = status.claims.find((c) => c.id === "iwa-direct-sockets");
	if (!iwa || iwa.status !== "passed" || !iwa.evidenceIds.length) {
		failures.push("iwa-direct-sockets must be passed with bound evidence");
	}

	if (failures.length > 0) {
		console.error("promote-release-status: refused");
		for (const f of failures) console.error(` - ${f}`);
		process.exit(1);
	}

	status.candidate.commit = commit;
	status.candidate.readiness = "ready";

	if (dryRun) {
		console.log(
			JSON.stringify({ wouldWrite: true, commit, readiness: "ready" }, null, 2),
		);
		process.exit(0);
	}

	writeFileSync(STATUS_PATH, `${JSON.stringify(status, null, "\t")}\n`);
	console.log(`promote-release-status: readiness=ready commit=${commit}`);

	const check = spawnSync("bun", ["scripts/check-doc-truth.ts"], {
		cwd: ROOT,
		encoding: "utf8",
	});
	if (check.status !== 0) {
		console.error(check.stdout);
		console.error(check.stderr);
		console.error(
			"promote-release-status: check-doc-truth failed after write; reverting readiness",
		);
		status.candidate.readiness = "pending";
		writeFileSync(STATUS_PATH, `${JSON.stringify(status, null, "\t")}\n`);
		process.exit(1);
	}
}

main();
