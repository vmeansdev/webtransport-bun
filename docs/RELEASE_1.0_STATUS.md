# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
`gaRequired: false`.

## Local progress on candidate `ab6bbdf…`

### Passed (commit-bound on candidate)

- `native-local-gates`, `wasm-local-gates`, `runtime-consumers`
- `chromium-native-interop` (19/19), `chromium-wasm-interop` (5/5)
- `fault-matrix` (1/1)
- `package-artifact`, `supply-chain-provenance`
- `wasm-dynamic-qpack`, `wasm-multi-session`, `wasm-0rtt`
- `auto-review-zero-p0-p4` (findings closed at product commit; round-3 re-review in progress)

### Still pending (block promote)

| Claim | Blocker |
|---|---|
| `coverage-gates` | Demoted: wasm `endpoint.rs` / `h3.rs` llvm-cov floors below 90/90/80 after QPACK/CONNECT work |
| `wasm-facade-parity` | Smoke green (session-map + wasm parity); claim flip at candidate rebind; pooling/waitUntilAvailable/`getStats` soft divergences |
| `iwa-direct-sockets` | Needs IWA origin/bundle + Chrome Direct Sockets run |
| `fuzz-gates` | Darwin cargo-fuzz sancov link fails; **Linux/CI campaign required** |
| `cross-platform-matrix` | Hosted macOS+Linux+Windows evidence not rebound |
| `soak-24h` / `soak-72h` | Wall-clock soak campaigns not run |
| `final-no-change-confirmation` | Requires immutable freeze after all other gates |

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
- Protocol product surfaces for QPACK / multi-session / 0-RTT are claim-passed
  on candidate `ab6bbdf` with local evidence; TicketStoreHost→rustls and
  facade parity remain incomplete.
- Promote still refuses until the pending table above clears.
