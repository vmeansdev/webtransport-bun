# Deviation — the rig lease's janitor unit is not present after stage-only

**Date:** 2026-09-08  
**Candidate:** every phase-b stage from `efaed8bb…` onward (the armed
`fanout-pilot-r1` stage and its successors)  
**Plan:** `2026-08-30-busyMs-attested-fanout.md` §9.3 (stage-only "arms a
`_wtcompare` lease janitor bound to `(candidate, campaignId,
rigPublicKeySha256, notAfterMs)`; it deletes the rig key at expiry even with
no controller") and the `RigSigningKeyLeaseV1.janitorUnit` field at plan
line 2540; recorded by the physical-budget amendment D6

## Discovery

`stage-live-campaign.ts stage-only` writes the lease record with
`janitorUnit: "wtcompare-rig-key-janitor@<candidate>-<campaignId>.service"`
(`tools/compare/bin/stage-live-campaign.ts:1327`) and nothing else. No code
in the repository installs, starts or checks that unit: `grep -rn
wtcompare-rig-key-janitor` over `tools/`, `ops/`, `scripts/` and the docs
finds the lease field and the plan's interface and nothing more, and the rig
after a stage-only has no such systemd unit. The lease names a janitor that
does not exist, so the `armed → expired-deleted` transition on "janitor
expiry" (plan 2644) never happens on its own.

## What holds instead

Expiry is enforced by `notAfterMs` checks only, on every path that could use
the key:

- the frozen run wrapper refuses admission unless
  `STAGE_NOT_AFTER_MS − now > RUN_TIMEOUT_MS + 5,400,000`
  (`frozen-run-wrapper.fragment.sh:480-481`), so a run cannot start inside
  the last six hours of a stage's validity;
- the rig supervisor refuses an expired receipt (`RIG_RECEIPT_EXPIRED`) and
  every minted rig record carries its own `notAfterMs`;
- every exit path of the wrapper after admission destroys both campaign
  private keys on both hosts, and `stage-live-campaign.ts abandon` destroys
  them for a stage that never ran (the operator step D5 names for the armed
  `fanout-pilot-r1` stage).

What is lost is only the unattended deletion of a key whose stage was never
launched and never abandoned: such a key sits on the rig, useless to any
signer because every record it could sign states a `notAfterMs` the
verifiers refuse, until the operator abandons the stage.

## Resolution

Recorded, not fixed, in this amendment: the janitor is an operational unit
on the rig, outside the source tree, and installing it is not part of any
slice here. The lease's `janitorUnit` field keeps its name so the record's
key set does not move; a later change that installs the unit closes this
deviation without touching the record.
