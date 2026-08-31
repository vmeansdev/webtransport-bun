# Deviation — A5 fail-closed verify-stage-approval

**Date:** 2026-08-31  
**Candidate:** `ed95c435…` (Architect REJECTED) → next HEAD after this fix  
**Plan:** unchanged

## Discovery

Exact-stage Architect REJECTED `ed95c435` / `busyms-attested-focused-r1` because
`verify-stage-approval` only checked that three paths existed, then printed
`EXACT_STAGE_APPROVAL_OK`. Plan §9 requires recomputing receipt/command/record/
review digests, validating `APPROVED` first lines and binding labels, verifying
HEAD, and checking DirectoryIdentity before traffic.

## Resolution

`verifyExactStageApproval` now:

- recomputes stage-receipt, upcoming-run-command, both review, and approval-record
  digests (record has no self-hash field);
- parses ExactStageApprovalV1 and binds receipt plan/approval/profile/campaign/HEAD;
- requires each review's first line `APPROVED` and unique labels for Stage receipt
  SHA-256, Upcoming run command SHA-256, Candidate HEAD, Worktree, Campaign ID;
- checks `git rev-parse HEAD` in the bound worktree;
- re-checks Mac staging-root via `observe-directory-identity` against authority
  `mac-staging` identity; revalidates linux-stage-observation digest/identity.

**APFS hardLinkCount:** mint seals DirectoryIdentity before capability/launch
leaves are written. On APFS, directory `nlink` rises when those files appear, so
exact hardLinkCount equality would always fail pre-traffic. Same-root proof uses
platform + inode + device (+ volumeUuid on Darwin / deviceMajor+Minor on Linux)
and ignores hardLinkCount drift.

Plan bytes were not edited.
