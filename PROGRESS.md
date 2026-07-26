# WASM 1.0 honest-release progress

**Goal:** Close remaining gaps from `docs/WASM_1.0_PLAN.md` and
`docs/superpowers/plans/2026-07-24-1.0-honest-release.md`.

**Branch tip:** see `git log -1 --oneline` (work continues on `feat/wasm-1.0`,
not `release/1.0-hardening`).

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
| D1 | partial | fuzz compile-check green locally; release-smoke fixed for `--fuzz-dir`/`--sanitizer none`; darwin sancov link still blocks full smoke |
| D3 | partial | scale-10k retained pending with note (not falsely passed) |
| D4 | complete | `scripts/promote-release-status.ts` refuses without evidence |
| E | partial | SUPPORT.md + wtransport disclosure; SPEC generator (E2) not built |
| Evidence bind | **partial (local, no Actions)** | 9/17 claims passed with commit-bound artifacts under `docs/release-evidence/`; readiness still `pending` |

## Local verification (this worktree)

- `bun run typecheck` + `check-doc-truth` pass
- `bun run test:wasm` → 67/67 pass (`WEBTRANSPORT_REQUIRE_WASM=1`)
- Packages cold-loop → 369/369 pass
- `bun run test:parity` → 63/63 pass
- `bun scripts/test-package-artifact.ts build` → tarball produced
- `bun scripts/check-actions-pinned.ts` → pass (11 workflows)
- `tools/fuzz` `cargo check --all-targets` pass (Rust 1.95.0)
- `tools/fuzz/release-smoke.test.ts` → 9/9 pass

## Bound claims (candidate `19acc30…`)

- `wasm-local-gates`
- `native-local-gates` (cold-loop subset; full `test:ci-local` still open)
- `package-artifact`
- `runtime-consumers`
- `supply-chain-provenance`
- `chromium-native-interop` (Playwright 19/19 darwin)
- `fault-matrix`
- `iwa-direct-sockets` (system Chrome 150 IWA proof)
- `chromium-wasm-interop` (Playwright wasm 5/5 darwin)

## What still blocks readiness=ready

1. Remaining commit-bound claims: coverage, fuzz campaign (Linux),
   cross-platform matrix, soaks, review, final no-change.
2. Soak 24h/72h (honest-release marked soak out of scope as evidence; still in release-status).
3. Eight-lane zero P0–P4 review + final no-change confirmation.
4. Optional: E2 `scripts/gen-spec.ts` freshness generator.

### Interop note (local Chromium)

Native Playwright suite is **19/19** on darwin after the interop addon emits
application idle close `3990`/`E_SESSION_IDLE_TIMEOUT` (Chromium may still
surface `Connection lost` client-side; server close-events are asserted).
Coverage, fuzz (Linux), cross-platform matrix, soaks, review remain pending.

GitHub Actions are unavailable for now; continue generating local/Linux evidence
and binding under `docs/release-evidence/<commit>/` rather than waiting on CI
artifacts.
