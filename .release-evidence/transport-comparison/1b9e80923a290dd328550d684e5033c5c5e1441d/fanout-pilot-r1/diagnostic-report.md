# Diagnostic campaign report

NON-PROMOTABLE PILOT EVIDENCE

- Campaign ID: `fanout-pilot-r1`
- Candidate: `1b9e80923a290dd328550d684e5033c5c5e1441d`
- Execution purpose: `pilot` (workload pilot)
- Index stage: `full`
- Flats: none required (sealed-index diagnostic; allowNonPromotable=true)
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window

NOT A CANONICAL FANOUT RESULT: 0/6 paired promotions from 2/60 measured PASS seals.

## Indexed measured arms

| Cell | Arm | Transport | Status | Promotable | Attestation | Sealed path | p50 |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | ---: |
| `ticker-fanout/rate-100` | `ticker-fanout/rate-100/ws` | ws | PASS | false | attested | /Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison/.release-evidence/transport-comparison/1b9e80923a290dd328550d684e5033c5c5e1441d/fanout-pilot-r1/reps/ticker-fanout_rate-100/ws/rep-1.sealed.json | 10000 |
| `ticker-fanout/rate-100` | `ticker-fanout/rate-100/wt` | wt | PASS | false | attested | /Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison/.release-evidence/transport-comparison/1b9e80923a290dd328550d684e5033c5c5e1441d/fanout-pilot-r1/reps/ticker-fanout_rate-100/wt/rep-1.sealed.json | 10000 |

## Per-arm accounting

### `ticker-fanout/rate-100/ws` (ws, attested)

- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 1000, accepted ingress 1000, relay writes 100000, delivered 100000, delivered bytes 10000000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 1932 ms (18.8% of the 10259 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 2680 ms (26.1% of the 10266 ms window)
- Server-child process CPU (rig-read utime+stime): 4650 ms (45.3% of the 10266 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### `ticker-fanout/rate-100/wt` (wt, attested)

- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 1000, accepted ingress 1000, relay writes 100000, delivered 100000, delivered bytes 10000000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 1511 ms (14.7% of the 10256 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 2660 ms (25.9% of the 10268 ms window)
- Server-child process CPU (rig-read utime+stime): 10820 ms (105.4% of the 10268 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

Source: `campaign-index.json` sealed paths under this campaign root. No promoted flats.
