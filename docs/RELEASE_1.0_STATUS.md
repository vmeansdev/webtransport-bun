# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
`gaRequired: false`.

## Local progress on candidate `2cc0732…` (working tree ahead)

### Passed (locally rebound)

- `native-local-gates`, `wasm-local-gates`, `runtime-consumers`
- `chromium-native-interop` (19/19), `chromium-wasm-interop` (5/5)
- `fault-matrix` (1/1)
- `coverage-gates` (native+wasm llvm-cov floors ≥90/90/80)
- `package-artifact`, `supply-chain-provenance`
- Protocol/facade bar: `wasm-dynamic-qpack`, `wasm-multi-session`,
  `wasm-0rtt`, `wasm-facade-parity` (unit/parity evidence; Chromium-facing
  QPACK SETTINGS remain zero by default until decoder-stream ACKs land)

### Still pending (block promote)

| Claim | Blocker |
|---|---|
| `iwa-direct-sockets` | Needs IWA origin/bundle + Chrome Direct Sockets run (`origin.txt` missing locally) |
| `fuzz-gates` | Darwin cargo-fuzz sancov link fails; **Linux/CI campaign required** |
| `cross-platform-matrix` | Hosted macOS+Linux+Windows evidence not rebound |
| `soak-24h` / `soak-72h` | Wall-clock soak campaigns not run |
| `auto-review-zero-p0-p4` | Eight-lane zero P0–P4 not closed |
| `final-no-change-confirmation` | Requires immutable freeze after all other gates |

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
- Dual-surface protocol foundations and coverage floors landed on
  `feat/wasm-1.0`.
- Promote still refuses until the pending table above clears.
