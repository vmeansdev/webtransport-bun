/**
 * Server-loop-utilization snapshot sidecar.
 *
 * The controller-side endpoint for `server-snapshot-protocol.ts`. The
 * codec lives in its own `protocolOnlyTs` module; this module is the
 * place where a stream is owned, deadlines are enforced, and
 * one-shot consumption is guaranteed. Two implementations of the
 * same `ServerLoopSnapshotSource` interface:
 *
 * 1. `bindInProcessServerSnapshotSource(server, options)`: wraps a
 *    `ServerHandle` that lives in the same Bun process as the
 *    controller (used in tests and in the single-host staging setup).
 *    The transport is bound at construction so the synthesised
 *    `ServerSnapshotRecord` carries the same correlation tuple as
 *    the leg the controller is joining.
 *
 * 2. `sidecarServerSnapshotSource(stream, clock)`: consumes one
 *    length-prefixed frame from an `AsyncIterable<Uint8Array>`. The
 *    iterable is whatever the rig control channel exposes (a
 *    dedicated SSH session, a fd-paired stream, or a
 *    `Bun.spawn`-backed pipe). The endpoint does not own the
 *    process: it owns only the consumption contract.
 *
 * The sidecar is consumed exactly once per leg. After `readSnapshot`
 * resolves, the source is exhausted and any further read is a
 * typed refusal. This is the one-shot guarantee that keeps a stale
 * snapshot from a prior repetition from being attached to the
 * next artifact.
 */
import type { ServerHandle, TransportClock } from "./adapters/transport.ts";
import {
	readServerSnapshotFrame,
	type ServerSnapshotRecord,
} from "./server-snapshot-protocol.ts";

/**
 * Read the server-aggregate loop utilization exactly once.
 *
 * `readSnapshot(deadlineMs)` resolves to a `ServerSnapshotRecord`
 * or rejects with a typed error on deadline, exhaustion, malformed
 * frame, or schema mismatch. The implementation owns the channel
 * state; the consumer (the controller, or
 * `measureLegOverAdapter` in Commit 2) sees only the resolved
 * record.
 */
export interface ServerLoopSnapshotSource {
	readSnapshot(deadlineMs: number): Promise<ServerSnapshotRecord>;
	/**
	 * Release the underlying channel. Idempotent. The controller
	 * calls this between legs so a stuck stream does not pin the
	 * next leg's timeout.
	 */
	close(): void;
}

export function inProcessServerSnapshotSource(
	server: ServerHandle,
): ServerLoopSnapshotSource {
	void server;
	throw new Error(
		"inProcessServerSnapshotSource is not exported; use `bindInProcessServerSnapshotSource` with a full correlation-tuple binding",
	);
}

/**
 * Bind an in-process source to a specific transport and leg
 * identity. The transport is required by the protocol's correlation
 * tuple; the controller has it from the campaign config.
 */
export function bindInProcessServerSnapshotSource(
	server: ServerHandle,
	options: {
		readonly transport: "ws" | "wt";
		readonly campaignId: string;
		readonly runId: string;
		readonly executionIndex: number;
		readonly legId: string;
		readonly sequence: number;
		readonly clock: () => number;
	},
): ServerLoopSnapshotSource {
	let consumed = false;
	return {
		async readSnapshot(deadlineMs: number): Promise<ServerSnapshotRecord> {
			if (consumed) {
				throw new Error(
					"E_BACKPRESSURE_TIMEOUT: in-process server snapshot source already consumed",
				);
			}
			consumed = true;
			if (!Number.isFinite(deadlineMs)) {
				throw new RangeError(`read deadline must be finite; got ${deadlineMs}`);
			}
			if (deadlineMs - options.clock() <= 0) {
				throw new Error("E_HANDSHAKE_TIMEOUT: read deadline already expired");
			}
			const snapshot = server.snapshot();
			return {
				schema: "server-loop-utilization/v1",
				campaignId: options.campaignId,
				runId: options.runId,
				executionIndex: options.executionIndex,
				transport: options.transport,
				legId: options.legId,
				sequence: options.sequence,
				capturedAtMs: options.clock(),
				loopUtilization: snapshot.serverLoopUtilization,
			};
		},
		close(): void {
			consumed = true;
		},
	};
}

/**
 * Consume one frame from a stream-backed sidecar.
 *
 * `stream` is an `AsyncIterable<Uint8Array>` whose items together
 * form exactly one length-prefixed frame. The endpoint buffers
 * partial reads, enforces the read deadline, and refuses to read
 * past the first frame. A second call to `readSnapshot` is a
 * typed refusal.
 */
export function sidecarServerSnapshotSource(
	stream: AsyncIterable<Uint8Array>,
	clock: TransportClock,
): ServerLoopSnapshotSource {
	let exhausted = false;
	const chunks: Uint8Array[] = [];
	let buffered = 0;
	let prefixRead = false;
	let payloadLength = 0;
	let payloadRead = 0;
	return {
		async readSnapshot(deadlineMs: number): Promise<ServerSnapshotRecord> {
			if (exhausted) {
				throw new Error(
					"E_BACKPRESSURE_TIMEOUT: sidecar stream already consumed",
				);
			}
			exhausted = true;
			const iterator = stream[Symbol.asyncIterator]();
			try {
				const frame = await readServerSnapshotFrame(
					async () => {
						// Drain the iterator until a complete
						// length-prefixed frame has been
						// assembled, then return it. EOF
						// returns null so the codec surfaces
						// the typed refusal.
						while (true) {
							if (prefixRead && payloadRead >= payloadLength) {
								const merged = mergeChunks(chunks, 4 + payloadLength);
								chunks.length = 0;
								buffered = 0;
								prefixRead = false;
								payloadRead = 0;
								payloadLength = 0;
								return merged;
							}
							const next = await iterator.next();
							if (next.done) {
								if (buffered === 0) return null;
								throw new Error(
									"E_SESSION_CLOSED: sidecar stream closed mid-frame",
								);
							}
							const value = next.value;
							if (!(value instanceof Uint8Array)) {
								throw new TypeError(
									"sidecar stream yielded a non-Uint8Array chunk",
								);
							}
							chunks.push(value);
							buffered += value.byteLength;
							if (!prefixRead && buffered >= 4) {
								const head = mergeChunks(chunks, 4);
								const view = new DataView(
									head.buffer,
									head.byteOffset,
									head.byteLength,
								);
								payloadLength = view.getUint32(0, false);
								prefixRead = true;
							}
							if (prefixRead) {
								payloadRead = Math.max(payloadRead, buffered - 4);
							}
						}
					},
					deadlineMs,
					() => clock.nowMs(),
				);
				return frame;
			} finally {
				// The iterator is consumed by the codec loop
				// above; release it on every path so the
				// underlying stream is not pinned.
				if (typeof iterator.return === "function") {
					await iterator.return();
				}
			}
		},
		close(): void {
			exhausted = true;
		},
	};
}

function mergeChunks(chunks: Uint8Array[], target: number): Uint8Array {
	// If a single chunk is exactly the target size, return it
	// without copying. `byteLength` is the chunk's view length,
	// not the underlying buffer size, so a subarray view that
	// happens to span the full target returns as-is.
	if (chunks.length === 1 && chunks[0]!.byteLength === target) {
		return chunks[0]!;
	}
	const merged = new Uint8Array(target);
	let written = 0;
	for (const chunk of chunks) {
		// The caller may have buffered more bytes than the
		// current target (e.g. the entire frame is in one
		// chunk, and we are reading the 4-byte length prefix).
		// Limit each chunk write to the remaining target
		// space so the `set` does not overflow.
		const remaining = target - written;
		if (remaining <= 0) break;
		const take = Math.min(chunk.byteLength, remaining);
		merged.set(
			chunk.byteOffset === 0 && take === chunk.byteLength
				? chunk
				: chunk.subarray(0, take),
			written,
		);
		written += take;
	}
	return merged;
}
