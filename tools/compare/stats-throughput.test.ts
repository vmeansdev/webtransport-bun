/**
 * Phase 2.1 / ticket 02a: throughput (Mbps) recorder.
 *
 * Sibling of the latency `openMeasurement` path. Bytes are observed by the
 * caller; the recorder files windowed Mbps samples under an attestation the
 * arm builder resolves through `takeMeasurementRecord`.
 */

import { describe, expect, test } from "bun:test";
import {
	openThroughputMeasurement,
	takeMeasurementRecord,
	THROUGHPUT_SAMPLE_UNIT,
	THROUGHPUT_WINDOW_MS_DEFAULT,
} from "./stats.ts";

describe("openThroughputMeasurement: Mbps windowed recorder", () => {
	test("files one Mbps sample for a known byte count over a known window", () => {
		let now = 1_000;
		const recorder = openThroughputMeasurement({
			driverRunId: "throughput-smoke",
			clock: {
				nowMs: () => now,
				method: "test-clock",
			},
			histogramBoundaries: [0, 1, 10, 100, 1_000],
			windowMs: 1_000,
		});
		// 104,857,600 bytes over 1000 ms = 838.8608 Mbps
		recorder.markBytes(104_857_600);
		now = 2_000;
		const sealed = recorder.seal();
		expect(sealed.unit).toBe(THROUGHPUT_SAMPLE_UNIT);
		expect(sealed.samples).toHaveLength(1);
		expect(sealed.samples[0]).toBeCloseTo(838.8608, 3);
		expect(sealed.deliveredBytes).toBe(104_857_600);
		expect(sealed.roundTrips).toEqual([]);
		expect(sealed.provenance.sampleCount).toBe(1);
		expect(sealed.provenance.attestation).toBe(recorder.attestation);
		const taken = takeMeasurementRecord(recorder.attestation);
		expect(taken?.unit).toBe("Mbps");
		expect(takeMeasurementRecord(recorder.attestation)).toBeUndefined();
	});

	test("default window is THROUGHPUT_WINDOW_MS_DEFAULT", () => {
		expect(THROUGHPUT_WINDOW_MS_DEFAULT).toBe(100);
		let now = 0;
		const recorder = openThroughputMeasurement({
			driverRunId: "default-window",
			clock: { nowMs: () => now },
			histogramBoundaries: [0, 1_000],
		});
		recorder.markBytes(1_000_000);
		now = 100;
		recorder.markBytes(1_000_000);
		now = 200;
		const sealed = recorder.seal();
		// Two full 100 ms windows of 1e6 bytes each → 80 Mbps each
		// (1e6 * 8) / (100 * 1000) = 80
		expect(sealed.samples.length).toBeGreaterThanOrEqual(2);
		expect(sealed.samples[0]).toBeCloseTo(80, 5);
		expect(sealed.deliveredBytes).toBe(2_000_000);
	});

	test("refuses a non-positive windowMs", () => {
		expect(() =>
			openThroughputMeasurement({
				driverRunId: "bad-window",
				clock: { nowMs: () => 0 },
				histogramBoundaries: [0, 1],
				windowMs: 0,
			}),
		).toThrow(/windowMs/);
	});

	test("refuses seal with no bytes observed", () => {
		const recorder = openThroughputMeasurement({
			driverRunId: "empty",
			clock: { nowMs: () => 0 },
			histogramBoundaries: [0, 1],
		});
		expect(() => recorder.seal()).toThrow(/no bytes/);
	});

	test("refuses negative byte counts", () => {
		const recorder = openThroughputMeasurement({
			driverRunId: "neg",
			clock: { nowMs: () => 0 },
			histogramBoundaries: [0, 1],
		});
		expect(() => recorder.markBytes(-1)).toThrow(/non-negative/);
	});

	test("provenance span excludes idle gaps so mean matches deliveredBytes/span", () => {
		let now = 1_000;
		const recorder = openThroughputMeasurement({
			driverRunId: "idle-gap",
			clock: {
				nowMs: () => now,
				method: "test-clock",
			},
			histogramBoundaries: [0, 1, 10, 100, 1_000, 10_000],
			windowMs: 100,
		});
		// Busy 100 ms window: 1_000_000 bytes → 80 Mbps
		recorder.markBytes(1_000_000);
		now = 1_100;
		recorder.markBytes(0);
		// Idle 500 ms (empty windows skipped)
		now = 1_600;
		// Second busy window
		recorder.markBytes(1_000_000);
		now = 1_700;
		const sealed = recorder.seal();
		expect(sealed.samples.length).toBeGreaterThanOrEqual(2);
		const spanMs = Math.max(
			1,
			sealed.provenance.lastSampleAtMs - sealed.provenance.firstSampleAtMs,
		);
		const observedMbps = (sealed.deliveredBytes! * 8) / (spanMs * 1000);
		const mean =
			sealed.samples.reduce((sum, value) => sum + value, 0) /
			sealed.samples.length;
		expect(Math.abs(mean - observedMbps)).toBeLessThan(
			observedMbps * 0.1 + 1e-9,
		);
		// Active span is 200 ms of busy windows, not the 700 ms wall span.
		expect(spanMs).toBeLessThanOrEqual(250);
	});
});
