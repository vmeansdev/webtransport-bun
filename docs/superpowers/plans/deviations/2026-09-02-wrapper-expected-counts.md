# Deviation — frozen run wrapper argv additions beyond plan §9

**Date:** 2026-09-02
**Candidate:** `1622c363…` (plus the public-key flags added this session)
**Plan:** unchanged — `2026-08-30-busyMs-attested-fanout.md` §9.5-§9.7

Plan §9 shows the wrapper's verifier and renderer calls at a level of detail the
implemented CLIs do not match. `2026-08-31-a5-verify-campaign-index-argv.md`
recorded the equals-form flag correction. The additions below landed afterwards
in `tools/compare/bin/frozen-run-wrapper.fragment.sh` and had no deviation
record; this file is that record. Plan bytes were not edited.

## 1. `--integrity-only` on the integrity attempt

The failure-path attempt runs the verifier with `--integrity-only` and with **no**
`--expect*` flag at all. An integrity attempt proves bytes; it reports zero
promotable, cannot move a campaign's status and cannot complete a canonical
claim (§6/§11). Carrying a count expectation there would let a failed run assert
a count a successful run owns.

Covered by `integrity_attempt_is_integrity_only_and_success_path_is_not` in
`tools/compare/bin/stage-live-campaign.test.ts`.

## 2. Flat-filter parity with the verifier

The wrapper's promoted-path flat count excludes exactly the verifier's
`RUN_CONTROL_FILENAMES` plus sealed artifacts —
`campaign-index.json`, `manifest.json`, `controller-terminal.json`,
`*.sealed.json`. Counting `controller-terminal.json` made a clean canonical run
count 13 flats against the verifier's 12 and fail on the wrapper.

Covered by `wrapper_flat_count_excludes_the_controller_terminal_record`.

## 3. `--expected-sealed-count` per section

The success-path verifier call states the section's sealed count as well as its
pass count: 2 for §9.5 and §9.6, 60 for §9.7. Pass count alone counts index rows;
sealed count counts artifacts on disk, and a run that wrote fewer sealed files
than it recorded rows is exactly the disagreement the pair exists to catch.

Covered by `success_verification_states_the_per_section_expected_counts`.

## 4. Canonical-completion flag only on §9.7

`--expect-canonical-fanout-complete` is passed only when the section fragment
sets `EXPECT_CANONICAL_FANOUT_COMPLETE=1`, i.e. §9.7. Only the canonical section
claims the complete observed fanout topology, so the flag is a per-section fact
and never a wrapper-level constant. §9.5 and §9.6 must not carry it.

Covered by the same test (`not.toContain` for focused and pilot).

## 5. `--mac-public-key` / `--rig-public-key` on the success path (new this session)

The success-path verifier call now also passes:

```
--mac-public-key="$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub"
--rig-public-key="$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub"
```

Leaf names are `stage-live-campaign.ts`'s
(`STAGED_MAC_PUBLIC_KEY_LEAF` / `STAGED_RIG_PUBLIC_KEY_LEAF` in
`cross-supervisor-protocol.ts`), under the staging root the pre-run gate already
digest-checks against the stage receipt.

Without both, `verify-campaign-index.ts` builds no `AttestationTrustMaterial`:
it parses the attestation records and verifies **no signature** over them, so the
R6 signature graph is never opened and the verification is a count check wearing
a trust check's name. The verifier refuses one flag without the other, so the
absent case — not the half case — is what this closes.

The integrity attempt deliberately does **not** pass them, for the same reason as
item 1.

Covered by the new
`success_verification_opens_the_signature_graph_with_both_staged_leaves`, which
asserts both flags on the success invocation for §9.5/§9.6/§9.7 and neither on
the integrity invocation.
