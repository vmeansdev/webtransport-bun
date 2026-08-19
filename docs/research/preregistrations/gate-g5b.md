# Pre-registration — Gate G5b: paced bulk throughput

**Written before any harness code for this gate**, and committed as its own
commit ahead of it, per spec §Process rules. Post-hoc edits to this file are
findings against the author.

- **Gate:** G5 (spec `.scratch/production-grade-scenarios/spec.md` rev 2, §G5),
  second registration. The first registration
  (`docs/research/preregistrations/gate-g5-bulk.md`, run 32220018998) returned
  **NO-VERDICT** via its host-saturation STOP and prescribed two ways to close
  the gate: off-box generation, or a paced gate. This is the paced gate. It is a
  **new registration with its own arms, thresholds and STOPs**, not a rerun —
  rerunning Arm G is forbidden, and nothing here relaxes a rule that document
  fixed.
- **Axis:** stream-throughput. Arms, classifier buckets, integrity rules and STOP
  conditions are inherited verbatim from
  `docs/research/preregistrations/stream-throughput.md` (original + Amendments 1
  and 2) and from gate-g5-bulk.md's two additions
  (`crossing-instrument-disagreement`, `server-socket-drops-unmeasurable`). This
  document adds **Arm P** and two pacing integrity rules, and nothing else.
- **Gate runner ≠ lever implementer.** Tickets 07 (chunk batching), 09 (windows)
  and 23 (lever hardening) were implemented by other agents; this document and
  the Arm P harness are written by the gate agent, who implemented no lever.

## Disclosure that must be read before any threshold below

**Phase-1 results are known to the author of this document.** Gate G5's first run
is stamped: `G-control` 0.880 Gbps, `G-window-ref` 1.142 Gbps, `G-batch`
3.96 Gbps at 54.9 KB per JS crossing and 92.3% host CPU, `G-window-batch`
4.05 Gbps at 92.9%. A registration written in that state cannot claim innocence,
so it states instead exactly which quantities it took from those numbers and
which it did not:

| quantity | derived from | phase-1's role |
|---|---|---|
| bar: ≥ 1.000 Gbps delivered | spec §G5, unchanged since rev 2 | none |
| bar: ≥ 8192 B per crossing | spec §G5, unchanged since rev 2 | none |
| pace point: 1.25 Gbps offered | 1.25 × the 1.000 Gbps bar; the 25% is 5× the axis's own 5% integrity band | none |
| match band 0.95, instrument band 1%, disclosure band 0.1%, A6 band 1.10 | quoted verbatim from gate-g5-bulk.md | none |
| batch budget 65,536 B | the four configuration arguments in gate-g5-bulk.md §"Why 65,536", all of which are statements about the shipped governors and the read path, none about a result | none |
| host-saturation bar 90% | `bench-stream.ts`, written for the axis before either gate existed | none |
| **expectation** that P-batch clears the bar under the host bar | interpolation of phase-1's `G-batch` cell | **yes — this is an expectation, not a threshold, and no clause reads it** |
| **expectation** that P-control and P-window-ref fall short of the offer | phase-1's unpaced 0.880 and 1.142 Gbps | **yes — expectations, recorded so the run can refute them** |

No threshold in this document is a number phase-1 produced. The two expectations
are written down precisely so that, if they hold, nobody can claim afterwards
that the arm was aimed at a rate the author already knew it would clear; and if
they fail, the failure is on record as a refuted prediction rather than a
surprise. A miss on this registration is **final and reported** (spec §Rerun
policy).

## Candidate composition — deferred, and why

Spec §Candidate-tree composition: candidate = the axis probe branch rebased onto
the staging SHA containing the needed lever commits. This gate rides the chunk
batching knob, and ticket 23 fixes a **protocol-visible defect in that knob's own
path** (`RESET_STREAM` swallowed mid-batch → clean EOF, `client_stream.rs`
`read_deferred_direct_batch`). Ticket 23 is open at the time of writing and
staging is at `b4af780ad3902c27ae69ca9f2f3a7c8c3172cdb7` (levers + the 3993
formalization), which does **not** contain it.

Therefore **no candidate is composed by this document**. Composition happens
after ticket 23 lands, by the dispatching agent, and is recorded then:

- staging base SHA — from `git rev-parse`, never typed;
- probe branch SHA before composition;
- composed (rebased) probe SHA = the candidate;
- the run log below gets the dispatched SHA and every artifact hash.

The probe branch is never merged back. A dispatch before ticket 23 lands would
measure the knob with a known protocol defect in it and is out of contract.

## What G5 asks, restated for a paced arm

The spec bar is a **threshold**, not a ceiling: "≥ 1 Gbps delivered on a config
whose per-session memory math stays inside the shipped budgets". Phase-1 asked
the question in its unpaced form — *how fast can this config go* — and the honest
answer (3.96 Gbps) came from a step the rig could not grade. The paced form asks
the question the bar was written for:

> **Does the shipped-governor configuration, with receive-side chunk batching at
> the registered budget, sustain ≥ 1 Gbps delivered for 60 s while the host stays
> under the axis's own saturation bar and the server's socket drops nothing?**

Same six clauses, restated cell-for-cell below. Nothing is dropped and nothing is
softened; two are strengthened (clause 6 moves onto the gate arm, and every
cell's drops are disclosed).

## Pacing — the mechanism, and why this one

### What is used

`crates/reference/src/load_client.rs`, `run_bulk_stream_worker`, via the existing
`--stream-target-bytes-per-sec` flag (per session; the client divides it by
`--stream-concurrency` to a per-worker target). **No product code is touched and
no new pacing code is written for this gate** — the pacer already ships in the
load client and is the same one Arm C used for its paced 600 Mbps datagram /
stream comparison, which is this design's precedent. Arm P's only harness change
is that it passes a non-zero target where Arm G passed 0.

The algorithm, quoted from the source:

```rust
written += write_bytes as u64;
if target_bytes_per_sec > 0 {
    let due = Duration::from_secs_f64(written as f64 / target_bytes_per_sec as f64);
    let elapsed = start.elapsed();
    if due > elapsed { tokio::time::sleep(due - elapsed).await; }
}
```

That is a **cumulative-deadline pacer** (a virtual clock): after the *n*-th write
the worker sleeps until the absolute time at which *n* writes were due, measured
from the step's own start, never for a fixed interval.

### Why a cumulative deadline and not the two alternatives

**Rejected: per-write fixed sleep** (`sleep(write_bytes / rate)` after each
write). Its achieved rate is `write / (write_cost + interval)`, i.e. it
undershoots the target by exactly the fraction of the period the write itself
consumes. That fraction is a function of per-byte send cost — which is the very
quantity the lever changes. A cheaper path would offer *more*, so the arm's
offered rate would be confounded with the effect under test, and the control and
gate cells would not be at the same offer despite carrying the same flag. This is
disqualifying, not merely imprecise.

**Rejected: token bucket with a burst allowance.** A bucket accrues credit while
the worker is blocked in `write_all` on flow control and spends it as a burst
when the block clears. The burst is unpaced by construction, and an unpaced burst
on this rig is exactly what produced phase-1's NO-VERDICT. It also introduces a
burst-size parameter with no principled value: any number chosen for it would be
a threshold this registration could not derive from anything.

**Chosen: cumulative deadline.** Three properties the gate needs:

1. **It cannot overshoot.** The sleep is `max(0, due − elapsed)`; the loop never
   writes ahead of its virtual clock. So `offered ≤ target` always, and a
   delivered figure at or below the offer can never have come from a burst. The
   direction of the only possible error is toward *under*-offering, which is the
   safe direction for a threshold gate: it can cause a miss, never a false pass.
2. **Its error does not accumulate.** A sleep that overshoots by the timer's
   granularity is absorbed at the next write (`due` grows by a fixed step,
   `elapsed` grew by more, so the next sleep is shorter). Residual error over the
   step is bounded by one write interval, not by the sum of the rounding errors.
   With the numbers below that is 26.8 ms over 60 s = **0.045%**, an order below
   the 5% shortfall band.
3. **A block is absorbed, not repaid.** If `write_all` blocks on flow control
   longer than the interval, the worker resumes without a catch-up burst and the
   step simply runs behind its clock — which the shortfall instrument then
   measures. Falling behind is the phenomenon the gate wants to observe on the
   control cells; a pacer that hid it by bursting would erase the finding.

### The pace point: 1.25 Gbps aggregate offered, derived without phase-1

- The bar is 1.000 Gbps delivered. An offer **equal** to the bar makes a pass
  require 100.0% of the offer to be delivered *and* counted inside the reported
  window; the accounting alone (the settle-window tail, the write-size
  quantization of the last write, the `windowSec` divisor) can cost a percent.
  An arm offered exactly its bar is a test of accounting, not of transport.
- The axis's own integrity band is **5%** — `drain-incomplete`,
  `flow-control-bound` and the clause-5 match band all use it. An offer of
  `bar + 5 × band = 1.25 × 1.000 Gbps` lets a cell absorb a full band's worth of
  shortfall in each of five independent places and still clear the bar.
- The upper limit on the pace is that the arm must stay a *sustain* test: an
  offer high enough that the arm runs at its ceiling is the unpaced arm again,
  with a flag. 1.25× is the smallest multiple that satisfies the lower argument
  at a round number, and it is the number registered.

Derived quantities, fixed here:

| quantity | value |
|---|---|
| aggregate offered | 1.25 Gbps = **156,250,000 B/s** |
| sessions × concurrency | 4 × 4 = 16 stream workers (unchanged from Arm G / A4 / A6) |
| per session (`--stream-target-bytes-per-sec`) | **39,062,500 B/s** |
| per worker (client divides by concurrency) | 9,765,625 B/s |
| write size | **262,144 B** (unchanged) |
| inter-write interval per worker | 26.84 ms |
| timer granularity as a share of the interval | ~3.7% per write, **0.045%** over the step (see property 2) |

The interval is 27× the millisecond timer granularity, so pacing is not
quantization-limited. Arrivals remain bursty *within* a 26.8 ms period — one
262,144 B write is one full shipped per-stream window — and that burstiness is
disclosed here because it is an input to the crossing clause (see below), not
tuned away: changing the write size would break comparability with A4, A6 and
every Arm G cell.

### Expected host CPU — an expectation, derived from a known result, not a threshold

Phase-1's cells give a usable relation between the two process CPU series and the
host series: `G-control` had server 202% + client 60% of one core on a 4-core box
= 65.5% of the box against a measured 71.3% host, so
`host ≈ (server + client)/4 + ~5`. Scaling `G-batch`'s 187% / 157% by
`1.25 / 3.96 = 0.316` gives server ≈ 59%, client ≈ 50%, host ≈ **32%**.
Proportional scaling through the origin understates fixed per-session and
per-stream cost, so the registered expectation is **30–50% host CPU** on
`P-batch`.

This is stated as an expectation because it is interpolated from the run this
gate exists to replace. **No clause reads it.** The bar that binds is the axis's
pre-existing `hostCpuPctMedian >= 90` rule, written before either gate. If the
paced arm still crosses 90, the STOP fires again and the finding is that this rig
cannot host a paced gate either — which routes to off-box generation and closes
nothing.

## Arm P — the cells

All cells: **4 sessions × 4 concurrent unidirectional streams (16 in flight),
client write size 262,144 B, 60 s per step, fresh server per repeat, two repeats
per cell**, `WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS=1` on every invocation
including the controls. Identical to Arm G except for the pace.

| cell | offered | windows (perStream / perSession) | `WEBTRANSPORT_STREAM_BATCH_BYTES` | role |
|---|---|---|---|---|
| `P-batch` | **1.25 Gbps paced** | 256 KiB / 2 MiB (**shipped**) | **65536** | **the gate arm** — every clause is a statement about this cell |
| `P-window-ref` | 1.25 Gbps paced | 16 MiB / 64 MiB (raised) | unset | clause 5's reference at the same offer |
| `P-control` | 1.25 Gbps paced | 256 KiB / 2 MiB (shipped) | unset | **disclosure cell**: does the shipped config need the lever to sustain the offer? |
| `A6-shipped` | **unpaced** | 256 KiB / 2 MiB (shipped) | unset | A6 denominator |
| `A6-raised` | **unpaced** | 16 MiB / 64 MiB (raised) | unset | A6 numerator |

**Why the A6 pair is unpaced.** A6 asks whether the flow-control window is the
binding constraint. Two cells held at the same offered rate deliver the same rate
whenever both can source it, so a ratio between two paced cells measures the
pacer, not the window — it would report `WINDOWS-NOT-BINDING` by construction and
that reading would be false. A6 is therefore re-run in its own unpaced form, on
the two cells phase-1 showed can be run unpaced without crossing the host bar
(they sat ~19 points under it). Their delivered figures are ceiling probes and
are used for nothing else.

**A6 knob-ON is registered as not measurable on this rig, and is not run.** Its
two cells are unpaced and knob-ON; phase-1 measured exactly those two at 92.3%
and 92.9% host CPU, i.e. both over the bar in both repeats with no overlap
against the knob-off group. Running them again to collect a second `unknown` is
not a measurement. This is recorded as a registered non-measurement, with its
reason, rather than as an `unknown` from a contaminated cell.

**Why `P-control` is a disclosure cell and not a completeness-gated one.** Its
expected outcome is a shortfall — that is its purpose: it answers "is the lever
necessary at this offer, or would the shipped default have sustained it anyway?".
Gating completeness on a cell whose registered expectation is that it fails to
meet its offer would make the gate unable to report its own most informative
negative result. Its bucket, its offered rate, its delivered rate and its drops
are all reported; no clause reads it.

### Invocations

`WEBTRANSPORT_STREAM_BATCH_BYTES` is read once at module init, so knob-off and
knob-on cells cannot share a process. Arm P runs as three invocations inside one
dispatch:

- invocation 1, knob unset: `P-control`, `P-window-ref`, `A6-shipped`,
  `A6-raised` (×2 each — 8 steps);
- invocation 2, knob `65536`: `P-batch` (×2 — 2 steps);
- invocation 3: `tools/load/gate-g5b-verdict.ts`, a pure evaluator over both
  artifacts.

`runArmP` **aborts** if a cell's required knob disagrees with what the process
resolved, so a mislabelled arm cannot be produced. The workflow's `mode: gate-g5b`
takes **no tunable dispatch inputs**: what ran is what was registered.

### Why the batch budget stays 65,536 B

The four arguments in gate-g5-bulk.md §"Why 65,536" are statements about the
shipped governors and the read path, not about any result, so they carry over
unchanged: (1) at the shipped 256 KiB per-stream governor the addon's
`min(1 MiB, maxQueuedBytesPerStream)` clamp leaves 64 KiB configured *and*
effective; (2) 16 in-flight streams × 64 KiB = 1 MiB, inside the 2 MiB
per-session governor, so the arm does not clear its bar by borrowing the budget
it claims to stay inside; (3) 8× headroom over the 8 KiB clause; (4) one quarter
of the per-stream window, so a crossing never holds more than 25% of a stream's
credit while JS owns it.

**One budget, no ladder.** Re-running `P-batch` at another budget to clear the
bar is forbidden, exactly as in the first registration.

## The two pacing integrity rules

Added to the axis's rules for `paced` cells only; the A6 pair is unpaced and
neither rule applies to it.

`offeredGbps = client.streamBytesWritten × 8 / windowSec / 1e9` — the client's
own byte counter over the same window every delivered figure uses.

- **P-STOP-1 `paced-overshoot` — INCOMPLETE.** `offeredGbps > 1.02 × pace`. The
  cumulative-deadline pacer cannot overshoot (property 1 above), so this rule is
  a **falsifier on the pacing mechanism itself**: if it fires, the arm was not
  paced, whatever the flag said, and no paced claim is made for that step. The 2%
  band covers counter and window skew, not a design tolerance.
- **`paced-shortfall` — DISCLOSURE, not INCOMPLETE.** `offeredGbps < 0.95 × pace`.
  On `P-control` and `P-window-ref` this is the registered expectation. On
  `P-batch` it means the gate arm did not source its offer, and the arm's
  delivered figure is then stated as "the rate sustained under a 1.25 Gbps
  offer", never as "1.25 Gbps offered and delivered".

**Registered ahead of the result, so it cannot look like leniency invented
afterwards:** a `paced-shortfall` on `P-batch` does **not** block clause 2.
Clause 2 asks whether ≥ 1.000 Gbps was delivered. If the arm offered 1.25 and
sustained 1.05 Gbps with the drain complete, the bytes were reliably delivered
and counted at the consumer over 60 s, and that is a sustained ≥ 1 Gbps — the
product statement the spec bar was written to license. The shortfall is disclosed
beside it. What *would* block clause 2 is any INCOMPLETE bucket
(`drain-incomplete`, `counter-contamination`, `host-saturated`,
`generator-saturated`, `paced-overshoot`, either gate integrity rule), all of
which say the step is not a measurement.

## Verdict rules, fixed before the run

Implemented in `tools/load/gate-g5b.ts` and unit-tested in
`tools/load/gate-g5b.test.ts` against synthetic cells, so they execute before the
dispatch rather than only inside the run they adjudicate. The evaluator reads
only the fields named here.

Every stream-throughput classifier rule applies first and verbatim (rules 1–5 of
the original registration and every Amendment 1 integrity rule), then
gate-g5-bulk.md's two additions, then the two pacing rules above. No P cell is a
rung of a ladder, so no cell is compared to another for its bucket.

### PASS requires all six

| # | clause | rule, restated for the paced shape |
|---|---|---|
| 1 | **completeness** | `P-batch`, `P-window-ref`, `A6-shipped` and `A6-raised` all usable: both repeats of each complete (no INCOMPLETE bucket). `P-control` is disclosed, not gating. |
| 2 | **throughput** | `median(P-batch delivered) >= 1.000 Gbps`, at a registered offer of 1.25 Gbps, with the achieved offer disclosed beside it |
| 3 | **inside shipped budgets** | `P-batch.insideShippedPerSessionBudget === true` **and** its governors are the shipped 256 KiB / 2 MiB **and** no explicit window field is set |
| 4 | **crossing at the paced rate** | `median(P-batch package-side meanBytesPerCrossing) >= 8192 B`, measured at the paced rate — phase-1's 54.9 KB was measured at 3.96 Gbps and licenses nothing here |
| 5 | **matched to the raised-window control** | `median(P-batch delivered) >= 0.95 × median(P-window-ref delivered)`, both cells at the same registered offer |
| 6 | **server-side rcvbuf drops on the gate arm** | `P-batch.serverSocketDrops === 0` in **both** repeats; **every cell's per-repeat drops are reported**, and a non-zero count makes that cell's delivered figure a lower bound |

A failure of any clause is a **MISS**, final for the effort per spec §Rerun
policy, routed to its mechanism ticket (07 for clauses 2/4, 09 for 3/5, the rig
for 6). The evaluator names the failing clause and does not aggregate.

### Clause 6, and what phase-1's omission actually was

Phase-1 bound this clause on `G-control` — the cell that was not the gate arm and
the cell where drops were cheapest to keep at zero — and then reported drops
**only** for that cell, leaving six of eight steps' non-zero counts (523–16,008)
out of the stamp entirely. The final review found this and it is the lesson this
registration carries. Two changes, and the reasoning for each:

1. **The clause moves onto `P-batch`**, the cell the gate's claim is made of. A
   gate that says "this configuration sustains ≥ 1 Gbps" must say it about a
   configuration whose receive socket dropped nothing.
2. **Every cell's drops are disclosed**, per repeat, in the verdict artifact and
   in the stamp, with a `deliveredIsLowerBound` flag emitted by the evaluator for
   any cell with a non-zero count — so a delivered figure and its drops can never
   again appear in different documents.

**What the clause deliberately does not do, and why**: it does not bind on all
five cells. `A6-shipped` and `A6-raised` are unpaced ceiling probes — running the
path until something binds is their function, and drops are a normal signature of
a ceiling, so a zero-drop requirement there would be a requirement that the
falsifier not do its job. `P-control` and `P-window-ref` are, by registered
expectation, offered more than their unpaced ceilings; a drop there is the
expected signature of the shortfall the gate is documenting, not a falsifier of
the gate's claim. Binding the clause on cells the gate makes no claim about would
let an expected, disclosed observation fail a gate for a reason unrelated to what
it asserts. The disclosure requirement, not the clause, is what discharges the
phase-1 lesson.

### The A6 falsifier, re-run

Arm A's rule verbatim, on the unpaced pair, at the chosen default:

- `a6AtChosenDefault = median(A6-raised) / median(A6-shipped)`; `> 1.10` ⇒
  `WINDOW-BOUND`, else `WINDOWS-NOT-BINDING`.
- `a6AtKnobOn` = **registered as not measurable on this rig** (see above);
  emitted as `not-measurable` with its reason, never as `unknown`.

The chosen default is `WEBTRANSPORT_STREAM_BATCH_BYTES` **unset** — no flip is
proposed by this gate and the soak-freeze forbids one before the rebind №5
ruling. `WINDOW-BOUND` at the chosen default does not by itself fail G5; it is a
disclosure and it moves the axis's `bulkCeilingIsLowerBoundOnly` flag exactly as
Amendment 1 specified.

### Reported, never a bar

`offeredGbps` and the shortfall/overshoot flags, `crossingsPerSecond`,
`maxBatchBytes`, `batchedCrossings`, `serverCpuMsPerGbit`, `clientCpuMsPerGbit`,
`rssMbPeak`/`Delta`, `gso`/`gro`, host and process CPU series, `coResidentDrops`
with its `MATERIAL`/`IMMATERIAL` verdict at the 0.1% band, and the lever's effect
`median(P-batch) / median(P-control)`. None carries a threshold. They exist so a
miss is interpretable and a pass is attributable.

## If the gate misses — what the artifact must already contain

Fixed here so no post-hoc instrument is added to explain a result.

- **Missed clause 2 (throughput) with `paced-shortfall` on `P-batch`:** the arm
  could not source 1 Gbps. `clientCpuPct` and the `generator-saturated` rule
  separate "the generator could not keep up" from "the server could not take it";
  `serverCpuPct` against `P-control`'s says whether the lever moved the cost at
  all. If the generator is the binder, the finding is a rig finding and routes to
  off-box generation, not to ticket 07.
- **Missed clause 2 without a shortfall:** the offer was sourced and the bytes did
  not arrive — impossible without an INCOMPLETE bucket on a reliable stream, so
  this branch predicts its own absence. If it happens anyway, the byte counters
  disagree with the classifier and the run is a harness fault, logged.
- **Missed clause 4 (crossing):** this is the clause most at risk in the paced
  shape and the registration says so before the run. At 1.25 Gbps the arrival
  rate at each of 16 streams is ~3.2× sparser than in the phase-1 cell that
  produced 54.9 KB/crossing, and a batching lever that takes only what is already
  queued (ticket 07's no-timer rule, inherited from H7) coalesces less when
  arrivals are sparser. `maxBatchBytes` decides between the mechanisms without
  another run: `≈ 65536` with a mean under 8192 ⇒ a bimodal distribution
  dominated by singleton crossings, i.e. the queue was usually empty when a
  crossing began and no larger budget would raise the mean; well under 65536 ⇒
  the budget was never the ceiling at this arrival rate. Either reading routes to
  ticket 07 and **neither licenses re-running this gate at another budget or at
  another pace**.
- **Missed clause 5:** `P-window-ref` outran `P-batch` at the same offer, which
  at a paced rate means the shipped windows bound the shipped-governor cell below
  the offer. Routes to ticket 09 with the A6 result beside it.
- **Missed clause 6 (drops on `P-batch`):** `serverSocketRxQueueBytesAtEnd`
  separates "the receiver never drained" from "the kernel buffer was too small".

## STOP conditions

The axis's STOP conditions 1 (generator saturation), 2 (host saturation), 3
(limiter engaged) and 5 (GSO uncomputable) apply verbatim, as do
gate-g5-bulk.md's G-STOP-A and G-STOP-B in their Arm P form:

- **P-STOP-A:** any clause-bearing cell (`P-batch`, `P-window-ref`,
  `A6-shipped`, `A6-raised`) unusable ⇒ **no gate verdict**. The run reports the
  cells it has. Not a rerun trigger.
- **P-STOP-B:** `crossing-instrument-disagreement` anywhere ⇒ no crossing claim
  is made for the whole arm.
- **P-STOP-1** (`paced-overshoot`), above: the mechanism falsifier.

**If the host bar fires on `P-batch` again**, the verdict is NO-VERDICT for the
second time and the registered conclusion is that this rig cannot grade G5 in any
on-box form. The gate then routes to off-box generation as the only remaining
design, and this registration is closed rather than re-paced. **Re-running Arm P
at a lower pace to get under the bar is forbidden** — it would be tuning the arm
to the result, and the second pace point would be a threshold derived from the
run it judges.

## Rules this gate holds itself to

- Every threshold, band, cell layout, pace point and budget in this document was
  fixed before the first dispatch, and the two phase-1-informed quantities are
  labelled as expectations that no clause reads.
- No default is flipped by this gate, and none may be: the soak-freeze binds
  until the rebind №5 ruling.
- No product code is changed for the measurement. The harness may only observe.
  The pacer is pre-existing load-client code, unmodified.
- Local macOS smoke validates only that the arm runs and that its output parses
  into these buckets. Every local step is INCOMPLETE by construction
  (`instrumentation-missing`, no procfs) and **local numbers are never quoted**.
- The gate is dispatched only on a candidate containing ticket 23's fixes.

## Run log

| # | date | run id | candidate SHA | invocations | outcome | artifact sha256 |
|---|---|---|---|---|---|---|
| 1 | 2026-08-19 | [32242618831](https://github.com/vmeansdev/webtransport-bun/actions/runs/32242618831) | `0d32d2784aa7597e2fc86d171427f62081398b7d` | **mis-dispatch — `mode=gate-g5`**, so `arms: ["G"]`, four Arm G cells, no Arm P step | **NO-VERDICT (G-STOP-A)**, phase-1 shape reproduced; **licenses nothing for either registration** | below |
| 2 | 2026-08-19 | [32244004915](https://github.com/vmeansdev/webtransport-bun/actions/runs/32244004915) | `0d32d2784aa7597e2fc86d171427f62081398b7d` | knoboff · knobon · verdict (`mode=gate-g5b`, `arms: ["P"]`) | **PASS**, all six clauses; stamped in ticket 27 | below |

Every dispatch is logged here, including aborted ones.

Both runs carry the same `headSha` and the same candidate because the
orchestrator dispatched the same ref twice with different `mode` inputs. The
candidate is `probe/stream-throughput-01` @ `0d32d278…`, rebased onto staging
`2a4145d0556a35f8b4a0849e5953927b5e028b64` (the merge of `fix/lever-hardening-01`,
i.e. ticket 23's five critical fixes including the `RESET_STREAM` terminal
latch in `client_stream.rs`). `b4af780ad3902c27ae69ca9f2f3a7c8c3172cdb7` — the
staging tip this document named while ticket 23 was open — is an ancestor of
`2a4145d`, so the registration's "dispatched only on a candidate containing
ticket 23's fixes" precondition is met and verified, not assumed.

### Run 1 — orchestrator mis-dispatch, disclosed

Dispatched with `mode=gate-g5`, the **phase-1** registration's mode, instead of
`gate-g5b`. The workflow therefore ran `gate-g5-bulk.md`'s Arm G on this
candidate: `G-control` 0.864 / 0.866, `G-window-ref` 1.093 / 1.110,
`G-batch` 3.890 / 3.861 (**median 3.876 Gbps**, `host-saturated` in both
repeats), `G-window-batch` 3.973 / 3.945 (`host-saturated` ×2) — G-STOP-A,
**NO-VERDICT**, the same shape phase-1 stamped. It is an input error, not a
rerun: the phase-1 registration is closed at NO-VERDICT and forbids re-running
Arm G, and this run is neither offered as nor capable of changing that. It is
logged in **both** pre-registrations' run logs because it executed the phase-1
harness while occupying this gate's runner slot, and it licenses nothing.

| file | sha256 |
|---|---|
| `bench-stream-g5-knoboff-0d32d278…json` | `8e7d938b98f20700a665b4ef3dfe31d414172ee34204cb115c08142f6284ab63` |
| `bench-stream-g5-knoboff-0d32d278…csv` | `adb6728ee89e2e080ae3f8f81db3a8536c415ba397e335344e6210e3616edaed` |
| `bench-stream-g5-knobon-0d32d278…json` | `7a4c6edf064b7ce2e3e613fb7f73617aace97d765749e9f0e17c65ea4b6424ad` |
| `bench-stream-g5-knobon-0d32d278…csv` | `a0ca19c2c9a30534a9704408b97f3a9a454b1e878530056d9493ce2905934f05` |
| `bench-stream-g5-verdict-0d32d278…json` | `256b5a8ed50991ac67b4390dd2f4d753abb0ca4e92df25e98669a5ba6686d75d` |

### Run 2 — the gate run

`bench-bandwidth.yml`, `mode: gate-g5b`, `[self-hosted, Linux, X64, heavy]`,
dedicated, no other inputs. Bun 1.3.14, 4 CPUs, procfs present. Ten step
fragments (8 knob-off + 2 knob-on), none missing, no harness abort, no declared
infra fault — a **valid run**, final for the effort per spec §Rerun policy.

| file | sha256 |
|---|---|
| `bench-stream-g5b-knoboff-0d32d278…json` | `6e4c7c31f449294cfe76d55a9573beff8c7e302564fb0d511d07485816cf9399` |
| `bench-stream-g5b-knoboff-0d32d278…csv` | `42472bce8938e9485df26b4ef29e355d57790ca4c54be4872bb61ff49a6c69c3` |
| `bench-stream-g5b-knobon-0d32d278…json` | `87309b40bc42bac2622f25414dd0551a845c160acedd4ff32b650489d8791efa` |
| `bench-stream-g5b-knobon-0d32d278…csv` | `ff4a515cc8c99832c5abe8c868cb4f9b876fbee9b0aec81401cdb07a3a774fd0` |
| `bench-stream-g5b-verdict-0d32d278…json` | `8b63991944f5a1ea6c8c3268f8fc4f7b25758ed26fe7c8a4b18bc8b0d0333537` |

These five hashes were computed twice: once over the artifact bundle handed to
the stamping agent and once over the bundle re-downloaded from run
32244004915 with `gh run download`. They match bit for bit, so the numbers
stamped in ticket 27 are provably the numbers this run produced.

**Verdict: PASS.** The stamp — every clause re-derived from the raw step
fragments rather than read off the evaluator's booleans — is
`.scratch/production-grade-scenarios/issues/27-g5-paced-gate.md` §"G5b stamp".
