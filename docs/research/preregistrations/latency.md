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

1. **`generator-saturation`** — client schedule-lag p99 ≥ 2.0 ms, **or**
   schedule-lag p99 ≥ 0.5 × server-ingest p99. The generator is queueing on its
   own send path and the measured tail is at least half the client's, not the
   server's. This is the canonical STOP for this axis.
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

## Reusability note (egress axis)

The stamp layout, the shared clock, and the histogram are separate modules with
their own commits (`tools/load/latency-clock.ts`, `latency-histogram.ts`,
`latency-stamp.ts`, `crates/reference/src/latency_probe.rs`) precisely so the
egress axis can branch from `probe/latency-01` and reverse the direction of
measurement without touching the bench driver.
