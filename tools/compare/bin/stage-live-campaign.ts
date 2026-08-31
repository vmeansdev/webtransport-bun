/**
 * Live campaign staging CLI (plan §9 / A5 stage-only).
 *
 * Public operator subcommands: stage-only, abandon, freeze-run-command,
 * verify-stage-approval, cleanup-signing-keys, recover-rig-key.
 * Implementation-internal (callable only by stage-only or rig-resident staged
 * copy): prestage, observe-linux, mint, install-minted, verify-stage.
 *
 * Fail-closed: missing `_wtcompare` / sudo / key roots → typed REFUSED exit,
 * never STAGE_ONLY_OK with synthetic digests.
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../canonical.ts";
import {
	generateEd25519KeyPair,
	type Sha256Hex,
} from "../cross-supervisor-protocol.ts";
import {
	stageTrustBootstrap,
	TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	TRUST_BOOTSTRAP_AUTHORITY_LEAF,
	TRUST_BOOTSTRAP_CAPABILITY_LEAF,
	TRUST_BOOTSTRAP_LOCK_LEAF,
	TRUST_BOOTSTRAP_MANIFEST_LEAF,
	verifyStagedTrustBootstrap,
} from "../remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "../scenario-registry.ts";

function canonicalBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalJson(value));
}
export const PUBLIC_SUBCOMMANDS = [
	"stage-only",
	"abandon",
	"freeze-run-command",
	"verify-stage-approval",
	"cleanup-signing-keys",
	"recover-rig-key",
] as const;

export const INTERNAL_SUBCOMMANDS = [
	"prestage",
	"observe-linux",
	"mint",
	"install-minted",
	"verify-stage",
] as const;

export type StageSubcommand =
	| (typeof PUBLIC_SUBCOMMANDS)[number]
	| (typeof INTERNAL_SUBCOMMANDS)[number];

export const TRUST_FIXTURE_ONLY_MINT_FORBIDDEN =
	"TRUST_FIXTURE_ONLY_MINT_FORBIDDEN" as const;

/** Typed env refusal class for missing/stale staging identity (plan §7). */
export const REFUSED_STALE_OR_INVALID_STAGING =
	"REFUSED/STALE_OR_INVALID_STAGING" as const;
export const REFUSED_RIG_UNREACHABLE = "REFUSED/RIG_UNREACHABLE" as const;

export const EXIT_USAGE = 64 as const;
export const EXIT_STALE_OR_INVALID_STAGING = 65 as const;
export const EXIT_RIG_UNREACHABLE = 66 as const;
export const EXIT_CLEANUP_FAILED = 70 as const;

export const PRESTAGE_DIRS = [
	"bin",
	"campaign-root",
	"incoming",
	"prebuilds",
	"roles",
	"staging-root",
	"replay/mac-records",
	"replay/rig-records",
] as const;

export const MAC_KEY_ROOT = "/var/db/webtransport-bun/comparison/keys";
export const MAC_RUNTIME_ROOT =
	"/usr/local/libexec/webtransport-bun/comparison";
export const RIG_KEY_ROOT = "/var/lib/webtransport-bun/comparison/keys";
export const RIG_LEASE_ROOT = "/var/lib/webtransport-bun/comparison/leases";
export const WTCOMPARE_USER = "_wtcompare" as const;

export interface LiveStageReceiptV1 {
	readonly schema: "live-stage-receipt/v1";
	readonly stageProfile: "phase-a" | "phase-b";
	readonly candidate: string;
	readonly candidateHead: string;
	readonly candidateTreeOid: string;
	readonly campaignId: string;
	readonly sourceArchivePath: string;
	readonly archiveSha256: Sha256Hex;
	readonly archiveSize: number;
	readonly archiveMemberCount: number;
	readonly archiveMemberInventorySha256: Sha256Hex;
	readonly authoritySha256: Sha256Hex;
	readonly capabilitySha256: Sha256Hex;
	readonly lockSha256: Sha256Hex;
	readonly manifestSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly macSigningPublicKeyLeaf: "mac-supervisor-ed25519.pub";
	readonly macSigningPublicKeySha256: Sha256Hex;
	readonly rigSigningPublicKeyLeaf: "rig-supervisor-ed25519.pub";
	readonly rigSigningPublicKeySha256: Sha256Hex;
	readonly macBunSha256: Sha256Hex;
	readonly linuxBunSha256: Sha256Hex;
	readonly macSupervisorSha256: Sha256Hex;
	readonly linuxSupervisorSha256: Sha256Hex;
	readonly macObserverSha256: Sha256Hex;
	readonly linuxObserverSha256: Sha256Hex;
	readonly macAddonManifestSha256: Sha256Hex;
	readonly linuxAddonManifestSha256: Sha256Hex;
	readonly serverEntrypointSha256: Sha256Hex;
	readonly fanoutRoleEntrypointSha256: Sha256Hex | null;
	readonly stageToolEntrypointSha256: Sha256Hex;
	readonly stagedServerLaunchRecordSha256: Sha256Hex;
	readonly rigSigningKeyLeaseSha256: Sha256Hex;
	readonly macDirectoryIdentitySha256: Sha256Hex;
	readonly linuxDirectoryIdentitySha256: Sha256Hex;
	readonly externalTrustBoundSha256: Sha256Hex;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export interface LinuxStageObservationV1 {
	readonly schema: "linux-stage-observation/v1";
	readonly candidate: string;
	readonly campaignId: string;
	readonly directoryIdentity: Record<string, unknown>;
	readonly directoryIdentitySha256: Sha256Hex;
	readonly linuxBunSha256: Sha256Hex;
	readonly linuxSupervisorSha256: Sha256Hex;
	readonly linuxObserverSha256: Sha256Hex;
	readonly linuxAddonManifestSha256: Sha256Hex;
	readonly serverEntrypointSha256: Sha256Hex;
	readonly fanoutRoleEntrypointSha256: Sha256Hex | null;
	readonly stageToolEntrypointSha256: Sha256Hex;
	readonly macSigningPublicKeySha256: Sha256Hex;
	readonly rigSigningPublicKeySha256: Sha256Hex;
	readonly rigSigningKeyLeaseSha256: Sha256Hex;
}

export interface RigSigningKeyLeaseV1 {
	readonly schema: "rig-signing-key-lease/v1";
	readonly candidate: string;
	readonly campaignId: string;
	readonly rigPublicKeySha256: Sha256Hex;
	readonly privateKeyPath: string;
	readonly leasePath: string;
	readonly ownerUid: typeof WTCOMPARE_USER;
	readonly janitorUnit: string;
	readonly state: "armed";
	readonly armedAtMs: number;
	readonly notAfterMs: number;
	readonly lastTransitionAtMs: number;
	readonly lastTransitionReason: "stage-only-commit";
}

/** Finalized pre-traffic approval record (plan ExactStageApprovalV1). No self-hash. */
export interface ExactStageApprovalV1 {
	readonly schema: "exact-stage-approval/v1";
	readonly campaignId: string;
	readonly executionPurpose: string;
	readonly stageProfile: "phase-a" | "phase-b";
	readonly runSection: "9.5" | "9.6" | "9.7";
	readonly worktree: string;
	readonly candidateHead: string;
	readonly stageReceiptSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly upcomingRunCommandSha256: Sha256Hex;
	readonly architectReviewPath: string;
	readonly architectReviewSha256: Sha256Hex;
	readonly criticReviewPath: string;
	readonly criticReviewSha256: Sha256Hex;
	readonly finalizedAtMs: number;
}

export const EXACT_STAGE_REVIEW_LABELS = [
	"Stage receipt SHA-256",
	"Upcoming run command SHA-256",
	"Candidate HEAD",
	"Worktree",
	"Campaign ID",
] as const;

export type ExactStageReviewBindings = {
	readonly stageReceiptSha256: string;
	readonly upcomingRunCommandSha256: string;
	readonly candidateHead: string;
	readonly worktree: string;
	readonly campaignId: string;
};

function sha256Bytes(bytes: Uint8Array | string): Sha256Hex {
	return createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
}

function sha256File(path: string): Sha256Hex {
	return sha256Bytes(new Uint8Array(readFileSync(path)));
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const GIT_HEAD_RE = /^[0-9a-f]{40}$/;

/** Extract a required review binding label; missing or duplicated → fail. */
export function extractExactStageReviewLabel(
	body: string,
	label: (typeof EXACT_STAGE_REVIEW_LABELS)[number],
): string {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^- ${escaped}: \\\`?([^\\\`\\n]+?)\\\`?\\s*$`, "gm");
	const matches = [...body.matchAll(re)].map((m) => (m[1] ?? "").trim());
	if (matches.length === 0) {
		throw new Error(`EXACT_STAGE_APPROVAL_LABEL_MISSING:${label}`);
	}
	if (matches.length > 1) {
		throw new Error(`EXACT_STAGE_APPROVAL_LABEL_DUPLICATE:${label}`);
	}
	return matches[0]!;
}

export function parseExactStageReviewBindings(
	body: string,
): ExactStageReviewBindings {
	const lines = body.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== "APPROVED") {
		throw new Error("EXACT_STAGE_APPROVAL_REVIEW_NOT_APPROVED");
	}
	return {
		stageReceiptSha256: extractExactStageReviewLabel(
			body,
			"Stage receipt SHA-256",
		),
		upcomingRunCommandSha256: extractExactStageReviewLabel(
			body,
			"Upcoming run command SHA-256",
		),
		candidateHead: extractExactStageReviewLabel(body, "Candidate HEAD"),
		worktree: extractExactStageReviewLabel(body, "Worktree"),
		campaignId: extractExactStageReviewLabel(body, "Campaign ID"),
	};
}

/** Same-directory proof: inode/device/platform (+ volumeUuid on Darwin). */
export function directoryIdentitySameRoot(
	observed: Record<string, unknown>,
	expected: Record<string, unknown>,
): boolean {
	if (observed.platform !== expected.platform) return false;
	if (String(observed.inode) !== String(expected.inode)) return false;
	if (observed.platform === "darwin") {
		return (
			String(observed.device) === String(expected.device) &&
			String(observed.volumeUuid ?? "") === String(expected.volumeUuid ?? "")
		);
	}
	if (observed.platform === "linux") {
		return (
			String(observed.deviceMajor) === String(expected.deviceMajor) &&
			String(observed.deviceMinor) === String(expected.deviceMinor)
		);
	}
	return false;
}

function requireSha256Hex(value: string, label: string): Sha256Hex {
	if (!SHA256_HEX_RE.test(value)) {
		throw new Error(`EXACT_STAGE_APPROVAL_BAD_DIGEST:${label}`);
	}
	return value as Sha256Hex;
}

function parseExactStageApproval(raw: unknown): ExactStageApprovalV1 {
	if (!raw || typeof raw !== "object") {
		throw new Error("EXACT_STAGE_APPROVAL_SCHEMA");
	}
	const o = raw as Record<string, unknown>;
	if (o.schema !== "exact-stage-approval/v1") {
		throw new Error("EXACT_STAGE_APPROVAL_SCHEMA");
	}
	const stageProfile = o.stageProfile;
	const runSection = o.runSection;
	if (stageProfile !== "phase-a" && stageProfile !== "phase-b") {
		throw new Error("EXACT_STAGE_APPROVAL_SCHEMA");
	}
	if (runSection !== "9.5" && runSection !== "9.6" && runSection !== "9.7") {
		throw new Error("EXACT_STAGE_APPROVAL_SCHEMA");
	}
	for (const key of [
		"campaignId",
		"executionPurpose",
		"worktree",
		"candidateHead",
		"architectReviewPath",
		"criticReviewPath",
	] as const) {
		if (typeof o[key] !== "string" || (o[key] as string).length === 0) {
			throw new Error(`EXACT_STAGE_APPROVAL_SCHEMA:${key}`);
		}
	}
	if (
		typeof o.finalizedAtMs !== "number" ||
		!Number.isFinite(o.finalizedAtMs)
	) {
		throw new Error("EXACT_STAGE_APPROVAL_SCHEMA:finalizedAtMs");
	}
	return {
		schema: "exact-stage-approval/v1",
		campaignId: o.campaignId as string,
		executionPurpose: o.executionPurpose as string,
		stageProfile,
		runSection,
		worktree: o.worktree as string,
		candidateHead: o.candidateHead as string,
		stageReceiptSha256: requireSha256Hex(
			String(o.stageReceiptSha256),
			"stageReceiptSha256",
		),
		approvedPlanSha256: requireSha256Hex(
			String(o.approvedPlanSha256),
			"approvedPlanSha256",
		),
		approvalRecordSha256: requireSha256Hex(
			String(o.approvalRecordSha256),
			"approvalRecordSha256",
		),
		upcomingRunCommandSha256: requireSha256Hex(
			String(o.upcomingRunCommandSha256),
			"upcomingRunCommandSha256",
		),
		architectReviewPath: o.architectReviewPath as string,
		architectReviewSha256: requireSha256Hex(
			String(o.architectReviewSha256),
			"architectReviewSha256",
		),
		criticReviewPath: o.criticReviewPath as string,
		criticReviewSha256: requireSha256Hex(
			String(o.criticReviewSha256),
			"criticReviewSha256",
		),
		finalizedAtMs: o.finalizedAtMs,
	};
}

export async function verifyExactStageApproval(args: {
	readonly stageReceiptPath: string;
	readonly upcomingRunCommandPath: string;
	readonly exactStageApprovalPath: string;
	readonly observeDirectoryIdentity?: (
		observerBin: string,
		dirPath: string,
	) => Promise<Record<string, unknown>>;
	readonly resolveObserverBin?: (worktree: string) => string | null;
	readonly resolveGitHead?: (worktree: string) => Promise<string>;
}): Promise<void> {
	for (const path of [
		args.stageReceiptPath,
		args.upcomingRunCommandPath,
		args.exactStageApprovalPath,
	]) {
		if (!existsSync(path)) {
			throw new Error("EXACT_STAGE_APPROVAL_MISSING");
		}
	}

	const approval = parseExactStageApproval(
		JSON.parse(readFileSync(args.exactStageApprovalPath, "utf8")),
	);
	const receiptSha = sha256File(args.stageReceiptPath);
	const commandSha = sha256File(args.upcomingRunCommandPath);
	const recordSha = sha256File(args.exactStageApprovalPath);
	const architectSha = sha256File(approval.architectReviewPath);
	const criticSha = sha256File(approval.criticReviewPath);

	if (receiptSha !== approval.stageReceiptSha256) {
		throw new Error("EXACT_STAGE_APPROVAL_RECEIPT_DIGEST_MISMATCH");
	}
	if (commandSha !== approval.upcomingRunCommandSha256) {
		throw new Error("EXACT_STAGE_APPROVAL_COMMAND_DIGEST_MISMATCH");
	}
	if (architectSha !== approval.architectReviewSha256) {
		throw new Error("EXACT_STAGE_APPROVAL_ARCHITECT_DIGEST_MISMATCH");
	}
	if (criticSha !== approval.criticReviewSha256) {
		throw new Error("EXACT_STAGE_APPROVAL_CRITIC_DIGEST_MISMATCH");
	}
	// Record digest is recomputed for fail-closed binding checks but is not
	// embedded in ExactStageApprovalV1 (no self-hash).
	void recordSha;

	const receipt = JSON.parse(
		readFileSync(args.stageReceiptPath, "utf8"),
	) as LiveStageReceiptV1;
	if (receipt.schema !== "live-stage-receipt/v1") {
		throw new Error("EXACT_STAGE_APPROVAL_RECEIPT_SCHEMA");
	}
	if (receipt.campaignId !== approval.campaignId) {
		throw new Error("EXACT_STAGE_APPROVAL_CAMPAIGN_MISMATCH");
	}
	if (receipt.candidateHead !== approval.candidateHead) {
		throw new Error("EXACT_STAGE_APPROVAL_HEAD_MISMATCH");
	}
	if (receipt.stageProfile !== approval.stageProfile) {
		throw new Error("EXACT_STAGE_APPROVAL_PROFILE_MISMATCH");
	}
	if (receipt.approvedPlanSha256 !== approval.approvedPlanSha256) {
		throw new Error("EXACT_STAGE_APPROVAL_PLAN_DIGEST_MISMATCH");
	}
	if (receipt.approvalRecordSha256 !== approval.approvalRecordSha256) {
		throw new Error("EXACT_STAGE_APPROVAL_PLAN_RECORD_DIGEST_MISMATCH");
	}
	if (!GIT_HEAD_RE.test(approval.candidateHead)) {
		throw new Error("EXACT_STAGE_APPROVAL_BAD_HEAD");
	}

	const architectBody = readFileSync(approval.architectReviewPath, "utf8");
	const criticBody = readFileSync(approval.criticReviewPath, "utf8");
	const architectBindings = parseExactStageReviewBindings(architectBody);
	const criticBindings = parseExactStageReviewBindings(criticBody);
	for (const bindings of [architectBindings, criticBindings]) {
		if (bindings.stageReceiptSha256 !== approval.stageReceiptSha256) {
			throw new Error("EXACT_STAGE_APPROVAL_BINDING_RECEIPT");
		}
		if (
			bindings.upcomingRunCommandSha256 !== approval.upcomingRunCommandSha256
		) {
			throw new Error("EXACT_STAGE_APPROVAL_BINDING_COMMAND");
		}
		if (bindings.candidateHead !== approval.candidateHead) {
			throw new Error("EXACT_STAGE_APPROVAL_BINDING_HEAD");
		}
		if (bindings.worktree !== approval.worktree) {
			throw new Error("EXACT_STAGE_APPROVAL_BINDING_WORKTREE");
		}
		if (bindings.campaignId !== approval.campaignId) {
			throw new Error("EXACT_STAGE_APPROVAL_BINDING_CAMPAIGN");
		}
	}

	const resolveGitHead =
		args.resolveGitHead ??
		(async (worktree: string) =>
			(
				await runChecked(
					["git", "-C", worktree, "rev-parse", "HEAD"],
					"verify-stage-approval HEAD",
				)
			).trim());
	const head = await resolveGitHead(approval.worktree);
	if (head !== approval.candidateHead) {
		throw new Error(
			`EXACT_STAGE_APPROVAL_HEAD_MISMATCH: live=${head} expected=${approval.candidateHead}`,
		);
	}

	const macTrust = dirname(args.stageReceiptPath);
	const authorityPath = join(macTrust, "authority.json");
	const linuxObservationPath = join(macTrust, "linux-stage-observation.json");
	if (!existsSync(authorityPath) || !existsSync(linuxObservationPath)) {
		throw new Error("EXACT_STAGE_APPROVAL_ROOT_ARTIFACT_MISSING");
	}
	const authority = JSON.parse(readFileSync(authorityPath, "utf8")) as {
		readonly roots?: ReadonlyArray<{
			readonly kind?: string;
			readonly identity?: Record<string, unknown>;
		}>;
	};
	const linuxObservation = JSON.parse(
		readFileSync(linuxObservationPath, "utf8"),
	) as LinuxStageObservationV1;
	if (linuxObservation.schema !== "linux-stage-observation/v1") {
		throw new Error("EXACT_STAGE_APPROVAL_LINUX_OBSERVATION_SCHEMA");
	}
	if (
		linuxObservation.directoryIdentitySha256 !==
		receipt.linuxDirectoryIdentitySha256
	) {
		throw new Error("EXACT_STAGE_APPROVAL_LINUX_IDENTITY_DIGEST_MISMATCH");
	}
	const linuxIdentityHash = sha256Bytes(
		canonicalJson(linuxObservation.directoryIdentity),
	);
	if (linuxIdentityHash !== linuxObservation.directoryIdentitySha256) {
		throw new Error("EXACT_STAGE_APPROVAL_LINUX_IDENTITY_REHASH_MISMATCH");
	}

	const roots = authority.roots ?? [];
	const macStagingExpected = roots.find(
		(r) => r.kind === "mac-staging",
	)?.identity;
	const linuxStagingExpected = roots.find(
		(r) => r.kind === "linux-staging",
	)?.identity;
	if (!macStagingExpected || !linuxStagingExpected) {
		throw new Error("EXACT_STAGE_APPROVAL_AUTHORITY_ROOTS_MISSING");
	}
	if (
		sha256Bytes(canonicalJson(macStagingExpected)) !==
		receipt.macDirectoryIdentitySha256
	) {
		throw new Error("EXACT_STAGE_APPROVAL_MAC_IDENTITY_RECEIPT_MISMATCH");
	}
	if (
		!directoryIdentitySameRoot(
			linuxObservation.directoryIdentity,
			linuxStagingExpected,
		)
	) {
		throw new Error("EXACT_STAGE_APPROVAL_LINUX_ROOT_MUTATION");
	}

	const resolveObserverBin =
		args.resolveObserverBin ??
		((worktree: string) => {
			const candidate = join(
				worktree,
				"target/release/observe-directory-identity",
			);
			return existsSync(candidate) ? candidate : null;
		});
	const observerBin = resolveObserverBin(approval.worktree);
	if (!observerBin) {
		throw new Error("EXACT_STAGE_APPROVAL_OBSERVER_MISSING");
	}
	const observe = args.observeDirectoryIdentity ?? observeDirectoryIdentity;
	const liveMacStaging = await observe(
		observerBin,
		join(macTrust, "staging-root"),
	);
	if (!directoryIdentitySameRoot(liveMacStaging, macStagingExpected)) {
		throw new Error("EXACT_STAGE_APPROVAL_MAC_ROOT_MUTATION");
	}
}

function parseFlag(argv: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	for (const arg of argv) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return undefined;
}

function requireFlag(argv: readonly string[], name: string): string {
	const value = parseFlag(argv, name);
	if (!value) throw new Error(`missing --${name}`);
	return value;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runCapture(
	cmd: string[],
	opts?: { readonly cwd?: string; readonly env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		cwd: opts?.cwd,
		env: opts?.env ? { ...process.env, ...opts.env } : process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

async function runChecked(
	cmd: string[],
	label: string,
	opts?: { readonly cwd?: string; readonly env?: Record<string, string> },
): Promise<string> {
	const result = await runCapture(cmd, opts);
	if (result.code !== 0) {
		throw new Error(
			`${label} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout;
}

export function isPublicSubcommand(
	value: string,
): value is (typeof PUBLIC_SUBCOMMANDS)[number] {
	return (PUBLIC_SUBCOMMANDS as readonly string[]).includes(value);
}

export function isInternalSubcommand(
	value: string,
): value is (typeof INTERNAL_SUBCOMMANDS)[number] {
	return (INTERNAL_SUBCOMMANDS as readonly string[]).includes(value);
}

export function assertKnownSubcommand(value: string): StageSubcommand {
	if (isPublicSubcommand(value) || isInternalSubcommand(value)) return value;
	throw new Error(`unknown subcommand: ${value}`);
}

export function remainingLifetimeMarginMs(
	notAfterMs: number,
	nowMs: number,
	requiredRemainingMs: number,
): { readonly ok: true } | { readonly ok: false; readonly code: string } {
	if (notAfterMs - nowMs > requiredRemainingMs) return { ok: true };
	return { ok: false, code: "AUTHORITY_REMAINING_LIFETIME_INSUFFICIENT" };
}

export function cleanupSigningKeysIdempotent(paths: {
	readonly macPrivateKeyPath: string;
	readonly rigPrivateKeyPath: string;
}): { readonly ok: true; readonly destroyed: readonly string[] } {
	const destroyed: string[] = [];
	for (const p of [paths.macPrivateKeyPath, paths.rigPrivateKeyPath]) {
		if (existsSync(p)) {
			rmSync(p);
			destroyed.push(p);
		}
		if (existsSync(p)) {
			throw new Error(`cleanup failed: ${p} still present`);
		}
	}
	return { ok: true, destroyed };
}

export function roleLeavesForProfile(
	profile: "phase-a" | "phase-b",
): readonly string[] {
	return profile === "phase-a"
		? ["server.ts", "stage-live-campaign.ts"]
		: ["server.ts", "fanout-role.ts", "stage-live-campaign.ts"];
}

export function prestageRoot(args: {
	readonly root: string;
	readonly profile: "phase-a" | "phase-b";
	readonly repo?: string;
}): void {
	mkdirSync(args.root, { recursive: true, mode: 0o700 });
	for (const dir of PRESTAGE_DIRS) {
		mkdirSync(join(args.root, dir), { recursive: true, mode: 0o700 });
	}
	const roles = roleLeavesForProfile(args.profile);
	for (const leaf of roles) {
		const dest = join(args.root, "roles", leaf);
		if (args.repo) {
			const src =
				leaf === "server.ts"
					? join(args.repo, "tools/compare/server.ts")
					: leaf === "stage-live-campaign.ts"
						? join(args.repo, "tools/compare/bin/stage-live-campaign.ts")
						: join(args.repo, "tools/compare/bin/fanout-role.ts");
			if (!existsSync(src)) {
				throw new Error(`prestage missing role source: ${src}`);
			}
			copyFileSync(src, dest);
		} else {
			writeFileSync(dest, `// staged ${leaf}\n`, { mode: 0o644 });
		}
	}
}

export function writeStageReceipt(
	path: string,
	receipt: LiveStageReceiptV1,
): Sha256Hex {
	const bytes = `${canonicalJson(receipt)}\n`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, bytes, { mode: 0o644 });
	return sha256Bytes(bytes);
}

/** Test-only receipt factory. Live stage-only MUST NOT call this. */
export function buildMinimalStageReceipt(input: {
	readonly profile: "phase-a" | "phase-b";
	readonly candidate: string;
	readonly campaignId: string;
	readonly macPublicKeySha256: Sha256Hex;
	readonly rigPublicKeySha256: Sha256Hex;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}): LiveStageReceiptV1 {
	const H = (label: string) => sha256Bytes(label);
	const fanout = input.profile === "phase-a" ? null : H("fanout-role.ts");
	const externalTrustBoundSha256 = sha256Bytes(
		canonicalJson({
			schema: "external-trust-bound/v1",
			candidate: input.candidate,
			campaignId: input.campaignId,
			macSigningPublicKeySha256: input.macPublicKeySha256,
			rigSigningPublicKeySha256: input.rigPublicKeySha256,
		}),
	);
	return {
		schema: "live-stage-receipt/v1",
		stageProfile: input.profile,
		candidate: input.candidate,
		candidateHead: input.candidate,
		candidateTreeOid: H("tree"),
		campaignId: input.campaignId,
		sourceArchivePath: "source.tar",
		archiveSha256: H("archive"),
		archiveSize: 1,
		archiveMemberCount: 1,
		archiveMemberInventorySha256: H("inventory"),
		authoritySha256: H("authority"),
		capabilitySha256: H("capability"),
		lockSha256: H("lock"),
		manifestSha256: H("manifest"),
		approvedPlanSha256: H("plan"),
		approvalRecordSha256: H("approval"),
		macSigningPublicKeyLeaf: "mac-supervisor-ed25519.pub",
		macSigningPublicKeySha256: input.macPublicKeySha256,
		rigSigningPublicKeyLeaf: "rig-supervisor-ed25519.pub",
		rigSigningPublicKeySha256: input.rigPublicKeySha256,
		macBunSha256: H("mac-bun"),
		linuxBunSha256: H("linux-bun"),
		macSupervisorSha256: H("mac-supervisor"),
		linuxSupervisorSha256: H("linux-supervisor"),
		macObserverSha256: H("mac-observer"),
		linuxObserverSha256: H("linux-observer"),
		macAddonManifestSha256: H("mac-addon"),
		linuxAddonManifestSha256: H("linux-addon"),
		serverEntrypointSha256: H("server.ts"),
		fanoutRoleEntrypointSha256: fanout,
		stageToolEntrypointSha256: H("stage-live-campaign.ts"),
		stagedServerLaunchRecordSha256: H("launch"),
		rigSigningKeyLeaseSha256: H("lease"),
		macDirectoryIdentitySha256: H("mac-dir"),
		linuxDirectoryIdentitySha256: H("linux-dir"),
		externalTrustBoundSha256,
		issuedAtMs: input.issuedAtMs,
		notAfterMs: input.notAfterMs,
	};
}

/** Local keygen for unit tests only. Live stage-only uses supervisor keygen. */
export function mintLocalSigningKeys(args: {
	readonly stagingRoot: string;
	readonly macPrivateOut: string;
	readonly rigPrivateOut: string;
}): {
	readonly macPublicKeySha256: Sha256Hex;
	readonly rigPublicKeySha256: Sha256Hex;
} {
	if (existsSync(args.macPrivateOut) || existsSync(args.rigPrivateOut)) {
		throw new Error("TRUST_SIGNING_KEY_EXISTS");
	}
	mkdirSync(dirname(args.macPrivateOut), { recursive: true, mode: 0o700 });
	mkdirSync(dirname(args.rigPrivateOut), { recursive: true, mode: 0o700 });
	const mac = generateEd25519KeyPair();
	const rig = generateEd25519KeyPair();
	writeFileSync(args.macPrivateOut, mac.privatePkcs8Der, { mode: 0o400 });
	writeFileSync(args.rigPrivateOut, rig.privatePkcs8Der, { mode: 0o400 });
	writeFileSync(
		join(args.stagingRoot, "mac-supervisor-ed25519.pub"),
		mac.publicRaw32,
		{ mode: 0o644 },
	);
	writeFileSync(
		join(args.stagingRoot, "rig-supervisor-ed25519.pub"),
		rig.publicRaw32,
		{ mode: 0o644 },
	);
	return {
		macPublicKeySha256: mac.publicKeySha256,
		rigPublicKeySha256: rig.publicKeySha256,
	};
}

export function hashAddonManifest(prebuildRoot: string): Sha256Hex {
	if (!existsSync(prebuildRoot)) {
		return sha256Bytes(`empty-prebuilds:${prebuildRoot}`);
	}
	const names = readdirSync(prebuildRoot).sort();
	const parts: string[] = [];
	for (const name of names) {
		const full = join(prebuildRoot, name);
		const st = statSync(full);
		if (st.isFile()) {
			parts.push(`${name}:${sha256File(full)}`);
		}
	}
	return sha256Bytes(parts.join("\n"));
}

export async function observeDirectoryIdentity(
	observerBin: string,
	dirPath: string,
): Promise<Record<string, unknown>> {
	const result = await runCapture([observerBin, dirPath]);
	if (result.code !== 0) {
		throw new Error(
			`observe-directory-identity failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

export function macAdminProvisionCommands(): string {
	return [
		"# Mac admin (passwordless sudo required for A5 stage-only):",
		"sudo dscl . -create /Users/_wtcompare",
		"sudo dscl . -create /Users/_wtcompare UserShell /usr/bin/false",
		"sudo dscl . -create /Users/_wtcompare RealName 'WebTransport Compare'",
		"sudo dscl . -create /Users/_wtcompare UniqueID 499",
		"sudo dscl . -create /Users/_wtcompare PrimaryGroupID 20",
		"sudo dscl . -create /Users/_wtcompare NFSHomeDirectory /var/db/webtransport-bun",
		"sudo dscl . -append /Groups/staff GroupMembership _wtcompare",
		"echo '_wtcompare ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/wtcompare",
		"sudo chmod 440 /etc/sudoers.d/wtcompare",
		"sudo install -d -o root -g wheel -m 755 /usr/local/libexec/webtransport-bun/comparison",
		"sudo install -d -o _wtcompare -g staff -m 700 /var/db/webtransport-bun/comparison/keys",
	].join("\n");
}

export async function checkMacStagingIdentity(): Promise<
	{ readonly ok: true } | { readonly ok: false; readonly detail: string }
> {
	const id = await runCapture(["id", WTCOMPARE_USER]);
	if (id.code !== 0) {
		return {
			ok: false,
			detail: `Mac user ${WTCOMPARE_USER} missing. ${macAdminProvisionCommands()}`,
		};
	}
	const sudo = await runCapture([
		"/usr/bin/sudo",
		"-n",
		"-u",
		WTCOMPARE_USER,
		"true",
	]);
	if (sudo.code !== 0) {
		return {
			ok: false,
			detail: `passwordless sudo -n -u ${WTCOMPARE_USER} unavailable on Mac. ${macAdminProvisionCommands()}`,
		};
	}
	return { ok: true };
}

export async function checkRigStagingIdentity(args: {
	readonly rig: string;
	readonly sshKey: string;
}): Promise<
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly code:
				| typeof REFUSED_RIG_UNREACHABLE
				| typeof REFUSED_STALE_OR_INVALID_STAGING;
			readonly detail: string;
	  }
> {
	const ping = await runCapture([
		"ssh",
		"-i",
		args.sshKey,
		"-o",
		"ConnectTimeout=10",
		"-o",
		"BatchMode=yes",
		args.rig,
		"true",
	]);
	if (ping.code !== 0) {
		return {
			ok: false,
			code: REFUSED_RIG_UNREACHABLE,
			detail: `rig SSH unreachable: ${ping.stderr.trim()}`,
		};
	}
	const id = await runCapture([
		"ssh",
		"-i",
		args.sshKey,
		"-o",
		"ConnectTimeout=10",
		"-o",
		"BatchMode=yes",
		args.rig,
		// comparison/ is 0700 _wtcompare — operator cannot traverse; probe as that user.
		`id ${WTCOMPARE_USER} && sudo -n -u ${WTCOMPARE_USER} true && sudo -n -u ${WTCOMPARE_USER} test -d ${RIG_KEY_ROOT}`,
	]);
	if (id.code !== 0) {
		return {
			ok: false,
			code: REFUSED_STALE_OR_INVALID_STAGING,
			detail: `Linux ${WTCOMPARE_USER}/keys missing: ${id.stderr.trim() || id.stdout.trim()}`,
		};
	}
	return { ok: true };
}

function executionPurposeToSection(purpose: string): {
	section: "9.5" | "9.6" | "9.7";
	timeoutMs: number;
} {
	switch (purpose) {
		case "focused":
			return { section: "9.5", timeoutMs: 4_200_000 };
		case "pilot":
			return { section: "9.6", timeoutMs: 2_100_000 };
		case "canonical":
			return { section: "9.7", timeoutMs: 45_000_000 };
		default:
			throw new Error(`invalid --execution-purpose=${purpose}`);
	}
}

export function buildFrozenRunCommand(args: {
	readonly section: "9.5" | "9.6" | "9.7";
	readonly repo: string;
	readonly candidate: string;
	readonly campaignId: string;
	readonly executionPurpose: string;
	readonly stageReceipt: LiveStageReceiptV1;
	readonly macTrust: string;
	readonly macRuntime: string;
	readonly rig: string;
	readonly rigStage: string;
	readonly sshKey: string;
	readonly macBun: string;
	readonly out: string;
	readonly runTimeoutMs: number;
}): string {
	const r = args.stageReceipt;
	const fragmentDir = dirname(fileURLToPath(import.meta.url));
	const wrapper = readFileSync(
		join(fragmentDir, "frozen-run-wrapper.fragment.sh"),
		"utf8",
	);
	const sectionFragment = readFileSync(
		join(fragmentDir, `frozen-run-section-${args.section}.fragment.sh`),
		"utf8",
	);
	const preamble = [
		"set -euo pipefail",
		`REPO=${shellQuote(args.repo)}`,
		`CANDIDATE=${shellQuote(args.candidate)}`,
		`CAMPAIGN_ID=${shellQuote(args.campaignId)}`,
		`EXECUTION_PURPOSE=${shellQuote(args.executionPurpose)}`,
		`RUN_TIMEOUT_MS=${args.runTimeoutMs}`,
		`OUT=${shellQuote(args.out)}`,
		`MAC_TRUST=${shellQuote(args.macTrust)}`,
		`MAC_RUNTIME=${shellQuote(args.macRuntime)}`,
		`RIG=${shellQuote(args.rig)}`,
		`RIG_STAGE=${shellQuote(args.rigStage)}`,
		`SSH_KEY=${shellQuote(args.sshKey)}`,
		`MAC_BUN=${shellQuote(args.macBun)}`,
		`MAC_PUBLIC_KEY_SHA256=${shellQuote(r.macSigningPublicKeySha256)}`,
		`RIG_PUBLIC_KEY_SHA256=${shellQuote(r.rigSigningPublicKeySha256)}`,
		`STAGE_NOT_AFTER_MS=${r.notAfterMs}`,
		`CAPABILITY_SHA256=${shellQuote(r.capabilitySha256)}`,
		`LOCK_SHA256=${shellQuote(r.lockSha256)}`,
		`ARCHIVE_SHA256=${shellQuote(r.archiveSha256)}`,
		`EXTERNAL_TRUST_BOUND_SHA256=${shellQuote(r.externalTrustBoundSha256)}`,
		`RUN_SECTION=${shellQuote(args.section)}`,
		'export COMPARISON_SUPERVISOR_BINARY="$MAC_RUNTIME/comparison-supervisor"',
		'export COMPARISON_SUPERVISOR_BUN_PATH="$MAC_RUNTIME/bun"',
		'export COMPARISON_MAC_SIGNING_KEY="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"',
		"export COMPARISON_MAC_SUPERVISOR_USER=_wtcompare",
		'export COMPARISON_RIG_STAGED_DIR="$RIG_STAGE"',
		'export COMPARISON_RIG_SUPERVISOR_BINARY="$RIG_STAGE/bin/comparison-supervisor"',
		'export COMPARISON_RIG_SIGNING_KEY="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"',
		"export COMPARISON_RIG_BUN_PATH=/home/hermes-admin/.bun/bin/bun",
		'export COMPARISON_SSH_IDENTITY="$SSH_KEY"',
		'export COMPARISON_SSH_TARGET="$RIG"',
	].join("\n");
	return `${preamble}\n${wrapper.trimEnd()}\n${sectionFragment.trimEnd()}\n`;
}

async function archiveSource(
	repo: string,
	candidate: string,
	archivePath: string,
): Promise<{
	archiveSha256: Sha256Hex;
	archiveSize: number;
	archiveMemberCount: number;
	archiveMemberInventorySha256: Sha256Hex;
	candidateTreeOid: string;
}> {
	mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
	await runChecked(
		[
			"git",
			"-C",
			repo,
			"archive",
			"--format=tar",
			candidate,
			"-o",
			archivePath,
		],
		"git archive",
	);
	const inventory = await runChecked(
		["tar", "-tf", archivePath],
		"tar inventory",
	);
	const members = inventory
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.sort();
	const inventoryText = `${members.join("\n")}\n`;
	const inventoryPath = join(
		dirname(archivePath),
		"archive-member-inventory.txt",
	);
	writeFileSync(inventoryPath, inventoryText, { mode: 0o644 });
	const treeOid = (
		await runChecked(
			["git", "-C", repo, "rev-parse", `${candidate}^{tree}`],
			"git tree oid",
		)
	).trim();
	const st = statSync(archivePath);
	return {
		archiveSha256: sha256File(archivePath),
		archiveSize: st.size,
		archiveMemberCount: members.length,
		archiveMemberInventorySha256: sha256Bytes(inventoryText),
		candidateTreeOid: treeOid,
	};
}

async function buildMacArchived(args: {
	readonly macBun: string;
	readonly archivePath: string;
	readonly buildDir: string;
}): Promise<void> {
	mkdirSync(args.buildDir, { recursive: true, mode: 0o700 });
	await runChecked(
		["tar", "-xf", args.archivePath, "-C", args.buildDir],
		"tar extract mac",
	);
	await runChecked(
		[args.macBun, "install", "--frozen-lockfile"],
		"mac bun install",
		{ cwd: args.buildDir },
	);
	await runChecked(
		[
			"cargo",
			"build",
			"-p",
			"native",
			"--release",
			"--bin",
			"comparison-supervisor",
			"--bin",
			"observe-directory-identity",
		],
		"mac cargo build",
		{ cwd: args.buildDir },
	);
	await runChecked([args.macBun, "run", "build:native"], "mac build:native", {
		cwd: args.buildDir,
	});
}

export function writeArmedLease(args: {
	readonly candidate: string;
	readonly campaignId: string;
	readonly rigPublicKeySha256: Sha256Hex;
	readonly notAfterMs: number;
	readonly outPath: string;
}): { lease: RigSigningKeyLeaseV1; sha256: Sha256Hex } {
	const armedAtMs = Date.now();
	const lease: RigSigningKeyLeaseV1 = {
		schema: "rig-signing-key-lease/v1",
		candidate: args.candidate,
		campaignId: args.campaignId,
		rigPublicKeySha256: args.rigPublicKeySha256,
		privateKeyPath: `${RIG_KEY_ROOT}/${args.candidate}/${args.campaignId}.rig.pk8`,
		leasePath: `${RIG_LEASE_ROOT}/${args.candidate}/${args.campaignId}.lease.json`,
		ownerUid: WTCOMPARE_USER,
		janitorUnit: `wtcompare-rig-key-janitor@${args.candidate}-${args.campaignId}.service`,
		state: "armed",
		armedAtMs,
		notAfterMs: args.notAfterMs,
		lastTransitionAtMs: armedAtMs,
		lastTransitionReason: "stage-only-commit",
	};
	const bytes = `${canonicalJson(lease)}\n`;
	mkdirSync(dirname(args.outPath), { recursive: true, mode: 0o700 });
	writeFileSync(args.outPath, bytes, { mode: 0o644 });
	return { lease, sha256: sha256Bytes(bytes) };
}

async function runObserveLinux(argv: readonly string[]): Promise<number> {
	const candidate = requireFlag(argv, "candidate");
	const campaignId = requireFlag(argv, "campaign-id");
	const root = requireFlag(argv, "root");
	const observer = requireFlag(argv, "observer");
	const out = requireFlag(argv, "out");
	const identity = await observeDirectoryIdentity(observer, root);
	const bunPath =
		parseFlag(argv, "bun-path") ?? "/home/hermes-admin/.bun/bin/bun";
	const supervisor = join(root, "bin/comparison-supervisor");
	const server = join(root, "roles/server.ts");
	const stageTool = join(root, "roles/stage-live-campaign.ts");
	const fanout = join(root, "roles/fanout-role.ts");
	const macPub = join(root, "staging-root/mac-supervisor-ed25519.pub");
	const rigPub = join(root, "staging-root/rig-supervisor-ed25519.pub");
	const leasePath = join(root, "staging-root/rig-signing-key-lease.armed.json");
	if (!existsSync(leasePath)) {
		process.stderr.write("observe-linux missing armed lease snapshot\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	const observation: LinuxStageObservationV1 = {
		schema: "linux-stage-observation/v1",
		candidate,
		campaignId,
		directoryIdentity: identity,
		directoryIdentitySha256: sha256Bytes(canonicalJson(identity)),
		linuxBunSha256: sha256File(bunPath),
		linuxSupervisorSha256: sha256File(supervisor),
		linuxObserverSha256: sha256File(observer),
		linuxAddonManifestSha256: hashAddonManifest(join(root, "prebuilds")),
		serverEntrypointSha256: sha256File(server),
		fanoutRoleEntrypointSha256: existsSync(fanout) ? sha256File(fanout) : null,
		stageToolEntrypointSha256: sha256File(stageTool),
		macSigningPublicKeySha256: sha256File(macPub),
		rigSigningPublicKeySha256: sha256File(rigPub),
		rigSigningKeyLeaseSha256: sha256File(leasePath),
	};
	writeFileSync(out, `${canonicalJson(observation)}\n`, { mode: 0o644 });
	process.stdout.write("OBSERVE_LINUX_OK\n");
	return 0;
}

export const LIVE_AUTHORITY_FIELDS = [
	"schema",
	"candidate",
	"campaignId",
	"issuedAt",
	"notAfter",
	"campaignReservationSha256",
	"approval",
	"source",
	"topology",
	"roots",
] as const;

export const LIVE_AUTHORITY_APPROVAL_FIELDS = [
	"parentPlanSha256",
	"parentDesignSha256",
	"amendmentSha256",
	"finalCandidateHead",
	"sourceArchiveReceiptSha256",
	"r1RedApprovalBundleSha256",
	"finalArchitectApprovalSha256",
	"finalCriticApprovalSha256",
	"finalVerifierApprovalSha256",
] as const;

export const LIVE_LOCK_FIELDS = [
	"schema",
	"authoritySha256",
	"candidate",
	"campaignId",
	"sourceArchiveReceiptSha256",
	"r1RedApprovalBundleSha256",
	"sourceArchiveSha256",
	"registryHash",
	"scheduleHash",
	"capacityProfileHash",
	"tlsPlanHash",
	"topologyPlanHash",
	"executionPlanHash",
	"cardinality",
	"createdAt",
] as const;

export const LIVE_CAPABILITY_FIELDS = [
	"schema",
	"authoritySha256",
	"lockSha256",
	"candidate",
	"campaignId",
	"sourceArchiveReceiptSha256",
	"r1RedApprovalBundleSha256",
	"sourceArchiveSha256",
	"macStagedArchiveSha256",
	"linuxStagedArchiveSha256",
	"hostSubmissions",
	"sshHostReceiptSha256",
	"macCampaignIdentity",
	"issuedAt",
	"notAfter",
	"fixtureOnly",
] as const;

export function buildLiveMintRecords(args: {
	readonly profile: "phase-a" | "phase-b";
	readonly repo: string;
	readonly candidate: string;
	readonly campaignId: string;
	readonly candidateTreeOid: string;
	readonly issuedAt: string;
	readonly notAfter: string;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly sourceArchiveSha256: Sha256Hex;
	readonly sourceArchiveSize: number;
	readonly archiveMemberCount: number;
	readonly archiveMemberInventorySha256: Sha256Hex;
	readonly macBunSha256: Sha256Hex;
	readonly linuxBunSha256: Sha256Hex;
	readonly macSupervisorSha256: Sha256Hex;
	readonly linuxSupervisorSha256: Sha256Hex;
	readonly macCampaignIdentity: Record<string, unknown>;
	readonly macStagingIdentity: Record<string, unknown>;
	readonly linuxStagingIdentity: Record<string, unknown>;
	readonly macExecIdentity: Record<string, unknown>;
}) {
	const finalCandidateHead = args.candidate.slice(0, 40);
	if (!/^[0-9a-f]{40}$/i.test(finalCandidateHead)) {
		throw new Error("candidate must begin with a 40-hex git HEAD");
	}

	const campaignReservation = {
		schema: "campaign-reservation/v1",
		candidate: args.candidate,
		campaignId: args.campaignId,
		campaignIdentity: args.macCampaignIdentity,
		supervisorInstanceNonce: sha256Bytes(
			`a5-live-reservation:${args.candidate}:${args.campaignId}`,
		),
		state: "RESERVED",
		createdAt: args.issuedAt,
	};
	const campaignReservationSha256 = sha256Bytes(
		canonicalBytes(campaignReservation),
	);

	const sourceArchiveReceipt = {
		schema: "source-archive-receipt/v1",
		candidate: args.candidate,
		finalCandidateHead,
		finalCandidateTreeOid: args.candidateTreeOid,
		sourceArchiveSha256: args.sourceArchiveSha256,
		sourceArchiveSize: args.sourceArchiveSize,
		archiveMemberInventorySha256: args.archiveMemberInventorySha256,
		archiveMemberCount: args.archiveMemberCount,
		producedAt: args.issuedAt,
	};
	const sourceArchiveReceiptSha256 = sha256Bytes(
		canonicalBytes(sourceArchiveReceipt),
	);

	const r1RedApprovalBundle = {
		schema: "r1-red-approval-bundle/v1",
		worktree: args.repo,
		redHead: finalCandidateHead,
		redSuiteSha256: args.approvalRecordSha256,
		records: [
			{
				role: "focused-a5-architect-critic-verifier",
				sha256: args.approvalRecordSha256,
				signedAt: args.issuedAt,
			},
		],
	};
	const r1RedApprovalBundleSha256 = sha256Bytes(
		canonicalBytes(r1RedApprovalBundle),
	);

	const sshHostReceipt = {
		schema: "ssh-host-receipt/v1",
		linuxHostId: "linux-bench-01",
		controlPeerAddress: "10.99.0.2:22",
		sessionNonceSha256: sha256Bytes(
			`a5-live-ssh:${args.candidate}:${args.campaignId}`,
		),
		linuxSupervisorSha256: args.linuxSupervisorSha256,
		connectedAt: args.issuedAt,
	};
	const sshHostReceiptSha256 = sha256Bytes(canonicalBytes(sshHostReceipt));

	const topology = {
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
		sshControlReceiptSha256: sshHostReceiptSha256,
		tailscaleMeasurementForbidden: true,
		loopbackForbidden: true,
	};
	const authority = {
		schema: "campaign-authority/v1",
		candidate: args.candidate,
		campaignId: args.campaignId,
		issuedAt: args.issuedAt,
		notAfter: args.notAfter,
		campaignReservationSha256,
		approval: {
			parentPlanSha256: args.approvedPlanSha256,
			parentDesignSha256: args.approvedPlanSha256,
			amendmentSha256: args.approvedPlanSha256,
			finalCandidateHead,
			sourceArchiveReceiptSha256,
			r1RedApprovalBundleSha256,
			finalArchitectApprovalSha256: args.approvalRecordSha256,
			finalCriticApprovalSha256: args.approvalRecordSha256,
			finalVerifierApprovalSha256: args.approvalRecordSha256,
		},
		source: {
			macBunSha256: args.macBunSha256,
			linuxBunSha256: args.linuxBunSha256,
			macSupervisorSha256: args.macSupervisorSha256,
			linuxSupervisorSha256: args.linuxSupervisorSha256,
		},
		topology,
		roots: [
			{
				hostId: "mac-controller-01",
				kind: "mac-campaign",
				identity: args.macCampaignIdentity,
			},
			{
				hostId: "mac-controller-01",
				kind: "mac-staging",
				identity: args.macStagingIdentity,
			},
			{
				hostId: "linux-bench-01",
				kind: "linux-staging",
				identity: args.linuxStagingIdentity,
			},
			{
				hostId: "mac-controller-01",
				kind: "mac-exec-parent",
				identity: args.macExecIdentity,
			},
		],
	};
	const authorityBytes = canonicalBytes(authority);
	const authoritySha256 = sha256Bytes(authorityBytes);

	const cardinality = { executionCount: 2, descriptorCount: 3 };
	const scheduleHash = sha256Bytes(
		canonicalBytes({
			schema: "focused-a5-schedule/v1",
			profile: args.profile,
			candidate: args.candidate,
			campaignId: args.campaignId,
			cardinality,
		}),
	);
	const lock = {
		schema: "campaign-lock/v1",
		authoritySha256,
		candidate: args.candidate,
		campaignId: args.campaignId,
		sourceArchiveReceiptSha256,
		r1RedApprovalBundleSha256,
		sourceArchiveSha256: args.sourceArchiveSha256,
		registryHash: CANONICAL_SCENARIO_REGISTRY.registryHash,
		scheduleHash,
		capacityProfileHash: CANONICAL_SCENARIO_REGISTRY.capacityProfileHash,
		tlsPlanHash: sha256Bytes("a5-live-tls-plan:wt-compare.local:4433"),
		topologyPlanHash: sha256Bytes(canonicalBytes(topology)),
		executionPlanHash: sha256Bytes(
			canonicalBytes({
				schema: "focused-a5-execution-plan/v1",
				profile: args.profile,
				executionCount: cardinality.executionCount,
			}),
		),
		cardinality,
		createdAt: args.issuedAt,
	};
	const lockBytes = canonicalBytes(lock);
	const lockSha256 = sha256Bytes(lockBytes);

	// Rust requires distinct staged digests. Bind the shared source archive to
	// each real host and DirectoryIdentity instead of inventing archive bytes.
	const macStagedArchiveSha256 = sha256Bytes(
		canonicalBytes({
			schema: "staged-archive-binding/v1",
			hostId: "mac-controller-01",
			sourceArchiveSha256: args.sourceArchiveSha256,
			stagingIdentity: args.macStagingIdentity,
		}),
	);
	const linuxStagedArchiveSha256 = sha256Bytes(
		canonicalBytes({
			schema: "staged-archive-binding/v1",
			hostId: "linux-bench-01",
			sourceArchiveSha256: args.sourceArchiveSha256,
			stagingIdentity: args.linuxStagingIdentity,
		}),
	);
	const capability = {
		schema: "staged-capability/v1",
		authoritySha256,
		lockSha256,
		candidate: args.candidate,
		campaignId: args.campaignId,
		sourceArchiveReceiptSha256,
		r1RedApprovalBundleSha256,
		sourceArchiveSha256: args.sourceArchiveSha256,
		macStagedArchiveSha256,
		linuxStagedArchiveSha256,
		hostSubmissions: [
			{ hostId: "mac-controller-01" },
			{ hostId: "linux-bench-01" },
		],
		sshHostReceiptSha256,
		macCampaignIdentity: args.macCampaignIdentity,
		issuedAt: args.issuedAt,
		notAfter: args.notAfter,
		fixtureOnly: false as const,
	};
	const capabilityBytes = canonicalBytes(capability);
	const capabilitySha256 = sha256Bytes(capabilityBytes);
	const manifest = {
		schema: "campaign-manifest/v1",
		authoritySha256,
		lockSha256,
		capabilitySha256,
		candidate: args.candidate,
		campaignId: args.campaignId,
		registryHash: CANONICAL_SCENARIO_REGISTRY.registryHash,
		scheduleHash,
		cardinality,
		sealedAt: args.issuedAt,
		descriptors: [
			{ components: ["authority"] },
			{ components: ["campaign-lock"] },
			{ components: ["staged-capability"] },
		],
	};

	return {
		campaignReservation,
		sourceArchiveReceipt,
		r1RedApprovalBundle,
		sshHostReceipt,
		authority,
		authorityBytes,
		authoritySha256,
		lock,
		lockBytes,
		lockSha256,
		capability,
		capabilityBytes,
		capabilitySha256,
		manifest,
		manifestBytes: canonicalBytes(manifest),
	};
}

/**
 * APFS directory nlink rises when regular files are added. Supervisor bootstrap
 * matches DirectoryIdentity field-for-field, so mint must seal identities only
 * after the final leaf set exists. Placeholders keep nlink stable; later writes
 * overwrite the same paths.
 */
export const MAC_CAMPAIGN_ROOT_FINAL_LEAVES = [
	"campaign-lock.json",
	"campaign-reservation.json",
	"manifest.json",
	"r1-red-approval-bundle.json",
	"source-archive-receipt.json",
	"ssh-host-receipt.json",
] as const;

export const MAC_STAGING_ROOT_FINAL_LEAVES = [
	"staged-capability.json",
	"staged-server-launch-record.json",
] as const;

export function ensureFinalRootLeafPlaceholders(args: {
	readonly campaignRoot: string;
	readonly stagingRoot: string;
}): void {
	mkdirSync(args.campaignRoot, { recursive: true, mode: 0o700 });
	mkdirSync(args.stagingRoot, { recursive: true, mode: 0o700 });
	for (const leaf of MAC_CAMPAIGN_ROOT_FINAL_LEAVES) {
		const path = join(args.campaignRoot, leaf);
		if (!existsSync(path)) {
			writeFileSync(path, "", { mode: 0o600 });
		}
	}
	for (const leaf of MAC_STAGING_ROOT_FINAL_LEAVES) {
		const path = join(args.stagingRoot, leaf);
		if (!existsSync(path)) {
			writeFileSync(path, "", { mode: 0o600 });
		}
	}
}

async function runMint(argv: readonly string[]): Promise<number> {
	const profile = requireFlag(argv, "profile") as "phase-a" | "phase-b";
	const candidate = requireFlag(argv, "candidate");
	const campaignId = requireFlag(argv, "campaign-id");
	const sourceArchive = requireFlag(argv, "source-archive");
	const macRoot = requireFlag(argv, "mac-root");
	const linuxObservationPath = requireFlag(argv, "linux-observation");
	const approvedPlan = requireFlag(argv, "approved-plan");
	const approvalRecord = requireFlag(argv, "approval-record");
	const macBun = requireFlag(argv, "mac-bun");
	const macSupervisor = requireFlag(argv, "mac-supervisor");
	const macObserver = requireFlag(argv, "mac-observer");
	const macAddonRoot = requireFlag(argv, "mac-addon-root");
	const macPublicKey = requireFlag(argv, "mac-public-key");
	const rigPublicKey = requireFlag(argv, "rig-public-key");
	const notAfterMs = Number(requireFlag(argv, "not-after-ms"));
	const repo = parseFlag(argv, "repo") ?? process.cwd();
	if (!Number.isSafeInteger(notAfterMs) || notAfterMs <= 0) {
		throw new Error("invalid --not-after-ms");
	}

	const linuxObservation = JSON.parse(
		readFileSync(linuxObservationPath, "utf8"),
	) as LinuxStageObservationV1;
	if (linuxObservation.schema !== "linux-stage-observation/v1") {
		throw new Error("linux observation schema mismatch");
	}
	if (
		profile === "phase-a" &&
		linuxObservation.fanoutRoleEntrypointSha256 !== null
	) {
		throw new Error("phase-a requires fanoutRoleEntrypointSha256:null");
	}
	if (
		profile === "phase-b" &&
		linuxObservation.fanoutRoleEntrypointSha256 === null
	) {
		throw new Error("phase-b requires non-null fanoutRoleEntrypointSha256");
	}

	const issuedAtMs = Date.now();
	const issuedAt = new Date(issuedAtMs).toISOString();
	const notAfter = new Date(notAfterMs).toISOString();

	const campaignRoot = join(macRoot, "campaign-root");
	const stagingRoot = join(macRoot, "staging-root");
	const execParent = join(macRoot, "bin");
	// Seal DirectoryIdentity only after the final leaf cardinality exists.
	ensureFinalRootLeafPlaceholders({ campaignRoot, stagingRoot });
	const macCampaignIdentity = await observeDirectoryIdentity(
		macObserver,
		campaignRoot,
	);
	const macStagingIdentity = await observeDirectoryIdentity(
		macObserver,
		stagingRoot,
	);
	const macExecIdentity = await observeDirectoryIdentity(
		macObserver,
		execParent,
	);

	const inventoryPath = join(macRoot, "archive-member-inventory.txt");
	const archiveMeta = {
		archiveSha256: sha256File(sourceArchive),
		archiveSize: statSync(sourceArchive).size,
		archiveMemberCount: readFileSync(inventoryPath, "utf8")
			.split("\n")
			.filter((l) => l.length > 0).length,
		archiveMemberInventorySha256: sha256File(inventoryPath),
	};

	const macPubSha = sha256File(macPublicKey);
	const rigPubSha = sha256File(rigPublicKey);
	const macBunSha = sha256File(macBun);
	const macSupervisorSha = sha256File(macSupervisor);
	const macObserverSha = sha256File(macObserver);
	const macAddonSha = hashAddonManifest(macAddonRoot);
	const serverSha = sha256File(join(macRoot, "roles/server.ts"));
	const stageToolSha = sha256File(
		join(macRoot, "roles/stage-live-campaign.ts"),
	);
	const fanoutSha =
		profile === "phase-b"
			? sha256File(join(macRoot, "roles/fanout-role.ts"))
			: null;
	const approvedPlanSha = sha256File(approvedPlan);
	const approvalRecordSha = sha256File(approvalRecord);
	const leasePath = join(stagingRoot, "rig-signing-key-lease.armed.json");
	const leaseSha = sha256File(leasePath);

	const treeOid = (
		await runChecked(
			["git", "rev-parse", `${candidate}^{tree}`],
			"mint tree oid",
			{ cwd: repo },
		)
	).trim();
	const records = buildLiveMintRecords({
		profile,
		repo,
		candidate,
		campaignId,
		candidateTreeOid: treeOid,
		issuedAt,
		notAfter,
		approvedPlanSha256: approvedPlanSha,
		approvalRecordSha256: approvalRecordSha,
		sourceArchiveSha256: archiveMeta.archiveSha256,
		sourceArchiveSize: archiveMeta.archiveSize,
		archiveMemberCount: archiveMeta.archiveMemberCount,
		archiveMemberInventorySha256: archiveMeta.archiveMemberInventorySha256,
		macBunSha256: macBunSha,
		linuxBunSha256: linuxObservation.linuxBunSha256,
		macSupervisorSha256: macSupervisorSha,
		linuxSupervisorSha256: linuxObservation.linuxSupervisorSha256,
		macCampaignIdentity,
		macStagingIdentity,
		linuxStagingIdentity: linuxObservation.directoryIdentity,
		macExecIdentity,
	});
	for (const [leaf, record] of [
		["campaign-reservation.json", records.campaignReservation],
		["source-archive-receipt.json", records.sourceArchiveReceipt],
		["r1-red-approval-bundle.json", records.r1RedApprovalBundle],
		["ssh-host-receipt.json", records.sshHostReceipt],
	] as const) {
		writeFileSync(join(campaignRoot, leaf), canonicalBytes(record), {
			mode: 0o600,
		});
	}

	const {
		authorityBytes,
		authoritySha256,
		lockBytes,
		lockSha256,
		capabilityBytes,
		capabilitySha256,
		manifestBytes,
	} = records;
	const staged = stageTrustBootstrap(macRoot, {
		authorityBytes,
		authoritySha256Hex: authoritySha256,
		campaignLockBytes: lockBytes,
		stagedCapabilityBytes: capabilityBytes,
		manifestBytes,
	});
	if (staged.ok === false) {
		throw new Error(`mint stage failed: ${staged.code}`);
	}
	const verified = verifyStagedTrustBootstrap(macRoot, authoritySha256);
	if (verified.ok === false) {
		throw new Error(`mint stage verification failed: ${verified.code}`);
	}

	const launchRecord = {
		schema: "staged-server-launch-record/v1",
		stageReceiptSha256: "0".repeat(64),
		serverEntrypointSha256: serverSha,
		bunSha256: linuxObservation.linuxBunSha256,
		addonSha256: linuxObservation.linuxAddonManifestSha256,
		bindAddress: "10.99.0.2",
		bindPort: 4433,
		advertisedHost: "10.99.0.2",
		tlsServerName: "wt-compare.local",
		transport: "wt",
		argv: ["server.ts", "--transport=wt"],
		allowedEnvironment: [{ name: "PATH", value: "/usr/bin:/bin" }],
	};
	const launchBytes = `${canonicalJson(launchRecord)}\n`;
	const launchPath = join(stagingRoot, "staged-server-launch-record.json");
	writeFileSync(launchPath, launchBytes, { mode: 0o644 });
	const stagedServerLaunchRecordSha256 = sha256Bytes(launchBytes);

	const macDirectoryIdentitySha256 = sha256Bytes(
		canonicalJson(macStagingIdentity),
	);
	const linuxDirectoryIdentitySha256 = linuxObservation.directoryIdentitySha256;
	const externalTrustBoundSha256 = sha256Bytes(
		canonicalJson({
			schema: "external-trust-bound/v1",
			candidate,
			campaignId,
			authoritySha256,
			capabilitySha256,
			lockSha256,
			archiveSha256: archiveMeta.archiveSha256,
			macSigningPublicKeySha256: macPubSha,
			rigSigningPublicKeySha256: rigPubSha,
			macDirectoryIdentitySha256,
			linuxDirectoryIdentitySha256,
		}),
	);

	const receipt: LiveStageReceiptV1 = {
		schema: "live-stage-receipt/v1",
		stageProfile: profile,
		candidate,
		candidateHead: candidate,
		candidateTreeOid: treeOid,
		campaignId,
		sourceArchivePath: "source.tar",
		archiveSha256: archiveMeta.archiveSha256,
		archiveSize: archiveMeta.archiveSize,
		archiveMemberCount: archiveMeta.archiveMemberCount,
		archiveMemberInventorySha256: archiveMeta.archiveMemberInventorySha256,
		authoritySha256,
		capabilitySha256,
		lockSha256,
		manifestSha256: staged.paths.digests.manifest,
		approvedPlanSha256: approvedPlanSha,
		approvalRecordSha256: approvalRecordSha,
		macSigningPublicKeyLeaf: "mac-supervisor-ed25519.pub",
		macSigningPublicKeySha256: macPubSha,
		rigSigningPublicKeyLeaf: "rig-supervisor-ed25519.pub",
		rigSigningPublicKeySha256: rigPubSha,
		macBunSha256: macBunSha,
		linuxBunSha256: linuxObservation.linuxBunSha256,
		macSupervisorSha256: macSupervisorSha,
		linuxSupervisorSha256: linuxObservation.linuxSupervisorSha256,
		macObserverSha256: macObserverSha,
		linuxObserverSha256: linuxObservation.linuxObserverSha256,
		macAddonManifestSha256: macAddonSha,
		linuxAddonManifestSha256: linuxObservation.linuxAddonManifestSha256,
		serverEntrypointSha256: serverSha,
		fanoutRoleEntrypointSha256: fanoutSha,
		stageToolEntrypointSha256: stageToolSha,
		stagedServerLaunchRecordSha256,
		rigSigningKeyLeaseSha256: leaseSha,
		macDirectoryIdentitySha256,
		linuxDirectoryIdentitySha256,
		externalTrustBoundSha256,
		issuedAtMs,
		notAfterMs,
	};
	const receiptSha = writeStageReceipt(
		join(macRoot, "stage-receipt.json"),
		receipt,
	);
	process.stdout.write(`STAGE_RECEIPT_SHA256=${receiptSha}\n`);
	process.stdout.write(`CAPABILITY_SHA256=${capabilitySha256}\n`);
	process.stdout.write(`LOCK_SHA256=${lockSha256}\n`);
	process.stdout.write(`ARCHIVE_SHA256=${archiveMeta.archiveSha256}\n`);
	process.stdout.write(
		`EXTERNAL_TRUST_BOUND_SHA256=${externalTrustBoundSha256}\n`,
	);
	process.stdout.write("MINT_OK\n");
	return 0;
}

function runInstallMinted(argv: readonly string[]): number {
	const root = requireFlag(argv, "root");
	const incoming = requireFlag(argv, "incoming");
	const expected = requireFlag(argv, "expected-receipt-sha256");
	const receiptPath = join(incoming, "stage-receipt.json");
	if (!existsSync(receiptPath)) {
		process.stderr.write("install-minted missing stage-receipt.json\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	const actual = sha256File(receiptPath);
	if (actual !== expected) {
		process.stderr.write(
			`install-minted receipt digest mismatch: ${actual} != ${expected}\n`,
		);
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	const copies: Array<[string, string]> = [
		[TRUST_BOOTSTRAP_AUTHORITY_LEAF, TRUST_BOOTSTRAP_AUTHORITY_LEAF],
		[
			TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
			TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
		],
		[
			TRUST_BOOTSTRAP_LOCK_LEAF,
			join("campaign-root", TRUST_BOOTSTRAP_LOCK_LEAF),
		],
		[
			TRUST_BOOTSTRAP_MANIFEST_LEAF,
			join("campaign-root", TRUST_BOOTSTRAP_MANIFEST_LEAF),
		],
		[
			TRUST_BOOTSTRAP_CAPABILITY_LEAF,
			join("staging-root", TRUST_BOOTSTRAP_CAPABILITY_LEAF),
		],
		[
			"mac-supervisor-ed25519.pub",
			join("staging-root", "mac-supervisor-ed25519.pub"),
		],
		[
			"rig-supervisor-ed25519.pub",
			join("staging-root", "rig-supervisor-ed25519.pub"),
		],
		["stage-receipt.json", "stage-receipt.json"],
	];
	for (const [fromRel, toRel] of copies) {
		const src = join(incoming, fromRel);
		if (!existsSync(src)) {
			process.stderr.write(`install-minted missing incoming leaf ${fromRel}\n`);
			return EXIT_STALE_OR_INVALID_STAGING;
		}
		const dest = join(root, toRel);
		mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
		copyFileSync(src, dest);
	}
	process.stdout.write("INSTALL_MINTED_OK\n");
	return 0;
}

async function runVerifyStage(argv: readonly string[]): Promise<number> {
	const profile = requireFlag(argv, "profile") as "phase-a" | "phase-b";
	const candidate = requireFlag(argv, "candidate");
	const campaignId = requireFlag(argv, "campaign-id");
	const macRoot = requireFlag(argv, "mac-root");
	const linuxObservationPath = requireFlag(argv, "linux-observation");
	const receiptPath = join(macRoot, "stage-receipt.json");
	if (!existsSync(receiptPath)) {
		process.stderr.write("verify-stage missing stage-receipt.json\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	const receipt = JSON.parse(
		readFileSync(receiptPath, "utf8"),
	) as LiveStageReceiptV1;
	if (receipt.schema !== "live-stage-receipt/v1") {
		process.stderr.write("verify-stage receipt schema mismatch\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	if (receipt.candidate !== candidate || receipt.campaignId !== campaignId) {
		process.stderr.write("verify-stage candidate/campaign mismatch\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	if (receipt.stageProfile !== profile) {
		process.stderr.write("verify-stage profile mismatch\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	if (profile === "phase-a" && receipt.fanoutRoleEntrypointSha256 !== null) {
		process.stderr.write("verify-stage phase-a fanout digest must be null\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	const verified = verifyStagedTrustBootstrap(macRoot, receipt.authoritySha256);
	if (!verified.ok) {
		process.stderr.write(`verify-stage bootstrap: ${verified.code}\n`);
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	if (!existsSync(linuxObservationPath)) {
		process.stderr.write("verify-stage missing linux observation\n");
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	process.stdout.write("STAGE_OK\n");
	process.stdout.write(`CAPABILITY_SHA256=${receipt.capabilitySha256}\n`);
	process.stdout.write(`LOCK_SHA256=${receipt.lockSha256}\n`);
	process.stdout.write(`ARCHIVE_SHA256=${receipt.archiveSha256}\n`);
	process.stdout.write(
		`EXTERNAL_TRUST_BOUND_SHA256=${receipt.externalTrustBoundSha256}\n`,
	);
	process.stdout.write(
		`MAC_SUPERVISOR_SHA256=${receipt.macSupervisorSha256}\n`,
	);
	process.stdout.write(
		`LINUX_SUPERVISOR_SHA256=${receipt.linuxSupervisorSha256}\n`,
	);
	process.stdout.write(`APPROVED_PLAN_SHA256=${receipt.approvedPlanSha256}\n`);
	process.stdout.write(
		`APPROVAL_RECORD_SHA256=${receipt.approvalRecordSha256}\n`,
	);
	return 0;
}

async function runFreezeRunCommand(argv: readonly string[]): Promise<number> {
	if (parseFlag(argv, "out") || parseFlag(argv, "body")) {
		process.stderr.write(
			"freeze-run-command rejects --out/--body; use --section/--stage-receipt/--output\n",
		);
		return EXIT_USAGE;
	}
	const section = requireFlag(argv, "section") as "9.5" | "9.6" | "9.7";
	const candidate = requireFlag(argv, "candidate");
	const campaignId = requireFlag(argv, "campaign-id");
	const executionPurpose = requireFlag(argv, "execution-purpose");
	const stageReceiptPath = requireFlag(argv, "stage-receipt");
	const output = requireFlag(argv, "output");
	const repo = parseFlag(argv, "repo") ?? process.cwd();
	const macBun = parseFlag(argv, "mac-bun") ?? process.execPath;
	const rig = parseFlag(argv, "rig") ?? "hermes-admin@10.99.0.2";
	const sshKey =
		parseFlag(argv, "ssh-key") ?? `${process.env.HOME}/.ssh/ubuntu-vm-hermes`;
	const macTrust = dirname(stageReceiptPath);
	const macRuntime = `${MAC_RUNTIME_ROOT}/${candidate}/${campaignId}`;
	const rigStage = `/home/hermes-admin/ws-wt-stage/${candidate}/${campaignId}`;
	const out = `${repo}/.release-evidence/transport-comparison/${candidate}/${campaignId}`;
	const { timeoutMs } = executionPurposeToSection(executionPurpose);
	if (section !== executionPurposeToSection(executionPurpose).section) {
		process.stderr.write("freeze-run-command section/purpose mismatch\n");
		return EXIT_USAGE;
	}
	const receipt = JSON.parse(
		readFileSync(stageReceiptPath, "utf8"),
	) as LiveStageReceiptV1;
	mkdirSync(out, { recursive: true, mode: 0o700 });
	const body = buildFrozenRunCommand({
		section,
		repo,
		candidate,
		campaignId,
		executionPurpose,
		stageReceipt: receipt,
		macTrust,
		macRuntime,
		rig,
		rigStage,
		sshKey,
		macBun,
		out,
		runTimeoutMs: timeoutMs,
	});
	writeFileSync(output, body, { mode: 0o444 });
	process.stdout.write(`UPCOMING_RUN_COMMAND_SHA256=${sha256Bytes(body)}\n`);
	process.stdout.write("FREEZE_RUN_COMMAND_OK\n");
	return 0;
}

type StageOnlyArgs = {
	repo: string;
	macBun: string;
	rig: string;
	sshKey: string;
	candidate: string;
	campaignId: string;
	executionPurpose: string;
	profile: "phase-a" | "phase-b";
	plan: string;
	approval: string;
	macRoot: string;
	rigRoot: string;
	authorityLifetimeMs: number;
};

function parseStageOnlyArgs(argv: readonly string[]): StageOnlyArgs {
	const profile = requireFlag(argv, "profile");
	if (profile !== "phase-a" && profile !== "phase-b") {
		throw Object.assign(new Error("invalid --profile"), {
			exitCode: EXIT_USAGE,
		});
	}
	const executionPurpose = requireFlag(argv, "execution-purpose");
	executionPurposeToSection(executionPurpose);
	return {
		repo: requireFlag(argv, "repo"),
		macBun: requireFlag(argv, "mac-bun"),
		rig: requireFlag(argv, "rig"),
		sshKey: requireFlag(argv, "ssh-key"),
		candidate: requireFlag(argv, "candidate"),
		campaignId: requireFlag(argv, "campaign-id"),
		executionPurpose,
		profile,
		plan: requireFlag(argv, "plan"),
		approval: requireFlag(argv, "approval"),
		macRoot: requireFlag(argv, "mac-root"),
		rigRoot: requireFlag(argv, "rig-root"),
		authorityLifetimeMs: Number(
			parseFlag(argv, "authority-lifetime-ms") ?? "72000000",
		),
	};
}

async function runStageOnly(argv: readonly string[]): Promise<number> {
	let args: StageOnlyArgs;
	try {
		args = parseStageOnlyArgs(argv);
	} catch (error) {
		const err = error as Error & { exitCode?: number };
		process.stderr.write(`${err.message}\n`);
		return err.exitCode ?? EXIT_USAGE;
	}

	const evidenceOut = join(
		args.repo,
		".release-evidence/transport-comparison",
		args.candidate,
		args.campaignId,
	);
	for (const path of [evidenceOut, args.macRoot, args.rigRoot]) {
		if (existsSync(path)) {
			process.stderr.write(
				`${REFUSED_STALE_OR_INVALID_STAGING}: fresh-root check failed: ${path} exists\n`,
			);
			return EXIT_STALE_OR_INVALID_STAGING;
		}
	}

	const macId = await checkMacStagingIdentity();
	if (!macId.ok) {
		process.stderr.write(
			`${REFUSED_STALE_OR_INVALID_STAGING}: ${macId.detail}\n`,
		);
		return EXIT_STALE_OR_INVALID_STAGING;
	}
	const rigId = await checkRigStagingIdentity({
		rig: args.rig,
		sshKey: args.sshKey,
	});
	if (!rigId.ok) {
		process.stderr.write(`${rigId.code}: ${rigId.detail}\n`);
		return rigId.code === REFUSED_RIG_UNREACHABLE
			? EXIT_RIG_UNREACHABLE
			: EXIT_STALE_OR_INVALID_STAGING;
	}

	const macKeyDir = join(MAC_KEY_ROOT, args.candidate);
	const macPrivate = join(macKeyDir, `${args.campaignId}.mac.pk8`);
	const macPublic = join(macKeyDir, `${args.campaignId}.mac.pub`);
	const macRecoveryPrivate = join(
		macKeyDir,
		`${args.campaignId}.mac-recovery.pk8`,
	);
	const macRecoveryPublic = join(
		macKeyDir,
		`${args.campaignId}.mac-recovery.pub`,
	);
	const macRuntime = join(MAC_RUNTIME_ROOT, args.candidate, args.campaignId);
	const rigPrivate = `${RIG_KEY_ROOT}/${args.candidate}/${args.campaignId}.rig.pk8`;

	let committed = false;
	let macBuildDir = "";
	const cleanup = async (): Promise<number> => {
		if (committed) return 0;
		let rc = 0;
		const macDestroy = await runCapture([
			"/usr/bin/sudo",
			"-n",
			"-u",
			WTCOMPARE_USER,
			join(macRuntime, "comparison-supervisor"),
			"destroy-signing-key",
			`--private-key=${macPrivate}`,
			"--missing=ok",
		]);
		if (macDestroy.code !== 0) rc = EXIT_CLEANUP_FAILED;
		const rigDestroy = await runCapture([
			"ssh",
			"-i",
			args.sshKey,
			"-o",
			"ConnectTimeout=10",
			args.rig,
			`sudo -n -u ${WTCOMPARE_USER} ${args.rigRoot}/bin/comparison-supervisor destroy-signing-key --private-key=${rigPrivate} --missing=ok`,
		]);
		if (rigDestroy.code !== 0) {
			mkdirSync(join(args.macRoot, "recovery"), {
				recursive: true,
				mode: 0o700,
			});
			writeFileSync(
				join(args.macRoot, "recovery/rig-disconnect-requirement.json"),
				`${canonicalJson({
					schema: "rig-disconnect-recovery-requirement/v1",
					candidate: args.candidate,
					campaignId: args.campaignId,
					phase: "pre-stage-receipt",
					stageReceiptSha256: null,
					rigPublicKeySha256: existsSync(
						join(args.macRoot, "staging-root/rig-supervisor-ed25519.pub"),
					)
						? sha256File(
								join(args.macRoot, "staging-root/rig-supervisor-ed25519.pub"),
							)
						: "0".repeat(64),
					leaseSnapshotSha256: null,
					macCleanupStatus: "destroy-failed",
					rigCleanupStatus: "unproven-unreachable",
					recordedAtMs: Date.now(),
					requiredAction: "recover-rig-key",
					recoveryRequirementPath: `.trust-staging/${args.candidate}/${args.campaignId}/recovery/rig-disconnect-requirement.json`,
				})}\n`,
				{ mode: 0o644 },
			);
			rc = EXIT_CLEANUP_FAILED;
		}
		return rc;
	};

	const onSignal = () => {
		void cleanup().then((code) => process.exit(code || 130));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	process.on("SIGHUP", onSignal);

	try {
		macBuildDir = (
			await runChecked(
				["mktemp", "-d", "/tmp/ws-wt-mac-build.XXXXXX"],
				"mktemp",
			)
		).trim();
		mkdirSync(args.macRoot, { recursive: true, mode: 0o700 });
		const archivePath = join(args.macRoot, "source.tar");
		const archive = await archiveSource(args.repo, args.candidate, archivePath);
		await buildMacArchived({
			macBun: args.macBun,
			archivePath,
			buildDir: macBuildDir,
		});

		prestageRoot({
			root: args.macRoot,
			profile: args.profile,
			repo: args.repo,
		});

		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"install",
				"-d",
				"-o",
				"root",
				"-g",
				"wheel",
				"-m",
				"755",
				macRuntime,
			],
			"mac runtime dir",
		);
		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"install",
				"-m",
				"0755",
				join(macBuildDir, "target/release/comparison-supervisor"),
				join(macRuntime, "comparison-supervisor"),
			],
			"install mac supervisor",
		);
		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"install",
				"-m",
				"0755",
				args.macBun,
				join(macRuntime, "bun"),
			],
			"install mac bun",
		);
		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"install",
				"-d",
				"-o",
				WTCOMPARE_USER,
				"-g",
				"staff",
				"-m",
				"700",
				macKeyDir,
			],
			"mac key dir",
		);

		// Cleanup traps are already installed above; keygen follows.
		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"-u",
				WTCOMPARE_USER,
				join(macRuntime, "comparison-supervisor"),
				"keygen-ed25519",
				`--private-out=${macPrivate}`,
				`--public-out=${macPublic}`,
				"--overwrite=refuse",
			],
			"mac keygen",
		);
		await runChecked(
			["/usr/bin/sudo", "-n", "chmod", "0400", macPrivate],
			"chmod mac key",
		);
		await runChecked(
			["/usr/bin/sudo", "-n", "chown", `${WTCOMPARE_USER}:staff`, macPrivate],
			"chown mac key",
		);
		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"install",
				"-m",
				"0644",
				macPublic,
				join(args.macRoot, "staging-root/mac-supervisor-ed25519.pub"),
			],
			"install mac pub leaf",
		);
		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"-u",
				WTCOMPARE_USER,
				join(macRuntime, "comparison-supervisor"),
				"keygen-ed25519",
				`--private-out=${macRecoveryPrivate}`,
				`--public-out=${macRecoveryPublic}`,
				"--overwrite=refuse",
			],
			"mac recovery keygen",
		);
		await runChecked(
			[
				"/usr/bin/sudo",
				"-n",
				"install",
				"-m",
				"0644",
				macRecoveryPublic,
				join(args.macRoot, "staging-root/mac-recovery-ed25519.pub"),
			],
			"install mac recovery pub",
		);

		const readable = await runCapture(["test", "!", "-r", macPrivate]);
		if (readable.code !== 0) {
			throw new Error("controller can read Mac private key (ownership broken)");
		}

		await runChecked(
			[
				"scp",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				archivePath,
				`${args.rig}:/tmp/ws-wt-${args.candidate}.tar`,
			],
			"scp archive",
		);
		await runChecked(
			[
				"scp",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				join(args.macRoot, "staging-root/mac-supervisor-ed25519.pub"),
				`${args.rig}:/tmp/ws-wt-${args.candidate}.mac.pub`,
			],
			"scp mac pub",
		);

		const notAfterMs = Date.now() + args.authorityLifetimeMs;
		const rigScript = [
			"set -euo pipefail",
			'export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"',
			`CANDIDATE=${shellQuote(args.candidate)}`,
			`CAMPAIGN_ID=${shellQuote(args.campaignId)}`,
			`RIG_STAGE=${shellQuote(args.rigRoot)}`,
			`STAGE_PROFILE=${shellQuote(args.profile)}`,
			`NOT_AFTER_MS=${notAfterMs}`,
			// Prior failed stage-only attempts leave ~1GiB /tmp builds; tmpfs is 6GiB.
			// Do not delete /tmp/ws-wt-$CANDIDATE.tar|.mac.pub — Mac scp'd them just before this script.
			"rm -rf /tmp/ws-wt-linux-build.*",
			// sccache into /tmp build trees races with tmpfs pressure and fails aws-lc-sys.
			"sccache --stop-server >/dev/null 2>&1 || true",
			"unset RUSTC_WRAPPER CARGO_INCREMENTAL CC CXX",
			"export RUSTC_WRAPPER=",
			"RIG_BUILD=$(mktemp -d /tmp/ws-wt-linux-build.XXXXXX)",
			'tar -xf "/tmp/ws-wt-$CANDIDATE.tar" -C "$RIG_BUILD"',
			'cd "$RIG_BUILD"',
			"/home/hermes-admin/.bun/bin/bun install --frozen-lockfile",
			"cargo build -p native --release --bin comparison-supervisor --bin observe-directory-identity",
			"/home/hermes-admin/.bun/bin/bun run build:native",
			"/home/hermes-admin/.bun/bin/bun tools/compare/bin/stage-live-campaign.ts prestage \\",
			'  --profile="$STAGE_PROFILE" --host=linux --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" --root="$RIG_STAGE" --repo="$RIG_BUILD"',
			'install -m 0755 target/release/comparison-supervisor "$RIG_STAGE/bin/comparison-supervisor"',
			'install -m 0755 target/release/observe-directory-identity "$RIG_STAGE/bin/observe-directory-identity"',
			// Plan path is $RIG_STAGE/bin/...; _wtcompare cannot traverse hermes-admin
			// 0700/750 home or stage dirs. Open execute-only traversal to the bin leaf;
			// keep staging-root/campaign-root/incoming/replay/roles/prebuilds at 0700.
			"chmod 711 /home/hermes-admin",
			'chmod 755 /home/hermes-admin/ws-wt-stage "/home/hermes-admin/ws-wt-stage/$CANDIDATE" "$RIG_STAGE" "$RIG_STAGE/bin"',
			'chmod 700 "$RIG_STAGE/staging-root" "$RIG_STAGE/campaign-root" "$RIG_STAGE/incoming" "$RIG_STAGE/replay" "$RIG_STAGE/roles" "$RIG_STAGE/prebuilds"',
			`sudo -n install -d -o ${WTCOMPARE_USER} -g ${WTCOMPARE_USER} -m 700 "${RIG_KEY_ROOT}/$CANDIDATE"`,
			`sudo -n install -d -o ${WTCOMPARE_USER} -g ${WTCOMPARE_USER} -m 700 "${RIG_LEASE_ROOT}/$CANDIDATE"`,
			`sudo -n -u ${WTCOMPARE_USER} "$RIG_STAGE/bin/comparison-supervisor" keygen-ed25519 \\`,
			`  --private-out="${RIG_KEY_ROOT}/$CANDIDATE/$CAMPAIGN_ID.rig.pk8" \\`,
			`  --public-out="${RIG_KEY_ROOT}/$CANDIDATE/$CAMPAIGN_ID.rig.pub" --overwrite=refuse`,
			`sudo -n chmod 0400 "${RIG_KEY_ROOT}/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"`,
			`sudo -n chown ${WTCOMPARE_USER}:${WTCOMPARE_USER} "${RIG_KEY_ROOT}/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"`,
			'install -m 0644 "/tmp/ws-wt-$CANDIDATE.mac.pub" "$RIG_STAGE/staging-root/mac-supervisor-ed25519.pub"',
			`sudo -n install -o hermes-admin -g hermes-admin -m 0644 "${RIG_KEY_ROOT}/$CANDIDATE/$CAMPAIGN_ID.rig.pub" "$RIG_STAGE/staging-root/rig-supervisor-ed25519.pub"`,
			`sudo -n -u hermes-admin test ! -r "${RIG_KEY_ROOT}/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"`,
			'install -m 0644 tools/compare/server.ts "$RIG_STAGE/roles/server.ts"',
			'install -m 0644 tools/compare/bin/stage-live-campaign.ts "$RIG_STAGE/roles/stage-live-campaign.ts"',
			'if test "$STAGE_PROFILE" = phase-b; then',
			'  install -m 0644 tools/compare/bin/fanout-role.ts "$RIG_STAGE/roles/fanout-role.ts"',
			"fi",
			'if test -d prebuilds; then cp -R prebuilds/. "$RIG_STAGE/prebuilds/"; fi',
			// Persist build tree path outside RIG_STAGE so later observe-linux /
			// install-minted can run the full module graph. roles/ may only hold
			// the exact hashed leaves (no sibling imports under the leaf rule).
			'printf "%s\n" "$RIG_BUILD" > "/tmp/ws-wt-rig-build-$CANDIDATE-$CAMPAIGN_ID"',
			"echo RIG_BUILD_KEYGEN_OK",
		].join("\n");

		const remoteProc = Bun.spawn(
			[
				"ssh",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				args.rig,
				"bash",
				"-s",
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		remoteProc.stdin.write(rigScript);
		remoteProc.stdin.end();
		const [remoteOut, remoteErr, remoteCode] = await Promise.all([
			new Response(remoteProc.stdout).text(),
			new Response(remoteProc.stderr).text(),
			remoteProc.exited,
		]);
		if (remoteCode !== 0) {
			throw new Error(
				`linux stage failed (${remoteCode}): ${remoteErr.trim() || remoteOut.trim()}`,
			);
		}

		await runChecked(
			[
				"scp",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				`${args.rig}:${args.rigRoot}/staging-root/rig-supervisor-ed25519.pub`,
				join(args.macRoot, "staging-root/rig-supervisor-ed25519.pub"),
			],
			"scp rig pub",
		);
		const lease = writeArmedLease({
			candidate: args.candidate,
			campaignId: args.campaignId,
			rigPublicKeySha256: sha256File(
				join(args.macRoot, "staging-root/rig-supervisor-ed25519.pub"),
			),
			notAfterMs,
			outPath: join(
				args.macRoot,
				"staging-root/rig-signing-key-lease.armed.json",
			),
		});
		await runChecked(
			[
				"scp",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				join(args.macRoot, "staging-root/rig-signing-key-lease.armed.json"),
				`${args.rig}:${args.rigRoot}/staging-root/rig-signing-key-lease.armed.json`,
			],
			"scp armed lease",
		);
		await runChecked(
			[
				"ssh",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				args.rig,
				[
					"set -euo pipefail",
					`sudo -n install -m 0644 ${args.rigRoot}/staging-root/rig-signing-key-lease.armed.json ${RIG_LEASE_ROOT}/${args.candidate}/${args.campaignId}.lease.json`,
					`RIG_BUILD=$(cat /tmp/ws-wt-rig-build-${args.candidate}-${args.campaignId})`,
					'test -d "$RIG_BUILD"',
					`/home/hermes-admin/.bun/bin/bun "$RIG_BUILD/tools/compare/bin/stage-live-campaign.ts" observe-linux --candidate=${args.candidate} --campaign-id=${args.campaignId} --root=${args.rigRoot} --observer=${args.rigRoot}/bin/observe-directory-identity --out=${args.rigRoot}/linux-stage-observation.json`,
				].join(" && "),
			],
			"rig observe-linux",
		);
		void lease;

		await runChecked(
			[
				"scp",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				`${args.rig}:${args.rigRoot}/linux-stage-observation.json`,
				join(args.macRoot, "linux-stage-observation.json"),
			],
			"scp linux observation",
		);

		const macObserver = join(
			macBuildDir,
			"target/release/observe-directory-identity",
		);
		const mintCode = await runMint([
			`--profile=${args.profile}`,
			`--candidate=${args.candidate}`,
			`--campaign-id=${args.campaignId}`,
			`--source-archive=${archivePath}`,
			`--mac-root=${args.macRoot}`,
			`--linux-observation=${join(args.macRoot, "linux-stage-observation.json")}`,
			`--approved-plan=${args.plan}`,
			`--approval-record=${args.approval}`,
			`--mac-bun=${join(macRuntime, "bun")}`,
			`--mac-supervisor=${join(macRuntime, "comparison-supervisor")}`,
			`--mac-observer=${macObserver}`,
			`--mac-addon-root=${join(macBuildDir, "prebuilds")}`,
			`--mac-public-key=${join(args.macRoot, "staging-root/mac-supervisor-ed25519.pub")}`,
			`--rig-public-key=${join(args.macRoot, "staging-root/rig-supervisor-ed25519.pub")}`,
			`--not-after-ms=${notAfterMs}`,
			`--repo=${args.repo}`,
		]);
		if (mintCode !== 0) return mintCode;

		// Flatten incoming leaves for scp of mint outputs
		const incomingLocal = join(args.macRoot, "incoming");
		mkdirSync(incomingLocal, { recursive: true, mode: 0o700 });
		for (const leaf of [
			TRUST_BOOTSTRAP_AUTHORITY_LEAF,
			TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
			"stage-receipt.json",
		]) {
			copyFileSync(join(args.macRoot, leaf), join(incomingLocal, leaf));
		}
		copyFileSync(
			join(args.macRoot, "campaign-root", TRUST_BOOTSTRAP_LOCK_LEAF),
			join(incomingLocal, TRUST_BOOTSTRAP_LOCK_LEAF),
		);
		copyFileSync(
			join(args.macRoot, "campaign-root", TRUST_BOOTSTRAP_MANIFEST_LEAF),
			join(incomingLocal, TRUST_BOOTSTRAP_MANIFEST_LEAF),
		);
		copyFileSync(
			join(args.macRoot, "staging-root", TRUST_BOOTSTRAP_CAPABILITY_LEAF),
			join(incomingLocal, TRUST_BOOTSTRAP_CAPABILITY_LEAF),
		);
		copyFileSync(
			join(args.macRoot, "staging-root/mac-supervisor-ed25519.pub"),
			join(incomingLocal, "mac-supervisor-ed25519.pub"),
		);
		copyFileSync(
			join(args.macRoot, "staging-root/rig-supervisor-ed25519.pub"),
			join(incomingLocal, "rig-supervisor-ed25519.pub"),
		);

		await runChecked(
			[
				"scp",
				"-i",
				args.sshKey,
				"-o",
				"ConnectTimeout=10",
				...[
					join(incomingLocal, TRUST_BOOTSTRAP_AUTHORITY_LEAF),
					join(incomingLocal, TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF),
					join(incomingLocal, TRUST_BOOTSTRAP_LOCK_LEAF),
					join(incomingLocal, TRUST_BOOTSTRAP_MANIFEST_LEAF),
					join(incomingLocal, TRUST_BOOTSTRAP_CAPABILITY_LEAF),
					join(incomingLocal, "mac-supervisor-ed25519.pub"),
					join(incomingLocal, "rig-supervisor-ed25519.pub"),
					join(incomingLocal, "stage-receipt.json"),
				],
				`${args.rig}:${args.rigRoot}/incoming/`,
			],
			"scp minted leaves",
		);

		const receiptSha = sha256File(join(args.macRoot, "stage-receipt.json"));
		const install = await runCapture([
			"ssh",
			"-i",
			args.sshKey,
			"-o",
			"ConnectTimeout=10",
			args.rig,
			[
				"set -euo pipefail",
				`RIG_BUILD=$(cat /tmp/ws-wt-rig-build-${args.candidate}-${args.campaignId})`,
				'test -d "$RIG_BUILD"',
				`/home/hermes-admin/.bun/bin/bun "$RIG_BUILD/tools/compare/bin/stage-live-campaign.ts" install-minted --profile=${args.profile} --root=${args.rigRoot} --incoming=${args.rigRoot}/incoming --expected-receipt-sha256=${receiptSha}`,
			].join(" && "),
		]);
		if (install.code !== 0) {
			throw new Error(`install-minted failed: ${install.stderr.trim()}`);
		}

		const verifyCode = await runVerifyStage([
			`--profile=${args.profile}`,
			`--candidate=${args.candidate}`,
			`--campaign-id=${args.campaignId}`,
			`--mac-root=${args.macRoot}`,
			`--linux-observation=${join(args.macRoot, "linux-stage-observation.json")}`,
		]);
		if (verifyCode !== 0) return verifyCode;

		const { section } = executionPurposeToSection(args.executionPurpose);
		const freezeCode = await runFreezeRunCommand([
			`--section=${section}`,
			`--candidate=${args.candidate}`,
			`--campaign-id=${args.campaignId}`,
			`--execution-purpose=${args.executionPurpose}`,
			`--stage-receipt=${join(args.macRoot, "stage-receipt.json")}`,
			`--output=${join(args.macRoot, "upcoming-run-command.sh")}`,
			`--repo=${args.repo}`,
			`--mac-bun=${args.macBun}`,
			`--rig=${args.rig}`,
			`--ssh-key=${args.sshKey}`,
		]);
		if (freezeCode !== 0) return freezeCode;

		committed = true;
		void archive;
		process.stdout.write(`STAGE_RECEIPT_SHA256=${receiptSha}\n`);
		const receipt = JSON.parse(
			readFileSync(join(args.macRoot, "stage-receipt.json"), "utf8"),
		) as LiveStageReceiptV1;
		process.stdout.write(
			`EXTERNAL_TRUST_BOUND_SHA256=${receipt.externalTrustBoundSha256}\n`,
		);
		process.stdout.write(
			`UPCOMING_RUN_COMMAND_SHA256=${sha256File(join(args.macRoot, "upcoming-run-command.sh"))}\n`,
		);
		process.stdout.write("STAGE_ONLY_OK\n");
		return 0;
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		const cleanupRc = await cleanup();
		return cleanupRc !== 0 ? cleanupRc : 1;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("SIGHUP", onSignal);
		if (macBuildDir && existsSync(macBuildDir)) {
			try {
				rmSync(macBuildDir, { recursive: true, force: true });
			} catch {
				/* retain on failure ok */
			}
		}
	}
}

export async function runStageLiveCampaign(
	argv: readonly string[],
): Promise<number> {
	const [subcommand, ...rest] = argv;
	if (!subcommand) {
		process.stderr.write("usage: stage-live-campaign <subcommand> ...\n");
		return 2;
	}
	let cmd: StageSubcommand;
	try {
		cmd = assertKnownSubcommand(subcommand);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		return 2;
	}

	try {
		switch (cmd) {
			case "prestage": {
				const profile = requireFlag(rest, "profile") as "phase-a" | "phase-b";
				const root = requireFlag(rest, "root");
				const repo = parseFlag(rest, "repo");
				prestageRoot({ root, profile, repo });
				process.stdout.write("PRESTAGE_OK\n");
				return 0;
			}
			case "cleanup-signing-keys": {
				const mac = requireFlag(rest, "mac-private-key");
				const rig = requireFlag(rest, "rig-private-key");
				cleanupSigningKeysIdempotent({
					macPrivateKeyPath: mac,
					rigPrivateKeyPath: rig,
				});
				process.stdout.write("CLEANUP_OK\n");
				return 0;
			}
			case "abandon": {
				const mac = requireFlag(rest, "mac-private-key");
				const rig = requireFlag(rest, "rig-private-key");
				cleanupSigningKeysIdempotent({
					macPrivateKeyPath: mac,
					rigPrivateKeyPath: rig,
				});
				const recovery = parseFlag(rest, "mac-recovery-key");
				if (recovery && existsSync(recovery)) {
					rmSync(recovery);
					if (existsSync(recovery)) {
						process.stderr.write("abandon failed to destroy recovery key\n");
						return EXIT_CLEANUP_FAILED;
					}
				}
				process.stdout.write("ABANDON_OK\n");
				return 0;
			}
			case "freeze-run-command":
				return await runFreezeRunCommand(rest);
			case "verify-stage-approval": {
				if (parseFlag(rest, "command") || parseFlag(rest, "approval")) {
					process.stderr.write(
						"verify-stage-approval rejects --command/--approval\n",
					);
					return EXIT_USAGE;
				}
				const stageReceipt = requireFlag(rest, "stage-receipt");
				const upcoming = requireFlag(rest, "upcoming-run-command");
				const approval = requireFlag(rest, "exact-stage-approval");
				try {
					await verifyExactStageApproval({
						stageReceiptPath: stageReceipt,
						upcomingRunCommandPath: upcoming,
						exactStageApprovalPath: approval,
					});
				} catch (error) {
					const message = String(
						error instanceof Error ? error.message : error,
					);
					process.stderr.write(`${message}\n`);
					if (message.startsWith("EXACT_STAGE_APPROVAL_MISSING")) {
						return 3;
					}
					return EXIT_STALE_OR_INVALID_STAGING;
				}
				process.stdout.write("EXACT_STAGE_APPROVAL_OK\n");
				return 0;
			}
			case "verify-stage":
				return await runVerifyStage(rest);
			case "observe-linux":
				return await runObserveLinux(rest);
			case "mint":
				return await runMint(rest);
			case "install-minted":
				return runInstallMinted(rest);
			case "recover-rig-key": {
				const requirement = requireFlag(rest, "recovery-requirement");
				if (!existsSync(requirement)) {
					process.stderr.write(
						"recover-rig-key missing recovery requirement\n",
					);
					return EXIT_STALE_OR_INVALID_STAGING;
				}
				process.stdout.write("RECOVER_RIG_KEY_REQUIRES_LIVE_SUPERVISORS\n");
				return EXIT_STALE_OR_INVALID_STAGING;
			}
			case "stage-only":
				return await runStageOnly(rest);
			default: {
				const _exhaustive: never = cmd;
				process.stderr.write(`unhandled: ${String(_exhaustive)}\n`);
				return 2;
			}
		}
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		return 1;
	}
}

if (import.meta.main) {
	const code = await runStageLiveCampaign(process.argv.slice(2));
	process.exit(code);
}
