import { describe, expect, test } from "bun:test";
import { ByteBoundedQueue, DEFAULT_MAX_QUEUE_ITEMS } from "./bounded-queue.ts";
import { ManualClock, OpenLoopPacer, PacerDeadlineError } from "./pacer.ts";
import { percentile, sampleSummary, studentTCritical95 } from "./stats.ts";
import {
	DEFAULT_MAX_WIRE_PAYLOAD_BYTES,
	decodeWireMessage,
	encodeWireMessage,
	isWireMessageExpired,
	MAX_WIRE_PAYLOAD_BYTES,
	MAX_WIRE_TOTAL_BYTES,
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

	test("requires own wire fields and snapshots message and codec getters once", () => {
		const reads = new Map<string, number>();
		const read = (name: string, value: unknown) => {
			reads.set(name, (reads.get(name) ?? 0) + 1);
			return value;
		};
		const snapshotMessage = {} as Record<string, unknown>;
		Object.defineProperties(snapshotMessage, {
			runId: { enumerable: true, get: () => read("runId", message.runId) },
			sessionId: {
				enumerable: true,
				get: () => read("sessionId", message.sessionId),
			},
			sequence: {
				enumerable: true,
				get: () => read("sequence", message.sequence),
			},
			expiresAtMs: {
				enumerable: true,
				get: () => read("expiresAtMs", message.expiresAtMs),
			},
			payload: {
				enumerable: true,
				get: () => read("payload", message.payload),
			},
		});

		const encoded = encodeWireMessage(
			snapshotMessage as unknown as typeof message,
		);
		expect(decodeWireMessage(encoded)).toEqual(message);
		for (const name of [
			"runId",
			"sessionId",
			"sequence",
			"expiresAtMs",
			"payload",
		]) {
			expect(reads.get(name)).toBe(1);
		}

		const inherited = Object.create(message) as typeof message;
		expect(() => encodeWireMessage(inherited)).toThrow(/own/i);

		let nowReads = 0;
		const options = {
			rejectExpired: true,
			get nowMs() {
				nowReads += 1;
				return message.expiresAtMs;
			},
		};
		expect(() => decodeWireMessage(encoded, options)).toThrow(/expired/i);
		expect(nowReads).toBe(1);
	});

	test("snapshots payload and input bytes through intrinsic view accessors", () => {
		const payload = new Uint8Array([7, 8, 9]);
		Object.defineProperties(payload, {
			buffer: { configurable: true, value: new ArrayBuffer(1) },
			byteOffset: { configurable: true, value: 0 },
			byteLength: { configurable: true, value: 1 },
		});
		const encoded = encodeWireMessage({ ...message, payload });
		expect(decodeWireMessage(encoded).payload).toEqual(
			new Uint8Array([7, 8, 9]),
		);

		const input = new Uint8Array(encoded);
		Object.defineProperties(input, {
			buffer: { configurable: true, value: new ArrayBuffer(1) },
			byteOffset: { configurable: true, value: 0 },
			byteLength: { configurable: true, value: 1 },
		});
		expect(decodeWireMessage(input)).toEqual({
			...message,
			payload: new Uint8Array([7, 8, 9]),
		});
	});

	test("requires own finite nowMs when rejecting expired envelopes", () => {
		const encoded = encodeWireMessage(message);
		expect(() => decodeWireMessage(encoded, { rejectExpired: true })).toThrow(
			/nowMs/i,
		);
		expect(() =>
			decodeWireMessage(encoded, { nowMs: Number.NaN, rejectExpired: true }),
		).toThrow(/nowMs/i);
		const inherited = Object.create({ nowMs: 1_000 }) as {
			rejectExpired: true;
		};
		inherited.rejectExpired = true;
		expect(() => decodeWireMessage(encoded, inherited)).toThrow(/own/i);
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

	test("rejects unpaired UTF-16 surrogates and round-trips valid pairs", () => {
		const unicodeMessage = {
			...message,
			runId: "run-🚀",
			sessionId: "session-🧪",
		};
		expect(decodeWireMessage(encodeWireMessage(unicodeMessage))).toEqual(
			unicodeMessage,
		);
		expect(() =>
			encodeWireMessage({ ...message, runId: "bad-\ud800" }),
		).toThrow(/surrogate/i);
		expect(() =>
			encodeWireMessage({ ...message, sessionId: "bad-\udfff" }),
		).toThrow(/surrogate/i);
	});

	test("enforces uint32 payload and compatible total wire limits", () => {
		expect(MAX_WIRE_PAYLOAD_BYTES).toBe(0xffff_ffff);
		expect(MAX_WIRE_TOTAL_BYTES).toBeGreaterThan(MAX_WIRE_PAYLOAD_BYTES);
		expect(() =>
			encodeWireMessage(message, {
				maxPayloadBytes: MAX_WIRE_PAYLOAD_BYTES + 1,
			}),
		).toThrow(/uint32/i);
		expect(() =>
			decodeWireMessage(encodeWireMessage(message), {
				maxPayloadBytes: MAX_WIRE_PAYLOAD_BYTES + 1,
			}),
		).toThrow(/uint32/i);
		expect(() =>
			encodeWireMessage(message, { maxWireBytes: MAX_WIRE_TOTAL_BYTES + 1 }),
		).toThrow(/wire|maximum|uint/i);
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

	test("bounds item metadata separately from bytes and rejects zero-byte entries", () => {
		expect(Number.isSafeInteger(DEFAULT_MAX_QUEUE_ITEMS)).toBe(true);
		expect(DEFAULT_MAX_QUEUE_ITEMS).toBeGreaterThan(0);
		const queue = new ByteBoundedQueue<Uint8Array>({
			maxBytes: 100,
			maxItems: 2,
		});
		expect(queue.tryPush(new Uint8Array([1]))).toBe(true);
		expect(queue.tryPush(new Uint8Array([2]))).toBe(true);
		expect(queue.tryPush(new Uint8Array([3]))).toBe(false);
		expect(() => queue.tryPush(new Uint8Array(0))).toThrow(/zero|positive/i);
		expect(
			() => new ByteBoundedQueue<Uint8Array>({ maxBytes: 10, maxItems: 0 }),
		).toThrow(/maxItems/i);
	});

	test("rejects resizable ArrayBuffer backing and untrusted byteLength objects", () => {
		const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
		const queue = new ByteBoundedQueue<unknown>({ maxBytes: 32 });
		expect(() => queue.tryPush(resizable)).toThrow(/resizable/i);
		expect(() => queue.tryPush(new Uint8Array(resizable))).toThrow(
			/resizable/i,
		);
		expect(() => queue.tryPush({ byteLength: 1 })).toThrow(/sizeOf/i);
	});

	test("uses intrinsic binary sizes and validates fixed backing before custom sizing", () => {
		const fixed = new ArrayBuffer(8);
		Object.defineProperty(fixed, "byteLength", {
			configurable: true,
			value: 1,
		});
		const fixedQueue = new ByteBoundedQueue<ArrayBuffer>({ maxBytes: 8 });
		expect(fixedQueue.tryPush(fixed)).toBe(true);
		expect(fixedQueue.bytes).toBe(8);

		const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
		Object.defineProperties(resizable, {
			resizable: { configurable: true, value: false },
			maxByteLength: { configurable: true, value: 8 },
		});
		const customQueue = new ByteBoundedQueue<ArrayBuffer>({
			maxBytes: 8,
			sizeOf: () => 1,
		});
		expect(() => customQueue.tryPush(resizable)).toThrow(/resizable/i);
	});

	test("rejects malformed queue wait arguments before consuming waiter capacity", () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 8,
			maxWaiters: 1,
			sizeOf: () => 1,
		});
		expect(() => queue.waitForItem({ aborted: false } as never)).toThrow(
			/signal|AbortSignal/i,
		);
		expect(() =>
			queue.waitForItem({ signal: { aborted: false } } as never),
		).toThrow(/signal|AbortSignal/i);
		expect(queue.pendingWaiters).toBe(0);
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

	test("aborted item waits are removed and waiter capacity is reusable", async () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 16,
			maxItems: 4,
			sizeOf: () => 1,
			maxWaiters: 1,
		});
		const controller = new AbortController();
		const pending = queue.waitForItem({ signal: controller.signal });
		expect(queue.pendingItemWaiters).toBe(1);
		controller.abort("cancelled");
		await pending.catch((reason) => expect(reason).toBe("cancelled"));
		expect(queue.pendingItemWaiters).toBe(0);
		const reusable = queue.waitForItem();
		expect(queue.pendingItemWaiters).toBe(1);
		queue.close("done");
		expect(await reusable).toEqual({ done: true, reason: "done" });
		expect(queue.pendingItemWaiters).toBe(0);
	});

	test("aborted watermark waits are removed and do not consume the total cap", async () => {
		const queue = new ByteBoundedQueue<Uint8Array>({
			maxBytes: 10,
			highWaterMark: 5,
			lowWaterMark: 1,
			maxWaiters: 1,
		});
		queue.tryPush(new Uint8Array([1, 2, 3, 4, 5]));
		const controller = new AbortController();
		const pending = queue.waitForLowWaterMark({ signal: controller.signal });
		expect(queue.pendingWatermarkWaiters).toBe(1);
		controller.abort("cancelled");
		await pending.catch((reason) => expect(reason).toBe("cancelled"));
		expect(queue.pendingWatermarkWaiters).toBe(0);
		const reusable = queue.waitForLowWaterMark();
		queue.shift();
		expect(await reusable).toBe("low");
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

	test("validates catch-up policy at runtime and bounds a hung sleeper by deadline", async () => {
		for (const catchUp of ["repay", null, 0] as unknown[]) {
			expect(
				() =>
					new OpenLoopPacer({
						ratePerSecond: 10,
						catchUp: catchUp as never,
					}),
			).toThrow(/catchUp/i);
		}

		let receivedSignal: AbortSignal | undefined;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1,
			now: () => 0,
			sleep: ((_: number, signal?: AbortSignal) => {
				receivedSignal = signal;
				return new Promise<void>(() => {});
			}) as (milliseconds: number) => Promise<void>,
		});
		pacer.nextSlot();
		await expect(pacer.waitNext(10)).rejects.toBeInstanceOf(PacerDeadlineError);
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(receivedSignal?.aborted).toBe(true);
	});

	test("freezes skip as the safe default open-loop policy", () => {
		const pacer = new OpenLoopPacer({ ratePerSecond: 10, now: () => 0 });
		expect(pacer.catchUp).toBe("skip");
	});

	test("rejects nonrepresentable rates, epochs, derived slots, and clock overflow", () => {
		expect(
			() => new OpenLoopPacer({ ratePerSecond: Number.MIN_VALUE }),
		).toThrow(/interval|rate/i);
		expect(() => new OpenLoopPacer({ ratePerSecond: 1e20 })).toThrow(
			/interval|rate/i,
		);
		expect(() =>
			new OpenLoopPacer({
				ratePerSecond: 1,
				now: () => Number.MAX_VALUE,
			}).nextSlot(),
		).toThrow(/epoch|safe|representable/i);
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1,
			now: () => Number.MAX_SAFE_INTEGER - 1_000,
			catchUp: "none",
		});
		pacer.nextSlot();
		expect(() => pacer.nextSlot()).toThrow(/slot|safe|representable/i);
		const clock = new ManualClock(Number.MAX_SAFE_INTEGER - 1);
		expect(() => clock.advance(2)).toThrow(/overflow|safe/i);
	});

	test("rejects intervals that collapse at the selected epoch", () => {
		const epochMs = 1_000_000_000;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1e12,
			now: () => epochMs,
			catchUp: "none",
		});
		expect(() => pacer.start()).toThrow(/monotonic|precision|representable/i);

		const resettable = new OpenLoopPacer({
			ratePerSecond: 1e12,
			now: () => 0,
			catchUp: "none",
		});
		resettable.nextSlot();
		expect(() => resettable.reset(epochMs)).toThrow(
			/monotonic|precision|representable/i,
		);
	});

	test("rejects sequence slots that collapse after a large offset", () => {
		const pacer = new OpenLoopPacer({
			ratePerSecond: 100_000,
			now: () => 0,
			catchUp: "none",
		});
		expect(() => pacer.dueAt(Number.MAX_SAFE_INTEGER - 1)).toThrow(
			/increasing|monotonic|precision|representable/i,
		);
	});

	test("rejects an unsafe manual-clock duration before adding it", () => {
		const clock = new ManualClock(-1);
		expect(() => clock.advance(Number.MAX_SAFE_INTEGER + 1)).toThrow(
			/duration|safe|representable/i,
		);
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
		expect(() => percentile(new Array(2), 50)).toThrow(/finite|number/i);

		const source = [1, 3];
		let firstRead = true;
		const mutating = new Proxy(source, {
			get(target, property, receiver) {
				if (property === "0") {
					const value = firstRead ? 1 : 100;
					firstRead = false;
					return value;
				}
				return Reflect.get(target, property, receiver);
			},
		}) as unknown as readonly number[];
		expect(percentile(mutating, 50)).toBe(2);
	});

	test("requires an own finite expiry timestamp", () => {
		const inherited = Object.create({
			expiresAtMs: message.expiresAtMs,
		}) as typeof message;
		expect(() => isWireMessageExpired(inherited, 2_000)).toThrow(
			/own|expires/i,
		);
		expect(() =>
			isWireMessageExpired({ ...message, expiresAtMs: Number.NaN }, 0),
		).toThrow(/expires/i);
		expect(() =>
			isWireMessageExpired(
				{ ...message, expiresAtMs: Number.POSITIVE_INFINITY },
				0,
			),
		).toThrow(/expires/i);
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
		expect(studentTCritical95(1e15)).toBeCloseTo(1.959964, 5);
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
