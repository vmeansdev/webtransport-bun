# Pre-registration — Gate G8: many-rooms multi-publisher fan-out

Status: **registered, not run.** Written before any G8 harness code exists.
Ticket: `.scratch/production-grade-scenarios/issues/32-gate-g8-many-rooms.md`.
Spec: `.scratch/production-grade-scenarios/spec.md` rev 2 (§Metric definitions and
§Process rules bind this document).
Branch: `probe/g8-many-rooms-01`, based on `rebind4-staging` @
`2a4145d0556a35f8b4a0849e5953927b5e028b64`.

Scope ruling carried from `map.md`: tickets 31-36 are **NOT** in the pre-soak
all-PASS bar. G8 is post-bar frontier work. Nothing here gates the rebind №5
soak, and nothing here may be used to delay it.

---

## §0 — Known results, disclosed before the thresholds

A bar derived from an INVALID run is not derived from anything. Every entry
carries its source's verdict status, and the entries whose numbers are struck
say so in the same row where the number would otherwise be quotable.

| # | fact | source | verdict status | how G8 uses it |
|---|---|---|---|---|
| K1 | GPS gate at 10k sessions | issues/17, G1 | **PASS-narrowed** | not used; different axis |
| K2 | games ingest gate | issues/18, G2 | **INCOMPLETE-ON-THIS-RIG** | not used |
| K3 | camera egress gate | issues/19, G3 | **INCOMPLETE** (interpretation struck) | not used |
| K3b | G3b re-registration run | issues/26 | **INVALID** — licenses nothing | used only as instrument lesson (K17) |
| K4 | SFU 1→50: forwarded 743,050 / 45.005936069 s = **16,510.04/s**, `egressOneWay` p99 inside 33.3 ms, forward delivery ≥ 0.99, R_eff 330/s | issues/20, G4 | **PASS** | licenses the constant-shape envelope arm B sits in |
| K5 | G4's largest complete fan-out step: N=100 **per-subscriber**, **33,016/s** forward egress, `egressOneWay` p99 **17.039 ms**, server CPU **83%** of 4 vCPU | issues/20 | complete step of a PASS run; explicitly **not** the registered gate point | the highest fan-out egress ever measured; every G8 rung is placed against it |
| K6 | G4 room formula `rooms = floor(F_measured / (P(P−1)R))` returned **0** | issues/20 | PASS run, honest output | the number G8 replaces |
| K7 | G4 per-target forward cost, `forwardIssueSpread` p50 ÷ N: **9.73 µs** (N=10), 7.13 (25), **6.31** (50), 5.98 (100) | issues/20 | complete steps | bounds the forward-issue budget; K=10 is the relevant column, so **9.73 µs** is G8's planning figure, not 6.31 |
| K8 | G4 `handlerToForward` p50: **2.4 µs** (N=10), 3.3 (25), 4.9 (50), **7.1 µs** (N=100) | issues/20 | complete steps | the instrument **demonstrably resolves growth** — ~3× over a 10× change in targets. V-H(b) rests on this |
| K9 | G4 `headroomRatio` **1.80** | issues/20 | **STRUCK** by reviews/final-round.json (`generator-headline`, major): the ceiling counted shadow sink stubs that skip the native send; on like-for-like work the arm sourced **0.90×** of the ladder's demand | **may not be quoted.** G8 derives no generator headroom from G4 and builds its own (V-G, V-S) |
| K10 | G4's emitter: `sendDatagram-pipelined`, `WEBTRANSPORT_DATAGRAM_SEND_SYNC` unset (**default on**), `WEBTRANSPORT_DATAGRAM_BATCH` unset | issues/20 | recorded config | **G8 uses the identical emitter and knob state**, or arm B's comparison to K5 is not a comparison |
| K11 | The mirror API — one payload, N sessions, one crossing — **does not exist**; `sendDatagramBatch` is many payloads into one session and per target would hold one element | issues/20 | recorded finding, routed to ticket 34 | G8 is **forbidden from acting on it**, same as G4. It is the reason the per-target cost is what it is |
| K12 | G4's binding caveat: the measured shape has **one** ingest; multi-publisher, ingest-side contention and per-publisher jitter are **untested** | issues/20 | binding | **this is why G8 exists** |
| K13 | bulk/stream gate | issues/21, G5 | **NO-VERDICT**; and reviews/final-round.json (`coherence`, blocker) finds the knob-OFF landing moved the shipped default's stream throughput +12.7% and cost −10% | not used; G8 sends no streams |
| K14 | on-box ceiling ≈ **103k datagrams/s** | 160k attribution closure, `docs/research/2026-08-18-bandwidth-ceiling-attribution.md` | settled | every G8 rung's total is stated as a fraction of it |
| K15 | `WEBTRANSPORT_DATAGRAM_SEND_SYNC` landed **default-ON** pre-soak; reviews/final-round.json (`incomplete-massaging+process`, blocker) calls it a soak-freeze dodge; **the maintainer ruling is open** | git 852bda3, merge 3d03a98 | **open ruling** | G8 records the knob's state in the artifact. If the ruling reverses it, G8's forward path describes the other tree — said here, before the run |
| K16 | The five critical lever defects (RESET-swallow, `send_datagram_batch` bypassing `spawn_counted`, the >256 deadline, client dead code, retryable close) are **fixed** in the base | ticket 23, merge `2a4145d` | landed | G8's base contains them; no G8 rung rides an unfixed lever |
| K17 | G3b's invalidation: an honesty instrument that shares the emitter's event loop measures the emitter, not the schedule; a validity falsifier that lives only in a hand derivation cannot be shown to fire | issues/26 | binding lesson | every G8 falsifier is a **pure function**, executable off-runner, unit-tested against the signature it rejects |
| K18 | G5b's pacing discipline: a **cumulative-deadline** (virtual-clock) pacer cannot overshoot, so a delivered figure can never come from a burst | issues/27 | binding lesson | G8's publisher grid and its lag probe are both cumulative-deadline |
| K19 | G6's design forcings: an emitter must **spread across a slice grid** rather than fire aligned impulses; the provenance ledger carries **verdict status per entry**; lower-rung licensing is **pre-registered before the run** | issues/30 | binding lessons | §1.6 (phase spreading), this §0, and §7 respectively |
| K20 | G6 harness is complete but **has never run** (cable-gated); its P3 predicts its own 5k rung misses | issues/30 | **not run** | **G6 licenses nothing.** No G8 threshold is derived from it |
| K21 | The Mac generator's schedule lag reached **40.6 ms** on an idle box | ticket 29 | observed, single reading | the reason the cable path is **not** qualified for G8's 20 ms bound (§2) |
| K22 | Ticket 29's iperf3 "21,738 pps delivered, 0 lost" is an **offered rate that was met**, not a measured ceiling (G6's correction K12) | issues/30 | corrected | not used as a sink capability figure |

Two entries are corrections I owe before anyone builds on this page:

* **K7 is not 6.31 µs.** G4's headline per-target figure came from its N=50
  step, and per-target cost *falls* with N because the issue loop's warm-up
  amortises. G8's fan-out width is **K=10**, so the applicable column is the
  N=10 one — **9.73 µs**, 1.54× the number a casual read of G4 would take.
  Every forward-budget derivation below uses 9.73.
* **K9 may not be quoted at all.** G4's stamp carries a generator-headroom
  ratio that the final review struck as arithmetic over two different units of
  work. G8 therefore builds its generator honesty from scratch (V-G) and its
  sink honesty from scratch (V-S), and neither borrows a number from G4.

---

## §1 — Scenario arithmetic

Everything below is derived here. No threshold is chosen by looking at a G8
number, because no G8 number exists.

### §1.1 Why this gate exists

K12: G4's shape has exactly **one** ingest. Every real product this axis is
named after has many — a Discord voice channel, a group chat, a small-room
video call. G8 puts **M concurrent publishers** on the server at once and asks
whether the ingest→forward path scales when it is running against itself.

The unit of the scenario is a **room**: one publisher, K subscribers, forwarding
confined to the room. That is the shape of a voice channel with one person
speaking, and of a small video room with one active speaker. Arm C additionally
runs the **mutual** room (every member publishes to every other), which is the
shape K6's formula was written for.

### §1.2 The voice payload — Opus arithmetic

| step | derivation | value |
|---|---|---|
| frame period | Opus default speech frame; the value WebRTC and Discord both use | **20 ms** |
| packet rate | 1 datagram per frame | **50 pps** |
| media bytes | Opus **32 kbps** mono fullband speech × 20 ms = 640 bits | **80 B** |
| stamp | `latency-stamp.ts` version 3 | **48 B** |
| payload | 80 + 48 | **128 B** |

Two disclosures on the payload, both registered now:

* **32 kbps, not 64.** Discord's *channel* bitrate defaults to 64 kbps, which is
  a stereo-capable ceiling rather than a typical speech rate; 32 kbps mono is the
  Opus fullband-speech operating point. At 64 kbps the payload would be 160 + 48
  = **208 B**. **The packet rate is identical**, and per K7 the forward cost is a
  per-target crossing cost measured at 1150 B — so a 128 B datagram cannot cost
  more than G4's per-target figure, and a 208 B one cannot either. The
  bytes/s difference (6.4 MB/s vs 10.4 MB/s at arm A's top rung) is **not
  covered**; pps is.
* **The stamp is larger than a real RTP header** (48 B vs 12 + 4). Carrying it
  makes the datagram bigger than production, never smaller, so the byte-side
  reading is conservative in the direction that matters.

### §1.3 Room size

K = **10 subscribers**. Derivation: the top of the typical active
voice-channel size (a Discord voice channel with more than ~10 simultaneously
active speakers is not the scenario; a 10-seat channel is), and it is the same P
that K6's room formula used, so arm C's output lands in G4's own units.

### §1.4 The three arms and their ladders

Per-room forward load is `K × R` (arms A, B) or `P × (P−1) × R` (arm C).
Per-room ingest is `R` (A, B) or `P × R` (C).

**Arm A — voice, the core arm.** 1 publisher → K=10, R = 50 pps, 128 B.
Per-room forward = 500/s. Per-room ingest = 50/s.

| M | ingest /s | forward /s | total /s | vs K5 (33,016/s) | vs K14 (103k) |
|---|---|---|---|---|---|
| 10 | 500 | 5,000 | 5,500 | 0.15× | 5% |
| 50 | 2,500 | 25,000 | 27,500 | 0.76× | 27% |
| **100** | **5,000** | **50,000** | **55,000** | **1.51×** | **53%** |

**Arm B — video, the controlled comparison with G4.** 1 publisher → K=10,
R = 330 pps (K4's quantised 11 datagrams/tick × 30 Hz form of 3 Mbps at
1150 B), 1150 B. Per-room forward = 3,300/s.

| M | ingest /s | forward /s | total /s | vs K5 | note |
|---|---|---|---|---|---|
| 2 | 660 | 6,600 | 7,260 | 0.20× | |
| 5 | 1,650 | 16,500 | 18,150 | 0.50× | aggregate = K4's gate point, 16,510/s |
| **10** | **3,300** | **33,000** | **36,300** | **1.00×** | **aggregate = K5 exactly** |

Arm B's top rung is the reason arm B exists. Its forward egress equals G4's
largest complete step to within 0.05%, at the **same** 33.3 ms bound, with the
**same** emitter and knob state (K10) — and exactly one variable changed: **10
concurrent ingests instead of 1**. If it passes, ingest concurrency at this
scale costs nothing measurable. If it misses, ingest concurrency is the cost,
isolated. Both readings are registered in §7 as informative.

**Arm C — the mutual room, replacing K6's zero in K6's own units.** P = 10
mutual publishers, R = 50 pps, 128 B, forwarding to the other P−1 = 9.
Per-room forward = 10 × 9 × 50 = **4,500/s**. Per-room ingest = 500/s.

| M | ingest /s | forward /s | total /s | vs K5 |
|---|---|---|---|---|
| 2 | 1,000 | 9,000 | 10,000 | 0.27× |
| 5 | 2,500 | 22,500 | 25,000 | 0.68× |
| **10** | **5,000** | **45,000** | **50,000** | **1.36×** |

Arm C at M=10 carries the same 5,000/s ingest as arm A's top rung but spread
over **100 publishers in 10 rooms**, which is the ingest-contention case in its
strongest available form.

**K6's formula at video rate is out of scope and stays so.** A mutual 10-person
*video* room needs `10 × 9 × 330 = 29,700/s` of forward egress for **one** room.
That is 90% of K5 on its own, so the honest statement about it — one room, maybe
— derives from K5 by arithmetic and needs no G8 run. G8 does not run it and does
not claim it.

### §1.5 The latency bound

**Voice: 20 ms, one Opus frame period.** Derived twice, independently.

*Derivation 1 — the jitter buffer.* An SFU that adds more than one frame period
of forwarding delay pushes the receiver's adaptive jitter buffer up by a whole
frame, because a frame is the smallest quantum it can hold. One frame period is
therefore the largest forwarding delay that does not cost the receiver a step of
buffer, and steps of buffer are the thing a voice product feels.

*Derivation 2 — the G.114 budget.* ITU-T G.114 puts one-way mouth-to-ear at
150 ms for "users very satisfied". Decomposing a regional SFU call:

| leg | ms |
|---|---|
| Opus frame + encoder look-ahead (20 + 5) | 25 |
| publisher access network, one way | 30 |
| **server forward** | **X** |
| server → subscriber access network, one way | 30 |
| receiver adaptive jitter buffer | 40 |
| decode + playout | 5 |
| fixed total | 130 |

X ≤ 20 ms.

The two derivations land on the same number from unrelated premises. That is a
coincidence and this document says so rather than presenting one as confirming
the other.

**Video: 33.3 ms, one 30 fps frame.** The same bound G3 and G4 use, taken
unchanged so arm B's comparison to K5 is like-for-like.

**The p99 is raw.** Nothing is subtracted — not the publisher's schedule lag,
not the sink's. G1's rule. The publisher's `intended → actual` distribution is
published *beside* the gate figure, and V-G below is what keeps it from being
the answer.

### §1.6 Phase spreading, and what that excludes

M publishers on a 20 ms grid, all firing at t = 0, 20, 40 ms, is an aligned
impulse of M datagrams every frame — the ingest-side twin of the egress impulse
K19 forced G6 to spread. Real voice clients are not phase-aligned; their frames
land wherever their capture clocks put them.

Each publisher therefore gets a deterministic phase offset of
`(publisherIndex / totalPublishers) × framePeriod`, recorded in the artifact.

**Registered as NOT covered: the phase-aligned arrival case.** Symmetric with
G1's stagger disclosure and G6's aligned-egress disclosure. A storm of aligned
frames is a different measurement and G8 does not make it.

### §1.7 The forward-issue budget, derived

At arm A's top rung the conductor issues `50,000` forward sends per second. At
K7's K=10 column that is `50,000 × 9.73 µs = 0.4865 s` of CPU per second — **49%
of one core**, on a 4 vCPU box, for the issue loop alone, before ingest handling,
before the library, before quinn. At arm C's top rung it is `45,000 × 9.73 µs =
0.4379 s/s`.

This is the number that makes P3 (§7) a real prediction rather than a hedge, and
it is also why V-H exists: at half a core of pure issue loop, the question "is
the conductor the bottleneck" is not rhetorical.

---

## §2 — Placement: on-box, and why the cable does not help here

**Registered placement: publisher pool, subscriber pool and server all on the
bench VM (4 vCPU / 8 GB), co-residence disclosed.** Three reasons, in order:

1. **The metric is a one-way interval and needs one clock.** G8's gate quantity
   is publisher-send → subscriber-receive. Off-box across the cable that spans
   two hosts and there is no shared clock; the standing rule for the cable is
   RTT-gated designs only, and a publisher→subscriber one-way is not a round
   trip. On-box it is one clock, exactly as it was for G4.
2. **Arm B's comparison requires G4's placement.** K5 was measured with
   publisher, server and sink co-resident. Moving G8 off-box would change two
   variables at once and destroy the one controlled comparison this gate has.
3. **The cable path is not qualified for a 20 ms bound.** K21: the Mac's
   schedule lag reached 40.6 ms on an idle box — **2× the voice bound**. A
   generator whose observed lag maximum exceeds the entire gate budget cannot
   carry a raw-p99 gate without a same-day floor arm that has never been run.

**The rejected-but-better placement, registered so it is not rediscovered as a
finding:** put *both* the publisher pool and the sink pool on the Mac. That
keeps one clock (both roles on one host) *and* isolates the server completely —
strictly better than on-box on the confound axis. Its wire cost is affordable:
arm A's top rung is 50,000 pps at ~180 B on wire ≈ 72 Mbps, 7% of 1 GbE; arm B's
top rung is 33,000 pps at ~1200 B ≈ 317 Mbps, 32%. **The only thing blocking it
is K21.** The exact condition under which a future G8 re-measure should take it:
a same-day Mac floor arm showing publisher schedule-lag **p99 ≤ 2 ms** and
**max ≤ 20 ms** at the arm's own publisher count. Recorded here; not attempted
now.

Co-residence is the standing caveat on every G8 number, and V-G and V-S are
what stop it from being an excuse.

---

## §3 — Process pooling, and the honest limit of it

The ticket's requirement: M publisher honesty without one process faking M.

### §3.1 What pooling can and cannot buy

It cannot buy independence. M publishers in P processes on **one host** share
one kernel, one scheduler and 4 vCPU with the server they are driving. No
process count makes them M independent originators. Saying otherwise would be
the co-residence version of the mistake K9 was struck for.

What pooling *can* buy is a bounded blast radius: a stall inside one runtime
correlates only the publishers in that runtime, not all M.

**Registered accordingly: G8 does not claim M independent publishers.** It
claims M concurrently-publishing sessions, pooled, on a co-resident host, with
per-publisher schedule fidelity measured and gated. The correlated-stall case
is **not covered**.

### §3.2 The pool rule

* **Publishers: ≤ 25 sessions per process.** At arm A's top rung, M=100 → **4
  processes**, each sourcing `25 × 50 = 1,250 pps`. At arm C's top rung, 100
  publishers → 4 processes at 1,250 pps each. At arm B's top rung, 10
  publishers → 1 process at 3,300 pps — which is 10× G4's single-publisher
  process load and the only per-process rate on this page above anything G4
  demonstrated, so it is flagged: arm B's publisher process is the one to watch
  in V-G.
* **Subscribers: ≤ 250 sessions per process.** Arm A M=100 → 1,000 subscriber
  sessions → **4 processes**, each sinking `250 × 50 = 12,500 pps`. Arm B M=10 →
  100 sessions → 1 process at 33,000 pps, which is K5's sink load in K5's
  process count.
* **Room-to-sink assignment is round-robin across sink processes**, so a room's
  K subscribers are spread and **room identity is independent of sink-process
  identity**. This is deliberate: if the K members of a room shared a sink
  process, a stall in that process would present as a *room* failure and point
  at the server. Spread, a sink stall smears across rooms and the per-room
  clauses stay attributable. The assignment is deterministic and recorded.

The per-process caps are blast-radius choices, not capability claims; no number
on this page asserts what a process *can* do. That is V-G's and V-S's job, and
they are measurements, not derivations.

### §3.3 Per-publisher, not per-pool

K17's other half — the negative-sample denominator. A per-pool aggregate lets 24
healthy publishers hide one starved one. **Every publisher reports its own
schedule-lag histogram and its own counters**, and V-G is evaluated over
publishers, never over pools. The pool is a deployment detail; the publisher is
the unit.

---

## §4 — The metrics

All names are the artifact's field names. Histograms are
`latency-histogram.ts` (log-linear buckets, negatives counted separately and
never dropped).

**Gate quantities**

| field | definition |
|---|---|
| `roomOneWay` | per room: publisher `actual` send stamp → subscriber JS receive instant. One clock (§2). The gate quantity |
| `roomForwardDelivery` | per room: subscriber-received ÷ (room ingested × K). Steady window, phase-aligned, drain grace — spec §Metric definitions |
| `aggregateOneWay` | all rooms pooled |
| `aggregateForwardDelivery` | pooled |
| `roomsFailingP99` / `roomsFailingDelivery` | counts, and the identities |

**Attribution and validity quantities**

| field | definition |
|---|---|
| `publisherToIngest` | publisher `actual` → server JS handler entry, per room. V-I |
| `handlerToForward` | server JS handler entry → **first** forward send issued, per room. Contains the room lookup. V-H(b) |
| `forwardIssueSpread` | first forward send call → last, within one arrival's fan-out |
| `forwardSettle` | first forward send call → all of that arrival's sends settled |
| `publisherScheduleLag` | per publisher: `intended` → `actual`. V-G. Cumulative-deadline grid (K18) |
| `conductorLoopLag` | conductor main thread: cumulative-deadline 5 ms grid, lateness. V-H(c) |
| `arrivalGaps` / `frameGapFraction` | per room, server-observed inter-arrival structure. V-I |
| `serverCpuPct`, `hostCpuPctMedian` | percent-of-one-core, windowed rate over the phase — spec §Metric definitions |
| `udpTx`, `udpRx`, `rcvbufErrors`, `sndbufErrors` | kernel counters bracketing each step |

**Rate labels are effective offered rates**, quantisation-corrected, per spec.
`driveWindowSec` is the drive window; no rate divides by wall clock that
includes handshake, samplers or drain.

---

## §5 — Gate clauses

A rung is **complete** when every validity falsifier in §6 clears. Clauses are
evaluated only on complete rungs. A complete rung that misses a clause is a
**miss, and it is final** (spec §Rerun policy).

Let `bound` = 20 ms (arms A, C) or 33.3 ms (arm B). Let `M` = the rung's room
count. Define the **room tolerance** `T(M) = floor(0.01 × M)` — at most 1% of
rooms may be bad. `T(10) = 0`, `T(50) = 0`, `T(100) = 1`, `T(2) = T(5) = 0`.

* **C1 — aggregate forward delivery.** `aggregateForwardDelivery ≥ 0.99`.
  Derived: G4's bar (K4), and independently the conventional packet-voice
  tolerance — Opus PLC conceals isolated losses at about this rate and stops
  concealing above it.
* **C1b — no bad room hides in the aggregate.** `roomsFailingDelivery ≤ T(M)`,
  where a room fails if its own `roomForwardDelivery < 0.99`.
* **C2 — aggregate tail.** `aggregateOneWay` p99 `< bound`, raw.
* **C2b — no bad room hides in the aggregate tail.**
  `roomsFailingP99 ≤ T(M)`, where a room fails if its own `roomOneWay` p99
  `≥ bound`.

C1b/C2b are the registered answer to K17's negative-denominator lesson **and**
to the opposite error. A per-room *worst-of-M* clause would be a max over M
order statistics and would tighten automatically as M grows, punishing the top
rung for being the top rung. A pooled aggregate alone would let a broken room
vanish into 99 healthy ones. The 1%-of-rooms form does neither, and it means the
same thing at every M.

**C3 — the M-scaling statement.** §8.

**C4 — the room count.** The largest M that is complete and clears C1, C1b, C2
and C2b, **per arm**, stated as measured, with its arm's shape attached and
non-detachable. This is the honest replacement for K6's zero.

### §5.1 What a G8 pass licenses, and what it does not

Registered now so it cannot be widened later.

**Licensed:** "M concurrent K-subscriber rooms of the stated shape, on the
4 vCPU rig with generator and sink co-resident, at the stated per-room rate,
held publisher→subscriber p99 under the stated bound with ≥ 99% forward
delivery and no more than 1% of rooms out of spec."

**Not licensed, in the same breath:**
* Any *saturation* or *capacity* claim. Every G8 rung is a fixed offered load.
  The forward-egress ceiling is not searched for, exactly as in G4, and "the
  largest M that passed" is a demonstrated point and not a maximum.
* Any claim about a real network, real clients, real Opus, or congestion. There
  is no encoder, no jitter buffer, no packet loss, no cross traffic.
* Any cross-arm combination. Arm A's M and arm B's M count different rooms.
  They may not be added, averaged, or presented as one number.
* Any statement about the mutual room at video rate (§1.4).
* Any per-user or per-session provisioning figure — the idle-floor caveat that
  bound G1 binds here too.

---

## §6 — Validity falsifiers

Every one is a **pure function** over a plain record in `tools/load/g8-classify.ts`,
executable off the runner, and **unit-tested against the signature it exists to
reject** (K17). A falsifier firing makes the rung **INVALID** — a statement about
the rig or the harness, never a capacity number and never a miss.

### V-I — ingest reality, per room

Reuses `ingestRealityVerdict` from `tools/load/egress-fanout.ts` (registered by
the egress pre-registration's amendment 8), applied **per room**:

1. `publisherToIngest` p50 ≥ **100 µs** (`INGEST_REALITY_FLOOR_NS`). The
   retracted fan-out run's 9–31 µs signature is what this rejects.
2. The room's `frameGapFraction` inside `cadenceBandFor(datagramsPerTick)` —
   the publisher's own frame cadence must be visible in the server's arrival
   times for **that room**, not for the pooled stream. Pooled, M interleaved
   publishers destroy the structure by construction, which is precisely why this
   is per-room.
3. ≥ 99% of the room's arrivals carry a decodable stamp.

**Rung INVALID if more than `T(M)` rooms are not real.** The full reason
histogram is published either way.

*Why the G4 form and not G6's replacement:* G6 amendment 2 replaced
`ingestToForward` with the subscribers' own one-way because off-box it spans two
hosts and cannot be computed. G8 is on-box (§2), so `publisherToIngest` is one
clock and G4's form applies unchanged — and G8's gate quantity `roomOneWay`
already *is* G6's stronger form, so both are present.

### V-S — sink saturation pre-check

`sinkPrecheckVerdict`, driven at `SINK_HEADROOM_FACTOR` = **1.5 ×** the rung's
forward load into the **same sink pool shape** the rung will use (same process
count, same sessions per process, same round-robin assignment). Requires
delivery ≥ 0.99 and one-way p99 under the arm's bound.

At arm A M=100 that is `1.5 × 50,000 = 75,000 pps` into 4 sink processes. At arm
B M=10, `1.5 × 33,000 = 49,500 pps` into 1.

A pre-check **whose own originator saturated is `inconclusive`, not a pass**
(ticket 14's rule, kept). An inconclusive or failed pre-check makes the rung
INVALID, never a capacity number.

The pre-check runs **standalone**, with no fan-out arm live, and its own
originator honesty is measured by the same V-G machinery.

### V-G — publisher generator honesty, per publisher

Two parts, both per publisher:

1. `publisherShortfall` (from `egress-fanout.ts`): sent ≥ 90% of
   `effectiveRatePerSec × driveWindowSec`, and skipped ticks < 10% of tick
   events.
2. **`publisherScheduleLag` p99 ≤ 2 ms** — 10% of the voice bound, and 6% of the
   video bound. Derived from the bound, not from any measurement of a generator.
   The **max is disclosed beside it** (K21's lesson: a p99 that clears while the
   max is 2× the budget is a fact the reader needs).

**Rung INVALID if more than `T(M × publishersPerRoom)` publishers fail either
part.** Evaluated over publishers, never over pools (§3.3).

The grid is cumulative-deadline (K18): the *n*-th send's deadline is
`start + phaseOffset + n × period`, never `previous + period`, so the generator
cannot drift and cannot overshoot to catch up.

### V-H — harness forward cost

Mandatory per the ticket: the conductor's SFU loop must not become the thing
being measured. Three parts, because "the harness is free" is not provable and
is not the right claim.

The right claim: **the conductor is the application**, and a real SFU would also
be a JS app on this library. What must be falsified is the conductor doing work a
real SFU would not, or being scheduled so badly that its own lateness is inside
the gate quantity.

**V-H(a) — routing is O(1) in M, by construction and by microbench.** The
conductor keeps `Map<publisherSessionId, RoomRecord>` where `RoomRecord` holds a
**pre-built subscriber array**, built once at room setup. Registered
prohibitions on the per-arrival path: no array construction, no `filter`, no
`sort`, no scan over sessions, no string keys built per arrival. (The W3C
scheduler's `q.sort()` and linear `includes` per datagram — spec §Lever
contracts — is the exact cost shape being excluded.) A committed microbench
asserts per-arrival routing cost is flat from M=10 to M=100: **the highest M's
ns-per-arrival may exceed the lowest M's by at most 1.5×**. Tighter than
V-H(b)'s factor because the microbench has no I/O, no scheduler and no other
tenant — if an O(1) router cannot look flat there, it is not O(1). It is a pure
function and runs off-runner. **A missing or single-point microbench fires the
falsifier**, so the check cannot be silently skipped.

**V-H(b) — the M-dependence discriminator.** `handlerToForward` p99 at the
largest complete rung of an arm must be `≤ 2 ×` its value at the smallest
complete rung of the same arm.

The instrument is known to resolve growth: K8 shows `handlerToForward` p50
moving 2.4 → 7.1 µs, ~3×, when *targets per arrival* went 10 → 100. In G8, K is
**fixed** across each arm's ladder and only M moves, so an O(1) router produces a
flat `handlerToForward` and an M-dependent one produces growth the instrument has
already demonstrated it can see.

**If V-H(b) fails, the M-scaling statement (C3) is withheld** — outcome S3 in
§8. C1/C1b/C2/C2b may still stand on their own absolute bounds, because those are
end-to-end statements that include the conductor honestly.

**V-H(c) — conductor scheduling lateness.** A cumulative-deadline 5 ms grid on
the conductor's **main thread**, reporting lateness only. p99 lateness
**≤ 2 ms** — 10% of the voice bound.

The main thread is correct here and is not a repeat of K17. G3b's defect was an
instrument that measured the *emitter's own send* and called it scheduler lag.
This measures pure lateness of a fixed grid against a monotonic clock, with no
I/O in the probe, and main-thread blocking is exactly the quantity of interest:
if the forward loop blocks the loop for 5 ms, that 5 ms is inside every
`roomOneWay` sample and the reader must know. Registered discriminator: the
probe performs **no send, no await on I/O, and no allocation per tick**.

### V-F — forward shortfall

`forwardShortfall` from `egress-fanout.ts`, G4's registered rule, applied per
room: the conductor must have issued at least 90% of `ingested × targets`. A
room whose forwards never happened has a delivery ratio that is a statement
about the conductor, not the transport.

### V-N — negative samples

Any histogram with `negative > 0` on a gate quantity makes the rung INVALID.
One clock, one host: a negative one-way is a clock or a decode defect, not a
fast packet. Counted, never dropped.

### Which falsifiers invalidate

**V-I, V-S, V-G, V-H(a), V-H(c), V-F and V-N make the rung INVALID.**
**V-H(b) does not** — it withholds C3 (§8, outcome S3) and leaves the absolute
clauses standing, because those are end-to-end statements that include the
conductor honestly.

V-S additionally requires the pre-check to have driven **the rung's own sink
pool shape**; a pre-check run against a different process count is not a
statement about this rung's sink and makes the rung INVALID for that reason
separately from its own outcome.

### One source of truth for the aggregate

`aggregateOneWay` is **derived by merging the per-room histograms**, not
reported separately by the conductor. C2 and C2b therefore cannot be reading
different data, and a room missing from the aggregate is a room missing from
C2b.

---

## §7 — Predictions, registered

Registered before the run so an outcome cannot be reframed afterwards. A wrong
prediction is a finding, not a failure of the gate.

* **P1 — arm A M=10 passes.** 5,000/s forward is 15% of K5.
* **P2 — arm A M=50 is the first at-risk rung.** 25,000/s is 76% of K5, but the
  bound is 20 ms against the 33.3 ms K5 cleared at p99 17.04 ms — a 1.67×
  tighter bar with 0.76× the load. Registered as genuinely open.
* **P3 — arm A M=100 misses at least one of C2/C2b.** 50,000/s is 1.51× the
  highest fan-out egress ever measured, at a 1.67× tighter bound, with §1.7's
  half-core issue loop. This is registered as the *expected* outcome, so a pass
  is the surprise and a miss is not a disappointment to be explained away.
* **P4 — arm B M=10 is the informative one either way.** Its forward egress
  equals K5 to 0.05% at the same bound with the same emitter, changing only
  ingest concurrency (1 → 10). **Pass ⇒ ingest concurrency costs nothing
  measurable at this scale. Miss ⇒ ingest concurrency is the cost, isolated.**
  No third reading is available, which is what makes the arm worth its runner
  minutes.
* **P5 — V-H(b) passes on every arm.** The router is O(1) by construction
  (V-H(a)). If it fails, the finding is a harness defect and the scaling
  statement is withheld, not massaged.
* **P6 — V-S passes at arm A M=10 and M=50 and is the live risk at M=100**,
  where it must drive 75,000 pps into 4 co-resident sink processes — 73% of K14
  spent entirely on the sink, while nothing else runs. A failed V-S at M=100 is
  an *incomplete rung*, not a miss, and §7.1 already says what that licenses.

### §7.1 Lower-rung licensing, fixed now

K19's third forcing. Registered **before** the run so a lower rung cannot be
promoted into a headline after the top rung disappoints:

* If arm A M=100 is a miss or incomplete, **M=50 licenses exactly**: "50
  concurrent 10-seat voice rooms — 500 sessions, 25,000/s of forward egress —
  held the 20 ms p99 and 99% delivery on this rig." It licenses **nothing**
  about 100, and the phrases "close to 100", "approaching 100" and any
  interpolation between 50 and 100 are forbidden.
* If arm A M=50 also falls, M=10's licence is the same sentence with 10 and
  5,000/s, and the gate's honest headline becomes a two-digit room count.
* If arm B M=10 is a miss, arm B licenses nothing about G4, because the whole
  arm is the M=10 point; M=5 licenses only itself.
* Arm C's C4 is stated in K6's formula's units and replaces the zero **only for
  the arm that produced it**. If arm C is INVALID at every rung, K6's zero
  stands unreplaced and G8 says so.
* A gate that is INVALID at every rung of every arm produces **no room count at
  all** and is reported that way.

---

## §8 — The M-scaling statement (C3), and its no-expectation flag

**This gate registers NO expected form for p99 versus M.** No bound derives: the
conductor is one event loop, so the tail is a queueing quantity whose growth
depends on a utilisation that is not known a priori — §1.7's per-target cost is
K7's, measured on a different shape at a different payload, and using it to
predict a percentile would be exactly the interpolation-is-not-measurement error
spec §G2 already names. The `fanoutScaling` precedent applies: **the statement
is a description of what was measured, never a confirmation of anything.**

The reading is mechanical, fixed here, three mutually exclusive outcomes over an
arm's complete rungs. Let `band = 0.10 × bound` (2 ms voice, 3.33 ms video) —
derived from the gate, not from the data.

* **S1 — "M-independent within the measured envelope."** Every complete rung's
  `aggregateOneWay` p99 lies within `± band` of their mean. Published as: p99 did
  not move with M across the measured span, with the span stated. **No
  extrapolation past the largest complete M**, ever.
* **S2 — "M-dependent, growth measured."** The spread exceeds `± band` **and**
  V-H(b) passed. Published as the p99-vs-M table, as measured. **No functional
  form is fitted and none is quoted**; no extrapolation past the largest complete
  M.
* **S3 — "withheld."** The spread exceeds `± band` **and** V-H(b) failed. The
  growth is attributable to the conductor's routing, so no statement about the
  server's M-scaling is published at all.

Fewer than two complete rungs on an arm ⇒ **no statement for that arm**, stated
as such.

---

## §9 — Disclosures carried regardless of outcome

1. **Co-residence.** Publisher pool, sink pool and server share 4 vCPU / 8 GB.
   Every number carries it. §2 records the better placement and why it was not
   taken.
2. **Not M independent originators** (§3.1). Pooled sessions on one host.
3. **The phase-aligned arrival case is not covered** (§1.6).
4. **The 64 kbps voice payload is not covered**; pps is identical, bytes/s is
   not (§1.2).
5. **`WEBTRANSPORT_DATAGRAM_SEND_SYNC` is an open maintainer ruling** (K15) and
   it is the path every forward takes. Its state is recorded in the artifact. If
   the ruling reverses it, G8's numbers describe the other tree.
6. **No saturation search** (§5.1). Every rung is a fixed offered load.
7. **The mirror API does not exist** (K11) and G8 does not act on it. The
   per-target cost G8 pays is the cost of its absence, and ticket 34 owns that.
8. **K9 is struck** and no generator-headroom number is inherited from G4.
9. **G6 licenses nothing** (K20) — it has not run.
10. **kernel UDP counters** (`rcvbufErrors` in particular) are published per
    step whatever they say; ticket 02's kernel-drop-aware footing applies.

---

## §10 — Amendment protocol

Any change to this document after the first dispatch quotes the original text in
full, states what moved and why, and is committed **before** the run it affects.
An amendment made after seeing a G8 number must say so in its first sentence.
A rerun requires a declared, logged harness or infra fault (spec §Rerun policy);
a miss on a valid run is final.

---

## §11 — Candidate composition and base

Per spec §Candidate-tree composition: the candidate is `probe/g8-many-rooms-01`
rebased onto the staging SHA carrying the levers it rides. The base recorded here
is `rebind4-staging` @ `2a4145d0556a35f8b4a0849e5953927b5e028b64`, which contains
ticket 23's five lever fixes (K16).

**If `rebind4-staging` has moved past `2a4145d0…` at dispatch time**: re-derive
the base, amend this header *before* dispatch quoting the old SHA, and diff the
two staging SHAs for anything touching the datagram send path, the batch path or
the session accept path. G1's stamp asserted a merge-base equality in the present
tense that stopped being true two hours later; this document is written not to.

Candidate SHAs come from `git rev-parse` / `git ls-remote` only, never typed.

---

## §12 — Dispatch log

Every dispatch is logged here before it is read, including aborted ones.

| when | run id | candidate SHA | staging base | arms | outcome |
|---|---|---|---|---|---|
| — | — | — | — | — | *no dispatch yet* |
