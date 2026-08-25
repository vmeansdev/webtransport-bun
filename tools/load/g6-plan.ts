/**
 * G6's scenario arithmetic, mechanized.
 *
 * Every rate, payload and bound in `docs/research/preregistrations/gate-g6-mmo.md`
 * §1 is derived here from the *scenario* constants — realm population, movement
 * cadence, AoI size, world tick, interaction budget — rather than transcribed as
 * a magic number. Two reasons, both learned the hard way by this effort:
 *
 *  * A threshold that exists only as prose in a pre-registration cannot be
 *    checked against the harness that is supposed to offer it. G2's 15,000/s
 *    rung was an interpolation nobody had measured; G3's bound and its
 *    instrument disagreed. Here the conductor asks this module for its rates and
 *    the classifier asks it for its bounds, so the two cannot drift apart.
 *  * A reader who disputes a bound can change one scenario constant and see
 *    exactly which numbers move.
 *
 * Nothing in this file reads a measurement. It is arithmetic over constants that
 * were fixed before the gate ran, and its unit tests pin the values the
 * pre-registration states in prose.
 */

/** Successor authority that freezes G6 closeout grading inputs and rules. */
export const G6_CLOSEOUT_SPEC_ID = "g6-mmo-closeout/1";
export const G6_CLOSEOUT_SPEC_PATH =
	"docs/research/preregistrations/gate-g6-mmo-closeout.md";

/* -------------------------------------------------------------------------- */
/* Scenario constants — the MMO, not the rig                                  */
/* -------------------------------------------------------------------------- */

/** Registered ladder. The gate rung is the last one (§2). */
export const REALM_LADDER = [500, 2500, 5000] as const;

/** Movement/heading updates a client sends per second (§1.2). */
export const MOVE_HZ = 4;
/** Upstream payload: 48 B of stamp + 28 B of movement record, rounded (§1.2). */
export const UPSTREAM_PAYLOAD_BYTES = 64;

/** World snapshot tick (§1.3). */
export const SNAPSHOT_HZ = 5;
/**
 * Entities in one player's area of interest (§1.3, as amended).
 *
 * 100 is the *contested-zone / capital-cluster* figure — players, pets and NPCs
 * in view where a realm is actually under load. The median quiet zone is nearer
 * 50, which divides into 2 datagrams per snapshot (10 pps/session) rather than
 * 3; the gate deliberately takes the demanding end, the same way it takes 5,000
 * players and a 40-player raid, and the quiet-zone shape is registered as **not
 * covered** rather than measured.
 */
export const AOI_ENTITIES = 100;
/** Bytes per entity delta: id + quantized position + state bits (§1.3). */
export const AOI_BYTES_PER_ENTITY = 24;
/** The rig's registered datagram payload for bulk-ish traffic (§1.3). */
export const SNAPSHOT_PAYLOAD_BYTES = 1150;

/** One discrete, GCD-paced action every 2 s (§1.4). */
export const ACTION_HZ = 0.5;
/** Ack payload: the stamp plus a result code (§1.4). */
export const ACK_PAYLOAD_BYTES = 64;

/** Emitter slice grid: 50 Hz, so a snapshot tick is spread over 10 slices (§1.3). */
export const EMITTER_SLICE_HZ = 50;

/** Raid size — the largest standard AoI cohort (§1.7). */
export const RAID_MEMBERS = 40;
/** Encounter event rate for one event source (§1.7). */
export const RAID_PUBLISHER_HZ = 20;

/* -------------------------------------------------------------------------- */
/* Latency budget — §1.6, worked out rather than asserted                     */
/* -------------------------------------------------------------------------- */

/** Where an MMO player starts calling the ability loop "spell delay" (§1.6). */
export const INTERACTION_BUDGET_MS = 150;
/** One frame of client input sampling at 60 fps. */
export const CLIENT_INPUT_FRAME_MS = 1000 / 60;
/** One frame to render the confirmation. */
export const CLIENT_RENDER_FRAME_MS = 1000 / 60;
/** Typical regional internet path RTT the transport does not control. */
export const INTERNET_RTT_MS = 60;

/**
 * The round-trip budget left for everything between the two hosts, rounded
 * *down* to a whole 10 ms so the registered bound is never richer than the
 * derivation. Comes out at 50 ms; the arithmetic is here so that is checkable.
 */
export function rttBudgetMs(): number {
	const residue =
		INTERACTION_BUDGET_MS -
		CLIENT_INPUT_FRAME_MS -
		INTERNET_RTT_MS -
		CLIENT_RENDER_FRAME_MS;
	return Math.floor(residue / 10) * 10;
}

/** One leg of the round trip (§1.7): the raid hotspot's one-way bound. */
export function hotspotOneWayBudgetMs(): number {
	return rttBudgetMs() / 2;
}

/* -------------------------------------------------------------------------- */
/* Per-session and aggregate shape                                            */
/* -------------------------------------------------------------------------- */

/**
 * Datagrams one snapshot needs. A populated AoI does not fit one datagram at the
 * rig's payload size, and this is the division that makes the batch real: the
 * emitter issues one `sendDatagramBatch` of exactly this many per session per
 * tick.
 */
export function snapshotDatagrams(): number {
	return Math.ceil(
		(AOI_ENTITIES * AOI_BYTES_PER_ENTITY) / SNAPSHOT_PAYLOAD_BYTES,
	);
}

/** Downstream snapshot datagrams per session per second (§1.3). */
export function snapshotPpsPerSession(): number {
	return snapshotDatagrams() * SNAPSHOT_HZ;
}

/**
 * Every Nth upstream tick carries `class = ACTION`. Derived so the action rate
 * comes out at `ACTION_HZ` without a second timer running beside the movement
 * ticker — one schedule, one lag figure.
 */
export function actionEveryNthTick(): number {
	return Math.round(MOVE_HZ / ACTION_HZ);
}

export type ArmShape = {
	sessions: number;
	/** Upstream */
	movePps: number;
	upstreamAggregatePps: number;
	upstreamPayloadBytes: number;
	moveIntervalMs: number;
	actionEveryNthTick: number;
	/** Downstream snapshot */
	snapshotDatagramsPerTick: number;
	snapshotPpsPerSession: number;
	snapshotAggregatePps: number;
	snapshotPayloadBytes: number;
	/** Batch calls/s the emitter issues — the number the lever actually changes. */
	emitterCrossingsPerSec: number;
	/** Sessions the emitter serves in one 20 ms slice. */
	sessionsPerSlice: number;
	datagramsPerSlice: number;
	/** Downstream ack */
	ackAggregatePps: number;
	ackPayloadBytes: number;
	/** Totals */
	downstreamAggregatePps: number;
	serverTotalPps: number;
	/** Payload bitrate of the downstream snapshot class, for the cable STOP. */
	snapshotMbps: number;
};

/** The whole shape of one rung, from the scenario constants. */
export function armShape(sessions: number): ArmShape {
	const perTick = snapshotDatagrams();
	const snapshotPerSession = snapshotPpsPerSession();
	const snapshotAggregate = sessions * snapshotPerSession;
	const slices = Math.max(1, Math.round(EMITTER_SLICE_HZ / SNAPSHOT_HZ));
	return {
		sessions,
		movePps: MOVE_HZ,
		upstreamAggregatePps: sessions * MOVE_HZ,
		upstreamPayloadBytes: UPSTREAM_PAYLOAD_BYTES,
		moveIntervalMs: 1000 / MOVE_HZ,
		actionEveryNthTick: actionEveryNthTick(),
		snapshotDatagramsPerTick: perTick,
		snapshotPpsPerSession: snapshotPerSession,
		snapshotAggregatePps: snapshotAggregate,
		snapshotPayloadBytes: SNAPSHOT_PAYLOAD_BYTES,
		emitterCrossingsPerSec: sessions * SNAPSHOT_HZ,
		sessionsPerSlice: Math.ceil(sessions / slices),
		datagramsPerSlice: Math.ceil(sessions / slices) * perTick,
		ackAggregatePps: sessions * ACTION_HZ,
		ackPayloadBytes: ACK_PAYLOAD_BYTES,
		downstreamAggregatePps: snapshotAggregate + sessions * ACTION_HZ,
		serverTotalPps:
			sessions * MOVE_HZ + snapshotAggregate + sessions * ACTION_HZ,
		snapshotMbps: (snapshotAggregate * SNAPSHOT_PAYLOAD_BYTES * 8) / 1e6,
	};
}

/** The rung the gate's clauses are evaluated on. */
export function gateRung(): number {
	return REALM_LADDER[REALM_LADDER.length - 1] as number;
}

/* -------------------------------------------------------------------------- */
/* Wire arithmetic — what the cable has to carry                              */
/* -------------------------------------------------------------------------- */

/**
 * Bytes one UDP datagram of `payloadBytes` occupies on Ethernet, including the
 * parts a naive bitrate calculation forgets: preamble and inter-frame gap.
 * Ticket 29 §3 fixed this arithmetic; it is repeated here rather than cited so
 * the pre-flight requirement and the runbook cannot drift.
 */
export function wireBytes(payloadBytes: number): number {
	return (
		payloadBytes +
		8 /* UDP */ +
		20 /* IPv4 */ +
		14 /* Eth */ +
		4 /* FCS */ +
		8 /* preamble */ +
		12 /* IFG */
	);
}

/** Packets/s a link of `linkBitsPerSec` carries at this payload size. */
export function wirePpsCeiling(
	payloadBytes: number,
	linkBitsPerSec: number,
): number {
	return Math.floor(linkBitsPerSec / (wireBytes(payloadBytes) * 8));
}

export const GIGABIT = 1_000_000_000;

/* -------------------------------------------------------------------------- */
/* The cable STOP's registered requirements — §8                              */
/* -------------------------------------------------------------------------- */

/** Link loss the path may show and still license a run (§8). */
export const PREFLIGHT_MAX_LOSS_PCT = 0.1;
/** QUIC's minimum, and what a 1150 B payload plus framing needs (§8). */
export const PREFLIGHT_MIN_MTU_BYTES = 1280;

/** Idle RTT p99 the path may spend: 10% of the round-trip budget (§8). */
export function preflightMaxIdleRttP99Ms(): number {
	return rttBudgetMs() / 10;
}

export type PreflightRequirementSpec = {
	name: "R-down" | "R-up";
	offeredPps: number;
	payloadBytes: number;
	maxLossPct: number;
	minMtuBytes: number;
	maxIdleRttP99Ms: number;
};

/**
 * The two requirements §8 registers, derived from the gate rung's own shape so a
 * change to the scenario cannot leave the cable STOP checking the old rate.
 *
 * R-down deliberately covers the *snapshot* class only: it is the class that
 * decides whether the wire can carry the arm at all, and mixing the 64 B ack
 * class into one pps figure would understate the byte load at the size that
 * matters.
 */
export function preflightRequirements(
	sessions = gateRung(),
): PreflightRequirementSpec[] {
	const shape = armShape(sessions);
	const idle = preflightMaxIdleRttP99Ms();
	return [
		{
			name: "R-down",
			offeredPps: shape.snapshotAggregatePps,
			payloadBytes: shape.snapshotPayloadBytes,
			maxLossPct: PREFLIGHT_MAX_LOSS_PCT,
			minMtuBytes: PREFLIGHT_MIN_MTU_BYTES,
			maxIdleRttP99Ms: idle,
		},
		{
			name: "R-up",
			offeredPps: shape.upstreamAggregatePps,
			payloadBytes: shape.upstreamPayloadBytes,
			maxLossPct: PREFLIGHT_MAX_LOSS_PCT,
			minMtuBytes: PREFLIGHT_MIN_MTU_BYTES,
			maxIdleRttP99Ms: idle,
		},
	];
}

/**
 * How much of a link the gate rung's downstream occupies. Prediction P1 turns on
 * this being the binding requirement, and §8 discloses it as the live risk: at
 * 1 GbE the headroom is 1.37×, which is not much of a margin for a gate.
 */
export function downstreamWireOccupancy(
	sessions = gateRung(),
	linkBitsPerSec = GIGABIT,
): { ceilingPps: number; offeredPps: number; occupancy: number } {
	const shape = armShape(sessions);
	const ceilingPps = wirePpsCeiling(shape.snapshotPayloadBytes, linkBitsPerSec);
	return {
		ceilingPps,
		offeredPps: shape.snapshotAggregatePps,
		occupancy: shape.snapshotAggregatePps / ceilingPps,
	};
}

/* -------------------------------------------------------------------------- */
/* Storm shape — §1.8 / §5                                                    */
/* -------------------------------------------------------------------------- */

/** Severed cohorts, in the order they run (§1.8). */
export function stormCohorts(sessions = gateRung()): number[] {
	return [Math.round(sessions / 5), sessions];
}

/** An MMO client retries immediately (§1.8). */
export const STORM_RECONNECT_DELAY_MS = 1000;
/** The shipped `idleTimeoutMs` default the storm window is derived from (§5.4). */
export const SHIPPED_IDLE_TIMEOUT_MS = 60_000;

/** Twice the server's own idle timeout (§5.4). Not a number from a run. */
export function stormWindowSec(): number {
	return (2 * SHIPPED_IDLE_TIMEOUT_MS) / 1000;
}

/* -------------------------------------------------------------------------- */
/* Clause bounds the classifier reads                                         */
/* -------------------------------------------------------------------------- */

/** Delivery bar, carried unchanged from G1 (§2 C1/C2). */
export const DELIVERY_FLOOR = 0.995;
/** Emitter and generator honesty fractions (§2 C6, §7 V-G). */
export const EMITTED_FRACTION_FLOOR = 0.99;
export const OFFERED_RATIO_FLOOR = 0.99;
/** Stage-ledger residual tolerance, carried from G1 C4a (§2 C5). */
export const STAGE_RESIDUAL_FRACTION = 0.001;
/** Server-observed vs kernel-delivered (§2 C5). */
export const SERVER_OBSERVED_FLOOR = 0.995;
/** Mac floor arm: 20% of the round-trip budget (§7 V-F). */
export function floorLagCeilingMs(): number {
	return rttBudgetMs() * 0.2;
}
/** Sink pre-check multiple and delivery bar (§7 V-S). */
export const SINK_HEADROOM_FACTOR = 1.5;
export const SINK_DELIVERY_FLOOR = 0.995;
/** Histogram skew tolerance, as a fraction of the sample count (§7 V-K). */
export const HISTOGRAM_SKEW_FRACTION = 0.001;
/** Little's-law band around the client's permit pool (§7 V-L). */
export const LITTLE_BAND = 0.2;

/**
 * The exact tick count a session's registered schedule makes due over a
 * window. This is the same arithmetic the Rust client uses — first tick at
 * half an interval plus the session's stagger fraction, then one tick per
 * interval — so an evaluator comparing a client's due counter against this
 * value is comparing two computations of one registered schedule, not a
 * measurement against an approximation. The epsilon absorbs float error on
 * offsets that land exactly on a tick boundary.
 */
export function exactTicksDueAfter(
	durationSec: number,
	intervalSec: number,
	phaseOffset: number,
): number {
	if (!(durationSec > 0) || !(intervalSec > 0)) return 0;
	const clampedPhase = Math.min(1, Math.max(0, phaseOffset));
	const firstTickSec = intervalSec / 2 + intervalSec * clampedPhase;
	if (durationSec < firstTickSec) return 0;
	const epsilon = intervalSec * 1e-9;
	return Math.floor((durationSec - firstTickSec + epsilon) / intervalSec) + 1;
}

/**
 * The exact total due for a staggered population slice: sessions
 * `startIndex..startIndex + count` of a `totalSessions`-strong fleet, each
 * offset by `index / totalSessions` of an interval exactly as the client
 * staggers them. The realm arms use the whole fleet, the storm-survivor
 * window uses the indices past the severed cohort, and a single-session role
 * is the slice of one.
 */
export function exactStaggeredWindowDue(options: {
	durationSec: number;
	intervalSec: number;
	totalSessions: number;
	startIndex: number;
	count: number;
}): number {
	const { durationSec, intervalSec, totalSessions, startIndex, count } =
		options;
	if (totalSessions <= 0 || count <= 0) return 0;
	let total = 0;
	for (let offset = 0; offset < count; offset += 1) {
		total += exactTicksDueAfter(
			durationSec,
			intervalSec,
			(startIndex + offset) / totalSessions,
		);
	}
	return total;
}

/**
 * Client endpoints for the registered gate workload: the sessions are spread
 * across this many client UDP sockets. The bench-g6 conductor has always run
 * the gate's client this way; a single-socket client at the 5,000-session
 * rung collapses on its own egress path (datagram frames accepted but never
 * transmitted, connections starved into server idle-closes), which measures
 * the socket, not the server. Any conductor claiming the gate's workload
 * identity must spawn the client with exactly this value.
 */
export const GATE_CLIENT_ENDPOINTS = 64;
