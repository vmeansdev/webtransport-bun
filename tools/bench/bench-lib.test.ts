import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	type ApprovedBaselines,
	type BenchmarkRun,
	benchmarkBindingFailures,
	compareAgainstBaseline,
	runCommand,
	sampleSummary,
	studentTCritical95,
	validateApprovedBaselineContext,
	validateBenchmarkRuns,
} from "./bench-lib.ts";

const ROOT = resolve(import.meta.dir, "../..");
const TEMP_ROOTS: string[] = [];

afterEach(() => {
	for (const root of TEMP_ROOTS.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Task 14 benchmark evidence", () => {
	test("uses a small-sample confidence interval instead of a normal approximation", () => {
		const summary = sampleSummary([1, 2, 3, 4, 5]);

		expect(summary.ci95Low).toBeLessThanOrEqual(1.04);
		expect(summary.ci95High).toBeGreaterThanOrEqual(4.96);
	});

	test("uses exact Student-t critical values beyond the lookup table", () => {
		expect(studentTCritical95(61)).toBeGreaterThan(1.96);
		expect(studentTCritical95(61)).toBeLessThan(2.01);
		expect(studentTCritical95(121)).toBeGreaterThan(1.97);
		expect(studentTCritical95(121)).toBeLessThan(1.981);
	});

	test("collects every metric required by the release plan", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "bench-lib.ts"),
			"utf8",
		);
		const required = [
			"handshake-p50-ms",
			"handshake-p95-ms",
			"handshake-p99-ms",
			"datagram-throughput-dgrams-per-sec",
			"datagram-loss-ratio",
			"stream-throughput-mbps",
			"event-loop-delay-p99-ms",
			"cpu-user-ms",
			"peak-rss-mib",
			"close-latency-p99-ms",
		];

		for (const metric of required) expect(source).toContain(metric);
	});

	test("writes benchmark evidence outside tools", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "bench-lib.ts"),
			"utf8",
		);
		expect(source).toContain(".release-evidence");
		expect(source).not.toContain("./bench-regress-artifact.json");
	});

	test("rejects non-finite samples before they can serialize as null", () => {
		expect(() => sampleSummary([1, Number.NaN])).toThrow("finite");
		expect(() => sampleSummary([Number.POSITIVE_INFINITY])).toThrow("finite");
	});

	test("rejects missing and semantically invalid required metrics", () => {
		const runs = requiredRuns();
		expect(validateBenchmarkRuns(runs.slice(1))).toContain(
			"missing required benchmark metric handshake-p50-ms",
		);

		const invalidLoss = runs.map((run) =>
			run.name === "datagram-loss-ratio" ? benchmarkRun(run.name, 1.1) : run,
		);
		expect(validateBenchmarkRuns(invalidLoss)).toContain(
			"datagram-loss-ratio: sample 1.1 must be between 0 and 1",
		);

		const invalidRss = runs.map((run) =>
			run.name === "peak-rss-mib" ? benchmarkRun(run.name, 0) : run,
		);
		expect(validateBenchmarkRuns(invalidRss)).toContain(
			"peak-rss-mib: sample 0 must be greater than 0",
		);
	});

	test("does not let an invalid current run pass baseline comparison", () => {
		const run = benchmarkRun("peak-rss-mib", 0);
		const baseline = approvedBaseline({
			thresholds: {
				"peak-rss-mib": {
					direction: "lower-is-better",
					approved: sampleSummary([50]),
					unit: "MiB",
				},
			},
		});

		expect(compareAgainstBaseline(run, baseline)).toContain(
			"peak-rss-mib: sample 0 must be greater than 0",
		);
	});

	test("recomputes approved summaries from their raw samples before comparison", () => {
		const baseline = approvedBaseline({
			thresholds: {
				"handshake-p50-ms": {
					direction: "lower-is-better",
					approved: {
						...sampleSummary([10, 11, 12]),
						mean: 0,
						min: 0,
						max: 0,
						stddev: 0,
						ci95Low: 0,
						ci95High: 0,
					},
					unit: "ms",
				},
			},
		});

		expect(
			compareAgainstBaseline(benchmarkRun("handshake-p50-ms", 11), baseline),
		).toBeNull();
	});

	test("requires an exact candidate, machine, and runtime baseline relationship", () => {
		const commit = "a".repeat(40);
		const baseline = approvedBaseline({ commit });
		const current = {
			commit,
			machine: "darwin/arm64/local/runner-a",
			bunVersion: "1.3.14",
			rustcVersion: "rustc 1.95.0",
		};
		expect(validateApprovedBaselineContext(baseline, current)).toEqual([]);

		expect(
			validateApprovedBaselineContext(baseline, {
				...current,
				commit: "b".repeat(40),
			}),
		).toContain(
			"approved baseline commit does not exactly match candidate commit",
		);
		expect(
			validateApprovedBaselineContext(
				approvedBaseline({ commit: "deadbeef" }),
				current,
			),
		).toContain("approved baseline commit is not a full Git SHA");
		expect(
			validateApprovedBaselineContext(baseline, {
				...current,
				machine: "linux/x64/github-actions/runner-b",
			}),
		).toContain("approved baseline machine does not match candidate machine");
		expect(
			validateApprovedBaselineContext(baseline, {
				...current,
				bunVersion: "1.3.15",
			}),
		).toContain(
			"approved baseline Bun runtime does not match candidate runtime",
		);
		expect(
			validateApprovedBaselineContext(baseline, {
				...current,
				rustcVersion: "rustc 1.96.0",
			}),
		).toContain(
			"approved baseline Rust runtime does not match candidate runtime",
		);
	});

	test("rejects dirty and locally unbound measurements before trusting evidence", () => {
		expect(
			benchmarkBindingFailures({
				commit: "a".repeat(40),
				machine: "darwin/arm64/local/runner-a",
				bunVersion: "1.3.14",
				rustcVersion: "rustc 1.95.0",
				dirtyWorkingTree: true,
				explicitMachineBinding: true,
				ciBoundRun: false,
			}),
		).toContain(
			"benchmark evidence is unbound because the git worktree is dirty",
		);

		expect(
			benchmarkBindingFailures({
				commit: "a".repeat(40),
				machine: "darwin/arm64/local/runner-a",
				bunVersion: "1.3.14",
				rustcVersion: "rustc 1.95.0",
				dirtyWorkingTree: false,
				explicitMachineBinding: false,
				ciBoundRun: false,
			}),
		).toContain(
			"benchmark evidence is unbound because BENCH_MACHINE_IDENTITY is required outside CI",
		);
	});

	test("kills descendant-held benchmark pipes with bounded timeouts", async () => {
		const tempRoot = mkdtempSync(resolve(tmpdir(), "wt-bench-lib-"));
		TEMP_ROOTS.push(tempRoot);
		const fixturePath = resolve(tempRoot, "held-pipe-fixture.mjs");
		writeFileSync(
			fixturePath,
			`
import { spawn } from "node:child_process";

if (process.argv[2] === "grandchild") {
	process.stdout.write("grandchild stdout\\n");
	process.stderr.write("grandchild stderr\\n");
	setInterval(() => {}, 1_000);
} else {
	const grandchild = spawn(process.execPath, [process.argv[1], "grandchild"], {
		detached: process.platform !== "win32",
		stdio: "inherit",
	});
	grandchild.unref();
	process.stdout.write("bench parent stdout\\n");
	process.stderr.write("bench parent stderr\\n");
}
`,
			"utf8",
		);

		await expect(
			runCommand(
				[process.execPath, fixturePath],
				{},
				{ outerTimeoutMs: 200, terminateGraceMs: 75, drainTimeoutMs: 75 },
			),
		).rejects.toThrow(/timed out|drain/);
	});
});

describe("Task 14 coverage workflow", () => {
	test("uses Bun's real lcov artifact and only the metrics Bun actually emits", () => {
		const workflow = readFileSync(
			resolve(ROOT, ".github/workflows/coverage.yml"),
			"utf8",
		);

		expect(workflow).toContain("native_floors");
		expect(workflow).toContain("wasm_floors");
		expect(workflow).toContain("bun_floors");
		expect(workflow).toContain("--branch");
		expect(workflow).toContain("coverage/lcov.info");
		expect(workflow).not.toContain("coverage/bun.lcov");
		expect(workflow).toContain("function_floor");
		expect(workflow).toContain('line.startswith("FNF:")');
		expect(workflow).toContain('line.startswith("FNH:")');
		expect(workflow).not.toContain('line.startswith("FNDA:")');
		expect(workflow).not.toContain('line.startswith("BRDA:")');
		expect(workflow).toContain("function coverage");
	});

	test("pins dependencies and bounds workflow execution", () => {
		const workflow = readFileSync(
			resolve(ROOT, ".github/workflows/coverage.yml"),
			"utf8",
		);

		expect(workflow).toMatch(/permissions:\n\s+contents: read/);
		expect(workflow).toMatch(/timeout-minutes:\s+\d+/);
		expect(workflow).toContain("cargo-llvm-cov --version 0.8.7 --locked");
		expect(workflow).not.toMatch(/uses:\s+[^\n]+@(v\d+|stable)\s*$/m);
	});
});

describe("Task 14 benchmark gate contract", () => {
	test("keeps benchmark baselines explicitly blocked until an approved measured capture exists", () => {
		const baseline = readFileSync(
			resolve(ROOT, "tools/bench/approved-baselines.json"),
			"utf8",
		);
		const doc = readFileSync(
			resolve(ROOT, "docs/BENCHMARK_BASELINES.md"),
			"utf8",
		);
		const releaseWorkflow = readFileSync(
			resolve(ROOT, ".github/workflows/release.yml"),
			"utf8",
		);

		expect(baseline).toContain('"status": "blocked"');
		expect(baseline).toContain('"thresholds": {}');
		expect(doc).toContain("do not populate thresholds by hand");
		expect(releaseWorkflow).toContain("bench:regress");
		expect(releaseWorkflow).toContain("approved baseline");
	});

	test("removes the standalone handshake p95 threshold from regression mode", () => {
		const source = readFileSync(
			resolve(ROOT, "tools/bench/handshake-latency.ts"),
			"utf8",
		);

		expect(source).not.toContain("BENCH_P95_MAX_MS");
		expect(source).not.toContain("FAIL (p95");
		expect(source).not.toContain("threshold p95<=");
	});

	test("routes baseline capture through the bounded bench command helper", () => {
		const source = readFileSync(
			resolve(ROOT, "tools/bench/baseline.ts"),
			"utf8",
		);
		expect(source).toContain('from "./bench-lib.ts"');
		expect(source).toContain("runCommand(");
		expect(source).not.toContain("new Response(p.stdout).text()");
		expect(source).not.toContain("await p.exited");
	});
});

function benchmarkRun(name: string, value: number): BenchmarkRun {
	const unit =
		name === "datagram-loss-ratio"
			? "ratio"
			: name.includes("throughput")
				? name.includes("stream")
					? "MiB/s"
					: "dgram/s"
				: name === "peak-rss-mib"
					? "MiB"
					: "ms";
	return {
		name,
		unit,
		samples: [value],
		summary: sampleSummary([value]),
		rawOutputs: ["{}"],
	};
}

function requiredRuns(): BenchmarkRun[] {
	return [
		benchmarkRun("handshake-p50-ms", 1),
		benchmarkRun("handshake-p95-ms", 2),
		benchmarkRun("handshake-p99-ms", 3),
		benchmarkRun("close-latency-p99-ms", 1),
		benchmarkRun("stream-throughput-mbps", 1),
		benchmarkRun("datagram-throughput-dgrams-per-sec", 1),
		benchmarkRun("datagram-loss-ratio", 0),
		benchmarkRun("event-loop-delay-p99-ms", 0),
		benchmarkRun("cpu-user-ms", 1),
		benchmarkRun("peak-rss-mib", 1),
	];
}

function approvedBaseline(
	overrides: Partial<ApprovedBaselines> = {},
): ApprovedBaselines {
	return {
		status: "approved",
		approvedAt: "2026-07-22T00:00:00.000Z",
		commit: "a".repeat(40),
		candidateRelationship: "exact",
		machine: "darwin/arm64/local/runner-a",
		bunVersion: "1.3.14",
		rustcVersion: "rustc 1.95.0",
		notes: [],
		thresholds: {},
		...overrides,
	};
}

describe("Task 14 scale proof contract", () => {
	test("requires an observed diverse live set and complete recovery evidence", () => {
		const source = readFileSync(
			resolve(ROOT, "tools/load/distributed-scale.ts"),
			"utf8",
		);
		for (const field of [
			"peakLiveSessions",
			"sourceIdentityCount",
			"liveSetHeldMs",
			"admissionShedCount",
			"finalGauges",
			"closeDurationMs",
		]) {
			expect(source).toContain(field);
		}
	});

	test("does not accept absent p99 metrics or opt-out RSS budgets", () => {
		const source = readFileSync(
			resolve(ROOT, "tools/load/distributed-scale.ts"),
			"utf8",
		);
		expect(source).toContain("missing handshake p99 evidence");
		expect(source).toContain("missing datagram enqueue p99 evidence");
		expect(source).toContain("missing stream open p99 evidence");
		expect(source).not.toContain("requireRssBudget: boolean");
		expect(source).not.toContain('tls: { certPem: "", keyPem: "" }');
	});
});
