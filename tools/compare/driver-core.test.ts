import { describe, expect, test } from "bun:test";
import { ByteBoundedQueue } from "./bounded-queue.ts";
import { OpenLoopPacer } from "./pacer.ts";
import { percentile, sampleSummary, studentTCritical95 } from "./stats.ts";
import {
	DEFAULT_MAX_WIRE_PAYLOAD_BYTES,
	decodeWireMessage,
	encodeWireMessage,
	isWireMessageExpired,
	WIRE_MAGIC,
	WIRE_VERSION,
	WireFormatError,
} from "./wire.ts";

const message = {
	runId: "run-20260822-a",
	sessionId: "session-17",
	sequence: 42,
	expiresAtMs: 2_000,
	payload: new Uint8Array([0, 1, 2, 253, 254, 255]),
};

describe("shared comparison driver core", () => {
	test("round-trips the binary envelope and preserves identity and payload bytes", () => {
		const encoded = encodeWireMessage(message);
		const decoded = decodeWireMessage(encoded);

		expect(decoded).toEqual(message);
		expect(encoded).toBeInstanceOf(Uint8Array);
		expect(encoded.byteLength).toBeGreaterThan(message.payload.byteLength);
	});

	test("decodes only the selected byte-view range", () => {
		const encoded = encodeWireMessage(message);
		const wrapped = new Uint8Array(encoded.byteLength + 4);
		wrapped.fill(0xa5);
		wrapped.set(encoded, 2);

		expect(
			decodeWireMessage(new DataView(wrapped.buffer, 2, encoded.byteLength)),
		).toEqual(message);
	});

	test("marks an envelope expired at its deadline without mutating the message", () => {
		expect(isWireMessageExpired(message, 1_999)).toBe(false);
		expect(isWireMessageExpired(message, 2_000)).toBe(true);
		expect(() =>
			decodeWireMessage(encodeWireMessage(message), {
				nowMs: 2_000,
				rejectExpired: true,
			}),
		).toThrow(WireFormatError);
		expect(decodeWireMessage(encodeWireMessage(message))).toEqual(message);
	});

	test("rejects truncated input before reading the fixed header", () => {
		expect(() => decodeWireMessage(new Uint8Array([0x57]))).toThrow(
			WireFormatError,
		);
	});

	test.each([
		[
			"wrong magic",
			(view: DataView) => view.setUint16(0, WIRE_MAGIC ^ 1, false),
		],
		[
			"unsupported version",
			(view: DataView) => view.setUint8(2, WIRE_VERSION + 1),
		],
	] as const)("rejects a full-length fixture with %s", (_label, mutate) => {
		const encoded = encodeWireMessage(message);
		mutate(
			new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength),
		);
		let thrown: unknown;
		try {
			decodeWireMessage(encoded);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WireFormatError);
		expect((thrown as WireFormatError).code).toBe("malformed");
	});

	test.each([
		["runId", 6],
		["sessionId", 8],
	] as const)("rejects a zero %s length symmetrically with the encoder", (_label, offset) => {
		const encoded = encodeWireMessage(message);
		const view = new DataView(
			encoded.buffer,
			encoded.byteOffset,
			encoded.byteLength,
		);
		view.setUint16(offset, 0, false);
		let thrown: unknown;
		try {
			decodeWireMessage(encoded);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WireFormatError);
		expect((thrown as WireFormatError).message).toContain(`${_label} length`);
	});

	test("rejects payloads over the configured and default caps", () => {
		const oversizedPayload = new Uint8Array(9);
		expect(() =>
			encodeWireMessage(
				{ ...message, payload: oversizedPayload },
				{
					maxPayloadBytes: 8,
				},
			),
		).toThrow(/payload/i);
		expect(DEFAULT_MAX_WIRE_PAYLOAD_BYTES).toBeGreaterThan(0);
	});

	test("rejects malformed UTF-8 and trailing bytes", () => {
		const encoded = encodeWireMessage(message);
		const withTrailing = new Uint8Array(encoded.byteLength + 1);
		withTrailing.set(encoded);
		withTrailing[withTrailing.length - 1] = 0xff;
		expect(() => decodeWireMessage(withTrailing)).toThrow(WireFormatError);

		const malformedId = encodeWireMessage({ ...message, runId: "run" });
		const idOffset = 38;
		malformedId[idOffset] = 0xff;
		expect(() => decodeWireMessage(malformedId)).toThrow(WireFormatError);
	});

	test("enforces byte capacity and exposes high/low watermark transitions", () => {
		const queue = new ByteBoundedQueue<Uint8Array>({
			maxBytes: 10,
			highWaterMark: 8,
			lowWaterMark: 3,
		});

		expect(queue.tryPush(new Uint8Array(5))).toBe(true);
		expect(queue.bytes).toBe(5);
		expect(queue.aboveHighWaterMark).toBe(false);
		expect(queue.tryPush(new Uint8Array(3))).toBe(true);
		expect(queue.aboveHighWaterMark).toBe(true);
		expect(queue.tryPush(new Uint8Array(3))).toBe(false);
		expect(queue.bytes).toBe(8);
		expect(queue.shift()?.byteLength).toBe(5);
		expect(queue.belowLowWaterMark).toBe(true);
	});

	test("closes deterministically, drains existing items, and rejects later pushes", async () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 16,
			sizeOf: () => 4,
		});
		const pending = queue.waitForItem();
		queue.close("finished");
		expect(await pending).toEqual({ done: true, reason: "finished" });
		expect(queue.tryPush(1)).toBe(false);
		expect(queue.shift()).toBeUndefined();
		expect(queue.closed).toBe(true);
		expect(queue.closeReason).toBe("finished");

		const drainable = new ByteBoundedQueue<number>({
			maxBytes: 16,
			sizeOf: () => 4,
		});
		drainable.tryPush(7);
		drainable.close();
		expect(drainable.shift()).toBe(7);
		expect(drainable.shift()).toBeUndefined();
	});

	test("pacing is open-loop from one epoch and does not drift or catch up implicitly", () => {
		let nowMs = 1_000;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 10,
			now: () => nowMs,
			catchUp: "none",
		});

		expect(pacer.nextSlot()).toMatchObject({
			sequence: 0,
			scheduledAtMs: 1_000,
			latenessMs: 0,
			skippedSlots: 0,
		});
		nowMs = 1_250;
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 1,
			scheduledAtMs: 1_100,
			latenessMs: 150,
			skippedSlots: 0,
		});
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 2,
			scheduledAtMs: 1_200,
			latenessMs: 50,
			skippedSlots: 0,
		});
	});

	test("skip mode records missed slots and never emits a catch-up burst", () => {
		let nowMs = 1_000;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 10,
			now: () => nowMs,
		});
		expect(pacer.catchUp).toBe("skip");
		pacer.nextSlot();
		nowMs = 1_250;
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 2,
			skippedSlots: 1,
			latenessMs: 50,
		});
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 3,
			skippedSlots: 0,
			delayMs: 50,
		});
	});

	test("freezes skip as the safe default open-loop policy", () => {
		const pacer = new OpenLoopPacer({ ratePerSecond: 10, now: () => 0 });
		expect(pacer.catchUp).toBe("skip");
	});

	test("reset starts a new warmup epoch and sequence", () => {
		let nowMs = 10;
		const pacer = new OpenLoopPacer({ ratePerSecond: 2, now: () => nowMs });
		pacer.nextSlot();
		nowMs = 2_000;
		pacer.reset();
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 0,
			scheduledAtMs: 2_000,
			latenessMs: 0,
		});
	});

	test("orders percentiles without mutating input and rejects non-finite samples", () => {
		const values = [9, 1, 4, 2, 8, 3, 7, 5, 6];
		expect(percentile(values, 50)).toBe(5);
		expect(percentile(values, 95)).toBeGreaterThanOrEqual(
			percentile(values, 50),
		);
		expect(percentile(values, 99)).toBeGreaterThanOrEqual(
			percentile(values, 95),
		);
		expect(values).toEqual([9, 1, 4, 2, 8, 3, 7, 5, 6]);
		expect(() => percentile([], 50)).toThrow(/empty/i);
		expect(() => percentile([1, Number.NaN], 50)).toThrow(/finite/i);
	});

	test("summarizes finite samples with a Student-t 95% confidence interval", () => {
		const summary = sampleSummary([1, 2, 3, 4, 5]);
		expect(summary.count).toBe(5);
		expect(summary.mean).toBe(3);
		expect(summary.stddev).toBeCloseTo(Math.sqrt(2.5));
		expect(summary.ci95Low).toBeLessThan(3);
		expect(summary.ci95High).toBeGreaterThan(3);
		expect(summary.ci95Low).toBeLessThanOrEqual(1.04);
		expect(summary.ci95High).toBeGreaterThanOrEqual(4.96);
		expect(studentTCritical95(5)).toBeCloseTo(2.776, 3);
		expect(() => sampleSummary([])).toThrow(/empty/i);
		expect(() => sampleSummary([1, Number.POSITIVE_INFINITY])).toThrow(
			/finite/i,
		);
	});

	test("fails closed for invalid Student-t sample counts", () => {
		for (const sampleCount of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-1,
			0,
			1,
			1.5,
		]) {
			expect(() => studentTCritical95(sampleCount)).toThrow(/sample count/i);
		}
		expect(sampleSummary([7]).ci95Low).toBe(7);
	});

	test("keeps extreme finite summaries finite or rejects unrepresentable results", () => {
		const repeatedMaximum = sampleSummary([Number.MAX_VALUE, Number.MAX_VALUE]);
		for (const value of [
			repeatedMaximum.mean,
			repeatedMaximum.stddev,
			repeatedMaximum.ci95Low,
			repeatedMaximum.ci95High,
			repeatedMaximum.p50,
			repeatedMaximum.p95,
			repeatedMaximum.p99,
		]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(() => sampleSummary([Number.MAX_VALUE, -Number.MAX_VALUE])).toThrow(
			/finite|overflow/i,
		);
	});
});
