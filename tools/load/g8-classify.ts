/**
 * Gate G8's clauses and validity falsifiers, as pure functions over plain
 * records.
 *
 * Registered by `docs/research/preregistrations/gate-g8-many-rooms.md` §5, §6
 * and §8. Nothing here chooses a threshold; every constant is a transcription of
 * one that document fixed before this file existed, and the ones that are
 * arithmetic over the scenario come from `g8-plan.ts` so there is one copy.
 *
 * It is pure and it lives outside the conductor for the reason G3b's
 * invalidation gave (registration K17): a rule that only ever executes inside a
 * 60-second arm on a Linux runner cannot be *shown* to fire. Here every rule can
 * be fed the exact signature it exists to reject — a µs-scale ingest path, a
 * starved sink, a publisher that missed its grid, a router whose cost grows with
 * M, six clauses that all computed PASS on a run that was never valid — and
 * `g8-classify.test.ts` asserts it rejects them.
 */

import {
	forwardShortfall,
	type IngestRealityVerdict,
	ingestRealityVerdict,
	publisherShortfall,
	type SinkPrecheckOutcome,
	sinkPrecheckVerdict,
} from "./egress-fanout.ts";
import {
	type G8Arm,
	HANDLER_GROWTH_FACTOR,
	type RungPlan,
	rungPlan,
} from "./g8-plan.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";

/**
 * V-H(a): per-arrival routing cost may grow by at most this factor across the
 * microbench's own M span. Tighter than V-H(b)'s factor because the microbench
 * has no I/O, no scheduler and no other tenant on the box — if an O(1) router
 * cannot look flat *there*, it is not O(1).
 */
export const ROUTING_FLATNESS_FACTOR = 1.5;

// ---------------------------------------------------------------------------
// Records the artifact carries. Field names match `gate-g8-many-rooms.md` §4.
// ---------------------------------------------------------------------------

export type RoomRecord = {
	roomId: number;
	/** Publisher arrivals the server observed for this room. */
	ingested: number;
	/** Of those, the ones carrying a decodable stamp. */
	publisherStamped: number;
	/** Forward sends the conductor issued for this room. */
	forwarded: number;
	forwardErrors: number;
	/** Datagrams this room's subscribers actually received. */
	received: number;
	/** Publisher send stamp → subscriber receive. The gate quantity. */
	oneWay: LatencyHistogramJson;
	/** Publisher send stamp → server JS handler entry, p50. V-I. */
	publisherToIngestP50Ns: number;
	/** Server JS handler entry → first forward issued. V-H(b). */
	handlerToForward: LatencyHistogramJson;
	/** Server-observed inter-arrival gaps at or above a frame boundary. V-I. */
	frameGapFraction: number;
	/** Datagrams the room's publisher emits per tick. V-I's cadence band. */
	datagramsPerTick: number;
};

export type PublisherRecord = {
	publisherId: number;
	roomId: number;
	/** Which pooled process this publisher ran in. Recorded, never aggregated. */
	processIndex: number;
	sent: number;
	effectiveRatePerSec: number;
	driveWindowSec: number;
	ticksSkipped: number;
	sendEvents: number;
	/** `intended` → `actual` on a cumulative-deadline grid. V-G. */
	scheduleLag: LatencyHistogramJson;
};

export type RoutingMicrobenchPoint = { rooms: number; nsPerArrival: number };

export type ConductorRecord = {
	/** Cumulative-deadline 5 ms grid on the conductor's main thread. V-H(c). */
	loopLag: LatencyHistogramJson;
	/** V-H(a). `null` when the microbench did not run — which is a failure. */
	routing: RoutingMicrobenchPoint[] | null;
};

export type PrecheckRecord = {
	offeredPerSec: number;
	deliveryRatio: number | null;
	oneWayP99Ns: number | null;
	generatorSaturated: boolean;
	/** Sink processes the pre-check drove. Must equal the rung's. */
	sinkProcesses: number;
};

export type RungRecord = {
	arm: G8Arm;
	rooms: number;
	driveWindowSec: number;
	roomRecords: RoomRecord[];
	publisherRecords: PublisherRecord[];
	conductor: ConductorRecord;
	precheck: PrecheckRecord;
};

// ---------------------------------------------------------------------------
// Histogram helpers. The aggregate is *derived* from the per-room histograms so
// C2 and C2b can never be reading different data.
// ---------------------------------------------------------------------------

export function mergeHistogramJson(
	parts: readonly LatencyHistogramJson[],
): LatencyHistogramJson {
	const buckets = new Map<number, number>();
	let count = 0;
	let recordedTotal = 0;
	let negative = 0;
	let minNs = Number.POSITIVE_INFINITY;
	let maxNs = 0;
	let sumNs = 0;
	// Seeded from this build's own bucketing rather than from the first part, so
	// an empty merge still produces a histogram this build can read, and a part
	// bucketed differently is rejected instead of quietly summed into buckets
	// that mean something else.
	const { subBits, maxOctave } = new LatencyHistogram().toJson();
	for (const part of parts) {
		if (part.subBits !== subBits || part.maxOctave !== maxOctave) {
			throw new Error(
				`g8-classify: cannot merge a histogram bucketed subBits=${part.subBits} maxOctave=${part.maxOctave} into this build's subBits=${subBits} maxOctave=${maxOctave}`,
			);
		}
		for (const [index, c] of part.buckets) {
			buckets.set(index, (buckets.get(index) ?? 0) + c);
		}
		count += part.count;
		recordedTotal += part.recordedTotal;
		negative += part.negative;
		if (part.count > 0 && part.minNs < minNs) minNs = part.minNs;
		if (part.maxNs > maxNs) maxNs = part.maxNs;
		sumNs += part.sumNs;
	}
	return {
		// The bucketing is asserted, not inherited: `LatencyHistogram.fromJson`
		// refuses a fragment whose `subBits`/`maxOctave` are not this build's, so a
		// merge across mismatched producers cannot silently produce a readable
		// histogram of incomparable buckets.
		version: 2,
		subBits,
		maxOctave,
		buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]),
		count,
		recordedTotal,
		negative,
		minNs: count === 0 ? 0 : minNs,
		maxNs,
		sumNs,
	};
}

export function p99Of(json: LatencyHistogramJson): number {
	return LatencyHistogram.fromJson(json).percentile(0.99);
}

// ---------------------------------------------------------------------------
// Per-room reading
// ---------------------------------------------------------------------------

export type RoomVerdict = {
	roomId: number;
	deliveryRatio: number | null;
	oneWayP99Ns: number;
	samples: number;
	negative: number;
	deliveryFail: boolean;
	p99Fail: boolean;
	ingestReality: IngestRealityVerdict;
	forwardShortfall: boolean;
};

/** C1's per-room floor and C2's per-room bound, plus V-I for that room. */
export const ROOM_DELIVERY_FLOOR = 0.99;

export function roomVerdict(room: RoomRecord, plan: RungPlan): RoomVerdict {
	const expected = room.ingested * plan.targetsPerArrival;
	const deliveryRatio = expected > 0 ? room.received / expected : null;
	const oneWayP99Ns = p99Of(room.oneWay);
	return {
		roomId: room.roomId,
		deliveryRatio,
		oneWayP99Ns,
		samples: room.oneWay.count,
		negative: room.oneWay.negative,
		// A room with no expectation at all is a failure, not an abstention: a
		// room that ingested nothing did not deliver anything either.
		deliveryFail: deliveryRatio === null || deliveryRatio < ROOM_DELIVERY_FLOOR,
		p99Fail: room.oneWay.count === 0 || oneWayP99Ns >= plan.boundNs,
		ingestReality: ingestRealityVerdict({
			ingestToForwardP50Ns: room.publisherToIngestP50Ns,
			frameGapFraction: room.frameGapFraction,
			datagramsPerTick: room.datagramsPerTick,
			publisherStamped: room.publisherStamped,
			ingested: room.ingested,
		}),
		forwardShortfall: forwardShortfall(
			room.forwarded,
			room.ingested,
			plan.targetsPerArrival,
		),
	};
}

// ---------------------------------------------------------------------------
// Per-publisher reading — V-G, evaluated over publishers and never over pools.
// ---------------------------------------------------------------------------

export type PublisherVerdict = {
	publisherId: number;
	roomId: number;
	processIndex: number;
	shortfall: boolean;
	lagP99Ns: number;
	/** Disclosed beside the p99, never subtracted from anything. */
	lagMaxNs: number;
	lagFail: boolean;
	fail: boolean;
};

export function publisherVerdict(
	pub: PublisherRecord,
	plan: RungPlan,
): PublisherVerdict {
	const lagP99Ns = p99Of(pub.scheduleLag);
	const lagFail =
		pub.scheduleLag.count === 0 || lagP99Ns > plan.publisherLagBoundNs;
	const shortfall = publisherShortfall({
		sent: pub.sent,
		effectiveRatePerSec: pub.effectiveRatePerSec,
		driveWindowSec: pub.driveWindowSec,
		ticksSkipped: pub.ticksSkipped,
		sendEvents: pub.sendEvents,
	});
	return {
		publisherId: pub.publisherId,
		roomId: pub.roomId,
		processIndex: pub.processIndex,
		shortfall,
		lagP99Ns,
		lagMaxNs: pub.scheduleLag.maxNs,
		lagFail,
		fail: shortfall || lagFail,
	};
}

// ---------------------------------------------------------------------------
// V-H(a) — routing is O(1) in M
// ---------------------------------------------------------------------------

export type RoutingVerdict = {
	fired: boolean;
	reason: "absent" | "too-few-points" | "grew" | null;
	ratio: number | null;
};

export function routingVerdict(
	points: readonly RoutingMicrobenchPoint[] | null,
): RoutingVerdict {
	if (points === null) return { fired: true, reason: "absent", ratio: null };
	const usable = points.filter((p) => p.nsPerArrival > 0);
	if (usable.length < 2) {
		return { fired: true, reason: "too-few-points", ratio: null };
	}
	const sorted = [...usable].sort((a, b) => a.rooms - b.rooms);
	const low = sorted[0]?.nsPerArrival ?? 0;
	const high = sorted[sorted.length - 1]?.nsPerArrival ?? 0;
	const ratio = high / low;
	if (ratio > ROUTING_FLATNESS_FACTOR) {
		return { fired: true, reason: "grew", ratio };
	}
	return { fired: false, reason: null, ratio };
}

// ---------------------------------------------------------------------------
// Rung reading
// ---------------------------------------------------------------------------

export type RungInvalidReason =
	| "ingest-reality"
	| "sink-saturation"
	| "sink-precheck-inconclusive"
	| "sink-precheck-shape"
	| "generator-honesty"
	| "harness-routing"
	| "harness-loop-lag"
	| "negative-samples"
	| "forward-shortfall"
	| "no-samples";

export type RungVerdict = {
	arm: G8Arm;
	rooms: number;
	plan: RungPlan;
	complete: boolean;
	invalidReasons: RungInvalidReason[];
	/** Set even when the rung is INVALID, and never readable as a result then. */
	clauses: {
		c1: boolean;
		c1b: boolean;
		c2: boolean;
		c2b: boolean;
	};
	pass: boolean;
	aggregateForwardDelivery: number | null;
	aggregateOneWayP99Ns: number;
	aggregateOneWay: LatencyHistogramJson;
	handlerToForwardP99Ns: number;
	roomsFailingDelivery: number[];
	roomsFailingP99: number[];
	roomsNotReal: number[];
	publishersFailing: number[];
	precheckOutcome: SinkPrecheckOutcome;
	conductorLagP99Ns: number;
	routing: RoutingVerdict;
};

export function rungVerdict(record: RungRecord): RungVerdict {
	const plan = rungPlan(record.arm, record.rooms);
	const rooms = record.roomRecords.map((r) => roomVerdict(r, plan));
	const publishers = record.publisherRecords.map((p) =>
		publisherVerdict(p, plan),
	);

	const aggregateOneWay = mergeHistogramJson(
		record.roomRecords.map((r) => r.oneWay),
	);
	const handlerToForward = mergeHistogramJson(
		record.roomRecords.map((r) => r.handlerToForward),
	);
	const aggregateOneWayP99Ns = p99Of(aggregateOneWay);
	const handlerToForwardP99Ns = p99Of(handlerToForward);

	let expected = 0;
	let received = 0;
	for (const r of record.roomRecords) {
		expected += r.ingested * plan.targetsPerArrival;
		received += r.received;
	}
	const aggregateForwardDelivery = expected > 0 ? received / expected : null;

	const roomsFailingDelivery = rooms.filter((r) => r.deliveryFail).map(id);
	const roomsFailingP99 = rooms.filter((r) => r.p99Fail).map(id);
	const roomsNotReal = rooms.filter((r) => !r.ingestReality.real).map(id);
	const publishersFailing = publishers.filter((p) => p.fail).map(pid);

	const precheckOutcome = sinkPrecheckVerdict({
		subscribers: plan.subscribers,
		offeredPerSec: record.precheck.offeredPerSec,
		deliveryRatio: record.precheck.deliveryRatio,
		oneWayP99Ns: record.precheck.oneWayP99Ns,
		generatorSaturated: record.precheck.generatorSaturated,
	});
	const conductorLagP99Ns = p99Of(record.conductor.loopLag);
	const routing = routingVerdict(record.conductor.routing);

	const invalidReasons: RungInvalidReason[] = [];
	if (record.roomRecords.length === 0 || aggregateOneWay.count === 0) {
		invalidReasons.push("no-samples");
	}
	if (roomsNotReal.length > plan.roomTolerance) {
		invalidReasons.push("ingest-reality");
	}
	if (precheckOutcome === "sink-saturation") {
		invalidReasons.push("sink-saturation");
	}
	if (precheckOutcome === "sink-precheck-inconclusive") {
		invalidReasons.push("sink-precheck-inconclusive");
	}
	// A pre-check that drove a different sink pool than the rung says nothing
	// about the rung's sink. Registration §6 V-S: "the same sink pool shape".
	if (record.precheck.sinkProcesses !== plan.sinkProcesses) {
		invalidReasons.push("sink-precheck-shape");
	}
	if (publishersFailing.length > plan.publisherTolerance) {
		invalidReasons.push("generator-honesty");
	}
	if (routing.fired) invalidReasons.push("harness-routing");
	if (
		record.conductor.loopLag.count === 0 ||
		conductorLagP99Ns > plan.conductorLagBoundNs
	) {
		invalidReasons.push("harness-loop-lag");
	}
	// V-N. One clock, one host: a negative one-way is a defect, not a fast packet.
	if (aggregateOneWay.negative > 0) invalidReasons.push("negative-samples");
	if (rooms.some((r) => r.forwardShortfall)) {
		invalidReasons.push("forward-shortfall");
	}

	const clauses = {
		c1:
			aggregateForwardDelivery !== null &&
			aggregateForwardDelivery >= ROOM_DELIVERY_FLOOR,
		c1b: roomsFailingDelivery.length <= plan.roomTolerance,
		c2: aggregateOneWay.count > 0 && aggregateOneWayP99Ns < plan.boundNs,
		c2b: roomsFailingP99.length <= plan.roomTolerance,
	};
	const complete = invalidReasons.length === 0;

	return {
		arm: record.arm,
		rooms: record.rooms,
		plan,
		complete,
		invalidReasons,
		clauses,
		// The only place `pass` is computed. An INVALID rung never passes,
		// however its clauses read — this is the reading G3b's classifier allowed.
		pass: complete && clauses.c1 && clauses.c1b && clauses.c2 && clauses.c2b,
		aggregateForwardDelivery,
		aggregateOneWayP99Ns,
		aggregateOneWay,
		handlerToForwardP99Ns,
		roomsFailingDelivery,
		roomsFailingP99,
		roomsNotReal,
		publishersFailing,
		precheckOutcome,
		conductorLagP99Ns,
		routing,
	};
}

function id(r: RoomVerdict): number {
	return r.roomId;
}
function pid(p: PublisherVerdict): number {
	return p.publisherId;
}

// ---------------------------------------------------------------------------
// V-H(b) and C3 — arm-level, over an arm's complete rungs
// ---------------------------------------------------------------------------

export type HandlerGrowthVerdict = {
	/** Registration §6 V-H(b). Firing withholds C3; it does not invalidate rungs. */
	fired: boolean;
	ratio: number | null;
	lowRooms: number | null;
	highRooms: number | null;
};

export function handlerGrowthVerdict(
	complete: readonly RungVerdict[],
): HandlerGrowthVerdict {
	if (complete.length < 2) {
		return { fired: false, ratio: null, lowRooms: null, highRooms: null };
	}
	const sorted = [...complete].sort((a, b) => a.rooms - b.rooms);
	const low = sorted[0];
	const high = sorted[sorted.length - 1];
	if (!low || !high || low.handlerToForwardP99Ns <= 0) {
		return { fired: false, ratio: null, lowRooms: null, highRooms: null };
	}
	const ratio = high.handlerToForwardP99Ns / low.handlerToForwardP99Ns;
	return {
		fired: ratio > HANDLER_GROWTH_FACTOR,
		ratio,
		lowRooms: low.rooms,
		highRooms: high.rooms,
	};
}

export type ScalingOutcome = "S1" | "S2" | "S3" | "no-statement";

export type ScalingVerdict = {
	outcome: ScalingOutcome;
	/** Always true. G8 registers NO expected form for p99 vs M (§8). */
	noExpectation: true;
	spreadNs: number | null;
	bandNs: number | null;
	points: Array<{ rooms: number; p99Ns: number }>;
	/** The largest M the statement may speak about. Never extrapolate past it. */
	maxCompleteRooms: number | null;
};

export function scalingVerdict(
	complete: readonly RungVerdict[],
	growth: HandlerGrowthVerdict,
): ScalingVerdict {
	const points = [...complete]
		.sort((a, b) => a.rooms - b.rooms)
		.map((r) => ({ rooms: r.rooms, p99Ns: r.aggregateOneWayP99Ns }));
	if (points.length < 2) {
		return {
			outcome: "no-statement",
			noExpectation: true,
			spreadNs: null,
			bandNs: null,
			points,
			maxCompleteRooms: points.at(-1)?.rooms ?? null,
		};
	}
	const bandNs = complete[0]?.plan.scalingBandNs ?? 0;
	const mean = points.reduce((a, p) => a + p.p99Ns, 0) / points.length;
	const spreadNs = Math.max(...points.map((p) => Math.abs(p.p99Ns - mean)));
	const outcome: ScalingOutcome =
		spreadNs <= bandNs ? "S1" : growth.fired ? "S3" : "S2";
	return {
		outcome,
		noExpectation: true,
		spreadNs,
		bandNs,
		points,
		maxCompleteRooms: points.at(-1)?.rooms ?? null,
	};
}

export type ArmVerdict = {
	arm: G8Arm;
	rungs: RungVerdict[];
	completeRungs: number[];
	passingRungs: number[];
	/** C4: the largest complete-and-passing M. `null` when there is none. */
	roomCount: number | null;
	handlerGrowth: HandlerGrowthVerdict;
	scaling: ScalingVerdict;
};

export function armVerdict(arm: G8Arm, rungs: RungRecord[]): ArmVerdict {
	const verdicts = rungs.map(rungVerdict).sort((a, b) => a.rooms - b.rooms);
	const complete = verdicts.filter((r) => r.complete);
	const passing = verdicts.filter((r) => r.pass);
	const handlerGrowth = handlerGrowthVerdict(complete);
	return {
		arm,
		rungs: verdicts,
		completeRungs: complete.map((r) => r.rooms),
		passingRungs: passing.map((r) => r.rooms),
		// C4 is the largest *passing* rung, not the largest complete one. A rung
		// that was measurable but missed its bound is not a room count.
		roomCount:
			passing.length > 0 ? Math.max(...passing.map((r) => r.rooms)) : null,
		handlerGrowth,
		scaling: scalingVerdict(complete, handlerGrowth),
	};
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

export type G8Status = "PASS" | "MISS" | "INVALID" | "NO-VERDICT";

export type G8Verdict = {
	status: G8Status;
	arms: ArmVerdict[];
	/** C4 per arm. Never summed, never averaged, never combined (§5.1). */
	roomCounts: Array<{ arm: G8Arm; rooms: number | null; shape: string }>;
	notes: string[];
};

/**
 * The run's status.
 *
 * `INVALID` beats everything: if no rung anywhere was complete, the clauses'
 * values are not readings of anything and the run says so, however many of them
 * computed true. That is precisely the reading G3b's classifier permitted, and
 * `g8-classify.test.ts` feeds this function a record whose clauses all compute
 * PASS on rungs that are all INVALID and asserts it returns `INVALID`.
 */
export function rollUp(arms: ArmVerdict[]): G8Verdict {
	const allRungs = arms.flatMap((a) => a.rungs);
	const notes: string[] = [];
	if (allRungs.length === 0) {
		return { status: "NO-VERDICT", arms, roomCounts: [], notes };
	}
	const complete = allRungs.filter((r) => r.complete);
	const roomCounts = arms.map((a) => ({
		arm: a.arm,
		rooms: a.roomCount,
		shape: shapeSentence(a),
	}));
	if (complete.length === 0) {
		notes.push(
			"No rung on any arm was complete; no room count is produced and the clause values are not readings.",
		);
		return { status: "INVALID", arms, roomCounts, notes };
	}
	const passing = complete.filter((r) => r.pass);
	if (passing.length === 0) {
		notes.push(
			"Rungs were complete and every one missed a clause. A miss on a valid run is final.",
		);
		return { status: "MISS", arms, roomCounts, notes };
	}
	if (complete.length < allRungs.length) {
		notes.push(
			`${allRungs.length - complete.length} of ${allRungs.length} rungs were INVALID and contribute nothing.`,
		);
	}
	for (const a of arms) {
		if (a.handlerGrowth.fired) {
			notes.push(
				`${a.arm}: V-H(b) fired — handlerToForward p99 grew ${a.handlerGrowth.ratio?.toFixed(2)}x from M=${a.handlerGrowth.lowRooms} to M=${a.handlerGrowth.highRooms}; the M-scaling statement is withheld.`,
			);
		}
		if (a.scaling.maxCompleteRooms !== null) {
			notes.push(
				`${a.arm}: no statement is licensed past M=${a.scaling.maxCompleteRooms}.`,
			);
		}
	}
	return { status: "PASS", arms, roomCounts, notes };
}

/**
 * The sentence a room count may not be detached from (§5.1). It is built from
 * the plan rather than written out, so a room count cannot be quoted without the
 * shape that produced it.
 */
export function shapeSentence(arm: ArmVerdict): string {
	const plan = arm.rungs[0]?.plan ?? rungPlan(arm.arm, 1);
	const who =
		plan.publishersPerRoom === 1
			? `1 publisher to ${plan.targetsPerArrival} subscribers`
			: `${plan.publishersPerRoom} mutual publishers`;
	return `${who}, ${plan.ratePerSec}/s per publisher, ${plan.payloadBytes} B, p99 < ${(plan.boundNs / 1e6).toFixed(1)} ms, forward delivery >= 0.99, generator and sink co-resident on the 4 vCPU rig, fixed offered load (no saturation search)`;
}
