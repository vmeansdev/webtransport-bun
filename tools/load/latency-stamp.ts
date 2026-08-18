/**
 * The latency stamp the load client writes into every datagram payload, and the
 * one field the server writes back into it on the echo.
 *
 * Layout (little-endian), fixed by `docs/research/preregistrations/latency.md`
 * (version 1) and its Amendment 6 (version 2):
 *
 * | offset | size | field                                    |
 * |--------|------|------------------------------------------|
 * | 0      | 2    | magic 0x4C54 ("LT")                      |
 * | 2      | 2    | version                                  |
 * | 4      | 8    | intended send, CLOCK_MONOTONIC ns        |
 * | 12     | 8    | actual send, CLOCK_MONOTONIC ns          |
 * | 20     | 8    | per-session sequence                     |
 * | 28     | 8    | echo actual send, ns — version 2 only    |
 *
 * `intended` is the tick or interval deadline the client meant to hit; `actual`
 * is when the send call actually happened. Their difference is the generator's
 * own queueing, which is how the co-residence tax gets separated from the
 * server's tail instead of silently added to it.
 *
 * `echoActual` is written by the *server*, in place, immediately before it echoes
 * the datagram back. It is what lets the client split its round trip into three
 * intervals that sum to it exactly — the registered ingest-vs-egress cross-check
 * in `docs/research/preregistrations/latency-ab.md`. It is zero on the upstream
 * leg and absent from a version-1 stamp, which decodes as zero so an older
 * fragment or an older `load-client` binary still reads.
 *
 * The two timestamps are read as u32 pairs rather than BigInt: monotonic
 * nanoseconds stay exactly representable as doubles for 104 days of uptime, and
 * the decode runs once per datagram on the server's hot path.
 */

export const STAMP_MAGIC = 0x4c54;
export const STAMP_VERSION = 2;
/** Bytes a version-2 stamp needs — what a writer must reserve. */
export const STAMP_BYTES = 36;
/** Bytes a version-1 stamp needs. Still decoded; never written. */
export const STAMP_BYTES_V1 = 28;

export const OFFSET_MAGIC = 0;
export const OFFSET_VERSION = 2;
export const OFFSET_INTENDED = 4;
export const OFFSET_ACTUAL = 12;
export const OFFSET_SEQUENCE = 20;
export const OFFSET_ECHO_ACTUAL = 28;

export type LatencyStamp = {
	intendedNs: number;
	actualNs: number;
	sequence: number;
	/** Server's echo send instant; 0 upstream and 0 for a version-1 stamp. */
	echoActualNs: number;
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

function viewOf(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Decode a stamp, or `null` if the datagram is not one of ours (a probe frame,
 * a truncated payload, a version we don't speak). Callers count the nulls rather
 * than dropping them silently — an unstamped fraction that is not ~0 means the
 * generator and the server disagree about the payload contract.
 */
export function decodeStamp(bytes: Uint8Array): LatencyStamp | null {
	if (bytes.byteLength < STAMP_BYTES_V1) return null;
	const view = viewOf(bytes);
	if (view.getUint16(OFFSET_MAGIC, true) !== STAMP_MAGIC) return null;
	const version = view.getUint16(OFFSET_VERSION, true);
	if (version !== 1 && version !== 2) return null;
	if (version === 2 && bytes.byteLength < STAMP_BYTES) return null;
	return {
		intendedNs: readU64(view, OFFSET_INTENDED),
		actualNs: readU64(view, OFFSET_ACTUAL),
		sequence: readU64(view, OFFSET_SEQUENCE),
		echoActualNs: version === 2 ? readU64(view, OFFSET_ECHO_ACTUAL) : 0,
	};
}

/** Write a stamp in place. Used by tests and by any JS-side generator. */
export function encodeStamp(bytes: Uint8Array, stamp: LatencyStamp): void {
	if (bytes.byteLength < STAMP_BYTES) {
		throw new Error(
			`latency-stamp: need at least ${STAMP_BYTES} bytes, got ${bytes.byteLength}`,
		);
	}
	const view = viewOf(bytes);
	view.setUint16(OFFSET_MAGIC, STAMP_MAGIC, true);
	view.setUint16(OFFSET_VERSION, STAMP_VERSION, true);
	writeU64(view, OFFSET_INTENDED, stamp.intendedNs);
	writeU64(view, OFFSET_ACTUAL, stamp.actualNs);
	writeU64(view, OFFSET_SEQUENCE, stamp.sequence);
	writeU64(view, OFFSET_ECHO_ACTUAL, stamp.echoActualNs);
}

/**
 * Stamp the server's echo send instant into a datagram it is about to send back,
 * without rewriting the fields the client owns. Returns false when the payload
 * cannot carry the field — a version-1 stamp, or a short frame — so the caller
 * counts it instead of silently producing an egress sample measured from zero.
 *
 * Called once per echoed datagram on the server's hot path, so it does the
 * minimum: two `setUint32`s over a view of a buffer it does not copy.
 */
export function writeEchoActual(
	bytes: Uint8Array,
	echoActualNs: number,
): boolean {
	if (bytes.byteLength < STAMP_BYTES) return false;
	const view = viewOf(bytes);
	if (view.getUint16(OFFSET_MAGIC, true) !== STAMP_MAGIC) return false;
	if (view.getUint16(OFFSET_VERSION, true) !== STAMP_VERSION) return false;
	writeU64(view, OFFSET_ECHO_ACTUAL, echoActualNs);
	return true;
}
