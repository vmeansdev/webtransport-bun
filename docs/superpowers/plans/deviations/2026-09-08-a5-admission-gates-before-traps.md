# Deviation — A5 frozen command: admission gates before the EXIT trap

**Date:** 2026-09-08  
**Candidate:** `80593b2b…` (twelfth stage, Architect and Critic both CHANGES REQUIRED)  
**Plan:** unchanged (base plan §9.5 wording "the EXIT trap always destroys both private keys")

## Discovery

The frozen `upcoming-run-command.sh` was launched before
`exact-stage-approval.json` existed. `verify-stage-approval` exited 3 under
`set -e`; the already-armed EXIT trap ran `cleanup_signing_keys`, and both
campaign private keys were destroyed on both hosts. The stage had to be
abandoned and restaged with a fresh review pair. Rig `journalctl` shows the
`destroy-signing-key … --missing=ok` at 2026-09-08T06:53:37Z, the same second
as the refused attempt's `integrity-only/attempt-marker.txt`.

The same refused attempt also wrote a meaningless integrity record
(`Module not found "tools/compare/bin/verify-campaign-index.ts"`) because
`finalize_terminal_integrity` used a repo-relative verifier path while the
pre-run gates run before the section's `cd "$REPO"`.

## Resolution

`frozen-run-wrapper.fragment.sh`:

- The three read-only admission gates (staged public-leaf re-hash, validity
  window, `verify-stage-approval`) now run BEFORE the traps are armed. A
  refusal there is administrative, leaves the staged keys intact, and the same
  frozen bytes can be launched again once the approval exists. Every exit path
  after admission still destroys both keys, as the plan requires.
- Both `verify-campaign-index.ts` invocations use `"$REPO/…"`, so the
  integrity record is honest whether or not the section has changed directory.

Proved by execution in `stage-live-campaign.test.ts` ("frozen run wrapper
admission gates"): with real traps and recorded `sudo`/`ssh` stubs, a missing
approval exits nonzero with zero key-destruction calls and no integrity dir; a
controller failure after admission still probes and destroys both keys. On the
previous fragment bytes, three of the four tests are red.
