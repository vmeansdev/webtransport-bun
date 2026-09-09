# Deviation — B6 verifier recomputes the external trust bound

**Date:** 2026-09-09  
**Candidate:** `1b9e8092…` (B6 exact-stage Architect and Critic: CHANGES REQUIRED)  
**Plan:** unchanged

## Discovery

Both B6 exact-stage reviews found that the frozen 9.7 verifier could not pass a
correct run. `verify-campaign-index.ts` gated every `promotable:true` index
entry on `checkPromotionQuarantine`, which appended
`EXTERNAL_TRUST_BOUND_UNVALIDATED` to every supplied bound ("opaque until the
external run/lock schema validates it") and returned promotable only with no
reasons. Every measured PASS seal of a canonical campaign is `promotable:true`,
so the first seal opened would have refused after all 72 executions, the
wrapper would have written an integrity-only record and destroyed both campaign
keys. The call landed at `cc866b8b` with no positive test; A5 and B5 carry only
`promotable:false` entries, so the branch had never executed.

The bound itself (`external-trust-bound/v1`) is minted at stage time over the
candidate, campaign id, authority, capability, lock and archive digests, both
supervisors' signing leaves, and both directory identities, and frozen into the
run command as `--external-trust-bound-sha256`. The verifier held six of those
ten fields (the index's candidate, campaign, capability and archive; the two
leaves it is handed by flag) and had no path to the other four.

## Resolution

- The preimage and its encoder live once, in `cross-supervisor-protocol.ts`
  (`externalTrustBoundSha256`); the live mint and the test-only receipt fixture
  both call it. The encoder reproduces the B6 receipt's `161e27a3…` and the B5
  receipt's bound byte for byte.
- `verify-campaign-index.ts` gains `--stage-receipt=<path>`. With both leaves it
  recomputes the bound from the index's anchors, the leaves' digests and the
  receipt's authority, lock and directory-identity digests, holds the receipt's
  copies of the shared fields to the verifier's own, and refuses the whole index
  with `EXTERNAL_TRUST_BOUND_MISMATCH` when anything disagrees. A canonical
  index with promotable entries and no receipt is refused with
  `EXTERNAL_TRUST_BOUND_UNVALIDATED` before any seal is opened.
- `checkPromotionQuarantine` takes an optional `externalTrustBoundValidation`
  and lifts `EXTERNAL_TRUST_BOUND_UNVALIDATED` only when its `sha256`,
  `recomputedSha256` and the bound are one digest. An arbitrary marker stays
  unvalidated; the other callers (`run-campaign.ts`, `bin/verify-artifact.ts`,
  `render-report.ts`) pass no validation and keep their fail-closed answer.
- `frozen-run-wrapper.fragment.sh` passes
  `--stage-receipt="$MAC_TRUST/stage-receipt.json"` on the success verification
  beside the two leaves, for every section. The integrity-only attempt is
  unchanged: it proves bytes and promotes nothing.

The frozen argv therefore differs from plan §9.5 by one more flag than
`2026-08-31-a5-verify-campaign-index-argv.md` recorded. Plan bytes were not
edited. B6 must be restaged from the fixed head; this stage's root is abandoned.
