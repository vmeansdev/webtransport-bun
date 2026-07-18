---
name: production-readiness-review
description: 2026-07-18 production-hardening of webtransport-bun — 8 review defects being fixed on branch hardening/production-grade, status tracker
metadata:
  type: project
---

Follow-on to the 2026-07-18 skeptical review (verdict was "not production-grade yet"). User then asked to fix ALL findings and drive to "FAANG (and above) production-grade" with full test coverage, iterate until confident yes. Working on branch **hardening/production-grade** (off release/0.3.0). Plan: docs/HARDENING_PLAN_2026-07.md.

IMPLEMENTED + committed (commit 7483094), all compiling, release addon rebuilt, existing 184 tests still green, typecheck clean:
- F3 panic teardown scoped (PanicScope::Session/Server/Conn in panic_guard.rs; spawn_tracked takes scope) — was global close_all killing all sessions process-wide.
- F4 finish()/reset() lossless via send_ctrl_lossless (try_send then async fallback) in client_stream.rs.
- F5 session Accepted/Closed events now awaited send (lossless) in lib.rs — was 512-slot try_send drop.
- F9 QUIC transport limits wired to app limits (max_concurrent_bidi/uni = cap+16, receive windows = byte budgets) in lib.rs via with_custom_tls_and_transport.
- F10 wrap-prone u32 metric fields widened to f64 (metrics.rs + conversions).
- F11 per-datagram RUNTIME.spawn removed; synchronous send inline (session.rs).
- F1 SendScheduler no longer awaits each task in drain → no cross-stream head-of-line blocking (index.ts).
- F2 close()-during-connect closes session + settles closed (index.ts #pendingCloseInfo).
- F6 receive paths pull-based w/ cancel: nodeReadableToWebReadable, createServerIncomingBidi/Uni, createIncomingBidi/Uni (index.ts).
- F7 real wire getStats via quinn stats (metrics.rs QuicConnectionStats + connectionStats() on both session handles; facade prefers it).
- F8 serverCertificateHashes pin-only per W3C intent + 14-day validity guard (x509-parser) in client.rs PinnedCertVerifier.
- F12 maxDatagramSize from path MTU (pathMaxDatagramSize) not constant.
- Added absolute RSS ceiling to tools/load/soak-addon.ts (SOAK_RSS_CEIL_MB, applies to 120s CI soak).

IN FLIGHT (subagents): test-fixer (de-tautologize fairness:329/hardening:337-381/boundary-limits:62), regression-tests (hardening-regressions.test.ts for F1/F2/F5/F6/F7), adversarial-harness (crates/adversary raw-quinn malformed input + adversarial-protocol.test.ts). F13 (client waitUntilAvailable busy-poll) still TODO.

Remaining before "yes": land 3 agent test suites green, run full verify (cargo test+clippy, typecheck, bun test, soak, parity), update docs (PARITY_MATRIX/METRICS/README getStats+cert), final verdict. Related: [[user_profile]], [[wasm-backend]].
