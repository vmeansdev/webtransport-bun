import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../canonical.ts";
import {
	parseStagedServerLaunchRecord,
	STAGED_SERVER_TLS_CERTIFICATE_LEAF,
	STAGED_SERVER_TLS_PRIVATE_KEY_LEAF,
	stagedServerLaunchRecordProfile,
} from "../cohort-protocol.ts";
import {
	externalTrustBoundSha256,
	type Sha256Hex,
} from "../cross-supervisor-protocol.ts";
import { parseServerArgs } from "../server.ts";
import {
	assertKnownSubcommand,
	buildFrozenRunCommand,
	buildLiveMintRecords,
	buildMinimalStageReceipt,
	buildStagedServerLaunchRecord,
	cleanupSigningKeysIdempotent,
	directoryIdentitySameRoot,
	EXIT_STALE_OR_INVALID_STAGING,
	EXIT_USAGE,
	type ExactStageApprovalV1,
	ensureFinalRootLeafPlaceholders,
	INTERNAL_SUBCOMMANDS,
	LIVE_AUTHORITY_APPROVAL_FIELDS,
	LIVE_AUTHORITY_FIELDS,
	LIVE_CAPABILITY_FIELDS,
	LIVE_LOCK_FIELDS,
	type LiveStageReceiptV1,
	MAC_CAMPAIGN_ROOT_FINAL_LEAVES,
	macStagingRootFinalLeaves,
	mintLocalSigningKeys,
	mintStagedServerTlsIdentity,
	PRESTAGE_DIRS,
	PUBLIC_SUBCOMMANDS,
	parseExactStageReviewBindings,
	prestageRoot,
	REFUSED_STALE_OR_INVALID_STAGING,
	RIG_PRESTAGE_DIRS,
	RIG_STAGE_ROOT_LEAVES,
	remainingLifetimeMarginMs,
	runStageLiveCampaign,
	stagedServerLaunchModesForProfile,
	stagedServerLaunchRecordLeaf,
	TRUST_FIXTURE_ONLY_MINT_FORBIDDEN,
	userIdOf,
	verifyExactStageApproval,
} from "./stage-live-campaign.ts";

function sha256Text(value: string): Sha256Hex {
	return createHash("sha256").update(value).digest("hex") as Sha256Hex;
}

describe("stage-live-campaign", () => {
	it("rejects_unknown_subcommand", () => {
		expect(() => assertKnownSubcommand("remint")).toThrow(/unknown subcommand/);
	});

	it("closed_public_and_internal_subcommand_sets", () => {
		expect([...PUBLIC_SUBCOMMANDS]).toEqual([
			"stage-only",
			"abandon",
			"freeze-run-command",
			"verify-stage-approval",
			"cleanup-signing-keys",
			"recover-rig-key",
		]);
		expect([...INTERNAL_SUBCOMMANDS]).toEqual([
			"prestage",
			"observe-linux",
			"mint",
			"install-minted",
			"verify-stage",
		]);
	});

	it("authority_remaining_lifetime_margin_is_strict_gt", () => {
		const notAfter = 1_000_000;
		const required = 1000;
		expect(
			remainingLifetimeMarginMs(notAfter, notAfter - required, required).ok,
		).toBe(false);
		expect(
			remainingLifetimeMarginMs(notAfter, notAfter - required - 1, required).ok,
		).toBe(true);
	});

	it("idempotent_two_key_cleanup_on_pass_fail_refused_signals", () => {
		const root = mkdtempSync(join(tmpdir(), "stage-cleanup-"));
		const mac = join(root, "mac.pk8");
		const rig = join(root, "rig.pk8");
		writeFileSync(mac, "mac");
		writeFileSync(rig, "rig");
		const first = cleanupSigningKeysIdempotent({
			macPrivateKeyPath: mac,
			rigPrivateKeyPath: rig,
		});
		expect(first.destroyed.length).toBe(2);
		expect(existsSync(mac)).toBe(false);
		expect(existsSync(rig)).toBe(false);
		const second = cleanupSigningKeysIdempotent({
			macPrivateKeyPath: mac,
			rigPrivateKeyPath: rig,
		});
		expect(second.destroyed.length).toBe(0);
	});

	it("stage_only_argv_requires_plan_section_flags", async () => {
		const code = await runStageLiveCampaign([
			"stage-only",
			"--profile=phase-a",
			"--candidate=abc",
			"--campaign-id=probe",
			"--mac-root=/tmp/should-not-create-stage-root",
		]);
		expect(code).toBe(EXIT_USAGE);
	});

	it("stage_only_refuses_existing_mac_staging_root", async () => {
		const root = mkdtempSync(join(tmpdir(), "stage-only-refuse-"));
		const macRoot = join(root, "mac-trust");
		mkdirSync(macRoot);
		const code = await runStageLiveCampaign([
			"stage-only",
			`--repo=${process.cwd()}`,
			`--mac-bun=${process.execPath}`,
			"--rig=hermes-admin@10.99.0.2",
			`--ssh-key=${process.env.HOME}/.ssh/ubuntu-vm-hermes`,
			`--candidate=${"a".repeat(40)}`,
			"--campaign-id=a5-stage-probe-refuse",
			"--execution-purpose=focused",
			"--profile=phase-a",
			`--plan=${process.cwd()}/docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`,
			`--approval=${process.cwd()}/docs/superpowers/plans/approvals/2026-08-30-busyMs-attested-fanout.md`,
			`--mac-root=${macRoot}`,
			`--rig-root=/tmp/a5-stage-probe-refuse-rig`,
			"--authority-lifetime-ms=72000000",
		]);
		expect(code).toBe(EXIT_STALE_OR_INVALID_STAGING);
		expect(existsSync(join(macRoot, "stage-receipt.json"))).toBe(false);
		expect(existsSync(macRoot)).toBe(true);
	});

	it("phase_a_minimal_receipt_has_null_fanout_digest", () => {
		const receipt = buildMinimalStageReceipt({
			profile: "phase-a",
			candidate: "a".repeat(40),
			campaignId: "busyms-attested-focused-r1",
			macPublicKeySha256: "1".repeat(64) as Sha256Hex,
			rigPublicKeySha256: "2".repeat(64) as Sha256Hex,
			issuedAtMs: 1,
			notAfterMs: 2,
		});
		expect(receipt.fanoutRoleEntrypointSha256).toBeNull();
		expect(receipt.externalTrustBoundSha256).toMatch(/^[0-9a-f]{64}$/);
		// The fixture's bound is the live encoder over the fixture's own
		// digests, so a verifier recomputing it from this receipt lands on it.
		expect(receipt.externalTrustBoundSha256).toBe(
			externalTrustBoundSha256(receipt),
		);
	});

	it("live_mint_records_match_rust_exact_field_sets", () => {
		const hash = "1".repeat(64) as Sha256Hex;
		const records = buildLiveMintRecords({
			profile: "phase-a",
			repo: process.cwd(),
			candidate: "a".repeat(40),
			campaignId: "busyms-attested-focused-r1",
			candidateTreeOid: "b".repeat(40),
			issuedAt: "2026-08-31T12:00:00.000Z",
			notAfter: "2026-09-01T08:00:00.000Z",
			approvedPlanSha256: hash,
			approvalRecordSha256: "2".repeat(64) as Sha256Hex,
			sourceArchiveSha256: "3".repeat(64) as Sha256Hex,
			sourceArchiveSize: 123,
			archiveMemberCount: 4,
			archiveMemberInventorySha256: "4".repeat(64) as Sha256Hex,
			macBunSha256: "5".repeat(64) as Sha256Hex,
			linuxBunSha256: "6".repeat(64) as Sha256Hex,
			macSupervisorSha256: "7".repeat(64) as Sha256Hex,
			linuxSupervisorSha256: "8".repeat(64) as Sha256Hex,
			macCampaignIdentity: { platform: "darwin", inode: "1" },
			macStagingIdentity: { platform: "darwin", inode: "2" },
			linuxStagingIdentity: { platform: "linux", inode: "3" },
			macExecIdentity: { platform: "darwin", inode: "4" },
		});
		const sorted = (value: Record<string, unknown>) =>
			Object.keys(value).sort();

		expect(records.authority.approval.approvedPlanSha256).toBe(hash);
		expect(records.authority.approval.approvalRecordSha256).toBe(
			"2".repeat(64),
		);
		expect(sorted(records.authority)).toEqual(
			[...LIVE_AUTHORITY_FIELDS].sort(),
		);
		expect(sorted(records.authority.approval)).toEqual(
			[...LIVE_AUTHORITY_APPROVAL_FIELDS].sort(),
		);
		expect(sorted(records.lock)).toEqual([...LIVE_LOCK_FIELDS].sort());
		expect(sorted(records.capability)).toEqual(
			[...LIVE_CAPABILITY_FIELDS].sort(),
		);
		expect(records.authority).not.toHaveProperty("macSigningPublicKeyLeaf");
		expect(records.authority).not.toHaveProperty("rigSigningPublicKeyLeaf");
		expect(records.capability.macStagedArchiveSha256).not.toBe(
			records.capability.linuxStagedArchiveSha256,
		);
		expect(records.lock.cardinality).toEqual({
			executionCount: 2,
			descriptorCount: 3,
		});
	});

	it("prestage_phase_a_omits_fanout_role_leaf", () => {
		const root = mkdtempSync(join(tmpdir(), "prestage-"));
		prestageRoot({ root, profile: "phase-a" });
		expect(existsSync(join(root, "roles", "server.ts"))).toBe(true);
		expect(existsSync(join(root, "roles", "stage-live-campaign.ts"))).toBe(
			true,
		);
		expect(existsSync(join(root, "roles", "fanout-role.ts"))).toBe(false);
	});

	it("the rig's staged root gets no campaign root; the Mac's keeps both (G3b)", async () => {
		// The 2026-08-24 amendment: the Linux supervisor retains one root and
		// its official outputs travel to the Mac over the control stream, so a
		// rig campaign root would be a directory nothing reads.
		expect([...RIG_PRESTAGE_DIRS]).toEqual(
			PRESTAGE_DIRS.filter((dir) => dir !== "campaign-root"),
		);
		expect(PRESTAGE_DIRS).toContain("campaign-root");
		const root = mkdtempSync(join(tmpdir(), "prestage-host-"));
		const mac = join(root, "mac");
		const rig = join(root, "rig");
		prestageRoot({ root: mac, profile: "phase-b" });
		prestageRoot({ root: rig, profile: "phase-b", host: "linux" });
		expect(existsSync(join(mac, "campaign-root"))).toBe(true);
		expect(existsSync(join(rig, "campaign-root"))).toBe(false);
		for (const dir of RIG_PRESTAGE_DIRS) {
			expect(existsSync(join(rig, dir))).toBe(true);
		}
		// The rig script invokes the CLI with `--host=linux`; the flag is
		// closed to the two hosts.
		const viaCli = join(root, "cli-rig");
		expect(
			await runStageLiveCampaign([
				"prestage",
				"--profile=phase-b",
				`--root=${viaCli}`,
				"--host=linux",
			]),
		).toBe(0);
		expect(existsSync(join(viaCli, "campaign-root"))).toBe(false);
		expect(existsSync(join(viaCli, "staging-root"))).toBe(true);
		expect(
			await runStageLiveCampaign([
				"prestage",
				"--profile=phase-b",
				`--root=${join(root, "cli-bad")}`,
				"--host=rig",
			]),
		).toBe(EXIT_USAGE);
		rmSync(root, { recursive: true, force: true });
	});

	it("the rig root leaf set is closed and names the six leaves the binary reads through its root handle", () => {
		// `comparison-supervisor.rs`: lock, capability, manifest (bootstrap),
		// `MAC_PUBLIC_LEAF` (cohort runtime install), the two TLS leaves
		// (every server spawn) -- single-component reads, no subdirectory.
		expect([...RIG_STAGE_ROOT_LEAVES]).toEqual([
			"authority.json",
			"authority-digest.bin",
			"campaign-lock.json",
			"manifest.json",
			"staged-capability.json",
			"mac-supervisor-ed25519.pub",
			"rig-supervisor-ed25519.pub",
			"stage-receipt.json",
			"staged-server-tls.crt",
			"staged-server-tls.key",
		]);
	});

	it("freeze_run_command_rejects_legacy_out_body_flags", async () => {
		const code = await runStageLiveCampaign([
			"freeze-run-command",
			"--out=/tmp/x",
			"--body=echo",
		]);
		expect(code).toBe(EXIT_USAGE);
	});

	it("freeze_run_command_writes_mode_0444_from_stage_receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "freeze-"));
		const receipt = buildMinimalStageReceipt({
			profile: "phase-a",
			candidate: "b".repeat(40),
			campaignId: "freeze-probe",
			macPublicKeySha256: "3".repeat(64) as Sha256Hex,
			rigPublicKeySha256: "4".repeat(64) as Sha256Hex,
			issuedAtMs: Date.now(),
			notAfterMs: Date.now() + 72 * 3600_000,
		});
		const receiptPath = join(root, "stage-receipt.json");
		writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
		const out = join(root, "upcoming-run-command.sh");
		const code = await runStageLiveCampaign([
			"freeze-run-command",
			"--section=9.5",
			`--candidate=${"b".repeat(40)}`,
			"--campaign-id=freeze-probe",
			"--execution-purpose=focused",
			`--stage-receipt=${receiptPath}`,
			`--output=${out}`,
			`--repo=${process.cwd()}`,
		]);
		expect(code).toBe(0);
		expect(existsSync(out)).toBe(true);
		const mode = (await Bun.file(out).stat()).mode & 0o777;
		expect(mode).toBe(0o444);
		const body = readFileSync(out, "utf8");
		expect(body.startsWith("set -euo pipefail\n")).toBe(true);
		expect(body).toContain("verify-stage-approval");
		expect(body).toContain("--exact-stage-approval=");
		expect(body).toContain("--campaign-root=");
		expect(body).toContain("--external-trust-bound-sha256=");
		expect(body).not.toContain("--external-trust-bound ");
		expect(body).toContain("--source=sealed-index --allow-non-promotable");
		expect(body).toContain('--output="$OUT/diagnostic-report.md"');
		expect(body).toContain("RENDER_MODE=diagnostic");
	});

	it("verify_stage_approval_rejects_command_approval_aliases", async () => {
		const code = await runStageLiveCampaign([
			"verify-stage-approval",
			"--command=/tmp/x",
			"--approval=/tmp/y",
		]);
		expect(code).toBe(EXIT_USAGE);
	});

	it("parse_exact_stage_review_bindings_requires_unique_labels", () => {
		const body = [
			"APPROVED",
			"- Stage receipt SHA-256: " + "a".repeat(64),
			"- Upcoming run command SHA-256: " + "b".repeat(64),
			"- Candidate HEAD: " + "c".repeat(40),
			"- Worktree: /tmp/wt",
			"- Campaign ID: focused-r1",
			"",
		].join("\n");
		const bindings = parseExactStageReviewBindings(body);
		expect(bindings.campaignId).toBe("focused-r1");
		expect(() =>
			parseExactStageReviewBindings(
				"REJECTED\n" + body.slice("APPROVED\n".length),
			),
		).toThrow(/REVIEW_NOT_APPROVED/);
		expect(() =>
			parseExactStageReviewBindings(
				body + "\n- Stage receipt SHA-256: " + "d".repeat(64) + "\n",
			),
		).toThrow(/LABEL_DUPLICATE/);
	});

	it("directory_identity_same_root_ignores_hard_link_count_drift", () => {
		const base = {
			platform: "darwin",
			device: "1",
			inode: "9",
			volumeUuid: "abc",
			hardLinkCount: "6",
		};
		expect(
			directoryIdentitySameRoot(base, { ...base, hardLinkCount: "8" }),
		).toBe(true);
		expect(directoryIdentitySameRoot(base, { ...base, inode: "10" })).toBe(
			false,
		);
	});

	it("ensure_final_root_leaf_placeholders_stabilize_leaf_cardinality", () => {
		const root = mkdtempSync(join(tmpdir(), "leaf-placeholders-"));
		const campaignRoot = join(root, "campaign-root");
		const stagingRoot = join(root, "staging-root");
		mkdirSync(stagingRoot, { recursive: true });
		writeFileSync(join(stagingRoot, "mac-supervisor-ed25519.pub"), "x");
		ensureFinalRootLeafPlaceholders({
			campaignRoot,
			stagingRoot,
			profile: "phase-b",
		});
		for (const leaf of MAC_CAMPAIGN_ROOT_FINAL_LEAVES) {
			expect(existsSync(join(campaignRoot, leaf))).toBe(true);
		}
		for (const leaf of macStagingRootFinalLeaves("phase-b")) {
			expect(existsSync(join(stagingRoot, leaf))).toBe(true);
		}
		expect(existsSync(join(stagingRoot, "mac-supervisor-ed25519.pub"))).toBe(
			true,
		);
		ensureFinalRootLeafPlaceholders({
			campaignRoot,
			stagingRoot,
			profile: "phase-b",
		});
		expect(readdirSync(campaignRoot).sort()).toEqual(
			[...MAC_CAMPAIGN_ROOT_FINAL_LEAVES].sort(),
		);
	});

	it("verify_exact_stage_approval_recomputes_digests_and_bindings", async () => {
		const root = mkdtempSync(join(tmpdir(), "verify-stage-approval-"));
		mkdirSync(join(root, "staging-root"), { recursive: true });
		const candidate = "d".repeat(40);
		const campaignId = "busyms-attested-focused-r1";
		const macIdentity = {
			platform: "darwin",
			device: "16777234",
			inode: "1001",
			volumeUuid: "vol",
			hardLinkCount: "6",
		};
		const linuxIdentity = {
			platform: "linux",
			deviceMajor: "259",
			deviceMinor: "4",
			inode: "2002",
			hardLinkCount: "9",
		};
		const receipt = {
			...buildMinimalStageReceipt({
				profile: "phase-a",
				candidate,
				campaignId,
				macPublicKeySha256: "1".repeat(64) as Sha256Hex,
				rigPublicKeySha256: "2".repeat(64) as Sha256Hex,
				issuedAtMs: 1,
				notAfterMs: 2,
			}),
			macDirectoryIdentitySha256: sha256Text(canonicalJson(macIdentity)),
			linuxDirectoryIdentitySha256: sha256Text(canonicalJson(linuxIdentity)),
		} as LiveStageReceiptV1;
		const receiptPath = join(root, "stage-receipt.json");
		writeFileSync(receiptPath, `${canonicalJson(receipt)}\n`);
		const commandPath = join(root, "upcoming-run-command.sh");
		writeFileSync(commandPath, "set -euo pipefail\necho ok\n", { mode: 0o444 });
		const reviewBody = [
			"APPROVED",
			`- Stage receipt SHA-256: ${sha256Text(`${canonicalJson(receipt)}\n`)}`,
			`- Upcoming run command SHA-256: ${sha256Text("set -euo pipefail\necho ok\n")}`,
			`- Candidate HEAD: ${candidate}`,
			`- Worktree: ${root}`,
			`- Campaign ID: ${campaignId}`,
			"",
		].join("\n");
		const architectPath = join(root, "exact-stage-architect-review.md");
		const criticPath = join(root, "exact-stage-critic-review.md");
		writeFileSync(architectPath, reviewBody);
		writeFileSync(criticPath, reviewBody);
		const approval: ExactStageApprovalV1 = {
			schema: "exact-stage-approval/v1",
			campaignId,
			executionPurpose: "focused",
			stageProfile: "phase-a",
			runSection: "9.5",
			worktree: root,
			candidateHead: candidate,
			stageReceiptSha256: sha256Text(`${canonicalJson(receipt)}\n`),
			approvedPlanSha256: receipt.approvedPlanSha256,
			approvalRecordSha256: receipt.approvalRecordSha256,
			upcomingRunCommandSha256: sha256Text("set -euo pipefail\necho ok\n"),
			architectReviewPath: architectPath,
			architectReviewSha256: sha256Text(reviewBody),
			criticReviewPath: criticPath,
			criticReviewSha256: sha256Text(reviewBody),
			finalizedAtMs: 1,
		};
		const approvalPath = join(root, "exact-stage-approval.json");
		writeFileSync(approvalPath, `${canonicalJson(approval)}\n`);
		writeFileSync(
			join(root, "authority.json"),
			`${canonicalJson({
				roots: [
					{ kind: "mac-staging", identity: macIdentity },
					{ kind: "linux-staging", identity: linuxIdentity },
				],
			})}\n`,
		);
		writeFileSync(
			join(root, "linux-stage-observation.json"),
			`${canonicalJson({
				schema: "linux-stage-observation/v1",
				candidate,
				campaignId,
				directoryIdentity: linuxIdentity,
				directoryIdentitySha256: sha256Text(canonicalJson(linuxIdentity)),
				linuxBunSha256: "3".repeat(64),
				linuxSupervisorSha256: "4".repeat(64),
				linuxObserverSha256: "5".repeat(64),
				linuxAddonManifestSha256: "6".repeat(64),
				serverEntrypointSha256: "7".repeat(64),
				fanoutRoleEntrypointSha256: null,
				stageToolEntrypointSha256: "8".repeat(64),
				macSigningPublicKeySha256: "1".repeat(64),
				rigSigningPublicKeySha256: "2".repeat(64),
				rigSigningKeyLeaseSha256: "9".repeat(64),
			})}\n`,
		);

		await verifyExactStageApproval({
			stageReceiptPath: receiptPath,
			upcomingRunCommandPath: commandPath,
			exactStageApprovalPath: approvalPath,
			resolveGitHead: async () => candidate,
			resolveGitStatus: async () => ({ code: 0, stdout: "", stderr: "" }),
			resolveStageToolSha: () => receipt.stageToolEntrypointSha256,
			resolveServerSha: () => receipt.serverEntrypointSha256,
			resolveObserverBin: () => "/dev/null",
			observeDirectoryIdentity: async () => ({
				...macIdentity,
				hardLinkCount: "8",
			}),
		});

		await expect(
			verifyExactStageApproval({
				stageReceiptPath: receiptPath,
				upcomingRunCommandPath: commandPath,
				exactStageApprovalPath: approvalPath,
				resolveGitHead: async () => "e".repeat(40),
				resolveGitStatus: async () => ({ code: 0, stdout: "", stderr: "" }),
				resolveStageToolSha: () => receipt.stageToolEntrypointSha256,
				resolveServerSha: () => receipt.serverEntrypointSha256,
				resolveObserverBin: () => "/dev/null",
				observeDirectoryIdentity: async () => macIdentity,
			}),
		).rejects.toThrow(/HEAD_MISMATCH/);

		const code = await runStageLiveCampaign([
			"verify-stage-approval",
			`--stage-receipt=${receiptPath}`,
			`--upcoming-run-command=${commandPath}`,
			`--exact-stage-approval=${approvalPath}`,
		]);
		// CLI uses live git/observer; fixture worktree is not a git root → fail-closed.
		expect(code).toBe(EXIT_STALE_OR_INVALID_STAGING);
	});

	it("mint_live_trust_bootstrap_is_fixture_only", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"./tools/compare/bin/mint-live-trust-bootstrap.ts",
				"--out=/tmp/should-not-mint",
				"--candidate=abc",
			],
			{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
		);
		const [stderr, code] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).not.toBe(0);
		expect(stderr).toContain(TRUST_FIXTURE_ONLY_MINT_FORBIDDEN);
	});

	it("keygen_refuses_existing_private_path", () => {
		const root = mkdtempSync(join(tmpdir(), "keygen-"));
		mkdirSync(join(root, "staging-root"), { recursive: true });
		const mac = join(root, "mac.pk8");
		const rig = join(root, "rig.pk8");
		mintLocalSigningKeys({
			stagingRoot: join(root, "staging-root"),
			macPrivateOut: mac,
			rigPrivateOut: rig,
		});
		expect(() =>
			mintLocalSigningKeys({
				stagingRoot: join(root, "staging-root"),
				macPrivateOut: mac,
				rigPrivateOut: join(root, "rig2.pk8"),
			}),
		).toThrow(/TRUST_SIGNING_KEY_EXISTS/);
	});

	it("refused_stale_constant_is_stable", () => {
		expect(REFUSED_STALE_OR_INVALID_STAGING).toBe(
			"REFUSED/STALE_OR_INVALID_STAGING",
		);
	});
});

/**
 * The frozen wrapper is shell, and the thing that has to be right is the argv it
 * actually emits -- not the text of the fragment. These tests run the generated
 * command under bash with `$MAC_BUN` replaced by an argv recorder and `test`
 * replaced by a logger, so every assertion below is over bytes a real run would
 * have produced.
 */
const WRAPPER_PHASE_MARKER = "__INTEGRITY_PHASE_MARKER__";

function decodeInvocations(raw: string): string[][] {
	return raw
		.split("\u001d")
		.filter((chunk) => chunk.length > 0)
		.map((chunk) => chunk.split("\u001e").slice(0, -1));
}

async function runFrozenWrapper(args: {
	readonly section: "9.5" | "9.6" | "9.7";
	readonly campaignId: string;
	readonly executionPurpose: string;
	readonly seedOut?: (out: string) => void;
}): Promise<{
	readonly bun: string[][];
	readonly countChecks: string[][];
	readonly exitCode: number;
	readonly stderr: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "frozen-wrapper-"));
	const out = join(root, "out");
	mkdirSync(out, { recursive: true });
	const argvLog = join(root, "argv.log");
	const testLog = join(root, "test.log");
	const macBun = join(root, "mac-bun");
	writeFileSync(
		macBun,
		[
			"#!/bin/sh",
			'if [ "${1:-}" != "-e" ]; then',
			`  { for a in "$@"; do printf '%s\\036' "$a"; done; printf '\\035'; } >>"$ARGV_LOG"`,
			"fi",
			"exit 0",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	// The wrapper treats a missing terminal record after a zero controller exit
	// as a failure, so the success path only exists when this file is there.
	writeFileSync(join(out, "controller-terminal.json"), "{}\n");
	args.seedOut?.(out);
	const receipt = buildMinimalStageReceipt({
		profile: "phase-a",
		candidate: "c".repeat(40),
		campaignId: args.campaignId,
		macPublicKeySha256: "5".repeat(64) as Sha256Hex,
		rigPublicKeySha256: "6".repeat(64) as Sha256Hex,
		issuedAtMs: Date.now(),
		notAfterMs: Date.now() + 72 * 3600_000,
	});
	const body = buildFrozenRunCommand({
		section: args.section,
		repo: process.cwd(),
		candidate: "c".repeat(40),
		campaignId: args.campaignId,
		executionPurpose: args.executionPurpose,
		stageReceipt: receipt,
		macTrust: join(root, "trust"),
		macRuntime: join(root, "runtime"),
		rig: "rig@example.invalid",
		rigStage: join(root, "rig-stage"),
		sshKey: join(root, "ssh-key"),
		macBun,
		out,
		runTimeoutMs: 1000,
	});
	const prelude = [
		`test() { { for a in "$@"; do printf '%s\\036' "$a"; done; printf '\\035'; } >>"$TEST_LOG"; return 0; }`,
		"trap() { :; }",
		"sudo() { return 0; }",
		"ssh() { return 0; }",
		"",
	].join("\n");
	// Drive the integrity path the same run, after a marker so the count checks
	// above it stay separable from the integrity attempt's own probes.
	const epilogue = [
		`test ${WRAPPER_PHASE_MARKER}`,
		"INTEGRITY_DONE=0",
		"ORIGINAL_RC=9",
		"TERMINAL_KIND=FAIL",
		"finalize_terminal_integrity",
		"",
	].join("\n");
	const script = join(root, "run.sh");
	writeFileSync(script, `${prelude}${body}${epilogue}`);
	const proc = Bun.spawn(["/bin/bash", script], {
		cwd: process.cwd(),
		env: { ...process.env, ARGV_LOG: argvLog, TEST_LOG: testLog },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const bun = existsSync(argvLog)
		? decodeInvocations(readFileSync(argvLog, "utf8"))
		: [];
	const tests = existsSync(testLog)
		? decodeInvocations(readFileSync(testLog, "utf8"))
		: [];
	const markerAt = tests.findIndex(
		(argv) => argv.length === 1 && argv[0] === WRAPPER_PHASE_MARKER,
	);
	const countChecks = markerAt === -1 ? tests : tests.slice(0, markerAt);
	return { bun, countChecks, exitCode, stderr };
}

function verifyIndexInvocations(bun: string[][]): string[][] {
	return bun.filter((argv) =>
		argv.some((arg) => arg.endsWith("bin/verify-campaign-index.ts")),
	);
}

/**
 * Runs the generated command with REAL traps (no `trap() { :; }` stub), so
 * the EXIT trap's key destruction is observable through the recorded
 * `sudo`/`ssh` stubs. `approval` decides whether verify-stage-approval
 * succeeds; `controllerRc` is what the controller stub exits with.
 */
async function runFrozenWrapperWithRealTraps(opts: {
	readonly approval: "ok" | "missing";
	readonly controllerRc: number;
}): Promise<{
	readonly exitCode: number;
	readonly stderr: string;
	readonly sudo: string[][];
	readonly ssh: string[][];
	readonly integrityDirExists: boolean;
}> {
	const root = mkdtempSync(join(tmpdir(), "frozen-admission-"));
	const out = join(root, "out");
	const trust = join(root, "trust");
	mkdirSync(out, { recursive: true });
	mkdirSync(join(trust, "staging-root"), { recursive: true });
	writeFileSync(join(out, "controller-terminal.json"), "{}\n");
	const macLeaf = "mac-leaf\n";
	const rigLeaf = "rig-leaf\n";
	writeFileSync(
		join(trust, "staging-root/mac-supervisor-ed25519.pub"),
		macLeaf,
	);
	writeFileSync(
		join(trust, "staging-root/rig-supervisor-ed25519.pub"),
		rigLeaf,
	);
	const sudoLog = join(root, "sudo.log");
	const sshLog = join(root, "ssh.log");
	const macBun = join(root, "mac-bun");
	writeFileSync(
		macBun,
		[
			"#!/bin/sh",
			'case "$*" in',
			// The wrapper itself assigns CONTROLLER_RC (inherited exports stay
			// exported), so the stub reads names the wrapper never touches.
			'  *verify-stage-approval*) exit "$STUB_APPROVAL_RC" ;;',
			'  *compare-controller.ts*) exit "$STUB_CONTROLLER_RC" ;;',
			"esac",
			"exit 0",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const receipt = buildMinimalStageReceipt({
		profile: "phase-a",
		candidate: "c".repeat(40),
		campaignId: "busyms-attested-focused-r1",
		macPublicKeySha256: sha256Text(macLeaf),
		rigPublicKeySha256: sha256Text(rigLeaf),
		issuedAtMs: Date.now(),
		notAfterMs: Date.now() + 72 * 3600_000,
	});
	const command = buildFrozenRunCommand({
		section: "9.5",
		repo: process.cwd(),
		candidate: "c".repeat(40),
		campaignId: "busyms-attested-focused-r1",
		executionPurpose: "focused",
		stageReceipt: receipt,
		macTrust: trust,
		macRuntime: join(root, "runtime"),
		rig: "rig@example.invalid",
		rigStage: join(root, "rig-stage"),
		sshKey: join(root, "ssh-key"),
		macBun,
		out,
		runTimeoutMs: 1000,
	}).replaceAll("/usr/bin/sudo", "sudo");
	const record = (log: string) =>
		`{ for a in "$@"; do printf '%s\\036' "$a"; done; printf '\\035'; } >>"${log}"`;
	const script = [
		"sudo() {",
		`  ${record("$SUDO_LOG")}`,
		'  case "$*" in *campaign-key-absence*) printf %s ABSENT; return 0 ;; esac',
		"  return 0",
		"}",
		"ssh() {",
		`  ${record("$SSH_LOG")}`,
		'  case "$*" in *campaign-key-absence*) printf %s ABSENT; return 0 ;; esac',
		"  return 0",
		"}",
		command,
		"",
	].join("\n");
	const scriptPath = join(root, "run.sh");
	writeFileSync(scriptPath, script);
	const proc = Bun.spawn(["/bin/bash", scriptPath], {
		cwd: process.cwd(),
		env: {
			...process.env,
			SUDO_LOG: sudoLog,
			SSH_LOG: sshLog,
			STUB_APPROVAL_RC: opts.approval === "ok" ? "0" : "3",
			STUB_CONTROLLER_RC: String(opts.controllerRc),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		stderr,
		sudo: existsSync(sudoLog)
			? decodeInvocations(readFileSync(sudoLog, "utf8"))
			: [],
		ssh: existsSync(sshLog)
			? decodeInvocations(readFileSync(sshLog, "utf8"))
			: [],
		integrityDirExists: existsSync(join(out, "integrity-only")),
	};
}

describe("frozen run wrapper admission gates", () => {
	// 2026-09-08: the command was launched before exact-stage-approval.json
	// existed; verify-stage-approval exited 3 under `set -e`, the already-armed
	// EXIT trap destroyed both campaign private keys, and the stage had to be
	// abandoned. An administrative refusal must not cost the stage.
	it("a_missing_approval_refuses_before_any_key_can_be_destroyed", async () => {
		const run = await runFrozenWrapperWithRealTraps({
			approval: "missing",
			controllerRc: 0,
		});
		expect(run.exitCode).not.toBe(0);
		expect(run.sudo).toEqual([]);
		expect(run.ssh).toEqual([]);
		expect(run.integrityDirExists).toBe(false);
	});

	it("a_failure_after_admission_still_destroys_both_keys", async () => {
		const run = await runFrozenWrapperWithRealTraps({
			approval: "ok",
			controllerRc: 1,
		});
		expect(run.exitCode).not.toBe(0);
		const probes = (log: string[][]) =>
			log.filter((argv) =>
				argv.some((a) => a.includes("campaign-key-absence")),
			);
		expect(probes(run.sudo).length).toBeGreaterThan(0);
		expect(probes(run.ssh).length).toBeGreaterThan(0);
	});

	it("the_admission_gates_precede_the_first_trap_in_the_emitted_bytes", () => {
		const command = frozenCommandForEnvAudit();
		const firstTrap = command.indexOf("\ntrap ");
		const approval = command.indexOf("verify-stage-approval");
		expect(approval).toBeGreaterThan(-1);
		expect(approval).toBeLessThan(firstTrap);
	});

	it("the_integrity_verifier_path_does_not_depend_on_the_cwd", () => {
		const command = frozenCommandForEnvAudit();
		expect(command).not.toContain(
			'"$MAC_BUN" tools/compare/bin/verify-campaign-index.ts',
		);
		expect(command).toContain(
			'"$REPO/tools/compare/bin/verify-campaign-index.ts"',
		);
	});
});

describe("frozen run wrapper argv", () => {
	it("integrity_attempt_is_integrity_only_and_success_path_is_not", async () => {
		const run = await runFrozenWrapper({
			section: "9.5",
			campaignId: "busyms-attested-focused-r1",
			executionPurpose: "focused",
		});
		expect(run.exitCode).toBe(0);
		const verifies = verifyIndexInvocations(run.bun);
		expect(verifies.length).toBe(2);
		const success = verifies[0]!;
		const integrity = verifies[1]!;
		expect(success).not.toContain("--integrity-only");
		expect(integrity).toContain("--integrity-only");
		// Integrity-only reports zero promotable and cannot complete a claim, so
		// it must not carry any count expectation that a full run owns.
		expect(integrity.filter((arg) => arg.startsWith("--expect"))).toEqual([]);
	});

	it("success_verification_opens_the_signature_graph_with_both_staged_leaves", async () => {
		// Both or neither: the verifier refuses half the trust material, so a
		// wrapper that passed one flag would fail the run rather than verify half
		// of it. What this test is really guarding is the *absent* case -- neither
		// flag, in which case the verifier counts entries and opens no signature.
		for (const section of ["9.5", "9.6", "9.7"] as const) {
			const run = await runFrozenWrapper({
				section,
				campaignId:
					section === "9.5"
						? "busyms-attested-focused-r1"
						: section === "9.6"
							? "fanout-pilot-r1"
							: "fanout-attested-r1",
				executionPurpose:
					section === "9.5"
						? "focused"
						: section === "9.6"
							? "pilot"
							: "canonical",
				...(section === "9.7" ? { seedOut: seedPromotedCampaignRoot } : {}),
			});
			const success = verifyIndexInvocations(run.bun)[0]!;
			const mac = success.find((arg) => arg.startsWith("--mac-public-key="));
			const rig = success.find((arg) => arg.startsWith("--rig-public-key="));
			expect(mac).toBeDefined();
			expect(rig).toBeDefined();
			// The leaf names are `stage-live-campaign.ts`'s, under the staged
			// staging-root the pre-run gate already digest-checked.
			expect(mac!.endsWith("/staging-root/mac-supervisor-ed25519.pub")).toBe(
				true,
			);
			expect(rig!.endsWith("/staging-root/rig-supervisor-ed25519.pub")).toBe(
				true,
			);
			// The stage receipt beside them is what lets the verifier recompute
			// the frozen external trust bound; without it no seal is promotable.
			const receipt = success.find((arg) => arg.startsWith("--stage-receipt="));
			expect(receipt).toBeDefined();
			expect(receipt!.endsWith("/stage-receipt.json")).toBe(true);
			expect(receipt!.slice("--stage-receipt=".length)).toBe(
				`${mac!.slice("--mac-public-key=".length, -"/staging-root/mac-supervisor-ed25519.pub".length)}/stage-receipt.json`,
			);
			// The integrity attempt proves bytes only; it must not claim to have
			// opened a signature graph it is not allowed to conclude anything from.
			const integrity = verifyIndexInvocations(run.bun)[1]!;
			expect(integrity.some((arg) => arg.startsWith("--mac-public-key="))).toBe(
				false,
			);
			expect(integrity.some((arg) => arg.startsWith("--rig-public-key="))).toBe(
				false,
			);
			expect(integrity.some((arg) => arg.startsWith("--stage-receipt="))).toBe(
				false,
			);
		}
	});

	it("success_verification_states_the_per_section_expected_counts", async () => {
		const focused = await runFrozenWrapper({
			section: "9.5",
			campaignId: "busyms-attested-focused-r1",
			executionPurpose: "focused",
		});
		const focusedArgv = verifyIndexInvocations(focused.bun)[0]!;
		expect(focusedArgv).toContain("--expected-pass-count=2");
		expect(focusedArgv).toContain("--expected-sealed-count=2");
		expect(focusedArgv).toContain("--expected-flat-count=0");
		expect(focusedArgv).not.toContain("--expect-canonical-fanout-complete");

		const pilot = await runFrozenWrapper({
			section: "9.6",
			campaignId: "fanout-pilot-r1",
			executionPurpose: "pilot",
		});
		const pilotArgv = verifyIndexInvocations(pilot.bun)[0]!;
		expect(pilotArgv).toContain("--expected-pass-count=2");
		expect(pilotArgv).toContain("--expected-sealed-count=2");
		expect(pilotArgv).toContain("--expected-flat-count=0");
		expect(pilotArgv).toContain("--expected-promotable-count=0");
		expect(pilotArgv).not.toContain("--expect-canonical-fanout-complete");

		const canonical = await runFrozenWrapper({
			section: "9.7",
			campaignId: "fanout-attested-r1",
			executionPurpose: "canonical",
			seedOut: seedPromotedCampaignRoot,
		});
		const canonicalArgv = verifyIndexInvocations(canonical.bun)[0]!;
		expect(canonicalArgv).toContain("--expected-pass-count=60");
		expect(canonicalArgv).toContain("--expected-sealed-count=60");
		expect(canonicalArgv).toContain("--expected-flat-count=12");
		expect(canonicalArgv).toContain("--expected-promotable-count=60");
		expect(canonicalArgv).toContain("--expect-canonical-fanout-complete");
	});

	// The count flags are blind to `transport`, `armKind` and `repetitionKind`:
	// `--expected-pass-count=2` reads the same for the registered ws+wt primary
	// pair and for two runs of one wire. Each section also states the topology
	// it registered, so the verifier proves the shape rather than restating the
	// producer's own argv.
	it("success_verification_states_the_registered_topology_of_its_section", async () => {
		const sections = [
			{
				section: "9.5",
				campaignId: "busyms-attested-focused-r1",
				executionPurpose: "focused",
				cells: "bulk-one-way/physical",
				reps: "1",
			},
			{
				section: "9.6",
				campaignId: "fanout-pilot-r1",
				executionPurpose: "pilot",
				cells: "ticker-fanout/rate-100",
				reps: "1",
			},
			{
				section: "9.7",
				campaignId: "fanout-attested-r1",
				executionPurpose: "canonical",
				cells:
					"ticker-fanout/rate-25,ticker-fanout/rate-50,ticker-fanout/rate-100," +
					"chat-fanout/subscribers-250,chat-fanout/subscribers-500,chat-fanout/subscribers-1000",
				reps: "5",
			},
		] as const;
		for (const declared of sections) {
			const run = await runFrozenWrapper({
				section: declared.section,
				campaignId: declared.campaignId,
				executionPurpose: declared.executionPurpose,
				...(declared.section === "9.7"
					? { seedOut: seedPromotedCampaignRoot }
					: {}),
			});
			const success = verifyIndexInvocations(run.bun)[0]!;
			expect(success).toContain(`--expect-cells=${declared.cells}`);
			expect(success).toContain("--expect-arms=ws,wt");
			expect(success).toContain("--expect-arm-kinds=primary");
			expect(success).toContain(
				`--expect-measured-repetitions=${declared.reps}`,
			);
			// The measured cells the verifier is told to prove are the measured
			// cells the controller was told to run: one source, not two.
			const controller = run.bun.find((argv) =>
				argv.some((arg) => arg.endsWith("bin/compare-controller.ts")),
			)!;
			expect(controller).toContain(`--cells=${declared.cells}`);
			expect(controller).toContain("--arm-kinds=primary");
			expect(controller).toContain(`--reps=${declared.reps}`);
			// Integrity-only proves bytes; it may not carry a topology claim.
			const integrity = verifyIndexInvocations(run.bun)[1]!;
			expect(integrity.filter((arg) => arg.startsWith("--expect"))).toEqual([]);
		}
	});

	it("wrapper_flat_count_excludes_the_controller_terminal_record", async () => {
		const run = await runFrozenWrapper({
			section: "9.7",
			campaignId: "fanout-attested-r1",
			executionPurpose: "canonical",
			seedOut: seedPromotedCampaignRoot,
		});
		expect(run.exitCode).toBe(0);
		// sealed count, flat count, attested-heading count -- in wrapper order.
		const last3 = run.countChecks.slice(-3);
		expect(last3.length).toBe(3);
		const flats = last3[1]!;
		expect(flats.slice(1)).toEqual(["=", "12"]);
		// 12 promoted flats sit beside campaign-index.json, manifest.json and
		// controller-terminal.json; counting the last one made this 13.
		expect(flats[0]).toBe("12");
	});
});

/** A promoted canonical root: 12 flats plus the three run-control files. */
function seedPromotedCampaignRoot(out: string): void {
	writeFileSync(join(out, "campaign-index.json"), "{}\n");
	writeFileSync(join(out, "manifest.json"), "{}\n");
	for (let i = 1; i <= 6; i += 1) {
		writeFileSync(join(out, `cell-${i}-ws.json`), "{}\n");
		writeFileSync(join(out, `cell-${i}-wt.json`), "{}\n");
	}
	// Deliberately not 12, so the heading check cannot be mistaken for the flats
	// check when both compare against the same literal.
	writeFileSync(
		join(out, "campaign-report.md"),
		`${Array.from({ length: 5 }, () => "### WS attested arm").join("\n")}\n`,
	);
}

describe("stage-live-campaign: the approval identity is always explicit", () => {
	// Amendment: "Stage tooling must accept the explicitly supplied
	// approved-plan/record paths and must not silently reuse the old approval
	// record." The mint has no default for either path: a call that omits one
	// is refused by name before any file is read, and there is nothing it
	// could fall back to.
	// The TLS identity joins the same rule (amendment C4, "Staging binds ...
	// TLS"): the mint has no default certificate or key to fall back to.
	for (const missing of [
		"approved-plan",
		"approval-record",
		"tls-cert",
		"tls-key",
	] as const) {
		it(`mint refuses without --${missing} rather than reusing an earlier approval`, async () => {
			const args = [
				"mint",
				"--profile=phase-b",
				"--candidate=cand",
				"--campaign-id=camp",
				"--source-archive=/dev/null",
				"--mac-root=/dev/null",
				"--linux-observation=/dev/null",
				"--approved-plan=/dev/null",
				"--approval-record=/dev/null",
				"--mac-bun=/dev/null",
				"--mac-supervisor=/dev/null",
				"--mac-observer=/dev/null",
				"--mac-addon-root=/dev/null",
				"--mac-public-key=/dev/null",
				"--rig-public-key=/dev/null",
				"--tls-cert=/dev/null",
				"--tls-key=/dev/null",
				"--not-after-ms=1",
			].filter((arg) => !arg.startsWith(`--${missing}=`));
			const proc = Bun.spawn(
				[
					process.execPath,
					"./tools/compare/bin/stage-live-campaign.ts",
					...args,
				],
				{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
			);
			const [stderr, code] = await Promise.all([
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code).not.toBe(0);
			expect(stderr).toContain(`missing --${missing}`);
		});
	}
});

describe("stage-live-campaign: the staged server TLS identity", () => {
	// Amendment C4: "Staging binds real launch argv, local/remote
	// binaries/addon/Bun, TLS and immutable roots". The identity is minted at
	// stage time, the certificate is a final leaf of the Mac staging root, and
	// install-minted puts both leaves directly under the rig's one staged root
	// with the key readable by nobody else.
	it("mints one self-signed leaf for the frozen server name and the rig address", () => {
		const root = mkdtempSync(join(tmpdir(), "stage-tls-"));
		const tls = mintStagedServerTlsIdentity({
			outDir: join(root, "tls"),
			validDays: 1,
			profile: "phase-b",
		});
		expect(readFileSync(tls.certPath, "utf8")).toContain(
			"-----BEGIN CERTIFICATE-----",
		);
		expect(statSync(tls.keyPath).mode & 0o777).toBe(0o600);
		const text = Bun.spawnSync({
			cmd: ["openssl", "x509", "-in", tls.certPath, "-noout", "-text"],
			stdout: "pipe",
			stderr: "pipe",
		}).stdout.toString();
		expect(text).toContain("DNS:wt-compare.local");
		expect(text).toContain("IP Address:10.99.0.2");
		// A physical profile's certificate never names loopback: a child that
		// connected there would fail identity verification, not be redirected.
		expect(text).not.toContain("IP Address:127.0.0.1");
		expect(text).toContain("CA:FALSE");
		expect(text).toContain("TLS Web Server Authentication");
		// One identity per campaign root: a second mint over it is refused, so a
		// stage cannot silently rotate the certificate a receipt already binds.
		expect(() =>
			mintStagedServerTlsIdentity({
				outDir: join(root, "tls"),
				validDays: 1,
				profile: "phase-b",
			}),
		).toThrow("TRUST_TLS_IDENTITY_EXISTS");
		rmSync(root, { recursive: true, force: true });
	});

	it("the local-acceptance certificate adds loopback to the SAN and nothing else changes", () => {
		// Design §3.1: one machine, loopback instead of 10.99.0.2. The local
		// profile's children connect to 127.0.0.1 and verify the staged CA
		// against the frozen server name, so the leaf carries loopback beside
		// the cable address; only that profile does.
		const root = mkdtempSync(join(tmpdir(), "stage-tls-local-"));
		const tls = mintStagedServerTlsIdentity({
			outDir: join(root, "tls"),
			validDays: 1,
			profile: "local-acceptance",
		});
		const text = Bun.spawnSync({
			cmd: ["openssl", "x509", "-in", tls.certPath, "-noout", "-text"],
			stdout: "pipe",
			stderr: "pipe",
		}).stdout.toString();
		expect(text).toContain("DNS:wt-compare.local");
		expect(text).toContain("IP Address:10.99.0.2");
		expect(text).toContain("IP Address:127.0.0.1");
		expect(text).toContain("CA:FALSE");
		rmSync(root, { recursive: true, force: true });
	});

	it("the certificate is a final leaf of the Mac staging root", () => {
		expect(macStagingRootFinalLeaves("phase-b")).toContain(
			STAGED_SERVER_TLS_CERTIFICATE_LEAF,
		);
		const root = mkdtempSync(join(tmpdir(), "stage-tls-leaves-"));
		ensureFinalRootLeafPlaceholders({
			campaignRoot: join(root, "campaign-root"),
			stagingRoot: join(root, "staging-root"),
			profile: "phase-b",
		});
		expect(
			existsSync(
				join(root, "staging-root", STAGED_SERVER_TLS_CERTIFICATE_LEAF),
			),
		).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	it("install-minted hands the key to the supervisor account at 0400 and refuses a certificate the receipt does not bind", async () => {
		const root = mkdtempSync(join(tmpdir(), "stage-tls-install-"));
		const incoming = join(root, "incoming");
		mkdirSync(incoming, { recursive: true });
		const tls = mintStagedServerTlsIdentity({
			outDir: join(root, "tls"),
			validDays: 1,
			profile: "phase-b",
		});
		const cert = readFileSync(tls.certPath);
		const receipt = {
			...buildMinimalStageReceipt({
				profile: "phase-b",
				candidate: "cand",
				campaignId: "camp",
				macPublicKeySha256: sha256Text("mac"),
				rigPublicKeySha256: sha256Text("rig"),
				issuedAtMs: 1,
				notAfterMs: 2,
			}),
			tlsCertificateSha256: createHash("sha256")
				.update(cert)
				.digest("hex") as Sha256Hex,
		};
		const receiptBytes = `${canonicalJson(receipt)}\n`;
		for (const leaf of [
			"authority.json",
			"authority-digest.bin",
			"campaign-lock.json",
			"manifest.json",
			"staged-capability.json",
			"mac-supervisor-ed25519.pub",
			"rig-supervisor-ed25519.pub",
		]) {
			writeFileSync(join(incoming, leaf), leaf);
		}
		writeFileSync(join(incoming, "stage-receipt.json"), receiptBytes);
		writeFileSync(join(incoming, STAGED_SERVER_TLS_CERTIFICATE_LEAF), cert);
		writeFileSync(
			join(incoming, STAGED_SERVER_TLS_PRIVATE_KEY_LEAF),
			readFileSync(tls.keyPath),
		);
		const rigRoot = join(root, "rig");
		// The account that runs the supervisor. On the rig that is
		// `_wtcompare` and the hand-off crosses a uid; here it is this
		// process's own account, so the hand-off is a mode change and the
		// read-back is the same assertion either way.
		const selfUser = userInfo().username;
		const argv = [
			"install-minted",
			`--root=${rigRoot}`,
			`--incoming=${incoming}`,
			`--expected-receipt-sha256=${sha256Text(receiptBytes)}`,
			`--supervisor-user=${selfUser}`,
		];
		expect(await runStageLiveCampaign(argv)).toBe(0);
		// One root (G3b): every leaf sits directly under `--root`, the directory
		// the rig bootstraps from; nothing is laid in a subdirectory.
		for (const leaf of RIG_STAGE_ROOT_LEAVES) {
			expect(statSync(join(rigRoot, leaf)).isFile()).toBe(true);
		}
		expect(readdirSync(rigRoot).sort()).toEqual(
			[...RIG_STAGE_ROOT_LEAVES].sort(),
		);
		expect(existsSync(join(rigRoot, "staging-root"))).toBe(false);
		expect(existsSync(join(rigRoot, "campaign-root"))).toBe(false);
		// The defect this pins: the key used to land 0600 owned by the
		// *staging* account, which runs install-minted over ssh, while the
		// supervisor that must `openat` it at every spawn runs as another
		// account and got EACCES -- the rig's `COHORT_NOT_READY: staged tls
		// leaf`, raised inside the spawner and indistinguishable by code from
		// a wrong stage. 0400 owned by the reader is the same owner-only rule
		// pointed at the right owner.
		const installedKey = join(rigRoot, STAGED_SERVER_TLS_PRIVATE_KEY_LEAF);
		expect(statSync(installedKey).mode & 0o777).toBe(0o400);
		expect(statSync(installedKey).uid).toBe(userIdOf(selfUser));
		expect(statSync(join(rigRoot, "campaign-lock.json")).mode & 0o777).toBe(
			0o644,
		);
		expect(
			readFileSync(join(rigRoot, STAGED_SERVER_TLS_CERTIFICATE_LEAF)),
		).toEqual(cert);

		// Re-runnable over the key it already handed away: the second install
		// unlinks the entry rather than trying to write through a file this
		// account no longer owns.
		expect(await runStageLiveCampaign(argv)).toBe(0);
		expect(statSync(installedKey).mode & 0o777).toBe(0o400);

		// An account this host does not have: the install refuses rather than
		// laying a key nobody can read.
		expect(
			await runStageLiveCampaign([
				"install-minted",
				`--root=${join(root, "rig-nobody")}`,
				`--incoming=${incoming}`,
				`--expected-receipt-sha256=${sha256Text(receiptBytes)}`,
				"--supervisor-user=wtb-no-such-account",
			]),
		).toBe(EXIT_STALE_OR_INVALID_STAGING);

		// Another certificate under the same receipt: refused, nothing trusted.
		const otherRoot = join(root, "rig-other");
		writeFileSync(
			join(incoming, STAGED_SERVER_TLS_CERTIFICATE_LEAF),
			`${cert.toString("utf8")}\n`,
		);
		expect(
			await runStageLiveCampaign([
				"install-minted",
				`--root=${otherRoot}`,
				`--incoming=${incoming}`,
				`--expected-receipt-sha256=${sha256Text(receiptBytes)}`,
				`--supervisor-user=${selfUser}`,
			]),
		).toBe(EXIT_STALE_OR_INVALID_STAGING);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("stage-live-campaign: the staged launch records are per profile and per mode", () => {
	// Lead rulings G4 and G3c on the amendment (design §3.1 "loopback instead
	// of 10.99.0.2"; C4 "Staging binds real launch argv"): the host is the
	// profile's, the record set is the profile's mode set, and the argv the
	// rig compares byte for byte carries the host and the profile.
	const digests = {
		serverEntrypointSha256: sha256Text("server.ts"),
		bunSha256: sha256Text("bun"),
		addonSha256: sha256Text("addon"),
		bindPort: 4433,
		tlsCertificateSha256: sha256Text("cert"),
		tlsPrivateKeySha256: sha256Text("key"),
	};

	it("phase-a stages only bulk-source; the other profiles stage both modes, and the leaf set follows", () => {
		expect(stagedServerLaunchModesForProfile("phase-a")).toEqual([
			"bulk-source",
		]);
		expect(stagedServerLaunchModesForProfile("phase-b")).toEqual([
			"bulk-source",
			"fanout-cohort",
		]);
		expect(stagedServerLaunchModesForProfile("local-acceptance")).toEqual([
			"bulk-source",
			"fanout-cohort",
		]);
		expect(macStagingRootFinalLeaves("phase-a")).toEqual([
			"staged-capability.json",
			"staged-server-launch-record.ws.bulk-source.json",
			"staged-server-launch-record.wt.bulk-source.json",
			STAGED_SERVER_TLS_CERTIFICATE_LEAF,
		]);
		expect(macStagingRootFinalLeaves("local-acceptance")).toEqual([
			"staged-capability.json",
			"staged-server-launch-record.ws.bulk-source.json",
			"staged-server-launch-record.ws.fanout-cohort.json",
			"staged-server-launch-record.wt.bulk-source.json",
			"staged-server-launch-record.wt.fanout-cohort.json",
			STAGED_SERVER_TLS_CERTIFICATE_LEAF,
		]);
		expect(stagedServerLaunchRecordLeaf("wt", "fanout-cohort")).toBe(
			"staged-server-launch-record.wt.fanout-cohort.json",
		);
	});

	it("every built record parses, binds its profile's host on both fields and inside the argv, and names its mode", () => {
		for (const profile of ["phase-a", "phase-b", "local-acceptance"] as const) {
			const host = profile === "local-acceptance" ? "127.0.0.1" : "10.99.0.2";
			for (const transport of ["ws", "wt"] as const) {
				for (const mode of stagedServerLaunchModesForProfile(profile)) {
					const record = buildStagedServerLaunchRecord({
						profile,
						transport,
						mode,
						...digests,
					});
					const parsed = parseStagedServerLaunchRecord(record);
					expect(parsed.ok).toBe(true);
					if (!parsed.ok) throw new Error(parsed.message);
					expect(stagedServerLaunchRecordProfile(parsed.value)).toBe(profile);
					expect(parsed.value.bindAddress).toBe(host);
					expect(parsed.value.advertisedHost).toBe(host);
					expect(parsed.value.argv).toEqual([
						"server.ts",
						`--transport=${transport}`,
						`--mode=${mode}`,
						`--stage-profile=${profile}`,
						`--bind=${host}`,
					]);
					// The argv is the server's own definition, so the child the
					// rig exec's parses exactly what was staged.
					const args = parseServerArgs(parsed.value.argv.slice(1));
					expect(args.bind).toBe(host);
					expect(args.mode).toBe(mode);
					expect(args.stageProfile).toBe(profile);
					expect(args.transport).toBe(transport);
				}
			}
		}
	});

	it("a physical record naming loopback and a local record naming the cable address are refused, on the record and on the argv", () => {
		const physical = buildStagedServerLaunchRecord({
			profile: "phase-b",
			transport: "ws",
			mode: "fanout-cohort",
			...digests,
		});
		const local = buildStagedServerLaunchRecord({
			profile: "local-acceptance",
			transport: "ws",
			mode: "fanout-cohort",
			...digests,
		});
		const refusal = (value: unknown): string => {
			const parsed = parseStagedServerLaunchRecord(value);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) throw new Error("unreachable");
			return parsed.message ?? parsed.code;
		};
		expect(
			refusal({
				...physical,
				bindAddress: "127.0.0.1",
				advertisedHost: "127.0.0.1",
			}),
		).toContain("phase-b profile's host");
		expect(
			refusal({
				...local,
				bindAddress: "10.99.0.2",
				advertisedHost: "10.99.0.2",
			}),
		).toContain("local-acceptance profile's host");
		expect(refusal({ ...physical, advertisedHost: "127.0.0.1" })).toContain(
			"advertisedHost does not equal bindAddress",
		);
		// The same substitutions inside the argv alone.
		expect(
			refusal({
				...physical,
				argv: (physical.argv as string[]).map((arg) =>
					arg === "--bind=10.99.0.2" ? "--bind=127.0.0.1" : arg,
				),
			}),
		).toContain("argv does not bind");
		// The profile is the argv's: a local record whose argv claims phase-b
		// is a phase-b record over loopback, refused on the host.
		expect(
			refusal({
				...local,
				argv: (local.argv as string[]).map((arg) =>
					arg === "--stage-profile=local-acceptance"
						? "--stage-profile=phase-b"
						: arg,
				),
			}),
		).toContain("phase-b profile's host");
		// A record whose argv names no profile, two profiles, or a non-profile
		// is not a record; the key set is the 14 keys both sides pin.
		const argvOf = (record: Record<string, unknown>) => record.argv as string[];
		expect(
			refusal({
				...physical,
				argv: argvOf(physical).filter(
					(arg) => !arg.startsWith("--stage-profile="),
				),
			}),
		).toContain("exactly one stage profile");
		expect(
			refusal({
				...physical,
				argv: [...argvOf(physical), "--stage-profile=phase-b"],
			}),
		).toContain("exactly one stage profile");
		expect(
			refusal({
				...physical,
				argv: argvOf(physical).map((arg) =>
					arg.startsWith("--stage-profile=") ? "--stage-profile=phase-c" : arg,
				),
			}),
		).toContain("exactly one stage profile");
		expect(refusal({ ...physical, stageProfile: "phase-b" })).toContain("keys");
		// The server child refuses the same two substitutions on its argv.
		expect(() =>
			parseServerArgs([
				"--transport=ws",
				"--mode=fanout-cohort",
				"--stage-profile=phase-b",
				"--bind=127.0.0.1",
			]),
		).toThrow("under the phase-b profile");
		expect(() =>
			parseServerArgs([
				"--transport=ws",
				"--mode=fanout-cohort",
				"--stage-profile=local-acceptance",
				"--bind=10.99.0.2",
			]),
		).toThrow("under the local-acceptance profile");
		expect(() =>
			parseServerArgs(["--transport=ws", "--bind=127.0.0.1"]),
		).toThrow("Refusing loopback bind address");
	});

	it("the minimal receipt binds the profile's host and exactly the profile's launch records", () => {
		const local = buildMinimalStageReceipt({
			profile: "local-acceptance",
			candidate: "cand",
			campaignId: "camp",
			macPublicKeySha256: sha256Text("mac"),
			rigPublicKeySha256: sha256Text("rig"),
			issuedAtMs: 1,
			notAfterMs: 2,
		});
		expect(local.cohortServerHost).toBe("127.0.0.1");
		expect(
			Object.keys(local.stagedServerLaunchRecordSha256ByLaunch.ws),
		).toEqual(["bulk-source", "fanout-cohort"]);
		const physical = buildMinimalStageReceipt({
			profile: "phase-a",
			candidate: "cand",
			campaignId: "camp",
			macPublicKeySha256: sha256Text("mac"),
			rigPublicKeySha256: sha256Text("rig"),
			issuedAtMs: 1,
			notAfterMs: 2,
		});
		expect(physical.cohortServerHost).toBe("10.99.0.2");
		expect(
			Object.keys(physical.stagedServerLaunchRecordSha256ByLaunch.wt),
		).toEqual(["bulk-source"]);
		expect(physical.rigRoleRootPath.startsWith("/")).toBe(true);
	});

	it("observe-linux binds the rig role root only when its server.ts is the staged leaf and its inputs are beside it", async () => {
		// G3a: the rig fchdir's into the role root before `bun run server.ts`
		// (`comparison-supervisor.rs` `fork_child`), so the root must be the
		// tree the entrypoint's relative imports resolve in, holding the very
		// bytes `roles/server.ts` was hashed from.
		const root = mkdtempSync(join(tmpdir(), "observe-linux-"));
		const stage = join(root, "stage");
		for (const dir of [
			"bin",
			"roles",
			"staging-root",
			"prebuilds",
			"tree/tools/compare/adapters",
		]) {
			mkdirSync(join(stage, dir), { recursive: true });
		}
		const observer = join(stage, "bin", "observe-directory-identity");
		writeFileSync(observer, "#!/bin/sh\nprintf '{\"fixture\":true}\n'\n", {
			mode: 0o755,
		});
		writeFileSync(join(stage, "bin", "comparison-supervisor"), "binary");
		writeFileSync(join(stage, "roles", "server.ts"), "// server\n");
		writeFileSync(join(stage, "roles", "stage-live-campaign.ts"), "// tool\n");
		writeFileSync(
			join(stage, "staging-root", "mac-supervisor-ed25519.pub"),
			"m",
		);
		writeFileSync(
			join(stage, "staging-root", "rig-supervisor-ed25519.pub"),
			"r",
		);
		writeFileSync(
			join(stage, "staging-root", "rig-signing-key-lease.armed.json"),
			"{}",
		);
		const bun = join(stage, "bin", "bun");
		writeFileSync(bun, "bun");
		const roleRoot = join(stage, "tree", "tools", "compare");
		writeFileSync(join(roleRoot, "server.ts"), "// server\n");
		const out = join(root, "observation.json");
		const argv = (role: string) => [
			"observe-linux",
			"--candidate=cand",
			"--campaign-id=camp",
			`--root=${stage}`,
			`--role-root=${role}`,
			`--observer=${observer}`,
			`--bun-path=${bun}`,
			`--out=${out}`,
		];
		expect(await runStageLiveCampaign(argv(roleRoot))).toBe(0);
		const observation = JSON.parse(readFileSync(out, "utf8")) as {
			readonly roleRootPath: string;
			readonly roleRootServerEntrypointSha256: string;
			readonly serverEntrypointSha256: string;
		};
		expect(observation.roleRootPath).toBe(roleRoot);
		expect(observation.roleRootServerEntrypointSha256).toBe(
			observation.serverEntrypointSha256,
		);
		// The bare leaf directory is not a role root: no inputs beside it.
		expect(await runStageLiveCampaign(argv(join(stage, "roles")))).toBe(
			EXIT_STALE_OR_INVALID_STAGING,
		);
		// A role root whose server.ts is not the staged bytes is refused.
		writeFileSync(join(roleRoot, "server.ts"), "// other\n");
		expect(await runStageLiveCampaign(argv(roleRoot))).toBe(
			EXIT_STALE_OR_INVALID_STAGING,
		);
		rmSync(root, { recursive: true, force: true });
	});

	// The rig role root used to ride the frozen command as
	// `COMPARISON_RIG_ROLE_ROOT`, which nothing ever read: the controller takes
	// it off the stage receipt (`compare-controller.ts`, `roleRoot: { path:
	// material.value.receipt.rigRoleRootPath }`). One source, and the export is
	// gone rather than left looking like a pin.
	it("binds the rig role root on the receipt the controller reads, and exports only the rig signing key", () => {
		const receipt = buildMinimalStageReceipt({
			profile: "phase-b",
			candidate: "cand",
			campaignId: "camp",
			macPublicKeySha256: sha256Text("mac"),
			rigPublicKeySha256: sha256Text("rig"),
			issuedAtMs: 1,
			notAfterMs: 2,
		});
		const command = buildFrozenRunCommand({
			section: "9.6",
			repo: "/repo",
			candidate: "cand",
			campaignId: "camp",
			executionPurpose: "pilot",
			stageReceipt: receipt,
			macTrust: "/mac/trust",
			macRuntime: "/mac/runtime",
			rig: "hermes-admin@10.99.0.2",
			rigStage: "/rig/stage",
			sshKey: "/ssh/key",
			macBun: "/mac/bun",
			out: "/out",
			runTimeoutMs: 1,
		});
		expect(receipt.rigRoleRootPath.length).toBeGreaterThan(0);
		expect(command).not.toContain("COMPARISON_RIG_ROLE_ROOT");
		expect(command).toContain(
			'export COMPARISON_RIG_SIGNING_KEY="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"',
		);
	});
});

/**
 * The frozen command's key-absence probes, driven for real.
 *
 * `cleanup_signing_keys` is the only thing standing between a finished run and
 * two live signing keys on disk, and its absence probes are what let it say so.
 * These run the generated function under recorded `sudo`/`ssh` stubs, so every
 * assertion is over the argv a real cleanup would have issued and the exit code
 * it would have returned.
 *
 * `/usr/bin/sudo` is absolute in the emitted bytes (a PATH-relative `sudo`
 * would be hijackable), which a shell function cannot intercept, so the harness
 * rewrites that one absolute path to the stub name in its own copy. The emitted
 * bytes are asserted separately, below.
 */
async function runCleanupSigningKeys(opts: {
	readonly macVerdict: string;
	readonly rigVerdict: string;
	readonly macDestroyRc?: number;
	readonly rigDestroyRc?: number;
}): Promise<{
	readonly rc: number;
	readonly stderr: string;
	readonly sudo: string[][];
	readonly ssh: string[][];
}> {
	const root = mkdtempSync(join(tmpdir(), "frozen-cleanup-"));
	const out = join(root, "out");
	mkdirSync(out, { recursive: true });
	mkdirSync(join(root, "trust"), { recursive: true });
	writeFileSync(join(out, "controller-terminal.json"), "{}\n");
	const sudoLog = join(root, "sudo.log");
	const sshLog = join(root, "ssh.log");
	const macBun = join(root, "mac-bun");
	writeFileSync(macBun, ["#!/bin/sh", "exit 0", ""].join("\n"), {
		mode: 0o755,
	});
	const receipt = buildMinimalStageReceipt({
		profile: "phase-a",
		candidate: "c".repeat(40),
		campaignId: "busyms-attested-focused-r1",
		macPublicKeySha256: "5".repeat(64) as Sha256Hex,
		rigPublicKeySha256: "6".repeat(64) as Sha256Hex,
		issuedAtMs: Date.now(),
		notAfterMs: Date.now() + 72 * 3600_000,
	});
	const command = buildFrozenRunCommand({
		section: "9.5",
		repo: process.cwd(),
		candidate: "c".repeat(40),
		campaignId: "busyms-attested-focused-r1",
		executionPurpose: "focused",
		stageReceipt: receipt,
		macTrust: join(root, "trust"),
		macRuntime: join(root, "runtime"),
		rig: "rig@example.invalid",
		rigStage: join(root, "rig-stage"),
		sshKey: join(root, "ssh-key"),
		macBun,
		out,
		runTimeoutMs: 1000,
	}).replaceAll("/usr/bin/sudo", "sudo");
	const record = (log: string) =>
		`{ for a in "$@"; do printf '%s\\036' "$a"; done; printf '\\035'; } >>"${log}"`;
	const script = [
		`test() { return 0; }`,
		"trap() { :; }",
		"sudo() {",
		`  ${record("$SUDO_LOG")}`,
		'  case "$*" in *campaign-key-absence*) printf %s "$MAC_VERDICT"; return 0 ;; esac',
		'  return "$MAC_DESTROY_RC"',
		"}",
		"ssh() {",
		`  ${record("$SSH_LOG")}`,
		'  case "$*" in *campaign-key-absence*) printf %s "$RIG_VERDICT"; return 0 ;; esac',
		'  return "$RIG_DESTROY_RC"',
		"}",
		command,
		// `cleanup_signing_keys` restores `set -e` before it returns, so its
		// nonzero return has to be taken in a condition or errexit ends the
		// script before the code can be reported.
		"if cleanup_signing_keys; then CLEANUP_RC=0; else CLEANUP_RC=$?; fi",
		'echo "CLEANUP_RC=$CLEANUP_RC"',
		"",
	].join("\n");
	const scriptPath = join(root, "cleanup.sh");
	writeFileSync(scriptPath, script);
	const proc = Bun.spawn(["/bin/bash", scriptPath], {
		cwd: process.cwd(),
		env: {
			...process.env,
			SUDO_LOG: sudoLog,
			SSH_LOG: sshLog,
			MAC_VERDICT: opts.macVerdict,
			RIG_VERDICT: opts.rigVerdict,
			MAC_DESTROY_RC: String(opts.macDestroyRc ?? 0),
			RIG_DESTROY_RC: String(opts.rigDestroyRc ?? 0),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	const rcLine = stdout
		.split("\n")
		.reverse()
		.find((line) => line.startsWith("CLEANUP_RC="));
	return {
		rc: rcLine === undefined ? -1 : Number(rcLine.slice("CLEANUP_RC=".length)),
		stderr,
		sudo: existsSync(sudoLog)
			? decodeInvocations(readFileSync(sudoLog, "utf8"))
			: [],
		ssh: existsSync(sshLog)
			? decodeInvocations(readFileSync(sshLog, "utf8"))
			: [],
	};
}

describe("frozen run command: campaign key absence is proved, not assumed", () => {
	const MAC_KEY =
		"/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8";
	const RIG_KEY =
		"/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8";

	function frozenText(): string {
		return buildFrozenRunCommand({
			section: "9.5",
			repo: "/repo",
			candidate: "c".repeat(40),
			campaignId: "busyms-attested-focused-r1",
			executionPurpose: "focused",
			stageReceipt: buildMinimalStageReceipt({
				profile: "phase-a",
				candidate: "c".repeat(40),
				campaignId: "busyms-attested-focused-r1",
				macPublicKeySha256: "5".repeat(64) as Sha256Hex,
				rigPublicKeySha256: "6".repeat(64) as Sha256Hex,
				issuedAtMs: 1,
				notAfterMs: 2,
			}),
			macTrust: "/mac/trust",
			macRuntime: "/mac/runtime",
			rig: "rig@example.invalid",
			rigStage: "/rig/stage",
			sshKey: "/ssh/key",
			macBun: "/mac/bun",
			out: "/out",
			runTimeoutMs: 1000,
		});
	}

	// The defect: the operator account cannot traverse the 0700 `_wtcompare`
	// key directory, so `test ! -e <key>` run as the operator answers "absent"
	// whether or not the key is there. Proved by contradiction on the rig: as
	// `hermes-admin` the probe said absent while `sudo -u _wtcompare test -e`
	// said present.
	it("never_probes_a_campaign_key_as_an_account_that_cannot_traverse_the_key_directory", () => {
		const text = frozenText();
		expect(text).not.toContain(`test ! -e "${MAC_KEY}"`);
		expect(text).not.toContain(`test ! -e "${RIG_KEY}"`);
		// The local probe keeps the absolute sudo path: a PATH-relative `sudo`
		// in a command that runs as the operator is a hijack away from a
		// constant.
		expect(text).toContain("/usr/bin/sudo -n -u _wtcompare /bin/sh -c");
	});

	it("runs_both_absence_probes_as_the_account_that_owns_the_key_directory", async () => {
		const run = await runCleanupSigningKeys({
			macVerdict: "ABSENT",
			rigVerdict: "ABSENT",
		});
		expect(run.rc).toBe(0);
		const macProbe = run.sudo.find((argv) =>
			argv.includes("campaign-key-absence"),
		);
		expect(macProbe).toBeDefined();
		expect(macProbe!.slice(0, 3)).toEqual(["-n", "-u", "_wtcompare"]);
		expect(macProbe!.some((arg) => arg.endsWith(".mac.pk8"))).toBe(true);
		const rigProbe = run.ssh.find((argv) =>
			argv.some((arg) => arg.includes("campaign-key-absence")),
		);
		expect(rigProbe).toBeDefined();
		const remote = rigProbe!.at(-1)!;
		expect(remote).toContain("sudo -n -u _wtcompare");
		expect(remote).toContain(".rig.pk8");
	});

	it("fails_cleanup_when_a_probe_cannot_prove_absence", async () => {
		const neither = await runCleanupSigningKeys({
			macVerdict: "",
			rigVerdict: "",
		});
		expect(neither.rc).toBe(70);
		expect(neither.stderr).toContain("CLEANUP_FAILED");
		const macOnly = await runCleanupSigningKeys({
			macVerdict: "",
			rigVerdict: "ABSENT",
		});
		expect(macOnly.rc).toBe(70);
		const rigOnly = await runCleanupSigningKeys({
			macVerdict: "ABSENT",
			rigVerdict: "",
		});
		expect(rigOnly.rc).toBe(70);
	});

	it("fails_cleanup_when_a_probe_finds_the_campaign_key_still_present", async () => {
		const mac = await runCleanupSigningKeys({
			macVerdict: "PRESENT",
			rigVerdict: "ABSENT",
		});
		expect(mac.rc).toBe(70);
		expect(mac.stderr).toContain("PRESENT");
		const rig = await runCleanupSigningKeys({
			macVerdict: "ABSENT",
			rigVerdict: "PRESENT",
		});
		expect(rig.rc).toBe(70);
	});

	it("only_two_proved_absences_and_two_clean_destroys_report_success", async () => {
		expect(
			(
				await runCleanupSigningKeys({
					macVerdict: "ABSENT",
					rigVerdict: "ABSENT",
				})
			).rc,
		).toBe(0);
		expect(
			(
				await runCleanupSigningKeys({
					macVerdict: "ABSENT",
					rigVerdict: "ABSENT",
					macDestroyRc: 1,
				})
			).rc,
		).toBe(70);
		expect(
			(
				await runCleanupSigningKeys({
					macVerdict: "ABSENT",
					rigVerdict: "ABSENT",
					rigDestroyRc: 1,
				})
			).rc,
		).toBe(70);
	});
});

/**
 * Every namespaced environment name production code reads, resolved from the
 * sources rather than restated here, so a new reader cannot slip past the two
 * rules below.
 */
function productionEnvNamesRead(): ReadonlySet<string> {
	const namespaced =
		/^(?:COMPARISON|WS_WT|WT_COMPARE|OBSERVE)_[A-Z0-9_]*[A-Z0-9]$/;
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
			item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)],
		);
	const typescript = walk(join(process.cwd(), "tools", "compare")).filter(
		(file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
	);
	const constants = new Map<string, string>();
	for (const file of typescript) {
		for (const match of readFileSync(file, "utf8").matchAll(
			/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*string\s*)?=\s*\n?\s*"([A-Z0-9_]+)"/g,
		)) {
			if (namespaced.test(match[2]!)) constants.set(match[1]!, match[2]!);
		}
	}
	const read = new Set<string>();
	const add = (name: string | undefined) => {
		if (name !== undefined && namespaced.test(name)) read.add(name);
	};
	for (const file of typescript) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g))
			add(m[1]);
		for (const m of text.matchAll(/process\.env\[([A-Za-z_][A-Za-z0-9_]*)\]/g))
			add(constants.get(m[1]!));
		// `server.ts` reads its TLS material off a narrowed `env` object.
		for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) add(m[1]);
	}
	// The Rust supervisors read (and set, for their children) the same names.
	for (const file of walk(join(process.cwd(), "crates")).filter((f) =>
		f.endsWith(".rs"),
	)) {
		for (const m of readFileSync(file, "utf8").matchAll(/"([A-Z0-9_]+)"/g))
			add(m[1]);
	}
	return read;
}

function frozenCommandForEnvAudit(): string {
	return buildFrozenRunCommand({
		section: "9.5",
		repo: "/repo",
		candidate: "c".repeat(40),
		campaignId: "busyms-attested-focused-r1",
		executionPurpose: "focused",
		stageReceipt: buildMinimalStageReceipt({
			profile: "phase-a",
			candidate: "c".repeat(40),
			campaignId: "busyms-attested-focused-r1",
			macPublicKeySha256: "5".repeat(64) as Sha256Hex,
			rigPublicKeySha256: "6".repeat(64) as Sha256Hex,
			issuedAtMs: 1,
			notAfterMs: 2,
		}),
		macTrust: "/mac/trust",
		macRuntime: "/mac/runtime",
		rig: "rig@example.invalid",
		rigStage: "/rig/stage",
		sshKey: "/ssh/key",
		macBun: "/mac/bun",
		out: "/out",
		runTimeoutMs: 1000,
	});
}

function exportedNames(command: string): string[] {
	return [...command.matchAll(/^export ([A-Z0-9_]+)=/gm)].map((m) => m[1]!);
}

describe("frozen run command: the environment it pins and the environment it clears", () => {
	// A variable the command exports that nothing reads is evidence-shaped and
	// proves nothing: `COMPARISON_SSH_IDENTITY` read as if the run's ssh
	// identity were pinned by the receipt, while the only identity any ssh
	// actually used came from a constant in the controller.
	it("exports_no_variable_that_no_production_code_reads", () => {
		const read = productionEnvNamesRead();
		const unread = exportedNames(frozenCommandForEnvAudit()).filter(
			(name) => !read.has(name),
		);
		expect(unread).toEqual([]);
	});

	// Not setting a variable is not the same as clearing it: the operator's
	// shell carries whatever it carries, and
	// `COMPARISON_MAC_SUPERVISOR_UID_SEAM=1` makes the controller skip all
	// twelve pre-traffic uid preconditions (compare-controller.ts, the
	// `MAC_SUPERVISOR_UID_SEAM_ENV` branch).
	it("clears_every_ambient_variable_production_reads_and_the_command_does_not_pin", () => {
		const command = frozenCommandForEnvAudit();
		const pinned = new Set(exportedNames(command));
		const mustClear = [...productionEnvNamesRead()]
			.filter((name) => !pinned.has(name))
			.sort();
		const cleared = [...command.matchAll(/^unset ([A-Z0-9_]+)$/gm)].map(
			(m) => m[1]!,
		);
		expect([...cleared].sort()).toEqual(mustClear);
		expect(mustClear).toContain("COMPARISON_MAC_SUPERVISOR_UID_SEAM");
	});

	it("clears_the_ambient_variables_before_it_pins_or_runs_anything", () => {
		const command = frozenCommandForEnvAudit();
		const lastUnset = command.lastIndexOf("\nunset ");
		const firstExport = command.indexOf("\nexport ");
		const firstTrap = command.indexOf("\ntrap ");
		expect(lastUnset).toBeGreaterThan(-1);
		expect(lastUnset).toBeLessThan(firstExport);
		expect(lastUnset).toBeLessThan(firstTrap);
	});

	// Proof by execution rather than by text: the controller the frozen command
	// launches must not see the seam variable, whatever the operator's shell
	// had in it.
	it("the_controller_never_sees_an_ambient_uid_seam_the_operator_shell_carried", async () => {
		const root = mkdtempSync(join(tmpdir(), "frozen-env-"));
		const out = join(root, "out");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "controller-terminal.json"), "{}\n");
		const envLog = join(root, "env.log");
		const macBun = join(root, "mac-bun");
		writeFileSync(
			macBun,
			[
				"#!/bin/sh",
				`printf '%s|%s\\n' "\${COMPARISON_MAC_SUPERVISOR_UID_SEAM-unset}" "\${WS_WT_TLS_CERT_CONTENT-unset}" >>"$ENV_LOG"`,
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const command = buildFrozenRunCommand({
			section: "9.5",
			repo: process.cwd(),
			candidate: "c".repeat(40),
			campaignId: "busyms-attested-focused-r1",
			executionPurpose: "focused",
			stageReceipt: buildMinimalStageReceipt({
				profile: "phase-a",
				candidate: "c".repeat(40),
				campaignId: "busyms-attested-focused-r1",
				macPublicKeySha256: "5".repeat(64) as Sha256Hex,
				rigPublicKeySha256: "6".repeat(64) as Sha256Hex,
				issuedAtMs: Date.now(),
				notAfterMs: Date.now() + 72 * 3600_000,
			}),
			macTrust: join(root, "trust"),
			macRuntime: join(root, "runtime"),
			rig: "rig@example.invalid",
			rigStage: join(root, "rig-stage"),
			sshKey: join(root, "ssh-key"),
			macBun,
			out,
			runTimeoutMs: 1000,
		});
		const scriptPath = join(root, "run.sh");
		writeFileSync(
			scriptPath,
			[
				"test() { return 0; }",
				"trap() { :; }",
				"sudo() { return 0; }",
				"ssh() { return 0; }",
				command,
				"",
			].join("\n"),
		);
		const proc = Bun.spawn(["/bin/bash", scriptPath], {
			cwd: process.cwd(),
			env: {
				...process.env,
				ENV_LOG: envLog,
				COMPARISON_MAC_SUPERVISOR_UID_SEAM: "1",
				WS_WT_TLS_CERT_CONTENT: "-----BEGIN CERTIFICATE-----",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const seen = readFileSync(envLog, "utf8").trim().split("\n");
		expect(seen.length).toBeGreaterThan(0);
		for (const line of seen) expect(line).toBe("unset|unset");
	});

	it("refuses_to_freeze_a_candidate_or_campaign_id_it_cannot_embed", () => {
		const receipt = buildMinimalStageReceipt({
			profile: "phase-a",
			candidate: "c".repeat(40),
			campaignId: "busyms-attested-focused-r1",
			macPublicKeySha256: "5".repeat(64) as Sha256Hex,
			rigPublicKeySha256: "6".repeat(64) as Sha256Hex,
			issuedAtMs: 1,
			notAfterMs: 2,
		});
		const build = (candidate: string, campaignId: string) =>
			buildFrozenRunCommand({
				section: "9.5",
				repo: "/repo",
				candidate,
				campaignId,
				executionPurpose: "focused",
				stageReceipt: receipt,
				macTrust: "/mac/trust",
				macRuntime: "/mac/runtime",
				rig: "rig@example.invalid",
				rigStage: "/rig/stage",
				sshKey: "/ssh/key",
				macBun: "/mac/bun",
				out: "/out",
				runTimeoutMs: 1000,
			});
		// The rig absence probe embeds both inside a single-quoted remote
		// command, so a quote in either would end the quoting and run the rest.
		expect(() =>
			build("c'; rm -rf /; '", "busyms-attested-focused-r1"),
		).toThrow();
		expect(() => build("c".repeat(40), "camp'aign")).toThrow();
		expect(() =>
			build("c".repeat(40), "busyms-attested-focused-r1"),
		).not.toThrow();
	});
});
