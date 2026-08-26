/**
 * Wasm-backend stream sink (RFC_STREAM_SINK §7): shape parity with the
 * native sink. The producer is the TS RingWriter fed from the wasm stream's
 * onData on the main thread — so unlike the native sink this CANNOT isolate
 * app latency from a saturated main loop (a fact the docs state plainly).
 * What it does provide: the same StreamSinkHandle/SinkReader API, per-chunk
 * callback dispatch replaced by binary ring records, and real
 * Atomics.notify doorbells (FLAG_PRODUCER_NOTIFIES).
 */

import {
	I32_HEAD,
	REC_DATA,
	REC_EOF,
	REC_ERROR,
	REC_MESSAGE,
	REC_RESET,
	SINK_DATA_OFFSET,
	type StreamSinkDescriptor,
} from "./sink-layout.js";
import { FrameCutter, RingWriter, wasmRingFlags } from "./sink-ring-writer.js";
import {
	normalizeRingBytes,
	type StreamSinkHandle,
	type StreamSinkOptions,
	type StreamSinkStats,
} from "./sink.js";

/** The slice of a WasmStream the sink producer drives. */
export interface WasmSinkStream {
	onData(
		cb: (
			data: Uint8Array,
			fin: boolean,
			reservation?: { release(): void },
		) => void,
		options?: { retainReservation?: boolean },
	): void;
	onReset(cb: (code: number) => void): void;
	pause(): void;
	resume(): void;
	stop(code: number): void;
}

export interface CapturedWasmChunk {
	data: Uint8Array;
	fin: boolean;
	reservation?: { release(): void };
}

const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 5000;
const TEXT_ENCODER = new TextEncoder();

function clockNowNs(wall: boolean): bigint {
	if (wall) return BigInt(Date.now()) * 1_000_000n;
	return BigInt(Math.round(performance.now() * 1e6));
}

/**
 * Open a sink over a wasm stream. `captured` hands over chunks an existing
 * readable adapter had already buffered (their reservations transfer here),
 * keeping the takeover lossless.
 */
export function openWasmReadSink(
	stream: WasmSinkStream,
	opts: StreamSinkOptions = {},
	captured: CapturedWasmChunk[] = [],
): StreamSinkHandle {
	const ringBytes = normalizeRingBytes(opts.ringBytes);
	const framing = opts.framing ?? null;
	const dropNewest = opts.overflow === "drop-newest";
	const wall = opts.clock === "wall";
	const backpressureTimeoutMs =
		opts.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS;
	const idleTimeoutMs = opts.idleTimeoutMs ?? 0;
	const cutter = framing ? new FrameCutter(framing) : null;
	const flags = wasmRingFlags(framing, dropNewest, wall);
	const sab = new SharedArrayBuffer(SINK_DATA_OFFSET + ringBytes);
	const writer = new RingWriter(sab, ringBytes, flags, dropNewest);
	const i32 = new Int32Array(sab);
	const monotonicAnchorUs = performance.now() * 1000;
	const wallAnchorUs = Date.now() * 1000;
	const descriptor: StreamSinkDescriptor = {
		version: 1,
		dataCapacity: ringBytes,
		flags,
		clock: wall ? "wall" : "monotonic",
		monotonicAnchorUs,
		wallAnchorUs,
		framing,
	};

	let ended = false;
	let taskState: StreamSinkStats["state"] = "active";
	let bytesIn = 0;
	let records = 0;
	let offset = 0n;
	const backlog: CapturedWasmChunk[] = [...captured];
	let draining = false;
	let idleWatch: { heartbeat: number; since: number } | null = null;

	const finish = (
		kind: number,
		code: string,
		aux: number,
		state: StreamSinkStats["state"],
		stopWire: boolean,
	): void => {
		if (ended) return;
		ended = true;
		taskState = state;
		for (const item of backlog) item.reservation?.release();
		backlog.length = 0;
		const payload =
			kind === REC_ERROR ? TEXT_ENCODER.encode(code) : new Uint8Array(0);
		writer.pushTerminal(kind, clockNowNs(wall), offset, payload, aux);
		writer.setExited();
		if (stopWire) {
			try {
				stream.stop(0);
			} catch {
				// Session teardown may already have closed the stream.
			}
		}
	};

	/** Push one record, absorbing block-mode fullness via waitAsync on HEAD. */
	const pushRecord = async (
		kind: number,
		timestampNs: bigint,
		streamOffset: bigint,
		payload: Uint8Array,
	): Promise<boolean> => {
		let stallStarted: number | null = null;
		let heartbeatSeen = writer.consumerHeartbeat();
		for (;;) {
			if (ended) return false;
			const outcome = writer.push(kind, timestampNs, streamOffset, payload);
			if (outcome === "written") {
				records += 1;
				return true;
			}
			if (outcome === "dropped") return true;
			const heartbeat = writer.consumerHeartbeat();
			const now = performance.now();
			if (heartbeat !== heartbeatSeen) {
				heartbeatSeen = heartbeat;
				stallStarted = null;
			}
			stallStarted ??= now;
			if (now - stallStarted >= backpressureTimeoutMs) {
				finish(REC_ERROR, "E_SINK_STALLED", 0, "stalled", true);
				return false;
			}
			const head = Atomics.load(i32, I32_HEAD);
			const waited = Atomics.waitAsync(i32, I32_HEAD, head, 100);
			if (waited.async) await waited.value;
		}
	};

	const processChunk = async (item: CapturedWasmChunk): Promise<void> => {
		try {
			const timestamp = clockNowNs(wall);
			if (item.data.length > 0) {
				bytesIn += item.data.length;
				if (cutter) {
					let frames: Uint8Array[];
					try {
						frames = cutter.push(item.data);
					} catch {
						finish(REC_ERROR, "E_SINK_FRAME_FAULT", 0, "error", true);
						return;
					}
					for (const frame of frames) {
						const ok = await pushRecord(REC_MESSAGE, timestamp, offset, frame);
						offset += BigInt(frame.length);
						if (!ok) return;
					}
				} else {
					const ok = await pushRecord(REC_DATA, timestamp, offset, item.data);
					offset += BigInt(item.data.length);
					if (!ok) return;
				}
				// Drop-newest liveness (block mode has the fullness deadline).
				if (dropNewest && idleTimeoutMs > 0) {
					const heartbeat = writer.consumerHeartbeat();
					const now = performance.now();
					if (idleWatch && idleWatch.heartbeat === heartbeat) {
						if (now - idleWatch.since >= idleTimeoutMs) {
							finish(REC_ERROR, "E_SINK_STALLED", 0, "stalled", true);
							return;
						}
					} else {
						idleWatch = { heartbeat, since: now };
					}
				}
			}
			if (item.fin) finish(REC_EOF, "", 0, "eof", false);
		} finally {
			item.reservation?.release();
		}
	};

	const drain = async (): Promise<void> => {
		if (draining) return;
		draining = true;
		try {
			while (backlog.length > 0 && !ended) {
				const item = backlog.shift();
				if (item) await processChunk(item);
			}
		} finally {
			draining = false;
		}
		if (!ended) stream.resume();
	};

	stream.onData(
		(data, fin, reservation) => {
			if (ended) {
				reservation?.release();
				return;
			}
			backlog.push({ data, fin, reservation });
			stream.pause();
			void drain();
		},
		{ retainReservation: true },
	);
	stream.onReset((code) => {
		finish(REC_RESET, "", code >>> 0, "reset", false);
	});
	if (backlog.length > 0) void drain();

	return {
		buffer: sab,
		descriptor,
		stats(): StreamSinkStats {
			const dv = new DataView(sab);
			return {
				bytesIn,
				records,
				droppedRecords: Number(dv.getBigUint64(72, true)),
				droppedBytes: Number(dv.getBigUint64(80, true)),
				ringHighWater: dv.getUint32(88, true),
				pendingPartialBytes: cutter?.pendingBytes ?? 0,
				state: taskState,
			};
		},
		async close(): Promise<void> {
			if (!ended) finish(REC_ERROR, "E_SINK_CLOSED", 0, "closed", true);
		},
	};
}
