# Pre-registration — G6 closeout measurement authority

**Status:** registered successor authority; no successor dispatch has occurred.
**Identity:** `g6-mmo-closeout/1`
**Authority path:** `docs/research/preregistrations/gate-g6-mmo-closeout.md`
**Predecessor authority quoted:** `.scratch/bare-metal-campaign/registrations/g6-mmo-03-redispatch.md`
for candidate `07472469e90d5c95a9270b3cceef19d0f7b1c95e`, historical run
`32666697490`, and stamp record `.scratch/bare-metal-campaign/stamps/g6.md`.

This document is a separately authorized validity-closeout authority. It is not
an amendment, retry, redispatch, restamp, or threshold rewrite of the original
campaign. The predecessor campaign remains closed to a third registration. The
user's separately named closeout request authorizes one new, source-bound
successor campaign after implementation, manifest, and independent-review gates
pass. Preserved predecessor evidence may be regraded only as historical
characterization; it cannot substitute for the successor run or decide its
verdict.

## 1. Why the predecessor promotion is invalid

Run `32666697490` remains preserved as non-verdict characterization, but its old
`MISS` promotion stamp is superseded to `INVALID` because the retained grading
path was not a valid implementation of the registered contract:

1. Hotspot latency bound H1 was graded from the wrong field binding
   (`arm.client.oneWay` instead of `arm.subscriberClient.oneWay`).
2. Clean histograms could be synthesized while negatives and mismatched totals
   were hidden.
3. Run-level falsifiers V-G, V-I, and V-L could be hardcoded clear rather than
   derived from raw evidence.
4. The floor check used the wrong floor input rather than the registered same-day
   floor artifact.
5. Schedule lag could go negative because it was reconstructed from nearest
   deadlines instead of the scheduled Tokio instant.
6. Lifetime receive counters were mixed with steady-window RTT denominators.
7. The historical manifest omitted the gate CSV and therefore did not freeze the
   whole grading input set.
8. Dispatch and stamp prose contradict each other about what was actually being
   graded and why.
9. Bare-echo attribution was compared to the registered scenario even though it
   removed registered downstream work and therefore was not throughput-comparable.

No replacement performance verdict is asserted here, and no stronger claim about
JS causality is licensed than what a corrected, hash-verified evaluator can
derive from the preserved raw evidence.

## 2. Scenario and thresholds frozen unchanged

The original scenario stays fixed:

- Ladder: `500 / 2500 / 5000` sessions.
- Upstream per session: `4` pps at `64 B`.
- Snapshot downstream per session: `15` pps at `1150 B`, emitted as
  `sendDatagramBatch([d0, d1, d2])` at `5 Hz`.
- Ack downstream per session: `0.5` pps at `64 B`.
- Gate rung aggregate offer: `20,000/s` upstream and `77,500/s` downstream.

All predecessor clause thresholds and falsifier thresholds remain frozen. A
corrected valid `MISS` remains final under this authority. No clause, falsifier,
or threshold may be moved after evidence is read.

## 3. Corrected measurement semantics

The successor grading mechanism must use these semantics:

1. Schedule lag is measured from the Tokio scheduled `Instant`, not reconstructed
   from nearest deadlines.
2. Schedule lag is nonnegative: `lag = max(0, fired_at - due_at)`.
3. Offer accounting records `due`, `fired`, and `skipped` separately; none may
   be inferred from another counter.
4. Steady-arm denominators use the registered steady window for offers and the
   registered steady-plus-drain window for delivered work only where the
   predecessor contract already allowed it.
5. Storm denominators use the registered storm window only; lifetime counters
   may not be mixed into steady or storm latency sample denominators.
6. Histogram validity is decided from raw bucket totals, recorded totals,
   negative counts, expected stamped samples, and unstamped counts.
7. Every role must expose explicit steady, one-second drain, storm, post-storm,
   idle, and lifetime accounting. Sends stop at drain while receives remain
   active; steady RTT and hotspot one-way use the steady-plus-drain receive
   window, while storm-survivor RTT uses only non-severed sessions during the
   storm window.
8. The three concurrent hotspot roles (`realm`, `publisher`, and
   `raid-subscriber`) must enter steady through one same-host barrier. Their raw
   reports must agree on barrier identity, party count, and release, and their
   recorded steady-entry skew must be at most 100 ms. Missing or inconsistent
   barrier evidence is invalid, not an inferred boundary.

## 4. Required schemas and raw evaluator binding

The successor closeout must bind to raw evidence, not artifact verdict fields.
The required schemas are:

- `bench-g6/2`
- `mmo-client/2`
- `g6-classified/2`
- `g6-attribution/1`

The evaluator must recompute all clause and falsifier outcomes from raw fields.
Any precomputed verdict booleans in an artifact are advisory only and have no
promotion authority.

## 5. Attribution boundaries

CPU attribution must keep two analyses separate:

1. Fixed-offer capacity attribution: compare workloads at the same registered
   offered shape and host conditions.
2. Matched-throughput attribution: compare workloads only after throughput is
   explicitly matched and labeled as such.

No closeout may cite a lower-work bare-echo run as if it were directly
comparable to the registered MMO shape.

The attribution matrix contains exactly three server lanes at the same
steady-5,000 workload: `full-js`, `minimal-js-addon`, and `direct-rust`.
`direct-rust` is a same-protocol reference control, not a replacement product
gate. It must use the same candidate dependency graph, two-worker server runtime
width, client binary, TLS identity, sessions, cadence, payload allocation shape,
classes, phase windows, and limits as the JavaScript lanes.

The only licensed `minimal-js-addon` contract is the full JavaScript lane with
this exact instrumentation switch vector:

```text
recordClauseLatencyHistograms: false
retainPerDatagramDiagnosticSamples: false
emitVerboseProgressLogs: false
materializeHumanReadableRows: false
```

It remains JavaScript-scheduled and N-API-backed. It must retain snapshot
construction and fresh payload materialization, 20 ms slice scheduling,
session-to-slice mapping, stamp decode and class/sequence validation,
`sendDatagramBatch([d0,d1,d2])`, unbatched ack reflection, raid behavior,
backpressure/error handling, phase markers, essential per-class/window integer
counters, emitter schedule-lag measurement, raw client reports, and stage
reconciliation. Pooling, template reuse, scheduler replacement, native callback
bypass, batch-size changes, decode/counter elision, or moving application work
into Rust/addon code makes the lane non-comparable.

The nine authoritative legs are unprofiled and order-balanced as
`full,minimal,rust`; `minimal,rust,full`; `rust,full,minimal`. Fixed-offer
capacity interpretation requires identical configured due work and offered
shape, but achieved issue/delivery divergence remains an outcome. Cross-lane CPU
attribution requires achieved issued-rate parity within 0.5%, or a separately
identified common-throughput replay at the lowest sustainable rate shared by
all lanes. Profiles are optional replays only and never replace authoritative
CPU/counter evidence.

## 6. Required inputs and refusal rules

The successor closeout requires all of the following, hash-verified before
grading:

- The predecessor registration, historical stamp, historical mechanism ticket,
  and all files under `.scratch/bare-metal-campaign/evidence/g6/`.
- A manifest that is executable from the corrections directory and freezes the
  full predecessor input set, including the CSV.
- Source identity for the historical candidate SHA and the evaluator source used
  for closeout.
- Host and path disclosures needed to keep fixed-offer and attribution claims
  comparable.
- One clean successor candidate SHA/tree on `probe/g6-mmo-closeout-04`, the
  exact preregistration SHA-256, and unconditional architect and critic approval
  bound to the same source-bound registration digest before dispatch.
- Same-day R-down, R-up, 20-session floor, and loopback sink inputs from the
  registered Mac/runner pair, with nonempty off-box identity for authoritative
  G6 evidence. A co-resident run is smoke evidence only.
- One complete nine-leg attribution bundle and one complete full-G6 bundle.
  Each bundle must retain final or partial JSON, CSV where applicable, all raw
  role reports/logs, external grading inputs, source/host identity, comparison
  output, and a byte-identical `preregistration.md`.
- A self-verifying manifest generated only after outputs close. It must list
  every retained file, reject missing or extra files, absolute paths, symlinks,
  duplicate names, candidate or preregistration mismatch, and incomplete leg
  sets, and it must be verified independently before upload and after download.

If any required input is missing, mismatched, stale, co-resident where off-box is
required, dirty, schema-incompatible, or unhashable, the successor must refuse
promotion rather than substitute newer evidence or retune thresholds. A
preflight failure stops before dispatch. One explicitly logged replacement is
allowed only for an infrastructure failure before measurement while source,
registration, hosts, and same-day inputs remain identical. A validity
falsifier, schema defect, source change, or artifact-integrity failure requires
a new fix, candidate SHA, registration digest, and unconditional architect and
critic reviews. If the corrected mechanism reaches a valid `MISS`, that result
is final under this authority and does not license a rerun.
