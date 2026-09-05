import { describe, expect, it } from "bun:test";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	STAGED_SERVER_TLS_CERTIFICATE_LEAF,
	STAGED_SERVER_TLS_PRIVATE_KEY_LEAF,
} from "../cohort-protocol.ts";
import type { Sha256Hex } from "../cross-supervisor-protocol.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical.ts";
import {
	assertKnownSubcommand,
	buildFrozenRunCommand,
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
	mintStagedServerTlsIdentity,
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
			// The integrity attempt proves bytes only; it must not claim to have
			// opened a signature graph it is not allowed to conclude anything from.
			const integrity = verifyIndexInvocations(run.bun)[1]!;
			expect(integrity.some((arg) => arg.startsWith("--mac-public-key="))).toBe(
				false,
			);
			expect(integrity.some((arg) => arg.startsWith("--rig-public-key="))).toBe(
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
	// install-minted puts both leaves into the rig's staging root with the key
	// readable by nobody else.
	it("mints one self-signed leaf for the frozen server name and the rig address", () => {
		const root = mkdtempSync(join(tmpdir(), "stage-tls-"));
		const tls = mintStagedServerTlsIdentity({
			outDir: join(root, "tls"),
			validDays: 1,
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
		expect(text).toContain("CA:FALSE");
		expect(text).toContain("TLS Web Server Authentication");
		// One identity per campaign root: a second mint over it is refused, so a
		// stage cannot silently rotate the certificate a receipt already binds.
		expect(() =>
			mintStagedServerTlsIdentity({ outDir: join(root, "tls"), validDays: 1 }),
		).toThrow("TRUST_TLS_IDENTITY_EXISTS");
		rmSync(root, { recursive: true, force: true });
	});

	it("the certificate is a final leaf of the Mac staging root", () => {
		expect(MAC_STAGING_ROOT_FINAL_LEAVES).toContain(
			STAGED_SERVER_TLS_CERTIFICATE_LEAF,
		);
		const root = mkdtempSync(join(tmpdir(), "stage-tls-leaves-"));
		ensureFinalRootLeafPlaceholders({
			campaignRoot: join(root, "campaign-root"),
			stagingRoot: join(root, "staging-root"),
		});
		expect(
			existsSync(
				join(root, "staging-root", STAGED_SERVER_TLS_CERTIFICATE_LEAF),
			),
		).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	it("install-minted installs both leaves with the key at 0600 and refuses a certificate the receipt does not bind", async () => {
		const root = mkdtempSync(join(tmpdir(), "stage-tls-install-"));
		const incoming = join(root, "incoming");
		mkdirSync(incoming, { recursive: true });
		const tls = mintStagedServerTlsIdentity({
			outDir: join(root, "tls"),
			validDays: 1,
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
		const argv = [
			"install-minted",
			`--root=${rigRoot}`,
			`--incoming=${incoming}`,
			`--expected-receipt-sha256=${sha256Text(receiptBytes)}`,
		];
		expect(await runStageLiveCampaign(argv)).toBe(0);
		const installedKey = join(
			rigRoot,
			"staging-root",
			STAGED_SERVER_TLS_PRIVATE_KEY_LEAF,
		);
		expect(statSync(installedKey).mode & 0o777).toBe(0o600);
		expect(
			readFileSync(
				join(rigRoot, "staging-root", STAGED_SERVER_TLS_CERTIFICATE_LEAF),
			),
		).toEqual(cert);

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
			]),
		).toBe(EXIT_STALE_OR_INVALID_STAGING);
		rmSync(root, { recursive: true, force: true });
	});
});
