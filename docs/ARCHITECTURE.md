# ARCHITECTURE.md

## Overview
The addon is implemented in Rust using napi-rs. QUIC/HTTP3/WebTransport is implemented by wtransport. JS/TS code provides:
- ergonomic API
- Node stream wrappers
- error normalization
- tests

## Threading model
- Two dedicated Tokio runtimes, each with 1 worker thread:
  - **RUNTIME** (`wt-server`): drives server accept loop, server-side sessions, and stream bridges.
  - **CLIENT_RUNTIME** (`wt-client`): drives client connections and client-side stream bridges.
- Isolation prevents same-process deadlock when client and server share a process (e.g. tests).
- All wtransport objects are owned and driven on these runtimes.
- JS calls enqueue commands to the runtimes via bounded channels.
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
