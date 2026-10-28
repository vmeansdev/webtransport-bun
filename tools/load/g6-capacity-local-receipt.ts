/**
 * Produces a source-bound local execution receipt for the capacity goal
 * evaluator: runs exactly capacityLocalProofArgv(kind) (suite, platform,
 * source), retains each command's stdout/stderr under the evidence root and
 * binds them by SHA-256. Refuses a dirty candidate tree.
 *
 * bun tools/load/g6-capacity-local-receipt.ts --kind <kind> --out <repo-relative dir>
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	capacityLocalProofArgv,
	G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA,
	type LocalReceiptCommand,
	type LocalReceiptKind,
} from "./g6-capacity-proof-catalog.ts";

const LOCAL_KINDS: readonly LocalReceiptKind[] = [
	"candidate-local-native",
	"harness-lifecycle",
	"bounded-overload",
];

export function produceLocalReceipt(options: {
	kind: LocalReceiptKind;
	outDir: string;
	repoRoot?: string;
	run?: typeof spawnSync;
}): { receiptPath: string; exitCodes: number[] } {
	const repoRoot = options.repoRoot ?? process.cwd();
	const run = options.run ?? spawnSync;
	if (!LOCAL_KINDS.includes(options.kind))
		throw Error(`unsupported local receipt kind ${options.kind}`);
	if (
		options.outDir.startsWith("/") ||
		options.outDir.split("/").includes("..")
	)
		throw Error("--out must be a repo-relative path without ..");
	const clean = run(
		"git",
		["diff", "--quiet", "HEAD", "--", ".", ":(exclude)AGENTS.md"],
		{ cwd: repoRoot },
	);
	if (clean.status !== 0) throw Error("candidate tree has uncommitted changes");
	const sha = String(
		run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout,
	).trim();
	if (!/^[0-9a-f]{40}$/.test(sha)) throw Error("cannot resolve HEAD");
	const dir = join(repoRoot, options.outDir);
	if (existsSync(join(dir, "receipt.json")))
		throw Error("receipt already exists; receipts are immutable");
	mkdirSync(dir, { recursive: true });
	const commands: LocalReceiptCommand[] = [];
	for (const [index, argv] of capacityLocalProofArgv(options.kind).entries()) {
		const started = Date.now();
		const result = run(argv[0] as string, argv.slice(1) as string[], {
			cwd: repoRoot,
			maxBuffer: 1024 * 1024 * 1024,
			timeout: 3_600_000,
		});
		const stdout = Buffer.from(result.stdout ?? ""),
			stderr = Buffer.from(result.stderr ?? "");
		const base = `${options.outDir}/${index + 1}-${String(argv[0])}`;
		writeFileSync(join(repoRoot, `${base}.stdout`), stdout);
		writeFileSync(join(repoRoot, `${base}.stderr`), stderr);
		commands.push({
			argv: [...argv],
			exitCode: result.status ?? -1,
			signal: result.signal ?? null,
			durationMs: Date.now() - started,
			stdoutPath: `${base}.stdout`,
			stderrPath: `${base}.stderr`,
			stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
			stderrSha256: createHash("sha256").update(stderr).digest("hex"),
		});
	}
	const platform = String(run("uname", ["-s"]).stdout).trim();
	const receipt = {
		schema: G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA,
		kind: options.kind,
		sourceSha: sha,
		phase: "LOCAL",
		commands,
		liveEvidence: false,
		note: `r5 local ${options.kind} proof on ${platform}`,
		executionSessionId: randomUUID(),
		platform,
	};
	const receiptPath = `${options.outDir}/receipt.json`;
	writeFileSync(
		join(repoRoot, receiptPath),
		`${JSON.stringify(receipt, null, 2)}\n`,
	);
	return { receiptPath, exitCodes: commands.map((c) => c.exitCode) };
}

if (import.meta.main) {
	const arg = (name: string) => {
		const i = process.argv.indexOf(`--${name}`);
		const v = i >= 0 ? process.argv[i + 1] : undefined;
		if (!v) throw Error(`--${name} is required`);
		return v;
	};
	const result = produceLocalReceipt({
		kind: arg("kind") as LocalReceiptKind,
		outDir: arg("out"),
	});
	console.log(JSON.stringify(result));
	process.exit(result.exitCodes.every((c) => c === 0) ? 0 : 1);
}
