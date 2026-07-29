# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
`gaRequired: false`.

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

### Not GA-blocking

| Claim | Harness | Evidence artifact |
|---|---|---|
| `scale-10k-multisource` (`gaRequired: false`, `pending`) | `tools/load/distributed-scale.ts` | `tools/load/distributed-scale.test.ts`; `.release-evidence/load/distributed-scale-artifact.json` |

`distributed-scale.ts` is the authoritative multisource harness; the earlier
single-source scale scripts it replaced are not release evidence.

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
