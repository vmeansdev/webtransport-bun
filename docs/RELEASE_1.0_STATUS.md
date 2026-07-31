# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
`gaRequired: false`.

## Candidate state before functional verification

The manifest is still bound to candidate `c7a1e78…` and remains `pending`.
Those commit-bound artifacts are historical evidence; they do not certify the
current `codex/functional-1.0-readiness` source tree. This source-candidate
documentation pass deliberately does not rebind `docs/release-status.json` or
write new passed evidence. Task 11 must re-run the local lane from a clean
checkout and create the sanitized functional-readiness record first.

### Existing manifest evidence (bound to `c7a1e78…`, not this source candidate)

- `native-local-gates` (canonical bun package suite, 441/441)
- `wasm-local-gates` (`bun run test:wasm`, 86/86)
- `wasm-facade-parity` — all 9 `parity-*.test.ts` on both backends
  (native 67 pass/0 fail; wasm 64 pass/3 skip/0 fail)
- `wasm-dynamic-qpack`, `wasm-multi-session`, `wasm-0rtt` (timed unit evidence)
- `package-artifact`, `supply-chain-provenance`

### Functional-candidate truth boundary

For this bounded readiness program, a **functional candidate** means a source
candidate that is frozen only after the local deterministic checks, native and
WASM functional lanes, package-artifact checks, and the exact-package process
cleanup smoke have been re-run from a clean tree. It is not a stable release,
GA certification, publish approval, or cross-platform support claim. Hosted
CI, browser/IWA, long-soak, coverage/fuzz, operator, and independent-review
gates remain release gates even when local functional checks are healthy.

The Task 11 report will contain only sanitized, commit-bound data: schema
version; candidate commit and clean-tree identity; exact commands; start/end
timestamps; exit codes and pass/fail/skip counts; toolchain versions; current
OS/architecture; artifact digests where applicable; explicit deferred/external
gates; and no secrets or absolute host paths.

### Pre-verification observations (2026-07-31; not release evidence)

- `bun scripts/check-bounded-waits.ts` passed on the current source tree.
- The focused native and WASM parity lanes each completed with 69 passes and
  0 failures; the Task 5 ticket-lifecycle and Task 6 queued-byte proofs also
  pass in their focused runs.
- The exact-package process-artifact smoke remains a local blocker: the
  current host has no Deno runtime, and the process-tree cleanup run is
  host-sensitive (fake-Deno diagnostic capture and mocked nonzero-taskkill
  timeout behavior). The latest full-package observation had 2 failures, so
  it is not a release pass.
- The adversarial protocol build is also toolchain-blocked on this host:
  rustc 1.85.0 is below dependency floors required by the pinned wtransport
  and time/rcgen graph. That is an external toolchain blocker, not a passing
  local gate.

No local command in this documentation commit is being promoted to
commit-bound release evidence. A local failure, stale artifact, or privacy
failure returns execution to the relevant implementation task.

### Still pending (block promote)

| Claim | Blocker |
|---|---|
| `coverage-gates` | `cargo llvm-cov --branch` needs a nightly toolchain (`-Z coverage-options=branch`); not re-measured on the rebound candidate. Last measurement, on the pre-alignment gap-closure commit, was already under floor at endpoint/h3 branch 79.64/78.85 < 80 |
| `runtime-consumers`, `chromium-*`, `fault-matrix` | Not re-run on the rebound candidate; demoted pending re-verify |
| `iwa-direct-sockets` | **Demoted 2026-07-29 on rebind.** The Chrome 150 Direct Sockets proof was a manually rebuilt and signed IWA bundle; the run was real but is bound to the pre-alignment commit and cannot be reproduced non-interactively |
| `auto-review-zero-p0-p4` | **Demoted 2026-07-29 on rebind.** Round 5 closed with no open P0-P4, but against the gap-closure commit; the candidate has since advanced by the portable-`createServer`, `ServerSession`-convergence, caPem and `E_TLS` commits |
| `fuzz-gates` | Darwin cargo-fuzz sancov link fails; **Linux/CI campaign required** |
| `cross-platform-matrix` | Hosted macOS+Linux+Windows evidence not rebound |
| `soak-24h` / `soak-72h` | Wall-clock soak campaigns not run |
| `final-no-change-confirmation` | Requires immutable freeze after all other gates |

### Not GA-blocking

| Claim | Harness | Evidence artifact |
|---|---|---|
| `scale-10k-multisource` (`gaRequired: false`, `pending`) | `tools/load/distributed-scale.ts` | `tools/load/distributed-scale.test.ts`; `.release-evidence/load/distributed-scale-artifact.json` |

`distributed-scale.ts` is the authoritative multisource harness; the earlier
single-source scale scripts it replaced are not release evidence.

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
- The current source contains the portable server contract, strict native/WASM
  error semantics, deterministic ticket handling, retained-byte accounting,
  and complete interop-evidence privacy validation. Focused parity and
  lifecycle tests currently pass, but their results are not yet bound to a
  source-candidate evidence record.
- The portable `/portable` server is a common functional contract. The root
  native `createServer` remains synchronous and addon-backed; the `/wasm`
  entrypoint remains asynchronous and browser/IWA-oriented. These are
  intentional entrypoint differences, not a claim that every runtime is
  distribution-ready.
- Promote still refuses until the pending table above clears and Task 11 binds
  only freshly verified evidence to the frozen source candidate.
