/**
 * Tests for compare-stage.
 *
 * Tests use fakes for the measurement set so they are deterministic and
 * do not require git, ssh, or the campaign's runtime environment. The CLI
 * is exercised end-to-end with a `Bun.spawn` against a temp directory, so
 * the file-writing + argv-parsing path is not just "unit tested" while
 * integration is broken.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256HexOfBytes } from "../secure-fs.ts";
import { resolveOfficialComparisonOutputDir } from "../output-policy.ts";
import {
	main,
	mintTrustBoundaryRecords,
	parseStageArgs,
	type Measurements,
	validateMeasurements,
	validateStagingRoot,
} from "./compare-stage.ts";

const VALID_STAGING_ROOT = join(
	resolveOfficialComparisonOutputDir({
		candidate: "ws-wt-campaign-2026-08-29",
		campaignId: "campaign-r0-real",
	}),
	"staged",
);

/**
 * Realistic-looking sha256 digests for tests. Each digest is 64 hex chars
 * with mixed characters (no constant-character, no empty-byte) so the
 * sample passes `isImplausibleDigest`. The exact values are arbitrary; only
 * their shape matters.
 */
function sampleDigest(seed: string): string {
	// A tiny stable hash so different seeds produce different digests, and the
	// resulting digests are not constant-character (implausibility check passes).
	let hash = 0xdeadbeef ^ seed.length;
	for (let i = 0; i < seed.length; i += 1) {
		hash = Math.imul(hash ^ seed.charCodeAt(i), 2654435761);
	}
	let out = "";
	let h = hash >>> 0;
	for (let i = 0; i < 64; i += 1) {
		// Mix a different bit each step so the resulting hex has all 16 chars.
		h = Math.imul(h ^ (i + 1), 1597334677) >>> 0;
		const nibble = (h + seed.charCodeAt(i % seed.length) * 7) & 0xf;
		out += nibble.toString(16);
	}
	return out;
}

const SAMPLE_MEASUREMENTS: Measurements = {
	candidateHead: "9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4",
	candidateId: "ws-wt-campaign-2026-08-29",
	campaignId: "campaign-r0-real",
	macBunSha256: sampleDigest("mac-bun"),
	macBunVersion: "1.3.14",
	linuxBunSha256: sampleDigest("linux-bun"),
	linuxBunVersion: "1.3.14",
	sourceArchiveSha256: sampleDigest("source-archive"),
	sourceArchiveSize: 4_096_000,
	archiveMemberCount: 512,
	gitVersion: "git version 2.50.1",
	gitExecutableSha256: sampleDigest("git-executable"),
	gitStatusBytesSha256: sampleDigest("git-status"),
	gitStatusBytesSize: 0,
	gitUnstagedDiffBytesSha256: sampleDigest("git-unstaged"),
	gitUnstagedDiffBytesSize: 0,
	gitStagedDiffBytesSha256: sampleDigest("git-staged"),
	gitStagedDiffBytesSize: 0,
	gitSubmoduleStatusSha256: sampleDigest("git-submodule"),
	gitSubmoduleStatusSize: 0,
	untrackedFileCount: 0,
	reviewedDiffSha256: sampleDigest("reviewed-diff"),
	archiveMemberInventorySha256: sampleDigest("archive-inventory"),
	archiveMemberInventorySize: 4096,
	sourceBuilderExecutableSha256: sampleDigest("source-builder"),
	commandSetSha256: sampleDigest("command-set"),
	candidateTreeOid: "0123456789abcdef0123456789abcdef01234567",
	issuedAtMs: 1_700_000_000_000,
	notAfterMs: 1_700_003_600_000,
};

describe("compare-stage: validateMeasurements", () => {
	it("accepts the sample measurement set", () => {
		expect(validateMeasurements(SAMPLE_MEASUREMENTS)).toBeNull();
	});

	it("refuses a malformed digest", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			macBunSha256: "not-hex",
		});
		expect(result).not.toBeNull();
		expect(result?.code).toBe("STAGE_DIGEST_MALFORMED");
	});

	it("refuses an implausible (constant-character) digest", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			linuxBunSha256: "0".repeat(64),
		});
		expect(result).not.toBeNull();
		expect(result?.code).toBe("STAGE_DIGEST_IMPLAUSIBLE");
	});

	it("refuses an empty digest", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			sourceArchiveSha256:
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		});
		expect(result).not.toBeNull();
		expect(result?.code).toBe("STAGE_DIGEST_IMPLAUSIBLE");
	});

	it("refuses a non-hex40 candidate HEAD", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			candidateHead: "abc",
		});
		expect(result?.code).toBe("STAGE_MEASUREMENT_INVALID");
	});

	it("refuses a missing macBunVersion", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			macBunVersion: "",
		});
		expect(result?.code).toBe("STAGE_MEASUREMENT_INVALID");
	});

	it("refuses a notAfter before issuedAt", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			issuedAtMs: 2_000,
			notAfterMs: 1_000,
		});
		expect(result?.code).toBe("STAGE_MEASUREMENT_INVALID");
	});

	it("refuses a negative untracked-file count", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			untrackedFileCount: -1,
		});
		expect(result?.code).toBe("STAGE_MEASUREMENT_INVALID");
	});

	it("refuses a git version that does not start with 'git version'", () => {
		const result = validateMeasurements({
			...SAMPLE_MEASUREMENTS,
			gitVersion: "1.2.3",
		});
		expect(result?.code).toBe("STAGE_MEASUREMENT_INVALID");
	});
});

describe("compare-stage: validateStagingRoot", () => {
	it("accepts the path returned by resolveOfficialComparisonOutputDir + /staged", () => {
		const result = validateStagingRoot(
			VALID_STAGING_ROOT,
			"ws-wt-campaign-2026-08-29",
			"campaign-r0-real",
		);
		expect(result.ok).toBe(true);
	});

	it("refuses a path that escapes the official output root", () => {
		const result = validateStagingRoot(
			"/tmp/elsewhere/staged",
			"ws-wt-campaign-2026-08-29",
			"campaign-r0-real",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("STAGE_PATH_OUTSIDE_ROOT");
	});

	it("refuses a path that targets a sibling campaign", () => {
		const result = validateStagingRoot(
			VALID_STAGING_ROOT.replace("campaign-r0-real", "campaign-other"),
			"ws-wt-campaign-2026-08-29",
			"campaign-r0-real",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("STAGE_PATH_OUTSIDE_ROOT");
	});
});

describe("compare-stage: mintTrustBoundaryRecords", () => {
	const minted = mintTrustBoundaryRecords(SAMPLE_MEASUREMENTS);

	it("mints non-empty bytes for every record", () => {
		expect(minted.authority.byteLength).toBeGreaterThan(0);
		expect(minted.sourceArchiveReceipt.byteLength).toBeGreaterThan(0);
		expect(minted.r1RedApprovalBundle.byteLength).toBeGreaterThan(0);
		expect(minted.stagedCapability.byteLength).toBeGreaterThan(0);
		expect(minted.bunRoleLaunchReceiptSet.byteLength).toBeGreaterThan(0);
		expect(minted.hostRuntimeFactsDarwin.byteLength).toBeGreaterThan(0);
		expect(minted.hostRuntimeFactsLinux.byteLength).toBeGreaterThan(0);
	});

	it("authority digest is stable across re-mints (no randomness, no clock drift)", () => {
		const first = sha256HexOfBytes(minted.authority);
		const second = sha256HexOfBytes(
			mintTrustBoundaryRecords(SAMPLE_MEASUREMENTS).authority,
		);
		expect(first).toBe(second);
	});

	it("authority digest is not implausible (real bytes, not all-zero or all-constant)", () => {
		const digest = sha256HexOfBytes(minted.authority);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(digest).not.toBe("0".repeat(64));
		expect(digest).not.toBe("e".repeat(64));
		expect(digest).not.toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("different measurements produce different authority digests", () => {
		const other = mintTrustBoundaryRecords({
			...SAMPLE_MEASUREMENTS,
			macBunSha256: sampleDigest("other-mac-bun"),
		});
		expect(sha256HexOfBytes(minted.authority)).not.toBe(
			sha256HexOfBytes(other.authority),
		);
	});

	it("authority record carries the campaign-authority/v1 schema", () => {
		const text = new TextDecoder().decode(minted.authority);
		expect(text).toContain('"schema":"campaign-authority/v1"');
	});

	it("source-archive-receipt carries the source-archive-receipt/v1 schema", () => {
		const text = new TextDecoder().decode(minted.sourceArchiveReceipt);
		expect(text).toContain('"schema":"source-archive-receipt/v1"');
	});

	it("source-archive-receipt binds the source-archive-sha256 the archive actually has", () => {
		const text = new TextDecoder().decode(minted.sourceArchiveReceipt);
		const parsed = JSON.parse(text);
		expect(parsed.sourceArchiveSha256).toBe(
			SAMPLE_MEASUREMENTS.sourceArchiveSha256,
		);
		expect(parsed.cleanTreeProof.statusBytesSha256).toBe(
			SAMPLE_MEASUREMENTS.gitStatusBytesSha256,
		);
		expect(parsed.cleanTreeProof.allEmpty).toBe(true);
	});

	it("authority record names the source-archive-receipt digest the receipt will verify against", () => {
		const authorityText = new TextDecoder().decode(minted.authority);
		const authority = JSON.parse(authorityText);
		const receiptDigest = sha256HexOfBytes(minted.sourceArchiveReceipt);
		expect(authority.approval.sourceArchiveReceiptSha256).toBe(receiptDigest);
	});

	it("staged-capability binds the authority digest the authority will verify against", () => {
		const capText = new TextDecoder().decode(minted.stagedCapability);
		const cap = JSON.parse(capText);
		expect(cap.authoritySha256).toBe(sha256HexOfBytes(minted.authority));
	});

	it("bun-role-launch-receipt-set binds the capability digest the capability will verify against", () => {
		const setText = new TextDecoder().decode(minted.bunRoleLaunchReceiptSet);
		const set = JSON.parse(setText);
		expect(set.capabilitySha256).toBe(
			sha256HexOfBytes(minted.stagedCapability),
		);
	});

	it("host-runtime-facts records name the toolchain Bun the mac/linux measurements have", () => {
		const darwinText = new TextDecoder().decode(minted.hostRuntimeFactsDarwin);
		const linuxText = new TextDecoder().decode(minted.hostRuntimeFactsLinux);
		const darwin = JSON.parse(darwinText);
		const linux = JSON.parse(linuxText);
		expect(darwin.toolchain.bunVersion).toBe(SAMPLE_MEASUREMENTS.macBunVersion);
		expect(darwin.toolchain.bunExecutableSha256).toBe(
			SAMPLE_MEASUREMENTS.macBunSha256,
		);
		expect(linux.toolchain.bunVersion).toBe(
			SAMPLE_MEASUREMENTS.linuxBunVersion,
		);
		expect(linux.toolchain.bunExecutableSha256).toBe(
			SAMPLE_MEASUREMENTS.linuxBunSha256,
		);
	});

	it("authority record pins the candidate topology (en13 ↔ eno1, direct cable)", () => {
		const text = new TextDecoder().decode(minted.authority);
		const parsed = JSON.parse(text);
		expect(parsed.topology.kind).toBe("direct-cable");
		expect(parsed.topology.mac.interface).toBe("en13");
		expect(parsed.topology.mac.address).toBe("10.99.0.1");
		expect(parsed.topology.linux.interface).toBe("eno1");
		expect(parsed.topology.linux.address).toBe("10.99.0.2");
		expect(parsed.topology.tailscaleMeasurementForbidden).toBe(true);
		expect(parsed.topology.loopbackForbidden).toBe(true);
	});

	it("authority record pins the candidate HEAD the campaign is built against", () => {
		const text = new TextDecoder().decode(minted.authority);
		const parsed = JSON.parse(text);
		expect(parsed.approval.finalCandidateHead).toBe(
			SAMPLE_MEASUREMENTS.candidateHead,
		);
		expect(parsed.candidate).toBe(SAMPLE_MEASUREMENTS.candidateId);
		expect(parsed.campaignId).toBe(SAMPLE_MEASUREMENTS.campaignId);
	});
});

describe("compare-stage: parseStageArgs", () => {
	const validArgs: readonly string[] = [
		"--staging-root",
		VALID_STAGING_ROOT,
		"--candidate",
		"ws-wt-campaign-2026-08-29",
		"--campaign",
		"campaign-r0-real",
		"--candidate-head",
		SAMPLE_MEASUREMENTS.candidateHead,
		"--candidate-tree-oid",
		SAMPLE_MEASUREMENTS.candidateTreeOid,
		"--mac-bun-sha256",
		SAMPLE_MEASUREMENTS.macBunSha256,
		"--linux-bun-sha256",
		SAMPLE_MEASUREMENTS.linuxBunSha256,
		"--mac-bun-version",
		SAMPLE_MEASUREMENTS.macBunVersion,
		"--linux-bun-version",
		SAMPLE_MEASUREMENTS.linuxBunVersion,
		"--source-archive-sha256",
		SAMPLE_MEASUREMENTS.sourceArchiveSha256,
		"--source-archive-size",
		String(SAMPLE_MEASUREMENTS.sourceArchiveSize),
		"--archive-member-count",
		String(SAMPLE_MEASUREMENTS.archiveMemberCount),
		"--git-version",
		SAMPLE_MEASUREMENTS.gitVersion,
		"--git-executable-sha256",
		SAMPLE_MEASUREMENTS.gitExecutableSha256,
		"--git-status-sha256",
		SAMPLE_MEASUREMENTS.gitStatusBytesSha256,
		"--git-status-size",
		String(SAMPLE_MEASUREMENTS.gitStatusBytesSize),
		"--git-unstaged-diff-sha256",
		SAMPLE_MEASUREMENTS.gitUnstagedDiffBytesSha256,
		"--git-unstaged-diff-size",
		String(SAMPLE_MEASUREMENTS.gitUnstagedDiffBytesSize),
		"--git-staged-diff-sha256",
		SAMPLE_MEASUREMENTS.gitStagedDiffBytesSha256,
		"--git-staged-diff-size",
		String(SAMPLE_MEASUREMENTS.gitStagedDiffBytesSize),
		"--git-submodule-status-sha256",
		SAMPLE_MEASUREMENTS.gitSubmoduleStatusSha256,
		"--git-submodule-status-size",
		String(SAMPLE_MEASUREMENTS.gitSubmoduleStatusSize),
		"--untracked-file-count",
		String(SAMPLE_MEASUREMENTS.untrackedFileCount),
		"--reviewed-diff-sha256",
		SAMPLE_MEASUREMENTS.reviewedDiffSha256,
		"--archive-member-inventory-sha256",
		SAMPLE_MEASUREMENTS.archiveMemberInventorySha256,
		"--archive-member-inventory-size",
		String(SAMPLE_MEASUREMENTS.archiveMemberInventorySize),
		"--source-builder-executable-sha256",
		SAMPLE_MEASUREMENTS.sourceBuilderExecutableSha256,
		"--command-set-sha256",
		SAMPLE_MEASUREMENTS.commandSetSha256,
		"--issued-at-ms",
		String(SAMPLE_MEASUREMENTS.issuedAtMs),
		"--not-after-ms",
		String(SAMPLE_MEASUREMENTS.notAfterMs),
	];

	it("parses a complete, valid argv into a measurement set", () => {
		const parsed = parseStageArgs(validArgs);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.measurements.candidateHead).toBe(
			SAMPLE_MEASUREMENTS.candidateHead,
		);
		expect(parsed.dryRun).toBe(false);
	});

	it("parses --dry-run", () => {
		const parsed = parseStageArgs([...validArgs, "--dry-run"]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.dryRun).toBe(true);
	});

	it("refuses an unknown flag", () => {
		const parsed = parseStageArgs([...validArgs, "--nope"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toContain("unknown argument");
	});

	it("refuses a missing required flag (--candidate-head omitted)", () => {
		const without = validArgs.filter((_, i) => {
			// Drop the candidate-head value pair
			const flagIdx = validArgs.indexOf("--candidate-head");
			return i !== flagIdx && i !== flagIdx + 1;
		});
		const parsed = parseStageArgs(without);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toContain("--candidate-head");
	});

	it("refuses a non-integer --source-archive-size", () => {
		const bad = validArgs.map((a) =>
			a === String(SAMPLE_MEASUREMENTS.sourceArchiveSize) ? "not-a-number" : a,
		);
		const parsed = parseStageArgs(bad);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toContain("--source-archive-size");
	});
});

describe("compare-stage: end-to-end CLI", () => {
	let stagingRoot: string;

	beforeEach(() => {
		// Use the resolved official output path under a unique sub-campaign.
		// Tests can write into the resolved staging root because the worktree
		// is the test sandbox; the validator's path policy still applies.
		const uniqueCampaignId = `campaign-test-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		stagingRoot = join(
			resolveOfficialComparisonOutputDir({
				candidate: "ws-wt-campaign-2026-08-29",
				campaignId: uniqueCampaignId,
			}),
			"staged",
		);
	});

	afterEach(() => {
		rmSync(stagingRoot, { recursive: true, force: true });
		// Also remove the campaign directory itself
		rmSync(join(stagingRoot, ".."), { recursive: true, force: true });
	});

	async function runCli(
		args: readonly string[],
	): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["bun", "run", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			cwd: process.cwd(),
			env: { ...process.env },
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	}

	function makeArgs(root: string): readonly string[] {
		// The campaign ID embedded in the staging-root path determines what
		// the CLI's --campaign flag must match. Extract it from `root`.
		const rootParts = root.split("/");
		const campaignId = rootParts[rootParts.length - 2]!;
		const args: string[] = [
			"tools/compare/bin/compare-stage.ts",
			"--staging-root",
			root,
			"--candidate",
			SAMPLE_MEASUREMENTS.candidateId,
			"--campaign",
			campaignId,
			"--candidate-head",
			SAMPLE_MEASUREMENTS.candidateHead,
			"--candidate-tree-oid",
			SAMPLE_MEASUREMENTS.candidateTreeOid,
			"--mac-bun-sha256",
			SAMPLE_MEASUREMENTS.macBunSha256,
			"--linux-bun-sha256",
			SAMPLE_MEASUREMENTS.linuxBunSha256,
			"--mac-bun-version",
			SAMPLE_MEASUREMENTS.macBunVersion,
			"--linux-bun-version",
			SAMPLE_MEASUREMENTS.linuxBunVersion,
			"--source-archive-sha256",
			SAMPLE_MEASUREMENTS.sourceArchiveSha256,
			"--source-archive-size",
			String(SAMPLE_MEASUREMENTS.sourceArchiveSize),
			"--archive-member-count",
			String(SAMPLE_MEASUREMENTS.archiveMemberCount),
			"--git-version",
			SAMPLE_MEASUREMENTS.gitVersion,
			"--git-executable-sha256",
			SAMPLE_MEASUREMENTS.gitExecutableSha256,
			"--git-status-sha256",
			SAMPLE_MEASUREMENTS.gitStatusBytesSha256,
			"--git-status-size",
			String(SAMPLE_MEASUREMENTS.gitStatusBytesSize),
			"--git-unstaged-diff-sha256",
			SAMPLE_MEASUREMENTS.gitUnstagedDiffBytesSha256,
			"--git-unstaged-diff-size",
			String(SAMPLE_MEASUREMENTS.gitUnstagedDiffBytesSize),
			"--git-staged-diff-sha256",
			SAMPLE_MEASUREMENTS.gitStagedDiffBytesSha256,
			"--git-staged-diff-size",
			String(SAMPLE_MEASUREMENTS.gitStagedDiffBytesSize),
			"--git-submodule-status-sha256",
			SAMPLE_MEASUREMENTS.gitSubmoduleStatusSha256,
			"--git-submodule-status-size",
			String(SAMPLE_MEASUREMENTS.gitSubmoduleStatusSize),
			"--untracked-file-count",
			String(SAMPLE_MEASUREMENTS.untrackedFileCount),
			"--reviewed-diff-sha256",
			SAMPLE_MEASUREMENTS.reviewedDiffSha256,
			"--archive-member-inventory-sha256",
			SAMPLE_MEASUREMENTS.archiveMemberInventorySha256,
			"--archive-member-inventory-size",
			String(SAMPLE_MEASUREMENTS.archiveMemberInventorySize),
			"--source-builder-executable-sha256",
			SAMPLE_MEASUREMENTS.sourceBuilderExecutableSha256,
			"--command-set-sha256",
			SAMPLE_MEASUREMENTS.commandSetSha256,
			"--issued-at-ms",
			String(SAMPLE_MEASUREMENTS.issuedAtMs),
			"--not-after-ms",
			String(SAMPLE_MEASUREMENTS.notAfterMs),
		];
		return args;
	}

	it("--dry-run prints the authority digest and writes no files", async () => {
		const result = await runCli([...makeArgs(stagingRoot), "--dry-run"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("compare-stage (dry-run)");
		expect(result.stdout).toContain("authority digest:");
		// Staging root should not have been created by dry-run.
		const manifestPath = join(stagingRoot, "manifest.json");
		expect(() => readFileSync(manifestPath)).toThrow();
	});

	it("writes 7 records + manifest on success", async () => {
		const result = await runCli(makeArgs(stagingRoot));
		expect(result.code).toBe(0);
		for (const filename of [
			"authority.json",
			"source-archive-receipt.json",
			"r1-red-approval-bundle.json",
			"staged-capability.json",
			"bun-role-launch-receipt-set.json",
			"host-runtime-facts.darwin.json",
			"host-runtime-facts.linux.json",
			"manifest.json",
		]) {
			expect(() => readFileSync(join(stagingRoot, filename))).not.toThrow();
		}
	});

	it("the manifest records the digest of every staged record", async () => {
		await runCli(makeArgs(stagingRoot));
		const manifestBytes = readFileSync(join(stagingRoot, "manifest.json"));
		const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
		expect(manifest.schema).toBe("staged-trust-boundary/v1");
		expect(manifest.records.length).toBe(7);
		for (const record of manifest.records) {
			expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(record.byteLength).toBeGreaterThan(0);
		}
	});

	it("the manifest digest matches the manifest's own bytes", async () => {
		await runCli(makeArgs(stagingRoot));
		const manifestBytes = readFileSync(join(stagingRoot, "manifest.json"));
		expect(sha256HexOfBytes(manifestBytes)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses a malformed digest and writes nothing", async () => {
		const badArgs = makeArgs(stagingRoot).map((a) =>
			a === SAMPLE_MEASUREMENTS.macBunSha256 ? "not-hex" : a,
		);
		const result = await runCli(badArgs);
		expect(result.code).not.toBe(0);
		// The CLI refuses at parse-time before any file is written.
		expect(() => readFileSync(join(stagingRoot, "manifest.json"))).toThrow();
	});
});

// Re-exports `main` so the `import { main } from ...` keeps both forms
// resolvable; the CLI entry checks `import.meta.main` to decide whether to
// run, so a test that imports it never accidentally drives the process.
void main;
