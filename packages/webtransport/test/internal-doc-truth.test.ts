import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const roots: string[] = [];

type Fixture = ReturnType<typeof validStatus>;

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function getAt<T>(items: T[], index: number): T {
	const item = items[index];
	if (!item) throw new Error(`fixture item ${index} is missing`);
	return item;
}

function validStatus() {
	return {
		schemaVersion: 1,
		candidate: { commit: COMMIT, readiness: "pending" },
		evidence: [
			{
				id: "native-bun-linux",
				path: ".release-evidence/native-bun-linux.json",
				commit: COMMIT,
				status: "passed",
			},
			{
				id: "wasm-iwa",
				path: ".release-evidence/wasm-iwa.json",
				commit: COMMIT,
				status: "passed",
			},
		],
		claims: [
			{
				id: "native-local",
				surface: "native",
				status: "passed",
				evidenceIds: ["native-bun-linux"],
			},
			{
				id: "wasm-browser",
				surface: "wasm",
				status: "passed",
				evidenceIds: ["wasm-iwa"],
			},
		],
		surfaces: {
			native: { stability: "candidate", requiredClaims: ["native-local"] },
			wasm: { stability: "candidate", requiredClaims: ["wasm-browser"] },
		},
		support: {
			claimed: [{ runtime: "bun-1.3.9", os: "linux", arch: "x64" }],
			tested: [
				{
					runtime: "bun-1.3.9",
					os: "linux",
					arch: "x64",
					evidenceIds: ["native-bun-linux"],
				},
			],
		},
	};
}

function runPolicy(mutate?: (fixture: Fixture, root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "wt-doc-truth-"));
	roots.push(root);
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "crates", "native", "src"), { recursive: true });
	mkdirSync(join(root, ".release-evidence"), { recursive: true });
	mkdirSync(join(root, "packages", "webtransport"), { recursive: true });

	const fixture = validStatus();
	writeFileSync(
		join(root, "README.md"),
		[
			"Canonical release truth: docs/release-status.json.",
			"This README describes candidate surfaces, not stable/GA.",
			"Candidate support remains unclaimed until release evidence passes.",
			"Readiness remains pending in docs/release-status.json.",
		].join("\n"),
	);
	writeFileSync(
		join(root, "docs", "ARCHITECTURE.md"),
		"Both runtimes use `Builder::new_multi_thread().worker_threads(1)`.",
	);
	writeFileSync(
		join(root, "docs", "FAQ.md"),
		"Not yet. Current evidence is recorded in docs/release-status.json.",
	);
	writeFileSync(
		join(root, "docs", "COMPATIBILITY.md"),
		"These are configured 1.0 release targets. See docs/release-status.json.",
	);
	writeFileSync(
		join(root, "docs", "CI.md"),
		"The release blocks on fuzz and package-consumers.",
	);
	writeFileSync(
		join(root, "docs", "RELEASE_CHECKLIST.md"),
		"Required release gates: fuzz and package-consumers.",
	);
	writeFileSync(
		join(root, "docs", "RELEASE_1.0_HARDENING_PLAN.md"),
		"Historical plan (superseded). See docs/release-status.json.",
	);
	writeFileSync(
		join(root, "packages", "webtransport", "README.md"),
		[
			"Canonical release truth: ../../docs/release-status.json.",
			"This README describes the current candidate surface, not a stable/GA promise.",
			"These are candidate targets, not current support claims.",
			"Support is claimed only after ../../docs/release-status.json carries passing evidence.",
		].join("\n"),
	);
	writeFileSync(
		join(root, "crates", "native", "src", "lib.rs"),
		`pub(crate) static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
  tokio::runtime::Builder::new_multi_thread()
    .worker_threads(1)
    .thread_name("wt-server")
    .build().unwrap()
});
pub(crate) static CLIENT_RUNTIME: Lazy<Runtime> = Lazy::new(|| {
  tokio::runtime::Builder::new_multi_thread()
    .worker_threads(1)
    .thread_name("wt-client")
    .build().unwrap()
});`,
	);
	for (const evidence of fixture.evidence) {
		writeFileSync(
			join(root, evidence.path),
			JSON.stringify({ commit: COMMIT }),
		);
	}
	mutate?.(fixture, root);
	writeFileSync(
		join(root, "docs", "release-status.json"),
		JSON.stringify(fixture),
	);

	return spawnSync(process.execPath, ["scripts/check-doc-truth.ts"], {
		cwd: PROJECT_ROOT,
		env: { ...process.env, CHECK_DOC_TRUTH_ROOT: root },
		encoding: "utf8",
	});
}

describe("documentation truth policy", () => {
	it("accepts commit-bound claims, tested support, and the exact runtime contract", () => {
		const result = runPolicy();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("documentation truth check passed");
	});

	it("rejects a passed status claim without an evidence ID", () => {
		const result = runPolicy((fixture) => {
			getAt(fixture.claims, 0).evidenceIds = [];
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("status claim has no evidence ID");
	});

	it("rejects evidence recorded for a different candidate commit", () => {
		const result = runPolicy((fixture, root) => {
			const evidence = getAt(fixture.evidence, 0);
			evidence.commit = "abcdef0123456789abcdef0123456789abcdef01";
			writeFileSync(
				join(root, evidence.path),
				JSON.stringify({ commit: evidence.commit }),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("differs from candidate commit");
	});

	it("rejects calling the wasm surface stable before every required gate passes", () => {
		const result = runPolicy((fixture) => {
			fixture.surfaces.wasm.stability = "stable";
			getAt(fixture.claims, 1).status = "pending";
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"wasm is called stable before required gate wasm-browser passes",
		);
	});

	it("rejects architecture text that contradicts the exact Tokio constructor", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(
				join(root, "docs", "ARCHITECTURE.md"),
				"Both runtimes use `Builder::new_current_thread()`.",
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"must state the exact runtime constructor Builder::new_multi_thread().worker_threads(1)",
		);
	});

	it("rejects source that drifts from the exact documented Tokio constructor", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(
				join(root, "crates", "native", "src", "lib.rs"),
				readFileSync(
					join(root, "crates", "native", "src", "lib.rs"),
					"utf8",
				).replace(
					"Builder::new_multi_thread()",
					"Builder::new_current_thread()",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"RUNTIME contradicts Builder::new_multi_thread().worker_threads(1)",
		);
	});

	it("rejects support claims absent from the passing tested matrix", () => {
		const result = runPolicy((fixture) => {
			fixture.support.claimed.push({
				runtime: "deno-2.9.3",
				os: "windows",
				arch: "x64",
			});
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("support table exceeds tested matrix");
	});

	it("rejects optimistic release readiness while any claim remains pending", () => {
		const result = runPolicy((fixture) => {
			fixture.candidate.readiness = "ready";
			getAt(fixture.claims, 1).status = "pending";
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"ready release still has non-passing gaRequired claim wasm-browser",
		);
	});

	it("rejects an unbound zero-known-findings claim in the FAQ", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(
				join(root, "docs", "FAQ.md"),
				"The release has zero known P0/P1/P2 defects. See docs/release-status.json.",
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"must not claim zero known P-level findings",
		);
	});

	it("rejects a superseded native-only plan without a historical banner", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(
				join(root, "docs", "RELEASE_1.0_HARDENING_PLAN.md"),
				"Native-only release plan. See docs/release-status.json.",
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("must carry an explicit historical banner");
	});

	it("rejects a compatibility matrix presented without candidate-target context", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(
				join(root, "docs", "COMPATIBILITY.md"),
				"Supported everywhere. See docs/release-status.json.",
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"must identify themselves as configured release targets",
		);
	});

	it("rejects release documentation that omits enforced blocking gates", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(
				join(root, "docs", "RELEASE_CHECKLIST.md"),
				"Required release gates: build only.",
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("must name the release-blocking fuzz gate");
		expect(result.stderr).toContain(
			"must name the release-blocking package-consumers gate",
		);
	});

	it("rejects a top-level README that drops release-truth readiness deferral", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(join(root, "README.md"), "This surface is stable now.");
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"README.md: release-truth wording must defer support/readiness to docs/release-status.json",
		);
		expect(result.stderr).toContain(
			"README.md: must include the release-truth phrase: Readiness remains pending",
		);
	});

	it("rejects the package README when it claims support outside release-status", () => {
		const result = runPolicy((_fixture, root) => {
			writeFileSync(
				join(root, "packages", "webtransport", "README.md"),
				[
					"Canonical release truth: ../../docs/release-status.json.",
					"This README describes the current candidate surface, not a stable/GA promise.",
					"These targets are fully supported right now.",
				].join("\n"),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"packages/webtransport/README.md: must include the release-truth phrase: candidate targets, not current support claims",
		);
		expect(result.stderr).toContain(
			"packages/webtransport/README.md: must include the release-truth phrase: Support is claimed only after",
		);
	});
});

describe("operational alert examples", () => {
	it("are valid YAML and map every alert to a local runbook anchor", () => {
		const yamlPath = join(PROJECT_ROOT, "ops", "prometheus-alerts.yml");
		const runbookPath = join(PROJECT_ROOT, "ops", "README.md");
		const parsed = Bun.YAML.parse(readFileSync(yamlPath, "utf8")) as {
			groups?: Array<{
				rules?: Array<{
					alert?: string;
					annotations?: { runbook_url?: string };
				}>;
			}>;
		};
		const runbook = readFileSync(runbookPath, "utf8");
		const rules = parsed.groups?.flatMap((group) => group.rules ?? []) ?? [];
		expect(rules.length).toBeGreaterThanOrEqual(9);
		for (const rule of rules) {
			expect(rule.alert).toBeTruthy();
			const url = rule.annotations?.runbook_url;
			expect(url).toStartWith(
				"https://github.com/vmeansdev/webtransport-bun/blob/main/ops/README.md#",
			);
			const anchor = url?.split("#").at(-1);
			expect(runbook).toContain(`<a id="${anchor}"></a>`);
		}
	});
});
