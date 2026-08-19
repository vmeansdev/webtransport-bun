# Pre-registration — Gate G3b (camera / desktop-share bursty egress, three-arm, second registration)

**Gate text (binding):** `.scratch/production-grade-scenarios/spec.md` rev 2,
§Targets, G3. The product target is unchanged; only the honesty control that
gates it is re-registered.
**Axis pre-registration (binding for everything this document does not
override):** `docs/research/preregistrations/egress.md`, Amendments 1–9.
**First registration (closed, final for its own run):**
`docs/research/preregistrations/gate-g3.md` §12, stamped INCOMPLETE on run
`32213270203`. Nothing in this document reopens that stamp.
**Probe branch:** `probe/egress-01` (never-merge).
**Runner:** heavy self-hosted `[self-hosted, Linux, X64, heavy]`, 4 vCPU / 8 GB
Ubuntu on Hyper-V, receiver co-resident. No runner config changes.

**Written before any harness change made for this registration.** The commit
carrying this file precedes every harness commit G3b depends on; the dispatch
log in §9 is empty at the time of writing. Any post-hoc edit is a finding
against its author, not a correction.

**Separation (spec §Process rules):** the agent preparing and running G3b
implemented none of the levers — not ticket 05 (send-batch native), not 07
(stream chunk batching), not 03 (close contract / promise-free send), not 09
(window fields), and not ticket 23 (lever hardening).

---

## 0. Full disclosure — what is already known, and why it cannot set a threshold

This is a **second registration written with the first run's results in hand.**
Pretending otherwise would be the dishonesty this whole effort exists to
prevent, so everything known is stated here, in front of the thresholds, and
every threshold below is then derived from arithmetic that was fixed before the
first run or from the grid's own definition — never from these numbers.

Known from run `32213270203` (`frame-bursty`, 100 real sessions, m = 0.5, i.e.
1.5 × the realized 35,200/s rung = 52,800/s offered):

| arm | emitted / scheduled | skipped events | old `originationLag` p99 | old rung verdict |
|---|---|---|---|---|
| `serial` | 0.9505 | 4,412 | 30.671 ms | fail |
| `pipelined` | 0.9610 | 3,529 | 31.195 ms | fail |
| `batch` | **1.0000520** | **0** | **8.520 ms** | fail (on lag only) |

Ceilings `{serial: 0, pipelined: 0, batch: 0}`; C1–C3 INCOMPLETE; C4 PASS. Gate
arms (not the headroom control) gave `frame-bursty`/`batch` p99 median 2.523 ms
over `[1.425, 3.572]` ms, published verdict-less.

The final review struck two things about that run, and this registration exists
to answer exactly those two and nothing else:

1. **The instrument was not a generator property.** `originationLag` was
   recorded across `await send(...)`: the per-session loop awaited the whole
   send of event *k* before it could reach the deadline of event *k+1*, so the
   product's send-path latency was charged to generator lateness. The empirical
   proof is in the table above — one offered rate, one profile, one box, one
   scheduler, and a **3.6× spread** in the "generator honesty" number across
   three choices of product API. A property of the generator alone cannot do
   that.
2. **The bound was not grid-relative.** 5 ms is 15 % of a 33.3 ms frame period
   and stands in no stated relation to what "the registered shape" means. It
   fired on an arm that sourced 100.005 % of its scheduled count with zero
   skips, and that failure was then written up as a rig incompleteness with a
   remedy (a second box) that the same fragment refutes.

**The threshold-integrity rule for this document.** Section 3 derives the lag
bound from the grid period alone. Section 3.4 states, before the derivation is
used, the one place where knowing the phase-1 number could have biased the
choice — the T/4 alternative, which the phase-1 batch value sits 2.3 % above —
and settles it on shape grounds with the number kept visible. If a reader thinks
the derivation was reverse-engineered from 8.520 ms, §3.4 is where to attack it,
and it is written to be attacked.

**A further consequence that must be stated up front:** under the corrected
instrument the phase-1 lag numbers are *not comparable to anything measured
here*. They measured a different quantity. No G3b number may be compared to a
G3 number, in either direction, and G3b states no Δ against phase 1.

---

## 1. Candidate composition — deferred, and why

Per spec §Process rules the candidate is the probe branch rebased onto the
staging SHA carrying the levers the gate rides. G3b rides the send-batch lever
**and ticket 23's hardening of it** (the >256-element one-deadline fix and the
`spawn_counted` accounting fix both sit inside arm (c)'s call path).

| role | SHA | state |
|---|---|---|
| probe branch head at this writing | `8c1c3589053ac184f734da6ca44fcbdfdedec686` | fixed |
| staging tip at this writing | `b4af780ad3902c27ae69ca9f2f3a7c8c3172cdb7` | carries levers + 3993 formalization, **not** ticket 23 |
| staging SHA the candidate rebases onto | **not yet in existence** | ticket 23 unlanded |
| candidate dispatched | recorded per dispatch in §9 | — |

Everything in this registration is therefore **built and validated on the
current base** (`8c1c358`, whose merge-base with staging is `b4af780`'s
ancestry through the phase-1 composition). The rebase onto the ticket-23
staging SHA is a **required step before dispatch**, flagged here for the
orchestrator: the run that stamps G3b must be a probe SHA rebased onto the
staging SHA that contains ticket 23, and both SHAs go in §9 from
`git rev-parse`, never typed. A dispatch on any other base does not stamp this
gate.

The disclosure that composition changes arm (a) — on the composed tree
`sendDatagram()` takes staging's promise-free `trySendDatagram` path — carries
forward unchanged from gate-g3 §1 and is restated in §8.

---

## 2. The corrected instrument

### 2.1 What went wrong, mechanically

The phase-1 per-session loop was:

```
sleep to deadline(k) → skip whole periods already past → await emitEvent(k)
```

`emitEvent` reads `actual` before its first send, so the *stamp inside the
datagram* was never contaminated. The contamination is one level up: because
the loop **awaits** event *k*'s completion, the loop's arrival at event *k+1*'s
handoff is delayed by the product's send time for event *k*, and the lag
recorded at *k+1* is that delay. Serial-await pays that cost `amplitude` times
per event; the batched call pays it once; hence 3.6×.

### 2.2 The replacement — two instruments, one loop each

**`schedulerLag` (the honesty instrument).** Per grid event, per session:

```
schedulerLag = handoffNs − effectiveIntendedNs
```

where `handoffNs` is read **at the instant the event is handed to the emitter,
before any await of the emitter**. The scheduler loop no longer awaits the
emitter: each session keeps at most **one** event in flight (unchanged from
phase 1 — awaiting serialized emission to one event at a time too), but the
timing loop runs on its own deadlines while that event is being emitted. So:

- if the emitter is free at the deadline, the event is handed over and
  `schedulerLag` is exactly the timer loop's own lateness;
- if the emitter is still busy with the previous event, the event is **dropped**
  and counted in `sendEventsDropped` — never queued, never caught up.

The emission concurrency per session is therefore identical to phase 1 (≤ 1
event in flight); only the timing loop is decoupled. This is the whole fix.

**`sendCallDuration` (the product-side diagnostic).** Per grid event, per
session: the interval from handoff to the settlement of that event's emission —
the whole product cost of one event under that arm (per-datagram awaits for
(a), the `Promise.allSettled` for (b), the batch crossing for (c)). Recorded as
its own histogram, reported for every arm, and **never** part of any honesty
condition. It is what phase 1 was accidentally measuring, now measured on
purpose and named for what it is.

### 2.3 Where the counts go

| counter | meaning |
|---|---|
| `sendEventsScheduled` | every grid event the plan put in the step: run + skipped + dropped |
| `sendEventsSkipped` | whole grid periods the **scheduler** was past before it woke — generator/rig saturation |
| `sendEventsDropped` | events the **emitter** was too slow to accept — a product property of that arm |
| `sent` / `scheduledDatagrams` | datagram-level, as before |

The split is the point: phase 1 had one bucket and it read as a rig statement.

### 2.4 The registered validity falsifier for the fix itself

The corrected instrument's defining property is that it is a property of the
scheduler. So, registered before the run:

> **V1.** Across the three arms of one headroom control at one multiplier, on
> one box, `schedulerLag` p99 must agree within **2×** (max/min ≤ 2). If the
> arms still spread by more than 2×, the decoupling did not work and **the run
> is invalid for G3b** — reported as a harness fault under §10's rerun clause,
> not as a gate result.

Phase 1's spread was 3.6× and would have tripped this. The 2× tolerance is not
"the old spread minus a margin": it is the loosest ratio at which the metric can
still be called arm-independent at all, since a metric that legitimately does
not depend on the arm should agree to within its own run-to-run noise, and this
box's own headroom rungs are the noise reference.

A companion unit-level falsifier is a build requirement rather than a run
requirement: on a synthetic fixture where the fake sender's latency differs by
an order of magnitude between arms, the test asserts `schedulerLag` does **not**
move while `sendCallDuration` does. That test must fail on the phase-1 loop; it
is the regression pin for the struck defect.

---

## 3. The headroom lag bound, derived from the grid

### 3.1 What the registered load is

`frame-bursty` is a burst train: one burst per grid period *T*, of amplitude
*A*, per session, sessions staggered across *T*. `T = round(1e9/30) =
33,333,333 ns`. The registered offered process is characterised by (i) the
burst rate `1/T`, (ii) the amplitude *A*, and (iii) the fact that bursts land
one to a period.

### 3.2 The hard constraint

Let burst *k* be intended at `kT` and handed over at `a_k = kT + L_k`, `L_k ≥ 0`.
The offered process is the registered one **iff every burst lands inside its own
period**, i.e.

```
L_k < T   for all k
```

At `L_k = T` burst *k* lands on top of burst *k+1*: the train acquires a period
with amplitude `2A` and a period with amplitude 0, which is a *different*
offered shape — a different burst amplitude at the same mean rate, and burst
amplitude is precisely what this axis exists to vary. So `T` is the shape
boundary, derived, not chosen.

### 3.3 The bound

The condition in §3.2 is on every burst; the instrument reports a p99. The
untested 1 % tail must still satisfy `L < T`. Registering the p99 bound at

```
LAG_BOUND = T / 2 = 16,666,667 ns  (16.667 ms at 30 Hz)
```

leaves the unobserved tail a full `T/2` of headroom before the shape breaks — a
factor-2 margin on the derived boundary, in the conservative direction.

A second, independent derivation lands on the same number. The gate's own
latency clause C2 is `egressOneWay p99 < 33.3 ms`, i.e. `< T`, measured from the
in-datagram stamp. The generator's lateness and the transport's latency draw on
the same one-frame budget from the application's point of view. A bound of `T/2`
caps the generator's claim on that budget at half and guarantees at least `T/2`
of it is available to the thing under test. A bound anywhere above `T/2` would
let the honesty control admit a generator consuming most of the product's own
budget.

**The bound is computed from `plan.gridPeriodNs`, not written as a constant.**
At the `constant` profile's 5 ms grid it is 2.5 ms; at 30 Hz it is 16.667 ms. It
is a property of the registered shape, which is what "grid-relative" means.

### 3.4 The alternative that knowing phase 1 could have biased — stated, not hidden

The other defensible sub-multiple is `T/4 = 8,333,333 ns`. Phase 1's batch arm
measured **8,519,680 ns** on the old instrument — 2.3 % *above* `T/4`. So the
choice between `T/2` and `T/4` is exactly the choice between a bound the
phase-1 batch number clears and one it does not, and a reader is entitled to
suspect the larger was chosen for that reason.

It was not, and here is the argument standing on its own: **nothing in the
burst process changes at a quarter period.** `T` is where bursts merge; `T/2` is
the factor-2 margin on that boundary and the even split of the frame budget in
§3.3. `T/4` is a round number with no referent in the shape — to justify it one
would have to name a property of the offered load that degrades at 8.3 ms of
lateness, and there is none: a burst at +8.3 ms and a burst at +16.6 ms are
equally inside their own frame and equally ordered with respect to their
neighbours.

Two things keep this honest rather than merely argued:

- `T/4` is **reported on every rung as a diagnostic** (`lagQuarterGrid: bool`),
  computed and printed whether or not it is convenient.
- Registered now: **if arm (c)'s headroom `schedulerLag` p99 lands in
  `(T/4, T/2)`, the stamp must say so on its face** and C1's PASS is written as
  "shape-honest at half-period, above quarter-period", with the number. A PASS
  that depends on the `T/2` choice will not be reported as if it did not.

And the fact that makes the whole worry mostly moot, stated as a prediction in
§7: under the corrected instrument the phase-1 number is not the expected
magnitude at all — that 8.52 ms was mostly the batch crossing, which now lands
in `sendCallDuration`.

---

## 4. Honesty conditions, split by what they are about

Phase 1's H1 fused two different questions into one `passes` boolean. They are
separated here, because the review's finding was precisely that a product
result got filed as a rig result.

### H1 — the rig/generator condition (arm-independent)

For a headroom rung, the **scheduler** was honest iff

```
schedulerLag p99 < gridPeriodNs / 2        (§3.3)
AND sendEventsSkipped < 0.10 × sendEventsScheduled   (unchanged from the axis)
```

A rung failing H1 is a **rig/generator** statement. If H1 fails for all three
arms, the box could not host the registered shape and the gate is INCOMPLETE
for rig reasons — the only reading that licenses "a second box".

### H2 — the arm's sourcing condition (a product property)

For a headroom rung, that **arm** sourced the load iff

```
emittedFraction = sent / scheduledDatagrams ≥ 0.95    (unchanged from the axis)
```

with `sendEventsDropped` reported beside it. A rung failing H2 while H1 passes
says **that emitter cannot source this load on this box** — a finding about the
product, reported as such, and never as a rig incompleteness. That is the
correction to the phase-1 write-up demanded by the review.

Each rung records `failedOn ∈ {null, "lag", "skips", "count"}` so the two are
never merged again by a later reader.

### H2b — the ceiling, and the 1.5× requirement

Unchanged from the axis and from gate-g3 §H2: multipliers `m ∈ {0.5, 1, 2, 4}`,
20 s per rung, stop at first failure;
`generatorCeilingPerSec(arm) = min(offered, emitted)` of the highest rung passing
**both** H1 and H2; an arm whose ceiling is below `1.5 ×
maxOfferedAggregatePerSec(arm)` is marked `generator-headroom` and contributes
no latency number, no capacity number and no side of any Δ.

**Shadow-sink disclosure, carried and sharpened** (final review, G4 finding):
the shadow sessions do the arm's JS work but not the native call, so the
headroom control is a **necessary** condition only. Passing it does not
establish that the originator could source 1.5× the rung of *real* sends, and
no ratio computed across real and shadow work is reported as a capability
number. The per-rung split (`realEmitted` / `shadowEmitted`) is on the record
for every rung so the mixture is always visible.

### H3 — the within-arm lag floor

Unchanged in form from gate-g3 §H3, now applied to `schedulerLag`: the
`4 × floor` saturation STOP takes its floor across the same
`(shape, profile, emitter)` group only.

### H4 — the absolute STOPs

Unchanged: `generator-saturation` (skip ratio), `offered-shortfall`,
`clock-invalid`, `delivery-collapse`, `sample-starvation`, in the axis's order.

### H5 — the ceiling-movement clause, kept verbatim in force

Retained from gate-g3 §H5 without change: if arm (b) cannot honestly source the
load and arm (c) can, the gate reports **that the ceiling moved**, with both
ceilings, and does **not** report a Δ p99 between them. The inverted case is
reported with the sentence inverted and C1 fails.

### H6 — the legacy-instrument guard

A `gate`-shape step whose fragment carries only the phase-1 `originationLag`
field and no `schedulerLag` is **INCOMPLETE** with STOP `legacy-lag-instrument`.
Phase-1 artifacts cannot be reclassified into a G3b verdict, by accident or
otherwise.

---

## 5. Arms, rung, profiles, blocks — unchanged

Three arms (`serial`, `pipelined`, `batch`), defined mechanically in gate-g3
§3 and unchanged in this registration, including the payload pool (§3.1) and
the stamp-point convention (§3.2 — `actual` at the array push for (c), which
loads (c) conservatively).

| parameter | value |
|---|---|
| sessions | 100 subscriber sessions, one receive-only load-client process per arm |
| payload | 1150 B |
| per-session rate | 326/s → **32,600/s aggregate registered**, the only rung |
| realized rung | the frame grid quantizes 326/s to 11 datagrams per 33.3 ms period = **352/s → 35,200/s**, **+8.0 %**, disclosed here as it was in phase 1 and reported on the stamp |
| profiles | `frame-bursty` (clause-bearing) and `keyframe-aligned` (alignment comparison) |
| arms per block | 6 = 2 profiles × 3 emitters |
| blocks | n = 5, rotated interleave (gate-g3 §4), every comparison paired within a block |
| drive per arm | 30 s, 10 s settle |

---

## 6. Gate clauses

Evaluated at the `frame-bursty` rung only. A clause whose inputs are missing or
invalid is **INCOMPLETE** — never a pass, never a fail charged to the server.

**C1 — the rung is complete under arm (c).** PASS iff all 5
`frame-bursty`/`batch` blocks are complete (no STOP, H1–H4 and H6 included)
**and** arm (c) cleared H1, H2 and H2b in its own headroom control. Not
satisfied by a majority. If the PASS depends on the `T/2` choice per §3.4, the
dependence is written on the face of the verdict.

**C2 — `egressOneWay` p99 < 33.3 ms under arm (c).** Unchanged, including C2's
order-statistic reading: median of the 5 per-block p99 values with the interval
`[min, max]`, distribution-free coverage `1 − 2^(1−5) = 93.75 %`. PASS iff C1
passes and `max < 33.3 ms`; `INCONCLUSIVE-AT-BAR` iff `median < 33.3 ms ≤ max`
(reported under that name, never rounded up); FAIL iff `median ≥ 33.3 ms`.
`endToEnd`, `schedulerLag` and `sendCallDuration` are reported beside it, never
in place of it.

**C3 — the lever value, stated as (c) vs (b).** Unchanged from gate-g3 §C3:
only if both (b) and (c) are honest; per-block Δ with the order-statistic
interval; `lever-positive` only if the whole interval is < 0;
`ab-confounded` and `cpu-asymmetric` labels mandatory and computed. **(c) vs (a)
is a diagnostic and is never the stated lever value.** If (b) is dishonest and
(c) is honest, §H5 applies and no Δ is reported.

**C4 — server-side UDP/GSO counters on the record.** Unchanged instrumentation
obligation; the phase-1 disclosure that `/proc/net/snmp` is host-wide and that
no per-send GSO segment count exists carries forward.

**Alignment cost** is measured only under the CPU-symmetry tolerances fixed in
gate-g3 §7 (server ≤ 10, host ≤ 20 percent-of-one-core); asymmetric pairs are
published with both CPU numbers and carry no bucket verdict. Phase 1 found all
14 available pairs asymmetric; if that repeats, G3b states no alignment cost
either, and says so.

---

## 7. Prediction, on the record

Registered so that a confirmation cannot be sold as a surprise and a refutation
cannot be dropped:

1. **`schedulerLag` p99 will be an order of magnitude below the phase-1
   `originationLag` p99 on every arm**, in the 0.1–2 ms regime — the timer
   loop's own wake granularity — because the send cost has moved to
   `sendCallDuration`.
2. **The three arms will agree on `schedulerLag` within 2×** (V1). If they do
   not, the run is invalid, not interesting.
3. **`sendCallDuration` will separate the arms strongly**, in the direction
   phase 1's contaminated metric already indicated: (c) cheapest per event.
4. **Arms (a) and (b) are expected to fail H2** at `m = 0.5` (they already
   dropped 4,412 / 3,529 events there), and that is a **product** finding about
   per-datagram origination, not a rig one.
5. **Arm (c) is expected to pass H1 and H2 at `m = 0.5`** and its ceiling to be
   established at whichever multiplier it first fails.

The gate is **not** re-registered if this prediction is wrong. A third
registration is not available: per the maintainer's directive a miss on this
registration is final and is reported as a miss.

---

## 8. Disclosures this gate carries regardless of outcome

1. **R4 remains OPEN.** G2's server ingest p99 and this gate's `egressOneWay`
   p99 are not established as comparable units. No ratio and no shared sentence
   follows from G2 and G3b together.
2. **Arm (a) rides staging's promise-free send path** (`trySendDatagram`), so it
   is the shipped default as of the composed base but not byte-identical to the
   emitter the axis registration was written against. The spec's "(c) vs (b),
   never (c) vs (a)" guard is *why* C3 is stated against (b); the changed (a) is
   a diagnostic only, and this registration draws that consequence explicitly
   rather than only disclosing the change.
3. **The stamp-point convention loads arm (c)** — `actual` at the array push —
   so a (c) win is a floor on the real one.
4. **Shadow-sink necessity-only**, per §H2b.
5. **Realized rung is 35,200/s, +8.0 % over the registered 32,600/s**, by grid
   quantization.
6. Co-resident receiver, one rung, 100 sessions, 4 vCPU box. No capacity,
   ladder, session-count or off-box claim follows from any G3b number.
7. **Cross-registration incomparability**: no G3b number may be compared to a
   phase-1 G3 number; the lag instruments measure different quantities and the
   send path differs by ticket 23.

---

## 9. The dispatch

One dispatch, `bench-bandwidth` workflow, `EGRESS_SHAPE=gate`, on the composed
candidate defined in §1. Every dispatch of this gate — including aborted ones —
is logged here with run id, candidate SHA, staging base SHA and artifact hash.

### Dispatch log

*(empty at the time of writing — no dispatch has been made under this
registration)*

---

## 10. What this registration may not do

- It may not be re-run for a different answer. One complete run stamps; a rerun
  requires a declared, logged harness/infra fault (V1 failing is such a fault,
  and is the only one anticipated).
- It may not move a threshold after the run. Every number above is derived in
  §3–§4 and the derivation is auditable against the grid arithmetic alone.
- It may not compare across registrations (§8.7).
- It may not convert any measurement here into a capacity, provisioning or
  off-box claim.
- The agent preparing it does not dispatch it.

---

## 11. Verdict

*(open — no run has been made under this registration)*

---

## 12. Amendments

Every amendment is made **before any dispatch under this registration** — the
§9 log is empty at each one — and each quotes what it changes.

### Amendment 1 — the handoff slot has depth one, not zero (pre-run)

§2.2 as written said:

> if the emitter is still busy with the previous event, the event is **dropped**
> and counted in `sendEventsDropped` — never queued, never caught up.

Implementing it exposed an accounting error in that rule, and it is corrected
here rather than discovered in a verdict. Drop-on-busy makes the emitted
fraction discontinuous in the emitter's cost: an arm needing 1.05 T per event
can genuinely source 1/1.05 = 95 % of the registered rate — and did, in phase 1,
where the awaiting loop measured exactly that — but under drop-on-busy it would
alternate run/drop and report 50 %. H2's bar is 0.95, so the rule would have
converted a 5 % shortfall into a 50 % one and failed arms that can source the
load.

**The rule as implemented:** one event is in flight and at most one waits behind
it. An event arriving with the waiting slot free is queued and taken the instant
the emitter frees; an event arriving with the slot already occupied is dropped
and counted in `sendEventsDropped`. So an arm slower than the grid emits back to
back exactly as the awaiting loop made it, and its sourcing shows up as a rate.

What this does **not** change is the property the correction exists for: the
timing loop still never awaits the emitter, so `schedulerLag` is still read at a
moment no product call can delay. The one thing the queue introduces —
scheduler-ready → the emitter actually taking the event — is recorded as its own
third instrument, `handoffDelay`, reported for every arm and part of **no**
honesty condition. Nothing in §3 (the bound), §4 (H1/H2/H2b) or §6 (the clauses)
moves.

Pinned by `tools/load/egress-driver.test.ts`: an emitter slower than the grid
produces `sendEventsDropped > 0` with the skip counter still inside its own bar,
and the counts close (`scheduled = skipped + dropped + sent + errors`).


<!-- §9 candidate composition record (orchestrator, pre-dispatch) -->
Candidate composed 2026-08-19: probe/egress-01 rebased onto rebind4-staging
@ 2a4145d0556a35f8b4a0849e5953927b5e028b64 (levers + 3993 formalization +
ticket-23 hardening incl. the one-deadline and spawn_counted fixes in arm (c)'s
call path). Rebased head = candidate: 066a342f92af (from git rev-parse).
Pre-rebase head acfff6a preserved at keep/egress-01-g3b-pre23.
