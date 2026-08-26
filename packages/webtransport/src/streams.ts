/**
 * Node stream wrappers for WebTransport QUIC streams.
 *
 * All bidi streams are exposed as Duplex.
 * Outgoing uni streams are Writable, incoming uni streams are Readable.
 *
 * Stream control extensions (reset / stopSending) are attached via symbols
 * to avoid name collisions with Node stream methods.
 */

import type {
	DuplexOptions,
	ReadableOptions,
	WritableOptions,
} from "node:stream";
import { Duplex, Readable, Writable } from "node:stream";
import {
	openReadSinkOnNativeHandle,
	type StreamSinkHandle,
	type StreamSinkOptions,
} from "./sink.js";
import { readStreamChunk } from "./stream-chunk-batch.js";

/**
 * Symbol to call stream reset (abort receiving). Use on BidiStream, SendStream, RecvStream.
 * @example `(stream as Resettable)[WT_RESET](code)`
 */
export const WT_RESET: unique symbol = Symbol("WT_RESET");
/**
 * Symbol to send stopSending (abort sending). Use on BidiStream, RecvStream.
 * @example `(stream as StopSendable)[WT_STOP_SENDING](code)`
 */
export const WT_STOP_SENDING: unique symbol = Symbol("WT_STOP_SENDING");

/** Stream that supports reset via WT_RESET. */
export type Resettable = { [WT_RESET](code?: number): void };
/** Stream that supports stopSending via WT_STOP_SENDING. */
export type StopSendable = { [WT_STOP_SENDING](code?: number): void };

// ---------------------------------------------------------------------------
// Internal handle type (opaque id referencing native StreamHandle)
// ---------------------------------------------------------------------------
type StreamHandleId = number;
const DEFAULT_STRICT_STREAM_ERRORS =
	process.env.WEBTRANSPORT_STRICT_STREAM_ERRORS === "1";
const SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS =
	process.env.WEBTRANSPORT_SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS === "1";

function normalizeError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Bidi stream (Duplex)
// ---------------------------------------------------------------------------

export interface BidiStreamOptions extends DuplexOptions {
	handleId: StreamHandleId;
	nativeHandle?: any;
	strictStreamErrors?: boolean;
}

export class BidiStream extends Duplex implements Resettable, StopSendable {
	private readonly _handleId: StreamHandleId;
	#nativeHandle: any;
	#destroyed = false;
	#readableEnded = false;
	#writableFinished = false;
	#nativeTerminationRequested = false;
	#strictStreamErrors = DEFAULT_STRICT_STREAM_ERRORS;

	constructor(opts: BidiStreamOptions) {
		super({
			...opts,
			allowHalfOpen: true,
			// autoDestroy stays false: it interferes with the separately-exposed
			// Web Readable/Writable lifecycle. Instead we free the native handle
			// explicitly once BOTH halves complete (see the end/finish listeners
			// below) — previously the handle was stranded until GC on a bidi
			// stream that completed cleanly.
			autoDestroy: false,
			readableHighWaterMark: opts.readableHighWaterMark ?? 256 * 1024,
			writableHighWaterMark: opts.writableHighWaterMark ?? 256 * 1024,
		});
		this._handleId = opts.handleId;
		this.#nativeHandle = opts.nativeHandle;
		this.#strictStreamErrors =
			opts.strictStreamErrors ?? DEFAULT_STRICT_STREAM_ERRORS;
		// Free the native handle when the stream completes cleanly: with
		// autoDestroy:false, a bidi stream whose readable reaches EOF and whose
		// writable finishes never runs _destroy() on its own, stranding the
		// native handle until GC. Destroy once BOTH halves are done (half-open
		// lifetimes are preserved because we wait for both events).
		let readableEnded = false;
		let writableFinished = false;
		const freeWhenBothDone = () => {
			if (readableEnded && writableFinished && !this.#destroyed) {
				this.destroy();
			}
		};
		this.once("end", () => {
			readableEnded = true;
			this.#readableEnded = true;
			freeWhenBothDone();
		});
		this.once("finish", () => {
			writableFinished = true;
			this.#writableFinished = true;
			freeWhenBothDone();
		});
		this.on("error", (err) => {
			if (this.listenerCount("error") > 1) return;
			const e = normalizeError(err);
			if (!SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS) {
				console.warn(
					`[webtransport] unhandled bidi stream error: ${e.message}`,
				);
			}
			if (this.#strictStreamErrors)
				queueMicrotask(() => {
					throw e;
				});
		});
	}

	// -- Node stream overrides -----------------------

	override _read(_size: number): void {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) {
			this.push(null);
			return;
		}
		// One crossing, one push: batching enlarges the chunk and never turns a
		// single push into a loop, so `push() === false` still stops the reader
		// exactly where it did before.
		readStreamChunk(h)
			.then((buf: Uint8Array | string | null) => {
				// Never-reject sentinel: a string result IS an error code
				// (see unwrapNativeValue) — never deliverable as payload.
				if (typeof buf === "string") {
					this.destroy(new Error(buf));
					return;
				}
				if (buf && !this.#destroyed) this.push(buf);
				else this.push(null);
			})
			.catch((err: any) => this.destroy(err));
	}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) {
			callback(new Error("E_STREAM_RESET"));
			return;
		}
		h.write(chunk)
			.then((code: string | null | undefined) =>
				typeof code === "string" ? callback(new Error(code)) : callback(),
			)
			.catch(callback);
	}

	override _final(callback: (error?: Error | null) => void): void {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) {
			callback();
			return;
		}
		try {
			const finishFn = h.finishWait ?? h.finish;
			if (typeof finishFn !== "function") {
				callback();
				return;
			}
			const ret = finishFn.call(h);
			if (ret && typeof ret.then === "function") {
				ret.then(
					(code: string | null | undefined) =>
						typeof code === "string" ? callback(new Error(code)) : callback(),
					(err: Error) => callback(err),
				);
				return;
			}
			callback();
		} catch (err) {
			callback(err as Error);
		}
	}

	override _destroy(
		error: Error | null,
		callback: (error?: Error | null) => void,
	): void {
		if (!this.#destroyed) {
			this.#destroyed = true;
			const nativeHandle = this.#nativeHandle;
			// A forced destroy can leave a pending native read() promise holding the
			// N-API handle alive. Abort both halves unless both Node halves completed
			// cleanly, so session teardown wakes that read and releases the native
			// stream object without adding a reset to a clean FIN/finish path.
			if (
				!this.#nativeTerminationRequested &&
				(error || !this.#readableEnded || !this.#writableFinished)
			) {
				try {
					nativeHandle?.stopSending?.(0);
				} catch {
					// Session teardown may already have closed the native stream.
				}
				try {
					nativeHandle?.reset?.(0);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[webtransport] bidi stream reset on destroy failed: ${msg}`,
					);
				}
			}
			try {
				nativeHandle?.dispose?.();
			} catch {
				// Resource disposal is best-effort during stream teardown.
			}
			this.#nativeHandle = null;
		}
		callback(error);
	}

	// -- Stream control extensions -------------------------------------------

	[WT_RESET](code?: number): void {
		this.#nativeTerminationRequested = true;
		const resetCode = code ?? 0;
		// Reset aborts the writable half. Stop the readable half as well so a
		// pending native read bridge cannot retain the N-API handle after reset.
		this.#nativeHandle?.stopSending?.(resetCode);
		this.#nativeHandle?.reset(resetCode);
		this.destroy();
	}

	[WT_STOP_SENDING](code?: number): void {
		this.#nativeHandle?.stopSending(code ?? 0);
	}

	/**
	 * Hand this stream's readable half to a native sink (RFC_STREAM_SINK): a
	 * native task drains it into the returned SharedArrayBuffer ring for a
	 * Worker-side SinkReader, off the JS event loop. One-way: facade reads
	 * error with E_SINK_ACTIVE afterwards (which destroys this Duplex, both
	 * halves — finish writing before reading-side errors matter, or use a
	 * uni stream). Throws E_SINK_READ_ACTIVE once facade reading started.
	 */
	openReadSink(opts?: StreamSinkOptions): StreamSinkHandle {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) throw new Error("E_STREAM_RESET");
		if (this.readableDidRead || this.readableFlowing !== null) {
			throw new Error("E_SINK_READ_ACTIVE");
		}
		return openReadSinkOnNativeHandle(h, opts);
	}
}

// ---------------------------------------------------------------------------
// Outgoing uni stream (Writable)
// ---------------------------------------------------------------------------

export interface SendStreamOptions extends WritableOptions {
	handleId: StreamHandleId;
	nativeHandle?: any;
	strictStreamErrors?: boolean;
}

export class SendStream extends Writable implements Resettable {
	private readonly _handleId: StreamHandleId;
	#nativeHandle: any;
	#destroyed = false;
	#strictStreamErrors = DEFAULT_STRICT_STREAM_ERRORS;

	constructor(opts: SendStreamOptions) {
		super({
			...opts,
			autoDestroy: true,
			highWaterMark: opts.highWaterMark ?? 256 * 1024,
		});
		this._handleId = opts.handleId;
		this.#nativeHandle = opts.nativeHandle;
		this.#strictStreamErrors =
			opts.strictStreamErrors ?? DEFAULT_STRICT_STREAM_ERRORS;
		this.on("error", (err) => {
			if (this.listenerCount("error") > 1) return;
			const e = normalizeError(err);
			if (!SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS) {
				console.warn(
					`[webtransport] unhandled unidirectional send stream error: ${e.message}`,
				);
			}
			if (this.#strictStreamErrors)
				queueMicrotask(() => {
					throw e;
				});
		});
	}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) {
			callback(new Error("E_STREAM_RESET"));
			return;
		}
		h.write(chunk)
			.then((code: string | null | undefined) =>
				typeof code === "string" ? callback(new Error(code)) : callback(),
			)
			.catch(callback);
	}

	override _final(callback: (error?: Error | null) => void): void {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) {
			callback();
			return;
		}
		try {
			const finishFn = h.finishWait ?? h.finish;
			if (typeof finishFn !== "function") {
				callback();
				return;
			}
			const ret = finishFn.call(h);
			if (ret && typeof ret.then === "function") {
				ret.then(
					(code: string | null | undefined) =>
						typeof code === "string" ? callback(new Error(code)) : callback(),
					(err: Error) => callback(err),
				);
				return;
			}
			callback();
		} catch (err) {
			callback(err as Error);
		}
	}

	override _destroy(
		error: Error | null,
		callback: (error?: Error | null) => void,
	): void {
		if (!this.#destroyed) {
			this.#destroyed = true;
			const nativeHandle = this.#nativeHandle;
			if (error) {
				try {
					nativeHandle?.reset?.(0);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[webtransport] unidirectional send stream reset on destroy failed: ${msg}`,
					);
				}
			}
			try {
				nativeHandle?.dispose?.();
			} catch {
				// Resource disposal is best-effort during stream teardown.
			}
			this.#nativeHandle = null;
		}
		callback(error);
	}

	[WT_RESET](code?: number): void {
		this.#nativeHandle?.reset(code ?? 0);
		this.destroy();
	}
}

// ---------------------------------------------------------------------------
// Incoming uni stream (Readable)
// ---------------------------------------------------------------------------

export interface RecvStreamOptions extends ReadableOptions {
	handleId: StreamHandleId;
	nativeHandle?: any;
	strictStreamErrors?: boolean;
}

export class RecvStream extends Readable implements StopSendable {
	private readonly _handleId: StreamHandleId;
	#nativeHandle: any;
	#destroyed = false;
	#strictStreamErrors = DEFAULT_STRICT_STREAM_ERRORS;

	constructor(opts: RecvStreamOptions) {
		super({
			...opts,
			autoDestroy: true,
			highWaterMark: opts.highWaterMark ?? 256 * 1024,
		});
		this._handleId = opts.handleId;
		this.#nativeHandle = opts.nativeHandle;
		this.#strictStreamErrors =
			opts.strictStreamErrors ?? DEFAULT_STRICT_STREAM_ERRORS;
		this.on("error", (err) => {
			if (this.listenerCount("error") > 1) return;
			const e = normalizeError(err);
			if (!SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS) {
				console.warn(
					`[webtransport] unhandled unidirectional recv stream error: ${e.message}`,
				);
			}
			if (this.#strictStreamErrors)
				queueMicrotask(() => {
					throw e;
				});
		});
	}

	override _read(_size: number): void {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) {
			this.push(null);
			return;
		}
		// One crossing, one push: batching enlarges the chunk and never turns a
		// single push into a loop, so `push() === false` still stops the reader
		// exactly where it did before.
		readStreamChunk(h)
			.then((buf: Uint8Array | string | null) => {
				// Never-reject sentinel: a string result IS an error code
				// (see unwrapNativeValue) — never deliverable as payload.
				if (typeof buf === "string") {
					this.destroy(new Error(buf));
					return;
				}
				if (buf && !this.#destroyed) this.push(buf);
				else this.push(null);
			})
			.catch((err: any) => this.destroy(err));
	}

	override _destroy(
		error: Error | null,
		callback: (error?: Error | null) => void,
	): void {
		if (!this.#destroyed) {
			this.#destroyed = true;
			const nativeHandle = this.#nativeHandle;
			if (error) {
				try {
					nativeHandle?.stopSending?.(0);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[webtransport] unidirectional recv stream stopSending on destroy failed: ${msg}`,
					);
				}
			}
			try {
				nativeHandle?.dispose?.();
			} catch {
				// Resource disposal is best-effort during stream teardown.
			}
			this.#nativeHandle = null;
		}
		callback(error);
	}

	[WT_STOP_SENDING](code?: number): void {
		this.#nativeHandle?.stopSending(code ?? 0);
	}

	/**
	 * Hand this stream to a native sink (RFC_STREAM_SINK): a native task
	 * drains it into the returned SharedArrayBuffer ring for a Worker-side
	 * SinkReader, off the JS event loop. One-way: facade reads error with
	 * E_SINK_ACTIVE afterwards. Throws E_SINK_READ_ACTIVE once facade
	 * reading started.
	 */
	openReadSink(opts?: StreamSinkOptions): StreamSinkHandle {
		const h = this.#nativeHandle;
		if (!h || this.#destroyed) throw new Error("E_STREAM_RESET");
		if (this.readableDidRead || this.readableFlowing !== null) {
			throw new Error("E_SINK_READ_ACTIVE");
		}
		return openReadSinkOnNativeHandle(h, opts);
	}
}
