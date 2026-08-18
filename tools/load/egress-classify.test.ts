import { describe, expect, test } from "bun:test";
import {
	type AlignmentBucket,
	alignmentBucketFor,
	bucketFor,
	type ClassifiedStep,
	classify,
	classifySteps,
	compareAlignment,
	type EgressBucket,
	type StopReason,
	summarizeFanout,
	verdictForProfile,
	verdictForRun,
} from "./egress-classify.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

const MS = 1e6;

function hist(
	valuesNs: number[],
	negative = 0,
): ReturnType<LatencyHistogram["toJson"]> {
	const h = new LatencyHistogram();
	for (const v of valuesNs) h.record(v);
	const json = h.toJson();
	json.negative = negative;
	return json;
}

/** A histogram of `n` samples all at `ns`, so percentiles are unambiguous. */
function flat(ns: number, n: number, negative = 0) {
	return hist(new Array(n).fill(ns), negative);
}

type RawStep = Parameters<typeof classifySteps>[0][number];

/**
 * A rung whose counters are internally consistent: the stamped-sample count,
 * the delivered count and the offered count have to agree or the fixture trips
 * STOPs that have nothing to do with what the test is about.
 */
function step(
	overrides: Partial<RawStep> = {},
	shape: {
		samples?: number;
		sent?: number;
		received?: number;
		oneWayMs?: number;
		endToEndMs?: number;
	} = {},
): RawStep {
	const sent = shape.sent ?? 20_000;
	const received = shape.received ?? sent;
	const samples = shape.samples ?? received;
	const base: RawStep = {
		shape: "ladder",
		profile: "constant",
		perSessionRate: 326,
		sessionsRequested: 100,
		sessionsConnected: 100,
		aggregateRate: 32_600,
		elapsedSec: 45,
		originator: {
			sent,
			sendErrors: 0,
			sendEventsScheduled: 2_000,
			sendEventsSkipped: 0,
			scheduledDatagrams: sent,
			originationLag: flat(1 * MS, 1000),
			sendIssueSpread: flat(0, 1000),
			peakWindowDatagrams: 326,
			driveWindowSec: 45,
		},
		clientReceived: received,
		client: {
			egressOneWay: flat((shape.oneWayMs ?? 2) * MS, samples),
			endToEnd: flat((shape.endToEndMs ?? 3) * MS, samples),
			recvUnstamped: 0,
		},
		downDeliveryRatio: sent > 0 ? received / sent : null,
		// Percent of one core on a 4 vCPU rig: 60 of a possible 400.
		hostCpuPctMedian: 60,
		hostCpuCount: 4,
		serverCpuPct: 90,
		ingested: 0,
		forwardLag: null,
	};
	return { ...base, ...overrides } as RawStep;
}

type FanoutRecordJson = NonNullable<RawStep["fanout"]>;

/**
 * A fan-out rung that clears both registered falsifiers, so a test can knock out
 * exactly the one condition it is about. The ingest lag is a millisecond and the
 * cadence is one long gap per 11-datagram tick burst — a real loopback path.
 */
function fanoutStep(
	subscribers: number,
	oneWayMs: number,
	fanoutOverrides: Partial<FanoutRecordJson> = {},
	stepOverrides: Partial<RawStep> = {},
): RawStep {
	// Enough forwards to clear the 10k-sample floor, and the stamped-sample count
	// has to equal what the subscriber received or the fixture trips
	// `clock-invalid` for reasons that have nothing to do with the test.
	const ingested = Math.ceil(20_000 / subscribers);
	const forwarded = ingested * subscribers;
	const fanout: FanoutRecordJson = {
		mode: "per-subscriber",
		publisherRatePerSec: 330,
		datagramsPerTick: 11,
		ingested,
		publisherStamped: ingested,
		forwarded,
		forwardDeliveryRatio: 1,
		frameGapFraction: 1 / 11,
		ingestToForward: flat(0.9 * MS, 1000),
		forwardIssueSpread: flat(0.2 * MS, 1000),
		forwardSettle: flat(1 * MS, 1000),
		ingestReality: { real: true, reasons: [] },
		publisherShortfall: false,
		forwardShortfall: false,
		precheck: { outcome: "pass" },
		...fanoutOverrides,
	};
	return step({
		shape: "fanout",
		perSessionRate: 330,
		sessionsRequested: subscribers,
		sessionsConnected: subscribers,
		aggregateRate: 330 * subscribers,
		ingested,
		forwardLag: flat(30_000, 1000),
		fanout,
		originator: {
			sent: forwarded,
			sendErrors: 0,
			sendEventsScheduled: ingested,
			sendEventsSkipped: 0,
			scheduledDatagrams: forwarded,
			originationLag: flat(0.9 * MS, 1000),
			sendIssueSpread: flat(0.2 * MS, 1000),
			peakWindowDatagrams: 11 * subscribers,
			gridPeriodNs: Math.round(1e9 / 30),
			driveWindowSec: 45,
		},
		clientReceived: forwarded,
		client: {
			egressOneWay: flat(oneWayMs * MS, forwarded),
			endToEnd: flat((oneWayMs + 1) * MS, forwarded),
			recvUnstamped: 0,
		},
		downDeliveryRatio: 1,
		...stepOverrides,
	});
}

describe("latency buckets sit exactly on the registered boundaries", () => {
	test.each<[number, EgressBucket]>([
		[4.9, "ok-realtime"],
		[5.0, "ok-interactive"],
		[19.9, "ok-interactive"],
		[20.0, "ok-frame"],
		[33.2, "ok-frame"],
		[33.3, "degraded"],
		[99.9, "degraded"],
		[100, "unusable"],
	])("p99 %s ms -> %s", (ms, expected) => {
		expect(bucketFor(ms * MS)).toBe(expected);
	});

	test.each<[number, AlignmentBucket]>([
		[0.9, "alignment-free"],
		[1.0, "alignment-cheap"],
		[9.9, "alignment-cheap"],
		[10, "alignment-expensive"],
		[33.3, "alignment-fatal"],
	])("alignment delta %s ms -> %s", (ms, expected) => {
		expect(alignmentBucketFor(ms * MS)).toBe(expected);
	});
});

describe("STOP conditions", () => {
	test("a clean step is complete and bucketed", () => {
		const [s] = classifySteps([step()], 0);
		expect(s?.complete).toBe(true);
		expect(s?.bucket).toBe("ok-realtime");
		expect(s?.stop).toBeNull();
	});

	test("skipping a tenth of the send events stops the step", () => {
		const [s] = classifySteps(
			[
				step({
					originator: {
						...step().originator,
						sendEventsSkipped: 90_000,
					},
				}),
			],
			0,
		);
		expect(s?.stop).toBe("generator-saturation");
		expect(s?.bucket).toBeNull();
	});

	test("origination lag four times its own arm's floor stops the step", () => {
		const cheap = step({ perSessionRate: 110, aggregateRate: 11_000 });
		const expensive = step({
			perSessionRate: 815,
			aggregateRate: 81_500,
			originator: { ...step().originator, originationLag: flat(4 * MS, 1000) },
		});
		const out = classifySteps([cheap, expensive], 0);
		expect(out[0]?.complete).toBe(true);
		expect(out[1]?.stop).toBe("generator-saturation");
	});

	test("a within-arm floor is not itself a saturation", () => {
		// Every step lags by the same platform-fixed amount: that is granularity,
		// not queueing, and it must not void the arm.
		const out = classifySteps([step(), step({ perSessionRate: 815 })], 0);
		expect(out.every((s) => s.complete)).toBe(true);
	});

	test("issuing under 90% of the scheduled datagrams stops the step", () => {
		const [s] = classifySteps(
			[step({ originator: { ...step().originator, sent: 1_000 } })],
			0,
		);
		expect(s?.stop).toBe("offered-shortfall");
	});

	test("sessions that never connected stop the step", () => {
		const [s] = classifySteps([step({ sessionsConnected: 80 })], 0);
		expect(s?.stop).toBe("offered-shortfall");
	});

	test("a clock residual above 50us voids every step", () => {
		const [s] = classifySteps([step()], 60_000);
		expect(s?.stop).toBe("clock-invalid");
	});

	test("negative one-way samples above 0.1% void the step", () => {
		const [s] = classifySteps(
			[
				step({
					client: {
						egressOneWay: flat(2 * MS, 20_000, 100),
						endToEnd: flat(3 * MS, 20_000),
						recvUnstamped: 0,
					},
				}),
			],
			0,
		);
		expect(s?.stop).toBe("clock-invalid");
	});

	test("one-way above end-to-end is impossible and voids the step", () => {
		const [s] = classifySteps(
			[
				step({
					client: {
						egressOneWay: flat(9 * MS, 20_000),
						endToEnd: flat(3 * MS, 20_000),
						recvUnstamped: 0,
					},
				}),
			],
			0,
		);
		expect(s?.stop).toBe("clock-invalid");
	});

	test("unstamped receives mean the two ends disagree and void the step", () => {
		const [s] = classifySteps(
			[
				step({
					clientReceived: 30_000,
					client: {
						egressOneWay: flat(2 * MS, 20_000),
						endToEnd: flat(3 * MS, 20_000),
						recvUnstamped: 10_000,
					},
				}),
			],
			0,
		);
		expect(s?.stop).toBe("clock-invalid");
	});

	test("losing a fifth of the load stops the step before it is bucketed", () => {
		const [s] = classifySteps(
			[step({}, { sent: 20_000, received: 14_000 })],
			0,
		);
		expect(s?.stop).toBe("delivery-collapse");
	});

	test("too few samples stops the step", () => {
		const [s] = classifySteps([step({}, { sent: 500, received: 500 })], 0);
		expect(s?.stop).toBe("sample-starvation");
	});

	test("STOPs are evaluated in the registered order", () => {
		// Saturation and shortfall are both true; saturation is registered first.
		const [s] = classifySteps(
			[
				step({
					originator: {
						...step().originator,
						sendEventsSkipped: 200_000,
						sent: 1000,
					},
				}),
			],
			0,
		);
		expect(s?.stop).toBe("generator-saturation");
	});

	test("co-residence is labelled, never a STOP", () => {
		// 390 of a possible 400 on the 4 vCPU rig: over the registered 97% of the
		// host, in the percent-of-one-core unit every axis reports.
		const [s] = classifySteps(
			[step({ hostCpuPctMedian: 390 }, { sent: 20_000, received: 18_000 })],
			0,
		);
		expect(s?.complete).toBe(true);
		expect(s?.coResidenceBound).toBe(true);
	});

	test("co-residence reads 97% of the host, not 97% of one core", () => {
		// The old threshold was a bare 97, which in this unit is under one core
		// busy — it would have labelled a nearly idle rig as co-residence-bound.
		const [s] = classifySteps(
			[step({ hostCpuPctMedian: 100 }, { sent: 20_000, received: 18_000 })],
			0,
		);
		expect(s?.coResidenceBound).toBe(false);
	});
});

describe("rates divide by the drive window", () => {
	test("the sampler join and the client's exit are outside the denominator", () => {
		const base = step({}, { sent: 45_000, received: 45_000 });
		const [s] = classifySteps(
			[
				{
					...base,
					// Six seconds of sampler join and client reaping past the drive.
					elapsedSec: 51,
					originator: { ...base.originator, driveWindowSec: 45 },
				},
			],
			0,
		);
		expect(s?.driveWindowSec).toBe(45);
		expect(s?.elapsedSec).toBe(51);
		expect(s?.deliveredPerSec).toBeCloseTo(1000, 5);
		expect(s?.offeredPerSec).toBeCloseTo(1000, 5);
	});
});

describe("capacity under the registered gates", () => {
	const ladder = (p99sMs: number[]) =>
		classifySteps(
			p99sMs.map((ms, i) =>
				step({
					perSessionRate: 100 * (i + 1),
					aggregateRate: 10_000 * (i + 1),
					client: {
						egressOneWay: flat(ms * MS, 20_000),
						endToEnd: flat((ms + 1) * MS, 20_000),
						recvUnstamped: 0,
					},
				}),
			),
			0,
		);

	test("capacity is the highest complete rung under each gate", () => {
		const steps = ladder([1, 2, 8, 30, 60]);
		const v = verdictForProfile("constant", steps);
		expect(v.capacityRealtimePerSec).toBe(20_000);
		expect(v.capacityFramePerSec).toBe(40_000);
		expect(v.realtimeIsFloor).toBe(false);
	});

	test("a gate the top rung still clears is reported as a floor", () => {
		const steps = ladder([1, 1, 1]);
		const v = verdictForProfile("constant", steps);
		expect(v.capacityRealtimePerSec).toBe(30_000);
		expect(v.realtimeIsFloor).toBe(true);
	});

	test("an incomplete top rung leaves the capacity below it a floor", () => {
		// No crossing was ever observed: the rung above was excluded, and an
		// excluded rung is evidence of nothing. Reading it as a point estimate
		// would claim more than the run saw.
		const steps = classifySteps(
			[
				step({ perSessionRate: 100, aggregateRate: 10_000 }),
				step(
					{ perSessionRate: 200, aggregateRate: 20_000 },
					{ sent: 20_000, received: 2_000 },
				),
			],
			0,
		);
		const v = verdictForProfile("constant", steps);
		expect(v.capacityRealtimePerSec).toBe(10_000);
		expect(v.realtimeIsFloor).toBe(true);
	});

	test("a complete rung that crossed the gate ends the floor", () => {
		const steps = ladder([1, 60]);
		const v = verdictForProfile("constant", steps);
		expect(v.capacityRealtimePerSec).toBe(10_000);
		expect(v.realtimeIsFloor).toBe(false);
	});

	test("an arm whose loaded rungs all stopped contributes nothing", () => {
		const steps = classifySteps(
			[
				step({ perSessionRate: 110, aggregateRate: 11_000 }),
				step(
					{ perSessionRate: 326, aggregateRate: 32_600 },
					{ sent: 20_000, received: 2_000 },
				),
			],
			0,
		);
		const v = verdictForProfile("constant", steps);
		expect(v.armComplete).toBe(false);
		expect(v.capacityRealtimePerSec).toBeNull();
	});
});

describe("alignment A/B", () => {
	test("the delta is bucketed and confounding is flagged", () => {
		const steps = classifySteps(
			[
				step({
					profile: "frame-bursty",
					client: {
						egressOneWay: flat(4 * MS, 20_000),
						endToEnd: flat(5 * MS, 20_000),
						recvUnstamped: 0,
					},
				}),
				step(
					{ profile: "keyframe-aligned" },
					{ sent: 20_000, received: 18_000, oneWayMs: 19, endToEndMs: 20 },
				),
			],
			0,
		);
		const [cmp] = compareAlignment(steps);
		expect(cmp?.bucket).toBe("alignment-expensive");
		expect(cmp?.abConfounded).toBe(true);
	});

	test("an incomplete rung is never compared", () => {
		const steps = classifySteps(
			[
				step({ profile: "frame-bursty" }),
				step(
					{ profile: "keyframe-aligned" },
					{ sent: 20_000, received: 2_000 },
				),
			],
			0,
		);
		expect(compareAlignment(steps)).toHaveLength(0);
	});
});

describe("fan-out", () => {
	test("scaling is reported raw against the smallest complete N of the sweep", () => {
		const steps = classifySteps([fanoutStep(10, 4), fanoutStep(100, 16)], 0);
		const out = summarizeFanout(steps);
		expect(out[0]?.complete).toBe(true);
		expect(out[0]?.scaling).toBe(1);
		expect(out[1]?.scaling).toBeCloseTo(4, 1);
		expect(out[1]?.bucket).toBe("ok-interactive");
	});

	test("the send-cost instrument is reported, not left empty", () => {
		const out = summarizeFanout(classifySteps([fanoutStep(50, 4)], 0));
		expect(out[0]?.forwardIssueSpreadP99Ms).toBeCloseTo(0.2, 1);
		expect(out[0]?.forwardIssuePerTargetNs).toBeGreaterThan(0);
		expect(out[0]?.ingestToForwardP50Ms).toBeCloseTo(0.9, 1);
	});

	/**
	 * The two sweeps carry different forward load at the same N, so anchoring one
	 * on the other would report the rate effect under N's name — the confound the
	 * retracted arm was built on.
	 */
	test("the two sweeps are never anchored on each other", () => {
		const steps = classifySteps(
			[
				fanoutStep(10, 4),
				fanoutStep(10, 12, {
					mode: "constant-aggregate",
					publisherRatePerSec: 1650,
				}),
			],
			0,
		);
		const out = summarizeFanout(steps);
		expect(out.map((f) => f.mode)).toEqual([
			"per-subscriber",
			"constant-aggregate",
		]);
		expect(out[0]?.scaling).toBe(1);
		expect(out[1]?.scaling).toBe(1);
	});

	test("an incomplete rung anchors nothing", () => {
		const steps = classifySteps(
			[
				fanoutStep(10, 4, { precheck: { outcome: "sink-saturation" } }),
				fanoutStep(50, 9),
			],
			0,
		);
		const out = summarizeFanout(steps);
		expect(out[0]?.complete).toBe(false);
		expect(out[0]?.scaling).toBeNull();
		// The 50-rung is the first complete one, so the curve starts there.
		expect(out[1]?.scaling).toBe(1);
	});

	test("a healthy rung clears both falsifiers", () => {
		const [s] = classifySteps([fanoutStep(50, 9)], 0);
		expect(s?.stop).toBeNull();
		expect(s?.complete).toBe(true);
	});

	test.each<[string, Partial<FanoutRecordJson>, string]>([
		[
			"a µs-scale ingest path",
			{ ingestReality: { real: false, reasons: ["lag-microsecond"] } },
			"ingest-unreal",
		],
		[
			"a saturated sink",
			{ precheck: { outcome: "sink-saturation" } },
			"sink-saturation",
		],
		[
			"a pre-check whose own generator saturated",
			{ precheck: { outcome: "sink-precheck-inconclusive" } },
			"sink-precheck-inconclusive",
		],
		[
			"a publisher that under-offered",
			{ publisherShortfall: true },
			"publisher-shortfall",
		],
		[
			"a forward side that dropped sends",
			{ forwardShortfall: true },
			"forward-shortfall",
		],
	])("%s stops the rung with %s", (_name, overrides, expected) => {
		const [s] = classifySteps([fanoutStep(50, 9, overrides)], 0);
		expect(s?.complete).toBe(false);
		expect(s?.stop).toBe(expected as StopReason);
	});

	test("the sink pre-check is evaluated before anything downstream of it", () => {
		const [s] = classifySteps(
			[
				fanoutStep(50, 9, {
					precheck: { outcome: "sink-saturation" },
					ingestReality: { real: false, reasons: ["lag-microsecond"] },
					publisherShortfall: true,
				}),
			],
			0,
		);
		expect(s?.stop).toBe("sink-saturation");
	});

	test("a fan-out step with no fan-out record is not a measurement", () => {
		const [s] = classifySteps(
			[step({ shape: "fanout", sessionsConnected: 50, sessionsRequested: 50 })],
			0,
		);
		expect(s?.stop).toBe("ingest-unreal");
	});

	/**
	 * A capacity finding, so it is a label. Marking the rung incomplete over it
	 * would throw away the answer the rung was run to get.
	 */
	test("a server that cannot fan one frame out before the next is labelled, not stopped", () => {
		const [s] = classifySteps(
			[fanoutStep(100, 9, { forwardSettle: flat(40 * MS, 1000) })],
			0,
		);
		expect(s?.complete).toBe(true);
		expect(s?.forwardOverrun).toBe(true);
		expect(classifySteps([fanoutStep(100, 9)], 0)[0]?.forwardOverrun).toBe(
			false,
		);
	});

	test("a fan-out-only fragment set says the headroom rule was never evaluated", () => {
		const steps = classifySteps([fanoutStep(50, 9)], 0);
		const v = verdictForRun(steps, { ceilingPerSec: 0, rungs: [] }, []);
		expect(v.stop).toBe("headroom-not-evaluated");
		expect(v.complete).toBe(false);
	});
});

describe("the run-level generator gate", () => {
	const ceiling = (perSec: number) => ({ ceilingPerSec: perSec, rungs: [] });
	const steps: ClassifiedStep[] = classifySteps([step()], 0);
	const profiles = [verdictForProfile("constant", steps)];
	const offered = steps[0]?.offeredPerSec ?? 0;

	test("a generator that barely outruns what the ladder asked voids the run", () => {
		const v = verdictForRun(steps, ceiling(offered * 1.2), profiles);
		expect(v.complete).toBe(false);
		expect(v.stop).toBe("generator-headroom");
	});

	test("1.5x headroom is the registered pass", () => {
		const v = verdictForRun(steps, ceiling(offered * 1.5), profiles);
		expect(v.complete).toBe(true);
		expect(v.stop).toBeNull();
	});

	test("the denominator is offered load, so saturation cannot buy headroom", () => {
		// The failure the amendment names: a step that delivered a tenth of what
		// it offered. Against delivered, a mediocre generator would clear 1.5x
		// tenfold over; against offered — the load the capacity claim rests on —
		// the same generator fails, which is the correct verdict.
		const starved = classifySteps(
			[step({}, { sent: 20_000, received: 18_000 })].map((s) => ({
				...s,
				clientReceived: 2_000,
				downDeliveryRatio: 0.9,
			})),
			0,
		);
		const delivered = starved[0]?.deliveredPerSec ?? 0;
		const v = verdictForRun(starved, ceiling(delivered * 3), [
			verdictForProfile("constant", starved),
		]);
		expect(v.stop).toBe("generator-headroom");
		expect(v.maxOfferedPerSec).toBeGreaterThan(v.maxDeliveredPerSec);
	});

	test("a missing headroom arm is a stop, never a silent pass", () => {
		const v = verdictForRun(steps, null, profiles);
		expect(v.stop).toBe("generator-headroom");
	});

	test("a falsifier artifact can never carry a capacity number", () => {
		const v = verdictForRun(
			steps,
			{ ceilingPerSec: offered * 100, rungs: [], burnNs: 20_000 },
			profiles,
		);
		expect(v.complete).toBe(false);
		expect(v.stop).toBe("harness-falsifier");
	});

	test("a stopped constant arm voids the run even with headroom", () => {
		const stopped = classifySteps(
			[step({}, { sent: 20_000, received: 2_000 })],
			0,
		);
		const v = verdictForRun(stopped, ceiling(10_000_000), [
			verdictForProfile("constant", stopped),
		]);
		expect(v.stop).toBe("constant-arm-incomplete");
	});
});

describe("fragment merge", () => {
	test("the headroom fragment supplies the ceiling and the clock residual is the worst seen", () => {
		const result = classify([
			{
				shape: "headroom",
				clock: { calibrationResidualNs: 0, source: "ffi" },
				headroom: { ceilingPerSec: 240_000, rungs: [] },
			},
			{
				shape: "ladder",
				profile: "constant",
				clock: { calibrationResidualNs: 120, source: "bun-nanoseconds" },
				steps: [step()],
			},
		]);
		expect(result.run.generatorCeilingPerSec).toBe(240_000);
		expect(result.clockResidualNs).toBe(120);
		expect(result.run.complete).toBe(true);
		expect(result.steps).toHaveLength(1);
	});
});
