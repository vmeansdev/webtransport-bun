# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. The distributed
`scale-10k-multisource` workload and the 24h/72h soak campaigns are tracked
as `gaRequired: false` post-1.0 follow-ups and do not block `1.0.0`.

## Bounded functional-candidate state

The manifest is bound to source candidate
`5db80f071085d951168e9438bc930add453fffe3` and remains `pending`. The
sanitized proof is recorded in
`docs/release-evidence/5db80f071085d951168e9438bc930add453fffe3/functional-readiness.json`.
The evidence-child handoff still has to preserve this source SHA as its parent;
the source candidate, not the evidence child, remains the code/package identity.

The current commit-bound local claims are `native-local-gates`,
`wasm-local-gates`, `runtime-consumers`, native and WASM Chromium interop,
`package-artifact`, `supply-chain-provenance`, and the WASM QPACK,
multi-session, 0-RTT, and facade-parity checks. Historical evidence directories
remain retained for audit context but are not referenced by the current
manifest.

### Functional-candidate truth boundary

For this bounded readiness program, a **functional candidate** means a source
candidate that is frozen only after the local deterministic checks, native and
WASM functional lanes, package-artifact checks, and the exact-package process
cleanup smoke have been re-run from a clean tree. It is not a stable release,
GA certification, publish approval, or cross-platform support claim. Hosted
CI, browser/IWA, coverage/fuzz, benchmark, operator, and independent-review
gates remain release gates even when local functional checks are healthy. The
distributed 10k workload and 24h/72h wall-clock soaks are optional post-1.0
reliability evidence, not `1.0.0` promotion gates.

The Task 11 report will contain only sanitized, commit-bound data: schema
version; candidate commit and clean-tree identity; exact commands; start/end
timestamps; exit codes and pass/fail/skip counts; toolchain versions; current
OS/architecture; artifact digests where applicable; explicit deferred/external
gates; and no secrets or absolute host paths.

### Verified bounded local result (2026-08-01)

- The canonical pinned lane completed with ten package cold-loop iterations;
  each iteration reported 488 pass and 0 fail across 65 files, and the exact-
  package cleanup proof remained green.
- Rust 1.95.0 and Deno 2.9.3 are callable. The same reproducible tarball passed
  Bun, Node, and Deno import, datagram, uni-stream, bidi-stream, and
  deterministic-close smokes.
- The authoritative two-cycle scale verdict passed with natural process exits
  and no forced kills. In-process RSS residency remains diagnostic telemetry
  under the adopted policy; it is not an authoritative leak failure.
- Fresh sanitized Chromium reports passed 21 native tests and 7 WASM-server
  tests. Bounded waits, docs truth, internal docs truth, parity, load profiles,
  and the canonical release policy checks also passed.
- The release-smoke fuzz command remains deferred: eight Darwin arm64
  cargo-fuzz targets hit the sanitizer-coverage linker limitation, while the
  parser/decoder harnesses passed. Linux/CI fuzz evidence is still required.

The full sanitized command, count, digest, and deferral record is the
commit-bound functional-readiness artifact named above.

### Still pending (block promote)

| Claim | Blocker |
|---|---|
| `coverage-gates` | `cargo llvm-cov --branch` needs a nightly toolchain (`-Z coverage-options=branch`); Bun coverage passed, native/WASM branch floors remain pending |
| `fault-matrix` | Dedicated release fault-matrix artifact was not regenerated for this candidate |
| `iwa-direct-sockets` | Current signed IWA assets and signing authority are unavailable for a reproducible non-interactive proof |
| `auto-review-zero-p0-p4` | Current architect, critic, security, and test-evidence reviews found no P0-P2 issue; a full P0-P4 release artifact remains pending |
| `fuzz-gates` | Darwin cargo-fuzz sanitizer-coverage link fails; **Linux/CI campaign required** |
| `cross-platform-matrix` | Hosted macOS+Linux+Windows evidence remains pending |
| `final-no-change-confirmation` | Requires immutable freeze after all other gates |

### Not GA-blocking

| Claim | Harness | Evidence artifact |
|---|---|---|
| `scale-10k-multisource` (`gaRequired: false`, `pending`) | `tools/load/distributed-scale.ts` | `tools/load/distributed-scale.test.ts`; `.release-evidence/load/distributed-scale-artifact.json` |
| `soak-24h` / `soak-72h` (`gaRequired: false`, `pending`) | `soak-long.yml` / `bun run test:soak-addon:24h` / `:72h` | segmented `soak-segment-*` and aggregate `soak-aggregate-*` artifacts |

`distributed-scale.ts` is the authoritative multisource harness; the earlier
single-source scale scripts it replaced are not release evidence. These scale
and long-soak records remain useful for post-1.0 reliability follow-up and are
not required to clear the promotion table.

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
- The current source contains the portable server contract, strict native/WASM
  error semantics, deterministic ticket handling, retained-byte accounting,
  and complete interop-evidence privacy validation. The bounded local results
  are now bound to the source candidate by the functional-readiness artifact.
- The portable `/portable` server is a common functional contract. The root
  native `createServer` remains synchronous and addon-backed; the `/wasm`
  entrypoint remains asynchronous and browser/IWA-oriented. These are
  intentional entrypoint differences, not a claim that every runtime is
  distribution-ready.
- Promote still refuses until the pending table above clears; the current
  bounded result is not a stable, GA, publish, or all-platform certification.
