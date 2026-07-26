# WASM Backend → 1.0 Plan & Status

Current release truth lives in `docs/release-status.json`. This document is the
working plan for the `/wasm` candidate, not a GA declaration.

Package version: `1.0.0-rc.1`.

Worktree label: `feat/wasm-1.0`.

## Current state (updated)

Honest-release phases **B2–B6 and C0** are landed on this branch. C1/C2
(optional `getStats` on `WebTransportLike` + wasm implementation) and D4
(`scripts/promote-release-status.ts`) are landed. Remaining work is primarily
**evidence binding** (17 claims still pending), C3–C6c parity polish, D1 fuzz
campaign duration, and E-group doc freshness generators.

## Task status

| Task group | Current status | Primary paths |
|---|---|---|
| 1-4 | landed | evidence generator; crates/wasm; packages/webtransport |
| 5 | landed + C1/C2 getStats | `wasm-webtransport.ts`, `types.ts` |
| 6a | landed | `docs/WASM_PROTOCOL_SCOPE.md` |
| 6b | landed (impl) | `crates/wasm/src/cert.rs`; `WasmCertRotator`; COMPATIBILITY |
| 6c | harness landed; evidence pending | `tools/interop/*`; `examples/webtransport-wasm-iwa/` |
| 7-8 | review fixes largely absorbed; zero-P0-P4 claim pending | finding ledger; index.ts |
| 9-12 | tooling landed | fuzz/load/package-smoke |
| 13-15 | tooling/workflows landed; **evidence pending** | coverage/fuzz/iwa/soak workflows |
| 16 | landed | ARCHITECTURE/CI/COMPATIBILITY/OPERATIONS/TESTPLAN |
| 17 | pending final closure | `release-status.json`; promote tool |

## Exit criterion

`/wasm` joins the package 1.0 commitment only after remaining release gates are
evidenced in `docs/release-status.json` with commit-bound proof and
`bun scripts/promote-release-status.ts` succeeds.

Until then, `/wasm` remains a candidate surface.
