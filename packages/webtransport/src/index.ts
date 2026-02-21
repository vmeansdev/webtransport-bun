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
    streamsPerSec: 200,
    streamsBurst: 400,
    datagramsPerSec: 2000,
    datagramsBurst: 5000,
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogEvent = {
    level: "debug" | "info" | "warn" | "error";
    msg: string;
    sessionId?: string;
    peerIp?: string;
    peerPort?: number;
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
        /** dev only */
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

// Resolving the native module based on platform
const _require = createRequire(import.meta.url);
const PLATFORM = process.platform;
const ARCH = process.arch;
let native: any;
try {
    native = _require(`../../../crates/native/webtransport-native.${PLATFORM}-${ARCH}.node`);
} catch (e) {
    // fallback or error
    // console.error("Failed to load native addon:", e);
}

class NativeServerSession implements ServerSession {
    #nativeHandle: any;

    constructor(nativeHandle: any) {
        this.#nativeHandle = nativeHandle;
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

    // Phase 5.3 stub
    get ready(): Promise<void> {
        return Promise.resolve(); // Stub for now
    }

    get closed(): Promise<CloseInfo> {
        return new Promise(() => { }); // Stub for now
    }

    close(info?: CloseInfo): void {
        this.#nativeHandle.close();
    }

    async sendDatagram(data: Uint8Array): Promise<void> {
        // native side expects Buffer natively
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        await this.#nativeHandle.sendDatagram(buf);
    }

    async *incomingDatagrams(): AsyncIterable<Uint8Array> {
        while (true) {
            const datagram = await this.#nativeHandle.readDatagram();
            if (!datagram) break; // None means closed
            yield datagram;
        }
    }

    async createBidirectionalStream(): Promise<Duplex> {
        const nativeStream = await this.#nativeHandle.createBidiStream();
        return new BidiStream({ handleId: nativeStream.id, nativeHandle: nativeStream });
    }

    async *incomingBidirectionalStreams(): AsyncIterable<Duplex> {
        while (true) {
            const nativeStream = await this.#nativeHandle.acceptBidiStream();
            if (!nativeStream) break;
            yield new BidiStream({ handleId: nativeStream.id, nativeHandle: nativeStream });
        }
    }

    async createUnidirectionalStream(): Promise<Writable> {
        const nativeStream = await this.#nativeHandle.createUniStream();
        return new SendStream({ handleId: nativeStream.id, nativeHandle: nativeStream });
    }

    async *incomingUnidirectionalStreams(): AsyncIterable<Readable> {
        while (true) {
            const nativeStream = await this.#nativeHandle.acceptUniStream();
            if (!nativeStream) break;
            yield new RecvStream({ handleId: nativeStream.id, nativeHandle: nativeStream });
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

    const handle = new native.ServerHandle(opts.port, certPem, keyPem, limitsJson, rateLimitsJson, (events: any[]) => {
        // TSFN callbacks for session events
        for (const evt of events) {
            if (evt.name === "session") {
                // evt.handle is the native session handle passed from Rust
                // But for now, let's say Rust just passes an object, or we explicitly create one:
                // const nativeSession = new native.SessionHandle("test-id", "127.0.0.1", 12345);
                // const session = new NativeServerSession(nativeSession);
                // opts.onSession(session);
            }
        }
    });

    return {
        address: { host: opts.host ?? "0.0.0.0", port: handle.port },
        close: async () => await handle.close(),
        metricsSnapshot: () => handle.metricsSnapshot(),
    };
}

/**
 * Connect to a WebTransport server (client mode).
 */
export async function connect(_url: string, _opts?: ClientOptions): Promise<ClientSession> {
    // TODO: wire to native addon runtime
    throw new Error("connect is not yet implemented — native addon required");
}
