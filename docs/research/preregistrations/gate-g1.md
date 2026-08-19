# Pre-registration — Gate G1 (GPS / telemetry session scale)

**Gate text (binding):** `.scratch/production-grade-scenarios/spec.md` rev 2, §Targets, G1.
**Axis pre-registration (still binding for everything this document does not
override):** `docs/research/preregistrations/session-scale.md`, incl. Amendments 1–2.
**Probe branch:** `probe/session-scale-01` (never-merge). Base for the gate work:
`40a3857` (ticket 11's ledger fixes).
**Runner:** heavy self-hosted `[self-hosted, Linux, X64, heavy]`, 4 vCPU / 8 GB,
generator co-resident. No runner config changes.
**Written before any harness change made for this gate.** The commit carrying
this file precedes every harness commit on this branch that G1 depends on. Any
post-hoc edit to this document is a finding against its author, not a correction.

Separation (spec §Process rules): the agent preparing and running G1 implemented
neither ticket 02 (loss attribution) nor ticket 11 (session-scale ledger).

## 1. What G1 asks, and which branch of it fires

The gate as written in the spec:

> **G1 GPS** — at 10,000 sessions × 0.2 pps: delivery ≥ 0.995 **and** ingest p99
> ≤ 50 ms (health metric — delivery alone is refuted as a health signal) **and**
> committed marginal at 10k within 20% of the 1k→5k marginal (sampling method
> pinned in the pre-reg). Pre-registered branch: if T02 attributes the loss to the
> client/harness, the gate is re-registered as a server-side statement (per-stage
> taps account for 100% of the gap; server observes ≥ 99.5% of kernel-delivered)
> with the client loss excluded and disclosed. G1's marginal may NOT be converted
> into a provisioning claim (idle-floor caveat stands).

**The client/harness branch has fired.** Ticket 02 attributed the 10k gap to a
kernel UDP receive-buffer overflow on the arrival path, confirmed on Linux in run
`32192153026` (candidate `c2fd7a02867a…`, branch `probe/loss-attribution-01`,
evidence `docs/research/2026-08-18-loss-attribution.md`):

- arm A, 10,000 sessions on one phase signal, 5 s interval: delivery 0.699, gap
  70,358, kernel `RcvbufErrors` delta 70,385 — the whole gap, to 0.04%;
- `enqueueToWire = 0` and `quinnRecvToJs = 0` in **every** arm: quinn's send-side
  eviction contributed nothing and the server's native queue, backpressure
  governor, N-API boundary and JS iterator lost nothing;
- arm B, 5,000 sessions at the same 2,000/s mean: 0.994 with `RcvbufErrors`
  1,503 — the pre-registered prediction that Linux's smaller default rcvbuf would
  show drops on the previously-clean 5,000 rung, verified;
- arm D, 10,000 sessions, same mean rate, **arrival spread across the interval**:
  delivery **1.000**, zero drops anywhere.

So the server pipeline is exonerated counter-exactly, and the loss lives in the
kernel socket buffer ahead of it. G1 is therefore re-registered as the
**server-side statement** the spec already wrote, and the client-side kernel loss
is excluded from the delivery clause and disclosed as its own number (§4, C4/D1).

## 2. The arrival process (and why staggered is the honest one, not the kind one)

**Registered arrival process for G1: staggered.** Session *i* of *N* offers its
datagrams on the same 5,000 ms period as every other session, phase-shifted by
`i/N` of one interval, so *N* sessions at 0.2 pps present a smooth
`N/5` datagrams/s arrival process instead of one *N*-packet impulse every 5 s.
Mean rate, session count, payload, direction, window lengths and every classifier
threshold are unchanged from the axis pre-registration.

Justification, stated before the run:

1. **The synchronized process is an artefact of the harness, not of the product.**
   Every session is released by one phase-change signal and then ticks on the same
   period. That is a property of `watch::channel` phase release, not of GPS
   handsets. Run 32192153026 measured its consequence: `datagramsIn` sampled every
   2 s in the aligned arm gave 30 zero-samples out of 59, interleaved with samples
   of 3,000–4,300. The label "2,000 datagrams/s" did not describe that process.
2. **A real fleet is not wall-clock aligned.** Handsets wake on their own
   schedules, so the aggregate is a smooth Poisson-ish arrival at the fleet's mean
   rate — which is what the staggered arm reproduces deterministically.
3. **The spec requires it.** The delivery clause must be evaluated "on an arrival
   process that does not manufacture kernel drops". Under the aligned process the
   delivery number is a measurement of `net.core.rmem_default` on the runner, and
   `SO_RCVBUF` is not settable through this project's public API — so the aligned
   number cannot be a statement about this server at all.
4. **It is not a softer test of the server.** Stagger *raises* what the server
   pipeline must sustain: instead of receiving 30% of the wall clock's worth of
   packets and having the kernel discard the rest, the server now has to observe
   and deliver ~100% of them. Arm D delivered 1.000 with the server doing strictly
   more work than in arm A.

**What stagger deliberately does not do:** it does not measure burst tolerance.
Ticket 02 left burst tolerance registered as a distinct, unmeasured axis; G1 does
not close it and does not claim it. The aligned process's result stands where
ticket 02 recorded it, and is repeated here in §4/D1 as disclosure so that no
reader of a passing G1 concludes that a wall-clock-aligned fleet delivers 1.000.

## 3. Ladder and profile (fixed before dispatch)

Rungs, in order, one dispatch:

```
100, 1000, 5000, 10000
```

`25000` and `50000` are **not run** and are reported
`incomplete-unless-off-box`. This is the axis pre-registration's own STOP S1
expectation ("the 25 000 and 50 000 rungs are expected to be the ones at risk",
generator co-resident on the same 4 vCPU / 8 GB box, off-box generator
`v-ubuntu-loadgen` *smaller* and therefore not a rescue), not a rung quietly
lowered to make a gate pass: G1's every number is taken at ≤ 10,000 sessions, so
running the top two rungs could only add host-crash risk (Amendment 1's incident)
and runner minutes to a gate they do not feed. They stay in the axis ladder at
full size for whoever runs the axis off-box.

Per-session profile, identical at every rung, unchanged from the axis
pre-registration: 5,000 ms datagram interval (0.2 pps/session), 100-byte payload,
client → server only with no echo, 120 s steady hold, 30 s idle tail, 15 s settle
plus the `sessionsActive → 0` drain barrier between rungs, 64 client endpoints on
64 distinct `127.0.<k>.1` source addresses at every rung, limiters configured
strictly above the load. Aggregate offered rate at the gate rung is
10,000 × 0.2 = **2,000 datagrams/s**, ~2% of the settled ~103k ingest ceiling.

## 4. Clauses

Every clause is evaluated at the **10,000-session rung** unless it names other
rungs, over the **steady window** (steady marker → idle marker, plus the 1,000 ms
drain grace on the server side, exactly as the axis registered), and only if the
validity preconditions in §5 hold. A clause whose inputs are missing or invalid is
**INCOMPLETE** — never a pass, and never silently a fail attributed to the server.

### C1 — delivery ≥ 0.995

`deliveryRatio = serverRx(steady + drain) / clientDatagramsSent(steady)` at the
10,000 rung, under the staggered arrival process of §2.

Kernel-dropped datagrams (§4/C4's `kernelDrops`) are **excluded from the
numerator's shortfall attribution and disclosed** per the spec's client-branch
instruction: if C1 misses, the miss is reported against the server only for the
part of the gap that C4's taps place at or after the server socket. The prediction,
registered now: under stagger `kernelDrops` is 0 and no exclusion is needed
(arm D measured exactly that). If `kernelDrops > 0` on a staggered run, that is
itself a finding and is reported as one.

**PASS** iff `deliveryRatio ≥ 0.995`.

### C2 — health metric: server ingest p99 ≤ 50 ms

**Definition (spec §Metric definitions):** actual-send stamp → JS handler entry.

- The client writes a 36-byte stamp into every steady-phase datagram carrying
  `intended_ns` (the tick deadline its schedule made due) and `actual_ns`
  (`CLOCK_MONOTONIC` read immediately before `send_datagram`), using the byte
  layout and log-linear histogram of `crates/reference/src/latency_probe.rs`,
  ported unchanged from `probe/latency-01`.
- The server reads `CLOCK_MONOTONIC` at **JS handler entry** — the first statement
  of the `for await (… of session.incomingDatagrams())` body — through
  `tools/load/latency-clock.ts`, and records `entry_ns − actual_ns`.
- Both ends read the same system-wide `CLOCK_MONOTONIC` counter, so the one-way
  measurement needs no calibration constant. The **FFI read is pinned** for this
  gate (`createMonotonicClock(false)`): at 2,000 datagrams/s the ~100 ns per-read
  cost is irrelevant, and pinning it removes the fast path's same-counter
  assumption from the evidence chain entirely.

**Floor rule, fixed here, before the run:** the evaluated number is the **raw
p99**, with **no floor subtracted**. Because the stamp is taken at the actual send
call, client scheduling lag lies outside the measured interval by construction;
there is nothing to subtract, and subtracting anything would only flatter the
number. The client's schedule lag is measured anyway and reported beside every
stamp as required — `clientScheduleLagP99Ms = p99(actual_ns − intended_ns)` — as
disclosure and as a validity check: **if `clientScheduleLagP99Ms > 50 ms`, C2 is
INCOMPLETE**, because a generator lagging by the size of the whole budget is no
longer offering the registered arrival process, whatever the server's own number
says.

**PASS** iff `ingestP99Ms ≤ 50` at the 10,000 rung. p50 / p90 / p999 / max, the
sample count, and the same statistics at 100 / 1,000 / 5,000 are reported beside
it; they are context, not the gate.

### C3 — numeric no-knee: 10k marginal within 20% of the 1k→5k marginal

`marginal(a→b) = (committed[b] − committed[a]) / (sessions[b] − sessions[a])`,
in KB/session, from the axis pre-registration's derived deliverable.

- `marginal_ref = marginal(1000 → 5000)`
- `marginal_10k = marginal(5000 → 10000)`
- **PASS** iff `|marginal_10k − marginal_ref| ≤ 0.20 × marginal_ref`.

**Sampling method, pinned here (the spec requires this pre-reg to pin it):**
`committed[r]` is the **median of the `RssAnon + VmSwap` samples taken during rung
r's idle phase**, i.e. from the end of the drain grace to the stop marker, on the
2-second independent sampler Amendment 1 installed. Idle-phase, because the
quantity C3 is about is the *retained* per-session footprint, and the idle phase
is the only window in the rung with no application sends, no connect ramp and no
in-flight queueing in it. Median, because a max over a rung is a single sample of
a transient and would make the marginal a difference of two outliers. The per-rung
**max** committed (the figure the axis harness already reports) is emitted beside
it as disclosure; if the two tell different stories, both are reported and C3 is
evaluated on the pinned one.

Both marginals must come from rungs classified `ok` and not `degraded` (§5). If
1,000, 5,000 or 10,000 is not `ok`, **C3 is INCOMPLETE** — a knee is not declared
from rungs the classifier rejected, and neither is its absence.

**Binding caveat, carried into any statement of the result:** C3's marginal may
**not** be converted into a provisioning claim. The idle floor of a session on this
build is not separated from its marginal cost by this measurement, the generator is
co-resident on the same 8 GB host, and `committed` on a mimalloc build is a
retention figure, not a demand figure.

### C4 — server-side statement (the T02 branch)

Two sub-clauses, both at the 10,000 rung, over the steady window.

Stage taps, in arrival order:

| # | tap | source |
|---|---|---|
| 1 | `clientEnqueued` | `send_datagram` returned `Ok` (scale-client steady counter) |
| 2 | `clientWireTx` | quinn `frame_tx.datagram`, summed over every live connection |
| 3 | `kernelDrops` | per-socket `drops` for the bench UDP port (`/proc/net/udp`), primary; host-wide `RcvbufErrors` (`/proc/net/snmp`) as cross-check |
| 4 | `serverObserved` | server metric `datagramsIn` — incremented immediately after `receive_datagram()` returns, before any native queue |
| 5 | `jsDelivered` | datagrams the application's `incomingDatagrams()` iterator yielded (`serverRx`) |

plus every native drop reason (`datagramsDropped*`) and the park counter
`datagramsSkippedQueueFull`, which is **not** part of `datagramsDropped` and which
the session-scale harness did not sample before this gate.

- **C4a — taps account for 100% of the gap.** With
  `kernelDelivered = clientWireTx − kernelDrops`:
  - `residual_ingress = clientEnqueued − clientWireTx` (quinn send-buffer eviction)
  - `residual_kernel = kernelDelivered − serverObserved`
  - `residual_native = serverObserved − jsDelivered − Σ datagramsDropped* − datagramsSkippedQueueFull`

  **PASS** iff each residual satisfies `|residual| ≤ 0.001 × clientEnqueued`. The
  tolerance is not zero because the five taps are read at slightly different
  instants across a 2 s sampler and a 1 s drain grace; 0.1% is an order of
  magnitude tighter than the 0.04% residual run 32192153026 actually produced at a
  gap of 70,358, and any real mechanism this gate could find is orders of magnitude
  larger. A residual outside the band is reported as **unattributed** — the honest
  outcome the taps exist to prevent — and C4a fails.

- **C4b — server observes ≥ 99.5% of kernel-delivered.**
  **PASS** iff `serverObserved ≥ 0.995 × kernelDelivered`.

If tap 3 reads null on both sources (no `/proc`, socket not found), **C4 is
INCOMPLETE**; a `kernelDrops` of 0 is only asserted when it was measured as 0.
Because the generator is co-resident, host-wide `RcvbufErrors` counts the client's
sockets too and is therefore an **upper bound** on server-side kernel loss; the
per-socket column is the primary for that reason, and the difference between them
is reported.

### D1 — disclosure (not a clause; no pass/fail)

Reported with any G1 verdict, so that a pass cannot be read as more than it is:

1. The **aligned-arrival** result from ticket 02 (delivery 0.699 at this same
   session count and mean rate, all of it kernel rcvbuf loss ahead of the server),
   with the statement that a wall-clock-synchronized fleet is not covered by G1 and
   that burst tolerance remains an unmeasured axis.
2. Co-residence: generator RSS and CPU on the same 4 vCPU / 8 GB host, per rung.
3. `kernelDrops` and both of its sources, even when zero.
4. The rig caveat, and C3's no-provisioning-claim caveat.
5. Every configuration value in force: env, defaults, limiter settings, candidate
   SHA, staging base SHA, artifact hash.

## 5. Validity preconditions (a failed precondition makes the run INCOMPLETE, not a miss)

All of the axis pre-registration's STOPs S1–S5 and classifier buckets apply
unchanged, including Amendment 1's S3 (`MemAvailable < 1000 MB` aborts) and
Amendment 2's degraded-rung rule. In addition, for this gate:

- **P1** — the 10,000 rung must be classified `ok` and not `degraded`. Anything
  else and G1 reports INCOMPLETE for C1/C2/C4 rather than a verdict.
- **P2** — `rateLimitedTotal == 0` and `limitExceededTotal == 0` at every rung
  (axis bucket 2). A limiter-contaminated rung measures configuration.
- **P3** — `offeredRatio ≥ 0.90` at every rung feeding a clause (axis S1). Under
  stagger the offered denominator is the per-session measured `ticksDue` of
  Amendment 2 as amended by §6 below.
- **P4** — `staggerSends == true` is stamped in the client artifact. A run whose
  artifact does not record the registered arrival process does not stamp this gate.
- **P5** — the ingest-latency clock is the pinned FFI `CLOCK_MONOTONIC` reader on
  both ends and both processes ran on the same host. Otherwise C2 is INCOMPLETE.

## 6. Amendment to the axis pre-registration — steady-tick offset under stagger

The axis pre-registration, Amendment 2 §1, registered verbatim:

> - Steady-phase ticks are offset by **half an interval** (first tick at
>   `interval/2`, then every `interval`). The window then holds exactly
>   `steady / interval` ticks — the nominal per-session rate — and no tick lies
>   within half an interval of either window edge.
> - `offeredRatio = clientDatagramsSent(steady) / steadyTicksDue`, where
>   `steadyTicksDue` is **measured**, not derived: each session books
>   `ticksDue(elapsed)` against the clock its own ticker runs on, at the instant
>   it leaves the steady phase, including sessions that die mid-window (charged
>   for what their schedule reached, never forgiven). The schedule's nominal
>   figure is reported beside it as `expectedTicksPerSession`.

A single half-interval offset shared by every session **is** the synchronized
arrival process §2 replaces. The rule is amended as follows, and only as follows:

> - Session *i* of *N* offsets its first steady tick by
>   `interval/2 + (i/N) × interval`, then ticks every `interval`. With
>   `staggerSends` off, `i/N` is zero for every session and the rule is exactly the
>   original.
> - `steadyTicksDue` remains **measured per session** against that session's own
>   offset and its own ticker clock, at the instant it leaves the steady phase.
>   `offeredRatio` is unchanged in meaning: sent over due.
> - `expectedTicksPerSession` continues to report the nominal schedule figure
>   (`ticksDue` at the un-staggered offset), beside the measured denominator.

What the original rule bought was that no tick shares a timer slot with a phase
boundary, so the denominator is not a coin flip. Under stagger that property is
weakened by construction — a spread arrival process must put *some* session's tick
near any given instant — but it is weakened per session and not in aggregate: each
session books what its own schedule made due at its own exit instant, so at most
the `O(1)` sessions whose tick falls inside the 250 ms phase-observation grace can
be off by one tick out of 24, i.e. a bound of well under 0.1% on `offeredRatio` at
10,000 sessions, against an S1 threshold of 0.90. No classifier threshold moves.
No window length, rate, payload or direction changes.

## 7. Harness support added for this gate (registered here, implemented after)

Nothing below changes a threshold, a window, a rate or a bucket. Each is an
instrument G1's clauses require and the axis harness did not have:

1. **Staggered arrival** in `scale-client` (`--stagger-sends`), with the
   per-session tick accounting of §6. Default off, so the axis harness's registered
   behaviour is unchanged unless a run asks for the gate's process.
2. **Ingest-latency stamp and histograms**: `latency_probe.rs`,
   `tools/load/latency-clock.ts` and `tools/load/latency-histogram.ts` ported
   unchanged from `probe/latency-01` (byte-identical bucketing on both ends, so the
   two percentiles are computed by the same arithmetic), the 36-byte stamp written
   into the 100-byte payload in place of the old `scale:<seq>:` text header, a
   client-side schedule-lag histogram, and a server-side ingest histogram recorded
   at JS handler entry and snapshotted per phase.
3. **Stage taps** (§4/C4): client `frame_tx.datagram` summed over a live-connection
   registry; server `datagramsIn`, every `datagramsDropped*` reason and
   `datagramsSkippedQueueFull` sampled at the same phase boundaries as the existing
   counters; kernel `/proc/net/udp` per-socket `drops` and `/proc/net/snmp`
   `RcvbufErrors`, sampled on the same boundaries and on the 2 s sampler.
   Ported in behaviour from `probe/loss-attribution-01`, which is where they were
   proven against a known gap.
4. **Idle-phase committed median** per rung (§4/C3), computed from samples the
   harness already takes.
5. `SCALE_STAGGER` plumbed through the `bench-bandwidth` workflow's session-scale
   mode, defaulting to `true`, and stamped into the artifact (P4).

**Why the existing per-phase counters do not satisfy C4, and taps are needed.**
Ticket 11's per-phase receive counters localize a deficit **in time** — an arrival
booked to `connect`, `steady`, `drain` or `idle` — which is what distinguishes a
boundary artefact from real loss. C4 is a statement about **stage**: where in
`enqueue → wire → kernel → quinn → JS` the datagrams went. The per-phase counters
cannot answer it, because on both sides they are the *same two* taps (client sent,
JS delivered) sliced by window; every stage between them is a subtraction with
nowhere to point — which is precisely the situation ticket 02 was opened to escape.
Nor do the kernel counters alone: the axis harness samples **none** — the
`/proc/net/snmp` and `/proc/net/udp` readers live in the loss-attribution harness,
not this one. Without tap 2 there is no `kernelDelivered` to compare against, and
without tap 4 `serverObserved` does not exist as a distinct quantity from
`jsDelivered`, so C4b would be a tautology.

## 8. What a pass and a miss each mean

- **PASS** = C1 ∧ C2 ∧ C3 ∧ C4a ∧ C4b, on one valid run, with D1 disclosed.
- A **miss on a valid run is final for this effort** (spec §Targets) and routes to
  its mechanism ticket. It is not rerun, and the harness is not tuned toward it.
- A **rerun** requires a declared, logged harness or infrastructure fault, recorded
  in §9 with the aborted run's id.
- Clauses are reported **individually**. A gate that passes C1/C3/C4 and misses C2
  is reported as exactly that; there is no aggregate score.
- No default flips on this gate. G1 measures the shipped configuration.

## 9. Dispatch log

Every dispatch for this gate, including aborted ones, in order. Filled in as they
happen; an empty row is never removed.

| # | date (UTC) | run id | candidate SHA | staging base SHA | ladder | stagger | outcome | artifact hash |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-08-19 | _pending dispatch_ | `probe/session-scale-01` head at dispatch — last harness commit `36eddb10b7c6`, filled in by the dispatcher from `git rev-parse` | `5ad02457` (`rebind4-staging` tip) | 100,1000,5000,10000 | true | _pending_ | _pending_ |

**Candidate composition (spec §Process rules).** G1 measures the shipped
configuration and needs no lever commits, so the probe branch's merge-base with
`rebind4-staging` already *is* the staging tip (`git merge-base` =
`5ad02457…` = `git rev-parse rebind4-staging`) and no rebase is required. The
recorded candidate is the probe head; the branch is never merged back.

Prior runs on this axis, for continuity (they are not G1 dispatches and stamp
nothing here):

| date | run id | outcome |
|---|---|---|
| 2026-08-18 | `32168754965` | zero artifacts; host swap-death; Amendment 1 |
| 2026-08-18 | `32174398131` | rung 4 delivery 0.694 — the observation that opened ticket 02 |
| 2026-08-19 | `32192153026` | ticket 02's confirmation run (loss-attribution branch, not this harness) |

## 10. Not a tuning target

No threshold in this document may be moved by anything measured under it. The
harness is not to be adjusted toward a clause after data exists. This branch is
never-merge; the gate's product is a stamped verdict and its evidence, not code.
