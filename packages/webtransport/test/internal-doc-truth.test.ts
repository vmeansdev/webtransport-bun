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

/** The exact hosted-H7 contract every operator doc has to carry verbatim. */
const H7_CONTRACT = [
	"### H7 hosted closure lane",
	"",
	"Dispatch `soak-long` from the immutable tag",
	"`refs/tags/h7-batch-delivery-<candidate-sha>` with duration_hours=2,",
	"runner_type=self-hosted, runner_mode=dedicated, segment_index=1,",
	"segment_count=1, datagram_batch=64, rss_ceiling_mb=1750,",
	"committed_abort_mb=2200, and heap_debug=0. The run identity is",
	"`soak-long-<campaign_seed>`.",
	"",
	"The workload is fixed and preregistered: runner_profile=h7-fixed-large,",
	"sessions=500, datagrams_per_sec=500, streams_per_sec=5. The runner must",
	"provide at least 5 CPUs and 8 GiB of memory; an under-capacity runner",
	"fails closed rather than downscaling the load, because a downscaled run is",
	"evidence for a different workload than the claim names.",
	"",
	"Acceptance is the fail-closed `verify-h7-hosted` mode run against the same",
	"candidate SHA. This lane supplements the release soak policy: it",
	"does not replace the 24h/72h release soak.",
].join("\n");

/** Every token the policy must require in all three operator docs. */
const H7_REQUIRED_TOKENS = [
	"H7 hosted closure lane",
	"duration_hours=2",
	"runner_type=self-hosted",
	"runner_mode=dedicated",
	"datagram_batch=64",
	"rss_ceiling_mb=1750",
	"soak-long-<campaign_seed>",
	"runner_profile=h7-fixed-large",
	"sessions=500",
	"datagrams_per_sec=500",
	"streams_per_sec=5",
	"at least 5 CPUs and 8 GiB",
	"fails closed rather than downscaling",
	"refs/tags/h7-batch-delivery-<candidate-sha>",
	"verify-h7-hosted",
	"does not replace the 24h/72h release soak",
] as const;

const H7_DOCS = [
	"docs/CI.md",
	"docs/RELEASE_CHECKLIST.md",
	"tools/load/README.md",
] as const;

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
	mkdirSync(join(root, "tools", "load"), { recursive: true });

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
		[
			"The server runtime uses `Builder::new_multi_thread().worker_threads(2)`.",
			"The client runtime uses `Builder::new_multi_thread().worker_threads(1)`.",
			"readDatagram, sendDatagram, and discardDatagram run on the N-API runtime and must not be wrapped in `RUNTIME.spawn`.",
		].join("\n"),
	);
	writeFileSync(
		join(root, "crates", "native", "src", "session_napi.rs"),
		`impl SessionHandle {
    pub fn send_datagram(&self, env: Env, data: Buffer) -> Result<JsObject> {
        env.spawn_future(async move { send_datagram_for_session(&id, &bytes).await })
    }
    pub fn read_datagram(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            Ok(read_datagram_for_session(&id).await?.map(PayloadBuffer::from))
        })
    }
    pub fn discard_datagram(&self, env: Env, timeout_ms: Option<u32>) -> Result<JsObject> {
        env.spawn_future(async move { discard_datagram_for_session(&id, timeout).await })
    }
}`,
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
		[
			"The release blocks on fuzz and package-consumers.",
			"The soak-long workflow offers 1h/2h/24h/72h modes.",
			"",
			H7_CONTRACT,
		].join("\n"),
	);
	writeFileSync(
		join(root, "docs", "RELEASE_CHECKLIST.md"),
		[
			"Required release gates: fuzz and package-consumers.",
			"GitHub-hosted campaigns use segment_count=5 for 24h and",
			"segment_count=15 for 72h; self-hosted 24h and 72h campaigns use",
			"segment_count=1.",
			"",
			H7_CONTRACT,
		].join("\n"),
	);
	writeFileSync(
		join(root, "tools", "load", "README.md"),
		[
			"`soak.ts` is a legacy local diagnostic (30-minute, 500-session) and is",
			"not part of any hosted campaign.",
			"The soak-long workflow offers 1h/2h/24h/72h modes.",
			"",
			H7_CONTRACT,
		].join("\n"),
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
    .worker_threads(2)
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
		env: {
			...process.env,
			CHECK_DOC_TRUTH_ROOT: root,
			CHECK_DOC_TRUTH_ROOT_UNSAFE_TEST_SEAM: "1",
		},
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
			"must state the exact runtime constructor Builder::new_multi_thread().worker_threads(2) for RUNTIME",
		);
		expect(result.stderr).toContain(
			"must state the exact runtime constructor Builder::new_multi_thread().worker_threads(1) for CLIENT_RUNTIME",
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
			"RUNTIME contradicts Builder::new_multi_thread().worker_threads(2)",
		);
	});

	// Regression: one server worker discards 80-95% of datagrams under load.
	// If this test starts passing with worker_threads(1), the gate has stopped
	// protecting the mitigation.
	it("rejects a server runtime that reverts to a single worker", () => {
		const result = runPolicy((_fixture, root) => {
			const path = join(root, "crates", "native", "src", "lib.rs");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					".worker_threads(2)",
					".worker_threads(1)",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"RUNTIME contradicts Builder::new_multi_thread().worker_threads(2)",
		);
	});

	it("rejects architecture text that documents a single server worker", () => {
		const result = runPolicy((_fixture, root) => {
			const path = join(root, "docs", "ARCHITECTURE.md");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					"worker_threads(2)",
					"worker_threads(1)",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"must state the exact runtime constructor Builder::new_multi_thread().worker_threads(2) for RUNTIME",
		);
	});

	// Regression: the RUNTIME.spawn hop put every delivery on the server
	// runtime's injection queue, capping datagram delivery near 5,000/s with
	// 95% dropped. If this test stops failing, the hop can come back unnoticed.
	it("rejects a datagram read that hops back onto the server runtime", () => {
		const result = runPolicy((_fixture, root) => {
			const path = join(root, "crates", "native", "src", "session_napi.rs");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					"Ok(read_datagram_for_session(&id).await?.map(PayloadBuffer::from))",
					"RUNTIME.spawn(async move { read_datagram_for_session(&id).await }).await.map_err(wt_from_upstream_error)?",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"read_datagram must not hop onto the server runtime",
		);
	});

	it("rejects a datagram send that hops back onto the server runtime", () => {
		const result = runPolicy((_fixture, root) => {
			const path = join(root, "crates", "native", "src", "session_napi.rs");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					"env.spawn_future(async move { send_datagram_for_session(&id, &bytes).await })",
					"env.spawn_future(async move { RUNTIME.spawn(async move { send_datagram_for_session(&id, &bytes).await }).await })",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"send_datagram must not hop onto the server runtime",
		);
	});

	it("rejects a per-datagram discard that hops back onto the server runtime", () => {
		const result = runPolicy((_fixture, root) => {
			const path = join(root, "crates", "native", "src", "session_napi.rs");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					"env.spawn_future(async move { discard_datagram_for_session(&id, timeout).await })",
					"env.spawn_future(async move { RUNTIME.spawn(async move { discard_datagram_for_session(&id, timeout).await }).await })",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"discard_datagram must not hop onto the server runtime",
		);
	});

	it("rejects architecture text that drops the delivery-path contract", () => {
		const result = runPolicy((_fixture, root) => {
			const path = join(root, "docs", "ARCHITECTURE.md");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					"readDatagram, sendDatagram, and discardDatagram run on the N-API runtime and must not be wrapped in `RUNTIME.spawn`.",
					"Datagram methods are dispatched onto the server runtime.",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"must document that readDatagram, sendDatagram, and discardDatagram run on the N-API runtime",
		);
	});

	it("rejects a worker count derived at runtime instead of hardcoded", () => {
		const result = runPolicy((_fixture, root) => {
			const path = join(root, "crates", "native", "src", "lib.rs");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					".worker_threads(2)",
					".worker_threads(2)\n    .max_blocking_threads(std::thread::available_parallelism().unwrap().get())",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"RUNTIME must hardcode its worker count, not derive it at runtime",
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

function rewriteDoc(
	root: string,
	doc: string,
	edit: (text: string) => string,
): void {
	const path = join(root, ...doc.split("/"));
	writeFileSync(path, edit(readFileSync(path, "utf8")));
}

describe("hosted H7 operator documentation policy", () => {
	it("accepts the shared H7 closure-lane contract across all three operator docs", () => {
		const result = runPolicy();
		expect(result.status, result.stderr).toBe(0);
	});

	for (const doc of H7_DOCS) {
		for (const token of H7_REQUIRED_TOKENS) {
			it(`rejects ${doc} when it drops the required H7 text: ${token}`, () => {
				const result = runPolicy((_fixture, root) => {
					rewriteDoc(root, doc, (text) => text.replaceAll(token, ""));
				});
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(
					`${doc}: H7 hosted closure lane contract is missing required text: ${token}`,
				);
			});
		}
	}

	for (const doc of ["docs/CI.md", "tools/load/README.md"] as const) {
		it(`rejects ${doc} when it keeps an exclusive 1h/24h/72h soak-long mode list`, () => {
			const result = runPolicy((_fixture, root) => {
				rewriteDoc(root, doc, (text) =>
					text.replace("1h/2h/24h/72h", "1h/24h/72h"),
				);
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				`${doc}: soak-long mode list "1h/24h/72h" omits the 2-hour H7 hosted closure lane`,
			);
		});
	}

	it("rejects a release checklist that drops the H7 non-substitution sentence", () => {
		const result = runPolicy((_fixture, root) => {
			rewriteDoc(root, "docs/RELEASE_CHECKLIST.md", (text) =>
				text.replace(
					"does not replace the 24h/72h release soak",
					"replaces the 24h/72h release soak",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"docs/RELEASE_CHECKLIST.md: H7 hosted closure lane contract is missing required text: does not replace the 24h/72h release soak",
		);
	});

	it("rejects a 30-minute local diagnostic advertised as H7 evidence", () => {
		const result = runPolicy((_fixture, root) => {
			rewriteDoc(
				root,
				"tools/load/README.md",
				(text) =>
					`${text}\nThe 30-minute soak.ts run is acceptable H7 evidence.\n`,
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"tools/load/README.md: the local soak.ts diagnostic must not be described as H7, release, or soak-long evidence",
		);
	});

	it("rejects a nightly local diagnostic advertised as release evidence", () => {
		const result = runPolicy((_fixture, root) => {
			rewriteDoc(
				root,
				"tools/load/README.md",
				(text) => `${text}\nThe nightly soak doubles as release evidence.\n`,
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"tools/load/README.md: the local soak.ts diagnostic must not be described as H7, release, or soak-long evidence",
		);
	});

	it("rejects a load README that never labels soak.ts a legacy local diagnostic", () => {
		const result = runPolicy((_fixture, root) => {
			rewriteDoc(root, "tools/load/README.md", (text) =>
				text.replace("legacy local diagnostic", "supported soak path"),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"tools/load/README.md: must label the 30-minute soak.ts path a legacy local diagnostic",
		);
	});

	it("rejects the stale self-hosted segment_count=4|12 campaign wording", () => {
		const result = runPolicy((_fixture, root) => {
			rewriteDoc(root, "docs/RELEASE_CHECKLIST.md", (text) =>
				text.replace(
					"self-hosted 24h and 72h campaigns use\nsegment_count=1.",
					"on self-hosted runners use segment_count=4 or segment_count=12.",
				),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'docs/RELEASE_CHECKLIST.md: contradicts the workflow-enforced self-hosted segmentation: "segment_count=4"',
		);
		expect(result.stderr).toContain(
			"docs/RELEASE_CHECKLIST.md: must state that self-hosted 24h and 72h campaigns use segment_count=1",
		);
	});

	it("rejects stale 4x6h/12x6h self-hosted segment wording", () => {
		const result = runPolicy((_fixture, root) => {
			rewriteDoc(
				root,
				"docs/RELEASE_CHECKLIST.md",
				(text) =>
					`${text}\nThe workflow uses bounded 4x6h or 12x6h segments on self-hosted runners.\n`,
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'docs/RELEASE_CHECKLIST.md: contradicts the workflow-enforced self-hosted segmentation: "4x6h"',
		);
	});

	it("rejects a release checklist that drops GitHub-hosted 5/15 segmentation", () => {
		const result = runPolicy((_fixture, root) => {
			rewriteDoc(root, "docs/RELEASE_CHECKLIST.md", (text) =>
				text.replace("segment_count=15", "segment_count=16"),
			);
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"docs/RELEASE_CHECKLIST.md: must retain the GitHub-hosted segmentation value segment_count=15",
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
