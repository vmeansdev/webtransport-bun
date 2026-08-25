# Mirror-send API — design note + JS-floor microbench (T34)

**Ticket:** `.scratch/production-grade-scenarios/issues/34-mirror-send-api-lever.md`
**Branch:** `design/mirror-send-01` (worktree, off `rebind4-staging` @ `2a4145d0556a35f8b4a0849e5953927b5e028b64`)
**Bench code + raw runs:** `tools/bench/mirror-send/` on that branch (`RUNS.md` is the full log)
**No product code lands from this ticket.** Implementation is a separate ticket — see §7.

Template: `assets/send-batch-design.md` (T04). Parity mechanism: `assets/send-batch-parity-posture.md` (T06).

---

## 0. What is licensed from these numbers, and what is not

Every number below was taken on the maintainer's macOS box while other agents
were working on it. **No local macOS number is a result.** What is used is only
the *ratio between shapes measured in the same interleaved pass*, min-of-6, and
every decision states the margin it needs. Ratios reproduce to within 1–3%
across two runs of the same payload (RUNS.md runs 1 and 3).

**No pre-registration was committed for this microbench, and none is claimed.**
This ticket carries no gate: nothing here is a pass/fail against a target. The
lever's value is stated by **G10 (ticket 35)**, whose own pre-registration is
owed before its run, and G10 must state it as **mirror-vs-`trySendDatagram`**,
never mirror-vs-promise — §1 is the arithmetic for why.

The addon models a registry lookup, the crossing, the payload copy, a `Bytes`
clone per target and a counter bump per target. It does **not** model quinn's
connection mutex, real framing, the governor's reserve/release pair or any IO —
all of which the baseline and the mirror pay identically per target. Leaving
them out therefore makes every mirror-vs-baseline ratio here a **lower bound**.

---

## 1. The headline: the lever is much smaller than the ticket's premise

The ticket's premise comes from G4's stamp: **6.31 µs per target**, hence
~63 ms for a 10,000-subscriber broadcast, hence "mass broadcast is
lever-blocked". That figure is the *pipelined promise* shape. Ticket 23 has
since landed the promise-free `trySendDatagram`, and it is in this branch's
baseline. Measured on the same estimator (ns per **target**, payload 200 B):

| shape | N=10 | N=100 | N=1000 | N=10000 |
|---|---:|---:|---:|---:|
| per-target promise, pipelined *(the G4 shape)* | 3749 | 2813 | 2828 | 2879 |
| **per-target `trySendDatagram`, sync** *(today's shipped shape)* | **309** | **314** | **317** | **331** |
| mirror, `string[]` targets | 158 | 93 | 90 | 84 |
| mirror, `Uint32Array` targets | 78 | 22 | 20 | 28 |
| mirror, native group handle | 61 | 16 | 11 | 11 |
| mirror, native group + per-target reframe | 85 | 40 | 36 | 36 |
| mirror, native group, behind one promise | 1357 | 140 | 27 | 14 |

Payload 1150 B moves only the reframe row materially (36 → 51 ns at N=10000);
every other row is within 1–8% of the 200 B figures. Full tables in RUNS.md.

**One 10,000-target broadcast, JS-floor cost, 200 B:**

| shape | per broadcast | % of one core at 50 msg/s |
|---|---:|---:|
| per-target promise *(G4's shape, retired)* | 28.8 ms | 144% |
| **per-target `trySendDatagram` (today)** | **3.31 ms** | **16.6%** |
| mirror, `string[]` targets | 0.84 ms | 4.2% |
| mirror, `Uint32Array` targets | 0.28 ms | 1.4% |
| mirror, native group handle | 0.11 ms | 0.6% |

**Readings.**

1. **The promise, not the crossing, was the 6.3 µs.** Removing it took the
   per-target cost from ~2.9 µs to ~0.33 µs — a 8.7× step that is *already
   landed*. The mirror API's remaining prize is the 3.31 ms → 0.84 ms step.
2. **So the ticket's "lever-blocked" premise is retired, and G10 should be
   re-scoped.** At G10's own top rung (10,000 subscribers, 50 msg/s) the
   *shipped* emitter already fits its own budget: a broadcast must complete
   before the next begins, the budget is 20 ms, and today's fan-out spends
   3.31 ms of JS floor inside it. The mirror is an **optimisation worth ~4×**,
   not an enabler. Whether it matters is exactly what G10's three-arm
   comparison is for; this note does not claim it.
3. **Conservative ratios** (worst mirror cell against best baseline cell across
   all three runs and both payloads): the `string[]` mirror is **≥ 3.5×**
   cheaper than per-target `trySendDatagram` at N ≥ 1000; `Uint32Array`
   **≥ 10×**; the native group **≥ 25×**. Against the retired promise shape the
   same cells read ≥ 30× / ≥ 95× / ≥ 250× — which is why quoting against it is
   forbidden.
4. **Target marshalling is the mirror's dominant cost**, not the fan-out.
   `string[]` 84–90 ns vs group 11 ns: **8 of every 9 nanoseconds the
   `string[]` mirror spends are spent turning JS strings into registry keys.**
   That is the whole content of the shape decision in M1.
5. **The mirror does not amortise below N ≈ 100.** At N=10 the `string[]`
   mirror costs 158–170 ns/target against a 309 ns baseline — under 2×,
   because one crossing's fixed cost is spread over ten targets. A fan-out of
   ten should keep using the loop.
6. **A promise costs ~13.6 µs, fixed.** The async group row is 1357 ns × 10 at
   N=10 and 14 ns × 10,000 at N=10,000: the same ~13.6 µs of promise, amortised.
   This is why the mirror is synchronous (M3) — a promise would cost more than
   the entire fan-out it wraps at every N below ~1000.

---

## 2. The envelope, measured

At N = 10,000, ns per target, by failure fraction (200 B). Cells are comparable
**down a column only**: a closed target skips the delivery work, so the
`1-in-1` column is a different amount of work, not a faster shape.

| envelope | 0% | 1-in-1000 | 1-in-10 | all fail |
|---|---:|---:|---:|---:|
| `{sent, failed}` counters | 11 | 11 | 10 | 4 |
| **failures-only (`Uint32Array` + codes)** | **11** | **11** | **10** | **13** |
| bitset, ⌈N/8⌉ bytes | 11 | 11 | 9 | 1 |
| per-target `(string \| null)[]` | 26 | 27 | 44 | 66 |

**Readings.**

1. **Failures-only is free at every realistic failure rate.** It is
   indistinguishable from a bare counter at 0% and 0.1% failures, and only
   overtakes it when *every* target fails (13 vs 4 ns), where it is allocating
   10,000 indices because there genuinely are 10,000 failures. Its cost is
   proportional to what went wrong, which is the property being bought.
2. **The bitset buys nothing.** It is the same cost as failures-only at every
   realistic rate, it allocates ⌈N/8⌉ = 1250 bytes whether or not anything
   failed, it carries **no error code**, and it makes the caller scan 10,000
   bits to find 3 dead subscribers. It is dominated on every axis.
3. **The per-target array is the only envelope that costs anything real:**
   +15 ns/target at 0% failure, i.e. 0.15 ms added to a 10,000-target broadcast
   — **more than doubling** the group mirror's total cost, and 18% of the
   `string[]` mirror's. It also allocates 10,000 JS strings per broadcast for a
   caller who, in the healthy case, wanted to learn "nothing failed".

---

## 3. Decisions

### M1 — Target shape: `readonly string[]`, and the ladder above it is measured, not guessed

v1 takes the session ids the application already holds. Reading 4 says this
costs 8× the native-group shape, so the honest form of the decision is a
**ladder with its rungs priced**:

| rung | ns/target | what it costs the product |
|---|---:|---|
| `readonly string[]` | 84–90 | nothing — the app already holds ids |
| `Uint32Array` of dense handles | 20–28 | a second, numeric identity per session in the registry, and an API to obtain it |
| native group handle | 11 | a `DatagramGroup` object with membership lifecycle (join/leave/reap on close), i.e. a new product concept |

v1 ships the first rung because it is the only one that adds no new identity or
lifecycle concept, and because 0.84 ms inside G10's own 20 ms budget is not a
binding cost. **The other two rungs land only if G10's gate shows the emitter
binding** — measure-first, and the ticket's own rule that this microbench never
states the lever's value. The envelope, governor, cap and parity decisions below
are all target-shape-independent, so a later rung is an additive change, not a
redesign.

Recorded so it is not rediscovered: materialising the list from a live
subscriber `Set` costs 2–7 ns/target (RUNS.md run 4), ≤ 8% of the rung's own
cost. It does not move the decision.

### M2 — It lives on the **server** handle, and it is owner-scoped

`ServerHandle::send_datagram_mirror` (`server_napi.rs`, beside the other
`#[napi]` methods), not on a session handle: the call's subject is a *set of
sessions*, and the object that owns a set of sessions is the server. A session
handle would be an arbitrary choice of one member of the set.

Targets are resolved through `session_registry` and **filtered by owner**:
`owner_of(&id) == Some(self.server_id)`. Two servers in one process (the
`__TESTING__` suites and the client pool both create them) must not be able to
fan out into each other's sessions through a guessed id. A target owned by
another server reports `E_SESSION_CLOSED` — the same code as a reaped session,
because from this server's point of view that is exactly what it is.

There is no `ClientSessionHandle` mirror. A client holds one session; a fan-out
over a set of size one is the loop.

### M3 — **Synchronous, promise-free, non-parking**: the mirror is the fan-out of `trySendDatagram`, not of `sendDatagram`

The call returns its envelope directly. No `spawn_future`, no `spawn_counted`,
no `AsyncOpGuard` — because there is no async operation.

Four independent reasons, any one of which is sufficient:

1. **Cost.** Reading 6: one promise is ~13.6 µs. At N=100 that is 14 µs of
   promise wrapped around 1.1 µs of fan-out.
2. **Blocking is worse than dropping, for a broadcast.** A parking mirror
   iterated serially would let one slow subscriber hold the other 9,999 for up
   to `backpressureTimeoutMs`. Parking them concurrently means N futures — the
   N-sized allocation the whole design exists to avoid.
3. **The host-loop reference class.** `try_send_datagram_for_session` exists
   because napi-rs backs every promise with a TSFN, and a live TSFN is an
   event-loop reference the addon cannot see or count (`session.rs:137-151`).
   A broadcast API that took one per call would reintroduce that class at the
   worst possible rate.
4. **It sidesteps two live findings by construction.** The final-round review
   found `send_datagram_batch` bypassing `spawn_counted` (major) and the
   chunked batch re-deriving its deadline (major). A synchronous call has no
   async op to count and no deadline to re-derive.

A target that has no queue budget right now yields `E_WOULD_BLOCK` in the
failure list. **The caller's remedy already ships**: `session.sendDatagram()` on
just those targets is the parking path, and `sendDatagramWithoutPromise`
(`index.ts:1541-1551`) is the documented precedent for exactly this
try-then-fall-back shape. "Park only where needed" needs no new API — it needs
the failure list to name the targets that need it, which M4 does.

### M4 — Envelope: **failures-only**, and it is a set, not a prefix

```rust
#[napi(object)]
pub struct DatagramMirrorResult {
    pub sent: u32,            // targets that took the payload
    pub failed: Uint32Array,  // indices into the caller's target list
    pub codes: Uint8Array,    // parallel; one small enum per failure
}
```

`sent + failed.length == targets.length`, always. It never rejects and never
throws for a transport condition.

**A target list is not a prefix, and the batch API's envelope must not be
copied.** `{sent: k, code}` means "elements 0..k went, nothing after k was
attempted" — correct for a batch of payloads down one session, where element
k+1 genuinely cannot be sent before element k. It is *false* for a target set:
subscriber 4 being gone says nothing about subscriber 5, and a broadcast that
stopped at the first dead subscriber would be a defect, not a policy. **Every
target is attempted, independently, and the envelope reports which ones failed.**
This is the single most important semantic difference between T04's API and this
one, and M-T3 exists to pin it.

Why not the alternatives (§2 is the arithmetic):

- **Per-target `(string|null)[]`** — 2.4× the envelope cost at 0% failure and
  10,000 string allocations per healthy broadcast, to communicate "nothing
  failed". Rejected on measurement.
- **Bitset** — same cost, ⌈N/8⌉ bytes whether or not anything failed, carries no
  code, and forces an O(N) scan to find O(1) failures. Dominated.
- **Bare `{sent, failed}` counters** — cheapest, and useless: a broadcast whose
  point is per-subscriber delivery cannot act on a count. The caller needs to
  know *which* subscriber to reap or to retry on the parking path (M3).

`codes` is a `u8` enum rather than strings so the failure path allocates 1 byte,
not a string, per failure: `1 = E_SESSION_CLOSED`, `2 = E_QUEUE_FULL`,
`3 = E_WOULD_BLOCK`. The TS layer decodes to the existing `WebTransportError`
identities through the existing `toWebTransportError` mapping, so error identity
is unchanged from every other send path. The enum is defined once in native and
asserted equal on both sides by test (M-T2), the same way `DATAGRAM_BATCH_MAX`
is.

### M5 — One deadline, honestly: **there is no deadline, because there is no wait**

The ticket asks for ONE deadline across the fan-out. The truthful discharge of
that obligation for a non-parking call is that its cost is bounded by
construction: it performs N reserve/try-send/release triples and returns.
Nothing awaits, so nothing can be waited on twice — the failure mode M4's
sibling API had (a chunked call re-deriving `backpressure_timeout_ms` per
crossing, final-round major) is unreachable here.

If a parking mode is ever added it inherits both rules explicitly: one deadline
computed at entry for the whole call, and the waits joined **concurrently**, not
run in sequence. Recorded, out of scope, and not implemented on speculation.

### M6 — Governor: per-target reservation only, never a fan-out-wide one

Per target: `try_reserve_queued_bytes_with_session(len)` → `send` → `release`,
exactly as `try_send_datagram_for_session` (`session.rs:165-186`) does today.
Peak reservation across the whole call is **one payload**.

Two things this forbids, both the park-forever class fixed by `5ad0245`:

- **Never `N × len` against `max_queued_bytes_per_session`** — reserving a
  10,000-target fan-out's worth of bytes against a per-session budget is
  nonsense (they are different sessions) and against the *global* budget it is
  a self-inflicted failure: 10,000 × 200 B = 2 MB reserved at once, which a
  configured `max_queued_bytes_global` can easily refuse while every individual
  send would have succeeded.
- **No fan-out-wide admission pre-check.** Same reasoning one layer up: it
  would fail a broadcast that would have gone through target by target.

Because the call never waits, a full budget is a per-target `E_WOULD_BLOCK`
(M3), not a park. That is the mirror's answer to backpressure, and it is the
right one for a broadcast: an unreliable transport delivering to 9,997 of 10,000
subscribers now beats delivering to 10,000 late.

### M7 — The payload is copied **once at the crossing**; the per-target reframe is a separately-landable refinement

`data.as_ref().to_vec()` once, into `Bytes`, before anything else. Every target
gets a `Bytes` clone — a refcount bump, per the Phase-R precedent
(`0d8dace`). Against today's loop this replaces **N copies from JS with one**.

**Honest correction to the ticket's premise.** "Copied once and refcounted per
target" is true of the JS→native copy, and *not yet* true of the wire framing:
`wtransport::Connection::send_datagram` calls `Datagram::write(session_id,
payload)`, which allocates and copies the payload behind that session's own
H3 quarter-stream-id varint (`wtransport/src/datagram.rs:35-50`). Different
sessions, different prefix, different buffer — so v1 pays one framing copy per
target no matter what it hands in.

That copy is measured: the reframe row costs **+25 ns/target at 200 B, +40 ns
at 1150 B** (36 vs 11, 51 vs 11). Absolutely it is 0.25–0.40 ms on a
10,000-target broadcast — *smaller than the `string[]` marshalling M1 already
accepts*, which is why v1 keeps the safe `conn.send_datagram(&payload)` call.
Relative to the group rung it is 70% of the cost, which is why it is recorded
rather than dismissed.

Removing it is possible without forking: `wtransport` exposes
`Connection::quic_connection()` under the `quinn` feature (already enabled,
`Cargo.toml:15`) and `Connection::session_id()`, and `quinn`'s
`send_datagram(Bytes)` moves the buffer without copying. Framed buffers would be
memoised per distinct quarter-stream-id — and in the ordinary broadcast case,
where every subscriber's WebTransport session is the first on its connection,
that is **one** framed buffer for the entire fan-out. The cost is 6 lines of H3
datagram framing duplicated in the addon; the alternative is a
`send_datagram_shared(Bytes)` on our own fork (0-RTT precedent). Either way it
lands **behind its own byte-equality falsifier**: the same payload framed both
ways must produce identical wire bytes. Not in v1.

### M8 — Mutate-after-call is free

The call is synchronous and copies before it returns; there is no window between
the copy and the caller regaining control. Contrast the side finding from T05
(the shipped client `sendDatagram` is an `async fn`, so its `to_vec` is *not*
synchronous with the caller). Still pinned by test (M-T4), because the property
is a contract, not an accident of the current implementation.

### M9 — Duplicate targets are delivered to twice

The parameter is a list, not a set. Deduplicating would cost a hash set per
call — an N-sized allocation, the thing this design keeps refusing — to
second-guess a caller who may have meant it. The behaviour is documented and
pinned (M-T7).

### M10 — Cap: **10,000 targets**, derived from a JS-thread stall budget, and splitting is safe here

`DATAGRAM_BATCH_MAX` does not apply: its reason is the memory held outside the
queue's byte reservation while a batch of *payloads* is in flight, and a mirror
holds one payload regardless of N. But a synchronous fan-out stalls the JS
thread for its whole duration, so the cap is a **time** budget expressed in
targets:

- Budget: **1 ms** of JS-thread stall per call. G2's ingest bound is p99
  ≤ 5 ms; an emitter call that can stall the loop for more than ~20% of that
  bound is a latency hazard the gates would see, and it would see it as ingest
  latency, in the wrong place.
- Worst measured mirror shape: **90 ns/target** (`string[]`, either payload,
  N ≥ 100).
- 1 ms / 90 ns = 11,111 → **cap = 10,000**, which is also exactly the shape G10
  needs. Measured stall at the cap: 0.86 ms (`string[]`), 0.11 ms (group).

Over-cap throws a synchronous `RangeError`. This is the one place the design
throws, and it is safe precisely because the call is synchronous: there is no
napi promise to reject, so the Bun self-reference leak the batch envelope exists
to dodge cannot arise. It is a programming error, not a transport condition.

**Splitting a target list across two calls is observably identical to one call
over the union**, and the docs say so: there is no deadline to divide (M5), no
ordering obligation across targets (M4), and no shared state between targets.
This is exactly the property the batch API lacks — chunking there splits a
deadline that was promised to be single, which is the standing major finding
against `datagram-batch.ts:61-66`. Here, chunking is sound, so the TS layer does
**not** chunk silently: the cap is the caller's to respect, because a caller
broadcasting to 40,000 subscribers should be deciding when to yield the loop.

Empty list → `{sent: 0, failed: [], codes: []}`, no crossing.

### M11 — A missing, closed or foreign target is a failure entry, never an exception

Reaping is normal at 10,000 subscribers; a broadcast that threw because one
subscriber left between the app's snapshot and the call would be unusable. Every
such target reports `E_SESSION_CLOSED` at its index and the other 9,999 are sent
to. Combined with M4 this is what makes the failure list actionable: it is
precisely the reap list.

### M12 — Metrics: the mirror must be visible in its own right

- `datagram_sends_async` **must not** move: the mirror hands JavaScript no
  promise, and that counter's documented meaning is "datagrams that needed an
  N-API promise, which is the exposure this server has to the host-loop
  reference class" (`session.rs:196-198`).
- Two new server counters: `datagram_mirror_calls` and
  `datagram_mirror_targets`. The standing review note against
  `send_datagram_batch_for_session` is exactly the failure of a new send path
  being invisible to the meters that name its class; this design does not repeat
  it.
- Per-session `datagrams_out` and the enqueue histogram increment once per
  **delivered** target, unchanged from every other send path, so a mirrored
  datagram is indistinguishable from a looped one in per-session metrics. That
  is deliberate: G10's delivery ratio must not depend on which arm produced it.

### M13 — Parity: native-only, by T06's mechanism, at the **server** level

`PortableServer` already has the precedent this needs —
`_AssertNoUpdateCertOnPortable` (`public-surface-contract.test.ts:88-91`) pins a
native-only *server* member exactly as `_AssertNoGoAwayOnPortable` pins a
session one. So:

- compile-time negative: `_AssertNoSendDatagramMirrorOnPortable` against
  `PortableServer`, beside the `updateCert` assertion;
- runtime half: the member is absent from the live portable server on both
  backends (safe here for the same reason T06 gave for `sendDatagramBatch` —
  `createNativePortableServer` builds an explicit object literal, and wasm has
  no such member to leak);
- the three frozen export lists are **unchanged** — a method on `ServerHandle`
  is not a module export, which was T06's load-bearing correction to T04's D10.

A wasm loop-shim is rejected for the same reason and one stronger one: the API's
entire content is amortising an N-API crossing wasm does not have, and the wasm
backend has no session registry to fan out through. `PARITY_MATRIX.md` §3 gains
a row beside the `sendDatagramBatch` one, worded as its send-side sibling.

### M14 — No knob

Additive: no existing call site changes behaviour, so there is nothing to gate
and no soak-freeze interaction. G10's arm (c) calls it directly, exactly as G3's
arm (c) calls `sendDatagramBatch`.

### M15 — Public TS shape

```ts
// WebTransportServer (native root surface only)
sendDatagramMirror(
  targets: readonly string[],
  payload: Uint8Array,
): { sent: number; failures: readonly { target: string; error: WebTransportError }[] };
```

The TS layer decodes the parallel `Uint32Array`/`Uint8Array` into the shape an
application can act on: the failing **session id** (not an index the caller must
resolve back) and the same `WebTransportError` identity every other send path
produces. In the healthy case `failures` is a shared frozen empty array, so a
successful broadcast allocates one small object and nothing else.

It throws synchronously for a non-array argument, a non-string element, a
non-`Uint8Array` payload (`TypeError`) and an over-cap list (`RangeError`) — all
programming errors, none of which cross N-API. It never throws for a transport
condition.

---

## 4. Test obligations for the implementation ticket

| # | Test | Pins |
|---|---|---|
| M-T1 | one-target mirror produces the same wire bytes, the same per-session `datagramsOut` delta and the same error codes as `trySendDatagram` | M3 |
| M-T2 | never throws for a transport condition: closed target, unknown id, foreign-owner id and a full byte budget each land in `failures` with the right code; the native `u8` enum and the TS decode table are asserted equal and exhaustive | M4, M11 |
| M-T3 | **set, not prefix**: with target 0 closed, targets 1..N-1 all receive the payload and `sent == N-1`; with every other target closed, the survivors all receive | M4 |
| M-T4 | caller mutates the payload array synchronously after the call returns; every peer received the original bytes | M8 |
| M-T5 | `max_queued_bytes_per_session` = 512 B and a small `max_queued_bytes_global`, 1,000 targets: the call returns promptly, peak reserved bytes never exceeds one payload, and full-budget targets report `E_WOULD_BLOCK` rather than parking | M6 |
| M-T6 | two servers in one process: a target id owned by server B is reported `E_SESSION_CLOSED` by server A's mirror and receives nothing | M2 |
| M-T7 | the same id twice in one list is delivered to twice (`datagramsOut` += 2) | M9 |
| M-T8 | cap: `cap` targets succeeds, `cap + 1` throws `RangeError` synchronously and sends nothing; a list split across two calls is observably identical to one call over the union | M10 |
| M-T9 | metrics: `datagramSendsAsync` is unchanged across a mirror call, `datagramMirrorCalls`/`datagramMirrorTargets` increment as expected, per-session `datagramsOut` increments once per delivered target | M12 |
| M-T10 | parity: `_AssertNoSendDatagramMirrorOnPortable` compiles as a negative, the member is absent from both backends' live portable server, the three frozen export lists are untouched, and `PARITY_MATRIX.md` §3 carries the row with a real evidence path | M13 |

---

## 5. What this note does not decide

- **Whether the mirror API is worth landing.** That is G10's three-arm
  comparison (ticket 35), run by a different agent per spec §Separation, and its
  number must be stated as **mirror vs `trySendDatagram`**, never against the
  retired promise shape. Reading 1 is the arithmetic.
- **Whether G10 is still lever-blocked.** Reading 2 says it is not, on emitter
  cost. G10's shape draft should be re-read against that before it
  pre-registers — the blocking premise in its own ticket text predates
  ticket 23's landing.
- **Anything about absolute throughput, delivery or latency.** These are macOS
  shape ratios on a contended box.
- **The `Uint32Array` and native-group rungs (M1).** Priced, not proposed. They
  are licensed only by a G10 result that shows the emitter binding.
- **The shared-framed-`Bytes` refinement (M7).** Priced, scoped out, and owed
  its own byte-equality falsifier if anyone picks it up.

---

## 6. Standing findings this design is written around

Three live findings from `reviews/final-round.json` touch the neighbouring send
paths. None of them is inherited here, and each is avoided by construction
rather than by care:

| finding | why the mirror cannot repeat it |
|---|---|
| `send_datagram_batch` bypasses `spawn_counted`, so a batched send is invisible to the close contract (major) | the mirror spawns nothing (M3) |
| the JS chunker re-derives the backpressure deadline per crossing, so "one deadline for the whole call" is false above 256 elements (major) | the mirror has no deadline, and its splitting is semantically sound (M5, M10) |
| `send_datagram_batch_for_session` never increments `datagram_sends_async` although it does hand JS a promise (note) | the mirror hands JS no promise, and gets its own counters instead of borrowing a meter whose name would then be wrong (M12) |

One further finding is *shared* and must be stated rather than dodged:
`try_send_datagram_for_session` takes quinn's connection-state mutex on the JS
thread (note). The mirror takes it N times per call, on the JS thread, in a
tight loop. That is the same axis, at 10,000× the rate — and it is the reason
M10's cap is derived from a JS-thread stall budget rather than from a round
number. **It is also the one thing this microbench cannot see**, because the
addon has no quinn connection: a real mirror's per-target cost includes lock
acquisition and any contention with the driver task. G10's arm (c) is where that
shows up, and the bound M10 derives is the honest place to look for it first.
