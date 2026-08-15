# H7 Batch Datagram Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to execute this plan task by task. Every wait in
> tests and harnesses must be bounded.

**Goal:** Raise the native receive ceiling by amortizing one napi-rs async
delivery call across an ordered batch while preserving the public per-datagram
`AsyncIterable<Uint8Array>` API and honest bounded-memory semantics.

**Architecture:** Both native session handles block for the first datagram,
drain only already-queued items up to a clamped maximum, and resolve one array.
The TypeScript generators yield that array one item at a time. The native root
and native `/portable` adapter use batching; WASM keeps its existing reader, and
the resulting bounded scheduling differences are explicitly part of the
portable parity contract rather than being hidden.

**Tech stack:** Rust, Tokio bounded `mpsc`, napi-rs 2.16.17, Bun 1.3.14+, TypeScript,
Bun test, Playwright/Chromium, and source-bound JSON performance evidence.

Status: **APPROVAL CANDIDATE, NOT SCHEDULED.** No H7 implementation exists.
Execution is forbidden until an architect and critic independently return
`APPROVED` for the exact same file digest. Approval is recorded outside this
file so recording it cannot invalidate the reviewed digest.

---

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
  datagram (`payload_buffer.rs:111-150`) plus one `napi_set_element` per
  element are UNCHANGED by batching. Only the TSFN/deferred/Promise/
  `spawn_future` counts fold. Task 7 establishes the JS-side floor for
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
  `dgram_recv_rx` — `mpsc::channel::<Vec<u8>>(256)` (`client.rs:735`; the
  adjacent send channel at `client.rs:734` shares the 256 capacity) with
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
#[napi(ts_return_type = "Promise<Uint8Array[] | null>")]
pub fn read_datagram_batch(&self, env: Env, max: u32) -> Result<JsObject>

// client (client.rs), spawn_future so a parked read does not exclusively
// borrow the napi handle and prevent close() from running:
#[napi(ts_return_type = "Promise<Uint8Array[] | null>")]
pub fn read_datagram_batch(&self, env: Env, max: u32) -> Result<JsObject>
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
- Resolve values: non-empty `Uint8Array[]`, or `null` (channel EOF **or session
  not in registry**, `session.rs:176-177` — same as today's single read).
  **Empty array is never returned** (verified to hold on every path). If
  EOF lands after some datagrams were drained, resolve the partial batch;
  `null` surfaces on the next call.
- **Reject-free semantic paths, both handles**: `session.rs:175-184` and
  `client.rs:556-566` return `Ok` for data, EOF, and closure. No user input
  or lifecycle state becomes `Err`, so no error-string sentinel is needed.
  A runtime join panic or unrecoverable napi allocation/materialization failure
  can still reject, as on the existing single-read infrastructure; those are
  not encoded as ordinary transport outcomes.
- Client borrow design: replace today's `#[napi] async fn(&self)` single read
  and add the batch method as synchronous napi entrypoints. Both clone their
  receiver/metrics/lifecycle Arcs before returning and use
  `env.spawn_future` plus `CLIENT_RUNTIME.spawn`. Neither a parked legacy
  nor batch read holds the exclusive napi borrow that `client.rs:588-592`
  warns about, so concurrent `close()` can reach the direct wake path.
- Payloads use the default arraybuffer path. Tasks 2 and 3 assert per-element
  `arraybuffer_delivery()` gating applies through `Vec<PayloadBuffer>`
  and extra-memory accounting is charged once per element, not
  double-counted per batch.
- Existing `read_datagram` methods are kept on both handles (legacy knob
  path, evidence tooling), but are retrofitted onto the same sticky lifecycle
  wait as the batch methods: server single-read extracts one item from the
  shared max=1 helper; client single-read uses the same cloned-state routine
  with max=1. It therefore remains one napi Promise/TSFN per datagram for a
  valid performance/rollback control while gaining deterministic close wake.
  `discard_datagram` / `discard_datagrams` share the server lock and are
  unaffected; the batch reader holds `dgram_rx` slightly longer per
  acquisition (pre-existing contention, noted).

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
in-flight data. Both bounds get dedicated tests (Task 3, server + client
twins).

### Documented semantic deviations (beyond the buffering bound)

1. The generator's `while (!session.#closed)` guard now admits up to `max`
   post-close yields of already-delivered datagrams instead of 1.
2. Mid-batch abandonment of the generator now discards up to `max - 1`
   already-received datagrams instead of at most 1.
3. Close-time drop-not-drain: on a sticky close, a parked or newly-entered
   native read returns EOF (`None`/`null`) immediately and datagrams still
   queued in the native channel are discarded. Today a parked
   `rx.recv().await` drains every buffered item before yielding `None` once
   the sender drops; the sticky-close select changes that. This deviation
   applies to BOTH handles and to BOTH lanes — knob=0 legacy reads share the
   sticky lifecycle wake, so it is not confined to the batch path. The
   deviation is about JS-visible delivery only: reservation accounting for
   the discarded remainder is settled internally in both directions (server
   via `DatagramSlot` `Drop` at registry removal, client via Task 2's
   reader-owned and terminal-task drains), so no budget or gauge remains
   stranded once teardown settles. Settlement is bounded, not instantaneous
   — tests assert it with bounded polls.

All three are stated here, asserted by Tasks 1 and 3, and land in the public
docs (Task 5A). Datagrams are droppable by contract, so all three are
acceptable — but they are changes and are not hidden.

### `/portable` contract decision (resolved, not deferred)

Option selected: native batching remains active when a native `ServerSession`
is reached through `@webtransport-bun/webtransport/portable`. We do **not** add
a second unbatched adapter path and we do **not** change the WASM engine merely
to imitate native queue scheduling.

The common portable contract remains equal for the behavior applications can
depend on: one memoized single-consumer iterable, `Uint8Array` items,
preservation of the order in which each backend surfaces received datagrams,
bounded termination, and datagram drop tolerance. It no longer claims
identical prefetch depth after close or
abandonment. Native may have up to `max` already-materialized items after
close, may discard up to `max - 1` on abandonment, and discards datagrams
still queued natively at close time (close-time drop-not-drain, deviation 3)
where WASM's Web Streams buffer would still surface already-enqueued chunks;
WASM retains its existing Web Streams buffering behavior. This is an observable backend divergence and is
therefore updated in all of the following exact places:

- `packages/webtransport/src/portable.ts` — API comment defines the common
  guarantee and explicitly excludes backend queue/prefetch depth.
- `docs/PARITY_MATRIX.md` — `incomingDatagrams()` becomes **Equal within the
  contract**, with the native and WASM bounds stated separately.
- `packages/webtransport/test/public-surface-contract.test.ts` — freezes the
  common guarantees on live native and WASM sessions without asserting equal
  hidden buffering.
- `packages/webtransport/test/parity-datagrams.test.ts` — proves both backends
  retain ordered per-item delivery and bounded EOF behavior.
- `tools/interop/tests/h7-datagram-batch.pw.ts` — a dedicated, single-test
  Chromium proof that exercises datagrams across native batch boundaries with
  bounded reads; generic Playwright discovery cannot substitute for it.

This decision is a documentation-compatible narrowing of what “equal” means
for an unreliable, droppable transport; it is not permission to diverge on
item type, memoization, open-session ordering, or termination.

### TS (`packages/webtransport/src/index.ts`)

- `NativeSessionHandle.readDatagramBatch(max: number):
  Promise<Uint8Array[] | null>` added to the shared interface
  (`index.ts:1106`) — required on both handles, no optional-with-fallback
  split. The JS package and bundled prebuild are version-bound; Task 3 adds a
  first-pull compatibility guard so a stale override addon fails with stable
  `E_INTERNAL` rather than silently disabling H7.
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
  Knob=0 status: exercised by Task 3 routing/lifecycle tests and used as Task
  8's preregistered per-item performance control. It is the rollback/evidence
  lane, not the production default.

- The two `__TESTING__` session factories at `index.ts:3889-3907` remain test
  seams, not compatibility loopholes. Their synthetic handles are updated in
  `packages/webtransport/test/internal-error-propagation.test.ts` to stub
  `readDatagramBatch`; the legacy error-path assertions continue to use
  knob=0 in a fresh subprocess because the batch method is reject-free.

### Payload materialization proof (exact surface)

`Vec<PayloadBuffer>` conversion crosses napi-rs once per element. This is not
accepted from type inference alone:

1. `crates/native/src/payload_buffer.rs` gains a small pure delivery-plan
   classifier used by the real `ToNapiValue` implementation. Rust unit tests
   lock the four actual branches: empty, engine-owned ArrayBuffer, buffer-copy
   escape hatch, and accounted external buffer. The engine-owned branch has no
   explicit `napi_adjust_external_memory`; the external branch has one positive
   charge and exactly one matching negative path (finalizer or construction
   failure).
2. `packages/webtransport/test/datagram-batch-delivery.test.ts` drives real
   server and client batch reads through the built addon. For every network-
   valid datagram it asserts bytes, `Uint8Array`, backing `ArrayBuffer`, and
   default small-payload non-`Buffer` identity. Because a >256 KiB datagram is
   invalid on the transport, Task 2 also adds one read-only native test seam
   that returns an actual `Vec<PayloadBuffer>` through napi-rs. The integration
   test passes empty, small, and `ENGINE_OWNED_MAX_BYTES + 1` payloads through
   that seam and proves the large result is the byte-identical external
   `Buffer` branch. A bounded child-process case sets
   `WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy` before module load (the mode is
   a `OnceLock`) and proves the small-payload escape hatch remains a `Buffer`
   per element. Thus all four production materialization branches cross the
   real addon; the armed-guard unit tests remain the authoritative proof of
   exactly-once charge/uncharge, including construction failure.
3. The same integration test records `process.memoryUsage().arrayBuffers` and
   `external` only as diagnostics. Those noisy process-wide counters cannot
   substitute for the branch/unit proof or the source-bound soak gate.

### Documentation (Tasks 5A, 5B, and 6)

The exact public/authoritative targets are `README.md`, `docs/SPEC.md`,
`docs/PARITY_MATRIX.md`, `docs/TESTPLAN.md`, `docs/CI.md`,
`docs/RELEASE_CHECKLIST.md`, `tools/load/README.md`, and the API comment in
`packages/webtransport/src/portable.ts`. They document the batch mechanism,
per-handle buffering-bound change, the three semantic deviations, the knob, the
resolved `/portable` contract above, and an explicit “native backends only —
WASM delivery is not napi” note. `docs/CI.md`, `docs/RELEASE_CHECKLIST.md`, and
`tools/load/README.md` jointly own the operator-facing 2-hour H7 hosted lane,
its dispatch inputs, unique run identity, downloaded-artifact verification,
and its relationship to the existing 1h/24h/72h soak modes. No unnamed public
API, load-operator, or CI/release contract remains for an executor to guess.

### Explicitly out of scope (follow-ups)

- **Send-side batching** (`send_datagram_batch`): the next lever for the
  video downstream story; separate surface with its own partial-failure
  semantics. Task 8's bench changes make its future win independently
  measurable.
- WASM backend: unaffected.
- Option B (long-lived push TSFN): still rejected. If Task 7 shows the
  async generator itself is the floor, the recorded fallback is exposing
  the batch array as an internal API for hot consumers (noted, not scoped).

## Execution discipline

- Execute in this worktree only. Before every evidence run record `pwd`,
  `git rev-parse HEAD`, `git status --short`, Bun version, Rust version,
  platform/architecture, command, and resolved batch knob.
- Each task below is one scoped logical commit and touches at most six files.
  Use the repository Lore trailers, including exact `Tested:` and honest
  `Not-tested:` entries. Never commit generated evidence.
- Write the failing test first, run it and capture the expected failure, then
  implement the minimum change and rerun the same test. A test that never
  demonstrated the pre-change failure is not regression proof.
- Every async iterator/read uses the existing bounded helpers or an explicit
  timeout. A timeout, missing tool, unavailable Chromium, dirty tree, identity
  mismatch, or statistically invalid control is `BLOCKED`, never `PASS`.
- Do not start Task 8 until Task 7's preliminary clean-tree floor passes. Do
  not dispatch the hosted soak until Task 10 has re-run Tasks 4 and 7–9 and all
  resulting artifacts pass on one immutable clean candidate SHA.
- Review may occur while this plan is the worktree's only dirty file. Before
  Task 0, the maintainer must intentionally persist the reviewed artifact
  (normally an explicitly authorized plan-only commit). The executor must not
  auto-commit, stash, or rewrite this plan. Implementation and source-bound
  evidence begin only after the chosen persistence route leaves a clean tree
  and the persisted bytes still match the approved digest.

## Task 0 — Freeze the starting evidence and candidate identity

**Files:** none.

- [ ] Record the worktree, branch, clean status, current HEAD, plan digest,
      Bun version, and Rust version.
- [ ] Preserve the historical baseline only as context: bandwidth run
      `31889419627` at source `0c49acf` found the 110–115 Mbps knee; the
      2026-08-12 lc-matrix numbers are diagnostic history, not fresh H7 proof.
- [ ] Build and test the unchanged candidate so implementation failures are
      distinguishable from pre-existing failures.

Run:

```bash
git status --short
git rev-parse HEAD
shasum -a 256 docs/superpowers/plans/2026-08-15-h7-batch-delivery-execution-plan.md
bun --version
rustc -V
cargo test -p native
cargo clippy -p native --all-targets -- -D warnings
bun run typecheck
```

Expected: clean status and all commands exit 0. Record any pre-existing failure
verbatim and stop; do not edit a gate to accommodate it.

## Task 1 — Server batch read and direct lifecycle wake

**Files:**

- Modify: `crates/native/src/session_registry.rs`
- Modify: `crates/native/src/session.rs`
- Modify: `crates/native/src/session_napi.rs`

- [ ] Add failing Rust tests in the owning modules for max clamp (`0 → 1`,
      `1 → 1`, `64 → 64`, `>256 → 256`), first-item blocking, ordered
      `try_recv` drain, exact cap, partial-batch-before-EOF, EOF-with-no-items,
      missing registry entry, and “never empty array”.
- [ ] With the real `DGRAM_CHANNEL_CAPACITY == 2048`, fill a test channel,
      hold a clamped batch, refill the released slots, and assert exactly
      `2048 + batch_len` native-plus-held items while reservation bytes cover
      only the refilled native queue. One more `try_send` must fail.
- [ ] Add failing close-while-parked tests for both
      `read_datagram_for_session` and `read_datagram_batch_for_session`.
      Close the registry entry and require `None` within 1 second without
      relying on the datagram sender task eventually dropping. Include for
      each method a case where undelivered datagrams remain queued in the
      channel at close: the read must still return `None` within 1 second
      and must NOT deliver the queued remainder first (drop-not-drain,
      documented semantic deviation 3 — a real change from today's
      drain-then-`None` mpsc behavior, on both lanes including knob=0).
- [ ] Add a dedicated `datagram_lifecycle_notify: Arc<Notify>` to the registry
      session state, fired from `mark_state_closed_and_notify` alongside the
      existing notifies after the sticky flag is stored with `Release`. Add
      `get_datagram_read_state` beside `get_stream_accept_state`, returning
      the receiver, sticky `datagram_lifecycle_closed`, and that dedicated
      lifecycle notify. Reusing the shared `datagram_capacity_notify` for the
      read-side lifecycle wait is forbidden: `release_datagram_capacity` fires
      it on every send-capacity release, so a parked reader would wake and
      re-arm proportionally to send rate on the exact hot path this feature
      optimizes. Use the lost-wake registration order proven by
      `wait_stream_kind_capacity_with_timeout` in
      `session.rs:64-110` (not the plain stream-accept select loop): create
      and pin `notified()`, call `enable()`, then recheck the sticky flag
      before selecting against `rx.recv()`. Adapt that ordering to an
      un-timed lifecycle wait. A spurious wake loops and rechecks; only a
      true sticky close returns `None`. Registry removal therefore cannot
      lose a wake or turn normal capacity churn into false EOF.
- [ ] Implement `read_datagram_batch_for_session(id, max)` with one locked
      receiver: block for the first item, then `try_recv` up to the clamped cap.
      Taking each `DatagramSlot` releases its reservation exactly where the
      single-read path does today.
- [ ] Reimplement `read_datagram_for_session` as the max=1 extraction over
      that same helper. Preserve its existing return type and per-item
      materialization while making the legacy path consume the sticky close
      wake rather than a raw parked `recv()`.
- [ ] Add `WtSession.read_datagram_batch`. It creates one `spawn_future` per
      batch, maps each `Vec<u8>` to one `PayloadBuffer`, resolves a non-empty
      array or `null`, and introduces no semantic `Err` branch for user
      input, data, EOF, or closure.

Run:

```bash
cargo fmt --check
cargo test -p native session::
cargo test -p native session_registry::
cargo clippy -p native --all-targets -- -D warnings
```

Expected: targeted tests and clippy exit 0. Commit only these three files.

## Task 2 — Client batch read, lifecycle wake, and payload branch proof

**Files:**

- Modify: `crates/native/src/client.rs`
- Modify: `crates/native/src/payload_buffer.rs`
- Modify: `crates/native/src/lib.rs`

- [ ] Add failing client tests for the same clamp/order/first-item/partial-EOF
      matrix and for decrementing `client_metrics.queued_bytes` once per
      drained item. Test constructors around current `client.rs:1886/1934`
      use `channel(1)` and a 1024-byte budget; create batch-specific helpers
      with enough channel capacity rather than weakening assertions.
- [ ] Name the existing receive capacity as
      `CLIENT_DATAGRAM_RECV_CAPACITY == 256`. Fill it, hold a batch, refill,
      and assert exactly `256 + batch_len` native-plus-held items, no extra
      send capacity, and byte accounting only for the refilled native queue.
- [ ] Add a `datagram_lifecycle_notify: Arc<Notify>` to the handle. Notify it
      from local `initiate_close` and from the terminal connection task after
      setting the sticky `closed` flag with `Release` ordering.
      A shared internal read routine loads it with `Acquire` before and after
      pinning/enabling `notified()`, then selects it against `rx.recv()`, so
      local and remote close wake both legacy and batch parked reads within 1
      second without a lost-notify race. On a sticky close, a parked or
      newly-entered read returns `null` immediately without delivering
      datagrams still queued in the channel — drop-not-drain is the
      JS-visible semantic (documented deviation 3, not pre-existing
      behavior). The byte accounting is settled internally, with the owner
      and execution context of each refund named — an executor makes no
      concurrency decision here:
      1. **Reader-owned drain (primary).** The shared read routine, upon
         observing the sticky close and while still holding the
         `dgram_recv_rx` mutex guard, drains the remainder with a `try_recv`
         loop, refunds `client_metrics.queued_bytes` per item, and only then
         returns `null`. The mutex makes each item removable exactly once by
         exactly one holder, and the remover is the refunder, so double
         refund is structurally impossible.
      2. **Terminal-task final drain, sequenced after the last possible
         charge — drain, bounded wait, drain again.** The async terminal
         connection task, after storing the sticky flag with `Release` and
         firing the lifecycle notify:
         (a) immediately takes `.lock().await` and performs a
             drain-and-refund — this frees channel capacity and, together
             with part 3's interruptible send, guarantees a send-parked
             forwarder unparks;
         (b) waits for the forwarder's completion signal with an explicit
             BOUNDED timeout — the forwarder signals completion via a
             Drop-guard it holds for its whole body (a guard whose `Drop`
             fires a `Notify`/oneshot), so the signal fires on normal exit
             AND on panic unwind, making the wait panic-safe. Retaining a
             raw `JoinHandle` is not available here: the forwarder is
             spawned through `spawn_quic_task_scoped` (`client.rs:822`),
             which consumes the handle inside `panic_guard.rs`'s watchdog —
             do NOT swap in a bare `tokio::spawn` and lose `PanicScope::Conn`
             containment, and do not modify `panic_guard.rs` (not in this
             task's files). If the bounded wait expires, log and proceed:
             with part 3's interruptible send, a LIVE forwarder always exits
             promptly after the notify (its only two await points —
             `receive_datagram` and the select-wrapped send — are both
             close-bounded), so an expired wait implies a panicked or
             containment-killed forwarder, which is dead and cannot charge;
             the timeout therefore cannot reintroduce the charge-after-drain
             window and is panic insurance, not a substitute for bounded
             forwarder exit;
         (c) performs the final drain-and-refund. The forwarder is the sole
             receive-side charger (`try_reserve_client_queued_bytes` has
             exactly two call sites — `client.rs:532` send path,
             self-refunding, and `client.rs:825` forwarder), so once it has
             exited no further receive-side charge or enqueue is possible
             and this drain is genuinely final. **No receive-side charge can
             occur after the final drain.**
         This covers sessions that close with no reader parked or ever
         re-entering. The drain lives in the spawned terminal task body —
         NOT in the synchronous `finalize_client_terminal_state` helper
         (`client.rs:111`), which cannot await. `try_lock()` is forbidden
         (it silently skips the refund exactly when a reader holds the
         guard) and `blocking_lock()` is forbidden (panics on a runtime
         thread); `initiate_close` is a synchronous `fn` and therefore only
         stores the flag and notifies — it never drains inline.
      3. **Forwarder cooperation and interruptible enqueue.** The receive
         forwarder task (`client.rs:822-833`) checks the sticky flag with
         `Acquire` before each `try_reserve`/send and stops charging and
         enqueuing once it observes it; its exit path refunds anything
         charged but not handed over. The check is an optimization that
         shrinks the charge-after-drain window — it does NOT by itself close
         it, because check→charge→send straddles an `.await` and a charge
         can land after a drain that ran between the check and the send.
         CRITICALLY, the forwarder's enqueue must be interruptible: wrap
         `dgram_recv_tx.send(...)` in `tokio::select!` against the lifecycle
         notify, so a close unparks a forwarder blocked on a FULL channel
         (`client.rs:829` today parks unboundedly in `send().await` — a
         reachable, ordinary backpressure state, since 256 slots × ~1150 B
         ≈ 294 KB fills long before the 2 MiB per-session byte budget at
         `limits.rs:30-31` binds, and closing the QUIC connection neither
         frees a slot nor drops the receiver). Without this, part 2's wait
         deadlocks: terminal task waits on forwarder, forwarder waits on a
         free slot, and the only slot-freer is the terminal task. On the
         select's notify arm the forwarder refunds the charged-but-unhanded
         datagram through its existing exit-refund and breaks its loop.
         With it, the forwarder's exit is bounded from BOTH park points
         (`receive_datagram`, which errors when either close origin closes
         the connection — local `initiate_close` via `close_session` on the
         `Connection` clone, remote via the connection task — and the
         select-wrapped send). The forwarder's own exit-refund — not the
         read path — is the true structural analogue of the send-side
         teardown at `client.rs:809-817`, whose channel is exclusively
         owned by its task; the receive channel is mutex-shared, so that
         precedent transfers the refund shape but NOT the concurrency
         context.
      This explicit refund is mandatory: the receive reservation is charged
      at enqueue (`client.rs:825-831`) and refunded only on reader take
      (`client.rs:561`) or failed send — there is no `DatagramSlot`, so
      unlike the server's `Drop`-based refund, a discarded datagram would
      otherwise strand its bytes on a live handle (observable via
      `metricsSnapshot`, `client.rs:612`) and break success criterion 6's
      zero-stranded-gauges requirement. The JS-visible drop matches the
      server's registry-miss behavior; the refund mechanism intentionally
      differs (server: `DatagramSlot` `Drop`; client: reader- and
      terminal-task drains). Add bounded unit tests for both methods and
      both terminal origins, including at least one case per method where
      undelivered datagrams remain queued at close time with the read parked,
      proving drop-not-drain non-vacuously AND that `queued_bytes` settles
      to zero after a close that discarded queued items; additionally one
      bounded test closes the session while the forwarder is actively
      delivering (not only a pre-filled channel), and one bounded test
      closes while the receive channel is FULL with no reader attached —
      the interleaving that distinguishes the interruptible-send design
      from a deadlocking one (an actively-delivering forwarder on a
      non-full channel exits promptly under either design and does not
      discriminate). Both must complete teardown, fire the close callback,
      and settle `queued_bytes` to baseline within their bounds, so the
      part-2/part-3 ordering — not scheduling luck — is what the passing
      assertion proves. Because
      `queued_bytes` is one counter shared with the send direction
      (`client.rs:532`), write the zero assertions as bounded polls, not
      immediate reads, so an unwinding send-side teardown cannot flake them.
- [ ] Implement the client synchronous napi batch method shown in the Native
      API section and refactor the existing `read_datagram` to the same
      synchronous spawn-future shape with max=1. Clone the receiver, metrics,
      sticky-close flag, and lifecycle notify before returning; use
      `env.spawn_future` plus `CLIENT_RUNTIME.spawn` for the wait/drain.
      Preserve the existing single-read JS signature, the batch clamp,
      partial-then-EOF semantics, and reject-free data/EOF/closure paths.
- [ ] Refactor `PayloadBuffer::to_napi_value` to consume a pure delivery-plan
      classifier and add unit tests for empty, engine-owned, buffer-copy, and
      externally-accounted branches. The external branch uses an armed
      accounting guard: charge once, disarm only after finalizer ownership is
      successfully transferred, and let `Drop` balance every construction or
      handoff failure. Tests lock zero explicit adjustment on engine-owned and
      buffer-copy paths plus exactly one balanced charge for both successful
      and failed external construction outcomes. The production guard and its
      `#[cfg(test)]` recording adjuster share the same state machine; tests do
      not merely restate classifier output.
- [ ] Make the payload mode resolver in `payload_buffer.rs` the single source
      used by `ToNapiValue`, then expose its already-resolved value as the
      read-only addon diagnostic `nativePayloadDeliveryMode()` from `lib.rs`.
      It returns exactly `"arraybuffer"` or `"buffer-copy"` and must not
      reread or mutate the environment. Unit tests prove the exported value and
      conversion classifier use the same `OnceLock` decision.
- [ ] In `lib.rs`, add read-only internal addon seams
      `nativePayloadEngineOwnedMaxBytes()` and
      `materializePayloadBatchForTests(payloads)`. The latter maps copied
      input bytes to `Vec<PayloadBuffer>` and returns that vector directly,
      forcing napi-rs's real per-element `ToNapiValue` array conversion; it
      must not reimplement materialization or accounting. These are exposed to
      JavaScript only through Task 3's `__TESTING__` object and are never used
      by production session paths.

Run:

```bash
cargo fmt --check
cargo test -p native client::
cargo test -p native payload_buffer::
cargo test -p native
cargo clippy -p native --all-targets -- -D warnings
```

Expected: full native tests and clippy exit 0. Commit only these three files.

## Task 3 — TypeScript routing, real-addon conversion, and test seams

**Files:**

- Modify: `packages/webtransport/src/index.ts`
- Create: `packages/webtransport/test/datagram-batch-delivery.test.ts`
- Modify: `packages/webtransport/test/internal-error-propagation.test.ts`
- Create: `packages/webtransport/test/datagram-batch-lifecycle.test.ts`

- [ ] Add failing tests for knob parsing: unset/invalid → 64, `0` → legacy,
      `1` → new one-item path, `2..256` unchanged, negative → 0, and `>256`
      → 256. “Invalid” means empty, non-decimal, non-finite, or non-integer
      (including `1.5`); valid decimal integers are clamped to `0..256`.
      Read the environment once at module initialization; run every environment
      case in a fresh bounded child process so module caching cannot create a
      false pass. Expose a read-only resolved-config snapshot through
      `__TESTING__` for evidence harnesses.
- [ ] Add `nativePayloadDeliveryMode` to `NativeAddon` and expose a
      read-only `__TESTING__.nativePayloadDeliveryModeForTests()` accessor.
      Evidence mode treats its absence or any value outside the two exact
      literals as a hard error; it never guesses the active native mode from
      JavaScript environment state.
- [ ] Add the two Task 2 materialization seams to `NativeAddon` and
      `__TESTING__`. In a bounded real-addon child, send empty, small, and
      exactly `nativePayloadEngineOwnedMaxBytes() + 1` byte inputs through
      `materializePayloadBatchForTests`; assert ordered byte identity, the
      small default ArrayBuffer/non-`Buffer` branch, and the large external
      `Buffer` branch. Drop all views, run a bounded double full-GC settle,
      and require clean child exit. Process-wide external-memory counters are
      diagnostic only; Task 2's shared guard-state tests decide accounting
      balance and failure cleanup.
- [ ] Add the required handle method and update both generators. Knob 0 calls
      only `readDatagram`; other values call only `readDatagramBatch`, yield
      each returned item in order, and never request the next batch until the
      current array is drained.
- [ ] Factor the common batch-yield loop into one internal async-generator
      helper used by both native session classes and exposed through
      `__TESTING__`. Task 7 imports this exact helper, so its floor benchmark
      cannot drift into an approximation of the production loop.
- [ ] On first generator pull, if a mismatched override addon lacks
      `readDatagramBatch`, throw `E_INTERNAL: native addon/JavaScript version
      mismatch; rebuild the matching prebuild`. Do not silently fall back.
- [ ] Update synthetic client/server handles in
      `packages/webtransport/test/internal-error-propagation.test.ts` with the
      batch method. Run the legacy rejection assertions in a bounded child
      process with `WEBTRANSPORT_DATAGRAM_BATCH=0`; add batch-path assertions
      that closure resolves `null` rather than rejecting.
- [ ] Build the addon, then prove real server and client deliveries across
      1/2/64 boundaries, partial EOF, value identity, default ArrayBuffer
      backing, external-buffer seam behavior, and buffer-copy behavior in fresh
      bounded child processes.
- [ ] Add diagnostics behind module-init
      `WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1`: legacy-read calls,
      batch-read calls, materialized items, yielded items, maximum/mean observed
      batch size, and locally abandoned items. At generator creation select
      either a separately instrumented wrapper or the production helper.
      Expose snapshots only through `__TESTING__`; diagnostics-disabled
      production has no per-item counter or diagnostic branch in its hot loop.
- [ ] In `datagram-batch-lifecycle.test.ts`, add bounded live-addon tests for
      the server/client byte-budget twins and prove TypeScript holds no second
      batch while the consumer is paused. Correlate held-batch diagnostics with
      native reservation/`queued_bytes` release; Tasks 1 and 2 own the exact
      deterministic `2048 + max` and `256 + max` channel arithmetic.
- [ ] With batch=4, abandon after the first yield and assert exactly
      `observedBatchSize - 1` local discards, native reservations return to
      baseline, and teardown settles. In fresh bounded child processes for
      batch=0 and batch=64, cover the eight server/client × local/remote-close
      cases and require parked reads to return `done: true`/`null` within 1
      second; in each close case at least one undelivered datagram remains
      queued at close time, so the JS-visible drop-not-drain deviation is
      proven on both lanes rather than passing vacuously on an empty channel.
      Client close cases additionally assert the metrics snapshot shows
      `queued_bytes` settling back to baseline after the close (bounded
      poll, since the counter is shared with the send direction), per
      Task 2's reader- and terminal-task drains, so criterion 6's
      zero-stranded-gauges requirement is literally tested where the discard
      happens.

Run:

```bash
bun run build:native
bun test packages/webtransport/test/datagram-batch-delivery.test.ts
bun test packages/webtransport/test/datagram-batch-lifecycle.test.ts
bun test packages/webtransport/test/internal-error-propagation.test.ts
bun run typecheck
```

Expected: targeted tests and typecheck exit 0. Commit only these four files.

## Task 4 — Churn and hosted-soak evidence contract

**Files:**

- Create: `tools/load/datagram-batch-churn.ts`
- Modify: `tools/load/soak-addon.ts`
- Modify: `tools/load/soak-addon.test.ts`
- Modify: `.github/workflows/soak-long.yml`
- Modify: `scripts/validate-soak-inputs.sh`
- Modify: `packages/webtransport/test/internal-actions-policy.test.ts`

- [ ] Build a dedicated churn falsifier. It captures a post-module-load,
      warm-session-cycle, double-full-GC protected-object baseline, then
      churns/abandons/closes 100 server/client session pairs at concurrency 10,
      repeats the same GC settle, and writes
      `.release-evidence/h7/datagram-batch-churn.json`. Pass requires: artifact
      HEAD equals candidate; clean tree; delivered count reached; all native
      await gauges zero; post-minus-baseline total protected count ≤ 0; and no
      positive delta for `WtSession`, `ClientSessionHandle`, `Promise`, or
      `Function`. The script uses
      `require("bun:jsc").getProtectedObjects()` plus
      `__TESTING__.nativeAwaitProbeSnapshotForTests()`; missing constructor
      keys are recorded as zero, not invented. Its parent runs three fresh
      child trials, each bounded to 60 seconds, and all three must pass.
- [ ] Extend `soak-addon.ts` without changing its existing pass thresholds.
      Parse the load client's already-emitted `datagramsReceived` field and add
      a hashed `source: { head: string, dirty: boolean }` record plus one
      hashed `workflowSource: { ref: string | null, sha: string | null }`
      record sourced only from `GITHUB_REF`/`GITHUB_SHA`, plus one
      `h7Delivery` record to each segment:
      `{ datagramBatchRequested: string | null,
      datagramBatchResolved: number, payloadDeliveryRequested: string | null,
      payloadDeliveryResolved: "arraybuffer" | "buffer-copy",
      diagnosticsEnabled: boolean, diagnostics: counters | null,
      datagramsSent: number, datagramsReceived: number, deliveryRatio: number }`.
      Read the batch result from Task 3's resolved-config snapshot and payload
      mode from `nativePayloadDeliveryModeForTests()`; never duplicate either
      parser in the soak harness. When diagnostics are disabled, record
      `null` rather than turning them on.
      Local/diagnostic runs record null workflow-source fields; hosted H7 may
      not. Include `source`, `workflowSource`, and `h7Delivery` in the segment
      hash and carry all three, `runnerType`, `runnerMode`, `runnerProfile`,
      the exact `rates` tuple, non-counter configuration, and aggregate
      sent/received/ratio into the aggregate hash.
- [ ] Add a fail-closed
      `verify-h7-hosted <aggregate-json> <segment-json> --sha <40-hex>
      --batch <integer> --rss-ceil-mb <number> --duration-seconds <integer>
      --seed <string> --continuity-token <string>
      --workflow-ref <refs/tags/h7-batch-delivery-40-hex>`
      mode to `soak-addon.ts`. It must parse and hash-validate both downloaded
      JSON files, re-run `aggregateSegments([segment])`, require canonical
      equality with the downloaded aggregate, then require: exact SHA and clean
      source; `workflowSource.sha` exactly equals that SHA and
      `workflowSource.ref` exactly equals the supplied immutable tag ref in
      both segment and aggregate; exact seed and continuity-token digest; exact
      `runnerType == "self-hosted"`, `runnerMode == "dedicated"`, and
      `runnerProfile == "h7-fixed-large"`; exact rates `{ sessions: 500,
      datagramsPerSec: 500, streamsPerSec: 5 }` in both documents; one segment
      numbered 1/1; exact duration; requested/resolved batch `"64"`/64;
      null/default ArrayBuffer payload; diagnostics disabled;
      `datagram-echo` present; sent > 0 and received/sent ≥0.95; charged-memory
      peak ≤ the supplied 1750 MB ceiling; existing charged trend/recovery and
      final baseline guards passing; `heapDebug: false`; and the dispatched
      `committedAbortMb: 2200` circuit breaker (a margin heuristic above the
      1750 MB charged ceiling; the breaker gates RssAnon+VmSwap while the
      ceiling gates the charged metric, so the ordering is between two
      different metrics and is not a guarantee the breaker cannot fire
      first). The exact source SHA binds the
      already-documented symmetric allocator-relief sampling; the verifier
      neither invokes nor relaxes it. Success prints
      `soak-addon: H7 hosted PASS`; any missing, malformed, mismatched, or
      non-finite field exits nonzero. Add positive and one-field-at-a-time
      negative tests, including tampered hashes, wrong SHA/seed/token/batch/
      payload, missing/wrong workflow ref, missing/wrong workflow SHA, wrong
      runner type, wrong runner mode, wrong runner profile, each wrong rate,
      diagnostics enabled, low delivery, wrong duration, excessive peak, and
      non-baseline final gauges.
- [ ] Add required `workflow_dispatch` inputs `datagram_batch` (default 64,
      integer 0..256) and `rss_ceiling_mb` (default 1750, positive integer) to
      `soak-long.yml`. The 1750 default matches the harness's own
      load-proportional charged-ceiling default `max(1024, sessions × 3.5)`
      for the fixed 500-session H7 profile (`soak-addon.ts:79`); pinning 1024
      would predictably false-red the hosted lane for load-proportional
      reasons unrelated to H7. It remains a preregistered hard ceiling. Extend the existing authoritative
      `scripts/validate-soak-inputs.sh` policy surface with
      `DATAGRAM_BATCH` and `RSS_CEILING_MB`: require decimal integers,
      batch in 0..256, and RSS ceiling >0. Thread both workflow inputs into that
      validator and move the existing “Validate campaign inputs” step to
      immediately after checkout, before Rust/Node/Bun setup. Then propagate
      the validated values to every segment and aggregate step as
      `WEBTRANSPORT_DATAGRAM_BATCH` and `SOAK_RSS_CEIL_MB`. Extend
      `soak-addon.test.ts` to execute the shared validator across boundary and
      malformed cases (batch 0/256 pass; empty/-1/257/1.5 fail; RSS 1 passes;
      empty/0/-1/1.5 fail), parse the workflow, assert the validator/env
      threading and pre-setup ordering, and assert the soak artifact records
      the resolved knob and RSS ceiling.
      The independent action-policy suite also shells this validator and reads
      `soak-long.yml`; update its valid fixture with `DATAGRAM_BATCH=64` and
      `RSS_CEILING_MB=1750`, add one-field invalid cases for both new inputs,
      and lock the new workflow inputs, env threading, early validation step,
      and run-name without weakening its existing shell-injection checks.
      Map `WORKFLOW_REF: ${{ github.ref }}` and
      `WORKFLOW_SHA: ${{ github.sha }}` into the validator. When
      `CANDIDATE_REF` matches
      `refs/tags/h7-batch-delivery-<40-lowercase-hex>`, fail before setup unless
      the tag suffix, `CANDIDATE_COMMIT`, `WORKFLOW_SHA`, and checked-out HEAD
      are identical and `WORKFLOW_REF == CANDIDATE_REF`; existing non-H7 soak
      modes retain their current candidate-ref policy. Both policy suites add
      positive H7-tag coverage plus one-field ref/SHA/tag-suffix mismatch
      negatives and lock the `github.ref`/`github.sha` mappings. For that H7
      tag shape, the validator also requires the complete fixed lane tuple:
      `duration_hours=2`, `runner_type=self-hosted`,
      `runner_mode=dedicated`, `segment_index=1`, `segment_count=1`,
      `datagram_batch=64`, `rss_ceiling_mb=1750`, and
      `committed_abort_mb=2200` (thread the existing workflow input into the
      validator for this check, so a wrong breaker fails pre-setup like every
      other H7 field rather than after the 2-hour run); mutate each field in
      a negative case. In the capacity-profile step, an H7-tagged run must fail
      rather than downscale unless `RUNNER_CPUS >= 5` and
      `RUNNER_MEM_GB >= 8`; a qualifying runner is forced to
      `SOAK_PROFILE=h7-fixed-large`, `SOAK_SESSIONS=500`,
      `SOAK_DATAGRAMS_PER_SEC=500`, and `SOAK_STREAMS_PER_SEC=5` regardless of
      normal profile auto-selection. Map `WORKFLOW_REF: ${{ github.ref }}` and
      `CANDIDATE_REF: ${{ github.event.inputs.candidate_ref }}` into that
      capacity step and enter the fixed branch only after their H7 identity was
      validated; do not rely on state implicitly crossing workflow steps.
      Non-H7 1h/24h/72h runs retain the existing adaptive profiles. Both policy
      suites lock the mappings, fixed branch, its insufficient-capacity
      failure, and the absence of H7 downscaling.
      The workflow launches the soak through
      `env -u WEBTRANSPORT_PAYLOAD_DELIVERY`; the artifact must record a null
      request/default ArrayBuffer mode, and the source-contract test locks that
      command so a self-hosted runner cannot inject the diagnostic escape hatch.
      Also launch through
      `env -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS`, so the 2-hour product
      run has no diagnostic hot-loop wrapper; lock both unsets in the
      source-contract test. Set the shared workflow's neutral top-level
      `run-name: soak-long-${{ inputs.campaign_seed }}` and lock it in the same
      test so Task 10 can identify its unique dispatch without mislabeling
      routine 1h/24h/72h runs or guessing from the newest run for a commit.

Run:

```bash
bun test tools/load/soak-addon.test.ts
bun test packages/webtransport/test/internal-actions-policy.test.ts
```

Expected: tests exit 0. Commit only these six files, confirm the tree is clean,
then run the preliminary churn falsifier:

```bash
env -u WEBTRANSPORT_PAYLOAD_DELIVERY WEBTRANSPORT_DATAGRAM_BATCH=64 WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1 bun tools/load/datagram-batch-churn.ts
```

The preliminary churn JSON must say `status: "pass"`; Task 10 overwrites it
with a final-candidate run after all later harness commits. Evidence remains
untracked.

## Task 5A — Portable contract and authoritative API documentation

**Files:**

- Modify: `packages/webtransport/src/portable.ts`
- Modify: `docs/SPEC.md`
- Modify: `docs/PARITY_MATRIX.md`
- Modify: `docs/TESTPLAN.md`
- Modify: `README.md`

- [ ] Write the resolved `/portable` contract from this plan into the five
      API/behavior targets (`portable.ts`, `SPEC`, `PARITY_MATRIX`, `TESTPLAN`,
      and `README`). State common guarantees and backend-specific prefetch,
      post-close, abandonment, close-time drop-not-drain, and buffering
      bounds without calling WASM batched.
- [ ] Document knob parsing/default/escape semantics and make clear the knob is
      native-only and read once at module load.
- [ ] Add the exact unit, parity, interop, floor, bandwidth, memory A/B, churn,
      and hosted-soak commands/artifact paths from Tasks 3–10 to `TESTPLAN.md`.
- [ ] Assert doc truth with searches: no remaining claim that portable
      `incomingDatagrams()` has identical hidden buffering and no unnamed
      “public API doc” placeholder.

Run:

```bash
rg -n "incomingDatagrams|WEBTRANSPORT_DATAGRAM_BATCH|2048 \+ max|256 \+ max|drop-not-drain" README.md docs/SPEC.md docs/PARITY_MATRIX.md docs/TESTPLAN.md packages/webtransport/src/portable.ts
bun run typecheck
```

Expected: all five targets contain consistent language and typecheck exits 0.
Commit only these five files.

## Task 5B — Hosted H7 operator documentation

**Files:**

- Modify: `docs/CI.md`
- Modify: `docs/RELEASE_CHECKLIST.md`
- Modify: `tools/load/README.md`
- Modify: `scripts/check-doc-truth.ts`
- Modify: `packages/webtransport/test/internal-doc-truth.test.ts`

- [ ] Update all three operator-facing soak contracts together. Keep the
      existing 1h/24h/72h modes, add the required 2-hour H7 closure lane, and
      state that H7 evidence supplements rather than replaces the longer
      routine/RC/stable soak policy.
- [ ] Document the exact H7 dispatch values `duration_hours=2`,
      `runner_type=self-hosted`, `runner_mode=dedicated`,
      `datagram_batch=64`, and `rss_ceiling_mb=1750`; the unique
      `soak-long-<campaign_seed>` run identity; fixed
      `runner_profile=h7-fixed-large`, `sessions=500`,
      `datagrams_per_sec=500`, and `streams_per_sec=5`; minimum runner capacity
      of 5 CPUs and 8 GiB with fail-closed refusal instead of downscaling;
      SHA-plus-display-title discovery; exact segment/aggregate download by
      immutable run ID; and fail-closed `verify-h7-hosted` acceptance on the
      same candidate SHA and exact workload tuple.
- [ ] Keep the existing release-gate truth intact. `docs/CI.md` may continue to
      delegate full soak requirements to `docs/RELEASE_CHECKLIST.md` only
      because both files now describe the same H7 exception and the same
      non-substitution rule. Update `tools/load/README.md` so its advertised
      soak-long modes and artifact workflow no longer omit the 2-hour H7 lane.
      While touching the delegated checklist, reconcile its stale self-hosted
      24h/72h `segment_count=4|12` wording with the workflow's enforced
      `segment_count=1`; retain GitHub-hosted 5/15 segmentation. The doc-truth
      policy locks those exact runner-specific values.
- [ ] Extend `check-doc-truth.ts` to read all three operator docs and require
      an exact common H7 contract: the phrase `H7 hosted closure lane`,
      `duration_hours=2`, `runner_type=self-hosted`,
      `runner_mode=dedicated`, `datagram_batch=64`,
      `rss_ceiling_mb=1750`, `soak-long-<campaign_seed>`,
      `runner_profile=h7-fixed-large`, `sessions=500`,
      `datagrams_per_sec=500`, `streams_per_sec=5`, the 5-CPU/8-GiB minimum,
      the fail-closed no-downscale rule, an immutable
      `refs/tags/h7-batch-delivery-<candidate-sha>` workflow ref,
      `verify-h7-hosted`, and the sentence `does not replace the 24h/72h
      release soak`. Fail if `docs/CI.md` or `tools/load/README.md` retains an
      exclusive `1h/24h/72h` soak-long mode list. In `tools/load/README.md`,
      relabel the separate 30-minute `soak.ts` path as a legacy local
      diagnostic, not hosted H7 evidence; reject text that calls that path H7,
      release, or soak-long evidence.
- [ ] Extend `internal-doc-truth.test.ts` to create the
      `tools/load/README.md` fixture and exact passing H7 text for all three
      docs. Add one-mutation-at-a-time negative cases for each missing required
      token, the stale exclusive mode list, a missing non-substitution sentence,
      and a 30-minute/nightly diagnostic mislabeled as H7 evidence. Retain every
      existing release-blocking gate and readiness-deferral assertion.

Run:

```bash
rg -n "soak-long|2-hour|datagram_batch|rss_ceiling_mb|h7-fixed-large|sessions=500|datagrams_per_sec=500|streams_per_sec=5|verify-h7-hosted|1h|24h|72h" docs/CI.md docs/RELEASE_CHECKLIST.md tools/load/README.md
bun scripts/check-doc-truth.ts
bun test packages/webtransport/test/internal-doc-truth.test.ts
```

Expected: all three docs agree, doc-truth exits 0, and every positive/negative
fixture passes. Commit only these five files.

## Task 6 — Parity and Chromium interop

**Files:**

- Modify: `packages/webtransport/test/public-surface-contract.test.ts`
- Modify: `packages/webtransport/test/parity-datagrams.test.ts`
- Create: `tools/interop/tests/h7-datagram-batch.pw.ts`
- Modify: `tools/interop/web-server-env.ts`
- Modify: `tools/interop/verify-evidence.ts`
- Modify: `tools/interop/tests/security-evidence.test.ts`

- [ ] Freeze the narrowed portable contract on live native and WASM sessions:
      memoization, `Uint8Array`, each backend's receive-queue order, per-item
      yields, and bounded EOF remain equal; exact post-close buffered count is
      asserted only for native in Task 3.
- [ ] Add `WEBTRANSPORT_DATAGRAM_BATCH` to both duplicated interop server-env
      policy surfaces: the launcher allowlist in `web-server-env.ts` and the
      evidence-verifier allowlist in `verify-evidence.ts`. Extend
      `security-evidence.test.ts` to prove both accept the new key and still
      reject an unknown key, so Playwright passes the chosen knob to the addon
      server without weakening evidence validation. Also add a
      `verify-h7-playwright-report <json>` mode to `verify-evidence.ts` that
      parses Playwright's JSON reporter output, requires exactly one discovered
      test case, exactly one executed result with status `passed`, zero skipped,
      interrupted, failed, timed-out, or unexpected results, and the exact H7
      title. Positive and one-field/result-status negative fixtures live in
      `security-evidence.test.ts`.
- [ ] The H7 report transport is never stdout, and the evidence sanitizer is
      never disabled. `tools/interop/playwright.config.ts` pipes the interop
      web-server's stdout into the runner's stdout, so a stdout-redirected
      JSON report would interleave server log lines and be unparseable; and a
      CLI `--reporter=json` flag would replace the `INTEROP_EVIDENCE=1`
      reporter chain (list + json `outputFile: interop-evidence.json` +
      evidence sanitizer), silently disabling the sanitizer. The H7 command
      therefore passes **no** `--reporter` flag: it runs under
      `INTEROP_EVIDENCE=1` so the config's own JSON reporter writes
      `tools/interop/interop-evidence.json` with the sanitizer active, and the
      harness copies that file to the report path before verification. The
      config-written file is the same Playwright JSON reporter format the
      verifier parses. No `playwright.config.ts` change is required, and this
      task must not modify it. Every H7 invocation removes any pre-existing
      `tools/interop/interop-evidence.json` immediately before running, so a
      failed run can never leave a stale predecessor for the copy step; and
      because that filename is also the generic release interop artifact
      (`release.yml` verifies it), full-verification sequences run the H7
      case BEFORE the generic suite so the full-suite evidence is what
      remains on disk afterward.
- [ ] Create `h7-datagram-batch.pw.ts` with exactly one non-skipped test named
      `H7 batch=4 delivers a unique bounded Chromium burst`. It sends a bounded
      burst carrying unique sequence IDs and runs with batch=4 to cross several
      batch boundaries. Because QUIC datagrams are unreliable, pass requires at
      least 95 of 100 unique echoes within 10 seconds and no duplicate/corrupt
      IDs; it must not require all 100 packets or impose network ordering. The
      file may not use `test.skip`, `test.fixme`, `test.describe.skip`,
      `test.describe.fixme`, or a conditional early return. Lock those source
      constraints in `security-evidence.test.ts`; the reporter verifier is the
      authoritative executed/skipped count, including suite-level skips. The
      live native/WASM parity tests separately prove that each local receive
      queue preserves the order in which its backend observed datagrams.

Run:

```bash
bun run build:native
bun run build:wasm
bun run build:wasm:dist
WEBTRANSPORT_REQUIRE_WASM=1 WEBTRANSPORT_REQUIRE_WASM_DIST=1 bun test packages/webtransport/test/public-surface-contract.test.ts packages/webtransport/test/parity-datagrams.test.ts
bun test tools/interop/tests/security-evidence.test.ts
H7_PLAYWRIGHT_REPORT="$(mktemp)"
rm -f tools/interop/interop-evidence.json
(cd tools/interop && env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=4 INTEROP_EVIDENCE=1 bunx playwright test tests/h7-datagram-batch.pw.ts)
cp tools/interop/interop-evidence.json "$H7_PLAYWRIGHT_REPORT"
bun tools/interop/verify-evidence.ts verify-h7-playwright-report "$H7_PLAYWRIGHT_REPORT"
```

Expected: parity and interop pass. If WASM or local Chromium is unavailable,
record `BLOCKED`; a skipped parity suite or absent browser is not approval.
Commit only these six files.

## Task 7 — JS-floor microbenchmark (mandatory stop/go before load CI)

**Files:**

- Create: `tools/bench/datagram-delivery-floor.ts`
- Create: `tools/bench/datagram-delivery-floor.test.ts`
- Modify: `package.json`

- [ ] Build a deterministic benchmark of the exact rewritten generator over
      pre-filled batches for sizes 1/16/64/256 plus a direct callback loop.
      Use 1-second warmup and seven 2-second samples per arm; randomize arm
      order; record every sample, median, minimum, environment identity, dirty
      state, command, and requested/resolved diagnostics state in
      `.release-evidence/h7/datagram-delivery-floor.json`.
- [ ] Fail closed on non-finite samples, wrong sample count, dirty tree, or
      artifact HEAD mismatch, and refuse
      `WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1` so this measures the
      branch-free production helper. Unit-test parsing, aggregation, identity
      refusal, diagnostic-mode refusal, and both sides of every threshold.
- [ ] Add the exact package script
      `"bench:h7-floor": "bun tools/bench/datagram-delivery-floor.ts"`.
- [ ] Gate the intended default (64) on both conditions: minimum measured
      generator rate ≥ 50,000 items/s (2× headroom over the ≥25,000 items/s
      receive target derived from the old ~12,500/s ceiling), and median rate
      ≥ 2.0× the batch=1 generator. Sizes 16/256 and callback ratio are recorded
      diagnostics, not alternate ways to pass.

Run:

```bash
bun test tools/bench/datagram-delivery-floor.test.ts
bun run typecheck
```

Expected: unit tests and typecheck exit 0. Commit only these three files,
confirm the tree is clean, then run
`env -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS bun run bench:h7-floor`. The
preliminary
artifact must say `status: "pass"` with both numeric conditions true.
Otherwise STOP before implementing Tasks 8–9 and revisit the internal
batch-array fallback as a new reviewed plan. Task 10 re-runs the floor on the
final candidate SHA.

## Task 8 — Receive-isolated, same-SHA bandwidth A/B

**Files:**

- Modify: `tools/load/bench-bandwidth.ts`
- Create: `tools/load/compare-h7-bandwidth.ts`
- Create: `tools/load/compare-h7-bandwidth.test.ts`
- Modify: `tools/load/distributed-scale.ts`
- Modify: `tools/load/distributed-scale.test.ts`
- Modify: `tools/load/load-scale-addon.ts`

- [ ] Add fail-closed `BENCH_ECHO=0|1`. Receive-only mode consumes and counts
      without awaiting `sendDatagram`; echo mode remains the composite
      diagnostic. Record offered/serverRx datagrams/s and Mbps separately.
      Export a pure `resolveBandwidthCliConfig(env)` and artifact builder, and
      guard execution with `import.meta.main`. Extend
      `compare-h7-bandwidth.test.ts` with fast coverage for unset/0/1/malformed
      echo parsing, receive/echo artifact fields, non-finite rates, dirty/SHA/
      diagnostics refusal, and both promotable and refused documents, so the
      new harness behavior is proven before the expensive final run.
- [ ] Add artifact identity: HEAD, dirty state, Bun/Rust versions, platform,
      machine fingerprint, resolved batch knob, echo mode, rates, durations,
      requested payload-delivery environment, requested/resolved batch-
      diagnostics state, and raw per-step samples. Promotable bandwidth
      evidence refuses diagnostics-enabled mode.
- [ ] Extend distributed-scale artifacts with the Task 3 resolved batch config
      and the requested payload-delivery environment (`null` means the default
      ArrayBuffer path), requested/resolved batch-diagnostics state, plus
      `source.dirty`. Preserve the real CLI/library boundary:
      `load-scale-addon.ts` is the sole parser for the **new H7 evidence
      variables** `LOAD_SCALE_H7_EVIDENCE` and `LOAD_SCALE_EXPECTED_SHA`, with
      exact `0|1` semantics and a required full SHA when enabled, and passes a
      typed H7-evidence request into `runScaleCampaign`. Extract and export a
      pure `resolveLoadScaleCliConfig(env)` and guard execution with
      `import.meta.main`, so parser tests cannot accidentally start a campaign.
      `distributed-scale.ts` keeps its existing direct CLI and an exported pure
      `resolveDistributedScaleCliConfig(env)` for the established campaign
      variables: `LOAD_SCALE_CLIENT_LAUNCHES_JSON`, `LOAD_SCALE_LABEL`,
      `LOAD_SCALE_SESSIONS`, `LOAD_SCALE_DURATION`, `LOAD_SCALE_SERVER_COUNT`,
      `LOAD_SCALE_CLIENT_COUNT`, `LOAD_SCALE_BASE_PORT`,
      `LOAD_SCALE_DATAGRAMS_PER_SEC`, `LOAD_SCALE_STREAMS_PER_SEC`,
      `LOAD_SCALE_WORKLOAD_MODE`, `LOAD_SCALE_MIN_DELIVERY_RATIO`,
      `LOAD_SCALE_MIN_SUCCESS_RATE`, `LOAD_SCALE_MIN_LIVE_SESSIONS`,
      `LOAD_SCALE_MIN_LIVE_SET_HOLD_MS`,
      `LOAD_SCALE_MIN_SOURCE_IDENTITIES`, `LOAD_SCALE_MAX_RSS_MB`,
      `LOAD_SCALE_MAX_RECOVERY_RSS_RATIO`, `LOAD_SCALE_MAX_FAIRNESS_GAP`,
      `LOAD_SCALE_MAX_STREAM_ERROR_RATE`, `LOAD_SCALE_P99_HANDSHAKE_MS`,
      `LOAD_SCALE_P99_DATAGRAM_MS`, `LOAD_SCALE_P99_STREAM_OPEN_MS`,
      `LOAD_SCALE_OVERLOAD_SESSIONS_PER_SERVER`,
      `LOAD_SCALE_OVERLOAD_RECOVERY_TIMEOUT_MS`, `LOAD_SCALE_ARTIFACT_OUT`,
      and `LOAD_SCALE_CLIENT_TARGET_HOST`.
      Its intentional legacy library-level environment reads remain exactly
      `LOAD_SCALE_ACK_REVIEW`, `LOAD_CLIENT_PROBE_TIMEOUT_MS`,
      `LOAD_SCALE_CLIENT_BIN`, `LOAD_SCALE_PROCESS_ISOLATED_RSS_JSON`, and
      `LOAD_SCALE_TRANSPORT_POLICY_REVISION`; no H7 evidence variable may be
      read there. `distributed-scale.ts` owns H7 enforcement and artifact truth
      only from the explicit typed request, records that request, and a direct
      CLI invocation cannot label an artifact H7-promotable. When H7 evidence
      is enabled it refuses SHA mismatch,
      a dirty tree, resolved batch other than 64, non-default payload mode, or
      enabled `WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS` before it can emit
      promotable release evidence. `distributed-scale.test.ts` exercises the
      pure wrapper parser for unset, 0, 1, malformed, and missing/invalid SHA
      cases; locks the legacy direct CLI parser and enumerated environment-read
      boundary; proves direct CLI output is not H7 evidence; then covers every
      typed-request library refusal branch and the exact passing document.
- [ ] Define a sustainable rung as delivery ratio ≥0.95 for its complete
      180-second step. Run three interleaved same-SHA control/candidate pairs
      (`batch=0` then `64`, reverse order on pair 2) over aggregate targets
      25/50/100/130/150/200/250/300 Mbps.
- [ ] Comparator unit tests lock identity refusal and thresholds. PASS requires
      the median candidate maximum sustainable serverRx ≥25,000 datagrams/s
      **and** ≥2.0× the median knob=0 control maximum. This replaces the
      impossible old wording “2× at every 130–200 Mbps offered rung”, where
      offered traffic itself could be less than twice the baseline ceiling.
- [ ] Define the comparator CLI as `--out <comparison.json>` followed by
      exactly three `<control.json> <candidate.json>` pairs. It refuses any
      duplicate/missing arm, dirty input, SHA/machine/ladder/duration mismatch,
      wrong knob or echo mode, non-default payload delivery, diagnostics-
      enabled mode, incomplete rung, or non-finite sample.
- [ ] Run one echo ladder after the receive gate. Report it as a send+receive
      composite only; it cannot rescue a failed receive gate.

Implementation verification before the Task 8 commit:

```bash
bun test tools/load/compare-h7-bandwidth.test.ts
bun test tools/load/distributed-scale.test.ts
```

Expected: both unit suites exit 0. Commit only these six files. Do not spend
the full bandwidth runtime yet: Task 9 adds the final evidence harness and
therefore changes the candidate SHA.

Final-candidate evidence commands, run in Task 10 only after Task 9 is
committed and the tree is clean:

```bash
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=0 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-control-1.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-batch64-1.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-batch64-2.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=0 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-control-2.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=0 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-control-3.json bun tools/load/bench-bandwidth.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=0 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-batch64-3.json bun tools/load/bench-bandwidth.ts
bun tools/load/compare-h7-bandwidth.ts --out .release-evidence/h7/bandwidth-comparison.json .release-evidence/h7/bandwidth-control-1.json .release-evidence/h7/bandwidth-batch64-1.json .release-evidence/h7/bandwidth-control-2.json .release-evidence/h7/bandwidth-batch64-2.json .release-evidence/h7/bandwidth-control-3.json .release-evidence/h7/bandwidth-batch64-3.json
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 BENCH_ECHO=1 BENCH_RATES=27,54,109,141,163,217,272,326 BENCH_STEP_SECONDS=180 BENCH_OUT=.release-evidence/h7/bandwidth-echo-batch64.json bun tools/load/bench-bandwidth.ts
```

The command order is the preregistered interleave: control/candidate,
candidate/control, control/candidate. Expected in Task 10: comparator artifact
`status: "pass"`. A kernel/socket drop is reported as the next bottleneck and
still counts against delivery.

## Task 9 — Mechanistic napi-growth and latency A/B

**Files:**

- Create: `tools/load/bench-datagram-napi-growth.ts`
- Create: `tools/load/bench-datagram-napi-growth.test.ts`

- [ ] Rebuild the old ad-hoc lc-matrix as a committed, bounded harness: 21
      sessions total, 20 measured minutes after warmup, 5-second samples, no
      explicit GC during measurement, exact command and identity in
      `.release-evidence/h7/datagram-napi-growth-*.json`. Twenty load sessions
      each send a burst of 64 datagrams every 1.28 seconds (50/s/session
      average, ≥1,000/s aggregate), which deliberately leaves enough queued
      work for batching; a twenty-first session is reserved for latency probes.
- [ ] Run same-SHA knob=0 and batch=64 controls with
      `WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy` **only for this diagnostic**.
      This suppresses the ArrayBuffer-triggered full-GC sawtooth so live
      Promise/Function slopes are measurable; it is not product/release memory
      evidence. Task 10 returns to default ArrayBuffer delivery.
- [ ] Record diagnostics from Task 3 and linear-regression slopes for JSC
      `Promise` and `Function` live counts per delivered datagram, sampled
      directly from `require("bun:jsc").heapStats().objectTypeCounts`. Missing
      keys are `BLOCKED`. If the knob=0 slope is non-positive or either
      control regression has R² < 0.80, mark the comparison `BLOCKED` instead
      of dividing noise into a pass.
- [ ] PASS requires delivery ratio ≥0.95 and ≥1,000,000 delivered datagrams in
      each arm; batch64 mean observed batch size ≥8; batch calls/datagram ≤0.20×
      control; Promise and Function slopes/datagram each ≤0.25× control; and
      first-datagram p95 no worse than control p95 plus the larger of 10% or
      0.25 ms. Per-item ArrayBuffer/Uint8Array counts are excluded by design.
- [ ] Measure first-datagram latency with isolated one-datagram probes on a
      reserved session only after all burst queues and the current batch have
      drained, then wait at least 100 ms before the probe. Probe traffic is
      excluded from throughput/batch-size counters, so the latency comparison
      measures the blocking-first-item path rather than backlog position.
- [ ] Unit tests cover good comparison, weak/noisy control, identity mismatch,
      latency regression, insufficient delivery, and every ratio boundary.
- [ ] The harness CLI has two fail-closed modes: `run` writes one arm;
      `compare <control> <candidate> --out <comparison>` verifies exact
      SHA/machine/traffic/duration identity and writes the sole verdict.

Implementation verification before the Task 9 commit:

```bash
bun test tools/load/bench-datagram-napi-growth.test.ts
```

Expected: the unit suite exits 0. Commit only these two files and confirm the
tree is clean. Final-candidate evidence commands, run in Task 10:

```bash
WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy WEBTRANSPORT_DATAGRAM_BATCH=0 WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1 H7_GROWTH_OUT=.release-evidence/h7/datagram-napi-growth-control.json bun tools/load/bench-datagram-napi-growth.ts run
WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy WEBTRANSPORT_DATAGRAM_BATCH=64 WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1 H7_GROWTH_OUT=.release-evidence/h7/datagram-napi-growth-batch64.json bun tools/load/bench-datagram-napi-growth.ts run
bun tools/load/bench-datagram-napi-growth.ts compare .release-evidence/h7/datagram-napi-growth-control.json .release-evidence/h7/datagram-napi-growth-batch64.json --out .release-evidence/h7/datagram-napi-growth-comparison.json
```

Expected in Task 10: comparison `status: "pass"`. Diagnostic buffer-copy
results never override Task 10 default-path memory evidence.

## Task 10 — Full verification and immutable 2-hour hosted soak

**Files:** none unless a failed gate requires a new reviewed fix task.

- [ ] Run formatting, native tests/clippy, typecheck, full Bun packages,
      parity, the dedicated lifecycle tests, every Task 4/6/7/8/9 tool-side
      policy/unit suite, generic Chromium interop at the product default, and
      the exact Task 6 batch=4 Chromium boundary case from a clean committed
      candidate. Record exact counts; do not use “533+” shorthand. A full
      package run does not substitute for the non-package suites, and generic
      Playwright discovery does not substitute for the named batch=4 test.
- [ ] Freeze `CANDIDATE_SHA` only after Task 9 is committed. On that unchanged
      clean SHA, re-run the Task 7 floor; only if it passes, run every Task 8
      final-candidate command; only if that comparator passes, run every Task 9
      final-candidate command and the Task 4 churn command. Overwrite preliminary
      artifacts. Verify every JSON records `CANDIDATE_SHA` and clean state;
      any mismatch restarts the entire final evidence sequence.
- [ ] Run the existing strict scale comparator twice on the same clean SHA and
      default ArrayBuffer, diagnostics-disabled path: batch64 `single-reader`
      (product H7 path) and matching `drain-all` control. Each artifact must
      be promotable with
      delivery ≥0.95, 100% session success, raw peak RSS ≤1024 MB,
      authoritative charged post-close/service-ready recovery ≤1.25, and every
      final live gauge zero/baseline. An acknowledged review-required result is
      forbidden for `.release-evidence/`.
- [ ] Create the lightweight immutable tag
      `h7-batch-delivery-<CANDIDATE_SHA>` at the exact candidate, fail on any
      local or remote collision that resolves elsewhere, push that tag, and
      verify `git ls-remote` resolves it to `CANDIDATE_SHA`. Dispatch
      `.github/workflows/soak-long.yml` with `--ref` set to that tag and with
      `duration_hours=2`, `runner_type=self-hosted`,
      `runner_mode=dedicated`, `segment_index=1`, `segment_count=1`,
      `datagram_batch=64`, `rss_ceiling_mb=1750`, and the exact candidate SHA
      plus full tag ref, unique seed, and continuity token. Retain the tag as
      the workflow-definition evidence identity; do not dispatch from a
      mutable branch. The H7-tagged workflow must accept only a runner with at
      least 5 CPUs and 8 GiB and must use the fixed
      `h7-fixed-large`/500-session/500-datagrams-per-second/5-streams-per-second
      workload; capacity-based downscaling is a failed gate, not alternate H7
      evidence.
- [ ] Discover the newly dispatched run without accepting a stale run for the
      same commit, monitor it to a successful terminal conclusion, download
      both exact artifact names by run ID, and run Task 4's
      `verify-h7-hosted` command. Accept only the workflow's source-bound
      aggregate/segment JSON. Required:
      `status: pass`; candidate/actual SHA equality; workflow-source SHA equals
      the candidate and workflow-source ref equals the immutable H7 tag; batch
      knob recorded as 64;
      `runnerType: "self-hosted"`; `runnerMode: "dedicated"`;
      `runnerProfile: "h7-fixed-large"`; exact rates 500 sessions, 500
      datagrams/s, and 5 streams/s in both hashed documents; required datagram
      operation class present; delivery ≥0.95; raw RSS peak is
      recorded; charged-memory peak ≤1750 MB (resolved from dispatch input
      `rss_ceiling_mb=1750`); charged-memory
      trend/recovery guards pass; final sessions/streams/tasks/queued bytes at
      baseline tolerances. Separately, the source-bound Task 4 churn artifact
      for the same SHA must report zero positive protected deltas. A diagnostic
      payload mode is forbidden. The harness's already-documented symmetric
      GC/allocator-relief sampling remains unchanged and source-recorded; this
      plan must not add automatic collection to production close paths or
      weaken any recovery threshold.
- [ ] If the hosted environment cannot run, report `BLOCKED`. Local tests,
      memory diagnostics, and a shorter soak do not substitute for this gate.

Freeze the candidate and run local verification before spending performance
runtime:

```bash
mkdir -p .release-evidence/h7
git rev-parse HEAD > .release-evidence/h7/candidate-sha.txt
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
test -z "$(git status --porcelain)"
unset WEBTRANSPORT_PAYLOAD_DELIVERY
unset WEBTRANSPORT_DATAGRAM_BATCH
unset WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS
cargo fmt --check
cargo test -p native
cargo clippy -p native --all-targets -- -D warnings
bun run build:native
bun run build:wasm
bun run build:wasm:dist
bun run typecheck
bun test packages/
bun test packages/webtransport/test/datagram-batch-delivery.test.ts packages/webtransport/test/datagram-batch-lifecycle.test.ts packages/webtransport/test/internal-error-propagation.test.ts
bun test packages/webtransport/test/internal-actions-policy.test.ts
bun test tools/load/soak-addon.test.ts
bun test tools/interop/tests/security-evidence.test.ts
bun test tools/bench/datagram-delivery-floor.test.ts
bun test tools/load/compare-h7-bandwidth.test.ts
bun test tools/load/distributed-scale.test.ts
bun test tools/load/bench-datagram-napi-growth.test.ts
WEBTRANSPORT_REQUIRE_WASM=1 WEBTRANSPORT_REQUIRE_WASM_DIST=1 bun run test:parity
H7_PLAYWRIGHT_REPORT=.release-evidence/h7/playwright-batch4.json
rm -f tools/interop/interop-evidence.json
(cd tools/interop && env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=4 INTEROP_EVIDENCE=1 bunx playwright test tests/h7-datagram-batch.pw.ts)
cp tools/interop/interop-evidence.json "$H7_PLAYWRIGHT_REPORT"
bun tools/interop/verify-evidence.ts verify-h7-playwright-report "$H7_PLAYWRIGHT_REPORT"
rm -f tools/interop/interop-evidence.json
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS INTEROP_EVIDENCE=1 bun run test:interop:once
test "$CANDIDATE_SHA" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
```

Then re-stamp the final evidence:

```bash
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
test "$CANDIDATE_SHA" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
env -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS bun run bench:h7-floor
```

Continue only on a passing floor: run the exact Task 8 final-candidate block,
then the exact Task 9 final-candidate block, then:

```bash
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
env -u WEBTRANSPORT_PAYLOAD_DELIVERY WEBTRANSPORT_DATAGRAM_BATCH=64 WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS=1 bun tools/load/datagram-batch-churn.ts
test "$CANDIDATE_SHA" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
```

Then run the two strict default-path scale arms:

```bash
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 LOAD_SCALE_H7_EVIDENCE=1 LOAD_SCALE_EXPECTED_SHA="$CANDIDATE_SHA" LOAD_SCALE_LABEL=h7-single-reader LOAD_SCALE_WORKLOAD_MODE=single-reader LOAD_SCALE_SESSIONS=200 LOAD_SCALE_DURATION=180 LOAD_SCALE_DATAGRAMS_PER_SEC=1000 LOAD_SCALE_STREAMS_PER_SEC=5 LOAD_SCALE_MIN_DELIVERY_RATIO=0.95 LOAD_SCALE_MIN_SUCCESS_RATE=1 LOAD_SCALE_MAX_RSS_MB=1024 LOAD_SCALE_MAX_RECOVERY_RSS_RATIO=1.25 LOAD_SCALE_ARTIFACT_OUT=.release-evidence/h7/load-scale-single-reader.json bun tools/load/load-scale-addon.ts
env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS WEBTRANSPORT_DATAGRAM_BATCH=64 LOAD_SCALE_H7_EVIDENCE=1 LOAD_SCALE_EXPECTED_SHA="$CANDIDATE_SHA" LOAD_SCALE_LABEL=h7-drain-all-control LOAD_SCALE_WORKLOAD_MODE=drain-all LOAD_SCALE_SESSIONS=200 LOAD_SCALE_DURATION=180 LOAD_SCALE_DATAGRAMS_PER_SEC=1000 LOAD_SCALE_STREAMS_PER_SEC=5 LOAD_SCALE_MIN_DELIVERY_RATIO=0.95 LOAD_SCALE_MIN_SUCCESS_RATE=1 LOAD_SCALE_MAX_RSS_MB=1024 LOAD_SCALE_MAX_RECOVERY_RSS_RATIO=1.25 LOAD_SCALE_ARTIFACT_OUT=.release-evidence/h7/load-scale-drain-all.json bun tools/load/load-scale-addon.ts
```

Both commands must exit 0, and both JSON files must record the exact candidate
SHA, `source.dirty: false`, resolved batch 64, default payload delivery,
diagnostics requested `null`/resolved false, `promotable: true`, no
failures/review-required entries, charged recovery ratio ≤1.25, raw peak RSS
≤1024 MB, and final live gauges at zero/baseline.

After all local gates pass, dispatch exactly once:

```bash
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
test "$CANDIDATE_SHA" = "$(git rev-parse HEAD)"
CANDIDATE_TAG="h7-batch-delivery-$CANDIDATE_SHA"
CANDIDATE_REF="refs/tags/$CANDIDATE_TAG"
LOCAL_TAG_SHA="$(git rev-parse -q --verify "$CANDIDATE_REF^{commit}" || true)"
if [ -n "$LOCAL_TAG_SHA" ]; then
  test "$LOCAL_TAG_SHA" = "$CANDIDATE_SHA"
else
  git tag "$CANDIDATE_TAG" "$CANDIDATE_SHA"
fi
REMOTE_TAG_SHA="$(git ls-remote --refs origin "$CANDIDATE_REF" | awk 'NR == 1 { print $1 }')"
if [ -z "$REMOTE_TAG_SHA" ]; then
  git push origin "$CANDIDATE_REF"
  REMOTE_TAG_SHA="$(git ls-remote --refs origin "$CANDIDATE_REF" | awk 'NR == 1 { print $1 }')"
fi
test "$REMOTE_TAG_SHA" = "$CANDIDATE_SHA"
CAMPAIGN_SEED="h7-$(uuidgen)"
CONTINUITY_TOKEN="$(uuidgen)-$(uuidgen)"
printf '%s\n' "$CANDIDATE_REF" > .release-evidence/h7/candidate-ref.txt
printf '%s\n' "$CAMPAIGN_SEED" > .release-evidence/h7/campaign-seed.txt
printf '%s\n' "$CONTINUITY_TOKEN" > .release-evidence/h7/continuity-token.txt
gh workflow run soak-long.yml --ref "$CANDIDATE_TAG" -f duration_hours=2 -f runner_type=self-hosted -f runner_mode=dedicated -f candidate_commit="$CANDIDATE_SHA" -f candidate_ref="$CANDIDATE_REF" -f segment_index=1 -f segment_count=1 -f campaign_seed="$CAMPAIGN_SEED" -f continuity_token="$CONTINUITY_TOKEN" -f committed_abort_mb=2200 -f heap_debug=0 -f datagram_batch=64 -f rss_ceiling_mb=1750
```

Discover the new run with the following bounded poll. Invoke the block once per
poll (at most 30 attempts, 10 seconds between attempts); do not put the retries
inside one long blocking shell call. A failed `test` means retry, while 30
failures means `BLOCKED`:

```bash
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
CAMPAIGN_SEED="$(tr -d '\n' < .release-evidence/h7/campaign-seed.txt)"
RUN_ID="$(gh run list --workflow soak-long.yml --commit "$CANDIDATE_SHA" --event workflow_dispatch --limit 20 --json databaseId,displayTitle,headSha --jq '[.[] | select(.headSha == "'"$CANDIDATE_SHA"'" and .displayTitle == "soak-long-'"$CAMPAIGN_SEED"'")] | sort_by(.databaseId) | reverse | .[0].databaseId // empty')"
test -n "$RUN_ID"
printf '%s\n' "$RUN_ID" > .release-evidence/h7/hosted-run-id.txt
```

Start `gh run watch` in an asynchronous PTY/session and poll that session at
intervals no longer than 60 seconds so user-visible progress continues. Only
an exit status of zero is acceptable:

```bash
RUN_ID="$(tr -d '\n' < .release-evidence/h7/hosted-run-id.txt)"
gh run watch "$RUN_ID" --exit-status
```

Then download by the immutable run ID and verify the two exact artifacts:

```bash
CANDIDATE_SHA="$(tr -d '\n' < .release-evidence/h7/candidate-sha.txt)"
CANDIDATE_REF="$(tr -d '\n' < .release-evidence/h7/candidate-ref.txt)"
RUN_ID="$(tr -d '\n' < .release-evidence/h7/hosted-run-id.txt)"
CAMPAIGN_SEED="$(tr -d '\n' < .release-evidence/h7/campaign-seed.txt)"
CONTINUITY_TOKEN="$(tr -d '\n' < .release-evidence/h7/continuity-token.txt)"
HOSTED_DIR=".release-evidence/h7/hosted-$RUN_ID"
mkdir -p "$HOSTED_DIR/aggregate" "$HOSTED_DIR/segment"
gh run download "$RUN_ID" --name "soak-aggregate-2h-$CANDIDATE_SHA" --dir "$HOSTED_DIR/aggregate"
gh run download "$RUN_ID" --name "soak-segment-2h-$CANDIDATE_SHA-seg01of01" --dir "$HOSTED_DIR/segment"
AGGREGATE_JSON="$(find "$HOSTED_DIR/aggregate" -type f -name 'soak-aggregate-*.json' -print -quit)"
SEGMENT_JSON="$(find "$HOSTED_DIR/segment" -type f -name 'soak-artifacts-seg-*.json' -print -quit)"
test -n "$AGGREGATE_JSON"
test -n "$SEGMENT_JSON"
bun tools/load/soak-addon.ts verify-h7-hosted "$AGGREGATE_JSON" "$SEGMENT_JSON" --sha "$CANDIDATE_SHA" --batch 64 --rss-ceil-mb 1750 --duration-seconds 7200 --seed "$CAMPAIGN_SEED" --continuity-token "$CONTINUITY_TOKEN" --workflow-ref "$CANDIDATE_REF"
test "$CANDIDATE_SHA" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
```

Expected: every local command exits 0, `gh run watch` exits 0, the verifier
prints `soak-addon: H7 hosted PASS`, and final status is clean. H7 is
execution complete only after that hosted 2-hour artifact passes; no release
rebind is part of this plan.

## Risks & mitigations

- **Portable semantic overclaim** — resolved by explicitly limiting equality
  to the common observable contract and recording native/WASM prefetch bounds
  in code docs, `PARITY_MATRIX`, parity tests, and Chromium interop.
- **Mutable workflow definition** — the hosted run is dispatched only from a
  verified `h7-batch-delivery-<candidate-sha>` tag; segment and aggregate hashes
  record `GITHUB_REF`/`GITHUB_SHA`, and the verifier requires both to match.
- **JS generator floor** — retired first by Task 7. A failure stops the plan
  before expensive load/CI evidence.
- **Echo-bound measurement** — Task 8 compares receive-only control/candidate
  on the same SHA and treats echo as diagnostic.
- **Backpressure loosening** — bounded (`+max` items per handle), stated per
  item and byte budget, and tested on both server and client.
- **Close while parked** — no longer left to transport-task teardown. Tasks 1
  and 2 put both legacy and batch reads on sticky direct lifecycle wake paths;
  Task 3 proves the eight batch=0/default × local/remote × server/client cases
  with a one-second bound.
- **Client exclusive napi borrow** — the new method clones state synchronously
  and returns a spawned future, so a parked default-path read holds no exclusive
  napi handle borrow; concurrent close and the 256-item drain cap are tested.
- **Bun batch-array materialization cost** — exact real-addon conversion tests
  precede the 1/16/64/256 floor sweep.
- **Rejection-leak recurrence** — both methods are reject-free on
  data/EOF/closure paths; out-of-range input clamps. Infrastructural join or
  materialization failure remains exceptional, and churn gates protected
  deltas across abandonment and close.
- **Noisy heap allocation evidence** — Task 9 fails closed when the control
  slope is not measurable and keeps diagnostic buffer-copy evidence separate
  from Task 10's default ArrayBuffer production path.
- **Next bottleneck after read batching** — Task 8 records UDP/kernel and send
  limits; send-side batching remains a separately reviewed follow-up.

## Success criteria (all must hold)

1. Public API unchanged (`AsyncIterable<Uint8Array>`, ordering,
   termination), with the documented deviations: buffering bound
   2048+max (server) / 256+max (client), up to `max` post-close yields,
   up to `max-1` discarded on mid-batch abandonment, and close-time
   drop-not-drain of still-queued datagrams on both handles and both lanes
   — all in exact docs, parity matrix, and bounded tests. `/portable` guarantees and exclusions are
   explicit; WASM is not described as batched.
2. Native unit tests prove silent clamp, ordering, partial EOF, per-item budget
   release, payload conversion branches, and direct close wake on both handles.
3. Task 7 artifact passes: batch64 minimum ≥50,000 items/s and median ≥2×
   batch1 before any load CI spend.
4. Task 8 same-SHA receive comparator passes: batch64 median sustainable
   serverRx ≥25,000 datagrams/s and ≥2× knob=0; echo remains diagnostic.
5. Task 9 passes every pre-registered call/growth/latency threshold, or records
   `BLOCKED` when the control is not measurable; no vague “near”,
   “~batch-fold”, or “unchanged” verdict remains.
6. Lifecycle proof passes on both handles and both batch=0/default lanes:
   exact abandonment count, local and remote close-while-parked, zero stranded
   budgets/gauges, and no positive post-baseline protected-object delta in the
   dedicated churn artifact.
7. Full native/Bun/parity verification, every Task 4/6/7/8/9 policy/unit suite,
   generic product-default Chromium interop, and the exact batch=4 Chromium
   boundary test pass on one clean immutable candidate SHA. Both strict scale
   artifacts pass on that SHA with default ArrayBuffer delivery, diagnostics
   disabled, batch64, delivery ≥0.95, raw peak ≤1024 MB, charged recovery
   ≤1.25, and final gauges at zero/baseline. The batch=4 Chromium JSON report
   proves exactly one executed pass and zero skipped results. A source-bound
   self-hosted/dedicated 2-hour soak dispatched from the immutable candidate
   tag then passes its workflow-ref/SHA identity, exact
   `h7-fixed-large`/500/500/5 workload, charged-peak/trend guards, and baseline
   tolerances on the same SHA; a smaller runner or auto-downscaled load is not
   acceptable H7 evidence.
8. Rollback/bisection remains one module-init knob: batch=0 retains
   one-Promise-per-item delivery while sharing deterministic lifecycle wake,
   batch=1 uses the new batch machinery with one item, and default64 batches.
   Invalid values resolve deterministically; no silent stale-addon fallback
   exists.

## Review record

The earlier embedded “approved” record applied to a superseded digest and is
not authority for this revision. Fresh review on 2026-08-15 rejected digest
`e8041a55567c2d5a66551e3b25cef8a41201dd2477b5f726ffad93ba3fd57a75`
at HEAD `62cc21e9f4e6583f8f059693540b5d26fc784d01` for:

- unresolved native `/portable` versus WASM semantics and missing
  `docs/PARITY_MATRIX.md`, parity, and interop work;
- no executable proof surface for batch `PayloadBuffer` conversion/accounting;
- non-falsifiable JS-floor, throughput, growth, and latency language;
- an incorrect `internal-error-propagation.test.ts` path and unnamed public doc;
- an unnamed protected-wrapper harness and no direct close-wake contingency.

All five rejection classes are addressed above. The only valid approval for
execution is a later pair of unconditional architect and critic `APPROVED`
verdicts bound to the exact same SHA-256 of this file. `APPROVE-WITH-CHANGES`
does not pass; any required change invalidates the digest and restarts both
reviews.

A second independent review rejected digest
`e396cc7b9fddab39fcde653da9a048dd550d957746c97a563ab0123702cea6ea`
for three cross-lane gaps: legacy batch=0 lacked direct close wake, promotable
local scale evidence did not reject the diagnostic wrapper, and hosted
verification did not assert self-hosted/dedicated runner identity. Those
requirements are now explicit in Tasks 1–4, 7–8, and 10 and must be re-reviewed
as part of the next digest.

A third independent review rejected digest
`39c2aeffa94b4b53edd360d34e1586711aa37bbd1ab741beb1d960ff8dd3b7a4`
because the real addon did not exercise the >256 KiB external-buffer
materializer, Task 1 named the plain stream-accept loop instead of the actual
lost-wake-safe capacity helper, and Task 4 omitted ownership of the repository's
shared soak-input validator. Tasks 1–4 now name the exact helper, real
`Vec<PayloadBuffer>` test seam, authoritative validator file, validation
order, and negative cases; none may be inferred during execution.

A fourth independent review bound to digest
`bce15b707b9d533291fe91229ec12e13598d774d12ecfc4e611e7d27fd082b8e`
approved the architecture but the critic rejected execution readiness because
Task 6 omitted the duplicated interop evidence allowlist in
`tools/interop/verify-evidence.ts`, and the documentation lane omitted
authoritative `docs/CI.md` coverage for the new 2-hour H7 workflow contract.
Tasks 5B and 6 now own both files, their exact contract changes, and their
existing policy tests; the per-task file cap is explicitly six rather than
silently exceeded.

A fifth independent review rejected digest
`af9623037f7a54135fdae86534ab31dd9807e64d7ac7c5ee718f3e9acfedb246`
for four remaining cross-surface gaps: Task 4 omitted the separate
`internal-actions-policy.test.ts` validator/workflow consumer; the operator-doc
lane omitted `docs/RELEASE_CHECKLIST.md`; Task 10 did not re-run the new
Task 4/6/7/8/9 tool-side suites on the frozen candidate SHA; and final
Chromium verification used only the generic batch64 command rather than the
exact Task 6 batch=4 boundary scenario. Tasks 4, 5B, 6, and 10 now assign every
owner and exact same-SHA command. `tools/load/README.md` is included alongside
both delegated CI/release docs so the visible load-operator modes also remain
truthful.

A sixth independent review rejected digest
`c926bc184419ef93e25a592bd64dff7d5a2449a33dc086c0b6ab288973a016eb`
for six final precision gaps: Task 5B did not own or strengthen its doc-truth
policy/fixtures; Task 8 assigned env parsing to `distributed-scale.ts` despite
the real `load-scale-addon.ts` parser; generic interop explicitly set 64 rather
than proving the unset default; the batch=4 Playwright command selected a
multi-test file rather than one unskippable proof; hosted dispatch used a
mutable branch ref; and hosted artifacts did not verify workflow-definition
ref/SHA identity. Tasks 4, 5B, 6, 8, and 10 now own the exact enforcement files,
dedicated test, parser boundary, immutable tag dispatch, and hashed
workflow-source verification needed to close each gap.

A seventh independent architect/critic review rejected digest
`6940d135e0f67a6cebe90e6f5a34f7bdb991d9b3c518e111c1080b327448b640`
for five execution-readiness gaps: the Task 8 wording erased the existing
`distributed-scale.ts` direct-CLI/environment boundary; hosted H7 rates still
varied with runner auto-profiling without verifier enforcement; the dedicated
Playwright gate used regex rather than reporter evidence; that command could
inherit payload-copy or diagnostics environment; and `bench-bandwidth.ts`
gained fail-closed behavior without fast owned tests. Tasks 4–6, 8, and 10 now
define the exact legacy/new parser boundary, a fixed capacity-gated 500/500/5
hosted profile hashed and verifier-enforced end to end, a sanitized JSON-report
proof with exactly one executed pass and zero skips, and pre-commit bandwidth
parser/artifact/refusal tests. The shared workflow run-name is also neutral so
routine soak modes are not mislabeled as H7.

An eighth independent review of digest
`1cf96fe86e926cb4fdbf1f4c81dbfac736bfd328b9593ef673026c139030adb4`
split: the architect returned unconditional APPROVED; the critic rejected for
one blocking defect — the dedicated Chromium gate captured its JSON report
from stdout, which `tools/interop/playwright.config.ts`'s piped web-server
output interleaves into unparseable text, while the CLI `--reporter=json`
override silently replaced the `INTEROP_EVIDENCE=1` reporter chain and
disabled the evidence sanitizer, and no task owned the config file. Tasks 6
and 10 now keep the config's reporter chain active, consume the config-written
`tools/interop/interop-evidence.json` as the report transport, and forbid
config edits. Folded from the same round's non-blocking findings: corrected
`session.rs`/`client.rs`/`payload_buffer.rs` line citations; a dedicated
server-side `datagram_lifecycle_notify` replacing the shared send-capacity
notify in the read-side lifecycle wait (hot-path wakeup churn); an explicit
client drop-not-drain-on-sticky-close statement; and the hosted
`rss_ceiling_mb` raised 1024 → 1750 (with `committed_abort_mb` 1500 → 2200
kept strictly above it) to match the harness's load-proportional
charged-ceiling default for the fixed 500-session profile, eliminating a
preregistered false-red.

A ninth independent review of digest
`2d2c8dd11db1cf36723109ca62a4c0131c2bad526db36b64c2f361658e2c34e3`
split again: the architect returned unconditional APPROVED (independently
confirming the B1 fix sound end-to-end against the real Playwright config and
the 1750/2200 propagation complete); the critic confirmed all four round-8
folds sound but rejected for one blocking defect — the newly-stated
close-time drop-not-drain behavior is a real, observable third semantic
deviation (affecting both handles and the knob=0 legacy lane, versus today's
drain-then-`None` mpsc teardown) that the revision falsely described as
already covered, leaving it absent from the deviations section, the Task 5A
doc count, and success criterion 1 — a doc-truth gate would have passed while
close semantics quietly moved. The deviation is now enumerated as deviation 3
with both-handles/both-lanes scope, Task 1 and Task 3 close tests must hold
undelivered datagrams queued at close so drop-not-drain is proven rather than
vacuous, and the doc lane and success criteria count three deviations. Folded
from the same round's non-blocking findings: the `client.rs` channel citation
corrected to recv=735/send=734 (the round-8 "fix" had regressed it); H7
interop runs delete any pre-existing `interop-evidence.json` and run before
the generic suite so the release-named artifact retains full-suite content;
`committed_abort_mb=2200` joins the validator's pre-setup H7 tuple; and the
breaker/ceiling relation is restated as a cross-metric margin heuristic, not
a firing-order guarantee.

A tenth independent review of digest
`f4c59a6cce9aa2872f7c7a346eada8ebec1139c7492750488051e362d533d836`
split a third time: the architect returned unconditional APPROVED (verifying
all six round-9 folds, endorsing B2 on the merits, and correcting its own
round-8 citation miscount that had caused the regression); the critic
verified every fold complete but rejected for one blocking defect — B3:
deviation 3's client-side discard collided with success criterion 6's
zero-stranded-gauges requirement, because the client's receive reservation is
charged into `queued_bytes` at enqueue with no `DatagramSlot`/`Drop` refund,
so every datagram discarded at close would strand its bytes on a live handle
in exactly the non-vacuous close tests fold 1 mandates, forcing a
non-interactive executor to improvise between a refund, a weakened gauge
assertion, or abandoning the deviation. Task 2 now mandates the repository's
own teardown pattern (`client.rs:809-817`): the close path drains the
discarded remainder and refunds `queued_bytes` per item while still returning
EOF to JavaScript — drop-not-drain stays the JS-visible semantic, accounting
is settled internally — with a unit test that `queued_bytes` returns to zero
after a discarding close, Task 3's client cases asserting the baseline
snapshot, and the deviations section and misleading "matching the server"
sentence corrected to distinguish the server's `Drop`-based refund from the
client's explicit one. Folded from the same round's and the architect's
non-blocking notes: the `/portable` native-bounds enumeration and Task 5A's
own checklist/`rg` now name close-time drop-not-drain, and the generic
interop invocation also clears `interop-evidence.json` before running.

An eleventh independent review of digest
`08750a62779c38fa71c53b196d7e974cbf8a811d0e64a0df119eda59f453e61d`
split a fourth time: the architect returned unconditional APPROVED (proving
double refund structurally impossible under the receiver mutex and that the
mandated parked-reader test forces a correct implementation); the critic
rejected for B4 — "the close path drains" was not implementable as written,
because `dgram_recv_rx` is `Arc<TokioMutex<Receiver>>` held across the parked
reader's await while both close paths (`initiate_close`, the terminal-state
fn) are synchronous: `try_lock()` fails exactly in the mandated parked-reader
scenario, and the cited send-side precedent owns its channel exclusively so
it transfers the refund shape but not the concurrency context. The critic
also identified a second window: the receive forwarder keeps charging after a
close-time drain. Task 2 now names the owner and execution context of every
refund: a reader-owned drain performed under the already-held guard before
returning `null` (primary), an async terminal-task `.lock().await` drain for
the no-reader case with `try_lock()`/`blocking_lock()` explicitly forbidden
and `initiate_close` never draining inline, and the forwarder checking the
sticky flag before each reserve and refunding its own unhanded charges on
exit — the true analogue of the send-side teardown. Folded from the same
round's non-blocking notes: `queued_bytes` zero assertions are bounded polls
(the counter is shared with the send direction), and the deviations section
now says settlement is bounded rather than claiming instantaneous
non-stranding.

A twelfth review of digest
`fdd557139899b49085a37952c087e6502fe64c7d89337189ccdc231b0e372f25`
saw BOTH reviewers independently reject for the same defect, B5: part 3's
check-then-charge could not stop charging atomically with respect to the
drains — the forwarder could pass its `Acquire` check, close could land and
both drains complete on an empty channel, and the forwarder's still-in-flight
iteration would then charge and successfully send (the window straddles an
`.await` that can park unboundedly on a full channel), stranding one
handed-over datagram that neither the exit-refund (failed handovers only) nor
any completed drain covers — reachable at Task 3/Task 4 volumes and
presenting as a flaky bounded-poll failure whose most tempting repair is
weakening the assertion. Both reviewers converged on the same fix, now
mandated: the terminal task retains the forwarder's `JoinHandle` (or an
equivalent completion signal), awaits the forwarder's exit after
sticky-store + notify, and only then performs the final `.lock().await`
drain — since the forwarder is the sole receive-side charger, no charge can
occur after the final drain. Part 3 is relabeled cooperation: its `Acquire`
check shrinks the window and its exit-refund covers unhanded charges, but
the part-2 ordering is what closes the window. Also folded: the drain
explicitly lives in the spawned terminal task body, not the synchronous
`finalize_client_terminal_state` helper; and a bounded test closes the
session while the forwarder is actively delivering, so the ordering — not
scheduling luck — is what passes.

A thirteenth review of digest
`ac605013a96c834e108785e41781c47fc86953ba0a6ee4d692c4207f291dcd5b`
saw both reviewers independently reject again for the same defect, B6: the
await-forwarder-exit step could deadlock teardown, because the forwarder
also parks in `dgram_recv_tx.send(...).await` on a full 256-slot channel —
the ordinary backpressure state (≈294 KB of slots against a 2 MiB
per-session budget, `limits.rs:30-31`) — where closing the QUIC connection
frees nothing: terminal task waits on forwarder, forwarder waits on a slot,
and the only slot-freer is the terminal task, while the receiver stays alive
precisely because the terminal task holds its `Arc` for draining. Teardown
wedges and `on_closed` never fires — strictly worse than the stranded bytes
B5 fixed. The critic additionally showed the prescribed `JoinHandle` is
unobtainable in scope (`spawn_quic_task_scoped` consumes it inside
`panic_guard.rs`'s watchdog) and a plain completion signal is not
panic-safe. The fold reconciles both reviewers' partially-conflicting
remedies: part 3 makes the forwarder's enqueue interruptible
(`tokio::select!` of the send against the lifecycle notify, with the
notify arm refunding the in-flight charge via the existing exit-refund), so
a LIVE forwarder's exit is bounded from both park points; part 2 becomes
drain → bounded wait → final drain, observing forwarder completion through
a Drop-guard signal that fires on normal exit AND panic unwind, with the
bounded timeout justified as panic-only insurance that cannot reintroduce
the B5 window (an expired wait implies a dead forwarder, which cannot
charge) — satisfying both the architect's no-timeout-as-substitute rule and
the critic's every-wait-bounded rule. A mandated bounded test closes with
the channel FULL and no reader attached, the interleaving that
distinguishes the interruptible design from a deadlocking one; bare
`tokio::spawn` (losing `PanicScope::Conn` containment) and `panic_guard.rs`
edits are both forbidden.
