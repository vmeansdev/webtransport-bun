#!/usr/bin/env bun
/**
 * Run a CI gate command and write a release-evidence command record for it
 * (docs/release-evidence.schema.json `commandRecord`). The record is uploaded
 * as a named workflow artifact and later pulled into the evidence manifest
 * with `release-evidence.ts fetch`, which binds it to the run that produced it.
 *
 *   bun scripts/record-command.ts --name <slug> --out <dir> -- <command> [args...]
 *
 * Output is streamed through unchanged; its sha256 becomes the record's
 * `artifactSha256`. The process exits with the command's exit code, so a
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
const proc = Bun.spawn(command, {
	stdin: "inherit",
	stdout: "pipe",
	stderr: "pipe",
	env: process.env,
});
const digest = createHash("sha256");
async function pump(
	stream: ReadableStream<Uint8Array>,
	sink: NodeJS.WriteStream,
): Promise<void> {
	for await (const chunk of stream) {
		digest.update(chunk);
		sink.write(chunk);
	}
}
await Promise.all([
	pump(proc.stdout, process.stdout),
	pump(proc.stderr, process.stderr),
]);
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
	artifactSha256: digest.digest("hex"),
};
const dir = join(out, "commands");
mkdirSync(dir, { recursive: true });
writeFileSync(
	join(dir, `${name}.json`),
	`${JSON.stringify(record, null, 2)}\n`,
);
console.error(
	`record-command: ${name} exit ${exitCode} recorded for ${commit}`,
);
process.exit(exitCode);
