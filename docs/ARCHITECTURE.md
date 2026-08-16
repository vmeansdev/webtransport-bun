# ARCHITECTURE.md

## Overview
The addon is implemented in Rust using napi-rs. QUIC/HTTP3/WebTransport is implemented by wtransport. JS/TS code provides:
- ergonomic API
- Node stream wrappers
- error normalization
- tests

## Threading model
- Two dedicated Tokio runtimes, each with an exact constructor contract:
  - **RUNTIME** (`wt-server`), `Builder::new_multi_thread().worker_threads(2)`:
    drives server accept loop, server-side sessions, and stream bridges.
  - **CLIENT_RUNTIME** (`wt-client`), `Builder::new_multi_thread().worker_threads(1)`:
    drives client connections and client-side stream bridges.
- `new_multi_thread` is required for both. Synchronous N-API entry points call
  `Runtime::spawn` without a permanently driven `block_on`; replacing these
  runtimes with `Builder::new_current_thread()` would leave spawned work without
  a continuously driven executor. The two builders provide separate,
  independently driven server and client executors.
- The server runs **two** workers, not for parallelism in the abstract but as
  independent headroom on top of the delivery-path fix described below. Two is
  not proven optimal, and higher is not better: on macOS, two workers delivered
  89,002/s, four delivered 81,682/s, and ten delivered 48,042/s. Nothing here
  justifies `available_parallelism()`. The only Linux host available has 4 vCPU
  and only the one- and two-worker arms were testable on it, so the count is not
  calibrated to production hardware. It is a hardcoded constant with no
  environment override: every measured alternative was worse, so a knob would
  only offer ways to regress.
- The client runtime stays at one worker. Every delivery measurement covers the
  server receive path only; raising the client for symmetry would be an
  unmeasured change.

### Datagram delivery must not hop between runtimes
- `readDatagram`, `sendDatagram`, and per-datagram `discardDatagram` run
  **directly on the N-API runtime** that `Env::spawn_future` provides. They must
  not be wrapped in `RUNTIME.spawn`, and `scripts/check-doc-truth.ts` pins that.
- Dispatching it as `env.spawn_future(async { RUNTIME.spawn(...).await })` was a
  **root-cause availability defect**, not a performance nicety. `RUNTIME.spawn`
  called from the N-API runtime is a spawn from *outside* the server runtime, so
  every delivery landed in that runtime's **injection queue**. A worker reaches
  the injection queue either by running dry — which drains it in bulk — or on a
  tick that takes **exactly one** task, and tokio time-targets that tick at one
  check per 200µs of work. Under sustained load the worker's local queue never
  ran dry, so every delivery trickled through the tick path at ~5,000/s. The
  server ingested datagrams off the wire normally and then discarded 80-95% of
  them, a cliff rather than a ceiling: delivered throughput fell about 10x in
  response to a 2x rise in offered load, with the same floor on macOS and Linux
  despite a 32x difference in receive-path cost — a scheduler policy constant,
  which is exactly why a cheaper receive path never moved it.
- Confirmed by falsifier, not inspection: pinning `global_queue_interval`
  disables tokio's tuner, and `delivered x interval` held constant at
  ~93,000 ± 3% across a 64x span of the knob (2 → 47,930/s, 127 → 726/s).
- Removing the hop is what fixes it: at one worker, 5,266 delivered/s with 95%
  dropped became 84,823/s with none dropped, a 16.1x improvement; at two workers
  it is slightly faster on about 10% less CPU. Two workers alone would only have
  made workers run dry often enough to dodge the tick path, which a busier
  server or a larger session count could undo.
- The hop is safe to delete on those three paths: `read_datagram_for_session`
  only locks a Tokio mutex and receives from a Tokio mpsc; `send_datagram`
  awaits a Notify plus a timer deadline then makes a synchronous quinn call;
  per-datagram `discard_datagram` is the read path plus an optional
  `tokio::time::timeout`. napi-rs's current_thread runtime already has a time
  driver. Measured at one worker: send 5,213 → 55,306/s (echo 15% → 100%);
  discard 5,374 → 83,479/s (94.5% → 0% dropped). Stream open/accept and the
  bulk `discard_datagrams` loop **keep** their hops: opens never bound the
  cadence (~1,530/s either way), and the bulk drain is one spawn then a native
  loop that must not monopolise the JS thread.
- `scripts/check-doc-truth.ts` source-policies both runtime declarations, their
  individual worker counts, and their dedicated thread names, and rejects a
  worker count derived from the environment or from `available_parallelism()`,
  so the documented constructors and the implementation cannot drift silently.
- Isolation prevents same-process deadlock when client and server share a process (e.g. tests).
- All wtransport objects are owned and driven on these runtimes.
- JS calls enqueue commands to the runtimes via bounded channels. Datagram
  read, send, and per-datagram discard are the exception: they run directly on
  the N-API runtime rather than hopping onto the server runtime first.
- Runtimes emit events back to JS via ThreadsafeFunction (TSFN) using batching.

## Object model and lifetimes
- ServerHandle: owns UDP socket and accept loop.
- SessionHandle: created by server accept loop or client connect; owns:
  - datagram send queue
  - datagram recv queue
  - stream accept queues (uni/bidi)
  - stream registry (for shutdown)
- StreamHandle: per QUIC stream; owns:
  - bounded outgoing byte queue
  - bounded incoming byte queue
  - cancellation signals (reset/stopSending)

All handles are ref-counted; runtime keeps the authoritative registry. JS side holds opaque ids.

## Bounded queues and budgets
All buffering must be bounded and accounted for.
- Global budget: maxQueuedBytesGlobal
- Per-session budget: maxQueuedBytesPerSession
- Per-stream budget: maxQueuedBytesPerStream

Rule: before enqueueing a buffer, atomically reserve bytes from budgets. If reservation fails:
- for streams: apply backpressure; if writer exceeds timeout, reset stream / error
- for datagrams: apply backpressure; if exceeds timeout, reject Promise

Release reservation when bytes are dequeued and handed off to wtransport (outgoing) or handed to JS consumer (incoming).

## Event delivery batching (mandatory)
Do not call into JS per packet/frame.
Instead:
- datagrams: batch up to N datagrams per JS tick (e.g., 256), or up to X bytes (e.g., 256 KiB)
- stream reads: batch up to Y bytes per stream per tick (e.g., 128 KiB)

Implementation pattern:
- runtime pushes items into bounded queues
- a single “notifier” triggers TSFN at most once per interval (e.g., every 1–5 ms)
- JS drains queues and feeds Node streams / iterators

## Node stream integration
Streams are exposed as Node streams implemented in JS (recommended):
- JS creates a Duplex/Readable/Writable wrapper with internal native handle id
- On `_write`, JS sends buffers to native via `stream_write(handle, buf)` which reserves budget and enqueues
- On native incoming data, JS pushes into Readable side via `push()`, respecting `highWaterMark`
- If JS consumer is slow, stop pulling from native by not draining the incoming queue; native must stop reading from QUIC when queue is near capacity

## Shutdown ordering (must be deterministic)
1. Server close:
   - stop accept loop
   - close UDP socket
   - close all sessions
2. Session close:
   - stop read/write tasks
   - resolve/reject pending datagram send Promises
   - terminate iterators
   - destroy Node streams (emit errors/end)
3. Runtime shutdown:
   - ensure all tasks join
   - drop registries

No pending Promise may remain unresolved after close.

## Rate limiting and limits enforcement
Before expensive work:
- apply per-IP token buckets for handshake / stream open / datagrams ingress
- apply global caps (maxSessions, maxHandshakesInFlight, maxStreamsGlobal)
- apply per-session caps (max streams per session)
If enforcement fails:
- close with E_RATE_LIMITED or E_LIMIT_EXCEEDED (stable codes)

## Observability
- all drops, limit rejections, backpressure timeouts must increment counters
- metricsSnapshot reads a stable atomic snapshot (no blocking)
