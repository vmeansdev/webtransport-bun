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
| 1 | 2026-08-19 | [32220018998](https://github.com/vmeansdev/webtransport-bun/actions/runs/32220018998) | `40b220cc0525cea54ddc3c5aaf12c8482bf82c4a` | knoboff · knobon · verdict | **NO-VERDICT** (G-STOP-A), stamped | see below |
| 2 | 2026-08-19 | [32242618831](https://github.com/vmeansdev/webtransport-bun/actions/runs/32242618831) | `0d32d2784aa7597e2fc86d171427f62081398b7d` | knoboff · knobon · verdict | **ORCHESTRATOR MIS-DISPATCH — not a rerun, licenses nothing** | see below |

Artifact sha256 (all five, as downloaded from `bench-bandwidth-40b220cc0525…`):

| file | sha256 |
|---|---|
| `bench-stream-g5-knoboff-40b220cc…json` | `82295847394714f13d249d43f6ff1581f199d45af2ca54d1cbf2f4f9eec68d68` |
| `bench-stream-g5-knoboff-40b220cc…csv` | `fe9f11be459d0aaced49b3b8a6c756e5dfae07ab0b190f7d1e9e0604dd67a401` |
| `bench-stream-g5-knobon-40b220cc…json` | `f47d3599b9ec177a13a351313de67ef4177b4fbec4c2fd69b0d0d46e5f902e9b` |
| `bench-stream-g5-knobon-40b220cc…csv` | `088f4c727b70d641cbc52720d453d310de222c8af99c6027dd698d231202e85c` |
| `bench-stream-g5-verdict-40b220cc…json` | `146aaf50b0d66987dd1e9749315dce06ef4fdfe0c841b3a4993131f04fdda051` |

Every dispatch is logged here, including aborted ones.

### Run 2 — orchestrator mis-dispatch (2026-08-19), logged, licenses nothing

On 2026-08-19 the orchestrator dispatched the **paced** gate's candidate
(`probe/stream-throughput-01` @ `0d32d2784aa7597e2fc86d171427f62081398b7d`,
based on staging `2a4145d`) with `mode=gate-g5` instead of `mode=gate-g5b` — an
input error, disclosed by the orchestrator in ticket 27 and logged here by the
stamping agent because it executed **this** registration's Arm G.

It reproduced this registration's stamped shape on the newer tree:
`G-control` 0.864 / 0.866, `G-window-ref` 1.093 / 1.110 (both `gate-cell`),
`G-batch` 3.890 / 3.861 and `G-window-batch` 3.973 / 3.945, the two knob-ON
cells `host-saturated` in both repeats — **G-STOP-A, NO-VERDICT**, exactly as
run 1.

**This is not a rerun and is not offered as one.** This registration is closed:
run 1 was valid, its NO-VERDICT is final for the effort, and re-running Arm G is
forbidden by spec §Rerun policy and by this document. Run 2 changes nothing
here — no verdict, no number, no threshold, no disclosure is revised by it. It
is recorded so that a reader who finds a second `mode=gate-g5` artifact bundle
on the runner knows what it is and what it is not. Its outcome does, in passing,
confirm the design finding this registration closed on — the knob-ON cells cross
the host bar on this rig at any tree — which is why the paced gate exists.

| file | sha256 |
|---|---|
| `bench-stream-g5-knoboff-0d32d278…json` | `8e7d938b98f20700a665b4ef3dfe31d414172ee34204cb115c08142f6284ab63` |
| `bench-stream-g5-knoboff-0d32d278…csv` | `adb6728ee89e2e080ae3f8f81db3a8536c415ba397e335344e6210e3616edaed` |
| `bench-stream-g5-knobon-0d32d278…json` | `7a4c6edf064b7ce2e3e613fb7f73617aace97d765749e9f0e17c65ea4b6424ad` |
| `bench-stream-g5-knobon-0d32d278…csv` | `a0ca19c2c9a30534a9704408b97f3a9a454b1e878530056d9493ce2905934f05` |
| `bench-stream-g5-verdict-0d32d278…json` | `256b5a8ed50991ac67b4390dd2f4d753abb0ca4e92df25e98669a5ba6686d75d` |

The correct `mode=gate-g5b` dispatch that followed it is run 32244004915, logged
and stamped against `docs/research/preregistrations/gate-g5b.md`.

---

# Run 1 — the stamp

`bench-bandwidth.yml`, `mode: gate-g5`, `[self-hosted, Linux, X64, heavy]`,
dedicated. Bun 1.3.14, 4 CPUs, procfs present. All three invocations ran to
completion; eight step fragments produced, none missing, no harness abort, no
declared infra fault. **This is a valid run**, and per spec §Rerun policy its
outcome is final for the effort.

## Verdict: NO-VERDICT — G-STOP-A

> `G-STOP-A: cells not usable (G-batch=[host-saturated,host-saturated]
> G-window-batch=[host-saturated,host-saturated]); no gate verdict`

Both knob-ON cells classified `host-saturated` in **both** repeats, which is the
axis's STOP condition 2 (bucket 4) applied by the classifier that predates this
gate. `G-batch` is the gate arm, so clauses 1, 2, 4 and 5 have no gradeable
input and **no G5 pass/fail is issued**. Per the registration this is *not* a
rerun trigger.

| clause | result |
|---|---|
| 1 completeness | **not met** — `G-batch`, `G-window-batch` unusable |
| 2 throughput ≥ 1.000 Gbps | **ungradeable** — gate arm unusable |
| 3 inside shipped budgets | **PASS** |
| 4 crossing ≥ 8192 B | **ungradeable** — gate arm unusable |
| 5 ≥ 0.95 × `G-window-ref` | **ungradeable** — gate arm unusable |
| 6 `G-control` server rcvbuf drops == 0 | **PASS** |

### Clause 3 — PASS, recorded

`G-batch` ran at `queuedBytesPerStream = 262144`, `queuedBytesPerSession =
2097152`, `explicitWindowFieldsSet = false`, `insideShippedPerSessionBudget =
true`. `windowMath()` puts its advertised worst case at `max_sessions` at
12,583,808,000 B = **1.46× the rig's 8 GB** (versus 31.8× for the raised-window
cells). The gate arm was configured exactly as registered: the shipped
governors, no explicit window field, the knob as the only variable. This clause
is a statement about the configuration that ran, not about a delivered number,
so the host-saturation contamination does not touch it.

### Clause 6 — PASS, recorded

`G-control` `serverSocketDrops` = **0 in both repeats** (per-socket attribution
over `/proc/net/udp{,6}` rows on port 4460), with `coResidentDrops` = 0 and
`serverSocketRxQueueBytesAtEnd` = 0. The clause was measurable (a matching
socket row was found in every step, so `server-socket-drops-unmeasurable` never
fired) and it is clean. Disclosed for the non-control cells, where the clause
does not bind: `G-window-ref` 523 / 1777, `G-batch` 1602 / 1975,
`G-window-batch` 15382 / 16008 server-socket drops. `coResidentDrops` was 0 and
`IMMATERIAL` in **all eight** steps — every drop this run saw was on the
server's own socket, none on the co-resident receiver.

## The usable cells — medians, spread, full disclosure

Two repeats per cell, so the median is the mean of two and there is no
distribution to put a confidence interval on. **No CI is quoted**; the honest
dispersion statistic at n = 2 is the half-range, given below with both samples.

| cell | usable | delivered Gbps (r1, r2) | median | half-range | host CPU median | server / client CPU % | server drops |
|---|---|---|---|---|---|---|---|
| `G-control` (shipped, knob off) | **yes** | 0.8768, 0.8829 | **0.8799** | ±0.0030 (0.35%) | 71%, 71% | 202 / 60 | 0, 0 |
| `G-window-ref` (raised, knob off) | **yes** | 1.1361, 1.1471 | **1.1416** | ±0.0055 (0.48%) | 69%, 69% | 211 / 48 | 523, 1777 |
| `G-batch` (shipped, knob 65536) | no — host-saturated ×2 | 3.9734, 3.9479 | *3.9606* | ±0.0127 (0.32%) | **92.34%, 92.31%** | 187 / 157 | 1602, 1975 |
| `G-window-batch` (raised, knob 65536) | no — host-saturated ×2 | 4.0196, 4.0730 | *4.0463* | ±0.0267 (0.66%) | **92.4%, 92.6%** | 195 / 152 | 15382, 16008 |

Integrity checks that had to hold before any of this is readable, and did:
`serverBytes == client.streamBytesWritten` **exactly** in all eight steps (no
`drain-incomplete`, no `counter-contamination`), `settleTimedOut = false`
everywhere, `serverStreamErrors = 0`, `rateLimitedDelta = limitExceededDelta =
0`, 16/16 streams opened, accepted and completed in every step.

Disclosed shift against run 1's Arm W: `G-control` 0.880 vs W1 **0.781**
(+12.7%) and `G-window-ref` 1.142 vs W-a6 **1.030** (+10.8%). The two controls
moved together by ~11–13%, which is consistent with a tree difference (this
candidate rebases the probe onto staging `3d03a98`, a different base than run
1's `29c3b69`). It is **not attributed** here — no experiment in this run
isolates it, and neither control is a gate clause. It is recorded so nobody
reads run 1's W numbers and this run's controls as the same measurement.

## Host CPU against the 90% bar — the exact margin

The bar is `bench-stream.ts:823`, `hostCpuPctMedian >= 90` ⇒ `host-saturated`,
written for the axis before this gate existed and not touched by it.

| cell | repeat | host CPU median | host CPU max | over the bar by |
|---|---|---|---|---|
| `G-control` | 1 / 2 | 71.3 / 71.4 | 73.6 / 72.9 | — (18.6 under) |
| `G-window-ref` | 1 / 2 | 69.9 / 69.8 | 75.2 / 74.9 | — (20.1 under) |
| `G-batch` | 1 / 2 | **92.34 / 92.31** | 94.01 / 94.4 | +2.34 / +2.31 |
| `G-window-batch` | 1 / 2 | **92.9 / 93.0** | 95.0 / 94.8 | +2.9 / +3.0 |

The knob-off cells sit ~19 points under the bar; the knob-ON cells sit ~2.3–3.0
points over it, in **both** repeats, with no overlap between the two groups.
This is not a marginal classification that a third repeat would resolve — the
knob moved the operating point across the bar, and on a 4-vCPU on-box rig it
cannot be moved back without changing the gate's design.

## Crossing diagnostics — what the 65,536 B budget actually produced

Both instruments, all eight steps:

| cell | package mean B/crossing | harness mean B/crossing | disagreement | crossings/s | maxBatchBytes | batchedCrossings |
|---|---|---|---|---|---|---|
| `G-control` | 1388.4 / 1387.1 | 1388.4 / 1387.1 | **0.000%** | 73807 / 74410 | **1422** | 0 / 0 |
| `G-window-ref` | 1418.9 / 1418.1 | 1418.9 / 1418.1 | **0.000%** | 92996 / 93971 | **1422** | 0 / 0 |
| `G-batch` | 54867.8 / 54908.9 | 54867.8 / 54908.9 | **0.000%** | 8477 / 8416 | **65536** | 543145 / 539258 |
| `G-window-batch` | 65509.1 / 65468.9 | 65509.1 / 65468.9 | **0.000%** | 7118 / 7201 | **65536** | 460215 / 466611 |

**The two instruments agreed to the byte** — 0.000% apart, against a 1%
tolerance — in every step, so `crossing-instrument-disagreement` never fired and
**G-STOP-B did not fire**. (They agree exactly because `streamBatch.dataCrossings`
and the consuming reader's `serverChunks` counted the same resolutions:
543129 = 543129 on `G-batch` r1, and both divide the same byte total.
`batchedCrossings` exceeds `dataCrossings` by exactly 16 per step — the
terminal crossing of each of the 16 streams.)

**The pre-registered 4 KiB read-cap consequence did NOT fire.** The registration
said a `G-batch` mean pinning at ≈ 4096 would mean the `STREAM_READ_BUFFER_BYTES`
cap, not the lever, binds the crossing clause. It did not pin: the mean is
**54.9 KB**, `maxBatchBytes` reached the configured **65,536 exactly** (so the
budget, not a clamp, is the ceiling and the queue routinely held a full budget's
worth), and 54888 / 4096 = **13.4 underlying 4 KiB chunks coalesced per crossing
on average**. The lever genuinely coalesced. Had `G-batch` been gradeable, the
8192 B clause would have cleared by **6.7×**.

A second reading falls out of the control, and it revises the registration's own
mechanical framing: the *unbatched* mean is **1388 B** with `maxBatchBytes` =
**1422**, i.e. far below the 4096 cap. The knob-off path was never read-cap
bound at this operating point at all — it was arrival-paced at roughly one QUIC
stream frame per crossing. So the 8 KiB clause was never "≥ 2 chunks coalesced"
in practice; against this control it is "≥ 5.9 frames coalesced". The
registration's construction-bound was correct as an upper bound on the unbatched
path and simply not the binding one. Recorded as a correction to the
registration's reading, not to any of its thresholds.

Derived, threshold-free: crossings/s fell **8.77×** (74,109 → 8,447) and
`serverCpuMsPerGbit` fell **4.86×** (2421 → 498) between `G-control` and
`G-batch`.

## `G-window-ref` — usable, and the A6 re-run at the chosen default

`G-window-ref` is **usable**: both repeats complete, `gate-cell` bucket, host
CPU 69.8–69.9% median, client CPU 48% against server 211% (nowhere near the
generator-saturation rule), instruments agreed to the byte. Its 523 / 1777
server-socket drops are disclosed and do not bind — clause 6 is written against
`G-control` — but they do make its own delivered figure a lower bound on what a
drop-free receiver would have taken.

**A6 falsifier, re-run at the chosen default (knob unset, the shipped default):**

- `a6AtChosenDefault = 1.1416 / 0.8799 = ` **1.297** > 1.10 ⇒ **WINDOW-BOUND**.
- Run 1's A6 on the same rule was 1.030 / 0.781 = 1.319 ⇒ also `WINDOW-BOUND`.
  The falsifier reproduces on the candidate tree.

Per the registration this is a **disclosure, not a gate failure**: G5 is a
delivered-throughput statement on a config inside shipped budgets, not a claim
about which resource binds. It moves `bulkCeilingIsLowerBoundOnly` exactly as
Amendment 1 specified — the shipped-window bulk figure measures the flow-control
window and therefore bounds the N-API boundary from below.

**A6 knob-ON:** the evaluator returned `unknown`, correctly — both of its cells
are unusable. The arithmetic ratio is 4.0463 / 3.9606 = 1.022, and it is
recorded here **as arithmetic only, not as an A6 verdict**: both numerator and
denominator were produced at ≥ 92% host CPU, where the rig and not the window is
what either cell was measuring.

## Numbers without a verdict — the 3.96 Gbps observation, and what survives

`G-batch` delivered **3.96 Gbps median** (3.9479 / 3.9734, half-range 0.32%) on
the **shipped 256 KiB / 2 MiB governors with no explicit window field**, knob at
65,536 — **4.50× `G-control`**. This is published under the registered rule for
unusable cells: *the cells the run has, reported, with no gate verdict attached*.

Stated precisely, per the registered rules and inventing nothing beyond them:

**What survives the contamination.** `deliveredMbps` is `serverBytes × 8 /
windowSec`. `serverBytes` is a counter read on the consuming server
(29,800,267,776 B in r1) that equals `client.streamBytesWritten` to the byte,
and `windowSec` is the configured 60 s. Those bytes really crossed the N-API
boundary into JS and were really counted by a reader that saw every stream
complete. Host saturation cannot inflate a byte counter. The same holds for the
crossing figures: `meanBytesPerCrossing` is one exact counter divided by
another, carries no time denominator, and was confirmed by a second instrument
to the byte. **The transport moved ~3.96 Gbps into JS at ~54.9 KB per crossing
on the shipped governors. That happened.**

**What does not survive.** (1) It is **not a capacity number for the server**:
the generator was co-resident and the host was at 92% median, so per STOP
condition 2 this is a **lower bound on the server, co-residence disclosed**, and
the true uncontended figure is unknown and higher. (2) Every **CPU-derived**
figure is contaminated — `serverCpuMsPerGbit` = 498, and the 4.86× cost
reduction computed from it, were measured while the server competed with the
generator for the same 4 cores; the direction is credible, the magnitude is not
adjudicated. (3) Any **tail or latency-like** quantity is void at this operating
point, and none is claimed. (4) The **1,602–1,975 server-socket drops** on
`G-batch` are a contention artifact of a saturated host, not a property of the
lever, and they are why `G-batch` could not have carried clause 6 even had it
been usable. (5) The **4.50× lever effect** is a ratio of a contaminated cell to
a clean one and is therefore itself a lower bound on the lever's effect at an
uncontended operating point — the evaluator refused to emit
`leverEffectBatchOverControl` (it is `null` in the verdict artifact) and this
document does not overturn that; the 4.50× is quoted as an observation about
this run, not as the lever's measured effect.

## Prediction reconciliation

The registration's "If the gate misses" section carried three conditional
predictions, one per miss branch. Reconciled honestly:

| pre-registered branch | fired? | outcome |
|---|---|---|
| missed clause 2, cleared clause 4 ⇒ compare `serverCpuMsPerGbit` | **no** | clause 2 never became gradeable |
| missed clause 4 ⇒ `maxBatchBytes` ≈ 4096 (arrival-paced) vs ≈ 65536 with low mean (bimodal) | **no** | `maxBatchBytes` = 65536 **and** the mean was 54.9 KB — neither failure mode; the lever coalesced as designed |
| missed clause 6 ⇒ `rx_queue` separates "never drained" from "buffer too small" | **no** | clause 6 passed; `rxQueueBytesAtEnd` = 0 in every step |

**The branch the registration did not carry is the one that happened.** Every
miss branch it wrote anticipated the lever under-delivering. None anticipated it
delivering hard enough to push a co-resident 4-vCPU rig across the axis's own
host-saturation STOP. The design gap is specific and now on record: `G-batch`
was registered **unpaced** at the W-rung operating point, inheriting a config
tuned for a ~0.8 Gbps boundary-bound path. Remove ~80% of the per-byte boundary
cost from that path and an unpaced 4-session × 16-stream generator co-resident
with its server on 4 cores has no way to stay under 90%. The gate could not have
produced a verdict for the lever *as it was registered*, and that is a finding
against the gate's design, not against the lever.

Also reconciled: the registration predicted the 65,536 budget would not be
silently clamped (`maxBatchBytes` = 65536 exactly — **confirmed**), that the
crossing clause would have 8× headroom (it had 6.7× realized — **confirmed**),
and that both instruments would be readable off one counter on the unbatched
path too (**confirmed**, 0.000% apart on all eight steps).

## Mechanism finding, routed

**The lever works and the rig cannot grade it.** Receive-side chunk batching at
a 65,536 B budget, on the shipped governors, moved delivered throughput 4.50×
(0.880 → 3.96 Gbps) and cut crossings/s 8.77×, and the registered co-residence
honesty rule — the axis's host-saturation STOP, written before this gate — bound
**before any product limit did**. No governor was hit, no window was raised, no
flow-control ceiling was reached, no rcvbuf drop on the co-resident receiver.
The binding constraint on this measurement is the measurement rig.

Routed per the pre-registration:

- **Ticket 07 (chunk batching)** — clauses 2 and 4 are its mechanism ticket.
  Both are ungradeable here, and the reason is not its lever. The crossing
  observation (54.9 KB/crossing, `maxBatchBytes` = 65536, 13.4 chunks coalesced,
  4.86× lower CPU/Gbit) is handed to it as evidence, contamination stated. Its
  residual 1 (`STREAM_READ_BUFFER_BYTES` = 4 KiB) is **not** the binding
  constraint at this operating point — the unbatched control ran at 1388 B per
  crossing, well under the cap.
- **Ticket 09 (windows)** — clauses 3 and 5. Clause 3 passed on the shipped
  governors. Clause 5 is ungradeable. A6 re-ran `WINDOW-BOUND` at 1.297,
  reproducing run 1, which stands as its disclosure.
- **The rig** — clause 6 passed, so nothing routes there on drops. The
  host-saturation STOP routes there as a **design finding**, below.

**Closing G5 on this rig requires a different gate, not another run of this
one.** Two designs can produce a gradeable ≥ 1 Gbps statement:

1. **Off-box generation** — move the client to a second box so the server's
   cores are its own and `hostCpuPctMedian` measures the server. The closed
   160k-ceiling ladder already found this vswitch caps off-box delivery, so this
   is not a free swap and needs its own feasibility step.
2. **A paced (rate-capped) gate** — hold the offered rate at, say, 1.2–1.5 Gbps
   instead of running unpaced, so the gate asks "does the config *sustain*
   1 Gbps with the host under the bar" rather than "how fast can it go". This
   answers G5's actual question (a threshold, not a ceiling) and is the design
   the ≥ 1 Gbps bar wanted from the start.

Either is a **new pre-registration** with its own arms, thresholds and STOPs.
Re-running the registered Arm G is **forbidden**: this was a valid run, and per
spec §Rerun policy a rerun requires a declared, logged harness or infra fault.
None occurred — the harness did exactly what it was registered to do, including
refusing to grade the cells it could not grade. Re-running `G-batch` at another
batch budget remains forbidden by the registration and is not what any finding
here asks for.

## What the bulk / VOD scenario licenses after this stamp

Unchanged from before this run, plus two facts and one recorded observation:

- **The stamped lower bounds stand, and are not raised.** Bulk reliable
  transfer on 4 vCPU: **≥ 792 Mbps at the shipped default config**, **≥ 1051 Mbps
  with raised windows (window-bound)**, both from the earlier stamped four-axes
  runs (`docs/research/2026-08-18-four-axes-measurement.md`). G5 returned no
  verdict and therefore raises nothing. This run's clean controls (`G-control`
  ≥ 0.877 Gbps drop-free, `G-window-ref` ≥ 1.136 Gbps) are **consistent with and
  above** those bounds but were measured on a different tree; they corroborate,
  they do not re-stamp.
- **The ≥ 1 Gbps G5 claim is not licensed.** No configuration inside the shipped
  budgets has a graded ≥ 1 Gbps delivered figure. The only ≥ 1 Gbps graded
  figure remains the raised-window one, which is outside the shipped per-session
  budget (31.8× the rig at `max_sessions`) and is `WINDOW-BOUND`.
- **Licensed as fact (clause 3):** the gate arm's configuration stayed inside
  the shipped 256 KiB / 2 MiB governors with no explicit window field, advertised
  worst case 1.46× the rig at `max_sessions`.
- **Licensed as fact (clause 6):** the shipped-config control sustained
  0.880 Gbps for 2 × 60 s with **zero** server-side kernel rcvbuf drops and zero
  co-resident drops, receive queue empty at step end.
- **Recorded, explicitly not licensed as a capacity claim:** 3.96 Gbps delivered
  into JS at 54.9 KB per crossing on the shipped governors with batching at
  65,536 B — a real byte count from a host-saturated step, published as a lower
  bound with its contamination stated, usable as evidence for ticket 07 and as
  the motivation for a paced gate, and **not** quotable as a product throughput
  figure.
- **Disclosure carried forward:** `bulkCeilingIsLowerBoundOnly` stands, reason
  `WINDOW-BOUND` at the chosen default (A6 = 1.297, reproducing run 1's 1.319).
