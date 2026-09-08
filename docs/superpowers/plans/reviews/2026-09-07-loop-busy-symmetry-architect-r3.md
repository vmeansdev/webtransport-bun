CHANGES REQUIRED

# Architect review (revision 3) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `2a2df711ab84f38ac0d7f426612fac34ff721664c2be5578cc3fc214298982bf` |
| Declared SHA-256 | identical — verified before reading the plan |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` (working tree carries no tracked modifications) |
| Prior artifacts read | `…-architect.md` (r1), `…-architect-r2.md` (r2) |
| Method | every cited `file:line` read at HEAD; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → 29 pass / 0 fail (baseline reproduced); every claim in the review brief checked against source |

**The reframing is right, and it is the best thing in this document.** Parity was
unreachable by honest charging, the plan now says so, and it says so from measurement
rather than assertion. That is not a retreat.

**But the reframing was also used as a scope boundary, and three items left the plan
along with parity that were never parity items.** The fanout relay's unmetered ingest
— diagnosed in revision 2's own W6, confirmed by me at HEAD, and untouched by any work
item — has disappeared from the "what is wrong" list entirely while objective 1 still
claims "every producer of the figure" and the title still claims "directions". The
definition constant is unscheduled for the third revision running. The decorator layers
are unenumerated for the third revision running. Six blocking items.

---

## Facts checked, and the result

Every claim the brief named, plus the plan's own citations. All verified at HEAD by
reading the code.

| Claim | Verified |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** `makeReceiveChannel(readable, clock)` takes no meter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `grep '"ingest"'` over `adapters/` returns exactly two hits in the whole adapter tree: `wt.ts:924` and `ws.ts:1865`. The other nine WT spans are `"egress"` |
| `acceptUni` has one production caller (`client.ts:883`) | **True as a consumer**; still reached through `ws-worker.ts:256`, `wt-stream-sink.ts:306`, `compare-controller.ts:804-805`, and `tools/load/distributed-scale.ts:962` is a fourth caller outside `tools/compare` |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) | **True** — that is `echoSession`, Phase A. The relays are elsewhere; see R1 |
| WS server ingests through its message callback (`server.ts:670`) | **True**, and metered by a local `timed()` (`:642-650`) that returns `work()` unchanged when `options.onRelayWork` is unset |
| Sealed artifact fields (`artifact-builder.ts:533-536`, `:787-799`) | **True.** `:536-541` declares `perSession` **and** `serverAggregate`; `:786-800` validates `windowMs` finiteness only. The r1 "only server figures" claim stays correctly retracted |
| W1: `ws-worker.ts:296-302` / `wt-stream-sink.ts:329-346` overwrite `loopUtilization` from `sink-worker.ts` `measureRead` (`:222-229`) | **True**, and the call site is `sink-worker.ts:320` — `await worker.measureRead(() => read(nowMs() + readTimeoutMs))`, the whole read including the wait |
| W1: pinned green by `read-path-adapters.test.ts:291` | **True** — `"snapshot publishes the reader's loop, not the base session's"` |
| W2: four `read` implementations, three `acceptUni` implementations | **True** for the adapters proper: `read` at `wt.ts:417`, `:454`, `:1306`, `ws.ts:2146`; `acceptUni` at `wt.ts:1242`, `:1566`, `ws.ts:1644`. Both counts exclude the wrapper layers — see R6 |
| W3: WS `acceptUni` (`ws.ts:1644`) charges nothing; construction + queue push (`:1998-2001`) run inside the `:1865` span | **True.** `:1998-2001` sits inside `dispatchSocketMessage` (`:1870`), which is the body of the `measure("ingest", …)` |
| W4: `render-report.ts:233` calls both figures the server's | **True**, verbatim, in a Provenance list that covers both scopes |
| W5: `65 / 1250` traces to `cohort-fixture-signing.ts:194-198` | **True** — `issuedAtMs = 1_700_000_000_000`, `spanMs ?? 1_250`, `busyMs ?? 65` |
| W6: all twelve `timed()` closures in `server.ts` are synchronous, so Phase B does not charge suspension | **True** |
| W7: gates exist; the monotonicity refusal at `server.ts:2529` | **True** — `if (finalBusyMs < baselineBusyMs) … "the server loop went backwards"` |
| W7: `busyMs` is minted as `finalBusyMs − baselineBusyMs` (`:2572`), so a late charge cannot break conservation | **True, and this corrects me.** My r2 A6 claimed a late charge would trip the conservation refusal at `secure_fs.rs` / `server-snapshot-protocol.ts:176-179`. It cannot: the figure is *minted* from the difference at `server.ts:2572`, so the identity holds by construction and the decode check is tautological on this path. W7's re-diagnosis — the real close-time hazard is **silent under-reporting**, at `wt.ts:1655-1664` where `onSessionClose?.(session, sessionLoopUtilization().busyMs)` transfers once and later charges are lost — is the correct one. Credit taken and given |
| "No gate constrains busyMs" (the brief's last item, from r1) | **False**, as r3 now says |

Two citation slips, non-blocking: `makeBidiChannel.read` is at `:454`, not `:455`;
`readFromStream` is at `:471`, not `:467` (the doc comment is at `:466`).

---

## Blocking findings

### R1. The reframing dropped a live code defect: the fanout relay's ingest is unmetered, and no work item touches it

Revision 2's W6 diagnosed it and my r2 A3 required the plan to *either schedule it or
scope the acceptance off it*. Revision 3 does neither. The item is simply gone: r3's
W-list renumbers, and the new W6 is "a docstring defect, not a code defect."

The docstring half of that is true. The code half is not, and I re-verified the defect
at HEAD (`server.ts:1114-1120`):

```
const inbound = opened.value.readable.getReader();
const frames = new LengthPrefixedFrameReader(FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES);
for (;;) {
    const chunk = await inbound.read();          // unmetered
    if (chunk.done || chunk.value === undefined) return;
    for (const bytes of frames.push(chunk.value)) {   // reassembly, OUTSIDE the span
        const result = timed(() => { … });             // span starts here
```

`frames.push(chunk.value)` — the length-prefixed reassembly, the one genuinely costly
per-byte JS step on that path — runs outside the `timed()` window, so it is uncharged
*even when the observer is wired*. That is the WT-side analogue of exactly the
under-charge this plan exists to close, on the producer that mints the Phase-B server
figure.

Why the reframing does not excuse it: it is not a parity item. It is a completeness
item, and completeness is what revision 3 says it is still doing. Three things in the
plan reach it:

- Objective 1: "on every seam of both adapters **and every producer of the figure**".
  `createCohortServerLoopObserver` (`server.ts:1277`) is a producer of the figure, and
  `onRelayWork` is how it is fed.
- The title: "across transports **and directions**". B5/B6 are the direction-inverting
  cells and they run through this relay.
- Acceptance: "Real-process evidence with the existing drivers, reporting **both
  scopes** on both transports" — the server scope on a fanout cell is this accumulator.

So the plan's objective, title and acceptance all reach a defect its work list is
silent about, and its "what is wrong, verified" section — which exists to be the
complete inventory — no longer mentions it. Restore it as a W-item and either schedule
it (charge `frames.push` inside the span; give the raw reader loop a span) or state in
one sentence that the fanout relay ingest is a known, named under-charge deferred to a
follow-up, and narrow the title and acceptance to match.

### R2. Work C's taxonomy has no cell for "transport work, charged at another seam" — and that omission puts C in direct conflict with acceptance bullet 3

C offers three classes: **ingest**, **egress**, **not transport work, with a reason**.
Its second test "drives every seam classified as ingest or egress and fails if it
charges nothing"; seams in the third class "are asserted to charge nothing."

Now apply it to the two WS seams the plan itself has just analysed:

- **`WsChannel.read` (`ws.ts:2146`)** is a `read` seam. It does transport work — it is
  the delivery of an inbound frame to the consumer — but it charges nothing, because
  the decode was charged upstream at `:1865`.
- **`WebSocketAdapter.acceptUni` (`ws.ts:1644`)** is W3's own case, for the same reason.

Neither fits any of the three classes. Classify them **ingest** and the second test
fails until someone adds a span — which double-counts and moves the sealed `26.3125`,
contradicting acceptance bullet 3. Classify them **not transport work** and the table
states a falsehood about the single most load-bearing seam on the WS receive path, and
W3's own justification ("already run inside the ingest span at `:1865`") has nowhere to
be written down.

Add the fourth class and make it carry evidence rather than prose: **charged upstream
at `<file:line>`**, with the test asserting (a) this seam charges nothing itself and
(b) the cited upstream span exists and is entered on the path that reaches this seam.
That is the class W3 needs, it is the class that makes bullet 3 provable rather than
asserted, and without it C is a test that must be made to pass by breaking the plan's
own acceptance.

**Related, and the plan should resolve it explicitly:** W3 justifies not charging WS
`acceptUni` by pointing at an upstream span. **WT has no counterpart.** `wt.ts:924` is
the message path only; the stream-accept path (`readFromStream` → `makeReceiveChannel`)
has no enclosing span anywhere. So "classify `readFromStream`" (work B) is not a
bookkeeping act: if it lands in "not transport work", the WT accept seam is uncharged
where its WS counterpart *is* charged, and that is an asymmetry in the **rule**, not in
the stacks. Objective 1 is "one rule, applied everywhere". Say which way it goes and why.

### R3. The explicit non-parity test has the wrong sign — as written it either pins the under-charge or asserts nothing

The idea is right. The form is not. Acceptance says:

> a test asserts the opposite is acceptable: for a receive-only arm the WebTransport
> figure may be near zero while WebSocket is not

A test cannot assert that something is *acceptable*. It can only assert a property, and
the two readings of this sentence are both bad:

- **It asserts WT-receive ≈ 0.** Then the near-zero charge becomes the specification.
  A later, correct change that puts real JS work on the WT read path — the
  session-lifetime pump, a checksum, a reassembly step — turns it red for being right.
  That is precisely "a way to bless a broken metric", and it is the reading the
  sentence most naturally supports.
- **It asserts nothing checkable.** Then it is a green test that pins no behaviour,
  which is what r1 called vacuity and r2's A4 half-answered.

The guard this plan actually needs points the other way, and revision 3 has removed
the only place it was written down. The live hazard after work A and work B is **an
implementer widening the new read span until the number looks like work**, which
re-creates W1's suspension charge on the seam B just installed. That failure is
**upward**, and the plan's own risk register names it first. So state a **ceiling**:

> For a receive-only arm of the sealed shape (100 MiB, 1600 chunks), the WT
> `perSession` figure is expected in the single-digit milliseconds. A reading in the
> same order as WS's is a **failure signal**, not a success signal, and the run is
> refused pending an explanation of where the milliseconds came from.

That is falsifiable, it points at the danger, it does not pin a floor, and it makes the
non-parity claim a positive finding rather than a disclaimer. Keep the idle-reader test
as the complementary floor guard — it is the strongest, most falsifiable line in the
acceptance and it should stay exactly as written.

Note the plan over-credits the `0.3` detector as a backstop for this: the sealed WS arm
sits at ~0.058, and a WT arm inflated from 1 ms to 50 ms over a ~2.3 s window reaches
~0.022. The detector fires for the `measureRead` shape (ratio → 1.0), as risk 3 says,
and is blind to exactly the partial over-charge R3 is guarding.

### R4. The `seam` flag is still absent, for the third revision, and work B is the change that makes it bite

`LoopBusyMeter.open(kind, seam = true)` fires `this.clock.noteBusySlice?.()` on entry
for every `"ingest"` span (`transport.ts:218`). Four suites price a deterministic clock
through that hook: `wt.test.ts:1086`, `:1133`, `:1181`, and `ws.test.ts:1516`.

Work B installs a **new ingest span on the read path**. At the default `seam = true` it
tells the fake clock that a delivery happened on every read — including the EOF read
that returns `null`, where nothing arrived. That mis-prices EOF and perturbs suites
that have nothing to do with this change.

The span must pass `seam = chunk !== null`, mirroring `wt.ts:924`'s
`busy.open("ingest", envelope !== null)` exactly. The plan uses the word "seam"
sixteen times and never once means the flag. One sentence in work B fixes it; without
it, an implementer following the plan writes the bug, and it will surface as an
unexplained red in `wt.test.ts` rather than as anything recognisable.

### R5. `SESSION_LOOP_BUSY_MS_DEFINITION` is still unscheduled, and work E as written makes the duplication worse and edits correct prose

The plan never mentions `transport.ts` or the definition constant — I grepped the whole
document. The constant reads (`transport.ts:131-136`):

> "busyMs is the JavaScript event-loop time **this server** spent on this session's
> transport work…"

W4 correctly says `render-report.ts:233` mislabels a client figure as the server's.
`render-report.ts:233` is a **hand copy** of that constant, with one extra clause. The
constant has the identical defect, and work B is about to charge a **client** read into
the very figure the constant calls the server's. Work E fixes the copy and leaves the
source, so after E the two disagree — strictly worse than today, where all three copies
agree and are wrong together.

Schedule the constant: make it role-neutral ("the loop time **this session's process**
spent…"), carry the role as a labelled property of each attested figure, and make the
report legend **derive** from the exported constant rather than restate it, so a fourth
copy cannot appear.

And E says "Fix `render-report.ts:233` **and the frame documentation**". The frame
documentation is `server-snapshot-protocol.ts:60-79`. I read it again at HEAD: it is
**correct** — it scopes itself explicitly to the server child ("the JavaScript
event-loop time the server child spent"), it derives its meaning from the constant by
citation rather than by copying, and its closing paragraph already says the thing this
whole revision is trying to say ("A reader comparing a WS arm's `busyMs` against a WT
arm's is comparing loop occupancy, not machine cost"). It is the one piece of prose in
the tree that does not need fixing. As phrased, E points an implementer at it. Name
what is actually wrong instead: `transport.ts:131` and `render-report.ts:233`.

### R6. Work B says "the arrival body", singular; there are three, across two branches, and the two construction sites take different ones

`readChunk` (`wt.ts:177`) has two branches and three places a chunk arrives:

1. WHATWG branch — the `.then` continuation at `:196-197`, `res.done ? null : (res.value ?? null)`.
2. Node branch — `onData` at `:220-224`.
3. Node branch — the **synchronous nudge**, `readable.read()` at `:243-250`, a third
   arrival body with its own `cleanup()` and its own `instanceof Uint8Array` branch,
   which resolves without any listener firing.

Both branches are live, at different construction sites:

- `:1251` passes an item off `native.incomingUnidirectionalStreams` cast to `Readable`.
  A WHATWG stream has `getReader`, so `readChunk` takes **branch 1**.
- `:1569` passes the return of `acceptNextUni` (`:1410-1412`), typed
  `Promise<import("node:stream").Readable>` — no `getReader` — so it takes **branch 2**,
  and the nudge at `:243` is on its path.

An implementer charging "the arrival body" charges one of three and leaves at least one
construction site unmetered; C's second test then passes if its driver happens to
exercise the metered site. This repo has a named gotcha for metering a dead branch, and
this is the shape of it. Work B must name the three bodies and require all three
charged, and C's driver must cover both construction sites, not both *seam names*.

Two structural pieces go with it that the plan still does not schedule, both raised in
r2 and unanswered:

- **Remove the optionality.** `makeBidiChannel(duplex, clock, busy?: LoopBusyMeter)`
  (`wt.ts:426-429`) is what let W2 happen — the meter is present and unused for `read`.
  Work B gives `makeReceiveChannel` a meter and passes it at the two sites that exist;
  make the parameter **required** and the compiler enforces what C otherwise has to chase.
- **Enumerate the wrapper layers.** C is keyed "on the adapter surface", which does not
  reach `ws-worker.ts:255-256`, `wt-stream-sink.ts:305-306` or
  `bin/compare-controller.ts:804-805` — all three verified present at HEAD, all three on
  the production path between `client.ts:883` and the adapter, and all three producing
  `read` implementations of their own via `wrapReceive`. A seam arrives unmetered by
  being **decorated**, not only by being added. Work A brings the first two into scope
  for the suspension fix; none of the three is in C's enumeration.

---

## Answers to the questions the brief asked

**Is the reframing right, or a retreat?** Right, and it is the document's strongest
move. Parity was unreachable by honest charging; I measured that in r2 and the plan now
carries the measurement rather than the hope. "What the numbers actually mean" is
correct and well argued. The plan is one sentence from an even better framing that it
almost reaches: `busyMs` is not a cost metric, it is **a measure of how much of each
transport's work lives in JavaScript**. Read that way, WS ≈ 50 ms against WT ≈ 0 on a
receive leg is not a gap, it is the campaign's finding — the WT adapter pushes its
framing below the loop and the WS adapter cannot. Put that in the report label and the
non-parity acceptance stops reading as an excuse.

**Do the work items still fix the real defects?** Four of five, yes.
A fixes the sink-worker suspension charge and rewrites the pin at
`read-path-adapters.test.ts:291` — correct and correctly scoped. B fixes the
structurally-unmeterable seam, subject to R6. D is right and W7's re-diagnosis of it
(silent under-reporting, not a conservation break) is right. E is right in intent and
wrong in target, per R5. C is the one that does not yet do its job: R2 and R6.

**Is the acceptance falsifiable, and does it smuggle parity back in?** It does not
smuggle parity — that is genuinely gone. But it is not yet falsifiable in the direction
that matters: bullet 5 is a permission rather than a property (R3), and bullet 3
("`26.3125` and `1 / 977` are reproduced by a run of the same shape") is unachievable
as literally written — a fractional wall-clock millisecond off a physical rig will not
reproduce to four decimal places, so the bullet will be discharged by restating its own
justification. Restate it as the justification: *no seam that contributed to those
figures changes charge, proven per construction site against the table; any re-run
reading is reported and is not required to match.*

**Is not charging WS `acceptUni` correctly justified?** Yes. I verified the chain:
`:1998-2001` constructs the channel and pushes it to `uniAcceptQueue` inside
`dispatchSocketMessage` (`:1870`), which is the body of the `measure("ingest")` at
`:1865`; `acceptUni` (`:1644`) is `waitForQueue` plus `releaseAcceptReservation()`, so
charging it would double-count the construction and charge the queue wait as well —
W1's defect on a new seam. The justification is sound; it just has no cell in C's table
to live in (R2), and its WT counterpart is left undecided (R2, second half).

**Is the enforcement in work C sufficient to prevent a third instance?** No. "Keyed on
the adapter surface rather than on names" is the right instinct stated too loosely to
bind: the adapter surface *is* a set of names, and the defect class is "an
implementation of a metered seam that does not charge". Four `read` implementations,
three `acceptUni` implementations, three more of each behind the wrappers, and two
`readChunk` branches under one of them. A seam can still arrive unmetered by being a
new construction site, a new wrapper, or a new branch of an existing body. Bind the
enforcement to **construction sites**, make the meter parameter required so the
compiler carries half the load, and drive each site behaviourally against a priced fake
clock.

**Does anything contradict the published definition, and is the definition still
right?** Nothing in r3 contradicts it — that is an improvement on r2, whose acceptance
bullet 1 demanded a figure the definition forbids. On substance the definition holds up
and is what makes the small WT figure *correct* rather than missing. On **role** it is
wrong and getting wronger: it says "this server" while the attested `perSession` is the
consumer's loop (`arm-measure.ts:224-231`), and work B charges a client read into it.
Unscheduled — R5.

---

## Smaller items, non-blocking

- **W7 says "Five" gates.** I count at least six: the `secure_fs.rs` conservation
  binding, the decode-side conservation at `server-snapshot-protocol.ts:176-179`,
  leg-finiteness at `arm-measure.ts:235`, server-snapshot finiteness at `:255` and
  `:713-716`, the `0.3` saturation threshold at `render-report.ts:48`/`:123-128`, and
  the monotonicity refusal at `server.ts:2529`. An unenumerated count is not checkable
  by a reader; list them.
- **Acceptance bullet 2 is garbled**: "deleting a row, or a charge on a seam classified
  as charging, turns a named test red" — presumably *removing* a charge. Fix the wording;
  it is one of only two enforcement claims in the acceptance.
- **Work D does not say where the report surfaces.** "Counted and reported" needs a
  named field — a counter on `TransportMetrics`, a line in the artifact, something a
  gate can read — or the count exists only in a log and is not evidence.
- **`windowMs` still has two origins.** `ws-worker.ts:301` and `wt-stream-sink.ts:345`
  compute it from `sessionOpenedAtMs`; `LoopBusyMeter` computes it from meter
  construction (`transport.ts:167-168`). Work A changes the numerator on those two arms
  and says nothing about the denominator, and the `0.3` detector divides one by the
  other. Raised in r1 and r2; still unaddressed.
- **Test disposition.** The plan names only `read-path-adapters.test.ts:291`. Say
  which suites must stay **green**: the exact-`65` assertions in `wt.test.ts`
  (`:1119, :1121, :1166, :1169, :1213, :1216`) drive the datagram/message path through
  `receiveMessage`, not stream reads, so work B must not move them — and if it does,
  that is the R4 seam-flag bug announcing itself.
- **Risk 4 is right and should be promoted.** "Changing the sink arms changes figures
  those arms have reported before … the change must be called out in the report" is the
  correct disposition, and it belongs in the acceptance as a deliverable, not only in
  the risk register.

---

## What would make this APPROVED

1. Restore the fanout relay ingest defect (`server.ts:1114-1120`) to the W-list and
   either schedule it or scope the title, objective 1 and the acceptance off it (R1).
2. Add the fourth classification — *charged upstream at `<file:line>`*, with the test
   asserting the upstream span exists and covers the seam — and decide whether the WT
   stream-accept path gets a span or an exception (R2).
3. Replace the non-parity permission with a pre-stated **ceiling** on the WT receive
   figure, naming a large reading as the failure signal; keep the idle-reader test (R3).
4. Add `seam = chunk !== null` to every new read span, mirroring `wt.ts:924` (R4).
5. Schedule `SESSION_LOOP_BUSY_MS_DEFINITION` to become role-neutral, derive the report
   legend from it, and strike "the frame documentation" from work E —
   `server-snapshot-protocol.ts:60-79` is correct (R5).
6. Name the three arrival bodies and the branch each construction site takes; make the
   meter parameter required; extend C's enumeration over `ws-worker.ts:255`,
   `wt-stream-sink.ts:305` and `compare-controller.ts:804` (R6).
7. Restate acceptance bullet 3 as the justification it actually is, rather than as exact
   reproduction of `26.3125`.
