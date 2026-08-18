import { describe, expect, test } from "bun:test";
import {
	type ClassifiedStep,
	alignmentBucketFor,
	bucketFor,
	classify,
	classifySteps,
	compareAlignment,
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
			effectiveRatePerSession: 326,
		},
		clientReceived: received,
		client: {
			egressOneWay: flat((shape.oneWayMs ?? 2) * MS, samples),
			endToEnd: flat((shape.endToEndMs ?? 3) * MS, samples),
			recvUnstamped: 0,
		},
		downDeliveryRatio: sent > 0 ? received / sent : null,
		hostCpuPctMedian: 60,
		serverCpuPct: 90,
		ingested: 0,
		forwardLag: null,
	};
	return { ...base, ...overrides } as RawStep;
}

describe("latency buckets sit exactly on the registered boundaries", () => {
	test.each([
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

	test.each([
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
		const [s] = classifySteps(
			[step({ hostCpuPctMedian: 99 }, { sent: 20_000, received: 18_000 })],
			0,
		);
		expect(s?.complete).toBe(true);
		expect(s?.coResidenceBound).toBe(true);
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
	test("scaling is reported raw against the smallest N", () => {
		const steps = classifySteps(
			[
				step({
					shape: "fanout",
					sessionsConnected: 10,
					sessionsRequested: 10,
					client: {
						egressOneWay: flat(4 * MS, 20_000),
						endToEnd: flat(5 * MS, 20_000),
						recvUnstamped: 0,
					},
				}),
				step({
					shape: "fanout",
					sessionsConnected: 100,
					sessionsRequested: 100,
					client: {
						egressOneWay: flat(16 * MS, 20_000),
						endToEnd: flat(17 * MS, 20_000),
						recvUnstamped: 0,
					},
				}),
			],
			0,
		);
		const out = summarizeFanout(steps);
		expect(out[0]?.scaling).toBe(1);
		expect(out[1]?.scaling).toBeCloseTo(4, 1);
		expect(out[1]?.bucket).toBe("ok-interactive");
	});
});

describe("the run-level generator gate", () => {
	const steps: ClassifiedStep[] = classifySteps([step()], 0);
	const profiles = [verdictForProfile("constant", steps)];
	const delivered = steps[0]?.deliveredPerSec ?? 0;

	test("a generator that barely outruns the transport voids the run", () => {
		const v = verdictForRun(steps, Math.round(delivered * 1.2), profiles);
		expect(v.complete).toBe(false);
		expect(v.stop).toBe("generator-headroom");
	});

	test("1.5x headroom is the registered pass", () => {
		const v = verdictForRun(steps, Math.ceil(delivered * 1.5), profiles);
		expect(v.complete).toBe(true);
		expect(v.stop).toBeNull();
	});

	test("a stopped constant arm voids the run even with headroom", () => {
		const stopped = classifySteps(
			[step({}, { sent: 20_000, received: 2_000 })],
			0,
		);
		const v = verdictForRun(stopped, 10_000_000, [
			verdictForProfile("constant", stopped),
		]);
		expect(v.stop).toBe("constant-arm-incomplete");
	});
});

describe("fragment merge", () => {
	test("the generator fragment supplies the ceiling and the clock residual is the worst seen", () => {
		const result = classify([
			{
				shape: "generator",
				clock: { calibrationResidualNs: 0, source: "ffi" },
				generator: { ceilingPerSec: 240_000, rungs: [] },
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
