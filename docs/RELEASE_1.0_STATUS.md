# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

Current state: both the native root entrypoint and `/wasm` are **candidate**
surfaces under a **coupled** GA model. Neither surface is stable until every
claim with `gaRequired: true` is `passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
tracked with `gaRequired: false` and does not block promote.

Do **not** treat the tables below as live status — always read
`docs/release-status.json`. This file only explains how to interpret the
manifest and lists claim categories.

## Claim categories

### Native surface (`surfaces.native.requiredClaims`)

- `native-local-gates`
- `chromium-native-interop`

### WASM surface (`surfaces.wasm.requiredClaims`)

- `wasm-local-gates`
- `chromium-wasm-interop`
- `iwa-direct-sockets`
- `wasm-dynamic-qpack` (protocol bar)
- `wasm-multi-session` (protocol bar)
- `wasm-0rtt` (protocol bar)
- `wasm-facade-parity` (API bar)

### Release / shared (`gaRequired: true` unless noted)

- `cross-platform-matrix`, `runtime-consumers`, `fault-matrix`
- `coverage-gates`, `fuzz-gates`
- `package-artifact`, `supply-chain-provenance`
- `soak-24h`, `soak-72h`
- `auto-review-zero-p0-p4`, `final-no-change-confirmation`
- `scale-10k-multisource` — **`gaRequired: false`**

## What is safe to say today

- The package is still `1.0.0-rc.1`.
- Readiness remains `pending` in `docs/release-status.json`.
- Several local claims already carry commit-bound `evidenceIds` under
  `docs/release-evidence/` while Actions are unavailable; others (coverage
  floors, fuzz campaign, soaks, protocol bar) are still open.
- `/wasm` is a candidate toward coupled 1.0, not an experimental forever-omit
  of QPACK / multi-session / 0-RTT — see `docs/WASM_PROTOCOL_SCOPE.md`.

## Historical note

Older narrative summaries that described the native surface as “ready”, or
WASM protocol limits as permanent phase omissions, are superseded by the
coupled 1.0 contract and `docs/release-status.json`.
