# Pre-registration — Gate G11: bidirectional streams (proxy / tunnel workloads)

Ticket: `.scratch/production-grade-scenarios/issues/36-gate-g11-bidi-proxy.md`
Branch: `probe/g11-bidi-01`
Staging base at writing: `2a4145d0556a35f8b4a0849e5953927b5e028b64`
Status: **registered, unrun, no candidate composed, nothing dispatched.**

This document is written **before** any G11 harness code exists. Every threshold
below is derived on this page from scenario arithmetic, from a prior stamp whose
verdict status is named in §0, or from a shipped constant read out of the source
tree. Nothing here is derived from a G11 run, because there has been none.

---

## §0 — Provenance ledger (known results, with verdict status attached)

A bar derived from an INVALID run is not derived from anything. Every quantity
this registration leans on is listed with the status of the thing it came from.

| # | fact | status | what it licenses here |
|---|---|---|---|
| K1 | G1: 10,000 sessions @ 0.2 pps, delivery 1.000, ingest p99 2.9 ms, staggered arrival only | **PASS** | session counts up to 10k are established on this rig; connects must be staggered |
| K2 | T02: synchronized arrival ⇒ kernel rcvbuf drops; knee ~5–6k packets/impulse | **CONFIRMED** | the connect ramp in every arm here is staggered, and the reason is on record |
| K3 | G2: 10k datagrams/s at shipped default, p99 5.14 ms; honest co-resident generator ceiling between 10k and 15k | **INCOMPLETE-ON-THIS-RIG** | a datagram-axis figure; it does not bound stream frames, and no player/user count is borrowed from it |
| K4 | G3 camera egress, rung numbers 35.2k @ p99 2.52 ms | **INCOMPLETE (published verdict-less)** | nothing |
| K5 | G3b three-arm origination comparison | **INVALID (V1 fired)** | **nothing at all**, including its emitter and alignment-cost readings |
| K6 | G4: 1→50 forward, p99 10.35 ms, delivery 1.000, ~6.3 µs per-target send | **PASS** | that per-target datagram send cost; not a stream cost |
| K7 | G5 phase 1: 3.96 Gbps saturated observation | **NO-VERDICT** | nothing; raises no bound |
| K8 | G5b: **1.250 Gbps delivered** client→server over uni streams, 2 × 60 s, knob 65536, shipped governors, 46.2 KB/crossing, host CPU median 48.8%, server CPU 108–119% of one core, RSS 98 MB, zero drops. Knob **off** at the same offer: **0.870 Gbps**, **1,388 B/crossing**, **73,301 crossings/s**, host **71.1%**, server **2,437 CPU-ms/Gbit** (910 knob-on) | **PASS** | the only stamped stream-path cost figures that exist; every CPU expectation in §7 is scaled from the knob-off row and labelled as an expectation |
| K9 | ~103k datagrams/s on-box ceiling | closed attribution | a datagram-axis ceiling; not a bound on stream frames/s |
| K10 | Window decision DECOUPLE, landed knob-OFF; shipped per-session worst case 6,291,904 B = 1.46× the rig at `maxSessions` 2000 | landed | the memory statement in §5 clause C8 |
| K11 | **Server→client bulk over streams has no stamped number.** G7 (ticket 31) is designed-but-unrun | **UNMEASURED** | the downstream direction of this gate has **no prior**. Every downstream expectation here is scaled from the *ingest* side and is labelled as such wherever it appears |
| K12 | Stream chunk batching (T07) landed knob-OFF; measured by G5b on **server-receive of uni streams only** | landed, partially measured | **bidi behaviour and client-receive behaviour are unmeasured**; this gate's instrument records both, and clause C9 grades nothing about them |
| K13 | Send-batch (T05) is a **datagram** lever. There is **no stream send-side batching**: one N-API crossing per `write()` (`packages/webtransport/src/streams.ts:156` → `crates/native/src/client_stream.rs:1602`) | landed / absent by design | the write-crossing term in §1.4 is one crossing per frame, by construction, not by assumption |
| K14 | Ticket 23's RESET-swallow fix lives in `read_deferred_direct_batch`, the knob-ON read path | open | composition waits on 23; the **gate cell is knob-OFF**, so the defect touches only the disclosure cell — that is a reason to sequence, not a reason to relax |
| K15 | `WEBTRANSPORT_DATAGRAM_SEND_SYNC` default is an open maintainer ruling | open | recorded so a reversal is known **not** to touch this gate: G11 sends no datagrams on any arm |
| K16 | Local macOS bench/soak numbers are never results | permanent gotcha | the local smokes in this branch are wiring checks and are labelled so |
| K17 | **A bidi handle owns ONE `StreamBudget`, charged by both directions.** `ClientBidiStreamHandle.budget` (`client_stream.rs:1014`) is read by the write path (`client_stream.rs:1602`) and by both deferred read paths (`client_stream.rs:786`, `client_stream.rs:1250`); `try_reserve` (`client_stream.rs:343`) charges one `stream_queued` counter against `max_stream` and one `session_metrics.queued_bytes` against `max_session` | **SOURCE-DERIVED, not measured** | it is the mechanism Arm D exists to test. It is written here as a reading of the tree, never as a result |

Correction owed before anyone builds on it: K8's knob-off row is a **receive**
cost. This gate's server both receives and sends on every stream. Applying the
knob-off per-crossing cost to the send side is an assumption, and §7 marks every
figure that does it.

---

## §1 — The scenario, and the arithmetic that sizes it

### 1.1 Shape choice: proxy/tunnel is primary, and why

The ticket offered two shapes. **Proxy/tunnel is the primary; the collab shape
is folded in as Arm X rather than dropped.** The justification, given that the
maintainer's option-c ruling makes this gate bar-critical and buys it one
dispatch:

1. **It is the only shape on the whole board that loads both directions of one
   connection at once.** G1/G2/G3/G6 are ingest-shaped; G4/G7/G10 are
   egress-shaped. Simultaneous bidirectional pressure is measured nowhere, and
   K17 says the tree has a mechanism that only shows up there.
2. **The collab shape's own questions are largely already answered.** Session
   count to 10k is K1; small-message latency at the shipped default is K3. What
   collab adds that nothing else has is the **acceptance path under churn** —
   and that is a property of stream open/close rate, not of session count. It is
   preserved exactly, as Arm X, at one third the design surface.
3. **The deferred claim under test is "bidi adds an acceptance path, not a
   different byte path."** A tunnel arm tests the byte-path half against G5b's
   stamped uni numbers at matched per-direction rate; Arm X tests the acceptance
   half. Neither half is assumed.
4. The strongest sentence a single dispatch can license is a **product-shaped
   capacity claim for the shipped default** — "N concurrent bidirectional
   tunnels at R each way, sustained, exact delivery, bounded one-way tail" —
   which is a proxy sentence, not a collab sentence.

### 1.2 Rig and surface: on-box loopback, no cable

Registered before the run, with reasons:

- **One clock.** Both endpoints on one host makes per-direction **one-way**
  delay measurable. A cross-host design could only give a round trip, and this
  gate's latency and fairness clauses are per-direction. (This is the same
  reason G4 could gate one-way and G6 cannot.)
- The cable is on the critical path for G2/G6/G9/G10. G11 does not need it and
  does not take it.
- Co-residence is the conservative direction: the generator competes for the
  same 4 vCPU, so every delivered figure is a **lower bound** on the server's
  capability, never a capacity number for the server alone. Disclosed in every
  claim §9 licenses.
- Ticket 31 registered loopback as the better surface for bulk stream work; this
  follows that precedent.

### 1.3 Per-tunnel rate

The tunnel carries an inner packet flow. A MASQUE-style relay or a zero-trust
access proxy frames each inner packet on the stream, so **one inner packet is
one `write()`**, which is also one N-API crossing (K13).

| quantity | derivation | value |
|---|---|---|
| inner packet | full-MSS inner segment of a tunnelled TCP flow | 1,400 B |
| framing | 2-byte length prefix | 2 B |
| **write size** | | **1,402 B** |
| per-direction rate | the effort's desktop-share constant (3 Mbps), applied to **both** directions | **3 Mbps = 375,000 B/s** |
| frames/s per direction per tunnel | 375,000 ÷ 1,402 | **267.5** |
| frame interval | 1,402 ÷ 375,000 | **3.739 ms** |

**The symmetry is a stress shape, not a traffic model, and this page says so
before the run.** Real proxy traffic is asymmetric (a browsing or VDI user pulls
far more than it pushes). The gate runs the symmetric case because it is the
worst case for the mechanism under test — both directions of one stream loaded
simultaneously — and the rate constant is the larger direction of the effort's
own desktop-share workload applied to both. No claim in §9 says real tunnels are
symmetric.

### 1.4 Session ladder and what it produces

| rung | tunnels | per direction | both directions | frames/s per direction | **server JS crossings/s** (reads + writes, knob off) |
|---|---|---|---|---|---|
| L1 | 25 | 75 Mbps | 150 Mbps | 6,687 | 13,374 |
| L2 | 50 | 150 Mbps | 300 Mbps | 13,374 | 26,748 |
| **L3 (gate)** | **100** | **300 Mbps** | **600 Mbps** | **26,748** | **53,495** |
| L4 (exploratory, **not a gate rung**) | 200 | 600 Mbps | 1,200 Mbps | 53,495 | 106,990 |

The crossing column is the number that matters. **A proxy is a crossing-rate
workload, not a byte-rate workload**: at 1,402 B per frame the gate rung moves
600 Mbps but pays 53,495 boundary crossings per second, where G5b's knob-off
cell paid 73,301 for 870 Mbps. This is registered here as the reading that makes
the rung sizes mean something, before any of them are run.

Why 100 is the gate rung and 200 is not: 100 is the largest rung whose crossing
rate is **below** the only stamped crossing rate that has ever completed
(K8: 73,301/s), so the gate asks for a capacity the tree has some evidence it
can reach. 200 is above it and is registered as exploratory — see §6.

### 1.5 Arm X — the acceptance path (the collab shape)

An exchange is: client opens a bidi stream, writes one request, reads one
response, both halves FIN. That is the RPC/CRDT-sync shape.

| quantity | derivation | value |
|---|---|---|
| request | one edit-op batch | 120 B |
| response | ack + rebroadcast envelope | 120 B |
| per-session exchange rate | an actively-typing collaborator emits an op batch every 500 ms | **2/s** |
| ladder | sessions 250 / 500 / **1,000** (the ticket's ≥1,000) | gate rung 1,000 |
| **gate rung exchange rate** | 1,000 × 2 | **2,000 exchanges/s** |
| bidi stream opens/s | one per exchange | **2,000/s** |
| concurrent bidi streams per session | 2/s × expected RTT ≪ 1 s | ≪ the shipped `maxStreamsPerSessionBidi` = 200 |

The last row is a **validity** condition, not a hope: if peak concurrent bidi
streams per session reaches the shipped 200 cap, the arm measured the cap and
V-X2 invalidates it (§4).

### 1.6 Latency bound, derived from the interaction budget

Same budget arithmetic G6 used, applied to a proxy rather than a realm:

```
150 ms  perceived interactive limit
-16.7   input frame at 60 Hz
-60     public-internet round trip
-16.7   render frame at 60 Hz
------
 56.6 ms  available for the round trip through the transport   → floored to 50 ms
```

A round trip crosses the proxy path **once in each direction**, so the
**one-way bound is 50 ÷ 2 = 25 ms p99**, applied independently to each
direction of Arm T. Arm X's exchange is a genuine round trip and therefore
carries the **50 ms p99** bound unhalved.

That G6 derived 50 ms from the same budget is not a shared threshold: G6 gates a
round trip, this gates one traversal, and the two numbers differ by the factor
that difference implies.

**Both clauses are the raw p99 with nothing subtracted** (G1's rule). The
client-process scheduler-lag floor is reported beside every latency figure
(spec §Metric definitions) and is a **precondition** (V-G, §4), never a
subtraction.

---

## §2 — Arms and cells

One dispatch. Every cell is 60 s of drive unless stated, plus a staggered
connect ramp (K2) and a settle/drain barrier (§4 V-D) that is **not** in any
rate denominator (spec §Metric definitions).

### Arm T — the tunnel arm

Each session opens exactly one bidi stream and holds it for the step. The
**client** paces 3 Mbps upstream of stamped 1,402 B frames. The **server**, on
accepting the stream, starts an **independently paced** 3 Mbps downstream of
stamped frames on the same stream, and separately drains the upstream. The two
directions are independent flows, not an echo — an echo would couple them and
destroy the simultaneity that is the point.

| cell | rung | knob | repeats | role |
|---|---|---|---|---|
| `T-25` | 25 | off | 1 | ladder |
| `T-50` | 50 | off | 1 | ladder |
| **`T-100`** | **100** | **off (shipped default)** | **2** | **the gate cell**; every clause in §5 is about this cell |
| `T-100-batch` | 100 | `WEBTRANSPORT_STREAM_BATCH_BYTES=65536` | 1 | disclosure: the knob's **bidi** behaviour, on both ends (K12). Grades nothing |
| `T-200` | 200 | off | 1 | exploratory (§6). Produces no gate verdict |
| `J-control` / `J-batch` | 50 | off / 65536 | 1 each | **Amendment 3**: the addon on both ends, so the knob's client-receive behaviour on a bidi handle is measurable at all. Verdict-free |

**The gate cell is the shipped default with the knob off.** G2's lesson: a gate
on a non-default configuration is a weaker claim than a gate on the shipped one.
G5b had to take the knob because the shipped default could not reach its bar;
§7's expectation E1 is that this rung does not need it, and if that expectation
is wrong the gate misses and the miss is final.

### Arm X — the acceptance arm

| cell | sessions | exchanges/s | seconds | role |
|---|---|---|---|---|
| `X-250` | 250 | 500 | 30 | ladder |
| `X-500` | 500 | 1,000 | 30 | ladder |
| **`X-1000`** | **1,000** | **2,000** | **30** | the arm's gate rung |

### Arm D — the cross-direction budget probe (mechanism arm, no verdict)

4 sessions, one bidi stream each, 30 s per cell. The **server** writes downstream
at 3 Mbps paced while **delaying its own consumption of the upstream** by a
registered per-frame delay, so unconsumed inbound reservation grows toward a
target fraction `f` of the shipped `maxQueuedBytesPerStream` = 262,144 B.

Amendment 2 splits every cell by **which end** holds the slow reader, because
the two ends read through different paths and the mechanism is predicted to live
on only one of them.

| cell | slow reader on | inbound backlog target `f` | bytes |
|---|---|---|---|
| `D-00-client` / `D-00-server` | client-opened / server-accepted | 0 (no delay) | control |
| `D-25-*` | both ends, separately | 0.25 | 65,536 |
| `D-75-*` | both ends, separately | 0.75 | 196,608 |
| `D-95-*` | both ends, separately | 0.95 | 249,036 |

Measured per cell: downstream `write()` completion latency distribution, count of
`E_BACKPRESSURE_TIMEOUT`, count of stream errors and resets, server
`queued_bytes` per session, and delivered bytes both directions.

**Registered prediction D-P1, from K17 (source, not a run):** because one
`StreamBudget` is charged by both directions of a bidi handle, downstream write
completion latency rises with inbound backlog, and downstream writes fail with
`E_BACKPRESSURE_TIMEOUT` once inbound unconsumed bytes approach 262,144 B,
bounded by the shipped `backpressureTimeoutMs` = 5,000 ms. **Superseded by
D-P1′ (Amendment 2), which makes it path-specific.**

**Registered falsifier of my own reading, D-F1:** if downstream write latency is
flat across `f` (p99 spread < 2× between `D-00` and `D-95`) and no
`E_BACKPRESSURE_TIMEOUT` appears at `f` = 0.95, the K17 reading is **REFUTED**
and this document's §9 says so. **Superseded by D-F1′ (Amendment 2)**, which
adds the reverse refutation: coupling observed on the server-accepted end would
refute the path asymmetry instead.

Arm D **produces no gate verdict** either way. If D-P1 holds it routes to a
defect ticket: an application whose reader is slow breaks its own *writer* on the
same stream with a stream error, rather than only applying backpressure to its
peer. If D-F1 fires, K17 is struck as a misreading.

---

## §3 — Configuration, pinned

Server (`createServer`), for every arm:

| option | value | why |
|---|---|---|
| `limits.maxSessions` | rung + 100 | headroom, never a limiter |
| `maxHandshakesInFlight` | rung + 100 | staggered ramp (K2) must not queue on the limiter |
| `maxStreamsPerSessionBidi` | **shipped 200, unchanged** | Arm X's validity condition V-X2 is about this exact number |
| `maxStreamsGlobal` | 200,000 | never the limiter |
| `maxQueuedBytesPerStream` / `PerSession` / `Global` | **shipped 262,144 / 2 MiB / 512 MiB** | the gate is about the shipped governors; Arm D's whole subject is `maxQueuedBytesPerStream` |
| `backpressureTimeoutMs` | **shipped 5,000** | D-P1's bound |
| `rateLimits.streamsPerSec` / `streamsBurst` | 10,000,000 | the bench measures the host, not the limiter (Arm B's precedent, verbatim) |
| `rateLimits.handshakesPerSec` / bursts | ≥ 4× / 8× the rung | same |
| datagrams | **none sent on any arm** | K15 cannot touch this gate |

Client: `crates/reference` (Rust), staggered connect ramp, cumulative-deadline
pacer (§8).

Environment recorded in every artifact: `WEBTRANSPORT_STREAM_BATCH_BYTES`,
`WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS`, `WEBTRANSPORT_DATAGRAM_*`, node/bun
version, candidate SHA, staging base SHA, run id.

---

## §4 — Validity falsifiers (every one computed by the classifier)

G3b's lesson, taken literally: **V1 lived only in a hand derivation until it was
too late.** Every falsifier below is a pure function in `tools/load/g11-classify.ts`,
executable off-runner, unit-tested against the signature it exists to reject. A
falsifier that fires makes the cell INVALID; an INVALID gate cell makes the gate
INVALID, not a miss.

| id | check | bar | rejects |
|---|---|---|---|
| **V-G** | client-process scheduler-lag p99 over the drive window, raw | ≤ **5 ms** (20% of the 25 ms bound) | a generator that cannot stamp on time pretending to measure a 25 ms tail |
| **V-G2** | the floor report is same-run, same-host, non-zero driving sessions | — | a floor borrowed from another step (G6's `floorReportIsUsable`) |
| **V-P** | offered ÷ target, each direction, each cell | ∈ **[0.98, 1.02]** | a burst masquerading as a sustained rate; the cumulative-deadline pacer cannot overshoot, so > 1.02 means the pacer is not the one that ran |
| **V-S** | host CPU median over the drive | ≤ **90%** of 4 vCPU (G5's bar) | a saturated host reported as a capacity number ⇒ INCOMPLETE, never a number |
| **V-S2** | client-process CPU is not pinned at its own ceiling while offered < target | — | generator saturation (ticket 14's rule) |
| **V-N** | negative one-way samples | **0** | a single-clock instrument fault; one negative sample invalidates the latency clause |
| **V-C** | `streamBatch.dataCrossings` vs harness-counted server reads | agree within **1%** | a lost or double-counted crossing (G5b's layer-consistency check, and it is only that — both instruments count the same resolutions at different layers) |
| **V-K** | knob provenance: knob-off cells have `batchedCrossings` = 0 and `maxBatchBytes` ≤ one QUIC frame; the knob cell has `batchedCrossings` = `dataCrossings` | exact | a cell whose knob state is not what the label says |
| **V-A** | Arm X: server-observed accepts = client-observed opens | exact | inferring accept rate from client pacing (the retracted-accept-rate lesson) |
| **V-X2** | Arm X: peak concurrent bidi streams per session | < **200** | an arm that measured the shipped per-session stream cap |
| **V-L** | `rateLimitedCount` and `limitExceededCount` deltas | **0** in every cell | an arm that measured the limiter |
| **V-D** | the settle barrier quiesced before counters were read | did not hit `SETTLE_MAX_MS` | `drain-unsettled` (ticket 12's precedent) |
| **V-B** | server-side kernel rcvbuf drops, **reported for every cell** | gate cell: 0 | the phase-1 omission of all-cells drop disclosure is a lesson, not a precedent |

`V-C`'s instrument note, recorded before the run: the chunk-batch diagnostics
counter is **process-global** (`stream-chunk-batch.ts:73`). In the G11 server the
only stream reads are bidi reads, so the counter is unambiguous here — and that
is a property of this harness, not of the counter, which is why it is written
down rather than assumed.

---

## §5 — Gate clauses (all evaluated on cell `T-100`, both repeats)

The gate is **PASS only if every clause passes on both repeats** and no
falsifier in §4 fired.

| id | clause | bar | derivation |
|---|---|---|---|
| **C1** | upstream offered rate | 300 Mbps ± 2% | §1.4; V-P is the honesty half |
| **C2** | downstream offered rate | 300 Mbps ± 2% | §1.4 |
| **C3** | byte accounting closes exactly, both directions | delivered = written, **exact** | streams are reliable; anything else is loss the transport promised not to have |
| **C4** | drain completeness | 0 stream errors, 0 resets, 0 `E_BACKPRESSURE_TIMEOUT`, every stream FINs both halves | K17 makes this the clause most worth stating; a cross-direction budget stall would surface here first |
| **C5** | per-session fairness, each direction | max ÷ min delivered bytes ≤ **1.05**, and min ≥ 0.95 × its own paced offer | the axis's 5% integrity band (used in five independent places on this axis). The pacer's own residual is one frame interval over the step = 3.739 ms ÷ 60 s = **0.0062%**, ~800× smaller than the band (Amendment 1), so any observed spread is scheduling, not pacing |
| **C6** | upstream one-way p99 | ≤ **25 ms**, raw | §1.6 |
| **C7** | downstream one-way p99 | ≤ **25 ms**, raw | §1.6 |
| **C8** | memory statement | advertised per-session worst case stays inside the shipped 2 MiB / 512 MiB budgets; peak RSS reported | K10; a ≥ N-tunnel claim may not borrow a budget it does not stay inside |
| **C9** | crossing disclosure | mean bytes per receive-side JS crossing reported for **both** ends and **both** knob cells | K12. **Graded on nothing** — this gate measures the knob's bidi behaviour, it does not gate on it |

C9 is deliberately verdict-free. The knob's bidi value is unmeasured (K12) and a
gate that graded it would be inventing a bar for a quantity with no prior.

---

## §6 — What each rung licenses, registered now

Written before the run so a lower rung cannot be promoted into a headline after
the top one disappoints (G6 §2.6's rule).

- **`T-100` complete under all §5 clauses ⇒** "on 4 vCPU with the generator
  co-resident, the shipped default sustained **100 concurrent bidirectional
  3 Mbps tunnels — 300 Mbps in each direction, 600 Mbps total — for 2 × 60 s
  with exact byte accounting, no stream errors, per-session spread within 5%,
  and one-way p99 ≤ 25 ms in both directions**."
- **`T-50` complete but `T-100` misses ⇒** the same sentence at 50 tunnels /
  150 Mbps each way. The `T-100` miss is **final** for the effort and routes to
  its mechanism.
- **`T-25` only ⇒** the same sentence at 25 tunnels.
- **`T-200` ⇒ never a gate verdict.** It licenses exactly one form of statement:
  "at 200 tunnels the run was complete/incomplete, with these observed figures",
  and if it is incomplete it licenses nothing at all beyond the STOP reason.
- **Arm X at `X-1000` complete ⇒** "the acceptance path sustained **2,000 bidi
  stream opens/s across 1,000 sessions** with exchange RTT p99 ≤ 50 ms and exact
  completion". Lower rungs license the same sentence at their own rate.
- **Arm D licenses no capacity claim on any cell**, only the mechanism finding
  or its refutation.

---

## §7 — Expectations (labelled; **no clause reads any of these**)

Stated in advance so that if they hold the arm cannot be called aimed, and if
they fail the failure is a refuted prediction rather than a surprise.

- **E1 — the gate cell passes with host CPU median ≤ 65%.** From K8's knob-off
  row: 71.1% host at 73,301 crossings/s, scaled to this rung's 53,495 ⇒ **51.9%**,
  then widened upward to 65 because (a) proportional scaling understates fixed
  cost — G5b's own lesson, where a widened band was still landed in at its top —
  and (b) **half of this rung's crossings are writes, for which no prior exists
  (K11)**, so the scaling is applied to a cost it has never been measured
  against.
- **E2 — the knob buys little or nothing here: mean bytes per receive-side
  crossing on `T-100-batch` lands in [1,402, 2,804] B**, against G5b's 46.2 KB.
  Mechanism: `readBatch` parks for the first chunk and takes only what is already
  queued (no timer, T07's rule). Per stream, frames arrive every 3.739 ms and the
  JS turnaround is far below that, so the queue holds about one frame when a
  crossing begins. If E2 holds, the honest product statement is that **the
  chunk-batching knob's value is a function of per-stream rate, not of aggregate
  rate** — a finding this gate is the first to be able to make.
- **E3 — `T-200` exceeds the host bar and is INCOMPLETE.** Same scaling:
  106,990 crossings/s ⇒ ~103.8% host, above the 90% bar of V-S. Registered as
  expected-incomplete, which is why it is not a gate rung.
- **E4 — Arm X's cost is dominated by the per-exchange JS wrapper**, not by the
  bytes: 240 B of payload per exchange against a `BidiStream` Duplex construction
  and teardown (`streams.ts:58`) plus at least three crossings (read, write,
  finish). No number is predicted, because none can be derived — this is a
  direction, and the arm's artifact is what settles it.

---

## §8 — Pacing mechanics

Both directions use the **cumulative-deadline (virtual-clock) pacer** already
shipping in `crates/reference/src/load_client.rs` (`run_bulk_stream_worker`,
`--stream-target-bytes-per-sec`), reproduced for the server-side downstream
emitter under the same rule: after the *n*-th frame, sleep until the absolute
time *n* frames were due, measured from step start.

Ticket 27 established the three properties this gate also needs, and the reasons
carry unchanged: it **cannot overshoot** (so a delivered figure can never be a
burst, and the only error direction is under-offering — which can cause a miss
but never a false pass); its timer error **does not accumulate**; and a
flow-control block is **absorbed, not repaid**, so falling behind stays visible.
Per-write fixed sleep and token-bucket were rejected there and are rejected here
for the same reasons.

Sizing at the gate rung: 375,000 B/s per direction per tunnel, 1,402 B frames ⇒
**3.739 ms between frames**, ~3.7× the millisecond timer granularity. Disclosed
rather than tuned away: arrivals are quantized at frame granularity, and that
quantization is an input to E2's coalescing reading.

**Downstream emitter alignment.** G6's lesson binds: 100 sessions emitting on one
shared 3.739 ms tick is a 100-frame impulse every 3.739 ms — the egress mirror of
T02's mechanism. The downstream emitter therefore **spreads sessions across the
tick** (each session's virtual clock is offset by `index / N` of one frame
interval). The aligned-egress case is registered as **not covered**, symmetric
with G1's stagger disclosure and G6's.

---

## §9 — What a PASS will and will not license

Written before the run so the stamp cannot widen it.

**Will license**, phrased with the config named because no default flips:
- the §6 sentence for the highest complete rung, with "shipped default, knob
  unset" and "4 vCPU, generator co-resident" inside the sentence, not in a
  footnote;
- the acceptance-path sentence from Arm X at its highest complete rung;
- the byte-path comparison against K8 **at matched per-direction rate only**,
  stated as a comparison of two stamped configurations, never as a general
  "bidi costs the same as uni".

**Will not license**:
- any uncontended capacity number (the generator shared the box);
- any off-box, real-NIC, or multi-host statement;
- any claim about asymmetric tunnel traffic, which this gate does not run;
- any default flip. This gate proposes none. The chunk-batch knob's default
  stays unset and remains soak-freeze-bound;
- any statement about the knob's value from C9, which grades nothing;
- any capacity figure from Arm D, which is a mechanism arm;
- the aligned-egress case (§8) and the synchronized-connect case (K2), both
  registered as not covered.

---

## §10 — Amendment and rerun protocol

- Any change to this document after its commit **quotes the original in full**
  and is dated, and must land **before** any dispatch. A threshold may not move
  after a run.
- One complete run stamps. A rerun requires a **declared, logged harness/infra
  fault**; a miss on a valid run is **final** for the effort (spec §Rerun policy).
- Every dispatch is logged in §12 with run id, candidate SHA, staging base SHA
  and artifact hash — **including aborted ones**.

## §11 — Candidate composition and base drift

- **No candidate is composed and nothing is dispatched by the design agent.**
- Candidate = this probe branch rebased onto the staging SHA that contains
  ticket 23's fixes (K14), recorded from `git rev-parse` by the dispatching
  agent, never typed.
- Staging base at writing: `2a4145d0556a35f8b4a0849e5953927b5e028b64`, verified
  by `git merge-base probe/g11-bidi-01 rebind4-staging`. **Superseded before
  dispatch** — staging moved to
  `9c475df1e255388abf4a07733164869f6377e0b7` (the M1 mirror-send merge) and the
  branch was rebased onto it; see Amendment 5 for the old SHA quoted and the
  drift diff over the four named source regions.
- **If `rebind4-staging` has moved at dispatch time**: re-derive, amend this
  header under §10 with the old SHA quoted **before** dispatch, and diff the two
  staging SHAs for anything touching the bidi accept loop (`lib.rs` ~1058–1175),
  the stream budget (`client_stream.rs` 130–390), the write path
  (`client_stream.rs` ~1590–1630) or the deferred read paths
  (`client_stream.rs` 721–800, ~1190–1280). G1's stamp asserted a merge-base
  equality in the present tense that stopped being true two hours later; this
  document is written not to.
- Agent separation (spec §Separation): the agent that dispatches must not be the
  agent that implemented the levers this gate rides.

## §11b — Amendments (each quotes its original in full, all pre-dispatch)

### Amendment 1 — the pacer-residual comparison in clause C5 (2026-08-19)

Found by mechanising the arithmetic in `tools/load/g11-plan.ts`, before any
harness existed and before any dispatch. **No threshold moves**: the 5% fairness
band and the 0.0062% residual are both unchanged; what was wrong was the phrase
comparing them.

Original, quoted in full:

> The pacer's own residual is one frame interval over the step = 3.739 ms ÷
> 60 s = **0.0062%**, four orders below the band, so any observed spread is
> scheduling, not pacing

Corrected to:

> The pacer's own residual is one frame interval over the step = 3.739 ms ÷
> 60 s = **0.0062%**, **~800× smaller than the band**, so any observed spread is
> scheduling, not pacing

0.05 ÷ 0.0000623 = 803, which is 2.9 orders of magnitude, not four. The clause's
reasoning is unaffected — the residual is still far too small for the band to be
measuring the pacer — but a factor stated wrong on a pre-registration is a factor
stated wrong, and `g11-plan.test.ts` now pins the ratio so it cannot drift again.

### Amendment 2 — K17 is path-asymmetric, and Arm D has to be built to see it (2026-08-19)

Found while designing Arm D's harness, before any harness code was committed and
before any dispatch. **No threshold moves and no clause changes**; what changes
is which end of a bidi stream Arm D loads, and the prediction becomes sharper
and falsifiable in a way the original was not.

K17, quoted in full:

> **A bidi handle owns ONE `StreamBudget`, charged by both directions.**
> `ClientBidiStreamHandle.budget` (`client_stream.rs:1014`) is read by the write
> path (`client_stream.rs:1602`) and by both deferred read paths
> (`client_stream.rs:786`, `client_stream.rs:1250`); `try_reserve`
> (`client_stream.rs:343`) charges one `stream_queued` counter against
> `max_stream` and one `session_metrics.queued_bytes` against `max_session`

That is true, and it is not sufficient, because the two ends of a bidi stream
read through **different** paths:

- **Server-accepted** handles are built by `ClientBidiStreamHandle::new_deferred`
  (`lib.rs:1154`) and read through the **deferred-direct** path. Its reservation
  is taken inside `read()` and released when the `StreamChunk` drops at the end
  of that same call (`client_stream.rs:428`, `455`). Unread inbound bytes sit in
  quinn's 256 KiB per-stream flow-control window, **not** in the shared budget.
- **Client-opened** handles are built by `spawn_bidi_bridge_on`
  (`client_stream.rs:2583`), whose read bridge **reads ahead** into a 256-slot
  channel of 4 KiB chunks and holds each chunk's reservation **until JS consumes
  it** (`reserve_for_recv`, `client_stream.rs:324`). The budget's 256 KiB binds
  before the channel's 1 MiB does, at 64 chunks.

So the sharpened prediction, replacing D-P1 as written:

> **D-P1′.** On a **client-opened** bidi handle whose JS reader falls behind,
> read-ahead reservations accumulate against the shared per-handle budget, and
> **writes on that same handle** park in `reserve_or_wait` and fail with
> `E_BACKPRESSURE_TIMEOUT` after the shipped 5,000 ms — while the read bridge
> independently resets the stream with the same code on its own 5 s deadline.
> On a **server-accepted** handle the same slow reader produces **no such
> coupling**, because its reservations are transient.
>
> **D-F1′.** If the client-opened cells show flat downstream-write latency
> across the backlog fractions and no `E_BACKPRESSURE_TIMEOUT` at f = 0.95, the
> reading is REFUTED. If the **server-accepted** cells *do* show coupling, the
> path asymmetry above is refuted instead, and that is the more interesting
> refutation of the two.

Harness consequence, and the reason this had to be an amendment rather than a
note: Arm D's slow reader must be placed on **both** ends as separate cells
(`D-*-client` on the client-opened handle, `D-*-server` on the server-accepted
one), because a probe that only slowed the server would have measured the path
where the mechanism is predicted **not** to live and would have reported
"no coupling" as if it were a general result.

Clause C4 is unaffected: it already reads `E_BACKPRESSURE_TIMEOUT` on the gate
cell, from whichever end produces it.

### Amendment 3 — where the generator lives, and the cell the ticket's "both ends" requirement actually needs (2026-08-19)

Found while specifying the harness, before any harness process existed and
before any dispatch. **No gate threshold moves and no clause changes**; one
verdict-free cell is added and one instrument is declared unmeasurable where it
was previously assumed available.

The ticket requires that "chunk batching applies receive-side on BOTH ends here
— the knob's bidi behaviour is itself unmeasured". §5 C9 was written to disclose
exactly that. **With the reference generator it cannot be measured at all**, and
the reason is structural rather than incidental:

`crates/reference` speaks QUIC through `wtransport` directly. It contains no
addon, therefore no `StreamBudget`, no `readBatch`, and no
`stream-chunk-batch.ts` diagnostics counter. A Rust-generated arm has a client
end with **no JS boundary to cross**, so "bytes per receive-side JS crossing on
the client end" is not a small number there — it is not a number.

Registered consequences:

1. **Arm T keeps the reference generator**, deliberately. A co-resident addon
   client at the gate rung would pay the same ~53,495 crossings/s the server
   pays, and the arm's whole purpose is a server capacity statement that
   co-residence taxes as little as possible. `crossings.client` is recorded as
   **`null`** on Arm T, and the classifier now distinguishes `null` (no addon
   ran on that end) from `0` (an addon ran and batched nothing) — because the
   second is a V-K finding and the first is not.
2. **Arm J is added**: the addon on **both** ends, at the **50-tunnel rung**,
   one knob-off cell and one knob-on cell, 60 s each. It is **verdict-free** —
   it grades nothing, exactly like C9 — and its output is the both-ends crossing
   disclosure the ticket asks for, plus the first measurement of the knob's
   behaviour on a client-opened bidi handle.
3. **Arm D runs the addon on both ends too**, for the same structural reason
   sharpened in Amendment 2: the read-ahead bridge whose reservations the
   coupling prediction is about (`spawn_bidi_bridge_on`) exists only on an
   **addon-opened** handle. A reference-client Arm D would have exercised
   neither of the two paths the amendment separates.

Arm J's rung is derived, not chosen for comfort: at 50 tunnels each end pays
26,748 crossings/s, which by E1's scaling is ~77% of one core per process and
~38.6% of the box for the pair — well inside V-S, so the disclosure is not taken
from a saturated cell. At the 100 rung the pair would sit near 78% of the box
with the unverified "a write costs what a read costs" assumption (K11) doing the
work, which is a bad place to take a first measurement of anything.

Registered expectation **E5** (labelled; no clause reads it): the knob's
client-end mean bytes per crossing on `J-batch` lands in the same
[1,402, 2,804] B band E2 predicts for the server end, because both ends see the
same per-stream cadence. If the two ends differ materially, that difference is
the finding — the client end reads through a read-ahead bridge and the server
end reads deferred-direct (Amendment 2), and nothing has ever compared them.

### Amendment 4 — five harness facts the build found, each pre-dispatch (2026-08-19)

Found while building and smoking the harness, before any dispatch. **No
threshold moves, no clause changes, no cell is added or removed.** Five things
this document assumed about instruments turned out to be different in the tree,
and each is recorded here rather than discovered in a run's artifact.

**(a) V-K's knob-off condition is about the *server* end, and the harness only
applies it there.** §4 V-K, quoted in full:

> | **V-K** | knob provenance: knob-off cells have `batchedCrossings` = 0 and
> `maxBatchBytes` ≤ one QUIC frame; the knob cell has `batchedCrossings` =
> `dataCrossings` | exact | a cell whose knob state is not what the label says |

"`maxBatchBytes` ≤ one QUIC frame" holds on a **server-accepted** handle, which
reads deferred-direct: one crossing is one assembler chunk. It does **not** hold
on an **addon-opened** handle even with the knob off, because the read-ahead
bridge (Amendment 2) delivers **4 KiB channel chunks**, so a knob-off crossing
there can legitimately carry several frames. A local wiring check showed exactly
that: `maxBatchBytes` 1,420 B server-side and 4,096 B client-side in the same
knob-off cell.

This changes nothing about the gate, and the reason is structural rather than
lucky: V-K is computed by `rollUpTunnelGate`, which runs on the **gate cell
only**, and the gate cell's `crossings.client` is `null` (Amendment 3). Arm J
and Arm D are verdict-free and no falsifier is applied to them. Recorded so that
a reader of Arm J's disclosure does not mistake a 4 KiB knob-off maximum for a
knob whose state was mislabelled. It is also a first reading of the two receive
paths that E5 asks about.

**(b) The client end's stream budget has no JS reader, so Arm D reports it as
`null` and never as `0`.** §2's measured list, quoted in full:

> Measured per cell: downstream `write()` completion latency distribution, count
> of `E_BACKPRESSURE_TIMEOUT`, count of stream errors and resets, server
> `queued_bytes` per session, and delivered bytes both directions.

`queued_bytes` is measurable on the server. On the client it is not: a client
session's stream budget is built over a `SessionMetrics` created at
`client.rs:1321` and shared only with `make_budget` (`client.rs:1352`), while
`metricsSnapshot()` reads `ClientMetrics.queued_bytes` (`client.rs:1170`) — a
different counter, charged by the datagram budget. The bytes the read-ahead
bridge holds against the shared per-handle budget therefore have **no JS reader
on the client end at all**.

Arm D is not disarmed by this: D-P1′ and D-F1′ are stated in terms of write
latency and `E_BACKPRESSURE_TIMEOUT`, both observable on both ends. What is lost
is one corroborating figure on one end, and the artifact says
`peakQueuedBytesBothEnds.client: null` rather than `0` — the all-cells
drop-disclosure lesson applied to a byte counter.

**(c) Arm D's withhold has to clear the JS-side buffer before it reaches the
budget.** §2 sizes the slow reader by "a registered per-frame delay, so
unconsumed inbound reservation grows toward a target fraction `f` of the shipped
`maxQueuedBytesPerStream` = 262,144 B", computed by
`consumptionDelayMsForBacklog`. A `BidiStream` is a Node Duplex with a **256 KiB
`readableHighWaterMark`** (`streams.ts:77`) sitting *in front of* the native
budget; bytes it absorbs are already consumed as far as the bridge is concerned,
so their reservations are released. A reader withholding only
`consumptionDelayMsForBacklog(f × 262,144)` fills the JS buffer and never
touches the budget the arm exists to load.

The driver therefore withholds for
`consumptionDelayMsForBacklog(f × 262,144 + 262,144)`. **The registered
fractions do not move**: they still name a fraction of the shipped
`maxQueuedBytesPerStream`, and this is what makes the driver actually reach
them. The high-water mark used travels in every Arm D artifact.

**(e) The one-way clock had to become an FFI `CLOCK_REALTIME` read, or V-N
would have invalidated the gate for an instrument fault.** §1.2's reason for
putting this gate on one box, quoted in full:

> - **One clock.** Both endpoints on one host makes per-direction **one-way**
>   delay measurable. A cross-host design could only give a round trip, and this
>   gate's latency and fairness clauses are per-direction.

One host is necessary and it was not sufficient. The JS side's first instrument
anchored `Date.now()` at a millisecond tick edge and advanced it with the
monotonic clock; against the Rust generator's `SystemTime::now()` that produced
**~2% negative one-way samples** on a loopback wiring check (62 of 3,210), while
the same server against a JS peer produced **zero** — the signature of two
epochs, not of a transport delivering frames before they were sent. V-N is
registered to invalidate exactly that, so the gate would have come back INVALID
for a clock.

The JS side now reads `clock_gettime(CLOCK_REALTIME)` through FFI, which is the
same system clock `SystemTime::now()` reads — `latency-clock.ts`'s precedent on
the G7 branch, applied to a different clock id. Nothing about the frame, the
field, the Rust side or any threshold changes; the negative counts went to zero
on both arms and the clock source travels in every artifact. The anchored reader
remains as a fallback, and a cell that used it says so.

**(d) A teardown race would have charged C4 for stream errors the run did not
suffer.** When one end observes EOF it may close its session while the peer's
own `close()` on its write half is still in flight; that close then fails with
`E_STREAM_RESET`. Smoking Arm D's control cell reproduced it in roughly half of
runs — on a cell that is meant to be error-free by construction. Both generators
now wait 500 ms after their last stream completes before closing the connection.
The delay is entirely outside the drive window and outside every counter either
generator reports; with it, five consecutive control smokes were clean where
three of five had been dirty. C4's bar is unchanged, and this is the difference
between it grading the product and it grading a shutdown ordering.

### Amendment 5 — staging moved, and the drift is one module declaration (2026-08-19)

Executed by the dispatching agent per §11's own rule, before any dispatch. **No
threshold moves, no clause changes, no cell changes.**

Original §11 line, quoted in full:

> - Staging base at writing: `2a4145d0556a35f8b4a0849e5953927b5e028b64`, verified
>   by `git merge-base probe/g11-bidi-01 rebind4-staging`.

`rebind4-staging` moved to `9c475df1e255388abf4a07733164869f6377e0b7` — the
merge of design/mirror-send-01 (M1 `sendDatagramMirror`). The probe branch was
rebased onto it: pre-rebase head `8b74697ea99d5b66eeca29aeeba7a50c2c8fd855`,
post-rebase head recorded in this amendment's commit. `2a4145d` (ticket 23's
lever-hardening merge) remains an ancestor, so the K14 requirement still holds.

Drift diff `2a4145d..9c475df` over the four regions §11 names — the bidi accept
loop (`lib.rs` ~1058–1175), the stream budget (`client_stream.rs` 130–390), the
write path (`client_stream.rs` ~1590–1630) and the deferred read paths
(`client_stream.rs` 721–800, ~1190–1280) — plus `packages/webtransport/src/streams.ts`
for the JS surface Amendment 4(c) reads: **only
`crates/native/src/lib.rs` is touched, by the single line
`pub mod datagram_mirror;`** — a module declaration in the module list, nowhere
near the accept loop. `client_stream.rs` and `streams.ts` are byte-identical
between the two SHAs. Everything else in the drift is the mirror feature's own
files (`datagram_mirror.rs`, `datagram-mirror.ts`, session/registry mirror
plumbing, bench and docs), none of which the bidi tunnel path reads.

## §12 — Run log

*(empty — no dispatch has occurred)*

| run id | candidate SHA | staging base | arms | artifact hash | outcome |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
