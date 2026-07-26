// Wasm implementation of the W3C `WebTransport` API.
//
// Wraps a `WasmSession` (the callback-driven wasm facade) so it satisfies
// the native W3C WebTransport shape (ReadableStream/WritableStream).

import type {
	WasmPayloadReservation,
	WasmSession,
	WasmStream,
} from "./backend.js";
import {
	E_SESSION_CLOSED,
	E_STREAM_RESET,
	WebTransportError,
} from "./errors.js";
import type { WebTransportCloseInfo } from "./types.js";

/** A bidirectional stream as a pair of WHATWG streams. */
export interface WebTransportBidirectionalStream {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

export type WebTransportDatagramDuplexStream = {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	createWritable(options?: {
		sendGroup?: unknown | null;
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
	let pullPending = false;
	let finPending = false;
	const pending: Array<{
		data: Uint8Array;
		fin: boolean;
		reservation?: WasmPayloadReservation;
	}> = [];
	let controller!: ReadableStreamDefaultController<Uint8Array>;

	const releasePending = () => {
		for (const item of pending) item.reservation?.release();
		pending.length = 0;
	};
	const deliver = () => {
		if (cancelled) return;
		if (pending.length === 0) {
			if (finPending) {
				finPending = false;
				pullPending = false;
				try {
					controller.close();
				} catch {}
			}
			return;
		}
		if (!pullPending) return;
		const item = pending.shift();
		if (!item) return;
		pullPending = false;
		try {
			if (item.data.length > 0) controller.enqueue(item.data);
		} finally {
			item.reservation?.release();
		}
		if (item.fin || (finPending && pending.length === 0)) {
			finPending = false;
			controller.close();
		} else if (pending.length === 0) {
			stream.resume();
		}
	};

	return new ReadableStream<Uint8Array>(
		{
			start(sourceController) {
				controller = sourceController;
				stream.onData(
					(data, fin, reservation) => {
						if (cancelled) {
							reservation?.release();
							return;
						}
						if (data.length > 0) {
							pending.push({ data, fin, reservation });
							stream.pause();
						} else {
							reservation?.release();
							if (fin) finPending = true;
						}
						deliver();
					},
					{ retainReservation: true },
				);
				stream.onReset((code) => {
					releasePending();
					try {
						controller.error(
							new WebTransportError(
								E_STREAM_RESET,
								`${E_STREAM_RESET}: stream reset by peer (code ${code})`,
								{ streamErrorCode: code },
							),
						);
					} catch {
						// Already closed/errored — a settled stream stays settled.
					}
				});
			},
			pull() {
				pullPending = true;
				deliver();
			},
			cancel() {
				// Consumer cancelled: STOP_SENDING so the peer stops, and release.
				cancelled = true;
				releasePending();
				stream.stop(0);
			},
		},
		new CountQueuingStrategy({ highWaterMark: 0 }),
	);
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
	private resolveDraining!: () => void;

	constructor(private readonly session: WasmSession) {
		this.ready = session.ready;
		this.draining = new Promise<undefined>((resolve) => {
			this.resolveDraining = () => resolve(undefined);
		});

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
		let datagramPullPending = false;
		const pendingDatagrams: Array<{
			data: Uint8Array;
			reservation?: WasmPayloadReservation;
		}> = [];
		const deliverDatagram = () => {
			if (!datagramPullPending || pendingDatagrams.length === 0) return;
			const item = pendingDatagrams.shift();
			if (!item) return;
			datagramPullPending = false;
			try {
				datagramsController.enqueue(item.data);
			} finally {
				item.reservation?.release();
			}
		};
		const dReadable = new ReadableStream<Uint8Array>(
			{
				start(c) {
					datagramsController = c;
				},
				pull() {
					datagramPullPending = true;
					deliverDatagram();
				},
				cancel() {
					for (const item of pendingDatagrams) item.reservation?.release();
					pendingDatagrams.length = 0;
				},
			},
			new CountQueuingStrategy({ highWaterMark: 0 }),
		);

		session.onDatagram(
			(data, reservation) => {
				pendingDatagrams.push({ data, reservation });
				deliverDatagram();
			},
			{ retainReservation: true },
		);

		const dWritable = new WritableStream<Uint8Array>({
			// Promise settlement is the backpressure/error boundary. A false Rust
			// send result is translated by WasmSession into a stable rejecting error.
			write: (chunk) => session.sendDatagram(chunk),
		});

		this.datagrams = {
			readable: dReadable,
			writable: dWritable,
			createWritable() {
				return dWritable;
			},
			get maxDatagramSize() {
				return session.maxDatagramSize;
			},
		};

		// Incoming streams
		let bidiController!: ReadableStreamDefaultController<WebTransportBidirectionalStream>;
		let uniController!: ReadableStreamDefaultController<
			ReadableStream<Uint8Array>
		>;
		let bidiPullPending = false;
		let uniPullPending = false;
		const pendingBidi: WasmStream[] = [];
		const pendingUni: WasmStream[] = [];
		const deliverBidi = () => {
			if (!bidiPullPending || pendingBidi.length === 0) return;
			const stream = pendingBidi.shift();
			if (!stream) return;
			bidiPullPending = false;
			try {
				bidiController.enqueue(toBidi(stream));
			} catch {
				stream.stop(0);
				stream.reset(0);
			}
		};
		const deliverUni = () => {
			if (!uniPullPending || pendingUni.length === 0) return;
			const stream = pendingUni.shift();
			if (!stream) return;
			uniPullPending = false;
			try {
				uniController.enqueue(streamReadable(stream));
			} catch {
				stream.stop(0);
			}
		};

		let incomingStarted = false;
		const startIncoming = () => {
			if (incomingStarted) return;
			incomingStarted = true;
			session.onIncomingStream((stream) => {
				if (stream.bidi) {
					pendingBidi.push(stream);
					deliverBidi();
				} else {
					pendingUni.push(stream);
					deliverUni();
				}
			});
		};

		this.incomingBidirectionalStreams =
			new ReadableStream<WebTransportBidirectionalStream>(
				{
					start(c) {
						bidiController = c;
					},
					pull() {
						bidiPullPending = true;
						startIncoming();
						deliverBidi();
					},
					cancel() {
						for (const stream of pendingBidi) {
							stream.stop(0);
							stream.reset(0);
						}
						pendingBidi.length = 0;
					},
				},
				new CountQueuingStrategy({ highWaterMark: 0 }),
			);

		this.incomingUnidirectionalStreams = new ReadableStream<
			ReadableStream<Uint8Array>
		>(
			{
				start(c) {
					uniController = c;
				},
				pull() {
					uniPullPending = true;
					startIncoming();
					deliverUni();
				},
				cancel() {
					for (const stream of pendingUni) stream.stop(0);
					pendingUni.length = 0;
				},
			},
			new CountQueuingStrategy({ highWaterMark: 0 }),
		);

		this.closed
			.then(() => {
				for (const item of pendingDatagrams) item.reservation?.release();
				pendingDatagrams.length = 0;
				for (const stream of pendingBidi) {
					stream.stop(0);
					stream.reset(0);
				}
				pendingBidi.length = 0;
				for (const stream of pendingUni) stream.stop(0);
				pendingUni.length = 0;
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
			.catch((error: unknown) => {
				const err =
					error instanceof WebTransportError
						? error
						: new WebTransportError(E_SESSION_CLOSED, "Connection failed");
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
		// Match the native facade: draining settles when closing begins locally,
		// remotely, or because connection establishment failed.
		this.closed.then(this.resolveDraining, this.resolveDraining);
	}

	close(info?: WebTransportCloseInfo): void {
		this.resolveDraining();
		this.session.close({ code: info?.closeCode, reason: info?.reason });
	}

	/**
	 * W3C WebTransportConnectionStats subset. Wasm does not yet expose QUIC
	 * wire counters; returns zeros so `if (t.getStats)` consumers type-check
	 * without E_UNSUPPORTED throwers (honest-release C1/C2).
	 */
	async getStats(): Promise<{
		bytesSent: number;
		bytesReceived: number;
		packetsSent: number;
		packetsReceived: number;
	}> {
		return {
			bytesSent: 0,
			bytesReceived: 0,
			packetsSent: 0,
			packetsReceived: 0,
		};
	}

	async createBidirectionalStream(options?: {
		waitUntilAvailable?: boolean;
	}): Promise<WebTransportBidirectionalStream> {
		if (
			options?.waitUntilAvailable !== undefined &&
			typeof options.waitUntilAvailable !== "boolean"
		) {
			throw new WebTransportError(
				"E_INVALID_ARGUMENT",
				"waitUntilAvailable must be a boolean",
			);
		}
		// Wasm stream opens already observe governor/backpressure in WasmSession;
		// waitUntilAvailable=true is accepted for API parity (C3).
		return toBidi(this.session.createBidirectionalStream());
	}

	async createUnidirectionalStream(options?: {
		waitUntilAvailable?: boolean;
	}): Promise<WritableStream<Uint8Array>> {
		if (
			options?.waitUntilAvailable !== undefined &&
			typeof options.waitUntilAvailable !== "boolean"
		) {
			throw new WebTransportError(
				"E_INVALID_ARGUMENT",
				"waitUntilAvailable must be a boolean",
			);
		}
		return streamWritable(this.session.createUnidirectionalStream());
	}
}
