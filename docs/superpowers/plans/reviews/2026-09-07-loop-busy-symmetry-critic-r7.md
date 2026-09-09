APPROVED

# Critic review (revision 7) — loop-busy honesty across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed by me, before reading) | `3a106fcd90e1886ba0b254c67b77e07f00793e9e0757cf1f95116746aff47b2a` |
| Declared SHA-256 | identical — verified first |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Working tree | `git status --porcelain` → untracked evidence and review files only; **0 tracked modifications**. Git read-only. Only this artifact written |
| Prior artifacts read | my r1–r6; Architect r7 |
| Method | every `file:line` the plan cites read at HEAD; `bun test tools/compare/` → **1749 pass / 0 fail / 0 skip** (303.85 s), so acceptance's "0 fail 0 skip" is a real bar; 449 sealed artifacts re-parsed off disk; and **three probes executed against production code**: the WS receive path on the real `WebSocketAdapter` against its own meter, the WT WHATWG read turn raw and under the honest discipline, and the honest-versus-await-spanning discipline against both a real clock and the house `pricedClock` |

**All four fixes are present and correct, and I confirmed each by execution rather than by
reading the plan's account of it.** The clause that decided r6 is gone from the body, not
merely contradicted; item C charges both halves of the symmetric pair; the census cell that
could not state the truth about three live seams no longer has an occupant it would falsify;
the scan roots now contain the site r5 refused over; W5 states no counts; `:1119` is right at
both sites.

**I re-measured the two quantities the fix turns on rather than inherit them.** On the real
adapter at the plan's own workload — 1600 × 64 KiB, 104,857,600 bytes — the WebSocket meter
delta tracks the arrival turn and contains none of the consumer turn, and the WebSocket
consumer turn is 2.5–3× the WebTransport twin. Charging only the WebTransport half would have
inverted the asymmetry, exactly as R7 says, and acceptance bullet 2 now makes that a red test
rather than a promise.

Eight items follow. **None of them changes a work item's direction, makes an acceptance bullet
unsatisfiable, or rests on a claim the plan needs and does not have.** Two of the eight are
corrections against myself. That is why this is an approval and not a seventh refusal.

---

## 1. The four fixes, checked

| Fix | Status | How I checked at HEAD |
| --- | --- | --- |
| **(1) Item C extended to both transports** | **Present and necessary.** C reads "Charge the whole consumer read turn on every read seam, both transports", names `ws.ts:2146`, `:1644`, `waitForQueue` and `readFromStream` alongside the two WT seams, and says charging only the WT half "would invert the asymmetry, since the WebSocket turn is the larger". I re-metered both turns (§3) and the ordering holds: **WS 7.47–8.78 ms against WT 2.53–3.19 ms**. Risks now owns **both** rises, which is what my r6 fix advice asked for and what bullet 6 already permitted | probes 1 and 2 |
| **(2) W6 rewritten; R6's clause withdrawn by name** | **Present.** `grep "charged in full"` over the plan returns nothing — the clause is absent from the body, and the revision history withdraws it by name. W6 now says `ws.ts:1865` "charges the arrival turn only" and puts the consumer turn at 7.65–7.99 ms per 1600 reads, charged nowhere. **Reproduced today**: meter delta 35.50 / 27.99 / 34.64 ms against an arrival turn of 35.88 / 28.35 / 34.99 ms — tracking to 1.0–1.3% — while the consumer turn ran 8.78 / 7.47 / 8.77 ms and none of it appears in the meter. The plan's own three deltas (31.82 / 35.81 / 37.36) are my r6 run verbatim | probe 1 |
| **(3) No fifth cell; cell three tightened** | **Correct disposal.** D's third cell now requires the named span to exist **"and is measured to charge that work"**, and states that after C no read seam uses it "because the span that was cited for them charges the arrival turn and not theirs" — which is precisely what my meter delta proves. My r6 K2 asked for a cell that could state the truth about `ws.ts:2146`, `ws.ts:1644` and WT `acceptUni`/`readFromStream`; C now charges all four, so the cell has no occupant to falsify. One residual, in item 2 below | plan text against the r6 measurement |
| **(4) Roots named; W5 stripped of counts; `:1119`** | **All three present.** D names `tools/compare/adapters/**` plus `bin/compare-controller.ts`, `ws-worker.ts`, `wt-stream-sink.ts`; `bin/compare-controller.ts:804` — the site r5 refused over — is inside the stated roots. W5 states no number at all. `grep 1120` over the plan returns nothing and both W1 and item A say `:1119`, which is the line the `timed()` span opens on | read at HEAD |

## 2. Every claim the brief named, checked at HEAD

| Claim | Result |
| --- | --- |
| WS charges channel-data ingest once in `onSocketMessage` (`ws.ts:1865`); `WsChannel.read` only dequeues | **True.** `this.busy.measure("ingest", () => this.dispatchSocketMessage(value))`; `read` (`:2146`) is `waitForQueue` + `result.reservation.release()`, no meter |
| WT charges nothing for stream reads — `makeReceiveChannel` (`:410`), `readChunk` (`:177`), sites `:1251` and `:1569` | **True.** `makeReceiveChannel(readable, clock)` takes no meter; both sites pass two arguments; `readChunk(readable, deadlineMs, clock)` has none |
| WT has exactly one ingest span (`:924`) | **True.** `grep '"ingest"'` over `tools/compare`, tests excluded, returns `ws.ts:1865`, `wt.ts:924` and the two `transport.ts` lines that define the kind |
| `acceptUni` has exactly one production caller (`client.ts:883`) | **True.** Every other non-test reference is an implementation or a decorator delegating to `base.acceptUni` (`bin/compare-controller.ts:804-805`, `ws-worker.ts:255-256`, `wt-stream-sink.ts:305-306`) |
| Fanout server ingests through `receiveMessage` (`server.ts:388-390`) | **False — and the plan does not claim it; the brief does.** That range is inside `echoSession`. The relay's inbound paths are `:1119` (WT) and `:670` (WS) |
| WS server ingests through its message callback (`:670`) | **True.** `:670-680` puts `handleInboundBytes` + `pump` inside `timed()` |
| Sealed artifact carries only server figures (`artifact-builder.ts:533-536`, `:787-799`) | **False — and the plan does not claim it; the brief does.** `:536-542` declares **both** `perSession` and `serverAggregate`; `:786-802` validates window finiteness on both |
| No gate constrains `busyMs` | **True of magnitude, false of structure — and the plan claims neither.** `arm-measure.ts:229-244` refuses a missing or non-finite `perSession` and a non-positive window; `artifact-builder.ts:786-802` refuses a degenerate window on both scopes; `server.ts:2529-2536` refuses a backwards loop; `render-report.ts:48` caveats at `0.3`. **A zero passes all five**, which is why the sealed WT zeros exist |
| W1: `frames.push` (`:1118`) and `relayFrameRoutingFields` (`:1126`) sit outside the span at `:1119` | **True**, read verbatim; `:1116`'s `await inbound.read()` is the idle wait and stays outside |
| W1 arithmetic: 1.66–1.83 µs/frame at 10,000/s | **Closes.** `scenario-registry.ts:256-263` is `ingressRatePerSecond: 10_000`, `publisherCount: 1`, `subscriberCount: 100`; 1.66–1.83 µs × 10⁴ = 16.6–18.3 ms/s = **0.996–1.098 s/min** |
| W2/W3: `sink-worker.ts:222-229` charges suspension; both arms replace `loopUtilization` wholesale; `ws-worker.ts:11-17` says there is no worker thread | **True on all three**, verbatim |
| W7: `render-report.ts:233` and `transport.ts:131-136` | **True.** `:233` is an independently hand-copied literal — and already divergent, since it carries a harness-work exclusion the exported constant does not |
| W8: `wt.ts:1655-1664` can drop a late charge; conservation and monotonicity hold | **True.** `onSessionClose` deletes from the live set **before** accumulating and no-ops on a repeat; `serverLoopUtilization` (`:1666-1678`) sums closed + live; `totalMs` only grows (`transport.ts:227`) |
| W9 and acceptance bullet 6's five sealed values | **True, re-parsed off disk.** `65 / 1250` appears on six sealed aggregates; `c7fafa52`'s carries `{busyMs: 1, windowMs: 977}`; the four WS arms are exactly 26.3125, 40.08154296875, 45.075439453125 and 54.9423828125, against WT `perSession.busyMs` exactly `0` over 2258.33 / 2447.59 ms windows |

**One thing I established this round that no earlier review had, and it strengthens the plan.**
`arm-measure.ts:224-229` says `perSession` is "the consumer side the driver is on", and **every**
sealed `bulk-one-way/physical` artifact carries `direction: "linux-to-mac"` — so the measured
session in those arms **receives**. That turns acceptance bullet 6's attribution from an
inference into a measurement: the WT zeros are zero because arrival happens in the addon and
the read caller turn is unmetered — the exact seam item C fixes. It also means the Risks
sentence describes arms already on disk: after C those artifacts' successors read roughly
48 and 63 ms on WS instead of 40.08 and 54.94, and 2–3 ms on WT instead of 0.

## 3. What I measured

Bun 1.3.14, macOS arm64, warmed, three runs each, 1600 × 64 KiB = 104,857,600 bytes.
Probe 1 drives the **real** `WebSocketAdapter` and `WsSession` through the repo's own fake
server runtime, interleaved so the reader never waits on the source, and reads the adapter's
own meter. Probe 2 transcribes `readChunk`'s WHATWG branch (`wt.ts:183-203`) verbatim against
a real `ReadableStream`, and also charges it with the **real** `LoopBusyMeter` under
`open`/`pause`/`resume`/`close`. Probe 3 exercises the two disciplines directly.

| Quantity, per 1600 × 64 KiB | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| WS arrival turn, inside `ws.ts:1865` | 35.88 | 28.35 | 34.99 ms |
| **WS `loopUtilization.busyMs` delta — what the adapter charges** | **35.50** | **27.99** | **34.64 ms** |
| WS consumer read turn (`read()` → value in hand) | 8.78 | 7.47 | 8.77 ms |
| …its synchronous prefix | 3.49 | 3.50 | 4.79 ms |
| WS `acceptUni`, whole call | 0.0094 | 0.0086 | 0.0080 ms |
| WT read caller turn, whole | 2.59 | 2.87 | 2.53 ms |
| **WT read caller turn, charged under the honest discipline** | **2.06** | **2.05** | **2.09 ms** |

| Discipline, 1600 spans | honest (`pause` before the `await`) | naive (span across the `await`) |
| --- | --- | --- |
| real clock, no injected wait | 48.45 ms | 2261.94 ms |
| real clock, ~1.6 s of real waiting injected | **33.47 ms** | **2256.44 ms** |
| house `pricedClock`, 50 spans, `ingestMs: 2` | **200 ms** | **100 ms** |

## 4. The brief's six attacks

**1. Is the blast radius real, or does something already attest a receive-side figure?**
**Real, and where it is not latent it is wrong.** Across 449 artifacts carrying a `perSession`
figure, the `bulk-one-way/physical` WT arms read exactly `0` over 2.2–3.8 s windows, and every
structural gate passes a zero. The one path that does attest a receive figure is `measureRead`
(`sink-worker.ts:222-229`), which charges suspension — so the sole producer of a receive-side
number produces a dishonest one. That is W2, and B removes it.

**2. Can charging `readChunk` over-charge a reader that waits?** **No — executed, not argued.**
With `pause` before the `await`, 1600 spans over roughly 1.6 s of real waiting charge
**33.47 ms**; the same spans with no wait charge 48.45 ms. The honest figure does not track the
wait at all (the difference between the two is run-to-run noise on the synchronous stand-in),
while the await-spanning shape charges 2256 ms and 2262 ms — essentially the whole suspension
in both. The reason is structural and holds for the real seams: two synchronous stretches
cannot interleave on one thread, so the meter's single `spanStartMs` and depth counter stay a
plain synchronous stack (`transport.ts:206-227`), which is the invariant its docstring claims.

**3. Can this break the child's monotonic reading, or live/closed conservation?** **No.**
`totalMs` only ever grows; `onSessionClose` transfers exactly once; `serverLoopUtilization`
sums closed + live; `server.ts:2529-2536` cannot fire from a change that only adds spans. The
residual hazard is **silent loss** of a charge landing after close — which is exactly what
item C creates more of, and which W8 states correctly. See item 7 below.

**4. Can the two transports be compared after the change?** **Yes, as the comparison the
definition actually defines, and the plan is right to refuse parity as an objective.** After C
a 100 MiB receive publishes roughly 36–48 ms on WS against 2–3 ms on WT, and that ~15× gap is
almost entirely *where the frame decode lives*: JavaScript on WS, the addon on WT. The
definition excludes native time by name, and the one-accumulator rule is what keeps the two
arms measuring the same thing. So the number stays comparable as JavaScript loop cost, which
is what the campaign ranks; what would make it meaningless is publishing it without saying so,
which is item F's job.

**5. Does this risk invalidating the sealed A5 arm?** **No.** Nothing re-seals; the sealed
files are unchanged on disk; the exposure is future runs, and bullet 6 plus Risks now own it
on **both** transports. I also went looking for a pinned expectation that C would turn red:
the suite's exact-value `busyMs` pins are 65, 57, 42 and 0, and every one of them is a
fake-clock arm driven through `receiveMessage` or a socket delivery — not through the read
seams C charges. C does not break them by construction. The adjacent hazard that could is
item 3 below.

**6. Can the surface table be satisfied vacuously?** **The two routes r6 found are closed; one
residual remains, and it is item 2.** The roots are named, so `bin/compare-controller.ts:804`
cannot fall outside the scan; and cell three now requires the named span to be *measured* to
charge the work, which is what made the WS pair's row false at r6.

---

## Items to carry into implementation — none blocking, in the order I would take them

**1. Acceptance bullet 4 carries the weak half of D's cell-three predicate.** D requires
"naming a span that actually exists **and is measured to charge that work**". Acceptance says
only "No row uses charged-at-another-seam without naming an existing span." The acceptance
bullet is the enforceable artifact, and the difference is the whole r6 refusal: `ws.ts:1865`
*exists*, which is why the false row would have validated. Cell three's likely occupants after
C are the delegating decorators at `ws-worker.ts`, `wt-stream-sink.ts` and
`bin/compare-controller.ts:804` — the same sites where B's suspension bug lived, so a row
saying "charged at the base seam" is worth exactly the measurement behind it. **Fix: copy D's
five words into the bullet.**

**2. `resume()` re-fires the deterministic seam, and item E's stated reason for excluding
`pricedClock` is false as written.** `resume` *is* `enter` (`transport.ts:220`), and `enter`
fires `noteBusySlice`/`noteEgressSlice` whenever depth goes 0→1 (`:213-219`). So a
paused-and-resumed span prices **two** slices, not one. Measured: 50 honest spans charge
200 ms on a `pricedClock` where 50 await-spanning spans charge 100 ms. E says "`pricedClock`
cannot discriminate"; it does discriminate — twofold, in the *opposite* direction to the real
clock, and for a reason with nothing to do with suspension. **E's instruction survives and is
better supported than its sentence**: a real wait never advances a fake clock, so `pricedClock`
still cannot see the thing the test exists to catch, and the only difference it shows is an
artifact of the seam. Restate the reason. And **item C should state the `seam` value it opens
with** — I raised this at r6 (S4) without the mechanism; with it, the risk is concrete: the
first implementer who meets a red fake-clock arm will reach for `seam: false` and quietly
change what the deterministic seam means. I searched for a currently-green frozen test that C
would turn red this way and **did not find one**; the priced-clock reads all arrive through
`receiveMessage` and socket delivery. **This error is mine**: my r6 said the two shapes are
"arithmetically identical" under `pricedClock`, and the plan took my word for the third time in
three rounds.

**3. The plan carries two bands for one quantity.** The revision history says the WT twin
"measures 2.77 to 3.76 ms"; the correction table says "the correct discipline, whole turn with
the await paused out | 5.76 to 8.27 ms at zero wait" — same seam, same workload, ~2.5× apart,
and a paused-out charge cannot exceed the raw turn it is taken from. I re-metered instead of
adjudicating on paper: **whole turn 2.53–2.87 ms, honest charge 2.05–2.09 ms.** That
corroborates the history band and refutes neither conclusion — R5's arrival body is still a
few per cent of the turn, and the WS turn is still the larger by 2.5–3×, which is the only
thing the sentence is for. **Fix: reconcile the two, or name the bench each came from.**
*I contradict the Architect here*: his N1 calls 2.77–3.76 "a warm prefix measurement compared
against the WS whole turn". It is not — it was a whole turn, measured exactly as the WS whole
turn beside it, and my independent re-run today lands on the same band while his own re-meter
(4.45–10.41) matches neither.

**4. `waitForQueue` has five callers, and C's charge cannot live inside it.**
`receiveMessage` (`:1560`), `acceptUni` (`:1645`), `acceptBidi` (`:1702`), `WsChannel.read`
(`:2154`) and `WsServer.acceptSession` (`:2425`). The last is on the server handle, which owns
no per-session meter, so the span belongs at the call sites with `waitForQueue`'s body inside
it. One clause in C. (The range the plan gives, `:471-510`, is off by one at both ends — 471 is
blank, the declaration is 472, the `finally` closes at 512. That range is mine, from r6.)

**5. A read seam no revision and no review has named: `wt.ts:1306`.** The inline `read` on the
`BidiChannel` that `acceptBidi` (`:1272`) builds by hand calls `readChunk` unmetered, while its
siblings `write` (`:1290`) and `end` (`:1303`) both take `busy`. D's required-meter change
cannot reach it — it is not a `makeReceiveChannel`/`makeBidiChannel` construction — but it sits
inside `tools/compare/adapters/**`, so the scan finds it, and after C no cell can hold it
except a charging one. The mechanism does force the charge; C's list should say it is
illustrative, so nobody reads "That means the two WebTransport seams and…" as closed. **I
confirm the Architect on this one.**

**6. The docstring's inbound sentence narrows after C, and F should take it.**
`transport.ts:96-100` defines inbound as "the time inside the handler that consumes bytes off
the wire", which is the arrival turn only; after C, ingest also holds the consumer's reader
acquisition, timer, race and release. **I part company with the Architect on where the defect
is**: he says the exported constant would "publish a sentence narrower than the number it
defines". It would not — `SESSION_LOOP_BUSY_MS_DEFINITION` (`:131-136`) qualifies *egress* and
leaves ingest unqualified, so it survives C intact. The prose above it does not. F already
opens that file; take the docstring with it.

**7. W8 still has no work item and no acceptance bullet, third round running.** Item C is what
creates late charges on the read path, and W8 is where the plan says a late charge can be
silently dropped. Couple them, or say why not.

**8. D's parenthetical mislocates two of its three decorator roots.** `ws-worker.ts` and
`wt-stream-sink.ts` live at `tools/compare/adapters/`, inside root one, not "outside it". Only
`bin/compare-controller.ts` is outside. Scope is unaffected and the K3 fix works.

---

## Where I correct myself

- My r6 assertion that the honest and await-spanning shapes are "arithmetically identical"
  under `pricedClock` is **wrong** (item 2). The plan adopted it, as it adopted my 18 µs at R5
  and my census count at R6. Three rounds, three inherited errors, all mine.
- The `waitForQueue` range `:471-510` is mine and is off by one at both ends (item 4).
- My r5 advice on the WS consumer turn — "charging it is not the fix" — was superseded by
  bullet 6 at r6 and is now correctly overtaken by R7's item C.

## Why this is an approval

The plan's load-bearing claims are all true at HEAD, and I checked them by driving the code
rather than reading it. Item C now applies one rule to both sides of the symmetric pair, and
acceptance bullet 2 makes a one-sided charge a red test instead of a promise. The census cell
that could hold a validated falsehood no longer has one to hold. The scan roots contain the
site r5 refused over. The ceiling is gone, replaced by a real-clock test whose separation I
measured at 33 ms against 2256 ms. The eight items above are text the implementer should carry;
not one of them changes what gets built, and two of them are corrections against me.
