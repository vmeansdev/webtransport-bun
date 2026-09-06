# Deviation — the frozen run command clears the ambient gate-weakening environment

**Date:** 2026-09-06
**Plan:** `2026-08-30-busyMs-attested-fanout.md` — unchanged
**Plan lines:** 2860-2875 (the exports the run command sets before the section
body) and 2905-2907 ("`freeze-run-command` embeds ALL of the following verified
literals before any trap body runs").

## Deviation

The generated preamble now begins, immediately after `set -euo pipefail` and
before any literal, export, or trap, with one `unset` per name in the new
`AMBIENT_ENV_CLEARED_BY_FROZEN_RUN`
(`tools/compare/bin/stage-live-campaign.ts`): thirteen names today, including
`COMPARISON_MAC_SUPERVISOR_UID_SEAM`, `COMPARISON_MAC_CAMPAIGN_SCRATCH_ROOT`,
`COMPARISON_STAGING_ROOT`, `OBSERVE_DIRECTORY_IDENTITY_BINARY`, the three
`WS_WT_COHORT_*` per-execution identities, the three `WS_WT_TLS_*` server
identity values and the three `WT_COMPARE_*` staged-material values.

## Reason

The plan pins what the run must set. It says nothing about what the run must
clear, and not setting a variable is not the same as clearing it: the frozen
command is executed as `bash "$MAC_TRUST/upcoming-run-command.sh"` in whatever
shell the operator is sitting in, and it inherits that shell's environment.
`COMPARISON_MAC_SUPERVISOR_UID_SEAM=1` present in that shell makes the
controller skip all twelve pre-traffic uid preconditions
(`compare-controller.ts`, the `MAC_SUPERVISOR_UID_SEAM_ENV` branch around
:2905); `OBSERVE_DIRECTORY_IDENTITY_BINARY` substitutes the directory-identity
observer; the `WS_WT_TLS_*` values substitute the server identity being
measured. Each is a gate the frozen command appears to run and would not have
run.

## Reason the list cannot rot

The list is a production constant, and the test derives what it *should* be from
the sources: every namespaced name production reads, minus every name the
command itself pins. A new production `process.env` read is red until the
command either pins it or clears it.

## Proof

`tools/compare/bin/stage-live-campaign.test.ts`:

- `clears_every_ambient_variable_production_reads_and_the_command_does_not_pin`
  compares the emitted `unset` set against the derived set, exactly.
- `clears_the_ambient_variables_before_it_pins_or_runs_anything` asserts the last
  `unset` precedes the first `export` and the first `trap`.
- `the_controller_never_sees_an_ambient_uid_seam_the_operator_shell_carried`
  executes the generated command with
  `COMPARISON_MAC_SUPERVISOR_UID_SEAM=1` and `WS_WT_TLS_CERT_CONTENT` set in the
  parent environment and asserts every `$MAC_BUN` child — the controller among
  them — sees both unset.

Dropping `COMPARISON_MAC_SUPERVISOR_UID_SEAM` from the constant turns the first
and third red.
