import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const controllerPath = join(import.meta.dir, "g6-c32-rca-controller.sh");
const scanPath = join(import.meta.dir, "g6-sharded-scan.ts");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function source(): string {
	return readFileSync(controllerPath, "utf8");
}

function scanSource(): string {
	return readFileSync(scanPath, "utf8");
}

function writeExecutable(path: string, contents: string): void {
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
}

function fixtureEnvironment(root: string): string {
	const bound = join(root, "bound");
	const evidence = join(root, "evidence");
	const knownHosts = join(bound, "host", "known_hosts");
	const bundle = join(bound, "candidate", "candidate.bundle");
	mkdirSync(join(bound, "host"), { recursive: true });
	mkdirSync(join(bound, "candidate"), { recursive: true });
	writeFileSync(
		knownHosts,
		"192.0.2.11 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureGeneratorHostKey\n",
	);
	writeFileSync(bundle, "fixture bundle\n");
	const values: Record<string, string> = {
		G6_C32_BOUND_ROOT: bound,
		G6_C32_BUDGET_POLICY_PATH: join(root, "budget-policy.json"),
		G6_C32_BUDGET_POLICY_SHA256: "9".repeat(64),
		G6_C32_CANDIDATE_BUNDLE_PATH: bundle,
		G6_C32_CANDIDATE_COMMIT: "1".repeat(40),
		G6_C32_CANDIDATE_TREE: "2".repeat(40),
		G6_C32_CONTROLLER_PATH: controllerPath,
		G6_C32_DISPATCH_FREEZE_SHA256: "3".repeat(64),
		G6_C32_EVIDENCE_ROOT: evidence,
		G6_C32_GENERATOR_BINARY_PATH:
			"/opt/g6/run/source/target/release/mmo-client",
		G6_C32_GENERATOR_BINARY_SHA256: "4".repeat(64),
		G6_C32_GENERATOR_BOOT_ID: "22222222-2222-4222-8222-222222222222",
		G6_C32_GENERATOR_ID: "102",
		G6_C32_GENERATOR_NAME: "g6-generator-fixture",
		G6_C32_GENERATOR_PRIVATE_IPV4: "10.0.0.11",
		G6_C32_GENERATOR_PUBLIC_IPV4: "192.0.2.11",
		G6_C32_HOST_BINDING_AUTHORITY_SHA256: "5".repeat(64),
		G6_C32_KNOWN_HOSTS_PATH: knownHosts,
		G6_C32_OFFRUNNER_BUN: "bun",
		G6_C32_REGISTRATION_PATH: join(bound, "views", "registration.md"),
		G6_C32_REGISTRATION_SHA256: "6".repeat(64),
		G6_C32_REMOTE_ROOT: "/root/webtransport-bun/.scratch/g6/fixture",
		G6_C32_REPOSITORY_PATH: import.meta.dir.replace(/\/tools\/load$/, ""),
		G6_C32_RUN_ID: "g6-c32-controller-fixture",
		G6_C32_SEMANTIC_FREEZE_AUTHORITY_SHA256: "7".repeat(64),
		G6_C32_SERVER_BINARY_PATH:
			"/opt/g6/run/source/crates/native/webtransport-native.linux-x64-gnu.node",
		G6_C32_SERVER_BINARY_SHA256: "8".repeat(64),
		G6_C32_SERVER_BOOT_ID: "11111111-1111-4111-8111-111111111111",
		G6_C32_SERVER_ID: "101",
		G6_C32_SERVER_NAME: "g6-server-fixture",
		G6_C32_SERVER_PRIVATE_IPV4: "10.0.0.10",
		G6_C32_SERVER_PUBLIC_IPV4: "192.0.2.10",
		G6_C32_SPEND_LEDGER_PATH: join(root, "spend-ledger.json"),
		G6_C32_VPC_UUID: "vpc-fixture",
	};
	return `${Object.keys(values)
		.sort()
		.map((key) => `${key}='${values[key]}'`)
		.join("\n")}\n`;
}

function runWithFakes(
	mode: "verify-fail" | "malformed" | "qualification-fail" | "post-fix",
): {
	root: string;
	result: ReturnType<typeof spawnSync>;
	sshLog: string;
	lockLog: string;
	ratedLog: string;
	cleanupLog: string;
} {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-controller-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const environment = fixtureEnvironment(root);
	const sshLog = join(root, "ssh.log");
	const lockLog = join(root, "lock.log");
	const ratedLog = join(root, "rated.log");
	const cleanupLog = join(root, "cleanup.log");
	const sshIdentity = join(root, "ssh-identity");
	writeFileSync(sshIdentity, "fixture private identity\n", { mode: 0o600 });
	writeFileSync(`${sshIdentity}.pub`, "ssh-ed25519 fixture-public-key\n", {
		mode: 0o600,
	});
	const marker = join(root, "malformed-executed");
	writeExecutable(
		join(bin, "bun"),
		`#!/bin/bash
set -eu
case " $* " in
  *"g6-c32-freeze.ts verify "*)
    case ${mode} in
      verify-fail) exit 19 ;;
      malformed) printf '%s\\n' 'G6_C32_RUN_ID=$(touch ${marker})'; exit 0 ;;
      qualification-fail|post-fix) cat '${join(root, "verified.env")}' ;;
    esac
    ;;
  *) exec '${process.execPath}' "$@" ;;
esac
`,
	);
	writeFileSync(join(root, "verified.env"), environment);
	writeFileSync(
		join(root, "budget-policy.json"),
		`${JSON.stringify({
			schema: "g6-c32-budget-policy/1",
			campaignId: "g6-c32-controller-fixture",
			runId: "g6-c32-controller-fixture",
			currency: "USD",
			lifecycle: mode === "post-fix" ? "post-fix-only" : "rca-only",
			totalBudgetMicrousd: 10_000_000,
			spentBeforeMicrousd: mode === "post-fix" ? 4_552_100 : 0,
			maximumRoleHourlyMicrousd: { server: 1_300_600, generator: 1_300_600 },
			maximumLifecycleSeconds: mode === "post-fix" ? 4_500 : 5_700,
			teardownReserveSeconds: 600,
			maximumLifecycleCostMicrousd: mode === "post-fix" ? 3_685_034 : 4_552_100,
			cellMaximumSeconds: {
				probe: 180,
				matrix: 180,
				interaction: 180,
				transfer: 180,
			},
			allowedStages: ["probe", "matrix", "interaction", "transfer"],
			priorLedger:
				mode === "post-fix"
					? {
							path: "prior-spend-ledger.json",
							sha256: "a".repeat(64),
							sealedSpentMicrousd: 4_552_100,
						}
					: null,
		})}\n`,
	);
	writeExecutable(
		join(bin, "ssh"),
		`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> '${sshLog}'
case "$*" in
  *'/tmp/bench.lock'*)
    printf '%s\\n' lock >> '${lockLog}'
    printf 'LOCKED\\n'
    trap 'exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  *'cleanup'*) printf '%s\\n' cleanup >> '${cleanupLog}' ;;
esac
exit 0
`,
	);
	writeExecutable(
		join(bin, "doctl"),
		`#!/bin/bash
printf '%s\\n' doctl-called
exit 23
`,
	);
	writeExecutable(join(bin, "scp"), "#!/bin/bash\nexit 0\n");
	writeExecutable(
		join(bin, "flock"),
		`#!/bin/bash
printf '%s\\n' "$*" >> '${lockLog}'
exec "$@"
`,
	);
	const result = spawnSync(
		"bash",
		[
			controllerPath,
			"run",
			"--bound-root",
			join(root, "bound"),
			"--repository",
			import.meta.dir.replace(/\/tools\/load$/, ""),
			"--budget-policy",
			join(root, "budget-policy.json"),
			"--spend-ledger",
			join(root, "spend-ledger.json"),
		],
		{
			encoding: "utf8",
			env: {
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				G6_C32_SSH_IDENTITY_PATH: sshIdentity,
				G6_C32_TEST_RATED_LOG: ratedLog,
				G6_C32_TEST_CLEANUP_LOG: cleanupLog,
			},
			timeout: 15_000,
		},
	);
	return {
		root,
		result,
		sshLog: existsSync(sshLog) ? readFileSync(sshLog, "utf8") : "",
		lockLog: existsSync(lockLog) ? readFileSync(lockLog, "utf8") : "",
		ratedLog: existsSync(ratedLog) ? readFileSync(ratedLog, "utf8") : "",
		cleanupLog: existsSync(cleanupLog) ? readFileSync(cleanupLog, "utf8") : "",
	};
}

describe("G6 c32 checked-in locked controller", () => {
	test("is Bash-valid, parameterized, verifier-first, and never executes Markdown", () => {
		const script = source();
		const syntax = spawnSync("bash", ["-n", controllerPath], {
			encoding: "utf8",
		});
		expect(syntax.status).toBe(0);
		expect(script).toContain("set -euo pipefail");
		expect(script.indexOf('g6-c32-freeze.ts" verify')).toBeGreaterThan(-1);
		expect(script.indexOf('g6-c32-freeze.ts" verify')).toBeLessThan(
			script.indexOf("SSH_BIN"),
		);
		expect(script).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
		expect(script).not.toMatch(/\b[0-9a-f]{40,64}\b/);
		expect(script).not.toContain("APPROVED_FOR_SERIALIZED_DISPATCH");
		expect(script).not.toContain("G6_FREEZE_GUARD");
		expect(script).not.toContain(".md");
		expect(script).not.toContain("```");
		expect(script).not.toContain(
			"/Users/vmeansdev/.local/share/mise/installs/node/23.9.0/bin/node",
		);
		expect(script).toContain("exec 9>>/tmp/bench.lock");
		expect(script).toContain("flock -w 30 9");
		expect(script).toContain('"recordedAt"');
		expect(script).toContain("ssh -n");
		expect(script).toContain("g6_ssh_retry_transport()");
		expect(script).toContain('[ "$status" -eq 255 ] || return "$status"');
		expect(script).toContain("isolated-sink QUALIFYING g6_ssh_retry_transport");
		expect(script).toContain('-i "$G6_C32_SSH_PUBLIC_IDENTITY_PATH"');
		expect(script).not.toContain('-i "$G6_C32_SSH_IDENTITY_PATH"');
		expect(script).toContain("IdentitiesOnly=yes");
		expect(script).toContain(
			String.raw`printf '%s' \"\$(/root/.cargo/bin/rustc --version)\" | base64 -w0`,
		);
		expect(script).toContain(
			String.raw`printf '%s' \"\$(/root/.cargo/bin/cargo --version)\" | base64 -w0`,
		);
		expect(script).not.toContain("'g6-sharded-scan|mmo-client|iperf3'");
		expect(script).toContain("'[g]6-sharded-scan|[m]mo-client|[i]perf3'");
		expect(script).not.toContain('"$DOCTL_BIN" compute vpc get');
		expect(script).toContain('"$DOCTL_BIN" vpcs get');
		expect(script).toContain('cd "$G6_C32_REPOSITORY_PATH"');
		expect(script).not.toContain("cwd: process.cwd()");
		expect(script.includes("cwd:root")).toBe(false);
		expect(script).toContain('cwd: "."');
		expect(script).toContain("start_captured_operation()");
		expect(script).toContain("finish_captured_operation()");
		expect(
			script.includes(
				'capture_operation "$root/loaded-down" loaded-down QUALIFYING',
			),
		).toBe(false);
		expect(
			script.includes(
				'capture_operation "$root/loaded-up" loaded-up QUALIFYING',
			),
		).toBe(false);
		expect(script).toContain("install_nested_generator_host_key()");
		expect(script).toContain("nested-generator-known_hosts");
		expect(script).toContain('g6_ssh -A root@"$G6_C32_SERVER_PUBLIC_IPV4"');
		expect(script).toContain("G6_C32_SSH_PUBLIC_IDENTITY_PATH");
		expect(script).toContain("g6_forwarded_identity.pub");
		expect(script).not.toContain("nested-generator-identity");
		expect(script).not.toContain("ssh-keygen");
		expect(script).not.toContain(
			'g6_scp "$G6_C32_SSH_IDENTITY_PATH" root@"$G6_C32_SERVER_PUBLIC_IPV4":/root/.ssh/id_ed25519',
		);
		const scan = scanSource();
		expect(scan).toContain("...OFFBOX_SSH_OPTIONS, OFFBOX_SSH, ...remoteArgs");
		expect(scan).toContain("...OFFBOX_SSH_OPTIONS,");
		expect(scan).toContain("IdentitiesOnly=yes");
		expect(scan).toContain("StrictHostKeyChecking=yes");
		expect(scan).toContain("UserKnownHostsFile=/root/.ssh/known_hosts");
		expect(scan).toContain("/root/.ssh/g6_forwarded_identity.pub");
	});

	test("retains registered qualification, matrix, transfer, ladder, and terminal ordering", () => {
		const script = source();
		const authorization = script.indexOf("write_dispatch_authorization");
		const firstRated = script.indexOf("run_cell P1-off");
		expect(script.indexOf("qualification_exact_pair")).toBeLessThan(
			authorization,
		);
		expect(script.indexOf("qualification_clock_resources")).toBeLessThan(
			authorization,
		);
		expect(script.indexOf("qualification_private_vpc")).toBeLessThan(
			authorization,
		);
		expect(script.indexOf("qualification_isolated_sink")).toBeLessThan(
			authorization,
		);
		expect(script.indexOf("qualification_loaded_legs")).toBeLessThan(
			authorization,
		);
		expect(script.indexOf("qualification_bpf_16")).toBeLessThan(authorization);
		expect(script.indexOf("qualification_rollback_25mib")).toBeLessThan(
			authorization,
		);
		expect(authorization).toBeLessThan(firstRated);
		expect(script).toContain("A1 B1 C1 D1 A2 B2 C2 D2 A3 B3 C3 D3 A4");
		expect(script).toContain("E1 A5 E2 A6 E3 A7");
		expect(script).toContain(
			"A296-1 W296-1 A296-2 W296-2 A296-3 W296-3 A296-reversal",
		);
		expect(script).toContain(
			"run_cell P1-off 296 128 50 250 0 1 historical probe",
		);
		expect(script).toContain(
			"run_cell P2-off 296 128 50 250 0 1 historical probe",
		);
		expect(script).not.toContain(
			"run_cell P1-off 296 128 500 0 0 0 historical probe",
		);
		for (const rung of [5000, 10000, 20000, 30000, 40000, 50000]) {
			expect(script).toContain(`run_ladder_rung ${rung}`);
		}
		for (const state of [
			"RCA_CONFIRMED",
			"RCA_INTERACTION",
			"RCA_UNRESOLVED",
		]) {
			expect(script).toContain(state);
		}
		const invoked = (name: string) => script.lastIndexOf(`\n${name}\n`);
		expect(invoked("apply_campaign_nofile")).toBeLessThan(
			invoked("qualification_exact_pair"),
		);
		expect(invoked("qualification_isolated_sink")).toBeLessThan(
			invoked("qualification_private_vpc"),
		);
		expect(invoked("qualification_rollback_25mib")).toBeLessThan(
			invoked("copy_and_validate_qualification"),
		);
		expect(script).toContain("artifact-manifest.json");
		expect(script).toContain(
			'phase:"FINAL",operationId:"offrunner-artifact-manifest"',
		);
		expect(script).toContain("final-seal.receipt.json");
	});

	test("initializes the transfer winner label before deriving its evidence root", () => {
		const script = source();
		expect(script).toContain(
			'local label=$1\n  local root="$G6_C32_EVIDENCE_ROOT/transfer/$label"',
		);
		expect(script).not.toContain(
			'local label=$1 root="$G6_C32_EVIDENCE_ROOT/transfer/$label"',
		);
	});

	test("retries one incomplete evaluator cell without retrying other failures", () => {
		const script = source();
		const wrapper = script.slice(
			script.indexOf("run_cell() {"),
			script.indexOf("read_winner_field()"),
		);
		expect(wrapper).toContain('run_cell_once "$@"');
		expect(wrapper).toContain('if [ "$status" -eq 75 ]; then');
		expect(wrapper).toContain('run_cell_once "$@"');
		expect(wrapper).toContain('return "$status"');
		const cell = script.slice(
			script.indexOf("run_cell_once() {"),
			script.indexOf("run_cell() {"),
		);
		expect(cell).toContain('if [ "$evaluate_status" -eq 2 ]; then');
		expect(cell).toContain("return 75");
		expect(cell).toContain(
			'if [ "$evaluate_restore_errexit" -eq 1 ]; then set -e; fi',
		);
		expect(cell).not.toContain(
			'local evaluate_status=$?\n  set -e\n  if [ "$evaluate_status" -eq 2 ]; then',
		);
		expect(cell).toContain(
			'[ "$evaluate_status" -eq 0 ] || return "$evaluate_status"',
		);
		expect(wrapper).toContain(
			'local retry_archive="$G6_C32_EVIDENCE_ROOT/$9/.attempts/$1-attempt-1"',
		);
		expect(wrapper).toContain('mv "$first_attempt" "$retry_archive"');
	});

	test("a verifier failure performs no SSH and takes no lock", () => {
		const run = runWithFakes("verify-fail");
		expect(run.result.status).not.toBe(0);
		expect(run.sshLog).toBe("");
		expect(run.lockLog).toBe("");
	});

	test("rejects malformed verifier output without evaluating it", () => {
		const run = runWithFakes("malformed");
		expect(run.result.status).not.toBe(0);
		expect(existsSync(join(run.root, "malformed-executed"))).toBeFalse();
		expect(run.sshLog).toBe("");
		expect(run.lockLog).toBe("");
	});

	test("fails closed before remote work for an unfrozen post-fix executor", () => {
		const run = runWithFakes("post-fix");
		expect(run.result.status).toBe(67);
		expect(run.result.stderr).toContain(
			"post-fix-only has no frozen mechanism-specific executor",
		);
		expect(run.sshLog).toBe("");
		expect(run.lockLog).toBe("");
	});

	test("qualification failure remains INCOMPLETE, cleans up, and starts no rated cell", () => {
		const run = runWithFakes("qualification-fail");
		expect(run.result.status).not.toBe(0);
		if (!run.lockLog.includes("lock")) {
			throw new Error(
				`controller stopped before lock: status=${String(run.result.status)} stdout=${String(run.result.stdout)} stderr=${String(run.result.stderr)}`,
			);
		}
		expect(run.lockLog).toContain("lock");
		expect(readFileSync(join(run.root, "evidence", "RUN_STATUS"), "utf8")).toBe(
			"INCOMPLETE\n",
		);
		expect(run.ratedLog).toBe("");
		expect(run.cleanupLog).toContain("cleanup");
		const receipt = JSON.parse(
			readFileSync(
				join(
					run.root,
					"evidence",
					"qualification",
					"doctl-server.receipt.json",
				),
				"utf8",
			),
		);
		expect(receipt.envelope.recordedAt).toMatch(/\.\d{3}Z$/);
		expect(receipt.startedAt).toMatch(/\.\d{3}Z$/);
		expect(receipt.finishedAt).toMatch(/\.\d{3}Z$/);
		expect(receipt.status).toEqual({
			outcome: "FAILED",
			exitCode: 23,
			signal: null,
		});
	});
});
