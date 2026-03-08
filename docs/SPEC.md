# SPEC.md

## Package name (suggested)
`@webtransport-bun/webtransport`

## High-level API
The API provides:
- `createServer(options)` for in-process server.
- `connect(url, options)` for client.
- `new WebTransport(url, options)` as additive browser-shaped client facade.
- Sessions expose datagrams (Promise send + async iterable receive) and streams (Node streams).

All streams must use standard Node stream backpressure semantics (write() returns false + 'drain').

## W3C facade parity status (current)
Source of truth: `docs/PARITY_MATRIX.md` (W3C snapshot: `docs/w3c/w3c.github.io-2026-02-04.md`).

- Implemented in facade:
  - lifecycle (`ready`, `closed`, `draining`)
  - datagram duplex shape (`readable`, `writable`, `createWritable`, `maxDatagramSize`)
  - datagram send options (`sendOrder`, `sendGroup`) with ownership validation + deterministic scheduling
  - stream creation/incoming stream surfaces
  - stream send options (`sendOrder`, `sendGroup`) with deterministic scheduling
  - browser-shaped stream control mapping (`writable.abort` -> reset, `readable.cancel` -> stopSending)
  - static capability `supportsReliableOnly`
  - `getStats()` connection counters (`bytesSent`, `bytesReceived`, packet counters, datagrams)
  - `congestionControl` option validation with explicit runtime mapping: `default` -> Cubic, `throughput` -> BBR, `low-latency` -> NewReno
  - `serverCertificateHashes` pinning support in native TLS verify path
  - `datagramsReadableType`: `"bytes"` creates ReadableByteStream with BYOB; `"default"` uses normal ReadableStream
  - `allowPooling`: when true, reuses pooled endpoints for compatible connects; when false, uses dedicated sessions
  - `requireUnreliable`: accepted; satisfied by QUIC/WebTransport transport capabilities
- Remaining parity tracking and implementation sequencing are in `docs/PARITY_MATRIX.md` (see Priority Execution Order / Remaining Work).

## Pooling Semantics (allowPooling)

When `allowPooling: true`, the runtime uses **endpoint-level pooling**:

- **What is pooled:** `Endpoint` instances (UDP socket + TLS config) are reused per compatibility key.
- **What is not pooled:** Each `connect()` still creates a new `Connection` (new QUIC handshake + WebTransport CONNECT); sessions are independent.
- **Compatibility key dimensions:** scheme, host, port, SNI (`serverName`), TLS mode (`insecureSkipVerify`, `caPem`, `serverCertificateHashes`), `requireUnreliable`, and requested congestion preference. Connects with identical key reuse the pooled endpoint; differing key creates a new pool entry.
- **Non-reuse conditions:** Different origin, TLS config, or transport options; `serverCertificateHashes` is incompatible with pooling (rejected at validation).
- **Terminology:** Use "endpoint pooling" (reuse of `Endpoint`) — not "connection pooling" or "session pooling."

See `docs/PARITY_MATRIX.md` for parity status.

## requireUnreliable Invariant

On supported targets (Bun/Node/Deno on macOS/Linux/Windows), the transport backend is QUIC/WebTransport, which supports unreliable (datagram) delivery. Therefore `requireUnreliable: true` is satisfiable and accepted. This option participates in the pool compatibility key; connects with differing `requireUnreliable` values do not share a pooled endpoint.

## Error Model and Browser-Style Names

- **Stable `E_*` codes:** All errors carry `code` (e.g. `E_TLS`, `E_HANDSHAKE_TIMEOUT`) for programmatic handling. This is preserved for backward compatibility.
- **Deterministic browser name for validation:** `allowPooling + serverCertificateHashes` throws with `name: "NotSupportedError"` and `code: E_INTERNAL`.
- **strictW3CErrors option:** When `strictW3CErrors: true` is passed to `connect()` or `new WebTransport()`, connect-path, session, and Web Streams facade errors use browser-style DOMException names while retaining `code: E_*`. Default is `false` for backward compatibility. Strict mode affects error surface only, not transport internals.
- **Mapping rules (when strictW3CErrors):** E_TLS → NetworkError; E_HANDSHAKE_TIMEOUT/E_BACKPRESSURE_TIMEOUT → TimeoutError; E_SESSION_CLOSED/E_SESSION_IDLE_TIMEOUT → InvalidStateError; E_STREAM_RESET/E_STOP_SENDING → AbortError; E_LIMIT_EXCEEDED/E_QUEUE_FULL/E_RATE_LIMITED → QuotaExceededError; invalid option types → TypeError; allowPooling+serverCertificateHashes → NotSupportedError; other E_INTERNAL cases → OperationError.
- **Unknown errors:** No broad catch-all; unmapped cases keep `name: "WebTransportError"`.

## TypeScript API (authoritative)

### Server

```ts
export type TlsOptions = {
  certPem: string | Uint8Array;
  keyPem: string | Uint8Array;
  /** Not supported for server. Passing caPem to createServer rejects with E_TLS. */
  caPem?: string | Uint8Array;
  serverName?: string; // for server: used in logs/metrics only; for client: SNI override
  /** Additional hostname-specific certificates for server mode. */
  sni?: Array<{
    serverName: string;
    certPem: string | Uint8Array;
    keyPem: string | Uint8Array;
  }>;
  /**
   * Server-only policy for unknown SNI hostnames when `sni` entries exist.
   * Default is "reject". No-SNI clients still receive the default cert.
   */
  unknownSniPolicy?: "reject" | "default";
  /** Production guard override for empty cert/key fallback. */
  allowSelfSigned?: boolean;
};

export type RateLimitOptions = {
  handshakesPerSec: number; handshakesBurst: number;
  handshakesBurstPerPrefix?: number; // per /24 IPv4 or /64 IPv6; default 100
  streamsPerSec: number; streamsBurst: number;
  datagramsPerSec: number; datagramsBurst: number;
};

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

  maxDatagramSize: number; // hard cap in bytes (also must respect negotiated max)
  maxQueuedBytesGlobal: number;
  maxQueuedBytesPerSession: number;
  maxQueuedBytesPerStream: number;

  backpressureTimeoutMs: number;
  handshakeTimeoutMs: number;
  idleTimeoutMs: number;
};

export type ServerOptions = {
  host?: string;          // default: 0.0.0.0
  port: number;
  tls: TlsOptions;
  limits?: Partial<LimitsOptions>;
  rateLimits?: Partial<RateLimitOptions>;

  // Called on each accepted session (must not block; long work should be async)
  onSession: (session: ServerSession) => void | Promise<void>;

  // Optional logging hook
  log?: (event: LogEvent) => void;
};

export type LogEvent = {
  level: "debug" | "info" | "warn" | "error";
  msg: string; // may be sanitized/empty under redaction policy
  sessionId?: string; // optional, may be redacted/omitted
  peerIp?: string; // optional, may be redacted/omitted
  peerPort?: number; // optional, may be redacted/omitted
  data?: Record<string, unknown>;
};

export interface WebTransportServer {
  readonly address: { host: string; port: number };
  /**
   * Hot-swap TLS leaf cert/key material in place.
   * Existing sessions stay open; only new handshakes observe the new certificate.
   * Transport-config or bind-address changes still require rebuilding/restarting the server.
   */
  updateCert(tls: { certPem: string | Uint8Array; keyPem: string | Uint8Array }): Promise<void>;
  /**
   * Atomically replace the full server TLS configuration in place.
   * Existing sessions stay open; only new handshakes observe the new configuration.
   * Supports replacing the default cert/key, SNI cert map, and unknown-SNI policy.
   * Transport-config or bind-address changes still require rebuilding/restarting the server.
   */
  updateTls(tls: TlsOptions): Promise<void>;
  /** Replace only the full SNI cert map, preserving the default cert/key and unknown-SNI policy. */
  replaceSniCerts(sni: Array<{
    serverName: string;
    certPem: string | Uint8Array;
    keyPem: string | Uint8Array;
  }>): Promise<void>;
  /** Add or replace one hostname-specific SNI certificate. */
  upsertSniCert(sni: {
    serverName: string;
    certPem: string | Uint8Array;
    keyPem: string | Uint8Array;
  }): Promise<void>;
  /** Remove one hostname-specific SNI certificate. */
  removeSniCert(serverName: string): Promise<void>;
  /** Update only the unknown-SNI policy. */
  setUnknownSniPolicy(policy: "reject" | "default"): Promise<void>;
  /** Inspect active SNI names and policy without exposing key material. */
  tlsSnapshot(): { sniServerNames: string[]; unknownSniPolicy: "reject" | "default" };
  close(): Promise<void>;
  metricsSnapshot(): MetricsSnapshot;
}

export function createServer(opts: ServerOptions): WebTransportServer;
```

### Server TLS / SNI semantics

- `tls.certPem` / `tls.keyPem` are the default server certificate and key.
- `tls.sni` adds hostname-specific certificates chosen from the client SNI value.
- Server names are IDNA-normalized to canonical ASCII after trimming a trailing `.`, so Unicode inputs are matched by their punycode form.
- Wildcards are supported only in the left-most label, for example `*.example.com`.
- Wildcards match exactly one label: `*.example.com` matches `api.example.com`, but not `example.com` or `a.b.example.com`.
- Exact hostname entries take precedence over wildcard entries.
- If `tls.sni` is empty, the server always serves the default certificate.
- If `tls.sni` is non-empty and `unknownSniPolicy` is `"reject"` (default), unknown SNI names are rejected during TLS handshake.
- If `tls.sni` is non-empty and `unknownSniPolicy` is `"default"`, unknown SNI names fall back to the default certificate.
- Clients that send no SNI still receive the default certificate.
- `updateCert()` changes only the default certificate/key.
- `updateTls()` atomically replaces the default certificate/key, full SNI map, and `unknownSniPolicy`.
- `replaceSniCerts()` atomically replaces only the SNI cert map, preserving the default certificate/key and `unknownSniPolicy`.
- `upsertSniCert()` adds or replaces one SNI hostname mapping in place.
- `removeSniCert()` removes one SNI hostname mapping in place.
- `setUnknownSniPolicy()` changes only unknown-SNI behavior in place.
- `tlsSnapshot()` returns sorted active SNI hostnames in canonical ASCII form plus the current `unknownSniPolicy`.
- Operators should review configured Unicode hostnames for homograph/confusable risk; IDNA normalization makes names protocol-correct, not human-safe.
- `tls.sni` and `unknownSniPolicy` require a non-empty default `certPem` / `keyPem`; they do not participate in the dev self-signed fallback path.

### Client

```ts
export type ClientOptions = {
  tls?: {
    /** PEM-encoded CA cert(s) added to trust store. Combined with platform native CAs. */
    caPem?: string | Uint8Array;
    /** Override host for TLS SNI (e.g. connect to 127.0.0.1 with cert for "localhost"). */
    serverName?: string;
    /** Skip cert verification (dev only; emits warning). */
    insecureSkipVerify?: boolean;
  };
  limits?: Partial<LimitsOptions>;
  log?: (event: LogEvent) => void;
};

export function connect(url: string, opts?: ClientOptions): Promise<ClientSession>;
```

### Sessions (server + client)

```ts
import type { Duplex, Readable, Writable } from "node:stream";

export type CloseInfo = { code?: number; reason?: string };

export type WebTransportBidirectionalStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

export type WebTransportReceiveStream = ReadableStream<Uint8Array>;

export interface CommonSession {
  readonly id: string;
  readonly peer: { ip: string; port: number };

  readonly ready: Promise<void>;
  readonly closed: Promise<CloseInfo>;

  close(info?: CloseInfo): void;

  // Datagrams
  sendDatagram(data: Uint8Array): Promise<void>;
  incomingDatagrams(): AsyncIterable<Uint8Array>;
}

export interface ServerSession extends CommonSession {
  // Streams
  createBidirectionalStream(options?: { waitUntilAvailable?: boolean }): Promise<Duplex>;
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;

  createUnidirectionalStream(options?: { waitUntilAvailable?: boolean }): Promise<Writable>;
  readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;

  // Metrics (per session)
  metricsSnapshot(): SessionMetricsSnapshot;
}

export interface ClientSession extends CommonSession {
  // Streams
  createBidirectionalStream(options?: { waitUntilAvailable?: boolean }): Promise<Duplex>;
  incomingBidirectionalStreams(): AsyncIterable<Duplex>;

  createUnidirectionalStream(options?: { waitUntilAvailable?: boolean }): Promise<Writable>;
  incomingUnidirectionalStreams(): AsyncIterable<Readable>;

  // Metrics (per session)
  metricsSnapshot(): SessionMetricsSnapshot;
}
```

### Stream control extensions

All outgoing streams must additionally expose:
```ts 
reset(code?: number): void
```
All incoming-capable streams must additionally expose:
```ts
stopSending(code?: number): void
```
In JS, implement as symbol-based methods on the stream object (to avoid name collisions), and also export helpers:

```ts
export const WT_RESET: unique symbol;
export const WT_STOP_SENDING: unique symbol;

export type Resettable = { [WT_RESET](code?: number): void };
export type StopSendable = { [WT_STOP_SENDING](code?: number): void };
``` 

For browser-shaped facade streams, the control mapping is:
- Writable stream `abort(reason)` -> stream reset (native reset path)
- Readable stream `cancel(reason)` -> stop-sending (native stop-sending path)
- Symbol controls remain available for Node-first compatibility.

### Metrics

```ts
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
  handshakeLatency?: HistogramSnapshot | null;
  datagramEnqueueLatency?: HistogramSnapshot | null;
  streamOpenLatency?: HistogramSnapshot | null;
};

export type HistogramSnapshot = {
  le: number[];
  cumulativeCount: number[];
  count: number;
  sumSecs: number;
};

export type SessionMetricsSnapshot = {
  datagramsIn: number;
  datagramsOut: number;
  streamsActive: number;
  queuedBytes: number;
};
```

### Semantics (must be implemented)
- `sendDatagram()` Promise resolves only when accepted into a bounded internal queue (or sent). If queues are full, it must wait (backpressure). If waiting exceeds `backpressureTimeoutMs`, reject with `E_BACKPRESSURE_TIMEOUT`.
- Incoming datagrams are delivered via AsyncIterable on both server/client sessions.
- Incoming streams are delivered as ReadableStream properties on `ServerSession` and as AsyncIterable methods on `ClientSession`.
- On session close, iterators/streams must terminate promptly.
- Node stream backpressure:
* writing beyond buffer returns `false`, then `'drain'` fires when writable resumes.
- Idle timeout: a session with no activity (configurable definition) must close with `E_SESSION_IDLE_TIMEOUT` / close info.
- Limits and rate limits must be enforced before allocating unbounded buffers.

Examples (expected to work):
- Datagram echo server and client
- Bidi stream echo server and client
- Uni stream upload and download

## API stability and semver

- **Stable surface**: Types and functions in this spec are the public API.
- **Semver**: Major (X.0.0) for breaking changes; minor (x.Y.0) for additive changes; patch (x.y.Z) for fixes.
- **Error codes**: E_* codes are stable; do not remove or change meaning.
- **Metrics fields**: ServerMetricsSnapshot and SessionMetricsSnapshot field names are stable; new fields may be added in minor releases.
