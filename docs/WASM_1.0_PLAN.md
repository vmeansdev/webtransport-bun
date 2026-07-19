# WASM Backend → 1.0 Plan & Status

**Goal:** bring the wasm backend to production-grade with 0 known P0/P1/P2
defects (verified by strict adversarial review), fuzzed parsers, a facade
convergent with the native W3C surface, and documented protocol scope — so
`/wasm` can join the package's 1.0 semver commitment instead of shipping
experimental/0.x.

Worktree: `feat/wasm-1.0` (off the native RC `release/1.0-hardening`).

## Status (2026-07-19)

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Parser hardening (frame cap, QPACK overflow, panic-free indexers) | ✅ done — `a7c0394` |
| 2 | Fuzzing (always-on robustness property tests) | ✅ done — `4d6d52f` |
| 3 | TS facade defects (use-after-close, bounded queues) | ✅ done — `c9130dd`, `299b12f`, `93ec1eb` |
| 4 | Security surface (AcceptAny gated out of shipped build) | ✅ done — `592a31a` |
| 6a | Protocol scope docs | ✅ done — `739dbd1` (`docs/WASM_PROTOCOL_SCOPE.md`) |
| 7 | Adversarial review loop → **0 P0/P1/P2 (Rust + TS)** | ✅ done — 3 rounds converged |
| **5** | **Facade convergence** | ⛔ **NOT started — the 1.0-semver gate** |
| 6b | Cert-rotation helper | ⛔ not started |
| 6c | IWA browser-interop CI | ⛔ not started |
| — | Accepted P3/P4 robustness | ⛔ deferred (see below) |

**Security/DoS/panic/UAF/OOM class is CLOSED.** The remaining items are the
convergence + ops + polish needed to actually flip `/wasm` from experimental
0.x to a 1.0-committed surface. None is started; all are picked up from here.

---

## REMAINING WORK (pickup guide)

### 5. Facade convergence — the gating item for `/wasm` 1.0 (largest, multi-day)
**Why it gates 1.0:** `/wasm` is exempt from the 1.0 semver commitment *because*
its facade diverges from the native surface. Until it converges, a consumer
can't write backend-agnostic code, so `/wasm` must stay 0.x.

**Current divergence** (`packages/webtransport/src/`):
- Native (root): W3C `WebTransport` class — Promise/WHATWG streams,
  `WebTransportError` + `E_*` codes, `{ready, closed, draining, datagrams,
  incoming*Streams, create*Stream, close}`.
- Wasm: `WasmSession`/`WasmStream` (`backend.ts`) — callback-style
  (`onDatagram`/`onStream`/`onData`/`onReset`), plain `Error`s, different
  close-info shape. `WasmWebTransport` (`webtransport-like-wasm.ts`) already
  adapts *part* of it to the shared `WebTransportLike` contract.

**Approach:** extend `WasmWebTransport` (or a new adapter) to implement the full
native `WebTransport` surface over `WasmSession`/`WasmStream` — WHATWG
`ReadableStream`/`WritableStream` for datagrams and streams, `ready`/`closed`/
`draining` with the same rejection semantics as the native class, W3C error
names, and the same state machine. Reuse `shared.ts` (`WebTransportLike`) and
mirror `webtransport-like-native.ts`. Then run the existing parity suite
(`docs/PARITY_MATRIX.md`, `test:parity`) against the wasm backend and close the
gaps row by row. Exit criterion: the parity matrix passes for the wasm backend
and `/wasm` types match the native root export.

### 6b. Cert-rotation helper (14-day P-256 pin treadmill)
`serverCertificateHashes` pins require ECDSA P-256 certs ≤ 14 days
(`crates/wasm/src/cert.rs`, `wt_generate_cert`). Add a helper that generates
the next cert before expiry and surfaces the new hash for redistribution, plus
docs on the rotation cadence. See `docs/COMPATIBILITY.md` cert notes.

### 6c. IWA browser-interop CI
The in-browser server path (Direct Sockets in a Chromium Isolated Web App) is
covered only by a manual Playwright harness (`tools/interop/WASM_INTEROP.md`,
`examples/webtransport-wasm-iwa/`). Make it runnable in CI (or clearly gated +
scheduled), since it's the only browser-server coverage.

### Accepted P3/P4 (from the review rounds — deferred, not blocking)
- **P3 — FFI-reachable constructor `.expect()`s** (`crates/wasm/src/endpoint.rs`
  `WtEndpoint::new`/`new_client_pinned`: `server_crypto`,
  `QuicServer/ClientConfig::try_from`). Deterministic crypto-init failure, NOT
  attacker-controlled, but a wasm panic aborts+poisons the thread-local
  REGISTRY — contradicts the "never panic across FFI" invariant. Fix: make the
  constructors return `Result` and have the `wt_new_*` bridge return 0 on error.
  Deferred only because it ripples through ~15 test call sites.
- **P3 — `events` VecDeque unbounded if JS lags** (`endpoint.rs`): recv paths
  drain quinn buffers into an in-process queue and extend flow-control credit;
  mitigated by synchronous pump + the opt-in `paused` mechanism. Consider a soft
  cap / auto-pause.
- **P4 — `h3.rs` `nlen/len as usize` truncation on wasm32** (correctness oddity,
  no unsafety); `next_id`/`next_stream` u32 wrap after ~4B allocations.
- **P4 — `backend-wasm.ts` `waitForProgress` one-shot `setTimeout` not cleared
  on close** (harmless no-op, no UAF).

### Deep fuzzing (cargo-fuzz, nightly) — optional hardening
The always-on robustness tests (`tools/fuzz/README.md`) are the regression
guard. For coverage-guided libFuzzer runs, add a `cargo +nightly fuzz` scaffold
under `crates/wasm` wrapping the same parser entry points, in a scheduled CI
job.

---

## Exit criterion for `/wasm` 1.0
Phase 5 done (parity matrix passes for the wasm backend, types converged) +
6b/6c + the accepted P3s cleared → `/wasm` can drop its experimental/0.x marking
and join the package's 1.0 semver commitment. The security work above is a
prerequisite that is now complete; convergence is what remains.
