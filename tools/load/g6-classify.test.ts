/**
 * Every G6 clause and every G6 falsifier, shown to fire against the signature it
 * was registered to reject — off the runner, before any dispatch.
 *
 * G3b's V1 existed only as prose and a hand derivation. Its classifier computed
 * no field for it, its own `c1.verdict` said PASS, and the run its registration
 * declared invalid would have been stamped by a reader who trusted that boolean.
 * The failing signatures below are taken from the real defects this effort has
 * already paid for: the retracted accept rate (Little's law on a permit pool),
 * the positive-samples-only percentile, the µs-signature ingest path, the
 * starved sink, and a kernel tap that was never read being booked as a zero.
 */

import { describe, expect, test } from "bun:test";
import {
	clauseC1,
	clauseC2,
	clauseC3,
	clauseC4,
	clauseC5,
	clauseC6,
	clauseH1,
	clauseH2,
	clauseSC1,
	clauseSC2,
	falsifierFloor,
	falsifierGenerator,
	falsifierHistograms,
	falsifierIngestReality,
	falsifierLittle,
	falsifierSink,
	type HistogramFacts,
	type HotspotFacts,
	histogramValidity,
	rollUp,
	type SteadyArmFacts,
	type StormFacts,
	steadyArmClauses,
} from "./g6-classify.ts";

const ms = (v: number) => v * 1e6;

function histogram(over: Partial<HistogramFacts> = {}): HistogramFacts {
	return {
		name: "rtt",
		count: 300_000,
		recordedTotal: 300_000,
		negative: 0,
		p99Ns: ms(12),
		expectedSamples: 300_000,
		unstamped: 0,
		...over,
	};
}

function steadyArm(over: Partial<SteadyArmFacts> = {}): SteadyArmFacts {
	return {
		sessions: 5000,
		clientEnqueuedUpstream: 2_400_000,
		serverRxUpstream: 2_400_000,
		snapshotServerIssued: 9_000_000,
		snapshotClientReceived: 9_000_000,
		ackServerIssued: 300_000,
		ackClientReceived: 300_000,
		rtt: histogram(),
		sessionsLost: 0,
		sessionsActiveAtEnd: 5000,
		ledger: {
			clientEnqueued: 2_400_000,
			clientWireTx: 2_400_000,
			kernelDropsSocket: 0,
			kernelRcvbufErrors: 0,
			serverObserved: 2_400_000,
			jsDelivered: 2_400_000,
			nativeDropped: 0,
			nativeSkippedQueueFull: 0,
		},
		emitter: {
			snapshotDue: 9_000_000,
			snapshotIssued: 9_000_000,
			ackDue: 300_000,
			ackIssued: 300_000,
			sendEventsSkipped: 0,
			sendErrors: 0,
			batchPartialCompletions: 0,
		},
		...over,
	};
}

describe("histogram validity — the two defects G3b had to dig out of raw buckets", () => {
	test("a negative sample on a single-clock measurement voids it", () => {
		const v = histogramValidity(histogram({ negative: 1 }));
		expect(v.valid).toBe(false);
		expect(v.reasons[0]).toContain("V-N");
	});

	test("a snapshot taken while recording continued is caught by the skew", () => {
		const v = histogramValidity(
			histogram({ count: 300_000, recordedTotal: 301_000 }),
		);
		expect(v.valid).toBe(false);
		expect(v.reasons.join(" ")).toContain("V-K");
	});

	test("a skew inside the tolerance is not a failure", () => {
		expect(
			histogramValidity(histogram({ count: 300_000, recordedTotal: 300_200 }))
				.valid,
		).toBe(true);
	});

	test("a percentile over a survivorship subset is caught by the denominator", () => {
		// G3b's second defect in its G6 form: the histogram holds fewer samples
		// than the run's own counters say were delivered on that path.
		const v = histogramValidity(
			histogram({ count: 180_000, recordedTotal: 180_000 }),
		);
		expect(v.valid).toBe(false);
		expect(v.reasons.join(" ")).toContain("V-D");
	});

	test("unstamped datagrams are subtracted from the expectation, not ignored", () => {
		expect(
			histogramValidity(
				histogram({ count: 299_990, recordedTotal: 299_990, unstamped: 10 }),
			).valid,
		).toBe(true);
	});
});

describe("arm 1 clauses (§2)", () => {
	test("a clean arm passes every clause", () => {
		const results = steadyArmClauses(steadyArm());
		expect(results.map((r) => r.verdict)).toEqual([
			"PASS",
			"PASS",
			"PASS",
			"PASS",
			"PASS",
			"PASS",
		]);
	});

	test("C1 fails below the 0.995 delivery floor", () => {
		const r = clauseC1(steadyArm({ serverRxUpstream: 2_380_000 }));
		expect(r.verdict).toBe("MISS");
		expect(r.observed.ratio).toBeCloseTo(0.99167, 5);
	});

	test("C2 grades the two classes apart, so snapshots cannot hide the ack path", () => {
		// 9,000,000 snapshots at 1.000 and 300,000 acks at 0.90 would read 0.9968
		// as one aggregate ratio — comfortably above the floor, and wrong.
		const f = steadyArm({ ackClientReceived: 270_000 });
		const aggregate =
			(f.snapshotClientReceived + f.ackClientReceived) /
			(f.snapshotServerIssued + f.ackServerIssued);
		expect(aggregate).toBeGreaterThan(0.995);
		const r = clauseC2(f);
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("C2 ack");
	});

	test("C3 is the raw p99 against the derived 50 ms budget", () => {
		expect(
			clauseC3(steadyArm({ rtt: histogram({ p99Ns: ms(49.9) }) })).verdict,
		).toBe("PASS");
		const r = clauseC3(steadyArm({ rtt: histogram({ p99Ns: ms(50.1) }) }));
		expect(r.verdict).toBe("MISS");
		expect(r.observed.budgetMs).toBe(50);
	});

	test("C4 fails on a lost session even when the percentiles are fine", () => {
		expect(clauseC4(steadyArm({ sessionsLost: 1 })).verdict).toBe("MISS");
		expect(clauseC4(steadyArm({ sessionsActiveAtEnd: 4999 })).verdict).toBe(
			"MISS",
		);
	});

	test("C5 is INCOMPLETE when no kernel tap read — never a zero", () => {
		// The distinction G1 registered: "we saw no drops" and "we could not
		// look" are different statements, and only one of them is evidence.
		const f = steadyArm();
		f.ledger.kernelDropsSocket = null;
		f.ledger.kernelRcvbufErrors = null;
		const r = clauseC5(f);
		expect(r.verdict).toBe("INCOMPLETE");
		expect(r.reasons.join(" ")).toContain("INCOMPLETE, not zero");
	});

	test("C5 localizes an unattributed remainder to its stage", () => {
		const f = steadyArm();
		f.ledger.jsDelivered = 2_300_000; // native lost 100k with no counter
		const r = clauseC5(f);
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("native residual");
		expect(r.observed.residualNative).toBe(100_000);
	});

	test("C5 tolerates the kernel drops T02 taught us to expect, as long as they account", () => {
		const f = steadyArm();
		f.ledger.kernelDropsSocket = 5_000;
		f.ledger.serverObserved = 2_395_000;
		f.ledger.jsDelivered = 2_395_000;
		const r = clauseC5(f);
		expect(r.verdict).toBe("PASS");
		expect(r.observed.residualKernel).toBe(0);
	});

	test("C6 fails a partially completed batch instead of forgiving the remainder", () => {
		const r = clauseC6(
			steadyArm({
				emitter: { ...steadyArm().emitter, batchPartialCompletions: 12 },
			}),
		);
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("partially");
	});

	test("C6 catches an emitter that did not source the registered load", () => {
		const r = clauseC6(
			steadyArm({
				emitter: { ...steadyArm().emitter, snapshotIssued: 8_000_000 },
			}),
		);
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("C6 snapshot");
	});
});

describe("arm 2 clauses (§3)", () => {
	const hotspot = (over: Partial<HotspotFacts> = {}): HotspotFacts => ({
		subscribers: 40,
		oneWay: histogram({
			name: "oneWay",
			p99Ns: ms(9),
			count: 96_000,
			recordedTotal: 96_000,
			expectedSamples: 96_000,
		}),
		ingested: 2_400,
		forwarded: 96_000,
		subscriberReceived: 96_000,
		pathP50Ns: 1_400_000,
		serverForwardDwellP50Ns: 14_000,
		frameGapFraction: 1,
		datagramsPerTick: 1,
		publisherStamped: 2_400,
		...over,
	});

	test("H1 uses one leg of the round-trip budget", () => {
		expect(clauseH1(hotspot()).observed.budgetMs).toBe(25);
		expect(
			clauseH1(
				hotspot({
					oneWay: histogram({
						name: "oneWay",
						p99Ns: ms(26),
						expectedSamples: null,
					}),
				}),
			).verdict,
		).toBe("MISS");
	});

	test("V-I fires on the retracted run's own µs-scale ingest signature", () => {
		// 9–31 µs of "ingest-to-forward" while the ladder beside it read
		// milliseconds: a path that never contained a network.
		const r = falsifierIngestReality(hotspot({ pathP50Ns: 31_000 }));
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("run");
		expect(r.reasons.join(" ")).toContain("lag-microsecond");
	});

	test("V-I fires when the arrivals are not the publisher's stamped datagrams", () => {
		expect(
			falsifierIngestReality(hotspot({ publisherStamped: 1_000 })).fired,
		).toBe(true);
	});

	test("V-I passes a real cabled publisher", () => {
		expect(falsifierIngestReality(hotspot()).fired).toBe(false);
	});

	test("V-I is not fed the server's own forward dwell", () => {
		// The dwell is one process on one clock and is µs-scale on every valid
		// run; feeding it to the µs-signature rule would fire the falsifier
		// against reality. Amendment 2 is exactly this correction.
		expect(
			falsifierIngestReality(hotspot({ serverForwardDwellP50Ns: 9_000 })).fired,
		).toBe(false);
	});

	test("H2 divides by ingested × N, not by what the server chose to forward", () => {
		// Forwarding less than the shape called for must show up as missing
		// delivery, not be normalized away by using `forwarded` as denominator.
		const r = clauseH2(hotspot({ subscriberReceived: 80_000 }));
		expect(r.verdict).toBe("MISS");
		expect(r.observed.expected).toBe(96_000);
	});
});

describe("arm 3 clauses (§5)", () => {
	const storm = (over: Partial<StormFacts> = {}): StormFacts => ({
		cohort: 1000,
		realmSessions: 5000,
		survivors: {
			sessions: 4000,
			rtt: histogram({
				name: "survivorRtt",
				p99Ns: ms(21),
				count: 240_000,
				recordedTotal: 240_000,
				expectedSamples: 240_000,
			}),
			clientEnqueuedUpstream: 1_920_000,
			serverRxUpstream: 1_920_000,
			sessionsLost: 0,
		},
		reAcceptedInWindow: 1000,
		sessionsActiveAtWindowClose: 5000,
		limitExceededDelta: 0,
		rateLimitedDelta: 0,
		stormWindowSec: 120,
		...over,
	});

	test("S-C1 holds the survivors to the same budget as a calm realm", () => {
		expect(clauseSC1(storm()).verdict).toBe("PASS");
		const hurt = storm();
		if (hurt.survivors)
			hurt.survivors.rtt = histogram({
				name: "survivorRtt",
				p99Ns: ms(63),
				expectedSamples: null,
			});
		const r = clauseSC1(hurt);
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("survivor RTT");
	});

	test("S-C1 does not apply when the whole realm was severed", () => {
		const r = clauseSC1(storm({ cohort: 5000, survivors: null }));
		expect(r.verdict).toBe("INCOMPLETE");
		expect(r.reasons.join(" ")).toContain("whole realm was severed");
	});

	test("S-C2 fails a cohort that did not all come back inside the window", () => {
		const r = clauseSC2(storm({ reAcceptedInWindow: 987 }));
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("987 of 1000");
	});

	test("S-C2 fails on a server-side limiter, which is a configuration finding", () => {
		expect(clauseSC2(storm({ limitExceededDelta: 3 })).verdict).toBe("MISS");
		expect(clauseSC2(storm({ rateLimitedDelta: 3 })).verdict).toBe("MISS");
	});
});

describe("§7 falsifiers", () => {
	test("V-L fires on the exact retracted signature", () => {
		// The four-axes retraction: acceptsPerSec × mean accept latency ≈ 500 =
		// the client's own connect semaphore, at every rung.
		const r = falsifierLittle({
			acceptRatePerSec: 625,
			meanAcceptLatencySec: 0.8,
			connectConcurrency: 500,
		});
		expect(r.fired).toBe(true);
		expect(r.reasons[0]).toContain("generator, not the server");
	});

	test("V-L cannot fire when the storm ran with no permit pool", () => {
		// The registered configuration: connect concurrency = cohort size, so
		// there is no pool for Little's law to be measuring.
		expect(
			falsifierLittle({
				acceptRatePerSec: 900,
				meanAcceptLatencySec: 1.2,
				connectConcurrency: null,
			}).fired,
		).toBe(false);
	});

	test("V-L only strips verdict force from the characterization", () => {
		expect(
			falsifierLittle({
				acceptRatePerSec: 625,
				meanAcceptLatencySec: 0.8,
				connectConcurrency: 500,
			}).scope,
		).toBe("characterization");
	});

	test("V-F fires on a floor the size of a fifth of the budget", () => {
		const base = {
			scheduleLagMaxMs: 40.6,
			floorArmDateIso: "2026-08-19T09:00:00Z",
			runDateIso: "2026-08-19T11:00:00Z",
			generatorHostMatches: true,
			drivingSessions: 20,
		};
		expect(falsifierFloor({ ...base, scheduleLagP99Ms: 2.1 }).fired).toBe(
			false,
		);
		const r = falsifierFloor({ ...base, scheduleLagP99Ms: 12.5 });
		expect(r.fired).toBe(true);
		expect(r.reasons[0]).toContain("> 10 ms");
	});

	test("V-F refuses a floor from the wrong day, the wrong host or no sessions", () => {
		const base = {
			scheduleLagP99Ms: 1,
			scheduleLagMaxMs: 5,
			runDateIso: "2026-08-19T11:00:00Z",
			generatorHostMatches: true,
			drivingSessions: 20,
		};
		expect(
			falsifierFloor({ ...base, floorArmDateIso: "2026-08-18T23:00:00Z" })
				.fired,
		).toBe(true);
		expect(
			falsifierFloor({
				...base,
				floorArmDateIso: "2026-08-19T09:00:00Z",
				generatorHostMatches: false,
			}).fired,
		).toBe(true);
		expect(
			falsifierFloor({
				...base,
				floorArmDateIso: "2026-08-19T09:00:00Z",
				drivingSessions: 0,
			}).fired,
		).toBe(true);
		expect(falsifierFloor({ ...base, floorArmDateIso: null }).fired).toBe(true);
	});

	test("V-S needs 1.5× the arm's downstream and a pre-check that meant something", () => {
		const base = {
			armDownstreamPps: 77_500,
			precheckOfferedPps: 120_000,
			precheckDeliveryRatio: 0.999,
			precheckOriginatorSaturated: false,
		};
		expect(falsifierSink(base).fired).toBe(false);
		// Under-driven: 100k is below 1.5 × 77.5k.
		expect(falsifierSink({ ...base, precheckOfferedPps: 100_000 }).fired).toBe(
			true,
		);
		// Starved originator: a slow generator looks exactly like a healthy sink.
		expect(
			falsifierSink({ ...base, precheckOriginatorSaturated: true }).fired,
		).toBe(true);
		expect(falsifierSink({ ...base, precheckDeliveryRatio: 0.98 }).fired).toBe(
			true,
		);
		expect(falsifierSink({ ...base, precheckOfferedPps: null }).fired).toBe(
			true,
		);
	});

	test("V-S boundary is exact: one packet below the floor fires, equality clears", () => {
		const base = {
			armDownstreamPps: 77_500,
			precheckDeliveryRatio: 0.999,
			precheckOriginatorSaturated: false,
		};
		// The evaluator floor is exact: one packet below 1.5 × 77,500 fires.
		const justBelow = falsifierSink({
			...base,
			precheckDeliveryRatio: 1,
			precheckOfferedPps: 116_249.999,
		});
		expect(justBelow.fired).toBe(true);
		expect(justBelow.reasons.join(" ")).toContain("needs 116250");
		// Equality clears the floor; there is no tolerance or rounding band.
		const exactlyAtFloor = falsifierSink({
			...base,
			precheckDeliveryRatio: 1,
			precheckOfferedPps: 116_250,
		});
		expect(exactlyAtFloor).toMatchObject({
			id: "V-S",
			fired: false,
			reasons: [],
			scope: "run",
		});
		// Delivery boundary: 0.994999 fires, 0.995 clears, at full offer.
		const lossy = falsifierSink({
			...base,
			precheckDeliveryRatio: 0.994_999,
			precheckOfferedPps: 120_000,
		});
		expect(lossy.fired).toBe(true);
		const atDeliveryFloor = falsifierSink({
			...base,
			precheckDeliveryRatio: 0.995,
			precheckOfferedPps: 120_000,
		});
		expect(atDeliveryFloor.fired).toBe(false);
	});

	test("V-S evaluator constants stay frozen at their registered values", async () => {
		const g6plan = await import("./g6-plan.ts");
		expect(g6plan.DELIVERY_FLOOR).toBe(0.995);
		expect(g6plan.SINK_HEADROOM_FACTOR).toBe(1.5);
		expect(g6plan.SINK_DELIVERY_FLOOR).toBe(0.995);
	});

	test("V-G fires on a generator that could not source a rung", () => {
		expect(
			falsifierGenerator({
				offeredRatioByRung: [
					{ sessions: 500, offeredRatio: 1 },
					{ sessions: 2500, offeredRatio: 0.9999 },
					{ sessions: 5000, offeredRatio: 0.94 },
				],
			}).fired,
		).toBe(true);
	});

	test("V-G reports a missing ratio rather than assuming it was fine", () => {
		expect(
			falsifierGenerator({
				offeredRatioByRung: [{ sessions: 5000, offeredRatio: null }],
			}).fired,
		).toBe(true);
	});
});

describe("run roll-up — the G3b failure mode, closed", () => {
	test("a firing run-level falsifier stamps INVALID over clauses that computed PASS", () => {
		const clauses = steadyArmClauses(steadyArm());
		expect(clauses.every((c) => c.verdict === "PASS")).toBe(true);
		const verdict = rollUp(clauses, [
			falsifierHistograms([histogram({ negative: 4 })]),
		]);
		expect(verdict.gate).toBe("INVALID");
		expect(verdict.valid).toBe(false);
		// Published, not withheld — G3b's precedent.
		expect(verdict.clauses).toHaveLength(6);
	});

	test("a characterization-only falsifier does not void the gate", () => {
		const verdict = rollUp(steadyArmClauses(steadyArm()), [
			falsifierLittle({
				acceptRatePerSec: 625,
				meanAcceptLatencySec: 0.8,
				connectConcurrency: 500,
			}),
		]);
		expect(verdict.gate).toBe("PASS");
		expect(verdict.characterizationOnlyReasons).toHaveLength(1);
	});

	test("a miss outranks an incomplete", () => {
		const f = steadyArm({ serverRxUpstream: 2_000_000 });
		f.ledger.kernelDropsSocket = null;
		f.ledger.kernelRcvbufErrors = null;
		expect(rollUp(steadyArmClauses(f), []).gate).toBe("MISS");
	});

	test("a clean run with a missing tap is INCOMPLETE, not PASS", () => {
		const f = steadyArm();
		f.ledger.kernelDropsSocket = null;
		f.ledger.kernelRcvbufErrors = null;
		expect(rollUp(steadyArmClauses(f), []).gate).toBe("INCOMPLETE");
	});
});
