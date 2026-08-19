# Pre-registration — Gate G5: bulk stream throughput

**Written before any harness code for this gate**, and committed as its own
commit ahead of it, per spec §Process rules. Post-hoc edits to this file are
findings against the author.

- **Gate:** G5 (spec `.scratch/production-grade-scenarios/spec.md` rev 2, §G5),
  as amended by ticket 09's disclosed decision.
- **Axis:** stream-throughput. Arms, classifier buckets, integrity rules and
  STOP conditions are inherited verbatim from
  `docs/research/preregistrations/stream-throughput.md` (original + Amendments
  1 and 2). This document adds **Arm G** and nothing else; it does not relax any
  rule there.
- **Gate runner ≠ lever implementer.** Tickets 07 (chunk batching) and 09
  (windows) were implemented by other agents; this document and the Arm G
  harness are written by the gate agent, who implemented no lever.

## Candidate composition (spec §Candidate-tree composition)

- **Staging base:** `rebind4-staging` @
  `3d03a9878619db77bc3d94b96976ddb5d9ddb24a` — the merge that lands the close
  contract + promise-free `trySendDatagram`, stream chunk batching
  (`WEBTRANSPORT_STREAM_BATCH_BYTES`), `sendDatagramBatch`, and the optional
  explicit window fields. All knob-OFF or additive; no default moved.
- **Probe branch before composition:** `probe/stream-throughput-01` @ `e181334`.
- **Method: rebase**, chosen over merge because the probe branch is eight
  commits that touch only `tools/load/`, `.github/workflows/bench-bandwidth.yml`
  and this directory, none of which staging touched — a rebase therefore
  produces a linear, reviewable candidate whose diff against staging *is* the
  harness, with no merge commit mixing the two histories. It applied with zero
  conflicts.
- **Composed probe SHA (the candidate):**
  `a5d603a954e523ce27079452b2d249cc67549967`. The gate's own commits land on top
  of it; the run log below records the exact dispatched SHA per run.
- The probe branch is **never merged back**.

## What G5 asks, restated exactly

From spec §G5, with ticket 09's decision folded in:

1. **≥ 1 Gbps delivered** on a config whose per-session memory math stays
   **inside the shipped 2 MiB / 512 MiB budgets**. Ticket 09 issued no blanket
   waiver: the gate config stays inside the shipped governors and the path to
   1 Gbps is chunk batching, not windows.
2. **Zero kernel rcvbuf drops on the server side in the control.** Drops on the
   co-resident receiver are a disclosure with a threshold, not a failure.
3. **Crossing clause, numeric:** mean bytes per receive-side JS crossing
   **≥ 8 KiB (8192 B)** at delivered throughput **matched to the raised-window
   control**.
4. **A6 falsifier re-run at the chosen default.** No default flip is proposed by
   this gate and the soak-freeze forbids one before the rebind №5 ruling, so the
   chosen default is `WEBTRANSPORT_STREAM_BATCH_BYTES` **unset** — the shipped
   default. A6 is therefore re-run knob-OFF, and (as insurance for whoever
   later proposes the flip) also knob-ON, which costs nothing here.

## The reference numbers this gate is measured against

From the axis run log, run 1 (`32193538952`, candidate `29c3b69`, Arm W):

| rung | config | delivered |
|---|---|---|
| W1 | shipped 256 KiB / 2 MiB, knob OFF | **0.781 Gbps** |
| W-a6 | raised 16 MiB / 64 MiB, knob OFF | **1.030 Gbps** |

W1 is the gate's baseline: the shipped config, knob off, is 0.781 Gbps and
misses the bar by 22%. W-a6 is the **raised-window control** clause 3 matches
against: it clears 1 Gbps but only by advertising 31.8× the rig's memory at
`maxSessions`, which is exactly the config ticket 09 refused.

Both are re-measured inside this gate rather than quoted across runs — the
candidate tree is not the tree that produced them.

## Arm G — design

Everything is held at the W-rung / A4 / A6 operating point so a G cell is
directly comparable to run 1 and to the A6 falsifier: **4 sessions × 4
concurrent unidirectional streams (16 in flight), client write size 262,144 B,
unpaced, 60 s per step, fresh server per cell.**

The only two variables are the **server flow-control window** and the
**receive-side batching knob**, crossed:

| cell | windows (perStream / perSession) | `WEBTRANSPORT_STREAM_BATCH_BYTES` | role |
|---|---|---|---|
| `G-control` | 256 KiB / 2 MiB (**shipped**) | unset (**off**) | control; re-measures W1 |
| `G-batch` | 256 KiB / 2 MiB (**shipped**) | **65536** | **the gate arm** |
| `G-window-ref` | 16 MiB / 64 MiB (**raised**) | unset (off) | raised-window control; re-measures W-a6; A6 numerator at the chosen default |
| `G-window-batch` | 16 MiB / 64 MiB (raised) | 65536 | A6 numerator knob-ON (insurance only, never a gate cell) |

`G-control` and `G-window-ref` together **are** the A6 falsifier at the chosen
default — same rule, same 10% threshold, same write size as Arm A's control.
That is the "Arm A subset the A6 comparison needs"; Arm A's other write sizes
answer a different question and are not run.

**Each cell runs twice** (`-r1`, `-r2`), and the verdict uses the **median** of
the two (with two samples, the median is the mean; it is stated as median so a
future third repeat needs no rule change). Both samples are reported. A cell is
usable only if **both** of its repeats are complete.

### Why the process is invoked more than once

`WEBTRANSPORT_STREAM_BATCH_BYTES` is read **once, at module init**
(`packages/webtransport/src/stream-chunk-batch.ts`), which is a deliberate
property of the lever — a process cannot change delivery shape halfway through
a stream's life. So a knob-off cell and a knob-on cell cannot coexist in one
process. Arm G therefore runs as **three invocations of the same harness inside
one dispatch**:

- invocation 1: knob unset → `G-control`, `G-window-ref` (×2 each)
- invocation 2: knob `65536` → `G-batch`, `G-window-batch` (×2 each)
- invocation 3: a pure evaluator over the two artifacts → the gate verdict

One dispatch, one runner, one candidate SHA, three artifacts. The comparison
across invocations is done by **code fixed before the run** (`tools/load/gate-g5.ts`,
unit-tested), never by reading two JSON files by hand.

### Why the byte budget is 65,536 — fixed before any result

Four independent reasons, none of which is "it was the value that worked":

1. **It is not silently clamped.** The addon clamps a batch budget to
   `min(1 MiB, maxQueuedBytesPerStream)`. At the shipped 256 KiB per-stream
   governor the effective ceiling is 256 KiB, so 64 KiB is the configured value
   *and* the effective value. A budget at or above 256 KiB would be reported as
   one number and executed as another.
2. **It is the largest power of two whose worst-case batch residency stays
   inside the shipped per-session governor at this arm's concurrency.** 16
   in-flight streams × 64 KiB = 1 MiB, inside the 2 MiB `maxQueuedBytesPerSession`.
   At 128 KiB that is 2 MiB — exactly the governor — and at 256 KiB it is 4 MiB,
   i.e. a config that can hold the whole per-session budget in un-consumed JS
   batches. The gate must not clear its bar by quietly borrowing the governor it
   claims to stay inside.
3. **It gives the crossing clause 8× headroom.** The clause is 8 KiB; a budget
   of 8–16 KiB would make the clause a coin flip on the batch-size distribution
   rather than a statement about the lever.
4. **It is one quarter of the per-stream window**, so a single crossing can
   never hold more than 25% of a stream's flow-control credit while JS owns it.

**One budget, pre-registered, no ladder.** Re-running `G-batch` at another
budget to clear the bar is forbidden. A budget ladder is a ticket-07 follow-up,
not part of this gate — and it is not needed to interpret a miss, because
`maxBatchBytes` and the batch-size distribution in the diagnostics counter
already say whether a larger budget could have helped (see "If the gate misses").

### The measurement-relevant residual: `STREAM_READ_BUFFER_BYTES` = 4 KiB

Ticket 07's residual 1. `crates/native/src/client_stream.rs:202` fixes each
underlying `read_chunk` at 4 KiB, so a 64 KiB batch is at most 16 coalesced
4 KiB chunks, and **the unbatched path's mean bytes per crossing cannot exceed
4 KiB by construction**. Two consequences, both fixed here before the run:

- The 8 KiB crossing clause is, mechanically, "**≥ 2 underlying chunks coalesced
  per crossing on average**". That is the honest reading of the number and the
  gate states it that way.
- **This gate does not raise that constant.** Ticket 07 exposes no environment
  knob for it, and the instruction is explicit: no product-code change for a
  measurement. If `G-batch`'s mean pins at ≈ 4096 B, the finding is that the
  4 KiB per-read cap — not the batching lever — is the binding constraint on the
  crossing clause, and the miss routes to ticket 07 as its mechanism ticket.

## Instruments

### Crossing size — two independent instruments, required to agree

1. **Harness-side (always on):** the bench server counts every
   `reader.read()` resolution and its bytes, so `serverBytes / serverChunks` is
   the mean bytes per receive-side JS crossing, measured by the consumer.
2. **Package-side (mandatory diagnostics, `WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS=1`):**
   ticket 07's counter — `dataCrossings`, `terminalCrossings`, `batchedCrossings`,
   `bytes`, `meanBytesPerCrossing`, `maxBatchBytes`, `crossingsPerSecond`. It
   records on the **unbatched path too**, so control and gate arms are read off
   one instrument. Reset at the start of every step, snapshotted after the
   step's settle, and reported **per step fragment** in the artifact.

The diagnostics knob is ON for **every** invocation, control included.

**Pre-registered integrity rule:** if a step's two mean-bytes-per-crossing
figures differ by more than **1%** of the larger, the step is
`crossing-instrument-disagreement` = INCOMPLETE. A crossing clause adjudicated
by an instrument that its own cross-check contradicts is not a measurement. The
clause is evaluated on the **package-side** counter (it is the instrument G5
names); the harness-side figure is the check.

### Server-side kernel rcvbuf drops

`/proc/net/snmp` `Udp.RcvbufErrors` is host-wide and on this on-box rig sums the
server's and the co-resident client's drops, so it cannot answer a clause that
says "**on the server side**". Arm G adds per-socket attribution:

- `/proc/net/udp` and `/proc/net/udp6` are parsed, and the rows whose local port
  equals the cell's server port are the **server sockets**. Their `drops` column
  (and `rx_queue`) is sampled at step start and after the step's settle.
- `serverSocketDrops` = the delta over the server's own sockets.
- `coResidentDrops` = host-wide `Udp.RcvbufErrors` delta − `serverSocketDrops`,
  floored at 0. This is the co-resident receiver's share and is **disclosed, not
  failed**.

Pre-registered rules:

- **Clause:** `G-control` (the control) must show `serverSocketDrops == 0` in
  **both** repeats. Non-zero → the gate **FAILS** on the drops clause. Reported
  for every cell, not only the control.
- **Disclosure threshold:** `coResidentDrops` is always printed. If it exceeds
  **0.1% of the step's `/proc/net/snmp` `Udp.InDatagrams` delta**, it is flagged
  `MATERIAL` and every delivered figure in that step is stated as a **lower
  bound**. Below the threshold it is flagged `IMMATERIAL` and still printed.
- **Instrumentation is not optional:** if no `/proc/net/udp*` row matches the
  server port, the step is `server-socket-drops-unmeasurable` = INCOMPLETE. A
  clause that could not be checked is not a clause that passed — the same rule
  Amendment 1 applied to the CPU series.

### Memory

`windowMath()` (Arm W's mirror of `transport_memory.rs`, already asserted
against that file's own unit-test values and aborting on drift) is reported per
cell: `perSessionWorstCaseBytes`, `atMaxSessionsBytes`, and
`insideShippedPerSessionBudget`. RSS baseline/peak/delta as in Arm W.

## Verdict rules, fixed before the run

Every rule below is implemented in `tools/load/gate-g5.ts` and unit-tested in
`tools/load/gate-g5.test.ts` against synthetic cells, so it executes before the
dispatch rather than only inside the run it adjudicates. The evaluator reads
only the fields named here.

**Every stream-throughput classifier rule applies first and verbatim** — rules
1–5 of the original registration and every Amendment 1 integrity rule
(`server-stream-errors`, `counter-contamination`, `drain-unsettled`,
`instrumentation-missing`). Arm G adds two more, ahead of the throughput
buckets: `crossing-instrument-disagreement` and
`server-socket-drops-unmeasurable`. Arm G cells are classified with Arm W's
`window`-kind rules against `prev = null` (no cell is a rung of a ladder, so no
cell is compared to another for its bucket).

### PASS requires all six

| # | clause | rule |
|---|---|---|
| 1 | **completeness** | all four cells usable: both repeats of each complete (no INCOMPLETE bucket) |
| 2 | **throughput** | `median(G-batch delivered) >= 1.000 Gbps` |
| 3 | **inside shipped budgets** | `G-batch.insideShippedPerSessionBudget === true` **and** its per-stream governor is the shipped 256 KiB **and** no explicit window field is set |
| 4 | **crossing** | `median(G-batch package-side meanBytesPerCrossing) >= 8192 B` |
| 5 | **matched to the raised-window control** | `median(G-batch delivered) >= 0.95 × median(G-window-ref delivered)` |
| 6 | **server-side rcvbuf drops** | `G-control.serverSocketDrops === 0` in both repeats |

A failure of any clause is a **MISS**, and per spec §Rerun policy a miss on a
valid run is **final for the effort** and routes to its mechanism ticket
(ticket 07 for clauses 2/4, ticket 09 for clause 3/5, the rig for clause 6).
The evaluator names the failing clause and does not aggregate.

### The A6 falsifier, re-run

Arm A's rule verbatim, at the chosen default and again knob-ON:

- `a6AtChosenDefault` = `median(G-window-ref) / median(G-control)`;
  `> 1.10` ⇒ `WINDOW-BOUND`, else `WINDOWS-NOT-BINDING`.
- `a6AtKnobOn` = `median(G-window-batch) / median(G-batch)`; same threshold.
  Reported for whoever later proposes the flip; it is **not** a gate clause.

`WINDOW-BOUND` at the chosen default does **not** by itself fail G5 — G5 is a
delivered-throughput statement on a config inside shipped budgets, not a claim
about which resource binds. It is carried into the stamp as a disclosure, and
it moves the axis's existing `bulkCeilingIsLowerBoundOnly` flag exactly as
Amendment 1 specified.

### Derived figures reported but never used as a bar

`crossingsPerSecond`, `maxBatchBytes`, `batchedCrossings` share, `serverCpuMsPerGbit`,
`clientCpuMsPerGbit`, `rssMbPeak`/`Delta`, `gso`/`gro` verdicts, and the
lever's own effect `median(G-batch) / median(G-control)`. None of these has a
threshold. They exist so a miss is interpretable and a pass is attributable.

## If the gate misses — what the artifact must already contain

Fixed here so that no post-hoc instrument is added to explain a result:

- **Missed clause 2 (throughput) but cleared 4 (crossing):** the crossing was
  amortized and the ceiling is elsewhere; `serverCpuMsPerGbit` versus
  `G-control`'s says whether the boundary got cheaper at all.
- **Missed clause 4 (crossing):** `maxBatchBytes` decides between two
  mechanisms without another run. `maxBatchBytes ≈ 4096` ⇒ the queue never held
  a second chunk when a crossing began, so **no** budget would have helped and
  the constraint is arrival pacing, not the budget. `maxBatchBytes ≈ 65536` with
  a low mean ⇒ the distribution is bimodal, and a larger budget would not raise
  a mean that is dominated by singleton crossings either. Both readings route to
  ticket 07, and neither licenses re-running this gate at another budget.
- **Missed clause 6 (drops):** `rx_queue` on the server socket at step end
  separates "the receiver never drained" from "the kernel buffer was too small".

## STOP conditions

The axis's STOP conditions 1 (generator saturation), 2 (host saturation), 3
(limiter engaged) and 5 (GSO uncomputable) apply verbatim. Two additions:

- **G-STOP-A:** any of the four cells unusable ⇒ **no gate verdict**. The run
  reports the cells it has. This is not a rerun trigger; a rerun requires a
  declared, logged harness/infra fault per spec §Rerun policy.
- **G-STOP-B:** `crossing-instrument-disagreement` anywhere ⇒ no crossing claim
  is made for the whole arm, not just the offending step.

## Rules this gate holds itself to

- The knob's byte budget, the arm layout, every threshold and every tolerance in
  this document were fixed before the first dispatch. Nothing is tuned to the
  bar.
- No default is flipped by this gate, and none may be: the soak-freeze binds
  until the rebind №5 ruling.
- No product code is changed for the measurement. The harness may only observe.
- Local macOS smoke validates that the arm runs and that its output parses into
  these buckets. Every local step is INCOMPLETE by construction
  (`instrumentation-missing`, no procfs) and **local numbers are never quoted**.

## Run log

| # | date | run id | candidate SHA | invocations | outcome | artifact sha256 |
|---|---|---|---|---|---|---|
| — | — | — | — | — | not yet dispatched | — |

Every dispatch is logged here, including aborted ones.
