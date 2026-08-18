import { describe, expect, test } from "bun:test";
import type { LatencyStep } from "./bench-latency.ts";
import { classifyAbRun, medianInterval } from "./latency-ab-classify.ts";
import {
	AB_FIRST_PORT,
	AB_REPLICATES,
	AB_RUNGS,
	abSchedule,
} from "./latency-ab-schedule.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

const MS = 1e6;

function flat(ns: number, count: number): LatencyHistogram {
	const h = new LatencyHistogram();
	for (let i = 0; i < count; i += 1) h.record(ns);
	return h;
}

describe("interleave schedule", () => {
	const schedule = abSchedule();

	test("is 86 cells: 4 rungs x 10 pairs x 2 arms, plus 3 floor pairs", () => {
		expect(schedule.length).toBe(AB_RUNGS.length * AB_REPLICATES * 2 + 6);
		expect(schedule.filter((c) => c.isFloor).length).toBe(6);
		for (const arm of ["default", "batch0"] as const) {
			expect(schedule.filter((c) => c.isFloor && c.arm === arm).length).toBe(3);
		}
	});

	test("pairs are adjacent — the two arms of a comparison never run apart", () => {
		const measurement = schedule.filter((c) => !c.isFloor);
		for (let i = 0; i < measurement.length; i += 2) {
			const a = measurement[i];
			const b = measurement[i + 1];
			expect(a).toBeDefined();
			expect(b).toBeDefined();
			expect(b?.rung).toBe(a?.rung as string);
			expect(b?.replicate).toBe(a?.replicate as number);
			expect(b?.arm).not.toBe(a?.arm as string);
			// Adjacent in the dispatch, not merely adjacent in this filtered list.
			expect((b?.index as number) - (a?.index as number)).toBe(1);
		}
	});

	test("ABBA — odd replicates lead with default, even with batch0", () => {
		for (const rung of AB_RUNGS.map((r) => r.rung)) {
			for (let r = 1; r <= AB_REPLICATES; r += 1) {
				const pair = schedule.filter(
					(c) => c.rung === rung && c.replicate === r,
				);
				expect(pair.length).toBe(2);
				expect(pair[0]?.arm).toBe(r % 2 === 1 ? "default" : "batch0");
			}
		}
	});

	test("every rung gets exactly ten replicates of each arm", () => {
		for (const { rung } of AB_RUNGS) {
			for (const arm of ["default", "batch0"] as const) {
				expect(
					schedule.filter((c) => c.rung === rung && c.arm === arm).length,
				).toBe(AB_REPLICATES);
			}
		}
	});

	test("floor arms are spread across the dispatch, not clustered at one end", () => {
		const floors = schedule.filter((c) => c.isFloor).map((c) => c.index);
		expect(floors[0]).toBe(0);
		expect(floors.at(-1)).toBe(schedule.length - 1);
		// One pair lands in the middle third rather than at either edge.
		const middle = floors.filter(
			(i) => i > schedule.length / 3 && i < (2 * schedule.length) / 3,
		);
		expect(middle.length).toBe(2);
	});

	test("no two cells share a port", () => {
		const ports = schedule.map((c) => c.port);
		expect(new Set(ports).size).toBe(ports.length);
		expect(Math.min(...ports)).toBe(AB_FIRST_PORT);
	});
});

describe("order-statistic interval", () => {
	test("n=10 gives the registered k=2 interval at 97.85% coverage", () => {
		const i = medianInterval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(i.k).toBe(2);
		expect(i.lo).toBe(2);
		expect(i.hi).toBe(9);
		expect(i.coverage).toBeCloseTo(0.9785, 4);
		expect(i.median).toBe(5.5);
	});

	test("n=6 still qualifies; n=5 does not and says so", () => {
		expect(medianInterval([1, 2, 3, 4, 5, 6]).k).toBe(1);
		const five = medianInterval([1, 2, 3, 4, 5]);
		expect(five.k).toBeNull();
		expect(five.lo).toBeNull();
		expect(five.median).toBe(3);
	});

	test("the interval is insensitive to one wild value — that is the point", () => {
		const clean = medianInterval([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
		const spiked = medianInterval([10, 10, 10, 10, 10, 10, 10, 10, 10, 9999]);
		expect(spiked.median).toBe(clean.median);
		expect(spiked.hi).toBe(clean.hi);
	});
});

/* ------------------------------------------------------------------ *
 * A synthetic dispatch. Every number here is invented; the assertions
 * are about the rules, never about latency.
 * ------------------------------------------------------------------ */

type CellSpec = {
	arm: "default" | "batch0";
	rung: string;
	replicate: number;
	index: number;
	aggregate: number;
	ingestNs: number;
	egressNs: number;
	lagNs?: number;
	upDeliveryRatio?: number;
	sentFraction?: number;
	hostCpu?: number;
};

function fragmentFor(spec: CellSpec) {
	const drive = 20;
	const requested = spec.aggregate * drive;
	const clientSent = Math.round(requested * (spec.sentFraction ?? 1));
	const up = spec.upDeliveryRatio ?? 1;
	const turnaroundNs = 0.05 * MS;
	const step: LatencyStep = {
		perSessionRate: spec.aggregate / 100,
		aggregateRate: spec.aggregate,
		nominalPerSessionRate: spec.aggregate / 100,
		nominalAggregateRate: spec.aggregate,
		elapsedSec: 22,
		driveWindowSec: drive,
		driveWindowMeasured: true,
		requestedDatagrams: requested,
		clientSent,
		clientErr: 0,
		clientReceived: Math.round(clientSent * up),
		serverRx: Math.round(clientSent * up),
		serverStamped: 200_000,
		serverUnstamped: 0,
		echoSent: Math.round(clientSent * up),
		echoErr: 0,
		echoStampFailures: 0,
		drainMs: 6000,
		drainArrivals: 0,
		upDeliveryRatio: up,
		ingest: flat(spec.ingestNs, 200_000).toJson(),
		turnaround: flat(turnaroundNs, 1000).toJson(),
		client: {
			arrival: "uniform",
			effectiveDatagramsPerSecPerSession: spec.aggregate / 100,
			rtt: flat(spec.ingestNs + turnaroundNs + spec.egressNs, 1000).toJson(),
			scheduleLag: flat(spec.lagNs ?? 0.05 * MS, 1000).toJson(),
			burstSpread: flat(0, 1000).toJson(),
			egressOneWay: flat(spec.egressNs, 1000).toJson(),
			upstreamPlusTurnaround: flat(spec.ingestNs + turnaroundNs, 1000).toJson(),
			echoMissingEchoInstant: 0,
			echoUnstamped: 0,
			ticksSkipped: 0,
			sendEvents: 1000,
			driveWindowSec: drive,
			driveWindowMeanSec: drive,
			sessionsDriving: 100,
		},
		hostCpuPctMedian: spec.hostCpu ?? 200,
		serverCpuPct: 120,
		sessionsOk: 100,
		sessionsErr: 0,
	};
	return {
		arm: spec.arm,
		rung: spec.rung,
		replicate: spec.replicate,
		cellIndex: spec.index,
		clock: { calibrationResidualNs: 100, source: "ffi" },
		config: {
			sessions: 100,
			payloadBytes: 1150,
			stepSeconds: drive,
			arrival: "uniform",
			tickHz: 64,
			echo: true,
			datagramBatchEnv: spec.arm === "batch0" ? "0" : null,
		},
		steps: [step],
	};
}

/**
 * A dispatch where `default` costs 0.6 ms of tail over `batch0` at every rung,
 * with a quiet floor and honest generation. Egress numbers are chosen per
 * scenario by the caller.
 */
function dispatch(
	options: {
		defaultIngestNs?: number;
		batch0IngestNs?: number;
		defaultEgressNs?: number;
		batch0EgressNs?: number;
		floorIngestNs?: number;
		mutate?: (spec: CellSpec) => CellSpec;
	} = {},
) {
	const {
		defaultIngestNs = 3.0 * MS,
		batch0IngestNs = 2.4 * MS,
		defaultEgressNs = 0.4 * MS,
		batch0EgressNs = 0.4 * MS,
		floorIngestNs = 0.3 * MS,
		mutate = (s) => s,
	} = options;
	const specs: CellSpec[] = [];
	for (const cell of abSchedule()) {
		const isDefault = cell.arm === "default";
		specs.push({
			arm: cell.arm,
			rung: cell.rung,
			replicate: cell.replicate,
			index: cell.index,
			aggregate: cell.aggregate,
			ingestNs: cell.isFloor
				? floorIngestNs
				: isDefault
					? defaultIngestNs
					: batch0IngestNs,
			egressNs: cell.isFloor
				? 0.2 * MS
				: isDefault
					? defaultEgressNs
					: batch0EgressNs,
			lagNs: 0.05 * MS,
		});
	}
	return classifyAbRun(specs.map(mutate).map(fragmentFor));
}

describe("interleaved A/B classification", () => {
	test("a clean dispatch is complete, banded, and adjusts against a quiet floor", () => {
		const result = dispatch();
		expect(result.dispatchComplete).toBe(true);
		expect(result.floor.notQuiet).toBe(false);
		expect(result.floor.adjustmentProduced).toBe(true);
		expect((result.floor.ingestP99Ns ?? 0) / MS).toBeCloseTo(0.3, 1);

		const gate = result.rungs.find((r) => r.rung === "B");
		expect(gate?.measured).toBe(true);
		expect(gate?.delta.n).toBe(10);
		expect((gate?.delta.median ?? 0) / MS).toBeCloseTo(0.6, 1);
		expect(gate?.deltaBucket).toBe("batch-cheap");
		// The adjusted figure is the raw one less the floor, not something else.
		const adjusted = gate?.adjustedIngestP99ByArm.default?.median ?? 0;
		const raw = gate?.ingestP99ByArm.default?.median ?? 0;
		expect((raw - adjusted) / MS).toBeCloseTo(0.3, 1);
	});

	test("a floor that is not quiet suppresses every adjusted figure", () => {
		const result = dispatch({ floorIngestNs: 2 * MS });
		expect(result.floor.notQuiet).toBe(true);
		expect(result.floor.adjustmentProduced).toBe(false);
		for (const rung of result.rungs) {
			expect(rung.adjustedIngestP99ByArm.default?.median).toBeNull();
		}
		// The raw medians are untouched — a bad floor may not damage the reading.
		expect(
			(result.rungs.find((r) => r.rung === "B")?.ingestP99ByArm.default
				?.median ?? 0) / MS,
		).toBeCloseTo(3.0, 1);
	});

	test("a floor doing more than half the work leaves the adjustment advisory", () => {
		const result = dispatch({
			defaultIngestNs: 0.9 * MS,
			batch0IngestNs: 0.9 * MS,
			floorIngestNs: 0.8 * MS,
		});
		expect(result.floor.exceedsSignal).toBe(true);
		expect(result.floor.adjustmentAdvisory).toBe(true);
		expect(result.floor.adjustmentProduced).toBe(true);
	});

	test("the gate rung is not measured when its generator is dishonest", () => {
		const result = dispatch({
			// Rung B alone offers 93% of its registered volume: inside the parent
			// STOP's 0.90 tolerance, outside the honesty check's 0.98.
			mutate: (s) => (s.rung === "B" ? { ...s, sentFraction: 0.93 } : s),
		});
		const gate = result.rungs.find((r) => r.rung === "B");
		expect(gate?.completeByArm.default).toBe(10);
		expect(gate?.honestByArm.default).toBe(0);
		expect(gate?.measured).toBe(false);
		expect(result.dispatchComplete).toBe(false);
		// Every other rung is untouched: honesty is a precondition at B only.
		expect(result.rungs.find((r) => r.rung === "C")?.measured).toBe(true);
	});

	test("a delivery gap between the arms marks the delta confounded", () => {
		const result = dispatch({
			mutate: (s) =>
				s.arm === "default" && !s.rung.startsWith("F")
					? { ...s, upDeliveryRatio: 0.96 }
					: s,
		});
		// Away from the gate rung, honesty is a diagnostic: the cells stay in and
		// the delta carries the confound label rather than vanishing.
		expect(result.rungs.find((r) => r.rung === "C")?.labels).toContain(
			"ab-confounded",
		);
		// At the gate rung the same gap fails H5, which is stricter than a label:
		// the cells are excluded and the rung is not measured at all.
		const gate = result.rungs.find((r) => r.rung === "B");
		expect(gate?.honestByArm.default).toBe(0);
		expect(gate?.measured).toBe(false);
	});

	test("a CPU gap between the arms marks the delta asymmetric", () => {
		const result = dispatch({
			mutate: (s) => (s.arm === "default" ? { ...s, hostCpu: 260 } : s),
		});
		expect(result.rungs.find((r) => r.rung === "B")?.labels).toContain(
			"ab-cpu-asymmetric",
		);
	});

	test("a delta inside its own quantization is unresolvable, never banded quietly", () => {
		const result = dispatch({
			defaultIngestNs: 15 * MS,
			batch0IngestNs: 15 * MS + 10_000,
		});
		const gate = result.rungs.find((r) => r.rung === "B");
		expect(gate?.labels).toContain("ab-unresolvable");
	});
});

describe("registered ingest-vs-egress cross-check", () => {
	test("R1 — the asymmetry is present by default and gone with the batch off", () => {
		const result = dispatch({
			defaultIngestNs: 4 * MS,
			batch0IngestNs: 0.5 * MS,
			defaultEgressNs: 0.5 * MS,
			batch0EgressNs: 0.5 * MS,
		});
		expect(result.crossCheck.reading).toBe("R1");
	});

	test("R2 — the asymmetry survives with the batch off, so it is the direction", () => {
		const result = dispatch({
			defaultIngestNs: 4 * MS,
			batch0IngestNs: 4 * MS,
			defaultEgressNs: 0.5 * MS,
			batch0EgressNs: 0.5 * MS,
		});
		expect(result.crossCheck.reading).toBe("R2");
	});

	test("R3 — no asymmetry anywhere withdraws the 6.6x as a cross-run artifact", () => {
		const result = dispatch({
			defaultIngestNs: 0.5 * MS,
			batch0IngestNs: 0.5 * MS,
			defaultEgressNs: 0.4 * MS,
			batch0EgressNs: 0.4 * MS,
		});
		expect(result.crossCheck.reading).toBe("R3");
	});

	test("R4 — a pattern nobody registered claims no mechanism", () => {
		const result = dispatch({
			defaultIngestNs: 4 * MS,
			batch0IngestNs: 1.8 * MS,
			defaultEgressNs: 0.5 * MS,
			batch0EgressNs: 0.5 * MS,
		});
		expect(result.crossCheck.reading).toBe("R4");
	});

	test("processes that disagree about the same datagrams void the cross-check", () => {
		const result = classifyAbRun(
			abSchedule().map((cell) => {
				const fragment = fragmentFor({
					arm: cell.arm,
					rung: cell.rung,
					replicate: cell.replicate,
					index: cell.index,
					aggregate: cell.aggregate,
					ingestNs: 4 * MS,
					egressNs: 0.5 * MS,
				});
				const client = fragment.steps[0]?.client;
				if (client) {
					// The client's view of the server's first two legs is 1 ms off the
					// server's own — one of them is not describing these datagrams.
					client.upstreamPlusTurnaround = flat(5.05 * MS, 1000).toJson();
				}
				return fragment;
			}),
		);
		expect(result.crossCheck.reading).toBe("crosscheck-clock-invalid");
		expect(result.crossCheck.clockDisagreementMs).toBeGreaterThan(0.2);
	});

	test("a dispatch with nothing complete says so, and does not blame the clock", () => {
		const result = classifyAbRun(
			abSchedule().map((cell) =>
				fragmentFor({
					arm: cell.arm,
					rung: cell.rung,
					replicate: cell.replicate,
					index: cell.index,
					aggregate: cell.aggregate,
					ingestNs: 4 * MS,
					egressNs: 0.5 * MS,
					// Under half the registered volume: every cell trips
					// offered-shortfall and nothing survives to be cross-checked.
					sentFraction: 0.4,
				}),
			),
		);
		expect(result.crossCheck.reading).toBe("crosscheck-no-data");
		expect(result.dispatchComplete).toBe(false);
	});
});
