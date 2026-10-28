APPROVED

# Exact-stage Critic review — B6 canonical `fanout-attested-r1` (section 9.7, phase-b), fourth stage (run #2 candidate)

Reviewer: Claude Code subagent, Critic pass, 2026-09-09 (~09:00–09:40Z). Pre-traffic review of exact bytes; every claim below names the command that produced it. Git was read-only throughout (`git rev-parse HEAD` → `c79e53ce98d540e37e8bceab2880dc6313c9d762` and `git status --porcelain -uno | wc -l` → `0`, before and after). Nothing on the rig was modified: the two `ssh -o BatchMode=yes -i /Users/vmeansdev/.ssh/ubuntu-vm-hermes hermes-admin@10.99.0.2` calls ran only `uptime`, `ss`, `df`, `ls`, `stat`, `sha256sum`, `pgrep` and `sudo -n -u _wtcompare` read probes (`test -e`, `find`, `ls`). The frozen command was **not** run, `compare-controller.ts` was **not** pointed at the staged directory, and the physical preflight was **not** run against the staged pair. The only file I wrote inside the repository is this artifact; every harness, every mutated evidence root and a byte-identical copy of the Rust workspace live in the session scratchpad. The Architect artifact (`.../reviews/architect.md`, `shasum -a 256` → `794cdca038b22b34016a21907338e8b19f1db450282bf04eaef27af34cb61918`) and the three earlier B6 review pairs were read as untrusted input and every claim I carry from them was re-executed here.

## Bindings

- Stage receipt SHA-256: `dd96bbf7d967af4fa1a1e84eb76d7d5beaf55b88cd5aa3e077305b18c44abf73`
- Upcoming run command SHA-256: `0489abbc080fcf14671613894212197b34a7cb8c295d214c31bd5fd2806c0ec0`
- Candidate HEAD: `c79e53ce98d540e37e8bceab2880dc6313c9d762`
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
- Campaign ID: `fanout-attested-r1`

Both digests recomputed here with `shasum -a 256` over the staged files.

## Verdict

**Approved. No blocker.** I tried to refute the two newest fixes and could not, and I drove every path the stop gate depends on that can be reached without spending the campaign — including one the three earlier reviews and the Architect all left unexamined.

That one is the finding of this pass, and it came out clean: **the Mac supervisor carries its own `MAX_SESSIONS_PER_CAMPAIGN = 64`** (`crates/native/src/secure_fs.rs:23854`), checked at `:24117` against `self.executions.len()` on every `mac-open-execution-request`. Section 9.7 opens 72 execution channels on that one campaign-scoped process, so had its PASS terminal not released, run #2 would have been refused at execution 65 on the *other* host — the identical failure `ff16a09f` fixed on the rig, one supervisor over. It does release: `:24409` calls `terminal_execution` on the cohort arm's `mac-export-cohort-evidence-request` ack and `:24566` on the ordinary arm's admission ack. I proved it by execution rather than by reading — 84 consecutive executions driven to their production terminal with both maps held at zero (§2.3). The tree's own coverage stops at three executions (`crates/native/tests/mac_cohort_runtime.rs:3646`), which is why no earlier pass saw the bound.

Everything else: both digests and every staged digest recompute; the frozen command is byte-identical to a rebuild from HEAD's fragments; the archive is the candidate tree by object identity; the promoted-flat binding refuses all three substitutions I could construct from real bytes, including one the earlier rounds did not try; the promoted render exits 3, 4 and 0 as documented; the wrapper's derived counts fail closed on every short report; both hosts are clean, both campaign keys present, the lease armed, and 12.5 h of slack stands before the latest admissible launch. Four residuals in §7, none able to produce a false PASS.

## 1. (a) Every path between "72 executions sealed" and `TERMINAL_KIND=PASS`

Nothing on this list is unexecuted-and-unexplained. Where a path could only be reached with a stub or a synthetic input, the row says so and §7 says why it cannot differ from one I did execute.

| # | step | code | driven on |
|---|---|---|---|
| 1 | rig bounds each accept: 84-entry acceptance ledger, 64 live sessions | `secure_fs.rs:18327`, `:18396` | **real Rust runtime**: `cargo test -p native --test rig_cohort_runtime` (55/0) runs 84 consecutive PASS arms; plus my three leak probes (§2.1) |
| 2 | rig releases the session on the stopped ack | `secure_fs.rs:18557-18569`, dispatched at `comparison-supervisor.rs:577-581` | **real runtime**, ordinary shape (72+12 arms) and fanout-cohort shape (`rig_cohort_runtime.rs:4067`), and over the resident loop's own frames (`comparison-supervisor.rs` `a_pass_arm_torn_down_over_the_loop…`) |
| 3 | **Mac holds one retained execution per open, bound 64, released on the export terminal** | `secure_fs.rs:23854`, `:24117`, `:24409`, `:24566` | **my scratch test: 84 consecutive executions through the production terminal, `execution_count()==0` and `session_count()==0` after each** (§2.3). No prior review executed this |
| 4 | controller resolves the staged signing leaves *before traffic*, or refuses | `compare-controller.ts:3371-3381` → `output-policy.ts:1398-1431` | **executed on a copy of the real staged pair**: `ok true mac32=32 rig32=32`; a swapped leaf → `STALE_OR_INVALID_STAGING` (§4.1) |
| 5 | `promoteCampaignFlats` writes the flats from the gate's median | `compare-controller.ts:1076-1165`, called at `:3854` with `sealClosesReceiptGraph` (`:996`) | **executed on run #1's 50 real seals** through the production function and production anchors: `receiptGraphComplete 50/50`, `promotedCells 5`, `flatsWritten 10`, `refusals []` (§3.1) |
| 6 | the controller's own positional render, whose nonzero exit sets `exitCode = 5` | `compare-controller.ts:2779-2796` | **executed** on a complete promoted root at the default path → rc **0** (§4.2). Run #1's rc 1 is explained and fixed |
| 7 | controller terminal record, and the wrapper's guarded parse of it | frozen command lines 314-369 | **executed on the staged bytes** against run #1's **real** record and four negative shapes (§4.3) |
| 8 | verifier: per-entry attestation, sealed-digest recomputation, external trust bound, count expectations | `verify-campaign-index.ts:920-926`, `:1160-1219` | **real bytes, frozen argv shape**: `VERIFY_CAMPAIGN_INDEX_OK pass=50 fail=0 refused=0 promotable=50 sealed=50 flats=10 pairs=5 attestationsVerified=50`, rc 0 (§3.1) |
| 9 | verifier binds every flat to the seal the gate selected | `verify-campaign-index.ts:1295-1336` | **real bytes, three independent substitutions, all `PROMOTED_FLAT_MISMATCH` rc 3** (§3.2) |
| 10 | every seal totals exactly its cell's cardinalities | `verify-campaign-index.ts:289-338` | real bytes for the five complete cells; and it is what refuses a cell built from another cell's seals (§3.3) |
| 11 | canonical fanout completion | `output-policy.ts:1251-1312`, gated at `verify-campaign-index.ts:1342-1352` | negative branch **on real bytes** (rc 3); positive branch executed as a function over **60 real index-entry records** (§3.4). End-to-end six-cell positive is run #2 itself — bootstrap, §7.1 |
| 12 | promoted render exit codes | `render-campaign-report.ts:850-867` | **all three executed**: rc 0 clean, rc 4 on two mutations, rc 3 on an unresolvable-leaves root (§3.5) |
| 13 | the wrapper's four counts (sealed files, flat files, attested-arm headings, COMPATIBLE rows) | frozen command lines 646-654 | **executed against real renderer output** for the clean root and four short reports; both new counts derive from the section's `CELLS` (§3.6) |
| 14 | the terminal ladder and `TERMINAL_KIND` | frozen command lines 665-676 | read; every branch's input executed above. `TERMINAL_KIND=PASS` is reachable only with `CONTROLLER_RC=0`, and with `CONTROLLER_RC=0` the record must have parsed **as PASS** (§4.3) or `CONTROLLER_RC` is forced to 68 at lines 570-588 |

## 2. (b) Attacking the session release

### 2.1 The rig: an arm that ends on anything but the stopped ack

`RigCohortRuntime::teardown_server` (`secure_fs.rs:18557`) releases only when the session's own answer leaves it at `ServerStopped`; the session's `teardown_server` (`:17899`) reaches that stage from `Captured`, `Measuring`, `OrdinaryServerSpawned` and `OrdinaryMeasuring`, and returns to `AwaitingGrant` on plan 2210's pre-readiness replacement. The binary intercepts the kind at `comparison-supervisor.rs:577`, **after** `request_execution_sha256` at `:566`, and the runtime's first act is the same `session_mut`, so frame validation and the no-session refusal are unchanged. Every other terminal I could find runs through `refuse_arm` (`:1028`) → `close_arm` (`:1112`) → `close_all`, which releases every session and, on the Mac side, `terminal_all_executions`.

Three attacks, appended to a byte-identical copy of the crate in scratch and run with `CARGO_TARGET_DIR=<scratch> cargo test -p native --test rig_cohort_runtime critic_` → **3 passed, 0 failed**:

- `critic_an_abandoned_arm_leaks_exactly_one_session_and_the_bound_needs_64_of_them` — an arm accepted, spawned and baselined and then simply abandoned (a measurement deadline, an unexpected EOF, a controller that never sends the teardown) leaks **exactly one** session, `session_count()` tracking the loop index 1:1, and the accept refuses `Overflow` only at the 65th. 
- `critic_a_mid_flight_refusal_retains_then_releases_through_close_all` — three arms refused mid-flight (an out-of-state capture) hold three sessions, and one `close_all` releases all three.
- `critic_a_teardown_whose_reap_fails_releases_nothing_and_stays_reachable` — a teardown whose reap cannot bound the group refuses, the session stays resident and reachable, and `close_all` ends it. The ack was never minted, so recording the execution as closed would have been the wrong answer.

**Why no leak can cost this campaign.** The bound is `sessions.len() >= 64` at accept, so reaching it needs **64 non-releasing terminals**. The campaign runs 72 executions (12 warmups + 60 measured; `LARGEST_FROZEN_SCHEDULE_EXECUTIONS` = `COHORT_CELLS.len() * 2 * (1 + 5)` = 72, `rig_cohort_runtime.rs:3906`) and the ledger admits 84, so at most 12 re-opened arms beyond the schedule. Every one of the 60 measured arms must be a PASS seal (`--expected-pass-count=60 --expected-fail-count=0`), and a PASS arm releases. The largest number of non-releasing terminals a campaign that still satisfies the stop gate can contain is therefore 12 warmups + 12 margin re-opens = 24, well under 64. A leak here cannot produce a false PASS, and cannot lose an otherwise-passing campaign either.

### 2.2 The two rig bounds are genuinely separate

`MAX_SESSIONS_PER_CAMPAIGN = 64` (`secure_fs.rs:18112`, checked `:18396` on `sessions.len()`) and `MAX_ACCEPTED_EXECUTIONS_PER_CAMPAIGN = 84` (`:18136`, checked `:18327` on `accepted.len()`) are distinct maps, constants and refusal sites, and `teardown_server` touches only the first. `grep -n close_all crates/native/tests/rig_cohort_runtime.rs` → `:3008 :3029 :3055` (the three tests *of* `close_all`), `:4259` (the refused-teardown test, whose subject is that a refusal releases nothing) and comment lines; no PASS-arm test reaches its precondition through it.

### 2.3 The Mac: the second 64-bound, and the check nobody had made

`grep -n "MAX_SESSIONS_PER_CAMPAIGN" crates/native/src/secure_fs.rs` returns **two** constants — `:18112` (rig) and `:23854` (`cohort::mac`). The Mac one is checked at `:24117` against `self.executions.len()` inside `construct_execution`, i.e. on every `mac-open-execution-request`, and refuses `MacRefusal::ResourceExhausted`. One campaign-scoped Mac process opens 72 execution channels. The tree's own coverage of the release is `one_process_completes_several_executions_without_leaking_retention` (`crates/native/tests/mac_cohort_runtime.rs:3646`), which runs **three**.

Appended to the scratch copy and run with `CARGO_TARGET_DIR=<scratch> cargo test -p native --test mac_cohort_runtime critic_` → **1 passed, 0 failed**:

- `critic_the_mac_holds_no_execution_across_the_largest_frozen_schedule` — 84 consecutive executions, each opened, driven to admission and closed by the production `export_evidence` terminal, asserting `runtime.execution_count() == 0` **and** `runtime.session_count() == 0` after every single one.

The Mac releases on its own PASS terminal at `secure_fs.rs:24409` (cohort export ack) and `:24566` (ordinary admission ack), and the `cohort::mac` module is untouched by the diff since `1b9e8092` (§5). So there is no second wall at execution 65.

## 3. (c) Attacking the flat binding, the render exit and the wrapper counts

All of §3 runs over a scratch root built from run #1's **real** seals — the five cells that have all ten (`chat-fanout/subscribers-1000` has only 3 ws seals and 7 unsealed entries) — promoted through the **production** `promoteCampaignFlats` with `sealClosesReceiptGraph` and run #1's real staged leaves, then verified in the frozen argv shape (all fifteen flags of command lines 607-628, with run #1's own bound `cac9d358…`, its two leaves and its stage receipt).

### 3.1 Control

`receiptGraphComplete 50/50`, `promotedCells 5`, `flatsWritten 10`, `refusals []`; verifier `VERIFY_CAMPAIGN_INDEX_OK pass=50 fail=0 refused=0 promotable=50 sealed=50 flats=10 pairs=5 promotedCells=0 canonicalFanoutComplete=false integrityOnly=false attestationsVerified=50`, rc **0**; promoted render rc **0**, `formalComparable=5/5 refused=0`, **10** attested-arm headings and **5** COMPATIBLE rows under the wrapper's own two regexes. `promotedCells=0` is the same benign artefact the Architect explains: `verify-campaign-index.ts:1342-1352` computes it only for an index scheduling all six fanout cells, and this root schedules five. Every substantive counter matches the lead's numbers.

### 3.2 Three substitutions, three refusals

| root | mutation | verifier | render |
|---|---|---|---|
| `rootA` | two WT flats swapped across cells | `PROMOTED_FLAT_MISMATCH: ticker-fanout_rate-50-wt.json is not the artifact the promotion gate selected for ticker-fanout/rate-50 wt (rep 3, 14aab43a…): found b323aebd…`, rc **3** | rc **4**, `RENDER_INCOMPATIBLE: 2 of 5`, 10 headings, **3** COMPATIBLE |
| `rootB` | a WT flat replaced by rep 1 of its own arm | same code, `found b169924e…`, rc **3** | rc **4**, `1 of 5`, 10 headings, **4** COMPATIBLE |
| `rootC` (**new here**) | a WS flat replaced by a *fully attested seal of another cell* — the "partner from somewhere else" shape | `PROMOTED_FLAT_MISMATCH: ticker-fanout_rate-25-ws.json … (rep 3, 3962e797…): found 326f5e3d…`, rc **3** | rc **4**, `1 of 5`, 10 headings, **4** COMPATIBLE |

`rootA` and `rootB` reproduce the lead's digests exactly. The binding cannot be satisfied by a flat from another campaign or candidate either: the flat's own sha256 must equal `promoted.artifactSha256`, and that field is not the index's word — `verify-campaign-index.ts:920-926` re-reads the sealed file from disk and refuses `artifact sha mismatch` unless it hashes to it, having first refused symlinks, traversal and any path not ending `.sealed.json` (`:890-919`). Both halves of a pair are bound to the same median repetition, so one honest flat cannot carry a dishonest partner.

### 3.3 A median that names a warmup, and a cell built from another cell's data

- **Warmup as median.** Relabelling the gate's median entry `repetitionKind: "warmup"` is refused before the gate even runs: `TRUST_PROTOCOL: entry ticker-fanout/rate-25/ws is a warmup repetition; a sealed campaign index holds measured repetitions only`, rc 3. Behind that, `gateOneTransport` (`output-policy.ts:996-1002`) refuses the whole cell `PROMOTION_ENTRY_NOT_MEASURED`. Run #1's real index confirms the production shape: 60 entries, **0** non-measured, 53 sealed, and `find … -name '*.sealed.json'` → 53 — warmups are neither indexed nor sealed.
- **A sixth cell forged from the fifth.** I built a six-cell root whose `chat-fanout/subscribers-1000` entries point at copies of `chat-fanout/subscribers-500`'s real, fully attested seals under `subscribers-1000` paths. **The promotion happily promoted six cells and wrote twelve flats** — `promoteCampaignFlats` is not the cell-identity check, exactly as the third round's row 5 said. The verifier refused it: `COHORT_PROTOCOL: cohort evidence does not reconstruct for …/chat-fanout_subscribers-1000/ws/rep-1.sealed.json: COHORT_EVIDENCE_GRAPH_INVALID process proof cardinality disagrees with the export`, rc **3**. Behind that sits the stop gate's "every seal totals exactly the cell cardinalities" clause (`checkExpectedTotals`, `verify-campaign-index.ts:289-338`), which compares the *reconstructed* publisher/subscriber/ingress/delivered figures against `cohortCellCardinality`. This is the clause that makes a promoted pair honest about which cell it measured, and it is executed on real bytes.

### 3.4 Canonical completion

`evaluateCanonicalFanoutCompletion` (`output-policy.ts:1251-1312`) is a pure conjunction of `evaluateCellPromotionGate` applied per cell — the same gate the promotion path uses — and two integer equalities (`promoted.length === 6`, `measuredPassSeals === 60`). It adds no clause of its own; I read every line of it. Executed here:

- **negative, real bytes**: the five-cell root plus `--expect-canonical-fanout-complete` → `TRUST_PROTOCOL: canonical fanout completion requires a canonical index scheduling all 6 fanout cells`, rc 3.
- **negative, function level**: 50 real entries over five cells → `complete false promotedCells 5 measuredPassSeals 50 flatCount 10 refusals []`.
- **positive, function level over 60 real index-entry records**: `complete true promotedCells 6 measuredPassSeals 60 flatCount 12 refusals []`. The sixth cell's ten records are real entries relabelled, and `receiptGraphComplete` is supplied `true` rather than recomputed — that stub is exactly the input `verify-artifact.ts` owns and that I verified separately at 50/50 in §3.1.

This is stronger than the "fixture only" the earlier rounds recorded, and I agree with the Architect that it is not blocker-grade: see §7.1.

### 3.5 The render's three exits, all executed

`render-campaign-report.ts:850-867`: `refused > 0` → 3, then `rejected > 0` → 4, else 0. Reproduced rc 0 (clean), rc 4 (`rootA`, `rootB`, `rootC`) and rc **3** by pointing the index's `stagedDir` at a path with no receipt: `formalComparable=0/5 refused=5`, `SIGNING_LEAVES_UNRESOLVED: 5 cohort cells refused`. Note what that last case shows: the report still carried **10** attested-arm headings, so the heading count alone would not have caught it — the COMPATIBLE-row count (0) and the exit code both did. The second of `c79e53ce`'s two counts is the load-bearing one.

### 3.6 The wrapper counts, and duplicate rows

Read in the **staged** file, lines 652-654: `CELL_COUNT` comes from `printf '%s\n' "$CELLS" | tr ',' '\n' | grep -c .` over the section's own six-entry `CELLS` (line 681), so the two counts are 12 and 6 rather than literals. Both regexes were exercised against real renderer output, never a fixture, and every short report failed at least one of them (3, 4, 4 and 0 COMPATIBLE against 5). A zero-match `rg` prints nothing and exits 1, and `test "" = "12"` is false, so it fails closed — reproduced in §3.5.

Duplicate rows cannot satisfy them. `proveRegisteredTopology` (`verify-campaign-index.ts:386-395`) compares `index.cells` to the frozen list with `sameMembers` (`:360-368`), which is length **plus** sorted equality — an exact multiset, so a duplicated cell is refused. Executed both ways: with the duplicate also in `--expect-cells`, the flag parser refuses (`--expect-cells is not a cell list`, rc 2); with the frozen distinct list, `TRUST_PROTOCOL: index cells [… ,ticker-fanout/rate-25] are not the registered cells […]`, rc 3. Independently, `flats=12` with `pairs=6` requires six *distinct* `<cell>-ws.json`/`<cell>-wt.json` filenames (`:1232-1237`), and each must map to a scheduled cell (`:1253-1265`), so five real cells can never present twelve flats.

A REFUSED cell cannot line the counts up either: `--expected-refused-count=0` refuses at the verifier, and a cell the renderer cannot verify sets `refused > 0` → rc 3 and files no COMPATIBLE row.

## 4. Three further seams I drove that the earlier passes did not

### 4.1 The pre-traffic leaf resolution — the seam that produced run #1's zero flats

Run #1 wrote **no flats at all** (`find .release-evidence/…/88b14a03…/fanout-attested-r1 -maxdepth 1` → `campaign-index.json`, `controller-terminal.json`, `integrity-only`, `reps`). `2bf0ccd2`'s own diff names the cause: without the staged leaves the verifier refuses each cohort export receipt and all 53 PASS seals answered `PROMOTION_RECEIPT_GRAPH_INCOMPLETE`. The fix makes the leaves a pre-traffic precondition: `compare-controller.ts:3371-3381` resolves them when `useInProcessSeal` (`:3326`, true whenever the campaign spawns the Mac supervisor from `--staged-dir`, which the frozen command passes at line 556) and **refuses the campaign** `REFUSED/…: promotion cannot close a receipt graph` otherwise.

Executed against a scratch copy of the real staged pair (`stage-receipt.json` plus both `.pub` leaves, copied out; the staged directory itself untouched): `resolveStagedSigningLeaves` → `ok true mac32=32 rig32=32`. With the Mac leaf overwritten by the rig leaf: `ok false STALE_OR_INVALID_STAGING: staged Mac public key does not match the receipt`. So run #1's silent zero-flat outcome cannot recur — it is now either a pre-traffic refusal or a working promotion.

### 4.2 The controller's own render, which gates the whole wrapper

`compare-controller.ts:2779-2796` spawns `render-campaign-report.ts <campaignId> <candidate>` positionally after a successful real run and, on any nonzero exit, sets `exitCode = 5` with `CHILD_LIFECYCLE`. That is run #1's terminal record verbatim (`controllerExitCode: 5`, `failureCode: "CHILD_LIFECYCLE"`, `trafficStarted: true`), and it matters because `CONTROLLER_RC != 0` makes the wrapper skip the verifier, the promoted render and all four counts entirely (lines 596-664). I checked it does not fire on a healthy campaign: running that exact positional invocation from a scratch working directory laid out as `.release-evidence/transport-comparison/<candidate>/<campaign>` over a complete promoted root → `formalComparable=5/5 refused=0`, exit **0**. Run #1's rc 1 was the zero-flat root of §4.1.

Two consequences worth stating. First, this is a *tightening* at `c79e53ce`: the same renderer now returns 4 when a pair does not compare, so a report short of 6/6 makes the controller exit 5 and the campaign fails before the verifier ever runs — fail-closed, in the right direction. Second, it writes `report.md` beside `campaign-report.md` in the campaign root; `.md` matches none of the wrapper's `*.json` finds, and I confirmed the clean flat count is 10 under the wrapper's exact `find` expression.

### 4.3 The terminal record path, driven on the staged bytes

I extracted lines 314-369 of the staged command (the `parse_controller_terminal_record` definition, nothing else) into scratch, sourced it, and drove it:

| input | result |
|---|---|
| run #1's **real** record, `CONTROLLER_RC=5` | prints `FAIL`, rc 0 |
| the same record with `CONTROLLER_RC=0` | rc 5 (the `controllerExitCode` correlation) |
| the same record under this candidate's identity | rc 4 |
| a canonical `PASS` record, `CONTROLLER_RC=0` | prints `PASS`, rc 0 |
| the same `PASS` record, `CONTROLLER_RC=1` | rc 5 |
| a `PASS` record claiming `trafficStarted: false` | rc 5 |

So the ladder at lines 665-671 cannot launder a bad record: `TERMINAL_KIND=PASS` at line 670 is reachable only with `CONTROLLER_RC=0`, and with `CONTROLLER_RC=0` a record that is missing, unparseable, or anything but a well-formed PASS forces `CONTROLLER_RC=68` and `TERMINAL_KIND=FAIL` at lines 570-588 before the verifier is ever invoked.

## 5. (d) Nothing in the diff reaches the traffic path

`git diff --name-only 1b9e8092 c79e53ce` → 27 files. I computed the transitive relative-import closure of both role entrypoints myself and deliberately followed it further than the Architect did — into `packages/webtransport/src/`, since the staged `roles/*.ts` are plain copies whose digests do not cover imports. Closure = **34** files (the two entrypoints, the three adapters, the three fanout scenarios, ten `tools/compare` modules and sixteen `packages/webtransport/src` modules). `comm -12` against the changed set → **exactly one** file, `tools/compare/cross-supervisor-protocol.ts`, and `git -c diff.external= diff --no-ext-diff --numstat` over it → `49 0`: purely additive (the trust-bound schema constant, the preimage interface, the field-order array and the pure `externalTrustBoundSha256`). No existing export is touched and nothing added runs on the traffic path.

On the Rust side, only `comparison-supervisor.rs`, `secure_fs.rs` and `rig_cohort_runtime.rs` changed. `git -c diff.external= diff --no-ext-diff -U0 1b9e8092 c79e53ce -- crates/native/src/secure_fs.rs | grep -E '^@@'` gives seven hunks, all between lines 18102 and 18572 — inside `pub mod cohort` → `pub mod rig` (which opens at `:15388`, with `pub mod mac` not starting until `:18797`). No relay, transport, server, worker or client source is in the diff at all, and `git ls-files | grep -c '\.node$'` → 0, so no prebuilt addon rides in the archive. The eight D4 receipts under `preflight/1b9e8092…/` still describe this candidate's physics.

## 6. (e) The bytes, the hosts and the clock

**Digests, all recomputed here with `shasum -a 256`.** The two bindings above; `authority.json` → `8e4ec977…`; `campaign-root/campaign-lock.json` → `bc71abf1…`; `staging-root/staged-capability.json` → `5f3a495c…`; `staged-server-tls.crt` → `6b7629db…`; `mac-supervisor-ed25519.pub` → `7db9059d…`; `rig-supervisor-ed25519.pub` → `8028b0e2…`; `rig-signing-key-lease.armed.json` → `b57cbc07…`; plan `2026-09-08-physical-budget-amendment.md` → `c98fdb39…` = `approvedPlanSha256`; its approval → `0e54de08…` = `approvalRecordSha256`; deviations → `ccc0964e…` and `5c23bce5…`. Every one equals the receipt or the brief.

**External trust bound.** Driving HEAD's own `externalTrustBoundSha256` (`cross-supervisor-protocol.ts:196-216`) over the ten preimage fields read from the staged receipt → `5c38aa838496902a68ccb41354bbb969a3fdb9f621d6a00ead25afb68e70bdd7`, equal to the receipt's field and to the `EXTERNAL_TRUST_BOUND_SHA256='…'` literal at line 33.

**The archive is the candidate tree.** `git archive --format=tar c79e53ce…` regenerated into scratch → `shasum -a 256` `4a2bb42db1749ff73ecf6959a635891222f6be035752e7fdb6eb1452ae88f370` = `archiveSha256`, `stat -f%z` `54466560` = `archiveSize`, `tar -tf | wc -l` `2073`; and `git rev-parse HEAD^{tree}` → `4a3221655109605cbd99ef9b4dce145cb4ee8b49` = `candidateTreeOid`.

**The frozen command rebuilds byte-identically.** Importing `buildFrozenRunCommand` from HEAD's `stage-live-campaign.ts:1145` with the staged receipt and the staged path literals, writing it to scratch and `cmp` against the staged file → **identical**, digest `0489abbc…`, **692** lines. The brief's "686 lines" is wrong and the Architect is right; the digest is what binds and it matches. `test "$CAMPAIGN_ID" = fanout-attested-r1` and `test "$EXECUTION_PURPOSE" = canonical` at lines 677-678, and the section parameters at lines 681-691 are the frozen six cells, `REPS=5`, `EXPECTED_PASS/PROMOTABLE/SEALED=60`, `EXPECTED_FLATS=12`, `EXPECTED_PAIRED_PROMOTIONS=6`, `EXPECT_CANONICAL_FANOUT_COMPLETE=1`, `RENDER_MODE=promoted`, `CAMPAIGN_TIMEOUT_MS=14400000`, with `RUN_TIMEOUT_MS=16200000` at line 19.

**Admission precedes the traps.** Lines 519-535: the two leaf digest checks, then `REQUIRED_REMAINING_MS=$(( RUN_TIMEOUT_MS + 5400000 ))` = 21,600,000 with `test "$(( STAGE_NOT_AFTER_MS - NOW_MS ))" -gt "$REQUIRED_REMAINING_MS"`, then the sole `verify-stage-approval`; only then are `INT`/`TERM`/`HUP`/`EXIT` armed. A refusal in that block leaves both campaign keys intact.

**Clock.** `STAGE_NOT_AFTER_MS=1789011457298` = 2026-09-10T03:37:37Z. At 2026-09-09T09:07:06Z, 66,630,386 ms remain (**18.51 h**) against the 21,600,000 ms gate: **12.51 h of slack**, latest admissible launch **2026-09-09T21:37:37Z**. Run #1 sealed 64 executions in about half an hour, so the 35-minute expectation sits far inside both `RUN_TIMEOUT_MS` and `CAMPAIGN_TIMEOUT_MS`.

**Hosts, live.**

- Mac campaign key `/var/db/webtransport-bun/comparison/keys/<candidate>/fanout-attested-r1.mac.pk8` → **PRESENT** (`sudo -n -u _wtcompare test -e`, the owning account). Rig key `/var/lib/…/fanout-attested-r1.rig.pk8` → **PRESENT** (same probe over ssh).
- Mac runtime binaries: `comparison-supervisor` → `693988ad…` = `macSupervisorSha256`, `bun` → `e0c90ec1…` = `macBunSha256`. Rig `bin/comparison-supervisor` → `870d3687…` = `linuxSupervisorSha256`. Both supervisors were rebuilt for the `secure_fs.rs` change, as the receipt says.
- Rig role root `/tmp/ws-wt-linux-build.bmYbJx/tools/compare` present, `server.ts` → `aeef5d1b…` and `bin/fanout-role.ts` → `d9c3f971…`, both equal to the receipt.
- Rig stage directory `stat -c` → `inode=8265884 mode=755 uid=1001 gid=1001 links=8 dev=66308` (= major 259, minor 4), the preimage `linuxDirectoryIdentitySha256` describes.
- Lease `armed`, `notAfterMs 1789011457298`, `rigPublicKeySha256 8028b0e2…`.
- Replay ledgers empty on both hosts (0 files). Campaign root `.release-evidence/transport-comparison/<candidate>/fanout-attested-r1` exists and holds **0 files** — no execution records.
- Port 4433 free on both: rig `ss -lunp | grep -w 4433` → no match; Mac `lsof -nP -iUDP:4433 -iTCP:4433` → none.
- Rig: `/` 16 % used, `/tmp` tmpfs 68 % with 2.0 G free, load `0.08 0.03 0.00`. Only two long-lived `bun` processes, the 2026-08-29 echo servers on 4446/4447 (§7.2).
- Mac: after both acceptance runs, `ps -axo pid,user,etime,command | grep -E "comparison-supervisor|fanout-role|compare-controller"` → **0** survivors. Load `3.17 3.37 3.29` with `WindowServer` at 43 % and ChatGPT/Codex helpers at 20 % and 9 % (§7.4).
- `command -v rg` → `/opt/homebrew/bin/rg`, ripgrep 15.1.0, also on a login shell's PATH (`zsh -lc`).
- `exact-stage-approval.json` does **not** yet exist under the staged directory. The order is: this review → write it → launch. Launching first arms the EXIT trap and destroys both campaign keys.

**Gates, all reproduced at this candidate.**

| gate | command | result |
|---|---|---|
| TS suite | `bun test tools/compare` | **1967 pass, 0 fail**, 38686 expect, 67 files, 316.27 s, rc 0 |
| Rust suite | `cargo test -p native` | **744 passed, 0 failed** (summed over 11 `test result:` lines), rc 0 |
| Types | `npx tsc --noEmit` | rc **0** |
| Official I/O | `bun tools/compare/check-official-io.ts` | `failure-count=0`, rc 0 |
| Local acceptance ×2 | `bun test tools/compare/fanout-production-e2e.test.ts` | run 1 **19 pass / 0 fail**, 393 expect, 195.92 s, rc 0; run 2 **19 pass / 0 fail**, 393 expect, 196.38 s, rc 0; no supervisor, controller or role process survived either |

## 7. Residuals — stated, none blocker-grade

**7.1 The six-cell completion positive branch, end to end, is still run #2 itself.** No complete six-cell canonical set exists, so the branch cannot be reached over real seals before the run that would create one. It is not blocker-grade, and I say so having executed both halves of it separately rather than inheriting the earlier rounds' conclusion: the function is a conjunction of `evaluateCellPromotionGate` — the same gate I ran on real bytes in both directions (promotable for five real cells; the real incomplete sixth correctly refused `PROMOTION_ARM_PAIR_INCOMPLETE`) — and two integers that four frozen expectations (`--expected-promotable-count`, `--expected-pair-count`, `--expected-flat-count`, `--expected-sealed-count`) assert independently and that I executed at five-cell scale. Its positive branch answered `complete true / 6 / 60 / 12` over 60 real entry records (§3.4), and every substantive stop-gate clause — the per-flat binding, `checkExpectedTotals`, the render's 6/6, the wrapper's derived counts — is a separate gate I reproduced on real bytes. A permissive wrong answer here is caught elsewhere; a refusing one costs a stage, never a false PASS.

**7.2 Two idle rig `bun` processes.** PIDs 3733490 (`rig-min-wt-echo-server.js`, UDP 4447) and 3733749 (`rig-min-echo-server.js`, TCP 4446), running since 2026-08-29 — eleven days before run #1, so a constant of the environment run #1 was measured in, not a new perturbation. They hold neither 4433 nor any campaign resource, and rig load is 0.08. Reap them at a later window rather than now.

**7.3 The rig role root lives on tmpfs at 68 %.** `/tmp/ws-wt-linux-build.bmYbJx/tools/compare` holds the right bytes today, but a reboot or tmpfs pressure would destroy it and the failure would land *after* admission, destroying both keys. Re-probe the two role digests immediately before launch and launch inside the 12.5 h window.

**7.4 Two ambient dependencies of the wrapper.** It sets no `PATH`, and the two new counts call `rg`; and the Mac's load is the usual WindowServer/Codex pattern. Neither can produce a false PASS — a missing `rg` fails closed — but both are cheap to remove: confirm `command -v rg` in the launching shell, and quiesce the Mac, which drives the client side of every arm.

Two non-issues I checked and am recording so the next reader need not: the wrapper's `FAILURES` enum (frozen line 322-328) still omits `DELIVERY_CONTEXT_MISMATCH`, which `cross-supervisor-protocol.ts:135` defines — a terminal record carrying it parses as unreadable and becomes `CONTROLLER_RC=68`/FAIL, i.e. a coarser failure, never a pass. And `controller-terminal.wrapper-substitute.json` is excluded from neither the wrapper's flat `find` nor the verifier's `RUN_CONTROL_FILENAMES` (`verify-campaign-index.ts:151-155`) — the two filters agree exactly, and the substitute is written only when `CONTROLLER_RC != 0`, on which path no count runs.

---

Verification summary: `git rev-parse HEAD` → `c79e53ce98d540e37e8bceab2880dc6313c9d762`, `git status --porcelain -uno | wc -l` → `0`, before and after. `bun test tools/compare` 1967/0 · `cargo test -p native` 744/0 · `npx tsc --noEmit` 0 · `check-official-io` failure-count 0 · `bun test tools/compare/fanout-production-e2e.test.ts` 19/0 twice · scratch-crate `critic_` probes 3/0 (rig) and 1/0 (Mac).
