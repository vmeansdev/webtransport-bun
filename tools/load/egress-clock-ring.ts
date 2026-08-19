/**
 * The shared-memory ring the schedule clock publishes grid events into.
 *
 * G3b's first run was declared INVALID on its own validity falsifier (V1): the
 * scheduling loop and the emitter shared one event loop, so `schedulerLag` —
 * the metric that exists to say whether the *rig* held the registered grid —
 * tracked the *arm's* CPU. `handoffDelay` p99 was 1.4–4.8 µs on every arm, which
 * proved the queue was not the carrier; the carrier was the event loop itself.
 *
 * The fix is structural: the grid clock runs in a Bun `Worker`, and the only
 * thing that crosses to the emitter's thread is this ring. The clock never
 * awaits the emitter, never shares its event loop, and never runs its code, so
 * `schedulerLag = readyNs − intendedNs` is read entirely inside the worker and
 * is arm-independent *by construction* rather than by argument.
 *
 * Layout (one `SharedArrayBuffer`):
 *
 * ```
 *   [0 .. CONTROL_BYTES)              Int32Array control words
 *   [CONTROL_BYTES .. end)            Float64Array record ring, CAPACITY × FIELDS
 * ```
 *
 * Publication is the standard release/acquire pattern the JS memory model
 * sanctions: the worker writes a record's plain `Float64` fields and then
 * `Atomics.store`s the head; the emitter `Atomics.load`s the head before reading
 * any field. The seq-cst pair is the synchronization edge.
 */

/** Records published by the clock. Monotone; the reader indexes modulo capacity. */
export const CTRL_HEAD = 0;
/** Records consumed by the emitter. Written by the emitter, read by the clock. */
export const CTRL_TAIL = 1;
/** Set to 1 by the clock when its last grid event has been published. */
export const CTRL_DONE = 2;
/** Set to 1 by the emitter to ask the clock to stop early (teardown path). */
export const CTRL_ABORT = 3;

export const CONTROL_WORDS = 8;
export const CONTROL_BYTES = CONTROL_WORDS * 4;

export const FIELD_SESSION = 0;
export const FIELD_AMPLITUDE = 1;
export const FIELD_INTENDED_NS = 2;
export const FIELD_READY_NS = 3;
export const FIELD_SEQUENCE_BASE = 4;
export const RECORD_FIELDS = 5;

/**
 * 65,536 events of slack, 2.6 MB. The heaviest registered rung publishes
 * ~15,000 events/s (100 real + 400 shadow sessions at 30 Hz), so the emitter
 * thread would have to stop draining for four seconds before the ring could
 * wrap — and if it ever does, the overflow is counted rather than silently
 * losing events (`ringOverflowEvents`), and charged to the thread that failed
 * to drain, which is the emitter's.
 */
export const RING_CAPACITY = 1 << 16;

export function createRingBuffer(
	capacity: number = RING_CAPACITY,
): SharedArrayBuffer {
	return new SharedArrayBuffer(
		CONTROL_BYTES + capacity * RECORD_FIELDS * Float64Array.BYTES_PER_ELEMENT,
	);
}

export function controlView(sab: SharedArrayBuffer): Int32Array {
	return new Int32Array(sab, 0, CONTROL_WORDS);
}

export function recordView(sab: SharedArrayBuffer): Float64Array {
	return new Float64Array(sab, CONTROL_BYTES);
}

/** The message the emitter's thread sends to start one drive. */
export type ClockStartMessage = {
	type: "start";
	sab: SharedArrayBuffer;
	capacity: number;
	/** The plan is pure data, so it structured-clones into the worker unchanged. */
	plan: import("./egress-schedule.ts").EgressPlan;
	sessions: number;
	seconds: number;
	anchorLeadNs: number;
};

/** What the clock reports back when its grid has run out. */
export type ClockReport = {
	type: "report";
	anchorNs: number;
	/**
	 * Intended → the clock being ready to hand the event over, measured wholly
	 * inside the worker. Negative samples (an early timer wake) are clamped to
	 * zero before recording — see `earlyWakes`.
	 */
	schedulerLag: import("./latency-histogram.ts").LatencyHistogramJson;
	/**
	 * How often the clock woke *before* its deadline. These are recorded as a lag
	 * of zero rather than dropped: the first run's percentiles ranked only
	 * positive samples while 47–84 % of `frame-bursty` wakes were early, so the
	 * three arms' "p99" were not the same order statistic.
	 */
	earlyWakes: number;
	/** Grid events with a non-zero amplitude handed to the ring. */
	eventsHanded: number;
	/** Grid events the plan gave amplitude zero. */
	eventsZero: number;
	/** Whole grid periods the clock woke past. The rig counter. */
	eventsSkipped: number;
	/** Events dropped because the emitter had not drained the ring. */
	ringOverflowEvents: number;
};

export type ClockReadyMessage = {
	type: "ready";
	/** The worker's monotonic clock, read at handshake, for the epoch guard. */
	clockProbeNs: number;
	clockSource: string;
};

export type ClockErrorMessage = { type: "error"; message: string };

export type ClockMessage = ClockReadyMessage | ClockReport | ClockErrorMessage;
