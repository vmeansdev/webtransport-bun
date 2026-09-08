# Loop-busy honesty across transports and directions

**Status:** DRAFT pending approving review. Revision 7.

## Revision history

R1 called the client figure a server figure. R2 demanded parity, which measurement showed
unreachable without charging suspension. R3 reframed correctly but used the reframing as a
scope boundary. R4 restored what it dropped and asserted two things measurement refuted.
R5 fixed those and was refused on four blockers, one decisive. R6 discharged all four and
was refused on one new ground, measured: its justifying clause was false. Every number
below is a reviewer's, re-verified.

**R6's false clause, withdrawn.** R6 said the caller turn item C charges is "charged in
full on the WebSocket side inside `ws.ts:1865`". It is not. Driven through the real
adapter at 1600 by 64 KiB, the meter's own deltas of 31.82, 35.81 and 37.36 ms track the
**arrival** turn to within 1.1 per cent and contain **none** of the 7.65 to 7.99 ms
consumer read turn through `WsChannel.read` (`ws.ts:2146`) and `waitForQueue`
(`:471-510`). The WebTransport twin of that same turn measures 2.77 to 3.76 ms. So the
uncharged WebSocket turn is the larger of the two, by two to three times, and R6 executed
as written would have inverted the asymmetry instead of closing it.

## The correction that reshapes the plan

**R5 charged about three per cent of the WebTransport read path, and its ceiling was
inverted.** Decomposed and metered at the plan's own workload, 1600 by 64 KiB:

| part | cost |
|---|---|
| the arrival body R5 charged | 0.06 to 0.22 ms |
| the caller turn R5 left uncharged: `getReader`, `setTimeout`, `Promise.race`, `clearTimeout`, `releaseLock` | 5.2 to 6.9 ms |
| the correct discipline, whole turn with the await paused out | 5.76 to 8.27 ms at zero wait |
| the same discipline against 1,600 ms of real waiting | 48.9 ms |
| a naive span straight across the await | 3.09 ms at this workload |

Every part of the caller turn is synchronous loop time and in scope by the published
definition. Its WebSocket counterpart is **also uncharged**, and larger: see W6. The discipline
that charges it correctly already exists and is already documented: `transport.ts:117-118`
and `:195-199` describe pausing a span before every `await`, and `LoopBusySpan` exports
`pause` and `resume` for exactly this.

So R5's 5 ms ceiling **failed the honest charge and passed the dishonest one**. A fixed
ceiling is the wrong instrument, and on the house-style `pricedClock`
(`loop-busy.test.ts:64-96`) the honest and dishonest shapes charge identically, so it
cannot discriminate at all.

## Two numbers corrected

- **The relay correction is about 1.0 to 1.1 seconds of loop time per minute**, not
  "up to 10.8". Both reviewers priced the two uncharged bodies at 995 to 1,098 ms per 600k
  frames, that is 1.66 to 1.83 µs per frame, and at the confirmed 10k per second inbound
  rate (`scenario-registry.ts:256-263`) that is roughly 17 ms per second.
- **The 18 µs citation is withdrawn.** `server.ts:812-822` attributes 18 µs per frame to
  `codec.decode`, the design that docstring exists to reject; the replacement it chose
  measures 1.10 to 1.31 µs per frame, matching the docstring's own neighbouring 1.1 µs.
  Citing it inflated the headline roughly tenfold.

## Objective

One charging rule at every seam and every producer, never charging suspension; a
classification derived from the code rather than hand-maintained; labels that stop the
figure being misread. Parity between transports is explicitly not an objective.

## What is wrong, verified

- **W1.** The relay drops its own reassembly and routing decode: `server.ts:1118` and
  `:1126` sit outside the `timed()` span opened at `:1119`, while `onRelayWork` is wired at
  `:3036` into the Phase B accumulator and forwarded at `:1203`. Size: about 1.0 to 1.1 s
  per minute. The delivery-side call at `:1027` **is** charged, so there is no larger
  sibling site.
- **W2.** `sink-worker.ts:227` `measureRead` charges suspension, and feeds two arms:
  `ws-worker.ts:298-302` and `wt-stream-sink.ts:345-348`, both of which replace
  `loopUtilization` wholesale from `worker.stats()`.
- **W3.** Removing it without restoring the base meter leaves an arm reporting zero.
  `ws-worker.ts:11-17` confirms there is no worker thread, so the base meter is the right
  replacement.
- **W4.** Neither WebTransport read seam charges its caller turn. Both branches have an
  arrival point, Node at `wt.ts:1569`, WHATWG at `:1251` through `:194-198`, but the
  expensive part is the turn around them, not the body.
- **W5.** The seam census cannot be hand-maintained. Every count this plan has stated has
  been wrong, including the one handed to it by a reviewer, and no count matches a scope
  the plan can define. No number appears here or in acceptance; the list is produced by a
  scan. A hand list is the same class of defect this plan exists to remove, installed as
  its cure.
- **W6.** The consumer read turn is uncharged on **both** transports. `ws.ts:1865` charges
  the arrival turn only: frame decode, channel construction (`:1988-1996`) and `tryPush`
  (`:1999-2002`). The consumer turn through `WsChannel.read` (`ws.ts:2146`),
  `WebSocketAdapter.acceptUni` (`:1644`) and `waitForQueue` (`:471-510`) costs 7.65 to
  7.99 ms per 1600 reads and is charged nowhere. `readFromStream` (`wt.ts:467-493`) is the
  same shape at 0.007 to 0.010 ms per accept.
- **W7.** `render-report.ts:233` mislabels both scopes; `transport.ts:131-136` must move
  with it.
- **W8.** `wt.ts:1655-1664` can silently drop a late charge; conservation and monotonicity
  cannot break.
- **W9.** Historical artifacts carry the fixture constant `65 / 1250`; today's `c7fafa52`
  arm carries a real `1 / 977`.

## Work

**A. Charge the relay's own decode.** Bring `frames.push` (`server.ts:1118`) and
`relayFrameRoutingFields` (`:1126`) inside the `timed()` span at `:1119`. Report the
correction as about 1.0 to 1.1 s per minute, citing the measured 1.66 to 1.83 µs per frame.
Do not cite the 18 µs figure.

**B. Replace the suspension charge in both arms.** Remove `measureRead`'s await wrapping and
restore the base session meter in both `ws-worker.ts:298-302` and
`wt-stream-sink.ts:345-348`. Rewrite `read-path-adapters.test.ts:291`, keep the old
expectation as an explicit negative, and add a test that fails if either arm reports zero
for a completed transfer.

**C. Charge the whole consumer read turn on every read seam, both transports**, using the
existing `open`, `pause`, `resume`, `close` discipline, so the reader charges the reader
acquisition, timer setup and teardown, the race and the release, and charges nothing while
suspended. That means the two WebTransport seams **and** the WebSocket seams `ws.ts:2146`,
`:1644` and `waitForQueue` (`:471-510`), and `readFromStream` (`wt.ts:467-493`). Charging
only the WebTransport half would invert the asymmetry, since the WebSocket turn is the
larger. Fix the misdeclaration at `wt.ts:94` and the cast at `:1251`.

**D. Derive the census, do not write it.** The scan roots are stated: `tools/compare/adapters/**`
plus the production decorators that wrap a session outside it, `bin/compare-controller.ts`,
`ws-worker.ts` and `wt-stream-sink.ts`. A scan over those roots produces the seam list; the table supplies each seam's cell and the test fails when a scanned seam has no row.
Four cells: ingest, egress, charged-at-another-seam naming a span that actually exists **and
is measured to charge that work**, and not-transport-work with a reason. After C, no read
seam uses the third cell, because the span that was cited for them charges the arrival turn
and not theirs. `makeReceiveChannel` and `makeBidiChannel` take the meter
as a required parameter so a future construction site cannot omit it silently. No count
appears in the plan or in acceptance.

**E. Replace the ceiling with a discriminating test.** Against a real clock, at 1600 by
64 KiB with a controlled wait injected, assert that the honest discipline and a span across
the await produce materially different charges, and that the honest one charges nothing for
injected waiting. State that `pricedClock` must not be used for this test, and why: it does
separate the two shapes, but only because `resume()` is `enter()` and so
re-fires the deterministic seam -- 50 honest spans charge 200 ms where 50
naive spans charge 100 ms -- which is an artifact of the seam, in the
opposite direction to a real clock, and has nothing to do with suspension. A
fake clock never advances during a real wait, so the one thing this test
exists to catch is the one thing it cannot see. Keep the idle-reader test.

**F. Labels and definition together.** Fix `render-report.ts:233` and `transport.ts:131-136`
in one change. Leave `server-snapshot-protocol.ts:60-79` alone. State what the figure
excludes and that the historical `65 / 1250` artifacts are fixture-bearing.

## Acceptance

- The relay charges both bodies; a test drives the fanout ingest and fails if either is
  outside the span. The report states the correction's measured size.
- Every read seam charges its consumer turn on both transports, and a test measures the
  WebSocket and WebTransport turns so a change that charges only one side fails.
- Neither sink arm reports zero for a completed transfer; no arm charges suspension.
- Every seam the scan finds has a row; deleting a row or changing whether a seam charges
  turns a named test red. No row uses charged-at-another-seam without naming an existing
  span. No numeric census appears.
- The discriminating test passes: honest and await-spanning shapes differ materially, and
  injected waiting is not charged.
- No parity requirement, and no pinning of a low figure as correct.
- **Changed charges are allowed where a seam was mischarged, including seams that produced
  sealed figures.** The sealed WebTransport zeros came from the very seam item C fixes, so
  future runs will report differently; nothing is resealed and the change is reported.
  Reproducing a specific sealed value is not a criterion: four sealed WebSocket arms read
  26.3125, 40.0815, 45.0754 and 54.9424.
- Full gate: `bun test tools/compare/` 0 fail 0 skip, `tsc` 0, `check-official-io` exit 0,
  `cargo test --workspace` 0 fail, clippy gate, fmt, fixture hashes CLEAN, chat-1k
  acceptance passes with readings reported.
- Real-process evidence on both transports and both directions, plus a fanout-shaped
  measurement showing the relay's charge before and after.

## Risks

- Both published figures will rise: the WebTransport read from about zero to single-digit
  milliseconds per 100 MiB, and the WebSocket figure by the 7.65 to 7.99 ms consumer turn
  it has never charged. Both are corrections, not regressions, and both must be reported
  with their measured size.
- A naive span across the await charges less than the honest one at zero wait and far more
  under real waiting. Only the discriminating test separates them; a fixed threshold does
  not.
- Charging the relay changes the campaign's headline Phase B figure by about a second per
  minute.
