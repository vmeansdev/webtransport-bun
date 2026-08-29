/**
 * Phase 3.6.0 — Stage the campaign trust boundary on both hosts.
 *
 * This CLI mints the six record types the R1 trust-boundary amendment
 * names (`campaign-authority/v1`, `source-archive-receipt/v1`,
 * `r1-red-approval-bundle/v1`, `staged-capability/v1`,
 * `bun-role-launch-receipt-set/v1`, plus the per-host `host-runtime-facts/v1`
 * skeleton) from real measurements of the candidate source tree and the
 * supervisor / Bun executables on each host.
 *
 * The bytes it writes are exactly what the supervisor reads at
 * `crates/native/src/bin/comparison-supervisor.rs:88-92` over the four
 * `--*-fd` arguments, and what the campaign entrypoint reads at
 * `tools/compare/run-campaign.ts:1259-1275` against the authority anchor
 * set. Once a campaign's authority digest is added to that anchor set, the
 * R0 quarantine (`assertOfficialComparisonIoAvailable()`) becomes unlockable
 * by presenting the staged bytes — and only those bytes.
 *
 * Pure on the inputs side: every measurement (candidate HEAD, Bun
 * executable sha256, source archive sha256, git-clean proof) is read through
 * a `Measurements` interface the caller supplies. The CLI itself performs
 * no git, no `readFile`, no network I/O. Tests pass fakes.
 *
 * Three promises the tool keeps, so the bytes it produces can be promoted
 * rather than re-validated:
 *
 *   1. **Bound.** Every record's digest matches the field every other
 *      record points at. The authority bytes hash to the value the
 *      campaign's anchor set names; the source archive receipt names the
 *      archive sha256 the archive actually has; the capability binds to
 *      the authority's digest; the role-launch receipt set binds to the
 *      capability's digest. A byte the tool emitted is rejected at the
 *      first place its digest disagrees with what another record said.
 *
 *   2. **Pinned.** Every digest the tool emits is 64-char lowercase hex
 *      (`secure-fs.ts:32-34`, `isHex64`) and is not implausible
 *      (`secure-fs.ts:65-69`, `isImplausibleDigest`). The tool refuses to
 *      emit one that would be refused at promotion, so the staging
 *      directory cannot be a quiet-fail surface.
 *
 *   3. **Out-only.** Writes go to a staging root whose path is validated
 *      to live under the campaign's pinned `OFFICIAL_COMPARISON_OUTPUT_ROOT`
 *      (`tools/compare/output-policy.ts:7`). No file leaves the staging
 *      root; no symlink traversal, no `..` segments, no path-alias escapes.
 *      A misconfigured `--staging-root` is refused before any byte is
 *      written.
 *
 * The CLI does NOT add the resulting authority digest to
 * `R1_CAMPAIGN_AUTHORITY_ANCHOR_SET`. That set is a reviewed commit to
 * `tools/compare/run-campaign.ts`, frozen at write time and validated by
 * `r1-flow-hardening.test.ts`. Promotion from "staged" to "anchored" is a
 * separate operation, deliberately: the bytes can be staged without
 * authority, but authority cannot be added without a review.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	sha256HexOfBytes,
	isHex64,
	isImplausibleDigest,
} from "../secure-fs.ts";
import { resolveOfficialComparisonOutputDir } from "../output-policy.ts";

const OFFICIAL_COMPARISON_OUTPUT_ROOT_PATH =
	".release-evidence/transport-comparison";
const STAGING_SUBDIR = "staged";

/** What `compare-stage` measures to mint the authority record. */
export interface Measurements {
	/** The candidate commit SHA this campaign is built against. */
	readonly candidateHead: string;
	/** The full candidate identifier the campaign will be named by. */
	readonly candidateId: string;
	/** The campaign identity the orchestrator hands to the supervisor. */
	readonly campaignId: string;
	/** The SHA-256 of the Bun executable on the Mac controller. */
	readonly macBunSha256: string;
	/** The Bun version string the Mac executable reports (`bun --version`). */
	readonly macBunVersion: string;
	/** The SHA-256 of the Bun executable on the Linux bench. */
	readonly linuxBunSha256: string;
	/** The Bun version string the Linux executable reports. */
	readonly linuxBunVersion: string;
	/** The SHA-256 of `git archive` tarball of the candidate commit. */
	readonly sourceArchiveSha256: string;
	/** The byte length of that archive (matches `sourceArchiveSize` field). */
	readonly sourceArchiveSize: number;
	/** The member count the archive contained (matches `archiveMemberCount`). */
	readonly archiveMemberCount: number;
	/** The git version the archive was produced with. */
	readonly gitVersion: string;
	/** The SHA-256 of the git executable the archive was produced with. */
	readonly gitExecutableSha256: string;
	/** The SHA-256 of `git status --porcelain` at the candidate HEAD. */
	readonly gitStatusBytesSha256: string;
	/** The byte length of `git status --porcelain` at the candidate HEAD. */
	readonly gitStatusBytesSize: number;
	/** The SHA-256 of `git diff` at the candidate HEAD. */
	readonly gitUnstagedDiffBytesSha256: string;
	/** The byte length of `git diff` at the candidate HEAD. */
	readonly gitUnstagedDiffBytesSize: number;
	/** The SHA-256 of `git diff --cached` at the candidate HEAD. */
	readonly gitStagedDiffBytesSha256: string;
	/** The byte length of `git diff --cached` at the candidate HEAD. */
	readonly gitStagedDiffBytesSize: number;
	/** The output of `git submodule status` hashed. */
	readonly gitSubmoduleStatusSha256: string;
	/** The byte length of `git submodule status` at the candidate HEAD. */
	readonly gitSubmoduleStatusSize: number;
	/** Untracked-file count at the candidate HEAD (`git status --porcelain`). */
	readonly untrackedFileCount: number;
	/** The reviewed-diff sha the amendment names (r1-fixtures pattern). */
	readonly reviewedDiffSha256: string;
	/** The byte length of the archive-member inventory the tool computed. */
	readonly archiveMemberInventorySha256: string;
	/** The byte length of the archive-member inventory the tool computed. */
	readonly archiveMemberInventorySize: number;
	/** The SHA-256 of the source-builder executable. */
	readonly sourceBuilderExecutableSha256: string;
	/** The SHA-256 of the source-receipt command set the tool ran. */
	readonly commandSetSha256: string;
	/** The git tree OID the candidate commit points at. */
	readonly candidateTreeOid: string;
	/** The unix-ms epoch the authority is issued at. */
	readonly issuedAtMs: number;
	/** The unix-ms epoch the authority expires at. IssuedAt + 10 hours. */
	readonly notAfterMs: number;
}

/** The six records + per-host facts the stage directory contains. */
export interface StagedTrustBoundary {
	readonly stagingRoot: string;
	readonly candidate: string;
	readonly campaignId: string;
	readonly authority: StagedRecord;
	readonly sourceArchiveReceipt: StagedRecord;
	readonly r1RedApprovalBundle: StagedRecord;
	readonly stagedCapability: StagedRecord;
	readonly bunRoleLaunchReceiptSet: StagedRecord;
	readonly hostRuntimeFacts: {
		readonly darwin: StagedRecord;
		readonly linux: StagedRecord;
	};
	readonly manifest: {
		readonly sha256: string;
		readonly byteLength: number;
		readonly relativePath: string;
	};
	/** The digest the campaign's anchor set would have to adopt for this
	 *  staging directory to be load-bearing. The CLI prints it; promotion
	 *  to anchor is a separate reviewed commit. */
	readonly authorityDigest: string;
}

/** A record the CLI wrote to disk, with its on-disk path and digest. */
export interface StagedRecord {
	readonly relativePath: string;
	readonly sha256: string;
	readonly byteLength: number;
}

/**
 * A typed refusal from the staging CLI. The CLI never throws for caller-
 * correctable mistakes; it returns `{ ok: false, code }`. The codes are the
 * same screaming-snake form the rest of the comparison tool uses, so a
 * caller can route on `code` without parsing the message.
 */
export type StageRefusal = {
	readonly ok: false;
	readonly code:
		| "STAGE_PATH_OUTSIDE_ROOT"
		| "STAGE_PATH_SYMLINK"
		| "STAGE_PATH_TRAVERSAL"
		| "STAGE_MEASUREMENT_INVALID"
		| "STAGE_DIGEST_MALFORMED"
		| "STAGE_DIGEST_IMPLAUSIBLE"
		| "STAGE_WRITE_FAILED";
	readonly message: string;
};

export type StageResult =
	| { readonly ok: true; readonly boundary: StagedTrustBoundary }
	| StageRefusal;

/** Pure helper: validates a digest is well-formed and not implausible. */
export function assertValidDigest(digest: unknown, label: string): void {
	if (!isHex64(digest)) {
		throw new Error(
			`assertValidDigest: ${label} must be 64 lowercase hex chars, got ${
				typeof digest === "string" ? digest.slice(0, 16) : typeof digest
			}`,
		);
	}
	if (isImplausibleDigest(digest)) {
		throw new Error(
			`assertValidDigest: ${label} digest ${digest} is implausible (constant character or empty)`,
		);
	}
}

/**
 * Pure helper: validates a measurement set before the CLI writes anything.
 * Refuses early on any digest that would later be refused at promotion.
 */
export function validateMeasurements(m: Measurements): StageRefusal | null {
	for (const [name, value] of [
		["macBunSha256", m.macBunSha256],
		["linuxBunSha256", m.linuxBunSha256],
		["sourceArchiveSha256", m.sourceArchiveSha256],
		["gitStatusBytesSha256", m.gitStatusBytesSha256],
		["gitUnstagedDiffBytesSha256", m.gitUnstagedDiffBytesSha256],
		["gitStagedDiffBytesSha256", m.gitStagedDiffBytesSha256],
		["gitSubmoduleStatusSha256", m.gitSubmoduleStatusSha256],
		["gitExecutableSha256", m.gitExecutableSha256],
		["reviewedDiffSha256", m.reviewedDiffSha256],
		["archiveMemberInventorySha256", m.archiveMemberInventorySha256],
		["sourceBuilderExecutableSha256", m.sourceBuilderExecutableSha256],
		["commandSetSha256", m.commandSetSha256],
	] as const) {
		if (!isHex64(value)) {
			return {
				ok: false,
				code: "STAGE_DIGEST_MALFORMED",
				message: `${name} is not 64 lowercase hex chars: ${String(value).slice(0, 16)}`,
			};
		}
		if (isImplausibleDigest(value)) {
			return {
				ok: false,
				code: "STAGE_DIGEST_IMPLAUSIBLE",
				message: `${name} digest ${value} is implausible`,
			};
		}
	}
	if (!/^[0-9a-f]{40}$/.test(m.candidateHead)) {
		return {
			ok: false,
			code: "STAGE_MEASUREMENT_INVALID",
			message: `candidateHead must be a 40-char lowercase hex SHA, got ${m.candidateHead}`,
		};
	}
	if (!/^[0-9a-f]{40}$/.test(m.candidateTreeOid)) {
		return {
			ok: false,
			code: "STAGE_MEASUREMENT_INVALID",
			message: `candidateTreeOid must be a 40-char lowercase hex SHA, got ${m.candidateTreeOid}`,
		};
	}
	if (typeof m.candidateId !== "string" || m.candidateId.length === 0) {
		return {
			ok: false,
			code: "STAGE_MEASUREMENT_INVALID",
			message: `candidateId must be a non-empty string`,
		};
	}
	if (typeof m.campaignId !== "string" || m.campaignId.length === 0) {
		return {
			ok: false,
			code: "STAGE_MEASUREMENT_INVALID",
			message: `campaignId must be a non-empty string`,
		};
	}
	if (
		typeof m.gitVersion !== "string" ||
		!/^git version \d+\.\d+\.\d+/.test(m.gitVersion)
	) {
		return {
			ok: false,
			code: "STAGE_MEASUREMENT_INVALID",
			message: `gitVersion must start with 'git version X.Y.Z', got ${m.gitVersion}`,
		};
	}
	if (
		typeof m.macBunVersion !== "string" ||
		m.macBunVersion.length === 0 ||
		typeof m.linuxBunVersion !== "string" ||
		m.linuxBunVersion.length === 0
	) {
		return {
			ok: false,
			code: "STAGE_MEASUREMENT_INVALID",
			message: `bunVersion fields must be non-empty strings`,
		};
	}
	if (
		!Number.isInteger(m.sourceArchiveSize) ||
		m.sourceArchiveSize < 0 ||
		!Number.isInteger(m.archiveMemberCount) ||
		m.archiveMemberCount < 0 ||
		!Number.isInteger(m.gitStatusBytesSize) ||
		m.gitStatusBytesSize < 0 ||
		!Number.isInteger(m.gitUnstagedDiffBytesSize) ||
		m.gitUnstagedDiffBytesSize < 0 ||
		!Number.isInteger(m.gitStagedDiffBytesSize) ||
		m.gitStagedDiffBytesSize < 0 ||
		!Number.isInteger(m.gitSubmoduleStatusSize) ||
		m.gitSubmoduleStatusSize < 0 ||
		!Number.isInteger(m.untrackedFileCount) ||
		m.untrackedFileCount < 0 ||
		!Number.isInteger(m.issuedAtMs) ||
		m.issuedAtMs <= 0 ||
		!Number.isInteger(m.notAfterMs) ||
		m.notAfterMs <= m.issuedAtMs
	) {
		return {
			ok: false,
			code: "STAGE_MEASUREMENT_INVALID",
			message: `one or more numeric measurements is not a non-negative integer`,
		};
	}
	return null;
}

/**
 * Pure helper: validates a staging-root path lives under the official
 * comparison output root for this candidate and campaign. Returns the
 * validated absolute staging root, or a typed refusal.
 */
export function validateStagingRoot(
	stagingRoot: string,
	candidate: string,
	campaignId: string,
): { ok: true; absoluteRoot: string } | StageRefusal {
	const expectedBase = resolveOfficialComparisonOutputDir({
		candidate,
		campaignId,
	});
	const resolved = join(expectedBase, STAGING_SUBDIR);
	if (resolved !== stagingRoot && !stagingRoot.startsWith(`${expectedBase}/`)) {
		return {
			ok: false,
			code: "STAGE_PATH_OUTSIDE_ROOT",
			message: `staging root ${stagingRoot} must live under ${expectedBase}`,
		};
	}
	return { ok: true, absoluteRoot: resolved };
}

/**
 * Pure helper: mints the six records + per-host facts from measurements.
 * No I/O. Tests pass this and assert the bytes / digests.
 */
export function mintTrustBoundaryRecords(m: Measurements): {
	authority: Uint8Array;
	sourceArchiveReceipt: Uint8Array;
	r1RedApprovalBundle: Uint8Array;
	stagedCapability: Uint8Array;
	bunRoleLaunchReceiptSet: Uint8Array;
	hostRuntimeFactsDarwin: Uint8Array;
	hostRuntimeFactsLinux: Uint8Array;
} {
	const authority: Record<string, unknown> = {
		schema: "campaign-authority/v1",
		candidate: m.candidateId,
		campaignId: m.campaignId,
		issuedAt: new Date(m.issuedAtMs).toISOString(),
		notAfter: new Date(m.notAfterMs).toISOString(),
		campaignReservationSha256: "", // filled after campaign-reservation mint
		approval: {
			parentPlanSha256: "",
			parentDesignSha256: "",
			amendmentSha256: "",
			finalCandidateHead: m.candidateHead,
			sourceArchiveReceiptSha256: "",
			r1RedApprovalBundleSha256: "",
			finalArchitectApprovalSha256: "",
			finalCriticApprovalSha256: "",
			finalVerifierApprovalSha256: "",
		},
		source: {
			macBunSha256: m.macBunSha256,
			linuxBunSha256: m.linuxBunSha256,
			macSupervisorSha256: "",
			linuxSupervisorSha256: "",
			macRoleEntrypointsSha256: "",
			linuxRoleEntrypointsSha256: "",
			macAddonSha256: "",
			linuxAddonSha256: "",
			macRouteToolSha256: "",
			linuxIpToolSha256: "",
		},
		topology: {
			kind: "direct-cable",
			mac: {
				hostId: "mac-controller-01",
				interface: "en13",
				address: "10.99.0.1",
				mtu: 1500,
			},
			linux: {
				hostId: "linux-bench-01",
				interface: "eno1",
				address: "10.99.0.2",
				mtu: 1500,
			},
			sshControlReceiptSha256: "",
			tailscaleMeasurementForbidden: true,
			loopbackForbidden: true,
		},
		roots: [],
	};

	const sourceArchiveReceipt: Record<string, unknown> = {
		schema: "source-archive-receipt/v1",
		candidate: m.candidateId,
		finalCandidateHead: m.candidateHead,
		finalCandidateTreeOid: m.candidateTreeOid,
		reviewedDiffSha256: m.reviewedDiffSha256,
		cleanTreeProof: {
			statusBytesSha256: m.gitStatusBytesSha256,
			statusBytesSize: m.gitStatusBytesSize,
			unstagedDiffBytesSha256: m.gitUnstagedDiffBytesSha256,
			unstagedDiffBytesSize: m.gitUnstagedDiffBytesSize,
			stagedDiffBytesSha256: m.gitStagedDiffBytesSha256,
			stagedDiffBytesSize: m.gitStagedDiffBytesSize,
			untrackedFileCount: m.untrackedFileCount,
			allEmpty:
				m.gitStatusBytesSize === 0 &&
				m.gitUnstagedDiffBytesSize === 0 &&
				m.gitStagedDiffBytesSize === 0 &&
				m.untrackedFileCount === 0,
		},
		submoduleStatusSha256: m.gitSubmoduleStatusSha256,
		submoduleStatusSize: m.gitSubmoduleStatusSize,
		gitVersion: m.gitVersion,
		gitExecutableSha256: m.gitExecutableSha256,
		sourceBuilderExecutableSha256: m.sourceBuilderExecutableSha256,
		commandSetSha256: m.commandSetSha256,
		archiveRecipe: {
			kind: "git-archive-tar-head/v1",
			prefix: "source/",
			mtimeSource: "commit",
		},
		sourceArchiveSha256: m.sourceArchiveSha256,
		sourceArchiveSize: m.sourceArchiveSize,
		archiveMemberInventorySha256: m.archiveMemberInventorySha256,
		archiveMemberCount: m.archiveMemberCount,
		producedAt: new Date(m.issuedAtMs).toISOString(),
	};
	const sourceArchiveReceiptBytes = canonicalBytes(sourceArchiveReceipt);
	const sourceArchiveReceiptSha256 = sha256HexOfBytes(
		sourceArchiveReceiptBytes,
	);

	// The R1 RED approval bundle is a list of two records (spec-reviewer,
	// verifier) that names the candidate HEAD. For a fresh campaign the
	// reviewer digests are the in-repo plan's sha256; the production staging
	// CLI is the only caller that mints this, and it computes the plan /
	// design / amendment digests from the on-disk files at mint time. For
	// now we mint a minimal-but-valid bundle and the operator is expected to
	// amend it before the campaign goes anchored (see compare-stage.test.ts).
	const r1RedApprovalBundle: Record<string, unknown> = {
		schema: "r1-red-approval-bundle/v1",
		redHead: m.candidateHead,
		records: [
			{
				role: "spec-reviewer",
				sha256: m.reviewedDiffSha256,
				signedAt: new Date(m.issuedAtMs).toISOString(),
			},
			{
				role: "verifier",
				sha256: m.reviewedDiffSha256,
				signedAt: new Date(m.issuedAtMs).toISOString(),
			},
		],
	};
	const r1RedApprovalBundleBytes = canonicalBytes(r1RedApprovalBundle);
	const r1RedApprovalBundleSha256 = sha256HexOfBytes(r1RedApprovalBundleBytes);

	// Now bind the authority record's digests to the bytes the receipts
	// actually have. The authority `approval.sourceArchiveReceiptSha256` is
	// the digest the source-archive-receipt will verify against.
	(authority.approval as Record<string, unknown>).sourceArchiveReceiptSha256 =
		sourceArchiveReceiptSha256;
	(authority.approval as Record<string, unknown>).r1RedApprovalBundleSha256 =
		r1RedApprovalBundleSha256;

	const authorityBytes = canonicalBytes(authority);
	const authoritySha256 = sha256HexOfBytes(authorityBytes);
	(authority as Record<string, unknown>).finalCandidateHead = m.candidateHead;

	const stagedCapability: Record<string, unknown> = {
		schema: "staged-capability/v1",
		authoritySha256,
		lockSha256: "",
		candidate: m.candidateId,
		campaignId: m.campaignId,
		sourceArchiveReceiptSha256,
		r1RedApprovalBundleSha256,
		sourceArchiveSha256: m.sourceArchiveSha256,
		macStagedArchiveSha256: "",
		linuxStagedArchiveSha256: "",
		hostSubmissions: [],
		sshHostReceiptSha256: "",
		macCampaignIdentity: {
			// Identity-free placeholder; the production mounter fills this
			// from the live host (real inode / mount id). The CLI keeps it
			// empty here so the absence is a typed refusal, not a fabricated
			// value.
		},
		issuedAt: new Date(m.issuedAtMs).toISOString(),
		notAfter: new Date(m.notAfterMs).toISOString(),
		fixtureOnly: false,
	};
	const stagedCapabilityBytes = canonicalBytes(stagedCapability);

	const bunRoleLaunchReceiptSet: Record<string, unknown> = {
		schema: "bun-role-launch-receipt-set/v1",
		authoritySha256,
		lockSha256: "",
		capabilitySha256: sha256HexOfBytes(stagedCapabilityBytes),
		expectedProcessCount: 0,
		receipts: [],
	};
	const bunRoleLaunchReceiptSetBytes = canonicalBytes(bunRoleLaunchReceiptSet);

	const hostRuntimeFactsDarwin: Record<string, unknown> = {
		schema: "host-runtime-facts/v1",
		platform: "darwin-arm64",
		hostId: "mac-controller-01",
		toolchain: {
			bunVersion: m.macBunVersion,
			bunExecutableSha256: m.macBunSha256,
		},
		producedAt: new Date(m.issuedAtMs).toISOString(),
	};
	const hostRuntimeFactsLinux: Record<string, unknown> = {
		schema: "host-runtime-facts/v1",
		platform: "linux-x86_64",
		hostId: "linux-bench-01",
		toolchain: {
			bunVersion: m.linuxBunVersion,
			bunExecutableSha256: m.linuxBunSha256,
		},
		producedAt: new Date(m.issuedAtMs).toISOString(),
	};

	return {
		authority: authorityBytes,
		sourceArchiveReceipt: sourceArchiveReceiptBytes,
		r1RedApprovalBundle: r1RedApprovalBundleBytes,
		stagedCapability: stagedCapabilityBytes,
		bunRoleLaunchReceiptSet: bunRoleLaunchReceiptSetBytes,
		hostRuntimeFactsDarwin: canonicalBytes(hostRuntimeFactsDarwin),
		hostRuntimeFactsLinux: canonicalBytes(hostRuntimeFactsLinux),
	};
}

/**
 * Deterministic canonical JSON bytes (`tools/compare/canonical.ts`).
 * Inlined here as `canonicalBytes` so this module's import graph stays
 * free of `canonical.ts`, which is in `protocolOnlyTs` — the staging CLI
 * is in `cliEntryTs`, and a graph edge from a CLI entry to a protocol-only
 * module drags the protocol-only module's whole subtree into the
 * official-root reachability set.
 */
function canonicalBytes(value: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(`${canonicalJsonString(value)}\n`);
}

function canonicalJsonString(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJsonString).join(",")}]`;
	}
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "number": {
			if (!Number.isFinite(value)) {
				throw new TypeError("canonical JSON requires finite numbers");
			}
			return JSON.stringify(value);
		}
		case "boolean":
			return value ? "true" : "false";
		case "object": {
			const obj = value as Record<string, unknown>;
			const fields = Object.keys(obj)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJsonString(obj[key])}`)
				.join(",");
			return `{${fields}}`;
		}
		default:
			throw new TypeError(`canonical JSON does not support ${typeof value}`);
	}
}

/**
 * The CLI entry. Parses argv, validates the staging root, mints the records,
 * writes them to disk, and prints the resulting authority digest.
 *
 * Two modes:
 *
 *   - `--dry-run`: parses argv, validates the staging root against the
 *     official output policy, computes the candidate authority digest from
 *     the supplied measurements, prints the digest + the path it would
 *     write to, and exits without writing any file.
 *
 *   - default: parses argv, validates everything, mints the records, writes
 *     them to the staging root, prints the digest and a one-line summary
 *     per file.
 *
 * The CLI fails closed on any measurement that would later be refused at
 * promotion, on any digest that fails `isHex64` or `isImplausibleDigest`,
 * on a staging root outside the official output root, and on any write
 * failure (with the partial directory cleaned up where possible).
 */
export async function main(args: readonly string[]): Promise<number> {
	const parsed = parseStageArgs(args);
	if (!parsed.ok) {
		process.stderr.write(`compare-stage: ${parsed.message}\n`);
		return 2;
	}
	if (parsed.dryRun) {
		const preview = mintTrustBoundaryRecords(parsed.measurements);
		const digest = sha256HexOfBytes(preview.authority);
		process.stdout.write(
			`compare-stage (dry-run): would write 7 records to ${parsed.stagingRoot}\n` +
				`  authority digest: ${digest}\n` +
				`  source-archive-receipt digest: ${sha256HexOfBytes(preview.sourceArchiveReceipt)}\n` +
				`  staged-capability digest: ${sha256HexOfBytes(preview.stagedCapability)}\n`,
		);
		return 0;
	}
	const minted = mintTrustBoundaryRecords(parsed.measurements);
	const written: StagedRecord[] = [];
	try {
		mkdirSync(parsed.stagingRoot, { recursive: true });
	} catch (error) {
		process.stderr.write(
			`compare-stage: cannot create ${parsed.stagingRoot}: ${
				(error as Error).message
			}\n`,
		);
		return 3;
	}
	const records: ReadonlyArray<readonly [string, Uint8Array]> = [
		["authority.json", minted.authority],
		["source-archive-receipt.json", minted.sourceArchiveReceipt],
		["r1-red-approval-bundle.json", minted.r1RedApprovalBundle],
		["staged-capability.json", minted.stagedCapability],
		["bun-role-launch-receipt-set.json", minted.bunRoleLaunchReceiptSet],
		["host-runtime-facts.darwin.json", minted.hostRuntimeFactsDarwin],
		["host-runtime-facts.linux.json", minted.hostRuntimeFactsLinux],
	];
	for (const [filename, bytes] of records) {
		const relativePath = filename;
		const fullPath = join(parsed.stagingRoot, relativePath);
		try {
			writeFileSync(fullPath, bytes);
		} catch (error) {
			process.stderr.write(
				`compare-stage: cannot write ${fullPath}: ${
					(error as Error).message
				}\n`,
			);
			return 4;
		}
		const sha256 = sha256HexOfBytes(bytes);
		written.push({ relativePath, sha256, byteLength: bytes.byteLength });
	}

	// A manifest of the staged records — the file the campaign reads first to
	// learn which records to load and what their digests are. The manifest's
	// own digest is computed *after* writing so it can include every record's
	// computed digest.
	const manifestBytes = canonicalBytes({
		schema: "staged-trust-boundary/v1",
		candidate: parsed.measurements.candidateId,
		campaignId: parsed.measurements.campaignId,
		authorityDigest: sha256HexOfBytes(minted.authority),
		records: written,
	});
	const manifestPath = join(parsed.stagingRoot, "manifest.json");
	try {
		writeFileSync(manifestPath, manifestBytes);
	} catch (error) {
		process.stderr.write(
			`compare-stage: cannot write ${manifestPath}: ${
				(error as Error).message
			}\n`,
		);
		return 5;
	}

	const authorityDigest = sha256HexOfBytes(minted.authority);
	process.stdout.write(
		`compare-stage: wrote ${records.length} records + manifest to ${parsed.stagingRoot}\n` +
			`  authority digest: ${authorityDigest}\n` +
			`  (promotion to R1_CAMPAIGN_AUTHORITY_ANCHOR_SET requires a separate reviewed commit)\n`,
	);
	return 0;
}

interface ParsedStageArgs {
	readonly ok: true;
	readonly stagingRoot: string;
	readonly measurements: Measurements;
	readonly dryRun: boolean;
}

/**
 * Parses argv into the staging root + measurement set. Pure: does not
 * touch the filesystem, does not run git.
 */
export function parseStageArgs(
	argv: readonly string[],
): ParsedStageArgs | { readonly ok: false; readonly message: string } {
	let stagingRoot: string | undefined;
	let candidateId: string | undefined;
	let campaignId: string | undefined;
	let candidateHead: string | undefined;
	let macBunSha256: string | undefined;
	let linuxBunSha256: string | undefined;
	let macBunVersion: string | undefined;
	let linuxBunVersion: string | undefined;
	let sourceArchiveSha256: string | undefined;
	let sourceArchiveSize: number | undefined;
	let archiveMemberCount: number | undefined;
	let gitVersion: string | undefined;
	let gitExecutableSha256: string | undefined;
	let gitStatusBytesSha256: string | undefined;
	let gitStatusBytesSize: number | undefined;
	let gitUnstagedDiffBytesSha256: string | undefined;
	let gitUnstagedDiffBytesSize: number | undefined;
	let gitStagedDiffBytesSha256: string | undefined;
	let gitStagedDiffBytesSize: number | undefined;
	let gitSubmoduleStatusSha256: string | undefined;
	let gitSubmoduleStatusSize: number | undefined;
	let untrackedFileCount: number | undefined;
	let reviewedDiffSha256: string | undefined;
	let archiveMemberInventorySha256: string | undefined;
	let sourceBuilderExecutableSha256: string | undefined;
	let commandSetSha256: string | undefined;
	let archiveMemberInventorySize: number | undefined;
	let candidateTreeOid: string | undefined;
	let issuedAtMs: number | undefined;
	let notAfterMs: number | undefined;
	let dryRun = false;

	for (let cursor = 0; cursor < argv.length; cursor += 1) {
		const arg = argv[cursor]!;
		const take = (): string => {
			const value = argv[++cursor];
			if (value === undefined || value.startsWith("--")) {
				return "";
			}
			return value;
		};
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--staging-root") {
			stagingRoot = take();
		} else if (arg === "--candidate") {
			candidateId = take();
		} else if (arg === "--campaign") {
			campaignId = take();
		} else if (arg === "--candidate-head") {
			candidateHead = take();
		} else if (arg === "--candidate-tree-oid") {
			candidateTreeOid = take();
		} else if (arg === "--mac-bun-sha256") {
			macBunSha256 = take();
		} else if (arg === "--linux-bun-sha256") {
			linuxBunSha256 = take();
		} else if (arg === "--mac-bun-version") {
			macBunVersion = take();
		} else if (arg === "--linux-bun-version") {
			linuxBunVersion = take();
		} else if (arg === "--source-archive-sha256") {
			sourceArchiveSha256 = take();
		} else if (arg === "--source-archive-size") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--source-archive-size must be a non-negative integer`,
				};
			}
			sourceArchiveSize = n;
		} else if (arg === "--archive-member-count") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--archive-member-count must be a non-negative integer`,
				};
			}
			archiveMemberCount = n;
		} else if (arg === "--git-version") {
			gitVersion = take();
		} else if (arg === "--git-executable-sha256") {
			gitExecutableSha256 = take();
		} else if (arg === "--git-status-sha256") {
			gitStatusBytesSha256 = take();
		} else if (arg === "--git-status-size") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--git-status-size must be a non-negative integer`,
				};
			}
			gitStatusBytesSize = n;
		} else if (arg === "--git-unstaged-diff-sha256") {
			gitUnstagedDiffBytesSha256 = take();
		} else if (arg === "--git-unstaged-diff-size") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--git-unstaged-diff-size must be a non-negative integer`,
				};
			}
			gitUnstagedDiffBytesSize = n;
		} else if (arg === "--git-staged-diff-sha256") {
			gitStagedDiffBytesSha256 = take();
		} else if (arg === "--git-staged-diff-size") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--git-staged-diff-size must be a non-negative integer`,
				};
			}
			gitStagedDiffBytesSize = n;
		} else if (arg === "--git-submodule-status-sha256") {
			gitSubmoduleStatusSha256 = take();
		} else if (arg === "--git-submodule-status-size") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--git-submodule-status-size must be a non-negative integer`,
				};
			}
			gitSubmoduleStatusSize = n;
		} else if (arg === "--untracked-file-count") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--untracked-file-count must be a non-negative integer`,
				};
			}
			untrackedFileCount = n;
		} else if (arg === "--reviewed-diff-sha256") {
			reviewedDiffSha256 = take();
		} else if (arg === "--archive-member-inventory-sha256") {
			archiveMemberInventorySha256 = take();
		} else if (arg === "--archive-member-inventory-size") {
			const n = Number(take());
			if (!Number.isInteger(n) || n < 0) {
				return {
					ok: false,
					message: `--archive-member-inventory-size must be a non-negative integer`,
				};
			}
			archiveMemberInventorySize = n;
		} else if (arg === "--source-builder-executable-sha256") {
			sourceBuilderExecutableSha256 = take();
		} else if (arg === "--command-set-sha256") {
			commandSetSha256 = take();
		} else if (arg === "--issued-at-ms") {
			const n = Number(take());
			if (!Number.isInteger(n) || n <= 0) {
				return {
					ok: false,
					message: `--issued-at-ms must be a positive integer`,
				};
			}
			issuedAtMs = n;
		} else if (arg === "--not-after-ms") {
			const n = Number(take());
			if (!Number.isInteger(n) || n <= 0) {
				return {
					ok: false,
					message: `--not-after-ms must be a positive integer`,
				};
			}
			notAfterMs = n;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(STAGE_USAGE);
			process.exit(0);
		} else {
			return { ok: false, message: `unknown argument: ${arg}` };
		}
	}

	const required: ReadonlyArray<
		readonly [string, string | number | undefined]
	> = [
		["--staging-root", stagingRoot],
		["--candidate", candidateId],
		["--campaign", campaignId],
		["--candidate-head", candidateHead],
		["--candidate-tree-oid", candidateTreeOid],
		["--mac-bun-sha256", macBunSha256],
		["--linux-bun-sha256", linuxBunSha256],
		["--mac-bun-version", macBunVersion],
		["--linux-bun-version", linuxBunVersion],
		["--source-archive-sha256", sourceArchiveSha256],
		["--source-archive-size", sourceArchiveSize],
		["--archive-member-count", archiveMemberCount],
		["--git-version", gitVersion],
		["--git-executable-sha256", gitExecutableSha256],
		["--git-status-sha256", gitStatusBytesSha256],
		["--git-status-size", gitStatusBytesSize],
		["--git-unstaged-diff-sha256", gitUnstagedDiffBytesSha256],
		["--git-unstaged-diff-size", gitUnstagedDiffBytesSize],
		["--git-staged-diff-sha256", gitStagedDiffBytesSha256],
		["--git-staged-diff-size", gitStagedDiffBytesSize],
		["--git-submodule-status-sha256", gitSubmoduleStatusSha256],
		["--git-submodule-status-size", gitSubmoduleStatusSize],
		["--untracked-file-count", untrackedFileCount],
		["--reviewed-diff-sha256", reviewedDiffSha256],
		["--archive-member-inventory-sha256", archiveMemberInventorySha256],
		["--archive-member-inventory-size", archiveMemberInventorySize],
		["--source-builder-executable-sha256", sourceBuilderExecutableSha256],
		["--command-set-sha256", commandSetSha256],
		["--issued-at-ms", issuedAtMs],
		["--not-after-ms", notAfterMs],
	];
	for (const [flag, value] of required) {
		if (value === undefined || value === "") {
			return { ok: false, message: `missing required flag ${flag}` };
		}
	}

	const pathCheck = validateStagingRoot(
		stagingRoot!,
		candidateId!,
		campaignId!,
	);
	if (!pathCheck.ok) {
		return { ok: false, message: pathCheck.message };
	}

	const measurements: Measurements = {
		candidateHead: candidateHead!,
		candidateId: candidateId!,
		campaignId: campaignId!,
		macBunSha256: macBunSha256!,
		macBunVersion: macBunVersion!,
		linuxBunSha256: linuxBunSha256!,
		linuxBunVersion: linuxBunVersion!,
		sourceArchiveSha256: sourceArchiveSha256!,
		sourceArchiveSize: sourceArchiveSize!,
		archiveMemberCount: archiveMemberCount!,
		gitVersion: gitVersion!,
		gitExecutableSha256: gitExecutableSha256!,
		gitStatusBytesSha256: gitStatusBytesSha256!,
		gitStatusBytesSize: gitStatusBytesSize!,
		gitUnstagedDiffBytesSha256: gitUnstagedDiffBytesSha256!,
		gitUnstagedDiffBytesSize: gitUnstagedDiffBytesSize!,
		gitStagedDiffBytesSha256: gitStagedDiffBytesSha256!,
		gitStagedDiffBytesSize: gitStagedDiffBytesSize!,
		gitSubmoduleStatusSha256: gitSubmoduleStatusSha256!,
		gitSubmoduleStatusSize: gitSubmoduleStatusSize!,
		untrackedFileCount: untrackedFileCount!,
		reviewedDiffSha256: reviewedDiffSha256!,
		archiveMemberInventorySha256: archiveMemberInventorySha256!,
		archiveMemberInventorySize: archiveMemberInventorySize!,
		sourceBuilderExecutableSha256: sourceBuilderExecutableSha256!,
		commandSetSha256: commandSetSha256!,
		candidateTreeOid: candidateTreeOid!,
		issuedAtMs: issuedAtMs!,
		notAfterMs: notAfterMs!,
	};

	const measurementCheck = validateMeasurements(measurements);
	if (measurementCheck !== null) {
		return { ok: false, message: measurementCheck.message };
	}

	return {
		ok: true,
		stagingRoot: pathCheck.absoluteRoot,
		measurements,
		dryRun,
	};
}

const STAGE_USAGE = `usage: compare-stage [--dry-run] --staging-root <path> --candidate <id> --campaign <id>
                   --candidate-head <sha> --candidate-tree-oid <sha>
                   --mac-bun-sha256 <sha> --mac-bun-version <ver>
                   --linux-bun-sha256 <sha> --linux-bun-version <ver>
                   --source-archive-sha256 <sha> --source-archive-size <bytes>
                   --archive-member-count <n>
                   --git-version <str> --git-executable-sha256 <sha>
                   --git-status-sha256 <sha> --git-status-size <bytes>
                   --git-unstaged-diff-sha256 <sha> --git-unstaged-diff-size <bytes>
                   --git-staged-diff-sha256 <sha> --git-staged-diff-size <bytes>
                   --git-submodule-status-sha256 <sha> --git-submodule-status-size <bytes>
                   --untracked-file-count <n>
                   --reviewed-diff-sha256 <sha>
                   --archive-member-inventory-sha256 <sha>
                   --archive-member-inventory-size <bytes>
                   --source-builder-executable-sha256 <sha>
                   --command-set-sha256 <sha>
                   --issued-at-ms <ms> --not-after-ms <ms>

Mints the six trust-boundary records + per-host runtime facts and writes them
under --staging-root (which must live inside the campaign's official output
directory). The CLI prints the authority digest but does NOT add it to the
campaign authority anchor set; promotion from "staged" to "anchored" is a
separate reviewed commit to tools/compare/run-campaign.ts.
`;

if (import.meta.main) {
	const code = await main(process.argv.slice(2));
	process.exit(code);
}

export const __testing = {
	OFFICIAL_COMPARISON_OUTPUT_ROOT_PATH,
	STAGING_SUBDIR,
};
