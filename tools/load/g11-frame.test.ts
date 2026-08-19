/**
 * The frame codec and the deframer, exercised against the arrival shapes the
 * gate will actually see — including the one the chunk-batching knob creates,
 * where several frames arrive inside one crossing.
 */

import { describe, expect, test } from "bun:test";
import {
	createWallClock,
	Deframer,
	decodeFrame,
	encodeFrame,
	FRAME_HEADER_BYTES,
	FRAME_VERSION,
	FrameClass,
	nsToMs,
} from "./g11-frame.ts";
import { FRAME_BYTES } from "./g11-plan.ts";

function makeFrame(
	sequence: number,
	sendWallNs: bigint,
	totalLength = FRAME_BYTES,
	frameClass = FrameClass.TunnelUp,
	session = 7,
): Uint8Array {
	const bytes = new Uint8Array(totalLength);
	encodeFrame(bytes, {
		totalLength,
		frameClass,
		session,
		sequence,
		sendWallNs,
	});
	return bytes;
}

describe("codec", () => {
	test("a frame round-trips every header field", () => {
		const stamp = 1_755_000_000_123_456_789n;
		const decoded = decodeFrame(makeFrame(42, stamp));
		expect(decoded).toEqual({
			totalLength: FRAME_BYTES,
			version: FRAME_VERSION,
			frameClass: FrameClass.TunnelUp,
			session: 7,
			sequence: 42,
			sendWallNs: stamp,
		});
	});

	test("the stamp survives the full u64 range without precision loss", () => {
		// A wall-clock nanosecond count near 2026 needs 61 bits; a double would
		// have quietly rounded it, which is why the field is a BigInt.
		const stamp = 1_755_123_456_789_012_345n;
		expect(decodeFrame(makeFrame(1, stamp)).sendWallNs).toBe(stamp);
	});

	test("an exchange frame is smaller and still legal", () => {
		const decoded = decodeFrame(makeFrame(3, 1n, 120, FrameClass.Request, 900));
		expect(decoded.totalLength).toBe(120);
		expect(decoded.frameClass).toBe(FrameClass.Request);
		expect(decoded.session).toBe(900);
	});

	test("a frame shorter than its header is refused, not truncated", () => {
		expect(() =>
			encodeFrame(new Uint8Array(64), {
				totalLength: FRAME_HEADER_BYTES - 1,
				frameClass: FrameClass.TunnelUp,
				session: 0,
				sequence: 0,
				sendWallNs: 0n,
			}),
		).toThrow();
		expect(() => decodeFrame(new Uint8Array(8))).toThrow();
	});

	test("a buffer too small for the frame is refused", () => {
		expect(() =>
			encodeFrame(new Uint8Array(100), {
				totalLength: FRAME_BYTES,
				frameClass: FrameClass.TunnelUp,
				session: 0,
				sequence: 0,
				sendWallNs: 0n,
			}),
		).toThrow();
	});
});

describe("deframer — the arrival shapes the gate will see", () => {
	test("one chunk, one frame", () => {
		const d = new Deframer();
		expect(d.push(makeFrame(1, 10n))).toHaveLength(1);
		expect(d.pendingBytes).toBe(0);
	});

	test("one chunk carrying several frames — the knob-on shape", () => {
		const d = new Deframer();
		const batch = new Uint8Array(FRAME_BYTES * 4);
		for (let i = 0; i < 4; i++) {
			batch.set(makeFrame(i, BigInt(i)), i * FRAME_BYTES);
		}
		const frames = d.push(batch);
		expect(frames.map((f) => f.sequence)).toEqual([0, 1, 2, 3]);
		expect(d.pendingBytes).toBe(0);
	});

	test("a frame split across chunks is held, not lost", () => {
		const d = new Deframer();
		const frame = makeFrame(9, 99n);
		expect(d.push(frame.subarray(0, 100))).toEqual([]);
		expect(d.pendingBytes).toBe(100);
		const frames = d.push(frame.subarray(100));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.sequence).toBe(9);
		expect(d.pendingBytes).toBe(0);
	});

	test("a chunk that ends inside the length prefix itself", () => {
		const d = new Deframer();
		const frame = makeFrame(5, 5n);
		expect(d.push(frame.subarray(0, 1))).toEqual([]);
		expect(d.push(frame.subarray(1))).toHaveLength(1);
	});

	test("byte-at-a-time delivery reassembles exactly one frame", () => {
		const d = new Deframer();
		const frame = makeFrame(11, 11n);
		let emitted = 0;
		for (const byte of frame) {
			emitted += d.push(Uint8Array.of(byte)).length;
		}
		expect(emitted).toBe(1);
	});

	test("a trailing partial frame stays pending across many pushes", () => {
		const d = new Deframer();
		const two = new Uint8Array(FRAME_BYTES * 2);
		two.set(makeFrame(1, 1n), 0);
		two.set(makeFrame(2, 2n), FRAME_BYTES);
		const frames = d.push(two.subarray(0, FRAME_BYTES + 7));
		expect(frames).toHaveLength(1);
		expect(d.pendingBytes).toBe(7);
	});

	test("a corrupt length below the header size is refused, never skipped", () => {
		const d = new Deframer();
		const bogus = new Uint8Array(64);
		new DataView(bogus.buffer).setUint16(0, 3, true);
		expect(() => d.push(bogus)).toThrow();
	});
});

describe("wall clock", () => {
	test("it advances monotonically and reads close to Date.now()", () => {
		const now = createWallClock();
		const a = now();
		const b = now();
		expect(b).toBeGreaterThanOrEqual(a);
		// Within 50 ms of the system clock: the anchor is a tick edge, so the
		// only error is the drift between CLOCK_REALTIME and the monotonic
		// clock over the life of this test.
		const drift = Math.abs(nsToMs(a) - Date.now());
		expect(drift).toBeLessThan(50);
	});

	test("nanoseconds convert to milliseconds as a float", () => {
		expect(nsToMs(1_500_000n)).toBeCloseTo(1.5, 6);
	});
});
