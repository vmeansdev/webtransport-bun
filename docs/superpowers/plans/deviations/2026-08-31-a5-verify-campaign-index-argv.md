# Deviation — A5 freeze verify-campaign-index / render argv

**Date:** 2026-08-31  
**Candidate:** `641c57d5…` (Architect REJECTED)  
**Plan:** unchanged

## Discovery

Exact-stage Architect REJECTED because frozen `upcoming-run-command.sh` invoked
`verify-campaign-index.ts` with plan-copied legacy space-form flags
(`--candidate`, `--external-trust-bound`, positional `$OUT`). The implemented
CLI only accepts equals-form `--campaign-root=`, `--index=`,
`--external-trust-bound-sha256=`, and `--expected-*-count=`. Dry-running the
frozen argv returned usage + exit 2.

The same freeze also passed unimplemented flag soup to
`render-campaign-report.ts`, whose live CLI is positional
`<campaignId> [candidate]` writing `$OUT/report.md`.

## Resolution

`frozen-run-wrapper.fragment.sh` now calls the implemented verifier and
renderer CLIs. Diagnostic/promoted paths copy `report.md` to the plan's
expected report filenames. Plan bytes were not edited.
