/**
 * The pre-check's own arithmetic, fed the signatures it exists to reject.
 *
 * Common-doc §4.3: a condition that lives only in prose is the G3b failure
 * mode. `buildPreflightReport` decides three things a reader could otherwise
 * get wrong — which host-CPU figure survives two shapes, whether one shape's
 * shortfall fails the whole pre-check, and that a missing measurement is never
 * a zero — so each is pinned here.
 */

import { describe, expect, test } from "bun:test";
import { evaluatePreflight, preflightRequirements } from "./g7-plan.ts";
import {
	AMENDED_REQUIREMENTS,
	AMENDED_SINK_EVENTS_PER_SEC,
	buildPreflightReport,
	type ShapeResult,
} from "./g7-precheck.ts";

function shape(over: Partial<ShapeResult> & Pick<ShapeResult, "shape">): ShapeResult {
	return {
		sinkRatePerSec: 1,
		sourceRatePerSec: 1,
		sourceShortfall: false,
		hostCpuPctMedian: 10,
		sinkCpuPctOfOneCoreMedian: 100,
		sourceCpuPctOfOneCoreMedian: 100,
		sinkCpuPctOfHost: 12.5,
		sourceCpuPctOfHost: 12.5,
		sinkSummary: null,
		sourceSummary: null,
		loopback: true,
		clockDeltaMs: 0.01,
		notes: [],
		...over,
	};
}

describe("the amended bar", () => {
	test("is 1.5 x 125,500 and replaces only the event field", () => {
		expect(AMENDED_SINK_EVENTS_PER_SEC).toBe(188_250);
		expect(AMENDED_REQUIREMENTS.sinkEventsPerSec).toBe(188_250);
		expect(AMENDED_REQUIREMENTS.sinkBytesPerSec).toBe(
			preflightRequirements().sinkBytesPerSec,
		);
		expect(AMENDED_REQUIREMENTS.clockAgreementMs).toBe(
			preflightRequirements().clockAgreementMs,
		);
	});

	test("the gate branch's own evaluator still returns the unamended bar", () => {
		expect(preflightRequirements().sinkEventsPerSec).toBe(37_500);
	});

	test("a sink that clears the old bar and misses the new one FAILS", () => {
		const report = buildPreflightReport(
			[
				shape({ shape: "bytes", sinkRatePerSec: 400_000_000 }),
				shape({ shape: "events", sinkRatePerSec: 50_000 }),
			],
			{ sameDay: true },
		);
		expect(evaluatePreflight(report, preflightRequirements()).ok).toBe(true);
		const amended = evaluatePreflight(report, AMENDED_REQUIREMENTS);
		expect(amended.ok).toBe(false);
		expect(amended.reasons.join(" ")).toContain("188250");
	});
});

describe("buildPreflightReport", () => {
	test("takes the worst host CPU of the two shapes, never the average", () => {
		const report = buildPreflightReport(
			[
				shape({ shape: "bytes", hostCpuPctMedian: 5 }),
				shape({ shape: "events", hostCpuPctMedian: 95 }),
			],
			{ sameDay: true },
		);
		expect(report.sourceHostCpuPctMedian).toBe(95);
		expect(evaluatePreflight(report, AMENDED_REQUIREMENTS).reasons.join(" ")).toContain(
			"saturated",
		);
	});

	test("an unmeasured host CPU in either shape is null, not the other shape's", () => {
		const report = buildPreflightReport(
			[
				shape({ shape: "bytes", hostCpuPctMedian: null }),
				shape({ shape: "events", hostCpuPctMedian: 5 }),
			],
			{ sameDay: true },
		);
		expect(report.sourceHostCpuPctMedian).toBeNull();
		expect(evaluatePreflight(report, AMENDED_REQUIREMENTS).ok).toBe(false);
	});

	test("either shape's source shortfall fails the pre-check", () => {
		const report = buildPreflightReport(
			[
				shape({ shape: "bytes", sourceShortfall: true, sinkRatePerSec: 1e9 }),
				shape({ shape: "events", sinkRatePerSec: 1e6 }),
			],
			{ sameDay: true },
		);
		expect(report.sourceShortfall).toBe(true);
		expect(evaluatePreflight(report, AMENDED_REQUIREMENTS).reasons.join(" ")).toContain(
			"did not source its own offer",
		);
	});

	test("a missing shape leaves its rate null, and null is never a pass", () => {
		const report = buildPreflightReport([shape({ shape: "bytes" })], {
			sameDay: true,
		});
		expect(report.sinkEventsPerSecObserved).toBeNull();
		expect(evaluatePreflight(report, AMENDED_REQUIREMENTS).reasons.join(" ")).toContain(
			"sink event rate not measured",
		);
	});

	test("the largest-magnitude clock delta survives, sign kept", () => {
		const report = buildPreflightReport(
			[
				shape({ shape: "bytes", clockDeltaMs: 1 }),
				shape({ shape: "events", clockDeltaMs: -80 }),
			],
			{ sameDay: true },
		);
		expect(report.clockDeltaMs).toBe(-80);
		expect(evaluatePreflight(report, AMENDED_REQUIREMENTS).reasons.join(" ")).toContain(
			"clock domains disagree",
		);
	});

	test("one non-loopback shape makes the whole pre-check non-loopback", () => {
		const report = buildPreflightReport(
			[
				shape({ shape: "bytes", loopback: false }),
				shape({ shape: "events" }),
			],
			{ sameDay: true },
		);
		expect(report.loopback).toBe(false);
	});

	test("a pre-check that straddled midnight is not same-day", () => {
		const report = buildPreflightReport([shape({ shape: "bytes" })], {
			sameDay: false,
		});
		expect(evaluatePreflight(report, AMENDED_REQUIREMENTS).reasons.join(" ")).toContain(
			"not from the run's own day",
		);
	});
});
