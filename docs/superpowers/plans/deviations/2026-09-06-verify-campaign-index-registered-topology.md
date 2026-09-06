# Deviation — the campaign verifier proves the registered topology

**Date:** 2026-09-06
**Plan:** `2026-08-30-busyMs-attested-fanout.md` — unchanged
**Plan lines:** 2373 (the verifier's obligations: "verifies expected
status/promotable/flat/pair counts"), 3431-3441 (the frozen §9 verifier argv),
and the equals-form CLI already recorded in
`deviations/2026-08-31-a5-verify-campaign-index-argv.md`.

## Deviation

Two additions to `tools/compare/bin/verify-campaign-index.ts`, and the four new
flags the three frozen section fragments now pass.

1. **Unconditional.** `validateIndexEntryConsistency` refuses an entry whose
   `repetitionKind` is not `"measured"`, and refuses `repetitionIndex < 1`.
2. **Opt-in, and every frozen section opts in.** `--expect-cells`,
   `--expect-arms`, `--expect-arm-kinds` and `--expect-measured-repetitions`
   (all four together or none) carry the section's registered topology.
   `proveRegisteredTopology` then requires: the index header names exactly that
   cell set, wire set, arm-kind set and repetition count; `scheduledMeasuredArms`
   is the product those four imply; every entry runs a scheduled cell, wire and
   arm kind, is PASS, is non-promotable under a non-canonical purpose, and
   declares the registered `repetitionTotal`; every (cell, wire, arm kind) triple
   in the cross product has exactly one PASS per measured repetition index
   `1..N`. It runs before any seal is opened.

`frozen-run-wrapper.fragment.sh` declares `ARMS=ws,wt` and `ARM_KINDS=primary`
once and reads them twice: `--arm-kinds="$ARM_KINDS"` on the controller, and the
four `--expect-*` flags on the success-path verifier, alongside the section's
own `$CELLS` and `$REPS`. The integrity-only invocation carries none of them.

## Reason

`--expected-pass-count`, `--expected-sealed-count` and the rest are blind to
`transport`, `armKind` and `repetitionKind`. For A5, `--expected-pass-count=2`
is satisfied by the registered ws+wt primary pair, by two measured runs of one
wire, by a read-path arm standing in for a primary, and — before change (1) — by
a warmup entry relabelled as measured. The numbers in the frozen fragment are
the producer's own argv restated back at it, so the A5 stop gate was satisfied by
the producer rather than proved by the verifier.

## What did not change

Nothing about what the campaign produces. The controller's schedule, the index
it writes and the seals it mints are byte-identical; only what the verifier is
willing to accept changed. `--arm-kinds=primary` became
`--arm-kinds="$ARM_KINDS"` with `ARM_KINDS=primary`, which is the same argv.

## Run-command bytes

The frozen fragments changed, so `upcoming-run-command.sh` bytes change and any
existing exact-stage approval over the old bytes no longer matches. That is
correct and expected: a re-freeze and a fresh exact-staged review are required
before the next live run.

## Proof

`tools/compare/bin/verify-campaign-index.test.ts`,
`describe("verify-campaign-index registered topology")` — nine tests, including
`refuses_two_passes_on_one_wire_when_both_wires_are_registered`,
`refuses_a_read_path_arm_standing_in_for_the_registered_primary`,
`refuses_a_warmup_entry_in_a_sealed_index`,
`accepts_the_registered_a5_shape_and_moves_on_to_the_seals` (the honest shape
passes the proof and fails afterwards, on the absent seal), and
`proves_the_canonical_sixty_seal_shape_and_names_a_missing_repetition` (59 of 60
seals: every blind counter but the total still agrees, and the verifier names the
cell and the missing repetition).

`tools/compare/bin/stage-live-campaign.test.ts`,
`success_verification_states_the_registered_topology_of_its_section`, executes
all three generated commands and asserts each verifier argv carries the section's
topology and that it is the same cells/reps/arm-kinds the controller argv carries.
