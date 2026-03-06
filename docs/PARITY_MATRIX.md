# PARITY_MATRIX.md

## Scope

Track API parity against the WebTransport W3C Editor's Draft snapshot:

- Snapshot: `docs/w3c/w3c.github.io-2026-02-04.md`
- Living: [https://w3c.github.io/webtransport/](https://w3c.github.io/webtransport/)

This matrix is the single source of truth. Update it when implementation changes land.

## Parity Baseline (Phase 0)

`packages/webtransport/test/parity-baseline.test.ts` freezes the current facade surface:

- Required members: `ready`, `closed`, `draining`, `datagrams`, `incomingBidirectionalStreams`, `incomingUnidirectionalStreams`, `createBidirectionalStream`, `createUnidirectionalStream`, `close`
- Datagrams: `readable`, `writable`, `createWritable()`, `maxDatagramSize` (WebTransportDatagramDuplexStream)
- getStats: returns WebTransportConnectionStats (minimal; datagrams only)
- Constructor options: `allowPooling`, `requireUnreliable` accepted with deterministic runtime semantics

## Legend

- `implemented`: behavior and shape match parity target.
- `partial`: some behavior exists, but semantics or shape differ.
- `missing`: not implemented.
- `diverged`: intentionally different surface/behavior (must be documented).

## Current Surface Strategy

- Current public API is Node-oriented (`createServer`, `connect`, Node streams).
- Browser-style WebTransport client facade is now implemented as an additive API.
- CI parity/interop coverage is in place; remaining work is ongoing hygiene and evidence maintenance.

## Target API Shape (recommended)

### Principle

1. Keep server API Node-native (spec has no server-side API to mirror).
2. Add browser-shaped client API for familiarity and onboarding.
3. Reuse the same native core for both client surfaces.

### Server (keep as-is, Node-first)

```ts
export function createServer(opts: ServerOptions): WebTransportServer;
```

Rationale:

- Backend/server requires operational controls (limits, abuse protection, observability) that browser API does not define.
- Preserves current ergonomics and existing user code.

### Client (add browser-style facade)

```ts
export class WebTransport {
  constructor(url: string, options?: WebTransportClientOptions);

  readonly ready: Promise<void>;
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly draining: Promise<void>;

  readonly datagrams: WebTransportDatagramDuplexStream;
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;

  createBidirectionalStream(options?: WebTransportSendStreamOptions): Promise<WebTransportBidirectionalStream>;
  createUnidirectionalStream(options?: WebTransportSendStreamOptions): Promise<WritableStream<Uint8Array>>;
  close(info?: WebTransportCloseInfo): void;
}
```

### Existing Node client (kept stable)

```ts
export function connect(url: string, opts?: ClientOptions): Promise<ClientSession>;
```

### Optional bridge helper

```ts
export function toWebTransport(session: ClientSession): WebTransportLike;
```

### Error model mapping

- Keep internal stable `E_*` codes.
- Browser-style facade should map failures to spec-like error shapes while preserving machine-readable internal code in `.cause` or equivalent metadata.

### Naming alignment for seamless server/client usage

- Keep close semantics aligned (`code`/`reason` mapping).
- Keep datagram/stream terminology aligned.
- Keep metrics server-specific (`metricsSnapshot`) and out of browser-style client surface unless exposed as optional extension.

### Migration strategy

1. Introduce facade as additive minor release.
2. Keep Node API default in docs for server and advanced backend use.
3. Add a “browser users” quickstart that uses `new WebTransport(...)`.
4. Deprecate nothing in current Node API.

## Matrix


| Spec area             | Member/behavior                                     | Current status | Current implementation mapping                                                                          | Gap summary                                                             | Next step                                                             |
| --------------------- | --------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `WebTransport` ctor   | `new WebTransport(url, options)`                    | `implemented`  | `WebTransport` class exists in `packages/webtransport/src/index.ts`                                      | Constructor now present and wired to core connect path                  | Keep conformance checks in parity suite                               |
| Session lifecycle     | `ready` promise semantics                           | `implemented`  | `WebTransport.ready` implemented in `packages/webtransport/src/index.ts`                                 | Core lifecycle behavior in place and covered by local parity tests      | Verify in CI parity runs                                               |
| Session lifecycle     | `closed` promise semantics                          | `implemented`  | `closed` promise wired via callbacks; `toCloseInfo` maps native `code`/`reason` to `closeCode`/`reason` | Client-initiated close propagates closeCode/reason; interop may show generic message on network loss | Covered by parity-error-close and parity-facade-lifecycle              |
| Session lifecycle     | `draining` promise                                  | `implemented`  | `draining` resolves when `close()` is called (closing process started)                                  | Matches spec semantics via JS-only implementation                       | —                                                                       |
| Session closure       | `close({ closeCode, reason })` semantics            | `implemented`  | `close(info?: WebTransportCloseInfo)` accepts `closeCode`/`reason`, maps to native `code`/`reason`      | Shape and semantics match spec                                          | —                                                                       |
| Datagrams             | `transport.datagrams.readable`                      | `implemented`  | Implemented via facade adapters in `packages/webtransport/src/index.ts`                                 | Web Streams facade exists and local parity tests pass                   | Validate CI parity run and edge semantics                              |
| Datagrams             | `transport.datagrams.writable`                      | `implemented`  | Implemented via facade adapters in `packages/webtransport/src/index.ts`                                 | Writable facade exists and local parity tests pass                      | Validate CI parity run and edge semantics                              |
| Datagrams             | `createWritable()`, `maxDatagramSize`               | `implemented`  | WebTransportDatagramDuplexStream with createWritable options + maxDatagramSize from DEFAULT_LIMITS      | —                                                                       | —                                                                       |
| Datagrams             | datagram options (e.g. send order/group)            | `implemented`  | `createWritable({ sendOrder, sendGroup })` implemented with send-group ownership validation and deterministic scheduler | Deterministic scheduling implemented for facade writes                  | Validate CI parity run and interop stability                            |
| Streams               | `createBidirectionalStream()` returning Web Streams | `implemented`  | Facade conversion implemented in `packages/webtransport/src/index.ts`                                    | Web Streams facade exists and local parity tests pass                   | Validate CI parity run and option semantics                            |
| Streams               | `incomingBidirectionalStreams` readable stream      | `implemented`  | Facade readable stream adapter in `packages/webtransport/src/index.ts`                                  | Surface exists and local parity tests pass                              | Validate CI parity run                                                 |
| Streams               | `createUnidirectionalStream()` writable stream      | `implemented`  | Facade writable stream adapter in `packages/webtransport/src/index.ts`                                  | Surface exists and local parity tests pass                              | Validate CI parity run and option semantics                            |
| Streams               | `incomingUnidirectionalStreams` readable stream     | `implemented`  | Facade readable stream adapter in `packages/webtransport/src/index.ts`                                  | Surface exists and local parity tests pass                              | Validate CI parity run                                                 |
| Streams               | `sendOrder`/`sendGroup` on createBidi/createUni     | `implemented`  | Options mapped to facade scheduler with per-group ordering + validation                                  | Deterministic ordering/group behavior implemented on facade send path    | Validate CI parity run and interop stability                            |
| Streams               | `waitUntilAvailable` on stream creation              | `implemented`  | Node session + facade stream creation support bounded wait/retry for capacity-unavailable opens         | Opt-in waiting semantics avoid immediate `E_LIMIT_EXCEEDED` under transient pressure | Keep timeout semantics covered in parity + boundary tests                |
| Stream control        | reset/stop sending semantics                        | `implemented`  | `writable.abort(reason)` → reset; `readable.cancel(reason)` → stopSending; symbols `WT_RESET`/`WT_STOP_SENDING` preserved | Browser-shaped API + symbol compatibility                               | —                                                                       |
| Error model           | WebTransport error classes/codes                    | `implemented`  | WebTransportError with code, source, streamErrorCode; cause holds internal code                         | Spec-like shape; internal E_* preserved in cause                        | —                                                                       |
| Stats                 | `getStats()` dictionaries                           | `implemented`  | `getStats()` returns datagram stats plus connection counters (`bytesSent`, `bytesReceived`, packet counters); optional fields omitted when unavailable | Optional dictionary fields omitted per spec allowance                    | Expand optional metrics when native exposes them                         |
| Security/auth         | `serverCertificateHashes` behavior                  | `implemented`  | Native TLS verifier performs SHA-256 leaf DER pin comparison; facade validates input shape               | Enforced in connect path with stable error mapping                       | Validate CI with pinned-cert coverage                                    |
| Transport states      | state machine transitions                           | `implemented`  | Internal state machine: connecting → connected → draining → closed / failed                              | Method guards and transition tests (R3)                                 | —                                                                       |
| Termination semantics | iterator/stream termination on close                | `implemented`  | Iterators stop on closed flags; native read/accept returns null on close                                | parity-facade-lifecycle tests cover incomingDatagrams/bidi/uni termination on close | —                                                                       |
| Static capabilities   | `supportsReliableOnly`                             | `implemented`  | WebTransport.supportsReliableOnly = false (QUIC supports unreliable)                                   | —                                                                       | —                                                                       |
| Options               | `congestionControl`                                | `implemented`  | Accepted, validated, and mapped to explicit Quinn controllers: `default` -> Cubic, `throughput` -> BBR, `low-latency` -> NewReno | Effective mode is surfaced via facade getter and preserved in pooling compatibility | Revisit mapping if backend defaults change                               |
| Options               | `datagramsReadableType`                            | `implemented`  | `"bytes"` creates ReadableByteStream with BYOB support; `"default"` uses normal ReadableStream         | —                                                                     | —                                                                       |
| Options               | `allowPooling`                                     | `implemented`  | When true, endpoint-level pooling reuses compatible connects; when false, dedicated sessions             | Pool hit/miss metrics via `clientPoolMetricsSnapshot()`                 | —                                                                       |
| Options               | `requireUnreliable`                                | `implemented`  | Accepted; runtime transport is QUIC/WebTransport and supports unreliable delivery                         | Requirement is always satisfiable on supported backend                 | Keep invariant covered in option tests                                  |
| Options               | `strictW3CErrors`                                  | `implemented`  | When true, errors use browser-style DOMException names; default false for backward compat                 | Coverage: NotSupportedError, TimeoutError, InvalidStateError, TypeError | Remaining gaps: some native errors not yet mapped                        |


## Intentional Divergences (currently)

1. Primary package API is Node-first (not browser-API-first).
2. Node client streams are Node streams; facade exposes Web Streams for browser parity.
3. Optional stats members may be omitted when not available from runtime counters.

## Priority Execution Order (completed)

1. ✅ Constructor option validation semantics (R1).
2. ✅ Close and draining semantics (R2).
3. ✅ State machine transitions (R3).
4. ✅ Stats dictionaries implemented with optional-field omission semantics (R4).
5. ✅ serverCertificateHashes pinning implemented and tested (R5).
6. ✅ Validate parity suite + interop in CI (R6).

## Remaining Work (not yet closed)

1. Ongoing CI hygiene: keep parity/interop/security gates green and evidence artifacts attached in release workflow.
2. ~~Follow-up hardening (closed/draining/termination)~~ — Completed in PARITY-A.
3. ✅ Phase 7 implementation closure complete for targeted parity rows (sendOrder/sendGroup, getStats, congestionControl semantics, serverCertificateHashes).

## Required CI Gate

- `bun run test:parity` is implemented; must remain required in CI.
- Existing interop gate (`tools/interop` Playwright) remains required.

## Files to touch first

- `packages/webtransport/src/index.ts`
- `packages/webtransport/src/streams.ts`
- `packages/webtransport/test/*` (new parity suites)
- `tools/interop/tests/*`
- `.github/workflows/test.yml` (parity/interop gate maintenance)
