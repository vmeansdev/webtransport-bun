# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
`gaRequired: false`.

## Local progress on candidate `b97e622…`

### Passed (commit-bound on candidate)

- `native-local-gates`, `wasm-local-gates`, `runtime-consumers`
- `chromium-native-interop`, `chromium-wasm-interop`
- `fault-matrix`, `package-artifact`, `supply-chain-provenance`
- `coverage-gates` (endpoint/h3 floors recovered)
- `iwa-direct-sockets` (local Chrome Direct Sockets proof)
- `wasm-dynamic-qpack`, `wasm-multi-session`, `wasm-0rtt`, `wasm-facade-parity`
- `auto-review-zero-p0-p4`

### Still pending (block promote)

| Claim | Blocker |
|---|---|
| `fuzz-gates` | Darwin cargo-fuzz sancov link fails; **Linux/CI campaign required** |
| `cross-platform-matrix` | Hosted macOS+Linux+Windows evidence not rebound |
| `soak-24h` / `soak-72h` | Wall-clock soak campaigns not run |
| `final-no-change-confirmation` | Requires immutable freeze after all other gates |

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
- Protocol + facade + IWA + coverage gates are claim-passed on candidate
  `b97e622` with local commit-bound evidence. Soft facade divergences
  (`allowPooling` / `waitUntilAvailable` / zero `getStats`) remain documented.
- TicketStoreHost hydrate/dump is on the 0-RTT path; durable IndexedDB is not.
- Promote still refuses until the pending table above clears.
