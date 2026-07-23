# WASM Backend → 1.0 Plan & Status

Current release truth lives in `docs/release-status.json`. This document is the
working plan for the `/wasm` candidate, not a GA declaration.

Package version: `1.0.0-rc.1`.

Worktree label: `feat/wasm-1.0`.

## Current state

The local implementation work for Tasks 1-16 is largely landed. The review
loop is still tightening Tasks 7/8, 13, 14, and 15, and the release gates are
still pending:

- immutable candidate SHA
- cross-platform/runtime CI
- coverage evidence
- fuzz campaign evidence
- >=10k diverse-source scale evidence
- package/provenance evidence
- 24h and 72h soak evidence
- zero P0-P4 eight-lane review
- final no-change confirmation

Treat the items below as the current pickup guide for the wasm release track.

## Task status

| Task group | Current status | Primary paths |
|---|---|---|
| 1-4 | largely landed | `scripts/generate-release-evidence.ts`; `crates/wasm/src/*`; `packages/webtransport/src/*`; `packages/webtransport/test/*` |
| 5 | landed locally, still reviewed for facade parity details | `packages/webtransport/src/{wasm-webtransport.ts,webtransport-like-wasm.ts,backend-wasm.ts}` |
| 6a | landed | `docs/WASM_PROTOCOL_SCOPE.md` |
| 6b | pending | `crates/wasm/src/cert.rs`; `docs/COMPATIBILITY.md` |
| 6c | pending release verification | `tools/interop/WASM_INTEROP.md`; `examples/webtransport-wasm-iwa/` |
| 7 | review fixes in progress | `docs/reviews/2026-07-21-1.0-finding-ledger.md`; `docs/release-status.json` |
| 8 | review fixes in progress | `docs/reviews/2026-07-21-1.0-finding-ledger.md`; `packages/webtransport/src/index.ts` |
| 9-12 | largely landed | `tools/fuzz/*`; `tools/load/*`; `packages/webtransport/test/*`; `packages/webtransport/package.json` |
| 13-15 | pending release evidence | `.github/workflows/{coverage,fuzz,iwa}.yml`; `tools/interop/*`; `tools/load/*` |
| 16 | landed | `docs/{ARCHITECTURE.md,CI.md,COMPATIBILITY.md,OPERATIONS.md,TESTPLAN.md}` |
| 17 | pending final closure | `docs/release-status.json`; this plan; the evidence ledger |

## What is already in place

- The wasm backend is implemented as a candidate path, not a silent no-op.
- Browser-shaped client behavior is covered by `packages/webtransport/src/*`
  and the parity suites.
- Protocol scope is documented in `docs/WASM_PROTOCOL_SCOPE.md`.
- The interop harness and IWA proof flow exist in `tools/interop/*` and
  `examples/webtransport-wasm-iwa/`.

## What still needs to close

### Final release gates

- Candidate immutability: bind the final release proof to one SHA and keep that
  SHA stable.
- CI breadth: keep the native, wasm, and browser proof matrix green across the
  configured OS/runtime set.
- Evidence: publish coverage, fuzz, scale, soak, and package/provenance
  artifacts in the release ledger.
- Review: finish the eight-lane zero-P0-P4 review and confirm no new issues were
  introduced by the last review round.
- Freeze: record the final no-change confirmation only after all prior gates are
  in place.

### Review churn that is still active

- Tasks 7 and 8 are still absorbing review feedback on wasm facade/security
  behavior.
- Tasks 13, 14, and 15 are still about evidence generation and release-gate
  proof, not feature expansion.

## Exit criterion

`/wasm` can join the package 1.0 commitment only after the remaining release
gates are evidenced in `docs/release-status.json` with commit-bound proof.

Until then, `/wasm` remains a candidate surface and this plan remains the
current working guide.
