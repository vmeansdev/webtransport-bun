/**
 * @webtransport-bun/webtransport
 *
 * Production-ready WebTransport for Bun, backed by napi-rs + wtransport (Rust).
 *
 * Public API surface — see docs/SPEC.md for authoritative contract.
 */

import type { Duplex, Readable, Writable } from "node:stream";

// Re-export stream symbols and helpers
export { WT_RESET, WT_STOP_SENDING } from "./streams.js";
export type { Resettable, StopSendable } from "./streams.js";

import { BidiStream, SendStream, RecvStream } from "./streams.js";

// Re-export error codes and error class
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

const E_CODE_RE = /^E_[A-Z_]+/;
function toWebTransportError(err: unknown): WebTransportError {
    const msg = err instanceof Error ? err.message : String(err);
    const match = E_CODE_RE.exec(msg);
    if (match) return new WebTransportError(match[0] as ErrorCode, msg);
    return new WebTransportError(E_INTERNAL as ErrorCode, msg);
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

export type TlsOptions = {
    certPem: string | Uint8Array;
    keyPem: string | Uint8Array;
    caPem?: string | Uint8Array;
    /** SNI for client mode; for server, used in logs/metrics */
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

export type LimitsOptions = {
    maxSessions: number;
    maxHandshakesInFlight: number;
    maxStreamsPerSessionBidi: number;
    maxStreamsPerSessionUni: number;
    maxStreamsGlobal: number;

    /** Hard cap in bytes (also must respect negotiated max) */
    maxDatagramSize: number;
    maxQueuedBytesGlobal: number;
    maxQueuedBytesPerSession: number;
    maxQueuedBytesPerStream: number;

    backpressureTimeoutMs: number;
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

export type ServerOptions = {
    host?: string; // default: 0.0.0.0
    port: number;
    tls: TlsOptions;
    limits?: Partial<LimitsOptions>;
    rateLimits?: Partial<RateLimitOptions>;

    /** Called on each accepted session (must not block; long work should be async) */
    onSession: (session: ServerSession) => void | Promise<void>;

    /** Optional logging hook */
    log?: (event: LogEvent) => void;

    /** Debug mode: increases log verbosity without changing semantics */
    debug?: boolean;
};

export interface WebTransportServer {
    readonly address: { host: string; port: number };
    close(): Promise<void>;
    metricsSnapshot(): MetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export type ClientOptions = {
    tls?: {
        caPem?: string | Uint8Array;
        serverName?: string;
        /** Dev only: skips server cert verification. Requires explicit `true`. Emits warning log. Never use in production. */
        insecureSkipVerify?: boolean;
    };
    limits?: Partial<LimitsOptions>;
    log?: (event: LogEvent) => void;
};

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type CloseInfo = { code?: number; reason?: string };

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

// ---------------------------------------------------------------------------
// Native addon loader
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const PLATFORM = process.platform;
const ARCH = process.arch;
const BINARY = `webtransport-native.${PLATFORM}-${ARCH}.node`;
let native: any;
const paths = [
    `../../../crates/native/${BINARY}`,
    `../prebuilds/${BINARY}`,
];
for (const p of paths) {
    try {
        native = _require(p);
        break;
    } catch {
        continue;
    }
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

    const handle = new native.ServerHandle(opts.port, opts.host ?? "0.0.0.0", certPem, keyPem, caPem, limitsJson, rateLimitsJson, (events: any[]) => {
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
    }, logCallback);

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
 * Connect to a WebTransport server (client mode).
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
