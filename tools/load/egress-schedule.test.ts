import { describe, expect, test } from "bun:test";
import {
	amplitudeAt,
	cycleOffsetFor,
	eventsForSeconds,
	peakWindowDatagrams,
	phaseNsFor,
	planFor,
	scheduledDatagrams,
} from "./egress-schedule.ts";

describe("constant profile", () => {
	test("offers exactly the requested rate even when it does not divide the grid", () => {
		for (const rate of [110, 220, 326, 490, 652, 815]) {
			const plan = planFor("constant", rate);
			expect(plan.perCycle).toBe(rate);
			expect(plan.effectiveRatePerSession).toBe(rate);
			expect(plan.amplitudes).toHaveLength(200);
		}
	});

	test("keeps its grid an order of magnitude above timer granularity", () => {
		expect(planFor("constant", 326).gridPeriodNs).toBe(5_000_000);
	});
});

describe("frame profiles", () => {
	test("3 Mbps is eleven datagrams a frame and fifty-five on a keyframe", () => {
		const plan = planFor("frame-bursty", 326);
		expect(plan.amplitudes[0]).toBe(55);
		expect(plan.amplitudes[1]).toBe(11);
		expect(plan.cycleEvents).toBe(60);
	});

	test("the keyframe multiplier's 6.67% inflation is reported, not hidden", () => {
		const plan = planFor("frame-bursty", 326);
		// 11/frame nominal is 330/s; four extra frames' worth every 60 frames.
		expect(plan.effectiveRatePerSession).toBeCloseTo(330 * (1 + 4 / 60), 1);
	});

	test("alignment is the only difference between the two frame arms", () => {
		const bursty = planFor("frame-bursty", 326);
		const aligned = planFor("keyframe-aligned", 326);
		expect(aligned.amplitudes).toEqual(bursty.amplitudes);
		expect(aligned.gridPeriodNs).toBe(bursty.gridPeriodNs);
		expect(bursty.staggered).toBe(true);
		expect(aligned.staggered).toBe(false);
	});

	test("the aligned arm produces the registered worst case in one window", () => {
		const aligned = planFor("keyframe-aligned", 326);
		expect(peakWindowDatagrams(aligned, 100)).toBe(5500);
	});

	test("staggering the keyframes flattens the worst window by roughly 5x", () => {
		const bursty = planFor("frame-bursty", 326);
		const peak = peakWindowDatagrams(bursty, 100);
		// 100 sessions spread over 60 cycle slots: at most two share a keyframe.
		expect(peak).toBeLessThan(1500);
		expect(peak).toBeGreaterThan(1000);
	});

	test("sessions of the aligned arm share one deadline and one cycle offset", () => {
		const aligned = planFor("keyframe-aligned", 326);
		expect(phaseNsFor(aligned, 37, 100)).toBe(0);
		expect(cycleOffsetFor(aligned, 37, 100)).toBe(0);
	});

	test("staggered sessions spread across the grid period", () => {
		const bursty = planFor("frame-bursty", 326);
		expect(phaseNsFor(bursty, 0, 100)).toBe(0);
		expect(phaseNsFor(bursty, 50, 100)).toBeCloseTo(bursty.gridPeriodNs / 2, 0);
	});
});

describe("desktop-share profile", () => {
	test("is bimodal and rate-neutral", () => {
		const plan = planFor("desktop-share", 326);
		const idle = plan.amplitudes[0] ?? 0;
		const active = plan.amplitudes[80] ?? 0;
		expect(active).toBeGreaterThan(idle * 4);
		// Same mean as a flat 11-per-frame stream, within the rounding of one
		// datagram per frame.
		expect(plan.effectiveRatePerSession).toBeCloseTo(330, 0);
	});

	test("its quiet phase really is quiet", () => {
		const plan = planFor("desktop-share", 326);
		expect(plan.amplitudes.slice(0, 75).every((a) => a === 1)).toBe(true);
	});
});

describe("scheduled counts", () => {
	test("the shortfall denominator matches the mean rate the plan claims", () => {
		for (const profile of [
			"constant",
			"frame-bursty",
			"keyframe-aligned",
			"desktop-share",
		] as const) {
			const plan = planFor(profile, 326);
			const events = eventsForSeconds(plan, 60);
			const scheduled = scheduledDatagrams(plan, 100, events);
			const expected = plan.effectiveRatePerSession * 100 * 60;
			// Whole cycles rarely divide a 60 s step exactly; 2% covers the
			// partial cycle at the end and nothing else.
			expect(Math.abs(scheduled - expected) / expected).toBeLessThan(0.02);
		}
	});

	test("rejects a rate that cannot be scheduled", () => {
		expect(() => planFor("constant", 0)).toThrow();
		expect(() => planFor("frame-bursty", Number.NaN)).toThrow();
	});
});
