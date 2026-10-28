/**
 * TS producer for the stream sink ring — the wasm backend's twin of the Rust
 * `SinkRing` writer (crates/native/src/stream_sink.rs, LAYOUT_VERSION 1).
 * Byte-compatible by construction and pinned by the shared golden vector.
 *
 * The wasm producer runs on the JS main thread, so unlike the native writer
 * it CAN wake a parked consumer: it stores TAIL with Atomics and notifies
 * (FLAG_PRODUCER_NOTIFIES), letting SinkReader use long waits with instant
 * wakes. Shape parity, not latency parity: a saturated main loop still
 * delays production (docs/OPERATIONS.md).
 */

import {
	FLAG_CLOCK_WALL,
	FLAG_DROP_NEWEST,
	FLAG_FRAMING,
	FLAG_PRODUCER_NOTIFIES,
	I32_TAIL,
	OFF_CAPACITY,
	OFF_DROPPED_BYTES,
	OFF_DROPPED_RECORDS,
	OFF_FLAGS,
	OFF_HEAD,
	OFF_HEARTBEAT,
	OFF_HIGH_WATER,
	OFF_MAGIC,
	OFF_STATE,
	OFF_TAIL,
	OFF_VERSION,
	REC_DROPGAP,
	REC_EOF,
	REC_ERROR,
	REC_RESET,
	REC_WRAP,
	SINK_DATA_OFFSET,
	SINK_LAYOUT_VERSION,
	SINK_MAGIC,
	SINK_RECORD_HEADER_BYTES,
	SINK_RESERVED_TAIL_BYTES,
	SINK_STATE_ACTIVE,
	SINK_STATE_EXITED,
	SINK_STATE_TERMINAL_COMMITTED,
	type StreamSinkFraming,
} from "./sink-layout.js";

export const MAX_TERMINAL_PAYLOAD_BYTES = 32;

export type RingPushOutcome = "written" | "wouldblock" | "dropped";

function align8(len: number): number {
	return (len + 7) & ~7;
}

/** Largest payload a ring of `dataCapacity` accepts (RFC §4 sizing rule). */
export function ringMaxPayloadBytes(dataCapacity: number): number {
	return dataCapacity / 4 - SINK_RECORD_HEADER_BYTES;
}

export class RingWriter {
	readonly #i32: Int32Array;
	readonly #u64: BigUint64Array;
	readonly #dv: DataView;
	readonly #u8: Uint8Array;
	readonly #capacity: number;
	readonly #mask: number;
	readonly #dropNewest: boolean;
	/** Free-running producer byte cursor (mod 2^32). */
	#tail = 0;
	#highWater = 0;
	#pendingGapRecords = 0;
	#pendingGapStartOffset = 0n;

	constructor(
		sab: SharedArrayBuffer,
		dataCapacity: number,
		flags: number,
		dropNewest: boolean,
	) {
		if (
			dataCapacity < 1024 ||
			dataCapacity > 1 << 30 ||
			(dataCapacity & (dataCapacity - 1)) !== 0
		) {
			throw new Error(
				"E_SINK_BAD_OPTIONS: ring capacity must be a power of two in [1024, 2^30]",
			);
		}
		if (sab.byteLength < SINK_DATA_OFFSET + dataCapacity) {
			throw new Error("E_SINK_BAD_BUFFER: buffer smaller than the layout");
		}
		this.#i32 = new Int32Array(sab);
		this.#u64 = new BigUint64Array(sab, 0, SINK_DATA_OFFSET / 8);
		this.#dv = new DataView(sab);
		this.#u8 = new Uint8Array(sab);
		this.#capacity = dataCapacity;
		this.#mask = dataCapacity - 1;
		this.#dropNewest = dropNewest;
		this.#u8.fill(0, 0, SINK_DATA_OFFSET);
		this.#dv.setUint32(OFF_MAGIC, SINK_MAGIC, true);
		this.#dv.setUint32(OFF_VERSION, SINK_LAYOUT_VERSION, true);
		this.#dv.setUint32(OFF_CAPACITY, dataCapacity, true);
		this.#dv.setUint32(OFF_FLAGS, flags, true);
		this.#dv.setUint32(16, SINK_DATA_OFFSET, true);
	}

	get capacity(): number {
		return this.#capacity;
	}

	#head(): number {
		return Atomics.load(this.#i32, OFF_HEAD / 4) >>> 0;
	}

	fill(): number {
		return (this.#tail - this.#head()) >>> 0;
	}

	consumerHeartbeat(): number {
		return Atomics.load(this.#i32, OFF_HEARTBEAT / 4) >>> 0;
	}

	state(): number {
		return Atomics.load(this.#i32, OFF_STATE / 4);
	}

	setExited(): void {
		Atomics.store(this.#i32, OFF_STATE / 4, SINK_STATE_EXITED);
	}

	/** Ring-space cost of `recLen` at `tail` (WRAP / pad-to-end geometry). */
	#costAt(tail: number, recLen: number): number {
		const remainder = this.#capacity - (tail & this.#mask);
		if (remainder >= recLen + SINK_RECORD_HEADER_BYTES) return recLen;
		if (remainder >= recLen) return remainder;
		return remainder + recLen;
	}

	#writeHeader(
		pos: number,
		recLen: number,
		kind: number,
		timestampNs: bigint,
		streamOffset: bigint,
		payloadLen: number,
		aux: number,
	): void {
		const base = SINK_DATA_OFFSET + pos;
		this.#dv.setUint32(base, recLen, true);
		this.#u8[base + 4] = kind;
		this.#u8[base + 5] = 0;
		this.#dv.setUint16(base + 6, 0, true);
		this.#dv.setBigUint64(base + 8, timestampNs, true);
		this.#dv.setBigUint64(base + 16, streamOffset, true);
		this.#dv.setUint32(base + 24, payloadLen, true);
		this.#dv.setUint32(base + 28, aux, true);
	}

	#commit(
		recLen: number,
		cost: number,
		kind: number,
		timestampNs: bigint,
		streamOffset: bigint,
		payload: Uint8Array,
		aux: number,
	): void {
		let pos = this.#tail & this.#mask;
		const remainder = this.#capacity - pos;
		let storedLen = recLen;
		if (remainder >= recLen + SINK_RECORD_HEADER_BYTES) {
			// Normal write.
		} else if (remainder >= recLen) {
			storedLen = remainder; // pad-to-end
		} else {
			this.#writeHeader(pos, remainder, REC_WRAP, 0n, 0n, 0, 0);
			pos = 0;
		}
		this.#writeHeader(
			pos,
			storedLen,
			kind,
			timestampNs,
			streamOffset,
			payload.length,
			aux,
		);
		if (payload.length > 0) {
			this.#u8.set(payload, SINK_DATA_OFFSET + pos + SINK_RECORD_HEADER_BYTES);
		}
		this.#tail = (this.#tail + cost) >>> 0;
		const fill = (this.#tail - this.#head()) >>> 0;
		if (fill > this.#highWater) {
			this.#highWater = fill;
			this.#dv.setUint32(OFF_HIGH_WATER, fill, true);
		}
		Atomics.store(this.#i32, I32_TAIL, this.#tail | 0);
		Atomics.notify(this.#i32, I32_TAIL);
	}

	/** Push one DATA or MESSAGE record. */
	push(
		kind: number,
		timestampNs: bigint,
		streamOffset: bigint,
		payload: Uint8Array,
	): RingPushOutcome {
		if (payload.length > ringMaxPayloadBytes(this.#capacity)) {
			throw new Error(
				`E_SINK_OVERSIZED: ${payload.length} byte payload exceeds the ${ringMaxPayloadBytes(this.#capacity)} byte cap for this ring`,
			);
		}
		const recLen = align8(SINK_RECORD_HEADER_BYTES + payload.length);
		const usable = this.#capacity - SINK_RESERVED_TAIL_BYTES;
		const gapCost =
			this.#pendingGapRecords > 0
				? this.#costAt(this.#tail, SINK_RECORD_HEADER_BYTES)
				: 0;
		const recordCost = this.#costAt((this.#tail + gapCost) >>> 0, recLen);
		if (this.fill() + gapCost + recordCost > usable) {
			if (!this.#dropNewest) return "wouldblock";
			if (this.#pendingGapRecords === 0) {
				this.#pendingGapStartOffset = streamOffset;
			}
			this.#pendingGapRecords += 1;
			Atomics.add(this.#u64, OFF_DROPPED_RECORDS / 8, 1n);
			Atomics.add(this.#u64, OFF_DROPPED_BYTES / 8, BigInt(payload.length));
			return "dropped";
		}
		this.#flushPendingGap();
		this.#commit(
			recLen,
			recordCost,
			kind,
			timestampNs,
			streamOffset,
			payload,
			0,
		);
		return "written";
	}

	/** Terminal record; exactly-once, may draw on the reserve. */
	pushTerminal(
		kind: number,
		timestampNs: bigint,
		streamOffset: bigint,
		payload: Uint8Array,
		aux: number,
	): boolean {
		if (kind !== REC_EOF && kind !== REC_ERROR && kind !== REC_RESET) {
			throw new Error("E_SINK_INTERNAL: not a terminal record type");
		}
		if (payload.length > MAX_TERMINAL_PAYLOAD_BYTES) {
			throw new Error("E_SINK_INTERNAL: terminal payload exceeds the cap");
		}
		const prior = Atomics.compareExchange(
			this.#i32,
			OFF_STATE / 4,
			SINK_STATE_ACTIVE,
			SINK_STATE_TERMINAL_COMMITTED,
		);
		if (prior !== SINK_STATE_ACTIVE) return false;
		const recLen = align8(SINK_RECORD_HEADER_BYTES + payload.length);
		if (this.#pendingGapRecords > 0) {
			const gapCost = this.#costAt(this.#tail, SINK_RECORD_HEADER_BYTES);
			const terminalAfter = this.#costAt((this.#tail + gapCost) >>> 0, recLen);
			if (this.fill() + gapCost + terminalAfter <= this.#capacity) {
				this.#flushPendingGap();
			}
		}
		const cost = this.#costAt(this.#tail, recLen);
		this.#commit(recLen, cost, kind, timestampNs, streamOffset, payload, aux);
		return true;
	}

	#flushPendingGap(): void {
		if (this.#pendingGapRecords === 0) return;
		const count = Math.min(this.#pendingGapRecords, 0xffff_ffff);
		const cost = this.#costAt(this.#tail, SINK_RECORD_HEADER_BYTES);
		this.#commit(
			SINK_RECORD_HEADER_BYTES,
			cost,
			REC_DROPGAP,
			0n,
			this.#pendingGapStartOffset,
			new Uint8Array(0),
			count,
		);
		this.#pendingGapRecords = 0;
	}
}

/** Flags for a wasm-producer ring with the given options. */
export function wasmRingFlags(
	framing: StreamSinkFraming | null,
	dropNewest: boolean,
	wallClock: boolean,
): number {
	let flags = FLAG_PRODUCER_NOTIFIES;
	if (framing) flags |= FLAG_FRAMING;
	if (dropNewest) flags |= FLAG_DROP_NEWEST;
	if (wallClock) flags |= FLAG_CLOCK_WALL;
	return flags;
}

/**
 * Incremental length-prefix deframer — the TS twin of the Rust `Deframer`.
 * Whole frames inside a chunk come back as subarray views of that chunk;
 * frames split across chunks are staged and copied.
 */
export class FrameCutter {
	readonly #framing: Required<
		Pick<
			StreamSinkFraming,
			"headerBytes" | "lengthOffset" | "lengthWidth" | "maxFrameBytes"
		>
	> & { littleEndian: boolean; lengthIncludesHeader: boolean };
	#staging: number[] = [];

	constructor(framing: StreamSinkFraming) {
		const { headerBytes, lengthOffset, lengthWidth, maxFrameBytes } = framing;
		if (headerBytes < 1 || headerBytes > 64) {
			throw new Error("E_SINK_BAD_OPTIONS: framing headerBytes must be 1..=64");
		}
		if (![1, 2, 4, 8].includes(lengthWidth)) {
			throw new Error(
				"E_SINK_BAD_OPTIONS: framing lengthWidth must be 1, 2, 4, or 8",
			);
		}
		if (lengthOffset + lengthWidth > headerBytes) {
			throw new Error(
				"E_SINK_BAD_OPTIONS: framing length field does not fit in the header",
			);
		}
		if (maxFrameBytes < headerBytes) {
			throw new Error(
				"E_SINK_BAD_OPTIONS: framing maxFrameBytes is smaller than the header",
			);
		}
		this.#framing = {
			headerBytes,
			lengthOffset,
			lengthWidth,
			maxFrameBytes,
			littleEndian: framing.endianness !== "be",
			lengthIncludesHeader: framing.lengthIncludesHeader !== false,
		};
	}

	get pendingBytes(): number {
		return this.#staging.length;
	}

	#frameLen(header: ArrayLike<number>): number {
		const f = this.#framing;
		let value = 0;
		if (f.littleEndian) {
			for (let i = f.lengthWidth - 1; i >= 0; i--) {
				value = value * 256 + (header[f.lengthOffset + i] ?? 0);
			}
		} else {
			for (let i = 0; i < f.lengthWidth; i++) {
				value = value * 256 + (header[f.lengthOffset + i] ?? 0);
			}
		}
		const total = f.lengthIncludesHeader ? value : f.headerBytes + value;
		if (f.lengthIncludesHeader && value < f.headerBytes) {
			throw new Error(
				`E_SINK_FRAME_FAULT: claimed length ${value} is shorter than the ${f.headerBytes} byte header`,
			);
		}
		if (total > f.maxFrameBytes) {
			throw new Error(
				`E_SINK_FRAME_FAULT: frame of ${total} bytes exceeds maxFrameBytes ${f.maxFrameBytes}`,
			);
		}
		return total;
	}

	/** Feed one chunk; returns the completed frames, header included. */
	push(chunk: Uint8Array): Uint8Array[] {
		const f = this.#framing;
		const out: Uint8Array[] = [];
		let cursor = 0;
		while (this.#staging.length > 0) {
			if (this.#staging.length < f.headerBytes) {
				const want = f.headerBytes - this.#staging.length;
				const take = Math.min(want, chunk.length - cursor);
				for (let i = 0; i < take; i++)
					this.#staging.push(chunk[cursor + i] ?? 0);
				cursor += take;
				if (this.#staging.length < f.headerBytes) return out;
				continue;
			}
			const total = this.#frameLen(this.#staging);
			const want = total - this.#staging.length;
			const take = Math.min(want, chunk.length - cursor);
			for (let i = 0; i < take; i++) this.#staging.push(chunk[cursor + i] ?? 0);
			cursor += take;
			if (this.#staging.length < total) return out;
			out.push(Uint8Array.from(this.#staging));
			this.#staging = [];
		}
		for (;;) {
			const rest = chunk.length - cursor;
			if (rest < f.headerBytes) break;
			const total = this.#frameLen(chunk.subarray(cursor));
			if (rest < total) break;
			out.push(chunk.subarray(cursor, cursor + total));
			cursor += total;
		}
		if (cursor < chunk.length) {
			for (let i = cursor; i < chunk.length; i++)
				this.#staging.push(chunk[i] ?? 0);
		}
		return out;
	}
}
