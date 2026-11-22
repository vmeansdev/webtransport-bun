# Broadcast and live data distribution

This guide is for servers that push the same small update to many long-lived
subscribers: market data for end users, scoreboards, tickers, live dashboards,
browser and mobile consumers of a feed. It is backed by the **paced broadcast
gate** (5,000 subscribers at 5 Hz, passed) and by **G10** (10,000 subscribers at
20 Hz), which passed for 1.0 with a remark: there is no verdict for that shape.
The full measurement table, with hardware for every figure, is in
[CAPACITY.md](../CAPACITY.md).

It is not a tick-to-trade or trading hot-path transport. Every broadcast is
issued from one JavaScript thread in a garbage-collected runtime, the tails
are in milliseconds, and the campaign's instrument could not have observed a
microsecond-scale claim in either direction.

## Workload this guide is proven for

The paced broadcast gate's shape, which is also what the
[example](https://github.com/vmeansdev/webtransport-bun/tree/main/examples/scenarios/broadcast) implements:

| Direction | Rate | Payload | API |
|---|---|---|---|
| Tick, server → every subscriber | 5 Hz per subscriber; 5,000 × 5 = 25,000 datagrams/s | One payload, identical for every subscriber (the example defaults to 200 B) | `server.sendDatagramMirrorPaced()` with `egressPacer: { pps: 30_000 }`, target list rotated between calls |
| Control: same offer, unpaced | 5 Hz, all 5,000 targets in one burst | Same | `server.sendDatagramMirror()` |
| Subscriber → server | none | — | — |

The gate's tick size is not recorded in this repository; the example's 200 B
default is the example's choice.

## What was measured

**Paced broadcast gate: PASS (narrowed).** 5,000 sessions × 5 Hz through the
shipped `sendDatagramMirrorPaced` with `egressPacer` `pps: 30_000` and
round-robin ordering of the target list. The server ran on a 4-core bare-metal
Linux box; the 5,000-session subscriber fleet ran on a separate Mac connected by
a 1 GbE cable. Three paired blocks, each comparing the paced call with the
unpaced control at the same offer:

| | Block 1 | Block 2 | Block 3 |
|---|---|---|---|
| Delivery, paced | 0.997859 | 0.997617 | 0.998633 |
| Delivery, unpaced control (`sendDatagramMirror`, one burst) | 0.9489 | 0.9434 | 0.9625 |
| RTT p50, paced | 0.834 ms | 0.792 ms | 0.763 ms |

- **JS-thread stall per broadcast:** 1.69–1.80 ms paced against 45.0–47.5 ms
  unpaced, about 26× less (median paired difference −44.71 ms). The unpaced
  call does all 5,000 sends before it returns; the paced call hands them to a
  native thread.
- **The burst sheds.** The unpaced control lost 4–6% of the same offer: 5,000
  sends in one call leave the host as a 5,000-packet impulse. Where the
  packets were lost was inferred, not measured (no kernel or NIC counters were
  captured): most likely at the receiving Mac's USB network adapter. Spreading
  those packets is what the pacer is for.
- **Pacer integrity:** late clumps 0.021–0.040%, zero refused targets, zero
  deferred failures. These came from the pacer's internal statistics, which are
  not public API.

**G10, 10,000 subscribers × 20 Hz (200,000 datagrams/s): no verdict.** The
first run, on the earlier VM rig, missed, and that miss was ruled final for
that rig as a hardware-scoped result. The same rig's datagram work found its
ceiling at about 103,000 datagrams/s delivered on one VM, set by the generator
sharing the host, the client's congestion control on loopback and loss in the
hypervisor's virtual switch, not by the server. Every later cloud run
ended without a verdict because of packet loss between NICs inside the
provider's network. G10 passed for 1.0 *with that remark*. The paced gate above
is a different, smaller shape, not a G10 re-run.

**Physical budget.** The receiving end limits this setup before the server
does. The measuring Mac's receive path was clean at about 75,000 packets/s
with smooth arrival and lost 2.1% by 118,000/s; with burst-shaped arrival it
was not clean at any rate tried, 75,000/s included. An inherited "~100,000
packets/s clean" figure held for neither shape. Subscribers × rate must fit
the link and the receiving hosts, not only the server.

### Not proven

- **10,000 subscribers at 20 Hz**, or anything above 25,000 datagrams/s from one
  process through the paced path. G10 has no verdict.
- **A p99.** The arrival-spread clause of the paced gate has no verdict, because
  the measuring Mac was degraded that day, and the off-box RTT p99 from that
  instrument is not a measurement. Only the p50 above stands.
- **The time from tick to the last subscriber.** The RTT above is the campaign
  instrument's round trip, not the age of a tick. A paced tick reaches its last
  subscriber about N / pps after its first (5,000 / 30,000 ≈ 167 ms of each
  200 ms period); that follows from how the schedule works and was not graded.
- **More than one process sharing a pacer budget**, and broadcast across
  processes. The pacer is per process (see [Scaling out](#scaling-out)).
- **Subscribers behind real access networks** (Wi-Fi, cellular, address
  changes). All subscribers were on one cable.
- **Microsecond latency** of any kind.

## Architecture

```
feed / your app ──▶ broadcast server (one Bun process)
                      ├─ tick at R Hz: one payload (seq, send time, data)
                      ├─ sendDatagramMirrorPaced(targets ≤ 10,000 per call, payload)
                      │     └─▶ native egress pacer thread: pps, in clumps of 32
                      │            └─▶ UDP ──▶ subscriber 1 … N
                      └─ each tick: readMirrorReports()
                            E_SESSION_CLOSED → drop from the subscriber list
                            E_QUEUE_FULL     → subscriber had no budget; count or retry
```

The JavaScript thread copies the payload once and hands the whole target list
to a native thread, which releases the datagrams at `pps` instead of in one
burst. Admission (did the schedule take the target) is answered at once;
per-target failures come back later through `readMirrorReports()`.

Datagrams suit values the next tick supersedes. A new subscriber sees nothing
until the next tick, and a lost tick is simply missed; send anything that must
arrive (an initial snapshot, corrections, a trade confirmation) on a stream.

## Run the example

From the repository root, with the native addon built (`bun run build:native`):

```bash
bun examples/scenarios/broadcast/server.ts --port=4433
```

In a second terminal:

```bash
bun examples/scenarios/broadcast/client.ts --url=https://127.0.0.1:4433 --subscribers=300 --seconds=30
```

Server flags: `--mode=paced` (default) or `--mode=mirror` for the unpaced
`sendDatagramMirror`, `--hz=5`, `--bytes=200`, and the pacer's `--pps=30000
--clump=32 --queueMs=250`. The first run generates a throwaway CA and
certificate in `examples/scenarios/.certs/`; both processes use it, and the
client verifies the server against it. To use a real certificate, set
`CERT_PEM`, `KEY_PEM` and (for the client) `CA_PEM` to file paths.

The client counts sequence gaps per subscriber (delivery = received /
expected, where expected spans the first to the last tick that subscriber saw)
and the age of each tick: receive time minus the send time the server stamped
into it. Age compares two processes' clocks, so it only means something when
server and client run on the same host. It includes the pacer's spread.

A 10-second run of each mode, 300 subscribers, both processes on one MacBook
(arm64) with a 1-minute load average of about 28 from other work (65–80 over
5–15 minutes). Paced:

```json
{
  "subscribers": 300,
  "connectFailures": 0,
  "received": 14985,
  "expected": 14985,
  "delivery": 1,
  "sessionsWithGaps": 0,
  "silentSessions": 0,
  "sameHostAgeP50Ms": 5.118,
  "sameHostAgeP99Ms": 10.211
}
```

The server's last counter line for that run (it prints one every 5 seconds and
on Ctrl-C):

```json
{"mode":"paced","subscribers":0,"ticks":50,"offered":14985,"accepted":14985,"refused":0,"reaped":0,"queueFull":0,"sendMsP50":0.093,"sendMsMax":0.798,"datagramsOut":14985,"datagramMirrorCalls":0,"datagramMirrorPacedCalls":50,"datagramMirrorPacedTargets":14985,"mirrorReportsDropped":0}
```

`--mode=mirror` on the same machine: delivery 1 (15,056 of 15,056), age p50
3.71 ms / p99 18.70 ms, and the server's `sendMsP50` 0.436 ms against the paced
0.093 ms. At 300 subscribers the paced age (p99 10.2 ms) is mostly the
schedule's spread, 300 / 30,000 = 10 ms. These runs show the example working;
they are not capacity figures.

Undersizing the pacer is visible too. With `--pps=1000` (300 subscribers × 5 Hz
= 1,500/s needed), the schedule refused 3,992 of 12,079 targets, delivery fell
to 0.68, and because the target list rotates, every subscriber missed some
ticks and none was starved (`sessionsWithGaps` 300, `silentSessions` 0); age
p50 rose to 153 ms.

## Server configuration

```ts
import { createServer } from "@webtransport-bun/webtransport";

const server = createServer({
  port: 4433,
  host: "0.0.0.0",
  tls: { certPem, keyPem },
  // Experimental (may change in a 1.x minor). Process-wide: one schedule and
  // one thread per process; the first configuration the process resolves wins.
  egressPacer: {
    pps: 30_000,   // must cover subscribers × Hz with headroom: 5,000 × 5 = 25,000
    clump: 32,     // datagrams released together, 1–64; 32 is the default
    queueMs: 250,  // admission bound: pps × queueMs / 1000 = 7,500 targets queued
  },
  limits: {
    maxSessions: 6_000,        // default 2,000; 5,000 subscribers need more
    maxDatagramSize: 1_200,    // default cap; the tick must also fit what the path negotiates
  },
  onSession: (session) => {
    subscribers.add(session.id);
    void session.closed.finally(() => subscribers.delete(session.id));
  },
});
```

The tick, as the example's [server](https://github.com/vmeansdev/webtransport-bun/blob/main/examples/scenarios/broadcast/server.ts)
does it:

```ts
const MAX_TARGETS_PER_CALL = 10_000; // both mirror calls throw RangeError above this
let cursor = 0;

setInterval(() => {
  for (const { target, error } of server.readMirrorReports()) {
    if (error.code === E_SESSION_CLOSED) subscribers.delete(target); // the reap list
    // E_QUEUE_FULL: that subscriber had no byte budget when its turn came
  }
  const ids = [...subscribers];
  if (ids.length === 0) return;
  const start = cursor % ids.length;
  const targets = ids.slice(start).concat(ids.slice(0, start));
  writeTick(payload, ++seq, wallMs());
  let admitted = 0;
  for (let i = 0; i < targets.length; i += MAX_TARGETS_PER_CALL) {
    const chunk = targets.slice(i, i + MAX_TARGETS_PER_CALL);
    admitted += server.sendDatagramMirrorPaced(chunk, payload).admitted;
  }
  cursor = start + admitted; // next tick starts at the first subscriber refused
}, 1000 / hz);
```

What matters in it:

- **Size the pacer for the fleet.** Two conditions, both derived from the
  pacer's contract rather than measured: `pps ≥ subscribers × Hz` with
  headroom, or each tick is still draining when the next arrives; and
  `pps × queueMs / 1000 ≥ subscribers`, or one tick does not fit the queue and
  its tail is refused at admission. At 10,000 subscribers × 2 Hz, 30,000 pps
  covers the rate but the default 250 ms holds only 7,500 targets; raise
  `queueMs`. The queue is also capped at 64 MiB of payload and target ids.
- **Rotate the target list.** Admission is a prefix: the schedule takes targets
  in list order until it is full and refuses the rest. Without rotation the same
  trailing subscribers starve under saturation. Starting each tick where the
  previous one stopped admitting spreads the misses.
- **Chunk above 10,000 targets.** Both mirror calls throw `RangeError` past
  10,000 targets, before sending anything. Splitting a list across calls is
  equivalent to one call over the union.
- **Admitted is not delivered.** `{ admitted, refused }` says what the schedule
  took. Delivery is `admitted` minus the failures that later arrive through
  `readMirrorReports()`. Drain it every tick: it returns failures only
  (`E_SESSION_CLOSED` = reap, `E_QUEUE_FULL` = no budget for that subscriber),
  and its ring holds 4,096 entries before it drops the oldest.
- **Reuse the payload buffer.** Both calls copy the payload before they return.
- **Small fleets can skip the pacer.** `sendDatagramMirror(targets, payload)`
  (stable, not experimental) sends synchronously and returns
  `{ sent, failures }` with the same two error codes immediately. At a few
  hundred subscribers its burst and its JS-thread time are small (0.44 ms per
  tick at 300 in the run above); at 5,000 it held the thread for 45–47.5 ms and
  shed 4–6% of the datagrams.

## Host tuning

On Linux, raise the UDP socket buffers on the server and on hosts carrying
large subscriber fleets. These are the values the cloud runs used:

```bash
sudo sysctl -w net.core.rmem_max=26214400 net.core.wmem_max=26214400 \
  net.core.rmem_default=26214400 net.core.wmem_default=26214400 \
  net.ipv4.udp_rmem_min=26214400 net.ipv4.udp_wmem_min=26214400
```

For tens of thousands of sessions also raise `fs.file-max` and `ulimit -n`; on
test hosts that open many client sessions widen
`net.ipv4.ip_local_port_range` to `"1024 65535"`. Watch
`nstat -az | grep -E 'Udp(RcvbufErrors|SndbufErrors|InErrors)'` on both ends:
an unpaced fan-out shows up as `RcvbufErrors` on the receiving side long before
the server looks busy. In a related campaign measurement, a fleet sending in
lockstep delivered 0.699 of its datagrams with every loss a kernel receive
buffer overflow, and 1.000 once the sends were spread.

## Scaling out

One process sources broadcasts from one JavaScript thread, and the pacer's
rate is a per-process budget. When subscribers × rate outgrows one process
(the certified point is 25,000 datagrams/s; nothing above it is graded),
partition subscribers across processes, each on its own port or address and
each with its own pacer sized for its share, and hand each subscriber the
exact URL from your own service. [deployment.md](deployment.md) describes that
pattern; a shared port needs the experimental CID steering in
[quic-lb.md](../quic-lb.md).

Two consequences:

- **Pacers on one host add up.** Two processes at 30,000 pps put 60,000/s on
  the same NIC. Size the sum against the link and the receivers.
- **The feed has to reach every process.** The library has no cross-process
  publish path; each broadcast process needs its own subscription to the
  upstream feed (your message bus, a socket from the publisher).

## What to watch

From `server.metricsSnapshot()` ([METRICS.md](../METRICS.md)). The mirror
counters are not among the series `metricsToPrometheus()` emits; export them
yourself.

- `datagramMirrorPacedCalls` and `datagramMirrorPacedTargets`: calls and
  targets offered to the pacer. `offered − admitted` is what admission refused;
  a non-zero refusal rate means the pacer is undersized or the queue is too
  short.
- `mirrorReportsDropped`: failure reports lost because `readMirrorReports()`
  was not drained fast enough. Should stay 0. Process-wide.
- `datagramMirrorCalls` and `datagramMirrorTargets`: the same for the unpaced
  `sendDatagramMirror`.
- `datagramsOut` (Prometheus `webtransport_datagrams_out`), and per subscriber
  `session.metricsSnapshot().datagramsOut`: delivery to quinn, counted the
  same way for every send path. `admitted − (E_SESSION_CLOSED + E_QUEUE_FULL
  reports)` should match its growth.
- `sessionsActive` (`webtransport_sessions_active`) against `maxSessions`.
- The JS-thread time per tick (the example's `sendMsP50` / `sendMsMax`) and
  event-loop lag.
- Kernel UDP counters on both ends (above).

## Pitfalls

- **The pacer is process-wide and the first configuration wins.** A second
  `createServer` in the same process asking for a different `egressPacer`
  fails with `E_INVALID_ARGUMENT`; the identical one is accepted. If no server
  passes the option, `WEBTRANSPORT_PACER_PPS` (with
  `WEBTRANSPORT_PACER_CLUMP` / `WEBTRANSPORT_PACER_QUEUE_MS`) is read on first
  use. A test suite that starts several servers in one process shares one
  pacer.
- **No pacer, no paced call.** Without `egressPacer` or the environment
  variable, `sendDatagramMirrorPaced` throws a `WebTransportError` with code
  `E_UNSUPPORTED_ARGUMENT` rather than sending unpaced.
- **The unpaced mirror at thousands of subscribers.** It is one burst per
  tick: in the gate it shed 4–6% and held the JS thread for ~45 ms at 5,000
  subscribers.
- **A lockstep fleet is an impulse.** The pacer spreads one process's egress;
  it does not help if several processes or many publishers fire on the same
  timer.
- **Experimental surfaces.** `egressPacer`, `sendDatagramMirrorPaced`,
  `readMirrorReports` and their metrics may change in a 1.x minor
  ([SPEC.md](../SPEC.md#experimental-surfaces)). `sendDatagramMirror` is
  stable.
- **Per-IP rate limits apply to load tests.** A subscriber fleet on one machine
  is one IP, and `handshakesBurst` (default 40) caps the sessions one IP may
  hold open at once: with the defaults, 40 subscribers connect and the rest get
  `E_RATE_LIMITED` (HTTP 429). The example's CLI server opens the buckets.
- **Payloads above the datagram size fail per target, not per call.** A tick
  longer than `maxDatagramSize` (or the size the path negotiated) is still
  admitted by the paced call, then reported as `E_QUEUE_FULL` for every
  subscriber (the unpaced call returns the same failures at once). Running the
  example with `--bytes=1300` shows it: 75 of 75 targets admitted, 75
  `E_QUEUE_FULL` reports, nothing delivered. Keep ticks small; the game example
  uses 1,150 B as its largest datagram.
- **Age across hosts is meaningless.** The example's age compares the server's
  clock with the client's. Off-host, use delivery, or add a round-trip probe.

## Re-measure on your hardware

Run the example's server on the target host and the client from one or more
other hosts: several client processes per host so the subscriber side is not
the bottleneck, `--subscribers` per process, and the server's rate limits
opened for the client IPs. Set `--hz`, `--bytes` and `--pps` to your shape,
compare `--mode=paced` against `--mode=mirror` at the same offer, and grade on
the client report (`delivery`, `sessionsWithGaps`, `silentSessions`), the
server's `refused`, `queueFull`, `sendMsP50` / `sendMsMax` and
`mirrorReportsDropped`, and the kernel UDP counters. Off-host, ignore the age
fields.

The harness that produced the gate figures is not in this repository. For the
cost of the native crossing alone (no transport),
[`tools/bench/mirror-send/fanout-bench.ts`](https://github.com/vmeansdev/webtransport-bun/blob/main/tools/bench/mirror-send/fanout-bench.ts)
compares per-target sends with mirror shapes at 10 to 10,000 targets. It loads
its own small addon from `tools/bench/mirror-send/fanout-bench.node`: run
`cargo build --release` in `tools/bench/mirror-send/fanout`, then copy
`target/release/libfanout_bench.dylib` (`.so` on Linux) from there to that
path.
