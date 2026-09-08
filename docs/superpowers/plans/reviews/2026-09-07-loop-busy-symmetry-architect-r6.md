CHANGES REQUIRED

# Architect review (revision 6) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed by me, before reading) | `187a73d3238f29ed98205777e181def3cb098c1a07c3409db2a52fc406f11239` |
| Declared SHA-256 | identical |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | `git status --porcelain` filtered for tracked changes → **empty**. Git used read-only. Only this artifact written |
| Prior artifacts read | my r1–r5; Critic r5 |
| Method | every `file:line` the plan cites read at HEAD; `bun test ./tools/compare/adapters/loop-busy.test.ts ./tools/compare/adapters/read-path-adapters.test.ts` → **29 pass / 0 fail**; the `acceptUni` and `read` surfaces enumerated by scan rather than by eye; the three sealed `bulk-one-way/physical` WT arms re-parsed off disk; and **the WebSocket consumer read turn metered on the real `WebSocketAdapter` at the plan's own workload**, which is the finding below |

**R6 discharges all four r5 blockers. I confirm each one, by execution, in the table below.**
Item C is now the right shape, the ceiling is correctly deleted, the 18 µs citation is
correctly withdrawn against both reviewers, and acceptance bullet 6 no longer refuses the
plan's principal work item. Those were the four things r5 refused over and they are gone.

**It is refused on one new ground, which is a consequence of R6's own reshaping and which I
found by metering the WebSocket side of the seam R6 now charges on WebTransport.** The
plan's central justifying sentence — that the caller turn item C charges is "charged in
full on the WebSocket side inside `ws.ts:1865`" — is false, and it is false about the
counterpart turn specifically. `ws.ts:1865` charges the **arrival** turn, whose WebTransport
counterpart is the arrival body R5 charged at 0.06–0.22 ms. The WebSocket counterpart of the
turn item C now charges is `WsChannel.read` → `waitForQueue` (`ws.ts:2146` → `:472-512`),
and I measured it at **8.2–11.5 ms per 1600 × 64 KiB, of which 3.7–5.0 ms is the synchronous
prefix alone** — against the 5.76–8.27 ms item C adds on WebTransport. Executed exactly as
written, the plan charges a turn on WT whose WS twin, of the same or greater size, stays off
the books and is recorded by the plan's own census as charged elsewhere. That does not close
the asymmetry; it moves it, and hides the remainder behind a cell that reads as evidence.

---

## The four r5 blockers, discharged

| r5 blocker | Status at r6 | How I checked |
| --- | --- | --- |
| **C1a — item C charged ~3% of the read path** | **Discharged.** C now says "Charge the whole caller turn on both WebTransport read seams, using the existing `open`, `pause`, `resume`, `close` discipline". The discipline exists as cited: `transport.ts:117-118` is the "No span crosses an `await`" rule verbatim, `:196-198` is "The caller pauses it before every `await` and closes it in a `finally`", and `LoopBusySpan` (`:138-145`) exports `pause`, `resume`, `close` | read at HEAD |
| **C1b — the 5 ms ceiling was inverted and `pricedClock` is blind** | **Discharged.** The ceiling is deleted; E is a discriminating test against a real clock with injected waiting, and it states `pricedClock` must not be used. I verified the blindness claim independently: `pricedClock` (`loop-busy.test.ts:63-96`) advances `now` **only** in `sleep` and in `noteBusySlice`/`noteEgressSlice`, and `readChunk`'s deadline uses the real `setTimeout` (`wt.ts:187`, `:206`), not `clock.sleep` — so under that clock the honest and the await-spanning shapes are indistinguishable and both read ~0. The plan's exclusion is correct and necessary | read at HEAD |
| **C2 / A5-2 — the 18 µs prices `codec.decode`** | **Discharged, and correctly.** `server.ts:812-824` reads "running **`codec.decode`** at either re-parsed, re-canonicalised and byte-compared the frame a second time … 18 us a frame". What runs at `:1126` is the replacement at `:829-862`: one `DataView.getUint32`, one `TextDecoder.decode`, one `JSON.parse`, one destructure. The plan withdraws the citation and corrects the headline to ~1.0–1.1 s/min. Its arithmetic closes: 1.66–1.83 µs × 10,000/s = 16.6–18.3 ms/s = 0.996–1.098 s/min, and `tickerCell` (`scenario-registry.ts:256-263`) is `ingressRatePerSecond: 10_000`, `publisherCount: 1` | read at HEAD; arithmetic re-derived |
| **C3 / A5-1 — the census was a hand count** | **Discharged in mechanism.** D now derives the list by scan, makes the meter a **required** parameter on `makeReceiveChannel` and `makeBidiChannel` — I confirmed `makeReceiveChannel(readable, clock)` (`wt.ts:410-413`) has no meter at all and `makeBidiChannel(duplex, clock, busy?)` (`:426-429`) has an optional one, so this is the correct structural fix — and acceptance carries no number. Residual prose defects only, below | read at HEAD |
| **C4 — acceptance bullet 6 refused item C** | **Discharged.** Bullet 6 now permits changed charges "where a seam was mischarged, including seams that produced sealed figures", and names the WT zeros as coming from the seam C fixes. I re-parsed the disk and the three sealed `bulk-one-way/physical` WT arms are exactly `perSession.busyMs: 0` over 2 220.7 / 2 258.3 / 2 447.6 ms windows, beside WS arms at 45.0754 / 54.9424 / 40.0815 | `bun` over `.release-evidence/` |

---

## Facts checked at HEAD

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `result.reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** No meter parameter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `grep '"ingest"'` over `tools/compare` returns `ws.ts:1865`, `wt.ts:924`, and the two `transport.ts` lines that define the kind |
| `acceptUni` has exactly one production caller (`client.ts:883`) | **True.** Every other reference is an implementation or a decorator delegating to `base.acceptUni` |
| The **fanout** server ingests through `receiveMessage` (`server.ts:388-390`) | **False, and the plan does not claim it — the brief does.** `:385-396` is `echoSession`, the Phase-A echo loop. The fanout relay's only inbound paths are `server.ts:1120` (WT) and `:670` (WS) |
| WS server ingests through its message callback (`:670`) | **True**, and `:670-680` puts `handleInboundBytes` + `pump` inside `timed()` |
| The sealed artifact carries **only** server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False, and the plan does not claim it — the brief does.** `:536-542` declares `perSession` **and** `serverAggregate`; `:786-802` validates window finiteness on both |
| No gate constrains `busyMs` | **False as stated; true only of magnitude — and the plan does not claim it.** `arm-measure.ts:229-244` refuses a missing or non-finite `perSession` and a non-positive window; `server.ts:2529-2536` refuses a backwards loop; `render-report.ts:48` caveats at `0.3`. **A zero passes every one of them**, which is why the sealed WT zeros exist |
| W1: `frames.push` (`:1118`) and `relayFrameRoutingFields` (`:1126`) outside `timed()` | **True.** One slip, now named for the third time: the span opens at **`:1119`**, not `:1120`. `:1120` is `relay.handleInboundBytes` *inside* the callback. W1 and item A both repeat it |
| W1: delivery-side `:1027` is charged, so there is no larger sibling site | **True**, re-verified: `relayFrameRoutingFields(bytes)` at `:1027` runs inside `sink.trySend` → `relay.pump()`, and every relay entry point in `server.ts` is inside `timed()` |
| W1: `onRelayWork` wired at `:3036`, forwarded at `:1203` | **True.** `onRelayWork: (elapsedMs) => loop.record(elapsedMs)`. Production, Phase B |
| W2: `sink-worker.ts:227` charges suspension; both arms replace `loopUtilization` wholesale | **True on all three.** `measureRead` (`:222-229`) accumulates across the `await`; `ws-worker.ts:298-301` and `wt-stream-sink.ts:345-348` both override the key |
| W3: `ws-worker.ts:11-17` — no worker thread | **True**, verbatim |
| W4: `:1569` Node branch, `:1251` WHATWG branch through `:194-198`; the expensive part is the turn, not the body | **True**, and the decomposition is right: `getReader` (`:183`), the `Promise` + `setTimeout` (`:186-192`), the `race` (`:199`), `clearTimeout` + `releaseLock` (`:200-203`) |
| W5: `bin/compare-controller.ts:804`, `ws-worker.ts:228`, `wt-stream-sink.ts:278` are real seams | **True.** All three at HEAD |
| W5: "the real counts are six and eight" | **Six is right; eight is not, and D forbids both.** See P1 |
| W6: WS `read`/`acceptUni` are "transport work already charged inside `ws.ts:1865`" | **False, and now load-bearing.** See A6-1 |
| W7: `render-report.ts:233` mislabels both scopes; `transport.ts:131-136` says "this server" | **True on both**, and `:233` is an independently hand-copied string, not the exported constant |
| W8: `wt.ts:1655-1664` can drop a late charge; conservation and monotonicity hold | **True.** `onSessionClose` deletes from the live set before accumulating and no-ops on a repeat; `serverLoopUtilization` (`:1666-1678`) sums closed + live. The residual hazard is silent loss, which is what W8 says |
| W9: `65 / 1250` is a fixture constant, present in sealed artifacts | **True**, in `cohort-fixture-signing.ts` and on disk |
| Acceptance 6: four sealed WS values | **True.** 26.3125, 40.0815, 45.0754, 54.9423828125 (the plan's 54.9424 is that rounded) |
| Baseline suites | **29 pass / 0 fail**, reproduced |

---

## Blocking findings

### A6-1. Item C charges a turn on WebTransport whose WebSocket twin it leaves uncharged and mislabels — I measured the twin

The plan's reshaping rests on one sentence, in *The correction that reshapes the plan*:

> Every part of the caller turn is synchronous loop time, in scope by the published
> definition, and **charged in full on the WebSocket side inside `ws.ts:1865`**.

W6 says the same thing as a finding: "`WsChannel.read` and `WebSocketAdapter.acceptUni` are
transport work already charged inside `ws.ts:1865`."

**Both halves of the first clause are right and the last clause is wrong.** `ws.ts:1865`
charges the **arrival** turn — socket message in, frame decode, channel construction
(`:1988-1996`), `tryPush` (`:1999-2002`); I re-confirmed by scan that the only method
declaration between `:1870` and `:2015` is `dispatchSocketMessage` at `:1870`, so the whole
enqueue is inside the span. The WebTransport counterpart of *that* turn is the arrival body
at `wt.ts:194-198`, which R5 charged at 0.06–0.22 ms.

The WebSocket counterpart of the turn **item C now charges** is the consumer's dequeue turn:
`WsChannel.read` (`ws.ts:2146-2162`) and `WebSocketAdapter.acceptUni` (`:1644-1654`), both of
which call `waitForQueue` (`ws.ts:472-512`). Read it beside `readChunk`:

| WT `readChunk`, WHATWG branch (`wt.ts:182-203`) — **item C charges this** | WS `waitForQueue` (`ws.ts:472-512`) — **item C leaves this uncharged** |
| --- | --- |
| `readable.getReader()` | `new AbortController()`; `queue.waitForItem({signal})` |
| `new Promise` + `setTimeout(reject, remaining)` | async IIFE + two `await Promise.resolve()` + `clock.sleep(remaining)` |
| `await Promise.race([readPromise, timeoutPromise])` | `await Promise.race([read, timer])` |
| `finally { clearTimeout(timer); reader.releaseLock() }` | `finally { controller.abort() }` |

The same shape, per call, on the same interface, driven by the same production consumer
(`client.ts:883`). **So I metered it**, on the real `WebSocketAdapter` over the repo's own
fake socket, at the plan's own workload — 1600 chunks of 64 KiB, interleaved receive/read so
the source never makes the reader wait, `bun` 1.3.14:

| Quantity, per 1600 × 64 KiB | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| WS arrival turn — **charged today** at `ws.ts:1865` | 37.4 ms | 36.4 ms | 34.4 ms |
| WS consumer read turn — **uncharged, and left uncharged by this plan** | 11.5 ms | 9.6 ms | 8.2 ms |
| …of which the **synchronous prefix alone**, before the `await` resolves | 5.02 ms | 4.94 ms | 3.72 ms |
| WT caller turn — **the quantity item C adds** (critic r5, same workload) | 5.76 ms | 8.27 ms | — |

Per-call cost is flat across N — 6.08 / 5.73 µs at N=400, 5.35 / 5.56 µs at N=1600, 5.11 /
4.89 µs at N=3200 — so this is linear per-call work, not timer accumulation.

**The consequence, if the plan is executed exactly as written.** On the read seams, WT ends
up charging its caller turn (5.8–8.3 ms) and WS charging none of its own (8.2–11.5 ms, of
which at least 3.7–5.0 ms is unambiguously synchronous). The remaining asymmetry is not
merely unclosed — **it is inverted and larger than the one being fixed**, and the census
records the uncharged side as *charged-at-another-seam* naming `ws.ts:1865`, a span that does
not execute any of that work. Acceptance bullet 3's check on that cell — "naming a span that
actually exists" — passes on a true statement about the span and a false statement about the
row. That is precisely the placeholder-evidence shape this campaign exists to remove: a field
that reads as evidence, has a validator, and has no producer.

**This is new at r6 and I am not re-litigating r5.** At r5 item C charged 0.2 ms of arrival
body, so the uncharged WS dequeue was the same order and the mislabel was a truthfulness nit
(the critic's S3, correctly ranked non-blocking; I accepted W6 outright). R6's expansion of
item C is exactly what promotes it: the moment WT starts charging its caller turn, the WS
caller turn becomes the largest uncharged thing on the read path and the largest false entry
in the census.

**Fix — and R6 has already unlocked the cheaper of the two.**

1. *Preferred, and now available for the first time:* **extend item C to `ws.ts:2146` and
   `:1644`**, charging the WS consumer turn with the same `open`/`pause`/`resume`/`close`
   discipline. This is what the plan's own Objective — "One charging rule at every seam and
   every producer" — requires, and R6's rewritten acceptance bullet 6 already permits a
   changed charge on a mischarged seam provided it is reported. Three things make it safe and
   I checked all three: the dequeue runs on a different turn from `:1865`, so nothing
   double-counts; `LoopBusyMeter`'s depth guard (`transport.ts:212-227`) would suppress it
   even if they nested; and the same discipline is already in use on WS egress at
   `ws.ts:1186` and `:1483`, so this is a pattern the file already carries. It supersedes the
   sealed WS arms as well as the WT zeros — say so, and say the measured size. The critic's
   S3 objection ("charging it is not the fix: that would add to the sealed 26.3125") was
   written against r5's bullet 6 and is superseded by R6's own rewrite of it.
2. *Acceptable alternative:* leave the WS turn uncharged, **correct W6 and the reshaping
   sentence**, and state in the report and the census that the published receive figure
   excludes the consumer dequeue turn on both transports on WS and includes it on WT, with
   the measured size of the exclusion. This requires the fifth census cell in A6-2.

Either way, the sentence "charged in full on the WebSocket side inside `ws.ts:1865`" must go,
because the plan's principal work item is justified by it.

### A6-2. The four-cell taxonomy has no honest cell for "transport work, deliberately uncharged"

Item D's cells are: *ingest*, *egress*, *charged-at-another-seam naming a span that actually
exists*, and *not-transport-work with a reason*. Three seams at HEAD are transport work,
uncharged, and not charged at any other seam:

- `ws.ts:2146` `WsChannel.read` and `ws.ts:1644` `WebSocketAdapter.acceptUni` — 8.2–11.5 ms
  per 1600 reads, measured above.
- `wt.ts:1242` / `:1566` `acceptUni`, whose caller turn is `readFromStream`
  (`wt.ts:468-495`) — `getReader`, `setTimeout`, `Promise.race`, `releaseLock`, the identical
  shape, taking no meter. **Item C names only the "read seams" and does not cover it.**

None of the four cells can hold these truthfully. Cell three is false (the named span does
not execute the work). Cell four is false (accepting a stream and dequeuing a chunk are
transport work by any reading of `SESSION_LOOP_BUSY_MS_DEFINITION`). An implementer following
W6 will use cell three, and the acceptance test cannot catch it because the span it names
does exist.

**Fix — one cell and one clause.** Add a fifth cell: *transport work, deliberately uncharged,
with the reason and the measured size*. Require that the size be a real measurement, not an
estimate, so the cell cannot become a second placeholder. And say whether WT `acceptUni` is
in item C's scope; if it is not, it belongs in that cell with its size.

### A6-3. The scan's root set is unspecified, so acceptance bullet 3 is satisfiable by a narrow scan

D says "A scan over the adapter surface produces the seam list", and acceptance says "Every
seam the scan finds has a row". **"The adapter surface" is not defined, and the answer moves
with it** — I ran the scan three ways at HEAD:

| Scope | `read` seams found |
| --- | --- |
| `ReceiveChannel`/`BidiChannel` implementations under `adapters/` | 7 — `ws.ts:2146`, `wt.ts:417`, `wt.ts:454`, `ws-worker.ts:203`, `ws-worker.ts:228`, `wt-stream-sink.ts:253`, `wt-stream-sink.ts:278` |
| …plus the `runSinkPump` read callbacks | 11 — adds `ws-worker.ts:162`, `:191`, `wt-stream-sink.ts:191`, `:241` |
| `acceptUni`, whole tree minus tests | 6 — `ws.ts:1644`, `wt.ts:1242`, `wt.ts:1566`, `ws-worker.ts:255`, `wt-stream-sink.ts:305`, **`bin/compare-controller.ts:804`** |

The site r5 refused over — `bin/compare-controller.ts:804` — **is outside `adapters/`**. A
scan rooted at "the adapter surface", read literally, misses it, the table has no row for it,
and the completeness test passes. That reproduces the exact r5 failure through the mechanism
installed to prevent it.

**Fix — one sentence.** Name the scan's roots explicitly (`tools/compare/adapters/` **and**
`tools/compare/bin/`, or the whole of `tools/compare` minus `*.test.ts`), and say that
widening the roots is the only sanctioned way to change what the table must contain.

---

## Answers to the questions the brief asked

**Is the objective the right one, or should the metric be defined differently?** Right, and I
re-endorse it a third time. `SESSION_LOOP_BUSY_MS_DEFINITION` measures JavaScript event-loop
time on transport work and explicitly excludes native, kernel and other-thread time. WS frames
in JS and WT frames in the addon, so a 170 / 48.5 ms split is the metric working. Charging the
read path is a **completeness** repair, not a definition repair, and R6's reshaping of item C
makes it the right completeness repair for the first time: the caller turn is loop time by the
definition's own words, and pausing across the `await` is the definition's own rule. Nothing
in the plan contradicts the published definition. **But completeness is a property of the set
of seams, not of one seam**, and A6-1 is the plan applying the correct rule to one side of a
symmetric pair.

**Does the scope cover every seam that could carry the same defect?** On the relay, yes, and I
re-proved it rather than inheriting it: the delivery-side `relayFrameRoutingFields` at `:1027`
runs inside `sink.trySend` → `relay.pump()`, inside `timed()`. On the read path, **no** — it
misses the WS consumer turn (A6-1) and WT `acceptUni`/`readFromStream` (A6-2).

**Is the work-item-2 surface enumeration sufficient to prevent a third instance?** Not yet,
for two independent reasons. The scan's roots are undefined and the obvious reading excludes
the very file r5 refused over (A6-3); and the cell set cannot express the truth about three
live seams, so a row can be complete, validated, and false (A6-2). The required meter
parameter is the strongest thing in the plan and it does hold for construction sites of
`makeReceiveChannel`/`makeBidiChannel` — it does not reach `ws.ts:2146`, `ws.ts:1644` or
`readFromStream`, which are not constructed through either factory.

**Is the acceptance criterion falsifiable as written?** Bullets 1, 2, 4, 6, 7 and 8 are,
cleanly. Bullet 4 in particular is a real improvement: a discriminating test with injected
waiting against a real clock is falsifiable in a way the deleted ceiling was not, and I
verified the plan's reason for excluding `pricedClock` is sound (`readChunk` uses the real
`setTimeout`, so a fake clock that only advances on `sleep` and on seam notes sees nothing).
Say the injected wait and the workload in the plan so the "materially different" bar is
pre-stated rather than chosen after the first run. Bullet 3 is falsifiable only once the scan
roots are named (A6-3), and it certifies a row-set that cannot state the truth (A6-2).

**Anything the plan should say and does not.**

- **The Node branch's caller turn is a different shape and C's enumeration does not describe
  it.** C names "`getReader`, the timer setup and teardown, the race and the release" — all
  WHATWG. On the Node branch (`wt.ts:205-253`) the synchronous caller-turn work is the
  `new Promise` executor: a `setTimeout`, three `once` registrations, and the nudge. Its
  teardown runs inside `cleanup()` **in the arrival turn**, not in a `finally` on the caller's
  turn. So `open`/`pause`/`resume`/`close` must be placed differently in the two branches, and
  an implementer reading C's single sentence will not know that.
- **`seam = chunk !== null` is classified in D and instructed nowhere.** One clause in C —
  "pass `seam = chunk !== null`, as `wt.ts:924` does for `envelope !== null`" — closes it.
  It matters: `open`'s default is `seam = true` (`transport.ts:207`), so a defaulted read span
  advances a fake clock on the EOF read that returns `null`.
- **W8 and C are coupled and listed apart.** C is what creates the post-close arrival W8 warns
  about: a read in flight at close resolves into a meter nothing reads. Say that C must close
  its span before the session's own close path, or that the late charge is accepted and
  bounded.
- **`wt.ts:239-250` is live on a duck-typed stream.** The nudge is unreachable on a real node
  `Readable` because `readable.once("data", onData)` at `:236` sets `readableFlowing` true
  before the guard is evaluated — but `readable.once?.` is optional-chained, so a stream
  without `.once` reaches it. If C charges the caller turn, this body is inside it; say so.
- **B's correctness on the WT arm depends on C landing.** `wt-stream-sink`'s base is the WT
  primary, whose only ingest span is the envelope pump at `wt.ts:924`. For a channel-read
  workload the restored base meter charges nothing until C. An implementer who does B first,
  sees the new zero-guard test red, and "fixes" it by keeping the suspension charge has undone
  the plan.
- **Say B deletes the override rather than recombining terms.** Both arms compute `windowMs`
  from `sessionOpenedAtMs` (`ws-worker.ts:300`, `wt-stream-sink.ts:347`) while `LoopBusyMeter`
  computes it from meter construction (`transport.ts:167-168`). A base-meter numerator over a
  worker-computed denominator is a unit mismatch feeding the `0.3` detector at
  `render-report.ts:48`. Dropping the `loopUtilization` key and letting `...metrics` through
  has no mismatch. I have asked for this in five reviews; it is one clause.
- **C implies a type change the plan does not name.** Fixing `wt.ts:94` and removing the
  `as unknown as Readable` cast at `:1252` means `makeReceiveChannel(readable: Readable, …)`
  no longer accepts that site; the honest repair is a union there and at
  `readChunk(readable: any, …)` (`:178`). Typing that parameter makes the two branches visible
  to the compiler instead of to a duck-type check — the same structural argument as the
  required meter, which the plan has now accepted.
- **F leaves the definition hand-copied.** `render-report.ts:233` is an independent string
  literal, not the exported constant. F says the two must "agree"; make them **unable** to
  disagree by importing `SESSION_LOOP_BUSY_MS_DEFINITION` into the report legend.
- **F does not say what the corrected definition asserts.** W7 names the defect as *role*
  ("this server" for a figure that is sometimes the client's). Say the fix: make the constant
  role-neutral and carry the role as a labelled property of each attested figure, so
  `perSession` and `serverAggregate` each name whose loop they measure.
- **Two docstrings cite the reading B deletes** — `server.ts:556-558` and `:1256-1257` both
  name `adapters/sink-worker.ts:227`. They will be stale the moment B lands.

**Anything the plan says that the code does not support.**

- **P1. W5 states counts, and D forbids counts, and one of the counts is wrong.** W5 says
  "the real counts are six and eight"; D says "No count appears in the plan or in acceptance."
  The plan contradicts itself in the space of five lines. Six checks out. **Eight does not**:
  the transport-channel `read` surface is 7, and 11 once the `runSinkPump` read callbacks that
  W5's own two additions sit beside are included. There is no scope under which it is 8. The
  fix is to strike both numbers from W5, which is what D already demands — and the fact that
  the corrected hand count is itself wrong is the plan's own thesis proving itself.
- **P2. The `timed()` span opens at `server.ts:1119`, not `:1120`.** `:1120` is
  `relay.handleInboundBytes` inside the callback. Named in my r5 and in the critic's r5 S1;
  W1 and item A both still say `:1120`.
- **P3.** `pricedClock` begins at `loop-busy.test.ts:63`, not `:64`. Trivial, listed for
  completeness.

**On the brief itself.** Three claims the brief asked me to check are not supported by the
code, and in each case **the plan is right and the brief is wrong** — I record this because
the brief asked me to confirm nothing new is asserted that the plan does not contain: the
fanout server does **not** ingest through `receiveMessage` (`server.ts:388-390` is
`echoSession`, Phase A; fanout ingest is `:1120` and `:670`); the sealed artifact does **not**
carry only server figures (`artifact-builder.ts:536-542` declares `perSession` and
`serverAggregate`, `:786-802` validates both); and gates **do** constrain `busyMs`
structurally (`arm-measure.ts:229-244`, `server.ts:2529-2536`, `render-report.ts:48`) — what
no gate constrains is its magnitude, which is why a zero seals. The plan asserts none of the
three.

---

## What would make this APPROVED

1. Resolve the WebSocket half of the seam item C fixes: either extend C to `ws.ts:2146` and
   `:1644` under the same `pause`/`resume` discipline, reporting the changed WS charge as
   bullet 6 now permits — or leave it uncharged, delete the "charged in full on the WebSocket
   side inside `ws.ts:1865`" justification, correct W6, and state the exclusion and its
   measured size in the report. My numbers are 8.2–11.5 ms per 1600 × 64 KiB, synchronous
   prefix 3.7–5.0 ms (A6-1).
2. Add the fifth census cell — *transport work, deliberately uncharged, with reason and
   measured size* — and place `ws.ts:2146`, `ws.ts:1644` and WT `acceptUni` /
   `readFromStream` in it, or bring the latter into C's scope (A6-2).
3. Name the scan's roots so `bin/compare-controller.ts:804` cannot fall outside them (A6-3).
4. Strike the counts from W5, which D already forbids and one of which is wrong (P1), and fix
   `:1120` → `:1119` (P2).

Items A, B, E and F are executable as written. The four r5 blockers are genuinely discharged,
the reshaping of C is the right reshaping, and the deletion of the ceiling in favour of a
discriminating test is the single best change in six revisions. What remains is that the plan
applies its own corrected rule to one side of a symmetric pair, and I could only see it
because R6 made the quantity large enough to measure.
