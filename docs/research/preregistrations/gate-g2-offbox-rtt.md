# Pre-registration — G2 conversion: off-box, client-measured RTT

**Registered:** 2026-08-19, before any harness code for this dispatch was written.
**Status:** registered; no dispatch has been made.
**Effort:** production-grade scenarios, phase 2 (`.scratch/production-grade-scenarios/`),
ticket 25. Maintainer directive: *"there will be no SOAK until all PASS."*
**Base:** `rebind4-staging` @ `b4af780ad3902c27ae69ca9f2f3a7c8c3172cdb7`.
**Probe branch:** `probe/latency-rtt-01` (never-merge) — `probe/latency-01`'s
instrument commits rebased onto that base, plus this document and the harness
below. `probe/latency-01` @ `c2e8369` is left untouched so phase-1's stamp keeps
its provenance.
**Server host (runner):** heavy self-hosted, 4 vCPU / 8 GB Ubuntu, Hyper-V,
`hv_netvsc`, LAN `192.168.2.35`.
**Generator host (new):** `v-ubuntu-loadgen`, 3 vCPU / 1280 MB static, LAN
`192.168.2.36`, sibling Hyper-V guest on the same Windows host, clone of the
runner's frozen parent VHDX. Powered off; power-on runbook:
`docs/research/runbooks/2026-08-19-offbox-loadgen.md`.
**Consumer:** gate ticket 25 (G2 conversion). This registration replaces G2's
metric and rig; it does not rerun anything.

---

## 0. Disclosure: phase-1's results are known to the author of this document

Spec §rerun policy makes a miss final, and the effort's rules require that a
pre-registration written after earlier results exist says so and derives its
thresholds from first principles or from prior-phase data — never from the run it
will judge. This section is that disclosure, in full.

**What I read before writing this document.** The phase-1 G2 stamp
(`issues/18-gate-g2-games.md`), and the 86 raw cell fragments of run
`32203374334` (`bench-latency-ab-0181666…`), from which I recomputed, myself, the
per-rung medians below. Nothing here is second-hand.

Pooled across both arms (`default` and `batch0`), 20 cells per rung, medians of
per-cell values, all **pre-landing** (candidate `0181666`, staging base
`5ad0245`):

| rung | aggregate /s | client RTT p99 | RTT p999 | server ingest p99 | egress p99 | turnaround p99 | client schedule-lag p99 | ticksSkipped/sendEvents | server CPU (% of one core) | host CPU (% of 4 cores) |
|---|---|---|---|---|---|---|---|---|---|---|
| F | 1,000 | **1.77 ms** | 2.91 ms | 1.32 ms | 0.62 ms | 0.03 ms | 1.30 ms | 0.00000 | 75 | 32 |
| A | 10,000 | **6.43 ms** | 16.73 ms | 5.14 ms (default arm) | 2.67 ms | 0.01 ms | 2.16 ms | 0.00062 | 159 | 66 |
| B | 15,000 | **26.64 ms** | 37.16 ms | 22.77 ms | 6.58 ms | 0.01 ms | 3.10 ms | 0.00115 | 189 | 80 |
| C | 20,000 | 93.45 ms | 119.67 ms | 63.11 ms | 17.53 ms | 0.01 ms | 4.58 ms | 0.00829 | 207 | 88 |
| D | 25,000 | 232.52 ms | 262.93 ms | 122.03 ms | 35.98 ms | 0.01 ms | 5.61 ms | 0.04140 | 218 | 95 |

The ticket's "10k rung RTT p99 ≈ 6.4 ms" is the rung-A pooled figure above; it
reproduces at 6.43 ms.

**Where each of those numbers is used in this document, and where it is not:**

- The **10 ms bound is not derived from any of them.** §2 derives it from the
  64 Hz tick budget alone. The prior numbers are used in §3 for one purpose only:
  to show the bound is *decidable* — that it sits between two already-measured
  regimes, so neither verdict is settled before the run.
- Rung B's 26.64 ms is the **on-box** number the off-box hypothesis is about. It
  is quoted as the thing to be explained, never as a threshold.
- The rung-F floor figures are quoted as an **order-of-magnitude sanity check on
  the floor-quiet STOP in §8**; the STOP's own numeric is derived in that section
  and is deliberately loose relative to them.
- The CPU decomposition in §3 is prior-phase data used for a feasibility
  argument, disclosed as such.
- **No phase-1 latency value is a threshold anywhere in this document.**

**Two-products disclosure.** Phase-1's G2 ran on candidate `0181666`, whose base
is `5ad0245` — *before* the four lever series and the T03 close/liveness work
landed on `rebind4-staging`. Those landings changed the datagram send path on
exactly this workload class (echo, 100 sessions, 1150 B): T03 reports "+20%
delivered, echo errors ÷6–10". **This dispatch runs on the post-landing tree
(`b4af780`).** The two are therefore *different products*, the phase-1 table
above characterises the older one, and no number from this dispatch may be
differenced against a number from that one. The on-box control arm in §5 exists
so that the off-box comparison is made *within* this dispatch, on one tree.

---

## 1. What is gated, exactly

**G2 (converted):** on the **shipped default configuration** — no
`WEBTRANSPORT_DATAGRAM_BATCH` override, no window overrides, no knobs — with the
load generator on `v-ubuntu-loadgen` and the data path over LAN:

> at **15,000 datagrams/s aggregate** (100 sessions × 150/s, 1150 B payload,
> uniform arrival, echo on), the **client-measured round-trip time p99 is
> ≤ 10.0 ms**.

The statistic is defined in §9; the preconditions that make it evaluable are in
§§6–8; the verdict algebra is §10.

**Why RTT and not the old one-way ingest metric.** Once the generator leaves the
box, the two ends no longer share `CLOCK_MONOTONIC`, and every cross-host
interval (server ingest, client-measured egress, upstream+turnaround) becomes an
arbitrary constant plus a latency. A round trip is measured entirely on the
client's own clock — one `monotonic_ns()` at send, one at receive, on the same
counter in the same process — so it survives the move with no synchronisation
assumption of any kind. It is also the *stronger* statement: RTT contains the
server's ingest leg, its turnaround, its egress leg and two wire legs, all of
which are non-negative, so an RTT bound upper-bounds each of them.

---

## 2. Derivation of the 10.0 ms bound — first principles

The scenario is FPS/MOBA. The product quantity is the server tick period.

1. A competitive server tick rate of **64 Hz** gives a tick period of
   **15.625 ms**. (64 Hz is already this axis's registered tick rate:
   `DEFAULT_TICK_HZ = 64` in `load_client.rs`, registered in
   `preregistrations/latency.md` before any run.)
2. For a client's input to be reflected in the authoritative state the client
   renders on its *next* frame, the input must reach the server, be simulated,
   and the resulting state must reach the client, all inside one tick period.
   Anything longer costs a whole extra tick of perceived delay.
3. That period must therefore cover: transport round trip + server simulation +
   serialisation + the client's own receive-to-render queue. Allocating
   **≤ 64% of the tick period to the transport round trip** leaves 5.6 ms for
   everything the game engine does. 64% of 15.625 ms = **10.0 ms**.

The bound is the transport's share of one tick, and it is stated for a LAN rig:
there is no WAN leg in this measurement and none is implied. A real deployment
spends its remaining budget on the internet path; this gate says only that the
transport and its host do not eat the tick before the network gets it.

**Relationship to the retired bound.** The old G2 asked for server ingest
p99 ≤ 5 ms at the same rate. RTT = ingest + turnaround + egress + two wire legs,
each ≥ 0, so RTT ≤ 10 ms implies ingest ≤ 10 ms and the new bound is a *weaker*
constraint on the ingest leg alone and a *stronger* constraint on the path as a
whole. This is disclosed rather than argued: the metric changed because the rig
changed, and the two bounds are not interchangeable. No claim of the form "G2's
old bar was met" may be made from this dispatch.

---

## 3. Decidability — the bound is not settled in advance

A gate that cannot fail is not a gate, and a gate that cannot pass is a rig
report. Both directions are checked here, from **pre-landing** data only.

**It can fail.** On-box at the same 15,000/s rung, RTT p99 was 26.64 ms —
**2.7× the bound**. If moving the generator off the box changes nothing, this
gate misses, loudly.

**It can pass.** The mechanism the move addresses is CPU contention between
generator and server on 4 vCPU. Prior-phase decomposition (percent of one core;
4 vCPU = 400 available):

| rung | server process | host total | generator + system (host − server) | idle |
|---|---|---|---|---|
| A (10k) | 159 | 264 | ≈ 105 | ≈ 136 |
| B (15k) | 189 | 320 | ≈ 131 | ≈ 80 |

Off-box, the ≈131 points the generator spends at 15k leave the box. The server
would run at ≈189 of 400 with ≈211 idle — *more absolute headroom than it had at
10k on-box*, where RTT p99 was 6.43 ms. That is a plausibility argument, not a
prediction, and it is exactly why the answer is worth measuring.

**Both statements come from the pre-landing tree** and the run judged here is the
post-landing tree; they establish decidability, nothing else.

---

## 4. What moving off-box does and does not remove — stated now

`v-ubuntu-loadgen` and the runner are **sibling guests on one 8-logical-core
Windows host**. Therefore:

- **Removed:** guest-level CPU contention. The generator's threads no longer
  compete with the server's inside one 4-vCPU scheduler, and the generator's
  wake latency no longer depends on the server's queue.
- **Not removed:** host-level contention. 4 + 3 = 7 vCPU are scheduled onto 8
  logical cores by the Hyper-V root partition. This dispatch is *not* a
  dedicated-hardware measurement and does not claim to be.
- **Added:** two virtual-switch wire legs, and the loss behaviour that goes with
  them (§7).

Every claim made from this dispatch carries this paragraph.

---

## 5. Rungs, cells and the dispatch order — fixed now

One cell = one `bench-latency.ts` process at one rung with one generator
placement. 100 sessions, 1150 B, uniform arrival, echo on, **20 s drive**,
**6 s drain grace before the snapshot**, per-cell wall-clock guard **150 s**
(phase-1's 120 s plus the ssh round trips). Drive/drain are phase-1's values,
carried over unchanged rather than chosen here.

| rung | aggregate /s | per-session /s | placement | cells | role |
|---|---|---|---|---|---|
| `F-off` | 1,000 | 10 | loadgen | 3 | floor arms **on the loadgen** (§8) |
| `F-on` | 1,000 | 10 | runner | 3 | wire-cost control at idle (§8) |
| `A-off` | 10,000 | 100 | loadgen | 3 | context only; carries no verdict |
| `G-off` | **15,000** | **150** | **loadgen** | **10** | **the gate** |
| `G-on` | 15,000 | 150 | runner | 3 | on-box control, context only |

22 cells. `G-on` exists so that "off-box changed the answer" is measured inside
this dispatch on one tree, instead of differenced against phase-1's other tree.
It **cannot pass or fail G2** and no verdict may be built on it.

**The order, fixed and deterministic** (index → cell; port = 4500 + index):

```
 0 F-off r0   1 F-on r0   2 A-off r1   3 G-off r1   4 G-on r1
 5 G-off r2   6 G-off r3   7 A-off r2   8 F-off r1   9 F-on r1
10 G-off r4  11 G-on r2  12 G-off r5  13 G-off r6  14 A-off r3
15 G-off r7  16 G-on r3  17 G-off r8  18 G-off r9  19 G-off r10
20 F-off r2  21 F-on r2
```

Floor arms sit at the start, the middle and the end so drift across the ~25
minute dispatch is visible rather than assumed away. On-box controls are spread
through the gate replicates for the same reason. The order lives in
`tools/load/latency-rtt-schedule.ts` as a pure function with its own tests, so
the conductor cannot drift from this document.

**Cell 0 is the reachability pre-flight.** If `F-off` at index 0 yields
`sessionsOk < 90`, the conductor aborts the whole dispatch immediately with
`offbox-unreachable`. That is an infra fault, declared and logged; the gate is
**INCOMPLETE**, and a re-dispatch after the fault is fixed is permitted by spec
§rerun policy because the fault is declared and logged. No cell after an abort is
run, and no partial result from an aborted dispatch may be quoted.

---

## 6. Off-box integrity — a cell is off-box only if it proves it

An arm that silently fell back to loopback would produce a beautiful number and a
false claim. Four independent marks are recorded per cell, and a `G-off` cell
missing any of them is **not off-box** and is excluded (counted, disclosed):

| # | mark | rule |
|---|---|---|
| O1 | `generator.mode` = `offbox`, with `ssh` and `urlHost` recorded | present |
| O2 | `urlHost` matches `^192\.168\.2\.` | LAN only. A `100.` (Tailscale) address is a **hard refusal** at conductor start, not a cell exclusion. |
| O3 | LAN interface counters (`/proc/net/dev` delta over the cell) show `rxBytes ≥ 0.5 × clientSent × 1150` | the datagrams crossed the NIC |
| O4 | loopback counters show `rxBytes < 0.1 × clientSent × 1150` | they did not cross `lo` |

O3's coefficient is loose on purpose: UDP GRO coalesces receive-side *packets*,
so packet counts undercount datagrams, and bytes carry framing overhead the
harness does not model. O3 and O4 are presence/absence assertions, not
accounting.

Symmetrically, an `F-on`/`G-on` cell must have `generator.mode` = `onbox` and
must fail O3/pass the inverse of O4, or it is excluded from the control.

**Cross-host clock integrity.** Off-box, the harness records **no cross-host
interval at all**, by construction rather than by convention:

- the server does not write its echo-send instant into the payload, so the client
  records neither `egressOneWay` nor `upstreamPlusTurnaround` (both stay empty
  and `echoMissingEchoInstant` equals the echoes received);
- the server does not record `ingest` (the stamp's send instant belongs to
  another machine's counter), so its histogram stays empty;
- `turnaround` is server-local at both ends and is still recorded, as a
  diagnostic.

The classifier **asserts** on every off-box fragment that
`ingest.count == 0`, `egressOneWay.count == 0`,
`upstreamPlusTurnaround.count == 0` and
`echoMissingEchoInstant == clientReceived`. A fragment that violates any of these
manufactured a cross-host number and makes the dispatch **INCOMPLETE**
(`crosshost-contamination`). No off-box ingest, egress or one-way figure exists
to be quoted, from this run or ever.

---

## 7. Loss, censoring, and the vswitch

The virtual switch between the two guests drops, burstily and invisibly: the
ceiling-attribution work measured 0–26% loss seconds under a 160k-pps iperf3
pre-flight, and off-box QUIC at 160k delivered 62k of 64k framed. This gate runs
at **15,000/s aggregate ≈ 9.4% of that offered rate**, so the regime is different
— but the mechanism is real and is registered against here, not hoped away.

**Why loss matters for an RTT p99 specifically.** A datagram that never comes
back produces *no RTT sample*. Loss therefore censors the tail **in the gate's
favour** unless it is corrected for. It is corrected for, as follows.

Per cell, let `f = 1 − rtt.count / clientSent` (the fraction of sent datagrams
that produced no round-trip sample). Treating a non-returning datagram as
infinite latency — which is what it is, to a game client — the p99 over *all*
sends is the survivor quantile at `0.99 / (1 − f)`:

```
rttP99CensoredNs(cell) = rttHistogram.percentile(0.99 / (1 - f))     for f < 0.01
                       = +infinity                                    for f >= 0.01
```

**The gate is evaluated on `rttP99CensoredNs`.** The raw survivor p99 is reported
beside it always. The correction can only move the figure up.

**One part of `f` is not loss at all, and its size is bounded now.** When the
client process exits at the end of the drive window, the datagrams still in
flight never come back and leave no RTT sample. That censors approximately
`RTT / driveWindow` of the sends — at a 10 ms round trip over a 20 s window,
**0.0005**, fifty times below H5's 0.01 bar and a hundred times below the
delivery-collapse STOP. It is disclosed rather than corrected: it moves `f`
upward, so it can only make the gate harder, and if `f` ever approaches the bar
the cause is loss, not this.

**Loss attribution, so a path fault is not filed as a product miss and a product
drop is not excused as a path fault.** Per cell the harness records the server's
`/proc/net/snmp` `Udp:` deltas (`InErrors`, `RcvbufErrors`) and both directional
gaps (`upGap = clientSent − serverRx`, `downGap = echoSent − clientReceived`).

| condition | consequence |
|---|---|
| `f < 0.01` in a cell | cell is evaluable |
| `f ≥ 0.01` and server kernel drops ≥ 0.1 × `upGap` | the loss is **in this host**. Cells stand; the gate is evaluated and this is a **MISS** path (a server that drops 1% of datagrams has no finite p99). |
| `f ≥ 0.01` and server kernel drops < 0.1 × `upGap` | the loss is **off this host** (wire/vswitch/client). Cell is `path-lossy`, excluded, counted. |
| median `f` over `G-off` cells ≥ 0.05 | **delivery-collapse STOP** — dispatch INCOMPLETE (`path-unusable`) regardless of attribution, with the numbers published. |

The 0.01 boundary is the p99 definition itself (1% missing makes the 99th
percentile undefined-or-infinite); 0.05 is the pre-existing delivery-collapse
posture carried in from the ceiling-attribution work; 0.1 is the attribution
majority-share threshold used by T02 when it attributed the 10k loss to
`RcvbufErrors`. None is derived from this run.

---

## 8. Floor arms on the loadgen, and the honesty check

**Floor arms run where the generator runs.** Three `F-off` cells at 1,000/s
aggregate — one fifteenth of the gate rung, two orders below the measured knee —
measure the loadgen's own irreducible cost: its timer wake granularity, its
quinn/tokio path, and the two wire legs at idle. Three `F-on` cells at the same
rate measure the same thing without the wire.

Published:

- `floorRttP99Ns` = median over the 3 `F-off` cells of that cell's RTT p99.
- `floorLagP99Ns` = median over the 3 `F-off` cells of that cell's client
  schedule-lag p99. **This is the loadgen's floor, measured on the loadgen** —
  the runner's floor is not used for the loadgen's honesty bar.
- `floorRttOnboxP99Ns` = the same over the 3 `F-on` cells.
- `wireCostP99Ns` = `floorRttP99Ns − floorRttOnboxP99Ns` — the LAN's contribution
  at idle. **Disclosure only.**

**Nothing is ever subtracted.** The gate is evaluated on the raw (censored-
corrected) RTT p99. Phase-1's floor rule produced an adjusted ingest figure and
then `floor-not-quiet` forbade its use; this registration removes the temptation
by never defining an adjusted figure at all. The floors are validity checks and
disclosures, and that is all they are.

**Floor validity:**

| condition | numeric | consequence |
|---|---|---|
| `floor-not-quiet` | any `F-off` cell's RTT p99 ≥ **4.0 ms** | the *path* is not quiet at 1/15th of the gate load; a 15k reading cannot be attributed. Dispatch **INCOMPLETE** (`path-not-quiet`). |
| `floor-drift` | max/min of the 3 `F-off` RTT p99s > **2.0** | host-level state moved under the dispatch. Dispatch **INCOMPLETE** (`floor-drift`). |
| `floor-exceeds-bound` | `floorRttP99Ns` > 0.25 × 10.0 ms | the idle path already spends a quarter of the budget. Gate still evaluated; mandatory disclosure label `floor-heavy` attaches to every quotation. |

The 4.0 ms figure is derived, not fitted: an idle round trip is two wire legs plus
one server turnaround plus two scheduler wakes. The loadgen's timer granularity
alone (~1 ms, the reason `MIN_UNIFORM_PERIOD_NS` is 2 ms) plus a 1 GbE-class
switch leg (1150 B ≈ 9 µs serialisation; queueing on a virtual switch dominates)
puts a quiet floor comfortably under 4 ms; a floor above it means something on
the path is not idle. It is deliberately ≥ 2× the prior-phase on-box floor
(1.77 ms) so that the wire cannot trip it on its own.

**Generator honesty, on the loadgen.** All conditions are computed for every cell
and reported; at `G-off` they are a **precondition**.

| # | condition | why this numeric |
|---|---|---|
| H1 | effective aggregate within ±2% of 15,000/s | carried unchanged from `latency-ab.md` |
| H2 | `offeredFraction` ≥ 0.98 (`clientSent / requestedDatagrams`) | carried unchanged |
| H3 | `ticksSkipped` ≤ 0.001 × `sendEvents` | carried unchanged |
| H4 | client schedule-lag p99 ≤ **2 ×** `floorLagP99Ns` | multiplier carried unchanged; the floor is now the **loadgen's** |
| H5 | round-trip completion `1 − f` ≥ 0.99 | §7; this replaces phase-1's `upDeliveryRatio ≥ 0.995`, which is now reported separately as one leg of the loss ledger |

Every multiplier and tolerance above is inherited verbatim from the phase-1
registration `latency-ab.md`, which was written before any of this axis's runs.
The only quantity measured *in* this dispatch that feeds a threshold is
`floorLagP99Ns`, and it feeds it through a multiplier fixed a priori — the same
structure phase-1 used. It is not circular: the floor is a different rung, run
three times across the dispatch, and it constrains the generator, never the
server.

**`schedule-lag` is a generator property here, not a product cost.** The final
review found that G3's `originationLag` was recorded across `await send(...)` and
therefore absorbed the product's send-path latency. This harness does not have
that defect and the difference is mechanical: `load_client.rs` records
`schedule_lag = actual_ns − intended_ns` where `actual_ns` is read immediately
before `write_stamp`, and the send it precedes (`conn.send_datagram`) is
**synchronous and not awaited**. The lag is wake lateness. This is stated here so
that a reader does not have to take it on trust.

**Precondition for a verdict:** at least **8 of 10** `G-off` cells complete, off-box
(§6) and honest (H1–H5). Fewer → **INCOMPLETE**; the gate is not evaluated, and
it is not repaired by borrowing `A-off`, `G-on`, or anything from phase-1.

---

## 9. The statistic

Per evaluable `G-off` cell: `rttP99CensoredNs` (§7).

**Gate statistic:** the **median** of those values across replicates.

**Interval:** the same distribution-free order-statistic interval phase-1
registered — for *n* sorted values, `[x₍ₖ₎, x₍ₙ₊₁₋ₖ₎]` with *k* the largest
integer ≥ 1 satisfying `2 · BinomCDF(k−1; n, ½) ≤ 0.05`; for n = 10, k = 2 and
true coverage is 97.85%. For n ≤ 5 the interval is `ci-unavailable` and the
median is reported bare.

**Quantisation:** the histogram's worst-case reporting error at value *v* is
`v / 512` (8 sub-bits), i.e. ±0.020 ms at 10 ms. Reported beside the median.

**The median decides.** If the median is ≤ 10.0 ms but the interval's upper
endpoint exceeds it, the verdict is PASS **with the mandatory label
`gate-ci-spans-bound`**, which must appear in every quotation of the result. The
symmetric case (median > 10.0 ms, lower endpoint below it) is a MISS with the
same label. Fixed now so it cannot be argued afterwards.

---

## 10. Verdict algebra

Evaluated in order; the first row that matches decides.

| # | condition | verdict |
|---|---|---|
| 1 | conductor refusal (§11) or `offbox-unreachable` at cell 0 | **INCOMPLETE** — infra fault, declared and logged, re-dispatch permitted |
| 2 | `crosshost-contamination` (§6) | **INCOMPLETE** — harness fault, declared and logged |
| 3 | `path-not-quiet` or `floor-drift` (§8) | **INCOMPLETE** — rig |
| 4 | delivery-collapse: median `f` over `G-off` ≥ 0.05 (§7) | **INCOMPLETE** — path unusable |
| 5 | fewer than 8/10 `G-off` cells complete + off-box + honest (§8) | **INCOMPLETE** — the loadgen could not honestly source 15,000/s, which is a finding about the rig and is reported as one |
| 6 | any evaluable cell has `f ≥ 0.01` with server kernel drops ≥ 0.1 × `upGap` (§7) | **MISS** — in-host loss |
| 7 | median `rttP99CensoredNs` > 10.0 ms | **MISS** |
| 8 | otherwise | **PASS** |

A MISS is final for this effort and routes to a mechanism ticket. A rerun requires
a declared, logged harness or infra fault — rows 1 and 2 only.

**What a PASS licenses:** exactly the sentence in §1, with §4's topology
paragraph and §0's two-products paragraph attached. Not a player count, not a
capacity, not a WAN claim, not an ingest-leg claim, not a comparison with
phase-1's numbers.

---

## 11. Conductor refusals — fixed now

The conductor exits non-zero, before any cell runs, if:

1. `LATENCY_RTT_OFFBOX_SSH` or `LATENCY_RTT_OFFBOX_URL_HOST` is unset while any
   off-box cell is scheduled;
2. `LATENCY_RTT_OFFBOX_URL_HOST` does not match `^192\.168\.2\.` — **the
   Tailscale path (`100.x`) is never the data path**;
3. `ssh -o BatchMode=yes -o ConnectTimeout=10 <ssh> true` fails;
4. `scp` of the freshly built `load-client` to the loadgen, or the `chmod +x`
   after it, fails;
5. the remote `uname -m` does not match the runner's;
6. the git tree is dirty or `HEAD` is unreadable.

Each refusal prints one line naming the failed check. A refused dispatch produces
no fragments and no verdict.

---

## 12. What this dispatch may not do

- It may not flip any default. Soak-freeze is binding; the shipped default is
  what is measured, and nothing else runs.
- It may not produce an off-box server-ingest, egress, or one-way number (§6).
- It may not be differenced against phase-1's run (§0).
- It may not interpolate. `A-off` at 10,000/s and `G-off` at 15,000/s are
  separate rungs and neither substitutes for the other.
- It may not convert `G-on` into a G2 verdict, in either direction.
- It may not report an adjusted, floor-subtracted, or otherwise corrected-downward
  latency. The only correction defined here (§7) moves the figure up.
- It may not quote any figure from an aborted dispatch.

---

## 13. Amendments

Any change to this document after the first dispatch is an amendment, appended
below with its own timestamp, quoting the original text verbatim, and stating
whether any run had produced output at the time it was written. No clause above
may be edited in place.

**Pre-dispatch clarification, 2026-08-19** — added to §7 before any dispatch of
this gate existed, while smoke-testing the harness on a laptop (5 sessions,
50/s, macOS; local numbers are never results and none is used here). The smoke
showed `f` sitting at 0.02 in a run with no loss whatsoever, because at 50/s a
5 s window leaves a visible fraction of the sends in flight when the client
exits. The clarification states that effect, derives its magnitude at the gate's
own rung (0.0005) and confirms it moves `f` in the conservative direction. **No
threshold moved**; §7's 0.01, 0.05 and 0.1 are unchanged from the original
commit, and the added paragraph could only make the gate harder to pass.

---

## 14. Dispatch log

Every dispatch of this gate is logged here — run id, candidate SHA, artifact
hash — including aborted and refused ones. A run that is not in this table did
not happen.

| run id | candidate SHA | started | outcome | artifact hash |
|---|---|---|---|---|
| — | — | — | **no dispatch has been made** | — |
