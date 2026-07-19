# WASM backend follow-ups 1–3 — implementation plan

Branch: `feat/wasm-webtransport-backend` (worktree `../webtransport-bun-wasm`)
Date: 2026-05-21
Scope: three follow-ups left after P0–P5 — multi-client server routing, facade
unification, interop verification.

This plan is grounded in a code read (see file:line refs). It has been reviewed
by an architect (design) and a critic (holes); their required changes are folded
in below and summarized in "Review outcomes — locked decisions".

---

## Review outcomes — locked decisions (2026-05-21)

Architect verdict: sound with required changes. Critic verdict: go-with-changes.
No structural blocker. The following are now binding on execution:

1. **`wt_poll_transmits` wire format is LOCKED** (the load-bearing ABI decision):
   a flat `Uint8Array` of records, each `[dest_len:u8][dest:utf8][pkt_len:u32-le]
   [pkt:bytes]`. `dest` is `"ip:port"` (IPv6 bracketed), ≤255 bytes so u8 is
   safe. Rust (`bridge.rs`) and TS (`backend-wasm.ts pump()`) implement this in
   the SAME atomic change.
2. **`endpoint_tx` becomes `Vec<(Vec<u8>, SocketAddr)>`.** Confirmed bug: the
   `DatagramEvent::Response(_t)` arm (endpoint.rs:~180) discards a `Transmit`
   whose `destination` is the real source — version-negotiation / stateless-reset
   packets are currently address-less. They must be emitted with their dest.
3. **Connection cleanup on `ConnectionLost`** (endpoint.rs:~220): prune `conns`,
   `sessions`, `handle_to_id`, `id_to_handle`, and matching `stream_index`
   entries. Without this a multi-client server leaks per connection.
4. **`UdpTransport` signature is LOCKED**: `send(data, dest:{address,port})` and
   the recv callback surfaces `{data, address, port}` (source). `BunUdpTransport`
   currently overwrites a single `remoteHost/remotePort` per packet
   (bun-udp.ts:~66) — that is itself a single-peer bug, fixed here.
5. **Item 1 lands atomically.** Rust ABI + TS decode + transport changes are one
   coherent change set; a half-landed ABI breaks every wasm test. Verify the
   whole wasm suite green before considering Item 1 done.
6. **Cross-talk isolation is the real test.** The 2-client test MUST assert that
   client A's datagram/stream echo is NEVER delivered to client B — not merely
   that both clients got *a* reply (which passes even with cross-talk).
7. **Two spikes BEFORE writing Item 1 transport code:** (a) confirm the wasm
   server's rustls `ServerConfig` advertises ALPN `h3` (needed for Item 3a and
   already implied by working wasm↔wasm); (b) confirm Bun's bound (non-connected)
   `udpSocket.send(data, port, address)` can target arbitrary peers.
8. **Adding `conn` to `StreamData`/`StreamReset`** (event.rs) is a coordinated
   wire-format change — Rust encode (event.rs:~66) and TS decode
   (backend-wasm.ts:~182) edited together.
9. **WHATWG adapter MUST enqueue copied data** (`.slice()` off wasm memory,
   already done at backend.ts:~152/167) — never a raw view, because `memory.grow`
   detaches the backing `ArrayBuffer`. Preserve this through the refactor.
10. **Unified interface is additive-only**: it MUST NOT remove or change any
    existing native API surface (production path stays untouched).
11. **CI (Item 3b) toolchain is Ubuntu-specific**: `rustup target add
    wasm32-unknown-unknown`, `apt-get install clang lld`, set
    `CC_wasm32_unknown_unknown` / `AR_wasm32_unknown_unknown` (NOT the macOS brew
    paths in `build:wasm:web`), pin `wasm-bindgen-cli` to the Cargo.lock version.
    Cache the cargo/target dirs. Budget ~3-5 min added build.

---

## Item 1 — Multi-client server routing

### Problem (grounded)
`WtEndpoint` (crates/wasm/src/endpoint.rs) is single-peer. The connection maps
already support N connections per endpoint:

- `conns: HashMap<ConnectionHandle, Connection>` (endpoint.rs:~52)
- `sessions: HashMap<ConnectionHandle, Session>`
- `handle_to_id` / `id_to_handle` give each connection a JS-facing `u32` id.

The single-peer assumption lives in exactly two places:

1. `recv()` (endpoint.rs:~157) calls `self.inner.handle(now, self.peer_addr, …)`
   — it passes the *stored* peer addr instead of the packet's real source. So a
   second client's packets get attributed to the first client's address.
2. `poll_transmits()` (endpoint.rs:~680–695) calls `conn.poll_transmit(...)` and
   **discards the returned `Transmit`** (`Some(_t) => out.push(buf)`, line ~689).
   `Transmit.destination` is the address we must send each packet to. Currently
   JS just sends every outgoing packet to the one configured peer.

quinn-proto already maintains source-addr → ConnectionHandle routing internally;
we just have to feed it the true source and honor the true destination.

### Design
**Rust (crates/wasm):**
- `recv` gains a `source: SocketAddr` param. Parse from a JS-supplied string
  (reuse existing `parse_addr` helper used by `wt_new_endpoint`).
- `poll_transmits` emits `(packet, destination)` pairs instead of bare packets.
  Capture `transmit.destination` before pushing. Need an output shape that
  carries the addr — options below.
- Endpoint-level transmits (`endpoint_tx`, e.g. retries/version-negotiation):
  these already come from `endpoint.handle()` as `Transmit` + buffer; capture
  their destination too (currently likely also addr-less — verify and fix).

**Bridge (crates/wasm/src/bridge.rs):**
- `wt_recv_packet(eid, data, source_addr: &str)` — add the source param.
- `wt_poll_transmits` must return packets *with* destinations. Cleanest:
  return a flat encoding JS can split — e.g. a `Vec` of records each
  `[dest_len u8][dest utf8][pkt_len u32][pkt bytes]`, or two parallel arrays.
  Pick whichever matches existing `wt_poll_transmits` return marshalling
  (verify current shape first; it currently returns `Vec<Vec<u8>>` via serde or
  manual). Keep the wasm-bindgen boundary simple.

**Events (crates/wasm/src/event.rs):**
- `StreamData` and `StreamReset` currently carry only `stream: u32`, no `conn`.
  Add `conn: u32` to both so JS can route stream data to the right session
  without maintaining a stream→session map. (`stream_index` already stores
  `(ConnectionHandle, StreamId)` so the conn id is available at emit time.)

**TS transports (packages/webtransport/src/):**
- `UdpTransport` interface (wasm-relay.ts): receive callback must surface the
  source `{address, port}`; send must accept a destination. Verify current
  signature — `BunUdpTransport` and `DirectSocketsUdpTransport` already get
  `{data, remoteAddress, remotePort}` from the socket, so the data is there;
  it's currently dropped on the floor for recv and hardcoded for send.
- `InMemoryRelay` (wasm-relay.ts): make it a real multi-endpoint switch keyed by
  address so two+ wasm clients can hit one wasm server in tests.
- `WasmEndpoint` (backend-wasm.ts): pass source into `wt_recv_packet`; read
  `(pkt, dest)` from `wt_poll_transmits` and send each to its dest.
- `WasmTransportManager` / `createWasmServer`: fire `onSession` per *new* conn id
  (already keyed by conn) — verify it doesn't assume a single session.

### Tests
- Rust: a cargo test in endpoint/integration that accepts two simulated clients
  from two source addrs against one server endpoint, completes two independent
  handshakes, and echoes a datagram on each without cross-talk.
- TS: extend `wasm-bun-udp` (real localhost UDP) with a 2-client-1-server case;
  add an `InMemoryRelay` 2-client case.

### Risk / unknowns for reviewers
- Exact current marshalling of `wt_poll_transmits` return — must confirm before
  picking the `(pkt,dest)` encoding.
- Whether `endpoint.handle()` initial/retry transmits carry a destination we're
  currently dropping.
- DirectSockets bound-socket semantics for replying to arbitrary peers.

---

## Item 2 — Facade unification (the real design decision)

### Current state (grounded)
- Native (index.ts): `createServer(opts): WebTransportServer`,
  `connect(url, opts): Promise<ClientSession>`, W3C `class WebTransport`.
  Sessions expose WHATWG ReadableStreams, Node `Duplex`/`Readable`/`Writable`,
  async-iterable datagrams, send groups, `getStats()`, metrics, cert rotation,
  stream-control symbols.
- Wasm (backend.ts/backend-wasm.ts): `connectWasm`, `createWasmServer`,
  `WasmSession`/`WasmStream` — synchronous, callback-driven (`onDatagram`,
  `onData`, `onIncomingStream`), no Promises, no WHATWG/Node streams.
- Selector `selectBackend()` (backend.ts) returns `"native" | "wasm"` but the two
  return *different-shaped* objects, so callers can't be backend-agnostic.

### Options for reviewers to weigh
- **A. Full W3C parity for wasm.** Reimplement the entire native session surface
  on the wasm core (WHATWG + Node Duplex + async iterables + send groups +
  stats). Highest fidelity, single API. Cost: large; Node `Duplex` is wrong for
  browser bundles; high surface to test.
- **B. Shared interface subset (recommended starting point).** Define a
  `WebTransportLike` contract = the portable common subset: `ready`/`closed`
  promises, `sendDatagram`, `incomingDatagrams()` async-iterable,
  `createBidirectionalStream()`/`createUnidirectionalStream()` returning a
  *WHATWG* duplex/stream (works in both Bun and browser), incoming-stream async
  iterables. Both backends implement it; native keeps its richer extras as
  additive. `selectBackend` can then return a uniform handle. Wasm wraps its
  callback core into Promises + WHATWG streams.
- **C. W3C class shape only (browser-native).** Promote wasm to expose the W3C
  `WebTransport` class shape (client) + a thin server facade, using WHATWG
  streams exclusively (no Node Duplex). Aligns wasm with the web platform.

Recommendation to put to the user: **B** as the unifying contract, implemented
with WHATWG streams (option-C-style stream types) so it's browser-safe, with a
shared `WebTransportLike` type both backends satisfy. Defer full Node-stream /
send-group / stats parity (additive, native-only) unless required.

### Design (assuming B)
- Add `packages/webtransport/src/shared.ts` (or extend an existing types file):
  `WebTransportLike`, `WtBidiStream` (WHATWG `{readable, writable}`),
  `WtRecvStream`, `WtSendStream`.
- Wasm adapters: wrap `WasmSession`/`WasmStream` callbacks into Promises +
  WHATWG ReadableStream/WritableStream + async iterables. Re-export under the
  unified names so wasm exposes `connect`/`createServer` semantics matching the
  native facade's *shape* (not necessarily its full extras).
- Make `selectBackend()` return the unified `WebTransportLike` factory so a
  caller writes one code path.
- Native side: confirm it already satisfies `WebTransportLike` (it should via a
  structural check) — add the type, do not rewrite native runtime.

### Tests
- A backend-agnostic test that runs the same scenario (connect, datagram echo,
  bidi echo) through the unified interface, parameterized over wasm (and native
  where the env supports it).
- Type-level: assert both facades are assignable to `WebTransportLike`.

### Risk / unknowns for reviewers
- Whether to expose Node `Duplex` at all on the unified surface (bundle cost in
  browser). Leaning no — WHATWG only on the shared contract.
- Backpressure/ordering semantics translating callback core → WHATWG streams.
- Async iterable vs ReadableStream for incoming streams (native uses both forms
  in different spots — pick one for the contract).

---

## Item 3 — Interop verification

### Current state (grounded)
Automated in CI today: native-client (Chromium, Playwright) ↔ native-server.
Automated locally (not CI): wasm↔wasm (InMemoryRelay + BunUdpTransport),
wasm-client ↔ native-server (`wasm-native-interop`). Manual only:
wasm-server-in-browser (IWA/Direct Sockets) ↔ Chrome native client.

`tools/interop/` already has a working Playwright + Chromium harness with
force-quic-on, cert-hash pinning, and an auto-started server.

### Design
- **3a. Automate "Chrome native client ↔ wasm server" without the IWA.** Host
  the wasm server under **Bun** (`BunUdpTransport`, real localhost UDP), generate
  its P-256 cert hash, and point the existing Playwright Chromium native
  `WebTransport` client at it (reuse `tools/interop` config: force-quic-on +
  `serverCertificateHashes`). This proves wasm-server protocol correctness
  against a real browser client — the high-value half of the manual gap — with
  zero IWA signing.
- **3b. Wire wasm tests into CI.** Add a CI job (or steps) running `test:wasm`
  and `test:wasm:interop`. This needs the wasm toolchain in CI: wasm32 target,
  brew LLVM for ring's C, matching wasm-bindgen-cli. Document/encode the env
  (the build:wasm:web script already encodes the clang/ar env).
- **3c. Keep IWA path manual but documented.** The in-browser Direct-Sockets
  server still needs IWA signing — leave `WASM_INTEROP.md` as the manual
  procedure, updated to note 3a now covers protocol interop automatically.

### Tests / CI
- New Playwright spec under `tools/interop/tests/` (or a sibling) for native
  client ↔ Bun-hosted wasm server.
- CI yaml: a job that builds wasm and runs `test:wasm` + the new wasm-server
  interop spec. Gate it so a missing toolchain fails loudly, not silently.

### Risk / unknowns for reviewers
- CI cost/time of building the wasm toolchain (ring C compile). May need caching.
- Whether Bun-hosted wasm server + Chromium force-quic interop has any
  cert/ALPN mismatch vs the native server path.
- Item 3a depends on Item 1 only if the test uses >1 client; single-client works
  regardless. Sequencing note below.

---

## Sequencing
1. **Item 1** first (unblocks a genuinely usable server; small, contained Rust+TS
   plumbing). Phased: 1a Rust recv/transmit addressing + events; 1b TS transports
   + relay; 1c multi-client tests.
2. **Item 3a** next (reuses existing Playwright harness; high verification value;
   single-client works even before any facade change).
3. **Item 2** last (largest design surface; benefits from a settled core). Phased:
   2a shared contract types; 2b wasm adapters; 2c selector + agnostic tests.
4. **Item 3b/3c** (CI wiring + docs) folded in after the suites exist.

Each phase: edit ≤5 files, run verification (cargo test / `test:wasm` / tsc),
stop for review before the next phase, per repo CLAUDE.md.

## Verification gates (per repo directives)
- Rust: `RUSTUP_TOOLCHAIN=stable cargo test` in crates/wasm (native + wasm32
  build), `cargo clippy`.
- TS: `tsc --noEmit`, `test:wasm`, `test:wasm:interop`, new interop spec.
- No phase reports "done" with errors outstanding.
