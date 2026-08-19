/**
 * Pins every number `docs/research/preregistrations/gate-g9-churn.md` states in
 * prose to the arithmetic that produces it. If a scenario or configuration
 * constant moves, exactly one of these fails and names the paragraph that has
 * gone stale — which is the failure G6 caught before dispatch and G3 did not.
 */

import { describe, expect, test } from "bun:test";
import {
	ARRIVAL_SHARDS,
	admissionCeilingPerSec,
	admissionSaturationLatencyMs,
	BASE_SESSIONS,
	baseAggregatePps,
	baseRttBarMs,
	cells,
	churnConcurrencyBudget,
	cycleLifetimeCeilingSec,
	derivedHandshakeBarMs,
	exchangeBytesPerSec,
	gateCellId,
	gateRungPerSec,
	generatorAbortCeiling,
	handshakeBarMs,
	LIMITER_BAND,
	ladder,
	limiterExpectedAdmits,
	pacerResidualFraction,
	SHIPPED_DOCUMENTED_HANDSHAKE_TARGET_MS,
	SHIPPED_MAX_HANDSHAKES_IN_FLIGHT,
	SHIPPED_STREAMS_PER_SEC_PER_IP,
	SOURCE_ENDPOINTS,
	scheduleLagBoundMs,
	sessionsPerDay,
	shardIntervalMs,
	streamOpensPerSecPerIp,
	tokenBucketCeilingPerSec,
	undividedSetupBudgetMs,
} from "./g9-plan.ts";

describe("§1.4 the handshake bar", () => {
	test("the undivided setup budget is 620 ms", () => {
		expect(undividedSetupBudgetMs()).toBe(620);
	});

	test("the tail margin produces 310 ms, floored to a whole 10", () => {
		expect(derivedHandshakeBarMs()).toBe(310);
	});

	test("the registered bar is the tighter of the two sources", () => {
		expect(handshakeBarMs()).toBe(300);
		expect(handshakeBarMs()).toBeLessThanOrEqual(derivedHandshakeBarMs());
		expect(handshakeBarMs()).toBeLessThanOrEqual(
			SHIPPED_DOCUMENTED_HANDSHAKE_TARGET_MS,
		);
	});

	test("the two derivations agree within 3.4%, which is a coincidence and not corroboration", () => {
		const spread =
			Math.abs(
				derivedHandshakeBarMs() - SHIPPED_DOCUMENTED_HANDSHAKE_TARGET_MS,
			) / SHIPPED_DOCUMENTED_HANDSHAKE_TARGET_MS;
		expect(spread).toBeCloseTo(0.0333, 4);
	});
});

describe("§1.5 the base bar", () => {
	test("the base round-trip bar is 40 ms", () => {
		expect(baseRttBarMs()).toBe(40);
	});

	test("it is tighter than G6's 50 ms ability bound, and independently derived", () => {
		expect(baseRttBarMs()).toBeLessThan(50);
	});
});

describe("§1.6 the ceilings and the ladder", () => {
	test("the token bucket over 64 endpoints admits 1,280/s sustained", () => {
		expect(tokenBucketCeilingPerSec()).toBe(1280);
	});

	test("the admission gate at the bar admits 666.7/s", () => {
		expect(admissionCeilingPerSec()).toBeCloseTo(666.667, 2);
	});

	test("the admission gate binds, not the token bucket", () => {
		expect(admissionCeilingPerSec()).toBeLessThan(tokenBucketCeilingPerSec());
	});

	test("the gate rung is 600/s — rounded down, never richer than its derivation", () => {
		expect(gateRungPerSec()).toBe(600);
		expect(gateRungPerSec()).toBeLessThanOrEqual(admissionCeilingPerSec());
	});

	test("the ladder is 75 / 150 / 300 / 600", () => {
		expect(ladder()).toEqual([75, 150, 300, 600]);
	});

	test("the churn concurrency budget is 1,400 sessions", () => {
		expect(churnConcurrencyBudget()).toBe(1400);
	});

	test("the cycle-lifetime ceiling at the gate rung is 2.333 s", () => {
		expect(cycleLifetimeCeilingSec(600)).toBeCloseTo(2.3333, 3);
	});

	test("the generator's safety abort is 5,600 in-flight cycles", () => {
		expect(generatorAbortCeiling()).toBe(5600);
	});

	test("P3's admission-saturation latency at the gate rung is 333 ms", () => {
		expect(admissionSaturationLatencyMs(600)).toBeCloseTo(333.33, 1);
	});

	test("the gate rung is 47% of the token-bucket ceiling, which is why C2 expects no limiter", () => {
		expect(gateRungPerSec() / tokenBucketCeilingPerSec()).toBeCloseTo(0.469, 2);
	});

	test("the stream bucket is checked and not binding — a 21x margin", () => {
		const perIp = streamOpensPerSecPerIp(gateRungPerSec());
		expect(perIp).toBeCloseTo(9.375, 3);
		expect(SHIPPED_STREAMS_PER_SEC_PER_IP / perIp).toBeGreaterThan(20);
	});

	test("the gate rung is 51.8 million sessions a day", () => {
		expect(sessionsPerDay(gateRungPerSec())).toBe(51_840_000);
	});
});

describe("§1.7 arrival shards", () => {
	test("the per-shard interval at the gate rung is 13.33 ms", () => {
		expect(shardIntervalMs(600)).toBeCloseTo(13.333, 3);
	});

	test("S=8 is the smallest power of two clearing 10x the Mac's 871 us mean lag", () => {
		const macMeanLagMs = 0.871;
		expect(shardIntervalMs(600, ARRIVAL_SHARDS) / macMeanLagMs).toBeGreaterThan(
			10,
		);
		// Sharding *widens* the per-shard interval, so the binding direction is
		// downward: the power of two below 8 is the one that must fail, and does.
		// That is what makes 8 derived rather than chosen.
		expect(shardIntervalMs(600, 4) / macMeanLagMs).toBeLessThan(10);
		expect(ARRIVAL_SHARDS).toBe(8);
	});

	test("more shards only ever widen the interval, which is why the bound is one-sided", () => {
		expect(shardIntervalMs(600, 16)).toBeGreaterThan(
			shardIntervalMs(600, ARRIVAL_SHARDS),
		);
	});

	test("a 40.6 ms oversleep costs 3 arrivals on one shard, not 24 globally", () => {
		const macMaxLagSec = 0.0406;
		expect(Math.floor((600 / ARRIVAL_SHARDS) * macMaxLagSec)).toBe(3);
		expect(Math.floor(600 * macMaxLagSec)).toBe(24);
	});

	test("V-F's bound is one tenth of a shard interval", () => {
		expect(scheduleLagBoundMs()).toBeCloseTo(1.3333, 3);
	});

	test("the pacer's residual over the graded window is 0.011%", () => {
		expect(pacerResidualFraction() * 100).toBeCloseTo(0.0111, 4);
	});

	test("the residual is an order under C2's 1% band", () => {
		expect(pacerResidualFraction()).toBeLessThan(0.01 / 10);
	});
});

describe("§2 the cells", () => {
	const all = cells();

	test("seven cells, and the gate cell is L-600 with two repeats", () => {
		expect(all).toHaveLength(7);
		const gate = all.find((c) => c.role === "gate");
		expect(gate?.id).toBe("L-600");
		expect(gate?.repeats).toBe(2);
		expect(gateCellId()).toBe("L-600");
	});

	test("every ladder cell carries the base; C-only and LIM do not", () => {
		for (const c of all) {
			if (c.id.startsWith("L-")) expect(c.baseSessions).toBe(BASE_SESSIONS);
		}
		expect(all.find((c) => c.id === "C-only")?.baseSessions).toBe(0);
		expect(all.find((c) => c.id === "LIM")?.baseSessions).toBe(0);
		expect(all.find((c) => c.id === "B-only")?.churnRatePerSec).toBe(0);
	});

	test("LIM is the only cell offering from a single source IP", () => {
		const single = all.filter((c) => c.sourceEndpoints === 1);
		expect(single.map((c) => c.id)).toEqual(["LIM"]);
		expect(all.find((c) => c.id === "LIM")?.role).toBe("config-fidelity");
	});

	test("every other cell uses the full endpoint pool", () => {
		for (const c of all) {
			if (c.id !== "LIM") expect(c.sourceEndpoints).toBe(SOURCE_ENDPOINTS);
		}
	});

	test("§2.3: the shipped bucket admits 1,240 over LIM's window, band +/-5%", () => {
		expect(limiterExpectedAdmits()).toBe(1240);
		expect(limiterExpectedAdmits() * (1 - LIMITER_BAND)).toBe(1178);
		expect(limiterExpectedAdmits() * (1 + LIMITER_BAND)).toBe(1302);
	});
});

describe("§1.2/§1.3 the load is not a throughput result in disguise", () => {
	test("the base aggregates 2,000/s, which sits inside G1's PASSED envelope", () => {
		expect(baseAggregatePps()).toBe(2000);
	});

	test("the exchange contributes 0.77 MB/s at the gate rung", () => {
		expect(exchangeBytesPerSec(600)).toBe(768_000);
	});

	test("that is three orders under the settled ~103k/s ingest ceiling", () => {
		const exchangePpsUpperBound = 600 * 2;
		expect(exchangePpsUpperBound).toBeLessThan(103_000 / 50);
	});
});

describe("the admission gate is the server's own mechanism, and the arithmetic says so", () => {
	test("Little's law at the gate reproduces the ceiling from the bar", () => {
		const bar = handshakeBarMs() / 1000;
		expect(gateRungPerSec() * bar).toBeLessThanOrEqual(
			SHIPPED_MAX_HANDSHAKES_IN_FLIGHT,
		);
	});

	test("one rung up would exceed it, which is why 600 is the top", () => {
		expect(700 * (handshakeBarMs() / 1000)).toBeGreaterThan(
			SHIPPED_MAX_HANDSHAKES_IN_FLIGHT,
		);
	});
});
