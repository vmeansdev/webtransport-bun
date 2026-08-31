# Deviation — A5 Mac supervisor OUTPUT_TRUST_BOUNDARY_UNAVAILABLE

**Date:** 2026-08-31  
**Candidate:** `7440e3b1…` / `busyms-attested-focused-r1`  
**After:** Architect+Critic APPROVED; `EXACT_STAGE_APPROVAL_OK`; staged-dir authority digest now matches `stage-receipt.json`.

## Discovery

```text
mac supervisor spawn failed (SPAWN_BINARY_OPEN_FAILED):
mac supervisor exited 69:
{"code":"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE","schema":"comparison-supervisor-error/v1"}
```

Live mint writes campaign-specific `campaign-authority/v1` (candidate/campaign/
DirectoryIdentity roots + signing key digests). Supervisor bootstrap still
fail-closes with the R1 output-trust-boundary unavailable code — likely schema
or anchor mismatch vs fixture `R1_CAMPAIGN_AUTHORITY` / `R1_CAMPAIGN_AUTHORITY_ANCHORS`.

Cleanup with `--expected-public-key-sha256` succeeded again (campaign private keys absent).

## Next

Align live mint authority bytes with `bootstrap_supervisor` acceptance
(or teach bootstrap to accept live `campaign-authority/v1` + digest FD without
requiring R1 fixture anchors). Then abandon + restage + fresh exact-stage pair.

Plan bytes not edited.
