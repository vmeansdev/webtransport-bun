# Preregistration — gate g6-sharded-02 (id `g6-sharded/2`)

Registered before any licensed measurement runs; frozen at registration
time; a failed rung is diagnosed, never re-thresholded.

## 1. Relationship to g6-sharded/1

Gate `g6-sharded/1` stamped **valid MISS × 3 on S3 duty alone**
(0.98756 / 0.96921 / 0.94902 against the 0.99 floor; every other clause
passed with wide margin — S1/S2 at 1.0000 everywhere, S4 at 4.99–14.11 ms
against 25, S5 zero). Its stamp attributes the mechanism: **emitter
slice-timer under-delivery** — missed `setInterval` firings were lost
demand. This gate asks the same question at a candidate carrying the fix
for exactly that mechanism, and nothing else material to the measurement.

## 2. Incorporation by reference

Question, ladder (5000 / 15000 / 20000 at 16 CID-steered shards), clauses
S1–S5, validity rules, producer (`g6-sharded-scan.ts` +
`g6-shard-server.ts`), grader (`g6-sharded-grade.ts`), rig class
(2 × DO `c-32-intel`, ams3 VPC), qualification (quartet + bidirectional
loaded leg + sink + the frontier-shape GRO steering calibration at ratio
≥ 1.8), per-rung `steer_stats` dumps, and every run rule are those of
`gate-g6-sharded.md` (sha256 `7368aa0708e2f390…`) unchanged. The grader and
producer files must be **byte-identical** to their state at that gate's
final candidate `0d8c99da…` — reviewers verify this; any drift beyond §3 is
a registration defect.

## 3. The registered change

Commit `944a1558` (on the candidate below): the emitter's tick body becomes
`runSlice()`, and a timer fire drains its backlog in bounded catch-up
passes (at most one full snapshot tick per fire, behindness judged from the
slice's own handoff stamp with no extra clock reads). Late slices are
emitted with their true lag on the histogram instead of being lost. The
falsifier flipped with the fix: the skip-14-firings test asserts
issued = due = 1500 where the defect measured 1416.

Over-emission is bounded by the schedule-index arithmetic, not by the
`totalSteadySlices` cap — that cap requires `dueAccounting`, which the
registered shard-server producer does not pass, so it is **dormant in this
gate** (it is live only in bench-g6-class producers). The real bound: each
slice index emits at most once (the window state advances once per
emission), and a catch-up pass is permitted only when the next slice's
deadline has already elapsed — so emitted slices never exceed
elapsed / sliceMs + 1, and the incorporated per-shard wallMs validity
(120 s ± 250 ms) caps any duty over-run at ~+0.21 %. S3 is a floor and S2's
denominator inflation is conservative, so no over-emit path flatters a
verdict. The paced lane (not registered here) shares the same catch-up.

Also on the candidate but **immaterial to this gate** (disclosed): the G2
port (latency-rtt suite, `load_client.rs` restoration, per-bin dead-code
allows in the shared `latency_probe.rs` — annotations only, no behavior),
operations documentation, and the g2-do preregistration. None touch the
g6 producer, grader, shard server, `mmo_client.rs`, or the native addon.

## 4. Expectation, stated before the run

At the 5000 rung the -01 shortfall was 1.2 %; the fix recovers missed
slices, so S3 is expected to clear. At 15000 (3.1 %) and 20000 (5.1 %) the
shortfall grew with load — if part of that growth is slice *execution* time
exceeding the 20 ms budget rather than missed firings, catch-up alone may
not close it and those rungs may still MISS on S3. Either way the verdict
is the answer; a MISS at the upper rungs with 5000 passing would localize
the residual to per-slice cost, a registered finding in itself — and a
**5000 MISS would refute the missed-firings attribution outright**, sending
the mechanism hunt back to the -01 stamp's drawing board rather than
licensing any threshold motion.
