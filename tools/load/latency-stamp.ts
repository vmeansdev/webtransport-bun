/**
 * The latency stamp the load client writes into every datagram payload, and the
 * one field the server writes back into it on the echo.
 *
 * Layout (little-endian), fixed by `docs/research/preregistrations/latency.md`
 * (version 1), its Amendment 6 (version 2), and
 * `docs/research/preregistrations/gate-g6-mmo.md` §6.1 (version 3):
 *
 * | offset | size | field                                    |
 * |--------|------|------------------------------------------|
 * | 0      | 2    | magic 0x4C54 ("LT")                      |
 * | 2      | 2    | version                                  |
 * | 4      | 8    | intended send, CLOCK_MONOTONIC ns        |
 * | 12     | 8    | actual send, CLOCK_MONOTONIC ns          |
 * | 20     | 8    | per-session sequence                     |
 * | 28     | 8    | echo actual send, ns — version 2 and up  |
 * | 36     | 8    | server dwell `holdNs` — version 3 only   |
 * | 44     | 1    | datagram class — version 3 and up        |
 * | 45     | 1    | emitter arm — version 4 only             |
 * | 46     | 2    | reserved, zero                           |
 *
 * Version 4 exists because G10 interleaves three emitter arms on one link and
 * has to attribute every broadcast copy to the arm that sent it. The arm byte
 * comes out of version 3's reserved field, so a version-4 stamp is still 48
 * bytes and G10's 200 B payload arithmetic does not move. A version-3 reader
 * sees a reserved byte it already ignores; a version-4 reader handed a
 * version-3 stamp reads `ARM_NONE`. Attributing arms by wall-clock block
 * boundary instead would make the interleave's own edges a source of
 * misattribution, which is precisely what K5 cost G3b.
 *
 * Version 3 exists because G6 measures a *round trip* through a server that also
 * holds the datagram deliberately. `holdNs` is a duration, measured entirely on
 * the server (receive instant → send instant), so unlike an instant it crosses
 * hosts safely; `class` tells the two ends apart on a link that carries four
 * different kinds of datagram at once.
 *
 * Clock discipline, because the legs are not symmetric: upstream, `actual` is the
 * client's clock. Downstream, `actual` is the *server's* clock and must never be
 * differenced against a client instant — the only client-clock quantity on a
 * downstream datagram is `echoActual`, the client's own earlier `actual`
 * reflected back.
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
/** Bytes a version-3 stamp needs (G6). */
export const STAMP_BYTES_V3 = 48;
/** Bytes a version-4 stamp needs (G10) — the same 48; the arm byte was reserved. */
export const STAMP_BYTES_V4 = 48;

export const OFFSET_MAGIC = 0;
export const OFFSET_VERSION = 2;
export const OFFSET_INTENDED = 4;
export const OFFSET_ACTUAL = 12;
export const OFFSET_SEQUENCE = 20;
export const OFFSET_ECHO_ACTUAL = 28;
export const OFFSET_HOLD = 36;
export const OFFSET_CLASS = 44;
export const OFFSET_ARM = 45;

/**
 * Datagram classes, registered in gate-g6-mmo.md §6.1. Zero is `MOVE` so a
 * version-1 or version-2 stamp — which has no class byte — decodes as the
 * unremarkable case rather than as something a G6 rule keys off.
 */
export const CLASS_MOVE = 0;
export const CLASS_ACTION = 1;
export const CLASS_ACK = 2;
export const CLASS_SNAPSHOT = 3;
export const CLASS_RAID = 4;
/**
 * A raid subscriber's one-datagram hello. The server has no path or authority to
 * key a role off, so a receive-only session has to say what it is once; the
 * hello is not load and is excluded from every rate.
 */
export const CLASS_RAID_JOIN = 5;
/** G10 §6.1: one copy of a broadcast. `sequence` is the broadcast's number. */
export const CLASS_BROADCAST = 6;
/** G10: a probe-cohort subscriber's own upstream datagram. */
export const CLASS_PROBE = 7;
/** G10: the server's echo of a probe datagram. */
export const CLASS_PROBE_ECHO = 8;

/**
 * Arm identities for the version-4 arm byte. Zero is "no arm", so a version-3
 * stamp — whose byte 45 is reserved and zero — decodes as unattributed rather
 * than as A1.
 */
export const ARM_NONE = 0;
export const ARM_A1 = 1;
export const ARM_A2 = 2;
export const ARM_A3 = 3;

export type LatencyStamp = {
	intendedNs: number;
	actualNs: number;
	sequence: number;
	/** Server's echo send instant; 0 upstream and 0 for a version-1 stamp. */
	echoActualNs: number;
	/** Server dwell (receive → send), a duration. 0 below version 3. */
	holdNs: number;
	/** Datagram class. `CLASS_MOVE` (0) below version 3. */
	klass: number;
	/** Emitter arm. `ARM_NONE` (0) below version 4. */
	arm: number;
	/** Stamp version this payload actually carried. */
	version: number;
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
	if (version < 1 || version > 4) return null;
	if (version >= 2 && bytes.byteLength < STAMP_BYTES) return null;
	if (version >= 3 && bytes.byteLength < STAMP_BYTES_V3) return null;
	return {
		version,
		intendedNs: readU64(view, OFFSET_INTENDED),
		actualNs: readU64(view, OFFSET_ACTUAL),
		sequence: readU64(view, OFFSET_SEQUENCE),
		echoActualNs: version >= 2 ? readU64(view, OFFSET_ECHO_ACTUAL) : 0,
		holdNs: version >= 3 ? readU64(view, OFFSET_HOLD) : 0,
		klass: version >= 3 ? view.getUint8(OFFSET_CLASS) : CLASS_MOVE,
		arm: version >= 4 ? view.getUint8(OFFSET_ARM) : ARM_NONE,
	};
}

export type StampInput = {
	intendedNs: number;
	actualNs: number;
	sequence: number;
	echoActualNs?: number;
	holdNs?: number;
	klass?: number;
	/** Emitter arm; version 4 only. Ignored below it. */
	arm?: number;
	/** 2 (default), 3 or 4. Versions 3 and 4 need `STAMP_BYTES_V3` of room. */
	version?: number;
};

/** Write a stamp in place. Used by tests and by any JS-side generator. */
export function encodeStamp(bytes: Uint8Array, stamp: StampInput): void {
	const version = stamp.version ?? STAMP_VERSION;
	const need = version >= 3 ? STAMP_BYTES_V3 : STAMP_BYTES;
	if (bytes.byteLength < need) {
		throw new Error(
			`latency-stamp: need at least ${need} bytes for version ${version}, got ${bytes.byteLength}`,
		);
	}
	const view = viewOf(bytes);
	view.setUint16(OFFSET_MAGIC, STAMP_MAGIC, true);
	view.setUint16(OFFSET_VERSION, version, true);
	writeU64(view, OFFSET_INTENDED, stamp.intendedNs);
	writeU64(view, OFFSET_ACTUAL, stamp.actualNs);
	writeU64(view, OFFSET_SEQUENCE, stamp.sequence);
	writeU64(view, OFFSET_ECHO_ACTUAL, stamp.echoActualNs ?? 0);
	if (version < 3) return;
	writeU64(view, OFFSET_HOLD, stamp.holdNs ?? 0);
	view.setUint8(OFFSET_CLASS, stamp.klass ?? CLASS_MOVE);
	view.setUint8(OFFSET_ARM, version >= 4 ? (stamp.arm ?? ARM_NONE) : 0);
	view.setUint8(OFFSET_ARM + 1, 0);
	view.setUint8(OFFSET_ARM + 2, 0);
}

/**
 * Turn a version-3 datagram the server received into the one it sends back,
 * in place and without copying: keep the client's `actual` where it is, move it
 * into `echoActual` where the client reads it, and write the server's own send
 * instant, dwell and class over the rest.
 *
 * Returns false when the payload cannot carry a version-3 stamp, so the caller
 * counts it rather than emitting a round trip measured from zero.
 */
export function writeReflection(
	bytes: Uint8Array,
	fields: {
		echoActualNs: number;
		serverSendNs: number;
		holdNs: number;
		klass: number;
		sequence: number;
		/** Version 4 only; omit to keep the reflection a version-3 stamp. */
		arm?: number;
	},
): boolean {
	if (bytes.byteLength < STAMP_BYTES_V3) return false;
	const view = viewOf(bytes);
	if (view.getUint16(OFFSET_MAGIC, true) !== STAMP_MAGIC) return false;
	const version = fields.arm === undefined ? 3 : 4;
	view.setUint16(OFFSET_VERSION, version, true);
	writeU64(view, OFFSET_INTENDED, 0);
	writeU64(view, OFFSET_ACTUAL, fields.serverSendNs);
	writeU64(view, OFFSET_SEQUENCE, fields.sequence);
	writeU64(view, OFFSET_ECHO_ACTUAL, fields.echoActualNs);
	writeU64(view, OFFSET_HOLD, fields.holdNs);
	view.setUint8(OFFSET_CLASS, fields.klass);
	if (version === 4) view.setUint8(OFFSET_ARM, fields.arm ?? ARM_NONE);
	return true;
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
