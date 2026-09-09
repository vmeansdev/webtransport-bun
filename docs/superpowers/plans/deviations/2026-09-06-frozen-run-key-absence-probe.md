# Deviation — the frozen run command's campaign-key absence probes

**Date:** 2026-09-06
**Plan:** `2026-08-30-busyMs-attested-fanout.md` — unchanged
**Plan lines:** 2919, 2927 (inside `cleanup_signing_keys`, §9 frozen wrapper), and
the same two probes restated at 3556-3557 (§9.8 recovery re-check).

## Plan text

```
  test ! -e "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
  ...
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" \
    test ! -e "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
```

Plan line 2483 states the intent those probes serve: the wrapper "verifies campaign-key
absences … and exits nonzero if either campaign key remains **or cannot be proven absent**".

## Deviation

`tools/compare/bin/frozen-run-wrapper.fragment.sh` no longer probes with a bare
`test ! -e`. Both probes run as `_wtcompare` — the account that owns the key
directory — through `probe_campaign_key_absence`, which prints `PRESENT` or
`ABSENT`; `absence_rc_for_verdict` maps those to 0/1 and maps *anything else*
(the probe itself could not run) to 2, which is a cleanup failure, never an
absence. The `CLEANUP_FAILED` line now carries the two verdicts.

## Reason

Both key directories are mode 0700 owned by `_wtcompare`. Neither the Mac
operator account nor the rig ssh account can traverse them, so the plan's probe
answers "absent" whether or not the key is there: a constant in the shape of a
proof, and the failing half of the very requirement plan line 2483 states.

## Proof

Proved by contradiction on the rig during the A5 staged campaign: as
`hermes-admin`, `test ! -e <rig key>` reported absent while
`sudo -u _wtcompare test -e <rig key>` reported present, for the same path at the
same moment.

Proved again by execution, in `tools/compare/bin/stage-live-campaign.test.ts`
(`describe("frozen run command: campaign key absence is proved, not assumed")`),
which runs the generated `cleanup_signing_keys` under recorded `sudo`/`ssh`
stubs: `runs_both_absence_probes_as_the_account_that_owns_the_key_directory`
asserts the argv crosses to `_wtcompare` on both sides, and
`fails_cleanup_when_a_probe_cannot_prove_absence` asserts a probe that returns
no verdict yields cleanup status 70. Restoring either plan-form probe turns both
tests red.

The §9.8 recovery re-check at plan lines 3556-3557 is operator text, not a
generated fragment; it has the same defect and the same fix applies when it is
run by hand (`sudo -n -u _wtcompare test -e …`). Nothing in this slice generates
those two lines.
