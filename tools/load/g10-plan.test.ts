import { describe, expect, test } from "bun:test";
import {
	A2_CHUNK_TARGETS,
	armShape,
	armStallFloors,
	bestCostNs,
	broadcastSerializationMs,
	DATAGRAM_MIRROR_MAX,
	DELIVERY_FLOOR,
	derivedLinkLossBudgetPct,
	EMITTER_COST_NS_PER_TARGET,
	egressPps,
	emitterFloorMs,
	expectedLoopLagTicks,
	fleetFitsMirrorCap,
	fleetSitsOnMirrorCap,
	GATE_RATE,
	GIGABIT,
	JS_STALL_BUDGET_MS,
	LOOP_LAG_SAMPLE_MS,
	MESSAGE_PAYLOAD_BYTES,
	MIRROR_GAIN_PREDICTION_MS,
	maxMirrorGainAsWireFraction,
	maxMirrorSpreadGainMs,
	mirrorCapAgreesWithProduct,
	mirrorStallFloorMs,
	preflightMaxIdleRttP99Ms,
	preflightRequirements,
	probeFloorLagCeilingMs,
	probeIndices,
	RATE_EXCLUDED,
	RATE_LADDER,
	RTT_BOUND_MS,
	rateFitsWire,
	recordBytes,
	rttResidueMs,
	SUBSCRIBERS,
	sinkPrecheckPps,
	spreadBoundMs,
	spreadClauseApplies,
	spreadCrossoverRate,
	spreadFloorCeilingMs,
	spreadHeadroom,
	stallBudgetTargets,
	TWO_POINT_FIVE_GIGABIT,
	VERDICT_ARM,
	wireBytes,
	wireOccupancy,
	wirePpsCeiling,
	worstCostNs,
} from "./g10-plan";

/**
 * These tests are the G6-amendment-1 guard: every figure the pre-registration
 * prints in §1 is asserted here against the arithmetic that is supposed to
 * produce it. A page number that stops matching its derivation fails a test
 * instead of surviving to a run.
 */

describe("§1.2 — the message", () => {
	test("200 B carries the stamp and a real record", () => {
		expect(MESSAGE_PAYLOAD_BYTES).toBe(200);
		expect(recordBytes()).toBe(152);
	});
});

describe("§1.3 — the wire", () => {
	test("wire bytes match ticket 29 §3 at both payloads on the page", () => {
		expect(wireBytes(200)).toBe(266);
		expect(wireBytes(1150)).toBe(1216);
	});

	test("the 1 GbE ceilings the page prints", () => {
		expect(wirePpsCeiling(200, GIGABIT)).toBe(469_924);
		expect(wirePpsCeiling(1150, GIGABIT)).toBe(102_796);
	});

	test("the 2.5 GbE ceilings the page prints", () => {
		expect(wirePpsCeiling(200, TWO_POINT_FIVE_GIGABIT)).toBe(1_174_812);
		expect(wirePpsCeiling(1150, TWO_POINT_FIVE_GIGABIT)).toBe(256_990);
	});

	test("200 B buys 4.57x the packet rate of 1150 B", () => {
		const ratio = wirePpsCeiling(200) / wirePpsCeiling(1150);
		expect(ratio).toBeGreaterThan(4.56);
		expect(ratio).toBeLessThan(4.58);
	});
});

describe("§1.5 — the serialization floor", () => {
	test("21.28 ms, exactly as the page derives it", () => {
		expect(broadcastSerializationMs()).toBeCloseTo(21.28, 6);
	});

	test("the rejected 5 ms fairness bound needs 4.3x this link", () => {
		// The page's claim: sub-5-ms fan-out at this shape needs >= 4.3 GbE.
		const needed = (broadcastSerializationMs() / 5) * GIGABIT;
		expect(needed / GIGABIT).toBeGreaterThan(4.25);
		expect(needed / GIGABIT).toBeLessThan(4.3);
		expect(
			broadcastSerializationMs(SUBSCRIBERS, MESSAGE_PAYLOAD_BYTES, needed),
		).toBeCloseTo(5, 6);
	});
});

describe("§1.4 — the ladder", () => {
	test("the rungs and the gate rung are what the page registers", () => {
		expect([...RATE_LADDER]).toEqual([1, 5, 20]);
		expect(GATE_RATE).toBe(5);
		expect(RATE_LADDER).toContain(GATE_RATE);
	});

	test("egress and occupancy per rung reproduce the page's table", () => {
		expect(egressPps(1)).toBe(10_000);
		expect(egressPps(5)).toBe(50_000);
		expect(egressPps(20)).toBe(200_000);
		expect(wireOccupancy(1) * 100).toBeCloseTo(2.128, 2);
		expect(wireOccupancy(5) * 100).toBeCloseTo(10.64, 2);
		expect(wireOccupancy(20) * 100).toBeCloseTo(42.56, 2);
	});

	test("every rung that runs fits the wire", () => {
		for (const rate of RATE_LADDER) expect(rateFitsWire(rate)).toBe(true);
	});

	test("R = 50 is excluded because it exceeds the wire", () => {
		expect([...RATE_EXCLUDED]).toEqual([50]);
		expect(egressPps(50)).toBe(500_000);
		expect(wireOccupancy(50) * 100).toBeCloseTo(106.4, 1);
		expect(rateFitsWire(50)).toBe(false);
	});

	test("2.5 GbE would admit R = 50 — the page's only claim about it", () => {
		expect(rateFitsWire(50, SUBSCRIBERS, 200, TWO_POINT_FIVE_GIGABIT)).toBe(
			true,
		);
		expect(
			wireOccupancy(50, SUBSCRIBERS, 200, TWO_POINT_FIVE_GIGABIT) * 100,
		).toBeCloseTo(42.56, 1);
	});
});

describe("§1.6 — the spread bound", () => {
	test("250/R, per rung", () => {
		expect(spreadBoundMs(1)).toBe(250);
		expect(spreadBoundMs(5)).toBe(50);
		expect(spreadBoundMs(20)).toBe(12.5);
	});

	test("the clause applies at R = 1 and R = 5 and not at R = 20", () => {
		expect(spreadClauseApplies(1)).toBe(true);
		expect(spreadClauseApplies(5)).toBe(true);
		expect(spreadClauseApplies(20)).toBe(false);
	});

	test("headroom figures the page prints", () => {
		expect(spreadHeadroom(1)).toBeCloseTo(11.75, 2);
		expect(spreadHeadroom(5)).toBeCloseTo(2.35, 2);
		expect(spreadHeadroom(20)).toBeCloseTo(0.587, 2);
	});

	test("the crossover is R < 11.75", () => {
		expect(spreadCrossoverRate()).toBeCloseTo(11.75, 2);
		expect(spreadClauseApplies(11)).toBe(true);
		expect(spreadClauseApplies(12)).toBe(false);
	});
});

describe("§1.7 — the RTT budget", () => {
	test("the residue is 23.3 ms and the registered bound rounds it down", () => {
		expect(rttResidueMs()).toBeCloseTo(23.333, 3);
		expect(RTT_BOUND_MS).toBe(20);
		expect(RTT_BOUND_MS).toBeLessThan(rttResidueMs());
	});

	test("it is not G6's 50 ms and not G3/G4's 33.3 ms", () => {
		expect(RTT_BOUND_MS).not.toBe(50);
		expect(RTT_BOUND_MS).not.toBe(33.3);
	});
});

describe("§1.9 — the rung's total load", () => {
	test("the gate rung's table", () => {
		const shape = armShape(GATE_RATE);
		expect(shape.broadcastEgressPps).toBe(50_000);
		expect(shape.probeUpPps).toBe(200);
		expect(shape.probeDownPps).toBe(200);
		expect(shape.publisherUpPps).toBe(5);
		expect(shape.serverInPps).toBe(205);
		expect(shape.serverOutPps).toBe(50_200);
		expect(shape.serverTotalPps).toBe(50_405);
	});

	test("the gate rung is 3.07x the highest valid stamped egress (K6)", () => {
		const k6ForwardEgress = 16_300;
		const ratio = armShape(GATE_RATE).broadcastEgressPps / k6ForwardEgress;
		expect(ratio).toBeGreaterThan(3.0);
		expect(ratio).toBeLessThan(3.1);
	});

	test("the probe cohort spans the fan-out order, head to tail", () => {
		const idx = probeIndices();
		expect(idx).toHaveLength(100);
		expect(idx[0]).toBe(0);
		expect(idx[99]).toBe(9900);
		expect(new Set(idx).size).toBe(100);
		// evenly spaced, so no half of the fan-out is unsampled
		for (let i = 1; i < idx.length; i += 1) {
			expect((idx[i] as number) - (idx[i - 1] as number)).toBe(100);
		}
	});

	test("armShape carries the spread facts for the rung it describes", () => {
		expect(armShape(20).spreadClauseApplies).toBe(false);
		expect(armShape(5).spreadClauseApplies).toBe(true);
		expect(armShape(5).serializationMs).toBeCloseTo(21.28, 6);
	});
});

describe("§1.10 — the provenance ledger's cost entries", () => {
	test("the landed emitter floor is 3.31-3.43 ms at 10k targets", () => {
		const floors = EMITTER_COST_NS_PER_TARGET.landedTrySend.map((ns) =>
			emitterFloorMs(ns),
		);
		expect(Math.min(...floors)).toBeCloseTo(3.31, 2);
		expect(Math.max(...floors)).toBeCloseTo(3.43, 2);
	});

	test("the mirror shapes' floors, as the page prints them", () => {
		expect(emitterFloorMs(bestCostNs("mirrorGroupHandle"))).toBeCloseTo(
			0.11,
			6,
		);
		expect(emitterFloorMs(worstCostNs("mirrorStringTargets"))).toBeCloseTo(
			0.86,
			6,
		);
		expect(emitterFloorMs(worstCostNs("mirrorUint32Targets"))).toBeCloseTo(
			0.3,
			6,
		);
	});

	test("the landed emitter is 15.6-16.1% of the wire floor", () => {
		const wire = broadcastSerializationMs();
		const lo = emitterFloorMs(bestCostNs("landedTrySend")) / wire;
		const hi = emitterFloorMs(worstCostNs("landedTrySend")) / wire;
		expect(lo * 100).toBeCloseTo(15.6, 1);
		expect(hi * 100).toBeCloseTo(16.1, 1);
	});

	test("the NIC dominates the JS emitter by 6.2x", () => {
		const ratio =
			broadcastSerializationMs() / emitterFloorMs(worstCostNs("landedTrySend"));
		expect(ratio).toBeGreaterThan(6.1);
		expect(ratio).toBeLessThan(6.3);
	});

	test("at 5 Hz the emitter holds the loop 1.7% of wall clock", () => {
		const perSecond = emitterFloorMs(worstCostNs("landedTrySend")) * GATE_RATE;
		expect((perSecond / 1000) * 100).toBeCloseTo(1.7, 1);
	});

	test("P3's ceiling on the lever is 3.32 ms, inside the 4 ms prediction", () => {
		expect(maxMirrorSpreadGainMs()).toBeCloseTo(3.32, 2);
		expect(maxMirrorSpreadGainMs()).toBeLessThan(MIRROR_GAIN_PREDICTION_MS);
		expect(maxMirrorGainAsWireFraction() * 100).toBeLessThan(20);
		expect(maxMirrorGainAsWireFraction() * 100).toBeCloseTo(15.6, 1);
	});

	test("the retired promise path is 8.1-8.7x the landed one and is never a comparand", () => {
		const ratio = worstCostNs("retiredPromise") / worstCostNs("landedTrySend");
		expect(ratio).toBeGreaterThan(8);
		expect(ratio).toBeLessThan(10);
	});
});

describe("§7 / §11a — the pre-check thresholds", () => {
	test("V-S drives 75,000 pps", () => {
		expect(sinkPrecheckPps()).toBe(75_000);
	});

	test("V-SP's loopback ceiling is 4.26 ms", () => {
		expect(spreadFloorCeilingMs()).toBeCloseTo(4.256, 3);
	});

	test("V-F's probe lag ceiling is 2 ms", () => {
		expect(probeFloorLagCeilingMs()).toBeCloseTo(2, 6);
	});
});

describe("§8 — the cable STOP", () => {
	test("the two requirements the page tabulates", () => {
		const reqs = preflightRequirements();
		expect(reqs.map((r) => r.name)).toEqual(["R-down", "R-up"]);
		const [down, up] = reqs;
		expect(down?.offeredPps).toBe(50_000);
		expect(down?.payloadBytes).toBe(200);
		expect(down?.minMtuBytes).toBe(1280);
		expect(down?.maxLossPct).toBeCloseTo(0.1, 6);
		expect(down?.maxIdleRttP99Ms).toBeCloseTo(2, 6);
		expect(up?.offeredPps).toBe(205);
	});

	test("idle RTT allowance is 10% of the bound and tighter than G6's 5 ms", () => {
		expect(preflightMaxIdleRttP99Ms()).toBeCloseTo(2, 6);
		expect(preflightMaxIdleRttP99Ms()).toBeLessThan(5);
	});

	test("R-down is only 10.64% of the wire — the cable is not this gate's risk", () => {
		const [down] = preflightRequirements();
		const occupancy =
			(down?.offeredPps as number) / wirePpsCeiling(down?.payloadBytes ?? 200);
		expect(occupancy * 100).toBeCloseTo(10.64, 2);
	});

	test("the disclosed loss gap: derived budget is a fifth of the standing bound", () => {
		expect(DELIVERY_FLOOR).toBe(0.999);
		expect(derivedLinkLossBudgetPct()).toBeCloseTo(0.02, 6);
		expect(derivedLinkLossBudgetPct()).toBeLessThan(0.1);
	});

	test("requirements track the rung they are asked for", () => {
		const [down] = preflightRequirements(1);
		expect(down?.offeredPps).toBe(10_000);
	});
});

/* -------------------------------------------------------------------------- */

describe("§1.11 — the JS-thread stall budget M1's cap came from", () => {
	test("M1's own derivation reproduces: 1 ms at the worst shipped cost", () => {
		// The cap comment says ~11,000 targets fit a 1 ms stall at the worst
		// measured cost of the `string[]` shape, and 10,000 is the round number
		// under it. If this stops holding, either the ledger's K17 cells moved or
		// the product's cap did, and the gate has to know which.
		const worstShipped = worstCostNs("mirrorStringTargets");
		expect(worstShipped).toBe(86);
		const admitted = stallBudgetTargets(worstShipped);
		expect(admitted).toBe(11_627);
		expect(DATAGRAM_MIRROR_MAX).toBeLessThan(admitted);
	});

	test("this gate's fleet sits exactly on the cap", () => {
		// §1.11's knife edge: A3 is the largest call the API permits. One
		// subscriber more and the TS wrapper throws instead of chunking, which
		// would make A3 a different arm.
		expect(SUBSCRIBERS).toBe(DATAGRAM_MIRROR_MAX);
		expect(fleetSitsOnMirrorCap()).toBe(true);
		expect(fleetFitsMirrorCap()).toBe(true);
		expect(fleetFitsMirrorCap(SUBSCRIBERS + 1)).toBe(false);
	});

	test("the reconciliation catches a product cap that has moved", () => {
		expect(mirrorCapAgreesWithProduct(10_000)).toBe(true);
		expect(mirrorCapAgreesWithProduct(8_192)).toBe(false);
	});

	test("A1 is over the budget and A2 is inside it, both by arithmetic", () => {
		const floors = armStallFloors();
		const byArm = new Map(floors.map((f) => [f.arm, f]));
		const a1 = byArm.get("A1");
		const a2 = byArm.get("A2");
		const a3 = byArm.get("A3");
		if (!a1 || !a2 || !a3) throw new Error("every arm has a stall floor");

		// P9: A1 fails C7 before the run, at 10,000 x 343 ns.
		expect(a1.floorMs).toBeCloseTo(3.43, 6);
		expect(a1.insideBudget).toBe(false);
		expect(a1.floorMs / JS_STALL_BUDGET_MS).toBeGreaterThan(3);

		// A2 yields every 256 targets, so its span is a chunk, not a pass.
		expect(a2.targetsPerSpan).toBe(A2_CHUNK_TARGETS);
		expect(a2.floorMs).toBeCloseTo(0.087808, 6);
		expect(a2.insideBudget).toBe(true);
		expect(JS_STALL_BUDGET_MS / a2.floorMs).toBeGreaterThan(11);

		// A3 is inside the budget on paper only — the addon has no mutex in it.
		expect(a3.floorMs).toBeCloseTo(0.86, 6);
		expect(a3.insideBudget).toBe(true);
		expect(a3.lowerBoundOnly).toBe(true);
		expect(a1.lowerBoundOnly).toBe(false);
	});

	test("A3's floor is quoted from the shipped shape, not the unshipped one", () => {
		// The group-handle row (11 ns) is the arithmetic ceiling P3 is registered
		// against; it is not what will run, and the stall floor must not use it.
		expect(mirrorStallFloorMs()).toBeCloseTo(0.86, 6);
		expect(mirrorStallFloorMs()).not.toBeCloseTo(0.11, 6);
	});

	test("the verdict arm is the one §3.0 registered", () => {
		expect(VERDICT_ARM).toBe("A2");
	});

	test("the loop-lag sampler is a quarter of the RTT bound and its ticks are countable", () => {
		expect(LOOP_LAG_SAMPLE_MS).toBe(RTT_BOUND_MS / 4);
		expect(expectedLoopLagTicks(120)).toBe(24_000);
		expect(expectedLoopLagTicks(0)).toBe(0);
	});
});
