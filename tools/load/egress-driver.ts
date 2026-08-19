/**
 * The egress originator's scheduling loop, and the two instruments it keeps.
 *
 * Split out of `bench-egress.ts` so the loop can be driven by a test against a
 * fake sender: gate G3's first registration was struck because its
 * "generator honesty" metric was recorded across `await send(...)` and so moved
 * 3.6× with the choice of product API. A metric that claims to be a property of
 * the scheduler has to be testable without a server, and it now is.
 *
 * Two instruments, and the whole correction is in the separation
 * (`docs/research/preregistrations/gate-g3b.md` §2):
 *
 * - `schedulerLag` — intended grid time → the instant the event is handed to
 *   the emitter, read **before** any await of it. A property of the timing loop
 *   alone.
 * - `sendCallDuration` — handoff → settlement of that event's emission. The
 *   product's cost for one event under one arm, reported as a diagnostic and
 *   never part of an honesty condition.
 *
 * The loop keeps at most one event per session in flight, exactly as awaiting
 * the emitter did, so no arm's emission concurrency changes. What changed is
 * that the *timing* loop no longer waits on the emitter: an event the emitter
 * is not ready for is dropped and counted, never queued and never caught up.
 */

import {
	type EgressEmitter,
	emitEvent,
	type SessionSender,
	type StampedSlot,
} from "./egress-emitter.ts";
import {
	amplitudeAt,
	type EgressPlan,
	eventsForSeconds,
	peakWindowDatagrams,
	phaseNsFor,
	scheduledDatagrams,
} from "./egress-schedule.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";
import {
	OFFSET_ACTUAL,
	OFFSET_INTENDED,
	OFFSET_MAGIC,
	OFFSET_SEQUENCE,
	OFFSET_VERSION,
	STAMP_BYTES,
	STAMP_MAGIC,
	STAMP_VERSION,
} from "./latency-stamp.ts";

export type EgressClock = { now(): number };

/**
 * One payload buffer with its stamp fields written in place.
 *
 * Fields are written through a retained DataView rather than `encodeStamp` so
 * the hot path allocates nothing at all — the layout still comes from
 * `latency-stamp.ts`, so there is one source of truth for it.
 *
 * Sessions hold a *pool* of these, one per position within a grid event, not
 * one shared buffer: the batched send copies its elements at the call, after
 * every element has been stamped, so a shared buffer would put the last stamp
 * on every datagram in the batch. All three arms use the pool, so no arm is
 * measured against a different allocation shape than another
 * (`docs/research/preregistrations/gate-g3.md` §3.1).
 */
export class StampedPayload implements StampedSlot {
	readonly bytes: Uint8Array;
	private readonly view: DataView;

	constructor(byteLength: number) {
		if (byteLength < STAMP_BYTES) {
			throw new Error(`payload must be at least ${STAMP_BYTES} bytes`);
		}
		this.bytes = new Uint8Array(byteLength).fill(0x78 /* 'x' */);
		this.view = new DataView(this.bytes.buffer);
		this.view.setUint16(OFFSET_MAGIC, STAMP_MAGIC, true);
		this.view.setUint16(OFFSET_VERSION, STAMP_VERSION, true);
	}

	stamp(intendedNs: number, actualNs: number, sequence: number): void {
		writeU64(this.view, OFFSET_INTENDED, intendedNs);
		writeU64(this.view, OFFSET_ACTUAL, actualNs);
		writeU64(this.view, OFFSET_SEQUENCE, sequence);
	}
}

function writeU64(view: DataView, offset: number, value: number): void {
	const low = value % 4294967296;
	view.setUint32(offset, low, true);
	view.setUint32(offset + 4, (value - low) / 4294967296, true);
}

/**
 * The headroom control's lag bound, derived from the registered shape
 * (gate-g3b §3): a burst train stays the registered train only while every
 * burst lands inside its own grid period, so `T` is the shape boundary and the
 * p99 bound is set at `T/2` — a factor-2 margin for the untested tail, and an
 * even split of the one-frame budget C2 measures the transport against.
 *
 * Grid-relative by construction: 16.667 ms on the 30 Hz frame grid, 2.5 ms on
 * the `constant` profile's 5 ms grid. Never a constant.
 */
export function headroomLagBoundNs(gridPeriodNs: number): number {
	return gridPeriodNs / 2;
}

/** The quarter-grid diagnostic §3.4 requires on every rung, convenient or not. */
export function quarterGridNs(gridPeriodNs: number): number {
	return gridPeriodNs / 4;
}

export function burn(clock: EgressClock, ns: number): void {
	if (ns <= 0) return;
	const end = clock.now() + ns;
	while (clock.now() < end) {
		// deliberate busy-wait
	}
}

export type OriginatorStats = {
	sent: number;
	sendErrors: number;
	/** Every grid event the plan put inside the step — run, skipped and dropped. */
	sendEventsScheduled: number;
	/** Whole grid periods the *scheduler* woke past. A rig property. */
	sendEventsSkipped: number;
	/**
	 * Events the scheduler was ready for and the emitter could not take, because
	 * it was still working on the previous one and one was already waiting. A
	 * property of the arm, never of the rig.
	 */
	sendEventsDropped: number;
	scheduledDatagrams: number;
	/**
	 * Intended grid time → the instant the scheduler was ready to hand the event
	 * over, read before any await of the emitter. The honesty instrument
	 * (gate-g3b §2.2). It cannot contain product time: the loop never waits on
	 * the emitter.
	 */
	schedulerLag: LatencyHistogramJson;
	/**
	 * Scheduler-ready → the emitter actually taking the event. Zero when the
	 * emitter was free; positive when the arm was still busy with the previous
	 * event. The product-side backpressure diagnostic.
	 */
	handoffDelay: LatencyHistogramJson;
	/**
	 * Handoff → settlement of that event's emission. The product's per-event
	 * cost under this arm; a diagnostic, never an honesty condition.
	 */
	sendCallDuration: LatencyHistogramJson;
	/** first to last datagram inside one send event. */
	sendIssueSpread: LatencyHistogramJson;
	gridPeriodNs: number;
	peakWindowDatagrams: number;
	/**
	 * The interval the originator was actually driving, on the shared monotonic
	 * clock. Every rate divides by this and never by a wall clock that also
	 * contains the CPU sampler, the client's exit or a process spawn.
	 */
	driveWindowSec: number;
	/** Which originator arm produced these numbers. */
	emitter: EgressEmitter;
};

export type DriveOptions = {
	burnNs?: number;
	payloadBytes: number;
	/** Injectable so a test can drive the loop on its own schedule. */
	sleep?: (ms: number) => Promise<void>;
};

type PendingEvent = {
	amplitude: number;
	effectiveIntendedNs: number;
	sequenceBase: number;
	readyNs: number;
};

/**
 * Drive one burst profile against a set of send functions for `seconds`.
 *
 * One loop per session, each on its own phase offset — the shape the
 * pre-registration describes. Every grid period is ≥ 5 ms, an order of
 * magnitude above the ~1 ms timer granularity, so the loop cannot become a
 * measurement of `setTimeout`.
 *
 * The loop hands each event to a **depth-one slot** and never awaits the
 * emitter. One event is in flight at a time and at most one waits behind it, so
 * an arm slower than the grid still emits back to back — its sourcing shows up
 * as a rate, the way it did when the loop awaited the send — while the timing
 * loop keeps its own deadlines and `schedulerLag` stays a scheduler property.
 *
 * Three ways an event fails to go out, kept apart because phase 1 fused them
 * and a product result was then read as a rig result:
 *
 * - the loop woke a whole period or more late → `sendEventsSkipped` (the
 *   `generator-saturation` STOP reads this);
 * - one event was in flight and another already waiting → `sendEventsDropped`
 *   (the arm could not take it: a product property);
 * - the send itself failed → `sendErrors`.
 */
export async function driveProfile(
	plan: EgressPlan,
	senders: SessionSender[],
	seconds: number,
	clock: EgressClock,
	emitter: EgressEmitter,
	options: DriveOptions,
): Promise<OriginatorStats> {
	const sessions = senders.length;
	const schedulerLag = new LatencyHistogram();
	const handoffDelay = new LatencyHistogram();
	const sendCallDuration = new LatencyHistogram();
	const sendIssueSpread = new LatencyHistogram();
	const burnNs = options.burnNs ?? 0;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	let sent = 0;
	let sendErrors = 0;
	let eventsRun = 0;
	let eventsSkipped = 0;
	let eventsDropped = 0;

	const anchorNs = clock.now() + 50_000_000; // 50 ms so every loop starts armed
	const endNs = anchorNs + seconds * 1e9;
	const events = eventsForSeconds(plan, seconds);
	// One slot per position inside the largest grid event this plan produces.
	const poolSize = Math.max(1, ...plan.amplitudes);

	const runSession = async (index: number): Promise<void> => {
		const sender = senders[index];
		if (!sender) return;
		const pool = Array.from(
			{ length: poolSize },
			() => new StampedPayload(options.payloadBytes),
		);
		const phaseNs = phaseNsFor(plan, index, sessions);
		const base = anchorNs + phaseNs;
		let eventIndex = 0;
		let sequence = 0;
		let inFlight: Promise<void> | null = null;
		let waiting: PendingEvent | null = null;

		const pump = (): void => {
			if (inFlight !== null || waiting === null) return;
			const job = waiting;
			waiting = null;
			// The emitter takes it here, and only here. Everything before this
			// instant belongs to the scheduler; everything after belongs to the arm.
			const handoffNs = clock.now();
			handoffDelay.record(handoffNs - job.readyNs);
			inFlight = emitEvent(
				emitter,
				sender,
				pool,
				job.amplitude,
				job.effectiveIntendedNs,
				job.sequenceBase,
				// The falsifier's synthetic per-datagram cost is spent *after* the
				// stamp is read and before the element is handed over, so it lands
				// inside the originator on every arm — including the batched one,
				// where there is no per-datagram await to hang it off.
				() => {
					const t = clock.now();
					burn(clock, burnNs);
					return t;
				},
			)
				.then((outcome) => {
					sent += outcome.sent;
					sendErrors += outcome.errors;
					sendCallDuration.record(clock.now() - handoffNs);
					sendIssueSpread.record(outcome.lastActualNs - outcome.firstActualNs);
				})
				.finally(() => {
					inFlight = null;
					pump();
				});
		};

		while (true) {
			const intendedNs = base + eventIndex * plan.gridPeriodNs;
			if (intendedNs >= endNs) break;
			const waitMs = (intendedNs - clock.now()) / 1e6;
			if (waitMs > 0) await sleep(waitMs);

			// Skip whole events we are already past, then send the current one.
			const behind = Math.floor((clock.now() - intendedNs) / plan.gridPeriodNs);
			if (behind > 0) {
				eventsSkipped += behind;
				eventIndex += behind;
				const shifted = base + eventIndex * plan.gridPeriodNs;
				if (shifted >= endNs) break;
			}
			const effectiveIntendedNs = base + eventIndex * plan.gridPeriodNs;
			const amplitude = amplitudeAt(plan, index, sessions, eventIndex);
			// The honesty stamp: the scheduler is ready, and it has awaited nothing
			// but its own deadline to get here.
			const readyNs = clock.now();
			if (amplitude > 0) schedulerLag.record(readyNs - effectiveIntendedNs);

			if (amplitude > 0) {
				if (waiting !== null) {
					eventsDropped += 1;
				} else {
					eventsRun += 1;
					waiting = {
						amplitude,
						effectiveIntendedNs,
						sequenceBase: sequence,
						readyNs,
					};
					pump();
				}
			} else {
				eventsRun += 1;
			}
			sequence += amplitude;
			eventIndex += 1;
		}

		while (waiting !== null || inFlight !== null) {
			if (inFlight !== null) await inFlight;
			else await Promise.resolve();
		}
	};

	await Promise.all(senders.map((_, i) => runSession(i)));
	const driveEndNs = clock.now();

	return {
		emitter,
		sent,
		sendErrors,
		// Run plus skipped plus dropped: the denominator the STOPs are written
		// against is every grid event the plan put inside the step, not only the
		// ones that survived to run.
		sendEventsScheduled: eventsRun + eventsSkipped + eventsDropped,
		sendEventsSkipped: eventsSkipped,
		sendEventsDropped: eventsDropped,
		scheduledDatagrams: scheduledDatagrams(plan, sessions, events),
		schedulerLag: schedulerLag.toJson(),
		handoffDelay: handoffDelay.toJson(),
		sendCallDuration: sendCallDuration.toJson(),
		sendIssueSpread: sendIssueSpread.toJson(),
		gridPeriodNs: plan.gridPeriodNs,
		peakWindowDatagrams: peakWindowDatagrams(plan, sessions),
		driveWindowSec: Math.max(driveEndNs - anchorNs, 1) / 1e9,
	};
}
