import { describe, expect, test } from "bun:test";
import {
	driveProfile,
	headroomLagBoundNs,
	quarterGridNs,
} from "./egress-driver.ts";
import type { SessionSender } from "./egress-emitter.ts";
import { planFor } from "./egress-schedule.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

const MS = 1e6;
const clock = { now: () => Number(Bun.nanoseconds()) };

function p99Ms(json: ReturnType<LatencyHistogram["toJson"]>): number {
	return LatencyHistogram.fromJson(json).percentile(0.99) / MS;
}

/**
 * A sender whose every call settles after `delayMs`. Nothing else about it
 * differs between arms, so any difference the instruments show is the delay and
 * the arm's shape, and nothing else.
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
	/**
	 * The falsifier for the defect the final review struck.
	 *
	 * Phase 1 recorded its "generator honesty" metric across `await send(...)`,
	 * so it moved 3.6× with the choice of product API at one offered rate. Here
	 * two arms are driven against senders an order of magnitude apart in cost:
	 * `schedulerLag` must not notice, and `sendCallDuration` must.
	 *
	 * The phase-1 loop was replayed against this exact fixture to fix the
	 * tolerances: awaiting an 8 ms send on a 5 ms grid drove its lag p99 to
	 * ≈ 4.8 ms — the whole grid period, since the skip logic resets it once a
	 * period is lost — against ≈ 1.5 ms here, and its arm-to-arm spread to
	 * ≈ 2.1 ms against ≈ 0.1 ms here. Both assertions below fail on that loop.
	 */
	test("scheduler lag does not move with the emitter; send-call duration does", async () => {
		const plan = planFor("constant", 200); // 5 ms grid, one datagram per event
		const seconds = 1.2;

		const fast = await driveProfile(
			plan,
			[slowSender(0)],
			seconds,
			clock,
			"batch",
			{
				payloadBytes: 64,
			},
		);
		const slow = await driveProfile(
			plan,
			[slowSender(8)],
			seconds,
			clock,
			"serial",
			{
				payloadBytes: 64,
			},
		);

		const gridMs = plan.gridPeriodNs / MS;
		// Neither arm's scheduler fell a whole grid period behind. (The absolute
		// value is a property of this developer machine's timers, not of the
		// instrument, so the arm-independence below is what the test is really
		// pinning — local macOS timing is never a gate in this repo.)
		expect(p99Ms(fast.schedulerLag)).toBeLessThan(gridMs);
		expect(p99Ms(slow.schedulerLag)).toBeLessThan(gridMs);
		// And the two agree to within a couple of timer ticks — the property that
		// makes it a generator metric at all, and the one phase 1's metric lacked.
		expect(
			Math.abs(p99Ms(slow.schedulerLag) - p99Ms(fast.schedulerLag)),
		).toBeLessThan(2);

		// The honesty instrument is now small *relative to the very cost it used
		// to absorb*. On the phase-1 loop this ratio was about 0.5; the send cost
		// was most of the metric.
		expect(p99Ms(slow.schedulerLag)).toBeLessThan(
			p99Ms(slow.sendCallDuration) / 3,
		);

		// The product cost went where it belongs, and it is large.
		expect(p99Ms(slow.sendCallDuration)).toBeGreaterThan(7);
		expect(p99Ms(fast.sendCallDuration)).toBeLessThan(3);
		expect(p99Ms(slow.sendCallDuration)).toBeGreaterThan(
			p99Ms(fast.sendCallDuration) + 5,
		);
	});

	test("an emitter slower than the grid drops events without charging the scheduler", async () => {
		const plan = planFor("constant", 200); // 5 ms grid
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
		// The scheduler stayed inside its own registered bar: `sendEventsSkipped`
		// is the rig counter and the emitter's cost does not reach it. Phase 1 had
		// one bucket for both.
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
	});

	test("a free emitter drops nothing and hands over on the grid", async () => {
		const plan = planFor("constant", 200);
		const stats = await driveProfile(
			plan,
			[slowSender(0)],
			0.4,
			clock,
			"batch",
			{ payloadBytes: 64 },
		);
		expect(stats.sendEventsDropped).toBe(0);
		expect(stats.sendEventsSkipped).toBeLessThan(
			0.1 * stats.sendEventsScheduled,
		);
		expect(stats.sent).toBeGreaterThan(50);
		expect(p99Ms(stats.handoffDelay)).toBeLessThan(1);
	});
});
