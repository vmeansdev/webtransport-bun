# Deviation: Freeze-run-command must expand plan §9.5 `run_measured_campaign`

**Date:** 2026-08-31  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (SHA-256 `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)  
**Phase:** A5 exact-stage review  

## Defect

Live `stage-only` for candidate `12d0dee2` / `busyms-attested-focused-r1` produced a receipt and mode-0444 command, but Architect (gpt-5.6-sol high) **REJECTED** the frozen command:

- Used `phase-a-busyMs-attested` instead of fixed `bulk-one-way/physical`
- Set controller timeout to `RUN_TIMEOUT_MS` (4200000) instead of `CAMPAIGN_TIMEOUT_MS=3600000`
- Invoked the controller directly without `run_measured_campaign`, recursive verify, diagnostic render, expected-count gates, or integrity-only failure handling

Verdict preserved at `.release-evidence/transport-comparison/a5-exact-stage-architect-REJECTED-12d0dee2.md`.

## Fix

`buildFrozenRunCommand` now embeds plan-extracted fragments:

- `tools/compare/bin/frozen-run-wrapper.fragment.sh` (cleanup / recovery / terminal helpers / `run_measured_campaign`)
- `tools/compare/bin/frozen-run-section-9.{5,6,7}.fragment.sh` (exact cell/timeout/expected counts)

## Next

Abandon rejected stage roots/keys; restage under new HEAD; fresh Architect→Critic on new digests. Plan bytes unchanged.
