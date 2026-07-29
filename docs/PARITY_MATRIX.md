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

These are `missing` on the native backend because the underlying `wtransport`
crate does not expose the required APIs. They are tracked as upstream feature
requests, not local work items (file against
[BiagioFesta/wtransport](https://github.com/BiagioFesta/wtransport)).

| Capability | Status | Why it is upstream-gated (verified against wtransport 0.7.1 source) |
| --- | --- | --- |
| Dynamic QPACK table | `missing` (upstream-gated, hard) | `wtransport-proto` QPACK decoder is static-table-only — any dynamic-table instruction returns `DecodingError::DynamicNotSupported` (`qpack.rs`); local SETTINGS hardcode `qpack_max_table_capacity(0)` and `qpack_blocked_streams(0)` (`driver/streams/settings.rs:25-26`). Native must never advertise nonzero QPACK SETTINGS until upstream implements the dynamic table. |

Server-side capabilities that became available in wtransport 0.7.1 —
congestion control (`ServerOptions.congestionControl`) and keep-alive
(`limits.keepAliveIntervalMs`, clamped to `min(interval, idleTimeout/3)`) —
are implemented on native and no longer upstream-gated.

**0-RTT is no longer upstream-gated.** The native backend now depends on a
fork of wtransport (`vmeansdev/wtransport`, branch `feat/0rtt`, pinned by rev
`aa45f37`) that adds `enable_0rtt`,
`connect_0rtt`, `SessionRequest::is_0rtt`/`handshake_confirmed`, and
0-RTT-rejection recovery — the exact APIs 0.7.1 lacked. The consuming plumbing
lives in `crates/native/src/zero_rtt.rs` and is surfaced through the facade;
see the implemented row above and `docs/FORK_MAINTENANCE.md` for the
obligations the git dependency creates. Dynamic QPACK remains native-only in
the wasm stack.

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
