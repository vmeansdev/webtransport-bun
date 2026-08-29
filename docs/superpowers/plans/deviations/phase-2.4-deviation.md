# Phase 2.4 — execution deviation

The Phase 2.4 block in `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md:417-544`
was independently reviewed by architect and critic before implementation. Both reviews
returned **REJECTED**. The plan file remains untouched; this deviation records the
corrected execution contract and the seven architect conditions that govern the
implementation.

Architect review: `docs/superpowers/plans/deviations/phase-2.4-architect-review.md`
Critic review:   `docs/superpowers/plans/deviations/phase-2.4-critic-review.md`

## Convergent blockers (architect + critic)

1. The sync-boundary adapter (Task 2.4.7) is directionally impossible — an
   `async MeasuredLeg` cannot be turned into a sync `ArmMeasurementRequest`
   without hidden buffering. The campaign loop is already `async`; `measureArm`
   must return `Promise<ArmMeasurement>` and the two call sites must `await`.
2. A `ServerHandle` cannot cross the Mac-client → Linux-server process boundary.
   `measureLegOverAdapter` must accept a narrow `ServerLoopSnapshotSource`
   with both in-process and sidecar-backed implementations.
3. The WS server aggregate drops busy time as soon as a session closes
   (`serverLoopUtilization` sums `this.sessions` only). A completed-session
   accumulator is required, plus a snapshot-after-close test.
4. The WT server `wrapServerHandle` discards per-session wrappers; the
   placeholder `{ busyMs: 0, windowMs: 0 }` is a literal fabrication. A real
   server accumulator is required, plus a snapshot-after-close test.
5. The sidecar protocol is undefined: ownership, framing, correlation, cadence,
   deadlines, trust binding, and I/O classification are all absent. A bounded,
   length-prefixed canonical-JSON codec is the minimal honest shape.
6. Required `ArmMeasurement` fields cannot precede frozen helpers by four
   commits. The F4 pattern (commit `2fb90c13`) requires atomic
   field + helper updates in the same commit. Tasks 2.4.2 and 2.4.6 must be
   one commit; tasks 2.4.3 and 2.4.4 must be one commit.
7. The verifier anchor at `verify-artifact.ts:2647` is `verifyTelemetry`
   (host-telemetry `loopUtilizationPercent`, a percent field). The new
   top-level `loopUtilization.{perSession,serverAggregate}` is a different
   signal and must have its own `verifyLoopUtilization` dispatched from
   `verifySnapshot`.
8. `renderMarkdownReport` takes only `ComparisonSummary`; no report config
   exists. The `0.3` threshold must live in a renderer-owned
   `REPORT_CONFIG` constant, not a per-run calibration or a required
   parameter.
9. The plan references a `spawnRigSupervisor` function that does not exist
   (`remote-supervisor.ts:518-569` is `buildRigSshArgv`, which returns argv
   and leaves actual spawning to the caller). The sidecar channel must
   reuse the controller's actual SSH process as the channel owner.
10. Test files named in the plan do not exist
    (`artifact-builder.test.ts`, `verify-artifact.test.ts`,
    `render-report.test.ts`, `r0-flow-hardening.test.ts`,
    `compare-run.test.ts`, `admission-record.test.ts`). The real
    frozen-helper set is `r1-flow-hardening.test.ts:262 statedArmMeasurement`
    and `r1-flow-hardening.test.ts:1394 measurementOf`, with five
    `buildMeasuredArmArtifact` literal sites in `driver-core.test.ts`.
11. The schema split (Task 2.4.3 vs 2.4.4) cannot be independent: the
    verifier enforces an exact top-level key set
    (`EXPECTED_TOP_LEVEL_KEYS` at `verify-artifact.ts:103-132`), so the
    input, builder emission, schema field, and exact-key verifier must
    land atomically, alongside sealed-fixture regeneration and hash
    convergence.
12. New modules (`server-snapshot-protocol.ts`, `server-snapshot-sidecar.ts`,
    `arm-measure.ts`) need explicit official-I/O classifications
    (`protocolOnlyTs`, `controllerOnlyTs`, or `roleChildTs`) and
    `resolvedStaticImports` updates in `official-io-allowlist.json`.

## Seven architect conditions for approval

1. `CampaignExecution.measureArm` is asynchronous; no one-shot buffer.
2. The remote source is a bounded, correlated sidecar abstraction, not a
   live `ServerHandle` passed across processes.
3. WS and WT retain completed-session busy time and tests snapshot after
   close.
4. Required arm fields and frozen helpers land atomically.
5. Artifact schema, builder emission, exact-key verification, and fixture
   updates land atomically.
6. The fixed `0.3` threshold is owned by immutable report config; only
   raw per-session utilization triggers the caveat.
7. New modules receive explicit official-I/O classifications and
   resolved-import updates.

## Revised commit order (5 commits, not 7)

The plan's seven tasks collapse into five atomic commits. Each commit
remains independently buildable, type-correct, and test-green.

### Commit 1 — Source server-aggregate loop utilization locally and remotely so measured legs carry real server load

Covers revised Task 2.4.1 (sub-steps a–e). Producer-side only.

- `adapters/transport.ts`: introduce `ServerMetrics` extending
  `TransportMetrics` with `serverLoopUtilization: { busyMs, windowMs }`.
  `ServerHandle.snapshot()` returns `ServerMetrics`. `Session.snapshot()`
  is unchanged.
- `adapters/ws.ts`: add `serverLoopBusyMs` accumulator fed by the
  `onClosed` callback; add a snapshot-after-close test
  (`adapters/ws.test.ts`).
- `adapters/wt.ts`: add `serverLoopBusyMs` accumulator on the
  `wrapServerHandle` closure; retain the wrapped server sessions in a
  list so closed-session busy time is visible at snapshot; replace the
  placeholder with the real accumulator. Add a snapshot-after-close
  test (`adapters/wt.test.ts`).
- `server-snapshot-protocol.ts` (new, `protocolOnlyTs`): pure codec for
  `server-loop-utilization/v1` records. Bounded length-prefixed
  canonical JSON, hard cap 4096 bytes, correlation tuple
  `{ campaignId, runId, executionIndex, transport, legId, sequence }`.
- `server-snapshot-sidecar.ts` (new, `controllerOnlyTs`): the actual
  stream owner, with explicit deadline and one-shot consumption
  semantics. Reuses the controller's SSH process; no new rig-spawn
  surface.
- `official-io-allowlist.json` and `check-official-io.ts`:
  classifications, `resolvedStaticImports` entries, and frozen
  `controllerOnlyTs` inventory updated to include the new module.
- Tests: codec round-trip, framing, correlation, deadline, oversized,
  wrong-schema, stale-sequence, snapshot-after-close on both adapters.

### Commit 2 — Await measured legs at the CampaignExecution boundary so asynchronous transport results reach arm artifacts

Covers revised Task 2.4.7. Boundary change.

- `arm-measure.ts` (new, `roleChildTs`): pure synchronous mapper
  `measuredLegToArm({ leg, serverSnapshot, supervisorContext, ... }): ArmMeasurement`.
  It is the join, not the collector.
- `run-campaign.ts:1530-1562`: change `CampaignExecution.measureArm` to
  return `Promise<ArmMeasurement>`. Update the two call sites
  (`run-campaign.ts:1661-1674` primary, `run-campaign.ts:1720-1733`
  overlay) to `await execution.measureArm(...)`. Apply the repository's
  deadline discipline at every `await`.
- Tests: bounded-await tests for primary and overlay arms in
  `driver-core.test.ts`.

### Commit 3 — Carry per-session and server-aggregate loop utilization into ArmMeasurement so comparison scope and server load stay explicit

Covers revised Tasks 2.4.2 and 2.4.6 atomically. Required field plus
every frozen producer.

- `run-campaign.ts:325-460`: replace the optional singular
  `loopUtilization?: { busyMs, windowMs }` with the required
  `loopUtilization: { perSession, serverAggregate }`. Remove the
  zero-fallback in `buildMeasuredArmArtifact` (currently
  `?? { busyMs: 0, windowMs: 0 }` at `run-campaign.ts:1158-1161`).
- `r1-flow-hardening.test.ts:262 statedArmMeasurement` and
  `:1394 measurementOf`: add the new required field with explicit
  fixture values, not zero.
- `driver-core.test.ts`: five `buildMeasuredArmArtifact` literal sites
  updated. The `admittedArm` callback type at `:2258-2263` is widened
  to expose the returned `server` handle.
- `evidence.test.ts:872 tailArm`: add the new field.
- Tests: producer round-trip, fixture-stated vs measured distinction,
  zero-fallback deletion assertion.

### Commit 4 — Require positive loop-utilization windows at artifact assembly and verification so elapsed time is always measured

Covers revised Tasks 2.4.3 and 2.4.4 atomically. Schema, builder, exact-key verifier, fixtures, and hash convergence in one commit.

- `artifact-builder.ts:317-326` and `BuildArtifactInput` (`:92+`): the
  `BuildArtifactInput.loopUtilization` field is required, with the
  nested `{ perSession, serverAggregate }` shape.
- `evidence.ts:1076+ RunArtifact`: add
  `loopUtilization: { perSession, serverAggregate }` as a top-level
  field. `RunArtifact` schema version stays at `"v1"`; only the
  required-key set is updated.
- `verify-artifact.ts:103-132 EXPECTED_TOP_LEVEL_KEYS`: add
  `loopUtilization` as a required top-level key.
- `verify-artifact.ts`: new `verifyLoopUtilization` validator, exact
  nested shape, finite `busyMs >= 0` and finite `windowMs > 0` for both
  scopes. Dispatched from `verifySnapshot` adjacent to
  `verifyTelemetry` (not inside it).
- `buildRunArtifact` (`:320`): require `perSession.windowMs > 0` and
  `serverAggregate.windowMs > 0` for measured arms.
- Sealed fixtures `valid-ws-run.json` and `valid-wt-run.json`
  regenerated; `artifactByteSha256` recomputed; document and fixture
  hashes converged by the repository's hash scripts.
- Tests: builder rejection (missing field, zero window), verifier
  rejection (zero window, wrong shape, finite check), sealed-fixture
  byte-equal, exact-key ordering.

### Commit 5 — Render both loop-utilization scopes and saturation caveats so protocol comparisons expose consumer load

Covers revised Task 2.4.5. Reporting.

- `render-report.ts`: new `REPORT_CONFIG` constant
  `loopUtilizationSaturationThreshold: 0.3`. Rendered in the report
  provenance so the configured value is visible in the deliverable.
- `renderMarkdownReport` (`:82+`): new `Loop Utilization` column.
  Both arms render `perSession` and `serverAggregate`. The
  `saturated` caveat fires strictly on
  `perSession.busyMs / perSession.windowMs > 0.3` (equality is not
  saturated). Only `perSession` triggers the caveat; `serverAggregate`
  is shown for transparency. The caveat text names the arm and the
  scope (e.g. "WT per-session receive-loop utilization 34%; protocol
  attribution is caveated").
- `ComparisonSummary` (`:42-71`): `CellComparison` carries the
  per-arm `loopUtilization` so the renderer can read from the joined
  artifact, not a side channel.
- Tests: threshold boundary (`0.3` not saturated, next
  representable value above it saturated), wrong-scope
  (`serverAggregate > 0.3` does not trigger the caveat), missing
  field, both arms rendered.

## Out-of-scope (preserved for Phase 4)

- Utilization is an **interpretability / caveat signal**, not a
  ranking input. Phase 4 ranking eligibility is unchanged in this
  phase. If a future phase decides that a saturated arm is
  non-promotable, that decision lands as its own commit with
  separate review.

## Plan file

`docs/superpowers/plans/2026-08-28-ws-wt-real-number.md` is unchanged.
This deviation file is the execution contract for Phase 2.4.
