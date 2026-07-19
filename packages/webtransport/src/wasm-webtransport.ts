// Wasm implementation of the W3C `WebTransport` API.
//
// Wraps a `WasmSession` (the callback-driven wasm facade) so it satisfies
// the native W3C WebTransport shape (ReadableStream/WritableStream).

import type { WasmSession, WasmStream } from "./backend.js";
import { WebTransportError, E_SESSION_CLOSED } from "./errors.js";

/** Caps on the WHATWG streams so a flood with a slow consumer can't OOM. */
const MAX_QUEUED_DATAGRAMS = 1024;
const MAX_QUEUED_INCOMING_STREAMS = 256;

/** Browser-style close info (W3C alignment). */
export type WebTransportCloseInfo = {
	closeCode?: number;
	reason?: string;
};

/** A bidirectional stream as a pair of WHATWG streams. */
export interface WebTransportBidirectionalStream {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

export type WebTransportDatagramDuplexStream = {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	createWritable(options?: {
		sendGroup?: any | null;
		sendOrder?: number;
	}): WritableStream<Uint8Array>;
	readonly maxDatagramSize: number;
};

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
 * EVERY byte is accepted by the QUIC send buffer.
 */
function streamWritable(stream: WasmStream): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
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

function toBidi(stream: WasmStream): WebTransportBidirectionalStream {
	return { readable: streamReadable(stream), writable: streamWritable(stream) };
}

/** Presents a `WasmSession` through the W3C `WebTransport` contract. */
export class WasmWebTransport {
	readonly ready: Promise<void>;
	readonly closed: Promise<WebTransportCloseInfo>;
	readonly draining: Promise<undefined>;
	readonly datagrams: WebTransportDatagramDuplexStream;
	readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
	readonly incomingUnidirectionalStreams: ReadableStream<
		ReadableStream<Uint8Array>
	>;

	constructor(private readonly session: WasmSession) {
		this.ready = session.ready;
		this.draining = new Promise(() => {}); // Draining not implemented in backend yet

		this.closed = session.closed
			.then((info) => ({
				closeCode: info.code,
				reason: info.reason,
			}))
			.catch((err) => {
				// W3C specifies closed rejects on connect failure.
				throw err;
			});

		// Datagrams
		let datagramsController!: ReadableStreamDefaultController<Uint8Array>;
		const dReadable = new ReadableStream<Uint8Array>(
			{
				start(c) {
					datagramsController = c;
				},
			},
			new CountQueuingStrategy({ highWaterMark: MAX_QUEUED_DATAGRAMS }),
		);

		session.onDatagram((d) => {
			if ((datagramsController.desiredSize ?? 1) > 0) {
				try {
					datagramsController.enqueue(d);
				} catch {}
			}
		});

		const dWritable = new WritableStream<Uint8Array>({
			write: (chunk) => {
				// Fire and forget; WasmSession.sendDatagram drops if queue is full
				session.sendDatagram(chunk);
			},
		});

		this.datagrams = {
			readable: dReadable,
			writable: dWritable,
			createWritable() {
				return dWritable;
			},
			maxDatagramSize: 1200,
		};

		// Incoming streams
		let bidiController!: ReadableStreamDefaultController<WebTransportBidirectionalStream>;
		let uniController!: ReadableStreamDefaultController<
			ReadableStream<Uint8Array>
		>;

		let incomingStarted = false;
		const startIncoming = () => {
			if (incomingStarted) return;
			incomingStarted = true;
			session.onIncomingStream((stream) => {
				if (stream.bidi) {
					if ((bidiController.desiredSize ?? 1) <= 0) {
						stream.stop(0);
						stream.reset(0);
					} else {
						try {
							bidiController.enqueue(toBidi(stream));
						} catch {}
					}
				} else {
					if ((uniController.desiredSize ?? 1) <= 0) {
						stream.stop(0);
					} else {
						try {
							uniController.enqueue(streamReadable(stream));
						} catch {}
					}
				}
			});
		};

		this.incomingBidirectionalStreams =
			new ReadableStream<WebTransportBidirectionalStream>(
				{
					start(c) {
						bidiController = c;
					},
					pull: startIncoming,
				},
				new CountQueuingStrategy({
					highWaterMark: MAX_QUEUED_INCOMING_STREAMS,
				}),
			);

		this.incomingUnidirectionalStreams = new ReadableStream<
			ReadableStream<Uint8Array>
		>(
			{
				start(c) {
					uniController = c;
				},
				pull: startIncoming,
			},
			new CountQueuingStrategy({ highWaterMark: MAX_QUEUED_INCOMING_STREAMS }),
		);

		this.closed
			.then(() => {
				try {
					datagramsController.close();
				} catch {}
				try {
					bidiController.close();
				} catch {}
				try {
					uniController.close();
				} catch {}
			})
			.catch(() => {
				const err = new WebTransportError(
					E_SESSION_CLOSED,
					"Connection failed",
				);
				try {
					datagramsController.error(err);
				} catch {}
				try {
					bidiController.error(err);
				} catch {}
				try {
					uniController.error(err);
				} catch {}
			});
	}

	close(info?: WebTransportCloseInfo): void {
		this.session.close({ code: info?.closeCode, reason: info?.reason });
	}

	async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
		return toBidi(this.session.createBidirectionalStream());
	}

	async createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
		return streamWritable(this.session.createUnidirectionalStream());
	}
}
