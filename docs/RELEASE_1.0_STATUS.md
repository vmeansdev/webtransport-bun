# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
`gaRequired: false`.

## Local progress on candidate `cb0cb69…`

### Passed (commit-bound on candidate)

- `wasm-local-gates`, `package-artifact`, `supply-chain-provenance`
- `wasm-dynamic-qpack`, `wasm-multi-session`, `wasm-0rtt`
  (honest timed unit evidence after R4 gap-closure)
- `auto-review-zero-p0-p4` (round-5 remainingP0P4 empty)
- `iwa-direct-sockets` (local Chrome 150 Direct Sockets; rebuilt+signed bundle)

### Still pending (block promote)

| Claim | Blocker |
|---|---|
| `coverage-gates` | endpoint/h3 branch 79.64/78.85 < 80 after gap-closure |
| `native-local-gates`, `runtime-consumers`, `chromium-*`, `fault-matrix` | Not re-run on gap-closure SHA; demoted pending re-verify |
| `fuzz-gates` | Darwin cargo-fuzz sancov link fails; **Linux/CI campaign required** |
| `cross-platform-matrix` | Hosted macOS+Linux+Windows evidence not rebound |
| `soak-24h` / `soak-72h` | Wall-clock soak campaigns not run |
| `wasm-facade-parity` | **Demoted 2026-07-29.** Its `cb0cb69` evidence was a session-map smoke that never supported the claim's wording. Superseded by all 9 `parity-*.test.ts` on both backends (native 67/0; wasm 64 pass/3 skip/0 fail) — see `docs/release-evidence/11abb39…/facade_parity-dual-backend-evidence.json`. Stamping it `passed` needs evidence bound to `candidate.commit`, still `cb0cb69` |
| `final-no-change-confirmation` | Requires immutable freeze after all other gates |

### Not GA-blocking

| Claim | Harness | Evidence artifact |
|---|---|---|
| `scale-10k-multisource` (`gaRequired: false`, `pending`) | `tools/load/distributed-scale.ts` | `tools/load/distributed-scale.test.ts`; `.release-evidence/load/distributed-scale-artifact.json` |

`distributed-scale.ts` is the authoritative multisource harness; the earlier
single-source scale scripts it replaced are not release evidence.

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
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
