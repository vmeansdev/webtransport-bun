import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sha256Hex } from "../cross-supervisor-protocol.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical.ts";
import {
	assertKnownSubcommand,
	buildLiveMintRecords,
	buildMinimalStageReceipt,
	cleanupSigningKeysIdempotent,
	directoryIdentitySameRoot,
	ensureFinalRootLeafPlaceholders,
	EXIT_STALE_OR_INVALID_STAGING,
	EXIT_USAGE,
	INTERNAL_SUBCOMMANDS,
	LIVE_AUTHORITY_APPROVAL_FIELDS,
	LIVE_AUTHORITY_FIELDS,
	LIVE_CAPABILITY_FIELDS,
	LIVE_LOCK_FIELDS,
	MAC_CAMPAIGN_ROOT_FINAL_LEAVES,
	MAC_STAGING_ROOT_FINAL_LEAVES,
	mintLocalSigningKeys,
	parseExactStageReviewBindings,
	PUBLIC_SUBCOMMANDS,
	prestageRoot,
	REFUSED_STALE_OR_INVALID_STAGING,
	remainingLifetimeMarginMs,
	runStageLiveCampaign,
	TRUST_FIXTURE_ONLY_MINT_FORBIDDEN,
	verifyExactStageApproval,
	type ExactStageApprovalV1,
	type LiveStageReceiptV1,
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
		ensureFinalRootLeafPlaceholders({ campaignRoot, stagingRoot });
		for (const leaf of MAC_CAMPAIGN_ROOT_FINAL_LEAVES) {
			expect(existsSync(join(campaignRoot, leaf))).toBe(true);
		}
		for (const leaf of MAC_STAGING_ROOT_FINAL_LEAVES) {
			expect(existsSync(join(stagingRoot, leaf))).toBe(true);
		}
		expect(existsSync(join(stagingRoot, "mac-supervisor-ed25519.pub"))).toBe(
			true,
		);
		ensureFinalRootLeafPlaceholders({ campaignRoot, stagingRoot });
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
