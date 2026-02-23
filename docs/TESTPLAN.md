# TESTPLAN.md

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
- `bun run test:soak-addon` — `SOAK_DURATION` env (CI uses 120s); task gauges + queuedBytes return to baseline; trend-based leak gate when duration >= 3600s

### Benchmarks
- `bun run bench:handshake` — p50/p95/p99 latency; **CI fails if p95 > BENCH_P95_MAX_MS** (default 500ms)
- `bun run bench:stream` — stream throughput (MB/s); emits JSON: `{"name":"stream-throughput","rounds":N,"bytes":N,"elapsed_s":N,"throughput_mbps":N}`
- `bun run bench:regress` — regression gate: runs stream benchmark, fails if throughput < `STREAM_MIN_MBPS` (default 0.5)

### Interop
- `cd tools/interop && bun run playwright test` — Chromium WebTransport client connects to addon server: session establishment with cert hash pinning, datagram round-trip, bidi stream echo

### Observability invariants (unit tests)
- `queuedBytesGlobal` drains to near-zero after all clients close
- `sessionTasksActive` and `streamTasksActive` drain to zero after all clients close
- `drain.test.ts` — stream+datagram stress burst drain, abandoned iterator drain, repeated open/close stress loop (no hang), server close while clients active
- `E_LIMIT_EXCEEDED` returned when server-created stream caps are exceeded
- `E_QUEUE_FULL` returned on oversized datagram
- `E_BACKPRESSURE_TIMEOUT` returned under saturation with short timeout
- `backpressureWaitCount` and `backpressureTimeoutCount` wired to server session send_datagram; incremented on timeout (see backpressure.test.ts)

### Pass criteria
- All Rust quality gates pass
- All unit tests pass
- load-addon, overload-addon, load-scale-addon pass
- Short soak (120s) passes
- Handshake benchmark p95 within threshold
- No panics in load-client stderr
- Interop passes (connect, datagram echo, bidi stream echo)
- Observability invariants asserted in automated tests
