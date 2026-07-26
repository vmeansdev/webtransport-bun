import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runCommand } from "./release-smoke.ts";

describe("Task 14 fuzz release smoke", () => {
	test("defines a cargo-fuzz target for every required attack surface", () => {
		const manifest = readFileSync(
			resolve(import.meta.dir, "Cargo.toml"),
			"utf8",
		);
		for (const target of [
			"h3_frames",
			"qpack_huffman",
			"der_metadata",
			"cert_pin_policy",
			"handle_allocator",
			"endpoint_event_dispatch",
			"event_encode",
			"limit_arithmetic",
		]) {
			expect(manifest).toContain(`name = "${target}"`);
		}
	});

	test("runs every target for the fixed duration with retained artifacts and corpora", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "release-smoke.ts"),
			"utf8",
		);
		expect(source).toContain("cargoFuzzTargets");
		expect(source).toContain("-max_total_time=");
		expect(source).toContain("-artifact_prefix=");
		expect(source).toContain("--fuzz-dir");
		expect(source).toContain("--sanitizer");
		expect(source).toContain("none");
		expect(source).toContain(".release-evidence");
		expect(source).toContain("corpora");
		expect(source).toContain("rustup run");
		expect(source).toContain(".github/release-toolchain.json");
		expect(source).toContain("ASAN_SYMBOLIZER_PATH");
	});

	test("enforces an outer watchdog per command and artifacts timeout state", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "release-smoke.ts"),
			"utf8",
		);
		expect(source).toContain("timeoutMs");
		expect(source).toContain("timedOut");
		expect(source).toContain('proc.kill("SIGTERM")');
		expect(source).toContain('proc.kill("SIGKILL")');
		expect(source).toContain("timeoutSignal");
		expect(source).toContain("drainDurationMs");
		expect(source).toContain("drainTimedOut");
		expect(source).toContain("stdoutBytes");
		expect(source).toContain("stderrBytes");
	});

	test("settles deterministically when a timed-out command leaves descendant-held pipes open", async () => {
		const started = performance.now();
		const result = await runCommand(
			[
				"/bin/sh",
				"-c",
				[
					'trap "exit 0" TERM',
					"(sleep 3) &",
					"echo stdout-ready",
					"echo stderr-ready 1>&2",
					"while :; do sleep 1; done",
				].join("\n"),
			],
			{
				timeoutMs: 100,
				drainTimeoutMs: 100,
			},
		);
		const settledInMs = performance.now() - started;

		expect(result.timedOut).toBe(true);
		expect(result.timeoutSignal).toBe("SIGTERM");
		expect(result.drainTimedOut).toBe(true);
		expect(result.drainDurationMs).toBeGreaterThanOrEqual(100);
		expect(result.stdout).toContain("stdout-ready");
		expect(result.stderr).toContain("stderr-ready");
		expect(result.stdoutBytes).toBeGreaterThan(0);
		expect(result.stderrBytes).toBeGreaterThan(0);
		expect(settledInMs).toBeLessThan(2_000);
	});

	test("names release fuzz coverage after the production code paths it actually executes", () => {
		const manifest = readFileSync(
			resolve(import.meta.dir, "Cargo.toml"),
			"utf8",
		);
		const readme = readFileSync(
			resolve(import.meta.dir, "README.md"),
			"utf8",
		).replace(/\s+/g, " ");

		expect(manifest).toContain('name = "handle_allocator"');
		expect(manifest).toContain('name = "endpoint_event_dispatch"');
		expect(manifest).toContain('name = "event_encode"');
		expect(manifest).toContain('name = "cert_pin_policy"');
		expect(manifest).not.toContain('name = "event_decode"');
		expect(readme).toContain("DER metadata parsing");
		expect(readme).toContain("certificate pin policy");
		expect(readme).toContain("HandleAllocator");
		expect(readme).toContain("WtEndpoint event dispatch");
		expect(readme).toContain("event encoding");
		expect(readme).not.toContain("does not directly fuzz");
	});

	test("runs the production TS wasm event decoder property harness during release smoke", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "release-smoke.ts"),
			"utf8",
		);
		expect(source).toContain("packages/webtransport/test/wasm-limits.test.ts");
		expect(source).toContain("WASM event decoder property harness");
		expect(source).toContain("--test-name-pattern");
	});

	test("the release and scheduled workflows make fuzz smoke blocking and artifacted", () => {
		const releaseWorkflow = readFileSync(
			resolve(import.meta.dir, "../../.github/workflows/release.yml"),
			"utf8",
		);
		const fuzzWorkflow = readFileSync(
			resolve(import.meta.dir, "../../.github/workflows/fuzz.yml"),
			"utf8",
		);
		const packageJson = readFileSync(
			resolve(import.meta.dir, "../../package.json"),
			"utf8",
		);

		expect(releaseWorkflow).toContain("fuzz:");
		expect(releaseWorkflow).toContain("needs: [security, codeql, fuzz]");
		expect(releaseWorkflow).toContain("bun run fuzz:release-smoke");
		expect(releaseWorkflow).toContain("fuzz-evidence");
		expect(fuzzWorkflow).toContain("schedule:");
		expect(fuzzWorkflow).toContain("workflow_dispatch:");
		expect(fuzzWorkflow).toContain("bun run fuzz:release-smoke");
		expect(fuzzWorkflow).toContain("retention-days: 90");
		expect(packageJson).toContain('"fuzz:release-smoke"');
	});

	test("docs and coverage workflow point at canonical evidence paths and preserve Rust JSON coverage", () => {
		const coverageWorkflow = readFileSync(
			resolve(import.meta.dir, "../../.github/workflows/coverage.yml"),
			"utf8",
		);
		const ciDoc = readFileSync(
			resolve(import.meta.dir, "../../docs/CI.md"),
			"utf8",
		);
		const testPlan = readFileSync(
			resolve(import.meta.dir, "../../docs/TESTPLAN.md"),
			"utf8",
		);

		expect(coverageWorkflow).toContain("--coverage-dir=coverage/bun");
		expect(coverageWorkflow).toContain("coverage/native-coverage.json");
		expect(coverageWorkflow).toContain("coverage/wasm-coverage.json");
		expect(coverageWorkflow).toContain("coverage/bun/lcov.info");
		expect(coverageWorkflow).toContain("coverage/lcov.info");
		expect(ciDoc).toContain(".release-evidence/fuzz/release-smoke.json");
		expect(testPlan).toContain(".release-evidence/fuzz/release-smoke.json");
		expect(testPlan).not.toContain("tools/fuzz/release-smoke-artifact.json");
	});

	test("release status names distributed scale as the authoritative 10k multisource harness", () => {
		const releaseStatus = readFileSync(
			resolve(import.meta.dir, "../../docs/RELEASE_1.0_STATUS.md"),
			"utf8",
		);

		expect(releaseStatus).toContain("distributed-scale.ts");
		expect(releaseStatus).toContain(
			".release-evidence/load/distributed-scale-artifact.json",
		);
		expect(releaseStatus).not.toContain("load-scale.ts");
		expect(releaseStatus).not.toContain("load-scale-artifact.json");
		expect(releaseStatus).not.toContain("load-scale-addon.ts");
	});
});
