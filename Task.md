# QUICK HIGHLOAD MATURITY — Task Tracking

## A) CI manual runs everywhere
- [x] `test.yml` has `workflow_dispatch` — already present
- [x] `release.yml` has `workflow_dispatch` — already present

## B) Fast highload safety gates
- [x] `test:load-addon` — exists with leak checks
- [x] `test:overload-addon` — exists with `limitExceededCount > 0` gate
- [x] Short soak (`SOAK_DURATION=120`) — exists in CI
- [x] Handshake p95 upper bound — bench:handshake fails if p95 > BENCH_P95_MAX_MS (default 500ms)
- [x] Overload gate increments `limitExceededCount` — already asserted
- [x] Post-test queue/task gauges baseline check — load-addon + soak already assert

## C) Observability checks with low runtime cost
- [x] Metrics consistency test: `queuedBytesGlobal` drains after stress burst
- [x] Metrics consistency test: `sessionTasksActive` and `streamTasksActive` drain to zero
- [x] `E_LIMIT_EXCEEDED` tested — hardening.test.ts (server-created stream caps)
- [x] `E_QUEUE_FULL` tested — hardening.test.ts (oversized datagram)
- [x] `E_BACKPRESSURE_TIMEOUT` tested — error code stability + backpressureTimeoutMs option wiring

## D) Documentation alignment
- [x] Target matrix aligned across CI.md / COMPATIBILITY.md / release.yml
- [x] Update TESTPLAN.md to reflect addon interop reality and current gates
