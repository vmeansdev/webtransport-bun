# Deviation: Linux staging identity probe must run as `_wtcompare`

**Date:** 2026-08-31  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (SHA-256 `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)  
**Phase:** A5 stage-only retry after Mac `_wtcompare` provision  

## Defect

`checkRigStagingIdentity` used bare `test -d /var/lib/webtransport-bun/comparison/keys` over SSH as `hermes-admin`. The parent `comparison/` directory is mode `0700` owned by `_wtcompare`, so the operator cannot traverse it even when the keys directory exists and passwordless `sudo -n -u _wtcompare` works. Stage-only therefore exited `65` / `REFUSED/STALE_OR_INVALID_STAGING` with a false "keys missing" detail that included only the successful `id` stdout.

## Fix

Probe the keys directory as `_wtcompare`:

`sudo -n -u _wtcompare test -d /var/lib/webtransport-bun/comparison/keys`

Mac identity check already only requires `id` + passwordless sudo (it does not bare-`test` the 0700 Mac keys path).

## Honesty

Keys were already provisioned on the rig; this is not an admission bypass. Plan bytes unchanged.
