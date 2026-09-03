import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dir, "g6-shard-server.ts"),
	"utf8",
);

describe("G6 shard server source-bound configuration", () => {
	test("bounds the server ID by the BPF build cap, not a fixed 16", () => {
		expect(source).toContain(
			"if (!Number.isInteger(serverId) || serverId < 1 || serverId > 64) {",
		);
		expect(source).toContain(
			'throw new Error("g6-shard-server: --server-id must be 1..64");',
		);
		expect(source).not.toContain("serverId > 16");
		expect(source).not.toContain("must be 1..16");
	}, 15_000);

	test("attests a coherent explicit emitter mode", () => {
		expect(source).toContain('requireArg("emitter-mode")');
		expect(source).toContain("resolveEmitterMode");
		expect(source).toContain("emitterMode");
		expect(source).toContain("server.sendDatagramMirror");
	}, 15_000);

	test("installs the G6 reflector rule only in native mode and reconciles its counters at every boundary", () => {
		expect(source).toContain(
			'const ackReflector = resolveAckReflectorMode(requireArg("ack-reflector"));',
		);
		expect(source).toContain(
			'if (ackReflector === "native")\n\t\tserver.setDatagramReflector(G6_V3_ACK_REFLECTOR_RULE);',
		);
		expect(source).toContain("reflectorCounters = reconcileReflectorCounters(");
		expect(source).toContain("ackReflector,\n");
	}, 15_000);

	test("reports the worker count native actually built, not the one it was asked for", () => {
		expect(source).toContain("server.serverWorkerThreads()");
		expect(source).toContain("serverWorkers,\n");
	}, 15_000);

	test("reports the recv runtime native actually built, not the one it was asked for", () => {
		expect(source).toContain("server.serverRecvRuntime()");
		expect(source).toContain("serverRecvRuntime,\n");
	}, 15_000);

	test("reports the ack cadence native actually built, not the one it was asked for", () => {
		expect(source).toContain("server.serverAckCadence()");
		expect(source).toContain("serverAckCadence,\n");
	}, 15_000);

	test("uses the tested fatal scheduler to emit a fatal event", () => {
		expect(source).toContain("createFatalEmitterScheduler");
		expect(source).toContain('ev: "fatal"');
		expect(source).toContain("process.exit(1)");
	}, 15_000);

	test("passes the whole addon snapshot through the boundary, unfiltered", () => {
		// The quinn aggregate fields (quicUdpDatagramsReceived and friends)
		// reach the scan JSON only because this spread whitelists nothing.
		expect(source).toContain(
			"...(metrics as unknown as Record<string, unknown>),",
		);
	}, 15_000);

	test("attaches the parsed pacer stats to every boundary message, not the snapshot", () => {
		// The pacer's priority disclosure lives only in __pacerStatsJson (a
		// JSON string, "{}" when the pacer is off). It rides the boundary
		// message so the scan can persist it outside deltaRecord; the
		// snapshot itself stays as the artifact layer expects it.
		expect(source).toContain("server.__pacerStatsJson?.()");
		expect(source).toContain("const pacerStats = ():");
		// Both boundary emits (phase and stop) carry it; nothing else does.
		expect(source.split("pacerStats: pacerStats()").length - 1).toBe(2);
		expect(source.split('ev: "boundary"').length - 1).toBe(2);
	}, 15_000);

	test("surfaces native warnings and errors on stderr with their full text", () => {
		// Without a log hook the addon emits nothing, and without debug the
		// text is redacted to "native warning (redacted)": a session the server
		// itself closes during the handshake (r101's H3 EXCESSIVE_LOAD at 20k)
		// left no server-side trace. The shard now writes warn and error
		// events verbatim to stderr, which the scan persists per shard.
		expect(source).toContain("debug: true,");
		expect(source).toContain("log: (event) => {");
		expect(source).toContain(
			'if (event.level !== "warn" && event.level !== "error") return;',
		);
		expect(source).toContain("process.stderr.write(");
	}, 15_000);

	test("echoes the requested pacer priority knobs in the ready message", () => {
		expect(source).toContain(
			"pacerNice: process.env.WEBTRANSPORT_PACER_NICE ?? null,",
		);
		expect(source).toContain(
			"pacerSched: process.env.WEBTRANSPORT_PACER_SCHED ?? null,",
		);
	}, 15_000);
});
