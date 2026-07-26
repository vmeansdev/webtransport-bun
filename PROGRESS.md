# WASM 1.0 honest-release progress

**Goal:** Close remaining gaps from `docs/WASM_1.0_PLAN.md` and
`docs/superpowers/plans/2026-07-24-1.0-honest-release.md`.

**Branch tip:** see `git log -1 --oneline`

## Phase ledger

| Phase | Status | Notes |
|---|---|---|
| B4, B1, A0–A6 | complete (pre-session) | through `e2d09d4` |
| B2a–c | complete | matrix false-green killed |
| B3 | complete | dist behavioral gate (+ cert-pin fix for production AcceptAny) |
| B5 | complete | bench gate harden |
| B6 | complete | dead IWA test deleted; ready refuses without IWA evidence |
| C0 | complete | fail-closed accept-any + PRODUCTION_BUILD marker |
| C1–C2 | complete | optional getStats + wasm zeros |
| C3 | complete | waitUntilAvailable accepted on wasm stream opens |
| C4 | largely complete | A1/A2 error-code surface already landed |
| C5–C6 | largely complete | 9 `parity-*.test.ts` suites present; further option polish is incremental |
| D1 | partial | fuzz compile-check green locally; full release-duration campaign still pending |
| D3 | partial | scale-10k retained pending with note (not falsely passed) |
| D4 | complete | `scripts/promote-release-status.ts` refuses without evidence |
| E | partial | SUPPORT.md + wtransport disclosure; SPEC generator (E2) not built |
| Evidence bind | **blocked on CI artifacts** | 17/17 claims still `pending`; promote dry-run refuses |

## Local verification (this worktree)

- `bun run typecheck` + `check-doc-truth` pass
- `bun run test:wasm` → 67/67 pass (`WEBTRANSPORT_REQUIRE_WASM=1`)
- Non-wasm package suite → 307/307 pass after native error-parse / SessionHandle fixes
- `tools/fuzz` `cargo check --all-targets` pass (Rust 1.95.0)

## What still blocks readiness=ready

1. Commit-bound evidence artifacts for each claim (local gates, interop, IWA, coverage, fuzz campaign, package, provenance).
2. Soak 24h/72h (honest-release marked soak out of scope as evidence; still in release-status).
3. Eight-lane zero P0–P4 review + final no-change confirmation.
4. Optional: E2 `scripts/gen-spec.ts` freshness generator.
