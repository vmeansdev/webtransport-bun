// Wasm implementation of the backend-agnostic WebTransport contract.
//
// Wraps a `WasmSession` (the callback-driven wasm facade) so it satisfies
// `WebTransportLike`, bridging push-style wasm callbacks into pull-based WHATWG
// streams.
//
// memory.grow safety: the wasm core's `Uint8Array`s are views over wasm linear
// memory which DETACHES on `memory.grow`. The manager layer (backend.ts) already
// `.slice()`s every inbound buffer (onDatagram / onStreamData) before it reaches
// us, so the bytes we enqueue here are owned copies. We never enqueue a raw view
// from the wasm side into a stream controller.

import type { WasmSession, WasmStream } from "./backend.js";
import type { WebTransportLike, WtBidiStream, WtCloseInfo } from "./shared.js";

/**
 * A tiny async queue that bridges a push-callback source to an async-iterable.
 * Items pushed before a consumer is waiting are buffered (preserving order); a
 * waiting consumer is resolved directly. Backpressure is bounded only by the
 * source — adequate for the in-memory/loopback transports this backend targets.
 */
class AsyncQueue<T> {
	private readonly items: T[] = [];
	private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
	private done = false;

	push(item: T): void {
		if (this.done) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: item, done: false });
		else this.items.push(item);
	}

	close(): void {
		if (this.done) return;
		this.done = true;
		for (const w of this.waiters.splice(0)) {
			w({ value: undefined as never, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				const item = this.items.shift();
				if (item !== undefined) {
					return Promise.resolve({ value: item, done: false });
				}
				if (this.done) {
					return Promise.resolve({ value: undefined as never, done: true });
				}
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
}

/**
 * Wrap a `WasmStream` as a WHATWG `ReadableStream` (enqueue on data, close on
 * fin, error on reset). When the consumer falls behind (desiredSize <= 0) the
 * wasm stream is paused so QUIC flow control throttles the sender; `pull`
 * resumes it.
 */
function streamReadable(stream: WasmStream): ReadableStream<Uint8Array> {
	let cancelled = false;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			stream.onData((data, fin) => {
				if (cancelled) return; // consumer cancelled; drop, no enqueue throw
				// `data` is already a copy from the manager's `.slice()`.
				if (data.length > 0) {
					try {
						controller.enqueue(data);
					} catch {
						return; // controller errored/closed — stop enqueuing
					}
					if ((controller.desiredSize ?? 1) <= 0) stream.pause();
				}
				if (fin) {
					try {
						controller.close();
					} catch {
						// Already closed (e.g. duplicate fin) — ignore.
					}
				}
			});
			stream.onReset((code) => {
				try {
					controller.error(new Error(`stream reset: ${code}`));
				} catch {
					// Already closed/errored — a settled stream stays settled.
				}
			});
		},
		pull() {
			stream.resume();
		},
		cancel() {
			// Consumer cancelled: STOP_SENDING so the peer stops, and release.
			cancelled = true;
			stream.stop(0);
		},
	});
}

/**
 * Wrap a `WasmStream` as a WHATWG `WritableStream`. `write` resolves only once
 * EVERY byte is accepted by the QUIC send buffer — a closed flow-control
 * window yields (the endpoint pump makes progress) and the remainder is
 * retried, so large chunks are never silently truncated.
 */
function streamWritable(stream: WasmStream): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			// writeAll copies the chunk and resolves only once every byte is
			// accepted — pending resolution IS the WHATWG backpressure signal.
			return stream.writeAll(chunk);
		},
		close() {
			stream.finish();
		},
		abort(reason) {
			const code = typeof reason === "number" ? reason : 0;
			stream.reset(code);
		},
	});
}

function toBidi(stream: WasmStream): WtBidiStream {
	return { readable: streamReadable(stream), writable: streamWritable(stream) };
}

/** Presents a `WasmSession` through the shared {@link WebTransportLike} contract. */
export class WasmWebTransport implements WebTransportLike {
	readonly ready: Promise<void>;
	readonly closed: Promise<WtCloseInfo>;
	private readonly datagrams = new AsyncQueue<Uint8Array>();
	private readonly bidiStreams = new AsyncQueue<WtBidiStream>();
	private readonly uniStreams = new AsyncQueue<ReadableStream<Uint8Array>>();
	private incomingStarted = false;

	constructor(private readonly session: WasmSession) {
		this.ready = session.ready;
		this.closed = session.closed;
		session.onDatagram((d) => this.datagrams.push(d));
		this.closed.then(() => {
			this.datagrams.close();
			this.bidiStreams.close();
			this.uniStreams.close();
		});
	}

	close(info?: WtCloseInfo): void {
		this.session.close(info);
	}

	sendDatagram(data: Uint8Array): Promise<void> {
		if (this.session.sendDatagram(data)) return Promise.resolve();
		const err = Promise.reject(new Error("sendDatagram failed"));
		// Datagrams are fire-and-forget for many callers; pre-handle the
		// rejection so it never surfaces as an unhandled-rejection crash.
		// Callers that DO await still observe the error.
		err.catch(() => {});
		return err;
	}

	incomingDatagrams(): AsyncIterable<Uint8Array> {
		return this.datagrams;
	}

	// async: a failed open (no session / closed connection) throws inside
	// `createXStream` and must surface as a rejection, not a sync throw.
	async createBidirectionalStream(): Promise<WtBidiStream> {
		return toBidi(this.session.createBidirectionalStream());
	}

	async createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
		return streamWritable(this.session.createUnidirectionalStream());
	}

	incomingBidirectionalStreams(): AsyncIterable<WtBidiStream> {
		this.startIncoming();
		return this.bidiStreams;
	}

	incomingUnidirectionalStreams(): AsyncIterable<ReadableStream<Uint8Array>> {
		this.startIncoming();
		return this.uniStreams;
	}

	/** Register the single onIncomingStream callback that fans out by stream kind. */
	private startIncoming(): void {
		if (this.incomingStarted) return;
		this.incomingStarted = true;
		this.session.onIncomingStream((stream) => {
			if (stream.bidi) this.bidiStreams.push(toBidi(stream));
			else this.uniStreams.push(streamReadable(stream));
		});
	}
}
