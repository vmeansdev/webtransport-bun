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
    drives server accept loop, server-side sessions, and stream bridges. The
    count is resolved by `server_worker_threads()` rather than written as a
    literal: it is 2 unless `WEBTRANSPORT_NATIVE_SERVER_WORKERS` names another
    integer in 1..=8; any other value logs one warning and falls back to 2.
    That override is an unsupported internal knob for measurement-campaign A/B
    runs only — 2 stays the shipped default, because every alternative
    measured worse (macOS: 89k/s at two, 82k/s at four, 48k/s at ten). The
    effective value is readable through the internal
    `__TESTING__.serverInternals(server).serverWorkerThreads()`.
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
  calibrated to production hardware. The default is a constant, and the only
  override is the unsupported `WEBTRANSPORT_NATIVE_SERVER_WORKERS` campaign
  knob described above: every measured alternative was worse, so there is no
  supported way to change it.
- The client runtime stays at one worker. Every delivery measurement covers the
  server receive path only; raising the client for symmetry would be an
  unmeasured change.

### Other native threads

Besides the two runtimes, the addon can run these threads. Only the first is
always present; the others exist only when their feature is in use:

- **napi-rs's async runtime**, which drives every `Env::spawn_future` call:
  the per-datagram read, batch read, send and discard paths below, and the
  stream read group's `next()`.
- **`wt-egress-pacer`**: one OS thread per process, started on first use of
  the experimental egress pacer (`ServerOptions.egressPacer` or
  `WEBTRANSPORT_PACER_PPS`). It owns the paced-mirror schedule.
- **`wt-quic-recv-<serverId>`**: one current-thread runtime on its own OS
  thread per server, only with the unsupported
  `WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME=dedicated` knob. It runs quinn's
  endpoint driver (UDP receive) off the `wt-server` workers.
- **`wt-udp-send-batch`**: the cross-connection `sendmmsg` flusher, only with
  the unsupported `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH` knob.
- **`wt-reflect-sender`**: one OS thread per process that sends the internal
  datagram reflector's replies, started on the reflector's first use. The
  reflector is reachable only through `__TESTING__.serverInternals`.

### Datagram delivery must not hop between runtimes
- `readDatagram`, `readDatagramBatch`, `sendDatagram`, and per-datagram
  `discardDatagram` run **directly on the N-API runtime** that
  `Env::spawn_future` provides. They must not be wrapped in `RUNTIME.spawn`,
  and `scripts/check-doc-truth.ts` pins that.
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
- The hop is safe to delete on those four paths: `read_datagram_for_session`
  and `read_datagram_batch_for_session` only lock a Tokio mutex and receive
  from a Tokio mpsc; `send_datagram` awaits a Notify plus a timer deadline then
  makes a synchronous quinn call; per-datagram `discard_datagram` is the read
  path plus an optional `tokio::time::timeout`. napi-rs's current_thread
  runtime already has a time driver. Measured at one worker: send
  5,213 → 55,306/s (echo 15% → 100%); discard 5,374 → 83,479/s (94.5% → 0%
  dropped). Stream open/accept and the bulk `discard_datagrams` loop **keep**
  their hops: opens never bound the cadence (~1,530/s either way), and the bulk
  drain is one spawn then a native loop that must not monopolise the JS thread.
- `scripts/check-doc-truth.ts` source-policies both runtime declarations, their
  individual worker counts, and their dedicated thread names. It rejects a
  worker count derived from `available_parallelism()`, and pins the server
  resolver's default of 2, its `1..=8` bound on the environment override and
  its warn-and-fall-back handling of a bad value, so the documented
  constructors and the implementation cannot drift silently.
- Isolation prevents same-process deadlock when client and server share a process (e.g. tests).
- All wtransport objects are owned and driven on these runtimes.
- JS calls enqueue commands to the runtimes via bounded channels. Datagram
  read, batch read, send, and per-datagram discard are the exception: they run
  directly on the N-API runtime rather than hopping onto the server runtime first.
- Data reaches JS by pull, not push (see "Event delivery batching" below).
  ThreadsafeFunctions (TSFN) carry control events only, batched where they can
  arrive in bursts: server session events, client connect results and close
  notifications, and `log` hook events. Datagram and stream payloads never
  travel through a TSFN.

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
Do not call into JS per packet/frame. The native side never calls into JS to
deliver data: it fills bounded queues, and JS pulls from them, so a slow
consumer is backpressure by construction.

- **Datagrams:** the session's `incomingDatagrams()` iterator calls the
  addon's `readDatagramBatch(max)`, which resolves with up to
  `WEBTRANSPORT_DATAGRAM_BATCH` (default 64, at most 256) queued datagrams per
  Node-API crossing; `WEBTRANSPORT_DATAGRAM_BATCH=0` falls back to one
  `readDatagram()` per datagram. See `docs/SPEC.md`, "Incoming datagram
  delivery".
- **Server stream reads:** one process-level read group serves every
  server-accepted stream. JS grants each stream read credit, and one
  `next(maxEntries)` crossing returns the queued chunks of every stream that
  has credit (at most 4096 entries and 1 MiB). Client streams, and every
  stream with `WEBTRANSPORT_STREAM_READ_GROUP=0`, pull per stream instead. See
  `docs/SPEC.md`, "Incoming stream chunk delivery".
- Nothing is read from QUIC for a queue that is full: the byte budgets below
  are reserved at ingest, so an unread queue leaves the rest in the transport
  under QUIC flow control.

## Node stream integration
Streams are exposed as Node streams implemented in JS:
- JS creates a Duplex/Readable/Writable wrapper around an opaque native handle id
- `_write` calls the handle's Node-API `write(chunk)`, which reserves budget and
  enqueues; it waits (backpressure) while the budget is full
- `_read` pulls the next chunk (through the read group or the handle's own
  read) and `push()`es it, so `highWaterMark` decides how far ahead JS reads
- A slow JS consumer stops pulling; native stops reading from QUIC once that
  stream's budget is reserved

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
