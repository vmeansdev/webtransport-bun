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
- `PAYLOAD_SOAK_PACKAGE_ROOT=/absolute/paired-package bun tools/load/payload-ownership-soak.ts` — focused native receive-ownership falsifier. The root must contain the candidate's matching `dist/` and `prebuilds/`; never compare by swapping only an addon into live source. Run the identical immutable baseline package on Bun, candidate package on Bun, and candidate package on Node. The harness bounds every operation and its sample storage, uses an explicit development-only self-signed certificate, performs datagram plus bidi delivery, and contains no forced JS collection or native allocator relief. Its JSON records JS/addon SHA-256, runtime, honestly labeled `process.memoryUsage().rss` plus heap/external/ArrayBuffer samples, delivery/errors, CPU, throughput, p99 latency, and a final-quarter RSS slope. A capability mismatch, timeout, zero delivery, error, or tail slope above `PAYLOAD_SOAK_MAX_TAIL_RSS_SLOPE_MB_PER_MINUTE` (default `4`, well below the original failure's roughly `29 MiB/min`) fails the command. This focused in-workload plateau check does not replace or redefine the separate post-close `1.25` release recovery comparator below.

### Benchmarks
- `bun run bench:handshake` — p50/p95/p99 latency; **CI fails if p95 > BENCH_P95_MAX_MS** (default 500ms)
- `bun run bench:stream` — stream throughput (MB/s); emits JSON: `{"name":"stream-throughput","rounds":N,"bytes":N,"elapsed_s":N,"throughput_mbps":N}`
- `bun run bench:capture` — governed Task 14 baseline capture: requires a clean tree plus explicit machine and authenticated approver bindings, runs exactly 3 warmups and 15 measured rounds, writes an immutable sample artifact, and atomically derives the approved thresholds from those samples. Checked-in approval runs only through `bench-baseline-capture.yml` on hosted Ubuntu identity `github-actions-ubuntu-latest-x64`; until that new workflow is registered on the default branch, `release.yml` delegates to it through the policy-enforced `capture-baseline-bootstrap` job. The bootstrap run's other pre-baseline failures are non-certifying; local captures are diagnostic.
- `bun run bench:regress` — Task 14 regression gate: warmup + repeated runs for handshake p50/p95/p99, close-latency p99, stream throughput, and datagram throughput/loss plus event-loop delay, CPU user time, and peak RSS; writes `.release-evidence/bench/bench-regress-artifact.json`; uses Student-t 95% confidence intervals and fails on missing/non-finite/semantically invalid metrics, an exact baseline that differs from the candidate, an ancestry baseline whose measured SHA is absent from or more than eight commits behind the candidate's true first-parent chain, machine/Bun/Rust/toolchain/artifact drift, or a statistically significant regression.

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
