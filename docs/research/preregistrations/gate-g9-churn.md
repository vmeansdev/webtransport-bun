# Pre-registration — Gate G9: sustained session churn

**Status:** registered, no run. Written before any G9 harness code existed.

**Ticket:** `.scratch/production-grade-scenarios/issues/33-gate-g9-sustained-churn.md`
(scope ruling 2026-08-19, option c: **this gate is in the pre-soak all-PASS bar**)
**Spec:** `.scratch/production-grade-scenarios/spec.md` rev 2 (§Process rules binding)
**Branch:** `probe/g9-churn-01`
**Base:** `rebind4-staging` @ `2a4145d0556a35f8b4a0849e5953927b5e028b64`
(the `fix/lever-hardening-01` merge). If `rebind4-staging` moves before
dispatch, the candidate is **not** rebased silently — §11 says what happens.

**One-sentence statement of what this gate asks.** Can this server sustain a
laddered arrival of short-lived request/response sessions — connect, exchange,
close, forever — while it is already serving a population of long-lived
sessions, at a handshake tail a user would not notice, without leaking a single
handle.

**What is new here that no prior arm measured.** G6's storm arm measures a
*burst* of reconnects and how long the realm takes to re-quorum. G9 measures a
*rate* held indefinitely. The two are different questions and they fail
differently: a burst is bounded by admission concurrency, a sustained rate is
bounded by the slowest of admission, the per-source token bucket, the
concurrency budget, and whatever the teardown path fails to release. Only the
last of those can leak, and only a sustained arm can see it.

---

## 0. Disclosure ledger — everything already known that could inform a threshold

Read this before §2. Every number here existed before this document was
written; **none of it may be re-read after the run to move a bar.** A threshold
comes from scenario arithmetic, from the shipped configuration, or from prior
*stamped* data with its verdict status attached — never from this gate's own
run.

| # | Fact | Where from | Verdict status of the source |
|---|---|---|---|
| K1 | **The accept-rate figures (449–700 accepts/s) are RETRACTED.** `acceptsPerSec × mean accept latency ≈ 500` at every rung = the generator's own connect semaphore. Little's law on a permit pool, not a server rate. **Sustained accept capacity is unmeasured.** | four-axes doc line 81 | retraction, **binding** |
| K2 | Stream churn at 14k/s is *streams within sessions*, not sessions. It licenses nothing about session establishment. | four-axes doc | standing clarification |
| K3 | 10,000 sessions × 0.2 pps (2,000/s aggregate, 100 B, no echo): delivery **1.000**, ingest p99 **2.945 ms**, host CPU median **104.2%** of 400 with a co-resident generator | G1, run `32207919468` | **PASS** (staggered arrival only) |
| K4 | A wall-clock-synchronized fleet at the same mean rate delivers **0.699**; the gap is kernel `RcvbufErrors` ahead of the server. The Linux knee is **below** 5,000 packets/impulse | T02, run `32192153026` | **CONFIRMED** attribution |
| K5 | Server ingest p99 **5.14 ms** at 10,000/s aggregate on the shipped default (100 sessions × 100/s, 1150 B, echo); the honest co-resident generator ceiling is between 10k and 15k/s | G2 | **INCOMPLETE-ON-THIS-RIG** |
| K6 | G3b is **INVALID** (validity falsifier V1 fired: `schedulerLag` p99 spread 2.28–3.85× across arms). Its ceiling, its C2 and its C3 license **nothing** | G3b, run `32238304133` | **INVALID** |
| K7 | 1→50 fan-out: publisher→subscriber p99 **10.35 ms**, forward delivery **1.000**, forward egress **16.3k/s** | G4, run `32216072119` | **PASS** |
| K8 | Bulk sustained **1.250 Gbps** delivered, 2 × 60 s, inside the shipped governors, with `WEBTRANSPORT_STREAM_BATCH_BYTES=65536`; the shipped default without the knob tops out at **0.870 Gbps** | G5b, run `32244004915` | **PASS** (knob-set claim) |
| K9 | The settled on-box ingest ceiling is **~103k/s**; 160k needs a physical path | ceiling attribution doc | closed finding |
| K10 | Two event-loop-pin mechanism classes are named and fixed — unsettled `Env::spawn_future` futures invisible to runtime-idle checks, and one host-loop reference per N-API promise. `nativeAsyncOpsPending`, `sessionsClosedByIdle/Reap/Other`, `nativeSessionRegistryEntries`, `nativeTrackedTasks`, `nativeRateLimitEntries`, `nativeBidiHandlesLive`, `nativeUniSendHandlesLive`, `nativeUniRecvHandlesLive` exist on the metrics snapshot because of it. Run `32209051975` stamped `asyncOpsPending=0` | Ticket 03 | **RESOLVED** — this gate's leak instrument |
| K11 | On this Mac, idle, 20 sessions × 50/s: generator `scheduleLag` **871 µs mean, 40.6 ms max**. The p99 was not reported and must be measured on the day | Ticket 29 §4 | measured caution |
| K12 | Ticket 29's iperf3 UDP figure is an **offered rate that was met**, not a measured ceiling; it predicts nothing about the Mac's capability | Ticket 30 §0 K12 correction | correction, carried forward |
| K13 | A **1 GbE** cable carries ~102,800 pps at 1150 B | Ticket 29 §3 | derivation, link speed not yet observed |
| K14 | Levers landed on this base carry known defects: `send_datagram_batch` bypasses `spawn_counted` (invisible to the close-contract counters), and "one deadline per call" is false above 256 elements | final-round review | open defects, disclosed |
| K15 | `WEBTRANSPORT_DATAGRAM_SEND_SYNC` landed default-ON pre-soak; whether that stands is an **open maintainer ruling** | final-round review | open ruling |
| K16 | Ticket 26's lesson: an origination-lag instrument recorded *across* the product call absorbs product latency (3.6× spread proved it). The honesty stamp must be taken at scheduler handoff, before any await, and the product's own call duration recorded separately | Ticket 26 | binding method |
| K17 | Ticket 27's lesson: a **cumulative-deadline** pacer cannot overshoot, does not accumulate timer error, and absorbs rather than repays a block — so a delivered figure can never come from a burst. Per-write fixed sleep and token-bucket-with-burst were rejected on the record | Ticket 27 | binding method |
| K18 | Ticket 30's lesson: an aligned emitter is an impulse; spread it over a slice grid, and register the aligned case as **not covered**. Also: clauses must be pure functions unit-tested against the signature they exist to reject, and `rollUp` must be able to stamp INVALID over clauses that all computed PASS | Ticket 30 | binding method |

### K19–K24 — the shipped configuration, read out of the tree at the base SHA

These are **configuration facts, not results.** Every one is quoted from source
at `2a4145d0`, and every ladder bound in §2 is derived from them.

| # | Fact | Source |
|---|---|---|
| K19 | `max_handshakes_in_flight = 200`. A 201st concurrent handshake is **refused** (`incoming_session.refuse()`) and increments `limitExceededCount` | `crates/native/src/limits.rs:34`, `lib.rs:824` |
| K20 | `handshakes_per_sec = 20.0`, `handshakes_burst = 40.0` — a token bucket keyed by **(server, peer IP)**. Over it, `too_many_requests()` and `rateLimitedCount` | `crates/native/src/rate_limit.rs:28-29`, `lib.rs:861` |
| K21 | `handshakes_burst_per_ip = 40` **concurrent** sessions per IP; `handshakes_burst_per_prefix = 100` concurrent per **/24** (IPv4) or /64 (IPv6) | `rate_limit.rs:26-27`, `ip_prefix` at `:125` |
| K22 | `max_sessions = 2000`; `handshake_timeout_ms = 10_000`; `idle_timeout_ms = 60_000` | `limits.rs:33,46,47` |
| K23 | `streams_per_sec = 200.0`, `streams_burst = 400.0`, per (server, peer IP) | `rate_limit.rs:30-31` |
| K24 | The rate-limiter maps are swept by a **60 s tick** that evicts buckets idle for **300 s**; `PER_IP_SESSIONS`/`PER_PREFIX_SESSIONS` entries are removed when their count reaches zero | `lib.rs:690-696`, `rate_limit.rs:301-313` |

### K25 — the shipped handshake histogram measures a *partial span*, and this gate may not use it as its latency instrument

`metrics.handshake_histogram.observe(accept_start.elapsed())` at
`crates/native/src/lib.rs:956` is taken around **`session_request.accept()`
only**. By the time `accept_start` is set, three things have already happened:

1. `incoming_session.await` — **the entire QUIC + TLS 1.3 handshake**, i.e. the
   certificate work this gate's own ticket names as a lever;
2. the `max_handshakes_in_flight` admission gate;
3. both rate-limit gates.

And a connection refused at any of those three **never enters the histogram at
all**. So the shipped `handshakeLatency` is a partial-span, survivorship-biased
instrument. It is **published on every rung as a decomposition term** and it
carries **no clause**. It is exactly the wrong instrument for a churn gate and
this document says so before the run rather than after.

The full span — the quantity a user experiences and the one C3 grades — is
**client-measured on a single clock** (§6). That is not the retraction's
mistake: K1 forbids inferring a **rate** from client pacing, and G9's rate
clause (C2) is read from the server's own accept series and nowhere else.
A connect *duration* is a round-trip-shaped quantity on one clock, which is the
only kind of latency statement an off-box generator can make at all (ticket 29).

### K26 — the shipped instrument's own documented target

`packages/webtransport/src/index.ts:901`: *"Handshake latency (accept start to
completion). P99 target <300ms."* Authored before this effort. It is used in
§1.4 as an **independent convergence check** on a bar derived from scenario
arithmetic, never as the derivation itself, and §1.4 states that it targets the
partial span of K25 while C3's bar is on the full span.

**What K1 costs this gate.** Everything. G9 exists because accept capacity has
never been honestly measured. §3 removes the permit pool by construction — a
cumulative-deadline arrival clock, no semaphore anywhere in the arrival path —
and §6 reads the rate from `onSession` on the server's own clock. §7's V-L is
registered anyway, in **two readings**, because "it cannot happen here" is what
the retraction thought too.

---

## 1. Scenario arithmetic — every bound on this page, derived here

Nothing below is copied from a measurement.

### 1.1 The workload: why short-lived sessions exist at all

A WebTransport session that lives for one request/response is a real and
increasingly common shape: an edge API that wants QUIC's handshake and
datagram surface without a connection pool; a mobile client that re-establishes
on every network handoff and app resume; a device that wakes, reports, and
sleeps. In all three the *steady* condition is a population of clients each
opening a session, exchanging once, and closing — **arrivals, not connections**.

A production server is essentially never doing only that. It is serving a
long-lived tier at the same time — live updates, presence, telemetry — and the
churn tier arrives on top. **The gate's shape is therefore churn on a base**,
and the base is a first-class part of the load, not scenery: the clause that
asks whether the long-lived tier pays for the churn (C4) is one of the two
clauses this gate exists for.

### 1.2 The exchange: one bidirectional stream, 256 B up, 1024 B down

The canonical request/response over WebTransport is a bidirectional stream: the
client opens it, writes the request, half-closes, the server replies and
finishes. Sizes are an ordinary small JSON API pair — **256 B request, 1024 B
response** — deliberately small, because this gate measures establishment and
teardown, not throughput. At the gate rung the exchange contributes
600 × 1280 B = **0.77 MB/s**, three orders under anything this rig has found a
ceiling for (K8, K9), so no clause here can be a throughput result in disguise.

**The exchange is a stream and not a datagram on purpose.** A bidi stream is
where per-session handles live (`nativeBidiHandlesLive`), so C5's leaked-handle
clause has something to leak. A datagram exchange would make C5 vacuous.

### 1.3 The base: 200 sessions × 10 pps × 200 B, echoed

- **200 long-lived sessions** = 10% of `max_sessions` (K22), leaving the churn
  tier the other 90% to work in (§1.6).
- **10 pps/session, 200 B**, server-echoed, so the base carries a round trip on
  one clock and C4 has a latency instrument.
- Aggregate **2,000/s up + 2,000/s down**.

The base's rate is chosen to sit **inside an already-PASSED envelope**: K3
licenses 2,000/s aggregate at delivery 1.000 with a co-resident generator, and
K7 licenses 16.3k/s of server-originated forward egress. The base therefore
cannot fail on its own account, which is what makes a C4 miss attributable to
the churn. (Disclosed: the base's payload is 200 B against K3's 100 B — twice
the bytes at the same packet rate, 400 KB/s each way, still trivially inside
K5's licensed 10,000/s × 1150 B.)

### 1.4 The handshake bar: 300 ms p99, full span, derived twice

**Derivation A — the connection-UX budget the ticket asks for.**

| term | ms | why |
|---|---|---|
| interaction budget | 1000 | Nielsen's 1.0 s limit: the delay at which a user's flow of thought is still uninterrupted, and the outer bound for "the thing I asked for is happening" |
| − QUIC + TLS 1.3 handshake propagation | 60 | one regional-internet RTT; the transport does not control it |
| − WebTransport CONNECT propagation | 60 | a second round trip before the session is usable |
| − the request/response the session exists for | 60 | a third; the session is pointless without it |
| − client cert-chain validation and scheduling | 100 | one RAIL response budget, on the client's side of the wire |
| − server application handling of the request | 100 | one RAIL response budget, above the transport |
| **= the transport's share of session setup** | **620** | undivided |

620 ms is a budget for a *typical* setup. C3 grades a **p99**, and a p99 bar
derived from a typical-case budget needs a tail margin. Ticket 26 established
the form: a factor of two, on shape grounds, for the part of the distribution
the derivation does not describe. **620 / 2 = 310 ms**, floored to a whole
10 ms so the registered bar is never richer than its derivation → **310 ms**.

**Derivation B — independent convergence.** K26: the shipped instrument
documents a p99 target of **300 ms**, authored before this effort and by a
different hand. 310 and 300 agree to **3.3%** (Amendment 1).

**The registered bar is 300 ms** — the tighter of the two, so the gate is never
more lenient than either source. That the two agree is a coincidence of
independent derivations and this document says so rather than treating it as
corroboration. K26's figure describes the **partial** span (K25) while C3's bar
is on the **full** span, which makes the registered bar strictly *harder* than
the documented target, not equal to it.

**Registered diagnostic.** The undivided 620 ms is reported on every rung, and
the classifier raises `c3.undividedBudgetWouldPass` when the measured p99 lands
in (300, 620]. That band is a **MISS** under this registration; the flag exists
so the miss is legible as "failed the halved bar, cleared the undivided one"
rather than being re-argued after the fact. **Re-deriving the bar at 620 after
seeing the result is forbidden.**

### 1.5 The base bar: 40 ms round trip, derived

| term | ms | why |
|---|---|---|
| user-visible update budget | 100 | one RAIL response budget for a live update |
| − regional internet RTT | 60 | the same constant as §1.4, not controlled by the transport |
| **= base round trip, floored to 10** | **40** | |

Tighter than G6's 50 ms ability-response bound, and independently derived: this
is an update budget, not an ability budget.

### 1.6 The ladder: 75 / 150 / 300 / 600 sessions/s, and where 600 comes from

Three shipped-configuration ceilings bound a sustained arrival rate. All three
are computed from §0's K19–K23, before the run.

**(a) The per-source token bucket.** K20: 20 handshakes/s per peer IP, burst 40.
The generator offers from **E = 64 distinct source endpoints** (the loopback
`127.0.k.1` pool G1 and G6 use; each is its own /24, so K21's per-prefix cap is
not engaged). Ceiling = 64 × 20 = **1,280 sessions/s** sustained.

**(b) The admission gate, at the registered bar.** K19: 200 concurrent
handshakes. Little's law at the gate — and here it is the *server's* mechanism,
not a generator artifact (§7 V-L makes the distinction operational) — gives
`R_max = 200 / L`. At the §1.4 bar of L = 0.300 s: **666.7 sessions/s**.

**(c) The concurrency budget.** K22: `max_sessions = 2000`. With the base's 200
and a 20% headroom reserve (400), the churn tier may hold **1,400** concurrent
sessions. `R × L_cycle ≤ 1400` ⇒ at R = 600 the whole connect→exchange→close
cycle must complete inside **2.333 s**. This is a *registered constraint on the
harness*, measured on every rung (§6): if the measured mean cycle lifetime
exceeds it the arm is measuring `max_sessions`, not churn, and the rung is
INCOMPLETE (§7 V-M), never a MISS.

**The gate rung is min(a, b) = 666.7, rounded down to a whole 100 = 600/s**, so
the registered offer is never richer than its derivation. The ladder halves
down from it: **75 / 150 / 300 / 600**. Population is the only variable across
rungs; the base, the exchange and every payload are identical at each.

600/s sustained is 51.8 million sessions/day. That is the scale statement this
gate would license if it passes, and it is stated here so nobody has to infer it
from a rate afterwards.

**K23 checked and not binding:** one bidi stream per cycle at 600/s across 64
IPs is 9.4 streams/s/IP against a 200/s bucket, a 21× margin.

### 1.7 Arrival shards: S = 8

The arrival clock is a cumulative-deadline pacer (§3, K17). At R = 600 the
inter-arrival interval is 1.667 ms — below the millisecond timer granularity
that K11's generator actually achieves, so a single-threaded arrival clock
would necessarily release arrivals in bursts of `R × oversleep`. At K11's
observed 40.6 ms maximum that is **24 arrivals in one instant**, which is
exactly the impulse shape K4 attributed on the ingest side and K18 forbids.

The fix is K18's, applied to arrivals instead of egress: **spread the arrival
clock over S = 8 independent shards**, each an independent cumulative-deadline
clock at R/S with a phase offset of `i/S` of one shard interval. At R = 600 the
per-shard interval is **13.33 ms**, 15× K11's mean schedule lag, and a 40.6 ms
oversleep costs **3** arrivals of deficit on one shard rather than 24 globally.

S = 8 is derived: it is the smallest power of two for which the per-shard
interval at the gate rung exceeds the generator's mean observed schedule lag by
a factor of ten or more. Sharding *widens* the per-shard interval
(`1000 · S / R`), so the binding direction is downward: S = 8 gives
13.33 / 0.871 = **15.3** and clears it, and S = 4 gives 6.67 / 0.871 = **7.7**
and does not (Amendment 2). **The day's floor arm re-checks it on the real p99**
(§7 V-F): if `scheduleLagP99 > perShardIntervalMs / 10 = 1.333 ms`, V-F fires
and the rung is INCOMPLETE.

**Registered as NOT covered**, symmetric with G6's aligned-egress disclosure:
within one timer-jitter window arrivals are still bursty. The gate's claim is
about the rate held over the steady window, and the burstiness is inside the
measured connect tail rather than hidden from it. A *deliberately* synchronized
arrival storm is G6's arm, not this one.

### 1.8 Windows

| window | seconds | why |
|---|---|---|
| ramp (excluded) | 30 | the churn tier reaches its steady concurrency `R × L_cycle`; nothing is counted |
| **steady (graded)** | **120** | at R = 600 that is 72,000 cycles, so a p99 rests on 720 samples above it. G6's steady window, unchanged |
| quiet settle (post-arm) | 30 | churn stops, base continues; C5's leak clause is evaluated at the end of it |

The settle window is **30 s and not 60 s deliberately**: K22's idle timeout is
60 s, so a churn session that is still registered 30 s after the last arrival
has *not* been reaped by the idle path, and C5 sees a real leak instead of
watching the timeout tidy the evidence away.

---

## 2. The cells

| cell | churn R | base | windowSec | role |
|---|---|---|---|---|
| `L-75` | 75 | 200 | 120 | ladder |
| `L-150` | 150 | 200 | 120 | ladder |
| `L-300` | 300 | 200 | 120 | ladder |
| **`L-600`** | **600** | **200** | **120** | **the gate cell — every clause is about this cell** |
| `B-only` | 0 | 200 | 120 | base-health reference (disclosure, §2.2) |
| `C-only` | 600 | 0 | 120 | what the base costs the churn (disclosure) |
| `LIM` | 600 from **one** source IP | 0 | 60 | limiter configuration fidelity (§2.3) |

Two repeats of `L-600`; one of everything else. Fresh server process per cell.

### 2.1 Registered lower-rung licensing — written now, so it cannot become a headline later

Ticket 30's §2.6 rule. If `L-600` misses and a lower rung passes every clause,
G9 licenses a statement **at that rung and no higher**, phrased as a rate on the
named configuration, with the miss disclosed in the same sentence. Specifically:

- `L-300` passes, `L-600` misses ⇒ licensed: *"sustains 300 sessions/s of
  connect–exchange–close on top of 200 long-lived sessions, on the shipped
  limits, with a full-span connect p99 under 300 ms and zero leaked handles;
  600/s was attempted and missed on <clause>."*
- The same, one rung down, for `L-150` and `L-75`.
- **No rung licenses a claim about a rate it did not run.** No interpolation
  (K5's lesson: 15,000/s was never a measured rung, and interpolation is not
  measurement).
- If **no** rung clears C5, the gate stamps MISS regardless of the rate rungs,
  because a leak is not a capacity question.

### 2.2 `B-only` is a disclosure cell, not a gate

C4's bar is the absolute 40 ms of §1.5. `B-only`'s figure is published beside it
and the ratio reported, but **it does not gate** — G5b's `P-control` posture.
Gating on a ratio to a cell measured in the same dispatch would be deriving a
threshold from this gate's own run, which §0 forbids.

### 2.3 `LIM` — "measure config, not accident"

The ticket asks for the limiter's behaviour at the boundary as a *measurement of
configuration*. `LIM` offers 600/s from a **single** source IP against the
shipped bucket (K20: 20/s, burst 40) over a 60 s window. The arithmetic, before
the run:

> admitted = burst + rate × window = 40 + 20 × 60 = **1,240 sessions**

Registered band ±5% ⇒ **[1178, 1302]**. Registered accounting: `rateLimitedDelta
> 0` and `limitExceededDelta == 0` — the token bucket (K20) gates before the
per-IP concurrency cap (K21) in `lib.rs`, and at 20 admits/s with a sub-second
cycle the concurrent count never approaches 40, so the concurrency cap must
never be the thing that fired. If `limitExceededDelta > 0` the cell is reporting
a different mechanism than the one it was built to check and it is INCOMPLETE.

**`LIM` is a configuration-fidelity statement and carries no capability
number.** Its verdict may not be quoted as a rate.

---

## 3. The arrival clock — the design decision this gate turns on

K1 exists because a generator with a connect semaphore measures its own pool.
Every alternative was considered on the record:

- **Permit pool / semaphore (what produced K1).** Arrival rate becomes
  `pool / mean completion`, i.e. a function of server latency. The measured
  "rate" is then a restatement of the pool size. **Disqualifying.**
- **Connect-then-wait loop (one task per shard, awaiting each cycle).** A pool
  of size S in disguise, with the same defect.
- **Fixed sleep between arrivals.** Achieves `1 / (sleep + issue_cost)`, and
  `issue_cost` is a function of the very path under test — so the fast and slow
  cells would sit at different offers while carrying the same rate label.
  Ticket 27 rejected this for writes; it is worse here, where the per-arrival
  cost is a TLS handshake.
- **Cumulative-deadline clock, S shards, detached cycles (chosen).** Shard *s*
  owes its *n*-th arrival at `t0 + (n + s/S) · S/R`; it sleeps to that absolute
  deadline, **spawns** the cycle detached, and immediately proceeds to *n+1*.
  Nothing in the arrival path awaits a connect, a handshake or a close.

Three properties this buys, all of them checkable in the artifact (§7 V-P):

1. **It cannot overshoot** (K17), so an accept figure can never come from a
   burst. The only possible error direction is under-offering.
2. **Timer error does not accumulate** — an oversleep shortens the next sleep.
   Residual is one shard interval over the step: 13.33 ms / 120 s = **0.011%**.
3. **Falling behind stays visible.** If the server slows, cycles pile up
   in flight; the pile-up is reported (`inFlightHighWater`) and is *the finding*.
   It is never absorbed into the arrival rate.

### 3.1 The abort ceiling is not a permit pool, and the difference is testable

An arrival clock that spawns without bound will OOM the generator against a
collapsed server, and a generator that takes its own host down leaves no
evidence. So a **safety abort** is registered: if in-flight cycles exceed
`4 × 1400 = 5,600` (four times the §1.6 concurrency budget), the rung
**terminates** and reports `generator-overrun` ⇒ INCOMPLETE, never a MISS.

The distinction from a pool is not rhetorical, it is observable:

| | a permit pool | this abort ceiling |
|---|---|---|
| effect on an arrival | **delays** it until a permit frees | never delays anything |
| effect on the rung | none — it runs to the end | **ends** it |
| signature | `arrivalsIssued ≈ cyclesCompleted`, in-flight pinned at the pool size | `arrivalsIssued` runs ahead of completions until the abort |

§7 V-P asserts the second signature and a unit test drives the pacer against a
fake connector with rising latency to prove the first cannot appear.

The generator also carries G6's RSS self-guard, unchanged.

---

## 4. What this gate does not do

- **No lever A/B.** One send path, one exchange shape, shipped defaults
  everywhere. G9 produces no send-batch, chunk-batch or window measurement, and
  no cell of it may be quoted in those arguments.
- **No default flip is proposed and none is licensed.** Soak-freeze (spec
  §Process rules) binds regardless of outcome.
- **No cross-arm `schedulerLag` agreement clause** (K6's lesson: unmeetable for
  an in-process scheduler).
- **No claim about aligned/synchronized arrival storms.** That is G6's arm; §1.7
  registers this gate's arrival process as staggered-within-jitter and the
  aligned case as not covered.
- **No uncontended capacity number** if the generator is co-resident (§8).

---

## 5. The clauses

All six are evaluated on **`L-600`** (both repeats; a median of two is their
mean, and both samples are published). Every clause is a pure function in
`tools/load/g9-classify.ts` and every one is unit-tested against the signature
it exists to reject (K18).

### C1 — completeness

Every ladder cell usable in both directions: no INCOMPLETE bucket
(§7 V-F, V-G, V-M, V-C, V-S), exit code 0, both repeats of `L-600` present, and
the host CPU median **under 90%** of 400 (the axis's standing INCOMPLETE rule —
a saturated gate arm is NO-VERDICT, not a MISS).

### C2 — sustained accept rate, read at the server

> `serverAcceptsInSteadyWindow / steadySec ≥ 0.99 × R`

`serverAcceptsInSteadyWindow` is the count of `onSession` completions the
**server** timestamped inside the graded window. The client's arrival pacing is
recorded and **never** read by this clause (K1). The 0.99 band is the
registered under-offer tolerance of §3 property 1 plus the shard residual of
§3 property 2 (0.011%), rounded to a whole percent in the gate's disfavour.

`limitExceededDelta` and `rateLimitedDelta` must both be **0** on `L-600`: with
E = 64 endpoints the offered rate is 47% of the token-bucket ceiling (§1.6a) and
either counter rising means the run met a limiter the derivation says it should
not have. Non-zero ⇒ C2 MISS with the counter named (**not** INCOMPLETE — a
limiter engaging below its derived boundary is a finding about the product).

### C3 — handshake tail, full span, client clock

> `connectDurationP99 ≤ 300 ms` on `L-600`

`connectDuration` is the client-measured span from **arrival handoff** (the
instant the shard released the cycle, stamped *before* any await — K16) to the
session being usable for a stream open. Raw p99, nothing subtracted (G1's rule).
The generator's own `arrivalLag` is published beside it and is **not**
subtracted from it; V-F is what makes the floor a precondition instead of a
correction term.

Published on the same rung, none of them gating: the server's partial-span
`handshakeLatency` p99 (K25), the difference between the two spans — which is
the QUIC/TLS handshake share and therefore the cert-cost lever the ticket asks
to **record, not pull** — and `c3.undividedBudgetWouldPass` (§1.4).

### C4 — the base does not pay for the churn

All three, on the base cohort only, during `L-600`'s steady window:

- base echo round-trip **p99 ≤ 40 ms** (§1.5);
- base upstream delivery **≥ 0.995** (server-observed ÷ client-enqueued);
- **zero** base sessions lost.

The base cohort is identified **server-side**, by the sessions established
before the churn tier's first arrival — G6's survivor rule, for G6's reason: it
is the only way to get the cohort without trusting the client's account of it.

### C5 — zero leaked sessions and handles

Evaluated at the end of the 30 s quiet settle (§1.8). Five parts, all required:

1. **The ledger closes exactly.**
   `acceptsTotal − sessionsActiveAtSettleEnd == closedByIdle + closedByReap + closedOther`.
   An unexplained difference is a session that ended without being accounted.
2. `nativeAsyncOpsPending == 0` (K10, the ticket-03 instrument).
3. `nativeBidiHandlesLive == 0` **and** `nativeUniSendHandlesLive == 0` **and**
   `nativeUniRecvHandlesLive == 0`. The base uses datagrams only, so zero is the
   correct expectation and not an approximation (§1.2).
4. `nativeSessionRegistryEntries == baseSessions` and
   `sessionsActive == baseSessions`.
5. **No drift during the arm.** Least-squares slope of
   `nativeSessionRegistryEntries` over the steady window, extrapolated across it,
   is under one session: `max(0, slope) × steadySec < 1.0`.

`sessionsClosedByIdle` over the churn window must be **0**: a churn session that
reached K22's 60 s idle timeout was abandoned, not closed, and the idle path
tidying it away is precisely how a teardown defect hides.

`nativeRateLimitEntries` is **bounded, not zero** — see P4. Registered bound:
`≤ 512` (E = 64 endpoints × 5 maps = 320, plus the base's own, plus 1.6×
margin). Expecting zero here would be an instrument error, and this document
says so before the run.

### C6 — teardown health

On `L-600`: client-observed close errors **0**; server-observed stream errors
**0**; `sessionsClosedOther` accounts for the churn closes (the churn tier closes
from the client, so its sessions are neither idle-reaped nor server-reaped);
`serverStreamsAccepted == serverStreamsCompleted == cyclesCompleted`.

---

## 6. Instruments

**Server-side (the only source for C2, C4's cohort, and C5).**
`onSession` timestamps every established session → a 1 Hz **accept series** on
the server's clock; `sessionsActive` series; peak `handshakesInFlight`;
`handshakeLatency` histogram (K25, decomposition only); the deltas of
`limitExceededCount`, `rateLimitedCount`; and the full K10 counter block —
`nativeAsyncOpsPending`, `nativeSessionRegistryEntries`, `nativeTrackedTasks`,
`nativeRateLimitEntries`, `nativeBidiHandlesLive`, `nativeUniSendHandlesLive`,
`nativeUniRecvHandlesLive`, `sessionsClosedByIdle/Reap/Other`. Kernel taps
(`/proc/net/udp` per-port drops, `/proc/net/snmp`) read as null when unreadable
— "we saw no drops" and "we could not look" are different statements.

**Client-side (latency and honesty only, never rate).**
`arrivalLag` — intended deadline → the shard being ready to hand off, stamped
**before any await** (K16). `connectDuration` — handoff → session usable (C3).
`exchangeRtt` — request write → response complete. `closeDuration`. Cycle
outcome counters. `inFlightHighWater`. Client CPU and RSS.

**The two spans are published side by side on every rung** and their difference
is the recorded cert/TLS lever.

---

## 7. Falsifiers — every one executable off-runner and unit-tested (K18)

| id | fires when | effect |
|---|---|---|
| **V-P** | the arrival clock was not a cumulative-deadline clock: `arrivalsIssued` outside `[0.98, 1.02] × R × steadySec` (**the load-bearing reading**); **or** `inFlightHighWater ≤ 1` while `meanCycleSec × R > 1`. A shortfall additionally carries the `poolBound` mechanism annotation when the achieved rate equals `inFlightHighWater / meanCycleSec` and not the clock (Amendment 3) | **run INVALID.** No rate claim of any kind |
| **V-L (generator reading)** | `acceptRate × clientMeanConnectSec` sits within ±10% of a declared connect-concurrency pool. `connectConcurrency === null` (the registered configuration: no pool) cannot fire it | strips **verdict force** — numbers published as characterization, exactly K1's shape |
| **V-L (server reading)** | `acceptRate × serverMeanHandshakeSpanSec` ≈ 200 (K19) within ±10% | **not a falsifier — a finding.** Raises `admissionGateBinding`. It is the shipped admission gate doing its job, which is what §1.6b predicted, and it is the same arithmetic as the generator reading landing on a different population. The two are distinguished by *which* population the product lands on, and the classifier reports both |
| **V-F** | the generator's same-day floor arm on the **actual generator host** shows `scheduleLagP99 > 1.333 ms` (§1.7); or the floor report is from the wrong day, the wrong host, or zero driving sessions | rung **INCOMPLETE** |
| **V-G** | generator saturated: client process CPU ≥ 90% of its available cores over the drive | rung **INCOMPLETE**, never MISS |
| **V-M** | measured mean cycle lifetime > 2.333 s (§1.6c), i.e. the arm is measuring `max_sessions`; or `sessionsActive` reached `max_sessions` | rung **INCOMPLETE** |
| **V-C** | instrument inconsistency: the server's partial-span handshake p99 **exceeds** the client's full-span connect p99 on any rung. The partial span is contained in the full span, so this is arithmetically impossible and indicates a clock or instrument fault | rung **INCOMPLETE** |
| **V-S** | the exchange was not real: server-observed request bytes ≠ client-sent request bytes for the completed cycles, or a cycle counted complete with no server-side stream accept. The G4 lesson — prove the path contains a network, do not infer it | **run INVALID** |
| **V-K** | a kernel tap that could not be read is booked as a zero anywhere in the artifact | **run INVALID** |

`rollUp` stamps the strongest outcome present: any INVALID ⇒ INVALID; else any
INCOMPLETE bucket ⇒ NO-VERDICT; else any clause MISS ⇒ MISS; else PASS. It is
unit-tested to stamp INVALID over a set of clauses that all computed PASS.

---

## 8. Generator host, and the cable

**Primary: the Mac over the direct Ethernet cable (ticket 29).** Churn
generation is handshake-CPU-heavy on the client — a TLS handshake per arrival,
600/s — so co-residence binds earlier here than on any prior axis.

**A requirement ticket 29's runbook does not yet contain, derived from K21.**
The runbook proposes a single pair of addresses, `10.99.0.1` (Mac) and
`10.99.0.2` (runner VM). At the shipped defaults that configuration **cannot run
this gate**: one source IP means one 20/s token bucket (K20) and a 40-session
concurrency cap (K21), and even 64 aliases inside `10.99.0.0/24` would share one
/24 prefix and hit the **100 concurrent** per-prefix cap. G9 therefore requires
the Mac to hold **64 aliases in 64 distinct /24s** — `10.99.k.1/24` for
k = 1…64 — with the runner routing `10.99.0.0/16` over the cable. This is a
cable-day human step and it is **flagged to ticket 29, not written into it**;
this registration changes no other ticket.

**Registered fallback: on-box loopback**, the `127.0.k.1` pool G1 and G6 use,
with co-residence disclosed and the result labelled a **lower bound** on the
server's capability. The fallback is registered *now*, with that label, so it
cannot be adopted after a cable failure and then reported as a clean number.
Under the fallback, V-G is the guard that turns a co-residence bind into
INCOMPLETE rather than a MISS.

Under either host: `offboxSsh` is recorded in the artifact, and a run whose
`offboxSsh` is null is stamped on its face as the co-resident lower-bound
variant.

---

## 9. Registered predictions — written before the run, read by no clause

| # | prediction |
|---|---|
| **P1** | `L-600` **misses C3**: the full-span connect p99 exceeds 300 ms under a co-resident generator. §2.1's lower-rung licensing exists for this outcome |
| **P2** | `L-150` passes every clause |
| **P3** | peak `handshakesInFlight` stays under 200 at R ≤ 300 and reaches 200 at R = 600 **iff** the full-span p99 exceeds 333 ms (= 200/600). If it reaches 200, `limitExceededDelta > 0` and C2 misses — and the mechanism is K19, not a defect |
| **P4** | `nativeRateLimitEntries` does **not** return to zero after the arm. K24's sweeper evicts on a 60 s tick at a 300 s idle threshold, and the arm plus settle is 180 s. This is the sweeper, **not** a leak, and C5's part 5 is bounded rather than zeroed for exactly this reason |
| **P5** | `C-only` (no base) clears C3 by a margin `L-600` does not. The base's cost is disclosed, never gated |
| **P6** | `LIM` admits `1,240 ± 5%` (§2.3). A miss here is a statement about the limiter's implementation, and it routes to the limiter, not to the ladder |

Stating these beforehand is what stops the arm being called aimed, and stops a
refuted prediction being reported as a surprise.

---

## 10. Amendments

Any change to this document after it is committed and before a dispatch is an
**amendment**, appended here, quoting the original text in full and stating what
moved and why. Ticket 30's precedent: mechanizing arithmetic exposes errors in
prose, and the correction belongs on the record rather than in a silent edit.
**After a dispatch, nothing in §1–§7 may change at all.**

Both amendments below were raised by `tools/load/g9-plan.test.ts` failing
against the prose, before any harness ran and long before any dispatch. **No
threshold moved in either.**

### Amendment 1 — the convergence figure in §1.4

Original: *"310 and 300 agree to **3.2%**."*

|310 − 300| / 300 = 3.33%, not 3.2%. Corrected to 3.3%. The figure is a
disclosure about how close two independent derivations landed; it carries no
clause, and the registered bar (300 ms, the tighter of the two) is untouched.

### Amendment 2 — the shard derivation in §1.7 was argued in the wrong direction

Original: *"S = 8 is derived: it is the smallest power of two for which the
per-shard interval at the gate rung exceeds the generator's mean observed
schedule lag by a factor of ten or more (13.33 / 0.871 = 15.3; S = 16 would
give 6.67 / 0.871 = 7.7 and fail the test)."*

The per-shard interval is `1000 · S / R`, so it **grows** with S. S = 16 would
give 26.67 ms and clear the test more easily, not fail it; the 6.67 ms figure
quoted against S = 16 is in fact **S = 4**'s. The conclusion — that S = 8 is
the smallest power of two clearing the factor of ten — was and remains correct,
and 8 stays the registered value; what was wrong was the falsifying case named
beside it. Corrected to S = 4, and a unit test now pins both sides plus the
one-sidedness of the bound, so the argument cannot be run backwards again.

### Amendment 3 — V-P's second reading was a steady-state signature, not a pool signature

Original (§7, V-P): *"…**or** `arrivalsIssued ≈ cyclesCompleted` within 0.5%
while `meanCycleSec × R > 1` (the completion-driven signature)…"*

**That rule fires on every healthy gate cell.** At steady state arrivals and
completions are equal *by definition* — that is what steady state means. The
first unit test written against it, on an otherwise perfect arm (72,000 arrivals,
71,940 completions, 310 in flight), fired the rule.

Restated with the reasoning on the record. Under a permit pool of size P with
mean cycle L, throughput is `P / L` and in-flight is pinned at P; under clock
pacing at R, throughput is R whatever L does. **So a pool that binds necessarily
misses the clock band, and a pool that does not bind is not an artifact.** The
first reading — the arrival count must be explainable by the wall clock alone —
is therefore already a complete test, and it is the one that carries V-P.

What replaces the struck rule is a **mechanism annotation**, `poolBound`, which
speaks only when the clock band has already fired: if the achieved rate equals
`inFlightHighWater / meanCycleSec` and does not equal R, concurrency was capped
somewhere and the shortfall's cause is named rather than left open. It cannot
fire alone, and a unit test pins that it stays silent whenever the clock was met.
The serialization reading (`inFlightHighWater ≤ 1`) is unchanged; it is kept as
the degenerate case and as a guard against an `arrivalsIssued` computed from the
schedule rather than counted at the handoff.

**No threshold moved and V-P's scope is still `run`/INVALID.** What moved is that
V-P can no longer void an honest run — which is the failure mode a falsifier is
least able to survive, since a rule that voids everything voids nothing.

The downstream figures are unaffected and were independently correct: 13.33 ms
per-shard interval, 1.333 ms V-F bound, 0.011% pacer residual, and 3 arrivals
of deficit per shard against 24 globally at K11's 40.6 ms maximum — all four
are now pinned by tests.

---

## 11. Dispatch

**Base drift.** If `rebind4-staging` has moved past `2a4145d0…` at dispatch
time: re-derive §1.6 from the limits and rate-limit sources at the new SHA,
amend this header **before** dispatch quoting the old SHA, and diff the two
staging SHAs for anything touching the accept path, the rate limiter, the
session registry or the close contract. G1's stamp asserted a merge-base
equality in the present tense that stopped being true two hours later; this
document is written not to.

**Order.**

0. If the cable is the host: ticket 29's pre-flight, same day, plus the 64-alias
   requirement of §8 verified by pinging each `10.99.k.1` from the runner.
0b. The generator floor arm on the actual generator host, same day (V-F).
1. Compose the candidate: rebase `probe/g9-churn-01` onto the staging SHA;
   SHAs from `git rev-parse` only; never merged back.
2. Push under a **new** remote ref so no earlier candidate becomes unreachable.
3. **One** dispatch: `bench-bandwidth.yml`, `mode=gate-g9`,
   `[self-hosted, Linux, X64, heavy]`, `runner_mode=dedicated`.
4. Log the dispatch in §12 — run id, candidate SHA, artifact sha256s —
   **including if it aborts**.

**Rerun policy** (spec §Process rules): one complete run stamps. A rerun
requires a declared, logged harness/infra fault. **A miss on a valid run is
final.** Re-running at another rung, another base size, another exchange shape
or another limiter configuration is **forbidden**.

---

## 12. Run log

*(empty — no dispatch has occurred)*
