#!/usr/bin/env bun
/**
 * Run a CI gate command and write a release-evidence command record for it
 * (docs/release-evidence.schema.json `commandRecord`). The record is uploaded
 * as a named workflow artifact and later pulled into the evidence manifest
 * with `release-evidence.ts fetch`, which binds it to the run that produced it.
 *
 *   bun scripts/record-command.ts --name <slug> --out <dir> -- <command> [args...]
 *
 * Output goes straight to the job log. The record's `artifactSha256` is the
 * digest of the record itself plus the run identity (there is no separate
 * artifact). The process exits with the command's exit code, so a
 * wrapped CI step fails exactly when the command does (the record of a failed
 * run is still written, with its real exit code).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

function usage(): never {
	console.error(
		"usage: bun scripts/record-command.ts --name <slug> --out <dir> -- <command> [args...]",
	);
	process.exit(2);
}

const argv = Bun.argv.slice(2);
const separator = argv.indexOf("--");
if (separator < 0) usage();
const options = argv.slice(0, separator);
const command = argv.slice(separator + 1);
const flag = (name: string) => {
	const index = options.indexOf(name);
	return index >= 0 ? options[index + 1] : undefined;
};
const name = flag("--name");
const out = flag("--out");
if (!name || !out || command.length === 0) usage();
if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) {
	console.error("record-command: --name must match [A-Za-z0-9._-]{1,80}");
	process.exit(2);
}

function headCommit(): string {
	const fromEnv = process.env.GITHUB_SHA;
	if (fromEnv && /^[0-9a-f]{40}$/.test(fromEnv)) return fromEnv;
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	const sha = result.stdout?.trim() ?? "";
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		console.error("record-command: cannot determine the commit");
		process.exit(2);
	}
	return sha;
}

const commit = headCommit();
const startedAt = new Date().toISOString();
// The command's output goes straight to the job log (inherited stdio): piping
// it through this process competes for CPU with timing-sensitive suites.
const proc = Bun.spawn(command, {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
	env: process.env,
});
const exitCode = await proc.exited;
const finishedAt = new Date().toISOString();

const record = {
	schemaVersion: 1,
	kind: "command",
	name,
	commit,
	platform: { os: platform(), arch: arch(), runtime: "bun" },
	toolchain: { name: "bun", version: Bun.version },
	command,
	exitCode,
	startedAt,
	finishedAt,
};
// The record carries no separate artifact (the output lives in the job log),
// so its digest field binds the record's own content and the run identity.
const artifactSha256 = createHash("sha256")
	.update(
		JSON.stringify({
			...record,
			runId: process.env.GITHUB_RUN_ID ?? null,
			runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
			job: process.env.GITHUB_JOB ?? null,
		}),
	)
	.digest("hex");
const dir = join(out, "commands");
mkdirSync(dir, { recursive: true });
writeFileSync(
	join(dir, `${name}.json`),
	`${JSON.stringify({ ...record, artifactSha256 }, null, 2)}\n`,
);
console.error(
	`record-command: ${name} exit ${exitCode} recorded for ${commit}`,
);
process.exit(exitCode);
