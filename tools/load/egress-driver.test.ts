import { describe, expect, test } from "bun:test";
import {
	driveProfile,
	driveProfileInProcess,
	headroomLagBoundNs,
	quarterGridNs,
} from "./egress-driver.ts";
import type { SessionSender } from "./egress-emitter.ts";
import { planFor } from "./egress-schedule.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

const MS = 1e6;
/**
 * `CLOCK_MONOTONIC`, not `Bun.nanoseconds()`: the schedule clock runs in a
 * worker, and `Bun.nanoseconds()` is epoch-per-thread, so the two would not be
 * on one counter. The driver refuses such a clock — pinned below.
 */
const clock = await createMonotonicClock(false);

function p99Ms(json: ReturnType<LatencyHistogram["toJson"]>): number {
	return LatencyHistogram.fromJson(json).percentile(0.99) / MS;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * A sender whose every call settles after `delayMs` of **awaiting**. This is the
 * shape of fake the struck test used, and it is kept because it is what the
 * `sendCallDuration` assertions need — but it is not what falsifies the
 * instrument (see below).
 */
function slowSender(delayMs: number): SessionSender {
	return {
		sendDatagram: async () => {
			if (delayMs > 0) await Bun.sleep(delayMs);
		},
		sendDatagramBatch: async (datagrams) => {
			if (delayMs > 0) await Bun.sleep(delayMs);
			return { sent: datagrams.length };
		},
	};
}

/**
 * A sender that spends `costMs` of **CPU**, in a continuation — the way a real
 * arm's work actually lands: after a yield, competing with the timer rather than
 * inside the scheduling loop's own turn.
 *
 * This is the fixture the previous falsifier lacked. Run `32238304133` was
 * declared INVALID because `schedulerLag` still moved 2.3–3.9× across the arms,
 * and the carrier was the emitter's CPU on the shared event loop — which an
 * await-cost fake does not exercise at all. A test built only from awaiting
 * fakes passes on a loop that has the defect, and did; that is pinned below too.
 */
function burningSender(costMs: number): SessionSender {
	const spin = () => {
		const end = clock.now() + costMs * MS;
		while (clock.now() < end) {
			// deliberate busy-wait: the emitter's cost, paid in CPU
		}
	};
	return {
		sendDatagram: async () => {
			await Bun.sleep(0);
			spin();
		},
		sendDatagramBatch: async (datagrams) => {
			await Bun.sleep(0);
			spin();
			return { sent: datagrams.length };
		},
	};
}

describe("the headroom lag bound is grid-relative", () => {
	test("it is half the grid period, whatever the grid is", () => {
		// gate-g3b §3.3: `T` is where bursts merge into their neighbour's period,
		// so the p99 bound sits at `T/2` — derived from the shape, never typed in.
		expect(headroomLagBoundNs(planFor("frame-bursty", 326).gridPeriodNs)).toBe(
			16_666_666.5,
		);
		expect(headroomLagBoundNs(planFor("constant", 200).gridPeriodNs)).toBe(
			2_500_000,
		);
		expect(quarterGridNs(planFor("frame-bursty", 326).gridPeriodNs)).toBe(
			8_333_333.25,
		);
	});
});

describe("the corrected origination instrument", () => {
	const plan = planFor("constant", 200); // 5 ms grid, one datagram per event
	/** The registered gate shape: a 33.3 ms frame grid, one datagram per frame. */
	const framePlan = planFor("frame-bursty", 30);
	const SESSIONS = 8;
	const DRIVE_S = 1.2;
	const REPEATS = 5;

	/**
	 * Drive two arms an order of magnitude apart in emitter cost, alternating,
	 * and return the arm-to-arm spread of the median `schedulerLag` p99 — V1's own
	 * statistic (§2.4: `max/min` across the arms).
	 *
	 * Alternating and taking medians is not cosmetic: a single drive's p99 on a
	 * developer machine moves by more than a small effect, and the first drive in
	 * a process is always the slowest.
	 */
	async function armSpread(
		drive: typeof driveProfile,
		cheap: () => SessionSender,
		costly: () => SessionSender,
	): Promise<{ cheapMs: number; costlyMs: number; spread: number }> {
		const fleet = (make: () => SessionSender) =>
			Array.from({ length: SESSIONS }, make);
		await drive(framePlan, fleet(cheap), 0.5, clock, "batch", {
			payloadBytes: 64,
		});
		const cheapRuns: number[] = [];
		const costlyRuns: number[] = [];
		for (let i = 0; i < REPEATS; i += 1) {
			cheapRuns.push(
				p99Ms(
					(
						await drive(framePlan, fleet(cheap), DRIVE_S, clock, "batch", {
							payloadBytes: 64,
						})
					).schedulerLag,
				),
			);
			costlyRuns.push(
				p99Ms(
					(
						await drive(framePlan, fleet(costly), DRIVE_S, clock, "serial", {
							payloadBytes: 64,
						})
					).schedulerLag,
				),
			);
		}
		const cheapMs = median(cheapRuns);
		const costlyMs = median(costlyRuns);
		return {
			cheapMs,
			costlyMs,
			spread: Math.max(cheapMs, costlyMs) / Math.min(cheapMs, costlyMs),
		};
	}

	/**
	 * The falsifier for the fault that voided run `32238304133`, and it now
	 * discriminates.
	 *
	 * Eight sessions on the registered 33.3 ms frame grid, driven through both
	 * loops, with two arms 12× apart in emitter CPU: 0.5 ms per event (12 % of the
	 * period across the fleet) against 6 ms (145 %, saturating). The retained
	 * in-process loop — the one that ran the invalid gate — moves by an order of
	 * magnitude even though it awaits nothing, because the burn and the grid's
	 * timers are queued on one event loop. The worker-driven loop does not move,
	 * because its grid runs where the emitter's CPU cannot reach it.
	 *
	 * Measured on this developer machine, three repeats of the whole procedure
	 * (absolute values are a property of the box's timers; arm-independence is the
	 * property being pinned):
	 *
	 * | loop | cheap arm | costly arm | spread |
	 * |---|---|---|---|
	 * | worker-driven | 1.10, 1.16, 1.16 ms | 1.13, 1.10, 1.13 ms | 1.03, 1.06, 1.03 |
	 * | in-process (control) | 1.13, 1.02, 0.99 ms | 33.3, 33.3, 32.8 ms | 8.8 – 33.1 |
	 *
	 * The fixture is CPU for a reason. Replacing `burningSender` with an awaiting
	 * fake of the same nominal cost puts the control's spread at 1.3–3.9× run to
	 * run — sometimes over V1's bar and sometimes well under it, because an
	 * awaiting emitter does not hold the thread and whether the metric moves is
	 * then down to timer luck. A falsifier built on awaiting fakes cannot be
	 * relied on to fail on a loop that has the defect, and the struck one did not:
	 * it asserted a 2 ms difference on a single 1-session drive and passed on the
	 * loop that went on to void the gate run.
	 */
	test("scheduler lag is arm-independent off-thread and arm-coupled in-process", async () => {
		const worker = await armSpread(
			driveProfile,
			() => burningSender(0.5),
			() => burningSender(6),
		);
		const inProcess = await armSpread(
			driveProfileInProcess,
			() => burningSender(0.5),
			() => burningSender(6),
		);

		// The coupling, measured head-on: on the *identical* costly fixture the two
		// instruments disagree by an order of magnitude, and the excess is the
		// emitter's CPU — exactly what an honesty metric must not contain.
		expect(inProcess.costlyMs).toBeGreaterThan(worker.costlyMs * 5);
		// The same statement in V1's own shape: the control moves with the arm past
		// the registered 2× bar, and the off-thread reading does not move much at
		// all. The bars are deliberately loose against the measured values (worker
		// 1.00–1.06, control 29–33 on a quiet box): a shared developer laptop is not
		// a measurement environment, V1 on the runner is what certifies the absolute
		// number, and local macOS timing is never a gate in this repo.
		expect(inProcess.spread).toBeGreaterThan(2.5);
		expect(worker.spread).toBeLessThan(4);
	}, 120_000);

	/**
	 * The awaiting-emitter case, kept from the struck test because
	 * `sendCallDuration` is exactly what it pins — but read over three alternating
	 * repeats rather than one drive each, since a single drive's p99 on a loaded
	 * developer box moves by more than the effect being asserted.
	 */
	test("scheduler lag does not move with an awaiting emitter; send-call duration does", async () => {
		const seconds = 1.2;
		const runs = async (delayMs: number, arm: "batch" | "serial") => {
			const lag: number[] = [];
			const call: number[] = [];
			for (let i = 0; i < 3; i += 1) {
				const stats = await driveProfile(
					plan,
					[slowSender(delayMs)],
					seconds,
					clock,
					arm,
					{ payloadBytes: 64 },
				);
				lag.push(p99Ms(stats.schedulerLag));
				call.push(p99Ms(stats.sendCallDuration));
				expect(stats.lagInstrumentThread).toBe("worker");
			}
			return { lag: median(lag), call: median(call) };
		};
		const fast = await runs(0, "batch");
		const slow = await runs(8, "serial");

		const gridMs = plan.gridPeriodNs / MS;
		// Neither arm's clock fell a whole grid period behind. (The absolute value
		// is a property of this developer machine's timers, not of the instrument
		// — local macOS timing is never a gate in this repo.)
		expect(fast.lag).toBeLessThan(gridMs);
		expect(slow.lag).toBeLessThan(gridMs);
		// Arm-independence itself is pinned by the falsifier above, which measures
		// it against the loop that lacks it; asserting it again here on a single
		// pair of absolute numbers would only add a flake.

		// The honesty instrument is small *relative to the very cost it used to
		// absorb*. On the phase-1 loop this ratio was about 0.5.
		expect(slow.lag).toBeLessThan(slow.call / 3);

		// The product cost went where it belongs, and it is large.
		expect(slow.call).toBeGreaterThan(7);
		expect(fast.call).toBeLessThan(3);
		expect(slow.call).toBeGreaterThan(fast.call + 5);
	}, 120_000);

	/**
	 * The second fault the stamp found in the raw: `LatencyHistogram.record`
	 * counts a negative sample without bucketing it, so the percentile ranked the
	 * late subset only — and the early fraction was itself arm-dependent (47–84 %
	 * across the arms of one rung). The driver now clamps an early wake to zero
	 * so it enters the denominator, and keeps the count.
	 *
	 * `latency-histogram.ts` is deliberately untouched: other axes share it, and
	 * a negative one-way latency there really is a clock violation rather than a
	 * zero.
	 */
	test("early wakes are ranked as zero lateness, not dropped from the rank", async () => {
		const stats = await driveProfile(
			plan,
			[slowSender(0)],
			0.6,
			clock,
			"batch",
			{ payloadBytes: 64 },
		);
		const lag = LatencyHistogram.fromJson(stats.schedulerLag);
		// Nothing left the rank: every non-zero-amplitude event is in the histogram.
		expect(lag.negative).toBe(0);
		expect(lag.count).toBe(stats.sendEventsScheduled - stats.sendEventsSkipped);
		// The information is kept rather than absorbed.
		expect(stats.schedulerEarlyWakes).toBeGreaterThan(0);
		expect(stats.schedulerEarlyWakes).toBeLessThanOrEqual(lag.count);
	}, 30_000);

	test("an emitter slower than the grid drops events without charging the clock", async () => {
		const stats = await driveProfile(
			plan,
			[slowSender(8)],
			0.6,
			clock,
			"serial",
			{ payloadBytes: 64 },
		);

		// The arm could not take every event: that is `sendEventsDropped`, a
		// product property (gate-g3b §4, H2).
		expect(stats.sendEventsDropped).toBeGreaterThan(0);
		// The clock stayed inside its own registered bar: `sendEventsSkipped` is
		// the rig counter and the emitter's cost does not reach it.
		expect(stats.sendEventsSkipped).toBeLessThan(
			0.1 * stats.sendEventsScheduled,
		);
		expect(stats.sendEventsScheduled).toBe(
			stats.sendEventsSkipped +
				stats.sendEventsDropped +
				stats.sent +
				stats.sendErrors,
		);
		// The handoff delay is where waiting behind the emitter is recorded, and it
		// is never part of an honesty condition.
		expect(p99Ms(stats.handoffDelay)).toBeGreaterThan(0);
	}, 30_000);

	test("a free emitter drops nothing and every handoff is instrumented", async () => {
		const stats = await driveProfile(
			plan,
			[slowSender(0)],
			0.4,
			clock,
			"batch",
			{ payloadBytes: 64 },
		);
		expect(stats.sendEventsDropped).toBe(0);
		expect(stats.ringOverflowEvents).toBe(0);
		expect(stats.sendEventsSkipped).toBeLessThan(
			0.1 * stats.sendEventsScheduled,
		);
		expect(stats.sent).toBeGreaterThan(50);
		// Every event that was handed over was instrumented on the way. The
		// magnitude is not asserted: `handoffDelay` now carries the ring transit and
		// the consumer's idle park as well as the arm's backpressure, it is a
		// diagnostic that gates nothing, and its value on a shared laptop is noise.
		expect(LatencyHistogram.fromJson(stats.handoffDelay).count).toBe(
			stats.sent,
		);
	}, 30_000);

	test("a ring the emitter cannot drain is charged to the emitter, not to the clock", async () => {
		// Capacity 4 on a 5 ms grid against a sender that holds the thread for
		// 40 ms: the clock keeps its deadlines, the consumer cannot keep up, and
		// the shortfall lands in the arm's counter — never in `sendEventsSkipped`.
		const stats = await driveProfile(
			plan,
			[burningSender(40)],
			0.6,
			clock,
			"serial",
			{ payloadBytes: 64, ringCapacity: 4 },
		);
		expect(stats.ringOverflowEvents).toBeGreaterThan(0);
		expect(stats.sendEventsDropped).toBeGreaterThanOrEqual(
			stats.ringOverflowEvents,
		);
		// The skip counter is not asserted here on purpose: a sender that holds the
		// thread for eight grid periods at a time starves the whole box, the clock
		// included, and its skips are then a fact about the machine. The rig/arm
		// split is pinned in the test above, where the emitter waits instead of
		// spinning.
		expect(stats.sendEventsScheduled).toBeGreaterThan(0);
	}, 30_000);

	test("a driver clock on another epoch than the clock worker is refused", async () => {
		// `Bun.nanoseconds()` counts from the *calling thread's* start, so a worker
		// reading it is on a different epoch than the main thread. Silently
		// accepting one would make `handoffDelay` and the in-datagram `intended`
		// stamp fiction.
		await expect(
			driveProfile(
				plan,
				[slowSender(0)],
				0.2,
				{ now: () => Number(Bun.nanoseconds()) },
				"batch",
				{ payloadBytes: 64 },
			),
		).rejects.toThrow(/different epochs/);
	}, 30_000);
});
