# SPEC.md

## Package name (suggested)
`@your-scope/webtransport-bun`

## High-level API
The API provides:
- `createServer(options)` for in-process server.
- `connect(url, options)` for client.
- Sessions expose datagrams (Promise send + async iterable receive) and streams (Node streams).

All streams must use standard Node stream backpressure semantics (write() returns false + 'drain').

## TypeScript API (authoritative)

### Server

```ts
export type TlsOptions = {
  certPem: string | Uint8Array;
  keyPem: string | Uint8Array;
  caPem?: string | Uint8Array;
  serverName?: string; // SNI for client mode; for server, used in logs/metrics
};

export type RateLimitOptions = {
  handshakesPerSec: number; handshakesBurst: number;
  handshakesBurstPerPrefix?: number; // per /24 IPv4 or /64 IPv6; default 100
  streamsPerSec: number; streamsBurst: number;
  datagramsPerSec: number; datagramsBurst: number;
};

export type LimitsOptions = {
  maxSessions: number;
  maxHandshakesInFlight: number;
  maxStreamsPerSessionBidi: number;
  maxStreamsPerSessionUni: number;
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
  msg: string;
  sessionId?: string;
  peerIp?: string;
  peerPort?: number;
  data?: Record<string, unknown>;
};

export interface WebTransportServer {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
  metricsSnapshot(): MetricsSnapshot;
}

export function createServer(opts: ServerOptions): WebTransportServer;
```

### Client

```ts
export type ClientOptions = {
  tls?: {
    caPem?: string | Uint8Array;
    serverName?: string;
    insecureSkipVerify?: boolean; // dev only
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

export interface ServerSession extends BaseSession {}
export interface ClientSession extends BaseSession {}
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
- Incoming datagrams and streams are delivered via AsyncIterable. On session close, iterators must terminate promptly.
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
