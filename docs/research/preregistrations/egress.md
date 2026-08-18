# Pre-registration — Axis: egress (server→client), latency-gated, burst-shaped

**Registered:** 2026-08-18, before any egress harness code was written.
**Base:** `rebind4-staging` @ `5ad0245742cbe5c231e0b06b8a42c93622f1ff14`.
**Branched from:** `probe/latency-01` @ `8cf042273d256718b328f410441f296ce4e1b7db`,
for its shared-clock instrumentation (`tools/load/latency-clock.ts`,
`latency-stamp.ts`, `latency-histogram.ts`, `crates/reference/src/latency_probe.rs`).
**Probe branch:** `probe/egress-01` (never-merge).
**Runner:** heavy self-hosted, 4 vCPU / 8 GB Ubuntu on Hyper-V. Unchanged.

This document is the contract. Buckets, gates, ladder and STOP conditions are
fixed *before* any run is dispatched. Editing it after a dispatch is a finding
against the author, not a result.

## Why this axis exists

Every throughput number this project owns is **ingest**. Every product scenario
that matters is **egress**. The only downstream evidence in existence is the echo
bench's 0.98–1.00 down-ratio, taken at ~12k/s, and echo is not origination.

Ingest is batched (H7, one N-API crossing per batch, mean fill 5.75). Egress is
not: `crates/native/src/session.rs:133` crosses the boundary once per datagram.
That asymmetry is the thing under measurement. **This run does not fix it** — if
a send-side batch lever shows up in the data it is written down and left alone.

## What is already settled and is not re-derived here

`docs/research/2026-08-18-bandwidth-ceiling-attribution.md`: ~103k datagrams/s
delivered **ingest** is this host's honest ceiling, and it is not a server-side
limit (sender co-residence, client Cubic on loopback, Hyper-V vswitch loss). The
egress ladder below tops out at 81,500 datagrams/s aggregate, deliberately under
that number: **this is not a 160k run and the closed ceiling is not re-litigated.**

Falsified and not re-proposed: coresplit/taskset pinning, `rmem` raises, BBR.

## What is measured

The originator is the **Bun server**. It schedules datagrams per subscriber
session, writes a 28-byte stamp into each payload, and sends. The receiver is the
Rust load client, which decodes the stamp and differences it against its own
`CLOCK_MONOTONIC` read.

Three intervals, all from one stamp:

| name | interval | contains |
|---|---|---|
| **`egressOneWay`** (primary) | `actual send` → client receive | `Buffer.from` copy, N-API crossing, native send queue, quinn encrypt, loopback UDP, client quinn decrypt, client `receive_datagram` |
| **`endToEnd`** (reported) | `intended send` → client receive | the above, plus the JS scheduler's own queueing |
| **`originationLag`** (diagnostic, server-side) | `intended send` → `actual send` | the JS scheduler's own queueing, alone |

`endToEnd = originationLag + egressOneWay` by construction, which is also a
consistency check (STOP `clock-invalid`).

**The gate is on `egressOneWay`.** `originationLag` is excluded from the gated
number on purpose: it is the *generator*, and the whole point of the
generator-saturation STOP is that the generator must never be reported as the
subject. `endToEnd` is reported alongside every rung so the exclusion is visible
rather than convenient.

### Clock

Identical to the latency axis. Both processes read
`clock_gettime(CLOCK_MONOTONIC)` — Bun through `bun:ffi`, Rust through `libc`.
On Linux that is one system-wide counter, so no calibration constant exists to be
wrong. The Bun side may substitute `Bun.nanoseconds()` plus a fixed offset only
if two offset measurements 200 ms apart agree to under 1 µs; the residual is
written into the artifact and gates the run.

**On-box by choice.** Off-box would need PTP/chrony for a one-way number to mean
anything, and the Hyper-V vswitch drops 0–26 % in bursty seconds, which would
make a one-way measurement survivorship-biased on top of that. Co-residence
inflation is therefore **disclosed, not fixed**: the receiver shares 4 vCPU with
the originator, so every percentile here is an **upper bound** on server egress
latency.

### Payload stamp

The layout registered by `docs/research/preregistrations/latency.md`, unchanged,
so one decoder serves both axes. In this axis the fields are written by the
server: `intended` = the scheduler deadline, `actual` = the clock read
immediately before `session.sendDatagram`, `sequence` = per-session counter.

Payload is 1150 B, identical to the closed bandwidth ladder and to the latency
ladder, so all three are comparable.

## Burst profiles (arms)

One arm per profile; one server process per arm. All grids are ≥ 5 ms, an order
of magnitude above the ~1 ms OS timer granularity, so no arm can be a measurement
of `setTimeout` resolution. Within a send event a session's datagrams are issued
back-to-back and awaited **serially per session**, sessions concurrent — the
shape real SFU code has.

| arm | grid | per-event amplitude |
|---|---|---|
| `constant` | 200 Hz (5 ms) | `round(rate / 200)`, sessions phase-staggered across the 5 ms period |
| `frame-bursty` | 30 Hz (33.333 ms) | `perFrame = round(rate / 30)`; every 60th frame (2 s) carries `5 × perFrame`; **sessions phase-staggered across the frame period and keyframe phases spread across the 60-frame cycle** |
| `keyframe-aligned` | 30 Hz (33.333 ms) | same amplitudes, **all sessions on one shared grid and all keyframes on the same 2 s boundary** |
| `desktop-share` | 30 Hz (33.333 ms) | bimodal, rate-neutral: 2.5 s at `round(0.1 × perFrame)` then 0.5 s at `round(5.5 × perFrame)`, sessions phase-staggered |

`keyframe-aligned` is the adversarial case the maintainer named: at 100 sessions
and the 3 Mbps rung, `perFrame = 11`, so a keyframe window carries
100 × 55 = **5,500 datagrams inside one 33.3 ms window ≈ 165k instantaneous pps**.

**Disclosed:** the frame arms quantize the requested rate to a whole number of
datagrams per frame, and the keyframe multiplier raises the mean by 6.67 %
(`1 + 4/60`). `desktop-share` is rate-neutral by construction. Every rung
therefore reports its **scheduled** datagram count, computed from the profile
generator itself, and `offered-shortfall` is evaluated against that number and
never against `rate × time`.

## Ladder

100 subscriber sessions, 1150 B, **45 s per step, 10 s settle**. Per-session
rates are chosen as multiples of a 3 Mbps video stream (326 datagrams/s at
1150 B):

| step | per-session /s | ≈ Mbps/session | aggregate /s | ≈ 3 Mbps-stream equivalents |
|---|---|---|---|---|
| 1 | 110 | 1.0 | 11,000 | 34 |
| 2 | 220 | 2.0 | 22,000 | 67 |
| 3 | 326 | 3.0 | 32,600 | 100 |
| 4 | 490 | 4.5 | 49,000 | 150 |
| 5 | 652 | 6.0 | 65,200 | 200 |
| 6 | 815 | 7.5 | 81,500 | 250 |

Session count is held at 100 for every rung. **Session-count scaling is a
different axis and is not touched here**; the "3 Mbps-stream equivalents" column
is an aggregate-bitrate equivalence and is labelled as such in every claim.

The server's `datagramsPerSec` limiter is set to 4× the top aggregate step so the
limiter is never the thing being measured.

## Fan-out shape (1 ingest → N egress)

Run separately from the ladder, because SFU / desktop-share / video-call are all
1→N, not N independent bidirectional sessions.

One publisher process (`--sessions 1`, frame-bursty via `--arrival tick
--tick-hz 30`, 330 datagrams/s = 11 per frame = 3 Mbps) plus one subscriber
process holding N receive-only sessions. The server is a minimal SFU: any
datagram arriving from a session is forwarded **verbatim** to every other
session. The publisher's own stamp therefore survives the fan-out untouched, and
the subscriber measures publisher-send → subscriber-receive with **no server
clock in the path at all** — both ends are load-client processes on one host.

N ∈ {10, 25, 50, 100}, 45 s each. Aggregate egress = 330 × N, i.e. 3,300 /
8,250 / 16,500 / 33,000 datagrams/s. The server additionally records its own
ingest→forward-issue lag as a diagnostic.

## Generator-saturation control — the STOP this axis is built around

The named trap: originate from JS on a timer and you measure Bun's timer
resolution and the single JS thread, not the transport. The ingest ladder's
headline finding was exactly that failure class.

**Generator headroom probe.** Before the ladder, and once per run, the driver
runs the *same* scheduler and the *same* per-datagram stamping and
`Buffer.from` copy into a counting sink — everything the originator does except
the native call. It escalates aggregate rate over
`20k, 40k, 80k, 160k, 240k, 320k` datagrams/s, 5 s each, and reports
`generatorCeilingPerSec` = the highest rate at which it both emitted ≥ 0.95 of
the scheduled count and kept `originationLag` p99 under 5 ms.

**Run-level STOP `generator-headroom`:** if
`generatorCeilingPerSec < 1.5 × maxDeliveredAggregatePerSec` observed anywhere in
the ladder, **the run is `incomplete` and no capacity number is claimed.** This
is the maintainer's non-negotiable, written as arithmetic so it cannot be
rationalized afterwards.

## Gates

Two latency gates, both registered here, both evaluated on `egressOneWay` p99 of
each **complete** rung. Reported for `endToEnd` as well, labelled separately.

| gate | bound | rationale |
|---|---|---|
| `gate-realtime` | p99 < 5.0 ms | conferencing / interactive budget |
| `gate-frame` | p99 < 33.3 ms | one 30 fps frame interval; a media pipeline that exceeds it is falling behind cadence |

**Egress capacity under a gate** = the highest complete rung whose
`egressOneWay` p99 satisfies that gate, reported per profile. If the top rung
still satisfies a gate, the result is reported as `≥ 81,500 /s` — a floor, never
extrapolated.

## Classifier buckets

Applied mechanically to each `(profile, step)` **after** STOP evaluation. A step
that trips any STOP is `incomplete`, is excluded from every curve and every
capacity number, and is never bucketed.

### Egress latency verdict — on `egressOneWay` p99

| bucket | rule |
|---|---|
| `ok-realtime` | p99 < 5.0 ms |
| `ok-interactive` | 5.0 ms ≤ p99 < 20.0 ms |
| `ok-frame` | 20.0 ms ≤ p99 < 33.3 ms |
| `degraded` | 33.3 ms ≤ p99 < 100.0 ms |
| `unusable` | p99 ≥ 100.0 ms |

Reported alongside, never in place of: p50, p90, p99, p999, p9999, max, sample
count, and the same set for `endToEnd` and `originationLag`.

### Burst absorption — frame arms only, on `egressOneWay`

| bucket | rule |
|---|---|
| `burst-absorbed` | p99 < 33.333 ms (one frame period) |
| `burst-overrun` | p99 ≥ 33.333 ms |

Also reported: `burstSpreadMs = p99 − p50`, the jitter a client jitter-buffer
would have to hide.

### Alignment cost — `keyframe-aligned` vs `frame-bursty` at equal offered rate

`Δ = p99(keyframe-aligned) − p99(frame-bursty)`, computed only where **both**
rungs are complete.

| bucket | rule |
|---|---|
| `alignment-free` | Δ < 1.0 ms |
| `alignment-cheap` | 1.0 ms ≤ Δ < 10.0 ms |
| `alignment-expensive` | 10.0 ms ≤ Δ < 33.3 ms |
| `alignment-fatal` | Δ ≥ 33.3 ms |

The comparison is only interpretable together with delivery ratio: an arm that
drops more reports a better tail for free. If the two arms' `downDeliveryRatio`
differ by more than 0.02 the comparison is labelled `ab-confounded` and the Δ
bucket is advisory only.

### Fan-out — per N, on publisher-send → subscriber-receive p99

Same latency buckets as above. Additionally `fanoutScaling` = p99(N) / p99(10),
reported raw with no bucket, because there is no pre-registered expectation for
its shape and inventing one after the fact would be the thing this document
exists to prevent.

## STOP conditions

Evaluated per step, in this order. First match wins and is recorded as the step's
`stop`.

1. **`generator-saturation`** — the originator did not offer the registered
   shape, shown by either:
   - `sendEventsSkipped ≥ 0.10 × sendEventsScheduled` (a session was still
     draining its previous send event when the next deadline arrived, and the
     event was skipped rather than allowed to run away); **or**
   - `originationLag` p99 `≥ 4 × originationLagFloor`, where the floor is the
     minimum `originationLag` p99 across every step of the *same profile*. A
     within-arm control, so the platform's fixed timer-wake granularity — present
     at idle, and not queueing — is subtracted rather than mistaken for load.
2. **`offered-shortfall`** — datagrams the server actually issued
   < 0.90 × the profile generator's own scheduled count for the step.
3. **`clock-invalid`** — negative `egressOneWay` samples > 0.1 % of stamped
   samples, **or** clock calibration residual > 50 µs, **or**
   `egressOneWay` p99 > `endToEnd` p99 (an interval cannot exceed the interval
   that contains it), **or** stamped receives are < 0.99 of the client's total
   receives (the two ends disagree about the payload contract).
4. **`delivery-collapse`** — `downDeliveryRatio` = clientReceived / serverSent
   < 0.80. Latency conditioned on arrival is survivorship-biased once a fifth of
   the load is missing.
5. **`sample-starvation`** — fewer than 10,000 stamped samples in the step.

**Advisory label, never a STOP:** `co-residence-bound` when host CPU median
≥ 97 % and `downDeliveryRatio` < 0.95. On-box co-residence is a disclosed
property of this rig, not a defect of the run.

**Arm-level STOP:** if every step at or above 32,600 aggregate /s in a profile is
incomplete, that profile is `incomplete` and contributes nothing.

**Run-level STOPs:**
- `generator-headroom`, defined above.
- If the `constant` profile is arm-level incomplete, the run is `incomplete` and
  no egress capacity claim is made.

A run that stops is a result about the harness or the host, and it is reported as
such rather than rationalized.

## Headline claim this axis is allowed to make

Exactly one form, for the largest complete rung under a named gate:

> N concurrent 3 Mbps egress streams (aggregate-bitrate equivalent, 100 sessions
> × R datagrams/s, 1150 B) at `egressOneWay` p99 < X ms on 4 vCPU, burst profile
> P, co-resident receiver.

Anything stronger — extrapolation past the top rung, a session count that was
never run, an off-box claim — is out of scope for this document.

## What this run may not do

- It may not optimize. The send-side batch API is the exact mirror of H7 and is
  unbuilt; if the data argues for it, that goes in notes and nowhere else.
- It may not re-propose coresplit/taskset pinning, `rmem` raises, or BBR.
- It may not chase 160k or reopen the closed ingest ceiling.
- It may not be re-tuned to clear a gate. A merge bar is not a physics result,
  and neither is a latency bar.
- It may not quote a local macOS smoke number as a result. The local smoke exists
  only to prove the harness runs and that its output parses into the buckets
  above.

## Dispatch log

Every dispatch of this axis is logged here — run id, candidate SHA, artifact
hash — including aborted ones, per the effort spec's process rules.

| dispatched | run id | candidate SHA | artifact hash | outcome |
|---|---|---|---|---|
| — | — | — | — | **no dispatch has been made** |

## Amendments

Every amendment below was written **before the first dispatch of this axis**
(the dispatch log above is empty at the time of writing) and quotes the text it
replaces verbatim, so the change is auditable rather than silent. An amendment
made after a dispatch would be a finding against the author; these are not.

### Amendment 1 — the generator-headroom probe is replaced (2026-08-18)

**Original text, quoted in full:**

> **Generator headroom probe.** Before the ladder, and once per run, the driver
> runs the *same* scheduler and the *same* per-datagram stamping and
> `Buffer.from` copy into a counting sink — everything the originator does except
> the native call. It escalates aggregate rate over
> `20k, 40k, 80k, 160k, 240k, 320k` datagrams/s, 5 s each, and reports
> `generatorCeilingPerSec` = the highest rate at which it both emitted ≥ 0.95 of
> the scheduled count and kept `originationLag` p99 under 5 ms.
>
> **Run-level STOP `generator-headroom`:** if
> `generatorCeilingPerSec < 1.5 × maxDeliveredAggregatePerSec` observed anywhere in
> the ladder, **the run is `incomplete` and no capacity number is claimed.** This
> is the maintainer's non-negotiable, written as arithmetic so it cannot be
> rationalized afterwards.

**Why it is replaced.** As registered, the probe cannot fail in the situation it
exists to catch. Two independent defects, either one fatal:

1. **It is not in situ.** The probe runs on an *idle* box: no server process, no
   quinn runtime, no receiver, nothing else contending for the 4 vCPU. The
   ceiling it measures is therefore the ceiling of a JS loop that owns the whole
   machine, while the ladder's originator shares that machine with the transport
   it is feeding and with a co-resident receiver. The number is an upper bound
   on a quantity nobody asked about.
2. **The denominator is saturation-depressed.** `maxDeliveredAggregatePerSec`
   is what the transport *delivered*. If the JS originator is the binder — the
   exact failure this STOP exists to detect — then delivered is *low*, so
   `ceiling / delivered` is *large*, so the STOP *passes*. The rule is
   anti-correlated with the condition it tests. Any run that is generator-bound
   clears it by being generator-bound.

**Replacement, registered here in its place.**

**Loaded-server headroom arm.** A dedicated arm (`EGRESS_SHAPE=headroom`), run
once per run, on the same server, with the same 100 real subscriber sessions
connected by the same load client. The transport carries the **top ladder rung**
(`headroomRatePerSession`, default 815/s/session = 81,500/s aggregate) for the
whole arm — that is the loaded-server condition, and it is the ladder's own
heaviest CPU state. Concurrently, and **from the same single JS originator and
the same scheduler**, a shadow set of `round(m × sessions)` sink sessions is
driven at the same per-session rate and the same burst profile, where the sink
does everything the real path does except the native call (per-datagram stamp
write and `Buffer.from` copy into a counting sink).

`m` escalates over `0.5, 1, 2, 4`, 20 s each, stopping at the first failure. A
rung passes iff, **counting real and shadow sessions together**, the originator
emitted ≥ 0.95 of the plan's own scheduled count **and** kept `originationLag`
p99 under 5 ms — the same two conditions, and the same 5 ms bound, as the
original text.

`generatorCeilingPerSec` = the combined offered rate of the highest passing
rung = `(1 + m) × sessions × effectiveRatePerSession`. It is a demonstrated
number: the originator *did* source that many datagrams per second, on the
loaded box, while the transport was carrying the top rung.

**Run-level STOP `generator-headroom` (replacement):** if

    generatorCeilingPerSec < 1.5 × maxOfferedAggregatePerSec

the run is `incomplete` and no capacity number is claimed, where
**`maxOfferedAggregatePerSec` = the largest `scheduledDatagrams / driveWindowSec`
across the run's *complete* ladder steps** — the offered load the capacity claim
rests on, computed from the profile generator's own arithmetic. That number is
fixed by the plan before the run and cannot be depressed by saturation, which is
the property the original denominator lacked. The 1.5 factor and the
"incomplete, no capacity number" consequence are unchanged.

The escalation set is chosen so that the threshold is not free: the lowest rung
(`m = 0.5`) yields exactly 1.5× the top rung's offered load, so the STOP passes
only if the originator demonstrably sourced at least half again the load the
ladder asked of it, under load, with the transport running.

**Falsifier, and its guard.** `EGRESS_HEADROOM_BURN_NS` inserts a synthetic
per-datagram busy-wait in the originator, which is how the new probe is proven
to fire: a deliberately starved originator must produce a lower ceiling and a
`generator-headroom` STOP. Because a starved originator is not a measurement,
any artifact carrying a non-zero burn marks the run `incomplete` with stop
`harness-falsifier`, and no capacity number may be read from it.

**Cost and contamination.** The headroom arm is a separate arm, so it does not
perturb any gated rung. It costs ≈ 4 × 20 s plus one connect.

### Amendment 2 — the session-connect guard is registered (2026-08-18)

The harness enforced a STOP the original document never registered: a step whose
connected session count fell below 0.95 of the requested count was recorded as
`offered-shortfall`. Registering it is the honest resolution — a rung driven
into 80 of the 100 registered sessions is not the registered shape, and silently
bucketing it would be worse than the unregistered guard.

**Original text, quoted in full:**

> 2. **`offered-shortfall`** — datagrams the server actually issued
>    < 0.90 × the profile generator's own scheduled count for the step.

**Replacement:**

> 2. **`offered-shortfall`** — either the step did not run on the registered
>    session count (`sessionsConnected < 0.95 × sessionsRequested`), **or**
>    datagrams the server actually issued < 0.90 × the profile generator's own
>    scheduled count for the step.

### Amendment 3 — the constant arm's amplitude formula (2026-08-18)

The document's formula and the harness's arithmetic disagree, and the harness is
the honest one: `round(rate / 200)` quantizes a 110/s rung up to 200/s, an 82 %
overshoot of the registered rate, while the harness spreads the rate across the
grid so the offered rate is exact.

**Original text, quoted in full (table row `constant`):**

> | `constant` | 200 Hz (5 ms) | `round(rate / 200)`, sessions phase-staggered across the 5 ms period |

**Replacement:**

> | `constant` | 200 Hz (5 ms) | `round(rate)` datagrams spread evenly across the 200 events of one second (event `i` carries `floor((i+1)·rate/200) − floor(i·rate/200)`), so the offered rate is exact rather than grid-quantized; sessions phase-staggered across the 5 ms period |

The frame arms' `round(rate / 30)` quantization and the keyframe arm's 6.67 %
mean increase are unchanged and were already disclosed.

### Amendment 4 — the skip-ratio denominator (2026-08-18)

`sendEventsScheduled` counted only the events that actually ran, so the ratio in
STOP 1 was `skipped / ran`, not `skipped / scheduled`. The wording is
unchanged; the harness is corrected so that `sendEventsScheduled` means what it
says — every grid event the plan put inside the step, run or skipped — and the
STOP's arithmetic is the arithmetic that was registered.

### Amendment 5 — CPU unit parity, and the co-residence threshold (2026-08-18)

The effort spec binds every axis to **percent-of-one-core** (a 4 vCPU box reads
up to 400). `hostCpuPct` was computed from `/proc/stat` as percent-of-the-whole-
box (0–100), so it disagreed in unit with `serverCpuPct` beside it and with every
other axis. It is converted to percent-of-one-core, and `hostCpuCount` is
recorded in every fragment so the conversion is visible and the classifier is not
guessing at the scale.

The co-residence advisory keeps the meaning it was registered with, restated in
the new unit so that a bare `97` cannot silently become "under one core busy":

**Original text, quoted in full:**

> **Advisory label, never a STOP:** `co-residence-bound` when host CPU median
> ≥ 97 % and `downDeliveryRatio` < 0.95. On-box co-residence is a disclosed
> property of this rig, not a defect of the run.

**Replacement:**

> **Advisory label, never a STOP:** `co-residence-bound` when the host CPU
> median is ≥ 97 % of total host capacity (i.e. ≥ `0.97 × 100 × hostCpuCount`
> in the percent-of-one-core unit — 388 on the 4 vCPU rig) and
> `downDeliveryRatio` < 0.95. On-box co-residence is a disclosed property of
> this rig, not a defect of the run.

### Amendment 6 — rates divide by the drive window (2026-08-18)

The effort spec binds rates to the drive window, never to a wall clock that
includes samplers and drains. The harness divided by an `elapsedSec` that ran
from the start of the drive to *after* the CPU sampler was joined (up to one
5 s sampler period of overshoot on the ladder), and on the fan-out shape from
before the publisher process was spawned to after it exited — a different and
much larger overshoot on the same field. Every derived rate therefore carried an
asymmetric, shape-dependent downward bias.

Registered here: rates divide by **`driveWindowSec`**, defined per shape as

- **ladder** — the interval the originator was actually driving, measured on the
  shared monotonic clock across the drive loop alone;
- **fan-out** — first to last server-observed ingest of the publisher's
  datagrams, on the same clock.

`elapsedSec` is still recorded, beside it, so the overshoot is visible rather
than hidden.

### Amendment 7 — "capacity is a floor" is decided by crossings, not by rung index (2026-08-18)

The original clause:

> If the top rung still satisfies a gate, the result is reported as
> `≥ 81,500 /s` — a floor, never extrapolated.

is a statement about *evidence*: a gate that was never observed to be crossed
bounds the capacity from below only. The harness implemented it as an index
comparison — capacity equals the highest rung *attempted* — which reads a floor
as a point estimate whenever the topmost rung was excluded by a STOP, even
though no crossing was observed there either.

Registered here, as the same clause made mechanical: a gate's capacity is
reported as a **floor** when **no complete rung above it failed that gate** —
"no crossing observed". A rung that is `incomplete` is evidence of nothing and
neither establishes nor refutes a crossing.
