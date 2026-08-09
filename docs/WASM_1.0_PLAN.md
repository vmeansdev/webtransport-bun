# WASM Backend → 1.0 Plan & Status

Current release truth lives in `docs/release-status.json`. This document is the
working plan for the `/wasm` candidate under a **coupled** package 1.0.0.

Package version: `1.0.0-rc.1`.

Worktree label: `feat/wasm-1.0`.

## Coupled GA definition

A single `1.0.0` ships only when **both** native and WASM meet the bar:

1. All claims with `gaRequired: true` are `passed` with commit-bound evidence.
2. WASM protocol/facade claims are passed: `wasm-dynamic-qpack`,
   `wasm-multi-session`, `wasm-0rtt`, `wasm-facade-parity`.
3. Shared evidence claims are passed (coverage, fuzz, matrix, soaks 24h/72h,
   auto-review, final no-change, etc.).
4. `bun scripts/promote-release-status.ts` succeeds (`readiness=ready`).

`scale-10k-loopback-recovery` is a GA-blocking release gate
(instrumentation only).

Engine strategy: keep sans-IO `quinn-proto` + hand-rolled H3/WT in
`crates/wasm/`. Do **not** port `wtransport`.

## Current state (updated)

Honest-release phases **B2–B6 and C0** are landed. C1/C2 and D4 (promote
script) are landed. Dual-surface production plan Phase 0 freezes this contract.
Remaining work: protocol expansion (QPACK / multi-session / 0-RTT), facade
parity, and shared evidence binding.

## Task status

| Task group | Current status | Primary paths |
|---|---|---|
| 1-4 | landed | evidence generator; crates/wasm; packages/webtransport |
| 5 | landed + C1/C2 getStats | `wasm-webtransport.ts`, `types.ts` |
| 6a | superseded by coupled protocol bar | `docs/WASM_PROTOCOL_SCOPE.md` |
| 6b | landed (impl) | `crates/wasm/src/cert.rs`; `WasmCertRotator`; COMPATIBILITY |
| 6c | harness landed; evidence pending deepen | `tools/interop/*`; IWA |
| Protocol bar | in progress | `h3.rs`, `endpoint.rs`, TLS early-data |
| Facade parity | **passed** on the rebound candidate | all 9 `parity-*.test.ts` via `webtransport-bun/portable` (native 67/0; wasm 64 pass/3 skip/0 fail) — evidence at `docs/release-evidence/c7a1e785.../facade_parity-dual-backend-evidence.json` |
| 13-15 | tooling landed; **evidence pending** | coverage/fuzz/soak workflows |
| 17 | pending final closure | `release-status.json`; promote tool |

## Exit criterion

`/wasm` joins the package 1.0 commitment only after remaining **gaRequired**
release gates are evidenced in `docs/release-status.json` with commit-bound
proof and `bun scripts/promote-release-status.ts` succeeds.

Until then, `/wasm` remains a candidate surface and native stays on `rc`.
