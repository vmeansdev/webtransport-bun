# Pre-registration — Gate G3 (camera / desktop-share bursty egress, three-arm)

**Gate text (binding):** `.scratch/production-grade-scenarios/spec.md` rev 2,
§Targets, G3.
**Axis pre-registration (binding for everything this document does not
override):** `docs/research/preregistrations/egress.md`, including Amendments
1–8.
**Probe branch:** `probe/egress-01` (never-merge).
**Runner:** heavy self-hosted `[self-hosted, Linux, X64, heavy]`, 4 vCPU / 8 GB
Ubuntu on Hyper-V, receiver co-resident. No runner config changes.

**Written before any harness change made for this gate.** The commit carrying
this file precedes every harness commit this gate depends on; the dispatch log
in §11 is empty at the time of writing. Any post-hoc edit to this document is a
finding against its author, not a correction.

**Separation (spec §Process rules):** the agent preparing and running G3
implemented none of the four levers — not ticket 05 (send-batch native), not 07
(stream chunk batching), not 03 (close contract / promise-free send), not 09
(window fields).

## 1. Candidate composition

Per spec §Process rules, "candidate = the axis probe branch rebased onto the
staging SHA containing the needed lever commits; the rebased probe SHA is the
recorded candidate (never merged back); the staging base SHA recorded in the
stamp."

| role | SHA |
|---|---|
| staging base (carries ticket 05 `sendDatagramBatch`) | `3d03a9878619db77bc3d94b96976ddb5d9ddb24a` |
| probe branch before composition | `28394d955…` (`probe/egress-01`, axis base was staging `5ad02457`) |
| composed base after rebase (21 commits replayed, **zero conflicts**) | `5ad0d5d71aea915743fadef79f4a9d89913de99f` |
| candidate dispatched | recorded per dispatch in §11 |

**Rebase, not merge**, and the choice is recorded because the spec asks for the
auditable one: the probe's 21 commits touch only `tools/load/*`,
`crates/reference/*`, `docs/research/preregistrations/*` and the bench workflow,
while staging's lever commits touch only `crates/native/*`,
`packages/webtransport/*` and product docs — the two sets are **disjoint**, so a
rebase replays cleanly and leaves one linear history in which every harness
commit sits visibly on top of the lever commits it is testing. A merge would
have produced the same tree with an extra node and no added information.

The composed tree was verified before this document's commit: `bun run
build:native` and `bun run typecheck` both clean. Nothing had yet been changed
for the gate.

**What composition changes about arm (a), disclosed here rather than
discovered later.** The axis's original emitter awaited
`session.sendDatagram()` per datagram. On the composed tree that call now takes
staging's promise-free path (`trySendDatagram`, commits `1e9dd54`/`852bda3`):
when the datagram has budget it is queued synchronously and no N-API promise is
created at all. Arm (a) below is therefore *the shipped default send path as of
`3d03a98`*, which is what the gate should be measuring — but it is **not**
byte-identical to the emitter the axis pre-registration was written against, and
no number from this gate may be compared against a pre-composition egress
number.

## 2. What G3 asks

> **G3 camera egress** — restated per critic: the transport side is already
> licensed to ≥ 49k/s under the frame gate; the open variable is
> **origination**. Gate: at 32,600/s frame-bursty, a pre-registered **three-arm
> interleaved comparison at the same rung** — (a) serial-await per datagram
> (current), (b) pipelined per-datagram sends (no API change), (c) send-batch
> API — with the rung complete under (c), egressOneWay p99 < 33.3 ms, and
> T-send-batch's measured value stated as **(c) vs (b)**, never (c) vs (a).
> Alignment cost re-measured only with CPU symmetry between compared arms (or
> disclosed asymmetry + tolerance). Server-side UDP/GSO socket counters
> instrumented.

The subject is the **originator**, not the transport. Everything below exists to
make sure that when a number is reported, the JS scheduler that produced the
load is demonstrably not the thing the number is about — and that when it *is*
the thing the number is about, that is reported as the finding instead of being
laundered into a capacity claim.

## 3. The three arms, defined mechanically

All three drive the identical schedule (`tools/load/egress-schedule.ts`,
unchanged), the identical sessions, the identical payload and the identical
stamp. They differ in exactly one place: what the originator does with the
`amplitude` datagrams a session owes at one grid event.

| arm | id | per grid event |
|---|---|---|
| (a) | `serial` | for each element: read clock, stamp, `await session.sendDatagram(bytes)` — one await per datagram, in order |
| (b) | `pipelined` | for each element: read clock, stamp, call `session.sendDatagram(bytes)` **without awaiting**, retain the promise; after the last element, `await Promise.allSettled(promises)` |
| (c) | `batch` | for each element: read clock, stamp, push into an array; after the last element, one `await session.sendDatagramBatch(array)` |

No arm may retry, reorder, coalesce across grid events, or skip an element the
plan scheduled. Arm (c) reads the batch envelope's prefix semantics as they
ship: `sent = k` counts elements `0..k` as sent and elements `k..N` as
`sendErrors`, which is the same accounting arms (a) and (b) apply to a rejected
or failed single send.

### 3.1 Payload pool — the arms are given the same allocation shape

Arm (c) cannot share one payload buffer across a batch: `prepare_batch`
(`crates/native/src/datagram_batch.rs`) copies each element at the *call*, after
every element has been stamped, so a shared buffer would put the last stamp on
every datagram in the batch. Each session therefore holds a **pool of
`max(plan.amplitudes)` distinct stamped buffers** (55 at the gate rung), indexed
by position within the event — **and all three arms use it**, so no arm is
measured against a different allocation or cache shape than another. This is a
change from the axis harness (one buffer per session); it is registered here,
before the run, and it applies uniformly.

### 3.2 The stamp point, and why (c)'s interval is the conservative one

`actual` is read **immediately before the element leaves the JS scheduler's
hands**: the `sendDatagram` call in (a) and (b), the array push in (c).
`egressOneWay = client receive − actual` therefore contains, for arm (c) and for
element *j* of an event of *N*: the stamping of elements *j+1…N*, the array
assembly, the whole `sendDatagramBatch` crossing, and the transport. That is
*more* of the originator's work inside the measured interval than (a) or (b)
carry for their element *j*, not less.

Registered consequence, stated before the run so it cannot be chosen
afterwards: **if arm (c) wins, the stamp convention is working against it and
the win is a floor on the real one; if arm (c) loses, the convention is a
candidate explanation and the loss is reported with that caveat attached.** The
alternative convention — stamping (c) at the batch call — was rejected because
it would move real originator work outside the measured interval, which is the
exact shape of the thing this effort keeps catching.

`originationLag` (intended → first `actual` of the event) and `sendIssueSpread`
(first `actual` → last `actual` of the event) are recorded per arm and are the
per-arm generator instruments of §5.

## 4. Rung, profiles, blocks and interleave

| parameter | value |
|---|---|
| sessions | 100 subscriber sessions, one receive-only load-client process per arm |
| payload | 1150 B |
| per-session rate | 326/s → **32,600/s aggregate**, the gate rung, and the only rung |
| profiles | `frame-bursty` (the gate's profile) and `keyframe-aligned` (the alignment comparison) |
| emitter arms | `serial`, `pipelined`, `batch` |
| arms per block | 6 = 2 profiles × 3 emitters |
| blocks (replicates) | **n = 5** |
| drive per arm | **30 s**, 10 s settle between arms |
| total gate arms | 30 |

**Interleave order.** Block *r* (0-indexed) runs its 6 arms in the order
produced by rotating the fixed list

```
[frame-bursty/serial, frame-bursty/pipelined, frame-bursty/batch,
 keyframe-aligned/serial, keyframe-aligned/pipelined, keyframe-aligned/batch]
```

left by `r` positions. Over 5 blocks every arm therefore occupies 5 different
positions in the running order, so a monotone drift in the box (thermal, page
cache, accumulated sessions) cannot masquerade as an arm effect. Every
comparison in §6 and §7 is computed **paired within a block** and never across
blocks.

**Deviation from the axis pre-registration, quoted.** The axis registered:

> 100 subscriber sessions, 1150 B, **45 s per step, 10 s settle**.

The gate drives **30 s per arm**, 10 s settle. Reason, registered before the
run: the gate is one rung compared 30 ways rather than a 6-rung ladder, and
interleaving is worth more here than step length — 30 s at 32,600/s yields
≈ 978,000 stamped samples per arm against the axis's `sample-starvation` bar of
10,000, so the p99 is not sample-limited and the p999 is not either. No other
axis parameter is changed.

## 5. Per-arm honesty — the conditions, fixed before the run

The ticket's binding instruction: *bursty rungs above the originator's honest
ceiling are incomplete, and with arm (c) the whole point is testing whether that
ceiling moves.* So the ceiling is established **per arm**, and the STOPs that
depend on a within-arm control are grouped **per arm**.

### H1 — the loaded-server headroom arm runs once per emitter arm

The axis's Amendment 1 arm (`EGRESS_SHAPE=headroom`) is run **three times, once
per emitter**, unchanged in every parameter except the emitter and the profile:
transport carrying the gate rung (326/s/session, `frame-bursty`, 100 real
sessions), shadow sink sessions at multipliers `m ∈ {0.5, 1, 2, 4}`, 20 s each,
stop at first failure, a rung passing iff the originator emitted ≥ 0.95 of the
plan's scheduled count across real and shadow together **and** kept
`originationLag` p99 < 5 ms.

The shadow sink mirrors *that arm's* JS work and nothing else:

- `serial` / `pipelined` → `Buffer.from(bytes)` per element, the copy
  `sendDatagram` makes before the native call;
- `batch` → the real `sendDatagramBatchChunked` path (element type validation,
  the 256-chunk slice) with a fake native call that does `Buffer.from` per
  element, standing in for `prepare_batch`'s copy. Disclosed: the real copy is a
  native memcpy out of the `Uint8Array` and `Buffer.from` is JS's nearest
  equivalent; if it is the *cheaper* of the two, arm (c)'s ceiling is
  overstated, and that direction is stated here rather than assumed away.

`generatorCeilingPerSec(arm)` = the combined offered rate of the highest passing
rung for that arm.

### H2 — the headroom STOP is evaluated per arm

For each emitter arm independently:

```
generatorCeilingPerSec(arm) < 1.5 × maxOfferedAggregatePerSec(arm)
```

marks **that arm's** rungs `incomplete` with `generator-headroom`. An arm that
fails H2 contributes no latency number, no capacity number, and no side of any
Δ. `maxOfferedAggregatePerSec(arm)` is the largest
`scheduledDatagrams / driveWindowSec` over that arm's complete gate arms — the
plan's own arithmetic, never a delivered number.

### H3 — the origination-lag floor never crosses an arm

The axis STOP *"`originationLag` p99 ≥ 4 × `originationLagFloor`, where the
floor is the minimum `originationLag` p99 across every step of the same
profile"* is evaluated with the floor taken across the same
**(profile, emitter)** group only. Taking it across arms would let arm (c)'s
floor condemn arm (a) — or, worse, let a cheap arm's floor make an expensive
arm's honest behaviour look like saturation. At one rung with 5 blocks the group
is the arm's own 5 replicates, so H3 degenerates into a within-arm outlier test;
that is stated as its scope rather than sold as a saturation check. **H1/H2 are
the saturation check.**

### H4 — the absolute STOPs are unchanged and are per-arm by construction

`generator-saturation` on the skip ratio
(`sendEventsSkipped ≥ 0.10 × sendEventsScheduled`), `offered-shortfall`
(`sent < 0.90 × scheduledDatagrams`, or `sessionsConnected < 0.95 ×
sessionsRequested`), `clock-invalid`, `delivery-collapse` (< 0.80) and
`sample-starvation` (< 10,000 samples) apply per arm exactly as the axis
registered them, in the axis's order.

### H5 — the ceiling-movement finding, registered before it can be convenient

If arm (b) fails H2/H4 at the gate rung and arm (c) passes, **the gate does not
report a Δ p99 between them.** It reports the finding in this form, and only
this form:

> At 32,600/s frame-bursty on this rig, the pipelined originator could not
> honestly source the load (ceiling C_b/s, needed 48,900/s) while the batched
> originator could (ceiling C_c/s). The lever's value at this rung is that the
> originator's ceiling moved from C_b to C_c; a tail comparison at this rung is
> not available because one side of it is not a measurement.

That is a **stronger** result than a Δ, and registering its shape now is what
stops it from being reported as a Δ later. The symmetric case (both honest)
yields the Δ of §6. The case where (c) is dishonest and (b) is honest is
reported with the same sentence inverted, and the gate fails its C1 clause.

### H6 — prediction, on the record

Registered prediction, so that a confirmed one cannot be presented as a surprise
and a refuted one cannot be quietly dropped: **arm (a) is expected to fail H2**
(serial-await at 32,600/s already spends ~1.4–4.9 ms of origination lag per the
axis's four-axes evidence, and H2 asks it for 48,900/s on a loaded box), arm (b)
is **uncertain**, and arm (c) is expected to pass. The gate is not re-registered
if this prediction is wrong.

## 6. Gate clauses

Evaluated at the 32,600/s `frame-bursty` rung only. A clause whose inputs are
missing or invalid is **INCOMPLETE** — never a pass, and never a fail charged to
the server.

### C1 — the rung is complete under arm (c)

**PASS** iff all 5 `frame-bursty`/`batch` blocks are complete (no STOP, H1–H4
included). Any incomplete block makes C1 **INCOMPLETE** and reports which STOP
fired in which block. C1 is not satisfied by a majority.

### C2 — egressOneWay p99 < 33.3 ms under arm (c)

Evaluated on the 5 per-block `egressOneWay` p99 values of the
`frame-bursty`/`batch` arm. Reported as the **median** with the order-statistic
interval `[min, max]` (k = 1…5; distribution-free coverage
`1 − 2^(1−5) = 93.75 %` for the median).

- **PASS** iff C1 passes **and** `max < 33.3 ms` — the whole interval under the
  bar.
- **INCONCLUSIVE-AT-BAR** iff `median < 33.3 ms ≤ max`. Reported under that name,
  with both numbers. It is not rounded to a pass.
- **FAIL** iff `median ≥ 33.3 ms`.

`endToEnd` and `originationLag` are reported beside it for every arm, never in
place of it.

### C3 — the lever value, stated as (c) vs (b)

Only if **both** (b) and (c) are honest at the rung (H1–H4 clear for both). Per
block *r*, `Δ_r = p99(c, r) − p99(b, r)`; the reading is `median(Δ_r)` with the
order-statistic interval `[min Δ_r, max Δ_r]`. Sign convention: **negative =
the batch API is faster.**

- The reading is `lever-positive` only if the whole interval is < 0.
- `lever-inconclusive` if the interval spans 0. A median on the good side of
  zero with an interval crossing it is reported as inconclusive, in those words.
- `lever-negative` if the whole interval is > 0.

**Confound labels, both mandatory and both computed, never negotiated:**

- `ab-confounded` when the two arms' `downDeliveryRatio` differ by > 0.02 in a
  block (an arm that drops more shows a better tail for free). A confounded
  block's Δ is published and excluded from the median, and if ≥ 2 of 5 blocks
  are confounded the whole C3 reading is advisory.
- `cpu-asymmetric` per §7's rule, applied to (b) vs (c) exactly as it is applied
  to the alignment pair.

**(c) vs (a) is computed and published as a diagnostic and is never the stated
lever value**, per the spec's explicit instruction. If arm (a) fails H2 it is not
computed at all.

### C4 — server-side UDP/GSO counters are on the record

Not a pass/fail clause — an instrumentation obligation the spec attaches to the
gate. Satisfied iff every arm's fragment carries the §8 counters and the run
header carries the GSO/GRO capability read.

## 7. Alignment cost, and the CPU-symmetry condition

`Δ_align = p99(keyframe-aligned) − p99(frame-bursty)` at the same rung, **within
one emitter arm and paired within one block**, bucketed by the axis's registered
thresholds (`alignment-free` < 1 ms, `alignment-cheap` < 10 ms,
`alignment-expensive` < 33.3 ms, `alignment-fatal` ≥ 33.3 ms).

**CPU symmetry (registered tolerance, fixed now).** Two arms of a block are
*symmetric* iff

- `|serverCpuPct(x) − serverCpuPct(y)| ≤ 10` (percent-of-one-core, the unit the
  effort spec binds; 10 of a 400-point scale), **and**
- `|hostCpuPctMedian(x) − hostCpuPctMedian(y)| ≤ 20` (same unit).

A symmetric pair's Δ is **measured**. An asymmetric pair's Δ is **disclosed**:
published with both CPU numbers, the gap, and the label `cpu-asymmetric`, and it
carries no bucket verdict. This is the spec's "(or disclosed asymmetry +
tolerance)" branch, and the tolerance is these two numbers, chosen before any
CPU reading from this gate exists.

The axis's `ab-confounded` delivery-ratio rule applies to the alignment pair
unchanged.

## 8. Server-side UDP / GSO instrumentation

Recorded **per arm**, as deltas across the arm's drive window, from
`/proc/net/snmp`: `InDatagrams`, `OutDatagrams`, `InErrors`, `RcvbufErrors`,
`SndbufErrors`.

Recorded **once per run**, in the fragment header, from `quinn_udp` itself via
the existing `gso-probe` binary (`crates/reference/src/gso_probe.rs`):
`maxGsoSegments`, `groSegments`.

Three disclosures, written now:

1. `/proc/net/snmp` is **host-wide**, not per-socket. On this shape it is still
   attributable: subscribers run `--datagrams-per-sec 0`, so `OutDatagrams` over
   an arm is the server's egress plus a negligible ACK-free remainder, and
   `SndbufErrors` is the egress-side kernel drop counter this gate cares about.
   The fan-out shape is not run here, so no second sender exists.
2. The kernel exposes **no per-send GSO segment count**. `maxGsoSegments` is a
   capability read, not a measurement of how many segments any send actually
   carried. No claim of the form "the batch produced N-segment GSO writes" may
   be made from this instrument, and none will be.
3. UDP counters are recorded for **all three arms**, so a difference in
   `OutDatagrams` per delivered datagram between arms is visible. That is the
   nearest available evidence about whether the batch path changes the syscall
   shape, and it is reported as exactly that much.

## 9. Inherited obligation — cross-check R4 is OPEN

Gate G2's stamp (`.scratch/production-grade-scenarios/issues/18-gate-g2-games.md`)
records the registered cross-check **R4 as inconclusive**: its four readings are
decided at the 15,000/s rung, that rung was not honest, so
`gateRungRatios` are `null` and nothing may be substituted for them. The 6.6×
ingest-vs-egress tail asymmetry is therefore **unresolved**, and the spec's
requirement that it be resolved *inside the A/B dispatch, before the G2 and G3
stamps* is **unmet**.

Registered consequence for this gate, before it runs:

> **G2's server ingest p99 and G3's egressOneWay p99 are not established as
> comparable units.** No statement of this gate may put them in one sentence as
> if they were, no ratio between them may be computed, and no "ingest is N×
> better/worse than egress" claim follows from G2 and G3 together. The G3 stamp
> must carry this disclosure on its face.

This is inherited, not created here, and G3 does not close it: closing it needs a
same-rung same-payload measurement with the H7 wait isolated, which is the A/B
ticket's shape and not this gate's.

## 10. What this gate may not do

- It may not be re-run to get a different answer. Spec §Process rules: one
  complete run stamps; a rerun requires a declared, logged harness/infra fault;
  a miss on a valid run is final.
- It may not be tuned to clear a bar — not the rung, not the block count, not
  the arm length, not the tolerances in §7, none of which may move after this
  commit.
- It may not flip a default. `sendDatagramBatch` is additive and knob-free; the
  soak-freeze forbids default flips before the rebind №5 ruling regardless, and
  this gate lands nothing.
- It may not quote a local macOS smoke number as a result. The local smoke
  exists to prove the harness runs, that all three arms drive, and that the
  classifier parses the output into these buckets.
- It may not claim a capacity, a ladder, a session count, or an off-box number.
  One rung, 100 sessions, co-resident receiver, disclosed.
- It may not report a `(c)` number against a pre-composition egress number
  (§1).

## 11. The dispatch, fixed before it is made

One dispatch, `bench-bandwidth` on the heavy runner, `egress_gate=true`:

| input | value |
|---|---|
| `candidate_commit` | the tip of `probe/egress-01` carrying this section (recorded in the log below) |
| `egress_probe` | `true` |
| `egress_gate` | `true` |
| `egress_gate_emitters` | `serial,pipelined,batch` |
| `egress_gate_profiles` | `frame-bursty,keyframe-aligned` |
| `egress_gate_blocks` | `5` |
| `egress_gate_rate` | `326` |
| `sessions` | `100` |
| `payload_bytes` | `1150` |
| `egress_step_seconds` | `30` |

The workflow runs, in this order: the loaded-server headroom control once per
arm (`EGRESS_SHAPE=headroom`, `frame-bursty`, `EGRESS_HEADROOM_RATE=326`), then
one `EGRESS_SHAPE=gate` process driving all 5 blocks × 6 arms, then one
`egress-classify` call over all four fragments. The ladder and the fan-out
shapes do **not** run in this dispatch; the gate needs neither and the run
budget is one dispatch.

Expected wall clock ≈ 50 min against the workflow's 120 min timeout: 3 headroom
arms (4 multiplier rungs × 20 s each plus connect), 30 gate arms at ≈ 55 s each
including the subscriber process's own lifetime, plus the cargo and bun builds.

### Dispatch log

Every dispatch is logged here — run id, candidate SHA, artifact hash —
including aborted ones, per the effort spec's process rules.

| dispatched | run id | candidate SHA | artifact hash | outcome |
|---|---|---|---|---|
| 2026-08-19 | `32213270203` | `e392c227d7215d8d71c7dd2dc46c8e3c80b0d605` | see below | **complete, valid, stamped** |

Artifact `bench-egress-e392c227d7215d8d71c7dd2dc46c8e3c80b0d605`, SHA-256 per
fragment:

| fragment | sha256 |
|---|---|
| `…-headroom-serial.json` | `92661a8f2786151bf8df007909e4f9a03ef3423c55754fa0bcfe9bd9ed02c483` |
| `…-headroom-pipelined.json` | `e601ac90d4b08432476c9900b31507b65ba690b50edcc14d47295f6bd633cc2f` |
| `…-headroom-batch.json` | `3da27db96763298a6002d2eb35754148c0dccf9b09fe939dad459d807ad39ad5` |
| `…-gate.json` | `9974413b725c38d21ee19d990be60dba39ec4c849dde648e0916c5f7d358dd61` |
| `…-classified.json` (as produced in-run) | `6940f2b13f10261d03468369a40f6bb54a21994b9367fb8635c4c4b52b09f683` |
| re-classified from the same four raw fragments after the §12a fix | `ca32edbad319dc638d3f53b04593bdb39321dfcc1428786fc551e22607ade6aa` |

One dispatch, as registered. The four raw fragments are untouched and every
number in §12 is derived from them.

## 11a. Local smoke (not a result)

Run on macOS before the dispatch, at 4 sessions / 60 per-session / 2 blocks /
4 s arms, purely to show the harness runs and its output parses into the buckets
above. **No number from it is a result** and none is quoted anywhere.

What it demonstrated: all three arms drove and delivered 1.000; the block
rotation put a different cell first in block 1; the batched arm made one call
per grid event carrying distinct stamps; each arm produced its own headroom
ceiling; `EGRESS_HEADROOM_BURN_NS` marked the batched arm's run
`harness-falsifier`; the classifier resolved every clause of §6 mechanically
(`C1/C2/C3/C4 = INCOMPLETE`, correctly — 1,034 samples per arm against the
registered 10,000-sample floor, and macOS has no `/proc/net/snmp`).

That last point is a property of the smoke host, not of the gate: on the Linux
runner an arm carries ≈ 978,000 stamped samples and the UDP counters exist, so
C4's instrumentation obligation is met there and only there.

## 12. Verdict

Written after the run, from the classifier's own output, with every clause of §6
stated separately. Run `32213270203`, candidate `e392c22`, one dispatch, valid.

**Headline: G3 is INCOMPLETE, and the reason is the originator — the thing the
gate was built to be honest about.** All three JS emitter arms failed their own
loaded-server headroom control (§H1) at its lowest rung, so no arm cleared §H2
and no arm may contribute a capacity or latency number at this rung. The batch
arm's blocks were all step-complete and its tails were far under the bar; that
is not a pass, and §6's "a clause whose inputs are missing or invalid is
INCOMPLETE" is what it is for.

### 12.0 The rung as realized

Registered rung: 326/s/session → 32,600/s. Realized: **352/s/session →
35,200/s**, because the schedule quantizes the per-session rate onto the profile
grid. The run therefore ran **8.0 % above** the registered rung. Disclosed, not
corrected: a rung above the registered one is the conservative direction for
every latency clause and the harder direction for every honesty clause, and no
threshold was moved to accommodate it. Every number below is at 35,200/s.

### 12.1 §H1 — the per-arm headroom control, from the raw fragments

Registered rule (§H1, verbatim): *"a rung passing iff the originator emitted
≥ 0.95 of the plan's scheduled count across real and shadow together and kept
`originationLag` p99 < 5 ms"*, multipliers `m ∈ {0.5, 1, 2, 4}`, **stop at first
failure**, `generatorCeilingPerSec(arm)` = the combined offered rate of the
highest passing rung.

| arm | m | offered/s | emitted fraction | ≥ 0.95? | `originationLag` p99 | < 5 ms? | rung |
|---|---|---|---|---|---|---|---|
| `serial` | 0.5 | 52,793 | 0.95051 | yes | **30.671 ms** | no | **fail** |
| `pipelined` | 0.5 | 52,729 | 0.96096 | yes | **31.195 ms** | no | **fail** |
| `batch` | 0.5 | 52,794 | **1.00005** | yes | **8.520 ms** | no | **fail** |

Every arm failed at `m = 0.5`; "stop at first failure" means no arm reached
`m = 1`, and each fragment carries exactly one rung. **No rung passed for any
arm, so `generatorCeilingPerSec = 0` for all three.** The zeros are the
measurement, not a missing read.

Note what `m = 0.5` is: 100 real + 50 shadow sessions × 352/s = 52,800/s, which
is exactly `1.5 × 35,200` — the §H2 bar itself. The gate's honesty hinged
entirely on this one rung, by construction.

### 12.2 §H2 — the arm-level STOP

`generatorCeilingPerSec(arm) < 1.5 × maxOfferedAggregatePerSec(arm)`:

| arm | ceiling | max offered | ratio | §H2 |
|---|---|---|---|---|
| `serial` | 0/s | 35,200/s | 0.00 | **`generator-headroom`** |
| `pipelined` | 0/s | 35,200/s | 0.00 | **`generator-headroom`** |
| `batch` | 0/s | 35,200/s | 0.00 | **`generator-headroom`** |

Per §H2 as registered: an arm that fails it *"contributes no latency number, no
capacity number, and no side of any Δ."* That applies to all three.

### 12.3 The four clauses

**C1 — the rung is complete under arm (c): INCOMPLETE.** All five
`frame-bursty`/`batch` blocks are step-complete (no H3/H4 STOP in any block; 100
sessions connected, `sendEventsSkipped = 0`, `downDeliveryRatio = 1.000`,
≈ 1,056,055 samples per block against the 10,000 floor). The clause is still
INCOMPLETE because §6 C1 requires *"no STOP, **H1–H4 included**"* and the arm's
own H2 STOP is `generator-headroom`. **Arm STOP: `generator-headroom`; per-block
STOPs: none.**

**C2 — egressOneWay p99 < 33.3 ms under arm (c): INCOMPLETE**, because C2 is
registered as conditional on C1. The numbers are published rather than withheld,
and they are **not a pass**:

> `frame-bursty`/`batch` p99 by block: 3.572, 2.523, 2.916, 1.425, 1.425 ms →
> **median 2.523 ms, order-statistic interval [1.425, 3.572] ms**, coverage
> 93.75 %, bar 33.3 ms.

The whole interval sits 9× under the bar. That is what the transport did while
the JS originator could not prove it was sourcing the load honestly, and it is
recorded as exactly that much — a tail measured behind an unmet honesty
condition, never a licensed capacity.

**C3 — the lever value, stated as (c) vs (b): INCOMPLETE. The lever's value at
this rung is not established.**

Registered §H5 does not apply: it fires when (b) is dishonest and (c) is honest
(`CEILING-MOVED`), or the inverse (`CEILING-MOVED-AGAINST`). Here **both** sides
are dishonest, and the registered name for that is INCOMPLETE. `ceilings =
{serial: 0, pipelined: 0, batch: 0}`, `headroomRatios = {0, 0, 0}`, comparison
`null`, `diagnosticVsSerial` `null` (arm (a) failed H2, so per §C3 it is not
computed).

Published for the record, and **not** the lever's value: the classifier's
independent `emitterComparisons` block, which pairs within blocks without
consulting H2, reads `frame-bursty` batch vs pipelined as **`lever-inconclusive`,
median −1.229 ms, interval [−1.999, +0.459] ms, n = 5, 4 of 5 blocks
`cpu-asymmetric`**. Even taken at face value that interval spans zero, so nothing
would have been claimed from it either.

**C4 — server-side UDP/GSO counters on the record: PASS.** GSO capability read
present in every fragment header (`maxGsoSegments = 64`, `groSegments = 64`,
"GSO ACTIVE, GRO ACTIVE"). `/proc/net/snmp` deltas present on **all 30 gate arms**
(the clause evaluates the gate profile's 15). `SndbufErrors = 0` on all 15
`frame-bursty` arms.

Per §8 disclosure 3 — the syscall-shape evidence, reported as exactly that much
and no more (app datagrams sent ÷ counted UDP `OutDatagrams`, median over 5
blocks):

| profile | serial | pipelined | batch |
|---|---|---|---|
| `frame-bursty` | 2.434 | 2.497 | **3.574** |
| `keyframe-aligned` | 3.291 | 3.172 | **3.751** |

The batched arm's egress cost ≈ 30 % fewer counted UDP sends per delivered
datagram than either per-datagram arm on the gate profile. Per §8 disclosure 2
this is **not** a claim that any send carried N GSO segments; the kernel exposes
no per-send segment count and none is claimed. One `RcvbufErrors` exception:
`keyframe-aligned`/`batch` shows 3–373 per arm; every `frame-bursty` arm is 0.

### 12.4 §7 — alignment cost, all pairs disclosed, none bucketed

Every one of the 14 available (profile-paired, within-arm, within-block)
comparisons is **`cpu-asymmetric`** against the tolerances fixed in §7
(server ≤ 10, host ≤ 20 percent-of-one-core): observed server gaps **50.8–75.9**
and host gaps **90.4–132.6**. Per §7 each Δ is therefore **published with both
CPU numbers and carries no bucket verdict**. Medians of the disclosed Δs:
`serial` ≈ 2.96 ms, `pipelined` ≈ 1.97 ms, `batch` ≈ 13.73 ms. The 15th pair,
`serial` block 0, does not exist: its `keyframe-aligned` step stopped on
`offered-shortfall`.

**No alignment cost is stated by this gate.** The spec's condition was "only with
CPU symmetry between compared arms (or disclosed asymmetry + tolerance)"; this is
the disclosure branch, and disclosure is not a measurement.

### 12.5 The `keyframe-aligned` profile

§6 binds the clauses to the `frame-bursty` rung only; `keyframe-aligned` enters
this gate through §7 alone. Run through the same clause machinery for
completeness: **C1 INCOMPLETE** (5/5 blocks step-complete on the batch arm, arm
STOP `generator-headroom` — the same H2 failure, the ceiling is per-arm and not
per-profile), **C2 INCOMPLETE** with median 16.646 ms, interval [13.238, 20.185]
ms, **C3 INCOMPLETE**, **C4 PASS**. The `keyframe-aligned`/`serial` block 0 step
also carries a step-level `offered-shortfall`.

### 12.6 §H6 — prediction against outcome

Registered before the run: **(a) expected to fail H2, (b) uncertain, (c) expected
to pass.**

| arm | predicted | outcome | |
|---|---|---|---|
| (a) `serial` | fail H2 | **failed H2** | **confirmed** |
| (b) `pipelined` | uncertain | failed H2 | consistent — nothing was claimed |
| (c) `batch` | pass | **failed H2** | **refuted** |

Per §H6 the gate is not re-registered because the prediction was wrong, and it
is not. The refutation is the gate's finding.

The refutation has a shape worth stating precisely, because it is not "the batch
API did nothing". At the headroom rung all three arms cleared the emitted-count
half of §H1; **all three failed on the lag half alone**, and there the arms are
not alike: `batch` held `originationLag` p99 at **8.520 ms** against `serial`'s
30.671 ms and `pipelined`'s 31.195 ms — **3.6× lower**, and it was the only arm
to emit its full scheduled count (1.00005 vs 0.951 / 0.961). It missed a 5 ms bar
that the other two missed by 6×. That is a reading of the headroom control
itself, which is where the ceilings come from; it is **not** a gate number, not a
Δ, and not a substitute for C3, which stays INCOMPLETE.

### 12.7 Disclosures carried on this stamp's face

1. **R4 is OPEN, inherited from G2 and not closed here.** G2's server ingest p99
   and this gate's `egressOneWay` p99 are **not established as comparable units**.
   No ratio between them may be computed, they may not appear in one sentence as
   if commensurable, and no "ingest is N× egress" claim follows from G2 and G3
   together. The classifier prints `crossCheckR4: "open"` on every run.
2. **Arm (a) rides staging's promise-free path (§1).** On the composed tree
   `session.sendDatagram()` takes `trySendDatagram`; arm (a) is the shipped
   default send path as of `3d03a98` but is **not** byte-identical to the emitter
   the axis pre-registration was written against. No number here may be compared
   against a pre-composition egress number.
3. **The stamp-point convention loads arm (c) (§3.2).** `actual` is read at the
   array push for (c) and at the send call for (a)/(b), so (c)'s measured
   interval contains the remaining stamps, the array assembly and the whole
   `sendDatagramBatch` crossing. Registered consequence, unchanged: a (c) win is a
   floor on the real one. It is recorded here only to keep the convention on the
   record — this gate states no (c)-vs-(b) win.
4. **`/proc/net/snmp` is host-wide** and attributable only because subscribers ran
   `--datagrams-per-sec 0`; **no per-send GSO segment count exists** and none is
   claimed (§8).
5. **Co-resident receiver, one rung, 100 sessions, 4 vCPU box.** Host CPU ran
   175–257 % of 400 on the `frame-bursty` arms and 231–258 % during the headroom
   control. No capacity, ladder, session-count or off-box claim is made (§10).

### 12.8 What the gate licenses, and what it does not

- It licenses **nothing about capacity** at 35,200/s frame-bursty. C1 is
  INCOMPLETE.
- It states **no value for T-send-batch**. C3 is INCOMPLETE; §H5's moved-ceiling
  form does not apply because both sides failed.
- It states **no alignment cost**. Every pair is disclosed-asymmetric.
- It **does** put the instrumentation on the record (C4 PASS) and it **does**
  establish, from the control rather than the gate, that at 52,800/s offered on
  this rig the JS originator is the binding constraint under all three arms —
  which is the axis's open question answered in the direction the ticket was
  built to detect rather than laundered past.

A miss on a valid run is final (§10). This run was valid.

## 12a. Post-run finding against the classifier — the C1 defect

Registered rule being applied: this document may not be edited to change a
threshold after results exist; a post-run correction is a **finding against its
author**, documented as such, never a threshold move. This is one.

**The bug.** `gateVerdictG3` computed C1 as
`blocks > 0 && completeBlocks === batch.length` — the batch arm's **per-step**
completeness only. Per-step `complete` encodes H3 and H4; **H1 and H2 are
arm-level** and live in the arm's `RunVerdict`, which the same function was
already reading four lines later to decide C3. The in-run
`…-classified.json` therefore printed the self-contradiction the orchestrator
caught: **C1 = PASS and C2 = PASS on the batch arm, while C3 = INCOMPLETE
because that same batch arm was not honest.** §6 C1's own words are "complete
(no STOP, **H1–H4 included**)", so the pre-registered clause was under-read, not
ambiguous.

**Not the suspected bug.** The first hypothesis was that the classifier failed to
parse the three `headroom-*.json` fragments and defaulted the ceilings to 0. It
did not: the fragments each carry exactly one rung, `m = 0.5`, with
`passes: false`, and `ceilingPerSec: 0` is written **in the raw fragment by the
harness**. The hand derivation in §12.1 is taken from those raw fields and the
§H1 rule quoted verbatim, and it reproduces `{serial: 0, pipelined: 0, batch: 0}`
exactly. The zeros were always right; the C1/C2 passes were always wrong.

**The fix.** C1 now requires the batch arm's `RunVerdict.complete` alongside its
per-block completeness, and the clause reports `armStop` so the arm-level STOP
has somewhere to be named (it belongs to no block). No threshold, rung, block
count, tolerance or clause name changed. A regression test —
*"C1: five step-complete blocks under a failed headroom arm are INCOMPLETE"* —
pins the exact configuration this run produced.

**Verification that the fix is a fix and not a second opinion.** The corrected
classifier was re-run over the **same four untouched raw fragments** and its
output matches the hand derivation of §12.1–12.3 clause for clause:
`C1=INCOMPLETE (5/5 batch arms complete, 5 blocks, armStop=generator-headroom)`,
`C2=INCOMPLETE median=2.523ms [1.425, 3.572]`, `C3=INCOMPLETE ceilings={0,0,0}`,
`C4=PASS 15/15`. `bun test tools/load/egress-*.test.ts` → **136 pass / 0 fail**;
`bun run typecheck` clean; Biome clean.

**Direction of the error, stated plainly.** The defect made the gate read
*better* than the evidence supports — a false C1/C2 PASS on the lever's own arm.
It was caught by a reader cross-checking two clauses of one artifact against each
other, not by the harness. The generalizable lesson: a clause that inherits
another clause's honesty condition must **read that condition**, not re-derive a
weaker proxy from the same inputs; every registered "H1–H4 included" needs a test
that fails when only H3/H4 are consulted.
