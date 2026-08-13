# Stream read-side retention fix — plan (2026-08-13)

## Problem (proven, not hypothesized)

Streams abandoned mid-read permanently retain their `ClientBidiStreamHandle`
(and uni equivalents): the JS `read()` napi async call never settles, so the
napi self-reference protects the handle across session close and full GCs.
Post-teardown double-full-GC forensics: **117,482 protected
`ClientBidiStreamHandle`** after a 10-min stream-heavy soak (~1 JS wrapper
Object + ~1.2KB native state each). On the 1-vCPU CI soak box, handler
timeouts abandon a fraction of streams continuously → the ~50–100MB/h
committed-memory ratchet that failed three 2h soak gates.

Root mechanism: the receive-side budget wait added by 32efbcb (issue #15 fix)
at `crates/native/src/client_stream.rs` (~1759 bidi, ~1853 uni) is:

```rust
while !b.try_reserve(sz) {
    // select: capacity_notify | 1ms sleep | stop_rx
}
```

- No timeout (write side has `backpressure_timeout_ms`; read side doesn't).
- No session-close signal (`stop_rx` fires only on explicit JS stopSending).
- Abandoned stream's queued `StreamChunk`s hold budget reservations forever →
  capacity never frees → loop spins at 1ms forever (CPU burn too).

Secondary defect (found during forensics, separate mechanism): native
response-channel delivery failures (`report_channel_failure`) can strand a JS
deferred that never settles. Every stranded deferred = a permanently retained
async-closure graph.

## Fix

### F1 — Bound the receive-side budget wait (core fix)

[ARCHITECT-CORRECTED] In all THREE recv wait loops:
- `client_stream.rs:1759` — shared deferred/lazy recv bridge
  (`ensure_deferred_read_bridge` :828; also server-accepted deferred handles
  via lib.rs:1006),
- `client_stream.rs:1853` — eager bidi `spawn_bidi_bridge_on` (client.rs
  :815/:888; server create_bidi lib.rs:1189),
- `client_stream.rs:2128` — uni recv (client.rs:924; lib.rs:1117),

replace the unbounded `while !try_reserve` select-loop with the bounded
semantics the write side has: `reserve_or_wait()` (cancel-safe, composes via
an outer `select!` against `&mut stop_rx` — architect-verified; no explicit
deadline variant needed). On expiry:

1. `recv_stream.stop(0)` (same signal pre-32efbcb behavior used),
2. set `read_error_slot` to `E_BACKPRESSURE_TIMEOUT` (documented code, same
   as the write side),
3. break the bridge loop → `read_tx` sender drops → pending JS `read()`
   settles (error or EOF-with-error-slot) → napi ref released → handle,
   wrapper, chunks, and budget all free.

Increment the existing `backpressure_wait_count` / `backpressure_timeout_count`
metrics on this path (they exist and are wired).

Semantics note (intentional behavior change, mirrors write side): a reader
that frees no capacity for a full `backpressureTimeoutMs` (default 5000ms)
while the per-stream budget is exhausted now gets the stream stopped with
`E_BACKPRESSURE_TIMEOUT`, instead of waiting forever. A slow-but-alive reader
that consumes anything within the window keeps the stream. Configurable via
`limits.backpressureTimeoutMs` at both ends.

### F2 — SKIPPED (architect ruling)

No close signal is in scope at the deferred-bridge spawn sites (:828, :1479
— spawned from the handle, which holds no session watch); plumbing would add
constructor params across client.rs/lib.rs/server paths. F1 bounds teardown
latency to `backpressureTimeoutMs` (5s default) — document that instead.

### F3 — DOWNGRADED to audit-only (architect ruling)

Every `report_channel_failure` site fires when `resp_tx.send()` fails, i.e.
the JS awaiter is already gone (client.rs:836/870/907/939; lib.rs:1155-1282)
— nothing strands. The inverse (sender dropped unsent) already maps
`RecvError` → `E_SESSION_CLOSED` (client.rs:614-666). No code change unless
implementation turns up an actual never-settling await; then fix that site.

### F3b — Truthful comments and docs (architect addition)

The "lossless backpressure" comments at client_stream.rs:1849-1865 and
:2119-2126 (and any doc claiming lossless read-side parking; check
`internal-doc-truth.test.ts`) become false under F1 — rewrite them to state
the bounded-wait semantics.

### F4 — Regression falsifier (test)

EXTEND the existing `packages/webtransport/test/stream-retention.test.ts`
(architect: it already exists — do not create a parallel file): open N bidi streams
server→JS, write payloads exceeding `maxQueuedBytesPerStream`, abandon the JS
readers (no read, no cancel), wait > `backpressureTimeoutMs`, force
`Bun.gc(true)`, then assert via `bun:jsc getProtectedObjects()` that no
stream-handle class instances remain protected (small tolerance for
in-flight), and that abandoned reads reject with `E_BACKPRESSURE_TIMEOUT`.
Must FAIL against the current build (verify by revert-run) and PASS with F1.

## Verification

1. `cargo clippy` + full `bun test` (native 131+/packages 470+/wasm suites) +
   `tsc --noEmit`.
2. F4 falsifier: red on pre-fix build, green on post-fix.
3. Local stream-heavy soak (50 sess / 50 dgram / 20 streams, 10 min,
   `SOAK_PROTECTED_DUMP=1`): protected `ClientBidiStreamHandle` ≈ 0 post-GC
   (was 117k). Error-rate phase gates may still fail locally at saturation —
   retention is the acceptance signal here, not the verdict.
4. CI 2h dedicated soak at the new candidate: expect committed drift bounded
   (flat-ish baseline phases) and verdict PASS. This is the gate that failed
   3×; it is the end-to-end acceptance test.
5. On PASS → rebind №5 → 24h dedicated (existing release pipeline).

## Out of scope

- Guard recalibrations (fd-slope deadband, session-recovery tolerance,
  committed-drift margin): separate user decisions, likely moot once the
  ratchet is gone.
- soak-addon handler behavior: abandoning streams on timeout is an
  intentional hostile-consumer simulation; the library must tolerate it.
- H7 batch delivery, upstream Bun report: unchanged queue.

## Files expected to change

- `crates/native/src/client_stream.rs` (both recv bridges; possibly
  `StreamBudget::reserve_or_wait` reuse)
- `crates/native/src/client.rs` / `lib.rs` (F3 audit sites, only where a
  deferred can strand)
- `packages/webtransport/test/` or `tools/load/` (F4 falsifier)
- Docs: error-code table already documents `E_BACKPRESSURE_TIMEOUT`; add the
  read-side case where write-side timeout is documented.

## Implementation deviation (2026-08-13, disclosed)

**F4 unit falsifier dropped after 8 design iterations**: the bridge-park is
not deterministically reachable through public APIs on a fast machine — the
W3C facade serializes reads (no overlapping native read()s → no bridge
spawn), the deferred direct-read path is already bounded, and every
starvation constellation hit QUIC connection-window exhaustion (session
budget doubles as the window) before budget-parking, stalling stream opens
instead. The regression instrument for this defect is the **soak-level
protected-object dump** (`SOAK_PROTECTED_DUMP=1`, committed at cc6dcd2):
red baseline recorded pre-fix (117,482 pinned `ClientBidiStreamHandle`
after the 10-min stream-heavy soak), green criterion = same soak on the
fixed build with protected count ≈ 0. The new timeout path was additionally
observed firing organically (`E_BACKPRESSURE_TIMEOUT` surfaced during test
prototyping under saturation).

## Critic-review corrections applied (2026-08-13)

1. **F4 redesigned as hog+victim** (as-specified would be green pre-fix: the
   protection needs a PENDING read() on an EMPTY channel — :894-937): N hog
   streams fill the session budget with unread chunks; M victim streams each
   hold one pending `read()`; victims must reject `E_BACKPRESSURE_TIMEOUT`;
   assert `getProtectedObjects` (constructor-name filtered, macrotask settle
   + double `Bun.gc(true)` — napi ref release rides a TSFN tick) AND the
   native `live_native_stream_handles()` counter (:267). Revert-run
   red-green proof mandatory.
2. **Fast-path budget release verified required**: `StreamChunk::Drop`
   (:397-405) + `dispose_resources` (:850-876) free promptly when a read
   errors via `BidiStream._read` → `destroy(err)` → `dispose()`
   (streams.ts:128-133,:207); MUST verify the W3C facade path also reaches
   destroy/dispose on the new rejection ("until GC" is not a safe backstop
   in this project). Add `queuedBytesGlobal` as a budget-leak canary in soak
   analysis.
3. `reserve_or_wait` cancel-safety CONFIRMED (:290-311); do not re-poll
   `&mut stop_rx` after it completes (oneshot panics) — preserve the
   immediate-break pattern (:1768-1778).
4. **Unbounded `read_tx.send(chunk).await` (:1782, :1883) is a second
   park-forever path** (256 tiny chunks fill the channel below budget) —
   bound it with a stop_rx select (chunk drop on stop releases budget via
   StreamChunk::Drop) or document; bounding chosen.
5. Doc-truth sweep for "lossless" beyond the two comment blocks (e.g.
   docs/HARDENING_PLAN_2026-07.md:13; SPEC/AGENTS/README;
   internal-doc-truth.test.ts).
6. Accepted risks acknowledged: 1-vCPU event-loop stalls >5s at full budget
   now kill healthy streams (the #15 tension — 5s defensible, untested at
   saturation; CI soak may fail error-rate gates for this new reason);
   abandoned no-pending-read streams still pin ≤256KB each until organic GC
   (pre-existing, now bounded); `E_BACKPRESSURE_TIMEOUT` maps to
   `TimeoutError` (w3c-client-options.ts:55) and is in the ErrorCode union.

## Architect-review corrections applied (2026-08-13)

- Three wait loops, not two (:1759 shared deferred, :1853 eager bidi, :2128
  uni); poll interval is 50ms (`BUDGET_POLL_INTERVAL` :196), not 1ms.
- Release chain verified: bridge break → `read_tx` drop → `rx.recv()` None →
  error slots (:913-935, deferred slots :843-846/:1494-1497) → promise
  settles → napi ref released. Buffered chunks keep budget reserved until
  wrapper GCs — acceptable.
- Bonus fixed by F1: a parked deferred bridge pins one of 64 global
  `DEFERRED_READ_BRIDGES` permits (:255-257) — current bug can starve ALL
  deferred reads process-wide.
- Behavior risk reviewed: deadline is per-chunk reservation; slow-but-alive
  readers consuming anything within the window keep the stream. Check
  `backpressure.test.ts` (:240-390) and `parity-streams.test.ts` for
  assertions of indefinite parking.
