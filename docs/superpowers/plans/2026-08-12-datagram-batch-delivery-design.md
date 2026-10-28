# H7 design: batch datagram delivery to shrink per-datagram napi machinery

Status: DESIGN OPTION (not approved). Context: memory-growth investigation
2026-08-12. Root cause #2 of the soak OOM is per-datagram JS garbage that
survives eden GC and is only reclaimed by a full GC that Bun never schedules
organically in the default (buffer-copy) delivery mode.

## What each delivered datagram costs today

`WtSession.read_datagram` (crates/native/src/session_napi.rs:157) runs
`env.spawn_future` per call. In napi-rs 2.16.17 (`js_values/deferred.rs`)
that creates, **per datagram**:

- 1 brand-new ThreadsafeFunction (full TSFN lifecycle, napi_ref rooted until
  full-GC finalization — the best current pin theory for the `fn` growth in
  the matrix logs)
- 1 deferred + 1 JS Promise (measured ~0.6 promises/datagram retained)
- 1 payload Buffer/Uint8Array + handle-scope slots

Measured on the lc-matrix harness (20 sessions × 50 dgrams/s): baseline
grows ~0.6 Objects/datagram, heap +~4MB/min, RSS ~100MB/h, no organic full
GC for 10+ minutes.

## Option A (recommended): pull-based batch read

Native:

```rust
#[napi(ts_return_type = "Promise<Buffer[] | null>")]
pub fn read_datagram_batch(&self, env: Env, max: u32) -> Result<JsObject> {
    // one spawn_future per BATCH:
    // 1. await first datagram (blocking, same semantics as read_datagram)
    // 2. drain queue non-blocking up to `max` (e.g. 64)
    // 3. return Vec<PayloadBuffer>; None on session end
}
```

JS (`packages/webtransport/src/index.ts` `incomingDatagrams`, line ~1405):
the async generator pulls a batch, `yield`s items from the local array,
pulls the next batch when drained. Public API unchanged
(`AsyncIterable<Uint8Array>`); ordering preserved; backpressure preserved
(pull-based — no batch is read until the consumer drains the previous one).

Effect: TSFN + promise + deferred cost drops from per-datagram to
per-batch (÷ up to 64 under load; degenerates gracefully to today's cost at
low rates where batches are size 1 and memory doesn't grow anyway).
Payload buffers themselves remain per-datagram, but those are the cheap,
GC-visible part (and the arraybuffer experiment makes them pressure-bearing).

Latency: unchanged. Step 1 still resolves on the FIRST datagram; the drain
in step 2 only takes what is already queued.

## Option B: single long-lived push TSFN

One ThreadsafeFunction registered per session; Rust pushes each datagram
into a JS-side ring buffer. Eliminates promises entirely but:

- still one TSFN *call* (+ napi value materialization) per datagram,
- needs an explicit backpressure protocol (pause/resume or drop policy)
  that the pull model gives us for free,
- bigger surface change in both layers.

Rejected as first move; revisit only if Option A's per-batch promise churn
still shows up in soak evidence.

## Interaction with the other levers

- `--smol` / periodic `Bun.gc(true)` valve: orthogonal, both proven flat.
  Option A reduces the garbage *production* rate ~10–60×, which stretches
  every GC-side mitigation and may make the valve unnecessary.
- Arraybuffer delivery (payload_buffer.rs experiment): makes payload bytes
  visible to JSC's allocation accounting → organic full GCs (proven at
  t≈150s). Combines cleanly with Option A: batch delivery cuts the napi
  machinery, arraybuffer makes what remains self-collecting.

## Verification plan

lc-matrix A/B: baseline vs batch build, GC_MODE=none, 20 min. Success =
Object/promise/fn growth per received datagram drops ~batch-size-fold and
RSS slope flattens or the organic-GC period shortens accordingly. Then
2h verification soak before any rebind.
