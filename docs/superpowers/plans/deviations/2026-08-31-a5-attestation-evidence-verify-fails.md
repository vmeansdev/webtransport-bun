# Deviation — A5 seal attestation evidence verify fails

**Date:** 2026-08-31
**Candidate:** `f9d0cd54` (fresh A5 stage-only re-run)
**Plan:** unchanged (Plan SHA `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)

## Discovery

Honest A5 focused re-run on `f9d0cd54` with all prior architect/critic
gates green, `EXACT_STAGE_APPROVAL_OK`, and live `run_measured_campaign`:

```
EXACT_STAGE_APPROVAL_OK
controller: mac supervisor pid=12896 (control pipes ready)
controller: rig supervisor pid=13056 (ssh control channel ready)
controller: seal PASS bulk-one-way/physical/ws  rep 1 p50=938.47552
controller: seal PASS bulk-one-way/physical/wt  rep 1 p50=351.97156
controller: focused index finalized under .release-evidence/.../busyms-attested-focused-r1 with zero flats (2 PASS / 2 index entries)
controller real-run: ok, evidence at .../reps/bulk-one-way_physical/wt/rep-1.sealed.json
TRUST_PROTOCOL: artifact verify failed for .../reps/bulk-one-way_physical/ws/rep-1.sealed.json
```

Both seals completed the 100 MiB Linux-to-Mac transfer, both index
entries record `status: "PASS"` with `sealedPath` and a real
`artifactSha256` (the new `9c3b18f8` + `f9d0cd54` fixes are honored),
zero flats were written (focused), and `serverAggregate` is the only
non-busy transparency. The seal files on disk match the
`artifactSha256` in the index. Yet the `verify-campaign-index` rejects
the seal with `TRUST_PROTOCOL: artifact verify failed` because the seal
attestation graph does not verify.

## A5 stop gate

Plan §8.A5 stop gate: "exactly two indexed measured primary PASS
entries, both `promotable:false`; zero FAIL/REFUSED; zero flats."

The honest measurement ran (2 PASS, 0 FAIL/REFUSED, 0 flats), but the
integrity verifier rejects the seal attestation. Stop gate is **not**
met. Phase B must not start.

## Root cause (initial)

`verify-campaign-index` (line 348) calls into the seal's
`attestationEvidence` verifier and gates on
`verification.evidenceStatus !== "PASS"`. The WS seal in
`.release-evidence/transport-comparison/f9d0cd54…/reps/bulk-one-way_physical/ws/rep-1.sealed.json`
contains a full Mac/rig cross-supervisor graph (MacExecutionGrantReceipt +
RigExecutionAcceptance + RigServerSnapshotReceipt + MacMeasurementAdmissionReceipt),
so the rejection is not "missing edge" — it is one or more of:

1. A signature bytes ↔ signed-bytes SHA mismatch inside one of the
   embedded receipts.
2. A `signingPublicKeySha256` not matching the staged Mac/rig leaf.
3. A `crossSupervisorExecutionV1` join (Mac grant vs rig acceptance)
   failing on `executionSha256` / `scenarioHash` / `rolePlanHash`.
4. A Mac measurement admission referencing a `macExecutionGrantReceipt`
   that the verifier cannot reach through the local index.

Full diagnostic decode of the WS seal and per-receipt signature
verification is the next step (no live campaign can be promoted until
it passes). Plan bytes are unchanged.

## Resolution path (out of A5 scope)

This is a seal-side wire graph defect in the A3 cutover, not a Phase A
trust contract issue. Until every embedded Mac and rig signature
verifies against the staged public keys, the campaign index cannot be
admitted by `verify-campaign-index`. Remediation must precede the
next A5 focused retry. Plan bytes are unchanged.

## Honest evidence retained

- Run log: `.release-evidence/transport-comparison/a5-focused-run-20260901T094251.log`
- Campaign index: `.release-evidence/transport-comparison/f9d0cd54…/busyms-attested-focused-r1/campaign-index.json`
  (`0 FAIL, 2 PASS, 0 REFUSED, 0 promotable, 0 flats`, but verifier rejects
  seal evidence).
- Sealed artifacts: `…/reps/bulk-one-way_physical/{ws,wt}/rep-1.sealed.json`
  (real Ed25519 cross-supervisor graph, real attested bulk completion).
- Staged bytes (mode 0444) under
  `.release-evidence/transport-comparison/.trust-staging/f9d0cd54…/busyms-attested-focused-r1/`.
- Architect + Critic APPROVED at
  `f9d0cd54…/exact-stage-architect-review.md` and
  `exact-stage-critic-review.md`.

## Theater-check

This is not theater: real Mac↔rig control channels came up, real
transfer of 100 MiB Linux-to-Mac completed for both arms, real
attestation evidence was produced, the campaign index was honestly
written with 2 PASS entries and zero flats, the EXIT trap ran
cleanup, and the integrity verifier returned the correct
non-zero summary identifying the attestation graph as invalid. No
fixture-minted artifacts were promoted, no campaign root was re-rooted
for a new HEAD to claim a fake success.
