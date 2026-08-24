import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	ALL_F_SENTINEL_SHA256,
	ComparisonOutputPolicyError,
	checkPromotionQuarantine,
	EMPTY_SHA256,
	LEGACY_SYNTHETIC_COMPARISON_ID,
	LEGACY_SYNTHETIC_SOURCE_SHA,
	readOfficialComparisonFile,
	resolveOfficialComparisonOutputDir,
	resolveOfficialComparisonOutputFile,
	writeOfficialComparisonFile,
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

type SwappedParent = "candidate" | "campaign";

function prepareSwappedParent(
	cwd: string,
	parent: SwappedParent,
): {
	officialDir: string;
	outputFile: string;
	outsideDir: string;
	outsideFile: string;
	restore: () => void;
} {
	const canonicalCwd = realpathSync(cwd);
	const officialDir = resolve(
		canonicalCwd,
		OFFICIAL_ROOT,
		"candidate-1",
		"campaign-1",
	);
	mkdirSync(officialDir, { recursive: true });
	const outputFile = resolveOfficialComparisonOutputFile({
		cwd: canonicalCwd,
		candidate: "candidate-1",
		campaignId: "campaign-1",
		outputDir: officialDir,
		outputFile: join(officialDir, "artifact.json"),
	} as never);
	const outsideRoot = mkdtempSync(join(tmpdir(), "wt-output-race-outside-"));
	const outsideDir = outsideRoot;
	const outsideFile =
		parent === "candidate"
			? join(outsideRoot, "campaign-1", "artifact.json")
			: join(outsideRoot, "artifact.json");
	mkdirSync(resolve(outsideFile, ".."), { recursive: true });
	const parentPath =
		parent === "candidate" ? resolve(officialDir, "..") : officialDir;
	const backupPath = `${parentPath}.real`;
	renameSync(parentPath, backupPath);
	symlinkSync(outsideDir, parentPath, "dir");

	return {
		officialDir,
		outputFile,
		outsideDir,
		outsideFile,
		restore: () => {
			try {
				unlinkSync(parentPath);
			} catch {}
			renameSync(backupPath, parentPath);
			rmSync(outsideRoot, { recursive: true, force: true });
		},
	};
}

function expectTrustBoundaryUnavailable(operation: () => unknown): void {
	let error: unknown;
	try {
		operation();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ComparisonOutputPolicyError);
	expect((error as ComparisonOutputPolicyError).code).toBe(
		"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE",
	);
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
	test.each([
		"candidate",
		"campaign",
	] as const)("rejects an intermediate %s parent swap before an official read", (parent) => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-read-parent-race-"));
		let swapped: ReturnType<typeof prepareSwappedParent> | undefined;
		try {
			const officialDir = resolve(
				cwd,
				OFFICIAL_ROOT,
				"candidate-1",
				"campaign-1",
			);
			mkdirSync(officialDir, { recursive: true });
			const insideFile = join(officialDir, "artifact.json");
			writeFileSync(insideFile, "inside");
			swapped = prepareSwappedParent(cwd, parent);
			writeFileSync(swapped.outsideFile, "outside");

			expectTrustBoundaryUnavailable(() =>
				readOfficialComparisonFile(swapped?.outputFile ?? insideFile),
			);
		} finally {
			swapped?.restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test.each([
		"candidate",
		"campaign",
	] as const)("rejects an intermediate %s parent swap before official publication", (parent) => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-write-parent-race-"));
		let swapped: ReturnType<typeof prepareSwappedParent> | undefined;
		try {
			swapped = prepareSwappedParent(cwd, parent);
			expectTrustBoundaryUnavailable(() =>
				writeOfficialComparisonFile(swapped?.outputFile ?? "", "report"),
			);
			expect(existsSync(swapped.outsideFile)).toBe(false);
		} finally {
			swapped?.restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("refuses official report generation until R1 trust is staged", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-report-artifact-"));
		const previousCwd = process.cwd();
		const previousCandidate = process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
		const previousCampaign = process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
		try {
			process.chdir(cwd);
			process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = "candidate-1";
			process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = "campaign-1";
			expectTrustBoundaryUnavailable(() => generateReport());
		} finally {
			process.chdir(previousCwd);
			if (previousCandidate === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
			else process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = previousCandidate;
			if (previousCampaign === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
			else process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = previousCampaign;
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("refuses official report publication until R1 trust is staged", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wt-report-race-"));
		const previousCwd = process.cwd();
		const previousCandidate = process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
		const previousCampaign = process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
		try {
			process.chdir(cwd);
			process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = "candidate-1";
			process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = "campaign-1";
			expectTrustBoundaryUnavailable(() => generateReport());
		} finally {
			process.chdir(previousCwd);
			if (previousCandidate === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CANDIDATE;
			else process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = previousCandidate;
			if (previousCampaign === undefined)
				delete process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN;
			else process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = previousCampaign;
			rmSync(cwd, { recursive: true, force: true });
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
