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

  RSS recovery records two baselines and, as of 2026-08-03, the gate is honestly RED at scale. Before the measured workload, the same Bun process performs one bounded warmup pass that creates and closes the same native server path used by the campaign (`createServer(...) -> await server.close()`). The warmup workload is fixed and workload-independent — exactly 1 session, 1 stream/sec, and 1 datagram/sec per server slot regardless of campaign size — so `serviceReady` excludes one-time initialization only and can never absorb load-proportional residual (an earlier revision warmed at the full campaign session count; that was a loaded baseline and its passes are not comparable). The warmup records `datagramStackWarmed`, `datagramWarmupSessions`, `datagramWarmupDatagramsReceived`, `streamStackWarmed`, `streamWarmupSessions`, `streamWarmupStreamsOpened`, and real `allocatorRelief` close diagnostics (no relief hook is currently wired; see `crates/native/src/native_memory.rs` for the recorded A/B disproof); it does not prewarm a native client or restart the process. The in-code comparator is `postClose <= serviceReady * maxRecoveryRssRatio` (default `1.25`), and the cold-start diagnostic threshold derives from the same configured ratio. A cold-start ratio above the threshold is recorded as `coldStartDiagnostic.status: "review-required"`, blocks promotion (`promotable: false`, non-zero exit unless `LOAD_SCALE_ACK_REVIEW=1`, which is refused for `.release-evidence/` paths), and is never hidden or converted into a pass. Current measured state on macOS at 200 sessions/30 s: all functional, delivery, overload, p99, and final-gauge/owner-telemetry gates pass with every logical gauge zero, but both ratios fail (`serviceReady` ≈ 2.09, `coldStart` ≈ 2.5): a load-proportional native residual (~57 MB) survives a fully drained close and is not reclaimable via allocator pressure relief. Release evidence for the RSS gate is therefore not promotable pending owner isolation (H2); the comparator and thresholds stay unchanged — the gate stays red rather than being redefined. Evidence acceptance additionally requires `coldToServiceReadyDeltaMb` to agree within 1.0 MB (median) across 4-session and 200-session lanes, proving the warmup stayed un-loaded, plus the 3-cycle in-process repeat (`tools/load/rss-cycle-repeat.ts`, cycle-3 post-close ≤ cycle-1 × 1.05). Release evidence requires three fresh strict smoke repetitions, the 20-session localization controls, the release-shaped scale run plus matching `drain-all` control, and cross-platform review of both ratios. `bun tools/load/load-scale-addon.ts` is the loopback rehearsal wrapper over the same assertions and artifact shape and writes `.release-evidence/load/load-scale-artifact.json`.

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
