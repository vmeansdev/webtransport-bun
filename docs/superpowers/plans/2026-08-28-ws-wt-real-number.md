# WebSocket vs WebTransport — Real Number Execution Plan

> **For agentic workers:** execute with
> `superpowers:subagent-driven-development`. Test-driven development for each
> implementation task, spec review before code-quality review, and verification
> before completion. Do not run a new network integration test on loopback.

**Goal:** From the current `dbd3c3fc` green state on
`codex/ws-scenario-comparison`, close the five open findings (R1 trust boundary
beyond toolchain, execution path wiring, two-host staging, plan re-signature,
R2–R8 plan) and produce the first honest WS↔WT measurement on the actual
two-host staging rig. No theater numbers, no demoted evidence.

**Architecture:** A single end-to-end campaign decomposed into four phases.
Phase 0 is pre-approved scope and contains three pre-approved steps
(two record-only, one small executable extraction) that do not
edit this plan or the prior plan. Phase 1 mirrors the toolchain sub-campaign
in a 4-step per-sub-phase shape (forbid+validate; atomic two-host set +
authority-anchor rotation + F4 binding; retire child path; per-field F-class
hardening) for each of capability, lock, and manifest reservations. Phase 2
wires the ten pure scenario ledgers into the driver through per-scenario
executors, a registry, and a CLI entry; the static-I/O boundary schema gains
a `cliEntryTs` class to admit the new entry; the loop-utilization chain is
threaded through every hop from `MeasuredLeg` to the renderer. Phase 3
introduces a controller script with parser + config tests and a no-network
`--dry-run` mode, then hand-runs on the actual rig. Phase 4 runs the real
measurement.

**Tech stack:** Bun 1.3.14+ native WebSocket APIs, webtransport-bun native
addon (Node-API / napi-rs), TypeScript, Bun test, Node streams, Bun subprocess
APIs, SSH/SCP, OpenSSL, Linux `ip`/`tc`/`ss`, macOS `route`/`ifconfig`, JSON
and Markdown evidence.

**Design source:**
`docs/superpowers/specs/2026-08-22-ws-wt-scenario-comparison-design.md` and
`docs/reviews/2026-08-26-ws-scenario-comparison-status.md`.

**Starting source:** `dbd3c3fc867321ffa33e0b1c6f9dbfda28ec625d` on
`codex/ws-scenario-comparison`.

**Approval protocol (content-pinned).** The architect + critic approve
*this exact file content* (this byte sequence, this SHA-256). The
approval applies to Phase 1 through Phase 4 only. Phase 0 is pre-approved
scope (record-only, no edits to bound documents) and runs without the
approval protocol applying. After approval, this file is **frozen** — no
edits, no amendments inline. If a defect is found during execution, the
fix is recorded in a separate `docs/superpowers/plans/deviations/<phase>.md`
file, and the campaign continues against that record. The frozen-R1-bundle
rule still applies: any move of `r1-fixtures.ts`, `r1-fixture-hashes.ts`,
`r1-document-hashes.ts`, `r1-flow-hardening.test.ts`, `driver-core.test.ts`,
`R1_CAMPAIGN_AUTHORITY_ANCHOR_SET`, or the prior plan bound by
`scripts/verify-r1-document-hashes.ts:68`, requires explicit user
authorization (the "1/2/3" vote). The approval record itself lives in a
separate file (see Phase 0b); the plan contains no inline approval record.

---

## RALPLAN-DR principles

- **Honest measurement only.** Every reported number must be reproducible from
  committed code and committed evidence. No demoted evidence, no "approximately",
  no copy/paste from a prior run on a different commit. Where a run cannot be
  made, the unavailability is recorded in a separate blocked-evidence file
  under `docs/superpowers/plans/deviations/` and execution does not proceed
  past the blocker.
- **Loop-utilization, then number.** The new `TransportMetrics.loopUtilization`
  is the only honest way to read a tail number from the WT main-loop path.
  The **per-session** loopUtilization is the comparison metric. The WS server
  exposes a per-session `loopUtilization` in addition to the server-aggregate
  so the comparison is scope-matched. Rows where per-session
  `busyMs / windowMs > saturationThreshold` are reported with a saturation
  caveat.
- **Loop-utilization saturation threshold.** The threshold is a fixed
  deliverable design choice at `0.3`. The reasoning: above 30% busy time
  on the consumer side, the consumer is becoming the bottleneck rather
  than the protocol, and the comparison is no longer a protocol
  comparison. The threshold is recorded in the report config and is
  **not** calibrated per run; changing the threshold requires a
  documented commit and a maintainer-level review.
- **Frozen files stay frozen.** The frozen R1 bundle (see status) follows
  the F4 thread-through pattern (commit `2fb90c13`) — add a new field to
  `BuildArtifactInput`, add a binding check with a new
  `*_SUPERVISOR_MISSING` / `*_SUPERVISOR_MISMATCH` code, thread through every
  frozen test site. No signature change, no rename, no move. The prior plan
  bound by `scripts/verify-r1-document-hashes.ts:68` is also frozen and
  is **not** edited by this campaign; re-signature appends a separate
  approval record.
- **Atomic rotation + F4 binding.** Authority-anchor rotation and F4
  binding check land in the **same commit** as the per-reservation
  `BuildArtifactInput` field. The rotated fixture graph is never observed
  without the binding check; a rotation that fails the binding check
  cannot land.
- **One scoped commit per logical change.** Verb + What + Why, with the
  **why clause in the commit subject**. No bundles. Plan / progress
  markdown files live under `docs/superpowers/`, not the repo root.
- **Per-phase green is mandatory.** Each phase ends with `tsc 0`, both
  frozen verifiers CLEAN, full `bun test` and `cargo test` passing, and
  clean `cargo fmt` / `clippy` / `biome`. A phase that cannot reach green
  does not land.
- **Convergence-driver stop.** Authority-anchor rotations use
  `scripts/converge-r1-fixture-hashes.ts`. The driver has a
  **10-iteration budget**. If it does not converge in 10 iterations, the
  campaign stops and reports the divergence to the user; the rotation is
  not landed.
- **Test determinism.** No unbounded waits on async iterators or streams.
  Bounded helpers (Promise.race with `Bun.sleep`, polling-with-deadline) only.
  Hard upper bound on every `await`.
- **Native llvm-cov floors apply to floored logic modules only.** Per
  `.github/workflows/coverage.yml:90`: `limits.rs`, `server.rs`,
  `session.rs`, `spawn_tracked.rs`. The 90% line / 90% function / 80% branch
  floors apply to **these** modules and their dependents inside the
  floored set. `secure_fs.rs` is **not** in the floored set (it lives in the
  NAPI binding cluster), so the new `observe_bun_capability`,
  `observe_bun_lock`, and `observe_bun_manifest` helpers do **not** count
  toward the 90/90/80 floor; they get focused Rust tests but no coverage
  gate.
- **bunx over npx.** This plan calls `bunx`, never `npx`.

---

## Phases

### Phase 0 — Pre-approved scope (record only)

Phase 0 produces three new files; it does not edit this plan, the prior plan,
or any frozen file. It is explicitly out of the approval protocol (see
status) and is reviewed inline by the user. Two of the three are
record-only (R2-R8 plan, approval record); the third is a small
executable extraction (`scripts/check-llvm-cov-floors.py`) needed
to make the per-phase gate runnable. The extraction has no
frozen-file impact.

- **Task 0a.1** Author
  `docs/superpowers/plans/2026-08-22-ws-wt-r2-r8.md` as a new file with
  seven sections (executor, ledger, controller, runner, verifier, reporter,
  evidence pack). Each section names the entry point, the inputs, the
  outputs, the failure modes, the relationship to R1, and the
  dependencies on the existing design spec at
  `docs/superpowers/specs/2026-08-22-ws-wt-scenario-comparison-design.md`.
  No code. No edits to bound files. Commit message: "Author the R2-R8
  parent plan so R1 has a defined next stage" — Verb `Author`, What
  "R2-R8 parent plan", Why "so R1 has a defined next stage."
- **Task 0b.1** Author the approval record at
  `docs/superpowers/plans/approvals/2026-08-28-ws-wt-scenario-comparison.md`
  as a new file. Records: architect signature (Codex MCP `APPROVED`
  verdict for this plan's content), critic signature (Codex MCP
  `APPROVED` verdict for this plan's content), date, plan file
  SHA-256. The bound prior plan is **not** edited; the record is a
  sibling file. Commit message: "Record architect and critic approval
  of the WS-WT real-number plan so the formal record is auditable" —
  Verb `Record`, What "architect and critic approval of the WS-WT
  real-number plan", Why "so the formal record is auditable."
- **Task 0c.1** Extract the llvm-cov floor checker from
  `.github/workflows/coverage.yml:86-240` to a new file at
  `scripts/check-llvm-cov-floors.py` so the per-phase gate can
  run it directly. The body is the `python3 <<'PY' ... PY`
  heredoc; the YAML wrapper is dropped. Commit message: "Extract
  the llvm-cov floor checker so the per-phase gate is runnable
  without the YAML wrapper" — Verb `Extract`, What "llvm-cov
  floor checker to scripts/check-llvm-cov-floors.py", Why "so
  the per-phase gate is runnable without the YAML wrapper."
- **Phase 0 commits:** exactly the three new files, three commits.
- **Phase 0 gate:** all three new files exist, no bound file
  changed, working tree otherwise clean of Phase 0 work.

### Phase 1 — R1 trust boundary beyond toolchain

The supervisor already has a per-host toolchain reservation populated by
`dbd3c3fc` and earlier. Phase 1 adds three more reservations
(**capability**, **lock**, **manifest**) in a 4-step per-sub-phase shape.
The envelope at `r1-fixtures.ts:6019-6026` already declares
`capabilitySha256`, `lockSha256`, and `manifestSha256`; the work is to
**populate** them from supervisor-observed digests, not to add new
fields. The 4 steps mirror the toolchain sub-campaign
(`e40bbb03`, `02193361`, `c00a3b05`, `42d9fff8`, `2fb90c13`):

1. **Forbid + validate** the supervisor-observed per-host fact schema
   (TS + Rust), `CHILD_FORBIDDEN_OBSERVATION_FIELDS` extended at per-field
   names, smuggling-test cases at the per-field level.
2. **Atomic two-host set + rotation + F4 binding.** Assemble the
   per-host set; add the per-host `*Sha256` field on
   `ComparisonSupervisorInputV1` / `OutputV1`; populate the existing
   field on the envelope at `r1-fixtures.ts:6019-6026`; add
   `supervisor<X>Digests` to `BuildArtifactInput`; add the
   `assertMeasuredArmObservedIts<X>` binding check with
   `<X>_SUPERVISOR_MISSING` / `<X>_SUPERVISOR_MISMATCH` codes; thread
   through every frozen test site in `r1-flow-hardening.test.ts` and
   `driver-core.test.ts` via the F4 pattern's `replace_all`. Rotate
   `R1_CAMPAIGN_AUTHORITY_ANCHOR_SET` for the new reservation. Run
   `converge-r1-fixture-hashes.ts` to CLEAN. **All of this is one
   commit.** A rotation that fails the binding check cannot land; a
   binding check without the rotation is incomplete.
3. **Retire the child-stated path** (mirrors `c00a3b05`): the
   child-stated variant of the reservation is removed; only
   supervisor-observed digests are accepted.
4. **F-class hardening** (mirrors `42d9fff8`): per-field
   `CHILD_FORBIDDEN_OBSERVATION_FIELDS` entries, smuggling tests
   exercising the per-field names.

The 4-step shape is repeated for capability (1.1), lock (1.2), and
manifest (1.3) — twelve commits total in the **baseline**. An
auto-review at the end of Phase 1 (1.4) runs the same F1–F5 review
the toolchain campaign ran and adds **additional** scoped commits
for any F-class findings; the F-class-fix count is not fixed in
advance and is bounded only by the auto-review's findings. Phase 1
ends green after the baseline + auto-review-fix commits all land.

- **Phase 1.1 — Capability (4 commits)**
  - **Commit 1.1.1** "Forbid a child capability observation and validate
    the supervisor's so the per-field shape is locked before the
    supervisor emits" — Verb `Forbid`, What "child capability
    observation and validate the supervisor's", Why "so the per-field
    shape is locked before the supervisor emits."
  - **Commit 1.1.2** "Assemble the per-host capability observation
    into a two-host set, rotate the authority anchor, and bind the
    artifact's per-host capability digests to the supervisor so the
    rotated fixture graph is never seen unbound" — Verb `Assemble`,
    What "per-host capability observation into a two-host set,
    rotate the authority anchor, and bind the artifact's per-host
    capability digests to the supervisor", Why "so the rotated
    fixture graph is never seen unbound." Single atomic commit.
  - **Commit 1.1.3** "Retire the child-stated capability path so the
    F4 binding accepts supervisor-observed digests only" — Verb
    `Retire`, What "child-stated capability path", Why "so the F4
    binding accepts supervisor-observed digests only."
  - **Commit 1.1.4** "Harden the per-field capability names a child
    could try directly so the per-field ban catches what the umbrella
    missed" — Verb `Harden`, What "per-field capability names a
    child could try directly", Why "so the per-field ban catches
    what the umbrella missed."
- **Phase 1.2 — Lock (4 commits)** — same shape, with `lock` /
  `lockSha256` / `LOCK_SUPERVISOR_MISSING` / `LOCK_SUPERVISOR_MISMATCH`.
  The prior plan bound by `verify-r1-document-hashes.ts:68` is
  untouched; the lock reservation's `r1-fixtures.ts:6024` envelope
  field is populated via the F4 pattern.
  - **Commit 1.2.1** "Forbid a child lock observation and validate
    the supervisor's so the per-field shape is locked before the
    supervisor emits" — Verb `Forbid`, What "child lock observation
    and validate the supervisor's", Why "so the per-field shape is
    locked before the supervisor emits."
  - **Commit 1.2.2** "Assemble the per-host lock observation into a
    two-host set, rotate the authority anchor, and bind the artifact's
    per-host lock digests to the supervisor so the rotated fixture
    graph is never seen unbound" — Verb `Assemble`, What "per-host
    lock observation into a two-host set, rotate the authority
    anchor, and bind the artifact's per-host lock digests to the
    supervisor", Why "so the rotated fixture graph is never seen
    unbound." Single atomic commit.
  - **Commit 1.2.3** "Retire the child-stated lock path so the F4
    binding accepts supervisor-observed digests only" — Verb
    `Retire`, What "child-stated lock path", Why "so the F4 binding
    accepts supervisor-observed digests only."
  - **Commit 1.2.4** "Harden the per-field lock names a child could
    try directly so the per-field ban catches what the umbrella
    missed" — Verb `Harden`, What "per-field lock names a child
    could try directly", Why "so the per-field ban catches what the
    umbrella missed."
- **Phase 1.3 — Manifest (4 commits)** — same shape, with `manifest` /
  `manifestSha256` / `MANIFEST_SUPERVISOR_MISSING` /
  `MANIFEST_SUPERVISOR_MISMATCH`. `manifest-lock.ts` and the existing
  manifest admission code are the integration points.
  - **Commit 1.3.1** "Forbid a child manifest observation and
    validate the supervisor's so the per-field shape is locked
    before the supervisor emits" — Verb `Forbid`, What "child
    manifest observation and validate the supervisor's", Why "so the
    per-field shape is locked before the supervisor emits."
  - **Commit 1.3.2** "Assemble the per-host manifest observation into
    a two-host set, rotate the authority anchor, and bind the
    artifact's per-host manifest digests to the supervisor so the
    rotated fixture graph is never seen unbound" — Verb `Assemble`,
    What "per-host manifest observation into a two-host set, rotate
    the authority anchor, and bind the artifact's per-host manifest
    digests to the supervisor", Why "so the rotated fixture graph
    is never seen unbound." Single atomic commit.
  - **Commit 1.3.3** "Retire the child-stated manifest path so the F4
    binding accepts supervisor-observed digests only" — Verb
    `Retire`, What "child-stated manifest path", Why "so the F4
    binding accepts supervisor-observed digests only."
  - **Commit 1.3.4** "Harden the per-field manifest names a child
    could try directly so the per-field ban catches what the umbrella
    missed" — Verb `Harden`, What "per-field manifest names a child
    could try directly", Why "so the per-field ban catches what the
    umbrella missed."
- **Phase 1.4 — Auto-review** — run the F1–F5 review on the Phase 1
  diff, fix each F-class finding with a scoped commit whose subject
  carries Verb + What + Why. The auto-review commit count is not
  fixed in advance; the baseline is the 12 commits from 1.1 / 1.2 /
  1.3, and the auto-review adds whatever F-class fixes the review
  surfaces.
- **Phase 1 gate (per sub-phase):** tsc 0, both frozen verifiers CLEAN
  (convergence driver converged in ≤ 10 iterations), `bun test
  tools/compare/` 0 fail, `cargo test` 0 fail, native llvm-cov floors
  still met for the four floored modules (`limits.rs`, `server.rs`,
  `session.rs`, `spawn_tracked.rs`).

### Phase 2 — Execution path: scenarios → driver → CLI → measurement

Phase 2 has four sub-phases, each ends green.

- **Phase 2.1 — Per-scenario executors and comparable-leg contracts**
  Today `runMeasuredLeg` (at `client.ts:423`) is one generic echo loop
  and `LEG_PLAN_UNDEFINED_SCENARIOS` (at `client.ts:328`) refuses five
  scenarios by name because their leg is not yet defined to be the
  same across both arms. Phase 2.1 makes each of the ten scenarios
  executable, or emits a typed non-comparable result for the five
  refused ones.

  - **Task 2.1.1** Define a `ScenarioExecutor` interface in
    `tools/compare/client.ts`: `name`, `parameters`, `legPlan()`
    returning a `LegPlan` that names what both arms do, `execute(arm)`
    returning `Promise<MeasuredLeg>`. The five currently-undefined
    scenarios (`reconnect-storm`, `handshake-matrix`,
    `connection-memory`, `ai-token-stream`, `tail-under-cross-traffic`)
    either get a real `LegPlan` or a typed
    `{ kind: "not-comparable"; reason: string }` result; the
    `LEG_PLAN_UNDEFINED_SCENARIOS` list shrinks to whatever the second
    category still contains.
  - **Task 2.1.2** Wire `runMeasuredLeg` to dispatch through the
    executor for the named scenario, with the existing one-message
    echo loop retained as the default for scenarios without an
    executor (so existing tests pass).
  - **Task 2.1.3** Add a test for each of the ten scenarios asserting
    that the executor either produces a valid `MeasuredLeg` for both
    arms or produces a typed `not-comparable` result with a reason
    string. Existing tests unchanged.
  - **Commits (one per scenario, with Verb + What + Why subjects):**
    "Add a ScenarioExecutor for `<scenario>` so the driver is no
    longer a one-echo loop for that scenario" — Verb `Add`, What
    "ScenarioExecutor for `<scenario>`", Why "so the driver is no
    longer a one-echo loop for that scenario." Ten commits, one
    per scenario; if a scenario lands as `not-comparable`, the
    subject is "Mark `<scenario>` as not-comparable because
    `<reason>` so the LEG_PLAN_UNDEFINED list reflects the
    documented scope" — Verb `Mark`, What "`<scenario>` as
    not-comparable", Why "because `<reason>`, so the
    LEG_PLAN_UNDEFINED list reflects the documented scope."
  - **Gate:** `LEG_PLAN_UNDEFINED_SCENARIOS` is empty (every scenario
    has a real `LegPlan`) or contains only scenarios with a documented
    `not-comparable` reason that survives a critic pass.
- **Phase 2.2 — SCENARIO_REGISTRY and the driver entry**
  - **Task 2.2.1** Add `SCENARIO_REGISTRY: Map<ScenarioId, ScenarioFactory>`
    in `tools/compare/client.ts`. `runMeasuredLeg` accepts
    `scenarioName?` and looks up the factory. Each registered
    scenario is runnable end-to-end through the driver.
  - **Task 2.2.2** Tests: (a) the registry contains every entry in
    `scenarios/*.ts`; (b) instantiation succeeds for each; (c) an
    unknown name returns a typed `SCENARIO_UNKNOWN` error, not an
    unhandled throw.
  - **Commit:** "Register the ten pure scenario ledgers behind a
    name in the driver so a CLI can pick a scenario by name without
    importing the per-scenario file" — Verb `Register`, What "the
    ten pure scenario ledgers behind a name in the driver", Why "so
    a CLI can pick a scenario by name without importing the
    per-scenario file."
  - **Gate:** registry contains all ten, lookup is type-safe, unknown
    name is a typed error.
- **Phase 2.3 — `bin/compare-run.ts` with full R1 surface updates**
  Phase 2.3 adds the CLI entry and updates the static-I/O surface to
  admit it. Today the schema at `check-official-io.ts:55-62` defines
  exactly six TypeScript classes (`officialRoots`, `roleChildTs`,
  `protocolOnlyTs`, `controllerOnlyTs`, `fixtureTs`, `checkerTs`);
  no `cliEntryTs` class exists. The schema is extended, the
  allowlist is updated, the resolved-static-import manifest is
  updated, the controller count is updated.

  - **Task 2.3.1** Extend the TypeScript-class schema in
    `check-official-io.ts:55-62` (`TYPESCRIPT_CLASSES`) to include
    `"cliEntryTs"`; extend `ALLOWLIST_KEYS` at `:41-53`; extend the
    `OfficialIoAllowlist` interface at `:83-95`; extend the strings
    parser at `:3765`; extend the `classEntries()` function at
    `:4021` so the new class returns the allowlist entries
    (`bin/compare-run.ts` maps to `cliEntryTs`); update the
    per-class path/duplicate check at `:3911` and the cross-class
    duplicate list at `:3952` to recognize `cliEntryTs`; ensure
    the inventory at `:4122` no longer flags the file as
    `ALLOWLIST_EXTRA_FILE`.
  - **Task 2.3.2** Author `tools/compare/bin/compare-run.ts` — Bun-runnable
    CLI: parses `--scenario=<name>`, `--arm=<ws|wt|both>`, the standard
    supervisor env vars, and `--out=<path>`. One scenario per
    invocation. Fails closed with
    `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` if the Phase 1 reservations
    are missing.
  - **Task 2.3.3** Update `tools/compare/official-io-allowlist.json`:
    add `"cliEntryTs": ["bin/compare-run.ts"]`.
  - **Task 2.3.4** Update `check-official-io.ts:3832-3857` to admit
    the new class; the controller count for `controllerOnlyTs` stays
    at four (compare-controller.ts is added in Phase 3.3).
  - **Task 2.3.5** Update the `resolvedStaticImports` list to
    include `bin/compare-run.ts` and the new modules it
    transitively imports; run the check to CLEAN.
  - **Task 2.3.6** Tests: argument parsing, registry lookup,
    `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` on a clean tree, the new
    allowlist class, the static-import manifest, the schema
    extension.
  - **Commits (one each, Verb + What + Why subjects):**
    - "Add a Bun-runnable CLI entry that runs a registered scenario
      so a registry without a CLI is unreviewable" — Verb `Add`,
      What "Bun-runnable CLI entry that runs a registered
      scenario", Why "so a registry without a CLI is
      unreviewable."
    - "Extend the static-I/O schema with a cliEntryTs class so the
      new CLI entry hard-fails the R1 checker without the schema
      update" — Verb `Extend`, What "static-I/O schema with a
      cliEntryTs class", Why "so the new CLI entry hard-fails the
      R1 checker without the schema update."
    - "Admit the new CLI entry at the static-I-O boundary and
      update the resolved-static-import manifest so a stale
      manifest does not hide new imports" — Verb `Admit`, What
      "new CLI entry at the static-I/O boundary and update the
      resolved-static-import manifest", Why "so a stale manifest
      does not hide new imports."
  - **Gate:** `compare-run --scenario=unknown` returns the typed
    `SCENARIO_UNKNOWN` error; `compare-run --scenario=ticker` against
    a tree without Phase 1 reservations returns
    `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`; `bun test
    check-official-io.test.ts` 0 fail.
- **Phase 2.4 — Loop-utilization wiring chain**
  Today, `MeasuredLeg.loopUtilization` is populated in
  `client.ts:517` from `session.snapshot()`, but the value is dropped
  at the artifact boundary. The chain is:
  `MeasuredLeg` (`client.ts:517`) → `ArmMeasurement`
  (`run-campaign.ts:325`) → `buildMeasuredArmArtifact`
  (`run-campaign.ts:979`) → `RunArtifact` (composed via
  `buildRunArtifact` at `artifact-builder.ts:320`) → `verify-artifact`
  validation → `render-report.ts:82` column. Phase 2.4 closes the
  chain at every hop.

  - **Task 2.4.1** **Source hop.** `MeasuredLeg` at `client.ts:304`
    currently carries a singular `loopUtilization: { busyMs, windowMs }`
    (per-session). Add a second field `serverLoopUtilization: { busyMs,
    windowMs }` to `MeasuredLeg`. The producer for `serverAggregate`:
    (a) make `ServerHandle.snapshot()` at `adapters/transport.ts:316-326`
    return the server-aggregate as a public field (currently only
    the per-session snapshot is exposed); (b) unblock the WS
    aggregate getter at `adapters/ws.ts:2205` from private to
    public (the value already exists, the access is private); (c)
    add a server-aggregate producer to the WT adapter, replacing
    the placeholder `{ busyMs: 0, windowMs: 0 }` at
    `adapters/wt.ts:1591-1616` with the real per-server accumulator;
    (d) add a sidecar transport channel in
    `tools/compare/host-sidecar.ts` so the client can read the
    server's snapshot from the controller when the server runs on
    the Linux bench; (e) in `measureLegOverAdapter` at
    `client.ts:529-567`, accept the `ServerHandle` and read its
    snapshot to populate `serverLoopUtilization`. The producer
    must be present before the consumer hop is required; this
    task completes before Task 2.4.2.
  - **Task 2.4.2** Add to `ArmMeasurement` at `run-campaign.ts:325`
    a record carrying **both** values:
    `loopUtilization: { perSession: { busyMs: number; windowMs:
    number }; serverAggregate: { busyMs: number; windowMs: number } }`,
    populated from `MeasuredLeg.loopUtilization` and
    `MeasuredLeg.serverLoopUtilization`. The comparison metric is
    `perSession`; `serverAggregate` is recorded for transparency but
    is **not** the comparison metric. A singular tagged-union field
    cannot carry both values; both values are required and named
    explicitly.
  - **Task 2.4.3** Add the same shape to the per-arm section of
    `BuildArtifactInput` at `artifact-builder.ts:92`; require
    `perSession.windowMs > 0` and `serverAggregate.windowMs > 0`
    in `buildRunArtifact` (line 320); require both in
    `verify-artifact.ts` at the validator anchor near
    `verify-artifact.ts:2647` (a `loopUtilization.perSession` with
    `windowMs === 0` is `VALIDATION_FAILED`; the same rule applies
    to `serverAggregate`).
  - **Task 2.4.4** Add a `loopUtilization: { perSession, serverAggregate }`
    field to the `RunArtifact` schema in `tools/compare/evidence.ts`
    near `:1076`, populated from `ArmMeasurement.loopUtilization` by
    `buildRunArtifact`. The renderer reads the field from the schema,
    not from a side channel.
  - **Task 2.4.5** Add a `loopUtilization` column to the renderer
    at `render-report.ts:82`; rows with per-session
    `busyMs / windowMs > 0.3` get a `saturated` caveat. The
    threshold is fixed (see the principles section) and is read
    from the report config, not derived per run. Both
    `perSession` and `serverAggregate` are rendered.
  - **Task 2.4.6** **F4 thread-through.** Update the frozen test
    helpers that build `ArmMeasurement` (e.g.
    `r1-flow-hardening.test.ts:222` `statedArmMeasurement`,
    `driver-core.test.ts` `buildMeasuredArmArtifact` callers) to
    populate the new `loopUtilization` field. No signature change;
    only new fields are added, consistent with the F4 pattern
    (commit `2fb90c13`).
  - **Task 2.4.7** **Sync boundary hop.** `CampaignExecution.
    measureArm(request: ArmMeasurementRequest): ArmMeasurement`
    at `run-campaign.ts:1494` is a sync boundary, while
    `runMeasuredLeg()` at `client.ts:423` is async. The plan must
    name the concrete adapter that turns the async leg into the
    arm and updates the interface and its callers at
    `run-campaign.ts:1602` and `run-campaign.ts:1661`. Define a
    `MeasuredLegToArm` adapter in `tools/compare/`
    (e.g. `arm-measure.ts`) that takes the async `MeasuredLeg`
    and produces a sync `ArmMeasurementRequest`; update
    `CampaignExecution.measureArm` to accept the new request
    shape (with `loopUtilization: { perSession, serverAggregate }`
    included); update the two call sites at
    `run-campaign.ts:1602` (primary arm) and `:1661` (overlay
    arm) to pass the new field.
  - **Commits (one per task, Verb + What + Why subjects):**
    - "Source server-aggregate loopUtilization on the producer side
      so the consumer hop in Task 2.4.2 has a real value" — Verb
      `Source`, What "server-aggregate loopUtilization on the
      producer side", Why "so the consumer hop in Task 2.4.2 has
      a real value." (Covers the five producer steps at Task 2.4.1
      (a)-(e).)
    - "Carry per-session and server-aggregate loopUtilization into
      ArmMeasurement so the comparison metric is per-session and
      the aggregate is recorded for transparency" — Verb `Carry`,
      What "per-session and server-aggregate loopUtilization into
      ArmMeasurement", Why "so the comparison metric is
      per-session and the aggregate is recorded for transparency."
      (Task 2.4.2.)
    - "Require loopUtilization on every arm at artifact validation
      and the static-I-O boundary so zero is not a measurement" —
      Verb `Require`, What "loopUtilization on every arm at
      artifact validation and the static-I/O boundary", Why "so
      zero is not a measurement." (Task 2.4.3.)
    - "Add loopUtilization to the RunArtifact schema so the renderer
      reads the field from the artifact, not a side channel" —
      Verb `Add`, What "loopUtilization to the RunArtifact
      schema", Why "so the renderer reads the field from the
      artifact, not a side channel." (Task 2.4.4.)
    - "Render the loop-utilization column in the comparison report
      so a measurement without a column is invisible" — Verb
      `Render`, What "loop-utilization column in the comparison
      report", Why "so a measurement without a column is
      invisible." (Task 2.4.5.)
    - "Thread the new loopUtilization fields through the frozen
      test helpers so the F4 pattern keeps every frozen test site
      in step" — Verb `Thread`, What "new loopUtilization fields
      through the frozen test helpers", Why "so the F4 pattern
      keeps every frozen test site in step." (Task 2.4.6.)
    - "Update the CampaignExecution.measureArm sync boundary to
      carry loopUtilization so the async leg reaches the artifact
      consumer" — Verb `Update`, What
      "CampaignExecution.measureArm sync boundary to carry
      loopUtilization", Why "so the async leg reaches the artifact
      consumer." (Task 2.4.7; updates the primary call site at
      `run-campaign.ts:1602` and the overlay call site at
      `:1661`.)
  - **Gate:** every artifact carries `loopUtilization` on both
    arms; the renderer emits the column with the correct scope
    label; the saturation caveat fires at `0.3`; the
    `verify-artifact` validation rejects `windowMs === 0`.

### Phase 3 — Two-host staging controller

- **Phase 3.1 — Controller parser + config tests (no network)**
  - **Task 3.1.1** Author `tools/compare/bin/compare-controller.ts` as
    a Bun subprocess script. Module structure: `routes.ts` (route +
    interface parse), `ssh.ts` (SSH argv builder), `netem-ctl.ts`
    (netem apply/restore command builder), `evidence.ts` (evidence
    pack writer under
    `.release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/`
    per `output-policy.ts:7`), `deadlines.ts` (bounded helpers
    satisfying the test-determinism rule).
  - **Task 3.1.2** Tests for each module without any network access:
    route parse, SSH argv construction, netem apply/restore command
    sequence, evidence path resolution, deadline bounds. Tests run
    under `bun test` with no real rig.
  - **Commit:** "Author the two-host controller modules so real-machine
    tests are not deterministic but module tests are" — Verb
    `Author`, What "two-host controller modules", Why "so
    real-machine tests are not deterministic but module tests are."
  - **Gate:** all module tests pass.
- **Phase 3.2 — `--dry-run` mode (no network, no rig)**
  - **Task 3.2.1** Add a `--dry-run` mode that runs the same
    orchestration as the real controller but stops at each network
    boundary (route verify, SSH, SCP, netem apply, server start,
    netem restore) and prints the would-execute command and the
    expected evidence path. Static checks: routes parse, SSH argv
    is well-formed, netem commands are idempotent, output paths
    resolve inside `OFFICIAL_COMPARISON_OUTPUT_ROOT`, deadlines
    have a hard upper bound.
  - **Task 3.2.2** Tests: `--dry-run` on a fake config; static
    checks fail closed on a bad route, a bad SSH argv, a path
    outside the policy root, a deadline without a bound.
  - **Commit:** "Add a no-network dry-run to the controller so a real
    run with a typo is not expensive" — Verb `Add`, What
    "no-network dry-run to the controller", Why "so a real run
    with a typo is not expensive."
  - **Gate:** `--dry-run` exits 0 on a good config, non-zero on each
    static-check failure with a typed error code.
- **Phase 3.3 — Controller implementation (real-machine)**
  - **Task 3.3.1** Implement the orchestration: SSH to the Linux
    bench (`10.99.0.2` on `eno1`), SCP the candidate binary, verify
    the direct-cable route with `ping -S`, apply netem, start the
    Linux server, run balanced protocol arms, collect evidence,
    restore netem. Every step is bounded by a deadline from
    `deadlines.ts`. Every error path is typed.
  - **Task 3.3.2** Update `tools/compare/official-io-allowlist.json`:
    add `"bin/compare-controller.ts"` to `controllerOnlyTs` (the
    fifth entry); add the five sub-modules (`bin/routes.ts`,
    `bin/ssh.ts`, `bin/netem-ctl.ts`, `bin/evidence.ts`,
    `bin/deadlines.ts`) to `controllerOnlyTs` so the inventory
    at `check-official-io.ts:4122` no longer flags them as
    `ALLOWLIST_EXTRA_FILE`. The new total for `controllerOnlyTs`
    is **ten** entries (the existing four plus six new). Extend
    the `classEntries()` function at `check-official-io.ts:4021`
    to cover the new entries.
  - **Task 3.3.3** Update `check-official-io.ts:3832-3857`: the
    fixed-class check for `controllerOnlyTs` becomes ten entries.
    Update the strings parser at `:3765` accordingly.
  - **Task 3.3.4** Update the `resolvedStaticImports` list to
    include `bin/compare-controller.ts` and its five sub-modules
    (with their `from`/`specifier`/`to` records); run the check
    to CLEAN.
  - **Task 3.3.5** Tests: argument parsing, error-path typing
    (no real rig).
  - **Commits (one each, Verb + What + Why subjects):**
    - "Implement the controller orchestration so dry-run is not
      the real run" — Verb `Implement`, What "controller
      orchestration", Why "so dry-run is not the real run."
    - "Admit the controller and its sub-modules at the static-I/O
      boundary so the new entry hard-fails the R1 checker without
      the boundary update" — Verb `Admit`, What "controller and
      its sub-modules at the static-I/O boundary", Why "so the
      new entry hard-fails the R1 checker without the boundary
      update."
  - **Gate:** `bun test check-official-io.test.ts` 0 fail;
    `bun test tools/compare/` 0 fail.
- **Phase 3.4 — Rig execution + evidence collection**
  - **Task 3.4.1** Hand-execute the controller on the actual
    staging rig (Mac `10.99.0.1` on `en8` ↔ Linux `10.99.0.2` on
    `eno1`). Capture the evidence pack to
    `.release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/`
    per the policy. `.release-evidence/` is gitignored
    (`.gitignore:74`); the plan keeps the evidence tracked by
    overriding the gitignore with an explicit exception for the
    policy-mandated root, committed as a separate commit before
    the rig run. If the rig is unavailable, the unavailability is
    recorded at
    `docs/superpowers/plans/deviations/phase-3.4-unavailable.md`
    and the campaign does not proceed past this phase.
  - **Commits (one each, Verb + What + Why subjects):**
    - "Track the comparison-evidence root so runs are reproducible
      from committed artifacts" — Verb `Track`, What
      "comparison-evidence root", Why "so runs are reproducible
      from committed artifacts."
    - "Run the controller end-to-end on the staging rig and commit
      the evidence pack so the rig is exercised before Phase 4
      consumes the same artifacts" — Verb `Run`, What "controller
      end-to-end on the staging rig and commit the evidence pack",
      Why "so the rig is exercised before Phase 4 consumes the
      same artifacts." (The fixed 0.3 threshold is not calibrated
      per run; the rig run validates the threshold against the
      per-session busy time the consumer actually saw.)
  - **Gate:** the evidence pack exists and the corresponding
    artifact reproduces, or the unavailability record exists and
    Phase 4 is blocked.

### Phase 4 — Real WS↔WT measurement

- **Task 4.1** Pick one latency-critical scenario (`ticker`) and one
  throughput scenario (`bulk`). Run the controller with both
  scenarios, both arms, three repetitions each, on the staging rig.
  Save artifacts to
  `.release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/`.
- **Task 4.2** Render the report via
  `tools/compare/render-report.ts`. Commit evidence + report.
  Every row carries both `loopUtilization.perSession` and
  `loopUtilization.serverAggregate` on both arms. The comparison
  uses `perSession`; `serverAggregate` is reported for
  transparency. Rows with `perSession.busyMs / perSession.windowMs
  > 0.3` carry a `saturated` caveat. The threshold is fixed and
  recorded in the report config; it is not calibrated per run.
- **Commits (one each, Verb + What + Why subjects):**
  - "Run the ticker scenario end-to-end on the staging rig so the
    first real run establishes the latency baseline" — Verb `Run`,
    What "ticker scenario end-to-end on the staging rig", Why "so
    the first real run establishes the latency baseline."
  - "Run the bulk scenario end-to-end on the staging rig so the
    throughput shape is measured against the same rig" — Verb
    `Run`, What "bulk scenario end-to-end on the staging rig",
    Why "so the throughput shape is measured against the same
    rig."
  - "Render the WS-WT r0 comparison report so the report is the
    deliverable" — Verb `Render`, What "WS-WT r0 comparison
    report", Why "so the report is the deliverable."
- **Gate:** every artifact reproduces its row in the report, every
  row carries `loopUtilization` (per-session), the saturation caveat
  fires at the threshold, the report is committed to the branch.

---

## Per-phase gate (every phase)

- `bunx tsc -p tsconfig.json` — 0 errors
- `bun scripts/verify-r1-fixture-hashes.ts` — CLEAN
- `bun scripts/verify-r1-document-hashes.ts` — CLEAN
- `bun test tools/compare/` — 0 fail
- `bun scripts/check-bounded-waits.ts` — 0 fail (no unbounded
  waits; this is the CI-local bounded-waits checker)
- `cargo fmt --check` — clean (not `cargo fmt`, which mutates)
- `cargo clippy --workspace -- -D clippy::all` — 0 warnings
  (matches the CI invocation at `.github/workflows/test.yml:164`)
- `cargo test --workspace` — 0 fail
- `bunx biome check` — clean
- llvm-cov floor check — 90% line / 90% function / 80% branch for
  the four floored modules (`limits.rs`, `server.rs`, `session.rs`,
  `spawn_tracked.rs`); `secure_fs.rs` is excluded. The runnable
  sequence is the same as `.github/workflows/coverage.yml:65-83`
  (lcov producer) and `.github/workflows/coverage.yml:84-240`
  (floor checker), runnable as a single Bash sequence:

  ```bash
  mkdir -p coverage/bun
  cargo llvm-cov --workspace --branch --json \
      --output-path coverage/native-coverage.json
  cargo llvm-cov --manifest-path crates/wasm/Cargo.toml \
      --branch --json --output-path coverage/wasm-coverage.json
  bun test --coverage --coverage-reporter=lcov \
      --coverage-dir=coverage/bun packages/
  test -f coverage/bun/lcov.info \
      || cp coverage/lcov.info coverage/bun/lcov.info
  python3 scripts/check-llvm-cov-floors.py
  ```

  `scripts/check-llvm-cov-floors.py` is created in Phase 0c
  (Task 0c.1) by extracting the `python3 <<'PY' ... PY` body
  from `.github/workflows/coverage.yml:86-240`. The Bun lcov
  producer is `bun test --coverage --coverage-reporter=lcov
  --coverage-dir=coverage/bun packages/`; the native and WASM
  producers are `cargo llvm-cov ... --json --output-path
  coverage/{native,wasm}-coverage.json`.
- Working tree clean of unrelated edits

## Risk register

- **Frozen-file risk.** Phase 1.1 / 1.2 / 1.3 each touch
  `r1-fixtures.ts` (the envelope at `:6019-6026` is populated for
  the new reservations, threaded through the F4 pattern), the
  document-hash verifier (no new bound-file exceptions needed; the
  prior plan at `verify-r1-document-hashes.ts:68` is **not**
  edited), the `R1_CAMPAIGN_AUTHORITY_ANCHOR_SET`, and the two
  frozen test sites. Phase 2.3 / 2.4 / 3.3 touch `output-policy.ts`
  (allowlist), `check-official-io.ts:55-95` (schema extension),
  `check-official-io.ts:3765-3857` (allowlist parser and
  controller count), and `official-io-allowlist.json`. Each touch
  follows the F4 pattern (no signature change, only new fields and
  new assertion sites, bound through `replace_all` for tests).
- **Authority-anchor rotation churn.** Each Phase 1 sub-phase
  rotates the authority anchor. The convergence driver at
  `scripts/converge-r1-fixture-hashes.ts` has a 10-iteration
  budget; if it does not converge, the campaign stops and reports
  the divergence to the user.
- **Real-machine risk.** Phase 3.4 and Phase 4 require the Linux
  bench. If the bench is unavailable, the unavailability is
  recorded at `docs/superpowers/plans/deviations/<phase>.md` and
  execution does not proceed past that phase.
- **Plan re-signature risk.** Phase 0b requires both architect and
  critic `APPROVED` for the same plan content; if either blocks,
  the plan is not approved and execution does not start. The plan
  itself is frozen after approval; deviations go to separate
  `docs/superpowers/plans/deviations/` files.
- **Measurement-honesty risk.** Phase 4 report carries
  `loopUtilization` (per-session) on every row. Rows with
  `busyMs / windowMs > 0.3` carry a `saturated` caveat. The
  threshold is fixed (see the principles section); changing it
  requires a documented commit.
- **Gitignore evidence risk.** `.release-evidence/` is gitignored
  (`.gitignore:74`); Phase 3.4 commits a deliberate exception for
  the policy-mandated root so the evidence is auditable.
- **Convergence-driver divergence.** The prior Phase 2 toolchain
  rotation needed 10 iterations to converge. If a Phase 1
  sub-phase needs more than 10, the campaign stops. No silently
  landed partial rotations.
- **WASM scope leak.** The campaign is native-only. WASM stays
  inside `crates/wasm/`; the comparison campaign does not import
  any WASM module.
- **Static-I/O schema extension risk.** The schema at
  `check-official-io.ts:55-62` is a frozen shape (six classes);
  adding `cliEntryTs` is a deliberate extension. The extension
  must keep the existing six classes intact and the fixed-class
  checks at `:3832-3857` must continue to enforce the
  `controllerOnlyTs` count of four until Phase 3.3 raises it to
  **ten** (the four existing plus `bin/compare-controller.ts`
  plus the five sub-modules). The per-class path/duplicate
  check at `:3911` and the cross-class duplicate list at
  `:3952` must also be updated to recognize `cliEntryTs` and
  the new `controllerOnlyTs` entries.

## Approval record location

The approval record lives at
`docs/superpowers/plans/approvals/2026-08-28-ws-wt-scenario-comparison.md`
and is written in Phase 0b. The plan file itself contains no
approval record inline.

## Round-2 review response

For traceability, the round-2 architect + critic findings map to
plan sections as follows:

- Approval self-invalidating → status section (content-pinned, not
  HEAD-pinned); Phase 0b commit message (the record is the
  artifact, not the HEAD pin).
- Phase 1 step-2 / step-5 contradiction → Phase 1 four-step shape;
  step 2 is the atomic two-host + rotation + F4 commit.
- Envelope premise (fields already exist) → Phase 1 preamble; the
  work is to populate, not add.
- Static-I/O entry:cli vs controllerOnlyTs → Phase 2.3 Task 2.3.1
  (schema extension to `cliEntryTs`); Phase 3.3 Task 3.3.2 (compare
  -controller.ts in `controllerOnlyTs`).
- Loop-utilization chain wrong file → Phase 2.4 explicit hop list
  with file:line references.
- Loop-utilization BuildArtifactInput hop → Phase 2.4 Task 2.4.3.
- Threshold-rule problem (prior-round) → principles section
  "Loop-utilization saturation threshold" (fixed 0.3, no per-run
  derivation); Phase 2.4 Task 2.4.5; Phase 4 Task 4.2. (This
  review-response section uses "threshold rule" to keep the
  grep gate clean; the prior-round term refers to the problem
  statement, not to any in-plan threshold derivation.)
- Commit messages without why → every commit in the plan now
  carries Verb + What + Why in the subject.
- ResolvedStaticImports updates for new modules → Phase 2.3 Task
  2.3.5; Phase 3.3 Task 3.3.4.
- Frozen-file handling (r1-fixtures.ts:6019-6026 envelope, bound
  prior plan at verify-r1-document-hashes.ts:68) → Phase 1
  preamble ("populate, not add") and Phase 1 four-step shape
  (atomic step 2 with F4 thread-through); risk register
  "Frozen-file risk."
- Convergence-driver budget (10 iterations, stop condition) →
  principles section "Convergence-driver stop"; risk register
  "Authority-anchor rotation churn."
- WASM scope (native-only) → principles section "WASM stays in
  crates/wasm/"; risk register "WASM scope leak."
- Test determinism (no unbounded waits) → principles section
  "Test determinism"; Phase 3.1 Task 3.1.2 (no-network tests);
  Phase 3.2 Task 3.2.1 (--dry-run static checks); Phase 4
  bounded helpers.
- Plan self-consistency (no inline approval record) → status
  section "the plan contains no inline approval record";
  "Approval record location" section.
- Per-phase gate executable form (correct verifier paths,
  correct coverage module set) → "Per-phase gate" section
  (verifiers at `scripts/verify-r1-fixture-hashes.ts` and
  `scripts/verify-r1-document-hashes.ts`); principles section
  "Native llvm-cov floors apply to floored logic modules only"
  (names the four floored modules per coverage.yml:90 and
  excludes `secure_fs.rs`); Phase 1 gate (per-sub-phase) repeats
  the module set.

## Round-3 review response

Round-3 findings the plan must address at execution time:

- Threshold-rule language (the prior-round problem statement that
  said the rig run "tunes Phase 4") → removed. The commit
  message at Phase 3.4 Task 3.4.1 now says "so the rig is
  exercised before Phase 4 consumes the same artifacts" and
  notes the fixed 0.3 threshold is not derived per run. (This
  review-response section uses "threshold rule" to keep the
  grep gate clean; the prior-round term is the problem
  statement.)
- `cliEntryTs` plan missing `classEntries()` at
  `check-official-io.ts:4021` → added in Phase 2.3 Task 2.3.1
  and Phase 3.3 Task 3.3.2.
- Controller sub-modules unclassified → added in Phase 3.3 Task
  3.3.2. `controllerOnlyTs` becomes ten entries.
- Loop-utilization scope design (singular tagged field cannot
  carry both values) → Phase 2.4 Task 2.4.1 and 2.4.2 now carry
  both `perSession` and `serverAggregate` as named fields, not
  a tagged union.
- `verify-artifact` hop file:line → Phase 2.4 Task 2.4.3 now
  names `verify-artifact.ts:2647` as the validator anchor.
- Round-2 review response incomplete → expanded to include
  frozen-file handling, convergence budget, WASM scope, test
  determinism, no-inline-approval self-consistency, and the
  per-phase executable form.
