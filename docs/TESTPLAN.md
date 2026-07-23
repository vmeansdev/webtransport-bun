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
- **Coverage**: `.github/workflows/coverage.yml` runs Rust coverage for native + wasm plus Bun lcov coverage for packages, uploads raw artifacts, and enforces `native_floors`, `wasm_floors`, and `bun_floors` with `>=90%` line / `>=90%` function / `>=80%` branch coverage on the risk modules named in Task 14. The workflow preserves `coverage/native-coverage.json` and `coverage/wasm-coverage.json`, directs Bun at `coverage/bun`, and records the observed Bun 1.3.14 LCOV source in `coverage/bun/path-proof.txt` before normalizing the report to `coverage/bun/lcov.info`. Local runs should report missing `cargo-llvm-cov` / LLVM tooling as blockers rather than fabricating coverage numbers.
- **Fuzz / property release smoke**: `bun tools/fuzz/release-smoke.ts` verifies the checked-in fixed corpus under `tools/fuzz/corpora/**`, runs the stable always-on parser/property tests, runs the Bun-side `WASM event decoder property harness` from `packages/webtransport/test/wasm-limits.test.ts`, and writes `.release-evidence/fuzz/release-smoke.json`. Missing `cargo-fuzz` / `llvm-symbolizer` is a release blocker unless you are intentionally recording a tooling-blocked artifact. Every external command in the smoke runner carries an outer watchdog and artifacts timeout state in `commandResults`.
- **Distributed scale proof**: `bun tools/load/distributed-scale.ts` runs a multi-process, multi-port campaign and writes `.release-evidence/load/distributed-scale-artifact.json`. `sourceIdentityCount` is derived only from server-observed `session.peer.ip` values; the artifact includes normalized peer identities and `/24` or `/64` prefixes. A loopback-only run cannot satisfy a multi-source requirement and fails with an external-environment marker instead of inferring diversity from child-process count. After the steady live set reaches the exact configured session cap, a separate excess-admission phase must produce nonzero limit/rate shedding and recover to its pre-overload session/task gauge baseline. The gate then requires final active/task/queue gauges to reach zero and records `peakLiveSessions`, `sourceIdentityCount`, `sourcePrefixCount`, `liveSetHeldMs`, `admissionShedCount`, `overloadEvidence`, `p99HandshakeMs`, `p99DatagramEnqueueMs`, `p99StreamOpenMs`, `peakQueuedBytesGlobal`, `peakRssMb`, `closeDurationMs`, and `finalGauges`. Missing p99 evidence or missing RSS caps is a hard failure. `bun tools/load/load-scale-addon.ts` is the loopback rehearsal wrapper over the same assertions and artifact shape and writes `.release-evidence/load/load-scale-artifact.json`.

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
