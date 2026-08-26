# RFC: Native Stream Sink API (`openReadSink` / `SinkReader`)

Status: **approved; Phase 0 spike PASSED (GO, 2026-08-26)** — see §10 Phase 0 results.
Architect + critic review complete 2026-08-26; maintainer approved same day.
Discharges: `docs/OPERATIONS.md` §"Sizing the JS read side", rule 2 — "treat 'read latency-critical
data on a saturated JS loop' as unsupported until it is productized."

## 1. Problem and evidence

Everything a stream delivers to JavaScript surfaces on one event loop, and app-observed tail
latency is a queueing function of that loop's utilization: 2.5 ms p99 with headroom, 5.2 ms at
~82 %, 11.5 ms at ~95 %, and 348 ms (~140× inflation) on a host that held the loop at 93–95 % of a
slower core — while wire-level delivery stayed flat throughout (C6-app root cause, 2026-08-25;
`docs/research/2026-08-21-bare-metal-capacity.md`; OPERATIONS.md §Sizing). A harness-only native
sink (`crates/native/src/frame_sink.rs` @33b304df, probe/g11-bidi-06) that drained off the event
loop held a flat 3–4 ms app-level overhead at every utilization the JS path degraded under, with
zero JS data crossings (`t100-native.json`: `dataCrossings: 0` vs 1.6 M harness reads).

This RFC productizes that mechanism as a supported API.

## 2. Decisions (maintainer, 2026-08-26 scoping)

1. **Consumption: SharedArrayBuffer + Atomics ring.** Native fills a SAB ring; the consumer reads
   from a Worker with zero napi calls on the hot path. (Chosen over ring+napi-drain, TSFN-push,
   fd sink.)
2. **Payload: raw chunks + optional declarative framing.** Base mode delivers arrival-stamped raw
   byte chunks. An optional length-prefix framing descriptor yields per-message records with
   per-message stamps. No harness-specific wire format in the product API.
3. **Backpressure: per-sink policy.** `overflow: 'block'` default (lossless — ring full parks the
   native reader, QUIC flow control throttles the sender); `'drop-newest'` opt-in (never blocks
   the wire; drops counted and disclosed).
4. **WASM: shape parity.** Same TS API and ring layout on the wasm backend; docs state plainly
   that latency isolation is native-only (wasm has no second thread).

Probed facts (this machine, Bun): worker-side `Atomics.wait`, `Atomics.waitAsync`,
`Atomics.notify` all work across threads on a SAB; a JS `notify` wakes a parked worker `wait`.
Native threads **cannot** wake a JSC futex — no napi entry point into JSC's ParkingLot — so the
doorbell design (§5) works around that. Unverified and gated in Phase 0: napi yielding a stable,
off-thread-writable pointer to SAB backing memory.

## 3. Public TS API

```ts
export interface StreamSinkFraming {
  headerBytes: number;               // 1..=64
  lengthOffset: number;
  lengthWidth: 1 | 2 | 4 | 8;
  endianness?: 'le' | 'be';          // default 'le'
  lengthIncludesHeader?: boolean;    // default true
  maxFrameBytes: number;             // required; validated at open (§4 sizing rule)
}

export interface StreamSinkOptions {
  ringBytes?: number;                // default 4 MiB; min 64 KiB; max 1 GiB; power of two
  overflow?: 'block' | 'drop-newest'; // default 'block'
  framing?: StreamSinkFraming;       // absent => raw DATA chunks
  clock?: 'monotonic' | 'wall';      // default 'monotonic'; 'wall' for cross-host stamp math
  backpressureTimeoutMs?: number;    // block-mode stall deadline; default 5000
  idleTimeoutMs?: number;            // drop-newest liveness deadline; default off (0)
}

export interface StreamSinkHandle {
  readonly buffer: SharedArrayBuffer;        // postMessage to the worker (shared, not transferred)
  readonly descriptor: StreamSinkDescriptor; // { version, mode, ringBytes, flags, framing, clock }
  stats(): StreamSinkStats; // { bytesIn, records, droppedRecords, droppedBytes, ringHighWater,
                            //   pendingPartialBytes, state: 'active'|'eof'|'error'|'stalled'|'closed' }
  close(): Promise<void>;   // idempotent; commits terminal, awaits task exit, releases SAB ref
}

export function openReadSink(
  stream: RecvStream | BidiStream | WebTransportReceiveStream,
  opts?: StreamSinkOptions,
): StreamSinkHandle; // throws synchronously on misuse (open-time validation)

// Worker-side. Separate entry point with zero native imports.
export class SinkReader {
  constructor(descriptor: StreamSinkDescriptor, sab: SharedArrayBuffer,
              opts?: { wakeTimeoutMs?: number; copy?: boolean });
  next(deadlineMs?: number): SinkRecord | null;  // blocking; null = deadline expired
  [Symbol.asyncIterator](): AsyncIterableIterator<SinkRecord>; // waitAsync-based
  readonly state: 'active' | 'ended';
}

export type SinkRecord = {
  type: 'data' | 'message' | 'eof' | 'error' | 'reset' | 'drops';
  timestampNs: bigint;      // clock domain per descriptor
  streamOffset: bigint;     // cumulative wire offset (resync anchor after 'drops')
  payload: Uint8Array;      // view into the SAB — valid until the NEXT next() call
  code?: string | number;   // 'error': code string; 'reset': app error code
  count?: number;           // 'drops': dropped-record count
};
```

Contracts:

- **Zero-copy view discipline.** `payload` is a subarray view into the SAB, valid until the next
  `next()` (which auto-advances HEAD past the previous record — quinn's chunk-borrow discipline).
  `copy: true` opts into safe copies. This is the point of the API; docs are loud about it.
- **One-way terminal detach.** `openReadSink` permanently owns the readable half. It throws
  `E_SINK_READ_ACTIVE` if any facade read has started (tri-state ownership, §6); afterwards
  `read()`/`readBatch()` resolve the in-band string `E_SINK_ACTIVE` (never-reject contract,
  client_stream.rs:1435), the Node `Readable` is destroyed with an explanatory error, and the W3C
  `readable` getter returns an already-errored stream (not a getter throw — friendlier to
  feature-detection). Second open → `E_SINK_ALREADY_OPEN`. The writable half is untouched.
- **Terminals ride the ring.** EOF / error / reset are in-band records, strictly ordered after
  all data. `stats().state` and the header mirror word are conveniences, never the source of
  ordering truth.
- `SinkRecord.type 'message'` payloads are the **full frame including header** (lossless).
- In-band ERROR record payloads are capped at 32 bytes (code strings only) so the reserved
  terminal slot bound (§4) holds.

## 4. SAB ring layout (LAYOUT_VERSION 1)

Single **SPSC byte ring, records inline with payload**. One producer (native sink task, or the
TS RingWriter on wasm), one consumer (`SinkReader` in one worker). SPSC is enforced by
construction — one sink per stream, one descriptor handed out — and documented. (A fixed record
ring + separate payload heap was rejected: consumption is strictly FIFO, so the heap degenerates
into a second byte ring; inline costs one cursor and reclamation is "advance HEAD".)

All multi-byte fields little-endian. Offsets fixed:

```
[0..64)     Config line (written once at open, then read-only)
   0  u32  MAGIC 0x5754_534B ("WTSK")
   4  u32  LAYOUT_VERSION = 1
   8  u32  dataCapacity            // power of two, <= 2^30
  12  u32  flags                   // bit0 framing, bit1 drop-newest, bit2 clock=wall,
                                   // bit3 producerNotifies (wasm), bit4 modeB
  16  u32  dataOffset = 192
[64..128)   Producer line (own cache line)
  64  u32  TAIL                    // free-running byte counter, Release-published
  68  u32  sinkState               // 0 ACTIVE, 1 TERMINAL_COMMITTED, 2 EXITED
  72  u64  droppedRecords          // Relaxed
  80  u64  droppedBytes
  88  u32  ringHighWaterBytes
[128..192)  Consumer line (own cache line)
 128  u32  HEAD                    // free-running byte counter, Release-published
 132  u32  consumerHeartbeat       // bumped by SinkReader on EVERY wait-loop iteration (§6 stall)
[192..192+dataCapacity)  data region
```

Cursors are free-running u32 counters: fill `= (TAIL - HEAD) >>> 0`, position
`= counter & (dataCapacity - 1)`; `dataCapacity ≤ 2^30` keeps mod-2^32 arithmetic unambiguous.
Wraparound of the counters themselves is property-tested across the 2^32 boundary.

**Record format** — 32-byte header, 8-byte aligned, payload follows, padded to 8:

```
  0  u32  recLen              // header + payload + padding
  4  u8   type                // 1 DATA, 2 MESSAGE, 3 EOF, 4 ERROR, 5 RESET, 6 WRAP, 7 DROPGAP
  5  u8   flags
  6  u16  reserved
  8  u64  timestampNs
 16  u64  streamByteOffset    // starts at bytes already consumed by prior facade reads (§6)
 24  u32  payloadLen          // unpadded
 28  u32  aux                 // RESET: app error code; DROPGAP: dropped count; else 0
```

**Wrap and terminal reservation (critic-hardened; pad-to-end amendment from the phase-2
implementation).** Rules, enforced by the writer and validated at open. With `remainder` the
contiguous space from the TAIL position to the region end, and every `recLen` a multiple of 8:

- `remainder ≥ recLen + 32`: write normally (the next record's start keeps ≥ 32 bytes of
  contiguous headroom, or lands exactly on the boundary).
- `recLen ≤ remainder < recLen + 32`: the record is **extended to span the whole remainder**
  ("pad-to-end", ≤ 31 bytes of tail padding). The consumer trusts `payloadLen`, so the padding
  is invisible. Without this arm, a pure WRAP rule allows a WRAP of up to `recLen + 24` bytes
  ahead of a terminal — 88 + 64 = 152 bytes worst case, overrunning a 128-byte reserve.
- `remainder < recLen`: a WRAP record spans the remainder (≥ 32 by the invariant above), and
  writing resumes at position 0.
- **128 bytes** of capacity are permanently reserved (subtracted from usable fill): the worst
  terminal commit is a WRAP (≤ 56 B, since a wrap before a 64 B terminal implies remainder
  < 64) plus the 64 B terminal record = 120 B, or a single ≤ 88 B pad-to-end terminal. A
  terminal record therefore always commits, even on a "full" ring, at every tail geometry —
  property-tested across tail positions.
- Open-time sizing rule: `32 + maxPayload ≤ dataCapacity/4` AND
  `32 + maxPayload ≤ dataCapacity − 128 − 32`, where `maxPayload` is the raw read cap
  (`min(64 KiB, dataCapacity/4)`, producer-controlled) or `framing.maxFrameBytes`. Violation →
  synchronous `E_SINK_BAD_OPTIONS`.

**Memory ordering.**

- Producer (Rust, `&*(ptr as *const AtomicU32)` over the SAB base pointer): load HEAD
  **Acquire** (pairs with the consumer's HEAD publish — reclaimed bytes are dead to the consumer
  before overwrite); write header + payload with `ptr::copy_nonoverlapping` (non-atomic; see
  risk R2); store TAIL **Release**.
- Consumer (JS): `Atomics.load` TAIL (JS atomics are seq-cst, ≥ Acquire); plain typed-array reads
  of record bytes; `Atomics.store` HEAD only after those bytes are dead to the consumer.

## 5. Doorbell

**Consumer wake: timeout-bounded `Atomics.wait` on the TAIL word.**
`Atomics.wait(i32, TAIL_IDX, lastSeenTail, wakeTimeoutMs)`:

- If TAIL moved since the last drain, the wait returns `'not-equal'` immediately — no sleep, no
  missed-wake TOCTOU (the compare-and-park is atomic in the futex).
- If it parks, the timeout bounds wake latency, because native cannot notify a JSC futex. The
  timeout **is** the doorbell.
- Default `wakeTimeoutMs = 0.5` (tunable 0.1–100 ms). Worst-case added latency 0.5 ms — well
  inside the 3–4 ms harness envelope with wire p99 at 0.3 ms. Under sustained load the reader
  almost never parks. Idle cost ≈ 2 k futex timer expiries/s per idle reader (low single-digit %
  of one core — the price of the latency class; measured curve published by the bench). Phase 0
  verifies Bun honors sub-millisecond wait timeouts rather than clamping.
- Rejected: fd doorbell (native writes a pipe byte). A Bun worker cannot block on a foreign fd
  without loading the addon in-worker — strictly more machinery for the same bounded latency.
  Kept as a v2 option behind the same `SinkReader` API; the Phase-0 spike checks addon-in-worker
  viability anyway (mode B needs it).
- The async-iterator mode uses `Atomics.waitAsync` with the same compare semantics, for consumers
  sharing their worker's loop. The blocking `next()` loop is the documented latency-critical mode.
- On wasm the producer is JS, so it **does** `Atomics.notify` TAIL after each publish; header
  flag `producerNotifies` lets `SinkReader` use long waits with instant wakes.

**Producer wake (block mode, ring full):** native polls HEAD with adaptive `tokio::time::sleep`
backoff 200 µs → 1 ms, only while full (`BUDGET_POLL_INTERVAL` precedent,
client_stream.rs:281–304). When the ring is full, latency is already consumer-bound; ≤1 ms to
unblock is noise against the stall itself, and the poll costs nothing when the ring has room.

## 6. Native architecture

New file `crates/native/src/stream_sink.rs` (the probe-branch `frame_sink.rs` remains a harness
artifact and is not merged). Surface methods on `ClientBidiStreamHandle` and
`ClientUniRecvHandle` cover **both endpoints and both directions** — server sessions return the
same handle types (session_napi.rs:384,406,451; client.rs:185–188). `ClientUniSendHandle` has no
readable half — no sink.

**Read-side ownership tri-state (critic B1/M1 fix — its own phase).** Today only server-accepted
streams are lazily bridged (`deferred_recv`, client_stream.rs:1009); client-opened/-accepted and
server-created streams spawn bridges eagerly (client.rs:1446,1519; lib.rs:1367), and direct
deferred reads temporarily take the RecvStream out and put it back (client_stream.rs:1200–1207,
854–863) — so both "sink on client streams" and "was a read active?" are undecidable from
`deferred_recv` alone. Phase 1 therefore:

- Extends lazy bridging to all recv-capable handles (strictly better: no bridge task, channel, or
  scratch buffer until first read — the existing server-accepted behavior becomes universal).
- Replaces the option-juggling with one explicit atomic ownership state per readable half:
  `Deferred | DirectReadActive | Bridged | Sink | Consumed`. `openReadSink` CASes
  `Deferred → Sink` and errors in-band otherwise (`E_SINK_READ_ACTIVE` for
  DirectReadActive/Bridged, `E_SINK_ALREADY_OPEN` for Sink). `streamByteOffset` starts at bytes
  already consumed by prior direct reads.

**Open path.** Sync napi `open_read_sink(sab_view: Uint8Array, opts) -> Either<SinkOpenInfo,
String>` (never-reject: all failures are in-band strings). The TS wrapper allocates the SAB
(native never creates one); native validates layout/options, writes the config line, takes the
RecvStream via the CAS above, creates a `napi_ref` on the SAB held in the handle struct, and
spawns the sink task on `RUNTIME`. **The sink task owns no napi values** — the Bun
rejected-async self-ref leak class (client_stream.rs:1435) is structurally impossible on the hot
path.

**Sink task.** Owns the RecvStream; loops `read_chunk(min(64 KiB, cap/4), true)` directly
(zero-copy discard precedent, client_stream.rs:224–240), bypassing the mpsc bridge entirely.
Framing mode runs an incremental deframer (shape of `@33b304df` frame_sink.rs `Deframer`, its
unit tests carried over) with a staging buffer only for frames split across chunks; whole frames
copy chunk→ring once. Selects on a `Notify` stop signal from `close()`/dispose.

**StreamBudget: sink bytes do NOT reserve budget.** The tiers bound engine-held queue memory
(client_stream.rs:390–401); sink buffering is the user's fixed SAB plus quinn's recv buffer,
neither unbounded. Double-charging a fixed user allocation would starve sibling bridges.
Compensations: `ringBytes` and high-water in `stats()` + `metricsSnapshot` so operators can sum.
`overflow:'block'` composes with quinn exactly as intended: full ring stops `read_chunk`, quinn's
recv buffer fills, MAX_STREAM_DATA stalls at the stream receive window
(client_stream.rs:475–478), the sender throttles. Effective lossless buffer = ring + stream
window.

**Bridge cap: sinks take no `DEFERRED_READ_BRIDGES` permits** (that semaphore bounds bridge
tasks + channels + scratch, client_stream.rs:244–252; a sink has none, and latency-critical opens
must not park behind bulk readers). Own global cap: 1024 active sinks (fail-fast in-band
`E_SINK_LIMIT`, no parking). Rationale vs the 64-bridge bound: a sink task's footprint is one
tokio task + one staging buffer (framing only) — no channel, no per-read scratch, no JS-side
queue; 1024 bounds runaway open loops while clearing the ~100-stream MMO shape with margin.

**Timestamps.** One u64 stamp per record. Default **monotonic** (steady, NTP-immune — right for
"when did this arrive"); `clock:'wall'` (CLOCK_REALTIME) opt-in for cross-host sender-stamp math
(why the harness used wall). Domain flagged in the config line; `SinkReader` labels values.

**Stall/liveness (critic M3 fix).** `consumerHeartbeat` is bumped by `SinkReader` on every
wait-loop iteration (Relaxed store) — it signals *liveness*, not progress, so a live consumer
that is merely slow is never killed. Block mode: ring full AND no heartbeat change for
`backpressureTimeoutMs` (default 5000) → `recv_stream.stop(0)`, ERROR `E_SINK_STALLED` into the
reserved terminal slot, task exits — the abandoned-reader memory lesson applied
(client_stream.rs:315–323): a dead worker must not wedge the sender or pin the task forever.
Drop-newest mode: optional `idleTimeoutMs` (default off) applies the same liveness rule for
consumers that should be polling; without it, a dead worker leaks nothing unbounded (drops are
counted; sink and SAB are freed at stream/session close) — documented.

**Teardown (critic M2 fix).** Any of {`close()`, stream reset, STOP_SENDING, session close, wire
error} → terminal record commits (pre-reserved slot always fits) → `sinkState := EXITED` → task
drops the RecvStream and exits. The SAB `napi_ref` is released on the JS thread **only after
task exit is observed**: `close()` awaits a oneshot fired from the task's exit path (async napi,
in-band result); the handle finalizer path spawns the same watcher. No window where native holds
a raw SAB pointer that JS has released. Worker death is the stall-deadline case above. SAB memory
is engine-allocated and GC-accounted at creation — the payload_buffer.rs invisible-native-bytes
trap (payload_buffer.rs:1–23) does not apply; docs state ring memory is user-provisioned and
outside the `maxQueuedBytes*` tiers.

**Stats/metrics.** Sync `stats()` reads atomics (datagram_mirror convention). `metricsSnapshot`
gains `sinksActive`, `sinkDroppedRecords` (optional-field convention, metrics.rs:27–30). No new
env knobs — per-call options only.

## 7. WASM shape parity

Same TS API, same ring layout, same `SinkReader`. The producer is a TS `RingWriter` (mirror of
the Rust writer; both checked against shared golden vectors) fed directly from the wasm stream's
`onData` on the main thread (the `streamReadable` machinery in wasm-webtransport.ts:150 is
refactored so sink mode consumes `onData` without the pull adapter). `overflow:'block'` maps to
`wt_stream_pause`/`resume` (crates/wasm/src/bridge.rs:756,763); the producer observes HEAD
progress via `Atomics.waitAsync` and notifies TAIL after each publish (`producerNotifies`).
Documented divergence: on wasm the fill happens on the main loop — a saturated loop still delays
production. **Shape parity, not latency parity.**

## 8. Failure modes

| Case | Behavior |
|---|---|
| Chunk/frame exceeds sizing rule | Raw: impossible (producer caps `read_chunk`). Framed: open-time `E_SINK_BAD_OPTIONS`; wire frame > `maxFrameBytes` → ERROR terminal + `stop()` (wire fault, like harness parse) |
| Consumer dead, block mode | fill → sender throttled (lossless) → heartbeat-based stall deadline → `stop(0)` + `E_SINK_STALLED` terminal + task exit |
| Consumer dead, drop-newest | drops counted, DROPGAP records with `streamByteOffset` resync anchor; optional `idleTimeoutMs`; resources freed at stream/session close |
| Consumer alive but slow | never killed (heartbeat ≠ progress); block mode throttles sender instead |
| Sink opened twice / after read active | in-band `E_SINK_ALREADY_OPEN` / `E_SINK_READ_ACTIVE` (tri-state CAS) |
| `read()`/facade use after sink | in-band `E_SINK_ACTIVE`; Node Readable destroyed; W3C readable = errored stream |
| Stream reset mid-frame | RESET terminal, app code in `aux`, `pendingPartialBytes` in stats |
| Session close / dispose | Notify → terminal → EXITED → ref release after observed exit |
| Ring full at terminal time | 128-byte reservation guarantees WRAP + terminal always commit |
| u32 cursor wraparound | free-running counters, property-tested across 2^32 |

## 9. Testing and verification

1. **Rust unit/property/fuzz**: `SinkRing` with random chunk-size sequences including wrap-around
   at every offset and cursor wraparound; a Rust reference consumer asserts byte-exact FIFO;
   framing fuzz with split points at every byte offset (harness test style carried over).
2. **Cross-language golden vectors**: byte-exact ring dumps produced and consumed by both the
   Rust writer/reference-consumer and the TS `RingWriter`/`SinkReader` — pins LAYOUT_VERSION 1.
3. **Bun integration**: worker end-to-end for every §8 row, both endpoints (client sink on
   server-initiated stream and vice versa), both overflow modes, facade detach, sub-ms
   `Atomics.wait` timeout behavior.
4. **Latency gate**: `tools/load/bench-sink.ts` — T-100-like shape with a main-loop saturator;
   assert sink app-level p99 stays flat (≤5 ms) at utilizations where `read()` degrades; publish
   the wakeTimeout latency/CPU curve. The g11 harness pieces this adapts (`bench-g11.ts`,
   `g11-frame.ts`) exist **only on probe/g11-bidi-06** — porting them into `tools/load/` on main
   is an explicit Phase 6 deliverable (critic M5).
5. **Soak**: 24 h sink open/close churn + RSS trend (soak-addon precedents) — targets the
   historical napi-ref leak class. Linux dedicated runner (local macOS soak is not a valid gate —
   standing rule).
6. **CI**: Linux runner for gate + soak; macOS covers Bun/JSC Atomics behavior in unit/integration.

## 10. Phasing (≤5 files each; each phase verified before the next)

- **Phase 0 — spike (go/no-go, throwaway):** verify in Bun: (a) napi
  (`napi_get_typedarray_info`) over a SAB-backed view yields a stable pointer writable from a
  non-JS thread; (b) SAB backing survives main-thread GC while a worker and a native ref hold it;
  (c) the addon loads inside a Bun Worker; (d) `Atomics.wait` honors sub-millisecond timeouts.
  **Fallback if (a) fails — mode B (explicitly degraded):** ring stays in native memory; the
  worker loads the addon and drains via a worker-thread sync napi call into a worker-local
  buffer. Same `SinkReader` API, but: polling floor ~1 ms (no futex against native memory),
  forced copies (no zero-copy views), `descriptor.mode = 'B'`, and its own gate numbers published
  separately. Mode B is a documented degradation, not silent parity (critic M4).

  **Phase 0 RESULT (2026-08-26): GO on all four items — mode B not needed.** Evidence archived at
  `.scratch/sink-phase0-spike-2026-08-26/` (throwaway crate + RESULTS.md). Summary, on Bun 1.3.14 /
  napi 2.16.17 (repo-locked) / macOS aarch64: (a) SAB backing pointer via napi identical across
  `Bun.gc(true)`×5 + 64 MiB garbage churn; a detached `std::thread` wrote 3000 records through it,
  all observed by the worker via Atomics, checksums clean. (b) Main dropped every SAB ref and GC'd
  while the native thread wrote — zero corruption. (c) `.node` loads inside a Bun Worker; per-env
  re-registration fine. (d) `Atomics.wait` honors sub-ms timeouts (0.1→0.131 ms, 0.5→0.633 ms mean;
  no clamping). Doorbell latency with the 0.5 ms wait loop: native-write→worker-observe p50 0.33 ms,
  p90 0.60 ms, p99 2.9 ms (within the ≤5 ms gate), max 8.9 ms on an unpinned dev box — the
  authoritative gate remains the Linux dedicated runner in Phase 6.
- **Phase 1 — read-ownership tri-state:** universal lazy bridging + `Deferred | DirectReadActive
  | Bridged | Sink | Consumed` state machine in client_stream.rs / client.rs / lib.rs; no sink
  code yet; full existing test suite green (this phase touches the hot read path — it merges only
  with zero behavior change for current readers).

  **Phase 1 RESULT (2026-08-26): COMPLETE** — commits bc718ef7 (dead-constructor pre-cleanup),
  9431df18 (`read_ownership.rs` gate + universal deferral + `BridgeRuntime` + `installed_budget`
  bridge fix + `direct_bytes_consumed`), 9cd67d58 (orphaned eager-bridge lanes removed, −263
  lines). Verified: 308/308 native unit tests, full TS suite (one environmental miss — the
  adversary-binary path vs the shared cargo target-dir — fixed locally, flagged for a proper
  `cargo metadata` fix; one documented churn-burst flake, passing in isolation and in the other
  full run), `tsc` clean. Read-path contract unchanged.
- **Phase 2 — ring core:** `crates/native/src/stream_sink.rs` (ring writer + deframer + property
  tests + golden-vector emitter).

  **Phase 2 RESULT (2026-08-26): COMPLETE** — commit 2db6ea64. `SinkRing` (LAYOUT_VERSION 1
  writer with WRAP/pad-to-end geometry, DROPGAP disclosure, exactly-once terminal from the
  reserve), declarative `Deframer`, Rust reference consumer, fuzz (200k-op wrap-around FIFO,
  u32 cursor wraparound, terminal-commit sweep across tail geometries, deframe splits at every
  byte), and the layout-v1 golden vector for the TS twins. §4 amended with the pad-to-end rule
  (a pure WRAP rule had a 152-byte terminal worst case against the 128-byte reserve).
  318/318 native tests, clippy clean.
- **Phase 3 — napi surface:** open/close/stats + task + teardown watcher: client_stream.rs,
  stream_sink.rs, lib.rs, metrics.rs.

  **Phase 3 RESULT (2026-08-26): COMPLETE** — commits 98a89098 (surface + task) and 5c49dca4
  (metrics gauges). `openReadSink`/`sinkCloseBegin`/`sinkWaitExit`/`sinkReleaseBuffer`/
  `sinkStats` on both recv handles; sink task over a testable `SinkSource` seam;
  heartbeat-based stall + opt-in drop-newest idle deadline; SAB ref released only after
  observed task exit. Deviations from the draft worth noting: close is a three-call napi
  sequence (`sinkCloseBegin` → `sinkWaitExit` → `sinkReleaseBuffer`) that the phase-4 TS
  `close(): Promise<void>` wraps — a single async napi close cannot release the reference on
  the JS thread; and `E_SINK_*` codes deliberately bypass the WtCode table (raw reason
  strings). Verified: 324 native tests, TS suite 657/0, tsc, and an end-to-end Bun smoke
  (Worker consumer, byte-exact stream, in-band error codes) archived at
  `.scratch/sink-phase3-smoke-2026-08-26/`.
- **Phase 4 — TS:** `packages/webtransport/src/sink.ts`, `sink-reader.ts` (+ shared layout
  module), streams.ts, portable-native.ts, index.ts.
- **Phase 5 — wasm producer:** wasm-webtransport.ts + `RingWriter`, parity tests.
- **Phase 6 — verification:** port g11 harness pieces, `tools/load/bench-sink.ts`, soak wiring,
  OPERATIONS.md update discharging the "until productized" clause.

  **Phase 6 RESULT (2026-08-26): TOOLING COMPLETE; Linux gates pending dispatch.**
  `tools/load/bench-sink.ts` is a self-contained successor to the g11 harness cell (child-process
  sender, receiver-loop saturator, facade-vs-sink modes, framed send stamps) rather than a port of
  the probe-branch files — the probe branch's `bench-g11.ts` stays unmerged. Local macOS
  indicative run at 90 % receiver-loop saturation, 8 streams × 100 msg/s × 1 KiB: facade p50
  5.16 ms / p99 9.45 ms; sink p50 0.71 ms / p99 2.26 ms (sink ≈ its unsaturated numbers — the
  RFC's core claim reproduced through the public API). `tools/load/soak-sink.ts` churns sinks
  (one long session; ~14.9k sinks / 931 MB drained in a 45 s local smoke) asserting terminals,
  byte counts, `sinksActive` returning to 0, and a flat `SharedArrayBuffer` heap count under
  forced GC (retention truth on macOS — RSS grows by MADV_FREE accounting there, the standing
  local-soak rule). OPERATIONS.md §"Sizing the JS read side" is ported from the probe branch
  (5f7f9c54) with rule 2 discharged: the sink is the supported answer for latency-critical reads
  on a saturated loop.

  **AUTHORITATIVE GATE: PASS (2026-08-26, Linux heavy runner, run 32960345591 @ 6a0d9b81).**
  Dispatched through bench-bandwidth's `sink_gate` mode; 8 streams × 100 msg/s × 1 KiB, 30 s
  cells, ~24.9k samples each:

  | cell | facade p50 / p99 | sink p50 / p99 |
  |---|---|---|
  | idle | 0.46 / 1.46 ms | 0.61 / 0.99 ms |
  | 90 % saturated | 4.80 / **10.30 ms** | 0.60 / **0.97 ms** |

  The saturated sink p99 is statistically identical to its idle profile — the flat-latency
  property this RFC exists to ship, held by `scripts/check-sink-gate.ts` to the 5 ms envelope.
  **Still outstanding:** the 24 h churn soak (run 32960348094, `sink_soak_seconds=86400`,
  soak-labeled runner) — dispatched, verdict follows.

## 11. Risks (ranked; critic-reviewed)

1. **R1 — napi-SAB pointer stability. RESOLVED GO (2026-08-26 spike, §10 Phase 0).** Pointer
   stable across GC, off-thread writes observed losslessly. Mode-B fallback retired.
2. **R2 — mixed-model shared memory.** Rust non-atomic payload writes vs JS plain reads:
   theoretical UB on the Rust side, universal practice for SAB rings, ordered by the
   Release/Acquire cursor pair. Accept; document; revisit only if review tooling objects.
3. **R3 — SAB backing lifetime with a native writer.** Spike (b) + napi ref held until observed
   task exit (§6 teardown). Belt and suspenders.
4. **R4 — doorbell idle CPU at scale** (N parked readers × 2 k wakes/s). Ship 0.5 ms default,
   publish the measured curve, per-reader tunable; fd/addon doorbell as v2 if deployments object.
5. **R5 — block-mode connection-window coupling.** A stalled sink stream consumes its
   connection-level flow-control share and can HoL-pressure siblings. Document; advise ring
   sizing or drop-newest for non-critical streams; no mechanism in v1.
6. **R6 — sink bytes invisible to StreamBudget aggregates.** Exclusion is correct
   (double-charging worse); stats/metrics expose ring usage for dashboard summing.
7. **R7 — view-until-next zero-copy footgun.** Keep (it is the point); `copy: true` escape
   hatch; loud docs.

## 12. Review trail

- Architect design: 2026-08-26 (this session), grounded in `@33b304df` frame_sink.rs +
  client_stream.rs and current staging read path.
- Critic verdict: **APPROVE-WITH-CHANGES**; all findings folded: B1 (client streams bridge
  eagerly → Phase 1 tri-state + universal lazy bridging), B2 (WRAP/terminal reservation → 128 B
  reserve + never-start-within-32B rule + 32 B terminal payload cap), M1 (direct-read race →
  ownership CAS + streamByteOffset base), M2 (teardown UAF → ref release after observed task
  exit), M3 (slow vs dead → heartbeat liveness), M4 (mode B labeled degraded), M5 (g11 harness
  port = Phase 6 deliverable). Minors folded (ERROR payload cap, sub-ms wait spike item, sizing
  rule stated, 1024-cap rationale, W3C errored-stream instead of getter throw).
