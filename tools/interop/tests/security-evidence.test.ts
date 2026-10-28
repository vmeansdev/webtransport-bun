import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	findPrivacyViolations,
	REDACTED_VALUE,
	REPO_ROOT_PLACEHOLDER,
	sanitizeEvidenceDocument,
} from "../evidence-privacy.ts";
import EvidenceSanitizer from "../evidence-sanitizer.ts";
import {
	H7_TEST_TITLE,
	isInteropReport,
	verifyDocumentPrivacy,
	verifyEvidenceDocument,
	verifyH7PlaywrightReport,
	verifyInteropSchema,
} from "../verify-evidence.ts";
import {
	buildInteropWebServerCommand,
	buildInteropWebServerEnv,
	resolveBunExecutable,
} from "../web-server-env.ts";

/** A minimal interop report shell whose documented parts are already safe, so a
 * test can bury one unsafe value somewhere else and prove the walk reaches it. */
function interopReport(
	extra: Record<string, unknown>,
): Record<string, unknown> {
	return {
		config: {
			webServer: {
				env: {
					WT_IDLE_TIMEOUT_MS: "5000",
					WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
				},
			},
			...extra,
		},
	};
}

describe("interop evidence security boundary", () => {
	it("forwards only documented non-sensitive server settings", () => {
		const env = buildInteropWebServerEnv({
			HOME: "/Users/secret",
			LOKALISE_API_TOKEN: "secret-token",
			OLLAMA_API_KEY: "secret-key",
			SSH_AUTH_SOCK: "/tmp/ssh-agent",
			PATH: "/usr/bin",
			WT_IDLE_TIMEOUT_MS: "5000",
			WT_QPACK_MAX_TABLE_CAPACITY: "4096",
			WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
			WEBTRANSPORT_INTEROP_QUIC_PORT: "4433",
			WEBTRANSPORT_INTEROP_HEALTH_PORT: "4434",
		});

		expect(env).toEqual({
			WT_IDLE_TIMEOUT_MS: "5000",
			WT_QPACK_MAX_TABLE_CAPACITY: "4096",
			WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
			WEBTRANSPORT_INTEROP_QUIC_PORT: "4433",
			WEBTRANSPORT_INTEROP_HEALTH_PORT: "4434",
		});
	});

	// The server-env policy is duplicated on purpose: the launcher decides what
	// reaches the addon server, the verifier decides what may appear in
	// published evidence. A knob added to only one of them either never reaches
	// the server or gets the evidence rejected, so both halves are pinned here.
	it("forwards the H7 datagram batch knob to the interop server", () => {
		expect(
			buildInteropWebServerEnv({ WEBTRANSPORT_DATAGRAM_BATCH: "4" }),
		).toEqual({ WEBTRANSPORT_DATAGRAM_BATCH: "4" });
	});

	it("accepts the H7 datagram batch knob in published evidence", () => {
		expect(() =>
			verifyEvidenceDocument({
				config: { webServer: { env: { WEBTRANSPORT_DATAGRAM_BATCH: "4" } } },
			}),
		).not.toThrow();
	});

	it("drops an undocumented key at the launcher and rejects it in evidence", () => {
		expect(
			buildInteropWebServerEnv({ WEBTRANSPORT_DATAGRAM_BATCH_TURBO: "9" }),
		).toEqual({});
		expect(() =>
			verifyEvidenceDocument({
				config: {
					webServer: { env: { WEBTRANSPORT_DATAGRAM_BATCH_TURBO: "9" } },
				},
			}),
		).toThrow(/unexpected environment key/i);
	});

	it("uses the current Bun executable instead of PATH lookup", () => {
		const command = buildInteropWebServerCommand();
		expect(command).toContain(resolveBunExecutable());
		expect(command).not.toContain("bun run");
	});

	it("rejects inherited environment keys and host paths in evidence", () => {
		expect(() =>
			verifyEvidenceDocument({
				config: {
					webServer: {
						env: {
							HOME: "/Users/vmeansdev",
							LOKALISE_API_TOKEN: "secret-token",
							SSH_AUTH_SOCK: "/tmp/agent.sock",
						},
					},
				},
			}),
		).toThrow(/environment|credential|host path/i);
	});

	it("accepts evidence containing only the documented runtime environment", () => {
		expect(() =>
			verifyEvidenceDocument({
				config: {
					webServer: {
						env: {
							WT_IDLE_TIMEOUT_MS: "5000",
							WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
							WEBTRANSPORT_INTEROP_QUIC_PORT: "4433",
							WEBTRANSPORT_INTEROP_HEALTH_PORT: "4434",
						},
					},
				},
			}),
		).not.toThrow();
	});
});

describe("whole-document evidence privacy walk", () => {
	// Each case buries a host-identifying value OUTSIDE config.webServer.env,
	// which the environment-only scanner never looked at.
	const nestedHostPaths: ReadonlyArray<readonly [string, unknown]> = [
		["absolute POSIX rootDir", "/Users/vmeansdev/Developer/repo/tools/interop"],
		["Windows drive path", "C:\\Users\\maintainer\\repo\\tools\\interop"],
		["UNC share path", "\\\\build-host\\evidence\\interop"],
		["Linux home directory", "/home/maintainer/repo/tools/interop"],
		["macOS private temp", "/private/var/folders/kb/T/playwright-artifacts"],
		["temporary directory", "/tmp/pw-run-3/test-results"],
		["path embedded in a command", "cd /Users/vmeansdev/repo && bun run x.ts"],
		["tilde home reference", "output written to ~/Library/Logs/interop.log"],
	];

	for (const [label, value] of nestedHostPaths) {
		it(`rejects a ${label} nested outside config.webServer.env`, () => {
			const report = interopReport({
				projects: [
					{
						name: "chromium-webtransport",
						metadata: { attachments: [{ outputDir: value }] },
					},
				],
			});
			expect(() => verifyInteropSchema(report)).not.toThrow();
			expect(() => verifyEvidenceDocument(report)).toThrow(
				/privacy violation/i,
			);
		});
	}

	// Synthetic secret-shaped fixtures. Assembled from fragments at runtime so
	// no complete provider-pattern literal appears in source: these are fake
	// test vectors for the scanner, and a literal `xoxb-...`/`sk-...` string in
	// the committed diff would trip GitHub push protection (which cannot tell a
	// synthetic vector from a real leak). The scanner still receives the full
	// assembled value, so detection is exercised identically.
	const syn = (...parts: string[]): string => parts.join("");
	const nestedSecrets: ReadonlyArray<readonly [string, string, string]> = [
		["OpenAI-shaped token", "note", syn("sk-", "abcdefghijklmnopqrstuvwx")],
		[
			"GitHub token",
			"note",
			syn("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
		],
		["Slack token", "note", syn("xoxb", "-1234567890-", "abcdefghijklmno")],
		[
			"Google API key",
			"note",
			syn("AIza", "SyA1234567890abcdefghijklmnopqrstuv"),
		],
		[
			"JSON web token",
			"note",
			syn("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxIn0.", "c2lnbmF0dXJl"),
		],
		["PEM private key", "note", syn("-----BEGIN EC ", "PRIVATE KEY-----\nMHc")],
	];

	for (const [label, key, value] of nestedSecrets) {
		it(`rejects a ${label} nested outside config.webServer.env`, () => {
			const report = interopReport({
				metadata: { ci: { steps: [{ [key]: value }] } },
			});
			expect(() => verifyInteropSchema(report)).not.toThrow();
			expect(() => verifyEvidenceDocument(report)).toThrow(
				/privacy violation/i,
			);
		});
	}

	const nestedSecretKeys = [
		"LOKALISE_API_TOKEN",
		"OLLAMA_API_KEY",
		"SSH_AUTH_SOCK",
		"awsSecretAccessKey",
		"httpCredentials",
		"cookie",
	];

	for (const key of nestedSecretKeys) {
		it(`rejects the secret-shaped key ${key} nested outside config.webServer.env`, () => {
			const report = interopReport({ metadata: { runner: { [key]: "x" } } });
			expect(() => verifyInteropSchema(report)).not.toThrow();
			expect(() => verifyEvidenceDocument(report)).toThrow(
				/credential-shaped property name/i,
			);
		});
	}

	it("finds host paths inside deeply nested arrays", () => {
		const violations = findPrivacyViolations({
			suites: [{ specs: [{ tests: [{ results: [{ stdout: ["/tmp/x"] }] }] }] }],
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]?.pointer).toBe(
			"/suites/0/specs/0/tests/0/results/0/stdout/0",
		);
	});

	it("never echoes the rejected value in a diagnostic", () => {
		const secret = ["sk-", "abcdefghijklmnopqrstuvwx"].join("");
		const hostPath = ["/Users/", "synthetic/Developer/private-repo"].join("");
		let message = "";
		try {
			verifyDocumentPrivacy({ a: { b: secret }, c: [hostPath] });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/privacy violation/i);
		expect(message).not.toContain(secret);
		expect(message).not.toContain(hostPath);
		expect(message).not.toContain("vmeansdev");
		expect(message).toContain("/a/b");
		expect(message).toContain("/c/0");
	});

	it("withholds a property name that is itself a host path", () => {
		const violations = findPrivacyViolations({
			outputs: { "/Users/vmeansdev/artifact.json": 1 },
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]?.pointer).not.toContain("vmeansdev");
		expect(violations[0]?.reason).toMatch(/property name/i);
	});

	it("accepts the functional-readiness record shape without interop schema", () => {
		const record = {
			schemaVersion: 1,
			candidateCommit: "0".repeat(40),
			commands: ["bun test packages/webtransport/test"],
			platform: { os: "darwin", arch: "arm64" },
			endpoints: ["/", "/cert-hash", "/execution-identity"],
			startedAt: "2026-08-03T00:00:00.000Z",
		};
		expect(() => verifyDocumentPrivacy(record)).not.toThrow();
		expect(() => verifyInteropSchema(record)).toThrow(/missing config/);
		expect(isInteropReport(record)).toBe(false);
		expect(isInteropReport(interopReport({}))).toBe(true);
	});

	it("does not flag public URLs or relative paths", () => {
		expect(
			findPrivacyViolations({
				url: "https://example.test:4436/health",
				health: "http://127.0.0.1:4436",
				testDir: "./tests-wasm",
				testMatch: ["**/*.pw.ts"],
				command: "bun run wasm-server.ts",
			}),
		).toEqual([]);
	});
});

describe("H7 Playwright report verification", () => {
	type ResultFixture = { status: string };
	type TestFixture = { status: string; results: ResultFixture[] };
	type SpecFixture = { title: string; ok: boolean; tests: TestFixture[] };
	type SuiteFixture = {
		title: string;
		specs: SpecFixture[];
		suites?: SuiteFixture[];
	};
	type ReportFixture = {
		config: { webServer: { env: Record<string, string> } };
		errors: unknown[];
		stats?: {
			expected: number;
			skipped: number;
			unexpected: number;
			flaky: number;
		};
		suites: SuiteFixture[];
	};

	/** The shape Playwright's JSON reporter writes for a single passing case. */
	function h7Report(): ReportFixture {
		return {
			config: { webServer: { env: { WEBTRANSPORT_DATAGRAM_BATCH: "4" } } },
			errors: [],
			stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
			suites: [
				{
					title: "h7-datagram-batch.pw.ts",
					specs: [
						{
							title: H7_TEST_TITLE,
							ok: true,
							tests: [{ status: "expected", results: [{ status: "passed" }] }],
						},
					],
				},
			],
		};
	}

	type Mutate = (report: ReportFixture) => void;

	function mutated(mutate: Mutate): ReportFixture {
		const report = h7Report();
		mutate(report);
		return report;
	}

	/** Non-null accessors so a fixture typo fails loudly instead of silently
	 * mutating `undefined` into a passing "rejection". */
	function onlySuite(report: ReportFixture): SuiteFixture {
		const suite = report.suites[0];
		if (!suite) throw new Error("fixture lost its suite");
		return suite;
	}

	function onlySpec(report: ReportFixture): SpecFixture {
		const spec = onlySuite(report).specs[0];
		if (!spec) throw new Error("fixture lost its spec");
		return spec;
	}

	function onlyTest(report: ReportFixture): TestFixture {
		const entry = onlySpec(report).tests[0];
		if (!entry) throw new Error("fixture lost its test entry");
		return entry;
	}

	function onlyResult(report: ReportFixture): ResultFixture {
		const result = onlyTest(report).results[0];
		if (!result) throw new Error("fixture lost its result");
		return result;
	}

	it("accepts a report with exactly one passing H7 case", () => {
		expect(() => verifyH7PlaywrightReport(h7Report())).not.toThrow();
	});

	const rejections: ReadonlyArray<readonly [string, Mutate, RegExp]> = [
		// A structurally perfect report from a run that never crossed a batch
		// boundary still proves nothing, and it is the report most likely to be
		// presented by mistake: the generic interop suite runs the same case
		// without the knob and overwrites the same evidence filename.
		[
			"a run with the batch knob absent",
			(r) => {
				r.config.webServer.env = {};
			},
			/WEBTRANSPORT_DATAGRAM_BATCH/,
		],
		[
			"a run at the default batch of 64, which crosses no boundary",
			(r) => {
				r.config.webServer.env.WEBTRANSPORT_DATAGRAM_BATCH = "64";
			},
			/WEBTRANSPORT_DATAGRAM_BATCH/,
		],
		[
			"a report with no webServer env at all",
			(r) => Reflect.deleteProperty(r.config, "webServer"),
			/config\.webServer/,
		],
		[
			"a report with no suites array",
			(r) => Reflect.deleteProperty(r, "suites"),
			/suites/i,
		],
		[
			"a second discovered case in the same suite",
			(r) => onlySuite(r).specs.push({ ...onlySpec(r) }),
			/exactly one test case/i,
		],
		[
			"a second case hidden in a nested suite",
			(r) => {
				onlySuite(r).suites = [{ title: "inner", specs: [onlySpec(r)] }];
			},
			/exactly one test case/i,
		],
		[
			"zero discovered cases",
			(r) => {
				onlySuite(r).specs = [];
			},
			/exactly one test case/i,
		],
		[
			"a mismatched title",
			(r) => {
				onlySpec(r).title = "H7 batch=4 delivers something else";
			},
			/title/i,
		],
		[
			"a case with no test entry",
			(r) => {
				onlySpec(r).tests = [];
			},
			/exactly one executed/i,
		],
		[
			"a retried case with two results",
			(r) => onlyTest(r).results.push({ status: "passed" }),
			/exactly one executed/i,
		],
		[
			"a failed spec flag",
			(r) => {
				onlySpec(r).ok = false;
			},
			/\bok\b/i,
		],
		["reporter errors", (r) => (r.errors = [{ message: "boom" }]), /errors/i],
		[
			"a missing stats block",
			(r) => Reflect.deleteProperty(r, "stats"),
			/stats/i,
		],
		[
			"stats.expected other than one",
			(r) => {
				if (r.stats) r.stats.expected = 2;
			},
			/stats\.expected/i,
		],
		[
			"a skipped count",
			(r) => {
				if (r.stats) r.stats.skipped = 1;
			},
			/stats\.skipped/i,
		],
		[
			"an unexpected count",
			(r) => {
				if (r.stats) r.stats.unexpected = 1;
			},
			/stats\.unexpected/i,
		],
		[
			"a flaky count",
			(r) => {
				if (r.stats) r.stats.flaky = 1;
			},
			/stats\.flaky/i,
		],
	];

	for (const [label, mutate, pattern] of rejections) {
		it(`rejects ${label}`, () => {
			expect(() => verifyH7PlaywrightReport(mutated(mutate))).toThrow(pattern);
		});
	}

	// A suite-level skip surfaces as a non-`passed` result status rather than an
	// absent case, which is exactly why the reporter — not the source scan — is
	// the authoritative executed count.
	for (const status of ["skipped", "failed", "timedOut", "interrupted"]) {
		it(`rejects a result whose status is ${status}`, () => {
			expect(() =>
				verifyH7PlaywrightReport(
					mutated((r) => {
						onlyResult(r).status = status;
					}),
				),
			).toThrow(/result status/i);
		});
	}

	for (const status of ["skipped", "unexpected", "flaky"]) {
		it(`rejects a test entry whose status is ${status}`, () => {
			expect(() =>
				verifyH7PlaywrightReport(
					mutated((r) => {
						onlyTest(r).status = status;
					}),
				),
			).toThrow(/test status/i);
		});
	}
});

describe("H7 interop test source constraints", () => {
	const source = readFileSync(
		resolve(import.meta.dir, "h7-datagram-batch.pw.ts"),
		"utf8",
	);

	/** A bare `test(` call at any indentation. The preceding-character guard,
	 * rather than a column-zero anchor, is what excludes `test.beforeEach(` and
	 * friends — so nesting or indenting the declaration cannot hide it. */
	const DECLARATION = /(?<![.\w])test\(/;

	it("declares exactly one test, under the title the verifier enforces", () => {
		expect(source).toContain(H7_TEST_TITLE);
		expect(source.match(new RegExp(DECLARATION, "g")) ?? []).toHaveLength(1);
	});

	// The reporter verifier is the authoritative executed/skipped count; this
	// scan only stops the source from asking to be skipped in the first place.
	// `.only` is here for the opposite reason: it does not skip this case, it
	// silently deselects every other one in the run.
	for (const construct of [
		"test.skip",
		"test.fixme",
		"test.only",
		"test.describe.skip",
		"test.describe.fixme",
		"test.describe.only",
	]) {
		it(`never uses ${construct}`, () => {
			expect(source).not.toContain(construct);
		});
	}

	it("has no early return that could silence the assertions", () => {
		// Everything from the `test(` declaration onwards is the Playwright-side
		// case body, where a `return` — conditional or not — would end the run
		// before the expectations execute. The browser-side burst helper is
		// hoisted above that point precisely so it can still return its counters.
		const caseBody = source.slice(source.search(DECLARATION));
		expect(caseBody).not.toMatch(/\breturn\b/);
		expect(caseBody).toMatch(/\bexpect\(/);
	});
});

describe("evidence sanitization at the generation boundary", () => {
	const repoRoot = "/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun";

	it("rewrites repository paths and redacts foreign host paths", () => {
		const sanitized = sanitizeEvidenceDocument(
			{
				config: {
					rootDir: `${repoRoot}/tools/interop/tests-wasm`,
					webServer: { cwd: `${repoRoot}/tools/interop` },
					projects: [{ outputDir: "/private/var/folders/kb/T/pw" }],
				},
			},
			repoRoot,
		);

		expect(sanitized).toEqual({
			config: {
				rootDir: `${REPO_ROOT_PLACEHOLDER}/tools/interop/tests-wasm`,
				webServer: { cwd: `${REPO_ROOT_PLACEHOLDER}/tools/interop` },
				projects: [{ outputDir: REDACTED_VALUE }],
			},
		});
	});

	it("drops credential-shaped properties entirely", () => {
		const sanitized = sanitizeEvidenceDocument(
			{ env: { LOKALISE_API_TOKEN: "secret", WT_IDLE_TIMEOUT_MS: "5000" } },
			repoRoot,
		);
		expect(sanitized).toEqual({ env: { WT_IDLE_TIMEOUT_MS: "5000" } });
	});

	it("produces documents the validator accepts", () => {
		const raw = {
			config: {
				rootDir: `${repoRoot}/tools/interop`,
				webServer: {
					cwd: `${repoRoot}/tools/interop`,
					env: { WT_IDLE_TIMEOUT_MS: "5000" },
				},
			},
			suites: [{ file: "wasm.pw.ts", stdout: ["/tmp/leak"] }],
		};
		expect(() => verifyEvidenceDocument(raw)).toThrow(/privacy violation/i);
		expect(() =>
			verifyEvidenceDocument(sanitizeEvidenceDocument(raw, repoRoot)),
		).not.toThrow();
	});

	it("redacts the reporter output file the JSON reporter wrote", async () => {
		const outputFile = join(
			mkdtempSync(join(tmpdir(), "interop-evidence-")),
			"interop-evidence.json",
		);
		const actualRepoRoot = resolve(import.meta.dir, "..", "..", "..");
		writeFileSync(
			outputFile,
			JSON.stringify({
				config: {
					rootDir: `${actualRepoRoot}/tools/interop`,
					webServer: {
						cwd: `${actualRepoRoot}/tools/interop`,
						env: { WT_IDLE_TIMEOUT_MS: "5000" },
					},
					projects: [{ outputDir: "/private/var/folders/kb/T/pw" }],
				},
			}),
		);

		await new EvidenceSanitizer({ outputFile }).onExit();

		const rewritten = JSON.parse(readFileSync(outputFile, "utf8"));
		expect(() => verifyEvidenceDocument(rewritten)).not.toThrow();
		expect(rewritten.config.rootDir).toBe(
			`${REPO_ROOT_PLACEHOLDER}/tools/interop`,
		);
		expect(rewritten.config.projects[0].outputDir).toBe(REDACTED_VALUE);
	});
});
