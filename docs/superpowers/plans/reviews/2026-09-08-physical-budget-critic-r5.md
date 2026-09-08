CHANGES REQUIRED

# Critic review R5 — physical-budget amendment (compact delivery frames, hardware-derived cells)

Reviewer: Claude (Critic pass, revision R5), 2026-09-08. Git read-only (`git status --porcelain | grep -v '^??' | wc -l` → 0 before and after; only this file written). No campaign, stage or controller started; nothing under `.release-evidence/`, `/var/db/webtransport-bun`, `/usr/local/libexec/webtransport-bun`, the rig stage dirs or keys touched. Rig access: one read-only ssh (`hermes-admin@10.99.0.2`: `/proc/loadavg` → 0.00 0.00 0.00; `ls -d /tmp/amendment-review-*` → 0; `pgrep -af 'amendment-review|combined-relay|fanout-physical'` minus the pgrep shell → 0; `eno1/speed` → 1000). No new measurement was taken: every utilisation figure was recomputed from the R2/R3 raw files in this session's scratchpad (`scratchpad/r2/raw/`, `scratchpad/r3/raw/`), and every citation, literal and count below was re-executed against HEAD. The Architect R5 artifact was read first and then treated as untrusted; every claim in it that I rely on was re-run.

## Bindings

- Amendment SHA-256: `25b4606a5d1634c7060aabbbe677cfc999d04d7f2c30f0daaca786fe79177c85` (`shasum -a 256 docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, 160 lines, revision R5; matches the dispatch SHA)
- Base plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Candidate HEAD: `efaed8bb0af82a499ca58b2627ea251efced41c5` (`git rev-parse HEAD`; tracked tree clean; the amendment and the review artifacts are untracked)
- Architect R5 artifact SHA-256: `65e68ca8e12651d8fe60368d10c816c6bf9fafdaf4efeb30e32bd68fab1bf721` (read, then re-verified; not trusted)
- R4 pair SHA-256: critic `d63a2f599f7807a9dcd102ff3c1ea4f930c6a0310a396231b9b616c87ad68a21`, architect `cfa50091b173b3ed244f2ff3310c5e09335356bcdd5f17f7f3c8c4dc5976d22e` (both read first). R4's bytes are not on disk; the R5 diff was checked claim by claim against the R4 reviewers' quotations plus a stale-string sweep (§C).

## Verdict in one paragraph

Every one of my R4 findings closes as written, and both Architect R4 findings with them, verified by execution: D4's chat 2× pass now offers 40 ingress/s for 30 s and the chat predicate example binds 40 per window; every main-thread figure in D1/D3 is now the whole-window mean of the 1 s samples (recomputed from the seven raw files: 0.429 / 0.449 at ticker 1×, 0.762 / 0.750 / 0.776 at ticker 2×, 0.330 at chat 1k warmup shape, 0.551 at 2× with max 0.68 — the document prints exactly these to two places, all inside their bounds); the unreachable "registered late" clause is replaced by the true statement with `fanout-relay.ts:689` (`REGISTRATION_CLOSED`); the warmup loop admits the epoch's context; the pinned grant hex is in the mirror list with the parse site; ws-wt-r0 is 855/80; and every offset the R4 pair corrected now lands on its line. Nothing else changed: no string either R4 reviewer quoted from R4 survives, and the unchanged sections still match HEAD where I spot-checked them (`check-official-io` failure-count 0, vocabulary 3 + 18 = 21 with `DELIVERY_CONTEXT_MISMATCH` absent, `:996` / `:762` / `:1077-1080` / `:1361-1370` / `:1451` as cited). **One thing blocks, and I reach it independently of the Architect:** the 2× count predicate at D4 line 125 prints "ticker **50** per 1 s window". The pass at line 124 offers 500/s for 10 s; the 1× predicate on the same line binds `A_origin[w] = 250`; R4's predicate bound 500; my own R4 required text said 500. As written, the ticker 2× pass — the only ticker topology D4 runs — binds a fifth of the 1× load, so a publisher pacing at 250/s satisfies `O = A`, satisfies `A ≥ 50`, reads ≈0.45 and passes the 0.80 bound vacuously. That is the exact class I refused R4 for on chat, now on the ticker row, in the pass whose bound the tightest run on record (R2 smoke, mean 0.776) clears by 0.024. The root is that "binding ingress" is undefined: read as D1's binding *rate* it gives ticker 50 and chat 1.33; read as the window total at the binding rate it gives ticker 500 and chat 40 — the two examples in one sentence were computed under different readings. The fix is one number and one definition; the raw ticker 500/s runs already pass the corrected predicate, so no row retires.

## R4 findings closure

Critic R4 (1–6):

| # | R4 finding | Status | Evidence (executed this pass) |
|---|---|---|---|
| 1 | BLOCKING — D4's 2× pass offered 1× the binding rate on every chat row | **CLOSED** for chat, as required; a mirrored defect on the ticker example is blocking finding 1 below | Line 124: "(2) **2× — the publishers offer twice the row's binding ingress rate for the full measured window**, the warmup epoch unchanged: ticker 500/s for 10 s (binding = measured rate 250/s); chat **40/s for 30 s** (binding = the warmup epoch's 20 ingress/s, which is 2× the measured window's 10/s) — so the 2× pass offers 2× the binding load on every row, never the 1× warmup load". Line 125: "`A_origin[w] ≥ 2 × binding ingress ÷ windows` in the 2× pass (ticker 50 per 1 s window; chat 40 per 1 s window)". D3 line 112: "at 2× that load (40 ingress/s) **0.55**". `grep -c -F 'chat 20/s for 30 s'` → 0; `grep -c -F "twice the row's ingress rate"` → 0. Chat arithmetic: 40 ingress/s × 1,000 = 40,000/s = 2 × the 20,000/s warmup binding; per window 2 × 600 ÷ 30 = 40 ✓. Raw `r3/raw/combined-k1000-p10-n128-r40-r3warm2x-server.json`: `offeredRatePerS 40`, `perBurst 20` per 500 ms (harsher than D4's paced 40/s), 29 samples, mean **0.551**, median 0.540, max **0.68**, `offered 1,200 = accepted 1,200`, `writesCompleted 1,200,000 = expectedWrites`, `faultCount 0`, `queueItemsPeak 2,464` — inside the 0.80 bound with 0.25 to spare. The chat side of the gate is real. The ticker worked number regressed (finding 1). |
| 2 | Medians labelled "whole-window means"; one 2× mean outside the stated range | **CLOSED** | D1 line 39: "figures are whole-window means of the per-1 s samples … **0.43–0.45** core at 1× … **0.75–0.78** at 2× over three runs … per-1 s readings at 2× span 0.72–0.87; … **0.33** … **0.55** … max 1 s sample 0.68"; D3 line 112 repeats 0.43–0.45 / 0.75–0.78 / 0.33 / 0.55 as "whole-window means of the 1 s samples". Recomputed (§A): 0.429 / 0.449; 0.762 / 0.750 / 0.776; 0.330; 0.551, max 0.68; R3 2× min 0.719 / max 0.869 → "0.72–0.87" ✓. `grep -c -F '0.74–0.76'` → 0; `grep -c -F '2× 0.54'` → 0. The parenthetical timed/process figures are still medians (non-blocking 3). |
| 3 | Warmup-loop sentence refuses the context it needs | **CLOSED** | Line 82: "the warmup loop (`:1361-1370`) refuses, not ignores, any unit that is neither the epoch's delivery context nor a warmup-tagged compact frame"; `grep -c -F 'not a warmup-tagged compact frame'` → 0. `sed -n 1361,1370p bin/fanout-role.ts` → deadline `config.warmupDurationMs + COHORT_DRAIN_DEADLINE_MS` (`:1361-1362`) and `frame.kind === "warmup-data"` at `:1365`, as D2 cites. |
| 4 | "Registered late or re-registered" describes no reachable case | **CLOSED** | Line 82: "The relay enqueues the warmup context for every registered subscriber when it binds the warmup epoch (registration is closed from that point, `fanout-relay.ts:689`, so no subscriber joins later)"; `grep -c -F 'registered late'` → 0. `sed -n 689p scenarios/fanout-relay.ts` → `if (this.phaseValue !== "registration") return "REGISTRATION_CLOSED";`; `bindWarmupEpoch`'s guard at `:762`, phase set to `warmup` at `:857`. |
| 5 | Architect R4 1–2 confirmed; one Architect offset off; `ws-wt-r0` counts | **CLOSED** | Each re-executed: `handle.onSession((raw) => {` at `server.ts:1030` (D2 line 72 says `:1030`); `pub const SECTION_7_CODES` at `secure_fs.rs:12171`, closing `];` at `:12193` (D2 line 92 says `:12171-12193`; `:12300` is the §7 comment, `:12318` `Self::Oversize`); `schema: "rig-server-snapshot-receipt/v1"` at `cohort-fixture-signing.ts:440`, `signedSchema:` at `:472` (D6 line 141 says `:440-472`); `rigServerSnapshotReceiptBase64` at `server-observation-artifact.test.ts:107`, `…SignatureBase64` at `:126`, `RUST_PINNED_MEASURE_START_ACK_HEX` inside `:563-568` and D6 now says that pin "does not move" ✓; `cohort_cell("ticker-fanout/rate-10000")` at `mac_cohort_runtime.rs:5162` (D3 line 116 says `:5162`); `subscriberId: frame.subscriberId ?? ""` at `fanout-role.ts:1451` (D2 line 82 says "`:1451` today"); worker budget `:1361-1362` kept. `git ls-files .release-evidence/transport-comparison/ws-wt-r0 \| wc -l` → **855**; `git grep -lE '<retired ids>' -- <that dir> \| wc -l` → **80**; D3 prints "855 tracked files, 80 naming retired ids"; `grep -c -F '89 tracked'` → 0. Stale-offset sweep: `:1032`, `:12188-12316`, `:363-415`, `test.ts:568`, `:5073-5085`, `role.ts:1455`, `:1363-1364` → 0 each. |
| 6 | Informational (CHAT_10K bounds, test-file counts, EOF mapping, instrument naming) | **CLOSED** as informational | Nothing was required and nothing moved. Test files naming a retired id or label: 22 by my pattern this pass (`git grep -lE … -- 'tools/**/*.test.ts' \| wc -l`); D3 still says "24–26 by pattern" — carried as informational. |

Architect R4 (1–3):

| # | R4 finding | Status | Evidence |
|---|---|---|---|
| 1 | Pinned `cohort-grant/v1` hex for the retired ticker id missing from D3's mirror list | **CLOSED** | D3 line 116 names "the `cohort-grant/v1` pin `RUST_PINNED_TICKER10K_GRANT_HEX` at `cohort-protocol.test.ts:3709` / `crates/native/tests/cohort_protocol.rs:970`, which stops parsing once the id is refused because grant parse resolves `cohort_cell(cell_id)?`, `secure_fs.rs:19695`". Executed: `grep -n RUST_PINNED_TICKER10K_GRANT_HEX` → `cohort-protocol.test.ts:3709` (definition; comment at `:3695`), `cohort_protocol.rs:970` (`const … &str =`, fed to the parser at `:987`); the hex decodes to a grant with `"cellId":"ticker-fanout/rate-10000"`, `declaredMessageCount 10000000`, `expectedExpandedDeliveries 10000000`; `sed -n 19695p secure_fs.rs` → `let cell = cohort_cell(cell_id)?;`, `fn cohort_cell` at `:19658`. Slice 3's "every mirror listed in D3" carries it. |
| 2 | Three fixture/pin citations pointed at the neighbouring record | **CLOSED** | As Critic 5 above: `:440-472`, `:107/:126` with the `:563-568` pin stated as unmoved, `:5162`. |
| 3 | Informational — `UNEXPECTED_EOF` seals as `COHORT_PROTOCOL` | **CLOSED** | D2 fail-closed 2 states it (unchanged). Vocabulary re-executed (python over `secure_fs.rs` and `cross-supervisor-protocol.ts`): 3 refusal + 18 failure = 21 Rust codes, union equal; `CHILD_LIFECYCLE` a member, `UNEXPECTED_EOF` not, `DELIVERY_CONTEXT_MISMATCH` absent today (so 22 = 3 + 19 after slice 1, as D2 says). |

R1–R3 residue: none reopened. Line 4's closure list ("critic r4 1; architect r4 1–2, critic r4 2–5") matches what changed.

## Blocking finding

### 1. BLOCKING — D4 line 125 binds the ticker 2× pass at 50 per window; the offer, the formula and the 1× predicate say 500, and "binding ingress" is undefined

Text (line 124): "ticker 500/s for 10 s (binding = measured rate 250/s)". Text (line 125): "`A_origin[w] = row ingress ÷ windows` in the 1× pass, `A_origin[w] ≥ 2 × binding ingress ÷ windows` in the 2× pass (ticker **50** per 1 s window; chat 40 per 1 s window)".

Arithmetic: `python3 -c "print(2*2500/10, 2*250/10, 2*600/30, 2*20/30)"` → `500.0 50.0 40.0 1.333…`. The 1× predicate on the same line uses the window total (2,500 ÷ 10 = 250; 300 ÷ 30 = 10). Under the same reading the 2× predicate is 2 × 2,500 ÷ 10 = **500** for ticker and 2 × 600 ÷ 30 = 40 for chat. The printed ticker number, 50, is what you get by plugging D1's binding *rate* (250/s) into the formula — and under that reading the chat example would be 1.33, not 40. So the two examples in one sentence were computed under two different meanings of "binding ingress", and the ticker one is wrong by 10×. R4's predicate `2 × (row ingress ÷ windows)` bound 500 on ticker (Architect R4, Critic R3 5 closure: "2× → 500 / 20"); my R4 required text said "ticker 500 per window, chat 40 per window". R5 fixed chat and regressed ticker.

Why blocking: the count predicate is the only thing that proves the publishers *offered* 2×. With `A ≥ 50`, a ticker 2× pass whose publisher paces at the 1× rate (a copied config, a default, a clamp) satisfies `O = A` (the relay accepts everything offered), satisfies `A ≥ 50` (it delivers 250), reads a main thread near 0.45 and passes the ≤ 0.80 bound with nothing measured at 2×; the stop condition "a D4 preflight below 2× stops staging" cannot fire on ticker through the count predicate. The bound as written is weaker than the 1× pass's own predicate (250). This is the class I refused R4 for on chat ("a gate that offers 1× and calls it 2×"), on the row D4 actually runs (rate-250 is the only ticker topology in D4), in the pass whose bound the tightest run on record (R2 smoke, mean 0.776) clears by 0.024. The document's own rule (D1 line 51: "the D4 preflight, offering 2× the binding rate for the full window, must sustain it … ≤ 0.80") is not enforced by its own gate text on the pilot row.

Required text (one number, one definition): "`A_origin[w] ≥ 2 × binding ingress ÷ windows` in the 2× pass, where binding ingress is the ingress the row accepts over its measured window at the binding rate (ticker 2,500; chat 20/s × 30 s = 600) — ticker **500** per 1 s window; chat 40 per 1 s window". Equivalently `A_origin[w] ≥ 2 × binding ingress rate × 1 s`. Nothing else moves: the three ticker 500/s raw runs (`r3/raw/combined-k100-p1-n100-r500-r3d4v2-b-server.json` mean 0.762 max 0.869; `r2/raw/…-r500-d4v2-server.json` 0.750 / 0.830; `r2/raw/…-r500-smoke-server.json` 0.776 / 0.850; each `offered 5,000 = accepted 5,000`, `writesCompleted 500,000 = expectedWrites`, `faultCount 0`, queue peak 100) already pass the corrected predicate and the 0.80 bound, so no row retires.

Commands: `sed -n 124,125p docs/superpowers/plans/2026-09-08-physical-budget-amendment.md | grep -o 'ticker 500/s for 10 s\|ticker 50 per 1 s window\|chat 40 per 1 s window\|A_origin\[w\] = row ingress ÷ windows'`; the python line above; the §A script for the three 500/s files.

## Non-blocking findings (carry into the slices; none changes a number, a record or a mechanism)

### 2. D2 line 72 says "R4 keeps the request at accepted subscriber registration and **removes the lazy fallback**"

Revision-numbered prose in a document now at R5. Write "This amendment keeps …". Command: `grep -n -F 'R4 keeps' <amendment>` → 72.

### 3. The parenthetical timed/process figures beside the main-thread means are medians

D1 line 39 / D3 line 112 print "(timed 0.29, process 1.74)", "(0.47 / 3.05)", "(timed 0.14, process 1.15, queue peak 2,464)", "(0.23 / 1.96)" under the row header "figures are whole-window means of the per-1 s samples". Recomputed from `series[].busyFrac` / `series[].processCores`: medians 0.29 / 1.74, 0.47 / 3.05, 0.14 / 1.15, 0.23 / 1.96 (exactly the printed numbers); means 0.29 / 1.77, 0.48 / 3.09, 0.14 / 1.18, 0.24 / 1.99; the timed figure also equals `busyFracOverWindow` 0.30 / 0.48 / 0.14 / 0.24. Nothing gates on them and every gap is ≤ 0.04 — relabel them as medians or print the means. Command: the §A script (columns `tim med/mean`, `proc med/mean`).

### 4. D4 line 126 "per-1 s readings at the ticker 2× point spread 0.72–0.87 around a 0.75 mean"

The run with that spread is `r3/raw/combined-k100-p1-n100-r500-r3d4v2-b-server.json`: min 0.719, max 0.869, **mean 0.762**, median 0.751. "0.75" is that run's median (or the low end of the three-run 0.75–0.78 range), not its mean. Ungated; write "around a 0.76 mean (0.75–0.78 over three runs)". Command: §A script.

### 5. D2 line 82 attributes the `queuedItems !== 0` refusal at `fanout-relay.ts:996` to `openMeasuredWindow`

`:996` is inside `drainWarmup()` (method at `:980`), the transition that sets `phaseValue = "warmup-drained"` at `:1025`; `openMeasuredWindow` (`:1077`) refuses unless the phase is already `warmup-drained` (`:1079-1080`). The consequence the sentence needs — every subscriber queue is empty when `openMeasuredWindow` enqueues the measured context — holds transitively and the contract is implementable as written; the attribution is one method off. Write "`drainWarmup` refuses the `warmup-drained` transition while `queuedItems !== 0` (`:996`), and `openMeasuredWindow` requires that phase (`:1080`)". Command: `awk 'NR>=940&&NR<=1085&&/^\t[a-zA-Z_]+\(/{print NR": "$0}' tools/compare/scenarios/fanout-relay.ts; sed -n '994,1000p;1023,1027p;1077,1080p' tools/compare/scenarios/fanout-relay.ts`.

### 6. Informational — "each publisher offers 2 ingress/s for 5 s in bursts of 10" (D1 line 41, unchanged R4 text)

`WARMUP_OFFSETS_MS` is `0, 500, …, 4500` per publisher with "no catch-up burst" (`cohort-protocol.ts:116-120`), and the publisher child sleeps to each offset and sends one frame (`bin/fanout-role.ts:1312-1338`): per publisher the warmup is one frame per 500 ms, not a burst of 10. The "burst of 10 per 500 ms" that lines 39/112/114 name for chat 1k is the aggregate of 10 publishers synchronised on the same `startAtMacNs` offsets — correct as an aggregate, and the R3 harness reproduced exactly that shape (`perBurst 10`/`20`, `burstMs 500`). On ticker (1 publisher) the warmup is 1 ingress per 500 ms = 200 deliveries/s. Every number is right; the per-publisher phrase is loose. No change required.

### 7. Informational — `const snapshot = {` is `server.ts:2598` inside D6's `:2596-2619`

`:2596` is the comment above it, `:2597` `const windowMs`, `:2599` `schema: "server-loop-utilization/v1"`, `:2618` `busyMs: finalBusyMs - baselineBusyMs`. The range is right.

### 8. Informational — test-file count

22 test files name a retired id or label by my pattern (Critic R4 21, Architect R4/R5 22, D3 "24–26 by pattern"). The conformance test is the guard; the count is not a contract.

### 9. Implementer carry — the 2× pass drives production role children at a rate no cell grants

D4 (unchanged R4 text, approved) runs "production role children" and in pass (2) has the publishers offer 500/s (ticker) and 4/s each (chat, 40 ÷ 10) for the measured window — rates that are integers on both rows (`publisherRatePerSecond = measuredIngress / publisherCount / seconds`, `compare-controller.ts:4631-4634`: 5,000/1/10, 1,200/10/30) but that no D3 cell declares. Slice 5 must give the preflight a way to hand the publisher child its 2× pacing outside the grant's `ingressRatePerSecond` (the preflight is not on the frozen path, so a config input is fine), and the receipt must record the offered rate per pass. Not a finding against the text; a note so the 2× pass is not silently built on the 1× cell default — which is precisely the failure mode finding 1 would have let through.

## A. Utilisation figures recomputed from the raw files (the statistic the rule gates)

`series[].mainThreadCore`, one sample per second, no filter (9 samples over the 10 s ticker window, 29 over the 30 s chat window). The two non-`-b` R3 ticker files are the contaminated first attempt the R3 Critic documented (Mac process storm; 11.9 % / 32.7 % of frames lost in QUIC send buffers) and are correctly excluded from the document's "three runs"; they are listed here to show the exclusion is not selective — both are inside the bounds anyway.

| Raw file | Load | n | Median | **Mean** | Min | Max | O = A · W = E · faults · qpeak | D1/D3 print |
|---|---|--:|--:|--:|--:|--:|---|---|
| `r3/raw/combined-k100-p1-n100-r250-r3row1x-b-server.json` | ticker 1×, 25,000/s | 9 | 0.420 | **0.429** | 0.390 | 0.470 | ✓ · ✓ · 0 · 100 | 0.43 ✓ |
| `r2/raw/combined-k100-p1-n100-r250-row1x-server.json` | ticker 1× | 9 | 0.449 | **0.449** | 0.420 | 0.480 | ✓ · ✓ · 0 · 100 | 0.45 ✓ |
| `r3/raw/combined-k100-p1-n100-r500-r3d4v2-b-server.json` | ticker 2×, 50,000/s | 9 | 0.751 | **0.762** | 0.719 | 0.869 | ✓ · ✓ · 0 · 100 | 0.75–0.78 ✓; "0.72–0.87" ✓ |
| `r2/raw/combined-k100-p1-n100-r500-d4v2-server.json` | ticker 2× | 9 | 0.740 | **0.750** | 0.719 | 0.830 | ✓ · ✓ · 0 · 100 | ✓ |
| `r2/raw/combined-k100-p1-n100-r500-smoke-server.json` | ticker 2× | 9 | 0.770 | **0.776** | 0.730 | 0.850 | ✓ · ✓ · 0 · 100 | 0.78 ✓ (0.024 under the bar) |
| `r3/raw/combined-k1000-p10-n128-r20-r3warm1x-server.json` | chat 1k warmup shape, 10 per 500 ms, 20,000/s | 29 | 0.320 | **0.330** | 0.180 | 0.465 | ✓ · ✓ · 0 · 2,464 | 0.33 ✓ |
| `r3/raw/combined-k1000-p10-n128-r40-r3warm2x-server.json` | chat 1k 2×, 20 per 500 ms, 40,000/s | 29 | 0.540 | **0.551** | 0.360 | 0.680 | ✓ · ✓ · 0 · 2,464 | 0.55 ✓, "max 0.68" ✓ |
| *(excluded)* `r3/raw/…-r250-r3row1x-server.json` | contaminated 1× | 9 | 0.400 | 0.408 | 0.399 | 0.440 | ✓ · ✓ · 0 | — |
| *(excluded)* `r3/raw/…-r500-r3d4v2-server.json` | contaminated 2× | 9 | 0.710 | 0.741 | 0.650 | 0.927 | ✓ · ✓ · 0 | — |

Every printed main-thread figure is the sample mean to two places and inside its bound (≤ 0.50 at 1×, ≤ 0.80 at 2×). D4's definitive instrument — `(utime+stime)` delta over the whole interval — is the same statistic as the mean of the 1 s deltas over that interval, so the document's numbers and the gate now agree. Script: `python3` over each file, `statistics.mean/median` of `series[].mainThreadCore`, `busyFrac`, `processCores`; `offered == accepted`, `writesCompleted == expectedWrites`, `faultCount`, `queueItemsPeak`, `offeredRatePerS`, `perBurst`.

## B. The chat 2× pass at 40/s is inside the bound (finding r4 1 closed on the physics as well as the text)

`r3warm2x`: `offeredRatePerS 40`, `perBurst 20`, `burstMs 500` — 20 ingress released together every 500 ms, which is a harsher shape than D4's paced 40/s; `warmupDeliveries 100,000` (= 10 × 10 × 1,000, D4's `D_warmup`); `achievedDeliveriesPerS 39,672` over 30.1 s of offering; `queueItemsPeak 2,464` (of a 64 × 1,000 = 64,000 item budget); `concurrentWritesPeak 256`; `streamOpenFailures 0`, `writeTimeouts 0`, `queueDrops 0`, `subscriberDisconnects 0`; main thread mean 0.551, max 0.68; process mean 1.99 cores. Both bounds hold with margin; the chat side of D4 is real and re-measurable per stage.

## C. The R5 change list, item by item (executed)

| Claimed change | Present | Correct |
|---|---|---|
| D4 chat 2× pass 40/s for 30 s, predicate against the binding ingress | line 124 ✓, line 125 ✓ | chat ✓; ticker example ✗ (finding 1) |
| D1/D3 utilisation as whole-window means 0.43–0.45 / 0.75–0.78 / 0.33 / 0.55 | lines 39, 112 ✓ | ✓ (§A) |
| "registered late" → reachable statement | line 82 ✓ | ✓ (`fanout-relay.ts:689`) |
| warmup-loop sentence | line 82 ✓ | ✓ |
| pinned grant hex in the mirror list | line 116 ✓ | ✓ (`:3709`, `:970`, `secure_fs.rs:19695`) |
| ws-wt-r0 counts 855 / 80 | line 116 ✓ | ✓ |
| offsets `:1030`, `:12171-12193`, `:440-472`, `:107/:126`, `:5162`, `server.ts:2596`, `fanout-role.ts:1451` | ✓ | ✓ each (Critic 5 row; `:2596` see informational 7) |
| review-artifact names `-r5` (line 17), status line (line 4) | ✓ | ✓ |
| "Nothing else changed" | — | stale-string sweep: every string the R4 reviewers quoted from R4 and R5 replaced → 0 hits (`chat 20/s for 30 s`, `twice the row's ingress rate`, `0.74–0.76`, `2× 0.54`, `registered late`, `not a warmup-tagged compact frame`, `89 tracked`, `:1032`, `:12188-12316`, `:363-415`, `test.ts:568`, `:5073-5085`, `:1455`, `:1363-1364`, `row ingress ÷ windows)\` in the 2×`); no other sentence differs from what the R4 pair quoted |

## D. Spot-checks of unchanged sections against HEAD (executed this pass)

- `bun tools/compare/check-official-io.ts` → `failure-count=0` (resolved-graph `1ba7d8b3…`, inventory `4f53cda1…`), same digests the R4 pair recorded — D4's "never reachable from the frozen command or the controller" precondition unchanged at HEAD.
- Vocabulary: `SECTION_7_CODES` (21) = `CAMPAIGN_REFUSAL_CODES` (3) ∪ `CAMPAIGN_FAILURE_CODES` (18); `DELIVERY_CONTEXT_MISMATCH` absent; `CHILD_LIFECYCLE` a member; `UNEXPECTED_EOF` not.
- `fanout-relay.ts`: `:689` `REGISTRATION_CLOSED`; `:762` `bindWarmupEpoch` guard; `:857` phase → `warmup`; `:980` `drainWarmup()`, `:996-1000` `queuedItems !== 0` refusal, `:1025` phase → `warmup-drained`; `:1077` `openMeasuredWindow`, `:1079-1080` requires `warmup-drained`.
- `fanout-role.ts`: `:1312-1338` publisher warmup loop over `WARMUP_OFFSETS_MS`; `:1340` "did not offer exactly ten"; `:1361-1370` worker warmup loop with `frame.kind === "warmup-data"` at `:1365`; `:1451` `frame.subscriberId ?? ""`.
- `cohort-protocol.ts:113-115` `WARMUP_MESSAGES_PER_PUBLISHER 10`, `WARMUP_INTERVAL_MS 500`, `WARMUP_DURATION_MS 5_000`; `:116-120` `WARMUP_OFFSETS_MS`.
- `server.ts:1030` `handle.onSession`, `:2596-2619` snapshot frame (`const snapshot` at `:2598`).
- Fixture and test offsets as in Critic 5 above; `RUST_PINNED_TICKER10K_GRANT_HEX` on both sides; `secure_fs.rs:19658/19695`; `mac_cohort_runtime.rs:5162`.
- Rig idle and clean; tracked tree untouched before and after.

## Non-blocking items an implementer must carry (consolidated)

1. Line 72 "R4 keeps" → "This amendment keeps" (finding 2).
2. Relabel or recompute the parenthetical timed/process figures at lines 39/112 (finding 3).
3. Line 126 "around a 0.75 mean" → the R3 run's mean is 0.762 (finding 4).
4. Line 82: the `:996` refusal is `drainWarmup`'s; `openMeasuredWindow` requires the resulting phase at `:1080` (finding 5).
5. Line 41's per-publisher "bursts of 10" is the aggregate shape; per publisher it is one frame per 500 ms (finding 6) — wording only.
6. `const snapshot` is `server.ts:2598` (finding 7); test-file count 22 vs "24–26" (finding 8).
7. Slice 5: the preflight's 2× pass must hand the publisher child a pacing the cell does not grant (500/s; 4/s per chat publisher) through a preflight-only input, and the receipt must record the offered rate per pass (finding 9).
8. Carried from R4 6: `secure_fs.rs:12119-12121` `CHAT_10K_*` bounds stay valid as bounds (leave or rename, never shrink); the receipt should say which instrument produced each CPU figure.

## Cleanup

Nothing was created on the rig (`ls -d /tmp/amendment-review-*` → 0 before and after; no process of mine). Local: only this file written; `git status --porcelain | grep -v '^??' | wc -l` → 0.

## Two-perspective note

- Perfectionist: the one revision whose only job was to make the 2× predicate bind 2× ships with a 2× predicate that binds 0.2× on the pilot row, because the term it introduced ("binding ingress") was never defined and the two examples beside it were computed under different units. This project has paid for chunk-vs-byte and 1×-called-2× already; a third units slip must not be hashed into an approval record.
- Pragmatist: every mechanism, number, record, mirror and offset is right and executed; the chat gate is now real and measured with margin; the fix is "50" → "500" plus a one-clause definition, and the true ticker 2× measurements already exist and pass. R6 is a one-line diff and should be the last revision.
