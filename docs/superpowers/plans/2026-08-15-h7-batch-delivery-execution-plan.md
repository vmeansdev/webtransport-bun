# H7 Batch Datagram Delivery — Execution Plan

Status: **APPROVED PLAN, NOT SCHEDULED** — reviewed by architect
(APPROVE-WITH-CHANGES, 7 changes folded) and critic (APPROVE-WITH-CHANGES,
7 changes folded) on 2026-08-15. Execution is a separate, later decision by
the maintainer; no code exists for this plan yet.

Supersedes the design sketch in `2026-08-12-datagram-batch-delivery-design.md`
(Option A adopted; Option B remains rejected).

## Motivation (2026-08-15 reframe)

The 2026-08-12 design motivated H7 by memory (per-datagram napi garbage).
Two things changed since:

1. **Arraybuffer delivery is the default** (99c93aa): payload memory is
   GC-visible and self-collecting; RSS proven flat over 24h. Memory is now
   the secondary motivation.
2. **The bandwidth bench (runs 31886338315 / 31889419627) proved a
   throughput ceiling**: the server saturates at ~12.5k datagrams/s inbound
   (~110–115 Mbps aggregate at 100 sessions × 1150 B, echo profile), server
   process pinned at ~188% CPU. Past that, socket-buffer loss collapses
   client congestion windows and quinn drops datagrams sender-side — a
   cliff to 9% delivery at 200 Mbps. The dominant per-datagram cost is the
   napi delivery machinery: one `spawn_future` per datagram = 1 fresh
   ThreadsafeFunction + 1 deferred + 1 Promise + handle-scope slots
   (napi-rs 2.16.17 `js_values/deferred.rs`), plus one JS microtask turn
   per datagram in the `incomingDatagrams` generator.

**Primary goal: throughput** — divide the per-datagram napi machinery cost
by the batch size to raise the datagrams/s ceiling. Memory-garbage
reduction (~batch-fold fewer TSFN/deferred/promise allocations) is the
secondary win.

**Honest ceiling caveats**:
- One microtask turn per yielded item and one ArrayBuffer + Uint8Array per
  datagram (`payload_buffer.rs:111-130`) plus one `napi_set_element` per
  element are UNCHANGED by batching. Only the TSFN/deferred/Promise/
  `spawn_future` counts fold. Phase 4a establishes the JS-side floor for
  minutes of local cost before any CI spend.
- The throughput claim is gated on a receive-isolated bench mode, never on
  the echo ladder (which is send-serialized and caps any read-side win at
  ~1.3–1.5×).

## Design: pull-based batch read

### Two native session types — BOTH are in scope

The TS facade has two native handles behind one interface
(`NativeSessionHandle`, `index.ts:1106`):

- **Server**: `WtSession` (`crates/native/src/session_napi.rs:157
  read_datagram`) → forwarder task (`lib.rs:1299-1381`) pushes
  `DatagramSlot`s into `mpsc::channel(2048)`
  (`session_registry.rs:247,363,429`, reservation-accounted);
  `read_datagram_for_session` (`session.rs:175-184`) is `rx.recv().await`
  under the `dgram_rx.lock().await` guard.
- **Client**: `ClientSessionHandle::read_datagram`
  (`crates/native/src/client.rs:556`), an `#[napi] async fn(&self)` over
  `dgram_recv_rx` — `mpsc::channel::<Vec<u8>>(256)` (`client.rs:735`) with
  manual `client_metrics.queued_bytes.fetch_sub` accounting (no
  `DatagramSlot`).

The batch method is added to **both** handles; the shared TS interface gains
one required method with identical semantics.

### Drain mechanism (confirmed against real code — no new machinery)

Per batch, on either handle:
1. `rx.recv().await` the FIRST datagram — identical blocking semantics and
   first-datagram latency to today's single read.
2. `rx.try_recv()` in a loop up to `max - 1` more, same lock/borrow held.
3. Resolve the collected batch.

No `poll_now`, no extra buffering task. Ordering preserved (single consumer,
single channel per session).

### Native API

```rust
// server (session_napi.rs), spawn_future-based like its siblings:
#[napi(ts_return_type = "Promise<Buffer[] | null>")]
pub fn read_datagram_batch(&self, env: Env, max: u32) -> Result<JsObject>

// client (client.rs), async-fn form like its siblings:
#[napi]
pub async fn read_datagram_batch(&self, max: u32) -> Result<Option<Vec<PayloadBuffer>>>
```

- New helpers alongside the single-read paths: server
  `read_datagram_batch_for_session(&id, max)` in `session.rs`; client drain
  inline over `dgram_recv_rx` in `client.rs` with the same
  `queued_bytes.fetch_sub` per drained item.
- **`max` clamped in native to 1..=256 — silently, never an `Err`.** The TS
  layer clamps first so the native clamp is unreachable in practice; the
  clamp is documented. Returning `Err` for out-of-range input is forbidden:
  on the client form an `Err` *rejects*, re-opening exactly the bfcb90c
  leak.
- Resolve values: non-empty `Buffer[]`, or `null` (channel EOF **or session
  not in registry**, `session.rs:171` — same as today's single read).
  **Empty array is never returned** (verified to hold on every path). If
  EOF lands after some datagrams were drained, resolve the partial batch;
  `null` surfaces on the next call.
- **Reject-free by construction, both handles**: `session.rs:175-184` and
  `client.rs:556-566` return `Ok` on every branch; the only rejection path
  is a `RUNTIME.spawn` join panic, unchanged from today. No error-string
  sentinel is needed (there is no error channel to encode) — this satisfies
  the bfcb90c no-reject rule without inventing one.
- Borrow caveat (client): a parked batch read holds an exclusive napi
  borrow of the handle for its whole park — the codebase warns about this
  at `client.rs:588-592` — and the drain loop lengthens that window
  slightly. Phase 3(b) covers close-while-parked on both handles.
- Payloads use the default arraybuffer path. Phase 1 asserts per-element
  `arraybuffer_delivery()` gating applies through `Vec<PayloadBuffer>`
  and extra-memory accounting is charged once per element, not
  double-counted per batch.
- Existing `read_datagram` methods are kept on both handles (legacy knob
  path, evidence tooling). `discard_datagram` / `discard_datagrams` share
  the server lock and are unaffected; the batch reader holds `dgram_rx`
  slightly longer per acquisition (pre-existing contention, noted).

### Backpressure semantics (stated per handle)

Draining moves up to `max` items out of the channel at once. Today a native
read already releases its reservation at native-read time
(`session_registry.rs:234` + Drop) — the change is the **count** per
acquisition (1 → max), not the timing:

- **Server**: effective buffering becomes `2048 + max` datagrams per
  session; `max_queued_bytes_per_session` is loosened by up to one batch of
  payload bytes (≤256 × payload).
- **Client**: effective buffering becomes `256 + max`;
  `datagram_budget_bytes` (`client.rs:749`) is loosened by up to one batch.

Momentary heap overshoot of up to `max × payload` bytes per session exists
between drain and JS materialization. No new batch is requested until the
consumer drains the previous one — the pull model still bounds total
in-flight data. Both bounds get dedicated tests (Phase 2, server + client
twins).

### Documented semantic deviations (beyond the buffering bound)

1. The generator's `while (!session.#closed)` guard now admits up to `max`
   post-close yields of already-delivered datagrams instead of 1.
2. Mid-batch abandonment of the generator now discards up to `max - 1`
   already-received datagrams instead of at most 1.

Both are stated here, asserted by Phase 3, and land in the public docs
(Phase 2). Datagrams are droppable by contract, so both are acceptable —
but they are changes and are not hidden.

### TS (`packages/webtransport/src/index.ts`)

- `NativeSessionHandle.readDatagramBatch(max: number):
  Promise<Uint8Array[] | null>` added to the shared interface
  (`index.ts:1106`) — required on both handles, no optional-with-fallback
  split.
- Both generator call sites rewritten: server `index.ts:1418`, client
  `index.ts:1973` — pull a batch, `yield` items one by one, pull the next
  batch when drained. Public API unchanged: `AsyncIterable<Uint8Array>`,
  per-item yields, same ordering, same termination.
- **One knob**: `WEBTRANSPORT_DATAGRAM_BATCH` (default 64), read once at
  module init on both layers (hot path — no per-call env lookups):
  - `0` → route through the legacy per-datagram `readDatagram` path
    (full escape hatch, mirrors the arraybuffer-delivery precedent),
  - `1` → degenerate batches of one through the NEW path (semantic
    bisection),
  - `2..=256` → batch size; TS clamps first, native clamp is the backstop.
  Knob=0 status: exercised by one Phase 2 routing test only — accepted as
  an evidence/escape lane, not a continuously-benched configuration (stated
  here so nobody reads more into it).

### Documentation (in scope, Phase 2)

`docs/SPEC.md` (same class of change as bfcb90c's spec touch) and the
datagram section of the public API docs: batch delivery mechanism, the
buffering-bound change per handle, the two semantic deviations, the knob,
and an explicit "native backends only — the WASM facade is unaffected
(browser datagram delivery is not napi)" parity note so the documented
bounds are not read as library-wide. The release evidence line has a
doc-truth gate; this keeps it green.

### Explicitly out of scope (follow-ups)

- **Send-side batching** (`send_datagram_batch`): the next lever for the
  video downstream story; separate surface with its own partial-failure
  semantics. Phase 4b's bench changes make its future win independently
  measurable.
- WASM backend: unaffected.
- Option B (long-lived push TSFN): still rejected. If Phase 4a shows the
  async generator itself is the floor, the recorded fallback is exposing
  the batch array as an internal API for hot consumers (noted, not scoped).

## Phases (≤5 files each; every phase ends with verification)

- **Phase 0 — baselines (in hand)**: bandwidth ladder @0c49acf (knee
  110–115 Mbps, artifacts on run 31889419627); lc-matrix per-datagram
  growth numbers from the 2026-08-12 verdict doc. Re-run only if stale.
- **Phase 1 — native batch read, both handles** (files: `session.rs`,
  `session_napi.rs`, `client.rs`, native test file(s)): helpers + napi
  methods + Rust unit tests — first-datagram blocking, drain cap + silent
  native clamp (never `Err`), ordering, EOF→null, not-in-registry→null,
  partial-batch-then-EOF, arraybuffer gating + single-charge accounting,
  client `queued_bytes` accounting per drained item. Client test
  constructors (`client.rs:1886/1934`) use `channel(1)`/budget 1024 — batch
  tests must account for that. Gate: cargo test + clippy green.
- **Phase 2 — TS integration + docs** (files: `index.ts`, `docs/SPEC.md`,
  public API doc, up to 2 test files): interface + both call sites + the
  single knob (0/1/n) + documentation above. TS tests: ordering across
  batch boundaries, EOF mid-batch, batch=1 degeneration, batch=0 legacy
  routing, backpressure bounds (server 2048+max AND client 256+max twins,
  reservation/budget release timing covered). Note:
  `test/internal-error-propagation.test.ts` references `readDatagram` and
  must stay green unmodified (legacy path kept). Gate: typecheck + full bun
  test suite green.
- **Phase 3 — lifecycle & retention proof** (the method never rejects, so
  the rejection falsifier is not the instrument): (a) consumer abandons the
  generator mid-batch — up to `max-1` datagrams are discarded (asserted,
  not just "no leak"), no retained reservations, no stranded payload
  buffers, teardown completes; (b) session close while a batch read is
  parked resolves `null` promptly on BOTH handles (no hang; client borrow
  released); (c) churn run leaves 0 protected wrappers (existing harness,
  expected-unchanged sanity). Gate: all green + existing 533+ suite.
- **Phase 4 — performance evidence, cheapest first**:
  - **4a Local JS-floor microbench (minutes, BEFORE any CI)**: drive the
    rewritten generator over pre-filled 64-element batches vs a direct
    callback loop; sweep batch 16/64/256. If the generator floor lands near
    the current ~12.5k/s ceiling, STOP and revisit — the premise is dead;
    record findings, consider the internal batch-API fallback.
  - **4b Receive-isolated bandwidth bench**: add `BENCH_ECHO=0` mode to
    `tools/load/bench-bandwidth.ts` (today's echo `await
    session.sendDatagram(...)` at line 207 inside the onSession loop
    serializes the consumer and would cap ANY read-side win at ~1.3–1.5×).
    Gate the throughput claim on the receive-isolated ladder: target ≥2×
    serverRx at the former cliff rungs (130–200 Mbps), honest report of
    where the next bottleneck lands. Run the echo ladder too, reported as
    the bounded composite it is — never as the headline.
  - **4c Memory A/B**: recreate the lc-matrix-style harness (the
    2026-08-12 harness was ad-hoc in the wt-linux container and is NOT
    committed — no `GC_MODE` knob exists in-repo; rebuild from the
    load-addon.ts pattern, default GC, no valve). 20 min, baseline vs
    batch: per-datagram **deferred/promise/function** growth must drop
    ~batch-fold (NOT "napi-object growth" — per-datagram ArrayBuffer +
    Uint8Array are unchanged by design); first-datagram latency recorded
    and unchanged.
  - **4d 2h dedicated CI soak** with clean memory gates before this is
    considered for any release rebind.

## Risks & mitigations

- **JS generator floor** — top risk; retired first by Phase 4a for minutes
  of cost.
- **Echo-bound measurement** — retired by 4b's receive-isolated mode.
- **Backpressure loosening** — bounded (`+max` items per handle) and tested
  per handle (Phase 2).
- **Client borrow window** — parked batch read holds the exclusive napi
  borrow longer; Phase 3(b) proves close-while-parked resolves.
- **Bun batch-array materialization cost** — swept in 4a (16/64/256) before
  concluding.
- **Rejection-leak recurrence** — reject-free by construction on both
  handles; out-of-range `max` clamps, never errors.
- **Next bottleneck after read batching** (send side, quinn UDP path) — 4b
  isolates receive so the result is attributable; send-side batching is the
  recorded follow-up.

## Success criteria (all must hold)

1. Public API unchanged (`AsyncIterable<Uint8Array>`, ordering,
   termination), with the documented deviations: buffering bound
   2048+max (server) / 256+max (client), up to `max` post-close yields,
   up to `max-1` discarded on mid-batch abandonment — all in docs and
   covered by tests.
2. Phase 4a microbench clears the premise BEFORE CI spend.
3. Receive-isolated ladder: ≥2× serverRx at the 130–200 Mbps rungs; honest
   report of the next bottleneck.
4. Memory A/B: per-datagram deferred/promise/function growth reduced
   ~batch-fold; first-datagram latency unchanged.
5. Lifecycle tests green on both handles: mid-batch abandonment (discard
   count asserted), close-while-parked, churn 0 protected wrappers.
6. 2h soak: memory gates clean.
7. Rollback story: single knob — batch=0 legacy path, batch=1 semantic
   bisection, default 64; doc-truth gate stays green.

## Review record

- Architect (2026-08-15): APPROVE-WITH-CHANGES — 7 required changes, all
  folded (no error sentinel; receive-isolated gate; microbench-first;
  honest backpressure; native clamp; single knob; lifecycle-test Phase 3).
  Confirmed the drain needs no new machinery.
- Critic (2026-08-15): APPROVE-WITH-CHANGES — 7 required changes, all
  folded (client handle in scope; per-handle backpressure statement +
  release-timing correction; memory gate narrowed to deferred/promise/fn;
  post-close-yields and abandonment-discard deviations documented + tested;
  docs phase added with WASM parity note; clamp silent-never-Err; client
  reject-free citation + borrow caveat). Verified every line reference.
