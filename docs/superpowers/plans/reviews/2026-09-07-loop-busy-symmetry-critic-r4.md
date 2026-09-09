CHANGES REQUIRED

# Critic review (revision 4) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `dc68d47467617541ae6d68526c0529bb4e35c445b291722a37a505fd5ba9098c` |
| Declared SHA-256 | identical — verified before reading the plan |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | `git status --porcelain` → 81 untracked, **0 tracked modifications**; only this artifact written |
| Prior artifacts read | my r1, r2, r3; Architect r1–r4 |
| Method | every `file:line` the plan cites read at HEAD; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → **29 pass / 0 fail** (baseline reproduced); four executed probes — the three meter shapes, `readableFlowing` around `once("data")`, the relay reassembly + routing decode on the real `LengthPrefixedFrameReader` and a real `FanoutDataV1` frame, and **the WHATWG arrival body metered at the A5 workload**; all seven sealed `bulk-one-way/physical` arms on disk re-parsed. Git read-only |

**Five of my eight r3 asks are discharged, and one of them is the important one.** Item A is
restored, correctly located, and made the headline. The `26.3`-reproduction criterion is
gone and replaced with the per-seam formulation. Item B's premise — no worker thread, so the
base meter is the same loop — is sound, and I verified it. The three meter shapes are named
with their measured separation, which was the single most dangerous omission in r3. The
fourth taxonomy cell exists.

**It is refused on five grounds.** One is the question the brief put to me directly and the
answer is not the one the plan gives: **item B repairs one of the two arms it breaks.** One
is a premise I refuted by execution: the WHATWG branch does have an arrival point, and I
metered it at the plan's own workload. The other three are the taxonomy, the ceiling, and
item A's number.

---

## Facts checked at HEAD

Every claim the brief named, and every citation the plan makes.

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** `makeReceiveChannel(readable, clock)` takes no meter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True, and this is the strongest fact in the tree.** `grep '"ingest"'` over `adapters/` returns `ws.ts:1865` and `wt.ts:924` and nothing else. `:924` is the envelope pump. **No span anywhere encloses a WT stream read or a WT stream accept** |
| `acceptUni` has one production consumer (`client.ts:883`) | **True** — `acceptUni` then a `channel.read()` loop, 1600 iterations on the bulk arm |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) | **False** — that is `echoSession`, Phase A. The plan correctly withdraws it; the brief still carries it |
| WS server ingests through its message callback (`:670`) | **True**, and everything it does is inside `timed()` (`:642-650`): no reassembly, no routing decode |
| Sealed artifact carries only server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False** — `:536-541` declares `perSession` **and** `serverAggregate`; `:786-802` validates window finiteness on both. The plan no longer claims it |
| No gate constrains `busyMs` | **False**, and the plan correctly withdraws it: `arm-measure.ts:229-244` and `:708-720` refuse a missing/non-finite figure and a non-positive window, `server-snapshot-protocol.ts:176-179` pins the conservation identity, `server.ts:2529-2536` refuses a backwards loop, `render-report.ts:48`/`:123-128` caveats at `0.3`. None constrains **magnitude**: a zero passes every one |
| W1: `frames.push` and `relayFrameRoutingFields` outside `timed()`; `onRelayWork` wired at `:3036` | **True.** `:3036` → `loop.record` → `createCohortServerLoopObserver()` (`:2970`, defined `:1277`). Production, Phase B, forwarded to whichever peer the grant names |
| W2: `sink-worker.ts:222-229` `measureRead` wraps the whole `await`; call site `:320` | **True**, verbatim |
| W2: pinned by `read-path-adapters.test.ts:291` | **True** — `"snapshot publishes the reader's loop, not the base session's"` off a `readDelayMs: 5` script |
| W3: `ws-worker.ts:296-302` discards the base meter; `:11-17` says same loop | **True.** `:14-17`: "there is no worker thread, because `node:worker_threads` is a forbidden import on a role-child module" |
| W4: `:1569` takes the Node branch | **True, traced to source.** `packages/webtransport/src/index.ts:2815` yields `new RecvStream(...)`; `streams.ts:396` is `class RecvStream extends Readable` |
| W4: `:1251` takes the WHATWG branch | **True, traced to source.** `index.ts:2241` returns `ReadableStream<WebTransportReceiveStream>`; `:949` types that `ReadableStream<Uint8Array>`; `createServerIncomingUniStreams` (`:4455`) does `controller.enqueue(direct.readable)` |
| W4: `wt.ts:94` and the cast at `:1251` misdeclare it | **True** — `readonly incomingUnidirectionalStreams: ReadableStream<Readable>` at `:94`, `as unknown as import("node:stream").Readable` at `:1252` |
| W4: three meter shapes 0.273 / 52.4 / 0.012 | **Reproduced**: 0.221 / 52.686 / 0.014. See K5 for what the third number actually measures |
| W4: the WHATWG branch has "no arrival callback at all" | **FALSE. Refuted by execution — K2** |
| W5: six `read` implementations | **True**: `wt.ts:417`, `:454`, `:1306`, `ws.ts:2146`, `ws-worker.ts:203`, `wt-stream-sink.ts:253` |
| W5: five `acceptUni` implementations | **Short by one.** `bin/compare-controller.ts:804` is a sixth, on the production path |
| W6: `ws.ts:1998-2001` is inside the `:1865` span | **True, and I checked it by scan rather than by eye**: `awk` over `ws.ts:1870-2010` finds **no `await` and no `async`**. The WS accept and read path is genuinely enclosed. W6 is the plan's soundest technical judgement |
| W8: `busyMs` minted as `finalBusyMs - baselineBusyMs` (`:2572`); hazard is silent loss | **True** — re-verified, see answer 3 |
| W9: `65 / 1250` traces to `cohort-fixture-signing.ts:194-198` | **True** |
| Acceptance 6: four sealed WS arms span 26.3 to 54.9 | **True, re-parsed off disk**: 26.3125 / 40.08154 / 45.07544 / 54.94238, windows 954–962 ms. And **three sealed WT arms read `busyMs` exactly `0`** over 2.2–2.4 s windows |
| Baseline suites | **29 pass / 0 fail**, reproduced |

**Citation slip that is not cosmetic.** `frames.push` is at **`server.ts:1118`**; `:1116` is
`const chunk = await inbound.read()`. Item A's instruction is "bring [the thing at `:1116`]
inside the `timed()` span" — pointed as written, at the **await**. That is W2 recreated on the
producer item A exists to fix. One character of fix; leave it and the plan's headline
instruction is a trap.

---

## Blocking findings

### K1. Work B repairs one of the two arms it breaks, and the arm it leaves behind reports a hard zero

This is the brief's own question — *can item B leave the WS sink arm reporting zero?* For the
**WS** arm, no: B is sound and the architect's chain is right. For the **WT** arm, **yes**,
and the plan neither names it nor guards it.

`measureRead` has two consumers, and W2 says so itself: "used by `ws-worker` and
`wt-stream-sink`". Both import the same worker (`ws-worker.ts:29-33`,
`wt-stream-sink.ts:38-42` → `createSinkWorker`, `runSinkPump`). **And both replace the base
session's `loopUtilization` wholesale:**

```
ws-worker.ts:298-302        loopUtilization: { busyMs, windowMs: now - sessionOpenedAtMs }
wt-stream-sink.ts:345-348   loopUtilization: { busyMs, windowMs: now - sessionOpenedAtMs }
```

In both, `busyMs` is summed from `worker.stats()` — that is, from `measureRead` and nothing
else. Both guard only the never-read case (`if (readerWorkers.length === 0) return metrics`),
so once a reader has run, whatever the accumulator holds is published as a real figure.

Work B removes the charge from `measureRead` and restores the base meter **on `ws-worker`
only**. `wt-stream-sink` keeps its discard over a now-empty accumulator, so after B it
publishes `busyMs: 0` for a session whose base meter holds real egress and real envelope
ingest. That is a fabricated zero — the exact defect class the plan exists to remove, on the
sibling arm, created by the plan's own work item.

And it breaks the plan's own acceptance. Bullet 2 reads "**no arm** charges about zero for
work it demonstrably does" and then illustrates with only the WebSocket arm. Under its own
words the bullet fails on `wt-stream-sink`; under its illustration the bullet has been
narrowed to the arm that was fixed. Either the work is incomplete or the acceptance is
unachievable, and the plan does not say which.

`wt-stream-sink` is a live campaign arm, not a curiosity: `r1-manifest-red.test.ts:1374`
and `:1392` carry `ticker-fanout/rate-10000/wt-stream-sink`.

**Fix.** B must say what `wt-stream-sink` publishes after the change on the same terms as
`ws-worker`, and acceptance bullet 2 must name both arms.

### K2. C's premise is false, and I refuted it at the plan's own workload

W4, which C is built on:

> `wt.ts:1251` … takes the WHATWG branch, which has **no arrival callback at all**; the only
> thing there to wrap is the `await`.

The code at `wt.ts:194-198`:

```ts
const readPromise = reader
    .read()
    .then((res: { value?: Uint8Array; done: boolean }) => {
        return res.done ? null : (res.value ?? null);
    });
```

That `.then` body **is** an arrival continuation. It runs on the JavaScript loop after the
chunk lands, for exactly the same reason `onData` at `:220-224` does. The two branches differ
in the shape of the callback, not in kind.

I did not stop at the reading. I metered that body with the plan's own discipline, on the
plan's own workload — 1600 chunks of 64 KiB through a real `ReadableStream`, `bun` 1.3.14:

```
WHATWG branch, arrival body unmetered      busyMs 0
WHATWG branch, arrival body metered        busyMs 0.179   (1600 chunks)
```

Against the plan's own Node-branch figure of 0.253 for the same 1600 chunks. **The two
branches are the same shape at the same order of magnitude.** "Structurally unmeterable at
arrival" is not a property of the code; it is an artifact of reading `readChunk` as if the
`await` were the only thing on the branch.

Everything C builds on that premise inherits the refutation: the fifth label (K3), the
exemption from the ceiling (K4), and the row that fits no cell. The clean resolution is the
one the measurement points at — charge `:196-197` at its truthful ~0.18 ms, which puts the
WHATWG branch in the *ingest* cell, retires the fifth label, restores the ceiling's reach,
and makes C's two sites one rule instead of two.

### K3. The taxonomy is keyed on surfaces, and one surface now carries two opposite rules

Work D, line 102: "A taxonomy with four cells, **keyed on the surface**", covering "all six
`read` … implementations".

`wt.ts:417` is **one** `read` implementation — `makeReceiveChannel`'s — reached from **two**
construction sites, `:1251` and `:1569`, to which work C assigns **opposite** rules: charge
the arrival on one, charge nothing on the other. A table with one row per surface cannot
hold two cells for that row, and D's own tests then bear on it in contradiction: test 2
requires an *ingest* row to charge, test 3 requires the zero-charge cells not to. **C and D
cannot both be implemented as written.** This is the vacuity mechanism from my r3 C6 in its
sharpest form: the defect lives one level below the key.

**Five seams have no decided disposition, and four of them fit none of the four cells:**

| Seam | Status |
| --- | --- |
| `wt.ts:454` `makeBidiChannel.read` | Takes `busy?` at `:426-429` and uses it for `write` (`:437`) and `end` (`:452`) — **and not for `read`**. That is W2's exact shape, in the file C edits, unnamed by the plan |
| `wt.ts:1306` inline bidi `read` | Same: `write`/`end` charge, `read` does not. Live — the fanout roles open a bidi control stream per session (`server.ts:1100-1111`) |
| `wt.ts:1242` `acceptUni` | Accept work, charged nowhere |
| `wt.ts:1566` `acceptUni` | Accept work, charged nowhere |
| `bin/compare-controller.ts:804` `acceptUni` | Sixth implementation, production path, absent from the plan's count of five |

For the four middle rows, *charged-at-another-seam-naming-that-seam* is unavailable as a
matter of fact, not of judgement: I verified by grep that the entire adapter tree holds two
ingest spans, `ws.ts:1865` and `wt.ts:924`, and `:924` is the envelope pump. **There is no
seam to name.** *not-transport-work* would be a falsehood. So acceptance bullet 3 — "every
seam appears in the four-cell table" — is satisfiable today only by writing something untrue.

**Two more things D never says.** How completeness is *derived*: if the first test compares
the table against a hand-maintained list, the list and the table go stale together and the
test is vacuous in precisely the way r3 refused. And where the classification surfaces — a
classification no gate can read exists only in a log.

### K4. Item A is correctly located; its number is wrong low by between 2.5x and 26x, and the plan's headline is that number

The **location** I confirm, in full: `frames.push` at `:1118` and `relayFrameRoutingFields`
at `:1126` are outside the `timed()` at `:1120`; `onRelayWork` is production-wired at `:3036`
into `createCohortServerLoopObserver`; the WS peer at `:670-679` performs neither step and
charges everything it does. The mechanism is trivially fixable —
`LengthPrefixedFrameReader.push` (`wt.ts:2073-2108`) returns an eagerly built `Uint8Array[]`,
not a generator, so the wrap needs no restructuring. Item A is executable as an instruction.

The **number** is not. Priced by execution against the real reader and a real `FanoutDataV1`
frame (`scenarios/fanout-wire.ts:207-221`, 128-byte payload, 674 bytes on the wire), 600k
frames, warmed:

| Arrival pattern | `frames.push` | routing decode | total | per frame |
| --- | --- | --- | --- | --- |
| 1 frame per stream read | 332.0 ms | 696.1 ms | **1,028 ms** | 1.71 us |
| 16 frames coalesced | 214.8 ms | 828.2 ms | **1,043 ms** | 1.74 us |
| plan | 171 ms | 247 ms | 418 ms | 0.70 us |

Two independent re-prices (mine and the Architect's, on different frame constructions) both
land at 2.3–2.9x the plan's total, with the routing decode ~3x the plan's figure.

**And the repo already carries a measured price for that exact function that the plan does
not cite.** `server.ts:818-822`: *"Measured on the chat-1k loopback acceptance (2026-09-05):
18 us a frame …"* — 10x my warm micro-bench and **44x** the plan's implied 0.41 us. A warm
micro-loop is a lower bound and an in-process acceptance measurement is the honest one, so
the true correction sits between roughly **1 s and 10.8 s of loop time per minute**, not
420 ms.

That range is the whole finding. At 420 ms/min the correction is a footnote; at the
docstring's rate it is the same order as the 16.3 s/min of relay work the child currently
charges, and it becomes the campaign's largest result. Risk 1 requires the correction be
reported "with its **measured size**". The plan's stated size is wrong in the direction that
makes it look harmless.

**I correct the Architect here.** His A4 claims the 10 k/s rate belongs to the charged egress
site and not to `:1126`. It does not. `scenario-registry.ts:256-263` defines
`tickerCell(10_000)` as `ingressRatePerSecond: 10_000`, `publisherCount: 1`,
`subscriberCount: 100`, `fanout: 100`, and `scenarios/ticker.ts:47-49` derives
`expectedOfferedRecords = ingressRatePerSecond * durationSeconds` with
`expectedOfferedBroadcasts = expectedOfferedRecords * fanout`. Ten thousand is the **inbound
record rate at the relay** — exactly what the uncharged site sees. The plan applied the right
rate to the right site; what is wrong is the per-frame price.

**What is a category error** is the comparison the plan closes on: "about 420 ms of loop time
dropped per minute … against a sealed WebSocket client figure of 26.3 ms". The 26.3 is
`perSession` — the **client's** loop over a 962 ms window on a Phase-A bulk arm. Setting a
per-minute Phase-B server aggregate beside it makes the correction read small by construction.
Drop the sentence or compare like with like.

### K5. The drift ceiling has no anchor, and cannot fire at the site Risk 2 says it guards

Work E: "Pin the WebTransport arrival charge to a measured ceiling on a fixed workload."
No value. No workload. Taken from the first passing run, a ceiling is self-fulfilling; the
plan holds the anchors to avoid that and does not state them.

Worse, the plan has **no measurement of the quantity it proposes to bound.** The `0.012` it
offers as "the correct discipline" is not an arrival body's cost — I reproduced it at 0.014
and it is the meter's own overhead across a single 50 ms sleep. The real anchors are the ones
at the A5 workload: 0.253 ms (Node, the plan's own) and **0.179 ms (WHATWG, mine, K2)** for
1600 chunks, against 52.4 ms for a span around the await. That is a 200–300x separation and
it makes a non-arbitrary ceiling a one-line decision.

And Risk 2 states two mitigations, neither of which exists:

> The WHATWG branch invites a span around an await … **The table entry and the ceiling test
> exist to make that fail.**

- The **ceiling** pins "the WebTransport arrival charge". After C the WHATWG site has no such
  quantity by construction, so there is nothing to bound and the guard cannot fire at the one
  site the risk is about.
- The **table entry** is prose. D's third test asserts only that *charged-at-another-seam* and
  *not-transport-work* seams charge nothing; the WHATWG row is in neither cell (K3), so no
  test asserts it charges nothing either.

Resolving K2 dissolves this: charge the branch, and the ceiling reaches it.

### K6. The plan asserts work it does not contain — fourth revision

Risks, line 145:

> `seam = chunk !== null` and the published definition text have gone unscheduled for three
> revisions; **D and F now name them.**

`grep -n "transport.ts\|SESSION_LOOP_BUSY\|seam = \|noteBusySlice\|windowMs" ` over the plan
returns **one line: 145 itself.** D names four cells, the seam counts and three tests, and
never mentions the flag. F names `render-report.ts:233`, names
`server-snapshot-protocol.ts:60-79` to leave alone, and never mentions `transport.ts`.

Both consequences are live and both are verified:

- **The flag.** `LoopBusyMeter.open(kind, seam = true)` fires `this.clock.noteBusySlice?.()`
  on entry for every ingest span (`transport.ts:206`, `:218`). Work C installs a **new ingest
  span on the read path**. At the default it tells a deterministic clock that a delivery
  happened on the EOF read that returns `null` — the precise thing `wt.ts:924`'s
  `busy.open("ingest", envelope !== null)` and its comment at `:919-923` exist to prevent.
- **The definition.** `SESSION_LOOP_BUSY_MS_DEFINITION` (`transport.ts:131-136`) says "the
  JavaScript event-loop time **this server** spent"; `render-report.ts:233` is a hand copy
  saying the same. F fixes the copy and leaves the source, so **after F the two disagree** —
  strictly worse than today, where all copies agree and are wrong together. Meanwhile B and C
  charge a **client** read into the figure the constant calls the server's.

A plan asserting coverage it does not have is worse than silence: a reader who checks the
risk register believes the items are handled.

---

## Answers to the questions the brief asked

**1. Is the blast radius real, or does some path already attest a receive-side figure?**
**Attested, not latent, and I re-parsed the disk to say so.** Three sealed
`bulk-one-way/physical` WT arms carry `loopUtilization.perSession.busyMs` **exactly `0`** over
2.2–2.4 s windows, against WS's 26.3 / 40.1 / 45.1 / 54.9. `arm-measure.ts:229-233` refuses a
*missing* consumer loop and accepts a zero one. Direction B is attested too, through
`onRelayWork` → `createCohortServerLoopObserver` (`server.ts:3036`, `:2970`). The gap is
already in signed artifacts.

**2. Can charging `readChunk` over-charge a reader that waits?** Not if the span sits inside
the continuation: both arrival bodies are synchronous and nothing suspends inside either
(`:196-197` a ternary, `:220-224` a type check and a resolve). The hazard was never the site,
it was the **shape**, and I reproduced all three — `measure(async …)` 0.221 (charges nothing),
a bare `open` around the await 52.686 (charges the wait), the discipline 0.014. **C naming the
prohibition and carrying the 52.4 is the plan's single biggest improvement over r3.** But C
then exempts from that guard the one branch where the wrong shape is most inviting, on a
premise I refuted (K2).

**3. Can this break the child's monotonic reading, or live/closed conservation?** **No — I
re-verified rather than inheriting it.** `busyMs` is minted as `finalBusyMs - baselineBusyMs`
from two reads of one accumulator (`server.ts:2572`); `LoopBusyMeter.totalMs` only grows
(`transport.ts:172`, `:227`); `onSessionClose` (`wt.ts:1655-1664`) deletes from the live set
before accumulating and no-ops on a repeat, so `closedServerBusyMs` cannot double-count and
`serverLoopUtilization()` (`:1666-1678`) cannot go backwards. `server.ts:2529` cannot fire
from this change. The hazard is **silent loss** of a charge that lands after close — and work
C is what creates that post-close arrival, since a read in flight at close resolves into a
meter nothing reads. **C and F are coupled and the plan still lists them as independent.**

**4. Can the two transports be compared after the change?** On the Phase-A client leg, yes —
as loop occupancy, never as cost, and the plan is honest about that. On the fanout server,
item A makes them comparable **for the first time**, and in the honest direction: whichever
peer does the work in JavaScript pays for it, which is what the definition says busyMs is. The
comparison stands or falls on A's magnitude being right, because the magnitude *is* the
finding (K4).

**5. Does the plan risk invalidating the sealed A5 arm?** **No, on three checks.** A touches
the Phase-B relay, not A5. B touches `ws-worker` and `wt-stream-sink`, which `ARM_WIRE` /
`ARM_READ_PATH` (`evidence.ts:238-252`) make separate arms from the `ws` primary. C touches
`wt.ts` only, and no WT arm has ever sealed a non-zero figure. The sealed WS number's own
contributing seams — `ws.ts:1644` and `:2146` — are the ones W6 correctly keeps at zero, and I
confirmed W6 by scanning `ws.ts:1870-2010` for `await`/`async` and finding none. **The one
path that would move it is a `read → ingest` row forced by K3**, which double-counts into the
sealed 26.3125. That is a reason to fix K3, not a reason to doubt the plan's intent.

**6. Can the surface table be satisfied vacuously?** **Yes, three ways.** One surface with two
construction-site rules and no way to express it (K3); five seams whose only available cells
are unavailable in fact or false in content (K3); and a completeness test whose derivation the
plan never states, so a hand list can go stale beside the table it checks.

---

## Corrections to the Architect's r4

- **A4's rate criticism is wrong.** He argues the 10 k/s belongs to the charged egress site
  and that the inbound rate is "the publish rate, not the delivery rate". The cell parameter
  is literally `ingressRatePerSecond: 10_000` with `fanout: 100`
  (`scenario-registry.ts:256-263`), and `scenarios/ticker.ts:47-49` multiplies by `fanout` to
  get broadcasts. Ten thousand **is** the inbound rate at `:1126`. His per-frame-price
  criticism stands and is right; the rate half should not be carried into r5.
- **His "acceptance bullet 1 has no mechanism at HEAD" overstates.** `timed()` does read
  `performance.now()` directly (`server.ts:642-650`, `:957-963`) and neither peer options type
  takes a clock — but `onRelayWork` is injectable, and this repo already has source-text
  structural assertions of exactly this shape (`driver-core.test.ts:2159-2168`,
  `fanout-relay.test.ts:1781-1787`). The bullet is **reachable**; what it lacks is a statement
  of which route it takes, since as written it reads behavioural.
- **His A2 says the plan's 0.012 "proves it measured something there".** It does not — 0.012
  is meter overhead around a sleep, and I reproduced it at 0.014 with no arrival body in
  sight. His conclusion is right anyway; the proof is my 0.179 ms at the real workload (K2).
- **S1 is correct and I confirmed it by execution.** `readableFlowing` is `null` before
  `once("data")` and `true` after, so the guard at `wt.ts:241` is already false and the nudge
  at `:243-250` is dead on a real `Readable`. Worth the one sentence he asks for.

## Smaller items — say these, none blocking alone

- **`frames.push` is `:1118`, not `:1116`**, and `:1116` is the await. See the header note:
  this one is load-bearing for item A's instruction.
- **Item A should say the `await inbound.read()` at `:1116` stays outside the span.**
- **B does not say which figure the arm publishes** (base only, base plus an empty reader
  accumulator, base plus a new span) **or which `windowMs` pairs with it** —
  `ws-worker.ts:301` computes it from `sessionOpenedAtMs`, `LoopBusyMeter.windowMs` from meter
  construction (`transport.ts:167-168`). A numerator from one clock over a denominator from
  another feeds the `0.3` detector, and this repo has a standing gotcha for that family.
- **Two docstrings cite the reading B deletes**: `server.ts:556-558` and `:1256-1257` both
  name `adapters/sink-worker.ts:227` as the definition Phase B takes.
- **Make the meter parameter required.** `makeBidiChannel(duplex, clock, busy?)`
  (`wt.ts:426-429`) is how W2 happened in the first place; give `makeReceiveChannel` a meter
  and make both required, and the compiler carries load the table would otherwise chase.
- **The plan's withdrawal sentence (lines 79-81) reads backwards** — as written it withdraws
  "busyMs is constrained by five gates", which is the true statement. Say which claim dies.

---

## What would make this APPROVED

1. Extend work B to `wt-stream-sink.ts:345-348` on the same terms as `ws-worker`, and name
   both arms in acceptance bullet 2, so removing `measureRead` does not leave a fabricated
   zero behind (K1).
2. Withdraw "no arrival callback at all" and charge `wt.ts:196-197` at its measured ~0.18 ms
   per 1600 chunks — which retires the fifth label, gives the WHATWG row the *ingest* cell,
   and brings it under the ceiling (K2). If the plan instead keeps a fifth cell, defend it
   against the 0.179 measurement.
3. Key D on **construction sites**, not surfaces; give `wt.ts:454`, `:1306`, `:1242` and
   `:1566` a stated disposition; add `bin/compare-controller.ts:804` and correct the count to
   six; and say how completeness is **derived** and where the classification surfaces (K3).
4. Re-derive item A's number with its workload stated and reconciled against
   `server.ts:818-822`'s 18 us a frame — or strike the number and let the before/after
   measurement supply it. Keep the 10 k/s rate; it is right. Stop comparing a per-minute
   server aggregate to a per-session client figure (K4).
5. Give the ceiling a pre-stated value and workload anchored on 0.253 / 0.179 against 52.4,
   and make Risk 2's two mitigations real (K5).
6. Schedule the seam flag and `SESSION_LOOP_BUSY_MS_DEFINITION` in the work items, or strike
   the Risks claim that D and F already do. Do not leave the plan asserting work it does not
   contain (K6).
7. Say whether acceptance bullet 1 is a driving assertion over injected `onRelayWork` or a
   structural one over source text, and fix `:1116` to `:1118`.
