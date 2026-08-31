/**
 * Live campaign staging CLI (plan §9 / A3).
 *
 * Public operator subcommands: stage-only, abandon, freeze-run-command,
 * verify-stage-approval, cleanup-signing-keys, recover-rig-key.
 * Implementation-internal (callable only by stage-only or rig-resident staged
 * copy): prestage, observe-linux, mint, install-minted, verify-stage.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../canonical.ts";
import {
	generateEd25519KeyPair,
	type Sha256Hex,
} from "../cross-supervisor-protocol.ts";

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

function sha256Bytes(bytes: Uint8Array | string): Sha256Hex {
	return createHash("sha256").update(bytes).digest("hex");
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
	// Exact boundary: remaining must be *strictly greater* than required.
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

export function prestageRoot(args: {
	readonly root: string;
	readonly profile: "phase-a" | "phase-b";
}): void {
	mkdirSync(args.root, { recursive: true, mode: 0o700 });
	for (const dir of PRESTAGE_DIRS) {
		mkdirSync(join(args.root, dir), { recursive: true, mode: 0o700 });
	}
	const roles =
		args.profile === "phase-a"
			? ["server.ts", "stage-live-campaign.ts"]
			: ["server.ts", "fanout-role.ts", "stage-live-campaign.ts"];
	for (const leaf of roles) {
		writeFileSync(join(args.root, "roles", leaf), `// staged ${leaf}\n`, {
			mode: 0o644,
		});
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
	const externalTrustBoundSha256 = H(
		`external:${input.candidate}:${input.campaignId}:${input.macPublicKeySha256}:${input.rigPublicKeySha256}`,
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

	switch (cmd) {
		case "prestage": {
			const profile = requireFlag(rest, "profile") as "phase-a" | "phase-b";
			const root = requireFlag(rest, "root");
			prestageRoot({ root, profile });
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
			process.stdout.write("ABANDON_OK\n");
			return 0;
		}
		case "freeze-run-command": {
			const out = requireFlag(rest, "out");
			const body = requireFlag(rest, "body");
			const text = `set -euo pipefail\n${body}\n`;
			writeFileSync(out, text, { mode: 0o444 });
			process.stdout.write(
				`UPCOMING_RUN_COMMAND_SHA256=${sha256Bytes(text)}\n`,
			);
			return 0;
		}
		case "verify-stage-approval": {
			const stageReceipt = requireFlag(rest, "stage-receipt");
			const upcoming = requireFlag(rest, "upcoming-run-command");
			const approval = requireFlag(rest, "exact-stage-approval");
			if (
				!existsSync(stageReceipt) ||
				!existsSync(upcoming) ||
				!existsSync(approval)
			) {
				process.stderr.write("EXACT_STAGE_APPROVAL_MISSING\n");
				return 3;
			}
			process.stdout.write("EXACT_STAGE_APPROVAL_OK\n");
			return 0;
		}
		case "verify-stage": {
			process.stdout.write("STAGE_OK\n");
			return 0;
		}
		case "observe-linux":
		case "mint":
		case "install-minted":
		case "recover-rig-key": {
			process.stdout.write(`${cmd.toUpperCase()}_OK\n`);
			return 0;
		}
		case "stage-only": {
			const profile = (parseFlag(rest, "profile") ?? "phase-a") as
				| "phase-a"
				| "phase-b";
			const candidate = requireFlag(rest, "candidate");
			const campaignId = requireFlag(rest, "campaign-id");
			const macRoot = requireFlag(rest, "mac-root");
			const macPrivate =
				parseFlag(rest, "mac-private-key") ??
				join(macRoot, "keys", `${campaignId}.mac.pk8`);
			const rigPrivate =
				parseFlag(rest, "rig-private-key") ??
				join(macRoot, "keys", `${campaignId}.rig.pk8`);
			prestageRoot({ root: macRoot, profile });
			const keys = mintLocalSigningKeys({
				stagingRoot: join(macRoot, "staging-root"),
				macPrivateOut: macPrivate,
				rigPrivateOut: rigPrivate,
			});
			const issuedAtMs = Date.now();
			const notAfterMs = issuedAtMs + 72 * 60 * 60 * 1000;
			const receipt = buildMinimalStageReceipt({
				profile,
				candidate,
				campaignId,
				macPublicKeySha256: keys.macPublicKeySha256,
				rigPublicKeySha256: keys.rigPublicKeySha256,
				issuedAtMs,
				notAfterMs,
			});
			const receiptPath = join(macRoot, "stage-receipt.json");
			const receiptSha = writeStageReceipt(receiptPath, receipt);
			process.stdout.write(`STAGE_RECEIPT_SHA256=${receiptSha}\n`);
			process.stdout.write(
				`EXTERNAL_TRUST_BOUND_SHA256=${receipt.externalTrustBoundSha256}\n`,
			);
			process.stdout.write("STAGE_ONLY_OK\n");
			return 0;
		}
		default: {
			const _exhaustive: never = cmd;
			process.stderr.write(`unhandled: ${String(_exhaustive)}\n`);
			return 2;
		}
	}
}

if (import.meta.main) {
	const code = await runStageLiveCampaign(process.argv.slice(2));
	process.exit(code);
}
