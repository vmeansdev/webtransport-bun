import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dir, "g6-sharded-scan.ts"),
	"utf8",
);
const setupSource = readFileSync(
	join(import.meta.dir, "g6-shard-bpf-setup.sh"),
	"utf8",
);

describe("g6 sharded scan source-bound configuration", () => {
	test("uses one resolved connect timeout for the client, watchdog, and artifact", () => {
		expect(source).toMatch(
			/const CONNECT_TIMEOUT_SECONDS = parsePositiveIntegerEnv\(\s*"SCAN_CONNECT_TIMEOUT_SECONDS",\s*300,?\s*\);/,
		);
		expect(source).toContain("connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS");
		expect(source).not.toContain(
			'"--connect-timeout",\n\t\t\t\t\t\tprocess.env.SCAN_CONNECT_TIMEOUT_SECONDS',
		);
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

	test("captures a fail-closed BPF pre-arm witness only for diagnostics before the generator", () => {
		expect(source).toContain(
			"function countBpfMapEntries(text: string): number | null",
		);
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
			"return entries.length > 0 ? entries.length : null;",
		);
		expect(source).toContain("let sawSteered = false;");
		expect(source).toContain("let sawFallback = false;");
		expect(source).toContain(
			"return sawSteered && sawFallback ? { steered, fallback } : null;",
		);
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
		expect(setupSource).toContain("created_at_ms=$(date +%s%3N)");
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
