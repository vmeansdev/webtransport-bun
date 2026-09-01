# Deviation — A5 sealed-artifact anchor verification

**Date:** 2026-09-01
**Candidate:** `f9d0cd54…` (honest 2-PASS run, integrity verify FAIL) → fixed at `cc866b8b…`
**Plan:** unchanged

## Discovery

The `f9d0cd54` focused run completed both 100 MiB transfers and sealed 2 PASS, but
`verify-campaign-index` rejected the seals with a bare `artifact verify failed`.
Offline replay of `verifyRunArtifact` with the verifier's exact context showed the
Ed25519 attestation graph verifying cleanly and eight context/policy rejections
instead: an unknown `verificationContext.externalTrustBoundSha256` field, six
`TRUST_ANCHOR_MISMATCH`es, and `SCENARIO_REPETITION_INVALID`.

Three defects, all of the placeholder-evidence family:

1. `buildRunArtifact` defaulted `sourceSha` / `archiveSha256` / `executableSha256`
   to fixture literals (the executable digest to the SHA-256 of empty input) and
   no campaign caller had an input through which to state the staged truth, so
   every sealed artifact embedded a fixture source identity.
2. `verify-campaign-index` fabricated its trust context — placeholder toolchain
   and sidecar digests, the campaign run id where the artifact seals a per-rep
   run id, and the trust bound smuggled into a context type that has no such
   field behind an `as never` cast. No artifact could ever verify.
3. The scenario repetition check pinned every artifact to the registry's
   `measuredRepetitions`, contradicting plan §"focused and pilot require
   measured index 1 only" for the sealed `{index:1, total:1}` identity.

## Resolution (commit `cc866b8b`)

- The controller resolves `resolveCampaignIndexDigests` once per campaign and
  threads `sourceIdentity` (candidate git SHA, stage-receipt archive digest,
  staged capability digest) through `measureSealAndWriteRep` →
  `buildMeasuredArmArtifact` → `buildRunArtifact`; `persistIndex` reuses the
  same resolution so seal and index row cannot disagree.
- `verify-campaign-index` derives per-rep identity (runId, toolchains, sidecar
  digests) from the artifact via `trustContextForArtifact` and anchors
  `sourceSha` / `archiveSha256` / `executableSha256` on the index's staged
  digests; the failure message names the rejection codes and paths; index
  promotability must match the sealed bytes; promotable entries additionally
  run `checkPromotionQuarantine` against the external trust bound.
- The repetition check accepts exactly `{index:1, total:1}` on focused/pilot
  purpose; canonical stays pinned to the registry policy. The widening is
  monotone — nothing previously accepted is now rejected.

Command-level tests cover the seam forwarding, an end-to-end PASS entry whose
staged anchors match, a swapped staged capability digest being named
(`TRUST_ANCHOR_MISMATCH … executableSha256`), and the repetition shapes.

The `f9d0cd54` seals embed the fixture identity and correctly remain
unverifiable; A5 evidence comes from a fresh staged run at the fixed candidate.

Plan bytes were not edited.
