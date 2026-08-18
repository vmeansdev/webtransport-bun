import { describe, expect, test } from "bun:test";
import { createMonotonicClock } from "./latency-clock.ts";
import {
	__testing,
	LatencyHistogram,
	quantizationNs,
} from "./latency-histogram.ts";
import {
	decodeStamp,
	encodeStamp,
	STAMP_BYTES,
	STAMP_BYTES_V1,
	STAMP_MAGIC,
	writeEchoActual,
} from "./latency-stamp.ts";

describe("latency histogram", () => {
	test("buckets are monotonic and within 0.2% of the recorded value", () => {
		let previous = -1;
		for (const ns of [
			0, 1, 255, 256, 257, 511, 512, 1_000, 9_999, 100_000, 1_500_000,
			15_625_000, 20_000_000, 1_000_000_000, 60_000_000_000,
		]) {
			const index = __testing.bucketIndex(ns);
			expect(index).toBeGreaterThan(previous - 1);
			previous = index;
			const value = __testing.bucketValue(index);
			const error = Math.abs(value - ns) / Math.max(ns, 1);
			expect(error).toBeLessThan(0.002);
		}
	});

	test("resolution stays under the 0.2 ms A/B band at a tens-of-ms p99", () => {
		// Amendment 2: Δ is a difference of two quantized p99s, so the per-arm
		// error has to stay well under half the band.
		const p99Ns = 15 * 1e6;
		expect(quantizationNs(p99Ns) * 2).toBeLessThan(0.2 * 1e6 * 0.5);
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

	test("a fragment written mid-record reports its skew and keeps its percentiles", () => {
		const h = new LatencyHistogram();
		for (let i = 0; i < 1_000; i += 1) h.record(1_000_000);
		// What a torn snapshot from the Rust side looks like: the counter ran
		// ahead of the buckets that were serialized.
		const torn = { ...h.toJson(), recordedTotal: 1_007 };
		const revived = LatencyHistogram.fromJson(torn);
		expect(revived.summary().skew).toBe(7);
		expect(revived.summary().count).toBe(1_000);
		expect(revived.summary().p99Ns).toBe(h.summary().p99Ns);
	});

	test("json is sparse and carries the bucketing it was written with", () => {
		const h = new LatencyHistogram();
		h.record(1_000);
		h.record(1_000);
		h.record(2_000_000);
		const json = h.toJson();
		expect(json.buckets).toHaveLength(2);
		expect(json.buckets.map(([, c]) => c).reduce((a, b) => a + b, 0)).toBe(3);
		expect(json.count).toBe(3);
		expect(json.subBits).toBe(8);
		expect(() => LatencyHistogram.fromJson({ ...json, subBits: 5 })).toThrow(
			/bucketing mismatch/,
		);
		expect(() =>
			LatencyHistogram.fromJson({ ...json, buckets: [[999_999, 1]] }),
		).toThrow(/out of range/);
	});
});

describe("latency stamp", () => {
	test("round-trips values above 2^32", () => {
		const bytes = new Uint8Array(64);
		const stamp = {
			intendedNs: 1_234_567_890_123,
			actualNs: 1_234_567_899_999,
			sequence: 8_589_934_593,
			echoActualNs: 1_234_567_999_999,
		};
		encodeStamp(bytes, stamp);
		expect(decodeStamp(bytes)).toEqual(stamp);
	});

	test("rejects short, unmagic and wrong-version payloads", () => {
		expect(decodeStamp(new Uint8Array(STAMP_BYTES_V1 - 1))).toBeNull();

		const bytes = new Uint8Array(STAMP_BYTES);
		encodeStamp(bytes, {
			intendedNs: 1,
			actualNs: 2,
			sequence: 3,
			echoActualNs: 0,
		});
		expect(decodeStamp(bytes)).not.toBeNull();

		const wrongMagic = bytes.slice();
		new DataView(wrongMagic.buffer).setUint16(0, STAMP_MAGIC ^ 0xffff, true);
		expect(decodeStamp(wrongMagic)).toBeNull();

		const wrongVersion = bytes.slice();
		new DataView(wrongVersion.buffer).setUint16(2, 99, true);
		expect(decodeStamp(wrongVersion)).toBeNull();

		// A version-2 header on a frame too short to carry its last field is not
		// ours; reading it would report an echo instant of whatever follows.
		const truncated = bytes.slice(0, STAMP_BYTES - 1);
		expect(decodeStamp(truncated)).toBeNull();
	});

	test("decodes a version-1 stamp with no echo instant", () => {
		const bytes = new Uint8Array(STAMP_BYTES_V1);
		const view = new DataView(bytes.buffer);
		view.setUint16(0, STAMP_MAGIC, true);
		view.setUint16(2, 1, true);
		view.setUint32(12, 4242, true);
		expect(decodeStamp(bytes)).toEqual({
			intendedNs: 0,
			actualNs: 4242,
			sequence: 0,
			echoActualNs: 0,
		});
	});

	test("the server can stamp its echo instant without touching client fields", () => {
		const bytes = new Uint8Array(STAMP_BYTES);
		encodeStamp(bytes, {
			intendedNs: 5,
			actualNs: 6,
			sequence: 7,
			echoActualNs: 0,
		});
		expect(writeEchoActual(bytes, 1_234_567_890_123)).toBe(true);
		expect(decodeStamp(bytes)).toEqual({
			intendedNs: 5,
			actualNs: 6,
			sequence: 7,
			echoActualNs: 1_234_567_890_123,
		});
	});

	test("echo stamping refuses payloads that cannot carry the field", () => {
		expect(writeEchoActual(new Uint8Array(STAMP_BYTES - 1), 1)).toBe(false);

		const v1 = new Uint8Array(STAMP_BYTES);
		const view = new DataView(v1.buffer);
		view.setUint16(0, STAMP_MAGIC, true);
		view.setUint16(2, 1, true);
		expect(writeEchoActual(v1, 1)).toBe(false);

		expect(writeEchoActual(new Uint8Array(STAMP_BYTES), 1)).toBe(false);
	});

	test("decodes and stamps at a non-zero byteOffset", () => {
		const backing = new Uint8Array(STAMP_BYTES + 8);
		const window = backing.subarray(8);
		encodeStamp(window, {
			intendedNs: 7,
			actualNs: 9,
			sequence: 11,
			echoActualNs: 0,
		});
		expect(decodeStamp(window)?.actualNs).toBe(9);
		expect(writeEchoActual(window, 13)).toBe(true);
		expect(decodeStamp(window)?.echoActualNs).toBe(13);
		// The bytes before the window are untouched.
		expect(backing.subarray(0, 8).every((b) => b === 0)).toBe(true);
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
