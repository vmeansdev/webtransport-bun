CHANGES REQUIRED

# Critic review (revision 2) — loop-busy symmetry across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `602af7b801e3b0b8fac5761e7f789261ad731bf665a92b35494b47b15bee7481` |
| Declared SHA-256 | identical — verified before reading the plan |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Prior artifacts read | `…-critic.md` (my r1), `…-architect.md` (r1), `…-architect-r2.md` (r2, `CHANGES REQUIRED`) |
| Method | every cited `file:line` read at HEAD; six sealed `bulk-one-way/physical` arms parsed and their embedded evidence frames base64-decoded; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → 29 pass / 0 fail; three executed probes pricing the prescribed charge site |

Revision 2 is a real improvement and it corrected me on a point I got wrong. I set out to
refute it anyway. The correction to my C1 is **true** and I confirmed it from the artifacts.
But the plan's central prescription — work item A — inherits an argument **I** gave it in r1,
and that argument is false. I confirmed the Architect's A1 independently and by execution.
Six blocking findings below; two of them (K3, K4) are corrections to the Architect's r2
report, and one (K6) is new to both of us and bears directly on the acceptance clause the
task asked me to check.

---

## The plan's correction to me is TRUE — confirmed from the artifacts

I decoded `attestationEvidence.serverObservationEvidence.snapshotFrameBase64` on every
sealed `bulk-one-way/physical` arm on disk.

| candidate / arm | `perSession` | `serverAggregate` | decoded frame |
| --- | --- | --- | --- |
| `8ada2d1b` ws | `54.9423828125 / 954.010` | `65 / 1250` | `childPid 4242`, `baselineAtLinuxNs "1000"`, ack `issuedAtMs 1700000000002` |
| `8ada2d1b` wt | **`0`** / `2258.329` | `65 / 1250` | same fixture constants |
| `f9d0cd54` wt | **`0`** / `2447.587` | `65 / 1250` | same fixture constants |
| `cc866b8b` ws | `45.075439453125 / 958.620` | `65 / 1250` | same fixture constants |
| `cc866b8b` wt | **`0`** / `2220.750` | `65 / 1250` | same fixture constants |
| `c7fafa52` ws | `26.3125 / 962.176` | **`1 / 977`** | `childPid 3788496`, `baselineAtLinuxNs "243308876"`, `issuedAtMs 1788778476360`, real `linuxClockId`, `bulk-source-completion/v1` with `bytesWritten 104857600` |

`1700000000000` is `cohort-fixture-signing.ts:194`; `spanMs ?? 1_250` / `busyMs ?? 65` is
`:196-197`. So the historical figures are fixture-minted, conclusively, and the `c7fafa52`
figure is a real capture from a real child. **My C1(b) was true of the artifacts I read and
false of the one I did not. The plan is right and I was wrong.** Fact 2 stands as written.

Two things the plan should add while it is being this precise:

- **There is no sealed WT arm under `c7fafa52`.** Every WT arm on disk carries the fixture
  `65/1250`. That is good news the plan does not claim: the WT arm has never sealed under a
  real server figure, so no WT incomparability has to be disclosed at all.
- **The Phase-A server figure is `LoopBusyMeter`-derived, and the plan should say so**, because
  it is what makes `1 / 977` credible rather than suspicious. `server.ts:2757` is
  `busyMs: () => Math.floor(server.snapshot().serverLoopUtilization.busyMs)`, and
  `serverLoopUtilization` is the adapter's closed-plus-live walk (`wt.ts:1666`, `ws.ts:2287`).
  A send-only server under pre-`60f4a59b` semantics, floored at the read, reporting 1 ms is
  the expected reading. Fact 3's dating is right.

**Fact 1 is also true and is the plan's strongest sentence.** The bulk leg is receive-only on
the client (`client.ts:883` accept, `:891` read loop), `arm-measure.ts:228` takes
`leg.loopUtilization` and refuses at `:232` for a missing *consumer* loop — and the sealed
record shows `54.94` on WS against exactly `0` on WT, three times. The gap is active, sealed,
and it is the largest asymmetry in the campaign.

## Every other cited fact, checked at HEAD

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`:2146`) only dequeues | **True.** `waitForQueue` + `reservation.release()` |
| WT charges nothing for stream reads (`makeReceiveChannel` `:410`, `readChunk` `:177`, sites `:1251`, `:1569`) | **True.** `makeReceiveChannel(readable, clock)` takes no meter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** Ten span sites in `wt.ts`; `:924` is the only `"ingest"`. `ws.ts` likewise has exactly one, `:1865` |
| `acceptUni` has one production consumer (`client.ts:883`) | **True** as a consumer; it is still reached through three forwarding wrappers — see K7 |
| `server.ts:388-390` is `echoSession`, not the relay (W6) | **True.** `echoSession` opens at `:379`; relays at `:631`, `:946`, `:1191` |
| `:670` metered by a local `timed()` that is a no-op when `onRelayWork` is unset; `startBinaryMessageServer` holds no meter | **True** (`timed` at `:642-650`) |
| Fanout WT ingest (`server.ts:1102`, `:1116`) raw and unmetered | **True**, and `frames.push(chunk.value)` — the reassembly — sits *outside* the `timed()` at `:1119` |
| r1's "sealed artifact carries only server figures" | Correctly **retracted**. `artifact-builder.ts:536-541` declares both scopes; `:786-800` validates `windowMs` only |
| `sink-worker.ts` `measureRead` wraps an `await` (`:222-229`); `ws-worker.ts:298-302` overwrites `loopUtilization`; `read-path-adapters.test.ts:291` pins it | **True**, verbatim |
| `evidence.ts:238-252` — four arms, two read-path | **True** (`ARM_WIRE`, `ARM_READ_PATH`) |
| `createCohortServerLoopObserver` (`server.ts:1277`), docstring anchored to `sink-worker.ts:227` | **True** (docstring `:1255-1256`) — but see K4 |
| `wt.ts:1655-1664` freezes `busyMs` at close, once | **True** |
| `render-report.ts:233` calls both figures the server's | **True**, verbatim |
| Baseline `29 pass / 0 fail` | Reproduced |

**Non-blocking citation slips** (I confirm the Architect's two and add one): `makeBidiChannel.read`
is `:454` not `:455`; `readFromStream` is `:468` not `:467`; the inline `acceptBidi` channel's
`read` is `:1305` not `:1307`; and W3's "`acceptUni` **and `acceptBidi`** … (`:1242`, `:1566`)"
cites two `acceptUni` sites — `acceptBidi` is `:1272` and `:1587`. The substance is right in
every case.

---

## Blocking findings

### K1. Work item A's stated reason is false — and the false argument is mine

W1 rejects r1's placement with this:

> Charging `readChunk` instead, as revision 1 said, charges the pull, so a WT session whose
> peer floods an unread stream would charge zero where WS charges full decode. The charge
> point must be the arrival callbacks.

That is my r1 C2, restated. **It is wrong, and moving the charge does not obtain the property.**
`readChunk` attaches its listeners *inside the promise executor, per call*, and removes them in
`cleanup()`:

```
readable.once?.("data", onData);     // wt.ts:235-237
readable.once?.("end", onEnd);
readable.once?.("error", onError);
```

and the WHATWG branch calls `readable.getReader()` on entry (`:182`) and `reader.releaseLock()`
in its `finally` (`:203`). With no `read()` outstanding there is no `onData`, no `.then`
continuation and no reader. A WT session whose peer floods an unread stream charges **zero at
the arrival callbacks too**. The Architect is right; I confirmed it by reading and by running it.

**And there is almost nothing there to charge.** `Buffer` *is* a `Uint8Array`, so
`chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)` never copies. Executed probes on
this machine, 1600 chunks of 64 KiB — the exact bulk-arm shape:

```
Buffer instanceof Uint8Array: true
onData body (1600x):                              0.253 ms   copyTaken: false
full readChunk scaffolding + dispatch (1600x):    3.205 ms
one 100 MiB JS copy, for scale:                  20.638 ms
```

So r1's placement and r2's placement differ by about **3 ms**, against a sealed WS figure of
26.3–54.9 ms. The plan changed its charge point for a property it does not gain, at a magnitude
that does not matter.

Limit of the probe, stated: it prices the callback *body and scaffolding* the plan names, using
`node:stream` and `EventEmitter` stand-ins, not Bun's production WT readable. That is the right
thing to price, because that body is the plan's charge site — but neither reviewer has priced
the production readable, and the plan should not pretend otherwise.

**One consequence neither review has drawn.** The only construction that would actually charge a
flood is a session-lifetime pump on the readable. A permanent `'data'` listener puts a Node
`Readable` into flowing mode for the session's life, which changes when bytes leave the stream's
buffer — i.e. it changes the backpressure behaviour of the transport being measured. My first
probe stalled after one chunk precisely because per-call listener attach/detach against a
flowing source loses emitted data; that is my probe's artifact, not production's, but it
demonstrates that listener lifetime on this path is semantically load-bearing. **A measurement
instrument that changes the thing measured must not be installed silently.** Either drop the
flood argument and say plainly that the WT read charge is *completeness, not magnitude*, or
commit to the pump, price it, and state what it does to backpressure.

The plan must also say **which branch of `readChunk` production takes at each site**. Both
`incomingUnidirectionalStreams` shapes are typed `Readable` (`wt.ts:94`, `:121`) and a Node
`Readable` has no `getReader`, so both sites should take the EventEmitter branch — but `:1251`
casts through `as unknown as Readable`, and this repo has a named gotcha for metering a dead
branch. Prove it, don't infer it.

### K2. Acceptance bullets 1 and 2 are unreachable by honest charging

Given K1's measurements, honest charging yields WT ≈ 0.25–3.2 ms against WS's sealed 26.3–54.9 ms
on the same 100 MiB receive-only leg: an **8×–200× gap**, not "the same order". Bullet 1 fails.
Bullet 2 fails on "work-tracking": the charge scales with `read()` call count, not with bytes —
it would read the same for 1600 × 64 KiB and 1600 × 64 B.

That gap is not a defect. It is the definition working: `SESSION_LOOP_BUSY_MS_DEFINITION`
excludes native and kernel time, WS frames every inbound message in JavaScript
(`decodeWebSocketFrame`, `ws.ts:1881`, inside the ingest span), and WT frames in QUIC below the
JS boundary. The WT *message* path proves the rule from the other side: `makeMessageStreamReceiver`
does real JS reassembly and *is* charged, at `:924`.

An implementer facing a red acceptance and a green risk register will widen the span until the
number looks like work, and the only way to reach tens of milliseconds on WT is to charge
suspension — W4's defect re-created on the seam just fixed. Replace bullets 1 and 2 with a
pre-stated, falsifiable bar: every classified seam charges, proven per construction site; an idle
reader charges nothing; **the WT receive figure is expected one to two orders of magnitude below
WS's, and a WT receive figure in WS's order is a failure signal, not a success signal**; the
residual is attributed to named measured components, as `60f4a59b` did on the send side.

### K3. Correcting the Architect: the 0.3 detector *does* catch the failure the plan names

The Architect writes that the detector "will not catch it either" and that the plan over-credits
it, computing 50 ms / 2258 ms = 0.022. That arithmetic is right and the conclusion is too broad.

The failure the plan's first risk names is *"the obvious implementation wraps an `await`"* — the
`measureRead` shape at `sink-worker.ts:222-229`. Applied to the bulk read loop that books
approximately the **whole read wall time**: the sealed WT arm's window is 2258 ms and the read
loop occupies essentially all of it, so the ratio goes to ≈1.0 — six times the
`REPORT_CONFIG.loopUtilizationSaturationThreshold` of `0.3` (`render-report.ts:48`, `:123-128`).
**The detector fires on exactly the failure the plan is most likely to cause.** What it cannot
see is a *partial* over-charge that lands in the tens of milliseconds.

So the plan should keep the detector and state its resolution: it is a guard against
suspension-charging, and it is blind to a 50 ms inflation. That is a more useful sentence than
either "use it as one" (the plan) or "it is not a guard" (the Architect).

### K4. Correcting the Architect: D is not a run-killer, it is a silent-loss bug — which changes what D must pin

A6 escalates D by claiming a late charge "makes `busyMs` and `finalBusyMs − baselineBusyMs`
disagree, and the frame is then **refused**" at `secure_fs.rs:17799` and
`server-snapshot-protocol.ts:177`. **That cannot happen.** `server.ts:2572` mints the field as

```
busyMs: finalBusyMs - baselineBusyMs,
```

by construction, from two reads of one accumulator. The conservation check is a decode-side
guard against a *lying child*, not a constraint the honest producer can violate. The other
candidate, the monotonicity refusal at `server.ts:2529` (`"the server loop went backwards"`),
also cannot fire from this: `onSessionClose` (`wt.ts:1655-1664`) freezes and deletes in one
synchronous step, so closed-plus-live is non-decreasing, and a charge into a closed session's
meter is simply never summed.

The real hazard is therefore **silent under-reporting**: an arrival callback that fires after
`close()` charges into an accumulator nothing reads, and the campaign's headline number quietly
loses it with every gate green. That is worse than a refusal, not better, and it changes what D
must build. D must pin *that a post-close arrival's charge is either counted or explicitly
refused* — not that the frame validates, which it always will.

### K5. "No gate constrains `busyMs` today" is still false, and the plan contradicts itself two bullets earlier

Five constraints exist at HEAD, all re-verified:

| Constraint | Location |
| --- | --- |
| Conservation `busyMs == finalBusyMs − baselineBusyMs`, else `BindingMismatch("busyMs")` | `crates/native/src/secure_fs.rs:17789-17800` |
| The same conservation on decode | `tools/compare/server-snapshot-protocol.ts:176-179` |
| Monotonicity refusal, "the server loop went backwards" | `tools/compare/server.ts:2529-2533` |
| `busyMs` finite (leg) / finite and non-negative (server) | `arm-measure.ts:235-239`, `:713-716` |
| Behavioural caveat at `0.3` on `perSession.busyMs / windowMs` | `render-report.ts:48`, `:123-128` |

The plan adopts the fifth as a detector in the risk bullet immediately above the sentence that
says no gate exists. Fix the sentence, and connect the third to D per K4.

### K6. Work item A's accept-seam instruction is transport-blind, and applying it to WS would invalidate the arm the acceptance promises to protect

Work item A says: *"Charge the accept seams as their counterparts are charged."* W3 supplies the
counterpart: `openUni` and `openBidi` "both open egress spans".

**`openUni`'s egress span is not `acceptUni`'s counterpart, and on WS the instruction is wrong.**
`WebSocketAdapter.acceptUni` (`ws.ts:1644-1653`) charges nothing, and that is *correct*: the
channel is constructed and pushed onto `uniAcceptQueue` at `ws.ts:1998-2001`, inside
`dispatchSocketMessage`, which runs inside `busy.measure("ingest", …)` at `:1865` — I confirmed
there is no method boundary between `:1870` and `:2010`. The accept work is already paid for.
Charging `acceptUni` on WS would double-count.

And it would move `perSession` on the WS bulk arm — the figure sealed at `26.3125` under
`c7fafa52`. The acceptance says *"the arm already sealed under `c7fafa52` is not invalidated"*.
As the work item is written, an implementer following it literally invalidates that arm. On WT
the accept seams (`:1242`, `:1566`) genuinely are uncharged and genuinely should be charged.

So the rule must be stated per adapter and by *provenance*, not by symmetry of name: **charge the
JS work that is not already inside another span.** Rewrite A accordingly, and say explicitly that
WS's accept seams stay uncharged and why.

Subject to that fix, and to work B touching only the `ws-worker` / `wt-stream-sink` arms
(`evidence.ts:246-252`) and not the plain `ws` arm, **the acceptance's non-invalidation clause is
correct** — I checked it directly. `perSession` on the sealed WS arm comes from an already
arrival-charged path, and its `serverAggregate 1/977` is a send-side server figure that a
read-path change does not touch.

### K7. Work item E is still name-keyed, so today's bug would pass it

E now has two tests and the second does make the first non-vacuous — that answers half of my r1
C7. The **keying** does not: E names *seams*. At HEAD there are **four** `read` implementations
(`wt.ts:417`, `:454`, `:1305`, `ws.ts:2146`) and **three** `acceptUni` implementations
(`wt.ts:1242`, `:1566`, `ws.ts:1644`), plus three forwarding wrappers on the production path,
all verified present:

```
tools/compare/adapters/ws-worker.ts:255-256
tools/compare/adapters/wt-stream-sink.ts:305-306
tools/compare/bin/compare-controller.ts:804-805
```

A row `read → ingest` satisfied by driving one of four is exactly today's bug, and it would pass
E after fixing `makeReceiveChannel` alone. Re-key E to **construction sites**, and make
`makeBidiChannel`'s `busy?: LoopBusyMeter` (`wt.ts:426-429`) **required** — an optional meter that
is present and unused is what produced W2 in the first place, and the compiler enforces for free
what a test otherwise has to chase.

---

## Two mechanics still missing, with their blast radius now bounded

**The `seam` flag.** `LoopBusyMeter.open(kind, seam = true)` (`transport.ts:206-218`) fires
`clock.noteBusySlice?.()` on entry. A read span opening with the default on an EOF read
(`chunk === null`) tells a deterministic clock a delivery happened when none did. It must pass
`seam = chunk !== null`, exactly as `:924` passes `envelope !== null`. The plan uses the word
"seam" eleven times, always for a code seam, never for the flag.

I can now bound this exactly, which neither r1 review could: there are only **four** priced-clock
sites in the tree — `loop-busy.test.ts:83`, `wt.test.ts:1086`, `:1133`, `:1181`, `ws.test.ts:1516`
— and all drive the datagram/message path. So omitting the flag breaks nothing *today*; it plants
a mis-pricing that fires the first time someone prices a read.

**The definition string.** `SESSION_LOOP_BUSY_MS_DEFINITION` (`transport.ts:131-136`) says
"the JavaScript event-loop time **this server** spent", while the attested `perSession` is the
consumer's loop. Work item F fixes the hand copy at `render-report.ts:233` and leaves the source,
so after F the constant and its copy **disagree** — strictly worse than today, where all three
copies agree and are wrong together. Schedule the constant; derive the legend from it. And F says
"and the frame documentation": `server-snapshot-protocol.ts:64-79` is **correct** — it describes a
server frame and says so. F as phrased points an implementer at correct prose.

## Corrections to my own r1

- **C1(b) overreached.** "There is no attested server `busyMs`" was true of the four artifacts I
  parsed and false of the `c7fafa52` arm I did not. The plan caught me. Fixed above.
- **C2's flood argument was wrong**, and the plan built work item A on it. K1.
- **My r1 said the exact-`65` assertions in `wt.test.ts` "should turn red". They should stay
  green.** I read them: `:1078-1121` and its two siblings drive `session.receiveMessage("datagram")`
  through the message path at `:924`, not stream reads. The Architect is right. The plan should
  carry the disposition both ways — which tests go red *and* which must stay green — because a
  change of this shape that turns nothing red has changed no measured behaviour, and one that
  turns the wrong thing red is a regression.

## Where the Architect is right and I confirm

A3 in full: W6 is diagnosed and no work item repairs it, while acceptance still reaches the
fanout relay. And his refinement of W5 is correct — I checked all twelve `timed()` call sites in
`server.ts` (`:604, 665, 673, 682, 690, 1010, 1013, 1042, 1092, 1105, 1108, 1119`) and every
closure is **synchronous**, so Phase B's producer does not charge suspension. W5's real defect is
the docstring anchor at `server.ts:1255-1256`, not the behaviour.

**On the over-reach question the task put to me: the plan is clean.** Work item C offering a
stated reason as an alternative to changing Phase B's producer is the right shape and, given the
twelve synchronous sites, the "state a reason" branch is very likely the correct one — the two
producers already mean the same thing. And the non-invalidation clause is correct, subject to K6.
The plan does not over-claim on the historical artifacts either: "must not be cited as busy
evidence" is the right disposition, and I confirmed the constant.

## What would make this APPROVED

1. Fix A's rationale (K1): drop the flood argument and state that the WT read charge is
   completeness rather than magnitude, or commit to a session-lifetime pump, price it, and state
   what it does to backpressure. Name the live `readChunk` branch per construction site.
2. Replace acceptance bullets 1 and 2 with a falsifiable completeness-plus-attribution bar that
   expects a small WT receive figure and names a large one as the failure signal (K2).
3. State the detector's resolution: it catches suspension-charging, it is blind to a 50 ms
   inflation (K3).
4. Re-aim D at silent loss, with the ordering rule between the last read charge and the close
   transfer pinned; drop the refusal framing (K4).
5. Correct the gate sentence and list the five constraints, monotonicity included (K5).
6. Rewrite A's accept-seam instruction by provenance, and say explicitly that WS's accept seams
   stay uncharged because `ws.ts:1998-2001` is already inside the `:1865` ingest span — which is
   also what keeps the acceptance's non-invalidation clause true (K6).
7. Re-key E to construction sites, make the meter parameter required, and enumerate the three
   forwarding wrappers (K7).
8. Schedule W6 or scope the acceptance off the fanout relay; sharpen C to the docstring anchor.
9. Schedule `SESSION_LOOP_BUSY_MS_DEFINITION`, derive the report legend from it, leave
   `server-snapshot-protocol.ts:64-79` alone, and add `seam = chunk !== null`.
10. Carry the full test disposition — red *and* green — including that the exact-`65` assertions
    stay green.
