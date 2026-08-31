# Deviation — A5 Mac supervisor hardLinkCount drift after mint

**Date:** 2026-08-31  
**Candidate:** `9df12e63…` / `busyms-attested-focused-r1`  
**Plan:** unchanged

## Discovery

After Architect+Critic APPROVED and fail-closed `EXACT_STAGE_APPROVAL_OK`,
focused run-only failed immediately:

```text
mac supervisor spawn failed (SPAWN_BINARY_OPEN_FAILED):
mac supervisor exited 69:
{"code":"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE","schema":"comparison-supervisor-error/v1"}
```

Live authority field sets matched Rust. Re-observation showed DirectoryIdentity
`hardLinkCount` drift on APFS after mint wrote final leaves:

| root | sealed | live after mint |
|------|--------|-----------------|
| mac-campaign | 2 | 8 |
| mac-staging | 6 | 8 |

Supervisor bootstrap matches identity field-for-field, so the seal was already
stale before traffic. Cleanup traps destroyed campaign private keys.

## Resolution

Before DirectoryIdentity observation, mint creates empty placeholders for every
final campaign-root and staging-root leaf, then overwrites those same paths.
Leaf cardinality (and thus APFS nlink) stays stable across seal and bootstrap.

Plan bytes were not edited.
