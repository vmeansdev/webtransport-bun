# 1.0.0 Hardening Plan — native + TS API (WASM postponed)

Branch: `release/1.0-hardening`. Goal: close every native + native-path-TS
defect from the 2026-07-19 four-agent audit so the native surface can be
honestly frozen at 1.0.0. WASM stays 0.x/experimental (out of scope here).

Definition of done for the 1.0 claim (native): all P0/P1/P2 code defects fixed
with regression tests; `/wasm` explicitly marked experimental so the frozen
surface is native-only; full suite + typecheck + clippy green; fuzz targets for
native framing; main pushed with green remote CI; a soak run on current code
with the leak gate passing. Evidence that needs wall-clock (multi-day soak,
real adopters) is called out honestly, not faked.

## Phase 1 — native P0: permanent budget leak (RAII guards)
Reservations (global+session for datagrams; global+session+stream for streams)
are released only on JS dequeue. Channel teardown drops buffered items without
releasing → `queued_bytes_global` leaks forever; attacker-accelerable to full
budget exhaustion (E_QUEUE_FULL for all sessions until restart).

Fix: make each queued item own its reservation via a Drop guard that releases
exactly once — on dequeue OR on teardown.
- `server_metrics.rs`: keep reserve/release helpers.
- New `DatagramSlot { data, session_metrics, server_metrics, reserved }` with
  `Drop` → `release_session_queued_bytes`. Channel becomes
  `mpsc::channel::<DatagramSlot>`. Sites: `session_registry::insert` sender
  type, lib.rs dgram enqueue (~961), `session.rs::read_datagram` dequeue
  (mem::take data, drop guard releases; remove manual release).
- Stream `read_tx` becomes `mpsc::channel::<StreamChunk>` where
  `StreamChunk { data, budget: Option<StreamBudget>, reserved }` Drop →
  `budget.release(reserved)` (which also notifies capacity). Sites in
  client_stream.rs: bidi + uni recv bridges (enqueue + send-error path), and
  the read-handle dequeue (`read()`); remove manual `b.release`.
Regression tests: session dropped with N datagrams buffered → global returns to
0; stream reset with data buffered → global returns to 0; churn-with-abandon
loop keeps global bounded.

## Phase 2 — native P1
- Client idle timeout + keep-alive (`client.rs` ~121): set
  `max_idle_timeout` (default e.g. 30s, configurable) and `keep_alive_interval`
  on the client `QuicTransportConfig`, mirroring server defaults. Plumb config
  through the client options.
- Non-blocking close/bind (`server.rs` ~160/167/585): replace
  `recv_timeout`/`thread::sleep` on async/JS threads with async await +
  `tokio::time::timeout`; move blocking bind-retry off the event-loop thread.
Tests: client on a dropped path resolves `closed` within the idle bound;
close() does not block the event loop.

## Phase 3 — native P2
- Finish/Reset ordering (`client_stream.rs` ~22): ensure FIN/Reset cannot be
  reordered before earlier writes on a full channel (block/await, not fallback
  enqueue that can jump ahead).
- Rate-limit per-server isolation (`rate_limit.rs`): key buckets by server id so
  two `ServerHandle`s don't share per-IP counters.
- `client_pool.rs` ~110: don't insert past `MAX_POOL_ENTRIES` when no victim
  found; reject or close instead.
- Atomic ordering consistency for `sessions_active` (lib.rs 502 vs 924).

## Phase 4 — TS (native path only)
- `index.ts` ~1691: fix `serverCertificateHashes` validation to check
  `entry.value.byteLength`, reject empty/oversized hashes.
- `index.ts` ~2005: `closed` must reject on connect failure, not resolve
  `{closeCode:0}` (distinguish error from clean close).
- Mark `/wasm` subpath experimental in package.json exports doc + README +
  PARITY_MATRIX so the frozen 1.0 surface is native-only; the divergent wasm
  facade is explicitly 0.x and exempt from the semver commitment.

## Phase 5 — evidence
- cargo-fuzz targets for native framing/datagram parse paths; wire into a CI
  fuzz-smoke job (short run).
- Regression tests from phases 1–4 in the bun + cargo suites.
- Push `release/1.0-hardening` → open PR → green remote CI (3-OS matrix).
- Run soak (as long as feasible here) + load; capture leak-gate result.

## Phase 6 — auto-review loop
Re-run the four-dimension audit against the patched tree. Loop: fix → verify →
review until no P0/P1 remain and the native surface is defensibly 1.0. Produce
an honest final gate: what is proven vs what still needs wall-clock evidence.
