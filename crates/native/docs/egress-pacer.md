# Architect note — the smooth egress pacer (prototype)

Branch `feat/egress-pacer-01`. Knob-gated, default off, unmerged. This note is
the design the prototype implements; the maintainer brainstorm happens against
it and against the measured numbers, not before them (declared deviation from
ticket 05's brainstorm-first rule — overnight execution ruling).

## The measured problem

Three facts from the map's Notes, none of them speculative:

1. The fan-out path sheds above roughly 100 k pps *instantaneous* with near-zero
   buffering. It is not an average-rate limit — the path has no queue to absorb
   a train.
2. Smooth 75 k pps is lossless on the same path.
3. Crude userspace pacing moved loss 21 % → 5.2 %, and the residual was the
   prober's own micro-bursts, i.e. the remaining loss was *scheduling jitter*,
   not capacity.

So the lever is shape, not rate. A fan-out of 10 000 targets emitted as one
tight loop is a ~10 000-packet train handed to the kernel in a few hundred
microseconds; the same 10 000 packets spread at 75 k pps is 133 ms of smooth
egress that the path takes whole.

## Where it sits

`Server::sendDatagramMirror` (`server_napi.rs`) → `send_datagram_mirror_for_owner`
(`session.rs`) → `datagram_mirror::fan_out` → `try_send_datagram_on_state` per
target. That inner loop *is* the burst: it is synchronous, promise-free, and by
design has nothing between one target and the next.

The pacer therefore sits exactly one level up, at
`send_datagram_mirror_for_owner`: when the knob is on, that function hands the
payload and the target list to a native pacer instead of running the loop
inline. Everything below it — session resolution, byte reservation, the quinn
call, both counters — is unchanged and shared, which is the property
`try_send_datagram_on_state` was factored out to preserve. The pacer never
reimplements a send.

Knob off, `send_datagram_mirror_for_owner` is what it is today plus one load of
a `OnceLock<Option<PacerConfig>>` and a branch. No allocation, no lock, no
thread, the same `fan_out` call with the same closure.

## The schedule (EDT)

One schedule per **process**, not per call and not per server. The rate is a
property of the path, and two servers in one process share one NIC: a per-server
schedule would let each of them emit at the configured rate and put twice the
budget on the wire, which is the failure the knob exists to prevent. The job
carries its `owner_server_id` so target resolution stays owner-scoped exactly as
the inline path resolves it.

Research (`research/linux-tuning.md`)
is unambiguous that the industry shape is earliest-departure-time: every burst
unit gets one departure timestamp, and burst units are never merged into a train.

- `interval = clump / pps`.
- A cursor holds the next departure time. Each clump takes the cursor as its
  txtime and advances it by `interval`.
- The cursor is **continuous across calls**. This is the point of one shared
  schedule: a 5 Hz broadcast to 10 000 targets at 75 k pps occupies 133 ms of
  every 200 ms window, and two submissions that overlap must interleave on one
  schedule rather than each start a fresh burst. Per-call schedules would
  reintroduce exactly the train the pacer exists to remove.
- Lateness is clamped, and the clamp is measured in **clumps, not wall time**.
  If the cursor has fallen more than `CATCHUP_CLUMPS` (2) intervals behind `now`
  — descheduled, or simply idle — it resets to `now` and `scheduleResets`
  records it.

  This detail is worth stating plainly because the first version of this design
  got it wrong, and the microbench caught it. A wall-time horizon of 200 ms
  sounds conservative and is not: at the target shape it lets a descheduled
  pacer settle its debt as ~468 back-to-back clumps — 15 000 packets with no
  spacing between them, which is the exact train the pacer exists to remove,
  arriving under the name of catch-up. The first microbench run on this branch
  showed p1 inter-clump spacing of 292 ns after a 13 ms stall.

  With the clump-counted clamp the worst observed burst is three tight clumps —
  the two allowed of debt, plus the restart departure itself, which has to land
  somewhere and lands at `now` — so 96 packets rather than 15 000. The trade is
  deliberate: a stalled pacer *loses* the packets it did not send rather than
  bursting them. For a pacer the rate is a ceiling, not a quota.

`PacerCore::next_txtime` is that whole rule, pure and napi-free, so it is unit
testable without a thread or a socket.

## Interplay with quinn's GSO

quinn coalesces whatever is queued at poll time into a GSO super-buffer of up to
64 segments. The pacer does not try to control GSO directly and must not: the
lever it has is *how many datagrams are queued at once*, which is precisely what
GSO batches over.

So one clump is one burst unit. Hand quinn `clump` datagrams and then stop until
the next txtime; quinn coalesces at most that clump into one super-buffer and
issues one `sendmsg`. That gives the property the research names — **one txtime
per super-buffer, never merged trains** — without touching quinn.

Hence `clump` defaults to 32 and is clamped to `1..=64`: above 64 a clump spans
more than one GSO train and the pacer would be pacing something other than the
burst unit; the default sits below the ceiling so that a clump is one train even
when quinn splits on a path-MTU boundary. `clump` is exactly the knob the
burst-probe counters measure the path's tolerance of (ticket question (b)), which
is why it is a knob and not a constant.

At the target shape: 75 000 pps ÷ 32 = 2 344 clumps/s, one every 427 µs.

## Threading

The schedule runs native-side, on a dedicated OS thread. Three things are ruled
out and it is worth saying why:

- **Not the JS thread.** `sendDatagramMirror` is synchronous; sleeping in it
  would stall the emitter for the whole 133 ms fan-out, which is the failure the
  10 000-target cap was sized against (1 ms budget, ~20 % of G2's p99 ≤ 5 ms).
- **Not a tokio timer on a runtime worker.** A pacer that wakes every 427 µs and
  spins the last 150 µs would sit on a runtime worker that also drives accept
  loops and per-session tasks. Its jitter would become their jitter, and theirs
  would become the pacer's — and the residual 5 % loss in the measurement was
  jitter.
- **Not one thread per call.** The schedule is process-wide and must be
  continuous; a thread per call is a schedule per call.

The thread is spawned lazily on the first paced submission and exits after
`IDLE_EXIT` (5 s) with an empty queue, so a knob-on server that never broadcasts
does not hold a thread, and a soak does not accumulate them. Submission is a
mutex + `VecDeque` push + condvar notify: the JS thread's per-call cost is one
lock, one `Arc<Vec<u8>>` clone and one `Vec<String>` move, independent of `N`.

The idle exit clears `thread_running` inside the same critical section that saw
the queue empty, which is what keeps a respawn from racing a still-running
thread — two schedules on one queue is two cursors, and two cursors is twice the
configured rate. Every *other* way out of the thread (a panic in a send, a
poisoned lock) is caught by an `ExitGuard` that clears the flag on unwind;
without it a dead thread leaves the flag set, no submission ever respawns one,
and the queue wedges with every subsequent target refused. `threadStarts` counts
the spawns, so a window with more than one is visible in the artifact rather
than inferred from a rate that quietly halved.

Sleeping to a 427 µs cadence: `thread::sleep` to within 150 µs of the txtime,
then `spin_loop` to it. Sleep granularity alone is ~50–100 µs on both platforms
and would show up directly as inter-clump jitter; a bounded spin costs at most
150 µs of one core per 427 µs tick in the worst case and typically far less.

## Backpressure and memory

The queue is bounded in *targets*, at `pps × queue_ms / 1000` (default 18 750
targets at 75 k, floored at one clump). Targets past the bound are refused at
admission with `E_WOULD_BLOCK` in the envelope, which is the code the caller
already handles for a target with no budget. Unbounded queueing would trade
packet loss for latency and RSS, silently, which is a worse failure than the one
being fixed.

**`queue_ms` is milliseconds at the *configured* rate, not a latency bound.** The
conversion above uses `pps`, so a full queue is `queue_ms` of wall time only
while the pacer achieves `pps`; at half the achieved rate the same 18 750 targets
are 500 ms of work. Real queue latency is `pendingTargets ÷ achieved pps`, and
the achieved rate is only readable from the windowed stats
(`window.clumps × clump ÷ window seconds`) — which is why no paced number is
interpretable without them.

The bound cannot be turned into a real latency bound without timestamping each
admission, which would put a clock read on the JS thread's per-target path to
bound something the drain already bounds.

What that means for reading a run: **zero `E_WOULD_BLOCK` from a paced mirror is
evidence the queue stayed below its bound, so it also caps how long any target
can have sat there.** A spread far above `queue_ms` with zero refusals is not a
contradiction and not a leak in the bound — it says the delay is downstream of
admission (the drain's own duration, the socket, the path, or the receiver). The
arithmetic is pinned in
`a_broadcast_that_is_never_refused_cannot_have_waited_the_bound_in_the_queue`:
holding a target for ~2 s inside this queue requires a drain near 9.4 k pps,
which at a 50 k/s offered rate refuses millions of targets.

The bound is released **clump by clump** as the drain progresses, not when a job
finishes. A 10 000-target job that has already sent 9 000 is 1 000 targets of
outstanding work; charging the full job until it completed would make a 250 ms
bound behave like a much smaller one at exactly the fan-out sizes this is for.

## The envelope — settled

This was left open for the brainstorm. It is now decided, and the decision is
candidate 3 below, given a concrete shape: **the pacer is not a mode of
`sendDatagramMirror`, it is a different method.**

The problem, restated. `sendDatagramMirror`'s `sent` means *queued to quinn*,
and `failed` names every target that did not take the payload, synchronously.
A paced call returns before most sends happen, so the same field could only mean
*admitted to the schedule* — a different quantity wearing a name the caller has
already been taught to read as delivery. Seven of the fifteen mirror tests
failed on the knob for exactly that reason, and one of the seven passed or
failed depending on the configured rate.

So `submit` is no longer reachable from `send_datagram_mirror_for_owner`; the
branch that used to steer it is deleted, and the mirror is byte-identical with
the pacer compiled in. The schedule is reached through
`send_datagram_mirror_paced_for_owner` / `sendDatagramMirrorPaced`, whose
envelope is `{ admitted, refused }` and carries no delivery count at all.
Per-target failures are drained out of band through `readMirrorReports(max)`
from a fixed 4,096-entry ring — bounded by construction, oldest dropped,
`mirrorReportsDropped` counting every drop, and `drained + dropped ==
deferredFailures` available as a falsifier for the reporting path itself.

The two rejected answers, for the record: fire-and-forget with counters only
discards the reap list, which is the actionable half of the mirror design; a
completion promise per broadcast reintroduces the ThreadsafeFunction — a host
event-loop reference — that the promise-free path exists to avoid.

Admission also became per-index (`admit_per_index`) rather than a
`targets[..admitted]` slice, so the paced envelope is a set and not a prefix,
matching design M4. Ticket 07's per-workload profiles remains the natural home
for *choosing* pacing per workload; what is settled here is the contract that
comes with it.

## Knobs

Read once, at first use, and never re-read. Default off.

| Env var | Default | Meaning |
| --- | --- | --- |
| `WEBTRANSPORT_PACER_PPS` | unset/`0` = **off** | Target packet rate for the schedule. |
| `WEBTRANSPORT_PACER_CLUMP` | `32` | Datagrams per burst unit, clamped `1..=64`. |
| `WEBTRANSPORT_PACER_QUEUE_MS` | `250` | Admission bound, in milliseconds **at the configured rate**. |
| `WEBTRANSPORT_PACER_NICE` | unset | Nice level for the pacer thread, clamped `-20..=19`. Linux only. |
| `WEBTRANSPORT_PACER_SCHED` | unset | `rr:<prio>` for `SCHED_RR` at that priority, clamped `1..=99`. Linux only. |

An unparseable or out-of-range value is clamped or treated as off — never an
error. This matches every existing knob in the crate and matters more than usual
here, because the knob is read on a path that must not throw. The two priority
knobs are the exception to "clamped": a value neither form can be read from sets
`priority.knobMalformed` rather than falling back to unset, because a sweep cell
that silently ran unprioritised would still be labelled a priority cell.

Both priority knobs are applied **at every pacer-thread spawn**, not once per
process: the thread idle-exits after 5 s and respawns at the runtime's default
priority. They are Linux-only by design — `setpriority(PRIO_PROCESS, 0, …)` is
per-thread on Linux but process-wide on macOS, where honouring the knob would
renice the whole runtime under a name that says "pacer thread". Off Linux the
request is disclosed and `priority.achieved.policy` reads `"unsupported"`.

`SCHED_RR` is asked for **before** the nice level, deliberately: an `RR` call
denied for want of `CAP_SYS_NICE` still leaves the nice request to be attempted,
so the cell degrades to a nice-level cell and discloses itself as one rather than
running unprioritised. Note the corollary when both knobs are set and `RR`
succeeds — nice only steers `SCHED_OTHER`, so the nice level is set but inert,
and `priority.achieved` will truthfully report both.

Both unset — the default — no syscall is made and the thread runs exactly as it
did before the knobs existed.

### Stats

`Server.__pacerStatsSnapshot()` opens a window: it records every counter and
returns a token (`0` when the pacer is off). `Server.__pacerStatsJson(token?)`
returns the counters as a JSON string, `"{}"` when off. Both are named with the
double underscore because they are diagnostic and unstable — the prototype
commits to no schema, and a string rather than a typed snapshot is the same
choice for the same reason.

With a token the result carries `window` — the deltas over that window — beside
the raw `cumulative` values; without one, `window` is `null`, so "no window" is
distinguishable from "a window in which nothing happened". A token is not
consumed by reading, and is released by eviction once 64 newer marks exist.

Two lateness fields, deliberately not one:
`cumulative.maxLatenessUsSinceProcessStart` is exactly what its name says and
must not be read as a property of any window; `window.maxLatenessUsSinceSnapshot`
is measured from the most recent `__pacerStatsSnapshot()` call — a maximum is not
invertible, so unlike every other counter it cannot be derived from two
cumulative reads and needs its own register.

`priority.achieved` is read back from `sched_getscheduler`/`getpriority` after
the calls, never inferred from them, so a `setpriority` that failed for want of
`CAP_SYS_NICE` discloses the level the thread is really running at with an errno
beside it. It is `null` until a pacer thread has started.

The counters are **process-global**: the pacer is one schedule per process, not
one per server, so a second `Server` in the same process reads the same numbers.

## What the prototype answers

- (a) *Can the native layer sustain smooth ~75 k pps without eating the JS thread
  or a core?* — measured by the microbench: JS-thread cost is submission only,
  and the pacer thread's duty cycle is reported.
- (b) *What clump size does the path tolerate?* — `clump` is a knob; the cable
  validation reads it against the burst-probe counters.
- (c) *What does the API surface look like?* — stated above as an open question
  with three candidates, for the brainstorm.
