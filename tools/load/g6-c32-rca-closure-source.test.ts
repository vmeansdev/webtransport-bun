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
const runbook = readFileSync(
	join(
		import.meta.dir,
		"../../.scratch/bare-metal-campaign/runbooks/g6-c32-rca-closure-01.md",
	),
	"utf8",
);

describe("g6 c32 RCA closure source contract", () => {
	test("separates successor states and binds dispatch to external exact-digest approval", () => {
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
		expect(registration).not.toContain("__FREEZE_REQUIRED_");
		expect(runbook).not.toContain("__FREEZE_REQUIRED_");
		expect(registration).toContain(
			"The registration intentionally does not embed its own SHA-256",
		);
		expect(runbook).toContain("APPROVED_RUNBOOK_SHA");
		expect(runbook).toContain("G6_FREEZE_GUARD");
		expect(runbook).toContain('test "$(sha256sum "$REGISTRATION_PATH"');
		expect(runbook).toContain('test "$(sha256sum "$RUNBOOK_PATH"');
		expect(registration).toContain(
			"No capacity-maximum, release, promotion, permanent configuration change, or",
		);
		expect(runbook).toMatch(
			/it does\s+not authorize a product fix, release, promotion,/,
		);
		expect(runbook).toMatch(
			/permanent configuration\s+change, or droplet deletion\./,
		);
	});

	test("binds the serialized A/B/C/D matrix and deterministic E interaction", () => {
		expect(registration).toContain(
			"`A1 -> B1 -> C1 -> D1 -> A2 -> B2 -> C2 -> D2 -> A3 -> B3 -> C3 -> D3 -> A4`",
		);
		expect(registration).toContain("`E1 -> A5 -> E2 -> A6 -> E3 -> A7`");
		expect(registration).toContain("tie order `B > C > D`");
		expect(registration).toContain("512 fixed-port endpoints");
		expect(registration).toContain(
			"exact 25 MiB effective server receive buffer",
		);
		expect(runbook).toContain("SCAN_CONNECT_CONCURRENCY");
		expect(runbook).toContain("SCAN_CONNECT_RATE_PER_SEC");
		expect(runbook).toContain("SCAN_FIXED_SOURCE_PORT_BASE");
		expect(runbook).toContain("SCAN_POST_RUN_STEERING_OUT");
		expect(runbook).toContain("tools/load/g6-c32-rca-evaluate.ts");
		expect(runbook).toContain("tools/load/g6-c32-successor-grade.ts");
		expect(runbook).toContain("tools/load/g6-linux-probe.ts");
		expect(runbook).toContain('if [ "$run_interaction" = 1 ]; then');
		expect(runbook).not.toContain("if(!d.runInteraction) process.exit(20)");
		expect(runbook).toContain("capture_cmd_status");
		expect(runbook).toContain("exec 9>>/tmp/bench.lock");
		expect(runbook).not.toContain("exec 9>/tmp/bench.lock");
	});

	test("requires transfer, successor ladder, matched-throughput proof, and rollback discipline", () => {
		expect(registration).toContain(
			"A valid overflowing baseline remains eligible for causal comparison",
		);
		expect(registration).not.toContain(
			"satisfy `FUNCTIONAL_PASS`, `RIG_CLEAN_PASS`, and",
		);
		expect(registration).toContain(
			"A296 -> W296 -> A296 -> W296 -> A296 -> W296 -> A296-reversal",
		);
		expect(runbook).toContain("A296/W296/A296/W296/A296/W296/A296-reversal");
		expect(registration).toContain("HIGH_LOAD_FACTOR_CONFIRMED");
		expect(registration).toContain("5k, 10k, 20k,");
		expect(registration).toContain("30k/40k/50k");
		expect(registration).toContain("matched-throughput companion");
		expect(registration).toContain("`>=0.995`");
		expect(registration).toContain("byte-for-byte");
		for (const rung of [5000, 10000, 20000, 30000, 40000, 50000])
			expect(runbook).toContain(`run_ladder_rung ${rung}`);
		expect(runbook).toContain(
			`highest_replicate="L\${LADDER_HIGHEST_CLEAN}-2"`,
		);
		expect(runbook).toContain('run_ladder_cell "$highest_replicate"');
		expect(runbook).toContain("--mode ladder");
		expect(runbook).toContain("transfer_status=$?");
		expect(runbook).toContain(
			'status === 3 && transfer.terminal === "RCA_UNRESOLVED"',
		);
		expect(runbook).toContain('if [ "$transfer_state" = CONFIRMED ]; then');
		expect(runbook).not.toContain("transfer.transferPass !== true");
		expect(runbook).toContain("--mode companion");
		expect(runbook).toContain("SCAN_WORKLOAD_ACTIVE_SESSIONS");
		expect(runbook).toContain("SESSION_SCALE_PASS");
		expect(runbook).toContain("restore_d_sysctls");
		expect(runbook).toContain("while read -r key value; do");
		expect(runbook).toContain('sysctl -w \\"$key=$value\\"');
		expect(runbook).toContain("trap 'restore_d_sysctls");
		expect(runbook).toContain("SHA256SUMS");
		expect(runbook).toContain("RUN_STATUS");
	});

	test("keeps the runbook non-dispatchable until external approvals and exact identity pass", () => {
		expect(runbook).toContain("freeze_refusal()");
		expect(runbook).toContain("APPROVED_FOR_SERIALIZED_DISPATCH");
		expect(runbook).toContain("set -euo pipefail");
		expect(runbook).toContain("set +e");
		expect(runbook).toContain('return "$status"');
		expect(runbook).toContain("SERVER_BUN=/opt/g6/bin/bun");
		expect(runbook).toContain("SERVER_CLONE=/root/webtransport-bun");
		expect(runbook).toContain(
			"REMOTE_ROOT=/root/webtransport-bun/.scratch/bare-metal-campaign/runs/$RUN_ID",
		);
		expect(runbook).toContain(
			"OFFRUNNER_ROOT=/Users/vmeansdev/Developer/Codex/wt-g6-sharded-diagnostic-01/.scratch/bare-metal-campaign/artifacts/",
		);
		expect(runbook).not.toContain("/private/tmp");
		expect(runbook).not.toContain("/var/tmp");
		const generatorMkdir = runbook.indexOf(
			'mkdir -p "$OFFRUNNER_ROOT/preflight/generator"',
		);
		const generatorCopy = runbook.indexOf(
			'scp -r root@"$GENERATOR_PUBLIC":"$REMOTE_ROOT/preflight/."',
		);
		expect(generatorMkdir).toBeGreaterThan(-1);
		expect(generatorCopy).toBeGreaterThan(generatorMkdir);
		expect(runbook).toContain('ssh -A root@"$SERVER_PUBLIC" env');
		expect(runbook).toContain(
			'scp -r root@"$SERVER_PUBLIC":"$remote_dir/." "$local_dir/"',
		);
		expect(runbook).toContain("--mode probe-non-interference");
		expect(runbook).toContain("--identity");
		expect(runbook).toContain("g6-c32-frozen-preflight/1");
		expect(runbook).toContain("P1-off P1-on P2-off P2-on");
		expect(runbook).toContain('doctl compute droplet get "$SERVER_DROPLET_ID"');
		expect(runbook).toContain(
			'doctl compute droplet get "$GENERATOR_DROPLET_ID"',
		);
		expect(runbook).not.toContain(
			'doctl compute droplet get "$SERVER_DROPLET_ID" "$GENERATOR_DROPLET_ID"',
		);
		expect(runbook).toContain(
			"No parallel load, build, or test activity is allowed",
		);
	});

	test("preserves the historical artifacts as immutable context rather than rewriting them", () => {
		expect(registration).toContain(
			".scratch/bare-metal-campaign/registrations/g6-c32-clean-capacity-01.md",
		);
		expect(registration).toContain(
			".scratch/bare-metal-campaign/runbooks/g6-c32-clean-capacity-01.md",
		);
		expect(registration).not.toContain(
			"highest tested clean rung, 1k resolution",
		);
	});

	test("lets only the verified finalizer select a registered terminal status", () => {
		expect(runbook).not.toContain("printf 'COMPLETE");
		expect(runbook).toContain(
			'--status-out "$OFFRUNNER_ROOT/closeout/RUN_STATUS.next"',
		);
		expect(runbook).toContain(
			'final_status=$(cat "$OFFRUNNER_ROOT/closeout/RUN_STATUS.next")',
		);
		for (const state of [
			"RCA_CONFIRMED",
			"RCA_INTERACTION",
			"RCA_UNRESOLVED",
		]) {
			expect(runbook).toContain(state);
		}
		expect(runbook).toContain("ladder/decision.json");
		expect(runbook).toContain("companion/decision.json");
		expect(runbook).toContain("if (value.transfer?.transferPass === true)");
		expect(runbook).toContain("fullRateWorksAbove5k");
		expect(runbook).toContain("sessionScalePass");
		expect(runbook).toContain("printf '%s\\n' \"$final_status\"");
	});

	test("captures receipts for every mandatory transfer winner leg", () => {
		for (const leg of ["W296-1", "W296-2", "W296-3"]) {
			expect(runbook).toContain(
				`capture_cmd_status "$OFFRUNNER_ROOT/transfer/${leg}/run-winner"`,
			);
			expect(runbook).toContain(`run_winner ${leg}`);
		}
		expect(runbook).toContain("winner_field profile.endpoints");
		expect(runbook).toContain('--expect-candidate "$CANDIDATE"');
	});

	test("grades only the separately captured post-run steering artifact", () => {
		expect(runbook).toContain(
			'SCAN_POST_RUN_STEERING_OUT="$remote_dir/post-run-steering.json"',
		);
		expect(runbook).toContain(
			'--post-run-steering "$local_dir/post-run-steering.json"',
		);
		expect(runbook).not.toMatch(/--post-run-steering[^\n]*T2/);
		expect(runbook).not.toContain("post-steer.json");
	});
});
