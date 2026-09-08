CHANGES REQUIRED

# Critic review — loop-busy symmetry across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `887d31d077b7173aeab2e394969bb18c82e10ca4336ede8d2b26737584e2b3b3` |
| Declared SHA-256 | identical — verified before reading the plan |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Architect artifact read | `docs/superpowers/plans/reviews/2026-09-07-loop-busy-symmetry-architect.md` (verdict `CHANGES REQUIRED`) |
| Method | every cited `file:line` read at HEAD; sealed A5 artifacts on disk parsed; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → 29 pass / 0 fail (reproduces the architect's baseline) |

I set out to refute the plan. The defect it names is real, but every one of the three
factual bullets in its "What is affected today, and what is not" section is false, and
the sealed evidence on disk contradicts its central conclusion with numbers. The plan
also contradicts itself: it states the goal as charging "at the same semantic point WS
charges" and then prescribes a charge at a point that is structurally not that. Eight
findings; C1, C2 and C4 are the ones that cannot be patched by wording.

I confirm the architect's B1–B6 independently and correct two of them (C6, C9).

---

## Confirmed by execution (both what the plan gets right and what the architect found)

- `ws.ts:1865` is `this.busy.measure("ingest", () => this.dispatchSocketMessage(value))`;
  `WsChannel.read` (`ws.ts:2146`) only `waitForQueue` + `reservation.release()`, unmetered. True.
- `makeReceiveChannel` (`wt.ts:410`) takes `(readable, clock)` only; its `read` (`:418`)
  calls `readChunk` (`:177`) unmetered; both construction sites (`:1251`, `:1569`) pass no
  meter. True.
- `wt.ts:924` is the only `ingest` span in `wt.ts`. True.
- Architect **B2** confirmed and it is worse than "one seam": `makeBidiChannel` (`:429`)
  *does* take `busy?: LoopBusyMeter`, uses it at `write` (`:438`) and `end` (`:452`), and
  its `read` (`:455`) is unmetered; the inline `acceptBidi` channel (`:1307`) repeats the
  pattern exactly. `readFromStream` (`:467`) is unmetered and unclassified. Additionally
  **`acceptUni` itself charges nothing on either construction site** (`:1242`, `:1566`)
  while its siblings `openUni` (`:1230`, `:1550`) and `openBidi` (`:1256`, `:1571`) each
  open an egress span — so a seam the plan's own table names is unmetered before any
  channel exists.
- Architect **B3** confirmed at source: `sink-worker.ts:222-229` `measureRead` wraps
  `await read()` and charges the suspension; `sink-worker.ts:320` drives it with
  `nowMs() + readTimeoutMs` (`ws-worker.ts:53`, 5 s default); `ws-worker.ts:293-302` and
  `wt-stream-sink.ts` overwrite `loopUtilization` with it; `evidence.ts:238-252` makes
  these two of the four arms.
- Architect **B5** confirmed: `secure_fs.rs:17789-17799` (`checked_sub` →
  `BindingMismatch("finalBusyMs")`, inequality → `BindingMismatch("busyMs")`),
  `server-snapshot-protocol.ts:176-179`, `arm-measure.ts:235-242`, and
  `render-report.ts:123-128` with `REPORT_CONFIG.loopUtilizationSaturationThreshold = 0.3`
  (`:48`, pinned `cli.test.ts:261`). The plan says it grepped `secure_fs.rs`; the
  constraint is in that file. "No current gate constrains `busyMs`" is false.

---

## C1 (blocking, supersedes architect B1). The gap is not latent, and the plan has **no** attested server figure at all

The architect showed `perSession` is client-sourced. I confirm the chain and then close it
with the artifacts themselves.

Chain: `executeBulkOneWay` (`client.ts:849`) accepts the uni at `:883`, reads every chunk
at `:891` (`await channel.read(readDeadline)`), and returns
`loopUtilization: metrics.loopUtilization` at `:936` where `metrics = input.session.snapshot()`
— the **client** session. `arm-measure.ts:228` takes `const perSession = leg.loopUtilization`
and refuses at `:232` with "a leg without a measured **consumer** loop is a measurement defect".

Now the sealed A5 bulk-one-way physical arms, read off disk:

| run | arm | `perSession` | `serverAggregate` |
| --- | --- | --- | --- |
| `8ada2d1b…` | ws | `busyMs 54.9423828125`, `windowMs 954.010009765625` | `busyMs 65`, `windowMs 1250` |
| `8ada2d1b…` | wt | **`busyMs 0`**, `windowMs 2258.32861328125` | `busyMs 65`, `windowMs 1250` |
| `f9d0cd54…` | ws | `busyMs 40.08154296875`, `windowMs 953.829833984375` | `busyMs 65`, `windowMs 1250` |
| `f9d0cd54…` | wt | **`busyMs 0`**, `windowMs 2447.586669921875` | `busyMs 65`, `windowMs 1250` |

(`.release-evidence/transport-comparison/<run>/busyms-attested-focused-r1/reps/bulk-one-way_physical/<arm>/rep-1.sealed.json`.)

**Two things follow, and each on its own refutes the plan's premise.**

**(a) The receive-side asymmetry is already sealed, twice, as `54.94` vs `0`.** The bulk leg
is receive-only. WS reports tens of milliseconds because ingest is charged at arrival; WT
reports *exactly zero* because no read seam charges. The plan's conclusion — "A5 is
unaffected, … the gap is latent rather than active. It becomes active the moment … a
client-side figure is attested" — is contradicted by the artifacts A5 already sealed. It is
active, it is in the record, and it is the largest asymmetry in the campaign: not a factor,
a zero.

**(b) `serverAggregate` in these artifacts is a fixture default, not a measurement.**
`{busyMs: 65, windowMs: 1250}` is byte-identical across four sealed artifacts spanning two
commits, two transports and two physical runs whose every other measured field varies. Its
source is `tools/compare/cohort-fixture-signing.ts:196-198`:

```
const spanMs = options?.spanMs ?? 1_250;
const busyMs = options?.busyMs ?? 65;
const windowMs = spanMs;
```

`mintPhaseAAttestationFixture` was reachable from `realRunBody` for every run — that is
recorded in this tree at
`.scratch/2026-09-05-cohort-completion/clean/docs/superpowers/plans/deviations/2026-09-02-b4-cohort-executor-dispatch.md:16`
— and production reachability was only removed later (`f95d14b4`, `b3fbaa3c`). So in the
A5 artifacts the plan reasons about, **the figure that varies with the run is the client's,
and the figure the plan believes is the server's is a constant `65`.** There is no attested
server `busyMs` in them.

This is the plan's foundation ("a live measurement campaign whose name is the attested
server busyMs"), and it does not hold for the sealed record. Before any of this work is
scheduled, the plan must establish, by reading a current artifact, whether `serverAggregate`
is captured or fixture-defaulted at HEAD, and say so. If it is still defaulted, this plan is
not the next piece of work.

I state the limit of what I proved: I proved the value equals the fixture default and does
not move across four runs. I did not re-execute the focused runner at HEAD. That is enough
to require the plan to prove provenance rather than assume it.

## C2 (blocking, new). The plan contradicts its own stated goal, and under the prescribed placement the transports still cannot be compared

Work item 1 states the goal and the mechanism in one sentence:

> Charge `readChunk` as `ingest` … **at the same semantic point WS charges**.

These are two different points, and the difference is exactly the one that makes the
comparison meaningless.

- **WS is arrival-charged.** `onSocketMessage` (`ws.ts:1865`) fires from the runtime when
  bytes land, and charges decode + enqueue there. `WsChannel.read` (`:2146`) is correctly
  unmetered because the work is already paid for. The charge does not depend on any
  consumer calling `read`.
- **`readChunk` is pull-charged.** It runs when a consumer asks. Charging there produces a
  number that scales with consumer behaviour, not with transport work.

The consequence is a structural asymmetry that survives the plan's fix intact: a WT session
whose peer floods a stream nobody reads charges **0**; a WS session in the identical state
charges the full decode. Two sessions doing identical transport work, reporting figures that
differ by everything. That is the same class of defect the plan exists to close, re-created
one layer down — and it answers the question of whether the transports are comparable after
the change: **not at the prescribed point.**

The only placement that is semantically WS's is inside the arrival callbacks — `onData`
(`wt.ts:221-224`, where `chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)` runs)
and the `.then` continuation on `reader.read()` (`:196-201`) — mirroring `wt.ts:924`, which
charges *after* `await feed.next()` returns. The architect reaches the same placement from
the other direction (B4: a caller-side span paused across the `await` charges only
`setTimeout`/listener plumbing, i.e. looks fixed while reading near zero). Both routes land
on the same correction, and I confirm the architect's mechanism: with `once("data")`
attached before the `readableFlowing` nudge check (`:238-244`), the synchronous nudge path
is normally dead, so the copy really does run in the listener.

The plan must name the arrival callbacks as the charge sites and drop "charge `readChunk`",
because `readChunk`'s own body is the wrong granularity in both directions.

## C3 (blocking, confirms architect B3 and answers the over-charge question directly)

Yes, charging the read path can over-charge, and this tree already ships the exact mistake.
`sink-worker.ts:222-229` charges `await read()` in full; at `sink-worker.ts:320` the pump
passes a 5 s bound, so an idle reader books up to 5000 ms of "busy" per read into
`loopUtilization.busyMs` — the same field, published by `ws-worker.ts:293-302` and
`wt-stream-sink.ts` for two of the four arms in `evidence.ts:238-252`, and pinned green at
`read-path-adapters.test.ts:291`.

The plan's own risk bullet names this failure ("a naive wrapper around an `await` would
inflate every idle reader") without noticing it is already live in the arms it does not
scope. A plan whose stated risk is realised, in production, in a file it does not mention,
has not bounded its blast radius.

Note the trap the plan is caught between, which it must resolve explicitly: a caller-side
span that pauses across the `await` under-charges to ~zero (C2/architect B4); one that does
not pause over-charges the whole wait (this finding). Neither is correct. Only the arrival
callback is.

## C4 (blocking, new). The fanout claim is misattributed, and Phase B's `busyMs` is a **third** producer

The plan justifies excluding B5/B6 with:

> The fanout server ingests publisher frames through `session.receiveMessage`
> (`tools/compare/server.ts:388-390`) and the WS server through its message callback
> (`:670`). Both are metered.

Both halves fail.

- **`server.ts:388-390` is not the fanout server.** It is inside `echoSession`
  (`:379-406`), whose only caller is `runEchoPeer` (`:423`) — the Phase-A echo peer. The
  fanout relay is `serveFanoutRelayOverWebSocket` (`:631`),
  `serveFanoutRelayOverWebTransport` (`:946`) and `serveFanoutCohortRelay` (`:1191`).
- **`:670` is not metered by `LoopBusyMeter`.** It is wrapped in the local `timed()` helper
  (`:642-650`), which reports through `options.onRelayWork` and is a **no-op when
  `onRelayWork` is undefined**. `startBinaryMessageServer` (`ws.ts:3095-3172`) constructs no
  meter and holds no `busy` at all.
- **The fanout WT peer's ingest is raw and unmetered.** `server.ts:1102` (`streams.read()`)
  and `:1116` (`inbound.read()`) read WHATWG readers directly, outside any adapter `Session`,
  with `LengthPrefixedFrameReader` reassembly — no `LoopBusyMeter` anywhere on that path.

So Phase B's server `busyMs` comes from `createCohortServerLoopObserver`
(`server.ts:1277-1290`), summing `performance.now()` spans and flooring at the read — a
third, independent mechanism, wired at `server.ts:3036`. Its own docstring (`:1256-1257`)
anchors its meaning to *"`adapters/sink-worker.ts:227`"* — the `measureRead` that C3 shows
charges suspension. Meanwhile `transport.ts:149-151` claims `LoopBusyMeter` is "the only
implementation of `SESSION_LOOP_BUSY_MS_DEFINITION` in this tree." At least three producers
write into `busyMs`-named fields; the definition comment is wrong about its own tree.

Two consequences for the plan. First, "B5 and B6 have their busiest direction covered" is
unfounded as written and cannot carry the scope boundary. Second, and more damaging to
objective 2: changing `LoopBusyMeter`'s read charging moves Phase A's figure and leaves
Phase B's untouched, because Phase B does not use `LoopBusyMeter`. A plan whose title is
symmetry must say which of the three producers is the definition and what happens to the
other two.

## C5 (blocking, new). The change introduces a live/closed conservation hole the plan does not address

`wt.ts:1655-1664`: `onSessionClose` deletes the session from `liveServerSessions` and adds a
**snapshot of `busyMs` taken at close** into `closedServerBusyMs`; `serverLoopUtilization()`
(`:1666-1677`) sums the frozen closed total plus a live walk. The transfer is deliberately
once-only.

Today reads charge nothing, so the freeze is exact. Once reads charge, any span that opens
in an arrival callback after `close()` — a `data`/`end` event still queued when
`close()` runs at `:1326`, or teardown after `readable.destroy()` in `cancel` — charges into
a meter that is no longer summed anywhere. The charge is silently lost. Symmetrically, if a
future refactor closes after the callback drains, the same milliseconds could be counted in
both halves.

That is precisely the property the plan's acceptance list asserts will "still hold" ("one
close transfer … no double counting") without naming a test that would notice. The plan must
state the ordering rule between the last read charge and the close transfer, and pin it —
`wt.test.ts` already has the shape (`wt_server_busy_transfers_closed_session_once`,
`wt_server_busy_live_plus_closed_is_65ms`), and those exact-equality assertions on `65` are
among the tests this change should turn red.

## C6 (refines architect B5). The integer refusal does not reach the figure this plan changes; the 0.3 threshold is a detector, not a breakage

The architect writes that "a read-side charge that introduces fractional milliseconds into
any figure that reaches a receipt is refused." That is too broad and the sealed evidence
disproves it: `perSession.busyMs` is `54.9423828125` in a sealed A5 artifact. The integer
refusal (`count()` → `as_u64`, `secure_fs.rs:12450-12459`, `:17789-17791`) applies to the
**rig cohort frame**, whose producer already floors at the read
(`createCohortServerLoopObserver`, `server.ts:1288`). The Phase-A leg figure this plan moves
is fractional today and legitimately so. The plan should state the rounding discipline
per figure, not globally.

On the threshold: the architect calls the 0.3 saturation caveat "the one that bites." The
sealed WS bulk arm sits at `54.94 / 954.01 = 0.0576` — nowhere near it, and a correctly
charged WT arm will not approach it either. Its real value here is the opposite and better:
**it is a ready-made detector for the C3 over-charge failure.** A read charge that books
suspension drives the ratio toward 1.0 and fires the caveat. The plan should adopt it as a
guard on the change rather than treat it as a compatibility risk.

## C7 (blocking, confirms and sharpens the architect's surface-test section). The table is satisfiable vacuously, and work item 2 builds less than acceptance promises

Work item 2 specifies a table keyed by seam **name** and a test that "fails if a seam is
missing from the table". That is a completeness-of-*table* test: it is satisfied by adding
rows. Nothing in it requires a charge to exist. Acceptance then promises strictly more —
"removing a seam's entry **or its charge** turns a named test red" — which work item 2 does
not build. The plan promises a behavioural gate and schedules a lookup.

It is also blind by construction to the defect it exists to catch. `wt.ts` has three
distinct `read` implementations (`:418`, `:455`, `:1307`) and `ws.ts` one (`:2146`). A row
`read → ingest` is satisfied if any one of the four charges — so the current bug would pass
this test after fixing `makeReceiveChannel` alone, with two implementations still unmetered.
The same holds for `acceptUni`, which has two implementations and charges in neither.

The enforcement must bind per construction site and be behavioural: drive each channel a
fixture produces against the priced fake clock and assert the accumulator moved. The
`busy?: LoopBusyMeter` optionality (`wt.ts:429`) is what let B2 happen and should become
non-optional. The enumeration must also cover the wrapper layers, which is where a seam
arrives unmetered by being *decorated* rather than added: `ws-worker.ts:255-256`,
`wt-stream-sink.ts:305-306`, `compare-controller.ts:804-805`.

## C8 (blocking). A5 is invalidated by this work, asymmetrically, and the plan excludes that by sentence

Scope says "Out of scope: changing what the sealed artifact attests for A5". The work
changes it. Concretely, and this is worth stating precisely because it is not symmetric:

- The **WS** arm's `perSession` does **not** move — WS is already arrival-charged, and the
  change touches only WT's read path. The sealed `54.94` stays valid.
- The **WT** arm's `perSession` moves from `0` to a positive number. The sealed WT arm
  becomes non-reproducible at the new HEAD.

So the pair becomes comparable for the first time, at the cost of the sealed WT arm. That is
a good trade and it should be *scheduled and disclosed* — re-run WT, annotate the sealed
artifact, or accept stated incomparability — not excluded by a scope sentence the work
contradicts.

## C9 (confirms architect B1.2 and adds the seam flag)

Work item 3 as written — "The artifact carries only server figures. State that in the
report's provenance text" — instructs the implementer to write a false statement, since
`perSession` is the consumer's loop. The defect it should fix already exists at
`render-report.ts:233`, whose legend says "`busyMs` is the JavaScript event-loop time **the
server** spent" while covering both scopes, and at `isPerSessionSaturated` (`:123-128`),
whose caveat is computed on the client figure under a server label. Invert the item: label
`perSession` as the consumer/driver loop, `serverAggregate` as the server's, and leave
`server-snapshot-protocol.ts:64-79` alone — it is correct for the server frame.

Two mechanics the plan must carry, which I confirm:

- **The `seam` flag.** `LoopBusyMeter.open(kind, seam)` (`transport.ts:205-218`) fires
  `clock.noteBusySlice?.()` on entry. A read returning `null` at EOF carries no message and
  must pass `seam = chunk !== null`, mirroring `wt.ts:924`'s
  `busy.open("ingest", envelope !== null)`, or a deterministic clock prices EOF as a delivery.
- **The definition string is role-baked and hand-duplicated.**
  `SESSION_LOOP_BUSY_MS_DEFINITION` (`transport.ts:131-136`) says "this **server**"; the
  attested `perSession` is a client. `render-report.ts:233` and
  `server-snapshot-protocol.ts:64-79` restate it by hand. The plan puts `transport.ts` in
  scope and schedules no work item that touches the string.

---

## Where I agree with the architect's framing, and where I go further

Agreed: "symmetry" is the wrong objective name and "same order" the wrong acceptance bar.
The definition explicitly excludes what WT does below the JS boundary, so WT *should* read
lower on a read arm, exactly as the send side still reads 170 vs 48.5 with the residual
explained rather than closed. Acceptance bullet 1 ("within a factor stated and justified
from measurement") is unfalsifiable — any ratio can be justified after the fact.

I go further on one point: C2 shows the transports are **not comparable at all** at the
prescribed charge point, independent of magnitude. Fix the placement first; only then is
"completeness plus attributed residual" a meaningful bar.

---

## What would make this APPROVED

1. **Establish the provenance of `serverAggregate` at HEAD** and correct C1 in full: state
   that A5's sealed WT bulk arm attests `perSession = 0` for a receive-only leg, that
   `perSession` is the consumer's loop, and whether any attested server figure exists. If
   `serverAggregate` is still the fixture default `65/1250`, say so and re-order the work.
2. **Move the charge to the arrival callbacks** (`wt.ts:196-201`, `:221-224`), drop "charge
   `readChunk`", and state why a pull-side charge cannot be WS's semantic point (C2), with
   the `seam = chunk !== null` flag (C9).
3. **Restate work item 1 as an invariant over every channel construction site**, covering
   `wt.ts:418`, `:455`, `:1307`, and classify `readFromStream` (`:467`) and the two
   unmetered `acceptUni` implementations (`:1242`, `:1566`).
4. **Bring `ws-worker.ts`, `wt-stream-sink.ts`, `sink-worker.ts` into scope**: either fix
   `measureRead` to exclude suspension or stop publishing its output as
   `loopUtilization.busyMs` (C3).
5. **Correct the fanout claim and name the three producers** (C4): say which is the
   definition, and what Phase B's figure means after the change.
6. **State the ordering rule between the last read charge and the close transfer**, and pin
   it (C5).
7. **Record the four real constraints**, with the integer refusal scoped to the rig frame
   and the 0.3 threshold adopted as an over-charge detector (C6).
8. **Re-key work item 2 to construction sites with behavioural per-site assertions**, extend
   over the wrapper layers, and align acceptance with what is actually built (C7).
9. **Schedule the A5 disposition** — WT arm re-run or annotated, WS arm noted as unaffected
   (C8) — instead of excluding it by scope sentence.
10. **Reframe the objective** from symmetry to completeness-plus-attribution with a
    pre-stated, falsifiable bar; **name the tests that must go red** (the exact-`65`
    assertions in `wt.test.ts`, `read-path-adapters.test.ts:291`) and those that must stay
    green (`loop-busy.test.ts`'s `*_receive_only_arm_is_unchanged_in_meaning`, which
    exercise the datagram/envelope path, not `readChunk`).
11. **Schedule the definition change** in `transport.ts` to be role-neutral, and derive the
    report legend from the exported constant instead of the third hand-written copy (C9).
