# Live media, SFUs and many rooms

This guide is for servers that move real-time media: a selective forwarding
unit (SFU) that relays each publisher's packets to the other members of a
room, a voice or video conferencing backend with many independent rooms, or a
camera uplink/downlink that sends each video frame as a burst of datagrams. It
is backed by three campaign gates: **G3** (camera / bursty egress), **G4**
(SFU fan-out) and **G8** (many rooms). The full measurement table, with
hardware for every figure, is in [CAPACITY.md](../CAPACITY.md).

## Workload this guide is proven for

The SFU shape, per publisher, which is also what the
[example](../../examples/scenarios/rooms/) implements:

| Direction | Rate | Payload | API |
|---|---|---|---|
| Media, publisher → server | 30 frames/s, each a burst of 11 datagrams (~3 Mbps, ~330 datagrams/s); publishers start at random phases | 1,150 B each | `session.sendDatagramBatch()` (one call per frame) |
| Forward, server → every other room member | each received datagram, once per member | the same 1,150 B | `server.sendDatagramMirror(targets, payload)` (one call per datagram) |
| Join, client ↔ server | once per session | a few dozen bytes of JSON | first bidirectional stream |

The gates measured these shapes:

| Gate | Shape |
|---|---|
| G3 camera / bursty egress | Server → client frame-shaped bursts, ~32,600 datagrams/s in aggregate, sent per frame with `sendDatagramBatch` |
| G4 SFU fan-out | 1 publisher → 50 subscribers at 3 Mbps: about 330 datagrams/s in, forwarded to each of 50 subscribers; measured 16,509 forwarded datagrams/s out |
| G8 many rooms | Three arms: voice rooms, video rooms of 10 subscribers, and mutual rooms where everyone publishes to everyone |

## What was measured

| Gate | Result | Hardware and topology |
|---|---|---|
| G3 | **Pass.** Egress one-way p99 **1.491 ms** (median of 5 blocks) against a 33.3 ms bar (one 30 fps frame), at ~32,600 datagrams/s. GSO and GRO active at 64 segments; `sndbufErrors` 0 on all 30 steps | 4-core / 8-thread bare-metal Linux box (~12 GB RAM); generator, sink and server on the same box over loopback |
| G4 | **Pass.** **16,509 forwarded datagrams/s** inside a 30 Hz frame gate, p99 **10.879 ms**, delivery **1.0000** | Same 4-core box, co-resident over loopback |
| G8 voice | **Pass at 100 rooms.** p99 1.96 / 2.32 / 2.45 ms at 10 / 50 / 100 rooms | Server: 10 room-shard processes, each pinned to 3 CPUs, on one DigitalOcean `c-32-intel` droplet (32 vCPU). Publisher and sink pools on a second droplet, same VPC (nyc3) |
| G8 video | **Pass at 100 rooms of 10 subscribers.** p99 2.88–3.54 ms across 2 / 5 / 10 / 25 / 50 / 100 rooms | Same |
| G8 mutual | **Pass at 10 rooms.** p99 0.77 / 0.83 / 1.53 ms at 2 / 5 / 10 rooms; worst shard's event-loop lag p99 1.07 ms. Only with each shard's JavaScriptCore large-heap size set to 8 MiB (see below) | Same |

Forward delivery was 1.0 in every G8 cell that passed. Earlier data points on
a DigitalOcean `c-32-intel` pair (one VPC): 25 concurrent 10-subscriber video
rooms at p99 3.584 ms from a single-process server, and 50 voice rooms at p99
1.64 ms from a sharded group-forwarding application.

**G4 is stated as a rate bound, not a subscriber count.** The measured shape
was one publisher forwarded to 50 subscribers, and the gate's record calls the
50 incidental to the 16,509/s figure rather than its cause. Other splits of
rooms × subscribers were not measured: treat about 16,500 forwarded
datagrams/s from one instance on the 4-core box as a starting point for
sizing, and measure your own split.

**G3's lever was the batch send API.** `sendDatagramBatch` measured at least
40× faster than a serial `await sendDatagram()` loop and 5–10× faster than
pipelined (not awaited one by one) sends. A serial await loop on its own can
make bursty egress saturate at a quarter of the rate the same process reaches
with smooth egress.

**G8 holds per arm, not all at once.** No single configuration passed all
three arms:

- At the default JavaScript heap, garbage carried between load steps failed
  the mutual arm at 5 and 10 rooms.
- With each shard's large-heap size at 8 MiB, mutual passed at 10 rooms, but
  video at 100 rooms failed on collection frequency.
- A 16 MiB sweep put both under their limits, but with only 2–6% to spare.
- Splitting the shards by room type (6 for one kind, 4 for the other) passed
  voice at 100 rooms but only video at 25 and mutual at 2.

The campaign record does not name how the heap size was set. Bun passes
JavaScriptCore options through environment variables prefixed `BUN_JSC_`, and
JavaScriptCore has a `largeHeapSize` option, so `BUN_JSC_largeHeapSize=8388608`
is the likely mechanism. That is unconfirmed. Note also that on Bun 1.3.14 for
macOS, `BUN_JSC_dumpOptions=1 bun -e 1` reports the default `largeHeapSize` as
33554432 (32 MiB), which would make 8 MiB a decrease, not a raise. Check the
default on your Linux build the same way before relying on either reading,
and measure.

The voice and mutual arms' participant counts per room and bitrates are not in
the summary this guide was written from, so they are not given here.

### Not proven

- **One configuration for mixed room types.** If one deployment hosts voice,
  video and mutual rooms together, nothing above says which heap setting or
  shard split serves all of them. Measure your mix.
- **More than ~16,500 forwarded datagrams/s from one process.** G4 is the
  single-process figure; G8 got further by running 10 processes.
- **Rooms that span processes.** Every G8 room lived on one shard. There is no
  cross-process forwarding in the library.
- **Large rooms.** The biggest measured room was 1 publisher and 50
  subscribers (G4). `sendDatagramMirror` accepts up to 10,000 targets per call,
  but no gate measured a room near that size.
- **Media quality.** Nothing here measured jitter buffers, codecs, congestion
  response or simulcast layer switching. These are datagram forwarding figures.
- **Browser publishers and subscribers.** The gates used native clients.
- **Client address changes** (Wi-Fi to cellular, NAT rebinding). No test in
  this project exercises one.

## Architecture

One process, rooms in memory:

```
publisher ──datagrams──▶ rooms server (one Bun process)
                           ├─ join: first bidi stream names room + role
                           ├─ per publisher datagram: stamp publisher id,
                           │    sendDatagramMirror(every other member, datagram)
                           └─ failures: E_SESSION_CLOSED → drop member
                                          E_QUEUE_FULL   → count, drop packet
subscribers ◀──datagrams──┘
```

The server cannot read the URL a client dialled: a server session exposes `id`
and `peer` but not the request path (see [SPEC.md](../SPEC.md), "Sessions").
So the room and role are not in the URL; the client opens one bidirectional
stream, writes `{"room":"lobby","role":"pub"}` and closes its side, and the
server answers `{"publisherId":3}` (0 for subscribers) or `{"error":"..."}`
on the same stream. A session that sends nothing valid within 5 seconds is
closed with code 4000.

For many rooms, run one process per shard and keep every room on exactly one
shard, which is how G8 ran:

```
client ──"which room?"──▶ room directory (your service)
       ◀── https://media-3.example.com:4433 ──┘
client ──UDP──▶ shard 3 (owns rooms r7, r19, ...)
```

Datagrams are right for media the next frame supersedes. Put signalling that
must arrive (mute, leave, keyframe requests, chat) on a stream.

## Run the example

From the repository root, with the native addon built (`bun run build:native`):

```bash
bun examples/scenarios/rooms/server.ts --port=4433
```

In a second terminal, 10 rooms of 1 publisher and 10 subscribers at 30 fps,
3 Mbps:

```bash
bun examples/scenarios/rooms/client.ts --url=https://127.0.0.1:4433 \
  --rooms=10 --publishers=1 --subscribers=10 --seconds=10
```

Flags: `--fps` (default 30), `--kbps` per publisher (default 3000) and
`--packetBytes` (default 1150) set the frame shape; datagrams per frame are
derived from them (11 at the defaults). `--roomPrefix` names the rooms, so two
fleets can share a server. Two other shapes:

```bash
# Voice-like: 50 packets/s of 160 B, 2 speakers and 8 listeners per room
bun examples/scenarios/rooms/client.ts --url=https://127.0.0.1:4433 \
  --rooms=20 --publishers=2 --subscribers=8 --fps=50 --kbps=64 --packetBytes=160

# Mutual: everyone publishes to everyone
bun examples/scenarios/rooms/client.ts --url=https://127.0.0.1:4433 \
  --rooms=5 --publishers=6 --subscribers=0 --kbps=1000
```

The first run generates a throwaway CA and certificate in
`examples/scenarios/.certs/`; both processes use it, and the client verifies
the server against it. To use a real certificate, set `CERT_PEM`, `KEY_PEM`
and (for the client) `CA_PEM` to file paths. The server prints its counters
every 5 seconds; the client prints a report when it finishes. `delivery` is
datagrams received over datagrams sent × (room members − 1), so a forward
that leaked into another room would push it above 1:

```json
{
  "rooms": 10,
  "publishers": 10,
  "subscribers": 100,
  "connectFailures": 0,
  "joinFailures": 0,
  "datagramsPerFrame": 11,
  "offeredKbpsPerPublisher": 3036,
  "framesSent": 2855,
  "datagramsSent": 31405,
  "sendErrors": 0,
  "receivedDatagrams": 314050,
  "receivedPerSec": 31404,
  "delivery": 1,
  "latencyP50Ms": 7.754,
  "latencyP99Ms": 27.799
}
```

That sample comes from a 10-second run on an Apple M1 Max laptop (10 cores)
with a load average of 30–60 from other work, server and client on the same
machine. The server's own counters matched it (31,405 datagrams in, 314,050
mirrored targets, no failures). It shows the example working; it is not a
capacity figure, and the latency is mostly the busy machine.

## Server configuration

```ts
import { createServer, E_SESSION_CLOSED } from "@webtransport-bun/webtransport";

const server = createServer({
  port: 4433,
  host: "0.0.0.0",              // "::" takes IPv6, plus IPv4 on Linux
                                // and macOS (on Windows since PR #22)
  tls: { certPem, keyPem },     // certificate and key only; clients verify the chain
  limits: {
    maxSessions: 5_000,         // default 2,000; size to what one shard holds
    maxDatagramSize: 1_200,     // default; a 1,150 B media packet fits
    // maxQueuedBytesPerSession stays at its 2 MiB default: a subscriber that
    // falls behind surfaces as E_QUEUE_FULL in the mirror's failures.
  },
  rateLimits: {
    // Per client IP. Defaults: 20 handshakes/s (burst 40) and 2,000
    // datagrams/s (burst 5,000). One 3 Mbps publisher sends ~330/s, so the
    // default covers about 6 publishers behind one NAT.
    datagramsPerSec: 2_000,
    datagramsBurst: 5_000,
  },
  onSession: (session) => { /* see examples/scenarios/rooms/server.ts */ },
});
```

The forward itself:

```ts
// targets: every other member's session id, cached per publisher and
// rebuilt only when the room's membership changes
const { sent, failures } = server.sendDatagramMirror(targets, datagram);
for (const { target, error } of failures) {
  if (error.code === E_SESSION_CLOSED) leaveRoom(target); // the reap list
  else queueFull++; // E_QUEUE_FULL: no budget right now; a late frame is useless, drop it
}
```

What matters in it:

- **One crossing per forwarded packet, not one per member.** The mirror copies
  the payload into native memory once and shares it across targets; it is
  synchronous, creates no promise and never waits. `sent + failures.length`
  always equals the number of targets, and one dead subscriber never stops
  the others.
- **The failure list is the reap list.** `E_SESSION_CLOSED` means the target
  is gone (or belongs to another server in the process); drop it from the
  room even if its `closed` promise has not settled yet.
- **`E_QUEUE_FULL` is where backpressure lands.** The mirror cannot park. The
  library's remedy is `session.sendDatagram()` on just those targets, which
  can wait; for live media the example drops the packet instead, because it
  would arrive after the next frame. Count it: a steady stream of these for
  one subscriber is a subscriber that cannot keep up.
- **At most 10,000 targets per call**, a cap on how long one call holds the
  JavaScript thread; over it the call throws `RangeError` before sending. The
  example refuses joins past 10,000 members per room. The library does not
  split the list for you.
- **The server stamps the publisher id** it assigned on join into every packet
  before forwarding, so one publisher cannot pose as another.
- **Spread the publishers.** Each publisher starts at a random phase of its
  frame period, so a room of publishers does not hit the server in the same
  instant.

### Bursty egress to one session (G3)

When the server itself produces frames (a camera relay, a rendered stream),
send each frame's packets to the session with one `sendDatagramBatch` call,
the way the example's publishers send theirs:

```ts
// frame: Uint8Array[] of one frame's packets, buffers reused frame after frame
const { sent, error } = await session.sendDatagramBatch(frame);
// frame[0 .. sent) went out in order; if error is set, frame[sent] failed with
// error.code (E_BACKPRESSURE_TIMEOUT, E_SESSION_CLOSED, E_QUEUE_FULL) and the
// rest were not attempted
```

not

```ts
for (const packet of frame) await session.sendDatagram(packet); // one crossing and one wait per packet
```

The batch copies every payload before its promise is returned, so the frame
buffers can be rewritten for the next frame immediately. The whole call shares
one `backpressureTimeoutMs` deadline (default 5,000 ms), rather than one per
packet. Partial sends resolve, they do not throw: check `sent` and `error`.

## Host tuning

On Linux, raise the UDP socket buffers on the server and on any load-generator
host. These are the values the cloud runs used:

```bash
sudo sysctl -w net.core.rmem_max=26214400 net.core.wmem_max=26214400 \
  net.core.rmem_default=26214400 net.core.wmem_default=26214400 \
  net.ipv4.udp_rmem_min=26214400 net.ipv4.udp_wmem_min=26214400
```

Frame bursts are packet impulses by design. A fleet that sends in lockstep
overflows the kernel's UDP receive buffer before the server is busy (in the
campaign, 0.699 delivery at 10,000 synchronized sessions, every loss a kernel
receive-buffer error; 1.000 staggered). Watch
`nstat -az | grep -E 'Udp(RcvbufErrors|SndbufErrors|InErrors)'`. GSO and GRO
were active (64 segments) on the standard bind path in the campaign, with no
send-buffer errors.

For large fleets also raise `fs.file-max` and `ulimit -n`, and on generator
hosts widen `net.ipv4.ip_local_port_range` to `"1024 65535"`.

## Scaling out

Shard rooms across processes rather than growing one process: that is the
lesson of G8, where 10 shard processes held 100 video rooms. The rules:

- A room never spans shards. Every member of a room connects to the shard
  that owns it.
- Your room directory (signalling, lobby, or whatever hands out room links)
  decides the shard and gives the client that shard's exact URL, one port or
  address per process.
- Pin shards to CPUs if you run several on one host; G8 gave each shard 3
  CPUs on a 32-vCPU droplet.
- Size each shard by forwarded datagrams per second (G4: about 16,500/s on the
  4-core box), not by member count.

Plain `SO_REUSEPORT`, ECMP or any balancer that hashes the UDP 4-tuple is not
supported for long-lived sessions. Sharing one port across processes needs
`reusePort` + `quicLb` + `reusePortSteering` with the eBPF connection-ID
steering program (Linux, experimental). Both patterns are in
[deployment.md](deployment.md); the steering design is in
[quic-lb.md](../quic-lb.md).

## What to watch

From `server.metricsSnapshot()` (Prometheus names in [METRICS.md](../METRICS.md)):

- `datagramsIn` (publisher packets) against `datagramsOut` (forwarded): their
  ratio is the average fan-out. Prometheus: `webtransport_datagrams_in`,
  `webtransport_datagrams_out`.
- `datagramMirrorCalls` and `datagramMirrorTargets`: calls and targets
  attempted. These are in the snapshot only, not in the Prometheus export.
- `datagramsDropped` and its reasons. `datagramsDroppedRateLimited` means a
  per-IP bucket is too small for the publishers behind one address;
  `datagramsDroppedQueueSession` means a publisher's packets are not being
  read fast enough, which here means the JavaScript loop is behind.
- Your own count of mirror `E_QUEUE_FULL` failures, per subscriber if you can:
  the library has no metric for them.
- `sessionsActive` against your per-shard target.
- Event-loop lag of each shard. The library does not measure it; time a
  short `setInterval` and record how late it fires. G8's mutual arm passed
  with the worst shard's lag p99 at 1.07 ms.
- The kernel UDP counters above.

## Pitfalls

- **The per-IP rate limits apply to load tests.** A test fleet on one machine
  is one IP, and `handshakesBurst` (default 40) caps the sessions one IP may
  hold open at once: with the defaults, 40 members connect and the rest get
  `E_RATE_LIMITED` (HTTP 429), and about 6 publishers at 3 Mbps exhaust the
  2,000 datagrams/s bucket. The example's CLI server opens them; size them for
  real NATs in production.
- **Awaiting each datagram of a frame.** A serial `await sendDatagram()` loop
  measured 40× slower than `sendDatagramBatch` in G3. Batch per frame.
- **Expecting the room in the URL.** The server session does not expose the
  request path; carry room and role in a join message, as the example does.
- **One heap setting for every room type.** G8's mutual arm needed a heap
  setting that made the video arm fail. Shard by room type or measure your
  mix.
- **Rooms near 10,000 members.** One mirror call holds the JavaScript thread
  for the whole list; over 10,000 targets it throws. A room that large needs
  a different design (a tree of forwarders), which this project has not
  measured.
- **Retrying `E_QUEUE_FULL` media.** By the time a parked send completes, the
  packet is stale. Drop it and watch the count.
- **Shared development certificates hide wrong ports.** Every example trusts
  the same throwaway CA, so a client pointed at the wrong local port connects
  to whichever example server is there without a TLS error. Check that the
  server's log shows your members arriving.

## Re-measure on your hardware

Scale the example up: run the server on the target host, and the client from
one or more other hosts (several client processes per generator host, each
with its own `--roomPrefix`, so the generator is not the bottleneck). Raise
the server's rate limits to cover the generator IPs. Latency in the client
report is measured on the client's clock (publisher stamp to subscriber
receive), so publishers and subscribers of a room must run in the same client
process, as they do in the example. Grade on `delivery`, `latencyP99Ms`,
`receivedPerSec`, `sendErrors` and `connectFailures`, and on the server's
`queueFull`, `datagramsDropped` and the kernel counters above.

To find a shard's forward ceiling, hold one room shape and raise `--rooms`
until `delivery` drops below 1 or `latencyP99Ms` leaves your frame budget
(33.3 ms at 30 fps). The campaign's G3, G4 and G8 drivers are not in this
repository (see [CAPACITY.md](../CAPACITY.md)). In-repo,
[`tools/bench/mirror-send/fanout-bench.ts`](../../tools/bench/mirror-send/fanout-bench.ts)
measures what a one-payload-to-N fan-out costs per target across the
JavaScript/native boundary, with no network behind it (build its addon first,
as the file header says).
