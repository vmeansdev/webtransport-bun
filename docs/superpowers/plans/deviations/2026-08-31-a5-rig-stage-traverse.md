# Deviation: Linux `$RIG_STAGE/bin` must be executable by `_wtcompare`

**Date:** 2026-08-31  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (SHA-256 `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)  
**Phase:** A5 stage-only  
**Prior:** `2026-08-31-a5-linux-keys-probe.md`

## Defect

Plan §9.3 runs:

`sudo -n -u _wtcompare "$RIG_STAGE/bin/comparison-supervisor" keygen-ed25519 ...`

`RIG_STAGE` lives under `/home/hermes-admin/ws-wt-stage/...`. On the live rig, `/home/hermes-admin` is mode `750` and `ws-wt-stage` / campaign / `bin` are mode `700` owned by `hermes-admin`. `_wtcompare` is not in group `hermes-admin`, so it cannot traverse to the staged binary. `sudo` reports `command not found` even when the file exists and is mode `0755`. Stage-only then failed after a successful cargo build; cleanup returned `70` for the same path reason.

Mac avoids this by installing the supervisor under `/usr/local/libexec/...` (world-traversable). The approved plan freezes the Linux path as `$RIG_STAGE/bin/...`, so the executor keeps that path and opens execute-only traversal.

## Fix

After installing binaries into `$RIG_STAGE/bin`, the Linux stage script now:

- `chmod 711 /home/hermes-admin` (others may traverse, not list)
- `chmod 755` on `ws-wt-stage`, `$CANDIDATE`, `$RIG_STAGE`, and `$RIG_STAGE/bin`
- keeps `staging-root`, `campaign-root`, `incoming`, `replay`, `roles`, and `prebuilds` at `0700`

Keygen/destroy continue to use the plan path `$RIG_STAGE/bin/comparison-supervisor`.

## Honesty

No admission bypass; private keys remain under `/var/lib/webtransport-bun/comparison/keys` mode `0700` `_wtcompare`. Plan bytes unchanged.
