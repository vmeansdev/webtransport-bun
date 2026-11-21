# Realtime games, MMO realms and device telemetry

This guide is for servers that hold many long-lived sessions exchanging small,
frequent, loss-tolerant messages: action and MOBA games (tight round trips),
MMO realms (thousands of players, server-driven world snapshots) and
GPS/telemetry fleets (many devices, low rate each). It is backed by three
campaign gates: **G1** (session scale), **G2** (tail latency) and **G6** (MMO
realm). The full measurement table, with hardware for every figure, is in
[CAPACITY.md](../CAPACITY.md).

## Workload this guide is proven for

The G6 realm shape, per player, which is also what the
[example](https://github.com/vmeansdev/webtransport-bun/tree/main/examples/scenarios/game) implements:

| Direction | Rate | Payload | API |
|---|---|---|---|
| Input, client → server | 4 Hz, phases spread across the period | 64 B in G6; 32 B in the example | `session.sendDatagram()` |
| Action (every 8th input) → ack, server → client | 0.5 Hz, ack sent on receipt | 64 B | `session.sendDatagram()` |
| World snapshot, server → client | 5 Hz × 3 datagrams, spread over 10 slices of 20 ms | 1,150 B each | `session.sendDatagramBatch()` |

The other two gates measured narrower shapes:

| Gate | Shape |
|---|---|
| G1 session scale | 10,000 concurrent sessions sending small periodic upstream datagrams, phases staggered |
| G2 tail latency | 100 sessions × 150 datagrams/s × 1,150 B echoed back (15,000/s each way) |

## What was measured

| Gate | Result | Hardware and topology |
|---|---|---|
| G1 | **10,000 sessions**, ingest p99 **2.576 ms**, delivery **1.000000**, memory **~126.5 KB per session**, linear from 1k to 10k | 4-core / 8-thread bare-metal Linux box; generator and server on the same box over loopback |
| G2 | Echo RTT p99 **1.0168 ms** (median over 9 replicates) against a 10 ms bar; network floor RTT p99 0.397 ms | Two DigitalOcean `c-32-intel` droplets (32 vCPU) in one VPC; server and generator on separate droplets |
| G6, one process (graded) | Every steady clause passed at **500** players; knee at **2,500**; collapse at **5,000**. Hotspot and reconnect-storm arms missed | Same 4-core box as G1, with a separate machine generating the players over a cable |
| G6, sharded | Steady realm at **40,000** players passed in two independent runs (ack RTT p99 **3.71 / 3.59 ms**). A 40-player raid hotspot passed (one-way p99 **8.50 ms**). A reconnect storm passed: 8,000 of 8,000 severed players re-accepted within 2.41 s, survivors' ack p99 **7.82 ms**. **50,000 missed** (ack p99 43.97 ms): that is the measured ceiling. This was a campaign build with pieces outside the supported library (listed under Not proven), not the shipped configuration | 24 server processes sharing one port (`reusePort` + `quicLb` + eBPF steering) on a DigitalOcean 48-vCPU droplet; 4 generator processes on a second; same VPC |

The single-process collapse at 5,000 was later traced to the measuring setup,
not the server: wire-level packet counts showed the generator machine's network
path dropping about 40% of its own outgoing packets below its UDP socket under
full-duplex load. The same workload against the same server code, with a Linux
generator on a pair of DigitalOcean `c-32-intel` droplets (32 vCPU), ran 5,000
players on one process with ingest 1.0000. That rig's shard ladder, before the
buffer-reuse fix described below (characterization, not a graded gate):

| Players | Processes | Ingest | Ack RTT p99 | Server cores used (of 32) |
|---|---|---|---|---|
| 5,000 | 1 | 1.0000 | 8.13 ms | 2.7 |
| 5,000 | 4 | 1.0000 | 2.52 ms | 4.5 |
| 10,000 | 4 | 1.0000 | 6.45 ms | 7.5 |
| 15,000 | 8 | 1.0000 | — | 13.3 |
| 20,000 | 8 | 0.9998 | — | 16.8 |
| 25,000 | 16 | 0.9993 | — | 24.1 |

More processes bought a lower tail at the same load (8.13 → 2.52 ms at 5,000
players, 1 → 4 processes). Past the box's capacity it shed throughput, not
sessions: at 100,000 players it lost 23 sessions and did not crash.

### Not proven

- **40,000 players on the shipped library.** The 40,000 runs and the sharded
  hotspot and storm arms used one closed campaign profile, built from a
  diagnostic branch (`e43c667f` on `probe/g6-sharded-diagnostic-01`) and
  recorded as a diagnostic result, not a release. Each of the 24 processes
  ran two pieces outside the supported library:
  - **3 server worker threads.** The shipped addon fixes 2; 3 is reachable
    only through the unsupported `WEBTRANSPORT_NATIVE_SERVER_WORKERS` knob.
  - **An internal native datagram reflector answering the acks.** It is not
    public API. With acks answered in each shard's JavaScript loop, that loop
    set the tail: at 30,000 players on a 48-vCPU pair the ack p99 was 83 ms.
    Plan on fewer players per shard than the 40,000 / 24 split if your acks
    run in JS, and measure.

  The rest of that profile is either this tree's default (the datagram pump
  read path on server and generators, the shared receive runtime, send
  `EAGAIN` handled by waiting, the experimental peer hint off) or host
  configuration: UDP GRO off on the server (see Pitfalls) and
  26,214,400-byte receive buffers (see Host tuning).
- **Cross-shard fan-out.** The raid hotspot passed with all 40 raid members on
  one shard, so raid traffic never crossed processes. There is no cross-shard
  path in the library; if a zone can span shards, you need your own relay.
- **A graded single-process figure above 500 players.** The cloud ladder above
  is a characterization, and the graded single-process run is confounded by
  its generator.
- **Single-digit-millisecond tails measured from an ordinary machine.** G2
  could not be graded on the 4-core box: before any gate cell counts, the
  measuring path must be quiet (idle floor RTT p99 under 4.0 ms), and there
  the floor RTT p99 was 8.1–12.6 ms, caused by the generator host waking late
  under load. The gate bar itself is 10 ms. On quiet cloud hardware the floor
  was 0.397 ms and the gate passed.
- **Client address changes** (Wi-Fi to cellular, NAT rebinding). No test in
  this project exercises one.

## Architecture

Up to a few thousand players of this shape, one process:

```
players ──UDP 4433──▶ game server (one Bun process)
                        ├─ per session: read inputs, ack actions on receipt
                        └─ world tick: 5 Hz, 10 slices × 20 ms, sendDatagramBatch per player
```

Beyond that, run one process per shard. The proven 40,000-player layout put 24
processes behind one port:

```
players ──UDP 4433──▶ Linux SO_REUSEPORT group
                        └─ eBPF program reads the server ID in each packet's
                           connection ID and picks the owning process
                              ├─ shard 1  (quicLb serverId [0,1], slot 0)
                              ├─ shard 2  (quicLb serverId [0,2], slot 1)
                              └─ ...      (24 shards)
```

The simpler alternative, which needs no eBPF, is one port per shard with your
lobby or matchmaker handing each player the exact URL. Both are described in
[deployment.md](deployment.md).

Datagrams are right for state that the next tick supersedes. Use a
bidirectional stream per session for anything that must arrive (chat,
inventory, purchases).

## Run the example

From the repository root, with the native addon built (`bun run build:native`):

```bash
bun examples/scenarios/game/server.ts --port=4433
```

In a second terminal:

```bash
bun examples/scenarios/game/client.ts --url=https://127.0.0.1:4433 --players=500 --seconds=8
```

The first run generates a throwaway CA and certificate in
`examples/scenarios/.certs/`; both processes use it, and the client verifies
the server against it. To use a real certificate, set `CERT_PEM`, `KEY_PEM`
and (for the client) `CA_PEM` to file paths. The server prints its counters
every 5 seconds; the client prints a report when it finishes:

```json
{
  "players": 500,
  "connectFailures": 0,
  "actionsSent": 1500,
  "acksReceived": 1500,
  "ackRttP50Ms": 18.36,
  "ackRttP99Ms": 616,
  "snapshotDatagrams": 51631,
  "snapshotDelivery": 0.86
}
```

That sample comes from an 8-second run on a MacBook with a load average of 140
from other work, with both processes on one machine. It shows the example
working (every player connected, every action acknowledged); it is not a
capacity figure.

## Server configuration

```ts
import { createServer } from "@webtransport-bun/webtransport";

const server = createServer({
  port: 4433,
  host: "0.0.0.0",              // "::" binds dual-stack (IPv4 + IPv6)
                                // on every OS
  tls: { certPem, keyPem },
  limits: {
    maxSessions: 5_000,         // default 2,000; size to what one process holds
    maxHandshakesInFlight: 500, // default 200; bounds simultaneous handshakes, not the rate
    maxDatagramSize: 1_200,     // default; a 1,150 B snapshot part fits
    idleTimeoutMs: 60_000,      // default; a silent player is reaped after this
  },
  rateLimits: {
    // Per client IP, so size them for the most players behind one NAT.
    // handshakesBurst is also the most sessions one IP may hold open at once
    // (default 40), and handshakesBurstPerPrefix the most per /24 or /64
    // (default 100). For 300 players behind one address:
    handshakesBurst: 300,
    handshakesBurstPerPrefix: 1_000,
    // 4 inputs/s × 300 players = 1,200 datagrams/s; the default is 2,000.
    datagramsPerSec: 2_000,
    datagramsBurst: 5_000,
  },
  onSession: (session) => { /* see examples/scenarios/game/server.ts */ },
});
```

What the example does that matters at scale:

- **Spread the tick.** Sending every player's snapshot in the same instant is
  a packet impulse. The example splits each 200 ms tick into ten 20 ms slices
  and sends one tenth of the players per slice. The same applies to clients:
  each player starts at a random phase of its input period.
- **Batch per player.** The three snapshot parts go out in one
  `sendDatagramBatch()` call: one crossing into native code instead of three,
  one backpressure deadline for the call.
- **Reuse buffers.** `sendDatagramBatch()` and `sendDatagramMirror()` copy the
  payload before they return, so per-player snapshot buffers can be allocated
  once and only their header rewritten each tick. In the campaign, allocating
  fresh buffers per tick was the largest cost in the snapshot emitter: reusing
  them raised the share of scheduled snapshots sent on time at 50,000 players
  from 42% to 76.5% (16 processes on a 32-vCPU droplet), and at 25,000 players
  freed about 6 cores.
- **Ack on receipt.** Acks are sent from the datagram read loop, not on the
  next tick, so a player's round trip never waits up to 200 ms for a tick.

## Host tuning

On Linux, raise the UDP socket buffers on the server and on any load-generator
host. These are the values the cloud runs used:

```bash
sudo sysctl -w net.core.rmem_max=26214400 net.core.wmem_max=26214400 \
  net.core.rmem_default=26214400 net.core.wmem_default=26214400 \
  net.ipv4.udp_rmem_min=26214400 net.ipv4.udp_wmem_min=26214400
```

With the default buffers, a synchronized 10,000-session fleet delivered 0.699
of its datagrams, and every lost one was a kernel receive-buffer overflow
counted before the server ever saw it; staggering the senders brought delivery
to 1.000. Watch `nstat -az | grep -E 'Udp(RcvbufErrors|SndbufErrors|InErrors)'`.

For tens of thousands of sessions also raise `fs.file-max` and `ulimit -n`, and
on generator hosts widen `net.ipv4.ip_local_port_range` to `"1024 65535"`.

## Scaling out

A single process held 5,000 players on a 32-vCPU droplet (a
characterization, not graded), with a better tail when the same load was
split over 4 processes. To go further, shard players across processes as
described in [deployment.md](deployment.md). The sketch below is the sharded G6 layout
expressed in public options only. It approximates the campaign's per-process
setup; the campaign's processes also ran the unsupported pieces listed under
Not proven, so this configuration is not the one that held 40,000 players:

```ts
createServer({
  port: 4433,
  tls: { certPem, keyPem },
  reusePort: true,
  quicLb: { serverId: [0, shard], nonceLen: 8 },       // shard = 1..24
  reusePortSteering: {
    sockArrayPinPath: "/sys/fs/bpf/quic-lb/socks",
    key: shard - 1,                                     // sockarray slot
    ...(shard === 1 ? { attachProgPinPath: "/sys/fs/bpf/quic-lb/steer_by_cid" } : {}),
  },
  limits: { maxSessions },
  rateLimits: { /* opened up: the generators were a handful of IPs */ },
  onSession,
});
```

A zone or raid must live on one shard; route players to shards by zone in your
matchmaker.

## What to watch

From `server.metricsSnapshot()` (Prometheus names in [METRICS.md](../METRICS.md)):

- `sessionsActive` against your per-process target.
- `datagramsDropped` and its reasons: `datagramsDroppedRateLimited` means a
  per-IP bucket is too small for a NAT'd population;
  `datagramsDroppedQueueSession` means a session is not being read fast enough.
- `limitExceededCount` bursts during reconnect waves are admission doing its
  job; sustained growth means scale out.
- `handshakeLatency` and `datagramEnqueueLatency` histograms.
- Event-loop lag of each process. The JavaScript loop is the usual ceiling for
  this workload, long before the network.

## Pitfalls

- **The per-IP limits apply to load tests.** A test fleet on one machine is
  one IP, and `handshakesBurst` (default 40) caps the sessions one IP may hold
  open at once: with the defaults, 40 players connect and the rest get
  `E_RATE_LIMITED`. Open the limits for tests; size them for real NATs in
  production.
- **Refused connects are retryable.** At `maxHandshakesInFlight` the server
  refuses the connection; at `maxSessions` it closes the new session. Both
  reject `connect()` with `E_LIMIT_EXCEEDED`. Clients should retry both with
  jittered backoff (see
  OPERATIONS.md,
  [Admission control](../OPERATIONS.md#admission-control-refusal-is-load-shaping-not-rejection),
  and [connection-churn.md](connection-churn.md)).
- **Do not hash UDP 4-tuples in front of the realm.** Plain `SO_REUSEPORT`,
  ECMP or an L4 balancer hashing the 4-tuple strands a player whose address
  changes until the idle timeout (60 s). See [deployment.md](deployment.md).
- **GRO with CID steering.** When many connections share one source address
  and port (load generators do this), the NIC's UDP GRO can merge datagrams of
  different connections into one super-packet that the eBPF program steers by
  the first segment alone. In the campaign this silently lost 12.4% of packets
  at 30,000 sessions from 128 generator ports; `ethtool -K <iface> gro off` on
  the server fixed it. Real players each have their own address and port, so
  this mostly affects tests, but check `steer_stats` and per-shard counters.
- **Datagrams have no delivery guarantee.** Anything that must arrive belongs
  on a stream.

## Re-measure on your hardware

Scale the example up: run the server on the target host, and the client from
one or more other hosts (`--players` per client process, several processes per
generator host so the generator is not the bottleneck). Raise the server's
rate limits to cover the generator IPs. Grade on the client report
(`ackRttP99Ms`, `snapshotDelivery`, `connectFailures`) and on the server's
`datagramsDropped` and the kernel counters above. For plain session scale and
datagram load against several server processes,
[`tools/load/distributed-scale.ts`](https://github.com/vmeansdev/webtransport-bun/blob/main/tools/load/distributed-scale.ts) is
the in-repo driver (configured through `LOAD_SCALE_*` environment variables).
