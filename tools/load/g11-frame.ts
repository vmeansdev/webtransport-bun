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

/**
 * A wall clock with nanosecond resolution, anchored precisely.
 *
 * `Date.now()` has millisecond resolution, and a millisecond of constant bias
 * against a 25 ms bound is not acceptable, so the anchor is taken **at a
 * millisecond tick edge**: spin until `Date.now()` changes, then pair that
 * instant with the high-resolution monotonic reading. After that every stamp is
 * `anchor + (hrtime - hrAnchor)`, which carries the monotonic clock's
 * resolution and the tick edge's accuracy.
 *
 * The spin costs under one millisecond, once, at process start.
 */
export function createWallClock(): () => bigint {
	const start = Date.now();
	let now = start;
	// Spin to the next millisecond edge. Bounded by construction: Date.now()
	// advances within a millisecond on every platform this runs on.
	while (now === start) now = Date.now();
	const anchorNs = BigInt(now) * 1_000_000n;
	const hrAnchor = process.hrtime.bigint();
	return () => anchorNs + (process.hrtime.bigint() - hrAnchor);
}

/** Nanoseconds to milliseconds, as a float, for the latency histograms. */
export function nsToMs(ns: bigint): number {
	return Number(ns) / 1e6;
}
