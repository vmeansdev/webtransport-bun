import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	acceptSeriesPerSecond,
	applyArmsPhase,
	armsEcho,
	emitterPhaseFor,
	freshShardArmsState,
	isArmsPhase,
	isShardPhase,
	recordStormSample,
	STORM_SAMPLES_MAX,
	stormSample,
} from "./g6-shard-arms.ts";

const shardSource = readFileSync(
	join(import.meta.dir, "g6-shard-server.ts"),
	"utf8",
);

describe("g6 shard arms state", () => {
	test("accepts the steady phases and the storm phases, nothing else", () => {
		for (const phase of ["connect", "steady", "drain", "idle"])
			expect(isShardPhase(phase)).toBe(true);
		for (const phase of ["sever", "storm", "post-storm"]) {
			expect(isShardPhase(phase)).toBe(true);
			expect(isArmsPhase(phase)).toBe(true);
		}
		expect(isArmsPhase("steady")).toBe(false);
		for (const phase of ["stop", "hotspot", "", null, 3])
			expect(isShardPhase(phase)).toBe(false);
	});

	test("sever keeps the emitter where it was; the storm phases drive it", () => {
		expect(emitterPhaseFor("sever", "drain")).toBe("drain");
		expect(emitterPhaseFor("storm", "drain")).toBe("storm");
		expect(emitterPhaseFor("post-storm", "storm")).toBe("post-storm");
		expect(emitterPhaseFor("idle", "post-storm")).toBe("idle");
	});

	test("the server-clock sever instant is required, single, and precedes the storm phases", () => {
		const state = freshShardArmsState();
		expect(() => applyArmsPhase(state, { phase: "storm" })).toThrow(
			"storm before sever",
		);
		expect(() => applyArmsPhase(state, { phase: "sever" })).toThrow(
			"severAtMs",
		);
		expect(() =>
			applyArmsPhase(state, { phase: "sever", severAtMs: 1.5 }),
		).toThrow("severAtMs");
		applyArmsPhase(state, { phase: "steady" });
		expect(state.severAtMs).toBeNull();
		applyArmsPhase(state, { phase: "sever", severAtMs: 1_000_000 });
		expect(state.severAtMs).toBe(1_000_000);
		expect(() =>
			applyArmsPhase(state, { phase: "sever", severAtMs: 1_000_001 }),
		).toThrow("duplicate sever");
		applyArmsPhase(state, { phase: "storm" });
		applyArmsPhase(state, { phase: "post-storm" });
	});

	test("admission samples read the addon's own counters and are bounded", () => {
		const sample = stormSample(5, {
			sessionsActive: 10,
			handshakesInFlight: 2,
			limitExceededCount: 0,
			rateLimitedCount: 1,
			other: 9,
		});
		expect(sample).toEqual({
			tMs: 5,
			sessionsActive: 10,
			handshakesInFlight: 2,
			limitExceededCount: 0,
			rateLimitedCount: 1,
		});
		expect(stormSample(6, {}).handshakesInFlight).toBeNull();
		const state = freshShardArmsState();
		for (let i = 0; i < STORM_SAMPLES_MAX + 5; i += 1)
			recordStormSample(state, sample);
		expect(state.stormSamples.length).toBe(STORM_SAMPLES_MAX);
	});

	test("the echo counts post-sever accepts and names raid members by token", () => {
		const state = freshShardArmsState();
		state.raidMemberTokens.push(3, 1, 2);
		const kinds = { player: 5, raid: 3, publisher: 1 };
		const before = armsEcho({
			state,
			acceptSeries: [1000, 1500, 2500],
			sessionKinds: kinds,
			full: false,
		});
		expect(before).toEqual({
			severAtMs: null,
			sessionKinds: kinds,
			raidMembers: { count: 3, tokens: [1, 2, 3] },
			acceptsTotal: 3,
			acceptsAfterSever: 0,
		});
		applyArmsPhase(state, { phase: "sever", severAtMs: 1500 });
		const full = armsEcho({
			state,
			acceptSeries: [1000, 1500, 2500, 2600, 4100],
			sessionKinds: kinds,
			full: true,
		});
		expect(full.acceptsAfterSever).toBe(3);
		expect(full.acceptMsAfterSever).toEqual([2500, 2600, 4100]);
		expect(full.acceptSeriesPerSecond).toEqual([
			{ tMs: 1000, accepts: 2 },
			{ tMs: 2000, accepts: 2 },
			{ tMs: 4000, accepts: 1 },
		]);
		expect(full.stormSamples).toEqual([]);
		expect(acceptSeriesPerSecond([])).toEqual([]);
	});

	test("the shard server wires the arms state without changing the steady path", () => {
		expect(shardSource).toContain("severAtMs: () => arms.severAtMs,");
		expect(shardSource).not.toContain("severAtMs: () => null,");
		expect(shardSource).toContain(
			"applyArmsPhase(arms, { phase: msg.phase, severAtMs: msg.severAtMs });",
		);
		// Arms boundaries never cut a native send-path phase.
		expect(shardSource).toContain(
			"isArmsPhase(msg.phase) ? undefined : msg.phase,",
		);
		expect(shardSource).toContain(
			"phaseState.current = emitterPhaseFor(msg.phase, phaseState.current);",
		);
		expect(shardSource.split("arms: armsEchoNow(").length - 1).toBe(2);
		expect(shardSource).toContain("arms: armsEchoNow(true),");
		expect(shardSource).toContain("g6SessionKinds: sessionKinds(),");
	});
});
