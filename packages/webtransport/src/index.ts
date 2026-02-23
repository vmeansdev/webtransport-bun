/**
 * @packageDocumentation
 * @module @webtransport-bun/webtransport
 *
 * Production-ready WebTransport for Bun, backed by napi-rs + wtransport (Rust).
 * Supports in-process server, client (Node API and W3C-style facade), datagrams, and streams.
 */

if (typeof globalThis.Bun === "undefined") {
  throw new Error(
    "@webtransport-bun/webtransport requires Bun (>=1.3.9). See https://bun.sh"
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

import { BidiStream, SendStream, RecvStream } from "./streams.js";

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
export type { ErrorCode } from "./errors.js";

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
function toWebTransportError(err: unknown): WebTransportError {
    const msg = err instanceof Error ? err.message : String(err);
    const match = msg.match(E_CODE_RE);
    const code = match ? (match[0] as ErrorCode) : (E_INTERNAL as ErrorCode);
    return new WebTransportError(code, msg);
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
    host?: string; /** @default "0.0.0.0" */
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
 * Unsupported: `allowPooling`, `requireUnreliable`, `serverCertificateHashes` (validated then rejected).
 * Stream options `sendOrder`/`sendGroup` are rejected when passed to createBidirectionalStream/createUnidirectionalStream.
 */
export type WebTransportClientOptions = {
    serverCertificateHashes?: Array<{ algorithm: "sha-256"; value: BufferSource }>; // BufferSource = ArrayBuffer | ArrayBufferView
    allowPooling?: boolean;
    requireUnreliable?: boolean;
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
};

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type CloseInfo = { code?: number; reason?: string };

/** Base session interface (server and client). Node streams; use toWebTransport for Web Streams. */
export interface BaseSession {
    readonly id: string;
    readonly peer: { ip: string; port: number };

    readonly ready: Promise<void>;
    readonly closed: Promise<CloseInfo>;

    close(info?: CloseInfo): void;

    // Datagrams
    sendDatagram(data: Uint8Array): Promise<void>;
    incomingDatagrams(): AsyncIterable<Uint8Array>;

    // Streams
    createBidirectionalStream(): Promise<Duplex>;
    incomingBidirectionalStreams(): AsyncIterable<Duplex>;

    createUnidirectionalStream(): Promise<Writable>;
    incomingUnidirectionalStreams(): AsyncIterable<Readable>;

    // Metrics (per session)
    metricsSnapshot(): SessionMetricsSnapshot;
}

export interface ServerSession extends BaseSession { }
export interface ClientSession extends BaseSession { }

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

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
};

export type SessionMetricsSnapshot = {
    datagramsIn: number;
    datagramsOut: number;
    streamsActive: number;
    queuedBytes: number;
};

/** Prometheus metric name prefix. Override via env WEBTRANSPORT_METRICS_PREFIX. */
export const METRICS_PREFIX = process.env.WEBTRANSPORT_METRICS_PREFIX ?? "webtransport_";

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
    labels?: Record<string, string>
): string {
    const l = labels
        ? "," + Object.entries(labels)
            .map(([k, v]) => `${sanitizePromLabelName(k)}="${escapePromLabelValue(v)}"`)
            .join(",")
        : "";
    const p = METRICS_PREFIX;
    const lines: string[] = [
        `# HELP ${p}sessions_active Current open sessions`,
        `# TYPE ${p}sessions_active gauge`,
        `${p}sessions_active${l} ${m.sessionsActive}`,
        `# HELP ${p}handshakes_in_flight Handshakes in progress`,
        `# TYPE ${p}handshakes_in_flight gauge`,
        `${p}handshakes_in_flight${l} ${m.handshakesInFlight}`,
        `# HELP ${p}streams_active Active streams`,
        `# TYPE ${p}streams_active gauge`,
        `${p}streams_active${l} ${m.streamsActive}`,
        `# HELP ${p}session_tasks_active Internal session tasks`,
        `# TYPE ${p}session_tasks_active gauge`,
        `${p}session_tasks_active${l} ${m.sessionTasksActive}`,
        `# HELP ${p}stream_tasks_active Internal stream tasks`,
        `# TYPE ${p}stream_tasks_active gauge`,
        `${p}stream_tasks_active${l} ${m.streamTasksActive}`,
        `# HELP ${p}queued_bytes_global Bytes queued globally`,
        `# TYPE ${p}queued_bytes_global gauge`,
        `${p}queued_bytes_global${l} ${m.queuedBytesGlobal}`,
        `# HELP ${p}datagrams_in Datagrams received`,
        `# TYPE ${p}datagrams_in counter`,
        `${p}datagrams_in${l} ${m.datagramsIn}`,
        `# HELP ${p}datagrams_out Datagrams sent`,
        `# TYPE ${p}datagrams_out counter`,
        `${p}datagrams_out${l} ${m.datagramsOut}`,
        `# HELP ${p}datagrams_dropped Datagrams dropped`,
        `# TYPE ${p}datagrams_dropped counter`,
        `${p}datagrams_dropped${l} ${m.datagramsDropped}`,
        `# HELP ${p}backpressure_wait_total Times senders waited on backpressure`,
        `# TYPE ${p}backpressure_wait_total counter`,
        `${p}backpressure_wait_total${l} ${m.backpressureWaitCount}`,
        `# HELP ${p}backpressure_timeout_total Times backpressure timeout fired`,
        `# TYPE ${p}backpressure_timeout_total counter`,
        `${p}backpressure_timeout_total${l} ${m.backpressureTimeoutCount}`,
        `# HELP ${p}rate_limited_total Sessions rejected by rate limit`,
        `# TYPE ${p}rate_limited_total counter`,
        `${p}rate_limited_total${l} ${m.rateLimitedCount}`,
        `# HELP ${p}limit_exceeded_total Sessions rejected (limits)`,
        `# TYPE ${p}limit_exceeded_total counter`,
        `${p}limit_exceeded_total${l} ${m.limitExceededCount}`,
    ];
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
const basePaths = [
    "../../../crates/native",
    "../prebuilds",
];
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

    constructor(nativeHandle: any, closedPromise: Promise<CloseInfo>) {
        this.#nativeHandle = nativeHandle;
        this.#closedPromise = closedPromise;
        this.#closedPromise.then(() => { this.#closed = true; });
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
        if (this.#closed) throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
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
        if (this.#closed) throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
        try {
            const nativeStream = await this.#nativeHandle.createBidiStream();
            return new BidiStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
        } catch (err) {
            throw toWebTransportError(err);
        }
    }

    async *incomingBidirectionalStreams(): AsyncIterable<Duplex> {
        while (!this.#closed) {
            try {
                const nativeStream = await this.#nativeHandle.acceptBidiStream();
                if (!nativeStream) break;
                yield new BidiStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
            } catch {
                break;
            }
        }
    }

    async createUnidirectionalStream(): Promise<Writable> {
        if (this.#closed) throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
        try {
            const nativeStream = await this.#nativeHandle.createUniStream();
            return new SendStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
        } catch (err) {
            throw toWebTransportError(err);
        }
    }

    async *incomingUnidirectionalStreams(): AsyncIterable<Readable> {
        while (!this.#closed) {
            try {
                const nativeStream = await this.#nativeHandle.acceptUniStream();
                if (!nativeStream) break;
                yield new RecvStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
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

    const certPem = typeof opts.tls.certPem === "string" ? opts.tls.certPem : new TextDecoder().decode(opts.tls.certPem);
    const keyPem = typeof opts.tls.keyPem === "string" ? opts.tls.keyPem : new TextDecoder().decode(opts.tls.keyPem);
    const caPem = typeof opts.tls.caPem === "string"
        ? opts.tls.caPem
        : opts.tls.caPem != null
            ? new TextDecoder().decode(opts.tls.caPem)
            : "";

    const limitsJson = JSON.stringify({ ...DEFAULT_LIMITS, ...opts.limits });
    const rateLimitsJson = JSON.stringify({ ...DEFAULT_RATE_LIMITS, ...opts.rateLimits });

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
            if (evt.name === "session" && evt.id != null && evt.peerIp != null && evt.peerPort != null) {
                let closedResolve!: (info: CloseInfo) => void;
                const closedPromise = new Promise<CloseInfo>((resolve) => { closedResolve = resolve; });
                closedResolvers.set(evt.id, closedResolve);
                const nativeSession = new native.SessionHandle(evt.id, evt.peerIp, evt.peerPort);
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
                    new Promise<void>((r) => { onSessionDrainResolve = r; }),
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

    constructor(
        nativeHandle: any,
        readyPromise: Promise<void>,
        closedPromise: Promise<CloseInfo>,
    ) {
        this.#nativeHandle = nativeHandle;
        this.#readyPromise = readyPromise;
        this.#closedPromise = closedPromise;
        this.#closedPromise.then(() => { this.#closed = true; });
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
        if (this.#closed) throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
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
                const dgram = await this.#nativeHandle.readDatagram();
                if (!dgram) break;
                yield dgram;
            } catch {
                break;
            }
        }
    }

    async createBidirectionalStream(): Promise<Duplex> {
        if (this.#closed) throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
        try {
            const nativeStream = await this.#nativeHandle.createBidiStream();
            return new BidiStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
        } catch (err) {
            throw toWebTransportError(err);
        }
    }

    async *incomingBidirectionalStreams(): AsyncIterable<Duplex> {
        while (!this.#closed) {
            try {
                const nativeStream = await this.#nativeHandle.acceptBidiStream();
                if (!nativeStream) break;
                yield new BidiStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
            } catch {
                break;
            }
        }
    }

    async createUnidirectionalStream(): Promise<Writable> {
        if (this.#closed) throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
        try {
            const nativeStream = await this.#nativeHandle.createUniStream();
            return new SendStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
        } catch (err) {
            throw toWebTransportError(err);
        }
    }

    async *incomingUnidirectionalStreams(): AsyncIterable<Readable> {
        while (!this.#closed) {
            try {
                const nativeStream = await this.#nativeHandle.acceptUniStream();
                if (!nativeStream) break;
                yield new RecvStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
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
export async function connect(url: string, opts?: ClientOptions): Promise<ClientSession> {
    if (!native) {
        throw new Error("Native addon not loaded");
    }
    if (opts?.tls?.insecureSkipVerify === true) {
        const log = opts.log ?? ((e: LogEvent) => console.warn(`[webtransport] ${e.level}: ${e.msg}`));
        log({ level: "warn", msg: "tls.insecureSkipVerify is enabled — dev only, never use in production" });
    }

    const mergedLimits = { ...DEFAULT_LIMITS, ...opts?.limits };
    const tlsOpts = opts?.tls ? {
        insecureSkipVerify: opts.tls.insecureSkipVerify ?? false,
        caPem: opts.tls.caPem ? (typeof opts.tls.caPem === "string" ? opts.tls.caPem : new TextDecoder().decode(opts.tls.caPem)) : undefined,
        serverName: opts.tls.serverName,
    } : undefined;
    const optsJson = JSON.stringify({
        limits: mergedLimits,
        tls: tlsOpts,
    });

    const handshakeTimeout = mergedLimits.handshakeTimeoutMs;

    const connectPromise = new Promise<ClientSession>((resolve, reject) => {
        const closedResolvers = new Map<string, (info: CloseInfo) => void>();
        const onClosed = (events: any[]) => {
            for (const evt of events) {
                if (evt.name === "session_closed" && evt.id != null) {
                    const resolveClosed = closedResolvers.get(evt.id);
                    closedResolvers.delete(evt.id);
                    if (resolveClosed) resolveClosed({ code: evt.code, reason: evt.reason });
                }
            }
        };
        native.connect(url, optsJson, onClosed, (err: any, handleId?: string) => {
            if (err) {
                reject(toWebTransportError(err));
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
            const closedPromise = new Promise<CloseInfo>((r) => { closedResolve = r; });
            closedResolvers.set(handle.id, closedResolve);
            const readyPromise = Promise.resolve();
            resolve(new NativeClientSession(handle, readyPromise, closedPromise));
        });
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
            reject(new WebTransportError(E_HANDSHAKE_TIMEOUT as ErrorCode, `E_HANDSHAKE_TIMEOUT: connect timed out after ${handshakeTimeout}ms`));
        }, handshakeTimeout);
    });

    return Promise.race([connectPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Browser-style WebTransport facade (Phase P1)
// ---------------------------------------------------------------------------

const UNSUPPORTED_CTOR_OPTIONS = ["allowPooling", "requireUnreliable"] as const;

function rejectUnsupportedOption(optionName: string): never {
    throw new WebTransportError(
        E_INTERNAL as ErrorCode,
        `E_INTERNAL: unsupported option '${optionName}'`
    );
}

function validateServerCertificateHashes(
    arr: Array<{ algorithm: string; value: BufferSource }>
): void {
    for (const entry of arr) {
        if (entry.algorithm !== "sha-256") {
            throw new WebTransportError(
                E_INTERNAL as ErrorCode,
                `E_INTERNAL: serverCertificateHashes only supports algorithm "sha-256", got "${entry.algorithm}"`
            );
        }
        if (entry.value == null || (typeof entry.value === "object" && "byteLength" in entry && entry.byteLength === 0)) {
            throw new WebTransportError(
                E_INTERNAL as ErrorCode,
                "E_INTERNAL: serverCertificateHashes entry value must be non-empty BufferSource"
            );
        }
    }
}

function validateClientOptions(opts?: WebTransportClientOptions): void {
    if (!opts) return;
    for (const k of UNSUPPORTED_CTOR_OPTIONS) {
        if (k in opts && (opts as Record<string, unknown>)[k] !== undefined) {
            rejectUnsupportedOption(k);
        }
    }
    if (opts.serverCertificateHashes !== undefined) {
        if (!Array.isArray(opts.serverCertificateHashes)) {
            throw new WebTransportError(
                E_INTERNAL as ErrorCode,
                "E_INTERNAL: serverCertificateHashes must be an array"
            );
        }
        validateServerCertificateHashes(opts.serverCertificateHashes);
        throw new WebTransportError(
            E_INTERNAL as ErrorCode,
            "E_INTERNAL: serverCertificateHashes is not supported in this runtime"
        );
    }
}

function mapToClientOptions(opts?: WebTransportClientOptions): ClientOptions {
    if (!opts) return {};
    validateClientOptions(opts);
    return {
        tls: opts.tls,
        limits: opts.limits,
    };
}

function toCloseInfo(info: CloseInfo): WebTransportCloseInfo {
    return {
        closeCode: info?.code,
        reason: info?.reason,
    };
}

/** Internal transport state for facade method guards */
type WebTransportState = "connecting" | "connected" | "draining" | "closed" | "failed";

/**
 * Browser-style WebTransport client (W3C facade).
 *
 * Use `new WebTransport(url, options)` to connect, or `toWebTransport(session)` to wrap an existing
 * {@link ClientSession}. Await {@link WebTransport.ready} before using datagrams/streams.
 *
 * Unsupported options (`allowPooling`, `requireUnreliable`, `sendOrder`, `sendGroup`,
 * `serverCertificateHashes`) throw {@link WebTransportError} with code `E_INTERNAL`.
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
    readonly #sessionPromise: Promise<ClientSession>;
    readonly #ready: Promise<void>;
    readonly #closed: Promise<WebTransportCloseInfo>;
    readonly #draining: Promise<void>;
    #session: ClientSession | null = null;
    #state: WebTransportState;
    #datagramsCache: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null = null;
    #incomingBidiCache: ReadableStream<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> | null = null;
    #incomingUniCache: ReadableStream<ReadableStream<Uint8Array>> | null = null;

    constructor(urlOrSession: string | ClientSession, options?: WebTransportClientOptions) {
        if (typeof urlOrSession === "string") {
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
                }
            );
            this.#closed = this.#sessionPromise.then((s) =>
                s.closed.then((info) => {
                    this.#state = "closed";
                    return toCloseInfo(info);
                })
            );
        } else {
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
        // draining: spec says it resolves when session is asked to gracefully close.
        // Native layer has no separate draining signal; we resolve when closed (documented as partial parity).
        this.#draining = this.#closed.then(() => {});
    }

    /** Resolves when handshake completes. Rejects with WebTransportError on connect failure. */
    get ready(): Promise<void> {
        return this.#ready;
    }

    /** Resolves with close info when session closes. Never rejects. */
    get closed(): Promise<WebTransportCloseInfo> {
        return this.#closed;
    }

    /** Resolves when session is draining. Currently resolves with closed (partial parity). */
    get draining(): Promise<void> {
        return this.#draining;
    }

    /** Datagram Web Streams (readable/writable). Throws E_SESSION_CLOSED after close. */
    get datagrams(): {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
    } {
        if (!this.#datagramsCache) {
            this.#datagramsCache = createDatagramStreams(this);
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
    get incomingUnidirectionalStreams(): ReadableStream<ReadableStream<Uint8Array>> {
        if (!this.#incomingUniCache) {
            this.#incomingUniCache = createIncomingUniStreams(this);
        }
        return this.#incomingUniCache;
    }

    /**
     * Create a bidirectional stream (Web Streams). Rejects sendOrder/sendGroup (unsupported).
     * @throws WebTransportError E_SESSION_CLOSED if session is closed/draining/failed.
     */
    async createBidirectionalStream(
        options?: { sendOrder?: number; sendGroup?: number }
    ): Promise<{
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
    }> {
        if (options?.sendOrder !== undefined) rejectUnsupportedOption("sendOrder");
        if (options?.sendGroup !== undefined) rejectUnsupportedOption("sendGroup");
        if (this.#state === "draining" || this.#state === "closed" || this.#state === "failed") {
            throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
        }
        const s = await this.#sessionPromise;
        const duplex = await s.createBidirectionalStream();
        return nodeDuplexToWebBidi(duplex);
    }

    /**
     * Create a unidirectional send stream (WritableStream). Rejects sendOrder/sendGroup (unsupported).
     * @throws WebTransportError E_SESSION_CLOSED if session is closed/draining/failed.
     */
    async createUnidirectionalStream(
        options?: { sendOrder?: number; sendGroup?: number }
    ): Promise<WritableStream<Uint8Array>> {
        if (options?.sendOrder !== undefined) rejectUnsupportedOption("sendOrder");
        if (options?.sendGroup !== undefined) rejectUnsupportedOption("sendGroup");
        if (this.#state === "draining" || this.#state === "closed" || this.#state === "failed") {
            throw new WebTransportError(E_SESSION_CLOSED as ErrorCode);
        }
        const s = await this.#sessionPromise;
        const writable = await s.createUnidirectionalStream();
        return nodeWritableToWebWritable(writable);
    }

    /** Initiate graceful close. Idempotent after first call. */
    close(info?: WebTransportCloseInfo): void {
        if (this.#state === "connected" || this.#state === "connecting") {
            this.#state = "draining";
        }
        if (this.#session) {
            this.#session.close({
                code: info?.closeCode,
                reason: info?.reason,
            });
        }
    }

    /** Internal: session for adapters (not part of spec) */
    async _getSession(): Promise<ClientSession> {
        return this.#sessionPromise;
    }
}

// Stub implementations for P2/P3 — will be replaced in datagram/stream phases
function createDatagramStreams(
    wt: WebTransport
): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
    const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
            const s = await wt._getSession();
            for await (const d of s.incomingDatagrams()) {
                controller.enqueue(new Uint8Array(d));
            }
            controller.close();
        },
    });
    const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
            const s = await wt._getSession();
            await s.sendDatagram(chunk);
        },
    });
    return { readable, writable };
}

function createIncomingBidiStreams(
    wt: WebTransport
): ReadableStream<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> {
    return new ReadableStream({
        async start(controller) {
            const s = await wt._getSession();
            for await (const duplex of s.incomingBidirectionalStreams()) {
                controller.enqueue(await nodeDuplexToWebBidi(duplex));
            }
            controller.close();
        },
    });
}

function createIncomingUniStreams(
    wt: WebTransport
): ReadableStream<ReadableStream<Uint8Array>> {
    return new ReadableStream({
        async start(controller) {
            const s = await wt._getSession();
            for await (const readable of s.incomingUnidirectionalStreams()) {
                controller.enqueue(nodeReadableToWebReadable(readable));
            }
            controller.close();
        },
    });
}

function nodeDuplexToWebBidi(duplex: Duplex): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
}> {
    const readable = nodeReadableToWebReadable(duplex);
    const writable = nodeWritableToWebWritable(duplex);
    return Promise.resolve({ readable, writable });
}

function nodeReadableToWebReadable(
    r: Readable
): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            for await (const chunk of r) {
                controller.enqueue(
                    chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
                );
            }
            controller.close();
        },
    });
}

function nodeWritableToWebWritable(w: Writable): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
        async write(chunk) {
            return new Promise((resolve, reject) => {
                w.write(Buffer.from(chunk), (err: Error | null | undefined) => (err ? reject(err) : resolve()));
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                w.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
            });
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
