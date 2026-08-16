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

## Run G — per-thread profile: which thread is actually pinned?

`process.cpuUsage()` is process-wide and Bun's
`performance.eventLoopUtilization()` is a stub that returns zeroes, so neither
could answer this. Each thread therefore reads its own
`CLOCK_THREAD_CPUTIME_ID` — the tokio workers from the datagram path, the JS
thread from the N-API getter, which by definition runs on it. Deltas over the
same 20s window as the throughput; the residual against the process total is
reported rather than hidden.

`ingested/s` is counted where quinn hands the datagram over, **before** the
rate-limit check and the queue reservation. `delivered/s` is what the JS reader
actually saw. The gap between them is the finding.

| workers | clients | delivered/s | ingested/s | dropped | process | tokio | JS | unattributed |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 50,899 | 50,897 | 0% | 2.11 | 0.82 | 0.46 | 0.83 |
| 1 | 3 | 5,393 | **102,993** | **95%** | 1.30 | **0.96** | **0.13** | 0.21 |
| 2 | 3 | 94,732 | 94,633 | 0% | 3.23 | 1.55 | 0.64 | 1.05 |
| auto (10) | 3 | 72,660 | 93,745 | 22% | 4.02 | 2.67 | 0.47 | 0.87 |

**Neither thread was pinned in the condition that started this investigation.**
At one worker and one client the tokio worker sits at 0.82 cores and the JS
thread at 0.46. The reading that ~2.05-2.16 cores meant "both threads
saturated" was wrong; 0.83 cores belongs to threads that touch neither path
(Bun's GC and helper threads), and the server had headroom it never used
because the generator was the limit.

**In the collapse, the tokio worker is pinned at 0.96 cores and the JS thread
is starved at 0.13.** That is the mechanism, and it is not the one I guessed.
The single worker takes 102,993 datagrams/s *off the wire* — within 11% of what
the pure-Rust control manages — and then delivers 5,393/s of them, discarding
95%. The transport half is healthy. What collapses is delivery: with one
worker, the quinn recv and demux work monopolises it, the per-session delivery
futures get almost no service, the queue budget fills, and arriving datagrams
are dropped at the reservation. The JS thread is idle at 0.13 cores waiting for
work that never arrives.

**Two workers eliminates the drops entirely**: 94,633 ingested against 94,732
delivered. Give the delivery half its own thread and it keeps up.

The reject path is identified. Differencing the server's own counters over the
window:

| workers | datagramsIn | datagramsDropped | rateLimited | backpressureWait | delivered/s |
|---|---|---|---|---|---|
| 1 | 1,932,921 | **1,825,573** (94.4%) | **0** | 0 | 5,368 |
| 2 | 2,007,214 | **0** | 0 | 0 | 100,248 |

`rateLimited` is zero, so the limiter is not throwing anything away — the drops
are the queued-bytes reservation
(`try_reserve_queued_bytes_with_session`). The queue budget fills because the
starved delivery future never drains it, and from then on every arriving
datagram is rejected at reservation. At two workers the budget never fills and
not one datagram is dropped.

The whole profile replicated on an independent rerun (47,793 / 5,392 / 94,712 /
72,588 delivered per second, with the same per-thread split to within 0.04
cores), so these are not single-shot numbers.

**Ten workers brings the drops back** (22%) while ingesting no more than two
did. This is where extra workers stop paying.

## Run G, continued — rate-limiter contention

`try_acquire_datagram_ingress` takes a mutex inside a `DashMap` entry keyed by
`(server_id, peer_ip)`. On loopback every session is `127.0.0.1`, so all 150
share one bucket and every worker contends for it once per datagram. Timing is
opt-in (`WEBTRANSPORT_WORKER_PROBE_TIMING=1`) because it costs two clock reads
per datagram; the throughput arms above ran without it.

| workers | limiter cores | calls | ns per call |
|---|---|---|---|
| 1 (1 client) | 0.009 | 1,017,946 | 173 |
| 1 (3 clients) | 0.012 | 2,059,865 | 119 |
| 2 | 0.028 | 1,892,651 | **296** |
| auto (10) | 0.152 | 1,874,896 | **1,623** |

**The contention the analysis predicted is real and scales with worker count**:
119 ns per call uncontended, 296 ns at two workers, 1,623 ns at ten — 13.6x.
At ten workers the limiter alone burns 0.152 cores, and because it is
serialised it caps aggregate ingress around 620k/s on its own. It is not yet
the binding constraint, but it is a direct contributor to why ten workers is
worse than two rather than merely no better.

Two caveats, both important. This is a **loopback worst case**: distinct client
IPs in production would hash to different `DashMap` shards and different
mutexes, so real deployments will contend far less. And the key is built with
`peer_ip.to_string()` — a heap allocation per datagram on the hot path,
independent of contention and present at every worker count.

## Run G, continued — quinn-udp `BATCH_SIZE` on this platform

Confirmed two independent ways.

**By feature resolution.** `quinn-udp-0.5.14/build.rs` defines
`apple_slow: { all(apple, not(feature = "fast-apple-datapath")) }`, and
`unix.rs:790-795` sets `BATCH_SIZE` to 32 under `not(apple_slow)` and **1**
under `apple_slow`. `cargo tree -i -e features quinn-udp@0.5.14` on this
workspace resolves exactly three features — `default`, `log`, `tracing`.
Nothing in the graph enables `fast-apple-datapath`.

**By live stack.** `sample(1)` taken mid-window against the running server
found `recvmsg` and never `recvmsg_x` in three of four profiled cases (the
fourth is a tooling miss — `sample` wrote to a file instead of stdout — not a
contradiction). `recvmsg_x` is the batched Apple datapath and is only compiled
in under `apple_fast`.

So **the endpoint driver on this host performs one `recvmsg` syscall per
datagram**, all of it serialised under the endpoint mutex that
`quinn-0.11.11/src/endpoint.rs:370` holds across `drive_recv` and
`handle_events`. On Linux with GRO the same code path batches 32.

**Every number in this document therefore comes from a receive path that is
substantially more expensive per datagram than the deployment target's.** This
does not invalidate the collapse finding — at one worker the server still
ingests 103k/s, so the syscall cost is not what starves delivery — but it does
mean the absolute rates are a macOS floor, and the balance between "endpoint
driver work" and "per-connection work" is different on Linux. A Linux rerun
before acting on any specific worker count is warranted.

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

**5. The collapse is delivery starvation, not a receive limit, and the JS
thread is innocent.** The per-thread profile settles the question the A/B could
not: at one worker under real load the tokio worker is pinned at 0.96 cores
while the JS thread idles at 0.13, and the server ingests 102,993 datagrams/s
off the wire while delivering 5,393/s. The receive half is working fine and
throwing away 95% of what it takes in, because the delivery futures cannot get
scheduled on the one worker that the recv/demux loop is monopolising. Two
workers gives delivery its own thread and the drops vanish completely.

**6. The premise that motivated the profile does not hold, in a way that
strengthens the result.** ~2.1 cores was never "two threads saturated": it is
0.82 tokio + 0.46 JS + 0.83 in Bun's other threads. The JS thread has never been
the constraint at any load or worker count measured here, peaking at 0.64 cores.

**7. Multi-worker contention on our own rate limiter is real** — 119 ns per
call at one worker, 1,623 ns at ten — and is part of why ten workers is worse
than two. It is a loopback worst case (one shared bucket for all 150 sessions)
and should be far milder with distinct production client IPs, but the
per-datagram `peer_ip.to_string()` allocation in the key is unconditional.

**4. The measurement that motivated this investigation was measuring the
sender.** Both of its data points were generator-limited, and the
"per-connection cost" signature it showed does not survive a controlled session
sweep.

## What this measurement cannot see

- **The collapse mechanism is now located but not fully explained.** The
  profile establishes *where* it happens — the worker is pinned, the JS thread
  is starved, 95% of ingested datagrams are discarded before delivery — but not
  *why the floor is so precisely constant* at ~5,380/s across every session
  count, client count and offered rate above the knee. Pure starvation would be
  expected to vary with load. Something downstream of the starved delivery
  future is running at a fixed service rate. Identifying it needs a tokio task
  trace, not another throughput number.
- **Whether the queue budget is per-session or global is not separated.** The
  drops are the queued-bytes reservation and not the rate limiter, but
  `try_reserve_queued_bytes_with_session` checks both ceilings and increments
  one counter for either.
- **The knee is not located.** I have 50k delivered at ~70k offered and 5.4k at
  ~145k. A proper ladder between those two would say where production traffic
  actually sits relative to the cliff. This matters more than any number above.
- **The recv path here is macOS-specific and more expensive than production's.**
  quinn-udp resolves `BATCH_SIZE` to 1 on this host (verified above), so the
  endpoint driver makes one `recvmsg` syscall per datagram under the endpoint
  mutex, where Linux with GRO batches 32. Absolute rates are a macOS floor and
  the recv/per-connection work balance differs on the deployment target.
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

## Run H — Linux heavy runner: does the cliff reproduce off macOS?

Everything above was measured where quinn-udp resolves `BATCH_SIZE` to 1, so the
endpoint driver makes one `recvmsg` syscall per datagram. Linux takes the
`#[cfg(not(apple_slow))]` branch and batches 32 per `recvmmsg`. That changes the
per-datagram economics enough that repeating one macOS operating point would
prove nothing, so this sweeps offered load against worker count instead.

Run [31943971720](https://github.com/vmeansdev/webtransport-bun/actions/runs/31943971720)
at `fc280de`, dispatched to the existing `bench-bandwidth` workflow with
`--ref investigate/quic-parallelism` and a new `worker_probe` input (GitHub will
not register a dispatch-only workflow that lives only on a non-default branch).
Artifact downloaded, not console-scraped. `status: ok`, zero failures.

**Runner capacity, read from the workflow rather than assumed:** 4 vCPU, 7,423 MB,
AMD Ryzen 5 3550H, Ubuntu, `linux/x64`. Two and a half times smaller than the
M1 Max, with both load-generator processes co-resident, so absolute rates are
not comparable to the macOS runs — only the shapes are.

100 sessions, 1150-byte payloads, 2 generator processes, 2 reps interleaved,
5s warmup and a 15s window.

| arm | requested/s | offered/s | delivered/s | ingested/s | drop % | process | tokio | JS | threads |
|---|---|---|---|---|---|---|---|---|---|
| workers=1 | 20,000 | 19,985 | **20,000** | 20,001 | 0.0 | 1.79 | 0.96 | 0.37 | 1 |
| workers=1 | 40,000 | 39,905 | **5,283** | 39,521 | **80.5** | 1.65 | 0.99 | 0.31 | 1 |
| workers=1 | 80,000 | 79,762 | 5,366 | 55,095 | 89.6 | 1.61 | 0.98 | 0.30 | 1 |
| workers=1 | 160,000 | 159,479 | 5,360 | 52,823 | 88.8 | 1.50 | 0.96 | 0.27 | 1 |
| workers=2 | 20,000 | 19,987 | 20,001 | 20,000 | 0.0 | 1.73 | 1.05 | 0.32 | 2 |
| workers=2 | 40,000 | 39,855 | **39,497** | 39,492 | **0.0** | 2.38 | 1.62 | 0.41 | 2 |
| workers=2 | 80,000 | 78,476 | 36,543 | 77,041 | 48.3 | 2.28 | 1.67 | 0.35 | 2 |
| workers=2 | 160,000 | 150,816 | 27,046 | 104,010 | 74.0 | 2.13 | 1.62 | 0.30 | 2 |

**The cliff reproduces, and the knee is now bracketed.** At one worker the
server is perfectly clean at 20k offered — 20,000 delivered, not one datagram
dropped — and has collapsed by 40k. The knee for `workers=1` on this host is
between 20,000/s and 40,000/s offered.

**No arm was generator-limited.** `generatorLimitedRates` is empty. Offered
tracked requested to within 0.7% at every rung up to 160k (19,985 / 39,905 /
79,762 / 159,479), so the trap that invalidated Runs A through C did not bite
here. `testedTheCliff` is true.

**The collapsed floor is the same number on both platforms.** macOS
5,364-5,393/s; Linux 5,250-5,367/s. Same on a different ISA, a different OS, a
different core count, and a receive path that batches 32 instead of 1. A
CPU-cost explanation cannot survive that: the 32x cheaper syscall path did not
move the floor at all. Whatever services the starved delivery future runs at a
fixed rate independent of the platform underneath it.

The rest of the signature matches too. The single worker is pinned at
0.96-0.99 cores in every collapsed arm (macOS: 0.96). The JS thread idles at
0.27-0.37 cores (macOS: 0.13) — nowhere near saturated on either. `rateLimited`
is 0 in all sixteen runs, so the drops are the queued-bytes reservation, same
as macOS. Per-round spread is tight: 5,315/5,250 and 5,364/5,367.

**Two workers is not a cure on a host this small, only a large improvement.**
It is clean through 40k where one worker has already collapsed, but degrades to
48% drops at 80k and 74% at 160k. Note that at those rungs the two workers sit
at 0.81 cores each rather than pinned, on a 4-vCPU box also running two
generator processes — so they may be runnable-but-unscheduled rather than out
of work, which per-thread CPU time cannot distinguish. That reading is a
limitation of this host, not a property of the code.

### macOS versus Linux

| | macOS (M1 Max, 10 cores) | Linux (Ryzen 5 3550H, 4 vCPU) |
|---|---|---|
| `BATCH_SIZE` | 1 (one `recvmsg` per datagram) | 32 (`recvmmsg`) |
| Clean at one worker up to | ~70k offered | 20k offered |
| Collapsed by | ~145k offered | 40k offered |
| Collapsed floor | 5,364-5,393/s | 5,250-5,367/s |
| Worker CPU when collapsed | 0.96 cores | 0.96-0.99 cores |
| JS thread when collapsed | 0.13 cores | 0.27-0.31 cores |
| Reject path | queued-bytes reservation | queued-bytes reservation |
| `rateLimited` | 0 | 0 |
| Two workers at the collapse point | 89,002/s, 0% dropped | 39,497/s, 0% dropped |

The knee arrives at lower absolute load on Linux, which is what a host with 40%
of the cores and co-resident generators should do; it is not evidence that
Linux is worse per core. What matters is that the failure mode is identical in
kind, in floor, and in reject path on both platforms.

## What worker count the evidence supports

**`worker_threads(1)` should not ship.** It is the current default, and on both
platforms it turns a manageable overload into a ~10x throughput *reduction*
with 80-95% of ingested datagrams discarded, while the process leaves most of
the machine idle. Two independent platforms, twelve independent collapsed runs,
same floor, same reject path. Confidence: **high**.

**Two workers is the supported choice.** It eliminated the drops entirely at
every rung where one worker collapsed, on both hosts, and on macOS it also beat
four (81,682/s) and ten (48,042/s). Confidence: **moderate** — it is clearly
better than one and better than many, but the sweep has only two Linux worker
counts, and the 4-vCPU runner cannot say whether four would help a larger Linux
box. A worker count is also a mitigation rather than a fix: two workers still
degraded to 48% drops at 80k on the small host, so the underlying starvation
still bites, just further out.

**What I would not conclude yet.** That two is optimal on production hardware;
the macOS ordering (2 > 4 > 10) may not transfer to a many-core Linux server,
and testing that needs a runner with more than 4 vCPU. And nothing here
justifies `available_parallelism()`, which was the worst arm on macOS.

## Run I — ROOT CAUSE: tokio's injection-queue servicing cadence

**The fixed cadence is `tokio`'s `global_queue_interval`, and the ~5,300/s floor
is one delivery per ~200µs of worker time. Established by falsifier, not by
inspection.**

### The path

`session_napi.rs:157` dispatches every single `readDatagram()` like this:

```rust
env.spawn_future(async move {           // runs on the N-API runtime
    RUNTIME.spawn(async move { ... })   // spawns into the SERVER runtime
        .await
})
```

`RUNTIME.spawn` called from the N-API runtime is a spawn from *outside* the
server runtime, so the task goes to that runtime's **injection queue**, not to
any worker's local queue. A worker reaches the injection queue two ways
(`tokio-1.53.1/src/runtime/scheduler/multi_thread/worker.rs`):

- **when it runs dry** — line 1533, `while let Some(task) = self.next_remote_task()`,
  which drains it in bulk;
- **on a tick counter** — line 1077:

```rust
if self.tick % self.global_queue_interval == 0 {
    self.tune_global_queue_interval(worker);
    ... .next_remote_task()     // exactly ONE task
}
```

Under sustained overload with 150 always-ready session tasks, a single worker's
local queue **never** runs dry, so the first path never fires and every delivery
must come through the second — one per `global_queue_interval` polls.

And that interval is *time-targeted* (`stats.rs:34,63`):

```rust
const TARGET_GLOBAL_QUEUE_INTERVAL: f64 = Duration::from_micros(200).as_nanos() as f64;
let tasks_per_interval = (TARGET_GLOBAL_QUEUE_INTERVAL / self.task_poll_time_ewma) as u32;
tasks_per_interval.clamp(2, 127)
```

One remote task per **200µs of work**. That is 5,000 deliveries/s — and it is a
scheduler policy constant, which is precisely why a 32x cheaper receive path did
not move it: the tuner re-derives the same 200µs of *work* whatever that work
costs per datagram.

### The falsifier

Setting the interval explicitly disables the tuner (`stats.rs:58`), so if this
is the mechanism the floor must track it inversely. Collapse condition, one
worker, 150 sessions, 3 generators, ~150k/s offered:

| `global_queue_interval` | delivered/s | dropped | delivered x interval |
|---|---|---|---|
| 2 | **47,930** | **2%** | 95,860 |
| 8 | 11,678 | 89% | 93,424 |
| 32 | 2,836 | 97% | 90,752 |
| 127 | 726 | 99% | 92,202 |
| unset (tuned) | 5,112 | 93% | — implies effective ≈ 18 |

**The product is constant at ~93,000 ± 3% across a 64x span of the knob.** That
is `delivered = poll_rate / global_queue_interval` exactly as one-task-per-check
predicts, with ~93,000 local polls/s. The tuned floor corresponds to an
effective interval of ~18, i.e. a mean task poll time of ~11µs against the
200µs target. Hypothesis confirmed quantitatively, not just directionally.

This also explains why two workers fixed it and why the JS thread stayed idle:
with the work spread, workers intermittently run dry and hit the *bulk* drain at
line 1533, so the tick path stops being the only route.

### The smallest correct fix

The hop buys nothing. `read_datagram_for_session` only locks a Tokio mutex and
receives from a Tokio mpsc — no timers, no IO driver, no server-runtime context
of any kind — so it runs correctly on the N-API runtime `spawn_future` already
provides. Deleting the `RUNTIME.spawn` wrapper removes the injection queue from
the delivery path entirely.

A/B at the collapse condition (`WEBTRANSPORT_READ_DATAGRAM_VIA_SERVER_RUNTIME`
retained only so this can be re-run):

| runtime hop | workers | delivered/s | ingested/s | dropped | cores |
|---|---|---|---|---|---|
| yes (today) | 1 | 5,266 | 97,951 | **95%** | 1.23 |
| **no (fix)** | 1 | **84,823** | 84,820 | **0%** | 2.51 |
| yes | 2 | 101,272 | 100,585 | 0% | 3.19 |
| no (fix) | 2 | 103,549 | 103,774 | 0% | 2.87 |

**A 16.1x improvement at the shipped worker count, with drops going to zero.**
It fixes the defect rather than masking it: the single-worker default becomes
safe on its own, and at two workers it is slightly faster on ~10% less CPU.

Cost: one deleted `RUNTIME.spawn` wrapper in `session_napi.rs`. Full suite green
(451 pass / 0 fail / 81 skip, 532 tests), 188 Rust tests, clippy clean.

Two caveats. The fix moves read work onto the N-API runtime's threads, so
one-worker CPU rises from 1.23 to 2.51 cores — it is buying throughput with
parallelism that was previously unreachable, not making delivery cheaper. And
the same `env.spawn_future -> RUNTIME.spawn` shape appears on the other session
methods in `session_napi.rs` (`send_datagram`, `discard_datagram`, the stream
opens); only `read_datagram` was measured, and the others should be reviewed for
the same reasoning rather than changed on faith.

### Recommendation revised

Ship **both**, in this order of importance: remove the runtime hop from
`read_datagram` (fixes the root cause, high confidence, falsifier-backed), and
keep two workers (independent headroom, already approved). Two workers alone
leaves the defect in place — it only ensures workers run dry often enough to
dodge it, which a busier server or a larger session count could undo.

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
- `.investigation/thread-profile.json` — Run G (per-thread CPU, limiter timing,
  recv syscall)
- `.investigation/worker-thread-parallelism-probe-c3-echo-hop-{on,off}.json` and
  `*-echo-gqi{2,8,32}.json` — Run J
- `.investigation/worker-thread-parallelism-probe-c3-streams20-hop-{on,off}.json`
  and `*-streams20-gqi{2,32}.json` — Run K
- `.investigation/worker-thread-parallelism-probe-c3-discard-hop-{on,off}.json`
  and `*-discard-gqi{2,8,32}.json` — Run L

```sh
CARGO_TARGET_DIR=$PWD/target cargo build -p reference \
  --bin load-client --bin recv-floor-server --release
bun run build:native

bun tools/bench/worker-thread-parallelism-probe.ts                 # A + B
WT_PROBE_CLIENTS=3 bun tools/bench/worker-thread-parallelism-probe.ts   # E
bun tools/bench/native-recv-floor-control.ts                       # C
WT_PROBE_CLIENTS=3 bun tools/bench/native-recv-floor-control.ts    # D
bun tools/bench/thread-profile.ts                                  # G

# H: Linux heavy runner. bench-bandwidth is already registered, so dispatching
# it with --ref runs the branch's copy of the file including the new input.
gh workflow run bench-bandwidth.yml --ref investigate/quic-parallelism \
  -f candidate_commit=$(git rev-parse HEAD) -f worker_probe=true \
  -f sessions=100 -f worker_sweep_rates=20000,40000,80000,160000 \
  -f worker_sweep_workers=1,2 -f worker_sweep_clients=2
```

Knobs: `WT_PROBE_CLIENTS`, `WT_PROBE_SESSIONS`, `WT_PROBE_AGGREGATE`,
`WT_PROBE_REPS`, `WT_PROBE_WARMUP_SEC`, `WT_PROBE_MEASURE_SEC`, `WT_PROBE_SEED`,
`WT_PROBE_ECHO`, `WT_PROBE_DISCARD`, `WT_PROBE_STREAMS_PER_SEC`,
`WT_PROBE_WORKERS` (restrict the worker sweep, e.g. `1`),
`WT_PROBE_SKIP_SESSION`. Hop A/B knobs:
`WEBTRANSPORT_SEND_DATAGRAM_VIA_SERVER_RUNTIME`,
`WEBTRANSPORT_DISCARD_DATAGRAM_VIA_SERVER_RUNTIME`,
`WEBTRANSPORT_STREAM_OPS_VIA_SERVER_RUNTIME`,
`WEBTRANSPORT_SERVER_GLOBAL_QUEUE_INTERVAL`.

## Run J / K / L — remaining spawn sites (measured 2026-08-16, HEAD `28b570d`)

Same `env.spawn_future -> RUNTIME.spawn` shape as `read_datagram`. Method:
source first, prediction, then a load shape that stresses *that* path, then
the `global_queue_interval` falsifier. Host: macOS M1 Max, 3 load-clients,
150 sessions, ~150k/s offered, workers=1, 10s window. Read hop already off
(the Run I fix), so receive is not itself collapsed unless the path under
test reintroduces the injection queue.

### `send_datagram` (Run J) — REMOVE the hop

**Source.** `send_datagram_for_session` (`session.rs:133`) awaits
`reserve_datagram_capacity` (Notify + `tokio::time::timeout` deadline) then
`conn.send_datagram` synchronously. No IO-driver affinity. The timer needs *a*
tokio time driver; napi-rs's current_thread runtime provides one.

**Prediction.** Under echo at the collapse condition the send hop *will* bind
to the ~5,000/s cadence.

**Result.** Confirmed.

| send hop | recv/s | send/s | echo | dropped | cores |
|---|---|---|---|---|---|
| yes (shipped) | 34,929 | **5,213** | 15% | 1,546 | 1.63 |
| **no (fix)** | 55,306 | **55,306** | **100%** | **0** | 2.71 |

Sends sat on the same floor as the old read path. Removing the hop is a
**10.6x** send lift and takes echo to 1:1. Receive also rose (the worker was
spending injection-queue polls on send tasks). Artifacts:
`worker-thread-parallelism-probe-c3-echo-hop-{on,off}.json`.

**Falsifier (hop on).** Directional, not as clean as the read-path product
because echo couples two paths:

| gqi | send/s | recv/s | send × gqi |
|---|---|---|---|
| 2 | 30,995 | 38,957 | 61,990 (ceiling: almost keeping up with recv) |
| 8 | 8,490 | 70,999 | 67,923 |
| 32 | 4,297 | 59,436 | 137,518 |
| unset (tuned) | 5,213 | 34,929 | implies ~18 against a ~94k poll rate |

gqi=2 is not injection-bound (send ≈ recv). The hop A/B is the deciding
evidence; the interval still moves send the right way.

**Recommendation.** Remove. Same defect as `read_datagram`, same fix.

### Stream open/accept (Run K) — KEEP the hop

**Source.** `accept_*` is mutex + mpsc recv + lifecycle Notify; `create_*` is
a oneshot round trip to the session task. Could move.

**Prediction.** The cadence will **not** bind. Host stream-open capacity sits
well under 5,000/s.

**Result.** Confirmed. Datagram flood kept the worker busy so a dry-queue
bulk drain could not hide a miss.

| stream hop | acc/s | recv/s | cores |
|---|---|---|---|
| yes (shipped) | **1,531** | 78,909 | 2.69 |
| no | **1,532** | 79,515 | 2.69 |
| gqi=2 | 1,516 | 73,699 | 2.60 |
| gqi=32 | 1,538 | 79,655 | 2.63 |

Accepts moved **1.4%** across a 16× interval span; the read path moved 66×.
Offered stream load was 3,000/s (20/session × 150); the host capped at
~1,530/s either way. Artifacts: `*-c3-streams20-*.json`.

**Recommendation.** Leave. Changing an unmeasured-benefit path costs more
than it buys. Revisit only if a host can drive >5,000 opens/s.

### `discard_datagram` (Run L) — REMOVE the hop

**Source.** `discard_datagram_for_session` (`session.rs:186`) is mutex + mpsc
recv plus optional `tokio::time::timeout`. Same class as `read_datagram`.
Production `incomingDatagrams()` uses `readDatagram`; load/evidence drains
call this per datagram from JS.

**Prediction.** A per-call JS loop **will** bind to the same ~5,000/s floor.

**Result.** Confirmed, including the product test.

| discard hop | delivered/s | dropped | cores |
|---|---|---|---|
| yes (shipped) | **5,374** | **94.5%** | 1.27 |
| **no (fix)** | **83,479** | **0%** | 2.46 |

**15.5x**, drops to zero. Floor matches read (5,374 vs 5,266).

| gqi | delivered/s | dropped | delivered × gqi |
|---|---|---|---|
| 2 | 58,450 | 0.1% | 116,900 (approaching ceiling) |
| 8 | 10,614 | 88.3% | **84,914** |
| 32 | 2,643 | 97.4% | **84,578** |
| unset (tuned) | 5,374 | 94.5% | implies ~16 |

Product constant at ~85,000 ± 0.2% across 8 and 32. Artifacts:
`*-c3-discard-*.json`.

**Recommendation.** Remove. Bulk `discard_datagrams` **keeps** its hop: that
is one injected task that then loops on the server runtime.

### Sites reviewed and not gated

| site | hop | reason |
|---|---|---|
| `discard_datagrams` / `discard_*_streams` | keep | one spawn, native loop; moving it pins the JS thread |
| `wait_draining` | keep | `conn.draining()` is a wtransport future; must run on the server runtime |
| `wait_*_capacity` | keep | timeout wait, not a hot path |
| `handle_*_probe` | keep | evidence harness; does real stream IO |
| client `wait_draining` | keep | same as server, on `CLIENT_RUNTIME` |

### Ship recommendation (remaining sites)

On the investigation branch, send and discard hops now default off (flags
retained so the A/B can be re-run). Stream hops stay on. The shippable
`fix/server-worker-threads` commit should delete the send and discard
wrappers the same way it deletes the read wrapper — **without** shipping
the measurement flags.

