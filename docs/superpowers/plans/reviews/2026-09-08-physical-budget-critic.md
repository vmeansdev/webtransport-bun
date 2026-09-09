CHANGES REQUIRED

# Critic review — physical-budget amendment (compact delivery frames, hardware-derived cells)

Reviewer: Claude (Critic pass), 2026-09-08. Git read-only (`git status --porcelain | grep -v '^??' | wc -l` → 0 before and after); no campaign, stage or controller started; nothing under `.release-evidence/`, `/var/db/webtransport-bun`, `/usr/local/libexec/webtransport-bun`, the rig stage dirs or keys touched. Rig access was read-only ssh plus scratch benchmarks under `/tmp/amendment-review-critic/` (relay bench, one WT cell, one WSS cell on port 4571 with a throwaway P-256 cert), deleted afterwards (`ls -d /tmp/amendment-review-* ; pgrep -af amendment-review` → empty, `RIG_SCRATCH_DELETED`). Raw outputs of my runs are kept in this session's scratchpad (`…/scratchpad/raw/{relay/*.jsonl, wt-n128-m100-critic1-*, wss-n128-m100-critic1-*}`); every number below names its file or command.

## Bindings

- Amendment SHA-256: `bfd38e0474c27cc153c96bb9ee06a91f4292b4d922c725b49baca331f95892a3` (`shasum -a 256 docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, 111 lines)
- Base plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Cohort completion amendment SHA-256: `90d469cb0c54e8e4e34a7edb333156b365d73464099e1d7eb49189234a55e7e1`
- Architect artifact SHA-256: `988c594878f7782652228c5c9fd499ef96808ccb99a3e311092240142a1345e2` (re-verified, not trusted; see §B)
- Candidate HEAD: `efaed8bb0af82a499ca58b2627ea251efced41c5`
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`

## Verdict in one paragraph

D1's numbers reproduce from the raw files (§A). D3's rows do **not** survive contact with the two costs D1 left out and the amendment itself flags as risks: the relay's per-delivery cost is not a constant — it grows with subscriber count because every `pump()` round re-filters and re-sorts every session with `localeCompare` and drains every session's control queue (`fanout-relay.ts:1341-1342, 1721-1743`), and a 5,000-subscriber expansion takes ~20 rounds of 256 writes — and the WT egress costs ~7 µs of the relay's **own JS thread** per stream write. Measured on the rig with the unmodified `FanoutRelay` and the amendment's own compact codec: 245k deliveries/s at 100 subscribers (D1 reproduced), **200.7k at 1,000, 129.0k at 2,500, 71.4k at 5,000** (free-encoder floor at 5,000: 78.7k). Adding the measured send cost, the chat-5k row at 50,000/s has 1.33× margin on WS and **0.95× on WT** — it cannot be sustained — and ticker rate-500 on WT is 1.8×, so the D4 gate's 2× bar (100,000/s on WT) is unreachable on two of the six rows: the amendment's own preflight refutes its own table. Separately, the evidence claim behind D2 ("fault … counted before any delivery counter moves", "must fail closed") has no sink at HEAD: the worker connector drops undecodable frames silently and the verifier never reads a worker-side counter. The architect's four blocking findings are all confirmed by execution. Fixes are a per-topology budget (or a relay/egress change that is then re-measured), a WT-specific egress decision, a worker/verifier fault path, and a preflight definition that cannot pass vacuously.

## A. D1 recomputed from the raw files (all reproduce)

`python3` over `.scratch/2026-09-08-physical-budget/…`:

| D1 claim | Recomputed | Source |
|---|---|---|
| Cable 940.7 Mbit/s | receiver 940.83 / 941.18 / 940.22, mean **940.74**, stdev 0.49 | `link-and-transport/raw/iperf3-run{1,2,3}.json` |
| WS link-bound 889k/716k/575k | wss M=100 sums **889,625 / 715,578 / 575,409** (formula 890,814 / 716,997 / 576,409) | `raw/wss-n{128,160,200}-m100-r*-client*.json` |
| WT as-written ~33k/session, ~140k across sessions, 3.2–4.6 cores | M=1 31,841 / 33,522; M=100 **142,882** (137,163–151,964) / 129,353 (118,073 min); rig 4.36–4.71 cores | `raw/wt-n{128,160}-m{1,100}-rasis*` |
| Relay JSON 47.8k / compact 245k / free 348k | medians **47,785 / 245,377 / 348,257** (n=5, warmup excluded) | `relay-cpu-and-encoding/results/rig/rig-relay-{json,compact,zero}.jsonl` |
| Frame 654/658 B; compact encode 2.6M, with digest 0.54M; decode 4.2M | 654/658; 2,628,403; 536,895; 4,245,784 | `rig-json.jsonl`, `rig-compact.jsonl` |
| WT 104 KB/session, accept 480–800/s unthrottled; WS 1.45 KB | tables §2/2b of the sessions report (n=2–3 per K) | `sessions-fds-memory/REPORT.md` |

My own rig runs this review reproduce the two anchors: relay compact K=100 **245,114/s** (`raw/relay/k100-compact.jsonl`, n=5, MAD 4 %); WT as-written n128 M=100 **140,680 frames/s** at 4.48 rig cores (`raw/wt-n128-m100-critic1-*`); WSS n128 M=100 **889,444 msg/s** at 0.82 cores.

## B. Architect findings re-verified by execution

| # | Claim | Verified by | Result |
|---|---|---|---|
| 1 | WT egress routes by JSON `kind`, throws on non-JSON | `sed -n 826,834p; 865,915p; 1063,1071p tools/compare/server.ts` | **Confirmed.** `relayFrameRoutingFields` `JSON.parse`s every outbound body; `0xC1` throws inside `pump()`; `delivery-context` would ride the control bidi stream, unordered against the uni stream. Slice 2 must own `server.ts`. Added cost dimension in finding 2 below. |
| 2 | D3 keeps two of "the old six ids" it retires | `grep -n 'subscribers-1000\|subscribers-5000\|old six' …amendment.md` | **Confirmed.** |
| 3 | Mirror list omits the id constructors | `git grep -nE 'rate-\$\{|subscribers-\$\{|ingressRatePerSecond' -- tools \| grep -v test` → `scenario-registry.ts:239, 257, 270`, `types.ts:30`, `client.ts:1442, 1470`; `PHASE4_GATE_CELLS` `compare-controller.ts:275-278` (used at `:3943`); label switch `:6874-6889`; `CohortCellId` `cohort-protocol.ts:5596-5602`, `COHORT_CELL_GRANT_PARAMETERS` `:5713-5721` | **Confirmed**; 34 tracked source files name an old id outside plans and evidence (`git grep -lE … \| wc -l`). |
| 4 | B6 timeout omits the arms; no literal | `cat tools/compare/bin/frozen-run-section-9.7.fragment.sh; sed -n 1087,1091p tools/compare/bin/stage-live-campaign.ts` | **Confirmed.** Correction to the architect's aside: 9.6 `RUN_TIMEOUT_MS` is `2_100_000` = CAMPAIGN + 300,000 (9.5: +600,000; only 9.7 is +1,800,000). |

Non-blocking architect items 5–12 are correct as far as I checked them (5 is promoted to blocking here — finding 2; 8, 9, 11 stand).

## C. What I measured on the rig this pass (scratch, deleted)

**C1. Relay cost vs subscriber count.** `bench-relay-k.ts` = the scratch `bench-relay.ts` with `SUBSCRIBER_COUNT`/publishers/`messageBytes`/windows from env and the production settler emulated (after each ingress, `pump()` until `counters().queuedItems === 0`, which is what `createRelaySettler` does per `setImmediate`, `server.ts:629-656`). Unmodified `FanoutRelay` from the scratch tree (byte-identical closure of HEAD), counting sink, 5 measured runs after one warmup, `Bun.gc(true)` per run, rig idle (load 0.01 before, 0.82 after). Files `raw/relay/k*-*.jsonl`.

| Topology | Mode | Deliveries/s median (min–max) | µs/delivery | Pump rounds per ingress |
|---|---|---:|---:|---:|
| 1 pub + 100 subs, 100 B, 10 w (ticker) | compact | **245,114** (232,956–254,815) | 4.08 | 1 |
| 10 + 1,000, 128 B, 30 w (chat 1k) | compact | **200,696** (179,492–209,090) | 4.98 | 3 |
| 10 + 2,500 (chat 2.5k) | compact | **128,999** (126,861–132,588) | 7.75 | 9 |
| 10 + 5,000 (chat 5k) | compact | **71,361** (70,057–71,503; MAD 0.2 %) | **14.01** | 19 |
| 10 + 5,000 | zero-cost encode | **78,657** (74,345–83,349) | 12.71 | 19 |
| 10 + 1,000 | JSON (today) | 55,849 | 17.9 | 3 |

Reading: at 5,000 subscribers 91 % of the per-delivery cost is bookkeeping, not encoding — each of the ~19 rounds per ingress costs ~3.5 ms: `activeSessions()` (filter over 5,010), `drainControl` × 5,010, `registeredSubscribers()` (filter + `localeCompare` sort of 5,000), `pumpStartIndex` (`findIndex` with `localeCompare`), then ≤ 256 writes (`fanout-relay.ts:1339-1391, 1721-1743`). D1 measured only the 100-subscriber shape and the amendment applied its 4.08 µs to every row.

**C2. Socket send cost on the relay's thread.** The link agent's harness (`rig/{ws,wt}-server.ts`, `mac/{ws,wt}-client.ts`, unchanged; my own end-entity cert) with `/proc/<pid>/task/<pid>/stat` sampled every second (`thread-sampler.sh`):

| Cell | Received | Rig process | **Main thread** | Per call on the loop |
|---|---:|---:|---:|---:|
| WT as-written n128 M=100 (one `writable.write` per frame) | 140,680 frames/s | 4.48 cores | **0.97 core (saturated)** | **~7.0 µs** |
| WSS n128 M=100 (`session.send` per message) | 889,444 msg/s | 0.82 cores | 0.87–0.90 core | **~1.0 µs** |

So the "~140k/s" WT ceiling in D1 is the relay's JS thread, not the link and not the NIC: 30 % of the WT write cost lands on the one thread the relay also needs for its bookkeeping. The Mac WT client burned 54.8 cpu-s over ~13 s (≈4.2 cores, ~30 µs per frame across its threads); at 50k/s that is ≈1.5 cores spread over 8 workers — not the limiter, but it is the same order as the rig's 4.5 cores at 140k.

**C3. Rows against relay(K) + send(transport).** Additive estimate (the two components were measured separately; D4 is where they meet). Margin = ceiling ÷ declared rate.

| Row | Rate | Relay µs | WS ceiling / margin | WT ceiling / margin | Amendment's claim |
|---|---:|---:|---:|---:|---|
| ticker rate-100 | 10,000 | 4.08 | 197k / 19.7× | 90k / 9.0× | 8.8× / 2.8× / 4.9× |
| ticker rate-250 | 25,000 | 4.08 | 197k / 7.9× | 90k / 3.6× | |
| **ticker rate-500** | 50,000 | 4.08 | 197k / 3.9× | **90k / 1.8×** | WT 2.8×, relay 4.9× |
| chat 1k | 10,000 | 4.98 | 167k / 16.7× | 84k / 8.4× | |
| chat 2.5k | 25,000 | 7.75 | 114k / 4.6× | 68k / 2.7× | |
| **chat 5k** | 50,000 | 14.01 | **67k / 1.33×** | **48k / 0.95×** | relay 4.9× |

If slice 2 leaves the `JSON.parse` route in place on WT (architect 1), add 18 µs (`server.ts:848-856` comment): rate-500 WT → 1/(4.08+7+18) = 34k/s, below the row.

## Blocking findings

### 1. BLOCKING — the budget rule `deliveries/s ≤ 50,000` is not a sufficient condition; the relay's cost scales with subscriber count and the chat-5k row does not fit

D1 states one relay number (245k/s, 4.08 µs) and D3 applies it to a 5,000-subscriber row. Measured (§C1): **71,361/s at 5,000 subscribers**, floor 78,657/s with a free encoder. Chat 5k at 50,000/s: 1.43× relay-only, 1.33× with `ws.send`, **0.95× with the WT write** — the WT arm cannot deliver the row's own declared rate, so its loop saturates, per-subscriber queues (64 items, `fanout-relay.ts:108`) fill, `SUBSCRIBER_QUEUE_FULL` closes sessions and the arm seals non-promotable; B6 (60/60 promotable) cannot pass. The rule must be per-topology: `1/(relay_us(K) + send_us(transport)) ≥ 2 × rate`, with `relay_us(K)` measured at each K in the table (my numbers can seed it). Either the chat ladder tops at 2.5k (25k/s: 4.6× WS, 2.7× WT) or the relay's per-round O(K·log K) work is removed in a slice (cache the sorted subscriber/active arrays and invalidate on register/close; drain control only for sessions with a non-empty control queue) **and re-measured before the rows are frozen** — a product change to the engine under test, which the exact-stage reviews must then see. Commands: `BENCH_SUBSCRIBERS=5000 BENCH_PUBLISHERS=10 BENCH_MESSAGE_BYTES=128 BENCH_WINDOWS=30 BENCH_MODE=compact bun bench/bench-relay-k.ts` (scratchpad `relay-bench/`), `sed -n 1339,1345p; 1721,1743p tools/compare/scenarios/fanout-relay.ts`.

### 2. BLOCKING — WT-as-written egress costs ~7 µs of the relay's own thread per delivery; rate-500's WT margin is 1.8×, and D4's 2× bar is unreachable on two rows

§C2: 140,680 writes/s with the main thread at 0.97 core. rate-500 on WT: 1/(4.08 + 7.0) = **90k/s = 1.8×**, not the "2.8× against the measured 140k" D1 quotes (that figure treats the 140k as available to the relay, but the relay must pay both). D4 requires ≥ 100,000 achieved deliveries/s on WT for rate-500 and chat-5k with the production relay and egress: **90k and 48k are what the hardware gives**, so the gate fails by the amendment's own numbers and its only remedy ("return to D1 … never to a smaller margin") returns to this finding. Decide now, in the amendment: (a) WT egress coalescing in slice 2 (the link report shows ≥ 1.2 KB writes reach the link at ~4 rig cores; this changes `trySend`/would-block semantics and the busyMs charge — a design item, not a footnote), or (b) top rows bounded by the WT-as-written budget (rate-250 / chat-2.5k) with the WS arm measured at the same rows, or (c) a per-transport preflight bar. "Out of scope here" (D1 last sentence) is not compatible with rows that need it. Command: `run-cell-critic.sh wt 128 100` (scratchpad), `raw/wt-n128-m100-critic1-threads.jsonl`.

### 3. BLOCKING — D2's fault semantics have no sink at HEAD: tag/format mismatches are silently dropped and no worker-side counter reaches the verifier

- WS connector: `tools/compare/bin/fanout-role.ts:2196-2197` — `const decoded = decodeFanoutWsMessage(bytes); if (decoded.ok) session.onFrame(decoded.value);` — a refused frame is discarded. WT: `:2252-2255`, same. `WorkerWindowBook.recordMalformed()` (`:937`) is never called from consumption (`grep -n recordMalformed tools/compare/bin/fanout-role.ts` → definition only).
- Verifier: `verify-artifact.ts:4124-4149` reads `linux.value.{duplicate,reordered,queueDrop,writeTimeout,disconnect,malformed}…` only; `WorkerPartialV1.{malformedCount,duplicateCount,reorderCount,perSubscriberDelivered}` are shape-checked (`cohort-protocol.ts:4157-4180`) and never compared (`grep -n 'malformedCount\|perSubscriberDelivered' tools/compare/verify-artifact.ts` → none). Base plan §4.5 says promotion requires "every duplicate/reorder/drop/timeout/disconnect/malformed counter zero … every per-subscriber delivered count equal accepted ingress" — at HEAD only the Linux half is enforced.

Consequence: a compact frame with a wrong `contextTag`, a JSON data frame from an old relay, or a relay that routes subscriber X's frames down Y's socket produces `D < L` and a **non-promotable PASS**, not a failure; the amendment's "fault on that session, counted before any delivery counter moves" and "a mixed-version relay/worker pair must fail closed" are both false unless specified. Required: (i) the connector hands decode refusals to the session (`onMalformed`) and the book counts them; (ii) `DELIVERY_CONTEXT_MISMATCH`/tag mismatch makes the worker child return a closed failure code (the child's FAIL is what the controller can see: `remote-supervisor.ts` `CHILD_LIFECYCLE`/`UNEXPECTED_EOF` path), not a counter; (iii) slice 4 makes `verify-artifact.ts` refuse promotion on any non-zero worker counter and on `perSubscriberDelivered[i] ≠ acceptedIngress`, with a mutation test; (iv) state explicitly that `recordDelivery` is keyed by the **session's** roleId and `subscriberIndex` is a check against it, never the key.

### 4. BLOCKING — D4 as written can pass vacuously; define what "achieved ≥ 2×" measures

A relay cannot "achieve" more than it is offered, so the gate must **offer** 2× the row's ingress rate (1,000/s ticker; 20/s × 10 publishers chat) for the **full window** (10 s / 30 s) and require conservation `D = A × K` **counted on the Mac side by the production worker consumption in 8 processes**, not `relayWritesCompleted` (a WT `writable.write` returning `true` is buffered, not delivered) and not an in-process sink. A pump-until-empty loop over an in-process relay is also "the production `FanoutRelay`"; the text must require the production settler path (`server.ts` `createRelaySettler`), the real WT connector on the Mac, and the real `cohortWtListenerAdmission` limits. The receipt should carry offered rate, achieved rate per window, max per-subscriber queue depth, `SUBSCRIBER_QUEUE_FULL`/write-timeout counts, and the relay's `onRelayWork` busy fraction. Without this a 3-second burst on 64-item queues passes and the paid campaign fails where the preflight said it would not.

### 5. BLOCKING — architect findings 1–4 (confirmed above); finding 1 also carries a budget

Repeat of §B for the record: `server.ts` routing by JSON `kind` must be replaced by magic-byte routing before any parse, the `delivery-context` must be declared a delivery-channel frame (first frame on the uni stream), the four retired ids must be named, the id constructors/unions/`PHASE4_GATE_CELLS`/readiness switch must be in slice 3 and the conformance test, and `CAMPAIGN_TIMEOUT_MS`/`RUN_TIMEOUT_MS` literals must be pinned (worst case 2 arms × 6 executions per cell recomputes to ≈ 2.9 h; `14,400,000` / `16,200,000` would hold the base plan's +1,800,000 pairing for 9.7).

## Non-blocking findings

### 6. Evidence strength of dropping the per-frame payload digest — no weakening found

`grep -rn payloadSha256 tools/compare crates/native/src | grep -v test` → the only consumers outside `fanout-wire.ts` are the bulk-payload path (`artifact-builder.ts:893`, `stats.ts:1213`, `evidence.ts:2835-2936`, `server.ts:511-549`); no seal, attestation, verifier or equation reads a delivery frame's digest. Today's per-frame check (`fanout-wire.ts:405-409`) is self-referential — digest and payload travel in the same frame from the same author — so it authenticates nothing the relay could not forge. §4.5's `DB = D × messageBytes` uses `config.payloadBytes` (`fanout-role.ts:1000-1003`), not the frame. **Forgery/collision:** the only author of bytes on a subscriber socket is the execution's server child (one server child per execution: `compare-controller.ts:2028, 4838`, TLS/QUIC pinned to the staged cert), which already knows both digests; a 32-bit tag adds a check the worker does not perform today (it never compares `cohortGrantSha256`/`cohortStartBarrierSha256` on data frames — `consumeWorkerFrame`, `:1435-1462`). A stale frame from a previous execution collides with probability 2⁻³² and cannot exist on a fresh per-execution socket. The `delivery-context` is unsigned and binds only to digests the worker already holds — acceptable because it authorises nothing; the worker must ignore its `publisherIds[]` in favour of `grant.publishers[]`. The binding is unobservable offline (nothing seals `deliveryContextSha256`); if the lead wants the binding in evidence, the worker partial would have to carry it, which is a §4.4 shape change the amendment currently forswears.

### 7. Discrimination (question c) — say what B6 can and cannot claim

Promotion requires `D_origin[w] = L_origin[w] = A_origin[w] × K` in every window (`verify-artifact.ts:4124-4149`) and the publisher paces at exactly the row's rate, so any promoted arm's `series.samples` **is the declared rate by construction**; the delivered-updates-per-second metric cannot separate WS from WT on a passing pair. What discriminates is the attested `busyMs` (the base plan's stated purpose) and pass/fail itself at the top rows. B6 will be able to claim "both transports complete X deliveries/s at topology T; the relay's attested busy time was Y (WS) vs Z (WT)" — a CPU-accounting comparison at equal work — not a throughput ranking. The amendment should say so, and the render clause (D6) should print busyMs beside the totals.

### 8. Chat 5k on WT (question d) — readiness and memory pass; the loop budget is what fails

5,010 sessions ÷ 500/s = 10.0 s nominal; at the measured unthrottled WT floor of 480/s it is 10.4 s; `readinessDeadlineMs` 180,000 → 17× time headroom (the "1.2–1.6×" is rate headroom above the grant's fixed 500/s, which the ramp cannot exceed anyway). Rig RSS 5,010 × 104 KB = 521 MB (measured 582 MB at K=5,000 incl. baseline) against MemAvailable 6,772 MB now (`free -m`), PSI 0; the 3.4 GB of swap is other residents. Mac 8 × 626 × 250 KB ≈ 1.25 GB. Handshake p99 0.6–0.95 s under ramp fits. Pass — but the row still fails on finding 1.

### 9. Per-subscriber queue tolerance at rate-500 is 128 ms

64 items at 500 ingress/s = 128 ms of backlog before `SUBSCRIBER_QUEUE_FULL` (`fanout-relay.ts:108, 1296-1306`); a single Mac GC pause or WT drain stall longer than that in any of 50 windows × 2 arms × 6 cells makes B6 non-promotable. D4's receipt should record the max queue depth reached; consider whether the row (not the cap — plan line 123 froze it) should leave more slack.

### 10. Small items

- `estimateDeliveryBytes` (`fanout-relay.ts:1711-1719`) canonicalises a JSON probe per ingress for the global-cap estimate; with 124 B frames it over-estimates 5× (harmless) — slice 2 should size it from the compact frame.
- Worker warmup counting is `frame.kind === "warmup-data"` (`fanout-role.ts:1365`); a compact warmup frame carries no kind — slice 2 must phase on the tag.
- 9.6 wall at rate-500 is unchanged (≈ 5 min); `EXPECTED_*` literals consistent.
- Architect 8, 9, 11 (exact keys of both contexts incl. `warmupNonce`; which closed vocabulary `DELIVERY_CONTEXT_MISMATCH` joins and its Rust mirror; orphaned 300,000 readiness member) still apply.

## Two-perspective note

- Perfectionist: the amendment's headline — "measurement has to always respect physical constraints" — is violated by its own table: two rows were derived from a relay number measured at a different topology and a WT number that double-counts the relay's thread. Freezing those rows into every grant's `approvedPlanSha256` and then discovering it at D4 costs a stage cycle; discovering it at B6 costs 12 hours and two keys.
- Pragmatist: the compact frame, the delivery-context binding and the 50k ticker ceiling on WS are sound and measured; the fix is one more measurement column (relay µs per K, send µs per transport) and a decision about WT egress. The rig work above took 20 minutes; the rows can be re-derived in an afternoon.
