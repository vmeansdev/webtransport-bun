# Production-Grade Hardening Plan (2026-07-18 review findings)

Goal: close every finding from the 2026-07 production-readiness review, prove each fix
with a regression test, and strengthen the suite until the answer to "is this
production-grade?" is a confident yes.

## Phase 1 — Rust core (highest blast radius)
- [ ] F3 Panic teardown scoped to owning server: `panic_guard.rs:67` uses global
      `close_all`; thread the owning server id into `spawn_quic_task` and call
      `close_all_for_owner`. Fallback to global only when no owner is known.
- [ ] F4 Lossy `finish()`/`reset()`: `client_stream.rs` control commands use
      `try_send` with discarded errors. Add async `finishWait`/`resetWait` napi
      methods that await channel capacity; keep sync variants but make them return
      an error instead of silently dropping.
- [ ] F5 Droppable session events: `lib.rs` batcher `try_send` drops
      Accepted/Closed under burst. Closed/Accepted must be delivered: use
      `blocking_send`-free async send from the emitting task (or a dedicated
      unbounded lifecycle channel — bounded-memory argument: events are O(sessions),
      already capped by maxSessions).
- [ ] F9 (rust-review M5) Set explicit quinn transport limits (max concurrent
      bidi/uni streams, stream/conn receive windows) matched to configured limits.
- [ ] F10 (rust-review LOW) Widen u32 metric fields that wrap (`server_metrics.rs`).
- [ ] F11 (rust-review M4) Replace per-datagram `RUNTIME.spawn` in `session.rs`
      with direct non-blocking send or a single drain loop.

## Phase 2 — TS facade
- [ ] F1 Head-of-line blocking: `SendScheduler` must serialize only within a
      sendGroup; different groups (and datagrams) proceed concurrently.
- [ ] F2 close()-during-connect: on connect success in "draining" state,
      immediately close the session; `closed` must settle.
- [ ] F6 Receive-side backpressure: convert eager `start()` pump loops
      (`nodeReadableToWebReadable`, incoming bidi/uni accept loops) to pull-based
      with `cancel()` handlers.
- [ ] F7 getStats honesty: surface real native counters where they exist; stop
      relabeling datagram counts as packets; document unavailable fields as null
      per W3C rather than fabricating zeros.
- [ ] F8 serverCertificateHashes W3C semantics: pin-only verification (no CA
      chain requirement) when hashes are provided, per spec intent; document.
- [ ] F12 (ts-review M4) maxDatagramSize from native/session, not a constant.
- [ ] F13 (ts-review M2) Client waitUntilAvailable busy-poll → event-driven wait.

## Phase 3 — Test hardening
- [ ] Regression test per fix above (F1-F13), each written to fail on the old code.
- [ ] De-tautologize: `fairness.test.ts:329` (`>=0`), `hardening.test.ts:337-381`,
      `boundary-limits.test.ts:62-66` — force the guarded condition to trigger
      (small buffers/limits) so assertions run unconditionally.
- [ ] Adversarial harness: drive the server with the `crates/reference` client
      sending malformed/hostile input (bad CONNECT, header flood, oversized
      datagrams, stream flood beyond QUIC limits).
- [ ] Graceful shutdown with in-flight streams test; close-race matrix.
- [ ] Event-burst test (>512 sessions churn) proving no Closed-event loss.

## Phase 4 — Verification & docs
- [ ] cargo build + clippy clean; rebuild native addon; typecheck; full bun test;
      parity suite; 2-min soak with RSS ceiling assertion; load smoke.
- [ ] Update PARITY_MATRIX/METRICS/README where behavior changed (getStats,
      cert hashes, scheduler semantics).
- [ ] Final self-audit against the original 8 findings; verdict.

Findings F1-F8 map to review items 1-8; F9-F13 are the medium/low agent findings.
