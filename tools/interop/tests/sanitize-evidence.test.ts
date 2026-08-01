import { describe, expect, it } from "bun:test";
import { sanitizeEvidenceDocument } from "../sanitize-evidence.ts";
import {
	verifyEvidenceDocument,
	verifyInteropEvidenceDocument,
} from "../verify-evidence.ts";

describe("interop evidence generation boundary", () => {
	it("removes Playwright host paths before the privacy validator sees the report", () => {
		const hostRoot = "/Users/private-user/webtransport-bun/tools/interop";
		const document = {
			config: {
				configFile: `${hostRoot}/playwright.config.ts`,
				rootDir: `${hostRoot}/tests`,
				projects: [
					{
						outputDir: `${hostRoot}/test-results`,
						testDir: `${hostRoot}/tests`,
					},
				],
				webServer: {
					command: `'/opt/homebrew/bin/bun' run addon-server.ts`,
					cwd: hostRoot,
					env: { WT_IDLE_TIMEOUT_MS: "5000" },
				},
			},
			suites: [],
		};

		const sanitized = sanitizeEvidenceDocument(document);
		const serialized = JSON.stringify(sanitized);
		expect(serialized).not.toContain(hostRoot);
		expect(serialized).not.toContain("/opt/homebrew/bin/bun");
		expect(sanitized.config.configFile).toBe("playwright.config.ts");
		expect(sanitized.config.rootDir).toBe("tests");
		expect(sanitized.config.projects[0].outputDir).toBe("test-results");
		expect(sanitized.config.webServer.cwd).toBe(".");
		expect(sanitized.config.webServer.command).toBe("bun run addon-server.ts");
		verifyEvidenceDocument(sanitized);
		verifyInteropEvidenceDocument(sanitized);
	});

	it("redacts embedded paths in command arrays and diagnostics", () => {
		const hostRoot = "/Users/private-user/webtransport-bun/tools/fuzz";
		const document = {
			command: [
				"rustup",
				"run",
				"1.95.0",
				`${hostRoot}/corpora/h3`,
				`-artifact_prefix=/private/var/folders/private-user/crashes/`,
			],
			stdout: `cargo-fuzz wrote diagnostics under ${hostRoot}/target`,
			stderr: `linker failed in /opt/homebrew/opt/llvm/bin/clang`,
		};

		const sanitized = sanitizeEvidenceDocument(document);
		const serialized = JSON.stringify(sanitized);
		expect(serialized).not.toContain(hostRoot);
		expect(serialized).not.toContain("/private/var/folders");
		expect(serialized).not.toContain("/opt/homebrew/opt/llvm");
		expect(sanitized.command[3]).toBe("<redacted>");
		expect(sanitized.command[4]).toBe("-artifact_prefix=<redacted>");
		verifyEvidenceDocument(sanitized);
	});
});
