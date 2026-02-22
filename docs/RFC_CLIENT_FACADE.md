# RFC_CLIENT_FACADE.md

## Title
Browser-Style Client Facade for `@webtransport-bun/webtransport`

## Status
Draft (implementation-ready)

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
  serverCertificateHashes?: Array<{ algorithm: "sha-256"; value: BufferSource }>;
  allowPooling?: boolean;
  requireUnreliable?: boolean;

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
    sendGroup?: number;
  }): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;

  createUnidirectionalStream(options?: {
    sendOrder?: number;
    sendGroup?: number;
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
- `draining`: resolves before `closed` when no new streams should be created (initially alias to `closed` until native signal exists, documented as partial parity).

### Errors
- Preserve stable internal `E_*` codes.
- Surface browser-like errors in facade while attaching internal code in metadata (`cause.code` or equivalent).

### Unsupported option behavior
- If options such as `sendGroup` are unsupported, fail explicitly with stable error (`E_INTERNAL` or dedicated mapped error) instead of silently ignoring.

## Compatibility
- Server API remains Node-native (`createServer`).
- Existing Node client API (`connect`) remains stable and documented.
- Facade is additive and can be adopted incrementally.

## Implementation Plan

### Phase A: Facade skeleton
1. Add `WebTransport` class and constructor wiring to `connect()`.
2. Add lifecycle promises (`ready`, `closed`, `draining` placeholder behavior).
3. Add parity-focused unit tests for constructor/lifecycle.

### Phase B: Datagram streams facade
1. Add `datagrams.readable` and `datagrams.writable` wrappers.
2. Ensure backpressure and close semantics are deterministic.
3. Add tests for read/write/close/error paths.

### Phase C: Stream facade
1. Add bidi and uni Web Streams wrappers.
2. Add incoming stream readable wrappers.
3. Ensure reset/stop-sending behavior is mapped consistently.

### Phase D: Error + close-info normalization
1. Normalize close info shape to `closeCode/reason` in facade.
2. Map stable errors to facade-friendly errors with code metadata.
3. Add conformance tests.

### Phase E: CI parity gate
1. Add `bun run test:parity` suite.
2. Add CI job requiring parity suite pass.

## Acceptance Criteria
1. Browser-style client facade shipped without breaking existing APIs.
2. Core facade flows pass tests:
   - connect + ready/closed/draining
   - datagram read/write
   - bidi + uni create/receive
3. Interop suite still passes.
4. `test:parity` gate integrated into CI.

## Open Questions
1. Should `draining` remain alias-to-closed until native support exists, or stay unimplemented initially?
2. Which unsupported options should hard-fail vs soft-warn?
3. Should adapter expose experimental `getStats()` mapped from `metricsSnapshot()` in v1?
