#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	runCommandWithBoundedOutput,
	runScaleCampaign,
	type RunSummary,
	type ScaleArtifact,
} from "./distributed-scale.ts";
import { loadScaleConfigFromEnv } from "./load-scale-addon.ts";

export const DEFAULT_AUTHORITATIVE_CYCLES = 2;
// Retained as an advisory threshold for same-process experiments. It is not
// applied to the authoritative cross-process comparison because RSS bases are
// not comparable after a fresh runtime starts.
export const DEFAULT_MAX_CYCLE_GROWTH_MB = 64;
const CHILD_EXIT_GRACE_MS = 90_000;

export type RepeatedCycleEvidence = {
	authoritative: true;
	status: "pass" | "fail";
	cycles: number;
	comparison: "process-isolated";
	maxPostCloseGrowthMb: number | null;
	postCloseRssMb: number[];
	observedPostCloseGrowthMb: number | null;
	failures: string[];
};

type ProcessExitRecord = {
	childExitCode: number;
	childExitSignal: string | null;
	childTimedOut: boolean;
	childForceKilled: boolean;
	childGone: boolean;
	failures: string[];
};

export type ProcessIsolationEvidence = {
	authoritative: true;
	status: "pass" | "fail";
	childExitCode: ProcessExitRecord["childExitCode"];
	childExitSignal: ProcessExitRecord["childExitSignal"];
	childTimedOut: ProcessExitRecord["childTimedOut"];
	childForceKilled: ProcessExitRecord["childForceKilled"];
	childGone: ProcessExitRecord["childGone"];
	cycleResults: Array<ProcessExitRecord & { cycle: number }>;
	failures: string[];
};

export type AuthoritativeScaleArtifact = {
	schemaVersion: 1;
	createdAt: string;
	bunVersion: string;
	rustcVersion: string | null;
	config: ScaleArtifact["config"];
	cycles: ScaleArtifact[];
	repeatedCycle: RepeatedCycleEvidence;
	processIsolation: ProcessIsolationEvidence;
	failures: string[];
	diagnosticFailures: string[];
};

type RepeatedCycleSummary = Pick<RunSummary, "label" | "failures"> & {
	memoryTelemetry: {
		postCloseRecovery: Pick<
			RunSummary["memoryTelemetry"]["postCloseRecovery"],
			"rssMb"
		>;
	};
};

export function evaluateRepeatedCycle(
	summaries: RepeatedCycleSummary[],
	maxPostCloseGrowthMb: number | null = null,
): RepeatedCycleEvidence {
	const failures: string[] = [];
	const postCloseRssMb = summaries.map(
		(summary) => summary.memoryTelemetry.postCloseRecovery.rssMb,
	);
	for (const [index, summary] of summaries.entries()) {
		failures.push(
			...summary.failures.map(
				(failure) => `cycle ${index + 1} (${summary.label}): ${failure}`,
			),
		);
	}

	let observedPostCloseGrowthMb: number | null = null;
	if (summaries.length < 2) {
		failures.push(
			`repeated-cycle gate requires at least 2 completed cycles; observed ${summaries.length}`,
		);
	} else if (maxPostCloseGrowthMb != null) {
		observedPostCloseGrowthMb = Number(
			(postCloseRssMb[postCloseRssMb.length - 1]! - postCloseRssMb[0]!).toFixed(
				3,
			),
		);
		if (observedPostCloseGrowthMb > maxPostCloseGrowthMb) {
			failures.push(
				`repeated-cycle post-close RSS growth ${observedPostCloseGrowthMb.toFixed(3)}MB exceeded ${maxPostCloseGrowthMb.toFixed(3)}MB`,
			);
		}
	}

	return {
		authoritative: true,
		status: failures.length === 0 ? "pass" : "fail",
		cycles: summaries.length,
		comparison: "process-isolated",
		maxPostCloseGrowthMb,
		postCloseRssMb,
		observedPostCloseGrowthMb,
		failures,
	};
}

export function buildProcessIsolationEvidence(input: {
	exitCode: number;
	exitSignal: string | null;
	timedOut: boolean;
	forceKilled: boolean;
	stdoutDrainTimedOut: boolean;
	stderrDrainTimedOut: boolean;
}): ProcessIsolationEvidence {
	const childGone =
		!input.timedOut &&
		!input.forceKilled &&
		input.exitCode >= 0 &&
		input.exitSignal == null &&
		!input.stdoutDrainTimedOut &&
		!input.stderrDrainTimedOut;
	const failures: string[] = [];
	if (!childGone) {
		failures.push(
			`authoritative child did not exit cleanly: code=${input.exitCode} signal=${input.exitSignal ?? "none"} timedOut=${input.timedOut} forceKilled=${input.forceKilled} stdoutDrainTimedOut=${input.stdoutDrainTimedOut} stderrDrainTimedOut=${input.stderrDrainTimedOut}`,
		);
	}
	const record: ProcessExitRecord = {
		childExitCode: input.exitCode,
		childExitSignal: input.exitSignal,
		childTimedOut: input.timedOut,
		childForceKilled: input.forceKilled,
		childGone,
		failures,
	};
	return {
		authoritative: true,
		status: failures.length === 0 ? "pass" : "fail",
		...record,
		cycleResults: [],
		failures,
	};
}

function aggregateProcessIsolationEvidence(
	results: ProcessIsolationEvidence[],
): ProcessIsolationEvidence {
	const cycleResults = results.map((result, index) => ({
		cycle: index + 1,
		childExitCode: result.childExitCode,
		childExitSignal: result.childExitSignal,
		childTimedOut: result.childTimedOut,
		childForceKilled: result.childForceKilled,
		childGone: result.childGone,
		failures: result.failures,
	}));
	const failures = cycleResults.flatMap((result) =>
		result.failures.map((failure) => `cycle ${result.cycle}: ${failure}`),
	);
	const last = results.at(-1);
	return {
		authoritative: true,
		status: failures.length === 0 ? "pass" : "fail",
		childExitCode: last?.childExitCode ?? -1,
		childExitSignal: last?.childExitSignal ?? null,
		childTimedOut: results.some((result) => result.childTimedOut),
		childForceKilled: results.some((result) => result.childForceKilled),
		childGone:
			results.length > 0 && results.every((result) => result.childGone),
		cycleResults,
		failures,
	};
}

function positiveIntegerEnv(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? String(fallback));
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumberEnv(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? String(fallback));
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function runChildCycle(): Promise<void> {
	const childArtifactPath = process.env.LOAD_SCALE_AUTHORITATIVE_CHILD_ARTIFACT;
	if (!childArtifactPath) {
		throw new Error(
			"LOAD_SCALE_AUTHORITATIVE_CHILD_ARTIFACT is required for the child runner",
		);
	}

	const baseConfig = loadScaleConfigFromEnv();
	const cycleIndex = positiveIntegerEnv("LOAD_SCALE_AUTHORITATIVE_CYCLE", 1);
	await runScaleCampaign({
		...baseConfig,
		label: `${baseConfig.label}-cycle-${cycleIndex}`,
		artifactPath: childArtifactPath,
	});
	// The child is the residency boundary. Exit explicitly after writing the
	// artifact so imported native runtime handles cannot extend the process.
	process.exit(0);
}

function processIsolationFailureArtifact(
	config: ScaleArtifact["config"],
	processIsolation: ProcessIsolationEvidence,
): AuthoritativeScaleArtifact {
	return {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		bunVersion: Bun.version,
		rustcVersion: null,
		config,
		cycles: [],
		repeatedCycle: {
			authoritative: true,
			status: "fail",
			cycles: 0,
			comparison: "process-isolated",
			maxPostCloseGrowthMb: null,
			postCloseRssMb: [],
			observedPostCloseGrowthMb: null,
			failures: ["authoritative child produced no readable aggregate artifact"],
		},
		processIsolation,
		failures: [
			"authoritative child produced no readable aggregate artifact",
			...processIsolation.failures,
		],
		diagnosticFailures: [],
	};
}

async function runParent(): Promise<void> {
	const config = loadScaleConfigFromEnv();
	const targetArtifactPath = config.artifactPath;
	const tempRoot = mkdtempSync(join(tmpdir(), "wt-authoritative-scale-"));
	const scriptPath = fileURLToPath(import.meta.url);
	const cycleCount = positiveIntegerEnv(
		"LOAD_SCALE_AUTHORITATIVE_CYCLES",
		DEFAULT_AUTHORITATIVE_CYCLES,
	);
	const childTimeoutMs = positiveNumberEnv(
		"LOAD_SCALE_AUTHORITATIVE_TIMEOUT_MS",
		Math.max(120_000, config.durationSec * 1_000 + CHILD_EXIT_GRACE_MS),
	);
	let exitCode = 0;

	try {
		const cycles: ScaleArtifact[] = [];
		const processResults: ProcessIsolationEvidence[] = [];
		const childStderr: string[] = [];
		for (let index = 0; index < cycleCount; index += 1) {
			const childArtifactPath = join(tempRoot, `cycle-${index + 1}.json`);
			let result: Awaited<ReturnType<typeof runCommandWithBoundedOutput>>;
			try {
				result = await runCommandWithBoundedOutput(
					[process.execPath, scriptPath, "--child"],
					{
						cwd: process.cwd(),
						env: {
							LOAD_SCALE_AUTHORITATIVE_CHILD_ARTIFACT: childArtifactPath,
							LOAD_SCALE_AUTHORITATIVE_CYCLE: String(index + 1),
						},
						outerTimeoutMs: childTimeoutMs,
						terminateGraceMs: 2_000,
						drainTimeoutMs: 2_000,
					},
				);
			} catch (error) {
				result = {
					stdout: "",
					stderr: error instanceof Error ? error.message : String(error),
					exitCode: -1,
					exitSignal: null,
					timedOut: false,
					forceKilled: false,
					stdoutDrainTimedOut: false,
					stderrDrainTimedOut: false,
					durationMs: 0,
				};
			}
			const processIsolation = buildProcessIsolationEvidence(result);
			processResults.push(processIsolation);
			if (result.stderr.trim()) childStderr.push(result.stderr.trim());
			if (existsSync(childArtifactPath)) {
				cycles.push(readJson<ScaleArtifact>(childArtifactPath));
			}
		}
		const repeatedCycle = evaluateRepeatedCycle(
			cycles.map((artifact) => artifact.summary),
		);
		const processIsolation = aggregateProcessIsolationEvidence(processResults);
		const first = cycles[0];
		const failures = [...repeatedCycle.failures, ...processIsolation.failures];
		const diagnosticFailures = cycles.flatMap(
			(cycle) => cycle.summary.diagnosticFailures,
		);
		const artifact: AuthoritativeScaleArtifact = first
			? {
					schemaVersion: 1,
					createdAt: new Date().toISOString(),
					bunVersion: first.bunVersion,
					rustcVersion: first.rustcVersion,
					config,
					cycles,
					repeatedCycle,
					processIsolation,
					failures,
					diagnosticFailures,
				}
			: processIsolationFailureArtifact(
					config,
					processResults[0] ??
						buildProcessIsolationEvidence({
							exitCode: -1,
							exitSignal: null,
							timedOut: false,
							forceKilled: false,
							stdoutDrainTimedOut: false,
							stderrDrainTimedOut: false,
						}),
				);
		if (cycles.length > 0) {
			artifact.failures = failures;
			artifact.diagnosticFailures = diagnosticFailures;
			artifact.repeatedCycle = repeatedCycle;
			artifact.processIsolation = processIsolation;
		}
		mkdirSync(dirname(targetArtifactPath), { recursive: true });
		writeFileSync(targetArtifactPath, JSON.stringify(artifact, null, 2));
		console.log(JSON.stringify(artifact, null, 2));
		if (artifact.failures.length > 0) {
			if (childStderr.length > 0) {
				console.error(childStderr.join("\n").slice(-8_000));
			}
			exitCode = 1;
		}
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	// The parent imports the native module graph to share the campaign types;
	// force an explicit terminal state so any runtime-owned handles cannot keep
	// the wrapper alive after the child evidence has been written.
	process.exit(exitCode);
}

if (import.meta.main) {
	const run = process.argv.includes("--child") ? runChildCycle : runParent;
	run().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
