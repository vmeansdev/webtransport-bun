CHANGES REQUIRED

# Critic review (revision 6) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed by me, before reading) | `187a73d3238f29ed98205777e181def3cb098c1a07c3409db2a52fc406f11239` |
| Declared SHA-256 | identical — verified first |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | `git status --porcelain` → untracked evidence and review files only; **0 tracked modifications**. Git used read-only. Only this artifact written |
| Prior artifacts read | my r1–r5; Architect r6 |
| Method | every `file:line` the plan cites read at HEAD; `bun test ./tools/compare/adapters/loop-busy.test.ts ./tools/compare/adapters/read-path-adapters.test.ts` → **29 pass / 0 fail**; the `acceptUni` and `read` surfaces enumerated by grep; every sealed `bulk-one-way/physical` artifact re-parsed off disk; **and the WebSocket receive path metered on the real `WebSocketAdapter` at the plan's own workload — including against the adapter's own `LoopBusyMeter`, which is what decides this review** |

**All four r5 blockers are discharged.** I confirm each by execution below. Item C is now
the right shape and uses a discipline that exists; the inverted ceiling is deleted in favour
of a test that can actually discriminate, and the `pricedClock` exclusion is correct and
necessary; the 18 µs citation is withdrawn against the right reading of the docstring; the
census is derived by scan with the meter made a required parameter; and acceptance bullet 6
no longer refuses the plan's principal work item.

**It is refused on one ground, which I proved by execution and which the plan's central
justifying sentence asserts.** The plan says the caller turn item C charges on WebTransport
is *"charged in full on the WebSocket side inside `ws.ts:1865`"* (and W6 says the same as a
finding). **It is not.** I drove 1600 × 64 KiB — 104,857,600 bytes, the plan's own workload —
through the real `WebSocketAdapter` and read the adapter's own meter: the session's
`busyMs` delta is **31.8 / 35.8 / 37.4 ms** across three runs, which tracks the arrival turn
(32.1 / 36.2 / 37.8 ms) and contains **none** of the **7.6 / 7.6 / 8.0 ms** the consumer read
turn costs. The seam item C now charges on WT has a WebSocket twin that is uncharged and, on
my bench, **larger than the WT quantity being charged**. Executed as written, the plan applies
its corrected rule to one side of a symmetric pair and records the other side, in its own
census, as charged at a span I have just measured to charge none of it.

I reached this independently of the Architect and by a stronger instrument — his timer
decomposition, my meter delta — and it corroborates his A6-1. I also correct him: he
understates the asymmetry.

---

## The four r5 blockers, discharged

| r5 blocker | Status | How I checked at HEAD |
| --- | --- | --- |
| **C1a — item C charged ~3% of the WT read path** | **Discharged.** C now charges the whole caller turn with `open`/`pause`/`resume`/`close`. The discipline is real and cited correctly: `transport.ts:117-118` is "**No span crosses an `await`.** A span is paused before the loop yields and resumed when it comes back"; `:196-198` is "The caller pauses it before every `await` and closes it in a `finally`"; `LoopBusySpan` (`transport.ts:139-145`) exports `pause`, `resume`, `close` | read at HEAD |
| **C1b — the 5 ms ceiling was inverted; `pricedClock` is blind** | **Discharged, and the exclusion is sound for a reason I re-derived.** `pricedClock` (`loop-busy.test.ts:63-96`) advances `now` only in `sleep` and in `noteBusySlice`/`noteEgressSlice`. `LoopBusyMeter.open` sets `spanStartMs` **before** firing the note (`transport.ts:212-219`), so each `open` charges exactly one `ingestMs` regardless of what happens across the `await` — the honest and the await-spanning shapes are arithmetically identical under it. And `readChunk` uses the real `setTimeout` (`wt.ts:187`, `:206`), not `clock.sleep`, so no injected wait is visible either. E's "must not be used" is not a preference; it is forced | read at HEAD, arithmetic traced |
| **C2 — the 18 µs prices `codec.decode`** | **Discharged correctly.** `server.ts:812-824` reads "running **`codec.decode`** at either re-parsed, re-canonicalised and byte-compared the frame a second time … 18 us a frame against 1.1 us for the stream write it chose". What runs at `:1126` is the replacement at `:827-864`: `DataView.getUint32`, one `TextDecoder.decode`, one `JSON.parse`, one destructure. The corrected arithmetic closes: 1.66–1.83 µs × 10,000/s = 16.6–18.3 ms/s = **0.996–1.098 s/min**, and `tickerCell` (`scenario-registry.ts:256-263`) is `ingressRatePerSecond: 10_000`, `publisherCount: 1`, `fanout: 100`. The error originated with my r4 and I record the correction against myself for the second time | read at HEAD |
| **C3 — the census was a hand count** | **Discharged in mechanism.** D derives by scan; `makeReceiveChannel(readable, clock)` (`wt.ts:410-413`) takes no meter and `makeBidiChannel(duplex, clock, busy?)` (`:426-429`) an optional one, so making both required is the correct structural fix; acceptance carries no number. Residual defects are the scan's root set (K3) and W5's surviving counts (K4) | read at HEAD |
| **C4 — acceptance bullet 6 refused item C** | **Discharged.** Bullet 6 permits changed charges "where a seam was mischarged, including seams that produced sealed figures". Re-parsed off disk: the three `bulk-one-way/physical` WT arms are `perSession.busyMs` exactly `0` over 2258.33 / 2220.75 / 2447.59 ms, beside WS arms at 54.9423828125 / 45.075439453125 / 40.08154296875, with a fourth at 26.3125 — the plan's four values, exact | `bun` over `.release-evidence/` |

---

## Facts checked at HEAD

Every citation the plan makes, and every claim the brief named.

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `result.reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** No meter parameter; both construction sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `grep '"ingest"'` over `tools/compare`, tests excluded, returns exactly `ws.ts:1865`, `wt.ts:924`, and the two `transport.ts` lines that define the kind |
| `acceptUni` has exactly one production caller (`client.ts:883`) | **True.** Every other non-test reference is an implementation or a decorator delegating to `base.acceptUni` |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) | **False — and the plan does not claim it; the brief does.** `:385-396` is `echoSession`, the Phase-A echo loop. The fanout relay's only inbound paths are `:1120` (WT) and `:670` (WS) |
| WS server ingests through its message callback (`server.ts:670`) | **True**, and `:670-680` puts `handleInboundBytes` + `pump` inside `timed()` |
| Sealed artifact carries only server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False — and the plan does not claim it; the brief does.** `:536-542` declares `perSession` **and** `serverAggregate`; `:786-802` validates window finiteness on both |
| No gate constrains `busyMs` | **False as stated; true only of magnitude — and the plan does not claim it.** `arm-measure.ts:229-244` refuses a missing or non-finite `perSession` and a non-positive window; `artifact-builder.ts:786-802` refuses a degenerate window on both scopes; `server.ts:2529-2536` refuses a backwards loop; `render-report.ts:48` caveats at `0.3`. **A zero passes every one of them**, which is why the sealed WT zeros exist |
| W1: `frames.push` (`:1118`) and `relayFrameRoutingFields` (`:1126`) outside `timed()` | **True.** One slip, now named for the third time across two reviewers: the span opens at **`:1119`**, not `:1120`. `:1120` is `relay.handleInboundBytes` *inside* the callback. W1 and item A both still say `:1120` |
| W1: the delivery-side call at `:1027` is charged, so there is no larger sibling | **True**, re-verified: it runs inside `sink.trySend` → `relay.pump()`, and every relay entry point in `server.ts` is inside `timed()`. At `fanout: 100` a missed delivery-side site would have been 100× the headline |
| W1: `onRelayWork` wired at `:3036`, forwarded at `:1203` | **True.** Production, Phase B |
| W2: `sink-worker.ts:222-229` `measureRead` charges suspension; both arms replace `loopUtilization` wholesale | **True on all three**, verbatim (`ws-worker.ts:298-301`, `wt-stream-sink.ts:345-348`) |
| W3: `ws-worker.ts:11-17` — no worker thread | **True**, verbatim |
| W4: `:1569` Node branch, `:1251` WHATWG branch; the expensive part is the turn, not the body | **True**, and the decomposition is exact: `getReader` (`:183`), `Promise` + `setTimeout` (`:186-192`), `race` (`:199`), `clearTimeout` + `releaseLock` (`:201-202`) |
| W4: `wt.ts:94` misdeclares and `:1252` casts | **True.** `readonly incomingUnidirectionalStreams: ReadableStream<Readable>` against `readable as unknown as import("node:stream").Readable` |
| W5: `bin/compare-controller.ts:804`, `ws-worker.ts:228`, `wt-stream-sink.ts:278` are real seams | **True.** All three at HEAD; `:804` is a full session decorator, `acceptUni: (deadlineMs) => base.acceptUni(deadlineMs)` |
| W5: "the real counts are six and eight" | **Six is right. Eight matches no scope, and D forbids both.** See K4 |
| W6: WS `read`/`acceptUni` are "transport work already charged inside `ws.ts:1865`" | **False, and I refuted it against the meter itself.** See K1 |
| W7: `render-report.ts:233` mislabels both scopes; `transport.ts:131-136` says "this server" | **True on both.** `:233` is an independently hand-copied string literal |
| W8: `wt.ts:1655-1664` can drop a late charge; conservation and monotonicity hold | **True, re-verified rather than inherited.** `onSessionClose` (`:1655-1664`) deletes from the live set before accumulating and no-ops on a repeat; `serverLoopUtilization` (`:1666-1678`) sums closed + live; `LoopBusyMeter.totalMs` only ever grows (`transport.ts:227`, `Math.max(0, …)`). The residual hazard is silent loss, which is what W8 says |
| W9: `65 / 1250` fixture constant; `c7fafa52` carries a real `1 / 977` | **True, exactly.** Three sealed artifacts carry `serverAggregate {busyMs: 65, windowMs: 1250}`; `c7fafa52`'s carries `{1, 977}` |
| Acceptance 6: four sealed WS values | **True, re-parsed** (54.9423828125 rounds to the plan's 54.9424) |
| Baseline suites | **29 pass / 0 fail**, reproduced |

---

## Blocking findings

### K1. The sentence item C is justified by is false, and I proved it against the adapter's own meter

The plan's reshaping rests on one clause, in *The correction that reshapes the plan*:

> Every part of the caller turn is synchronous loop time, in scope by the published
> definition, and **charged in full on the WebSocket side inside `ws.ts:1865`**.

W6 restates it as a finding: "`WsChannel.read` and `WebSocketAdapter.acceptUni` are transport
work already charged inside `ws.ts:1865`."

**`ws.ts:1865` charges the arrival turn, not the caller turn.** The span is
`this.busy.measure("ingest", …)`, which closes in a `finally` **synchronously**; the whole
enqueue is inside it — frame decode, channel construction (`ws.ts:1988-1996`), `tryPush`
(`:2001-2002`, `:2203`). The WebTransport counterpart of *that* turn is the arrival body at
`wt.ts:194-198`, which r5 metered at 0.06–0.22 ms. The WebSocket counterpart of the turn
**item C now charges** is the consumer's dequeue turn: `WsChannel.read` (`ws.ts:2146-2162`)
and `WebSocketAdapter.acceptUni` (`ws.ts:1644-1654`), both through `waitForQueue`
(`ws.ts:471-510`) — `new AbortController()`, `queue.waitForItem({signal})`, an async IIFE with
two `await Promise.resolve()` and `clock.sleep(remaining)`, `await Promise.race([read, timer])`,
`finally { controller.abort() }`. The same shape as `readChunk`, per call, on the same
interface, driven by the same production consumer (`client.ts:883`).

**I did not argue this. I measured it, and then I measured it against the meter.** Real
`WebSocketAdapter`, real `WsSession`, the repo's own fake server runtime, one inbound uni
channel, 1600 `channel-data` frames of 64 KiB — 104,857,600 bytes delivered and read, the
plan's own workload — interleaved so the reader never waits on the source; `bun` 1.3.14,
warmed, three runs:

| Quantity, per 1600 × 64 KiB | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| WS arrival turn, inside `ws.ts:1865` | 37.76 ms | 36.17 ms | 32.15 ms |
| **`session.loopUtilization.busyMs` delta — what the adapter actually charges** | **37.36 ms** | **35.81 ms** | **31.82 ms** |
| WS consumer read turn (`read()` call → value in hand) | 7.99 ms | 7.56 ms | 7.65 ms |
| …of which the synchronous prefix, before the first `await` yields | 3.82 ms | 3.46 ms | 3.53 ms |
| `acceptUni`, whole call | 0.010 ms | 0.010 ms | 0.007 ms |

**The meter delta tracks the arrival turn to within 1.1% and contains none of the consumer
turn.** Had `waitForQueue` been inside the span, `busyMs` would have read ~40–45 ms. It does
not. W6 is refuted by the implementation of the very definition the plan is defending.

**And the uncharged twin is bigger than the quantity item C charges.** I metered
`readChunk`'s WHATWG branch — transcribed verbatim from `wt.ts:182-203` — against a **real**
`ReadableStream`, same methodology, same workload, same 104,857,600 bytes:

| WT caller turn, per 1600 × 64 KiB | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| whole turn (`readChunk` call → value in hand) | 3.76 ms | 2.77 ms | 2.80 ms |
| synchronous prefix | 1.83 ms | 1.18 ms | 1.17 ms |

(With a hand-rolled fake reader instead of a real `ReadableStream` it collapses to 1.0–1.5 ms;
`getReader`/`releaseLock` on the real object are most of the cost. My transcription is not the
routed path, so treat it as a lower bound; r5's disciplined, meter-carrying figure at the same
workload was 5.76–8.27 ms. **Either bound is at or below the WS twin.**)

**So the Architect understates it.** He reports the WS twin as "of the same or greater size"
against r5's 5.76–8.27 ms. On my bench the WS consumer turn (7.6–8.0 ms) is **2–3×** the WT
caller turn (2.8–3.8 ms). The plan does not merely leave a comparable remainder uncharged; on
the read seams it would charge the smaller half of a symmetric pair.

**The consequence, priced against the sealed numbers rather than in the abstract.** The sealed
`bulk-one-way/physical` WS arms read 26.3125 / 40.0815 / 45.0754 / 54.9424 ms, and my measured
WS arrival turn at the plan's own workload is 32–38 ms — the same quantity. The uncharged
consumer turn is therefore **roughly a fifth to a third of the published WS figure**, and it
stays off the books under this plan while WT's structural twin comes on. That is not "parity
is not an objective"; the plan's own **Objective** is "One charging rule at every seam and
every producer", and this is two rules at one seam.

**The census makes it worse than an omission.** Under item D, `ws.ts:2146` and `ws.ts:1644`
would be filed under *charged-at-another-seam naming a span that actually exists*, naming
`ws.ts:1865`. Acceptance bullet 3 validates that the named span exists — and it does. The row
would be complete, validated, and false, about a quantity I can measure at 7.6–8.0 ms. That is
the placeholder-evidence family this campaign exists to remove: a field that reads as evidence,
has a validator, and has no producer.

**This is new at r6 and I am not re-litigating r5.** At r5 item C charged 0.2 ms of arrival
body, the WS dequeue was the same order, and I ranked the mislabel non-blocking (S3). R6's
expansion of item C is exactly what promotes it. **My r5 fix advice for S3 is also superseded**:
I wrote "charging it is not the fix: that would add to the sealed 26.3125" — bullet 6 as R6
rewrote it now permits precisely that, provided it is reported.

**Fix — either, in one paragraph.**

1. *Preferred.* Extend item C to `ws.ts:2146` and `ws.ts:1644` under the same
   `open`/`pause`/`resume`/`close` discipline. I checked the three things that make it safe:
   the dequeue runs on a different turn from `:1865`, so nothing double-counts; the meter's
   depth guard (`transport.ts:208-227`) would suppress it even if they nested; and the same
   discipline is already used on WS egress (`ws.ts:1186`, `:1483`). Then say in **Risks** that
   the sealed WS arms are superseded too — the plan's Risks section currently owns only the WT
   change, and bullet 6 permits the WS one but Risks does not mention it.
2. *Acceptable.* Leave it uncharged, **delete the "charged in full on the WebSocket side inside
   `ws.ts:1865`" clause, correct W6**, and state in the report and the census that the
   published receive figure excludes the consumer dequeue turn on WS and includes it on WT,
   with its measured size. This requires the cell in K2.

Either way the clause must go, because the plan's principal work item is justified by it.

### K2. No cell in the four-cell taxonomy can state the truth about three live seams

Item D's cells are *ingest*, *egress*, *charged-at-another-seam naming a span that actually
exists*, and *not-transport-work with a reason*. Given K1, three seams at HEAD are transport
work, uncharged, and charged at no other seam:

- `ws.ts:2146` and `ws.ts:1644` — 7.6–8.0 ms per 1600 reads, measured above.
- WT `acceptUni` (`wt.ts:1242`, `:1566`), whose caller turn is `readFromStream`
  (`wt.ts:467-493`): `stream.getReader()`, `setTimeout`, `Promise.race`, `releaseLock` in a
  `finally` — the identical shape, taking no meter. **Item C says "read seams" and does not
  reach it.** I measured it at 0.007–0.010 ms per accept, so in a one-stream bulk arm this is
  a truthfulness defect, not a magnitude one; in a many-stream arm it is both.

Cell three is false for all three (the named span executes none of the work, and I have the
meter delta to prove it for the WS pair). Cell four is false for all three (accepting a stream
and dequeuing a chunk are transport work by any reading of
`SESSION_LOOP_BUSY_MS_DEFINITION`). An implementer following W6 will use cell three and the
acceptance test cannot catch it.

**Fix.** Add a fifth cell — *transport work, deliberately uncharged, with the reason and the
measured size* — require the size to be a real measurement so the cell cannot become the next
placeholder, and say explicitly whether WT `acceptUni`/`readFromStream` is inside item C's
scope or inside that cell.

### K3. The scan's root set is unstated, and the obvious reading excludes the site r5 refused over

D says "A scan over the adapter surface produces the seam list"; acceptance bullet 3 says
"Every seam the scan finds has a row." **"The adapter surface" is not defined, and the answer
moves with it.** `bin/compare-controller.ts:804` — which W5 itself names, and which r5 refused
over — is **outside `adapters/`**. I confirmed it at HEAD: a full session decorator on the
production controller path carrying `acceptUni`, alongside `openUni`, `openBidi`, `acceptBidi`
and a `receiveMessage` overlay.

A scan rooted at `tools/compare/adapters/`, which is the literal reading, misses it; the table
has no row for it; the completeness test passes. That reproduces the exact r5 failure through
the mechanism installed to prevent it, and it is the vacuity route the brief asked me to hunt.
The required-meter change is the strongest thing in the plan, but it reaches only construction
sites of `makeReceiveChannel`/`makeBidiChannel` — not `ws.ts:2146`, `ws.ts:1644`,
`readFromStream`, or `:804`.

**Fix — one sentence.** Name the roots (`tools/compare/adapters/` **and** `tools/compare/bin/`,
or all of `tools/compare` minus `*.test.ts`), and say that widening them is the only sanctioned
way to change what the table must contain.

### K4. W5 states counts that D forbids, and one of them is wrong — mine

W5: "the real counts are six and eight." D: "**No count appears in the plan or in
acceptance.**" The plan contradicts itself in five lines.

Six is right; I enumerated `acceptUni` at HEAD, tests excluded: `ws.ts:1644`, `wt.ts:1242`,
`wt.ts:1566`, `ws-worker.ts:255`, `wt-stream-sink.ts:305`, `bin/compare-controller.ts:804`.

**Eight matches no scope.** The transport-channel `read` surface is **seven** — `ws.ts:2146`,
`wt.ts:417`, `wt.ts:454`, `ws-worker.ts:203`, `ws-worker.ts:228`, `wt-stream-sink.ts:253`,
`wt-stream-sink.ts:278` — and **eleven** once the `runSinkPump` read callbacks that W5's own
two additions sit beside are included (`ws-worker.ts:162`, `:191`, `wt-stream-sink.ts:191`,
`:241`).

**The eight is mine.** My r5 handed it over as a corrected hand count and R6 adopted it, the
same way R5 adopted my 18 µs. A hand count I produced *while arguing that hand counts go
stale* was itself wrong — which is the plan's thesis demonstrating itself, and the second time
in two rounds that the plan is refused for taking my word. **Fix: strike both numbers from W5,
which D already demands.**

---

## Answers to the questions the brief asked

**1. Is the blast radius real, or does some path already attest a receive-side figure?**
**Real, attested, and in both directions.** Three sealed `bulk-one-way/physical` WT arms carry
`perSession.busyMs` exactly `0` over 2.22–2.45 s windows against WS at 26.3–54.9, and every
structural gate passes a zero (`arm-measure.ts:229-244` refuses *missing*, never *small*). A
receive-side figure **is** already attested on the sink arms — through `measureRead`
(`sink-worker.ts:222-229`), which charges suspension, so the one path that attests a receive
figure attests a wrong one. Direction B is attested via `onRelayWork` → `loop.record`
(`server.ts:3036`, `:1203`). The gap is in signed artifacts.

**2. Can charging `readChunk` over-charge a reader that waits?** **No, and I re-derived the
reason rather than inheriting r5's measurement.** With `pause` before the `await`, a span
charges only synchronous stretches, and two synchronous stretches cannot interleave on one
thread — so `LoopBusyMeter`'s single `spanStartMs` and depth counter (`transport.ts:207-227`)
remain a plain synchronous stack, which is exactly the invariant its own docstring
(`transport.ts:117-118`, `:155-158`) claims. `readChunk` has one `await` and one `finally`, so
one pause point suffices. R6's shape is correct. The hazard was never the site; it was the
shape, and the plan now names it.

**3. Can this break the child's monotonic reading, or live/closed conservation?** **No,
re-verified at HEAD.** `LoopBusyMeter.totalMs` only grows (`Math.max(0, …)`, `transport.ts:227`);
`onSessionClose` (`wt.ts:1655-1664`) deletes from the live set **before** accumulating and
no-ops on a repeat, so `serverLoopUtilization` (`:1666-1678`) cannot double-count or go
backwards; `server.ts:2529-2536` cannot fire from this change. The residual hazard is **silent
loss** of a charge landing after close — which item C is what creates, and which W8 states
correctly. C and W8 remain listed apart; couple them.

**4. Can the two transports be compared after the change?** **On the fanout relay, yes** —
item A makes the peer that runs the JavaScript pay for it, and both its location and its
magnitude check out. **On the Phase-A read path, no, and in a new way.** After C as written,
WT charges its whole read caller turn while WS charges none of its own — a quantity I measure
at 7.6–8.0 ms per 100 MiB, 2–3× the WT figure being added, and roughly a fifth to a third of
the sealed WS numbers. The residual *arrival*-side gap (WS 32–38 ms of JS frame decode against
WT's addon) is the metric working and I do not object to it; the *caller*-turn gap is the
metric being applied to one side (K1).

**5. Does the plan risk invalidating the sealed A5 arm?** **Not the WS arm as the plan is
written, on three checks** — A touches only the Phase-B fanout relay (`timed()` exists only in
the two fanout peers; A5 is `bulk-one-way/physical`); B touches `ws-worker` and
`wt-stream-sink`, which `ARM_WIRE`/`ARM_READ_PATH` make separate arms; C touches `wt.ts` only.
**The exposure is the sealed WT zeros, and it is deliberate and now correctly owned** by bullet
6. Two riders: **(a)** if K1 is fixed by option 1, the sealed **WS** arms are superseded as
well — bullet 6 permits it but **Risks** does not mention it, and Risks is where the campaign
reads its own blast radius. **(b)** I checked whether item F could collide with the
"fixture hashes CLEAN" gate: `SESSION_LOOP_BUSY_MS_DEFINITION` has **zero importers** anywhere
in the tree — every other mention is a docstring reference — and the definition text appears in
**no** sealed artifact on disk. **F is safe from the fixture gate.** It also means the
constant's own docstring claim, "in one place, for every adapter and every reader of an
artifact that carries it" (`transport.ts:89-90`), is false today: the reader of a report gets
`render-report.ts:233`'s hand-copied duplicate. Importing the constant, as F should, makes that
docstring true for the first time.

**6. Can the surface table be satisfied vacuously?** **Yes, two ways, both new since r5 and
both consequences of R6's own reshaping.** (a) The scan's roots are unstated and the literal
reading excludes `bin/compare-controller.ts:804` (K3). (b) Cell three is satisfiable by a row
whose named span executes none of the row's work, and bullet 3 checks only that the span
exists — which for `ws.ts:1865` it does (K1, K2). The two vacuity routes r5 found are closed:
the count is gone from acceptance, and the ceiling is deleted.

---

## Where I correct the Architect's r6

- **A6-1 is right and he understates it.** He compares his 8.2–11.5 ms WS twin against r5's
  5.76–8.27 ms WT figure and concludes "same or greater size". My meter-delta proof is
  stronger than his timer decomposition, and my WT number against a real `ReadableStream`
  (2.8–3.8 ms) makes the WS twin **2–3×** the quantity item C adds.
- **A6-2's WT half is right in kind and small in magnitude.** `readFromStream` is uncharged
  and identical in shape, but at 0.007–0.010 ms per accept it is a taxonomy defect in a
  one-stream arm, not a number defect. His blocking core — the missing cell — stands on the WS
  pair alone.
- **A6-3 and P1 I reproduce exactly**, including that the corrected hand count is itself wrong.
  P1's eight originates with **me**, not with the plan, and I say so above.
- **His three "the brief is wrong, the plan is right" entries I confirm independently**:
  `server.ts:385-396` is `echoSession`; `artifact-builder.ts:536-542` declares both scopes;
  gates constrain `busyMs` structurally but never its magnitude. The plan asserts none of the
  three, and the brief should be corrected rather than the plan.

## Smaller items — worth taking, none blocking alone

- **S1. `server.ts:1119`, not `:1120`**, in W1 and in item A. Named by both reviewers at r5 and
  still present. In a plan whose subject is whether a cited figure names the work it prices,
  a citation that names the wrong line for the third round is worth one `sed`.
- **S2. Item A should say the `await inbound.read()` at `:1116` stays outside the span** — the
  one line in that loop that must not be charged.
- **S3. Item C's enumeration describes only the WHATWG branch.** On the Node branch
  (`wt.ts:204-251`) the synchronous caller-turn work is the `new Promise` executor — a
  `setTimeout`, three `once` registrations, the nudge — and its teardown runs inside `cleanup()`
  on the **arrival** turn, not in a `finally` on the caller's. `open`/`pause`/`resume`/`close`
  must be placed differently in the two branches and C's single sentence does not say so.
- **S4. `seam = chunk !== null` is classified in D and instructed nowhere.** `open`'s default is
  `seam = true` (`transport.ts:206`), so a defaulted read span fires the deterministic seam on
  the EOF read that returns `null`. One clause in C, mirroring `wt.ts:924`'s
  `envelope !== null`.
- **S5. State E's injected wait and its separation bar in the plan**, so "materially different"
  is pre-stated rather than chosen after the first run. The separation is enormous when it
  exists (r5: 2,346 ms against 48.9 ms), so any pre-stated multiple is safe — which is the
  argument for stating one.
- **S6. Say B deletes the override rather than recombining terms.** Both arms compute `windowMs`
  from `sessionOpenedAtMs` (`ws-worker.ts:300`, `wt-stream-sink.ts:347`) while `LoopBusyMeter`
  computes it from meter construction (`transport.ts:167-168`); a base-meter numerator over a
  worker-computed denominator is a unit mismatch feeding the `0.3` detector at
  `render-report.ts:48`. Asked in five reviews; it is one clause.
- **S7. B's correctness on the WT arm depends on C landing.** `wt-stream-sink`'s base is the WT
  primary, whose only ingest span is the envelope pump at `wt.ts:924`; for a channel-read
  workload the restored base meter charges nothing until C. An implementer who does B first,
  sees the new zero-guard test red, and "fixes" it by keeping the suspension charge has undone
  the plan.
- **S8. Two docstrings cite the reading B deletes** — `server.ts:556-558` and `:1256-1257` both
  name `adapters/sink-worker.ts:227`.
- **S9. C implies a type change the plan does not name.** Fixing `wt.ts:94` and dropping the
  `as unknown as Readable` cast at `:1252` means `makeReceiveChannel(readable: Readable, …)` no
  longer accepts that site; the honest repair is a union there and at
  `readChunk(readable: any, …)` (`wt.ts:178`) — the same structural argument as the required
  meter, which the plan has already accepted.
- **S10. F should make the two texts unable to disagree, not merely agree.** `render-report.ts:233`
  is an independent string literal and the exported constant has no importers at all; importing
  it is the fix, and it is free of the fixture gate (see question 5b).
- **S11. `wt.ts:238-249` is live on a duck-typed stream.** The nudge is unreachable on a real
  node `Readable` because `readable.once("data", onData)` sets `readableFlowing` before the
  guard, but `readable.once?.` is optional-chained, so a stream without `.once` reaches it. If
  C charges the caller turn, this body is inside it; say so.

---

## What would make this APPROVED

1. Resolve the WebSocket half of the seam item C fixes: **either** extend C to `ws.ts:2146` and
   `ws.ts:1644` under the same `pause`/`resume` discipline, reporting the changed WS charge as
   bullet 6 now permits and adding it to **Risks**; **or** leave it uncharged, delete the
   "charged in full on the WebSocket side inside `ws.ts:1865`" clause, correct W6, and state the
   exclusion with its measured size. My numbers: WS consumer turn **7.6–8.0 ms** per
   1600 × 64 KiB, synchronous prefix 3.5–3.8 ms, against a session `busyMs` delta of
   31.8–37.4 ms that contains none of it (K1).
2. Add the fifth census cell — *transport work, deliberately uncharged, with reason and measured
   size* — and place `ws.ts:2146`, `ws.ts:1644` and WT `acceptUni`/`readFromStream` in it, or
   bring the latter into C's scope (K2).
3. Name the scan's roots so `bin/compare-controller.ts:804` cannot fall outside them (K3).
4. Strike the counts from W5, which D already forbids and one of which is wrong and mine (K4),
   and fix `:1120` → `:1119` (S1).

Items A, B, E and F are executable as written. The four r5 blockers are genuinely discharged;
the reshaping of C is the right reshaping and it is justified by the right rule; and replacing
the ceiling with a discriminating real-clock test is the single best change across six
revisions. What remains is that the plan applies its own corrected rule to one side of a
symmetric pair — and, as with the 18 µs and the census count, I could only see it because R6
made the quantity large enough to measure.
