APPROVED

# Critic review R6 — physical-budget amendment (compact delivery frames, hardware-derived cells)

Reviewer: Claude (Critic pass, revision R6), 2026-09-08. Git read-only (`git status --porcelain | grep -v '^??' | wc -l` → 0 before and after; only this file written). No campaign, stage, controller or rig write; nothing under `.release-evidence/`, `/var/db/webtransport-bun`, `/usr/local/libexec/webtransport-bun`, the rig stage dirs or keys touched. Rig access: one read-only ssh (`hermes-admin@10.99.0.2`: `/proc/loadavg` → 0.00 0.02 0.00; `ls -d /tmp/amendment-review-*` → 0; `pgrep -af 'amendment-review|combined-relay|fanout-physical'` minus the pgrep shell → 0; `eno1/speed` → 1000). No new measurement was taken: every utilisation figure was recomputed from the R2/R3 raw files in this session's scratchpad (`scratchpad/r2/raw/`, `scratchpad/r3/raw/`) and the R3 harness source (`scratchpad/r3/combined-relay-wt.ts`) was read to establish how its origin windows were stamped. The Architect R6 artifact was read first and then treated as untrusted; every claim in it I rely on was re-executed. Both R5 artifacts were read first.

## Bindings

- Amendment SHA-256: `c98fdb39f6a05cdd473b88a3dcaac943ed3e6fd809593e1898e9f992d5d6d073` (`shasum -a 256 docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, 161 lines, revision R6; matches the dispatch SHA)
- Base plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Candidate HEAD: `efaed8bb0af82a499ca58b2627ea251efced41c5` (`git rev-parse HEAD`; tracked tree clean; the amendment and the review artifacts are untracked)
- Architect R6 artifact SHA-256: `32fd673b9f799dd017a2aee81639fbe8a2ca5766f24cb5b904169732fefb75c3` (read, then re-verified; not trusted)
- R5 pair: critic (my own, amendment SHA `25b4606a…`), architect (`65e68ca8…` as I recorded in R5). R5's bytes are not on disk; the R6 diff was checked against the R5 pair's quotations plus a stale-string sweep (§C).

## Verdict in one paragraph

Nothing blocking remains. My R5 blocking finding closes exactly as I required it: D4 line 125 now defines **binding ingress** as the row's window total at the binding rate (ticker 2,500 = 250/s × 10 s; chat 600 = 20/s × 30 s, "i.e. 250 and 20 per 1 s window"), and line 126 binds the 2× pass at "**ticker 500, chat 40 per 1 s window**" beside the 1× pass's "ticker 250, chat 10". Recomputed on all six D3 rows (§A): the 2× predicate binds 100 / 200 / 500 per window on the ticker rows and 40 on every chat row; 1× pacing (50 / 100 / 250; 10) satisfies the 2× predicate on no row; on the two rows D4 runs the line-124 offer is exactly 2.00× the binding load; the rate reading that produced R5's "50" (`2 × 250 ÷ 10`, and `2 × 20 ÷ 30 = 1.33` for chat) is excluded by the definition. I attacked the definition for a way to pass either predicate at less than the rule's load (§B) and found none: the origin window index is stamped by the publisher from its scheduled offset (`fanout-role.ts:1512`, `Number(offsetNs / 1 s)`), so the count is per origin window and cannot be front-loaded, wall-clock jittered or averaged; `O = A` plus zero refusals plus `D = A × K` on the Mac closes the relay and the consumer sides; the per-row binding ingress is a fixed number, not a run-time reading. The three ticker 500/s raw runs already satisfy the corrected predicate by construction (§A): the R3 harness stamps `windowIndex = floor(i / RATE)` (`combined-relay-wt.ts:214`), so each of the 10 origin windows carries exactly 500, all 5,000 offered were accepted with zero refusals, and the main-thread means are 0.762 / 0.750 / 0.776 with `writesCompleted = expectedWrites` and zero faults — inside the 0.80 bound; no row retires. Every carried non-blocking item is present and correct against HEAD (§C). Approval is unconditional; the items in the closing list are wording and implementer carries.

## R5 findings closure

Critic R5 (1 blocking + 2–9):

| # | R5 finding | Status | Evidence (executed this pass) |
|---|---|---|---|
| 1 | BLOCKING — ticker 2× example "50 per 1 s window"; "binding ingress" undefined | **CLOSED** | Line 125 (inserted; 160 → 161 lines): "definitions: the **binding ingress** of a row is its window total at the binding rate — ticker 2,500 (250/s × 10 s), chat 600 (the warmup epoch's 20/s × 30 s), i.e. 250 and 20 per 1 s window". Line 126: "in the 1× pass `A_origin[w] = row ingress ÷ windows` (ticker 250, chat 10 per 1 s window); in the 2× pass `A_origin[w] ≥ 2 × binding ingress ÷ windows` (**ticker 500, chat 40 per 1 s window**), so an under-offering pass cannot satisfy the predicate at 1× pacing". `grep -c -F 'ticker 50 per 1 s window'` → 0. `python3`: `2*2500/10, 2*600/30` → `500.0 40.0`; excluded reading `2*250/10, 2*20/30` → `50.0 1.333`. Line 124's offer ("ticker 500/s for 10 s … chat **40/s for 30 s**") is the R5 text unchanged. §A table: 1× pacing meets the 2× predicate on no row. This is my R5 required text ("window total at the binding rate … ticker 2,500; chat 20/s × 30 s = 600 — ticker 500 per 1 s window; chat 40"). |
| 2 | Line 72 "R4 keeps" | **CLOSED** | Line 72: "This amendment keeps the request at accepted subscriber registration and **removes the lazy fallback**"; `grep -c -F 'R4 keeps'` → 0. |
| 3 | Parenthetical timed/process figures are medians under a "means" header | **CLOSED** | Line 39: "(timed 0.29, process 1.74 — parenthetical timed/process figures are per-1 s medians, ≤0.04 from their means, ungated)". Recomputed from `series[].busyFrac` / `processCores` (median / mean): r3 1× 0.29/0.29 · 1.74/1.77; r3 2× 0.47/0.48 · 3.05/3.09; chat warm1x 0.14/0.14 · 1.15/1.18; warm2x 0.23/0.24 · 1.96/1.99 — every printed parenthetical is the median and every gap ≤ 0.04, as the label says. |
| 4 | Line 126 "around a 0.75 mean" | **CLOSED** | Line 127: "spread 0.72–0.87 around means of 0.75–0.78"; `grep -c -F 'around a 0.75 mean'` → 0. Recomputed `mainThreadCore` means: `r3/raw/…-r500-r3d4v2-b` 0.762 (min 0.719, max 0.869 → "0.72–0.87" ✓), `r2/raw/…-r500-d4v2` 0.750, `r2/raw/…-r500-smoke` 0.776 → "0.75–0.78" ✓. |
| 5 | `:996` attributed to `openMeasuredWindow` | **CLOSED** | Line 82: "`openMeasuredWindow` requires `warmup-drained`, which `drainWarmup()` refuses to reach while `queuedItems !== 0`, `:996`"; `grep -c -F 'openMeasuredWindow\` refuses'` → 0. `awk 'NR>=940&&NR<=1085&&/^\t[a-zA-Z_]+\(/' tools/compare/scenarios/fanout-relay.ts` → `980: drainWarmup()`, `1077: openMeasuredWindow(`; `sed -n '689p;762p;857p;996p;1025p;1079,1080p'` → `REGISTRATION_CLOSED` (689), `bindWarmupEpoch` guard `!== "registration"` (762), `phaseValue = "warmup"` (857), `if (this.queuedItems !== 0) {` (996), `phaseValue = "warmup-drained"` (1025), `if (this.phaseValue !== "warmup-drained") {` (1080). |
| 6 | Per-publisher "bursts of 10" is the aggregate shape (informational) | **CLOSED** on line 39; line 41 keeps the loose phrase (carry 1) | Line 39: "(each of the 10 publishers sends one frame per 500 ms at its `WARMUP_OFFSETS_MS` slot, 10 ingress per 500 ms in aggregate, 20,000 deliveries/s)". `sed -n 113,120p tools/compare/cohort-protocol.ts` → `WARMUP_MESSAGES_PER_PUBLISHER = 10`, `WARMUP_INTERVAL_MS = 500`, `WARMUP_DURATION_MS = 5_000`, `WARMUP_OFFSETS_MS` = `index * WARMUP_INTERVAL_MS` for 10 indexes, "no catch-up burst"; `sed -n 1312,1340p tools/compare/bin/fanout-role.ts` → `for (const offsetMs of WARMUP_OFFSETS_MS) { await clock.sleepUntilNs(…); … await session.send({ kind: "warmup-data", … }) }` — one frame per slot per publisher. `grep -n -F 'in bursts of 10'` → 41 (per publisher, loose), 112, 114 (aggregate, correct). |
| 7 | `const snapshot` is `server.ts:2598` | **CLOSED** | Line 142: "(`server.ts:2596-2619`, `const snapshot` at `:2598`)"; `sed -n '2596,2599p;2618p' tools/compare/server.ts` → comment, `const windowMs`, `const snapshot = {`, `schema: "server-loop-utilization/v1"`, `busyMs: finalBusyMs - baselineBusyMs`. |
| 8 | Test-file count "24–26 by pattern" | **CLOSED** (wording carry 2) | Line 116: "(22 by id, more by label; slice 3 sweeps both patterns)"; `grep -c -F '24–26 by pattern'` → 0. Executed: by retired id only → **19**; by id or label (`ticker (10k|50k|100k)|chat (5k|10k)`, `evidence.ts:154-159`) → **22**; adding `TICKER_?10K|CHAT_?(5K|10K)` → 22. So "22 by id" is the id-or-label count; lines 152 and 161 still say "26 test files". The sweep's output is the contract, not either count. |
| 9 | Implementer carry — slice 5's 2× pass needs its own pacing input; record the offered rate | **CLOSED** in text (implementer carry 3 stands) | Line 154: "`bin/fanout-physical-preflight.ts` with its own pacing input for the 2× pass (the grant's pacing is the 1× pass; the 2× offer is a preflight parameter recorded in the receipt as the offered rate per pass, never a grant field)". |

Architect R5 (1 blocking + 2–5): 1 (the same ticker-50 slip) **CLOSED** as Critic 1; 2 ("R4 keeps") **CLOSED** as Critic 2; 3 (parenthetical medians) **CLOSED** as Critic 3; 4 (`server.ts:2598`) **CLOSED** as Critic 7; 5 (test-file count) **CLOSED** as Critic 8 (carry 2).

Carried R4 informational (Critic R4 6: `CHAT_10K_*` bounds stay valid; the receipt names the CPU instrument): still an implementer carry (carry 4); nothing in the text was required.

R1–R4 residue: none reopened. Line 4's revision note lists exactly what changed (§C).

## Blocking findings

None. Nothing blocking remains.

## Non-blocking findings (carry into the slices; none changes a number, a record or a mechanism)

### 1. D1 line 41 still says "each publisher offers 2 ingress/s for 5 s in bursts of 10"

Per publisher the warmup is one frame per 500 ms (`WARMUP_OFFSETS_MS`, `fanout-role.ts:1312-1338`); "bursts of 10" is the 10-publisher aggregate that lines 39/112/114 name correctly. Every number on line 41 is right (2/s × 5 s = 10 per publisher; ticker 2/s × K; chat 20/s × K). Wording only, ungated. Command: `grep -n -F 'in bursts of 10' <amendment>` → 41, 112, 114.

### 2. Line 116 "22 by id" is the id-or-label count; lines 152/161 say "26 test files"

Executed counts above: 19 by bare id, 22 by id or label. The conformance test plus slice 3's two-pattern sweep is the guard; the implementer must not treat 19, 22 or 26 as a completion criterion. Command: `git grep -lE 'ticker-fanout/rate-(10000|50000|100000)|chat-fanout/subscribers-(5000|10000)' -- 'tools/**/*.test.ts' | wc -l` → 19; with `|ticker (10k|50k|100k)|chat (5k|10k)` → 22.

### 3. Slice 5 carries (the text now states them; the slice must build them)

- The 2× pass paces the production publisher child through its `messageRatePerSecond` config (the field the controller derives from the cell at `compare-controller.ts:5308-5309` and hands the child at `:5365`; the child derives `totalMessages` and each frame's `originWindowIndex = Number(offsetNs / 1 s)` from it, `fanout-role.ts:1501-1512`): 500 for ticker, 4 per chat publisher (40 ÷ 10). Because the origin window is stamped from the scheduled offset, the 2× pass produces exactly 500 / 40 per origin window by construction, so `A_origin[w] ≥ 500 / 40` is met exactly when the relay accepts everything, and `totalMessages` (5,000; 120 per chat publisher) stays a safe integer. The preflight input must be preflight-only (never the grant's `ingressRatePerSecond`), and the receipt records the offered rate per pass.
- The receipt's "offered and accepted ingress per window" (line 129) must be the **origin-window** counts (`acceptedIngressByOriginWindow`, as the predicate at line 126 is written), not wall-clock 1 s samples: the raw files' wall-clock deltas at a 500/s offer read 498–509 per second (§A), which would fail an `= 250` / `≥ 500` test if a wall-clock series were substituted for the origin-window counts.
- The chat 2× pass is paced (4/s per publisher) while the R3 evidence for it used bursts of 20 per 500 ms (`perBurst 20`) — the raw evidence is the harsher shape (mean 0.551, max 0.68); the paced pass is expected to read at or below it. Accepted at R5; recorded so the implementer does not "match the shape" by adding a burst option to the production child.

### 4. Slice 4 / D6 carries (Critic R4 6)

The receipt names which instrument produced each CPU figure (`(utime+stime)` delta vs `onRelayWork` spans); `secure_fs.rs:12119-12121` `CHAT_10K_*` bounds stay valid as bounds — leave or rename, never shrink. D4's parenthetical medians are informational; the gated statistic is the whole-window mean (lines 51, 112, 127).

### 5. Revision-identity edits outside the dispatch list (expected, not a finding)

Line 4 (revision note), line 17 (`-r6.md` artifact names) and the reordering of the 1× clause inside line 126's predicate sentence. `sed -n '4p;17p' | grep -o 'Revision:\*\* R6\|-r6.md\`'` → both present; `grep -c -F -e '-r5.md\`; the canonical'` → 0.

## A. D4 predicate under the R6 definition, all six rows, and the ticker 500/s raw runs against it (recomputed)

`binding rate` = max(measured deliveries/s, warmup deliveries/s) (D1 line 49); warmup = 2 ingress/s per publisher; `binding ingress` = binding ingress rate × window seconds (line 125); 2× predicate = `2 × binding ingress ÷ windows` (line 126). `python3` over the D3 table:

| Row | P | K | W | 1× `A[w]` | binding ing/s | **binding ingress** | **2× `A[w] ≥`** | 2× offer ing/s (line 124) | offer ÷ binding | 1× pacing passes 2×? | `D_warmup` |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|
| ticker rate-50 | 1 | 100 | 10 | 50 | 50 | 500 | 100 | 100 | 2.00 | no | 1,000 |
| ticker rate-100 | 1 | 100 | 10 | 100 | 100 | 1,000 | 200 | 200 | 2.00 | no | 1,000 |
| **ticker rate-250** | 1 | 100 | 10 | 250 | 250 | **2,500** | **500** (line 126 ✓) | 500 (line 124 ✓) | 2.00 | **no (250 < 500)** | 1,000 |
| chat 250 | 10 | 250 | 30 | 10 | 20 | 600 | 40 | 40 | 2.00 | no | 25,000 |
| chat 500 | 10 | 500 | 30 | 10 | 20 | 600 | 40 | 40 | 2.00 | no | 50,000 |
| **chat 1k** | 10 | 1,000 | 30 | 10 | 20 | **600** | **40** (line 126 ✓) | 40 (line 124 ✓) | 2.00 | **no (10 < 40)** | 100,000 |

Line 125's "i.e. 250 and 20 per 1 s window" = 2,500 ÷ 10 and 600 ÷ 30 ✓. Excluded rate reading: 50.0 / 1.33.

Raw files, `series[].mainThreadCore` (one wall-clock sample per second, no filter) and conservation:

| Raw file | Load | n | Mean | Median | Min | Max | O = A | W = E | refusals · wto · qdrop · faults | qpeak | wall-clock offered per 1 s | Printed |
|---|---|--:|--:|--:|--:|--:|---|---|---|--:|---|---|
| `r3/raw/combined-k100-p1-n100-r250-r3row1x-b-server.json` | ticker 1× | 9 | **0.429** | 0.420 | 0.390 | 0.470 | 2,500 = 2,500 | 250,000 | 0 · 0 · 0 · 0 | 100 | 249–251 | 0.43 ✓ |
| `r2/raw/combined-k100-p1-n100-r250-row1x-server.json` | ticker 1× | 9 | **0.449** | 0.449 | 0.420 | 0.480 | 2,500 = 2,500 | 250,000 | 0 · 0 · 0 · 0 | 100 | 249–251 | 0.45 ✓ |
| `r3/raw/combined-k100-p1-n100-r500-r3d4v2-b-server.json` | ticker 2× | 9 | **0.762** | 0.751 | 0.719 | 0.869 | 5,000 = 5,000 | 500,000 | 0 · 0 · 0 · 0 | 100 | 499–509 | 0.75–0.78 ✓; 0.72–0.87 ✓ |
| `r2/raw/combined-k100-p1-n100-r500-d4v2-server.json` | ticker 2× | 9 | **0.750** | 0.740 | 0.719 | 0.830 | 5,000 = 5,000 | 500,000 | 0 · 0 · 0 · 0 | 100 | 498–503 | ✓ |
| `r2/raw/combined-k100-p1-n100-r500-smoke-server.json` | ticker 2× | 9 | **0.776** | 0.770 | 0.730 | 0.850 | 5,000 = 5,000 | 500,000 | 0 · 0 · 0 · 0 | 100 | 499–504 | 0.78 ✓ |
| `r3/raw/combined-k1000-p10-n128-r20-r3warm1x-server.json` | chat 1k warmup shape (perBurst 10) | 29 | **0.330** | 0.320 | 0.180 | 0.465 | 600 = 600 | 600,000 | 0 · 0 · 0 · 0 | 2,464 | 20 (30 once) | 0.33 ✓ |
| `r3/raw/combined-k1000-p10-n128-r40-r3warm2x-server.json` | chat 1k 2× (perBurst 20) | 29 | **0.551** | 0.540 | 0.360 | 0.680 | 1,200 = 1,200 | 1,200,000 | 0 · 0 · 0 · 0 | 2,464 | 40 (60 once) | 0.55 ✓; max 0.68 ✓ |

**The ticker 500/s runs satisfy the corrected predicate.** The harness pre-encodes `TOTAL = RATE × WINDOW_MS / 1000 = 5,000` frames with `windowIndex = min(WINDOWS − 1, floor(i / RATE))` (`scratchpad/r3/combined-relay-wt.ts:209-215`), i.e. exactly 500 frames stamped per origin window 0…9; `offered 5,000 = accepted 5,000` with `ingressRefusals 0` means every one of those was accepted, so `A_origin[w] = 500 ≥ 500` in every window (`O_origin[w] = A_origin[w]` likewise); `writesCompleted 500,000 = expectedWrites`, `faultCount 0`, `writeTimeouts 0`, `queueDrops 0`; means 0.762 / 0.750 / 0.776 ≤ 0.80. The wall-clock 1 s deltas (498–509) are sampler artefacts, not origin-window counts — the reason carry 3 asks the preflight receipt to record origin-window counts. No row retires.

## B. Attack on the binding-ingress definition: can either pass be met with less than the rule's load?

- **Under-offer at 2×.** The predicate is per origin window, `A_origin[w] ≥ 500` (ticker) / `≥ 40` (chat), for every `w`. A publisher pacing at 1× stamps 250 / 10 per window (`fanout-role.ts:1512`) and fails every window; a front-loaded offer (1,000 in window 0, 0 after) fails windows 1…9; a late start fails window 0. `windows` is the cell's `windowCount` (10 / 30, ≤ `FANOUT_MAX_WINDOW_COUNT` 30), not a preflight parameter, so the divisor cannot be enlarged to shrink the per-window bound. Rate-reading the term is excluded by line 125's "window total".
- **Relay refusing to make `O = A` hold.** `O = A` is required in every window and "zero ingress refusals" is required separately (line 126), so refusing offered ingress to keep utilisation low fails the pass on both.
- **Mac under-counting.** `D = A × K` is counted by the production 8-worker consumption, with zero `SUBSCRIBER_QUEUE_FULL`, zero write-timeout and zero malformed required; a relay that accepts but does not deliver fails `D = A × K`.
- **Chat's binding through the warmup epoch.** The 1× pass gates the 5 s warmup epoch at ≤ 0.50 (line 127) with `D_warmup = 10 × P × K` on the Mac (line 126), so the load that binds chat (20 ingress/s) is measured in the 1× pass at the code's own pacing, not asserted; the 2× pass's 40/s for 30 s is 2× that load in deliveries/s on every chat row (§A). "The warmup epoch's 20/s × 30 s" fixes the window to the measured window, so the 5 s epoch length cannot be substituted to make binding ingress 100.
- **Transport.** The predicate, the bound and the counters are the same on WS and WT; nothing lets one transport's pass bind lower.
- **Utilisation bound alone.** It is the mean over the whole window from `/proc/<pid>/task/<pid>/stat` (utime+stime), the same statistic as the mean of the 1 s deltas (§A), on the real `sudo -u _wtcompare` child; the count predicates above are what make the reading a 2× reading. With `A ≥ 500` there is no load below 2× at which the ticker pass can read.

No vacuous path found. The one place a correct pass could fail spuriously — comparing origin-window predicates against wall-clock samples — is a receipt-construction detail, carried to slice 5 (carry 3), not a defect in the text (line 126 writes `O_origin[w]` / `A_origin[w]`).

## C. The R6 change list, item by item (executed), and "nothing else changed"

| Claimed change | Line | Correct |
|---|---|---|
| D4 definitions: binding ingress = window total at the binding rate, ticker 2,500 / chat 600 | 125 | ✓ (§A) |
| 2× predicate example ticker 500 / chat 40; 1× ticker 250 / chat 10 | 126 | ✓ (§A) |
| "R4 keeps" → "This amendment keeps" | 72 | ✓ |
| parenthetical medians note | 39 | ✓ (recomputed; gaps ≤ 0.04) |
| "0.75 mean" → "means of 0.75–0.78" | 127 | ✓ (0.762 / 0.750 / 0.776) |
| `:996` attributed to `drainWarmup()` | 82 | ✓ (`:980/:996/:1025/:1077/:1080`) |
| warmup burst shape per publisher / aggregate | 39 | ✓ (`cohort-protocol.ts:113-120`, `fanout-role.ts:1312-1338`); line 41 unchanged (carry 1) |
| `server.ts:2598` | 142 | ✓ |
| test-file count "22 by id" | 116 | present; id-or-label count (carry 2) |
| slice 5 pacing input + offered rate per pass | 154 | ✓ |
| revision note / `-r6` artifact names | 4, 17 | ✓ |
| "Nothing else changed" | — | Stale sweep → 0 for each of: `R4 keeps`, `ticker 50 per 1 s window`, `around a 0.75 mean`, `openMeasuredWindow\` refuses`, `24–26 by pattern`, `Revision:** R5`, `-r5.md\`; the canonical`, `chat 20/s for 30 s`, `0.74–0.76`, `registered late`, `89 tracked`, `twice the row's ingress rate`, `2× 0.54`, `not a warmup-tagged compact frame`. The R5-verified text I re-read at lines 21, 47–51, 72, 74, 82, 84–95, 112, 114, 116, 120–124, 129, 135–138, 142 is the text the R5 pair quoted; the only in-sentence reorder is line 126's 1× clause (carry 5). Line count 160 → 161 = the inserted definitions bullet. |

Spot-checks of unchanged citations against HEAD this pass: `fanout-relay.ts:689/:762/:857/:980/:996/:1025/:1077/:1080`; `server.ts:2596-2599/:2618`; `cohort-protocol.ts:113-120`; `fanout-role.ts:1312-1340` (warmup loop, "did not offer exactly ten" at `:1340`), `:1455/:1468/:1525` (`windowIndex` sites), `:1501-1512` (measured pacing); `compare-controller.ts:4631-4634` (`publisherRatePerSecond`), `:5308-5312` (`messageRatePerSecond` whole-rate check), `:5365` (handed to the child); `evidence.ts:154-159` (labels); `.scratch/2026-09-08-physical-budget/{link-and-transport,relay-cpu-and-encoding,sessions-fds-memory}/REPORT.md` exist.

## Non-blocking items an implementer must carry (consolidated)

1. Line 41 "in bursts of 10" is the aggregate shape; per publisher it is one frame per 500 ms — wording only (finding 1).
2. Test-file counts (19 by id / 22 by id-or-label / "26" at lines 152, 161) are not a completion criterion; slice 3's two-pattern sweep output is (finding 2).
3. Slice 5: 2× pacing through the child's `messageRatePerSecond` (500 ticker; 4 per chat publisher) as a preflight-only input, never a grant field; record the offered rate per pass; the receipt's per-window offered/accepted are origin-window counts, not wall-clock samples; the chat 2× pass is paced, and its R3 evidence is the harsher burst shape (finding 3).
4. Slice 4 / D6: the receipt names the instrument behind each CPU figure; `secure_fs.rs:12119-12121` `CHAT_10K_*` bounds stay valid as bounds (leave or rename, never shrink); parenthetical medians are informational, the mean is gated (finding 4).
5. Lines 4 / 17 / 126 carry revision-identity edits — expected (finding 5).

## Cleanup

Nothing was created on the rig (`ls -d /tmp/amendment-review-*` → 0; no process of mine). Local: only this file written; `git status --porcelain | grep -v '^??' | wc -l` → 0.

## Two-perspective note

- Perfectionist: the fix is the one-number-one-definition diff both R5 passes asked for, verifiable by arithmetic on all six rows and by construction on the three 500/s raw runs; what remains is two loose phrases (line 41, line 116's "by id") and a receipt-construction detail (origin-window vs wall-clock counts) that the text already gets right and only the slice can get wrong.
- Pragmatist: every mechanism, number, record, mirror and offset was executed across R4–R6; the 2× gate now binds 2× on both rows D4 runs and the true 2× measurements already pass it with margin. Approve; slices 1–6 carry the five notes above.
