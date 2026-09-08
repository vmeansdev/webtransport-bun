APPROVED

# Architect review R6 — physical-budget amendment (compact delivery frames, hardware-derived cells)

Reviewer: Claude (Architect pass, revision R6), 2026-09-08. Git read-only (`git status --porcelain | grep -v '^??' | wc -l` → 0 before and after; only this file written). No campaign, stage, controller or rig write; nothing under `.release-evidence/`, `/var/db/webtransport-bun`, `/usr/local/libexec/webtransport-bun`, the rig stage dirs or keys touched. Rig access: one read-only ssh (`hermes-admin@10.99.0.2`: `/proc/loadavg` → 0.00 0.02 0.00; `ls -d /tmp/amendment-review-*` → 0; `pgrep -af 'amendment-review|combined-relay|fanout-physical'` minus the pgrep shell → 0; `eno1/speed` → 1000). No new measurement was taken; the utilisation figures were recomputed from the R2/R3 raw files still in this session's scratchpad (`scratchpad/r2/raw/`, `scratchpad/r3/raw/`), and every citation R6 touched was re-executed against HEAD. Both R5 artifacts were read first.

## Bindings

- Amendment SHA-256: `c98fdb39f6a05cdd473b88a3dcaac943ed3e6fd809593e1898e9f992d5d6d073` (`shasum -a 256 docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, 161 lines — R5 was 160; the D4 definitions bullet is the inserted line — revision R6; matches the dispatch SHA)
- Base plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Candidate HEAD: `efaed8bb0af82a499ca58b2627ea251efced41c5` (`git rev-parse HEAD`; tracked tree clean; the amendment and the review artifacts are untracked)
- R5 pair read first: `reviews/2026-09-08-physical-budget-architect-r5.md`, `reviews/2026-09-08-physical-budget-critic-r5.md` (Critic recorded the Architect R5 SHA as `65e68ca8…`). R5's bytes are not on disk (`find <worktree> <scratchpad> -name '*physical-budget-amendment*'` → the R6 file only), so "nothing else changed" was checked by re-grepping every phrase the R5 pair quoted from R5 (§C) plus a stale-string sweep.

## Verdict in one paragraph

Nothing blocking remains. The one R5 refusal is closed by execution: D4 now defines **binding ingress** as the row's window total at the binding rate (line 125: ticker 2,500 = 250/s × 10 s; chat 600 = 20/s × 30 s, "i.e. 250 and 20 per 1 s window") and the 2× predicate example reads "**ticker 500, chat 40 per 1 s window**" with the 1× example "ticker 250, chat 10" beside it (line 126). Recomputed for all six D3 rows (§A): the 2× predicate binds 100 / 200 / **500** per window on the ticker rows and 40 on every chat row; the 1× pacing delivers 50 / 100 / 250 and 10; no row's 1× pacing satisfies its 2× predicate, and on the two rows D4 runs the 2× offer (500/s, 40/s) is exactly 2.00× the binding load. The rate-reading that produced R5's "50" (`2 × 250 ÷ 10`) is now excluded by the definition. Every carried non-blocking item is present and correct against HEAD: "This amendment keeps" (line 72), the parentheticals labelled per-1 s medians ≤ 0.04 from their means (line 39, recomputed: gaps 0.00–0.04), "means of 0.75–0.78" (line 127; means 0.762 / 0.750 / 0.776), the `:996` refusal attributed to `drainWarmup()` with `openMeasuredWindow` requiring `warmup-drained` (line 82; `drainWarmup` at `fanout-relay.ts:980`, refusal `:996`, phase set `:1025`, `openMeasuredWindow :1077`, guard `:1080`), the warmup shape stated per publisher and in aggregate (line 39; `WARMUP_OFFSETS_MS` 0…4500 at `cohort-protocol.ts:116-120`, one `session.send` per offset at `fanout-role.ts:1312-1338`), `const snapshot` at `server.ts:2598`, "22 by id, more by label" (line 116), and slice 5's own pacing input with the offered rate recorded per pass (line 154). No phrase either R5 reviewer quoted as unchanged is missing, and no stale R4/R5 wording survives. Approval is unconditional; the items below are wording and implementer carries only.

## R5 findings closure

Architect R5:

| # | R5 finding | Status | Evidence (executed this pass) |
|---|---|---|---|
| 1 | BLOCKING — 2× predicate example "ticker 50 per 1 s window"; "binding ingress" undefined | **CLOSED** | Line 125 (new): "definitions: the **binding ingress** of a row is its window total at the binding rate — ticker 2,500 (250/s × 10 s), chat 600 (the warmup epoch's 20/s × 30 s), i.e. 250 and 20 per 1 s window". Line 126: "in the 1× pass `A_origin[w] = row ingress ÷ windows` (ticker 250, chat 10 per 1 s window); in the 2× pass `A_origin[w] ≥ 2 × binding ingress ÷ windows` (**ticker 500, chat 40 per 1 s window**), so an under-offering pass cannot satisfy the predicate at 1× pacing". `grep -c -F 'ticker 50 per 1 s window'` → 0. `python3 -c "print(2*2500/10, 2*600/30)"` → `500.0 40.0`; the excluded rate reading `print(2*250/10, 2*20/30)` → `50.0 1.333`. §A table: 1× pacing meets the 2× predicate on no row. Line 124's offer ("ticker 500/s for 10 s … chat **40/s for 30 s**") is byte-identical to R5. |
| 2 | Line 72 "R4 keeps" | **CLOSED** | Line 72: "This amendment keeps the request at accepted subscriber registration and **removes the lazy fallback**"; `grep -c -F 'R4 keeps'` → 0. |
| 3 | Parenthetical timed/process figures are medians under a "means" header | **CLOSED** | Line 39: "(timed 0.29, process 1.74 — parenthetical timed/process figures are per-1 s medians, ≤0.04 from their means, ungated)". Recomputed (`series[].busyFrac` / `processCores`, median/mean): r3 1× 0.29/0.29 · 1.74/1.77; r3 2× 0.47/0.48 · 3.05/3.09; chat warm1x 0.14/0.14 · 1.15/1.18; warm2x 0.23/0.24 · 1.96/1.99 — every printed parenthetical is the median and every gap ≤ 0.04, as the label now says. |
| 4 | `const snapshot` is `server.ts:2598` | **CLOSED** | Line 142: "(`server.ts:2596-2619`, `const snapshot` at `:2598`)"; `sed -n '2596,2599p;2618p' tools/compare/server.ts` → `:2596` comment, `:2597` `const windowMs`, `:2598` `const snapshot = {`, `:2599` `schema: "server-loop-utilization/v1"`, `:2618` `busyMs: finalBusyMs - baselineBusyMs`. |
| 5 | Test-file count "24–26 by pattern" | **CLOSED** (wording carry, non-blocking 2 below) | Line 116: "(22 by id, more by label; slice 3 sweeps both patterns)"; `grep -c -F '24–26 by pattern'` → 0. Executed counts in non-blocking 2. |

Critic R5:

| # | R5 finding | Status | Evidence |
|---|---|---|---|
| 1 | BLOCKING — ticker 2× example 50, "binding ingress" undefined | **CLOSED** | As Architect 1. The Critic's required text ("window total at the binding rate … ticker 2,500; chat 20/s × 30 s = 600 — ticker 500 per 1 s window; chat 40") is what line 125–126 now says. |
| 2 | "R4 keeps" | **CLOSED** | As Architect 2. |
| 3 | Parentheticals are medians | **CLOSED** | As Architect 3. |
| 4 | Line 126 "around a 0.75 mean" | **CLOSED** | Line 127: "(per-1 s readings at the ticker 2× point spread 0.72–0.87 around means of 0.75–0.78)"; `grep -c -F 'around a 0.75 mean'` → 0. Recomputed `mainThreadCore` means: `r3/raw/…-r500-r3d4v2-b-server.json` 0.762 (min 0.719, max 0.869 → "0.72–0.87" ✓), `r2/raw/…-r500-d4v2-server.json` 0.750, `r2/raw/…-r500-smoke-server.json` 0.776 → "0.75–0.78" ✓. |
| 5 | `:996` attributed to `openMeasuredWindow` | **CLOSED** | Line 82: "both enqueue points see empty delivery queues (`bindWarmupEpoch` requires phase `registration`; `openMeasuredWindow` requires `warmup-drained`, which `drainWarmup()` refuses to reach while `queuedItems !== 0`, `:996`)"; `grep -c -F 'openMeasuredWindow\` refuses'` → 0. `awk 'NR>=940&&NR<=1085&&/^\t[a-zA-Z_]+\(/' tools/compare/scenarios/fanout-relay.ts` → `980: drainWarmup()`, `1077: openMeasuredWindow(`; `sed -n '996p;1025p;1080p'` → `if (this.queuedItems !== 0) {`, `this.phaseValue = "warmup-drained";`, `if (this.phaseValue !== "warmup-drained") {`; `:762` `bindWarmupEpoch` guard `!== "registration"`. |
| 6 | Per-publisher "bursts of 10" is the aggregate shape (informational) | **CLOSED** on line 39 (line 41 keeps the loose phrase — non-blocking 1) | Line 39: "chat 1k at its warmup shape (each of the 10 publishers sends one frame per 500 ms at its `WARMUP_OFFSETS_MS` slot, 10 ingress per 500 ms in aggregate, 20,000 deliveries/s)". `sed -n 113,120p tools/compare/cohort-protocol.ts` → `WARMUP_MESSAGES_PER_PUBLISHER = 10`, `WARMUP_INTERVAL_MS = 500`, `WARMUP_DURATION_MS = 5_000`, "Ordered offsets 0,500,...,4500 ms from `startAtMacNs`; no catch-up burst"; `sed -n 1312,1340p tools/compare/bin/fanout-role.ts` → `for (const offsetMs of WARMUP_OFFSETS_MS) { await clock.sleepUntilNs(…); … await session.send({ kind: "warmup-data", … }) }` — one frame per slot per publisher, 10 publishers on the same `startAtMacNs` → 10 per 500 ms aggregate; raw `r3warm1x` `perBurst 10`, `r3warm2x` `perBurst 20`. |
| 7 | `server.ts:2598` | **CLOSED** | As Architect 4. |
| 8 | Test-file count | **CLOSED** (carry) | As Architect 5. |
| 9 | Implementer carry — slice 5 must give the 2× pass its own pacing input and record the offered rate | **CLOSED** in text (implementer carry stands, non-blocking 3) | Line 154: "`bin/fanout-physical-preflight.ts` with its own pacing input for the 2× pass (the grant's pacing is the 1× pass; the 2× offer is a preflight parameter recorded in the receipt as the offered rate per pass, never a grant field)". |

Carried R4 informational (Critic R4 6: `CHAT_10K_*` bounds stay valid, receipt names the instrument): still an implementer carry (non-blocking 3); nothing in the text was required.

R1–R4 residue: none reopened. Line 4's revision note ("R5 closed every R4 finding; both R5 passes refused on one arithmetic slip … R6 fixes that and the carried non-blocking items (line 72 wording, medians-vs-means parenthetical, the `:996` attribution, the warmup burst shape, `server.ts:2598`, the test-file count, the preflight's pacing input). Nothing else changed.") matches what changed (§C).

## Blocking findings

None.

## Non-blocking findings (carry into the slices; none changes a number, a record or a mechanism)

### 1. D1 line 41 still says "each publisher offers 2 ingress/s for 5 s in bursts of 10"

The warmup-shape fix landed on line 39 (correct: per publisher one frame per 500 ms; 10 per 500 ms in aggregate for chat). Line 41's per-publisher phrase is the one Critic R5 6 quoted and is still loose: per publisher it is one frame per 500 ms, never a burst of 10. Every number on the line is right (2 ingress/s per publisher × 5 s = 10; ticker 2/s × K = 200 deliveries/s; chat 20/s × K = 2× the measured rate). Wording only, ungated. Command: `grep -n -F 'in bursts of 10' <amendment>` → 41 (per-publisher), 112, 114 (aggregate, correct).

### 2. Test-file count: "22 by id" is the id-or-label count; by bare id it is 19; slice 3 and risk (3) still say "26 test files"

Executed: `git grep -lE 'ticker-fanout/rate-(10000|50000|100000)|chat-fanout/subscribers-(5000|10000)' -- 'tools/**/*.test.ts' | wc -l` → **19**; adding the labels (`ticker (10k|50k|100k)|chat (5k|10k)`, `evidence.ts:154-159`) → **22**; the constant-name variants (`TICKER_?10K|CHAT_?(5K|10K)`) add none. Line 116 says "22 by id, more by label"; lines 152 and 161 say "the 26 test files". The conformance test is the guard and slice 3 "sweeps both patterns" — the sweep's output, not any printed count, is the set slice 3 edits. Nothing to change before approval; the implementer should not treat 22 or 26 as a completion criterion.

### 3. Implementer carries that the text now states but the slices must still build

- Slice 5: the 2× pass paces 500/s (ticker, one publisher) and 4/s per chat publisher (40 ÷ 10) through a preflight-only input, never the grant's `ingressRatePerSecond`; the receipt records the offered rate per pass, and the count predicate (`A_origin[w] ≥ 500 / 40`) is what proves the offer was 2× (Critic R5 9).
- Slice 4 / D6: the receipt names which instrument produced each CPU figure (`(utime+stime)` delta vs `onRelayWork` spans) and `secure_fs.rs:12119-12121` `CHAT_10K_*` bounds stay valid as bounds — leave or rename, never shrink (Critic R4 6).
- D4's parenthetical medians are informational; the gated statistic is the whole-window mean, as lines 51, 112 and 127 state.

### 4. Revision-identity edits outside the dispatch list (expected, not a finding)

Line 4 (revision note) and line 17 (`-r6.md` artifact names) changed with the revision, and line 126 reorders the 1× clause to "in the 1× pass `A_origin[w] = row ingress ÷ windows` (…)" — inside the predicate sentence R6 was allowed to touch. Nothing else moved (§C).

## A. D4 predicate under the R6 definition, all six rows (recomputed)

`binding rate` = max(measured-window deliveries/s, warmup deliveries/s) per D1 line 49; warmup = 2 ingress/s per publisher (`cohort-protocol.ts:113-115`); `binding ingress` = binding ingress rate × window seconds (line 125); 2× predicate = `2 × binding ingress ÷ windows` (line 126). `python3` over the D3 table:

| Row | P | K | W | 1× `A[w]` (row ingress ÷ W) | 1× del/s | warmup ing/s · del/s | binding del/s · ing/s | **binding ingress** (window total) | **2× predicate `A[w] ≥`** | 2× offer ing/s (line 124) | 2× del/s | ÷ binding | 1× pacing passes 2×? |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| ticker rate-50 | 1 | 100 | 10 | 50 | 5,000 | 2 · 200 | 5,000 · 50 | 500 | 100 | 100 | 10,000 | 2.00× | no (50 < 100) |
| ticker rate-100 | 1 | 100 | 10 | 100 | 10,000 | 2 · 200 | 10,000 · 100 | 1,000 | 200 | 200 | 20,000 | 2.00× | no (100 < 200) |
| **ticker rate-250** | 1 | 100 | 10 | 250 | 25,000 | 2 · 200 | 25,000 · 250 | **2,500** | **500** (line 126 ✓) | **500** (line 124 ✓) | 50,000 | 2.00× | **no (250 < 500)** |
| chat 250 | 10 | 250 | 30 | 10 | 2,500 | 20 · 5,000 | 5,000 · 20 | 600 | 40 | 40 | 10,000 | 2.00× | no (10 < 40) |
| chat 500 | 10 | 500 | 30 | 10 | 5,000 | 20 · 10,000 | 10,000 · 20 | 600 | 40 | 40 | 20,000 | 2.00× | no (10 < 40) |
| **chat 1k** | 10 | 1,000 | 30 | 10 | 10,000 | 20 · 20,000 | 20,000 · 20 | **600** | **40** (line 126 ✓) | **40** (line 124 ✓) | 40,000 | 2.00× | **no (10 < 40)** |

Line 125's "i.e. 250 and 20 per 1 s window" = binding ingress ÷ windows (2,500 ÷ 10; 600 ÷ 30) ✓. On both rows D4 runs, the offer is 2.00× the binding load and the predicate is 2× the 1× predicate (500 vs 250; 40 vs 10); a publisher pacing at 1× cannot pass `A ≥ 500` / `A ≥ 40`, so the vacuous pass R5 refused is closed on the ticker row as well as the chat row. Under the rejected rate reading the numbers would be 50 and 1.33 — the definition now excludes it. `D_warmup = 10 × P × K` → 1,000 / 25,000 / 50,000 / 100,000 for the four K values, unchanged.

## B. Utilisation figures, recomputed from the raw files (unchanged from R5; the statistic the rule gates)

`series[].mainThreadCore`, one sample per second, no filter:

| Raw file | Load | n | Mean | Median | Min | Max | O = A · W = E · faults · qpeak | Printed |
|---|---|--:|--:|--:|--:|--:|---|---|
| `r3/raw/combined-k100-p1-n100-r250-r3row1x-b-server.json` | ticker 1× | 9 | **0.429** | 0.420 | 0.390 | 0.470 | ✓ · ✓ · 0 · 100 | 0.43 ✓ (timed 0.29 / process 1.74 = medians ✓) |
| `r2/raw/combined-k100-p1-n100-r250-row1x-server.json` | ticker 1× | 9 | **0.449** | 0.449 | 0.420 | 0.480 | ✓ · ✓ · 0 · 100 | 0.45 ✓ |
| `r3/raw/combined-k100-p1-n100-r500-r3d4v2-b-server.json` | ticker 2× | 9 | **0.762** | 0.751 | 0.719 | 0.869 | ✓ · ✓ · 0 · 100 | 0.75–0.78 ✓; 0.72–0.87 ✓; (0.47 / 3.05) medians ✓ |
| `r2/raw/combined-k100-p1-n100-r500-d4v2-server.json` | ticker 2× | 9 | **0.750** | 0.740 | 0.719 | 0.830 | ✓ · ✓ · 0 · 100 | ✓ |
| `r2/raw/combined-k100-p1-n100-r500-smoke-server.json` | ticker 2× | 9 | **0.776** | 0.770 | 0.730 | 0.850 | ✓ · ✓ · 0 · 100 | 0.78 ✓ |
| `r3/raw/combined-k1000-p10-n128-r20-r3warm1x-server.json` | chat 1k warmup shape (perBurst 10) | 29 | **0.330** | 0.320 | 0.180 | 0.465 | ✓ · ✓ · 0 · 2,464 | 0.33 ✓; (0.14 / 1.15) medians ✓ |
| `r3/raw/combined-k1000-p10-n128-r40-r3warm2x-server.json` | chat 1k 2× (perBurst 20) | 29 | **0.551** | 0.540 | 0.360 | 0.680 | ✓ · ✓ · 0 · 2,464 | 0.55 ✓; max 0.68 ✓; (0.23 / 1.96) medians ✓ |

Every printed main-thread figure is the sample mean to two places and inside its bound (≤ 0.50 at 1×, ≤ 0.80 at 2×); every parenthetical is the median with a mean ≤ 0.04 away, exactly as line 39 now labels them. The three ticker 500/s runs are the true 2× point the corrected predicate binds; they pass, so no row retires.

## C. The R6 change list, item by item (executed), and "nothing else changed"

| Claimed change | Present (line) | Correct |
|---|---|---|
| D4 definitions: binding ingress = window total at the binding rate, ticker 2,500 / chat 600 | 125 | ✓ (§A) |
| 2× predicate example ticker 500 / chat 40; 1× ticker 250 / chat 10 | 126 | ✓ (§A) |
| "R4 keeps" → "This amendment keeps" | 72 | ✓ |
| parenthetical medians note | 39 | ✓ (§B) |
| "0.75 mean" → "means of 0.75–0.78" | 127 | ✓ (§B) |
| `:996` attributed to `drainWarmup()` | 82 | ✓ (`:980/:996/:1025/:1077/:1080`) |
| warmup burst shape per publisher / aggregate | 39 | ✓ (`cohort-protocol.ts:116-120`, `fanout-role.ts:1312-1338`); line 41 unchanged (non-blocking 1) |
| `server.ts:2598` | 142 | ✓ |
| test-file count "22 by id" | 116 | present; 22 is the id-or-label count (non-blocking 2) |
| slice 5 pacing input + offered rate per pass | 154 | ✓ |
| revision note / `-r6` artifact names | 4, 17 | ✓ |
| "Nothing else changed" | — | 55 phrases the R5 pair quoted as unchanged re-grepped → every one present at its section (lines 47, 51, 72, 74, 82, 84, 87–95, 112, 114, 116, 124, 129, 135–136, 142); the only miss is the 1× predicate clause, reordered inside line 126 (non-blocking 4). Stale sweep → 0 for `R4 keeps`, `ticker 50 per 1 s window`, `around a 0.75 mean`, `openMeasuredWindow\` refuses`, `24–26 by pattern`, `Revision:** R5`, `-r5.md\`; the canonical`, `chat 20/s for 30 s`, `0.74–0.76`, `registered late`, `89 tracked`. Line count 160 → 161 = the inserted definitions bullet. |

## Verified without finding

- D1 line 51 (rule), D3 line 112 (measured utilisation, retirement clause) and D4 line 127 (bound) name the same statistic and thresholds (mean over the whole window / epoch; 0.50 at 1×, 0.80 at 2×; per-window max recorded not gated); D4 line 124's offers and line 126's predicates are now the same 2× load on every row.
- Every D1 figure R6 re-labelled traces to a raw file in the scratchpad (§B); no number moved.
- Tracked tree clean before and after; rig idle with no scratch directory and no process of mine; nothing created anywhere but this file.

## Cleanup

Nothing was created on the rig. Local: only this file written; `git status --porcelain | grep -v '^??' | wc -l` → 0.

## Two-perspective note

- Perfectionist: the fix is exactly the one-number-one-definition diff both R5 passes asked for, and it is verifiable by arithmetic on all six rows; the residue is two loose phrases (line 41's per-publisher "bursts of 10", line 116's "by id" for a count that includes labels), neither of which gates anything or names a contract.
- Pragmatist: every mechanism, number, record, mirror and offset was executed and is right across R4–R6; the 2× gate is now real on both rows D4 runs and the true 2× measurements already pass it. Approve, and let slices 1–6 carry the three implementer notes above.
