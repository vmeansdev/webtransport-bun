# Deviation: the ordinary Phase-A server spawn

**Slice:** the ordinary A5 arm's signed server lifecycle (amendment C4 line 76,
"Ordinary A5 traffic must also follow the base plan's signed server
lifecycle").

**Base plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`.

## What the plan says

Plan §3.4 freezes the rig <-> server-child frame set. `server-bind-execution/v1`
is frozen with four fields beside `schema`/`sequence`:

```ts
interface ServerBindExecutionV1 {
  schema: "server-bind-execution/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  rigExecutionAcceptanceSha256: Sha256Hex;
  cohortGrantBase64: Base64 | null;
}
```

(`cohortGrantSignatureBase64` is a prior recorded registry edit, documented in
`tools/compare/child-pipe-protocol.ts` above `SERVER_BIND_KEYS`: a grant the
child cannot authenticate is a grant §4.2 forbids it to bind under.)

Plan §5's `RIG_SPAWN_SERVER_REQUEST` already types `cohortGrantSha256` as
`Sha256Hex | null` (plan 795), `rig-measure-start-request/v1` types all three
of its joins nullable (plan 858-860), and `rig-stop-and-capture-request/v1`
types its barrier nullable. The controller <-> rig half of the ordinary arm
therefore needed **no** deviation: it needed a sender, which is what the rest of
this slice added.

## The deviation

`server-bind-execution/v1` gains two nullable fields:

```ts
  macExecutionGrantReceiptBase64: Base64 | null;
  macExecutionGrantSignatureBase64: Base64 | null;
```

Exactly one of the two pairs (`cohortGrant*`, `macExecutionGrant*`) is non-null.
A bind carrying both, neither, or half of either is refused by
`parseServerBindExecution`.

## Why

§5's lifecycle ends in a capture, and the capture frame is
`server-loop-utilization/v1`, whose key set includes five identity fields the
server child must state: `cellId`, `scenarioHash`, `transport`,
`repetitionKind`, `repetitionIndex` and `repetitionTotal`.

A **fanout** child reads all of them off the `execution` its cohort grant
embeds — `tools/compare/scenarios/fanout-relay.ts` builds the frame from
`grant.execution.cellId`, `grant.scenarioHash`,
`grant.execution.repetitionKind`, `grant.execution.repetitionIndex` and
`grant.execution.repetitionTotal` (the `loopUtilizationSnapshot` projection,
`fanout-relay.ts:3618-3644`).

An **ordinary** child has no grant. Under the plan's five-key bind frame it
would have had to invent that identity, and every other candidate source was
checked and rejected by execution:

- **The staged launch record's `allowedEnvironment`** is minted once per
  campaign, before any execution exists (`tools/compare/server.ts`,
  `buildStagedServerLaunchRecord`). `repetitionKind` alone differs between the
  warmup and the measured repetition of one A5 cell, so a stage-time binding is
  wrong for the very campaign this slice exists to run.
- **argv** is frozen by the same record and compared field for field by the rig
  (`crates/native/src/secure_fs.rs`, `parse_spawn_request`: `serverArgv`,
  `transport` and `bindPort` are read back off the record).
- **`executionSha256`** is a digest; it cannot be inverted.
- **Stating placeholder values** is the failure mode this campaign has already
  been bitten by (`reference_placeholder-evidence-family`): a field that reads
  as evidence, has a validator, and has no honest producer.

The record that already carries the identity, is Mac-signed, and is *already in
the rig's hands* is `mac-execution-grant-receipt/v1`. It embeds the whole
`CrossSupervisorExecutionV1` (`MAC_EXECUTION_GRANT_RECEIPT_FIELDS` in
`secure_fs.rs` lists `execution` as its second key), the rig receives it on
`rig-accept-execution-request/v1` at §5 RIG_EXECUTION_ACCEPTED, and the rig has
already verified its signature against the staged Mac key
(`RigCohortRuntime::accept_execution`). Carrying it to the ordinary child in the
cohort grant's place is therefore not new authority: it is the same authority,
along the same path, verified twice — by the rig before the fork and by the
child before a listener exists (`decidePhaseABind` in `tools/compare/server.ts`,
which re-verifies against the same staged Mac key and refuses a receipt naming
another execution).

## What it does not do

- It does not widen any controller <-> rig or controller <-> Mac frame. Plan
  §3.3's frame set is untouched.
- It does not let the spawn request choose what the child verifies. The receipt
  and its signature are filled in by `RigCohortSession::spawn_server` from the
  session's own retained state, exactly as the cohort grant is; the spawn
  payload has no field for either.
- It does not weaken the cohort arm. A fanout bind carries the grant pair and
  the receipt pair null, unchanged, and the child refuses a bind that carries
  both authorities.
- It does not create a bare bind. The plan's five-key form (both pairs null) is
  now refused outright: it was the shape that could ask a child to bind a
  listener for an execution nothing had signed.

## Proof

- `tools/compare/child-pipe-protocol.test.ts`
  `a_grant_without_its_mac_signature_is_refused_on_the_bind_frame` covers all
  five shapes: half-grant, half-receipt, neither, both, and the ordinary arm's
  honest bind. The pinned hex vector for `server-bind-execution/v1` moved with
  the key set, in the same commit, on both sides.
- `crates/native/tests/rig_cohort_runtime.rs`
  `the_ordinary_arm_runs_the_signed_server_lifecycle_with_no_cohort` asserts the
  spawner is handed the retained receipt and signature and no grant.
- `tools/compare/fanout-supervisor-integration.test.ts`
  "A5 e2e: the real rig runs the ordinary arm's signed server lifecycle" drives
  the release `comparison-supervisor` as the rig against the real
  `server.ts --mode=bulk-source` child: spawn, baseline, the registered
  104,857,600-byte transfer over the staged TLS identity, capture, and teardown,
  asserting the child's pid was alive before the teardown and gone after it, and
  that the capture frame's five identity fields are the signed execution's.
