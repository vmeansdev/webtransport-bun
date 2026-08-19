# Pre-registration — Axis: stream throughput

**Written before any harness code.** Committed as its own commit so the
orchestrator can diff it against the final state. Post-hoc edits to this file are
findings against the author.

- **Axis:** stream-throughput
- **Base:** `rebind4-staging` @ `5ad0245`
- **Probe branch:** `probe/stream-throughput-01` (never-merge)
- **Runner:** `[self-hosted, Linux, X64, heavy]`, 4 vCPU / 8 GB, on-box loopback.
  No runner config changes. On-box loopback is chosen deliberately: the closed
  ladder established that the Hyper-V vswitch drops heavily and invisibly under
  load, so for a *bulk byte* measurement loopback is the better surface.
- **Workflow:** `.github/workflows/bench-bandwidth.yml`, extended with a
  `mode` input (`bandwidth` | `stream`). No new workflow file — a dispatch-only
  workflow is unregisterable from a non-default branch.

## What is settled and is not re-derived here

`docs/research/2026-08-18-bandwidth-ceiling-attribution.md`: ~103k datagrams/s
delivered is this host's honest ceiling and it is **not** a server-side limit.
That is a *packet-rate* ceiling expressed in bytes; it is explicitly not a
bytes/s ceiling and this work does not treat it as one.

Falsified levers, not re-proposed and not built around: coresplit / taskset
pinning, raising `rmem`, BBR. 160k is not chased.

## Direction and scope

All three arms measure **ingress**: client writes, server (Bun + N-API addon)
reads. That is where the JS-boundary copy lives and where the headline
"bytes/s through the N-API boundary" number lives. Server→client stream egress
is a different axis and is out of scope here (see "Deferred" at the bottom).

## Arm A — bulk bytes/s vs write size

Fixed: 4 sessions x 4 concurrent unidirectional streams (16 in flight), opened
once at step start and finished at step end. Zero stream churn by construction —
churn is Arm B's job. Unpaced: each stream writes as fast as flow control allows.

Ladder over client write size `W`, 60 s per step:

| step | W bytes | server limits |
|---|---|---|
| A1 | 4,096 | default |
| A2 | 16,384 | default |
| A3 | 65,536 | default |
| A4 | 262,144 | default |
| A5 | 1,048,576 | default |
| A6 | 262,144 | **control**: `maxQueuedBytesPerStream` 16 MiB, `maxQueuedBytesPerSession` 64 MiB |

A6 is a falsifier, not a step of the ladder. `crates/native/src/transport_memory.rs`
derives the QUIC `stream_receive_window` from `maxQueuedBytesPerStream` (default
256 KiB) and `receive_window` from `maxQueuedBytesPerSession` (default 2 MiB). On
loopback the BDP is far below both, so the pre-registered **prediction is that A6
matches A4 within 10%**. If A6 beats A4 by more than 10%, the shipped default
flow-control window is the binding constraint for bulk transfer and every other
number in this arm is a window measurement, not a boundary measurement.

Recorded per step: client bytes written / accepted, server bytes received at the
JS boundary, JS chunk count and mean JS chunk size, elapsed, host CPU
(median/max), server-process CPU, **client-process CPU** (`/proc/<pid>/stat`,
percent of one core), server RSS, `/proc/net/snmp` UDP deltas, client quinn
`udp_tx`/`udp_rx` `{datagrams, bytes, ios}`.

## Arm B — stream open/close rate ceiling

Fixed: 4 sessions. Each operation is: open uni stream, write 64 bytes, finish.
Server accepts, drains to EOF, counts. Unpaced. 30 s per step.

Ladder over in-flight streams per session `C`: **1, 4, 16, 64, 256**.

Server must not be the limiter by configuration: `rateLimits.streamsPerSec` and
`streamsBurst` set to 10,000,000; `limits.maxStreamsPerSessionUni` 4,096;
`maxStreamsGlobal` 200,000. If the limiter engages anyway the step is invalid
(see classifier), because then we measured the limiter.

Recorded per step: server-counted completed streams, client-counted opens,
elapsed, all CPU series as in Arm A, and `server.metricsSnapshot()` deltas for
`rateLimitedCount` and `limitExceededCount`.

## Arm C — datagrams vs streams at matched offered bytes/s

Two sub-arms, 8 sessions, 60 s each, both **paced to an offered 600 Mbps
aggregate**. 600 Mbps is chosen to sit safely below the settled ~950 Mbps
datagram packet-rate ceiling so neither arm is running into the closed ladder's
wall; it is not a bar to clear.

- **C-dgram:** 1,150 B datagrams, 8,153 datagrams/s/session (65,224/s aggregate).
  `rateLimits.datagramsPerSec` set to 4x that so the limiter is not the subject.
- **C-stream:** 1 long-lived uni stream per session, 65,536 B writes,
  9.375 MB/s/session.

The comparison metric is not throughput (both are pinned to the same offered
rate). It is cost per delivered bit:

- `wirePacketsPerGbit` = `/proc/net/snmp` `InDatagrams` delta / delivered Gbit.
  This is the number that turns "streams change the pps math in your favor" into
  a measurement.
- `serverCpuPctPerGbps`, `hostCpuPctMedian`.
- `boundaryEventsPerSec` — JS callbacks/s (datagram deliveries vs stream chunks).
  This is the N-API crossing rate.

## GSO on the stream send path — how the run output answers it

Unknown #3 is answered mechanically, not by assumption. The load client reports
per-connection quinn stats (`Connection::quic_connection().stats()`, available
because the workspace enables wtransport's `quinn` feature), summed across
sessions and printed in the client summary:

```
udpTx{datagrams,bytes,ios}  udpRx{datagrams,bytes,ios}
```

`ios` is the count of send/recv syscalls; `datagrams` is the count of UDP
datagrams. quinn's own doc on the field: *"Can be less than `datagrams` when GSO,
GRO, and/or batched system calls are in use."*

The harness derives and emits per step:

- `gsoSegmentsPerIo = udpTxDatagrams / udpTxIos`
- `groSegmentsPerIo = udpRxDatagrams / udpRxIos`

Verdict rule, pre-registered:

| condition | verdict emitted |
|---|---|
| `udpTxIos == 0` | `gso: unknown` |
| `gsoSegmentsPerIo > 1.05` | `gso: ENGAGED` (value reported) |
| `gsoSegmentsPerIo <= 1.05` | `gso: NOT-ENGAGED` (silent fallback to one packet per sendmsg) |

Same rule for GRO on `groSegmentsPerIo`. These are the **client/sender** side —
the sender in every arm here is the client. The `gso-probe` binary continues to
report host *capability* (`max_gso_segments`); this reports actual *engagement*.
Capability without engagement is exactly the silent-fallback case, and the two
numbers appearing side by side in one run is the point.

## Classifier buckets

Applied mechanically by the harness to each step and printed with the step. All
CPU percentages are percent-of-one-core (4 vCPU => 400 is full box).

Definitions: `clientCpuPct` from `/proc/<child pid>/stat` utime+stime over the
step; `serverCpuPct` from `process.cpuUsage()` of the bench process (which is the
server); `hostCpuPctMedian` from `/proc/stat`, 0-100 host-wide.

**Precedence — first matching rule wins.**

| # | bucket | rule | run status |
|---|---|---|---|
| 1 | `session-failure` | `sessionsOk < sessions` or `streamErr > 0` | INCOMPLETE |
| 2 | `limiter-engaged` | `rateLimitedCount` or `limitExceededCount` delta > 0 | INCOMPLETE |
| 3 | `drain-incomplete` | `residualBytes > 0.05 * clientBytesWritten` at step end (streams are reliable; a large residual means the step ended mid-flight) | INCOMPLETE |
| 4 | `host-saturated` | `hostCpuPctMedian >= 90` | INCOMPLETE |
| 5 | `generator-saturated` | `clientCpuPct >= 150` and `clientCpuPct >= 1.5 * serverCpuPct` | INCOMPLETE |
| 6 | `server-boundary-bound` | `serverCpuPct >= 90` and `serverCpuPct >= clientCpuPct` | capacity number |
| 7 | `flow-control-bound` | `|delivered - prevDelivered| < 0.05 * prevDelivered` and `hostCpuPctMedian < 70` and `serverCpuPct < 70` and `clientCpuPct < 100` | capacity number, window-limited |
| 8 | `scaling` | `delivered >= 1.10 * prevDelivered` | capacity number, ceiling not yet reached |
| 9 | `plateau` | otherwise | capacity number |

Arm B reuses rules 1-5 verbatim, then:

| # | bucket | rule |
|---|---|---|
| B6 | `concurrency-scaling` | `streamsPerSec >= 1.10 * prev` |
| B7 | `churn-ceiling` | otherwise |

Arm C adds, before comparison:

| # | bucket | rule | status |
|---|---|---|---|
| C1 | `offer-shortfall` | client offered bytes < 0.95 * target for either sub-arm | INCOMPLETE — the arms are not matched, no comparison |
| C2 | `dgram-lossy` | datagram sub-arm delivery ratio < 0.98 | comparison proceeds but is stated at *delivered* bytes/s with the loss disclosed |
| C3 | `matched` | otherwise | comparison valid |

## STOP conditions

A STOP means the run yields **no capacity number** for that arm; it does not mean
the run is retried with different knobs until it produces one.

1. **Generator saturation** (bucket 5) at the step producing the arm's maximum
   delivered bytes/s. The arm's ceiling is then a *lower bound on the server*,
   reported as such, and the honest next step is an off-box generator — which the
   closed ladder already showed costs more than it buys on this vswitch.
2. **Host saturation** (bucket 4) at the maximum-delivering step. Same treatment:
   lower bound only, co-residence disclosed.
3. **Limiter engaged** (bucket 2) anywhere: that step measured configuration, is
   discarded, and the harness config is a defect to be fixed before re-running —
   not a result to be reported.
4. **A6 control fails** (A6 > A4 by more than 10%): Arm A's numbers are
   flow-control-window measurements. Report them as such; do not relabel them as
   boundary numbers.
5. **`gsoSegmentsPerIo` uncomputable** (`ios == 0`): the GSO question is answered
   `unknown`. It is never answered `NOT-ENGAGED` by absence of data.
6. **Arm C offer shortfall** (C1): no datagram-vs-stream claim is made.

## Rules this run holds itself to

- There is no threshold to clear. Every arm reports a number and its bucket. A
  merge bar is not a physics result, and no knob is turned to move a number
  across a line.
- Local macOS smoke validates that the harness runs and that its output parses
  into these buckets. Local numbers are never quoted as results.
- Measure first, optimize never: any lever this surfaces is recorded, not built.

## Amendment 1 — 2026-08-18, before any dispatch

Written after a ledger review of the harness against this document and **before
the first run of any arm** (no run id exists for this axis at the time of
writing; the run log below is empty). Recorded here rather than by editing the
tables above, so the diff against the original registration stays legible.

**Rate limits.** The harness ran `streamsBurst` at 20,000,000 against the
10,000,000 registered above. Code aligned to this document; the registered value
stands.

**Classifier — harness-integrity rules added ahead of rules 4-5.** These do not
relabel any capacity number; each one moves a step to INCOMPLETE that the
original table would have scored as a measurement it is not:

| bucket | rule | why |
|---|---|---|
| `server-stream-errors` | `serverStreamErrors > 0` | Rule 1 asks whether every stream in the step completed. Server-side reader errors answer that question too, and the original harness excluded them as shutdown artifacts — an exclusion that lets a step lose bytes and still be a capacity number. |
| `counter-contamination` | `serverBytes - clientBytesWritten > 0.05 * clientBytesWritten` | The other side of `drain-incomplete`. Server counters exceeding what the client wrote means a previous step's tail landed inside this step's delta. |
| `drain-unsettled` | server counters still moving when the post-child settle budget (15 s) expires | The step's own tail never landed, so neither this delta nor the next one is clean. |
| `instrumentation-missing` | `hostCpuPctMedian === null` or `clientCpuPct === null` | Rules 4 and 5 are checks; a check that could not run is not a pass. Without `clientCpuPct` the generator-saturation STOP cannot be evaluated, and an unevaluable step may not be the step that sets the ceiling. This is also what makes every local macOS run INCOMPLETE by construction, which is the intended outcome. |
| `sub-arm-incomplete` (Arm C, before C1) | either sub-arm INCOMPLETE | A comparison is at most as sound as its weaker side. |

**Cross-step counter hygiene.** Each step now waits for the server counters to
go quiet after the client exits (250 ms polls, 4 consecutive quiet polls, 15 s
budget) before its closing snapshot is taken. Without it a step's in-flight tail
was charged to the following step's delta, so the ladder's shape partly recorded
when each client happened to exit. `settleSec` and `settleTimedOut` are reported
per step.

**Denominators.** Fixed and stated in the artifact under `notes.denominators`:

- delivered/offered rates, `streamsPerSec`, `boundaryEventsPerSec` — `windowSec`
  (the configured drive window), as registered;
- `serverCpuPct` and `clientCpuPct` — percent of one core over `driveSec`
  (spawn → child exit), the one interval both processes share, so the classifier
  rules that compare them compare like with like;
- cost per delivered bit — **CPU-ms per delivered Gbit**, which carries no time
  denominator at all. This replaces Arm C's `serverCpuPctPerGbps`, which divided
  a `driveSec` rate by a `windowSec` rate and so scaled the answer by the ratio
  of the two.

**A6 and the lower-bound flag.** STOP condition 4 now moves
`verdicts.bulkCeilingIsLowerBoundOnly`, alongside STOP conditions 1 and 2: a
`WINDOW-BOUND` control means Arm A measured the flow-control window, so its
ceiling bounds the boundary from below. `verdicts.bulkCeilingLowerBoundReasons`
names which conditions fired.

**`wirePacketsPerGbit` renamed `snmpUdpInDatagramsPerGbit`.** The name asserted a
wire-packet count the counter does not provide: `/proc/net/snmp` `Udp.InDatagrams`
counts socket-layer datagrams, each one a coalesced super-packet under GRO, and
the file is host-wide so on this on-box rig it sums the server's and the
co-resident client's receives. Neither is invertible from this counter, so the
figure is reported as what it is, beside the `gso`/`gro` verdicts, and no
wire-packet estimate is derived from it. Counting real wire packets is deferred
with the rest of the list below.

## Amendment 2 — 2026-08-19, before any dispatch (Arm W: window sweep)

Deferred item 3 below — "flow-control window sweep beyond the single A6
falsifier" — is promoted into this axis as **Arm W**, per ticket 08 of the
production-grade-scenarios effort. Written before the first run of any arm of
this axis (the run log above is still empty), and committed ahead of the harness
code that implements it. Arms A, B and C are unchanged; A6 keeps its role.

Arm W **decides nothing**. It supplies delivered Gbps and a memory pair per rung.
The decouple-vs-raise-budgets decision belongs to ticket 09.

### Design

Fixed, so the only variable is the window: 4 sessions × 4 concurrent
unidirectional streams (16 in flight), client write size **262,144 B** — the same
point as steps A4 and A6, so a sweep rung is directly comparable to both.
Unpaced, 60 s per rung. One **fresh server per rung**, since the windows are
server configuration.

Ladder over `maxQueuedBytesPerStream`, log-spaced from the shipped default to the
A6 config, with `maxQueuedBytesPerSession` held at the **shipped 8× ratio**
(2 MiB : 256 KiB) so the sweep moves one parameter and not two:

| rung | per-stream | per-session |
|---|---|---|
| W1 | 256 KiB (**shipped default**) | 2 MiB (default) |
| W2 | 512 KiB | 4 MiB |
| W3 | 1 MiB | 8 MiB |
| W4 | 2 MiB | 16 MiB |
| W5 | 4 MiB | 32 MiB |
| W6 | 8 MiB | 64 MiB |
| W7 | 16 MiB | 128 MiB |
| W-a6 | 16 MiB | **64 MiB** (A6's ratio, 4×) |
| W-repeat | 256 KiB | 2 MiB (replay of W1) |

`W-a6` is a tie-in, not a rung of the sweep: it is exactly Arm A's control
config, so the sweep and the A6 falsifier sit on one axis instead of being two
configurations that cannot be compared. `W-repeat` is the retention falsifier
described below. Rungs run strictly ascending, then `W-a6`, then `W-repeat`.

### The two memory numbers, and why they are never merged

Spec §Windows math asks for "peak committed memory" per rung. That is reported as
a **pair**, because the two available numbers mean different things and averaging
or substituting them would be a claim the data does not support.

**(i) Advertised worst case (derived).** What a peer is licensed to make the
server buffer. Mirrored from `crates/native/src/transport_memory.rs`:

```
stream_receive_window = clamp(max(perStream,  maxDatagramSize), 1, 2^62-1)
receive_window = send_window = clamp(max(perSession, stream_receive_window), …)
datagramChannel = clamp(ceil(perSession / maxDatagramSize), 1, 2048)
perSessionWorstCase = receive_window + send_window + datagramChannel × maxDatagramSize
```

Reported per rung as `perSessionWorstCase`, `atArmSessions` (×4) and
`atMaxSessions` (×`maxSessions` = 2000) against the rig's 8 GB, plus whether it
stays inside the shipped 2 MiB / 512 MiB budgets. `maxQueuedBytesGlobal` does not
bound this. The harness asserts its mirror against `transport_memory.rs`'s own
unit-test values at the defaults (256 KiB / 2 MiB / 2 MiB, channel 1748) and
**aborts the run** if they disagree — a drifted mirror produces a memory column
that describes code that is not running.

**(ii) Observed resident (measured).** `rssMbBaseline` sampled after the previous
rung's server is closed, `releaseNativeMemory()` is called and the process has
quiesced; `rssMbPeak` over the rung; `rssMbDelta` between them. RSS is resident,
not committed, and it is charged to the whole Bun process including the harness.

Three honesty rules on the observed number, pre-registered:

- Advertisement is not allocation. (i) is an exposure ceiling; (ii) is what the
  rung actually touched. A rung may show (ii) ≪ (i) and that is the expected
  result on loopback, not a defect.
- All rungs share one Bun process and the allocator retains freed arenas, so a
  later rung can be served from an earlier rung's retained memory and show a
  falsely small delta. Hence ascending order — each rung is the largest so far —
  and hence `W-repeat`. **Verdict `memoryRetention`**: `CLEAN` if `W-repeat`'s
  peak RSS is within 20% of `W1`'s peak; otherwise `CONTAMINATED`, and then no
  per-rung delta is quoted (see W-STOP-B).
- RSS also tracks delivered throughput, since bytes in flight cross into JS. A
  rung's RSS is therefore not attributable to its windows alone. Disclosed in the
  artifact, not corrected for.

### Classifier

`commonBucket` rules 1–5 and every Amendment 1 integrity rule apply verbatim and
first. Then:

| # | bucket | rule | status |
|---|---|---|---|
| W6 | `window-scaling` | `delivered >= 1.10 * prev` | capacity number, knee not yet reached |
| W7 | `window-plateau` | otherwise | capacity number |

`W-a6` and `W-repeat` are classified but excluded from the ladder comparison
(they are not ascending rungs); `W2` compares against `W1` and so on.

### Knee, fixed before the run

**knee = the smallest complete rung whose delivered bytes/s is ≥ 0.95 × the
maximum delivered across all complete rungs.** Reported with both memory numbers
at that rung.

If the top rung (`W7`) is itself `window-scaling`, **no knee is reported**: the
sweep did not bracket it and the honest output is the open statement "knee is at
or above 16 MiB". The top rung is never named the knee by default.

### STOP conditions

Original STOP conditions 1 (generator saturation), 2 (host saturation), 3
(limiter engaged) and 5 (GSO uncomputable) apply verbatim. Two additions:

- **W-STOP-A:** fewer than 3 complete rungs → no knee and no memory curve. The
  arm reports the rungs it has and nothing derived from their shape.
- **W-STOP-B:** `memoryRetention: CONTAMINATED` → no per-rung RSS delta is
  quoted. The memory statement is made on the derived worst case plus the
  absolute peak series only. This is not a rerun trigger; it is a narrower claim.

## Amendment 3 — 2026-08-19, pointer only (Arm G: gate G5)

This axis' harness gains a fourth arm, **Arm G**, which executes gate G5 of the
production-grade-scenarios effort. Its arms, batch budget, instruments,
thresholds and STOP conditions are registered in full in
`docs/research/preregistrations/gate-g5-bulk.md`, written and committed before
its harness existed and before its first dispatch.

Nothing above changes. Arm G inherits rules 1–5 and every Amendment 1 integrity
rule verbatim and adds two of its own
(`crossing-instrument-disagreement`, `server-socket-drops-unmeasurable`), both
of which only ever move a step to INCOMPLETE. Arms A, B, C and W are untouched,
and run 1's numbers are unaffected. This entry exists so a reader of this
document cannot encounter an arm it never mentioned.

## Run log

| # | date | run id | candidate SHA | arms | outcome | artifact sha256 |
|---|---|---|---|---|---|---|
| 1 | 2026-08-18 | [32193538952](https://github.com/vmeansdev/webtransport-bun/actions/runs/32193538952) | `29c3b694b0a28aac8b68802e886643e92f9a2a9f` | W | complete, stamped | `827a474cf6342c7634338eb49f14a09e03b252eee2a3daad64c379d9ac5de1e5` (`bench-stream-29c3b69….json`), `91ce57f522dd453bd5fd5237cb3ad61069f5eb8b7043fa979647797b8d7a87a0` (`.csv`) |

Run 1, `bench-bandwidth.yml` on `[self-hosted, Linux, X64, heavy]`, started
2026-08-18T22:54:18.988Z, Bun 1.3.14, 4 CPUs, procfs present. All nine rungs
complete, zero STOPs, `memoryRetention: CLEAN` (W-repeat 0.774 vs W1 0.781
Gbps). Delivered Gbps: W1 0.781 · W2 0.814 · W3 0.853 · W4 0.896 · W5 0.931 ·
W6 1.003 · W7 1.037 · W-a6 1.030. Every rung classified `window-plateau`, so
the ladder never met the `window-scaling` rule and the knee rule applied
normally: **knee = W6** (8 MiB per-stream / 64 MiB per-session), the smallest
complete rung ≥ 0.95 × the best complete rung (W7). Only W1 and its W-repeat
replay are `insideShippedPerSessionBudget`; W6's advertised worst case at
`max_sessions` = 31.8× the rig's 8 GB. No rerun; this is the single dispatch
this axis' sweep was budgeted. Decision consumed by ticket 09.

## Deferred (out of scope for this harness)

Listed so the gap is explicit rather than silent:

1. **Rust-only control server** (the same client ladder against a pure-wtransport
   drain server) to decompose the ceiling into transport cost vs N-API boundary
   cost. Arm A gives the boundary-inclusive ceiling; it does not attribute it.
2. **Server→client stream egress.** Different axis.
3. ~~**Flow-control window sweep** beyond the single A6 falsifier.~~ Promoted to
   Arm W by Amendment 2.
4. **Bidirectional streams.** Arms use unidirectional only; bidi adds an
   acceptance path but not a different byte path.
5. **Window sweep under a BDP that exceeds the default window.** Arm W runs on
   loopback, where the bandwidth-delay product is far below 256 KiB; a rung that
   plateaus here has not been shown to plateau on a real path. The sweep answers
   what the windows cost and buy *on this rig*, which is what the decision in
   ticket 09 is allowed to rest on.
