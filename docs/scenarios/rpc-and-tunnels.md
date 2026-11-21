# RPC and long-lived tunnels

This guide is for servers that answer request/response calls over
WebTransport streams (one call per stream, like an RPC or a GraphQL request),
and for servers that hold one long-lived bidirectional stream per session and
move bytes both ways on it (a tunnel, a terminal, a sync channel). It is
backed by campaign gate **G11** and its three arms: **X** (exchange), **T**
(tunnels) and **D** (a cross-direction coupling probe). The full measurement
table, with hardware for every figure, is in [CAPACITY.md](../CAPACITY.md).

## Workload this guide is proven for

| Arm | Direction | Rate | Payload | API |
|---|---|---|---|---|
| X, exchange | client → server request, then server → client response, on a new bidi stream per call | 60,000 calls over 1,000 sessions | not recorded in the material this guide was written from | client `createBidirectionalStream()`, server `incomingBidirectionalStreams` |
| T, tunnel | both directions at once, one bidi stream per session | 3 Mbps each way per tunnel, 100 tunnels, 60 s | timestamped frames | same, held open |

The [example](../../examples/scenarios/rpc/) implements both shapes in one
server. Its defaults: exchange requests of 256 B and responses of 1,024 B,
1 call per second per session; tunnel frames of 1,024 B (length prefix
included) at 3 Mbps each way. Those sizes are the example's choice, not the
gate's.

## What was measured

| Arm | Result | Hardware and topology |
|---|---|---|
| G11 X | **PASS**: 60,000 / 60,000 exchanges at 1,000 sessions, RTT p99 **27.25 ms** (raw) against a 50 ms bar. Server-side stream accepts equal to attempted opens. Host CPU median 25.6% | Home rig: 4-core / 8-thread bare-metal Linux box, generator and server co-resident over loopback |
| G11 T | **PASS** at shipped defaults: 100 tunnels × 3 Mbps each way for 60 s, exact byte accounting, no stream errors, per-session spread within 5%. Up (client → server, read by the server's JavaScript) one-way p99 **3.5 / 3.594 ms**, down **0.94 / 1.00 ms**, host CPU ~45% | DigitalOcean `c-8` (8 vCPU), generator on the same droplet |
| G11 T, read group off | Also passed (up p99 4.5 ms) with `WEBTRANSPORT_STREAM_READ_GROUP=0`. So this run does not show that the cross-stream read group was needed | Same droplet |
| G11 T on the home rig | **Missed**: up p99 **348 / 328 ms**, down 4.25 ms, native wire-level 17.25 / 12.25 ms. Attributed to the benchmark conductor's read-side scheduling at full-duplex saturation (host ~87.7%); the conductor ran inside the server process, and the miss stands with that harness as the application | Home rig |
| G11 T ladder, home rig | T-25: up/down p99 1.44 / 0.57 ms, 26.5% host CPU. T-50: 2.50 / 0.97 ms, 51.5%. T-100: the miss above. T-200: the box saturated | Home rig |
| G11 D | **Coupling absent**: the cross-direction choke it looked for did not appear. It grades nothing | Home rig |

Read the two T results together. The same 100-tunnel shape passed with a
3.5 ms tail on an 8-vCPU droplet and missed by 100× on a 4-core box, while
the wire-level delivery on the 4-core box stayed at 17 ms. The frames arrived;
on the 4-core box the benchmark conductor shared the server's one JavaScript
thread, and its read-side scheduling ran the read callbacks late. A leaner
application may do better there; nobody measured one. App-level stream tail
latency is a queueing function of that thread's utilization, and it climbs
steeply near saturation (see OPERATIONS.md,
[Sizing the JS read side](../OPERATIONS.md#sizing-the-js-read-side-stream-tail-latency)).

### Not proven

- **Tunnels faster than 3 Mbps each way.** No gate graded a higher
  per-tunnel rate. On this example, at default limits, bidirectional tunnels
  of 10 Mbps or more each way failed under load where one-directional
  traffic at the same rate did not (see Pitfalls, "Bidirectional streams can
  stall"). Do not extrapolate the T result upward.
- **More than 100 tunnels per process** as a graded figure. The home rig
  saturated at 200; plan around ~70 tunnels of this shape per JavaScript
  process on reference hardware (OPERATIONS.md) and shard beyond.
- **Calls slower than one round trip.** X measured calls whose server answers
  immediately. A handler that awaits a database holds a stream open for its
  duration; streams per session and global stream caps then bound
  concurrency, not the rate.
- **The native stream sink in a tunnel server.** `openReadSink` is the fix the
  OPERATIONS.md rules point to for latency-critical streams, and
  `tools/load/bench-sink.ts` measured it against the facade path, but no G11
  arm ran a tunnel server on it. It is experimental.
- **A separate generator host.** Every G11 figure had the generator on the
  server's machine, so per-process costs are upper bounds of unknown
  tightness.
- **Client address changes** mid-tunnel. No test in this project exercises
  one.

## Architecture

Both modes share one server process and one stream type. The client says
which mode a stream is in its first byte:

```
clients ──UDP 4433──▶ rpc server (one Bun process)
                        └─ per session: for await (stream of incomingBidirectionalStreams)
                              ├─ exchange: read request to FIN ─▶ write response ─▶ FIN
                              └─ tunnel:   read frames ──┐ concurrently, one stream
                                           write frames ◀┘ until the client's FIN, then summary ─▶ FIN
```

- **Exchange: one stream per call.** Calls are independent: a slow response
  never blocks the next one (no head-of-line blocking between calls), and a
  call's end is its stream's FIN, so the server needs no framing. The server
  serves streams concurrently; awaiting one call before accepting the next
  would turn the session into a queue.
- **Tunnel: one stream, two directions.** The reader and the writer of each
  side run independently. A stream is a byte stream, so frames are
  length-prefixed and a reader reassembles them across reads: one read can
  hold half a frame or several.

## Run the example

From the repository root, with the native addon built (`bun run build:native`):

```bash
bun examples/scenarios/rpc/server.ts --port=4433
```

In a second terminal, calls:

```bash
bun examples/scenarios/rpc/client.ts --url=https://127.0.0.1:4433 --mode=exchange \
  --sessions=200 --rate=5 --seconds=10 --requestBytes=256 --responseBytes=1024
```

or tunnels:

```bash
bun examples/scenarios/rpc/client.ts --url=https://127.0.0.1:4433 --mode=tunnel \
  --sessions=100 --upMbps=3 --downMbps=3 --frameBytes=1024 --seconds=10
```

`--rate` is calls per second per session; sessions start at random phases so
the fleet does not open its streams in step. The first run generates a
throwaway CA and certificate in `examples/scenarios/.certs/`; both processes
use it and the client verifies the server against it. To use a real
certificate, set `CERT_PEM`, `KEY_PEM` and (for the client) `CA_PEM` to file
paths. The server prints its counters every 5 seconds; check that
`streamsAccepted` moves, which also confirms the client reached the server you
think it did.

Exchange report:

```json
{
  "mode": "exchange",
  "sessions": 200,
  "connectFailures": 0,
  "attempted": 9957,
  "completed": 9957,
  "completedPerSec": 995.5,
  "rttP50Ms": 3.36,
  "rttP99Ms": 12.98,
  "errors": {}
}
```

Tunnel report:

```json
{
  "mode": "tunnel",
  "sessions": 100,
  "connectFailures": 0,
  "tunnelsCompleted": 100,
  "errors": {},
  "latencyClock": "one-way, sender wall clock to receiver wall clock: valid on one host only; 2% buckets",
  "up": {
    "offeredMbps": 299.95,
    "sentMbps": 299.79,
    "deliveredMbps": 299.79,
    "perTunnelSpreadPct": 0.03,
    "latencyP50Ms": 3.73,
    "latencyP99Ms": 6.62,
    "bytesSent": 374382592,
    "bytesReceived": 374382592,
    "exact": true
  },
  "down": {
    "offeredMbps": 299.96,
    "sentMbps": 299.72,
    "deliveredMbps": 299.72,
    "perTunnelSpreadPct": 0.05,
    "latencyP50Ms": 4.73,
    "latencyP99Ms": 7.03,
    "bytesSent": 374455296,
    "bytesReceived": 374455296,
    "exact": true
  }
}
```

Both samples come from 10-second runs on an Apple M1 Max laptop (10 cores,
macOS) with a 1-minute load average of about 5.5 from other work, client and
server on one machine. They show the example working; they are not capacity
figures.

How to read the tunnel report:

- **`up`** is client → server, measured by the server and returned in a
  summary frame when the client ends its side; **`down`** is server → client,
  measured by the client.
- **`offeredMbps`** is the sender's schedule, **`sentMbps`** what its stream
  accepted, **`deliveredMbps`** what the receiver read, all over the sender's
  own elapsed time. Sent below offered means the stream pushed back.
- **`exact`** is true when every tunnel's receiver read exactly the bytes its
  sender wrote.
- **One-way latency** subtracts the sender's wall-clock stamp from the
  receiver's clock. It is only meaningful with both ends on one host (the
  campaign's arrangement too); across hosts it includes the clock offset.
  Values are bucketed to about 2%.
- The example's sender writes every 10 ms and keeps one write in flight, at
  most 64 KiB, so one tunnel direction tops out near 50 Mbps (46.7 Mbps
  measured on the laptop). That is the example's pacing, not a transport
  limit.

## Server configuration

```ts
import { createServer } from "@webtransport-bun/webtransport";

const server = createServer({
  port: 4433,
  host: "0.0.0.0",                  // "::" takes IPv6, plus IPv4 on Linux
                                    // and macOS (on Windows since PR #22)
  tls: { certPem, keyPem },         // no caPem on a server: it fails with E_TLS
  limits: {
    maxStreamsPerSessionBidi: 200,  // default; concurrent calls per session (a tunnel counts as one)
    maxStreamsGlobal: 50_000,       // default; concurrent streams across all sessions
    maxQueuedBytesPerStream: 262_144, // default 256 KiB; shared by BOTH directions of a bidi stream
    backpressureTimeoutMs: 5_000,   // default; a stream that cannot make progress this long fails
    idleTimeoutMs: 60_000,          // default; a quiet tunnel is closed after this
  },
  rateLimits: {
    // Stream opens are rate-limited per client IP, not per session: every
    // session behind one NAT shares one bucket. Defaults: 200/s, burst 400.
    // Size it for the busiest address you expect, in calls per second.
    streamsPerSec: 2_000,
    streamsBurst: 4_000,
  },
  onSession: async (session) => {
    for await (const stream of session.incomingBidirectionalStreams) {
      void serve(stream); // concurrently: see examples/scenarios/rpc/server.ts
    }
  },
});
```

What matters in this workload:

- **Per-IP stream-open rate.** Every call opens a stream, so the stream
  bucket is the per-address call rate. Over it, the server resets the new
  stream before your code sees it and counts it in `rateLimitedCount`; the
  client sees the call fail with `E_STREAM_RESET` or `E_STOP_SENDING`.
  Measured with the example against the default bucket (100 sessions × 5
  calls/s from one address for 6 s): 1,599 of 2,985 calls completed, about
  200/s plus the 400 burst, and the server's `rateLimitedCount` was 1,386,
  exactly the failed calls.
- **Streams per session.** `maxStreamsPerSessionBidi` (default 200; both
  sides enforce it, the client side since PR #22) caps concurrent streams per
  session, not streams over the session's lifetime: a closed stream frees its
  slot. Concurrent calls per session are roughly call rate × call duration.
  The server refuses an incoming stream over its cap by resetting it (counted
  in `limitExceededCount`).
- **`waitUntilAvailable`.** `createBidirectionalStream()` at the cap rejects
  with `E_LIMIT_EXCEEDED`. `createBidirectionalStream({ waitUntilAvailable:
  true })` instead waits for a slot to free, retrying on `E_LIMIT_EXCEEDED`,
  `E_QUEUE_FULL` and `E_BACKPRESSURE_TIMEOUT`, for at most
  `backpressureTimeoutMs`, then rejects with `E_BACKPRESSURE_TIMEOUT`. It
  does not wait out a rate limit. The example client uses it. Before PR #22 the
  client accepted its own `maxStreamsPerSessionBidi` but did not enforce it,
  so there was nothing to wait for: in a probe on a pre-#22 build, one
  session opened 215 of 230 concurrent streams locally, the server
  accepted 200 and reset 15 (`limitExceededCount` 15), and the last 15
  opens waited on QUIC stream credit for as long as the probe watched (3 s).
  After PR #22 the client rejects (or with `waitUntilAvailable`, waits) at
  its cap.
- **Keep-alive for quiet tunnels.** A tunnel with no traffic for
  `idleTimeoutMs` is closed. The client pings at `idleTimeoutMs / 3` by
  default (`keepAliveIntervalMs`); the server does not ping unless you set
  `keepAliveIntervalMs` on it.
- **Do not raise `maxQueuedBytesPerStream` to fix a stalled tunnel.** Raising
  it to 1 MiB on the server alone did not remove the bidirectional stall
  below. Pace the writers instead.

## Host tuning

On Linux, raise the UDP socket buffers on the server and on any
load-generator host. These are the values the cloud runs used:

```bash
sudo sysctl -w net.core.rmem_max=26214400 net.core.wmem_max=26214400 \
  net.core.rmem_default=26214400 net.core.wmem_default=26214400 \
  net.ipv4.udp_rmem_min=26214400 net.ipv4.udp_wmem_min=26214400
```

Watch `nstat -az | grep -E 'Udp(RcvbufErrors|SndbufErrors|InErrors)'`. For
thousands of sessions also raise `fs.file-max` and `ulimit -n`, and on
generator hosts widen `net.ipv4.ip_local_port_range` to `"1024 65535"`.

## Scaling out

The resource that runs out first in this workload is the JavaScript thread
that reads the streams, not the network or the native transport:

1. **Keep each reading loop below ~80% of one core.** On the reference
   hardware 100 tunnels of the T shape cost 0.9–1.15 cores of loop time, so
   plan about **70 such tunnels per JavaScript process** and add processes
   beyond that. Watch the loop's own utilization, not host CPU: the host can
   be mostly idle while the one loop that matters is saturated.
2. **Run more processes, each with its own port or address**, and tell
   clients the exact URL through DNS or your own rendezvous. See
   [deployment.md](deployment.md). One shared port needs `reusePort` +
   `quicLb` + `reusePortSteering` with the eBPF CID steering program (Linux,
   experimental: [quic-lb.md](../quic-lb.md)); `reusePort` alone hashes the
   4-tuple and strands a session whose client address changes until the idle
   timeout.
3. **Move latency-critical stream reads off the loop with the native sink**
   (`openReadSink`, experimental; [RFC_STREAM_SINK.md](../RFC_STREAM_SINK.md),
   SPEC.md "Experimental surfaces"). A native task writes stream data into a
   `SharedArrayBuffer` ring that a `SinkReader` in a Worker consumes, so
   delivery no longer waits for the main loop. Open it before anything reads
   the stream's readable.
4. **Worker threads help processing, not delivery.** Parsing in a Worker
   lowers the loop's load, but the read callback still lands on the main
   loop.
5. **`WEBTRANSPORT_STREAM_BATCH_BYTES` is damping, not prevention.** It
   coalesces what has already queued. It softens a backlog once you are
   behind; it does not keep you out of saturation.

For calls, the same thread parses requests and runs handlers. Fewer, larger
calls are cheaper than many small ones: one JavaScript thread sourced about
63,300 writes/s of 1 KiB on the home rig and could not go faster, whatever
the transport could carry.

## What to watch

From `server.metricsSnapshot()` (Prometheus names in [METRICS.md](../METRICS.md)):

- `streamsActive` (`webtransport_streams_active`): concurrent calls plus open
  tunnels. Compare with `maxStreamsPerSessionBidi` × sessions and
  `maxStreamsGlobal`.
- `rateLimitedCount` (`webtransport_rate_limited_total`): it also counts
  stream opens refused by the per-IP stream bucket. A rise that matches failed
  calls means the bucket is too small for an address.
- `limitExceededCount` (`webtransport_limit_exceeded_total`): includes
  incoming streams refused at a stream cap.
- `streamOpenLatency` (`webtransport_stream_open_latency_seconds`): measures
  streams the server opens, so it is quiet for client-opened calls.
- `queuedBytesGlobal` (`webtransport_queued_bytes_global`): a value that sits
  at a multiple of `maxQueuedBytesPerStream` while traffic stops is the
  bidirectional stall below.
- Your own counters: calls served, call errors by code, tunnel bytes per
  direction. In the example's runs `backpressureTimeoutCount` stayed 0 while
  streams failed with `E_BACKPRESSURE_TIMEOUT`, so do not rely on it to see
  stream stalls.
- The event-loop utilization of each process.

## Pitfalls

- **Bidirectional streams can stall when both directions are busy.** A known
  open issue, tracked and not yet fixed: one per-stream byte budget
  (`maxQueuedBytesPerStream`, 256 KiB by default) is shared by both
  directions of a bidi stream. The example's runs on the laptop above, at
  default limits, with both sides reading concurrently:
  - **Unpaced writers stall reliably.** One stream, each side writing as fast
    as backpressure allowed while reading the other direction: with 16, 64 or
    256 KiB writes both directions stopped after under 10 KB; with 1 KiB writes
    after 2.4 MB in one run and 59 MB in another. Each time
    `queuedBytesGlobal` sat at exactly 262,144 (one stream's budget) with no
    progress until both sides failed with `E_BACKPRESSURE_TIMEOUT` after
    `backpressureTimeoutMs`. The same probe with only one direction busy ran
    at 443–457 Mbps without an error.
  - **Paced tunnels at 3 Mbps did not stall**: 100 tunnels (300 Mbps each
    way) and 200 tunnels (600 Mbps each way, past the loops' comfort: p99
    84 / 181 ms) both had exact accounting and no errors. Neither did 10
    tunnels at 40 Mbps each way.
  - **Paced tunnels at 10–40 Mbps each way failed under load**: 6 of 20
    tunnels at 40 Mbps, 15 of 40 at 20 Mbps, 23–29 of 80 at 10 Mbps (about
    500 Mbps each way in total), with `E_BACKPRESSURE_TIMEOUT` on the server
    and `E_STREAM_RESET` / `E_STOP_SENDING` on the client. The same 80
    tunnels at 10 Mbps in one direction only ran clean (p99 under 10 ms), and
    so did 80 × 20 Mbps one-way while overloaded (1,058 of 1,600 Mbps
    delivered, p99 354 ms). That points at the shared budget rather than at
    plain loop saturation, but these runs do not prove the mechanism.

  What to do: pace every writer below what the stream drains, keep one write
  in flight per direction, and keep writes small. For a high-rate tunnel,
  consider two unidirectional streams, one per direction: a uni stream has no
  reverse half sharing its budget (not exercised by this example). G11 D,
  which probed for cross-direction coupling, did not find it; its exact shape
  is not recorded in the material this guide was written from.
- **Writes larger than `maxQueuedBytesPerStream` used to fail** with
  `E_BACKPRESSURE_TIMEOUT`. This is fixed after rc.5 (PR #22), which splits
  them into budget-sized pieces. The example never writes more than 64 KiB at
  once, so it behaves the same on either side of that fix.
- **Read the whole request; frame the tunnel.** Chunk boundaries are not
  message boundaries, in QUIC or here. An exchange ends at FIN; a tunnel
  needs its own framing. The example uses a 4-byte length prefix and
  reassembles frames that span reads.
- **Stream error codes.** Session-level and open failures are
  `WebTransportError`s with a `code`. Errors emitted by a client's Node
  `Duplex` (`'error'` events, write callbacks) are plain `Error`s whose
  message starts with the code (for example `E_BACKPRESSURE_TIMEOUT: ...`)
  and have no `code` property. The example's `errorCode()` handles both.
- **Do not close the session right after the last byte.** On the sending side
  a stream's close completes only when the peer has acknowledged the FIN. A
  client that reads its response and closes its session at once can make the
  server's `close()` reject for a call that was delivered. The example server
  counts a call as served when its response is written and ignores that
  rejection.
- **The per-IP limits apply to load tests.** A test fleet on one machine is
  one IP: it shares one handshake bucket (`handshakesBurst` default 40 caps
  the sessions one IP may open at once) and one stream bucket. Open both for
  tests; size them for real NATs in production. The example server opens
  them.
- **A dev CA hides a wrong port.** The example's clients trust the shared
  throwaway CA, so they will happily connect to any example server using it.
  Confirm in the server's log that the sessions arrived.

## Re-measure on your hardware

Scale the example up: run the server on the target host and the client from
one or more other hosts, with several client processes per generator host so
the generator's own JavaScript thread is not the bottleneck. Open the
server's per-IP limits for the generator addresses. One-way latency needs
both ends on one host; across hosts, grade the tunnel on throughput,
`exact`, `perTunnelSpreadPct` and errors, and grade latency on the exchange
RTT, which uses one clock. Raise `--sessions` until the reading loop
approaches ~80% of a core and record where the tail starts climbing.

To A/B the server's read path, run the server once more with
`WEBTRANSPORT_STREAM_READ_GROUP=0` (it is read at startup). To compare the
facade read path with the native sink under a saturated loop,
[`tools/load/bench-sink.ts`](../../tools/load/bench-sink.ts) is the in-repo
driver:

```bash
SINK_BENCH_STREAMS=8 SINK_BENCH_SATURATE_PCT=90 bun tools/load/bench-sink.ts
```

It also takes `SINK_BENCH_RATE_HZ`, `SINK_BENCH_PAYLOAD`,
`SINK_BENCH_DURATION_S`, `SINK_BENCH_MODES` and `SINK_BENCH_JSON`; its
authoritative runs are on Linux, and local macOS numbers are indicative only.
The G11 harness itself is not in this repository.
