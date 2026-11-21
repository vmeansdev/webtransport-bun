# Connection churn: short visits, reloads and reconnect storms

This guide is for servers whose sessions come and go constantly: mobile apps
that connect for a few seconds, web pages that reload, clients that drop and
redial when the network blips. The cost here is the session lifecycle
(handshake, admission, teardown), not the traffic, and the questions are
whether the server keeps up with the arrival rate, whether the users who stay
connected notice, and whether every closed session is fully released. It is
backed by gate **G9** (sustained churn) and by the reconnect-storm arm of
**G6** (MMO realm). The full measurement table, with hardware for every
figure, is in [CAPACITY.md](../CAPACITY.md).

## Workload this guide is proven for

The G9 shape, which is also what the
[example](../../examples/scenarios/churn/) implements:

| Population | Rate | Payload | API |
|---|---|---|---|
| Base: long-lived sessions | one ping every ~200 ms per session, phases spread, echoed by the server | 32 B datagram | `connect()`, `session.sendDatagram()` |
| Churners: new sessions | R per second, spread evenly over each second; each does one ping exchange, then closes | 32 B datagram | `connect()`, `session.close()` |
| Refused or failed dials | retried with jittered exponential backoff | — | client code (see below) |

The G6 reconnect storm is a different shape: a realm of established sessions,
a slice of which is severed at once and redials together.

## What was measured

| Gate | Result | Hardware and topology |
|---|---|---|
| G9 sustained churn | **PASS at 600 sessions/s**, final. Achieved **595.75 / 596.01** sessions/s against a 594/s bar. The base population kept RTT p99 at **7.09 / 12.60 ms** against a 40 ms bar, delivery **0.99952**, **zero** leaked sessions and native handles, and the limits check passed | Home rig: a 4-core / 8-thread bare-metal Linux box, ~12 GB RAM, performance governor |
| G6 reconnect storm, sharded | A 40,000-session realm with **8,000** sessions severed and reconnected: **8,000 / 8,000** re-accepted within **+2.41 s**, survivors' ack RTT p99 **7.82 ms**. A full **40,000 / 40,000** reconnect completed by **+4.55 s** (characterization only, not graded). Ran on a campaign build with pieces outside the supported library (see [realtime-games.md](realtime-games.md#not-proven)) | 24 server processes sharing one port on a DigitalOcean 48-vCPU droplet, generators on a second one, same VPC |
| G6 reconnect storm, one process | **Missed**, at 1,000 and at 5,000 sessions. Confounded: the same home-rig setup whose generator machine was later shown to drop its own packets under full-duplex load | Single instance on the home rig, generator on a separate machine over a cable |

Unless stated otherwise, home-rig figures had the load generator and the
server on the same box over loopback, so they are upper bounds on what one
instance costs, of unknown tightness: the generator's share of the box was
not measured.

**Finding F-1.** Under concurrent churn ramps, one base-population connect was
refused in 3 of 5 cells. That is not a defect: refusals at `maxSessions` and
`maxHandshakesInFlight` are the server shaping load, and clients are expected
to retry them with jittered backoff (see
[OPERATIONS.md, "Admission control"](../OPERATIONS.md#admission-control-refusal-is-load-shaping-not-rejection)).
The example does exactly that.

### Not proven

- **A reconnect storm at thousands of sessions on one process.** The single
  instance missed at 1,000 and 5,000, but on a generator-confounded rig, so
  that miss does not show where one process's limit is. A storm at that scale
  is only proven on the sharded deployment in [deployment.md](deployment.md).
- **Churn above 600 sessions/s per process**, or any churn figure on hardware
  other than the home rig.
- **0-RTT under churn.** `enable0Rtt` exists, but no campaign measured it
  (see "Pitfalls").
- **Client address changes** (Wi-Fi to cellular, NAT rebinding) mid-session.
  No test in this project exercises one.
- **Real NAT populations.** Every figure came from generators on a few IP
  addresses with the per-IP limits opened up. How the defaults behave for
  users behind a carrier-grade NAT is reasoned from the source below, not
  measured.

## Architecture

```
base clients ──┐                       churn server (one Bun process)
 (stay, ping)  ├──UDP 4433──▶ admission: maxHandshakesInFlight → per-IP
churners ──────┘               limits → maxSessions → onSession: datagram echo
 (connect, 1 ping, close)            │
       ▲                             └─ refused? QUIC CONNECTION_REFUSED,
       └──── jittered backoff ◀──────    HTTP 429, or close 3992
```

The server does almost nothing per session; that is the point. Everything a
session holds (registry entry, tasks, rate-limit slots, stream handles) has to
be released when it closes, or a server that churns at hundreds of sessions
per second runs out of it within minutes.

## Run the example

From the repository root, with the native addon built (`bun run build:native`):

```bash
bun examples/scenarios/churn/server.ts --port=4433
```

In a second terminal:

```bash
bun examples/scenarios/churn/client.ts --url=https://127.0.0.1:4433 --base=200 --rate=200 --seconds=15
```

The server takes `--port`, `--host`, `--maxSessions` (default 2,000) and
`--maxHandshakesInFlight` (default 200). The client takes `--url`, `--base`
(base sessions), `--rate` (churn sessions per second), `--seconds` and
`--pingMs` (base ping interval, default 200). The first run generates a
throwaway CA and certificate in `examples/scenarios/.certs/`; both processes
use it, and the client verifies the server against it. To use a real
certificate, set `CERT_PEM`, `KEY_PEM` and (for the client) `CA_PEM` to file
paths.

Check that the server is the one receiving the sessions: it prints its
counters every 2 seconds, including `accepted`. A client pointed at the wrong
port can connect to another server that trusts the same dev CA without any
error.

The client prints a report when it finishes:

```json
{
  "targetPerSec": 200,
  "achievedPerSec": 199.84,
  "churnLaunched": 2998,
  "churnEstablished": 2998,
  "churnGaveUp": 0,
  "churnSkipped": 0,
  "churnUnfinished": 0,
  "connectRetries": 0,
  "connectFailures": {},
  "connectP50Ms": 7.45,
  "connectP99Ms": 47.47,
  "firstPingTimeouts": 0,
  "baseSessions": 200,
  "baseConnected": 200,
  "baseLost": 0,
  "baseGaveUp": 0,
  "basePingsSent": 14946,
  "baseDelivery": 1,
  "baseRttP50Ms": 0.74,
  "baseRttP99Ms": 6.13
}
```

That sample is a 15-second run on an Apple M1 Max (10 cores) with a load
average of about 30 from other work, both processes on one machine. It shows
the example working; it is not a capacity figure. The server's last lines
after the client exited:

```json
{"acceptedPerSec":200,"accepted":3193,"open":202,"limitExceededCount":0,"rateLimitedCount":0,"sessionsClosedByIdle":0,"sessionsClosedOther":2992,"sessionsActive":201,"handshakesInFlight":0,"sessionTasksActive":0,"nativeSessionRegistryEntries":201,"nativeTrackedTasks":1004,"nativeRateLimitEntries":4,"nativeBidiHandlesLive":0,"nativeUniSendHandlesLive":0,"nativeUniRecvHandlesLive":0}
{"acceptedPerSec":0,"accepted":3198,"open":0,"limitExceededCount":0,"rateLimitedCount":0,"sessionsClosedByIdle":0,"sessionsClosedOther":3198,"sessionsActive":0,"handshakesInFlight":0,"sessionTasksActive":0,"nativeSessionRegistryEntries":0,"nativeTrackedTasks":1,"nativeRateLimitEntries":2,"nativeBidiHandlesLive":0,"nativeUniSendHandlesLive":0,"nativeUniRecvHandlesLive":0}
```

`accepted` is 3,198 = 200 base + 2,998 churners. During the run
`sessionsActive` sits at the base count plus the churners in flight; once the
client has closed everything it is 0. The idle values on this machine were
`nativeSessionRegistryEntries` 0, `nativeTrackedTasks` 1 and
`nativeRateLimitEntries` 2 (see "What to watch" for why that one is not 0).

To see refusals and retries, start the server with a tiny handshake cap and
run the same client:

```bash
bun examples/scenarios/churn/server.ts --port=4433 --maxHandshakesInFlight=4
```

On the same machine that gave `"connectRetries": 28`,
`"connectFailures": {"E_INTERNAL (CONNECTION_REFUSED)": 28}` and still
`churnGaveUp: 0`, `baseConnected: 200`: every refused dial came back through
the backoff and got in. The server's `limitExceededCount` was also 28.

## Retry refused connects

This is the part of the example to copy into a real client. The server's
admission refusals mean "not right now". A client that gives up on the first
one turns a sub-second load spike into an outage; a client that retries on a
fixed timer comes back as the same synchronized wave it was refused for.

```ts
import { connect } from "@webtransport-bun/webtransport";

const policy = { attempts: 6, baseMs: 200, maxMs: 5000 };

// Exponential, capped, ±50% jitter. The jitter is what spreads the retry.
function backoffMs(n: number) {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** n);
  return ceiling * (0.5 + Math.random());
}

async function connectWithRetry(url: string, caPem: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect(url, { tls: { caPem } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "E_TLS" || attempt + 1 >= policy.attempts) throw err; // a bad certificate does not heal
      await Bun.sleep(backoffMs(attempt));
    }
  }
}
```

What each refusal looks like to a client, checked against this version:

| Server condition | On the wire | `connect()` rejects with | Server counter |
|---|---|---|---|
| Per-IP or per-prefix handshake limit | HTTP 429 on the CONNECT | `E_RATE_LIMITED` | `rateLimitedCount` |
| `maxHandshakesInFlight` reached | QUIC `CONNECTION_REFUSED` | `E_INTERNAL`, message "the server refused to accept a new connection" | `limitExceededCount` |
| `maxSessions` reached | handshake completes, then close code `3992` / reason `E_LIMIT_EXCEEDED` | `E_LIMIT_EXCEEDED` (rarely: the session opens and closes with 3992 right away, or a plain `Error` without a code; see "Pitfalls") | `limitExceededCount` |

Treat all three as retryable. Only repeated exhaustion of the retry budget is
an outage. The example also treats a session that closes before answering its
first ping as a refused dial and retries it, which covers the `maxSessions`
race.

## Server configuration

```ts
import { createServer } from "@webtransport-bun/webtransport";

const server = createServer({
  port: 4433,
  host: "0.0.0.0",              // "::" takes IPv6, plus IPv4 on Linux
                                // and macOS (on Windows since PR #22)
  tls: { certPem, keyPem },
  limits: {
    maxSessions: 2_000,         // default; base population + churners in flight + headroom
    maxHandshakesInFlight: 200, // default; caps simultaneous handshakes, not the rate
    handshakeTimeoutMs: 10_000, // default; a stalled handshake holds its slot this long
    idleTimeoutMs: 60_000,      // default; a client that vanishes without close() is reaped after this
  },
  rateLimits: {
    handshakesPerSec: 20,         // default; per client IP, token bucket refill
    handshakesBurst: 40,          // default; bucket size AND max concurrent sessions per IP
    handshakesBurstPerPrefix: 100, // default; max concurrent sessions per /24 (IPv4) or /64 (IPv6)
  },
  onSession: (session) => { /* see examples/scenarios/churn/server.ts */ },
});
```

The defaults are in `DEFAULT_LIMITS` and `DEFAULT_RATE_LIMITS` (exported from
the package). What they mean for churn:

- **`maxHandshakesInFlight` bounds concurrency, not rate.** A handshake that
  finishes in ~10 ms frees its slot quickly, so 200 slots sustain hundreds of
  new sessions per second. G9 ran 600/s against this default. What it refuses
  is a wave deeper than 200 arriving at once.
- **`handshakesBurst` is two limits.** It is the size of the per-IP handshake
  token bucket, and the same number caps how many sessions one IP may hold
  open at once (`crates/native/src/rate_limit.rs`,
  `try_acquire_per_ip_session_with_prefix`; the slot is released when the
  session closes). With the defaults, one address gets at most 40 concurrent
  sessions, and one /24 at most 100. Checked on this version: dialling 60
  sessions one by one at 10 per second from 127.0.0.1, 40 stayed open and the
  other 20 were refused with `E_RATE_LIMITED`.
- **`maxSessions`** counts admitted sessions. Size it for
  the base population plus the churners alive at any moment (rate × session
  lifetime), plus headroom for a reconnect wave.

### Sizing the per-IP limits

The defaults assume one user per IP. Size them for the address, not the user:

- **Behind a NAT or carrier-grade NAT**, many users share one public address,
  and often one /24. A mobile carrier can put thousands of users behind a
  handful of addresses. Set `handshakesBurst` and `handshakesBurstPerPrefix`
  to the most concurrent sessions you expect from one address and one prefix,
  and `handshakesPerSec` to their reconnect rate. After a network blip, every
  user behind that NAT redials in the same second. With the defaults, the
  41st session from a carrier address is refused for as long as 40 others are
  open, however slowly it dials. This project has not measured real NAT
  populations; the advice is reasoned from the source above.
- **In a load test**, the whole fleet is one IP. Open the buckets (the example
  CLI sets `handshakesPerSec` 10,000, `handshakesBurst` and
  `handshakesBurstPerPrefix` 100,000) or the test measures the rate limiter,
  not the server.

## Host tuning

On Linux, raise the UDP socket buffers on the server and on any load-generator
host. These are the values the cloud runs used:

```bash
sudo sysctl -w net.core.rmem_max=26214400 net.core.wmem_max=26214400 \
  net.core.rmem_default=26214400 net.core.wmem_default=26214400 \
  net.ipv4.udp_rmem_min=26214400 net.ipv4.udp_wmem_min=26214400
```

A reconnect storm is a packet impulse: thousands of Initial packets in the
same instant. A fleet that sends in lockstep overflows the kernel UDP receive
buffer before the server is busy (a synchronized 10,000-session fleet
delivered 0.699, and every lost packet was a kernel `RcvbufErrors`; staggered,
it was 1.000). Watch `nstat -az | grep -E 'Udp(RcvbufErrors|SndbufErrors|InErrors)'`.

For large fleets also raise `fs.file-max` and `ulimit -n`. On generator hosts,
widen `net.ipv4.ip_local_port_range` to `"1024 65535"`: every churned client
session uses a fresh local port.

## Scaling out

A reconnect storm at the scale of thousands of sessions is only proven on the
sharded deployment: 24 processes on one port re-accepted 8,000 of 8,000 within
2.41 s. The single instance missed at 1,000 and 5,000 sessions, on a rig whose
generator confounded the result, so that miss is not a measured limit. The layouts,
and the steering that keeps sessions on their process, are in
[deployment.md](deployment.md) and [quic-lb.md](../quic-lb.md).

Do not put a balancer that hashes UDP 4-tuples (plain `SO_REUSEPORT`, ECMP) in
front of long-lived sessions: a client whose address changes is steered to a
process that does not know it, and its session stalls until the idle timeout
(60 s by default). Churners that live for a second are not hurt by this; the
base population is.

## What to watch

From `server.metricsSnapshot()` (Prometheus names in
[METRICS.md](../METRICS.md)):

- **Admission:** `limitExceededCount` (`webtransport_limit_exceeded_total`)
  and `rateLimitedCount` (`webtransport_rate_limited_total`). A burst that
  coincides with a reconnect wave and drains within seconds is admission doing
  its job. Steady growth under steady load means scale out or raise the cap.
  A steady `rateLimitedCount` from real users usually means a NAT'd
  population hitting the per-IP limits.
- **Handshakes:** `handshakesInFlight` against `maxHandshakesInFlight`, and
  the `handshakeLatency` histogram
  (`webtransport_handshake_latency_seconds`; OPERATIONS.md alerts at p99 over
  300 ms).
- **Why sessions end:** `sessionsClosedByIdle` (the peer vanished without
  closing), `sessionsClosedByReap` (this server closed it on shutdown) and
  `sessionsClosedOther` (peer close, transport error). Under healthy churn,
  `sessionsClosedOther` grows with the churn and `sessionsClosedByIdle` stays
  small. A large idle count means clients are not calling `close()`, and each
  of those sessions held its slot for 60 s. These three are snapshot-only, not
  in the Prometheus export.
- **Leak gauges** (native only; the example server prints them):
  `sessionsActive`, `nativeSessionRegistryEntries`, `nativeTrackedTasks`,
  `nativeRateLimitEntries`, `nativeBidiHandlesLive`,
  `nativeUniSendHandlesLive`, `nativeUniRecvHandlesLive`. After the churn
  stops they should fall back to the surviving population, and to their idle
  values once every client is gone. On the example run, idle was 0 / 0 / 1 /
  2 / 0 / 0 / 0. `nativeTrackedTasks` does not reach 0 because the accept loop
  is itself a tracked task. `nativeRateLimitEntries` holds the per-IP token
  buckets, which the addon sweeps every 60 s once they have been idle for 5
  minutes, so a few entries per recent client address linger; growth without
  bound is the leak signal, not a non-zero value. The stream handle gauges
  count the whole process, client streams included. The tracked-task, rate-limit
  and stream-handle gauges are not in the Prometheus export; read them from
  `metricsSnapshot()`.

## Pitfalls

- **`CONNECTION_REFUSED` arrives as `E_INTERNAL`.** A dial refused at
  `maxHandshakesInFlight` rejects with code `E_INTERNAL` and the message "the
  server refused to accept a new connection". There is no stable code for it
  yet, so a client that retries only named codes skips the case documented as
  the most common one. Retry `E_INTERNAL` on connect too.
- **The `maxSessions` refusal can arrive as a plain `Error`.** The server
  completes the handshake and then closes with 3992. Usually `connect()`
  rejects with `E_LIMIT_EXCEEDED`. When the close lands between the native
  connect and the JavaScript side taking the session, it rejects with
  `Error("connect: handle not found in registry")` and no `code` (5 of about
  4,800 refusals in a local run against `--maxSessions=201`). The example
  counts those as `unknown` and retries them.
- **Close sessions explicitly.** A client that leaves (page unload, app
  backgrounded) without `close()` keeps its server session, its
  `maxSessions` slot and its per-IP slot until the idle timeout, 60 s by
  default. At 600 sessions/s that is 36,000 abandoned sessions alive at once.
  A lower `idleTimeoutMs` reaps them sooner; make sure clients that are still
  there send something more often than that (this library's client sends a
  keep-alive every `keepAliveIntervalMs`, by default a third of its own
  `idleTimeoutMs`).
- **Planned restarts are not an outage.** `server.close()` ends sessions with
  close code `3993`, reason `E_SERVER_CLOSING`: clients can reconnect at once
  instead of treating it as a failure, with the same jittered backoff. To move
  clients off before closing, `session.drain()` (WT_DRAIN_SESSION) and
  `session.goAway()` (GOAWAY) both resolve the peer's `draining` promise while
  the session stays usable (see [SPEC.md](../SPEC.md)). Spread a fleet-wide
  restart, or every client redials in the same second.
- **0-RTT is replayable.** `enable0Rtt` on both sides lets a returning client
  send its CONNECT as TLS early data, which can cut reconnect latency, but an
  attacker who captured that early data can replay it. Read
  [SECURITY.md, "Native 0-RTT / early data"](../../SECURITY.md#native-0-rtt--early-data-anti-replay)
  before turning it on. Tickets live in process memory, so a reconnect to a
  different instance falls back to a full handshake. No campaign has measured
  0-RTT under churn.
- **One test IP hits the per-IP limits.** With the defaults a load test from
  one machine gets 40 concurrent sessions and 20 handshakes per second.
- **Watch the generator, not only the server.** A churn generator spends most
  of its time in handshakes too. If `churnSkipped` or `churnUnfinished` is
  non-zero, or `achievedPerSec` falls short while the server's
  `handshakesInFlight` is low, the generator is the bottleneck.

## Re-measure on your hardware

Scale the example up: run the server on the target host and the client from
one or more other hosts. Split the target rate across several client
processes per generator host (one JavaScript thread per process is the usual
ceiling), and open the server's per-IP limits to cover the generator
addresses. Grade on the client report (`achievedPerSec` against
`targetPerSec`, `baseRttP99Ms`, `baseDelivery`, `baseLost`, `churnGaveUp`,
`connectFailures`) and on the server: after the run, `sessionsActive` and the
leak gauges must return to idle, and the kernel UDP error counters above must
stay flat. The G9 bar is a useful template: achieved rate within 1% of the
target, base RTT p99 under 40 ms, zero leaked sessions and handles.

In-repo tools that cover parts of this:
[`tools/bench/handshake-latency.ts`](../../tools/bench/handshake-latency.ts)
(`bun run bench:handshake`) measures connect p50/p95/p99 for a single sequence
of handshakes, and
[`tools/load/soak-addon.ts`](../../tools/load/soak-addon.ts) has a
`reconnect-churn` phase in its long-running soak. The G9 and G6 campaign
drivers are not in this repository.
