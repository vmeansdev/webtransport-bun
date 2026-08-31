# Deviation: Clear stale `/tmp/ws-wt-linux-build.*` before each Linux stage build

**Date:** 2026-08-31  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (SHA-256 `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)  
**Phase:** A5 stage-only  

## Defect

Repeated failed stage-only attempts left ~1 GiB build trees under `/tmp/ws-wt-linux-build.*` on a 6.1 GiB tmpfs. The next `cargo`/`build:native` failed with `Disk quota exceeded` while compiling `aws-lc-sys`.

## Fix

At the start of the Linux stage SSH script, remove prior `/tmp/ws-wt-linux-build.*` before `mktemp` of the new build dir. Do **not** delete `/tmp/ws-wt-$CANDIDATE.tar` or `.mac.pub` here — Mac scp's those immediately before the script runs.

The active build dir used for observe-linux / install-minted is recreated and re-recorded under `/tmp/ws-wt-rig-build-<candidate>-<campaignId>`.

## Follow-up

An earlier draft of this fix also deleted the candidate tar/pub and broke extract (`tar: Cannot open`). That line was removed.

## Honesty

Env hygiene only; no admission bypass. Plan bytes unchanged.
