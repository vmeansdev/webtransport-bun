/**
 * Main-thread side of the native stream sink (RFC_STREAM_SINK §3).
 *
 * `openReadSinkOnNativeHandle` allocates the SharedArrayBuffer ring, opens
 * the sink on a raw native stream handle, and returns the StreamSinkHandle
 * whose `buffer`/`descriptor` the application posts to its Worker (where a
 * SinkReader consumes it). Native latency isolation applies to the native
 * backend only; see docs/OPERATIONS.md "Sizing the JS read side".
 */

import {
	FLAG_CLOCK_WALL,
	OFF_DROPPED_BYTES,
	OFF_DROPPED_RECORDS,
	OFF_HIGH_WATER,
	SINK_DATA_OFFSET,
	TASK_STATE_NAMES,
	type SinkTaskStateName,
	type StreamSinkDescriptor,
	type StreamSinkFraming,
} from "./sink-layout.js";

export interface StreamSinkOptions {
	/** Ring data-region size in bytes; power of two. Default 4 MiB. */
	ringBytes?: number;
	/**
	 * 'block' (default): a full ring parks the native reader and QUIC flow
	 * control throttles the sender — lossless. 'drop-newest': the wire is
	 * never blocked; losses are counted and disclosed as 'drops' records.
	 */
	overflow?: "block" | "drop-newest";
	/** Cut per-message records out of a length-prefixed protocol. */
	framing?: StreamSinkFraming;
	/** Record timestamp domain. Default 'monotonic'. */
	clock?: "monotonic" | "wall";
	/** Block-mode stall deadline (consumer heartbeat frozen). Default 5000. */
	backpressureTimeoutMs?: number;
	/** Drop-newest liveness deadline. Default off. */
	idleTimeoutMs?: number;
}

export interface StreamSinkStats {
	bytesIn: number;
	records: number;
	droppedRecords: number;
	droppedBytes: number;
	ringHighWater: number;
	pendingPartialBytes: number;
	state: SinkTaskStateName;
}

export interface StreamSinkHandle {
	/** Post to the consuming Worker together with `descriptor` (shared). */
	readonly buffer: SharedArrayBuffer;
	readonly descriptor: StreamSinkDescriptor;
	stats(): StreamSinkStats;
	/**
	 * Stop the sink task, await its exit, and release the native buffer
	 * reference. Idempotent. The terminal record (E_SINK_CLOSED unless the
	 * stream already ended) is committed to the ring before this resolves.
	 */
	close(): Promise<void>;
}

/** The napi sink surface both recv handle classes expose. */
export interface SinkCapableNativeHandle {
	openReadSink(
		sab: Uint8Array,
		options: Record<string, unknown>,
	): Record<string, unknown> | string;
	sinkCloseBegin(): boolean;
	sinkWaitExit(timeoutMs: number): Promise<boolean>;
	sinkReleaseBuffer(): boolean;
	sinkStats():
		| {
				bytesIn: number;
				records: number;
				pendingPartialBytes: number;
				taskState: number;
				exited: boolean;
		  }
		| null
		| undefined;
}

const DEFAULT_RING_BYTES = 4 * 1024 * 1024;
const MIN_RING_BYTES = 64 * 1024;
const MAX_RING_BYTES = 1 << 30;
const CLOSE_WAIT_MS = 10_000;

export function normalizeRingBytes(requested: number | undefined): number {
	const wanted = requested ?? DEFAULT_RING_BYTES;
	if (!Number.isFinite(wanted) || wanted <= 0) {
		throw new Error("E_SINK_BAD_OPTIONS: ringBytes must be a positive number");
	}
	const clamped = Math.min(
		MAX_RING_BYTES,
		Math.max(MIN_RING_BYTES, Math.ceil(wanted)),
	);
	// Round up to a power of two: the ring mask arithmetic requires it.
	return 2 ** Math.ceil(Math.log2(clamped));
}

export function openReadSinkOnNativeHandle(
	native: SinkCapableNativeHandle,
	opts: StreamSinkOptions = {},
): StreamSinkHandle {
	const ringBytes = normalizeRingBytes(opts.ringBytes);
	const framing = opts.framing ?? null;
	const sab = new SharedArrayBuffer(SINK_DATA_OFFSET + ringBytes);
	const view = new Uint8Array(sab);
	const result = native.openReadSink(view, {
		dataCapacity: ringBytes,
		dropNewest: opts.overflow === "drop-newest",
		wallClock: opts.clock === "wall",
		framing: framing
			? {
					headerBytes: framing.headerBytes,
					lengthOffset: framing.lengthOffset,
					lengthWidth: framing.lengthWidth,
					bigEndian: framing.endianness === "be",
					lengthIncludesHeader: framing.lengthIncludesHeader ?? true,
					maxFrameBytes: framing.maxFrameBytes,
				}
			: undefined,
		backpressureTimeoutMs: opts.backpressureTimeoutMs,
		idleTimeoutMs: opts.idleTimeoutMs,
	});
	if (typeof result === "string") {
		throw new Error(result);
	}
	const info = result as {
		dataCapacity: number;
		flags: number;
		monotonicAnchorUs: number;
		wallAnchorUs: number;
	};
	const descriptor: StreamSinkDescriptor = {
		version: 1,
		dataCapacity: info.dataCapacity,
		flags: info.flags,
		clock: (info.flags & FLAG_CLOCK_WALL) !== 0 ? "wall" : "monotonic",
		monotonicAnchorUs: info.monotonicAnchorUs,
		wallAnchorUs: info.wallAnchorUs,
		framing,
	};
	const dv = new DataView(sab);
	let closed = false;
	return {
		buffer: sab,
		descriptor,
		stats(): StreamSinkStats {
			const nativeStats = native.sinkStats?.();
			return {
				bytesIn: nativeStats?.bytesIn ?? 0,
				records: nativeStats?.records ?? 0,
				droppedRecords: Number(dv.getBigUint64(OFF_DROPPED_RECORDS, true)),
				droppedBytes: Number(dv.getBigUint64(OFF_DROPPED_BYTES, true)),
				ringHighWater: dv.getUint32(OFF_HIGH_WATER, true),
				pendingPartialBytes: nativeStats?.pendingPartialBytes ?? 0,
				state:
					nativeStats == null
						? "closed"
						: (TASK_STATE_NAMES[nativeStats.taskState] ?? "closed"),
			};
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			try {
				native.sinkCloseBegin();
				await native.sinkWaitExit(CLOSE_WAIT_MS);
			} finally {
				native.sinkReleaseBuffer();
			}
		},
	};
}
