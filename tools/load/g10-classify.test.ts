import { describe, expect, test } from "bun:test";
import type { ClauseId, ClauseResult } from "./g10-classify";
import {
	armComparabilityFalsifier,
	cableFalsifier,
	completenessFalsifierFires,
	deadlineFalsifier,
	denominatorFalsifier,
	evaluateEmitterHonesty,
	evaluateFleetDelivery,
	evaluateLedger,
	evaluateLiveness,
	evaluatePerSubscriberDelivery,
	evaluateRtt,
	evaluateSpreadClause,
	evaluateStall,
	excludedMessageFraction,
	gateVerdict,
	generatorFalsifier,
	invalidatesRun,
	leverStatement,
	loopLagSamplerFalsifier,
	macSessionFalsifier,
	messageCountsForSpread,
	negativeFalsifier,
	probeFloorFalsifier,
	SOFT_FALSIFIERS,
	scoreMirrorStallPrediction,
	sinkFalsifier,
	skewFalsifier,
	spreadFloorFalsifier,
} from "./g10-classify";

const DAY = "2026-08-19";
const MAC = "cable-mac";

const precheck = {
	artifactDate: DAY,
	runDate: DAY,
	host: MAC,
	expectedHost: MAC,
};

/* -------------------------------------------------------------------------- */

describe("C1 — spread, and the guards around it", () => {
	const base = {
		rate: 5,
		subscribers: 10_000,
		spreadP99Ms: 30,
		messagesIssued: 600,
		messagesComplete: 600,
	};

	test("passes inside the amended path-derived bound", () => {
		const r = evaluateSpreadClause(base, false);
		expect(r.status).toBe("pass");
		expect(r.bound).toBeCloseTo(119.915, 2);
		expect(r.reason).toContain("21.28");
	});

	test("fails above the bound", () => {
		expect(
			evaluateSpreadClause({ ...base, spreadP99Ms: 121 }, false).status,
		).toBe("fail");
	});

	test("R = 20 is not-applicable, never a miss — the wire forbids the bound", () => {
		const r = evaluateSpreadClause(
			{ ...base, rate: 20, spreadP99Ms: 40 },
			false,
		);
		expect(r.status).toBe("not-applicable");
		expect(r.status).not.toBe("fail");
		expect(r.reason).toContain("serialize");
	});

	test("R = 1 applies with room to spare", () => {
		expect(evaluateSpreadClause({ ...base, rate: 1 }, false).status).toBe(
			"pass",
		);
	});

	test("a message that reached half the fleet does not count for spread", () => {
		expect(messageCountsForSpread(10_000)).toBe(true);
		expect(messageCountsForSpread(9_990)).toBe(true);
		expect(messageCountsForSpread(9_989)).toBe(false);
		expect(messageCountsForSpread(5_000)).toBe(false);
	});

	test("the failure the guard exists for: a narrow spread bought by dropping half the fleet", () => {
		// 40% of messages were incomplete; their spreads would have been narrow.
		const facts = {
			...base,
			spreadP99Ms: 4,
			messagesIssued: 600,
			messagesComplete: 360,
		};
		expect(excludedMessageFraction(facts)).toBeCloseTo(0.4, 6);
		expect(completenessFalsifierFires(facts)).toBe(true);
		const r = evaluateSpreadClause(facts, false);
		expect(r.status).toBe("no-verdict-force");
		expect(r.status).not.toBe("pass");
		expect(r.reason).toContain("V-X");
	});

	test("exactly 1% excluded still speaks; more than 1% does not", () => {
		expect(
			completenessFalsifierFires({
				...base,
				messagesIssued: 1000,
				messagesComplete: 990,
			}),
		).toBe(false);
		expect(
			completenessFalsifierFires({
				...base,
				messagesIssued: 1000,
				messagesComplete: 989,
			}),
		).toBe(true);
	});

	test("V-SP strips force even when the number is inside the bound", () => {
		const r = evaluateSpreadClause(base, true);
		expect(r.status).toBe("no-verdict-force");
		expect(r.reason).toContain("V-SP");
	});

	test("a missing percentile is no-verdict-force, not a pass", () => {
		expect(
			evaluateSpreadClause({ ...base, spreadP99Ms: null }, false).status,
		).toBe("no-verdict-force");
	});

	test("no messages at all excludes everything", () => {
		expect(
			excludedMessageFraction({
				...base,
				messagesIssued: 0,
				messagesComplete: 0,
			}),
		).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */

describe("C2 — delivery, fleet and per subscriber", () => {
	const base = {
		received: 5_997_000,
		messagesIssued: 600,
		subscribers: 10_000,
		subscribersMeetingFloor: 10_000,
		worstSubscriberRatio: 0.9995,
	};

	test("C2a passes at 0.9995 and fails at 0.998", () => {
		expect(evaluateFleetDelivery(base).status).toBe("pass");
		expect(evaluateFleetDelivery({ ...base, received: 5_988_000 }).status).toBe(
			"fail",
		);
	});

	test("C2a is no-verdict-force with a zero denominator, not a pass", () => {
		expect(evaluateFleetDelivery({ ...base, messagesIssued: 0 }).status).toBe(
			"no-verdict-force",
		);
	});

	test("P5's failure mode: a healthy fleet ratio hiding a starved cohort", () => {
		// 200 of 10,000 subscribers systematically behind; fleet ratio still fine.
		const facts = {
			...base,
			subscribersMeetingFloor: 9_800,
			worstSubscriberRatio: 0.61,
		};
		expect(evaluateFleetDelivery(facts).status).toBe("pass");
		const perSub = evaluatePerSubscriberDelivery(facts);
		expect(perSub.status).toBe("fail");
		expect(perSub.reason).toContain("0.610000");
	});

	test("exactly 99% of subscribers clears C2b; 98.99% does not", () => {
		expect(
			evaluatePerSubscriberDelivery({ ...base, subscribersMeetingFloor: 9_900 })
				.status,
		).toBe("pass");
		expect(
			evaluatePerSubscriberDelivery({ ...base, subscribersMeetingFloor: 9_899 })
				.status,
		).toBe("fail");
	});
});

/* -------------------------------------------------------------------------- */

describe("C3 — RTT, raw", () => {
	test("passes at 12 ms, fails at 21 ms", () => {
		expect(evaluateRtt({ rttP99Ms: 12, holdP99Ms: 0.4 }).status).toBe("pass");
		expect(evaluateRtt({ rttP99Ms: 21, holdP99Ms: 0.4 }).status).toBe("fail");
	});

	test("dwell is disclosed and never subtracted", () => {
		// 21 ms raw with 8 ms of server dwell would pass if dwell were subtracted.
		const r = evaluateRtt({ rttP99Ms: 21, holdP99Ms: 8 });
		expect(r.status).toBe("fail");
		expect(r.observed).toBe(21);
		expect(r.reason).toContain("not subtracted");
	});
});

/* -------------------------------------------------------------------------- */

describe("C4 — the fleet is still the fleet", () => {
	test("a shrunken audience fails even with zero recorded losses", () => {
		expect(
			evaluateLiveness({
				sessionsActiveAtEnd: 9_900,
				subscribers: 10_000,
				sessionsLost: 0,
			}).status,
		).toBe("fail");
	});

	test("a full fleet with a recorded loss still fails", () => {
		expect(
			evaluateLiveness({
				sessionsActiveAtEnd: 10_000,
				subscribers: 10_000,
				sessionsLost: 3,
			}).status,
		).toBe("fail");
	});

	test("intact passes", () => {
		expect(
			evaluateLiveness({
				sessionsActiveAtEnd: 10_000,
				subscribers: 10_000,
				sessionsLost: 0,
			}).status,
		).toBe("pass");
	});
});

/* -------------------------------------------------------------------------- */

describe("C5 — the stage ledger", () => {
	const base = {
		broadcastsIssued: 600,
		subscribers: 10_000,
		sendAttempts: 6_000_000,
		sendOk: 5_999_000,
		sendWouldBlock: 900,
		sendErrors: 100,
	};

	test("a closed ledger passes", () => {
		expect(evaluateLedger(base).status).toBe("pass");
	});

	test("attempts that do not match the fan-out fail", () => {
		expect(evaluateLedger({ ...base, sendAttempts: 5_000_000 }).status).toBe(
			"fail",
		);
	});

	test("outcomes that do not sum to attempts fail — K14's uncounted batch path", () => {
		expect(evaluateLedger({ ...base, sendOk: 5_000_000 }).status).toBe("fail");
	});

	test("a residual inside 0.1% is tolerated", () => {
		expect(evaluateLedger({ ...base, sendOk: 5_998_000 }).status).toBe("pass");
	});
});

/* -------------------------------------------------------------------------- */

describe("C6 — the emitter sourced the load", () => {
	const base = {
		emitted: 6_000_000,
		messagesIssued: 600,
		subscribers: 10_000,
		handoffLagP99Ms: 1.2,
		sendEventsSkipped: 0,
		sendErrors: 0,
		rate: 5,
	};

	test("a full emitter inside its period passes", () => {
		expect(evaluateEmitterHonesty(base).status).toBe("pass");
	});

	test("an emitter that fell behind its own grid fails", () => {
		expect(
			evaluateEmitterHonesty({ ...base, handoffLagP99Ms: 260 }).status,
		).toBe("fail");
	});

	test("an emitter that never issued the shape fails", () => {
		expect(evaluateEmitterHonesty({ ...base, emitted: 4_000_000 }).status).toBe(
			"fail",
		);
	});

	test("a missing lag percentile is not a pass", () => {
		expect(
			evaluateEmitterHonesty({ ...base, handoffLagP99Ms: null }).status,
		).toBe("fail");
	});
});

/* -------------------------------------------------------------------------- */

describe("§7 — the pre-check falsifiers", () => {
	test("V-C: yesterday's artifact does not license today's run", () => {
		expect(
			cableFalsifier({
				...precheck,
				artifactDate: "2026-08-18",
				requirementsMet: { "R-down": true, "R-up": true },
			}).fires,
		).toBe(true);
	});

	test("V-C: a failed requirement fires and names itself", () => {
		const r = cableFalsifier({
			...precheck,
			requirementsMet: { "R-down": false, "R-up": true },
		});
		expect(r.fires).toBe(true);
		expect(r.reason).toContain("R-down");
	});

	test("V-C: green same-day pre-flight does not fire", () => {
		expect(
			cableFalsifier({
				...precheck,
				requirementsMet: { "R-down": true, "R-up": true },
			}).fires,
		).toBe(false);
	});

	test("V-M: 9,999 sessions is not 10,000", () => {
		expect(
			macSessionFalsifier({
				...precheck,
				sessionsEstablished: 9_999,
				sessionsHeld: 9_999,
			}).fires,
		).toBe(true);
	});

	test("V-M: established but not held still fires", () => {
		expect(
			macSessionFalsifier({
				...precheck,
				sessionsEstablished: 10_000,
				sessionsHeld: 9_400,
			}).fires,
		).toBe(true);
	});

	test("V-M: a full, held fleet does not fire", () => {
		expect(
			macSessionFalsifier({
				...precheck,
				sessionsEstablished: 10_000,
				sessionsHeld: 10_000,
			}).fires,
		).toBe(false);
	});

	test("V-S: a pre-check that only drove the arm's own rate fires", () => {
		const r = sinkFalsifier({
			...precheck,
			offeredPps: 50_000,
			deliveryRatio: 1,
			rate: 5,
		});
		expect(r.fires).toBe(true);
		expect(r.reason).toContain("75000");
	});

	test("V-S: 1.5x at a good ratio does not fire", () => {
		expect(
			sinkFalsifier({
				...precheck,
				offeredPps: 75_000,
				deliveryRatio: 0.998,
				rate: 5,
			}).fires,
		).toBe(false);
	});

	test("V-S: 1.5x at a bad ratio fires", () => {
		expect(
			sinkFalsifier({
				...precheck,
				offeredPps: 75_000,
				deliveryRatio: 0.9,
				rate: 5,
			}).fires,
		).toBe(true);
	});

	test("V-SP: a sink slower than 1.2 × the net impulse emission fires", () => {
		expect(
			spreadFloorFalsifier({
				...precheck,
				burstDrainMaxMs: 120,
				burstEmitNetMaxMs: 95,
				burstEmitMaxMs: 95,
				burstCompletenessMin: 0.99,
			}).fires,
		).toBe(true);
	});

	test("V-SP: a sink at wire pace on a near-complete burst does not fire", () => {
		const ok = spreadFloorFalsifier({
			...precheck,
			burstDrainMaxMs: 100,
			burstEmitNetMaxMs: 95,
			burstEmitMaxMs: 140,
			burstCompletenessMin: 0.98,
		});
		expect(ok.fires).toBe(false);
		expect(ok.reason).toContain("completeness min 0.980");
		expect(ok.reason).toContain("gross 140.00 ms");
	});

	test("V-SP (Amendment 5): the sender's backoff sleeps no longer raise the ceiling", () => {
		// Same sink, same burst. Gross emission 300 ms would have licensed a
		// 360 ms drain; the sender's own work was 95 ms, so the ceiling is 114.
		const facts = {
			...precheck,
			burstDrainMaxMs: 200,
			burstEmitNetMaxMs: 95,
			burstEmitMaxMs: 300,
			burstCompletenessMin: 0.99,
		};
		expect(spreadFloorFalsifier(facts).fires).toBe(true);
		expect(
			spreadFloorFalsifier({ ...facts, burstEmitNetMaxMs: 300 }).fires,
		).toBe(false);
	});

	test("V-SP (Amendment 5): a burst that mostly did not arrive cannot pass on its short drain", () => {
		// The 2026-08-19 reading Amendment 4 recorded as passing: drain 91.9 ms
		// against a 114 ms ceiling — but only 61.7% of the burst arrived, so the
		// window is 61.7% of a window. Normalized it is 148.95 ms, over ceiling.
		const fired = spreadFloorFalsifier({
			...precheck,
			burstDrainMaxMs: 91.9,
			burstEmitNetMaxMs: 95,
			burstEmitMaxMs: 95,
			burstCompletenessMin: 0.617,
		});
		expect(fired.fires).toBe(true);
		expect(fired.reason).toContain("148.9");
	});

	test("V-SP: undisclosed completeness fires — an unnormalizable drain is not a cleared sink", () => {
		expect(
			spreadFloorFalsifier({
				...precheck,
				burstDrainMaxMs: 91.9,
				burstEmitNetMaxMs: 95,
				burstEmitMaxMs: 95,
				burstCompletenessMin: null,
			}).fires,
		).toBe(true);
	});

	test("V-SP: a missing burst-probe artifact fires", () => {
		expect(
			spreadFloorFalsifier({
				...precheck,
				burstDrainMaxMs: null,
				burstEmitNetMaxMs: null,
				burstEmitMaxMs: null,
				burstCompletenessMin: null,
			}).fires,
		).toBe(true);
	});

	test("V-F: K11's 40.6 ms signature fires; a 0.9 ms p99 does not", () => {
		expect(
			probeFloorFalsifier({
				...precheck,
				scheduleLagP99Ms: 40.6,
				scheduleLagMaxMs: 40.6,
				drivingSessions: 20,
			}).fires,
		).toBe(true);
		const ok = probeFloorFalsifier({
			...precheck,
			scheduleLagP99Ms: 0.9,
			scheduleLagMaxMs: 40.6,
			drivingSessions: 20,
		});
		expect(ok.fires).toBe(false);
		expect(ok.reason).toContain("disclosed");
	});

	test("V-F: a floor arm that drove nothing fires", () => {
		expect(
			probeFloorFalsifier({
				...precheck,
				scheduleLagP99Ms: 0.1,
				scheduleLagMaxMs: 0.2,
				drivingSessions: 0,
			}).fires,
		).toBe(true);
	});

	test("V-F: a floor arm from the wrong host fires", () => {
		expect(
			probeFloorFalsifier({
				...precheck,
				host: "the-runner",
				scheduleLagP99Ms: 0.1,
				scheduleLagMaxMs: 0.2,
				drivingSessions: 20,
			}).fires,
		).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

describe("§7 — the instrument falsifiers", () => {
	const hist = (over: Partial<Parameters<typeof negativeFalsifier>[0][0]>) => ({
		name: "spread",
		count: 1000,
		recordedTotal: 1000,
		negative: 0,
		deliveredOnPath: 1000,
		unstamped: 0,
		...over,
	});

	test("V-N: one negative sample is enough", () => {
		expect(negativeFalsifier([hist({ negative: 1 })]).fires).toBe(true);
		expect(negativeFalsifier([hist({})]).fires).toBe(false);
	});

	test("V-K: G3b's skew signature fires; 0.1% does not", () => {
		expect(skewFalsifier([hist({ recordedTotal: 1200 })]).fires).toBe(true);
		expect(skewFalsifier([hist({ recordedTotal: 1001 })]).fires).toBe(false);
	});

	test("V-D: a percentile over a subset of its own path fires", () => {
		expect(
			denominatorFalsifier([hist({ count: 800, deliveredOnPath: 1000 })]).fires,
		).toBe(true);
		expect(
			denominatorFalsifier([
				hist({ count: 990, deliveredOnPath: 1000, unstamped: 10 }),
			]).fires,
		).toBe(false);
	});

	test("V-G: the worst rung decides", () => {
		expect(generatorFalsifier([1, 0.999, 0.97]).fires).toBe(true);
		expect(generatorFalsifier([1, 0.995]).fires).toBe(false);
		expect(generatorFalsifier([]).fires).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

describe("V-A — arm comparability (K5's exact defect)", () => {
	test("G3b's 3.85x lag spread fires", () => {
		const r = armComparabilityFalsifier([
			{ arm: "A1", probeLagP99Ms: 1.0, emitterLagP99Ms: 0.5 },
			{ arm: "A2", probeLagP99Ms: 3.85, emitterLagP99Ms: 0.6 },
		]);
		expect(r.fires).toBe(true);
		expect(r.spread).toBeCloseTo(3.85, 2);
	});

	test("an emitter-lag spread fires even when the probe lag is even", () => {
		expect(
			armComparabilityFalsifier([
				{ arm: "A1", probeLagP99Ms: 1.0, emitterLagP99Ms: 0.5 },
				{ arm: "A2", probeLagP99Ms: 1.05, emitterLagP99Ms: 2.0 },
			]).fires,
		).toBe(true);
	});

	test("comparable arms do not fire", () => {
		expect(
			armComparabilityFalsifier([
				{ arm: "A1", probeLagP99Ms: 1.0, emitterLagP99Ms: 0.5 },
				{ arm: "A2", probeLagP99Ms: 1.4, emitterLagP99Ms: 0.7 },
				{ arm: "A3", probeLagP99Ms: 1.1, emitterLagP99Ms: 0.6 },
			]).fires,
		).toBe(false);
	});

	test("a single arm compares nothing", () => {
		expect(
			armComparabilityFalsifier([
				{ arm: "A1", probeLagP99Ms: 1.0, emitterLagP99Ms: 0.5 },
			]).fires,
		).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */

describe("§7 — which falsifiers kill the run", () => {
	test("V-SP, V-X, V-A and V-L strip force; everything else invalidates", () => {
		expect([...SOFT_FALSIFIERS].sort()).toEqual(["V-A", "V-L", "V-SP", "V-X"]);
		expect(invalidatesRun("V-C")).toBe(true);
		expect(invalidatesRun("V-M")).toBe(true);
		expect(invalidatesRun("V-N")).toBe(true);
		expect(invalidatesRun("V-SP")).toBe(false);
		expect(invalidatesRun("V-X")).toBe(false);
		expect(invalidatesRun("V-A")).toBe(false);
	});

	test("V-W kills the rung it fires on — a killed fleet is never a number", () => {
		expect(invalidatesRun("V-W")).toBe(true);
		expect(deadlineFalsifier(true).fires).toBe(true);
		expect(deadlineFalsifier(true).reason).toContain("truncated");
		expect(deadlineFalsifier(false).fires).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */

describe("§2.4 — the anti-inflation rule", () => {
	test("the lever is quoted against A2, and the number says so", () => {
		const r = leverStatement([
			{ arm: "A1", spreadP99Ms: 24 },
			{ arm: "A2", spreadP99Ms: 27 },
			{ arm: "A3", spreadP99Ms: 24.5 },
		]);
		expect(r.status).toBe("measured");
		expect(r.comparand).toBe("A2");
		expect(r.gainMs).toBeCloseTo(2.5, 6);
		// The inflated figure A3 vs A1 would have been -0.5; against the retired
		// promise path it would have been larger still. Neither is computable here.
		expect(r.gainMs).not.toBeCloseTo(-0.5, 6);
	});

	test("a missing mirror arm is NOT-RUN, never a pass and never a blocker", () => {
		const r = leverStatement([
			{ arm: "A1", spreadP99Ms: 24 },
			{ arm: "A2", spreadP99Ms: 27 },
		]);
		expect(r.status).toBe("not-run");
		expect(r.gainMs).toBeNull();
		expect(r.reason).toContain("two arms");
	});

	test("V-A strips the lever's force but keeps the number visible", () => {
		const r = leverStatement(
			[
				{ arm: "A2", spreadP99Ms: 27 },
				{ arm: "A3", spreadP99Ms: 24.5 },
			],
			true,
		);
		expect(r.status).toBe("no-verdict-force");
		expect(r.gainMs).toBeCloseTo(2.5, 6);
	});

	test("P3's registered ceiling: a gain above 4 ms would falsify the prediction", () => {
		const r = leverStatement([
			{ arm: "A2", spreadP99Ms: 27 },
			{ arm: "A3", spreadP99Ms: 21.5 },
		]);
		expect(r.gainMs).toBeCloseTo(5.5, 6);
		expect(r.gainMs as number).toBeGreaterThan(4);
	});
});

/* -------------------------------------------------------------------------- */

describe("C7 — the JS-thread stall, against M1's own budget", () => {
	test("A2's registered shape passes with the margin §1.11 derives", () => {
		const r = evaluateStall({
			arm: "A2",
			passStallP99Ms: 0.09,
			loopLagP99Ms: 0.4,
		});
		expect(r.status).toBe("pass");
		expect(r.bound).toBe(1);
		expect(r.reason).toContain("disclosure, not the clause");
	});

	test("A1's 3.4 ms pass fails it — P9's registered arithmetic, as a signature", () => {
		const r = evaluateStall({
			arm: "A1",
			passStallP99Ms: 3.43,
			loopLagP99Ms: 4.1,
		});
		expect(r.status).toBe("fail");
		expect(r.observed).toBe(3.43);
	});

	test("the clause takes no per-arm bound: A1 is not given a softer one", () => {
		// A1 and A3 at the same stall get the same verdict. If C7 ever grew a
		// per-arm bound, a registered arithmetic consequence would quietly become
		// a scoring convenience, and §3.0 would have nothing left to do.
		const a1 = evaluateStall({
			arm: "A1",
			passStallP99Ms: 1.4,
			loopLagP99Ms: null,
		});
		const a3 = evaluateStall({
			arm: "A3",
			passStallP99Ms: 1.4,
			loopLagP99Ms: null,
		});
		expect(a1.status).toBe("fail");
		expect(a3.status).toBe("fail");
		expect(a1.bound).toBe(a3.bound);
	});

	test("exactly at the budget passes; a hair over does not", () => {
		expect(
			evaluateStall({ arm: "A3", passStallP99Ms: 1, loopLagP99Ms: null })
				.status,
		).toBe("pass");
		expect(
			evaluateStall({ arm: "A3", passStallP99Ms: 1.0001, loopLagP99Ms: null })
				.status,
		).toBe("fail");
	});

	test("a missing pass-stall percentile strips force rather than passing", () => {
		const r = evaluateStall({
			arm: "A3",
			passStallP99Ms: null,
			loopLagP99Ms: 0.3,
		});
		expect(r.status).toBe("no-verdict-force");
		expect(r.observed).toBeNull();
	});

	test("loop lag is never substituted for the clause", () => {
		// A healthy loop-lag figure beside a blown pass stall must not rescue it.
		const r = evaluateStall({
			arm: "A3",
			passStallP99Ms: 2.2,
			loopLagP99Ms: 0.2,
		});
		expect(r.status).toBe("fail");
		expect(r.observed).toBe(2.2);
	});
});

describe("P8 — the microbench floor is a lower bound, scored", () => {
	test("a stall at 2x the mutex-free floor holds the prediction", () => {
		const r = scoreMirrorStallPrediction({
			arm: "A3",
			passStallP99Ms: 1.8,
			loopLagP99Ms: null,
		});
		expect(r.status).toBe("measured");
		expect(r.floorMs).toBeCloseTo(0.86, 6);
		expect(r.ratio as number).toBeCloseTo(1.8 / 0.86, 6);
		expect(r.predictionHeld).toBe(true);
	});

	test("a stall near the floor falsifies it — the more interesting outcome", () => {
		const r = scoreMirrorStallPrediction({
			arm: "A3",
			passStallP99Ms: 0.95,
			loopLagP99Ms: null,
		});
		expect(r.predictionHeld).toBe(false);
		expect(r.reason).toContain("mutex-free");
	});

	test("no mirror arm scores NOT-RUN, never PASS", () => {
		expect(scoreMirrorStallPrediction(undefined).status).toBe("not-run");
		expect(
			scoreMirrorStallPrediction({
				arm: "A2",
				passStallP99Ms: 0.09,
				loopLagP99Ms: null,
			}).status,
		).toBe("not-run");
		expect(
			scoreMirrorStallPrediction({
				arm: "A3",
				passStallP99Ms: null,
				loopLagP99Ms: null,
			}).predictionHeld,
		).toBeNull();
	});
});

describe("V-L — the loop-lag sampler's own liveness", () => {
	test("a sampler that got its ticks does not fire", () => {
		const r = loopLagSamplerFalsifier({
			ticksRecorded: 23_500,
			windowSeconds: 120,
		});
		expect(r.fires).toBe(false);
		expect(r.reason).toContain("24000");
	});

	test("a starved sampler fires — percentiles over a self-selected subset", () => {
		const r = loopLagSamplerFalsifier({
			ticksRecorded: 9_000,
			windowSeconds: 120,
		});
		expect(r.fires).toBe(true);
		expect(r.reason).toContain("37.5%");
	});

	test("a window implying no ticks fires rather than dividing by zero", () => {
		expect(
			loopLagSamplerFalsifier({ ticksRecorded: 0, windowSeconds: 0 }).fires,
		).toBe(true);
	});

	test("it is soft: it strips a disclosure, never the run", () => {
		expect(SOFT_FALSIFIERS.has("V-L")).toBe(true);
		expect(invalidatesRun("V-L")).toBe(false);
	});
});

describe("§3.0 — the verdict is A2's clause set, and only A2's", () => {
	const pass = (id: ClauseId): ClauseResult => ({
		id,
		status: "pass",
		observed: 1,
		bound: 1,
		reason: "",
	});
	const fail = (id: ClauseId): ClauseResult => ({
		...pass(id),
		status: "fail",
	});
	const na = (id: ClauseId): ClauseResult => ({
		...pass(id),
		status: "not-applicable",
	});
	const stripped = (id: ClauseId): ClauseResult => ({
		...pass(id),
		status: "no-verdict-force",
	});

	test("A1 failing C7 does not fail the gate — that is the whole point of §3.0", () => {
		const v = gateVerdict([
			{ arm: "A1", clauses: [pass("C1"), fail("C7")] },
			{ arm: "A2", clauses: [pass("C1"), pass("C7")] },
		]);
		expect(v.verdict).toBe("pass");
		expect(v.arm).toBe("A2");
	});

	test("A3 failing anything does not fail the gate either", () => {
		const v = gateVerdict([
			{ arm: "A2", clauses: [pass("C1"), pass("C7")] },
			{ arm: "A3", clauses: [fail("C7"), fail("C3")] },
		]);
		expect(v.verdict).toBe("pass");
	});

	test("A2 missing a clause fails the gate and names it", () => {
		const v = gateVerdict([
			{ arm: "A2", clauses: [pass("C1"), fail("C2b"), fail("C3")] },
		]);
		expect(v.verdict).toBe("fail");
		expect(v.failed).toEqual(["C2b", "C3"]);
	});

	test("an unsatisfiable clause is not a miss (R = 20's spread, §1.6)", () => {
		const v = gateVerdict([{ arm: "A2", clauses: [na("C1"), pass("C2a")] }]);
		expect(v.verdict).toBe("pass");
	});

	test("a force-stripped clause on the verdict arm yields no verdict, not a pass", () => {
		const v = gateVerdict([
			{ arm: "A2", clauses: [stripped("C1"), pass("C2a")] },
		]);
		expect(v.verdict).toBe("no-verdict");
		expect(v.reason).toContain("C1");
	});

	test("no A2 means no verdict, however well the other arms did", () => {
		const v = gateVerdict([
			{ arm: "A1", clauses: [pass("C1")] },
			{ arm: "A3", clauses: [pass("C1")] },
		]);
		expect(v.verdict).toBe("no-verdict");
		expect(v.arm).toBe("A2");
	});
});
