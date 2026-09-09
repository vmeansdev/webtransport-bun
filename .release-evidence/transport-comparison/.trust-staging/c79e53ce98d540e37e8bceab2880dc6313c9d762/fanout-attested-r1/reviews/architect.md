APPROVED

# Exact-stage Architect review — B6 canonical `fanout-attested-r1` (section 9.7, phase-b), fourth stage (run #2 candidate)

Reviewer: Claude Code subagent, Architect pass, 2026-09-09 (~08:35–09:05Z). Pre-traffic review of exact bytes. Git read-only throughout (`git status --porcelain -uno | wc -l` → `0` before and after; `git rev-parse HEAD` → `c79e53ce98d540e37e8bceab2880dc6313c9d762` before and after). Nothing on the rig was modified: every `ssh -o BatchMode=yes hermes-admin@10.99.0.2` call ran only `ps`, `ss`, `pgrep`, `uptime`, `df`, `stat`, `sha256sum`, `find`, `ls` and `sudo -n -u _wtcompare` read probes (`sh -c 'test -e'`, `stat`, `sha256sum`, `find`). The frozen command was **not** run, `compare-controller.ts` was **not** pointed at the staged directory, and the physical preflight was **not** run against the staged pair. The only file written under the repository is this artifact; every harness and every mutated root lives in the session scratchpad (`scratchpad/{rebuild.ts,promote.ts,verify5.sh,verify5b.sh,etb.ts,closure.ts,arch/,treeid/,root5,root5b,rootCtl,rootA,rootB}`). The three earlier B6 review artifact pairs were read and treated as untrusted input; every claim I carry forward was re-executed here and the proving command is cited.

## Bindings

- Stage receipt SHA-256: `dd96bbf7d967af4fa1a1e84eb76d7d5beaf55b88cd5aa3e077305b18c44abf73`
- Upcoming run command SHA-256: `0489abbc080fcf14671613894212197b34a7cb8c295d214c31bd5fd2806c0ec0`
- Candidate HEAD: `c79e53ce98d540e37e8bceab2880dc6313c9d762`
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
- Campaign ID: `fanout-attested-r1`

Both digests recomputed here with `shasum -a 256` over the staged files and equal to the values above.

## Verdict

**Approved. No blocker.** The two blockers the third round raised are fixed, and I reproduced both fixes by execution on run #1's real seals and on the real Rust runtime — not on stubs. Every byte of the stage receipt and the frozen command reproduces from HEAD; the archive is the candidate tree by object identity two independent ways; both hosts are clean and both campaign keys are present with the lease armed; validity leaves 12.9 h of slack before the latest admissible launch. Four residuals are stated in §5, none of which can produce a false PASS; the strongest of them (§5.1) is the six-cell completion branch, and I show below why it is not blocker-grade at this candidate rather than asserting it.

## 1. The two newest fixes, by execution

### 1.1 `ff16a09f` — a PASS arm releases its rig session

**Read.** `crates/native/src/secure_fs.rs:18536-18569` adds `RigCohortRuntime::teardown_server`, which calls `self.session_mut(execution_sha256)?`, delegates to the session, and then — only when `session.stage() == RigCohortStage::ServerStopped` — does `self.sessions.remove(...)` and `self.closed.insert(...)`. `crates/native/src/bin/comparison-supervisor.rs:571-581` moves the `rig-teardown-server-request` arm out of the session `match` and into a runtime call placed **after** `request_execution_sha256(payload)` (`:565`), so the frame validation and the "no session for this execution" refusal are the same as for every other session-routed kind; the session cannot remove itself from the map it was borrowed out of, which was the missing release.

**The two bounds are separate.** `MAX_SESSIONS_PER_CAMPAIGN = 64` (`secure_fs.rs:18112`) is checked at `:18396` against `self.sessions.len()`; `MAX_ACCEPTED_EXECUTIONS_PER_CAMPAIGN` (`:18136`, `COHORT_CELLS.len() * 2 * (WARMUP + CANONICAL_MEASURED + 1)` = 6·2·7 = 84) is checked at `:18327` against `self.accepted.len()`. Distinct maps, distinct constants, distinct refusal sites. The acceptance survives the release (`accepted` is untouched by `teardown_server`), so a re-presented execution is a `Duplicate` on both accepts and `closed` blocks `accept_cohort` rebuilding the session.

**No test in the rig file reaches its own precondition through `close_all`.** `grep -n close_all crates/native/tests/rig_cohort_runtime.rs` → `:3008`, `:3029`, `:3055` (the three tests **of** `close_all` itself), `:4259` (the refused-teardown test, whose subject is precisely that a refusal releases nothing and the refusal path ends the arm), and comment lines `:3925`, `:3979-3981`, `:4039`, `:4062`, `:4219`. None of the new PASS-arm tests calls it.

**Executed.**
- `cargo test -p native --test rig_cohort_runtime` → **55 passed, 0 failed**.
- `cargo test -p native --bin comparison-supervisor a_pass_arm_torn_down_over_the_loop` → **1 passed**. This is the resident-loop test the third-round Critic demanded in its §1.5: `a_pass_arm_torn_down_over_the_loop_releases_its_session_and_the_next_execution_is_accepted` (`comparison-supervisor.rs:6162`) drives the PASS arm over `ResidentLoop`'s own frame dispatch — accept, spawn, baseline, capture, teardown through the production `LibcProcessGroupReaper` — and then accepts the next execution on the same channel.
- `cargo test -p native` → **744 passed, 0 failed** (summed across all binaries with `awk` over `^test result:` lines).

**What the 72-and-84 test actually states** (`rig_cohort_runtime.rs:3984-4035`): it runs `run_ordinary_pass_arm` for `1..=72`, asserting `session_count() == 0` **after every single arm** and `accepted_count() == index`; then continues `73..=84` (the margin), still `session_count() == 0`; then asserts every arm reaped exactly one group; then that execution 7, torn down long ago, is refused `CohortRefusal::Duplicate` and `session_mut` on it `is_err()`; then that the 85th is `CohortRefusal::Overflow` with `code() == "COHORT_PROTOCOL"`, mints nothing, and leaves the ledger at 84. `run_ordinary_pass_arm` (`:3926`) uses `accept_execution` → `session_mut` → the signed lifecycle → the **runtime's** `teardown_server`, i.e. the binary's dispatch path, and calls no `close_all`. The 64/65 test (`:4043`) asserts `session_count() == 1` after the 65th accept — an assertion that can only hold if the preceding 64 released.

**Refused arms and duplicates still behave.** `a_refused_teardown_keeps_the_session_for_the_refusal_path_to_release` (`:4219`) pins that a refused teardown releases nothing; the release is gated on `ServerStopped`, so plan 2210's pre-readiness replacement (which returns the session to `AwaitingGrant`) keeps its session.

### 1.2 `c79e53ce` — promoted flats bound to the gate's median, and the wrapper's derived counts

**Read.** `verify-campaign-index.ts:1295-1336`: for each cell with a flat under its name, the promotion gate's `median` names a sealed path, the verified index entry at that path is located among `gateEntries` (matching `cellId`, `transport`, `armKind === "primary"`, `sealedPath`), and the flat's own sha256 must equal that entry's `artifactSha256`; anything else is `PROMOTED_FLAT_MISMATCH` naming flat, cell, rep and both digests. I confirmed `artifactSha256` is the digest of the `.sealed.json` the entry names (`shasum -a 256 …/ticker-fanout_rate-25/ws/rep-1.sealed.json` → `0059b4e4…`, equal to that entry's field), and that `promoteCampaignFlats` (`compare-controller.ts:1163-1165`) writes the flat as a byte copy of `median.{ws,wt}SealedPath` — so the binding compares like with like.

**Reproduced the lead's three real-bytes results.** Five-cell root built in scratch from run #1's real seals (the five cells with all ten seals; `chat-fanout/subscribers-1000` has only 3 and 7 FAIL entries), index copied and its `sealedPath` values rewritten to the scratch root, then the **production** promotion driven through `promoteCampaignFlats` with `sealClosesReceiptGraph` and the real staged leaves from the `88b14a03…` trust directory:

| root | promotion | `verify-campaign-index` (frozen argv shape) | promoted render |
|---|---|---|---|
| clean (`rootCtl`) | `receiptGraphComplete 50/50`, `promotedCells 5`, `flatsWritten 10`, `refusals []` | `VERIFY_CAMPAIGN_INDEX_OK pass=50 fail=0 refused=0 promotable=50 sealed=50 flats=10 pairs=5 attestationsVerified=50`, rc **0** | rc **0**, `formalComparable=5/5 refused=0`, **10** attested-arm headings, **5** COMPATIBLE rows |
| two WT flats swapped across cells (`rootA`) | — | `PROMOTED_FLAT_MISMATCH: ticker-fanout_rate-50-wt.json is not the artifact the promotion gate selected for ticker-fanout/rate-50 wt (rep 3, 14aab43a…): found b323aebd…`, rc **3** | rc **4** (`RENDER_INCOMPATIBLE: 2 of 5`), `3/5`, 10 headings, **3** COMPATIBLE rows |
| WT flat replaced by rep 1 of its own arm (`rootB`) | — | `PROMOTED_FLAT_MISMATCH … (rep 3, 14aab43a…): found b169924e…`, rc **3** | rc **4** (`RENDER_INCOMPATIBLE: 1 of 5`), `4/5`, 10 headings, **4** COMPATIBLE rows |

The control (`rootCtl`, same construction, no mutation) passes rc 0, so the refusals are the mutation and not the scratch shape.

**One deviation from the lead's numbers, understood and benign.** My clean root reports `promotedCells=0`, not `5`. `verify-campaign-index.ts:1342-1352` computes `promotedCells` only when the index schedules **all six** `FANOUT_COHORT_CELL_IDS`; my root drops the sixth from `index.cells`, so the completion evaluator never runs. Rebuilding the root with six scheduled cells and the same fifty entries (`root5b`) gives the promotion `promotedCells 5` with `chat-fanout/subscribers-1000` refused `PROMOTION_ARM_PAIR_INCOMPLETE` — the lead's figure — and the verifier then correctly refuses on a different clause (`index scheduledMeasuredArms 50 is not the 60 the registered topology schedules`). Every substantive counter (`pass`, `promotable`, `sealed`, `flats`, `pairs`, `attestationsVerified`) matches the lead exactly. This is a difference in how the rehearsal root was shaped, not a disagreement about code.

**The render's exit path** (`render-campaign-report.ts:849-867`): `refused > 0` → `RENDER_REFUSED_EXIT_CODE` (3, leaves unresolved); `rejected > 0` → `RENDER_INCOMPATIBLE_EXIT_CODE` (4, verified but not comparable), with the report written either way. Both codes land in `RENDER_RC`, which sets `TERMINAL_KIND=FAIL`.

**The wrapper's two counts, read in the STAGED file, not the fragment** (`upcoming-run-command.sh:652-654`):

```
CELL_COUNT=$(printf '%s\n' "$CELLS" | tr ',' '\n' | grep -c .)
test "$(rg -c '^### (WS|WT) attested arm' "$OUT/campaign-report.md")" = "$((CELL_COUNT * 2))" || COUNT_RC=$?
test "$(rg -c '^\| `[^`]*` \| \*\*COMPATIBLE\*\* ' "$OUT/campaign-report.md")" = "$CELL_COUNT" || COUNT_RC=$?
```

`CELL_COUNT` is derived from the section's own `CELLS` (line 681, six entries), so both counts are 12 and 6 rather than literals. A short report fails: on `rootA` the comparable count reads 3 against 5 and on `rootB` 4 against 5, and `COUNT_RC != 0` sets `TERMINAL_KIND=FAIL` and `ORIGINAL_RC` (lines 666-671). I also checked the failure mode of a zero-match `rg` (exit 1, empty stdout): `test "" = "12"` is false, so `COUNT_RC` is set — it fails closed rather than passing. Both regexes were exercised against **real renderer output**, not a seeded fixture: the real five-cell report carries exactly 2 headings and 1 COMPATIBLE row per cell.

**The report's required content, on the real render** (`rootCtl/campaign-report.md`): each attested-arm section carries `Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions`, `Totals (recomputed from the retained partials): offered ingress … delivered … post-stop drain 0`, the three attested figures (`busyMs …`, `Server-child main-thread CPU …`, `Server-child process CPU …`, each with its window percentage) and the full `Claim boundary:` sentence. That is the stop gate's per-arm reporting clause, verified on real bytes.

## 2. The bytes

**Digests, all recomputed here.** Stage receipt and frozen command as in the Bindings. `authority.json` → `8e4ec977…`; `archive-member-inventory.txt` → `72552215…` (2073 lines); `campaign-root/campaign-lock.json` → `bc71abf1…`; `campaign-root/manifest.json` → `d0503a46…`; `staging-root/staged-capability.json` → `5f3a495c…`; `staging-root/staged-server-tls.crt` → `6b7629db…`; `staging-root/mac-supervisor-ed25519.pub` → `7db9059d…`; `staging-root/rig-supervisor-ed25519.pub` → `8028b0e2…`; `staging-root/rig-signing-key-lease.armed.json` → `b57cbc07…`; `roles/server.ts` → `aeef5d1b…`; `roles/fanout-role.ts` → `d9c3f971…`; `roles/stage-live-campaign.ts` → `2e3506d9…`. Plan `docs/superpowers/plans/2026-09-08-physical-budget-amendment.md` → `c98fdb39…` and approval → `0e54de08…`, equal to `approvedPlanSha256` / `approvalRecordSha256`. Deviations `2026-09-09-ticker-250-retired-by-preflight.md` → `ccc0964e…` and `2026-09-09-b6-verify-external-trust-bound.md` → `5c23bce5…`, unchanged from the digests the third round recorded.

**External trust bound recomputes.** Driving HEAD's own `externalTrustBoundSha256()` (`tools/compare/cross-supervisor-protocol.ts:209`) over the ten receipt fields yields `5c38aa838496902a68ccb41354bbb969a3fdb9f621d6a00ead25afb68e70bdd7`, equal to the receipt's `externalTrustBoundSha256` and to the `EXTERNAL_TRUST_BOUND_SHA256='…'` literal at line 33 of the frozen command.

**The archive is the candidate tree, two independent ways.** (a) `git archive --format=tar c79e53ce…` regenerated into scratch is **byte-identical** — `shasum -a 256` → `4a2bb42db1749ff73ecf6959a635891222f6be035752e7fdb6eb1452ae88f370`, equal to `archiveSha256`, with 2073 members and `stat -f%z` = `54466560` = `archiveSize`. (b) Object identity: extracting `source.tar` into a fresh scratch directory, `git init`, `git add -A`, `git write-tree` → **`4a3221655109605cbd99ef9b4dce145cb4ee8b49`**, equal to `candidateTreeOid` and to `git rev-parse HEAD^{tree}`. The archive's contents hash to the candidate's tree object, mode bits included.

**The frozen command rebuilds byte-identically from HEAD fragments.** Importing `buildFrozenRunCommand` from HEAD's `stage-live-campaign.ts` (which reads `frozen-run-wrapper.fragment.sh` and `frozen-run-section-9.7.fragment.sh` from its own directory) with the staged receipt and the staged path literals, then `cmp` against the staged file → **identical**, and the rebuild's own digest is `0489abbc…`. The file is 692 lines. (Note: the brief says "686 lines"; the correct figure is 692, which is exactly the "twelve more than the last stage" the brief also states — the prior two stages were 680 and the pilot 675. The digest, which is what binds, matches exactly.)

**Admission gates precede the traps.** Lines 512-535: the two leaf digest checks, then `REQUIRED_REMAINING_MS=$(( RUN_TIMEOUT_MS + 5400000 ))` and `test "$(( STAGE_NOT_AFTER_MS - NOW_MS ))" -gt "$REQUIRED_REMAINING_MS"`, then the sole `verify-stage-approval` invocation — and only then `trap 'on_signal 130' INT` / `143 TERM` / `129 HUP` / `on_exit EXIT`. A refusal in the gate block leaves both campaign keys intact.

**Campaign parameters, read in the staged file** (lines 681-691): `CELLS` = the six 9.7 cells in order (`ticker-fanout/rate-25,rate-50,rate-100,chat-fanout/subscribers-250,subscribers-500,subscribers-1000`), `REPS=5`, `PURPOSE=canonical`, `CAMPAIGN_TIMEOUT_MS=14400000`, `EXPECTED_PASS=60`, `EXPECTED_PROMOTABLE=60`, `EXPECTED_FLATS=12`, `EXPECTED_PAIRED_PROMOTIONS=6`, `EXPECTED_SEALED=60`, `EXPECT_CANONICAL_FANOUT_COMPLETE=1`, `RENDER_MODE=promoted`; `RUN_TIMEOUT_MS=16200000` at line 19; `ARMS=ws,wt`, `ARM_KINDS=primary` (lines 543-544). The success verifier is passed `--stage-receipt="$MAC_TRUST/stage-receipt.json"` at line 617, alongside both staged leaves and the bound. Flat and pair counting (`verify-campaign-index.ts:1220-1237`) makes `flats=12` with `pairs=6` mean six distinct `<cell>-ws.json`/`<cell>-wt.json` couples and nothing else, so no cell can be short while another is doubled.

**Both supervisors were rebuilt and the staged binaries equal the receipt.** Mac runtime `/usr/local/libexec/webtransport-bun/comparison/<candidate>/fanout-attested-r1/`: `comparison-supervisor` → `693988ad…` = `macSupervisorSha256`, `bun` → `e0c90ec1…` = `macBunSha256`. Rig `…/ws-wt-stage/<candidate>/fanout-attested-r1/bin/`: `comparison-supervisor` → `870d3687…` = `linuxSupervisorSha256`, `observe-directory-identity` → `4ad6f34b…` = `linuxObserverSha256`; rig `bun` → `9fd36f87…` = `linuxBunSha256`. Both supervisor digests **changed** at this stage (previous stage: `3940724c…` / `d4f8352a…`), so the rebuild demanded by the `secure_fs.rs` change did happen; `serverEntrypointSha256` and `fanoutRoleEntrypointSha256` are unchanged across all four stages, as the brief states. The rig's `linux-stage-observation.json` is internally consistent with the receipt on all ten shared digests.

**Directory identity.** `linuxDirectoryIdentitySha256`'s preimage in `linux-stage-observation.json` (inode 8265884, mode 493 = 0755, uid/gid 1001, 8 links, device 259:4, ext4 magic `ef53`) matches the **rig stage directory** exactly, verified live: `stat -c` on `/home/hermes-admin/ws-wt-stage/<candidate>/fanout-attested-r1` → `inode=8265884 mode=755 uid=1001 gid=1001 links=8 devmajor=259 devminor=4`, `stat -f -c %T` → `ext2/ext3`. (I first compared it against `rigRoleRootPath` and saw a mismatch; that path is a separate tmpfs directory and is not what the field describes. Resolved, no discrepancy.)

**The rig role root still holds the right bytes.** `/tmp/ws-wt-linux-build.bmYbJx/tools/compare` is PRESENT, with `server.ts` → `aeef5d1b…` and `bin/fanout-role.ts` → `d9c3f971…`, both equal to the receipt.

**Keys, ledgers, ports, processes.**
- Mac campaign key `/var/db/webtransport-bun/comparison/keys/<candidate>/fanout-attested-r1.mac.pk8` → **PRESENT** (probed as `_wtcompare`, the owning account, in the same shape the frozen command's `probe_campaign_key_absence` uses).
- Rig campaign key `/var/lib/webtransport-bun/comparison/keys/<candidate>/fanout-attested-r1.rig.pk8` → **PRESENT** (same probe over ssh).
- Lease `rig-signing-key-lease.armed.json`: `"state":"armed"`, `notAfterMs 1789011457298`, `rigPublicKeySha256 8028b0e2…`, owner `_wtcompare` — armed and consistent with the receipt.
- Replay ledgers empty: Mac `.trust-staging/<candidate>/fanout-attested-r1/replay` → 0 files; rig `…/fanout-attested-r1/replay` → 0 files.
- Campaign root `.release-evidence/transport-comparison/<candidate>/fanout-attested-r1` exists and holds **0 files** — no execution records.
- Rig port 4433 free (`ss -lunp | grep -w 4433` → no match). Mac port 4433 free (`lsof -nP -iUDP:4433 -iTCP:4433` → none).
- No leftover run #1 processes on either host. On the Mac, `ps -axo pid,user,etime,command | grep -E "comparison-supervisor|fanout-role|compare-controller"` matches only my own search process; the earlier `pgrep` hits were self-matches (the PIDs no longer existed when `ps` ran). On the rig, the only non-system `bun` processes are two idle echo servers — see §5.2.
- Rig disk: `/` 16% used, `/tmp` (tmpfs) 68% used with 2.0 G free; rig load average `0.08 0.04 0.06`.

## 3. Gates and carry-over

**Gates, all four reproduced at this candidate.**

| gate | command | result |
|---|---|---|
| TS suite | `bun test tools/compare` | **1967 pass, 0 fail**, 38686 expect, 67 files, 317 s |
| Rust suite | `cargo test -p native` | **744 passed, 0 failed** |
| Types | `npx tsc --noEmit` | exit **0** |
| Official I/O | `bun tools/compare/check-official-io.ts` | `status=PASS`, **`failure-count=0`** |
| Local acceptance | `bun test tools/compare/fanout-production-e2e.test.ts` | **19 pass, 0 fail**, 393 expect, 196.68 s, exit 0; no supervisor, controller or role process survived it on the Mac |

**Carry-over from the three earlier B6 reviews, re-checked here.**

1. *Third round, Blocker 1 (rig session bound).* Fixed and re-proved by execution — §1.1. The Critic's §1.5 offered two remedies for the conformance test; the second was taken (release proven rather than the test comparing both bounds). `cohort-cells.conformance.test.ts:735-783` still compares each frozen schedule against `MAX_ACCEPTED_EXECUTIONS_PER_CAMPAIGN` (84) only, and its title "the rig accepts every execution of every frozen schedule" is now **true**, because `MAX_SESSIONS_PER_CAMPAIGN` is no longer a campaign-long bound: the Rust tests assert `session_count() == 0` after each of 84 consecutive PASS arms. The residual is that a regression deleting the release would be caught by `rig_cohort_runtime`, not by this conformance test — see §5.3.
2. *Third round, Blocker 2 (6/6 comparable unenforced).* Fixed and re-proved on real bytes at both the verifier and the wrapper — §1.2.
3. *Third round, row 6a (the six-cell completion positive branch).* Still reachable only by fixture — §5.1, where I argue it is not blocker-grade rather than carrying the prior rounds' conclusion.
4. *Third round, row 5 (`promoteCampaignFlats` returns `ok` regardless of promoted count).* Unchanged and correct: the wrapper's `EXPECTED_FLATS=12` / `EXPECTED_PAIRED_PROMOTIONS=6`, and now also the per-cell binding, are what refuse a short promotion.
5. *First round (pilot) findings.* The local acceptance number (19/0/393) is unchanged, and no process survives it.

**Physics unchanged since the D4 preflight — checked, not assumed.** `git diff --stat 1b9e8092 c79e53ce` touches 27 files; no relay, transport, server, worker or client traffic-path source appears. I did not rely on the unchanged entrypoint digests for this, because the staged `roles/*.ts` are plain file copies (byte-identical to `tools/compare/server.ts` and `tools/compare/bin/fanout-role.ts`), not bundles, so their digests do not cover imports. Instead I computed the transitive relative-import closure of both role entrypoints (18 files: the two entrypoints, `adapters/{transport,ws,wt}.ts`, `scenarios/fanout-{delivery,relay,wire}.ts`, `bounded-queue`, `canonical`, `child-pipe-protocol`, `cohort-protocol`, `cross-supervisor-protocol`, `scenario-registry`, `secure-fs`, `server-snapshot-protocol`, `types`, `wire`) and intersected it with the changed set. Exactly one file intersects: `tools/compare/cross-supervisor-protocol.ts`, and its diff is **purely additive** — a new `EXTERNAL_TRUST_BOUND_SCHEMA` constant, the `ExternalTrustBoundPreimageV1` interface, the field-order array, and the pure `externalTrustBoundSha256()` function. No existing export or code path is modified, and nothing added runs on the traffic path. The eight D4 receipts under `preflight/1b9e8092…/` therefore still describe this candidate's physics.

**Wall clock and validity margin at a launch today.** `notAfterMs` 1789011457298 = 2026-09-10T03:37:37Z. The admission gate requires `RUN_TIMEOUT_MS + 5400000` = 16,200,000 + 5,400,000 = **21,600,000 ms** (6 h) of remaining validity, exactly as the brief states. At the time of this review (2026-09-09T08:43Z) 68,062,159 ms remain (18.91 h), so the gate passes with **12.91 h of slack**; the latest admissible launch is **2026-09-09T21:37:37Z**. Run #1 sealed 72 executions in about 28 minutes, and the campaign timeout is 4 h, so the 35-minute expectation sits far inside both the run timeout and the validity window.

## 4. What the stop gate rests on, and where each clause was executed

| stop-gate clause | enforced by | executed on |
|---|---|---|
| 60 fresh measured primary PASS seals | `--expected-pass-count=60`, `--expected-sealed-count=60`, `EXPECTED_PASS` sealed-file count | real bytes at 50 (`pass=50 sealed=50`, and the sealed-file count formula) |
| all promotable | `--expected-promotable-count=60`; `evaluateCellPromotionGate` per cell | real bytes: 50/50 promotable; the sixth cell's real partial set correctly refused `PROMOTION_ARM_PAIR_INCOMPLETE` |
| 12 flats, 6 paired promotions | `--expected-flat-count`, `--expected-pair-count`, filename pairing | real bytes at 10/5 |
| each flat is the seal the gate chose | `PROMOTED_FLAT_MISMATCH` | real bytes: clean passes, both mutations refuse rc 3 |
| every seal totals the cell cardinalities | `checkExpectedTotals` inside the verifier | real bytes for the five cells present |
| canonical fanout complete | `--expect-canonical-fanout-complete` | **fixture only** for the positive branch — §5.1; the negative branch executed on real bytes |
| report prints topology, totals, three attested figures, claim boundary per arm | renderer | real bytes, all ten arms |
| 6/6 cells COMPATIBLE | render rc 4 + wrapper's derived COMPATIBLE-row count | real bytes: 5/5 clean rc 0; 3/5 and 4/5 both rc 4 with the count short |

## 5. Residuals (stated, none blocker-grade)

**5.1 The six-cell canonical-completion positive branch is reachable only by fixture — and cannot by itself produce a false PASS.** `evaluateCanonicalFanoutCompletion` (`output-policy.ts:1251-1312`) runs only when the index schedules all six cells, and no complete six-cell canonical set exists yet — run #2 is what would produce the first one, so this is a bootstrap, not an oversight. My brief says a stop-gate path reachable only by stub is a blocker, so I examined whether this one is, rather than inheriting the prior rounds' conclusion. It is not, for a reason I can state structurally: the function is a pure conjunction of (a) `evaluateCellPromotionGate` applied per cell — the **same** gate the promotion path uses, which I executed on real bytes in both directions (promotable for five real cells, refused for the real incomplete sixth) — and (b) two integer equalities, `promoted.length === 6` and `measuredPassSeals === 60`. It introduces no clause of its own. Both of its integers are independently asserted by frozen expectations I did execute on real bytes at five-cell scale (`--expected-promotable-count`, `--expected-pair-count`, `--expected-flat-count`, `--expected-sealed-count`), and the substantive stop-gate clauses — the per-flat binding, the render's 6/6, the wrapper's derived counts — are separate gates I reproduced on real bytes. A wrong answer from this branch in the permissive direction is therefore caught elsewhere; in the refusing direction it costs a stage, never a false PASS. I also executed its refusing path here (five-cell root plus the flag → `TRUST_PROTOCOL: canonical fanout completion requires a canonical index scheduling all 6 fanout cells`, rc 3) and confirmed `c79e53ce` repaired a genuine defect in the six-cell fixture itself (it had been writing rep 3 as every flat while its p50s ranked rep 4 as median; the new binding refused it), which is evidence the fixture is now consistent with the gate rather than with itself.

**5.2 Two idle bun processes on the rig, constant across both runs.** PIDs 3733490 (`rig-min-wt-echo-server.js`, UDP 10.99.0.2:4447) and 3733749 (`rig-min-echo-server.js`, TCP 10.99.0.2:4446), started **2026-08-29 12:47**, i.e. eleven days before run #1. They are not run #1 leftovers, hold neither port 4433 nor any campaign resource, and were present throughout run #1's 53 real seals, so they are a constant of the measurement environment rather than a new perturbation. Rig load is 0.08. Non-blocking; worth reaping at the next convenient window, but changing rig state now would alter the environment run #1 was measured in.

**5.3 The rig role root lives on tmpfs.** `rigRoleRootPath` is `/tmp/ws-wt-linux-build.bmYbJx/tools/compare` on a tmpfs at 68% capacity. It is present now with the correct `server.ts` and `fanout-role.ts` digests, but a rig reboot or tmpfs pressure between now and launch would destroy it, and the failure would land **after** admission, destroying both campaign keys. This argues for launching promptly within the 12.9 h window and for re-probing the role root immediately before launch.

**5.4 The wrapper depends on `rg` from the operator's ambient PATH.** The frozen command sets no `PATH` and the two new report counts call `rg`. It resolves on this machine (`/opt/homebrew/bin/rg`, ripgrep 15.1.0, confirmed present on a login shell's PATH via `zsh -lc 'command -v rg'`). If it were missing the counts would fail closed (`COUNT_RC` set → `TERMINAL_KIND=FAIL`), never falsely pass — but it would burn the campaign, so the operator should confirm `command -v rg` in the launching shell.

**5.5 Mac load is elevated.** Load average `5.09 3.89 4.44` at review time, with `WindowServer` at 41%, ChatGPT/Codex helper processes at 20.9% and 14.2%, and Activity Monitor open. This is the known local-load pattern; the Mac drives the client side of every arm. Not a correctness gate and run #1 measured cleanly under similar conditions, but quiescing the Mac before launch is the cheap precaution.

## 6. Launch preconditions still outstanding

`exact-stage-approval.json` does **not** yet exist under the staged directory (`ls` → No such file or directory), and the admission block at line 526 invokes `verify-stage-approval` against it. The order must be: this review and the Critic pass → write `exact-stage-approval.json` → launch. Launching before that file exists fires the EXIT trap and destroys both campaign keys, which is exactly the 2026-09-08 loss the frozen comment at lines 514-518 records.

---

Verification summary: `git rev-parse HEAD` → `c79e53ce98d540e37e8bceab2880dc6313c9d762`; `git status --porcelain -uno | wc -l` → `0`. `bun test tools/compare` 1967/0 · `cargo test -p native` 744/0 · `npx tsc --noEmit` 0 · `check-official-io` failure-count 0 · `bun test tools/compare/fanout-production-e2e.test.ts` 19/0.
