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
- Diverged: `getStats` not present on facade
- Unsupported options: `allowPooling`, `requireUnreliable` — explicit rejection

## Legend

- `implemented`: behavior and shape match parity target.
- `partial`: some behavior exists, but semantics or shape differ.
- `missing`: not implemented.
- `diverged`: intentionally different surface/behavior (must be documented).

## Current Surface Strategy

- Current public API is Node-oriented (`createServer`, `connect`, Node streams).
- Browser-style WebTransport client facade is now implemented as an additive API.
- Remaining execution blocker is CI evidence closure (R6); after that, only `partial` rows are follow-up hardening work.

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
| Datagrams             | `createWritable()`, `maxDatagramSize`               | `implemented`  | WebTransportDatagramDuplexStream with createWritable (sendGroup rejected), maxDatagramSize from DEFAULT_LIMITS | —                                                                       | —                                                                       |
| Datagrams             | datagram options (e.g. send order/group)            | `diverged`     | `sendOrder`/`sendGroup` explicitly rejected with E_INTERNAL                                              | Parity option failure behavior implemented (R1)                         | —                                                                       |
| Streams               | `createBidirectionalStream()` returning Web Streams | `implemented`  | Facade conversion implemented in `packages/webtransport/src/index.ts`                                    | Web Streams facade exists and local parity tests pass                   | Validate CI parity run and option semantics                            |
| Streams               | `incomingBidirectionalStreams` readable stream      | `implemented`  | Facade readable stream adapter in `packages/webtransport/src/index.ts`                                  | Surface exists and local parity tests pass                              | Validate CI parity run                                                 |
| Streams               | `createUnidirectionalStream()` writable stream      | `implemented`  | Facade writable stream adapter in `packages/webtransport/src/index.ts`                                  | Surface exists and local parity tests pass                              | Validate CI parity run and option semantics                            |
| Streams               | `incomingUnidirectionalStreams` readable stream     | `implemented`  | Facade readable stream adapter in `packages/webtransport/src/index.ts`                                  | Surface exists and local parity tests pass                              | Validate CI parity run                                                 |
| Stream control        | reset/stop sending semantics                        | `partial`      | Symbol methods `WT_RESET` / `WT_STOP_SENDING` in `packages/webtransport/src/streams.ts`                 | Spec API shape differs; semantics mostly present                        | Bridge to browser-style stream cancellation/abort semantics           |
| Error model           | WebTransport error classes/codes                    | `partial`      | Stable internal `E_*` codes + `WebTransportError` in `packages/webtransport/src/errors.ts`              | Need spec-aligned DOMException/WebTransportError shape in facade        | Add error translator in browser facade                                |
| Stats                 | `getStats()` dictionaries                           | `diverged`     | No `getStats()` on WebTransport facade for v1; use `metricsSnapshot()` on Node session                   | Documented explicit divergence for current release                       | See Intentional Divergences                                            |
| Security/auth         | `serverCertificateHashes` behavior                  | `diverged`     | Facade validates format, then rejects with "not supported in this runtime"                               | Option parsed/validated; explicit unsupported path (R5)                  | —                                                                       |
| Transport states      | state machine transitions                           | `implemented`  | Internal state machine: connecting → connected → draining → closed / failed                              | Method guards and transition tests (R3)                                 | —                                                                       |
| Termination semantics | iterator/stream termination on close                | `implemented`  | Iterators stop on closed flags; native read/accept returns null on close                                | parity-facade-lifecycle tests cover incomingDatagrams/bidi/uni termination on close | —                                                                       |
| Static capabilities   | `supportsReliableOnly` etc.                         | `missing`      | No static capability flags on facade                                                                   | Phase 5 target                                                          | Add capability probing                                                 |


## Intentional Divergences (currently)

1. Primary package API is Node-first (not browser-API-first).
2. Node client streams are Node streams; facade exposes Web Streams for browser parity.
3. **Stats (getStats())**: No `getStats()` on WebTransport facade for v1. Use Node `ClientSession.metricsSnapshot()` for observability. Explicit divergence for current release; may add adapter in future.
4. **serverCertificateHashes**: Option is parsed/validated but runtime does not support it; explicit rejection with clear error.

## Priority Execution Order (completed)

1. ✅ Explicit unsupported-option failure behavior (R1).
2. ✅ Close and draining semantics (R2).
3. ✅ State machine transitions (R3).
4. ✅ Stats: explicit divergence documented (R4).
5. ✅ serverCertificateHashes facade mapping/tests (R5).
6. ⏳ Validate parity suite + interop in CI (R6).

## Remaining Work (not yet closed)

1. Execution blocker: CI evidence closure (R6):
   - local status: `bun run test:parity` passes on current branch
   - confirm `test:parity` pass in CI
   - confirm interop pass in CI
   - confirm security scan jobs pass in CI
2. ~~Follow-up hardening (closed/draining/termination)~~ — Completed in PARITY-A: draining resolves when `close()` called; closed propagates closeCode/reason; termination tests added for iterators.

## Required CI Gate

- `bun run test:parity` is implemented; must remain required in CI.
- Existing interop gate (`tools/interop` Playwright) remains required.

## Files to touch first

- `packages/webtransport/src/index.ts`
- `packages/webtransport/src/streams.ts`
- `packages/webtransport/test/*` (new parity suites)
- `tools/interop/tests/*`
- `.github/workflows/test.yml` (parity job addition)
