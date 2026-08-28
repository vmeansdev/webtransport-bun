import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dir, "g6-sharded-scan.ts"),
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

	test("runs the generator through bash and stops diagnostics on early client exit", () => {
		expect(source).toContain('"bash",\n\t\t\t\tOFFBOX_ENTRY_SCRIPT,');
		expect(source).toContain("let stopCurrentRung");
		expect(source).toContain("stop: () =>");
		expect(source).toContain("stopCurrentRung?.();");
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
