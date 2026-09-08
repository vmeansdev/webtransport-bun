CHANGES REQUIRED

# Critic review (revision 5) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed by me, before reading) | `77cd84b165cdc3f38b56a3e4186ca3ec3b1403d8c7f8f1d7d49cb7b51b75d2e5` |
| Declared SHA-256 | identical — verified first |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | `git status --porcelain` → untracked evidence and review files only; **0 tracked modifications**. Git used read-only. Only this artifact written |
| Prior artifacts read | my r1–r4; Architect r5 |
| Method | every `file:line` the plan cites read at HEAD; `bun test adapters/loop-busy.test.ts adapters/read-path-adapters.test.ts` → **29 pass / 0 fail**; item A re-priced by execution on the real `LengthPrefixedFrameReader` with a real 675-byte `FanoutDataV1`; **`readChunk`'s WHATWG branch decomposed and metered in four shapes at the plan's own workload**; every sealed `bulk-one-way/physical` artifact on disk re-parsed; `acceptUni` and `read` enumerated by grep rather than by eye |

**Four of my six r4 blockers are discharged, and two of them mattered.** K1 is fixed
correctly and completely: W2 and item B now name **both** sink arms
(`ws-worker.ts:298-302` **and** `wt-stream-sink.ts:345-348`), and I verified both override
`loopUtilization` wholesale off `worker.stats()`. K2's withdrawal is right and I re-proved
it against myself: `wt.ts:194-198` is an arrival continuation, and metered at 1600 × 64 KiB
it charges **0.217 ms** — my r4 "no arrival callback at all" was wrong. K6 is discharged: D
now names the `seam = chunk !== null` flag and F now names `transport.ts:131-136`. The
`:1118` slip is fixed.

**It is refused on four grounds.** Two are carried from r4 and undischarged. Two are new,
and one of them I found by decomposing the very measurement R5 built its ceiling on: **item
C charges about 3% of the loop work the WT read path actually does, and item E's 5 ms
ceiling sits below the honest complete charge — so the ceiling admits the wrong shape and
refuses the right one.**

---

## Facts checked at HEAD

Every claim the brief named, and every citation the plan makes.

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `result.reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** `makeReceiveChannel(readable: Readable, clock: TransportClock)` — no meter parameter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `grep '"ingest"'` over the tree returns `ws.ts:1865`, `wt.ts:924`, and two lines of `transport.ts` that define the kind. `:924` is the envelope pump |
| `acceptUni` has exactly one production caller (`client.ts:883`) | **True** — every other reference is an implementation or a decorator delegating to `base.acceptUni` |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) | **False.** `:383-395` is `echoSession`, Phase A. The plan does not claim it; the brief still carries it |
| WS server ingests through its message callback (`server.ts:670`) | **True**, and `:670-680` puts `handleInboundBytes` + `pump` inside `timed()`; no reassembly, no routing decode |
| Sealed artifact carries only server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False.** `:536-542` declares `perSession` **and** `serverAggregate`; `:786-802` validates window finiteness on both. The plan does not claim it |
| No gate constrains `busyMs` | **False as stated; true only of magnitude.** `arm-measure.ts:229-244` refuses a missing or non-finite `perSession` and a non-positive window, `:707-722` does the same for the server snapshot, `server-snapshot-protocol.ts:176-179` pins `busyMs = finalBusyMs − baselineBusyMs`, `server.ts:2529-2536` refuses a backwards loop, `render-report.ts:48` caveats at `0.3`. **A zero passes every one of them** — which is why the sealed WT zeros exist. The plan does not claim it |
| W1: `frames.push` at `server.ts:1118`, `relayFrameRoutingFields` at `:1126`, both outside `timed()` | **True.** One slip: the span opens at **`:1119`**, not `:1120` |
| W1: `onRelayWork` production-wired at `:3036`, forwarded at `:1203` | **True** → `loop.record` → `createCohortServerLoopObserver`. Phase B, production |
| W1: the inbound rate at `:1126` is 10 k/s | **True, and independently corroborated.** `scenario-registry.ts:256-263` is `ingressRatePerSecond: 10_000`, `publisherCount: 1`, `fanout: 100`. The WT relay has exactly **one** inbound path (`grep handleInboundBytes` → `server.ts:674` WS, `server.ts:1120` WT), so every publisher data frame crosses `:1118`/`:1126`. And `server.ts:820-822`'s own arithmetic — "180 ms … per second" at 18 µs — is 10 k/s. **A4's rate half is right and R5 was right to keep it** |
| W2: `sink-worker.ts:222-229` `measureRead` wraps the whole `await`; call site `:320` | **True**, verbatim |
| W2: **both** arms discard the base meter | **True on both**, read at HEAD. K1 discharged |
| W3: `ws-worker.ts:11-17` — no worker thread | **True.** "there is no worker thread, because `node:worker_threads` is a forbidden import on a role-child module" |
| W4: `:1569` Node (`streams.ts:396` `class RecvStream extends Readable`); `:1251` WHATWG (`index.ts:949`, `:2241`); `wt.ts:94` misdeclares; `:1252` casts | **True on all four** |
| W4: the arrival costs 0.179 / 0.253 ms | **Reproduced: 0.217 ms** (WHATWG, 1600 × 64 KiB). Same order. R5's withdrawal is correct and my r4 was wrong |
| W5: `wt.ts:454` and `:1306` take a meter, use it for `write`/`end`, not `read` | **True**, verbatim at `:426-429`, `:437`, `:452`, `:453-455`; and `:1303-1308` |
| W5: eleven implementations — six `read`, five `acceptUni` | **False, and self-contradicting.** See C3 |
| W6: WS `read`/`acceptUni` are "already charged inside the `:1865` span" | **Half true.** The *producing* half is (`:1990-2001`, channel construction and `tryPush`, no method boundary between `:1870` and `:2010`). The *consuming* half is not: `acceptUni` (`:1644-1653`) is `waitForQueue` + `releaseAcceptReservation`, and `read` (`:2146-2161`) is `waitForQueue` + `reservation.release()`, both on the consumer's own loop turn, outside any span. See S3 |
| W7: `render-report.ts:233` calls the scope the server's; `transport.ts:131-136` says "this server" | **True on both** |
| W8: conservation and monotonicity cannot break | **True, re-verified.** `busyMs` minted at `server.ts:2572` as one difference of one accumulator; `LoopBusyMeter.totalMs` only grows (`transport.ts:172`, `:227`); `onSessionClose` (`wt.ts:1655-1664`) deletes from the live set before accumulating and no-ops on a repeat. The residual hazard is **silent loss**, not a backwards read |
| W9: `65 / 1250` at `cohort-fixture-signing.ts:196-198` | **True** (`busyMs = 65`, `spanMs = 1_250`), and present in three sealed artifacts on disk |
| Acceptance 6: four sealed WS arms 26.3125 / 40.0815 / 45.0754 / 54.9424 | **True, re-parsed off disk.** And **three sealed WT `bulk-one-way/physical` arms read `perSession.busyMs` exactly `0`** over 2.22 / 2.26 / 2.45 s windows |
| Baseline suites | **29 pass / 0 fail**, reproduced |

---

## Blocking findings

### C1. Item C charges ~3% of the read path, and item E's ceiling refuses the honest charge

This is the plan's central deliverable and it is the one I can refute by execution.

C says: "Charge the arrival continuation on each, with the same discipline." E calibrates
its ceiling to that: "5 ms, which is roughly twenty times the measured 0.179 and 0.253 ms."
So the plan's charge is scoped to the arrival body, and its guard is scoped to the same
quantity.

**`readChunk`'s WHATWG branch does most of its synchronous loop work outside that body.**
Read at HEAD, `wt.ts:180-204`, per call:

```
reader = readable.getReader()                    // caller's turn, before the await
new Promise(... setTimeout(reject, remaining))   // caller's turn
reader.read().then(res => res.done ? null : ...) // <- the ONLY thing C charges
await Promise.race([readPromise, timeoutPromise])
finally { clearTimeout(timer); reader.releaseLock() }  // caller's turn, after the await
```

I metered the three parts separately with plain `performance.now()` — no meter object, so
the numbers are not meter overhead — at the plan's own stated workload, 1600 chunks of
64 KiB, `bun` 1.3.14, two runs:

| Part | zero-wait source | 1 ms-paced source |
| --- | --- | --- |
| arrival body — **what C charges** | 0.062 / 0.064 ms | 0.191 / 0.167 ms |
| caller-turn setup — uncharged by C | 3.408 / 4.560 ms | 14.10 / 8.91 ms |
| caller-turn teardown — uncharged by C | 1.782 / 2.231 ms | 27.03 / 18.93 ms |
| **total synchronous loop work** | **5.25 / 6.86 ms** | **41.3 / 28.0 ms** |

**C charges between 0.4% and 3.6% of the loop time the read path spends.** The remainder is
not waiting — it is `getReader`, a `Promise` construction, a `setTimeout`, a `Promise.race`,
a `clearTimeout` and a `releaseLock`, executed synchronously on the JavaScript loop, 1600
times. Under `SESSION_LOOP_BUSY_MS_DEFINITION` — "the JavaScript event-loop time … spent on
this session's transport work, ingest and egress" — every one of them is in scope, and the
WS counterpart (frame decode, channel construction, queue push) is charged **in full**
inside `:1865`. Excluding it on WT while charging it on WS is the asymmetry the plan exists
to close, reproduced inside the fix.

**The correct discipline is already in the codebase and C does not use it.**
`transport.ts:197-199` documents it — "the caller pauses it before every `await` and closes
it in a `finally`, so suspended time is never charged" — and `LoopBusySpan` exports
`pause`/`resume` for exactly this. Metered:

| Shape | zero-wait | 1 ms-paced (1,600 ms of real waiting) |
| --- | --- | --- |
| span held **across** the await (the shape Risk 2 fears) | 3.088 ms | **2,346 ms** |
| **`open` → `pause` → await → `resume` → `close`, arrival body inside** | **5.757 / 8.265 ms** | **48.9 / 33.9 ms** |
| C as written (arrival body only) | 0.06–0.22 ms | 0.17–0.19 ms |

The disciplined shape charges 48.9 ms of 1,600 ms of waiting — 3% — so **it does not
over-charge a reader that waits**, which is the brief's second question answered in the
plan's favour for a charge the plan does not propose.

**Now the contradiction.** The plan's ceiling is **5 ms at 1600 × 64 KiB**. At that
workload:

- the honest, complete charge is **5.76–8.27 ms** even with a source that never makes the
  reader wait — **it fails the ceiling**;
- the dishonest span-across-the-await charges **3.09 ms** against a source that never makes
  the reader wait — **it passes the ceiling**.

**The ceiling is inverted at the workload the plan states.** It refuses the correct answer
and admits the wrong one. And the plan's separation argument — "far below the 52.4 ms a
span around the await would produce" — is not a property of the stated workload: I could
not reproduce 52.4 ms at either pacing I tried, getting 3.09 ms and 2,346 ms, three orders
of magnitude apart, because **arrival pacing is the variable and the plan does not pin it.**

That is a second, independent vacuity route, and it is the one an implementer will take by
accident. This repository's loop-busy tests run on `pricedClock` (`loop-busy.test.ts:64-96`),
whose `nowMs` advances **only** when a seam fires or `sleep` is called. Under that clock a
span held across an await charges exactly what a paused one charges, because no time passes
during the await. **On the house-style clock the ceiling cannot discriminate at all.** The
plan does not say whether E's test is wall-clock or deterministic, and both readings defeat
it: deterministic makes it blind, wall-clock at zero pacing makes it inverted.

Acceptance bullet 5 says "no pinning of a low figure as correct." Item E does precisely
that, at a value I measured to be below the truth.

**Fix.** Say that C charges `readChunk`'s synchronous work on **both** sides of the await
using `pause`/`resume` — the discipline `transport.ts:197-199` already names — not the
arrival body alone. Re-derive E's ceiling against that quantity (my zero-wait measurement is
5.8–8.3 ms; anything you pin must be above it and far below the paced dishonest 2,346 ms),
and state the arrival pacing and the clock the ceiling test runs on. If the plan instead
intends to charge only the arrival body, it must say so explicitly and say that the
published WT receive figure is a stated fraction of the read path's loop work — because
after C as written, a 100 MiB WT receive would attest ~0.2 ms while WS attests its ingest in
full, and the report would present that as the asymmetry closed.

### C2. The 18 µs upper bound prices `codec.decode` — the design that docstring exists to reject

The plan's headline is "**between about 1 second and about 10.8 seconds of loop time per
minute**", and work A instructs the implementer to "cite the repository's own 18 µs per
frame." 10.8 s is 18 µs × 600 k.

`server.ts:812-822`, read whole:

> Neither is a trust boundary, and running **`codec.decode`** at either re-parsed,
> re-canonicalised and byte-compared the frame a second time … Measured on the chat-1k
> loopback acceptance (2026-09-05): **18 us a frame against 1.1 us for the stream write it
> chose** …

18 µs prices `codec.decode` — the alternative the docstring is written to justify
**rejecting**. What runs at `:1126` is the cheap replacement at `:829-860`:
`DataView.getUint32`, one `TextDecoder.decode`, one `JSON.parse`, one destructure.

**I measured it rather than arguing grammar.** Real `LengthPrefixedFrameReader`, a real
675-byte `FanoutDataV1` (`publisher-000001`, 128-byte payload), 600 k frames, warmed:

| Arrival pattern | `frames.push` | routing decode | total | per frame |
| --- | --- | --- | --- | --- |
| 1 frame per stream read | 350.4 ms | 661.4 ms | **1,011.8 ms** | 1.686 µs |
| 16 frames coalesced | 207.1 ms | 787.9 ms | **995.0 ms** | 1.658 µs |
| plan (r5) | — | — | 1,028–1,043 ms | ~1.72 µs |

**Item A's headline number reproduces** — within 3% of the plan's, on my own bench, against
a frame I built from the repo's own encoder. And the routing decode alone costs **1.10–1.31
µs**, which is the docstring's own neighbouring figure of "1.1 µs", 14× below 18 µs.

So the plan's upper bound is ~10× high **by citation**: a number that carries a `file:line`,
reads as evidence, and prices a different operation. In a campaign whose subject is whether
a published figure names the work it did, that is the defect under repair appearing in the
repair — and work A schedules its publication into the report.

**This originates with me and I want that on the record.** My r4 K4 asserted the 18 µs
attribution as a blocking finding and demanded R5 reconcile against it. R5 reconciled by
adopting it. The plan is being refused for taking my word, which is my fault and not the
plan's.

**Fix — one sentence.** Strike the 10.8 s/min upper bound and the instruction to cite 18 µs,
or relabel it explicitly as the counterfactual price of the rejected `codec.decode` design.
The finding survives intact on its own measurement: **~1.0 s of loop time per minute**
against the WT child's ~16.3 s/min of charged relay work (`server.ts:821-822`, 271 ms/s) —
a ~6% correction, still the largest single item in the plan and still correctly first.

### C3. The census is a hand count, it is short, it contradicts itself, and completeness is still underived

My r4 K3 asked for four things. R5 delivered two — the key is now construction site and
seam, which is the right key and a real improvement, and `wt.ts:454`, `:1306`, `:1242`,
`:1566` all now have a stated disposition. **The other two are untouched.**

W5: "Eleven implementations exist: six `read`, **five `acceptUni`, counting the three
production decorators**." One grep:

```
adapters/ws.ts:1644              async acceptUni(...)
adapters/wt.ts:1242              async acceptUni(...)
adapters/wt.ts:1566              async acceptUni(...)
adapters/ws-worker.ts:255        async acceptUni(...)                    decorator (wrapReceive)
adapters/wt-stream-sink.ts:305   async acceptUni(...)                    decorator (wrapReceive)
bin/compare-controller.ts:804    acceptUni: (deadlineMs) => base.acceptUni(deadlineMs)   decorator
```

Three bases plus three decorators is **six**. The plan's five can contain at most two
decorators, so its own qualifier — "counting the three production decorators" — is false
about its own list. The omission is `bin/compare-controller.ts:804`, a full session
decorator on the production controller path, which I named with its `file:line` in r4 and
which is unchanged at HEAD.

**The `read` half is short by the same mechanism.** `wrapBidi` emits a second `read` on each
decorator — `ws-worker.ts:228` and `wt-stream-sink.ts:278`, both
`read: (deadlineMs) => receive.read(deadlineMs)` — so a mechanical enumeration of channel
`read` implementations returns **eight**, not six. Under a key of construction site, which
D correctly adopts, those are distinct sites and must appear.

**The number is not the finding.** The finding is that acceptance bullet 3 pins it —
"Every one of the **eleven** implementations appears in the table" — so a table with eleven
rows passes while three live seams are absent, and D says only "Three tests: completeness,
…" without ever saying **what completeness is measured against**. If it is a
hand-maintained list, the list and the table go stale together and the test is vacuous in
exactly the way D exists to prevent. Every defect in this plan is a hand-placed thing gone
stale: a `timed()` boundary drawn in the wrong place (`:1119`), a meter passed and used for
two seams of three (`wt.ts:426-454`), a meter parameter omitted (`makeReceiveChannel`), an
override written by hand (both sink arms). A hand-maintained census is the fifth instance,
installed as the cure.

**Fix.** State that the census is derived from a scan of the source or carried by the type
system; strike "eleven" from acceptance bullet 3; add the three missing sites or state the
delegator rule that excludes them (noting it cannot exclude `ws-worker.ts:255` or
`wt-stream-sink.ts:305`, which do real work through `wrapReceive`); and schedule the
structural half that has never been scheduled — **make the meter parameter required** on
`makeReceiveChannel` and on `makeBidiChannel` (`wt.ts:426-429`, `busy?`), which is what let
W5 happen in the first place and which converts D from an audit into a mechanism.

### C4. Acceptance bullet 6, read literally, refuses item C

> "No seam that contributed to an already sealed figure changes charge."

The seam `wt.ts:417` `makeReceiveChannel.read` **is** the seam that produced the sealed WT
zeros. I re-parsed the disk: `bulk-one-way/physical` WT arms are sealed at
`perSession.busyMs = 0` under `cc866b8b…`, `8ada2d1b…` and `f9d0cd54…`, each beside a
sealed WS arm. Item C exists to change that seam's charge. Under the bullet as written, C
cannot ship.

The intent is plainly the WS arms — the second sentence names their four values — but an
acceptance criterion is the contract an implementer executes, and this one contradicts the
plan's principal work item. It also under-states a real consequence the plan should own:
after C, no future WT arm is comparable to the three already-sealed WT zeros, and the report
must say so rather than presenting a step from 0 to a positive figure as a measured change
in the system.

**Fix — one clause.** Say "no seam that contributed a **non-zero** charge to a sealed
figure", or name the WS arms directly, and add a sentence that the sealed WT zeros are
superseded rather than contradicted.

---

## Answers to the questions the brief asked

**1. Is the blast radius real, or does some path already attest a receive-side figure?**
**Attested, not latent, and both ways at once.** Three sealed WT `bulk-one-way/physical`
arms carry `perSession.busyMs` exactly `0` over 2.2–2.4 s windows, against WS's 26.3 / 40.1
/ 45.1 / 54.9; every structural gate passes a zero (`arm-measure.ts:229-244` refuses
*missing*, never *small*). And a receive-side figure **is** already attested on the sink
arms — through `measureRead`, which charges suspension, so the one path that attests a
receive figure attests a wrong one. Direction B is attested too, via `onRelayWork` →
`createCohortServerLoopObserver` (`server.ts:3036`). The gap is in signed artifacts, on both
sides.

**2. Can charging `readChunk` over-charge a reader that waits?** **No — for the charge the
plan should make, and I measured it.** The disciplined shape (`open` → `pause` → await →
`resume` → `close`) charges 48.9 ms against 1,600 ms of real waiting: 3%. Suspension is not
charged. The hazard was never the site, it was the shape. C's naming of the prohibition and
its carrying of the 52.4 ms counter-example remain the plan's single best improvement over
r3 — but C then applies the prohibition so narrowly that it discards 96–99% of the honest
charge (C1).

**3. Can this break the child's monotonic reading, or live/closed conservation?** **No, and
I re-verified rather than inheriting it.** `busyMs` is one difference of one accumulator
(`server.ts:2572`); `LoopBusyMeter.totalMs` only grows; `onSessionClose` (`wt.ts:1655-1664`)
deletes from the live set before accumulating and no-ops on a repeat, so
`serverLoopUtilization()` (`:1666-1678`) cannot double-count or go backwards;
`server.ts:2529` cannot fire from this change. The residual hazard is **silent loss** of a
charge that lands after close — and C is what creates that post-close arrival, since a read
in flight at close resolves into a meter nothing reads. W8 says exactly this and is right.
C and W8 are coupled and the work items still list them apart.

**4. Can the two transports be compared after the change?** **On the fanout server, yes, and
for the first time** — item A makes the peer that does the JavaScript pay for it, which is
what the definition says `busyMs` is, and A's location and magnitude both check out (C2 is
about the *citation*, not the finding). **On the Phase-A client leg, no — and this is the
part the plan believes it fixes and does not.** After C as written, a 100 MiB WT receive
attests ~0.2 ms while the WS peer attests its ingest in full; the honest WT figure at that
workload is 5.8–8.3 ms and the plan's own ceiling would refuse it. The comparison would be
declared closed while 96%+ of the WT side stayed off the books (C1).

**5. Does the plan risk invalidating the sealed A5 arm?** **Not the WS arm, on three checks
— but the acceptance bullet that says so is written in a way that refuses the plan.** A
touches the Phase-B fanout relay (`timed()` exists only in the two fanout peers); A5 is
`bulk-one-way/physical`. B touches `ws-worker` and `wt-stream-sink`, which `ARM_WIRE` /
`ARM_READ_PATH` (`evidence.ts:238-252`) make separate arms from the `ws` primary. C touches
`wt.ts` only. The sealed WS figure's own contributing seams stay at their present charge —
**provided** the taxonomy does not force `ws.ts:2146`/`:1644` into an *ingest* row, which
would double-count into 26.3125. The exposure is the sealed **WT** zeros, and it is
deliberate (C4).

**6. Can the surface table be satisfied vacuously?** **Yes, four ways, and two are new since
r4.** (a) The count is wrong and acceptance bullet 3 pins it, so eleven rows pass with three
live seams absent (C3). (b) Completeness has no stated derivation, so a hand list and the
table go stale together (C3). (c) The ceiling in E passes the dishonest shape at 3.09 ms and
fails the honest one at 5.8–8.3 ms on a zero-wait source, and cannot discriminate at all on
the deterministic clock this repo's loop-busy suite actually uses (C1). (d) Cell three,
*charged-at-another-seam-naming-that-seam*, is satisfiable while the seam it names covers
only part of the row's work — see S3.

---

## Where I correct the Architect's r5

- **A5-1 and A5-2 are both right and I reproduce both.** The census is short by three by my
  own grep; the 18 µs prices `codec.decode` by my own reading and my own 1.10–1.31 µs
  measurement of the replacement. I adopt both as C3 and C2.
- **His scope probe is right and worth keeping.** I re-checked it: `relayFrameRoutingFields`
  at `:1027` runs inside `sink.trySend` → `relay.pump()`, and the relay entry points in
  `server.ts` are inside `timed()`. At `fanout: 100` a missed delivery-side site would have
  been 100× the headline. It is not missed.
- **He under-states C.** He calls the honest WT arrival charge "essentially the meter's own
  overhead" and asks only that the report not be *read* as if the gap were closed. That
  concedes the number. The number is not 0.179 ms — it is 5.8–8.3 ms at the same workload,
  and the plan's ceiling refuses it (C1). His "acceptance bullet 4 is now reachable at both
  sites" is true of the fragment and false of the quantity.
- **His withdrawal on acceptance bullet 1 is right and I withdraw mine too.** At 1.67 µs a
  frame, driving 100 k frames moves ~167 ms of charge — orders above timer noise, so bullet 1
  is deterministic without clock injection. Say the frame count in the plan.

## Smaller items — worth taking, none blocking alone

- **S1. The `timed()` span opens at `server.ts:1119`, not `:1120`.** W1 says `:1120`, which
  is `relay.handleInboundBytes` inside the callback.
- **S2. Item A should say the `await inbound.read()` at `:1116` stays outside the span** —
  the one line in that loop that must not be charged.
- **S3. W6 over-claims, and cell three inherits it.** "`WsChannel.read` and
  `WebSocketAdapter.acceptUni` are transport work already charged inside the ingest span" is
  true of the *producing* half (`:1990-2001`) and false of the *consuming* half:
  `acceptUni` (`:1644-1653`) and `read` (`:2146-2161`) are `waitForQueue` dequeues on the
  consumer's own turn, enclosed by nothing. The residual is the same order as the WT arrival
  body I metered (~0.1–0.5 ms per 1600), so this is a truthfulness defect in the taxonomy,
  not a magnitude one — but a cell named *charged-at-another-seam* must not be usable by a
  row the named seam only partly covers. Charging it is **not** the fix: that would add to
  the sealed 26.3125. Say instead that the enqueue is charged at `:1865`, that the dequeue is
  deliberately uncharged to hold the sealed figure, and give its measured size.
- **S4. B's correctness on the WT arm depends on C landing for stream-shaped workloads.**
  `wt-stream-sink`'s base is the WT primary, whose only ingest span is the envelope pump at
  `wt.ts:924` — which does cover the live `ticker-fanout/rate-10000/wt-stream-sink` arm,
  since that arm reads messages. For a channel-read workload the restored base meter charges
  nothing until C. An implementer who does B first, sees the new zero-guard test red, and
  "fixes" it by keeping the suspension charge has undone the plan. One sentence.
- **S5. Say B deletes the override rather than recombining terms.** Both arms compute
  `windowMs` from `sessionOpenedAtMs` (`ws-worker.ts:301`, `wt-stream-sink.ts:347`) while
  `LoopBusyMeter` computes it from meter construction (`transport.ts:167-168`). A base-meter
  numerator over a worker-computed denominator is a unit mismatch feeding the `0.3`
  detector. Dropping the `loopUtilization` key and letting `...metrics` through has no
  mismatch.
- **S6. Two docstrings cite the reading B deletes**: `server.ts:556-558` and `:1256-1257`
  both name `adapters/sink-worker.ts:227`.
- **S7. C implies a type change the plan does not name.** Fixing `wt.ts:94` and removing the
  `as unknown as Readable` cast at `:1252` means `makeReceiveChannel(readable: Readable, …)`
  no longer accepts that site; the honest repair is a union there and at
  `readChunk(readable: any, …)` (`:178`). Typing that parameter is what makes the two
  branches visible to the compiler instead of to a duck-type check — the same structural
  point as the required meter in C3.
- **S8. F leaves the definition hand-copied.** F schedules both `transport.ts:131-136` and
  `render-report.ts:233` in one change so they "agree", which discharges my r4 ask; it does
  not make them **unable** to disagree, since `:233` stays an independent string. Import the
  exported constant into the report legend. (The brief says "cannot disagree"; the plan says
  "agree" — the plan is the weaker text.)
- **S9. `seam = chunk !== null` is classified in D but instructed nowhere.** D is the
  taxonomy item; C installs the span. One clause in C — "pass `seam = chunk !== null`, as
  `wt.ts:924` does for `envelope !== null`" — closes it. This matters more than it looks:
  under `pricedClock` a defaulted `seam = true` on the read path advances the fake clock on
  every read, including the EOF read that returns `null`.
- **S10. C's singular "the arrival continuation" hides a third arrival body.** The Node
  branch's nudge at `wt.ts:239-250` is unreachable on a real `Readable` because
  `readable.once("data", onData)` at `:236` sets `readableFlowing` true before the guard is
  evaluated — but `readable.once?.` is optional-chained, so a duck-typed stream without
  `.once` reaches it live and unmetered. Say it.

---

## What would make this APPROVED

1. Scope C to `readChunk`'s synchronous work on **both** sides of the await, using the
   `pause`/`resume` discipline `transport.ts:197-199` already documents — not the arrival
   body alone. Re-derive E's ceiling against that quantity (above my 5.8–8.3 ms zero-wait
   measurement, far below the paced dishonest 2,346 ms), and state E's arrival pacing and
   whether its test runs on wall time or `pricedClock`. If C is meant to charge only the
   arrival body, say so and say what fraction of the read path the published figure is (C1).
2. Strike the 10.8 s/min upper bound and the instruction to cite 18 µs, or relabel it as the
   counterfactual price of the rejected `codec.decode` design. ~1.0 s/min stands on its own
   and I have reproduced it at 1.66–1.69 µs a frame (C2).
3. State how the census is derived rather than counted, strike "eleven" from acceptance
   bullet 3, add `bin/compare-controller.ts:804`, `ws-worker.ts:228`,
   `wt-stream-sink.ts:278` or state the delegator rule, and schedule the required meter
   parameter on `makeReceiveChannel` and `makeBidiChannel` (C3).
4. Fix acceptance bullet 6 so it does not refuse item C, and own the superseding of the
   three sealed WT zeros (C4).

Nothing else blocks. Items A and B are executable as written once C2 lands; the withdrawals
R5 made against r4 are both correct and I re-proved both against myself.
