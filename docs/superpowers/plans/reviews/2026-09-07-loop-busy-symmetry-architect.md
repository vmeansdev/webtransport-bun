CHANGES REQUIRED

# Architect review — loop-busy symmetry across transports and directions

| Bound | Value |
| --- | --- |
| Plan | `docs/superpowers/plans/2026-09-07-loop-busy-symmetry.md` |
| Plan SHA-256 (computed) | `887d31d077b7173aeab2e394969bb18c82e10ca4336ede8d2b26737584e2b3b3` |
| Declared SHA-256 | identical — digest verified before review |
| HEAD reviewed against | `60f4a59b66c2313d0fa680a094a0f56d343211fc` |
| Method | every cited file:line read at HEAD; `bun test tools/compare/adapters/loop-busy.test.ts tools/compare/adapters/read-path-adapters.test.ts` → 29 pass / 0 fail |

Verdict: the plan identifies a real defect and one real seam, but its central
factual premise about *whose* loop time is attested is wrong, and that error
propagates into the risk assessment, the scope boundary and work item 3 — which,
executed as written, would publish a false provenance statement. Three further
unmetered read seams and two whole arms are outside the scope. Six blocking
items below.

---

## What the plan gets right (verified)

These claims are true at HEAD and I confirmed each by reading the code:

- **WS charges channel-data ingest once, in `onSocketMessage`.** `adapters/ws.ts:1865`
  is `this.busy.measure("ingest", () => this.dispatchSocketMessage(value))`, and
  `decodeWebSocketFrame` runs inside `dispatchSocketMessage`. **`WsChannel.read`
  (`ws.ts:2146`) only dequeues** — `waitForQueue` on `this.incoming` plus
  `reservation.release()`, no meter. Accurate.
- **WT has exactly one ingest span.** `grep 'busy\.\(measure\|open\)'` over
  `adapters/wt.ts` returns 13 spans; twelve are `"egress"`, and `:924`
  (`busy.open("ingest", envelope !== null)`) is the only ingest one. Accurate.
- **`makeReceiveChannel` (`wt.ts:410`) takes no meter and its `read` calls
  `readChunk` (`:177`) unmetered**, and both construction sites (`:1251`, `:1569`)
  pass only `(readable, clock)`. Accurate.
- **The fanout server ingests through `receiveMessage`** (`server.ts:388-390`) and
  **the WS server through its message callback** (`server.ts:670`, `onMessage`).
  Accurate.
- **`artifact-builder.ts:533-536` carries `loopUtilization.{perSession,serverAggregate}`**
  and **`:787-799` validates them** — though see B1: the validation is on `windowMs`,
  and the *scope* claim attached to these fields is wrong.
- The drivers named in work item 4 exist:
  `.scratch/2026-09-07-phase-a-delivered/drive.ts` and
  `.scratch/2026-09-07-wt-capture/rig-arm.ts`.
- The meter contract the plan cites is real: `LoopBusyMeter`
  (`adapters/transport.ts:161`) with depth-based nesting, `open(kind, seam=true)`,
  `pause`/`resume`/`close`, one accumulator per session.

---

## Blocking findings

### B1. The plan's provenance premise is false: `perSession` is the **client** loop, not the server's

The plan states:

> The sealed artifact carries two busy figures, **both server-side**:
> `loopUtilization.perSession` and `loopUtilization.serverAggregate` … **No client
> loop figure is attested.**

The code says the opposite for `perSession`. `tools/compare/arm-measure.ts:224-231`:

```
// Per-session busy time lives on the leg (the consumer side
// the driver is on); the server's aggregate is a separate
// scope sourced from the controller's sidecar.
const perSession = leg.loopUtilization;
```

and the refusal text at `:232` is `"a leg without a measured **consumer** loop is a
measurement defect"`. The chain is unambiguous:

- `client.ts:503` (and `:939`, `:1025`, `:1152`, `:1259`) sets
  `loopUtilization: metrics.loopUtilization`, where `metrics` is the snapshot of the
  session returned by `input.adapter.connect(...)` in `measureLegOverAdapter` — a
  **client** session.
- `bin/compare-controller.ts:2180` calls `measuredLegToArm({ leg, serverSnapshot: … })`
  with that client leg. This is the Phase-A path A5 runs.
- Only `serverAggregate` comes from the sidecar (`server-snapshot-sidecar.ts:107`).
- Phase B is different: `projectCohortEvidenceToMeasuredLeg` sources
  `loopUtilization = the rig server snapshot's reading` (`arm-measure.ts:527`, `:770`).
  So "both server-side" is true for B5/B6 and **false for A5**.

Three consequences, each of which changes the plan:

1. **The gap is active, not latent.** The plan concludes "A5 is unaffected … the gap
   is latent rather than active. It becomes active the moment … a client-side figure
   is attested." A client-side figure *is* attested, and the one production consumer
   the plan itself identifies — the bulk read leg at `client.ts:883` — is exactly the
   leg whose `perSession` figure A5 seals. A5's WT bulk arm attests a `perSession`
   busyMs that omits its entire read path today.
2. **Work item 3 would document a falsehood.** It instructs: "The artifact carries
   only server figures. State that in the report's provenance text and in the frame
   documentation." Executing that writes an untrue claim into the report. The real
   defect it should be fixing is already present: `render-report.ts:233` describes
   busyMs as "the JavaScript event-loop time **the server** spent" in a legend that
   covers *both* scopes, mislabelling `perSession`. Work item 3 must be inverted —
   label `perSession` as the driver/consumer loop and `serverAggregate` as the
   server's — rather than cementing the error.
3. **The "out of scope" boundary is unachievable as written.** Scope says "Out of
   scope: changing what the sealed artifact attests for A5". Charging the read path
   changes `perSession` for every A5 bulk arm, so any re-run is non-comparable with
   the sealed WS arm. That is a legitimate thing to do, but it must be *scheduled and
   disclosed*, not excluded by a sentence that the work contradicts.

### B2. Three more unmetered read seams in `wt.ts`; the fix as written reaches one

The plan diagnoses the defect as "`makeReceiveChannel` is the one seam constructed
without a `LoopBusyMeter` argument at all" and prescribes "`makeReceiveChannel` takes
the meter, as `makeBidiChannel` already does, and both construction sites pass it."
That diagnosis is the wrong invariant. Having the meter is not the same as charging:

- **`makeBidiChannel.read` (`wt.ts:455`)** — `return readChunk(duplex, deadlineMs, clock)`.
  `makeBidiChannel` *does* take `busy?: LoopBusyMeter` (`:429`) and uses it for `write`
  (`:438`) and `end` (`:452`), and still does not charge `read`.
- **The inline bidi channel returned by native `acceptBidi` (`wt.ts:1307`)** — same
  shape: `write`/`end` pass `busy`, `read` calls `readChunk(readable, dl, clock)`
  unmetered.
- **`readFromStream` (`wt.ts:467`)**, used by `acceptUni` (`:1243`) and `acceptBidi`
  (`:1273`) to take the stream off the incoming-streams queue, is unmetered and
  unclassified.

Executing work item 1 verbatim leaves two of the three channel `read` implementations
unmetered while the plan reports the defect closed. The fix must be stated as an
invariant over *every* channel-returning construction site, not over the one
constructor whose signature lacks the parameter.

### B3. The two arms whose entire identity is the read path are outside the scope, and one of them already commits the exact error the plan warns about

`evidence.ts:238-252` defines four arms — `ws`, `wt`, `ws-worker`, `wt-stream-sink` —
and `ARM_READ_PATH` marks the last two `"worker"`. Half the comparison is read-path
arms. The plan's scope names only `adapters/wt.ts`, `adapters/ws.ts`,
`adapters/transport.ts`. Neither `adapters/ws-worker.ts`, `adapters/wt-stream-sink.ts`
nor `adapters/sink-worker.ts` appears anywhere in it.

This is not a coverage nicety. `ws-worker.ts:296-302` **replaces** the base session's
`loopUtilization` in `snapshot()`:

```
loopUtilization: {
    busyMs,                    // summed from worker.stats()
    windowMs: Math.max(0, context.clock.nowMs() - sessionOpenedAtMs),
},
```

`wt-stream-sink.ts:329-346` does the same. That `busyMs` comes from
`sink-worker.ts` `measureRead`:

```
async measureRead<R>(read: () => Promise<R>): Promise<R> {
    const startedAtMs = nowMs();
    try { return await read(); }
    finally { busyMs += Math.max(0, nowMs() - startedAtMs); }
}
```

This wraps an `await`. It charges the full suspension waiting for a chunk — up to
`readTimeoutMs` (default 5 s, `ws-worker.ts:53`) per read. That is precisely the
error the plan's own risk section names: *"a naive wrapper around an `await` would
inflate every idle reader."* It exists today, in a producer that writes into the same
`loopUtilization.busyMs` field the plan is trying to make coherent, under a module
docstring (`ws-worker.ts:21-25`) that presents it as the honest reading. It is a
**fourth instance** of the defect family, and it is pinned green by
`read-path-adapters.test.ts:291` ("snapshot publishes the reader's loop, not the base
session's").

Because the value is near-saturating by construction (busy ≈ window for any pumping
reader), it also interacts with B5: `isPerSessionSaturated` fires at 0.3.

The plan must either bring these three files into scope and reconcile them with
`SESSION_LOOP_BUSY_MS_DEFINITION`, or state explicitly that `ws-worker` /
`wt-stream-sink` publish a *different, named* quantity that is not busyMs and must not
share the field. Silence is the one option that leaves a known-wrong number attested.

### B4. The prescribed span placement cannot charge the work it is meant to charge

Work item 1 says: charge `readChunk` as ingest, "excluding time suspended waiting for
data", obeying "never spanning an `await`". Applied literally — a span opened in
`makeReceiveChannel.read` around `await readChunk(...)`, paused across the await — it
charges almost nothing on WT, because WT's read does its JS work in *callbacks that
fire while the span is paused*:

- Node `Readable` branch (`wt.ts:221-224`): the copy
  `chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)` runs inside `onData`,
  a `once("data")` listener invoked from the event loop after the promise executor
  returned.
- WHATWG branch (`wt.ts:196-201`): the unwrap runs in a `.then()` continuation on
  `reader.read()`.

Both run outside any caller-held span. What a caller-side span *can* charge is the
prologue — `setTimeout`, listener attachment, `getReader`/`releaseLock` — i.e.
microseconds of plumbing, not the ingest work. The plan would then report the seam as
metered while the number stays near zero, which is worse than the current state
because it looks fixed.

The charge must be placed **inside** the resolution callbacks (`onData`, `onEnd`, the
`.then` continuation), mirroring how `wt.ts:924` charges *after* `await feed.next()`
returns. The plan must say this; as written it steers an implementer to the wrong
placement, and its own "never spanning an `await`" rule is what does the steering.

### B5. "No gate constrains busyMs" is false, and the greps that established it missed the files that matter

The risk section says: "No current gate constrains `busyMs`, verified by grep over
`server-observation-artifact.ts`, `verify-campaign-index.ts`, `output-policy.ts` and
`crates/native/src/secure_fs.rs`, so nothing breaks today."

Four constraints exist, one of them in a file the plan says it grepped:

| Constraint | Location |
| --- | --- |
| Conservation `finalBusyMs − baselineBusyMs == busyMs`, else `BindingMismatch("busyMs")` | `crates/native/src/secure_fs.rs:17789-17799` |
| Same conservation on decode | `tools/compare/server-snapshot-protocol.ts:176-179` |
| `busyMs` must be finite (leg) / finite and nonnegative (server) | `arm-measure.ts:235-239`, `:713-716` |
| **Behavioural threshold**: `isPerSessionSaturated` fires when `perSession.busyMs / windowMs > 0.3`, adding the saturation caveat to the ranking | `render-report.ts:123-128`, `:48`, pinned at `cli.test.ts:261` |

The last is the one that bites: it reads exactly the figure this plan increases, and
it changes report output. Additionally, `busyMs` on the rig frame is parsed with
`count(...)` (`secure_fs.rs:17789-17791`) — integer-only, pinned by
`rig_cohort_runtime.rs:2370` `a_fractional_baseline_busy_ms_cannot_reach_a_rig_receipt`.
A read-side charge that introduces fractional milliseconds into any figure that
reaches a receipt is refused. The plan must state the rounding/accumulation
discipline, and must re-run the risk grep over `server-snapshot-protocol.ts`,
`arm-measure.ts` and `render-report.ts`.

### B6. The acceptance criterion is not falsifiable, and the plan states two different bars

Work item 4: "the two transports report figures **of the same order** for the same
work". Acceptance bullet 1: "the WS and WT figures for the same bytes are **within a
factor stated and justified from measurement**". These are different bars, and the
second states the factor *after* measuring — which makes it unfalsifiable: any
observed ratio can be "stated and justified" post hoc.

Fix: pre-state the numeric bar and what disproves it, before the run. If the honest
answer is that no ratio can be pre-stated (see the framing note below), then the
acceptance criterion should not be a ratio at all — it should be per-seam charge
completeness plus a residual attributed to named measured components, which is what
`60f4a59b` actually delivered on the send side and what the plan cites as its model.

---

## Framing: is charging the read path the right fix?

Partly, and the objective is misnamed. Two things are conflated:

**Completeness of charging** — every seam that does JS transport work charges it — is
correct, is the real defect, and is worth doing.

**Symmetry** — WS and WT reporting comparable figures for the same bytes — is the
plan's title, objective 2, and acceptance bar, and it is very likely *wrong as a
goal*, because under the published definition the transports genuinely differ:

- WS decodes every inbound frame in JavaScript (`decodeWebSocketFrame` inside
  `onSocketMessage`). That is real loop time and is correctly charged.
- WT stream reads do their framing in QUIC below the JS boundary. The definition
  explicitly excludes that: *"It is not process CPU: native, kernel and other-thread
  time are excluded."*

So after every seam is charged honestly, WT *should* read lower than WS on a read
arm, for the same reason the send side still shows 170 ms vs 48.5 ms after
`60f4a59b` — and there that residual was accepted as explained, not forced closed.
Naming the objective "symmetry" and the acceptance "same order" creates pressure to
make two legitimately different numbers converge. Recommend renaming the objective to
completeness-plus-attribution and making the acceptance "every seam charges what it
does; the residual is attributed to measured components", which is both achievable
and falsifiable.

## Is the definition in `transport.ts` still right?

No, and the plan asserts the opposite. `SESSION_LOOP_BUSY_MS_DEFINITION`
(`transport.ts:131-136`) opens: *"busyMs is the JavaScript event-loop time **this
server** spent on this session's transport work…"*. Objective 2 requires WS and WT
sessions reading a bulk channel to be comparable *"under the definition already
published"* — but the bulk reader is the client (`client.ts:883`), and per B1 the
attested `perSession` is already a client figure. The definition does not describe it
today and will describe it less well once client reads are charged.

The definition needs to become role-neutral — the loop time *this session's process*
spent on this session's transport work — with the role carried as a labelled property
of each attested figure rather than baked into the prose. The plan puts
`transport.ts` in scope but schedules no work item that touches the definition
string, so as written it leaves the contradiction standing.

Two related items the plan should also carry:

- The definition is **hand-duplicated**, not derived, at `render-report.ts:233` (with
  an extra clause about harness work) and paraphrased again at
  `server-snapshot-protocol.ts:64-79`. If the wording changes, three copies must move
  together. Make the report legend derive from the exported constant.
- `server-snapshot-protocol.ts:64-79` is the "frame documentation" work item 3 names;
  its text is correct for the *server frame* and must not be edited to match the
  (wrong) claim that all figures are server-side.

---

## Is the work item 2 surface test sufficient to prevent a third instance?

**No, not as specified.** The plan describes a table keyed by *seam name* —
`openUni`, `acceptUni`, `openBidi`, `acceptBidi`, `sendDatagram`, `receiveMessage`,
`sendMessage`, channel `write`, channel `read`, channel `cancel`, close — with a test
that "walks the surface of both adapters and fails if a seam is missing from the
table."

A name-keyed table cannot catch the defect it exists to catch. `wt.ts` has **three
distinct `read` implementations** (`:418`, `:455`, `:1307`) and `ws.ts` one (`:2146`).
A table entry `read → ingest` is satisfied by one of the four charging. The current
bug — B2 — would pass this test today if `makeReceiveChannel` alone were fixed. The
defect class is "an implementation of a metered seam that does not charge", and name
enumeration is blind to it by construction.

To actually prevent a third instance, the enforcement must bind at the point a channel
is *constructed*, not at the point a method is *named*. Concretely, one of:

- Route every `ReceiveChannel` / `BidiChannel` / `SendChannel` through a single
  registered factory that takes a non-optional `LoopBusyMeter`, so a new construction
  site cannot type-check without one. This is the structural fix and it also removes
  the `busy?: LoopBusyMeter` optionality that let B2 happen.
- Plus a behavioural test per construction site — drive each channel a fixture
  produces against a priced fake clock and assert the meter moved. That is what
  "removing a seam's charge turns a named test red" requires; a table lookup does not.

The enumeration must also cover the decorator layers (B3): `ws-worker.ts`,
`wt-stream-sink.ts`, and the forwarding wrapper at `compare-controller.ts:804-811`.
A seam can arrive unmetered by being *wrapped*, not only by being added.

---

## Things the plan says that the code does not support

- **"`acceptUni` + `makeReceiveChannel` has exactly one production caller,
  `tools/compare/client.ts:883`."** There is one production *consumer*, but it is
  reached through three forwarding layers that are also production code and are where
  the metering is lost or overwritten: `ws-worker.ts:256`, `wt-stream-sink.ts:306`,
  and `compare-controller.ts:804-805`. `tools/load/distributed-scale.ts:962` is a
  fourth caller outside `tools/compare`. The single-caller framing is what makes the
  blast radius look small; it is not.
- **"both server-side" / "No client loop figure is attested"** — B1.
- **"No current gate constrains `busyMs`"** — B5.
- **"`makeReceiveChannel` is the one seam constructed without a `LoopBusyMeter`
  argument at all"** — true literally, misleading as a diagnosis (B2).

## Things the plan should say and does not

1. **Which existing tests go red, and which must.** `read-path-adapters.test.ts:291`
   pins the `ws-worker` override that B3 challenges. The plan asserts the existing
   properties "still hold" without naming a single test that must change — but a
   change of this shape that turns *nothing* red has not changed a measured
   behaviour. (For the record: `loop-busy.test.ts`'s
   `*_receive_only_arm_is_unchanged_in_meaning` tests exercise the datagram/envelope
   path, not `readChunk`, so they stay green — the plan should say so rather than
   leave it to be discovered.)
2. **The `seam` flag for the read span.** `LoopBusyMeter.open(kind, seam)`
   (`transport.ts:206`) exists so a slice carrying no message charges its real time
   without letting a deterministic clock price it as a delivery. A read returning
   `null` at EOF is exactly that case, and must mirror `wt.ts:924`'s
   `busy.open("ingest", envelope !== null)` as `chunk !== null`. Omitting this
   mis-prices EOF under the priced fake clock the loop-busy suite uses.
3. **Baseline numbers before the change.** Work item 4 says "report, before and
   after" but pins no before-values into the plan, so a reader cannot tell later
   whether the run that was executed is the run that was planned. Record the current
   A5 bulk `perSession` figures for both arms in the plan before executing.
4. **What happens to already-sealed A5.** See B1.3 — state the disposition
   (re-run / annotate / accept incomparability), do not exclude it by scope sentence.
5. **`sessionsActive`-style scope for the window.** `ws-worker` computes `windowMs`
   from `sessionOpenedAtMs` while `LoopBusyMeter` computes it from meter construction
   (`transport.ts:167-168`). If both can populate one field, the window origins must
   be reconciled or the ratio is not comparable across arms.

---

## What would make this APPROVED

1. Correct the provenance premise (B1) and invert work item 3 accordingly.
2. Restate work item 1 as an invariant over every channel construction site, covering
   `wt.ts:455` and `:1307`, and classify `readFromStream` (B2).
3. Bring `ws-worker.ts`, `wt-stream-sink.ts` and `sink-worker.ts` into scope; either
   fix `measureRead` to exclude suspension or stop publishing its output as
   `loopUtilization.busyMs` (B3).
4. Specify the span placement inside the read resolution callbacks, with the `seam`
   flag (B4, missing-item 2).
5. Re-run the gate grep and record the four real constraints, including the 0.3
   saturation threshold and the integer-only rig parse (B5).
6. Pre-state a falsifiable acceptance bar, or reframe from symmetry to
   completeness-plus-attribution (B6, framing section).
7. Re-key the work item 2 enforcement from seam names to construction sites, and
   extend it over the decorator layers (surface-test section).
8. Schedule the definition change in `transport.ts` and de-duplicate the two copies
   (definition section).
