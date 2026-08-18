import { describe, expect, test } from "bun:test";
import type { LatencyStep } from "./bench-latency.ts";
import {
	type ArmFragment,
	classifyBatchAb,
	classifyRun,
	classifyStep,
	scheduleLagFloorNs,
} from "./latency-classify.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

const MS = 1e6;

function histogram(valuesNs: number[], negative = 0): LatencyHistogram {
	const h = new LatencyHistogram();
	for (const v of valuesNs) h.record(v);
	for (let i = 0; i < negative; i += 1) h.record(-1);
	return h;
}

/** `n` samples all at `ns`, so every percentile is `ns`. */
function flat(ns: number, n: number): LatencyHistogram {
	return histogram(new Array(n).fill(ns));
}

function fragment(
	arm: string,
	steps: LatencyStep[],
	overrides: Partial<ArmFragment> = {},
): ArmFragment {
	return {
		arm,
		clock: { calibrationResidualNs: 0, source: "ffi" },
		config: {
			sessions: 100,
			payloadBytes: 1150,
			stepSeconds: 60,
			arrival: "uniform",
			tickHz: 64,
			echo: true,
			datagramBatchEnv: null,
		},
		steps,
		...overrides,
	};
}

type StepOverrides = {
	aggregateRate?: number;
	ingestNs?: number;
	rttNs?: number;
	lagNs?: number;
	samples?: number;
	sentFraction?: number;
	upDeliveryRatio?: number;
	negative?: number;
	ticksSkipped?: number;
};

function step(o: StepOverrides = {}): LatencyStep {
	const aggregateRate = o.aggregateRate ?? 50_000;
	const samples = o.samples ?? 60_000;
	const requested = aggregateRate * 60;
	const clientSent = Math.round(requested * (o.sentFraction ?? 1));
	const upDeliveryRatio = o.upDeliveryRatio ?? 1;
	return {
		perSessionRate: aggregateRate / 100,
		aggregateRate,
		elapsedSec: 60,
		requestedDatagrams: requested,
		clientSent,
		clientErr: 0,
		clientReceived: 0,
		serverRx: Math.round(clientSent * upDeliveryRatio),
		serverStamped: samples,
		serverUnstamped: 0,
		echoSent: 0,
		echoErr: 0,
		drainMs: 10_000,
		drainArrivals: 0,
		upDeliveryRatio,
		ingest: histogram(
			new Array(samples).fill(o.ingestNs ?? 0.4 * MS),
			o.negative ?? 0,
		).toJson(),
		client: {
			arrival: "uniform",
			effectiveDatagramsPerSecPerSession: aggregateRate / 100,
			rtt: flat(o.rttNs ?? 3 * MS, 1000).toJson(),
			scheduleLag: flat(o.lagNs ?? 0.01 * MS, 1000).toJson(),
			burstSpread: flat(0, 1000).toJson(),
			echoUnstamped: 0,
			ticksSkipped: o.ticksSkipped ?? 0,
			sendEvents: 1000,
		},
		hostCpuPctMedian: 70,
		serverCpuPct: 90,
		sessionsOk: 100,
		sessionsErr: 0,
	};
}

describe("step classification", () => {
	test("a clean step lands in the p99 bucket", () => {
		const s = classifyStep(
			step({ ingestNs: 0.4 * MS }),
			fragment("default", []),
		);
		expect(s.complete).toBe(true);
		expect(s.bucket).toBe("ok-realtime");

		expect(
			classifyStep(
				step({ ingestNs: 3 * MS, rttNs: 9 * MS }),
				fragment("default", []),
			).bucket,
		).toBe("ok-interactive");
		expect(
			classifyStep(
				step({ ingestNs: 9 * MS, rttNs: 30 * MS }),
				fragment("default", []),
			).bucket,
		).toBe("degraded");
		expect(
			classifyStep(
				step({ ingestNs: 40 * MS, rttNs: 90 * MS }),
				fragment("default", []),
			).bucket,
		).toBe("unusable");
	});

	test("generator saturation wins over every later STOP", () => {
		// Lag far above the arm's floor, and also a shortfall — first rule wins.
		const s = classifyStep(
			step({ lagNs: 5 * MS, sentFraction: 0.5 }),
			fragment("default", []),
			0.01 * MS,
		);
		expect(s.stop).toBe("generator-saturation");
		expect(s.bucket).toBeNull();
	});

	test("lag is judged against the arm's floor, not an absolute threshold", () => {
		// 0.6 ms of lag on a 0.5 ms floor is the platform, not saturation.
		expect(
			classifyStep(
				step({ ingestNs: 1 * MS, lagNs: 0.6 * MS, rttNs: 4 * MS }),
				fragment("default", []),
				0.5 * MS,
			).stop,
		).toBeNull();
		// The same 0.6 ms against a 0.05 ms floor is a twelve-fold rise.
		expect(
			classifyStep(
				step({ ingestNs: 1 * MS, lagNs: 0.6 * MS, rttNs: 4 * MS }),
				fragment("default", []),
				0.05 * MS,
			).stop,
		).toBe("generator-saturation");
	});

	test("dropped send events are saturation on their own", () => {
		expect(
			classifyStep(step({ ticksSkipped: 50 }), fragment("default", [])).stop,
		).toBeNull();
		expect(
			classifyStep(step({ ticksSkipped: 150 }), fragment("default", [])).stop,
		).toBe("generator-saturation");
	});

	test("the floor is the arm's own minimum lag across its ladder", () => {
		const steps = [
			step({ aggregateRate: 10_000, lagNs: 0.4 * MS }),
			step({ aggregateRate: 50_000, lagNs: 0.1 * MS }),
			step({ aggregateRate: 90_000, lagNs: 3 * MS }),
		];
		const floor = scheduleLagFloorNs(steps);
		expect(floor / MS).toBeCloseTo(0.1, 1);
	});

	test("a shortfall below 90% of requested load stops the step", () => {
		expect(
			classifyStep(step({ sentFraction: 0.89 }), fragment("default", [])).stop,
		).toBe("offered-shortfall");
		expect(
			classifyStep(step({ sentFraction: 0.95 }), fragment("default", [])).stop,
		).toBeNull();
	});

	test("negatives, a drifting clock, or one-way above RTT are clock-invalid", () => {
		expect(
			classifyStep(
				step({ samples: 10_000, negative: 200 }),
				fragment("default", []),
			).stop,
		).toBe("clock-invalid");
		expect(
			classifyStep(
				step(),
				fragment("default", [], {
					clock: { calibrationResidualNs: 60_000, source: "bun-nanoseconds" },
				}),
			).stop,
		).toBe("clock-invalid");
		// One-way cannot exceed the round trip that contains it.
		expect(
			classifyStep(
				step({ ingestNs: 8 * MS, rttNs: 4 * MS }),
				fragment("default", []),
			).stop,
		).toBe("clock-invalid");
	});

	test("a missing client block is clock-invalid, not a silent pass", () => {
		const bare = { ...step(), client: null };
		expect(classifyStep(bare, fragment("default", [])).stop).toBe(
			"clock-invalid",
		);
	});

	test("delivery collapse and sample starvation stop the step", () => {
		expect(
			classifyStep(step({ upDeliveryRatio: 0.5 }), fragment("default", []))
				.stop,
		).toBe("delivery-collapse");
		expect(
			classifyStep(step({ samples: 500 }), fragment("default", [])).stop,
		).toBe("sample-starvation");
	});

	test("tick absorption is judged against one 64 Hz period", () => {
		const tick = fragment("tick", [], {
			config: {
				sessions: 100,
				payloadBytes: 1150,
				stepSeconds: 60,
				arrival: "tick",
				tickHz: 64,
				echo: true,
				datagramBatchEnv: null,
			},
		});
		expect(
			classifyStep(step({ ingestNs: 10 * MS, rttNs: 30 * MS }), tick)
				.tickBucket,
		).toBe("tick-absorbed");
		expect(
			classifyStep(step({ ingestNs: 30 * MS, rttNs: 60 * MS }), tick)
				.tickBucket,
		).toBe("tick-overrun");
		expect(
			classifyStep(step({ ingestNs: 10 * MS, rttNs: 30 * MS }), tick)
				.intraTickSpreadMs,
		).toBeCloseTo(0, 1);
	});
});

describe("batch A/B", () => {
	test("pairs arms by rate and buckets the delta", () => {
		const def = fragment("default", []);
		const zero = fragment("batch0", []);
		const steps = [
			classifyStep(
				step({ aggregateRate: 50_000, ingestNs: 1.5 * MS, rttNs: 9 * MS }),
				def,
			),
			classifyStep(step({ aggregateRate: 50_000, ingestNs: 0.4 * MS }), zero),
		];
		const ab = classifyBatchAb(steps);
		expect(ab).toHaveLength(1);
		expect(ab[0]?.deltaMs).toBeCloseTo(1.1, 1);
		expect(ab[0]?.bucket).toBe("batch-expensive");
		expect(ab[0]?.confounded).toBe(false);
	});

	test("a delta inside its own quantization is not resolvable", () => {
		const steps = [
			classifyStep(
				step({ aggregateRate: 50_000, ingestNs: 15 * MS, rttNs: 40 * MS }),
				fragment("default", []),
			),
			classifyStep(
				step({ aggregateRate: 50_000, ingestNs: 15 * MS, rttNs: 40 * MS }),
				fragment("batch0", []),
			),
		];
		const ab = classifyBatchAb(steps)[0];
		expect(ab?.deltaMs).toBe(0);
		expect(ab?.resolvable).toBe(false);
		// Amendment 2: the instrument must resolve well inside the 0.2 ms band.
		expect(ab?.deltaUncertaintyMs).toBeLessThan(0.1);
	});

	test("a delivery-ratio gap marks the comparison confounded", () => {
		const steps = [
			classifyStep(
				step({
					aggregateRate: 50_000,
					ingestNs: 0.4 * MS,
					upDeliveryRatio: 0.99,
				}),
				fragment("default", []),
			),
			classifyStep(
				step({
					aggregateRate: 50_000,
					ingestNs: 0.4 * MS,
					upDeliveryRatio: 0.85,
				}),
				fragment("batch0", []),
			),
		];
		expect(classifyBatchAb(steps)[0]?.confounded).toBe(true);
	});

	test("an incomplete step in either arm removes the rate from the A/B", () => {
		const steps = [
			classifyStep(step({ aggregateRate: 50_000 }), fragment("default", [])),
			classifyStep(
				step({ aggregateRate: 50_000, lagNs: 5 * MS }),
				fragment("batch0", []),
				0.01 * MS,
			),
		];
		expect(classifyBatchAb(steps)).toHaveLength(0);
	});
});

describe("run classification", () => {
	test("crossings and the highest realtime rate come from complete steps only", () => {
		const arm = fragment("default", [
			step({ aggregateRate: 10_000, ingestNs: 0.3 * MS }),
			step({ aggregateRate: 50_000, ingestNs: 0.7 * MS }),
			step({ aggregateRate: 75_000, ingestNs: 2 * MS, rttNs: 9 * MS }),
			step({ aggregateRate: 110_000, ingestNs: 40 * MS, lagNs: 9 * MS }),
		]);
		const result = classifyRun([arm]);
		expect(result.runComplete).toBe(true);
		const verdict = result.arms[0];
		expect(verdict?.highestRealtimeRate).toBe(50_000);
		expect(
			verdict?.crossings.find((c) => c.thresholdMs === 1)?.aggregateRate,
		).toBe(75_000);
		// The 110k step stopped, so it never supplies a 20 ms crossing.
		expect(
			verdict?.crossings.find((c) => c.thresholdMs === 20)?.aggregateRate,
		).toBeNull();
	});

	test("an arm with nothing complete at or above 50k is incomplete, and so is the run", () => {
		const arm = fragment("default", [
			step({ aggregateRate: 10_000 }),
			step({ aggregateRate: 50_000, lagNs: 9 * MS }),
			step({ aggregateRate: 90_000, lagNs: 9 * MS }),
		]);
		const result = classifyRun([arm]);
		expect(result.arms[0]?.complete).toBe(false);
		expect(result.runComplete).toBe(false);
	});
});
