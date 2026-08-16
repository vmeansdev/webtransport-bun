# Session handoff — H7 batching (halted) and QUIC parallelism (live)

Written 2026-08-16 because the session may end on usage limits. Everything
needed to resume without re-deriving anything is here. Two independent tracks:
H7 datagram batching, which is **finished and halted**, and QUIC server-side
parallelism, which is **root-caused with the fix measured** (see ACTION 2).

---

## 1. State of the world, in one table

| Track | Branch | HEAD | Pushed | Status |
|---|---|---|---|---|
| H7 batching | `feat/h7-batch-delivery` | `17be997` | no | HALTED at its own stop/go gate, 9 tasks complete and reviewed |
| QUIC parallelism | `investigate/quic-parallelism` | `28b570d` | **yes** (this HEAD not yet) | ROOT CAUSED; remaining spawn sites measured (Run J/K/L) |
| Mainline | `rebind4-staging` | `db9e7c6` | yes | GSO probe work only |
| Two-worker ship | `fix/server-worker-threads` | `6cfbe8d` | ? | two workers landed; hop removal still to add |

Worktrees:
- `webtransport-bun-worktrees/h7-batch-delivery` — do not touch, finished work.
- `webtransport-bun-worktrees/quic-parallelism` — active.

---

## 2. H7 batching — HALTED, do not resume without a new decision

**Verdict: batching datagram delivery across the N-API boundary gives 1.00x.**
Two independent probe runs measured 1.0021 and 0.9811 against a 2x requirement.

**Why, mechanically:** mean batch fill was 1.23-1.26. 814k-840k batch reads
delivered ~1.03M datagrams — a ~20% reduction in N-API calls, arithmetically
incapable of 2x. The precondition for a batch to fill is a backlog at the JS
reader, and there is none: the reader drains ~12.2M items/s against ~53k/s
arriving, a ~230x gap.

**The floor bench** (`.release-evidence/h7/datagram-delivery-floor.json` on the
H7 branch) records `status: "fail"` and was deliberately never tuned:
- gate 1, minimum rate >= 50,000 items/s: measured **11,948,198/s — PASS by 239x**
- gate 2, median >= 2.0x batch-1: measured **1.5356x — FAIL**
- arms: batch1 7,929,668/s; batch16 11,835,038 (1.49x); batch64 12,176,454
  (1.54x); batch256 12,314,782 (1.55x); **direct callback 153,800,683 (19.40x)**

**The 19.4x callback number is a red herring** and I said so after checking the
arithmetic: at the real arrival rate it would save 0.40% of one core, ~0.19% of
the server's 2.05-core load. It only matters if arrivals approach ~12.2M/s,
which is ~230x today. Do not scope it on throughput grounds.

**What shipped on `feat/h7-batch-delivery`** (21 commits, all reviewed clean,
one fix round each): native batch read on both handles (reject-free, silent
clamp 1..=256, dedicated sticky lifecycle wake); the five-part client teardown
with drain-and-refund accounting; TS routing with the `WEBTRANSPORT_DATAGRAM_BATCH`
knob, diagnostics and a version guard; the hosted-soak evidence contract
(duration corroboration, sample-density, throughput floor, churn falsifier with
27/27 clean retention trials); API + operator docs with a doc-truth gate that
rejects contradicting values; and a real Chromium proof (100/100 unique echoes
at batch=4). Suites: native 219, packages 644 pass/1 skip, security-evidence 69,
doc-truth 83.

**Tasks 8, 9 and 10 were never dispatched** (bandwidth ladder, napi-growth A/B,
2-hour hosted soak) — that is the ~5 hours the gate saved.

**Open decision for the maintainer:** keep the work as-is (correct, tested,
~5% CPU saving, knob defaults to 64, throughput flat), or revert it. Eight
deferred minor findings are listed in
`webtransport-bun-worktrees/h7-batch-delivery/.superpowers/sdd/2026-08-15-h7-batch-delivery-execution-plan/progress.md`
and would need triage in a final whole-branch review if kept.

---

## 3. QUIC parallelism — the live track

### 3.1 The defect, stated plainly

At the shipped default of `worker_threads(1)`, under sustained load the server
**ingests datagrams fine and then discards 80-95% of them**, delivering a fixed
~5,300/s, while leaving most of the machine idle. It is a **cliff, not a
ceiling**: delivered throughput *falls ~10x in response to a ~2x rise in offered
load*.

### 3.2 Evidence, both platforms

macOS M1 Max (10 cores), addon, 3 generators, 149.5k/s offered:

| workers | delivered/s | server cores | dgram threads |
|---|---|---|---|
| 1 | **5,373** | 1.30 | 1 |
| 2 | **89,002** | 3.29 | 2 |
| 4 | 81,682 | 3.27 | 4 |
| auto (10) | 48,042 | 3.10 | 10 |

Best/1 = **16.56x**. Per-round spread at workers=1 was 0.2% — stable, not noise.

Linux heavy runner (4 vCPU Ryzen 5 3550H), GH run **31943971720** at `fc280de`,
100 sessions, 2 generators, artifact downloaded not scraped:

| workers | offered/s | delivered/s | ingested/s | drop % | tokio | JS |
|---|---|---|---|---|---|---|
| 1 | 19,985 | **20,000** | 20,001 | **0.0** | 0.96 | 0.37 |
| 1 | 39,905 | **5,283** | 39,521 | **80.5** | 0.99 | 0.31 |
| 1 | 79,762 | 5,366 | 55,095 | 89.6 | 0.98 | 0.30 |
| 1 | 159,479 | 5,360 | 52,823 | 88.8 | 0.96 | 0.27 |
| 2 | 19,987 | 20,001 | 20,000 | 0.0 | 1.05 | 0.32 |
| 2 | 39,855 | **39,497** | 39,492 | **0.0** | 1.62 | 0.41 |
| 2 | 78,476 | 36,543 | 77,041 | 48.3 | 1.67 | 0.35 |
| 2 | 150,816 | 27,046 | 104,010 | 74.0 | 1.62 | 0.30 |

Knee for workers=1 on that host is **between 20k and 40k offered**. **No arm was
generator-limited** (`generatorLimitedRates` empty, offered tracked requested
within 0.7% to 160k, `testedTheCliff` true).

### 3.3 THE KEY CLUE — why this is not simply CPU starvation

**The collapsed floor is the same number on both platforms**: macOS 5,364-5,393/s,
Linux 5,250-5,367/s. Different ISA, different OS, 10 cores vs 4, and a receive
path that batches **32 datagrams per syscall on Linux versus 1 on macOS**
(quinn-udp `BATCH_SIZE`; macOS takes the `apple_slow` cfg because
`fast-apple-datapath` is not enabled — confirmed by feature resolution AND by
live `sample(1)` showing `recvmsg`, never `recvmsg_x`).

A 32x cheaper receive path did not move the floor at all. **Whatever services the
starved delivery future runs at a fixed rate independent of the platform
underneath it.** That points at a fixed-cadence wake — a timer, a poll interval,
a yield budget — not at CPU exhaustion. **This clue was correct and led straight
to the answer: tokio's `global_queue_interval`, one injected task per ~200us of
work. See ACTION 2, now solved.**

Supporting facts, identical on both platforms:
- The single worker is pinned at **0.96-0.99 cores** in every collapsed arm.
- The **JS thread idles** at 0.13 (macOS) / 0.27-0.37 (Linux) cores. It has never
  been the constraint at any load or worker count measured.
- The reject path is the **queued-bytes reservation**, not the rate limiter —
  `rateLimited` is 0 in all 16 runs.
- Ingest keeps working: at workers=1 the server took **102,993/s off the wire**
  on macOS while delivering 5,393/s.

### 3.4 Architecture facts established by code reading (all cited in feasibility.md)

- `worker_threads(1)` is **NOT load-bearing**. The `docs/ARCHITECTURE.md`
  rationale correctly argues against `Builder::new_current_thread()` (sync N-API
  entrypoints call `Runtime::spawn` with no permanently driven `block_on`) and
  contains **no argument for capping the multi-thread runtime at one worker**.
- quinn spawns **one endpoint driver task per `Endpoint`**
  (`quinn-0.11.11/src/endpoint.rs:364`, spawned at `:152-160`). Its `poll` takes
  `self.0.state.lock()` at `:370` and **holds it across both `drive_recv` (`:377`)
  and `handle_events` (`:378`)**. Serialised per UDP port regardless of worker
  count: the recv syscall, per-datagram header decode and CID routing,
  Initial-packet AEAD/handshake, retry/version-negotiation.
- **Parallelisable across workers**: for an established connection the endpoint
  driver only forwards into a per-connection unbounded mpsc
  (`endpoint.rs:813-820`) without taking the connection mutex; each `Connection`
  has its own `ConnectionDriver` (`connection.rs:65-73`) and own state mutex;
  1-RTT payload decryption, reassembly, ACK, loss detection, congestion control,
  pacing timers, and **transmit** (`connection.rs:1040`, per-connection socket
  handle) all run per-connection.
- Thread inventory for a server-only process: 1 tokio worker (`wt-server`),
  0 `wt-client` threads (`CLIENT_RUNTIME` is a never-forced `Lazy`), 0 blocking
  pool in use (no `spawn_blocking` anywhere in `crates/native/src/`), 0 watchdog
  threads (panic_guard and spawn_tracked spawn *tasks*), 1 Bun JS thread.
- **Rate-limiter contention** (`lib.rs:1351` → `rate_limit.rs:246-273`):
  `try_acquire_datagram_ingress` takes a mutex inside a DashMap entry keyed
  `(server_id, peer_ip)`. Loopback puts all sessions in one bucket. Measured
  119 ns/call at 1 worker, 296 at 2, **1,623 at 10 (13.6x)**, self-capping
  ingress ~620k/s at ten workers. Also: the key does **`peer_ip.to_string()` —
  a heap allocation per datagram on the hot path, unconditional, at every
  worker count**.

### 3.5 Methodological warnings — both cost real time, do not repeat them

1. **The first sweep measured the load generator, not the server.** A single
   load-client process pins at 65.1-65.4k/s (0.4% variance across runs). Every
   number in the first three runs was the generator's ceiling. It took 3 client
   processes to expose the real behaviour. **Always report offered/s per arm and
   flag arms where offered is pinned across configurations.**
2. **Prove the arms actually differ.** The H7 probe nearly halted the project on
   a number whose knob could not be shown to have taken effect. The QUIC probe
   therefore has two enforced proofs: `WEBTRANSPORT_SERVER_WORKER_THREADS`
   **aborts** on a bad value rather than defaulting to 1, and
   `crates/native/src/worker_probe.rs` counts datagrams per OS thread and
   **refuses** any multi-worker arm whose datagrams only ever landed on one
   thread.
3. **The supervisor's own hypothesis was wrong.** "150 sessions worse than 4,
   therefore per-connection multiplexing cost" did not survive a controlled
   session sweep — it was the generator. The real finding was delivery
   starvation. Check the framing you are handed.

### 3.6 What is on the branch

Commits: `358b867` instrumentation, `6369a22` per-thread CPU + limiter timing,
`5fff9c0` reject-path attribution, `7795bd2` native control, `d27f1b8` sharded
generators, `fc280de` Linux workflow wiring, `df798b4` Linux write-up.

New code: `crates/native/src/worker_probe.rs`; `WEBTRANSPORT_SERVER_WORKER_THREADS`
in `crates/native/src/lib.rs`; `tools/bench/worker-thread-parallelism-probe.ts`
and `.test.ts`; a `recv-floor-server` control binary with the delivery hop
deleted; a `worker_probe` input on `.github/workflows/bench-bandwidth.yml`.

Findings docs: `.investigation/feasibility.md` (16KB, every claim file-and-line
cited) and `.investigation/measurement.md` (20KB+, all runs incl. Linux Run H).
Artifacts: `thread-profile.json`, `worker-thread-parallelism-probe*.json`,
`native-recv-floor-control*.json`.

**Known gate breakage, deliberate and untouched:** `scripts/check-doc-truth.ts`
pins the exact string `Builder::new_multi_thread().worker_threads(1)` and now
reports 1 violation. `packages/webtransport/test/internal-doc-truth.test.ts`
still passes 15/15 because it checks prose, and the docs were not changed.

---

## 4. NEXT ACTIONS — what to do when resuming

### ACTION 1 — ship two workers as a near-term mitigation

Authorised by the maintainer on 2026-08-16. **Two workers is a MITIGATION, not
a fix** — it still degraded to 48% drops at 80k on the 4-vCPU host. Do not
present it as a cure.

Required, and all four sites must move together or the doc-truth gate fails:
1. `crates/native/src/lib.rs` — the server runtime constructor (~line 55).
   Consider whether `CLIENT_RUNTIME` (~line 72) should also change; the
   measurements only cover the server, so the conservative choice is server-only
   with a recorded reason.
2. `docs/ARCHITECTURE.md` — the threading-model prose, which currently states
   the one-worker contract and its rationale.
3. `scripts/check-doc-truth.ts` — the pinned constructor string.
4. `packages/webtransport/test/internal-doc-truth.test.ts` — its fixtures.

Do NOT weaken the doc-truth gate; update it to pin the NEW contract with the
same strictness. Add a regression test that fails if the worker count returns
to 1. Decide deliberately whether the count stays hardcoded or becomes
env-overridable with a default of 2 — the investigation branch has an
env-configurable implementation that aborts on bad input, which is the safer
shape, but shipping an env knob is a public-surface decision.

Evidence to cite in the commit: two platforms, twelve collapsed runs, identical
~5,300/s floor and identical reject path; 2 workers eliminated drops at every
rung where 1 collapsed; 2 beat 4 (81,682/s) and 10 (48,042/s) on macOS; nothing
justifies `available_parallelism()`.

### ACTION 2 — root-cause the fixed-cadence floor — ✅ SOLVED 2026-08-16

**FOUND. It is tokio's `global_queue_interval`.** Full write-up in
`measurement.md` under "Run I — ROOT CAUSE". Summary:

Every `readDatagram` goes `env.spawn_future` -> `RUNTIME.spawn`
(`session_napi.rs:157`). Spawning into the server runtime from the N-API runtime
is a spawn from *outside*, so the task lands in the **injection queue**. A
worker with 150 always-ready session tasks never runs dry, so it never hits the
bulk drain at `worker.rs:1533` and can only reach the injection queue via
`worker.rs:1077`, `tick % global_queue_interval == 0`, which takes **one** task
per check. Tokio tunes that interval to `200us / task_poll_time_ewma`
(`stats.rs:34,63`) — one delivery per ~200us of work, i.e. ~5,000/s, a scheduler
policy constant and therefore identical on both platforms.

FALSIFIER RUN (this is what establishes it): pinning the interval disables the
tuner, and the floor tracked it inversely with `delivered x interval` constant
at ~93,000 +/- 3% across a 64x span — gqi 2 -> 47,930/s (2% drops), 8 -> 11,678,
32 -> 2,836, 127 -> 726. Tuned floor implies an effective interval of ~18.

**SMALLEST CORRECT FIX, measured:** delete the `RUNTIME.spawn` wrapper in
`read_datagram`. It buys nothing — `read_datagram_for_session` only locks a
Tokio mutex and receives from an mpsc, with no timers, IO driver or
server-runtime context — so it runs correctly on the N-API runtime that
`spawn_future` already provides. At one worker under the collapse condition:
**5,266 -> 84,823/s delivered, 95% -> 0% dropped (16.1x)**. At two workers,
103,549 vs 101,272 on ~10% less CPU. Implemented on this branch behind
`WEBTRANSPORT_READ_DATAGRAM_VIA_SERVER_RUNTIME` (default = fixed path) so the
A/B can be re-run. Suite green: 451 pass / 0 fail, 188 Rust tests, clippy clean.

REVISED RECOMMENDATION: ship the hop removal AND two workers. Two workers alone
leaves the defect in place — it only makes workers run dry often enough to dodge
it, which a busier server or more sessions could undo.

REMAINING SPAWN SITES — measured 2026-08-16 (Run J/K/L, HEAD `28b570d`):

| site | verdict | evidence |
|---|---|---|
| `send_datagram` | **REMOVE hop** | echo: 5,213 → 55,306 send/s, 15% → 100% echo |
| `discard_datagram` | **REMOVE hop** | 5,374 → 83,479/s, 94.5% → 0% dropped; gqi product ~85k |
| stream open/accept | **KEEP hop** | 1,531 vs 1,532 acc/s; gqi 2→32 moved 1.4% |
| bulk `discard_datagrams` / waits / probes | **KEEP hop** | one spawn then a loop, or a wtransport future |

Investigation-branch defaults now match: send and discard hops off, stream
hops on. Flags retained for A/B. The shippable branch should delete the send
and discard wrappers with the read wrapper, **without** the measurement flags.

Full write-up: `measurement.md` "Run J / K / L".

### ACTION 3 — smaller follow-ups, independent of the above

- Remove the unconditional `peer_ip.to_string()` heap allocation per datagram in
  the rate-limiter key (`rate_limit.rs`).
- Consider sharding the limiter bucket; loopback is a worst case but the
  contention scaling (13.6x at ten workers) is real.
- The delivery crossing costs ~3.4x the CPU per datagram versus the no-addon
  control (115,557/s on 0.98 cores with the delivery hop deleted, versus
  89,002/s on 3.29 cores with it). **That gap is the real optimisation target**
  now that both batching and the JS drain are ruled out.
- Carry send + discard hop removal onto `fix/server-worker-threads` (no
  measurement flags), next to the read-hop commit already in flight.

---

## 5. Where the durable records live

- This file.
- `.investigation/feasibility.md` and `.investigation/measurement.md` on this branch.
- H7's ledger with all 16 supervisor rulings:
  `webtransport-bun-worktrees/h7-batch-delivery/.superpowers/sdd/2026-08-15-h7-batch-delivery-execution-plan/progress.md`
- Session memory:
  `~/.claude/projects/-Users-vmeansdev-Developer-Codex-Apps-webtransport-bun/memory/`
  — `project_parallelism-analysis.md` (this track) and
  `project_h7-batch-delivery-plan.md` (the batching track).
