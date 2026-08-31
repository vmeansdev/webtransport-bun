import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sha256Hex } from "../cross-supervisor-protocol.ts";
import {
	assertKnownSubcommand,
	buildLiveMintRecords,
	buildMinimalStageReceipt,
	cleanupSigningKeysIdempotent,
	EXIT_STALE_OR_INVALID_STAGING,
	EXIT_USAGE,
	INTERNAL_SUBCOMMANDS,
	LIVE_AUTHORITY_APPROVAL_FIELDS,
	LIVE_AUTHORITY_FIELDS,
	LIVE_CAPABILITY_FIELDS,
	LIVE_LOCK_FIELDS,
	mintLocalSigningKeys,
	PUBLIC_SUBCOMMANDS,
	prestageRoot,
	REFUSED_STALE_OR_INVALID_STAGING,
	remainingLifetimeMarginMs,
	runStageLiveCampaign,
	TRUST_FIXTURE_ONLY_MINT_FORBIDDEN,
} from "./stage-live-campaign.ts";

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
	});

	it("verify_stage_approval_rejects_command_approval_aliases", async () => {
		const code = await runStageLiveCampaign([
			"verify-stage-approval",
			"--command=/tmp/x",
			"--approval=/tmp/y",
		]);
		expect(code).toBe(EXIT_USAGE);
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
