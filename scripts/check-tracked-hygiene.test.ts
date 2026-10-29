import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "check-tracked-hygiene.sh");

function runStdin(paths: string[]) {
	const proc = Bun.spawnSync(["bash", SCRIPT, "--stdin"], {
		stdin: new TextEncoder().encode(`${paths.join("\n")}\n`),
	});
	return {
		code: proc.exitCode,
		stderr: proc.stderr.toString(),
	};
}

describe("check-tracked-hygiene", () => {
	test("accepts ordinary product, test and fixture paths", () => {
		const result = runStdin([
			"packages/webtransport/src/index.ts",
			"docs/OPERATIONS.md",
			"docs/release-evidence.schema.json",
			"docs/release-evidence-manifest.json",
			"docs/release-evidence-manifest.schema.json",
			"tools/load/fixtures/run.jsonl",
			"packages/webtransport/test/data/events.jsonl",
			"crates/native/tests/frames.jsonl",
			".gitignore",
		]);
		expect(result.code).toBe(0);
	});

	test.each([
		".release-evidence/iwa/evidence.json",
		".bench-evidence/bench-sink-idle.json",
		".scratch/feature/spec.md",
		"docs/superpowers/plans/plan.md",
		"session-transcript.jsonl",
		"tools/load/run-log.jsonl",
		"docs/notes/agent.jsonl",
	])("refuses %s", (path) => {
		const result = runStdin(["README.md", path]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(path);
	});

	test("checks the git index, including staged files", () => {
		const dir = mkdtempSync(join(tmpdir(), "wtb-hygiene-"));
		try {
			const git = (...args: string[]) => {
				const p = Bun.spawnSync(["git", ...args], { cwd: dir });
				if (p.exitCode !== 0) throw new Error(p.stderr.toString());
			};
			const write = (rel: string) => {
				mkdirSync(dirname(join(dir, rel)), { recursive: true });
				writeFileSync(join(dir, rel), "x\n");
			};
			git("init", "-q");
			write("README.md");
			git("add", "README.md");
			const clean = Bun.spawnSync(["bash", SCRIPT], { cwd: dir });
			expect(clean.exitCode).toBe(0);
			write(".release-evidence/x.json");
			git("add", "-f", ".release-evidence/x.json");
			const dirty = Bun.spawnSync(["bash", SCRIPT], { cwd: dir });
			expect(dirty.exitCode).toBe(1);
			expect(dirty.stderr.toString()).toContain(".release-evidence/x.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
