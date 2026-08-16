# TESTPLAN.md

Canonical release truth: `docs/release-status.json`. The suites below are the evidence inputs for that manifest.

## Required suites and pass criteria

### Rust quality gates
- `cargo fmt --check`
- `cargo clippy --workspace -- -D clippy::all`
- `cargo test --workspace`

### Unit tests
- `bun test packages/` — must pass
- Packages: webtransport (server, client, lifecycle, session-accept, backpressure, hardening, robustness, abuse, acceptance)

### Load / harness
- `bun run test:load-addon` — addon server + Rust load-client, no panics, FD stable, task gauges + queuedBytesGlobal return to baseline; writes `tools/load/rss-trend.json` and `rss-trend.csv` (RSS samples at 2s intervals)
- `bun run test:overload-addon` — shedding verified: `limitExceededCount > 0`, `sessionsActive <= maxSessions + 2`
- `bun run test:load-scale-addon` — 200 sessions, 30s; no panics, FD stable
- `bun run test:load-profiles-addon` — P2.1: handshake flood, stream-open flood, datagram flood, mixed workload. P2.3-A: contention profile (rate-limited handshakes, compliant clients progress).
- `bun run test:soak-addon` — `SOAK_DURATION` env (CI uses 120s); task gauges + queuedBytes return to baseline; trend-based leak gate when duration >= 3600s; writes segment-scoped `tools/load/soak-artifacts-seg-*.json` + `.csv`. The final hosted segment also writes `.release-evidence/soak-aggregate-<duration>h.json` after validating the complete hash chain.
- `bun run test:soak-addon:1h` / `:24h` / `:72h` — P2.2 staged long soak; use `workflow_dispatch` soak-long.yml for 24h/72h

### Benchmarks
- `bun run bench:handshake` — p50/p95/p99 latency; **CI fails if p95 > BENCH_P95_MAX_MS** (default 500ms)
- `bun run bench:stream` — stream throughput (MB/s); emits JSON: `{"name":"stream-throughput","rounds":N,"bytes":N,"elapsed_s":N,"throughput_mbps":N}`
- `bun run bench:regress` — Task 14 regression gate: warmup + repeated runs for handshake p50/p95/p99, close-latency p99, stream throughput, and datagram throughput/loss plus event-loop delay, CPU user time, and peak RSS; writes `.release-evidence/bench/bench-regress-artifact.json`; uses Student-t 95% confidence intervals and fails on missing/non-finite/semantically invalid metrics, a baseline whose exact candidate SHA/machine/Bun/Rust identity differs from the current measurement, or a statistically significant regression.

### Task 14 evidence gates
- **Coverage**: `.github/workflows/coverage.yml` runs Rust coverage for native + wasm plus Bun lcov coverage for packages, uploads raw artifacts, and enforces `native_floors`, `wasm_floors`, and `bun_floors` with `>=90%` line / `>=90%` function / `>=80%` branch coverage on the risk modules named in Task 14. Native floors target logic modules (`limits.rs`, `server.rs` TLS/drain, `session.rs` capacity/datagram/stream helpers, `spawn_tracked.rs`); bind/retry spawn in `server_spawn.rs` and NAPI wrappers in `*_napi.rs` are unit-tested but intentionally outside floors. The workflow preserves `coverage/native-coverage.json` and `coverage/wasm-coverage.json`, directs Bun at `coverage/bun`, and records the observed Bun 1.3.14 LCOV source in `coverage/bun/path-proof.txt` before normalizing the report to `coverage/bun/lcov.info`. Local runs should report missing `cargo-llvm-cov` / LLVM tooling as blockers rather than fabricating coverage numbers.
- **Fuzz / property release smoke**: `bun tools/fuzz/release-smoke.ts` verifies the checked-in fixed corpus under `tools/fuzz/corpora/**`, runs the stable always-on parser/property tests, runs the Bun-side `WASM event decoder property harness` from `packages/webtransport/test/wasm-limits.test.ts`, and writes `.release-evidence/fuzz/release-smoke.json`. Missing `cargo-fuzz` / `llvm-symbolizer` is a release blocker unless you are intentionally recording a tooling-blocked artifact. Every external command in the smoke runner carries an outer watchdog and artifacts timeout state in `commandResults`.
- **Distributed scale proof**: `bun tools/load/distributed-scale.ts` runs a multi-process, multi-port campaign and writes `.release-evidence/load/distributed-scale-artifact.json`. `sourceIdentityCount` is derived only from server-observed `session.peer.ip` values; the artifact includes normalized peer identities and `/24` or `/64` prefixes. A loopback-only run cannot satisfy a multi-source requirement and fails with an external-environment marker instead of inferring diversity from child-process count. After the steady live set reaches the exact configured session cap, a separate excess-admission phase must produce nonzero limit/rate shedding and recover to its pre-overload session/task gauge baseline. The gate then requires final active/task/queue gauges to reach zero and records `peakLiveSessions`, `sourceIdentityCount`, `sourcePrefixCount`, `liveSetHeldMs`, `admissionShedCount`, `overloadEvidence`, `p99HandshakeMs`, `p99DatagramEnqueueMs`, `p99StreamOpenMs`, `peakQueuedBytesGlobal`, `peakRssMb`, `closeDurationMs`, and `finalGauges`. Missing p99 evidence or missing RSS caps is a hard failure.

  Memory recovery is judged on **charged memory** — what the OS bills the process (macOS `phys_footprint` via `proc_pid_rusage`, the ledger/jetsam metric; other platforms fall back to `rss`, which is strictly conservative). `resident_size` additionally counts MADV_FREE'd reusable pages of the runtime's own allocators and clean shared library pages, which the OS reclaims on demand and never charges to the process; both rss ratios are still computed and disclosed in every artifact (`coldStartRecoveryRatioRss`, `serviceReadyRecoveryRatioRss`), and each artifact states its metric provenance (`chargedMetric`). The native dylib routes its Rust allocations through mimalloc (the macOS system malloc never returns freed small-zone pages; `malloc_zone_pressure_relief` is a measured no-op — see `crates/native/src/native_memory.rs`; caveat: vmmap labels mimalloc arenas "IOAccelerator" via an OS-tag collision), and `releaseNativeMemory()` purges freed pages across the runtime threads as a best-effort, bounded, delivery-safe product API.

  Sampling is symmetric by contract: every comparator sample (cold-start, service-ready, pre-close, post-close) is taken after one identical purge+GC settle as the median of three readings by charged memory; the peak sample is a raw high-water mark and is never purged, and the `maxRssMb` peak cap stays enforced on rss. Before the measured workload the same Bun process performs one bounded warmup pass with a fixed workload-independent shape — exactly 1 session, 1 stream/sec, 1 datagram/sec per server slot — so `serviceReady` excludes one-time initialization only and can never absorb load-proportional residual (an earlier revision warmed at the campaign session count; that was a loaded baseline and its passes are not comparable). The authoritative comparator is `chargedMb(postClose) <= chargedMb(serviceReady) * maxRecoveryRssRatio` (default `1.25`, unchanged). The cold-start diagnostic is an absolute residency delta — `chargedMb(postClose) - chargedMb(coldStart) <= 6.1 MB`, a cap pre-registered from platform-floor accounting (page tables, pool-thread stacks, allocator metadata, JSC steady growth, one-time init; derivation in `COLD_RESIDENCY_DELTA_CAP_MB`) — because the previous ratio's ~20 MB denominator flipped its verdict on cold-sample noise; the ratio stays recorded as informational. A `review-required` diagnostic blocks promotion (`promotable: false`, non-zero exit; `LOAD_SCALE_ACK_REVIEW=1` acknowledges diagnostics-only runs and is refused for `.release-evidence/` paths) and is never hidden or converted into a pass; `tools/load/sign-cold-disposition.ts` records an auditable human disposition in a separate file that never mutates the artifact, never flips `promotable`, and reconciles to the distinct status "promotable-with-reviewed-cold-diagnostic". Evidence acceptance additionally requires `coldToServiceReadyDeltaMb` to agree within 1.0 MB (median) across 4-session and 200-session lanes (un-loaded-warmup proof), the 3-cycle in-process repeat (`tools/load/rss-cycle-repeat.ts`, cycle-3 ≤ cycle-1 × 1.05) plus one purge-disabled repeat arm (`WEBTRANSPORT_DISABLE_ALLOCATOR_RELIEF=1`) as the leak falsifier, three fresh strict smoke repetitions, the 20-session localization controls, and the release-shaped scale run plus matching `drain-all` control. Cross-platform status: the charged metric and mimalloc purge behavior are load-proven on macOS only; Linux carries an open ELF symbol-interposition risk (Bun embeds its own mimalloc) and uses the conservative rss fallback until a Linux lane lands. `bun tools/load/load-scale-addon.ts` is the loopback rehearsal wrapper over the same assertions and artifact shape and writes `.release-evidence/load/load-scale-artifact.json`.

### Interop
- `cd tools/interop && bun run playwright test` — Chromium WebTransport client connects to addon server: session establishment with cert hash pinning, datagram round-trip, bidi stream echo. P3.3: reconnect storms, mixed stream/datagram concurrency, close/reset semantics; `INTEROP_EVIDENCE=1` produces `interop-evidence.json` for per-release artifacts.

### Observability invariants (unit tests)
- `queuedBytesGlobal` drains to near-zero after all clients close
- `sessionTasksActive` and `streamTasksActive` drain to zero after all clients close
- `drain.test.ts` — stream+datagram stress burst drain, abandoned iterator drain, repeated open/close stress loop (no hang), server close while clients active
- `E_LIMIT_EXCEEDED` returned when server-created stream caps are exceeded
- `E_QUEUE_FULL` returned on oversized datagram
- `E_BACKPRESSURE_TIMEOUT` returned under saturation with short timeout
- `backpressureWaitCount` and `backpressureTimeoutCount` wired to server session send_datagram; incremented on timeout (see backpressure.test.ts)
- `fairness.test.ts` (P2.3 / P2.3-A) — compliant client recovers after rate limit; E_RATE_LIMITED + rateLimitedCount; per-IP burst enforced. **Non-starvation assertions**: compliant connects within refill window after abusive burst; high-contention (abusive hammer vs compliant retries) — compliant eventually succeeds. Per-prefix independence covered by `cargo test` rate_limit tests.
- P3.1: `acceptance.test.ts` — latency histograms (handshake, datagram enqueue, stream open) populated after activity; `metricsToPrometheus` emits histogram metrics.
- P3.2: `adversarial.test.ts` — connection churn, stream churn, mixed churn, edge payloads (empty/max-size datagram); no panic, metrics drain.

### Pass criteria
- All Rust quality gates pass
- All unit tests pass
- load-addon, overload-addon, load-scale-addon pass
- Short soak (120s) passes
- Handshake benchmark p95 within threshold
- No panics in load-client stderr
- Interop passes (connect, datagram echo, bidi stream echo)
- Observability invariants asserted in automated tests

### CI evidence (CI-EVIDENCE-A)
- **Parity**: `bun run test:parity` runs in release pipeline; produces `parity-evidence.json` attached to release.
- **Interop**: `INTEROP_EVIDENCE=1 bun run playwright test` in release pipeline; produces `interop-evidence.json` attached to release.
- **Release gate**: Release job fails if parity-evidence or interop-evidence is missing.
- **Auditability**: Evidence files are linkable from GitHub release Assets per release.
- **Readiness**: `docs/release-status.json` is the canonical release-status manifest for native and wasm candidate surfaces.

## H7 batch datagram delivery evidence

Evidence for native batched datagram delivery (`WEBTRANSPORT_DATAGRAM_BATCH`,
default 64; contract in `docs/SPEC.md` → "Incoming datagram delivery"). Every
artifact below is written under `.release-evidence/h7/` and is untracked; each
one records the candidate SHA, clean/dirty state, and the exact command, and
fails closed on an identity mismatch. Diagnostics
(`WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1`) are a measurement aid: the floor,
bandwidth, scale, and hosted-soak lanes refuse a diagnostics-enabled run.

### Unit and lifecycle (no artifacts)

```bash
bun run build:native
bun test packages/webtransport/test/datagram-batch-delivery.test.ts
bun test packages/webtransport/test/datagram-batch-lifecycle.test.ts
bun test packages/webtransport/test/internal-error-propagation.test.ts
bun test packages/webtransport/test/internal-actions-policy.test.ts
bun test tools/load/soak-addon.test.ts
bun test tools/bench/datagram-delivery-floor.test.ts
bun test tools/load/compare-h7-bandwidth.test.ts
bun test tools/load/distributed-scale.test.ts
bun test tools/load/bench-datagram-napi-growth.test.ts
bun test tools/interop/tests/security-evidence.test.ts
bun run typecheck
```

`datagram-batch-delivery.test.ts` proves real server and client deliveries
across batch boundaries 1/2/64, partial EOF, value identity, default
`ArrayBuffer` backing, the external-buffer seam, and the
`WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy` escape hatch in bounded child
processes. `datagram-batch-lifecycle.test.ts` covers the `2048 + max` and
`256 + max` byte-budget twins, mid-batch abandonment discarding exactly
`observedBatchSize - 1` items, and the eight server/client × local/remote-close
cases at batch 0 and 64 with parked reads terminating within 1 second and at
least one datagram still queued at close (the drop-not-drain deviation, proven
on both lanes). The `Vec<PayloadBuffer>` delivery-plan branches are locked by
`cargo test -p native`.

### Parity and Chromium interop

```bash
bun run build:native
bun run build:wasm
bun run build:wasm:dist
WEBTRANSPORT_REQUIRE_WASM=1 WEBTRANSPORT_REQUIRE_WASM_DIST=1 bun test packages/webtransport/test/public-surface-contract.test.ts packages/webtransport/test/parity-datagrams.test.ts
H7_PLAYWRIGHT_REPORT=.release-evidence/h7/playwright-batch4.json
rm -f tools/interop/interop-evidence.json
(cd tools/interop && env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=4 INTEROP_EVIDENCE=1 bunx playwright test tests/h7-datagram-batch.pw.ts)
cp tools/interop/interop-evidence.json "$H7_PLAYWRIGHT_REPORT"
bun tools/interop/verify-evidence.ts verify-h7-playwright-report "$H7_PLAYWRIGHT_REPORT"
```

The single non-skipped test `H7 batch=4 delivers a unique bounded Chromium
burst` requires at least 95 of 100 unique echoes within 10 seconds with no
duplicate or corrupt IDs. Generic Playwright discovery does not substitute for
it, and the reporter verifier — not the test file — is the authoritative
executed/skipped count. Run this H7 case **before** the generic interop suite,
since both write `tools/interop/interop-evidence.json`. A missing Chromium or
wasm build is `BLOCKED`, not a pass.

### JS-floor microbenchmark (stop/go gate)

```bash
env -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS bun run bench:h7-floor
```

Writes `.release-evidence/h7/datagram-delivery-floor.json`. Measures the
rewritten generator over pre-filled batches at sizes 1/16/64/256 plus a direct
callback loop: 1-second warmup, seven 2-second samples per arm, randomized arm
order. Pass requires minimum measured generator rate ≥50,000 items/s **and**
median rate ≥2.0× the batch=1 generator; sizes 16/256 and the callback ratio are
recorded diagnostics, not alternate ways to pass. The harness refuses
diagnostics-enabled mode, a dirty tree, and an artifact HEAD mismatch. A failing
floor stops the bandwidth and growth lanes.

### Receive-isolated bandwidth A/B

Three interleaved same-SHA control/candidate pairs (control/candidate,
candidate/control, control/candidate) over the fixed ladder, then the
comparator, then one echo ladder reported as a send+receive composite only:

```bash
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=0 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-control-1.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-batch64-1.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-batch64-2.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=0 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-control-2.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=0 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-control-3.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-batch64-3.json bun tools/load/bench-bandwidth.ts
bun tools/load/compare-h7-bandwidth.ts --out .release-evidence/h7/bandwidth-comparison.json .release-evidence/h7/bandwidth-control-1.json .release-evidence/h7/bandwidth-batch64-1.json .release-evidence/h7/bandwidth-control-2.json .release-evidence/h7/bandwidth-batch64-2.json .release-evidence/h7/bandwidth-control-3.json .release-evidence/h7/bandwidth-batch64-3.json
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=1 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-echo-batch64.json bun tools/load/bench-bandwidth.ts
```

A rung is sustainable at delivery ratio ≥0.95 for its complete 180-second step.
`bandwidth-comparison.json` must report `status: "pass"`, which requires the
median candidate maximum sustainable serverRx ≥25,000 datagrams/s **and** ≥2.0×
the median knob=0 control maximum. The comparator refuses duplicate or missing
arms, dirty inputs, SHA/machine/ladder/duration mismatch, wrong knob or echo
mode, non-default payload delivery, diagnostics-enabled runs, incomplete rungs,
and non-finite samples. Kernel or socket drops count against delivery and are
reported as the next bottleneck; the echo ladder cannot rescue a failed receive
gate.

### Mechanistic napi-growth and latency A/B

```bash
WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy WEBTRANSPORT_DATAGRAM_BATCH=0 WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1 H7_GROWTH_OUT=.release-evidence/h7/datagram-napi-growth-control.json bun tools/load/bench-datagram-napi-growth.ts run
WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy WEBTRANSPORT_DATAGRAM_BATCH=64 WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1 H7_GROWTH_OUT=.release-evidence/h7/datagram-napi-growth-batch64.json bun tools/load/bench-datagram-napi-growth.ts run
bun tools/load/bench-datagram-napi-growth.ts compare .release-evidence/h7/datagram-napi-growth-control.json .release-evidence/h7/datagram-napi-growth-batch64.json --out .release-evidence/h7/datagram-napi-growth-comparison.json
```

21 sessions, 20 measured minutes after warmup, 5-second samples, no explicit GC
during measurement. `buffer-copy` is used **only here**, to suppress the
ArrayBuffer-triggered full-GC sawtooth so live `Promise`/`Function` slopes are
measurable; it is a diagnostic and never product or release memory evidence.
Pass requires delivery ≥0.95 and ≥1,000,000 delivered datagrams per arm, batch64
mean observed batch size ≥8, batch calls per datagram ≤0.20× control, `Promise`
and `Function` slopes per datagram each ≤0.25× control, and first-datagram p95
no worse than control p95 plus the larger of 10% or 0.25 ms. A non-positive
control slope or a control regression with R² < 0.80 is `BLOCKED`, not a pass.

### Churn falsifier (protected-object leak)

```bash
env -u WEBTRANSPORT_PAYLOAD_DELIVERY WEBTRANSPORT_DATAGRAM_BATCH=64 WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1 bun tools/load/datagram-batch-churn.ts
```

Writes `.release-evidence/h7/datagram-batch-churn.json`, which must report
`status: "pass"`. Churns, abandons, and closes 100 server/client session pairs
at concurrency 10 between two double-full-GC protected-object baselines; three
fresh child trials bounded to 60 seconds each must all pass. Pass requires
artifact HEAD equal to the candidate, a clean tree, the delivered count reached,
all native await gauges zero, a post-minus-baseline total protected count ≤ 0,
and no positive delta for `WtSession`, `ClientSessionHandle`, `Promise`, or
`Function`.

### Default-path scale arms

```bash
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 LOAD_SCALE_H7_EVIDENCE=1 LOAD_SCALE_EXPECTED_SHA="$CANDIDATE_SHA" LOAD_SCALE_LABEL=h7-single-reader LOAD_SCALE_WORKLOAD_MODE=single-reader LOAD_SCALE_SESSIONS=200 LOAD_SCALE_DURATION=180 LOAD_SCALE_DATAGRAMS_PER_SEC=1000 LOAD_SCALE_STREAMS_PER_SEC=5 LOAD_SCALE_MIN_DELIVERY_RATIO=0.95 LOAD_SCALE_MIN_SUCCESS_RATE=1 LOAD_SCALE_MAX_RSS_MB=1024 LOAD_SCALE_MAX_RECOVERY_RSS_RATIO=1.25 LOAD_SCALE_ARTIFACT_OUT=.release-evidence/h7/load-scale-single-reader.json bun tools/load/load-scale-addon.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 LOAD_SCALE_H7_EVIDENCE=1 LOAD_SCALE_EXPECTED_SHA="$CANDIDATE_SHA" LOAD_SCALE_LABEL=h7-drain-all-control LOAD_SCALE_WORKLOAD_MODE=drain-all LOAD_SCALE_SESSIONS=200 LOAD_SCALE_DURATION=180 LOAD_SCALE_DATAGRAMS_PER_SEC=1000 LOAD_SCALE_STREAMS_PER_SEC=5 LOAD_SCALE_MIN_DELIVERY_RATIO=0.95 LOAD_SCALE_MIN_SUCCESS_RATE=1 LOAD_SCALE_MAX_RSS_MB=1024 LOAD_SCALE_MAX_RECOVERY_RSS_RATIO=1.25 LOAD_SCALE_ARTIFACT_OUT=.release-evidence/h7/load-scale-drain-all.json bun tools/load/load-scale-addon.ts
```

Both artifacts must record the exact candidate SHA, `source.dirty: false`,
resolved batch 64, default payload delivery, diagnostics requested `null` /
resolved `false`, `promotable: true`, no failures or review-required entries,
delivery ≥0.95, 100% session success, raw peak RSS ≤1024 MB, charged recovery
ratio ≤1.25, and final live gauges at zero/baseline. An acknowledged
review-required result is forbidden for `.release-evidence/`.

### Hosted 2-hour soak closure

Dispatched from an immutable lightweight tag `h7-batch-delivery-<CANDIDATE_SHA>`
that resolves to the frozen candidate on the remote, never from a mutable
branch:

```bash
gh workflow run soak-long.yml --ref "$CANDIDATE_TAG" -f duration_hours=2 -f runner_type=self-hosted -f runner_mode=dedicated -f candidate_commit="$CANDIDATE_SHA" -f candidate_ref="$CANDIDATE_REF" -f segment_index=1 -f segment_count=1 -f campaign_seed="$CAMPAIGN_SEED" -f continuity_token="$CONTINUITY_TOKEN" -f committed_abort_mb=2200 -f heap_debug=0 -f datagram_batch=64 -f rss_ceiling_mb=1750
gh run watch "$RUN_ID" --exit-status
gh run download "$RUN_ID" --name "soak-aggregate-2h-$CANDIDATE_SHA" --dir "$HOSTED_DIR/aggregate"
gh run download "$RUN_ID" --name "soak-segment-2h-$CANDIDATE_SHA-seg01of01" --dir "$HOSTED_DIR/segment"
bun tools/load/soak-addon.ts verify-h7-hosted "$AGGREGATE_JSON" "$SEGMENT_JSON" --sha "$CANDIDATE_SHA" --batch 64 --rss-ceil-mb 1750 --duration-seconds 7200 --seed "$CAMPAIGN_SEED" --continuity-token "$CONTINUITY_TOKEN" --workflow-ref "$CANDIDATE_REF"
```

Artifacts land under `.release-evidence/h7/hosted-<run-id>/`. The run is
discovered by candidate SHA plus the `soak-long-<campaign_seed>` display title,
so a stale run for the same commit cannot be accepted, and it is downloaded by
immutable run ID. `verify-h7-hosted` is fail-closed and must print
`soak-addon: H7 hosted PASS`: it re-runs `aggregateSegments([segment])` against
the downloaded aggregate and requires hash-valid documents, exact SHA and clean
source, `workflowSource` SHA/ref equal to the candidate and the immutable tag,
exact seed and continuity-token digest, `runnerType: "self-hosted"`,
`runnerMode: "dedicated"`, `runnerProfile: "h7-fixed-large"`, rates of exactly
500 sessions / 500 datagrams per second / 5 streams per second in both
documents, one segment numbered 1/1, exact duration, requested/resolved batch
`"64"`/64, default ArrayBuffer payload delivery, diagnostics disabled,
`datagram-echo` present, sent > 0 with received/sent ≥0.95, charged-memory peak
≤1750 MB, the existing charged trend/recovery and final-baseline guards, and
`heapDebug: false`. The workload is fixed: an H7-tagged run fails rather than
downscales unless the runner has at least 5 CPUs and 8 GiB. This 2-hour lane is
H7 closure evidence and **does not replace the 24h/72h release soak**; if the
hosted environment cannot run, the result is `BLOCKED` — local tests, memory
diagnostics, and a shorter soak do not substitute for it.

## Known load-sensitive flakes

These pass in isolation and fail only intermittently under a loaded machine
(e.g. concurrent cargo builds during a full-suite run). Re-run in isolation to
confirm before treating a failure as a regression; none is a correctness defect
in the code under test.

- **`runtime-portability` › `withDeadline` timeout/clear** — global timer-spy
  counts get polluted by concurrently-running test files.
- **`tools/load` › descendant-held pipes / timeout+drain metadata** — passes
  30/30 in isolation; full-suite-only.
- **`hardening-regressions` › "Closed events survive a churn burst (>512
  sessions)"** — opens >512 sessions and asserts closed-event delivery within a
  handshake-timeout window; misses the window under CPU contention. No GOAWAY or
  capsule path is involved. Observed intermittently 2026-07-30.
