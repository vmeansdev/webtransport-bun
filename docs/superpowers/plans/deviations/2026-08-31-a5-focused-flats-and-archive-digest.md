# Deviation — A5 focused flats + archive digest binding

**Date:** 2026-08-31  
**Candidate:** `e6c0d7a2…` (Architect REJECTED)  
**Plan:** unchanged

## Discovery

Exact-stage Architect REJECTED `e6c0d7a2` because:

1. Focused/`promotable:false` campaigns still promoted WS/WT flats under
   `useInProcessSeal`.
2. `verify-campaign-index` previously skipped `expectedFlatCount` /
   `expectedPairCount` when the value was `0`.
3. Recursive artifact verify supplied `approvedPlanSha256` as
   `archiveSha256`, which cannot match the source archive digest.

## Resolution

- Flat promotion runs only for `executionPurpose === "canonical"`.
- Flat/pair expected counts are enforced including zero.
- CampaignIndexV2 carries `sourceArchiveSha256` from the stage receipt
  `archiveSha256`; verify uses that field, and rejects plan/archive
  digest aliasing. Plan bytes were not edited.
