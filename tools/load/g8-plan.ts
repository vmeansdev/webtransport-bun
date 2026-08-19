/**
 * Gate G8's scenario arithmetic, as functions over the scenario's constants.
 *
 * Every number here is a transcription of a derivation in
 * `docs/research/preregistrations/gate-g8-many-rooms.md` §1. Nothing in this
 * file decides anything; it exists so the arithmetic that produced the
 * registration's tables can be executed and unit-tested rather than trusted.
 *
 * G6's amendment 1 is why: its §1.3 claimed three datagrams per snapshot from a
 * figure that produces two, and mechanising the arithmetic is what exposed it.
 * Constants that live only in prose drift from the tables they generated.
 */

import { STAMP_BYTES_V3 } from "./latency-stamp.ts";

/** Opus speech frame period. One datagram per frame. */
export const FRAME_PERIOD_MS = 20;
/** Opus fullband-speech operating point the voice arms use (registration §1.2). */
export const OPUS_KBPS = 32;
/** Discord's default *channel* bitrate — the disclosed, not-covered variant. */
export const OPUS_KBPS_DISCLOSED = 64;
/** 3 Mbps video at 1150 B, quantised as 11 datagrams per tick at 30 Hz (K4). */
export const VIDEO_RATE_PER_SEC = 330;
export const VIDEO_PAYLOAD_BYTES = 1150;
/** Subscribers in a room. Registration §1.3. */
export const ROOM_SUBSCRIBERS = 10;
/** Members of a mutual room — K6's formula's P. */
export const MUTUAL_MEMBERS = 10;

/** One Opus frame period. Registration §1.5, derived twice. */
export const VOICE_BOUND_NS = 20e6;
/** One 30 fps frame — G3's and G4's bound, taken unchanged so arm B compares. */
export const VIDEO_BOUND_NS = 33.3e6;

/** Blast-radius caps, not capability claims. Registration §3.2. */
export const PUBLISHERS_PER_PROCESS = 25;
export const SUBSCRIBERS_PER_PROCESS = 250;

/** The sink pre-check's multiple of the rung's forward load (`SINK_HEADROOM_FACTOR`). */
export const SINK_PRECHECK_FACTOR = 1.5;

/** Fraction of the bound that V-G allows a publisher's schedule lag. §6 V-G. */
export const PUBLISHER_LAG_FRACTION = 0.1;
/** Fraction of the bound that V-H(c) allows the conductor's own lateness. */
export const CONDUCTOR_LAG_FRACTION = 0.1;
/** Fraction of the bound that bands the M-scaling reading. §8. */
export const SCALING_BAND_FRACTION = 0.1;
/** V-H(b): `handlerToForward` p99 growth allowed across an arm's ladder. */
export const HANDLER_GROWTH_FACTOR = 2;

export type G8Arm = "voice" | "video" | "mutual";

export const G8_ARMS: readonly G8Arm[] = ["voice", "video", "mutual"];

export function isG8Arm(value: string): value is G8Arm {
	return value === "voice" || value === "video" || value === "mutual";
}

/** The registered ladders. Registration §1.4. */
export const G8_LADDERS: Readonly<Record<G8Arm, readonly number[]>> = {
	voice: [10, 50, 100],
	video: [2, 5, 10],
	mutual: [2, 5, 10],
};

/**
 * Payload bytes for a voice datagram: the Opus frame, plus the stamp we carry
 * in place of an RTP header.
 *
 * The stamp is 48 B against RTP's 12 + 4, so the datagram is bigger than
 * production rather than smaller — the byte-side reading is conservative in the
 * direction that matters, and the registration says so.
 */
export function voicePayloadBytes(
	kbps: number = OPUS_KBPS,
	frameMs: number = FRAME_PERIOD_MS,
	stampBytes: number = STAMP_BYTES_V3,
): number {
	const mediaBits = kbps * 1000 * (frameMs / 1000);
	return Math.round(mediaBits / 8) + stampBytes;
}

/** Datagrams per second from a frame period. */
export function ratePerSecFromFrameMs(
	frameMs: number = FRAME_PERIOD_MS,
): number {
	return Math.round(1000 / frameMs);
}

export type ArmShape = {
	arm: G8Arm;
	/** Publishers in one room. 1 for the broadcast arms, P for mutual. */
	publishersPerRoom: number;
	/** Receive-only subscribers in one room. 0 for mutual — the members publish. */
	subscribersPerRoom: number;
	/** Sessions a room needs. */
	sessionsPerRoom: number;
	/** Targets one arrival fans out to. K for broadcast, P−1 for mutual. */
	targetsPerArrival: number;
	/** Datagrams per second, per publisher. */
	ratePerSec: number;
	payloadBytes: number;
	boundNs: number;
	frameMs: number;
};

/** The three arm shapes. Registration §1.4. */
export function armShape(arm: G8Arm): ArmShape {
	if (arm === "video") {
		return {
			arm,
			publishersPerRoom: 1,
			subscribersPerRoom: ROOM_SUBSCRIBERS,
			sessionsPerRoom: 1 + ROOM_SUBSCRIBERS,
			targetsPerArrival: ROOM_SUBSCRIBERS,
			ratePerSec: VIDEO_RATE_PER_SEC,
			payloadBytes: VIDEO_PAYLOAD_BYTES,
			boundNs: VIDEO_BOUND_NS,
			// 11 datagrams per tick at 30 Hz — K4's quantised form.
			frameMs: 1000 / 30,
		};
	}
	if (arm === "mutual") {
		return {
			arm,
			publishersPerRoom: MUTUAL_MEMBERS,
			subscribersPerRoom: 0,
			sessionsPerRoom: MUTUAL_MEMBERS,
			targetsPerArrival: MUTUAL_MEMBERS - 1,
			ratePerSec: ratePerSecFromFrameMs(),
			payloadBytes: voicePayloadBytes(),
			boundNs: VOICE_BOUND_NS,
			frameMs: FRAME_PERIOD_MS,
		};
	}
	return {
		arm,
		publishersPerRoom: 1,
		subscribersPerRoom: ROOM_SUBSCRIBERS,
		sessionsPerRoom: 1 + ROOM_SUBSCRIBERS,
		targetsPerArrival: ROOM_SUBSCRIBERS,
		ratePerSec: ratePerSecFromFrameMs(),
		payloadBytes: voicePayloadBytes(),
		boundNs: VOICE_BOUND_NS,
		frameMs: FRAME_PERIOD_MS,
	};
}

export type RungPlan = ArmShape & {
	rooms: number;
	publishers: number;
	subscribers: number;
	sessions: number;
	ingestPerSec: number;
	forwardPerSec: number;
	totalPerSec: number;
	/** Bytes per second the forward direction offers. Disclosure, not a gate. */
	forwardBytesPerSec: number;
	publisherProcesses: number;
	/**
	 * Sessions that receive forwarded media. The subscribers in a broadcast room;
	 * the members themselves in a mutual one, where the sink pool is not a second
	 * pool. V-S drives this shape.
	 */
	sinkSessions: number;
	sinkProcesses: number;
	/** Rooms allowed to be out of spec: `floor(0.01 × M)`. §5. */
	roomTolerance: number;
	/** Publishers allowed to fail V-G: `floor(0.01 × publishers)`. §6 V-G. */
	publisherTolerance: number;
	sinkPrecheckOfferedPerSec: number;
	publisherLagBoundNs: number;
	conductorLagBoundNs: number;
	scalingBandNs: number;
};

/**
 * One rung of one arm, fully derived.
 *
 * `forwardPerSec = rooms × publishersPerRoom × targetsPerArrival × rate` is the
 * only place the fan-out arithmetic lives. For the broadcast arms that is
 * `M × K × R`; for mutual it is `M × P × (P−1) × R`, which is K6's formula with
 * the room count factored out — deliberately, so arm C's output lands in G4's
 * own units.
 */
export function rungPlan(arm: G8Arm, rooms: number): RungPlan {
	const shape = armShape(arm);
	const publishers = rooms * shape.publishersPerRoom;
	const subscribers = rooms * shape.subscribersPerRoom;
	const ingestPerSec = publishers * shape.ratePerSec;
	const forwardPerSec = ingestPerSec * shape.targetsPerArrival;
	const publisherProcesses = poolSize(publishers, PUBLISHERS_PER_PROCESS);
	return {
		...shape,
		rooms,
		publishers,
		subscribers,
		sessions: rooms * shape.sessionsPerRoom,
		ingestPerSec,
		forwardPerSec,
		totalPerSec: ingestPerSec + forwardPerSec,
		forwardBytesPerSec: forwardPerSec * shape.payloadBytes,
		publisherProcesses,
		sinkSessions: subscribers > 0 ? subscribers : publishers,
		// A mutual room's members publish *and* receive on the same session, so
		// its sink pool is not a second pool — it is the publisher pool. Reporting
		// a separate count would imply an isolation the shape does not have.
		sinkProcesses:
			subscribers > 0
				? poolSize(subscribers, SUBSCRIBERS_PER_PROCESS)
				: publisherProcesses,
		roomTolerance: tolerance(rooms),
		publisherTolerance: tolerance(publishers),
		sinkPrecheckOfferedPerSec: Math.round(forwardPerSec * SINK_PRECHECK_FACTOR),
		publisherLagBoundNs: shape.boundNs * PUBLISHER_LAG_FRACTION,
		conductorLagBoundNs: shape.boundNs * CONDUCTOR_LAG_FRACTION,
		scalingBandNs: shape.boundNs * SCALING_BAND_FRACTION,
	};
}

/** Processes a pool needs at a per-process cap. Registration §3.2. */
export function poolSize(members: number, perProcess: number): number {
	if (members <= 0) return 0;
	return Math.ceil(members / Math.max(perProcess, 1));
}

/**
 * The 1%-of-cohort tolerance, `floor(0.01 × n)`.
 *
 * Registration §5: a worst-of-M clause is a max over M order statistics and
 * tightens automatically as M grows; a pooled aggregate alone lets one broken
 * room vanish into ninety-nine healthy ones. This form means the same thing at
 * every M — and at M ≤ 99 it means "none", which is intended.
 */
export function tolerance(n: number): number {
	return Math.floor(0.01 * n);
}

/**
 * Deterministic phase offset for one publisher, in nanoseconds.
 *
 * M publishers sharing a 20 ms grid with no offset is an aligned impulse of M
 * datagrams every frame — the ingest-side twin of the egress impulse G6 had to
 * spread. Real capture clocks are not aligned. The aligned case is registered as
 * NOT covered (§1.6); this is what makes it not the case being measured.
 */
export function phaseOffsetNs(
	index: number,
	total: number,
	periodNs: number,
): number {
	if (total <= 1) return 0;
	return Math.round((index % total) * (periodNs / total));
}

/**
 * Which sink process a room's `slot`-th subscriber belongs to.
 *
 * Round-robin over the *global* subscriber index, so room identity and
 * sink-process identity are independent (§3.2). If a room's members shared a
 * sink process, a stall there would present as a room failure and point at the
 * server; spread, it smears across rooms and the per-room clauses stay
 * attributable.
 */
export function sinkProcessFor(
	globalSubscriberIndex: number,
	sinkProcesses: number,
): number {
	if (sinkProcesses <= 1) return 0;
	return globalSubscriberIndex % sinkProcesses;
}

/**
 * Forward-issue CPU the conductor must find, in seconds per second, at G4's
 * measured per-target crossing cost.
 *
 * The applicable per-target figure is K7's **N=10** column, 9.73 µs — not the
 * 6.31 µs headline, which is the N=50 step and is cheaper because the issue
 * loop's warm-up amortises over a wider fan-out. G8's fan-out is K=10.
 */
export const PER_TARGET_ISSUE_NS = 9_730;

export function forwardIssueLoad(forwardPerSec: number): number {
	return (forwardPerSec * PER_TARGET_ISSUE_NS) / 1e9;
}

/** The whole registered plan, one row per rung. */
export function g8Plan(
	ladders: Readonly<Record<G8Arm, readonly number[]>> = G8_LADDERS,
): RungPlan[] {
	const rows: RungPlan[] = [];
	for (const arm of G8_ARMS) {
		for (const rooms of ladders[arm] ?? []) rows.push(rungPlan(arm, rooms));
	}
	return rows;
}
