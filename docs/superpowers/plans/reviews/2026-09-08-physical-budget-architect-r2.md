CHANGES REQUIRED

# Architect review R2 — physical-budget amendment (compact delivery frames, hardware-derived cells)

Reviewer: Claude (Architect pass, revision R2), 2026-09-08. Git read-only; no tracked file edited (`git status --porcelain | grep -v '^??' | wc -l` → 0 before and after); no campaign, stage or controller started; nothing under `.release-evidence/`, `/var/db/webtransport-bun`, `/usr/local/libexec/webtransport-bun`, the rig stage dirs or keys touched. Rig access: one read-only ssh (`cat /sys/class/net/eno1/speed` → 1000; `free -m` MemAvailable 6,803 MB, swap 3,410 MB used; load 0.03; `ls /tmp | grep -c amendment-review` → 0). No scratch was created on the rig this pass: every number I needed either lives in the repo's raw files or in the R1 Critic's raw outputs, which are in this session's scratchpad (`…/scratchpad/raw/{relay/k*-*.jsonl, wt-n128-m100-critic1-*, wss-n128-m100-critic1-*}`), and I recomputed from those files rather than re-running.

## Bindings

- Amendment SHA-256: `2c982d544a2f3ebab999aff0d6da5cfc54b123398b2aca36cc2acb98de935066` (`shasum -a 256 docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, 138 lines, revision R2)
- Base plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Candidate HEAD: `efaed8bb0af82a499ca58b2627ea251efced41c5`
- R1 artifacts read: `reviews/2026-09-08-physical-budget-architect.md`, `reviews/2026-09-08-physical-budget-critic.md`
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`

## Verdict in one paragraph

R2 closes 20 of the 22 R1 findings outright, and the arithmetic is now right: every D1 number reproduces from a raw file including the per-K relay and per-transport send columns (section A), every D3 row clears the 2.5× rule on both transports with the margins printed (section B, smallest 2.7× on WT chat 2.5k), the compact frame binds every field the worker and §4.5 consume (section C), the mirror list is complete to within one help-text line (section E), and the B5/B6 literals hold with a corrected worst case (section F). Two things block. First, the fail-closed path D2 promises does not reach the controller as specified: the worker child has no frame that carries a failure code upward — at HEAD it prints the code to stderr and exits 1 (`fanout-role.ts:2340-2345`), the supervisor turns that into `UNEXPECTED_EOF` (`remote-supervisor.ts:8739`), and the controller's terminal record derives its `failureCode` from a third hardcoded list (`compare-controller.ts:1431-1455`) that no `satisfies` clause forces to be complete; there is also no "existing cross-language vocabulary test" — TS pins 18 and Rust pins 21 independently and nothing compares them. Second, the WT delivery channel as written does not exist when the warmup context must be sent: the uni stream is opened lazily by the first delivery-routed `trySend` (`server.ts:1038-1059`), so with "trySend/would-block semantics unchanged" the context takes the backlog path, and that path re-parses every pending session's context on every pump — K²/2 JSON parses plus K sorts of K at the warmup open: ≈25 s of relay thread at chat 2.5k against a 3.2 s per-subscriber warmup queue and a 5 s write deadline. D2 also names the wrong routing byte for WT (`{` never occurs first at the routing site; WT bytes carry a u32 prefix). Both are paragraphs, not redesigns.

## R1 findings closure

Architect R1 (1–12):

| # | R1 finding | Status | Evidence |
|---|---|---|---|
| 1 | WT stream for the delivery-context unstated; egress throws on non-JSON | **CLOSED as a decision, reopened as new finding 2** | D2 "Delivery-channel framing" declares the context a delivery-channel frame, first on the uni stream, routed by first byte before any parse, `isRelayDeliveryFrame` extended, verified at consumption in inbox order, compact-before-context refused. But the byte named for WT is wrong and the stream does not exist at emission time — finding 2 below. |
| 2 | D3 kept and retired `subscribers-1000/-5000` | CLOSED | D3: "Retired ids … `rate-10000`, `rate-50000`, `rate-100000`, `chat-fanout/subscribers-5000`, `subscribers-10000`"; `subscribers-1000` keeps its id. `grep -n 'Retired ids' …amendment.md`. Note the retired set is now five (chat 5k was dropped by the R1 Critic's finding 1), and the D3 rows use none of them. |
| 3 | Mirror list omitted the id constructors and unions | CLOSED (one omission, finding 7) | D3 lists `scenario-registry.ts:228/:256-270/:514-519`, `types.ts:30`, `client.ts:1442,1470`, `:6874-6889`, `PHASE4_GATE_CELLS`, the label union `:5596-5602`, `:5713-5721`. Execution: `git grep -nE 'rate-(10000|50000|100000)|subscribers-(5000|10000)' -- tools crates ':!*.test.ts' ':!crates/native/tests'` → every hit is in D3's list except `bin/compare-controller.ts:4096` (help text). |
| 4 | B6 timeout: arms omitted, no literal, second mirror unnamed | CLOSED (arithmetic slip, finding 4) | D5 pins `CAMPAIGN_TIMEOUT_MS=14,400,000`, `RUN_TIMEOUT_MS=16,200,000`, names `stage-live-campaign.ts:1091`, counts 12 executions per cell. Recomputed worst case is 9,432 s (2.62 h), not the 8,712 s stated — the literal still holds. |
| 5 | D4 2× bar unreachable at the top rows; no fallback | CLOSED | Rows bounded by WT-as-written (option b); rate-500 and chat 5k out; fallback text "a new measurement or a smaller row — never to a smaller margin". At the new top rows the WT ceiling is 1.81× (rate-250) and 1.36× (chat 2.5k) of the 2×-offered preflight rate — section B. |
| 6 | Margins quoted for the ticker frame only | CLOSED | Per-row WS/WT ceiling and margin columns in D3; all reproduce (section B). |
| 7 | Payload bit-rate line | CLOSED (label, finding 9) | D1: "at 25,000 deliveries/s … 25.6 Mbit/s (ticker) / 31.2 Mbit/s (chat) before framing". Those are the compact frame plus the 4 B WS header (128/156 B), not the payload (100/128 B → 20.0/25.6). |
| 8 | Exact keys of both contexts, `warmupNonce`, verification point, LE tag | CLOSED | D2 gives both key sets (warmup binds `cohortWarmupEpochSha256` + `warmupNonce`), the preimage rule, "first 4 LE bytes", "verifies at consumption, in inbox order". One parser convention to state — finding 6. |
| 9 | Name the vocabulary each new code joins; `EXPECTED_TOTALS_MISMATCH` as an index refusal | **PARTIALLY CLOSED** | Vocabulary named (`CampaignFailureCode` + `secure_fs.rs` mirror); `EXPECTED_TOTALS_MISMATCH` correctly placed in `verify-campaign-index.ts` (its refusal style is local `{ok:false, code, message}`, `:207-262`). But "pinned by the existing cross-language vocabulary test" names a test that does not exist, and the path has no carrier — finding 1. |
| 10 | D1 wording (113.6 B) | CLOSED | D1: "at any frame ≥113.6 B before margin (940.7e6/8/1e6 − 4)"; recomputed 113.59. |
| 11 | Orphaned readiness member; file paths | CLOSED | `READINESS_DEADLINE_MS_CHAT_10K = 300_000` removed from `READINESS_DEADLINE_MS_VALUES` "and its Rust mirror" (the Rust mirror is the `COHORT_CELLS` row at `secure_fs.rs:19649`; there is no separate Rust set — `grep -n READINESS secure_fs.rs` → none); D6 paths are `tools/compare/bin/…`. |
| 12 | Historical evidence with retired ids | CLOSED | D3 last sentence + deviation file `2026-09-08-retired-cell-ids-in-history.md` in D6. |

Critic R1 (1–10):

| # | R1 finding | Status | Evidence |
|---|---|---|---|
| 1 | Budget rule not per-topology; chat 5k does not fit | CLOSED | D1 per-K row, `ceiling(K,t)` with linear interpolation, 2.5× rule on both transports; chat 5k retired. My recompute from the Critic's own raw files: 245,114 / 200,696 / 128,999 / 71,361 (zero-encoder 78,657) — identical (section A). |
| 2 | WT write costs ~7 µs of the relay thread; D4 bar unreachable | CLOSED | D1 "Send cost on the relay's own thread" row (recomputed 6.85 µs WT, 0.97 µs WS from the sampler files); option (b) chosen; rate-500 out. |
| 3 | D2 fault semantics have no sink | **PARTIALLY CLOSED** | (i) `onMalformed` + `recordMalformed` — D2 fail-closed 1; (iii) verifier worker-counter and `perSubscriberDelivered` refusals with mutation tests — D2 fail-closed 3 (`verify-artifact.ts:4124-4149` confirmed Linux-only at HEAD, `grep -n 'malformedCount\|perSubscriberDelivered' verify-artifact.ts` → none); (iv) book keyed by the session's roleId — stated. (ii) child exit with a closed code that the controller sees — stated but not implementable as written: finding 1. |
| 4 | D4 can pass vacuously | CLOSED | D4: offer 2× for the full window, production settler path, real WT connector and `cohortWtListenerAdmission`, `D = A × K` counted by the workers, zero `SUBSCRIBER_QUEUE_FULL`/write-timeout, receipt with offered/achieved per window, max queue depth, busy fraction, RSS, NOFILE. Gap: the warmup epoch is not named as in scope — finding 2 makes it necessary. |
| 5 | Architect 1–4 confirmed | as above | |
| 6 | Dropping the per-frame digest weakens nothing | CLOSED | D2 "Why no per-frame payload digest" restates the §6 reasoning; the worker ignores the context's `publisherIds` in favour of its own facts by construction ("recomputes the digest from its own admission facts"). |
| 7 | Say what B6 can claim | CLOSED | D5 "Claim boundary"; D6 render prints attested busy figures beside totals. |
| 8 | Chat 5k on WT: readiness/memory pass, loop fails | CLOSED | Row removed; chat 2.5k: 2,510 sessions → 5.0 s ramp at 500/s vs 180,000 ms; 2,510 × 104 KB = 261 MB rig RSS vs 6.8 GB available now. |
| 9 | Queue tolerance at rate-500 is 128 ms | CLOSED | D3: 64/250 = 256 ms (rate-250), 64/10 = 6.4 s (chat) — recomputed, and the 64 KiB byte cap is not the binding one (64 × 152 B = 9.7 KB); D4 records the max depth. |
| 10 | Small items (`estimateDeliveryBytes`, warmup kind test, 9.6 wall, arch 8/9/11) | CLOSED | D2 fail-closed 4; D2 "replacing today's `frame.kind === "warmup-data"` test"; 9.6 unchanged; 8/11 closed above, 9 partial. |

## A. D1 traceability (recomputed)

| D1 claim | Recomputed | Raw file / command |
|---|---|---|
| Relay K=100 4.08 µs (245k), K=1,000 4.98 (201k), K=2,500 7.75 (129k), K=5,000 14.01 (71k); free-encoder floor 78.7k | medians of 5 non-warmup runs: **245,114 / 200,696 / 128,999 / 71,361**; zero 78,657; 1e6 ÷ each = 4.08 / 4.98 / 7.75 / 14.01 | `python3` over `scratchpad/raw/relay/k{100,1000,2500,5000}-compact.jsonl`, `k5000-zero.jsonl` (`deliveriesPerS`, `warmup:false`) |
| K=100 anchor from the budget agent | 245,377 (240,269–262,298); JSON 47,785; zero 348,257 | `.scratch/…/relay-cpu-and-encoding/results/rig/rig-relay-{compact,json,zero}.jsonl` |
| WT `writable.write` ~7.0 µs on the relay thread; WSS `session.send` ~1.0 µs | 4 clients sum **140,680** msg/s with main thread median **0.963** core (max 0.968) → 6.85 µs; WSS **889,444** msg/s at **0.867** core → 0.97 µs; process cores 4.6 (WT) / 0.87 (WSS) | `scratchpad/raw/{wt,wss}-n128-m100-critic1-client{0..3}.json` `window.msgsPerS`; `*-threads.jsonl` parsed by regex (values like `.86942` are not JSON) |
| Mac WT client ~30 µs/frame across threads | 54.76 cpu-s over a 10 s window at 140,680/s → 38.9 µs/frame summed over 4 clients (≈1.5 cores at 50k/s: 50,000 × 30 µs = 1.5 core-s/s) | same client files, `cpuS` |
| Per-round relay cost (basis of finding 2) | ms per `pump()` round, writes included: **1.66 (K=1,000), 2.15 (K=2,500), 3.69 (K=5,000)**; ≈0.4 ms of that is the ≤256–278 writes | `ns / pumpRounds` per run, same files |
| Cable, link-bound WS, frames 654/124/152 B, encode/decode, sessions, ports | not re-run this pass; R1 (both passes) reproduced them from the raw files and the rig link speed re-read today is still 1000 | `ssh … cat /sys/class/net/eno1/speed` |

## B. D3 rows recomputed (interpolation as D1 states; send 1.0 / 7.0 µs)

| Cell | K | Del/s | relay µs | WS ceiling / margin | WT ceiling / margin | 2.5× rule | WS link (frame+4 B) | D4 2×-offer vs WT ceiling | Queue tolerance |
|---|--:|--:|--:|--:|--:|---|--:|--:|--:|
| rate-50 | 100 | 5,000 | 4.08 | 196,850 / 39.4× | 90,253 / 18.1× | OK | 918,652 / 184× | 9.03× | 1.28 s |
| rate-100 | 100 | 10,000 | 4.08 | 196,850 / 19.7× | 90,253 / 9.0× | OK | 918,652 / 92× | 4.51× | 0.64 s |
| rate-250 | 100 | 25,000 | 4.08 | 196,850 / 7.9× | 90,253 / 3.6× | OK | 918,652 / 37× | 1.81× | 0.256 s |
| chat 500 | 500 | 5,000 | **4.48** (interpolated) | 182,482 / 36.5× | 87,108 / 17.4× | OK | 753,766 / 151× | 8.71× | 6.4 s |
| chat 1k | 1,000 | 10,000 | 4.98 | 167,224 / 16.7× | 83,472 / 8.3× | OK | 753,766 / 75× | 4.17× | 6.4 s |
| chat 2.5k | 2,500 | 25,000 | 7.75 | 114,286 / 4.6× | 67,797 / 2.7× | OK | 753,766 / 30× | 1.36× | 6.4 s |

- Every D3 margin reproduces (D3 prints WT chat 1k as 8.4×; exact 8.35×). The chat-500 row prints "≤4.98 / ≥167k / ≥84k" (the K=1,000 bound) where D1's rule says interpolate — finding 5.
- Readiness after removing 300,000: closed set {30,000, 90,000, 180,000}; every row's value is a member (ticker 30,000; chat 500/1k 90,000; chat 2.5k 180,000). Ramps 0.2 / 1.0 / 2.0 / 5.0 s at 500/s.
- Publisher pacing: `totalMessages = rate × duration` = 500 / 1,000 / 2,500 (ticker) and 10 × 30 = 300 (chat), all integers; `publisherRatePerSecond = measuredIngress / publisherCount / seconds` (`compare-controller.ts:4631-4634`) gives 50 / 100 / 250 / 1 / 1 / 1.
- Deliveries, sessions, bytes, expanded totals all recompute from the row; `expectedExpandedDeliveries = ingress × K` is what `verify-artifact.ts:3717-3722` compares.

## C. Compact frame and both delivery contexts against every consumer

Read at HEAD: `fanout-role.ts:925-1016` (`WorkerWindowBook`, `recordMalformed` :937, `recordDelivery` :948), `:1361-1370` (warmup kind test), `:1435-1462` (`consumeWorkerFrame`), `:1852-1858` (`drainOnce`), `:2196-2197`, `:2247-2256`; `fanout-wire.ts:304-308` (`exactKeys`), `:355-383` (`rejectEpochMixing`), `:734-770` (`DATA_KEYS`/`parseFanoutData`), `:1029-1130`; `fanout-relay.ts:1204-1245` (fanned object), `:1711-1719`.

- Consumed by the worker: `subscriberId` (from the session; cross-checked by `subscriberIndex` — bijective with the id, `subscriber-${ordinal padStart 6}`), `publisherId` (from `publisherIndex` into `grant.publishers[]`, which the grant carries — `cohort-protocol.ts:719`), `publisherSequence`, `windowIndex`, arrival time (local), `messageBytes` (cell constant checked against `payloadBytes`). Warmup-vs-measured by `contextTag`. Nothing the book or the §4.5 equations read is missing; `linuxAcceptedOrdinal` is carried and, as at HEAD, not verified by the worker. Every field is bound to something the worker holds or checks; the reserved u16 must be 0. **Complete.**
- Both key sets are exact and disjoint in their epoch-specific members (`cohortStartBarrierSha256` vs `cohortWarmupEpochSha256` + `warmupNonce`) and carry an explicit `epoch` — unambiguous. One convention to state: `rejectEpochMixing` (`fanout-wire.ts:371-372`) chooses the forbidden set by `kind.startsWith("warmup-")`; both contexts share `kind:"delivery-context"`, so a parser that reuses it would refuse the warmup context for carrying warmup fields. The delivery-context parser must key the forbidden set on `epoch` (finding 6).
- Tag collision between a session's two contexts is 2⁻³²; the worker should refuse the session when its warmup and measured tags coincide (finding 6).
- D2 fail-closed 1 says the book is keyed by the session's own roleId. At HEAD `consumeWorkerFrame` keys on `frame.subscriberId ?? ""` (`:1455`) and `drainOnce`'s callback receives `{frame, arrivedAtMacNs}` without the inbox's roleId (`:1852-1858`, inboxes are keyed by roleId at `:1200`). Implementable; slice 2 must thread the roleId (finding 8).

## D. WT delivery channel against `server.ts` as written

- Routing site: `sink.trySend` (`server.ts:1063-1071`) calls `relayFrameRoutingFields(bytes)` (`:865-915`), which first reads a u32-BE length prefix and requires `declared === byteLength − 4` (`:882-890`), then `JSON.parse`s the body. WT bytes from the relay are `encodeFanoutWtFrame` output, `u32be length || canonical JSON` (`fanout-wire.ts:1073-1083`). So at this site the first byte of every JSON frame is the prefix's MSB (0x00 for any frame under the caps), never `{`. D2's "`{` → the existing JSON routing" is true on WS (raw message bytes) and false on WT. The discriminator on WT is `0xC1` vs a length-prefixed frame; a prefix whose MSB is 0xC1 would declare ≥3.2 GB and is refused by every cap, so the two are unambiguous. **Implementable, but the amendment names the wrong byte** (finding 2a).
- Mac side: both the control bidi stream and the uni stream are read through `LengthPrefixedFrameReader` (`adapters/wt.ts:2194`, wired at `fanout-role.ts:2247-2256`), which refuses anything that is not `u32 length || body`. An unprefixed compact frame ("written as-is") on the uni stream therefore needs a mixed-mode uni reader: first byte `0xC1` → fixed 24 + `payloadBytes`; otherwise a length-prefixed JSON frame (the context). The amendment must say the uni reader changes; as written it only says the server routes by first byte (finding 2a).
- Does the uni stream exist when the warmup context must be sent? **No.** `openDeliveryStream` (`:1038-1059`) runs on the first delivery-routed `trySend` and that call answers `would-block` (`:1066-1069`); `delivery` is set in the open callback, which also runs one `relay.pump()` (`:1048-1052`). With the context now delivery-routed and "trySend/would-block semantics unchanged", the relay's `sendFrame` backlogs it (`fanout-relay.ts:1791-1810`), `pump` skips the subscriber until its backlog drains (`:1350`), and `drainControl` retries the head of every active session's backlog on every pump (`:1341`, `:1827-1838`) — each retry going through `relayFrameRoutingFields` (a JSON parse) before the `delivery === null` check. K open callbacks → K pumps; on the i-th, K − i sessions still have no stream → K²/2 parses in total plus K sorts of K. Sized with the Critic's per-round numbers: at chat 2.5k ≈ 4.3 s of empty-pump bookkeeping plus 3.1 M parses (≈25 s at ~8 µs for a ~500 B context) on the relay thread at warmup open, against a per-subscriber warmup queue that holds 3.2 s of chat warmup ingress (`WARMUP_MESSAGES_PER_PUBLISHER 10` at `WARMUP_INTERVAL_MS 500` × 10 publishers = 20 deliveries/s per subscriber, `cohort-protocol.ts:113-114`; cap 64, `fanout-relay.ts:108`) and a 5,000 ms write deadline (`:24`). HEAD's own lazy path is bounded by `maxConcurrentWrites` (≤256 tries per round); the control backlog path is not. On WS none of this exists (one socket, `trySend` succeeds unless paused). **Blocking as specified** (finding 2b). Fix: open the uni stream at WT session admission (before `accept` is written), so the context's `trySend` succeeds; and route by channel (the relay knows which frames are delivery-channel when it encodes them) rather than by parsing.
- What the WS worker connector does with a JSON delivery-context today: `decodeFanoutWsMessage` → `parseFanoutWire` refuses the unknown kind → `decoded.ok === false` → silently dropped (`fanout-role.ts:2196-2197`). WT: `decodeFanoutWtStream` refuses the same way → dropped (`:2252-2255`). Consistent with D2's "today a refused frame is silently dropped"; D2 fail-closed 1 turns that into `onMalformed`.

## E. Mirror completeness (execution)

- `git grep -nE 'ticker-fanout/rate-(10000|50000|100000)([^0-9]|$)|chat-fanout/subscribers-(5000|10000)([^0-9]|$)' -- tools crates ':!*.test.ts' ':!*fixtures*' ':!crates/native/tests'` → `secure_fs.rs:19574,19587,19600,19626,19639`; `compare-controller.ts:277`, **`:4096`** (help text: "--phase4 selects ticker-fanout/rate-10000"); `frozen-run-section-9.{6,7}.fragment.sh:4`; `render-phase4-report.ts:23`; `cross-supervisor-protocol.ts:195,199,203,211,215`; `evidence.ts:154-159`. All in D3 except `:4096`.
- Label unions `"ticker 10k|50k|100k" / "chat 5k|10k"`: `secure_fs.rs` (5), `compare-controller.ts` (5, the readiness switch), `cohort-protocol.ts` (15: union, cardinalities, grant parameters), `evidence.ts` (5). All in D3.
- `READINESS_DEADLINE_MS_CHAT_10K`: `cohort-protocol.ts:104,109` + `cohort-protocol.test.ts:67,824`. In D3. `READINESS_DEADLINE_MS_CHAT_5K` (180,000) will name a retired cell while serving chat 2.5k — cosmetic (finding 7).
- `FANOUT_COHORT_CELL_IDS` consumers: `evidence.ts:163`, `render-campaign-report.ts:17,221,359,400`, `verify-campaign-index.ts:17,1059,1064` — all derive from `evidence.ts`, one edit.
- Test files naming an old id (`.test.ts` + `crates/native/tests` + fixtures): **26** — matches D3.
- `comparison-supervisor.rs` names no cell id or label at HEAD; listing it is harmless surplus. `cohort-cells.conformance.test.ts` does not exist at HEAD (`ls tools/compare/*conformance*` → none) — D3 reads as if it did; it is new (finding 7).

## F. B5/B6 literals (execution)

- 9.6 at HEAD: `CELLS=ticker-fanout/rate-10000 … CAMPAIGN_TIMEOUT_MS=1800000 EXPECTED_PASS=2 …`; `stage-live-campaign.ts:1088` pilot `timeoutMs: 2_100_000` = campaign + 300,000 ✓ (D5 states it). B5 at rate-250: 2 arms × (1 warmup + 1 measured) × ≤76 s ≈ 5 min ✓; totals 2,500 / 250,000 per arm = the rate-250 row ✓.
- 9.7 at HEAD: `CAMPAIGN_TIMEOUT_MS=43200000`, `stage-live-campaign.ts:1090` canonical `45_000_000` = +1,800,000 — the pairing D5 keeps with 14,400,000 / 16,200,000 ✓. `EXPECTED_PASS=60 … EXPECTED_PAIRED_PROMOTIONS=6 EXPECTED_SEALED=60` = 6 × 2 × 5 ✓.
- Worst case per execution from the controller's bounds (`readinessDeadlineMs` + `WARMUP_DURATION_MS 5,000 + warmupDrainMs 6,000` + `measuredDurationMs + COHORT_DRAIN_DEADLINE_MS 10,000 + frameMs 5,000` + `teardownMs 10,000`; `compare-controller.ts:6740-6748, 7425-7431`; `cohort-protocol.ts:95,115`): ticker **76 s**, chat 90 s **156 s**, chat 180 s **246 s**. B6 = 3×12×76 + 2×12×156 + 1×12×246 = **9,432 s = 2.62 h** (D5 says 136 / 226 / 8,712 s / 2.42 h — it used the ticker's 25 s measured bound for the chat rows). With `captureMs 15,000` + `roleReceiveMs 5,000` added per execution: 3.02 h. `14,400,000` (4.0 h) holds either way (finding 4).
- Wrapper admission (`frozen-run-wrapper.fragment.sh:480-482`) requires `RUN_TIMEOUT_MS + 5,400,000` = 21,600,000 ms (6 h) of stage lease remaining at launch; the lease is the operator's `--not-after-ms` (`stage-live-campaign.ts:2220`). D5 should say so (finding 4).

## G. D4 under `check-official-io` and the fresh-root checks (execution)

- `official-io-allowlist.json` classes: `server.ts`, `scenarios/fanout-relay.ts`, `bin/fanout-role.ts` → `roleChildTs`; `scenarios/fanout-wire.ts`, `cohort-protocol.ts`, `cross-supervisor-protocol.ts` → `protocolOnlyTs`; `bin/compare-controller.ts` → `controllerOnlyTs`; `cliEntryTs` has 10 `bin/*.ts` entries. No finding code exists for "role-child code imported by a CLI entry" (`grep -n 'ROLE_CHILD_' check-official-io.ts` → none); the reachability codes (`FIXTURE_/CHECKER_/CONTROLLER_REACHED_FROM_OFFICIAL_ROOT`, `:5977-5996`) walk from `officialRoots` only. `bin/stage-live-campaign.ts` is a `cliEntryTs` with 8 `spawnSync`/`Bun.spawn` calls and the audit is green at HEAD, so the forbidden-call scan does not bind a `cliEntryTs`. **D4 is specifiable as stated**: add `bin/fanout-physical-preflight.ts` to `cliEntryTs`, never to `officialRoots`/`roleChildTs`.
- Receipt path `.release-evidence/transport-comparison/preflight/<candidate>/…` is outside the fresh-root triple `{<candidate>/<campaignId>, macRoot, rigRoot}` (`stage-live-campaign.ts:2799-2811`), and the index/render tools enumerate only the campaign directory (`verify-campaign-index.ts:906,974`, `render-campaign-report.ts:285`); `.runtime/` and `.trust-staging/` already live as non-candidate siblings. **Compatible.**

## H. The fail-closed path, hop by hop (execution)

1. Connector: WS `fanout-role.ts:2196-2197`, WT `:2252-2255` — refusal dropped today; D2 adds `onMalformed`.
2. Session inbox: `:1200-1210` (`inboxes.set(roleId, …)`, `onFrame → inbox.push`); consumption `drainOnce` `:1852-1858` → `consumeWorkerFrame` `:1435-1462` → `WorkerWindowBook.recordMalformed` `:937` / `recordDelivery` `:948`.
3. Child exit: the child's only frames to the supervisor are `role-ready/v1` `:1281`, `role-warmup-complete/v1` `:1381`, `role-measure-start-ack/v1` `:1485`, `role-partial/v1` `:1655`, `role-exited/v1` `:1677`; a `fail(code, …)` return reaches `import.meta.main`, which prints `[fanout-role] ${code}: ${message}` to stderr and `process.exit(1)` (`:2340-2345`). **No frame carries a failure code.**
4. Supervisor: the control-pipe reader sees EOF → `poison("UNEXPECTED_EOF", "control pipe ended before <expected schema>")` (`remote-supervisor.ts:8739-8742`) or a read error → `CHILD_LIFECYCLE` (`:8734`); role-child stderr is drained (`:8915`) but nothing parses a code out of it.
5. Controller: `UNEXPECTED_EOF` before readiness is a replacement trigger (`PRE_READINESS_CHILD_LOSS_CODES`, `compare-controller.ts:5507-5511`) — irrelevant here since both contexts arrive after readiness; after readiness the arm fails and the terminal record's `failureCode` is chosen by `reason.includes(code)` over a **hardcoded 18-entry list** (`:1431-1455`, `as const satisfies readonly CampaignFailureCode[]` — `satisfies` checks membership, not completeness), defaulting to `TRUST_PROTOCOL` (`:1430, :1458-1460`); the cohort executor path clamps with `closedCohortFailureCode` (`:6369`, `isCampaignFailureCode` else `COHORT_PROTOCOL`).
6. Verifier: `verify-campaign-index.ts:222-243` checks a FAIL entry has a non-null `failureCode` typed `CampaignFailureCode` (`:65`); `verify-artifact.ts` does not read `failureCode` at all (`grep -n failureCode verify-artifact.ts` → none).
7. Vocabulary pins: TS `CAMPAIGN_FAILURE_CODES.length === 18` (`cross-supervisor-protocol.test.ts:655`); Rust `SECTION_7_CODES.len() == 21` (`crates/native/tests/rig_cohort_runtime.rs:2746`, `mac_cohort_runtime.rs:2108`); no TS test reads `secure_fs.rs` (`grep -rln secure_fs.rs tools/compare` → only comments in `cohort-protocol.test.ts`, `fanout-supervisor-integration.test.ts`, `remote-supervisor.ts`). **There is no cross-language vocabulary test.**

Answer to the brief's question: a new `CampaignFailureCode` member needs, beyond the two tables, (a) a carrier from the role child (`role-failed/v1` or equivalent, with a closed code the supervisor turns into its terminal), (b) the controller's substring list at `:1431-1455`, (c) the three pinned lengths, and (d) the mixed-version test asserting the sealed `failureCode`, not merely FAIL.

## Findings

### 1. BLOCKING — D2 fail-closed 2 names a code that has no carrier to the controller, and cites a test that does not exist

Text at D2 fail-closed 2: "makes the worker child exit with the closed failure code `DELIVERY_CONTEXT_MISMATCH`, a new member of `CampaignFailureCode` (… mirrored in `secure_fs.rs` … and pinned by the existing cross-language vocabulary test); the controller sees it through the child lifecycle path". As section H shows, the child lifecycle path delivers `UNEXPECTED_EOF`/`CHILD_LIFECYCLE`, the terminal record would seal `CHILD_LIFECYCLE` or `TRUST_PROTOCOL`, and the two vocabularies are pinned separately with no comparison. The arm is FAIL either way, so the campaign is safe; what is false is the evidence claim — the sealed record would not name the refusal, and a mixed-version test written to the text ("→ child FAIL") would pass without proving the code exists anywhere. Required text: (i) slice 2 adds a `role-failed/v1` control frame `{schema, sequence, executionSha256, childId, code: CampaignFailureCode, message}` the child sends before exiting 1 and the supervisor maps to its terminal code (its own `isCampaignFailureCode` pass-through at `remote-supervisor.ts:7206` already admits any member); (ii) slice 1 owns `compare-controller.ts:1431-1455` and the three pinned lengths (`cross-supervisor-protocol.test.ts:655` → 19; `rig_cohort_runtime.rs:2746` and `mac_cohort_runtime.rs:2108` → 22); (iii) the mixed-version test asserts `failureCode === "DELIVERY_CONTEXT_MISMATCH"` on the sealed terminal; (iv) drop "existing cross-language vocabulary test" or add one (a test that reads both lists is a slice-1 deliverable). Commands: `sed -n 2340,2346p tools/compare/bin/fanout-role.ts; grep -n 'schema: "role-' tools/compare/bin/fanout-role.ts; sed -n 8736,8742p tools/compare/remote-supervisor.ts; sed -n 1431,1460p tools/compare/bin/compare-controller.ts; grep -rn 'SECTION_7_CODES.len()' crates/native/tests; grep -n 'CAMPAIGN_FAILURE_CODES.length' tools/compare/cross-supervisor-protocol.test.ts; grep -rln 'secure_fs.rs' tools/compare`.

### 2. BLOCKING — the WT delivery channel: wrong routing byte, unstated uni reader, and a stream that does not exist when the warmup context is sent

(a) D2: "`server.ts` routes by the first byte before any JSON parse: `0xC1` → the uni delivery stream; `{` → the existing JSON routing". On WT the bytes at the routing site are `u32be length || JSON` (`fanout-wire.ts:1073-1083`; `server.ts:882-890` reads the prefix), so `{` never occurs first; the WT discriminator is `0xC1` vs `0x00`. And "written as-is (no length prefix)" on the uni stream breaks the Mac uni reader (`LengthPrefixedFrameReader`, `adapters/wt.ts:2194`, wired at `fanout-role.ts:2247-2256`), which the amendment does not mention. Required text: WT routing is "first byte `0xC1` → uni delivery stream; otherwise a length-prefixed control frame, `kind` decides as today, extended to `delivery-context`"; the Mac uni-stream reader becomes mixed-mode (`0xC1` → 24 + `payloadBytes`; else prefixed JSON), the control stream reader unchanged.

(b) D2 pins "the relay sink's `trySend`/would-block semantics are unchanged" and "the first frame on the uni stream", but the uni stream is opened lazily by the first delivery-routed `trySend` (`server.ts:1038-1059, 1066-1069`). The context therefore rides the control backlog (`fanout-relay.ts:1791-1810`), which `drainControl` retries for every active session on every pump with a JSON parse per retry (`:1341, :1827-1838` → `relayFrameRoutingFields`), unbounded by `maxConcurrentWrites` — K pumps of O(K log K) plus K²/2 parses at the warmup open on WT: ≈4.3 s + ≈25 s at chat 2.5k (section D), against 3.2 s of per-subscriber warmup queue and a 5 s write deadline; chat 1k is ≈1.7 s + ≈4 s. A warmup `SUBSCRIBER_QUEUE_FULL` or `RELAY_WRITE_TIMEOUT` closes sessions and the worker fails `WARMUP_PROTOCOL` (`fanout-role.ts:1370-1374`) — B6's chat WT arms fail before any measured frame. Required text: `server.ts` opens the WT uni delivery stream at session admission, before the relay's `accept` is written, so every delivery-channel `trySend` finds `delivery !== null`; the relay tells the sink the channel when it encodes a frame (`trySend(bytes, "control" | "delivery")` or a pre-routed byte) so no outbound frame is parsed for routing; and D4 runs the warmup epoch too at both topologies on both transports. Commands: `sed -n 1034,1071p tools/compare/server.ts; sed -n 1336,1352p tools/compare/scenarios/fanout-relay.ts; sed -n 1791,1840p tools/compare/scenarios/fanout-relay.ts; grep -n 'WARMUP_MESSAGES_PER_PUBLISHER\|WARMUP_INTERVAL_MS' tools/compare/cohort-protocol.ts`; per-round cost: `python3` over `scratchpad/raw/relay/k2500-compact.jsonl` (`ns/pumpRounds` → 2.15 ms).

### 3. Non-blocking — D4 must name the warmup epoch and the WT stream-open timing as in scope

Follows from 2(b): "offer 2× the row's ingress rate for the full window" covers the measured window; the WT failure mode above is in warmup. State that the preflight runs the production warmup (10 messages per publisher at 500 ms) before the measured window and that its receipt records the max per-subscriber queue depth during warmup as well.

### 4. Non-blocking — D5 arithmetic and the lease

Per-execution bounds for the chat rows are 156 s (90 s readiness) and 246 s (180 s), not 136/226 (the ticker's 25 s measured bound was used); B6 worst case 9,432 s = 2.62 h (3.02 h with capture and role-receive). The pinned `14,400,000` still holds; fix the sentence so the exact-stage Critic is not comparing against a wrong derivation. Add: the stage's `--not-after-ms` must leave ≥ `RUN_TIMEOUT_MS + 5,400,000` = 21,600,000 ms at launch (`frozen-run-wrapper.fragment.sh:480-482`).

### 5. Non-blocking — chat-500 row uses the K=1,000 bound where D1 says interpolate

D1: "`relay_us` interpolated linearly between the measured K points". At K=500 that is 4.48 µs → WS 182k / 36.5×, WT 87k / 17.4×. The row prints "≤4.98 / ≥167k / ≥84k". Either is safe; pick one convention and say which.

### 6. Non-blocking — two parser conventions for the delivery-context

`rejectEpochMixing` (`fanout-wire.ts:371-383`) selects the forbidden set by `kind.startsWith("warmup-")`; the two contexts share `kind:"delivery-context"`, so the parser must select by `epoch`. And state the worker refuses a session whose warmup and measured tags are equal (2⁻³², but fail closed rather than ambiguous).

### 7. Non-blocking — mirror list residue

Add `bin/compare-controller.ts:4096` (help text). `cohort-cells.conformance.test.ts` is new, not existing — say "a new conformance test". `READINESS_DEADLINE_MS_CHAT_5K` will serve chat 2.5k under a retired name; rename to `_CHAT_2K5` or note it. `comparison-supervisor.rs` names no id or label at HEAD (harmless).

### 8. Non-blocking — "keyed by the session's own roleId" needs `drainOnce` to carry it

`consumeWorkerFrame` keys `recordDelivery` on `frame.subscriberId` (`fanout-role.ts:1455`) and `drainOnce`'s callback carries no roleId (`:1852-1858`) although inboxes are keyed by it. Slice 2 must thread the inbox's roleId to consumption and make `subscriberIndex` a check. Implementation detail; naming it stops a "keyed by the frame" shortcut.

### 9. Non-blocking — D1 bit-rate label

"25.6 Mbit/s (ticker) / 31.2 Mbit/s (chat) before framing" are 25,000 × (124+4) × 8 and 25,000 × (152+4) × 8 — the compact frame with its 4 B WS header. Payload alone is 20.0 / 25.6 Mbit/s. Relabel as "frame bit rate on WS before TCP/TLS".

## Verified without finding

- D3 rows vs every D1 constraint at their own K on both transports: hold (section B), rule 2.5× satisfied, D4's 2×-offered rate under the WT ceiling on every row, link ≥30× everywhere.
- Compact frame vs consumers and §4.5: complete and bound (section C).
- Mirror enumeration: complete to one help-text line (section E); 26 test files confirmed.
- D4 specifiable under `check-official-io`; receipt path compatible with fresh-root checks (section G).
- 9.6 pairing and B5 totals; B6 literal covers the corrected worst case (section F).
- `EXPECTED_TOTALS_MISMATCH` as a `verify-campaign-index.ts` local refusal code: consistent with `:207-262`.
- Rig state during this review: idle, MemAvailable 6,803 MB, nothing created under `/tmp` on the rig.

## Two-perspective note

- Perfectionist: the two blocking items are both "the text pins a mechanism that does not exist at HEAD" — a code with no carrier, a stream with no opener — in the one document every grant will hash. The R1 cycle already established that such gaps cost a stage or a run; both fixes are a paragraph each.
- Pragmatist: the measurement, the rows, the frame and the mirror list are done and reproduce; one more revision with findings 1–2 (and the 3–9 one-liners) and this is ready for the Critic.
