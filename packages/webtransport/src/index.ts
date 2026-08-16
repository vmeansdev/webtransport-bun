/**
 * @packageDocumentation
 * @module @webtransport-bun/webtransport
 *
 * Production-ready WebTransport for Bun, backed by napi-rs + wtransport (Rust).
 * Supports in-process server, client (Node API and W3C-style facade), datagrams, and streams.
 */

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

export type { Resettable, StopSendable } from "./streams.js";
// Re-export stream symbols and helpers
export { WT_RESET, WT_STOP_SENDING } from "./streams.js";

import {
	BidiStream,
	RecvStream,
	type Resettable,
	SendStream,
	type StopSendable,
	WT_RESET,
	WT_STOP_SENDING,
} from "./streams.js";

export type {
	WebTransportErrorOptions,
	WebTransportErrorSource,
} from "./errors.js";
/**
 * Stable error codes. Use with {@link WebTransportError.code} for programmatic handling.
 * @see WebTransportError
 */
export {
	E_BACKPRESSURE_TIMEOUT,
	E_HANDSHAKE_TIMEOUT,
	E_INTERNAL,
	E_INVALID_ARGUMENT,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_RATE_LIMITED,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STOP_SENDING,
	E_STREAM_RESET,
	E_TLS,
	E_UNSUPPORTED_ARGUMENT,
	WebTransportError,
} from "./errors.js";
export type { ErrorCode } from "./types.js";

import { createMonotonicDeadline, sleep, withDeadline } from "./deadline.js";
import {
	E_BACKPRESSURE_TIMEOUT,
	E_HANDSHAKE_TIMEOUT,
	E_INTERNAL,
	E_INVALID_ARGUMENT,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_RATE_LIMITED,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STOP_SENDING,
	E_STREAM_RESET,
	E_TLS,
	E_UNSUPPORTED_ARGUMENT,
	extractStreamErrorCode,
	unwrapNativeValue,
	unwrapNativeVoid,
	WebTransportError,
} from "./errors.js";
import type {
	CloseInfo,
	ErrorCode,
	RateLimitOptions,
	WebTransportCloseInfo,
} from "./types.js";
import {
	createW3CMappedError as createMappedError,
	normalizeW3CBrowserName as normalizeToBrowserName,
} from "./w3c-client-options.js";

/** Web IDL BufferSource (ArrayBuffer | ArrayBufferView) for spec alignment */
type BufferSource = ArrayBuffer | ArrayBufferView;
type StreamOpenOptions = { waitUntilAvailable?: boolean };

const E_CODE_RE = /^(E_[A-Z_]+)(?::|$)/;
/** Bun/Node often stringify napi errors as `GenericFailure, E_CODE: …`. */
const NAPI_STATUS_PREFIX_RE =
	/^(?:GenericFailure|Cancelled|InvalidArg|ObjectExpected|StringExpected|FunctionExpected|NumberExpected|BooleanExpected|ArrayExpected|Unknown|PendingException|EscapeCalledTwice|HandleScopeMismatch|CallbackScopeMismatch|QueueFull|Closing|BigintExpected|DateExpected|ArrayBufferExpected|DetachableArraybufferExpected|WouldDeadlock),\s*/u;
const E_CODE_TOKEN_RE = /\b(E_[A-Z_]+)\b/gu;
const KNOWN_ERROR_CODES = [
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
	E_INVALID_ARGUMENT,
	E_UNSUPPORTED_ARGUMENT,
	E_INTERNAL,
] as const satisfies readonly ErrorCode[];
const KNOWN_ERROR_CODE_SET = new Set<ErrorCode>(KNOWN_ERROR_CODES);
/** Wrapper codes that may nest a more specific causal E_* in the same message. */
const WRAPPER_ERROR_CODES = new Set<ErrorCode>([E_SESSION_CLOSED, E_INTERNAL]);
const SUPPRESS_LOG_CALLBACK_WARN =
	process.env.WEBTRANSPORT_SUPPRESS_LOG_CALLBACK_WARN === "1";
const SUPPRESS_READY_REJECTION_WARN =
	process.env.WEBTRANSPORT_SUPPRESS_READY_REJECTION_WARN === "1";

function knownCodeOrUndefined(
	value: string | undefined,
): ErrorCode | undefined {
	return value && KNOWN_ERROR_CODE_SET.has(value as ErrorCode)
		? (value as ErrorCode)
		: undefined;
}

/**
 * Extract a stable E_* from native/Bun error text. Prefers a causal code when a
 * wrapper like E_SESSION_CLOSED nests `connection closed by peer: E_LIMIT_EXCEEDED`.
 */
function extractMessageErrorCode(msg: string): ErrorCode | undefined {
	const withoutStatus = msg.replace(NAPI_STATUS_PREFIX_RE, "");
	const startCode = knownCodeOrUndefined(withoutStatus.match(E_CODE_RE)?.[1]);
	const tokens = [...withoutStatus.matchAll(E_CODE_TOKEN_RE)]
		.map((m) => knownCodeOrUndefined(m[1]))
		.filter((c): c is ErrorCode => c != null);
	const causal = [...tokens].reverse().find((c) => !WRAPPER_ERROR_CODES.has(c));
	if (startCode && WRAPPER_ERROR_CODES.has(startCode) && causal) {
		return causal;
	}
	return startCode ?? causal ?? tokens[0];
}

function toWebTransportError(
	err: unknown,
	strictW3CErrors?: boolean,
): WebTransportError {
	const explicitCode =
		err && typeof err === "object"
			? (err as { code?: unknown }).code
			: undefined;
	const knownExplicitCode =
		typeof explicitCode === "string" &&
		KNOWN_ERROR_CODE_SET.has(explicitCode as ErrorCode)
			? (explicitCode as ErrorCode)
			: undefined;
	const msg = err instanceof Error ? err.message : String(err);
	if (knownExplicitCode) {
		return createMappedError(knownExplicitCode, msg, strictW3CErrors);
	}
	return createMappedError(
		extractMessageErrorCode(msg) ?? (E_INTERNAL as ErrorCode),
		msg,
		strictW3CErrors,
	);
}

function isSessionCloseError(err: unknown): boolean {
	const mapped = toWebTransportError(err);
	if (
		mapped.code === E_SESSION_CLOSED ||
		mapped.code === E_SESSION_IDLE_TIMEOUT
	) {
		return true;
	}
	const msg = err instanceof Error ? err.message : String(err);
	const lower = msg.toLowerCase();
	// Native transports can report close without E_* code (e.g. "connection locally closed").
	return (
		lower.includes("connection locally closed") ||
		lower.includes("connection closed by peer")
	);
}

function shouldRetryStreamOpen(err: unknown): boolean {
	const mapped = toWebTransportError(err);
	return (
		mapped.code === E_LIMIT_EXCEEDED ||
		mapped.code === E_QUEUE_FULL ||
		mapped.code === E_BACKPRESSURE_TIMEOUT
	);
}

function parseWaitUntilAvailable(
	options?: StreamOpenOptions,
	strictW3CErrors?: boolean,
): boolean {
	const value = options?.waitUntilAvailable;
	if (value === undefined) return false;
	if (typeof value !== "boolean") {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: waitUntilAvailable must be a boolean",
			strictW3CErrors,
		);
	}
	return value;
}

function boundNativeCapacityWait(
	handle: {
		waitBidiCapacity?: (remainingMs: number) => Promise<void>;
		waitUniCapacity?: (remainingMs: number) => Promise<void>;
	},
	kind: "bidi" | "uni",
): ((remainingMs: number) => Promise<void>) | undefined {
	let fn: ((remainingMs: number) => Promise<void>) | undefined;
	switch (kind) {
		case "bidi":
			fn = handle.waitBidiCapacity;
			break;
		case "uni":
			fn = handle.waitUniCapacity;
			break;
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
	if (typeof fn !== "function") return undefined;
	return (remainingMs) => fn.call(handle, remainingMs);
}

async function openStreamWithWait<T>(
	openFn: () => Promise<T>,
	options: StreamOpenOptions | undefined,
	backpressureTimeoutMs: number,
	isClosed: () => boolean,
	waitForCapacity?: (remainingMs: number) => Promise<void>,
	strictW3CErrors?: boolean,
): Promise<T> {
	const waitUntilAvailable = parseWaitUntilAvailable(options, strictW3CErrors);
	if (!waitUntilAvailable) {
		return openFn();
	}
	const waitForCapacityWithFallback =
		waitForCapacity ?? createPollingCapacityWaiter(isClosed);
	const deadline = createMonotonicDeadline(backpressureTimeoutMs);
	const timeoutMs = deadline.timeoutMs;
	while (true) {
		if (isClosed()) {
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		}
		try {
			return await openFn();
		} catch (err) {
			if (!shouldRetryStreamOpen(err)) {
				throw toWebTransportError(err, strictW3CErrors);
			}
			if (deadline.expired()) {
				throw new WebTransportError(
					E_BACKPRESSURE_TIMEOUT as ErrorCode,
					`E_BACKPRESSURE_TIMEOUT: waitUntilAvailable timed out after ${timeoutMs}ms`,
				);
			}
			const remaining = deadline.remainingMs();
			await withDeadline(
				waitForCapacityWithFallback(Math.max(1, remaining)),
				Math.max(1, remaining),
				{
					timeoutMessage: `E_BACKPRESSURE_TIMEOUT: waitUntilAvailable timed out after ${timeoutMs}ms`,
				},
			);
		}
	}
}

function createPollingCapacityWaiter(
	isClosed: () => boolean,
): (remainingMs: number) => Promise<void> {
	let backoffMs = 2;
	return async (remainingMs: number): Promise<void> => {
		if (isClosed()) {
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		}
		const sleepMs = Math.max(1, Math.min(backoffMs, remainingMs));
		backoffMs = Math.min(backoffMs * 2, 64);
		await sleep(sleepMs);
	};
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

/** TLS configuration for server (cert/key) or client (CA, SNI). */
export type ServerTlsSniEntry = {
	serverName: string;
	certPem: string | Uint8Array;
	keyPem: string | Uint8Array;
};

export type UnknownSniPolicy = "reject" | "default";

export type ServerTlsSnapshot = {
	sniServerNames: string[];
	unknownSniPolicy: UnknownSniPolicy;
};

export type TlsOptions = {
	/** PEM-encoded certificate (server) or CA (client). */
	certPem: string | Uint8Array;
	/**
	 * PEM-encoded private key (server only). Unencrypted PKCS#8
	 * (`BEGIN PRIVATE KEY`), SEC1 ECDSA (`BEGIN EC PRIVATE KEY`), and PKCS#1 RSA
	 * (`BEGIN RSA PRIVATE KEY`) are accepted; encrypted keys are not.
	 */
	keyPem: string | Uint8Array;
	/** Optional CA PEM for client verification. */
	caPem?: string | Uint8Array;
	/** SNI for client mode; for server, used in logs/metrics. */
	serverName?: string;
	/** Optional additional SNI certificates for server mode. */
	sni?: ServerTlsSniEntry[];
	/** Unknown SNI handling for server mode. Default "reject". No-SNI still uses default cert. */
	unknownSniPolicy?: UnknownSniPolicy;
	/** When true, allow empty cert/key fallback in production (dev only). */
	allowSelfSigned?: boolean;
};

// ---------------------------------------------------------------------------
// Rate-limit options
// ---------------------------------------------------------------------------

export type { RateLimitOptions } from "./types.js";

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
	/**
	 * Max idle time before a connection is considered dead and closed. Applies
	 * to both the server and the client: on the client it guarantees `closed`
	 * resolves on a dead path (NAT rebind, network drop, server power loss)
	 * instead of hanging forever. Default 60000.
	 */
	idleTimeoutMs: number;
	/**
	 * Keep-alive ping interval in ms. Keeps a live-but-quiet connection from
	 * being idle-closed, and is always clamped to stay safely below
	 * `idleTimeoutMs`. On the client it defaults to `idleTimeoutMs / 3` when
	 * omitted; on the server keep-alive is off unless set, and the effective
	 * interval is `min(keepAliveIntervalMs, idleTimeoutMs / 3)`. Set 0 to
	 * disable.
	 */
	keepAliveIntervalMs?: number;
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

	/** Congestion controller for all server connections: cubic (default), BBR (throughput), or NewReno (low-latency). */
	congestionControl?: "default" | "throughput" | "low-latency";

	/**
	 * Accept QUIC 0-RTT session establishment from resuming clients.
	 * Off by default. When enabled, a returning client's CONNECT can arrive
	 * as replayable early data; such sessions report `has0Rtt` and resumption
	 * state is per-process (restarts/load balancing fall back to 1-RTT).
	 */
	enable0Rtt?: boolean;

	/**
	 * Deliver 0-RTT sessions to `onSession` before the handshake is confirmed.
	 * Off by default: session establishment is the replayable unit of 0-RTT,
	 * so by default `onSession` is deferred until the request is no longer
	 * replayable. Opt in only when the callback's pre-confirmation work is
	 * strictly idempotent; it can still gate side effects on
	 * `session.handshakeConfirmed`. No effect unless `enable0Rtt` is set.
	 */
	allowEarlySession?: boolean;

	/**
	 * Advertise a QPACK dynamic-table capacity (`SETTINGS_QPACK_MAX_TABLE_CAPACITY`)
	 * to peers, in bytes. `0` (the default) advertises no table and keeps header
	 * compression to the static table alone — unchanged wire behavior. A non-zero
	 * value both offers a table to the peer and bounds the table this endpoint will
	 * mirror; values above 65536 (64 KiB) are rejected. This is an interop/completeness
	 * setting, not a throughput one: WebTransport carries headers only on the
	 * CONNECT exchange. `SETTINGS_QPACK_BLOCKED_STREAMS` is always advertised as 0
	 * and is not configurable. Prefer {@link enableDynamicQpack} for the preset.
	 */
	qpackMaxTableCapacity?: number;

	/**
	 * Convenience preset for {@link qpackMaxTableCapacity}: `true` advertises a
	 * 4096-byte dynamic table (blocked-streams still 0). Off by default. An
	 * explicit `qpackMaxTableCapacity` takes precedence over this flag.
	 */
	enableDynamicQpack?: boolean;

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
	/** Effective congestion-control mode applied to all server connections. */
	readonly congestionControl: "default" | "throughput" | "low-latency";
	/** Rotate only the default server TLS certificate/key at runtime. Existing sessions stay alive. */
	updateCert(tls: {
		certPem: string | Uint8Array;
		keyPem: string | Uint8Array;
	}): Promise<void>;
	/** Atomically replace the full server TLS configuration, including SNI certs and unknown-SNI policy. */
	updateTls(tls: TlsOptions): Promise<void>;
	/** Replace only the full SNI cert map, preserving the default cert/key and unknown-SNI policy. */
	replaceSniCerts(sni: ServerTlsSniEntry[]): Promise<void>;
	/** Add or replace one hostname-specific SNI certificate. */
	upsertSniCert(entry: ServerTlsSniEntry): Promise<void>;
	/** Remove one hostname-specific SNI certificate. */
	removeSniCert(serverName: string): Promise<void>;
	/** Update only the unknown-SNI policy. */
	setUnknownSniPolicy(policy: UnknownSniPolicy): Promise<void>;
	/** Introspect the active server TLS SNI state without exposing key material. */
	tlsSnapshot(): ServerTlsSnapshot;
	close(): Promise<void>;
	metricsSnapshot(): MetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Browser-style facade types (RFC_CLIENT_FACADE, PARITY_MATRIX)
// ---------------------------------------------------------------------------

/** Browser-style close info (W3C alignment). Used by {@link WebTransport.close} and {@link WebTransport.closed}. */
export type { WebTransportCloseInfo } from "./types.js";

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
	/** Cert pinning list; values are raw SHA-256 digests (BufferSource). */
	serverCertificateHashes?: Array<{
		algorithm: "sha-256";
		value: BufferSource;
	}>;
	/** Internal/advanced: congestion hint passed to native runtime. */
	congestionControl?: "default" | "throughput" | "low-latency";
	/** Enable connection pooling for compatible connects. */
	allowPooling?: boolean;
	/** Require unreliable (datagram) delivery; participates in pool compatibility. */
	requireUnreliable?: boolean;
	/** When true, errors use browser-style DOMException names. Default false. */
	strictW3CErrors?: boolean;
	/**
	 * Offer QUIC 0-RTT on reconnects to servers seen before by this process.
	 * Off by default. Requires the server to enable 0-RTT too; incompatible
	 * with `allowPooling`. Sessions report `has0Rtt`/`accepted0Rtt`.
	 */
	enable0Rtt?: boolean;
	/**
	 * Advertise a QPACK dynamic-table capacity (`SETTINGS_QPACK_MAX_TABLE_CAPACITY`)
	 * to the server, in bytes. `0` (the default) keeps header compression to the
	 * static table alone. Values above 65536 are rejected.
	 * `SETTINGS_QPACK_BLOCKED_STREAMS` is
	 * always 0 and not configurable. Interop/completeness, not throughput —
	 * WebTransport carries headers only on the CONNECT exchange. Prefer
	 * {@link enableDynamicQpack} for the preset.
	 */
	qpackMaxTableCapacity?: number;
	/**
	 * Convenience preset for {@link qpackMaxTableCapacity}: `true` advertises a
	 * 4096-byte dynamic table (blocked-streams still 0). Off by default. An
	 * explicit `qpackMaxTableCapacity` takes precedence.
	 */
	enableDynamicQpack?: boolean;
};

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type { CloseInfo } from "./types.js";

function normalizeCloseInfo(
	info: CloseInfo | undefined,
	fallback?: CloseInfo,
): { code: number; reason: string } {
	return {
		code: info?.code ?? fallback?.code ?? 0,
		reason: info?.reason ?? fallback?.reason ?? "",
	};
}

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
	/** @internal */
	_getTransport(): WebTransport {
		return this.#transport;
	}
	/** @internal */
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

	/**
	 * Whether this session involved 0-RTT early data. Client side: this
	 * connect offered early data; server side: the CONNECT arrived as
	 * replayable early data. Always false unless 0-RTT was enabled.
	 */
	readonly has0Rtt: boolean;
	/** Whether the peer accepted the early data (false until known / when refused). */
	readonly accepted0Rtt: boolean;
	/** Whether the TLS handshake has completed (always true for non-0-RTT sessions). */
	readonly handshakeConfirmed: boolean;

	readonly ready: Promise<void>;
	readonly closed: Promise<CloseInfo>;

	/**
	 * Resolves when the peer says this session is going away — a received
	 * `WT_DRAIN_SESSION` capsule or `GOAWAY`. The session stays usable: streams
	 * already open keep working and new ones can still be opened. This is a
	 * warning, not an ending; await `closed` for the ending.
	 */
	readonly draining: Promise<void>;

	close(info?: CloseInfo): void;

	/**
	 * Tell the peer this session is going away soon, without ending it. Sends a
	 * `WT_DRAIN_SESSION` capsule and returns immediately.
	 */
	drain(): void;

	// Datagrams
	sendDatagram(data: Uint8Array): Promise<void>;
	incomingDatagrams(): AsyncIterable<Uint8Array>;
}

/** Server session surface used by createServer(onSession). */
export interface ServerSession extends CommonSession {
	readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
	readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;

	createBidirectionalStream(options?: StreamOpenOptions): Promise<Duplex>;
	createUnidirectionalStream(options?: StreamOpenOptions): Promise<Writable>;
	metricsSnapshot(): SessionMetricsSnapshot;

	/**
	 * Tell the peer not to open any further session on this connection. Sends an
	 * H3 `GOAWAY` and returns immediately.
	 *
	 * `GOAWAY` is connection-scoped, so this is a server-initiated
	 * graceful-shutdown signal ("I'm going away, don't start new sessions"). The
	 * peer observes it as its `draining` settling, and the current session stays
	 * usable. Native is single-session-per-connection, so the "refuse a second
	 * session" enforcement is not reachable through this API — the observable
	 * effect is the drain signal on the peer.
	 */
	goAway(): void;
}

/** Node client API session surface returned by connect(). */
export interface ClientSession extends CommonSession {
	// Streams
	createBidirectionalStream(options?: StreamOpenOptions): Promise<Duplex>;
	incomingBidirectionalStreams(): AsyncIterable<Duplex>;

	createUnidirectionalStream(options?: StreamOpenOptions): Promise<Writable>;
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
	/** Native ingest only. Present when the snapshot includes reason counters. */
	datagramsDroppedRateLimited?: number;
	datagramsDroppedTooLarge?: number;
	datagramsDroppedQueueGlobal?: number;
	datagramsDroppedQueueSession?: number;

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

// Bun <=1.3.13 permanently retains one WritableStream + one rejection Error
// for every stream whose close() rejects — e.g. any peer that drops its
// receive half, which quinn surfaces as STOP_SENDING racing the close. A
// long-running server on such a runtime leaks until the OOM-killer fires.
// engines.bun is advisory (npm does not enforce the "bun" key), so the only
// reliable disclosure is at runtime.
const LEAKY_BUN_CEILING = "1.3.14";
let warnedLeakyBunRuntime = false;
function warnIfLeakyBunRuntime(): void {
	if (warnedLeakyBunRuntime) return;
	warnedLeakyBunRuntime = true;
	const v = process.env.WEBTRANSPORT_SUPPRESS_RUNTIME_VERSION_WARN;
	if (v === "1" || v === "true" || v === "yes") return;
	if (typeof Bun === "undefined" || typeof Bun.version !== "string") return;
	const parse = (s: string): number[] | null => {
		const parts = s.split(".").slice(0, 3);
		if (parts.length < 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
		return parts.map(Number);
	};
	const actual = parse(Bun.version);
	const floor = parse(LEAKY_BUN_CEILING);
	if (!actual || !floor) return;
	const cmp =
		(actual[0] ?? 0) - (floor[0] ?? 0) ||
		(actual[1] ?? 0) - (floor[1] ?? 0) ||
		(actual[2] ?? 0) - (floor[2] ?? 0);
	if (cmp >= 0) return;
	console.warn(
		`[webtransport] warn: Bun ${Bun.version} leaks one WritableStream per stream whose close is rejected (fixed in Bun ${LEAKY_BUN_CEILING}); long-running servers will exhaust memory — upgrade the runtime`,
	);
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
		`# HELP ${p}tls_sni_cert_selections_total Handshakes served by hostname-specific SNI certs`,
		`# TYPE ${p}tls_sni_cert_selections_total counter`,
		`${p}tls_sni_cert_selections_total${metricLabels} ${m.sniCertSelections}`,
		`# HELP ${p}tls_default_cert_selections_total Handshakes served by the default certificate`,
		`# TYPE ${p}tls_default_cert_selections_total counter`,
		`${p}tls_default_cert_selections_total${metricLabels} ${m.defaultCertSelections}`,
		`# HELP ${p}tls_unknown_sni_rejected_total Handshakes rejected because SNI did not match a configured hostname`,
		`# TYPE ${p}tls_unknown_sni_rejected_total counter`,
		`${p}tls_unknown_sni_rejected_total${metricLabels} ${m.unknownSniRejectedCount}`,
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
const NATIVE_ADDON_OVERRIDE_ENV = "WEBTRANSPORT_NATIVE_ADDON_PATH";
const binaryCandidates = [
	`webtransport-native.${PLATFORM}-${ARCH}.node`,
	`webtransport-native.${PLATFORM}-${ARCH}-msvc.node`,
	`webtransport-native.${PLATFORM}-${ARCH}-gnu.node`,
	`webtransport-native.${PLATFORM}-${ARCH}-musl.node`,
];
const basePaths = ["../../../crates/native", "../prebuilds"];
type RequireLike = (id: string) => unknown;
type NativeLoadFailure = { request: string; message: string };
type NativeLoadResult = {
	addon: NativeAddon | undefined;
	failures: NativeLoadFailure[];
};
type NativeLogEvent = {
	level?: "debug" | "info" | "warn" | "error";
	msg?: string;
	sessionId?: string;
	peerIp?: string;
	peerPort?: number;
};
type NativeServerSessionEvent =
	| {
			name: "session";
			id: string;
			peerIp: string;
			peerPort: number;
	  }
	| {
			name: "session_closed";
			id: string;
			code: number;
			reason: string;
	  };
type NativeClientSessionEvent = {
	name: "session_closed";
	id: string;
	code: number;
	reason: string;
};
type NativeBidiStreamHandle = {
	readonly id: number;
	// Never-reject sentinels: string results are error codes (see
	// unwrapNativeValue) — rejected async napi calls leak handle refs.
	read(): Promise<Uint8Array | string | null>;
	write(chunk: Buffer | Uint8Array): Promise<string | null>;
	finish(): Promise<string | null> | void;
	finishWait?: () => Promise<string | null> | void;
	reset?: (code?: number) => void;
	stopSending?: (code?: number) => void;
	dispose?: () => void;
};
type NativeSendStreamHandle = {
	readonly id: number;
	write(chunk: Buffer | Uint8Array): Promise<string | null>;
	finish?: () => Promise<string | null> | void;
	finishWait?: () => Promise<string | null> | void;
	reset?: (code?: number) => void;
	stopSending?: (code?: number) => void;
	dispose?: () => void;
};
type NativeRecvStreamHandle = {
	readonly id: number;
	read(): Promise<Uint8Array | string | null>;
	reset?: (code?: number) => void;
	stopSending?: (code?: number) => void;
	dispose?: () => void;
};
interface NativeSessionHandle {
	id: string;
	peerIp: string;
	peerPort: number;
	close(code: number | null, reason: string | null): void;
	sendDatagram(data: Buffer | Uint8Array): Promise<string | null>;
	readDatagram(): Promise<Uint8Array | null>;
	discardDatagram?: (timeoutMs?: number) => Promise<boolean | null>;
	discardDatagrams?: (timeoutMs?: number) => Promise<number | null>;
	discardBidiStreams?: (timeoutMs?: number) => Promise<number | null>;
	discardUniStreams?: (timeoutMs?: number) => Promise<number | null>;
	enableBidiDiscard?: () => void;
	enableUniDiscard?: () => void;
	createBidiStream(): Promise<NativeBidiStreamHandle | string>;
	createUniStream(): Promise<NativeSendStreamHandle | string>;
	waitBidiCapacity?: (remainingMs: number) => Promise<void>;
	waitUniCapacity?: (remainingMs: number) => Promise<void>;
	acceptBidiStream(): Promise<NativeBidiStreamHandle | null>;
	acceptUniStream(): Promise<NativeRecvStreamHandle | null>;
	handleBidiProbe?: () => Promise<boolean>;
	handleUniProbe?: () => Promise<number>;
	metricsSnapshot(): SessionMetricsSnapshot;
	connectionStats?(): QuicConnectionStats | null;
	pathMaxDatagramSize?: () => number | null;
	/** 0-RTT getters (absent on older prebuilt addons). */
	has0Rtt?: boolean;
	accepted0Rtt?: boolean;
	handshakeConfirmed?: boolean;
	/** Session drain (absent on older prebuilt addons). */
	drain?: () => void;
	waitDraining?: () => Promise<void>;
	/** Connection-scoped H3 GOAWAY send (absent on older prebuilt addons). */
	goAway?: () => void;
}
type NativeConnectSessionHandle = {
	id: string;
	close(code: number | null, reason: string | null): void;
	peerIp?: string;
	peerPort?: number;
} & Partial<NativeSessionHandle>;
interface NativeServerHandle {
	port: number;
	close(): Promise<void>;
	updateCert(certPem: string, keyPem: string): Promise<void>;
	updateTls(configJson: string): Promise<void>;
	replaceSniCerts(json: string): Promise<void>;
	upsertSniCert(
		serverName: string,
		certPem: string,
		keyPem: string,
	): Promise<void>;
	removeSniCert(serverName: string): Promise<void>;
	setUnknownSniPolicy(policy: string): Promise<void>;
	tlsSnapshot(): ServerTlsSnapshot;
	metricsSnapshot(): MetricsSnapshot;
}
interface NativeAddon {
	ServerHandle: new (
		port: number,
		host: string,
		debug: boolean,
		tlsConfigJson: string,
		limitsJson: string,
		rateLimitsJson: string,
		serverOptsJson: string,
		onSessionEvents: (events: NativeServerSessionEvent[]) => void,
		onLog?: (events: NativeLogEvent[]) => void,
	) => NativeServerHandle;
	SessionHandle: new (
		id: string,
		peerIp: string,
		peerPort: number,
	) => NativeSessionHandle;
	ClientSessionHandle: new (
		id: string,
		peerIp: string,
		peerPort: number,
	) => NativeSessionHandle;
	connect(
		url: string,
		optsJson: string,
		onClosed: (events: NativeClientSessionEvent[]) => void,
		cb: (err: unknown, handleId?: string) => void,
	): void;
	takeClientSession(handleId: string): NativeSessionHandle | undefined;
	clientPoolMetricsSnapshot(): {
		hits: number;
		misses: number;
		evictIdle?: number;
		evictBroken?: number;
	};
	nativeStreamHandlesSnapshot?: () => {
		bidiHandlesLive: number;
		uniSendHandlesLive: number;
		uniRecvHandlesLive: number;
	};
	/** Leak-forensics: futures currently parked per instrumented await
	 * (absent on older prebuilt addons). Diagnostic only. */
	nativeAwaitProbeSnapshot?: () => Record<string, number>;
	/** Force-return freed native allocator memory to the OS (absent on older prebuilt addons). */
	releaseNativeMemory?: () => boolean;
	/** 0-RTT vault (absent on older prebuilt addons). */
	exportZeroRttVault?(
		optsJson: string,
		serverName?: string | null,
	): string | null;
	importZeroRttVault?(optsJson: string, token: string): boolean;
}
interface NativeConnectOnlyAddon {
	connect(
		url: string,
		optsJson: string,
		onClosed: (events: NativeClientSessionEvent[]) => void,
		cb: (err: unknown, handleId?: string) => void,
	): void;
	takeClientSession(handleId: string): NativeConnectSessionHandle | undefined;
}

function tryLoadNativeAddon(
	requireFn: RequireLike,
	bases = basePaths,
	candidates = binaryCandidates,
	explicitRequests: string[] = [],
): NativeLoadResult {
	const failures: NativeLoadFailure[] = [];
	for (const request of explicitRequests) {
		try {
			return { addon: requireFn(request) as NativeAddon, failures };
		} catch (err) {
			failures.push({
				request,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (explicitRequests.length > 0) {
		return { addon: undefined, failures };
	}
	for (const base of bases) {
		for (const candidate of candidates) {
			const request = `${base}/${candidate}`;
			try {
				return { addon: requireFn(request) as NativeAddon, failures };
			} catch (err) {
				failures.push({
					request,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
	return { addon: undefined, failures };
}

function nativeAddonOverrideRequestsFromEnv(
	envValue = process.env[NATIVE_ADDON_OVERRIDE_ENV],
): string[] {
	const trimmed = envValue?.trim();
	return trimmed ? [trimmed] : [];
}

function buildNativeAddonLoadErrorMessage(
	failures: NativeLoadFailure[],
	maxEntries = 6,
): string {
	if (failures.length === 0) {
		return "Native addon not loaded; no load attempts were recorded.";
	}
	const shown = failures.slice(0, maxEntries);
	const details = shown.map((f) => `- ${f.request}: ${f.message}`).join("\n");
	const omitted = failures.length - shown.length;
	const suffix = omitted > 0 ? `\n- ... and ${omitted} more attempt(s)` : "";
	return `Native addon not loaded. Candidate load errors:\n${details}${suffix}`;
}

const nativeLoad = tryLoadNativeAddon(
	_require,
	basePaths,
	binaryCandidates,
	nativeAddonOverrideRequestsFromEnv(),
);
const native = nativeLoad.addon as NativeAddon | undefined;
const nativeLoadFailures = nativeLoad.failures;

function getNativeOrThrow(): NativeAddon {
	if (native) return native;
	throw new Error(buildNativeAddonLoadErrorMessage(nativeLoadFailures));
}

// ---------------------------------------------------------------------------
// Server session implementation
// ---------------------------------------------------------------------------

class NativeServerSession implements ServerSession {
	#nativeHandle: NativeSessionHandle;
	#closedPromise: Promise<CloseInfo>;
	#closed = false;
	#requestedCloseInfo: CloseInfo | null = null;
	#streamOpenWaitTimeoutMs: number;
	#incomingDatagramsCache: AsyncIterable<Uint8Array> | null = null;
	#drainingPromise: Promise<void> | null = null;
	#incomingBidiCache: ReadableStream<WebTransportBidirectionalStream> | null =
		null;
	#incomingUniCache: ReadableStream<WebTransportReceiveStream> | null = null;

	#has0Rtt: boolean;
	#handshakeConfirmedLatch = false;

	constructor(
		nativeHandle: NativeSessionHandle,
		closedPromise: Promise<CloseInfo>,
		streamOpenWaitTimeoutMs: number,
	) {
		this.#nativeHandle = nativeHandle;
		this.#streamOpenWaitTimeoutMs = streamOpenWaitTimeoutMs;
		// Snapshot: fixed for the session's lifetime, and must survive the
		// native registry entry being removed at close.
		this.#has0Rtt = nativeHandle.has0Rtt ?? false;
		this.#closedPromise = closedPromise.then((info) =>
			normalizeCloseInfo(info, this.#requestedCloseInfo ?? undefined),
		);
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

	get has0Rtt(): boolean {
		return this.#has0Rtt;
	}

	get accepted0Rtt(): boolean {
		// Server side: a request readable from early data was accepted.
		return this.#has0Rtt;
	}

	get handshakeConfirmed(): boolean {
		if (!this.#handshakeConfirmedLatch) {
			this.#handshakeConfirmedLatch =
				this.#nativeHandle.handshakeConfirmed ?? true;
		}
		return this.#handshakeConfirmedLatch;
	}

	get ready(): Promise<void> {
		// Server sessions are already handshake-complete when onSession fires
		return Promise.resolve();
	}

	get closed(): Promise<CloseInfo> {
		return this.#closedPromise;
	}

	get draining(): Promise<void> {
		// Raced against `closed` so a session that ends without the peer ever
		// draining does not leave this pending forever. An older prebuilt addon
		// has no waitDraining, in which case close is the only signal available.
		this.#drainingPromise ??= Promise.race(
			[
				this.#nativeHandle.waitDraining?.(),
				this.#closedPromise.then(
					() => undefined,
					() => undefined,
				),
			].filter((p): p is Promise<void> => p !== undefined),
		);
		return this.#drainingPromise;
	}

	close(info?: CloseInfo): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#requestedCloseInfo = normalizeCloseInfo(info);
			this.#nativeHandle.close(info?.code ?? null, info?.reason ?? null);
		}
	}

	drain(): void {
		if (!this.#closed) this.#nativeHandle.drain?.();
	}

	goAway(): void {
		if (!this.#closed) this.#nativeHandle.goAway?.();
	}

	async sendDatagram(data: Uint8Array): Promise<void> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			unwrapNativeVoid(await this.#nativeHandle.sendDatagram(buf));
		} catch (err) {
			throw toWebTransportError(err);
		}
	}

	incomingDatagrams(): AsyncIterable<Uint8Array> {
		if (!this.#incomingDatagramsCache) {
			const session = this;
			this.#incomingDatagramsCache = (async function* () {
				while (!session.#closed) {
					try {
						const datagram = await session.#nativeHandle.readDatagram();
						if (!datagram) break;
						yield datagram;
					} catch (err) {
						if (isSessionCloseError(err)) break;
						throw toWebTransportError(err);
					}
				}
			})();
		}
		return this.#incomingDatagramsCache;
	}

	/** @internal Consume one queued datagram without materializing its payload. */
	async discardIncomingDatagram(
		timeoutMs?: number,
	): Promise<boolean | null | undefined> {
		if (!this.#nativeHandle.discardDatagram) return undefined;
		if (this.#closed) return null;
		try {
			return await this.#nativeHandle.discardDatagram(timeoutMs);
		} catch (err) {
			if (isSessionCloseError(err)) return null;
			throw toWebTransportError(err);
		}
	}

	/** @internal Consume queued datagrams without materializing payloads. */
	async discardIncomingDatagrams(
		timeoutMs?: number,
	): Promise<number | null | undefined> {
		if (!this.#nativeHandle.discardDatagrams) return undefined;
		if (this.#closed) return null;
		try {
			return await this.#nativeHandle.discardDatagrams(timeoutMs);
		} catch (err) {
			if (isSessionCloseError(err)) return null;
			throw toWebTransportError(err);
		}
	}

	/** @internal Consume accepted bidi streams without materializing wrappers. */
	async discardIncomingBidiStreams(
		timeoutMs?: number,
	): Promise<number | null | undefined> {
		if (!this.#nativeHandle.discardBidiStreams) return undefined;
		if (this.#closed) return null;
		try {
			return await this.#nativeHandle.discardBidiStreams(timeoutMs);
		} catch (err) {
			if (isSessionCloseError(err)) return null;
			throw toWebTransportError(err);
		}
	}

	/** @internal Consume accepted uni streams without materializing wrappers. */
	async discardIncomingUniStreams(
		timeoutMs?: number,
	): Promise<number | null | undefined> {
		if (!this.#nativeHandle.discardUniStreams) return undefined;
		if (this.#closed) return null;
		try {
			return await this.#nativeHandle.discardUniStreams(timeoutMs);
		} catch (err) {
			if (isSessionCloseError(err)) return null;
			throw toWebTransportError(err);
		}
	}

	/** @internal Load/evidence path: handle one ordered bidi probe in Rust. */
	async __handleIncomingBidiProbe(): Promise<boolean> {
		if (this.#closed) return false;
		try {
			return (await this.#nativeHandle.handleBidiProbe?.()) ?? false;
		} catch (err) {
			if (isSessionCloseError(err)) return false;
			throw toWebTransportError(err);
		}
	}

	/** @internal Load/evidence path: handle one ordered uni probe in Rust. */
	async __handleIncomingUniProbe(): Promise<number> {
		if (this.#closed) return 0;
		try {
			return (await this.#nativeHandle.handleUniProbe?.()) ?? 0;
		} catch (err) {
			if (isSessionCloseError(err)) return 0;
			throw toWebTransportError(err);
		}
	}

	/** @internal Switch subsequent load streams to the native discard path. */
	__enableIncomingBidiDiscard(): void {
		this.#nativeHandle.enableBidiDiscard?.();
	}

	/** @internal Switch subsequent load streams to the native discard path. */
	__enableIncomingUniDiscard(): void {
		this.#nativeHandle.enableUniDiscard?.();
	}

	async createBidirectionalStream(
		options?: StreamOpenOptions,
	): Promise<Duplex> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = (await openStreamWithWait(
				() => this.#nativeHandle.createBidiStream().then(unwrapNativeValue),
				options,
				this.#streamOpenWaitTimeoutMs,
				() => this.#closed,
				boundNativeCapacityWait(this.#nativeHandle, "bidi"),
			)) as any;
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
				this.#closedPromise,
			);
		}
		return this.#incomingBidiCache;
	}

	async createUnidirectionalStream(
		options?: StreamOpenOptions,
	): Promise<Writable> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = (await openStreamWithWait(
				() => this.#nativeHandle.createUniStream().then(unwrapNativeValue),
				options,
				this.#streamOpenWaitTimeoutMs,
				() => this.#closed,
				boundNativeCapacityWait(this.#nativeHandle, "uni"),
			)) as any;
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
				this.#closedPromise,
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
 * @returns WebTransportServer with address, live TLS management methods, `close()`, and `metricsSnapshot()`.
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
	warnIfLeakyBunRuntime();
	const native = getNativeOrThrow();

	const decodePem = (value: string | Uint8Array | undefined): string =>
		typeof value === "string"
			? value
			: value != null
				? new TextDecoder().decode(value)
				: "";
	const certPem = decodePem(opts.tls.certPem);
	const keyPem = decodePem(opts.tls.keyPem);
	if (
		process.env.NODE_ENV === "production" &&
		opts.tls.allowSelfSigned !== true &&
		(certPem.trim().length === 0 || keyPem.trim().length === 0)
	) {
		throw new WebTransportError(
			E_TLS as ErrorCode,
			"E_TLS: empty certPem/keyPem is not allowed in production (set tls.allowSelfSigned=true to override)",
		);
	}
	const caPem = decodePem(opts.tls.caPem);
	const tlsConfigToJson = (tls: TlsOptions): string =>
		JSON.stringify({
			certPem: decodePem(tls.certPem),
			keyPem: decodePem(tls.keyPem),
			caPem: decodePem(tls.caPem),
			unknownSniPolicy: tls.unknownSniPolicy,
			sni:
				tls.sni?.map((entry) => ({
					serverName: entry.serverName,
					certPem: decodePem(entry.certPem),
					keyPem: decodePem(entry.keyPem),
				})) ?? [],
		});

	if (
		opts.congestionControl !== undefined &&
		!VALID_CONGESTION.has(opts.congestionControl)
	) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			`E_INVALID_ARGUMENT: congestionControl must be "default", "throughput", or "low-latency", got "${opts.congestionControl}"`,
		);
	}

	validateQpackOptions(opts);

	const mergedLimits = { ...DEFAULT_LIMITS, ...opts.limits };
	const limitsJson = JSON.stringify(mergedLimits);
	const serverOptsJson = JSON.stringify({
		congestionControl: opts.congestionControl ?? "default",
		enable0Rtt: opts.enable0Rtt === true,
		allowEarlySession: opts.allowEarlySession === true,
		...(opts.qpackMaxTableCapacity === undefined
			? {}
			: { qpackMaxTableCapacity: opts.qpackMaxTableCapacity }),
		...(opts.enableDynamicQpack === undefined
			? {}
			: { enableDynamicQpack: opts.enableDynamicQpack }),
	});
	const rateLimitsJson = JSON.stringify({
		...DEFAULT_RATE_LIMITS,
		...opts.rateLimits,
	});

	const closedResolvers = new Map<string, (info: CloseInfo) => void>();
	let activeOnSessionCallbacks = 0;
	let onSessionDrainResolve: (() => void) | null = null;

	const emitUserLog = (event: LogEvent): void => {
		if (!opts.log) return;
		try {
			opts.log(event);
		} catch (err) {
			if (!SUPPRESS_LOG_CALLBACK_WARN) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[webtransport] log callback failed: ${msg}`);
			}
		}
	};

	const logCallback = (logEvents: NativeLogEvent[]) => {
		for (const le of logEvents) {
			emitUserLog({
				level: le.level ?? "info",
				msg: le.msg ?? "",
				sessionId: le.sessionId,
				peerIp: le.peerIp,
				peerPort: le.peerPort,
			});
		}
	};

	const handle = new native.ServerHandle(
		opts.port,
		opts.host ?? "0.0.0.0",
		opts.debug === true,
		tlsConfigToJson(opts.tls),
		limitsJson,
		rateLimitsJson,
		serverOptsJson,
		(events: NativeServerSessionEvent[]) => {
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
					const session = new NativeServerSession(
						nativeSession,
						closedPromise,
						mergedLimits.backpressureTimeoutMs,
					);
					activeOnSessionCallbacks++;
					let maybePromise: void | Promise<void>;
					try {
						maybePromise = opts.onSession(session);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						session.close({
							code: 0,
							reason: `onSession callback threw: ${msg}`,
						});
						emitUserLog({
							level: "error",
							msg: `E_INVALID_ARGUMENT: onSession callback threw: ${msg}`,
							sessionId: evt.id,
							peerIp: evt.peerIp,
							peerPort: evt.peerPort,
						});
						onSessionCallbackDone();
						continue;
					}
					if (maybePromise && typeof maybePromise.then === "function") {
						maybePromise.then(onSessionCallbackDone, (err) => {
							const msg = err instanceof Error ? err.message : String(err);
							session.close({
								code: 0,
								reason: `onSession callback rejected: ${msg}`,
							});
							emitUserLog({
								level: "error",
								msg: `E_INVALID_ARGUMENT: onSession callback rejected: ${msg}`,
								sessionId: evt.id,
								peerIp: evt.peerIp,
								peerPort: evt.peerPort,
							});
							onSessionCallbackDone();
						});
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
		congestionControl: opts.congestionControl ?? "default",
		updateCert: async (tls) => {
			const nextCertPem = decodePem(tls.certPem);
			const nextKeyPem = decodePem(tls.keyPem);
			await handle.updateCert(nextCertPem, nextKeyPem);
		},
		updateTls: async (tls) => {
			await handle.updateTls(tlsConfigToJson(tls));
		},
		replaceSniCerts: async (sni) => {
			await handle.replaceSniCerts(
				JSON.stringify(
					sni.map((entry) => ({
						serverName: entry.serverName,
						certPem: decodePem(entry.certPem),
						keyPem: decodePem(entry.keyPem),
					})),
				),
			);
		},
		upsertSniCert: async (entry) => {
			await handle.upsertSniCert(
				entry.serverName,
				decodePem(entry.certPem),
				decodePem(entry.keyPem),
			);
		},
		removeSniCert: async (serverName) => {
			await handle.removeSniCert(serverName);
		},
		setUnknownSniPolicy: async (policy) => {
			await handle.setUnknownSniPolicy(policy);
		},
		tlsSnapshot: () => handle.tlsSnapshot(),
		close: async () => {
			await handle.close();
			for (const [id, resolve] of closedResolvers) {
				closedResolvers.delete(id);
				resolve({ code: 0, reason: "server closed" });
			}
			if (activeOnSessionCallbacks > 0) {
				// Clear the timeout timer if the drain wins the race, so it does
				// not keep the event loop alive up to 5s after close() resolves.
				let drainTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						new Promise<void>((r) => {
							onSessionDrainResolve = r;
						}),
						new Promise<void>((r) => {
							drainTimer = setTimeout(r, 5000);
						}),
					]);
				} finally {
					if (drainTimer !== undefined) clearTimeout(drainTimer);
				}
			}
		},
		metricsSnapshot: () => handle.metricsSnapshot(),
	};
}

// ---------------------------------------------------------------------------
// Client session implementation
// ---------------------------------------------------------------------------

class NativeClientSession implements ClientSession {
	#nativeHandle: NativeSessionHandle;
	#readyPromise: Promise<void>;
	#closedPromise: Promise<CloseInfo>;
	#closed = false;
	#requestedCloseInfo: CloseInfo | null = null;
	#strictW3CErrors: boolean;
	#streamOpenWaitTimeoutMs: number;
	#incomingDatagramsCache: AsyncIterable<Uint8Array> | null = null;
	#drainingPromise: Promise<void> | null = null;

	constructor(
		nativeHandle: NativeSessionHandle,
		readyPromise: Promise<void>,
		closedPromise: Promise<CloseInfo>,
		strictW3CErrors = false,
		streamOpenWaitTimeoutMs = DEFAULT_LIMITS.backpressureTimeoutMs,
	) {
		this.#nativeHandle = nativeHandle;
		this.#readyPromise = readyPromise;
		this.#closedPromise = closedPromise.then((info) =>
			normalizeCloseInfo(info, this.#requestedCloseInfo ?? undefined),
		);
		this.#strictW3CErrors = strictW3CErrors;
		this.#streamOpenWaitTimeoutMs = streamOpenWaitTimeoutMs;
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

	get has0Rtt(): boolean {
		return this.#nativeHandle.has0Rtt ?? false;
	}

	get accepted0Rtt(): boolean {
		return this.#nativeHandle.accepted0Rtt ?? false;
	}

	get handshakeConfirmed(): boolean {
		return this.#nativeHandle.handshakeConfirmed ?? true;
	}

	get ready(): Promise<void> {
		return this.#readyPromise;
	}

	get closed(): Promise<CloseInfo> {
		return this.#closedPromise;
	}

	get draining(): Promise<void> {
		// Raced against `closed` so a session that ends without the peer ever
		// draining does not leave this pending forever. An older prebuilt addon
		// has no waitDraining, in which case close is the only signal available.
		this.#drainingPromise ??= Promise.race(
			[
				this.#nativeHandle.waitDraining?.(),
				this.#closedPromise.then(
					() => undefined,
					() => undefined,
				),
			].filter((p): p is Promise<void> => p !== undefined),
		);
		return this.#drainingPromise;
	}

	close(info?: CloseInfo): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#requestedCloseInfo = normalizeCloseInfo(info);
			this.#nativeHandle.close(info?.code ?? null, info?.reason ?? null);
		}
	}

	drain(): void {
		if (!this.#closed) this.#nativeHandle.drain?.();
	}

	async sendDatagram(data: Uint8Array): Promise<void> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			unwrapNativeVoid(await this.#nativeHandle.sendDatagram(buf));
		} catch (err) {
			throw toWebTransportError(err, this.#strictW3CErrors);
		}
	}

	incomingDatagrams(): AsyncIterable<Uint8Array> {
		if (!this.#incomingDatagramsCache) {
			const session = this;
			this.#incomingDatagramsCache = (async function* () {
				while (!session.#closed) {
					try {
						const dgram = await session.#nativeHandle.readDatagram();
						if (!dgram) break;
						yield dgram;
					} catch (err) {
						if (isSessionCloseError(err)) break;
						throw toWebTransportError(err, session.#strictW3CErrors);
					}
				}
			})();
		}
		return this.#incomingDatagramsCache;
	}

	async createBidirectionalStream(
		options?: StreamOpenOptions,
	): Promise<Duplex> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = (await openStreamWithWait(
				() => this.#nativeHandle.createBidiStream().then(unwrapNativeValue),
				options,
				this.#streamOpenWaitTimeoutMs,
				() => this.#closed,
				boundNativeCapacityWait(this.#nativeHandle, "bidi") ??
					createPollingCapacityWaiter(() => this.#closed),
				this.#strictW3CErrors,
			)) as any;
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
			} catch (err) {
				if (isSessionCloseError(err)) break;
				throw toWebTransportError(err, this.#strictW3CErrors);
			}
		}
	}

	async createUnidirectionalStream(
		options?: StreamOpenOptions,
	): Promise<Writable> {
		if (this.#closed)
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		try {
			const nativeStream = (await openStreamWithWait(
				() => this.#nativeHandle.createUniStream().then(unwrapNativeValue),
				options,
				this.#streamOpenWaitTimeoutMs,
				() => this.#closed,
				boundNativeCapacityWait(this.#nativeHandle, "uni") ??
					createPollingCapacityWaiter(() => this.#closed),
				this.#strictW3CErrors,
			)) as any;
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
			} catch (err) {
				if (isSessionCloseError(err)) break;
				throw toWebTransportError(err, this.#strictW3CErrors);
			}
		}
	}

	metricsSnapshot(): SessionMetricsSnapshot {
		return this.#nativeHandle.metricsSnapshot();
	}

	/** Wire-level QUIC stats from the native layer, or null when unavailable. */
	/** @internal */
	_connectionStats(): QuicConnectionStats | null {
		return typeof this.#nativeHandle.connectionStats === "function"
			? (this.#nativeHandle.connectionStats() ?? null)
			: null;
	}

	/** Current path MTU-derived max datagram payload size, or null when unknown. */
	/** @internal */
	_pathMaxDatagramSize(): number | null {
		return typeof this.#nativeHandle.pathMaxDatagramSize === "function"
			? (this.#nativeHandle.pathMaxDatagramSize() ?? null)
			: null;
	}
}

/** Wire-level QUIC connection stats reported by the native layer. */
export interface QuicConnectionStats {
	rttMs: number;
	bytesSent: number;
	bytesReceived: number;
	packetsSent: number;
	packetsReceived: number;
	packetsLost: number;
	maxDatagramSize?: number | null;
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

function validateConnectUrl(url: string, strictW3CErrors?: boolean): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (err) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			`E_INVALID_ARGUMENT: connect URL is invalid: ${
				err instanceof Error ? err.message : String(err)
			}`,
			strictW3CErrors,
		);
	}
	if (parsed.protocol !== "https:") {
		throw createMappedError(
			E_UNSUPPORTED_ARGUMENT as ErrorCode,
			`E_UNSUPPORTED_ARGUMENT: connect only supports https URLs, got ${parsed.protocol}`,
			strictW3CErrors,
		);
	}
	if (!parsed.hostname) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: connect URL must include a host",
			strictW3CErrors,
		);
	}
}

function connectWithNative(
	native: NativeConnectOnlyAddon,
	url: string,
	optsJson: string,
	handshakeTimeout: number,
	strictW3CErrors?: boolean,
	streamOpenWaitTimeoutMs = DEFAULT_LIMITS.backpressureTimeoutMs,
	setTimer: (cb: () => void, ms: number) => any = (cb, ms) =>
		setTimeout(cb, ms),
	clearTimer: (handle: any) => void = (handle) => clearTimeout(handle),
): Promise<ClientSession> {
	return new Promise<ClientSession>((resolve, reject) => {
		const closedResolvers = new Map<string, (info: CloseInfo) => void>();
		let settled = false;
		let timeoutHandle: any;

		const settleResolve = (session: ClientSession): void => {
			if (settled) return;
			settled = true;
			clearTimer(timeoutHandle);
			resolve(session);
		};

		const settleReject = (err: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimer(timeoutHandle);
			reject(err);
		};

		const onClosed = (events: NativeClientSessionEvent[]) => {
			for (const evt of events) {
				if (evt.name === "session_closed" && evt.id != null) {
					const resolveClosed = closedResolvers.get(evt.id);
					closedResolvers.delete(evt.id);
					if (resolveClosed)
						resolveClosed({ code: evt.code, reason: evt.reason });
				}
			}
		};

		timeoutHandle = setTimer(() => {
			const msg = `E_HANDSHAKE_TIMEOUT: connect timed out after ${handshakeTimeout}ms`;
			const browserName =
				strictW3CErrors === true
					? (normalizeToBrowserName(E_HANDSHAKE_TIMEOUT as ErrorCode) ??
						undefined)
					: undefined;
			settleReject(
				new WebTransportError(
					E_HANDSHAKE_TIMEOUT as ErrorCode,
					msg,
					browserName ? { browserName } : undefined,
				),
			);
		}, handshakeTimeout);

		native.connect(
			url,
			optsJson,
			onClosed,
			(err: unknown, handleId?: string) => {
				if (err) {
					settleReject(toWebTransportError(err, strictW3CErrors));
					return;
				}
				if (handleId == null) {
					settleReject(new Error("connect succeeded but no handle id"));
					return;
				}
				const handle = native.takeClientSession(handleId);
				if (!handle) {
					settleReject(new Error("connect: handle not found in registry"));
					return;
				}
				if (settled) {
					try {
						handle.close?.(0, "late connect completion after timeout");
					} catch (closeErr) {
						const msg =
							closeErr instanceof Error ? closeErr.message : String(closeErr);
						console.warn(
							`[webtransport] late connect orphan cleanup failed: ${msg}`,
						);
					}
					return;
				}
				let closedResolve!: (info: CloseInfo) => void;
				const closedPromise = new Promise<CloseInfo>((r) => {
					closedResolve = r;
				});
				closedResolvers.set(handle.id, closedResolve);
				settleResolve(
					new NativeClientSession(
						handle as NativeSessionHandle,
						Promise.resolve(),
						closedPromise,
						strictW3CErrors,
						streamOpenWaitTimeoutMs,
					),
				);
			},
		);
	});
}

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
function mapClientTlsOptions(tls: ClientOptions["tls"]):
	| {
			insecureSkipVerify: boolean;
			caPem: string | undefined;
			serverName: string | undefined;
	  }
	| undefined {
	if (!tls) return undefined;
	return {
		insecureSkipVerify: tls.insecureSkipVerify ?? false,
		caPem: tls.caPem
			? typeof tls.caPem === "string"
				? tls.caPem
				: new TextDecoder().decode(tls.caPem)
			: undefined,
		serverName: tls.serverName,
	};
}

/** JSON identity payload the native 0-RTT vault keys client state by. */
function clientIdentityOptsJson(opts?: ClientOptions): string {
	return JSON.stringify({
		tls: mapClientTlsOptions(opts?.tls),
		serverCertificateHashes: mapServerCertificateHashes(
			opts?.serverCertificateHashes,
		),
	});
}

/**
 * Drain this process's in-memory 0-RTT tickets for a client identity
 * (optionally scoped to one server name) into an opaque vault. Returns a
 * token to pass to {@link importTicketVault}, or null when there is nothing
 * to export. Tokens reference live in-process state only — they are NOT
 * durable and mean nothing after a process restart.
 */
export function exportTicketVault(
	opts?: ClientOptions,
	serverName?: string,
): string | null {
	const native = getNativeOrThrow();
	if (typeof native.exportZeroRttVault !== "function") return null;
	return native.exportZeroRttVault(
		clientIdentityOptsJson(opts),
		serverName ?? null,
	);
}

/**
 * Import a vault previously produced by {@link exportTicketVault} into a
 * client identity's ticket store. Consumes the token; returns false when the
 * token is unknown or already used.
 */
export function importTicketVault(
	token: string,
	opts?: ClientOptions,
): boolean {
	const native = getNativeOrThrow();
	if (typeof native.importZeroRttVault !== "function") return false;
	return native.importZeroRttVault(clientIdentityOptsJson(opts), token);
}

export async function connect(
	url: string,
	opts?: ClientOptions,
): Promise<ClientSession> {
	warnIfLeakyBunRuntime();
	const native = getNativeOrThrow();
	validateConnectUrl(url, opts?.strictW3CErrors);
	const serverCertificateHashes = mapServerCertificateHashes(
		opts?.serverCertificateHashes,
	);
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

	if (opts?.serverCertificateHashes !== undefined) {
		validateServerCertificateHashes(
			opts.serverCertificateHashes,
			opts?.strictW3CErrors,
		);
	}
	if (opts !== undefined) {
		validateQpackOptions(opts, opts.strictW3CErrors);
	}
	const mergedLimits = { ...DEFAULT_LIMITS, ...opts?.limits };
	const tlsOpts = mapClientTlsOptions(opts?.tls);
	const optsJson = JSON.stringify({
		limits: mergedLimits,
		tls: tlsOpts,
		congestionControl: opts?.congestionControl,
		serverCertificateHashes: serverCertificateHashes,
		allowPooling: opts?.allowPooling,
		requireUnreliable: opts?.requireUnreliable,
		enable0Rtt: opts?.enable0Rtt,
		qpackMaxTableCapacity: opts?.qpackMaxTableCapacity,
		enableDynamicQpack: opts?.enableDynamicQpack,
	});

	const handshakeTimeout = mergedLimits.handshakeTimeoutMs;
	return connectWithNative(
		native,
		url,
		optsJson,
		handshakeTimeout,
		opts?.strictW3CErrors,
		mergedLimits.backpressureTimeoutMs,
	);
}

/** Client pool metrics (hits, misses, evictions). For tests when allowPooling is used. */
export function clientPoolMetricsSnapshot(): {
	hits: number;
	misses: number;
	evictIdle: number;
	evictBroken: number;
} {
	const native = getNativeOrThrow();
	const s = native.clientPoolMetricsSnapshot();
	return {
		hits: s.hits,
		misses: s.misses,
		evictIdle: (s as any).evictIdle ?? (s as any).evict_idle ?? 0,
		evictBroken: (s as any).evictBroken ?? (s as any).evict_broken ?? 0,
	};
}

/**
 * Force-return freed native allocator memory to the OS.
 *
 * Never required for correctness. Useful for long-lived servers after load
 * spikes and for memory evidence: the native allocator (mimalloc) retains
 * freed pages briefly for reuse, and this purges them immediately across the
 * native runtime threads. Returns false when the loaded addon predates the
 * capability.
 */
export function releaseNativeMemory(): boolean {
	const native = getNativeOrThrow();
	return native.releaseNativeMemory?.() ?? false;
}

// ---------------------------------------------------------------------------
// Browser-style WebTransport facade (Phase P1)
// ---------------------------------------------------------------------------

function validateServerCertificateHashes(
	arr: unknown,
	strictW3CErrors?: boolean,
): void {
	if (!Array.isArray(arr)) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: serverCertificateHashes must be an array",
			strictW3CErrors,
		);
	}
	if (arr.length === 0) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: serverCertificateHashes must be a non-empty array",
			strictW3CErrors,
		);
	}
	for (const entry of arr) {
		if (entry.algorithm !== "sha-256") {
			throw createMappedError(
				E_UNSUPPORTED_ARGUMENT as ErrorCode,
				`E_UNSUPPORTED_ARGUMENT: serverCertificateHashes only supports algorithm "sha-256", got "${entry.algorithm}"`,
				strictW3CErrors,
			);
		}
		if (
			!(entry.value instanceof ArrayBuffer) &&
			!ArrayBuffer.isView(entry.value)
		) {
			throw createMappedError(
				E_INVALID_ARGUMENT as ErrorCode,
				"E_INVALID_ARGUMENT: serverCertificateHashes entry value must be BufferSource",
				strictW3CErrors,
			);
		}
		// A SHA-256 digest is exactly 32 bytes. The previous check inspected
		// `entry` (the wrapper) for a `byteLength` it never has, so empty or
		// malformed hashes passed straight through to the native pin path.
		if (entry.value.byteLength !== 32) {
			throw createMappedError(
				E_INVALID_ARGUMENT as ErrorCode,
				`E_INVALID_ARGUMENT: serverCertificateHashes sha-256 value must be exactly 32 bytes, got ${entry.value.byteLength}`,
				strictW3CErrors,
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
		E_INVALID_ARGUMENT as ErrorCode,
		"E_INVALID_ARGUMENT: serverCertificateHashes entry value must be BufferSource",
	);
}

function mapServerCertificateHashes(
	hashes?: Array<{ algorithm: "sha-256"; value: BufferSource }>,
): Array<{ algorithm: "sha-256"; value: number[] }> | undefined {
	if (hashes === undefined) return;
	return hashes.map((entry) => ({
		algorithm: entry.algorithm,
		value: Array.from(bufferSourceToUint8(entry.value)),
	}));
}

const VALID_CONGESTION = new Set(["default", "throughput", "low-latency"]);
/** Hard cap on advertised QPACK dynamic-table capacity (mirrors the native `MAX_QPACK_TABLE_CAPACITY`, 64 KiB). */
const MAX_QPACK_TABLE_CAPACITY = 65536;
const VALID_DATAGRAMS_READABLE_TYPE = new Set(["bytes", "default"]);

/**
 * Both QPACK options, validated the same way on the server and the client.
 * A capacity above the cap is rejected rather than clamped: silently
 * advertising something other than what was asked for would be a worse answer
 * than saying no.
 */
function validateQpackOptions(
	opts: {
		qpackMaxTableCapacity?: number;
		enableDynamicQpack?: boolean;
	},
	strictW3CErrors?: boolean,
): void {
	if (
		opts.enableDynamicQpack !== undefined &&
		typeof opts.enableDynamicQpack !== "boolean"
	) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: enableDynamicQpack must be a boolean",
			strictW3CErrors,
		);
	}
	const cap = opts.qpackMaxTableCapacity;
	if (
		cap !== undefined &&
		(!Number.isInteger(cap) || cap < 0 || cap > MAX_QPACK_TABLE_CAPACITY)
	) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			`E_INVALID_ARGUMENT: qpackMaxTableCapacity must be an integer between 0 and ${MAX_QPACK_TABLE_CAPACITY}, got ${cap}`,
			strictW3CErrors,
		);
	}
}

function validateClientOptions(
	opts?: WebTransportClientOptions,
	strictW3CErrors?: boolean,
): void {
	if (!opts) return;
	if (
		opts.allowPooling !== undefined &&
		typeof opts.allowPooling !== "boolean"
	) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: allowPooling must be a boolean",
			strictW3CErrors,
		);
	}
	if (
		opts.requireUnreliable !== undefined &&
		typeof opts.requireUnreliable !== "boolean"
	) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: requireUnreliable must be a boolean",
			strictW3CErrors,
		);
	}
	if (
		opts.congestionControl !== undefined &&
		!VALID_CONGESTION.has(opts.congestionControl)
	) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			`E_INVALID_ARGUMENT: congestionControl must be "default", "throughput", or "low-latency", got "${opts.congestionControl}"`,
			strictW3CErrors,
		);
	}
	if (
		opts.datagramsReadableType !== undefined &&
		!VALID_DATAGRAMS_READABLE_TYPE.has(opts.datagramsReadableType)
	) {
		throw createMappedError(
			E_INVALID_ARGUMENT as ErrorCode,
			`E_INVALID_ARGUMENT: datagramsReadableType must be "bytes" or "default", got "${opts.datagramsReadableType}"`,
			strictW3CErrors,
		);
	}
	if (opts.serverCertificateHashes !== undefined) {
		if (!Array.isArray(opts.serverCertificateHashes)) {
			throw createMappedError(
				E_INVALID_ARGUMENT as ErrorCode,
				"E_INVALID_ARGUMENT: serverCertificateHashes must be an array",
				strictW3CErrors,
			);
		}
		// An empty array is a silent pinning downgrade: the consumer asked for
		// cert pinning but supplied no hashes. Reject rather than fall back to
		// accept-any.
		if (opts.serverCertificateHashes.length === 0) {
			throw createMappedError(
				E_INVALID_ARGUMENT as ErrorCode,
				"E_INVALID_ARGUMENT: serverCertificateHashes must be a non-empty array",
				strictW3CErrors,
			);
		}
		if (opts.allowPooling === true) {
			// W3C mandates NotSupportedError for this combination regardless of
			// the strict flag (asserted by parity-compat) — intentionally not
			// gated on strictW3CErrors.
			throw createMappedError(
				E_UNSUPPORTED_ARGUMENT as ErrorCode,
				"E_UNSUPPORTED_ARGUMENT: serverCertificateHashes cannot be used with allowPooling=true",
				true,
			);
		}
		validateServerCertificateHashes(
			opts.serverCertificateHashes,
			strictW3CErrors,
		);
	}
}

function mapToClientOptions(opts?: WebTransportClientOptions): ClientOptions {
	if (!opts) return {};
	validateClientOptions(opts, opts.strictW3CErrors);
	return {
		tls: opts.tls,
		limits: opts.limits,
		congestionControl: opts.congestionControl,
		strictW3CErrors: opts.strictW3CErrors,
		serverCertificateHashes: opts.serverCertificateHashes,
		allowPooling: opts.allowPooling,
		requireUnreliable: opts.requireUnreliable,
	};
}

function toCloseInfo(info: CloseInfo): WebTransportCloseInfo {
	const normalized = normalizeCloseInfo(info);
	return {
		closeCode: normalized.code,
		reason: normalized.reason,
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
			// Yield one microtask so writes enqueued in the same tick are all
			// visible and can be dispatched in sendOrder-priority order.
			await Promise.resolve();
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
				// Dispatch WITHOUT awaiting completion: QUIC streams are
				// independent, and per-stream write ordering is already
				// guaranteed by the WritableStream sink contract (the next
				// sink write starts only after this task's promise settles).
				// Awaiting here would head-of-line-block every other stream
				// and all datagrams behind one backpressured peer stream.
				// Backpressure is enforced per stream by the native layer.
				task.run().then(task.resolve, task.reject);
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
	/** Close info captured when close() races an in-flight connect. */
	#pendingCloseInfo: WebTransportCloseInfo | null = null;
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
	#strictW3CErrors = false;

	constructor(
		urlOrSession: string | ClientSession,
		options?: WebTransportClientOptions,
	) {
		if (typeof urlOrSession === "string") {
			this.#datagramsReadableType = options?.datagramsReadableType ?? "default";
			const requestedCongestion = options?.congestionControl ?? "default";
			this.#congestionControl = requestedCongestion;
			this.#strictW3CErrors = options?.strictW3CErrors ?? false;
			const clientOpts = mapToClientOptions(options);
			this.#sessionPromise = connect(urlOrSession, clientOpts);
			this.#state = "connecting";
			this.#ready = this.#sessionPromise.then(
				(s) => {
					this.#session = s;
					if (this.#state === "draining") {
						// close() was called while connecting: the session must not
						// outlive the transport. Close it now so `closed` settles and
						// the QUIC connection is released instead of leaking until
						// idle timeout.
						s.close({
							code: this.#pendingCloseInfo?.closeCode,
							reason: this.#pendingCloseInfo?.reason,
						});
					} else {
						this.#state = "connected";
					}
				},
				(err) => {
					this.#state = "failed";
					throw err;
				},
			);
			// Symmetric to `#closed` below: a consumer may observe only `closed`
			// (e.g. via nativeToWebTransportLike, which forwards `ready`
			// untouched) and never await `ready`. Attach a no-op handler so a
			// connect-failure rejection on `ready` does not surface as an
			// unhandled rejection (which aborts under
			// --unhandled-rejections=strict). The getter returns this same
			// rejecting promise, so awaiters still see the error.
			this.#ready.catch(() => {});
			this.#closed = this.#sessionPromise.then(
				(s) =>
					s.closed.then((info) => {
						this.#state = "closed";
						return toCloseInfo(info);
					}),
				(err) => {
					// Connect failed: per W3C, `closed` rejects with the same
					// error as `ready` (a resolved {closeCode:0} was
					// indistinguishable from a clean close). Keep the "failed"
					// state that the `ready` handler set — don't mask it as a
					// clean "closed", which callers like getStats() guard on.
					if (this.#state !== "failed") {
						this.#state = "closed";
					}
					throw err;
				},
			);
			// A consumer may await only `ready` (which also rejects on connect
			// failure); attach a no-op handler so the spec-correct `closed`
			// rejection does not surface as an unhandled rejection.
			this.#closed.catch(() => {});
		} else {
			this.#datagramsReadableType = options?.datagramsReadableType ?? "default";
			this.#congestionControl = options?.congestionControl ?? "default";
			this.#strictW3CErrors = options?.strictW3CErrors ?? false;
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
		// `draining` also resolves when the session enters its closing phase via a
		// remote/server-initiated close (not just local close()). Without this, a
		// consumer awaiting `draining` to detect server shutdown would hang
		// forever. `#drainingResolve` is idempotent, so a later local close() is
		// harmless. (Both settle paths handled so a connect-failure rejection
		// doesn't leave draining pending or surface unhandled.)
		this.#closed.then(
			() => this.#drainingResolve?.(),
			() => this.#drainingResolve?.(),
		);
		// And it resolves on the real wire signal: a peer that sends
		// WT_DRAIN_SESSION is saying the session is going away while leaving it
		// usable, which is the case the two paths above cannot see. The close
		// fallbacks stay — a peer that never drains must not hang consumers.
		this.#sessionPromise.then(
			(s) => {
				s.draining.then(
					() => this.#drainingResolve?.(),
					() => this.#drainingResolve?.(),
				);
			},
			() => {},
		);
	}

	/** Resolves when handshake completes. Rejects with WebTransportError on connect failure. */
	get ready(): Promise<void> {
		return this.#ready;
	}

	/**
	 * Resolves with close info when the session closes cleanly, and rejects
	 * with a `WebTransportError` when the connection fails to establish (same
	 * error as `ready`), per the W3C WebTransport spec.
	 */
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

	/** Datagram duplex stream (W3C WebTransportDatagramDuplexStream). Lazily initialized and cached. */
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
		waitUntilAvailable?: boolean;
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
		const duplex = await s.createBidirectionalStream(options);
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
			this.#strictW3CErrors,
		);
	}

	/**
	 * Create a unidirectional send stream (WritableStream).
	 * @throws WebTransportError E_SESSION_CLOSED if session is closed/draining/failed.
	 */
	async createUnidirectionalStream(options?: {
		sendOrder?: number;
		sendGroup?: WebTransportSendGroup | null;
		waitUntilAvailable?: boolean;
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
		const writable = await s.createUnidirectionalStream(options);
		return nodeWritableToWebWritable(
			writable,
			this.#sendScheduler,
			policy,
			(bytes) => {
				this.#connStats.bytesSent += bytes;
				this._recordSendGroupBytes(policy.groupId, bytes);
			},
			this.#strictW3CErrors,
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
		// If getStats() is called while still connecting and the connect then
		// fails, awaiting #sessionPromise rejects with the raw connect error;
		// surface the consistent InvalidStateError instead.
		const s = await this.#sessionPromise.catch(() => {
			throw new DOMException("Transport has failed", "InvalidStateError");
		});
		// Prefer wire-level QUIC stats from the native layer; fall back to
		// facade byte tallies only when the native call is unavailable.
		const quic = (
			s as unknown as { _connectionStats?: () => QuicConnectionStats | null }
		)._connectionStats?.();
		return {
			datagrams: {
				droppedIncoming: 0,
				expiredIncoming: 0,
				expiredOutgoing: 0,
				lostOutgoing: 0,
			},
			bytesSent: quic ? quic.bytesSent : this.#connStats.bytesSent,
			bytesReceived: quic ? quic.bytesReceived : this.#connStats.bytesReceived,
			packetsSent: quic ? quic.packetsSent : 0,
			packetsReceived: quic ? quic.packetsReceived : 0,
			smoothedRtt: quic ? quic.rttMs : undefined,
			packetsLost: quic ? quic.packetsLost : undefined,
			estimatedSendRate: null,
		};
	}

	/** Initiate graceful close. Idempotent after first call. */
	close(info?: WebTransportCloseInfo): void {
		this.#drainingResolve(); // Resolves draining as soon as close() is called
		if (this.#state === "connected" || this.#state === "connecting") {
			this.#state = "draining";
		}
		if (info) this.#pendingCloseInfo = info;
		if (this.#session) {
			this.#session.close({
				code: info?.closeCode,
				reason: info?.reason,
			});
		} else {
			// Still connecting: absorb eventual connect failure to prevent unhandled rejection (S4).
			this.#ready.catch((err) => {
				if (!SUPPRESS_READY_REJECTION_WARN) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[webtransport] ready rejection observed after close() during connect: ${msg}`,
					);
				}
			});
		}
	}

	/** @internal */
	async _getSession(): Promise<ClientSession> {
		return this.#sessionPromise;
	}

	/** Internal: MTU-derived datagram size from the live session, if connected */
	/** @internal */
	_getPathMaxDatagramSize(): number | null {
		const s = this.#session as unknown as {
			_pathMaxDatagramSize?: () => number | null;
		} | null;
		return s?._pathMaxDatagramSize?.() ?? null;
	}

	/** Internal: state for createWritable guard (not part of spec) */
	/** @internal */
	_getState(): WebTransportState {
		return this.#state;
	}

	/** @internal */
	_isStrictW3CErrors(): boolean {
		return this.#strictW3CErrors;
	}

	/** @internal */
	_resolveSendPolicy(options?: {
		sendOrder?: number;
		sendGroup?: WebTransportSendGroup | null;
		waitUntilAvailable?: boolean;
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

	/** @internal */
	_recordSendGroupBytes(groupId: number, bytes: number): void {
		this.#sendGroupBytesSent.set(
			groupId,
			(this.#sendGroupBytesSent.get(groupId) ?? 0) + bytes,
		);
	}

	/** @internal */
	async _getSendGroupStats(groupId: number): Promise<{
		bytesSent?: number;
		bytesAcknowledged?: number;
	}> {
		return {
			bytesSent: this.#sendGroupBytesSent.get(groupId) ?? 0,
		};
	}

	/** @internal */
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

	/** @internal */
	_recordIncomingDatagram(chunk: Uint8Array): void {
		this.#connStats.bytesReceived += chunk.byteLength;
		this.#connStats.datagramsIn += 1;
	}

	/** @internal */
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
			// Path-MTU-derived value from QUIC when connected; configured
			// default until the handshake completes.
			return wt._getPathMaxDatagramSize() ?? DEFAULT_LIMITS.maxDatagramSize;
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

type ServerIncomingStreamResource = {
	dispose(): void;
	reset(code?: number): void;
	stopSending(code?: number): void;
};

class ServerIncomingBidiResource implements ServerIncomingStreamResource {
	handle: NativeBidiStreamHandle | null;
	disposed = false;
	readableDone = false;
	writableDone = false;
	private writableStream: WritableStream<Uint8Array> | null = null;
	readonly onDisposed: (resource: ServerIncomingStreamResource) => void;

	constructor(
		nativeStream: NativeBidiStreamHandle,
		onDisposed: (resource: ServerIncomingStreamResource) => void,
	) {
		this.handle = nativeStream;
		this.onDisposed = onDisposed;
	}

	getWritable(): WritableStream<Uint8Array> {
		return (this.writableStream ??= new WritableStream<Uint8Array>(this));
	}

	release(abort: boolean, code = 0): void {
		if (this.disposed) return;
		this.disposed = true;
		const current = this.handle;
		this.handle = null;
		if (current) {
			if (abort) {
				try {
					current.stopSending?.(code);
				} catch {
					// Session teardown may already have closed the stream.
				}
				try {
					current.reset?.(code);
				} catch {
					// Session teardown may already have closed the stream.
				}
			}
			try {
				current.dispose?.();
			} catch {
				// Resource disposal is best-effort during stream teardown.
			}
		}
		this.onDisposed(this);
	}

	dispose(): void {
		this.release(true);
	}

	reset(code = 0): void {
		this.release(true, code);
	}

	stopSending(code = 0): void {
		try {
			this.handle?.stopSending?.(code);
		} catch {
			// Session teardown may already have closed the stream.
		}
	}

	async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
		const current = this.handle;
		if (!current || this.disposed) {
			controller.close();
			return;
		}
		try {
			const chunk = unwrapNativeValue(await current.read());
			if (this.disposed || this.handle !== current) return;
			if (chunk === null) {
				this.readableDone = true;
				this.maybeRelease();
				controller.close();
				return;
			}
			controller.enqueue(chunk);
		} catch (err) {
			if (this.disposed) return;
			this.readableDone = true;
			this.release(true);
			controller.error(toWebTransportError(err));
		}
	}

	cancel(reason: unknown): void {
		if (this.disposed) return;
		this.readableDone = true;
		// W3C half-close: canceling the readable stops only the peer's sending
		// half. The writable half must stay usable for a response.
		this.stopSending(extractStreamErrorCode(reason));
		this.maybeRelease();
	}

	async write(chunk: Uint8Array): Promise<void> {
		const current = this.handle;
		if (!current || this.disposed) {
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		}
		try {
			unwrapNativeVoid(await current.write(Buffer.from(chunk)));
		} catch (err) {
			this.writableDone = true;
			try {
				current.reset?.(0);
			} catch {
				// Session teardown may already have closed the stream.
			}
			this.maybeRelease();
			throw toWebTransportError(err);
		}
	}

	async close(): Promise<void> {
		const current = this.handle;
		if (!current || this.disposed) {
			throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
		}
		try {
			const finish = current.finishWait ?? current.finish;
			if (finish) unwrapNativeVoid((await finish.call(current)) ?? null);
			this.writableDone = true;
			this.maybeRelease();
		} catch (err) {
			this.writableDone = true;
			try {
				current.reset?.(0);
			} catch {
				// Session teardown may already have closed the stream.
			}
			this.maybeRelease();
			throw toWebTransportError(err);
		}
	}

	abort(reason: unknown): void {
		if (this.disposed) return;
		this.writableDone = true;
		// W3C half-close: aborting the writable resets only our sending half;
		// the readable half keeps delivering peer data.
		try {
			this.handle?.reset?.(extractStreamErrorCode(reason));
		} catch {
			// Session teardown may already have closed the stream.
		}
		this.maybeRelease();
	}

	private maybeRelease(): void {
		if (this.readableDone && this.writableDone) this.release(false);
	}
}

/**
 * Keep the writable half allocation lazy for read-only consumers. The W3C
 * surface still exposes the same stable writable stream once it is requested,
 * but high-volume receive paths no longer allocate a sink they never use.
 */
function createServerIncomingBidiWebStreams(
	nativeStream: NativeBidiStreamHandle,
	onDisposed: (resource: ServerIncomingStreamResource) => void,
): {
	resource: ServerIncomingStreamResource;
	stream: WebTransportBidirectionalStream;
} {
	const resource = new ServerIncomingBidiResource(nativeStream, onDisposed);
	const readable = new ReadableStream<Uint8Array>(resource, {
		highWaterMark: 0,
	});
	const stream = {
		readable,
		get writable(): WritableStream<Uint8Array> {
			return resource.getWritable();
		},
	} as WebTransportBidirectionalStream;
	return {
		resource,
		stream: attachServerBidiResourceControls(stream, resource),
	};
}

function attachServerBidiResourceControls(
	stream: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	},
	resource: ServerIncomingStreamResource,
): WebTransportBidirectionalStream {
	const withControls = stream as WebTransportBidirectionalStream;
	withControls[WT_RESET] = (code?: number) => resource.reset(code);
	withControls[WT_STOP_SENDING] = (code?: number) => resource.stopSending(code);
	return withControls;
}

class ServerIncomingUniResource implements ServerIncomingStreamResource {
	handle: NativeRecvStreamHandle | null;
	disposed = false;
	readonly onDisposed: (resource: ServerIncomingStreamResource) => void;

	constructor(
		nativeStream: NativeRecvStreamHandle,
		onDisposed: (resource: ServerIncomingStreamResource) => void,
	) {
		this.handle = nativeStream;
		this.onDisposed = onDisposed;
	}

	release(abort: boolean, code = 0): void {
		if (this.disposed) return;
		this.disposed = true;
		const current = this.handle;
		this.handle = null;
		if (current) {
			if (abort) {
				try {
					current.stopSending?.(code);
				} catch {
					// Session teardown may already have closed the stream.
				}
			}
			try {
				current.dispose?.();
			} catch {
				// Resource disposal is best-effort during stream teardown.
			}
		}
		this.onDisposed(this);
	}

	dispose(): void {
		this.release(true);
	}

	reset(code = 0): void {
		this.release(true, code);
	}

	stopSending(code = 0): void {
		try {
			this.handle?.stopSending?.(code);
		} catch {
			// Session teardown may already have closed the stream.
		}
	}

	async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
		const current = this.handle;
		if (!current || this.disposed) {
			controller.close();
			return;
		}
		try {
			const chunk = unwrapNativeValue(await current.read());
			if (this.disposed || this.handle !== current) return;
			if (chunk === null) {
				this.release(false);
				controller.close();
				return;
			}
			controller.enqueue(chunk);
		} catch (err) {
			if (this.disposed) return;
			this.release(true);
			controller.error(toWebTransportError(err));
		}
	}

	cancel(reason: unknown): void {
		this.release(true, extractStreamErrorCode(reason));
	}
}

function createServerIncomingUniWebReadable(
	nativeStream: NativeRecvStreamHandle,
	onDisposed: (resource: ServerIncomingStreamResource) => void,
): {
	resource: ServerIncomingStreamResource;
	readable: WebTransportReceiveStream;
} {
	const resource = new ServerIncomingUniResource(nativeStream, onDisposed);
	const readable = new ReadableStream<Uint8Array>(resource, {
		highWaterMark: 0,
	});
	const withControls = readable as WebTransportReceiveStream;
	withControls[WT_STOP_SENDING] = (code?: number) => resource.stopSending(code);
	return { resource, readable: withControls };
}

function createServerIncomingBidiStreams(
	nativeHandle: any,
	isClosed: () => boolean,
	closedPromise?: Promise<unknown>,
): ReadableStream<WebTransportBidirectionalStream> {
	// Pull-based: streams are accepted from native only as fast as the
	// consumer reads them, so a slow/stalled consumer cannot pile up
	// unbounded native handles in the queue.
	let cancelled = false;
	const activeStreams = new Set<ServerIncomingStreamResource>();
	const removeActiveStream = (resource: ServerIncomingStreamResource) =>
		activeStreams.delete(resource);
	const disposeActiveStreams = () => {
		for (const stream of activeStreams) stream.dispose();
		activeStreams.clear();
	};
	void closedPromise?.then(disposeActiveStreams, disposeActiveStreams);
	return new ReadableStream({
		async pull(controller) {
			if (cancelled) return;
			if (isClosed()) {
				disposeActiveStreams();
				controller.close();
				return;
			}
			try {
				const nativeStream = await nativeHandle.acceptBidiStream();
				if (cancelled) {
					nativeStream?.reset?.(0);
					return;
				}
				if (!nativeStream) {
					controller.close();
					return;
				}
				const direct = createServerIncomingBidiWebStreams(
					nativeStream,
					removeActiveStream,
				);
				activeStreams.add(direct.resource);
				controller.enqueue(direct.stream);
			} catch (err) {
				if (isClosed() || isSessionCloseError(err)) {
					disposeActiveStreams();
					controller.close();
					return;
				}
				controller.error(toWebTransportError(err));
			}
		},
		cancel() {
			// Only stop accepting new streams. Streams already handed to the
			// application stay owned by it and are released by their own
			// lifecycle or by session close.
			cancelled = true;
		},
	});
}

function createServerIncomingUniStreams(
	nativeHandle: any,
	isClosed: () => boolean,
	closedPromise?: Promise<unknown>,
): ReadableStream<WebTransportReceiveStream> {
	// Pull-based for the same backpressure reasons as the bidi variant.
	let cancelled = false;
	const activeStreams = new Set<ServerIncomingStreamResource>();
	const removeActiveStream = (resource: ServerIncomingStreamResource) =>
		activeStreams.delete(resource);
	const disposeActiveStreams = () => {
		for (const stream of activeStreams) stream.dispose();
		activeStreams.clear();
	};
	void closedPromise?.then(disposeActiveStreams, disposeActiveStreams);
	return new ReadableStream({
		async pull(controller) {
			if (cancelled) return;
			if (isClosed()) {
				disposeActiveStreams();
				controller.close();
				return;
			}
			try {
				const nativeStream = await nativeHandle.acceptUniStream();
				if (cancelled) {
					nativeStream?.stopSending?.(0);
					return;
				}
				if (!nativeStream) {
					controller.close();
					return;
				}
				const direct = createServerIncomingUniWebReadable(
					nativeStream,
					removeActiveStream,
				);
				activeStreams.add(direct.resource);
				controller.enqueue(direct.readable);
			} catch (err) {
				if (isClosed() || isSessionCloseError(err)) {
					disposeActiveStreams();
					controller.close();
					return;
				}
				controller.error(toWebTransportError(err));
			}
		},
		cancel() {
			// Only stop accepting new streams. Streams already handed to the
			// application stay owned by it and are released by their own
			// lifecycle or by session close.
			cancelled = true;
		},
	});
}

function createIncomingBidiStreams(wt: WebTransport): ReadableStream<{
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}> {
	// Pull-based: accept from the session only as fast as the consumer reads.
	let iter: AsyncIterator<Duplex> | null = null;
	return new ReadableStream({
		async pull(controller) {
			if (!iter) {
				const s = await wt._getSession();
				iter = s.incomingBidirectionalStreams()[Symbol.asyncIterator]();
			}
			const { value: duplex, done } = await iter.next();
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(
				await nodeDuplexToWebBidi(
					duplex,
					undefined,
					undefined,
					undefined,
					(bytes) => {
						wt._recordIncomingStreamBytes(bytes);
					},
					wt._isStrictW3CErrors(),
				),
			);
		},
		cancel() {
			void iter?.return?.();
		},
	});
}

function createIncomingUniStreams(
	wt: WebTransport,
): ReadableStream<ReadableStream<Uint8Array>> {
	// Pull-based: accept from the session only as fast as the consumer reads.
	let iter: AsyncIterator<Readable> | null = null;
	return new ReadableStream({
		async pull(controller) {
			if (!iter) {
				const s = await wt._getSession();
				iter = s.incomingUnidirectionalStreams()[Symbol.asyncIterator]();
			}
			const { value: readable, done } = await iter.next();
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(
				nodeReadableToWebReadable(
					readable,
					(bytes) => {
						wt._recordIncomingStreamBytes(bytes);
					},
					wt._isStrictW3CErrors(),
				),
			);
		},
		cancel() {
			void iter?.return?.();
		},
	});
}

function nodeDuplexToWebBidi(
	duplex: Duplex,
	scheduler?: SendScheduler,
	policy?: SendPolicy,
	onWriteBytes?: (bytes: number) => void,
	onReadBytes?: (bytes: number) => void,
	strictW3CErrors = false,
	destroyOnReadableCancel = false,
): Promise<{
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}> {
	const readable = nodeReadableToWebReadable(
		duplex,
		onReadBytes,
		strictW3CErrors,
		destroyOnReadableCancel,
	);
	const writable = nodeWritableToWebWritable(
		duplex,
		scheduler,
		policy,
		onWriteBytes,
		strictW3CErrors,
	);
	return Promise.resolve({ readable, writable });
}

function nodeReadableToWebReadable(
	r: Readable,
	onReadBytes?: (bytes: number) => void,
	strictW3CErrors = false,
	destroyOnCancel = true,
): ReadableStream<Uint8Array> {
	const stopSendable = r as unknown as Partial<StopSendable>;
	// Pull-based so the web stream's highWaterMark actually bounds buffering:
	// a slow consumer stops pulls, which stops draining the native channel,
	// which lets QUIC flow control push back on the peer. The previous eager
	// start() loop buffered a fast sender unboundedly.
	const iter = r[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value: chunk, done } = await iter.next();
				if (done) {
					controller.close();
					return;
				}
				const bytes =
					chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
				if (onReadBytes) onReadBytes(bytes.byteLength);
				controller.enqueue(bytes);
			} catch (err) {
				controller.error(toWebTransportError(err, strictW3CErrors));
			}
		},
		async cancel(reason) {
			const fn = stopSendable[WT_STOP_SENDING];
			if (typeof fn === "function") fn.call(r, extractStreamErrorCode(reason));
			// Abort the Node/native stream before asking its async iterator to
			// return. A pending iterator.next() owns the N-API stream handle; if
			// return() runs first, cancellation can wait on that read while the
			// native stop/reset signal is still queued behind it.
			if (destroyOnCancel && !r.destroyed) r.destroy();
			await iter.return?.();
		},
	});
}

function nodeWritableToWebWritable(
	w: Writable,
	scheduler?: SendScheduler,
	policy?: SendPolicy,
	onWriteBytes?: (bytes: number) => void,
	strictW3CErrors = false,
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
			try {
				if (scheduler && policy) {
					await scheduler.enqueue(policy, run);
				} else {
					await run();
				}
			} catch (err) {
				throw toWebTransportError(err, strictW3CErrors);
			}
			if (onWriteBytes) onWriteBytes(chunk.byteLength);
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				w.end((err: Error | null | undefined) => {
					if (err) {
						reject(toWebTransportError(err, strictW3CErrors));
						return;
					}
					resolve();
				});
			});
		},
		abort(reason) {
			const fn = resettable[WT_RESET];
			if (typeof fn === "function") fn.call(w, extractStreamErrorCode(reason));
		},
	});
}

function createNativeClientSessionForTests(
	nativeHandle: any,
	strictW3CErrors = false,
): ClientSession {
	return new NativeClientSession(
		nativeHandle,
		Promise.resolve(),
		new Promise<CloseInfo>(() => {}),
		strictW3CErrors,
	);
}

function createNativeServerSessionForTests(nativeHandle: any): ServerSession {
	return new NativeServerSession(
		nativeHandle,
		new Promise<CloseInfo>(() => {}),
		DEFAULT_LIMITS.backpressureTimeoutMs,
	);
}

/** @internal */
export const __TESTING__ = {
	createNativeClientSessionForTests,
	createNativeServerSessionForTests,
	createServerIncomingBidiStreamsForTests: createServerIncomingBidiStreams,
	createServerIncomingUniStreamsForTests: createServerIncomingUniStreams,
	tryLoadNativeAddonForTests: tryLoadNativeAddon,
	buildNativeAddonLoadErrorMessageForTests: buildNativeAddonLoadErrorMessage,
	nativeAddonOverrideRequestsFromEnvForTests:
		nativeAddonOverrideRequestsFromEnv,
	connectWithNativeForTests: connectWithNative,
	nativeStreamHandlesSnapshotForTests: () =>
		native?.nativeStreamHandlesSnapshot?.(),
	nativeAwaitProbeSnapshotForTests: () => native?.nativeAwaitProbeSnapshot?.(),
	nativeErrorCodes: KNOWN_ERROR_CODES,
	extractMessageErrorCodeForTests: extractMessageErrorCode,
};

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

// Backend-agnostic facade: the same contract is implemented by the wasm
// backend (`@webtransport-bun/webtransport/wasm`), letting application code
// run unchanged against either backend.
export type { WebTransportLike, WtBidiStream, WtCloseInfo } from "./shared.js";
export { nativeToWebTransportLike } from "./webtransport-like-native.js";
