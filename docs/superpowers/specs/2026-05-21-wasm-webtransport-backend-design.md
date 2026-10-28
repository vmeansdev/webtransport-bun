# WASM WebTransport Backend (Browser via Direct Sockets) — Design Spec

- Status: Draft for review
- Date: 2026-05-21
- Branch / worktree: `feat/wasm-webtransport-backend` (`../webtransport-bun-wasm`)
- Author: design via architect + critic review + Phase-0 empirical spike

## 1. Goal

Add a **WASM backend** to `@webtransport-bun/webtransport` so the same public API
runs a WebTransport **server AND client inside a browser**, using the **Direct
Sockets `UDPSocket`** API for all UDP I/O. The QUIC/TLS1.3/HTTP3/WebTransport
logic is a **sans-IO state machine compiled to WASM**: JS feeds inbound UDP
datagrams in and drains outbound datagrams out. No tokio, no native sockets, no
Node-API in the browser path.

The existing native Node-API addon (Bun/Node/Deno) is **untouched**; the browser
gets a second backend behind the same surface.

## 2. Why

The current stack is `wtransport`→`quinn`→`rustls/ring`→`tokio`→native UDP,
compiled to a `.node`. None of that runs in a browser. Browsers ship only a
WebTransport *client*; there is no way to run a WebTransport *server* in a page
except by owning the UDP socket (Direct Sockets) and running the protocol stack
yourself (WASM/JS). This is the user's request and the novel capability.

## 3. Proven foundation (Phase 0 — DONE)

The single make-or-break risk was the wasm32 crypto provider + time source. This
is now **empirically resolved** (see `crates/wasm`, commit `5c5f9bc`):

- The architect's proposed `rustls-rustcrypto` pure-Rust provider is a **dead
  end** for QUIC: it sets `quic: None` on all cipher suites with `todo!()` stubs;
  quinn-proto panics at construction. (Found by critic, verified in source.)
- The working path is to **accept `ring`** with its `wasm32_unknown_unknown_js`
  feature — which **quinn-proto 0.11.13 already declares** as a wasm target-dep,
  together with `getrandom`/`wasm_js` and `web-time` (shims `Instant`). Both
  go/no-go blockers (QUIC crypto + `Instant::now()`) are solved upstream.
- **Gate #1 (compiles):** `quinn-proto 0.11` (`default-features=false`,
  `rustls-ring`) + `rustls 0.23`(ring) + `rcgen 0.14`(ring) + `web-time` +
  `wasm-bindgen 0.2.121` build cleanly to `wasm32-unknown-unknown`.
- **Gate #2 (runs):** the identical code completes a real loopback client↔server
  TLS1.3/QUIC handshake **natively** (`cargo test`) and **in Bun**
  (`bun run-spike.cjs` → `OK handshake complete in 2 steps; server_conns=1`),
  exercising ring crypto, ECDSA P-256 self-signed cert, `web-time::Instant`, and
  `getrandom` in a JS host.

Build requirements discovered: ring still compiles C for wasm32, so a
wasm-capable clang is required (`CC_wasm32_unknown_unknown=<llvm>/clang`,
`AR_wasm32_unknown_unknown=<llvm>/llvm-ar`); rustc ≥1.88 (we use stable 1.95).

## 4. Architecture

### 4.1 Crate / module layout

- `crates/wasm/` — new standalone-workspace crate, `cdylib`, wasm-bindgen. Owns
  the sans-IO QUIC + minimal H3/WebTransport state machine and the exported
  bridge API. Detached `[workspace]` so the native crate's aws-lc-rs feature set
  never leaks into the wasm build.
- `packages/webtransport/src/`:
  - `backend.ts` — `Backend` interface + runtime selector.
  - `backend-native.ts` — existing native-addon code extracted behind `Backend`.
  - `backend-wasm.ts` — WASM module + Direct Sockets bridge behind `Backend`.
  - `index.ts` / `streams.ts` / `errors.ts` — public surface unchanged; delegate
    to the selected backend.

### 4.2 Backend selection

At load: `typeof globalThis.UDPSocket !== "undefined"` → wasm backend; else
native. The public `createServer`, `connect`, and `WebTransport` facade call
through `Backend` and behave identically where features overlap.

### 4.3 WASM ↔ JS bridge contract

Synchronous wasm-bindgen exports; JS owns all scheduling. Shape (refined from the
spike's working endpoint-driving loop):

- Lifecycle: `new_endpoint(is_server, config_json) -> eid`, `close_endpoint(eid)`.
- Packet I/O: `recv_packet(eid, data, src_ip, src_port)`,
  `poll_transmits(eid) -> Array<{data, dst_ip, dst_port}>` (or batched buffer).
- Timers: `next_timeout_ms(eid) -> f64` (-1 none), `handle_timeout(eid)`.
- Events: `poll_event(eid) -> Event | null` (NewConnection, Connected,
  StreamOpened, StreamReadable, StreamWritable, DatagramReceived, Closed, …).
- Sessions: `accept_session`, `connect_session(authority)`, `session_ready`,
  `close_session(code, reason)`.
- Streams: `open_bidi`, `open_uni`, `accept_bidi`, `accept_uni`, `stream_write`
  (returns bytes accepted → backpressure), `stream_read`, `stream_finish`,
  `stream_reset(code)`, `stream_stop_sending(code)`.
- Datagrams: `send_datagram`, `recv_datagram`.
- TLS: `generate_self_signed_cert(cn, validity_days) -> {certPem,keyPem,spkiSha256}`,
  `set_cert_key(eid, certPem, keyPem)`.
- Memory: `alloc`/`free` for hot-path slabs; JS re-acquires memory views after any
  call that may `memory.grow` (detach guard).

Async JS mapping: each not-ready call returns a sentinel; the JS bridge wraps the
operation in a Promise re-polled each pump iteration. Incoming streams/datagrams
feed `ReadableStream` controllers / async iterators the existing API expects.

### 4.4 Direct Sockets integration

- **Server:** `new UDPSocket({ localAddress, localPort })`; read pump pulls
  `socket.readable` `{data, remoteAddress, remotePort}` → `recv_packet`; write
  pump drains `poll_transmits` → `socket.writable`.
- **Client:** `new UDPSocket({ remoteAddress, remotePort })` (connected mode).
- **Timer pump:** one `setTimeout` per endpoint, rescheduled from
  `next_timeout_ms`; QUIC loss timers need sub-`requestAnimationFrame`
  granularity → use `setTimeout(0)`/`MessageChannel`, not rAF.
- **Backpressure:** writer `desiredSize<=0` pauses transmit drain (bounded
  buffer); read pump stops pulling when the per-endpoint byte budget is hit.

### 4.5 Crypto & certificate story

- Provider: `ring` via `wasm32_unknown_unknown_js` (proven).
- Server identity: ECDSA **P-256**, validity **≤14 days**, generated in-wasm via
  `rcgen` (proven to compile+run) → returns `{certPem, keyPem, spkiSha256}`.
- Browser clients connect with
  `serverCertificateHashes: [{algorithm:"sha-256", value: spkiSha256}]`.
- Cert rotation API regenerates before expiry and surfaces the new hash.

### 4.6 H3 / WebTransport layer

Hand-rolled minimal layer in `crates/wasm/src/h3/`: HTTP/3 control stream +
`SETTINGS` (`ENABLE_WEBTRANSPORT`, `H3_DATAGRAM`), Extended CONNECT
request/response, WT stream-type prefixes (bidi/uni + session id), datagram
capsule/quarter-stream-id framing. Rationale: `h3`/`wtransport-proto` are
runtime-coupled; the WT-over-H3 subset is narrow. Estimate revised upward per
critic: budget ~2–3× a naive happy path once flow control, GOAWAY, and settings
edge cases are included. Validate frame sequences against the native server via
qlog diff.

## 5. Phasing

- **P0 — DONE.** wasm32 crypto+QUIC handshake spike (native + Bun loopback).
- **P1 — DONE (wasm↔wasm loopback).** Minimal H3 control + Extended CONNECT; WT
  datagrams; `backend-wasm.ts` + `wasm-relay.ts` with timer/transmit pumps.
  Verified by `packages/webtransport/test/wasm-datagram-echo.test.ts` (session
  established both ways + datagram echo) via `bun run test:wasm`. Direct Sockets
  adapter and `E_*` propagation refinement carry into P3/P4.
- **P2 — Streams.** WT bidi/uni framing; stream read/write/finish/reset/
  stop-sending wired to existing `streams.ts` via a wasm handle adapter. DoD:
  bidi echo + uni up/down + backpressure. Verify: `test/wasm-stream-echo.test.ts`.
- **P3 — Backend refactor + parity.** Extract `backend-native.ts`, add
  `backend.ts` selector; all existing native tests pass unchanged; wasm passes
  the same functional tests via loopback. Verify: CI matrix native + wasm-loopback.
- **P4 — IWA demo + real UDPSocket.** IWA manifest/SW; real `UDPSocket` server on
  localhost; cert + `serverCertificateHashes`; Chrome client connects. DoD:
  `new WebTransport(url,{serverCertificateHashes})` → datagram echo. Verify:
  documented Chrome flags + script; Playwright smoke if feasible.
- **P5 — Cross interop.** wasm client ↔ native server; wasm server ↔ Chrome
  native client. DoD: cross-backend echo both directions.

## 6. Parity divergences (documented in `docs/PARITY_MATRIX.md`)

WASM backend intentionally does **not** support, initially: `allowPooling`
(single endpoint per context), `congestionControl` selection (quinn-proto
default), SNI/cert hot-swap beyond rotation, per-IP rate limiting (no multi-tenant
threat model in an IWA page). No silent no-ops — declared options that aren't
honored throw or are surfaced per existing parity rules.

## 7. Invariants (match existing repo)

- Bounded memory: same global/session/stream byte budgets; `stream_write` returns
  accepted-bytes for backpressure.
- Deterministic shutdown: `close_endpoint` drains sessions→streams→promises in the
  documented order; JS bridge settles all pending promises on close.
- Stable `E_*` codes: reuse `errors.ts` mapping; wasm-specific failures → `E_INTERNAL`.

## 8. Remaining risks

1. H3/WT framing interop with Chrome (M) — qlog diff vs native; pcap vectors.
2. Pump-loop latency / wasm-bindgen copy overhead (M) — batch packets; slab + view
   re-acquire; benchmark in P1.
3. `memory.grow` detach corruption (M) — revalidate views after every call; force-
   grow stress test in P2.
4. Direct Sockets / Chromium flag drift (M) — pin Chrome in CI; `UdpTransport`
   interface so a mock/polyfill can substitute for non-browser tests.
5. Two getrandom majors (0.2 for ring, 0.3 for quinn-proto) coexist — confirmed OK
   in spike; keep an eye on dedup.

## 9. Build/toolchain

- rustc ≥1.88 (stable). Shell pins `RUSTUP_TOOLCHAIN=1.85.0`; override to `stable`.
- wasm32 target on the active toolchain.
- `CC_wasm32_unknown_unknown` / `AR_wasm32_unknown_unknown` → wasm-capable LLVM
  (brew llvm 19 here).
- `wasm-bindgen-cli` pinned to the crate version (0.2.121).
- CI must provide an LLVM with wasm support; document in `docs/CI.md`.

## 10. Resolved product decisions (2026-05-21)

- **API shape:** Reuse `createServer` + the `WebTransport` facade; backend is
  auto-selected by environment. `createServer` remains the server entry in the
  browser (server-in-browser has no W3C analogue). No new public entry points.
- **Packaging:** Ship the prebuilt `.wasm` under a **subpath export**
  (e.g. `@webtransport-bun/webtransport/wasm`), **lazy-loaded** only on the
  browser path so Bun/Node/Deno installs pull no wasm bytes.
- **IWA deliverable:** Ship a **runnable reference Isolated Web App under
  `examples/`** (manifest, service worker, demo UI) that runs the wasm server and
  connects a client, in P4.
