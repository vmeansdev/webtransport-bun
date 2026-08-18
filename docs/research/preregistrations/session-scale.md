# Pre-registration — Axis: session-scale

**Base commit:** `5ad0245` (`rebind4-staging` tip).
**Probe branch:** `probe/session-scale-01` (never-merge).
**Runner:** heavy self-hosted `[self-hosted, Linux, X64, heavy]`, 4 vCPU / 8 GB. No runner config changes.
**Written before any harness code.** Post-hoc edits to this document are findings against the author.

## Question

Every measurement this project has taken used exactly 100 concurrent sessions.
This axis varies **session count and nothing else**, at a deliberately low
per-session datagram rate, and reports the shape of the cost curve: per-rung
server RSS, committed (RssAnon+VmSwap), fd count, CPU, accept latency / accept
rate, and steady-state delivery.

Settled and not re-derived here: the ~103k datagrams/s delivered ingest ceiling
(`docs/research/2026-08-18-bandwidth-ceiling-attribution.md`). Falsified levers
(coresplit/taskset, rmem raises, BBR) are not used and not re-proposed. This is a
measurement, not an optimization: any lever discovered is recorded in the run
notes and not acted on.

## Ladder (fixed before dispatch)

Session-count rungs, in order:

```
100, 1000, 5000, 10000, 25000, 50000
```

Per-session profile, **identical at every rung** (this is what makes session
count the only variable):

| Knob | Value | Why |
|---|---|---|
| datagram interval | 5000 ms (0.2 datagrams/s/session) | Strava-style GPS/telemetry shape from the axis brief |
| payload | 100 bytes | telemetry-sized, not MTU-sized |
| direction | client -> server only, **no echo** | fan-in shape; also keeps aggregate pps far from the settled ceiling |
| steady hold | 120 s per rung | |
| idle tail | 30 s per rung, no application sends | isolates idle per-session cost (client QUIC keep-alive still runs — that *is* the idle cost) |
| settle between rungs | 15 s | queues drain, CPU baseline resets |

Aggregate offered rate at the top rung is 50 000 x 0.2 = **10 000 datagrams/s**,
about one tenth of the settled ~103k ceiling. If a rung's verdict is driven by
packet rate rather than session count, the harness has failed, not the server.

Source identities: the client opens a fixed **64 client endpoints**, each bound
to a distinct loopback address `127.0.<k>.1` (k = 1..64), so 64 distinct `/24`
prefixes and 64 distinct `IpAddr` rate-limit keys exist at **every** rung.
Endpoint count is constant across rungs on purpose — varying it would add a
second variable.

### What the ladder deliberately does not measure

The alloc-hygiene `IpAddr` rate-limit key change is **already landed on the base**
(`79f0f2b`); this run measures the landed state and does not re-litigate it. With
an `IpAddr` key the limiter map is bounded by **distinct peer IPs, not session
count**, so "rate-limiter map growth vs sessions" is not a question this axis can
answer with a co-resident generator. It is held constant at 64 keys and reported
as such. Answering map-growth-at-10k-distinct-peers honestly needs 10k source
IPs, which is out of scope here and recorded as a cut, not silently dropped.

## Limiter configuration (so we measure the server, not the limiter)

At every rung the server is configured strictly above the load:
`maxSessions = sessions * 2`, `maxHandshakesInFlight = sessions * 2`,
`handshakesPerSec / handshakesBurst / handshakesBurstPerPrefix` >= `sessions * 2`
(note: in this codebase `handshakesBurst` also caps **concurrent sessions per
peer IP** and `handshakesBurstPerPrefix` caps them per `/24`),
`datagramsPerSec` >= 8x the aggregate offered rate, `maxStreamsGlobal` unused
(zero streams in this profile).

If `rateLimitedTotal > 0` or `limitExceededTotal > 0` at any rung, that rung is
**invalid**, not a capacity number (bucket `limiter-contaminated`, below).

## Classifier buckets (mechanical, applied per rung)

Inputs, all measured:

- `connectedRatio = sessionsOk / sessionsRequested`
- `offeredRatio  = clientDatagramsSent / (sessionsOk * steadySeconds / 5)` — how much of the intended offered load the generator actually sourced
- `deliveryRatio = serverDatagramsReceivedDuringSteady / clientDatagramsSent`
- `serverCpuPct`, `hostCpuPctMedian` (percent of one core; 4 vCPU => 400 max)
- `clientCpuPct`, `clientRssMb` (the generator's own footprint — co-residence honesty)
- `serverRssMb`, `serverCommittedMb`, `serverFdCount`
- `rateLimitedTotal`, `limitExceededTotal` (server metrics snapshot deltas)
- `hostMemAvailableMbMin`

Buckets, evaluated **in this order**; the first match wins:

| # | Bucket | Rule |
|---|---|---|
| 1 | `harness-error` | the rung threw, or `sessionsOk == 0` |
| 2 | `limiter-contaminated` | `rateLimitedTotal > 0` or `limitExceededTotal > 0` — configuration error, rung invalid |
| 3 | `generator-limited` | `offeredRatio < 0.90` **or** (`connectedRatio < 0.99` and server reported zero rejections) — the client could not source the rung. **STOP condition, see below** |
| 4 | `host-memory-limited` | `hostMemAvailableMbMin < 500` or `serverRssMb + clientRssMb > 6500` |
| 5 | `accept-limited` | connect phase wall time > 120 s (accept rate itself is the finding; steady-state numbers for the rung are still reported but flagged) |
| 6 | `server-limited` | `deliveryRatio < 0.95` or `serverCpuPct >= 300` |
| 7 | `host-limited` | `hostCpuPctMedian >= 360` (>=90% of 4 vCPU) with both `serverCpuPct < 300` and `clientCpuPct < 300` |
| 8 | `ok` | `connectedRatio >= 0.99` and `offeredRatio >= 0.90` and `deliveryRatio >= 0.95` |

Anything that reaches the end without matching `ok` is `unclassified` and is
treated as `incomplete`, never as a capacity number.

## STOP conditions (make a rung *incomplete*, not a number)

- **S1 — generator saturation (canonical).** `offeredRatio < 0.90`. The rung and
  every rung above it are reported `incomplete-unless-off-box`. A server number
  is never quoted from a generator-limited rung. **Pre-registered now, before the
  run: the 25 000 and 50 000 rungs are expected to be the ones at risk**, because
  the generator is co-resident on the same 4 vCPU / 8 GB runner and the off-box
  generator (`v-ubuntu-loadgen`, 3 vCPU / 1280 MB static) is *smaller*, so it is
  not an automatic rescue. These rungs stay in the ladder at full size; they are
  not quietly lowered.
- **S2 — memory co-residence.** `serverRssMb + clientRssMb > 6500` on an 8 GB
  host: server and client memory are competing, and the server number is
  contaminated. Rung `incomplete`.
- **S3 — host memory floor.** any sample with `MemAvailable < 500 MB` aborts the
  remainder of the ladder; unrun rungs are reported `not-run`, never extrapolated.
- **S4 — limiter contamination.** any rung with `rateLimitedTotal > 0` or
  `limitExceededTotal > 0` is invalid (bucket 2); it measures configuration.
- **S5 — connect timeout.** connect phase exceeding 300 s aborts that rung
  (`harness-error`) and the ladder stops.

Ephemeral-port exhaustion is called out in the axis brief. On inspection it does
**not** apply in the expected form: the client uses shared QUIC endpoints (one
UDP socket per endpoint, connections demultiplexed by connection ID), so 50 000
sessions consume 64 sockets, not 50 000 ports. The pre-registered expectation is
therefore that fd count is flat in session count on **both** sides; if it is not,
that itself is the finding. `serverFdCount` is recorded per rung to test it.

## Deliverable and how the curve is read

Per rung: `sessions, bucket, connectedRatio, offeredRatio, deliveryRatio,
acceptP50/P99/maxMs, acceptsPerSec, connectWallSec, serverRssMb,
serverCommittedMb, serverFdCount, serverCpuPct(steady), serverCpuPct(idle),
hostCpuPctMedian, clientRssMb, clientCpuPct, rateLimitedTotal, limitExceededTotal`.

Derived, and pre-registered as the actual answer:

- **marginal per-session cost** between consecutive `ok` rungs:
  `(committedMb[i] - committedMb[i-1]) / (sessions[i] - sessions[i-1])`, in KB/session.
- **linearity verdict**: linear if every marginal cost between `ok` rungs is
  within 2x of the 100->1000 marginal. Otherwise a **knee** is declared at the
  first rung whose marginal cost is outside that band, and the run reports which
  measured quantity moved with it (CPU, fd, delivery, accept latency).
- **idle per-session cost**: `serverCpuPct(idle) / sessions`, in millicores per
  1000 sessions.

Linearity and the knee are reported only across rungs classified `ok`. A knee
that coincides with a `generator-limited` rung is reported as a generator
artifact, explicitly not as a server knee.

## Addendum — measurement hygiene fixed during harness build

Added while building the harness and **before any run on the runner**, from the
local macOS smoke. Recorded here rather than silently, because each one changes
a number the classifier reads. None of them moves a threshold.

1. **First-tick suppression.** tokio's `interval` fires immediately, which gave
   every session one extra send per rung and pushed `offeredRatio` to 1.06 in
   the smoke. The generator now starts one interval in
   (`interval_at(now + interval)`), so `offeredRatio` cannot run rich and hide a
   saturated generator behind an inflated numerator.
2. **Phase-boundary ordering.** The client switches sessions to idle, waits
   250 ms for every task to observe it, and only then snapshots its send
   counter and prints the marker. Without this, sends racing the phase change
   were counted by the server but not the client, giving `deliveryRatio > 1`.
3. **Drain grace.** The harness closes the server-side steady window 1000 ms
   after the client's idle marker. Datagrams still in flight at the boundary
   were otherwise booked as loss — the smoke read 0.941 delivery on a lossless
   loopback path, which would have mis-bucketed a clean rung as `server-limited`.
   The grace is borrowed from the idle phase, which sends nothing, so it cannot
   import load into the steady window.
4. **Source-IP fallback.** If binding `127.0.<k>.1` fails, that endpoint falls
   back to the default bind instead of aborting the run, and the report stamps
   `distinctSourceIps` — so a run with fewer distinct rate-limit keys than
   intended is visible rather than assumed. (macOS needs interface aliases for
   these addresses and reports 0; Linux routes all of `127/8` to `lo`.)
5. **Curve memory metric.** Committed (RssAnon+VmSwap) is used when available
   and RSS otherwise, and which one was used is stamped as `memoryMetric`. On
   the runner this is always `committed`; the fallback exists so the local smoke
   produces a parseable curve, and smoke numbers are never results.

## Amendment 1 — S3 abort threshold raised to 1000 MB, sampled continuously

**Written 2026-08-18, after the first dispatch and before any measurement data
existed.** Run `32168754965` produced **zero artifacts**: no rung JSON, no CSV,
no log. Nothing in this amendment is informed by a measured number, because
there is no measured number to be informed by.

**What happened.** The ladder failed roughly 29 minutes in, on the 4 vCPU / 8 GB
heavy runner. Bench processes survived job teardown, total memory demand reached
about 10.8 GB against 8 GB of assigned RAM, and the host went into swap-death:
`sshd` and the runner listener were killed and the VM had to be force-restarted
from the hypervisor. Everything the run had completed was lost with it.

**The original rule, verbatim:**

> - **S3 — host memory floor.** any sample with `MemAvailable < 500 MB` aborts the
>   remainder of the ladder; unrun rungs are reported `not-run`, never extrapolated.

The rule did not fire. Two mechanisms are consistent with the evidence available
(which is only the hypervisor's view, since the run produced none): allocation at
the large rungs outran the sampling — the host went from above the floor to
swap-death inside one sampling gap — and/or the crash happened during a connect
ramp, while sampling was tied to phase progress rather than running unconditionally.

**The new rule, replacing S3:**

> - **S3 — host memory floor.** `MemAvailable` is sampled at least every 2 seconds
>   by a timer independent of phase logic, during **all** phases including the
>   connect ramp. Any sample with `MemAvailable < 1000 MB` aborts the remainder of
>   the ladder immediately: the load client's process group is killed, the partial
>   results JSON is flushed, and the server is closed on a bounded timeout rather
>   than a graceful drain. Unrun rungs are reported `not-run`, never extrapolated.

This tightens a pre-registered STOP. It can only make the ladder stop **earlier**
and report **less**; it cannot turn an incomplete rung into a capacity number, and
it moves no classifier threshold. Bucket 4 (`host-memory-limited`) keeps its
`hostMemAvailableMbMin < 500` rule unchanged, so the buckets are exactly as
pre-registered — a rung aborted between 1000 MB and 500 MB is reported
`incomplete` with the ladder stopped, not reclassified.

Three harness mechanics land with it. None of them is a threshold, and none
changes what any rung reports:

1. **Incremental evidence flush.** The results JSON is written after every rung
   and on every abort path, by atomic rename over the same path. A crash can no
   longer erase completed rungs; the incident's total data loss was a harness
   defect, not a property of the question.
2. **Client self-guard.** The generator aborts its own run if its RSS exceeds
   3.5 GB, emitting a distinct marker. The driver records that the guard fired and
   buckets the rung through the existing `harness-error` path — no new bucket.
   A generator that eats the host is not a server result.
3. **Process-group teardown.** The driver kills the client's process group on
   every exit path (normal, abort, signal). The orphans that outlived the job are
   what turned a failed rung into a force-restart.

## Not a gate

No threshold in this document is a merge bar, and the harness is not to be tuned
to clear one. A merge bar is not a physics result. This branch is never-merge.
