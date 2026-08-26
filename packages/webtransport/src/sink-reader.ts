/**
 * Worker-side consumer for a native stream sink ring (RFC_STREAM_SINK §3).
 *
 * Zero native imports: instantiate this inside your Worker with the
 * SharedArrayBuffer and descriptor the main thread posted. The blocking
 * `next()` loop is the latency-critical mode — it parks the worker thread on
 * `Atomics.wait` with a sub-millisecond timeout (the producer is a native
 * thread and cannot wake a JS futex, so the timeout IS the doorbell). The
 * async iterator is the loop-sharing alternative built on `Atomics.waitAsync`.
 *
 * Zero-copy contract: `payload` is a subarray view into the shared buffer,
 * valid only until the NEXT `next()` call (which reclaims the previous
 * record's bytes for the producer). Pass `copy: true` for safe copies.
 */

import {
	FLAG_PRODUCER_NOTIFIES,
	I32_HEAD,
	I32_HEARTBEAT,
	I32_TAIL,
	OFF_CAPACITY,
	OFF_MAGIC,
	OFF_VERSION,
	REC_DATA,
	REC_DROPGAP,
	REC_EOF,
	REC_ERROR,
	REC_MESSAGE,
	REC_RESET,
	REC_WRAP,
	SINK_DATA_OFFSET,
	SINK_LAYOUT_VERSION,
	SINK_MAGIC,
	SINK_RECORD_HEADER_BYTES,
	type StreamSinkDescriptor,
} from "./sink-layout.js";

export type SinkRecordType =
	| "data"
	| "message"
	| "eof"
	| "error"
	| "reset"
	| "drops";

export interface SinkRecord {
	type: SinkRecordType;
	/** Arrival stamp in the descriptor's clock domain. */
	timestampNs: bigint;
	/** Cumulative wire offset of this record's first payload byte. */
	streamOffset: bigint;
	/** View into the shared buffer (or a copy with `copy: true`). */
	payload: Uint8Array;
	/** 'error': the code string; 'reset': the peer's application code. */
	code?: string | number;
	/** 'drops': records lost to drop-newest overflow at this offset. */
	count?: number;
}

export interface SinkReaderOptions {
	/**
	 * Upper bound on one blocking park in `next()`, in milliseconds. Bounds
	 * wake latency when the ring goes from empty to non-empty (default 0.5).
	 */
	wakeTimeoutMs?: number;
	/** Copy payloads out of the shared buffer instead of handing out views. */
	copy?: boolean;
}

const RECORD_TYPE_NAMES: Record<number, SinkRecordType> = {
	[REC_DATA]: "data",
	[REC_MESSAGE]: "message",
	[REC_EOF]: "eof",
	[REC_ERROR]: "error",
	[REC_RESET]: "reset",
	[REC_DROPGAP]: "drops",
};

const TEXT_DECODER = new TextDecoder();

export class SinkReader {
	readonly #i32: Int32Array;
	readonly #dv: DataView;
	readonly #u8: Uint8Array;
	readonly #mask: number;
	readonly #wakeTimeoutMs: number;
	readonly #copy: boolean;
	readonly #producerNotifies: boolean;
	/** Free-running consumer byte cursor (mod 2^32). */
	#head = 0;
	/** Bytes of the record currently on loan to the caller. */
	#pendingAdvance = 0;
	#state: "active" | "ended" = "active";

	constructor(
		descriptor: StreamSinkDescriptor,
		sab: SharedArrayBuffer,
		opts?: SinkReaderOptions,
	) {
		this.#i32 = new Int32Array(sab);
		this.#dv = new DataView(sab);
		this.#u8 = new Uint8Array(sab);
		const magic = this.#dv.getUint32(OFF_MAGIC, true);
		const version = this.#dv.getUint32(OFF_VERSION, true);
		const capacity = this.#dv.getUint32(OFF_CAPACITY, true);
		if (magic !== SINK_MAGIC || version !== SINK_LAYOUT_VERSION) {
			throw new Error(
				`E_SINK_BAD_BUFFER: not a v${SINK_LAYOUT_VERSION} sink ring`,
			);
		}
		if (capacity !== descriptor.dataCapacity) {
			throw new Error(
				"E_SINK_BAD_BUFFER: descriptor capacity does not match the ring",
			);
		}
		this.#mask = capacity - 1;
		this.#wakeTimeoutMs = opts?.wakeTimeoutMs ?? 0.5;
		this.#copy = opts?.copy ?? false;
		this.#producerNotifies = (descriptor.flags & FLAG_PRODUCER_NOTIFIES) !== 0;
	}

	get state(): "active" | "ended" {
		return this.#state;
	}

	/** Reclaim the previously returned record's bytes for the producer. */
	#advancePending(): void {
		if (this.#pendingAdvance === 0) return;
		this.#head = (this.#head + this.#pendingAdvance) >>> 0;
		this.#pendingAdvance = 0;
		Atomics.store(this.#i32, I32_HEAD, this.#head | 0);
	}

	/** Parse the record at the head, if the producer published one. */
	#tryNext(): SinkRecord | null {
		for (;;) {
			const tail = Atomics.load(this.#i32, I32_TAIL) >>> 0;
			if (this.#head === tail) return null;
			const pos = this.#head & this.#mask;
			const base = SINK_DATA_OFFSET + pos;
			const recLen = this.#dv.getUint32(base, true);
			const kind = this.#u8[base + 4] ?? 0;
			if (kind === REC_WRAP) {
				// No payload on loan: reclaim immediately.
				this.#head = (this.#head + recLen) >>> 0;
				Atomics.store(this.#i32, I32_HEAD, this.#head | 0);
				continue;
			}
			const payloadLen = this.#dv.getUint32(base + 24, true);
			const aux = this.#dv.getUint32(base + 28, true);
			const raw = this.#u8.subarray(
				base + SINK_RECORD_HEADER_BYTES,
				base + SINK_RECORD_HEADER_BYTES + payloadLen,
			);
			const record: SinkRecord = {
				type: RECORD_TYPE_NAMES[kind] ?? "error",
				timestampNs: this.#dv.getBigUint64(base + 8, true),
				streamOffset: this.#dv.getBigUint64(base + 16, true),
				payload: this.#copy ? raw.slice() : raw,
			};
			if (kind === REC_ERROR) record.code = TEXT_DECODER.decode(raw);
			if (kind === REC_RESET) record.code = aux;
			if (kind === REC_DROPGAP) record.count = aux;
			this.#pendingAdvance = recLen;
			if (kind === REC_EOF || kind === REC_ERROR || kind === REC_RESET) {
				this.#state = "ended";
			}
			return record;
		}
	}

	/**
	 * Blocking read of the next record. Returns null when `deadlineMs`
	 * expires first, and forever after the terminal record was returned.
	 * Must not be called on a thread that disallows `Atomics.wait`.
	 */
	next(deadlineMs?: number): SinkRecord | null {
		this.#advancePending();
		if (this.#state === "ended") return null;
		const deadline =
			deadlineMs === undefined ? Infinity : performance.now() + deadlineMs;
		for (;;) {
			// Liveness heartbeat on every iteration — consuming or merely
			// polling, a live reader never looks dead to the stall detector.
			Atomics.add(this.#i32, I32_HEARTBEAT, 1);
			const record = this.#tryNext();
			if (record) return record;
			const now = performance.now();
			if (now >= deadline) return null;
			const park = this.#producerNotifies
				? Math.min(1000, deadline - now)
				: Math.min(this.#wakeTimeoutMs, deadline - now);
			Atomics.wait(this.#i32, I32_TAIL, this.#head | 0, park);
		}
	}

	/**
	 * Loop-sharing consumption via `Atomics.waitAsync`. Latency is bounded
	 * by the worker's own event-loop responsiveness on top of the doorbell.
	 */
	async *[Symbol.asyncIterator](): AsyncIterableIterator<SinkRecord> {
		for (;;) {
			this.#advancePending();
			if (this.#state === "ended") return;
			Atomics.add(this.#i32, I32_HEARTBEAT, 1);
			const record = this.#tryNext();
			if (record) {
				yield record;
				continue;
			}
			const park = this.#producerNotifies ? 1000 : this.#wakeTimeoutMs;
			const waited = Atomics.waitAsync(
				this.#i32,
				I32_TAIL,
				this.#head | 0,
				park,
			);
			if (waited.async) await waited.value;
		}
	}
}
