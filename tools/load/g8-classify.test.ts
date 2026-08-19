/**
 * Feeds every G8 falsifier the exact signature it exists to reject.
 *
 * G3b's V1 lived only in a hand derivation until it was too late to fire
 * (registration K17). These tests are the answer: each rule is executed
 * off-runner against a synthetic record carrying the defect, and asserted to
 * reject it — including the one that matters most, a run whose every clause
 * computes PASS on rungs that were never valid.
 */

import { describe, expect, test } from "bun:test";
import {
	armVerdict,
	type ConductorRecord,
	type G8Verdict,
	handlerGrowthVerdict,
	mergeHistogramJson,
	type PrecheckRecord,
	type PublisherRecord,
	p99Of,
	type RoomRecord,
	type RungRecord,
	rollUp,
	roomVerdict,
	routingVerdict,
	rungVerdict,
	scalingVerdict,
	shapeSentence,
} from "./g8-classify.ts";
import { rungPlan } from "./g8-plan.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";

// ---------------------------------------------------------------------------
// Builders. Everything starts healthy; each test breaks exactly one thing.
// ---------------------------------------------------------------------------

function hist(samplesNs: number[], negatives = 0): LatencyHistogramJson {
	const h = new LatencyHistogram();
	for (const ns of samplesNs) h.record(ns);
	for (let i = 0; i < negatives; i += 1) h.record(-1);
	return h.toJson();
}

/**
 * A histogram of `n` samples whose 99th percentile is `p99Ns`.
 *
 * The reader is nearest-rank, so the high samples have to occupy every rank from
 * `ceil(0.99n)` upward — one high sample in a hundred lands at rank 100 and
 * leaves p99 reading the low value, which is a mistake worth not making twice.
 */
function histAtP99(p99Ns: number, lowNs = 1e6, n = 100): LatencyHistogramJson {
	const highs = n - Math.ceil(0.99 * n) + 1;
	const s = Array.from({ length: n - highs }, () => lowNs);
	for (let i = 0; i < highs; i += 1) s.push(p99Ns);
	return hist(s);
}

function healthyRoom(roomId: number, overrides: Partial<RoomRecord> = {}) {
	const ingested = 3_000;
	const targets = 10;
	return {
		roomId,
		ingested,
		publisherStamped: ingested,
		forwarded: ingested * targets,
		forwardErrors: 0,
		received: ingested * targets,
		oneWay: histAtP99(10e6),
		// A real on-box ingest path: 1.4 ms, the regime G4's ladder read.
		publisherToIngestP50Ns: 1_400_000,
		handlerToForward: histAtP99(3_000, 2_000),
		// One datagram per tick at 50 pps, so every gap is a frame gap.
		frameGapFraction: 1,
		datagramsPerTick: 1,
		...overrides,
	} satisfies RoomRecord;
}

function healthyPublisher(
	publisherId: number,
	overrides: Partial<PublisherRecord> = {},
): PublisherRecord {
	return {
		publisherId,
		roomId: publisherId,
		processIndex: Math.floor(publisherId / 25),
		sent: 3_000,
		effectiveRatePerSec: 50,
		driveWindowSec: 60,
		ticksSkipped: 0,
		sendEvents: 3_000,
		scheduleLag: histAtP99(400_000, 100_000),
		...overrides,
	};
}

function healthyConductor(
	overrides: Partial<ConductorRecord> = {},
): ConductorRecord {
	return {
		loopLag: histAtP99(600_000, 200_000),
		routing: [
			{ rooms: 10, nsPerArrival: 120 },
			{ rooms: 50, nsPerArrival: 124 },
			{ rooms: 100, nsPerArrival: 128 },
		],
		...overrides,
	};
}

function healthyPrecheck(
	rooms: number,
	overrides: Partial<PrecheckRecord> = {},
): PrecheckRecord {
	const plan = rungPlan("voice", rooms);
	return {
		offeredPerSec: plan.sinkPrecheckOfferedPerSec,
		deliveryRatio: 0.999,
		oneWayP99Ns: 8e6,
		generatorSaturated: false,
		sinkProcesses: plan.sinkProcesses,
		...overrides,
	};
}

function healthyRung(
	rooms = 10,
	overrides: Partial<RungRecord> = {},
): RungRecord {
	const plan = rungPlan("voice", rooms);
	return {
		arm: "voice",
		rooms,
		driveWindowSec: 60,
		roomRecords: Array.from({ length: rooms }, (_, i) => healthyRoom(i)),
		publisherRecords: Array.from({ length: plan.publishers }, (_, i) =>
			healthyPublisher(i),
		),
		conductor: healthyConductor(),
		precheck: healthyPrecheck(rooms),
		...overrides,
	};
}

// ---------------------------------------------------------------------------

describe("the healthy baseline", () => {
	test("a clean rung is complete and passes", () => {
		const v = rungVerdict(healthyRung());
		expect(v.invalidReasons).toEqual([]);
		expect(v.complete).toBe(true);
		expect(v.pass).toBe(true);
		expect(v.aggregateForwardDelivery).toBe(1);
		expect(v.clauses).toEqual({ c1: true, c1b: true, c2: true, c2b: true });
	});

	test("the aggregate is derived from the rooms, so it cannot disagree with them", () => {
		const rung = healthyRung(10);
		const v = rungVerdict(rung);
		const merged = mergeHistogramJson(rung.roomRecords.map((r) => r.oneWay));
		expect(v.aggregateOneWay.count).toBe(merged.count);
		expect(v.aggregateOneWay.count).toBe(10 * 100);
		expect(v.aggregateOneWayP99Ns).toBe(p99Of(merged));
	});
});

describe("V-I — ingest reality, per room", () => {
	test("the retracted run's µs signature is rejected", () => {
		// 9-31 µs: the path that never contained a network.
		const room = healthyRoom(0, { publisherToIngestP50Ns: 31_000 });
		const v = roomVerdict(room, rungPlan("voice", 10));
		expect(v.ingestReality.real).toBe(false);
		expect(v.ingestReality.reasons).toContain("lag-microsecond");
	});

	test("a room whose publisher cadence is absent is rejected", () => {
		// A free-running in-process loop: no frame boundaries at all.
		const room = healthyRoom(0, { frameGapFraction: 0.01 });
		expect(
			roomVerdict(room, rungPlan("voice", 10)).ingestReality.reasons,
		).toContain("cadence-absent");
	});

	test("arrivals that are not the publisher's stamped datagrams are rejected", () => {
		const room = healthyRoom(0, { publisherStamped: 100 });
		expect(
			roomVerdict(room, rungPlan("voice", 10)).ingestReality.reasons,
		).toContain("stamp-provenance");
	});

	test("the cadence check is per room, and pooling M publishers would destroy it", () => {
		// 100 interleaved publishers at 1 datagram/tick present as a free-running
		// stream in the pooled view. Per room the structure is intact.
		const perRoom = healthyRoom(0);
		expect(
			roomVerdict(perRoom, rungPlan("voice", 100)).ingestReality.real,
		).toBe(true);
		const pooled = healthyRoom(0, { frameGapFraction: 1 / 100 });
		expect(roomVerdict(pooled, rungPlan("voice", 100)).ingestReality.real).toBe(
			false,
		);
	});

	test("one bad room out of 100 is inside tolerance; two is not", () => {
		const rooms = Array.from({ length: 100 }, (_, i) => healthyRoom(i));
		rooms[0] = healthyRoom(0, { publisherToIngestP50Ns: 20_000 });
		const okRung = healthyRung(100, {
			roomRecords: rooms,
			publisherRecords: Array.from({ length: 100 }, (_, i) =>
				healthyPublisher(i),
			),
			precheck: healthyPrecheck(100),
		});
		expect(rungVerdict(okRung).invalidReasons).not.toContain("ingest-reality");

		rooms[1] = healthyRoom(1, { publisherToIngestP50Ns: 20_000 });
		expect(
			rungVerdict({ ...okRung, roomRecords: [...rooms] }).invalidReasons,
		).toContain("ingest-reality");
	});

	test("at M=10 the tolerance is zero, so one bad room invalidates", () => {
		const rooms = Array.from({ length: 10 }, (_, i) => healthyRoom(i));
		rooms[3] = healthyRoom(3, { publisherToIngestP50Ns: 9_000 });
		expect(
			rungVerdict(healthyRung(10, { roomRecords: rooms })).invalidReasons,
		).toContain("ingest-reality");
	});
});

describe("V-S — sink saturation", () => {
	test("a starved sink invalidates the rung", () => {
		const rung = healthyRung(10, {
			precheck: healthyPrecheck(10, { deliveryRatio: 0.82 }),
		});
		const v = rungVerdict(rung);
		expect(v.precheckOutcome).toBe("sink-saturation");
		expect(v.complete).toBe(false);
	});

	test("a pre-check whose own originator saturated is inconclusive, not a pass", () => {
		const rung = healthyRung(10, {
			precheck: healthyPrecheck(10, { generatorSaturated: true }),
		});
		const v = rungVerdict(rung);
		expect(v.precheckOutcome).toBe("sink-precheck-inconclusive");
		expect(v.invalidReasons).toContain("sink-precheck-inconclusive");
	});

	test("a pre-check against a different sink pool says nothing about this rung", () => {
		const rung = healthyRung(100, {
			roomRecords: Array.from({ length: 100 }, (_, i) => healthyRoom(i)),
			publisherRecords: Array.from({ length: 100 }, (_, i) =>
				healthyPublisher(i),
			),
			// Healthy in every respect except that it drove one process, not four.
			precheck: healthyPrecheck(100, { sinkProcesses: 1 }),
		});
		const v = rungVerdict(rung);
		expect(v.precheckOutcome).toBe("pass");
		expect(v.invalidReasons).toContain("sink-precheck-shape");
	});
});

describe("V-G — generator honesty, per publisher and never per pool", () => {
	test("one starved publisher in a pool of 25 is not hidden by the other 24", () => {
		const publishers = Array.from({ length: 10 }, (_, i) =>
			healthyPublisher(i),
		);
		// This is the negative-denominator signature: the pool's aggregate rate is
		// 99.6% of plan, which any pooled rule would wave through.
		publishers[4] = healthyPublisher(4, { sent: 100, ticksSkipped: 2_900 });
		const pooledSent = publishers.reduce((a, p) => a + p.sent, 0);
		expect(pooledSent / (10 * 3_000)).toBeGreaterThan(0.9);

		const v = rungVerdict(healthyRung(10, { publisherRecords: publishers }));
		expect(v.publishersFailing).toEqual([4]);
		expect(v.invalidReasons).toContain("generator-honesty");
	});

	test("a publisher that missed its grid fails even though it sent everything", () => {
		const publishers = Array.from({ length: 10 }, (_, i) =>
			healthyPublisher(i),
		);
		// 3 ms p99 schedule lag against a 2 ms bound: it sent the load, late.
		publishers[7] = healthyPublisher(7, { scheduleLag: histAtP99(3e6) });
		const v = rungVerdict(healthyRung(10, { publisherRecords: publishers }));
		expect(v.publishersFailing).toEqual([7]);
	});

	test("the max is carried beside the p99 and never subtracted", () => {
		const pub = healthyPublisher(0, {
			scheduleLag: hist([...Array.from({ length: 99 }, () => 100_000), 40.6e6]),
		});
		const v = rungVerdict(healthyRung(10, { publisherRecords: [pub] }));
		// A p99 that clears while the max is twice the whole budget is a fact the
		// reader needs — the Mac's 40.6 ms signature (K21).
		expect(v.publishersFailing).toEqual([]);
		const [only] = [pub];
		expect(only.scheduleLag.maxNs).toBe(40.6e6);
	});
});

describe("V-H(a) — routing is O(1) in M", () => {
	test("an absent microbench fires", () => {
		expect(routingVerdict(null)).toEqual({
			fired: true,
			reason: "absent",
			ratio: null,
		});
	});

	test("a single point cannot demonstrate flatness", () => {
		expect(routingVerdict([{ rooms: 10, nsPerArrival: 120 }]).reason).toBe(
			"too-few-points",
		);
	});

	test("an O(M) router — a per-arrival scan over rooms — is rejected", () => {
		const v = routingVerdict([
			{ rooms: 10, nsPerArrival: 120 },
			{ rooms: 100, nsPerArrival: 1_180 },
		]);
		expect(v.fired).toBe(true);
		expect(v.reason).toBe("grew");
		expect(v.ratio).toBeCloseTo(9.83, 2);
	});

	test("a flat router passes and invalidates nothing", () => {
		expect(routingVerdict(healthyConductor().routing).fired).toBe(false);
		expect(rungVerdict(healthyRung()).invalidReasons).not.toContain(
			"harness-routing",
		);
	});

	test("firing invalidates the rung", () => {
		const rung = healthyRung(10, {
			conductor: healthyConductor({ routing: null }),
		});
		expect(rungVerdict(rung).invalidReasons).toContain("harness-routing");
	});
});

describe("V-H(c) — the conductor's own lateness", () => {
	test("a conductor blocking its loop past a tenth of the bound invalidates", () => {
		const rung = healthyRung(10, {
			conductor: healthyConductor({ loopLag: histAtP99(5e6) }),
		});
		const v = rungVerdict(rung);
		expect(v.conductorLagP99Ns).toBeGreaterThan(2e6);
		expect(v.invalidReasons).toContain("harness-loop-lag");
	});

	test("a probe that recorded nothing is a failure, not an abstention", () => {
		const rung = healthyRung(10, {
			conductor: healthyConductor({ loopLag: hist([]) }),
		});
		expect(rungVerdict(rung).invalidReasons).toContain("harness-loop-lag");
	});
});

describe("V-F and V-N", () => {
	test("a room whose forwards never happened invalidates the rung", () => {
		const rooms = Array.from({ length: 10 }, (_, i) => healthyRoom(i));
		rooms[2] = healthyRoom(2, { forwarded: 1_000, received: 1_000 });
		expect(
			rungVerdict(healthyRung(10, { roomRecords: rooms })).invalidReasons,
		).toContain("forward-shortfall");
	});

	test("a negative one-way sample invalidates: one clock, one host", () => {
		const rooms = Array.from({ length: 10 }, (_, i) => healthyRoom(i));
		rooms[0] = healthyRoom(0, {
			oneWay: hist(
				Array.from({ length: 100 }, () => 10e6),
				1,
			),
		});
		const v = rungVerdict(healthyRung(10, { roomRecords: rooms }));
		expect(v.aggregateOneWay.negative).toBe(1);
		expect(v.invalidReasons).toContain("negative-samples");
	});
});

describe("C1/C1b and C2/C2b — the aggregate and the rooms hiding in it", () => {
	test("one broken room out of 100 is inside tolerance for delivery", () => {
		const rooms = Array.from({ length: 100 }, (_, i) => healthyRoom(i));
		rooms[0] = healthyRoom(0, { received: 3_000 * 10 * 0.5 });
		const v = rungVerdict(
			healthyRung(100, {
				roomRecords: rooms,
				publisherRecords: Array.from({ length: 100 }, (_, i) =>
					healthyPublisher(i),
				),
				precheck: healthyPrecheck(100),
			}),
		);
		expect(v.roomsFailingDelivery).toEqual([0]);
		expect(v.clauses.c1b).toBe(true);
		expect(v.pass).toBe(true);
	});

	test("a broken room that the aggregate hides still fails C2b", () => {
		// 98 healthy rooms and two whose own p99 is over the bound. The pooled p99
		// is fine because their tails are 0.04% of the samples — which is exactly
		// the case a pooled-only clause waves through.
		const rooms = Array.from({ length: 100 }, (_, i) => healthyRoom(i));
		rooms[0] = healthyRoom(0, { oneWay: histAtP99(21e6) });
		rooms[1] = healthyRoom(1, { oneWay: histAtP99(21e6) });
		const v = rungVerdict(
			healthyRung(100, {
				roomRecords: rooms,
				publisherRecords: Array.from({ length: 100 }, (_, i) =>
					healthyPublisher(i),
				),
				precheck: healthyPrecheck(100),
			}),
		);
		expect(v.clauses.c2).toBe(true);
		expect(v.roomsFailingP99).toEqual([0, 1]);
		expect(v.clauses.c2b).toBe(false);
		expect(v.pass).toBe(false);
	});

	test("a room that ingested nothing fails rather than abstaining", () => {
		const rooms = Array.from({ length: 10 }, (_, i) => healthyRoom(i));
		rooms[5] = healthyRoom(5, {
			ingested: 0,
			publisherStamped: 0,
			forwarded: 0,
			received: 0,
			oneWay: hist([]),
		});
		const v = rungVerdict(healthyRung(10, { roomRecords: rooms }));
		expect(v.roomsFailingDelivery).toContain(5);
		expect(v.roomsFailingP99).toContain(5);
	});

	test("an aggregate tail over the bound fails C2", () => {
		const rooms = Array.from({ length: 10 }, (_, i) =>
			healthyRoom(i, { oneWay: histAtP99(25e6) }),
		);
		const v = rungVerdict(healthyRung(10, { roomRecords: rooms }));
		expect(v.clauses.c2).toBe(false);
		expect(v.complete).toBe(true);
		expect(v.pass).toBe(false);
	});
});

describe("V-H(b) and C3 — the M-scaling statement", () => {
	function completeRungAt(rooms: number, p99Ns: number, handlerP99Ns: number) {
		const roomRecords = Array.from({ length: rooms }, (_, i) =>
			healthyRoom(i, {
				oneWay: histAtP99(p99Ns),
				handlerToForward: histAtP99(handlerP99Ns, handlerP99Ns / 2),
			}),
		);
		return healthyRung(rooms, {
			roomRecords,
			publisherRecords: Array.from({ length: rooms }, (_, i) =>
				healthyPublisher(i),
			),
			precheck: healthyPrecheck(rooms),
		});
	}

	test("flat p99 across the ladder reads S1 and licenses no extrapolation", () => {
		const arm = armVerdict("voice", [
			completeRungAt(10, 10e6, 3_000),
			completeRungAt(50, 11e6, 3_100),
			completeRungAt(100, 10.5e6, 3_200),
		]);
		expect(arm.scaling.outcome).toBe("S1");
		expect(arm.scaling.noExpectation).toBe(true);
		expect(arm.scaling.maxCompleteRooms).toBe(100);
	});

	test("growth with a flat router reads S2 — measured, never fitted", () => {
		const arm = armVerdict("voice", [
			completeRungAt(10, 5e6, 3_000),
			completeRungAt(50, 12e6, 3_100),
			completeRungAt(100, 18e6, 3_200),
		]);
		expect(arm.handlerGrowth.fired).toBe(false);
		expect(arm.scaling.outcome).toBe("S2");
		expect(arm.scaling.points.map((p) => p.rooms)).toEqual([10, 50, 100]);
	});

	test("growth the router explains reads S3 and the statement is withheld", () => {
		const arm = armVerdict("voice", [
			completeRungAt(10, 5e6, 3_000),
			completeRungAt(100, 18e6, 30_000),
		]);
		expect(arm.handlerGrowth.fired).toBe(true);
		expect(arm.scaling.outcome).toBe("S3");
	});

	test("V-H(b) withholds C3 but does not invalidate the rungs", () => {
		const arm = armVerdict("voice", [
			completeRungAt(10, 5e6, 3_000),
			completeRungAt(100, 18e6, 30_000),
		]);
		expect(arm.rungs.every((r) => r.complete)).toBe(true);
		expect(arm.roomCount).toBe(100);
	});

	test("the instrument that carries V-H(b) is the one G4 showed resolves growth", () => {
		// G4: handlerToForward p50 went 2.4 → 7.1 µs when targets went 10 → 100.
		expect(handlerGrowthVerdict([]).fired).toBe(false);
		const ratio = 7_100 / 2_400;
		expect(ratio).toBeGreaterThan(2);
	});

	test("fewer than two complete rungs produces no statement at all", () => {
		const arm = armVerdict("voice", [completeRungAt(10, 10e6, 3_000)]);
		expect(arm.scaling.outcome).toBe("no-statement");
		expect(
			scalingVerdict([], {
				fired: false,
				ratio: null,
				lowRooms: null,
				highRooms: null,
			}).outcome,
		).toBe("no-statement");
	});
});

describe("C4 — the room count", () => {
	test("it is the largest passing rung, not the largest complete one", () => {
		const good = healthyRung(10);
		const missed = healthyRung(50, {
			roomRecords: Array.from({ length: 50 }, (_, i) =>
				healthyRoom(i, { oneWay: histAtP99(25e6) }),
			),
			publisherRecords: Array.from({ length: 50 }, (_, i) =>
				healthyPublisher(i),
			),
			precheck: healthyPrecheck(50),
		});
		const arm = armVerdict("voice", [good, missed]);
		expect(arm.completeRungs).toEqual([10, 50]);
		expect(arm.passingRungs).toEqual([10]);
		expect(arm.roomCount).toBe(10);
	});

	test("it cannot be quoted without the shape that produced it", () => {
		const arm = armVerdict("voice", [healthyRung(10)]);
		const s = shapeSentence(arm);
		expect(s).toContain("1 publisher to 10 subscribers");
		expect(s).toContain("50/s per publisher");
		expect(s).toContain("128 B");
		expect(s).toContain("p99 < 20.0 ms");
		expect(s).toContain("co-resident");
		expect(s).toContain("no saturation search");
	});

	test("the mutual arm's shape sentence says mutual, in K6's units", () => {
		const arm = armVerdict("mutual", []);
		expect(shapeSentence(arm)).toContain("10 mutual publishers");
	});
});

describe("rollUp — INVALID beats clauses that computed PASS", () => {
	/** Every clause true; every rung invalid for a different registered reason. */
	function allClausesPassAllRungsInvalid(): G8Verdict {
		const base = healthyRung(10);
		const invalidations: Array<Partial<RungRecord>> = [
			{ conductor: healthyConductor({ routing: null }) },
			{ conductor: healthyConductor({ loopLag: histAtP99(9e6) }) },
			{ precheck: healthyPrecheck(10, { generatorSaturated: true }) },
			{ precheck: healthyPrecheck(10, { deliveryRatio: 0.5 }) },
			{
				publisherRecords: [
					healthyPublisher(0, { sent: 1, ticksSkipped: 2_999 }),
					...Array.from({ length: 9 }, (_, i) => healthyPublisher(i + 1)),
				],
			},
			{
				roomRecords: [
					healthyRoom(0, { publisherToIngestP50Ns: 12_000 }),
					...Array.from({ length: 9 }, (_, i) => healthyRoom(i + 1)),
				],
			},
		];
		return rollUp([
			armVerdict(
				"voice",
				invalidations.map((patch) => ({ ...base, ...patch })),
			),
		]);
	}

	test("six rungs whose clauses all computed PASS still roll up INVALID", () => {
		const verdict = allClausesPassAllRungsInvalid();
		const rungs = verdict.arms.flatMap((a) => a.rungs);
		expect(rungs).toHaveLength(6);
		for (const r of rungs) {
			expect(r.clauses).toEqual({ c1: true, c1b: true, c2: true, c2b: true });
			expect(r.complete).toBe(false);
			expect(r.pass).toBe(false);
		}
		// Six distinct registered reasons, so this is not one bug six times.
		const reasons = new Set(rungs.flatMap((r) => r.invalidReasons));
		expect(reasons.size).toBeGreaterThanOrEqual(6);
		expect(verdict.status).toBe("INVALID");
		expect(verdict.roomCounts.every((c) => c.rooms === null)).toBe(true);
	});

	test("complete rungs that all missed roll up MISS, and a miss is final", () => {
		const missed = healthyRung(10, {
			roomRecords: Array.from({ length: 10 }, (_, i) =>
				healthyRoom(i, { oneWay: histAtP99(30e6) }),
			),
		});
		const v = rollUp([armVerdict("voice", [missed])]);
		expect(v.status).toBe("MISS");
		expect(v.notes.join(" ")).toContain("final");
	});

	test("no rungs at all is NO-VERDICT, not a pass", () => {
		expect(rollUp([]).status).toBe("NO-VERDICT");
	});

	test("a pass names the largest M it may speak about", () => {
		const v = rollUp([armVerdict("voice", [healthyRung(10)])]);
		expect(v.status).toBe("PASS");
		expect(v.notes.join(" ")).toContain("past M=10");
	});

	test("room counts are reported per arm and never combined", () => {
		const v = rollUp([
			armVerdict("voice", [healthyRung(10)]),
			armVerdict("mutual", []),
		]);
		expect(v.roomCounts).toHaveLength(2);
		expect(v.roomCounts[0]?.arm).toBe("voice");
		expect(v.roomCounts[1]?.rooms).toBeNull();
		// Each carries its own non-detachable shape sentence.
		expect(v.roomCounts[0]?.shape).not.toBe(v.roomCounts[1]?.shape);
	});
});
