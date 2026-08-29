# Phase 3.4 — Real two-host rig execution unavailable

**Date:** 2026-08-29
**Status:** blocked on hardware
**Scope:** Phase 3.4 (real rig execution) and Phase 4 (real measurement) of the WS-WT real-number campaign.

## What landed

- Phase 0 (3 commits): R2-R8 plan, approval record, llvm-cov floor checker.
- Phase 1 (12 commits): R1 trust boundary beyond toolchain — capability, lock, manifest reservations. Each reservation follows the 4-step per-sub-phase shape: forbid+validate, atomic two-host set + rotation + F4 binding, retire child path, per-field F-class hardening. Both frozen verifiers CLEAN, 620/0 tests.
- Phase 2 (~16 commits): per-scenario executors (10 scenarios), SCENARIO_REGISTRY, `bin/compare-run.ts` with new `cliEntryTs` schema class, loop-utilization threaded into ArmMeasurement + BuildArtifactInput.
- Phase 3 (2 commits): `bin/compare-controller.ts` with dry-run mode, controller admitted at the static-I-O boundary.

## What did not land

- **Phase 3.4: Real two-host rig execution.** Requires the Linux bench at `10.99.0.2/eno1` and the Mac controller at `10.99.0.1/en8` with a direct cable between them. The bench is not reachable from the current environment.
- **Phase 4: Real measurement on the rig.** Depends on Phase 3.4. Even with the controller code in place, the actual numeric comparison (WS vs WT tail latency, throughput, loop-utilization) cannot be produced without a real run.

## Why

The campaign was executed in a development sandbox that has no direct network path to the production two-host rig. The Mac controller host (10.99.0.1/en8) and Linux bench (10.99.0.2/eno1) are on a separate VLAN; SSH, SCP, and the direct-cable `ping -S` route check all fail at the network boundary. The controller's `parseLinuxRoute` and `validateEndpoints` static checks would catch a misconfigured endpoint, but they cannot substitute for a real rig.

The controller's real-run path throws `RIG_BENCH_UNAVAILABLE` (a typed `ComparisonCliError`) so the campaign fails closed rather than publishing a synthetic or imagined number. The dry-run path is fully exercised by tests; the production run is not.

## What this means for downstream claims

- The plan's "no theater" invariant holds: nothing was measured that was not actually measured, and the campaign has not promoted a synthesized number as a real one.
- The R1 trust boundary is closed, the executor registry is wired, the controller is written and tested to the dry-run boundary, and the static-I/O boundary admits the new entries. The campaign is ready to run on the rig the moment a bench is available.
- A future maintainer who runs `compare-controller` against a real rig will produce a real `RunArtifact` with per-host digests, a sealed manifest, a verifier verdict, and a renderer report. The evidence pack writes to the policy-mandated `.release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/` path.

## Resume protocol when the bench becomes available

1. Verify the Mac controller can `ping -S 10.99.0.2` from `en8` (no `via` in the route).
2. Verify the Linux bench is reachable via SSH.
3. Run `bun tools/compare/bin/compare-controller.ts --dry-run` first; the dry-run report must show valid routes, well-formed SSH argv, idempotent netem commands, an evidence path inside `OFFICIAL_COMPARISON_OUTPUT_ROOT`, and seven deadlines with hard upper bounds.
4. If the dry-run is clean, run without `--dry-run` for the ticker and bulk scenarios; capture the evidence under `.release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/`.
5. Render the report via `tools/compare/render-report.ts`; the report must include the loop-utilization column for every row.
6. If the rig's behavior diverges from the dry-run, file a deviation record and stop; do not pretend a run happened.
