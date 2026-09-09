# Deviation: Rig public-key leaf must be hermes-admin-owned for install-minted

**Date:** 2026-08-31  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (SHA-256 `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)  
**Phase:** A5 stage-only  

## Defect

`sudo -n install -m 0644 …/rig.pub "$RIG_STAGE/staging-root/rig-supervisor-ed25519.pub"` created a root-owned leaf. Later `install-minted` (as `hermes-admin`) failed with `EACCES` copying the minted pub over that path. Mint and stage receipt had already succeeded (`MINT_OK`).

## Fix

Install the rig public leaf with explicit ownership:

`sudo -n install -o hermes-admin -g hermes-admin -m 0644 …`

## Honesty

Private key remains `_wtcompare` mode `0400` under `/var/lib/.../keys`. Plan bytes unchanged.
