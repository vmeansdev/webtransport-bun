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
