/**
 * Shared type declarations for WebTransport public + cross-backend API.
 */

/** W3C WebTransportCloseInfo shape used by native W3C facade. */
export type WebTransportCloseInfo = {
	closeCode?: number;
	reason?: string;
};

/** Internal/bridge close info used by shared contract helpers. */
export type CloseInfo = {
	code?: number;
	reason?: string;
};

/** Backend-agnostic stream surface for WHATWG-style adapters. */
export interface WtBidiStream {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

/** Minimal close information common to both backends. */
export interface WtCloseInfo {
	readonly code?: number;
	readonly reason?: string;
}

/** Optional connection stats (W3C-shaped subset). */
export type WebTransportLikeStats = {
	bytesSent: number;
	bytesReceived: number;
	packetsSent: number;
	packetsReceived: number;
};

/**
 * Declared members that a backend may omit. Runtime must match this set —
 * see `WEBTRANSPORT_LIKE_OPTIONAL` test.
 */
export const WEBTRANSPORT_LIKE_OPTIONAL = ["getStats"] as const;

/** The common WebTransport surface satisfied by both backends. */
export interface WebTransportLike {
	readonly ready: Promise<void>;
	readonly closed: Promise<WtCloseInfo>;
	close(info?: WtCloseInfo): void;
	sendDatagram(data: Uint8Array): Promise<void>;
	incomingDatagrams(): AsyncIterable<Uint8Array>;
	createBidirectionalStream(): Promise<WtBidiStream>;
	createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;
	incomingBidirectionalStreams(): AsyncIterable<WtBidiStream>;
	incomingUnidirectionalStreams(): AsyncIterable<ReadableStream<Uint8Array>>;
	/** Optional: present on native and wasm facades; check with `if (t.getStats)`. */
	getStats?(): Promise<WebTransportLikeStats>;
}

/**
 * Stable error-code union for WebTransport programmatic handling.
 * Defined here to serve both native and wasm/public layers.
 */
export type ErrorCode =
	| "E_TLS"
	| "E_HANDSHAKE_TIMEOUT"
	| "E_SESSION_CLOSED"
	| "E_SESSION_IDLE_TIMEOUT"
	| "E_STREAM_RESET"
	| "E_STOP_SENDING"
	| "E_QUEUE_FULL"
	| "E_BACKPRESSURE_TIMEOUT"
	| "E_LIMIT_EXCEEDED"
	| "E_RATE_LIMITED"
	| "E_INVALID_ARGUMENT"
	| "E_UNSUPPORTED_ARGUMENT"
	| "E_INTERNAL";

/** Shared native rate limits configured per endpoint/server. */
export type RateLimitOptions = {
	handshakesPerSec: number;
	handshakesBurst: number;
	/** Per /24 (IPv4) or /64 (IPv6) prefix; defaults 100 */
	handshakesBurstPerPrefix?: number;
	streamsPerSec: number;
	streamsBurst: number;
	datagramsPerSec: number;
	datagramsBurst: number;
};

/** Wasm-specific rate limit controls aligned to the wasm endpoint interface. */
export type WasmRateLimitOptions = {
	handshakesPerSec?: number;
	handshakesBurst?: number;
	streamOpensPerSec?: number;
	streamOpensBurst?: number;
	datagramsIngressPerSec?: number;
	datagramsIngressBurst?: number;
};

/** Wasm normalized rate limits mirrored from DEFAULT_WASM_RATE_LIMITS. */
export type WasmNormalizedRateLimits = {
	handshakesPerSec: number;
	handshakesBurst: number;
	streamOpensPerSec: number;
	streamOpensBurst: number;
	datagramsIngressPerSec: number;
	datagramsIngressBurst: number;
};

/**
 * Latency histogram snapshot (Prometheus histogram format). Duplicated here
 * (rather than imported from index.ts) so the wasm backend never pulls in
 * index.ts's eager native-addon load; keep in sync with index.ts's copy.
 */
export type HistogramSnapshot = {
	le: number[];
	cumulativeCount: number[];
	count: number;
	sumSecs: number;
};

/**
 * Aggregate metrics snapshot shape shared by the native and wasm backends.
 * See the note on {@link HistogramSnapshot} for why this is duplicated
 * rather than imported from index.ts.
 */
export type MetricsSnapshot = {
	nowMs: number;

	sessionsActive: number;
	sessionTasksActive: number;
	streamTasksActive: number;
	handshakesInFlight: number;
	streamsActive: number;

	datagramsIn: number;
	datagramsOut: number;
	datagramsDropped: number;

	queuedBytesGlobal: number;
	backpressureWaitCount: number;
	backpressureTimeoutCount: number;

	rateLimitedCount: number;
	limitExceededCount: number;
	sniCertSelections: number;
	defaultCertSelections: number;
	unknownSniRejectedCount: number;
	nativeSessionRegistryEntries?: number;
	nativeTrackedTasks?: number;
	nativeRateLimitEntries?: number;
	nativeBidiHandlesLive?: number;
	nativeUniSendHandlesLive?: number;
	nativeUniRecvHandlesLive?: number;

	handshakeLatency?: HistogramSnapshot | null;
	datagramEnqueueLatency?: HistogramSnapshot | null;
	streamOpenLatency?: HistogramSnapshot | null;
};

/** Per-session metrics snapshot shape shared by the native and wasm backends. */
export type SessionMetricsSnapshot = {
	datagramsIn: number;
	datagramsOut: number;
	streamsActive: number;
	queuedBytes: number;
};
