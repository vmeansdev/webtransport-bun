# Deviation: the rig's post-readiness replacement refusal is `CHILD_LIFECYCLE`, not `COHORT_PROTOCOL`

Date: 2026-09-06
Author: the integration gate
Files: `crates/native/src/secure_fs.rs`, `crates/native/tests/rig_cohort_runtime.rs`

## The plan line

`docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md:2295`

> | Missing/extra/**replaced-after-ready** child, role, shard, subscriber,
> publisher, duplicate PID/nonce | `FAIL/COHORT_PROTOCOL` |

and `:2210`

> Before readiness, replacement invalidates all ready state, kills the entire
> role cohort and server child, increments `cohortAttempt`, mints fresh
> child/cohort nonces and all fresh tokens, sends the new grant to rig, spawns a
> fresh server child, and re-runs readiness. [...] At most one pre-readiness
> cohort replacement is allowed; a second failure is terminal.

## What this change did

`RigCohortSession::teardown_server` now accepts `rig-teardown-server-request/v1`
from `RigCohortStage::ServerSpawned` as step 1 of plan 2210's replacement (the
frame the controller already sends there, `bin/compare-controller.ts:5621`),
retires the cohort through `CohortOwner::retire_before_ready`, and returns the
session to `AwaitingGrant` so `accept_cohort` can install the replacement grant
and `spawn_server` can start a fresh server child. That part is the plan line,
implemented; it is not the deviation.

## The deviation

When that frame arrives at `ServerSpawned` but the cohort has **already reached
readiness**, the rig answers
`CohortRefusal::ChildLifecycle("replacement is forbidden after cohort readiness")`,
whose §7 code is `CHILD_LIFECYCLE`. Plan 2295 assigns a replaced-after-ready
cohort to `COHORT_PROTOCOL`, and the Mac binary does answer `COHORT_PROTOCOL`
there (`MacRefusal::Cohort("replacement after readiness")`,
`secure_fs.rs`, recorded in `.scratch/2026-09-05-cohort-completion/notes/rust-replacement.md`
§7). The two supervisors therefore refuse the same condition under two codes.

## Why

1. The refusal is not new. `CohortOwner::replace_before_ready` has minted
   exactly this `ChildLifecycle` since before this batch, and
   `crates/native/tests/fanout_supervisor.rs:1026-1035`
   (`supervisor_post_ready_child_exit_is_terminal`) pins the string. This change
   routes a new caller to an existing guard; it did not choose the code.
2. `CohortRefusal` has a `ChildLifecycle` member and `MacRefusal` does not
   (`secure_fs.rs`), which is the whole reason the Mac uses `COHORT_PROTOCOL`
   for its half. Making the rig match the Mac would mean re-coding a pinned
   refusal on the rig; making the Mac match the rig is impossible without a new
   `MacRefusal` member.
3. Both codes are §7 closed codes and both are terminal for the arm. Neither
   widens a bound, and no caller branches on the difference: the controller's
   `PRE_READINESS_CHILD_LOSS_CODES` (`bin/compare-controller.ts:5467-5471`)
   contains `CHILD_LIFECYCLE` and not `COHORT_PROTOCOL`, so the rig's code is,
   if anything, the more recoverable of the two — and the recovery it would
   trigger is refused again immediately by the same guard, once, because the
   supervisor's replacement allowance is already spent by then.

## Proof

`crates/native/tests/rig_cohort_runtime.rs`,
`a_teardown_of_a_ready_cohort_is_a_post_readiness_replacement_and_is_terminal`:
drives a cohort to `CohortPhase::Ready` at stage `ServerSpawned`, sends the
teardown frame, and asserts the refusal, its `code()` of `CHILD_LIFECYCLE`, that
the cohort is `Terminal`, and that the refused transition reaped nothing.

Mutation proof: deleting the `CohortPhase::Ready` guard from
`CohortOwner::retire_before_ready` makes that test fail (the teardown succeeds
and retires a ready cohort).
