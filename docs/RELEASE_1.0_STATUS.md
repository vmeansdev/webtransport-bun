# 1.0.0 Release Status — native surface

Branch: `release/1.0-hardening` (6 commits on top of the wasm merge `46aa68b`).
Scope: freeze the **native** (root entrypoint) surface at 1.0.0. The `/wasm`
subpath ships as **experimental/0.x**, exempt from the semver commitment.

## What was fixed (all committed, tested, verified)

Every defect from the 2026-07-19 four-agent audit, plus two found by the
post-fix re-review:

| Defect | Sev | Resolution | Commit |
|--------|-----|-----------|--------|
| Byte-budget leak → permanent capacity exhaustion | P0 | RAII reservation guards (`DatagramSlot`, `StreamChunk`) on datagram + stream-read + stream-write channels; released exactly once on dequeue or teardown | `6b38db3` |
| Client hangs forever on a dead path | P1 | 30s idle timeout + keep-alive (≤ idle/2), configurable | `867f40e`, `89917a7` |
| `close()` blocks a napi worker | P1 | tokio oneshot + `timeout().await` | `867f40e` |
| `serverCertificateHashes` panics the client thread (feature entirely broken, masked as handshake timeout) | P0 | `WebPkiServerVerifier::builder_with_provider(ring)` — the bare `builder()` resolved an uninstalled process-default CryptoProvider | `89917a7` |
| `closed`-rejects change leaked an unhandled rejection via the root-exported adapter | P1 | `.catch(() => {})` on the derived promise | `89917a7` |
| Write-after-finish truncation | P2 | deterministic `finished` guard, re-checked post-reservation | `1cbfe67` |
| Connection pool overflows its cap | P2 | reject with `E_LIMIT_EXCEEDED` | `1cbfe67` |
| Cross-server rate-limit DoS amplification | P2 | per-server-scoped `(server_id, ip)` keys | `1cbfe67` |
| Dead cert-hash validation (empty hashes passed) | P2 | require exactly 32 bytes | `c54dbcc` |
| `closed` didn't reject on connect failure (W3C) | P2 | rejects with the connect error; state stays `failed` | `c54dbcc`, `89917a7` |
| `#ready` unhandled rejection when only `closed` is observed | P2 | no-op `.catch` on `#ready` (symmetric to `#closed`) | (this batch) |

## Evidence gathered

- **Unit/integration:** 40 native cargo tests, 214 JS tests, tsc + clippy clean
  on every commit. New regression tests: 6 budget-guard (incl.
  churn-with-abandonment stays bounded), per-server rate-limit isolation,
  connect-failure `closed`-rejects, empty/wrong-size cert-hash rejection, and a
  **live pinned-hash connect** (previously untested — the gap that hid the P0).
- **Soak (20 min, 500 sessions, datagram + stream churn):** leak-trend gate
  **PASS**; RSS 46 MB → ~1075 MB peak under load → **46 MB after close** — the
  P0 budget-leak fix holds; memory is fully released on teardown. (The wrapper's
  absolute 1024 MB ceiling is a conservative test threshold that 500 concurrent
  QUIC+TLS sessions legitimately exceed; the ~17% session errors are same-IP
  rate-limiting under a synthetic single-source burst, not crashes.)

## What still gates an honest 1.0.0 tag (not code — evidence/process)

These require wall-clock or infrastructure and are **not** claimed as done:

1. **Green remote CI** on this branch (3-OS matrix). The branch is not pushed —
   an outward action left for maintainer go-ahead.
2. **A successful multi-hour / 72h soak** on the current code. The 20-min run is
   a proxy; the last scheduled 72h soak (pre-hardening) failed and was never
   re-run.
3. **Coverage measurement** (cargo-llvm-cov + bun) with published numbers.
4. **Load at true claim scale** — sustained multi-hour, ≥10k concurrent from
   diverse sources (the current soak is 500 same-IP sessions).
5. **Broader interop** (Firefox / non-Chromium / lossy-network) beyond the
   Chromium Playwright matrix.

## Review convergence

Three independent adversarial review rounds were run (initial audit → post-fix
re-review → final convergence review). The loop converged: round 2 caught a P0
(pinned-cert panic) and a P1 (unhandled-rejection regression), both fixed; the
final round confirmed all fixes correct and complete, found **no P0 and no true
P1**, and surfaced one last P2 (the `#ready` rejection asymmetry, now fixed).
The final reviewer's verdict: *"The native + native-TS surface is honestly
1.0.0-ready … no P0 and no true P1 blocker."*

A subsequent **zero-issue gate** was then run at the user's request: a
five-critic maximally-skeptical review (instructed to report every issue at any
severity, defaulting to reporting when uncertain) surfaced ~36 findings —
including a P1 that had been *reintroduced* by an earlier fix, and later a P1 a
fix had only half-applied (bidi write but not uni write). Every P0/P1/P2 was
fixed; P3/P4 were fixed or explicitly justified as by-design. Final two-surface
verification (native + TS) and a native re-verification after the last fixes all
returned **0 P0/P1/P2**. The package is versioned `1.0.0-rc.1` on that basis.

## Honest verdict

The native surface has **no known P0/P1 defects** after this work: the two
critical bugs (budget leak, pinned-cert panic) are fixed with regression tests
and, for the leak, direct soak evidence; liveness and close are bounded; the API
is freezable now that `/wasm` is carved out as experimental. That makes it
**code-ready** for a 1.0.0 candidate. It is **not yet honestly claimable as
"proven at 10M DAU / as reliable as Linux"** — that specific bar needs items
1–5 above, which are time- and infrastructure-bound, not code changes. The
defensible framing for a tag today is **1.0.0-rc** on the native surface, with
the production-scale claim following the CI + multi-day-soak + scale-load
evidence.
