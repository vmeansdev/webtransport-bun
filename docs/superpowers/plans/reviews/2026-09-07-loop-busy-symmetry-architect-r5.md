CHANGES REQUIRED

# Architect review (revision 5) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed by me, before reading) | `77cd84b165cdc3f38b56a3e4186ca3ec3b1403d8c7f8f1d7d49cb7b51b75d2e5` |
| Declared SHA-256 | identical |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | no tracked modification under `tools/`, `packages/`, `docs/`; untracked evidence and review documents only |
| Prior artifacts read | `…-architect.md` (r1) through `…-architect-r4.md` (r4) |
| Method | every `file:line` the plan cites read at HEAD; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → 29 pass / 0 fail; item A re-priced by execution on the real `LengthPrefixedFrameReader` with a real 660-byte fanout data frame; the four sealed WS arms re-read out of `.release-evidence/`; every relay entry point traced for span coverage |

**Two things before the refusal, because both change the standing record.**

**R5 discharges three of my four r4 blockers outright, and one of my two withdrawn
statements was withdrawn correctly against me.** `wt.ts:194-198` is
`reader.read().then(res => res.done ? null : (res.value ?? null))` — an arrival
continuation, exactly as R5 says. My r4 "no arrival callback at all" was wrong to build a
fifth label on, and R5 is right to delete the label, the missing cell and the ceiling
exemption together. A2 and A3 are discharged.

**Item A's number now reproduces, and I say so with my own measurement.** I re-priced both
uncharged bodies on the real reader at 600k frames, warmed, in both arrival patterns:

| Arrival pattern | `frames.push` | routing decode | total | per frame |
| --- | --- | --- | --- | --- |
| 1 frame per stream read | 273.6 ms | 744.3 ms | **1,017.9 ms** | 1.70 µs |
| 16 frames coalesced | 184.6 ms | 913.4 ms | **1,098.0 ms** | 1.83 µs |
| plan (r5) | — | — | 1,028–1,043 ms | ~1.72 µs |

That is inside noise of the plan's figure. The workload is stated, the inbound rate is now
derived from `scenario-registry.ts:256-263` (`ingressRatePerSecond: 10_000`,
`publisherCount: 1`) rather than imported from the delivery site, and the per-minute /
per-session category comparison is gone. **A4's substance is discharged.**

**It is refused on two grounds, both cheap, one of them my own error.**

---

## Facts checked, and the result

Every claim the brief named, plus every citation the plan makes. All read at HEAD.

| Claim | Verified |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => this.dispatchSocketMessage(value))` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `reservation.release()`; no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** `makeReceiveChannel(readable, clock)` takes no meter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** `grep '"ingest"'` over the tree returns `ws.ts:1865` and `wt.ts:924` only; `:924` is the envelope pump |
| `acceptUni` has one production consumer (`client.ts:883`) | **True** |
| WS server ingests through its message callback (`server.ts:670`) | **True**, and it charges everything it does |
| Sealed artifact carries only server figures | **False**, and the plan no longer claims it: `artifact-builder.ts:536-541` declares `perSession` **and** `serverAggregate`, `:786-800` validates both |
| No gate constrains `busyMs` | **False**, and the plan no longer claims it: monotonicity refusal at `server.ts:2529`, minting at `:2572`, the `0.3` caveat at `render-report.ts:48` |
| W1: `frames.push` at `server.ts:1118`, `relayFrameRoutingFields` at `:1126`, both outside `timed()` | **True.** (The span opens at **`:1119`**, not `:1120` as the plan says — a one-line slip.) `onRelayWork` wired at `:3036` → `loop.record` → `createCohortServerLoopObserver` (`:1277`), forwarded at `:1203`. Production |
| W1: the WS peer at `:670` performs neither step | **True.** WS preserves message boundaries and its `sink.trySend` is `session.send(bytes)` with no routing decode |
| **Scope probe I ran: is the *delivery*-side decode also uncharged?** | **No — it is charged.** `relayFrameRoutingFields` at `:1027` runs inside `sink.trySend`, which runs inside `relay.pump()`, and every one of the eleven `relay.pump()` / `openSession` / `closeSession` / `handleInboundBytes` call sites in `server.ts` is inside `timed()`. The plan targets the only uncharged relay work there is. At `fanout: 100` a missed delivery site would have been 100× the headline; it is not missed |
| W2: `sink-worker.ts:222-229` wraps the whole `await`; **both** arms discard the base meter (`ws-worker.ts:298-302`, `wt-stream-sink.ts:345-348`) | **True on both.** Adding the second arm is the r4 critic's catch and it is real |
| W3: `ws-worker.ts:11-17` — no worker thread, so the base meter is the same loop | **True** |
| W4: `:1569` Node branch (`RecvStream extends Readable`, `streams.ts:396`); `:1251` WHATWG branch (`index.ts:949`, `:2241`); `wt.ts:94` misdeclares it and `:1251` casts | **True on all four** |
| W5: `wt.ts:454` and `:1306` take a meter and use it for `write`/`end` but not `read` | **True**, verbatim at `:426-429` / `:433-454` |
| W6: WS `read`/`acceptUni` are already inside the `:1865` span | **True, and I checked the boundary by execution.** `awk` over `1870..2012` finds exactly one method declaration, `:1870` — so `:1998-2001` is inside `dispatchSocketMessage`, inside the span. The WS rows may legitimately use cell three |
| W7: `render-report.ts:233` calls both scopes the server's; `transport.ts:131-136` says "this server" | **True on both** |
| W8: `wt.ts:1655-1664` drops a late charge; conservation/monotonicity hold | **True** |
| W9: `65 / 1250` at `cohort-fixture-signing.ts:194-198` | **True** |
| E: `seam` fires `noteBusySlice` on span *entry* (`transport.ts:206-219`), so `seam = chunk !== null` is only expressible once the chunk is known | **True**, and it is expressible in the `.then` body — the same shape as `wt.ts:924` |
| Acceptance 6: the four sealed WS values | **True.** 26.3125, 40.0815, 45.0754, and 54.9423828125 (the plan's "54.9424" is that value rounded), all present in `.release-evidence/` |
| Baseline suites green | **True.** 29 pass / 0 fail |

---

## Blocking findings

### A5-1. The census is still a hand count, it is still short, and completeness is still underived

This is my r4 F2, carried. R5 fixed one of its three parts — the key is now construction
site and seam, which is right and is a real improvement — and left the other two.

**The count is wrong, and the plan's own sentence proves it.** W5 says "Eleven
implementations exist: six `read`, five `acceptUni`, **counting the three production
decorators**." One grep:

```
adapters/ws.ts:1644          async acceptUni(...)
adapters/wt.ts:1242          async acceptUni(...)
adapters/wt.ts:1566          async acceptUni(...)
adapters/ws-worker.ts:255    async acceptUni(...)        decorator
adapters/wt-stream-sink.ts:305  async acceptUni(...)     decorator
bin/compare-controller.ts:804   acceptUni: (deadlineMs) => base.acceptUni(deadlineMs)   decorator
```

Three non-decorator implementations plus three decorators is **six**, not five. The five
the plan counts contain only **two** decorators, so the phrase "counting the three
production decorators" is false about the plan's own list. The omitted one,
`bin/compare-controller.ts:804`, is a full session decorator on the production controller
path — I named it with its file:line in r4 and it is unchanged at HEAD.

**And the `read` half is short by the same mechanism.** `wrapBidi` produces a second
`read` on each decorator — `ws-worker.ts:228` and `wt-stream-sink.ts:278`, both
`read: (deadlineMs) => receive.read(deadlineMs)` — so a mechanical enumeration of channel
`read` implementations returns **eight**, not six. A census keyed on construction site, as
D correctly requires, must see them: they are distinct sites.

Twelve or fourteen rather than eleven is not the finding. **The finding is that the plan
still specifies the census as a number, and a number is the thing that goes stale.** My r4
asked for the derivation and R5 does not answer it: D says "Three tests: completeness, …"
and never says what completeness is measured against. If the completeness test compares
the table to a hand-maintained list, the list and the table go stale together and the test
is vacuous — which is the exact failure D exists to prevent. If it compares the table to a
scan of the source, the count in W5 is merely wrong prose and harmless. The plan does not
say which, and the two readings differ in whether work D is a mechanism or a decoration.

This matters more here than it would in another plan, because **the plan's real finding is
that hand-placed things go stale, and it has not said so.** Four instances, one cause:
the relay drops its decode because a human drew the `timed()` boundary in the wrong place;
`makeBidiChannel(duplex, clock, busy?)` drops its read because a human passed a meter and
used it for two seams of three; `makeReceiveChannel` drops everything because a human
omitted the parameter; the sink arms publish a worker figure because a human wrote an
override. A table maintained by hand is a fifth instance of the same cause, installed as
the cure.

**Fix — three sentences, no redesign.**

1. Say the census is derived from a scan of the source (or carried by the type system),
   not from a list, and strike the number from acceptance bullet 3.
2. Add `bin/compare-controller.ts:804`, `ws-worker.ts:228` and `wt-stream-sink.ts:278`, or
   state the scope rule that excludes pure delegators — and if you state that rule, note
   that it does *not* exclude `ws-worker.ts:255` or `wt-stream-sink.ts:305`, which do work
   (`wrapReceive`).
3. Schedule the structural half you have never scheduled: **make the meter parameter
   required**. `makeBidiChannel(duplex, clock, busy?)` at `wt.ts:426-429` is what let W5
   happen. Give `makeReceiveChannel` a meter and make the parameter required on both, and
   the compiler carries what the table would otherwise chase by hand. That is one line of
   plan text and it converts D from an audit into a mechanism.

### A5-2. The 18 µs upper bound prices an operation the code does not perform — and the error is mine

The plan's headline is "**between about 1 second and about 10.8 seconds of loop time per
minute**", and work A instructs the implementer to "cite the repository's own 18 µs per
frame". The 10.8 s comes from `18 µs × 600k`.

`server.ts:818-822` does not price `relayFrameRoutingFields`. Read the whole sentence it
sits in:

> …and running **`codec.decode`** at either re-parsed, re-canonicalised and byte-compared
> the frame a second time … Measured on the chat-1k loopback acceptance (2026-09-05):
> **18 us a frame** against 1.1 us for the stream write it chose…

18 µs is the price of `codec.decode` — the alternative the docstring exists to justify
*rejecting*. The function that actually runs at `:1126` is the cheap replacement:
`DataView.getUint32` + one `TextDecoder.decode` + one `JSON.parse` (`:836-851`).

I did not settle this on grammar. **I measured it:** the replacement costs **1.24 µs a
frame** (744.3 ms / 600k), 14.5× below 18 µs and consistent with the docstring's own
"1.1 µs for the stream write it chose" as the neighbouring order of magnitude. Under
either reading of that sentence — a rejected design, or an older one — 18 µs is not the
price of what runs at `:1126` today.

So the plan's upper bound is roughly 10× too high, and it is 10× too high *by citation*: a
number that reads as evidence, carries a file:line, and prices something else. In a
campaign whose entire subject is whether a published figure names the work it did, that
is the defect being repaired, appearing in the repair.

**This is my error and I want it on the record as mine.** R4 asserted the 18 µs
attribution as a blocking finding and demanded R5 reconcile with it. R5 reconciled, by
adopting it. The plan is refused for repeating me, which is unfair to the plan and fair
to the number.

**Fix — one sentence.** Strike the 10.8 s upper bound, or relabel it explicitly as the
counterfactual price of the `codec.decode` design that was rejected and is not on this
path. The finding stands on its own measurement: **~1.0 s of loop time per minute** at the
canonical cell rate, against the WT child's ~16.3 s/min of charged relay work — a ~6%
correction to the campaign's headline Phase B figure, still the largest single item in the
plan, and still correctly first. Acceptance bullet 7 already requires the real before/after
number, so nothing downstream depends on the estimate being wide.

---

## Answers to the questions the brief asked

**Is the objective the right one, or should the metric be defined differently?** Right, and
I re-endorse it. `SESSION_LOOP_BUSY_MS_DEFINITION` measures JavaScript event-loop time on
transport work and explicitly excludes native, kernel and other-thread time. WS does its
framing in JS and WT does it in the addon, so a 170 / 48.5 ms split is the metric working,
not failing. Charging the read path fixes a **completeness** defect, not a definition
defect. Nothing in the plan contradicts the definition. The definition remains right once
the read path is charged, on substance; it is wrong on **role**, which F now schedules.

One thing the plan should say and does not: **C closes the read-side honesty gap without
closing the A5 gap, and the report must not be read as if it did.** The honest WT arrival
charge is 0.179 / 0.253 ms for 100 MiB — essentially the meter's own overhead — against a
WS ingest charge that carries 47–49 ms of real frame decode. After C both figures are
complete; they are still not comparable term by term. Acceptance's "no pinning of a low
figure as correct" protects the number but not the reader.

**Does the scope cover every seam that could carry the same defect?** On the relay, yes,
and I proved it rather than assuming it: every `relay.pump` / `openSession` /
`closeSession` / `handleInboundBytes` call site in `server.ts` is inside `timed()`,
including the delivery-side `relayFrameRoutingFields` at `:1027`. `frames.push` and
`:1126` are the only uncharged relay work. On the adapters, the *seams* are covered but the
*census of seams* is not — A5-1.

**Is the work-item-2 surface enumeration sufficient to prevent a third instance?** Not as
written. Keying on construction site and seam is the right key and fixes the half of my r4
objection that mattered most conceptually. But an enumeration whose completeness is
asserted as a count, with no derivation and no required-parameter backstop, can be
satisfied while a live seam is absent — and one demonstrably is. A5-1.

**Is the acceptance criterion falsifiable as written?** Bullets 2, 4, 6 and 7 are, cleanly.
Bullet 4 is now reachable at both sites, because C leaves both branches with a charge to
bound; 5 ms against a measured 0.179 / 0.253 and a dishonest 52.4 is a real separation
pre-stated before the run, which is what I asked for. Bullet 3 is falsifiable only under
the scan reading (A5-1). **Bullet 1 I now believe is reachable and I withdraw my r4
objection to it:** I said a driving test could not be deterministic because neither relay
`timed()` helper takes an injectable clock (`server.ts:642-650`, `:957-963` — still true).
At the corrected price of 1.7 µs a frame, driving 100k frames moves ~170 ms of charge,
which is orders above timer noise. Say the frame count in the plan and it is deterministic
without clock injection.

**Anything the plan should say and does not.**

- **B's correctness on the WT arm depends on C landing.** The `wt-stream-sink` base is the
  WT primary (`wt-stream-sink.ts:1-8`), whose only ingest span is the envelope pump at
  `wt.ts:924`. For a stream-read workload the base WT meter charges **nothing today**, so
  B alone replaces one fabricated zero with another; only C makes the restored figure real.
  Acceptance bullet 2 catches it, but an implementer who does B first, sees the new test
  red, and "fixes" it by keeping the suspension charge has undone the plan. One sentence.
- **Say that B deletes the override rather than recombining terms.** Both arms compute
  `windowMs` from `sessionOpenedAtMs` (`ws-worker.ts:131/300`, `wt-stream-sink.ts:161/347`)
  while `LoopBusyMeter` computes it from meter construction (`transport.ts:167-168, 177`).
  Pairing a base-meter numerator with a worker-computed denominator is a unit mismatch
  feeding the `0.3` detector. The minimal reading of "restore the base session meter" —
  drop the `loopUtilization` key and let `...metrics` through — has no mismatch. Say that,
  and the question I have raised in four reviews closes for good.
- **C implies a type change the plan does not name.** Fixing `wt.ts:94` and removing the
  `as unknown as Readable` cast at `:1251-1253` means `makeReceiveChannel(readable:
  Readable, …)` no longer accepts that site. The honest repair is a union type there and at
  `readChunk(readable: any, …)` (`:178`) — and typing that parameter is what makes the two
  branches visible to the compiler instead of to a duck-type check, which is the same
  structural point as the required meter.
- **F leaves the definition hand-copied.** F schedules `transport.ts:131-136` and
  `render-report.ts:233` in one change "so they agree" — which discharges my r4 ask. It does
  not make them *unable* to disagree: `:233` stays an independent string that a fifth
  revision can drift. Import the exported constant into the report legend; one line, and
  the class retires. (The brief describes F as making them "cannot disagree"; the plan says
  "agree". The plan's text is the weaker of the two.)
- **F does not say what the corrected definition asserts.** W7 identifies the defect as
  role — "calls both scopes the server's; one is the client's" — but F's instructions are
  "state what the figure excludes" and the fixture note. Say the fix: make the constant
  role-neutral and carry the role as a labelled property of each attested figure, so
  `perSession` and `serverAggregate` each name whose loop they measure.
- **`seam = chunk !== null` is classified but not instructed.** D names the flag verbatim,
  which discharges my r4 A1. But D is the taxonomy item and C is the item that installs the
  span. One clause in C — "pass `seam = chunk !== null`, as `wt.ts:924` does for
  `envelope !== null`" — removes the indirection.
- **The nudge at `wt.ts:239-250`.** C's singular "the arrival continuation" is correct on
  the Node branch only because `readable.once("data", onData)` at `:236` sets
  `readableFlowing` to `true` before the guard at `:241-243` is evaluated, so on a real
  node `Readable` the third arrival body is unreachable. Say it. `readable.once?.` is
  optional-chained, so a duck-typed stream without `.once` reaches it live and unmetered.

**Anything the plan says that the code does not support.** One: the 18 µs attribution
(A5-2). One citation slip: the `timed()` span opens at `server.ts:1119`, not `:1120`.
Everything else in the plan checked out against HEAD, including both statements R5
withdrew — `wt.ts:194-198` is an arrival continuation and my r4 was wrong to say otherwise,
and item A's re-priced number reproduces on my own bench.

---

## What would make this APPROVED

1. State how the census is derived — a scan of the source, or a required type — strike the
   count from acceptance bullet 3, add `bin/compare-controller.ts:804`,
   `ws-worker.ts:228`, `wt-stream-sink.ts:278` (or state and apply a delegator rule), and
   schedule the required meter parameter on `makeReceiveChannel` and `makeBidiChannel`.
2. Strike the 10.8 s/min upper bound, or relabel it as the counterfactual price of the
   rejected `codec.decode` design. The measured ~1.0 s/min stands on its own and I have
   reproduced it.

Nothing else blocks. The smaller items above are worth taking in the same pass, but I
would not refuse a sixth revision over any of them.
