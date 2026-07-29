# Wasm IWA plug-and-play `createServer` Implementation Plan

> Executed 2026-07-27. See design sibling for architect/critic amendments.

**Goal:** Async IWA Direct Sockets `createServer` on `/wasm`.

**Architecture:** `wasm-create-server.ts` wraps `serveOverUdp` + optional atomic
PEM construction; exports from `wasm.ts`.

## Tasks

- [x] Session facade honesty (`WasmServerSession`)
- [x] `wasm-create-server.ts` + `loadWasmWebModule` + exports
- [x] Atomic PEM in `wt_new_server_with_options`
- [x] Unit tests with injectable bind
- [x] IWA example + docs honesty
- [x] Auto-review round
