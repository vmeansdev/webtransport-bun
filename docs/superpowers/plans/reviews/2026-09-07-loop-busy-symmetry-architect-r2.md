CHANGES REQUIRED

# Architect review (revision 2) — loop-busy symmetry across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `602af7b801e3b0b8fac5761e7f789261ad731bf665a92b35494b47b15bee7481` |
| Declared SHA-256 | identical — verified before reading the plan |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Prior artifacts read | `…-architect.md` (r1, `CHANGES REQUIRED`), `…-critic.md` (r1, `CHANGES REQUIRED`) |
| Method | every cited `file:line` read at HEAD; seven sealed A5 artifacts parsed off disk and their embedded evidence frames base64-decoded; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → 29 pass / 0 fail; one executed probe of the prescribed charge site |

Revision 2 is a large, honest improvement. Its central factual correction to the
Critic is **true**, and I verified it from the artifacts rather than accepting it.
Six of the r1 blocking findings are answered. But the plan's core prescription —
work item A — rests on a rationale that the code does not support, and the charge
it installs cannot produce the number its own acceptance demands. Three further r1
findings survive in weakened form. Six blocking items below.

---

## The correction to the Critic is confirmed, with evidence

The plan asserts (fact 2) that the historical `65 / 1250` is a fixture constant but
that today's sealed arm under `c7fafa52` carries a real `1 / 977`. **Both halves are
true.** I decoded the embedded evidence frames.

`…/8ada2d1b…/busyms-attested-focused-r1/reps/bulk-one-way_physical/ws/rep-1.sealed.json`,
field `attestationEvidence.serverObservationEvidence.snapshotFrameBase64`, decodes to a
`server-loop-utilization/v1` frame carrying `busyMs 65`, `finalBusyMs 65`,
`baselineBusyMs 0`, `windowMs 1250`, `childPid 4242`, `baselineAtLinuxNs "1000"`, and
its companion `rigMeasureStartAckBase64` carries `issuedAtMs 1700000000002`. That
constant is `cohort-fixture-signing.ts:194` (`const issuedAtMs = 1_700_000_000_000;`)
alongside `:196-198` (`spanMs ?? 1_250`, `busyMs ?? 65`). Fixture-minted, conclusively.

`…/c7fafa52…/…/ws/rep-1.sealed.json` decodes to a frame carrying `busyMs 1`,
`finalBusyMs 1`, `baselineBusyMs 0`, `windowMs 977`, `childPid 3788496`,
`baselineAtLinuxNs "243308876"`, `issuedAtMs 1788778476360`, a real `linuxClockId`,
and a `bulk-source-completion/v1` sub-frame with `bytesWritten 104857600`,
`chunksWritten 1600`. That is a real capture from a real child process.

So the Critic's C1(b) is **true of the historical artifacts and false of the current
one**, exactly as the plan states. `1 / 977` is also plausible on its face: under
pre-`60f4a59b` semantics the send path was uncharged, and this is a send-only server
arm, so a floor-at-the-read accumulator reporting 1 ms is the expected reading, not a
suspicious one. Fact 3's dating is also right — `c7fafa52` is an ancestor of
`60f4a59b` (`git merge-base --is-ancestor` → true), so the reading predates the
send-path charge.

One thing the plan should add while it is being precise: **there is no sealed WT arm
under `c7fafa52`** — the only `bulk-one-way/physical` sealed artifact under that
candidate is `ws`. Every WT arm on disk (`8ada2d1b`, `f9d0cd54`, `cc866b8b`) carries
the fixture `65/1250` server figure. That is *good news the plan does not claim*: the
WT arm has never sealed under real server attestation, so it will be measured under
the new semantics from the start and there is no WT incomparability to disclose at
all. Say it.

## Every other cited fact I checked, and the result

| Plan claim | Verified at HEAD |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`) | **True.** `this.busy.measure("ingest", () => { this.dispatchSocketMessage(value); })` |
| `WsChannel.read` (`ws.ts:2146`) only dequeues | **True.** `waitForQueue` + `reservation.release()`, no meter |
| WT charges nothing for stream reads: `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251`, `:1569` | **True.** `makeReceiveChannel(readable, clock)` — no meter parameter; both sites pass two arguments |
| WT has exactly one ingest span (`:924`) | **True.** 13 spans in `wt.ts`; `:924` `busy.open("ingest", envelope !== null)` is the only one; the other twelve are `"egress"`. `ws.ts` likewise has exactly one (`:1865`) |
| `acceptUni` has exactly one production caller (`client.ts:883`) | **True** as a *consumer*; `client.ts:883` `const channel = await input.session.acceptUni(acceptDeadline)`, read loop at `:891`. It is still reached through the forwarding layers — see A4 |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) is *echoSession*, not the relay (`W6`) | **True.** `echoSession` opens at `:379`; the relays are `:631`, `:946`, `:1191` |
| `:670` metered by a local `timed()` into `onRelayWork`, no-op when unset; `startBinaryMessageServer` (`ws.ts:3095`) holds no meter | **True.** `timed` at `:642-650` returns `work()` unchanged when `options.onRelayWork === undefined` |
| Fanout WT ingest (`server.ts:1102`, `:1116`) reads raw readers unmetered | **True**, and worse: `frames.push(chunk.value)` — the length-prefixed reassembly — is *outside* the `timed()` at `:1119` |
| Sealed artifact fields (`artifact-builder.ts:533-536`, `:787-799`) | **True**, and r1's false "only server figures" claim is correctly gone. `:536-541` declares both `perSession` and `serverAggregate`; `:786-800` validates **`windowMs`** finiteness only |
| `evidence.ts:238-252` defines four arms, two read-path | **True** (`ARM_WIRE` `:238`, `ARM_READ_PATH` `:246`) |
| `ws-worker.ts:296-302` overwrites `loopUtilization`; `sink-worker.ts:227` `measureRead` wraps an `await` | **True**, verbatim |
| `read-path-adapters.test.ts:291` pins it | **True** — `"snapshot publishes the reader's loop, not the base session's"` |
| `createCohortServerLoopObserver` (`server.ts:1277`), docstring anchored to `sink-worker.ts:227` | **True** (docstring `:1255-1256`) — but see A3 note |
| `wt.ts:1655-1664` freezes `busyMs` at close | **True.** `onSessionClose` at `:1655`; the once-only transfer is fed by `onSessionClose?.(session, sessionLoopUtilization().busyMs)` at the server session's `close` |
| `render-report.ts:233` calls both figures the server's | **True**, verbatim |
| Baseline `29 pass / 0 fail` | Reproduced |

Two citation slips, non-blocking but fix them: `makeBidiChannel.read` is at **`:454`**,
not `:455`; and W3 says "`acceptUni` **and `acceptBidi`** charge nothing on either
construction site (`wt.ts:1242`, `:1566`)" — both cited lines are `acceptUni`. The
`acceptBidi` sites are `:1272` and `:1587`. The substance is right (neither accept
seam opens a span while `openUni` `:1228`/`:1552` and `openBidi` `:1258`/`:1573` each
do), but a reader following the citation lands on the wrong seam.

---

## Blocking findings

### A1. Work item A's stated reason is false, and the charge it installs is ~0.7 ms

This is the one that matters. W1 rejects the r1 placement with this argument:

> Charging `readChunk` instead, as revision 1 said, charges the pull, so a WT session
> whose peer floods an unread stream would charge zero where WS charges full decode.
> The charge point must be the arrival callbacks.

**The arrival callbacks are themselves pull-gated.** `readChunk` attaches its
listeners *inside the promise executor, per call*, and tears them down in `cleanup()`:

```
readable.once?.("data", onData);      // wt.ts:235-237
readable.once?.("end", onEnd);
readable.once?.("error", onError);
```

and the WHATWG branch calls `readable.getReader()` on entry (`:182`) and
`reader.releaseLock()` in its `finally` (`:203`). With no `read()` outstanding there
is no `onData`, no `.then` continuation, and no reader — so a WT session whose peer
floods an unread stream charges **zero at the arrival callbacks too**. The property
the plan moves the charge point to obtain is not obtained by moving it. The genuine
analogue of WS's `onSocketMessage` is a session-lifetime pump on the readable that
charges on arrival regardless of consumer demand; that is an architectural change to
`makeReceiveChannel`, and the plan neither describes it nor prices it.

Second, and worse for the objective: **there is almost nothing in those callbacks to
charge.** The whole `onData` body is `cleanup()` plus
`chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)` — and `Buffer` *is* a
`Uint8Array`, so the branch is true and no copy happens. The WHATWG continuation is
`res.done ? null : (res.value ?? null)`. I measured the body (executed probe,
1600 iterations, `bun`, this machine):

```
charged-inside-onData ms for 1600 chunks: 0.719
Buffer instanceof Uint8Array: true
```

Roughly half of that 0.719 ms is the meter's own two `clock.nowMs()` reads per span.
The honest WT bulk-read charge is on the order of **1 ms against WS's sealed
45–55 ms** — the charge is the same order as its own instrumentation overhead.

I state the probe's limit: it uses an `EventEmitter` stand-in, not the production WT
readable, so it prices the callback *body* the plan names, not whatever Bun's native
stream does before dispatching. That is the right thing to price, because the plan's
charge site is that body — and it is also the whole point: the per-byte framing work
on the WT read path happens below the JS boundary, which
`SESSION_LOOP_BUSY_MS_DEFINITION` explicitly excludes ("native, kernel and
other-thread time are excluded"). WT's stream reads legitimately have no JS ingest
work to charge. The WT *message* path is the counter-example that proves the rule:
`makeMessageStreamReceiver` (`wt.ts:751`) does real JS reassembly — `takeEnvelope`
slices, `grown.set(...)` copies the accumulated buffer — and that path *is* charged,
at `:924`.

What the plan must do: say which branch the production bulk readable actually takes
(`acceptNextUni` at `:1410` is typed `Readable`; `wrapServerSession`'s `:1251` casts a
WHATWG stream *to* `Readable`, so the two sites may take different branches), so the
implementer can prove the metered branch is the live one rather than metering a dead
one — this repo has a named gotcha for exactly that failure. And it must either
commit to the pump (and price it) or drop the flood argument and state plainly that
the WT read charge is completeness, not magnitude.

### A2. The acceptance is unreachable by honest charging, and bullet 2 manufactures over-charge pressure

Acceptance bullet 1: *"WS and WT report figures of the same order … on both the client
leg and the server."* Acceptance bullet 2: *"A receive-only arm reports positive,
work-tracking time on both transports."*

Given A1, honest charging yields WS ≈ 50 ms and WT ≈ 1 ms on the same 100 MiB
receive-only leg — a ~50× gap, not the same order. Bullet 1 fails. Bullet 2 fails on
"work-tracking": ~1 ms of listener plumbing does not track 100 MiB, and it does not
scale with bytes, it scales with `read()` call count.

That combination is precisely the over-charge trap the plan's own first risk names.
An implementer facing a red acceptance and a green risk register will widen the span
until the number looks like work — and the only way to reach tens of milliseconds on
WT is to charge suspension, which is exactly W4's defect re-created on the seam the
plan just fixed. **The acceptance criterion is pushing toward the failure the risk
section warns about.** The 0.3 detector will not catch it either: the sealed WS arm
sits at 0.0576, and a WT arm inflated from 1 ms to 50 ms over a 2258 ms window is
0.022 — still nowhere near 0.3. The detector is real but it is not a guard for this
magnitude of error; the plan over-credits it.

Bullet 1 is also not falsifiable as written. "Same order" is a bar, but "with any
residual gap explained by a measured component rather than asserted" reopens it: an
implementer who measures a 50× gap and names `decodeWebSocketFrame` has satisfied the
clause while violating "same order". The two halves of the bullet cannot both bind.

The framing I recommended in r1 and still recommend: **completeness plus attribution,
with convergence explicitly disclaimed.** Pre-state, before running:

- every seam classified ingest/egress charges, proven per construction site;
- an idle reader charges nothing (hold a stream open with no data);
- WT's receive charge is expected to be **one to two orders of magnitude below WS's**
  because WS frames in JavaScript and WT frames in QUIC, and *a WT receive figure in
  the same order as WS's is a failure signal, not a success signal*;
- the residual is attributed to named measured components, as `60f4a59b` did on the
  send side.

Written that way the criterion is falsifiable in the direction that actually matters
here, which is *upward*.

### A3. W6 is diagnosed and then unscheduled — no work item repairs it

W6 correctly demolishes r1's fanout claim: `echoSession` is Phase A, `:670`'s `timed()`
is a no-op when `onRelayWork` is unset, `startBinaryMessageServer` holds no meter, and
`server.ts:1102`/`:1116` read raw readers unmetered (with `frames.push` reassembly
outside the `timed()` span at `:1119`, so the one genuinely costly JS step on that
path is unmetered even when the observer *is* wired).

Now map W1–W8 onto A–F: A covers the adapters, B covers `sink-worker`/`ws-worker`/
`wt-stream-sink`, C covers the Phase-B *producer*, D covers close, E covers the table,
F covers labels. **Nothing covers W6.** Yet acceptance bullet 1 says "on both the
client leg **and the server**" and the last bullet demands real-process evidence "on
both transports and both directions" — which reaches the fanout relay, whose ingest
the plan has just shown is unmetered and which no work item touches. Either schedule
it or scope the acceptance off it; do not diagnose a defect in the "what is wrong"
list and leave the work list silent about it.

While there: **W5's diagnosis is weaker than it reads, and C should say so.** I
checked every `timed()` call site in `server.ts` (`:604, 665, 673, 682, 690, 1010,
1013, 1042, 1092, 1105, 1108, 1119`) — all twelve take **synchronous** closures.
Phase B's producer therefore does *not* charge suspension; behaviourally it is
`LoopBusyMeter`'s discipline, not `measureRead`'s. What is wrong is the **docstring
anchor** at `server.ts:1255-1256` citing `adapters/sink-worker.ts:227`. So C's real
work is small and specific: once B lands, the anchor becomes accurate and should be
re-pointed at `SESSION_LOOP_BUSY_MS_DEFINITION`; the producer split can stay with a
stated reason. Presenting "bring it onto the shared meter" as the primary option
invites a large refactor for no semantic change.

### A4. Work item E is still name-keyed, so a third instance can still arrive unmetered

E now has two tests, which answers the vacuity half of r1's finding — the second test
does make the first non-vacuous. But the **keying** is unchanged: *"a table naming
every seam of the `Session` and channel surface"*, and *"drives each seam classified as
ingest or egress and fails if that seam charges nothing."* Seams are named. There are
**four** `read` implementations (`wt.ts:417`, `:454`, `:1305`, `ws.ts:2146`) and
**two** `acceptUni` implementations (`wt.ts:1242`, `:1566`). A row `read → ingest`
with a driver that exercises one of the four is satisfied while three stay unmetered
— which is today's bug exactly, and it would pass this suite after fixing
`makeReceiveChannel` alone. The plan's own W2 proves the point and E does not act on
it.

The enforcement must bind **per construction site**, and two structural pieces go
with it that the plan does not schedule:

- **Remove the optionality.** `makeBidiChannel(duplex, clock, busy?: LoopBusyMeter)`
  (`wt.ts:426-429`) is what let W2 happen: the meter is present and unused. Work A
  says "give `makeReceiveChannel` a meter and pass it at both construction sites" —
  which fixes the two sites that exist and leaves the third site a future author adds
  free to pass nothing. Make the parameter required, and the compiler enforces what a
  test otherwise has to chase.
- **Enumerate the wrapper layers.** A seam can arrive unmetered by being *decorated*,
  not only by being added. `ws-worker.ts:255-256`, `wt-stream-sink.ts:305-306`, and
  the forwarding wrapper at `bin/compare-controller.ts:804-805` (verified present at
  HEAD: `acceptUni: (deadlineMs) => base.acceptUni(deadlineMs)`) all sit on the
  production path between `client.ts:883` and the adapter. B brings the first two into
  scope for the suspension fix; none of the three is named in E's enumeration.

### A5. The definition itself is not scheduled, and F as written makes the duplication worse

The plan never mentions `transport.ts` or `SESSION_LOOP_BUSY_MS_DEFINITION` — I
grepped it. The constant reads (`transport.ts:131-136`):

> "busyMs is the JavaScript event-loop time **this server** spent on this session's
> transport work…"

The plan's own W8 says the report mislabels both scopes because one of them is the
client's. The exported constant has the same defect, and `render-report.ts:233` is a
**hand copy** of it, not a derivation. Work item F fixes the copy and leaves the
source. After F the constant and its copy *disagree*, which is strictly worse than
today, where all three copies (`transport.ts:131`, `render-report.ts:233`,
`server-snapshot-protocol.ts:64-79`) agree and are wrong together. Schedule the
constant: make it role-neutral ("the loop time this session's process spent…"), carry
the role as a labelled property of each attested figure, and make the report legend
*derive* from the exported constant so the third copy cannot drift again.

F also says "Fix `render-report.ts:233` **and the frame documentation**". The frame
documentation is `server-snapshot-protocol.ts:64-79`, and I read it: it is **correct**
— it describes a server frame and says so ("the JavaScript event-loop time the server
child spent"). The Critic explicitly warned against editing it. As phrased, F points an
implementer at correct prose. Name what is actually wrong.

**And the mechanic both r1 reviews required is still absent: the `seam` flag.**
`LoopBusyMeter.open(kind, seam = true)` (`transport.ts:206`) fires
`clock.noteBusySlice?.()` on entry, and the loop-busy suite prices a fake clock
through it — `wt.test.ts:1078-1121` advances `now += 65` inside `noteBusySlice`. A
read span that opens with the default `seam = true` on an EOF read (`chunk === null`)
tells a deterministic clock that a delivery happened when none did, mirroring nothing
and mis-pricing every EOF. The read span must pass `seam = chunk !== null`, exactly as
`:924` passes `envelope !== null`. The plan uses the word "seam" eleven times, always
to mean a code seam, never the flag. Add it.

### A6. "No gate constrains busyMs today" is still false

Last risk bullet, verbatim: *"No gate constrains `busyMs` today, so nothing breaks on
landing."* Four constraints exist at HEAD; I re-verified each:

| Constraint | Location |
| --- | --- |
| Conservation `busyMs == finalBusyMs − baselineBusyMs`, else `BindingMismatch("busyMs")` | `crates/native/src/secure_fs.rs:17790-17799` |
| The same conservation on decode | `tools/compare/server-snapshot-protocol.ts:176-179` |
| `busyMs` finite (leg) / finite and non-negative (server) | `arm-measure.ts:235-239`, `:713-716` |
| Behavioural threshold at 0.3 on `perSession.busyMs / windowMs` | `render-report.ts:48`, `:123-128`, `:150` |

The plan adopts the fourth as a detector — good, and the Critic's C6 correction (the
integer refusal binds the rig frame, not the fractional leg figure) is right, so no
rounding blanket is needed. But the flat sentence is false, and the first two are
**directly load-bearing for work item D**. D says "make close-time freezing safe
against a late arrival" without naming the consequence: a charge that lands after
`finalBusyMs` is read does not merely get lost, it makes `busyMs` and
`finalBusyMs − baselineBusyMs` disagree, and the frame is then **refused** at
`secure_fs.rs:17799` and at `server-snapshot-protocol.ts:177`. That turns D from a
tidiness item into a run-killer, and it is the strongest argument for D that the plan
does not make. State the ordering rule (last read charge strictly before the close
transfer, and the close transfer strictly before the final read), and pin it.

---

## Is the objective the right one?

The objective sentence is now right and is a genuine improvement on r1: *"One
definition of loop-busy time, charged at the same semantic point, on every seam of both
adapters, in both directions, for every arm that reports the figure."* That is
completeness, and completeness is the real defect.

The **title** and the **acceptance** did not follow it. The title still says
"symmetry"; acceptance bullet 1 still demands convergence. Under a definition that
excludes everything below the JS boundary, WS and WT *are not symmetric on the receive
side and should not be made to look symmetric* — WS decodes every inbound frame in
JavaScript, WT does not. Rename the plan to match its own objective, and make the
acceptance say what a correct outcome looks like *including the case where the WT
figure stays small*, because that is the likely outcome and the plan currently has no
place to put it.

There is a better framing available and the plan is one sentence from it. `busyMs` is
not a cost metric; it is **a measure of how much of each transport's work lives in
JavaScript**. Read that way, WS ≈ 50 ms / WT ≈ 1 ms on a receive leg is not a gap to
close, it is the campaign's finding: the WT adapter pushes its framing below the loop
and the WS adapter cannot. That is a stronger result than parity, and it is only
defensible once every seam is charged — which is what this plan builds. Say that
out loud in the objective, and the acceptance writes itself.

## Is the definition still right once the read path is charged?

No, on one axis, and it is the axis the plan leaves alone (A5): the role is baked into
the prose ("this server") while the attested `perSession` is the consumer's loop, and
charging client reads makes that mismatch larger, not smaller. On the substance the
definition holds up well: "loop time, not process CPU, native and other-thread
excluded" is exactly what makes the small WT receive figure *correct* rather than
missing, and nothing in the plan contradicts it — provided A2 is fixed, because
acceptance bullet 1 as written contradicts it directly by demanding a figure the
definition forbids.

## On over-reach — checked, and the plan is clean here

- **Work item C offering a stated reason as an alternative to changing Phase B's
  producer is right**, and given my finding that all twelve `timed()` sites are
  synchronous, the "state a reason" branch is very likely the correct one. Keep the
  option. Sharpen it per A3.
- **The acceptance's "the arm already sealed under `c7fafa52` is not invalidated" is
  correct.** That arm is WS, WS is already arrival-charged at `ws.ts:1865`, and work A
  touches the WT read path. Its `26.3125 / 962.176` and `1 / 977` stand. Add the
  stronger fact from the artifacts (no WT arm ever sealed under a real server figure)
  and the disposition question closes entirely.
- The plan does not over-claim on the historical artifacts: "must not be cited as busy
  evidence" is exactly the right disposition and I confirmed the constant.

## Things the plan should say and does not

1. **Which branch of `readChunk` production takes** (Node `Readable` vs WHATWG), per
   construction site, so the metered branch is provably the live one (A1).
2. **The expected magnitude of the WT receive charge, pre-stated**, and the statement
   that a large WT figure is a failure signal (A2).
3. **The `seam = chunk !== null` flag** on every read span (A5).
4. **Test disposition beyond one line.** The plan names only
   `read-path-adapters.test.ts:291`. For the record, and the plan should carry it: the
   exact-`65` assertions in `wt.test.ts` (`:1119, :1121, :1166, :1169, :1213, :1216`)
   drive the **datagram/message** path through `receiveMessage`, not stream reads, so
   they should stay **green** — the Critic listed them as tests that "should turn red"
   and that is wrong. Saying which stay green is as load-bearing as saying which go
   red, because a change of this shape that turns nothing red has not changed a
   measured behaviour, and a change that turns the *wrong* thing red is a regression.
5. **What `windowMs` means once two producers can populate one field.**
   `ws-worker.ts:301` computes it from `sessionOpenedAtMs`; `LoopBusyMeter` computes it
   from meter construction. Work item B changes the numerator on those two arms and
   says nothing about the denominator, and the 0.3 detector divides one by the other.

---

## What would make this APPROVED

1. Fix work item A's rationale: drop the flood argument or commit to a session-lifetime
   pump and price it; name the live branch per construction site (A1).
2. Replace acceptance bullets 1 and 2 with a pre-stated, falsifiable
   completeness-plus-attribution bar that explicitly permits — and expects — a small WT
   receive figure, and names a large one as the failure signal (A2).
3. Schedule W6, or scope the acceptance off the fanout relay; sharpen C to the
   docstring anchor given that all twelve `timed()` sites are synchronous (A3).
4. Re-key work item E to construction sites, make the meter parameter required, and
   extend the enumeration over `ws-worker.ts:255`, `wt-stream-sink.ts:305` and
   `bin/compare-controller.ts:804` (A4).
5. Schedule `SESSION_LOOP_BUSY_MS_DEFINITION` to become role-neutral, derive the report
   legend from it, leave `server-snapshot-protocol.ts:64-79` alone, and add the `seam`
   flag (A5).
6. Correct the gate claim, and connect work item D to the conservation refusal that
   makes it urgent (A6).
