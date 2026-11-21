# Bulk transfer, VOD and stream egress

This guide is for servers that push large amounts of reliable data to clients:
file and asset downloads, video-on-demand segments, model weights, and
long-lived streams of small writes such as AI token output. It is backed by
two campaign gates: **G5** (bulk / VOD throughput) and **G7** (stream egress).
The full measurement table, with hardware for every figure, is in
[CAPACITY.md](../CAPACITY.md).

## Workload this guide is proven for

| Direction | Rate | Payload | API |
|---|---|---|---|
| Bulk / VOD, server → client (G5) | paced offer of 1.25 Gbps | reliable stream data | stream writes |
| Stream egress, server → client (G7) | 1.2498 Gbps delivered | 16 streams × 64 KiB writes | stream writes |
| Token streaming, server → client (G7) | 1,000 sessions | small streamed writes | stream writes |
| 1 KiB writes, server → client (G7, originator-bound cell) | 152,588 writes/s offered, ~63.3k/s sourced | 1 KiB writes | stream writes |

The summary this guide was written from does not say which stream type
(uni or bidi, or which side opened it) the gates used, or the G5 cell's
stream count and write size. Check [CAPACITY.md](../CAPACITY.md) before you
assume they match the example.

The [example](../../examples/scenarios/bulk/) reproduces the G7 egress shape (16 streams, 64 KiB writes):
one session asks for N transfers, and the server sends each one on its own
unidirectional stream in 64 KiB writes.

## What was measured

All four figures below come from the **home rig**: a 4-core / 8-thread
bare-metal Linux box with ~12 GB of RAM and the performance governor, with
the load generator and the server on the same box over loopback. A
per-process cost measured that way is an upper bound of unknown tightness,
because the generator's share of the box was never measured.

| Gate | Result |
|---|---|
| G7 stream egress | **PASS.** **1.2498 Gbps** at 16 streams × 64 KiB writes. The byte and stream ledgers were exact. Client receive-socket drops were 0 in all 14 cell-repeats |
| G7 token sessions | One-way p99 **5.112 ms** across 1,000 sessions of small streamed writes, in the same run (**4.16 ms** on the rerun) |
| G7 host CPU | Highest host CPU median in the run: **79.1%**, on the 1 KiB-write cell, not the 64 KiB one |
| G7 1 KiB writes | Originator-bound: one JS thread sourced **~63.3k writes/s** at 1 KiB and could not reach the **152,588/s** it was offered |
| G5 bulk / VOD (graded) | **PASS.** **1.2505 Gbps** delivered against a 1.000 Gbps bar: **100.037%** of a paced 1.25 Gbps offer, **42,599 B** per JS↔native crossing, host CPU median **34.3%**. Graded with the experimental stream-chunk batching knob on (`WEBTRANSPORT_STREAM_BATCH_BYTES`, see [Server configuration](#server-configuration)) |
| G5, knob off (disclosed, not graded) | **1.1473 Gbps**, 91.6–92.0% of the offer, at **73.8%** host CPU |

What the two G5 arms show: with batching on, the run delivered more
(1.2505 against 1.1473 Gbps; the knob-off cell sourced only 91.6–92.0% of
the offer) at under half the host CPU (34% against 74%). The graded cell
measured 42,599 B per crossing into JavaScript. The batching knob is
experimental and off by default.

### Not proven

- **Anything over a real network.** Every figure here is loopback on one box.
  On loopback the bandwidth-delay product is tiny, so the flow-control windows
  barely matter. Over a WAN they decide single-stream throughput (see
  [Flow-control windows](#flow-control-windows-and-memory)).
- **An unpaced G5 run with raised windows.** One was made and is not a
  licensed result; no figure from it is quoted anywhere.
- **`congestionControl`.** `"throughput"` (BBR) and `"low-latency"` (NewReno)
  exist, but no campaign figure compares them with the default Cubic for this
  workload. Treat them as options to evaluate on your own path.
- **More than one process, or a separate client machine.** The ceiling here is
  per box, not per fleet.
- **Uploads (client → server bulk).** The gates measured server egress.
- **The batching knob's value.** The value used for the graded G5 cell is not
  in the summary this guide was written from, and neither is whether it was
  set on one process or on both.

## Architecture

The client opens one bidirectional **control** stream, writes a small JSON
request (`streams`, `bytesPerStream`, `chunkBytes`) and closes its write
side. For each transfer the server opens a **unidirectional** stream, writes a
4-byte index and then the payload, and ends the stream. When every transfer
has finished, the server answers on the control stream with a summary
(bytes sent, stream errors by code) and closes it. The client closes its
session only after it has read that summary.

```
client                                           server
  |  control (bidi): {"streams":16,...} + FIN  ---> |  validate, open 16 uni streams
  |                                                 |
  |  <--- uni #0:  [index][64 KiB][64 KiB]... FIN   |  write(); on false, wait 'drain'
  |  <--- uni #1:  [index][64 KiB][64 KiB]... FIN   |  end(); 'finish' = client ACKed
  |  <--- ...                                       |
  |  <--- uni #15                                   |
  |                                                 |
  |  <--- control: {"bytesSent":...} + FIN          |  after all 16 have finished
  |  close session                                  |
```

Why this shape:

- **A stream request, not a datagram.** The request must arrive, and the
  client needs to hear when the server is done. A datagram request would need
  its own retry logic, and a datagram cannot carry the completion signal
  reliably. The control stream carries a few hundred bytes, so the shared-budget
  issue described in [Pitfalls](#pitfalls) does not touch it.
- **Unidirectional streams for the bulk.** Each transfer is independent, so a
  lost packet on one stream does not stall the others. A uni stream also has
  no reverse half sharing its byte budget (see [Pitfalls](#pitfalls)).
- **A summary before close.** On the server, a stream's `end()` completes only
  when the client has acknowledged every byte. Holding the session open until
  the summary arrives means no transfer is cut off by the client's close.

The client checks each stream's length, plus a sample of its bytes against a
pattern that depends only on the stream index and the offset: every 509th
byte, plus the last byte of every chunk it receives. That catches a lost,
repeated or misordered chunk for a few thousand comparisons per GiB. Checking
every byte in JavaScript would cost more than receiving it, and QUIC's AEAD
already rules out corruption on the wire.

## Run the example

From the repository root, with the native addon built (`bun run build:native`):

```bash
bun examples/scenarios/bulk/server.ts --port=4433
```

In a second terminal, one session downloading 16 × 64 MiB in 64 KiB writes
(the defaults):

```bash
bun examples/scenarios/bulk/client.ts --url=https://127.0.0.1:4433
```

Flags:

| Process | Flag | Default | Meaning |
|---|---|---|---|
| client | `--streams` | 16 | transfers (uni streams) per session |
| client | `--bytesPerStream` | 67108864 | payload bytes per stream |
| client | `--chunkBytes` | 65536 | server write size; the server refuses a request above its `maxQueuedBytesPerStream` |
| client | `--sessions` | 1 | concurrent sessions, each running one transfer of `--streams` streams |
| client | `--seconds` | 120 | upper bound on the whole run |
| both | `--maxQueuedBytesPerStream`, `--maxQueuedBytesPerSession` | 0 (library default) | byte governors, and through them the flow-control windows |
| server | `--congestionControl` | `default` | `default`, `throughput` or `low-latency` |
| server | `--host` | `0.0.0.0` | bind address |

The first run generates a throwaway CA and certificate in
`examples/scenarios/.certs/`. Both processes use it, and the client verifies
the server against it. To use a real certificate, set `CERT_PEM`, `KEY_PEM`
and (for the client) `CA_PEM` to file paths. The server prints its counters
every 5 seconds. The client prints a report when it finishes:

```json
{
  "sessions": 1,
  "connectFailures": 0,
  "streamsRequested": 16,
  "streamsCompleted": 16,
  "bytesExpected": 1073741824,
  "bytesReceived": 1073741824,
  "patternMismatches": 0,
  "errors": {},
  "elapsedMs": 6543.2,
  "gbps": 1.3128,
  "perStreamMsP50": 5559.93,
  "perStreamMsP99": 6515.89,
  "perStreamMsMax": 6515.89,
  "serverBytesSent": 1073741824,
  "serverStreamErrors": {}
}
```

That sample comes from an Apple M1 Max (10 cores, 64 GB, macOS), with both
processes on the same machine and a 1-minute load average of about 9 from
other work. It shows the example working (every byte accounted for on both
sides), not a capacity figure; earlier runs of the same command at a load
average near 30 gave 1.12–1.14 Gbps. On the same machine,
`--sessions=100 --bytesPerStream=262144` (1,600 streams) completed every
stream in three runs at 0.98–1.09 Gbps. At `--sessions=200` (3,200 streams
read by one client process), about half the runs lost one to three streams
to `E_BACKPRESSURE_TIMEOUT`; see [Pitfalls](#pitfalls).

To try the experimental batching knob, set it on the process that **reads**
the bulk data. For a download, that is the client:

```bash
WEBTRANSPORT_STREAM_BATCH_BYTES=262144 bun examples/scenarios/bulk/client.ts --url=https://127.0.0.1:4433
```

## Server configuration

```ts
import { createServer } from "@webtransport-bun/webtransport";

const server = createServer({
  port: 443,
  tls: { certPem, keyPem }, // server takes cert + key only; caPem throws E_TLS
  limits: {
    // Byte governors. Bytes queued across the JS boundary count against all
    // three; a full budget makes writes wait (backpressure). Defaults:
    // 256 KiB per stream, 2 MiB per session, 512 MiB global.
    maxQueuedBytesPerStream: 256 * 1024,
    maxQueuedBytesPerSession: 2 * 1024 * 1024,
    maxQueuedBytesGlobal: 512 * 1024 * 1024,
    // QUIC windows (native only). Unset, they are derived from the governors
    // above. Set them to widen the transport without loosening the governors;
    // budget the memory first (next section).
    // streamReceiveWindow: 4 * 1024 * 1024,
    // receiveWindow: 16 * 1024 * 1024,
    // sendWindow: 16 * 1024 * 1024,
    // A write that waits on a full budget for this long fails with
    // E_BACKPRESSURE_TIMEOUT and the stream is reset: this is what sheds a
    // client that stops reading.
    backpressureTimeoutMs: 5000,
    // Caps the transfers one session can have open at once.
    maxStreamsPerSessionUni: 200,
    // Pick this against the per-session memory ceiling, not the default.
    maxSessions: 500,
  },
  // Option to evaluate, not a proven win: no campaign figure for this workload.
  congestionControl: "default", // or "throughput" (BBR), "low-latency" (NewReno)
  onSession,
});
```

The stream-open rate limit (`rateLimits.streamsPerSec`, default 200/s per
peer IP, burst 400) applies to streams the **peer** opens. In this design
that is one control stream per request; the server's own uni streams do not
count against it. The example's CLI server raises the per-IP handshake and
stream buckets, because a load test runs every client from one IP. In
production, size them for the most clients you expect behind one NAT.

`WEBTRANSPORT_STREAM_BATCH_BYTES` is an environment variable, not an option.
It changes how received stream data crosses into JavaScript: one crossing
carries everything already queued for a stream, up to the given number of
bytes, instead of one transport chunk. It is **experimental and off by
default**. Unset, invalid or non-positive means off. Positive values are
clamped to 1 MiB in JavaScript and again in native to the per-stream receive
window (`maxQueuedBytesPerStream`), since a budget above the window can never
be filled. It is read once at module load. It changes chunk sizes and nothing
else: FIN, RESET and STOP_SENDING are never merged into a batch, and byte
accounting is unchanged (docs/SPEC.md,
[Incoming stream chunk delivery](../SPEC.md#incoming-stream-chunk-delivery)).
It is damping, not prevention: a reader that is keeping up gains nothing,
because there is nothing queued to coalesce (docs/OPERATIONS.md,
[Sizing the JS read side](../OPERATIONS.md#sizing-the-js-read-side-stream-tail-latency)).

### Flow-control windows and memory

Two things bound memory, and they are easy to confuse
([OPERATIONS.md, Flow-control windows](../OPERATIONS.md#flow-control-windows)):

- the **byte governors** (`maxQueuedBytesGlobal` / `PerSession` /
  `PerStream`) count bytes queued across the JS boundary and drive
  backpressure;
- the **QUIC windows** (`streamReceiveWindow`, `receiveWindow`, `sendWindow`)
  are what the transport advertises to the peer, and so how much data can be
  in flight.

Left unset, `streamReceiveWindow` follows `maxQueuedBytesPerStream`, and both
connection windows follow `maxQueuedBytesPerSession`. For a download, the
client's receive windows bound what the server may have in flight, and the
server's `sendWindow` bounds its unacknowledged bytes. Raise both sides
together. The example takes the same `--maxQueuedBytesPerStream` and
`--maxQueuedBytesPerSession` flags on both processes.

The per-session worst case is

```
receiveWindow + sendWindow + datagramChannelCapacity × maxDatagramSize
datagramChannelCapacity = min(2048, ceil(maxQueuedBytesPerSession / maxDatagramSize))
```

and `maxQueuedBytesGlobal` does **not** bound it. Worked numbers:

| config | per session | sessions that fit 8 GB |
|---|---|---|
| defaults (256 KiB stream, 2 MiB session) | 6.0 MiB | 1,365 |
| `maxQueuedBytesPerStream` 4 MiB, `maxQueuedBytesPerSession` 16 MiB | 16 + 16 + 2.34 = 34.3 MiB | 238 |
| windows set directly to 4 / 16 / 16 MiB, governors at default | 16 + 16 + 2.0 = 34.0 MiB | 240 |

The two raised rows reach the same ceiling. The second keeps the governors,
and with them backpressure and the datagram budget, where they were. Nothing
is allocated up front: a window is a ceiling that a peer has to drive you to.
It is still the only bound the transport gives you, so choose `maxSessions`
against it.

Raise windows **for throughput on a long path**, when you measure a sender
stalled on flow control. Loopback has almost no bandwidth-delay product, so a
loopback test shows you the cost of a wider window, not its benefit
([OPERATIONS.md](../OPERATIONS.md#flow-control-windows) records a 4 vCPU
loopback curve). Do **not** raise the 2 MiB per-session or 512 MiB global
governors just to make drops or timeouts go away. They exist to shed readers
that fall behind, and raising them hides the slow reader instead of fixing
it.

## Host tuning

The gates ran over loopback, and the summary this guide was written from does
not record kernel buffer settings for the home rig. The campaign's cloud rigs
used these UDP buffer settings on both server and generator hosts. They are
the starting point for any deployment where packets leave the box:

```bash
sudo sysctl -w net.core.rmem_max=26214400 net.core.wmem_max=26214400 \
  net.core.rmem_default=26214400 net.core.wmem_default=26214400 \
  net.ipv4.udp_rmem_min=26214400 net.ipv4.udp_wmem_min=26214400
```

GSO and GRO were active (64 segments) on the standard bind path, with no
send-buffer errors. Watch
`nstat -az | grep -E 'Udp(RcvbufErrors|SndbufErrors|InErrors)'` (or
`netstat -su`) on both ends. A rising `SndbufErrors` on the server means the
kernel is refusing your egress, and the fix is not in the application.

## Scaling out

One process's JavaScript thread does every `write()` on the server and every
read on the client. At 1 KiB writes, that thread capped G7 at ~63.3k
writes/s. The fix is bigger writes first, then more processes, not a bigger
box. A loaded instance costs well over one core and probably under three.

When one process is not enough, run N independent processes, each on its own
port or address. Hand each client the exact URL through DNS or through
whatever already tells it what to download (a manifest, a playlist, a
token service). Do not put a 4-tuple-hash balancer (plain `SO_REUSEPORT`,
ECMP) in front of long-lived sessions: a client address change then stalls the
session until its idle timeout. Sharing one port across processes takes
`reusePort` + `quicLb` + `reusePortSteering` with the eBPF CID steering
program (Linux, experimental). See [deployment.md](./deployment.md) and
[quic-lb.md](../quic-lb.md).

The same rule applies to clients. One client process reading thousands of
streams saturates its own JS thread before the server is busy. That is what
the example's 200-session failures above show.

## What to watch

| Signal | Where | What it tells you |
|---|---|---|
| `streamsActive` | `webtransport_streams_active` | open transfers; compare with `maxStreamsPerSessionUni` × sessions |
| `queuedBytesGlobal` | `webtransport_queued_bytes_global` | bytes waiting on slow readers; alert below `maxQueuedBytesGlobal` (OPERATIONS.md alerts at 80%) |
| `streamOpenLatency` | `webtransport_stream_open_latency_seconds` | stream open p99; the SLO in METRICS.md is < 20 ms |
| `limitExceededCount`, `rateLimitedCount` | `webtransport_limit_exceeded_total`, `webtransport_rate_limited_total` | admission refusals and rate-limited sessions or streams |
| `session.metricsSnapshot().queuedBytes` | per session, not exported | which session is backing up |
| `nativeUniSendHandlesLive` | `metricsSnapshot()` only | leak gauge: should return to idle after load stops |
| stream write failures by code | **your own counter** | see below |

`backpressureTimeoutCount` (`webtransport_backpressure_timeout_total`) counts
**datagram** send timeouts only (docs/METRICS.md). A stream write that times
out with `E_BACKPRESSURE_TIMEOUT` does not appear in it. Count stream failures
yourself, by error code, where you write. The example server does this: its
5-second log line and each summary carry `streamErrors` keyed by code.

## Pitfalls

- **Write large chunks.** Each `write()` is a crossing from JavaScript into
  the addon, and one JS thread sourced only ~63.3k writes/s at 1 KiB. At
  64 KiB the same thread is far from that limit. If your source produces small
  pieces (tokens, log lines), coalesce them into larger writes unless the
  latency of each piece is the point.
- **Honour `write()` returning `false`.** Wait for `'drain'` before writing
  more. A stream hands the addon one chunk at a time, and everything behind it
  sits in the Node `Writable`'s own buffer in JavaScript. The library's byte
  governors do not see that buffer, so a producer that ignores `false` grows
  it without bound.
- **Make the `'drain'` wait fail when the stream dies.** A write to a
  destroyed stream also returns `false`, and its `'close'` has already fired.
  A bare `once(stream, "drain")` then waits forever. The example's `drained()`
  rejects on `'error'`, on `'close'`, and immediately on an already-destroyed
  stream.
- **Prefer unidirectional streams for bulk.** There is a known, tracked open
  issue: one per-stream byte budget (`maxQueuedBytesPerStream`, 256 KiB by
  default) is shared by both directions of a **bidirectional** stream. An echo
  in which one side queued ~1 MiB in 16 KiB writes before the echo was drained
  stalled with `E_BACKPRESSURE_TIMEOUT` at ~55 KB; the same echo in 1 KiB
  writes passed. A uni stream has no reverse half competing for its budget.
- **Keep each write within `maxQueuedBytesPerStream`.** Writes larger than the
  per-stream budget used to fail with `E_BACKPRESSURE_TIMEOUT`. This is fixed
  after rc.5 (PR #22) by splitting them into budget-sized pieces. The example
  server refuses a `chunkBytes` above its per-stream budget, so it behaves the
  same on either side of that fix.
- **Do not close straight after EOF.** On the sending side, `end()` (the
  `'finish'` event) completes only when the peer has acknowledged every byte,
  FIN included. A receiver that reads to EOF and closes its session at once
  can beat that acknowledgement. The sender then sees `E_STREAM_RESET` for a
  stream that was fully delivered. Have the sender say "done" in-band, as the
  example's summary does, and close after that.
- **Wait for `session.closed` before a process exits.** If a client calls
  `close()` and exits immediately, the close may never be sent, and the
  server keeps the session until `idleTimeoutMs` (60 s by default). In this
  example's own runs, before its client waited on `closed`, 247 sessions
  lingered on the server for about a minute after the client processes had
  exited.
- **A slow reader loses its transfer.** If the client stops draining, the
  server's writes wait on the full budget. After `backpressureTimeoutMs`
  (5 s) they fail with `E_BACKPRESSURE_TIMEOUT`, the stream is destroyed, and
  the client sees `E_STREAM_RESET`. That is the bounded-memory contract
  working, not a bug. It is what happened in this example when one client
  process read 3,200 streams at once: about half the runs lost one to three
  streams, while the global queue peaked near 390 MB. Spread readers across
  processes, cap streams per session, or make the client resume (request the
  missing byte range on a new stream) rather than raising the timeout.
- **Per-session stream caps apply on both sides.** Both sides enforce
  `maxStreamsPerSessionUni` (200 by default; the client side since PR #22),
  which limits how many transfers can be open at once. Opening
  beyond it rejects with `E_LIMIT_EXCEEDED`, or waits with
  `createUnidirectionalStream({ waitUntilAvailable: true })`, which times out
  after `backpressureTimeoutMs`.

## Re-measure on your hardware

The example is the driver. Scale it with `--streams`, `--bytesPerStream`,
`--chunkBytes` and `--sessions`, and run several client processes (each on its
own JS thread) when a single client becomes the bottleneck. Watch the server's
5-second log for `queuedBytesGlobal`, `drainWaits` and `streamErrors`. For a
paced comparison of the batching knob like G5's, run the same command with and
without `WEBTRANSPORT_STREAM_BATCH_BYTES` on the reading process, and record
host CPU next to throughput: the knob's effect in G5 was mostly on CPU.

In-repo tools, and what they do and do not measure:

- `bun run bench:stream` (`tools/bench/stream-throughput.ts`) runs one
  bidirectional stream in a 1 KiB write-then-read-echo loop. It measures round
  trips on one stream, not bulk egress.
- `tools/load/bench-bandwidth.ts` is a **datagram** bandwidth ladder (MTU-sized
  datagrams, rising per-session rate, a Rust `load-client` from
  `target/release`). It does not exercise streams.
- `WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS=1` arms per-process crossing counters
  (crossings/s, mean bytes per crossing). They are readable only through the
  unstable `__TESTING__` export, so they are a measurement aid, not a
  production metric.

The campaign's own G5/G7 harnesses are not in this repository
([CAPACITY.md](../CAPACITY.md) explains why).
