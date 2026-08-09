#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
	approvedBaselineFromCapture,
	BENCH_DESIGN_ROUNDS,
	BENCH_DESIGN_WARMUPS,
	type BenchmarkCaptureArtifact,
	collectBenchmarkRuns,
	DEFAULT_BASELINE_PATH,
	gitCommit,
	gitWorkingTreeDirty,
	machineIdentity,
	ROOT,
	rustcVersion,
	toolchainHash,
	validateApprovedBaselineContext,
	validateBenchmarkRuns,
} from "./bench-lib.ts";

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function immutableWrite(path: string, bytes: Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	try {
		writeFileSync(path, bytes, { flag: "wx" });
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EEXIST"
		) {
			throw error;
		}
		if (!readFileSync(path).equals(bytes)) {
			throw new Error(`immutable benchmark capture already differs at ${path}`);
		}
	}
}

function atomicWrite(path: string, bytes: Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx");
		writeSync(descriptor, bytes);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

async function main(): Promise<void> {
	if (gitWorkingTreeDirty()) {
		throw new Error("benchmark capture requires a clean git worktree");
	}
	const explicitMachine = requiredEnvironment("BENCH_MACHINE_IDENTITY");
	const approver = requiredEnvironment("BENCH_BASELINE_APPROVER");
	const commit = gitCommit();
	if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
		throw new Error("benchmark capture requires a full source commit SHA");
	}
	const rust = rustcVersion();
	if (!rust) throw new Error("benchmark capture requires rustc");
	const bun = Bun.version;
	const capturedToolchainHash = toolchainHash(bun, rust);
	if (!capturedToolchainHash) {
		throw new Error("benchmark capture could not bind the toolchain");
	}
	if (machineIdentity() !== explicitMachine) {
		throw new Error("benchmark capture machine identity is not explicit");
	}

	const runs = await collectBenchmarkRuns({
		warmups: BENCH_DESIGN_WARMUPS,
		rounds: BENCH_DESIGN_ROUNDS,
	});
	const runFailures = validateBenchmarkRuns(runs);
	if (runFailures.length > 0) {
		throw new Error(`benchmark capture is invalid: ${runFailures.join("; ")}`);
	}
	const capture: BenchmarkCaptureArtifact = {
		createdAt: new Date().toISOString(),
		commit,
		machine: explicitMachine,
		bunVersion: bun,
		rustcVersion: rust,
		toolchainHash: capturedToolchainHash,
		warmups: BENCH_DESIGN_WARMUPS,
		rounds: BENCH_DESIGN_ROUNDS,
		runs,
	};
	const safeMachine = explicitMachine.replace(/[^A-Za-z0-9._-]+/g, "-");
	const capturePath = resolve(
		ROOT,
		"tools/bench/baselines",
		`${commit}-${safeMachine}.json`,
	);
	const captureBytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`);
	immutableWrite(capturePath, captureBytes);
	const artifactSha256 = createHash("sha256")
		.update(captureBytes)
		.digest("hex");
	const artifactPath = relative(ROOT, capturePath);
	const baseline = approvedBaselineFromCapture(capture, {
		approver,
		artifactPath,
		artifactSha256,
		approvedAt: new Date().toISOString(),
	});
	const contextFailures = validateApprovedBaselineContext(baseline, {
		commit,
		machine: explicitMachine,
		bunVersion: bun,
		rustcVersion: rust,
	});
	if (contextFailures.length > 0) {
		throw new Error(
			`derived approved baseline is invalid: ${contextFailures.join("; ")}`,
		);
	}
	const baselineBytes = Buffer.from(`${JSON.stringify(baseline, null, 2)}\n`);
	atomicWrite(DEFAULT_BASELINE_PATH, baselineBytes);

	console.log(`source: ${commit}`);
	console.log(`capture: ${artifactPath}`);
	console.log(`capture sha256: ${artifactSha256}`);
	console.log(`baseline: ${relative(ROOT, DEFAULT_BASELINE_PATH)}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
