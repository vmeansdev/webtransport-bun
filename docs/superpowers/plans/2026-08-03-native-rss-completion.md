# Native RSS Completion Implementation Plan (v2 — post architect/critic review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the native RSS recovery work honestly: repair the forbidden silent baseline shift (the current "service-ready" baseline is a *loaded* baseline that scales with campaign size), remove the false-green promotion paths, land the skipped H1 allocator-relief lane with a pre-registered A/B retention gate, commit the orphaned residency tests, and regenerate the full source-SHA-bound evidence matrix — or report honestly that the gate cannot yet pass at scale.

**Architecture:** Commits `b585152..c396782` landed residency bounding plus a warmup/service-ready baseline, silently changing the authoritative comparator — which `2026-08-02-native-rss-resolution.md` explicitly forbade ("no silent baseline shift is allowed"). Worse than first assessed: warmup launches the external Rust client at the full per-server campaign session count (`serverSessionCaps[i]`, `distributed-scale.ts:2031-2110`), so the baseline absorbs load-proportional residual — the "loaded baseline" the contract bans. The shift is also ratified in constants (`RSS_BASELINE_POLICY`, `RSS_AUTHORITATIVE_BASELINE`, `distributed-scale.ts:29-31`, stamped into artifacts at `:2978-2979`) and in `docs/TESTPLAN.md:34`. This plan: (1) makes warmup workload-independent so service-ready means "one-time init only"; (2) implements H1 allocator relief with an on/off A/B at the same SHA as the pre-registered retention test; (3) pins the baseline contract by measured outcome across ALL lanes including 200-session runs (known data point: cold ratio 2.0345 on the 200-session drain-all at `b16e042` — the smoke-only picture is misleading); (4) if neither baseline honestly passes at scale post-relief, returns to H2 owner isolation instead of ratifying anything.

**Tech Stack:** Rust/napi-rs (edition 2021, toolchain `rustup run 1.95.0`, native crate has NO `libc` dependency — use `extern "C"` declarations), Bun/TypeScript load harness (`tools/load/distributed-scale.ts`, `tools/load/load-scale-addon.ts`), external Rust `load-client`.

## Global Constraints

- The recovery ratio threshold stays `1.25`. Never change `maxRecoveryRssRatio`, delivery floors (`>=0.95`), p99 thresholds, error contracts, or final live-gauge requirements.
- A candidate that improves RSS by dropping traffic, hiding errors, shortening workload, inflating a baseline, or bypassing close is rejected. Growing warmup to reach a fallback is baseline laundering and is rejected.
- One scoped commit per behavior change; stage explicit paths only; audit `git diff --cached` before each commit; Lore trailers on every commit.
- Preserve unrelated dirty file `tools/interop/web-server-env.ts` and all untracked evidence/plan/spec files.
- Every load artifact records source SHA, branch, Bun version, Rust version, config, workload mode, command line; unique base ports and fresh artifact files per run.
- No new runtime dependencies in the native crate.
- Verification commands run sequentially; read each output before proceeding.
- No release-status/GA/soak claims change as part of this work.

## Verified state (2026-08-03, HEAD `c396782`)

- Strict 4-session smoke at HEAD (artifact: session scratchpad `fresh-strict-smoke-1.json`): 4/4 sessions, delivery green, zero failures; cold 43.563 → postClose 55.531 MB = **1.2747** (fails 1.25), serviceReady 53.375 = 1.0404. But at `b16e042`, 20/200-session artifacts show cold 1.32–1.35 (smokes) and **2.0345** (200-session drain-all, svc 1.225) — the cold gap grows with scale.
- UDP bind EPERM is **intermittent** (succeeded 17:03 and in this session's shell; failed 17:12 in the prior agent's sandbox). Task 0 adds a preflight probe.
- `recoveryBaseline: input.serviceReady` hard-wired at `distributed-scale.ts:280`; `allocatorReliefApplied: false` stubs at `:307`, `:2160`, `:2229`; catch path (`:2947-2963`) fabricates all memory samples from one reading (ratios exactly 1.0) and hard-codes `reviewRequired: []`; artifact is written before any exit decision, so review-required artifacts land on `.release-evidence/load/` looking clean.
- Native close seam: `server_napi.rs::close` awaits `wait_for_server_drain(...)` (returns `None` on success) at `crates/native/src/server_napi.rs:327-331` before `Ok(())`. `WtServer::close()` currently returns `Result<()>`; JS callers ignore the value.
- Dirty uncommitted tests belonging to `06d8013`: `packages/webtransport/test/stream-symbols.test.ts`, `packages/webtransport/test/internal-error-propagation.test.ts`.
- Overload-recovery commits `b16e042`/`c396782` are defensible (exact equality still required on session/task/handshake gauges; only transient `streamsActive`/`queuedBytesGlobal` relaxed to `<=`) but recovery is recorded only as a boolean — Task 5 hardens the evidence.

---

### Task 0: Preflight (no commit)

- [ ] **Step 1: UDP bind probe.** Run `bun -e 'const s = await Bun.udpSocket({port: 0}); console.log("UDP OK", s.port); s.close();'`. If EPERM: stop, report the sandbox restriction to the maintainer with the exact error, and do not fake or reuse stale evidence. Re-probe at the start of every evidence batch (EPERM is intermittent across shell types).
- [ ] **Step 2:** Record `git rev-parse HEAD`, `git status --short`, `bun --version`, `rustup run 1.95.0 rustc --version`. Confirm `target/release/load-client` exists (rebuild via the repo's build path if not). Define unique-port ranges per run (46xxx series, one range per artifact) and a fresh artifact directory.

### Task 1: Commit the orphaned stream-residency tests

**Files:**
- Modify (already dirty, commit as-is after verification): `packages/webtransport/test/stream-symbols.test.ts`, `packages/webtransport/test/internal-error-propagation.test.ts`

- [ ] **Step 1:** Run `bun test --max-concurrency=1 packages/webtransport/test/stream-symbols.test.ts packages/webtransport/test/internal-error-propagation.test.ts` — expected PASS.
- [ ] **Step 2:** Confirm the new `"destroy releases native stream resources before wrapper finalization"` test asserts `disposed.sort() == ["bidi","recv","send"]` (fails if `destroy()` stops calling native `dispose()` — not theater).
- [ ] **Step 3:** `git add` exactly those two files; commit `Cover native stream dispose on destroy` with Lore trailers.

### Task 2: Close every false-green promotion path

**Files:**
- Modify: `tools/load/distributed-scale.ts`, `tools/load/load-scale-addon.ts`
- Check-and-cover: the direct CLI entry at `distributed-scale.ts:~3068`, `tools/load/rss-hold.ts` (untracked diagnostic — gate it if it writes artifacts)
- Test: `tools/load/distributed-scale.test.ts`

**Interfaces (produces):**
- `isPromotable(summary): boolean` — pure, exported: `failures.length === 0 && reviewRequired.length === 0`.
- Artifact top level gains `promotable: boolean` and `acknowledgedReviewRequired: boolean`, written by `runScaleCampaign` itself (so the artifact is self-describing regardless of exit path).
- Exit contract at BOTH entry points (`load-scale-addon.ts` and the `distributed-scale.ts` CLI): exit non-zero when `!isPromotable(summary)`, unless `LOAD_SCALE_ACK_REVIEW=1` — and `LOAD_SCALE_ACK_REVIEW=1` is **refused with a hard error** when `config.artifactPath` is under `.release-evidence/`.

- [ ] **Step 1: Failing tests** in `distributed-scale.test.ts` (follow existing style): (a) summary with empty `failures` + non-empty `reviewRequired` → `isPromotable === false`; (b) artifact object embeds `promotable: false` for that summary; (c) ack-under-release-evidence path throws.
- [ ] **Step 2:** Run `bun test --max-concurrency=1 tools/load/distributed-scale.test.ts` — expected FAIL (helper not exported).
- [ ] **Step 3: Implement:** export `isPromotable`; stamp `promotable`/`acknowledgedReviewRequired` into the artifact JSON in `runScaleCampaign`; wire exit gating at both entry points with message `review-required diagnostics block promotion (LOAD_SCALE_ACK_REVIEW=1 acknowledges for diagnostics-only runs; refused under .release-evidence/)`.
- [ ] **Step 4: Fix the catch path** (`:2947-2963`): set the fabricated memory ratios to `null` instead of synthesizing five identical samples, and push `"campaign aborted before memory evidence"` into `reviewRequired` (do not leave it `[]`).
- [ ] **Step 5:** Run the harness test file; then `bun x tsc --noEmit --pretty false`. Expected: green.
- [ ] **Step 6:** Commit only these harness files + test: `Fail release probes on unacknowledged review diagnostics`.

### Task 3: Implement H1 allocator relief behind the drained-close seam

**Files:**
- Create: `crates/native/src/native_memory.rs`
- Modify: `crates/native/src/lib.rs` (module), `crates/native/src/server.rs` (NAPI-free seam fn), `crates/native/src/server_napi.rs:327-331` (call site), generated `index.d.ts` (regenerate via the repo's napi build)
- Test: unit tests in `native_memory.rs`; close-path test asserting the not-drained refusal and recording close duration.

**Interfaces (produces):**
- `native_memory::release_drained_residency(drained: bool) -> ResidencyRelief` where `ResidencyRelief { platform: &'static str, applied: bool, reported_bytes_released: Option<u64>, refused_reason: Option<&'static str> }`. When `drained == false`: `applied: false`, `refused_reason: Some("not-drained")` — this is the drain-ordering observable.
- `server.rs::release_drained_residency()` — NAPI-free wrapper that checks the server's drained state (zero sessions/tasks/gauges) and delegates.
- `WtServer::close()` return changes from `Result<()>` to a napi object carrying `allocatorRelief { platform, applied, reportedBytesReleased?, refusedReason? }` (existing JS callers ignore the return value — compatible; regenerating `index.d.ts` is an explicit step).
- Env kill-switch for the A/B gate: `WEBTRANSPORT_DISABLE_ALLOCATOR_RELIEF=1` → skip with `refused_reason: Some("disabled")`. Test/diagnostic use only.
- `reported_bytes_released` is **allocator-reported, not RSS-verified**; it never drives retain/reject decisions (Task 4's A/B on measured post-close RSS does).

- [ ] **Step 1: Failing unit tests** in `native_memory.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relief_refuses_when_not_drained() {
        let r = release_drained_residency(false);
        assert!(!r.applied);
        assert_eq!(r.refused_reason, Some("not-drained"));
    }

    #[test]
    fn relief_reports_platform_and_never_panics_when_drained() {
        let r = release_drained_residency(true);
        assert!(!r.platform.is_empty());
        #[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
        assert!(r.applied);
        #[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
        assert!(!r.applied);
    }

    #[test]
    fn relief_is_idempotent() {
        release_drained_residency(true);
        release_drained_residency(true);
    }
}
```

- [ ] **Step 2:** `rustup run 1.95.0 cargo test -p native native_memory` — expected FAIL (module missing).
- [ ] **Step 3: Implement** (no `libc` dependency — `extern "C"` for both symbols; `unsafe extern` is stable on this toolchain):

```rust
pub struct ResidencyRelief {
    pub platform: &'static str,
    pub applied: bool,
    /// Allocator-reported figure; NOT verified against RSS. Diagnostic only.
    pub reported_bytes_released: Option<u64>,
    pub refused_reason: Option<&'static str>,
}

pub fn release_drained_residency(drained: bool) -> ResidencyRelief {
    if std::env::var_os("WEBTRANSPORT_DISABLE_ALLOCATOR_RELIEF").is_some_and(|v| v == "1") {
        return ResidencyRelief { platform: platform_name(), applied: false, reported_bytes_released: None, refused_reason: Some("disabled") };
    }
    if !drained {
        return ResidencyRelief { platform: platform_name(), applied: false, reported_bytes_released: None, refused_reason: Some("not-drained") };
    }
    apply_relief()
}

#[cfg(target_os = "macos")]
fn apply_relief() -> ResidencyRelief {
    unsafe extern "C" {
        fn malloc_zone_pressure_relief(zone: *mut core::ffi::c_void, goal: usize) -> usize;
    }
    // NULL zone = all zones; goal 0 = release as much as possible.
    let reported = unsafe { malloc_zone_pressure_relief(core::ptr::null_mut(), 0) };
    ResidencyRelief { platform: "macos", applied: true, reported_bytes_released: Some(reported as u64), refused_reason: None }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn apply_relief() -> ResidencyRelief {
    unsafe extern "C" {
        fn malloc_trim(pad: usize) -> core::ffi::c_int;
    }
    let rc = unsafe { malloc_trim(0) };
    // malloc_trim returns 1 when memory was released; no byte count is available.
    ResidencyRelief { platform: "linux-gnu", applied: rc == 1, reported_bytes_released: None, refused_reason: None }
}

#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
fn apply_relief() -> ResidencyRelief {
    ResidencyRelief { platform: platform_name(), applied: false, reported_bytes_released: None, refused_reason: Some("unsupported-platform") }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") { "macos" }
    else if cfg!(all(target_os = "linux", target_env = "gnu")) { "linux-gnu" }
    else { "unsupported" }
}
```

Windows heap compaction is out of scope (unsupported no-op); cross-platform builds must stay green.
- [ ] **Step 4: Wire the seam:** `server.rs` gains a NAPI-free `release_drained_residency()` that passes `drained = true` only from the post-drain state; `server_napi.rs::close` calls it immediately after `wait_for_server_drain(...)` returns `None` (`:327-331`) and before returning; close success never depends on it. Change `close()`'s napi return to the diagnostic object; regenerate `index.d.ts`; confirm existing JS callers/tests unaffected.
- [ ] **Step 5:** `rustup run 1.95.0 cargo test -p native`; rebuild the addon via the repo's build script; `bun x tsc --noEmit --pretty false`; run the focused package suites (`backpressure`, `boundary-limits`, `hardening`, `acceptance`) — all green. The close-path test additionally records close duration to catch pathological relief latency (relief is synchronous and heap-proportional, but sits on the rare close path outside p99 contracts).
- [ ] **Step 6:** Commit only the native files + regenerated typings: `Release idle native allocator pages after drained close`.

### Task 4: Un-load the warmup, wire real telemetry, and pin the baseline by measurement

**Files:**
- Modify: `tools/load/distributed-scale.ts` (warmup sizing `:2031-2110`, relief stubs `:307/:2160/:2229`, baseline `:280`, constants `:29-31`), `docs/TESTPLAN.md:34` (whichever way the decision resolves), `tools/load/load-scale-addon.ts` if plumbing requires.
- Test: `tools/load/distributed-scale.test.ts`

**Pre-registered decision criteria (fixed NOW, before any run):**
- **H1 retention:** on/off A/B at the same SHA (`WEBTRANSPORT_DISABLE_ALLOCATOR_RELIEF`), same config, ≥2 runs per arm on BOTH the 4-session strict smoke AND the 200-session `drain-all` lane: retain H1 only if median post-close RSS (relief on) is lower than (relief off) by ≥1.0 MB on the smoke lane and is not worse on the 200-session lane, with delivery/p99/close-duration/final-gauge evidence unchanged on both. Report both lanes' on/off deltas before selecting an outcome. `reported_bytes_released` is never the criterion.
- **Warmup ceiling:** warmup becomes workload-independent — fixed 1 session, 1 stream, 1 datagram per server slot regardless of `config.sessions` (still one create/close server pass). Add a harness assertion that `coldToServiceReadyDeltaMb` measured at 4 sessions and at 200 sessions agrees within ≤1.0 MB, computed as the difference of medians over ≥2 runs per size; growth with campaign size means the baseline is loaded and the run is invalid. (Expected consequence: un-loading warmup should collapse `coldToServiceReadyDeltaMb` from ~10 MB to a few MB, making service-ready nearly equal cold-start — so Outcome B likely degenerates into A or C. If Outcome B appears "just barely" reachable with a still-sizable cold-to-service delta, that is the signal warmup is still doing workload: treat the run as invalid, do not ratify.)
- **Baseline decision (outcome-based, evaluated on the FULL lane set — 4-session smokes AND 200-session probe AND 200-session drain-all):**
  - **Outcome A** — all cold-start ratios ≤1.25 post-H1: restore cold-start as authoritative. Revert `:280` to the cold sample, delete/repoint `RSS_BASELINE_POLICY`/`RSS_AUTHORITATIVE_BASELINE` (`:29-31`, artifact stamping `:2978-2979`), rewrite `docs/TESTPLAN.md:34` back to the cold-start contract, delete the `coldStartDiagnostic` review-required path (hard gate again), and `grep -rn "service-ready-authoritative"` to prove no residual.
  - **Outcome B** — cold fails at scale but service-ready (now un-loaded: one-time init only) passes ≤1.25 on every lane: ratify service-ready explicitly. Keep cold-start as a hard-review diagnostic (fails promotion via Task 2 unless acknowledged), update `docs/TESTPLAN.md:34` to describe the *un-loaded* warmup contract truthfully, and surface the ratification prominently in the handoff — the maintainer must see and can veto it.
  - **Outcome C** — service-ready also fails ≥1 lane post-H1: **ratify nothing.** Leave the gate red, keep both diagnostics, and hand off to a new H2 owner-isolation plan (per `2026-08-02-native-rss-resolution.md` H2) with the artifacts as evidence. "Diagnostic-only" is not completion — but laundering is worse.
- **Masking guard (all outcomes):** every post-relief strict artifact must show `nativeOwnerTelemetry` post-close all-zero, and a 3-cycle in-process repeat (create/load/close ×3 in one process) must show cycle-3 post-close RSS ≤ cycle-1 post-close ×1.05 — relief must not hide cross-cycle growth. Implementation home: a new **committed** script `tools/load/rss-cycle-repeat.ts` (thin driver over the existing harness pieces, writes its own artifact) plus a focused test in `distributed-scale.test.ts`; it lands in this task's commit. Do not improvise it through the untracked `rss-hold.ts`.

- [ ] **Step 1: Failing tests:** (a) warmup session count is constant (1) regardless of `config.sessions`; (b) synthetic close result with `allocatorRelief.applied: true` produces real `allocatorReliefApplied: true` in the artifact memory block (replacing all three stubs); (c) baseline-scaling assertion fails when `coldToServiceReadyDeltaMb` grows with session count; (d) the cold-start diagnostic threshold is derived from `config.maxRecoveryRssRatio`, not the module constant at `distributed-scale.ts:32` — overriding the config ratio must move the diagnostic with it.
- [ ] **Step 2:** Implement warmup un-loading + telemetry wiring + threshold derivation + `rss-cycle-repeat.ts`; run harness tests + `bun x tsc --noEmit --pretty false`.
- [ ] **Step 2b (frozen-SHA prerequisite for Task 5):** add the overload-evidence recording here — the recovered gauge tuple and wait duration in `overloadEvidence`, plus the `admissionShedCount > 0` assertion — so Task 5 needs no source change. It ships in this task's commit.
- [ ] **Step 3:** Run the A/B (≥2 strict smokes per arm, unique ports, fresh artifacts) and record the retention verdict. If H1 is not retained, revert the Task 3 wiring commit (keep the module + tests if harmless, but do not ship a no-op hook silently — record the disproof).
- [ ] **Step 4:** Run the full lane set fresh at this SHA: 3× strict 4-session smokes, 200-session/30 s probe, 200-session/30 s drain-all. Evaluate the pre-registered outcome (A/B/C) on cold and service-ready ratios across all lanes.
- [ ] **Step 5:** Apply the outcome's harness/docs changes (A, B, or C as pre-registered above); update harness unit tests to match; rerun the harness test file.
- [ ] **Step 6:** Commit: `Record allocator relief and pin the RSS baseline contract` (or, for Outcome C, `Record allocator relief and keep the RSS gate red pending owner isolation`).

### Task 5: Regenerate the full evidence matrix at the final SHA

**Files:** no tracked source changes; artifacts under the scratchpad/`/private/tmp`; `.release-evidence/load/load-scale-artifact.json` only via the release-shaped run and only if promotable.

- [ ] **Step 1: Verification matrix, sequentially:**

```bash
rustup run 1.95.0 cargo test -p native
bun test --max-concurrency=1 tools/load/distributed-scale.test.ts
bun test --max-concurrency=1 packages/webtransport/test/backpressure.test.ts packages/webtransport/test/boundary-limits.test.ts packages/webtransport/test/hardening.test.ts packages/webtransport/test/acceptance.test.ts
bun x tsc --noEmit --pretty false
```

- [ ] **Step 2: Three fresh strict 4-session smokes at the final SHA — unconditionally.** (Task 4's runs never count: Task 4 Steps 5-6 change source after them by construction.)
- [ ] **Step 3: Localization controls** (20 sessions, 10 s, unique ports, fresh artifacts, `drain-all` unless stated): streams-only (0/1), datagrams-only (1/0), mixed low (1/1), mixed high (1000/1), plus one diagnostic datagrams-only `single-reader` run (delivery-exempt; ACK env only if it emits review diagnostics, never under `.release-evidence/`).
- [ ] **Step 4: Release-shaped run:** `bun run test:load-scale-addon` (200/30 probe → `.release-evidence/load/load-scale-artifact.json`), then a matching 200/30 `drain-all` control on the same SHA, unique port.
- [ ] **Step 5: Acceptance per artifact:** authoritative recovery ratio ≤1.25 under the pinned contract (or, Outcome C, documented red), peak RSS within cap, 100% sessions, delivery/error green, p99 green, zero final live gauges, `admissionShedCount > 0` with the recovered gauge tuple and wait duration present in `overloadEvidence` (recording landed in Task 4 Step 2b — **Task 5 is strictly no-commit**; if any source change proves necessary here, return to Task 4, land it there, and restart Task 5's evidence from Step 2), `promotable: true`, exit 0 without ACK env, and — when H1 was retained — `allocatorRelief.applied === true` with `refusedReason == null` in every release artifact (the kill-switch must be provably off on the release path).
- [ ] **Step 6: WASM non-regression:** `bun run test:wasm` and `bun run test:wasm:interop` match prior green.

### Task 6: Handoff report

- [ ] Report per hypothesis: retained/rejected with the A/B numbers, exact commits, cold AND service-ready ratios for every artifact, the baseline outcome (A/B/C) and where it is documented, verification outputs, the intermittent-EPERM note, and what remains external to the local macOS proof (linux-gnu `malloc_trim` is compile-gated, not load-proven locally; Windows is an explicit no-op).

---

## Post-approval amendment (2026-08-03, architect + critic approved)

The goal was extended by the maintainer to "continue until the RSS gate is green." H2 owner isolation attributed the Outcome C residual and led to three reviewed changes; both reviewers approved with conditions, all folded in:

1. **Constraint amendment:** "No new runtime dependencies in the native crate" is amended to admit **mimalloc as the global allocator** (vendored C, builds via cc). Justification: a C micro-test proved `malloc_zone_pressure_relief` is a no-op on macOS 26 and the system malloc never returns freed small-zone pages — the Outcome C residual was 44 MB of freed-but-resident MALLOC_SMALL. Recorded caveats: vmmap labels mimalloc arenas "IOAccelerator" (OS tag 100); Linux ELF interposition against Bun's embedded mimalloc is an open risk until a symbol-binding check lands.
2. **`releaseNativeMemory()` product API:** `mi_collect(force)` on the calling thread plus both runtime threads (bounded 500 ms waits), best-effort, proven delivery-safe by test. Used symmetrically by the harness.
3. **Charged-metric comparator (measurement-architecture change per resolution-plan H3):** authoritative recovery ratio and cold diagnostic compare charged memory (macOS `phys_footprint`; conservative rss fallback elsewhere); rss ratios disclosed in every artifact; peak cap stays rss; symmetric purge+settle median-of-3 sampling for all four comparator samples, never peak; cold diagnostic reframed as an absolute delta against the pre-registered 6.1 MB platform-floor cap (`COLD_RESIDENCY_DELTA_CAP_MB`). Disposition: review-required never flips `promotable` or exit codes; `sign-cold-disposition.ts` records auditable human dispositions in a separate file reconciling to "promotable-with-reviewed-cold-diagnostic". Leak falsifier: purge-disabled cycle-repeat arm added to evidence acceptance.

Commits: `f5a1c34` (mimalloc), `654eb7c` (releaseNativeMemory), `28d0f9b` (charged metric + symmetric sampling + delta diagnostic).
