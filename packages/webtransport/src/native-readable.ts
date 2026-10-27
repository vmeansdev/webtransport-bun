/**
 * The receive half of a native stream as a WHATWG byte stream that pulls the
 * addon directly: one `pull` is one `readStreamChunk` crossing (`readBatch`
 * when the batch knob is on, `read` otherwise) and one `enqueue`.
 *
 * Every native-backed incoming readable is built here — the server's accepted
 * bidi and uni streams, and the client's created and accepted ones, which used
 * to go native handle → Node `Readable` → async iterator → web stream and paid
 * two promise layers and a Node buffer per chunk for nothing.
 *
 * The owner keeps the lifecycle: this module never resets, disposes or
 * releases anything itself; it reports EOF, errors and cancellation to the
 * owner's hooks and puts on the stream what the owner says to.
 *
 * Backpressure is the pull itself: `highWaterMark: 0`, so the addon is read
 * only while a reader is waiting, and an idle consumer leaves the bytes in the
 * native queue where QUIC flow control pushes back on the peer.
 */

import {
	type BatchableRecvHandle,
	readStreamChunk,
} from "./stream-chunk-batch.js";

export type NativeReadableOwner = {
	/** The live handle, or null once the owner released it. A read that
	 * completes after the owner released the handle closes the stream — what
	 * the next pull would have done — so a reader already waiting settles
	 * instead of hanging; a read that completes after a cancel, or after the
	 * handle was swapped for another, is dropped. */
	current(): BatchableRecvHandle | null;
	/** A read is about to cross the handle: the first one marks the stream as
	 * read, so a native sink can no longer claim it (`openReadSink` throws
	 * E_SINK_READ_ACTIVE). Called before every direct read and when a group
	 * feeder starts reading. */
	onRead?: () => void;
	/** Set by a read group (read-group.ts) when it attaches the stream; the
	 * owner calls it whenever it releases the handle (dispose, reset, session
	 * close), so a stream that was attached but never read does not stay in
	 * the group's pump. */
	released?: () => void;
	/** Bytes about to be delivered (connection statistics). */
	onBytes?: (bytes: number) => void;
	/** The peer finished cleanly; called before the stream closes. */
	onEnd(): void;
	/** A read failed; release whatever the owner holds and return the error
	 * the stream should carry. */
	onError(err: unknown): unknown;
	/** The consumer cancelled the readable. */
	onCancel(reason: unknown): void;
};

type ByteController = {
	enqueue(chunk: Uint8Array): void;
	close(): void;
	error(err: unknown): void;
	readonly byobRequest?: { respond(bytesWritten: number): void } | null;
};

/**
 * Close a byte stream, completing a BYOB read that is waiting on it: a byte
 * source must answer a pending pull-into with `respond(0)` after `close()`,
 * or that read never settles.
 */
export function closeByteStream(controller: ByteController): void {
	controller.close();
	controller.byobRequest?.respond(0);
}

/** Close unless the stream already settled by another path. */
export function closeQuietly(controller: ByteController): void {
	try {
		closeByteStream(controller);
	} catch {
		// Already closed or errored: the reader has its answer.
	}
}

type PullState = { cancelled: boolean };

function pullOnce(
	owner: NativeReadableOwner,
	controller: ByteController,
	state: PullState,
): Promise<void> | undefined {
	const handle = owner.current();
	if (!handle) {
		closeByteStream(controller);
		return undefined;
	}
	owner.onRead?.();
	return readStreamChunk(handle).then(
		(value): Promise<void> | undefined => {
			if (state.cancelled) return undefined;
			const live = owner.current();
			if (live !== handle) {
				// Released while the read was in flight: settle the waiting
				// reader the way the next pull would. Swapped: not ours.
				if (live === null) closeQuietly(controller);
				return undefined;
			}
			// Never-reject sentinel: a string result IS an error code (see
			// unwrapNativeValue) and is never deliverable as payload.
			if (typeof value === "string") {
				controller.error(owner.onError(new Error(value)));
				return undefined;
			}
			if (value === null) {
				owner.onEnd();
				closeByteStream(controller);
				return undefined;
			}
			// A byte stream refuses an empty chunk, and a pull that enqueues
			// nothing is not re-run while the reader waits: read again instead.
			if (value.byteLength === 0) return pullOnce(owner, controller, state);
			owner.onBytes?.(value.byteLength);
			controller.enqueue(value);
			return undefined;
		},
		(err: unknown) => {
			if (state.cancelled) return;
			const live = owner.current();
			if (live !== handle) {
				if (live === null) closeQuietly(controller);
				return;
			}
			controller.error(owner.onError(err));
		},
	);
}

export function createNativeByteReadable(
	owner: NativeReadableOwner,
): ReadableStream<Uint8Array> {
	// Bun's `UnderlyingSource` type does not model `type: "bytes"` sources and
	// this package's tsconfig omits the DOM lib that defines
	// `UnderlyingByteSource`; the runtime supports it (see the datagram
	// readables), so bypass the constructor's overloads here.
	const state: PullState = { cancelled: false };
	return new ReadableStream<Uint8Array>(
		{
			type: "bytes",
			pull: (controller: ByteController) => pullOnce(owner, controller, state),
			cancel: (reason: unknown) => {
				state.cancelled = true;
				owner.onCancel(reason);
			},
		} as unknown as object,
		{ highWaterMark: 0 },
	);
}

export type { ByteController };
