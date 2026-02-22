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
import type { DuplexOptions, ReadableOptions, WritableOptions } from "node:stream";

/** Symbol-based stream control — avoids name collisions with Node stream API */
export const WT_RESET: unique symbol = Symbol("WT_RESET");
export const WT_STOP_SENDING: unique symbol = Symbol("WT_STOP_SENDING");

export type Resettable = { [WT_RESET](code?: number): void };
export type StopSendable = { [WT_STOP_SENDING](code?: number): void };

// ---------------------------------------------------------------------------
// Internal handle type (opaque id referencing native StreamHandle)
// ---------------------------------------------------------------------------
type StreamHandleId = number;

// ---------------------------------------------------------------------------
// Bidi stream (Duplex)
// ---------------------------------------------------------------------------

export interface BidiStreamOptions extends DuplexOptions {
    handleId: StreamHandleId;
    nativeHandle?: any;
}

export class BidiStream extends Duplex implements Resettable, StopSendable {
    private readonly _handleId: StreamHandleId;
    readonly #nativeHandle: any;

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
    }

    // -- Node stream overrides (to be wired to native) -----------------------

    override _read(_size: number): void {
        const h = this.#nativeHandle;
        if (!h) {
            this.push(null);
            return;
        }
        h.read()
            .then((buf: Buffer | null) => {
                if (buf) this.push(buf);
                else this.push(null);
            })
            .catch((err: any) => this.destroy(err));
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        this.#nativeHandle?.write(chunk).then(() => callback()).catch(callback);
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.#nativeHandle?.finish?.();
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        callback(error);
    }

    // -- Stream control extensions -------------------------------------------

    [WT_RESET](code?: number): void {
        this.#nativeHandle.reset(code ?? 0);
        this.destroy();
    }

    [WT_STOP_SENDING](code?: number): void {
        this.#nativeHandle.stopSending(code ?? 0);
    }
}

// ---------------------------------------------------------------------------
// Outgoing uni stream (Writable)
// ---------------------------------------------------------------------------

export interface SendStreamOptions extends WritableOptions {
    handleId: StreamHandleId;
    nativeHandle?: any;
}

export class SendStream extends Writable implements Resettable {
    private readonly _handleId: StreamHandleId;
    readonly #nativeHandle: any;

    constructor(opts: SendStreamOptions) {
        super({
            ...opts,
            highWaterMark: opts.highWaterMark ?? 256 * 1024,
        });
        this._handleId = opts.handleId;
        this.#nativeHandle = opts.nativeHandle;
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        // TODO: send to native via stream_write(handleId, chunk)
        this.#nativeHandle?.write(chunk).then(() => callback()).catch(callback);
    }

    override _final(callback: (error?: Error | null) => void): void {
        // TODO: signal FIN
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        // TODO: clean up native resources
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
}

export class RecvStream extends Readable implements StopSendable {
    private readonly _handleId: StreamHandleId;
    readonly #nativeHandle: any;

    constructor(opts: RecvStreamOptions) {
        super({
            ...opts,
            highWaterMark: opts.highWaterMark ?? 256 * 1024,
        });
        this._handleId = opts.handleId;
        this.#nativeHandle = opts.nativeHandle;
    }

    override _read(_size: number): void {
        // TODO: pull from native incoming queue
        this.#nativeHandle?.read().then((buf: Buffer | null) => {
            if (buf) this.push(buf);
            else this.push(null);
        }).catch((err: any) => this.destroy(err));
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        // TODO: clean up native resources
        callback(error);
    }

    [WT_STOP_SENDING](code?: number): void {
        this.#nativeHandle?.stopSending(code ?? 0);
    }
}
