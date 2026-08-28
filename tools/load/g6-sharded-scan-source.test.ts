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
		expect(source).toContain(
			"perShardUdp[shard.serverId] = readPerProcessUdpSockets(shard.child.pid!);",
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
			"const lastSnap = shard.marks.steadyStart ?? shard.marks.start;",
		);
		expect(source).toContain("await clientOutputDone;");
		expect(source).toContain(
			"currentRung?.setConnectErrorsSample(parseConnectErrorsSample(clientStdout));",
		);
		expect(source).not.toContain("}, 100);");
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

	test("keeps the registered movement cadence source-bound", () => {
		expect(source).not.toContain("G6_MOVE_HZ");
		expect(source).toContain("String(Math.round(1000 / MOVE_HZ))");
		expect(source).toContain("String(actionEveryNthTick())");
	});
});
