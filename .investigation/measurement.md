# Does the single tokio worker cap server receive throughput?

Branch `investigate/quic-parallelism`, measured 2026-08-16 at commits `358b867`
(instrumentation), `7795bd2` (native control), `d27f1b8` (sharded generators).

**Short answer: yes, and far more sharply than the hypothesis predicted — but
the first sweep did not show it, because that sweep was measuring the load
generator.** Once the offered load is real, one tokio worker delivers 5,373
datagrams/s where two deliver 89,002. The same quinn stack with the addon
removed delivers 115,557/s on one worker. The single-worker runtime is not a
throughput ceiling; it is an overload collapse.

---

## Host and conditions

Apple M1 Max, 8 performance + 2 efficiency cores (`available_parallelism()` =
10), macOS 26.4, Bun 1.3.14. Server, load generators and harness are all
co-resident on loopback. Every arm is receive-only — no echo — at 1150-byte
payloads. Warmup 5s, measurement window 20s, arms interleaved round-robin,
3 reps unless noted. Every run refuses on a dirty tree, an unreadable or moved
HEAD, or a non-finite sample.

## Proof the arms actually differed

This is the part the previous investigation nearly got wrong, so it is the part
built first. Two independent checks, both required, both enforced in
`proofFailures()`:

1. **Configured count.** `crates/native/src/lib.rs` reads
   `WEBTRANSPORT_SERVER_WORKER_THREADS` (positive integer, or `auto` for
   `available_parallelism()`) and **aborts** on anything else rather than
   falling back to 1. A typo cannot quietly produce a default-configured arm
   that then reads as a genuine negative.
2. **Observed parallelism.** `crates/native/src/worker_probe.rs` counts
   datagrams per OS thread, registering a slot the first time a thread touches
   the receive path. The harness reports how many distinct threads carried load
   in the measurement window, and **refuses** any arm configured with more than
   one worker whose datagrams only ever landed on one thread.

The counts came out exactly as configured in every single run — 1, 2, 4 and 10
distinct `wt-server` threads — and the work divided evenly rather than piling
onto one thread. From one `workers=auto` window:

```
ThreadId(20)=130,826  ThreadId(19)=128,624  ThreadId(15)=125,916
ThreadId(16)=125,807  ThreadId(14)=124,774  ThreadId(13)=124,655
ThreadId(18)=124,602  ThreadId(12)=122,873  ThreadId(17)=118,956
ThreadId(21)=118,290
```

Spread across ten threads within 10% of each other. The knob took effect, and
the per-session datagram tasks genuinely ran in parallel. Zero `failures` in
every artifact.

The same proof is built into the Rust control
(`crates/reference/src/recv_floor_server.rs`), registered through a thread-local
so the hot path never takes a lock.

---

## Run A — worker sweep, one load-client (150 sessions x 1,000/s nominal)

| workers | recv/s (median) | server cores | worst saturation | offered/s | dgram threads |
|---|---|---|---|---|---|
| 1 | 50,704 | 2.14 | 0.79 | 67k–76k | 1 |
| 2 | 58,208 | 2.57 | 0.44 | 131k–137k | 2 |
| 4 | 62,033 | 3.21 | 0.64 | 97k–115k | 4 |
| auto (10) | 62,791 | 3.88 | 0.84 | 75k–78k | 10 |

Best arm / `workers=1` = **1.2384x**, for 1.81x the CPU. Read on its own this is
the boring answer the hypothesis feared: a modest gain, poor marginal
efficiency, plateauing between 4 and 10 workers.

**It is also wrong**, and the `offered/s` column is why. The load generator
delivered anywhere from 67k to 137k depending on the arm. Offered load was never
a controlled variable, and no arm was ever driven at the nominal 150k/s.

## Run B — session sweep, workers=1, one load-client (aggregate held ~150k/s)

| sessions | rate each | recv/s | server cores | saturation |
|---|---|---|---|---|
| 4 | 37,500/s | 43,098 | 1.95 | 0.565 |
| 16 | 9,375/s | 52,795 | 2.07 | 0.994 |
| 64 | 2,344/s | 50,488 | 2.09 | 0.870 |
| 150 | 1,000/s | 54,251 | 2.14 | 0.681 |

**This refutes the per-connection-cost reading that motivated the
investigation.** Fewer sessions gave *less* throughput, not more: 4 sessions is
the worst arm at 43k, 150 sessions the best at 54k. CPU barely moves across the
sweep (1.95 → 2.14 cores).

The original "4 sessions x 15,000/s gave 59,907/s on 1.58 cores" observation had
a saturation ratio of 1.0006 — it was sender-limited, and was being compared
against a receiver-limited 150-session arm. "Fewer sessions, more throughput" is
an artifact of comparing a measurement of the sender against a measurement of
the receiver. There is no per-connection cliff here. (The `sessions=16` arm
above, at saturation 0.994, is sender-limited in the same way and should be
read as offered load, not capacity.)

## Run C — the control: same quinn stack, no addon, no N-API, no JS

`recv-floor-server` is the identical wtransport receive loop with the delivery
hop deleted. One load-client, 150 sessions:

| workers | recv/s | server cores | offered/s |
|---|---|---|---|
| 1 | 50,633 | 0.81 | 65,124–65,388 |
| auto (10) | 52,528 | 1.64 | 66k–72k |

Two things here. The control reaches the same ~50k as the addon while using
**38% of the CPU** (0.81 vs 2.14 cores), so the addon's cost is real but was not
the ceiling. And the offered rate is pinned at 65.1k–65.4k across all three
`workers=1` runs — a variance of 0.4%. That is not a server responding to load;
that is a generator at its own limit.

## Run D — the control with the generator unblocked (3 client processes)

| workers | recv/s | server cores |
|---|---|---|
| 1 | **115,557** | 0.98 |
| auto (10) | 106,508 | 2.87 |

One load-client tops out near 65k/s. Three of them let the *same one-worker*
Rust server take 115,557/s on under one core. **Every number in Runs A, B and C
was the load generator's ceiling, not the server's.** Ten workers is 8% *slower*
than one and costs 2.9x the CPU.

## Run E — the addon with the generator unblocked (3 clients, ~149.5k/s offered)

| workers | recv/s (median) | server cores | saturation | dgram threads |
|---|---|---|---|---|
| 1 | **5,373** | 1.30 | 0.036 | 1 |
| 2 | **89,002** | 3.29 | 0.60 | 2 |
| 4 | 81,682 | 3.27 | 0.55 | 4 |
| auto (10) | 48,042 | 3.10 | 0.32 | 10 |

Best arm / `workers=1` = **16.56x**.

Per-round, `workers=1` gave 5,373 / 5,383 / 5,364 — a 0.2% spread, with all 150
sessions healthy, zero session errors, zero client send errors, and the full
149.5k/s offered. This is not noise and not a broken run. It is a stable
pathological state in which the server accepts 3.6% of what arrives while
leaving 8.7 of 10 cores idle.

## Run F — intermediate load (2 clients, 1 rep)

| workers | recv/s | server cores |
|---|---|---|
| 1 | 5,385 | 1.20 |
| 2 | 58,008 | 2.04 |
| 4 | 43,013 | 2.02 |
| auto (10) | 29,373 | 2.11 |

The collapsed floor is the same ~5,380/s at two clients as at three. The session
sweep under both 2 and 3 clients also sat at 5,100–5,433/s for every session
count from 4 to 150 — the collapse does not care how the load is divided.

---

## What this says

**1. The single tokio worker is a real and serious limit, but as a cliff rather
than a ceiling.** Below roughly 70k/s offered it looks fine (50k delivered).
Somewhere between there and 145k/s it does not plateau — it falls to a fixed
~5,380/s, a 10x *reduction* in delivered throughput in response to a 2x
*increase* in offered load. Since `worker_threads(1)` is the shipped default,
this is production behaviour, not an artifact of the experiment.

**2. Two workers is worth 16x under overload; more than two is worth less than
two.** 2 workers median 89,002/s, 4 workers 81,682, 10 workers 48,042 and
falling. Whatever the fix is, it is not "use `available_parallelism()`".

**3. The ceiling above the cliff is the addon, not the transport.** With the
generator unblocked, the pure Rust control does 115,557/s on 0.98 cores; the
best addon arm does 89,002/s on 3.29 cores. The delivery path costs roughly 3.4x
the CPU per datagram and gives up ~23% of the rate. That gap is the real
optimization target, and it is a per-datagram cost — which is consistent with
the batching investigation's finding that the JS reader is not the bottleneck,
since the cost is in the crossing rather than the drain.

**4. The measurement that motivated this investigation was measuring the
sender.** Both of its data points were generator-limited, and the
"per-connection cost" signature it showed does not survive a controlled session
sweep.

## What this measurement cannot see

- **The collapse mechanism is not established.** I have a reproducible
  behaviour and no root cause. The constancy of the floor (~5,380/s across every
  session count, client count and offered rate above the knee) argues against
  simple starvation, which would vary with load, and points at something with a
  fixed service rate — a per-tick handoff between the single worker and the JS
  thread. That is a hypothesis, not a finding. Proving it needs a profile or a
  tokio task-scheduling trace, not another throughput number.
- **The knee is not located.** I have 50k delivered at ~70k offered and 5.4k at
  ~145k. A proper ladder between those two would say where production traffic
  actually sits relative to the cliff. This matters more than any number above.
- **Everything is loopback on one machine**, with generators, server and harness
  contending for the same 10 cores. Cross-host numbers will differ, possibly a
  lot, and the ordering of arms is more trustworthy here than the magnitudes.
- **Offered load is still not properly controlled.** Sharding across three
  clients raised it to a consistent ~149.5k/s, but the correct experiment pins
  offered load and sweeps it, rather than asking for a rate and recording what
  arrived.
- **One host, one payload size, one Bun version, receive-only.** No echo, no
  streams, no send path. The send path may behave completely differently.
- **The instrumentation is exonerated but not free.** `record_datagram()` adds a
  thread-local read and a relaxed atomic increment per datagram. It cannot
  explain the collapse — the same build at `workers=1` with one client delivered
  50,704/s with no collapse at all, and `workers=2` with identical
  instrumentation delivered 16x more than `workers=1`.

## Recorded gate breakage

`scripts/check-doc-truth.ts` pins the exact constructor string
`Builder::new_multi_thread().worker_threads(1)` and now reports **1 violation**:
`crates/native/src/lib.rs: RUNTIME contradicts
Builder::new_multi_thread().worker_threads(1)`. This is expected on an
investigation branch and the gate was deliberately left untouched.
`packages/webtransport/test/internal-doc-truth.test.ts` still passes 15/15 — it
checks the documentation prose rather than the source, and the docs were not
changed.

## Artifacts and how to reproduce

- `.investigation/worker-thread-parallelism-probe.json` — Runs A and B
- `.investigation/worker-thread-parallelism-probe-c2.json` — Run F
- `.investigation/worker-thread-parallelism-probe-c3.json` — Run E
- `.investigation/native-recv-floor-control.json` — Run C
- `.investigation/native-recv-floor-control-c3.json` — Run D

```sh
CARGO_TARGET_DIR=$PWD/target cargo build -p reference \
  --bin load-client --bin recv-floor-server --release
bun run build:native

bun tools/bench/worker-thread-parallelism-probe.ts                 # A + B
WT_PROBE_CLIENTS=3 bun tools/bench/worker-thread-parallelism-probe.ts   # E
bun tools/bench/native-recv-floor-control.ts                       # C
WT_PROBE_CLIENTS=3 bun tools/bench/native-recv-floor-control.ts    # D
```

Knobs: `WT_PROBE_CLIENTS`, `WT_PROBE_SESSIONS`, `WT_PROBE_AGGREGATE`,
`WT_PROBE_REPS`, `WT_PROBE_WARMUP_SEC`, `WT_PROBE_MEASURE_SEC`, `WT_PROBE_SEED`.
