/**
 * The egress originator's scheduling loop, and the three instruments it keeps.
 *
 * Split out of `bench-egress.ts` so the loop can be driven by a test against a
 * fake sender: gate G3's first registration was struck because its
 * "generator honesty" metric was recorded across `await send(...)` and so moved
 * 3.6× with the choice of product API. A metric that claims to be a property of
 * the scheduler has to be testable without a server, and it now is.
 *
 * Three instruments, and the whole correction is in the separation
 * (`docs/research/preregistrations/gate-g3b.md` §2):
 *
 * - `schedulerLag` — intended grid time → the instant the schedule clock is
 *   ready to hand the event over. The honesty instrument.
 * - `handoffDelay` — clock-ready → the emitter actually taking the event.
 *   Diagnostic.
 * - `sendCallDuration` — handoff → settlement. The arm's per-event product
 *   cost. Diagnostic, never part of an honesty condition.
 *
 * **Why the clock is on another thread (the fix for run `32238304133`).** G3b's
 * first run was declared INVALID on its own validity falsifier V1: the arms'
 * `schedulerLag` p99 still spread 2.3–3.9×. Not awaiting the emitter was not
 * enough — the scheduling loop and the emitter shared one event loop, so a
 * costlier arm delayed the timer callback that read the ready instant.
 * `handoffDelay` p99 was 1.4–4.8 µs on every arm and every rung, which ruled the
 * queue out as the carrier and left only the event loop itself. An in-process
 * scheduler cannot be decoupled from the emitter's CPU by any arrangement of
 * `await`s.
 *
 * So the grid now runs in a `Worker` (`egress-clock-worker.ts`) and reaches this
 * thread only through a `SharedArrayBuffer` ring. `schedulerLag` is measured
 * wholly inside the worker, on a clock the emitter cannot delay; what the
 * emitter's own load costs shows up in `handoffDelay`, which is a diagnostic,
 * and in `sendEventsDropped`, which is the arm's own H2 condition. The
 * in-process loop is retained below as `driveProfileInProcess` — the falsifier's
 * negative control, and nothing else runs on it.
 */

import {
	type ClockMessage,
	type ClockReport,
	CTRL_ABORT,
	CTRL_DONE,
	CTRL_HEAD,
	CTRL_TAIL,
	controlView,
	createRingBuffer,
	FIELD_AMPLITUDE,
	FIELD_INTENDED_NS,
	FIELD_READY_NS,
	FIELD_SEQUENCE_BASE,
	FIELD_SESSION,
	RECORD_FIELDS,
	RING_CAPACITY,
	recordView,
} from "./egress-clock-ring.ts";
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
	 * Intended grid time → the instant the schedule clock was ready to hand the
	 * event over. The honesty instrument (gate-g3b §2.2). Under `driveProfile`
	 * both terms are read inside the clock worker, so it cannot contain product
	 * time and cannot be delayed by the emitter's CPU.
	 *
	 * Early wakes are recorded as a lag of zero rather than discarded, so the
	 * percentile is an order statistic of every scheduled event and not of the
	 * late subset (see `schedulerEarlyWakes`).
	 */
	schedulerLag: LatencyHistogramJson;
	/**
	 * How many of those events the clock woke *before* their deadline. Diagnostic
	 * — they are already in `schedulerLag` at zero.
	 */
	schedulerEarlyWakes: number;
	/**
	 * Which thread produced `schedulerLag`. `worker` is the only reading G3b's V1
	 * can be evaluated against; `in-process` is the retained negative control;
	 * `none` is a shape with no JS send grid at all (the fan-out forward side).
	 */
	lagInstrumentThread: "worker" | "in-process" | "none";
	/**
	 * Events the clock could not publish because this thread had not drained the
	 * ring within its capacity. A property of the consuming (emitter) thread, so
	 * it is folded into `sendEventsDropped` and reported here for visibility.
	 */
	ringOverflowEvents: number;
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
	/**
	 * Injectable so a test can drive the in-process control on its own schedule.
	 * The worker-driven loop's grid lives on another thread and takes no
	 * injected sleep.
	 */
	sleep?: (ms: number) => Promise<void>;
	/** Ring depth, in grid events. Only a test has any reason to shrink it. */
	ringCapacity?: number;
};

type PendingEvent = {
	amplitude: number;
	effectiveIntendedNs: number;
	sequenceBase: number;
	readyNs: number;
};

/**
 * The retained in-process scheduling loop — **the falsifier's negative control,
 * and nothing else.**
 *
 * This is the loop run `32238304133` was driven by. It never awaits the emitter,
 * yet its `schedulerLag` still tracks the emitter's CPU, because the grid's
 * timer callbacks and the arm's work are queued on the same event loop. It is
 * kept, exported and named so `egress-driver.test.ts` can demonstrate the
 * coupling on a CPU-burning fake sender and show that the worker-driven loop
 * does not have it. **No bench arm may call it.**
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
export async function driveProfileInProcess(
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
	let earlyWakes = 0;

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
			if (amplitude > 0) {
				const lag = readyNs - effectiveIntendedNs;
				// Same clamp as the worker: an early wake is zero lateness and belongs
				// in the rank, not out of it.
				if (lag < 0) earlyWakes += 1;
				schedulerLag.record(lag > 0 ? lag : 0);
			}

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
		schedulerEarlyWakes: earlyWakes,
		lagInstrumentThread: "in-process",
		ringOverflowEvents: 0,
		handoffDelay: handoffDelay.toJson(),
		sendCallDuration: sendCallDuration.toJson(),
		sendIssueSpread: sendIssueSpread.toJson(),
		gridPeriodNs: plan.gridPeriodNs,
		peakWindowDatagrams: peakWindowDatagrams(plan, sessions),
		driveWindowSec: Math.max(driveEndNs - anchorNs, 1) / 1e9,
	};
}

/** How far apart the two threads' clocks may read at handshake before we refuse
 *  to believe they are the same counter. Both are `CLOCK_MONOTONIC`, so the true
 *  gap is one message round trip; 50 ms is a decade of margin over that and
 *  still catches a different epoch, which differs by the process uptime. */
const CLOCK_EPOCH_GUARD_NS = 50_000_000;

/** Longest the emitter parks on an empty ring before re-checking the done flag. */
const RING_WAIT_MS = 2;

/**
 * Drive one burst profile against a set of send functions for `seconds`, with
 * the grid clock on its own thread.
 *
 * The clock worker owns every deadline and publishes `{session, amplitude,
 * intended, ready, sequenceBase}` into a shared ring; this thread consumes the
 * ring and does all of the arm's work. The per-session emission shape is
 * unchanged from the depth-one slot §12 Amendment 1 registered: one event in
 * flight, at most one waiting, a third dropped and counted.
 *
 * What changed is only where the honesty stamp is read. `schedulerLag` is now a
 * property of a thread that runs no product code, so V1 (§2.4) is a question
 * about the box's timers rather than about the arm — which is what it was always
 * written to ask.
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
	const capacity = options.ringCapacity ?? RING_CAPACITY;
	const sab = createRingBuffer(capacity);
	const ctrl = controlView(sab);
	const records = recordView(sab);
	const handoffDelay = new LatencyHistogram();
	const sendCallDuration = new LatencyHistogram();
	const sendIssueSpread = new LatencyHistogram();
	const burnNs = options.burnNs ?? 0;
	let sent = 0;
	let sendErrors = 0;
	let eventsDropped = 0;

	const poolSize = Math.max(1, ...plan.amplitudes);
	const pools = senders.map(() =>
		Array.from(
			{ length: poolSize },
			() => new StampedPayload(options.payloadBytes),
		),
	);
	const inFlight: Array<Promise<void> | null> = new Array(sessions).fill(null);
	const waiting: Array<PendingEvent | null> = new Array(sessions).fill(null);

	const worker = new Worker(
		new URL("./egress-clock-worker.ts", import.meta.url).href,
		{ type: "module" },
	);

	let onReady: ((m: ClockMessage) => void) | null = null;
	let onReport: ((m: ClockReport) => void) | null = null;
	let fail: ((err: Error) => void) | null = null;
	const ready = new Promise<ClockMessage>((resolve, reject) => {
		onReady = resolve;
		fail = reject;
	});
	const reported = new Promise<ClockReport>((resolve, reject) => {
		onReport = resolve;
		const previous = fail;
		fail = (err) => {
			previous?.(err);
			reject(err);
		};
	});
	worker.onmessage = (event: MessageEvent) => {
		const message = event.data as ClockMessage;
		if (message.type === "ready") onReady?.(message);
		else if (message.type === "report") onReport?.(message);
		else fail?.(new Error(`egress-driver: clock worker: ${message.message}`));
	};
	worker.onerror = (event: ErrorEvent) => {
		fail?.(new Error(`egress-driver: clock worker failed: ${event.message}`));
	};

	try {
		const handshake = await ready;
		if (handshake.type !== "ready") {
			throw new Error("egress-driver: clock worker did not hand shake");
		}
		// Both threads must be reading one counter, or `handoffDelay` and the
		// in-datagram `intended` stamp are nonsense. `Bun.nanoseconds()` is *not*
		// that counter across threads — its epoch is per-thread — so this guard
		// exists to catch a caller that passed one.
		const skewNs = Math.abs(clock.now() - handshake.clockProbeNs);
		if (!(skewNs < CLOCK_EPOCH_GUARD_NS)) {
			throw new Error(
				`egress-driver: driver clock and clock worker are on different epochs ` +
					`(${(skewNs / 1e6).toFixed(1)} ms apart) — the driver clock must be ` +
					`CLOCK_MONOTONIC (latency-clock.ts), not Bun.nanoseconds()`,
			);
		}

		const pump = (index: number): void => {
			if (inFlight[index] !== null) return;
			const job = waiting[index];
			if (!job) return;
			waiting[index] = null;
			// The emitter takes it here, and only here. Everything before this
			// instant belongs to the clock thread; everything after belongs to the arm.
			const handoffNs = clock.now();
			handoffDelay.record(handoffNs - job.readyNs);
			inFlight[index] = emitEvent(
				emitter,
				senders[index] as SessionSender,
				pools[index] as StampedPayload[],
				job.amplitude,
				job.effectiveIntendedNs,
				job.sequenceBase,
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
					inFlight[index] = null;
					pump(index);
				});
		};

		worker.postMessage({
			type: "start",
			sab,
			capacity,
			plan,
			sessions,
			seconds,
			anchorLeadNs: 50_000_000, // 50 ms so every session loop starts armed
		});

		let tail = 0;
		const waitAsync = Atomics.waitAsync as typeof Atomics.waitAsync | undefined;
		while (true) {
			const head = Atomics.load(ctrl, CTRL_HEAD);
			while (tail < head) {
				const base = (tail % capacity) * RECORD_FIELDS;
				const index = records[base + FIELD_SESSION] as number;
				const job: PendingEvent = {
					amplitude: records[base + FIELD_AMPLITUDE] as number,
					effectiveIntendedNs: records[base + FIELD_INTENDED_NS] as number,
					readyNs: records[base + FIELD_READY_NS] as number,
					sequenceBase: records[base + FIELD_SEQUENCE_BASE] as number,
				};
				tail += 1;
				// The depth-one slot, unchanged: queued if nothing waits, dropped only
				// if one already does (gate-g3b §12, Amendment 1).
				if (waiting[index] !== null) eventsDropped += 1;
				else {
					waiting[index] = job;
					pump(index);
				}
			}
			Atomics.store(ctrl, CTRL_TAIL, tail);
			if (
				Atomics.load(ctrl, CTRL_DONE) === 1 &&
				tail === Atomics.load(ctrl, CTRL_HEAD)
			) {
				break;
			}
			if (waitAsync) {
				const parked = waitAsync(ctrl, CTRL_HEAD, tail, RING_WAIT_MS);
				if (parked.async) await parked.value;
				else await Promise.resolve();
			} else {
				await Bun.sleep(0);
			}
		}

		const report = await reported;
		for (let i = 0; i < sessions; i += 1) {
			while (waiting[i] !== null || inFlight[i] !== null) {
				const pending = inFlight[i];
				if (pending) await pending;
				else await Promise.resolve();
			}
		}
		const driveEndNs = clock.now();

		return {
			emitter,
			sent,
			sendErrors,
			// Run plus skipped plus dropped: every grid event the plan put inside the
			// step, not only the ones that survived to run.
			sendEventsScheduled:
				report.eventsHanded + report.eventsZero + report.eventsSkipped,
			sendEventsSkipped: report.eventsSkipped,
			// A ring the emitter did not drain is the emitter failing to take the
			// event, which is exactly what `sendEventsDropped` counts.
			sendEventsDropped: eventsDropped + report.ringOverflowEvents,
			scheduledDatagrams: scheduledDatagrams(
				plan,
				sessions,
				eventsForSeconds(plan, seconds),
			),
			schedulerLag: report.schedulerLag,
			schedulerEarlyWakes: report.earlyWakes,
			lagInstrumentThread: "worker",
			ringOverflowEvents: report.ringOverflowEvents,
			handoffDelay: handoffDelay.toJson(),
			sendCallDuration: sendCallDuration.toJson(),
			sendIssueSpread: sendIssueSpread.toJson(),
			gridPeriodNs: plan.gridPeriodNs,
			peakWindowDatagrams: peakWindowDatagrams(plan, sessions),
			driveWindowSec: Math.max(driveEndNs - report.anchorNs, 1) / 1e9,
		};
	} finally {
		Atomics.store(ctrl, CTRL_ABORT, 1);
		worker.terminate();
	}
}
