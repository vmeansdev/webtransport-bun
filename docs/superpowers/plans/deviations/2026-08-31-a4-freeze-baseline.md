# A4 Phase A candidate freeze — gate baseline

**Date:** 2026-08-31  
**Frozen HEAD:** `6362e4abcd8b884cace9b13bcfce5c5a5097cb5b`  
**Plan SHA-256 (unchanged):** `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`  
**Evidence dir:** `.release-evidence/transport-comparison/a4-freeze/`

## Scoped commits present (A1–A3 + plan record)

- `7e805398` Fix server busy accounting to prevent closed-session double count  
- `2f3c592b` Record approved busyMs and fanout plan with architect-critic signatures  
- `553136f3` Add authenticated cross-supervisor codecs without changing seal production  
- `6362e4ab` Cut over attested server artifacts so every receipt remains offline verifiable  

`git diff --check` exit 0. Clippy `-D warnings` for `native` lib + `comparison-supervisor` exit 0.

## Section 10 gate results (honest)

| Command | Exit | Notes |
|---------|------|-------|
| `bun test tools/compare/ --timeout 30000` | 1 | 921 pass / 3 fail — R1 RED official-entrypoint inventory subset (same family as A3 deviation) |
| `bunx tsc -p tsconfig.json --noEmit` | 2 | Pre-existing render/client errors + new narrowing errors in `cross-supervisor-protocol.test.ts` |
| `bun tools/compare/check-official-io.ts` | 1 | 143-class allowlist inventory (A3 deviation) |
| `cargo test --workspace` | 101 | Pre-existing `a_grant_presented_after_it_expires_is_refused` |
| `cargo clippy -p native --lib --bin comparison-supervisor -- -D warnings` | 0 | Clean |
| `git diff --check` | 0 | Clean |

## Freeze decision

Candidate HEAD is frozen at `6362e4ab` for A5 staging identity. Section 10 is **not** fully green; failures match documented A2/A3 baselines plus tsc narrowing in A2 tests. A5 may proceed under live grant/admission; A5 must not claim a clean §10 stamp. Remediation of RED inventory / official-io / grant-expiry / tsc is tracked as follow-up before B6 success criterion #9.
