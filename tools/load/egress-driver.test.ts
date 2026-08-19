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
	 * | in-process (control) | 1.13, 1.02, 0.99 ms | 33.3, 33.3, 32.8 ms | 29.5, 32.5, 33.1 |
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

		// The instrument agrees across arms — inside V1's registered 2× bar with
		// room to spare, on the same fixture that moves the control 30×.
		expect(worker.spread).toBeLessThan(1.5);
		// …and the loop that produced the invalid run does not, on the same
		// fixture, driven by the same test, in the same process.
		expect(inProcess.spread).toBeGreaterThan(10);
		expect(inProcess.spread).toBeGreaterThan(worker.spread * 5);
	}, 120_000);

	/**
	 * Why the struck test passed: its fakes paid their cost in `await`, and an
	 * awaiting emitter does not hold the thread, so the in-process loop keeps its
	 * deadlines and its metric looks arm-independent. Same loop, same grid, same
	 * order-of-magnitude cost difference (0.5 ms vs 60 ms), and the spread lands
	 * at 1.32–1.36 — comfortably inside the 2× bar the CPU fixture above breaks by
	 * 30×.
	 *
	 * This is pinned so nobody rebuilds the falsifier out of awaiting fakes again.
	 */
	test("an awaiting fake cannot detect the fault — which is why the struck test passed", async () => {
		const fleet = (delayMs: number) =>
			Array.from({ length: SESSIONS }, () => slowSender(delayMs));
		const cheap: number[] = [];
		const costly: number[] = [];
		for (let i = 0; i < 3; i += 1) {
			cheap.push(
				p99Ms(
					(
						await driveProfileInProcess(
							framePlan,
							fleet(0.5),
							DRIVE_S,
							clock,
							"batch",
							{ payloadBytes: 64 },
						)
					).schedulerLag,
				),
			);
			costly.push(
				p99Ms(
					(
						await driveProfileInProcess(
							framePlan,
							fleet(60),
							DRIVE_S,
							clock,
							"serial",
							{ payloadBytes: 64 },
						)
					).schedulerLag,
				),
			);
		}
		const a = median(cheap);
		const b = median(costly);
		expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(2);
	}, 120_000);

	test("scheduler lag does not move with an awaiting emitter; send-call duration does", async () => {
		const seconds = 1.2;
		const fast = await driveProfile(
			plan,
			[slowSender(0)],
			seconds,
			clock,
			"batch",
			{ payloadBytes: 64 },
		);
		const slow = await driveProfile(
			plan,
			[slowSender(8)],
			seconds,
			clock,
			"serial",
			{ payloadBytes: 64 },
		);

		const gridMs = plan.gridPeriodNs / MS;
		// Neither arm's clock fell a whole grid period behind. (The absolute value
		// is a property of this developer machine's timers, not of the instrument
		// — local macOS timing is never a gate in this repo.)
		expect(p99Ms(fast.schedulerLag)).toBeLessThan(gridMs);
		expect(p99Ms(slow.schedulerLag)).toBeLessThan(gridMs);
		expect(
			Math.abs(p99Ms(slow.schedulerLag) - p99Ms(fast.schedulerLag)),
		).toBeLessThan(2);

		// The honesty instrument is small *relative to the very cost it used to
		// absorb*. On the phase-1 loop this ratio was about 0.5.
		expect(p99Ms(slow.schedulerLag)).toBeLessThan(
			p99Ms(slow.sendCallDuration) / 3,
		);

		// The product cost went where it belongs, and it is large.
		expect(p99Ms(slow.sendCallDuration)).toBeGreaterThan(7);
		expect(p99Ms(fast.sendCallDuration)).toBeLessThan(3);
		expect(p99Ms(slow.sendCallDuration)).toBeGreaterThan(
			p99Ms(fast.sendCallDuration) + 5,
		);
		expect(slow.lagInstrumentThread).toBe("worker");
	}, 30_000);

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

	test("a free emitter drops nothing and is handed events promptly", async () => {
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
		// Ring transit plus one event-loop turn. Measured 0.06–0.24 ms here.
		expect(p99Ms(stats.handoffDelay)).toBeLessThan(2);
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
		expect(stats.sendEventsSkipped).toBe(0);
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
