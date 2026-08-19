/**
 * G11's on-stream frame: the tunnel's inner packet, and the only thing either
 * end of the gate ever writes.
 *
 * A tunnel over a reliable stream has to frame its inner packets itself, so the
 * gate's write unit is one length-prefixed frame — which is also one N-API
 * crossing (ledger K13), which is why the pre-registration counts frames rather
 * than bytes when it sizes the rungs.
 *
 * Layout, little-endian:
 *
 * ```
 *  0 u16  total length, prefix included
 *  2 u8   version (1)
 *  3 u8   class (see FrameClass)
 *  4 u32  session index
 *  8 u32  sequence within the session and direction
 * 12 u64  send stamp, wall-clock nanoseconds
 * 20 ..   filler to the total length
 * ```
 *
 * The stamp is a **wall-clock** nanosecond count on both ends, not a monotonic
 * one, because the two ends are separate processes: a monotonic clock is only
 * comparable inside one process. Both processes run on the same host (§1.2), so
 * they read the same CLOCK_REALTIME, and the V-N falsifier treats any negative
 * sample as an instrument fault rather than as a number.
 */

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

export const FRAME_HEADER_BYTES = 20;
export const FRAME_VERSION = 1;

export enum FrameClass {
	TunnelUp = 0,
	TunnelDown = 1,
	Request = 2,
	Response = 3,
}

export type Frame = {
	totalLength: number;
	version: number;
	frameClass: FrameClass;
	session: number;
	sequence: number;
	sendWallNs: bigint;
};

export function encodeFrame(
	into: Uint8Array,
	frame: Omit<Frame, "version">,
): void {
	if (frame.totalLength < FRAME_HEADER_BYTES) {
		throw new Error(
			`g11: frame length ${frame.totalLength} is below the ${FRAME_HEADER_BYTES}-byte header`,
		);
	}
	if (into.byteLength < frame.totalLength) {
		throw new Error(
			`g11: buffer of ${into.byteLength} B cannot hold a ${frame.totalLength} B frame`,
		);
	}
	const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
	view.setUint16(0, frame.totalLength, true);
	view.setUint8(2, FRAME_VERSION);
	view.setUint8(3, frame.frameClass);
	view.setUint32(4, frame.session, true);
	view.setUint32(8, frame.sequence, true);
	view.setBigUint64(12, frame.sendWallNs, true);
}

export function decodeFrame(bytes: Uint8Array): Frame {
	if (bytes.byteLength < FRAME_HEADER_BYTES) {
		throw new Error(
			`g11: ${bytes.byteLength} B is shorter than a frame header`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		totalLength: view.getUint16(0, true),
		version: view.getUint8(2),
		frameClass: view.getUint8(3) as FrameClass,
		session: view.getUint32(4, true),
		sequence: view.getUint32(8, true),
		sendWallNs: view.getBigUint64(12, true),
	};
}

/**
 * Reassembles frames from the arbitrary chunks a stream delivers.
 *
 * A chunk can carry a partial frame, several frames, or both — with the
 * chunk-batching knob on it routinely carries several — so the receive side
 * cannot assume chunk boundaries are frame boundaries. Every frame in one chunk
 * shares that chunk's arrival instant, which is honest: they did arrive
 * together.
 */
export class Deframer {
	#buffer: Uint8Array = new Uint8Array(0);

	/** Bytes currently held back waiting for the rest of their frame. */
	get pendingBytes(): number {
		return this.#buffer.byteLength;
	}

	push(chunk: Uint8Array): Frame[] {
		const combined =
			this.#buffer.byteLength === 0 ? chunk : concat(this.#buffer, chunk);
		const frames: Frame[] = [];
		let offset = 0;
		for (;;) {
			if (combined.byteLength - offset < 2) break;
			const view = new DataView(
				combined.buffer,
				combined.byteOffset + offset,
				combined.byteLength - offset,
			);
			const length = view.getUint16(0, true);
			if (length < FRAME_HEADER_BYTES) {
				throw new Error(`g11: frame claims ${length} B, below the header size`);
			}
			if (combined.byteLength - offset < length) break;
			frames.push(decodeFrame(combined.subarray(offset, offset + length)));
			offset += length;
		}
		this.#buffer =
			offset === combined.byteLength
				? new Uint8Array(0)
				: combined.slice(offset);
		return frames;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}

/** Linux and macOS both number `CLOCK_REALTIME` zero. */
const CLOCK_REALTIME = 0;

const LIBC_CANDIDATES =
	process.platform === "darwin"
		? ["libSystem.B.dylib", `libSystem.${suffix}`]
		: ["libc.so.6", "libc.so", `libc.${suffix}.6`];

export type WallClockSource = "ffi-clock-realtime" | "anchored-date-now";

/**
 * `CLOCK_REALTIME`, read the way the Rust generator reads it.
 *
 * Both ends of this gate stamp the same clock from different processes, so the
 * question is not resolution but *epoch*: `clock_gettime(CLOCK_REALTIME)` is
 * one system-wide clock, and a Rust `SystemTime::now()` read and a Bun FFI read
 * of it share an epoch by construction — no calibration constant, no anchor to
 * go stale. This follows `latency-clock.ts`'s precedent on the G7 branch, which
 * solved the same two-process problem with the same mechanism on a different
 * clock id.
 *
 * The FFI call costs ~100 ns per stamp, against a 3.739 ms per-stream frame
 * cadence. That is the right trade here: the alternative was measured and is
 * below.
 */
function makeRealtimeReader(): () => bigint {
	let lastError: unknown;
	for (const candidate of LIBC_CANDIDATES) {
		try {
			const lib = dlopen(candidate, {
				clock_gettime: {
					args: [FFIType.i32, FFIType.ptr],
					returns: FFIType.i32,
				},
			});
			const clockGettime = lib.symbols.clock_gettime as (
				a: number,
				b: number,
			) => number;
			// A `struct timespec` is two 64-bit words on every platform this runs
			// on; reading four little-endian u32s keeps the seconds field exact
			// past 2^53, which a double would not.
			const buf = new ArrayBuffer(16);
			const words = new Uint32Array(buf);
			const bufPtr = ptr(buf);
			const read = () => {
				if (clockGettime(CLOCK_REALTIME, bufPtr) !== 0)
					throw new Error("g11: clock_gettime(CLOCK_REALTIME) failed");
				const sec = (words[0] ?? 0) + (words[1] ?? 0) * 4294967296;
				const nsec = (words[2] ?? 0) + (words[3] ?? 0) * 4294967296;
				return BigInt(sec) * 1_000_000_000n + BigInt(nsec);
			};
			read(); // Fail here, at construction, rather than mid-drive.
			return read;
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(
		`g11: could not dlopen libc for clock_gettime (${String(lastError)})`,
	);
}

/**
 * The fallback: `Date.now()` anchored at a millisecond tick edge and advanced
 * by the monotonic clock.
 *
 * This was the original instrument and it is **not good enough on its own**,
 * which the harness build measured rather than assumed. Against the Rust
 * generator it produced ~2% negative one-way samples on a loopback wiring check
 * (62 of 3,210), while the same server against a JS peer produced zero — the
 * signature of two processes reading two epochs, not of a transport delivering
 * frames before they were sent. V-N is registered to invalidate exactly that,
 * so it would have invalidated the gate for an instrument fault.
 *
 * It stays as a fallback because a run on a host where `dlopen` fails is better
 * served by a biased clock plus V-N than by no cell at all — and the artifact
 * records which source ran.
 */
function makeAnchoredReader(): () => bigint {
	const start = Date.now();
	let now = start;
	while (now === start) now = Date.now();
	const hrAnchor = process.hrtime.bigint();
	const anchorNs = BigInt(now) * 1_000_000n;
	return () => anchorNs + (process.hrtime.bigint() - hrAnchor);
}

export function createWallClockWithSource(): {
	now: () => bigint;
	source: WallClockSource;
} {
	try {
		return { now: makeRealtimeReader(), source: "ffi-clock-realtime" };
	} catch (err) {
		console.error(
			`g11: falling back to the anchored Date.now() clock — cross-process ` +
				`stamps may go negative and V-N will say so (${String(err)})`,
		);
		return { now: makeAnchoredReader(), source: "anchored-date-now" };
	}
}

/** The clock, when the caller does not need to record which source it got. */
export function createWallClock(): () => bigint {
	return createWallClockWithSource().now;
}

/** Nanoseconds to milliseconds, as a float, for the latency histograms. */
export function nsToMs(ns: bigint): number {
	return Number(ns) / 1e6;
}
