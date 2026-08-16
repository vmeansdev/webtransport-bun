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

## Protocol posture

Both backends speak the draft-02/07 wire format, because that is what Chromium
interoperates with and interop is the bar. Elements of draft-16 are adopted
**additively, where they are free** — a session close now travels as a
`WT_CLOSE_SESSION` capsule, drains as `WT_DRAIN_SESSION`, and stream error
codes go through the §4.4 `WT_APPLICATION_ERROR` mapping. None of that changes
the wire format Chromium sees, and all of it is verified against a real browser
(`tools/interop/`).

This is **not** a claim of draft-16 conformance. Full conformance is blocked
upstream on `RESET_STREAM_AT`, which quinn does not implement; see
`docs/PARITY_MATRIX.md` for what is and is not present on each backend.

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
- Remaining parity tracking is in `docs/PARITY_MATRIX.md`, split into client-facade parity, portable server/session parity, intentional backend-specific extensions, and environment/distribution evidence.

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
  // streams/datagrams limits are keyed PER PEER IP, not per session: N
  // sessions from one address (NAT/CGNAT, proxies, load tests from one
  // host) share a single budget. Size the limits for the address, not the
  // session, when many clients can share an IP.
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
- `tls.keyPem` accepts unencrypted PKCS#8 (`BEGIN PRIVATE KEY`), SEC1 ECDSA (`BEGIN EC PRIVATE KEY`), and PKCS#1 RSA (`BEGIN RSA PRIVATE KEY`) PEM. Encrypted keys are not supported. A key that does not match the leaf certificate's public key fails server construction.
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
- Reliable-stream receive paths apply the same bound: when the byte budget (`maxQueuedBytesPerStream`/`maxQueuedBytesPerSession`) stays exhausted — a reader that consumes nothing for a full `backpressureTimeoutMs` — the stream is stopped and pending reads reject with `E_BACKPRESSURE_TIMEOUT`. A reader that frees any capacity within the window keeps the stream. This bound is load-bearing for memory: an abandoned reader must not pin the stream's native state for the life of the process.
- Incoming datagrams are delivered via AsyncIterable on both server/client sessions. See "Incoming datagram delivery" below for the delivery contract and the native batching knob.
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

## Incoming datagram delivery

`incomingDatagrams()` is the same public API on both native session classes and
on `/portable`: an `AsyncIterable<Uint8Array>`, memoized per session, yielding
one datagram at a time, in the order the backend received them, terminating
once the session is closed. Datagrams are droppable by contract — nothing below
turns a lost datagram into an error.

Internally the native backend no longer crosses Node-API once per datagram. The
generator calls `readDatagramBatch(max)` on the native handle, which resolves
`Uint8Array[] | null`, and yields the returned items one by one before asking
for the next batch. `max` is clamped silently to `1..=256` in native; the
JavaScript layer clamps first, so the native clamp is a backstop. The batch
methods are reject-free: data, EOF, closure, and an out-of-range `max` all
resolve rather than throw. Only a runtime panic or an unrecoverable Node-API
allocation failure can still reject, exactly as on the pre-existing single-read
path.

### `WEBTRANSPORT_DATAGRAM_BATCH`

| Value | Effect |
| --- | --- |
| unset or invalid | `64` (the default) |
| `0` | legacy path: one `readDatagram()` call per datagram |
| `1` | the new batch path with degenerate one-item batches |
| `2`–`256` | batch size |
| negative | `0` |
| greater than `256` | `256` |

"Invalid" means empty, non-decimal, non-finite, or non-integer. The variable is
read **once at module initialization**, so a process cannot change delivery
shape halfway through a session's lifetime, and it is **native-only** — wasm
datagram delivery does not go through Node-API and is unaffected.

The knob is a performance dial, but it is not purely one: because batching wins
the close race by needing one round-trip instead of one per datagram, the batch
size visibly changes how much tail a consumer receives when the peer ends the
connection cleanly (see deviation 3 below). Do not treat a change in observed
tail length as a bug.

### Buffering bounds

Draining moves up to `max` items out of the native channel per acquisition, so
effective buffering becomes `2048 + max` datagrams per server session and
`256 + max` per client session, and the per-session byte budget
(`maxQueuedBytesPerSession` on the server, the client datagram budget) is
loosened by up to one batch of payload bytes. The pull model still bounds total
in-flight data: no new batch is requested until the consumer has drained the
previous one.

### Semantic deviations

Three JS-visible behaviors changed. All three are permitted for an unreliable,
droppable transport, and all three are stated rather than hidden.

1. **Post-close prefetch.** The generator may yield up to `max` already-
   delivered datagrams after the session is closed, instead of at most 1.
2. **Mid-batch abandonment.** Abandoning the iterator mid-batch discards up to
   `max - 1` already-received datagrams, instead of at most 1.
3. **Close-time drop-not-drain.** On a sticky close, a parked or newly entered
   read returns EOF immediately and datagrams still queued natively are
   discarded. Previously a parked read drained every buffered item before
   yielding EOF. This applies to **both** handles and **both** lanes — the
   legacy `WEBTRANSPORT_DATAGRAM_BATCH=0` path shares the same sticky lifecycle
   wake, so it is not confined to batch mode. It is JS-visible delivery only:
   reservation accounting for the discarded remainder is settled internally in
   both directions, so no budget or gauge is stranded, but settlement is
   bounded rather than instantaneous.

On a clean connection end, how much of the remaining tail a consumer receives
**depends on the configured batch size, and no count is guaranteed**. In one
measured run over the same 12-datagram tail: 2 of 12 delivered at
`WEBTRANSPORT_DATAGRAM_BATCH=0` versus 12 of 12 at `64`. Those counts are an
illustration of the effect, not a specification of it — the quantity is racy,
which is why the tests that cover it assert ranges rather than equalities. The forwarder is no longer an independent
unconditional discarder, but in production forwarder EOF and connection end
coincide and the terminal drain still discards that remainder — the improvement
is a **race window that batching is more likely to win, not a delivery
guarantee**.

### `iter.throw()` mapping

The shared generator now yields outside its `try`, so an error injected with
`iter.throw()` at a yield point is no longer passed through the error mapper: it
propagates as the caller's own error. Nothing in this repository calls
`iter.throw()`, and `AsyncIterator.prototype.throw` is optional in the language
spec so `AsyncIterable<Uint8Array>` promises nothing about it, but the method is
reachable from user code because `incomingDatagrams()` returns the generator and
its `[Symbol.asyncIterator]()` returns itself. The new behavior is strictly
better than the old: previously an injected error whose message merely resembled
a session-close error was silently converted into a clean `done: true`, and any
other injected error was rewrapped as a `WebTransportError` the caller never
threw.

## API stability and semver

### The three exported surfaces

The package exports exactly three entrypoints, and they promise different
things. `packages/webtransport/test/public-surface-contract.test.ts` freezes all
three — the export lists at runtime, and the shared session/server contract both
at compile time (`tsc --noEmit`) and against a live session from each backend.

| Entrypoint | Contract |
| --- | --- |
| `@webtransport-bun/webtransport` (root) | Native Node-API server/client API. `createServer()` is **synchronous**. Node streams (`Duplex`/`Writable`) on the session stream constructors. Native-only capabilities live here and only here: `releaseNativeMemory()`, `exportTicketVault`/`importTicketVault`, `connect()`, `metricsToPrometheus()`, `ServerSession.goAway()`, SNI/cert rotation, keep-alive and congestion-control knobs. |
| `@webtransport-bun/webtransport/wasm` | Async WASM/IWA API. `createServer()` returns a promise. Backend-specific extensions are allowed and documented here: Direct Sockets binding, `UdpTransport` injection, ticket-store hosts, `serveOverUdp`, self-signed cert generation and `certHashBase64` pinning. |
| `@webtransport-bun/webtransport/portable` | The common async subset implemented by *both* backends: one `createServer()` returning `PortableServer`, whose sessions expose `id`, `peer`, `ready`, `closed`, `close()`, `drain()`, `sendDatagram()`, `incomingDatagrams()`, the two incoming-stream `ReadableStream`s, the two stream constructors, and `metricsSnapshot()`. Stream constructors resolve to W3C `{ readable, writable }` pairs on both backends. `incomingDatagrams()` is equal *within the contract*: same item type, memoization, receive order, and bounded termination, but not identical hidden buffering — native batching stays active behind `/portable`, with the bounds in "Incoming datagram delivery" above. |

Capabilities only one backend can honour stay out of `/portable` by design —
native `goAway()` (the wasm h3 module has no control-stream `GOAWAY` handling),
native keepalive and ticket-vault APIs, wasm ticket hosts, and IWA Direct
Sockets. `PortableServer.certHashBase64` is the one deliberately optional field:
wasm clients pin a hash, native clients chain-validate, so it is present on wasm
and `undefined` on native.

`/wasm` has a frozen export list but a `candidate` stability label; see
`docs/release-status.json`. Freezing names is not the same as promising
behavior under gates that have not passed.

### Semver rules

- **Stable surface**: Types and functions in this spec are the public API.
- **Semver**: Major (X.0.0) for breaking changes; minor (x.Y.0) for additive changes; patch (x.y.Z) for fixes.
- **Error codes**: E_* codes are stable; do not remove or change meaning.
- **Metrics fields**: ServerMetricsSnapshot and SessionMetricsSnapshot field names are stable; new fields may be added in minor releases.
- **`__TESTING__` is explicitly unstable**: the root module's `__TESTING__`
  export is a bag of internal test seams (addon loading, session/stream
  construction hooks). It is not part of this spec, is excluded from the frozen
  export list, and may be reshaped or removed in any release without a major
  bump. Do not depend on it outside this repository's own tests.
