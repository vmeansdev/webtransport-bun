# Pre-registration — Gate G7: server→client bulk over reliable streams

Ticket: `.scratch/production-grade-scenarios/issues/31-gate-g7-stream-egress.md`
Branch: `probe/g7-stream-egress-01`
Base: `rebind4-staging` @ `2a4145d0556a35f8b4a0849e5953927b5e028b64`
Status: **registered, not run.** This document is committed before any harness
code exists on this branch. Nothing here may be edited after the first dispatch
except through a numbered amendment (§12) that quotes the original in full.

Scope note carried from the map: tickets 31–36 are **not** in the pre-soak
all-PASS bar (that bar is G1–G6). G7 is post-bar frontier work.

---

## 0. Provenance ledger — every quantity this document leans on, with the
## verdict status of its source

A threshold derived from an INVALID run is not derived from anything. Every
entry below is labelled with what its source is actually licensed to say, and
the §-references show where (and whether) it is used.

| # | quantity | source | source's verdict status | used here for |
|---|---|---|---|---|
| K1 | ≥ 1 Gbps bulk target | `spec.md` §Targets G5 | pre-registered product target, predates every run | **the C2 bar** (§4) |
| K2 | 1.25 Gbps pace point = bar + 5 × the axis's 5% integrity band | `gate-g5b.md` §pacing; band is a `bench-stream.ts` property | derivation from K1 + a configuration fact | **the registered offer** (§3.2) |
| K3 | cumulative-deadline pacer: cannot overshoot, non-accumulating timer error, absorbs (never repays) a flow-control block | ticket 27 §"Pacing mechanics"; `load_client.rs run_bulk_stream_worker` | design precedent, **verified against raw fragments** in the G5b stamp §2 | **the pacer design** (§3.3), re-implemented server-side |
| K4 | 0.95 shortfall / 1.02 overshoot pacing bands | `gate-g5b.md` | pre-registered, fired correctly on a PASS run | **V2** (§5) |
| K5 | G5b delivered 1.250 Gbps *ingest* (client→server) with `WEBTRANSPORT_STREAM_BATCH_BYTES=65536`, host CPU 48.8%, zero drops | ticket 27 G5b stamp | **PASS**, but it is a *receive-direction, knob-set* result | context only. **No G7 threshold is derived from it.** The direction under test here is the opposite one and has no lever. |
| K6 | shipped default without the receive knob tops out at 0.870 Gbps ingest | G5b stamp §5 | PASS-run disclosure cell | context only; **not** a prediction for egress |
| K7 | shipped governors: `maxQueuedBytesPerStream` 262,144 · `maxQueuedBytesPerSession` 2,097,152 · `maxQueuedBytesGlobal` 536,870,912 · `maxSessions` 2000 · `maxStreamsPerSessionUni` 200 | `packages/webtransport/src/index.ts` `DEFAULT_LIMITS` | configuration fact on the base tree | **write-size derivation** (§3.1), **C6** (§4) |
| K8 | per-session advertised worst case = `receiveWindow + sendWindow + datagramChannel × maxDatagramSize`; `maxQueuedBytesGlobal` does not bound it | `index.ts` doc comment, ticket 09 | configuration fact + a landed decision | **C6** (§4) |
| K9 | ~103k datagrams/s is this rig's settled on-box ceiling | `docs/research/2026-08-18-bandwidth-ceiling-attribution.md` | CLOSED attribution | **ladder bracketing** (§3.1) and **P4** (§7). A datagram-path number; used only as an order-of-magnitude bracket for a *crossing-rate* ladder, never as a bar. |
| K10 | receive-side stream chunk batching (`WEBTRANSPORT_STREAM_BATCH_BYTES`) | ticket 07, landed knob-OFF | landed lever | **explicitly irrelevant here** (§2.4) and recorded as OFF in every cell |
| K11 | the *send* path has no batching story: `SendStream._write` → `handle.write(chunk)` = one N-API async call per write | `packages/webtransport/src/streams.ts:287-302`, `crates/native/src/client_stream.rs:1794` | code fact on the base tree, read this session | **the instrument-discovery arm** (§6) |
| K12 | datagram send-batch is ≥ 40× cheaper than serial-await at the JS floor | ticket 04 microbench | a **datagram** microbench result | **not used as a prediction.** Quoted only to say what G7 is *not* allowed to assume about streams. |
| K13 | G3b's V1 fired: an in-process scheduler's lag metric is arm-dependent by construction (shared event loop), and percentiles over positive samples only are not the same order statistic across arms | ticket 26 G3b stamp §1 | **INVALID run — licenses no product number**, but its instrument lesson is binding | **V3** (§5) and the deliberate *absence* of a cross-arm lag agreement clause (§5.8) |
| K14 | rates must divide by the drive window, not a nominal one | `spec.md` §Metric definitions; final-review finding on G5's `windowSec` | binding process rule + an open finding | **§3.5 — G7 reports both denominators and the clause must clear on both** |
| K15 | drop disclosure must cover **all** cells, per repeat | final-review finding against the G5 phase-1 stamp | binding lesson | **C4 + §4.1** |
| K16 | a sink/pre-check that skips the real path measures nothing (shadow-sink vacuity); a pre-check whose own originator saturated is a failure, not a pass | final-review finding against G4's headroom; ticket 14's rule | binding lesson | **V1** (§5) |
| K17 | `Bun.nanoseconds()` is epoch-per-thread; `clock_gettime(CLOCK_MONOTONIC)` read by FFI from Bun and by `libc` from Rust is one system-wide counter on Linux | ticket 26/30 measurement, `tools/load/latency-clock.ts` | measured instrument fact | **§3.4 clock discipline** |
| K18 | 28-byte latency stamp v1 layout (magic/version/intended/actual/sequence) | `tools/load/latency-stamp.ts` | shipped harness instrument | **the token payload** (§3.1) |
| K19 | `WEBTRANSPORT_DATAGRAM_SEND_SYNC` default is an open maintainer ruling | map §Phase-1 record | **open ruling** | recorded in the artifact; **no datagram is sent by this gate**, so no clause depends on it |
| K20 | 4 vCPU / 8 GB rig, generator co-resident | `spec.md` §Aim | standing caveat | every figure carries it |

**One correction I owe before anyone builds on this document.** K12 is a
*datagram* result on a *microbench*. Ticket 04's "≥ 40×" compares JS-floor
crossing shapes for `sendDatagram`, not stream writes, and a stream write is a
different native path (budget reservation + mpsc send + a writer task) with a
much larger per-call payload. It is entered here **only** so that a reader
cannot later say G7 assumed the stream send path is expensive because the
datagram one was. G7 measures the stream send path; it predicts nothing from
K12.

---

## 1. What this gate is for, and the coverage hole it closes

The stream axis has only ever measured **ingest** (client→server bulk: G5, G5b).
The egress axis has only ever measured **datagrams** (G3, G4). Every product
scenario where the server is the byte source over a reliable stream — VOD and
media distribution, LLM token streaming, file/asset distribution, log and event
fan-down — has **zero stamped numbers**. G7 measures that direction, in the two
shapes that bracket it:

- **Arm S-bulk** — few sessions, large writes, high byte rate. The VOD /
  distribution shape. Question: *does the server sustain ≥ 1 Gbps of
  server-originated stream bytes inside the shipped governors?*
- **Arm S-tokens** — many sessions, tiny writes, negligible byte rate. The LLM
  streaming shape, and the **session-count × stream-egress cross-term** that no
  gate has touched. Question: *does a 1,000-session fleet of low-rate token
  streams hold a per-write delivery latency inside the interactive budget?*

Both arms share one instrument-discovery obligation (§6): **the server-side
stream write path has no batching story** (K11), and G7 records what one write
call costs, at write rates from 2.4k/s to 150k/s. Recorded, not built.

---

## 2. Design decisions, each with the argument that fixes it

### 2.1 Stream direction and type — server-opened uni for bulk, client-opened
### bidi for tokens

Both are real W3C usages and they exercise **two different native handles**,
which is a coverage argument and not a convenience:

- **S-bulk uses server-opened unidirectional streams**
  (`session.createUnidirectionalStream()` → `ClientUniSendHandle`, despite the
  historical name — `session_napi.rs:429` returns it for a *server* session).
  This is the push/distribution shape: the server decides when an object exists
  and writes it down; the browser receives on `incomingUnidirectionalStreams`.
  One stream per media object is the MoQ/CMAF-shaped mapping.
- **S-tokens uses client-opened bidirectional streams**
  (client `open_bi()`, server `incomingBidirectionalStreams` →
  `ClientBidiStreamHandle`). This is the request/response shape an LLM
  completion actually has: the client sends a prompt, the server writes tokens
  back on the same stream. Using bidi here is not decoration — the write path on
  a bidi handle is a *separate* `write` impl (`client_stream.rs:1563` vs
  `:1794`), and the send-batch lever contract (spec §Lever contracts) already
  records that "both handles" is a place this codebase has diverged before.

The two arms therefore cover both server-side write implementations. If they
disagree materially on write-call cost (§6), that is itself a finding.

### 2.2 On-box loopback is mandatory here, not merely convenient

The registered bulk-surface reasoning carries with one addition specific to
egress: the gate offers **1.25 Gbps**, which is *above the entire capacity of a
1 GbE link*. A cable run would measure the cable and nothing else. Loopback is
the only surface on which this question exists on this rig. Recorded now so that
the co-residence caveat is not later read as a shortcut that a cable would have
fixed.

Consequence, disclosed up front: the generator — here the *sink*, a Rust
process — shares the box. Every figure is an on-box, co-resident figure and
bounds the server's capability from below.

### 2.3 The sink is Rust, deliberately, and what that costs the claim

The peer is `crates/reference` (Rust/wtransport), not a Bun client. That
isolates the *server's send path* from any JS receive cost, which is what this
gate is about, and it mirrors how G5 isolated the JS receive path against a Rust
source.

**What it therefore cannot license:** nothing about a Bun-client deployment.
A Bun receiver would pay the receive-side crossings G5/G5b measured, on top of
everything here. G7's numbers are not end-to-end numbers for a Bun↔Bun pair and
the stamp must say so.

### 2.4 No lever is under test, and the receive knob is irrelevant

`WEBTRANSPORT_STREAM_BATCH_BYTES` (K10) batches the **receive** side. The
receiver here is Rust and crosses no N-API boundary. The knob is therefore
recorded as unset in every cell and **no clause may read it**. G7 is a
measure-first scout on a path that has no lever, which is exactly why the
instrument-discovery arm (§6) is the deliverable of equal standing to the gate.

### 2.5 What "delivery exact" means on a reliable stream

Streams retransmit. A lost packet is not a lost byte, so a delivery *ratio* is
the wrong instrument and would read 1.000 by construction. The ticket's own
formulation is adopted verbatim: the delivery clause is **drain-completeness +
pace fidelity**:

- every byte the server wrote arrived (`serverBytesWritten == sinkBytesRead`, to
  the byte),
- every stream the server opened was accepted and observed to finish,
- no stream error on either side,
- and the offer the pacer actually issued is inside its registered band.

A kernel receive-buffer drop on this path costs a **retransmit**, not a byte.
It therefore makes a delivered figure an *understatement* of the path's
capability. C4 still requires zero on the gate arm — a "sustains ≥ 1 Gbps"
statement should be made about a config that was not paying a retransmit tax —
and all other cells disclose their counts (K15).

---

## 3. The arms

### 3.1 Sizes, derived

**S-bulk write size.** The per-stream governor is 262,144 B (K7) and
`write_bytes` reserves the full write against it before enqueueing
(`client_stream.rs` `reserve_or_wait`). A write **equal** to the governor
therefore serialises: park → write → park, with zero writes in flight. The
largest write that leaves the governor room to pipeline at depth 4 is
`262144 / 4 = 65,536 B` — which is also the CMAF partial-segment order of
magnitude. **Gate write size = 65,536 B.**

**S-bulk crossing ladder.** At the fixed 1.25 Gbps offer, halving the write size
doubles the write rate for identical bytes. That is the send-crossing experiment
for free:

| cell | bytes/write | writes/s (aggregate, at 156,250,000 B/s) | role |
|---|---|---|---|
| `B-64k` | 65,536 | **2,384** | **the gate arm** — every S-bulk clause is about this cell |
| `B-16k` | 16,384 | 9,537 | scout rung |
| `B-4k` | 4,096 | 38,147 | scout rung |
| `B-1k` | 1,024 | 152,588 | scout rung, **registered as expected to miss** (§7 P4): it demands a crossing rate ~1.5× the rig's settled ~103k/s datagram ceiling (K9), an order-of-magnitude bracket and not a bar |

4 sessions × 4 streams = 16 streams, unchanged from G5b's operating point so the
two directions are comparable at the same session/stream shape. Per-stream rate
= 156,250,000 / 16 = **9,765,625 B/s**; at 65,536 B that is **6.71 ms** between
writes, 6.7× the 1 ms timer granularity.

**S-tokens write size,** derived from the token arithmetic, not chosen:
an SSE frame carrying one 4-character token (`data: {"c":"____"}\n\n`) is 22 B.
The measurement stamp is 28 B (K18). The write is **40 B** = the 28 B stamp
+ 12 B of token text, which sits inside the ticket's derived 20–50 B band and is
within 2× of the real frame it stands in for. Every write is therefore a latency
sample; **no sampling, no unstamped fraction by construction** (V5 still checks).

**S-tokens write rate:** interactive completion serving targets output that
outruns reading — adult reading is ~4–5 words/s, and the product bar is roughly
5× that. **25 tokens/s**, inside the ticket's 10–30 band, giving a **40 ms**
inter-token interval.

**S-tokens ladder:**

| cell | sessions | writes/s aggregate | role |
|---|---|---|---|
| `T-250` | 250 | 6,250 | lower rung; **what it licenses is registered in §7.1 before the run** |
| `T-1k` | 1,000 | **25,000** | **the gate rung** (the ticket's ≥ 1,000) |
| `T-2.5k` | 2,500 | 62,500 | scout rung, expected to bind |

Payload rate at the gate rung is 25,000 × 40 B = 1.0 MB/s = **8 Mbps**. This arm
is a pure crossing/latency probe: if it misses, bytes are not why.

### 3.2 The offer

1.25 Gbps for every S-bulk cell (K2), identical across the ladder so that the
ladder varies **only** the crossing rate. S-tokens is rate-shaped by its own
25 Hz grid and is not byte-paced.

### 3.3 The paced writer — server-side, which is new

The pacer that G5b used is Rust, client-side (K3). Here the paced writer is the
**server**, in Bun/JS. The mechanism is re-implemented, not reused, and the
re-implementation is the design decision this ticket asked for.

**Cumulative deadline (chosen).** Per stream, after the *n*-th write, sleep
until the absolute time at which `n × writeBytes` was due, measured from the
step's start: `sleep(max(0, written/rate − elapsed))`. Its three properties
survive the port:

1. **It cannot overshoot.** The only error direction is under-offering, which
   can cause a miss but never a false pass.
2. **Timer error does not accumulate.** An over-sleep shortens the next sleep.
3. **A flow-control block is absorbed, not repaid** — falling behind stays
   visible instead of being erased by a catch-up burst.

**Two things are genuinely different in JS and are handled explicitly:**

- **Sub-millisecond intervals.** At 4,096 B the per-stream interval is 0.419 ms
  and at 1,024 B it is 0.105 ms — under the timer granularity. The writer
  therefore issues **all writes currently due** at each wake and then sleeps to
  the next deadline. The burst is bounded by construction: **at most one timer
  tick of bytes** (`ceil(1 ms × perStreamRate / writeBytes)` writes), a constant
  ~1 ms of arrival burstiness at *every* rung, so the ladder stays comparable.
  This is the direct analogue of G5b's disclosed write-granularity burstiness
  and is disclosed the same way: **arrivals are bursty within one timer tick,
  and that is an input to any reading of the crossing figures.**
- **The pacer shares the product's event loop.** This is K13's coupling, and it
  is unavoidable: the writer *is* the server. It is handled by measuring it
  rather than by claiming independence — `pacerLatenessNs = actualWriteNs −
  intendedNs` is recorded per write, and V2b (§5) converts a shortfall that is
  accompanied by large lateness into an **ORIGINATOR-BOUND / INCOMPLETE** cell
  rather than a product miss. No cross-arm agreement clause is registered,
  because G3b proved that class of clause is unmeetable in-process (§5.8).

**Rejected, on the record:** per-write fixed sleep (undershoots by the fraction
of the period the write consumes — and that fraction *is* the quantity under
test, so cells would sit at different offers while carrying the same flag) and
token bucket (accrues credit during flow-control blocks and spends it as an
unpaced burst — the exact shape that produced G5's NO-VERDICT).

### 3.4 Clock discipline

One clock domain: `clock_gettime(CLOCK_MONOTONIC)` (K17), read by FFI on the Bun
side and by `libc` on the Rust side. `Bun.nanoseconds()` is **not** used for any
stamped instant. Both processes are on one box, so this is a genuine shared
epoch and a one-way latency is legitimate — the same footing on which G4
discharged its on-box one-way.

The stamp direction is **server → sink** only: `intended` and `actual` are both
**server** clock instants, and `arrival` is the sink's read instant on the same
counter. One-way latency = `arrival − actual`, which starts at the write call
and therefore contains the entire product path (N-API, budget, mpsc, writer
task, quinn, kernel, loopback, sink read) and **excludes** the server's own
pre-write scheduling, which is reported separately as `pacerLateness`.

### 3.5 Denominators — both, and the clause must clear on both

K14 is binding and G5's stamp had to disclose a 5.2% denominator gap after the
fact. G7 reports every rate on **both** `windowSec` (the nominal drive window)
and `driveSec` (spawn→exit wall time), and **C2 must clear on the `driveSec`
denominator**, which is the conservative one and the one the spec's metric
definition names. The `windowSec` figure is reported beside it for comparability
with the ingest direction. Registering the strict denominator as the binding one
*before* the run is the only way this cannot look like a choice made afterwards.

### 3.6 Repeats, duration, arrival

**2 repeats per cell, fresh server per repeat, 60 s drive**, matching the stream
axis's operating point. S-tokens connects its fleet **staggered** (G1's lesson;
T02's synchronized-impulse mechanism is CONFIRMED) and the **synchronized-arrival
case is registered as NOT COVERED**, symmetric with G1's stagger disclosure.

---

## 4. The clauses

A cell is graded on the **median of its repeats** (n = 2 ⇒ the mean of two, both
samples always published).

| # | arm | clause | bar | derivation |
|---|---|---|---|---|
| **C1** | both | **completeness**: every clause-bearing cell usable in both repeats; no INCOMPLETE bucket; `hostCpuPctMedian < 90` | the axis's pre-existing 90% saturation rule | K20 + axis rule. A saturated gate arm is **NO-VERDICT**, not a MISS |
| **C2** | S-bulk | **throughput**: `median(B-64k delivered)` ≥ **1.000 Gbps**, on the `driveSec` denominator | K1 | the spec's bulk target, direction-flipped |
| **C3** | S-bulk | **drain-completeness / delivery exactness**: `serverBytesWritten == sinkBytesRead` to the byte; streams opened == accepted == finished; zero stream errors both sides | exact | §2.5 |
| **C4** | S-bulk | **client-side rcvbuf drops == 0** on `B-64k`, both repeats; **all cells disclose** their per-repeat counts on both sides (client `Udp.RcvbufErrors`, server `Udp.SndbufErrors`) | zero | §2.5, K15 |
| **C5** | S-bulk | **pace fidelity**: `offered / pace` ∈ [0.95, 1.02] on `B-64k` | K4 | overshoot ⇒ INVALID (V2), shortfall ⇒ V2b |
| **C6** | S-bulk | **inside shipped budgets**: no explicit window field set; governors at K7 defaults; per-session advertised worst case re-derived and stated | K7/K8 | a ≥ 1 Gbps claim must not borrow a budget it says it stays inside |
| **C7** | S-tokens | **one-way p99** on `T-1k` ≤ **10 ms**, raw, computed over **all** samples including non-positive | 40 ms inter-token interval × ¼ | a token later than a quarter of the interval is visible jitter in a stream whose whole product promise is smooth arrival; the ¼ fraction is the same shape as G3's frame-fraction bounds. **Raw p99 with nothing subtracted — G1's rule.** `pacerLateness` is reported beside it, never subtracted from it |
| **C8** | S-tokens | **delivery + drain exactness**: every issued write arrives; per-stream sequences gapless and in order; every stream finishes; zero errors | exact | §2.5 at the token shape |

**C9 is not a clause — it is a mandatory disclosure with a pre-registered
reading** (§6).

### 4.1 The all-cells drop disclosure

Every cell, every repeat, both directions, in **one** object in the verdict
artifact alongside that cell's delivered samples — so the counts can never again
live in a different document from the numbers they qualify (K15). Any non-zero
count flags that cell `deliveredIsLowerBound`. The clause binds only on the gate
arm (§2.5); the scout rungs are *expected* to drop at high crossing rates, and a
zero-drop requirement there would demand the ladder not do its job.

---

## 5. Validity falsifiers

All are **pure functions of recorded fields**, implemented in
`tools/load/g7-classify.ts`, unit-tested against the signature each exists to
reject, and **executable off-runner** on a downloaded artifact. This is the
direct answer to K13: G3b's V1 lived only in a hand derivation, and a reader
taking the classifier at face value would have stamped a PASS on a run its own
registration declared invalid.

| id | rule | outcome if it fires |
|---|---|---|
| **V1** | **sink honesty.** Pre-check, same day, same box, loopback: the Rust sink reads ≥ 1.5 × the gate arm's byte rate **and** ≥ 1.5 × the gate rung's write rate, through the *real* read path (no stub, no discard-before-read). A pre-check whose own **source** saturated (host CPU ≥ 90 or source-reported shortfall) is a **failure**, not a pass (K16). In-run: sink process CPU median < 90 and sink read backlog bounded | run **INCOMPLETE** — a sink-bound arm is not a server measurement |
| **V2** | **pace overshoot.** `offered > 1.02 × pace` on any paced cell | **INVALID** for that cell — the cumulative-deadline pacer cannot write ahead of its clock, so this falsifies the *mechanism*, whatever the flag said. `pace-unmeasurable` (no server-side write-byte counter) is the same rule's missing-instrument case and is likewise INVALID |
| **V2b** | **originator-bound.** `offered < 0.95 × pace` **and** `p99(pacerLateness) > oneWriteInterval` | that cell is **ORIGINATOR-BOUND / INCOMPLETE**, not a product miss. A shortfall with *small* lateness is a genuine product shortfall and is disclosed as such |
| **V3** | **negative-sample denominator.** Every latency percentile is computed over **all** recorded samples, with non-positive samples ranked at ≤ 0 and counted, never dropped. If `negativeFraction > 0.001` the clock domain is violated (both ends are on one counter on one box) | **INVALID** for that cell. The negative count and fraction are published on every cell regardless |
| **V4** | **ledger closure.** `serverBytesWritten == sinkBytesRead`; `writeCalls == writeSettles`; `streamsOpened == streamsAccepted == streamsFinished`; `stampsDecoded == writesIssued` on S-tokens | **INCOMPLETE** (`drain-incomplete`) — a step whose two processes disagree about how many bytes exist is not a measurement |
| **V5** | **stamp provenance.** ≥ 99% of received S-tokens writes carry a decodable v1 stamp of the expected version; unstamped fraction published | below 99% ⇒ **INCOMPLETE** |
| **V6** | **limiter / error quiescence.** `rateLimitedDelta == 0`, `limitExceededDelta == 0`, `sessionsErr == 0`, `exitCode == 0` | **INCOMPLETE** (the axis's standing STOP) |
| **V7** | **host saturation.** `hostCpuPctMedian ≥ 90` on a clause-bearing cell | **NO-VERDICT** (C1), never a MISS |

### 5.8 One falsifier deliberately **not** registered

No cross-arm agreement clause on any scheduler-lag metric. K13 established that
a lag metric measured on the emitter's own event loop is arm-dependent **by
construction**, and G6 declined the same clause for the same reason. Registering
an unmeetable falsifier costs a run. `pacerLateness` here is a **disclosure**
plus the one-sided V2b rule, and it is read only in the direction where it can
protect the product from a harness-caused miss — never to excuse one.

---

## 6. Instrument discovery — the send-side crossing scout (C9)

This is a deliverable of equal standing to the gate verdict, and it is
**recorded, not built**: G7 changes no product code and proposes no lever here.

**What is measured, per cell, per repeat:**

| quantity | how |
|---|---|
| `writeCalls`, `bytesPerWrite`, `writeCallsPerSec` | server-side counters at the application write site |
| `writeSettleNs` p50/p99/max | call instant → the `write()` promise settling, per write, histogrammed |
| `serverCpuMsPerGbit` | windowed server CPU over delivered Gbit |
| `serverCpuMsPerMillionWrites` | the crossing-normalised cost, which is the actual scout quantity |
| `sessionQueuedBytes` | `metricsSnapshot().queuedBytes` sampled at 1 Hz — separates "parked on the governor" from "parked on the pacer" |
| `wireBytesSent` | `_connectionStats().bytes_sent` (UDP tx bytes), a **native-layer** byte counter |

**On "two crossing instruments agreeing ≤ 1%", honestly.** There is no second
*independent* crossing counter on the send side — the send path has no
diagnostics counter at all (K11), and adding one is product code this gate will
not touch. What is registered instead, and labelled as exactly what it is:

- a **byte ledger that closes across two processes**: `writeCalls × bytesPerWrite
  == serverBytesWritten == sinkBytesRead`, exact (V4). A miscounted crossing
  cannot survive this at a fixed write size.
- a **settle ledger**: `writeCalls == writeSettles`, exact — every crossing
  produced exactly one settled promise.
- a **native-layer byte cross-check**: `wireBytesSent ≥ serverBytesWritten` and
  `wireBytesSent / serverBytesWritten ≤ 1.10` (QUIC + UDP framing overhead on
  65,536 B writes is ~2–3%; 1.10 is a loose bound whose violation means
  retransmission or a counter fault, and it is a **disclosure**, not a clause).

This is a **layer-consistency and ledger check, not two independent
measurements of one quantity** — stated here because G5b's stamp had to make the
same correction about its receive-side pair after the fact (its residual 3).

**Pre-registered reading — L1, the only rule that may license a lever:**

> If `serverCpuMsPerGbit(B-4k) ≥ 2 × serverCpuMsPerGbit(B-64k)` — identical
> bytes, identical offer, 16× the crossings — the per-crossing cost of the
> server-side stream write is **material**, and a send-side batching design
> ticket (the stream mirror of H7 / ticket 34) is licensed **as a design
> question only**. If the ratio is < 2, this run **refutes** the assumption that
> the stream send path needs batching at bulk rates, and no lever is licensed.

The 2× threshold is derived, not chosen: the receive-side lever (K5's run) moved
CPU-per-Gbit by 2.68× across a 33× crossing-rate change. A 16× crossing change
that fails to move CPU-per-Gbit by even 2× means crossings are under ~1/8 of the
path's cost, which is below the level at which a batching lever can pay for its
own complexity. **L1 is evaluated on whatever the run produces and its result is
reported in both directions**; a refutation is as much the deliverable as a
confirmation.

---

## 7. Predictions, registered before the run

Each states what it licenses so that a lower rung cannot be promoted into a
headline after a top rung disappoints (G6's forcing).

- **P1** — `B-64k` clears C2 (≥ 1 Gbps delivered). *Basis:* 2,384 writes/s is
  three orders below any crossing rate this rig has struggled with, and the
  bytes are the same order as the ingest direction's. **If P1 fails, the miss is
  final for the effort** and routes to a mechanism ticket, not to a rerun.
- **P2** — `B-4k` (38k writes/s) delivers ≥ 0.95 × `B-64k`. *Basis:* K11 says
  each write is one N-API async call, and 38k/s is inside the same order as
  datagram send rates this rig sustains. **If P2 holds, L1 is expected to refute
  the lever.**
- **P3** — `B-1k` (153k writes/s) **misses**: it demands a crossing rate ~1.5×
  the rig's settled ceiling (K9). **A `B-1k` miss licenses nothing about the
  product** — it is the ladder's bracket, registered as expected, and may not be
  reported as a defect.
- **P4** — `T-1k` (25,000 writes/s, 1,000 sessions) is the arm most at risk.
  Registered failure signature to discriminate: if C7 misses **with**
  `p99(writeSettle)` well under 40 ms and `pacerLateness` p99 large, the binding
  constraint is the **JS emitter's own scheduling** (V2b territory, an
  originator finding); if it misses **with** `p99(writeSettle)` large, the
  binding constraint is the **write path** (a product finding that licenses the
  L1 design question at the token shape). Both readings are registered now;
  neither licenses a rerun.
- **P5** — `T-250` passes C7. §7.1 fixes what that is worth.

### 7.1 What a lower rung licenses, fixed in advance

- `T-250` passing licenses exactly: *"250 concurrent 25 tok/s streams held a
  ≤ 10 ms p99 one-way on this rig, with the sink co-resident and in Rust."* It
  licenses **no** statement about 1,000 sessions, no per-session capacity
  extrapolation, and no provisioning claim (G1's idle-floor caveat class).
- `B-16k` / `B-4k` passing licenses a **crossing-cost** statement only, never a
  second throughput headline: the gate arm is `B-64k` and C2 is about it alone.
- A `T-2.5k` result of any kind is scout data. It is outside the gate rung and
  above the shipped `maxSessions` default's comfortable range for this shape;
  it is reported and licenses nothing.

---

## 8. Pre-flight, before any dispatch (all evaluated off-runner)

| step | requirement |
|---|---|
| **PF1** | **V1 sink pre-check**, on the runner, loopback, same day: Rust sink sustains ≥ 234 MB/s read (1.5 × 156.25 MB/s) **and** ≥ 37,500 write-events/s (1.5 × 25,000), through the real read path. Source honesty checked: pre-check source not saturated |
| **PF2** | **clock check**: `latency-clock.ts` reports `source` and `calibrationResidualNs`; the Rust sink and the Bun server bracket-test agree within 50 ms (the G6 refusal rule). Failure ⇒ no dispatch |
| **PF3** | **base check**: `git merge-base --is-ancestor` of the recorded base against `rebind4-staging` at dispatch time; if staging has moved, §12 amendment **before** dispatch quoting the old SHA (G1's stamp asserted a present-tense equality that stopped being true — this document is written not to) |

---

## 9. Candidate composition and dispatch (the orchestrator's steps, not the
## design agent's)

1. Candidate = `probe/g7-stream-egress-01` rebased onto the `rebind4-staging`
   SHA at dispatch time. SHAs from `git rev-parse` only, never typed.
2. Push under a **new** remote ref so no earlier candidate becomes unreachable.
3. **One** dispatch, `[self-hosted, Linux, X64, heavy]`, dedicated:
   `mode=g7-stream-egress`, arms and ladders as workflow inputs (populations and
   windows only — **no thresholds are workflow inputs**).
4. Log the dispatch in §11 — run id, candidate SHA, artifact sha256s —
   **including if it aborts**.
5. **Rerun policy:** one complete run stamps. A rerun requires a declared,
   logged harness/infra fault. A miss on a valid run is final. Re-running at
   another write size, another pace point, another session count or another
   bound is **forbidden**.

---

## 10. What a PASS licenses, and what it can never license

**Licensed by a PASS**, phrased with the config named (no default flips here):

- *"On 4 vCPU with the sink co-resident and in Rust, over loopback, the server
  sustained ≥ 1 Gbps of server-originated reliable-stream bytes for 2 × 60 s
  inside the shipped 256 KiB / 2 MiB governors, with zero client-side rcvbuf
  drops and an exact byte ledger."*
- *"1,000 concurrent 25 tok/s token streams held a p99 one-way of ≤ X ms."*
- The send-path cost table (§6) as a measured property of the base tree.

**Never licensed, whatever the result:**

- Anything about a **Bun client** receiving this traffic (§2.3).
- Any **uncontended** capacity number (co-resident sink).
- Any **default flip**. G7 proposes none; the soak-freeze rule stands.
- Any **provisioning** claim ("N viewers", "N concurrent completions") — the
  idle-floor caveat class from G1 applies to every session-count figure here.
- Any statement about the **ingest** direction, or any comparison to K5's
  1.250 Gbps that is not explicitly labelled as a cross-direction, cross-knob
  comparison of two different experiments.
- Any **cable/off-box** statement (§2.2).

---

## 11. Run log

<!-- One row per dispatch, including aborted ones. Run id, candidate SHA,
     staging base SHA, artifact sha256s, outcome. -->

_No dispatch has occurred._

---

## 12. Amendments

<!-- Numbered, each quoting the original text in full, each dated, each made
     before the dispatch it affects. -->

_None._
