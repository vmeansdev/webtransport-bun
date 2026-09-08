CHANGES REQUIRED

# Architect review — physical-budget amendment (compact delivery frames, hardware-derived cells)

Reviewer: Claude (Architect pass), 2026-09-08. Git read-only; no tracked file edited; no campaign, stage or controller started; rig touched only by read-only ssh (`cat /sys/class/net/eno1/speed`, `free -m`, `lscpu`); nothing created under `/tmp` on the rig (`ls /tmp | grep -c amendment-review` → 0). Every number below was recomputed from the raw files or from code at HEAD; the command is named beside each claim.

## Bindings

- Amendment SHA-256: `bfd38e0474c27cc153c96bb9ee06a91f4292b4d922c725b49baca331f95892a3` (`shasum -a 256 docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, 111 lines)
- Base plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Cohort completion amendment SHA-256: `90d469cb0c54e8e4e34a7edb333156b365d73464099e1d7eb49189234a55e7e1`
- Candidate HEAD: `efaed8bb0af82a499ca58b2627ea251efced41c5` (`git rev-parse HEAD`; `git status --porcelain | grep -v '^??'` empty)
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`

## Verdict in one paragraph

D1 is sound: every number in the table traces to a raw file and reproduces (section A). D3's rows all sit under the 50,000/s budget rule and clear every D1 constraint with the margins the amendment states, with one honest caveat the amendment already prints (WT-as-written is 2.8× against the measured 140k, 0.70–0.77× against its own derated ceiling). The compact frame carries exactly the fields the worker's accounting and the §4.5 equations consume (section C). What blocks approval is specification, not arithmetic: (1) the delivery-context binding is causal on WS but not on WT as written, because the WT egress routes by JSON `kind` onto two different QUIC streams and throws on a non-JSON body; (2) D3 both retains and retires `chat-fanout/subscribers-1000`/`-5000`; (3) the mirror enumeration misses the module that actually constructs the cell ids (`scenario-registry.ts`) and its typed unions; (4) the B6 timeout is left as a formula that omits the two arms and pins no literal, while a second timeout mirror in `stage-live-campaign.ts` is not named. All four are short edits to the amendment text; none changes the design.

## A. D1 traceability (every number recomputed from a raw file)

| D1 claim | Recomputed | Raw file / command |
|---|---|---|
| Cable 940.7 Mbit/s, spread 0.4 | receiver mean **940.74**, stdev 0.49 (940.83 / 941.18 / 940.22), 0 retransmits | `jq .end.sum_received.bits_per_second link-and-transport/raw/iperf3-run{1,2,3}.json` |
| Rig eno1 / Mac en13 1000baseT | rig `speed`=1000 `duplex`=full; Mac `media: autoselect (1000baseT <full-duplex,flow-control>)` | ssh read-only + `ifconfig en13` (live, this review) |
| WS link-bound `940.7e6/8/(N+4)`: 889k/716k/575k | formula 890,814 / 716,997 / 576,409; measured wss M=100 from client JSONs **889,625 / 715,578 / 575,409** (3 reps each, spread <0.2 %) | python over `raw/wss-n{128,160,200}-m100-r{1,2,3}-client*.json` `window.msgsPerS` summed |
| Rig CPU <0.8 core for WS | 0.13–0.73 | `summary.txt` srvCPU column |
| WT as written ~33k/session, ~140k across 8–100 sessions, 3.2–4.6 cores | M=1: 31,841 / 33,522; M=100: 142,882 / 129,353 (min rep **118,073**) / 139,945 / 140,198; cores 3.18–4.60 | `raw/wt-n*-m*-rasis{1,2,3}-client*.json`, `summary.txt` |
| WT coalesced ≥1.2 KB link-bound, 900k @128 B, ~4 cores | 899,822 at 4.15 cores (M=100) | `summary.txt` wt-w rows |
| Today's frame 654 B WS / 658 B WT | `{"bytes":{"ws":654,"wt":658}}` in the bench log; my own run with HEAD's `encodeFanoutWsMessage` gives 655/659 with a 6-digit `publisherSequence` (bench sample used 5 digits) — one digit, same codec | `results/rig/rig-json.jsonl` line 2; scratch `sizes.ts` importing `tools/compare/scenarios/fanout-wire.ts` at HEAD |
| Compact 124 B / 152 B | **124 / 152** with the prototype `encodeCompact` (header 24 + payload) | same `sizes.ts` importing `tree/bench/compact-codec.ts` |
| Relay JSON 47.8k (20.9 µs) / compact 245k (4.08 µs) / free-encoder 348k (2.87 µs), medians of 5 | **47,785** (45,971–55,941) 20.93 µs; **245,377** (240,269–262,298) 4.08 µs; **348,257** (254,875–362,759) 2.87 µs; warmup run excluded | python median over `results/rig/rig-relay-{json,compact,zero}.jsonl` `deliveriesPerS` with `warmup:false` |
| Compact encode 2.6M (MAD 0.7 %), with digest 0.54M | template+clone **2,628,403**; with digest **536,895** | `rig-compact.jsonl` `fps` medians |
| Subscriber decode JSON 78k / compact 13M per Mac worker | 78,414 / 12,988,630 | `results/mac/mac-{json,compact}.jsonl` |
| Sessions: WS 1.45 KB, WT 104 KB (1.04 GB @10k), accept headroom 1.2–1.6× (WT) / 17× (WS), bun raises NOFILE to 524,288 | WS 1.47/1.44/1.45 KB; WT 103.86 KB ×2 → 1,096 MB @10k; WT unthrottled 480–800/s vs 500/s; `bun -e` reports 524288/524288 | `sessions-fds-memory/REPORT.md` §1–2b tables, `raw/rig-facts-2.txt` |
| Mac 16,384 ephemeral ports; 8×1,250 fine (40 MB WS / 370 MB WT) | 49152–65535; 38–40 MB / 366–368 MB | `raw/mac-facts.txt`, WT k10000 rows |

Derived ceilings check: WS@50 % F=130 → 438,759 (amendment "~439k" ✓; at the actual 124 B frame it is 459,326); WT-as-written@50 % 64,677–71,441 ✓; relay compact halved 122,689 ✓. The "impossible at any frame ≥118 B" sentence is true but loose: at 1,000,000/s the cable admits ≤113.6 B per WS message including the 4 B header (940.7e6/8/1e6 − 4) and ≤114.4 B on coalesced WT — non-blocking, see finding 10.

## B. D3 rows against every D1 constraint (recomputed)

Budget rule `deliveries/s ≤ 50,000` holds for all six rows. Frame = 24 + messageBytes. WS link = 940.7e6/8/(frame+4). "WT min" = the worst as-is rep (118,073/s). "WT derated" = the amendment's 50 %-derated 64.7–71.4k. Relay = 245,377 (derated 122,689). Decode/worker = 12.99M ÷ (deliveries/s ÷ 8 workers). Readiness = sessions ÷ 500/s.

| Cell | Sessions | Ingress | Expanded | Del/s | WS full | WS @50 % | WT 140k | WT min | WT derated | Relay | Relay derated | Decode/worker | WT rig RSS | Mac ports | Ramp / deadline |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ticker rate-100 | 101 | 1,000 | 100,000 | 10,000 | 91.9× | 45.9× | 14.0× | 11.8× | 6.5–7.1× | 24.5× | 12.3× | 10,391× | 10 MB | 0.6 % | 0.2 s / 30 s |
| ticker rate-250 | 101 | 2,500 | 250,000 | 25,000 | 36.7× | 18.4× | 5.6× | 4.7× | 2.6–2.9× | 9.8× | 4.9× | 4,156× | 10 MB | 0.6 % | 0.2 s / 30 s |
| ticker rate-500 | 101 | 5,000 | 500,000 | 50,000 | 18.4× | 9.2× | 2.8× | 2.4× | **1.29–1.43×** | 4.9× | 2.5× | 2,078× | 10 MB | 0.6 % | 0.2 s / 30 s |
| chat 1k | 1,010 | 300 | 300,000 | 10,000 | 75.4× | 37.7× | 14.0× | 11.8× | 6.5–7.1× | 24.5× | 12.3× | 10,391× | 103 MB | 6.1 % | 2.0 s / 90 s |
| chat 2.5k | 2,510 | 300 | 750,000 | 25,000 | 30.2× | 15.1× | 5.6× | 4.7× | 2.6–2.9× | 9.8× | 4.9× | 4,156× | 255 MB | 15.3 % | 5.0 s / 180 s |
| chat 5k | 5,010 | 300 | 1,500,000 | 50,000 | 15.1× | **7.5×** | 2.8× | 2.4× | **1.29–1.43×** | 4.9× | 2.5× | 2,078× | 509 MB | 30.5 % | 10.0 s / 180 s |

- Every `readinessDeadlineMs` ∈ `READINESS_DEADLINE_MS_VALUES` = {30,000, 90,000, 180,000, 300,000} (`cohort-protocol.ts:102-111`). 300,000 becomes an orphan member (finding 11).
- Chat 5k WT inside 180 s: 5,010 × 104 KB = 509 MB rig RSS (measured 582 MB at K=5,000 including a 58 MB baseline; MemAvailable 6.1–6.2 GB during that run); ramp 10.0 s at the grant's 500/s, measured series 496–504/s with 200 in flight for both transports; the production listener admission `cohortWtListenerAdmission` (`server.ts:940-969`) sets `handshakesPerSec: 500` with `handshakesBurst = sessions`, so the limiter cannot refuse the ramp. The "1.2–1.6×" is a rate headroom above 500/s, not a time headroom; the time headroom is 18×. Holds.
- Publisher pacing at 500/s is realisable: `fanout-role.ts:1500-1516` sleeps per message at `sequence/rate` ns offsets (2 ms spacing); `totalMessages = rate × duration/1000` is an integer for 100/250/500 and for chat's 1 × 30.
- Deliveries/s, expanded deliveries, sessions and process counts (publishers + 8) all recompute from the row. `expectedOfferedIngress = ingress`, `expectedExpandedDeliveries = ingress × subscribers`, `declaredMessageCount = expanded` (cross-supervisor-protocol.ts:192-216 shape).

## C. Compact frame vs. the real consumers

Read at HEAD: `fanout-role.ts:1435-1462` (`consumeWorkerFrame`), `:948-1016` (`recordDelivery`), `:410-447` (`assignedGlobalOrdinals`), `:1416-1428` (`WorkerWindowBook` construction), `fanout-wire.ts:207-221, 387-465, 746-775`, `fanout-relay.ts:1224-1245` (the fanned object), `:1256-1320` (`enqueue`), `:1339-1391` (`pump`).

- Worker consumes exactly `subscriberId`, `publisherId`, `publisherSequence`, `windowIndex` (+ local arrival time). `payloadSha256`, `payloadBase64`, `linuxAcceptedOrdinal`, both digests: never read by the worker (`grep -n payloadSha256 fanout-role.ts` → only the publisher's own sends). Confirmed.
- `subscriberIndex` ↔ `subscriberId`: bijective by construction — `subscriber-${ordinal.padStart(6,"0")}` at `fanout-role.ts:441`, `fanoutRoleId` at `fanout-relay.ts:1943-1948`, `roleIdNumber` at `:410-417`; the worker's shard is `ordinal ≡ workerIndex (mod 8)` so membership is checkable from the index alone. `publisherIndex` ↔ `grant.publishers[i]`: the publisher's global ordinal is `subscriberCount + index` into `grant.publishers` (`:421-429`) and ids are minted as `publisher-${index}` (`cohort-protocol.ts:2403, 3738`, `fanout-relay.ts:2024`), so the relay can derive the index from the role id without an extra grant field (the relay config has `expectedSubscriberIds` only, `fanout-relay.ts:255`). Consistent.
- `windowIndex` u8 < 30 = `FANOUT_MAX_WINDOW_COUNT` (`fanout-wire.ts:71`); `publisherSequence`/`linuxAcceptedOrdinal` ≤ 5,000 fit u32; `payloadBytes` u16 ∈ {100,128}.
- §4.5: `D_origin[w]`, `DB_origin[w] = D × messageBytes` use `this.messageBytes` (`fanout-role.ts:1000-1003`), not the frame; `series.samples[e]` from arrival time; duplicates/reorders keyed on (subscriber, publisher, sequence) — all present in the header. Nothing in the frame is unbound: `contextTag` binds to the per-session digest the worker recomputes from admission facts it already holds (grant digest from spawn config `:1183`, barrier digest from `verifyRoleMeasureStart` `:1408`, `messageBytes` = `config.payloadBytes` checked against the grant at `:353`, `windowCount` from the barrier `:1414`).
- Warmup counting today is `frame.kind === "warmup-data"` (`fanout-role.ts:1365`); a compact warmup frame has no `kind`, so the in-process representation the connector hands to `session.onFrame` must carry the phase (tag match against the warmup context). Slice-2 detail, not a spec gap, but see finding 8 for the warmup context's keys.

## D. Causality of the delivery-context in the real lifecycle

- Measured: `openMeasuredWindow` (`fanout-relay.ts:1077-1109`) flips `phaseValue` to `measured`; it is called from the cohort runtime at `:3380` while building `ServerStartBarrierAcceptedV1`; the Mac arms role children only after the rig's signed barrier acceptance, and `measureStartAtMacNs` is ≥250 ms after minting (`fanout-role.ts:548-556`). Registration is closed at that point (`phaseValue` left `registration` at `:851`), a closed subscriber cannot re-register (`registrationRefusal` returns `REGISTRATION_CLOSED`, `:691`), so "every session immediately after `openMeasuredWindow`" covers every subscriber that can ever receive a measured frame. No late admission exists.
- Warmup: `bindWarmupEpoch` is immediately followed by `closeRegistration()` in the runtime (`:3037-3043`); the relay refuses warmup data before phase `warmup` (`:865-873`). Emitting the warmup delivery-context at `closeRegistration` (after the bind) reaches every registered subscriber before any warmup-data can exist.
- WS: one ordered socket; `pump` drains `controlQueue` before servicing `queue` and skips a subscriber with pending control (`:1341, :1350`), so a control frame enqueued before a delivery precedes it on the wire. Causal.
- WT: **not causal as written** — finding 1.
- Worker side: frames are queued per session in FIFO inboxes (`:1200-1210`) and consumed later, so a delivery-context arriving before the worker holds the epoch/barrier can be verified at consumption. The amendment should say "verified at consumption in inbox order" rather than "on arrival" (finding 8).

## E. Mirror enumeration (execution)

`git grep -lE 'ticker-fanout/rate-(10000|50000|100000)([^0-9]|$)|chat-fanout/subscribers-(1000|5000|10000)([^0-9]|$)' -- . ':!docs/superpowers/plans'` → 38 tracked source files + 89 files under `.release-evidence/transport-comparison/ws-wt-r0/` (historical sealed evidence, not to be edited). Of the 38: 23 `.test.ts` + 2 `crates/native/tests/*.rs` + `r1-fixtures.ts` = 26 (the amendment's "26 test files" holds if the fixture is counted). Non-test source files naming an old id: `cohort-protocol.ts` (labels), `cross-supervisor-protocol.ts:190-216`, `evidence.ts:152-160`, `bin/compare-controller.ts:277`, `bin/render-phase4-report.ts`, `bin/frozen-run-section-9.{6,7}.fragment.sh`, `crates/native/src/secure_fs.rs:19572-19651`, `crates/native/src/bin/comparison-supervisor.rs` — all in slice 3. **Missed** (finding 3): `git grep -nE 'rate-\$\{|subscribers-\$\{'` → `scenario-registry.ts:239, :270`; `git grep -n 'ingressRatePerSecond'` → `types.ts:30`, `scenario-registry.ts:257`, `client.ts:1442, 1470`; label switch `bin/compare-controller.ts:6874-6889`; `COHORT_CELL_GRANT_PARAMETERS` `cohort-protocol.ts:5713-5721` and the `CohortCellId` union `:5596-5602`. `.github/workflows/ws-wt-campaign.yml` names only the scenario id `ticker-fanout` (fine).

## F. D4 under the official-io audit (execution)

`check-official-io.ts:4896-4962`: every non-test `.ts` under `tools/compare` is walked and must be in one allowlist class or it is `ALLOWLIST_EXTRA_FILE`; `bin/*.ts` operator entrypoints live in `cliEntryTs` (`official-io-allowlist.json` `cliEntryTs`, 10 entries). Static edges are frozen only for the graph walked from the four `officialRoots` (`jq '.resolvedStaticImports|length'` → 68; `select(.from|startswith("tools/compare/bin/"))` → none), so a `cliEntryTs` file importing `server.ts`, `scenarios/fanout-relay.ts`, `scenarios/fanout-wire.ts` and `bin/fanout-role.ts` adds no edge the audit checks; "not reachable from production" is proven by the reachability walk from the roots (`:5977-5996`), which the preflight satisfies as long as no root/role-child module imports it. D4 is specifiable as stated: add `bin/fanout-physical-preflight.ts` to `cliEntryTs`. `stage-live-campaign.ts abandon` exists (`:76, :3476`).

## G. B5/B6 consistency (execution)

- 9.6 fragment at HEAD: `CELLS=ticker-fanout/rate-10000 REPS=1 CAMPAIGN_TIMEOUT_MS=1800000 EXPECTED_PASS=2 EXPECTED_PROMOTABLE=0 EXPECTED_FLATS=0 EXPECTED_PAIRED_PROMOTIONS=0 EXPECTED_SEALED=2 EXPECT_CANONICAL_FANOUT_COMPLETE=0 RENDER_MODE=diagnostic`; D5 changes only `CELLS`. B5 totals 5,000 / 500,000 per arm = the rate-500 row. B5 wall: 2 arms × 2 executions × ≤76 s ≈ 5 min under 1,800,000 ms. Consistent.
- 9.7 fragment: `EXPECTED_PASS=60 EXPECTED_PROMOTABLE=60 EXPECTED_FLATS=12 EXPECTED_PAIRED_PROMOTIONS=6 EXPECTED_SEALED=60` = 6 cells × 2 arms × 5 reps; D5's counts match. `CAMPAIGN_TIMEOUT_MS`: finding 4.

## Findings

### 1. BLOCKING — D2 does not say which WT stream carries the delivery-context, and the WT egress as written cannot carry a compact frame at all

`tools/compare/server.ts:826-834` (`isRelayDeliveryFrame`: `kind ∈ {data, warmup-data} && direction === "relay-to-subscriber"`) and `:865-915` (`relayFrameRoutingFields`: `JSON.parse` of the body; any non-JSON body **throws** "relay produced an undecodable frame"); `:1063-1071` routes delivery frames to the lazily-opened server uni stream and everything else to the control bidi stream. Consequences at HEAD: (a) a `kind:"delivery-context"` frame goes to the control bidi stream while compact frames go to the uni stream — two QUIC streams with no mutual ordering, so the worker can observe a compact frame before its context, and D2 makes an unbound tag a `RELAY_DELIVERY` fault "counted before any delivery counter moves"; (b) a compact frame's first byte `0xC1` makes `relayFrameRoutingFields` throw inside `sink.trySend` inside `pump()`, i.e. the relay child dies on the first measured delivery. The amendment's "server.ts unchanged unless the relay sink needs it" is therefore false by reading; slice 2 must own `server.ts:826-915`.

Required text: the delivery-context is a **delivery-channel** frame — WS: the next binary message on the subscriber's socket; WT: the **first frame on the server-opened uni stream**, routed by `isRelayDeliveryFrame` extended to `kind:"delivery-context"`, with compact frames routed by their magic byte before any JSON parse. State that the worker verifies the context at consumption in inbox order and refuses (`DELIVERY_CONTEXT_MISMATCH`) a compact frame that arrives on a session with no context yet. Command: `sed -n 826,834p tools/compare/server.ts; sed -n 880,905p tools/compare/server.ts`. (Informational: the relay's `end` marker has the same cross-stream exposure today; not introduced by this amendment.)

### 2. BLOCKING — D3 both keeps and retires two cell ids

D3 lists `chat-fanout/subscribers-1000` and `chat-fanout/subscribers-5000` as rows, then says "The old six ids become unknown cells everywhere (refused, never aliased)" and slice 3 says "the old ids are asserted unknown". Those two ids are among the old six (`evidence.ts:157-158`, `secure_fs.rs:19612, 19625`). A conformance test written to the text refuses two of the six new rows. Fix: "the four retired ids `ticker-fanout/rate-10000`, `rate-50000`, `rate-100000`, `chat-fanout/subscribers-10000` become unknown; `subscribers-1000` and `subscribers-5000` keep their ids and cardinalities". Command: `grep -n 'subscribers-1000\|subscribers-5000\|old six' docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`.

### 3. BLOCKING — the mirror list omits the module that constructs the ids

`tools/compare/scenario-registry.ts:228` `chatCell(subscriberCount: 1_000 | 5_000 | 10_000)`, `:256-270` `tickerCell(ingressRatePerSecond: 10_000 | 50_000 | 100_000)` building `` `ticker-fanout/rate-${ingressRatePerSecond}` ``, `:514-519` the canonical cell loops; `tools/compare/types.ts:30` `TickerParameters.ingressRatePerSecond: 10_000 | 50_000 | 100_000` (the value the `scenarioHash`/grant commits to); `tools/compare/client.ts:1442, 1470` (executor default params `ingressRatePerSecond: 10_000`, `messageCount: 10_000 * 10`); `bin/compare-controller.ts:6874-6889` (`cohortReadinessDeadlineMs` switch on labels — a fourth readiness mirror beside `cohort-protocol.ts:102-111`, `secure_fs.rs` `readiness_deadline_ms`, and the base plan text); `cohort-protocol.ts:5596-5602` `CohortCellId` and `:5713-5721` `COHORT_CELL_GRANT_PARAMETERS`. None is named in slice 3 or in the conformance test's asserted set; the registry is where a `--cells=ticker-fanout/rate-500` lookup is resolved, so an unlisted registry is a run-time refusal, not a tsc error. Add them to slice 3 and to the conformance test's mirror list. Command: `git grep -nE 'rate-\$\{|subscribers-\$\{|ingressRatePerSecond' -- tools | grep -v test`.

### 4. BLOCKING — B6 timeout: derivation omits the arms, no literal is pinned, second mirror unnamed

D5 says "six cells × 6 executions × (readiness + 30 s + drain) ≤ 4 h … frozen in the fragment". A cell runs 2 arms × (1 warmup + 5 measured) = 12 executions (60 seals ÷ 5), not 6. Recomputed worst case with per-cell deadlines and the controller's bounds (`WARMUP_DURATION_MS 5,000 + warmupDrainMs 6,000`, `COHORT_DRAIN_DEADLINE_MS 10,000`, `teardownMs 10,000`, `frameMs 5,000`, `compare-controller.ts:6743-6747, 7425-7431`): 3 × 12 × 76 s + 12 × 156 s + 2 × 12 × 246 s = **10,512 s = 2.92 h** (the amendment's 6-execution formula gives 1.46 h; expected actual at a 500/s ramp is ~1.2 h). So "≤ 4 h" holds, but the amendment must state the literal (e.g. `CAMPAIGN_TIMEOUT_MS=14400000`) and the paired `RUN_TIMEOUT_MS` that `stage-live-campaign.ts:1091` hardcodes for section 9.7 (`45_000_000` today; the base plan keeps RUN = CAMPAIGN + 1,800,000, and the wrapper's admission gate at `frozen-run-wrapper.fragment.sh:480` requires `RUN_TIMEOUT_MS + 5,400,000` of lease remaining). Without the two literals the exact-stage Critic has nothing to compare the frozen fragment against. Command: `grep -n 'timeoutMs' tools/compare/bin/stage-live-campaign.ts | head -5; cat tools/compare/bin/frozen-run-section-9.7.fragment.sh`.

### 5. Non-blocking — the D4 2× bar for WT at the 50k rows is at or above the measured WT ceiling; say what happens to D3 when it fails

D4 requires ≥2× the declared rate, i.e. ≥100,000 deliveries/s on WT for rate-500 and chat-5k, using the production relay + production egress. D1's WT-as-written ceiling is 118–152k/s (M=100, `summary.txt`) for a tight loop with **no relay bookkeeping** (4.08 µs/delivery, and at chat 5k the relay sorts all 5,010 sessions in `activeSessions()`/`registeredSubscribers()` on every `pump` — `fanout-relay.ts:1721-1743` — with `RELAY_MAX_CONCURRENT_WRITES` 256 per round and the settler re-pumping per `setImmediate`, `server.ts:629-656`; D1's relay number was measured at 100 subscribers). The likely outcome is a WT preflight below 2× on the two top rows, and the amendment's only remedy is "return to D1, never to a smaller margin". State the fallback now (e.g. the top rows drop to rate-250 / chat-2.5k by re-amendment, or the 2× bar is measured against the arm's own achieved rate with relay included), so a preflight miss does not require inventing policy under a lease clock.

### 6. Non-blocking — margins are quoted for the ticker frame only

"WS link 8.8×" is 439k ÷ 50k for a 124–130 B frame; chat 5k's frame is 152 B: 376,883 ÷ 50,000 = **7.5×** derated (15.1× raw). Print the margin per row (table in section B) rather than one number for the rule.

### 7. Non-blocking — payload bit rate at the top rows for the record

50,000/s × 128 B WS message = 51.2 Mbit/s (ticker), 62.4 Mbit/s (chat) before TCP/TLS framing — 5–7 % of the cable. Worth one line in D1 so a reader sees the link is no longer the constraint; WT write count is.

### 8. Non-blocking — pin the delivery-context's exact keys for both epochs and the verification point

`fanout-wire.ts` parsers are exact-key (`exactKeys`, `rejectEpochMixing` at `:746-749`). D2 gives the measured key set and says the warmup variant has "`cohortStartBarrierSha256` replaced by `cohortWarmupEpochSha256`", which leaves ambiguous whether the key name changes, whether `warmupNonce` is bound, and whether the digest preimage's key is renamed. Give both exact key sets and both canonical preimages (recommend binding `warmupNonce` in the warmup context, as every other warmup frame does at `:154-160`), and state that the worker verifies at consumption in inbox order (section D). Also state the u32 tag is read little-endian from digest bytes 0..3 (the prototype does; `compact-codec.ts:52`).

### 9. Non-blocking — name the vocabulary each new code joins

`DELIVERY_CONTEXT_MISMATCH` "added to the existing closed relay/worker vocabularies": the closed sets are `FANOUT_ACK_CLOSED_CODES` (`fanout-wire.ts:112-119`, relay→publisher acks, mirrored nowhere in Rust) and `CampaignFailureCode` (`cross-supervisor-protocol.ts:116-135`, mirrored in `secure_fs.rs:12188-12316`). A worker refusal is a `COHORT_PROTOCOL`/`RELAY_DELIVERY` failure with a message today; a new `CampaignFailureCode` needs the Rust mirror and the seal/verifier tests. Say which. `EXPECTED_TOTALS_MISMATCH` (D6) should be a `verify-campaign-index.ts` refusal (its own code style, `:1207-1227`), not a sealed `failureCode` — say so.

### 10. Non-blocking — D1 wording

"impossible on this cable at any frame ≥118 B before margin": the exact bound is 113.6 B per WS message including the 4 B header (940.7e6/8/1e6 − 4) and 114.4 B on coalesced WT (915e6/8/1e6). True as written, weaker than the data.

### 11. Non-blocking — orphaned readiness member and file paths

`READINESS_DEADLINE_MS_CHAT_10K = 300_000` stays in the closed set with no row using it; either drop it from `READINESS_DEADLINE_MS_VALUES` (and `secure_fs.rs`) or note it as retained. D6 names `render-campaign-report.ts` / `verify-campaign-index.ts`; both live under `tools/compare/bin/` (`ls tools/compare/bin/render-campaign-report.ts`).

### 12. Non-blocking — historical evidence

89 tracked files under `.release-evidence/transport-comparison/ws-wt-r0/` name the retired ids; they are sealed history and must not be edited, but `renderSealedIndexDiagnostic` (`bin/render-campaign-report.ts:214-222`, `FANOUT_COHORT_CELL_IDS.includes`) and `cohortCellForArm` will treat them as non-cohort cells after slice 3. Record that as intended in the deviation set so nobody "fixes" it.

## Verified without finding

- D1 → raw files: complete (section A). D3 → budget rule and D1 constraints with the stated margins: holds (section B). Compact frame ↔ consumers and §4.5: complete and bound (section C). Delivery-context causality on WS and in the relay's lifecycle: holds; WT: finding 1. D4 under `check-official-io`: specifiable (section F). B5 totals and 9.6 literals: consistent (section G). `stage-live-campaign.ts abandon`: exists. `2026-09-08-a5-admission-gates-before-traps.md`: exists; the other two deviation files are to be created as D6 says.
- Rig state during this review: load idle, MemAvailable 6,771 MB, swap 3,411 MB used (matches D1), no `/tmp/amendment-review-*` created.

## Two-perspective note

- Perfectionist: four text defects in a document that will be hashed into every grant (`approvedPlanSha256`) are four things the exact-stage reviews can never repair; fix them before the hash exists.
- Pragmatist: the measurements are right, the rows are right, and each blocking item is a paragraph. One revision cycle, then Critic.
