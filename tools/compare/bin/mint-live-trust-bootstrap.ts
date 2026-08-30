/**
 * Mint a live trust bootstrap whose Mac root identities match the real OS
 * epochs on this host (observed via `observe-directory-identity`), then
 * stage them for `spawnMacSupervisor` / `comparison-supervisor`.
 *
 * Usage:
 *   bun tools/compare/bin/mint-live-trust-bootstrap.ts --out=<dir>
 *
 * The minted authority is NOT the pinned R1 fixture digest; promoting it into
 * `R1_CAMPAIGN_AUTHORITY_ANCHOR_SET` is a separate reviewed commit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	canonicalBytes,
	R1_CAMPAIGN_AUTHORITY,
	R1_CAMPAIGN_ID,
	R1_CAMPAIGN_LOCK,
	R1_CAMPAIGN_MANIFEST_V1,
	R1_CANDIDATE_ID,
	R1_LINUX_DIRECTORY_IDENTITY,
	R1_SOURCE_ARCHIVE_RECEIPT,
	R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
	R1_STAGED_ARCHIVE_RECEIPTS,
	R1_STAGED_CAPABILITY_V1,
	R1_RED_APPROVAL_BUNDLE_SHA256,
	sha256Hex,
} from "../r1-fixtures.ts";
import {
	stageTrustBootstrap,
	TRUST_BOOTSTRAP_CAMPAIGN_ROOT,
	TRUST_BOOTSTRAP_STAGING_ROOT,
} from "../remote-supervisor.ts";

function observerPath(): string {
	const fromEnv = process.env.OBSERVE_DIRECTORY_IDENTITY_BINARY;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return resolve("target/release/observe-directory-identity");
}

async function observeDirectory(
	path: string,
): Promise<Record<string, unknown>> {
	const proc = Bun.spawn([observerPath(), path], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	if (code !== 0) {
		throw new Error(
			`observe-directory-identity failed (${code}): ${stderr.trim()}`,
		);
	}
	return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function parseArgs(argv: readonly string[]): { out: string } {
	let out: string | undefined;
	for (const arg of argv) {
		if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write("usage: mint-live-trust-bootstrap --out=<dir>\n");
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!out || out.length === 0) {
		throw new Error("--out=<dir> is required");
	}
	return { out: resolve(out) };
}

async function main(argv: readonly string[]): Promise<number> {
	const { out } = parseArgs(argv);
	mkdirSync(out, { recursive: true, mode: 0o700 });

	const campaignRoot = join(out, TRUST_BOOTSTRAP_CAMPAIGN_ROOT);
	const stagingRoot = join(out, TRUST_BOOTSTRAP_STAGING_ROOT);
	const execParent = join(out, "exec-parent");
	for (const dir of [campaignRoot, stagingRoot, execParent]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	// APFS on macOS increments directory hardLinkCount when regular files
	// are added (non-POSIX). Observe only after the leaf files exist so the
	// authority roots match the descriptors the supervisor will open.
	const issuedAt = new Date().toISOString();
	// Full-matrix campaigns run for many wall hours (high-rate legs alone can
	// take tens of minutes each). Twelve hours expires mid-resume; seventy-two
	// covers a local overnight seal loop without reminting mid-flight.
	const notAfter = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
	const placeholderAuthoritySha256 = "0".repeat(64);
	const placeholderLock = {
		...R1_CAMPAIGN_LOCK,
		authoritySha256: placeholderAuthoritySha256,
		createdAt: issuedAt,
	};
	const placeholderCapability = {
		...R1_STAGED_CAPABILITY_V1,
		authoritySha256: placeholderAuthoritySha256,
		lockSha256: sha256Hex(canonicalBytes(placeholderLock)),
		hostSubmissions: [
			{ hostId: "mac-controller-01" },
			{ hostId: "linux-bench-01" },
		],
		issuedAt,
		notAfter,
		fixtureOnly: false as const,
	};
	const placeholderManifest = {
		...R1_CAMPAIGN_MANIFEST_V1,
		authoritySha256: placeholderAuthoritySha256,
		lockSha256: sha256Hex(canonicalBytes(placeholderLock)),
		capabilitySha256: sha256Hex(canonicalBytes(placeholderCapability)),
		candidate: R1_CANDIDATE_ID,
		campaignId: R1_CAMPAIGN_ID,
		sealedAt: issuedAt,
	};
	const prestage = stageTrustBootstrap(out, {
		authorityBytes: canonicalBytes({
			...R1_CAMPAIGN_AUTHORITY,
			issuedAt,
			notAfter,
		}),
		authoritySha256Hex: sha256Hex(
			canonicalBytes({
				...R1_CAMPAIGN_AUTHORITY,
				issuedAt,
				notAfter,
			}),
		),
		campaignLockBytes: canonicalBytes(placeholderLock),
		stagedCapabilityBytes: canonicalBytes(placeholderCapability),
		manifestBytes: canonicalBytes(placeholderManifest),
	});
	if (!prestage.ok) {
		process.stderr.write(
			`mint-live-trust-bootstrap: prestage failed (${prestage.code}): ${prestage.message}\n`,
		);
		return 1;
	}

	const [macCampaign, macStaging, macExecParent] = await Promise.all([
		observeDirectory(campaignRoot),
		observeDirectory(stagingRoot),
		observeDirectory(execParent),
	]);

	const authority = {
		...R1_CAMPAIGN_AUTHORITY,
		issuedAt,
		notAfter,
		roots: [
			{
				hostId: "mac-controller-01",
				kind: "mac-campaign" as const,
				identity: macCampaign,
			},
			{
				hostId: "mac-controller-01",
				kind: "mac-staging" as const,
				identity: macStaging,
			},
			{
				hostId: "linux-bench-01",
				kind: "linux-staging" as const,
				identity: R1_LINUX_DIRECTORY_IDENTITY,
			},
			{
				hostId: "mac-controller-01",
				kind: "mac-exec-parent" as const,
				identity: macExecParent,
			},
		],
	};
	const authorityBytes = canonicalBytes(authority);
	const authoritySha256 = sha256Hex(authorityBytes);

	const lock = {
		...R1_CAMPAIGN_LOCK,
		authoritySha256,
		createdAt: issuedAt,
	};
	const lockBytes = canonicalBytes(lock);
	const lockSha256 = sha256Hex(lockBytes);

	const capability = {
		...R1_STAGED_CAPABILITY_V1,
		authoritySha256,
		lockSha256,
		// Rust StagedCapabilityV1::parse requires hostSubmissions entries to
		// contain only `hostId` (exact_fields). The fixture's rich submissions
		// are for TS tests, not the live supervisor parser.
		hostSubmissions: [
			{ hostId: "mac-controller-01" },
			{ hostId: "linux-bench-01" },
		],
		macCampaignIdentity: macCampaign,
		issuedAt,
		notAfter,
		fixtureOnly: false as const,
		macStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[0].stagedArchiveSha256,
		linuxStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[1].stagedArchiveSha256,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
		sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
	};
	const capabilityBytes = canonicalBytes(capability);
	const capabilitySha256 = sha256Hex(capabilityBytes);

	const manifest = {
		...R1_CAMPAIGN_MANIFEST_V1,
		authoritySha256,
		lockSha256,
		capabilitySha256,
		candidate: R1_CANDIDATE_ID,
		campaignId: R1_CAMPAIGN_ID,
		sealedAt: issuedAt,
		// Rust manifest_component_lists exact_fields each descriptor to
		// `["components"]` only; the fixture's richer descriptor records
		// are for TypeScript tests, not the live supervisor parser.
		descriptors: R1_CAMPAIGN_MANIFEST_V1.descriptors.map((descriptor) => ({
			components: descriptor.components,
		})),
	};
	const manifestBytes = canonicalBytes(manifest);

	// Overwrite the placeholders in place (same leaf count → same APFS nlink).
	const staged = stageTrustBootstrap(out, {
		authorityBytes,
		authoritySha256Hex: authoritySha256,
		campaignLockBytes: lockBytes,
		stagedCapabilityBytes: capabilityBytes,
		manifestBytes,
	});
	if (!staged.ok) {
		process.stderr.write(
			`mint-live-trust-bootstrap: stage failed (${staged.code}): ${staged.message}\n`,
		);
		return 1;
	}

	const receipt = {
		schema: "live-trust-bootstrap/v1",
		stagedDir: staged.paths.stagedDir,
		authoritySha256,
		lockSha256,
		capabilitySha256: staged.paths.digests.capability,
		manifestSha256: staged.paths.digests.manifest,
		paths: staged.paths,
		issuedAt,
		notAfter,
		note: "Promote authoritySha256 into R1_CAMPAIGN_AUTHORITY_ANCHOR_SET before official quarantine release.",
	};
	writeFileSync(
		join(out, "live-bootstrap-receipt.json"),
		`${JSON.stringify(receipt, null, 2)}\n`,
		{ mode: 0o600 },
	);
	process.stdout.write(
		`mint-live-trust-bootstrap: staged under ${out}\n` +
			`  authoritySha256: ${authoritySha256}\n` +
			`  campaignRoot: ${staged.paths.campaignRootDir}\n` +
			`  stagingRoot: ${staged.paths.stagingRootDir}\n`,
	);
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		process.stderr.write(
			`mint-live-trust-bootstrap: ${(error as Error).message}\n`,
		);
		process.exit(1);
	}
}
