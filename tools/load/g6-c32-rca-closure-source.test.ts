import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

	test("probe non-interference enforces the hard wall-time maximum and reports off-off drift", () => {
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
		expect(registration).toContain("This registration does not authorize");
		expect(registration).toContain("lock, load, or recreate.");
		expect(runbook).toContain("--max-connect-wall-shift-pct 5");
		expect(runbook).toContain("hard maximum");
		expect(runbook).toContain(
			"Off-off drift is reported but never raises that maximum",
		);
	});

	test("treats the unavailable generator binary as historical until a fresh freeze", () => {
		expect(registration).toContain(
			"Last-known destroyed-host generator binary SHA-256",
		);
		expect(registration).toContain("not locally recomputable");
		expect(runbook).toContain("HISTORICAL_GENERATOR_BINARY_SHA");
		expect(runbook).toContain("APPROVED_GENERATOR_BINARY_SHA");
		expect(runbook).not.toContain("\nGENERATOR_BINARY_SHA=");
		expect(runbook).toContain(
			"set from a fresh host-identity freeze and exact approval receipt",
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
		expect(runbook).toContain(
			'2>"$OFFRUNNER_ROOT/preflight/bench-lock.stderr" </dev/null &',
		);
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
			"SSH_KNOWN_HOSTS=/Users/vmeansdev/Developer/Codex/wt-g6-sharded-diagnostic-01/.scratch/bare-metal-campaign/provisioning/",
		);
		expect(runbook).toContain(`command ssh "\${SSH_OPTIONS[@]}" "$@"`);
		expect(runbook).toContain(`command scp "\${SSH_OPTIONS[@]}" "$@"`);
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
			expect(runbook).toContain(`run_winner ${leg}`);
			expect(runbook).not.toContain(
				`capture_cmd_status "$OFFRUNNER_ROOT/transfer/${leg}/run-winner"`,
			);
		}
		expect(runbook).toContain("winner_field profile.endpoints");
		expect(runbook).toContain('--expect-candidate "$CANDIDATE"');
	});

	test("keeps restore and capture helpers stdin-safe and locally scoped", () => {
		const restoreStart = runbook.indexOf("restore_d_sysctls() {");
		const restoreEnd = runbook.indexOf("apply_campaign_nofile() {");
		const restoreFn = runbook.slice(restoreStart, restoreEnd);
		expect(restoreStart).toBeGreaterThan(-1);
		expect(restoreFn).toContain("while read -r key value; do");
		expect(restoreFn).toMatch(/sysctl -w \\"\$key=\$value\\"/);
		expect(restoreFn).toContain("</dev/null");
		expect(restoreFn).toMatch(/local label=/);
		expect(restoreFn).toMatch(/local status=/);

		const captureStart = runbook.indexOf("capture_cmd_status() {");
		const captureFn = runbook.slice(
			captureStart,
			runbook.indexOf("snapshot_d_sysctls() {"),
		);
		expect(captureFn).toMatch(/local label=/);
		expect(captureFn).toMatch(/local status/);
		expect(captureFn).toContain("case $-");
		expect(captureFn).toContain("restore_errexit");
		expect(captureFn).toContain('return "$status"');
		expect(runbook).toContain(
			'test "$(cat "$OFFRUNNER_ROOT/closeout/verify-nofile-server-absent.status")" = 0',
		);
		expect(runbook).toContain(
			'test "$(cat "$OFFRUNNER_ROOT/closeout/verify-nofile-generator-absent.status")" = 0',
		);
		expect(runbook).toContain("stop_preflight_listeners");

		expect(runbook.indexOf("trap cleanup_campaign EXIT")).toBeGreaterThan(-1);
		expect(runbook.indexOf("trap cleanup_campaign EXIT")).toBeLessThan(
			runbook.indexOf("\napply_campaign_nofile\n"),
		);
		expect(runbook).toContain("verify-nofile-server-absent");
		expect(runbook).toContain(
			"test ! -e /etc/security/limits.d/99-g6-rca-nofile.conf",
		);
		expect(runbook).not.toContain(
			"rm -f /etc/security/limits.d/99-g6-rca-nofile.conf' || true",
		);
		expect(runbook).toContain("local cell=");
		expect(runbook).toContain('local label="$1"');
		expect(runbook).toContain("for companion_label in C1 C2");
		expect(runbook).not.toContain("for label in C1 C2");
	});

	test("capture_cmd_status restores caller errexit and restore walks every sysctl line", () => {
		const captureFn = runbook.slice(
			runbook.indexOf("capture_cmd_status() {"),
			runbook.indexOf("snapshot_d_sysctls() {"),
		);
		const restoreFn = runbook.slice(
			runbook.indexOf("restore_d_sysctls() {"),
			runbook.indexOf("apply_campaign_nofile() {"),
		);
		const work = mkdtempSync(join(tmpdir(), "g6-c32-runbook-"));
		try {
			const plusE = join(work, "plus-e.sh");
			writeFileSync(
				plusE,
				`#!/bin/bash
set -euo pipefail
${captureFn}
set +e
capture_cmd_status "${work}/producer" false
producer_status=$?
capture_cmd_status "${work}/listener-stop" true
stop_status=$?
set -e
test "$producer_status" -ne 0
test "$stop_status" -eq 0
`,
			);
			const plus = spawnSync("bash", [plusE], { encoding: "utf8" });
			expect(plus.status).toBe(0);
			expect(readFileSync(join(work, "listener-stop.status"), "utf8")).toBe(
				"0\n",
			);

			const minusE = join(work, "minus-e.sh");
			writeFileSync(
				minusE,
				`#!/bin/bash
set -euo pipefail
${captureFn}
capture_cmd_status "${work}/fail" false
printf 'REACHED\\n' > "${work}/after"
`,
			);
			const minus = spawnSync("bash", [minusE], { encoding: "utf8" });
			expect(minus.status).not.toBe(0);
			expect(spawnSync("test", ["!", "-e", join(work, "after")]).status).toBe(
				0,
			);

			const restoreScript = join(work, "restore.sh");
			writeFileSync(
				restoreScript,
				`#!/bin/bash
set -euo pipefail
SERVER_PUBLIC=10.110.0.3
OFFRUNNER_ROOT="${work}"
mkdir -p "$OFFRUNNER_ROOT/preflight" "$OFFRUNNER_ROOT/closeout"
printf '%s\\n' 'net.core.rmem_max 212992' 'net.core.rmem_default 212992' 'net.ipv4.udp_rmem_min 4096' > "$OFFRUNNER_ROOT/preflight/d-sysctls.before"
ssh() {
  printf '%s\\n' "$*" >> "${work}/ssh-args"
  cat >> "${work}/ssh-stdin"
}
${restoreFn}
restore_d_sysctls "$OFFRUNNER_ROOT/closeout"
test "$(wc -l < "${work}/ssh-args" | tr -d ' ')" = 3
test ! -s "${work}/ssh-stdin"
`,
			);
			const restored = spawnSync("bash", [restoreScript], { encoding: "utf8" });
			expect(restored.status).toBe(0);
			expect(restored.stderr).toBe("");
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
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
