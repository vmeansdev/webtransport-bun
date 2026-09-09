# Deviation — A5 controller authority digest from stage-receipt.json

**Date:** 2026-08-31  
**Candidate:** `edf3a24d…` / campaign `busyms-attested-focused-r1`  
**Plan:** unchanged

## Discovery

After Architect+Critic APPROVED and `EXACT_STAGE_APPROVAL_OK`, run-only failed:

```text
STAGE_DIGEST_MISMATCH: authority on disk hashes to <live>,
expected <R1_CAMPAIGN_AUTHORITY_SHA256>
```

`resolveStagedAuthorityDigest` only read `live-bootstrap-receipt.json`, while
live `stage-only` writes `stage-receipt.json` with the real `authoritySha256`.

## Resolution

Prefer `stage-receipt.json`, then legacy `live-bootstrap-receipt.json`, then
the R1 pin. Cleanup with `--expected-public-key-sha256` succeeded (campaign
private keys absent; recovery retained until abandon).

Plan bytes were not edited.
