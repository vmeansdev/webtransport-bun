# Wasm IWA plug-and-play `createServer` — design

Date: 2026-07-27  
Status: implemented on candidate (not GA)

## Problem

Wasm server setup required manual wasm load, Direct Sockets bind, and
`serveOverUdp` wiring. Native Bun `createServer` stayed one-call.

## Decision

Ship async `createServer` / `createIwaServer` on
`@webtransport-bun/webtransport/wasm` only. Root native `createServer` stays
sync and unchanged.

Architect/critic amendments incorporated:

- Web wasm loader calls/memoizes wasm-bindgen `default()` init.
- Atomic PEM via `wt_new_server_with_options` `certPem`/`keyPem` (no
  generate-then-rotate for the caller PEM path).
- Live `certHashBase64` getter from `tlsSnapshot()`.
- Distinct `WasmWebTransportServer` / `WasmServerSession` types (not native
  `WebTransportServer` / `ServerSession`).
- Fail closed without `UDPSocket` unless `bind` is injected; reject port `0`.
- Cleanup manager on construction failure; idempotent async `close()`.

## Non-goals

Normal webpages, Firefox/Safari, Bun native default change, GA claim.
