import { describe, expect, test } from "bun:test";
import {
	BULK_GATE_CELL,
	BULK_TARGET_GBPS,
	bulkCellPlan,
	evaluatePreflight,
	gateWriteBytes,
	PACE_TARGET_GBPS,
	preflightRequirements,
	SHIPPED_QUEUED_BYTES_PER_SESSION,
	SHIPPED_QUEUED_BYTES_PER_STREAM,
	sessionMemoryMath,
	TOKEN_GATE_CELL,
	TOKEN_WRITE_BYTES,
	tokenCellPlan,
} from "./g7-plan.ts";

describe("the page's arithmetic produces the page's numbers", () => {
	test("the gate write size falls out of the governor, it is not chosen", () => {
		expect(gateWriteBytes()).toBe(65536);
		expect(gateWriteBytes()).toBe(SHIPPED_QUEUED_BYTES_PER_STREAM / 4);
		expect(bulkCellPlan("B-64k").writeBytes).toBe(gateWriteBytes());
	});

	test("the pace point is the bar plus five integrity bands", () => {
		expect(PACE_TARGET_GBPS).toBeCloseTo(1.25, 10);
		expect(PACE_TARGET_GBPS).toBeCloseTo(BULK_TARGET_GBPS * 1.25, 10);
	});

	test("the ladder varies only the crossing rate", () => {
		const cells = ["B-64k", "B-16k", "B-4k", "B-1k"] as const;
		const plans = cells.map((c) => bulkCellPlan(c));
		const offer = bulkCellPlan("B-64k").paceBytesPerSec;
		for (const p of plans) expect(p.paceBytesPerSec).toBe(offer);
		expect(plans.map((p) => Math.round(p.writesPerSec))).toEqual([
			2384, 9537, 38147, 152588,
		]);
	});

	test("the gate cell paces above the timer granularity; the small rungs do not", () => {
		const gate = bulkCellPlan(BULK_GATE_CELL);
		expect(gate.writeIntervalMs).toBeCloseTo(6.71, 2);
		expect(gate.subTickPaced).toBe(false);
		expect(gate.sliceQuantum).toBe(1);

		const fine = bulkCellPlan("B-4k");
		expect(fine.subTickPaced).toBe(true);
		// One timer tick of bytes, never more: the burst stays ~1 ms wide at
		// every rung, which is what keeps the rungs comparable.
		expect(fine.sliceQuantum).toBe(3);
		expect(fine.sliceQuantum * fine.writeIntervalMs).toBeLessThanOrEqual(2);

		const finest = bulkCellPlan("B-1k");
		expect(finest.sliceQuantum).toBe(10);
		expect(finest.sliceQuantum * finest.writeIntervalMs).toBeLessThanOrEqual(2);
	});

	test("only B-1k is registered as expected to miss, and only B-64k is gate-bearing", () => {
		expect(bulkCellPlan("B-1k").expectedToMiss).toBe(true);
		expect(bulkCellPlan("B-4k").expectedToMiss).toBe(false);
		expect(bulkCellPlan("B-64k").gateBearing).toBe(true);
		expect(bulkCellPlan("B-16k").gateBearing).toBe(false);
	});

	test("the token write is a stamp inside a real frame's envelope", () => {
		expect(TOKEN_WRITE_BYTES).toBe(40);
		expect(TOKEN_WRITE_BYTES).toBeGreaterThanOrEqual(20);
		expect(TOKEN_WRITE_BYTES).toBeLessThanOrEqual(50);
	});

	test("the token bound is a quarter of the inter-token interval", () => {
		const gate = tokenCellPlan(TOKEN_GATE_CELL);
		expect(gate.intervalMs).toBe(40);
		expect(gate.oneWayBoundMs).toBe(10);
		expect(gate.writesPerSec).toBe(25000);
		expect(gate.bytesPerSec).toBe(1_000_000);
		expect(gate.sliceMs).toBe(2);
		expect(gate.sessionsPerSlice).toBe(50);
		expect(gate.gateBearing).toBe(true);
		expect(gate.scoutOnly).toBe(false);
	});

	test("rungs above the gate rung are scout-only by construction", () => {
		expect(tokenCellPlan("T-2.5k").scoutOnly).toBe(true);
		expect(tokenCellPlan("T-250").scoutOnly).toBe(false);
		expect(tokenCellPlan("T-250").gateBearing).toBe(false);
	});

	test("the slice grid is wider than the timer granularity", () => {
		for (const cell of ["T-250", "T-1k", "T-2.5k"] as const)
			expect(tokenCellPlan(cell).sliceMs).toBeGreaterThanOrEqual(1);
	});
});

describe("memory math (C6)", () => {
	test("reproduces the shipped per-session worst case and the rig multiple", () => {
		const math = sessionMemoryMath({
			maxSessions: 2000,
			rigBytes: 8 * 1024 ** 3,
		});
		expect(math.receiveWindow).toBe(SHIPPED_QUEUED_BYTES_PER_SESSION);
		expect(math.perSessionWorstCaseBytes).toBe(6_291_904);
		expect(math.rigMultipleAtMaxSessions).toBeCloseTo(1.46, 2);
	});

	test("a raised-window config is visibly outside the budget", () => {
		const math = sessionMemoryMath({
			queuedBytesPerSession: 64 * 1024 * 1024,
			maxSessions: 2000,
			rigBytes: 8 * 1024 ** 3,
		});
		expect(math.rigMultipleAtMaxSessions).toBeGreaterThan(30);
	});
});

describe("pre-flight (V1 / K16)", () => {
	const good = {
		sinkBytesPerSecObserved: 300_000_000,
		sinkEventsPerSecObserved: 50_000,
		sourceHostCpuPctMedian: 55,
		sourceShortfall: false,
		clockDeltaMs: 0.4,
		sameDay: true,
		loopback: true,
	};

	test("requirements are 1.5x the gate arms", () => {
		const req = preflightRequirements();
		expect(req.sinkBytesPerSec).toBe(156_250_000 * 1.5);
		expect(req.sinkEventsPerSec).toBe(37_500);
	});

	test("a clean pre-check passes", () => {
		expect(evaluatePreflight(good).ok).toBe(true);
	});

	test("a pre-check whose own source saturated is a failure, not a pass", () => {
		const v = evaluatePreflight({ ...good, sourceHostCpuPctMedian: 93 });
		expect(v.ok).toBe(false);
		expect(v.reasons.join(" ")).toContain("a failure, not a pass");
	});

	test("an under-driven pre-check is a failure", () => {
		expect(evaluatePreflight({ ...good, sourceShortfall: true }).ok).toBe(
			false,
		);
	});

	test("an unmeasured quantity is never a pass", () => {
		expect(
			evaluatePreflight({ ...good, sinkBytesPerSecObserved: null }).ok,
		).toBe(false);
		expect(evaluatePreflight({ ...good, clockDeltaMs: null }).ok).toBe(false);
		expect(
			evaluatePreflight({ ...good, sourceHostCpuPctMedian: null }).ok,
		).toBe(false);
	});

	test("a stale or off-box pre-check is refused", () => {
		expect(evaluatePreflight({ ...good, sameDay: false }).ok).toBe(false);
		expect(evaluatePreflight({ ...good, loopback: false }).ok).toBe(false);
	});

	test("clocks further apart than the refusal rule stop the dispatch", () => {
		expect(evaluatePreflight({ ...good, clockDeltaMs: 51 }).ok).toBe(false);
		expect(evaluatePreflight({ ...good, clockDeltaMs: -51 }).ok).toBe(false);
	});
});
