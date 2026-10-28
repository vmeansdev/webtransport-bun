# Phase 2.4 Architect Review — Loop-Utilization Wiring Chain

Review target: Phase 2.4, Tasks 2.4.1–2.4.7, in `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md:417-544` on branch `codex/ws-scenario-comparison`.

## 1. Verdict

**REJECTED**

The target data model is correct: every measured arm should carry both a scope-matched `perSession` value and a transparent `serverAggregate` value, with only `perSession` used for the comparison. The seven-task execution shape is not safe to implement as written, however. Three blockers require an execution deviation before Phase 2.4 starts:

1. A Mac client process cannot receive the Linux server process's live `ServerHandle`; the plan conflates the in-process adapter seam with the cross-host sidecar seam.
2. `MeasuredLegToArm` cannot turn an asynchronous result into a synchronous request without hidden state. `runCampaign` is already asynchronous and must await an asynchronous `CampaignExecution.measureArm` instead.
3. The seven commits are not independently buildable. Required `ArmMeasurement` fields are introduced four commits before frozen helpers are updated, while the exact-key artifact verifier makes the Task 2.4.3/2.4.4 split non-atomic.

Approval can be reconsidered after those boundaries and the commit order are corrected. The plan file itself remains untouched.

## 2. Architecture issues

### 1. The sync-boundary adapter is directionally impossible

- **File:line:** `tools/compare/client.ts:423-439`, `tools/compare/run-campaign.ts:1530-1562`, `tools/compare/run-campaign.ts:1581-1594`, `tools/compare/run-campaign.ts:1661-1674`, `tools/compare/run-campaign.ts:1720-1733`.
- **Defect:** Task 2.4.7 says an adapter takes an asynchronous `MeasuredLeg` and produces a synchronous `ArmMeasurementRequest`. A request exists before measurement; `MeasuredLeg` exists after measurement. Converting the latter into the former reverses the data flow and can only work through hidden preloading or a one-shot buffer.
- **Evidence:** `runMeasuredLeg` returns `Promise<MeasuredLeg>` (`client.ts:423-439`). `CampaignExecution.measureArm` returns `ArmMeasurement` synchronously (`run-campaign.ts:1560-1562`), although `runCampaign` itself already returns `Promise<void>` (`run-campaign.ts:1581-1594`). Both primary and overlay call sites consume `measureArm` without `await` (`run-campaign.ts:1661-1674`, `1720-1733`).
- **Structural fix:** Change the seam to `measureArm(request: ArmMeasurementRequest): Promise<ArmMeasurement>` and await it at both call sites. Define `MeasuredLegToArm` as a pure result mapper, not a request builder: it should accept `{ leg, toolchains, telemetry, grant, admission }` and return `ArmMeasurement`. The awaited `MeasuredLeg` lives in the local `measureArm` implementation until it is mapped; no one-shot buffer is needed.

### 2. `MeasuredLeg` alone cannot produce `ArmMeasurement`

- **File:line:** `tools/compare/client.ts:255-310`, `tools/compare/run-campaign.ts:343-459`.
- **Defect:** Task 2.4.7 names a leg-to-arm adapter without naming the additional trusted inputs required to build an arm.
- **Evidence:** `MeasuredLeg` carries samples, ledger, admission counters, provenance, loop utilization, and round trips (`client.ts:255-310`). `ArmMeasurement` additionally requires supervisor-observed `toolchains`, host `telemetry`, a `MeasurementGrantV1`, and admission-receipt bytes (`run-campaign.ts:343-459`). Those values cannot be inferred from a client-produced leg.
- **Structural fix:** Make the mapper's context explicit. It must join the child-produced leg with supervisor/controller-produced evidence. Do not add trusted observations to `ArmMeasurementRequest` as if they were pre-measurement workload inputs; pass them to the mapper after the supervisor admits the leg.

### 3. A remote client cannot be passed a live `ServerHandle`

- **File:line:** `tools/compare/client.ts:529-567`, `tools/compare/client.ts:1048-1068`, `tools/compare/bin/compare-controller.ts:600-616`, `tools/compare/bin/compare-controller.ts:644-695`, `tools/compare/adapters/transport.ts:316-326`.
- **Defect:** Task 2.4.1(e) asks `measureLegOverAdapter` to accept a `ServerHandle`. The production client runs on the Mac while the server and its handle live in a different Bun process on the Linux rig.
- **Evidence:** `measureLegOverAdapter` currently constructs only a client `Session` through `adapter.connect` (`client.ts:529-567`). Its CLI caller passes no server object (`client.ts:1048-1068`). The controller starts the server over SSH and later spawns the client locally (`compare-controller.ts:600-616`, `644-695`). `ServerHandle` is an in-memory interface returned by `TransportAdapter.startServer` (`transport.ts:316-326`), not a serializable capability.
- **Structural fix:** Accept a narrow asynchronous `ServerLoopSnapshotSource` (or receive the already-correlated snapshot as controller data), not a raw `ServerHandle`. Provide an in-process adapter around `ServerHandle.snapshot()` for tests and a remote sidecar-backed implementation for the rig. Keep process locality visible in the types.

### 4. The proposed public-server field duplicates an existing contract and still loses closed-session work

- **File:line:** `tools/compare/adapters/transport.ts:92-128`, `tools/compare/adapters/transport.ts:299-320`, `tools/compare/adapters/ws.ts:2205-2218`, `tools/compare/adapters/ws.ts:2267-2274`, `tools/compare/adapters/ws.ts:2402-2428`.
- **Defect:** Task 2.4.1(a)-(b) says the server aggregate is not public and the WS getter must be made public. `ServerHandle.snapshot()` already publicly returns a `TransportMetrics` whose `loopUtilization` is populated from the WS server aggregate. Making the private implementation getter public does not improve the interface. More importantly, the aggregate drops closed-session busy time.
- **Evidence:** Both `Session.snapshot()` and `ServerHandle.snapshot()` return `TransportMetrics` (`transport.ts:299-320`), whose public `loopUtilization` is defined at `transport.ts:92-128`. WS maps `ServerHandle.snapshot().loopUtilization` to `this.serverLoopUtilization` (`ws.ts:2402-2428`). On close, the session is removed from `this.sessions` (`ws.ts:2267-2270`), while `serverLoopUtilization` sums only the remaining set (`ws.ts:2205-2218`). `mergeMetrics` does not retain loop busy time, so a snapshot after client teardown can report zero.
- **Structural fix:** Keep implementation getters private. Either document `ServerHandle.snapshot().loopUtilization` as server-scoped or introduce a distinct `ServerMetrics` return type whose field is named `serverLoopUtilization`. Accumulate completed-session busy time separately and add active-session busy time at snapshot. Tests must cover a snapshot after session close, because that is when the remote controller reads it.

### 5. WT has no retained session source for a real server aggregate

- **File:line:** `tools/compare/adapters/wt.ts:1517-1554`, `tools/compare/adapters/wt.ts:1591-1627`.
- **Defect:** Replacing `{ busyMs: 0, windowMs: 0 }` is not a local expression change. `wrapServerHandle` wraps a raw session and immediately returns it without retaining the wrapper or receiving its final utilization.
- **Evidence:** `deliverSession` resolves `wrapServerSession(raw, clock)` directly, and queued sessions are wrapped on acceptance (`wt.ts:1530-1554`). The per-session utilization closure is therefore trapped inside each returned `Session`. The server snapshot has only native counters and the placeholder (`wt.ts:1591-1627`).
- **Structural fix:** Add an explicit server accumulator owned by `wrapServerHandle`. Each wrapped server session must contribute its final busy time on close and expose its live contribution while active, using the same completed-plus-active rule as WS. Start the aggregate window when the server handle is created, not when the first session is accepted. Do not sum or remove wrappers in a way that double-counts closed sessions.

### 6. The remote sidecar has no defined ownership, correlation, or leg window

- **File:line:** `tools/compare/host-sidecar.ts:1-105`, `tools/compare/remote-supervisor.ts:16-51`, `tools/compare/bin/compare-controller.ts:626-695`.
- **Defect:** Task 2.4.1(d) names a file but not a protocol, transport owner, record identity, deadline, or snapshot window. The controller can run multiple repetitions against one server, so an untagged cumulative snapshot is not a per-leg value.
- **Evidence:** `host-sidecar.ts` contains only FD and ephemeral-port parsing/validation. `remote-supervisor.ts:46-51` explicitly says that file is a pure validator and should not acquire a process-management role. The controller loops repetitions (`compare-controller.ts:626-695`). A server-lifetime cumulative value would therefore grow across repetitions unless each server is restarted or deltas are defined.
- **Structural fix:** Put the channel in dedicated sidecar/protocol modules, correlate every record to `campaignId`, `runId`, `executionIndex`, transport, and leg/session identity, and enforce a bounded read deadline. Prefer one server lifecycle per measured leg; otherwise define before/after snapshots and record the non-negative delta. Never send this telemetry over the measured WS/WT data path.

### 7. Tasks 2.4.3 and 2.4.4 cannot be separate strict-schema commits

- **File:line:** `tools/compare/artifact-builder.ts:317-326`, `tools/compare/artifact-builder.ts:1081-1113`, `tools/compare/evidence.ts:1076-1124`, `tools/compare/verify-artifact.ts:103-132`, `tools/compare/verify-artifact.ts:275-313`, `tools/compare/verify-artifact.ts:2861-2904`.
- **Defect:** The plan puts input/runtime verification in Task 2.4.3 and the `RunArtifact` field in Task 2.4.4. The verifier enforces an exact top-level key set, so the producer, schema, required-key list, and field validator must move atomically.
- **Evidence:** `BuildArtifactInput` already has an optional singular field (`artifact-builder.ts:317-326`), but the typed artifact literal does not publish it (`artifact-builder.ts:1081-1113`) and `RunArtifact` has no field (`evidence.ts:1076-1124`). `requireKeys` rejects both unknown and missing required keys (`verify-artifact.ts:275-313`), using `EXPECTED_TOP_LEVEL_KEYS` (`verify-artifact.ts:103-132`).
- **Structural fix:** Merge Tasks 2.4.3 and 2.4.4 into one atomic schema/builder/verifier commit, or redefine their boundary so 2.4.3 only introduces a compatibility-neutral input shape and 2.4.4 atomically publishes and requires it. The zero fallback must be removed for measured arms; `busyMs === 0` remains valid, but both windows must be finite and strictly positive.

### 8. The frozen-helper update is too late and incomplete

- **File:line:** `tools/compare/r1-flow-hardening.test.ts:262-328`, `tools/compare/r1-flow-hardening.test.ts:1393-1425`, `tools/compare/r1-flow-hardening.test.ts:1586-1597`, `tools/compare/driver-core.test.ts:1783`, `2034`, `2297`, `2396`, `2759`.
- **Defect:** Task 2.4.2 makes `ArmMeasurement.loopUtilization` required, but Task 2.4.6 updates test producers four commits later. The named helper is not the only producer: the frozen flow test contains additional direct `ArmMeasurement` constructors and the driver test has five arm-builder sites.
- **Evidence:** `statedArmMeasurement` returns an `ArmMeasurement` object without loop utilization (`r1-flow-hardening.test.ts:262-328`). The same file contains other constructors such as `measurementOf` and direct typed spreads (`1393-1425`, `1586-1597`). The driver test has multiple independent `buildMeasuredArmArtifact` sites.
- **Structural fix:** Apply the F4 fixture thread-through in the same commit that makes the field required, or keep the property type-compatible until the atomic tightening commit. Audit all `ArmMeasurement` object literals and all measured `buildRunArtifact`/`buildMeasuredArmArtifact` callers, not only the two examples. Add separate tests for WS/WT closed-session aggregation, sidecar framing/correlation/deadline, builder rejection, verifier rejection, renderer threshold boundaries, and async campaign execution.

### 9. The verifier anchor points at unrelated reserved telemetry

- **File:line:** `tools/compare/verify-artifact.ts:2647-2716`, `tools/compare/verify-artifact.ts:2861-2904`.
- **Defect:** The plan's anchor near line 2647 is `verifyTelemetry`, which validates `$.telemetry.{mac,linux}.arm.loopUtilizationPercent`. The new field is top-level `$.loopUtilization.{perSession,serverAggregate}` and has different raw-unit semantics.
- **Evidence:** `verifyTelemetry` requires `loopUtilizationPercent` inside each host's reserved arm telemetry (`verify-artifact.ts:2647-2716`). `verifySnapshot` dispatches independent top-level validators (`2861-2904`).
- **Structural fix:** Add `loopUtilization` to `EXPECTED_TOP_LEVEL_KEYS`, define a dedicated `verifyLoopUtilization` for the nested raw `{busyMs, windowMs}` records, and call it from `verifySnapshot` adjacent to `verifyTelemetry`. Validate exact keys, finite non-negative `busyMs`, and finite `windowMs > 0` for both scopes. Do not place the new checks inside `verifyTelemetry`.

### 10. “Report config” does not exist

- **File:line:** `tools/compare/render-report.ts:42-71`, `tools/compare/render-report.ts:82-139`, `tools/compare/render-report.ts:147-153`, `tools/compare/render-report.ts:312-320`.
- **Defect:** Task 2.4.5 requires the fixed threshold to be read from report config, but the renderer currently has no report config. `ComparisonSummary` contains results only, while `ReportIdentity` contains filesystem/trust identity only.
- **Evidence:** `renderMarkdownReport` takes one `ComparisonSummary` (`render-report.ts:82-139`). `ComparisonSummary` has no configuration field (`42-71`), and `ReportIdentity` is an evidence/output locator (`147-153`). `generateReport` constructs the summary and immediately renders it (`312-320`).
- **Structural fix:** Define an exported immutable renderer-owned `REPORT_CONFIG` (or a pure `report-config.ts` if it will be shared) with `loopUtilizationSaturationThreshold: 0.3`. The renderer reads that value and records it in the report provenance/caveat text. Do not source it from CLI, environment, artifact data, or a per-run calibration. Avoid adding a required positional argument to `renderMarkdownReport`, which would break frozen callers.

### 11. New modules are missing official-I/O classification work

- **File:line:** `tools/compare/check-official-io.ts:31-53`, `tools/compare/check-official-io.ts:3840-3865`, `tools/compare/remote-supervisor.ts:46-51`.
- **Defect:** Task 2.4.7 creates `arm-measure.ts`, and the recommended sidecar boundary creates at least a protocol module. The plan does not mention their static-I/O classifications or resolved-static-import manifest updates.
- **Evidence:** The checker has an exact class schema including `controllerOnlyTs`, `protocolOnlyTs`, and `resolvedStaticImports` (`check-official-io.ts:31-53`). It currently requires exactly five controller modules, including `host-sidecar.ts` (`3840-3865`).
- **Structural fix:** Classify a pure sidecar codec as protocol-only and its controller/process endpoint as controller-only (or use the existing role-child classification for a role endpoint), update the checker's expected class inventory, update `official-io-allowlist.json` and resolved static imports, then rotate only the hashes the repository's convergence scripts require. `arm-measure.ts` should remain pure so importing it from an official root does not pull process/network I/O into that graph.

### 12. The plan cites a rig spawn function that is not present

- **File:line:** `tools/compare/remote-supervisor.ts:518-569`.
- **Defect:** The supplied anchor says `spawnRigSupervisor` exists near line 548. The current branch has no such exported function.
- **Evidence:** The section describes rig spawning, but the implementation at line 532 is `buildRigSshArgv`, which returns argv and explicitly leaves actual spawning to the caller (`remote-supervisor.ts:518-569`). Repository search finds no `spawnRigSupervisor` definition.
- **Structural fix:** Do not design the telemetry sidecar around a nonexistent handle. Either use the controller's actual SSH process as the channel owner or add a separately reviewed rig spawn surface with explicit stdin/stdout ownership. This is another reason not to hide the channel in `host-sidecar.ts`.

## 3. Per-task commit review

| Task | Scope verdict | Commit-subject verdict | Missing or required correction |
|---|---|---|---|
| **2.4.1 Source hop** | **Too broad and partly mis-specified.** The adapter-side producer chain is one logical change, but the remote protocol is a separate process boundary. A raw `ServerHandle` cannot cross it, and exposing the WS private getter is unnecessary. | **Revise.** The subject refers to another task rather than the durable outcome. | Define a narrow snapshot-source interface; fix completed-session accounting in both adapters; create a dedicated bounded/correlated sidecar protocol; add static-I/O classifications and local/remote tests. |
| **2.4.2 ArmMeasurement shape** | **Right data shape; wrong atomic boundary.** `perSession` as the comparison scope and `serverAggregate` as transparency is correct. | **Approve with tightening.** | Remove the current optional singular shape. Populate the nested required shape through the actual leg-to-arm mapper. Land all `ArmMeasurement` fixture producers in the same green commit or merge Task 2.4.6. |
| **2.4.3 BuildArtifactInput + validation** | **Not independently landable as described.** Input validation can be separate only if it remains compatibility-neutral; artifact verification cannot require a top-level field before the schema publishes it. | **Revise.** “Zero is not a measurement” is inaccurate because `busyMs: 0` is valid. | Require positive windows specifically. Remove the measured-arm zero fallback. Merge the strict verifier work with Task 2.4.4 or restate the commit boundary. |
| **2.4.4 RunArtifact schema** | **Correct destination, but must be atomic with strict validation and builder emission.** | **Approve if merged/rebounded.** | Add the exact top-level key, builder emission, schema field, verifier dispatch, fixture/schema tests, and any required sealed-fixture regeneration together. |
| **2.4.5 Renderer** | **Right feature scope.** It is incomplete without an owned config constant, explicit scope labels, and threshold-boundary tests. | **Revise.** The current why is too weak and omits the caveat behavior. | Render both scopes for both arms. Use `perSession` only for `> 0.3`; show which arm is saturated. Record the fixed threshold in report provenance. Test `0.3` (not saturated) and the next representable value above it (saturated). |
| **2.4.6 Frozen helpers** | **Necessary but sequenced too late and under-enumerated.** | **Revise or merge into 2.4.2.** | Update every typed arm producer and measured artifact caller, not only `statedArmMeasurement` and selected driver callers. Under the actual F4 precedent, this belongs with the required-field/binding commit. |
| **2.4.7 Sync boundary** | **Incorrect design.** A sync adapter would require hidden buffering; the request/result direction is reversed. | **Replace.** | Make `CampaignExecution.measureArm` asynchronous, await it in the already-async campaign loop, and make `MeasuredLegToArm` a pure join from leg plus supervisor context to arm. Add bounded-await tests for primary and overlay arms. |

## 4. Sidecar transport decision

### Home

`host-sidecar.ts` is the wrong home. It is a 105-line pure FD/port validation module, and `remote-supervisor.ts:46-51` explicitly protects that role boundary. Use dedicated modules:

- `server-snapshot-protocol.ts`: pure types, canonical encoding/decoding, size checks, correlation checks; classify as protocol-only.
- `server-snapshot-sidecar.ts` (or endpoint-specific server/controller modules): bounded stream ownership and deadlines; classify according to the actual role/process that imports it.

Keeping the codec pure prevents `arm-measure.ts` or an official root from importing process/network capabilities accidentally.

### Wire format

Use a **bounded length-prefixed canonical JSON record**, not a bespoke binary struct and not newline-delimited JSON:

```text
uint32_be payloadLength
payloadLength bytes of canonical JSON (hard cap, e.g. 4096 bytes)
```

The payload should be versioned and correlated:

```json
{
  "schema": "server-loop-utilization/v1",
  "campaignId": "...",
  "runId": "...",
  "executionIndex": 1,
  "transport": "ws",
  "legId": "...",
  "sequence": 1,
  "capturedAtMs": 0,
  "loopUtilization": { "busyMs": 0, "windowMs": 1 }
}
```

This payload is tiny, low-rate, and benefits more from readable/versioned fields than from binary packing. A length prefix gives deterministic framing across partial pipe/SSH reads. Reusing the full supervisor frame codec is acceptable only if the import graph remains legal; otherwise a small pure codec is safer than importing `supervisor-client.ts` into a role process.

### Read cadence

Use **one completion-triggered push per leg, consumed once by the controller with a deadline**. In other words: on-snapshot push on the server side, per-leg read on the controller side. Do not poll and do not stream periodic samples.

The cleanest scope is one server lifecycle per measured leg, after which the server snapshots once and emits the correlated record. If the controller deliberately reuses a server across sequential repetitions, it must capture a baseline and emit a non-negative per-leg delta; a cumulative server-lifetime value must not be mislabeled as a leg value. The controller joins that record with the matching client `MeasuredLeg` before `MeasuredLegToArm` runs.

## 5. Sync boundary decision

The new `MeasuredLeg` should live in an ordinary local variable inside an asynchronous `CampaignExecution.measureArm` implementation:

```ts
interface CampaignExecution {
  measureArm(request: ArmMeasurementRequest): Promise<ArmMeasurement>;
}

async function measureArm(request: ArmMeasurementRequest): Promise<ArmMeasurement> {
  const leg = await runOrReadMeasuredLeg(request);
  const supervisorContext = await admitAndReadContext(request, leg);
  return measuredLegToArm({ leg, ...supervisorContext });
}
```

`runCampaign` is already asynchronous, so the primary and overlay cell-loop sites should simply `await execution.measureArm(...)`. A one-shot buffer is rejected: it introduces ordering, replay, correlation, and cleanup states solely to preserve a synchronous interface that has no technical need to remain synchronous. Every await must carry the repository's explicit timeout/deadline discipline.

## 6. Saturation threshold ownership

There is no report config today. `ComparisonSummary` is data, `ReportIdentity` is an evidence/output locator, and `renderMarkdownReport` takes only the summary.

The fixed threshold should live in renderer-owned immutable configuration, preferably in `render-report.ts` unless another consumer appears:

```ts
export const REPORT_CONFIG = Object.freeze({
  loopUtilizationSaturationThreshold: 0.3,
});
```

The report must print the configured value in its provenance/caveat text so “recorded in report config” is visible in the deliverable. It must not be read from an artifact, CLI flag, environment variable, or rig observation. The condition is strictly `busyMs / windowMs > 0.3`; equality is not saturated. Only `perSession` triggers the caveat, though both scopes are rendered.

## 7. Correct verifier anchor

The correct integration has three parts:

1. Add `loopUtilization` to `EXPECTED_TOP_LEVEL_KEYS` at `verify-artifact.ts:103-132`.
2. Add a dedicated `verifyLoopUtilization` validator for the exact nested shape and positive windows.
3. Invoke it from `verifySnapshot` near the other top-level evidence validators at `verify-artifact.ts:2861-2904`, adjacent to but not inside `verifyTelemetry`.

`verifyTelemetry` at line 2647 is reserved host telemetry and validates `loopUtilizationPercent`; it is not the semantic parent of the new field. Both invalid windows should produce the plan's general `VALIDATION_FAILED` outcome through normal rejection accumulation, with precise paths `$.loopUtilization.perSession.windowMs` and `$.loopUtilization.serverAggregate.windowMs`.

## 8. F4 pattern compliance

Commit `2fb90c13` does **not** support the proposed seven-commit split. Its actual pattern was:

- add optional seam fields to `BuildArtifactInput`/`buildMeasuredArmArtifact`;
- make them required-in-fact for measured/provenanced arms through a binding assertion;
- update every frozen helper/caller in the **same commit**;
- avoid a rename, move, or positional signature change.

Phase 2.4 diverges from that precedent:

- Task 2.4.1(e) adds a required field to `measureLegOverAdapter`'s input object and breaks its CLI/test callers unless compatibility is preserved.
- Task 2.4.2 changes the existing optional singular `ArmMeasurement.loopUtilization` into a required nested record, breaking typed test literals before Task 2.4.6.
- Tasks 2.4.3/2.4.4 change an exact serialized schema; they cannot be split across strict verification.
- Task 2.4.5 would break `renderMarkdownReport` callers if “report config” is introduced as a required parameter. Use a module-owned constant instead.
- Task 2.4.7 explicitly changes `CampaignExecution.measureArm` and its callers; that is a signature change, even though it is the correct architectural change when made asynchronous.

Therefore the claim “each of the seven commits adds required fields with no signature change” is false. The required-field and frozen-site portions must be atomic, and Task 2.4.7 must openly acknowledge the necessary async interface change.

## 9. Risk register and order

| Order | Risk | Consequence | Required control |
|---:|---|---|---|
| 1 | **Consumer type lands before producer** | Task 2.4.2 cannot populate `serverAggregate`; object literals fail. | Keep revised 2.4.1 first. |
| 2 | **Closed-session utilization disappears** | Remote snapshots read zero after the client closes, especially on WS. | Completed-plus-active accumulators; snapshot-after-close tests on both adapters. |
| 3 | **Remote handle/process confusion** | Local tests pass while the rig path has no source. | Snapshot-source abstraction plus a real controller/server sidecar proof. |
| 4 | **Stale or cross-leg sidecar record** | A prior repetition's server load is attached to the next artifact. | Correlation tuple, monotonic sequence, single consumption, hard deadline. |
| 5 | **Cumulative server window mislabeled per-leg** | Later repetitions appear progressively less/more loaded for orchestration reasons. | One server per leg or explicit before/after deltas. |
| 6 | **Required type before frozen helpers** | Typecheck/tests fail from Task 2.4.2 through Task 2.4.5. | Merge 2.4.6 into 2.4.2 or use one atomic tightening commit. |
| 7 | **Schema/validator split** | New artifact field is either unknown or required-but-absent. | Atomic BuildArtifactInput + RunArtifact + builder + exact-key verifier change. |
| 8 | **Zero fallback survives** | `{busyMs:0, windowMs:0}` passes into a nominally measured artifact. | Remove fallback for provenanced arms; builder and verifier negative tests. |
| 9 | **Schema-v1 fixture drift** | Sealed fixtures/hashes and exact-key tests fail or silently stop representing v1. | Explicit fixture regeneration/hash convergence in the atomic schema commit, or a versioned migration if backward compatibility is required. |
| 10 | **Official-I/O graph drift** | New sidecar/mapper modules fail the static checker or pull forbidden capabilities into official roots. | Classify modules and update resolved static imports in the owning commit. |
| 11 | **Saturation scope error** | Server aggregate or rounded display value triggers the protocol-comparison caveat. | Compute from raw `perSession`, compare strictly to config, then format. |
| 12 | **Unbounded async join** | Missing sidecar/admission leaves campaign promises pending. | Deadline every leg, sidecar read, and supervisor join; surface a typed refusal. |
| 13 | **Measurement contamination** | Sidecar bytes alter the WS/WT metric being reported. | Separate control transport; never tunnel telemetry over the measured session. |

The plan's high-level producer-before-consumer ordering begins correctly with 2.4.1 before 2.4.2, but the rest is not correct. Recommended executable order:

1. Revised 2.4.1: local accumulators plus remote sidecar protocol/source, fully tested.
2. Revised 2.4.7: asynchronous campaign execution and pure leg-to-arm join.
3. Tasks 2.4.2 + 2.4.6 atomically: required arm shape plus all producers/frozen helpers.
4. Tasks 2.4.3 + 2.4.4 atomically: input, builder, serialized schema, exact-key verifier, and fixture updates.
5. Task 2.4.5: immutable report config, rendering, and threshold-boundary tests.

If exactly seven commits is non-negotiable, the task boundaries must be rewritten so every intermediate commit remains type-correct and schema-valid; the current seven subjects cannot describe such a sequence honestly.

## 10. Concrete commit-message audit

1. **Plan:** “Source server-aggregate loopUtilization on the producer side so the consumer hop in Task 2.4.2 has a real value”  
   **Decision:** Revise. Task numbers are not durable intent, and the subject omits the remote boundary.  
   **Proposed:** **“Expose server-aggregate loop utilization locally and remotely so measured legs carry real server load”**

2. **Plan:** “Carry per-session and server-aggregate loopUtilization into ArmMeasurement so the comparison metric is per-session and the aggregate is recorded for transparency”  
   **Decision:** Approve, with style normalization.  
   **Proposed:** **“Carry per-session and server-aggregate loop utilization into ArmMeasurement so comparison scope and server load stay explicit”**

3. **Plan:** “Require loopUtilization on every arm at artifact validation and the static-I-O boundary so zero is not a measurement”  
   **Decision:** Revise. `busyMs: 0` is a valid measurement; only a non-positive window is invalid. “Static-I-O” is also the wrong name for artifact assembly.  
   **Proposed:** **“Require positive loop-utilization windows at artifact assembly and verification so elapsed time is always measured”**

4. **Plan:** “Add loopUtilization to the RunArtifact schema so the renderer reads the field from the artifact, not a side channel”  
   **Decision:** Approve if this commit is atomic with builder emission and strict verification.  
   **Proposed:** **“Add loop utilization to RunArtifact so reports read verified artifact data instead of a side channel”**

5. **Plan:** “Render the loop-utilization column in the comparison report so a measurement without a column is invisible”  
   **Decision:** Revise. The why should state the interpretability/saturation outcome.  
   **Proposed:** **“Render both loop-utilization scopes and saturation caveats so protocol comparisons expose consumer load”**

6. **Plan:** “Thread the new loopUtilization fields through the frozen test helpers so the F4 pattern keeps every frozen test site in step”  
   **Decision:** Revise and merge with the required-field commit.  
   **Proposed:** **“Update frozen arm fixtures with both loop-utilization scopes so the required measurement shape remains covered”**

7. **Plan:** “Update the CampaignExecution.measureArm sync boundary to carry loopUtilization so the async leg reaches the artifact consumer”  
   **Decision:** Reject and replace; preserving a sync boundary is the defect.  
   **Proposed:** **“Await measured legs at the CampaignExecution boundary so asynchronous transport results reach arm artifacts”**

## Approval conditions

Phase 2.4 may proceed only after the execution deviation states all of the following:

1. `CampaignExecution.measureArm` is asynchronous; no one-shot buffer is introduced.
2. The remote source is a bounded, correlated sidecar abstraction, not a live `ServerHandle` passed across processes.
3. WS and WT retain completed-session busy time and tests snapshot after close.
4. Required arm fields and frozen helpers land atomically.
5. Artifact schema, builder emission, exact-key verification, and fixture updates land atomically.
6. The fixed `0.3` threshold is owned by immutable report config and only raw per-session utilization triggers the caveat.
7. New modules receive explicit official-I/O classifications and resolved-import updates.
