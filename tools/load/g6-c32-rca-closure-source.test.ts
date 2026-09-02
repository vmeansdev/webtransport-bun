import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const registration = readFileSync(
	join(
		import.meta.dir,
		"../../.scratch/bare-metal-campaign/registrations/g6-c32-rca-closure-01.md",
	),
	"utf8",
);
const controller = readFileSync(
	join(import.meta.dir, "g6-c32-rca-controller.sh"),
	"utf8",
);

describe("g6 c32 RCA closure source contract", () => {
	test("keeps every registered terminal claim distinct", () => {
		for (const state of [
			"FUNCTIONAL_PASS",
			"RIG_CLEAN_PASS",
			"SESSION_SCALE_PASS",
			"RCA_QUALITY_PASS",
			"RCA_CONFIRMED",
			"RCA_INTERACTION",
			"RCA_UNRESOLVED",
			"INCOMPLETE",
		]) {
			expect(registration).toContain(`\`${state}\``);
		}
		expect(registration).toContain(
			"No capacity-maximum, release, promotion, permanent configuration change, or",
		);
		expect(controller).toContain(
			"RCA_CONFIRMED|RCA_INTERACTION|RCA_UNRESOLVED",
		);
		expect(controller).not.toContain("printf 'COMPLETE");
	}, 15_000);

	test("makes the checked-in controller the only executable campaign authority", () => {
		expect(controller).toContain("set -euo pipefail");
		expect(controller).toContain('g6-c32-freeze.ts" verify');
		expect(controller).toContain("qualification_exact_pair");
		expect(controller).toContain("write_dispatch_authorization");
		expect(controller).not.toContain("APPROVED_RUNBOOK_SHA");
		expect(controller).not.toContain("G6_FREEZE_GUARD");
		expect(controller).not.toContain("APPROVED_FOR_SERIALIZED_DISPATCH");
		expect(controller).not.toContain(".md");
		expect(controller).not.toContain("```");
		expect(controller).not.toContain("__FREEZE_REQUIRED_");
	}, 15_000);

	test("probe non-interference preserves the hard wall-time maximum", () => {
		const evaluate = readFileSync(
			join(import.meta.dir, "g6-c32-rca-evaluate.ts"),
			"utf8",
		);
		const scan = readFileSync(
			join(import.meta.dir, "g6-sharded-scan.ts"),
			"utf8",
		);
		expect(scan.indexOf("await startLinuxProbe(shards)")).toBeLessThan(
			scan.indexOf("currentRung?.begin();"),
		);
		expect(evaluate).not.toContain("Math.max(maxShiftPct, offOffShiftPct)");
		expect(evaluate).toContain("const allowedShiftPct = maxShiftPct");
		expect(evaluate).toContain("g6-c32-probe-non-interference/3");
		expect(registration).toContain("The hard maximum wall shift is 5%");
		expect(registration).toContain(
			"Off-off drift is diagnostic only and never raises that maximum",
		);
		expect(controller).toContain("--max-connect-wall-shift-pct 5");
		expect(controller).toContain("P1-off,P1-on,P2-off,P2-on");
	}, 15_000);

	test("binds the serialized A/B/C/D matrix and deterministic interaction", () => {
		expect(registration).toContain(
			"`A1 -> B1 -> C1 -> D1 -> A2 -> B2 -> C2 -> D2 -> A3 -> B3 -> C3 -> D3 -> A4`",
		);
		expect(registration).toContain("`E1 -> A5 -> E2 -> A6 -> E3 -> A7`");
		expect(registration).toContain("tie order `B > C > D`");
		expect(registration).toContain("512 fixed-port endpoints");
		expect(registration).toContain(
			"exact 25 MiB effective server receive buffer",
		);
		expect(controller).toContain("A1 B1 C1 D1 A2 B2 C2 D2 A3 B3 C3 D3 A4");
		expect(controller).toContain("E1 A5 E2 A6 E3 A7");
		expect(controller).toContain("--tie-order B,C,D");
		expect(controller).toContain("SCAN_CONNECT_CONCURRENCY");
		expect(controller).toContain("SCAN_CONNECT_RATE_PER_SEC");
		expect(controller).toContain("SCAN_FIXED_SOURCE_PORT_BASE");
		expect(controller).toContain("SCAN_POST_RUN_STEERING_OUT");
	}, 15_000);

	test("retains transfer, successor ladder, companion, and rollback discipline", () => {
		expect(registration).toContain(
			"A valid overflowing baseline remains eligible for causal comparison",
		);
		expect(registration).toContain(
			"A296 -> W296 -> A296 -> W296 -> A296 -> W296 -> A296-reversal",
		);
		expect(registration).toContain("HIGH_LOAD_FACTOR_CONFIRMED");
		expect(registration).toContain("5k, 10k, 20k,");
		expect(registration).toContain("30k/40k/50k");
		expect(registration).toContain("matched-throughput companion");
		expect(registration).toContain("`>=0.995`");
		expect(registration).toContain("byte-for-byte");
		expect(controller).toContain(
			"A296-1 W296-1 A296-2 W296-2 A296-3 W296-3 A296-reversal",
		);
		for (const rung of [5000, 10000, 20000, 30000, 40000, 50000]) {
			expect(controller).toContain(`run_ladder_rung ${rung}`);
		}
		expect(controller).toContain('run_ladder_cell "$replicate"');
		expect(controller).toContain("--mode ladder");
		expect(controller).toContain("--mode companion");
		expect(controller).toContain("SCAN_WORKLOAD_ACTIVE_SESSIONS");
		expect(controller).toContain("restore_server_settings");
		expect(controller).toContain("while read -r key value; do");
		expect(controller).toContain("26214400");
		expect(controller).toContain('cmp "$SYSCTL_SNAPSHOT"');
	}, 15_000);

	test("verifies generated exact identities before remote work and lock", () => {
		const verifyAt = controller.indexOf('g6-c32-freeze.ts" verify');
		const importerAt = controller.indexOf("REQUIRED_VERIFIED_KEYS=");
		const remoteAt = controller.indexOf("SSH_BIN=ssh");
		const lockAt = controller.indexOf("exec 9>>/tmp/bench.lock");
		const qualifyAt = controller.indexOf("qualification_exact_pair");
		expect(verifyAt).toBeGreaterThan(-1);
		expect(verifyAt).toBeLessThan(importerAt);
		expect(importerAt).toBeLessThan(remoteAt);
		expect(remoteAt).toBeLessThan(lockAt);
		expect(lockAt).toBeLessThan(qualifyAt);
		expect(controller).toContain("G6_C32_SERVER_ID");
		expect(controller).toContain("G6_C32_GENERATOR_ID");
		expect(controller).toContain("G6_C32_SERVER_BOOT_ID");
		expect(controller).toContain("G6_C32_GENERATOR_BOOT_ID");
		expect(controller).toContain("G6_C32_SERVER_BINARY_SHA256");
		expect(controller).toContain("G6_C32_GENERATOR_BINARY_SHA256");
	}, 15_000);

	test("holds one append-mode lock across qualification and every rated cell", () => {
		expect(controller).toContain("exec 9>>/tmp/bench.lock");
		expect(controller).toContain("flock -w 30 9");
		expect(controller).toContain("/tmp/bench.lock.owner");
		expect(controller).toContain('"recordedAt"');
		expect(controller).not.toContain("exec 9>/tmp/bench.lock");
		expect(controller.indexOf("acquire_continuous_lock")).toBeLessThan(
			controller.indexOf("qualification_exact_pair"),
		);
		expect(controller.indexOf("write_dispatch_authorization")).toBeLessThan(
			controller.indexOf("run_cell P1-off"),
		);
		expect(controller.indexOf("run_cell P1-off")).toBeLessThan(
			controller.indexOf("for cell in A1"),
		);
	}, 15_000);

	test("persists budget admission before any rated cell or remote work", () => {
		const runCell = controller.slice(
			controller.indexOf("run_cell_once()"),
			controller.indexOf("read_winner_field()"),
		);
		const admissionAt = runCell.indexOf("admit_budget_cell");
		expect(admissionAt).toBeGreaterThan(-1);
		for (const boundary of [
			'rated-cells.log"',
			'"$cell-remote-mkdir"',
			'"$cell-apply-buffer"',
			'"$cell-bpf-repin"',
			'"$cell-scan"',
		]) {
			expect(admissionAt).toBeLessThan(runCell.indexOf(boundary));
		}
		expect(controller).toContain("g6-c32-budget-cli.ts");
		expect(controller).toContain("admit-cell");
		expect(controller).toContain("REFUSED_BUDGET");
	}, 15_000);

	test("gates ladder and companion execution on the post-fix lifecycle", () => {
		const invokedCampaign = controller.slice(
			controller.lastIndexOf('if [ "$BUDGET_LIFECYCLE" = ladder-only ]; then'),
		);
		expect(invokedCampaign).toContain("run_probe_and_matrix\n  run_transfer");
		expect(invokedCampaign).toContain(
			'if [ "$BUDGET_LIFECYCLE" = post-fix-only ] && [ "$TRANSFER_CONFIRMED" = 1 ]; then\n    run_ladder_and_companion\n  fi',
		);
		expect(invokedCampaign).toContain("verify_ladder_profile");
		const invocations = invokedCampaign
			.split("\n")
			.filter((line) => line.trim() === "run_ladder_and_companion");
		expect(invocations).toHaveLength(2);
		expect(controller).toContain('--lifecycle "$BUDGET_LIFECYCLE"');
		expect(controller).not.toContain(
			"post-fix-only has no frozen mechanism-specific executor",
		);
	}, 15_000);

	test("captures timestamps and detached stdin for operations and cleanup", () => {
		expect(controller).toContain("g6-c32-operation-receipt/1");
		expect(controller).toContain("startedAt");
		expect(controller).toContain("finishedAt");
		expect(controller).toContain("durationMonotonicNs");
		expect(controller).toContain("recordedAt");
		expect(controller).toContain("ssh -n");
		expect(controller).toContain('command "$SSH_BIN" -n');
		for (const line of controller.split("\n")) {
			if (/g6_ssh .*&\s*$/.test(line)) expect(line).toContain("</dev/null");
		}
		expect(controller).toContain("trap cleanup_campaign EXIT INT TERM HUP");
		expect(controller).toContain("stop_qualification_listeners");
	}, 15_000);

	test("lets only the finalizer select a terminal status before cleanup releases the lock", () => {
		expect(controller).toContain("--status-out");
		expect(controller).toContain("RUN_STATUS.next");
		expect(controller).toContain("trap - EXIT INT TERM HUP");
		expect(controller).toContain("cleanup_campaign");
		expect(controller).toContain("SHA256SUMS");
		expect(controller.indexOf("printf '%s\\n' \"$final_status\"")).toBeLessThan(
			controller.indexOf(
				"cleanup_campaign",
				controller.indexOf("finalize_campaign"),
			),
		);
		expect(controller).toContain("final-seal.receipt.json");
		expect(controller).toContain("artifact-manifest.json");
	}, 15_000);

	test("takes the shard count from the verified environment, never a literal", () => {
		const countOf = (needle: string): number =>
			controller.split(needle).length - 1;
		expect(controller).toContain("G6_C32_SHARDS");
		expect(controller).toContain("SCAN_SHARDS=$G6_C32_SHARDS");
		expect(countOf('g6-shard-bpf-setup.sh "$G6_C32_SHARDS"')).toBe(2);
		expect(countOf('--expected-shards "$G6_C32_SHARDS"')).toBe(3);
		expect(controller).toContain("qualification_bpf_shards");
		expect(controller).not.toContain("SCAN_SHARDS=16");
		expect(controller).not.toContain("bpf-setup.sh 16");
		expect(controller).not.toContain("qualification_bpf_16");
		expect(controller).not.toContain("bpf-16");
	}, 15_000);

	test("grades only the separately captured post-run steering artifact", () => {
		expect(controller).toContain(
			"SCAN_POST_RUN_STEERING_OUT=$remote_dir/post-run-steering.json",
		);
		expect(controller).toContain(
			'--post-run-steering "$local_dir/post-run-steering.json"',
		);
		expect(controller).not.toMatch(/--post-run-steering[^\n]*T2/);
		expect(controller).not.toContain("post-steer.json");
	}, 15_000);
});
