# Deviation — the ws-wt-r0 evidence keeps retired cell ids and renders as non-cohort

**Date:** 2026-09-08  
**Candidate:** `973e9b67…` (the physical-budget cell replacement) and after  
**Plan:** physical-budget amendment D3 ("Historical sealed evidence under
`.release-evidence/transport-comparison/ws-wt-r0/` is not edited;
`renderSealedIndexDiagnostic` and `cohortCellForArm` treating those entries
as non-cohort cells is intended and recorded in the deviation set")

## Discovery

The amendment retires `ticker-fanout/rate-10000`, `rate-50000`,
`rate-100000`, `chat-fanout/subscribers-5000` and `subscribers-10000`, and
requires that they be "refused everywhere and never aliased". The sealed
evidence under `.release-evidence/transport-comparison/ws-wt-r0/` predates
the amendment and names them. By execution at this HEAD:

- `git ls-files .release-evidence/transport-comparison/ws-wt-r0 | wc -l`
  → 855 tracked files;
- `git grep -l` for the five ids under that root → 80 files name a retired
  id in their content (129 by file path);
- `cohortCellForArm({ cellId, armKind: "primary" })` → `null` for all five
  ids, and `FANOUT_COHORT_CELL_IDS` is exactly the six D3 ids.

## What this means for a reader

Sealed evidence is never edited. A reader that renders or verifies the
ws-wt-r0 index sees those entries as arms of no cohort cell: the diagnostic
render labels them `unattested` (no cohort export on a cell that, today,
requires none), the attestation classifier puts them outside the six cells,
and `verify-campaign-index` would refuse the index under the registered
topology of any current section because those cells are not registered. None
of that is a defect: the ids are unknown to the current contract by design,
and the historical evidence stands as it was sealed under the contract of
its day.

## Resolution

Recorded as intended behaviour. No alias, no compatibility table, no edit to
the sealed bytes. Anyone reading ws-wt-r0 reads it against the plan revision
it was sealed under, not against the physical-budget amendment.
