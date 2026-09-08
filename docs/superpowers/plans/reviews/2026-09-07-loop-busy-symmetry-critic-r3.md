CHANGES REQUIRED

# Critic review (revision 3) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `2a2df711ab84f38ac0d7f426612fac34ff721664c2be5578cc3fc214298982bf` |
| Declared SHA-256 | identical — verified before reading the plan |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc`, working tree carries no tracked modifications |
| Prior artifacts read | my r1 and r2, Architect r1/r2/r3 |
| Method | every cited `file:line` read at HEAD; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → **29 pass / 0 fail** (baseline reproduced); every sealed `bulk-one-way/physical` arm on disk parsed; **four executed probes** — the fanout reassembly, the fanout routing decode, the `readChunk` branch discriminator, and the three meter shapes. Git read-only; only this artifact written |

**The reframing is right.** Parity was unreachable by honest charging, I measured that in r2,
and revision 3 carries the measurement instead of the hope. I set out to refute the reframing
and could not.

**What I can refute is the generalisation it is used to justify.** "WebSocket decodes in
JavaScript, WebTransport decodes natively" is true of the Phase-A client leg and **false of
the fanout server**, where the WT peer does hundreds of milliseconds of JavaScript
reassembly and JSON decoding that the WS peer does not do at all — and does not charge for
it. Revision 3 deletes that defect from its inventory and then generalises the client-leg
finding over "transports **and directions**". So the reframing is not a retreat, but it was
used as a scope boundary, and the thing outside the boundary refutes the sentence the
boundary was drawn to protect.

Seven blocking findings. C1, C2 and C3 are new to both reviews; C2 and C3 are both live
hazards in the work items themselves, not in the prose.

---

## Facts checked at HEAD

Every claim the brief named, and every citation the plan makes.

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` then `reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** `makeReceiveChannel(readable, clock)` takes no meter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `busy.open("ingest", envelope !== null)`; the other nine WT spans are `"egress"`. `ws.ts` likewise has exactly one, `:1865` |
| `acceptUni` has one production **consumer** (`client.ts:883`) | **True** as a consumer — `const channel = await input.session.acceptUni(acceptDeadline)`. It is reached through decorators; see C6 |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) | **True of `echoSession`, which is Phase A, not the fanout relay.** The relays ingest at `:670` (ws) and `:1114` (wt). The plan does not make this claim; the brief carries it from r1 and it should not be carried forward |
| WS server ingests through its message callback (`server.ts:670`) | **True**, and everything it does per message is inside `timed()` (`:642-650`) |
| Sealed artifact carries only server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False, and the plan correctly no longer claims it.** `:536-541` declares `perSession` **and** `serverAggregate`; `:786-800` validates `windowMs` finiteness only. Every sealed arm on disk carries a `perSession` figure |
| No gate constrains `busyMs` | **False.** Five constraints, re-verified: `secure_fs.rs:17789-17800`, `server-snapshot-protocol.ts:176-179`, `server.ts:2529-2533`, `arm-measure.ts:235-239`/`:713-716`, `render-report.ts:48`/`:123-128`. The plan's W7 now says so; the brief still says the opposite |
| W1: `ws-worker.ts:296-302` overwrites `loopUtilization` with `sink-worker.ts` `measureRead` (`:222-229`), booking the whole read wall time | **True**, verbatim: `const startedAtMs = nowMs(); try { return await read(); } finally { busyMs += … }` |
| W1: pinned green by `read-path-adapters.test.ts:291` | **True** — `"snapshot publishes the reader's loop, not the base session's"`, asserting `busyMs > 0` off a `readDelayMs: 5` script |
| W3: WS `acceptUni` charges nothing because `:1998-2001` is already inside the `:1865` span | **True.** No method boundary between `dispatchSocketMessage` (`:1870`) and the queue push |
| W5: `65 / 1250` traces to `cohort-fixture-signing.ts:194-198` | **True** — `issuedAtMs = 1_700_000_000_000`, `spanMs ?? 1_250`, `busyMs ?? 65` |
| W6: all twelve `timed()` closures in `server.ts` are synchronous | **True** — so Phase B does not charge *suspension*. It does under-charge; C1 |
| W7: `busyMs` minted as `finalBusyMs - baselineBusyMs` (`:2572`); real close hazard is silent under-reporting (`wt.ts:1655-1664`) | **True, and this is the plan's best correction.** I re-verified the monotonicity question separately; see "Answers", question 3 |
| W4: `render-report.ts:233` calls both figures the server's | **True**, verbatim, in a Provenance list covering both scopes |
| Baseline 29 pass / 0 fail | **Reproduced** |

**Sealed evidence, re-parsed.** `c7fafa52` ws is `perSession 26.3125 / 962.176`,
`serverAggregate 1 / 977`. Every other sealed arm carries the fixture `65 / 1250`, and
**every WT arm on disk, in every campaign, reads `perSession.busyMs` exactly `0`.** No WT
arm has ever sealed under a real server figure.

**Citation slips, non-blocking.** `makeBidiChannel.read` is `:454`, not `:455`;
`readFromStream` is `:468` — the plan's `:467` is its doc comment, and the Architect's
`:471` is its third parameter.

---

## Blocking findings

### C1. The dropped fanout defect is worse than "unmetered ingest", and it inverts the plan's headline sentence

The Architect's R1 is right that `server.ts:1114-1120` is a live code defect that revision 3
deleted from its inventory. I confirm it and I extend it in three ways he did not.

**It is wired in production.** `onRelayWork` is not a test hook. `server.ts:3036` passes
`onRelayWork: (elapsedMs) => loop.record(elapsedMs)` into `serveFanoutCohortRelay`, and
`loop` is `createCohortServerLoopObserver()` (`:2970`) — the accumulator that mints the
Phase-B attested `busyMs`. `serveFanoutCohortRelay` forwards it to **whichever peer the
signed grant names** (`:1203`), WT included. So this is the attested figure, not a latent one.

**There are two uncharged bodies on that path, not one, and the plan's own W6 names neither.**

```
const chunk = await inbound.read();                     // :1114  unmetered
for (const bytes of frames.push(chunk.value)) {         // :1116  reassembly, OUTSIDE the span
    const result = timed(() => { … });                  // :1118  the span
    settler.settle();
    if (result.ok) {
        const routing = relayFrameRoutingFields(bytes); // :1126  OUTSIDE the span
```

`relayFrameRoutingFields` (`server.ts:829-860`) is a `TextDecoder.decode` plus a `JSON.parse`
of the whole frame body, per accepted inbound frame. It is the more expensive of the two and
neither review has named it.

**Priced.** Bench on this Mac with the real `LengthPrefixedFrameReader` (`wt.ts:2062`) and a
255-byte JSON frame of the fanout shape, `bun` 1.3.14:

```
frames.push, 10k frames, one unit per chunk                3.42 ms
frames.push, 10k frames, split across two chunks           6.40 ms
frames.push, 600k frames (60 s at the 10k/s cell rate)    171.07 ms
relayFrameRoutingFields x10,000                            4.81 ms
relayFrameRoutingFields x600,000                          246.70 ms
```

A `ticker-fanout_rate-10000` cell — the rate is in the fixture names under
`tools/compare/fixtures/cohort-evidence-vectors/` — therefore drops on the order of **420 ms
of real JavaScript loop time per minute** out of the attested WT server figure. For scale,
the entire sealed WS Phase-A `perSession` figure is 26.3 ms and the sealed server figure is
1 ms.

**And it points the opposite way from the plan's thesis.** The WS peer's `onMessage`
(`:670-679`) receives an already-delimited message from Bun's native WebSocket framing, calls
no routing decoder at all, and charges everything it does inside `timed()`. The WT peer has
to reassemble a length-prefixed stream in JavaScript and decode routing in JavaScript — and
charges for neither. So on the fanout server it is **WebTransport that decodes in JavaScript**,
and the meter hides it. "What the numbers actually mean" is a correct statement about the
Phase-A client leg and a false one about direction B, which is half the title.

This is not a parity item and the reframing does not reach it. Objective 1 says "every
producer of the figure"; `createCohortServerLoopObserver` is one. Restore it as a W-item and
either charge both bodies, or state in one sentence that direction B carries a named,
quantified under-charge deferred to a follow-up — and then delete "and directions" from the
title and "both scopes on both transports" from the acceptance, because as written they
promise what the work list does not deliver.

### C2. Work B's charge site does not exist at one of its two construction sites — and the natural repair is W1 re-created

Work B says "charge the arrival body". My r2 asked which branch of `readChunk` production
takes at each site and got no answer in r3. I settled it by execution, and **the two sites
take different branches.**

The discriminator is `typeof readable.getReader === "function"` (`wt.ts:178`). Executed:

```
ReadableStream getReader: function        // WHATWG branch
node Readable  getReader: undefined       // EventEmitter branch
```

- **`wt.ts:1569`, in `wrapClientSession`** — `acceptNextUni` is declared
  `Promise<import("node:stream").Readable>` (`:1410-1412`). **EventEmitter branch.** This is
  the A5 client leg (`client.ts:883` → this adapter), and it is the branch my r2 probe priced
  at 0.253 ms per 1600 chunks. Work B is implementable here.
- **`wt.ts:1251`, in `wrapServerSession`** — the item comes off
  `native.incomingUnidirectionalStreams`, whose **item** type is
  `WebTransportReceiveStream = ReadableStream<Uint8Array> & Partial<StopSendable>`
  (`packages/webtransport/src/index.ts:949`, `:2241`), and
  `createServerIncomingUniStreams` enqueues exactly that
  (`controller.enqueue(direct.readable)`). **WHATWG branch.**

`wt.ts:1251` casts it `as unknown as import("node:stream").Readable`, and `wt.ts:94` declares
the outer stream `ReadableStream<Readable>`. **Both declarations are wrong about the runtime
object**, which is why a reader of `wt.ts` alone — me, on first pass — concludes the
EventEmitter branch. The Architect reached the right answer by the wrong route: the outer
stream having `getReader` is irrelevant, since `makeReceiveChannel` receives an *item*, not
the stream.

The consequence is the finding. On the WHATWG branch **there is no arrival callback at all**
— only `await Promise.race([readPromise, timeoutPromise])` and a `.then` continuation
(`:194-198`). An implementer told to "charge the arrival body" at `:1251` finds no body, and
the only enclosing thing to wrap is the `await`. That is W1, on the seam work B was written
to fix, in the file the plan is fixing it in.

**The meter offers no defence, in either direction.** Executed, all three shapes an
implementer might reach for:

```
measure("ingest", async () => { await sleep(50); })   busyMs =  0.273   // silently ~nothing
open("ingest"); await sleep(50); span.close()         busyMs = 52.436   // the W1 shape
open(); pause(); await sleep(50); resume(); close()   busyMs =  0.012   // the discipline
```

`LoopBusyMeter.measure<T>(kind, run: () => T)` (`transport.ts:186`) type-checks an `async`
closure with `T = Promise<R>` and closes the span at the first `await`, charging ~0. So work B
has one correct shape and two type-clean wrong ones, differing by **200×** in opposite
directions, and the plan names none of them.

Work B must name the three arrival bodies — the WHATWG `.then` continuation (`:196-197`), the
Node `onData` (`:220-224`), and the synchronous `readable.read()` nudge (`:243-250`) — say
which construction site reaches which, require the `open`/`pause`/`resume` discipline
explicitly, and fix or annotate the two lying type declarations at `:94` and `:1251` in the
same change.

### C3. Work A, as written, converts an over-charge into a near-total under-charge, and no work item catches it

`ws-worker.ts:1-25` states plainly: *"there is no worker thread, because `node:worker_threads`
is a forbidden import on a role-child module."* The sink pump runs on the **same JavaScript
loop** as the base session. And `ws-worker.ts:296-302` deliberately **discards** the base
session's `loopUtilization` — the meter that holds the actual WS frame decode at `ws.ts:1865`
— and publishes only the pump's figure.

Today that figure is `measureRead`'s wall time, which is wrong but non-zero. Work A removes
the suspension charge and replaces it with "the shared meter's discipline" — and the pump's
own JavaScript work is a queue push. The decode stays on the discarded meter. **The
`ws-worker` arm will report approximately zero for a path that decodes 100 MiB of WebSocket
frames in JavaScript on the loop it is reporting.**

That is the same defect class the plan exists to remove, manufactured by work A, on the same
loop, in the same direction as the WT gap the plan calls "a true property of the two stacks".
And work C's second test ("drives every seam classified as ingest and fails if it charges
nothing") would then fail on the `ws-worker` `read` seam — or be dodged by classifying the
decorator as not-transport-work, which is false.

Work A must say what replaces the charge: either the pump adopts the base session's meter for
the slices that run on this loop, or the arm publishes `base + pump` with the composition
stated. "Charge loop time, not waiting" is necessary and, on this arm, not sufficient.

### C4. Acceptance bullet 3 is unachievable as written, and I have the data

> The already sealed arms are untouched: `26.3125` and `1 / 977` are reproduced by a run of
> the same shape

`perSession.busyMs` is a sum of fractional wall-clock milliseconds. Four sealed WS arms of the
**same shape** on the physical rig:

| candidate | `perSession.busyMs` |
| --- | --- |
| `c7fafa52` | `26.3125` |
| `f9d0cd54` | `40.08154296875` |
| `cc866b8b` | `45.075439453125` |
| `8ada2d1b` | `54.9423828125` |

A **2.09× spread** across runs that changed no charge at all. Bullet 3 cannot pass, so it will
be "interpreted" at acceptance time — which is how a non-falsifiable bullet gets marked green.
The bullet's own subordinate clause is the checkable claim and should be the whole bullet:
*no seam that contributed to the sealed figures changes charge*, demonstrated per seam, not
per number. Keep the exact figures as provenance, not as a target.

### C5. Work C's taxonomy has no cell for "transport work, charged upstream" — confirmed, and it is the cell that makes bullet 3 provable

I confirm the Architect's R2 independently. `WsChannel.read` (`ws.ts:2146`) and
`WebSocketAdapter.acceptUni` (`ws.ts:1644`) are transport work that charges nothing because
`ws.ts:1998-2001` runs inside the `:1865` span. Classify either as ingest and C's second test
forces a double-count that moves the sealed `26.3125`, contradicting bullet 3; classify either
as not-transport-work and the table asserts a falsehood about the busiest seam on the WS
receive path, and W3's justification has nowhere to live.

Add the fourth class **charged upstream at `<file:line>`**, and make the test check both
halves — this seam charges nothing, *and* the cited span is entered on the path that reaches
it. That converts W3 from an assertion into a proof, and it is the only construction that
makes bullet 3 checkable rather than reproducible.

The Architect's related point holds too and the plan must answer it: WT's stream-accept path
has **no** upstream span anywhere (`:924` is message-only), so classifying `readFromStream`
decides whether the two adapters obey one rule or two. Objective 1 is "one rule, applied
everywhere". Say which way, and why.

### C6. "Keyed on the adapter surface" is still name-keyed, and the plan's own seam counts prove it can be satisfied vacuously

W2 says "four `read` implementations and three `acceptUni` implementations exist at HEAD".
Enumerated at HEAD:

| `read` | `acceptUni` |
| --- | --- |
| `wt.ts:417` (`makeReceiveChannel`) | `wt.ts:1242` (`wrapServerSession`) |
| `wt.ts:454` (`makeBidiChannel`) | `wt.ts:1566` (`wrapClientSession`) |
| `wt.ts:1306` (inline `acceptBidi` channel) | `ws.ts:1644` |
| `ws.ts:2146` | `ws-worker.ts:255` |
| `ws-worker.ts:203` (`wrapReceive`) | `wt-stream-sink.ts:305` |
| `wt-stream-sink.ts:253` (`wrapReceive`) | |

**Six and five, not four and three.** The plan's count is exactly the count you get by
excluding the decorator layers — and the decorators are on the production path, all three
verified: `ws-worker.ts:255-256`, `wt-stream-sink.ts:305-306`,
`bin/compare-controller.ts:804-805`, each `return wrapReceive(await base.acceptUni(…))`.
(`tools/load/distributed-scale.ts:962` is a fourth caller outside `tools/compare`.)

A row `read → ingest` satisfied by driving one of six is today's bug, and it would pass work C
after fixing `makeReceiveChannel` alone. Key C on **construction sites** — there are five for
`makeReceiveChannel`/`makeBidiChannel` (`wt.ts:1251`, `:1266`, `:1569`, `:1581`, `:1590`) plus
the inline `:1306` — and drive each one. And take the free half of it from the compiler: make
`makeBidiChannel(duplex, clock, busy?: LoopBusyMeter)` (`:426-429`) **required**. That
parameter is present and unused by `read` at `:455` today — the plan's W2 in miniature, inside
the function the plan is editing.

### C7. The `seam` flag and `SESSION_LOOP_BUSY_MS_DEFINITION` are both unscheduled for the third revision, and work B makes each one worse

I grepped the plan: it never mentions `transport.ts`, never mentions the flag, and never uses
the word "seam" to mean it.

**The flag.** `LoopBusyMeter.open(kind, seam = true)` fires `clock.noteBusySlice?.()` on entry
for every ingest span (`transport.ts:218`). Work B installs a new ingest span on the read path;
at the default it tells a deterministic clock that a delivery happened on the EOF read that
returns `null`. It must pass `seam = chunk !== null`, mirroring `wt.ts:924` exactly. Blast
radius bounded: five priced-clock sites exist (`loop-busy.test.ts:83`, `wt.test.ts:1086`,
`:1133`, `:1181`, `ws.test.ts:1516`), all on the datagram/message path, so omitting it breaks
nothing today and plants a mis-pricing that fires the first time someone prices a read.

**The constant.** `SESSION_LOOP_BUSY_MS_DEFINITION` (`transport.ts:131-136`) says "the
JavaScript event-loop time **this server** spent". Work B is about to charge a **client** read
into that figure, and work E fixes only the hand copy at `render-report.ts:233`. After E the
constant and its copy disagree, which is strictly worse than today where all three copies agree
and are wrong together. Schedule the constant, make it role-neutral, and derive the report
legend from it so a fourth copy cannot appear.

And E's phrase "and the frame documentation" points at
`server-snapshot-protocol.ts:60-79`, which I read again at HEAD: it is **correct**, scopes
itself to the server child, cites the constant rather than copying it, and already says the
thing this revision is trying to say. Name `transport.ts:131` instead.

---

## Answers to the questions the brief asked

**1. Is the blast radius real — or does some path already attest a receive-side figure?**
Already attested, and the plan is right to have retracted r1's claim. Every sealed
`bulk-one-way/physical` arm carries `loopUtilization.perSession`, which is the *client's*
loop (`arm-measure.ts:228-232` refuses a missing **consumer** loop), and `artifact-builder.ts:536-541`
declares both scopes. The gap is not latent: it is `54.94` against `0`, sealed, three times.
Direction B is attested too, via `onRelayWork` → `createCohortServerLoopObserver` (C1).

**2. Can charging `readChunk` over-charge a reader that waits?** At the Node arrival bodies,
no — they are synchronous callbacks and nothing suspends inside them. At `wt.ts:1251` there is
no arrival body at all, and the two type-clean implementations available there are wrong by
200× in opposite directions. **That is the plan's single most dangerous instruction** (C2).
The idle-reader test in the acceptance is the right guard for the over-charge half, and it is
the strongest line in the document; it does not catch the `measure(async …)` under-charge half,
which needs the discipline named in prose.

**3. Can the change break the server child's monotonic reading, or live/closed conservation?**
**No, and I verified this rather than inheriting it.** `busyMs` is minted as
`finalBusyMs - baselineBusyMs` (`server.ts:2572`) from two reads of one accumulator, so the
conservation checks at `secure_fs.rs:17789-17800` and `server-snapshot-protocol.ts:176-179`
are tautological on the honest path. `onSessionClose` (`wt.ts:1655-1664`) removes from the live
set and accumulates into `closedServerBusyMs` in one synchronous step, `closedServerBusyMs`
only grows, live meters only grow (`transport.ts:172`, "only ever grows"), and `Math.floor` is
monotone — so `serverLoopUtilization()` (`wt.ts:1666-1678`) cannot go backwards and
`server.ts:2529` cannot fire from this. W7's re-diagnosis is correct: the hazard is **silent
loss**, not refusal, and D is aimed correctly. One thing D should say that it does not: **work
B is what creates the post-close arrival**, since a read in flight at close resolves into a
meter nothing reads. B and D are coupled and the plan lists them as independent.

**4. Can the two transports be compared after the change?** On the Phase-A client leg, yes —
as loop occupancy, never as cost, and the plan is honest about that. On the fanout server,
**no**, and the plan leaves it that way: the WT peer will still omit ~420 ms/minute of JS the
WS peer never performs (C1). The comparison is meaningless again in exactly the direction the
title claims to cover.

**5. Does the plan risk invalidating the sealed A5 arm?** **No, for the arm itself, on two
independent grounds I checked.** Work A touches only `ws-worker` and `wt-stream-sink`, which
`ARM_WIRE` / `ARM_READ_PATH` (`evidence.ts:238-252`) show are separate arms from the `ws` and
`wt` A5 arms. Work B touches `wt.ts` only, and the sealed `26.3125` is a WS figure whose
`serverAggregate 1 / 977` is a send-side server reading. There is no sealed WT arm to
invalidate — every WT arm on disk reads `0`. **Yes, for acceptance bullet 3 as literally
worded** (C4).

**6. Can the surface table be satisfied vacuously?** **Yes, twice.** By driving one of six
`read` implementations under a name-keyed row (C6), and by classifying a genuinely-charged-
upstream seam into whichever of three ill-fitting classes makes the test green (C5).

**7. Is the explicit non-parity test a good idea, or a way to bless a broken metric?** The idea
is right; the form blesses. I confirm the Architect's R3 — "a test asserts the opposite is
**acceptable**" either pins WT ≈ 0 as the specification or asserts nothing — and I add the
reason it matters most here: C1 shows the metric **is** broken in the other direction, so a
test that pins "WT receive ≈ 0 is correct" institutionalises the exact reading that is wrong
on the fanout server. Give it a ceiling instead: for a receive-only arm of the sealed shape,
the WT `perSession` figure is expected in the single-digit milliseconds, and a reading in WS's
order is a **failure signal** that refuses the run pending an explanation of where the
milliseconds came from.

**8. Is not charging WebSocket `acceptUni` correctly justified?** **Yes, and it is the plan's
soundest technical judgement.** `ws.ts:1998-2001` constructs the channel and pushes the accept
queue inside `dispatchSocketMessage`, which is the body of `busy.measure("ingest", …)` at
`:1865`, with no method boundary between them. Charging `acceptUni` would double-count and
would move the sealed `26.3125`. W3 is right, it correctly reverses revision 2's
transport-blind instruction, and it correctly reverses my own r1. The only thing missing is a
place to write it down — C5's fourth class.

---

## Corrections to the Architect's r3

- **R6's branch conclusion is right; its reasoning is not, and the difference matters.** He
  argues `:1251` takes the WHATWG branch because "a WHATWG stream has `getReader`" — but
  `makeReceiveChannel` receives an *item* off that stream, not the stream. The proof is that
  the item type is `WebTransportReceiveStream = ReadableStream<Uint8Array> & …`
  (`packages/webtransport/src/index.ts:949`, `:2241`, enqueued at `createServerIncomingUniStreams`).
  Stated his way, an implementer checking the claim against `wt.ts:94`'s `ReadableStream<Readable>`
  will conclude he is wrong and meter the dead branch.
- **R1 understates its own case.** He names `frames.push` and stops. `relayFrameRoutingFields`
  at `server.ts:1126` is a second uncharged body on the same loop iteration and is the more
  expensive of the two (247 ms against 171 ms at 600k frames). And he does not establish that
  `onRelayWork` is wired in production (`server.ts:3036`), which is what makes R1 blocking
  rather than theoretical.
- **`readFromStream` is `:468`**, not `:471`.
- **His `0.3` arithmetic is right** and supersedes my r2 K3 as far as it goes: the detector
  fires on the `measureRead` shape (ratio → 1.0) and is blind to a 50 ms partial inflation
  (~0.022). The plan's risk bullet 3 already states exactly this and should keep it.

## Corrections to my own r2

- **K1's demand to "name the live `readChunk` branch per construction site" is now answered,
  by me, and the answer is that the plan's implied single branch does not exist.** Retired as
  an ask, reopened as C2.
- **K2's replacement bar is the right one and revision 3 adopted only half of it** — it took
  the non-parity framing and dropped the ceiling. That half-adoption is C7's sibling, R3.

---

## What would make this APPROVED

1. Restore the fanout relay as a W-item: charge `frames.push` (`server.ts:1116`) and
   `relayFrameRoutingFields` (`:1126`), or state the deferral with its measured magnitude and
   narrow the title and acceptance off direction B (C1).
2. Rewrite work B's charge site: name the three arrival bodies, say which construction site
   reaches which, require `open`/`pause`/`resume` and forbid both `measure(async …)` and a
   bare `open` around an `await`, and fix the type declarations at `wt.ts:94` and `:1251` (C2).
3. Say what replaces the `ws-worker` charge after work A removes `measureRead`, so the arm does
   not report zero for JavaScript frame decode on its own loop (C3).
4. Replace acceptance bullet 3's "reproduced" with per-seam evidence that no contributing seam
   changed charge; keep the figures as provenance (C4).
5. Add work C's fourth class, **charged upstream at `<file:line>`**, with the test checking
   both halves, and decide the WT stream-accept rule explicitly (C5).
6. Key work C on construction sites, enumerate the three decorators, correct the seam counts to
   six and five, and make `makeBidiChannel`'s meter parameter required (C6).
7. Add `seam = chunk !== null` to work B; schedule `SESSION_LOOP_BUSY_MS_DEFINITION`
   (`transport.ts:131`) and derive the report legend from it; drop
   `server-snapshot-protocol.ts:60-79` from work E's target (C7).
8. Give the non-parity acceptance a ceiling with a large WT receive figure named as the failure
   signal, and state that work B creates the post-close arrival work D must handle.
