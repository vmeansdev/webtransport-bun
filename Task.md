# Task: Hardening to Real Production (P0 -> P1)

From INSTRUCTIONS_CURRENT_PHASE.md. Objective: reach production readiness with deterministic behavior, bounded memory, abuse resistance, verified browser interop.

## Priority 0: Close Functional Correctness Gaps

### 1) Replace stub session/stream implementations with real bindings
- [ ] Wire `SessionHandle` and `StreamHandle` to real wtransport session/stream state
- [ ] Remove placeholder returns (`Ok(None)`, no-op write/reset/stop)
- [ ] Acceptance: datagram/stream methods functional; iterators terminate on close; reset/stopSending propagate

### 2) Fix server architecture from single-accept prototype to full session loops
- [x] Per session: continuously process datagrams, bidi accepts, uni accepts (loop until connection closes)
- [ ] Acceptance: sustained multi-stream traffic; streams opened/accepted repeatedly with limits enforced

### 3) Enforce TLS configuration and secure defaults
- [ ] Server uses provided cert/key from JS (no hardcoded self-signed only)
- [ ] Client verifies certs by default; `insecureSkipVerify` explicit opt-in
- [ ] Acceptance: valid CA/cert connects; invalid cert fails with `E_TLS`

## Priority 1: Resource Safety and Abuse Resistance

### 4) Implement full budget accounting
- [ ] Enforce global, per-session, per-stream queued-byte budgets
- [ ] Backpressure first, timeout second, shedding third
- [ ] Acceptance: no unbounded growth; metrics reflect wait/timeout/drop paths

### 5) Complete rate limiting controls
- [ ] Per-IP and per-prefix handshakes; stream-open and datagram ingress token buckets
- [ ] Defaults active unless overridden
- [ ] Acceptance: abuse tests show `E_RATE_LIMITED` without instability

### 6) Deterministic shutdown and task lifecycle
- [ ] Track spawned tasks and joins
- [ ] No unresolved promises or hanging iterators after close
- [ ] Acceptance: repeated open/close cycles pass leak checks (FD/task baseline)

## Priority 2: Interop, Operations, and Packaging

### 7) Chromium interop against addon server
- [ ] Playwright suite runs against addon (not reference server)
- [ ] Acceptance: interop passes in CI on Linux

### 8) Error model and observability completion
- [ ] Map failures to stable E_* codes; structured logs and full metrics
- [ ] Acceptance: no generic/unmapped error classes in public API

### 9) CI/release and prebuild completeness
- [ ] CI matrix covers supported runtime/platform; prebuilds for all targets
- [ ] Acceptance: `bun add` works on macOS arm64 and Linux x64

## Priority 3: FAANG-Level Highload Bar

### 10) SLOs and load targets
- [ ] Define SLOs; run overload, 24h soak, chaos scenarios
- [ ] Acceptance: meets SLOs with bounded memory, graceful shedding, no panics
