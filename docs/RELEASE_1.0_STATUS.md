# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. The strict scale probe and
10k loopback recovery artifacts are GA-blocking release evidence.

## Local progress on candidate `c7a1e78…`

The candidate was rebound to branch HEAD on 2026-07-29, after the branch commit
messages were aligned to the project format. Every gate below was re-run at that
commit; nothing was carried over.

### Passed (commit-bound on candidate)

- `native-local-gates` (canonical bun package suite, 441/441)
- `wasm-local-gates` (`bun run test:wasm`, 86/86)
- `wasm-facade-parity` — all 9 `parity-*.test.ts` on both backends
  (native 67 pass/0 fail; wasm 64 pass/3 skip/0 fail)
- `wasm-dynamic-qpack`, `wasm-multi-session`, `wasm-0rtt` (timed unit evidence)
- `package-artifact`, `supply-chain-provenance`

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

### Remaining GA-blocking scale evidence

| Claim | Harness | Evidence artifact |
|---|---|---|
| `scale-10k-loopback-recovery` (`gaRequired: true`, `pending`) | `tools/load/distributed-scale.ts` | strict `.release-evidence/load/scale-probe-artifact.json` plus `.release-evidence/load/scale-10k-artifact.json` |

The hosted artifacts are explicitly one-source loopback evidence. The harness
can record real external source diversity, but does not infer it from processes.

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
- Facade parity is now proven, not asserted: the same nine parity suites pass on
  the native and wasm backends through the portable `createServer`, and caPem
  CA-root trust is verified end to end (handshake plus stream echo against a
  CA-issued leaf, foreign CA refused with `E_TLS` alert 48).
- R4 product gaps closed on candidate: random ticket vault, SNI=authority,
  QPACK encode scratch + blocked-stream cap, `ticketStore` on unified client.
- Soft facade divergences for pooling / waitUntilAvailable / getStats / CC /
  sendOrder were closed on the parity epic path; ticket dump auto-fires on
  close when a `TicketStoreHost` is set (`Memory` / `File` / `IndexedDB`).
  Live TLS/SNI rotate, metricsSnapshot, log/debug, and `WasmServerSession`
  are available on wasm managers. Async IWA plug-and-play `createServer` exists
  on `@webtransport-bun/webtransport/wasm` (candidate; not GA; not the root
  native sync API).
- Promote still refuses until the pending table above clears.

## Session progress 2026-08-04 (candidate advanced beyond `c7a1e78…`)

The branch has advanced well past the recorded candidate. This section records
the state honestly; it does **not** re-bind `release-status.json` or claim any
`gaRequired` gate, which still require commit-bound evidence regenerated at the
new head.

- **Local gates green at the current head** (native `cargo test -p native`
  169/0; wasm crate 250/0; `bun test packages/` 511/0; `bun run test:wasm`
  96/0; `bun x tsc --noEmit` clean). This is local truth, not release evidence.
- **Functional 1.0-readiness plan tasks 1–9 landed** (bounded waits; package
  process-tree reaping; accept-loop task accounting; ECDSA-key contract locked
  with tests; WASM single-use tickets, real queued-bytes, zero-skip error
  parity; recursive evidence-privacy scanner; three-surface API contract
  frozen). Several plan premises proved false on inspection and were recorded
  as such; the diagnostic steps still surfaced real defects, which were fixed.
- **CI environment repaired**: the cross-OS matrix went from failing at
  `build:native` on every OS to running the full suites. Fixes: install-before-
  build ordering, per-OS wasm32 LLVM toolchain, coverage `RUSTC_BOOTSTRAP`,
  Node-appropriate npm in the consumer matrix, and a repaired fuzz-target /
  adversary-fixture build. Heavy load and stress campaigns moved to a dedicated
  Linux `load` job (they saturate loopback UDP on shared runners). The current
  release workflow deliberately generates a strict 20-session protocol/stream
  probe and a separate 10k datagram/recovery artifact.
- **RSS recovery gate validated on real CI Linux** (charged `smaps-lazyfree`
  metric: cold-start residency delta 11.03 MB under the pre-registered 13.1 MB
  Linux cap; service-ready ratio 1.11 under 1.25).
- **Known CI reds, all traced to one shared-runner root cause** — loopback UDP
  datagram delivery is unreliable under concurrency on GitHub runners. This
  flakes the `load` job's flood profiles and one datagram-triggered Chromium
  interop close test (`interop-expanded.pw.ts` "close … propagates to client",
  which passes on macOS and fails on loaded ubuntu/windows). Neither is a code
  defect; both belong to the `chromium-native-interop` / load-evidence gates.
- **Still open for GA** (unchanged, still blocking): re-bind the candidate and
  regenerate every `gaRequired` evidence artifact at the new head; the pending
  gate table above; external `LOKALISE_API_TOKEN` rotation and published-history
  purge; the interactive IWA Direct Sockets proof; and the 24h/72h soaks.
