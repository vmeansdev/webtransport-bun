/**
 * @webtransport-bun/webtransport
 *
 * Production-ready WebTransport for Bun, backed by napi-rs + wtransport (Rust).
 *
 * Public API surface — see SPEC.md for authoritative contract.
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
// Public factory functions (stubs — to be wired to native addon)
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";

// Resolving the native module: prebuilds (published) or crates/native (dev)
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

class NativeServerSession implements ServerSession {
    #nativeHandle: any;
    #closedPromise: Promise<CloseInfo>;

    constructor(nativeHandle: any, closedPromise: Promise<CloseInfo>) {
        this.#nativeHandle = nativeHandle;
        this.#closedPromise = closedPromise;
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
        return Promise.resolve();
    }

    get closed(): Promise<CloseInfo> {
        return this.#closedPromise;
    }

    close(info?: CloseInfo): void {
        this.#nativeHandle.close(info?.code ?? null, info?.reason ?? null);
    }

    async sendDatagram(data: Uint8Array): Promise<void> {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        await this.#nativeHandle.sendDatagram(buf);
    }

    async *incomingDatagrams(): AsyncIterable<Uint8Array> {
        while (true) {
            const datagram = await this.#nativeHandle.readDatagram();
            if (!datagram) break;
            yield datagram;
        }
    }

    async createBidirectionalStream(): Promise<Duplex> {
        const nativeStream = await this.#nativeHandle.createBidiStream();
        return new BidiStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
    }

    async *incomingBidirectionalStreams(): AsyncIterable<Duplex> {
        while (true) {
            const nativeStream = await this.#nativeHandle.acceptBidiStream();
            if (!nativeStream) break;
            yield new BidiStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
        }
    }

    async createUnidirectionalStream(): Promise<Writable> {
        const nativeStream = await this.#nativeHandle.createUniStream();
        return new SendStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
    }

    async *incomingUnidirectionalStreams(): AsyncIterable<Readable> {
        while (true) {
            const nativeStream = await this.#nativeHandle.acceptUniStream();
            if (!nativeStream) break;
            yield new RecvStream({ handleId: nativeStream?.id ?? 0, nativeHandle: nativeStream });
        }
    }

    metricsSnapshot(): SessionMetricsSnapshot {
        return this.#nativeHandle.metricsSnapshot();
    }
}

/**
 * Create an in-process WebTransport server.
 */
export function createServer(opts: ServerOptions): WebTransportServer {
    if (!native) {
        throw new Error("Native addon not loaded");
    }

    // Convert keys to string representation if they are UInt8Arrays
    const certPem = typeof opts.tls.certPem === "string" ? opts.tls.certPem : new TextDecoder().decode(opts.tls.certPem);
    const keyPem = typeof opts.tls.keyPem === "string" ? opts.tls.keyPem : new TextDecoder().decode(opts.tls.keyPem);

    const limitsJson = JSON.stringify({ ...DEFAULT_LIMITS, ...opts.limits });
    const rateLimitsJson = JSON.stringify({ ...DEFAULT_RATE_LIMITS, ...opts.rateLimits });

    const closedResolvers = new Map<string, (info: CloseInfo) => void>();
    const handle = new native.ServerHandle(opts.port, certPem, keyPem, limitsJson, rateLimitsJson, (events: any[]) => {
        for (const evt of events) {
            if (evt.name === "session" && evt.id != null && evt.peerIp != null && evt.peerPort != null) {
                let closedResolve!: (info: CloseInfo) => void;
                const closedPromise = new Promise<CloseInfo>((resolve) => { closedResolve = resolve; });
                closedResolvers.set(evt.id, closedResolve);
                const nativeSession = new native.SessionHandle(evt.id, evt.peerIp, evt.peerPort);
                opts.onSession(new NativeServerSession(nativeSession, closedPromise));
            } else if (evt.name === "session_closed" && evt.id != null) {
                const resolve = closedResolvers.get(evt.id);
                closedResolvers.delete(evt.id);
                if (resolve) resolve({ code: evt.code, reason: evt.reason });
            }
        }
    });

    return {
        address: { host: opts.host ?? "0.0.0.0", port: handle.port },
        close: async () => {
            await handle.close();
            for (const [id, resolve] of closedResolvers) {
                closedResolvers.delete(id);
                resolve({ code: 0, reason: "server closed" });
            }
        },
        metricsSnapshot: () => handle.metricsSnapshot(),
    };
}

class NativeClientSession implements ClientSession {
    #nativeHandle: any;
    #closedPromise: Promise<CloseInfo>;
    #closedResolvers: Map<string, (info: CloseInfo) => void>;

    constructor(
        nativeHandle: any,
        closedPromise: Promise<CloseInfo>,
        closedResolvers: Map<string, (info: CloseInfo) => void>,
    ) {
        this.#nativeHandle = nativeHandle;
        this.#closedPromise = closedPromise;
        this.#closedResolvers = closedResolvers;
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
        return Promise.resolve();
    }

    get closed(): Promise<CloseInfo> {
        return this.#closedPromise;
    }

    close(info?: CloseInfo): void {
        this.#nativeHandle.close(info?.code ?? null, info?.reason ?? null);
    }

    async sendDatagram(data: Uint8Array): Promise<void> {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        await this.#nativeHandle.sendDatagram(buf);
    }

    async *incomingDatagrams(): AsyncIterable<Uint8Array> {
        while (true) {
            const dgram = await this.#nativeHandle.readDatagram();
            if (!dgram) break;
            yield dgram;
        }
    }

    async createBidirectionalStream(): Promise<Duplex> {
        const nativeStream = await this.#nativeHandle.createBidiStream();
        return new BidiStream({ handleId: 0, nativeHandle: nativeStream });
    }

    async *incomingBidirectionalStreams(): AsyncIterable<Duplex> {
        while (true) {
            const nativeStream = await this.#nativeHandle.acceptBidiStream();
            if (!nativeStream) break;
            yield new BidiStream({ handleId: 0, nativeHandle: nativeStream });
        }
    }

    async createUnidirectionalStream(): Promise<Writable> {
        const nativeStream = await this.#nativeHandle.createUniStream();
        return new SendStream({ handleId: 0, nativeHandle: nativeStream });
    }

    async *incomingUnidirectionalStreams(): AsyncIterable<Readable> {
        while (true) {
            const nativeStream = await this.#nativeHandle.acceptUniStream();
            if (!nativeStream) break;
            yield new RecvStream({ handleId: 0, nativeHandle: nativeStream });
        }
    }

    metricsSnapshot(): SessionMetricsSnapshot {
        return this.#nativeHandle.metricsSnapshot();
    }
}

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

    const optsJson = JSON.stringify({
        limits: opts?.limits ? { ...DEFAULT_LIMITS, ...opts.limits } : undefined,
        tls: opts?.tls ? { insecureSkipVerify: opts.tls.insecureSkipVerify ?? false } : undefined,
    });

    return new Promise((resolve, reject) => {
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
                reject(typeof err === "string" ? new Error(err) : err);
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
            resolve(new NativeClientSession(handle, closedPromise, closedResolvers));
        });
    });
}
