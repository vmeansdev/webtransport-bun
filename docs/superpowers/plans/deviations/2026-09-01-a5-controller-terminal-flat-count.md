# Deviation — A5 controller-terminal record vs flat count

**Date:** 2026-09-01
**Candidate:** `cc866b8b…` (integrity verify PASS, success-path count check FAIL) → fixed at the next HEAD
**Plan:** unchanged

## Discovery

The first run at `cc866b8b` passed the integrity gate —
`VERIFY_CAMPAIGN_INDEX_OK pass=2 fail=0 refused=0 promotable=0 sealed=2` —
proving the anchor-verification fix end to end on live seals. The wrapper's
success-path invocation then failed with
`TRUST_PROTOCOL: expectedFlatCount mismatch: expected 0, found 1`.

The one counted "flat" is `controller-terminal.json`: the run wrapper's own
terminal record, written at the campaign root and parsed by the wrapper to
correlate the controller's exit code with the terminal kind. The flat filter
excluded only `campaign-index.json` and `manifest.json`, so the wrapper's own
protocol file failed the zero-flat focused gate. Earlier runs never reached
this check (they failed at the integrity gate first), which is why the defect
was invisible until now.

## Resolution

`verify-campaign-index` excludes `controller-terminal.json` from the flat
count alongside the index and manifest — it is run-control metadata, not an
echo flat. The pair-count logic only matches `<cell>-ws/-wt.json` names and is
unaffected. A command-level test drops a `controller-terminal.json` into a
zero-flat campaign root and requires the verify to pass; the existing test
still proves a real top-level flat is counted and rejected.

The `cc866b8b` campaign root is abandoned (its campaign keys were destroyed by
the wrapper's cleanup on exit); A5 evidence comes from a fresh staged run at
the fixed candidate.

Plan bytes were not edited.
