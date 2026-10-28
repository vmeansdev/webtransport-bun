/**
 * Phase 2.1: rate (count/events-per-second) and percent recorders.
 *
 * Siblings of the throughput `openThroughputMeasurement` path. Events /
 * attempts are observed by the caller; the recorder files samples under an
 * attestation the arm builder resolves through `takeMeasurementRecord`.
 */

import { describe, expect, test } from "bun:test";
import {
	openPercentMeasurement,
	openRateMeasurement,
	PERCENT_SAMPLE_UNIT,
	RATE_SAMPLE_UNIT,
	RATE_WINDOW_MS_DEFAULT,
	takeMeasurementRecord,
} from "./stats.ts";

describe("openRateMeasurement: events-per-second windowed recorder", () => {
	test("files one rate sample for a known event count over a known window", () => {
		let now = 1_000;
		const recorder = openRateMeasurement({
			driverRunId: "rate-smoke",
			clock: {
				nowMs: () => now,
				method: "test-clock",
			},
			histogramBoundaries: [0, 1, 10, 100, 1_000, 10_000],
			windowMs: 1_000,
		});
		// 5_000 events over 1000 ms = 5_000 events/s
		recorder.markEvents(5_000);
		now = 2_000;
		const sealed = recorder.seal();
		expect(sealed.unit).toBe(RATE_SAMPLE_UNIT);
		expect(sealed.samples).toHaveLength(1);
		expect(sealed.samples[0]).toBeCloseTo(5_000, 5);
		expect(sealed.roundTrips).toEqual([]);
		expect(sealed.provenance.sampleCount).toBe(1);
		expect(sealed.provenance.attestation).toBe(recorder.attestation);
		const taken = takeMeasurementRecord(recorder.attestation);
		expect(taken?.unit).toBe("count");
		expect(takeMeasurementRecord(recorder.attestation)).toBeUndefined();
	});

	test("default window is RATE_WINDOW_MS_DEFAULT", () => {
		expect(RATE_WINDOW_MS_DEFAULT).toBe(1_000);
	});

	test("refuses seal with no events observed", () => {
		const recorder = openRateMeasurement({
			driverRunId: "empty-rate",
			clock: { nowMs: () => 0 },
			histogramBoundaries: [0, 1],
		});
		expect(() => recorder.seal()).toThrow(/no events/);
	});

	test("refuses a non-positive windowMs", () => {
		expect(() =>
			openRateMeasurement({
				driverRunId: "bad-window",
				clock: { nowMs: () => 0 },
				histogramBoundaries: [0, 1],
				windowMs: 0,
			}),
		).toThrow(/windowMs/);
	});

	test("refuses negative event counts", () => {
		const recorder = openRateMeasurement({
			driverRunId: "neg",
			clock: { nowMs: () => 0 },
			histogramBoundaries: [0, 1],
		});
		expect(() => recorder.markEvents(-1)).toThrow(/non-negative/);
	});
});

describe("openPercentMeasurement: delivery-percent recorder", () => {
	test("files 100% when every attempt is delivered", () => {
		const recorder = openPercentMeasurement({
			driverRunId: "percent-100",
			clock: { nowMs: () => 1_000, method: "test-clock" },
			histogramBoundaries: [0, 50, 100],
		});
		recorder.markAttempt();
		recorder.markDelivered();
		recorder.markAttempt();
		recorder.markDelivered();
		const sealed = recorder.seal();
		expect(sealed.unit).toBe(PERCENT_SAMPLE_UNIT);
		expect(sealed.samples).toHaveLength(1);
		expect(sealed.samples[0]).toBe(100);
		expect(sealed.roundTrips).toEqual([]);
		const taken = takeMeasurementRecord(recorder.attestation);
		expect(taken?.unit).toBe("percent");
		expect(takeMeasurementRecord(recorder.attestation)).toBeUndefined();
	});

	test("files 50% when half the attempts are delivered", () => {
		const recorder = openPercentMeasurement({
			driverRunId: "percent-50",
			clock: { nowMs: () => 2_000 },
			histogramBoundaries: [0, 50, 100],
		});
		recorder.markAttempt();
		recorder.markDelivered();
		recorder.markAttempt();
		const sealed = recorder.seal();
		expect(sealed.unit).toBe(PERCENT_SAMPLE_UNIT);
		expect(sealed.samples).toHaveLength(1);
		expect(sealed.samples[0]).toBe(50);
	});

	test("refuses seal with zero attempts", () => {
		const recorder = openPercentMeasurement({
			driverRunId: "empty-percent",
			clock: { nowMs: () => 0 },
			histogramBoundaries: [0, 100],
		});
		expect(() => recorder.seal()).toThrow(/at least one attempt/);
	});
});
