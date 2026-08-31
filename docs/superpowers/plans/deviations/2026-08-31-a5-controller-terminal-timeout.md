# Deviation — A5 controller `--campaign-timeout-ms` + `--write-terminal-record`

**Date:** 2026-08-31  
**Campaign:** `busyms-attested-focused-r1` (candidate `5b077adc…`)  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (unchanged)

## Discovery

Exact-stage Architect+Critic APPROVED the frozen §9.5 wrapper. Run-only then
failed immediately:

```text
controller: unknown argument: --campaign-timeout-ms=3600000
```

The approved plan requires both `--campaign-timeout-ms` and
`--write-terminal-record` on `compare-controller.ts`; the freeze wrapper already
emitted them, but the controller parser/runtime did not implement them.

## Resolution

Accept and enforce both flags; write `ControllerTerminalV1` as canonical JSON
(O_EXCL tmp + rename-after-fsync) before exit. Timeout maps to FAIL /
`MEASUREMENT_WINDOW`.

Plan bytes were not edited.
