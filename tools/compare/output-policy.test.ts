import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	ALL_F_SENTINEL_SHA256,
	checkPromotionQuarantine,
	EMPTY_SHA256,
	LEGACY_SYNTHETIC_COMPARISON_ID,
	LEGACY_SYNTHETIC_SOURCE_SHA,
	resolveOfficialComparisonOutputDir,
	resolveOfficialComparisonOutputFile,
} from "./output-policy.ts";
import { generateReport } from "./render-report.ts";

const OFFICIAL_ROOT = ".release-evidence/transport-comparison";

function validOutput(cwd: string): string {
	return resolve(cwd, OFFICIAL_ROOT, "candidate-1", "campaign-1");
}

function validEvidence() {
	return {
		artifactKind: "measured",
		promotable: true,
		comparisonId: "comparison-live",
		source: {
			sourceSha: "1".repeat(40),
			executableSha256: "2".repeat(64),
			toolchain: { sha256: "3".repeat(64) },
		},
		rawSidecarDigests: {
			client: "4".repeat(64),
			server: "5".repeat(64),
			topology: "6".repeat(64),
			impairment: "7".repeat(64),
			cleanup: "8".repeat(64),
		},
	};
}

describe("comparison output path quarantine", () => {
	test("resolves the official output directory and accepts its explicit alias", () => {
		const cwd = "/private/tmp/ws-wt-policy";
		const expected = validOutput(cwd);

		expect(
			resolveOfficialComparisonOutputDir({
				cwd,
				candidate: "candidate-1",
				campaignId: "campaign-1",
			} as never),
		).toBe(expected);
		expect(
			resolveOfficialComparisonOutputDir({
				cwd,
				candidate: "candidate-1",
				campaignId: "campaign-1",
				outputDir: join(OFFICIAL_ROOT, "candidate-1", "campaign-1"),
			} as never),
		).toBe(expected);
	});

	test.each([
		"./evidence",
		"evidence",
		"/tmp/evidence",
		"./results",
		"../.release-evidence/transport-comparison/candidate-1/campaign-1",
		".release-evidence/transport-comparison/candidate-1/../escape",
		".release-evidence/transport-comparison/./candidate-1/campaign-1",
	])("rejects legacy, escaped, and aliased output path %s", (outputDir) => {
		expect(() =>
			resolveOfficialComparisonOutputDir({
				cwd: "/tmp/ws-wt-policy",
				candidate: "candidate-1",
				campaignId: "campaign-1",
				outputDir,
			} as never),
		).toThrow();
	});

	test.each([
		["", "campaign-1"],
		["candidate-1", ""],
		["../escape", "campaign-1"],
		["candidate-1", "../escape"],
		["candidate/escape", "campaign-1"],
		["candidate-1", "campaign/escape"],
	])("rejects unsafe candidate/campaign pair %j", (candidate, campaignId) => {
		expect(() =>
			resolveOfficialComparisonOutputDir({
				cwd: "/private/tmp/ws-wt-policy",
				candidate,
				campaignId,
			} as never),
		).toThrow();
	});

	test.each([
		["candidate:1", "campaign-1"],
		["candidate-1", "campaign:1"],
		["CON", "campaign-1"],
		["candidate-1", "NUL.txt"],
		["candidate.", "campaign-1"],
		["candidate-1", "campaign-1 "],
	])("rejects cross-platform identity syntax %j", (candidate, campaignId) => {
		expect(() =>
			resolveOfficialComparisonOutputDir({
				cwd: "/private/tmp/ws-wt-policy",
				candidate,
				campaignId,
			} as never),
		).toThrow();
	});

	test("accepts a valid Windows official path with injected win32 handling", () => {
		const expected =
			"C:\\repo\\.release-evidence\\transport-comparison\\candidate-1\\campaign-1";
		const resolved = resolveOfficialComparisonOutputDir({
			cwd: "C:\\repo",
			candidate: "candidate-1",
			campaignId: "campaign-1",
			outputDir: expected,
			platform: "win32",
		} as never);

		expect(resolved).toBe(expected);
	});

	test.each([
		"NUL",
		"NUL.txt",
		"CON",
		"CON.txt",
		"comparison-report.md::$DATA",
	])("rejects a Win32-reserved or ADS report leaf %s", (leaf) => {
		const officialDir =
			"C:\\repo\\.release-evidence\\transport-comparison\\candidate-1\\campaign-1";
		expect(() =>
			resolveOfficialComparisonOutputFile({
				cwd: "C:\\repo",
				candidate: "candidate-1",
				campaignId: "campaign-1",
				outputDir: officialDir,
				outputFile: `${officialDir}\\${leaf}`,
				platform: "win32",
			} as never),
		).toThrow();
	});

	test("rejects an existing symlink component instead of following it", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-output-policy-"));
		try {
			const outside = mkdtempSync(join(tmpdir(), "wt-output-policy-outside-"));
			mkdirSync(join(cwd, ".release-evidence"), { recursive: true });
			rmSync(join(cwd, ".release-evidence"), { recursive: true, force: true });
			symlinkSync(outside, join(cwd, ".release-evidence"), "dir");

			expect(() =>
				resolveOfficialComparisonOutputDir({
					cwd,
					candidate: "candidate-1",
					campaignId: "campaign-1",
				} as never),
			).toThrow();
			rmSync(outside, { recursive: true, force: true });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("promotion quarantine", () => {
	test("requires an external trust bound even for otherwise complete evidence", () => {
		const result = checkPromotionQuarantine({
			artifact: validEvidence(),
		});

		expect(result.promotable).toBe(false);
		expect(result.reasons.map(({ code }) => code)).toContain(
			"EXTERNAL_TRUST_BOUND_MISSING",
		);
	});

	test.each([
		[
			"legacy synthetic campaign",
			{ comparisonId: LEGACY_SYNTHETIC_COMPARISON_ID },
		],
		[
			"legacy synthetic source",
			{
				source: {
					...validEvidence().source,
					sourceSha: LEGACY_SYNTHETIC_SOURCE_SHA,
				},
			},
		],
		[
			"empty executable digest",
			{ source: { ...validEvidence().source, executableSha256: EMPTY_SHA256 } },
		],
		[
			"empty toolchain digest",
			{
				source: {
					...validEvidence().source,
					toolchain: { sha256: EMPTY_SHA256 },
				},
			},
		],
		[
			"sentinel sidecar digest",
			{
				rawSidecarDigests: {
					...validEvidence().rawSidecarDigests,
					client: ALL_F_SENTINEL_SHA256,
				},
			},
		],
	] as const)("quarantines %s", (_label, changes) => {
		const artifact = { ...validEvidence(), ...changes };
		const result = checkPromotionQuarantine({
			artifact,
			externalTrustBound: "trust-bound-1",
		});

		expect(result.promotable).toBe(false);
	});

	test("does not treat an arbitrary non-empty trust marker as validated", () => {
		const result = checkPromotionQuarantine({
			artifact: validEvidence(),
			externalTrustBound: "trust-bound-1",
		});

		expect(result.promotable).toBe(false);
	});

	test("rejects an artifact whose comparison ID is from another campaign", () => {
		const result = checkPromotionQuarantine({
			artifact: { ...validEvidence(), comparisonId: "campaign-2" },
			externalTrustBound: "trust-bound-1",
			expectedComparisonId: "campaign-1",
		} as never);

		expect(result.promotable).toBe(false);
	});
});

describe("comparison publication containment", () => {
	test("refuses to read a symlinked artifact leaf", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-report-artifact-"));
		const outside = mkdtempSync(join(tmpdir(), "wt-report-artifact-outside-"));
		const previousCwd = process.cwd();
		const previousCandidate = process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
		const previousCampaign = process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
		const previousTrust =
			process.env.WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND;
		try {
			process.chdir(cwd);
			process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = "candidate-1";
			process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = "campaign-1";
			process.env.WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND =
				"trust-bound-1";
			const officialDir = resolve(
				cwd,
				OFFICIAL_ROOT,
				"candidate-1",
				"campaign-1",
			);
			mkdirSync(officialDir, { recursive: true });
			const outsideArtifact = join(outside, "artifact.json");
			writeFileSync(outsideArtifact, JSON.stringify(validEvidence()));
			symlinkSync(
				outsideArtifact,
				join(officialDir, "chat-fanout_subscribers-1000-ws.json"),
			);

			expect(() => generateReport()).toThrow(/symbolic link|symlink|artifact/i);
		} finally {
			process.chdir(previousCwd);
			if (previousCandidate === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
			else process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = previousCandidate;
			if (previousCampaign === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
			else process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = previousCampaign;
			if (previousTrust === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND;
			else
				process.env.WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND =
					previousTrust;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("fails closed when the report leaf is swapped after validation", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-report-race-"));
		const outside = mkdtempSync(join(tmpdir(), "wt-report-race-outside-"));
		const previousCwd = process.cwd();
		const previousCandidate = process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
		const previousCampaign = process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
		const trustKey = "WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND";
		const previousTrustDescriptor = Object.getOwnPropertyDescriptor(
			process.env,
			trustKey,
		);
		try {
			process.chdir(cwd);
			process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = "candidate-1";
			process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = "campaign-1";
			const officialDir = resolve(
				cwd,
				OFFICIAL_ROOT,
				"candidate-1",
				"campaign-1",
			);
			mkdirSync(officialDir, { recursive: true });
			const resolvedCwd = process.cwd();
			const reportPath = resolveOfficialComparisonOutputFile({
				cwd: resolvedCwd,
				candidate: "candidate-1",
				campaignId: "campaign-1",
			});
			const escapedReport = join(outside, "escaped-report.md");
			Object.defineProperty(process.env, trustKey, {
				configurable: true,
				get() {
					symlinkSync(escapedReport, reportPath);
					return "trust-bound-1";
				},
			});

			expect(() => generateReport()).toThrow(/symbolic link|symlink|output/i);
			expect(existsSync(escapedReport)).toBe(false);
		} finally {
			process.chdir(previousCwd);
			if (previousCandidate === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
			else process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = previousCandidate;
			if (previousCampaign === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
			else process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = previousCampaign;
			if (previousTrustDescriptor)
				Object.defineProperty(process.env, trustKey, previousTrustDescriptor);
			else delete process.env[trustKey];
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("authoritative comparison documentation", () => {
	test("documents only the official candidate/campaign output layout", () => {
		const docs = readFileSync(
			resolve(import.meta.dir, "../../docs/TRANSPORT_COMPARISON.md"),
			"utf8",
		);

		expect(docs).not.toContain("./evidence");
		expect(docs).not.toContain("--artifact");
		expect(docs).not.toContain("--input-dir");
		expect(docs).toContain(
			".release-evidence/transport-comparison/<candidate>/<campaign-id>",
		);
		expect(docs).toContain("--candidate <candidate>");
		expect(docs).toContain("--campaign-id <campaign-id>");
	});
});
