# Preregistration — gate g6-sharded-arms (id `g6-sharded-arms/1`)

Registered before any paid hotspot or storm measurement; frozen at
registration. A MISS is diagnosed, never re-thresholded. Plan:
`docs/superpowers/plans/2026-10-06-g6-sharded-arms.md` r6 (sha256
`9b5c72914c1fcfd5d8e341393a9f204ddf1c949b2b2683567a23c219939d92e5`),
approved unconditionally by Architect r6 and Critic r6. §8 lists every
amendment to plan r6 and every disclosure decided before freeze.

## 1. Framing

- **G6-04's valid MISS stands.** G6-04 ran under `g6-mmo-closeout/1` on the
  single-instance home rig and remains the G6 verdict. This gate is not a
  rerun of G6-04. `g6-mmo-closeout/1` licenses no rerun.
- **No G6 PASS is promoted from this gate.** It is a new gate on a new
  deployment. It asks one question: does the sharded deployment that passed
  40k steady carry G6's two arms that were never measured on it, the raid
  hotspot and the reconnect storm?
- Stamped arm verdicts (PASS, or a valid MISS) close the open "never
  measured on sharded" items. They make no comparison claim against G6-04.
  Raid co-location (§3.1) makes H1–H3 structurally easier than G6-04's
  single-instance hotspot.
- Incorporated by reference, unchanged except where this document says
  otherwise:
  - `gate-g6-mmo.md` (sha256 `5eff7ed5…6fbd4fad`): §1.7 hotspot, §1.8 storm,
    §3, §5, §7.
  - `gate-g6-mmo-closeout.md` (sha256 `bae6c5ed…1f46580`): §3 measurement
    semantics, in particular §3.5 storm denominators, §3.7 survivor windows
    and §3.8 the shared barrier.
  - `gate-g6-sharded.md` (sha256 `7368aa07…2bbb5b`): the realm contract S1–S5.

## 2. Deployment (the closed 40k deployment, unchanged)

One fresh journal-owned pair of DigitalOcean `g5-48vcpu-96gb-80gb` droplets
(v5, 48 vCPU / 98,304 MiB), region `ric1`, Ubuntu 24.04 x64. Every cell runs
the single source-encoded profile `candidate`
(`makeShardedArmsWorkProfiles`). This is the closed B-12 40k profile, and
any other profile is refused:

- 24 SO_REUSEPORT shards with QUIC-LB/eBPF CID steering, 3 server workers
  per shard;
- C-PUMP datagram read path on both roles, stock send path (UDP batch 0);
- detailed probe off, default server send buffer;
- native ACK reflector, default ACK cadence;
- GRO off, shared receive runtime, receive buffers 26,214,400 bytes;
- EAGAIN wait, peer hint off, native counters on;
- 4 owned generator processes over 128 client endpoints (ports
  20000–20127), connect concurrency 50 and rate 250/s in aggregate, split
  into exact shares.

Hotspot cells add one publisher process and one raid-subscriber process on
the generator. Each has its own registered source port (base + 128 and
base + 129). Work plan: `makeShardedArmsWorkPlan` (`g6-sharded-arms`),
lifecycle `ladder-only`.

## 3. Registered deployment semantics

### 3.1 Raid co-location

The publisher and its 40 subscribers open with 20-octet DCIDs drawn until
FNV-1a over the first 8 octets mod N == K. This is the BPF
`place_by_client_dcid` with `MAX_INSTANCES = N = 24`. Raid slot **K = 0**,
so server id 1. The DCID length is 20, which differs from CID_LEN 11, so
the opening DCID is always hash-placed. Realm sessions keep uniformly
random 20-octet DCIDs and record their expected shard from their own
opening DCID.

Realm sessions never send RAID_JOIN: requested = active, and raid
membership is an explicit marker.

### 3.2 Storm across shards

- Severing is client-side, by abrupt application close. The cohort is split
  into even shares by global index over the 4 processes, behind a shared
  sever barrier.
- Reconnects start 1,000 ms after the sever. The whole cohort reconnects at
  once, with no permit pool.
- The storm window (120 s) is anchored at the server-clock sever instant
  plus 1,000 ms.
- All 24 shards share one host clock, so per-shard accept series and
  counters are summed without alignment.
- Reconnect Initials carry fresh random 20-octet DCIDs.
- Idle timeout is 300 s.

### 3.3 Phases

| kind | phases |
|---|---|
| hotspot | V-F 10 s, V-S 20 s, connect, 120 s steady, 1 s drain, 30 s idle |
| storm | V-F 10 s, connect, 60 s steady, 1 s drain, sever, 1,000 ms, 120 s storm window, 60 s post-storm, 30 s idle |

## 4. Cells, order, maxima

| Cell | Realm (requested = active) | Arm | Cohort | Role | Gated clauses |
|---|---|---|---|---|---|
| H5k | 5,000 | hotspot | — | bridge to G6-04 (reported) | H1 H2 H3 |
| H40k | 40,000 | hotspot | — | **gate** (hotspot verdict) | H1 H2 H3 |
| S1-5k | 5,000 | storm | 1,000 | **gate** | S-C1 S-C2 |
| S2-5k | 5,000 | storm | 5,000 | **gate** | S-C2 |
| S1-40k | 40,000 | storm | 8,000 | **gate** | S-C1 S-C2 |
| S2-40k | 40,000 | storm | 40,000 | characterization only (no verdict force) | S-C2 reported |

Order: H5k → H40k → S1-5k → S2-5k → S1-40k → S2-40k.

Whole-cell maxima: hotspot **480 s**, storm **600 s**. A cell maximum is
the whole work cell (`completion.durationMonotonicNs`), not the scan. The
registered worst cases include a ≥ 60 s fixed per-cell overhead (sealed
B-12 cells show about 54 s):

- hotspot: 10 + 20 + 210 + 120 + 10 + 30 + 60 = 460 s;
- storm: 10 + 210 + 60 + 1 + 120 + 60 + 30 + 60 = 551 s.

The VM rehearsal measured arms overhead of about 6 s (raid processes,
pre-checks, barrier), below the Critic's 15 s trigger, so the hotspot
maximum stays 480 s.

## 5. Clauses (thresholds, and how each is recomputed from raw fields)

The grader is `tools/load/g6-sharded-arms-grade.ts`, reached through
`gradeWorkCell` in the paid run and through `g6-sharded-arms-evaluate.ts`
for the stamp. It reuses the clause functions of `tools/load/g6-classify.ts`
unchanged. The scan's own summary values (`placement.placed`,
`steeringDelta`, `severSkewMs`, …) are never read as verdicts. Each one is
recomputed from the raw field it was derived from.

### Hotspot

| id | threshold | raw recomputation |
|---|---|---|
| H1 | publisher→subscriber one-way p99 ≤ **25 ms** | raid-subscriber `windows.steadyDrain.oneWay` histogram, p99 from buckets |
| H2 | forward delivery ≥ **0.995** | subscriber `steadyDrain.rxRaid` / (ingested × 40). Ingested = shard K `windows.steadyDrain.rxByClass.raid + raidJoin` |
| H3 (gated) | sharded S1–S5 (S1 ≥ 0.995, S2 ≥ 0.995, S3 ≥ 0.99, **S4 ACK p99 ≤ 25 ms**, S5 ≤ 0.001), evaluated twice and both must pass | **Realm-wide:** S1 = Σ shard `steady.rxTotal` − raid ingest, over merged `steady.sent`. S2 = merged `steadyDrain.rxSnapshot` / Σ `steadyDrain.emitter.snapshotIssued`. S3 = issued / (sessions × 5 × 3 × 120). S4 = merged `steadyDrain.rtt` p99. S5 = `steady.sessionsLost` / sessions. **Shard K:** the same on merged `arms.shards.K.*`, shard K's own windows, and `arms.sessionsByShard.steadyEntry.K` |
| H3 (G6) | C1 ≥ 0.995 / C3 ≤ 50 ms | unchanged `clauseH3`, reported beside, no verdict force |

The 25 ms H3 choice is registered before any hotspot or storm data. The
author has seen this rig's steady ACK p99 at about 4–20 ms at 40k and
43.9 ms at 50k.

### Storm

| id | threshold | raw recomputation |
|---|---|---|
| S-C1 (gated, S1 cells) | survivors' ACK p99 ≤ **25 ms**; upstream delivery ≥ **0.995**; sessionsLost == 0 | Merged `windows.stormSurvivors.rtt`: non-severed sessions only, merged bucket by bucket across processes and shards, storm window only. Delivery: see §8 item 4. |
| S-C1 (G6) | 50 ms | unchanged `clauseSC1`, reported beside with the uncorrected ratio |
| S-C2 | every severed session re-accepted within 120 s; sessionsActive at window close == rung; limitExceeded and rateLimited deltas 0 | Re-accepts are counted from the raw per-shard `acceptMsAfterSever` instants in (sever, storm end]. Active sessions: Σ `sessionsByShardAtStormEnd.server`. Deltas: Σ shard `windows.storm.metrics.{limitExceededCount, rateLimitedCount}` |
| S-M | characterization, no verdict force | accept instants: first and last re-accept, peak accepts/s, handshakes in flight, client reconnect ms |

S-C2 deltas are structurally zero on this rig because per-shard harness
limits are 2 × the rung. They are reported, not counted as evidence.

## 6. Falsifiers (each fires INVALID unless stated)

| id | rule | raw recomputation |
|---|---|---|
| V-C | rig qualification + PREPARED_HOST on the exact pair | `validateCapacityRawCell` (exact pair, receipts, owners, diagnostic) before arms grading |
| RAW | per-kind raw-cell expectations | Arms config equals the registration (arm, shards, raid slot, DCID length 20, negctl null, cohort, durations not overridden). Realm census = rung. Roles. Realm source ports are the 128-port pool and raid processes have their own ports. Shard steady wall within ±250 ms. Hotspot: server census at drain player/raid/publisher = rung/40/1, 40 RAID_JOINs, explicit membership. Storm: anchored timeline, cohort shares, no permit pool, window 1,000 ms after sever and 120 s ± 250 ms, one server-clock sever instant on every shard |
| V-F | every cell, before connect | 10 s floor, exactly 20 driving sessions at the registered per-session rate, against the generator-loopback forwarder (never the shards). `floorReportIsUsable` applies except the host check. INVALID if p99 > **10 ms**, the floor is unusable, or the forwarder rc ≠ 143 |
| V-S | hotspot cells, before connect | 20 s loopback sink at 1,200/s (1 publisher at 30/s × 40 subscribers). INVALID if delivery (`rxRaid` / (sent × 40)) < **0.995**, or the originator's achieved rate (sent × 40 / 20 s) < **0.995 × 1,200 = 1,194/s**. Raw `scheduleTicksSkipped` is disclosed (§8 item 2) |
| V-N | any negative RTT or one-way sample | every histogram, per process, per shard and merged |
| V-K | recordedTotal − count > 0.1 %; merged ≠ bucket sum | per histogram before merge; merged = bucket-by-bucket sum, per window and per shard |
| V-D | percentile denominator ≠ delivered − unstamped | per path, including the shard-K subsets |
| V-G | upstream offeredRatio < **0.99** | merged `sent / scheduleTicksDue`, steady (and storm survivors) |
| V-I / H4 | ingest reality | Cadence on shard K's own publisher arrival gaps (frame gap ≥ 0.5 × 50 ms). Band 0.5–2.0 × expected. Ingest→forward p50 ≥ 100 µs. ≥ 99 % stamped. Arrivals must equal ingest |
| V-P | placement, membership, per-shard attribution | Every report carries shardCount = 24 and DCID length 20 ≠ CID_LEN. At steady entry, client-derived per-shard counts (realm + raid) equal the server `sessionsAtSteady` per shard. Per-shard attributed sends equal realm sends. Raid: shard K reports exactly tokens 1..40 plus 1 publisher, and no other shard reports any raid member. Storm: re-checked at storm end |
| V-B | shared barrier | All parties on one barrier with the registered party count (4 realm processes, plus publisher and subscriber in hotspot = 6). Steady-entry skew ≤ **100 ms** |
| V-T | sever-instant skew across processes | max − min of each process's own `severUnixMs` ≤ **100 ms**. Every process's sever barrier covers 4 parties |
| V-R | first reconnect Initial late | Per process and merged, the latest first-Initial issue instant minus (process sever + 1,000 ms) must be ≤ **R = 500 ms**. Raw integrity also checked: issue clock `dcid-provider-call`; Initials = cohort share; lateness samples = Initials; none negative; merged = bucket sum. On S2-40k, lateness is reported only (§8 item 3) |
| V-F′ | per-process generator scheduleLag p99 > **10 ms** in the clause's named histogram, worst process | The named clause becomes INVALID, never a MISS. H1/H3 use steady-window scheduleLag (realm processes + publisher). S-C1 uses storm-window survivor scheduleLag. A histogram with no samples is recorded as not applicable |
| V-W | storm-window fallback fraction > **1 %** | From raw `steer_stats` dumps at storm start and end: Δfallback / (Δsteered + Δfallback). Per-slot deltas disclosed. The old steered ≥ 0.9 × work comparison is disclosure only |
| V-L | acceptRate × meanAcceptLatency within ±20 % of the connect concurrency | Strips S-M only (characterization scope). It cannot fire while there is no permit pool |

## 7. Verdict and stop rules

- **Cell verdict.** A cell is INVALID if any run-scope falsifier fires or
  any gated clause is V-F′-INVALID. Otherwise it is MISS if any gated clause
  missed, INCOMPLETE if any gated clause is incomplete, and PASS otherwise.
  Characterization-scope findings (V-L, and V-R lateness on S2-40k) never
  change a cell verdict.
- **Run rules.**
  - PASS and MISS continue to the next cell.
  - INVALID **or a clause INCOMPLETE** stops the run INCOMPLETE. The work
    grader refuses both, and teardown follows.
  - A later storm INVALID never voids hotspot cells already stamped.
- **Arm verdicts.**
  - Hotspot = H40k. H5k is reported as the bridge.
  - Storm = the worst of S1-5k, S2-5k and S1-40k. S2-40k is characterization
    only.
  - The stamp (`g6-sharded-arms-stamp/1`) is authoritative only with no
    rehearsal override.
- No knob changes, retries, reduced load, raised budgets or second pair. A
  cleanup failure is reported, never edited.

## 8. Amendments to plan r6 and disclosures (decided before freeze)

Amendments (lead decisions, 2026-10-07):

1. **R = 500 ms** (`SHARDED_ARMS_V_R_MS = 500`), fixed from the work-item-6
   characterization
   (`.scratch/bare-metal-campaign/g6-sharded-arms/characterization/v-r-characterization-2026-10-07.md`,
   sha256 `e070f80f…bb078141`). The VM worst case at S1-40k's 2,000-per-process
   cohort is 171–181 ms, and the derated projection is ≤ 260 ms. The frozen
   value always wins in the campaign grader. A rehearsal R is accepted only
   by the stamp evaluator for dry stamps, and that stamp is never
   authoritative.
2. **V-S tolerance.** The plan read "delivery < 0.995 → INVALID", and the
   reused `falsifierSink` also fired on any originator skip. Registered: the
   cell is INVALID by V-S only if sink delivery < 0.995 OR the originator's
   achieved rate < 0.995 × 1,200/s. A skip fraction ≤ 0.5 % is tolerated, and
   the raw skip count, due ticks and achieved rate are disclosed under
   `characterization.V-S`.
3. **V-R on S2-40k is reported, not verdict-forcing.** The cell is
   characterization only. The VM envelope does not bound a 10,000-per-process
   cohort within R with confidence (about 805 ms without speed-up). Lateness
   beyond R is recorded as `V-R (reported)` (characterization scope). V-R's
   raw-integrity checks still force INVALID.
4. **S-C1 survivor upstream accounting.** The native ACK reflector consumes
   action datagrams before the shard's JS survivor counter, so
   `windows.storm.rxSurvivors` holds survivor moves only. The registered
   numerator is Σ `rxSurvivors` + survivor actions whose reflection the
   survivor received (client `stormSurvivors.rxAck`), over client
   `stormSurvivors.sent`. This is a lower bound: a lost reflection counts as
   an upstream loss. The uncorrected moves-only ratio is reported beside it.
5. **Raid slot K = 0** (server id 1).

Disclosures:

6. Survivors are silent for about 2 s before the storm window (end of
   steady, 1 s drain, sever, 1,000 ms delay).
7. The V-R clock is the quinn DCID-provider call for the reconnect's first
   Initial, not a wire send time.
8. The storm window uses two clocks. The server window is timed from the
   scan host's receipt of process 0's sever marker. Client survivor windows
   are timed from each process's own sever instant.
9. The loopback forwarder is the Rust g6-server on 127.0.0.1:4499. The
   fan-out stops it with SIGTERM, so exit 143 is required. A failed
   forwarder is recorded by the scan and graded INVALID.
10. The scan records facts only. Every verdict is recomputed by the grader.
11. V-F applies `floorReportIsUsable` minus its host checks, because the
    Linux generator entry prints no host provenance line.
12. V-B is the six-party barrier (4 realm processes, publisher, subscriber)
    in hotspot cells and four parties in storm cells.
13. INCOMPLETE (a clause without a percentile or ratio) stops the run like
    INVALID.
14. Arms plans reuse the `ladder-only` lifecycle. A complete run therefore
    seals `LADDER_COMPLETE`; no new lifecycle reaches the rig code.
15. mmo-client stamps the hard-coded closeout pre-registration id/path
    (`g6-mmo-closeout/1`) beside the sha256 it is given. Reports bind to
    this gate's frozen registration by sha256 only.
16. The fan-out tagger fix `0ad11aef` (whole-line writes under a per-stream
    flock) changes the generator's output path for steady cells as well. It
    is a harness fix with no measurement semantics.
17. Idle timeout is 300 s. S-C2's 120 s window derives from a 60 s default.
    The close is abrupt, not a black hole.
18. Raid co-location makes H1–H3 easier than G6-04's single-instance
    hotspot. Product handshake/accept limiter counters are reported (§5).

## 9. Budget

- Price ceiling: 1,742,900 µUSD/h per role, 2 roles.
- Active time: setup 2,100 s (live host review, cutoff CREATE_INTENT +
  1,680 s), plus control 60 s, plus 2 × 480 s hotspot, plus 4 × 600 s
  storm = 5,520 s.
- Teardown reserve: 600 s.
- Maximum liability: ceil(1,742,900 × 6,120 / 3,600) × 2 = **5,925,860 µUSD**.
- Ceiling: **143,544,166 µUSD** (unchanged).
- The policy chains to the sealed ledger of the last chained run,
  `g6-sndbuf-50k-p2-20261005-02` (`terminal/final-spend-ledger.json`). Its
  sealed chain total is **117,080,820 µUSD**.
- Out-of-chain spend, disclosed and not chained:
  - B-10: 1,394,320 µUSD;
  - B-11: 3,718,188 µUSD;
  - network probes: about 1.13 M µUSD.
- True spend before this run is therefore about **123.3 M µUSD**. The true
  worst case after this run is about 129.25 M µUSD, which is below the
  ceiling.

## 10. Stop rules and authority

- Exactly one pair, with no automatic recreation.
- Sequential, unconditional Architect → Critic approval of the exact
  semantic freeze is required before creation.
- A fresh sequential Architect → Critic host review of the exact prepared
  pair is required before `/tmp/bench.lock` or load. A missing or late host
  review → INCOMPLETE and exact-owned teardown.
- The run is sealed before destruction, and absence is verified afterwards.
- Stamp, then an independent audit.
