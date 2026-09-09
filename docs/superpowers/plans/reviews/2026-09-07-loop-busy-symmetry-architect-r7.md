APPROVED

# Architect review (revision 7) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed by me, before reading) | `3a106fcd90e1886ba0b254c67b77e07f00793e9e0757cf1f95116746aff47b2a` |
| Declared SHA-256 | identical — verified first |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | `git status --porcelain` shows untracked evidence/review files and the two tracked modifications present at session start; git used read-only (`shasum`, `rev-parse`, `status`, `grep`). Only this artifact written |
| Prior artifacts read | my r1–r6; Critic r6 |
| Method | every `file:line` the plan cites read at HEAD; `bun test ./tools/compare/adapters/loop-busy.test.ts ./tools/compare/adapters/read-path-adapters.test.ts` → **29 pass / 0 fail** reproduced; the `read` / `acceptUni` / `receiveMessage` implementation surface enumerated exhaustively across `tools/compare` by grep rather than by eye; and the **WebTransport read caller turn re-metered myself** under the honest discipline at the plan's own workload, which is finding N1 |

**The four fixes are present and correct. I confirm each by execution.** The plan is
executable as written, and I approve it. Item C now charges the consumer read turn on both
transports; W6 states what was measured rather than what was assumed; the third census cell
is narrowed so it cannot absorb the read seams; the scan roots are named and, at HEAD,
provably complete. Seven corrections follow — all of them text inside work items that already
exist, none of them changing what gets built or making an acceptance bullet vacuous. **N2 is
the one that must land**, because without it the published definition ends up narrower than
the thing it names.

---

## The four fixes, verified

| Required fix | Status | How I checked |
| --- | --- | --- |
| **1. Extend item C to the WebSocket half rather than deleting the clause** | **Present and correct.** C reads "Charge the whole consumer read turn on **every read seam, both transports**", and names `ws.ts:2146`, `:1644`, `waitForQueue` (`:471-510`) and `readFromStream` (`wt.ts:467-493`) alongside the two WT seams, with the reason ("Charging only the WebTransport half would invert the asymmetry"). Risks now owns **both** rising figures, which is what the critic asked for and r6 said Risks lacked | plan L111-117, L165-168; every named site read at HEAD |
| **2. Rewrite W6 to the measured truth; withdraw R6's justifying clause by name** | **Present and correct.** The revision history withdraws it explicitly and W6 now says `ws.ts:1865` "charges the **arrival** turn only", naming frame decode, channel construction (`:1988-1996`) and `tryPush` (`:1999-2002`). `grep "charged in full"` over the plan returns **nothing** — the clause is gone from the body, not merely contradicted | plan L14-21, L85-90; `grep` |
| **3. No fifth cell, because after C the seams are charged** | **Present and sound.** Cell three now reads "naming a span that actually exists **and is measured to charge that work**", and the plan states "After C, no read seam uses the third cell, because the span that was cited for them charges the arrival turn and not theirs." That is the correct disposal of my A6-2: the cell my r6 said could hold a lie now carries an evidentiary burden the lie cannot meet, and the seams that would have needed a fifth cell are inside C's scope instead. **WT `acceptUni`/`readFromStream` is explicitly inside C**, which is the disjunct K2 asked the plan to pick | plan L111-127 |
| **4. Name the scan roots; strike W5's counts; `:1120`→`:1119`** | **Present.** D names `tools/compare/adapters/**` plus `bin/compare-controller.ts`, `ws-worker.ts`, `wt-stream-sink.ts`, so the site r5 refused over is inside scope. W5 contains no count — `grep` for count words returns nothing. `:1119` is correct at both occurrences (W1 and item A) and `:1120` appears nowhere | plan L66-67, L80-84, L101, L119-121; `grep` |

**On fix 4 I verified completeness rather than trusting the enumeration.** I grepped every
implementation of `read(`, `acceptUni` and `receiveMessage` across `tools/compare` with tests
excluded. Every implementation seam at HEAD is inside the named roots: `ws.ts`, `wt.ts`,
`ws-worker.ts`, `wt-stream-sink.ts`, `transport.ts` (interface only) and
`bin/compare-controller.ts:783`/`:804`. `client.ts:883` and `server.ts:390` are **callers**,
not seams. The roots as stated produce a complete census today.

---

## Facts checked at HEAD, including every claim the brief named

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) and `WsChannel.read` only dequeues | **True.** `:1865` is `this.busy.measure("ingest", () => this.dispatchSocketMessage(value))`; `:2146` `read` calls `waitForQueue` then `result.reservation.release()` — no meter anywhere in it |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251` and `:1569` | **True.** `makeReceiveChannel(readable: Readable, clock: TransportClock)` at `:410-413` takes no meter; `readChunk` at `:177`; `:1250-1252` passes the `as unknown as … Readable` cast, `:1569` passes two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `busy.open("ingest", envelope !== null)` at `:924`; the only other `"ingest"` occurrences in `tools/compare` are `ws.ts:1865` and the two `transport.ts` lines that define the kind |
| `acceptUni` has exactly one production caller (`client.ts:883`) | **True.** `const channel = await input.session.acceptUni(acceptDeadline)`. Every other non-test occurrence is an implementation (`ws.ts:1644`, `wt.ts:1242`, `:1566`), a decorator delegating to `base.acceptUni` (`ws-worker.ts:255-256`, `wt-stream-sink.ts:305-306`, `bin/compare-controller.ts:804-805`), the interface (`transport.ts:475`), or a comment |
| The **fanout** server ingests through `receiveMessage` (`server.ts:388-390`) | **False, and the plan does not claim it — the brief does.** `:388-390` is inside `echoSession`, declared at `server.ts:379`; it is the Phase-A echo loop. The fanout relay's inbound paths are `server.ts:1116-1131` (WT) and `:670-680` (WS). Second time I have had to record this |
| The WS server ingests through its message callback (`:670`) | **True**, and `:673-677` puts `relay.handleInboundBytes` + `relay.pump()` inside `timed()` |
| The sealed artifact carries **only** server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False as phrased, and the plan does not claim it — the brief does.** `:536-542` declares `perSession` **and** `serverAggregate`; `:786-802` validates window finiteness on both. Both are server-role figures, so the claim is true of *role* and false of *count* |
| No gate constrains `busyMs` | **True of magnitude only — and the plan does not claim otherwise.** `arm-measure.ts:235`/`:255` refuse non-finite, `:713` refuses non-finite or negative, `artifact-builder.ts:786-802` refuses a non-positive window, `server.ts:2529-2536` refuses a backwards loop, `render-report.ts:48` caveats above `0.3`. **A zero passes every one**, which is why the sealed WT zeros exist and why item C can land without tripping a gate |
| W1: `frames.push` (`:1118`) and `relayFrameRoutingFields` (`:1126`) sit outside the `timed()` span opened at `:1119` | **True, and the line numbers are now right.** `:1118` is the `for (const bytes of frames.push(chunk.value))` header, `:1119` opens `timed(`, `:1120-1122` is the callback body, `:1126` is the routing decode inside `if (result.ok)` — outside the span |
| W1: `:1027` is charged, so there is no larger sibling | **True.** `relayFrameRoutingFields(bytes)` at `:1027` is inside `sink.trySend`, reached only through `relay.pump()`, which runs inside `timed()` at `:1121` and `:675` |
| W1: `onRelayWork` wired at `:3036`, forwarded at `:1203` | **True**, verbatim, on the production Phase-B path |
| W1 size: 1.66–1.83 µs/frame at 10k/s ⇒ ~1.0–1.1 s/min | **Arithmetic closes.** `tickerCell` (`scenario-registry.ts:256-263`) is `ingressRatePerSecond: 10_000`, `publisherCount: 1`. 1.66–1.83 µs × 10 000 = 16.6–18.3 ms/s = 0.996–1.098 s/min |
| W2: `sink-worker.ts:227` charges suspension; both arms replace `loopUtilization` wholesale | **True on all three.** `measureRead` (`:222-229`) accumulates `nowMs() - startedAtMs` across `await read()`; `ws-worker.ts:298-301` and `wt-stream-sink.ts:345-348` both override the key with a worker-computed window |
| W3: `ws-worker.ts:11-17` — no worker thread | **True**, verbatim: "there is no worker thread, because `node:worker_threads` is a forbidden import on a role-child module" |
| W4: both WT branches; the expensive part is the turn, not the body | **True.** WHATWG at `wt.ts:182-203` — `getReader` (`:183`), `new Promise` + `setTimeout` (`:186-192`), `Promise.race` (`:199`), `clearTimeout` + `releaseLock` (`:201-202`) |
| W6: `ws.ts:1865` charges the arrival turn only; the consumer turn is charged nowhere | **True**, and this is the r6 finding correctly absorbed. `waitForQueue` has no meter parameter and constructs `AbortController`, the two-tick IIFE, `clock.sleep` and the race entirely outside any span |
| W6: `readFromStream` is the same shape | **True.** `wt.ts:468-495`: `stream.getReader()`, `Promise.race` against a `setTimeout` rejection, `reader.releaseLock()` in a `finally`. No meter |
| W7: `render-report.ts:233` mislabels; `transport.ts:131-136` says "this server" | **True on both**, and worse than W7 says: `:233` is an independent hand-copied string that **already disagrees in content** with the constant — it carries a trailing "as is harness work outside the session such as generating or digesting a bulk payload" clause the constant does not. `SESSION_LOOP_BUSY_MS_DEFINITION` has **zero importers** anywhere in `tools/` |
| W8: `wt.ts:1655-1664` can drop a late charge | **True.** `onSessionClose` returns early when `liveServerSessions.delete(session)` is false, so a repeat close is a silent no-op; `serverLoopUtilization` (`:1667-1678`) sums closed + live |
| The discipline item C relies on exists | **True.** `transport.ts:117-118` is "No span crosses an `await`" verbatim; `:196-198` is "The caller pauses it before every `await` and closes it in a `finally`"; `open` returns `{ pause, resume, close }` at `:229` |
| `pricedClock` cannot discriminate (item E) | **True.** `loop-busy.test.ts:63-97` advances `now` only in `sleep` and in the two seam notes; `readChunk` uses the real `setTimeout` (`wt.ts:187`), never `clock.sleep`. E's exclusion is necessary |
| Baseline suites | **29 pass / 0 fail**, reproduced at HEAD |

---

## Answers to the questions the brief asked

**Is the objective right, or should the metric be defined differently?** Right, and I endorse
it a fourth time. `SESSION_LOOP_BUSY_MS_DEFINITION` measures JavaScript event-loop time on
transport work and explicitly excludes native, kernel and other-thread time; WS frames in JS
and WT frames in the addon, so a 170 / 48.5 ms split is the metric working, not failing.
Charging the read path is a **completeness** repair, not a definition repair — the consumer
turn is synchronous loop time by the definition's own words, and pausing across the `await`
is the definition's own rule. **Nothing in the plan contradicts the published definition.**
But see N2: once C lands, the published *prose* is narrower than what the number counts.

**Does the scope cover every seam?** On the relay, yes, re-proved not inherited. On the read
path, yes **as a set**, though C's enumeration is not the thing that closes it — the census
is. See N3: there is a third `ReceiveChannel`-shaped `read` at `wt.ts:1306` that no revision
and no review has ever named, and it is unmetered.

**Is the surface enumeration in item 2 sufficient to prevent a third instance?** I tested
this rather than asserting it, by finding a seam the plan does not name (`wt.ts:1306`) and
tracing whether the mechanism catches it. It does: `wt.ts` is inside the named roots, so the
scan finds the seam; the table must then carry a row; cell three is forbidden for read seams
after C; cell four ("not-transport-work") is false for a channel read by any reading of the
definition. The only honest cell left is *ingest*, which forces the charge. **The mechanism
reaches a seam the plan's prose misses — which is exactly what it was installed to do.** Its
residual limit is N4: the roots are complete at HEAD but not self-extending.

**Is the acceptance criterion falsifiable as written?** Bullets 1, 2, 3, 4, 6 and 7 are,
cleanly. Bullet 2 is the decisive improvement over r6: "a test measures the WebSocket and
WebTransport turns so a change that charges only one side fails" is falsifiable and it is
precisely the failure mode I refused r6 over. Bullet 5 is falsifiable **given** an injected
wait large against noise; the plan's own table supplies the intended magnitude (1 600 ms of
real waiting, against 5.76–8.27 ms at zero wait) but item E does not restate it — see N6.

---

## Corrections binding on the implementer

None of these blocks. All are text inside work items that already exist.

**N1 — the "two to three times" claim is not supported, and the plan gives two different
figures for the same quantity.** The revision history says the WT twin of the consumer turn
"measures 2.77 to 3.76 ms"; the correction table two sections later prices the same turn under
the same discipline at "5.76 to 8.27 ms at zero wait". I re-metered it myself — `readChunk`'s
WHATWG branch replicated verbatim, 1600 × 64 KiB, honest `open`/`pause`/`resume`/`close`,
`bun` 1.3.14:

| per 1600 × 64 KiB | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| WT read turn, honest discipline | 10.41 ms | 5.73 ms | 4.45 ms |
| …synchronous prefix alone | 8.49 ms | 4.54 ms | 3.50 ms |

I cannot reproduce 2.77–3.76 as the whole turn; the table's 5.76–8.27 is the band I land in.
**2.77–3.76 looks like a warm-run measurement of the WT synchronous *prefix* being compared
against the WS whole turn (7.65–7.99)** — my own prefix run 3 is 3.50 — which would make the
"two to three times" a comparison of unlike quantities. Against like quantities the two turns
are the same order: WS 7.65–11.5, WT 4.45–10.41. **Strike "2.77 to 3.76" and the "by two to
three times", or re-derive both against the same span shape and say which shape.** No work
item depends on this: item C charges both sides, so which turn is larger is decorative — but
this plan's whole thesis is that a measured-sounding number with no reproducible producer is
the defect, and this is one, sitting in the paragraph that justifies the plan's reshaping. The
surviving claim is the one that matters and it is true: **both turns are uncharged, they are
the same order, and charging one alone leaves the other uncharged.**

**N2 — the definition's prose must widen with the measurement. This is the one that must
land.** `SESSION_LOOP_BUSY_MS_DEFINITION` (`transport.ts:131-136`) spells out the egress half
— "the loop time spent framing, scheduling and resuming outbound writes, never the wall time
the bytes take to leave" — and says nothing at all about what ingest covers. After C, ingest
grows to include the consumer's read turn on both transports: reader acquisition, timer setup
and teardown, the race, the release. Item F opens that constant for edit but scopes the edit
to W7's **role** defect only. An implementer who fixes the role and stops will publish a
sentence that under-describes what the number now counts, on a plan titled *symmetry*, with
one half of the metric explained and the other not. **F must say: give ingest a clause
symmetric with the egress clause, naming the consumer read turn as charged and suspension as
not.** This is a genuine gap in the plan, not a style note — it is the campaign's own failure
mode pointed the other way.

**N3 — `wt.ts:1306` is a third unmetered read seam, and the required-meter guard cannot reach
it.** Inside the native bidi channel, `async read(dl) { return readChunk(readable, dl, clock); }`
— the same defect as `makeReceiveChannel`, in an inline object literal whose sibling `write`
(`:1289`) and `end` (`:1303`) **do** take `busy`. D's structural fix hardens
`makeReceiveChannel` and `makeBidiChannel`; `:1306` is constructed through neither, so no
required parameter protects it. C's universal clause covers it and the census forces it, as
argued above, but **name it in C** so it is not left to the mechanism alone.

**N4 — the scan roots are complete at HEAD but do not stay complete, and two of the three are
mis-described.** D says "`tools/compare/adapters/**` plus the production decorators that wrap
a session **outside it**, `bin/compare-controller.ts`, `ws-worker.ts` and `wt-stream-sink.ts`".
`ws-worker.ts` and `wt-stream-sink.ts` are at `tools/compare/adapters/ws-worker.ts` and
`tools/compare/adapters/wt-stream-sink.ts` — **inside** `adapters/**`, already covered. Only
`bin/compare-controller.ts` is outside. The union is unchanged and complete, so this is
harmless to scope, but fix the sentence. More usefully: the critic's K3 asked for one further
clause — that widening the roots is the only sanctioned way to change what the table must
contain — and R7 dropped it. Without it a decorator added tomorrow in `bin/` outside
`compare-controller.ts` escapes the scan silently, which is the r5 shape recurring.
**Prefer the broader root the critic offered — all of `tools/compare` minus `*.test.ts` —
which I verified is a strict superset containing no extra seams at HEAD.**

**N5 — the `seam` flag is still instructed nowhere.** `open`'s default is `seam = true`
(`transport.ts:207`), and a defaulted read span fires `clock.noteBusySlice()` on the EOF read
that returns `null`, pricing a shutdown as a delivery on any fake clock. One clause in C —
"pass `seam = chunk !== null`, as `wt.ts:924` does for `envelope !== null`" — closes it.
Carried unchanged from my r6; the code comment at `transport.ts:200-205` states the rule, so
an implementer has the guidance even if the plan does not.

**N6 — item E should restate its injected wait.** E fixes the workload (1600 × 64 KiB) but
not the wait. At zero wait the honest and across-the-`await` shapes differ by under ten per
cent in my runs — not "material". The plan's own table supplies the intended figure
(1 600 ms of real waiting ⇒ 48.9 ms honest); put it in E so the bar is pre-stated rather than
chosen after the first run. Note the two "naive" shapes are not the same and E should say
which it means: a `measure()` wrapper around an async function closes synchronously
(`transport.ts:186-192`) and charges **only** the prefix — which is why the Risks sentence
"charges less than the honest one at zero wait" is correct, and correct only for that shape.

**N7 — say which cell the sink wrappers' own dequeue lands in.** `ws-worker.ts:203` and
`wt-stream-sink.ts:253` take from a local queue that a pump fills by calling the base
`channel.read` — the seam C charges. So the transport read is charged, and the wrapper's
`takeOrThrow` turn is an additional harness hand-off. C's "every read seam" and D's
not-transport-work cell both reach it and the plan picks neither. Either is defensible; the
plan should choose, because after B these arms publish the base meter and an implementer
guessing here changes a published arm figure.

**N8 — two citation slips, non-load-bearing.** `waitForQueue` is `ws.ts:472-512`, not
`:471-510` (`:471` is blank; `:510` is inside the `finally`). `readFromStream` is
`wt.ts:468-495`, not `:467-493` (`:467` is the docstring). Both unambiguously identify the
right function. Also, `render-report.ts:233` resolves against `tools/compare/render-report.ts`;
`tools/compare/bin/render-report.ts` is 55 lines and has no `:233`.

---

## Verdict

**APPROVED.** The four required fixes are present, correct and verified by execution against
the code, not accepted on assertion. The plan's objective is the right one, its scope covers
the seam set as a set, its census mechanism demonstrably reaches a seam its own prose misses,
and its acceptance criteria are falsifiable. The one defect I would have refused r6 over —
applying a corrected rule to one side of a symmetric pair — is gone, and gone in the stronger
direction: C charges both halves and acceptance bullet 2 fails a change that charges only one.

Implementation may begin. Carry N1–N8 as text corrections; **N2 is required** — the published
definition must name the consumer read turn as charged before any run reports a figure that
includes it, or the campaign ships a number broader than the sentence that defines it.
