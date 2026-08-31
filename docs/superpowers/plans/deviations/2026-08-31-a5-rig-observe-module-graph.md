# Deviation: Rig observe-linux / install-minted run from retained build tree

**Date:** 2026-08-31  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (SHA-256 `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)  
**Phase:** A5 stage-only  

## Defect

Invoking `$RIG_STAGE/roles/stage-live-campaign.ts` under Bun fails with `Cannot find module '../canonical.ts'` because phase-a may only stage the exact role leaves (`server.ts`, `stage-live-campaign.ts`) — no sibling imports under `roles/`. Plan §9.3 runs observe-linux from the extracted build tree (`tools/compare/bin/...`); the live executor had switched to the roles leaf and broke module resolution after keygen succeeded.

## Fix

- Persist `$RIG_BUILD` to `/tmp/ws-wt-rig-build-<candidate>-<campaignId>` during the Linux build/keygen SSH session (outside `RIG_STAGE`, so DirectoryIdentity / exact role leaves are unchanged).
- Run `observe-linux` and `install-minted` via `$RIG_BUILD/tools/compare/bin/stage-live-campaign.ts`.
- Continue installing the hashed source leaf at `$RIG_STAGE/roles/stage-live-campaign.ts` for digest binding.

## Honesty

No synthetic digests; plan bytes unchanged. Roles leaf set unchanged.
