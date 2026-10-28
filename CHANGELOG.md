# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased (1.0.0)

This section is the 1.0.0 release (the package is `1.0.0-rc.1` until it is
cut). Surfaces under **Experimental** ship in 1.0 but may change in a 1.x minor
(`docs/SPEC.md`, "Experimental surfaces"). **Removed and internalized** lists
what was on the release-candidate branch and is deliberately not public in
1.0.

### Added

- **Batched incoming datagrams (native).** `incomingDatagrams()` drains the
  native channel in batches of up to `WEBTRANSPORT_DATAGRAM_BATCH` items per
  Node-API crossing (default `64`; `0` restores one crossing per datagram,
  range `0`–`256`). The public iterator still yields one `Uint8Array` at a
  time, in receive order. Buffering and close-tail deviations are in
  `docs/SPEC.md` ("Incoming datagram delivery").
- **`session.sendDatagramBatch(datagrams)` (native).** Many datagrams in one
  crossing with a resolved **prefix** envelope `{ sent, error? }`. Payloads are
  copied before it returns, there is one backpressure deadline for the whole
  call, and an array longer than the 256-element native cap is chunked
  transparently. Native-only; `/portable` keeps `sendDatagram()`.
- **Promise-free `sendDatagram()` (native, server and client).**
  `session.sendDatagram()` first tries a synchronous native send that hands
  JavaScript no promise. It falls back to the parking call, and counts it in
  `datagramSendsAsync`, only when the byte budget is full. The call signature
  is unchanged. `WEBTRANSPORT_DATAGRAM_SEND_SYNC=0` is the escape hatch
  (`docs/OPERATIONS.md`, "Escape hatches").
- **Explicit QUIC flow-control windows (native).** `limits.streamReceiveWindow`,
  `limits.receiveWindow` and `limits.sendWindow` set the advertised transport
  windows independently of the `maxQueuedBytes*` governors. Each window is
  still derived from its governor when omitted, which is the old behavior.
  Native-only (server and client). See `docs/OPERATIONS.md` ("Flow-control
  windows") for the memory budget.
- New server metrics: `datagramSendsAsync`, `sessionsClosedByIdle`,
  `sessionsClosedByReap`, `sessionsClosedOther`, `nativeAsyncOpsPending`, and the
  native handle and registry gauges (`nativeSessionRegistryEntries`,
  `nativeTrackedTasks`, `nativeRateLimitEntries`, `native*HandlesLive`). All
  are documented in `docs/METRICS.md`.
- **One payload to many sessions.** `WebTransportServer.sendDatagramMirror(targets, payload)`
  fans one datagram out to many of that server's sessions across a single
  Node-API crossing. Synchronous and non-parking — the fan-out of the
  promise-free fast path `session.sendDatagram()` tries first, not of its
  parking fallback (there is no public `trySendDatagram`; that name is the
  addon's internal binding) — with a failures-only envelope that
  is a **set, not a prefix**: every target is attempted independently, so a
  reaped subscriber never stops a broadcast. Targets are owner-scoped by server,
  duplicates are delivered to twice, the peak byte reservation is one payload,
  and the cap is 10,000 targets (over it throws `RangeError` before anything is
  sent). Native-only, additive, no knob. See `docs/SPEC.md` → "One payload to
  many sessions". New metrics: `datagramMirrorCalls`, `datagramMirrorTargets`;
  `datagramSendsAsync` deliberately does not move, because the call creates no
  promise.
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

### Experimental

- **Egress pacer and the paced mirror.** `createServer({ egressPacer: { pps,
  clump?, queueMs? } })` turns on a process-wide native egress pacer.
  `server.sendDatagramMirrorPaced(targets, payload)` hands a fan-out to its
  schedule and returns an **admission** envelope `{ admitted, refused }`.
  `server.readMirrorReports(max?)` drains per-target failures out of band from
  a 4,096-entry ring; `mirrorReportsDropped` counts what overflowed. New
  metrics: `datagramMirrorPacedCalls`, `datagramMirrorPacedTargets`,
  `mirrorReportsDropped`. The first pacer configuration a process resolves
  wins, and a conflicting `egressPacer` fails with `E_INVALID_ARGUMENT`.
  `WEBTRANSPORT_PACER_PPS` / `_CLUMP` / `_QUEUE_MS` remain a documented fallback
  when no server passes the option. `sendDatagramMirror` itself is never paced.
- **Multi-process binds.** `ServerOptions.reusePort` (`SO_REUSEPORT`, unix),
  `quicLb` (QUIC-LB keyless connection IDs carrying a cleartext server ID,
  draft-ietf-quic-load-balancers-21 §5.3) and `reusePortSteering` (attach a
  pinned BPF `SK_REUSEPORT` program and sockarray, Linux). Plus the
  balancer-side decoders `decodeQuicLbServerId`, `decodeQuicLbConfigRotation`
  and `quicLbCidLength` on the root entrypoint. Costs and topology are in
  `docs/OPERATIONS.md`.
- **Native stream sink.** `openReadSink(stream, opts?)` (and the
  `openReadSink` method on native streams) drains a stream's readable half off
  the JS event loop into a `SharedArrayBuffer` ring. A Worker consumes it with
  `SinkReader`, also importable from the native-free `./sink-reader` subpath.
  The wasm backend has the same API shape (shape parity, not latency parity).
  Its `E_SINK_*` codes join the `ErrorCode` union as the experimental
  `ExperimentalSinkErrorCode` subset. See `docs/RFC_STREAM_SINK.md`.
- **Incoming stream chunk batching** (`WEBTRANSPORT_STREAM_BATCH_BYTES`, off by
  default). One crossing coalesces the chunks that have already arrived on a
  stream. Terminal events are never merged and byte accounting is unchanged.

### Changed

- **Engine-owned payload delivery (native).** Datagrams and stream chunks of
  256 KiB or less now reach JavaScript as engine-owned `ArrayBuffer` copies
  whose bytes the engine's garbage collector accounts for. Under sustained
  load RSS stays flat where `napi_create_buffer_copy` delivery grew about
  100 MB/h. `WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy` is the escape hatch.
- **Native server runtime: 2 Tokio workers** (was 1). The per-datagram
  injection-queue hops are gone, so the second worker is headroom. Every other
  count measured worse. Not configurable through the public API.
- **Server close contract.** `server.close()` resolves only after the server's
  owned sessions are closed and every pending `onSession` callback has
  settled. `nativeAsyncOpsPending` exposes what the addon still holds on the
  host event loop. Sessions it ends carry the wire-visible pair below.
- **Two native transport defaults** (no public knob, recorded in
  `docs/OPERATIONS.md`): the per-connection datagram receive buffer is now
  256 KiB (was 64 KiB), and the wtransport fork reads datagrams in a
  dedicated per-connection pump task instead of inline in the driver's
  `select!`.
- **Cross-stream read group, on by default (native server).** Server-accepted
  incoming streams are read through one process-level native read group, so
  every stream whose read completed while the event loop was busy crosses
  Node-API in a single `next()`. Consumer-visible semantics are unchanged: no
  read-ahead (one native read per outstanding consumer read), terminal events
  never merged, and memory bounded by the existing QUIC windows and
  `maxQueuedBytes*` budgets plus one in-flight crossing (at most 4096 entries
  and 1 MiB). `WEBTRANSPORT_STREAM_READ_GROUP=0` opts out (read once at module
  load). Native client streams and the wasm backend keep the direct pull. See
  `docs/SPEC.md` ("Cross-stream read group"), `docs/OPERATIONS.md` and
  `docs/PARITY_MATRIX.md`.
- **Wire-visible: sessions closed by `server.close()` now report close code
  `3993` with reason `E_SERVER_CLOSING`** (previously application code `0` with
  the free-text reason `"server closing"`). The new pair is a stable, well-known
  code alongside `3990` (idle timeout) and `3992` (limit exceeded), and it lets a
  peer tell a deliberate server shutdown — reconnect now — from a session that
  was simply lost. `E_SERVER_CLOSING` joins the stable error codes and is
  exported from the root entrypoint; it is a close *reason* only and never
  appears as a thrown `WebTransportError.code`. Documented in `docs/SPEC.md`
  ("Server shutdown close semantics"). Native only: the wasm backend still
  closes its endpoint with code `0` / `"endpoint closed"` (the peer sees
  `{ closeCode: 0 }` and no reason), a divergence recorded in
  `docs/PARITY_MATRIX.md`. Applications matching on the old pair must update.
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

### Removed and internalized

None of these were in a published release. They existed on the 1.0
release-candidate branch for measurement campaigns and are not public in 1.0.
They remain reachable for this repository's tests and harnesses through the
unstable `__TESTING__.serverInternals(server)` accessor (`docs/SPEC.md`,
"Semver rules").

- **Datagram reflector:** `WebTransportServer.setDatagramReflector()`, the
  `DatagramReflectorRule` / `ReflectorMatch` / `ReflectorOp` type exports, the
  `serverReflectRingBypass()` getter, and 14 `datagramReflect*` metrics.
- **Campaign getters and diagnostics:** `serverWorkerThreads()`,
  `serverRecvRuntime()`, `serverAckCadence()`, `serverUdpSendBufferBytes()`,
  `serverUdpSendBatch()`, `serverDatagramDriver()`,
  `serverUdpSendEagainMode()`, `__sendPathDiagnostics()`,
  `__pacerStatsSnapshot()` and `__pacerStatsJson()`.
- **Campaign metrics:** `udpSendBatch*` (8), `datagramPumpsSpawned`,
  `datagramPumpsLive`, `quicSessions` and the six `quic*` loss-attribution
  sums. The public `metricsSnapshot()` strips them at runtime.
- **Unsupported tuning knobs** (`WEBTRANSPORT_NATIVE_*`, `WTRANSPORT_DATAGRAM_PUMP`,
  `WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS`, `WEBTRANSPORT_PACER_NICE` /
  `_SCHED`, `WEBTRANSPORT_PACER_PPS` / `_CLUMP` / `_QUEUE_MS`) are listed
  in `docs/OPERATIONS.md` as unsupported or fallback-only. A malformed or
  out-of-range value now logs one warning and falls back to the default; it
  never aborts the process and never fails `createServer`. Two
  well-formed requests that cannot be honoured still fail `createServer`
  with a recoverable `E_INTERNAL: server startup failed`: EAGAIN `drop` mode
  combined with UDP send batching, and a UDP send buffer the OS caps below
  the requested size.
- **Comparison supervisor out of the addon crate.** The comparison-campaign
  supervisor (`comparison-supervisor`, `observe-directory-identity`, and its
  secure filesystem boundary) moved from `crates/native` to its own workspace
  crate, `crates/compare-supervisor`. The addon crate is a plain `cdylib` again
  (no `rlib`, no bins) and no longer depends on `ed25519-dalek` or `rand_core`.

### Fixed

- Clients bind their endpoint in the destination's address family, so an
  ephemeral port draw can no longer take a port a local IPv4 socket already
  owns.
- The platform trust store is read once per process instead of once per
  `WebTransport` connect.
- A clean connection end no longer discards datagrams still queued for the
  application.
- A receive batch that consumed a `RESET_STREAM` latches it, so batching can
  no longer downgrade a reset to a clean EOF.
- Hot async Node-API calls resolve an error string instead of rejecting. Under
  Bun, a rejection leaked a strong self-reference on its handle.
- The client session handle implements the promise-free datagram send, so the
  fast path is live on clients too.

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
