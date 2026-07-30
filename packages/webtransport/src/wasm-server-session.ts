import type { WasmSession } from "./backend.js";
import {
	WasmWebTransport,
	type WasmWebTransportOptions,
	type WebTransportBidirectionalStream,
} from "./wasm-webtransport.js";

/** Stream-open options, kept identical to the W3C client surface. */
type PortableStreamOpenOptions = Parameters<
	WasmWebTransport["createBidirectionalStream"]
>[0];

/**
 * Server-session facade over {@link WasmSession}, shaped like the native
 * `ServerSession` so one server codebase runs on either backend.
 *
 * The W3C surface (streams, `incomingDatagrams`, `getStats`) is delegated to a
 * {@link WasmWebTransport} built over the same session, so client and server
 * behaviour cannot drift. That transport is created lazily: constructing one
 * subscribes the session's datagram callback, which would silently displace a
 * caller's own {@link onDatagram} handler.
 */
export class WasmServerSession {
	readonly #session: WasmSession;
	readonly #options: WasmWebTransportOptions;
	#wt: WasmWebTransport | null = null;
	#usedCallbacks = false;

	constructor(session: WasmSession, options: WasmWebTransportOptions = {}) {
		this.#session = session;
		this.#options = options;
	}

	/**
	 * The lazily-built W3C view. Mutually exclusive with the deprecated
	 * callback API, which owns the same single-slot session callbacks.
	 */
	#web(): WasmWebTransport {
		if (this.#usedCallbacks) {
			throw new Error(
				"WasmServerSession: the deprecated onDatagram/onIncomingStream callbacks and the W3C stream surface are mutually exclusive on one session — pick one",
			);
		}
		if (!this.#wt) {
			this.#wt = new WasmWebTransport(this.#session, this.#options);
		}
		return this.#wt;
	}

	#markCallbackUse(): void {
		if (this.#wt) {
			throw new Error(
				"WasmServerSession: the W3C stream surface is already in use on this session — the deprecated onDatagram/onIncomingStream callbacks cannot also be installed",
			);
		}
		this.#usedCallbacks = true;
	}

	/** Session id as a string, matching native `ServerSession.id`. */
	get id(): string {
		return String(this.#session.sessionId);
	}

	/** Remote address of the peer, matching native `ServerSession.peer`. */
	get peer(): { ip: string; port: number } {
		return this.#session.peer;
	}

	get ready(): Promise<void> {
		return this.#session.ready;
	}

	get closed(): Promise<{ code?: number; reason?: string }> {
		return this.#session.closed;
	}

	get maxDatagramSize(): number {
		return this.#session.maxDatagramSize;
	}

	get sessionId(): bigint {
		return this.#session.sessionId;
	}

	/** Underlying callback session. */
	unwrap(): WasmSession {
		return this.#session;
	}

	sendDatagram(data: Uint8Array): Promise<void> {
		return this.#session.sendDatagram(data);
	}

	/** Datagrams as an async iterable, matching native `incomingDatagrams()`. */
	incomingDatagrams(): AsyncIterable<Uint8Array> {
		const readable = this.#web().datagrams.readable;
		return {
			async *[Symbol.asyncIterator]() {
				const reader = readable.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) return;
						if (value) yield value;
					}
				} finally {
					reader.releaseLock();
				}
			},
		};
	}

	get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> {
		return this.#web().incomingBidirectionalStreams;
	}

	get incomingUnidirectionalStreams(): ReadableStream<
		ReadableStream<Uint8Array>
	> {
		return this.#web().incomingUnidirectionalStreams;
	}

	createBidirectionalStream(
		options?: PortableStreamOpenOptions,
	): Promise<WebTransportBidirectionalStream> {
		return this.#web().createBidirectionalStream(options);
	}

	createUnidirectionalStream(
		options?: PortableStreamOpenOptions,
	): Promise<WritableStream<Uint8Array>> {
		return this.#web().createUnidirectionalStream(options);
	}

	/** Quinn-backed connection counters, matching the W3C client `getStats()`. */
	getStats(): ReturnType<WasmWebTransport["getStats"]> {
		return this.#web().getStats();
	}

	/**
	 * @deprecated Use {@link incomingDatagrams} instead. Kept for the original
	 * callback-style wasm session API; cannot be combined with the W3C surface.
	 */
	onDatagram(
		cb: (data: Uint8Array, reservation?: { release(): void }) => void,
		options?: { retainReservation?: boolean },
	): void {
		this.#markCallbackUse();
		this.#session.onDatagram(cb, options);
	}

	/**
	 * @deprecated Use {@link incomingBidirectionalStreams} /
	 * {@link incomingUnidirectionalStreams} instead.
	 */
	onIncomingStream(
		cb: (stream: ReturnType<WasmSession["createBidirectionalStream"]>) => void,
	): void {
		this.#markCallbackUse();
		this.#session.onIncomingStream(cb);
	}

	metricsSnapshot(): {
		datagramsIn: number;
		datagramsOut: number;
		streamsActive: number;
		queuedBytes: number;
	} {
		return this.#session.metricsSnapshot();
	}

	close(info?: { code?: number; reason?: string }): void {
		this.#session.close(info);
	}

	drain(): void {
		this.#session.drain();
	}
}

/** Wrap an accepted wasm session as a ServerSession-like facade. */
export function toWasmServerSession(
	session: WasmSession,
	options?: WasmWebTransportOptions,
): WasmServerSession {
	return new WasmServerSession(session, options);
}
