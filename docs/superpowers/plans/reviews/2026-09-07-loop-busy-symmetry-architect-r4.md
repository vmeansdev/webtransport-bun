CHANGES REQUIRED

# Architect review (revision 4) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `dc68d47467617541ae6d68526c0529bb4e35c445b291722a37a505fd5ba9098c` |
| Declared SHA-256 | identical — verified before reading the plan |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | no tracked modifications under `tools/`, `packages/`, `docs/`; only the untracked plan and review documents |
| Prior artifacts read | `…-architect.md` (r1), `…-architect-r2.md` (r2), `…-architect-r3.md` (r3) |
| Method | every `file:line` the plan cites read at HEAD; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → 29 pass / 0 fail (baseline reproduced); the relay decode re-priced by execution on the real `LengthPrefixedFrameReader` and the real frame shape; the Node-branch nudge probed by execution; the four sealed WS bulk arms read out of `.release-evidence/` |

**R4 is a real advance and I want to say so before the refusal.** The fanout relay is
restored as work item A and correctly made the headline. The two WebTransport
construction sites are separated by name and the branch attribution is right — I traced
it end to end and it holds. Work B's pairing is right, and its premise is right: there
is no worker thread, so the base meter and the reader meter are the same loop. The
`26.3`-reproduction criterion is properly dropped, and the four sealed arms do span
26.31 to 54.94. Five of my seven r3 items are discharged.

**It is refused on four grounds, three of them mechanical.** The plan claims in its own
Risks section that two items are now scheduled; neither work item names either, and one
grep proves it. The four-cell taxonomy leaves at least three live read seams with no
cell, including the one work C is about. Acceptance bullet 4's guard cannot reach the
site whose hazard Risk 2 names. And item A's headline number is not reproducible: I
re-priced it on the real reader and got 2.3–2.9× the plan's figure, while the repo's own
measured constant for one of the two components implies 25× it.

---

## Facts checked, and the result

Every claim the brief named, plus every citation the plan makes. All read at HEAD.

| Claim | Verified |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** `makeReceiveChannel(readable, clock)` takes no meter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `grep '"ingest"'` over `adapters/` returns exactly two hits in the tree: `ws.ts:1865` and `wt.ts:924`. `:924` is the envelope pump (`feed.next()`), not the stream path |
| `acceptUni` has one production **consumer** (`client.ts:883`) | **True** — `acceptUni` then `channel.read()` in a loop, 1600 iterations on the bulk arm |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) | **False, and the plan correctly withdraws it** — that is `echoSession`, Phase A |
| WS server ingests through its message callback (`:670`) | **True**, and it charges everything it does: no reassembly, no routing decode |
| Sealed artifact carries only server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False** — `:536-541` declares `perSession` **and** `serverAggregate`; `:786-800` validates window finiteness on both. The plan no longer claims otherwise |
| No gate constrains `busyMs` | **False, and the plan correctly withdraws it** — monotonicity refusal at `server.ts:2529`, minting at `:2572`, the `0.3` detector at `render-report.ts:48` |
| W1: `frames.push` and `relayFrameRoutingFields` outside the `timed()` span, `onRelayWork` wired at `:3036` | **True.** `:3036` → `loop.record` → `createCohortServerLoopObserver` (`:1277`), Phase B, production |
| W1: the WS peer at `:670` performs neither step | **True.** WS preserves message boundaries; there is nothing to reassemble and the routing decode is not on that path |
| W2: `sink-worker.ts:222-229` `measureRead` wraps the whole `await`, call site `:320` | **True** |
| W2: pinned by `read-path-adapters.test.ts:291` | **True** — `"snapshot publishes the reader's loop, not the base session's"` |
| W3: `ws-worker.ts:296-302` discards the base meter; `ws-worker.ts:1-25` says same loop | **True.** `:11-17`: "there is no worker thread". The comment at `:294-296` claiming a different loop is misleading; B's premise is sound |
| W4: `:1569` takes the Node branch | **True, traced to the source.** `incomingUnidirectionalStreams()` (`packages/webtransport/src/index.ts:2815`) yields `new RecvStream(...)`, and `streams.ts:396` is `class RecvStream extends Readable` |
| W4: `:1251` takes the WHATWG branch | **True.** `index.ts:2241` returns `ReadableStream<WebTransportReceiveStream>`, and `:949` types that as `ReadableStream<Uint8Array>` — it has `getReader`, so `readChunk` takes branch 1 |
| W4: `wt.ts:94` misdeclares it | **True** — `ReadableStream<Readable>` on `FakeWtServerSession`, plus the `as unknown as` cast at `:1252` |
| W5: six `read` implementations | **True.** `wt.ts:417`, `:454`, `:1306`, `ws.ts:2146`, `ws-worker.ts:203`, `wt-stream-sink.ts:253` |
| W5: five `acceptUni` implementations | **False — there are six.** See F2 |
| W7: `render-report.ts:233` calls both figures the server's | **True**, verbatim, and it is a hand copy of `SESSION_LOOP_BUSY_MS_DEFINITION` |
| W9: `65 / 1250` traces to `cohort-fixture-signing.ts:194-198` | **True** |
| Acceptance 6: four sealed WS arms span 26.3 to 54.9 | **True, read out of the evidence tree.** 26.3125, 40.0815, 45.0754, 54.9424 — a 2.09× spread. Windows 954–962 ms, so utilization 0.028–0.058, far under the `0.3` detector |

One citation slip: `frames.push` is at **`server.ts:1118`**, not `:1116`. `:1116` is
`const chunk = await inbound.read()`. `relayFrameRoutingFields` at `:1126` is correct.
Worth fixing because the headline correction points at that line.

**One correction to my own r3.** R3's R6 required the plan to charge the Node branch's
*third* arrival body — the synchronous nudge at `wt.ts:243-250`. I withdraw that as
applied to the production path. `readable.once("data", onData)` at `:236` sets
`readableFlowing` to `true` synchronously, so the guard `!readable.readableFlowing` at
`:241` is already false when it is evaluated. Probed by execution: `readableFlowing`
is `null` before `once` and `true` after. On any genuine node `Readable` — which
`RecvStream` is — the nudge is unreachable. The plan's singular "the arrival body" for
the Node branch is therefore **correct**, and I was wrong to require otherwise. It is
correct for a reason the plan does not state and did not verify, which is the only
thing I still ask for (S1).

---

## Blocking findings

### A1. The plan asserts two items are scheduled that no work item schedules — one grep disproves it

Risks, line 145:

> `seam = chunk !== null` and the published definition text have gone unscheduled for
> three revisions; **D and F now name them.**

`grep -n "transport.ts\|SESSION_LOOP_BUSY\|seam = \|noteBusySlice"` over the whole plan
returns **exactly one line: 145 itself.**

- **Work D** (the taxonomy) names four cells, six `read` and five `acceptUni`
  implementations, and three tests. It does not mention the seam flag.
- **Work F** names `render-report.ts:233`, names `server-snapshot-protocol.ts:60-79` to
  leave alone, and says "state in the provenance". It does not mention `transport.ts` or
  the constant.

Both items are therefore unscheduled for the **fourth** revision, and the plan now
carries a false statement about its own contents. That is worse than the silence in r3,
because a reader who checks the risk register will believe the items are covered.

The two consequences are concrete and both were spelled out in r3:

- **The seam flag.** `LoopBusyMeter.open(kind, seam = true)` fires
  `this.clock.noteBusySlice?.()` on entry for every `"ingest"` span (`transport.ts:206`,
  `:219`). Work C installs a **new ingest span on the read path**. At the default it
  tells the fake clock a delivery happened on every read, including the EOF read that
  returns `null`. It must pass `seam = chunk !== null`, mirroring `wt.ts:924`'s
  `busy.open("ingest", envelope !== null)` — whose own comment at `:919-920` says
  exactly why. Without the sentence, an implementer following the plan writes the bug
  and it surfaces as an unexplained red in the four suites that price a deterministic
  clock through that hook.
- **The definition.** `SESSION_LOOP_BUSY_MS_DEFINITION` (`transport.ts:131-136`) says
  "the JavaScript event-loop time **this server** spent". `render-report.ts:233` is a
  hand copy of it. F fixes the copy and leaves the source, so **after F the two
  disagree** — strictly worse than today, where all copies agree and are wrong together.
  And work B charges a *client* read into the very figure the constant calls the
  server's. Make the constant role-neutral, carry the role as a labelled property of each
  attested figure, and make the report legend derive from the exported constant so a
  fourth copy cannot appear.

**Fix:** name both in the work items, or strike the claim from Risks and say plainly
that they are deferred. Do not leave the plan asserting work it does not contain.

### A2. The four-cell taxonomy has no cell for the seam work C is about, and C and D contradict each other

Work D fixes the cells: *ingest*, *egress*, *charged-at-another-seam-naming-that-seam*,
*not-transport-work-with-a-reason*. Work C then says of the WHATWG branch:

> charge nothing there and record in the table that it is **structurally unmeterable at
> arrival**

That is a **fifth label**. It is not any of D's four, and it cannot be mapped onto one:

- Not *ingest* or *egress* — nothing is charged.
- Not *charged-at-another-seam* — that cell must **name the seam**, and there is none.
  I verified this is the strongest fact in the file: the whole adapter tree contains
  exactly two ingest spans, `ws.ts:1865` and `wt.ts:924`, and `:924` is the envelope
  pump. **No span anywhere encloses a WT stream read.**
- Not *not-transport-work* — delivering inbound bytes to the consumer is the definition
  of transport work, and D requires a reason that would here be a falsehood.

So the plan's own headline work item produces a row its own taxonomy cannot hold, and
D's third test ("charged-at-another-seam and not-transport-work seams charge nothing")
has no cell to file it under. **C and D are internally inconsistent.**

**Two more seams have no assigned cell, and the plan never mentions them.** D says the
table covers all six `read` implementations, but work C only addresses
`makeReceiveChannel`'s two construction sites. That leaves:

- **`wt.ts:454`**, `makeBidiChannel.read` → `readChunk`. Note `makeBidiChannel(duplex,
  clock, busy?)` at `:426-429` **already receives a meter** and uses it for `write` and
  `end` and not for `read`. That is the exact shape of W2's defect, sitting in the file,
  unnamed.
- **`wt.ts:1306`**, the inline bidi channel's `read` → `readChunk`.

Both are live: the fanout roles open a bidi control stream per session
(`server.ts:1101-1111`). The table will have rows for them and the plan decides nothing
about them.

**Fix:** either add the fifth cell explicitly and defend it — *transport work, no
arrival point exists, charged nowhere, with the measured 0.012 / 52.4 as the reason a
span around the await is forbidden* — or resolve the WHATWG branch into an existing
cell. And give `wt.ts:454` and `wt.ts:1306` a stated disposition, not just a table row.

**A note on the fifth cell's premise, which is separately wrong.** W4 says the WHATWG
branch "has **no arrival callback at all**; the only thing there to wrap is the
`await`." The code says otherwise. `wt.ts:194-197` is:

```ts
const readPromise = reader.read().then((res) => res.done ? null : (res.value ?? null));
```

That `.then` continuation *is* an arrival point, and it runs on the loop after the data
lands. It is trivial — a ternary — which is why it prices at 0.012 ms, and the plan's own
number proves it measured something there. So "structurally unmeterable" overstates the
case: the branch is meterable at `:196-197` and the honest finding is that its arrival
work is ~0.012 ms, not that it does not exist. Charging it makes the WHATWG branch fit
the *ingest* cell at a truthful near-zero value, which dissolves this whole finding and
is my recommended resolution.

### A3. Acceptance bullet 4 cannot reach the site whose hazard Risk 2 names

Risk 2:

> The WHATWG branch invites a span around an await, which measures 52.4 ms of mostly
> waiting. **The table entry and the ceiling test exist to make that fail.**

Neither does.

- **The ceiling test** (work E, acceptance bullet 4) pins "the WebTransport **arrival
  charge**". After work C only the Node branch (`:1569`) has an arrival charge. The
  WHATWG branch (`:1251`) has none by construction, so there is no quantity for the
  ceiling to bound and the guard cannot fire there. Acceptance bullet 4 is unreachable
  for exactly one of the two construction sites — the one Risk 2 is about.
- **The table entry** is prose. D's third test asserts that *charged-at-another-seam* and
  *not-transport-work* seams charge nothing. The WHATWG branch is in neither cell (A2),
  so no test asserts it charges nothing either.

The mechanism that would actually catch a 52.4 ms span on that branch is a **zero-charge
assertion on that branch**, and it exists only if A2 is resolved first. Risk 2's stated
mitigation does not exist in either of the two places it claims.

**Related, and it makes bullet 4 weaker than it reads: the ceiling has no value and no
workload.** "A measured ceiling on a fixed workload" leaves both the number and the
workload to the implementer, and the natural choice — take it from the first passing run
— makes the guard self-fulfilling. The plan does hold the anchors that make a
non-arbitrary choice possible (0.012 correct against 52.4 for the wrong discipline, a
4000× separation), so this is a sentence, not a redesign: state the workload (the sealed
shape — 100 MiB, 1600 chunks) and state the number, before the run.

### A4. Item A is correctly located, but its measurement is not established — and the repo contradicts it

The **location is right** and I confirmed the mechanism is straightforwardly fixable:
`LengthPrefixedFrameReader.push` returns an eagerly-built `Uint8Array[]`
(`wt.ts:2073-2108`), not a generator, so `const units = timed(() => frames.push(chunk.value))`
works with no restructuring. Item A is executable as an instruction.

The **number is not**. The plan says:

> Priced on the real reader: 171 ms and 247 ms at 600k frames, about **420 ms of loop
> time dropped per minute at the 10k per second cell rate**

Three problems, each checkable:

1. **It does not state the workload it was priced on.** A per-frame cost is dominated by
   frame size, and the plan names none.

2. **It does not reproduce.** I re-priced both components by execution against the real
   `LengthPrefixedFrameReader` and the real `FanoutDataV1` shape
   (`scenarios/fanout-wire.ts:207-221`, 128-byte payload → 661 bytes on the wire), 600k
   frames, warmed:

   | Arrival pattern | `frames.push` | routing decode | total |
   | --- | --- | --- | --- |
   | 1 frame per stream read | 440.7 ms | 745.2 ms | **1,186 ms** |
   | 16 frames coalesced per read | 213.9 ms | 764.0 ms | **978 ms** |
   | plan | 171 ms | 247 ms | 418 ms |

   The routing decode is **3× the plan's figure** in both patterns, and the total is
   2.3–2.9× it.

3. **The repo already carries a measured price for the routing decode, and it is 44×
   the plan's.** `server.ts:818-822`:

   > Measured on the chat-1k loopback acceptance (2026-09-05): **18 us a frame** against
   > 1.1 us for the stream write it chose, which is 180 ms of the WT server child's 271 ms
   > of relay work per second of the measured window

   18 µs/frame is 10.8 s per 600k frames against the plan's 0.247 s. The plan does not
   cite this constant and does not reconcile with it.

**And the rate is imported from the wrong site.** That same docstring's 10 k/s is the
**delivery** rate at the *charged* egress call site `:1027` (180 ms/s ÷ 18 µs = 10,000),
inside `sink.trySend`, which runs inside `relay.pump()` and therefore inside `timed()`.
The *uncharged* site is `:1126`, on the inbound control stream, which sees publisher data
frames and registrations — roles never send acks inbound (`bin/fanout-role.ts:1466` is a
receive-side check and there is no ack send). In a fanout cell one publish produces N
deliveries, so the inbound rate is the **publish** rate, not the delivery rate. The plan
applies the delivery rate to the inbound site without establishing that the site sees it.

This matters beyond tidiness, for two reasons the plan itself supplies. Risk 1 requires
the correction to be "reported as a correction **with its measured size**"; a size that
is wrong in the unit price and derived from the wrong site is not that. And the plan
frames the magnitude by comparing it to "a sealed WebSocket client figure of 26.3 ms" —
a per-minute server aggregate against a per-session client figure, a category comparison
that makes the correction read as small and harmless. At 420 ms/min it is a footnote; at
the docstring's implied rate it approaches the same order as the 16.3 s/min of relay work
the child currently charges, which would make it the campaign's largest finding.

**Fix:** state the workload, re-derive against `server.ts:818-822` or say why that
constant does not apply to the inbound site, establish the inbound frame rate from the
cell shape rather than importing the delivery rate — or strike the number entirely and
let acceptance bullet 7's before/after measurement supply it. Do not compare a per-minute
server aggregate to a per-session client figure.

---

## Answers to the questions the brief asked

**Is item A correctly located, and is its measurement right?** Located correctly and
executable as an instruction (the reader returns an array, so the wrap is mechanical).
The measurement is not established — A4.

**Does item C still smuggle a wrong branch charge?** No, and this is a genuine
improvement: C explicitly forbids the span-around-the-await and carries the 52.4 ms
measurement as the reason. But it justifies the prohibition with a false premise ("no
arrival callback at all" — `:196-197` is one), and the disposition it substitutes has no
cell (A2) and no guard (A3).

**Can item B leave the WS sink arm reporting zero?** **No — B is sound, and I verified
the chain.** Removing `measureRead`'s await wrapping leaves nothing in that function,
so the reader accumulator goes to zero; restoring the base session's meter is what
prevents the arm reporting ~0 for decoding 100 MiB. And the base meter genuinely holds
that decode: `ws-worker.ts:11-17` states there is no worker thread, so the base session's
`ws.ts:1865` ingest span charges the **same loop** the arm reports. The comment at
`ws-worker.ts:294-296` that justifies the discard — "a loop this arm does not run the
read path on" — is the thing that is wrong, and B is right to remove it.

Two things B must say and does not:

- **Which figure the arm publishes.** "Stop discarding" admits at least three readings —
  base only, base plus a now-empty reader accumulator, base plus some new reader span —
  and they are not the same number. Say which.
- **The denominator.** `ws-worker.ts:301` computes `windowMs` from `sessionOpenedAtMs`;
  `LoopBusyMeter` computes it from meter construction (`transport.ts:167-168`). B changes
  the numerator on this arm and says nothing about which window pairs with it. Mixing a
  base-meter `busyMs` with a worker-computed `windowMs` is a unit mismatch feeding the
  `0.3` detector, and this repo has a named gotcha for precisely that family. Raised in
  r1, r2 and r3; still unaddressed.

**Does the four-cell taxonomy have a remaining seam that fits no cell?** Yes — at least
three: the WHATWG branch of `readChunk` reached from `:1251` (and again through the
`wt-stream-sink.ts:253` decorator over it), `wt.ts:454`, and `wt.ts:1306`. A2.

**Is the drift ceiling falsifiable and not arbitrary?** Falsifiable in form, arbitrary as
written: no value, no workload, and unreachable at one of the two sites. A3.

**Does acceptance contain anything unreachable?** Two things.

- Bullet 4, at the WHATWG site — A3.
- **Bullet 1: "a test drives the fanout ingest and fails if either step is outside the
  span."** There is no mechanism at HEAD. Both relay `timed()` helpers read
  `performance.now()` directly (`server.ts:642-650`, `:957-963`), and neither
  `FanoutRelayWsPeerOptions` nor `FanoutRelayWtPeerOptions` accepts a clock — unlike the
  adapters, which take an injectable `TransportClock`. A *driving* test can therefore only
  assert against real wall time, which is flaky at these magnitudes. Either schedule
  clock injection into the two relay `timed()` helpers (unscheduled work the acceptance
  currently requires), or make bullet 1 a **structural** assertion — the `frames.push` and
  `relayFrameRoutingFields` calls are lexically inside the `timed()` call — which this
  repo already has the tooling shape for. Say which; as written the bullet reads
  behavioural and cannot be met deterministically.

**Is the surface-enumeration test sufficient to prevent a third instance?** No, for
three reasons.

- **F2. The inventory is already short.** There are **six** `acceptUni` implementations,
  not five: `ws.ts:1644`, `wt.ts:1242`, `wt.ts:1566`, `wt-stream-sink.ts:305`,
  `ws-worker.ts:255`, and **`bin/compare-controller.ts:804`** — a full session decorator
  on the production path, verified at HEAD, and one of the three decorators r3 named. A
  table built to the plan's count omits it. (The `read` count of six is correct.)
- **The plan never says how completeness is *derived*.** If D's first test compares the
  table against a hand-maintained list, it is vacuous in exactly the way r3 refused —
  the list and the table go stale together. Completeness must be derived from the source
  (a scan) or carried by the type system.
- **The defect lives below the surface the taxonomy is keyed on.** `readChunk` is one
  function with two branches and two live construction sites reaching different ones. A
  per-surface table cannot see that, which is why A2 exists at all. The enumeration must
  bind to **construction sites**, and C's driver must exercise both — not both seam names.

The structural half of this, unscheduled since r2: **make the meter parameter required.**
`makeBidiChannel(duplex, clock, busy?)` (`wt.ts:426-429`) is what let W2 happen — the
meter is present and unused for `read`. Give `makeReceiveChannel` a meter, make the
parameter required on both, and the compiler carries the load the table otherwise has to
chase by hand.

**Is the objective right, or is there a better framing?** The reframing is right and I
endorsed it in r3; nothing here retracts that. But work item A has quietly changed what
the plan is about, and the plan has not noticed. R3's story was "the read path is
unmetered." A's story is different and better: **spans are placed by hand at call sites,
and nothing structural makes them cover the work.** The relay drops its decode because a
human drew the `timed()` boundary in the wrong place; `makeBidiChannel` drops its read
because a human passed a meter and used it twice out of three times; `makeReceiveChannel`
drops everything because a human omitted a parameter. Three instances, one cause. The
durable fix is to make the charge a property of the **seam constructor** — a required
meter, and a relay `timed()` that takes the reader rather than a hand-placed closure —
with the table as the audit of that, not the mechanism. The plan does per-site surgery
plus a table, and a table is a thing that goes stale. Say the cause out loud; it is the
plan's real finding and it would change what D is for.

**Does anything contradict the published definition, and is the definition still right?**
Nothing in the plan contradicts it. On substance it holds up, and it is what makes the
small WT figure *correct* rather than missing. On **role** it is wrong and work B makes it
wronger by charging a client read into a figure the constant calls the server's. That is
A1's second half, and it is now unscheduled for the fourth revision while the plan says
it is scheduled.

---

## Smaller items — say these, none blocking on its own

- **S1. Name the nudge and why it is dead.** Work C's singular "the arrival body" on the
  Node branch is correct, but only because `once("data")` sets `readableFlowing` before
  the guard at `wt.ts:241` is evaluated. Say that. It costs one sentence, it is the
  difference between a decision and a coincidence, and if anyone ever reorders those two
  statements or a duck-typed stream without `.once` reaches `readChunk`, `:243-250`
  becomes a live unmetered arrival body.
- **S2. Work B invalidates two docstrings it does not name.** `server.ts:556-558` and
  `server.ts:1256-1257` both cite `adapters/sink-worker.ts:227` as the definition of "the
  same reading" Phase B takes. B deletes that reading. Both must move with it, or Phase B
  will cite a definition that no longer exists.
- **S3. `frames.push` is at `:1118`, not `:1116`.**
- **S4. Work A should say the `await inbound.read()` at `:1116` stays outside the span.**
  It is the idle wait, excluding it is correct, and an implementer told to "bring the
  reassembly inside" while looking at an adjacent await is one line away from recreating
  W2 on the producer this plan exists to fix.
- **S5. Work D does not say where the count surfaces.** A classification with no field a
  gate can read exists only in a log.
- **S6. Test disposition is still unnamed.** Say which suites must stay green — the
  exact-`65` assertions in `wt.test.ts` (`:1119`, `:1121`, `:1166`, `:1169`, `:1213`,
  `:1216`) drive the message path through `receiveMessage`, not stream reads, so work C
  must not move them. If it does, that is the seam-flag bug of A1 announcing itself.

---

## What would make this APPROVED

1. Schedule the seam flag and `SESSION_LOOP_BUSY_MS_DEFINITION` in the work items, or
   strike the Risks claim that D and F already do (A1).
2. Resolve the WHATWG branch into a cell — preferably by charging `wt.ts:196-197` at its
   truthful ~0.012 ms, which retires the fifth label and the contradiction together — and
   give `wt.ts:454` and `wt.ts:1306` a stated disposition (A2).
3. Give the ceiling a pre-stated value and workload, and give the WHATWG site a guard
   that can actually fire — a zero-charge assertion, once it has a cell (A3).
4. Re-derive item A's number with its workload stated, reconciled against
   `server.ts:818-822`, with the inbound frame rate established from the cell shape rather
   than imported from the delivery site — or strike the number and let the before/after
   measurement supply it. Stop comparing a per-minute server aggregate to a per-session
   client figure (A4).
5. Add `bin/compare-controller.ts:804` to the inventory, say how completeness is derived
   rather than asserted, bind the enumeration to construction sites, and make the meter
   parameter required (F2).
6. Say which figure the WS sink arm publishes after B, and which `windowMs` pairs with it.
7. Make acceptance bullet 1 achievable: either schedule clock injection into the relay
   `timed()` helpers, or state it as a structural assertion.
