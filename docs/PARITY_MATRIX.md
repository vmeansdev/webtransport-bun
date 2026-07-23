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
| Transport states | `connecting → connected → draining → closed / failed` | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/parity-facade-lifecycle.test.ts`; `packages/webtransport/test/parity-robustness.test.ts` | `docs/release-status.json` still `pending` |
| Static capabilities and option mapping | `supportsReliableOnly`, `congestionControl`, `datagramsReadableType`, `allowPooling`, `requireUnreliable`, `strictW3CErrors` | `packages/webtransport/src/index.ts`; `packages/webtransport/src/backend.ts` | `packages/webtransport/test/parity-options.test.ts`; `packages/webtransport/test/parity-pooling.test.ts`; `packages/webtransport/test/parity-compat.test.ts` | `docs/release-status.json` still `pending` |

## Native and wasm implementation surfaces

| Surface | Implementation source | Implementation evidence | Release verification |
|---|---|---|---|
| Native addon path | `crates/native/src/{client.rs,lib.rs,limits.rs,rate_limit.rs,server.rs}` | `packages/webtransport/test/{acceptance,adversarial,backpressure,drain,fairness,hardening*,parity-*,tls}.test.ts`; `docs/reviews/2026-07-21-1.0-finding-ledger.md` | `docs/release-status.json` still `pending` |
| WASM candidate path | `crates/wasm/src/{bridge.rs,cert.rs,endpoint.rs,event.rs,h3.rs,lib.rs,verify.rs}`; `packages/webtransport/src/{backend.ts,backend-wasm.ts,wasm-webtransport.ts,webtransport-like-wasm.ts}` | `packages/webtransport/test/{wasm-*.test.ts,parity-*.test.ts}`; `tools/interop/interop-evidence-wasm.json` | `docs/release-status.json` still `pending` |

## Interop and IWA evidence

| Scenario | Implementation source | Evidence path | Release verification |
|---|---|---|---|
| Chromium native client ↔ native addon server | `tools/interop/{addon-server.ts,tests/*.pw.ts,playwright.config.ts}` | `tools/interop/interop-evidence.json` when generated by the workflow | `docs/release-status.json` still `pending` |
| Chromium native client ↔ wasm server | `tools/interop/tests-wasm/wasm-server.spec.ts`; `tools/interop/playwright.wasm.config.ts` | `tools/interop/interop-evidence-wasm.json` | `docs/release-status.json` still `pending` |
| IWA browser server proof | `examples/webtransport-wasm-iwa/{README.md,app.js,.well-known/manifest.webmanifest}`; `tools/interop/{run-iwa.mjs,tests/iwa-contract.test.ts}` | `.release-evidence/iwa/{evidence.json,evidence-chrome-beta.json,origin.txt,webtransport-wasm-iwa.wbn,webtransport-wasm-iwa.swbn}` | `docs/release-status.json` still `pending` |

## Candidate notes

- The browser-shaped client facade is implemented as an additive surface.
- The wasm backend is a candidate implementation, not a GA declaration.
- The former “intentional divergence” notes are retired. Treat remaining
  differences as implementation details or release-verification status, not as
  silent no-ops.
- Release verification still waits on commit-bound evidence in
  `docs/release-status.json`.
