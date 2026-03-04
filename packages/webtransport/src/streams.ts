/**
 * Node stream wrappers for WebTransport QUIC streams.
 *
 * All bidi streams are exposed as Duplex.
 * Outgoing uni streams are Writable, incoming uni streams are Readable.
 *
 * Stream control extensions (reset / stopSending) are attached via symbols
 * to avoid name collisions with Node stream methods.
 */

import { Duplex, Readable, Writable } from "node:stream";
import type {
	DuplexOptions,
	ReadableOptions,
	WritableOptions,
} from "node:stream";

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
	#strictStreamErrors = DEFAULT_STRICT_STREAM_ERRORS;

	constructor(opts: BidiStreamOptions) {
		super({
			...opts,
			allowHalfOpen: true,
			autoDestroy: false,
			readableHighWaterMark: opts.readableHighWaterMark ?? 256 * 1024,
			writableHighWaterMark: opts.writableHighWaterMark ?? 256 * 1024,
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
		h.read()
			.then((buf: Buffer | null) => {
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
			.then(() => callback())
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
					() => callback(),
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
			if (error) {
				try {
					this.#nativeHandle?.reset?.(0);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[webtransport] bidi stream reset on destroy failed: ${msg}`,
					);
				}
			}
			this.#nativeHandle = null;
		}
		callback(error);
	}

	// -- Stream control extensions -------------------------------------------

	[WT_RESET](code?: number): void {
		this.#nativeHandle?.reset(code ?? 0);
		this.destroy();
	}

	[WT_STOP_SENDING](code?: number): void {
		this.#nativeHandle?.stopSending(code ?? 0);
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
			.then(() => callback())
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
					() => callback(),
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
			if (error) {
				try {
					this.#nativeHandle?.reset?.(0);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[webtransport] unidirectional send stream reset on destroy failed: ${msg}`,
					);
				}
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
		h.read()
			.then((buf: Buffer | null) => {
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
			if (error) {
				try {
					this.#nativeHandle?.stopSending?.(0);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[webtransport] unidirectional recv stream stopSending on destroy failed: ${msg}`,
					);
				}
			}
			this.#nativeHandle = null;
		}
		callback(error);
	}

	[WT_STOP_SENDING](code?: number): void {
		this.#nativeHandle?.stopSending(code ?? 0);
	}
}
