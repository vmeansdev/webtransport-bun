/**
 * @packageDocumentation
 * @module @webtransport-bun/webtransport
 *
 * Production-ready WebTransport for Bun, backed by napi-rs + wtransport (Rust).
 * Supports in-process server, client (Node API and W3C-style facade), datagrams, and streams.
 */

if (!("Bun" in globalThis)) {
	throw new Error(
		"@webtransport-bun/webtransport requires Bun (>=1.3.9). See https://bun.sh",
	);
}

/**
 * @example Node client (connect)
 * ```ts
 * import { connect, createServer } from "@webtransport-bun/webtransport";
 * const session = await connect("https://127.0.0.1:4433", {
 *   tls: { insecureSkipVerify: true },
 *   limits: { handshakeTimeoutMs: 10_000 },
 * });
 * await session.sendDatagram(new Uint8Array([1, 2, 3]));
 * const stream = await session.createBidirectionalStream();
 * stream.write(Buffer.from("hello"));
 * stream.end();
 * session.close();
 * ```
 *
 * @example W3C-style client (new WebTransport)
 * ```ts
 * import { WebTransport, createServer } from "@webtransport-bun/webtransport";
 * const wt = new WebTransport("https://127.0.0.1:4433", {
 *   tls: { insecureSkipVerify: true },
 * });
 * await wt.ready;
 * const writer = wt.datagrams.writable.getWriter();
 * await writer.write(new Uint8Array([1, 2, 3]));
 * writer.releaseLock();
 * const { readable, writable } = await wt.createBidirectionalStream();
 * // ... use Web Streams ...
 * wt.close({ closeCode: 1000, reason: "done" });
 * ```
 *
 * @see docs/SPEC.md Authoritative API contract
 * @see docs/PARITY_MATRIX.md W3C spec alignment
 */

import type { Duplex, Readable, Writable } from "node:stream";

// Re-export stream symbols and helpers
export { WT_RESET, WT_STOP_SENDING } from "./streams.js";
export type { Resettable, StopSendable } from "./streams.js";

import {
	BidiStream,
	RecvStream,
	SendStream,
	WT_RESET,
	WT_STOP_SENDING,
	type Resettable,
	type StopSendable,
} from "./streams.js";

/**
 * Stable error codes. Use with {@link WebTransportError.code} for programmatic handling.
 * @see WebTransportError
 */
export {
	E_TLS,
	E_HANDSHAKE_TIMEOUT,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STREAM_RESET,
	E_STOP_SENDING,
	E_QUEUE_FULL,
	E_BACKPRESSURE_TIMEOUT,
	E_LIMIT_EXCEEDED,
	E_RATE_LIMITED,
	E_INTERNAL,
	WebTransportError,
} from "./errors.js";
export type {
	ErrorCode,
	WebTransportErrorOptions,
	WebTransportErrorSource,
} from "./errors.js";

import {
	E_INTERNAL,
	E_HANDSHAKE_TIMEOUT,
	E_SESSION_CLOSED,
	WebTransportError,
} from "./errors.js";
import type { ErrorCode } from "./errors.js";

/** Web IDL BufferSource (ArrayBuffer | ArrayBufferView) for spec alignment */
type BufferSource = ArrayBuffer | ArrayBufferView;

const E_CODE_RE = /E_[A-Z_]+/g;

/**
 * Maps known validation/connect failures to browser-style DOMException names.
 * Returns undefined for unknown cases; E_* code is always preserved.
 * No broad catch-all: unknown errors remain explicit.
 */
function normalizeToBrowserName(
	code: ErrorCode,
	message: string,
): string | undefined {
	if (
		message.includes(
			"serverCertificateHashes cannot be used with allowPooling=true",
		)
	) {
		return "NotSupportedError";
	}
	if (message.includes("serverCertificateHashes must be an array")) {
		return "TypeError";
	}
	if (
		message.includes("allowPooling must be a boolean") ||
		message.includes("requireUnreliable must be a boolean")
	) {
		return "TypeError";
	}
	if (
		message.includes("congestionControl must be") ||
		message.includes("datagramsReadableType must be")
	) {
		return "TypeError";
	}
	if (message.includes("E_HANDSHAKE_TIMEOUT")) {
		return "TimeoutError";
	}
	if (
		message.includes("E_SESSION_CLOSED") ||
		message.includes("E_SESSION_IDLE_TIMEOUT")
	) {
		return "InvalidStateError";
	}
	return undefined;
}

function toWebTransportError(
	err: unknown,
	strictW3CErrors?: boolean,
): WebTransportError {
	const msg = err instanceof Error ? err.message : String(err);
	const match = msg.match(E_CODE_RE);
	const code = match ? (match[0] as ErrorCode) : (E_INTERNAL as ErrorCode);
	const browserName =
		strictW3CErrors === true ? normalizeToBrowserName(code, msg) : undefined;
	return new WebTransportError(
		code,
		msg,
		browserName ? { browserName } : undefined,
	);
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

/** TLS configuration for server (cert/key) or client (CA, SNI). */
export type TlsOptions = {
	/** PEM-encoded certificate (server) or CA (client). */
	certPem: string | Uint8Array;
	/** PEM-encoded private key (server only). */
	keyPem: string | Uint8Array;
	/** Optional CA PEM for client verification. */
	caPem?: string | Uint8Array;
	/** SNI for client mode; for server, used in logs/metrics. */
	serverName?: string;
};

// ---------------------------------------------------------------------------
// Rate-limit options
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Resource limits. Merge with {@link DEFAULT_LIMITS} for defaults.
 * @see DEFAULT_LIMITS Default values (e.g. handshakeTimeoutMs: 10000, maxDatagramSize: 1200).
 */
export type LimitsOptions = {
	/** Max concurrent sessions. At limit, next handshake is rejected. */
	maxSessions: number;
	/** Max handshakes in progress. At limit, next is rejected (inclusive: limit is allowed). */
	maxHandshakesInFlight: number;
	/** Max bidi streams per session. At limit, createBidirectionalStream rejects with E_LIMIT_EXCEEDED. */
	maxStreamsPerSessionBidi: number;
	/** Max uni streams per session. At limit, createUnidirectionalStream rejects with E_LIMIT_EXCEEDED. */
	maxStreamsPerSessionUni: number;
	/** Max streams across all sessions. At limit, new streams (accept or create) are rejected. */
	maxStreamsGlobal: number;
	/** Hard cap in bytes (also must respect negotiated max). Default 1200. */
	maxDatagramSize: number;
	maxQueuedBytesGlobal: number;
	maxQueuedBytesPerSession: number;
	maxQueuedBytesPerStream: number;
	backpressureTimeoutMs: number;
	/** Connect handshake timeout. Default 10000. */
	handshakeTimeoutMs: number;
	idleTimeoutMs: number;
};

/** Default limit values from AGENTS.md */
export const DEFAULT_LIMITS: LimitsOptions = {
	maxSessions: 2000,
	maxHandshakesInFlight: 200,
	maxStreamsPerSessionBidi: 200,
	maxStreamsPerSessionUni: 200,
	maxStreamsGlobal: 50_000,
	maxDatagramSize: 1200,
	maxQueuedBytesGlobal: 512 * 1024 * 1024, // 512 MiB
	maxQueuedBytesPerSession: 2 * 1024 * 1024, // 2 MiB
	maxQueuedBytesPerStream: 256 * 1024, // 256 KiB
	backpressureTimeoutMs: 5000,
	handshakeTimeoutMs: 10_000,
	idleTimeoutMs: 60_000,
};

/** Default rate-limit values from AGENTS.md */
export const DEFAULT_RATE_LIMITS: RateLimitOptions = {
	handshakesPerSec: 20,
	handshakesBurst: 40,
	handshakesBurstPerPrefix: 100,
	streamsPerSec: 200,
	streamsBurst: 400,
	datagramsPerSec: 2000,
	datagramsBurst: 5000,
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Structured log event. Include sessionId, peerIp, peerPort, error code for incident diagnosis. */
export type LogEvent = {
	level: "debug" | "info" | "warn" | "error";
	msg: string;
	sessionId?: string;
	peerIp?: string;
	peerPort?: number;
	/** Error code (e.g. E_SESSION_CLOSED), counters context */
	data?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Server options & interface
// ---------------------------------------------------------------------------

/** Options for {@link createServer}. Limits/rateLimits merge with defaults. */
export type ServerOptions = {
	host?: string /** @default "0.0.0.0" */;
	port: number;
	tls: TlsOptions;
	limits?: Partial<LimitsOptions>;
	rateLimits?: Partial<RateLimitOptions>;

	/** Called on each accepted session (must not block; long work should be async) */
	onSession: (session: ServerSession) => void | Promise<void>;

	/** Optional logging hook */
	log?: (event: LogEvent) => void;

	/** Debug mode: enables detailed native diagnostics/log payloads (redaction off). */
	debug?: boolean;
};

/** Returned by {@link createServer}. Use address, close(), and metricsSnapshot(). */
export interface WebTransportServer {
	readonly address: { host: string; port: number };
	close(): Promise<void>;
	metricsSnapshot(): MetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Browser-style facade types (RFC_CLIENT_FACADE, PARITY_MATRIX)
// ---------------------------------------------------------------------------

/** Browser-style close info (W3C alignment). Used by {@link WebTransport.close} and {@link WebTransport.closed}. */
export type WebTransportCloseInfo = {
	closeCode?: number;
	reason?: string;
};

/**
 * Options for `new WebTransport(url, options)`.
 * `allowPooling` and `requireUnreliable` are accepted with deterministic facade semantics:
 * - `allowPooling`: when true, reuses pooled endpoints for compatible connects; when false, dedicated sessions.
 * - `requireUnreliable`: accepted; current runtime uses QUIC/WebTransport and always supports unreliable delivery.
 */
export type WebTransportClientOptions = {
	/** When true, errors use browser-style DOMException names (NotSupportedError, etc.). Default false for backward compat. */
	strictW3CErrors?: boolean;
	serverCertificateHashes?: Array<{
		algorithm: "sha-256";
		value: BufferSource;
	}>;
	allowPooling?: boolean;
	requireUnreliable?: boolean;
	/** Preference hint for congestion control. */
	congestionControl?: "default" | "throughput" | "low-latency";
	/** When "bytes", datagrams.readable is a ReadableByteStream with BYOB support; default uses normal ReadableStream. */
	datagramsReadableType?: "bytes" | "default";
	/** Bun backend extension */
	tls?: {
		insecureSkipVerify?: boolean;
		caPem?: string | Uint8Array;
		serverName?: string;
	};
	limits?: Partial<LimitsOptions>;
};

// ---------------------------------------------------------------------------
// Client options (Node API)
// ---------------------------------------------------------------------------

/** Options for {@link connect} (Node client API). */
export type ClientOptions = {
	tls?: {
		caPem?: string | Uint8Array;
		serverName?: string;
		/** Dev only: skips server cert verification. Requires explicit `true`. Emits warning. Never use in production. */
		insecureSkipVerify?: boolean;
	};
	limits?: Partial<LimitsOptions>;
	log?: (event: LogEvent) => void;
	/** Internal/advanced: cert pinning list serialized as base64. */
	serverCertificateHashes?: Array<{
		algorithm: "sha-256";
		valueBase64: string;
	}>;
	/** Internal/advanced: congestion hint passed to native runtime. */
	congestionControl?: "default" | "throughput" | "low-latency";
	/** Enable connection pooling for compatible connects. */
	allowPooling?: boolean;
	/** Require unreliable (datagram) delivery; participates in pool compatibility. */
	requireUnreliable?: boolean;
	/** When true, errors use browser-style DOMException names. Default false. */
	strictW3CErrors?: boolean;
};

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type CloseInfo = { code?: number; reason?: string };

export type WebTransportBidirectionalStream = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
} & Partial<Resettable & StopSendable>;

/** W3C WebTransportDatagramDuplexStream: readable, writable (compat), createWritable(), maxDatagramSize. */
export type WebTransportDatagramDuplexStream = {
	readonly readable: ReadableStream<Uint8Array>;
	/** Backward compat: default writable. Prefer createWritable() for multiple writers. */
	readonly writable: WritableStream<Uint8Array>;
	createWritable(options?: {
		sendGroup?: WebTransportSendGroup | null;
		sendOrder?: number;
	}): WritableStream<Uint8Array>;
	readonly maxDatagramSize: number;
};

/** W3C-style send group object used by sendOrder/sendGroup options. */
export class WebTransportSendGroup {
	readonly #transport: WebTransport;
	readonly #id: number;
	constructor(transport: WebTransport, id: number) {
		this.#transport = transport;
		this.#id = id;
	}
	_getTransport(): WebTransport {
		return this.#transport;
	}
	_getId(): number {
		return this.#id;
	}
	async getStats(): Promise<{
		bytesSent?: number;
		bytesAcknowledged?: number;
	}> {
		return this.#transport._getSendGroupStats(this.#id);
	}
}

export type WebTransportReceiveStream = ReadableStream<Uint8Array> &
	Partial<StopSendable>;

interface CommonSession {
	readonly id: string;
	readonly peer: { ip: string; port: number };

	readonly ready: Promise<void>;
	readonly closed: Promise<CloseInfo>;

	close(info?: CloseInfo): void;

	// Datagrams
	sendDatagram(data: Uint8Array): Promise<void>;
	incomingDatagrams(): AsyncIterable<Uint8Array>;
}

/** Server session surface used by createServer(onSession). */
export interface ServerSession extends CommonSession {
	readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
	readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;

	createBidirectionalStream(): Promise<Duplex>;
	createUnidirectionalStream(): Promise<Writable>;
	metricsSnapshot(): SessionMetricsSnapshot;
}

/** Node client API session surface returned by connect(). */
export interface ClientSession extends CommonSession {
	// Streams
	createBidirectionalStream(): Promise<Duplex>;
	incomingBidirectionalStreams(): AsyncIterable<Duplex>;

	createUnidirectionalStream(): Promise<Writable>;
	incomingUnidirectionalStreams(): AsyncIterable<Readable>;

	// Metrics (per session)
	metricsSnapshot(): SessionMetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Latency histogram snapshot (Prometheus histogram format). */
export type HistogramSnapshot = {
	le: number[];
	cumulativeCount: number[];
	count: number;
	sumSecs: number;
};

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

	/** Handshake latency (accept start to completion). P99 target &lt;300ms. */
	handshakeLatency?: HistogramSnapshot | null;
	/** Datagram send enqueue latency. P99 target &lt;10ms. */
	datagramEnqueueLatency?: HistogramSnapshot | null;
	/** Stream open latency (createBidi/createUni). P99 target &lt;20ms. */
	streamOpenLatency?: HistogramSnapshot | null;
};

export type SessionMetricsSnapshot = {
	datagramsIn: number;
	datagramsOut: number;
	streamsActive: number;
	queuedBytes: number;
};

/** W3C WebTransportConnectionStats shape. Unavailable stats are omitted. */
export type WebTransportConnectionStats = {
	datagrams: {
		droppedIncoming: number;
		expiredIncoming: number;
		expiredOutgoing: number;
		lostOutgoing: number;
	};
	bytesSent?: number;
	bytesSentOverhead?: number;
	bytesAcknowledged?: number;
	packetsSent?: number;
	bytesLost?: number;
	packetsLost?: number;
	bytesReceived?: number;
	packetsReceived?: number;
	smoothedRtt?: number;
	rttVariation?: number;
	minRtt?: number;
	estimatedSendRate?: number | null;
	atSendCapacity?: boolean;
};

/** Prometheus metric name prefix. Override via env WEBTRANSPORT_METRICS_PREFIX. */
export const METRICS_PREFIX =
	process.env.WEBTRANSPORT_METRICS_PREFIX ?? "webtransport_";

function shouldSuppressInsecureSkipVerifyWarning(): boolean {
	const v = process.env.WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN;
	return v === "1" || v === "true" || v === "yes";
}

function escapePromLabelValue(v: unknown): string {
	return String(v)
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/"/g, '\\"');
}

function sanitizePromLabelName(k: string): string {
	const safe = k.replace(/[^a-zA-Z0-9_]/g, "_");
	return /^[a-zA-Z_]/.test(safe) ? safe : `_${safe}`;
}

/**
 * Convert MetricsSnapshot to Prometheus exposition format (text).
 * Gauges: sessions_active, handshakes_in_flight, streams_active, session_tasks_active, stream_tasks_active, queued_bytes_global.
 * Counters: datagrams_in, datagrams_out, datagrams_dropped, backpressure_wait_total, backpressure_timeout_total, rate_limited_total, limit_exceeded_total.
 *
 * @example
 * ```ts
 * const snapshot = server.metricsSnapshot();
 * const text = metricsToPrometheus(snapshot, { serverId: "main" });
 * response.end(text); // Content-Type: text/plain; version=0.0.4
 * ```
 */
export function metricsToPrometheus(
	m: MetricsSnapshot,
	labels?: Record<string, string>,
): string {
	const baseLabels = labels
		? Object.entries(labels)
				.map(
					([k, v]) =>
						`${sanitizePromLabelName(k)}="${escapePromLabelValue(v)}"`,
				)
				.join(",")
		: "";
	const metricLabels = baseLabels ? `{${baseLabels}}` : "";
	const p = METRICS_PREFIX;
	const lines: string[] = [
		`# HELP ${p}sessions_active Current open sessions`,
		`# TYPE ${p}sessions_active gauge`,
		`${p}sessions_active${metricLabels} ${m.sessionsActive}`,
		`# HELP ${p}handshakes_in_flight Handshakes in progress`,
		`# TYPE ${p}handshakes_in_flight gauge`,
		`${p}handshakes_in_flight${metricLabels} ${m.handshakesInFlight}`,
		`# HELP ${p}streams_active Active streams`,
		`# TYPE ${p}streams_active gauge`,
		`${p}streams_active${metricLabels} ${m.streamsActive}`,
		`# HELP ${p}session_tasks_active Internal session tasks`,
		`# TYPE ${p}session_tasks_active gauge`,
		`${p}session_tasks_active${metricLabels} ${m.sessionTasksActive}`,
		`# HELP ${p}stream_tasks_active Internal stream tasks`,
		`# TYPE ${p}stream_tasks_active gauge`,
		`${p}stream_tasks_active${metricLabels} ${m.streamTasksActive}`,
		`# HELP ${p}queued_bytes_global Bytes queued globally`,
		`# TYPE ${p}queued_bytes_global gauge`,
		`${p}queued_bytes_global${metricLabels} ${m.queuedBytesGlobal}`,
		`# HELP ${p}datagrams_in Datagrams received`,
		`# TYPE ${p}datagrams_in counter`,
		`${p}datagrams_in${metricLabels} ${m.datagramsIn}`,
		`# HELP ${p}datagrams_out Datagrams sent`,
		`# TYPE ${p}datagrams_out counter`,
		`${p}datagrams_out${metricLabels} ${m.datagramsOut}`,
		`# HELP ${p}datagrams_dropped Datagrams dropped`,
		`# TYPE ${p}datagrams_dropped counter`,
		`${p}datagrams_dropped${metricLabels} ${m.datagramsDropped}`,
		`# HELP ${p}backpressure_wait_total Times senders waited on backpressure`,
		`# TYPE ${p}backpressure_wait_total counter`,
		`${p}backpressure_wait_total${metricLabels} ${m.backpressureWaitCount}`,
		`# HELP ${p}backpressure_timeout_total Times backpressure timeout fired`,
		`# TYPE ${p}backpressure_timeout_total counter`,
		`${p}backpressure_timeout_total${metricLabels} ${m.backpressureTimeoutCount}`,
		`# HELP ${p}rate_limited_total Sessions rejected by rate limit`,
		`# TYPE ${p}rate_limited_total counter`,
		`${p}rate_limited_total${metricLabels} ${m.rateLimitedCount}`,
		`# HELP ${p}limit_exceeded_total Sessions rejected (limits)`,
		`# TYPE ${p}limit_exceeded_total counter`,
		`${p}limit_exceeded_total${metricLabels} ${m.limitExceededCount}`,
	];

	function emitHistogram(
		name: string,
		h: HistogramSnapshot | null | undefined,
	): void {
		if (!h) return;
		const raw = h as Record<string, unknown>;
		const le = (raw.le ?? []) as number[];
		const cumulativeCount = (raw.cumulativeCount ??
			raw.cumulative_count ??
			[]) as number[];
		const count = (raw.count ?? 0) as number;
		const sumSecs = (raw.sumSecs ?? raw.sum_secs ?? 0) as number;
		const bn = `${p}${name}`;
		lines.push(`# HELP ${bn}_seconds Latency histogram (seconds)`);
		lines.push(`# TYPE ${bn}_seconds histogram`);
		for (let i = 0; i < le.length; i++) {
			const v = le[i];
			const leVal =
				v === Infinity || v === undefined || v >= 1e308 ? "+Inf" : String(v);
			const bucketLabels = baseLabels
				? `{le="${leVal}",${baseLabels}}`
				: `{le="${leVal}"}`;
			lines.push(
				`${bn}_seconds_bucket${bucketLabels} ${Math.round(cumulativeCount[i] ?? 0)}`,
			);
		}
		const infBucketLabels = baseLabels
			? `{le="+Inf",${baseLabels}}`
			: `{le="+Inf"}`;
		lines.push(`${bn}_seconds_bucket${infBucketLabels} ${Math.round(count)}`);
		lines.push(`${bn}_seconds_count${metricLabels} ${Math.round(count)}`);
		lines.push(`${bn}_seconds_sum${metricLabels} ${sumSecs}`);
	}
	const mAny = m as Record<string, unknown>;
	emitHistogram(
		"handshake_latency",
		(mAny.handshakeLatency ?? mAny.handshake_latency) as
			| HistogramSnapshot
			| null
			| undefined,
	);
	emitHistogram(
		"datagram_enqueue_latency",
		(mAny.datagramEnqueueLatency ?? mAny.datagram_enqueue_latency) as
			| HistogramSnapshot
			| null
			| undefined,
	);
	emitHistogram(
		"stream_open_latency",
		(mAny.streamOpenLatency ?? mAny.stream_open_latency) as
			| HistogramSnapshot
			| null
			| undefined,
	);

	return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Native addon loader
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const PLATFORM = process.platform;
const ARCH = process.arch;
let native: any;
const binaryCandidates = [
	`webtransport-native.${PLATFORM}-${ARCH}.node`,
	`webtransport-native.${PLATFORM}-${ARCH}-gnu.node`,
	`webtransport-native.${PLATFORM}-${ARCH}-musl.node`,
];
const basePaths = ["../../../crates/native", "../prebuilds"];
for (const base of basePaths) {
	for (const candidate of binaryCandidates) {
		try {
			native = _require(`${base}/${candidate}`);
			break;
		} catch {
			continue;
		}
	}
	if (native) break;
}

// ---------------------------------------------------------------------------
// Server session implementation
// ---------------------------------------------------------------------------

class NativeServerSession implements ServerSession {
	#nativeHandle: any;
	#closedPromise: Promise<CloseInfo>;
	#closed = false;
	#incomingBidiCache: ReadableStream<WebTransportBidirectionalStream> | null =
		null;
	#incomingUniCache: ReadableStream<WebTransportReceiveStream> | null = null;

	constructor(nativeHandle: any, closedPromise: Promise<CloseInfo>) {
		this.#nativeHandle = nativeHandle;
		this.#closedPromise = closedPromise;
		this.#closedPromise.then(() => {
			this.#closed = true;
		});
	}

	get id(): string {
		return this.#nativeHandle.id;
	}

	get peer(): { ip: string; port: number } {
		return {
			ip: this.#nativeHandle.peerIp,
			port: this.#nativeHandle.peerPort,
		};
	}

	get ready(): Promise<void> {
		// Server sessions are already handshake-complete when onSession fires
		return Promise.resolve();
	}

	get closed(): Promise<CloseInfo> {
		return this.#closedPromise;
	}

	close(info?: CloseInfo): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#nativeHandle.close(info?.code ?? null, info?.reason ?? null);
		}
	}

	async sendDatagram(data: Uint8Array): Promise<void> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			await this.#nativeHandle.sendDatagram(buf);
		} catch (err) {
			throw toWebTransportError(err);
		}
	}

	async *incomingDatagrams(): AsyncIterable<Uint8Array> {
		while (!this.#closed) {
			try {
				const datagram = await this.#nativeHandle.readDatagram();
				if (!datagram) break;
				yield datagram;
			} catch {
				break;
			}
		}
	}

	async createBidirectionalStream(): Promise<Duplex> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = await this.#nativeHandle.createBidiStream();
			return new BidiStream({
				handleId: nativeStream?.id ?? 0,
				nativeHandle: nativeStream,
			});
		} catch (err) {
			throw toWebTransportError(err);
		}
	}

	get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> {
		if (!this.#incomingBidiCache) {
			this.#incomingBidiCache = createServerIncomingBidiStreams(
				this.#nativeHandle,
				() => this.#closed,
			);
		}
		return this.#incomingBidiCache;
	}

	async createUnidirectionalStream(): Promise<Writable> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = await this.#nativeHandle.createUniStream();
			return new SendStream({
				handleId: nativeStream?.id ?? 0,
				nativeHandle: nativeStream,
			});
		} catch (err) {
			throw toWebTransportError(err);
		}
	}

	get incomingUnidirectionalStreams(): ReadableStream<WebTransportReceiveStream> {
		if (!this.#incomingUniCache) {
			this.#incomingUniCache = createServerIncomingUniStreams(
				this.#nativeHandle,
				() => this.#closed,
			);
		}
		return this.#incomingUniCache;
	}

	metricsSnapshot(): SessionMetricsSnapshot {
		return this.#nativeHandle.metricsSnapshot();
	}
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

/**
 * Create an in-process WebTransport server.
 *
 * @param opts - Server configuration. Requires `port`, `tls` (certPem, keyPem), and `onSession` callback.
 * @returns WebTransportServer with `address`, `close()`, and `metricsSnapshot()`.
 * @throws Error if native addon is not loaded.
 *
 * @example
 * ```ts
 * const server = createServer({
 *   port: 4433,
 *   tls: { certPem: "...", keyPem: "..." },
 *   onSession: async (session) => {
 *     for await (const d of session.incomingDatagrams()) {
 *       await session.sendDatagram(d);
 *     }
 *   },
 * });
 * // server.address.port
 * await server.close();
 * ```
 */
export function createServer(opts: ServerOptions): WebTransportServer {
	if (!native) {
		throw new Error("Native addon not loaded");
	}

	const certPem =
		typeof opts.tls.certPem === "string"
			? opts.tls.certPem
			: new TextDecoder().decode(opts.tls.certPem);
	const keyPem =
		typeof opts.tls.keyPem === "string"
			? opts.tls.keyPem
			: new TextDecoder().decode(opts.tls.keyPem);
	const caPem =
		typeof opts.tls.caPem === "string"
			? opts.tls.caPem
			: opts.tls.caPem != null
				? new TextDecoder().decode(opts.tls.caPem)
				: "";

	const limitsJson = JSON.stringify({ ...DEFAULT_LIMITS, ...opts.limits });
	const rateLimitsJson = JSON.stringify({
		...DEFAULT_RATE_LIMITS,
		...opts.rateLimits,
	});

	const closedResolvers = new Map<string, (info: CloseInfo) => void>();
	let activeOnSessionCallbacks = 0;
	let onSessionDrainResolve: (() => void) | null = null;

	const logCallback = (logEvents: any[]) => {
		if (opts.log) {
			for (const le of logEvents) {
				opts.log({
					level: le.level ?? "info",
					msg: le.msg ?? "",
					sessionId: le.sessionId,
					peerIp: le.peerIp,
					peerPort: le.peerPort,
				});
			}
		}
	};

	const handle = new native.ServerHandle(
		opts.port,
		opts.host ?? "0.0.0.0",
		opts.debug === true,
		certPem,
		keyPem,
		caPem,
		limitsJson,
		rateLimitsJson,
		(events: any[]) => {
			for (const evt of events) {
				if (
					evt.name === "session" &&
					evt.id != null &&
					evt.peerIp != null &&
					evt.peerPort != null
				) {
					let closedResolve!: (info: CloseInfo) => void;
					const closedPromise = new Promise<CloseInfo>((resolve) => {
						closedResolve = resolve;
					});
					closedResolvers.set(evt.id, closedResolve);
					const nativeSession = new native.SessionHandle(
						evt.id,
						evt.peerIp,
						evt.peerPort,
					);
					const session = new NativeServerSession(nativeSession, closedPromise);
					activeOnSessionCallbacks++;
					const maybePromise = opts.onSession(session);
					if (maybePromise && typeof maybePromise.then === "function") {
						maybePromise.then(onSessionCallbackDone, onSessionCallbackDone);
					} else {
						onSessionCallbackDone();
					}
				} else if (evt.name === "session_closed" && evt.id != null) {
					const resolve = closedResolvers.get(evt.id);
					closedResolvers.delete(evt.id);
					if (resolve) resolve({ code: evt.code, reason: evt.reason });
				}
			}
		},
		logCallback,
	);

	function onSessionCallbackDone() {
		activeOnSessionCallbacks--;
		if (activeOnSessionCallbacks <= 0 && onSessionDrainResolve) {
			onSessionDrainResolve();
			onSessionDrainResolve = null;
		}
	}

	return {
		address: { host: opts.host ?? "0.0.0.0", port: handle.port },
		close: async () => {
			await handle.close();
			for (const [id, resolve] of closedResolvers) {
				closedResolvers.delete(id);
				resolve({ code: 0, reason: "server closed" });
			}
			if (activeOnSessionCallbacks > 0) {
				await Promise.race([
					new Promise<void>((r) => {
						onSessionDrainResolve = r;
					}),
					new Promise<void>((r) => setTimeout(r, 5000)),
				]);
			}
		},
		metricsSnapshot: () => handle.metricsSnapshot(),
	};
}

// ---------------------------------------------------------------------------
// Client session implementation
// ---------------------------------------------------------------------------

class NativeClientSession implements ClientSession {
	#nativeHandle: any;
	#readyPromise: Promise<void>;
	#closedPromise: Promise<CloseInfo>;
	#closed = false;
	#strictW3CErrors: boolean;

	constructor(
		nativeHandle: any,
		readyPromise: Promise<void>,
		closedPromise: Promise<CloseInfo>,
		strictW3CErrors = false,
	) {
		this.#nativeHandle = nativeHandle;
		this.#readyPromise = readyPromise;
		this.#closedPromise = closedPromise;
		this.#strictW3CErrors = strictW3CErrors;
		this.#closedPromise.then(() => {
			this.#closed = true;
		});
	}

	get id(): string {
		return this.#nativeHandle.id;
	}

	get peer(): { ip: string; port: number } {
		return {
			ip: this.#nativeHandle.peerIp,
			port: this.#nativeHandle.peerPort,
		};
	}

	get ready(): Promise<void> {
		return this.#readyPromise;
	}

	get closed(): Promise<CloseInfo> {
		return this.#closedPromise;
	}

	close(info?: CloseInfo): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#nativeHandle.close(info?.code ?? null, info?.reason ?? null);
		}
	}

	async sendDatagram(data: Uint8Array): Promise<void> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			await this.#nativeHandle.sendDatagram(buf);
		} catch (err) {
			throw toWebTransportError(err, this.#strictW3CErrors);
		}
	}

	async *incomingDatagrams(): AsyncIterable<Uint8Array> {
		while (!this.#closed) {
			try {
				const dgram = await this.#nativeHandle.readDatagram();
				if (!dgram) break;
				yield dgram;
			} catch {
				break;
			}
		}
	}

	async createBidirectionalStream(): Promise<Duplex> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = await this.#nativeHandle.createBidiStream();
			return new BidiStream({
				handleId: nativeStream?.id ?? 0,
				nativeHandle: nativeStream,
			});
		} catch (err) {
			throw toWebTransportError(err, this.#strictW3CErrors);
		}
	}

	async *incomingBidirectionalStreams(): AsyncIterable<Duplex> {
		while (!this.#closed) {
			try {
				const nativeStream = await this.#nativeHandle.acceptBidiStream();
				if (!nativeStream) break;
				yield new BidiStream({
					handleId: nativeStream?.id ?? 0,
					nativeHandle: nativeStream,
				});
			} catch {
				break;
			}
		}
	}

	async createUnidirectionalStream(): Promise<Writable> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = await this.#nativeHandle.createUniStream();
			return new SendStream({
				handleId: nativeStream?.id ?? 0,
				nativeHandle: nativeStream,
			});
		} catch (err) {
			throw toWebTransportError(err, this.#strictW3CErrors);
		}
	}

	async *incomingUnidirectionalStreams(): AsyncIterable<Readable> {
		while (!this.#closed) {
			try {
				const nativeStream = await this.#nativeHandle.acceptUniStream();
				if (!nativeStream) break;
				yield new RecvStream({
					handleId: nativeStream?.id ?? 0,
					nativeHandle: nativeStream,
				});
			} catch {
				break;
			}
		}
	}

	metricsSnapshot(): SessionMetricsSnapshot {
		return this.#nativeHandle.metricsSnapshot();
	}
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

/**
 * Connect to a WebTransport server (Node API).
 *
 * @param url - WebTransport URL (e.g. `https://host:port/path`).
 * @param opts - Optional TLS, limits, and logging. Limits default per {@link DEFAULT_LIMITS}.
 *   Use `tls.insecureSkipVerify: true` only for dev; emits a warning.
 * @returns Promise that resolves to ClientSession when handshake completes.
 * @throws WebTransportError with code `E_HANDSHAKE_TIMEOUT` if handshake exceeds `limits.handshakeTimeoutMs` (default 10s).
 * @throws WebTransportError with code `E_TLS` on TLS failure.
 *
 * @example
 * ```ts
 * const session = await connect("https://127.0.0.1:4433", {
 *   tls: { insecureSkipVerify: true },
 *   limits: { handshakeTimeoutMs: 5000 },
 * });
 * await session.ready;
 * await session.sendDatagram(new Uint8Array([1, 2, 3]));
 * session.close({ code: 1000, reason: "done" });
 * ```
 */
export async function connect(
	url: string,
	opts?: ClientOptions,
): Promise<ClientSession> {
	if (!native) {
		throw new Error("Native addon not loaded");
	}
	if (
		opts?.tls?.insecureSkipVerify === true &&
		(opts.log !== undefined || !shouldSuppressInsecureSkipVerifyWarning())
	) {
		const log =
			opts.log ??
			((e: LogEvent) => console.warn(`[webtransport] ${e.level}: ${e.msg}`));
		log({
			level: "warn",
			msg: "tls.insecureSkipVerify is enabled — dev only, never use in production",
		});
	}

	const mergedLimits = { ...DEFAULT_LIMITS, ...opts?.limits };
	const tlsOpts = opts?.tls
		? {
				insecureSkipVerify: opts.tls.insecureSkipVerify ?? false,
				caPem: opts.tls.caPem
					? typeof opts.tls.caPem === "string"
						? opts.tls.caPem
						: new TextDecoder().decode(opts.tls.caPem)
					: undefined,
				serverName: opts.tls.serverName,
			}
		: undefined;
	const optsJson = JSON.stringify({
		limits: mergedLimits,
		tls: tlsOpts,
		congestionControl: opts?.congestionControl,
		serverCertificateHashes: opts?.serverCertificateHashes,
		allowPooling: opts?.allowPooling,
		requireUnreliable: opts?.requireUnreliable,
	});

	const handshakeTimeout = mergedLimits.handshakeTimeoutMs;

	const connectPromise = new Promise<ClientSession>((resolve, reject) => {
		const closedResolvers = new Map<string, (info: CloseInfo) => void>();
		const onClosed = (events: any[]) => {
			for (const evt of events) {
				if (evt.name === "session_closed" && evt.id != null) {
					const resolveClosed = closedResolvers.get(evt.id);
					closedResolvers.delete(evt.id);
					if (resolveClosed)
						resolveClosed({ code: evt.code, reason: evt.reason });
				}
			}
		};
		native.connect(url, optsJson, onClosed, (err: any, handleId?: string) => {
			if (err) {
				reject(toWebTransportError(err, opts?.strictW3CErrors));
				return;
			}
			if (handleId == null) {
				reject(new Error("connect succeeded but no handle id"));
				return;
			}
			const handle = native.takeClientSession(handleId);
			if (!handle) {
				reject(new Error("connect: handle not found in registry"));
				return;
			}
			let closedResolve!: (info: CloseInfo) => void;
			const closedPromise = new Promise<CloseInfo>((r) => {
				closedResolve = r;
			});
			closedResolvers.set(handle.id, closedResolve);
			const readyPromise = Promise.resolve();
			resolve(
				new NativeClientSession(
					handle,
					readyPromise,
					closedPromise,
					opts?.strictW3CErrors,
				),
			);
		});
	});

	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => {
			const msg = `E_HANDSHAKE_TIMEOUT: connect timed out after ${handshakeTimeout}ms`;
			const browserName =
				opts?.strictW3CErrors === true
					? (normalizeToBrowserName(E_HANDSHAKE_TIMEOUT as ErrorCode, msg) ??
						undefined)
					: undefined;
			reject(
				new WebTransportError(
					E_HANDSHAKE_TIMEOUT as ErrorCode,
					msg,
					browserName ? { browserName } : undefined,
				),
			);
		}, handshakeTimeout);
	});

	return Promise.race([connectPromise, timeoutPromise]);
}

/** Client pool metrics (hits, misses, evictions). For tests when allowPooling is used. */
export function clientPoolMetricsSnapshot(): {
	hits: number;
	misses: number;
	evictIdle: number;
	evictBroken: number;
} {
	if (!native) throw new Error("Native addon not loaded");
	const s = native.clientPoolMetricsSnapshot();
	return {
		hits: s.hits,
		misses: s.misses,
		evictIdle: (s as any).evictIdle ?? (s as any).evict_idle ?? 0,
		evictBroken: (s as any).evictBroken ?? (s as any).evict_broken ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Browser-style WebTransport facade (Phase P1)
// ---------------------------------------------------------------------------

function validateServerCertificateHashes(
	arr: Array<{ algorithm: string; value: BufferSource }>,
): void {
	for (const entry of arr) {
		if (entry.algorithm !== "sha-256") {
			throw new WebTransportError(
				E_INTERNAL as ErrorCode,
				`E_INTERNAL: serverCertificateHashes only supports algorithm "sha-256", got "${entry.algorithm}"`,
			);
		}
		if (
			entry.value == null ||
			(typeof entry.value === "object" &&
				"byteLength" in entry &&
				entry.byteLength === 0)
		) {
			throw new WebTransportError(
				E_INTERNAL as ErrorCode,
				"E_INTERNAL: serverCertificateHashes entry value must be non-empty BufferSource",
			);
		}
	}
}

function bufferSourceToUint8(value: BufferSource): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	throw new WebTransportError(
		E_INTERNAL as ErrorCode,
		"E_INTERNAL: serverCertificateHashes entry value must be BufferSource",
	);
}

function bufferSourceToBase64(value: BufferSource): string {
	return Buffer.from(bufferSourceToUint8(value)).toString("base64");
}

const VALID_CONGESTION = new Set(["default", "throughput", "low-latency"]);
const VALID_DATAGRAMS_READABLE_TYPE = new Set(["bytes", "default"]);

function validateClientOptions(opts?: WebTransportClientOptions): void {
	if (!opts) return;
	if (
		opts.allowPooling !== undefined &&
		typeof opts.allowPooling !== "boolean"
	) {
		throw new WebTransportError(
			E_INTERNAL as ErrorCode,
			"E_INTERNAL: allowPooling must be a boolean",
		);
	}
	if (
		opts.requireUnreliable !== undefined &&
		typeof opts.requireUnreliable !== "boolean"
	) {
		throw new WebTransportError(
			E_INTERNAL as ErrorCode,
			"E_INTERNAL: requireUnreliable must be a boolean",
		);
	}
	if (
		opts.congestionControl !== undefined &&
		!VALID_CONGESTION.has(opts.congestionControl)
	) {
		throw new WebTransportError(
			E_INTERNAL as ErrorCode,
			`E_INTERNAL: congestionControl must be "default", "throughput", or "low-latency", got "${opts.congestionControl}"`,
		);
	}
	if (
		opts.datagramsReadableType !== undefined &&
		!VALID_DATAGRAMS_READABLE_TYPE.has(opts.datagramsReadableType)
	) {
		throw new WebTransportError(
			E_INTERNAL as ErrorCode,
			`E_INTERNAL: datagramsReadableType must be "bytes" or "default", got "${opts.datagramsReadableType}"`,
		);
	}
	if (opts.serverCertificateHashes !== undefined) {
		if (!Array.isArray(opts.serverCertificateHashes)) {
			throw new WebTransportError(
				E_INTERNAL as ErrorCode,
				"E_INTERNAL: serverCertificateHashes must be an array",
			);
		}
		if (opts.allowPooling === true) {
			throw new WebTransportError(
				E_INTERNAL as ErrorCode,
				"E_INTERNAL: serverCertificateHashes cannot be used with allowPooling=true",
				{ browserName: "NotSupportedError" },
			);
		}
		validateServerCertificateHashes(opts.serverCertificateHashes);
	}
}

function mapToClientOptions(opts?: WebTransportClientOptions): ClientOptions {
	if (!opts) return {};
	validateClientOptions(opts);
	return {
		tls: opts.tls,
		limits: opts.limits,
		congestionControl: opts.congestionControl,
		strictW3CErrors: opts.strictW3CErrors,
		serverCertificateHashes: opts.serverCertificateHashes?.map((entry) => ({
			algorithm: entry.algorithm,
			valueBase64: bufferSourceToBase64(entry.value),
		})),
		allowPooling: opts.allowPooling,
		requireUnreliable: opts.requireUnreliable,
	};
}

function toCloseInfo(info: CloseInfo): WebTransportCloseInfo {
	return {
		closeCode: info?.code,
		reason: info?.reason,
	};
}

/** Internal transport state for facade method guards */
type WebTransportState =
	| "connecting"
	| "connected"
	| "draining"
	| "closed"
	| "failed";

type SendPolicy = {
	groupId: number;
	sendOrder: number;
};

type ScheduledTask = {
	groupId: number;
	sendOrder: number;
	seq: number;
	run: () => Promise<void>;
	resolve: () => void;
	reject: (err: unknown) => void;
};

class SendScheduler {
	#queues = new Map<number, ScheduledTask[]>();
	#groupOrder: number[] = [];
	#rrIdx = 0;
	#running = false;
	#seq = 0;

	enqueue(policy: SendPolicy, run: () => Promise<void>): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const task: ScheduledTask = {
				groupId: policy.groupId,
				sendOrder: policy.sendOrder,
				seq: this.#seq++,
				run,
				resolve,
				reject,
			};
			const q = this.#queues.get(policy.groupId) ?? [];
			q.push(task);
			q.sort((a, b) => a.sendOrder - b.sendOrder || a.seq - b.seq);
			this.#queues.set(policy.groupId, q);
			if (!this.#groupOrder.includes(policy.groupId)) {
				this.#groupOrder.push(policy.groupId);
			}
			void this.#drain();
		});
	}

	async #drain(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			while (this.#groupOrder.length > 0) {
				const groupId = this.#nextGroup();
				if (groupId == null) break;
				const q = this.#queues.get(groupId);
				if (!q || q.length === 0) {
					this.#removeGroup(groupId);
					continue;
				}
				const task = q.shift()!;
				if (q.length === 0) this.#removeGroup(groupId);
				try {
					await task.run();
					task.resolve();
				} catch (err) {
					task.reject(err);
				}
			}
		} finally {
			this.#running = false;
		}
	}

	#nextGroup(): number | null {
		if (this.#groupOrder.length === 0) return null;
		if (this.#rrIdx >= this.#groupOrder.length) this.#rrIdx = 0;
		const groupId = this.#groupOrder[this.#rrIdx];
		this.#rrIdx = (this.#rrIdx + 1) % Math.max(1, this.#groupOrder.length);
		return groupId ?? null;
	}

	#removeGroup(groupId: number): void {
		this.#queues.delete(groupId);
		const idx = this.#groupOrder.indexOf(groupId);
		if (idx >= 0) this.#groupOrder.splice(idx, 1);
		if (this.#rrIdx > idx && idx >= 0) this.#rrIdx--;
		if (this.#rrIdx < 0) this.#rrIdx = 0;
	}
}

/**
 * Browser-style WebTransport client (W3C facade).
 *
 * Use `new WebTransport(url, options)` to connect, or `toWebTransport(session)` to wrap an existing
 * {@link ClientSession}. Await {@link WebTransport.ready} before using datagrams/streams.
 *
 * Option semantics:
 * - `allowPooling`: when true, endpoint-level pooling; when false, dedicated sessions.
 * - `requireUnreliable` is accepted; runtime transport always supports unreliable delivery.
 *
 * @example
 * ```ts
 * const wt = new WebTransport("https://127.0.0.1:4433", { tls: { insecureSkipVerify: true } });
 * await wt.ready;
 * const { readable, writable } = await wt.createBidirectionalStream();
 * writable.getWriter().write(new Uint8Array([1, 2, 3]));
 * wt.close({ closeCode: 1000, reason: "done" });
 * await wt.closed;
 * ```
 */
export class WebTransport {
	/** Static: true if runtime supports sessions over exclusively reliable (TCP) connections. Ours uses QUIC (supports unreliable). */
	static readonly supportsReliableOnly = false;

	readonly #sessionPromise: Promise<ClientSession>;
	readonly #ready: Promise<void>;
	readonly #closed: Promise<WebTransportCloseInfo>;
	readonly #draining: Promise<void>;
	#drainingResolve!: () => void;
	#session: ClientSession | null = null;
	#state: WebTransportState;
	#datagramsCache: WebTransportDatagramDuplexStream | null = null;
	readonly #datagramsReadableType: "bytes" | "default";
	#incomingBidiCache: ReadableStream<{
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	}> | null = null;
	#incomingUniCache: ReadableStream<ReadableStream<Uint8Array>> | null = null;
	readonly #sendScheduler = new SendScheduler();
	#nextSendGroupId = 1;
	readonly #sendGroupBytesSent = new Map<number, number>();
	readonly #connStats = {
		bytesSent: 0,
		bytesReceived: 0,
		datagramsOut: 0,
		datagramsIn: 0,
	};
	readonly #congestionControl: "default" | "throughput" | "low-latency";

	constructor(
		urlOrSession: string | ClientSession,
		options?: WebTransportClientOptions,
	) {
		if (typeof urlOrSession === "string") {
			this.#datagramsReadableType = options?.datagramsReadableType ?? "default";
			const requestedCongestion = options?.congestionControl ?? "default";
			// Runtime currently supports default algorithm; explicit preference falls back to default.
			this.#congestionControl =
				requestedCongestion === "default" ? "default" : "default";
			const clientOpts = mapToClientOptions(options);
			this.#sessionPromise = connect(urlOrSession, clientOpts);
			this.#state = "connecting";
			this.#ready = this.#sessionPromise.then(
				(s) => {
					this.#session = s;
					if (this.#state !== "draining") this.#state = "connected";
				},
				(err) => {
					this.#state = "failed";
					throw err;
				},
			);
			this.#closed = this.#sessionPromise.then(
				(s) =>
					s.closed.then((info) => {
						this.#state = "closed";
						return toCloseInfo(info);
					}),
				() => {
					// Connect failed: closed never rejects (PARITY_MATRIX).
					this.#state = "closed";
					return toCloseInfo({ code: 0, reason: "" });
				},
			);
		} else {
			this.#datagramsReadableType = "default";
			this.#congestionControl = "default";
			const s = urlOrSession;
			this.#sessionPromise = Promise.resolve(s);
			this.#session = s;
			this.#state = "connected";
			this.#ready = s.ready;
			this.#closed = s.closed.then((info) => {
				this.#state = "closed";
				return toCloseInfo(info);
			});
		}
		// draining: spec says it resolves when close() is called and closing process has started.
		this.#draining = new Promise<void>((r) => {
			this.#drainingResolve = r;
		});
	}

	/** Resolves when handshake completes. Rejects with WebTransportError on connect failure. */
	get ready(): Promise<void> {
		return this.#ready;
	}

	/** Resolves with close info when session closes. Never rejects. */
	get closed(): Promise<WebTransportCloseInfo> {
		return this.#closed;
	}

	/** Resolves when close() has been called and closing process has started. */
	get draining(): Promise<void> {
		return this.#draining;
	}

	/** Effective congestion control mode applied by this runtime. */
	get congestionControl(): "default" | "throughput" | "low-latency" {
		return this.#congestionControl;
	}

	/** Create a send group used by sendOrder/sendGroup options. */
	createSendGroup(): WebTransportSendGroup {
		return new WebTransportSendGroup(this, this.#nextSendGroupId++);
	}

	/** Datagram duplex stream (W3C WebTransportDatagramDuplexStream). Throws E_SESSION_CLOSED after close. */
	get datagrams(): WebTransportDatagramDuplexStream {
		if (!this.#datagramsCache) {
			this.#datagramsCache = createDatagramStreams(
				this,
				this.#datagramsReadableType,
			);
		}
		return this.#datagramsCache;
	}

	/** Incoming bidirectional streams as ReadableStream of { readable, writable }. */
	get incomingBidirectionalStreams(): ReadableStream<{
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	}> {
		if (!this.#incomingBidiCache) {
			this.#incomingBidiCache = createIncomingBidiStreams(this);
		}
		return this.#incomingBidiCache;
	}

	/** Incoming unidirectional streams as ReadableStream of ReadableStream. */
	get incomingUnidirectionalStreams(): ReadableStream<
		ReadableStream<Uint8Array>
	> {
		if (!this.#incomingUniCache) {
			this.#incomingUniCache = createIncomingUniStreams(this);
		}
		return this.#incomingUniCache;
	}

	/**
	 * Create a bidirectional stream (Web Streams).
	 * @throws WebTransportError E_SESSION_CLOSED if session is closed/draining/failed.
	 */
	async createBidirectionalStream(options?: {
		sendOrder?: number;
		sendGroup?: WebTransportSendGroup | null;
	}): Promise<{
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	}> {
		const policy = this._resolveSendPolicy(options);
		if (
			this.#state === "draining" ||
			this.#state === "closed" ||
			this.#state === "failed"
		) {
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		}
		const s = await this.#sessionPromise;
		const duplex = await s.createBidirectionalStream();
		return nodeDuplexToWebBidi(
			duplex,
			this.#sendScheduler,
			policy,
			(bytes) => {
				this.#connStats.bytesSent += bytes;
				this._recordSendGroupBytes(policy.groupId, bytes);
			},
			(bytes) => {
				this.#connStats.bytesReceived += bytes;
			},
		);
	}

	/**
	 * Create a unidirectional send stream (WritableStream).
	 * @throws WebTransportError E_SESSION_CLOSED if session is closed/draining/failed.
	 */
	async createUnidirectionalStream(options?: {
		sendOrder?: number;
		sendGroup?: WebTransportSendGroup | null;
	}): Promise<WritableStream<Uint8Array>> {
		const policy = this._resolveSendPolicy(options);
		if (
			this.#state === "draining" ||
			this.#state === "closed" ||
			this.#state === "failed"
		) {
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		}
		const s = await this.#sessionPromise;
		const writable = await s.createUnidirectionalStream();
		return nodeWritableToWebWritable(
			writable,
			this.#sendScheduler,
			policy,
			(bytes) => {
				this.#connStats.bytesSent += bytes;
				this._recordSendGroupBytes(policy.groupId, bytes);
			},
		);
	}

	/**
	 * Get connection stats (W3C WebTransportConnectionStats).
	 * Maps from session.metricsSnapshot(). Native exposes limited fields; unavailable stats are omitted.
	 * @throws DOMException InvalidStateError if state is "failed"
	 */
	async getStats(): Promise<WebTransportConnectionStats> {
		if (this.#state === "failed") {
			throw new DOMException("Transport has failed", "InvalidStateError");
		}
		await this.#sessionPromise; // Ensure session resolved (throws if failed)
		return {
			datagrams: {
				droppedIncoming: 0,
				expiredIncoming: 0,
				expiredOutgoing: 0,
				lostOutgoing: 0,
			},
			bytesSent: this.#connStats.bytesSent,
			bytesReceived: this.#connStats.bytesReceived,
			packetsSent: this.#connStats.datagramsOut,
			packetsReceived: this.#connStats.datagramsIn,
			estimatedSendRate: null,
		};
	}

	/** Initiate graceful close. Idempotent after first call. */
	close(info?: WebTransportCloseInfo): void {
		this.#drainingResolve(); // Resolves draining as soon as close() is called
		if (this.#state === "connected" || this.#state === "connecting") {
			this.#state = "draining";
		}
		if (this.#session) {
			this.#session.close({
				code: info?.closeCode,
				reason: info?.reason,
			});
		} else {
			// Still connecting: absorb eventual connect failure to prevent unhandled rejection (S4).
			this.#ready.catch(() => {});
		}
	}

	/** Internal: session for adapters (not part of spec) */
	async _getSession(): Promise<ClientSession> {
		return this.#sessionPromise;
	}

	/** Internal: state for createWritable guard (not part of spec) */
	_getState(): WebTransportState {
		return this.#state;
	}

	_resolveSendPolicy(options?: {
		sendOrder?: number;
		sendGroup?: WebTransportSendGroup | null;
	}): SendPolicy {
		const sendOrder = options?.sendOrder ?? 0;
		if (!Number.isInteger(sendOrder)) {
			throw new TypeError("sendOrder must be an integer");
		}
		let groupId = 0;
		if (options?.sendGroup != null) {
			if (!(options.sendGroup instanceof WebTransportSendGroup)) {
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

	_recordSendGroupBytes(groupId: number, bytes: number): void {
		this.#sendGroupBytesSent.set(
			groupId,
			(this.#sendGroupBytesSent.get(groupId) ?? 0) + bytes,
		);
	}

	async _getSendGroupStats(groupId: number): Promise<{
		bytesSent?: number;
		bytesAcknowledged?: number;
	}> {
		return {
			bytesSent: this.#sendGroupBytesSent.get(groupId) ?? 0,
		};
	}

	async _sendDatagramWithPolicy(
		chunk: Uint8Array,
		policy: SendPolicy,
	): Promise<void> {
		await this.#sendScheduler.enqueue(policy, async () => {
			const s = await this.#sessionPromise;
			await s.sendDatagram(chunk);
			this.#connStats.bytesSent += chunk.byteLength;
			this.#connStats.datagramsOut += 1;
			this._recordSendGroupBytes(policy.groupId, chunk.byteLength);
		});
	}

	_recordIncomingDatagram(chunk: Uint8Array): void {
		this.#connStats.bytesReceived += chunk.byteLength;
		this.#connStats.datagramsIn += 1;
	}

	_recordIncomingStreamBytes(bytes: number): void {
		this.#connStats.bytesReceived += bytes;
	}
}

function createDatagramWritable(
	wt: WebTransport,
	policy: SendPolicy,
): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		async write(chunk) {
			await wt._sendDatagramWithPolicy(chunk, policy);
		},
	});
}

function createDatagramStreams(
	wt: WebTransport,
	readableType: "bytes" | "default",
): WebTransportDatagramDuplexStream {
	let iter: AsyncIterator<Uint8Array> | null = null;
	const getNext = async (): Promise<IteratorResult<Uint8Array>> => {
		if (!iter) {
			const s = await wt._getSession();
			iter = s.incomingDatagrams()[Symbol.asyncIterator]();
		}
		return iter.next();
	};

	const pull = async (
		controller:
			| ReadableStreamDefaultController<Uint8Array>
			| ReadableByteStreamController,
	) => {
		const { done, value } = await getNext();
		if (done) {
			controller.close();
			return;
		}
		const chunk = new Uint8Array(value);
		wt._recordIncomingDatagram(chunk);
		const byteController = controller as ReadableByteStreamController;
		if (
			readableType === "bytes" &&
			byteController.byobRequest &&
			byteController.byobRequest.view
		) {
			const view = byteController.byobRequest.view as Uint8Array;
			if (view.byteLength < chunk.length) {
				throw new RangeError("BYOB buffer smaller than datagram size");
			}
			view.set(chunk.subarray(0, chunk.length));
			byteController.byobRequest.respond(chunk.length);
			return;
		}
		controller.enqueue(chunk);
	};

	const readable =
		readableType === "bytes"
			? new ReadableStream<Uint8Array>(
					{
						type: "bytes",
						pull,
					} as unknown as object,
					{ highWaterMark: 0 },
				)
			: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
	const writable = createDatagramWritable(wt, { groupId: 0, sendOrder: 0 });
	return {
		readable,
		writable,
		createWritable(options?: {
			sendGroup?: WebTransportSendGroup | null;
			sendOrder?: number;
		}): WritableStream<Uint8Array> {
			const state = wt._getState();
			if (state === "closed" || state === "failed") {
				throw new DOMException(
					"Transport is closed or failed",
					"InvalidStateError",
				);
			}
			return createDatagramWritable(wt, wt._resolveSendPolicy(options));
		},
		get maxDatagramSize(): number {
			return DEFAULT_LIMITS.maxDatagramSize;
		},
	};
}

function attachServerBidiControls(
	duplex: Duplex,
	stream: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	},
): WebTransportBidirectionalStream {
	const withControls = stream as WebTransportBidirectionalStream;
	const reset = (duplex as unknown as Partial<Resettable>)[WT_RESET];
	if (typeof reset === "function") {
		withControls[WT_RESET] = (code?: number) => reset.call(duplex, code);
	}
	const stopSending = (duplex as unknown as Partial<StopSendable>)[
		WT_STOP_SENDING
	];
	if (typeof stopSending === "function") {
		withControls[WT_STOP_SENDING] = (code?: number) =>
			stopSending.call(duplex, code);
	}
	return withControls;
}

function attachServerRecvControls(
	readable: Readable,
	stream: ReadableStream<Uint8Array>,
): WebTransportReceiveStream {
	const withControls = stream as WebTransportReceiveStream;
	const stopSending = (readable as unknown as Partial<StopSendable>)[
		WT_STOP_SENDING
	];
	if (typeof stopSending === "function") {
		withControls[WT_STOP_SENDING] = (code?: number) =>
			stopSending.call(readable, code);
	}
	return withControls;
}

function createServerIncomingBidiStreams(
	nativeHandle: any,
	isClosed: () => boolean,
): ReadableStream<WebTransportBidirectionalStream> {
	return new ReadableStream({
		async start(controller) {
			while (!isClosed()) {
				try {
					const nativeStream = await nativeHandle.acceptBidiStream();
					if (!nativeStream) break;
					const duplex = new BidiStream({
						handleId: nativeStream?.id ?? 0,
						nativeHandle: nativeStream,
					});
					controller.enqueue(
						attachServerBidiControls(duplex, await nodeDuplexToWebBidi(duplex)),
					);
				} catch {
					break;
				}
			}
			controller.close();
		},
	});
}

function createServerIncomingUniStreams(
	nativeHandle: any,
	isClosed: () => boolean,
): ReadableStream<WebTransportReceiveStream> {
	return new ReadableStream({
		async start(controller) {
			while (!isClosed()) {
				try {
					const nativeStream = await nativeHandle.acceptUniStream();
					if (!nativeStream) break;
					const readable = new RecvStream({
						handleId: nativeStream?.id ?? 0,
						nativeHandle: nativeStream,
					});
					controller.enqueue(
						attachServerRecvControls(
							readable,
							nodeReadableToWebReadable(readable),
						),
					);
				} catch {
					break;
				}
			}
			controller.close();
		},
	});
}

function createIncomingBidiStreams(wt: WebTransport): ReadableStream<{
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}> {
	return new ReadableStream({
		async start(controller) {
			const s = await wt._getSession();
			for await (const duplex of s.incomingBidirectionalStreams()) {
				controller.enqueue(
					await nodeDuplexToWebBidi(
						duplex,
						undefined,
						undefined,
						undefined,
						(bytes) => {
							wt._recordIncomingStreamBytes(bytes);
						},
					),
				);
			}
			controller.close();
		},
	});
}

function createIncomingUniStreams(
	wt: WebTransport,
): ReadableStream<ReadableStream<Uint8Array>> {
	return new ReadableStream({
		async start(controller) {
			const s = await wt._getSession();
			for await (const readable of s.incomingUnidirectionalStreams()) {
				controller.enqueue(
					nodeReadableToWebReadable(readable, (bytes) => {
						wt._recordIncomingStreamBytes(bytes);
					}),
				);
			}
			controller.close();
		},
	});
}

function nodeDuplexToWebBidi(
	duplex: Duplex,
	scheduler?: SendScheduler,
	policy?: SendPolicy,
	onWriteBytes?: (bytes: number) => void,
	onReadBytes?: (bytes: number) => void,
): Promise<{
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}> {
	const readable = nodeReadableToWebReadable(duplex, onReadBytes);
	const writable = nodeWritableToWebWritable(
		duplex,
		scheduler,
		policy,
		onWriteBytes,
	);
	return Promise.resolve({ readable, writable });
}

/** Extract QUIC application error code from abort/cancel reason. */
function extractStreamErrorCode(reason: unknown): number {
	if (typeof reason === "number" && Number.isInteger(reason)) return reason;
	const o =
		reason && typeof reason === "object"
			? (reason as Record<string, unknown>)
			: null;
	if (o) {
		const c = (o.streamErrorCode ?? o.code) as unknown;
		if (typeof c === "number" && Number.isInteger(c)) return c;
	}
	return 0;
}

function nodeReadableToWebReadable(
	r: Readable,
	onReadBytes?: (bytes: number) => void,
): ReadableStream<Uint8Array> {
	const stopSendable = r as unknown as Partial<StopSendable>;
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for await (const chunk of r) {
				const bytes =
					chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
				if (onReadBytes) onReadBytes(bytes.byteLength);
				controller.enqueue(bytes);
			}
			controller.close();
		},
		cancel(reason) {
			const fn = stopSendable[WT_STOP_SENDING];
			if (typeof fn === "function") fn.call(r, extractStreamErrorCode(reason));
		},
	});
}

function nodeWritableToWebWritable(
	w: Writable,
	scheduler?: SendScheduler,
	policy?: SendPolicy,
	onWriteBytes?: (bytes: number) => void,
): WritableStream<Uint8Array> {
	const resettable = w as unknown as Partial<Resettable>;
	return new WritableStream<Uint8Array>({
		async write(chunk) {
			const run = () =>
				new Promise<void>((resolve, reject) => {
					w.write(Buffer.from(chunk), (err: Error | null | undefined) =>
						err ? reject(err) : resolve(),
					);
				});
			if (scheduler && policy) {
				await scheduler.enqueue(policy, run);
			} else {
				await run();
			}
			if (onWriteBytes) onWriteBytes(chunk.byteLength);
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				w.end((err: Error | null | undefined) =>
					err ? reject(err) : resolve(),
				);
			});
		},
		abort(reason) {
			const fn = resettable[WT_RESET];
			if (typeof fn === "function") fn.call(w, extractStreamErrorCode(reason));
		},
	});
}

/**
 * Wrap an existing {@link ClientSession} as a browser-style WebTransport.
 *
 * Use when you obtained a session via {@link connect} but want Web Streams and W3C-style API.
 *
 * @param session - Connected ClientSession from {@link connect}.
 * @returns WebTransport with same lifecycle; `ready` resolves immediately if session is connected.
 *
 * @example
 * ```ts
 * const session = await connect("https://127.0.0.1:4433", { tls: { insecureSkipVerify: true } });
 * const wt = toWebTransport(session);
 * await wt.ready;
 * const writer = wt.datagrams.writable.getWriter();
 * await writer.write(new Uint8Array([1, 2, 3]));
 * writer.releaseLock();
 * session.close();
 * ```
 */
export function toWebTransport(session: ClientSession): WebTransport {
	return new WebTransport(session);
}
