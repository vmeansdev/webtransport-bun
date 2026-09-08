CHANGES REQUIRED

# Architect review R5 — physical-budget amendment (compact delivery frames, hardware-derived cells)

Reviewer: Claude (Architect pass, revision R5), 2026-09-08. Git read-only (`git status --porcelain | grep -v '^??' | wc -l` → 0 before and after; only this file written). No campaign, stage, controller or rig write; nothing under `.release-evidence/`, `/var/db/webtransport-bun`, `/usr/local/libexec/webtransport-bun`, the rig stage dirs or keys touched. Rig access: one read-only ssh (`hermes-admin@10.99.0.2`: `/proc/loadavg` → 0.06 0.03 0.02; `ls -d /tmp/amendment-review-*` → 0; `pgrep -af 'amendment-review|combined-relay|fanout-physical'` minus the pgrep shell → 0; `eno1/speed` → 1000). No new measurement was taken; every utilisation figure was recomputed from the R2/R3 raw files in this session's scratchpad (`scratchpad/r2/raw/`, `scratchpad/r3/raw/`, the R3 Critic's own runs), and every citation and literal below was re-executed against HEAD.

## Bindings

- Amendment SHA-256: `25b4606a5d1634c7060aabbbe677cfc999d04d7f2c30f0daaca786fe79177c85` (`shasum -a 256 docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, 160 lines, revision R5; matches the dispatch SHA)
- Base plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Candidate HEAD: `efaed8bb0af82a499ca58b2627ea251efced41c5` (`git rev-parse HEAD`; tracked tree clean; the amendment and the review artifacts are untracked)
- R4 pair read first (`reviews/2026-09-08-physical-budget-{architect,critic}-r4.md`, Architect R4 SHA-256 `cfa50091…` as the Critic recorded); R4's bytes are not recoverable (untracked, no copy on disk: `find … -name '*physical-budget-amendment*'` → the R5 file only), so the R5 diff was checked claim by claim against the R4 reviewers' quotations of R4 and by a stale-text sweep (below).

## Verdict in one paragraph

Every R4 finding closes as the revision note says, verified by execution: D4's chat 2× pass now offers 40 ingress/s for 30 s and the D1/D3 utilisation figures are the sample means the rule gates (recomputed: 0.429/0.449 · 0.762/0.750/0.776 · 0.330 · 0.551, max 0.68), the unreachable "registered late" clause is replaced by the true statement (`REGISTRATION_CLOSED` at `fanout-relay.ts:689`), the warmup loop admits the epoch's context, the pinned grant hex is in the mirror list with the parse site (`secure_fs.rs:19695`), the ws-wt-r0 counts are 855/80, and every offset the R4 pair corrected now points at the line it names. D2's fail-closed path, D3's table and rule, D5's literals and D6's `serverChildCpu` placement are unchanged and still match HEAD. **One thing blocks, and it is the same defect class the Critic refused R4 for, mirrored onto the ticker row:** the 2× count predicate's worked example at D4 line 125 says "ticker **50** per 1 s window" where the formula it illustrates (`2 × binding ingress ÷ windows`) and line 124's own offer (500/s for 10 s) give **500**. As exemplified, the ticker 2× pass — the only ticker topology D4 runs — binds one fifth of the 1× load (250/window), so a publisher that under-offers at 2× passes `O = A`, passes `A ≥ 50`, reads a low utilisation and satisfies the 0.80 bound vacuously; the stop condition "a D4 preflight below 2× stops staging" cannot fire on ticker through the count predicate. The root is that "binding ingress" is undefined in the formula: plugging D1's binding *rate* (250/s) gives 50 for ticker and 1.33 for chat; the chat example (40) is right only with the *window total at the binding rate* (600 ÷ 30). One number and one units clause fix it; the R3 raw runs at the true ticker 2× point (500/s: means 0.75–0.78, exact conservation, zero faults) show the fix retires no row.

## R4 findings closure

Critic R4 (1–6):

| # | R4 finding | Status | Evidence (executed this pass) |
|---|---|---|---|
| 1 | BLOCKING — D4's 2× pass offered 1× the binding rate on every chat row | **CLOSED** (and a new, mirrored defect opened on the ticker example — blocking finding 1 below) | Line 124: "(2) **2× — the publishers offer twice the row's binding ingress rate for the full measured window**, the warmup epoch unchanged: ticker 500/s for 10 s (binding = measured rate 250/s); chat **40/s for 30 s** (binding = the warmup epoch's 20 ingress/s, which is 2× the measured window's 10/s) — so the 2× pass offers 2× the binding load on every row, never the 1× warmup load". Line 125: "`A_origin[w] ≥ 2 × binding ingress ÷ windows` in the 2× pass (ticker 50 per 1 s window; chat 40 per 1 s window)". D3 (line 112): "at 2× that load (40 ingress/s) **0.55**". `grep -c 'chat 20/s for 30 s\|twice the row.s ingress rate' amendment.md` → 0 / 0. Per-row offer arithmetic in §A: chat 250/500/1k at 40 ingress/s = 10,000 / 20,000 / 40,000 deliveries/s = 2.0× binding on each; the raw file `r3/raw/combined-k1000-p10-n128-r40-r3warm2x-server.json` (40 ingress/s, bursts of 20 per 500 ms): mean 0.551, max 0.68, offered 1,200 = accepted 1,200, writes 1,200,000 = expected, `faultCount` 0, queue peak 2,464 — the chat side of the gate is now real and measured. The ticker worked number is wrong (finding 1). |
| 2 | Medians labelled "whole-window means"; one 2× mean outside the stated range | **CLOSED** | D1 line 39: "figures are whole-window means of the per-1 s samples … **0.43–0.45** … **0.75–0.78** at 2× over three runs … **0.33** … **0.55** … max 1 s sample 0.68"; D3 line 112: "whole-window means of the 1 s samples: … **0.43–0.45** … **0.75–0.78** … **0.33** … **0.55**". Recomputed (`series[].mainThreadCore`, python over the seven raw files, §B): means 0.429 / 0.449 (1×), 0.762 / 0.750 / 0.776 (2×), 0.330 / 0.551 — every printed figure is the mean rounded to two places; `grep -c '0.74–0.76\|2× 0.54' amendment.md` → 0 / 0. The 2× per-1 s spread "0.72–0.87" (line 126) is the R3 2× series min 0.719 / max 0.869. The parenthetical timed/process figures beside them are still medians (informational 3). |
| 3 | Warmup loop sentence refuses the context it needs | **CLOSED** | Line 79: "the warmup loop (`:1361-1370`) refuses, not ignores, any unit that is neither the epoch's delivery context nor a warmup-tagged compact frame"; `grep -c 'not a warmup-tagged compact frame' amendment.md` → 0. `sed -n 1361,1370p bin/fanout-role.ts` → the deadline (`config.warmupDurationMs + COHORT_DRAIN_DEADLINE_MS`) and the `frame.kind === "warmup-data"` test at `:1365`, as cited. |
| 4 | "Registered late or re-registered" describes no reachable case | **CLOSED** | Line 82: "The relay enqueues the warmup context for every registered subscriber when it binds the warmup epoch (registration is closed from that point, `fanout-relay.ts:689`, so no subscriber joins later)"; `grep -c 'registered late' amendment.md` → 0. `sed -n 689p scenarios/fanout-relay.ts` → `if (this.phaseValue !== "registration") return "REGISTRATION_CLOSED";`; `bindWarmupEpoch` guard at `:762`. |
| 5 | Architect R4 1–2 confirmed; offsets | **CLOSED** | Each offset re-executed: `handle.onSession` → `server.ts:1030` (D2 says `:1030`); `SECTION_7_CODES` → `secure_fs.rs:12171`, closing `];` at `:12193` (D2 says `:12171-12193`, mapping "near `:12300-12318`" — `:12300` is the §7 comment, `:12318` `Self::Oversize`); snapshot-receipt fixture → `cohort-fixture-signing.ts:440` (`schema:`) / `:472` (`signedSchema:`), D6 says `:440-472`; key lists → `server-observation-artifact.test.ts:107` (`rigServerSnapshotReceiptBase64`) / `:126` (`…SignatureBase64`), D6 says `:107/:126`, and D6 now says the `rig-measure-start-ack/v1` pin at `:563-568` does not move (`:563` `RUST_PINNED_MEASURE_START_ACK_HEX` — confirmed); `cohort_cell("ticker-fanout/rate-10000")` → `mac_cohort_runtime.rs:5162` (D3 says `:5162`); `frame.subscriberId ?? ""` → `fanout-role.ts:1451` (`workerBook.recordDelivery({` at `:1451`; D2 says `:1451`); worker warmup budget `:1361-1362` kept as the Critic said. ws-wt-r0: `git ls-files .release-evidence/transport-comparison/ws-wt-r0 | wc -l` → **855**; `git grep -lE '<retired ids>' -- that dir | wc -l` → **80**; D3 prints "855 tracked files, 80 naming retired ids"; `grep -c '89 tracked' amendment.md` → 0. Stale-offset sweep `grep -c` for `:1032`, `:12188`, `:363-415`, `test.ts:568`, `:5073-5085`, `role.ts:1455`, `:1363-1364` → 0 each. |
| 6 | Informational (CHAT_10K bounds, test-file counts, EOF mapping, instrument naming) | **CLOSED** as informational | Unchanged text; nothing was required. Test files naming a retired id or label: 22 by my pattern (`git grep -lE … -- 'tools/**/*.test.ts' | wc -l`), D3 still says "24–26 by pattern" — informational. |

Architect R4 (1–3):

| # | R4 finding | Status | Evidence |
|---|---|---|---|
| 1 | Pinned `cohort-grant/v1` hex for the retired ticker id missing from D3's mirror list | **CLOSED** | D3 line 116 names "the `cohort-grant/v1` pin `RUST_PINNED_TICKER10K_GRANT_HEX` at `cohort-protocol.test.ts:3709` / `crates/native/tests/cohort_protocol.rs:970`, which stops parsing once the id is refused because grant parse resolves `cohort_cell(cell_id)?`, `secure_fs.rs:19695`". Executed: `grep -n RUST_PINNED_TICKER10K_GRANT_HEX` → `cohort-protocol.test.ts:3709` (definition), `cohort_protocol.rs:970` (`const … &str =`); `sed -n 19695p secure_fs.rs` → `let cell = cohort_cell(cell_id)?;`; `fn cohort_cell` at `:19658`. Slice 3's "every mirror listed in D3" carries it. |
| 2 | Three fixture/pin citations pointed at the neighbouring record | **CLOSED** | As Critic 5 above: `:440-472`, `:107/:126` with the `:563-568` pin stated as unmoved, `:5162`. |
| 3 | Informational — `UNEXPECTED_EOF` seals as `COHORT_PROTOCOL` | **CLOSED** | D2 fail-closed 2 already stated it in R4 ("`UNEXPECTED_EOF` is a channel code and seals as `COHORT_PROTOCOL` through `closedCohortFailureCode`"); unchanged. Vocabulary re-executed: Rust 21 = TS 3 refusal + 18 failure, intersection empty, `CHILD_LIFECYCLE` a member, `UNEXPECTED_EOF` and `DELIVERY_CONTEXT_MISMATCH` not (the latter is the addition). |

R1–R3 residue: none reopened. Every R5 change in the dispatch list is present (§C); the stale-text sweep found no R4 wording left behind, and no sentence outside the listed changes differs from what the R4 reviewers quoted.

## Blocking finding

### 1. BLOCKING — the 2× count predicate's ticker example binds 50 per window; the formula and the offer say 500, and "binding ingress" is read as a rate on one side of the semicolon and as a window total on the other

Line 124 offers "ticker 500/s for 10 s (binding = measured rate 250/s)". Line 125 binds "`A_origin[w] ≥ 2 × binding ingress ÷ windows` in the 2× pass (ticker **50** per 1 s window; chat 40 per 1 s window)". For the rate-250 topology — the only ticker topology D4 runs — 2 × 2,500 ingress ÷ 10 windows = **500** per window, which is what R4's predicate (`2 × (row ingress ÷ windows)` = 500, Architect R4 closure of Critic R3 5: "2× → 500 / 20") already bound and what the Critic's required text for R5 named ("ticker 500 per window, chat 40 per window"). R5 regressed the ticker number by 10× while fixing the chat one.

Why it is blocking and not a typo: the count predicate is the only thing that proves the publishers *offered* 2×. With `A ≥ 50` a 2× ticker pass whose publisher paces at 250/s (the 1× rate — a pacing default, a copied 1× config, a clamp) satisfies `O = A` (the relay accepts everything offered), satisfies `A ≥ 50`, reads a main thread near 0.45 and passes the ≤ 0.80 bound vacuously; the stop condition "a D4 preflight below 2× stops staging" cannot fire on ticker through the count predicate. This is exactly the class the Critic refused R4 for on chat ("a gate that offers 1× and calls it 2×"), and it sits in the pass whose bound the tightest run on record (R2 smoke, mean 0.776) misses by 0.024.

Why the example is wrong rather than the formula: "binding ingress" is never defined. D1 defines the *binding rate* in deliveries/s and line 124 speaks of the "binding ingress **rate**" (250/s, 20/s). Plugging that rate into `2 × binding ingress ÷ windows` gives ticker 2 × 250 ÷ 10 = **50** (the printed number) and chat 2 × 20 ÷ 30 = **1.33** (not the printed 40). The chat example is right only when "binding ingress" is the window total at the binding rate (20/s × 30 s = 600; 2 × 600 ÷ 30 = 40). The two examples were computed under different readings of the same term; the formula is right under the second reading and must say so.

Required text (one number, one clause): "`A_origin[w] ≥ 2 × binding ingress ÷ windows` in the 2× pass, where binding ingress is the ingress the row would accept over the measured window at its binding rate (ticker 2,500; chat 20 × 30 = 600) — ticker **500** per 1 s window; chat 40 per 1 s window". Equivalently: `A_origin[w] ≥ 2 × binding ingress rate × 1 s`. Nothing else moves: the R3/R2 raw runs at ticker 500/s (`r3/raw/combined-k100-p1-n100-r500-r3d4v2-b-server.json` mean 0.762, max 0.87; `r2/raw/…-r500-d4v2-…` 0.750; `…-r500-smoke-…` 0.776; offered 5,000 = accepted 5,000, writes 500,000 = expected, faults 0) already pass the bound at the corrected predicate, so no row retires.

Commands: `sed -n 124,125p docs/superpowers/plans/2026-09-08-physical-budget-amendment.md | grep -o 'ticker 500/s for 10 s\|ticker 50 per 1 s window\|chat 40 per 1 s window'`; `python3 -c "print(2*2500/10, 2*250/10, 2*600/30, 2*20/30)"` → `500.0 50.0 40.0 1.3333`.

## Non-blocking findings (carry to the implementer; none changes a number, a record or a mechanism)

### 2. D2 line 72 still says "R4 keeps the request at accepted subscriber registration and removes the lazy fallback"

The sentence describes what the amendment does; "R4" is the revision that introduced the wording, now R5. Cosmetic; "This amendment keeps …" would age correctly.

### 3. Informational — the timed/process figures in parentheses are medians beside main-thread means

D1 line 39 and D3 line 112 print the main-thread figures as means (correct, the gated statistic) and, in parentheses, "timed 0.29, process 1.74", "0.47 / 3.05", "timed 0.14, process 1.15", "0.23 / 1.96". Recomputed: those four pairs are the per-sample **medians** (means: 0.29/1.77, 0.48/3.09, 0.14/1.18, 0.24/1.99; the timed figure also equals `busyFracOverWindow` 0.30/0.48/0.14/0.24). Nothing gates on them and every difference is ≤ 0.04; the row says "figures are whole-window means", so either relabel the parentheticals or print the means. Command: python over the four R3 raw files, `statistics.median`/`mean` of `series[].processCores` and `series[].busyFrac`.

### 4. Informational — `const snapshot = {` is `server.ts:2598`; D6's range `:2596-2619` contains it

`sed -n 2596,2619p tools/compare/server.ts` → `:2596` comment, `:2597` `const windowMs`, `:2598` `const snapshot = {`, `:2599` `schema: "server-loop-utilization/v1"`, `:2618` `busyMs: finalBusyMs - baselineBusyMs`. The range is right; the start line the Critic gave (2596) is the comment above it.

### 5. Informational — test-file count

22 test files name a retired id or label by my pattern (Critic R4 21, Architect R4 22, D3 "24–26 by pattern"). The conformance test is the guard; the count is not a contract.

## A. D4's 2× pass, offered and bound, per row (recomputed)

`binding` = max(measured-window deliveries/s, warmup deliveries/s) per D1 line 49; warmup = `WARMUP_MESSAGES_PER_PUBLISHER 10` per 500 ms = 2 ingress/s per publisher (`cohort-protocol.ts:113-115`, executed); `windowCount: 10 | 30` (`:1805`).

| Row | P | K | W | 1× A/window | 1× del/s | warmup del/s | binding del/s | binding ingress/s | 2× offer (ingress/s) | 2× del/s | ÷ binding | correct 2× `A_origin[w]` | line 125 prints |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| rate-50 | 1 | 100 | 10 | 50 | 5,000 | 200 | 5,000 | 50 | 100 | 10,000 | **2.0×** | 100 | — |
| rate-100 | 1 | 100 | 10 | 100 | 10,000 | 200 | 10,000 | 100 | 200 | 20,000 | **2.0×** | 200 | — |
| rate-250 | 1 | 100 | 10 | 250 | 25,000 | 200 | 25,000 | 250 | **500** (line 124 ✓) | 50,000 | **2.0×** | **500** | **50 ✗** (finding 1) |
| chat 250 | 10 | 250 | 30 | 10 | 2,500 | 5,000 | 5,000 | 20 | 40 | 10,000 | **2.0×** | 40 | — |
| chat 500 | 10 | 500 | 30 | 10 | 5,000 | 10,000 | 10,000 | 20 | 40 | 20,000 | **2.0×** | 40 | — |
| chat 1k | 10 | 1,000 | 30 | 10 | 10,000 | 20,000 | 20,000 | 20 | **40** (line 124 ✓) | 40,000 | **2.0×** | 40 | 40 ✓ |

The offer (line 124) is 2× the binding load on every row. The bound (line 125) is 2× on the chat rows and, as exemplified, 0.2× on the ticker row D4 runs. D4 measures only the two top rows; the lower rows are dominated (same K at a lower rate for ticker; smaller K and a lower binding rate for chat, with `relay_us` monotone in K), as R4 accepted.

## B. Utilisation means, recomputed from the raw files (the statistic the rule gates)

`series[].mainThreadCore`, one sample per second (9 over the 10 s ticker window, 29 over the 30 s chat window; no filter applied):

| Raw file | Load | n | Median | **Mean** | Min | Max | D1/D3 print |
|---|---|--:|--:|--:|--:|--:|---|
| `r3/raw/combined-k100-p1-n100-r250-r3row1x-b-server.json` | ticker 1×, 25,000/s | 9 | 0.420 | **0.429** | 0.39 | 0.47 | 0.43 ✓ |
| `r2/raw/combined-k100-p1-n100-r250-row1x-server.json` | ticker 1× | 9 | 0.449 | **0.449** | — | 0.48 | 0.45 ✓ |
| `r3/raw/combined-k100-p1-n100-r500-r3d4v2-b-server.json` | ticker 2×, 50,000/s | 9 | 0.751 | **0.762** | 0.72 | 0.87 | 0.75–0.78 ✓; "0.72–0.87" ✓ |
| `r2/raw/combined-k100-p1-n100-r500-d4v2-server.json` | ticker 2× | 9 | 0.740 | **0.750** | — | 0.83 | ✓ |
| `r2/raw/combined-k100-p1-n100-r500-smoke-server.json` | ticker 2× | 9 | 0.770 | **0.776** | — | 0.85 | 0.78 ✓ (0.024 under the bar) |
| `r3/raw/combined-k1000-p10-n128-r20-r3warm1x-server.json` | chat 1k warmup shape, 20,000/s | 29 | 0.320 | **0.330** | 0.18 | 0.47 | 0.33 ✓ |
| `r3/raw/combined-k1000-p10-n128-r40-r3warm2x-server.json` | chat 1k 2×, 40,000/s | 29 | 0.540 | **0.551** | 0.36 | 0.68 | 0.55 ✓, "max 0.68" ✓ |

Every printed main-thread figure is the sample mean to two places, inside its bound (≤ 0.50 at 1×, ≤ 0.80 at 2×), with `offered = accepted`, `writesCompleted = expectedWrites` and `faultCount 0` in every file; queue peak 2,464 at chat 1k in both chat runs (D1 prints it). D4's definitive instrument is the `(utime+stime)` delta over the whole interval (line 126), which is the same statistic as the mean of 1 s deltas over the same interval — the document's numbers and the gate now agree.

## C. The R5 change list, item by item (executed)

| Claimed change | Present | Correct |
|---|---|---|
| D4 chat 2× pass: 40/s for 30 s, predicate against the binding ingress | line 124 ✓; line 125 ✓ | chat side ✓ (§A); ticker example ✗ (finding 1) |
| D1/D3 utilisation restated as whole-window means 0.43–0.45 / 0.75–0.78 / 0.33 / 0.55 | lines 39, 112 ✓ | ✓ (§B) |
| "registered late" sentence → reachable statement | line 82 ✓ | ✓ (`fanout-relay.ts:689`) |
| warmup-loop sentence | line 79 ✓ | ✓ |
| pinned grant hex in the mirror list | line 116 ✓ | ✓ (`:3709`, `:970`, `secure_fs.rs:19695`) |
| ws-wt-r0 counts 855 / 80 | line 116 ✓ | ✓ (`git ls-files`, `git grep -l`) |
| offsets `:1030`, `:12171-12193`, `:440-472`, `:107/:126`, `:5162`, `server.ts:2596`, `fanout-role.ts:1451` | ✓ | ✓ each (Critic 5 row above; `:2596` see informational 4) |
| "Nothing else changed" | — | no R4 wording quoted by either R4 reviewer survives (`grep -c` sweep → 0 for every stale string); every unchanged section re-verified in §D |

## D. Spot-checks of unchanged sections against HEAD (executed)

- **D2 fail-closed path.** `PHASE_B_ROLE_CHILD_SCHEMAS` `child-pipe-protocol.ts:1571-1587` (`export const … as const`), `roleChildFrameBoundForSchema :1596-1602`, `encodeRoleChildFrame` "unregistered role-child schema" inside `:1628-1640`, `STATE_INVALID` "expected X, read Y" at `:1673-1679`; `PHASE_B_ROLE_CHILD_ORIGINATED_SCHEMAS` `supervisor-protocol.ts:1871-1880` (7 entries, no `role-failed/v1` today); `poison` with `??=` `remote-supervisor.ts:8626-8627`, `receive :8676-8745`; the five driver awaits `compare-controller.ts:7704/7775/7846/7924/7959` (`grep -n 'receive("role-'` → exactly those); `closedCohortFailureCode :6368-6370`, seal `:6454`, terminal list `:1431-1460`, `warmupDeadlineMs :6743`, `warmupDrainMs: 6_000 :7427`, `ROLE_WARMUP_DEADLINE_CODE :7462`; worker budget `fanout-role.ts:1361-1362`, `recordMalformed :937`, WS silent drop `:2196-2197`, WT `:2252-2255` (`decoded.value.length === 1` at `:2253`), detached uni loop `:2263-2282`, exit `:2340-2345`; `CampaignFailureCode` `cross-supervisor-protocol.ts:116` … `:135`; `verify-artifact.ts:4124-4149` Linux-only (`grep -c 'malformedCount\|perSubscriberDelivered'` → 0); `estimateDeliveryBytes` canonical-JSON probe `fanout-relay.ts:1711-1719`; `QueuedDelivery :364-370`; `handleRegister` accept `:676`; `queuedItems !== 0` refusal `:996`; `RELAY_SUBSCRIBER_QUEUE_MAX_ITEMS = 64 :108`; `rejectEpochMixing` `fanout-wire.ts:371-372`; `encodeFanoutWtFrame` u32be prefix `:1073-1083`; `FANOUT_MAX_WINDOW_COUNT = 30 :71`; `LengthPrefixedFrameReader` `adapters/wt.ts:2194`, over-cap throw `:2225-2231`; `server.ts` `handle.onSession :1030`, lazy `openDeliveryStream :1065` inside `:1058-1069`, register-time open `:1172-1175`, `relayFrameRoutingFields :865`, settler `relay.counters()` in `settle()` `:643-651`, `cohortWtListenerAdmission :940`, `createRelaySettler :629`. All as cited.
- **D3 table and rule.** Model recomputed (`relay_us` interpolated over (100, 4.08) (1,000, 4.98) (2,500, 7.75) (5,000, 14.01); `send_us` 1.0 / 12.0): WS 196,850 / 196,850 / 196,850 / 191,205 / 182,482 / 167,224 → 39.4× / 19.7× / 7.87× / 38.2× / 18.2× / 8.36×; WT 62,189 / 62,189 / 62,189 / 61,614 / 60,680 / 58,893 → 12.44× / 6.22× / **2.488×** / 12.32× / 6.07× / 2.94× — every row ≥ 2×, every table print reproduces (chat-250 relay 4.23 = 4.08 + 0.90 × 150/900); `D_warmup` 1,000 / 25,000 / 50,000 / 100,000; bit rates 25.6 / 31.2 / 20.0 / 25.6 Mbit/s (3.3 % of the cable); frame floor 113.6 B; queue tolerance 0.256 s / 3.2 s. Mirrors (`git grep -nE '<retired ids>' -- tools crates ':!*.test.ts' ':!*fixtures*' ':!crates/native/tests'`): `secure_fs.rs:19574,19587,19600,19626,19639`, `compare-controller.ts:277, :4096`, both fragments `:4`, `render-phase4-report.ts:23`, `cross-supervisor-protocol.ts:195-215`, `evidence.ts:154-159` — all in D3; `cohort-protocol.ts:5596-5602` label union, `COHORT_CELL_CARDINALITIES :5615`, `COHORT_CELL_GRANT_PARAMETERS :5713`, readiness constants `:103-104` and set `:105-110`, closed-set checks `:834`, `:3869`; `scenario-registry.ts:228`, `:256-258`, `:514-519`; `types.ts:30`; `client.ts:1442, :1470`; `PHASE4_GATE_CELLS :275`, `:3943`; `cohortReadinessDeadlineMs :6874-6889`; evidence-vector pins `cross-supervisor-protocol.test.ts:2426-2428` (`cellId: "ticker-fanout/rate-10000"`, `size: 134_555`; D3 says `:2417-2437`, the enclosing block), fixture files ×3 for the retired id under `fixtures/cohort-evidence-vectors/`, `mac_cohort_runtime.rs:4846` (`S3_VECTOR_TICKER_10K`), `:4943`, `:5162`, `:5514-5545`.
- **D5 literals.** 9.6: `CAMPAIGN_ID=fanout-pilot-r1`, `pilot`, `REPS=1`, `CAMPAIGN_TIMEOUT_MS=1800000`, `EXPECTED_PASS=2`, `EXPECTED_PROMOTABLE=0`, `EXPECTED_FLATS=0`, `EXPECTED_SEALED=2`; `stage-live-campaign.ts:1089` pilot `2_100_000` (+300,000 ✓). 9.7: `fanout-attested-r1`, `canonical`, `REPS=5`, `CAMPAIGN_TIMEOUT_MS=43200000`, `EXPECTED_PASS=60`, `EXPECTED_FLATS=12`, `EXPECTED_PAIRED_PROMOTIONS=6`, `EXPECTED_SEALED=60`; `:1091` canonical `45_000_000` (+1,800,000); D5's 14,400,000 / 16,200,000 keeps the pairing ✓. `COHORT_ACQUISITION_DEADLINES :7425-7431` (`frameMs 5_000`, `warmupDrainMs 6_000`, `teardownMs 10_000`), `COHORT_DRAIN_DEADLINE_MS = 10_000` (`cohort-protocol.ts:95`); worst case 36 × 76 + 36 × 156 = 8,352 s = 2.32 h ✓; lease `RUN_TIMEOUT_MS + 5400000` = 21,600,000 (`frozen-run-wrapper.fragment.sh:480-481`) ✓; `--authority-lifetime-ms=72000000` in the base plan's stage command (`2026-08-30-busyMs-attested-fanout.md:2744`); `abandon` at `stage-live-campaign.ts:76`, `:3476`; fresh-root check `:2799-2808` tests `<candidate>/<campaignId>`, `macRoot`, `rigRoot` only, so the preflight directory is exempt as D4 says.
- **D6 `serverChildCpu` placement.** `comparison-supervisor.rs` (at `crates/native/src/bin/`): `.receive("server-measure-start-ack/v1")` at `:2308` (the `map_err` D6's `:2310` sits in), `pipe.receive("server-capture-ack/v1")` at `:2407`, pid/pgid check `:2157-2161`; Rust `SERVER_SNAPSHOT_RECEIPT` key set `secure_fs.rs:15308-15337`, exact-key admission `:15362`, mint `:17595-17627` inside `:17595-17633`, carried `:17685-17686`; TS `RigServerSnapshotReceiptV1` `server-observation-artifact.ts:160`; evidence key lists `server-observation-artifact.test.ts:107/:126`; `RUST_PINNED_MEASURE_START_ACK_HEX` pin `:563` unmoved; fixture `cohort-fixture-signing.ts:440/:472` (`rig-measure-start-ack/v1` at `:364/:387`, `server-loop-utilization/v1` at `:393`); child-authored `server-loop-utilization/v1` at `server.ts:2598-2618` (`busyMs: finalBusyMs - baselineBusyMs`), `binding.busyMs()` at `:2574`. Placement in the rig-authored, post-capture, signed receipt — not in the barrier-bound ack — is right and unchanged.
- **D4 reachability.** `bun tools/compare/check-official-io.ts` at HEAD → `failure-count=0` (resolved-graph `1ba7d8b3…`, inventory `4f53cda1…`); `official-io-allowlist.json` `cliEntryTs` 10 entries, none named preflight (slice 5 adds it).
- **Vocabulary.** python over `secure_fs.rs` (`SECTION_7_CODES`) and `cross-supervisor-protocol.ts`: 21 = 3 + 18, union equal, intersection empty; `DELIVERY_CONTEXT_MISMATCH` absent today, so 22 = 3 + 19 after slice 1 as D2 states.

## Verified without finding

- The rule text (D1 line 51) and the D4 bound (line 126) name the same statistic (mean over the whole window / epoch, per-window max recorded not gated) and the same thresholds (0.50 at 1×, 0.80 at 2×); D3's row-retirement clause binds on those readings.
- Every D1 figure cited in D3/D4 traces to a raw file in the scratchpad or to a REPORT.md under `.scratch/2026-09-08-physical-budget/` (paths exist).
- Compact frame, both delivery-context key sets, the tag, the discriminator and the stale-session argument are byte-for-byte the R4 text the Critic verified.
- Line 4's closure list ("critic r4 1; architect r4 1–2, critic r4 2–5") matches what changed.
- Rig idle, no scratch, no process of mine on either host; tracked tree untouched before and after.

## Cleanup

Nothing was created on the rig. Local: only this file written; `git status --porcelain | grep -v '^??' | wc -l` → 0.

## Two-perspective note

- Perfectionist: the revision whose only purpose was to make the 2× predicate bind 2× has one worked number in that predicate off by 10×, on the row whose 2× reading sits 0.024 under the bar. The formula's undefined term produced two examples computed two different ways in one sentence — a units confusion of the kind this project has already paid for (chunk-count vs byte-count, R4's 1×-called-2×). It must not reach the approval record.
- Pragmatist: every mechanism, number, record and mirror is right and executed; the fix is "50" → "500" plus a five-word definition of "binding ingress", and the true 2× ticker measurements already exist and pass. R6 should be a one-line diff and the last revision.
