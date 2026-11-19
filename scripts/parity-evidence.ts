#!/usr/bin/env bun
/**
 * Run the W3C facade parity suites against each requested backend and write
 * `parity-evidence.json` from what the runs actually reported.
 *
 *   bun scripts/parity-evidence.ts --backend native [--backend wasm] --out parity-evidence.json
 *
 * Each backend is one `bun test` run over every `parity-*.test.ts` file with
 * the JUnit reporter. The evidence carries the exact command, its exit code,
 * per-suite and per-test results parsed from the report, and the sha256 of the
 * raw report. The report itself is not published: Bun writes the host name
 * into it.
 *
 * `passed` is computed, never stated: a backend passes only when its command
 * exited 0, it reported at least one test, no test failed, and every parity
 * suite in the checkout reported at least one passing test (a suite that only
 * skipped, or that never loaded, fails the run). The file is written either
 * way; the process exits 1 unless the whole record passed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

export type Backend = "native" | "wasm";
export type CaseStatus = "passed" | "failed" | "skipped" | "todo";

export interface ParityCase {
	/** Enclosing `describe` titles, outermost first. Kept apart from the
	 * title: joined, a describe ending in ")" and an identifier-heavy title
	 * read as one opaque run to the evidence content check. */
	describe: string[];
	name: string;
	status: CaseStatus;
	line: number;
	durationMs: number;
}

export interface ParitySuite {
	file: string;
	tests: number;
	passed: number;
	failed: number;
	skipped: number;
	durationMs: number;
	cases: ParityCase[];
}

export interface BackendRun {
	backend: Backend;
	command: string[];
	env: Record<string, string>;
	exitCode: number;
	startedAt: string;
	finishedAt: string;
	report: string;
}

export interface BackendEvidence {
	backend: Backend;
	passed: boolean;
	problems: string[];
	command: string[];
	env: Record<string, string>;
	exitCode: number;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	reporter: { format: "junit"; bytes: number; sha256: string };
	totals: { tests: number; passed: number; failed: number; skipped: number };
	suites: ParitySuite[];
}

export interface ParityEvidence {
	schemaVersion: 1;
	suite: "parity";
	passed: boolean;
	commit: string;
	ref: string;
	generatedAt: string;
	platform: { os: string; arch: string; runtime: string };
	toolchain: { name: "bun"; version: string };
	expectedSuites: string[];
	backends: BackendEvidence[];
}

export const PARITY_TEST_DIR = "packages/webtransport/test";
/** Nine suites exist today; fewer means suites were lost, not that parity
 * shrank. Raise it when a suite is added. */
export const MIN_PARITY_SUITES = 9;
const REPORT_DIR = ".release-evidence/parity";

export function parityTestFiles(root = "."): string[] {
	return readdirSync(join(root, PARITY_TEST_DIR))
		.filter((name) => /^parity-[a-z0-9-]+\.test\.ts$/.test(name))
		.sort()
		.map((name) => `${PARITY_TEST_DIR}/${name}`);
}

// ---------------------------------------------------------------------------
// Bun's JUnit report

function unescapeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

function attributes(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g))
		attrs[match[1] as string] = unescapeXml(match[2] as string);
	return attrs;
}

function seconds(value: string | undefined): number {
	const parsed = Number(value ?? "0");
	return Number.isFinite(parsed) ? Math.round(parsed * 1e6) / 1e3 : 0;
}

/**
 * Parse the report `bun test --reporter=junit` writes: one top-level
 * `<testsuite>` per file, nested `<testsuite>`s per `describe`, and
 * `<testcase>`s that may hold `<skipped/>` or `<failure/>`. A case records its
 * describe chain from the nesting (Bun's own `classname` double-escapes, so it
 * is not used).
 */
export function parseJunit(xml: string): ParitySuite[] {
	const suites: ParitySuite[] = [];
	const describeChain: string[] = [];
	let depth = 0;
	let file: ParitySuite | undefined;
	let open: ParityCase | undefined;
	const tags =
		/<(\/?)(testsuites|testsuite|testcase|skipped|failure|error)\b([^>]*?)(\/?)>/g;
	for (const match of xml.matchAll(tags)) {
		const [, closing, tag, rawAttrs, selfClosing] = match as unknown as [
			string,
			string,
			string,
			string,
			string,
		];
		const attrs = attributes(rawAttrs);
		if (tag === "testsuite") {
			if (closing) {
				depth -= 1;
				if (depth === 0) {
					if (file) suites.push(file);
					file = undefined;
				} else describeChain.pop();
				continue;
			}
			depth += 1;
			if (depth === 1) {
				file = {
					file: attrs.file ?? attrs.name ?? "",
					tests: 0,
					passed: 0,
					failed: 0,
					skipped: 0,
					durationMs: 0,
					cases: [],
				};
			} else describeChain.push(attrs.name ?? "");
			if (selfClosing) {
				depth -= 1;
				if (depth === 0 && file) {
					suites.push(file);
					file = undefined;
				} else describeChain.pop();
			}
			continue;
		}
		if (tag === "testcase") {
			if (closing) {
				open = undefined;
				continue;
			}
			if (!file) throw new Error("junit: <testcase> outside a file suite");
			open = {
				describe: [...describeChain],
				name: attrs.name ?? "",
				status: "passed",
				line: Number(attrs.line ?? 0) || 0,
				durationMs: seconds(attrs.time),
			};
			file.cases.push(open);
			if (selfClosing) open = undefined;
			continue;
		}
		if (closing || !open) continue;
		if (tag === "skipped")
			open.status = attrs.message === "TODO" ? "todo" : "skipped";
		else if (tag === "failure" || tag === "error") open.status = "failed";
	}
	if (depth !== 0) throw new Error("junit: unbalanced <testsuite> elements");
	suites.sort((a, b) => a.file.localeCompare(b.file));
	for (const suite of suites) {
		suite.tests = suite.cases.length;
		suite.passed = suite.cases.filter((c) => c.status === "passed").length;
		suite.failed = suite.cases.filter((c) => c.status === "failed").length;
		suite.skipped = suite.tests - suite.passed - suite.failed;
		// Bun writes time="0" on the file-level element; sum the cases instead.
		suite.durationMs =
			Math.round(suite.cases.reduce((ms, c) => ms + c.durationMs, 0) * 1e3) /
			1e3;
	}
	return suites;
}

// ---------------------------------------------------------------------------
// Evidence

export function backendEvidence(
	run: BackendRun,
	expectedSuites: readonly string[],
): BackendEvidence {
	const problems: string[] = [];
	let suites: ParitySuite[] = [];
	try {
		suites = parseJunit(run.report);
	} catch (error) {
		problems.push(`report did not parse: ${(error as Error).message}`);
	}
	const totals = {
		tests: suites.reduce((n, s) => n + s.tests, 0),
		passed: suites.reduce((n, s) => n + s.passed, 0),
		failed: suites.reduce((n, s) => n + s.failed, 0),
		skipped: suites.reduce((n, s) => n + s.skipped, 0),
	};
	if (run.exitCode !== 0) problems.push(`bun test exited ${run.exitCode}`);
	if (totals.tests === 0) problems.push("no tests were reported");
	if (totals.failed > 0) problems.push(`${totals.failed} test(s) failed`);
	if (expectedSuites.length < MIN_PARITY_SUITES)
		problems.push(
			`only ${expectedSuites.length} parity suites in the checkout (expected at least ${MIN_PARITY_SUITES})`,
		);
	const reported = new Map(suites.map((s) => [s.file, s]));
	for (const expected of expectedSuites) {
		const suite = reported.get(expected);
		if (!suite) problems.push(`${expected}: not in the report`);
		else if (suite.passed === 0) problems.push(`${expected}: no passing test`);
	}
	for (const suite of suites)
		if (!expectedSuites.includes(suite.file))
			problems.push(`${suite.file}: reported but not a parity suite`);
	const report = Buffer.from(run.report);
	return {
		backend: run.backend,
		passed: problems.length === 0,
		problems,
		command: run.command,
		env: run.env,
		exitCode: run.exitCode,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
		reporter: {
			format: "junit",
			bytes: report.byteLength,
			sha256: createHash("sha256").update(report).digest("hex"),
		},
		totals,
		suites,
	};
}

export function parityEvidence(input: {
	backends: readonly Backend[];
	runs: readonly BackendRun[];
	expectedSuites: readonly string[];
	commit: string;
	ref: string;
	generatedAt: string;
	platform: ParityEvidence["platform"];
	bunVersion: string;
}): ParityEvidence {
	const backends = input.runs.map((run) =>
		backendEvidence(run, input.expectedSuites),
	);
	const ran = new Set(backends.map((b) => b.backend));
	const passed =
		input.backends.length > 0 &&
		input.backends.every((b) => ran.has(b)) &&
		backends.length === input.backends.length &&
		backends.every((b) => b.passed);
	return {
		schemaVersion: 1,
		suite: "parity",
		passed,
		commit: input.commit,
		ref: input.ref,
		generatedAt: input.generatedAt,
		platform: input.platform,
		toolchain: { name: "bun", version: input.bunVersion },
		expectedSuites: [...input.expectedSuites],
		backends,
	};
}

// ---------------------------------------------------------------------------
// CLI

function headCommit(): string {
	const fromEnv = process.env.GITHUB_SHA;
	if (fromEnv && /^[0-9a-f]{40}$/.test(fromEnv)) return fromEnv;
	const sha =
		spawnSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).stdout?.trim() ?? "";
	if (!/^[0-9a-f]{40}$/.test(sha))
		throw new Error("parity-evidence: cannot determine the commit");
	return sha;
}

function currentRef(): string {
	const fromEnv = process.env.GITHUB_REF_NAME;
	if (fromEnv) return fromEnv;
	const ref =
		spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
		}).stdout?.trim() ?? "";
	return ref || "HEAD";
}

async function runBackend(
	backend: Backend,
	files: readonly string[],
): Promise<BackendRun> {
	const reportPath = `${REPORT_DIR}/parity-${backend}.junit.xml`;
	const command = [
		"bun",
		"test",
		"--max-concurrency=1",
		"--reporter=junit",
		`--reporter-outfile=${reportPath}`,
		...files,
	];
	const env: Record<string, string> = {
		WEBTRANSPORT_PARITY_BACKEND: backend,
		WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
	};
	// Without this the wasm suites soft-skip when the pkg is missing.
	if (backend === "wasm") env.WEBTRANSPORT_REQUIRE_WASM = "1";
	writeFileSync(reportPath, "");
	console.error(`parity-evidence: ${backend}: ${command.join(" ")}`);
	const startedAt = new Date().toISOString();
	// Inherited stdio: the suites are timing-sensitive and their output belongs
	// in the job log, not in this process's pipes.
	const proc = Bun.spawn(command, {
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, ...env },
	});
	const exitCode = await proc.exited;
	const finishedAt = new Date().toISOString();
	return {
		backend,
		command,
		env,
		exitCode,
		startedAt,
		finishedAt,
		report: readFileSync(reportPath, "utf8"),
	};
}

function usage(): never {
	console.error(
		"usage: bun scripts/parity-evidence.ts --backend <native|wasm> [--backend ...] --out <file>",
	);
	process.exit(2);
}

async function main(argv: string[]): Promise<number> {
	const backends: Backend[] = [];
	let out: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = argv[i + 1];
		if (arg === "--backend" && (value === "native" || value === "wasm")) {
			if (backends.includes(value)) usage();
			backends.push(value);
			i += 1;
		} else if (arg === "--out" && value) {
			out = value;
			i += 1;
		} else usage();
	}
	if (backends.length === 0 || !out) usage();

	mkdirSync(REPORT_DIR, { recursive: true });
	const expectedSuites = parityTestFiles();
	const runs: BackendRun[] = [];
	for (const backend of backends)
		runs.push(await runBackend(backend, expectedSuites));
	const evidence = parityEvidence({
		backends,
		runs,
		expectedSuites,
		commit: headCommit(),
		ref: currentRef(),
		generatedAt: new Date().toISOString(),
		platform: { os: platform(), arch: arch(), runtime: "bun" },
		bunVersion: Bun.version,
	});
	writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
	for (const b of evidence.backends) {
		const { tests, passed, failed, skipped } = b.totals;
		console.error(
			`parity-evidence: ${b.backend}: ${b.passed ? "PASS" : "FAIL"} ` +
				`(${b.suites.length} suites, ${tests} tests: ${passed} passed, ${failed} failed, ${skipped} skipped)`,
		);
		for (const problem of b.problems)
			console.error(`parity-evidence: ${b.backend}: ${problem}`);
	}
	console.error(
		`parity-evidence: ${evidence.passed ? "passed" : "FAILED"}; wrote ${out}`,
	);
	return evidence.passed ? 0 : 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
