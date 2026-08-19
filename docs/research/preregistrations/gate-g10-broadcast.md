# Pre-registration — Gate G10: mass broadcast (tickers · live events · market data)

**Status:** registered, no run. Written before any G10 harness code existed and
before the Ethernet cable this gate depends on was characterized.

**Ticket:** `.scratch/production-grade-scenarios/issues/35-gate-g10-broadcast.md`
**Spec:** `.scratch/production-grade-scenarios/spec.md` rev 2 (§Process rules binding)
**Branch:** `probe/g10-broadcast-01`
**Base:** `rebind4-staging` @ `9c475df1e255388abf4a07733164869f6377e0b7`
(the `design/mirror-send-01` merge — M1's `sendDatagramMirror`, on top of the
`fix/lever-hardening-01` merge that carries the promise-free send fast path and
the counted/one-deadline batch fixes). **Amended from
`2a4145d0556a35f8b4a0849e5953927b5e028b64`** under §11's own re-derivation rule;
the rebase is recorded in §11.2. If `rebind4-staging` moves again before
dispatch, the candidate is **not** rebased silently: §11 says what happens
instead.

**One-sentence statement of what this gate asks.** One small message, ten
thousand subscribers, a moderate message rate: can this rig put every copy of a
market-data tick on the wire close enough together that no subscriber is
systematically disadvantaged, and does it still answer anybody while it does?

**Scope ruling.** The ticket's original "NOT part of the pre-soak bar" line is
superseded by the maintainer's 2026-08-19 ruling (option c): **this gate is in
the pre-soak all-PASS bar.**

---

## 0. Disclosure ledger — everything already known that could inform a threshold

Read this before §2. Every number here existed before this document was written;
**none of it may be re-read after the run to move a bar.** A threshold comes from
scenario arithmetic or from prior *stamped* data, never from this gate's own run,
so the prior data goes on the page up front with its verdict status attached.

| # | Fact | Where from | Verdict status of the source |
|---|---|---|---|
| K1 | 10,000 sessions × 0.2 pps (2,000/s, 100 B, no echo): delivery **1.000**, ingest p99 **2.945 ms**, host CPU median **104.2%** of 400 with a co-resident generator | G1, run `32207919468` | **PASS** (staggered arrival only) |
| K2 | A wall-clock-synchronized 10,000-session fleet at the same mean rate delivers **0.699**; the whole gap is kernel `RcvbufErrors` *ahead of* the server. The Linux impulse knee is **below** 5,000 packets | T02, run `32192153026` | **CONFIRMED** attribution |
| K4 | Frame-bursty egress at **35,200/s** read `egressOneWay` p99 **2.52 ms**; the 52,800/s rung's originator honesty failed | G3 phase 1 | **INCOMPLETE**, published verdict-less |
| K5 | G3b's re-run is **INVALID** (V1 fired: `schedulerLag` p99 spread 2.28–3.85× across arms). Its 105,573/s ceiling licenses **nothing** | G3b, run `32238304133` | **INVALID** |
| K6 | 1→50 fan-out of a 3 Mbps publisher: publisher→subscriber p99 **10.35 ms**, forward delivery **1.000**, forward egress **16.3k/s** | G4, run `32216072119` | **PASS** — the highest *valid* stamped egress figure in this effort |
| K8 | The settled on-box **ingest** ceiling is **~103k/s** (Cubic loopback pipe ~105k) | `docs/research/2026-08-18-bandwidth-ceiling-attribution.md` | closed finding |
| K9 | A **1 GbE** cable at 1150 B payload has a wire ceiling of **~102,800 pps**. The same arithmetic at **200 B** gives **469,924 pps** (§1.3) | Ticket 29 §3, arithmetic | derivation, link speed **not yet observed** |
| K11 | On this Mac, idle, 20 sessions × 50/s, `--arrival uniform`: generator `scheduleLag` **871 µs mean, 40.6 ms max** | Ticket 29 §4 | measured caution |
| K12 | Ticket 29's iperf3 UDP figure is an **offered rate that was met**, not a measured ceiling. It predicts **nothing** about the Mac's sink capability | Ticket 29 §2 | correction registered before the run |
| K13 | GSO and GRO are **ACTIVE** on the runner at 64 segments; `/proc/net/snmp` is host-wide | GSO probe + G3b C4 | standing disclosure |
| K14 | `send_datagram_batch` bypasses `spawn_counted` (invisible to the close-contract counters), and "one deadline per call" is false above 256 elements | final-round review | open defects, disclosed |
| K15 | `WEBTRANSPORT_DATAGRAM_SEND_SYNC` landed **default-ON** pre-soak; whether that stands is an **open maintainer ruling** | final-round review | open ruling |
| **K16** | **Landed emitter cost, measured**: per-target promise-free `trySendDatagram` at N = 10,000, payload 200 B, is **331 / 334 / 343 ns/target** across microbench runs 1 / 3 / 5. The old per-target *promise* path is 2,772–3,832 ns/target | T34 `tools/bench/mirror-send/RUNS.md` runs 1, 3, 5 | same-pass ratios only; **no absolute number here is a result** |
| **K17** | **Mirror-API cost, measured, same passes**: `string[]` targets **84–86 ns/target**, `Uint32Array` **28–30 ns**, native group handle **11 ns**. Envelope shapes at N = 10,000 and 0% failure all cost **11 ns/target** — `{sent, failed}`, failures-only, and bitset are indistinguishable; only the per-target `(string\|null)[]` shape (26–28 ns) is dearer | T34 RUNS.md runs 1, 2, 3, 5 | same, and the addon omits quinn's mutex, framing, governor and all IO — every mirror-vs-baseline ratio is a **lower bound**, and every mirror *stall* figure is a **lower bound too** (§1.11) |
| **K18** | ~~Ticket 34's mirror API is a design note plus a microbench addon, not a landed product API.~~ **Superseded by K19 before registration; kept so the ledger shows what changed.** | T34 | superseded |
| **K19** | **M1 is IMPLEMENTED**: `WebTransportServer.sendDatagramMirror(targets: string[], payload)` on `design/mirror-send-01` @ `093e1cde565c199a0b95efe92f5629c2f7597123`. Synchronous, promise-free, non-parking; **failures-only** envelope `{sent, failures[{target,index,error}]}`; native-only, additive, no knob. Cap `DATAGRAM_MIRROR_MAX = 10_000`, and the TS layer **throws `RangeError`** above it rather than chunking | T34 M1 commit + `packages/webtransport/src/datagram-mirror.ts` | landed on a **design branch**, not on `rebind4-staging` |
| **K20** | **M1's cap is a time budget, not a memory budget**: 10,000 is derived from a **1 ms JS-thread stall budget** at the worst measured cost of the shipped `string[]` shape (86 ns/target → ≈ 11,628 targets; 10,000 is the round number under it). The call holds the JS thread for its whole duration and takes quinn's connection mutex **once per target** | M1's own doc comment on `DATAGRAM_MIRROR_MAX` | the derivation's input is K17, whose addon **omits that mutex** |
| **K21** | M1's commit **refactors the single-datagram send path**: `try_send_datagram_for_session` now resolves state and delegates to a new `try_send_datagram_on_state`, which is also the mirror's per-target body. A1 and A2 therefore do **not** run byte-identical native code with and without M1 composed in — behaviour-identical by construction, not binary-identical | `crates/native/src/session.rs` in `093e1cde` | **composition disclosure**, §11 |

**What K16/K17 cost this gate.** They are the provenance ledger's cost entries
and they fix §1.6's emitter-floor arithmetic *before* any run. They are also the
reason §9's P3 can be registered as a falsifiable prediction that the lever will
look **small** here: registering the lever's expected value honestly, in advance,
is the anti-inflation rule.

**What K19–K21 cost this gate.** The mirror arm is **optional by construction**
(§2.3): its presence depends on candidate composition (§11), not on this
document. If A3 does not resolve at dispatch time, G10 runs as a **two-arm**
gate, every clause is unchanged, and §9's P3 is scored `NOT-RUN`. The mirror's
absence never blocks this gate and never weakens a clause.

What K20 *does* change is what this gate is obliged to measure. M1's cap is a
**JS-thread stall budget**, and this gate's fleet is exactly the cap. §1.11
derives that, §3's **C7** turns it into a clause with a bound taken from M1's own
budget, and §6.6 is the instrument. **A gate that ran the mirror arm without
observing the stall would be spending the lever's only real risk and reporting
none of it.**

**What K21 costs this gate.** It forbids one thing outright: comparing an A2
number taken on a two-arm candidate against an A2 number taken on a three-arm
candidate. The composition is fixed once, before the run, and stamped in §12.

**What K11 costs this gate.** A 40.6 ms schedule-lag maximum on an idle Mac is
larger than this gate's entire 20 ms RTT bound (§1.7). §7 V-F therefore makes the
Mac's same-day floor arm a **precondition**, and the clause is on the **raw** RTT
p99 with nothing subtracted (G1's rule).

---

## 1. Scenario arithmetic — every rate on this page, derived here

Nothing below is copied from a measurement. It is the market-data scenario,
worked out. Every constant and every derivation in this section is mechanized in
`tools/load/g10-plan.ts` with unit tests, so the numbers this page claims and the
numbers the harness uses cannot drift apart (the G6 amendment-1 lesson).

### 1.1 Subscriber count: 10,000

A mid-size retail broker's peak concurrent tape audience is order 10⁴. **10,000
is the gate rung and the only rung** — G1 already proved the *count* is holdable
(K1), so a subscriber ladder would re-measure a settled question. The ladder in
this gate is on **message rate**, which is the axis nothing has measured.

All 10,000 subscriber sessions live on the cable Mac (ticket 29's sink contract).
That is not a convenience: §1.8 shows the gate's headline metric is only
computable because every subscriber shares one clock.

### 1.2 The message: one 200 B datagram

A market-data update is a quote or trade record — symbol, bid, ask, sizes, a
venue code, an exchange timestamp and a sequence — roughly **150 B** of real
fields. The instrument (§6.1) adds a **48-byte** stamp. **Payload = 200 B**, the
smallest size that carries a real record and the stamp honestly.

**One message is one datagram.** No splitting, no bundling, no conflation window.
The bundled-feed shape (a tick carrying D instrument updates as one
`sendDatagramBatch` of depth D) is a different product and is registered here as
**NOT COVERED**; no G10 number speaks for it.

### 1.3 The wire, at 200 B — and why this payload changes the gate

Ticket 29 §3's arithmetic, repeated rather than cited so the pre-flight
requirement cannot drift from it:

```
wire bytes per datagram = payload + 8 (UDP) + 20 (IPv4) + 14 (Eth)
                                  + 4 (FCS) + 8 (preamble) + 12 (IFG)
      at 200 B payload  = 266 B = 2,128 bits
      at 1150 B payload = 1,216 B = 9,728 bits      ← G6's figure, for contrast
```

| link | pps ceiling at 200 B | pps ceiling at 1150 B |
|---|---|---|
| 1 GbE | **469,924** | 102,796 |
| 2.5 GbE | 1,174,812 | 256,990 |

**At 200 B a 1 GbE cable carries 4.57× the packet rate it carries at 1150 B.**
That is the R-down arithmetic this gate's payload buys, and it is why G6's live
cable risk (73% wire occupancy) is not this gate's live risk.

### 1.4 The message-rate ladder

Downstream egress is `subscribers × rate`:

| rung | egress pps | 1 GbE occupancy at 200 B | status |
|---|---|---|---|
| R = 1 | 10,000 | 2.13% | runs |
| **R = 5** | **50,000** | **10.64%** | **gate rung** |
| R = 20 | 200,000 | 42.56% | runs, spread clause N/A (§1.6) |
| R = 50 | 500,000 | **106.40%** | **excluded: exceeds the wire** |

**R = 50 does not run.** 500,000 pps is 1.064× a 1 GbE cable's ceiling at this
payload; registering a rung the wire arithmetically forbids is not a gate, it is
a scheduled failure. It is registered as **NOT COVERED (wire-excluded)**, with
the note that a 2.5 GbE path would admit it at 42.6% occupancy. The ticket
offered `1/5/20/50` as an example ladder; the arithmetic on this page is what
decides, and it removes the top rung.

**Why R = 5 is the gate rung.** Retail market-data feeds conflate to a
100–250 ms cadence; **5 Hz (200 ms) is the standard retail conflation rate**, and
10,000 subscribers is the peak audience of §1.1. R = 5 is therefore the product
target, derived from the scenario, not chosen because it looked reachable —
§1.9 shows it sits at 3.07× the highest *valid* stamped egress figure in this
effort and §9 registers that it may miss.

### 1.5 The wire serialization floor — the number that governs this gate

One broadcast is 10,000 datagrams. They cannot arrive faster than the link can
serialize them:

```
10,000 × 2,128 bits ÷ 1e9 bits/s = 21.28 ms
```

> **The first-to-last delivery spread of a 10,000-subscriber broadcast over a
> 1 GbE cable at 200 B cannot be below 21.28 ms. Ever. By arithmetic, before any
> run.**

This is derived here, before data, because it decides two things:

1. It sets the floor every spread number in this gate must be read against.
2. It **rejects a derivation I considered and am recording rather than hiding.**
   A fairness derivation — "the server-side spread must be a minority of typical
   regional path jitter (≈ 10 ms), so ≤ 5 ms" — is *unachievable on this
   hardware by a factor of 4.3*. It is not a bar, it is a hardware statement:
   **sub-5-ms 10k-subscriber fan-out fairness needs ≥ 4.3 GbE at this payload, or
   fewer subscribers per NIC.** That statement is free, it is derivable now, and
   it is the honest thing to publish instead of a bound no run could meet.

### 1.6 The fan-out completion spread bound: 250/R ms

The ticket requires this bound be **derived from the message rate**, and it is:

> A broadcast must complete before the next one begins, with margin. The period
> is `1000/R` ms. A server that spends more than **a quarter** of every period
> fanning out has no period left for ingest, for the probe path, for the
> transport's own queue drain, or for the next tick's arrival — a quarter is the
> margin, and it is registered here, before data.
>
> **Spread bound = 0.25 × 1000/R = 250/R ms.**

| rung | bound | wire floor (§1.5) | headroom | spread clause |
|---|---|---|---|---|
| R = 1 | 250 ms | 21.28 ms | 11.75× | applies |
| **R = 5** | **50 ms** | 21.28 ms | **2.35×** | **applies — the gate clause** |
| R = 20 | 12.5 ms | 21.28 ms | **0.59×** | **NOT APPLICABLE** |

**R = 20's spread clause is arithmetically unsatisfiable and therefore carries no
verdict.** The wire needs 21.28 ms per broadcast and the rate allows 12.5 ms. The
rung still runs — its delivery and RTT clauses are live and informative at 42.6%
wire occupancy — but its spread is published as a **characterization with no
verdict force**, and this is registered now rather than discovered afterwards.
The crossover is `250/R > 21.28` ⟺ `R < 11.75`.

### 1.7 The RTT-proxy bound: 20 ms

**Not G6's 50 ms and not G3/G4's 33.3 ms.** Those are an MMO ability loop and a
30 fps frame. A market-data subscriber's deadline is **quote staleness**:

```
subscriber-perceived quote staleness, p99 target       100 ms
  − internet path RTT (regional, typical)             − 60.0 ms
  − client render of the update (1 frame @ 60 fps)    − 16.7 ms
  ─────────────────────────────────────────────────────────────
  = budget for the whole server-side round trip         23.3 ms
```

100 ms is the point at which a trading UI's tape reads as lagging rather than
live. Rounding the residue down:

> **RTT-proxy p99 bound: 20 ms**, measured probe-send → server → echo →
> probe-receive, on the probe client's single clock, **raw**.

### 1.8 What is measurable across two hosts, and what is not

The server is on the Linux runner; every subscriber is on the Mac. A
server-send-instant differenced against a subscriber-receive-instant spans two
clocks and **cannot be computed** — this is G6's amendment-2 lesson, applied
before it can bite.

Therefore:

- **Broadcast one-way latency is NOT AVAILABLE in this gate.** No G10 number
  claims it.
- **The fan-out completion spread IS available**, because it is
  `max(receiveNs) − min(receiveNs)` over one broadcast sequence number across
  subscribers who all live in one process on one host on one clock. The spread is
  a *difference of two client instants*, so it crosses nothing.

That is the design reason all 10,000 subscribers are on the Mac, and it is why
this gate's headline metric is the spread and not a latency.

**The RTT proxy is a separate, independent loop.** The probe cohort (§1.9) does
not measure its own broadcast copy — a probe at fan-out position 9,999 would be
measuring its queue position, not the server. Each probe sends its own 200 B
stamped datagram at **2 Hz** and the server echoes it to that session on receipt.
`RTT = clientReceive − clientSend`, one clock, and what it answers is: *does the
server still answer anybody while it is fanning out?*

### 1.9 The gate rung's total load, stated plainly

Probe cohort: **100 subscribers of the 10,000**, chosen at fan-out indices
`0, 100, 200, …, 9900` so the cohort spans the fan-out order rather than its
head. All RTT statements are **cohort statements** and say so.

| direction | rate | payload | note |
|---|---|---|---|
| broadcast egress | 50,000/s | 200 B | 10,000 × 5 |
| probe upstream | 200/s | 200 B | 100 × 2 Hz |
| probe echo downstream | 200/s | 200 B | on receipt |
| publisher upstream | 5/s | 200 B | the source tick |
| **server total** | **50,405 datagrams/s** | | 205 in, 50,200 out |

**This is 3.07× the highest valid stamped egress figure in this effort** (K6's
16.3k/s) and 1.42× the verdict-less K4 figure. The settled ~103k/s (K8) is an
*ingest* ceiling and does not license an egress claim. **§9 registers what this
gate predicts, and a miss on a valid run is final.**

### 1.10 The emitter floor, from the provenance ledger

K16/K17, multiplied out at N = 10,000, payload 200 B:

| emitter | ns/target (measured) | per-broadcast floor | as % of the 21.28 ms wire floor |
|---|---|---|---|
| A1/A2 landed `trySendDatagram` | 331 / 334 / 343 | **3.31 – 3.43 ms** | 15.6 – 16.1% |
| **A3 mirror, `string[]` targets — the shape M1 shipped** | 84 – 86 | **0.84 – 0.86 ms** | 4.0% |
| A3 mirror, native group handle — *not shipped*, kept as the arithmetic ceiling | 11 | 0.11 ms | 0.5% |

At 5 Hz the landed emitter spends **1.7% of wall clock** inside the fan-out loop.
The JS crossing is **not** this gate's constraint; the NIC is, by 6.2×. The
largest spread improvement the mirror API could possibly show here is
`3.43 − 0.11 = 3.32 ms`, i.e. **≤ 16% of the wire floor** — and that is a ceiling
on the lever's value at this gate, registered before the run (§9 P3). The ceiling
is computed against the *unshipped* group-handle row on purpose: pairing the
worst landed cell with the best mirror cell flatters the lever as far as the
measurements allow, so a prediction registered against it cannot be accused of
having been set low. **The shape that will actually run is the 84–86 ns row.**

### 1.11 The JS-thread stall budget — why this gate is where M1's cap is tested

K20: M1's cap of 10,000 targets is **a time budget**, derived as
`1 ms ÷ 86 ns/target ≈ 11,628`, rounded down to 10,000. Two facts about this
gate follow, and both are registered here rather than discovered on the day.

**First, this gate's fleet is exactly the cap.** §1.1 fixes 10,000 subscribers;
`DATAGRAM_MIRROR_MAX` is 10,000; the TS wrapper throws `RangeError` above it
instead of chunking. So A3 is **one `sendDatagramMirror` call per broadcast,
sitting exactly on the API's own ceiling** — the largest call the product
permits, five times a second. One subscriber more and A3 would have to become a
chunked arm, which is a different arm measuring a different thing; §2.3 says so.

**Second, the cap's own derivation rests on a microbench that omits the cost the
cap exists to bound.** K17's addon has no quinn connection mutex, no framing, no
byte governor and no IO. The landed mirror takes **quinn's connection mutex once
per target** on the JS thread, inside a call nothing can interrupt. So:

> **0.86 ms is a *lower bound* on M1's JS-thread stall at 10,000 targets, not a
> prediction of it. G10's A3 is the first place the real figure is observable.**

That is the whole reason C7 (§3) exists with a bound of **1 ms**, taken from M1's
own budget rather than invented here: if the real stall exceeds it, the cap is
not conservative, and this gate is the instrument that says so. A gate that ran
the mirror arm and reported only its spread would be spending the lever's only
real risk and measuring none of it.

**What the stall costs the other arms, by arithmetic.** A1 holds the loop for one
whole pass — 3.31–3.43 ms, **3.4× over the budget, by §1.10's arithmetic, before
any run**. A2 holds it for one chunk of 256 targets — `256 × 343 ns = 88 µs`,
**11× inside it**. Those are not predictions about the product, they are
transcriptions of K16, and they are why §3.0 takes this gate's verdict on A2.

---

## 2. Arms

Three emitter arms, **interleaved** (ticket 16's A/B precedent) rather than run
back to back, so a drift in host conditions cannot be read as an arm effect.
Interleave granularity: one arm per 10 s block, round-robin, across a 120 s
window per rung.

### 2.1 A1 — tight per-target loop (the landed emitter, baseline)

For each message, one pass over all 10,000 target sessions calling
`session.sendDatagram(payload)`, no yield inside the pass. On this base that call
takes the promise-free `trySendDatagram` fast path whenever queue budget allows
(K15's default-ON flag), which is the 331–343 ns/target of K16. Minimum spread,
maximum event-loop occupancy: the loop holds the loop for 3.3–3.4 ms, five times
a second.

### 2.2 A2 — chunked per-target loop

The same pass, cut into chunks of **256 targets** with an `await` yield between
chunks. 256 is not a free parameter: it is the datagram-batch machinery's own
chunk size and the exact boundary K14 names as the point above which "one
deadline per call" stops being true. Where a chunk holds more than one pending
datagram for the same target the chunk issues them through `sendDatagramBatch`;
at this gate's depth of one that path degenerates to `sendDatagram`, and **that
degeneracy is registered, not discovered** — A2 differs from A1 in yield
discipline, which is precisely the variable the RTT clause is sensitive to.

A2 is the shape a real server uses, because a server that will not yield for
3.4 ms cannot also be an ingest path. **A2 is the arm the lever is measured
against** (§2.4).

### 2.3 A3 — mirror API (optional lever arm)

One crossing, 10,000 targets, one payload:
`server.sendDatagramMirror(targets, payload)` — ticket 34's M1 as landed (K19).
Synchronous, promise-free, non-parking; the call returns a **failures-only**
envelope `{sent, failures}` and the harness folds it into C5's ledger —
`E_QUEUE_FULL` failures count as `sendWouldBlock`, `E_SESSION_CLOSED` as
`sendErrors`, and neither is retried inside the arm, because a retry would make
A3 a different emitter from A1 and A2.

**The target list is the whole fleet and is built once**, at arm start, in
fan-out index order, and reused for every broadcast. Rebuilding a 10,000-element
`string[]` five times a second would put an allocation in the arm that the arm is
not about. `targets.length === DATAGRAM_MIRROR_MAX` exactly (§1.11): the arm sits
on the API's cap, and if a future fleet exceeded it the wrapper would throw
rather than chunk, making the chunked replacement **a different arm** — registered
as NOT COVERED here.

**This arm is optional by construction.** The harness resolves it at start-up: if
the composed candidate exposes `sendDatagramMirror`, A3 joins the interleave; if
it does not, the gate runs A1 and A2 only, `armsRun` records `["A1","A2"]`, P3
and P8 are scored `NOT-RUN`, and **no clause changes**. Absence degrades the gate
to two arms. It never blocks it. Which composition produced which is stamped in
§12, and K21 forbids comparing an A2 figure across the two.

### 2.4 The anti-inflation rule, stated as an equation

> **The lever's value is `A3 − A2`, never `A3 − A1`, and never `A3` against the
> retired per-target *promise* path.**

K16 records that the promise path was 2,772–3,832 ns/target — 8.7× the landed
emitter. Quoting the mirror against *that* would credit the mirror with a
saving the currently-landed tree already banked. A2 is the honest comparand
because A2 is what a production server would otherwise ship.

---

## 3. Clauses

### 3.0 Which arm carries the verdict

Every clause is computed for every arm at every rung and all of it is published.
But this gate is in the pre-soak all-PASS bar, so it owes a single verdict, and
**a verdict needs a named arm**:

> **The gate's verdict is the clause set at R = 5 on arm A2.**

A2 is the shape a production server ships (§2.2): a server that will not yield
for 3.4 ms cannot also be an ingest path, and §1.11 shows A1 is 3.4× over M1's
own stall budget **by arithmetic, before any run**. Taking the verdict on A1 would
gate the product on an emitter nobody should write; taking it on A3 would gate
the product on a lever that may not be composed in.

This is a **judgment**, registered before data, not a derivation. Its cost is
stated plainly: A1's clause results are a **characterization of the unyielding
baseline** and carry no verdict force, and A3's are the **lever's statement**
(§2.4) and likewise carry none. If A1 or A3 misses a clause that A2 passes, the
gate is a PASS and the miss is published beside it.

### 3.1 The clauses

Evaluated per rung, per arm. Every one is a pure function in
`tools/load/g10-classify.ts` with a unit test that feeds it the failing
signature. **The classifier is not the verdict**: the gate agent recomputes every
clause and every falsifier from the raw artifact fields.

### C1 — fan-out completion spread p99 ≤ 250/R ms

Per broadcast sequence number, on the Mac's clock:
`spread = max(receiveNs) − min(receiveNs)` across the subscribers that received
it. p99 over the messages in the window, compared against `spreadBoundMs(R)`.

**The completeness guard, and why it exists.** A message that reached only half
the fleet would show a *narrower* spread — a delivery failure would read as a
latency success. So:

- The spread is computed **only** over messages whose completeness
  (`received / 10,000`) is ≥ **0.999**.
- The count and fraction of excluded messages is reported.
- If more than **1%** of messages are excluded, C1 publishes **without verdict
  force** (falsifier V-X), because at that point the p99 is a statement about a
  self-selected subset.

Applies at R = 1 and R = 5. **N/A at R = 20** (§1.6), where the same number is
published as a characterization.

### C2 — delivery

- **C2a (fleet)**: aggregate `received / (messages × 10,000)` ≥ **0.999**.
- **C2b (per subscriber)**: the fraction of subscribers whose own delivery ratio
  is ≥ 0.999 must itself be ≥ **0.99**. The worst subscriber's ratio is disclosed
  beside it either way.

C2b exists because a fleet ratio hides the failure mode this scenario actually
has: not "the feed dropped 0.2%" but "these forty subscribers are systematically
behind". The 0.99 tolerance is a judgment — one percent of subscribers absorbing
a per-session transient inside a 120 s window — and it is registered as a
judgment, before data, rather than presented as a derivation.

### C3 — probe-cohort RTT p99 ≤ 20 ms, raw

§1.7. Nothing subtracted. Server dwell (`holdNs`, §6.3) is recorded and reported
beside it and is **never** subtracted from the clause.

### C4 — every subscriber alive at arm end

`sessionsActive == 10,000` at the end of each rung, and no session-lost event in
the window. A broadcast gate that quietly shrinks its own audience is measuring a
smaller fan-out than it claims.

### C5 — the stage ledger closes

Server-side, per rung, per arm:
`broadcastsIssued × 10,000 == sendAttempts`, and
`sendAttempts == sendOk + sendWouldBlock + sendErrors`, with all four published.
Residual tolerance **0.1%** of `sendAttempts` (the effort's standing
`STAGE_RESIDUAL_FRACTION`).

### C6 — the emitter sourced the load

- `emitted / (messages × 10,000)` ≥ **0.99**.
- Emitter lag is measured at the **scheduler handoff** — the interval between a
  broadcast's scheduled deadline and the instant the emitter *begins* the pass —
  and **never across `await send(...)`**. That was G3's defect 1.
- `sendEventsSkipped` and `sendErrors` counted and published separately.

### C7 — the fan-out does not stall the JS thread past 1 ms

Per broadcast, per arm, on the server:

> **`passStallNs` p99 ≤ 1 ms**, where `passStallNs` is the **longest
> uninterrupted span the emitter held the JS thread** during that broadcast —
> A1: the whole pass; A2: the largest single chunk; A3: the single
> `sendDatagramMirror` call.

**The bound is not invented here.** It is M1's own budget, the number the mirror
API's 10,000-target cap was derived from (K20). Registering any other figure
would be this gate marking its own homework: if the product says a mirror call is
sized to stall the loop for at most a millisecond, the gate's job is to hold it
to that sentence, at exactly the target count the cap allows.

`loopLagP99Ms` (§6.6b) is reported beside C7 and is **never substituted for it**.
The two instruments answer different questions — one is what the emitter did, the
other is what the loop felt — and a gate that reported only the second could not
tell an emitter stall from a GC pause.

**Registered consequences, before data:**

- **A1 is expected to FAIL C7** at 3.31–3.43 ms (§1.10 arithmetic). That is not a
  discovery, it is the reason §3.0 does not take the verdict on A1, and it is
  scored as P9.
- **A2 is expected to PASS with ~11× margin** (88 µs per 256-target chunk).
- **A3 is the open question.** Its microbench floor is 0.86 ms against a 1 ms
  bound — 14% margin — and that floor omits the connection mutex (§1.11). C7 on
  A3 is the measurement this gate exists to add to ticket 34, and P8 registers
  the direction.

---

## 4. What G10 is *not*

- **Not a subscriber-count gate.** G1 settled the count (K1). The ladder here is
  on rate.
- **Not a bundled-feed gate.** One message = one 200 B datagram (§1.2). A
  depth-D `sendDatagramBatch` feed is NOT COVERED.
- **Not a broadcast one-way latency gate.** Two hosts, two clocks (§1.8). NOT
  AVAILABLE.
- **Not a conflation-window study.** No arm delays a message to make a batch.
- **Not an R = 50 gate.** Wire-excluded (§1.4).
- **Not a churn or reconnect gate.** That is G9.
- **Not a claim about 2.5 GbE.** Every ceiling on this page is computed at both
  link speeds, but only the negotiated speed the pre-flight artifact records is
  spoken for.

---

## 5. The aligned impulse is the point, not an accident

A broadcast is an aligned egress impulse **by nature**. G6 deliberately spread
its emitter across a 20 ms slice grid because a real realm server slices its
player list; a market-data server has no such freedom — the tick exists at one
instant and every subscriber is owed it.

So where T02 (K2) found the kernel's **ingress** impulse knee below 5,000
packets, this gate measures the **egress** impulse of exactly 10,000 packets,
five times a second, through a real NIC. **That is registered here as the
measured case, on purpose.** No G10 arm spreads the fan-out across a grid; a
spread emitter would be a different product and is NOT COVERED.

Two consequences registered before the run:

1. The 21.28 ms wire floor (§1.5) *is* the impulse being serialized. The spread
   number this gate produces is, in large part, a direct measurement of that
   serialization plus whatever the server and the sink add on top.
2. K2's mechanism has an egress mirror — the runner's own transmit queue, and the
   Mac's receive path taking 10,000 packets in 21 ms. §7 V-SP exists to bound how
   much of the observed spread belongs to the sink rather than to the server.

---

## 6. Instruments

### 6.1 The stamp — version 4

`tools/load/latency-stamp.ts` and `crates/reference/src/latency_probe.rs` gain a
version 4, additively. v1–v3 keep decoding exactly as today.

| offset | size | field |
|---|---|---|
| 0 | 2 | magic `0x4C54` |
| 2 | 2 | version |
| 4 | 8 | intended send, ns |
| 12 | 8 | actual send, ns |
| 20 | 8 | sequence — **the broadcast sequence number** for `BROADCAST` |
| 28 | 8 | echo actual, ns (v2+) |
| 36 | 8 | `holdNs` — server dwell, a duration (v3) |
| 44 | 1 | `class` (v3) |
| 45 | 1 | **`arm` (v4): 1 = A1, 2 = A2, 3 = A3** |
| 46 | 2 | reserved, zero |

`STAMP_BYTES_V4 = 48` — unchanged, the arm byte comes out of the v3 reserved
field, so the 200 B payload arithmetic in §1.2 does not move.

Classes used here: `BROADCAST = 6`, `PROBE = 7`, `PROBE_ECHO = 8`
(amendment 1, §11c — the original text assigned 5/6/7, but 5 was already
`CLASS_RAID_JOIN`).

**The arm byte is what makes the interleave readable.** Every broadcast datagram
carries the arm that emitted it, so the Mac attributes each message's spread to
an arm without trusting wall-clock block boundaries.

### 6.2 Spread

Computed on the Mac, per sequence number, as `max(receiveNs) − min(receiveNs)`
across receiving subscribers, recorded into the shared log-linear histogram
(`subBits = 8`, ≤ 0.4% relative error) so every percentile in this gate is
computed by identical arithmetic. Completeness per sequence number is counted
alongside (§C1).

### 6.3 RTT and dwell

`RTT = probeReceiveNs − probeSendNs`, both from the probe client's
`CLOCK_MONOTONIC`. `holdNs = serverSendNs − serverReceiveNs` on the echo path,
a duration measured entirely on the server, so it crosses hosts safely. Reported
beside C3, never subtracted from it.

### 6.4 Generator honesty

Probe `scheduleLag` (actual send − nearest scheduled deadline) recorded on the
Mac over the same window and reported beside every latency percentile. The floor
arm is §7 V-F.

### 6.5 Emitter honesty

§C6. Scheduler-handoff lag only.

### 6.6 The JS-thread stall — two independent instruments

Both live on the **server**, both are durations measured entirely on the server's
`CLOCK_MONOTONIC`, so neither crosses a host boundary.

**6.6a — `passStallNs`, what the emitter did.** `process.hrtime.bigint()` taken
immediately before and after the **synchronous span** of the fan-out, recorded
into the shared log-linear histogram per arm:

| arm | the span | expected, from §1.10 |
|---|---|---|
| A1 | the whole 10,000-target pass | 3.31 – 3.43 ms |
| A2 | each 256-target chunk, one sample per chunk, **max per broadcast** also recorded | ≈ 88 µs |
| A3 | the one `sendDatagramMirror(targets, payload)` call | ≥ 0.86 ms (a lower bound, §1.11) |

The clause reads the **per-broadcast maximum** span, so A2 is judged on its worst
chunk rather than on an average that its own yields would flatter.

**6.6b — `loopLagNs`, what the loop felt.** An independent sampler on the
server's event loop, armed with `setTimeout(…, 5)` and re-armed from inside its
own callback, recording `actualNs − scheduledNs` per tick into its own histogram.
Period **5 ms**, chosen as one quarter of the RTT bound so a stall the RTT clause
would care about cannot hide between two samples. It is a **disclosure**, not a
clause: it sees GC and native callbacks that 6.6a cannot, and it aliases stalls
shorter than its period, which is exactly why it is not the thing C7 reads.

The sampler's own liveness is falsifiable: **V-L** (§7) fires if it recorded
fewer than 90% of the ticks its period and window imply, because a sampler that
was itself starved reports percentiles over a self-selected subset — the same
defect V-D exists for.

---

## 7. Validity falsifiers — the run is INVALID if any fires

A falsifier firing is a **harness/infra fault** under spec §Rerun policy, not a
gate miss. Every one is a pure function in `tools/load/g10-classify.ts` with a
unit test that feeds it the failing signature — because G3b's V1 lived only in a
hand derivation until it was too late.

| id | fires when | why it exists |
|---|---|---|
| **V-C** cable | No same-day pre-flight artifact, **or** `evaluatePreflight` fails either registered requirement (§8) | Ticket 29's STOP template |
| **V-M** Mac sessions | The Mac cannot establish and hold **10,000** concurrent subscriber sessions in a same-day pre-check | G1 proved 10k on the *runner*. The Mac holding 10k client sessions is **unproven** and is this gate's most likely blocker |
| **V-S** sink | Mac sink pre-check fails: cannot sustain **1.5 × 50,000 = 75,000 pps** at 200 B at ≥ 0.995 delivery, on **Mac loopback** | K12 says nothing prior predicts the Mac's sink capability |
| **V-SP** spread floor | Mac **loopback** broadcast spread p99 at R = 5 exceeds **4.26 ms** (20% of the 21.28 ms wire floor), or the floor arm was not taken the same day | §5(2). Without it, the Mac's own receive-order dispersion is indistinguishable from the server's fan-out. Strips verdict force from **C1 only** |
| **V-F** probe floor | Mac floor-arm `scheduleLag` p99 > **2 ms** (10% of the 20 ms bound), or not taken the same day, or the wrong host | K11 |
| **V-N** negatives | **Any** spread or RTT histogram reports `negative > 0` | Both ends of every measurement here are on one clock; a negative means the instrument is wrong |
| **V-K** skew | `recordedTotal − count > 0.1%` of `count` on any histogram the gate reads | G3b's second defect |
| **V-D** denominator | Any percentile computed over fewer samples than the run's own counters say were delivered on that path | The same defect as an equality the artifact must satisfy |
| **V-X** completeness | More than **1%** of messages excluded from C1 by the completeness guard | §C1. Strips verdict force from **C1 only** |
| **V-G** generator | Probe `offeredRatio` < **0.99** at any measured rung | The Mac is a new generator host |
| **V-A** arm comparability | Probe `scheduleLag` p99 spread across arms > **2×**, or emitter scheduler-handoff lag p99 spread across arms > **2×** | K5, exactly. Strips force from **arm comparisons** (§2.4, P3, P4) only; the per-arm absolute clauses stand |
| **V-L** loop sampler | The event-loop lag sampler (§6.6b) recorded fewer than **90%** of the ticks its 5 ms period and the arm window imply | A sampler that was itself starved reports percentiles over a self-selected subset. Strips force from the **`loopLagP99Ms` disclosure only** — never from C7, which reads a different instrument |

**V-SP, V-X, V-A and V-L do not kill the run.** Each strips verdict force from a
named statement and says so in the artifact. Every other falsifier invalidates
the run.

**None of these are computed by reading a boolean out of the classifier.**

---

## 8. The cable STOP — registered requirements

The gate run is **INVALID** unless a pre-flight artifact from **the same calendar
day**, produced by `tools/offbox/preflight.ts`, satisfies **both** requirements
below via `evaluatePreflight(artifact, requirement)` from
`tools/offbox/preflight-lib.ts`:

| requirement | offeredPps | payloadBytes | maxLossPct | minMtuBytes | maxIdleRttP99Ms |
|---|---|---|---|---|---|
| **R-down** | 50,000 | 200 | 0.1 | 1280 | 2 |
| **R-up** | 205 | 200 | 0.1 | 1280 | 2 |

- **0.1% loss** is derived: C2a allows 0.1% end-to-end loss and the link may
  contribute at most a fifth of it — so the link bound is 0.02%. **0.1% is
  deliberately the looser figure**, kept at the effort's standing value, and the
  gap is disclosed here rather than papered over: a link at exactly 0.1% loss
  would consume C2a's entire budget on its own. If R-down comes back between
  0.02% and 0.1%, the run may proceed and **C2a's result is reported with the
  link's loss printed beside it**.
- **MTU 1280** is QUIC's minimum.
- **Idle RTT p99 ≤ 2 ms** = 10% of the 20 ms bound (§1.7). Tighter than G6's
  5 ms because this gate's budget is tighter.

**K9 is *not* the live risk here**, unlike G6. R-down is 10.64% of a 1 GbE wire
at this payload (§1.4). **The live risks are V-M and V-S** — the Mac holding
10,000 sessions, and the Mac's sink taking 75,000 pps. The negotiated link speed
is still recorded in the artifact, and if it negotiates below 1 GbE the ladder is
re-derived against the observed speed **before** the run, with the amendment
recorded under §11.

---

## 9. Registered predictions

Falsifiable, written before any data. Scored in the stamp, one by one.

1. **P1** — The cable is **not** the binding pre-flight requirement. If anything
   stops this gate it is **V-M** (the Mac holding 10,000 sessions) or **V-S** (the
   Mac's sink at 75,000 pps), not R-down.
2. **P2** — At the gate rung R = 5, arm A2's C1 spread p99 lands **between
   21.28 ms and 50 ms** — above the wire floor, inside the bound — i.e. C1
   **PASSES with less than 2.35× headroom**.
3. **P3** — The lever is **small here**: `A3 − A2` spread p99 improvement is
   **≤ 4 ms**, i.e. ≤ 20% of the wire floor, because the mirror API saves a
   3.3 ms crossing behind a 21.3 ms NIC (§1.10). If A3 does not run, this scores
   `NOT-RUN`, not `PASS`.
4. **P4** — A1's C3 RTT p99 is **worse than A2's by ≥ 2 ms**, because an
   unyielding 3.4 ms loop five times a second delays the probe echo path. This is
   the arm difference that matters at this gate, and it is not the one the lever
   is about.
5. **P5** — **C2b misses before C2a does.** The per-subscriber floor is the clause
   this scenario's real failure mode trips first.
6. **P6** — R = 20 holds C2a (42.6% wire occupancy is not a delivery problem) and
   its spread p99 lands **above 12.5 ms**, confirming §1.6's arithmetic — with no
   verdict either way.
7. **P7** — V-A does **not** fire, because the arms are interleaved at 10 s
   granularity rather than run as separate blocks (K5's defect).
8. **P8** — **A3's `passStallNs` p99 is at least 2× its 0.86 ms microbench
   floor**, because K17's addon omits quinn's connection mutex, which the landed
   mirror takes once per target (§1.11). If A3 does not run, `NOT-RUN`.
   P8 is deliberately a prediction about the *instrument's own input* rather than
   about the product: it is the claim that a microbench with no mutex in it
   cannot price a call whose cost is mutexes.
9. **P9** — **A1 FAILS C7** at 3.31–3.43 ms against the 1 ms bound. This is
   §1.10's arithmetic, restated as a falsifiable claim so that a *pass* would be
   as informative as a miss: A1 passing C7 would mean K16's per-target cost does
   not reproduce on the runner, and §11d's instrument validation would be the
   first thing to re-examine.
10. **P10** — **C7 does not decide this gate.** A2 passes C7 with margin, so the
    stall instrument's contribution is to the *lever's* statement (A3) and to
    A1's characterization, not to the verdict. If C7 turns out to be the clause
    A2 misses, the derivation in §1.11 was wrong about the shipped chunk size and
    that is the finding, not a re-derivation.

---

## 10. Rerun, amendment and honesty rules

- **One complete run stamps.** A rerun requires a declared, logged harness/infra
  fault. A miss on a valid run is **final** and routes to its mechanism ticket.
- **No threshold in this document moves after data exists.** Amendments before
  the first dispatch quote the original text in full and say what changed and
  why. There are no amendments after the first dispatch.
- **A third registration is not available** (G3b precedent).
- Every dispatch is logged in §12, **including aborted ones**. A run not in that
  table did not happen.
- The classifier is not the verdict.
- **Local macOS smoke output is never a result** (standing rule). The unit-test
  runs recorded in §11d are validation of the *instrument*, not of the product.

---

## 11. Candidate composition

Candidate = `probe/g10-broadcast-01` at the SHA recorded in §12, whose merge-base
with `rebind4-staging` must equal the base SHA in the header. The candidate is
never merged back. Candidate SHAs come from `git rev-parse` / `git ls-remote`
only.

**If `rebind4-staging` has moved past `2a4145d0…` at dispatch time:** the base is
re-derived, this header is amended *before* the dispatch with the old SHA quoted,
and the diff between the two staging SHAs is inspected for anything touching the
datagram send path, the batch path, or the mirror entry point.

### 11.1 Composing the mirror arm — the three options, ranked, before the run

M1 exists (K19) but lives on `design/mirror-send-01` @ `093e1cde565c`, **not on
`rebind4-staging`**. A3 therefore needs a composition decision, and it is made
here rather than on the day. Exactly one option is taken, and §12 records which.

**Option A — preferred. M1 lands on staging first.**
`design/mirror-send-01` is merged into `rebind4-staging` under the normal landing
rules (spec §Process rules: knob-OFF, suites green, one revertable series). The
candidate is then this probe branch rebased onto that staging SHA, per the
standing composition rule. This is the only option in which the candidate is a
tree the project actually ships, and it is the only one that needs no disclosure
beyond the SHAs.

**Option B — fallback. Cherry-pick onto the probe branch.**
`093e1cde565c` is cherry-picked onto `probe/g10-broadcast-01` and the result is
the candidate. Permitted, and **disclosed as a deviation**: the candidate then
carries a commit that is on no shipping branch. §12 records *both* SHAs and the
cherry-pick's own SHA. The A2 result from an Option-B run is still a valid A2
result — but K21 means it is **not** the same binary as an Option-A A2, and the
two are never quoted against each other.

**Option C — the mirror does not run.** Neither A nor B is available at dispatch
time. The gate runs A1 and A2, `armsRun = ["A1","A2"]`, P3 and P8 score
`NOT-RUN`, and every clause is unchanged (§2.3). **This is a complete G10 run**,
not a partial one: the gate's verdict arm is A2 (§3.0), and A2 exists in every
option.

**What is forbidden in all three:** running some rungs on one composition and
some on another; re-running a rung after changing composition and reporting the
better number; and quoting A2 across compositions. One composition, one run, one
stamp.

The composition also decides C7's reach. Under Option C the stall instrument
still runs and still produces A1's and A2's numbers — §1.11's obligation to
*measure* the stall is not conditional on the mirror. Only P8 is.

### 11.2 The composition that was taken — Option A, recorded

**Option A.** `design/mirror-send-01` landed on `rebind4-staging` as
`9c475df1e255388abf4a07733164869f6377e0b7` (the merge of `093e1cde565c`), and
this branch was rebased onto it. No cherry-pick, no commit on a non-shipping
branch, and nothing to disclose beyond the SHAs below.

| | SHA |
|---|---|
| staging base **before** | `2a4145d0556a35f8b4a0849e5953927b5e028b64` |
| staging base **after** (composed base) | `9c475df1e255388abf4a07733164869f6377e0b7` |
| candidate **before** rebase | `574fbd9c09a876d41f6ce232a7a7b5dca3b65325` |
| candidate **after** rebase | *from `git rev-parse` at dispatch; §12 records it* |

The rebase replayed four commits with no conflicts and no content change. The
pre-rebase head is named here so the tree that existed before composition stays
reachable by SHA rather than only by reflog.

**§11's own inspection requirement, discharged.** The diff between the two
staging SHAs was read for anything touching the datagram send path, the batch
path or the mirror entry point. It touches all three: `crates/native/session.rs`
(+65/−14), `session_registry.rs`, the new `datagram_mirror.rs`, and
`packages/webtransport/src/index.ts` (+61). That is K21 exactly — M1's commit
refactors the single-datagram send path A1 and A2 themselves take — and it is
the reason §11.1 forbids quoting an A2 number across compositions. Every arm in
this run is measured on this one tree.

**What A3 stops being.** Under Option A the mirror is present in every
candidate, so `resolveArms` will never drop A3 on a real dispatch. The
degradation path §2.3 registers is therefore exercised by a harness affordance
(`G10_HIDE_MIRROR=1`, §11d) rather than by the composition, and remains the
behaviour on a candidate that does not expose the entry point.

## 11a. Dispatch plan — gated on the cable pre-flight artifact

Nothing below runs until step 0 produces a green artifact. **No green same-day
pre-flight at this gate's rates → no run.** That is the STOP, not a guideline.

**Step 0 — cable day, on the Mac** (`docs/research/runbooks/mac-generator-cable.md`,
ticket 29):

```
bun tools/offbox/preflight.ts --peer <runner bench IP> --payload-bytes 200 \
    --out .bench-evidence/g10-preflight-<date>.json
```

Then, off-runner, evaluate **both** §8 requirements with
`evaluatePreflight(artifact, requirement)` using `preflightRequirements()` from
`tools/load/g10-plan.ts`. Record the negotiated link speed. **If R-down fails,
stop and report; do not substitute a lower rung, a loopback path, or the loadgen
VM.**

**Step 0b — the four same-day pre-checks on the Mac**, all required, all
evaluated by §7:

| pre-check | what it drives | falsifier |
|---|---|---|
| session capacity | 10,000 subscriber sessions established and held 60 s | V-M |
| sink | Mac loopback, 75,000 pps at 200 B into the subscriber shape, delivery ≥ 0.995 | V-S |
| spread floor | Mac loopback, 10,000 sessions, R = 5 broadcast, spread p99 ≤ 4.26 ms | V-SP |
| probe floor | probe role at a trivial rate, `--sessions 20`, `scheduleLag` p99 ≤ 2 ms, **max disclosed** | V-F |

**Step 1 — one dispatch**, `bench-bandwidth` workflow, ref `probe/g10-broadcast-01`:

| input | value |
|---|---|
| `candidate_commit` | the branch SHA from `git rev-parse`, never typed |
| `mode` | `g10-broadcast` |
| `g10_rate_ladder` | `1,5,20` |
| `g10_arms` | `A1,A2,A3` under composition option A or B; `A1,A2` under option C (§11.1). The conductor resolves `sendDatagramMirror` at start-up and **drops A3 with a logged warning if the input asks for an arm the candidate does not expose** — it never fails the run over it |
| `g10_window_seconds` | `120` |
| `g10_offbox_ssh` | the Mac's ssh destination — **empty is a wiring check, never a G10 result** |
| `g10_server_address` | the runner's bench-subnet address |

`candidate_commit` is also what the workflow now passes to the Mac as
`G10_CANDIDATE`: ticket 29's entry script checks that SHA out and builds the
generator from it, and refuses a ref or an abbreviation (exit 3). The conductor
makes the same refusal locally, before it spawns anything.

Expected runner wall clock ≈ 15 min: three rungs × 120 s, plus a
`sessionsActive → 0` drain barrier and a 15 s settle between rungs, plus the
10,000-session establish ramp.

**Step 2 — stamp.** Recompute every clause and every falsifier from the raw
artifact with `g10-classify.ts`, never by reading a boolean out of it. Log the
run in §12 whatever the outcome, including an abort. A miss is final.

**What would make this run invalid before it starts**, in the order checked:
no green same-day pre-flight (V-C) · the Mac cannot hold 10,000 sessions (V-M) ·
no sink pre-check at 1.5× (V-S) · no same-day spread-floor arm (V-SP) · a probe
floor arm from the wrong day, wrong host, or above 2 ms p99 (V-F) ·
`g10_offbox_ssh` empty, which is not a falsifier but is a disqualification.

## 11b. What is built on this branch, and what is not

This section is the branch's own inventory and is updated **by commit, as each
piece lands**, unlike the thresholds above, which do not move (§10). A reader
checking whether this gate may dispatch reads this table, not the commit log.

| piece | what it is | status |
|---|---|---|
| `docs/research/preregistrations/gate-g10-broadcast.md` | this page — registered before any harness code and before the cable was characterized | **committed first, deliberately** |
| `tools/load/g10-plan.ts` (+ test) | every constant and derivation in §1 and §1.11, mechanized | built, validated off-runner (§11d) |
| `tools/load/g10-classify.ts` (+ test) | every clause in §3 and every falsifier in §7 as pure functions | built, validated off-runner |
| `tools/load/g10-emitter.ts` (+ test) | the three arms of §2 over an injected send interface, plus §6.6a's stall instrument — so arm shape, chunk boundary, counters, the optional-mirror resolution and the stall measurement are all testable with no cable and no runner | built, validated off-runner |
| `tools/load/bench-g10.ts` | the runner-side conductor: fleet establish, the interleave, the emitter, the probe echo, §6.6b's loop sampler, the drain barrier, the artifact | built, **smoke-run on macOS only** — and a macOS smoke run is never a result (§10) |
| `.github/workflows/bench-bandwidth.yml` `mode: g10-broadcast` | the dispatch surface of §11a step 1 | built |
| `tools/load/latency-stamp.ts` v4 (+ test) | §6.1's arm byte out of v3's reserved field — still 48 B — plus classes `BROADCAST`/`PROBE`/`PROBE_ECHO`, additively: v1–v3 decode exactly as before | built, validated off-runner |
| `tools/load/latency-histogram.ts` | the shared log-linear histogram every percentile in this gate is computed by, unchanged from the gate that introduced it | vendored onto this branch |
| `crates/reference/src/broadcast_client.rs` | the Rust subscriber role the Mac runs: 10,000 sessions, per-sequence receive stamps, the probe cohort's own loop, the spread histogram, the v4 stamp's reader | built, validated off-runner (§11d) — **exercised end to end** against the conductor over loopback |
| `crates/reference/src/latency_probe.rs` v4 | the Rust half of the stamp — the arm byte on the subscriber's side, `ARM_NONE = 0` guarding a version-3 payload out of A1's samples | built, validated off-runner |
| `tools/load/g10-offbox.ts` (+ test) | the ssh invocation, with every refusal `mac-generator-entry.sh` makes mirrored as a check performed *before* the spawn | built, validated off-runner |
| `tools/offbox/preflight.ts` + `preflight-lib.ts` | ticket 29's cable pre-flight, which §8's STOP calls | **NOT ON THIS BRANCH** — it lives on `prep/mac-generator-01` and arrives with ticket 29's landing |
| `tools/offbox/mac-generator-entry.sh` `--bin` | the entry script hard-codes `load-client`; G10's far end is `broadcast-client` | **NOT ON THIS BRANCH, AND NOT YET IN THE CONTRACT** — ticket 29 owes the flag. The conductor emits `--bin broadcast-client` and today's script rejects it as an unknown argument (exit 3), which is deliberate: omitting it would build and run the *wrong binary* on the Mac |

**No part of this gate dispatches while any row above says NOT BUILT or NOT ON
THIS BRANCH.** Both remaining rows belong to ticket 29 and land with it: the
pre-flight §8's STOP calls, and the one-flag extension the entry script needs to
run a binary other than `load-client`.

**Three defects the Rust half found in the conductor**, recorded because they
were all invisible to a harness with no far end:

1. **C4 read its sessions after the fleet had already gone.** `sessionsActive`
   was sampled after `await pumped`, which resolves when the subscriber process
   *exits*. The clause would have read ~0 and failed on every valid run. The
   snapshot now happens immediately after the emitter stops, which is what "at
   arm end" means.
2. **V-N, V-K, V-D and V-G were computed over nothing that mattered.** The only
   histogram the conductor fed them was its own stall histogram — the spread,
   the RTT and the probe lag, all of which are computed on the Mac and all of
   which this gate takes percentiles from, had no denominator check at all, and
   V-G had no offered ratio to read. All four now read the far end's fragments.
3. **Probe echoes taken while nothing was emitting were attributed to the last
   arm.** The probe grid runs through the establish ramp and the drain grace, so
   whichever arm was last collected a block of RTT and lag samples measured
   under *no broadcast load* — and V-A compares that lag percentile across arms.
   In an 18 s three-arm smoke it was 490 of 1,345 echoes, all on A3, whose
   `probeEchoes` read 744 against A1's 310. The server now stamps `ARM_NONE`
   whenever no arm is emitting, and the count of unattributed echoes is
   disclosed rather than merely excluded.

**C2b is divided on the runner, not on the Mac.** The subscriber role reports the
*distribution* of per-subscriber receive counts and never a ratio, because it
cannot know how many broadcasts it failed to receive; the emitter's own
`broadcastsIssued` is the denominator. `messagesIssued` is absent from its report
by design, so the conductor cannot accidentally use a self-flattering one.

## 11c. Amendment log

**Amendment 1 (2026-08-19, before first dispatch — legal under §10).** §6.1's
class-id line originally read, in full: *"Classes used here: `BROADCAST = 5`,
`PROBE = 6`, `PROBE_ECHO = 7`."* It now reads 6/7/8. Why: class 5 was already
`CLASS_RAID_JOIN` in the landed `tools/load/latency-stamp.ts`, and both halves
of stamp v4 — the TS conductor and the Rust `broadcast_client` — were built
against the code's 6/7/8, because the wire is what the two ends must agree on.
Nothing scored reads a class id; no threshold moves. The prose is corrected to
match the wire rather than the wire quietly diverging from the registration.

Otherwise none: this document's first commit is its registration, and every
threshold on this page was fixed in that commit. Two things are worth naming so a later
reader does not mistake them for silent edits:

- **K18 was superseded before registration, not amended after it.** Its original
  claim — that M1 was a design note rather than a landed API — stopped being true
  while this page was being written, and K19–K21 replace it. The struck row stays
  in the ledger so the change is visible rather than tidy.
- **§11b is an inventory, not a threshold**, and it moves as pieces land. §10's
  no-movement rule binds §1 through §9, which are what a run is scored against.

## 11d. Instrument validation — off-runner, and what it does and does not prove

Run on the maintainer's macOS arm64 box, before the first dispatch:

| command | outcome |
|---|---|
| `bun test tools/load/` | 232 pass, 0 fail |
| `cargo test -p reference` | 43 pass, 0 fail |
| `cargo clippy -p reference --all-targets` | clean |
| `bun run typecheck` | clean |
| `bunx biome check tools/load/g10-*.ts tools/load/bench-g10.ts tools/load/latency-stamp*.ts` | clean |

The smoke was run in **three arms**, because after composition option A the
mirror is always present and one invocation can no longer reach every path.
All three used `G10_SMOKE=1 G10_SMOKE_FLEET=24 G10_RATE_LADDER=5
G10_ARMS=A1,A2,A3 G10_BLOCK_MS=3000` so that six 3 s blocks fit inside the
window and every arm actually emits — the earlier 8 s/10 s-block smoke gave
every broadcast to A1 and reported the other arms as zero.

| smoke | what it reaches | outcome |
|---|---|---|
| **1 — mirror present** | `G10_WINDOW_SECONDS=18` | three arms ran; A3 issued 30 broadcasts through `sendDatagramMirror`; `mirrorStall` measured 1.399 ms against the 0.002 ms mutex-free microbench floor — P8's ≥ 2× would have held at 677× on a laptop |
| **2 — option C** | `G10_HIDE_MIRROR=1 G10_WINDOW_SECONDS=12` | `armsRun = ["A1","A2"]`, `armsDropped = ["A3"]`, the registered §2.3 warning in the artifact, the run continued, P3 and P8 scored `NOT-RUN` |
| **3 — the Rust fleet** | `G10_SMOKE_RUST=1 G10_WINDOW_SECONDS=18` | `broadcast-client` at the far end over loopback: 24/24 sessions, 0 undecodable, 0 sequence overflow, 0 unattributed copies, `offeredRatio` 1.0, all three arms' spread/RTT/probe-lag histograms present with `negative` 0 and `count == recordedTotal`; V-N, V-K, V-D and V-G all computed and none fired; V-A and V-L fired, as a co-resident laptop should make them |

**Two of those smokes exist only because of a harness affordance**, and both are
named in the code: `G10_HIDE_MIRROR=1` simulates a candidate with no mirror
entry point, and `G10_SMOKE_RUST=1` puts the real subscriber binary at the far
end of a loopback smoke. Neither changes anything a run is scored against; the
first makes option C testable now that composition A has made it unreachable,
and the second is the only way the two halves of the v4 stamp meet before the
cable does.

**What the smoke proves.** That the conductor's wiring works: arm resolution,
the interleave, the deadline-aimed emitter, the stamp, the probe echo path, the
per-arm ledger, both stall instruments, the falsifiers and the artifact — and
now also that the Rust subscriber role speaks the same wire and produces the
report shape the conductor parses. Nothing else.

**What it does not prove, and this is the larger half.** No number it printed is
a result — the fleet was 24 rather than 10,000, the subscribers were co-resident
with the emitter and shared its event loop, there was no cable, and macOS is not
the runner. **Local macOS smoke output is never a result** (§10), and the
artifact it writes carries that sentence in a field so a stray copy cannot be
mistaken for one.

**Five defects the smoke caught**, recorded because a passing smoke that found
nothing would have been the less useful outcome. The first two came from the
conductor's own first run; the last three needed a real far end and are written
up in §11b:

1. Clauses **C2b and C6 were never evaluated** by the conductor. Every other
   clause was, so the artifact looked complete. A gate can only miss a clause it
   computes.
2. The emitter polled at a quarter of the message period instead of aiming a
   timer at each deadline, manufacturing **46 ms of scheduler-handoff lag** out
   of its own poll granularity. C6 reads that lag and V-A compares it across
   arms; the instrument would have been reporting itself. Deadline-aimed
   re-arming brought it to 2–4 ms on an unquiesced laptop.
3. **C4 sampled `sessionsActive` after the fleet had exited** — a clause that
   would have failed on every valid run (§11b).
4. **Four falsifiers read only the server's own histogram**, leaving the spread,
   the RTT and the probe lag with no denominator check and V-G with no offered
   ratio (§11b).
5. **Probe echoes from the ramp and the drain were attributed to the last arm**,
   handing it hundreds of samples measured under no broadcast load — the exact
   percentile V-A compares across arms (§11b).

## 12. Dispatch log

Every dispatch of this gate, including aborted ones. A run not in this table did
not happen.

| # | date | run id | candidate SHA | staging base | pre-flight artifact + date | rungs | arms | outcome |
|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | *no dispatch yet* |

## 13. Verdict

*(empty — no run)*
