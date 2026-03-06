# RFC_CLIENT_FACADE.md

## Title
Browser-Style Client Facade for `@webtransport-bun/webtransport`

## Status
Implemented (see `docs/PARITY_MATRIX.md` and `PARITY_PLAN.md`)

## Motivation
The current package is Node-first and production-friendly for backend usage. For client developers already familiar with browser WebTransport, a browser-shaped API reduces onboarding cost and usage mistakes.

Goals:
1. Add browser-style client API parity for core flows.
2. Keep existing Node-first API stable.
3. Reuse a single native core and avoid duplicate transport logic.

Non-goals:
1. Replace Node-first server API.
2. Remove or deprecate `connect()` and existing Node stream surfaces.
3. Full browser environment parity (workers, browser scheduling internals).

## Proposed Public API

### Keep existing exports (unchanged)
```ts
export function createServer(opts: ServerOptions): WebTransportServer;
export function connect(url: string, opts?: ClientOptions): Promise<ClientSession>;
```

### Add browser-style client facade
```ts
export type WebTransportCloseInfo = {
  closeCode?: number;
  reason?: string;
};

export type WebTransportClientOptions = {
  /** When true, errors use browser-style DOMException names. Default false. */
  strictW3CErrors?: boolean;
  serverCertificateHashes?: Array<{ algorithm: "sha-256"; value: BufferSource }>;
  allowPooling?: boolean;
  requireUnreliable?: boolean;

  /** When "bytes", datagrams.readable is a ReadableByteStream with BYOB support; default uses normal ReadableStream. */
  datagramsReadableType?: "bytes" | "default";

  /** Accepted and forwarded; effective mode may fall back to default when backend support is limited. */
  congestionControl?: "default" | "throughput" | "low-latency";

  // runtime-specific extension for Bun backend apps
  tls?: {
    insecureSkipVerify?: boolean;
    caPem?: string | Uint8Array;
    serverName?: string;
  };

  limits?: Partial<LimitsOptions>;
};

export class WebTransport {
  constructor(url: string, options?: WebTransportClientOptions);

  readonly ready: Promise<void>;
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly draining: Promise<void>;

  readonly datagrams: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };

  readonly incomingBidirectionalStreams: ReadableStream<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;

  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;

  createBidirectionalStream(options?: {
    sendOrder?: number;
    sendGroup?: WebTransportSendGroup | null;
  }): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;

  createUnidirectionalStream(options?: {
    sendOrder?: number;
    sendGroup?: WebTransportSendGroup | null;
  }): Promise<WritableStream<Uint8Array>>;

  close(info?: WebTransportCloseInfo): void;
}
```

### Optional adapter helper
```ts
export function toWebTransport(session: ClientSession): WebTransport;
```

## Semantics and Mapping

### Core mapping strategy
- `WebTransport` facade wraps existing `ClientSession` core.
- `datagrams.writable.write(chunk)` maps to `session.sendDatagram(chunk)`.
- `datagrams.readable` is backed by `session.incomingDatagrams()`.
- Stream methods adapt Node stream handles to Web Streams using bridge wrappers.

### Lifecycle
- `ready`: resolves when underlying `connect()` succeeds.
- `closed`: resolves with close info when session closes cleanly.
- `draining`: resolves when `close()` initiates graceful closure.

### Errors
- Preserve stable internal `E_*` codes.
- `allowPooling + serverCertificateHashes` throws with `name: "NotSupportedError"` and `code: E_INTERNAL`.
- `strictW3CErrors: true` enables browser-style DOMException names (TimeoutError, InvalidStateError, AbortError, etc.) on validation, connect/session, and Web Streams facade errors; `code` remains for programmatic handling.

### Option behavior
- `allowPooling` is accepted; when true, endpoint-level pooling reuses compatible connects.
- `requireUnreliable` is accepted; current runtime transport always supports unreliable delivery.
- `serverCertificateHashes` is rejected when combined with `allowPooling=true`, matching W3C constraints.

## Compatibility
- Server API remains Node-native (`createServer`).
- Existing Node client API (`connect`) remains stable and documented.
- Facade is additive and can be adopted incrementally.

## Implementation Plan

### Completed
1. Facade skeleton (`WebTransport` constructor/lifecycle + parity tests).
2. Datagram facade (`readable`, `writable`, `createWritable`, max datagram size).
3. Stream facade (bidi/uni create + incoming wrappers + reset/stop-sending mapping).
4. Error/close normalization (`closeCode`/`reason`, facade error shape with stable internal codes).
5. Option semantics implemented for:
   - `congestionControl`
   - `datagramsReadableType`
   - `serverCertificateHashes`
   - `allowPooling` / `requireUnreliable` acceptance semantics
6. `sendOrder`/`sendGroup` deterministic scheduling + send-group ownership validation.
7. `test:parity` suite and local pass evidence.

### Remaining
1. CI evidence closure for parity + interop + security gates.

## Acceptance Criteria
1. Browser-style client facade shipped without breaking existing APIs.
2. Core facade flows pass tests:
   - connect + ready/closed/draining
   - datagram read/write
   - bidi + uni create/receive
3. Interop suite still passes.
4. `test:parity` gate integrated into CI.

## Remaining Divergence Closure Work
No targeted client-facade divergence items remain in scope. See `docs/PARITY_MATRIX.md` for current row-level status.
