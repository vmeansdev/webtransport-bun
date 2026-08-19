/**
 * The egress schedule clock — the grid, and nothing else, on its own thread.
 *
 * This worker owns every deadline of the registered burst train. It sleeps to a
 * deadline, reads `CLOCK_MONOTONIC`, records `schedulerLag`, and publishes the
 * event into the shared ring. It never touches a session, never calls the
 * product, and never awaits anything the emitter does — which is the whole
 * reason it exists (`docs/research/preregistrations/gate-g3b.md` §2.4 V1, and
 * the harness fault logged against run `32238304133` in §9).
 *
 * Two properties this file has to keep, or the instrument is worthless again:
 *
 * 1. **No emitter work reaches this thread.** The only cross-thread traffic is
 *    the ring write and one `Atomics.notify`. Everything an arm does — the
 *    stamping, the `Buffer.from`, the napi crossing, the promise settlement —
 *    happens on the thread that consumes the ring.
 * 2. **The clock is `clock_gettime(CLOCK_MONOTONIC)` read through FFI**, the
 *    same counter the emitter thread and the Rust load client read.
 *    `Bun.nanoseconds()` is *not* usable here: its epoch is the calling thread's
 *    start, so a worker's reading is on a different epoch than the main
 *    thread's. The driver checks the epoch at handshake rather than trusting it.
 */

import {
	type ClockStartMessage,
	CTRL_ABORT,
	CTRL_DONE,
	CTRL_HEAD,
	CTRL_TAIL,
	controlView,
	FIELD_AMPLITUDE,
	FIELD_INTENDED_NS,
	FIELD_READY_NS,
	FIELD_SEQUENCE_BASE,
	FIELD_SESSION,
	RECORD_FIELDS,
	recordView,
} from "./egress-clock-ring.ts";
import { amplitudeAt, type EgressPlan, phaseNsFor } from "./egress-schedule.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

// FFI read per deadline, no fast path: the fast path costs a 200 ms calibration
// sleep and buys ~100 ns on a thread that reads the clock 3,000 times a second.
const clock = await createMonotonicClock(false);

declare const self: Worker;

self.postMessage({
	type: "ready",
	clockProbeNs: clock.now(),
	clockSource: clock.source,
});

let driving = false;

self.onmessage = (event: MessageEvent) => {
	const message = event.data as ClockStartMessage;
	if (message?.type !== "start") return;
	if (driving) {
		self.postMessage({
			type: "error",
			message: "clock worker was asked to drive two steps at once",
		});
		return;
	}
	driving = true;
	run(message)
		.catch((err) => {
			self.postMessage({ type: "error", message: String(err) });
		})
		.finally(() => {
			driving = false;
		});
};

async function run(message: ClockStartMessage): Promise<void> {
	const { sab, capacity, sessions, seconds, anchorLeadNs } = message;
	const plan: EgressPlan = message.plan;
	const ctrl = controlView(sab);
	const records = recordView(sab);
	const schedulerLag = new LatencyHistogram();

	let earlyWakes = 0;
	let eventsHanded = 0;
	let eventsZero = 0;
	let eventsSkipped = 0;
	let ringOverflowEvents = 0;

	const anchorNs = clock.now() + anchorLeadNs;
	const endNs = anchorNs + seconds * 1e9;

	/**
	 * Publish one event. The plain field writes are made visible to the emitter
	 * by the `Atomics.store` that follows them, and by the `Atomics.load` the
	 * emitter does before reading any field.
	 */
	const publish = (
		session: number,
		amplitude: number,
		intendedNs: number,
		readyNs: number,
		sequenceBase: number,
	): void => {
		const head = Atomics.load(ctrl, CTRL_HEAD);
		if (head - Atomics.load(ctrl, CTRL_TAIL) >= capacity) {
			// The emitter has not drained in `capacity` events. That is a property
			// of the consuming thread, so it is counted and folded into the arm's
			// dropped events by the driver — never into the clock's own skips.
			ringOverflowEvents += 1;
			return;
		}
		const base = (head % capacity) * RECORD_FIELDS;
		records[base + FIELD_SESSION] = session;
		records[base + FIELD_AMPLITUDE] = amplitude;
		records[base + FIELD_INTENDED_NS] = intendedNs;
		records[base + FIELD_READY_NS] = readyNs;
		records[base + FIELD_SEQUENCE_BASE] = sequenceBase;
		Atomics.store(ctrl, CTRL_HEAD, head + 1);
		Atomics.notify(ctrl, CTRL_HEAD);
	};

	const runSession = async (index: number): Promise<void> => {
		const phaseNs = phaseNsFor(plan, index, sessions);
		const base = anchorNs + phaseNs;
		let eventIndex = 0;
		let sequence = 0;

		while (true) {
			const intendedNs = base + eventIndex * plan.gridPeriodNs;
			if (intendedNs >= endNs) break;
			if (Atomics.load(ctrl, CTRL_ABORT) === 1) return;
			const waitMs = (intendedNs - clock.now()) / 1e6;
			if (waitMs > 0) await Bun.sleep(waitMs);

			// Skip whole periods we are already past, then take the current one.
			const behind = Math.floor((clock.now() - intendedNs) / plan.gridPeriodNs);
			if (behind > 0) {
				eventsSkipped += behind;
				eventIndex += behind;
				if (base + eventIndex * plan.gridPeriodNs >= endNs) break;
			}
			const effectiveIntendedNs = base + eventIndex * plan.gridPeriodNs;
			const amplitude = amplitudeAt(plan, index, sessions, eventIndex);
			// The honesty stamp. Both terms are read on this thread; no emitter
			// work has run between the deadline and this line, and none can.
			const readyNs = clock.now();

			if (amplitude > 0) {
				const lag = readyNs - effectiveIntendedNs;
				// An early wake is not lateness — it is zero lateness. Recording it
				// as zero puts it in the rank rather than out of it: the first run's
				// percentiles ranked positive samples only, and the early fraction was
				// itself arm-dependent (47–84 %), so the three arms' "p99" were not
				// the same order statistic. Clamping lowers the reported percentiles
				// and enlarges the denominator; the count of early wakes is kept.
				if (lag < 0) earlyWakes += 1;
				schedulerLag.record(lag > 0 ? lag : 0);
				eventsHanded += 1;
				publish(index, amplitude, effectiveIntendedNs, readyNs, sequence);
			} else {
				eventsZero += 1;
			}
			sequence += amplitude;
			eventIndex += 1;
		}
	};

	await Promise.all(Array.from({ length: sessions }, (_, i) => runSession(i)));

	Atomics.store(ctrl, CTRL_DONE, 1);
	Atomics.notify(ctrl, CTRL_HEAD);

	self.postMessage({
		type: "report",
		anchorNs,
		schedulerLag: schedulerLag.toJson(),
		earlyWakes,
		eventsHanded,
		eventsZero,
		eventsSkipped,
		ringOverflowEvents,
	});
}
