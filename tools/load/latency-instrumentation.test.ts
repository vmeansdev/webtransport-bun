import { describe, expect, test } from "bun:test";
import { createMonotonicClock } from "./latency-clock.ts";
import { LatencyHistogram, __testing } from "./latency-histogram.ts";
import {
	STAMP_BYTES,
	STAMP_MAGIC,
	decodeStamp,
	encodeStamp,
} from "./latency-stamp.ts";

describe("latency histogram", () => {
	test("buckets are monotonic and within 4% of the recorded value", () => {
		let previous = -1;
		for (const ns of [
			0, 1, 31, 32, 33, 63, 64, 1_000, 9_999, 100_000, 1_500_000, 20_000_000,
			1_000_000_000, 60_000_000_000,
		]) {
			const index = __testing.bucketIndex(ns);
			expect(index).toBeGreaterThan(previous - 1);
			previous = index;
			const value = __testing.bucketValue(index);
			const error = Math.abs(value - ns) / Math.max(ns, 1);
			expect(error).toBeLessThan(0.04);
		}
	});

	test("percentiles track a known distribution", () => {
		const h = new LatencyHistogram();
		// 1..10000 µs, uniform: p50 ≈ 5000 µs, p99 ≈ 9900 µs.
		for (let i = 1; i <= 10_000; i += 1) h.record(i * 1_000);
		expect(h.count).toBe(10_000);
		expect(h.percentile(0.5) / 1_000).toBeGreaterThan(4_800);
		expect(h.percentile(0.5) / 1_000).toBeLessThan(5_200);
		expect(h.percentile(0.99) / 1_000).toBeGreaterThan(9_600);
		expect(h.percentile(0.99) / 1_000).toBeLessThan(10_300);
		expect(h.summary().maxNs).toBe(10_000_000);
	});

	test("negative samples are counted, never bucketed", () => {
		const h = new LatencyHistogram();
		h.record(-5);
		h.record(100);
		expect(h.negative).toBe(1);
		expect(h.count).toBe(1);
		expect(h.summary().p50Ns).toBeGreaterThan(90);
	});

	test("json round-trip preserves the summary", () => {
		const h = new LatencyHistogram();
		for (let i = 0; i < 5_000; i += 1) h.record(i * 137 + 11);
		h.record(-1);
		const revived = LatencyHistogram.fromJson(h.toJson());
		expect(revived.summary()).toEqual(h.summary());
	});
});

describe("latency stamp", () => {
	test("round-trips values above 2^32", () => {
		const bytes = new Uint8Array(64);
		const stamp = {
			intendedNs: 1_234_567_890_123,
			actualNs: 1_234_567_899_999,
			sequence: 8_589_934_593,
		};
		encodeStamp(bytes, stamp);
		expect(decodeStamp(bytes)).toEqual(stamp);
	});

	test("rejects short, unmagic and wrong-version payloads", () => {
		expect(decodeStamp(new Uint8Array(STAMP_BYTES - 1))).toBeNull();

		const bytes = new Uint8Array(STAMP_BYTES);
		encodeStamp(bytes, { intendedNs: 1, actualNs: 2, sequence: 3 });
		expect(decodeStamp(bytes)).not.toBeNull();

		const wrongMagic = bytes.slice();
		new DataView(wrongMagic.buffer).setUint16(0, STAMP_MAGIC ^ 0xffff, true);
		expect(decodeStamp(wrongMagic)).toBeNull();

		const wrongVersion = bytes.slice();
		new DataView(wrongVersion.buffer).setUint16(2, 99, true);
		expect(decodeStamp(wrongVersion)).toBeNull();
	});

	test("decodes at a non-zero byteOffset", () => {
		const backing = new Uint8Array(STAMP_BYTES + 8);
		const window = backing.subarray(8);
		encodeStamp(window, { intendedNs: 7, actualNs: 9, sequence: 11 });
		expect(decodeStamp(window)?.actualNs).toBe(9);
	});
});

describe("monotonic clock", () => {
	test("advances, and agrees with itself across a sleep", async () => {
		const clock = await createMonotonicClock();
		const t0 = clock.now();
		await Bun.sleep(50);
		const t1 = clock.now();
		const elapsedMs = (t1 - t0) / 1e6;
		expect(elapsedMs).toBeGreaterThan(40);
		expect(elapsedMs).toBeLessThan(500);
		expect(clock.calibrationResidualNs).toBeLessThan(50_000);
	});

	test("the forced-FFI path reports no calibration residual", async () => {
		const clock = await createMonotonicClock(false);
		expect(clock.source).toBe("ffi");
		expect(clock.calibrationResidualNs).toBe(0);
		expect(clock.now()).toBeGreaterThan(0);
	});
});
