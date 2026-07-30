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
	E_BACKPRESSURE_TIMEOUT,
	E_INVALID_ARGUMENT,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	E_STREAM_RESET,
	WebTransportError,
} from "./errors.js";
import { SendScheduler, type SendPolicy } from "./send-scheduler.js";
import type { WebTransportCloseInfo } from "./types.js";
import {
	createW3CMappedError,
	normalizeW3CBrowserName,
	validateW3CClientOptions,
	type W3CClientOptionSurface,
	type W3CCongestionControl,
	type W3CDatagramsReadableType,
} from "./w3c-client-options.js";

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

/** Options for {@link WasmWebTransport} — W3C-shaped, validated loudly. */
export type WasmWebTransportOptions = W3CClientOptionSurface;

type StreamOpenOptions = {
	waitUntilAvailable?: boolean;
	sendOrder?: number;
	sendGroup?: WasmWebTransportSendGroup | null;
};

/** Minimal send-group handle for API parity with the native facade. */
export class WasmWebTransportSendGroup {
	constructor(
		private readonly transport: WasmWebTransport,
		private readonly id: number,
	) {}

	/** @internal */
	_getId(): number {
		return this.id;
	}

	/** @internal */
	_getTransport(): WasmWebTransport {
		return this.transport;
	}

	async getStats(): Promise<{
		bytesSent?: number;
		bytesAcknowledged?: number;
	}> {
		return this.transport._getSendGroupStats(this.id);
	}
}

function shouldRetryStreamOpen(err: unknown): boolean {
	if (!(err instanceof WebTransportError)) {
		const msg = err instanceof Error ? err.message : String(err);
		return (
			msg.includes(E_LIMIT_EXCEEDED) ||
			msg.includes(E_QUEUE_FULL) ||
			msg.includes(E_BACKPRESSURE_TIMEOUT)
		);
	}
	return (
		err.code === E_LIMIT_EXCEEDED ||
		err.code === E_QUEUE_FULL ||
		err.code === E_BACKPRESSURE_TIMEOUT
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openStreamWithWait<T>(
	openFn: () => T,
	options: StreamOpenOptions | undefined,
	backpressureTimeoutMs: number,
	isClosed: () => boolean,
	strictW3CErrors: boolean,
): Promise<T> {
	const wait = options?.waitUntilAvailable;
	if (wait !== undefined && typeof wait !== "boolean") {
		throw createW3CMappedError(
			E_INVALID_ARGUMENT,
			"waitUntilAvailable must be a boolean",
			strictW3CErrors,
		);
	}
	if (!wait) return openFn();

	const started = Date.now();
	let backoffMs = 2;
	while (true) {
		if (isClosed()) {
			throw new WebTransportError(E_SESSION_CLOSED);
		}
		try {
			return openFn();
		} catch (err) {
			if (!shouldRetryStreamOpen(err)) throw err;
			const elapsed = Date.now() - started;
			if (elapsed >= backpressureTimeoutMs) {
				throw new WebTransportError(
					E_BACKPRESSURE_TIMEOUT,
					`E_BACKPRESSURE_TIMEOUT: waitUntilAvailable timed out after ${backpressureTimeoutMs}ms`,
				);
			}
			const remaining = Math.max(1, backpressureTimeoutMs - elapsed);
			await sleep(Math.min(backoffMs, remaining));
			backoffMs = Math.min(backoffMs * 2, 50);
		}
	}
}

/**
 * Wrap a `WasmStream` as a WHATWG `ReadableStream` (enqueue on data, close on
 * fin, error on reset). When the consumer falls behind (desiredSize <= 0) the
 * wasm stream is paused so QUIC flow control throttles the sender; `pull`
 * resumes it.
 */
function streamReadable(
	stream: WasmStream,
	strictW3CErrors: boolean,
): ReadableStream<Uint8Array> {
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
							createW3CMappedError(
								E_STREAM_RESET,
								`${E_STREAM_RESET}: stream reset by peer (code ${code})`,
								strictW3CErrors,
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
function streamWritable(
	stream: WasmStream,
	scheduler?: SendScheduler,
	policy?: SendPolicy,
	onBytesSent?: (bytes: number) => void,
): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			const run = async () => {
				await stream.writeAll(chunk);
				onBytesSent?.(chunk.byteLength);
			};
			if (scheduler && policy) {
				return scheduler.enqueue(policy, run);
			}
			return run();
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

function toBidi(
	stream: WasmStream,
	strictW3CErrors: boolean,
	scheduler?: SendScheduler,
	policy?: SendPolicy,
	onBytesSent?: (bytes: number) => void,
): WebTransportBidirectionalStream {
	return {
		readable: streamReadable(stream, strictW3CErrors),
		writable: streamWritable(stream, scheduler, policy, onBytesSent),
	};
}

function createDatagramReadable(
	session: WasmSession,
	readableType: W3CDatagramsReadableType,
): {
	readable: ReadableStream<Uint8Array>;
	close: () => void;
	fail: (error: unknown) => void;
} {
	let datagramPullPending = false;
	const pendingDatagrams: Array<{
		data: Uint8Array;
		reservation?: WasmPayloadReservation;
	}> = [];
	let datagramsController:
		| ReadableStreamDefaultController<Uint8Array>
		| ReadableByteStreamController
		| null = null;

	const releasePending = () => {
		for (const item of pendingDatagrams) item.reservation?.release();
		pendingDatagrams.length = 0;
	};

	const deliverDatagram = () => {
		if (!datagramPullPending || pendingDatagrams.length === 0) return;
		const item = pendingDatagrams.shift();
		if (!item || !datagramsController) return;
		datagramPullPending = false;
		try {
			const byteController =
				datagramsController as ReadableByteStreamController;
			if (
				readableType === "bytes" &&
				byteController.byobRequest &&
				byteController.byobRequest.view
			) {
				const view = byteController.byobRequest.view as Uint8Array;
				if (view.byteLength < item.data.length) {
					item.reservation?.release();
					throw new RangeError("BYOB buffer smaller than datagram size");
				}
				view.set(item.data.subarray(0, item.data.length));
				byteController.byobRequest.respond(item.data.length);
				return;
			}
			datagramsController.enqueue(
				item.data as Uint8Array<ArrayBuffer> & ArrayBufferView<ArrayBuffer>,
			);
		} finally {
			item.reservation?.release();
		}
	};

	session.onDatagram(
		(data, reservation) => {
			pendingDatagrams.push({ data, reservation });
			try {
				deliverDatagram();
			} catch (error) {
				try {
					datagramsController?.error(error);
				} catch {}
			}
		},
		{ retainReservation: true },
	);

	const pull = (
		controller:
			| ReadableStreamDefaultController<Uint8Array>
			| ReadableByteStreamController,
	) => {
		datagramsController = controller;
		datagramPullPending = true;
		deliverDatagram();
	};

	const cancel = () => {
		releasePending();
	};

	// Bun's `UnderlyingSource` type doesn't model `type: "bytes"` sources (its
	// docs say the mode "is not currently supported"), and this package's
	// tsconfig omits the DOM lib that defines `UnderlyingByteSource`. Bun's
	// runtime does support it, so bypass the constructor's overloads here.
	const readable =
		readableType === "bytes"
			? new ReadableStream<Uint8Array>(
					{
						type: "bytes",
						pull,
						cancel,
					} as unknown as object,
					{ highWaterMark: 0 },
				)
			: new ReadableStream<Uint8Array>(
					{
						start(c: ReadableStreamDefaultController<Uint8Array>) {
							datagramsController = c;
						},
						pull,
						cancel,
					},
					new CountQueuingStrategy({ highWaterMark: 0 }),
				);

	return {
		readable,
		close() {
			releasePending();
			try {
				datagramsController?.close();
			} catch {}
		},
		fail(error: unknown) {
			releasePending();
			try {
				datagramsController?.error(error);
			} catch {}
		},
	};
}

/** Presents a `WasmSession` through the W3C `WebTransport` contract. */
export class WasmWebTransport {
	/** Static: QUIC/WebTransport always supports unreliable delivery. */
	static readonly supportsReliableOnly = false;

	readonly ready: Promise<void>;
	readonly closed: Promise<WebTransportCloseInfo>;
	readonly draining: Promise<undefined>;
	readonly datagrams: WebTransportDatagramDuplexStream;
	readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
	readonly incomingUnidirectionalStreams: ReadableStream<
		ReadableStream<Uint8Array>
	>;
	private resolveDraining!: () => void;
	readonly #congestionControl: W3CCongestionControl;
	readonly #strictW3CErrors: boolean;
	readonly #sendGroupBytes = new Map<number, number>();
	readonly #sendScheduler = new SendScheduler();
	#nextSendGroupId = 1;

	constructor(
		private readonly session: WasmSession,
		options: WasmWebTransportOptions = {},
	) {
		validateW3CClientOptions(options, options.strictW3CErrors);
		this.#congestionControl = options.congestionControl ?? "default";
		this.#strictW3CErrors = options.strictW3CErrors === true;
		const datagramsReadableType: W3CDatagramsReadableType =
			options.datagramsReadableType ?? "default";

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
				throw this.#mapError(err);
			});

		const datagrams = createDatagramReadable(session, datagramsReadableType);
		const self = this;
		const defaultPolicy: SendPolicy = { groupId: 0, sendOrder: 0 };
		const dWritable = createDatagramWritable(this, defaultPolicy);

		this.datagrams = {
			readable: datagrams.readable,
			writable: dWritable,
			createWritable(options?: {
				sendGroup?: unknown | null;
				sendOrder?: number;
			}) {
				const policy = self._resolveSendPolicy(options);
				return createDatagramWritable(self, policy);
			},
			get maxDatagramSize() {
				return session.maxDatagramSize;
			},
		};

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
				bidiController.enqueue(toBidi(stream, this.#strictW3CErrors));
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
				uniController.enqueue(streamReadable(stream, this.#strictW3CErrors));
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
				datagrams.close();
				for (const stream of pendingBidi) {
					stream.stop(0);
					stream.reset(0);
				}
				pendingBidi.length = 0;
				for (const stream of pendingUni) stream.stop(0);
				pendingUni.length = 0;
				try {
					bidiController.close();
				} catch {}
				try {
					uniController.close();
				} catch {}
			})
			.catch((error: unknown) => {
				const err = this.#mapError(error);
				datagrams.fail(err);
				try {
					bidiController.error(err);
				} catch {}
				try {
					uniController.error(err);
				} catch {}
			});
		// The peer's WT_DRAIN_SESSION is the real wire signal. The close-based
		// resolution stays as a fallback so a peer that never drains cannot
		// leave a consumer awaiting `draining` forever.
		session.draining.then(this.resolveDraining, this.resolveDraining);
		this.closed.then(this.resolveDraining, this.resolveDraining);
	}

	/** Effective congestion control mode (preference; wired in Phase 2 to quinn). */
	get congestionControl(): W3CCongestionControl {
		return this.#congestionControl;
	}

	createSendGroup(): WasmWebTransportSendGroup {
		return new WasmWebTransportSendGroup(this, this.#nextSendGroupId++);
	}

	/** @internal */
	_resolveSendPolicy(options?: {
		sendOrder?: number;
		sendGroup?: unknown | null;
	}): SendPolicy {
		const sendOrder = options?.sendOrder ?? 0;
		if (!Number.isInteger(sendOrder)) {
			throw new TypeError("sendOrder must be an integer");
		}
		let groupId = 0;
		if (options?.sendGroup != null) {
			if (!(options.sendGroup instanceof WasmWebTransportSendGroup)) {
				throw new DOMException(
					"sendGroup belongs to another transport",
					"InvalidStateError",
				);
			}
			if (options.sendGroup._getTransport() !== this) {
				throw new DOMException(
					"sendGroup belongs to another transport",
					"InvalidStateError",
				);
			}
			groupId = options.sendGroup._getId();
		}
		return { groupId, sendOrder };
	}

	/** @internal */
	_recordSendGroupBytes(groupId: number, bytes: number): void {
		this.#sendGroupBytes.set(
			groupId,
			(this.#sendGroupBytes.get(groupId) ?? 0) + bytes,
		);
	}

	/** @internal */
	_getSendGroupStats(id: number): {
		bytesSent?: number;
		bytesAcknowledged?: number;
	} {
		return { bytesSent: this.#sendGroupBytes.get(id) ?? 0 };
	}

	/** @internal */
	async _sendDatagramWithPolicy(
		chunk: Uint8Array,
		policy: SendPolicy,
	): Promise<void> {
		await this.#sendScheduler.enqueue(policy, async () => {
			await this.session.sendDatagram(chunk);
			this._recordSendGroupBytes(policy.groupId, chunk.byteLength);
		});
	}

	close(info?: WebTransportCloseInfo): void {
		this.resolveDraining();
		this.session.close({ code: info?.closeCode, reason: info?.reason });
	}

	/**
	 * W3C WebTransportConnectionStats subset backed by quinn Connection::stats.
	 */
	async getStats(): Promise<{
		bytesSent: number;
		bytesReceived: number;
		packetsSent: number;
		packetsReceived: number;
		datagrams: {
			droppedIncoming: number;
			expiredIncoming: number;
			expiredOutgoing: number;
			lostOutgoing: number;
		};
	}> {
		return this.session.connectionStats();
	}

	async createBidirectionalStream(
		options?: StreamOpenOptions,
	): Promise<WebTransportBidirectionalStream> {
		const policy = this._resolveSendPolicy(options);
		const stream = await openStreamWithWait(
			() => this.session.createBidirectionalStream(),
			options,
			this.session.backpressureTimeoutMs,
			() => this.session.isClosingOrClosed,
			this.#strictW3CErrors,
		);
		return toBidi(
			stream,
			this.#strictW3CErrors,
			this.#sendScheduler,
			policy,
			(bytes) => this._recordSendGroupBytes(policy.groupId, bytes),
		);
	}

	async createUnidirectionalStream(
		options?: StreamOpenOptions,
	): Promise<WritableStream<Uint8Array>> {
		const policy = this._resolveSendPolicy(options);
		const stream = await openStreamWithWait(
			() => this.session.createUnidirectionalStream(),
			options,
			this.session.backpressureTimeoutMs,
			() => this.session.isClosingOrClosed,
			this.#strictW3CErrors,
		);
		return streamWritable(stream, this.#sendScheduler, policy, (bytes) =>
			this._recordSendGroupBytes(policy.groupId, bytes),
		);
	}

	#mapError(error: unknown): WebTransportError {
		if (error instanceof WebTransportError) {
			if (!this.#strictW3CErrors) return error;
			const browserName = normalizeW3CBrowserName(error.code);
			if (!browserName || error.name === browserName) return error;
			return new WebTransportError(error.code, error.message, {
				browserName,
				source: error.source,
			});
		}
		return createW3CMappedError(
			E_SESSION_CLOSED,
			error instanceof Error ? error.message : String(error),
			this.#strictW3CErrors,
		);
	}
}

function createDatagramWritable(
	wt: WasmWebTransport,
	policy: SendPolicy,
): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		async write(chunk) {
			await wt._sendDatagramWithPolicy(chunk, policy);
		},
	});
}

/** Validate W3C options without constructing a session (parity selector tests). */
export function validateWasmWebTransportOptions(
	options: WasmWebTransportOptions = {},
): void {
	validateW3CClientOptions(options, options.strictW3CErrors);
}
