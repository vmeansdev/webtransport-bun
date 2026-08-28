# WS-WT Real-Number Plan — Approval Record

> **For auditors:** this file is the canonical record of the
> architect + critic approval of the WS-WT real-number plan. The
> plan file itself remains at
> `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md` and is
> content-pinned at this SHA-256.

**Plan file:** `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md`
**Plan file SHA-256:** `b0928b3fefc8924f1da150718e0498168772c317c780a1c77cf29f37d2025c05`
**Plan HEAD:** `2a3da15f` on `codex/ws-scenario-comparison`
**Review date:** 2026-08-28

---

## Architect signature

- **Reviewer:** Codex MCP, role: architect
- **Model:** `gpt-5.6 Sol High`
- **Verdict:** `APPROVED`
- **Verdict iteration:** round 9 of architect review (the first
  eight rounds identified content gaps; the plan was rewritten
  and re-submitted in each round until the architect verdict
  stabilized at `APPROVED`).
- **Verbatim verdict text:** "APPROVED — `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md:15`
  correctly reads 'three pre-approved steps (two record-only, one
  small executable extraction).'"

## Critic signature

- **Reviewer:** Codex MCP, role: critic
- **Model:** `gpt-5.6 Sol High`
- **Verdict:** `APPROVED`
- **Verdict iteration:** round 7 of critic review (the first six
  rounds identified content gaps; the plan was rewritten and
  re-submitted in each round until the critic verdict stabilized
  at `APPROVED`).
- **Verbatim verdict text:** "APPROVED — Phase 2.4 has exactly
  Tasks 2.4.1–2.4.7; Task 2.4.7 specifies the `MeasuredLegToArm`
  adapter, sync request boundary, and both campaign call-site
  blocks; seven 2.4 commits, each with an explicit why clause;
  runnable llvm-cov sequence and Phase 0c extraction are present;
  cross-references are correct: BuildArtifactInput/verify-artifact
  are 2.4.3, renderer is 2.4.5."

## Scope of approval

The approval covers the plan content (the file content at this
SHA-256). The plan governs Phase 1 through Phase 4 of the WS-WT
real-number campaign. Phase 0 (this file's parent phase) is
pre-approved scope and ran without the architect+critic approval
protocol applying.

The approval is **content-pinned**, not HEAD-pinned. The
plan file is frozen at this SHA-256; subsequent commits in the
campaign may change `codex/ws-scenario-comparison`'s HEAD but
do not invalidate the approval as long as the plan file content
remains byte-identical to this SHA-256.

If a defect is found during execution, the fix is recorded in
a separate `docs/superpowers/plans/deviations/<phase>.md` file;
the plan file itself is not edited.

## Phase 0 record

Phase 0 has three pre-approved tasks. This record is one of
them. The other two are:
- `docs/superpowers/plans/2026-08-22-ws-wt-r2-r8.md` (R2–R8
  parent plan) — committed separately.
- `scripts/check-llvm-cov-floors.py` (extracted from
  `.github/workflows/coverage.yml:86-240` so the per-phase gate
  is runnable) — committed separately.

Both are committed as Verb+What+Why commits on the same
`codex/ws-scenario-comparison` branch as the plan itself.

---

**Auditor note:** to re-verify this approval, check
(1) the plan file's SHA-256 matches the value above;
(2) the `2a3da15f` commit is reachable from
`codex/ws-scenario-comparison`; (3) the review history in the
session transcripts records the architect + critic verdicts
quoted above; (4) the model identifier is `gpt-5.6 Sol High`,
not any other Codex model.
