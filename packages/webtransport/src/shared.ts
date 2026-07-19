// Backend-agnostic WebTransport contract.
//
// Both the native (Node-API addon, via the W3C `WebTransport` class) and the
// wasm backend can be presented through this single interface so callers write
// one code path regardless of runtime. It is intentionally a PORTABLE SUBSET:
// it uses only WHATWG streams (ReadableStream/WritableStream) — never Node
// `Duplex`/`Readable`/`Writable` — so it is safe in browsers, Bun, and Node.
//
// This contract is additive: the native facade keeps its richer extras
// (send groups, getStats, metrics, cert rotation, Node-stream sessions). They
// are simply not part of the shared surface.

/** A bidirectional stream as a pair of WHATWG streams. */
export interface WtBidiStream {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

/** Minimal close information common to both backends. */
export interface WtCloseInfo {
	readonly code?: number;
	readonly reason?: string;
}

/**
 * The common WebTransport surface satisfied by both backends.
 *
 * Stream creation is async (Promise-returning) to match the native handshake/
 * flow-control wait; incoming streams and datagrams are async-iterables.
 */
export interface WebTransportLike {
	/** Resolves when the session is established; rejects if the connection
	 * fails or closes before establishment. */
	readonly ready: Promise<void>;
	/** Resolves (never rejects) with close info when the session ends. */
	readonly closed: Promise<WtCloseInfo>;

	/** Begin closing the session. */
	close(info?: WtCloseInfo): void;

	/** Send one datagram. Resolves once enqueued (or immediately for wasm). */
	sendDatagram(data: Uint8Array): Promise<void>;
	/** Async-iterate inbound datagrams. */
	incomingDatagrams(): AsyncIterable<Uint8Array>;

	/** Open a bidirectional stream. */
	createBidirectionalStream(): Promise<WtBidiStream>;
	/** Open a unidirectional (send-only) stream. */
	createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;

	/** Async-iterate bidirectional streams opened by the peer. */
	incomingBidirectionalStreams(): AsyncIterable<WtBidiStream>;
	/** Async-iterate unidirectional (receive-only) streams opened by the peer. */
	incomingUnidirectionalStreams(): AsyncIterable<ReadableStream<Uint8Array>>;
}
