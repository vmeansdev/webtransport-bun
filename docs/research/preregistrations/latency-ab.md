# Pre-registration — Interleaved H7 A/B, floor rule, and the ingest-vs-egress cross-check

**Registered:** 2026-08-19, before any harness code for this dispatch was written
and before any interleaved arm was run.
**Parent registration:** `docs/research/preregistrations/latency.md` — its stamp
layout, clock, histogram, latency buckets, batch-A/B bands and STOP conditions 1–5
are carried over unchanged except where Amendment 5 (in that file) says otherwise.
**Base:** `rebind4-staging` @ `5ad0245742cbe5c231e0b06b8a42c93622f1ff14`.
**Probe branch:** `probe/latency-01` (never-merge).
**Runner:** heavy self-hosted, 4 vCPU / 8 GB Ubuntu on Hyper-V. Unchanged.
**Consumers:** gate ticket 18 (G2, games) and the H7 batch-default decision.

This document is the contract. Everything it fixes — the rungs, the replicate
count, the interleave order, the floor rule, the honesty check, the confidence
interval, and the four readings the cross-check is allowed to produce — is fixed
*before* the run. An edit after the dispatch is a finding against the author, not
a result.

## Why this dispatch exists

The ladder dispatch produced **one** paired observation per rate, with the two
arms run sequentially as whole 6-rung ladders. The four-axes synthesis is explicit
that this is not a result: *"One paired observation per rate, arms run
sequentially, and the sign flips between the only two rungs (+1.31 ms at 10k,
−128 ms at 25k). Direction at low rate (batching costs tail) is plausible and
worth a dedicated interleaved A/B; it is not established."* Two arms separated by
half an hour of runner time are not a controlled comparison, and n=1 has no
dispersion at all.

Three questions are settled here, in one dispatch, and nothing else:

1. **What does H7 batching cost the ingest tail**, at rates the co-resident
   generator can honestly source, with enough replicates to put an interval on it.
2. **Is 15,000/s real?** G2 is stated at ≥ 15,000/s aggregate and 15k was never a
   measured rung — the ladder ran 10k then 25k. Interpolation is not measurement.
3. **Does the 6.6× ingest-vs-egress tail asymmetry survive inside one dispatch**,
   at one rung, on one clock, with the H7 batch wait switched off in one arm.

It does **not** produce a ladder, a crossing rate, or a capacity number.

## Rungs

100 sessions, 1150 B payloads, echo on — identical to the parent ladder and to the
closed bandwidth ladder, so all three remain comparable.

| rung | per-session /s | aggregate /s | uniform burst | wake period |
|---|---|---|---|---|
| A | 100 | 10,000 | 1 | 10.000 ms |
| B | 150 | **15,000** | 1 | 6.667 ms |
| C | 200 | 20,000 | 1 | 5.000 ms |
| D | 250 | 25,000 | 1 | 4.000 ms |

Chosen as the band the co-resident generator demonstrably sources: the ladder was
arm-level incomplete at every rung ≥ 50,000/s, and 10k and 25k were its only
complete rungs. This dispatch stays inside that band and adds the two rungs
between them. Rung B is G2's rate and is the reason the dispatch exists.

Every rung's wake period clears the Amendment 1 uniform floor (2 ms) with burst 1,
so **every arm here is single-datagram uniform arrival**. The parent registration's
disclosed micro-burst caveat (750/s/session and above) does not apply to any rung
in this document.

The tick arm is **not** run in this dispatch. It is a different arrival process and
a different question; mixing it in would spend the replicate budget on three arms
instead of two.

## Arms, replicates, and the interleave order

An **arm-process** is one server process plus one load-client process, running one
`(arm, rung, replicate)` cell. The batch knob is read once at import, so it cannot
be varied inside a process — that constraint is what forces process-level
alternation rather than in-process interleaving.

| arm | `WEBTRANSPORT_DATAGRAM_BATCH` | arrival |
|---|---|---|
| `default` | unset (= 64) | uniform |
| `batch0` | `0` (legacy one-at-a-time path) | uniform |

**n = 10 pairs per rung.** 4 rungs × 10 pairs × 2 arms = **80 measurement arms**,
plus 6 floor arms (below) = **86 arm-processes in one dispatch.**

Per arm: 3 s server readiness, ~1 s connect (100 sessions staggered 10 ms),
**20 s drive**, **6 s drain grace before the snapshot** (parent registration's
harness correction: the drain is on the useful side of the snapshot), then exit.
20 s at the lowest rung is 200,000 stamped samples, twenty times the
`sample-starvation` floor and enough to place a p99 with the histogram's own
0.4 % resolution.

**Interleave order — fixed, deterministic, and ABBA within each pair:**

```
floor pair 0
for replicate r = 1 .. 10:
    for rung in [A, B, C, D]:                    # always this order
        if r is odd:  run default, then batch0   # AB
        else:         run batch0, then default   # BA
    if r == 5: floor pair 1
floor pair 2
```

The two members of a pair run back-to-back — about 64 s apart — so any slow drift
in host state (thermal, page cache, background runner work) is common to both and
cancels in the paired Δ to first order. Alternating the within-pair order between
replicates cancels the *residual* first-order drift across the dispatch: five pairs
see the drift with one sign, five with the other. Ports advance monotonically
(`4400 + armIndex mod 200`) so no two consecutive arms reuse a port.

**Per-arm wall-clock guard: 120 s.** An arm that exceeds it is killed and its cell
recorded as `arm-timeout` (incomplete, excluded, counted). The parent registration's
dispatch log has one run that hung 55+ minutes in `epoll` after writing its
fragment; an 86-arm dispatch cannot afford to discover that the same way.

## Floor arms and the pinned floor rule

The spec requires that *"every stamp reports the client schedule-lag floor beside
it; a gate evaluates p99 − (pre-registered floor rule fixed before the run, not
after)."* This section is that rule.

**Floor arms.** 6 arm-processes (3 `default`, 3 `batch0`), 100 sessions ×
10/s/session = **1,000/s aggregate**, same 20 s drive / 6 s drain shape, same
payload. That is one fifteenth of rung B and two orders of magnitude below the
measured knee: queueing cannot be present, so what these arms measure is the
harness's own fixed cost — loopback UDP, quinn decrypt, the native queue, the
N-API boundary, one event-loop turn — plus the platform's timer-wake granularity.
They are spread across the dispatch (before replicate 1, after replicate 5, after
replicate 10) so floor drift over the dispatch's ~50 minutes is visible rather than
assumed away.

**Two floors are published:**

- `floorIngestP99Ns` = median over the 6 floor arms of that arm's server ingest p99.
- `floorLagP99Ns` = median over the 6 floor arms of that arm's client schedule-lag p99.

**The pinned rule, used by the G2 gate:**

```
adjustedIngestP99Ns(cell) = max(0, ingestP99Ns(cell) − floorIngestP99Ns)
```

G2 is evaluated on the **median across replicates of `adjustedIngestP99Ns`** in the
`default` arm at rung B, against the registered 5 ms. The **raw** median is
reported beside it with the same interval, always. If the raw median passes 5 ms,
the adjusted figure is not quoted at all — an adjustment that is not needed is not
made.

**Why the floor is the idle ingest cost and not the client's schedule lag.** The
literal reading — subtract client schedule lag from server ingest — subtracts
something the number does not contain. Amendment 1 of the parent registration
established this mechanically: server ingest is measured from the *actual send*
instant written into the payload, so all client-side lateness before that instant
is already outside the interval by construction. Subtracting it would credit the
server with time it never spent. What genuinely inflates every reading, and what a
tick-budget claim should not be charged for, is the harness's own irreducible
cost — and the honest way to measure that is to run the same harness at a load
where queueing cannot exist. `floorLagP99Ns` is reported beside every cell exactly
as the spec requires, and it drives the honesty check below; it is not subtracted.

**Floor validity, fixed now:**

| condition | consequence |
|---|---|
| `floor-not-quiet` — any floor arm's ingest p99 ≥ 1.0 ms | the floor is not a floor. **No adjusted figure is produced**; the gate is evaluated on raw p99 only. |
| `floor-drift` — max/min of the 6 floor ingest p99s > 2.0 | the adjusted figure is **advisory**; raw stands. |
| `floor-exceeds-signal` — `floorIngestP99Ns` > 0.5 × the raw median p99 at rung A | the adjustment is doing more than half the work at the easiest rung. Adjusted figure is **advisory**; raw stands. |

An advisory adjusted figure may be reported and may not carry a gate.

## Generator-honesty check — rung B, precondition

G2 cannot be evaluated at a rate the generator did not produce. All five conditions
are computed for every cell at every rung and reported; at **rung B they are a
precondition**, not a diagnostic.

| # | condition |
|---|---|
| H1 | effective aggregate rate within ±2 % of 15,000/s |
| H2 | `offeredFraction` ≥ 0.98 (the parent STOP's tolerance is 0.90 — this is stricter) |
| H3 | `ticksSkipped` ≤ 0.001 × `sendEvents` |
| H4 | client schedule-lag p99 ≤ 2 × `floorLagP99Ns` (the parent STOP's is 4× — stricter) |
| H5 | `upDeliveryRatio` ≥ 0.995 |

A cell failing any of the five is `dishonest`: excluded from rung B's medians,
excluded from its pairs, and counted in the artifact.

**Rung B is `measured` only when at least 8 of 10 replicates are complete *and*
honest in *both* arms.** If it is not, **G2 is not evaluated at 15,000/s** — the
result is that the rig cannot honestly source G2's rate with a co-resident
generator, which is a finding and is reported as one. It is not repaired by
interpolating between rungs A and C.

## Statistics — medians and intervals

Estimator, pinned: **medians and distribution-free order-statistic intervals.**
No normality assumption, no bootstrap, no seed to argue about, and a median is not
moved by the one arm that met a stray runner hiccup.

**Pairing.** Δ is paired by replicate index within a rung:
`Δᵢ = ingestP99(default, rung, i) − ingestP99(batch0, rung, i)`, computed only
where **both** members of pair *i* are complete (and, at rung B, honest). The two
members ran back-to-back; that is what makes the pairing worth anything.

**Interval.** For *n* values sorted ascending, the reported interval is
`[x₍ₖ₎, x₍ₙ₊₁₋ₖ₎]` where *k* is the largest integer ≥ 1 satisfying
`2 · BinomCDF(k−1; n, ½) ≤ 0.05`. Exact, distribution-free, and its true coverage
is reported alongside (for n = 10, k = 2 and coverage is 97.85 %). When no k ≥ 1
qualifies — n ≤ 5 — the interval is `ci-unavailable` and the median is reported
bare. The same estimator produces every per-arm median p99 interval in this
document.

**Verdict.** The parent registration's Δ bands (`batch-helps` ≤ −0.2 ms,
`batch-free`, `batch-cheap`, `batch-expensive` ≥ 1.0 ms) are unchanged and apply to
the **median Δ**. Four labels can attach, and every one of them only weakens a
claim:

- `ab-ci-spans-bands` — the interval's endpoints fall in different bands. The
  bucket is advisory; the interval is the result.
- `ab-unresolvable` — |median Δ| ≤ `deltaUncertaintyMs` (Amendment 2's
  quantization term). Bucket advisory.
- `ab-confounded` — the arms' median `upDeliveryRatio` differ by more than 0.02.
  Bucket advisory. An arm that drops more datagrams buys a better tail for free.
- `ab-cpu-asymmetric` — the arms' median `hostCpuPctMedian` differ by more than
  10 points at that rung. Bucket advisory. (The spec requires CPU symmetry between
  compared arms, or a disclosed asymmetry with a tolerance; this is that tolerance.)

## Registered cross-check — ingest tail vs egress tail

The four-axes synthesis flags, as *"genuine unresolved cross-axis tension"*, that
**the ingest tail is ~6.6× the egress tail** (latency arm at 25k/s vs egress arm at
32.6k/s) and that it is undecided whether that is a real path difference (H7 batch
wait + JS delivery versus a direct send) or an artifact of comparing two harnesses
across two runs. The spec makes resolving it an obligation *inside this dispatch*,
before G2 or G3 stamps.

**Method.** Both directions are measured on the same datagram, in the same
processes, at the same rung, on the one `CLOCK_MONOTONIC` both ends read. The
server echo carries a second stamp field written immediately before its
`sendDatagram` call (stamp version 2, `echoActual`). That splits the existing
round trip into three intervals that sum to it exactly, per datagram:

| interval | measured by | contains |
|---|---|---|
| `ingest` | server | actual send → JS handler body entry: loopback, decrypt, native queue, **H7 batch wait**, N-API, event loop |
| `turnaround` | server | JS handler entry → the echo's `sendDatagram` call instant |
| `egress` | client | echo send instant → `receive_datagram` returns in the client |
| `rtt` | client | actual send → client receive. **`ingest + turnaround + egress = rtt`, exactly, per datagram.** |

The H7 batch wait is in `ingest` and in nothing else — batching is a receive-side
lever and the echo send does not pass through it. So the `batch0` arm is a direct
subtraction of the batch wait from the ingest leg, with the egress leg held fixed.
That is the isolation the spec asks for, and it needs no second harness.

**Validity, fixed now:**

- `crosscheck-clock-invalid` — the client also records
  `upstreamPlusTurnaround = echoActual − actualSend` (both stamps, one payload, so
  the client can compute the server's first two legs without trusting anything but
  the shared clock). If
  `|(server ingest p50 + server turnaround p50) − client upstreamPlusTurnaround p50| > 0.2 ms`
  the two processes do not agree about the same datagrams and **the cross-check
  produces nothing.**
- `egress-survivorship` — only datagrams that survive *both* directions yield an
  egress sample. `echoReturnRatio` = client datagrams received / server echoes sent
  is reported per cell; below 0.98 at a rung, that rung's egress figure is
  **advisory**.
- The parent STOP 3 (`one-way ≤ RTT`) still applies to `ingest` and now also to
  `egress` and to `upstreamPlusTurnaround`.

**Statistic.** `asymmetryRatio(arm, rung) = median ingest p99 / median egress p99`,
over complete replicates, with the order-statistic interval carried through both
medians and the ratio reported at the interval endpoints.

**The four readings, fixed before the run.** Exactly one is reported; which one is
determined mechanically at rung B and cross-tabulated at every rung.

| reading | condition (rung B) | what it means |
|---|---|---|
| **R1 — the batch wait is the mechanism** | `ratio_default ≥ 3` and `ratio_batch0 ≤ 1.5` | The asymmetry is the H7 batch fill wait. The H7 default decision must price it, and G3's egress numbers are not comparable to G2's ingest numbers without it. |
| **R2 — a path difference, not the batch** | `ratio_default ≥ 3` and `ratio_batch0 ≥ 3`, the two within 25 % of each other | The asymmetry belongs to the receive direction as a whole (loopback → decrypt → native queue → N-API → event loop) versus a direct send. H7 is not the cause; the ratio is a property of direction and both gates keep their own units. |
| **R3 — a cross-run artifact** | `ratio_default ≤ 2` **and** `ratio_batch0 ≤ 2`, at every rung | The 6.6× does not reproduce inside one dispatch on one clock. It is withdrawn as an artifact of comparing two harnesses across two runs, and the cross-axis tension is closed. |
| **R4 — inconclusive** | anything else | No mechanism claim. The numbers are published, the tension stays open, and the G2/G3 stamps say so. |

## STOP conditions

Parent STOPs 1–5 (`generator-saturation`, `offered-shortfall`, `clock-invalid`,
`delivery-collapse`, `sample-starvation`) apply **per cell, unchanged**, with one
substitution forced by the interleaved shape and registered as Amendment 5 in the
parent document: the schedule-lag floor that STOP 1 compares against is the
**dispatch-level** `floorLagP99Ns` measured by the floor arms, not the
within-arm minimum across ladder steps — an arm-process here runs one rung, so a
within-process minimum is that rung's own value and the rule could never fire.

**Floor-arm clause.** STOP 1's schedule-lag half compares a cell's lag against
`floorLagP99Ns`, which the floor arms themselves define. Evaluating it on a floor
arm is circular, so on a floor arm that half is inert and STOPs 2–5 (and the
`ticksSkipped` half of STOP 1, which is absolute) do the work. A floor arm that
trips any of those is excluded from the floor, and the floor is the median of
those that remain. If fewer than 3 floor arms survive, `floor-not-quiet` fires and
no adjusted figure is produced. *(Registered 2026-08-19 with the rest of this
document, before any run: it closes a gap in the rules rather than changing one.)*

Added for this dispatch:

6. **`arm-timeout`** — the arm-process exceeded its 120 s wall-clock guard and was
   killed. Incomplete, excluded, counted.

Completeness is redefined for the interleaved shape (also Amendment 5): the
parent's arm-level STOP (*"every step at or above 50,000/s incomplete"*) and
run-level STOP are ladder-shaped and no rung in this document reaches 50,000/s.

- A **cell** is complete when it trips no STOP.
- A **rung** is `measured` when ≥ 8 of 10 replicates are complete in **both** arms
  (and, at rung B, honest).
- The **dispatch** is complete when rung B is `measured`. If it is not, this
  dispatch licenses no A/B claim and no G2 evaluation, and says so.

## What this dispatch may not do

Carried from the parent registration, and binding here:

- It may not optimize. A lever that appears in the data is recorded in notes and
  left alone.
- It may not re-propose coresplit/taskset pinning, `rmem` raises, or BBR. All three
  are falsified.
- It may not be re-tuned to clear a bucket boundary or a gate.
- It may not quote a local macOS smoke number as a result. Local smoke exists only
  to prove the harness runs and that its output parses.

Added here:

- It may not produce a ladder, a p99 crossing rate, or a capacity figure. Four
  rungs inside a band the generator can source is not a ladder.
- It may not interpolate rung B from rungs A and C under any circumstance. If B is
  not `measured`, B is not measured.
- Its `egress` leg may not be quoted as the egress axis's number. See the
  disclosure below.

## Disclosures

- **The egress leg here is echo egress.** It is reactive — one send per arrival,
  issued from inside the receive handler on the same JS thread — not the egress
  axis's scheduled originator. That is precisely what makes it a *same-rung,
  same-payload, same-process* comparator for the ingest leg, which is what the
  cross-check needs. Its absolute value is not the G3 axis's `egressOneWay` and is
  not offered as one.
- **Survivorship.** Only round-trip survivors produce an egress sample.
  `echoReturnRatio` bounds it and is reported per cell.
- **Co-residence.** Unchanged and total: the generator shares the 4 vCPU with the
  server, so every percentile in this dispatch is an upper bound on server latency,
  never an isolated server figure.
- **The floor arms are also co-resident.** `floorIngestP99Ns` therefore contains
  the harness's co-resident idle cost, which is the point — and it is why the
  adjusted figure is published beside the raw one rather than instead of it.

## Dispatch log

Every dispatch of this registration is logged here, including aborted ones. A run
that is not in this table did not happen.

| # | run id | candidate SHA | outcome | artifact hash |
|---|---|---|---|---|
| 1 | 32203374334 | `probe/latency-01` @ `0181666` (staging base `5ad0245`) | **complete run, dispatch incomplete by its own rule.** 86/86 arm-processes ran, none hit the 120 s guard. Floor `notQuiet` (ingest p99 1.32 ms ≥ 1.0 ms) → no adjusted figure; the gate is evaluated on raw p99, as registered. Rung A `measured`; rung B complete 10/10 in both arms but **honest 0/10 in both** (H4 in 20/20, H3 in 17/20) → B is not `measured`, so **G2 is not evaluated at 15,000/s** and is not interpolated. Rung C `measured` but honest 0/20. Rung D `generator-saturation` in 19/20. Cross-check reading **R4 — inconclusive** (the gate rung produced no ratio); clock valid (disagreement 0.0086 ms ≪ 0.2 ms). Classifier re-run independently from the fragments by the gate agent: output byte-identical apart from `classifiedAt`. | `sha256:6b71c709603a5f05f125b65ebe24fae0cfb995c0220914afe77a4a69d292aaf8` (`…-classified.json`) |
