# Deviation — A5 diagnostic render without flats

**Date:** 2026-08-31  
**Candidate:** `4fdee542…` (Architect REJECTED)  
**Plan:** unchanged

## Discovery

Exact-stage Architect REJECTED because §9.5 diagnostic freeze sets
`EXPECTED_FLATS=0` then calls `render-campaign-report.ts`, which exited when
no promoted WS/WT flat pairs existed. That made a valid focused A-stop-gate
campaign (two PASS, `promotable:false`, zero flats) fail at `RENDER_RC`.

## Resolution

`render-campaign-report.ts` now supports `--source=sealed-index` with
`--allow-non-promotable`, writing a diagnostic report from
`campaign-index.json` sealed paths (including the plan's
`NON-PROMOTABLE FOCUSED EVIDENCE` / `PILOT` banner). The freeze diagnostic
branch invokes that mode; positional argv also falls back for focused/pilot
indexes. `compare-controller` skips flats render for focused/pilot so
`CONTROLLER_RC` stays 0 when zero flats exist. Plan bytes were not edited.

`compare-controller.ts` skips end-of-run flat render for focused/pilot; the
freeze wrapper owns sealed-index diagnostic after verify-campaign-index.
