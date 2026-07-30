# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Native GOAWAY send.** `ServerSession.goAway()` sends the connection-scoped
  H3 `GOAWAY`, surfacing the fork's `Connection::send_goaway`. The peer observes
  it as its `draining` settling (the fork folds a received `GOAWAY` into the same
  signal as `WT_DRAIN_SESSION`), and the session stays usable. Scope caveat:
  native is single-session-per-connection, so `GOAWAY`'s practical use is a
  server-initiated graceful-shutdown signal — the "refuse a second session"
  enforcement it implies is not reachable through the public API. Wasm sends no
  `GOAWAY` and that remains a deliberate non-goal (no control-stream handling in
  the wasm h3 module).
- Server-side `congestionControl` on `ServerOptions` (`"default"` → Cubic, `"throughput"` → BBR, `"low-latency"` → NewReno), matching the existing client option; the effective mode is exposed as `WebTransportServer.congestionControl`.
- Server keep-alive: `limits.keepAliveIntervalMs` now emits QUIC keep-alive packets on server sessions so idle-but-healthy connections survive `idleTimeoutMs`; the interval is clamped to `min(keepAliveIntervalMs, idleTimeoutMs / 3)`, and `0`/omitted keeps keep-alive disabled.
- New `webtransport-bun/portable` entrypoint: an async `createServer` that runs one
  server codebase against the native addon and the wasm backend, dispatching on the
  runtime. The module stays free of static `node:` imports so it loads inside a
  Chromium Isolated Web App; the native adapter is behind a dynamic import.
- `WasmSession.peer` / `WasmServerSession.peer`, backed by a new `wt_conn_peer`
  wasm bridge export over quinn-proto's `Connection::remote_address()`.
- **Native 0-RTT session resumption.** `createServer` accepts `enable0Rtt` (and
  `allowEarlySession`); `connect` and the `WebTransport` client accept
  `enable0Rtt`. Sessions expose `has0Rtt`, `accepted0Rtt`, and
  `handshakeConfirmed`. Opaque, process-local ticket movement is available via
  `exportTicketVault`/`importTicketVault`. 0-RTT is off by default; the session
  request is replayable early data, so by default the server `onSession`
  callback is deferred until the handshake is confirmed (`allowEarlySession`
  opts out for idempotent pre-confirmation work). Resumption state and
  anti-replay are per-process (a restart or a different load-balanced instance
  falls back to a full 1-RTT handshake); durable ticket persistence is out of
  scope. This required forking `wtransport` — see below and
  `docs/FORK_MAINTENANCE.md`.

- **Native dynamic QPACK (opt-in).** `createServer` and the client (`connect` /
  `WebTransport`) accept `qpackMaxTableCapacity` (bytes, clamped to 64 KiB) and
  the `enableDynamicQpack` boolean preset (capacity 4096). Off by default
  (capacity 0 = static-only, unchanged wire behavior). When set, native
  advertises `SETTINGS_QPACK_MAX_TABLE_CAPACITY`, decodes the peer's dynamic
  table, and drives its decoder stream (Section-Ack / Insert-Count-Increment /
  Stream-Cancellation). `SETTINGS_QPACK_BLOCKED_STREAMS` is always advertised as
  0 and is not configurable — the decision that keeps header decoding
  synchronous. A consequence worth stating: because a WebTransport session
  carries a single CONNECT header exchange and at blocked-streams 0 an encoder
  may not reference an unacknowledged entry, native never emits a dynamic-table
  *reference* on the wire; it populates and acknowledges the table but encodes
  the CONNECT literally. This is an interop/completeness feature, not a
  throughput one. Backed by the fork (see below); decode correctness is covered
  by the fork's RFC 9204 Appendix B vectors, and a Chromium interop test proves
  native no longer rejects a peer that advertises a table.

- **WebTransport session capsules on both backends.** A session close now
  reaches the peer as a `WT_CLOSE_SESSION` capsule carrying the application
  code and reason, and a received `WT_DRAIN_SESSION` resolves `draining`
  without ending the session. The wasm backend gained a capsule encoder and
  decoder; the native backend routes `session.close({code, reason})` through
  the fork's `Connection::close_session`.
- Sessions expose `drain()` and a wire-driven `draining` promise on both
  backends and on `webtransport-bun/portable`. `drain()` sends a
  `WT_DRAIN_SESSION` capsule — the session stays fully usable — and `draining`
  resolves when the peer sends one. The existing local-`close()` fallback is
  unchanged, so a peer that never drains still cannot hang a consumer.
- WebTransport application error codes are mapped onto the reserved QUIC range
  and back per draft §4.4, for QUIC **stream** codes only — the close capsule
  carries the raw 32-bit code.
- The wasm backend rejects streams that never associate with a session using
  `WT_BUFFERED_STREAM_REJECTED`.

### Changed

- Upgraded `wtransport` from `=0.7.0` to `=0.7.1`, then switched both the native
  addon and the reference server from the crates.io release to a Git dependency
  on the `vmeansdev/wtransport` fork (branch `feat/qpack-dynamic`, which stacks
  on `feat/track1-conformance`, pinned by rev `ac515b1`, version
  `0.7.1-zerortt-qpack.1`) via `[workspace.dependencies]`. The fork adds the
  0-RTT APIs upstream 0.7.1 lacked, the session lifecycle work above, and the
  dynamic QPACK decode + encoder machinery; the swap is behavior-neutral while
  the QPACK capacity default stays 0. The reference crate keeps the `quinn`
  feature for compile parity.
- The wasm `SETTINGS_WT_MAX_SESSIONS` codepoint was corrected to Chromium's
  `0xc671706a`; the previous value was fabricated.
- `docs/PARITY_MATRIX.md` now lists native 0-RTT **and** native dynamic QPACK as
  **implemented (on the fork)** rather than upstream-gated; the upstream-gated
  table is now empty. `docs/WASM_PROTOCOL_SCOPE.md` notes the native/wasm 0-RTT
  and dynamic-QPACK parity, including the deliberate blocked-streams divergence
  (native always 0, wasm defaults 16).
- `WasmServerSession` now mirrors the native `ServerSession` surface (`id`, `peer`,
  `incomingDatagrams()`, incoming stream `ReadableStream`s, `getStats()`), delegating
  to a `WasmWebTransport` over the same session. `createBidirectionalStream` and
  `createUnidirectionalStream` are now async and resolve to W3C `{ readable, writable }`
  pairs; the synchronous raw-stream form remains reachable through `unwrap()`.
  The callback API (`onDatagram`/`onIncomingStream`) is deprecated but retained, and
  now throws if combined with the W3C surface on the same session rather than
  silently dropping datagrams. `/wasm` remains a candidate surface.
- All nine `parity-*.test.ts` suites now run against both backends.

### Fixed

- A wasm session that closed itself reported `reason: undefined` from `closed`; the
  caller's close reason is now retained locally, matching native.
- A server-initiated close reached a browser as a bare QUIC `CONNECTION_CLOSE`,
  so Chromium reported only "Connection lost" with no code or reason. Both
  backends now send the close capsule, and the Chromium interop specs assert the
  real code and reason instead of tolerating the loss.
- Reading a peer's close took the code from `closed()`, which reports the QUIC
  connection's fate — `H3_NO_ERROR` once a close capsule has been handled — and
  so lost the session's real close code. The code and reason are now taken from
  the session operation that carries them.

## [0.3.0](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.4...v0.3.0) - 2026-03-08

### Changed

- Bumped the published package and native addon metadata to `0.3.0` for the first release-candidate cut.
- Status, CI, release, and publish documentation now describe the `0.3.0` RC process and examples consistently.

## [0.2.4](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.3...v0.2.4) - 2026-03-05

### Fixed

- `waitUntilAvailable` server-side stream opens now use native capacity signaling (`waitBidiCapacity`/`waitUniCapacity`) instead of JS-only polling, reducing wake latency and avoiding unnecessary retry loops under stream-pressure.
- Native server session limits are now scoped per session/server instance, fixing cross-server limit leakage where the first server's limits could affect subsequent servers in the same process.

### Added

- Regression coverage for native `waitUntilAvailable` signaling paths on server sessions.
- Multi-server regression coverage that verifies per-server datagram limits remain isolated.

### Changed

- Documentation consistency refresh for `0.2.4` status and CI gate descriptions.

## [0.2.3](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.2...v0.2.3) - 2026-03-03

### Fixed

- Eliminated a server-side close propagation race that could surface client-initiated closes as `code: 0, reason: ""` instead of the client-provided close info.
- Hardened native session and stream paths to return explicit, stable `E_*` diagnostics across additional error branches.
- Improved TypeScript-side propagation of non-close errors vs session-close EOF semantics for incoming iterators and stream wrappers.

### Added

- Chromium interop regression coverage that asserts browser-initiated close `code`/`reason` is observable on the server side.
- Additional regression coverage for reset/stopSending-related error mapping and CA PEM TLS validation edge cases.
- Internal tests for native addon loader diagnostics and connect-time race handling.
- Echo playground close-code/reason demo controls and server-side close logging showcase.

### Changed

- NPM/package docs and metadata now consistently describe runtime support as Bun + Node + Deno.
- Release/publish guidance updated with cross-runtime install/import smoke checks and updated `0.2.3` examples.

## [0.2.2](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.1...v0.2.2) - 2026-03-02

### Fixed

- `session.closed` now consistently propagates close `code` and `reason` from client-initiated close events to both client and server session surfaces.
- Close info mapping now normalizes unset values to deterministic defaults (`code: 0`, `reason: ""`) for stable consumer behavior.

### Added

- Regression coverage for client-initiated close propagation to `serverSession.closed` with bounded-time assertions.

## [0.2.1](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.0...v0.2.1) - 2026-03-01

### Changed

- Release and publish workflows now build package `dist/` explicitly before tarball verification and npm publish, preventing missing runtime artifacts when scripts are ignored during publish.
- GitHub release artifacts now include a packaged npm `.tgz` in addition to native prebuilds and evidence files.
- README install guidance now documents npm package contents (`dist/`, `prebuilds/`) and clarifies that GitHub source archives are not equivalent to published package outputs.

### Documentation

- CI and release docs now include branch protection policy details and checked-in ruleset payload guidance for protecting `main` from direct pushes.

## [0.2.0](https://github.com/vmeansdev/webtransport-bun/compare/v0.1.0...v0.2.0) - 2026-02-25

### Added

- Browser-shaped `WebTransport` facade parity coverage and option support, including `congestionControl`, `datagramsReadableType`, `supportsReliableOnly`, and `getStats()` mapping.
- Datagram facade enhancements: duplex shape (`readable`/`writable`), `createWritable(...)`, `maxDatagramSize`, and BYOB-readable support for `datagramsReadableType: "bytes"`.
- Stream option acceptance and deterministic scheduling for `sendOrder`/`sendGroup` on datagram and stream write paths.
- Endpoint pooling behavior for compatible client connects (`allowPooling`) with explicit compatibility-key semantics.
- Runtime error-path coverage for `E_RATE_LIMITED`, `E_SESSION_IDLE_TIMEOUT`, and `E_STOP_SENDING`.
- Observability additions: latency histograms, Prometheus SLO alert surfaces, and backpressure-timeout counters.
- CI and release hardening workflows, including dedicated parity CI, rollback drill safeguards, and expanded interop evidence collection.

### Changed

- W3C parity lifecycle semantics to align closure and termination behavior for facade streams and iterators.
- Server incoming stream surface for tighter W3C alignment.
- TLS handling for deterministic client handshake behavior (SNI normalization and CA PEM validation).
- Test strategy to enforce bounded waits and reduce nondeterministic hangs in CI.

### Fixed

- TypeScript facade stream typings and DOM-specific typecheck issues in CI.
- Interop script execution for Playwright-based runs.
- Metrics timing and race-related CI flakes in parity/backpressure/fairness/drain/adversarial suites.
- Client connect path clippy issues and assorted CI regressions.
- Server startup now fails fast during `createServer(...)` when endpoint initialization/bind fails, returning `E_INTERNAL` immediately instead of surfacing as downstream timeout behavior.
- `maxSessions` overflow handling now rejects excess connects with stable `E_LIMIT_EXCEEDED` signaling, making limit-boundary behavior deterministic for clients and CI.
- Test harness port allocation is now collision-resistant per process/range to reduce nondeterministic bind flakes in parallel CI runs.

### Documentation

- Refreshed and expanded `README.md`, `docs/SPEC.md`, `docs/PARITY_MATRIX.md`, `docs/TESTPLAN.md`, `docs/CI.md`, and related operational docs to reflect parity and hardening status.

## [0.1.0](https://github.com/vmeansdev/webtransport-bun/releases/tag/v0.1.0) - 2026-02-04

### Added

- Initial public beta release of `@webtransport-bun/webtransport`.
- Bun in-process WebTransport server/client powered by Rust `wtransport` via `napi-rs`.
- Datagram and stream APIs with production-focused limits, abuse controls, and CI coverage.
