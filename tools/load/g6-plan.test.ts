/**
 * Pins every number `docs/research/preregistrations/gate-g6-mmo.md` states in
 * prose to the arithmetic that is supposed to produce it.
 *
 * This suite is the reason Amendment 1 exists: §1.3 claimed 3 datagrams per
 * snapshot from an AoI figure that divides into 2. A pre-registration whose
 * arithmetic is only prose cannot be checked; this makes it checkable, off the
 * runner, before any dispatch.
 */

import { describe, expect, test } from "bun:test";
import {
	AOI_ENTITIES,
	actionEveryNthTick,
	armShape,
	DELIVERY_FLOOR,
	downstreamWireOccupancy,
	floorLagCeilingMs,
	GIGABIT,
	gateRung,
	hotspotOneWayBudgetMs,
	preflightMaxIdleRttP99Ms,
	preflightRequirements,
	REALM_LADDER,
	rttBudgetMs,
	STORM_RECONNECT_DELAY_MS,
	snapshotDatagrams,
	snapshotPpsPerSession,
	stormCohorts,
	stormWindowSec,
	wireBytes,
	wirePpsCeiling,
} from "./g6-plan.ts";

describe("latency budget (§1.6)", () => {
	test("the interaction budget leaves 50 ms for the round trip", () => {
		// 150 − 16.67 (input frame) − 60 (internet) − 16.67 (render) = 56.67,
		// floored to a whole 10 ms so the bound is never richer than the residue.
		expect(rttBudgetMs()).toBe(50);
	});

	test("the hotspot bound is one leg of that round trip", () => {
		expect(hotspotOneWayBudgetMs()).toBe(25);
	});

	test("it is not the 33.3 ms frame budget G3 and G4 use", () => {
		expect(rttBudgetMs()).not.toBeCloseTo(33.3, 1);
	});

	test("derived bounds hang off it rather than being typed in", () => {
		expect(floorLagCeilingMs()).toBe(10); // 20% of the budget
		expect(preflightMaxIdleRttP99Ms()).toBe(5); // 10% of the budget
	});
});

describe("per-session shape (§1.2–1.4)", () => {
	test("a populated AoI does not fit one datagram and splits into three", () => {
		expect(AOI_ENTITIES).toBe(100);
		expect(snapshotDatagrams()).toBe(3);
		expect(snapshotPpsPerSession()).toBe(15);
	});

	test("every 8th movement tick carries an action", () => {
		// 4 pps movement ÷ 0.5 pps action. One schedule, one lag figure.
		expect(actionEveryNthTick()).toBe(8);
	});
});

describe("aggregate shape at the gate rung (§1.5)", () => {
	const shape = armShape(5000);

	test("the gate rung is 5,000 and the ladder runs below it", () => {
		expect(gateRung()).toBe(5000);
		expect([...REALM_LADDER]).toEqual([500, 2500, 5000]);
	});

	test("the table in §1.5 is what the arithmetic produces", () => {
		expect(shape.upstreamAggregatePps).toBe(20_000);
		expect(shape.snapshotAggregatePps).toBe(75_000);
		expect(shape.ackAggregatePps).toBe(2_500);
		expect(shape.downstreamAggregatePps).toBe(77_500);
		expect(shape.serverTotalPps).toBe(97_500);
	});

	test("the batch lever converts 75,000 datagrams into 25,000 crossings", () => {
		// This is the derivation that makes the arm plausible rather than
		// hopeless: the crossing count, not the datagram count, is what the
		// originator pays.
		expect(shape.emitterCrossingsPerSec).toBe(25_000);
		expect(shape.emitterCrossingsPerSec * shape.snapshotDatagramsPerTick).toBe(
			shape.snapshotAggregatePps,
		);
	});

	test("the emitter spreads a tick over ten slices instead of one impulse", () => {
		// An all-at-once tick would offer a 15,000-packet impulse every 200 ms —
		// the egress mirror of the kernel-drop mechanism T02 attributed.
		expect(shape.sessionsPerSlice).toBe(500);
		expect(shape.datagramsPerSlice).toBe(1_500);
		expect(shape.datagramsPerSlice * 50).toBe(shape.snapshotAggregatePps);
	});

	test("the upstream payload can carry a version-3 stamp", () => {
		expect(shape.upstreamPayloadBytes).toBeGreaterThanOrEqual(48);
		expect(shape.moveIntervalMs).toBe(250);
	});

	test("lower rungs scale linearly in offered load", () => {
		expect(armShape(2500).serverTotalPps).toBe(48_750);
		expect(armShape(500).serverTotalPps).toBe(9_750);
	});
});

describe("wire arithmetic (§8, ticket 29 §3)", () => {
	test("a 1150 B payload occupies 1216 B of Ethernet", () => {
		expect(wireBytes(1150)).toBe(1216);
	});

	test("1 GbE carries ~102.8k pps at that size", () => {
		expect(wirePpsCeiling(1150, GIGABIT)).toBe(102_796);
	});

	test("the gate rung's downstream is 73% of a gigabit link", () => {
		const occ = downstreamWireOccupancy(5000, GIGABIT);
		expect(occ.offeredPps).toBe(75_000);
		expect(occ.occupancy).toBeCloseTo(0.7296, 3);
		// 1.37× headroom is the disclosed risk on R-down, not a comfortable margin.
		expect(1 / occ.occupancy).toBeCloseTo(1.371, 2);
	});

	test("2.5 GbE would remove the risk, which is why link speed is recorded", () => {
		expect(wirePpsCeiling(1150, 2.5 * GIGABIT)).toBeGreaterThan(250_000);
	});
});

describe("cable STOP requirements (§8)", () => {
	const reqs = preflightRequirements(5000);

	test("both directions are registered, at their own payload sizes", () => {
		const down = reqs.find((r) => r.name === "R-down");
		const up = reqs.find((r) => r.name === "R-up");
		expect(down).toEqual({
			name: "R-down",
			offeredPps: 75_000,
			payloadBytes: 1150,
			maxLossPct: 0.1,
			minMtuBytes: 1280,
			maxIdleRttP99Ms: 5,
		});
		expect(up).toEqual({
			name: "R-up",
			offeredPps: 20_000,
			payloadBytes: 64,
			maxLossPct: 0.1,
			minMtuBytes: 1280,
			maxIdleRttP99Ms: 5,
		});
	});

	test("the loss bound is a fifth of the end-to-end delivery budget", () => {
		const endToEndLossPct = (1 - DELIVERY_FLOOR) * 100;
		expect(reqs[0]?.maxLossPct).toBeCloseTo(endToEndLossPct / 5, 6);
	});

	test("changing the rung moves the requirement with it", () => {
		// The point of deriving rather than transcribing: the STOP cannot be left
		// checking a rate the arm no longer offers.
		expect(preflightRequirements(2500)[0]?.offeredPps).toBe(37_500);
	});
});

describe("storm shape (§1.8, §5.4)", () => {
	test("cohorts are the 20% partial outage and the whole-realm restart", () => {
		expect(stormCohorts(5000)).toEqual([1000, 5000]);
	});

	test("the storm window is twice the shipped idle timeout, not a run figure", () => {
		expect(stormWindowSec()).toBe(120);
		expect(STORM_RECONNECT_DELAY_MS).toBe(1000);
	});
});
