# Deviation — `ticker-fanout/rate-250` retired by the D4 preflight

**Date:** 2026-09-09  
**Candidate:** `ab6126a3…` (staged `fanout-pilot-r1`, phase-b)  
**Plan:** `docs/superpowers/plans/2026-09-08-physical-budget-amendment.md` R6 (SHA `c98fdb39…`), unchanged; this note applies D3's own rule

## Discovery

The first D4 passes on the production lifecycle over the cable measured the
top ticker row on WebSocket:

| pass | main thread (mean over the 10 s window) | bound | result | receipt |
|---|---:|---:|---|---|
| ws rate-250 1× (250 ingress/s, 25,000 deliveries/s) | **0.468** core (process 0.654, relay timed spans 0.383) | 0.50 | PASS, conservation exact, 0 faults | `preflight/ab6126a3…/ws-ticker-fanout_rate-250-1x.json` SHA `9e58570f…` |
| ws rate-250 2× (500 ingress/s, 50,000 deliveries/s) | **0.936** core (process 1.051, per-second max 1.008, relay timed spans 0.855) | 0.80 | FAIL: `DRAIN_DEADLINE_EXCEEDED`, 148 of 5,000 offered frames unacknowledged; origin-window series incomplete | `preflight/ab6126a3…/ws-ticker-fanout_rate-250-2x.json` SHA `a4845673…` |

The production path costs roughly twice what the review-time harness
measured (the R2/R3 Critic's combined harness read 0.75–0.78 at the same
2× point on WebTransport): the harness drove the relay without the
production control loop, the eight worker children's acknowledgements,
the rig supervisor's CPU sampling and the settler as spawned by
`server.ts`. The measurement is what D4 exists to take.

## Resolution

D3: "If a D4 reading exceeds 0.50 at 1× or 0.80 at 2×, the row is retired
and the next row down becomes the top of its ladder, without a new review
of this amendment (the rule, not the row, is what the reviewers approve)."

- `ticker-fanout/rate-250` is retired (refused as unknown, never aliased).
- `ticker-fanout/rate-25` (25 ingress/s × 10 s = 250 ingress, 25,000
  deliveries, 2,500 deliveries/s) is added at the bottom so the ladder keeps
  three rungs — 25 / 50 / 100 — and B6 keeps six cells, 60 seals, 12 flats
  and 6 pairs as frozen in section 9.7.
- `ticker-fanout/rate-100` becomes the top ticker row: the B5 pilot cell
  (section 9.6 `CELLS`), and the ticker topology D4 measures.
- The conformance test that reads D3's table from the amendment applies the
  retirements and additions recorded in this file's table below, so the
  amendment bytes stay as approved and the code still has one source.

| action | cell id | label | pub | workers | subs | sessions | window | ingress | deliveries | bytes | readinessDeadlineMs |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| retire | `ticker-fanout/rate-250` | ticker 250 | | | | | | | | | |
| add | `ticker-fanout/rate-25` | ticker 25 | 1 | 8 | 100 | 101 | 10 s | 250 | 25,000 | 100 | 30,000 |

The chat ladder is unchanged by this note; its top row is measured by the
same preflight before the stage that follows.
