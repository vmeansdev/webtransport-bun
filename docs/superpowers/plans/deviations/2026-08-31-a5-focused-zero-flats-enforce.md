# Deviation — A5 focused zero flats + enforce expectedFlatCount

**Date:** 2026-08-31  
**Candidate:** `e6c0d7a2…` (Architect REJECTED)  
**Plan:** unchanged

## Discovery

Exact-stage Architect REJECTED: controller still entered the flat-promotion
path for any in-process seal (including focused), and
`verify-campaign-index` ignored `--expected-flat-count=0`. A focused A-stop
campaign could therefore pass verification while writing or tolerating flats.

## Resolution

- `compare-controller.ts` promotes flats only when `executionPurpose===canonical`;
  focused/pilot finalize the index with zero flats.
- `verify-campaign-index.ts` counts top-level `*.json` flats (excluding
  `campaign-index.json` / `manifest.json`) and paired `*-ws.json`/`*-wt.json`
  against `expectedFlatCount` / `expectedPairCount`.

Plan bytes were not edited.
