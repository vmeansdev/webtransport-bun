# Phase 2.4 critic review — WS↔WT loop-utilization wiring

Reviewed plan: `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md:417-544`  
Reviewed tree: `codex/ws-scenario-comparison` at the current worktree  
Review mode: adversarial, repository-evidence first

## 1. Verdict

**REJECTED.**

The objective is sound, but the seven-task implementation contract is not executable as written. The blocking defects are:

1. The source contract is misstated. `ServerHandle.snapshot()` already returns a server aggregate under the singular `TransportMetrics.loopUtilization` key for WS, while WT returns a literal `{ busyMs: 0, windowMs: 0 }`. There is no separate public server-aggregate shape.
2. The existing WS aggregate loses all busy time as soon as a session closes, and the WT server handle retains no wrapped sessions from which to aggregate. Merely exposing the current getters would publish false or incomplete values.
3. The remote source protocol is absent. `host-sidecar.ts` has no transport, framing, correlation, cadence, or timeout contract, and the client process cannot possess the Linux server's in-process `ServerHandle`.
4. Task 2.4.7 asks a synchronous adapter to turn an asynchronous measurement into a synchronous request. No pure adapter can synchronously unwrap `Promise<MeasuredLeg>`. The current campaign has no pre-collected-leg store that would make this possible.
5. The task order cannot keep one green commit per task. Task 2.4.2 makes an arm field required before Task 2.4.6 updates its producers. Task 2.4.3 makes verification require an artifact key before Task 2.4.4 adds that key to `RunArtifact` and builder output.
6. Three of the five explicitly named test files do not exist at `HEAD`, nor do the three “additional helper” example files. The actual schema and fixture blast radius is in other files the plan does not name.
7. The plan calls per-session utilization “the comparison metric,” but current comparison/ranking code consumes `artifact.metrics`, not loop utilization. The only specified consumer is report display/caveating. That terminology invites the wrong scope to be fed into ranking.

Confidence is **high** for all seven blockers: each follows from direct types, producers, call sites, tests, or the requested historical commit. The exact remote wire design is **unknown** because the plan and code do not define one.

## 2. Silent default audit

The governing rule must be: absence of either measured scope is a typed refusal, never a numeric substitute. Positive `windowMs` validation proves only that a denominator exists; it does not prove the producer observed it.

| Task | Silent value an implementation can fabricate | Evidence and failure mode |
|---|---|---|
| **2.4.1 Source hop** | WT currently reports `busyMs: 0, windowMs: 0` for every server, regardless of traffic. WS can report `busyMs: 0` after a completed session even when the session was busy. A sidecar implementation can also substitute zero, a stale last-known snapshot, or the client-session snapshot when the remote value is absent. | `adapters/wt.ts:1591-1616` contains the literal placeholder. In WS, close removes the session at `adapters/ws.ts:2267-2274`; `mergeMetrics` at `:257-280` does not preserve loop utilization; the getter sums only `this.sessions` at `:2205-2217`. Thus the current aggregate drops completed-session work. |
| **2.4.2 ArmMeasurement** | The current arm seam already permits absence and later turns it into `{ busyMs: 0, windowMs: 0 }`. A naive nested migration can duplicate the per-session value into `serverAggregate`, or default either child independently. Both produce plausible numbers nobody measured. | `run-campaign.ts:419-422` makes the current singular field optional. `buildMeasuredArmArtifact` uses `measurement.loopUtilization ?? { busyMs: 0, windowMs: 0 }` at `:1158-1161`. The replacement must delete this fallback, not nest it. |
| **2.4.3 BuildArtifactInput and validation** | A fixture-wide `{ busyMs: 0, windowMs: 1 }` satisfies both `windowMs > 0` checks while measuring nothing. Validation can also coerce missing/non-finite values with `?? 0`, `Number(...)`, or `Math.max(1, ...)`. | `BuildArtifactInput.loopUtilization` is currently optional and singular at `artifact-builder.ts:317-326`. No existing assertion ties it to provenance. A positive denominator is necessary but not sufficient. `busyMs: 0` can be a legitimate observation; the lie is inventing its window. |
| **2.4.4 RunArtifact schema** | Schema emission can serialize the Task 2.4.2/2.4.3 fallback or two copies of one scope and make fabrication look authoritative. Keeping schema version `v1` while changing the exact required top-level key set can also make old v1 objects silently “legacy” in one consumer and invalid in another. | `RunArtifact` has no field at `evidence.ts:1076-1124`. Builder output at `artifact-builder.ts:1081-1111` omits the current input entirely. The verifier uses an exact top-level key list at `verify-artifact.ts:103-132`. |
| **2.4.5 Renderer** | Missing data can become `0%`, `-`, `NaN` that simply fails the `> 0.3` check, or a rounded display value used for the caveat. Any of these silently produces “not saturated.” A nonexistent “report config” can become an undocumented hard-coded fallback. | `renderMarkdownReport` accepts only `ComparisonSummary` at `render-report.ts:82`; neither `ComparisonSummary` (`:64-71`) nor `ReportIdentity` (`:147-153`) contains report config. Current compatible rows have no utilization fields (`:97-121`). |
| **2.4.6 Frozen helpers** | Adding the same canned `{ perSession: {0,1}, serverAggregate: {0,1} }` to every helper makes all validation green while asserting that a fabricated millisecond was measured. Driver-backed tests can also use the real client leg for both scopes, which falsely labels a client-session observation as server aggregate. | `statedArmMeasurement` is intentionally a stated fixture (`r1-flow-hardening.test.ts:262-328`), while `driver-core.test.ts` has real connected server handles. These classes need visibly different fixture strategy: explicit fixture constants for stated tests, real server snapshots for honest-chain tests. |
| **2.4.7 Sync boundary** | A “sync adapter” can only use a cached leg, a promise object cast as a value, or a prefilled default. A cache introduces stale/cross-execution reuse unless keyed and consumed exactly once. The adapter also cannot derive toolchains, telemetry, grant, or admission from `MeasuredLeg`; defaulting those would fabricate more than loop utilization. | `CampaignExecution.measureArm` is synchronous at `run-campaign.ts:1560-1562`; `runMeasuredLeg` is asynchronous at `client.ts:423-439`. `ArmMeasurementRequest` at `run-campaign.ts:1530-1542` carries only cell/transport/arm/execution, and `runCampaign` contains no leg store or call to `runMeasuredLeg`. |

Additional silent-default defect already present: `BuildArtifactInput.loopUtilization` reaches `buildMeasuredArmArtifact`, but `buildRunArtifact` never places it in the artifact. A caller can believe it was recorded when it was dropped (`run-campaign.ts:1158-1161` versus `artifact-builder.ts:1081-1111`).

## 3. Test breakage audit

### 3.1 Named-file inventory

| File named by the request/plan | Present at `HEAD`? | Result |
|---|---:|---|
| `tools/compare/driver-core.test.ts` | Yes | Multiple real-leg and arm-literal sites break. |
| `tools/compare/r1-flow-hardening.test.ts` | Yes | Two primary arm factories plus downstream tests break. |
| `tools/compare/artifact-builder.test.ts` | **No** | There is no such file to update or run. Actual builder coverage is spread across `evidence.test.ts`, `r1-entrypoint-red.test.ts`, `r1-verdict-wiring.test.ts`, `r1-trust-validators.test.ts`, `toolchain-observation.test.ts`, and `r1-flow-hardening.test.ts`. |
| `tools/compare/verify-artifact.test.ts` | **No** | There is no such file. Actual verifier coverage is primarily `evidence.test.ts`, plus `r1-entrypoint-red.test.ts` and `r1-verdict-wiring.test.ts`. |
| `tools/compare/render-report.test.ts` | **No** | There is no such file. Actual direct renderer tests are `cli.test.ts:182-224` and `r1-entrypoint-red.test.ts:675-691`. |

The nonexistence is not a cosmetic naming problem. A phase gate that says to update these files can be marked complete without touching the tests that actually freeze the contracts.

### 3.2 `driver-core.test.ts`

Five `buildMeasuredArmArtifact` measurement literals need the new arm field:

- `test.each("the %s arm acknowledges every message it admits, on the shared envelope", ...)` at `:1713-1810`: add `loopUtilization.perSession` from `leg.loopUtilization` and `serverAggregate` from the returned `server.snapshot()` at the same measurement boundary.
- `test("carries a measured leg's funnel into the artifact it is judged on", ...)` at `:1996-2050`: same two scopes.
- `test("an honest leg over both real adapter pairs still publishes a delta", ...)` at `:2355-2367`, through `admittedArm` and its literal at `:2297-2347`: same two scopes. The `admittedArm` callback type at `:2258-2263` currently omits `server`, even though both connected-pair helpers return it; that helper signature must change if it is to read the aggregate.
- `test("the audit's forged arm never reaches the comparator", ...)` at `:2374-2410`: its literal must either carry explicit fixture values so it still reaches the intended refusal, or the expected first refusal must change. Supplying made-up “measured” values weakens the test's honesty claim.
- `test("the arm builder refuses a series measured in another unit", ...)` at `:2698-2775`, through `armOn`: add both scopes, with `serverAggregate` taken from the actual server handle returned by `connectedWebSocketPair`.

Nine direct `runMeasuredLeg` test call sites are also in scope if Task 2.4.1 changes that function's input or keeps its return type as required `MeasuredLeg`: `:1732`, `:1885`, `:1924`, `:2015`, `:2223`, `:2279`, `:2541`, `:2661`, and `:2730`. The affected tests are:

- the parametrized acknowledgement test;
- `does not charge a receipt to the application's send funnel`;
- `records one round trip per message over a real adapter pair`;
- `carries a measured leg's funnel into the artifact it is judged on`;
- `the echo peer sends a message back on the kind it arrived on`;
- `an honest leg over both real adapter pairs still publishes a delta` (through `admittedArm`);
- `a measured leg carries a histogram the builder does not have to invent`;
- the parametrized driver-unit refusal test at `:2648`;
- `the arm builder refuses a series measured in another unit`.

Each needs either a `ServerHandle`/snapshot source or a lower-level return type that does not yet claim to be the fully joined `MeasuredLeg`.

### 3.3 `r1-flow-hardening.test.ts`

The plan names only `statedArmMeasurement`, but there are two primary factories:

1. `statedArmMeasurement` at `:262-328`.
2. `measurementOf` at `:1394-1464`.

If the new `ArmMeasurement.loopUtilization` is required, both returned literals fail type-checking until they add:

```ts
loopUtilization: {
  perSession: { busyMs: number, windowMs: number },
  serverAggregate: { busyMs: number, windowMs: number },
}
```

Tests downstream of `measurementOf` include:

- `publishes the clock its samples were taken on into the sealed bytes`;
- `refuses a send progression that does not narrow rather than rewriting it`;
- `spends the grant on the attempt, so a refused arm is unbuildable`;
- `records a lost receipt as a shortfall instead of refusing the arm`;
- `names every stage that exceeds the one above it in its own direction`;
- `derives the verdict from the ledger it records`;
- `the arm builder states a tuple rather than inheriting the promotable default`;
- `an arm that measured nothing is built BLOCKED, not defaulted to PASS/PASS`;
- `an arm whose ledger lost more than the cell injected is built as a MISS`;
- the registry-object and blackout tests that reuse the shared `blackout = measurementOf(0)` value.

Tests downstream of `statedArmMeasurement` or its `grantedMeasurement`/`forgedArm` wrappers include:

- `no arm of the live registry is scored MISS for loss its own cell injects`;
- `every cell records the impairment it is judged against`;
- `a literal-returning producer cannot build an arm, whatever it returns` (its admission-counter helper call);
- `refuses a measurement that is not the one the recorder filed`;
- `the driver's own recorder is accepted by the guard it has to pass`;
- all tests in `R1 flow hardening: a measurement is bound to one execution` that call `grantedMeasurement`: absent grant, wrong execution, replay, expiry, and one-leg reuse;
- all tests in `R1 flow hardening: an arm the supervisor never admitted is not an artifact` that use `forgedArm` or `statedArmMeasurement`: missing admission, wrong execution, wrong grant, rewritten latency total, and malformed/corrupted/wrong-kind admission.

The literals at `:1586` and `:1675` spread `measurementOf`, so fixing only the helper is enough for their shape. The factory at `:2472-2486` and `forgedArm` at `:2728-2758` spread `statedArmMeasurement`, so they inherit its fields. The casted “reintroduced literal producer” at `:2185-2227` is intentionally not an `ArmMeasurement`; it should remain invalid rather than be padded merely to satisfy the new field.

### 3.4 Actual artifact/verifier/renderer breakage outside the named files

Making the field required on `BuildArtifactInput` or exact `RunArtifact` breaks more than the frozen arm helpers:

- `tools/compare/evidence.test.ts`: both `valid-ws-run.json` and `valid-wt-run.json` lack the top-level key, so essentially every verifier/comparator test built on `wsBytes`/`wtBytes` fails exact top-level shape. The `tailArm` builder literal at `:872-910` also needs both scopes.
- `tools/compare/r1-entrypoint-red.test.ts`: builder literals at `:616` and `:836` need both scopes; the sealed artifact/hash expectations change. Its direct renderer summary at `:675` needs artifacts or explicit loop fields if the renderer requires them.
- `tools/compare/r1-verdict-wiring.test.ts`: the shared `artifactInput` at `:10-32` needs both scopes; all tests in the file depend on it.
- `tools/compare/r1-trust-validators.test.ts`: the measured `arm` at `:865-899` and derived builder calls need both scopes if validation reaches that field before the intended F4 refusal.
- `tools/compare/toolchain-observation.test.ts`: shared `base` at `:97-118` needs both scopes if every artifact requires them. The measured-arm subcases need the field without changing their expected earlier refusal ordering.
- `tools/compare/cli.test.ts:188-224`: direct report summary has no artifacts; either the renderer must tolerate missing artifacts on incompatible/non-artifact unit tests or this fixture must gain WS/WT artifacts carrying both scopes.
- `tools/compare/r1-verdict-wiring.test.ts` and the sealed fixtures must be updated atomically with exact-key verifier changes, or the intermediate commit is red.

The two JSON fixtures' `artifactByteSha256` values must be regenerated after the new top-level field is serialized. Any frozen fixture/document hash that embeds those bytes must then be converged by the repository's hash scripts; the plan does not name that work.

### 3.5 ArmMeasurement literals outside `tools/compare/`

Repository-wide TypeScript search found **no test outside `tools/compare/` that imports or constructs `ArmMeasurement`**. The only files containing the `ArmMeasurement` type or its builders are `tools/compare/run-campaign.ts`, `tools/compare/driver-core.test.ts`, `tools/compare/r1-flow-hardening.test.ts`, and a documentation mention in `stats.ts`.

## 4. Frozen helper and test thread-through (F4) audit

The extra helper files suggested in the question do not exist in this tree:

- `r0-flow-hardening.test.ts` — absent;
- `compare-run.test.ts` — absent;
- `admission-record.test.ts` — absent.

There are therefore no additional `ArmMeasurement` literals in those files. The additional real helper is `measurementOf` in `r1-flow-hardening.test.ts:1394-1464`. In `driver-core.test.ts`, there is no helper named `buildMeasuredArmArtifact`; rather, there are five callers with inline `measurement` literals. The most important nested helper is `admittedArm` at `:2258`, whose callback type currently erases the returned `server` handle.

Commit `2fb90c13` does not establish the precedent claimed by Task 2.4.6. Its actual F4 pattern was:

- add optional `supervisorToolchainDigests` fields to `BuildArtifactInput` and the `buildMeasuredArmArtifact` input;
- make those fields required-in-fact only for provenanced arms through a new binding assertion;
- update every existing `buildMeasuredArmArtifact` call in the same commit;
- leave `ArmMeasurement`, `MeasuredLeg`, and `CampaignExecution.measureArm` signatures unchanged.

The commit message explicitly says all frozen callers were updated in that same commit. Phase 2.4 instead proposes a required nested field in Task 2.4.2, leaves its frozen producers broken until Task 2.4.6, and changes the campaign boundary in Task 2.4.7. That is not “no signature change.”

At test-helper level:

- `statedArmMeasurement` can technically retain its parameter signature only by hard-coding a named fixture observation inside it. That is still a new semantic default and must be explicit as fixture data, not presented as measured.
- `measurementOf` has the same problem.
- `admittedArm` **does require a signature change** if it is to use the server handle already returned by the connected-pair factories.
- Any change that adds `server` to `runMeasuredLeg` is a signature change at nine test call sites.

Therefore Task 2.4.6's F4 framing is false. Required-field producers and their frozen helpers must land atomically, and the commit description must admit the affected helper/input signatures.

## 5. Backward-compatibility and complete code-hit audit

### 5.1 Existing public shape

`TransportMetrics` declares one required field:

```ts
// adapters/transport.ts:125-128
readonly loopUtilization: {
  readonly busyMs: number;
  readonly windowMs: number;
};
```

Both `Session.snapshot()` and `ServerHandle.snapshot()` return that same type (`adapters/transport.ts:313` and `:319`). This overloads one property name with two scopes:

- a session snapshot means per-session;
- a WS server snapshot means server aggregate (`adapters/ws.ts:2402-2428`);
- a WT server snapshot means placeholder zeros (`adapters/wt.ts:1591-1616`).

Task 2.4.1(a) is therefore inaccurate when it says the public server snapshot exposes only per-session data. The server snapshot already exposes aggregate data under an ambiguously named field. The required design decision is whether to introduce a distinct `ServerMetrics`/`ServerSnapshot`, add `serverLoopUtilization` alongside the existing key, or rename the server key with a compatibility migration. “Make it public” does not resolve this.

Making the WS class getter public changes TypeScript visibility but not the `ServerHandle` interface. No external caller can use `server.serverLoopUtilization` through a `ServerHandle` unless the interface also changes. Conversely, adding an enumerable property to the snapshot changes JSON/spread shape for any untyped caller.

Existing direct server-snapshot callers are:

- `adapters/wt.test.ts:452` and `:1136` — only inspect absence of applied-config fields;
- `adapters/ws.test.ts:456` and `:1335` — inspect `sessionsClosed`;
- `adapters/ws.test.ts:634` — this is a session snapshot, not a server snapshot.

They use `toMatchObject`/field checks, so an additive field is unlikely to break them. Renaming/removing the existing `loopUtilization` field would break the shared `TransportMetrics` contract and WT loop-utilization tests.

### 5.2 Every TypeScript hit for the requested terms

Repository-wide `rg` over `*.ts` found the following. There are no TypeScript hits outside `tools/compare/`.

**Core `loopUtilization` producers/contracts/consumers**

- `adapters/transport.ts:125` — the singular `TransportMetrics` field.
- `adapters/ws.ts:899`, `:2002` — per-session getter and session snapshot.
- `adapters/ws.ts:2205`, `:2212`, `:2427` — private server getter, sum of session busy time, and server snapshot emission.
- `adapters/wt.ts:820`, `:957`, `:1000`, `:1062-1069`, `:1083`, `:1117`, `:1267`, `:1401`, `:1505` — per-session ingest producers and snapshots.
- `adapters/wt.ts:1615` — server placeholder `{ busyMs: 0, windowMs: 0 }`.
- `client.ts:304`, `:517` — `MeasuredLeg` field and session-snapshot source.
- `run-campaign.ts:419`, `:1081`, `:1158-1161` — optional singular arm/input shape and zero fallback.
- `artifact-builder.ts:323` — optional singular builder input, currently unused in artifact output.

**Tests of raw busy/window values**

- `adapters/wt.test.ts:969-972`, `:981-984` — session snapshot window/busy assertions. These do not test the server placeholder at `wt.ts:1615`.

**Same word, different metric**

- `artifact-builder.ts:84`, `evidence.ts:1046`, `verify-artifact.ts:2666`, and `r1-entrypoint-red.test.ts:886` refer to host telemetry `loopUtilizationPercent`, not the new raw `{busyMs, windowMs}` artifact field. Task 2.4.3's cited verifier anchor `verify-artifact.ts:2647` begins `verifyTelemetry`; putting the new validator there would conflate two different signals.

**Unrelated `.windowMs` hits**

- `bin/compare-controller.ts:230-232`, `:239`, `:480` are bounded deadline-window validation and standard-deadline lookup. They are not loop-utilization consumers.

There are no existing external reads of `serverLoopUtilization`; the only hits are the WS private getter and its internal snapshot use. There is also no existing artifact/report consumer of raw `busyMs`/`windowMs`.

## 6. Sync-boundary audit — Task 2.4.7

The new adapter cannot be both the async collector and a synchronous converter.

Current facts:

```ts
// client.ts:423-439
export async function runMeasuredLeg(...): Promise<MeasuredLeg>

// run-campaign.ts:1560-1562
export interface CampaignExecution {
  measureArm(request: ArmMeasurementRequest): ArmMeasurement;
}
```

The primary and overlay sites (`run-campaign.ts:1661-1674` and `:1720-1733`) call the injected execution seam synchronously. They do **not** collect a leg beforehand. `run-campaign.ts` does not import `runMeasuredLeg`, does not call `measureLegOverAdapter`, and has no map/queue of already collected legs. The comment at `:1554-1558` says driver output crosses into the controller “as data,” but no concrete join is implemented here.

Therefore:

- If `MeasuredLegToArm` performs leg collection, `CampaignExecution.measureArm` must return `Promise<ArmMeasurement>` and both call sites must `await` it. `runCampaign` is already `async`; the nested `for` loops do not need to become “re-entrant.” A normal `await` preserves sequential execution and the existing `executionIndex` order. Every await needs an explicit deadline per the repository rule.
- If `MeasuredLegToArm` is only the `MeasuredLeg` → `ArmMeasurement` join, it should be a pure synchronous function that receives an already resolved `MeasuredLeg` plus all supervisor-owned context needed by `ArmMeasurement` (toolchains, telemetry, grant, admission, and server aggregate). A separate asynchronous execution implementation must collect those inputs before calling it.
- The plan's phrase “takes the async `MeasuredLeg` and produces a sync `ArmMeasurementRequest`” reverses the data direction. A `MeasuredLeg` is a resolved value; `Promise<MeasuredLeg>` is async. An adapter cannot synchronously unwrap the latter. Also, `ArmMeasurementRequest` is currently the campaign's input request, not the measured output shape.

The plan must choose one architecture. The current code supports neither a pre-collected synchronous lookup nor an in-loop async collector. Preserving the sync signature by hidden buffering would create ordering, replay, stale-value, and cleanup states solely to avoid an interface change.

## 7. Sidecar transport shape — Task 2.4.1(d)

`host-sidecar.ts` is a 105-line pure validator for FD and ephemeral-port capacity. Its only imports are in `orchestration.test.ts`; it has no controller/server channel. It is classified as `controllerOnlyTs` in `official-io-allowlist.json`, and `check-official-io.ts:3841-3866` freezes the exact controller-only module inventory.

The plan does not answer any of the following:

- **Ownership:** server role process, Linux supervisor, SSH process, or Mac controller?
- **Direction:** request/response pull, completion-triggered control-channel push, or measured-transport push?
- **Framing:** schema/version, length prefix or delimiter, maximum frame size, encoding, and partial-read behavior.
- **Correlation:** campaign ID, run ID, execution index, transport, arm kind, repetition, session/leg ID, and sequence number.
- **Timing:** snapshot before or after client close; before or after server session removal; baseline/delta versus cumulative server-lifetime value.
- **Cadence:** one snapshot per leg, polling interval, or periodic stream.
- **Failure behavior:** deadline, EOF, duplicate, missing, stale, out-of-order, wrong-arm, and oversized frame codes.
- **Trust:** who attests the server value and how the controller binds it to the same execution as the client leg.
- **I/O classification:** updates to `official-io-allowlist.json`, exact class inventory, and resolved static imports for any new protocol/endpoint module.

A server-opened WT uni-stream push is especially unsafe: there is no symmetric WS mechanism, it adds traffic to the measured transport, and the plan specifies no frame format. It would contaminate the very comparison it is meant to explain. The existing remote-supervisor design already describes SSH stdin/stdout as a controller↔supervisor control channel (`remote-supervisor.ts:270-276`, `:518-529`), so a separate bounded control-plane record is the plausible home—but that route is not wired to the server role process today.

A controller pull also cannot be evaluated because there is no polling cadence or command/response schema. Polling is unnecessary for the stated artifact: one correlated snapshot at leg completion (or explicit before/after snapshots if a server is reused) is enough. If the server lifetime spans repetitions, cumulative `busyMs/windowMs` must not be mislabeled as per-leg data; a baseline/delta contract is required.

Verdict for 2.4.1(d): **unknown protocol, therefore not implementable from the plan.**

## 8. Architectural-coupling audit

Not every caller of `runMeasuredLeg` has a `ServerHandle`.

- Production `measureLegOverAdapter` currently receives only a `TransportAdapter` and connects a client session (`client.ts:529-567`). Its CLI call at `client.ts:1048-1068` likewise has no local server handle because the server is a separate process/host.
- The nine direct test calls in `driver-core.test.ts` pass only sessions, plan, clock, timeout, and contract.
- The two connected-pair test helpers do create and return a server handle (`driver-core.test.ts:1468-1515` and `:1545-1664`), but several consumers destructure it away, and `admittedArm`'s callback type erases it.
- `ScenarioExecutorInput` at `client.ts:719-734` contains a session but no server source. All executor methods promise `MeasuredLeg`.

This creates a type contradiction in Task 2.4.1:

1. The plan makes `MeasuredLeg.serverLoopUtilization` required.
2. `runMeasuredLeg` currently returns `Promise<MeasuredLeg>` but has no server source.
3. The plan says only outer `measureLegOverAdapter` accepts `ServerHandle` and reads it.

The outer function cannot add the field after `runMeasuredLeg` returns if the inner function must already satisfy the required `MeasuredLeg` type. Safe choices are:

- introduce a lower-level `MeasuredSessionLeg` returned by `runMeasuredLeg`, then join it with a `ServerLoopUtilizationSource` in the outer orchestration layer; or
- pass a narrow server snapshot source into `runMeasuredLeg` and update every call site; or
- keep the server aggregate out of `MeasuredLeg` and place the join at the arm boundary.

The plan names none of these. Passing a raw `ServerHandle` is also the wrong abstraction for the rig because it cannot cross a process/host boundary. A narrow asynchronous snapshot source can have local-handle and remote-control-channel implementations.

## 9. Phase-4 consumer contract

The actual numeric comparison consumer is `compare.ts`, which verifies artifacts and compares the primary `metrics` series/contract. It has no `loopUtilization` hit. The renderer builds `CellComparison` with `wsArtifact` and `wtArtifact` (`render-report.ts:282-297`), so the planned raw-utilization consumers are:

- **per-session:** display both arms and evaluate the saturation caveat;
- **server aggregate:** display both arms for transparency only.

No current or planned code path in Phase 2.4 feeds per-session utilization into delta/ranking. Calling it “the comparison metric” is therefore misleading. It is an **interpretability/caveat signal** unless the plan explicitly changes comparison eligibility or ranking.

There is a concrete scope-confusion risk:

- The current server snapshot calls its aggregate `loopUtilization`.
- The current measured leg calls its session value `loopUtilization`.
- The planned artifact nests both under another `loopUtilization`.
- A renderer helper that accepts only `{busyMs, windowMs}` has no type-level indication of scope.

The report logic must access explicit paths: `artifact.loopUtilization.perSession` for caveat computation and `artifact.loopUtilization.serverAggregate` only for display. Tests must make the two values deliberately different, including a case where only server aggregate exceeds 0.3, so using the wrong scope fails.

The plan also conflicts with its own principle at `:73-77`: it says above 30% the comparison “is no longer a protocol comparison,” yet Task 2.4.5 merely adds a caveat. It does not say whether ranking/delta remains visible, becomes non-promotable, or is withheld. Phase 4 cannot have an actionable contract until that consequence is explicit.

## 10. Saturation caveat audit

`0.3` is a **dimensionless fraction** of `busyMs / windowMs`, i.e. **30% busy time**, not `0.3%`. A report should display it as `30%` (or `0.300`) and label the unit unambiguously. The comparison is strict: `ratio > 0.3` is saturated; equality is not.

The current operational definition in the plan is only an assertion: “above 30% busy time on the consumer side, the consumer is becoming the bottleneck.” The code measures synchronous envelope-processing time after idle receive, not total host CPU or event-loop delay (`wt.ts:874-908`; WS has an analogous counter). That signal can support a caveat, but the tree contains no calibration proving 30% is a bottleneck boundary.

An actionable definition needs all of the following:

1. Scope: raw `perSession`, never `serverAggregate`.
2. Formula: `busyMs / windowMs`, computed before display rounding.
3. Validity: finite `busyMs >= 0`, finite `windowMs > 0`; ideally `busyMs <= windowMs` for a true single-session fraction, or a documented reason if the WT datagram/envelope sum can exceed the common window.
4. Boundary: strictly greater than `0.3`; test exactly `0.3` and a representable value above it.
5. Consequence: state whether the row remains ranked with a warning, is non-promotable, or is excluded from protocol conclusions. “Saturated caveat” alone tells a reader no action.
6. Text: name the affected arm and scope, e.g. “WT per-session receive-loop utilization 34%; protocol attribution is caveated.”
7. Provenance: the immutable threshold value must be visible in report configuration/output. There is currently no report config object.

The server aggregate may legitimately exceed 1.0 when busy time is summed across concurrent sessions over one wall-clock window. That is another reason it must not share the per-session saturation rule or be formatted as an ordinary percentage without a scope explanation.

## 11. Required plan corrections before implementation

Approval requires a revised Phase 2.4 contract that:

1. Defines separate session and server snapshot types/scopes without pretending the current `ServerHandle` returns per-session data.
2. Preserves completed-session busy time in WS and creates real completed-plus-active accounting in WT, with snapshot-after-close tests.
3. Defines a bounded, correlated, deadline-guarded control-plane snapshot protocol and its official-I/O classifications. It must not use the measured WT/WS data path.
4. Chooses either asynchronous `CampaignExecution.measureArm` with awaited call sites, or a documented pre-collected one-shot store. A sync function may only map already resolved inputs.
5. Introduces a pure leg-plus-supervisor-context → `ArmMeasurement` join; no defaults for either utilization scope.
6. Lands required `ArmMeasurement` fields and every producer/helper in the same green commit.
7. Lands `BuildArtifactInput`, builder emission, `RunArtifact`, exact-key verification, JSON fixture regeneration, and hash convergence atomically. Tasks 2.4.3 and 2.4.4 cannot remain ordered as written.
8. Names the actual test files and adds dedicated server-aggregate, zero-window, wrong-scope, and threshold-boundary tests.
9. Replaces “comparison metric” with “comparison caveat/interpretability signal,” or explicitly specifies how utilization changes ranking/promotability.
10. Defines the operational consequence of saturation and makes `0.3` visibly a 30% raw per-session fraction.

Until those changes are made, the current plan can produce a schema-valid report containing numbers no producer measured, which violates the campaign's first principle.
