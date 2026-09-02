import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sumWindowQuic } from "./g6-artifact.ts";

const source = readFileSync(
	join(import.meta.dir, "g6-sharded-scan.ts"),
	"utf8",
);
const setupSource = readFileSync(
	join(import.meta.dir, "g6-shard-bpf-setup.sh"),
	"utf8",
);
const steerSource = readFileSync(
	join(import.meta.dir, "../../examples/quic-lb/steer_by_cid.bpf.c"),
	"utf8",
);

describe("g6 sharded scan source-bound configuration", () => {
	test("places client-chosen DCIDs uniformly instead of kernel-hash luck", () => {
		expect(steerSource).toContain("place_by_client_dcid");
		expect(steerSource).toContain(
			"return place_by_client_dcid(reuse, prefix[UDP_HDR_LEN + 5]);",
		);
		expect(steerSource).not.toContain(
			"if (prefix[UDP_HDR_LEN + 5] != CID_LEN)\n\t\t\treturn fallback();",
		);
		expect(steerSource).toContain("if (dcid_len < 8)");
		expect(steerSource).toContain("0x811c9dc5");
		expect(steerSource).toContain("0x01000193");
		expect(steerSource).toContain("hash % MAX_INSTANCES");
		const placement = steerSource.slice(
			steerSource.indexOf("static __always_inline int place_by_client_dcid"),
			steerSource.indexOf('SEC("sk_reuseport")'),
		);
		expect(placement).toContain(
			"bpf_sk_select_reuseport(reuse, &socks, &slot, 0)",
		);
		expect(placement).toContain("return fallback();");
		expect(placement).toContain("bump(0);");
	});

	test("bounds the shard count by the BPF build cap instead of a fixed 16", () => {
		expect(source).toContain("const SHARDS = parseInt(process.env.SCAN_SHARDS");
		expect(source).toContain(
			"if (!Number.isInteger(SHARDS) || SHARDS < 1 || SHARDS > 64) {",
		);
		expect(source).toContain('"g6-sharded-scan: SCAN_SHARDS must be 1..64"');
		expect(source).toContain("-DMAX_INSTANCES=<shards>");
		expect(source).not.toContain("SCAN_SHARDS must be 1..16");
		expect(source).not.toContain("-DMAX_INSTANCES=16");
	});

	test("requires diagnostics for the Linux probe at any shard count", () => {
		expect(source).toContain("if (LINUX_PROBE_ENABLED && !DIAGNOSTIC) {");
		expect(source).toContain(
			'"g6-sharded-scan: Linux probe requires diagnostics"',
		);
		expect(source).not.toContain("SHARDS !== 16");
		expect(source).not.toContain("exactly 16 shards");
	});

	test("passes the probe the sized artifact budget, not a stale literal", () => {
		expect(source).toContain(
			'parsePositiveIntegerEnv(\n\t"SCAN_LINUX_PROBE_MAX_BYTES",\n\tDEFAULT_MAX_BYTES,\n)',
		);
		expect(source).not.toContain("16 * 1024 * 1024");
		expect(source).toContain(
			'"--max-bytes",\n\t\t\tString(LINUX_PROBE_MAX_BYTES),',
		);
	});

	test("uses one resolved connect timeout for the client, watchdog, and artifact", () => {
		expect(source).toMatch(
			/const CONNECT_TIMEOUT_SECONDS = parsePositiveIntegerEnv\(\s*"SCAN_CONNECT_TIMEOUT_SECONDS",\s*300,?\s*\);/,
		);
		expect(source).toContain("connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS");
		expect(source).not.toContain(
			'"--connect-timeout",\n\t\t\t\t\t\tprocess.env.SCAN_CONNECT_TIMEOUT_SECONDS',
		);
	});

	test("validates and seals the RCA connection shape controls", () => {
		expect(source).toContain(
			'const CONNECT_CONCURRENCY = parsePositiveIntegerEnv(\n\t"SCAN_CONNECT_CONCURRENCY",\n\t500,\n);',
		);
		expect(source).toContain(
			'const CONNECT_RATE_PER_SEC = parseNonnegativeIntegerEnv(\n\t"SCAN_CONNECT_RATE_PER_SEC",\n\t0,\n);',
		);
		expect(source).toContain("SCAN_FIXED_SOURCE_PORT_BASE");
		expect(source).toContain('"--connect-rate-per-sec"');
		expect(source).toContain('"--fixed-source-port-base"');
		expect(source).toContain("connectRatePerSec: CONNECT_RATE_PER_SEC");
		expect(source).toContain("fixedSourcePortBase: FIXED_SOURCE_PORT_BASE");
	});

	test("binds matched-throughput active sessions through dispatch and evidence", () => {
		expect(source).toContain("SCAN_WORKLOAD_ACTIVE_SESSIONS");
		expect(source).toContain('"--active-sessions"');
		expect(source).toContain(
			"activeWorkloadSessions: WORKLOAD_ACTIVE_SESSIONS",
		);
		expect(source).toContain("aggregate: {");
		expect(source).toContain("lifetime: sumWindows(lifetimeWindows)");
		expect(source).toContain("sessionsByKindAtSteady");
		expect(source).toContain("must not exceed SCAN_SESSIONS");
	});

	test("collects UDP socket counters only for inodes owned by each shard", () => {
		expect(source).toContain("readPerProcessUdpSockets,");
		expect(source).toContain('from "./g6-sharded-diagnostic.ts";');
		expect(source).toMatch(
			/perShardUdp\[shard\.serverId\]\s*=\s*readPerProcessUdpSockets\(\s*shard\.child\.pid!\s*,?\s*\);/,
		);
		expect(source).not.toContain(
			'const lines = text.split("\\n").filter((l) => l.startsWith("Udp:"));',
		);
	});

	test("keeps typed host UDP samples phase-bound and diagnostic-only", () => {
		expect(source).toContain("type HostUdpCounters,");
		expect(source).toContain("parseHostUdpCounters,");
		expect(source).toContain(
			"function readKernelUdp(): HostUdpCounters | null",
		);
		expect(source).toContain(
			'return parseHostUdpCounters(readFileSync("/proc/net/snmp", "utf8"));',
		);
		expect(source).not.toContain("const out: Record<string, number> = {};");
		expect(source).toContain('captureServerHostUdp("connect")');
		expect(source).toContain('captureServerHostUdp("steady")');
		expect(source).toContain('captureServerHostUdp("drain")');
		expect(source).toContain('captureServerHostUdp("idle")');
		expect(source).toContain("serverHostUdp: serverHostUdpSamples");
		expect(source).toContain(
			'"--",\n\t\t\t\t...(DIAGNOSTIC ? ["--diagnostic-host-udp"] : [])',
		);

		const resultStart = source.indexOf("const result = {");
		const resultEnd = source.indexOf("writeFileSync(OUT", resultStart);
		const ratedOutput = source.slice(resultStart, resultEnd);
		expect(ratedOutput).toContain('schema: "g6-sharded-scan/2"');
		expect(ratedOutput).toContain("kernelMarks");
		expect(ratedOutput).not.toContain("serverHostUdp");
	});

	test("derives T1 from actual connect time and parses errors after output closes", () => {
		expect(source).toContain("t1TargetTsMs");
		expect(source).toContain("t1OffsetMs");
		expect(source).toContain(
			"const DIAGNOSTIC_MIDPOINT_SAMPLE_INTERVAL_MS = 1000;",
		);
		expect(source).toContain(
			"captureTimestamp(`rung${rung}_midpoint_candidate`)",
		);
		expect(source).toContain(
			"const lastSnap = shard.marks.steadyStart ?? shard.marks.start;",
		);
		expect(source).toContain('phase: msg.phase ?? "unknown"');
		expect(source).not.toContain(
			"(msg.snap as unknown as { phase?: string }).phase",
		);
		expect(source).toContain("await clientOutputDone;");
		expect(source).toContain(
			"currentRung?.setConnectErrorsSample(parseConnectErrorsSample(clientStdout));",
		);
		expect(source).not.toContain("}, 100);");
		expect(source).not.toContain("const captureMidpointCandidate");
		expect(source).not.toContain("currentRung.mid();");
	});

	test("samples the generator host at every diagnostic timestamp through the same offbox SSH path", () => {
		expect(source).toContain("parseGeneratorHostSample,");
		expect(source).toContain("generatorHost: readGeneratorHostSample(),");
		const reader = source.slice(
			source.indexOf("function readGeneratorHostSample("),
			source.indexOf(
				"\n}\n",
				source.indexOf("function readGeneratorHostSample("),
			),
		);
		expect(reader).toContain("[...OFFBOX_SSH_OPTIONS, OFFBOX_SSH,");
		expect(reader).toContain("/proc/loadavg");
		expect(reader).toContain("/proc/meminfo");
		expect(reader).toContain("pgrep -x mmo-client");
		expect(reader).toContain("return null;");
	});

	test("samples per-interface counters on both hosts at every phase mark without delaying the broadcast", () => {
		expect(source).toContain("parseInterfaceSample,");
		expect(source).toContain('"cat /proc/net/dev"');
		expect(source).toContain('ethtool -S "$i" 2>/dev/null || true');
		for (const phase of ["connect", "steady", "drain", "idle"]) {
			expect(source).toContain(`captureInterfaceMarks("${phase}")`);
		}
		for (const phase of ["steady", "drain", "idle"]) {
			const broadcastAt = source.indexOf(
				`await broadcast("phase", "${phase}")`,
			);
			const captureAt = source.indexOf(`captureInterfaceMarks("${phase}")`);
			expect(broadcastAt).toBeGreaterThan(-1);
			expect(captureAt).toBeGreaterThan(broadcastAt);
		}
		const sampler = source.slice(
			source.indexOf("function sampleInterfaces("),
			source.indexOf("\n}\n", source.indexOf("function sampleInterfaces(")),
		);
		expect(sampler).toContain("execFile(");
		expect(sampler).not.toContain("execFileSync");
		expect(source).toContain(
			"serverInterface: await settleSamples(serverInterfaceSamples),",
		);
		expect(source).toContain(
			"generatorInterface: await settleSamples(generatorInterfaceSamples),",
		);
		const resultStart = source.indexOf("const result = {");
		const ratedOutput = source.slice(
			resultStart,
			source.indexOf("writeFileSync(OUT", resultStart),
		);
		expect(ratedOutput).not.toContain("serverInterface");
		expect(ratedOutput).not.toContain("generatorInterface");
	});

	test("does not execute diagnostic hooks when diagnostics are disabled", () => {
		expect(source).toContain(
			"const currentRung = DIAGNOSTIC ? captureRung(SESSIONS, SESSIONS) : null;",
		);
		expect(source).toContain("currentRung?.begin();");
		expect(source).toContain("currentRung?.end();");
		expect(source).toMatch(/if \(DIAGNOSTIC\) \{\s+shard\.lifecycle\.push/);
		expect(source).toMatch(
			/if \(DIAGNOSTIC\) \{\s+shard\.boundaryArrivedAt\.push/,
		);
	});

	test("runs the bounded Linux probe only during connect and stores runtime files in the worktree", () => {
		expect(source).toContain("SCAN_LINUX_PROBE_ENABLED");
		expect(source).toContain("SCAN_LINUX_PROBE_OUT");
		expect(source).toContain("SCAN_LINUX_PROBE_MAX_BYTES");
		expect(source).toContain("async function startLinuxProbe(");
		expect(source).toContain("async function stopLinuxProbe(");
		expect(source).toContain(
			"if (LINUX_PROBE_ENABLED) linuxProbe = await startLinuxProbe(shards);",
		);
		expect(source.indexOf("await startLinuxProbe(shards)")).toBeLessThan(
			source.indexOf("currentRung?.begin();"),
		);
		expect(source.indexOf("await startLinuxProbe(shards)")).toBeLessThan(
			source.indexOf("const activeClient = spawn("),
		);
		expect(source).toMatch(
			/if \(kind === "steady"\)[\s\S]*currentRung\?\.end\(\);[\s\S]*await stopLinuxProbe\(linuxProbe\)/,
		);
		expect(source).toContain('join(process.cwd(), ".scratch", "runtime-tmp")');
		expect(source).not.toContain('from "node:os"');
		expect(source).not.toContain("tmpdir()");
	});

	test("captures a fail-closed BPF pre-arm witness only for diagnostics before the generator", () => {
		expect(source).toContain(
			'import { countBpfMapEntries, sumPerCpuSteerStats } from "./g6-bpf-map.ts";',
		);
		expect(source).toContain('"-j", "map", "dump", "pinned", mapName');
		expect(source).toContain(
			"const bpfPreArm = DIAGNOSTIC ? captureBpfPreArm() : null;",
		);
		expect(
			source.indexOf(
				"const bpfPreArm = DIAGNOSTIC ? captureBpfPreArm() : null;",
			),
		).toBeLessThan(source.indexOf("const activeClient = spawn("));
		expect(source).toContain("if (DIAGNOSTIC && !bpfPreArm?.fresh) {");
		expect(
			source.indexOf("if (DIAGNOSTIC && !bpfPreArm?.fresh) {"),
		).toBeLessThan(source.indexOf("const activeClient = spawn("));
		expect(source).toContain("dumpBpfMap(`${PIN_DIR}/socks`)");
		expect(source).toContain("dumpBpfMap(`${PIN_DIR}/steer_stats`)");
	});

	test("defines BPF pre-arm freshness only from a recent setup receipt, populated shards, and zero steer counters", () => {
		expect(source).toContain(
			'const BPF_READY_SCHEMA = "g6-shard-bpf-ready/1";',
		);
		expect(source).toContain("const BPF_READY_MAX_AGE_MS = 60_000;");
		expect(source).toContain(
			"function nonnegativeSafeInteger(value: unknown): number | null",
		);
		expect(source).toContain("function validateBpfReadyReceipt(");
		expect(source).toContain("createdAtMs > armedAtMs");
		expect(source).toContain("armedAtMs - createdAtMs > BPF_READY_MAX_AGE_MS");
		expect(source).toMatch(
			/const fresh =\s*receiptValidation\.valid &&\s*socksEntries === SHARDS &&\s*steerStats\?\.steered === 0 &&\s*steerStats\.fallback === 0;/,
		);
		expect(source).not.toContain("socksEntries === 0");
		expect(source).toContain("rawReceipt,");
		expect(source).toContain("receiptValidation,");
		expect(source).toContain("socksEntries,");
		expect(source).toContain("steerStats,");
	});

	test("writes the BPF setup receipt atomically after slot initialization", () => {
		expect(setupSource).toContain(
			"READY_RECEIPT=${G6_BPF_READY_RECEIPT:-/var/tmp/g6-shard-bpf-ready.json}",
		);
		expect(source).toContain(
			'process.env.G6_BPF_READY_RECEIPT ?? "/var/tmp/g6-shard-bpf-ready.json"',
		);
		expect(setupSource).toContain("created_at_ns=$(date +%s%N)");
		expect(setupSource).toContain("created_at_ms=$((created_at_ns / 1000000))");
		expect(setupSource).not.toContain("%3N");
		expect(setupSource).toContain(
			'tmp_receipt="$receipt_dir/.g6-shard-bpf-ready.$$"',
		);
		expect(setupSource).toContain('"schema":"g6-shard-bpf-ready/1"');
		expect(setupSource).toContain('mv -f "$tmp_receipt" "$READY_RECEIPT"');
		expect(
			setupSource.indexOf(
				'bpftool map dump pinned "$PIN_DIR/slot_by_server_id"',
			),
		).toBeLessThan(
			setupSource.indexOf('mv -f "$tmp_receipt" "$READY_RECEIPT"'),
		);
	});

	test("emits the BPF pre-arm witness only in the diagnostic artifact", () => {
		const resultStart = source.indexOf("const result = {");
		const resultEnd = source.indexOf("writeFileSync(OUT", resultStart);
		const ratedOutput = source.slice(resultStart, resultEnd);
		expect(ratedOutput).not.toContain("bpfPreArm");

		const diagnosticStart = source.indexOf("const diagnosticResult = {");
		const diagnosticEnd = source.indexOf(
			"writeFileSync(DIAGNOSTIC_OUT",
			diagnosticStart,
		);
		const diagnosticOutput = source.slice(diagnosticStart, diagnosticEnd);
		expect(diagnosticOutput).toContain("bpfPreArm,");
	});

	test("captures a distinct post-run steering dump at stop before BPF teardown", () => {
		expect(source).toContain("SCAN_POST_RUN_STEERING_OUT");
		expect(source).toContain("capturePostRunSteering");
		expect(source).toContain("postRunSteering");
		expect(source).toContain("writeFileSync(POST_RUN_STEERING_OUT");
		expect(source).toContain("if (steerStatsSum === null) {");
		expect(source).toContain("post-run steering dump unusable");
		expect(source).toMatch(
			/else if \(kind === "stop"\) \{[\s\S]*capturePostRunSteering\(\);[\s\S]*broadcast\("stop", null\)/,
		);
		expect(source).toContain(
			"markerChain = markerChain.then(() => applyMarks(marker.kind));",
		);
		expect(source).not.toContain(
			"writeFileSync(POST_RUN_STEERING_OUT, block.T2.steerStatsRaw",
		);
	});

	test("runs the generator through bash and stops diagnostics on early client exit", () => {
		expect(source).toContain('"bash",\n\t\t\t\tOFFBOX_ENTRY_SCRIPT,');
		expect(source).toContain("let stopCurrentRung");
		expect(source).toContain("stop: () =>");
		expect(source).toContain("stopCurrentRung?.();");
	});

	test("requires an explicit remote entrypoint and refuses generator failure", () => {
		expect(source).toContain("G6_OFFBOX_ENTRY_SCRIPT must be an absolute path");
		expect(source).toContain("if (clientExit !== 0)");
		expect(source).toContain("generator exited");
	});

	test("keeps the registered movement cadence source-bound", () => {
		expect(source).not.toContain("G6_MOVE_HZ");
		expect(source).toContain("String(Math.round(1000 / MOVE_HZ))");
		expect(source).toContain("String(actionEveryNthTick())");
	});

	test("propagates and attests the resolved native-mirror mode", () => {
		expect(source).toContain("G6_EMITTER_MODE");
		expect(source).toContain("resolveEmitterMode");
		expect(source).toContain('"--emitter-mode"');
		expect(source).toContain("emitterMode");
		expect(source).toContain('schema: "g6-sharded-scan/2"');
	});

	test("plumbs the ack reflector mode from SCAN_ACK_REFLECTOR into the shard spawn, the ready check, and the rated config", () => {
		expect(source).toContain(
			"resolveAckReflectorMode(process.env.SCAN_ACK_REFLECTOR)",
		);
		expect(source).toContain('"--ack-reflector",\n\t\t\t\tACK_REFLECTOR,');
		expect(source).toContain("msg.ackReflector !== ACK_REFLECTOR");
		const resultStart = source.indexOf("const result = {");
		const ratedOutput = source.slice(
			resultStart,
			source.indexOf("writeFileSync(OUT", resultStart),
		);
		expect(ratedOutput).toContain("ackReflector: ACK_REFLECTOR,");
		const diagnosticStart = source.indexOf("const diagnosticResult = {");
		const diagnosticOutput = source.slice(
			diagnosticStart,
			source.indexOf("writeFileSync(DIAGNOSTIC_OUT", diagnosticStart),
		);
		expect(diagnosticOutput).toContain("ackReflector: ACK_REFLECTOR,");
	});

	test("plumbs the server worker count from SCAN_SERVER_WORKERS into each shard's environment, the ready check, and the rated config", () => {
		expect(source).toContain('process.env.SCAN_SERVER_WORKERS ?? "2"');
		expect(source).toContain(
			"g6-sharded-scan: SCAN_SERVER_WORKERS must be 1..8",
		);
		// The count reaches the shard as the addon's own environment variable,
		// not as a CLI flag: it has to be set before the shard process builds
		// its Tokio runtime, and both spawn branches must carry it.
		expect(source).toContain(
			"WEBTRANSPORT_NATIVE_SERVER_WORKERS: String(SERVER_WORKERS)",
		);
		// One env object, but it has to reach both spawn branches — the direct
		// one and the sudo one — or half the dispatches run the default.
		expect(source.split("env: shardEnv,").length - 1).toBe(2);
		// The shard reports what native actually built, so this is a real
		// kill gate rather than an echo of the flag we just sent.
		expect(source).toContain("msg.serverWorkers !== SERVER_WORKERS");
		const resultStart = source.indexOf("const result = {");
		const ratedOutput = source.slice(
			resultStart,
			source.indexOf("writeFileSync(OUT", resultStart),
		);
		expect(ratedOutput).toContain("serverWorkers: SERVER_WORKERS,");
		const diagnosticStart = source.indexOf("const diagnosticResult = {");
		const diagnosticOutput = source.slice(
			diagnosticStart,
			source.indexOf("writeFileSync(DIAGNOSTIC_OUT", diagnosticStart),
		);
		expect(diagnosticOutput).toContain("serverWorkers: SERVER_WORKERS,");
	});

	test("sums quinn's per-window transport counts beside rxTotal", () => {
		const sumStart = source.indexOf("const sumWindows = (");
		expect(sumStart).toBeGreaterThan(-1);
		const sum = source.slice(
			sumStart,
			source.indexOf("const shardResults", sumStart),
		);
		// The tested helper, not a local re-sum, so the missing-field refusal
		// below cannot be bypassed here.
		expect(sum).toContain("...sumWindowQuic(entries),");
		expect(source).toContain('sumWindowQuic,\n} from "./g6-artifact.ts"');
		// Warns the reader off the two windows whose deltas lose sessions.
		expect(source).toContain("Read `steady.quic` only.");
		// Fed from the per-shard window metrics delta, so the numbers are
		// windowed exactly the way rxTotal is, and tagged by shard.
		expect(source).toContain(
			"entries.push({ serverId: shard.serverId, metrics: window.metrics });",
		);
	});

	test("a shard that reported no quic fields makes the window's quic null", () => {
		const present = (over: Record<string, number> = {}) => ({
			quicSessions: 10,
			quicUdpDatagramsReceived: 500,
			quicDatagramFramesReceived: 400,
			quicPacketsLost: 3,
			...over,
		});

		const all = sumWindowQuic([
			{ serverId: 0, metrics: present() },
			{ serverId: 1, metrics: present({ quicUdpDatagramsReceived: 1 }) },
		]);
		expect(all.quicMissingShards).toEqual([]);
		expect(all.quic).toEqual({
			sessions: 20,
			udpDatagramsReceived: 501,
			datagramFramesReceived: 800,
			packetsLost: 6,
		});

		// An older addon reports none of the fields. Summing the rest would read
		// as "quinn received less", which is the wrong conclusion, so refuse.
		const partial = sumWindowQuic([
			{ serverId: 0, metrics: present() },
			{ serverId: 7, metrics: { rxTotal: 5 } },
		]);
		expect(partial.quic).toBeNull();
		expect(partial.quicMissingShards).toEqual([7]);

		// One field missing is as disqualifying as all of them.
		const oneField = sumWindowQuic([
			{
				serverId: 3,
				metrics: { ...present(), quicDatagramFramesReceived: undefined },
			},
		]);
		expect(oneField.quic).toBeNull();
		expect(oneField.quicMissingShards).toEqual([3]);

		// No shards measured nothing; it did not measure zero.
		expect(sumWindowQuic([])).toEqual({ quic: null, quicMissingShards: [] });
	});

	test("uses the tested boundary controller for fatal and post-ready failure", () => {
		expect(source).toContain("createShardBoundaryController");
		expect(source).toContain('msg.ev === "fatal"');
		expect(source).toContain("shard.boundaries.fail");
		expect(source).toContain("stopBoundaryReceived");
	});

	test("cleans up every shard when an error aborts the conductor", () => {
		expect(source).toContain("} finally {");
		expect(source).toContain("for (const shard of shards) {");
		expect(source).toContain('shard.child.kill("SIGKILL")');
	});

	test("waits for forced children to close before the conductor returns", () => {
		expect(source).toContain(
			'import { trackChildClose, waitForChildClose } from "./g6-child-lifecycle.ts"',
		);
		expect(source).toContain("trackChildClose(child)");
		expect(source).toContain("trackChildClose(activeClient)");
		expect(source).toContain("await Promise.all(");
		expect(source).toContain("waitForChildClose(shard.child)");
	});
});
