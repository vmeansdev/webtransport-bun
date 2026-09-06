# Mac binary's evidence for "before readiness" (2026-09-06)

Plan: `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`
Amendment: `docs/superpowers/plans/2026-09-05-cohort-completion-amendment.md`
Slice: RUST (`crates/native/**`), item 1.

## Plan line

Line 2210: "Child replacement policy is exact: after `RAMP_AND_READY`/Phase A
`SERVER_READY`, any child exit is `FAIL/CHILD_LIFECYCLE`; replacement is
forbidden. Before readiness, replacement invalidates all ready state, kills the
entire role cohort and server child, increments `cohortAttempt`, mints fresh
child/cohort nonces and all fresh tokens, sends the new grant to rig, spawns a
fresh server child, and re-runs readiness."

## The deviation

The Mac supervisor binary decides "before readiness" from **its own stage**, not
from child readiness. `MacCohortRuntime::open_cohort`
(`crates/native/src/secure_fs.rs`) admits a replacement while the live session's
stage is `Opened` or `CohortAcceptanceRetained`, and refuses
`COHORT_PROTOCOL` / `Cohort("replacement after readiness")` from
`WarmupEpochIssued` onward.

`RAMP_AND_READY` sits between those two: there is a window in which the role
children have registered and the cohort is ready, but the controller has not yet
asked for the warmup epoch, and in that window the binary would still admit a
replacement.

## Why

The binary has no frame that reports readiness. Its whole Mac request table is
`mac::ack_kind_for` (`crates/native/src/secure_fs.rs:18398`): the cohort open,
the rig cohort acceptance, the warmup epoch, the warmup completion manifest, the
start barrier, the barrier acceptance, the observation and the evidence export,
plus the Phase-A execution open. None carries child readiness, and readiness is
observed over the controller's role-child control FDs, which this process does
not hold.

Adding a `childrenReady` field to `mac-open-cohort-request/v1` would make the
binary's rule depend on a value the **controller** states. The controller is the
party a replacement bound exists to constrain, and a controller that wanted a
third attempt would simply state `false`. A controller-claimed readiness flag
would be weaker than the stage rule, not stronger, so it was rejected rather
than added.

The rule is therefore enforced in two halves, and the plan's guarantee is the
conjunction:

- `MacFanoutSupervisor.replaceCohort` refuses on `anyChildReady`
  (`tools/compare/remote-supervisor.ts:5021-5026`,
  `macFail("CHILD_LIFECYCLE", ...)`), which is exact for `RAMP_AND_READY`
  because that supervisor owns the child control FDs.
- The binary refuses on everything it can itself prove is post-readiness, which
  is the half a lying controller cannot skip.

## Proof

- `supervisor_post_ready_replacement_fails`
  (`crates/native/tests/mac_cohort_runtime.rs`) drives the honest cohort to
  `WarmupEpochIssued` and asserts the replacement is refused
  `Cohort("replacement after readiness")` with the live attempt left at 1.
- Mutation: widening the bound to `live.stage() > MacCohortStage::Exported`
  kills exactly that test.
- `tools/compare/fanout-supervisor-integration.test.ts`'s `past-readiness`
  conformance scenario reaches readiness the same way — presenting a signed rig
  cohort acceptance and asking for the warmup epoch — and requires the scripted
  fixture and a real spawned release `comparison-supervisor` to answer that open
  identically.

## Not deviations

- The binary does not kill role children, spawn a server child or re-run
  readiness on a replacement. Those are the controller's and the rig's; plan
  2210 describes the whole system's replacement, and this slice owns the Mac
  binary's half of it (mint, retirement, bound).
- The refusal code for a post-readiness replacement and for exceeding the bound
  is `COHORT_PROTOCOL`, not `CHILD_LIFECYCLE`. Plan 2295 names
  `FAIL/COHORT_PROTOCOL` for a "replaced-after-ready" entity, and `MacRefusal`
  (`crates/native/src/secure_fs.rs`, `MacRefusal::code`) has no
  `CHILD_LIFECYCLE` member: the binary's §7 table publishes exactly nine codes
  and that is not one of them.
