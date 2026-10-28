import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dir, "g6-sharded-scan.ts"),
	"utf8",
);

describe("g6 sharded scan: arms wiring", () => {
	test("the arm is resolved once from the environment and steady stays the default", () => {
		expect(source).toContain(
			"const ARMS = resolveArmsConfig(process.env, {\n\tshards: SHARDS,\n\tsessions: SESSIONS,\n\tactiveSessions: WORKLOAD_ACTIVE_SESSIONS,\n});",
		);
		// The steady cell's watchdog and fan-out script are the old ones.
		expect(source).toMatch(
			/const generatorDeadlineSec =\s*ARMS\.arm === "steady"\s*\?\s*deadlineSec/,
		);
		expect(source).toMatch(
			/precheck === null\s*\?\s*ownedFanoutScript\(clientPlans\.map\(generatorArgsFor\)\)/,
		);
		expect(source).toContain(
			"...(precheck === null ? {} : { arms: buildArmsResult() }),",
		);
	});

	test("realm processes gain the arm's flags after their registered argv", () => {
		const realm = source.slice(
			source.indexOf("const clientArgsFor ="),
			source.indexOf("console.log(", source.indexOf("const clientArgsFor =")),
		);
		const barrierAt = realm.indexOf('"--phase-barrier-timeout-ms"');
		const armsAt = realm.indexOf("...realmArmsArgs(ARMS, {");
		expect(barrierAt).toBeGreaterThan(-1);
		expect(armsAt).toBeGreaterThan(barrierAt);
	});

	test("arms cells always fan out, pre-checks and raid processes in the same group", () => {
		expect(source).toMatch(
			/\(GENERATOR_WORK_OWNER !== null && CLIENT_PROCESSES > 1\) \|\|\s*precheck !== null/,
		);
		expect(source).toContain(
			"const armsMainArgvs = [...clientPlans.map(generatorArgsFor), ...raidArgvs];",
		);
		expect(source).toContain(
			'forwarder: armsEntryArgv("g6-server", precheck.forwarder),',
		);
		expect(source).toContain("[`bash -c ${shellQuote(fanoutScript)}`]");
	});

	test("the sever marker sets a server-clock instant and arms the storm window timers", () => {
		expect(source).toMatch(
			/\} else if \(kind === "sever"\) \{\s*await armsSever\(\);/,
		);
		expect(source).toContain(
			'const snaps = await broadcast("phase", "sever", { severAtMs });',
		);
		// Steering is dumped immediately before each storm-window boundary.
		expect(source).toMatch(
			/await at\(ARMS\.stormReconnectDelayMs\);\s*armsRun\.steerStart = captureSteer\(\);\s*armsRun\.stormStartAtMs = Date\.now\(\);\s*await broadcastStormBoundary\("storm"\);/,
		);
		expect(source).toMatch(
			/armsRun\.steerEnd = captureSteer\(\);\s*armsRun\.stormEndAtMs = Date\.now\(\);\s*await broadcastStormBoundary\("post-storm"\);/,
		);
		// The idle boundary never overtakes the storm window's close, and the
		// steadyDrain window keeps the sever as its end.
		expect(source).toMatch(
			/\} else if \(kind === "idle"\) \{\s*if \(armsRun\.stormEnd !== null\) await armsRun\.stormEnd;/,
		);
		expect(source).toContain("shard.marks.drainEnd ??= snap;");
		// The client's own storm flips are recorded, never broadcast.
		expect(source).toContain("armsRun.clientMarkers[kind] = Date.now();");
	});

	test("arms boundaries skip the native send-path parse but keep the echo", () => {
		expect(source).toMatch(
			/if \(msg\.arms !== undefined\)\s*shard\.armsEchoes\[msg\.phase \?\? "unknown"\] = msg\.arms;/,
		);
		expect(source).toContain("if (!isArmsPhase(msg.phase))");
	});
});
