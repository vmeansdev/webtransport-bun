# Deviation — A5 focused r2 abandoned (campaign-id assert)

**Date:** 2026-08-31  
**Candidate:** `372e6cc97fcc30e196a3fd67c3376939e0ffd37a`  
**Abandoned campaign:** `busyms-attested-focused-r2`

## Discovery

Exact-stage Architect REJECTED: freeze §9.5 fragment hard-asserts
`test "$CAMPAIGN_ID" = busyms-attested-focused-r1` while the stage used `…-r2`.

## Resolution

Abandon r2 roots/keys. Restage under plan-exact `CAMPAIGN_ID=busyms-attested-focused-r1`
on the same candidate HEAD (fresh paths). Plan bytes unchanged.
