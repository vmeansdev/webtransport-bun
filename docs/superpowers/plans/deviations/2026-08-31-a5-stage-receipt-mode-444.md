# Deviation — A5 stage-receipt.json mode 0444 (immutable)

**Date:** 2026-08-31
**Candidate:** `f420fb45` (stage-only re-run)
**Plan:** unchanged (Plan SHA `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)

## Discovery

Exact-staged-artifact Architect REJECTED the A5 focused re-staging because
`$MAC_TRUST/stage-receipt.json` was mode `0644`. The plan §9.4 only spelled out
mode `0444` for `upcoming-run-command.sh`, but its "remain immutable" applies
to both staged artifacts (`stage-receipt.json` and `upcoming-run-command.sh`).

## Resolution

`writeStageReceipt` in `tools/compare/bin/stage-live-campaign.ts` now writes
the receipt with `mode: 0o444` so the staged bytes are immutable. This matches
the `freeze-run-command` precedent (`writeFileSync(output, body, { mode: 0o444 })`)
and the "remain immutable" requirement. Plan bytes were not edited.

## Verification

`stat -f '%Lp' <stage-receipt.json>` prints `444` after stage-only completes.
`upcoming-run-command.sh` continues to be written with `mode: 0o444` by
`freeze-run-command`. The frozen run wrapper still reads both files but never
mutates them.
