/**
 * The 28-byte latency stamp the load client writes into every datagram payload.
 *
 * Layout (little-endian), fixed by `docs/research/preregistrations/latency.md`:
 *
 * | offset | size | field                                    |
 * |--------|------|------------------------------------------|
 * | 0      | 2    | magic 0x4C54 ("LT")                      |
 * | 2      | 2    | version = 1                              |
 * | 4      | 8    | intended send, CLOCK_MONOTONIC ns        |
 * | 12     | 8    | actual send, CLOCK_MONOTONIC ns          |
 * | 20     | 8    | per-session sequence                     |
 *
 * `intended` is the tick or interval deadline the client meant to hit; `actual`
 * is when the send call actually happened. Their difference is the generator's
 * own queueing, which is how the co-residence tax gets separated from the
 * server's tail instead of silently added to it.
 *
 * The two timestamps are read as u32 pairs rather than BigInt: monotonic
 * nanoseconds stay exactly representable as doubles for 104 days of uptime, and
 * the decode runs once per datagram on the server's hot path.
 */

export const STAMP_MAGIC = 0x4c54;
export const STAMP_VERSION = 1;
export const STAMP_BYTES = 28;

export const OFFSET_MAGIC = 0;
export const OFFSET_VERSION = 2;
export const OFFSET_INTENDED = 4;
export const OFFSET_ACTUAL = 12;
export const OFFSET_SEQUENCE = 20;

export type LatencyStamp = {
	intendedNs: number;
	actualNs: number;
	sequence: number;
};

function readU64(view: DataView, offset: number): number {
	return (
		view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 4294967296
	);
}

function writeU64(view: DataView, offset: number, value: number): void {
	const low = value % 4294967296;
	view.setUint32(offset, low, true);
	view.setUint32(offset + 4, (value - low) / 4294967296, true);
}

/**
 * Decode a stamp, or `null` if the datagram is not one of ours (a probe frame,
 * a truncated payload, a future version). Callers count the nulls rather than
 * dropping them silently — an unstamped fraction that is not ~0 means the
 * generator and the server disagree about the payload contract.
 */
export function decodeStamp(bytes: Uint8Array): LatencyStamp | null {
	if (bytes.byteLength < STAMP_BYTES) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(OFFSET_MAGIC, true) !== STAMP_MAGIC) return null;
	if (view.getUint16(OFFSET_VERSION, true) !== STAMP_VERSION) return null;
	return {
		intendedNs: readU64(view, OFFSET_INTENDED),
		actualNs: readU64(view, OFFSET_ACTUAL),
		sequence: readU64(view, OFFSET_SEQUENCE),
	};
}

/** Write a stamp in place. Used by tests and by any JS-side generator. */
export function encodeStamp(bytes: Uint8Array, stamp: LatencyStamp): void {
	if (bytes.byteLength < STAMP_BYTES) {
		throw new Error(
			`latency-stamp: need at least ${STAMP_BYTES} bytes, got ${bytes.byteLength}`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint16(OFFSET_MAGIC, STAMP_MAGIC, true);
	view.setUint16(OFFSET_VERSION, STAMP_VERSION, true);
	writeU64(view, OFFSET_INTENDED, stamp.intendedNs);
	writeU64(view, OFFSET_ACTUAL, stamp.actualNs);
	writeU64(view, OFFSET_SEQUENCE, stamp.sequence);
}
