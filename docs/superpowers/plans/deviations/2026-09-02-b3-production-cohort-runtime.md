# B3 production cohort runtime — reviewed deviation

**Date:** 2026-09-02
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`
**Plan bytes:** unchanged. Nothing in this deviation edits the plan, the approval
record, or `.release-evidence/`.
**Baseline:** worktree `ws-scenario-comparison`, HEAD `2fec7de6`.

---

## 1. Discovery

The B5 exact-stage Critic found that the staged controller could not reach the
cohort executor at all. The dispatch was wired at `2fec7de6`, and that wiring
exposed the real shape of the gap: `realRunBody`'s `cohortRuntimeProvider` was
`undefined`, because **no production cohort runtime existed anywhere in the
tree**.

A gap map verified at HEAD found, on every side of the lifecycle:

| Seam | State at `2fec7de6` |
|---|---|
| `CohortRigBinding` (10 methods) | zero production implementers; only `refusingBinding()` in `fanout-executor.test.ts` and an ad-hoc Linux side in `fanout-supervisor-integration.test.ts` |
| `FanoutLinuxAuthority` | missing `registerRolePeers`, `runWarmupWire`, `measureStartAck`, `runMeasuredWindow`; `startServer` arity mismatch |
| `server.ts` fanout mode | `serveFanoutCohortRelay` had no production caller; `import.meta.main` handled only `bulk-one-way` and `echo`; no fanout mode reachable from argv or env |
| controller ↔ rig wire | `remote-supervisor.ts` emitted only the seven Mac-side acks; **zero** `rig-*` frame kinds appeared anywhere in it |
| Rust rig | `validate_cohort_record` / `apply_cohort_record` existed but were never called from `serve()`; an in-file comment said the binary "still does not speak the cohort protocol" |
| sealer | `ArmMeasureInput.cohortEvidence` and `cohortEvidenceFromExportAck` existed; **no non-test caller constructed `cohortEvidence`**, and the `CohortRateSeriesV1 -> MeasuredLeg` projection was absent |

This is the `placeholder-evidence` family in its structural form: a whole
lifecycle of schemas, validators and codecs with no producer behind them.

## 2. What the plan asked for

B3 (plan lines 2435–2456), on the entrypoint:

> Implement Mac-owned 10+8/1+8 spawn, direct control FDs plus sealed read-only
> token FD 5, one publisher+subscriber total-ordinal permit scheduler, role
> child entrypoint, pre-readiness replacement, Linux verification of signed
> cohort/warmup/barrier before each transition, rig-signed
> accept/start/barrier/snapshot/relay records, Linux observation,
> controller-to-Mac authenticated rig receipt presentation, raw evidence export,
> aggregation, and bounded reap **behind a non-production integration
> entrypoint**.

That clause is the deviation's origin. B3 deliberately built the machinery
behind a non-production entrypoint; B4 was to make the selection production. The
Critic's finding is that the step from "non-production integration entrypoint"
to "a production caller" was never taken on any of the six seams above, so B5's
stop gate is unreachable.

§5 (plan lines 2153–2211) fixes the transitions this runtime has to carry:

> 4. Phase B only: `COHORT_GRANTED`: Mac spawns role children, mints the token
>    leaf manifest and signed pre-readiness grant; controller transfers exact
>    grant+signature to rig; rig authenticates it, signs its acceptance, and
>    controller presents acceptance+signature back to Mac.

> 6. Phase B only: `RAMP_AND_READY`: subscribers then publishers register under
>    global ordinal permits; Linux validates every token […]

> 7. Phase B only: `IN_REPETITION_WARMUP`: […] Every publisher offers exactly ten
>    paced frames and every subscriber worker proves its exact expanded delivery
>    count.

> 8. `LINUX_BASELINE`: […] **No measured traffic is legal before this ack.**

> 15. `ASSEMBLY`: after all I/O is complete, synchronous `measuredLegToArm`
>     consumes immutable validated bytes.

## 3. What was built, per piece

Five slices worked the gap map in parallel. Each recorded its own
out-of-slice findings under `.scratch/b35-notes/`; all five notes were read and
their claims re-verified by execution before this document was written.

- **Sealer** (`arm-measure.ts`, +462/−1): `projectCohortEvidenceToMeasuredLeg`
  and `measuredCohortToArm` — the §4.5 `CohortRateSeriesV1 -> MeasuredLeg`
  projection, with every field sourced from the cohort ledger, capacity record
  or process proof and **no invented values**. `cohort-seal.test.ts` (new, 1112
  lines) seals an honest ticker-10k fixture.
- **Linux authority** (`scenarios/fanout-relay.ts`, +519): the four missing
  `FanoutLinuxAuthority` methods plus the `startServer` arity fix; `server.ts`
  (+178) gained a real `--mode=fanout-cohort` branch and
  `FANOUT_COHORT_SERVER_ENV_NAMES`; `stage-live-campaign.ts` (+10/−2) stages the
  phase-b argv.
- **Controller ↔ rig wire** (`cross-supervisor-protocol.ts` +278,
  `remote-supervisor.ts` +972): `CohortRigChannel`, the eight rig cohort
  frames, and exact-key parsers for six Phase-A rig kinds.
- **Rust rig** (`secure_fs.rs` +1427, `comparison-supervisor.rs` +440): a
  `cohort::rig` submodule, `ack_kind_for`, and a `serve()` dispatch arm for the
  five controller → rig cohort request kinds.
- **Controller runtime** (`bin/compare-controller.ts` +782):
  `CohortChannelRigBinding`, `createCohortArmRuntimeProvider`,
  `sealCohortArmRepetition`, and the `dispatchArmRepetition` routing that
  refuses a fanout primary rather than demoting it to a single-session leg.

Two reviewed sub-deviations, both recorded by their slices and both re-verified
here:

- `tools/compare/cohort-seal.ts` and `tools/compare/cohort-rig-binding.ts` were
  **not created**. A new production `.ts` under `tools/compare` is an
  unclassified file (`ALLOWLIST_EXTRA_FILE`), and the slices' rules made the
  allowlist gate-owned. Both bodies went into modules that already own the
  surrounding types. Verified: the audit key set is byte-identical with and
  without the work.
- A canonical-encoding defect family was found and fixed inside the controller
  slice: `sha256HexOfCanonical` used `canonicalJson` where the protocol digests
  cover `canonicalRecordBytes` (which terminates with a newline). This made
  `driveCohortArm` refuse **its own terminal export** with
  `CROSS_SUPERVISOR_MISMATCH` on every cohort. No test reached the export step,
  which is why it was invisible.

## 4. The e2e test as the new guard

`tools/compare/fanout-production-e2e.test.ts` (new, 11 tests) is the guard the
gap map had no equivalent of. Every other cohort suite injects the missing half
— a stub runtime, an in-process binding, a hand-built harness — and a suite that
supplies the missing half cannot observe that it is missing. This one supplies
nothing:

- `dispatchArmRepetition` with the **production** provider
  (`createCohortArmRuntimeProvider`, built as `realRunBody` builds it) and the
  **production** executors (no `executors` override);
- a real `bun tools/compare/server.ts --mode=fanout-cohort` child process,
  launched from `stagedServerLaunchArgv` — the argv the campaign actually
  stages;
- a real locally built `comparison-supervisor`, booted through the real trust
  bootstrap by the production `spawnMacSupervisor` and spoken to over the real
  `comparison-supervisor-frame/v1` codec.

Topology: `ticker-fanout/rate-10000` — the frozen "ticker 10k" cell, 1
publisher / 8 workers / 100 subscribers / 101 sessions / 100,000 measured
ingress / 10,000,000 expanded deliveries, both arms. The reduction versus B5 is
in the *rung*, not the shape.

**The test asserts refusal boundaries, not the mandated PASS assertions**, and
that is the finding. Section 6 below records what it proved instead, and each
assertion in the file names the expectation it becomes when production is
complete — so the file goes red the day the hole is filled, and red today if
anyone fabricates a way past it.

Mutation-proven: replacing the cohort routing condition in
`dispatchArmRepetition` with `if (true)` (demoting every fanout primary to the
single-session leg) turns 3 of the 11 tests red. Source restored byte-identical.

## 5. Inventory classification

`official-io-allowlist.json` gained exactly one line:
`fanout-production-e2e.test.ts` under `controllerTestTs`. That is the documented
bucket for a test that pins the controller's own surface — the same
classification `fanout-executor.test.ts` and `fanout-supervisor-integration.test.ts`
carry — and it is a classification, not an exemption. Verified on a
`git archive` clean tree with real `node_modules`: 136 findings before, 136
after, **identical normalized key sets**.

## 6. Residuals — production cannot yet measure an honest cohort

Recorded here because they are the reason B5's stop gate is unreachable, not
because they are this deviation's to fix. Each was proved by execution against
real processes, not by reading source.

1. **Frame-kind divergence, session-fatal (new finding).**
   `encodeRemoteSupervisorPayload` writes the frame `kind` as the schema with
   `/v1` stripped (`headerKindFromSchema`), so the controller sends
   `kind: "rig-accept-cohort-request"`. The rig matches the suffixed form
   (`cohort::rig::ack_kind_for` takes `"rig-accept-cohort-request/v1"`). Every
   cohort frame the production controller can encode falls through `serve()` to
   `_ => terminate("TRUST_CHILD_FRAME_INVALID")` — a fatal end of session, not a
   refusal. **The controller ↔ rig cohort wire cannot carry a single frame.**
2. **Refusal-codec divergence (new finding).** At an agreed kind, the rig
   answers a refused transition with an `admission-refusal` frame carrying
   `measurement-refusal/v1`; `CohortRigChannel` understands only
   `remote-supervisor-refusal/v1`. The controller reports a decode failure and
   never learns the rig's code, so an operator cannot distinguish "the rig has
   no cohort runtime" from "the wire is corrupt".
3. **No Mac cohort supervisor lease.** `MacCohortMinter`,
   `MacFanoutChildSpawner` and `MacFanoutProcessControl` have no production
   implementer, so the runtime provider refuses `COHORT_NOT_READY`.
4. **No signed-grant channel to the server child.** `server-bind-execution/v1`
   carries `cohortGrantBase64` and no signature field, so
   `server.ts --mode=fanout-cohort` refuses before binding a listener.
5. **`install_cohort_runtime` has no production caller.** Its only call site is
   inside the binary's own `cohort_dispatch_tests`; `serve()` needs a signing-key
   fd, the staged Mac public key, and a Phase-A rig binding that does not exist.
6. **`run-campaign.ts` drops `cohortEvidence`.** `buildMeasuredArmArtifact`
   forwards every measurement field except the cohort export, so for the six
   fanout primaries `buildRunArtifact` throws
   `COHORT_OBSERVATION_EVIDENCE_MISSING`. Fix: add
   `readonly cohortEvidence?: ArmCohortEvidenceV1` to `ArmMeasurement` and pass
   it through.
7. **`rig-measure-start-ack/v1` has no controller ↔ rig frame.** The rig mints
   and retains it; no frozen frame carries it to the Mac, so
   `cohort-start-barrier/v1` can never be minted honestly in the remote
   topology. Needs a B1 registry edit.
8. **`server-warmup-ready/v1` has no key set anywhere.** One registration line,
   no producer and no parser.
9. **No role-child control-pipe reader.** `runWarmupWire` and
   `runMeasuredWindow` refuse because `role-warmup-complete/v1` and
   `role-partial/v1` have parsers but no producer and no consumer.

Residual on the test itself: assertions 1–2 of the mandate (both arms seal PASS;
`verifyRunArtifact` PASS over a reconstructed `CohortObservationEvidenceV1`) and
the issuer-signature-graph and promotable-entry assertions are **not** made,
because no artifact can be produced to make them against. The closest real
boundary is asserted in each case, and `verifyCampaignIndex` is driven to prove
that the wrapper-style expectation (2 PASS / 0 promotable / 0 flats / 2 sealed)
is **not** satisfiable by this run, while the honest counts (0 PASS / 2 FAIL /
0 sealed) are.
