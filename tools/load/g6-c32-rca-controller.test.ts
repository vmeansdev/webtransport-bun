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

import { validateArtifactManifestRecord } from "./g6-c32-freeze-model.ts";

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

function extractFunction(script: string, name: string): string {
	const start = script.indexOf(`${name}() {`);
	expect(start).toBeGreaterThan(-1);
	const end = script.indexOf("\n}", start);
	expect(end).toBeGreaterThan(start);
	return script.slice(start, end + 2);
}

function writeExecutable(path: string, contents: string): void {
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
}

function writeLadderProfile(
	root: string,
	serverUdpSendBufferBytes: number,
): void {
	mkdirSync(join(root, "tools", "load"), { recursive: true });
	writeFileSync(
		join(root, "tools", "load", "g6-c32-ladder-profile.json"),
		`${JSON.stringify({
			schema: "g6-c32-ladder-profile/1",
			profile: {
				endpoints: 128,
				connectConcurrency: 50,
				connectRatePerSec: 250,
				receiveBufferBytes: 26_214_400,
				gradeMode: "historical",
				ackReflector: "native",
				serverWorkers: 2,
				serverGro: "off",
				serverRecvRuntime: "dedicated",
				ackCadence: "default",
				pacerPps: 0,
				udpSendBatch: 64,
				serverUdpSendBufferBytes,
			},
		})}\n`,
	);
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
		G6_C32_SHARDS: "16",
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
			cellMaximumSeconds:
				mode === "post-fix"
					? {
							probe: 180,
							matrix: 180,
							interaction: 180,
							transfer: 180,
							ladder: 480,
							companion: 480,
						}
					: {
							probe: 180,
							matrix: 180,
							interaction: 180,
							transfer: 180,
						},
			allowedStages:
				mode === "post-fix"
					? [
							"probe",
							"matrix",
							"interaction",
							"transfer",
							"ladder",
							"companion",
						]
					: ["probe", "matrix", "interaction", "transfer"],
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
	}, 15_000);

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
		expect(script.indexOf("qualification_bpf_shards")).toBeLessThan(
			authorization,
		);
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
		// The 25 MiB receive buffer is an instrument setting on BOTH hosts: the
		// generator's sockets overflowed at 30k in r75/r80 while the server was
		// clean, so every apply/restore/proof on the server has a generator twin.
		const rollback = extractFunction(script, "qualification_rollback_25mib");
		expect(rollback).toContain('root@"$G6_C32_GENERATOR_PUBLIC_IPV4"');
		expect(rollback).toContain("rollback-proof-generator");
		expect(rollback).toContain("snapshot-compare-generator");
		expect(rollback).toContain("restore_generator_settings");
		expect(rollback).toContain('"g6-c32-rollback-generator/1"');
		// The ack reflector mode is a registered profile field: the scan runs
		// under it and every grader is told which one to expect, so a native
		// profile can never be graded against a JS-reflected run.
		expect(script).toContain(
			'for (const key of ["endpoints","connectConcurrency","connectRatePerSec","receiveBufferBytes","gradeMode","ackReflector","serverWorkers","serverGro","serverRecvRuntime","ackCadence","pacerPps","udpSendBatch","serverUdpSendBufferBytes"])',
		);
		expect(script).toContain(
			"ack_reflector=$(read_winner_field profile.ackReflector",
		);
		expect(script).toContain("SCAN_ACK_REFLECTOR=$ack_reflector");
		expect(script).toContain('--expected-ack-reflector "$ack_reflector"');
		// The worker count travels the same three paths as the reflector mode:
		// read from the frozen profile, dispatched to the scan, and asserted
		// again by both graders off the scan the run produced.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pins a literal bash default, not a JS template
		expect(script).toContain("local server_workers=${13:-2}");
		expect(script).toContain("SCAN_SERVER_WORKERS=$server_workers");
		expect(
			script.split('--expected-server-workers "$server_workers"').length - 1,
		).toBe(2);
		expect(
			script.split("read_winner_field profile.serverWorkers").length - 1,
		).toBe(3);
		// GRO travels the same three paths, and is additionally a value gate:
		// the profile may only name a state ethtool can be held to.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pins a literal bash default, not a JS template
		expect(script).toContain("local server_gro=${14:-on}");
		expect(script).toContain("SCAN_SERVER_GRO=$server_gro");
		expect(script).toContain(
			'if(profile.serverGro!=="on" && profile.serverGro!=="off") process.exit(74);',
		);
		expect(script.split('--expected-server-gro "$server_gro"').length - 1).toBe(
			2,
		);
		expect(script.split("read_winner_field profile.serverGro").length - 1).toBe(
			3,
		);
		// The recv-runtime knob travels the same three paths as the worker
		// count and GRO: read from the frozen profile, dispatched to the scan,
		// and asserted again by both graders off the scan the run produced.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pins a literal bash default, not a JS template
		expect(script).toContain("local server_recv_runtime=${15:-shared}");
		expect(script).toContain("SCAN_SERVER_RECV_RUNTIME=$server_recv_runtime");
		expect(
			script.split('--expected-server-recv-runtime "$server_recv_runtime"')
				.length - 1,
		).toBe(2);
		expect(
			script.split("read_winner_field profile.serverRecvRuntime").length - 1,
		).toBe(3);
		expect(script).toContain(
			'if(profile.serverRecvRuntime!=="shared" && profile.serverRecvRuntime!=="dedicated") process.exit(74);',
		);
		// The ack-cadence knob travels the same three paths as the recv-runtime
		// knob: read from the frozen profile, dispatched to the scan, and
		// asserted again by both graders off the scan the run produced.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pins a literal bash default, not a JS template
		expect(script).toContain("local ack_cadence=${16:-default}");
		expect(script).toContain("SCAN_ACK_CADENCE=$ack_cadence");
		expect(
			script.split('--expected-ack-cadence "$ack_cadence"').length - 1,
		).toBe(2);
		expect(
			script.split("read_winner_field profile.ackCadence").length - 1,
		).toBe(3);
		expect(script).toContain(
			'if(profile.ackCadence!=="default" && profile.ackCadence!=="relaxed") process.exit(74);',
		);
		// The egress pacer is a registered profile field (pacerPps, 0 = the
		// unpaced native mirror): the cell runs the paced emitter under it and
		// both graders assert the scan's recorded pacing against it.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pins a literal bash default, not a JS template
		expect(script).toContain("local pacer_pps=${17:-0}");
		expect(script).toContain(
			'if [ "$pacer_pps" -gt 0 ]; then emitter_mode=paced-mirror; pacer_env="G6_PACED_EMITTER=1 WEBTRANSPORT_PACER_PPS=$pacer_pps"; fi',
		);
		expect(script).toContain("G6_EMITTER_MODE=$emitter_mode $pacer_env");
		expect(script).not.toContain("G6_EMITTER_MODE=native-mirror ");
		expect(script.split('--expected-pacer-pps "$pacer_pps"').length - 1).toBe(
			2,
		);
		expect(script.split("read_winner_field profile.pacerPps").length - 1).toBe(
			3,
		);
		expect(script).toContain(
			"if(!Number.isInteger(profile.pacerPps) || profile.pacerPps<0) process.exit(74);",
		);
		// The UDP send batch is a registered profile field (udpSendBatch, 0 =
		// off): the cell runs the addon's batched socket under it and both
		// graders assert the scan's recorded size against it.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pins a literal bash default, not a JS template
		expect(script).toContain("local udp_send_batch=${18:-0}");
		expect(script).toContain("SCAN_UDP_SEND_BATCH=$udp_send_batch");
		expect(
			script.split('--expected-udp-send-batch "$udp_send_batch"').length - 1,
		).toBe(2);
		expect(
			script.split("read_winner_field profile.udpSendBatch").length - 1,
		).toBe(3);
		expect(script).toContain(
			"if(!Number.isInteger(profile.udpSendBatch) || profile.udpSendBatch<0) process.exit(74);",
		);
		// The server UDP send buffer is server-only: read from the frozen
		// profile, dispatched into the scan, then asserted again by both
		// graders against the scan output they read back.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pins a literal bash default, not a JS template
		expect(script).toContain("local server_udp_sndbuf_bytes=${19:-0}");
		expect(script).toContain(
			"SCAN_SERVER_UDP_SNDBUF_BYTES=$server_udp_sndbuf_bytes",
		);
		expect(
			script.split(
				'--expected-server-udp-sndbuf-bytes "$server_udp_sndbuf_bytes"',
			).length - 1,
		).toBe(2);
		expect(
			script.split("read_winner_field profile.serverUdpSendBufferBytes")
				.length - 1,
		).toBe(3);
		expect(script).toContain(
			"if(!Number.isInteger(profile.serverUdpSendBufferBytes) || (profile.serverUdpSendBufferBytes!==0 && (profile.serverUdpSendBufferBytes<65536 || profile.serverUdpSendBufferBytes>67108864))) process.exit(74);",
		);
		// The knob is restored on every exit from a rated cell, not just the
		// successful one, and again from cleanup — so neither an aborted
		// campaign nor the bounded retry ever meets a NIC left reconfigured.
		expect(extractFunction(script, "restore_cell_instruments")).toContain(
			'restore_server_gro "$local_dir/restore-gro" RUNNING',
		);
		const cellBody = extractFunction(script, "run_cell_once");
		expect(
			cellBody.split('restore_cell_instruments "$local_dir" "$recv_bytes"')
				.length - 1,
		).toBe(3);
		// The apply is checked explicitly: run_cell runs run_cell_once with
		// errexit off, so a failed capture_operation would otherwise be recorded
		// and then ignored, and the cell would be graded as if the knob took.
		expect(cellBody).toContain(
			'g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" "$(gro_remote_script "$server_gro" "$remote_dir")" \\\n    || return $?',
		);
		expect(extractFunction(script, "cleanup_campaign")).toContain(
			"restore_server_gro",
		);
		const cell = extractFunction(script, "run_cell_once");
		expect(cell).toContain('"$cell-apply-buffer-generator"');
		// The generator twin restores through the same shared helper as the
		// server's, so it too is put back on every exit from a rated cell.
		expect(extractFunction(script, "restore_cell_instruments")).toContain(
			'restore_generator_settings "$local_dir/restore-buffer-generator"',
		);
		const cleanup = extractFunction(script, "cleanup_campaign");
		expect(cleanup).toContain("restore_server_settings");
		expect(cleanup).toContain("restore_generator_settings");
		expect(script).toContain("artifact-manifest.json");
		expect(script).toContain(
			'phase:"FINAL",operationId:"offrunner-artifact-manifest"',
		);
		expect(script).toContain("final-seal.receipt.json");
	}, 15_000);

	test("a server sndbuf apply failure stops the cell before scan starts", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-c32-sndbuf-fail-"));
		roots.push(root);
		const script = source();
		const harness = join(root, "harness.sh");
		writeExecutable(
			harness,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				`HARNESS_ROOT=${JSON.stringify(root)}`,
				'G6_C32_EVIDENCE_ROOT="$HARNESS_ROOT/evidence"',
				'G6_C32_REMOTE_ROOT="/tmp/g6-remote"',
				'G6_C32_SERVER_PUBLIC_IPV4="192.0.2.10"',
				'G6_C32_GENERATOR_PUBLIC_IPV4="192.0.2.11"',
				'G6_C32_GENERATOR_PRIVATE_IPV4="10.0.0.11"',
				'G6_C32_SERVER_PRIVATE_IPV4="10.0.0.10"',
				'G6_C32_RUN_ID="g6-c32-sndbuf-fail"',
				"G6_C32_SHARDS=16",
				'G6_C32_OFFRUNNER_BUN="bun"',
				"G6_C32_REGISTRATION_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"G6_C32_CANDIDATE_COMMIT=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				'BUDGET_LIFECYCLE="ladder-only"',
				'SERVER_CLONE="/srv/server"',
				'GENERATOR_CLONE="/srv/generator"',
				'REMOTE_BUN="/usr/bin/bun"',
				'RCA_EVALUATOR="tools/load/g6-c32-rca-evaluate.ts"',
				"FIXED_SOURCE_PORT_BASE=20000",
				'mkdir -p "$G6_C32_EVIDENCE_ROOT/ladder" "$G6_C32_EVIDENCE_ROOT/.attempts"',
				"next_operation_sequence() { echo 1; }",
				"rfc3339_now() { echo 2026-09-04T00:00:00.000Z; }",
				"before_new_work() { :; }",
				"admit_budget_cell() { :; }",
				'g6_ssh() { printf \'ssh %s\\n\' "$*" >>"$HARNESS_ROOT/ssh.log"; }',
				"g6_scp() { :; }",
				"capture_operation() {",
				"  local label=$1 operation_id=$2 phase=$3",
				"  shift 3",
				'  mkdir -p "$(dirname "$label")"',
				'  printf \'%s\\n\' "$operation_id" >>"$HARNESS_ROOT/operations.log"',
				'  if [ "$operation_id" = "L5000-1-snapshot-server-sndbuf" ]; then',
				"    printf 'net.core.wmem_max 212992\\n' >\"$label.stdout\"",
				"    return 0",
				"  fi",
				'  if [ "$operation_id" = "L5000-1-apply-server-sndbuf" ]; then',
				"    return 91",
				"  fi",
				"  return 0",
				"}",
				"restore_cell_instruments() { :; }",
				'gro_remote_script() { printf "true"; }',
				extractFunction(script, "run_cell_once"),
				extractFunction(script, "run_cell"),
				"run_cell L5000-1 5000 128 50 250 0 1 historical ladder 5000 ladder native 2 off dedicated relaxed 30000 64 26214400",
				"",
			].join("\n"),
		);
		const result = spawnSync("bash", [harness], { encoding: "utf8" });
		expect(result.status).not.toBe(0);
		const operations = readFileSync(join(root, "operations.log"), "utf8");
		expect(operations).toContain("L5000-1-apply-server-sndbuf\n");
		expect(operations).not.toContain("L5000-1-scan\n");
	}, 15_000);

	test("verify_ladder_profile accepts 0 and range boundaries for serverUdpSendBufferBytes", () => {
		const script = source();
		for (const value of [0, 65_536, 67_108_864]) {
			const root = mkdtempSync(join(tmpdir(), "g6-c32-ladder-valid-"));
			roots.push(root);
			writeLadderProfile(root, value);
			const harness = join(root, "harness.sh");
			writeExecutable(
				harness,
				[
					"#!/usr/bin/env bash",
					"set -euo pipefail",
					'G6_C32_EVIDENCE_ROOT="/tmp/g6-c32-evidence"',
					'G6_C32_OFFRUNNER_BUN="bun"',
					"capture_operation() {",
					"  local label=$1 operation_id=$2 phase=$3",
					"  shift 3",
					'  mkdir -p "$(dirname "$label")"',
					'  "$@"',
					"}",
					extractFunction(script, "verify_ladder_profile"),
					"verify_ladder_profile",
					"",
				].join("\n"),
			);
			const result = spawnSync("bash", [harness], {
				cwd: root,
				encoding: "utf8",
			});
			expect({ value, status: result.status, stderr: result.stderr }).toEqual({
				value,
				status: 0,
				stderr: "",
			});
		}
	}, 15_000);

	test("verify_ladder_profile rejects out-of-contract serverUdpSendBufferBytes values", () => {
		const script = source();
		for (const value of [1, 67_108_865]) {
			const root = mkdtempSync(join(tmpdir(), "g6-c32-ladder-invalid-"));
			roots.push(root);
			writeLadderProfile(root, value);
			const harness = join(root, "harness.sh");
			writeExecutable(
				harness,
				[
					"#!/usr/bin/env bash",
					"set -euo pipefail",
					'G6_C32_EVIDENCE_ROOT="/tmp/g6-c32-evidence"',
					'G6_C32_OFFRUNNER_BUN="bun"',
					"capture_operation() {",
					"  local label=$1 operation_id=$2 phase=$3",
					"  shift 3",
					'  mkdir -p "$(dirname "$label")"',
					'  "$@"',
					"}",
					extractFunction(script, "verify_ladder_profile"),
					"verify_ladder_profile",
					"",
				].join("\n"),
			);
			const result = spawnSync("bash", [harness], {
				cwd: root,
				encoding: "utf8",
			});
			expect({ value, status: result.status }).toEqual({
				value,
				status: 74,
			});
		}
	}, 15_000);

	test("initializes the transfer winner label before deriving its evidence root", () => {
		const script = source();
		expect(script).toContain(
			'local label=$1\n  local root="$G6_C32_EVIDENCE_ROOT/transfer/$label"',
		);
		expect(script).not.toContain(
			'local label=$1 root="$G6_C32_EVIDENCE_ROOT/transfer/$label"',
		);
	}, 15_000);

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
		// A non-2 evaluator failure still returns its own status and is not
		// retried; it just has to put the rig back on the way out, like every
		// other exit from a rated cell.
		expect(cell).toContain(
			'if [ "$evaluate_status" -ne 0 ]; then\n    restore_cell_instruments "$local_dir" "$recv_bytes" || return $?\n    return "$evaluate_status"\n  fi',
		);
		expect(
			cell.split('restore_cell_instruments "$local_dir" "$recv_bytes"').length -
				1,
		).toBe(3);
		expect(wrapper).toContain(
			'local retry_archive="$G6_C32_EVIDENCE_ROOT/$9/.attempts/$1-attempt-1"',
		);
		expect(wrapper).toContain('mv "$first_attempt" "$retry_archive"');
	}, 15_000);

	test("executes the bounded retry after an incomplete evaluator sentinel", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-c32-retry-"));
		roots.push(root);
		const script = source();
		const extract = (name: string): string => {
			const start = script.indexOf(`${name}() {`);
			expect(start).toBeGreaterThan(-1);
			const end = script.indexOf("\n}", start);
			expect(end).toBeGreaterThan(start);
			return script.slice(start, end + 2);
		};
		const fakeBun = join(root, "fake-bun.sh");
		writeExecutable(
			fakeBun,
			[
				"#!/usr/bin/env bash",
				'for argument in "$@"; do',
				'  if [ "$argument" = admit-cell ]; then',
				"    while [ $# -gt 0 ]; do",
				'      if [ "$1" = --out ]; then printf \'{"decision":"ADMIT"}\\n\' >"$2"; fi',
				"      shift",
				"    done",
				"    printf 'admit\\n' >>\"$RETRY_HARNESS_ROOT/admissions.log\"",
				"    exit 0",
				"  fi",
				"done",
				"exit 0",
				"",
			].join("\n"),
		);
		// A stateful fake NIC: the retry only proves anything if the second
		// attempt's apply-gro meets whatever the first attempt left behind.
		const fakeBin = join(root, "bin");
		mkdirSync(fakeBin, { recursive: true });
		writeExecutable(
			join(fakeBin, "ip"),
			`#!/usr/bin/env bash\necho "2: eth1    inet 10.0.0.10/24 brd 10.0.0.255 scope global eth1"\n`,
		);
		writeExecutable(
			join(fakeBin, "ethtool"),
			[
				"#!/usr/bin/env bash",
				`state=$(cat ${JSON.stringify(join(root, "gro.state"))})`,
				'if [ "$1" = "-k" ]; then echo "generic-receive-offload: $state"; exit 0; fi',
				`if [ "$1" = "-K" ]; then printf '%s' "$4" >${JSON.stringify(join(root, "gro.state"))}; exit 0; fi`,
				"exit 0",
				"",
			].join("\n"),
		);
		writeFileSync(join(root, "gro.state"), "on");
		const harness = join(root, "harness.sh");
		writeExecutable(
			harness,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				`PATH=${JSON.stringify(fakeBin)}:$PATH`,
				"export PATH",
				`RETRY_HARNESS_ROOT=${JSON.stringify(root)}`,
				"export RETRY_HARNESS_ROOT",
				'G6_C32_EVIDENCE_ROOT="$RETRY_HARNESS_ROOT/evidence"',
				'G6_C32_REMOTE_ROOT="/tmp/retry-harness-remote"',
				"G6_C32_SERVER_PUBLIC_IPV4=192.0.2.10",
				"G6_C32_SERVER_PRIVATE_IPV4=10.0.0.10",
				"G6_C32_GENERATOR_PRIVATE_IPV4=10.0.0.11",
				"SERVER_CLONE=/tmp/retry-harness-server",
				"GENERATOR_CLONE=/tmp/retry-harness-generator",
				"REMOTE_BUN=/usr/local/bin/bun",
				"FIXED_SOURCE_PORT_BASE=40000",
				"G6_C32_SHARDS=16",
				"G6_C32_RUN_ID=retry-harness",
				`G6_C32_CANDIDATE_COMMIT=${"1".repeat(40)}`,
				`G6_C32_REGISTRATION_SHA256=${"2".repeat(64)}`,
				'RCA_EVALUATOR="$RETRY_HARNESS_ROOT/rca-evaluate.ts"',
				`G6_C32_OFFRUNNER_BUN=${JSON.stringify(fakeBun)}`,
				'BUDGET_CLI="$RETRY_HARNESS_ROOT/budget-cli.ts"',
				'REPOSITORY_ARG="$RETRY_HARNESS_ROOT"',
				'BUDGET_POLICY_ARG="$RETRY_HARNESS_ROOT/budget-policy.json"',
				'SPEND_LEDGER_ARG="$RETRY_HARNESS_ROOT/spend-ledger.json"',
				"DEADLINE=",
				'mkdir -p "$G6_C32_EVIDENCE_ROOT"',
				"next_operation_sequence() { printf '1\\n'; }",
				"rfc3339_now() { printf '2026-01-01T00:00:00.000Z\\n'; }",
				"capture_operation() {",
				"  local label=$1 operation_id=$2 phase=$3",
				"  shift 3",
				'  mkdir -p "$(dirname "$label")"',
				'  printf \'%s\\n\' "$operation_id" >>"$RETRY_HARNESS_ROOT/operations.log"',
				'  case "$operation_id" in',
				'    *-remote-mkdir|*-apply-gro|restore-server-gro) "$@"; return $? ;;',
				"    *-evaluate)",
				'      if [ ! -f "$RETRY_HARNESS_ROOT/evaluated-once" ]; then',
				'        : >"$RETRY_HARNESS_ROOT/evaluated-once"',
				"        return 2",
				"      fi",
				"      return 0",
				"      ;;",
				"  esac",
				"  return 0",
				"}",
				"GRO_SNAPSHOT_REMOTE_DIR=",
				extract("gro_probe_prefix"),
				extract("gro_require_before_on"),
				extract("gro_remote_script"),
				extract("restore_server_gro_raw"),
				extract("restore_server_gro"),
				extract("before_new_work"),
				extract("admit_budget_cell"),
				'g6_ssh() { shift; bash -c "$*"; }',
				"GRO_SNAPSHOT_REMOTE_DIR=",
				extract("gro_probe_prefix"),
				extract("gro_require_before_on"),
				extract("gro_remote_script"),
				extract("restore_server_gro_raw"),
				extract("restore_server_gro"),
				extract("restore_cell_instruments"),
				extract("run_cell_once"),
				extract("run_cell"),
				"run_cell A1 5000 128 500 0 0 1 real-time matrix 5000 matrix js 2 off",
				"printf 'completed\\n' >\"$RETRY_HARNESS_ROOT/completed.log\"",
				"",
			].join("\n"),
		);
		const result = spawnSync("bash", [harness], { encoding: "utf8" });
		expect({
			status: result.status,
			stderr: result.stderr,
			completed: existsSync(join(root, "completed.log")),
		}).toEqual({ status: 0, stderr: "", completed: true });
		const admissions = readFileSync(join(root, "admissions.log"), "utf8");
		expect(admissions).toBe("admit\nadmit\n");
		expect(
			existsSync(join(root, "evidence", "matrix", ".attempts", "A1-attempt-1")),
		).toBe(true);
		const operations = readFileSync(join(root, "operations.log"), "utf8");
		expect(
			operations.split("\n").filter((line) => line === "A1-evaluate").length,
		).toBe(2);
		// The retry re-applies GRO with the same arguments, and the off arm
		// demands an on baseline. Without a restore on the exit-2 path the NIC
		// would still be off and the retry would abort on 97 — turning the one
		// transient the retry exists to absorb into a terminal failure.
		expect(
			operations
				.split("\n")
				.filter(
					(line) => line === "A1-apply-gro" || line === "restore-server-gro",
				),
		).toEqual([
			"A1-apply-gro",
			"restore-server-gro",
			"A1-apply-gro",
			"restore-server-gro",
		]);
		// Both attempts ran the knob for real, and the rig is left as found.
		expect(readFileSync(join(root, "gro.state"), "utf8")).toBe("on");
	}, 15_000);

	test("a 25 MiB cell applies and restores the receive buffer on both hosts", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-c32-both-hosts-"));
		roots.push(root);
		const script = source();
		const fakeBun = join(root, "fake-bun.sh");
		writeExecutable(
			fakeBun,
			[
				"#!/usr/bin/env bash",
				'for argument in "$@"; do',
				'  if [ "$argument" = admit-cell ]; then',
				"    while [ $# -gt 0 ]; do",
				'      if [ "$1" = --out ]; then printf \'{"decision":"ADMIT"}\\n\' >"$2"; fi',
				"      shift",
				"    done",
				"    exit 0",
				"  fi",
				"done",
				"exit 0",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(root, "server-sysctls.before"),
			"net.core.rmem_max 212992\nnet.core.rmem_default 212992\nnet.ipv4.udp_rmem_min 4096\n",
		);
		writeFileSync(
			join(root, "generator-sysctls.before"),
			"net.core.rmem_max 212992\nnet.core.rmem_default 212992\nnet.ipv4.udp_rmem_min 4096\n",
		);
		const harness = join(root, "harness.sh");
		writeExecutable(
			harness,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				`HARNESS_ROOT=${JSON.stringify(root)}`,
				"export HARNESS_ROOT",
				'G6_C32_EVIDENCE_ROOT="$HARNESS_ROOT/evidence"',
				'G6_C32_REMOTE_ROOT="/tmp/both-hosts-remote"',
				"G6_C32_SERVER_PUBLIC_IPV4=192.0.2.10",
				"G6_C32_SERVER_PRIVATE_IPV4=10.0.0.10",
				"G6_C32_GENERATOR_PUBLIC_IPV4=192.0.2.11",
				"G6_C32_GENERATOR_PRIVATE_IPV4=10.0.0.11",
				"SERVER_CLONE=/tmp/both-hosts-server",
				"GENERATOR_CLONE=/tmp/both-hosts-generator",
				"REMOTE_BUN=/usr/local/bin/bun",
				"FIXED_SOURCE_PORT_BASE=40000",
				"G6_C32_SHARDS=24",
				"G6_C32_RUN_ID=both-hosts-harness",
				`G6_C32_CANDIDATE_COMMIT=${"1".repeat(40)}`,
				`G6_C32_REGISTRATION_SHA256=${"2".repeat(64)}`,
				'RCA_EVALUATOR="$HARNESS_ROOT/rca-evaluate.ts"',
				`G6_C32_OFFRUNNER_BUN=${JSON.stringify(fakeBun)}`,
				'BUDGET_CLI="$HARNESS_ROOT/budget-cli.ts"',
				'REPOSITORY_ARG="$HARNESS_ROOT"',
				'BUDGET_POLICY_ARG="$HARNESS_ROOT/budget-policy.json"',
				'SPEND_LEDGER_ARG="$HARNESS_ROOT/spend-ledger.json"',
				'SYSCTL_SNAPSHOT="$HARNESS_ROOT/server-sysctls.before"',
				"GRO_SNAPSHOT_REMOTE_DIR=",
				'GENERATOR_SYSCTL_SNAPSHOT="$HARNESS_ROOT/generator-sysctls.before"',
				"DEADLINE=",
				'mkdir -p "$G6_C32_EVIDENCE_ROOT"',
				"next_operation_sequence() { printf '1\\n'; }",
				"rfc3339_now() { printf '2026-01-01T00:00:00.000Z\\n'; }",
				'g6_ssh() { printf \'ssh %s\\n\' "$*" >>"$HARNESS_ROOT/ssh.log"; }',
				"g6_scp() { :; }",
				"capture_operation() {",
				"  local label=$1 operation_id=$2 phase=$3",
				"  shift 3",
				'  mkdir -p "$(dirname "$label")"',
				'  printf \'%s %s\\n\' "$operation_id" "$*" >>"$HARNESS_ROOT/operations.log"',
				'  case "$operation_id" in *-evaluate) return 0 ;; esac',
				'  "$@"',
				"}",
				extractFunction(script, "restore_server_sysctls_raw"),
				extractFunction(script, "restore_server_settings"),
				extractFunction(script, "restore_generator_sysctls_raw"),
				extractFunction(script, "restore_generator_settings"),
				extractFunction(script, "gro_probe_prefix"),
				extractFunction(script, "gro_require_before_on"),
				extractFunction(script, "gro_remote_script"),
				extractFunction(script, "restore_server_gro_raw"),
				extractFunction(script, "restore_server_gro"),
				extractFunction(script, "before_new_work"),
				extractFunction(script, "admit_budget_cell"),
				extractFunction(script, "restore_cell_instruments"),
				extractFunction(script, "run_cell_once"),
				extractFunction(script, "run_cell"),
				"run_cell L5000-1 5000 128 50 250 26214400 1 historical ladder 5000 ladder native 2 off dedicated relaxed 30000 64 26214400",
				"printf 'completed\\n' >\"$HARNESS_ROOT/completed.log\"",
				"",
			].join("\n"),
		);
		const result = spawnSync("bash", [harness], { encoding: "utf8" });
		expect({
			status: result.status,
			stderr: result.stderr,
			completed: existsSync(join(root, "completed.log")),
		}).toEqual({ status: 0, stderr: "", completed: true });
		const operations = readFileSync(join(root, "operations.log"), "utf8");
		const ssh = readFileSync(join(root, "ssh.log"), "utf8");
		const apply = "sysctl -w net.core.rmem_max=26214400";
		const serverSendApply = "sysctl -w net.core.wmem_max=26214400";
		for (const host of ["192.0.2.10", "192.0.2.11"]) {
			expect(operations).toMatch(
				new RegExp(
					`^L5000-1-apply-buffer(-generator)? .*root@${host} ${apply}`,
					"m",
				),
			);
			expect(ssh).toMatch(
				new RegExp(
					`^ssh root@${host} sysctl -w 'net.core.rmem_max=212992'$`,
					"m",
				),
			);
		}
		expect(operations).toMatch(
			new RegExp(
				`^L5000-1-apply-server-sndbuf .*root@192\\.0\\.2\\.10 ${serverSendApply}`,
				"m",
			),
		);
		expect(ssh).toMatch(
			/^ssh root@192\.0\.2\.10 sysctl -w 'net.core.wmem_max=212992'$/m,
		);
		expect(operations).toMatch(/^L5000-1-scan .*SCAN_ACK_REFLECTOR=native/m);
		expect(operations).toMatch(/^L5000-1-scan .*SCAN_SERVER_WORKERS=2/m);
		expect(operations).toMatch(/^L5000-1-scan .*SCAN_SERVER_GRO=off/m);
		expect(operations).toMatch(
			/^L5000-1-scan .*SCAN_SERVER_RECV_RUNTIME=dedicated/m,
		);
		expect(operations).toMatch(/^L5000-1-scan .*SCAN_ACK_CADENCE=relaxed/m);
		expect(operations).toMatch(
			/^L5000-1-scan .*SCAN_SERVER_UDP_SNDBUF_BYTES=26214400/m,
		);
		// The apply resolves the device from the private address rather than
		// naming one, snapshots the prior line, turns GRO off, and re-reads to
		// prove it took — a driver that ignored the request exits 95.
		expect(operations).toMatch(/^L5000-1-apply-gro .*root@192\.0\.2\.10 /m);
		expect(ssh).toContain("ip -o -4 addr show | grep -F ' 10.0.0.10/'");
		expect(ssh).toContain('ethtool -K "$iface" gro off');
		expect(ssh).toContain("'off:generic-receive-offload: off'*) ;;");
		// The on arm is verified too, so an unrestored off NIC cannot be graded
		// as an on cell.
		expect(ssh).toContain("'on:generic-receive-offload: on'*) ;;");
		expect(ssh).toContain("but the cell was dispatched as the %s arm");
		// A snapshot that cannot be written refuses before the NIC is touched.
		expect(ssh).toContain("gro-before.state' || exit 95");
		// The restore reads the snapshot back off the server and only turns GRO
		// on again when that is what it found.
		expect(ssh).toContain(
			'case "$before" in \'generic-receive-offload: on\'*) ethtool -K "$iface" gro on',
		);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-ack-reflector native/m,
		);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-server-workers 2/m,
		);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-server-gro off/m,
		);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-server-recv-runtime dedicated/m,
		);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-ack-cadence relaxed/m,
		);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-pacer-pps 30000/m,
		);
		expect(operations).toMatch(
			/^L5000-1-scan .*G6_EMITTER_MODE=paced-mirror G6_PACED_EMITTER=1 WEBTRANSPORT_PACER_PPS=30000 /m,
		);
		expect(operations).toMatch(/^L5000-1-scan .*SCAN_UDP_SEND_BATCH=64 /m);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-udp-send-batch 64/m,
		);
		expect(operations).toMatch(
			/^L5000-1-evaluate .*--expected-server-udp-sndbuf-bytes 26214400/m,
		);
		const order = (needle: string) => operations.indexOf(needle);
		expect(order("L5000-1-apply-buffer-generator")).toBeLessThan(
			order("L5000-1-scan"),
		);
		expect(order("L5000-1-apply-server-sndbuf")).toBeLessThan(
			order("L5000-1-scan"),
		);
		expect(order("L5000-1-apply-gro")).toBeLessThan(order("L5000-1-scan"));
		expect(order("L5000-1-evaluate")).toBeLessThan(order("restore-server-gro"));
		expect(order("restore-server-gro")).toBeLessThan(order("L5000-1-seal"));
		expect(order("L5000-1-evaluate")).toBeLessThan(
			order("restore-generator-sysctls"),
		);
		expect(order("restore-generator-sysctls")).toBeLessThan(
			order("L5000-1-seal"),
		);
	}, 15_000);

	test("a refused admission stops the cell before any operation", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-c32-refuse-"));
		roots.push(root);
		const script = source();
		const extract = (name: string): string => {
			const start = script.indexOf(`${name}() {`);
			expect(start).toBeGreaterThan(-1);
			const end = script.indexOf("\n}", start);
			expect(end).toBeGreaterThan(start);
			return script.slice(start, end + 2);
		};
		const fakeBun = join(root, "fake-bun.sh");
		writeExecutable(
			fakeBun,
			[
				"#!/usr/bin/env bash",
				'for argument in "$@"; do',
				'  if [ "$argument" = admit-cell ]; then',
				"    while [ $# -gt 0 ]; do",
				'      if [ "$1" = --out ]; then printf \'{"decision":"REFUSED_DEADLINE"}\\n\' >"$2"; fi',
				"      shift",
				"    done",
				"    printf 'admit\\n' >>\"$RETRY_HARNESS_ROOT/admissions.log\"",
				"    exit 3",
				"  fi",
				'  case "$argument" in',
				"    *value.decision*) printf 'REFUSED_DEADLINE\\n'; exit 0 ;;",
				"  esac",
				"done",
				"exit 0",
				"",
			].join("\n"),
		);
		const harness = join(root, "harness.sh");
		writeExecutable(
			harness,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				`RETRY_HARNESS_ROOT=${JSON.stringify(root)}`,
				"export RETRY_HARNESS_ROOT",
				'G6_C32_EVIDENCE_ROOT="$RETRY_HARNESS_ROOT/evidence"',
				'G6_C32_REMOTE_ROOT="/tmp/retry-harness-remote"',
				"G6_C32_SERVER_PUBLIC_IPV4=192.0.2.10",
				"G6_C32_SERVER_PRIVATE_IPV4=10.0.0.10",
				"G6_C32_GENERATOR_PRIVATE_IPV4=10.0.0.11",
				"SERVER_CLONE=/tmp/retry-harness-server",
				"GENERATOR_CLONE=/tmp/retry-harness-generator",
				"REMOTE_BUN=/usr/local/bin/bun",
				"FIXED_SOURCE_PORT_BASE=40000",
				"G6_C32_SHARDS=16",
				"G6_C32_RUN_ID=retry-harness",
				`G6_C32_CANDIDATE_COMMIT=${"1".repeat(40)}`,
				`G6_C32_REGISTRATION_SHA256=${"2".repeat(64)}`,
				'RCA_EVALUATOR="$RETRY_HARNESS_ROOT/rca-evaluate.ts"',
				`G6_C32_OFFRUNNER_BUN=${JSON.stringify(fakeBun)}`,
				'BUDGET_CLI="$RETRY_HARNESS_ROOT/budget-cli.ts"',
				'REPOSITORY_ARG="$RETRY_HARNESS_ROOT"',
				'BUDGET_POLICY_ARG="$RETRY_HARNESS_ROOT/budget-policy.json"',
				'SPEND_LEDGER_ARG="$RETRY_HARNESS_ROOT/spend-ledger.json"',
				"DEADLINE=",
				'mkdir -p "$G6_C32_EVIDENCE_ROOT"',
				"next_operation_sequence() { printf '1\\n'; }",
				"rfc3339_now() { printf '2026-01-01T00:00:00.000Z\\n'; }",
				"capture_operation() {",
				"  local label=$1 operation_id=$2 phase=$3",
				"  shift 3",
				'  mkdir -p "$(dirname "$label")"',
				'  printf \'%s\\n\' "$operation_id" >>"$RETRY_HARNESS_ROOT/operations.log"',
				"  return 0",
				"}",
				"GRO_SNAPSHOT_REMOTE_DIR=",
				extract("gro_probe_prefix"),
				extract("gro_require_before_on"),
				extract("gro_remote_script"),
				extract("restore_server_gro_raw"),
				extract("restore_server_gro"),
				extract("before_new_work"),
				extract("admit_budget_cell"),
				extract("restore_cell_instruments"),
				extract("run_cell_once"),
				extract("run_cell"),
				"run_cell A1 5000 128 500 0 0 1 real-time matrix",
				"printf 'completed\\n' >\"$RETRY_HARNESS_ROOT/completed.log\"",
				"",
			].join("\n"),
		);
		const result = spawnSync("bash", [harness], { encoding: "utf8" });
		expect({
			status: result.status,
			completed: existsSync(join(root, "completed.log")),
			operations: existsSync(join(root, "operations.log")),
			ratedCells: existsSync(join(root, "evidence", "rated-cells.log")),
		}).toEqual({
			status: 3,
			completed: false,
			operations: false,
			ratedCells: false,
		});
		const admissions = readFileSync(join(root, "admissions.log"), "utf8");
		expect(admissions).toBe("admit\n");
		expect(readFileSync(join(root, "evidence", "RUN_STATUS"), "utf8")).toBe(
			"REFUSED_DEADLINE\n",
		);
	}, 15_000);

	test("the final evidence seal emits a manifest the validator accepts", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-c32-seal-"));
		roots.push(root);
		const script = source();
		const start = script.indexOf("seal_final_evidence() {");
		expect(start).toBeGreaterThan(-1);
		const end = script.indexOf("\n}", start);
		expect(end).toBeGreaterThan(start);
		const sealFunction = script.slice(start, end + 2);
		const evidence = join(root, "evidence");
		mkdirSync(join(evidence, "closeout"), { recursive: true });
		mkdirSync(join(evidence, "probe"), { recursive: true });
		mkdirSync(join(evidence, "matrix", "D2"), { recursive: true });
		writeFileSync(join(evidence, "RUN_STATUS"), "RCA_CONFIRMED\n");
		writeFileSync(join(evidence, ".operation-sequence"), "42\n");
		writeFileSync(join(evidence, "SHA256SUMS"), "stale\n");
		writeFileSync(
			join(evidence, "probe", "decision.json"),
			'{"status":"PASS"}\n',
		);
		writeFileSync(
			join(evidence, "matrix", "D2", "rca.json"),
			'{"complete":true}\n',
		);
		writeFileSync(
			join(evidence, "matrix", "D2", "SHA256SUMS"),
			`${"e".repeat(64)}  rca.json\n`,
		);
		const harness = join(root, "harness.sh");
		writeExecutable(
			harness,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				`G6_C32_EVIDENCE_ROOT=${JSON.stringify(evidence)}`,
				"G6_C32_RUN_ID=seal-harness",
				`G6_C32_OFFRUNNER_BUN=${JSON.stringify(process.execPath)}`,
				sealFunction,
				"seal_final_evidence 300 301",
				"",
			].join("\n"),
		);
		const result = spawnSync("bash", [harness], { encoding: "utf8" });
		expect({ status: result.status, stderr: result.stderr }).toEqual({
			status: 0,
			stderr: "",
		});
		const manifest = JSON.parse(
			readFileSync(join(evidence, "artifact-manifest.json"), "utf8"),
		);
		expect(() => validateArtifactManifestRecord(manifest)).not.toThrow();
		const paths = manifest.entries.map((entry: { path: string }) => entry.path);
		expect(paths).toContain("probe/decision.json");
		expect(paths).toContain("matrix/D2/SHA256SUMS");
		expect(paths).toContain("closeout/final-seal.receipt.json");
		for (const excluded of [
			"RUN_STATUS",
			".operation-sequence",
			"SHA256SUMS",
			"artifact-manifest.json",
		]) {
			expect(paths).not.toContain(excluded);
		}
		const sums = readFileSync(join(evidence, "SHA256SUMS"), "utf8");
		expect(sums).toContain("  RUN_STATUS");
		expect(sums).toContain("  .operation-sequence");
		expect(sums).toContain("  artifact-manifest.json");
	}, 15_000);

	test("a verifier failure performs no SSH and takes no lock", () => {
		const run = runWithFakes("verify-fail");
		expect(run.result.status).not.toBe(0);
		expect(run.sshLog).toBe("");
		expect(run.lockLog).toBe("");
	}, 15_000);

	test("rejects malformed verifier output without evaluating it", () => {
		const run = runWithFakes("malformed");
		expect(run.result.status).not.toBe(0);
		expect(existsSync(join(run.root, "malformed-executed"))).toBeFalse();
		expect(run.sshLog).toBe("");
		expect(run.lockLog).toBe("");
	}, 15_000);

	test("post-fix-only proceeds into the campaign instead of failing closed", () => {
		const run = runWithFakes("post-fix");
		expect(run.result.status).not.toBe(67);
		expect(run.result.stderr).not.toContain(
			"post-fix-only has no frozen mechanism-specific executor",
		);
		expect(run.sshLog).not.toBe("");
	}, 15_000);

	test("executes the ladder only for a confirmed post-fix transfer", () => {
		const script = source();
		const tail = script.slice(
			script.lastIndexOf('if [ "$BUDGET_LIFECYCLE" = ladder-only ]; then'),
		);
		const scenarios = [
			{
				lifecycle: "rca-only",
				confirmed: "1",
				calls: "authorize\nmatrix\ntransfer\nfinalize\n",
			},
			{
				lifecycle: "post-fix-only",
				confirmed: "1",
				calls: "authorize\nmatrix\ntransfer\nladder\nfinalize\n",
			},
			{
				lifecycle: "post-fix-only",
				confirmed: "0",
				calls: "authorize\nmatrix\ntransfer\nfinalize\n",
			},
			{
				lifecycle: "ladder-only",
				confirmed: "0",
				calls: "authorize\nladder\nfinalize\n",
			},
		] as const;
		for (const scenario of scenarios) {
			const root = mkdtempSync(join(tmpdir(), "g6-c32-tail-"));
			roots.push(root);
			const log = join(root, "calls.log");
			const harness = join(root, "harness.sh");
			writeExecutable(
				harness,
				[
					"#!/usr/bin/env bash",
					"set -euo pipefail",
					`BUDGET_LIFECYCLE=${scenario.lifecycle}`,
					"TRANSFER_CONFIRMED=0",
					`write_dispatch_authorization() { printf 'authorize\\n' >>${JSON.stringify(log)}; }`,
					`run_probe_and_matrix() { printf 'matrix\\n' >>${JSON.stringify(log)}; }`,
					`run_transfer() { printf 'transfer\\n' >>${JSON.stringify(log)}; TRANSFER_CONFIRMED=${scenario.confirmed}; }`,
					`run_ladder_and_companion() { printf 'ladder\\n' >>${JSON.stringify(log)}; }`,
					`finalize_campaign() { printf 'finalize\\n' >>${JSON.stringify(log)}; }`,
					"verify_ladder_profile() { :; }",
					tail,
				].join("\n"),
			);
			const result = spawnSync("bash", [harness], { encoding: "utf8" });
			expect({
				scenario,
				status: result.status,
				stderr: result.stderr,
				calls: readFileSync(log, "utf8"),
			}).toEqual({
				scenario,
				status: 0,
				stderr: "",
				calls: scenario.calls,
			});
		}
	}, 15_000);

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
	}, 15_000);
	test("proves the GRO knob at qualification, before any cell can be admitted", () => {
		const script = source();
		// The per-cell apply's 94/95/96 fire after admit_budget_cell, so on the
		// last fundable run a rig that cannot honour the knob would cost
		// qualification plus a billed cell before saying so. The capability is
		// proven in the qualification sequence instead.
		expect(script).toContain(
			"qualification_clock_resources\nqualification_gro_capability\n",
		);
		// Everything billed sits past the qualify-only exit; the probe sits before it.
		expect(script.indexOf("\nqualification_gro_capability\n")).toBeLessThan(
			script.indexOf('if [ "$MODE" = qualify ]'),
		);
		// Both the probe and the per-cell apply resolve the device through one
		// shared snippet, so they can never disagree about which NIC is meant.
		for (const fn of ["gro_capability_script", "gro_remote_script"])
			expect(extractFunction(script, fn)).toContain('"$(gro_probe_prefix)"');
		// ethtool that runs but reports no such feature is a refused knob (95),
		// not a missing tool (94).
		expect(extractFunction(script, "gro_probe_prefix")).toContain(
			"has no generic-receive-offload feature line",
		);
		// An already-off NIC would make the off arm a null result that still
		// spends the lifecycle, so it refuses with its own code — but only on
		// the off arm, since the on arm has no baseline to require.
		expect(extractFunction(script, "gro_require_before_on")).toContain(
			"exit 97",
		);
		expect(extractFunction(script, "gro_capability_script")).toContain(
			'"$(gro_require_before_on)"',
		);
		const apply = extractFunction(script, "gro_remote_script");
		expect(apply).toContain(
			'[ "$mode" = off ] && require_on=$(gro_require_before_on)',
		);

		const root = mkdtempSync(join(tmpdir(), "g6-c32-gro-qual-"));
		roots.push(root);
		const fakeBun = join(root, "fake-bun.sh");
		writeExecutable(fakeBun, "#!/usr/bin/env bash\nprintf 'off\\n'\nexit 0\n");
		const harness = join(root, "harness.sh");
		writeExecutable(
			harness,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				`QUAL_ROOT=${JSON.stringify(root)}`,
				"export QUAL_ROOT",
				'G6_C32_EVIDENCE_ROOT="$QUAL_ROOT/evidence"',
				"G6_C32_SERVER_PUBLIC_IPV4=192.0.2.10",
				"G6_C32_SERVER_PRIVATE_IPV4=10.0.0.10",
				`G6_C32_OFFRUNNER_BUN=${JSON.stringify(fakeBun)}`,
				'mkdir -p "$G6_C32_EVIDENCE_ROOT/qualification"',
				"capture_operation() {",
				"  local label=$1 operation_id=$2 phase=$3",
				"  shift 3",
				'  mkdir -p "$(dirname "$label")"',
				'  printf \'%s %s\\n\' "$operation_id" "$phase" >>"$QUAL_ROOT/operations.log"',
				'  "$@" >"$label.stdout" 2>"$label.stderr"',
				"}",
				'g6_ssh() { printf \'ssh %s\\n\' "$*" >>"$QUAL_ROOT/ssh.log"; }',
				extractFunction(script, "gro_probe_prefix"),
				extractFunction(script, "gro_require_before_on"),
				extractFunction(script, "gro_capability_script"),
				extractFunction(script, "read_profile_server_gro"),
				extractFunction(script, "qualification_gro_capability"),
				"qualification_gro_capability",
				"printf 'completed\\n' >\"$QUAL_ROOT/completed.log\"",
				"",
			].join("\n"),
		);
		const result = spawnSync("bash", [harness], { encoding: "utf8" });
		expect({
			status: result.status,
			stderr: result.stderr,
			completed: existsSync(join(root, "completed.log")),
		}).toEqual({ status: 0, stderr: "", completed: true });

		const operations = readFileSync(join(root, "operations.log"), "utf8");
		// The whole probe is QUALIFYING work, and it writes the receipt the
		// reviewer reads back.
		expect(operations).toContain("profile-server-gro QUALIFYING");
		expect(operations).toContain("gro-capability QUALIFYING");
		expect(
			existsSync(join(root, "evidence/qualification/gro-capability.stdout")),
		).toBe(true);

		const ssh = readFileSync(join(root, "ssh.log"), "utf8");
		expect(ssh).toContain("command -v ethtool >/dev/null 2>&1 || exit 94");
		expect(ssh).toContain("ip -o -4 addr show | grep -F ' 10.0.0.10/'");
		expect(ssh).toContain("|| exit 96");
		// Off, proven, then put straight back to whatever was found — the probe
		// must not leave the NIC reconfigured for the rest of qualification.
		expect(ssh).toContain('ethtool -K "$iface" gro off || exit 95');
		expect(ssh).toContain(
			'case "$before" in \'generic-receive-offload: on\'*) ethtool -K "$iface" gro on',
		);
		expect(ssh).toContain('[ "$restored" = "$before" ] || exit 95');
		// The snapshotted before-line is both refused on and recorded, so the
		// receipt's stdout says which baseline the probe actually found.
		expect(ssh).toContain("exit 97");
		expect(ssh).toContain(
			"is already off; the off arm would have no on baseline",
		);
		expect(ssh).toContain("printf 'before %s\\n' \"$before\"");
		// The restore is attempted before the verdict, so a fixed feature still
		// leaves the NIC as it was found.
		expect(ssh.indexOf('ethtool -K "$iface" gro on')).toBeLessThan(
			ssh.indexOf("case \"$probed\" in 'generic-receive-offload: off'*"),
		);
	}, 15_000);
});
