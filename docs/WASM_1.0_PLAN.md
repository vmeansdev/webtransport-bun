# WASM Backend → 1.0 Plan

**Goal:** bring the wasm backend to production-grade with **0 known P0/P1/P2
defects** (verified by strict adversarial review), fuzzed hand-rolled parsers,
a facade convergent with the native W3C surface, and documented protocol scope
— so `/wasm` can join the package's 1.0 semver commitment instead of shipping
experimental/0.x.

Worktree: `../webtransport-bun-wasm10`, branch `feat/wasm-1.0` (off the native
RC `release/1.0-hardening`). Baseline: 27 cargo tests green.

## Phase 1 — Parser hardening (attacker-facing surface; highest priority)
1. **MAX_FRAME_SIZE cap** on H3 frames (`endpoint.rs` parse_control ~863/876,
   decode_frame_header ~1264/1268): reject/bound `flen` before allocating so a
   peer can't force unbounded per-connection buffering (memory-exhaustion DoS).
   Also cap the SETTINGS/control accumulation buffer.
2. **QPACK integer-decode overflow** (`h3.rs:358` `value += (b&0x7f) << m`,
   `m += 7`): bound the shift/continuation count; return None on overflow
   instead of debug-panic / release-wrap.
3. **`flen as usize` truncation on wasm32** (endpoint.rs:876/1268): compare the
   u64 length against a max and the available buffer as u64 before the cast.
4. **Panic-free indexers**: replace every `self.handle_to_id[&h]` (10 sites) and
   the `.unwrap()`/`.expect()` on network-reachable paths with graceful
   `get(...)`/early-return, so a desync can't poison the thread-local REGISTRY
   and kill every session on the page.

## Phase 2 — Fuzzing
5. Real `cargo-fuzz` targets for varint, H3 frame, QPACK, and capsule/datagram
   parsing, with a seed corpus; wire a short fuzz-smoke run into CI.

## Phase 3 — WASM TS facade defects
6. Handshake timeout on wasm `connect` (currently can hang forever).
7. Use-after-close: detach `udp.onPacket` on `close()` so late packets can't
   hit a freed/reused endpoint id.
8. Bound the wasm-side datagram/stream queues (flood → OOM today).

## Phase 4 — Security surface
9. Gate/remove the `AcceptAny` dev TLS verifier from the shipping wasm API
   (`bridge.rs` `wt_new_endpoint`).

## Phase 5 — Facade convergence (the gating item for /wasm 1.0)
10. Converge the wasm facade (`WasmSession`/`WasmStream`, callback-style,
    plain `Error`s) onto the native W3C `WebTransportLike`/`WebTransport`
    surface so `/wasm` can share the semver commitment.

## Phase 6 — Protocol scope + ops
11. Document delegated-vs-absent protocol features (0-RTT, migration, key
    update, retry/stateless reset, single WT session/conn, datagram/flow caps).
12. Cert-rotation helper for the 14-day P-256 pin treadmill.
13. IWA browser-interop harness runnable in CI (or clearly gated + scheduled).

## Phase 7 — Auto-review loop
Strictest adversarial review across the wasm Rust + TS surface; fix everything
at any severity or justify by-design; loop until a clean pass returns
0 P0/P1/P2. Only then is `/wasm` 1.0-ready.
