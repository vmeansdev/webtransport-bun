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
	isInteropReport,
	verifyDocumentPrivacy,
	verifyEvidenceDocument,
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
