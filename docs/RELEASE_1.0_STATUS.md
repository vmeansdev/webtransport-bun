# 1.0.0 Release Status

Canonical release truth: `docs/release-status.json`.

Package version: `1.0.0-rc.1`.

**Coupled GA model:** `1.0.0` only when every `gaRequired: true` claim is
`passed` with commit-bound evidence and
`bun scripts/promote-release-status.ts` succeeds. `scale-10k-multisource` is
`gaRequired: false`.

## Current state (2026-10-29): no candidate, every claim pending

`docs/release-status.json` is bound to no candidate (`candidate.commit: null`,
readiness `pending`) and every claim is `pending` with no evidence IDs.

Why: all previously recorded evidence was bound to the pre-rewrite candidate
`875dfbfe…`, which no longer exists after the 2026-10 history rewrite (see
`docs/HISTORY_REWRITE_2026-10.md`), and was already stale (the branch had moved
967 commits past it). The evidence files themselves (`docs/release-evidence/`,
`.release-evidence/`, `.bench-evidence/`) were removed from the repository on
2026-10-29 together with the other measurement-campaign material and archived
outside it.

Evidence will be regenerated at the next frozen candidate and stored outside
the repository. **Open question:** whether it is published as GitHub release
assets of the candidate tag or kept in a separate evidence repository; the
`docs/release-evidence.schema.json` contract and
`scripts/promote-release-status.ts` / `scripts/check-doc-truth.ts` stay in this
repo either way, and evidence paths will need to resolve wherever that lands.
Tracked files under `.release-evidence/` and `.bench-evidence/` are refused by
CI (`scripts/check-tracked-hygiene.sh`).

### Pending (block promote)

Every `gaRequired: true` claim: `native-local-gates`, `wasm-local-gates`,
`wasm-facade-parity`, `wasm-dynamic-qpack`, `wasm-multi-session`, `wasm-0rtt`,
`chromium-native-interop`, `chromium-wasm-interop`, `iwa-direct-sockets`,
`runtime-consumers`, `cross-platform-matrix`, `fault-matrix`, `coverage-gates`,
`fuzz-gates`, `package-artifact`, `supply-chain-provenance`, `soak-24h`,
`soak-72h`, `auto-review-zero-p0-p4`, `final-no-change-confirmation`.

Known blockers carried over from the last candidate: `coverage-gates` needs a
nightly toolchain for `cargo llvm-cov --branch` (last measured under the 80%
branch floor at endpoint/h3); `fuzz-gates` needs a Linux/CI campaign (darwin
cargo-fuzz sancov link fails); `iwa-direct-sockets` needs the interactive
Chrome Direct Sockets proof; the soaks are wall-clock campaigns;
`final-no-change-confirmation` requires an immutable freeze after all other
gates.

### Not GA-blocking

| Claim | Harness | Evidence artifact |
|---|---|---|
| `scale-10k-multisource` (`gaRequired: false`, `pending`) | `tools/load/distributed-scale.ts` | `tools/load/distributed-scale.test.ts`; run output `.release-evidence/load/distributed-scale-artifact.json` (untracked) |

`distributed-scale.ts` is the authoritative multisource harness; the earlier
single-source scale scripts it replaced are not release evidence.

## What is safe to say today

- Package remains `1.0.0-rc.1`; readiness remains `pending`.
- No gate is currently `passed` in `docs/release-status.json`; earlier passes
  were bound to a commit that no longer exists and are history, not evidence.
- Promote refuses until every `gaRequired` claim passes at a new candidate.

## History: session progress 2026-08-04 (candidate advanced beyond `c7a1e78…`)

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
  Linux `load` job (they saturate loopback UDP on shared runners; the strict
  200-session RSS evidence is generated deliberately, not per push).
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
  gates above; external `LOKALISE_API_TOKEN` rotation and published-history
  purge; the interactive IWA Direct Sockets proof; and the 24h/72h soaks.
- **History rewritten 2026-10-29** (token rotated, history purged): SHAs cited in
  this repo predate the rewrite; resolve them via `docs/HISTORY_REWRITE_2026-10.md`.

## Capacity gates ruling 2026-10-28

Nikita ruled the bare-metal capacity gates G1–G11 passed for 1.0, each stated
with its own figure and placement phrase as recorded in the capacity chapter
(the verdict ledger). That chapter and the campaign records behind it were
moved out of the repository on 2026-10-29 with the other campaign material;
they are not part of the shipped documentation. G10 carries a remark: no cloud
verdict exists (DigitalOcean reruns stopped on provider-side loss between the
NICs), its scenario is superseded by the paced-broadcast PASS, and a dedicated
bare-metal rerun is parked. These gates are capacity evidence for the
documentation; they are not `release-status.json` claims and do not change the
coupled GA model above.
