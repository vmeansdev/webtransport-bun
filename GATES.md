# GATES — Phase 1.1 capability sub-phase (four commits)

**Starting state:** Phase 1.1.1 (8c04e1d0) committed. Phase 0 complete.
Phase 1.1.2 (282b0af4) committed: capability F4 binding + thread-through.
Phase 1.1.3 (719cbaec) committed: retire the child-stated capability path.
Now landing Phase 1.1.4: F-class hardening of the per-field ban.

**Worktree:** `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
**Branch:** `codex/ws-scenario-comparison`
**Plan:** `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md`

## Phase 1.1.4 — F-class hardening of the per-field ban

Phase 1.1.4 mirrors commit `42d9fff8` (toolchain): the F-class review
looks for any per-field names the umbrella missed. For toolchain the
review surfaced a real gap (the per-field names `bunVersion`,
`bunRevision`, `bunExecutableSha256` were not on the forbidden list
and a child observation of `{ bunVersion: "9.9.9" }` was being
silently accepted). For capability the review finds no gap: the
per-field names were already on the forbidden list from commit
`8c04e1d0` (Phase 1.1.1), because we learned from the toolchain case.
This commit codifies the F-class review's finding: every shape a
child could try to smuggle a capability in is refused structurally,
including the edge cases (null, undefined, zero, empty string), and
the absence of any capability-named key is still accepted so the
refusal is not blanket.

- [x] **G1.1.4.1** — F-class review test asserts the per-field ban is comprehensive
  - CHECK: `grep -A 4 "every smuggling shape the per-field ban claims to catch" tools/compare/r1-trust-validators.test.ts`
  - EXPECT: a test that iterates the umbrella name, each per-field name (wrapped and unwrapped), the per-field alongside other unrelated keys, and the edge cases (null / undefined / 0 / "" / false), asserting `TRUST_CHILD_OBSERVATION_FORBIDDEN`; plus the negative case (no capability-named key) is accepted
  - EVIDENCE: r1-trust-validators.test.ts:843-895

- [x] **G1.1.4.2** — `tsc` clean
  - CHECK: `bunx tsc -p tsconfig.json`
  - EXPECT: exits 0
  - EVIDENCE: no output, exit 0

- [x] **G1.1.4.3** — `bun test tools/compare/` 0 fail
  - CHECK: `bun test tools/compare/ 2>&1 | tail -5`
  - EXPECT: "0 fail"
  - EVIDENCE: "605 pass / 0 fail / 8259 expect() calls"

- [x] **G1.1.4.4** — Both frozen verifiers CLEAN
  - CHECK: `bun scripts/verify-r1-fixture-hashes.ts && bun scripts/verify-r1-document-hashes.ts`
  - EXPECT: both report CLEAN
  - EVIDENCE: "fixture hashes: CLEAN" and "document hashes: CLEAN"

## Done definition

Phase 1.1.4 lands as one commit on `codex/ws-scenario-comparison` with all
4 boxes checked and committed code in green state. The 1.1 sub-phase
gate is then fully met (1.1.1 + 1.1.2 + 1.1.3 + 1.1.4 all green).
The 1.2 (lock) and 1.3 (manifest) sub-phases follow.
