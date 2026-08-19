# Pre-registration — gate G4, SFU 1→50 fan-out

Contract: `.scratch/production-grade-scenarios/spec.md` §G4 (rev 2, APPROVED).
Method: `docs/research/preregistrations/egress.md`, amendment 8 (the fan-out
shape, both falsifiers, both sweeps) and amendment 9 (socket counters, added
below). This document does not reinterpret either — it records the decisions
§G4 leaves to the gate runner, and it is committed **before** the harness is
touched for this gate and **before** any dispatch.

Gate runner is not the implementer of any lever and not the implementer of
tickets 14/15 (spec §Process rules, *Separation*).

## Candidate tree

| role | SHA |
|---|---|
| staging base (the four landed levers) | `3d03a9878619db77bc3d94b96976ddb5d9ddb24a` |
| axis probe branch | `28394d9` (`probe/egress-01`, ticket 14 tip) |
| composition | **rebase** of `probe/egress-01` onto staging, as `probe/egress-fanout-01` |
| composed tree, before this gate's commits | `932c0bebaca660c33fb3e2e460f4ee3f20f0b851` |
| candidate | the tip of `probe/egress-fanout-01` after this document and the amendment-9 harness commit; its SHA is entered in the run log below at dispatch |

Rebase, not merge, on purpose: the axis's five fan-out commits replay one by one
onto the staging tree, so each stays individually reviewable and the candidate is
a linear tree whose diff against staging is exactly the harness. A separate
branch (`probe/egress-fanout-01`, forked at `28394d9`) is used because
`probe/egress-01` is checked out by another agent's worktree. The candidate is
never merged back.

## Forward emitter — registered before the run

The server's SFU forward path stays **pipelined per-target `session.sendDatagram`,
settled together** — the shape ticket 14 built, unchanged:

```
const targets = subscribers.filter((s) => s !== entry);
for (const target of targets) pending.push(target.send(datagram));
await Promise.allSettled(pending);
```

Registered reasons, all of which predate the run:

1. **`sendDatagramBatch` does not apply to this crossing shape.** It batches
   *many payloads into one session*. A 1→N fan-out delivers *one payload to N
   sessions*: per target the batch would have exactly one element. The API's own
   contract says a batch of one has nothing to amortise its array marshalling
   over and must be byte-identical to `sendDatagram`, so using it here could only
   add a JS array allocation per target. The API a real SFU would want is the
   mirror image — one payload, N sessions — and **it does not exist**. That is a
   finding this gate records, not one it acts on.
2. **The landed promise-free send is already on this path.** `sendDatagram`
   takes `trySendDatagram` whenever the datagram has queue budget
   (`WEBTRANSPORT_DATAGRAM_SEND_SYNC`, default on), and falls back to the parking
   send only when it must wait. The close-contract lever is therefore exercised
   by the registered emitter with no harness change, and the run records the knob
   in the fragment config so the artifact states which path was live.
3. **A raw `trySendDatagram` emitter is refused.** It would drop on
   `WOULD_BLOCK` instead of waiting, converting a capacity finding into a silent
   delivery loss — under a gate whose bar *is* forward delivery ≥ 0.99. It would
   also be this axis optimising, which amendment 8 forbids in as many words
   ("It is recorded, not acted on: this axis may not optimize").

The per-target crossing cost stays instrumented and unacted-on:
`forwardIssueSpread / max(N,1)`, plus `forwardSettle` and `handlerToForward`.

## What is dispatched

One dispatch of `bench-bandwidth.yml` with `egress_probe=true` and the ladder
profiles empty, so the run is the fan-out shape and its controls only. Both
registered sweeps run, each in its own server process and its own fragment:

- `per-subscriber` — publisher held at 330/s (11 datagrams per 33.3 ms frame,
  ≈ 3.04 Mbps at 1150 B; the quantised form of §G4's 326 pps) for every N.
- `constant-aggregate` — aggregate forward egress pinned at 16,500/s.

N ∈ {10, 25, 50, 100}, 45 s a step, 20 s sink pre-check before every N. N=50 is
the gate's point and is derived from arithmetic (326 pps × 50 = 16.3k/s forward
egress, inside the licensed constant-shape envelope); N=10 and N=25 give the
scaling curve an anchor, N=100 exists so the curve is not read off its own
endpoint. Nothing about N comes from the retracted run.

The generator-headroom control arm runs (the workflow runs it unconditionally)
and its fragment is kept. With no ladder step in the set, the run-level headroom
rule reports **`headroom-not-evaluated`** and the run-level `complete` is false —
that is amendment 8's mechanical form 2 firing exactly as registered, and it does
**not** void G4. G4's pass/fail is read off the fan-out steps' own `complete`
flag and their own numbers, because the headroom rule's denominator is the JS
ladder scheduler, which this shape does not contain.

## Gate evaluation — pre-registered, mechanical

G4 **passes** iff, on the `per-subscriber` sweep at **N=50**:

1. the step is `complete` (no STOP; both falsifiers cleared — sink pre-check
   `pass`, `ingestReality.real === true`), **and**
2. publisher-send → subscriber-receive `egressOneWay` p99 **< 33.3 ms**, **and**
3. `forwardDeliveryRatio` ≥ **0.99**, **and**
4. **N is decoupled from rate**: the `constant-aggregate` sweep is complete at
   N=50 as well, and the two sweeps agree on whether the N=50 p99 clears the
   frame gate. If `per-subscriber` shows an effect at N=50 that
   `constant-aggregate` does not, the effect is a rate effect and the N claim is
   withheld — reported, not converted into a pass.

Any falsifier firing at N=50 makes the gate **incomplete**, never a miss and
never a capacity number: an `incomplete` step is a statement about the rig.
A complete N=50 step that misses (2) or (3) is a **miss**, and per the spec's
rerun policy a miss on a valid run is final and routes to its mechanism ticket.

`fanoutScaling` = p99(N)/p99(smallest complete N of the same sweep) is reported
raw, per sweep, with no bucket and no cross-sweep comparison.

## The 10-person-room equivalence figure — formula registered before the run

§G4's room figure is derived from measured numbers only, by this formula and no
other:

```
roomForwardLoad = P × (P − 1) × R_eff        with P = 10
rooms           = floor(F_measured / roomForwardLoad)
```

where `R_eff` is the **measured** effective publisher rate of the complete N=50
`per-subscriber` step (the quantisation-corrected label, not the nominal 330),
and `F_measured` is the **measured aggregate forward egress of that same
complete step** — `forwarded / driveWindowSec` — and nothing else. No rung is
extrapolated, no incomplete step contributes, and if the N=50 step is not
complete the figure is not produced at all.

Binding caveat, registered here so it cannot be dropped later: the measured shape
has **one** ingest and N egress. A 10-person room has ten simultaneous ingests.
The figure is therefore an arithmetic conversion of measured *forward-egress*
capacity into a room count under the explicit assumption that ingest is not the
binding constraint — an assumption this gate does not test. It is reported with
that sentence attached, and it may not be quoted without it.

## Amendment 9 to the egress pre-registration — server-side socket counters

Registered in `docs/research/preregistrations/egress.md` (amendment 9) and
implemented by this gate's single harness commit; ticket 15's residual, the
critic's "closes the server-send-path blind spot". Purely additive
instrumentation: a new `udp` field per step and per sink pre-check arm, carrying
`/proc/net/snmp` `Udp:` deltas over the same drive window the step's rates divide
by, plus the derived GSO amortisation ratio. It is a **diagnostic**: no bucket,
no STOP, no gate reads it. On a non-Linux host it is `null`, which is what the
local smoke produces.

## Local validation performed before the dispatch plan was returned

Recorded so the dispatch is not the first time the composed tree runs: typecheck,
lint, the axis harness's own tests, and a local macOS smoke of the fan-out shape
with a reduced N set and short steps, with `WEBTRANSPORT_DATAGRAM_SEND_SYNC` at
its default (on). The smoke exists only to prove the harness runs on the composed
tree; **no number from it is a result**, per amendment 8's "what this shape may
not do".

## Run log

Every dispatch of this gate, including aborted ones.

| dispatched | run id | candidate SHA | artifact hash | outcome |
|---|---|---|---|---|
| — | — | — | — | **no dispatch has been made** |

## What this gate may not do

It may not report a number from a step any falsifier marked `incomplete`; it may
not compare a `per-subscriber` rung to a `constant-aggregate` rung as if they
were one measurement; it may not quote the local smoke; it may not tune the
harness, the emitter or the N set after seeing a result; and it may not convert
the room figure into a provisioning claim without the ingest caveat above.
