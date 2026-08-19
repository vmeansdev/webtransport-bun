/**
 * The histogram and its percentile, exercised against the readings that would
 * otherwise be discovered to be wrong only after a run: a tail that sits above
 * the gate's 25 ms bound, a population that is mostly non-positive, and a
 * snapshot produced with foreign edges (which is what the Rust generator sends).
 */

import { describe, expect, test } from "bun:test";
import {
	emptySnapshot,
	G11Histogram,
	HISTOGRAM_CEILING_MS,
	type LatencySnapshot,
	percentileMs,
	sampleCount,
} from "./g11-histogram.ts";

describe("recording", () => {
	test("a non-positive sample is counted, ranked and never dropped", () => {
		const h = new G11Histogram();
		h.record(-3);
		h.record(0);
		h.record(5);
		const s = h.snapshot();
		expect(s.negativeCount).toBe(2);
		expect(sampleCount(s)).toBe(3);
	});

	test("nanoseconds convert, including from a BigInt stamp difference", () => {
		const h = new G11Histogram();
		h.recordNs(2_000_000n);
		expect(percentileMs(h.snapshot(), 1)).toBeGreaterThanOrEqual(2);
		expect(percentileMs(h.snapshot(), 1)).toBeLessThan(2.1);
	});

	test("a sample above the last edge still moves maxMs", () => {
		const h = new G11Histogram();
		h.record(HISTOGRAM_CEILING_MS * 4);
		expect(h.snapshot().maxMs).toBe(HISTOGRAM_CEILING_MS * 4);
	});

	test("merge is additive over counts and negatives alike", () => {
		const a = new G11Histogram();
		const b = new G11Histogram();
		a.record(1);
		a.record(-1);
		b.record(1);
		b.record(-1);
		a.merge(b.snapshot());
		const s = a.snapshot();
		expect(s.negativeCount).toBe(2);
		expect(sampleCount(s)).toBe(4);
	});
});

describe("percentile", () => {
	test("an empty distribution reports 0, not NaN", () => {
		expect(percentileMs(emptySnapshot(), 0.99)).toBe(0);
	});

	test("the p99 of a tight distribution lands at the tight value", () => {
		const h = new G11Histogram();
		for (let i = 0; i < 1000; i += 1) h.record(2);
		expect(percentileMs(h.snapshot(), 0.99)).toBeCloseTo(2, 1);
	});

	test("a tail thicker than 1% is what the p99 reports", () => {
		// The reading C6/C7 depend on: a slow tail must not average away into a
		// pass. Nearest-rank is the definition — 2 of 100 samples above the bound
		// put the 99th-ranked sample in the tail, where exactly 1 of 100 would
		// not, and that boundary is pinned here rather than discovered later.
		const h = new G11Histogram();
		for (let i = 0; i < 98; i += 1) h.record(1);
		h.record(40);
		h.record(40);
		expect(percentileMs(h.snapshot(), 0.99)).toBeGreaterThan(25);

		const thin = new G11Histogram();
		for (let i = 0; i < 99; i += 1) thin.record(1);
		thin.record(40);
		expect(percentileMs(thin.snapshot(), 0.99)).toBeLessThan(25);
		expect(thin.snapshot().maxMs).toBe(40);
	});

	test("non-positive samples rank at the bottom and consume the low quantiles", () => {
		const h = new G11Histogram();
		for (let i = 0; i < 90; i += 1) h.record(-1);
		for (let i = 0; i < 10; i += 1) h.record(50);
		expect(percentileMs(h.snapshot(), 0.5)).toBe(0);
		expect(percentileMs(h.snapshot(), 0.99)).toBeGreaterThan(25);
	});

	test("a percentile outside (0, 1] is refused rather than clamped", () => {
		expect(() => percentileMs(emptySnapshot(), 0)).toThrow();
		expect(() => percentileMs(emptySnapshot(), 1.5)).toThrow();
	});

	test("a foreign snapshot is read through its own edges", () => {
		// This is the shape the Rust generator emits: its own edges travel with
		// its counts, so nothing here assumes the two languages agreed on a
		// bucket table.
		const foreign: LatencySnapshot = {
			negativeCount: 0,
			bucketUpperMs: [1, 10, 100],
			bucketCounts: [98, 1, 1],
			maxMs: 90,
		};
		expect(percentileMs(foreign, 0.99)).toBe(10);
		expect(percentileMs(foreign, 1)).toBe(100);
		expect(sampleCount(foreign)).toBe(100);
	});
});
