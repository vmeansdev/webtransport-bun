# Pre-registration — Gate G6: MMO realm (steady realm · raid hotspot · reconnect storm)

**Status:** registered, no run. Written before any G6 harness code existed and
before the Ethernet cable this gate depends on was characterized.

**Ticket:** `.scratch/production-grade-scenarios/issues/30-gate-g6-mmo.md`
**Spec:** `.scratch/production-grade-scenarios/spec.md` rev 2 (§Process rules binding)
**Branch:** `probe/g6-mmo-01`
**Base:** `rebind4-staging` @ `2a4145d0556a35f8b4a0849e5953927b5e028b64`
(the `fix/lever-hardening-01` merge — the five lever fixes the conversion gates
ride). If `rebind4-staging` moves before dispatch, the candidate is **not**
rebased silently: §11 says what happens instead.

**One-sentence statement of what this gate asks.** Can this rig hold a
WoW-class realm — 5,000 players at MMO-typical rates, with the downstream the
server originates and batches — at an interaction latency a player would accept,
including through a raid hotspot and through the one thing nothing in this effort
has ever measured, a reconnect storm.

---

## 0. Disclosure ledger — everything already known that could inform a threshold

Read this before §2. Every number in this section existed before this document
was written; **none of it may be re-read after the run to move a bar.** The rule
the effort enforces is that a threshold comes from scenario arithmetic or from
prior *stamped* data, never from this gate's own run — so the prior data has to
be on the page, with its verdict status attached, up front.

| # | Fact | Where from | Verdict status of the source |
|---|---|---|---|
| K1 | 10,000 sessions × 0.2 pps (2,000/s, 100 B, no echo): delivery **1.000**, ingest p99 **2.945 ms**, committed marginal **128.142 KB/session** (1.0% deviation), host CPU median **104.2%** of 400 with a co-resident generator | G1, run `32207919468` | **PASS** (staggered arrival only) |
| K2 | A wall-clock-synchronized 10,000-session fleet at the same mean rate delivers **0.699**; the whole gap is kernel `RcvbufErrors` *ahead of* the server (70,385 vs a 70,358 gap). Linux knee is **below** 5,000 packets/impulse — the 5k rung showed 1,503 drops | T02, run `32192153026` | **CONFIRMED** attribution |
| K3 | Server ingest p99 **5.14 ms** [4.42, 5.79] at 10,000/s aggregate on the shipped default (100 sessions × 100/s, 1150 B, echo). The honest **co-resident** generator ceiling is between 10k and 15k/s | G2, run set from `32213…` | **INCOMPLETE-ON-THIS-RIG** (licenses a 10k statement + the rig finding; no 15k claim) |
| K4 | Frame-bursty egress at **35,200/s** read `egressOneWay` p99 **2.52 ms**; the 52,800/s rung's originator honesty failed | G3 phase 1 | **INCOMPLETE**, numbers published *verdict-less* |
| K5 | G3b's re-run is **INVALID** (validity falsifier V1 fired: `schedulerLag` p99 spread 2.28–3.85× across arms). Its ceiling (105,573/s), its C2 (1.130 ms) and its C3 all license **nothing** | G3b, run `32238304133` | **INVALID** |
| K6 | 1→50 fan-out of a 3 Mbps publisher: publisher→subscriber p99 **10.35 ms**, forward delivery **1.000**, forward egress **16.3k/s**, N decoupled from rate | G4, run `32216072119` | **PASS** (headroom context struck) |
| K7 | Stream/bulk gate produced **no verdict** (host saturation) | G5 | **NO-VERDICT** |
| K8 | The settled on-box ingest ceiling is **~103k/s** (Cubic loopback pipe ~105k); 160k needs a physical path | 160k ceiling attribution, `docs/research/2026-08-18-bandwidth-ceiling-attribution.md` | closed finding |
| K9 | A **1 GbE** cable at 1150 B payload has a wire ceiling of **~102,800 pps** (1216 B on the wire incl. preamble/IFG). 2.5 GbE would give ~257k | Ticket 29 §3, arithmetic | derivation, link speed **not yet observed** |
| K10 | **The accept-rate figures (449–700 accepts/s) are RETRACTED.** `acceptsPerSec × mean accept latency ≈ 500` at every rung = the generator's own connect semaphore. Little's law on a permit pool, not a server rate. **Accept capacity is unmeasured.** | four-axes doc line 81 | retraction, binding |
| K11 | On this Mac, idle, 20 sessions × 50/s, `--arrival uniform`: generator `scheduleLag` **871 µs mean, 40.6 ms max**. The max is **larger than this gate's entire RTT budget.** The Mac's floor must be measured on the day | Ticket 29 §4 | measured caution |
| K12 | Ticket 29's iperf3 UDP figure — "200 M at 1150 B → 21,738 pps delivered, 0 lost" — is an **offered rate that was met**, not a measured ceiling (200e6 ÷ 9200 bits = 21,739). It predicts **nothing** about the Mac's sink capability, in either direction | Ticket 29 §2, re-read here | correction registered before the run |
| K13 | GSO and GRO are **ACTIVE** on the runner at 64 segments; `/proc/net/snmp` is host-wide; no per-send GSO segment count exists | GSO probe + G3b C4 | standing disclosure |
| K14 | Levers landed on this base carry known defects: `send_datagram_batch` bypasses `spawn_counted` (invisible to the close-contract counters), and "one deadline per call" is false above 256 elements | final-round review, code-quality 1 & 2 | open defects, disclosed |
| K15 | `WEBTRANSPORT_DATAGRAM_SEND_SYNC` landed **default-ON** pre-soak; whether that stands is an **open maintainer ruling** | final-round review, process 0 | open ruling |

**What K10 costs this gate.** The reconnect-storm arm exists to measure accept
behaviour. K10 says the only prior accept numbers were the generator measuring
itself. §5 is written so that mistake cannot recur: the storm arm runs with **no
permit pool at all**, and the accept series is read from the **server's own**
session-established callback, never from client pacing. A Little's-law falsifier
(§7 V-L) is registered anyway, and if it fires the arm reports numbers **without
verdict force**.

**What K11 costs this gate.** A 40.6 ms schedule-lag maximum on an idle Mac is
inside the same order as the 50 ms round-trip bar. §7 V-F therefore makes the
Mac's same-day floor arm a **precondition**, evaluated on p99 with the max
disclosed beside it, and the gate clause is on the **raw** RTT p99 with nothing
subtracted (G1's rule).

---

## 1. Scenario arithmetic — every rate on this page, derived here

Nothing below is copied from a measurement. It is the MMO scenario, worked out.

### 1.1 Realm population

A WoW-class realm holds 2,500–5,000 concurrent players. **The gate rung is
5,000.** Two lower rungs run in the same ladder for shape and for a
pre-registered fallback statement (§2.6): **500 / 2,500 / 5,000**. Population is
the *only* variable across rungs — the per-player shape below is identical at
every rung, so a difference between rungs is a population effect and not a rate
effect.

### 1.2 Upstream: 4 pps/session, 64 B

An MMO client's steady upstream is a **movement/heading update on a fixed
cadence**, not a per-frame input stream: the client predicts locally and the
server reconciles. Classic-lineage MMOs heartbeat movement at roughly 2 Hz; a
modern realm at the responsive end runs **4 Hz**. Discrete actions (ability
press, target change, interact) are folded into the same tick rather than
counted separately — see §1.4.

- **4 pps/session**, i.e. a **250 ms** interval.
- Payload: an opcode, movement flags, position (3 × f32), orientation (f32), a
  client tick and a sequence ≈ **28 B** of real fields. The instrument (§6) adds
  a 48-byte stamp. **Payload = 64 B**, which is the stamp plus the movement
  record, and is the smallest payload that carries both honestly.
- Arrival process: **staggered** (session *i* of *N* phase-offset by *i/N* of
  one interval), exactly G1's registered process, for exactly K2's reason. The
  synchronized-fleet case is **not covered** by the steady arm; it is covered
  deliberately, and only, by the storm arm (§5).

**Aggregate upstream at the gate rung: 5,000 × 4 = 20,000 datagrams/s at 64 B.**

### 1.3 Downstream snapshot: 15 pps/session, 1150 B, batch-of-3 at 5 Hz

The realm server runs a world tick and, per tick, sends each player an
**interest-managed** snapshot: the deltas for entities inside that player's area
of interest, and nothing else. This is the class the batch emitter exists for.

- World snapshot tick: **5 Hz** (200 ms). Slower than the client's input rate on
  purpose — the client interpolates between snapshots.
- Snapshot size: a populated zone puts ≈ **50 entities** in a player's AoI, at
  ≈ **24 B** per entity delta (id + quantized position + state bits) ≈ 1,200 B
  of body, which does **not** fit one datagram at the rig's registered 1150 B
  payload. Split into **3 datagrams** per snapshot.
- **3 datagrams × 5 Hz = 15 pps/session at 1150 B.**
- **The batch is real, and is 3.** Each session's snapshot is issued as one
  `sendDatagramBatch([d0, d1, d2])`. This is why G6 uses the landed lever rather
  than describing it: 75,000 datagrams/s leave the server as **25,000 crossings/s**.

**Aggregate snapshot downstream at the gate rung: 5,000 × 15 = 75,000
datagrams/s at 1150 B, from 25,000 batch calls/s.**

**Emitter arrival process: spread, not aligned.** A server that computed all
5,000 snapshots in one instant would offer a 15,000-packet impulse every 200 ms —
the egress mirror of K2, and a shape no realm server actually has (they slice the
player list across the tick). The emitter therefore runs a **20 ms slice grid**
(50 Hz), 10 slices per snapshot tick, 500 sessions per slice, 1,500 datagrams per
slice. Sustained 75,000/s, no impulse. The aligned-egress variant is **not
covered** and no G6 number speaks for it.

### 1.4 Downstream ack: 0.5 pps/session, 64 B — the latency-bearing path

Snapshots are interpolated, so their delivery latency is not what a player feels.
What a player feels is the **ability-response loop**: press → server validates →
world confirms. That confirm is event-driven; a realm server does not hold it for
the next snapshot tick (holding it would cost up to a full 200 ms of tick
quantization, which by itself exceeds the budget derived in §1.6).

- An actively-playing character commits a discrete action about once per **2 s**
  (global-cooldown-paced) → **0.5 pps/session**.
- Mechanically: every **8th** upstream tick carries `class = ACTION`
  (4 pps ÷ 8 = 0.5 pps). Every ACTION draws exactly one **ack** datagram, issued
  by the server **on receipt**, not on the tick.
- Ack payload: **64 B** (the stamp plus a result code).

**Aggregate ack downstream at the gate rung: 5,000 × 0.5 = 2,500 datagrams/s.**

### 1.5 The gate rung's total load, stated plainly

| direction | rate | payload | note |
|---|---|---|---|
| upstream | 20,000/s | 64 B | 5,000 × 4 pps, staggered |
| downstream snapshot | 75,000/s | 1150 B | 25,000 batch calls/s of 3 |
| downstream ack | 2,500/s | 64 B | on-receipt, unbatched |
| **server total** | **97,500 datagrams/s** | | 20,000 in, 77,500 out |

**This is above every valid stamped number in this effort, and the pre-registered
expectation is that it may miss.** The valid egress stamps are G4's 16.3k/s
forward (K6) and G3's 35.2k/s published verdict-less (K4); G3b's higher figures
are INVALID (K5). 25,000 crossings/s is 1.53× K6. The settled ingest ceiling is
~103k/s (K8) and the server's *total* datagram traffic here is 97,500/s. A gate
is a product target, not something a run is tuned to clear — §9 registers what
this gate predicts, and a miss is final.

### 1.6 The RTT bound: 50 ms p99, derived from the MMO interaction budget

**Not the FPS/camera frame budget.** G3 and G4 use 33.3 ms because a 30 fps frame
is the deadline a camera pipeline misses. An MMO has no frame deadline on the
wire: the client interpolates. Its deadline is *perceptual*, on the ability loop.

Budget, end to end, for the ability-response loop:

```
player-perceived ability response, p99 target            150 ms
  − client input sampling (1 frame @ 60 fps)            − 16.7 ms
  − internet path RTT (regional, typical)               − 60.0 ms
  − client render of the confirmation (1 frame)         − 16.7 ms
  ───────────────────────────────────────────────────────────────
  = budget for the whole server-side round trip           56.6 ms
```

150 ms is the point at which MMO players report "spell delay" as a defect;
below it the loop reads as responsive. Rounding the residue down:

> **RTT p99 bound: 50 ms**, measured client-send → server → ack → client-receive,
> on the **ack** class, on the client's single clock.

That this lands on the same number as G1's ingest bound is a coincidence of two
independent derivations and must not be read as one bound being reused.

### 1.7 The hotspot: N = 40, publisher 20 pps, one-way bound 25 ms

- **N = 40** is the classic raid size and the largest standard AoI cohort an MMO
  has to fan a single event source to. It is chosen as the scenario's worst case,
  not from a measurement.
- Publisher rate: during a boss encounter, 40 players each commit roughly one
  GCD-paced action per 1.5 s ≈ 27/s, plus boss abilities. **20 pps** is the
  rounded encounter-event rate for one event source.
- Forward load: 20 × 40 = **800/s**, which is deliberately small beside 77,500 —
  the hotspot arm is a **tail statement under load**, not a throughput arm. It
  runs with the full steady realm behind it, because an empty-realm raid proves
  nothing.
- **One-way bound: 25 ms p99.** The 50 ms round trip of §1.6, of which event
  delivery is one leg.

### 1.8 The storm: cohorts of 1,000 and 5,000

- **S1 — 1,000 of 5,000 (20%)** models a partial outage: an upstream link or one
  ISP drops a fifth of a realm. 4,000 survivors remain, which is what makes the
  survivors clause (§5.3) measurable at all.
- **S2 — 5,000 of 5,000 (100%)** models the canonical MMO event: a realm restart,
  where every player reconnects at once. There are no survivors, so S2 carries
  only the completion clause and the characterization.

Sever mechanism, and what it deliberately excludes: severed clients issue an
**abrupt application close**, modelling a client-side disconnect or crash. A
*silent* black-hole storm (the client vanishes, the server learns via the idle
timeout) is **not covered**: at a 60–120 s idle timeout the server's teardown
would dominate the window and the arm would measure the reaper rather than
accept behaviour. That case is disclosed as uncovered, not measured.

Reconnect delay: **1,000 ms** after the sever — an MMO client retries
immediately. Reconnect concurrency: **the whole cohort at once, no permit pool**
(§0 K10). This is the aligned-arrival case G1 excluded, embraced on purpose, on
K2's footing.

---

## 2. Arm 1 — steady realm. Clauses, and the ladder.

Ladder: **500 / 2,500 / 5,000** sessions. Per-session shape identical at every
rung (§1.2–§1.4). Steady window **120 s**, drain grace **1,000 ms**, idle tail
**30 s**, settle **15 s** with a `sessionsActive → 0` drain barrier between
rungs. Generator off-box on the Mac over the cable.

Every clause below is evaluated on the **5,000** rung. §2.6 says what the lower
rungs license.

### C1 — upstream delivery ≥ 0.995

`serverRx(steady+drain) / clientEnqueued(steady)`, phase-aligned, per spec
§Metric definitions. 0.995 is G1's registered bar, carried unchanged: it is the
same quantity on the same instrument.

### C2 — downstream delivery ≥ 0.995, per class

Measured at the **client sink**, both classes separately:
`clientReceived(class) / serverIssued(class)` over the same window, where
`serverIssued` counts the emitter's *completed* sends (`{sent}` from the batch
envelope, summed), not its intentions.

Both classes must clear 0.995. Reporting one aggregate ratio would let 75,000
snapshots hide a failing ack path, which is the path the gate's latency clause
lives on.

### C3 — ack RTT p99 ≤ 50 ms (raw)

Client-send → server → ack → client-receive, on the client's single
`CLOCK_MONOTONIC` (§6.2). **Raw p99. Nothing subtracted.** The Mac's floor arm
(§7 V-F) is reported beside it, and the floor is a validity precondition, never
a subtrahend. Bound derived §1.6.

Reported beside it and *not* clause-bearing: p50, p90, p999, max, the sample
count, and the server's own dwell `holdNs` distribution (§6.3), which separates
"the server was slow" from "the path was slow" without either being subtracted
from the clause.

### C4 — every session alive at arm end

`sessionsLost == 0` on the client and `sessionsActive == rung size` on the
server at the end of the steady window. A realm that drops players under steady
load has failed regardless of its percentiles.

### C5 — stage ledger closes (server-side statement)

G1's C4, carried verbatim because the mechanism it guards (K2) is live here:
per-stage residuals `|residual| ≤ 0.1%` of `clientEnqueued` at ingress, kernel
and native stages, and `serverObserved ≥ 0.995 × kernelDelivered`.

Taps: `clientEnqueued` (client `send_datagram` → Ok), `clientWireTx` (quinn
`frame_tx.datagram`), kernel per-socket `drops` + `/proc/net/snmp RcvbufErrors`,
`serverObserved` (`datagramsIn`), `jsDelivered` (harness receive count),
`datagramsDropped*` by reason, `datagramsSkippedQueueFull`.

**A tap that did not read is `null`, never `0`.** If both kernel sources are
`null`, C5 is **INCOMPLETE**, not PASS — G1's registered branch.

### C6 — the emitter sourced the load

`emittedFraction = serverIssued / (rung × 15 × windowSec) ≥ 0.99` for the
snapshot class and `≥ 0.99` of the observed ACTION arrivals for the ack class;
`sendEventsSkipped == 0`; `sendErrors == 0`; batch envelopes report
`sent == requested` on every call (partial completion is counted and disclosed,
and any non-zero count fails C6).

**Overall arm 1 verdict = C1 ∧ C2 ∧ C3 ∧ C4 ∧ C5 ∧ C6** on the 5,000 rung, on
one valid run, with every §7 falsifier passing.

### 2.6 What the lower rungs license — registered now, not after

If the 5,000 rung misses, the 2,500 and 500 rungs are **published as rungs**.
A lower rung licenses a statement about a realm of *its own* population **only
if it meets C1–C6 by the same arithmetic**, and such a statement is explicitly
**not** the G6 gate verdict — G6 is the 5,000 rung and nothing else. This is
written here so that a lower rung cannot be promoted into the headline after the
top rung disappoints. The committed-memory marginal across rungs is reported for
shape and, per G1 D1 §2, **may not be multiplied out into a provisioning claim.**

---

## 3. Arm 2 — raid hotspot (1 → 40), under the steady realm

Three processes, all on the Mac (ticket 14's registered shape):

1. **publisher** — 1 session, 20 pps, stamped, its own process.
2. **realm** — the 5,000-session steady arm of §2, running behind it.
3. **raid subscribers** — 40 sessions, receive-only, their own process.

The server forwards every publisher datagram to all 40 raid-member sessions.

**One-way is valid here and this is worth stating.** Publisher and subscriber are
different processes on the *same host*, so the stamp is written and read on one
`CLOCK_MONOTONIC`. The datagram crosses to the other host and back, but the
measurement never does. Ticket 29's "RTT-gated designs only" constrains
client↔server legs; it does not constrain a Mac-to-Mac one-way that happens to
route through the runner.

### H1 — publisher→subscriber one-way p99 ≤ 25 ms (raw, §1.7)
### H2 — forward delivery ≥ 0.995 (`received / (ingested × 40)`)
### H3 — the steady realm's C1/C3 still hold during the hotspot window

An empty-realm raid proves nothing (ticket), and a raid that costs the realm its
latency is a finding, not a footnote.

### H4 — ingest-reality falsifier (ticket 14, verbatim)

Publisher→server ingest must be demonstrably real: `ingestToForwardP50 ≥ 100 µs`
(3.2× the top of the retracted run's 9–31 µs signature), the publisher's frame
cadence visible in the server's own inter-arrival gaps inside the registered
band, and ≥ 99% of arrivals carrying a decodable publisher stamp. Any failure →
**arm 2 INVALID**, not a slow number.

### H5 — sink pre-check (ticket 14, adapted; see §7 V-S)

The 40-subscriber process must be shown not to be the binding constraint.

**N is not swept.** N-decoupling was G4's registered obligation and was
discharged there (K6). G6 fixes N = 40 by scenario (§1.7) and makes no
N-scaling claim.

---

## 4. What G6 is *not*

Registered as an exclusion so it cannot be read in later:

- **G6 is not a lever A/B.** It runs exactly one emitter shape — the batch
  emitter — because that is what a realm server would use (§1.3). It contains no
  serial/pipelined comparison arm and produces **no** send-batch measurement.
  That comparison is G3's, and G3 is INCOMPLETE.
- Consequently, **no V1-style cross-arm `schedulerLag` agreement clause is
  registered.** G3b proved (K5) that an in-process scheduler cannot be decoupled
  from the emitter's CPU on one event loop; a cross-arm agreement clause is
  therefore unmeetable in-process and there are no arms here to compare. §7
  registers the falsifiers that *are* meetable instead.
- G6 makes no claim about aligned-arrival *steady* load (§1.2), aligned egress
  (§1.3), silent black-hole storms (§1.8), N ≠ 40 (§3), or any population above
  5,000.

---

## 5. Arm 3 — reconnect storm. The never-measured axis.

Phases, in order, one arm:

```
connect 5,000 → steady 60 s → SEVER cohort → 1,000 ms → RECONNECT (all at once)
  → storm window 120 s → post-storm steady 60 s → idle 30 s
```

Run twice: **S1 cohort = 1,000**, then **S2 cohort = 5,000**, S2 after the realm
has re-stabilized.

### 5.1 The arrival shape, registered honestly

A storm **is** synchronized. The cohort reconnects with **no permit pool** —
connect concurrency equals the cohort size — so there is no semaphore for Little's
law to be measuring (K10). The client's connect concurrency is recorded in the
artifact as a registered property either way, and §7 V-L checks it anyway.

### 5.2 Kernel-drop footing (K2), and why alignment is admissible here

A 1,000- or 5,000-session simultaneous reconnect is a 1,000/5,000-packet Initial
impulse, above the Linux knee K2 established. **Non-zero `RcvbufErrors` and
per-socket drops are expected during the storm window and are disclosed, not
disqualifying.** The mechanism differs from G1's in the way that matters: a
dropped QUIC **Initial is retransmitted by the client**, whereas a dropped
DATAGRAM is gone. Kernel pressure in a storm therefore shows up as **latency in
the accept series**, not as loss — which is why alignment is admissible here and
was not in G1.

Both kernel sources are read across the storm window and reported whatever they
say. A `null` read is reported as `null`.

### 5.3 S-C1 — the survivors clause (gated, S1 only)

During the storm window, the sessions that were **not** severed must hold:

- ack RTT **p99 ≤ 50 ms** (§1.6 — the budget does not change because someone
  else reconnected), and
- upstream delivery **≥ 0.995**, and
- `sessionsLost == 0` among survivors.

Survivor metrics are computed over the survivor cohort alone, from per-session
accounting — never from a realm-wide aggregate that the reconnecting cohort's
own traffic would contaminate.

S2 has no survivors and therefore no S-C1.

### 5.4 S-C2 — the completion clause (gated, S1 and S2)

Every severed session is re-accepted by the server, and the realm returns to full
population, **within the 120 s storm window**, with no server fault:
`limitExceededCount` delta 0, `rateLimitedCount` delta 0, and
`sessionsActive` back to the rung size at window close.

**Derivation of 120 s:** twice the shipped `idleTimeoutMs` default of 60 s. A
reconnect slower than two of the server's own idle timeouts is indistinguishable
from a dead realm to the server's own reaper. This is a product constant, not a
number from a run.

### 5.5 S-M — the characterization (published, **no verdict force**)

The axis has never been measured, so it is measured, not graded. Reported:

- **Accept-completion series** at 1 Hz, from the **server's** own
  session-established callback — a monotone count of sessions the server
  established, timestamped on the server. This is the measurement K10's
  retraction demands. Client-side connect timing is reported separately and is
  never the accept rate.
- **Time to 50 / 90 / 99 / 100 %** of the cohort re-accepted, from that series.
- **Peak `handshakesInFlight`** and the server's `handshakeLatency` histogram
  delta across the storm window.
- **`sessionsClosedByIdle` / `sessionsClosedByReap` / `sessionsClosedOther`**
  deltas across the sever, so the sever's own accounting is visible.
- Kernel UDP counters across the storm window (§5.2).
- Server and host CPU, windowed over the storm window (never cumulative).

None of these carry a bar. Registering a bar on a quantity nobody has ever
measured would be inventing a gate, which is the mirror image of the failure the
effort's rules exist to prevent.

---

## 6. Instruments

### 6.1 The stamp — version 3

`tools/load/latency-stamp.ts` and `crates/reference/src/latency_probe.rs` gain a
version 3, additively. v1 and v2 keep decoding exactly as today.

| offset | size | field |
|---|---|---|
| 0 | 2 | magic `0x4C54` |
| 2 | 2 | version |
| 4 | 8 | intended send, ns |
| 12 | 8 | actual send, ns |
| 20 | 8 | sequence |
| 28 | 8 | echo actual, ns (v2+) |
| 36 | 8 | **`holdNs` — server dwell, a duration (v3)** |
| 44 | 1 | **`class` (v3)** |
| 45 | 3 | reserved, zero |

`STAMP_BYTES_V3 = 48`. Classes: `MOVE = 0`, `ACTION = 1`, `ACK = 2`,
`SNAPSHOT = 3`, `RAID = 4`.

**Clock discipline, stated because the two directions are not symmetric.** On the
**upstream** leg `actual` is the client's clock. On the **downstream** leg
`actual` is the *server's* clock and is never differenced against a client
instant; the only client-clock quantity on a downstream datagram is
`echoActual`, which is the client's own earlier `actual` reflected back.
`holdNs` is a **duration** measured entirely on the server (receive → send), so
it crosses hosts safely.

### 6.2 RTT

`RTT = clientReceiveNs − echoActualNs`, both from the client's
`CLOCK_MONOTONIC`. Recorded into the shared log-linear histogram
(`subBits = 8`, ≤0.4% relative error), so client and server percentiles are
computed by identical arithmetic.

### 6.3 Server dwell

`holdNs = serverSendNs − serverReceiveNs` on the ack path, recorded server-side
into the same histogram shape and reported beside C3. It is **never** subtracted
from the clause.

### 6.4 Generator honesty

Client `scheduleLag` (actual send − nearest scheduled deadline) recorded on the
Mac over the same window, reported beside every latency percentile. The floor arm
is §7 V-F.

### 6.5 Emitter honesty

Emitter lag is measured at the **scheduler handoff** — the interval between the
slice's scheduled deadline and the instant the emitter *hands the batch to the
send path* — and **never across `await send(...)`**. That was G3's defect 1 (the
metric absorbed the product's own send latency). `sendEventsSkipped`,
`sendErrors` and the batch `{sent}` envelope are counted separately.

---

## 7. Validity falsifiers — the run is INVALID if any fires

A falsifier firing is a **harness/infra fault** under spec §Rerun policy, not a
gate miss. Every one of these is implemented as a pure function in
`tools/load/g6-classify.ts` with unit tests that feed it the failing signature —
**because G3b's V1 lived only in a hand derivation until it was too late**, and
`classified.json` carried no field for it.

| id | fires when | why it exists |
|---|---|---|
| **V-C** cable | No same-day pre-flight artifact, **or** `evaluatePreflight` fails either registered requirement (§8) | Ticket 29's STOP template. A gate run over an uncharacterized path is not evidence |
| **V-F** floor | Mac floor-arm `scheduleLag` p99 > **10 ms** (20% of the 50 ms bound), or the floor arm was not taken on the same day, or `floorReportIsUsable` refuses it (wrong host, zero driving sessions) | K11: a 40.6 ms lag maximum on an idle Mac is inside the bound's order of magnitude |
| **V-S** sink | Mac sink pre-check fails: cannot sustain **1.5 ×** the arm's downstream rate at ≥ 0.995 delivery, measured **on Mac loopback** (the cable cannot carry 1.5 × 77,500) | The sink is the constraint most likely to bind, and K12 says nothing prior predicts it |
| **V-N** negatives | **Any** RTT or one-way histogram reports `negative > 0` | Both ends of every latency measurement here are on one clock; a negative is impossible and means the instrument is wrong |
| **V-K** skew | `recordedTotal − count > 0.1%` of `count` on any histogram the gate reads | G3b's second defect: percentiles over a subset whose size differs across what is being compared |
| **V-D** denominator | Any latency percentile computed over fewer samples than the run's own counters say were delivered on that path (`count ≠ delivered − unstamped`) | The same defect, stated as an equality the artifact must satisfy |
| **V-L** Little | `acceptRate × meanAcceptLatencySec` lands within ±20% of the client's configured connect concurrency **and** that concurrency is finite | K10, exactly. If it fires, §5's accept numbers publish **without verdict force** and the arm's characterization says so |
| **V-G** generator | Upstream `offeredRatio` < **0.99** at any measured rung | The Mac is a new generator host at a rate no one has driven from it |
| **V-I** ingest-real | §3 H4 fails | Ticket 14, verbatim |

**V-L is the one exception to "INVALID kills the run":** it does not invalidate
arms 1 and 2, and it does not invalidate S-C1/S-C2. It strips verdict force from
**S-M only**, which is already a characterization.

**None of these are computed by reading a boolean out of the classifier and
trusting it.** The gate agent recomputes every clause and every falsifier from
the raw artifact fields, as G1 and G3b did.

---

## 8. The cable STOP — registered requirements

The gate run is **INVALID** unless a pre-flight artifact from **the same
calendar day**, produced by `tools/offbox/preflight.ts`, satisfies **both**
requirements below via
`evaluatePreflight(artifact, requirement)` from `tools/offbox/preflight-lib.ts`:

| requirement | offeredPps | payloadBytes | maxLossPct | minMtuBytes | maxIdleRttP99Ms |
|---|---|---|---|---|---|
| **R-down** | 75,000 | 1150 | 0.1 | 1280 | 5 |
| **R-up** | 20,000 | 64 | 0.1 | 1280 | 5 |

- **0.1% loss bound** is derived: C1/C2 allow 0.5% end-to-end loss, and the link
  may contribute at most a fifth of that budget.
- **MTU 1280** is QUIC's minimum and is what a 1150 B payload plus QUIC/WT
  framing needs inside one datagram.
- **Idle RTT p99 ≤ 5 ms** is derived as 10% of the 50 ms bound: a path whose
  idle tail already spends a tenth of the budget cannot carry a latency gate.

**K9 is the live risk on R-down.** A 1 GbE link carries ~102,800 pps at 1150 B,
so 75,000 pps is **73% of the wire** and the headroom ratio is 1.37×. If the
cable negotiates 1 GbE, R-down may fail on loss well before the arithmetic
ceiling. **If R-down fails, the gate does not run** — no partial arm, no
loopback substitute, no "we'll just report the 2,500 rung from a different
path". The negotiated link speed is recorded in the artifact.

---

## 9. Registered predictions

Written to be falsifiable, before any data. Scored in the stamp, one by one.

1. **P1** — R-down is the binding pre-flight requirement, not R-up; if anything
   fails the cable STOP it is the 75,000 pps downstream rung.
2. **P2** — The Mac's floor-arm `scheduleLag` p99 comes in **below 5 ms** even
   though K11 saw a 40.6 ms maximum, because the maximum was a single outlier on
   an unloaded box and p99 is not max.
3. **P3** — The 5,000 rung **misses at least one of C2/C3**, because 97,500
   datagrams/s of server-side traffic is within 5% of the settled ~103k ceiling
   (K8) and the emitter's 25,000 crossings/s is 1.53× the highest *valid* stamped
   egress figure (K6).
4. **P4** — The 2,500 rung (48,750 datagrams/s total) **meets C1–C6**.
5. **P5** — Storm S1's accept series shows non-zero kernel `RcvbufErrors` in the
   storm window and **still** completes inside 120 s, because Initials retransmit
   (§5.2).
6. **P6** — V-L does **not** fire, because the storm arm has no permit pool.
7. **P7** — Server dwell `holdNs` p99 on the ack path is **under 5 ms** at the
   2,500 rung and **above 5 ms** at the 5,000 rung — i.e. if C3 misses at 5,000,
   it misses inside the server, not on the wire.

---

## 10. Rerun, amendment and honesty rules

- **One complete run stamps.** A rerun requires a declared, logged
  harness/infra fault. A miss on a valid run is **final** and routes to its
  mechanism ticket.
- **No threshold in this document moves after data exists.** Amendments before
  the first dispatch quote the original text in full and say what changed and
  why. There are no amendments after the first dispatch.
- **A third registration is not available**, per the G3b precedent.
- Every dispatch is logged in §12, **including aborted ones**. A run that is not
  in that table did not happen.
- The classifier is not the verdict. Every clause is recomputed from the raw
  artifact by the gate agent.
- Local macOS smoke output is **never** a result (standing rule).

## 11. Candidate composition

Candidate = `probe/g6-mmo-01` at the SHA recorded in §12, whose merge-base with
`rebind4-staging` must equal the base SHA in the header. The candidate is never
merged back. Candidate SHAs come from `git rev-parse` / `git ls-remote` only.

**If `rebind4-staging` has moved past `2a4145d0…` at dispatch time:** the base is
re-derived, this header is amended *before* the dispatch with the old SHA quoted,
and the diff between the two staging SHAs is inspected for anything touching the
datagram send path, the batch path or the accept path. G1's stamp asserted a
merge-base equality in the present tense that stopped being true two hours later
(final-round, prereg-drift 6); this document states its base as of dispatch and
says so.

## 11a. Amendment 1 — the AoI figure, corrected before any dispatch

**Written before the first dispatch. The dispatch log in §12 is empty, and this
amendment is what made me check it: mechanizing §1.3 in `tools/load/g6-plan.ts`
showed the stated arithmetic does not produce the stated result.**

Original text of §1.3, verbatim:

> - Snapshot size: a populated zone puts ≈ **50 entities** in a player's AoI, at
>   ≈ **24 B** per entity delta (id + quantized position + state bits) ≈ 1,200 B
>   of body, which does **not** fit one datagram at the rig's registered 1150 B
>   payload. Split into **3 datagrams** per snapshot.

50 × 24 B = 1,200 B, which is `ceil(1200 / 1150) = 2` datagrams, not 3. The
number 3 was right for the scenario I meant and wrong for the AoI figure I
wrote down.

**Changed to:**

> - Snapshot size: a **contested zone or capital cluster** puts ≈ **100
>   entities** in a player's AoI — players, pets and NPCs in view where a realm
>   is actually under load — at ≈ **24 B** per entity delta ≈ 2,400 B of body,
>   which is `ceil(2400 / 1150)` = **3 datagrams** per snapshot at the rig's
>   registered 1150 B payload.

**Why 100 and not "whatever makes 3".** The gate takes the demanding end of
every scenario axis it registers: 5,000 players (top of the 2,500–5,000 range),
a 40-player raid (the largest standard cohort), the populated-zone AoI. 100
entities is that axis's demanding end and it is the figure the scenario was
always about; 50 is the median quiet zone. **The quiet-zone shape (2 datagrams
per snapshot, 10 pps/session, 50,000/s aggregate at the gate rung) is registered
as NOT COVERED** and no G6 number speaks for it.

**What this does and does not move.** Every derived figure in §1.5, §8 and §9 is
unchanged, because they were all computed from the 3-datagram snapshot: 15
pps/session, 75,000/s snapshot aggregate, 25,000 crossings/s, 97,500/s server
total, R-down at 75,000 pps. **No threshold moved.** What moved is one scenario
constant, so that the arithmetic on the page produces the numbers the page
already claimed.

The constant now lives in `tools/load/g6-plan.ts` (`AOI_ENTITIES = 100`) and its
unit test asserts the 3-datagram result, so this class of drift cannot recur
silently.

## 11b. Amendment 2 — the ingest-reality falsifier, made measurable off-box

**Written before the first dispatch. §12 is empty. Found by the local wiring
smoke, which is what a smoke is for: the harness reported a 14 µs
"ingest-to-forward" on a run where nothing was wrong.**

Original text of §3 H4, verbatim:

> Publisher→server ingest must be demonstrably real: `ingestToForwardP50 ≥ 100
> µs` (3.2× the top of the retracted run's 9–31 µs signature), the publisher's
> frame cadence visible in the server's own inter-arrival gaps inside the
> registered band, and ≥ 99% of arrivals carrying a decodable publisher stamp.
> Any failure → **arm 2 INVALID**, not a slow number.

**The defect.** Ticket 14's `ingestToForwardP50Ns` is "publisher actual-send →
first forward issued". On-box — which is where G4 discharged it — publisher and
server shared one clock and that subtraction was legal. **Off-box it spans two
hosts and cannot be computed at all.** What the harness can compute server-side
is *arrival → first forward issued*, which is one process on one clock and is
therefore µs-scale on **every** valid run. Registering that quantity against a
µs-signature floor would fire the falsifier against reality on every G6 run,
which is worse than not having it.

**Changed to:**

> Publisher→server ingest must be demonstrably real:
>
> * **`pathP50 ≥ 100 µs`**, where `pathP50` is the p50 of publisher-send →
>   subscriber-receive **on the subscribers' own clock** (both processes on the
>   Mac, §3). This covers ticket 14's question strictly more strongly than the
>   original: the interval contains two cable traversals and the whole server
>   path, so an in-process source cannot produce it, and it is measurable.
> * the publisher's frame cadence visible in the server's own inter-arrival gaps
>   inside the registered band (unchanged, server-local), and
> * ≥ 99% of arrivals carrying a decodable publisher stamp (unchanged; an
>   in-process source could not carry the publisher's clock at all).
>
> Any failure → **arm 2 INVALID**, not a slow number.
>
> The server-internal **`serverForwardDwell`** (arrival → first forward, one
> clock) is still recorded and **published as a disclosure**. It is explicitly
> not a falsifier input, and its expected µs-scale value is stated here so a
> reader does not mistake it for the retracted signature.

**No threshold moved:** the 100 µs floor, the cadence band and the 99%
provenance fraction are unchanged; one of the three now reads a quantity that
exists. The change is enforced in `tools/load/g6-classify.ts`
(`HotspotFacts.pathP50Ns` / `serverForwardDwellP50Ns`) and pinned by a unit test
that asserts the dwell cannot fire the rule.

## 11c. Dispatch plan — gated on the cable pre-flight artifact

Nothing below runs until step 0 produces a green artifact. **No green same-day
pre-flight at this gate's rates → no run.** That is the STOP, not a guideline.

**Step 0 — cable day, on the Mac (human + ssh, ticket 29 §"What remains").**
The runbook's ten steps, then:

```
bun tools/offbox/preflight.ts --peer <runner bench IP> --payload-bytes 1150 \
    --out .bench-evidence/g6-preflight-<date>.json
bun tools/offbox/preflight.ts --peer <runner bench IP> --payload-bytes 64 \
    --out .bench-evidence/g6-preflight-up-<date>.json
```

Then, off-runner, evaluate **both** §8 requirements with
`evaluatePreflight(artifact, requirement)` using
`preflightRequirements()` from `tools/load/g6-plan.ts`. Record the negotiated
link speed. **If R-down fails, stop and report; do not substitute a lower rung,
a loopback path or the loadgen VM.**

**Step 0b — the two same-day honesty arms on the Mac**, both required before
the gate run and both evaluated by §7:

* **floor arm (V-F)** — the realm role at a trivial rate, `--sessions 20`, on
  the Mac, through the same `mac-generator-entry.sh` path the gate uses, checked
  with `floorReportIsUsable(report, <mac host>)`. Report p99 **and** max.
* **sink pre-check (V-S)** — Mac **loopback**, driving 1.5 × 77,500 ≈ 116,250
  downstream pps into the subscriber shape. Loopback because the cable cannot
  carry 1.5× the arm; the question is the sink's capability, not the wire's.

**Step 1 — one dispatch**, `bench-bandwidth` workflow, ref `probe/g6-mmo-01`:

| input | value |
|---|---|
| `candidate_commit` | the branch SHA from `git rev-parse`, never typed |
| `mode` | `g6-mmo` |
| `g6_arms` | `steady,hotspot,storm` |
| `g6_ladder` | `500,2500,5000` |
| `g6_steady_seconds` | `120` |
| `g6_offbox_ssh` | the Mac's ssh destination — **empty is a wiring check, never a G6 result** |
| `g6_server_address` | the runner's bench-subnet address |

Expected runner wall clock ≈ 25 min: three steady rungs (~3.5 min each), the
hotspot arm (~3.5 min), two storm arms (~5 min each), plus settle barriers.
Inside the effort's remaining budget as one dispatch.

**Step 2 — stamp.** Recompute every clause and every falsifier from the raw
artifact with `g6-classify.ts`, never by reading a boolean out of it. Log the
run in §12 whatever the outcome, including an abort. A miss is final.

**What would make this run invalid before it starts,** in the order it is
checked: no green same-day pre-flight (V-C) · a floor arm from the wrong day,
the wrong host, or above 10 ms p99 (V-F) · no sink pre-check at 1.5× (V-S) ·
`g6_offbox_ssh` empty, which is not a falsifier but is a disqualification: a
co-resident generator is the confound the cable exists to remove.

## 12. Dispatch log

Every dispatch of this gate, including aborted ones. A run that is not in this
table did not happen.

| # | date | run id | candidate SHA | staging base | pre-flight artifact + date | arms | outcome |
|---|---|---|---|---|---|---|---|
| A1 | 2026-08-19 | *none — never dispatched* | `523fcd161236451a6e1c2dfb968d0469555cafde` | `2a4145d0556a35f8b4a0849e5953927b5e028b64` | `preflight-1150.json` (2026-08-19T14:11:58Z), `preflight-64.json` (2026-08-19T14:16:56Z) | *none taken* | **ABORTED before dispatch — V-C fired on R-up** |

### A1 — pre-dispatch abort, 2026-08-19

Step 0 of §11c was executed on the Mac and both artifacts were evaluated through
`evaluatePreflight` against `preflightRequirements()`. **R-down passes, R-up
fails, so the §8 cable STOP fires and the gate does not run.** No arm was taken,
no dispatch was made, and no threshold in this document was touched.

| requirement | offered | payload | verdict | clean ceiling @ 0.1% | headroom | MTU | idle RTT p99 |
|---|---|---|---|---|---|---|---|
| **R-down** | 75,000 pps | 1150 B | **PASS** | 81,508 pps | 1.087× | 1500 B | 4.967 ms |
| **R-up** | 20,000 pps | 64 B | **FAIL** | *none* | — | 1500 B | 2.583 ms |

`evaluatePreflight` returns exactly one reason on R-up: `no UDP rung at 64 B
stayed under 0.1% loss`.

**The mechanism, stated honestly.** This is not a measurement showing the link
cannot carry 20,000 pps at 64 B. It is the *absence* of any measurement that
speaks to R-up. `preflight.ts` defaults `--rates-mbit` to
`[100,250,500,750,900,1000]`, a ladder sized for 1150 B where 100 Mbit/s is
~10,900 pps. The 64 B run changed `--payload-bytes` and left the ladder alone,
so every rung landed 18× higher in pps than intended: the **lowest** rung
measured was 77,297 pps — 3.9× the requirement — and at that rate the path is
already sender/receiver-bound at 0.157% loss. All five rungs sit between 0.157%
and 0.505%, so `derivePpsCeiling(…, 0.1)` finds no clean rung and returns
`null`. The requirement's own rate was never offered.

**This falsifies P1** (§9), which predicted R-down would be the binding
pre-flight requirement. R-down passed; R-up is what stopped the gate. P1 is
scored a miss on the record, and it is scored against the *procedure* — the
prediction was about the link, and the link was never asked the question.

**What is not licensed by this row.** Not a lower gate rung, not a loopback
substitute, not the loadgen VM, and not reading R-up off the 1150 B artifact.
§8 is explicit and it was followed.

**The single unblocking action**, for whoever takes it: re-run step 0's second
command with a ladder that brackets 20,000 pps at 64 B (20,000 × 64 × 8 =
10.24 Mbit/s, so e.g. `--rates-mbit 10,25,50,100`), same calendar day as the
dispatch. That re-runs the registered tool at the registered requirement; it
moves nothing. Both honesty arms (V-F floor, V-S sink) must then also be taken
on the dispatch day, since both are same-day preconditions.

**State of the other pre-dispatch checks at abort time:**

- **Candidate (§11)** — verified from `git ls-remote` / `git merge-base`, never
  typed. `probe/g6-mmo-01` head is `523fcd161236451a6e1c2dfb968d0469555cafde`
  and its merge-base with `rebind4-staging` is
  `2a4145d0556a35f8b4a0849e5953927b5e028b64`, equal to the header's base.
  Staging has **not** moved, so §11's re-derivation clause does not apply.
- **V-F floor** — **not taken.** Blocked by the STOP above, and the host was in
  no state to produce one: load average 7.79 / 11.55 / 11.62 at 16:24 local. A
  floor measured under that is not this machine's floor. The
  `mac-generator-entry.sh` contract was verified non-destructively with
  `--plan`: full SHA accepted, 7-character abbreviation refused (exit 3),
  `~/wt-macgen` clean, candidate object present, `load-client` release binary
  in place.
- **V-S sink** — **not taken.** Same reason.

## 13. Verdict

*Not yet run.* The first attempt aborted before dispatch on the §8 cable STOP;
see §12 row A1.
