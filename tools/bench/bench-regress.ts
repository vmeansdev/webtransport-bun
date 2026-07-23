#!/usr/bin/env bun

import {
	baselineArtifactStatusMessage,
	benchmarkBindingFailures,
	collectBenchmarkRuns,
	compareAgainstBaseline,
	DEFAULT_ARTIFACT_PATH,
	DEFAULT_BASELINE_PATH,
	gitCommit,
	gitWorkingTreeDirty,
	loadApprovedBaselines,
	machineIdentity,
	rustcVersion,
	validateApprovedBaselineContext,
	validateBenchmarkRuns,
	writeArtifact,
} from "./bench-lib.ts";

const WARMUPS = Number(process.env.BENCH_WARMUPS ?? "1");
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? "5");
const BASELINE_PATH = process.env.BENCH_BASELINE_PATH ?? DEFAULT_BASELINE_PATH;
const ARTIFACT_PATH = process.env.BENCH_ARTIFACT_OUT ?? DEFAULT_ARTIFACT_PATH;

async function main() {
	const baseline = loadApprovedBaselines(BASELINE_PATH);
	const baselineStatus = baselineArtifactStatusMessage(baseline, BASELINE_PATH);
	const failures: string[] = [];
	const candidateContext = {
		commit: gitCommit(),
		machine: machineIdentity(),
		bunVersion: Bun.version,
		rustcVersion: rustcVersion(),
	};
	failures.push(
		...benchmarkBindingFailures({
			...candidateContext,
			dirtyWorkingTree: gitWorkingTreeDirty(),
			explicitMachineBinding:
				(process.env.BENCH_MACHINE_IDENTITY?.trim().length ?? 0) > 0,
			ciBoundRun: Boolean(process.env.GITHUB_RUN_ID),
		}),
	);

	if (baselineStatus) {
		failures.push(baselineStatus);
	} else {
		failures.push(
			...validateApprovedBaselineContext(baseline, candidateContext),
		);
	}

	let runs = [] as Awaited<ReturnType<typeof collectBenchmarkRuns>>;
	try {
		runs = await collectBenchmarkRuns({ warmups: WARMUPS, rounds: ROUNDS });
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}

	if (runs.length > 0 && baseline.status === "approved") {
		failures.push(...validateBenchmarkRuns(runs));
		for (const run of runs) {
			const failure = compareAgainstBaseline(run, baseline);
			if (failure) failures.push(failure);
		}
	}

	const artifact = {
		createdAt: new Date().toISOString(),
		...candidateContext,
		warmups: WARMUPS,
		rounds: ROUNDS,
		baselineStatus: baseline.status,
		runs,
		failures,
	};
	writeArtifact(artifact, ARTIFACT_PATH);

	if (runs.length > 0) {
		for (const run of runs) {
			console.log(
				`${run.name}: mean=${run.summary.mean}${run.unit} ci95=[${run.summary.ci95Low}, ${run.summary.ci95High}] samples=${run.samples.join(",")}`,
			);
		}
	}

	if (failures.length > 0) {
		console.error("bench-regress: FAIL");
		for (const failure of failures) {
			console.error(` - ${failure}`);
		}
		console.error(`artifact: ${ARTIFACT_PATH}`);
		process.exit(1);
	}

	console.log("bench-regress: PASS");
	console.log(`artifact: ${ARTIFACT_PATH}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
