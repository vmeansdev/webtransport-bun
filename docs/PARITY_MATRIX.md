# PARITY_MATRIX.md

## Scope

Track API parity against the WebTransport W3C Editor's Draft snapshot:

- Snapshot: `docs/w3c/w3c.github.io-2026-02-04.md`
- Living: <https://w3c.github.io/webtransport/>

This matrix is the single source of truth for parity. Release readiness is
tracked in `docs/release-status.json`.

## Parity Baseline

`packages/webtransport/test/parity-baseline.test.ts` freezes the current facade
surface:

- Required members: `ready`, `closed`, `draining`, `datagrams`,
  `incomingBidirectionalStreams`, `incomingUnidirectionalStreams`,
  `createBidirectionalStream`, `createUnidirectionalStream`, `close`
- Datagrams: `readable`, `writable`, `createWritable()`, `maxDatagramSize`
  (`WebTransportDatagramDuplexStream`)
- `getStats()`: returns `WebTransportConnectionStats` backed by real quinn
  transport stats
- Constructor options: `allowPooling`, `requireUnreliable` accepted with
  deterministic runtime semantics

## Reading the matrix

- `implemented`: the behavior exists in the current codebase.
- `release pending`: the behavior exists, but `docs/release-status.json` still
  keeps the release claim pending.
- `missing`: the behavior is not present.

The implementation rows below intentionally separate code coverage from release
verification. Code can be present while the release claim is still pending.

## Browser-shaped client surface

| Area | Members / behavior | Implementation source | Implementation evidence | Release verification |
|---|---|---|---|---|
| Session lifecycle | `new WebTransport(url, options)`, `ready`, `closed`, `draining`, `close()` | `packages/webtransport/src/index.ts` | `packages/webtransport/test/parity-facade-lifecycle.test.ts`; `packages/webtransport/test/parity-error-close.test.ts`; `packages/webtransport/test/parity-baseline.test.ts` | `docs/release-status.json` still `pending` |
| Datagrams | `transport.datagrams.readable`, `transport.datagrams.writable`, `createWritable()`, `maxDatagramSize`, datagram send order/group options | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/parity-datagrams.test.ts`; `packages/webtransport/test/parity-options.test.ts`; `packages/webtransport/test/parity-error-close.test.ts` | `docs/release-status.json` still `pending` |
| Streams | `createBidirectionalStream()`, `createUnidirectionalStream()`, `incomingBidirectionalStreams`, `incomingUnidirectionalStreams`, `waitUntilAvailable` | `packages/webtransport/src/index.ts`; `packages/webtransport/src/wasm-webtransport.ts` | `packages/webtransport/test/parity-streams.test.ts`; `packages/webtransport/test/parity-options.test.ts`; `packages/webtransport/test/parity-facade-lifecycle.test.ts` | `docs/release-status.json` still `pending` |
| Stream control | reset / stop-sending semantics and close propagation | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/parity-error-close.test.ts`; `packages/webtransport/test/parity-facade-lifecycle.test.ts` | `docs/release-status.json` still `pending` |
| Error model | W3C-shaped error classes, browser names, internal `E_*` preservation | `packages/webtransport/src/index.ts` | `packages/webtransport/test/error-codes.test.ts`; `packages/webtransport/test/parity-error-close.test.ts` | `docs/release-status.json` still `pending` |
| Stats | `getStats()` dictionaries backed by transport counters | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/parity-compat.test.ts`; `packages/webtransport/test/parity-baseline.test.ts` | `docs/release-status.json` still `pending` |
| Security / auth | `serverCertificateHashes` validation and pinned-certificate connect | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts`; `packages/webtransport/src/wasm-webtransport.ts` | `packages/webtransport/test/tls.test.ts`; `packages/webtransport/test/parity-pooling.test.ts`; `packages/webtransport/test/parity-error-close.test.ts` | `docs/release-status.json` still `pending` |
| Security / auth (CA roots) | wasm client `caPem` trust over user-supplied roots | `crates/wasm/src/verify.rs`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/wasm-ca-trust.test.ts` | **Implemented and end-to-end verified.** A server holding a CA-issued leaf completes the handshake against a client trusting only that CA, and stream data echoes over it; a client given a different CA's PEM is refused with `E_TLS: handshake failed with TLS alert 48` (unknown_ca). Also proven at the QUIC layer natively (`spike_tests::loopback_handshake_over_ca_root_trust`). Test chains come from `cert::generate_ca_signed`, gated behind `dev-insecure` like the accept-any verifier, so shipped artifacts cannot mint a CA |
| Transport states | `connecting → connected → draining → closed / failed` | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/parity-facade-lifecycle.test.ts`; `packages/webtransport/test/parity-robustness.test.ts` | `docs/release-status.json` still `pending` |
| Static capabilities and option mapping | `supportsReliableOnly`, `congestionControl`, `datagramsReadableType`, `allowPooling`, `requireUnreliable`, `strictW3CErrors` | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/parity-options.test.ts`; `packages/webtransport/test/parity-pooling.test.ts`; `packages/webtransport/test/parity-compat.test.ts` | `docs/release-status.json` still `pending` |
| 0-RTT session resumption / early data | `enable0Rtt` (server + client), `allowEarlySession`, session-object `has0Rtt`/`accepted0Rtt`/`handshakeConfirmed`, `exportTicketVault`/`importTicketVault` | `crates/native/src/{zero_rtt.rs,client.rs,lib.rs,server_napi.rs,session_napi.rs,session_registry.rs}`; `packages/webtransport/src/index.ts` | `packages/webtransport/test/native-0rtt.test.ts` (7 pass); `crates/native` `zero_rtt` unit + loopback resumption tests (`shared_config_resumes_with_early_data`, `fresh_config_per_connect_never_resumes`) | `docs/release-status.json` still `pending` |

## Session lifecycle on the wire

These rows cover how a session close, a drain, and a stream error actually
reach the peer. All four are `implemented` on **both** backends. The evidence
that matters here is Chromium, not native-to-native: a QUIC `CONNECTION_CLOSE`
looks like a valid close to another copy of ourselves while telling a browser
nothing, which is exactly how the old interop gates passed while the defect was
live.

| Behavior | Native | WASM | Implementation source | Implementation evidence |
|---|---|---|---|---|
| `WT_CLOSE_SESSION` capsule (send + receive) | `implemented` | `implemented` | `crates/native/src/{session_registry.rs,client.rs,lib.rs}` (via the fork's `Connection::close_session`); `crates/wasm/src/{capsule.rs,endpoint.rs}` | Real Chromium reads back both fields on both backends: `tools/interop/tests/edge-cases.pw.ts`, `tools/interop/tests/interop-expanded.pw.ts`, `tools/interop/tests-wasm/wasm-server.spec.ts`. Backend-to-backend: `packages/webtransport/test/parity-error-close.test.ts` ("close code and reason cross the wire from the peer"). WASM unit: `crates/wasm/src/endpoint_tests.rs::primary_session_close_conveys_code_and_reason_over_capsule` |
| `WT_DRAIN_SESSION` capsule (send + receive) | `implemented` | `implemented` | `crates/native/src/{session_napi.rs,session_registry.rs,client.rs}` over the fork's `drain_session`/`draining`; `packages/webtransport/src/{index.ts,portable.ts,portable-native.ts}`; `crates/wasm/src/{capsule.rs,endpoint.rs}` | `packages/webtransport/test/parity-facade-lifecycle.test.ts` ("draining resolves on a peer drain, and the session stays usable") runs on **both** backends. WASM unit: `crates/wasm/src/endpoint_tests.rs::drain_capsule_notifies_the_peer_without_closing_the_session` |
| `GOAWAY` (send + receive) | `implemented` — server-side `goAway()` sends the connection-scoped H3 `GOAWAY`; a received `GOAWAY` already settled `draining` | **deliberate non-goal** — the wasm h3 module has no control-stream `GOAWAY` handling; wasm signals session drain only | `crates/native/src/{session_napi.rs,session_registry.rs}` over the fork's `Connection::send_goaway`; `packages/webtransport/src/index.ts` (`ServerSession.goAway()`) | `packages/webtransport/test/native-goaway.test.ts`: a native server calls `goAway()` and the native client peer observes it — its `draining` settles while the session stays usable (a fresh stream still opens). Negative control: without the send, `draining` stays pending on the wire. **Scope caveat:** native is single-session-per-connection, so `GOAWAY`'s real use is a server-initiated graceful-shutdown signal ("don't start new sessions"); the "refuse a second session" enforcement is not reachable through the public API, since native cannot open a 2nd CONNECT on one connection |
| `WT_APPLICATION_ERROR` remap (§4.4, QUIC stream codes only) | `implemented` | `implemented` | fork `wtransport/src/stream.rs` (`reset`/`stop` take a `u32` and map it); `crates/wasm/src/wt_error.rs` | Chromium round-trips the code on both backends: `tools/interop/tests/interop-expanded.pw.ts` and `tools/interop/tests-wasm/wasm-server.spec.ts` ("stream reset code round-trips … through the remap"). Both were verified to fail when the server shifts the code by one |
| Buffered-stream reject (`WT_BUFFERED_STREAM_REJECTED`) | n/a — native is single-session, so there is no unassociated-stream buffer | `implemented` | `crates/wasm/src/endpoint.rs` | `crates/wasm/src/endpoint_tests.rs::unassociated_wt_stream_is_rejected_with_buffered_stream_rejected` |

**`draining` is wire-driven on both backends, with the local-close fallback
kept.** It resolves on a received `WT_DRAIN_SESSION` (and, on native, a
received `GOAWAY` — the fork folds both into one signal), and *also* on the
local `close()` path and on `closed`. Those fallbacks are deliberate: a peer
that never drains must not leave consumers waiting forever.

The native backend now *sends* `GOAWAY` through `ServerSession.goAway()`, which
surfaces the fork's `Connection::send_goaway`. Because native is
single-session-per-connection, the practical effect is limited to a
server-initiated graceful-shutdown signal — the peer observes it as its
`draining` settling, the session stays usable, and the "refuse a second session"
enforcement `GOAWAY` implies is not exercisable through the public API. Wasm
sends no `GOAWAY` and that stays a deliberate non-goal: the wasm h3 module has no
control-stream `GOAWAY` handling. That asymmetry is intentional, not a pending
gap.

**The native backend consumes the fork at rev `d3ff84d`** (branch
`feat/qpack-dynamic`, which stacks on `feat/track1-conformance`, itself a
superset of `feat/0rtt`), which is where `close_session`, the drain/GOAWAY
methods, the §4.4 remap, and the dynamic QPACK decode + encoder machinery live.
See `docs/FORK_MAINTENANCE.md`.

## Native and wasm implementation surfaces

| Surface | Implementation source | Implementation evidence | Release verification |
|---|---|---|---|
| Native addon path | `crates/native/src/{client.rs,lib.rs,limits.rs,rate_limit.rs,server.rs}` | `packages/webtransport/test/{acceptance,adversarial,backpressure,drain,fairness,hardening*,parity-*,tls}.test.ts`; `docs/reviews/2026-07-21-1.0-finding-ledger.md` | `docs/release-status.json` still `pending` |
| WASM candidate path (coupled 1.0 target) | `crates/wasm/src/{bridge.rs,cert.rs,endpoint.rs,event.rs,h3.rs,lib.rs,verify.rs,server_tls.rs,congestion.rs}`; `packages/webtransport/src/{backend.ts,backend-wasm.ts,wasm-webtransport.ts,webtransport-like-wasm.ts,send-scheduler.ts,wasm-endpoint-pool.ts,ticket-store-hosts.ts,wasm-server-session.ts}` | `packages/webtransport/test/{wasm-*.test.ts,parity-*.test.ts}`; `tools/interop/interop-evidence-wasm.json` | `wasm-dynamic-qpack` / `wasm-multi-session` / `wasm-0rtt` **passed** on candidate; `wasm-facade-parity` **passed** on the rebound candidate — all 9 `parity-*.test.ts` run on both backends via `webtransport-bun/portable` (native 67/0; wasm 64 pass/3 skip/0 fail), with pooling/waitUntilAvailable/getStats/CC/sendOrder/tickets/metrics/TLS/log/`WasmServerSession` landed |

## Interop and IWA evidence

| Scenario | Implementation source | Evidence path | Release verification |
|---|---|---|---|
| Chromium native client ↔ native addon server | `tools/interop/{addon-server.ts,tests/*.pw.ts,playwright.config.ts}` | `tools/interop/interop-evidence.json` when generated by the workflow | `docs/release-status.json` still `pending` |
| Chromium native client ↔ wasm server | `tools/interop/tests-wasm/wasm-server.spec.ts`; `tools/interop/playwright.wasm.config.ts` | `tools/interop/interop-evidence-wasm.json` | `docs/release-status.json` still `pending` |
| IWA browser server proof | `examples/webtransport-wasm-iwa/{README.md,app.js,.well-known/manifest.webmanifest}`; `tools/interop/run-iwa.mjs` | `docs/release-evidence/cb0cb698…/iwa-direct-sockets.json` (+ `.release-evidence/iwa/*` bundles) | `iwa-direct-sockets` **pending**: the Chrome 150 proof is real but bound to a pre-alignment commit, so it does not carry to the rebound candidate |

## Upstream-Gated Capabilities (native backend)

No native capabilities are `missing` for want of an upstream API any longer.
The two that were — 0-RTT and the dynamic QPACK table — are now implemented on
the `vmeansdev/wtransport` fork (see below); the table is kept for history.

| Capability | Status | Notes |
| --- | --- | --- |
| Dynamic QPACK table | **implemented (on the fork)** | Was `missing` on stock wtransport 0.7.1 (the QPACK decoder was static-table-only, returning `DecodingError::DynamicNotSupported`, and local SETTINGS hardcoded capacity 0). The fork adds RFC 9204 dynamic-table decode, the local decoder stream (Section-Ack / Insert-Count-Increment / Stream-Cancellation), and the peer-sized encoder machinery. Native exposes it opt-in via `qpackMaxTableCapacity` / `enableDynamicQpack` (default 0 = static-only). `SETTINGS_QPACK_BLOCKED_STREAMS` is always 0, so native decodes + acknowledges the peer's table but never emits a dynamic-table *reference* on the single CONNECT exchange (an encoder may not reference an unacknowledged entry at blocked-streams 0). Interop/completeness, not throughput. Decode is covered by the fork's RFC 9204 Appendix B vectors; a Chromium interop test (`tools/interop/tests-qpack/`) proves native no longer rejects an advertised table. |

Server-side capabilities that became available in wtransport 0.7.1 —
congestion control (`ServerOptions.congestionControl`) and keep-alive
(`limits.keepAliveIntervalMs`, clamped to `min(interval, idleTimeout/3)`) —
are implemented on native and no longer upstream-gated.

**0-RTT and dynamic QPACK are no longer upstream-gated.** The native backend
now depends on a fork of wtransport (`vmeansdev/wtransport`, branch
`feat/qpack-dynamic`, pinned by rev `d3ff84d`) that adds `enable_0rtt`,
`connect_0rtt`, `SessionRequest::is_0rtt`/`handshake_confirmed`, and
0-RTT-rejection recovery — the exact APIs 0.7.1 lacked — plus the
`qpack_max_table_capacity` config method and the dynamic QPACK decode + encoder
machinery. The 0-RTT plumbing lives in `crates/native/src/zero_rtt.rs`; the
QPACK options thread through `crates/native/src/{client,server_napi,lib}.rs`.
Both are surfaced through the facade; see the implemented rows above and
`docs/FORK_MAINTENANCE.md` for the obligations the git dependency creates.

## Candidate notes

- The browser-shaped client facade is implemented as an additive surface.
- The wasm backend is a **candidate** toward coupled package 1.0.0 — not GA
  until `gaRequired` claims (including protocol bar + facade parity) pass.
- Protocol targets (dynamic QPACK, multi-session, 0-RTT) are required for
  coupled GA; see `docs/WASM_PROTOCOL_SCOPE.md`.
- Treat remaining differences as implementation progress or release-verification
  status, not as silent no-ops.
- Release verification always defers to commit-bound evidence in
  `docs/release-status.json`.
