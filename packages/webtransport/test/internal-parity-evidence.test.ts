import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	type Backend,
	type BackendRun,
	MIN_PARITY_SUITES,
	parityEvidence,
	parityTestFiles,
	parseJunit,
} from "../../../scripts/parity-evidence.ts";
import {
	JSON_SCHEMAS,
	schemaProblems,
} from "../../../scripts/release-evidence-content.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SUITES = Array.from(
	{ length: MIN_PARITY_SUITES },
	(_, i) => `packages/webtransport/test/parity-s${i}.test.ts`,
);

type CaseKind = "pass" | "fail" | "skip" | "todo";

function junit(files: Record<string, CaseKind[]>): string {
	const body = Object.entries(files)
		.map(([file, cases]) => {
			const tcs = cases
				.map((kind, i) => {
					const open = `<testcase name="case ${i} &lt;&amp;&gt;" classname="x &amp;gt; y" time="0.0015" file="${file}" line="${i + 3}" assertions="1"`;
					if (kind === "pass") return `${open} />`;
					const inner =
						kind === "fail"
							? `<failure type="AssertionError" />`
							: kind === "todo"
								? `<skipped message="TODO" />`
								: "<skipped />";
					return `${open}>\n${inner}\n</testcase>`;
				})
				.join("\n");
			return `<testsuite name="${file}" file="${file}" tests="${cases.length}" time="0.25" hostname="build-host.example">
<testsuite name="describe [native]" file="${file}" line="2" tests="${cases.length}" hostname="build-host.example">
${tcs}
</testsuite>
</testsuite>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n${body}\n</testsuites>\n`;
}

function run(
	backend: Backend,
	files: Record<string, CaseKind[]>,
	exitCode = 0,
): BackendRun {
	return {
		backend,
		command: ["bun", "test", "--reporter=junit", ...Object.keys(files)],
		env: {
			WEBTRANSPORT_PARITY_BACKEND: backend,
			WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
		},
		exitCode,
		startedAt: "2026-11-19T10:00:00.000Z",
		finishedAt: "2026-11-19T10:00:07.500Z",
		report: junit(files),
	};
}

const allPass = () =>
	Object.fromEntries(SUITES.map((s) => [s, ["pass", "pass"] as CaseKind[]]));

function evidence(
	runs: BackendRun[],
	backends: Backend[] = runs.map((r) => r.backend),
	expectedSuites: string[] = SUITES,
) {
	return parityEvidence({
		backends,
		runs,
		expectedSuites,
		commit: "a".repeat(40),
		ref: "v1.0.0-rc.6",
		generatedAt: "2026-11-19T10:00:08.000Z",
		platform: { os: "linux", arch: "x64", runtime: "bun" },
		bunVersion: "1.3.14",
	});
}

describe("parity evidence", () => {
	it("parses Bun's JUnit report into per-suite, per-test results", () => {
		const [suite] = parseJunit(
			junit({ "a.test.ts": ["pass", "fail", "skip", "todo"] }),
		);
		expect(suite?.file).toBe("a.test.ts");
		expect(suite?.durationMs).toBe(6);
		expect([
			suite?.tests,
			suite?.passed,
			suite?.failed,
			suite?.skipped,
		]).toEqual([4, 1, 1, 2]);
		expect(suite?.cases.map((c) => c.status)).toEqual([
			"passed",
			"failed",
			"skipped",
			"todo",
		]);
		expect(suite?.cases[0]).toEqual({
			describe: ["describe [native]"],
			name: "case 0 <&>",
			status: "passed",
			line: 3,
			durationMs: 1.5,
		});
	});

	it("refuses an unbalanced report", () => {
		expect(() => parseJunit("<testsuites><testsuite file='x'>")).toThrow(
			"unbalanced",
		);
	});

	it("passes when every backend ran every suite green, and the record satisfies its content schema", () => {
		const ev = evidence([run("native", allPass()), run("wasm", allPass())]);
		expect(ev.passed).toBe(true);
		expect(ev.backends.map((b) => [b.backend, b.passed, b.problems])).toEqual([
			["native", true, []],
			["wasm", true, []],
		]);
		expect(ev.backends[0]?.totals).toEqual({
			tests: 2 * MIN_PARITY_SUITES,
			passed: 2 * MIN_PARITY_SUITES,
			failed: 0,
			skipped: 0,
		});
		expect(ev.backends[0]?.reporter.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(ev.backends[0]?.durationMs).toBe(7500);
		expect(
			schemaProblems(ev, JSON_SCHEMAS["parity-evidence"] as never),
		).toEqual([]);
		// The raw report carries the host name; only its digest is published.
		expect(JSON.stringify(ev)).not.toContain("build-host");
	});

	it("fails a run that reported zero tests", () => {
		const ev = evidence([run("native", {})]);
		expect(ev.passed).toBe(false);
		expect(ev.backends[0]?.problems).toContain("no tests were reported");
	});

	it("fails when a parity suite is missing from the report", () => {
		const files = allPass();
		delete files[SUITES[3] as string];
		const ev = evidence([run("native", files)]);
		expect(ev.passed).toBe(false);
		expect(ev.backends[0]?.problems).toContain(
			`${SUITES[3]}: not in the report`,
		);
	});

	it("fails on a failed test even if the exit code says otherwise", () => {
		const files = allPass();
		files[SUITES[0] as string] = ["pass", "fail"];
		const ev = evidence([run("native", files, 0)]);
		expect(ev.passed).toBe(false);
		expect(ev.backends[0]?.problems).toContain("1 test(s) failed");
	});

	it("fails a suite that only skipped (soft-skipped backend)", () => {
		const files = allPass();
		files[SUITES[1] as string] = ["skip", "todo"];
		const ev = evidence([run("wasm", files)]);
		expect(ev.passed).toBe(false);
		expect(ev.backends[0]?.problems).toContain(`${SUITES[1]}: no passing test`);
	});

	it("fails on a non-zero exit with an otherwise clean report", () => {
		const ev = evidence([run("native", allPass(), 1)]);
		expect(ev.passed).toBe(false);
		expect(ev.backends[0]?.problems).toContain("bun test exited 1");
	});

	it("fails when a requested backend has no run", () => {
		const ev = evidence([run("native", allPass())], ["native", "wasm"]);
		expect(ev.backends[0]?.passed).toBe(true);
		expect(ev.passed).toBe(false);
	});

	it("fails when the checkout lost parity suites", () => {
		const few = SUITES.slice(0, 2);
		const files = Object.fromEntries(
			few.map((s) => [s, ["pass"] as CaseKind[]]),
		);
		const ev = evidence([run("native", files)], ["native"], few);
		expect(ev.passed).toBe(false);
		expect(ev.backends[0]?.problems.join("\n")).toContain(
			"only 2 parity suites",
		);
	});

	it("finds at least the minimum number of parity suites in the checkout", () => {
		const files = parityTestFiles(ROOT);
		expect(files.length).toBeGreaterThanOrEqual(MIN_PARITY_SUITES);
		for (const file of files)
			expect(file).toMatch(
				/^packages\/webtransport\/test\/parity-.+\.test\.ts$/,
			);
	});

	it("rejects bad CLI arguments without running anything", () => {
		const result = spawnSync(
			process.execPath,
			[join(ROOT, "scripts/parity-evidence.ts"), "--backend", "browser"],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("usage:");
	});
});
