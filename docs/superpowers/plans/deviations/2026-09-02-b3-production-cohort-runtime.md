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

---

## 7. Round two — what closed, what the registry gained, and what is left

Round one wired the round and left the nine blockers of §6. Round two closed
eight of them and moved the ninth. Every claim below was established by
executing something, not by reading source; the per-slice working notes are
under `.scratch/b35r2-notes/`.

### 7.1 Per-blocker outcome

| # | §6 blocker | Round-two outcome |
|---|---|---|
| 1 | frame-kind divergence | **Closed.** `COHORT_REQUEST_KINDS` and `cohort::rig::ack_kind_for` are header-spelled; new `header_kind_for_schema`. Payload `schema` fields unchanged. Two frames are pinned as hex on both sides (`TS_ACCEPT_COHORT_FRAME_HEX` / `RUST_PINNED_FRAME_HEX`), and all six production-encoded requests are written into one live `serve()` session and answered. |
| 2 | refusal-codec divergence | **Closed.** `CohortRigChannel.exchange` reads the rig's `admission-refusal` / `measurement-refusal/v1` shape before `decodeRegisteredRemotePayload`, and `mapRigRefusalCodeToIndexCode` maps the rig's literal onto the §7 closed set. |
| 3 | no production Mac seams | **Closed.** `createMacProductionCohortMinter`, `createMacFanoutRoleChildHost` and `createMacFanoutProcessControl` in `remote-supervisor.ts`, with real `kill(2)` addressed at the process group and a bounded synchronous reap. |
| 4 | no signature on `server-bind-execution/v1` | **Closed. Registry edit — see §7.2.** The field exists, the pairing rule lives in the codec, and `server.ts --mode=fanout-cohort` verifies it against the staged Mac key before any listener exists. |
| 5 | `install_cohort_runtime` has no production caller | **Closed.** `serve()` installs a `CohortRuntime` from four all-or-none descriptors (`--cohort-signing-key-fd`, `--cohort-execution-acceptance-fd`, `--cohort-execution-acceptance-signature-fd`, `--cohort-role-root-fd`) before it reads its first frame. The Phase-A rig binding the mandate assumed does not exist (`grep -rn 'rig-accept-execution-request' crates/native tools/compare`, non-test, is empty); the binding is read from the rig's own signed `rig-execution-acceptance/v1`, verified against the key derived from the private half on the descriptor. |
| 6 | `run-campaign.ts` drops `cohortEvidence` | **Closed.** `ArmMeasurement` gained `readonly cohortEvidence?: ArmCohortEvidenceV1` and `buildMeasuredArmArtifact` spreads it through. Mutation-proven in `r1-flow-hardening.test.ts`. |
| 7 | `rig-measure-start-ack/v1` has no frame | **Closed, and §6 was wrong about the cause.** No registry edit was needed: §3.3 already registers `rig-measure-start-request/v1 -> rig-measure-started-ack/v1` and `CohortRigChannel.measureStart` already sends it. The missing half was the rig's: `RigCohortSession::measure_start` now exports the retained ack bytes and signature. |
| 8 | `server-warmup-ready/v1` has no key set | **Closed. Registry edit — see §7.2.** Frozen key set enforced on both sides, with `warmupCountersZero` a builder-written `true` rather than a caller field. |
| 9 | no role-child control-pipe reader | **Closed.** `MacRoleChildControlChannel` + `MacRoleChildCohortDriver`. `bin/fanout-role.ts` needed no change — it already emits every frame of the lifecycle. |

### 7.2 Registry edits made, and why each was unavoidable

Both are recorded here because §3.3/§3.4 freeze these key sets.

1. **`server-bind-execution/v1` gains `cohortGrantSignatureBase64: Base64 | null`.**
   §4.2 requires the server child to verify the grant against the *staged* Mac
   public key before it binds, and a bare record cannot be verified against any
   key. The alternative to this field is a server that trusts an unsigned
   grant. `parseServerBindExecution` enforces the pairing rule — grant and
   signature both null or both present — so "a grant with no signature" is
   unrepresentable rather than merely refused.
2. **`server-warmup-ready/v1` gains its key set**
   (`schema`, `sequence`, `executionSha256`, `cohortWarmupEpochSha256`,
   `warmupCountersZero: true`). It was registered with no key set, no producer
   and no parser — a placeholder-evidence-family entry. This is the plan's own
   §3.4 table (lines 1042-1048) made enforceable, not a widening.

No other frame kind or field was added.

### 7.3 One further defect found and closed this round

`deliverSpawnConfigs` had **no caller outside `fanout-executor.test.ts`.**
`driveCohortArm` goes `spawnRoleChildren -> beginRamp -> rig.registerRolePeers`,
holding a `CohortRigBinding` and no driver handle, and
`composeCohortRigBinding` routed that last step straight at
`MacRoleChildCohortDriver.registerRolePeers`, which refuses
`COHORT_NOT_READY: no child has been handed its spawn config yet`. Every driver
test called `deliverSpawnConfigs` itself, which is exactly how a suite that
states its own inputs hides the step production never takes.
`composeCohortRigBinding` now delivers the configs once per composition, on the
first ramp. Mutation-proven by
`the composed binding hands each child its spawn config, because driveCohortArm never does`.

### 7.4 The e2e's final assertion list

`fanout-production-e2e.test.ts`, 14 tests, all passing:

1. `the_frozen_topology_is_the_one_this_suite_claims_to_drive` — the cardinality
   table for `ticker 10k` (1 publisher / 8 workers / 100 subscribers / 101
   sessions / 100,000 ingress / 10,000,000 deliveries) is the frozen one.
2. `the_{ws,wt}_primary_reaches_the_cohort_executor_and_refuses_with_a_named_missing_input`
   — routed to the cohort executor, refused `COHORT_NOT_READY`, the refusal
   names the Phase-A half of `CohortArmLease`, and nothing is written.
3. `a_refused_cohort_arm_is_never_demoted_to_a_single_session_leg`.
4. `refuses_at_the_absent_control_pipe_rather_than_binding_a_listener` and
   `refuses_earlier_when_the_stage_time_environment_is_absent` — the real
   entrypoint's two fail-closed orders.
5. **New:** `the_child_binds_a_socket_and_then_exits_because_no_relay_serves_the_cohort`
   — the real `server.ts --mode=fanout-cohort` process with the real §3.4 pipes
   on FD 3/4 and this test standing in for the rig: a real Mac keypair, a really
   signed grant, `server-ready/v1` and `server-warmup-ready/v1` decoded off the
   pipe, the warmup digest taken over the epoch bytes exactly as they arrived,
   and then exit 0 with no relay having served anything.
6. `the_frames_the_rust_dispatch_pins_are_the_ones_this_encoder_produces` and
   `every_cohort_frame_kind_is_its_schema_without_the_version_suffix`.
7. `every_production_encoded_cohort_frame_is_matched_by_the_real_rig_dispatch`,
   `a_kind_spelled_as_a_schema_is_still_not_a_frame_this_rig_speaks`,
   `the_controllers_cohort_channel_reports_the_rigs_own_refusal_code` — the real
   built binary over the real codec.
8. `the_wrapper_expected_counts_for_a_sealed_pilot_pair_are_not_met` and
   `the_honest_counts_for_this_run_are_zero_passes_and_zero_seals` — the
   mandate's index shape is driven through `verifyCampaignIndex` and shown
   **not** to be satisfiable by a campaign that measured nothing, while the
   honest counts are.

The mandate's assertions 1–4 (two sealed PASS arms; `verifyRunArtifact` PASS
over a reconstructed `CohortObservationEvidenceV1`; both issuer signature graphs
verified; promotable:false pilot-shaped index entries) are still **not** made,
and are not weakened: no artifact can be produced to make them against. §7.5 is
why, and it is round three's list.

### 7.5 Residuals — round three's list

1. **No relay serves the cohort.** *Proved by execution* —
   `the_child_binds_a_socket_and_then_exits_because_no_relay_serves_the_cohort`:
   the real child verifies the grant, binds a socket at `server.ts:1379`
   (`adapterForTransport(...).startServer`, not `serveFanoutCohortRelay`),
   answers `server-warmup-ready/v1`, and exits at `server.ts:1431`.
   `serveFanoutCohortRelay` (`server.ts:791`) needs a `FanoutLinuxAuthority`,
   and `FanoutLinuxAuthorityConfig.rig` requires `privatePkcs8Der`
   (`scenarios/fanout-relay.ts:2282`) — the rig signing key, which reaches the
   supervisor on `--cohort-signing-key-fd` and is deliberately not passed to
   this child. **This is a design question, not a wiring gap:** plan line 987
   says "Role children *additionally* receive no controller FD and no supervisor
   signing-key FD", which reads as the server child being entitled to one, while
   the rig supervisor already mints every cohort receipt in
   `crates/native/src/secure_fs.rs` (`cohort::rig`). Two implementations of the
   Linux authority exist and only one can be authoritative. Until it is
   resolved, no role peer can register and no ingress can be accepted, so
   §5's drain, baseline, barrier and measured window are all unreachable.
2. **No lease factory.** `realRunBody` passes none.
   `ProductionCohortArmMaterial` (`bin/compare-controller.ts:5263`) declares the
   assembled Mac half and has **no factory and no caller**
   (`grep -rn 'ProductionCohortArmMaterial' tools/compare` returns the
   declaration alone) — a type that reads as a producer and has none. The seal
   half also still needs a live Phase-A execution for `supervisorContext`,
   `serverSnapshot`, `admissionCounters`, `attestationEvidence` and `recorder`,
   and `bin/compare-controller.ts` still loads none of the staged Mac/rig public
   keys or the Mac private key.
3. **Two §4.1 grant codecs disagree.** Rust `parse_shards` requires
   `firstSubscriberIndex == 0` and `lastSubscriberIndexExclusive ==
   grant.subscriberCount` for every shard; TS `parseCohortGrant`
   (`cohort-protocol.ts:346`) requires
   `shard.lastSubscriberIndexExclusive === shard.subscriberCount`, and
   `buildFanoutCohortFixture` (`scenarios/fanout-relay.ts:1992`) writes it that
   way. With modulus 8 and 8 subscribers those demand 8 and 1 in the same field,
   so **no grant satisfies both.** Proved by execution: the first live attempt
   died on `TRUST_RECORD_SCHEMA_INVALID` to `rig-accept-cohort-request/v1`.
   The Rust reading is the coherent one.
4. **`buildFanoutCohortFixture` cannot mint production tokens.** Every token is
   `sha256(cohortId || ":" || roleId)` (`scenarios/fanout-relay.ts:1879`), and
   `cohortId` travels inside the signed grant — so anyone holding the grant can
   recompute every raw registration token, which is the exact property the
   commitment scheme exists to prevent. The fix is one optional `tokenFor`
   parameter; it was not taken because that file was outside every round-two
   slice.
5. **`MacRoleChildFrameSource` has no production implementer.**
   `role-spawn-config/v1`, `role-warmup-start/v1` and `role-measure-start/v1`
   all carry Mac-signed material and the driver deliberately cannot mint them.
6. **`check-official-io`'s `tools/compare` scan resolves to
   `tools/compare/tools/compare/...`** and therefore finds nothing under
   `tools/compare/*.ts`. Both live pipe readers (`server.ts`'s
   `createFanoutCohortControlPipeIo` and `remote-supervisor.ts`'s
   `MacRoleChildControlChannel`) import `node:fs`, which is on
   `forbiddenImports`; if that scan is ever repaired both surface at once and the
   allowlist needs a decision about pipe I/O in children handed descriptors.
7. **The rig still answers cohort refusals in the Phase-A shape** rather than
   minting a `remote-supervisor-refusal/v1`. §3.3 freezes that record with
   `terminal: true`, and a refused cohort transition is deliberately
   non-terminal. Recorded rather than decided.

### 7.6 Round-two gate state

Measured on a `git archive` clean tree with real `node_modules`
(`.scratch/rebuild-clean.sh`), except the cargo gates, which run in the
worktree.

- `bunx tsc -p tsconfig.json`: 0.
- `bun test tools/compare/ --timeout 30000`: **1373 pass / 0 fail** across 49
  files on the clean tree. The two `r1-entrypoint-red` inventory oracles fail on
  a dirty worktree only, and pass here.
- `bun test tools/compare/fanout-production-e2e.test.ts`: 14 pass / 0 fail.
- `bun tools/compare/check-official-io.ts`: 136 failures, **normalized key set
  byte-identical** to the same tree at `d873aa80`. `official-io-allowlist.json`
  was not edited this round.
- `cargo fmt --all --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: 34 errors, unchanged from the
  round-one baseline (all pre-existing, in `limits.rs` / `session.rs` /
  `session_registry.rs` / `spawn_tracked.rs` / `tests/secure_fs.rs`); no Rust
  file was edited in round two's final gate.
- `cargo test --workspace`: green.
- `scripts/converge-r1-fixture-hashes.ts --check`: `verdict CLEAN, no edits
  needed`.
