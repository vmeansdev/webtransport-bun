/**
 * The G11 scenario arithmetic, pinned against the figures the pre-registration
 * prints on its own page.
 *
 * These are not tests of a library. They are the mechanism that keeps
 * docs/research/preregistrations/gate-g11-bidi.md and the harness telling the
 * same story: if a constant here moves, the table in §1.4 stops reproducing and
 * this file fails.
 */

import { describe, expect, test } from "bun:test";
import {
	advertisedPerSessionBytes,
	BACKLOG_FRACTIONS,
	backlogTargetBytes,
	backlogWitnessBytes,
	bytesPerSecPerDirection,
	consumptionDelayMsForBacklog,
	EXCHANGE_GATE_RUNG,
	EXCHANGE_LADDER,
	emitterOffsetMs,
	exchangeRttBoundMs,
	exchangeRung,
	FRAME_BYTES,
	oneWayBoundMs,
	pacerResidualFraction,
	roundTripBudgetMs,
	SHIPPED_MAX_STREAMS_PER_SESSION_BIDI,
	SHIPPED_QUEUED_BYTES_PER_STREAM,
	TUNNEL_EXPLORATORY_RUNG,
	TUNNEL_GATE_RUNG,
	TUNNEL_LADDER,
	tunnelRung,
} from "./g11-plan.ts";

describe("frame and rate constants (§1.3)", () => {
	test("a frame is one inner packet plus its length prefix", () => {
		expect(FRAME_BYTES).toBe(1402);
	});

	test("3 Mbps is 375,000 B/s in one direction", () => {
		expect(bytesPerSecPerDirection()).toBe(375_000);
	});

	test("one tunnel emits 267.5 frames/s per direction, 3.739 ms apart", () => {
		const rung = tunnelRung(1);
		expect(rung.framesPerSecPerTunnel).toBeCloseTo(267.475, 3);
		expect(rung.frameIntervalMs).toBeCloseTo(3.7387, 4);
	});
});

describe("the session ladder reproduces §1.4 exactly", () => {
	const expected = [
		{ sessions: 25, mbps: 75, total: 150, frames: 6687, crossings: 13374 },
		{ sessions: 50, mbps: 150, total: 300, frames: 13374, crossings: 26748 },
		{ sessions: 100, mbps: 300, total: 600, frames: 26748, crossings: 53495 },
		{ sessions: 200, mbps: 600, total: 1200, frames: 53495, crossings: 106990 },
	];

	for (const row of expected) {
		test(`rung ${row.sessions}`, () => {
			const rung = tunnelRung(row.sessions);
			expect(rung.mbpsPerDirection).toBe(row.mbps);
			expect(rung.mbpsTotal).toBe(row.total);
			expect(Math.round(rung.framesPerSecPerDirection)).toBe(row.frames);
			expect(Math.round(rung.serverCrossingsPerSec)).toBe(row.crossings);
		});
	}

	test("the gate rung is the ladder's top, and 200 is not on the ladder", () => {
		expect(TUNNEL_LADDER.at(-1)).toBe(TUNNEL_GATE_RUNG);
		expect(TUNNEL_LADDER).not.toContain(TUNNEL_EXPLORATORY_RUNG);
	});

	test("the gate rung's crossing rate is below the only stamped one (K8)", () => {
		// G5b's knob-off cell completed at 73,301 crossings/s. The gate rung is
		// sized under it on purpose; the exploratory rung is above it on purpose.
		expect(tunnelRung(TUNNEL_GATE_RUNG).serverCrossingsPerSec).toBeLessThan(
			73_301,
		);
		expect(
			tunnelRung(TUNNEL_EXPLORATORY_RUNG).serverCrossingsPerSec,
		).toBeGreaterThan(73_301);
	});

	test("a rung must be a positive integer", () => {
		expect(() => tunnelRung(0)).toThrow();
		expect(() => tunnelRung(2.5)).toThrow();
	});
});

describe("the latency bounds come out of the interaction budget (§1.6)", () => {
	test("the budget leaves 56.6 ms, floored to 50", () => {
		expect(roundTripBudgetMs()).toBe(50);
	});

	test("Arm T gates one traversal, Arm X gates the round trip", () => {
		expect(oneWayBoundMs()).toBe(25);
		expect(exchangeRttBoundMs()).toBe(50);
	});
});

describe("Arm X arithmetic (§1.5)", () => {
	test("the gate rung is 2,000 exchanges/s and 2,000 bidi opens/s", () => {
		const rung = exchangeRung(EXCHANGE_GATE_RUNG);
		expect(rung.exchangesPerSec).toBe(2000);
		expect(rung.bidiOpensPerSec).toBe(2000);
		expect(rung.bytesPerSec).toBe(480_000);
	});

	test("the ladder tops out at the gate rung", () => {
		expect(EXCHANGE_LADDER.at(-1)).toBe(EXCHANGE_GATE_RUNG);
	});

	test("expected concurrency stays far under the shipped per-session cap", () => {
		// Two exchanges/s at an RTT bounded by 50 ms means ~0.1 concurrent
		// streams per session. V-X2 invalidates the arm if the run says
		// otherwise; this is the arithmetic that makes V-X2 a real check rather
		// than a formality.
		const concurrent = (2 * exchangeRttBoundMs()) / 1000;
		expect(concurrent).toBeLessThan(SHIPPED_MAX_STREAMS_PER_SESSION_BIDI / 100);
	});
});

describe("Arm D arithmetic", () => {
	test("backlog targets are fractions of the shipped per-stream budget", () => {
		expect(backlogTargetBytes(0)).toBe(0);
		expect(backlogTargetBytes(0.25)).toBe(65_536);
		expect(backlogTargetBytes(0.75)).toBe(196_608);
		expect(backlogTargetBytes(0.95)).toBe(249_036);
	});

	test("the top target sits just under the budget it is probing", () => {
		const top = backlogTargetBytes(BACKLOG_FRACTIONS.at(-1) as number);
		expect(top).toBeLessThan(SHIPPED_QUEUED_BYTES_PER_STREAM);
	});

	test("an out-of-range fraction is refused, not clamped", () => {
		expect(() => backlogTargetBytes(1.5)).toThrow();
		expect(() => backlogTargetBytes(-0.1)).toThrow();
		expect(() => backlogWitnessBytes(1.5)).toThrow();
	});

	test("the witness bar is half the target the cell is registered at", () => {
		expect(backlogWitnessBytes(0)).toBe(0);
		expect(backlogWitnessBytes(0.95)).toBe(124_518);
		for (const f of BACKLOG_FRACTIONS) {
			expect(backlogWitnessBytes(f)).toBeLessThan(backlogTargetBytes(f) + 1);
		}
	});

	test("the consumption delay to reach a backlog is derivable", () => {
		// 65,536 B is 46.7 frames; at 3.739 ms apart that is ~175 ms of withheld
		// consumption. The number matters because it must be well under the
		// 5,000 ms backpressure timeout, or the cell would be testing the
		// timeout rather than the coupling.
		const ms = consumptionDelayMsForBacklog(65_536);
		expect(ms).toBeGreaterThan(150);
		expect(ms).toBeLessThan(250);
	});
});

describe("pacer and emitter properties the clauses lean on", () => {
	test("the pacer's residual is ~800x smaller than the 5% fairness band", () => {
		const residual = pacerResidualFraction(60);
		expect(residual).toBeCloseTo(0.0000623, 7);
		expect(0.05 / residual).toBeGreaterThan(800);
	});

	test("the downstream emitter spreads a tick across its sessions", () => {
		const interval = tunnelRung(1).frameIntervalMs;
		expect(emitterOffsetMs(0, 100)).toBe(0);
		expect(emitterOffsetMs(50, 100)).toBeCloseTo(interval / 2, 6);
		expect(emitterOffsetMs(99, 100)).toBeLessThan(interval);
	});

	test("an emitter index outside the population is refused", () => {
		expect(() => emitterOffsetMs(100, 100)).toThrow();
		expect(() => emitterOffsetMs(-1, 100)).toThrow();
	});
});

describe("memory statement (clause C8)", () => {
	test("the shipped per-session worst case reproduces G5b's figure", () => {
		expect(advertisedPerSessionBytes()).toBe(6_291_904);
	});

	test("the gate rung's advertised footprint is stated, not inferred", () => {
		// 100 tunnels is the gate rung; the claim in §6 names this number rather
		// than borrowing maxSessions=2000's 1.46x-the-rig figure.
		expect(advertisedPerSessionBytes() * TUNNEL_GATE_RUNG).toBe(629_190_400);
	});
});
