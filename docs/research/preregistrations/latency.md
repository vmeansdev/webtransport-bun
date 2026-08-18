# Pre-registration — Axis: latency & jitter

**Registered:** 2026-08-18, before any harness code was written.
**Base:** `rebind4-staging` @ `5ad0245742cbe5c231e0b06b8a42c93622f1ff14`.
**Probe branch:** `probe/latency-01` (never-merge).
**Runner:** heavy self-hosted, 4 vCPU / 8 GB Ubuntu on Hyper-V. Unchanged.

This document is the contract. The classifier buckets, the STOP conditions and
the ladder below are fixed *before* the run. Any edit to this file after a run is
dispatched is a finding against the author, not a result.

## What is being measured

**Primary metric — server ingest latency.** Wall time from the load client's
`send_datagram` call returning control (the *actual send* stamp, written into the
datagram payload) to the moment that datagram is yielded to the JavaScript
`for await (... of session.incomingDatagrams())` handler body in the Bun server
process. This interval contains: loopback UDP, quinn decrypt, the native
datagram queue, the H7 batch fill wait, the N-API boundary, and the Bun event
loop. It is the interval H7 batching trades against, and it is the number a game
server's tick budget is spent on.

**Secondary metric — client RTT.** Measured entirely inside the load client
against its own clock: stamp → server echo → back. Single process, single clock,
zero cross-process clock assumptions. Its role is a **cross-check**: one-way
ingest latency must be ≤ RTT for every percentile, or the shared-clock
assumption is broken and the run is void (see STOP `clock-invalid`).

**Diagnostic — client schedule lag.** Each datagram carries both its *intended*
send instant (the tick/interval deadline) and its *actual* send instant. Their
difference is the generator's own queueing. This is the co-residence tax made
visible, and it is the mechanical basis of the generator-saturation STOP.

### Clock

Both processes read `clock_gettime(CLOCK_MONOTONIC)` — Rust via `libc`, Bun via
`bun:ffi`. On Linux that is one system-wide counter, so the two processes share
an epoch exactly; no NTP, no realtime, no calibration constant.

For the server hot path the per-datagram FFI call is replaced by
`Bun.nanoseconds()` plus a startup offset, **only if** a 64-sample paired
calibration shows the two clocks advance together within 1 µs. The measured
calibration residual is written into the output; if the fast path is not proven
the harness falls back to a direct FFI read per datagram. Either way the residual
is reported and gates the run (STOP `clock-invalid`).

### Disclosed inflation

The generator is co-resident with the server on the same 4 vCPU. Section 1 of
`docs/research/2026-08-18-bandwidth-ceiling-attribution.md` establishes that
co-residence caps the *offered rate*; here it also inflates the *tail*, because
client send-side scheduling and server receive-side work contend for the same
cores. Every number produced by this harness is therefore an **upper bound** on
server latency, not an isolated server figure. On-box is nevertheless the correct
choice: it is the only configuration where the two ends share a clock, and the
off-box path is known-lossy (Hyper-V vswitch), which would make one-way timing
survivorship-biased on top of everything else.

## Payload stamp layout

28-byte little-endian header, then `x` padding to `--payload-bytes`:

| offset | size | field |
|---|---|---|
| 0 | 2 | magic `0x4C54` (`"LT"`) |
| 2 | 2 | version = 1 |
| 4 | 8 | intended send, CLOCK_MONOTONIC ns |
| 12 | 8 | actual send, CLOCK_MONOTONIC ns |
| 20 | 8 | per-session sequence |

`--payload-bytes` < 28 is rejected at startup.

## Arms

Three arms, each a fresh server process (the batch knob is read once at import,
so it cannot be varied inside a process).

| arm | `WEBTRANSPORT_DATAGRAM_BATCH` | arrival profile |
|---|---|---|
| `default` | unset (= 64) | uniform, per-session interval ticker |
| `batch0` | `0` (legacy one-at-a-time path) | uniform, identical to `default` |
| `tick` | unset (= 64) | 64 Hz synchronized burst, all sessions aligned to one shared epoch |

`default` vs `batch0` is the H7 tail-cost A/B — same shape as the original H7
throughput gate, so the two are comparable.

`tick` is deliberately **not** the constant-rate ladder: at 64 Hz every session
fires `round(rate / 64)` datagrams back-to-back at the same shared deadline, then
goes silent for the remaining ~15.6 ms. Best case for batch fill, worst case for
tail.

## Ladder

100 sessions, 1150 B payloads (identical to the closed bandwidth ladder, so the
two are comparable). Per-session rates and their aggregate offered load:

| step | per-session /s | aggregate /s |
|---|---|---|
| 1 | 100 | 10,000 |
| 2 | 250 | 25,000 |
| 3 | 500 | 50,000 |
| 4 | 750 | 75,000 |
| 5 | 900 | 90,000 |
| 6 | 1100 | 110,000 |

60 s per step, 10 s settle between steps. Step 6 sits above the ~103k ceiling on
purpose: it is expected to trip a STOP, and a pre-registered expected STOP is
evidence, not a failure.

The server's `datagramsPerSec` limiter is set to 4× the top aggregate step so the
limiter is never the thing being measured.

**This is not a 160k run.** The ladder stops at 110k. The closed ceiling is not
being re-litigated.

## Classifier buckets

Buckets are applied mechanically to each `(arm, step)` after STOP evaluation.
A step that trips any STOP is `incomplete` and is excluded from every curve and
every A/B; it is never bucketed.

### Latency verdict — on server ingest p99

| bucket | rule |
|---|---|
| `ok-realtime` | p99 < 1.0 ms |
| `ok-interactive` | 1.0 ms ≤ p99 < 5.0 ms |
| `degraded` | 5.0 ms ≤ p99 < 20.0 ms |
| `unusable` | p99 ≥ 20.0 ms |

Reported alongside, never in place of: p50, p90, p99, p999, p9999, max, and the
sample count. The headline claim this axis is allowed to make is of the form
"server ingest p99 crosses N ms at R datagrams/s offered, 100 sessions, 1150 B,
4 vCPU, co-resident generator" — for the largest step that is complete.

### H7 batch tail cost — `Δ = p99(default) − p99(batch0)` at equal offered rate

Computed only for rates where **both** arms produced a complete step.

| bucket | rule |
|---|---|
| `batch-helps` | Δ ≤ −0.2 ms |
| `batch-free` | −0.2 ms < Δ < 0.2 ms |
| `batch-cheap` | 0.2 ms ≤ Δ < 1.0 ms |
| `batch-expensive` | Δ ≥ 1.0 ms |

The A/B is only interpretable together with delivered ratio: an arm that drops
more datagrams reports a better tail for free. Any bucket is reported with both
arms' `upDeliveryRatio`, and if they differ by more than 0.02 the A/B is labelled
`ab-confounded` and the Δ bucket is advisory only.

### Tick absorption — `tick` arm only

| bucket | rule |
|---|---|
| `tick-absorbed` | p99 < 15.625 ms (one 64 Hz period) |
| `tick-overrun` | p99 ≥ 15.625 ms |

Also reported: `intraTickSpreadMs = p99 − p50`, the jitter a client-side buffer
would have to hide.

## STOP conditions

Evaluated per step, in this order. First match wins and is recorded as the step's
`stop` reason.

1. **`generator-saturation`** — *amended, see Amendment 1 below; the original
   rule is preserved there.* The generator did not offer the registered load,
   shown by either:
   - `ticksSkipped ≥ 0.10 × sendEvents` — the send scheduler dropped whole send
     events. Same 10 % tolerance rule 2 already registers for volume, expressed
     on send events rather than datagrams, because in the tick arm one event
     carries a whole burst; **or**
   - `scheduleLag p99 ≥ 4 × scheduleLagFloor`, where `scheduleLagFloor` is the
     minimum `scheduleLag p99` across every step of the *same arm*. A within-arm
     control, so the platform's fixed timer-wake granularity — which is present
     at idle and is not queueing — is subtracted rather than mistaken for load.

   `scheduleLag` measures wake lateness only: the first datagram of each send
   event against its deadline. `burstSpread` (first-to-last within one send
   event) is reported separately and is never a STOP.
2. **`offered-shortfall`** — datagrams actually sent < 0.90 × requested
   (`sessions × rate × stepSeconds`). The step did not run the load it claims.
3. **`clock-invalid`** — negative one-way latency samples > 0.1 % of stamped
   samples, **or** startup calibration residual > 50 µs, **or** server p99 >
   client RTT p99 (one-way cannot exceed round trip).
4. **`delivery-collapse`** — `upDeliveryRatio` < 0.80. Latency conditioned on
   arrival is survivorship-biased once a fifth of the load is missing.
5. **`sample-starvation`** — fewer than 10,000 stamped samples in the step.

**Arm-level STOP:** if every step at or above 50,000 aggregate /s is incomplete,
the whole arm is `incomplete` and contributes nothing.

**Run-level STOP:** if the `default` arm is arm-level incomplete, the run is
`incomplete` and no latency claim is made. A run that stops is a result about the
harness or the host, and it will be reported as such rather than rationalized.

## What this run may not do

- It may not optimize. If a lever appears in the data it is recorded in notes and
  left alone. Measurement and optimization do not share a pass.
- It may not re-propose coresplit/taskset pinning, `rmem` raises, or BBR. All
  three are falsified in the attribution doc.
- It may not be re-tuned to clear a bucket boundary. A merge bar is not a physics
  result, and neither is a latency bar.
- It may not quote a local macOS smoke number as a result. The local smoke exists
  only to prove the harness runs and that its output parses into the buckets
  above.

## Amendment 1 — generator-saturation, 2026-08-18, before any measurement run

**Status:** amended after local macOS harness smoke, **before** any run was
dispatched to the runner. No measurement data existed when this was written. The
original rule is quoted in full so the change is auditable rather than quiet.

**Original rule 1:** *client schedule-lag p99 ≥ 2.0 ms, or schedule-lag p99 ≥
0.5 × server-ingest p99.*

**Why it was wrong.** Local smoke at trivial load — 8 sessions, 1,600
datagrams/s aggregate, three orders of magnitude below anything that could
queue — produced schedule-lag p99 of 2.6–6.1 ms in all three arms. That is
tokio/OS timer wake granularity: a constant floor present at idle, not
queueing. Both halves of the original rule fire on that floor, so every step of
every arm would have been voided regardless of load, and the run would have
reported `incomplete` for a reason that has nothing to do with the host.

The second half was also mis-aimed. Server ingest latency is measured from the
*actual* send instant written into the payload, so client lag before that
instant is excluded from the server's number by construction — client lag cannot
inflate server latency, only the offered load's shape. Rule 1's job is to detect
that the shape was not the registered one; the amended form measures that
directly, and rule 2 (`offered-shortfall`) remains the blunt check on volume.

**Also changed, in the same amendment:** `scheduleLag` now records only the first
datagram of each send event. Recording every datagram folded a burst's own
duration into the tick arm's lag, which grows with rate for a purely structural
reason (burst size is `rate / tick_hz`) and would have stopped the tick arm at
its top rungs by construction. That duration is now reported separately as
`burstSpread`, which is a diagnostic and never a STOP.

**Third change, same amendment — the uniform arm's wake period has a floor.**
The original design asked tokio for one wake per datagram, which at the top
rungs means a 0.9–1.1 ms period against a timer wheel whose granularity is about
1 ms on both Linux and macOS. The generator would then have silently produced
roughly half the requested rate and the ladder's top would have measured a load
that was never offered. The uniform arm now keeps its wake period at or above
**2 ms** and sends the smallest whole burst that still hits the requested rate
exactly:

| per-session rate | burst | period |
|---|---|---|
| 100 | 1 | 10.000 ms |
| 250 | 1 | 4.000 ms |
| 500 | 1 | 2.000 ms |
| 750 | 2 | 2.667 ms |
| 900 | 2 | 2.222 ms |
| 1100 | 3 | 2.727 ms |

**Disclosed consequence:** at 750/s/session and above, "uniform" means micro-bursts
of two or three datagrams, not one. Sessions remain phase-staggered across the
period, so aggregate arrivals stay spread, and the tick arm's 64 Hz bursts (2 to
17 datagrams, all sessions on one shared deadline) remain a categorically
different shape. Any p50/p99 read at the top two rungs carries this caveat.

Everything else in this document — the ladder, the arms, the latency buckets,
the batch A/B rule, the tick-absorption rule, and STOP conditions 2 through 5 —
is unchanged from the original registration.

## Reusability note (egress axis)

The stamp layout, the shared clock, and the histogram are separate modules with
their own commits (`tools/load/latency-clock.ts`, `latency-histogram.ts`,
`latency-stamp.ts`, `crates/reference/src/latency_probe.rs`) precisely so the
egress axis can branch from `probe/latency-01` and reverse the direction of
measurement without touching the bench driver.
