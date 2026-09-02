# Cohort runtime integration design — round three

**Date:** 2026-09-02
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` — **plan bytes unchanged.**
**Deviation of record:** `docs/superpowers/plans/deviations/2026-09-02-b3-production-cohort-runtime.md` (§7.5 = this document's input list)
**Critic review answered:** `docs/superpowers/plans/deviations/2026-09-02-cohort-runtime-integration-design-critic-review.md`
**Baseline:** worktree `ws-scenario-comparison`, HEAD `172d6f91`.

**Binding maintainer ruling this design implements:** the **rig supervisor**
(`crates/native/src/bin/comparison-supervisor.rs` + `secure_fs::cohort::rig`) is the
**sole Linux signer**. The server child (`tools/compare/server.ts --mode=fanout-cohort`
running the `scenarios/fanout-relay.ts` cohort relay) is an **observer**: it never holds
a signing key, it produces observation bytes, and it hands them to the rig over the §3.4
FD 3/4 child pipe for the rig to receipt-sign. `privatePkcs8Der` leaves
`FanoutLinuxAuthorityConfig`.

**Binding coordinator ruling on review:** the Mac signer is made **symmetric** — a process
holding a key on a descriptor, not a class holding a key in the controller.

---

## Revision 7 — changes

Revision 6 closed all five items with no blocking finding and no new crossing object, and the
review retired the floor framing. Revision 7 closes one ordering defect and three
clarifications, and **splits S8**, which the review flagged as the busiest slice.

| Item | Finding | What moved |
|---|---|---|
| **NEW-14** MUST-FIX | stage 1 named `closeOwnedFds()`, which also does `supervisorToController?.destroy()` and closes `controlParentFds` (`remote-supervisor.ts:1115-1128`) — tearing down the supervisor's **output** channel at the same instant as its input, so its `terminate`/`write_frame` paths (`comparison-supervisor.rs:607-660`) hit a broken pipe and the controller discards its last words | §2.9(4d) stage 1 is now a **half-close**: `controllerToSupervisor.end()` **only**. The controller keeps reading until EOF; `closeOwnedFds()` moves to **after** stage 2's reap. The stage-1 test asserts the final frame was **received and content-checked**, not merely that the process ended — otherwise it passes on the broken-pipe path. S8b function boundaries named. |
| **NEW-11 residue** | §2.9(4e) gave the probe as a command, not as an exit-status **reading**; the Darwin-zombie rationale that makes it correct lives in a comment on a helper this path no longer uses | The reading is stated — **non-zero, `EPERM` included, means the group is gone; zero means alive** — with the `:5729-5740` rationale carried into (4e) and the premise that transfers spelled out. Pinned by a named test. |
| **NEW-15** NOTE | the SIGPIPE dismissal had the direction backwards: SIGPIPE is a **write**-side signal, so the `Ok(None)` read-side break is disposition-independent | Row rewritten. `SIG_IGN` protects the supervisor's **outbound** writes — which is exactly NEW-14's hazard — and Rust installs it in `lang_start` before user code, so sudo resetting handlers is harmless. Same conclusion, correct mechanism. |
| **NEW-16** NOTE | `the_mac_supervisor_is_its_own_process_group_leader` is false in sudo's fork mode, where `handle.pid` is sudo's and the supervisor is a group *member* | Renamed `the_mac_supervisor_group_is_disjoint_from_the_controllers`, with a line recording why `-<pgid>` covers the supervisor in **both** sudo modes. |
| **S8 split** | S8 had absorbed something from every revision since 3 — 2,550-3,300 src, twelve named tests | Split along a clean seam into **S8a** (cohort channels) and **S8b** (supervisor process lifecycle), disjoint by named symbol, in different waves. |

Everything else in Revision 6 stands unchanged.

---

## Revision 6 — changes

Revision 5 closed four of five and was rejected on five items, three of them inside
§2.9(4d)'s stage 3. The finding that matters most is that stage 3 named a process group the
design never established — and the controller's only nameable group is its own, so the
"forced stop" would have killed the campaign that issued it.

| Item | Finding | What moved |
|---|---|---|
| **NEW-11** BLOCKING | stage 3's `<pgid>` is undefined; `nodeSpawn` (`remote-supervisor.ts:843-850`) passes only `stdio`/`env`, **no `detached`**, so the sudo'd supervisor sits in the **controller's** process group and `kill -- -<pgid>` would signal the controller, the rig supervisor and every role child | §2.9(4d) stage 3 rewritten. `detached: true`, `pgid` carried on `SupervisorHandle`, a spawn-time assertion that it **differs from the controller's**. ↺ **The precedent is stronger than the review's**: `createMacFanoutRoleChildHost` in the *same file* already does exactly this (`:6152` comment, `:6178`), and `createMacFanoutProcessControl` (`:5757`) already implements the `killPgid`/`waitPgid` pair. ⚠ **New finding: `processGroupAlive` (`:5742`) cannot be reused across the boundary as-is** — see §2.9(4e). |
| **NEW-12** | preflight check 12 (`sudo … /bin/kill -0 $$`) targets a **controller-owned** pid from `_wtcompare`, so `kill(2)` returns `EPERM` **on a correctly configured host** | Replaced with a self-targeting form, and §2.9(4b) gains the governing rule the check violated: **every preflight check must pass on a correctly configured host and fail only for the defect it names.** Semantics settled by execution in S0. |
| **NEW-13** | four objects outside the twelve-object table: control-channel fds 0/1/2, umask, PATH, cwd | Table is now **sixteen**, with the **five dismissed objects named and reasoned** so it is closed over its stated domain. Residual 2c reworded — the three standard streams **do** cross, by construction, and stage 1 depends on it. |
| **NEW-7 residue** | `proc.kill("SIGKILL")` (`:1145`) survives into the new design and would falsify `reaped` by orphaning the supervisor in sudo's fork mode | Stated explicitly as **deleted, not retained as a fourth stage**. |
| **NEW-10 residue** | §2.10 said "five for S3 in total" against the S3 row's six | Fixed. |

Everything else in Revision 5 stands unchanged.

---

## Revision 5 — changes

Revision 4 closed six of seven and was rejected on five items. The Critic's diagnosis is
exact and I accept it in full: §2.9(4a) claimed to enumerate "every object that crosses the
uid boundary" and enumerated every *filesystem* object. **The enumeration's domain was
wrong, not its method.** Two non-filesystem objects cross — the **environment** and
**process control** — and both break the spawn at run time. The table is now twelve objects
and its domain is stated as "everything the child needs and everything that acts on it",
not "every file".

| Item | Finding | What moved |
|---|---|---|
| **NEW-6** BLOCKING | `sudo`'s `env_reset` strips `COMPARISON_SUPERVISOR_BUN_PATH`, which the binary requires (`comparison-supervisor.rs:1877`, error `:1913`) and the controller sets at `remote-supervisor.ts:849` | New **§2.9(4c)**. The variable is carried as an `export NAME=<shellQuote(value)>` line **inside the argv script**, consistent with form (iv). `sudo -E` / `env_keep` **rejected** as widening. ↺ **The crossing set is exactly one variable** — I enumerated every `std::env` read in the binary and every `COMPARISON_*` in the controller; the rest are controller-side. Row 10 of the table. |
| **NEW-7** BLOCKING | the controller cannot `kill(2)` a `_wtcompare` process, and `child.pid` is `sudo`'s; `stopSupervisor` (`remote-supervisor.ts:1111-1152`) returns `ok:true` unconditionally so it cannot tell signalled from reaped | New **§2.9(4d)**: a three-stage shutdown — **control-channel EOF** as the graceful stop (the Rust loop breaks on EOF at `comparison-supervisor.rs:604-606`), a bounded wait on `sudo`'s exit as the **reap proof**, and `sudo -n -u _wtcompare /bin/kill` as forced stop, which the **existing** sudoers grant already permits. Row 11. Tests in S8 and S9 prove *reaped*, not signalled. |
| **NEW-8** MUST-FIX | residual 6 breaks **this design's own e2e** at execution 2: `spawnRigSupervisor` has one call site (`bin/compare-controller.ts:2471`) and the acceptance is read once at startup (`comparison-supervisor.rs:1465`, `:1473`) | Promoted out of the residuals into **§2.13**, owned by **S5-RIG**. ↺ Unlike the Mac, the symmetric fix **needs a registry edit**: `rig-accept-cohort-request/v1`'s frozen key set (plan 775-781, `cross-supervisor-protocol.ts:2046-2051`) has no acceptance field. §3.4's assertion-1 row updated. |
| **NEW-9** MUST-FIX | S9's line list omits `:1556` (the `stagingRoot` mkdir — row 4's own object) and miscites `:1558` | List corrected to `:702-704`, `:1555`, **`:1556`**, **`:1560`**, `:1698-1699`, and §2.9(4b) now states the preflight is the **backstop for exactly this class of omission**. |
| **NEW-10** NOTE | residual 7 said `fanout_supervisor.rs` was unowned while the S5-MAC-RS row owns it — a gate-item-9 violation inside the document | Residual 7 reduced to a note; residual 4's stale "12.5-16k" total corrected. |

Everything else in Revision 4 stands unchanged.

---

## Revision 4 — changes

Revision 3 closed six of seven items and was rejected on one blocking defect plus six more.
The Critic named the pattern and it is correct: **each revision moved the named object across
the uid boundary and left an unnamed one behind it.** Revision 4 stops doing that by
enumerating *every* object that crosses, once, in §2.9(4a) — and the enumeration found more
than the review did.

| Item | Finding | What moved |
|---|---|---|
| **NEW-1** BLOCKING | `sudo` cannot read the wrapper script: `remote-supervisor.ts:827-832` writes it `0700` into `tmpdir()`, which on macOS is `/var/folders/<hash>/T`, `drwx------` and per-user by construction | §2.9(4) **rewritten**. The script stops being a filesystem object at all: it travels as `bash -c <text>` **argv**. §2.9(4a) is a new table walking every object that crosses. ↺ **The problem is bigger than the review found**: `bin/stage-live-campaign.ts:702-704` creates the staged trust root *and every subdirectory* at `0700`, and `:1555` creates campaign-root at `0700` — so fds **3, 4, 5 and 6** are all unreadable by `_wtcompare`, not just campaign-root. |
| **NEW-3** | the Mac supervisor is spawned once per campaign (`bin/compare-controller.ts:2433`, handle at `:2457`) but fds 8/10 were per-`<runId>`, and §3.2 runs four executions | **Decided: per-campaign**, confirmed from plan text. Per-execution inputs move onto the request frame — `mac-open-cohort-request/v1` already carries `workloadRolePlanInputBase64` + digest + size and `executionSha256` (`cross-supervisor-protocol.ts:1942-1950`, plan 595-604). Descriptors drop **four → two**, both campaign-scoped. §3.2's budget, S9's scope and the restart test are updated. |
| **NEW-2** | F8's premise was false: `RigMeasureStartAckV1` already exists at `server-observation-artifact.ts:87`, built `:1192`, read `:599`, and `scenarios/fanout-relay.ts:3045` already names that module the owner | The second definition is **deleted from the design**. `server-observation-artifact.ts` becomes the TS owner of `rig-measure-start-ack/v1` and is given to S5-RIG; one vector; S8's two schema checks consume the owner's type. |
| **NEW-2b** | `PhaseARigFieldSpec` (`:2480-2490`) has exactly eleven kinds; `intOrNull`, `stringOrNull` and a **boolean** literal do not exist — `literal` compares against `spec.value: string` | S3 **widens** the shared union with three kinds and three arms in `phaseARigFieldOk` (`:2498`), plus a regression assertion over the existing eleven. S3 re-scoped and re-estimated again. |
| **NEW-4** | the two columns narrowed plan 1289/1291's open unions inside a constant whose comment (`cohort-protocol.ts:5245`) says "the exact §4.5 table"; plan §4.5 (2144-2150) has seven columns and neither field | **Separate table** `COHORT_CELL_GRANT_PARAMETERS`, same owner/slice/test. Chosen over recording a registry edit, with the reason stated. |
| **2b** | preflight checked only `test -w` on the campaign root | Extended in §2.9(4b) to traverse+read on every crossing object, and `bin/stage-live-campaign.ts` **is now owned** (S9) with the exact mode change. |
| **NEW-5** | `bin/` prefix missing on four `stage-live-campaign.ts` citations; mode-444 is plan 2684/2886, not 2853 | Fixed throughout. |
| **ownership** | `server-observation-artifact.ts` and `bin/stage-live-campaign.ts` were owned by nobody | Both assigned in §4 (S5-RIG and S9). Every file any slice touches now has exactly one owner. |

Everything else in Revision 3 stands unchanged.

---

## Revision 3 — changes

Revision 2 closed 12 of 14 findings and was rejected on seven open items. All seven are
closed below. Every new claim was verified at HEAD before being acted on; two of the
review's own numbers are corrected in passing (marked ↺).

| Item | Finding | What moved |
|---|---|---|
| **N1** BLOCKING | the Mac signing-key descriptor is opened by a process plan §3.1 forbids to read it: the key is at `/var/db/webtransport-bun/comparison/keys/<cand>/<camp>.mac.pk8` mode 0400 owner `_wtcompare` (plan 238), `staging-root` holds public halves only, and `spawnMacSupervisor` runs `nodeSpawn("bash", …)` (`remote-supervisor.ts:843`) with no uid change | §2.9(4) **rewritten**. The Mac supervisor is spawned under `/usr/bin/sudo -n -u _wtcompare`, the mechanism plan lines 2769/2915 already use for keygen and key destruction; the key path comes from `COMPARISON_MAC_SIGNING_KEY`, which `bin/stage-live-campaign.ts:1025` already writes into the frozen run command **and which has no consumer today**. Campaign-root group access, the preflight, and the e2e's two tiers are specified. |
| **N2** MUST-FIX | S3 got two Phase-A Mac key sets with no table and no nullable field kind (`CohortRemoteFieldKind`, `:1899-1905`, has none) | §2.10 names `PHASE_A_MAC_FIELDS` + `PhaseAMacRemoteSchema` + `parsePhaseAMacRemotePayload`, reusing the existing `PhaseARigFieldSpec` union (`:2480-2490`) which already carries `base64OrNull`. S3 re-estimated. ↺ the frame has **seven** `Base64\|null` fields, not six; nine across the two frames. |
| **F5** OPEN | S2 (wave 1) left the suite red until S4 (wave 2), making S2's own gate 2 unsatisfiable | S2 gains a **named single-line carve-out**: `fanout-supervisor-integration.test.ts:210`. Verified that is the only shard-local fixture in that 5,600-line file (`:5541` already uses the grant total). |
| **F8** OPEN | §2.11 split one codec across waves 1 and 2, so its hex vector could not exist when S2 reported done | **All of §2.11 goes to S5-RIG.** Verified `rig-measure-start-ack/v1` has **no TS codec anywhere** — so the TS half is a new `parseRigMeasureStartAck`, a named carve-out of `cohort-protocol.ts` that collides with nothing S2 edits. |
| **N3** MUST-FIX | `measuredDurationMs` / `messageBytes` are open unions (`cohort-protocol.ts:681`, `:683`), not frozen per cell; the §9.6 pilot cell is ticker-10k (plan 3511), not chat 1k | §3.2 presents both as **chosen grant parameters** with **S2** as the owner (two new columns on `COHORT_CELL_CARDINALITIES`, `:5235-5243`). §3.3/§3.4 state plainly that chat-1k proves the machinery and §9.6's ticker-10k pilot is the plan's proof, on the rig. |
| **Finding-1 residue** | `mac-present-rig-observation-request/v1` (plan 697-715) carries **five** of the seven rig records | §2.9(2)'s last row corrected; the other two come from retained `MacCohortSession` state, with the restart-refuses invariant and its two codes named. |
| **N4 / N5** | inverted timeout claim; two overcounts | `PROCESS_TEST_TIMEOUT_MS = 900_000` (`fanout-production-e2e.test.ts:163`) is already per-test; the 240,000 figure is dropped. `COHORT_REMOTE_PAYLOAD_SCHEMAS` has **22** members (verified by count). The `:4255` citation is corrected — it is a doc comment above `exportCohortEvidence`. |

Everything else in Revision 2 stands unchanged.

---

## Revision 2 — changes

Revision 1 was rejected on four blocking findings, three of which were the same failure
mode as rounds one and two: a blocker resolved by pointing at machinery that does not
exist. All fourteen review findings are answered below; nine changed the design, five are
adopted as written. Nothing is refuted — every finding was independently re-verified at
HEAD before being acted on.

| # | Review finding | What moved |
|---|---|---|
| 1 | Mac signer is `MacFanoutSupervisor`, a TS class holding `privatePkcs8Der` (`remote-supervisor.ts:2813-2822`, `:2918`); no Rust `mac-*` arm; no TS sender | **Option (b) taken per coordinator ruling.** New §2.9 builds the Mac cohort runtime as a Rust process with four all-or-none descriptors, plus a TS sender/receiver and spawn-path plumbing. §1.1, §1.2, §2.2, §2.5 rewritten against it. New slices **S5-MAC-RS** and **S8**. |
| 2 | `rig-teardown-server-request/v1` / `rig-server-stopped-ack/v1` have no TS codec and no owning slice | New §2.10. `cross-supervisor-protocol.ts` gets an explicit owner (**S3**). "No §3.3 registry edit is required" **withdrawn**. |
| 3 | `evidence.ts:152-160` admits **six** cells, not three; `chat 1k` is a frozen 33× reduction | §3.2 rewritten. My "there is no legal reduced rung" was **false** — I read lines 152-157 and stopped one line short of the chat entries. |
| 4 | Measured: 195,387 deliveries/s is a strict upper bound on this host vs the rung's 1,000,000/s | **S0 deleted.** FULL/SHORT branch deleted. Rung is `chat-fanout/subscribers-1000`. A session-count probe replaces the delivery probe. |
| 5 | Shard fix breaks three unowned fixtures; positional `workerIndex`/`residue` and 8-entry checks missing; Rust test file unowned | §2.3 extended; **S2** now owns five files. |
| 6 | F3 is **12** of 15 with neither half, not ten | F3 corrected and all 12 enumerated with slice assignment. **S1** re-scoped. |
| 7 | `createFanoutLinuxAuthority` does not exist — it is `new FanoutLinuxAuthority` (`fanout-relay.ts:2422`, constructed at `:2443`); S4's deletion breaks a 5,600-line unowned test file | §2.1 corrected; **S4** owns `fanout-supervisor-integration.test.ts`. My "every file:line was read at HEAD" claim did not cover this identifier; it was carried from memory. |
| 8 | Open question 2 is mostly answerable from plan 876-883 | Settled in §2.11; residue narrowed to three fields and decided. |
| 9 | Per-assertion reachability not stated | New §3.4 walks each of the four mandate assertions to the slice that makes it true. |
| 10 | F1 overstatement: nothing sends `rig-teardown-server-request/v1` | Wording corrected. |
| 11 | F2/§2.8 sound; keep the gate, cite the code comment | Adopted; comment cited. |
| 12 | §2.6 correct in both halves | Unchanged. |
| 13 | New `.test.ts` files need no allowlist line | Gate item 7 corrected. |
| 14 | Take question 3's own fix: carry the nested records as base64 | Adopted. §1.3 rewritten; folded into S3's registry edit. |

**LOC calibration.** Rounds one and two produced 10,900 and 6,300 lines against ~3,000-line
estimates (3.6× and 2.1×). Revision 1's estimates were built the same way and are therefore
low by the same factor. Every estimate below is revision 1's bottom-up figure multiplied by
**2.75**, then adjusted for the scope changes above. They are stated as ranges, and the
range is the honest width.

---

## 0. What this document is

A contract, not a proposal. §1 fixes who signs what and which frame carries each hand-off.
§2 resolves each blocker to a named edit at a named line. §3 is the e2e's rung, assertion
list, and per-assertion reachability. §4 is the slicing. §5 is what remains open.

Three defects found while verifying the round-three input list, all still standing after
review:

- **F1.** `rig-stop-and-capture-request` and `rig-teardown-server-request` are **not** in
  the rig's dispatch. `COHORT_REQUEST_KINDS` (`secure_fs.rs:14771-14778`) has exactly six
  kinds and `ack_kind_for` (`:14792-14800`) matches the same six. The controller sends
  `rig-stop-and-capture-request/v1` (`remote-supervisor.ts:5552`) — *that one only*;
  **nothing anywhere sends `rig-teardown-server-request/v1`**, which has no TS codec at all
  (§2.10). Both fall through to `_ => terminate("TRUST_CHILD_FRAME_INVALID")`
  (`comparison-supervisor.rs:699`), so §5's `LINUX_CAPTURE` and `TEARDOWN` are unreachable.
- **F2.** `RigCohortSession::mark_ready` (`secure_fs.rs:16288-16290`) has no production
  caller and its invariant cannot hold on the rig — it delegates to
  `CohortRuntime::mark_ready` (`:14447-14459`), which demands
  `role_children.len() == expectedProcessCount` and
  `admitted_registration_count() == expectedSessionCount`. The rig spawns one child; the
  role children and every registration are Mac-side and wire-side.
  `present_start_barrier` refuses on `self.owner.phase() != Ready` (`:16111`), so the
  barrier is unreachable. §2.8.
- **F3 (corrected).** Of the **15** §3.4 server-child lifecycle schemas in
  `PHASE_A_CHILD_SCHEMAS` (`child-pipe-protocol.ts:295-314`, 18 entries including three
  non-lifecycle records), exactly **one** has both halves; **two** have a parser only;
  **twelve** have neither. Enumerated in §2.12.

---

## 1. Authority model

### 1.1 The four roles

| Role | Holds a private key? | Signs | Never does |
|---|---|---|---|
| **Controller** (`bin/compare-controller.ts`) | **no** | nothing | never mints a record; a courier that verifies digests and correlates sequences |
| **Mac supervisor process** (`comparison-supervisor` on darwin) | **yes** — Mac Ed25519, on `--cohort-mac-signing-key-fd` (§2.9) | the seven `MacReceiptSignatureV1` signed schemas (`cross-supervisor-protocol.ts:811-818`) | never observes traffic; every rig record it binds is verified against the staged **rig public** key first |
| **Rig supervisor process** (`comparison-supervisor` on linux) | **yes** — rig Ed25519, on `--cohort-signing-key-fd` | the seven `RigReceiptSignatureV1` signed schemas (`:827-834`) | never observes traffic; every number it receipts came off the child pipe |
| **Server child** (`server.ts --mode=fanout-cohort` + `scenarios/fanout-relay.ts`) | **no** | nothing | never holds `privatePkcs8Der`; never mints a `rig-*` record |

`MacFanoutSupervisor` (`remote-supervisor.ts:2714-3910`, 1,197 lines) **stays**, and keeps
everything that is not signing: topology, the global ordinal permit scheduler, child
lifecycle and replacement, ramp, partial acceptance, byte retention. What it loses is
`macKeys` (`:2678`) and `macSign` (`:2813-2822`). Where it called `this.macSign(...)` it
now sends a `mac-*-request/v1` and receives signed bytes back. It becomes a **client**.

Plan line 987 ("Role children *additionally* receive no controller FD and no supervisor
signing-key FD") is read as a statement about *role* children, leaving the server child's
entitlement open. The ruling closes it: the server child gets no signing-key FD either. Its
FD set is exactly FD 3 (read) and FD 4 (write); a fifth descriptor is `UNEXPECTED_FD`,
which the entrypoint already refuses (`fanout-production-e2e.test.ts:374`, asserted `:388`).

### 1.2 §5 transitions: who acts, which frame carries it

`R→C` = rig to server child on FD 3. `C→R` = child to rig on FD 4. **NEW** marks something
this design adds. **NEW-RS** marks a new Rust dispatch arm on the Mac binary (§2.9).

| §5 state | Mac supervisor **process** | Controller frames | Rig supervisor | Server child |
|---|---|---|---|---|
| `COHORT_GRANTED` | **NEW-RS** mints 32-random-byte tokens, `token-commitment-leaf-manifest/v1`, signs `cohort-grant/v1` | `mac-open-cohort-request/v1` → `mac-cohort-opened-ack/v1`; `rig-accept-cohort-request/v1` → `rig-cohort-accepted-ack/v1`; `mac-present-rig-cohort-acceptance-request/v1` → `mac-rig-cohort-acceptance-ack/v1` (**NEW-RS** verifies the rig acceptance against the staged rig public key) | `accept_cohort` (`secure_fs.rs:15564`) signs `rig-cohort-acceptance/v1` | not spawned |
| `SERVER_READY` | — | `rig-spawn-server-request/v1` → `rig-server-ready-ack/v1` | `spawn_server` (`:15646`) forks into its own pgid; **R→C** `server-bind-execution/v1` | verifies grant against staged Mac key; **NEW** binds via `serveFanoutCohortRelay` (`server.ts:791`) instead of `adapterForTransport(...).startServer` (`:1382`); **C→R** `server-ready/v1` |
| `RAMP_AND_READY` | permit scheduler over role-child pipes (`connect-permit-*`, `role-ready/v1`) — **stays in TS**, no signature involved | none | learns nothing here; §2.8 | validates every `fanout-wire/v1` register against the Merkle root, spends `tokenSha256` once (`fanout-relay.ts:2664`) |
| `IN_REPETITION_WARMUP` | **NEW-RS** signs `cohort-warmup-epoch/v1`; **NEW-RS** signs `role-warmup-completion-manifest/v1` from the ordered entries the TS driver read off the role pipes | `mac-issue-warmup-epoch-request/v1` → ack; `rig-begin-warmup-request/v1` → `rig-warmup-ready-ack/v1`; `mac-export-warmup-completion-manifest-request/v1` → ack; `rig-finish-warmup-request/v1` → `rig-warmup-drained-ack/v1` | `begin_warmup` (15762); `finish_warmup` (15835) signs `rig-warmup-drained-receipt/v1` binding `serverWarmupDrainedSha256` (15886) | `server-warmup-start/v1` → `server-warmup-ready/v1` (works today); **NEW** `server-warmup-drain-and-reset/v1` → `server-warmup-drained/v1` — **hand-off #1** |
| `LINUX_BASELINE` | **NEW-RS** verifies + retains `rig-measure-start-ack/v1` | `rig-measure-start-request/v1` → `rig-measure-started-ack/v1` | `measure_start` (16027) exports the ack minted in `finish_warmup` | **NEW** `server-measure-start/v1` → `server-measure-start-ack/v1` — **hand-off #2** |
| `START_BARRIER` | **NEW-RS** signs `cohort-start-barrier/v1` **only after** the rig cohort acceptance, drained receipt and measure-start ack all verified against the staged rig key | `mac-issue-start-barrier-request/v1` → ack; `rig-present-start-barrier-request/v1` → `rig-barrier-accepted-ack/v1`; `mac-present-rig-barrier-acceptance-request/v1` → ack | `present_start_barrier` (16091) signs `rig-barrier-acceptance/v1` | **NEW** `server-present-start-barrier/v1` → `server-start-barrier-accepted/v1` — **hand-off #3** |
| `MEASURING` / `STOPPING` | Mac stop stamp | none | none | relay accepts, orders, fans out; rejects post-stop ingress |
| `DRAINING` + `LINUX_CAPTURE` | — | **NEW** `rig-stop-and-capture-request/v1` → `rig-capture-complete-ack/v1` (Rust arm missing today) | **NEW** `stop_and_capture` signs `rig-server-snapshot-receipt/v1` and `rig-relay-observation-receipt/v1` | **NEW** `server-stop-and-capture/v1` → `server-capture-ack/v1` — **hand-offs #4/#5** |
| `MAC_JOIN` | **NEW-RS** verifies both rig graphs, signs `mac-measurement-admission/v1` + `cohort-admission-receipt/v1` | `mac-present-rig-observation-request/v1` → `mac-measurement-admission-issued-ack/v1`; `mac-export-cohort-evidence-request/v1` → `mac-cohort-evidence-exported-ack/v1` | — | — |
| `ASSEMBLY` | — | `sealCohortArmRepetition` (`compare-controller.ts:4496`) | — | — |
| `TEARDOWN` | reaps role children | **NEW** `rig-teardown-server-request/v1` → `rig-server-stopped-ack/v1` (**no TS codec today** — §2.10) | **NEW** reaps the server pgid | **NEW** `server-teardown/v1` → `server-stopped/v1` |

**Registry status — revision 1's "no §3.3 registry edit is required" is withdrawn.** The
accurate statement is three-way:

1. **Key sets that exist in the TS registry and need only a sender:**
   `COHORT_REMOTE_PAYLOAD_SCHEMAS` (`cross-supervisor-protocol.ts:1788-1823`) has **22**
   members — 14 mac and 8 rig (revision 2 said fourteen; corrected per review N5, count
   verified) — with caps (`:1850-1870`), key sets in `COHORT_REMOTE_FIELDS` (`:1939-2260`),
   interfaces (`:2121`, `:2154`, `:2189`, `:2223`, …) and `parseCohortRemotePayload`
   (`:2334`).
2. **Key sets frozen in the plan but absent from the TS registry** — implementing them is
   registration, not widening: `rig-teardown-server-request/v1` and
   `rig-server-stopped-ack/v1` (plan 922-935), `mac-present-rig-observation-request/v1`
   (plan 697-715) and `mac-measurement-admission-issued-ack/v1` (plan 716-725). Verified
   absent: `PHASE_A_RIG_REMOTE_SCHEMAS` has six members (`:2456-2464`), `PHASE_A_RIG_FIELDS`
   covers only stop-and-capture and capture-complete (`:2585-2602`), the union has six arms
   (`:2677-2684`), and a repo-wide grep for the two teardown literals returns only the two
   name-list lines 1784-1785.
3. **Genuine registry edits, taken deliberately, and there are two:**
   (a) **§3.4** — `server-capture-ack/v1` carries `snapshotFrameBase64` and
   `linuxRelayObservationBase64` instead of nested objects (§1.3);
   (b) **§3.3** — `rig-accept-cohort-request/v1` gains `rigExecutionAcceptanceBase64` and
   `rigExecutionAcceptanceSignatureBase64`, without which one campaign-scoped rig process can
   serve only one execution (§2.13). Both field names and types are copied verbatim from
   `mac-present-rig-execution-acceptance-request/v1` (plan 566-572).

### 1.3 The observation hand-off — base64, not nesting

Five C→R records are receipt-signed by the rig. The rule is the one round two proved on
`server-warmup-ready/v1`:

> The rig digests the record as it arrived. It never digests a reconstruction it built from
> parsed fields.

| # | Record | §3.4 key set | Rig binds it into | Field |
|---|---|---|---|---|
| 1 | `server-warmup-drained/v1` | plan 1056-1070 | `rig-warmup-drained-receipt/v1` | `serverWarmupDrainedSha256` (implemented, `secure_fs.rs:15886`) |
| 2 | `server-measure-start-ack/v1` | plan 1077-1084 | `rig-measure-start-ack/v1` | `baselineBusyMs` / `baselineAtLinuxNs` verbatim (`:15871`) |
| 3 | `server-start-barrier-accepted/v1` | plan 1092-1100 | `rig-barrier-acceptance/v1` | `serverStartBarrierAcceptedSha256` (implemented) |
| 4 | `server-loop-utilization/v1` | plan 1128-1152 | **NEW** `rig-server-snapshot-receipt/v1` | `snapshotFrameSha256` + `snapshotFrameSize` (plan 439-440) |
| 5 | `linux-relay-observation/v1` | plan 1892-1930 | **NEW** `rig-relay-observation-receipt/v1` | `linuxRelayObservationSha256` (plan 1936) |

**The §3.4 edit (review note 14, adopted).** §3.4 freezes `ServerCaptureAckV1` (plan
1108-1114) with `snapshotFrame: ServerLoopUtilizationFrameV1` and
`linuxRelayObservation: LinuxRelayObservationV1 | null` as **nested objects**. That forces
the rig to re-canonicalize before digesting, which is a silent-divergence class that hex
vectors make loud but not impossible: any future encoder change on either side breaks the
receipt between vector re-pins. Revision 1 identified this and declined the fix because it
needed a registry edit. Finding 2 already forces one, so this design takes the second:

```ts
interface ServerCaptureAckV1 {
  schema: "server-capture-ack/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  snapshotFrameBase64: Base64;              // was snapshotFrame: ServerLoopUtilizationFrameV1
  linuxRelayObservationBase64: Base64 | null; // was linuxRelayObservation: … | null
}
```

The rig base64-decodes and digests the decoded bytes **without parsing them first**; it
parses afterwards only to check the bindings. The class of defect is deleted, not pinned.
This also matches the shape §3.3 already uses one hop later:
`rig-capture-complete-ack/v1` carries `snapshotFrameBase64` and
`linuxRelayObservationBase64` (`cross-supervisor-protocol.ts:2592-2601`) — so the edit makes
the two adjacent frames agree instead of transcoding between them.

**Sequence rules on FD 3/4** (§3.4, plan 987): independent `sequence` per direction from 0,
≤ 64 KiB per frame, **≤ 32 per direction**.

```
R→C 0 server-bind-execution         C→R 0 server-ready
R→C 1 server-warmup-start           C→R 1 server-warmup-ready
R→C 2 server-warmup-drain-and-reset C→R 2 server-warmup-drained
R→C 3 server-measure-start          C→R 3 server-measure-start-ack
R→C 4 server-present-start-barrier  C→R 4 server-start-barrier-accepted
R→C 5 server-stop-and-capture       C→R 5 server-capture-ack
R→C 6 server-teardown               C→R 6 server-stopped
```

Seven each way, 25 frames of headroom. A skipped, repeated or out-of-state sequence is
`child-pipe-refusal/v1` `SEQUENCE_INVALID` / `STATE_INVALID`, terminal, mapping to
`FAIL/TRUST_PROTOCOL` (plan 2313).

**Cap check.** Base64 grows the payload by 4/3. At `windowCount: 30` the relay observation's
fifteen numeric arrays plus identifiers are ≈ 6 KiB raw ≈ 8 KiB base64; the snapshot frame
≈ 1 KiB raw. `server-capture-ack/v1` ≈ 10 KiB, well inside 64 KiB.

### 1.4 What the server child loses

`scenarios/fanout-relay.ts` mints and signs five rig records today:
`rig-cohort-acceptance/v1` (`:2543`, signed `:2574`), `rig-warmup-drained-receipt/v1`
(`:2997`, `:3030`), `rig-measure-start-ack/v1` (`:3083`, `:3110`),
`rig-barrier-acceptance/v1` (`:3222`, `:3254`), `rig-relay-observation-receipt/v1`
(`:3406`, `:3432`) — all via `this.config.rig.privatePkcs8Der` (`:2282`, used `:2489`).
Under the ruling all five are the second implementation and none is authoritative. They are
**deleted**, and `FanoutLinuxRigIdentity` loses `privatePkcs8Der`. The observer surface it
keeps: `relayForServe` (`:2469`) · `startServer` (`:2590`) · `registerRolePeers` (`:2664`) ·
`runWarmupWire` (`:2864`) · warmup-drained facts · `runMeasuredWindow` (`:3279`) ·
`buildLinuxRelayObservation` (`:1553`) · the `server-loop-utilization/v1` snapshot.

---

## 2. Blockers: the exact change

### 2.1 `server.ts` must serve the cohort relay and stay alive (§7.5 blocker 1)

**Where it goes wrong.** `server.ts:1382`:

```ts
const cohortAdapter = await adapterForTransport(decision.transport);
const listener = await cohortAdapter.startServer({ port: args.port, tls: {...} });
```

A generic transport listener with no relay behind it: no `fanout-wire/v1` register is ever
answered. The process then reaches `io.close?.()` / `process.exit(0)` (`:1428-1435`) —
exactly what `the_child_binds_a_socket_and_then_exits_because_no_relay_serves_the_cohort`
(`fanout-production-e2e.test.ts:423`) proves by execution.

**The change.**

1. `runFanoutCohortServerChild` (`server.ts:1099`) gains a `bindListener` contract
   returning a `FanoutCohortPeer`: the callback builds the authority and calls
   `serveFanoutCohortRelay({ authority, port: args.port, wsTls/wtTls })` (`:791`).
   `serveFanoutCohortRelay` already takes the transport from the *signed grant* rather than
   argv (doc comment `:785-789`); that property must not be lost.
2. The authority is constructed **without a key**. **Corrected per review 7:** there is no
   `createFanoutLinuxAuthority` anywhere in the repo — the class is
   `export class FanoutLinuxAuthority` (`scenarios/fanout-relay.ts:2422`) and the only
   construction form is `new FanoutLinuxAuthority(config)` (as at `:2443` and in
   `fanout-supervisor-integration.test.ts:1451`, `:3470`, `:4736`). `server.ts` names
   neither the class nor `FanoutLinuxAuthorityConfig` today, so S6 adds both imports:

   ```ts
   new FanoutLinuxAuthority({
     transport: decision.transport,
     executionSha256: decision.executionSha256,
     stagedMacPublicRaw32: environment.value.stagedMacPublicRaw32,
     serverIdentity: { serverChildPid, serverChildPgid, serverChildInstanceNonce },
     linuxClockId: environment.value.linuxClockId,
     clock,
     receiptValidityMs: environment.value.receiptValidityMs,
   })   // `rig: FanoutLinuxRigIdentity` is gone from the config — S4 removes it
   ```
3. `import.meta.main`'s fanout branch (`:1352-1435`) stops calling `process.exit(0)` after
   warmup-ready and hands control to a **pipe-driven lifecycle loop** that reads FD 3 until
   `server-teardown/v1`, answering each frame from the relay's own state, then stops the
   peer and exits 0. Deadlines per §3.5; every refusal is `child-pipe-refusal/v1` with the
   §3.4 code, then EOF.
4. `createFanoutCohortControlPipeIo` (`:1223`) is unchanged.

**Fail-closed order preserved:** stage-time environment → control pipe → signed grant →
*then* a listener. The tests at `fanout-production-e2e.test.ts:374` and `:395` stay green
unchanged.

### 2.2 `ProductionCohortArmMaterial` needs a factory (§7.5 blocker 2)

`ProductionCohortArmMaterial` (`compare-controller.ts:5280`) has no factory and no caller;
`createCohortArmRuntimeProvider` (`:4654`) refuses `COHORT_NOT_READY` when
`inputs.lease === undefined` (`:4671-4677`); `realRunBody` passes nothing (`:2721`).

```ts
export function createProductionCohortArmMaterial(args: {
  readonly context: CohortArmRuntimeContext;
  readonly staged: VerifiedStagedTrustBootstrap;   // computed at :2415
  readonly macChannel: MacCohortChannel;           // NEW, §2.9
  readonly rigChannel: CohortRigChannel;           // remote-supervisor.ts:5051…
  readonly phaseA: PhaseAExecutionHandle;
}): ProtocolResult<ProductionCohortArmMaterial>

export function createProductionCohortArmLeaseFactory(...): CohortArmLeaseFactory
```

**(a) Key material — and now the "public keys only" claim is true.** Revision 1 asserted
this while the controller process held `macKeys.privatePkcs8Der`
(`remote-supervisor.ts:2678`, `:2818`). §2.9 moves that key into the Mac binary on a
descriptor, so:

| Input | Staged path | Read how |
|---|---|---|
| staged **Mac public** key | `<stagedDir>/staging-root/mac-supervisor-ed25519.pub` — leaf named by `LiveStageReceiptV1.macSigningPublicKeyLeaf` (`bin/stage-live-campaign.ts:114`), digest pinned at `:115` | through the verified `staged.paths.stagingRootDir` handle from `verifyStagedTrustBootstrap` (`compare-controller.ts:2415`); digest checked against the stage receipt before use |
| staged **rig public** key | `<stagedDir>/staging-root/rig-supervisor-ed25519.pub`, leaf `:116`, digest `:117` | same |
| **Mac private** key | never in the controller, and **not a staging-root leaf** (that directory holds public halves only): `/var/db/webtransport-bun/comparison/keys/<candidate>/<campaignId>.mac.pk8`, mode 0400 owner `_wtcompare` (plan 238), named by the already-frozen `COMPARISON_MAC_SIGNING_KEY` (`bin/stage-live-campaign.ts:1025`), opened on `--cohort-mac-signing-key-fd` by a wrapper that has **already changed uid to `_wtcompare`** — §2.9(4) | n/a |
| **rig private** key | never leaves the rig host; `RigSigningKeyLeaseV1` (`bin/stage-live-campaign.ts:157-170`) | n/a |

**(b) The Mac half.** `createMacProductionCohortMinter` (`remote-supervisor.ts:6436`),
`createMacFanoutRoleChildHost` (`:6156`), `createMacFanoutProcessControl` (`:5759`),
composed by `composeCohortRigBinding` (`compare-controller.ts:5238`), which already delivers
spawn configs once per composition (round two §7.3). `tokenMaterial` is no longer supplied
by TS at all — token minting moves into the binary with the grant (§2.9), and the minter's
`MacCohortTokenMaterialSource` becomes the *bundle writer* for FD 5 from the raw tokens the
binary returns once, in `mac-cohort-opened-ack/v1`'s token-bundle side channel (§2.9 step 1).

**(c) The seal half.** Five Phase-A facts, none defaulted; a missing one refuses.

| `CohortArmLease` field (`:4425`) | Source |
|---|---|
| `supervisorContext` (`:4455`) | the Phase-A measurement grant + Mac execution grant receipt the controller already holds for every arm (`:1946`) |
| `serverSnapshot` (`:4451`) | the `server-loop-utilization/v1` decoded from `rig-capture-complete-ack/v1`.`snapshotFrameBase64`, after `rig-server-snapshot-receipt/v1` verifies over it — **not** re-read from a sidecar |
| `admissionCounters` (`:4453`) | the Mac supervisor's `LoopSummary` for this execution, read on the teardown path — **revision 1 named `mac-execution-stopped-ack/v1` as the sole source; that frame has no TS codec** (`PHASE_A_REMOTE_PAYLOAD_SCHEMAS` name only, no key set). It is the existing in-process counter until the Phase-A Mac channel is built, and §5 records that as the remaining asymmetry. |
| `attestationEvidence` (`:4456`) | `attested.attestation`, already computed and passed for leg arms at `:2984` |
| `recorder` (`:4457`) | `{ attestation, driverRunId: context.runId, clockMethod: "mach_continuous_time" }` |

**Wiring:** `realRunBody` at `:2721` passes
`lease: createProductionCohortArmLeaseFactory({...})`. The `COHORT_NOT_READY` message at
`:4676` is rewritten to name whatever the factory could not obtain.

### 2.3 The §4.1 shard bound: the Rust reading is correct (§7.5 blocker 3)

**The disagreement.** TS: `value.lastSubscriberIndexExclusive !== value.subscriberCount` →
fail (`cohort-protocol.ts:346`). Rust:
`expect_count(entry, "lastSubscriberIndexExclusive", subscriber_count)` where
`subscriber_count` is the **grant's** total (`secure_fs.rs:12556`, parameter `:12533`).

**The decision, from the plan and from the Rust's own arithmetic.**

- **Plan line 1237:** `firstSubscriberIndex: 0;` — a *literal* `0` on every shard. A
  per-shard contiguous slice would need a non-zero first index on shards 1..7.
- **Plan line 1774:** one global ordinal domain, worker `o mod 8`.
- **Decisive (review 5):** Rust sums `subscriberCount` across the eight entries and requires
  `shard_total == subscriber_count` (`secure_fs.rs:12558`, `:12571`). That sum is vacuous
  unless `subscriberCount` is per-shard — which makes `lastSubscriberIndexExclusive` the
  grant total. TS `:346` conflates the two.

**Single-owner fix**, all in **S2**:

1. `parseSubscriberShard(value, grantSubscriberCount)` mirrors Rust's
   `parse_shards(map, subscriber_count)`; `:346` becomes
   `value.lastSubscriberIndexExclusive !== grantSubscriberCount`. `parseCohortGrant` is the
   only caller and holds `subscriberCount`.
2. **Positional checks, missing today (review 5).** Rust binds both fields to the **array
   index**: `expect_count(entry, "workerIndex", index as u64)` and
   `expect_count(entry, "residue", index as u64)` (`secure_fs.rs:12553-12555`). TS checks
   only `value.residue !== value.workerIndex` (`cohort-protocol.ts:341`) and never checks
   position, so a reordered shard array passes TS and fails Rust. `parseCohortGrant` gains
   the positional check.
3. **Eight-entry check.** `secure_fs.rs:12540` requires exactly `SUBSCRIBER_SHARD_MODULUS`
   entries. That is an array-level invariant and belongs in `parseCohortGrant`, not
   `parseSubscriberShard`.
4. `buildFanoutCohortFixture` writes `lastSubscriberIndexExclusive: subscriberCount` (the
   argument), replacing `roleIds.length` (`scenarios/fanout-relay.ts:1992`), and refuses
   `subscriberCount < 8` rather than silently emitting fewer than eight shards
   (`:1979`, `if (roleIds === undefined || roleIds.length === 0) continue`). **Owned by
   S4**, which owns that file; S2 publishes the vector S4 asserts against.

**Fixtures S2 must own** — both readings are live in the suite today and S2's
"suite green" gate is otherwise unsatisfiable:

- `tools/compare/cohort-protocol.test.ts:211` — `lastSubscriberIndexExclusive: SHARD_SUBSCRIBERS`
- `tools/compare/fanout-supervisor-integration.test.ts:210` — same **(shared with S4; see §4 note)**
- `tools/compare/fanout-promotion.test.ts:500` — `lastSubscriberIndexExclusive: SHARDS[worker]!`

**Gate carve-out (review F5).** `fanout-supervisor-integration.test.ts:210` is a shard-local
fixture that S2's rule breaks, and S4 (wave 2) owns that file — so revision 2 left the suite
red between waves and S2's own gate 2 unsatisfiable. **S2 owns exactly line 210 of that
file**, as a named single-line carve-out; S4 owns every other line of it. Verified this is
the only such fixture there: a grep for `lastSubscriberIndexExclusive` across the 5,600-line
file returns `:210` and `:5541`, and `:5541` already uses `base.grant.subscriberCount`.

The grant-total reading is already asserted at
`fanout-supervisor-integration.test.ts:5541` and `crates/native/tests/cohort_protocol.rs:65`
(`100`). **Four** Rust fixtures use `SUBSCRIBER_SHARD_MODULUS` where the grant total happens
to be 8 and so are reading-agnostic: `rig_cohort_runtime.rs:113`, `fanout_supervisor.rs:129`,
and — added per review F5's citation gap — `comparison-supervisor.rs:2885` and `:3473`. The
last two sit in S5-RIG's file; all four must be re-read and corrected if the grant total ever
differs from the modulus.

**Conformance test, named and homed (review 5).** `crates/native/tests/cohort_protocol.rs`
— **owned by S2** — emits `RUST_PINNED_TICKER10K_GRANT_HEX`, the canonical bytes of one
`cohort-grant/v1` at 1 publisher / 8 shards / 100 subscribers. `cohort-protocol.test.ts`
asserts `parseCohortGrant` accepts the identical literal, and that three mutations refuse
on **both** sides: `lastSubscriberIndexExclusive → 13` on one shard; two shards swapped;
seven shards. That is the mutation proof.

### 2.4 Token generation: raw 32 random bytes, commitment-only travel (§7.5 blocker 4)

**Plan line 1221:** "The Mac supervisor mints tokens with 32 random bytes."
`buildFanoutCohortFixture` derives every token as `sha256(cohortId || ":" || roleId)`
(`deterministicToken`, `scenarios/fanout-relay.ts:1879`, called `:1913`, `:1946`).
`cohortId` travels inside the signed grant (plan 1268), so **the grant is a universal token
oracle** — the exact property §4.3's destroyed-secret scheme exists to prevent (plan
1768-1770).

**The change** (S4, the file's owner):

```ts
export function buildFanoutCohortFixture(args: {
  readonly cohortId: string;
  readonly publisherCount: number;
  readonly subscriberCount: number;
  /** 32 raw bytes per role. Defaults to the deterministic fixture token. */
  readonly tokenFor?: (roleId: string) => Uint8Array;
}): FanoutCohortFixture
```

with both call sites becoming
``args.tokenFor?.(roleId) ?? deterministicToken(`${cohortId}:${roleId}`)``.

**Fixture-only or production? Both — that is the point of the parameter.** The builder is
the single implementation of §4.1's leaf ordering, Merkle root, proofs, publisher grants and
shards; a second copy for production is the defect §4.1 exists to prevent. So the **builder**
is production, the **default token source** is fixture-only, and every existing caller keeps
today's bytes. **Under §2.9 the production token source is the Mac binary**, which mints 32
random bytes per role with the grant and returns them once; the TS side receives them, writes
the FD 5 bundles, and destroys them. `tokenFor` is then the seam through which the binary's
tokens reach the builder, not a place TS invents bytes.

**Guard (mandatory):** for a production-minted cohort, assert
`tokenSha256 !== sha256(cohortId + ":" + roleId)` for **every** role. A guard that only
checks "two cohorts differ" passes on the derived scheme.

### 2.5 `MacRoleChildFrameSource` production implementer (§7.5 blocker 5)

`MacRoleChildFrameSource` (`compare-controller.ts:4744`) is the driver's declared inability:
`role-spawn-config/v1`, `role-warmup-start/v1`, `role-measure-start/v1` all carry Mac-signed
material and `MacRoleChildCohortDriver` (`:4800`) deliberately cannot mint them.

**The change.** `createMacSignedRoleChildFrameSource` in **`remote-supervisor.ts`** — not in
the controller — because it is an adapter over the Mac channel that lives there, and because
`compare-controller.ts` must acquire no signing surface.

| Method | Builds | Signed material, and where it comes from |
|---|---|---|
| `spawnConfigFor(plan)` | `role-spawn-config/v1` (plan 1604-1642) | `cohortGrantBase64` + `cohortGrantSignatureBase64` **verbatim from `mac-cohort-opened-ack/v1`**; `stagedServerLaunchRecordBase64` from the stage receipt; `macSigningPublicKeyBase64`/`Sha256` = the staged Mac public key (§2.2(a)); FD 5 bundle digest/size/count from the minter |
| `warmupStartFor(plan)` | `role-warmup-start/v1` (plan 1685-1699) | `cohortWarmupEpochBase64` + signature **verbatim from `mac-warmup-epoch-issued-ack/v1`**; `expectedChildOfferedWarmupIngress` = 10 publisher / 0 worker; `expectedChildDeliveredWarmupRecords` = `shardSubscriberCount(w) * publisherCount * 10` worker / 0 publisher (plan 1422) |
| `measureStart()` | `role-measure-start/v1` (plan 1714-1719) | `cohortStartBarrierBase64` **verbatim from `mac-start-barrier-issued-ack/v1`** |
| `warmupCompletionManifestFor({entries, completedAtMacNs})` | — | issues `mac-export-warmup-completion-manifest-request/v1` and returns the binary's own signed manifest from the ack; the controller never assembles it (plan 983: "using a controller-reconstructed manifest fails before Linux drain") |

Every method **echoes bytes it received**. Guard: flip one byte of `cohortWarmupEpochBase64`
after the ack and prove the role child refuses, so an "equivalent" re-encode is not silently
accepted.

### 2.6 `check-official-io`: two defects, one of them round three's

Verified at HEAD by execution (`bun tools/compare/check-official-io.ts`, 311 findings on the
dirty worktree) and independently confirmed by the review. **There is no path doubling in
the scan.** §7.5 blocker 6's diagnosis is wrong in mechanism, right in consequence.

**(B) Cosmetic — round three's, two lines.** `check-official-io.ts:5106` and `:5116` report
`` `${TOOLS_COMPARE_ROOT}/${edge.from}` `` while `edge.from` is already repo-relative (all 70
`resolvedStaticImports[].from` values verified). That produces the six
`tools/compare/tools/compare/…` strings. **Fix:** drop the prefix at both sites.
**Expected delta: zero findings.** Six `STATIC_IMPORT_ALLOWLIST_EXTRA` entries keep code,
message and count; only the path normalizes. The RED oracles are re-pinned in the same
commit and the before/after key sets must differ **only** in those six paths.

**(A) Real, and NOT round three's.** `:5311` seeds the graph from `allowlist.officialRoots`
only — exactly `artifact-builder.ts`, `render-report.ts`, `run-campaign.ts`,
`verify-artifact.ts`. Files that are spawned rather than imported are never parsed, so no
forbidden-import, official-I/O or ambient-authority rule has ever run on **60 of 75**
classified files. Confirmed: zero allowlist edges from `server.ts` or `remote-supervisor.ts`,
and the audit reports nothing at either path. The live descriptor/pipe readers are therefore
unaudited, not mis-pathed: `server.ts:60-65`, `remote-supervisor.ts:73-81`,
`bin/compare-controller.ts:36-41`, all importing `node:fs`.

Repairing (A) brings ~48 non-test files into scope and ~23 `FORBIDDEN_IMPORT` findings on
code that legitimately performs pipe and process I/O — that is what §3.4 and §4.3 are made
of. The question "what may each allowlist bucket import and call?" is governance, not
runtime; blanket-allowlisting `node:fs` for these buckets deletes the check rather than
applying it. **(B) ships as S7; (A) is filed as its own reviewed deviation.** §5 keeps the
open question.

### 2.7 Rig cohort refusals become `remote-supervisor-refusal/v1`, terminal (§7.5 blocker 7)

**Today.** A refused cohort transition answers `m::ADMISSION_REFUSAL_KIND` carrying
`{"code":…,"schema":"measurement-refusal/v1"}` (`comparison-supervisor.rs:687-695`, payload
`:767`) and the session continues. §3.3 (plan 531) is unambiguous: on this codec "The refusal
kind is `remote-supervisor-refusal`. No alias kind is accepted," and
`RemoteSupervisorRefusalV1` (plan 536-544) is `terminal: true`.

**The change, scoped to the cohort dispatch arms only.** The `Err(code)` branch writes,
under header kind `remote-supervisor-refusal`:

```json
{ "schema": "remote-supervisor-refusal/v1", "responseSeq": <next>, "ackRequestSeq": <parsed>,
  "executionSha256": <bound execution, or null before the binding exists>,
  "code": <§3.1 closed literal>, "campaignStatus": "FAIL" | "REFUSED", "terminal": true }
```

and then **ends the session** — `terminal: true` is not decoration. §3.3's "One remote
channel carries one open execution" and §7's mapping (plan 2309-2312) make a refused cohort
transition the end of that arm regardless. `campaignStatus` is `REFUSED` for exactly
`RIG_UNREACHABLE`, `HOST_FD_PREFLIGHT`, `STALE_OR_INVALID_STAGING`; `FAIL` otherwise.

**Phase A untouched.** `measurement-refusal/v1` remains the Phase-A shape; round two proved
the audit key set is sensitive to this file. `CohortRigChannel.exchange`'s round-two
compatibility read stays as a tolerated legacy path with a test proving the cohort dispatch
no longer exercises it. Mutation proof: `terminal: false` must turn red a test asserting the
controller stops the arm and appends exactly one index entry.

### 2.8 (F2) Rig readiness — the invariant belongs to the Mac

`present_start_barrier` refuses unless `self.owner.phase() == CohortPhase::Ready`
(`secure_fs.rs:16111`); the only setter is `CohortRuntime::mark_ready` (`:14447`), demanding
9 role children and 101 registrations the rig neither spawns nor observes.
`RigCohortSession::mark_ready` (`:16288`) has no production caller and cannot acquire one.

**The change.** Leave `CohortRuntime::mark_ready` alone — it is the Mac-side owner's
invariant and `crates/native/tests/fanout_supervisor.rs:363` depends on it. Add a rig-side
readiness with a rig-side invariant:

```rust
/// Readiness the rig can actually check: the child reported that every publisher
/// and every subscriber the grant declared completed the warmup wire. Stronger
/// than a count declared at registration, because a peer that registered and then
/// died cannot reach this number.
pub fn mark_ready_from_linux(&mut self, drained: &ServerWarmupDrainedFacts) -> CohortResult<()>
```

called from `finish_warmup` (`:15871`) right after `parse_child_warmup_drained`, requiring
`publisherWarmupEndCount == grant.publisherCount` and
`subscriberWarmupEndCount == grant.subscriberCount`. Warmup precedes the barrier in §5
(step 7 before step 9), and §4.1's warmup equations (plan 1422) make those counts
non-vacuous.

**Keep the gate (review 11).** The alternative — dropping it — is refuted by the code's own
comment at `secure_fs.rs:16106-16110`: "a supervisor that marked itself ready on the arrival
of a barrier would be letting the Mac decide that its own role children exist." Recorded
here so round four does not reopen it.

### 2.9 NEW — the Mac cohort runtime as a process (review finding 1, option b)

**What is true at HEAD.** The Mac signer is `MacFanoutSupervisor`, a TypeScript class in the
controller process: `macSign` (`remote-supervisor.ts:2813-2822`) calls `signMacReceipt` with
`this.config.macKeys.privatePkcs8Der` (`:2678`, `:2818`), used for `cohort-grant/v1` at
`:2918` and for the rest through the same helper.
`createMacProductionCohortMinter` (`:6436-6516`) returns an **unsigned** grant.
`spawnMacSupervisor` (`:787-820`, called `compare-controller.ts:2433-2450`) passes exactly
four bootstrap descriptors — `authority` 3, `authority-digest` 4, `campaign-root` 5,
`staging-root` 6 — and no signing key. `comparison-supervisor.rs` has **no `mac-*` dispatch
arm**, and nothing sends `mac-open-cohort-request/v1`,
`mac-issue-warmup-epoch-request/v1` or `mac-issue-start-barrier-request/v1`. Revision 1
asserted this channel existed. It does not.

**The change: symmetry with the rig.**

**(1) Process lifetime, decided: per campaign (review NEW-3).**

Revision 3 gave the binary four descriptors, two of them per-`<runId>`
(`<campaignRoot>/<runId>/execution-binding.json`, `…/workload-role-plan-input.json`), while
the Mac supervisor is spawned **once**: `spawnMacSupervisor` has exactly one call site
(`bin/compare-controller.ts:2433`, handle assigned `:2457`) in one-time setup, and §3.2 runs
four executions. One long-lived process cannot hold four `<runId>`s open, and the controller
cannot have written the first before the spawn that precedes it.

**Per-campaign is confirmed by the plan, not merely convenient.** §5 treats the supervisor as
campaign-scoped — step 2 `MAC_EXECUTION_OPEN` says the Mac "assigns `executionIndex`", which
is a counter across executions and cannot live in a process that dies between them; the same
holds for `receiptSequence` monotonicity and the durable replay ledger. Plan 238's key path is
itself campaign-scoped: `<candidate>/<campaignId>.mac.pk8`, one key per campaign.

**So per-execution inputs travel as frame payloads, and the descriptor set drops to two.**
`mac-open-cohort-request/v1`'s frozen key set already carries everything the two deleted
descriptors held — verified at `cross-supervisor-protocol.ts:1942-1950` against plan 595-604:

```
requestSeq · executionSha256 · scenarioHash · rolePlanHash
workloadRolePlanInputBase64 · workloadRolePlanInputSha256 · workloadRolePlanInputSize
```

The canonical role-plan bytes are *on the frame*, with their digest and size, which is exactly
what `--cohort-role-plan-fd` was for; and `executionSha256` is what
`--cohort-execution-binding-fd` was for. Both descriptors are deleted. The binary anchors that
`executionSha256` against the campaign authority it already holds on **fd 3**, which is
campaign-scoped and already verified by the trust bootstrap.

| Option | What it is | Scope |
|---|---|---|
| `--cohort-mac-signing-key-fd` | the Mac Ed25519 PKCS#8 DER. A descriptor, never a path or env var: the key lives outside every root the supervisor owns, so the launcher opens it and the process inherits an open file and no way to name it. | campaign (plan 238's path is per `<candidate>/<campaignId>`) |
| `--cohort-staged-rig-public-key-fd` | the staged **rig public** key, so the binary can verify every rig record before binding it — the descriptor that makes §2.9's security property true | campaign (a staging-root leaf) |

**Two, all-or-none.** Present-but-incomplete is `TRUST_DESCRIPTOR_ARGUMENT_INVALID`; a failed
install is fatal at startup, never a silent fall back to "no cohort".
`macSupervisorInstanceNonce` and `macClockId` are **observations**, not inputs — the rule
`observe_clock_identity()` established for the rig.

**Consequences, all of them:**

- **§3.2's budget is unchanged and correct as written** — one `sudo` spawn per campaign, in
  the existing one-time setup, not four. Revision 3's budget already assumed no per-execution
  spawn; that assumption is now the decision rather than an oversight.
- **`macSupervisor` at `bin/compare-controller.ts:2457` stays campaign state**, not per-arm.
  S9 gains no per-execution spawn path.
- **The restart-refuses test keeps its exact meaning.** With a campaign-scoped supervisor a
  mid-campaign restart is *never* legitimate, so
  `a_restarted_mac_supervisor_refuses_to_admit_on_five_of_seven` needs no
  legitimate-respawn discrimination and both nets stand as designed. Had the answer been
  per-execution, the test would have had to separate an inter-execution respawn from an
  intra-execution one; it does not.
- **A new `MacCohortSession` is opened per execution inside the one process**, keyed by
  `executionSha256`, and closed at `mac-cohort-evidence-exported-ack/v1`. The retained records
  of §2.9(2) live in that session, so "same session" means "same execution in the same
  process" — which is what the five-of-seven invariant needs.

**(2) Records minted, and what each verifies first.** A `MacCohortSession` mirroring
`RigCohortSession`, with a stage enum and a monotonic `receiptSequence`:

| Request → ack | Mints / signs | Verified before minting |
|---|---|---|
| `mac-open-cohort-request/v1` → `mac-cohort-opened-ack/v1` | 32 random bytes per role; `token-commitment-leaf-manifest/v1`; `cohort-grant/v1` + signature | `scenarioHash`/`rolePlanHash` equal the execution binding's; `workloadRolePlanInputSha256` equals the descriptor bytes' digest; `expectedProcessCount`/`expectedSessionCount` equal the cell cardinality; §4.1 leaf order and Merkle root recomputed |
| `mac-present-rig-cohort-acceptance-request/v1` → `mac-rig-cohort-acceptance-ack/v1` | nothing; **retains** | `rig-cohort-acceptance/v1` signature verifies against the **staged rig public key**; `cohortGrantSha256` equals the grant this session minted; expiry and `receiptSequence` monotonicity |
| `mac-issue-warmup-epoch-request/v1` → `mac-warmup-epoch-issued-ack/v1` | `cohort-warmup-epoch/v1` + signature | the request names this grant **and** the retained rig cohort acceptance; a fresh `warmupNonce`; one epoch per cohort |
| `mac-export-warmup-completion-manifest-request/v1` → `mac-warmup-completion-manifest-exported-ack/v1` | `role-warmup-completion-manifest/v1` + signature | ordered entries sum to the epoch's `expectedWarmupIngress`/`expectedWarmupDeliveries` (plan 1422); every child present exactly once; one-shot |
| `mac-issue-start-barrier-request/v1` → `mac-start-barrier-issued-ack/v1` | `cohort-start-barrier/v1` + signature | **`rig-warmup-drained-receipt/v1` and `rig-measure-start-ack/v1` both verify against the staged rig public key**, and their digests are the ones bound into the barrier; `measureStartAtMacNs >= mintedAtMacNs + 250,000,000` (§5 step 9) |
| `mac-present-rig-barrier-acceptance-request/v1` → `mac-rig-barrier-acceptance-ack/v1` | nothing; retains; sets `roleChildrenMayArm: true` | `rig-barrier-acceptance/v1` verifies against the staged rig key and names this barrier |
| `mac-present-rig-observation-request/v1` → `mac-measurement-admission-issued-ack/v1` | `mac-measurement-admission/v1` + `cohort-admission-receipt/v1`, both signed | the whole rig graph verifies against the staged rig key and every digest cross-pairs — but **only five of the seven records arrive on this frame**; see below |
| `mac-export-cohort-evidence-request/v1` → `mac-cohort-evidence-exported-ack/v1` | `cohort-observation-evidence/v1` from retained bytes only | names the admission receipt this session minted; one-shot; ≤ 9 MiB decoded / 14 MiB encoded, charged against the 20 MiB budget before allocation (plan 529) |

**Five of seven, and the restart invariant (revision-2 residue).** Revision 2 said the
observation frame lets the binary verify "the whole rig graph". Plan 697-715 carries only
**five** of the seven rig records: `rigExecutionAcceptance`, `rigMeasureStartAck`,
`rigBarrierAcceptance`, `rigServerSnapshotReceipt`, `rigRelayObservationReceipt` (plus the
two server-child records). The other two — `rig-cohort-acceptance/v1` and
`rig-warmup-drained-receipt/v1` — are **not on this frame**, and never were:

- `rig-cohort-acceptance/v1` arrived earlier on `mac-present-rig-cohort-acceptance-request/v1`
  and was verified and retained then;
- `rig-warmup-drained-receipt/v1` arrived on `mac-issue-start-barrier-request/v1` — whose
  frozen key set carries `rigWarmupDrainedReceiptBase64` /
  `rigWarmupDrainedReceiptSignatureBase64` (`cross-supervisor-protocol.ts:2002-2009`) — and
  was verified and retained then.

So the admission's seven-record graph is **five verified now plus two verified earlier and
retained**, and that is sound *only if it is the same `MacCohortSession`*. The invariant, and
the two codes it refuses with:

> A Mac supervisor that did not itself verify and retain the cohort acceptance and the
> drained receipt **must refuse to mint the admission**, never admit on five of seven.

Two independent nets, both derived from frozen rules rather than added:

1. **Channel sequence.** §3.3 gives each controller→supervisor direction a `requestSeq`
   starting at 0 and fails "a skipped, repeated, stale, or out-of-state value" (plan 529). A
   restarted supervisor's channel begins at 0, so an observation request bearing the
   mid-execution `requestSeq` is caught before any state is consulted →
   **`FAIL/TRUST_PROTOCOL`** (plan 2293).
2. **Retention.** If a session exists but lacks either record, `retained(...)` refuses, and
   the request is describing an execution this session did not conduct →
   **`FAIL/CROSS_SUPERVISOR_MISMATCH`** (plan 2294).

Named test, owned by S5-MAC-RS: `a_restarted_mac_supervisor_refuses_to_admit_on_five_of_seven`
— drive the lifecycle to the barrier, restart the binary, present a well-formed observation
request, and assert refusal rather than an admission receipt. Mutation-proven by deleting the
retention check and showing the test goes red on net 2 alone (with the sequence net disabled),
so the two nets are shown to be independent rather than one net counted twice.

**Sequence and refusal rules** are §3.3's, unchanged: one open execution per channel,
`requestSeq` from 0, responses echo `ackRequestSeq`, ≤ 192 frames, payload cap
`CAPS.remotePayloadDefault` except the two named exports. A refused Mac transition answers
`remote-supervisor-refusal/v1` `terminal: true` with the §3.1 closed code — the same shape
§2.7 gives the rig, so the two supervisors refuse identically.

**(3) The TS side.** `MacCohortChannel` in `remote-supervisor.ts`, the exact analogue of
`CohortRigChannel` (`:5051-5600`): eight request senders, exact-key parsers for the eight
acks, stage tracking, and the refusal read. `MacFanoutSupervisor` keeps its 1,197 lines
minus `macKeys` (`:2678`) and `macSign` (`:2813-2822`); every former `this.macSign(...)`
site becomes an `await channel.<step>(...)` returning signed bytes it retains verbatim.
`openCohort` (`:2841`), `issueWarmupEpoch` (`:3381`), `issueRoleWarmupCompletionManifest`
(`:3453`), `issueStartBarrier` (`:3640`) and `exportCohortEvidence` (declared at `:4257`;
`:4255` is the doc comment above it — corrected per review N5) keep their signatures and
become thin clients; `presentRigCohortAcceptance` (`:3274`),
`presentRigWarmupDrainedReceipt` (`:3523`), `presentRigMeasureStartAck` (`:3594`),
`presentRigBarrierAcceptance` (`:3707`) and `presentRigRelayObservation` (`:3774`) forward to
the binary instead of verifying in process.

**(4) Spawn-path plumbing, and the uid boundary it must cross (N1).**

Revision 2 put the Mac key at `${stagedDir}/mac-supervisor-ed25519.key` and opened it with
`buildRigSupervisorWrapperScript`'s `exec N<…`, "the same mechanism the rig's four use."
Three things were wrong and the third was fatal. Verified at HEAD:

1. **Wrong path.** Plan line 238 fixes the Mac private key at
   `/var/db/webtransport-bun/comparison/keys/<candidate>/<campaignId>.mac.pk8`, mode `0400`,
   owner `_wtcompare`, group `staff`.
2. **Wrong directory.** `staging-root` holds **public** halves only —
   `mac-supervisor-ed25519.pub` / `rig-supervisor-ed25519.pub`
   (`bin/stage-live-campaign.ts:114-117`, plan 2772). There is no `.key` leaf there to open.
3. **Fatal.** Plan line 238: "the controller never reads either private key. **The Mac
   controller account must fail `test -r` on the Mac key**" — and plan 2775 executes exactly
   that assertion during staging. `spawnMacSupervisor` launches the wrapper with
   `nodeSpawn("bash", [scriptPath], …)` (`remote-supervisor.ts:843`) — no `sudo`, no uid
   change — so an `exec 7</…mac.pk8` inside that wrapper **must** fail by design. The rig's
   mechanism does not generalise: the rig wrapper runs over SSH as a different account on a
   different host, and the Mac had no such separation.

**What already exists, and is reused rather than invented** (the coordinator asked; the
answer is "the naming, not the plumbing"):

- **There is no Phase-A Mac signing-key descriptor.** `spawnMacSupervisor` (`:787-820`)
  passes exactly four bootstrap descriptors. Nothing to reuse there.
- **The env names are already frozen into the run command and have no consumer.**
  `bin/stage-live-campaign.ts:1025-1026` writes
  `export COMPARISON_MAC_SIGNING_KEY="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"`
  and `export COMPARISON_MAC_SUPERVISOR_USER=_wtcompare` (plan 2868-2869), and a repo-wide
  grep finds **no reader of either**. That is the placeholder-evidence family once more: two
  frozen bindings the run command sets and nothing consumes. §2.9 consumes them; it does not
  invent a new name.
- **The uid mechanism is already the plan's own.** Plan 2769 runs
  `/usr/bin/sudo -n -u _wtcompare "$MAC_RUNTIME/comparison-supervisor" keygen-ed25519 …` and
  plan 2915 runs `/usr/bin/sudo -n -u _wtcompare "$MAC_RUNTIME/comparison-supervisor"
  destroy-signing-key …`. The supervisor binary is *already* executed as `_wtcompare` twice
  in the frozen lifecycle. Running it as `_wtcompare` for the campaign itself is the
  consistent third case, not a new privilege.

**The spawn form, and why the script is not a file (review NEW-1).** Revision 3 wrote
`nodeSpawn("/usr/bin/sudo", ["-n","-u",USER,"/bin/bash", scriptPath])`. That changes the
executor's uid and the descriptor provenance and never touches the script itself. At HEAD
(`remote-supervisor.ts:827-832`) the script is written `0700` into `tmpdir()`, which on macOS
is `/var/folders/<hash>/T` — `drwx------`, owned by the controller account, per-user by
construction. `_wtcompare` cannot traverse it, so `/bin/bash <scriptPath>` fails at exec,
before fd 3 is opened and before the key is touched. Mode alone cannot fix it; the directory
is the problem.

Three candidate crossings, and the one taken:

| Candidate | Verdict |
|---|---|
| (i) write the script into `$MAC_TRUST` or a shared campaign dir at 0755 | **Rejected.** §9 freezes the staged tree after commit — `$MAC_TRUST/upcoming-run-command.sh` is mode `0444` (plan 2684, asserted plan 2886) and the stage receipt binds the tree's digests — so a per-spawn file written there breaks staging immutability. It also creates a new group-readable object containing the key path and fd layout, which would then need its own digest pin and its own preflight line. |
| (ii) `bash -s`, script on stdin | **Rejected on a concrete conflict:** stdin *is* the control channel. `buildRigSupervisorWrapperScript` binds `controlIn: {fd: 0}` / `controlOut: {fd: 1}` and `spawnMacSupervisor` wires `stdio: ["pipe","pipe","pipe"]` (`remote-supervisor.ts:843-845`). Feeding the script on stdin consumes the frame channel. |
| (iii) exec the supervisor directly under `sudo` with argv, no shell | **Rejected:** the six descriptors are established by shell redirections (`exec 3< …`), which only a shell provides. |
| **(iv) `sudo -n -u _wtcompare /bin/bash -c <script text>` — script as argv** | **Taken.** |

```
spawnMacSupervisor:  nodeSpawn("/usr/bin/sudo",
                       ["-n", "-u", process.env.COMPARISON_MAC_SUPERVISOR_USER ?? "_wtcompare",
                        "/bin/bash", "-c", wrapper.script], …)
```

Why (iv) is the right one:

- **Nothing crosses as a pathname.** The script becomes process argv, delivered by `execve`.
  This *strengthens* residual 2c's property rather than trading it away: revision 3's design
  still had a temp file to create, chmod, and unlink; this has no filesystem object at all,
  so there is nothing to digest-pin, nothing to leak between runs, and the three
  `unlinkSync(scriptPath)` cleanup paths (`remote-supervisor.ts:854`, `:879`, `:891`) are
  **deleted**, not relocated.
- **§9's immutability is untouched**: nothing is written into `$MAC_TRUST` or the campaign
  root at spawn time.
- **The control channel stays free**, which (ii) would have consumed.
- **Cost, stated:** the script text is visible in `ps` argv. It contains the supervisor binary
  path, the key *path*, and the fd layout — no key material. Every one of those is already
  world-readable in the mode-0444 frozen run command (plan 2684/2886) and printed in the plan
  itself, so argv exposure discloses nothing new. A named test asserts the argv contains no
  key *bytes*, only paths.

### 2.9(4a) Every object that crosses the uid boundary

**The domain of this table is everything the child needs in order to run and everything that
acts on it after it starts — not every file.** Revision 4's version was scoped to filesystem
objects, which is why it missed two that break the spawn at run time: the **environment**
(row 10) and **process control** (row 11). That scoping error is the same shape as the errors
it was written to prevent, and stating the domain explicitly is the fix.

Each row carries its owner and mode at HEAD and what it must become. **The filesystem problem
is larger than the review stated**: the staged trust root and every subdirectory are created
`0700` (`bin/stage-live-campaign.ts:702-704`), campaign-root at `:1555` and staging-root at
`:1556` — so fds **3, 4, 5 and 6 are all unreadable by `_wtcompare` today**, not only
campaign-root.

| # | Object | Direction | At HEAD | Must be |
|---|---|---|---|---|
| 0 | wrapper script | controller → `_wtcompare` | `0700` file in `drwx------` `tmpdir()` (`remote-supervisor.ts:827-832`) | **no filesystem object** — argv, per (iv) |
| 1 | `$MAC_TRUST/authority.json` (fd 3) | read by `_wtcompare` | inside a `0700` tree (`:702-704`) | tree `0750` group `staff`; file `0640` group `staff` |
| 2 | `$MAC_TRUST/authority-digest.bin` (fd 4) | read by `_wtcompare` | same | same |
| 3 | campaign-root **dir** (fd 5) | read+write by `_wtcompare` | `0700` controller-owned (`:1555`) | `2770` group `staff` — **setgid**, so files the supervisor creates inherit `staff` and the controller can read them back |
| 4 | `$MAC_TRUST/staging-root` **dir** (fd 6) | read by `_wtcompare` | inside the `0700` tree | `0750` group `staff` |
| 5 | `$COMPARISON_MAC_SIGNING_KEY` (fd 7) | read by `_wtcompare` **only** | `0400` owner `_wtcompare` (plan 238) — **already correct** | unchanged; the controller must keep failing `test -r` |
| 6 | `staging-root/rig-supervisor-ed25519.pub` (fd 8) | read by `_wtcompare` | `0644` (plan 2772) — **already correct** | unchanged |
| 7 | per-`<runId>` dirs under campaign-root | **created by `_wtcompare`**, read by the controller | do not exist yet | created `2770` group `staff` under the setgid parent |
| 8 | supervisor state in campaign-root (replay ledger, receipt sequence) | written by `_wtcompare`, read back by the controller for verification | n/a | `0660` group `staff`; supervisor `umask 007` |
| 9 | sealed artifacts, per-rep evidence, campaign index | **written by the controller** (`sealCohortArmRepetition`, `bin/compare-controller.ts:4496`) | controller-owned | unchanged — the controller still owns evidence writing; the supervisor never seals |
| **10** | **the environment** — `COMPARISON_SUPERVISOR_BUN_PATH` | controller → `_wtcompare` | set in the child env at `remote-supervisor.ts:849`; **stripped by `sudo`'s `env_reset`** | carried as an `export` line inside the argv script — **§2.9(4c)** |
| **11** | **process control** — stop and reap | controller → `_wtcompare` | `stopSupervisor` (`:1111-1152`) `SIGTERM`s `child.pid`, which is **`sudo`'s** and whose target is another uid | three-stage EOF → wait → `sudo … kill -- -<pgid>`, proving *reaped* — **§2.9(4d)/(4e)** |
| **12** | **the control channel — fds 0, 1, 2** | controller → `_wtcompare`, **as open descriptors** | `stdio: ["pipe","pipe","pipe"]` (`:843-845`) bound by the wrapper as `--control-in-fd 0 --control-out-fd 1` (`:497-503`) — these **do** cross the sudo boundary; sudo preserves standard I/O | **unchanged, and deliberately so.** This is the boundary's *interface*, not a leak: stage 1's graceful stop **is** closing fd 0. Residual 2c is reworded to say so. |
| **13** | **umask** | controller → `_wtcompare` | sudo applies **sudoers' `umask` (0022 by default)**, not the caller's — so rows 7-8's required `0660`/`2770` would silently degrade to `0644`/`0755` and the reverse crossing becomes read-only | explicit **`umask 007`** line in the argv script, plus a post-spawn assertion on a file the supervisor actually created |
| **14** | **`PATH`** | controller → `_wtcompare` | `env_reset` replaces it with sudoers' `secure_path`. The wrapper does exactly **one** PATH lookup — `exec 3< <(cat -- …)` (`:490`) — while every other command is absolute | spell it **`/bin/cat`**. Absolute paths chosen over exporting a PATH: the script then depends on no environment at all, matching §2.9(4c)'s rejection of host-sudoers dependencies |
| **15** | **working directory** | controller → `_wtcompare` | sudo without `-i` does not chdir, so the child inherits the controller's cwd, which `_wtcompare` may not be able to traverse. Inheritance itself does not fail — the handle is inherited, not re-resolved — but `getcwd()` and any relative open would, obscurely | **`cd /`** as the script's first line. Free, and it makes the child's cwd a stated property rather than an accident. Every path in the script is already absolute. |

**The reverse crossing is the one that is easy to miss** and is why rows 3, 7 and 8 specify
setgid plus `umask 007`: the supervisor creates files that the *controller* must later read to
seal. A design that only granted `_wtcompare` access forward would fail at assembly.

**Row 5 is the boundary's whole point**: it is the one object that must *not* be widened.
Any change that makes the key group-readable defeats §2.9 entirely, so the preflight asserts
its negative explicitly.

**The resulting script**, with rows 13-15 and §2.9(4c)'s row 10 in place:

```bash
#!/usr/bin/env bash
set -eu
cd /                                                       # row 15
umask 007                                                  # row 13
export COMPARISON_SUPERVISOR_BUN_PATH=<shellQuote(bunPath)> # row 10
exec 3< <(/bin/cat -- <authorityFile>)                     # row 14: was `cat`
exec 4<<authorityDigestFile>
exec 5<<campaignRootDir>
exec 6<<stagingRootDir>
exec 7<<macSigningKeyPath>                                 # row 5
exec 8<<stagedRigPublicKeyPath>                            # row 6
exec <supervisorBinary> --authority-fd 3 … --control-in-fd 0 --control-out-fd 1 \
  --cohort-mac-signing-key-fd 7 --cohort-staged-rig-public-key-fd 8
```

#### The five objects outside the table, named and dismissed

The domain is "everything the child needs and everything that acts on it". Five more objects
are inside that domain and outside the table; each is dismissed with its reason, so the table
is **closed** over the domain rather than merely long.

| Object | Why it does not need a row |
|---|---|
| **controlling tty** | `sudo -n` fails outright under `requiretty`, which **preflight check 1 already catches**. `detached: true` (§2.9(4e)) calls `setsid(2)` and removes the controlling terminal, which is the desired end state anyway. |
| **resource limits** | Inherited, possibly reset per sudoers. The Mac supervisor holds ~18 role-child pipes and two descriptors — **not** the 1,010 sockets, which are the server child's, spawned by the rig on the other side of this boundary. Low risk, and §3.2's session probe measures the side that carries the load. |
| **signal dispositions** | Benign, but revision 6 gave the wrong mechanism (review NEW-15). **SIGPIPE is raised on *write* to a pipe with no reader**, so stage 1's `Ok(None)` EOF break (`comparison-supervisor.rs:604-606`) is a **read**-side event and is **disposition-independent** — reading a pipe whose write end is closed returns zero bytes under `SIG_DFL` just as under `SIG_IGN`. What Rust's `SIG_IGN` actually protects is the supervisor's **outbound** writes once the controller's read end goes away — i.e. exactly the hazard §2.9(4d)'s half-close now avoids, and the reason a mis-ordered stage 1 would have *looked* like it worked. Sudo resetting handlers before `exec` is harmless because Rust installs the disposition in `lang_start`, before user code. |
| **locale / `LANG`** | Stripped by `env_reset`. The binary emits canonical JSON and lowercase hex; Rust's formatting is locale-independent. Benign. |
| **`TMPDIR`** | Stripped. Nothing on the Mac supervisor path writes a temp file **now that the wrapper is argv** — one more thing form (iv) bought, rather than a property that had to be arranged. |

### 2.9(4c) Row 10 — the environment

`sudo` runs with `env_reset` by default and discards the caller's environment apart from a
small `env_keep` list. The Mac binary **requires** `COMPARISON_SUPERVISOR_BUN_PATH`:
`std::env::var_os("COMPARISON_SUPERVISOR_BUN_PATH")` at
`crates/native/src/bin/comparison-supervisor.rs:1877`, with the `None` arm at `:1908-1916`
printing "supervisor toolchain observation required: set `COMPARISON_SUPERVISOR_BUN_PATH` to
the Bun executable this supervisor will launch" and exiting. The controller sets it in the
child env at `remote-supervisor.ts:845-850`. Under form (iv) it never arrives, and the
supervisor fails **before any descriptor matters**.

**The crossing set is exactly one variable, and I enumerated rather than assumed it.** Two
greps at HEAD:

- **Every `std::env` read in the supervisor binary:** one — `:1877`. (`secure_fs.rs:3688`
  matches `WT_COMPARISON_STRICT_ADDON_FD`, but it inspects a **supplied** `env: &[(String,
  String)]` list — a child's allowlisted environment — not this process's own, so it does not
  cross.)
- **Every `COMPARISON_*` in the controller:** `COMPARISON_SUPERVISOR_BUN_PATH`,
  `COMPARISON_SUPERVISOR_BINARY`, `COMPARISON_RIG_SUPERVISOR_BINARY`,
  `COMPARISON_RIG_STAGED_DIR`, `COMPARISON_OUTPUT_ROOT` — plus the two §2.9 additions,
  `COMPARISON_MAC_SIGNING_KEY` and `COMPARISON_MAC_SUPERVISOR_USER`. **All seven are read by
  the controller**, to decide what to spawn and where; none is read by the supervisor.

So exactly one variable must cross, and the frozen run command's other exports
(`bin/stage-live-campaign.ts:1025-1029`: `COMPARISON_RIG_SIGNING_KEY`, `COMPARISON_SSH_*`, …)
stay controller-side by construction.

**The mechanism: one `export` line inside the argv script.**
`buildRigSupervisorWrapperScript` already builds the script by interpolation through
`shellQuote`, so the line is emitted with the six `exec N<` lines:

```
export COMPARISON_SUPERVISOR_BUN_PATH=<shellQuote(options.bunExecutablePath)>
```

- **Consistent with form (iv)'s own argv analysis.** The value is a **path** to the Bun
  executable. Every value the wrapper interpolates is a path — `authorityFile`,
  `authorityDigestFile`, `campaignRootDir`, `stagingRootDir`, `rigBinaryPath`, and now the key
  path and the bun path — and **none is a secret**: the key's *path* crosses, its *bytes*
  never do. `the_spawn_argv_carries_paths_and_no_key_material` already asserts this and gains
  the new line in its coverage.
- **`sudo -E` and `--preserve-env=` are rejected.** `-E` forwards the controller's entire
  environment across a privilege boundary, which is the opposite of what §2.9 is for;
  `--preserve-env=NAME` and an `env_keep` entry both depend on the host's sudoers permitting
  them, which is the class of host dependency residual 2c refused to rely on. An explicit
  `export` of one named path depends on nothing but the shell.
- **Preflight gains check 11:** `sudo -n -u _wtcompare test -r -a -x "$BUN_PATH"` — the bun
  executable must be readable and executable by the target uid, not merely by the controller.
- **Named test:** `the_supervisor_starts_under_sudo_with_an_emptied_parent_environment` —
  spawn with a stripped parent env and assert the binary does not print the `:1913` message.

### 2.9(4d) Row 11 — shutdown and reap

`stopSupervisor` (`remote-supervisor.ts:1111-1152`) does `proc.kill("SIGTERM")` **first**,
polls `proc.exitCode` for the deadline, then `SIGKILL`, then closes the owned fds — and
**returns `{ ok: true }` on every path**, with `exitCode: proc.exitCode ?? -1`. Two things
break under (iv), and the second is why the current code cannot report the first:

1. `kill(2)` needs a matching uid. The controller cannot signal a `_wtcompare` process, so
   both signals are no-ops and the 5,000 ms bound (`bin/compare-controller.ts:2506`, `:2509`)
   expires against a process that never received them.
2. `handle.pid` is `child.pid` (`:727-729`) — **`sudo`'s** pid. Whether `sudo` `exec`s in
   place or forks and relays is version- and configuration-dependent, so even a permitted
   signal may not reach the supervisor.

**The three-stage design. The graceful stop is something the controller *can* do across the
boundary: close the control channel.**

| Stage | Mechanism | Why it works across uids |
|---|---|---|
| **1. Graceful — a half-close** | `handle.controllerToSupervisor.end()` **and nothing else**: the supervisor's fd 0 reaches EOF while its fd 1 stays open and the controller keeps reading | the serve loop reads frames and **breaks on EOF** — `Ok(None) => break` at `comparison-supervisor.rs:604-606` — then falls through to `teardown_cohort()` and returns its summary. Closing a pipe needs no uid match. |
| **2. Reap proof** | bounded wait on **`sudo`'s own exit** (the `exited` promise at `remote-supervisor.ts:720-725`), not a poll of `exitCode` | `sudo` does not exit until its child does, whether it execs or forks, so observing `sudo`'s exit **is** the waitpid proof that the supervisor is gone. This works without knowing which form sudo took. |
| **3. Forced** | `sudo -n -u _wtcompare /bin/kill -TERM -- -<handle.pgid>`, then `-KILL` — **the pgid is established by §2.9(4e), not assumed** | **permitted by the existing grant** — the host provisioning grants `${ADMIN_USER} ALL=(_wtcompare) NOPASSWD: ALL`, so no second sudoers entry is needed. Preflight check 12 asserts the grant covers it. |

**Stage 1 is a half-close, and `closeOwnedFds()` is NOT part of it (review NEW-14).** Revision 6
said "`closeOwnedFds()` **first**, not last". That function does four things
(`remote-supervisor.ts:1115-1128`) and stage 1 wants exactly one of them:

```ts
for (const fd of handle.bootstrapFds) safeClose(fd);        // not stage 1
for (const fd of handle.controlParentFds) safeClose(fd);    // not stage 1
handle.controllerToSupervisor?.end();                       // ← stage 1, this line only
handle.supervisorToController?.destroy();                   // not stage 1 — the OUTPUT channel
```

Calling all four tears down the supervisor's **output** channel at the same instant it is told
to wind down. The supervisor writes on its way out: every failure arm in the serve loop calls
`self.terminate(writer, code)` (`comparison-supervisor.rs:607`, `:617`, `:621`, `:639`) and the
loop body has three `m::write_frame(writer, …)` sites (`:632`, `:649`, `:658`). With the read
end destroyed those writes hit a broken pipe — and because Rust ignores `SIGPIPE` they return
`EPIPE` rather than killing the process, so **the supervisor still exits and stage 2's proof
still holds**, which is precisely why this would have survived review: it exits on a write
error instead of through its teardown path, and the controller silently discards whatever it
said last. A graceful stop that cuts off the other side's reply is not graceful, and that
distinction is the one §2.9(4d) exists to draw.

**The ordering:**

1. **stage 1** — `handle.controllerToSupervisor.end()` only. Half-close: the supervisor's fd 0
   sees EOF, its fd 1 stays open, and the controller **keeps reading `supervisorToController`
   until EOF**, retaining the final frames.
2. **stage 2** — wait on `sudo`'s exit.
3. **then** `closeOwnedFds()`, where releasing the bootstrap fds and the parent's control copies
   is correct because nothing is left to say.

**The stage-1 test must check receipt, not termination.** `closing_the_control_channel_stops_the_supervisor_without_a_signal`
asserts that the supervisor's **final frame was received and its content matches the expected
summary** — not merely that the process ended. Without that, the test passes on the broken-pipe
path and the defect survives its own guard.

**`proc.kill("SIGKILL")` at `remote-supervisor.ts:1145` is DELETED, not retained as a fourth
stage.** This is load-bearing, not tidying: in sudo's fork mode, `SIGKILL`ing sudo kills the
*waiter* without reaping its child, orphaning the supervisor to launchd — so stage 2's "sudo
exited" observation would report `reaped: true` about a process that is still running, and the
new verdict would become false in exactly the case it exists to detect. Stage 3 signals the
supervisor's own group instead, and stage 2 then observes a real exit. A test asserts no
`SIGKILL` is ever sent to `handle.pid`.

**`stopSupervisor` returns a real verdict.** Its unconditional `{ok: true}` becomes
`{ ok: true, exitCode, reaped: true }` or a refusal naming the stage that timed out, so a
supervisor that was signalled but not reaped is distinguishable from one that exited. §1.2's
`TEARDOWN` row and §3.2's 10 s teardown budget then rest on something checked.

### 2.9(4e) Row 11's process group — establishing the number stage 3 names

Revision 5's stage 3 said `kill -- -<pgid>` and **never said where `<pgid>` came from**. At
HEAD it cannot come from anywhere safe: `nodeSpawn` is called with only `stdio` and `env`
(`remote-supervisor.ts:843-850`) — **no `detached`**, so no `setsid(2)` — and `handle.pid` is
`child.pid` (`:727-729`), a pid rather than a pgid. The only process group the controller can
name is therefore **its own**, and `kill -TERM -- -<controller pgid>` would signal the
controller itself, the rig supervisor (`bin/compare-controller.ts:2506`) and every role child.
A teardown would end the campaign that issued it, and S9's reap test could never pass because
`ps -g <pgid>` would always contain the controller.

**The pattern is already in this file, twice, and is reused rather than invented.**
`createMacFanoutRoleChildHost` spawns every role child with `detached: true`
(`remote-supervisor.ts:6178`) under a comment that states the property exactly (`:6152`):

> "`detached: true` is `setsid(2)`: the child's PGID equals its PID and no role child shares a
> group with another, which is what makes `killPgid` able to take down a child and anything it
> forked without touching its siblings."

and `createMacFanoutProcessControl` (`:5757`) is the matching `killPgid`/`waitPgid` pair. §1.2's
`SERVER_READY` row says the rig's `spawn_server` "forks into its own pgid" and its `TEARDOWN`
row reaps that group. The Mac supervisor is the one process in the design that was left out.

**The change (S8):**

1. `nodeSpawn(… , { stdio, env, detached: true })` — `setsid(2)`, so **`pgid === child.pid`**
   and the group is disjoint from the controller's. `detached` is compatible with
   `stdio: ["pipe","pipe","pipe"]`: the pipes are inherited descriptors, unaffected by the new
   session. It also removes the controlling terminal, which is the dismissed-object row's
   desired end state.
2. `SupervisorHandle` gains **`pgid`** beside `pid`, so stage 3 and the S9 test name the same
   number instead of each deriving one.
3. **A spawn-time assertion that `handle.pgid !== process.pgid`**, refusing before any frame is
   sent. Without it, a future edit that drops `detached` silently re-arms the campaign-wide
   self-kill — the assertion is the regression guard, not the spawn option.

⚠ **`processGroupAlive` cannot be reused across the boundary as-is — a new finding.**
`remote-supervisor.ts:5742` probes liveness with `process.kill(-pgid, 0)` **from the
controller** and treats `EPERM` as *dead*, which is correct for role children the controller
owns (its comment at `:5729-5740` records the measured Darwin behaviour: a group of zombies
answers `EPERM`). Against a **`_wtcompare`-owned** group the controller gets `EPERM` while the
supervisor is very much **alive**, so the helper would report a running supervisor as reaped —
the same false verdict this section exists to eliminate. The liveness probe for row 11 must run
**as the target uid**: `sudo -n -u _wtcompare /bin/kill -0 -- -<pgid>`. Recorded here because
reusing the existing helper is the obvious move and it is wrong.

**The reading, not just the command (review NEW-11 residue).** Revision 6 gave the invocation
and stopped, which leaves the most dangerous part to an implementer's guess:

> **Non-zero exit means the group is gone — `EPERM` included. Zero means alive.**

The `EPERM` half is counter-intuitive and is why the rule has to be written down rather than
inferred. The rationale is the measured one recorded at `remote-supervisor.ts:5729-5740`, and it
transfers to the new probe because the probe is now run **as the group's own owner**:

- On Darwin, a process group whose every member is a **zombie** answers `EPERM` to
  `kill(-pgid, 0)` — for signal 0 as much as for a real signal — because an exited process no
  longer carries the credentials the permission check reads. That is measured behaviour, not an
  assumption: the comment records a `sleep` spawned detached and left unreaped answering `EPERM`
  to `kill(-pgid, 0)`, `SIGCONT` and `SIGKILL` alike while `ps` reported it `Z <defunct>`.
- Reading `EPERM` as *alive* is what makes a bounded reap unbounded: the poll is synchronous, so
  while it spins, the polling process cannot run the `SIGCHLD` handler that would turn the
  zombie into a reaped child — and the group would stay `EPERM` until the deadline **every
  time**.
- The premise that makes `EPERM` unambiguous is the one revision 6 broke and this probe
  restores: the original helper's comment ends "*every PGID this control is ever addressed at
  was created by the host beside it, so `EPERM` cannot mean 'a stranger's group' here*". Run
  from the controller against a `_wtcompare` group, that premise is **false** — it is exactly a
  stranger's group. Run **as `_wtcompare`** against a group `_wtcompare` owns, it is **true
  again**, and `EPERM` recovers its single meaning.

So the reading is inherited legitimately rather than copied. An implementer who takes
`code !== "ESRCH"` off the old helper gets it right by accident and without knowing why; one who
reads only the command plausibly writes `EPERM = alive` and reintroduces the unbounded wait.

**Pinned by `the_liveness_probe_reads_eperm_as_gone` (S8b)** — a table-driven test over the
three outcomes (zero → alive, `ESRCH` → gone, `EPERM` → gone), mutation-proven by flipping the
`EPERM` arm and showing the reap test hangs to its deadline rather than passing.

**Tests (S8), asserting absence rather than signal delivery:**

- `the_mac_supervisor_group_is_disjoint_from_the_controllers` — `handle.pgid === handle.pid` and
  `!== process.pgid`. **Renamed from `…_is_its_own_process_group_leader` (review NEW-16)**,
  which asserted something false: `handle.pid` is **sudo's** pid, so in sudo's fork mode the
  supervisor is a group *member*, not the leader. The assertion was always correct and the
  `-<pgid>` addressing sound in **both** modes — with `detached: true` sudo becomes the session
  and group leader, and a forked supervisor inherits that group, so the signal reaches it either
  way — but a later reader trusting the old name could have "fixed" a correct test toward it.
- `dropping_detached_is_refused_at_spawn` — the mutation proof for the assertion.
- `no_sigkill_is_ever_sent_to_the_sudo_pid`.
- `the_liveness_probe_reads_eperm_as_gone` — the three-outcome table above.
- S9's `the_campaign_teardown_reaps_the_wtcompare_supervisor` asserts `ps -g <handle.pgid>` is
  empty, which is now a group the controller can name without naming itself.

**Named tests, proving reaped rather than signalled:**

- **S8b** — `closing_the_control_channel_stops_the_supervisor_without_a_signal`: stage 1 alone
  ends the process, asserted by `sudo`'s exit, with no `kill` issued — **and asserting that the
  supervisor's final frame was received and its content matches the expected summary.** Without
  the second half the test passes on the broken-pipe path (review NEW-14) and the defect
  survives its own guard.
- **S8b** — `stop_supervisor_reports_not_reaped_when_the_process_survives`: mutation-proof that
  the new verdict is load-bearing.
- **S9** — `the_campaign_teardown_reaps_the_wtcompare_supervisor`: after `stopSupervisor`,
  assert **no process remains in the supervisor's process group** (`ps -g <pgid>` empty), which
  is an observation of absence, not of a signal delivered.

**If the sudoers grant did not permit stage 3** — it does, but the design states the fallback
rather than depending on the grant silently — stages 1 and 2 remain sufficient for a
cooperative supervisor, and the guarantee degrades to the supervisor's own deadline. Preflight
check 12 makes the difference visible before traffic instead of at teardown.

### 2.9(4b) The preflight

S9 adds this before any `mkdir`, in the same fail-closed slot as `CAMPAIGN_ROOT_EXISTS`
(plan 2272). Any failure is `REFUSED/STALE_OR_INVALID_STAGING` before traffic (plan 2289):

```
sudo -n -u _wtcompare true                                       # 1. the grant exists
test ! -r "$COMPARISON_MAC_SIGNING_KEY"                          # 2. the controller MUST fail
sudo -n -u _wtcompare test -r "$COMPARISON_MAC_SIGNING_KEY"      # 3. and _wtcompare must not
sudo -n -u _wtcompare test -x "$MAC_TRUST"                       # 4. traverse the trust root
sudo -n -u _wtcompare test -r "$MAC_TRUST/authority.json"        # 5. fd 3
sudo -n -u _wtcompare test -r "$MAC_TRUST/authority-digest.bin"  # 6. fd 4
sudo -n -u _wtcompare test -x "$MAC_TRUST/staging-root"          # 7. fd 6
sudo -n -u _wtcompare test -r "$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub"  # 8. fd 8
sudo -n -u _wtcompare test -w "<campaignRoot>" -a -x "<campaignRoot>"               # 9. fd 5
test -r "<campaignRoot>"                                         # 10. the reverse crossing
sudo -n -u _wtcompare test -r "$BUN_PATH" -a -x "$BUN_PATH"      # 11. row 10, §2.9(4c)
sudo -n -u _wtcompare test -x /bin/kill                          # 12. row 11 stage 3
```

**The governing rule, which check 12 violated (review NEW-12).**

> **Every preflight check must pass on a correctly configured host, and fail only for the
> defect it names.**

Nothing stated this before, and revision 5's check 12 — `sudo -n -u _wtcompare /bin/kill -0 $$`
— broke it. `$$` is the **controller's** shell pid. `kill(2)` permits even the signal-0 probe
only when the sender's real or effective uid matches the target's real or saved uid; running as
`_wtcompare` against a controller-owned process, neither holds, so the kernel returns `EPERM`
and the preflight would refuse `REFUSED/STALE_OR_INVALID_STAGING` **on a host where everything
is configured correctly** — and would do so with a symptom that reads like a missing sudoers
grant, which is the one thing check 1 has already proved.

What check 12 is actually for is narrow: *the grant covers running `/bin/kill`*. Under
`${ADMIN_USER} ALL=(_wtcompare) NOPASSWD: ALL` that is implied by check 1, so the check is
reduced to `test -x /bin/kill` — which proves the binary exists and is executable **as the
target uid**, the only part not already established, and which passes on a correct host. The
two stronger alternatives are recorded rather than chosen: `sudo … /bin/sh -c 'kill -0 $$'` is
self-targeting and would prove the uid can signal *itself*, and a spawn-then-probe would prove
it can signal *the supervisor's group* — but the second is what §2.9(4e)'s own
`the_mac_supervisor_group_is_disjoint_from_the_controllers` test does directly, at the moment it
matters, so duplicating it in a preflight buys nothing.

**Settled by execution, not by argument.** I could not run this here — the review host has no
`_wtcompare` sudo grant, so an attempt fails at the sudo layer and proves nothing about
`kill(2)`. **S0's probe runs all twelve checks on the real host and reports each one's exit
status**, so check 12's semantics are established by execution before S9 writes it. If the
probe shows `test -x /bin/kill` is not sufficient to predict stage 3, S0 says so and S9 adopts
the self-targeting form.

Check 2 is the interesting one — a controller that *can* read the key refuses to run, which is
plan 2775's own assertion moved from staging time to run time where it protects something.
Check 10 proves the controller can still read back what the supervisor will write, so assembly
cannot fail after measurement. Checks 11 and 12 cover the two non-filesystem rows.

**The preflight is the backstop for an incomplete mode change, and that is load-bearing rather
than decorative.** Checks 4-9 assert the *effect* of §2.9(4a) rather than trusting the line
list below — so if S9 edits four of the five `0700` sites and misses one, check 7 fails and the
run refuses before traffic instead of failing at spawn. That is exactly how NEW-9 was caught,
and the ten-then-twelve checks exist so it would have been caught anyway.

**The mode change has an owner (residual 2b escalated), with the line list corrected
(NEW-9).** `bin/stage-live-campaign.ts` was owned by no slice. **S9 owns that file** and
changes **five** sites, not four:

| Line | At HEAD | Becomes |
|---|---|---|
| `:702-704` | staged trust root + every `PRESTAGE_DIRS` subdir, `mode: 0o700` | `0750` group `staff` |
| `:1555` | `mkdirSync(args.campaignRoot, { mode: 0o700 })` | `2770` group `staff`, setgid |
| **`:1556`** | `mkdirSync(args.stagingRoot, { mode: 0o700 })` — **row 4's own object, omitted from revision 4's list** | `0750` group `staff` |
| **`:1560`** | `writeFileSync(path, "", { mode: 0o600 })` — revision 4 miscited this as `:1558`, which is `const path = join(...)` | `0640` group `staff` |
| `:1698-1699` | `writeFileSync(join(campaignRoot, leaf), …, { mode: 0o600 })` | `0640` group `staff` |

Phase A is unaffected: a controller-only run neither needs nor loses anything from a group it
is already in.

**How the local e2e exercises the boundary, and the seam that cannot reach production.**
The boundary is the property under test, so the e2e does not fake it:

- **Tier A — the real boundary (default).** When `sudo -n -u _wtcompare true` succeeds, the
  e2e runs the Mac supervisor as `_wtcompare` against a real 0400 key at plan 238's path,
  and §3.3's assertions 3 and 5 and the five §2.9(5) forgery tests are made for real.
- **Tier B — no grant on this host.** Every non-boundary assertion still runs, with the Mac
  supervisor under the controller uid and a key under the campaign scratch root. The two
  boundary assertions — `the_controller_account_cannot_read_the_mac_signing_key` and
  assertion 5's independence half — are **skipped with a named reason string**, never
  silently passed.

**Tier B cannot be reached by the production path**, and the reason is structural rather
than a convention: `spawnMacSupervisor` refuses a non-`_wtcompare` uid unless **both**
`COMPARISON_MAC_SUPERVISOR_UID_SEAM=1` is set **and** the resolved key path is inside the
campaign scratch root. The frozen run command sets `COMPARISON_MAC_SUPERVISOR_USER=_wtcompare`
and `COMPARISON_MAC_SIGNING_KEY=/var/db/...` (`bin/stage-live-campaign.ts:1025-1026`) and sets no
seam variable, and `upcoming-run-command.sh` is mode 0444 and immutable (plan 2684, asserted plan 2886), so the
production path fails both conditions. Guarded by a test asserting that the frozen run
command's own environment drives tier A, and that setting only one of the two conditions
refuses.

**Why not a test-only seam that lets the controller uid open the production key:** it would
make assertions 3 and 5 vacuous — the thing they assert is precisely that the controller uid
cannot. Tier B moves the *key*, not the *boundary*, and says so in the skip reason.

**(5) The security property, stated as a test.** The ruling's point is that *the controller
cannot invent, rewrite, or cross-pair any rig record*. Under §2.9 that is testable, because
the only path from a rig record to a Mac signature runs through a verification the
controller does not perform:

| Attack | What the binary does | Named test |
|---|---|---|
| controller **invents** a `rig-measure-start-ack/v1` | signature fails against the staged rig public key on the `--cohort-staged-rig-public-key-fd` descriptor; no barrier is minted | `an_invented_rig_ack_mints_no_barrier` |
| controller **rewrites** one field of a genuine rig receipt | signature fails over the mutated canonical bytes | `a_mutated_rig_receipt_mints_no_barrier` |
| controller **cross-pairs** receipt A's bytes with receipt B's signature | `signedSchema` / `signedBytesSha256` mismatch in the `rig-receipt-signature/v1` carrier | `a_cross_paired_rig_signature_mints_no_barrier` |
| controller replays **last execution's** rig acceptance | `executionSha256` ≠ the binding on the descriptor | `a_rig_receipt_from_another_execution_mints_no_barrier` |
| controller **omits** the drained receipt and asks for a barrier | `retained(...)` refuses `NotReady` | `a_barrier_without_the_drained_receipt_is_refused` |

Each of the five must be **mutation-proven**: deleting the corresponding check turns exactly
that test red. Today none of these is testable at all, because the verifier and the forger
are the same process.

**(6) Scope boundary, stated so it is not assumed away.** This slice moves the **cohort**
Mac records. Phase A's `mac-execution-grant-receipt/v1` is signed at
`server-observation-artifact.ts:1159` and `mac-measurement-admission/v1` at `:1357`, in
process, and the Phase-A `mac-*` frames have **no TS key sets at all** (`PHASE_A_MAC_*`
does not exist; the names sit in `PHASE_A_REMOTE_PAYLOAD_SCHEMAS` `:1765-1775` with no
`_FIELDS` table). Moving those needs the Phase-A Mac codec built first. Until then the Mac
private key exists in **two** places — the binary (for cohort records) and the controller
process (for the Phase-A receipt). That is a real weakening of the ruling's symmetry, it is
the price of not rewriting Phase A in this round, and §5 records it as the top residual.

### 2.10 NEW — the §3.3 registry edit for rig teardown (review finding 2)

**What is missing.** `rig-teardown-server-request/v1` and `rig-server-stopped-ack/v1` appear
only as names at `cross-supervisor-protocol.ts:1784-1785`. Verified absent:
`PHASE_A_RIG_REMOTE_SCHEMAS` has six members (`:2456-2464`); `PHASE_A_RIG_FIELDS` covers
only `rig-stop-and-capture-request/v1` and `rig-capture-complete-ack/v1` (`:2585-2602`);
`PhaseARigRemotePayloadV1` has six arms (`:2677-2684`); there is no interface, no parse arm,
and no sender. Revision 1's claim that all four capture/teardown frames were "already
registered on the TS side" read a name list as machinery and was wrong.

**The edit** — owned by **S3**, whose exclusive file is `cross-supervisor-protocol.ts`:

1. **Key sets, verbatim from plan 922-935** (registration, not widening):
   `rig-teardown-server-request/v1` = `{requestSeq: seq, executionSha256: sha256}`;
   `rig-server-stopped-ack/v1` = `{responseSeq: seq, ackRequestSeq: seq, executionSha256:
   sha256, exitCode: intOrNull, signal: stringOrNull, reaped: literalTrue}` — **three kinds
   that do not exist yet; see item 0.**

0. **Widen the shared field-spec union first (review NEW-2b).** Revision 3 asserted these
   kinds were already available, on my reading of the revision-2 review, which said the union
   "already has the kinds the two frames need". **Both were wrong**, and the review has
   withdrawn its own claim. `PhaseARigFieldSpec` (`cross-supervisor-protocol.ts:2480-2490`) is
   exactly eleven kinds — `seq | positiveInt | sha256 | sha256OrNull | base64 | base64OrNull |
   nsString | port | argv | literal{value: string} | oneOf{values}` — with **no `intOrNull`,
   no `stringOrNull`**, and `literal` comparing against `spec.value` typed `string`, so
   `reaped: true` (a **boolean**) is not expressible either. `exitCode: number | null` (plan
   929-934) needs a nullable *integer* validator that does not exist.

   S3 therefore adds three kinds to the union and three arms to `phaseARigFieldOk`
   (`:2498`+): `intOrNull`, `stringOrNull`, and `literalBoolean{value: boolean}` (a new kind
   rather than loosening `literal`'s `value` to `string | boolean`, so no existing spec's type
   changes). **This modifies the validator every Phase-A rig frame already depends on**, so it
   carries its own regression assertion — `the_eleven_existing_field_kinds_are_unchanged_by_the_widening`,
   a table-driven accept/reject case per existing kind, run before and after — which is
   distinct from `the_shared_field_spec_validates_both_tables_identically` (that one covers the
   table split, not the kind additions).
2. **Caps:** `CAPS.remotePayloadDefault` (1 MiB) for both, matching every neighbouring rig
   frame at `:1850-1870`.
3. **Membership:** both into `PHASE_A_RIG_REMOTE_SCHEMAS` (`:2457`), both interfaces, both
   arms in `parsePhaseARigRemotePayload` (`:2685`), both into `PhaseARigRemotePayloadV1`.
4. **Sender:** `CohortRigChannel.teardownServer()` in `remote-supervisor.ts`, after
   `stopAndCapture` (`:5542`) — **owned by S8**, which owns that file, consuming S3's codec.
5. **The `server-capture-ack/v1` base64 edit (§1.3, review note 14)** lands in the same
   registry commit: `child-pipe-protocol.ts`'s key set is **S1's**, and S3 publishes the
   matching `rig-capture-complete-ack/v1` shape it already has at `:2592-2601`.
6. **Hex conformance vector per frame**, Rust-pinned and TS-asserted, for
   `rig-teardown-server-request/v1`, `rig-server-stopped-ack/v1` and `server-capture-ack/v1`.

**The Phase-A Mac table S3 must create first (review N2).** Revision 2 assigned S3 "the
`mac-present-rig-observation-request/v1` and `mac-measurement-admission-issued-ack/v1` key
sets from plan 697-725" while §2.9(6) itself said `PHASE_A_MAC_*` does not exist. Verified:
both schemas are names only (`cross-supervisor-protocol.ts:1772-1773`); the only `_FIELDS`
tables are `COHORT_REMOTE_FIELDS` (keyed by `CohortRemoteSchema`) and `PHASE_A_RIG_FIELDS`
(keyed by `PhaseARigRemoteSchema`); and `CohortRemoteFieldKind` (`:1899-1905`) is exactly
`seq | sha256 | base64 | byteSize | count | literalTrue` — **no nullable kind**, so those
frames cannot be expressed in it at all. ↺ The review said six `Base64 | null` fields; the
count is **seven** on `mac-present-rig-observation-request/v1` (plan 705-714:
`rigBarrierAcceptanceBase64`, `rigBarrierAcceptanceSignatureBase64`,
`serverWarmupDrainedBase64`, `serverStartBarrierAcceptedBase64`,
`linuxRelayObservationBase64`, `rigRelayObservationReceiptBase64`,
`rigRelayObservationReceiptSignatureBase64`) plus **two** on
`mac-measurement-admission-issued-ack/v1` (plan 723-724) — **nine across the two frames**.

S3's scope therefore includes, before the two key sets:

7. **`PhaseARigFieldSpec` (`:2480-2490`) is renamed `PhaseARemoteFieldSpec`** and shared. It
   already carries every kind these frames need — `seq`, `sha256`, `base64`, `base64OrNull`,
   `literal` — so **no new field kind is invented**; the nullable kind that
   `CohortRemoteFieldKind` lacks already exists one table over. Its validator is factored
   alongside it.
8. **`PhaseAMacRemoteSchema`** (the two literals), **`PHASE_A_MAC_FIELDS`** keyed by it in
   the `PHASE_A_RIG_FIELDS` style, **two interfaces**, **`PhaseAMacRemotePayloadV1`**, and
   **`parsePhaseAMacRemotePayload`**, plus caps at `CAPS.remotePayloadDefault`.
9. **Two more hex vectors**, for the two Mac frames — **six for S3 in total**, the sixth being
   §2.13's `rig-accept-cohort-request/v1` edit.

The rename at item 7 touches `PHASE_A_RIG_FIELDS`' spec references and
`parsePhaseARigRemotePayload`, both inside S3's own file, so it stays single-owner. **S3 is
re-estimated in §4**: revision 2's 500-700 src lines covered two key sets and did not cover a
shared spec union, a new schema type, a new table, a new union, a new parser, and five
vectors.

### 2.11 Settled — `RigMeasureStartAckV1`'s key set (review finding 8)

Revision 1 escalated this whole. Most of it resolves from the plan, and the review is right
that the design should settle it rather than hand it to a slice.

**Resolved.** Plan 859-875 declares `responseSeq`/`ackRequestSeq` on
`rig-measure-start-ack/v1`, but the very next record — `RigMeasureStartedAckV1`, plan
876-883 — carries `rigMeasureStartAckBase64` and `rigMeasureStartAckSignatureBase64`. So
`rig-measure-start-ack/v1` is an **inner signed receipt carried inside a frame**, and frame
envelope fields on it are a plan defect. The Rust is right to omit them
(`secure_fs.rs:15905-15920`) and right to add the binding digests `measurementGrantSha256`,
`macExecutionGrantReceiptSha256`, `rigExecutionAcceptanceSha256`, `approvedPlanSha256`,
`approvalRecordSha256` (`:15908-15921`), which are what make the receipt joinable offline.

**The three-field residue, decided here.** `cohort-start-barrier/v1` binds
`rigMeasureStartAckSha256` (`cohort-protocol.ts:743`, `:1599`, `:1638`, `:1663`) and the
offline verifier recomputes it, so every choice is load-bearing and must be made once:

| Field | Plan | Rust | Decision |
|---|---|---|---|
| `childResponseSequence` | present | absent | **Add it.** It is the server child's own FD-4 sequence at the instant the baseline was taken, and it is the only field that joins the receipt to a position in the child-pipe stream. Without it a baseline from frame 3 and one from a replayed frame 3′ are indistinguishable in the receipt. Sourced from the rig's own `ServerChildChannel` counter, never from the child. |
| `rigSupervisorInstanceNonce` | present | absent | **Add it.** Every other rig receipt carries it (`rig-warmup-drained-receipt/v1` at `:15891`, `rig-barrier-acceptance/v1`), and its absence here is the one gap that would let a second rig instance's ack be bound into a barrier. |
| `warmupCompletionSha256` (Rust `:15919`) vs plan's `warmupCompletionAuthoritySha256` + `rigWarmupDrainedReceiptSha256` | two fields | one field | **Take the plan's two fields.** They are not synonyms: the first is the Mac's signed manifest digest, the second is the rig's own receipt over the Linux drain. Collapsing them loses the ability to show that the rig saw the Linux side drain, which is exactly what `LINUX_BASELINE` is asserting. The Rust already holds both values (`manifest.sha256` and `self.rig_warmup_drained_receipt_sha256`), so this is a rename plus one field, not new plumbing. |

**Ownership — all of it is S5-RIG's, and the TS home is `server-observation-artifact.ts`
(review F8, corrected by NEW-2).** Revision 2 split this codec across waves, which made gate 8
unsatisfiable for S2. Revision 3 fixed that but on a false premise — it said
`rig-measure-start-ack/v1` "has no TS codec anywhere" and proposed a **new**
`parseRigMeasureStartAck` in `cohort-protocol.ts`. It has one, and writing a second would be
exactly the defect the single-owner rule exists to prevent — the same class as §1.4's "all
five are the second implementation". Verified at HEAD:

- `export interface RigMeasureStartAckV1` at **`tools/compare/server-observation-artifact.ts:87-104`**,
  carrying precisely the Rust key set §2.11 analyses, `warmupCompletionSha256` included;
- built at `:1192`, read at `:599` (`baselineJson.value as RigMeasureStartAckV1`);
- `scenarios/fanout-relay.ts:3045` already names that module the owner in its own comment:
  "The record's shape is the Phase-A `RigMeasureStartAckV1` in …";
- the module is `protocolOnlyTs` in the allowlist — a protocol owner by classification.

So:

- **`server-observation-artifact.ts` is the TS owner of `rig-measure-start-ack/v1`**, and it is
  given to **S5-RIG** as a named carve-out: the interface (`:87`), the builder (`:1192`) and
  the reader (`:599`). It was owned by no slice; that gap is closed.
- **The `parseRigMeasureStartAck` in `cohort-protocol.ts` is deleted from this design.** S2's
  file is not touched by §2.11 at all.
- **S8a's two schema readers** (`remote-supervisor.ts:3608`, `:5385`) **consume the owner's
  type** rather than re-declaring it; S8a (wave 4) follows S5-RIG (wave 2), so the type it
  imports already carries the three §2.11 changes.
- **The barrier is untouched.** `cohort-start-barrier/v1` binds `rigMeasureStartAckSha256`
  (`cohort-protocol.ts:743`, `:1599`, `:1638`, `:1663`) as a digest field whose *shape* does
  not change; only what the rig puts inside the hashed record does.
- **One hex vector**, pinned in Rust and asserted against the owner's builder, inside one
  slice at one point in time.

### 2.12 F3 enumerated: the 12 §3.4 schemas with neither half (review finding 6)

`PHASE_A_CHILD_SCHEMAS` (`child-pipe-protocol.ts:295-314`) lists 18 entries: 15 lifecycle
schemas plus `server-loop-utilization/v1`, `bulk-source-completion/v1`, `bulk-sink-series/v1`.
Existing bodies: `parseChildPipeRefusal` (`:220`), `parseServerBindExecution` (`:354`),
`buildServerWarmupReady` (`:415`), `parseServerWarmupReady` (`:439`). So:

| # | Schema | Has | Needs | Slice |
|---|---|---|---|---|
| 1 | `child-pipe-refusal/v1` | parser | builder | S1 |
| 2 | `server-bind-execution/v1` | parser | builder | S1 |
| 3 | `server-ready/v1` | — | both | S1 |
| 4 | `server-warmup-start/v1` | — | both | S1 |
| 5 | `server-warmup-ready/v1` | **both** | — | — |
| 6 | `server-warmup-drain-and-reset/v1` | — | both | S1 |
| 7 | `server-warmup-drained/v1` | — | both | S1 |
| 8 | `server-measure-start/v1` | — | both | S1 |
| 9 | `server-measure-start-ack/v1` | — | both | S1 |
| 10 | `server-present-start-barrier/v1` | — | both | S1 |
| 11 | `server-start-barrier-accepted/v1` | — | both | S1 |
| 12 | `server-stop-and-capture/v1` | — | both | S1 |
| 13 | `server-capture-ack/v1` | — | both, **with the §1.3 base64 key set** | S1 |
| 14 | `server-teardown/v1` | — | both | S1 |
| 15 | `server-stopped/v1` | — | both | S1 |

**14 schemas need work; 26 codec bodies.** Revision 1 said ten and estimated ~700 src LOC.
S1 is re-scoped in §4.

---

### 2.13 NEW — the rig has the identical lifetime mismatch, and it breaks this e2e (review NEW-8)

Revision 4 recorded this as residual 6, "not mine to fix", so round five would not find it as
new. **That classification was wrong on urgency**: the defect breaks mandate assertion 1 in
this design's own e2e, at execution 2 of 4. Promoted here, owned by **S5-RIG**.

**The facts, verified at HEAD.** `spawnRigSupervisor` has exactly one call site
(`bin/compare-controller.ts:2471`), so the rig process is campaign-scoped — the same finding
NEW-3 made about the Mac. But round two gave it two **per-execution** descriptors, and
`install_production_cohort_runtime` reads them **once at process start**:
`read_all_from_fd(descriptors.acceptance_fd, …)` and
`read_all_from_fd(descriptors.acceptance_signature_fd, …)` at
`crates/native/src/bin/comparison-supervisor.rs:1465-1471`, feeding
`rig::read_rig_execution_acceptance` at `:1473`, whose `inputs` become the binding every
`RigCohortSession` checks `executionSha256` against.

§3.2 runs **four executions** (one unsealed warmup + one measured, per arm). One rig process
holding execution 1's acceptance refuses executions 2, 3 and 4 on the binding check — so two
*sealed* arms are unreachable and §3.4's "Yes" for assertion 1 was wrong.

**The fix is symmetric with NEW-3, but it is not free the way the Mac's was.** On the Mac,
`mac-open-cohort-request/v1` already carried every per-execution input, so two descriptors
were simply deleted. The rig's equivalent frame does **not**:
`rig-accept-cohort-request/v1`'s frozen key set is
`{requestSeq, executionSha256, cohortGrantBase64, cohortGrantSignatureBase64}` — plan 775-781,
implemented identically at `cross-supervisor-protocol.ts:2046-2051` — with **no acceptance
field**. So this needs a **§3.3 registry edit**, and it is recorded as one:

> `rig-accept-cohort-request/v1` gains `rigExecutionAcceptanceBase64: Base64` and
> `rigExecutionAcceptanceSignatureBase64: Base64`.

Justified on the same ground as the two edits §1.2 already records: the alternative is a rig
that can serve exactly one execution per campaign, which contradicts §5's campaign-scoped
supervisor and plan 2216's one-warmup-plus-measured schedule. The two field names and types
are copied verbatim from `mac-present-rig-execution-acceptance-request/v1` (plan 566-572), so
the edit introduces no new shape — it moves an existing pair onto the frame that needs it.

**Consequences:**

- the rig's descriptor set drops **four → two** (`--cohort-signing-key-fd`,
  `--cohort-role-root-fd`), exactly as NEW-3 left the Mac at two;
- `install_production_cohort_runtime` no longer reads an acceptance at startup; the binding is
  established **per execution** by `accept_cohort` (`secure_fs.rs:15564`), which verifies the
  acceptance against the key derived from the private half on the descriptor — the same
  derivation `.scratch/b35r2-notes/rig-install.md` §2 established, at a later moment;
- a per-execution `RigCohortSession` keyed by `executionSha256`, mirroring the Mac's;
- **this is a third registry edit** and §1.2's three-way status list gains it.

**Named tests (S5-RIG):** `one_rig_process_serves_four_executions_with_distinct_bindings`,
beside the Mac's `one_process_serves_four_executions_with_distinct_sessions`; and
`an_acceptance_for_another_execution_is_refused_at_accept_cohort`, mutation-proven.

---

## 3. The e2e definition of done

### 3.1 Local topology

One machine, all real processes, loopback instead of `10.99.0.2`:

- **Mac supervisor** — the real binary via `spawnMacSupervisor`
  (`bin/compare-controller.ts:2433`), spawned once per campaign under
  `sudo -n -u _wtcompare` with the two campaign-scoped cohort descriptors of §2.9(1);
- **rig** — the real `target/release/comparison-supervisor` (darwin build) booted the way the
  rig wrapper boots it, with `--cohort-signing-key-fd`,
  `--cohort-execution-acceptance-fd`, `--cohort-execution-acceptance-signature-fd`,
  `--cohort-role-root-fd`;
- **server child** — a real `bun tools/compare/server.ts --mode=fanout-cohort`, argv from
  `stagedServerLaunchArgv` (`server.ts:122`), fork/exec'd **by the rig** into its own process
  group, FD 3/4 real;
- **role children** — real `bun tools/compare/bin/fanout-role.ts` processes spawned by
  `createMacFanoutRoleChildHost` (`remote-supervisor.ts:6156`), each with a real unlinked
  read-only FD 5 token bundle;
- **controller** — `dispatchArmRepetition` with the production provider and **no** executor
  override, as the suite does today;
- **both arms** — `ws` and `wt`, self-signed TLS, `wt-compare.local`.

### 3.2 The rung: `chat-fanout/subscribers-1000`

**Revision 1's premise was false.** `FANOUT_COHORT_CELL_BY_ID` (`evidence.ts:152-160`) admits
**six** cells, not three — I read to line 157 and stopped one line before the chat entries:

```
"ticker-fanout/rate-10000": "ticker 10k"      "chat-fanout/subscribers-1000":  "chat 1k"
"ticker-fanout/rate-50000": "ticker 50k"      "chat-fanout/subscribers-5000":  "chat 5k"
"ticker-fanout/rate-100000": "ticker 100k"    "chat-fanout/subscribers-10000": "chat 10k"
```

**The measurement that settles it** (review finding 4, adopted rather than re-derived): a
*strict upper bound* — raw `Bun.serve` WebSocket fanout on plain loopback, no TLS, no relay
ordering, no envelope, no counters, no Merkle validation — 1 publisher to 100 subscriber
sockets sustained **195,387 deliveries/s**, and offered only 1,954 of a targeted 10,000
ingress/s. The cohort relay is strictly slower on every axis.

| Cell | pubs | subs | sessions | ingress | expanded deliveries | deliveries/s over the window | vs 195,387/s bound |
|---|---:|---:|---:|---:|---:|---:|---|
| `ticker 10k` | 1 | 100 | 101 | 100,000 | 10,000,000 (10 s) | 1,000,000 | **5.1× over** — unreachable |
| `chat 1k` | 10 | 1,000 | 1,010 | 300 | 300,000 (30 s) | 10,000 | **19.5× under** |

**Decision: the e2e runs `chat-fanout/subscribers-1000`.** It is frozen, already admitted,
needs no contract edit, and sits an order of magnitude inside a measured ceiling.
**S0 is deleted** and the FULL/SHORT branch with it — there is nothing left to branch on.

**Exact topology — what is frozen** (`cohort-protocol.ts:5274-5281`): **10 publishers, 8
subscriber workers, 1,000 subscribers, 1,010 sessions, 300 measured ingress, 300,000 expanded
deliveries**; and `readinessDeadlineMs: 90,000` (plan 1424, per-cell). **18 role children**
per execution (10 publisher + 8 worker), plus the server child, plus two supervisors.

**What is chosen, not frozen (review N3).** Revision 2 listed `messageBytes: 128` and
`measuredDurationMs: 30,000` as if they came from `:5274-5281`. They do not — that range is
the cardinality row, which contains neither. Both are open unions on the grant:
`measuredDurationMs: 10000 | 30000` (`cohort-protocol.ts:681`) and
`messageBytes: 100 | 128` (`:683`), matching plan 1289 and 1291, and **nothing in the repo
chooses either per cell**.

| Parameter | Chosen | Basis | Owner |
|---|---|---|---|
| `messageBytes` | **128** | plan 1428: "exactly 100 bytes ticker or 128 bytes chat" — determined by the cell family, so this is a derivation the table should carry rather than a free choice | **S2** |
| `measuredDurationMs` | **30,000** (`windowCount: 30`) | genuinely free between the two legal values. 30 s gives the §4.5 rate series 30 windows instead of 10, which is the shape the conservation and mean-denominator checks are written against; at 10 s the rung is still 6.5× under the measured ceiling, so this is a fidelity choice, not a feasibility one | **S2** |

**They go in a separate table, not in `COHORT_CELL_CARDINALITIES` (review NEW-4).** Revision 3
added them as two columns there. That constant's own comment (`cohort-protocol.ts:5245`) reads
"The exact §4.5 table; nothing here is derived at runtime from a knob", and plan §4.5's table
(2144-2150) has exactly seven columns — cell, publishers, workers, subscribers, sessions,
measured ingress, expanded deliveries — and contains neither field. Adding them would be a
**contract narrowing dressed as a column addition**, and would silently make the constant stop
being the table its comment claims.

**S2 creates `COHORT_CELL_GRANT_PARAMETERS`** — same file, same owner, same slice, same test —
a second frozen table keyed by `CohortCellId` carrying `measuredDurationMs` and `messageBytes`
for all six cells, which both languages read and S5-MAC-RS mints from.
`COHORT_CELL_CARDINALITIES` is left byte-identical and its comment stays true.

**Chosen over the alternative of recording a registry edit**, because there is nothing to
edit: plan 1289/1291 leave the two grant fields as open unions and the plan nowhere says a
cell must not pin its own value. A separate table *selects* within the frozen unions for this
campaign's cells; it does not narrow `CohortGrantV1`, which keeps both unions. Had the columns
gone into the §4.5 constant, the narrowing would have been real and §1.2's three-way status
list would have needed a third entry. This way it needs none, and the Rust conformance vector
S2 already owns is extended to cover the new table.

**The rung and the pilot are different things, and this design does not conflate them
(review N3).** Plan §9.6 line 3511 fixes the B5 pilot as `CELLS=ticker-fanout/rate-10000`
with `EXPECTED_PASS=2`. Chat 1k is **not** the pilot cell. The local e2e at chat 1k proves
that the *machinery* — lifecycle, both signers, both signature graphs, seal, index — produces
a correct pilot-shaped result; §9.6's ticker-10k run on the real rig remains the plan's
proof, and it is a rig-only gate this design does not attempt to move. §3.3 and §3.4 say so
at each assertion.

**Timing budget, per execution:**

| Phase | Budget | Basis |
|---|---:|---|
| spawn + bind + role-child spawn | 10 s | 20 processes |
| ramp (1,010 permits at 500/s, ≤200 in flight) | ~2 s nominal, 90 s deadline | plan 1776, `readinessDeadlineMs` |
| in-repetition warmup | 5 s | plan 1287 |
| measured window | 30 s | `measuredDurationMs` |
| drain | ≤ 10 s | `drainDeadlineMs` |
| capture + join + seal + teardown | 10 s | — |
| **per execution, nominal / worst** | **~67 s / ~155 s** | |

Pilot purpose schedules one unsealed warmup + one measured per arm (plan 2216), so
**4 executions**: ~4.5 min nominal, ~10.5 min worst case.

**Timeouts (review N4).** Revision 2 said "the file's timeout is 900,000 ms and each `it`
that drives a full execution 240,000 ms" — inverted. `PROCESS_TEST_TIMEOUT_MS = 900_000`
(`fanout-production-e2e.test.ts:163`) is already the **per-test** value, passed as `it`'s
third argument (e.g. `:392`), and 240,000 would *lower* it below the 155 s worst case plus a
cold Rust build. **Execution-driving tests keep `PROCESS_TEST_TIMEOUT_MS`; the 240,000 figure
is dropped.** Gate 2's `bun test --timeout 30000` is not in conflict: a per-test third
argument overrides the CLI default, which is why this file passes today.

**The remaining unknown is session count, not delivery rate.** 1,010 concurrent loopback
sessions (WS, then WT/QUIC) plus 20 processes on one Mac is the open question. **S0 is
replaced by a session-count probe** in the same slot: bring up 1,010 loopback sessions on
each transport against the real relay, hold them 30 s, record peak RSS, FD count and accept
latency. If WT cannot hold 1,010 QUIC sessions on this host, the fallback is stated in
advance and is not a rung change: run the ws arm locally at `chat 1k` and record the wt arm
as a rig-only assertion, naming which of the four mandate assertions that costs.

### 3.3 The assertion list

The existing 14 tests stay. Added, in the file's naming convention:

**Lifecycle:**

1. `the_child_serves_the_cohort_relay_and_a_role_peer_registers` — a real role child
   completes `fanout-wire/v1` register→accept against the real server child. **Replaces**
   the negative at `:423`, which is deleted the day this goes green.
2. `the_server_child_holds_no_signing_key_and_mints_no_rig_record`.
3. `the_controller_process_holds_no_mac_cohort_private_key` — the §2.9 symmetry, asserted on
   the controller's own module surface.
3b. `the_controller_account_cannot_read_the_mac_signing_key` — plan 238's `test -r` assertion
   at run time, **tier A only** (§2.9(4)); skipped with a named reason under tier B.
3c. `the_frozen_run_command_environment_drives_tier_a_and_the_seam_needs_both_conditions` —
   the seam cannot be reached from `upcoming-run-command.sh`.
4. `every_rig_receipt_is_signed_by_the_rig_and_verifies_against_the_staged_rig_public_key` —
   all seven `RIG_SIGNED_SCHEMAS`.
5. `every_mac_receipt_is_signed_by_the_mac_binary_and_verifies_against_the_staged_mac_public_key`.
6. `the_snapshot_and_relay_observation_digests_the_rig_signed_are_the_bytes_the_child_sent` —
   the §1.3 base64 rule over the real capture ack.
7. `the_rig_answers_a_refused_cohort_transition_with_a_terminal_remote_supervisor_refusal`.
8. `the_child_pipe_sequences_are_zero_through_six_in_each_direction`.
9. The five §2.9(5) forgery tests, driven end to end rather than in the Rust unit suite:
   `an_invented_rig_ack_mints_no_barrier` and its four siblings.

**Mandate assertion 1** — `both_arms_seal_pass`.
**Mandate assertion 2** — `verify_run_artifact_passes_over_a_reconstructed_cohort_observation_evidence`:
`verifyRunArtifact` over the sealed artifact with `CohortObservationEvidenceV1` reconstructed
from the export ack's retained bytes, not from controller memory.
**Mandate assertion 3** — `both_issuer_signature_graphs_verify`: the Mac graph
(grant → epoch → manifest → barrier → admission receipt) and the rig graph
(execution acceptance → cohort acceptance → drained receipt → measure-start ack → barrier
acceptance → snapshot receipt → relay observation receipt), each against the staged public
key for its issuer, no cross-issuer edge accepted.
**Mandate assertion 4** — `the_index_is_the_pilot_shape_at_the_machinery_rung`:
`verifyCampaignIndex` over 2 PASS / 0 promotable / 0 flats / 2 sealed,
`executionPurpose: "pilot"`. The two negatives at `:1075` and `:1095` invert to positives and
the negatives are **deleted**, not left alongside. **The test name carries the caveat on
purpose (review N3):** this run's cell is `chat-fanout/subscribers-1000`, while §9.6 line
3511 fixes the B5 pilot at `CELLS=ticker-fanout/rate-10000`. What is proved locally is that
the index machinery produces the pilot shape; that §9.6's own run does so on the rig is not
proved here and the file says so in a comment naming plan line 3511.

**Mutation proofs:** (i) replacing the cohort routing condition in `dispatchArmRepetition`
with `if (true)` still turns tests red (round two's proof); (ii) deleting the
`serveFanoutCohortRelay` call from `server.ts`'s bind callback turns assertion 1 red without
turning any refusal-boundary test red; (iii) each of the five §2.9(5) checks, deleted one at
a time, turns exactly its own test red.

### 3.4 Per-assertion reachability (review finding 9)

Revision 1 left this implicit and the review is right that it is where round four's
rediscovery would happen. Each mandate assertion is walked to the slices that make it true.

| Assertion | What blocked it in revision 1 | Slices that close it | Reachable after this design? |
|---|---|---|---|
| **1** two sealed PASS arms | (i) the rung — 5.1× over a measured ceiling; (ii) no Mac signer outside the controller, so nothing mints grant/epoch/barrier/admission for a seal; **(iii) added in revision 5** — one campaign-scoped rig process holding execution 1's acceptance refuses executions 2-4, so two *sealed* arms were unreachable even with (i) and (ii) fixed (§2.13) | (i) **§3.2** rung → `chat 1k`, 19.5× under the ceiling; (ii) **S5-MAC-RS** + **S8** build the Mac signer; (iii) **S6** makes the relay serve; (iv) **S1** gives the lifecycle its codecs; (v) **S5-RIG** closes F1/F2 so barrier and capture exist; (vi) **S9** supplies the lease; **(vii) S5-RIG closes §2.13 via the §3.3 registry edit, and S3 registers the two new fields** | **Yes**, conditional on the §3.2 session-count probe for the wt arm. Revision 4 answered "Yes" here while (iii) was still open and filed as a round-five note; that answer was wrong. |
| **2** `verifyRunArtifact` over reconstructed `CohortObservationEvidenceV1` | blocked behind assertion 1's seal | same chain, plus **S9**'s `sealCohortArmRepetition` wiring at `compare-controller.ts:2721` | **Yes**, once 1 is |
| **3** both issuer signature graphs verify | rig graph reachable after S5-RIG; **Mac graph had no defined signer** | **S5-MAC-RS** defines it; the graph is verified inside the binary before admission is minted (§2.9(2) last row) and re-verified offline by the test against the staged public keys | **Yes** |
| **4** `verifyCampaignIndex` pilot shape | additionally: `TEARDOWN` had no carrier frame, so the lifecycle never reached the counters §2.2(c) named | **S3** adds the teardown codec, **S8** the sender, **S5-RIG** the dispatch arm; §2.2(c) is corrected to take `admissionCounters` from the existing in-process counter, and §5 records the Phase-A asymmetry | **Yes** |

**All four are conditional on the §2.9(4) uid boundary.** Assertions 3 and 5 assert two
independent issuers; under tier B (no `sudo -n -u _wtcompare` grant on the host) the Mac
supervisor runs as the controller uid and the two boundary assertions are skipped with a
named reason. Tier A is the default and the only configuration in which mandate assertion 3
is fully made.

**What this design proves locally, and what it does not.** All four assertions are made at
`chat-fanout/subscribers-1000`. §9.6's pilot (`CELLS=ticker-fanout/rate-10000`,
`EXPECTED_PASS=2`, plan 3511) runs on the real rig and is **not** attempted here: the local
run proves the machinery is correct, the pilot proves the plan's number. Nothing in §3.3
claims otherwise, and assertion 4's test name says so.

**Residuals that would still go red, stated with their invariant** (the discipline revision 1
applied only to assertion 1):

- If the session-count probe shows 1,010 QUIC sessions are not affordable, assertion 1's
  **wt** half becomes a rig-only assertion. The invariant that would turn it green locally:
  `sessionsAccepted == 1010 && sessionsActivePeak == 1010` on the wt arm's
  `linux-relay-observation/v1`.
- The Mac private key remains in two processes until the Phase-A Mac codec exists (§2.9(6)).
  The invariant that would close it: no non-test call to `signMacReceipt` outside
  `crates/native`.
- Under tier B, assertions 3 and 5 are partial. The invariant that would close it:
  `sudo -n -u _wtcompare test -r "$COMPARISON_MAC_SIGNING_KEY"` succeeding while the same
  `test -r` fails for the controller account.

---

## 4. Implementation slicing

**Cross-language single-owner rule (binding).** Any codec with a Rust half and a TS half has
exactly one owning slice. That slice edits both halves and lands **one hex conformance vector
per frame**, Rust-pinned as a `const` and TS-asserted against a literal, in the shape round
two used (`TS_ACCEPT_COHORT_FRAME_HEX` / `RUST_PINNED_FRAME_HEX`). No slice edits a codec it
does not own. **A codec change with no conformance vector is not done.**

**File ownership is disjoint within a wave**, and now includes the test files each slice
breaks.

### Wave 1 — parallel, four slices

| Slice | Owns (exclusively) | Does | Named tests | LOC src / test |
|---|---|---|---|---|
| **S0 host probe** *(replaces the deleted rung probe)* | `.scratch/` only — **writes no tracked file** | (i) brings up 1,010 loopback sessions on ws and on wt against the real relay, holds 30 s, records peak RSS / FD count / accept latency, and decides whether the wt arm is local or rig-only (§3.2); (ii) runs **all twelve** §2.9(4b) preflight checks against a scratch staging tree, **reporting each one's exit status individually**, to determine tier A or tier B and to **settle check 12's semantics by execution** (review NEW-12) before S9 writes it; reports which of §2.9(4a)'s sixteen crossing objects the installed host already satisfies | n/a — output is two numbers, a tier, and a twelve-row pass/fail with exit statuses | 0 / ~400 throwaway |
| **S1 child-pipe codec** | `tools/compare/child-pipe-protocol.ts`, **new** `tools/compare/child-pipe-protocol.test.ts` | §2.12's 14 schemas / 26 bodies; per-direction sequence, cap and state machine; `server-capture-ack/v1` with the §1.3 **base64** key set; the hex vectors S5-RIG and S6 assert against | one key-set test per schema; `the_sequences_are_independent_per_direction`; `a_frame_over_64_kib_is_refused`; `the_capture_ack_carries_base64_not_nested_records` | **1,900-2,400 / 1,200-1,500** |
| **S2 §4.1 grant codec** | `tools/compare/cohort-protocol.ts`; the `parse_shards` region of `secure_fs.rs` (`:12531-12574`); `crates/native/tests/cohort_protocol.rs`; `tools/compare/cohort-protocol.test.ts`; `tools/compare/fanout-promotion.test.ts`; **`fanout-supervisor-integration.test.ts` line 210 only** | §2.3 in full: grant-total bound, positional `workerIndex`/`residue`, 8-entry check, the four fixture sites it owns, `RUST_PINNED_TICKER10K_GRANT_HEX`; §3.2's **new `COHORT_CELL_GRANT_PARAMETERS` table** (review NEW-4) — `COHORT_CELL_CARDINALITIES` is left byte-identical | `the_shard_bound_is_the_grants_subscriber_total`; `a_shard_bound_to_its_own_count_is_refused_on_both_sides`; `a_reordered_shard_array_is_refused_on_both_sides`; `a_seven_shard_grant_is_refused_on_both_sides`; `every_cell_pins_its_own_duration_and_payload_size`; `the_exact_4_5_table_is_unchanged` | **400-600 / 650-850** |
| **S3 remote registry** | `tools/compare/cross-supervisor-protocol.ts`, `tools/compare/cross-supervisor-protocol.test.ts` | §2.10 **item 0 (review NEW-2b)**: widen the shared field-spec union with `intOrNull`, `stringOrNull`, `literalBoolean` and three arms in `phaseARigFieldOk` (`:2498`), with a regression assertion over the existing eleven kinds; items 1-3 and 6: the two teardown key sets, caps, `PHASE_A_RIG_*` membership, interfaces, parse arms, union; items 7-9: rename `PhaseARigFieldSpec` → shared `PhaseARemoteFieldSpec`, then `PhaseAMacRemoteSchema`, `PHASE_A_MAC_FIELDS`, two interfaces, `PhaseAMacRemotePayloadV1`, `parsePhaseAMacRemotePayload`, caps (plan 697-725, nine `Base64\|null` fields); **§2.13's §3.3 registry edit** — `rig-accept-cohort-request/v1` gains `rigExecutionAcceptanceBase64` + `rigExecutionAcceptanceSignatureBase64` in `COHORT_REMOTE_FIELDS` (`:2046-2051`) and its interface; **six** hex vectors | `the_eleven_existing_field_kinds_are_unchanged_by_the_widening`; `the_teardown_frames_round_trip_exactly`; `the_pinned_teardown_frame_is_the_one_the_rust_dispatch_matches`; `a_null_base64_field_is_accepted_only_where_the_plan_allows_it`; `the_shared_field_spec_validates_both_tables_identically` | **1,300-1,750 / 1,000-1,350** |

> **S2/S4 coordination, corrected (review F5).** Revision 2 gave the
> `fanout-supervisor-integration.test.ts:210` fixture edit to **S4 in wave 2** while S2's rule
> landed in wave 1 — leaving the suite red between them and S2's own gate 2 unsatisfiable.
> **S2 now owns exactly line 210**; S4 owns every other line of that 5,600-line file in wave 2.
> Verified this is the only shard-local fixture there (`:5541` already uses the grant total).
> The two slices are in different waves, so the shared file is never edited concurrently.

### Wave 2 — parallel, two slices

| Slice | Owns (exclusively) | Does | Named tests | LOC src / test |
|---|---|---|---|---|
| **S4 Linux observer** | `tools/compare/scenarios/fanout-relay.ts`, `tools/compare/fanout-relay.test.ts`, **`tools/compare/fanout-supervisor-integration.test.ts`** (review 7 — it is the only consumer of `FanoutLinuxAuthorityConfig` outside the module, at `:131`, `:1449`/`:1451`, `:1741`, `:3470`, `:4736`) | removes `privatePkcs8Der` from `FanoutLinuxRigIdentity` (`:2282`) and deletes the five rig-record mints (`:2543`, `:2997`, `:3083`, `:3222`, `:3406`) per §1.4; `observe` (`:3373`) reduces to `buildLinuxRelayObservation` (`:1553`); adds the `server-loop-utilization/v1` builder; §2.4's `tokenFor`; §2.3(4)'s grant-total write at `:1992` and the `subscriberCount < 8` refusal; fixes the `:210` fixture | `the_linux_authority_holds_no_signing_key`; `production_tokens_are_not_derivable_from_the_grant`; `a_cohort_below_eight_subscribers_is_refused` | **−700 / +750-950 src, 900-1,200 test** |
| **S5-RIG Rust rig** | `crates/native/src/secure_fs.rs` (`cohort::rig` only), `crates/native/src/bin/comparison-supervisor.rs` (rig arms), `crates/native/tests/rig_cohort_runtime.rs`, **plus `tools/compare/server-observation-artifact.ts` — the TS owner of `rig-measure-start-ack/v1` (interface `:87`, builder `:1192`, reader `:599`), previously owned by no slice** (review F8/NEW-2) | F1: capture + teardown into `COHORT_REQUEST_KINDS` (`:14771`) and `ack_kind_for` (`:14792`); `stop_and_capture` / `teardown_server`; `rig-server-snapshot-receipt/v1` + `rig-relay-observation-receipt/v1` per §1.3; extends `ServerChildChannel` (`:14962`) and adds the **real** FD 3/4 implementation beside `AbsentServerChild` (`:14993`); §2.7's refusal; §2.8's `mark_ready_from_linux`; **all of §2.11 — both halves and its hex vector, in one slice**; **§2.13 (review NEW-8): drop the two per-execution acceptance descriptors from `install_production_cohort_runtime` (`comparison-supervisor.rs:1465-1473`), move the binding into `accept_cohort` (`secure_fs.rs:15564`) per execution, per-execution `RigCohortSession` keyed by `executionSha256`**; the two reading-agnostic shard fixtures in its own file (`comparison-supervisor.rs:2885`, `:3473`) | `the_capture_receipts_bind_the_bytes_the_child_sent`; `a_refused_cohort_transition_is_a_terminal_remote_supervisor_refusal`; `readiness_comes_from_the_childs_warmup_end_counts`; `the_pinned_capture_frame_is_the_one_the_ts_codec_produces`; `the_measure_start_ack_key_set_is_the_same_on_both_sides`; `one_rig_process_serves_four_executions_with_distinct_bindings`; `an_acceptance_for_another_execution_is_refused_at_accept_cohort` | **3,000-3,800 / 1,600-2,100** |

### Wave 3 — parallel, three slices

| Slice | Owns (exclusively) | Does | Named tests | LOC src / test |
|---|---|---|---|---|
| **S5-MAC-RS Rust Mac cohort runtime** | `crates/native/src/secure_fs.rs` (**new** `cohort::mac` module only), `crates/native/src/bin/comparison-supervisor.rs` (**new** mac arms + descriptor install), **new** `crates/native/tests/mac_cohort_runtime.rs`, `crates/native/tests/fanout_supervisor.rs` (residual 5) | §2.9 items 1, 2 and 5: **two** campaign-scoped all-or-none descriptors (review NEW-3), a per-execution `MacCohortSession` keyed by `executionSha256`, the eight request→ack transitions, verification-before-minting, `remote-supervisor-refusal/v1` refusals, the five forgery tests, and the five-of-seven **restart-refuses** invariant | the five §2.9(5) tests; `a_restarted_mac_supervisor_refuses_to_admit_on_five_of_seven`; `the_mac_cohort_install_descriptors_are_all_or_none_and_all_distinct`; `the_public_half_of_the_mac_signing_key_is_derived_and_not_supplied`; `one_process_serves_four_executions_with_distinct_sessions` | **3,000-3,800 / 1,700-2,250** — *the least constrained number in this table: `cohort::rig` (`secure_fs.rs:14721`→~`:16300`) is ~1,600 lines, so this estimates its sibling at ~2×, justified by eight transitions against six, per-execution session lifecycle, token minting and Merkle recomputation, but it is an anchor-free extrapolation* |
| **S6 server child** | `tools/compare/server.ts`, **new** `tools/compare/server-fanout-cohort.test.ts` | §2.1 in full: `new FanoutLinuxAuthority(...)` and `serveFanoutCohortRelay` at the bind point (`:1382`), keyless authority, the FD 3/4 lifecycle loop replacing the exit at `:1428-1435`, §3.5 deadlines, `child-pipe-refusal/v1` on every failure path; asserts S1's hex vectors | one test per R→C frame; `the_two_existing_fail_closed_orders_are_unchanged` | **1,300-1,700 / 1,000-1,300** |
| **S8b supervisor process lifecycle** | `tools/compare/remote-supervisor.ts` — **the process region only**: `buildRigSupervisorWrapperScript` (`:466`), `SupervisorHandle` (`:682`), `wrapNodeChild` (`:717`), `spawnMacSupervisor` (`:787`), `spawnRigSupervisor` (`:987`), `stopSupervisor` (`:1111`); **new** `tools/compare/mac-supervisor-spawn.test.ts` | **§2.9(4)'s spawn form** — `spawnMacSupervisor` gains the two cohort descriptor slots (fds 7-8), `buildRigSupervisorWrapperScript` gains their `exec N<` lines, and `nodeSpawn("bash", [scriptPath])` at `:843` becomes `nodeSpawn("/usr/bin/sudo", ["-n","-u",USER,"/bin/bash","-c",wrapper.script])` — the temp file at `:827-832` and the three `unlinkSync` paths at `:854`/`:879`/`:891` are deleted; **§2.9(4a) rows 13-15** (`umask 007`, `cd /`, `/bin/cat`) and **row 10** (`export COMPARISON_SUPERVISOR_BUN_PATH=`) in the script text; **§2.9(4d)** — `stopSupervisor` (`:1111-1152`) rebuilt as the three stages with stage 1 a **half-close**, `closeOwnedFds()` **after** stage 2, a real `reaped` verdict, and `proc.kill("SIGKILL")` at `:1145` **deleted**; **§2.9(4e)** — `detached: true`, `pgid` on `SupervisorHandle`, the `pgid !== process.pgid` spawn assertion, and its own uid-correct liveness probe; **§2.13's** two dropped rig descriptors in `spawnRigSupervisor` | `the_wrapper_never_becomes_a_filesystem_object`; `the_spawn_argv_carries_paths_and_no_key_material`; `the_supervisor_starts_under_sudo_with_an_emptied_parent_environment`; `closing_the_control_channel_stops_the_supervisor_without_a_signal` (**asserts the final frame was received and content-checked**); `stop_supervisor_reports_not_reaped_when_the_process_survives`; `the_mac_supervisor_group_is_disjoint_from_the_controllers`; `dropping_detached_is_refused_at_spawn`; `no_sigkill_is_ever_sent_to_the_sudo_pid`; `the_liveness_probe_reads_eperm_as_gone`; `the_supervisor_creates_group_writable_files` | **900-1,200 / 700-900** |

> **S5-RIG / S5-MAC-RS share two Rust files.** They are in different waves and their regions
> are disjoint (`cohort::rig` vs a new `cohort::mac`; rig dispatch arms vs mac dispatch arms).
> Wave 3 starts only after wave 2 lands, so the sharing is sequential, never concurrent.

### Wave 4 — one slice

> **The S8 split (review, "the busiest slice").** S8 had absorbed something from every revision
> since 3 — 2,550-3,300 src and twelve named tests across the spawn form, rows 10 and 13-15,
> both shutdown sections and `MacCohortChannel`. It splits along a **clean seam by named
> symbol**: **S8b** owns the *process* region (`:466`-`:1152` — wrapper, handle, spawn, stop),
> **S8a** owns the *cohort* region (`:2714`+ — supervisor class, channels, host, minter).
> Nothing in either region calls into the other; S8b's only contact with S8a's region is the
> deliberate **non**-edit of `processGroupAlive` (`:5742`).
>
> They are in **different waves** — S8b in wave 3, S8a in wave 4 — so the shared file is never
> held concurrently, the same sequencing S2→S4 uses for `fanout-supervisor-integration.test.ts`
> and S5-RIG→S5-MAC-RS use for `secure_fs.rs`. S8b lands first because S9 (wave 5) and S10
> (wave 6) both depend on the spawn form, and because §2.13's rig-descriptor change is in its
> region. Test files are disjoint: S8a keeps `fanout-executor.test.ts`; S8b takes a new
> `mac-supervisor-spawn.test.ts`, which needs no allowlist line (gate item 7).

| Slice | Owns (exclusively) | Does | Named tests | LOC src / test |
|---|---|---|---|---|
| **S8a Mac + rig TS cohort channels** | `tools/compare/remote-supervisor.ts` — **the cohort region only** (`MacFanoutSupervisor` `:2714`, `CohortRigChannel` `:4686`+, `createMacFanoutProcessControl` `:5757`, `createMacFanoutRoleChildHost` `:6156`, `createMacProductionCohortMinter` `:6436`, plus the new `MacCohortChannel` and `createMacSignedRoleChildFrameSource`); `tools/compare/fanout-executor.test.ts` | §2.9(3): `MacCohortChannel`, and `MacFanoutSupervisor` loses `macKeys` (`:2678`) and `macSign` (`:2813-2822`) and becomes a client at its ten mint/present sites; §2.10(4): `CohortRigChannel.teardownServer()`; §2.5's `createMacSignedRoleChildFrameSource`. **Does not touch `processGroupAlive` (`:5742`)** — S8b writes its own uid-correct probe beside `stopSupervisor` rather than editing this one, so the role-child path keeps the reading that is correct for it | `the_mac_supervisor_class_holds_no_private_key`; `every_mac_signed_frame_echoes_the_binarys_exact_bytes`; `a_reencoded_epoch_is_refused_by_the_role_child` | **1,800-2,300 / 1,150-1,450** |

### Wave 5 — one slice

| Slice | Owns (exclusively) | Does | LOC src / test |
|---|---|---|---|
| **S9 controller lease + spawn plumbing + staging modes** | `tools/compare/bin/compare-controller.ts`, **`tools/compare/bin/stage-live-campaign.ts`** (previously owned by no slice) | §2.2 (`createProductionCohortArmMaterial`, `createProductionCohortArmLeaseFactory`, the `realRunBody` wiring at `:2721`); §2.9(4)'s **two**-descriptor plumbing at `:2433-2450` (down from four — review NEW-3) and the campaign-scoped handle at `:2457`; §2.9(4b)'s **twelve-check uid preflight** refusing `REFUSED/STALE_OR_INVALID_STAGING`; the two-condition tier-B seam guard; §2.9(4a)'s mode changes in `bin/stage-live-campaign.ts` at **`:702-704`, `:1555`, `:1556`, `:1560`, `:1698-1699`** (five sites — review NEW-9; group `staff`, `0750` / `2770` setgid / `0640`); and the teardown call sites at `:2506`/`:2509` consuming §2.9(4d)'s `reaped` verdict, with `the_campaign_teardown_reaps_the_wtcompare_supervisor` | **1,650-2,250 / 1,150-1,550** |

### Wave 6 — two slices

| Slice | Owns (exclusively) | Does | LOC src / test |
|---|---|---|---|
| **S7 official-io path** | `tools/compare/check-official-io.ts`, `tools/compare/official-io-allowlist.json`, `tools/compare/r1-entrypoint-red.test.ts` | §2.6(B) only: drop the doubled prefix at `:5106`/`:5116`; re-pin the RED oracles; assert the delta is those six paths and nothing else | **~10 / 150-200** |
| **S10 e2e** | `tools/compare/fanout-production-e2e.test.ts` | §3.3 in full at the `chat 1k` rung; deletes each negative it turns positive; the three mutation proofs | **0 / 1,600-2,100** |

### Totals

| | src | test |
|---|---:|---:|
| **Revision 2 range** | 12,500-16,000 | 10,600-13,700 |
| **Revision 3 range** | 13,900-17,900 | 11,900-15,500 |
| **Revision 4 range** | 14,200-18,300 | 12,300-16,000 |
| **Revision 5 range** | 14,600-18,900 | 12,800-16,700 |
| **Revision 6 range** | 14,750-19,200 | 12,950-16,900 |
| **Revision 7 range** | **14,800-19,300** | **13,000-17,000** |

Revision 7 nets +50-100 src: §2.9(4d)'s half-close ordering and the received-frame assertion,
§2.9(4e)'s probe reading, and two renames. The S8 split moves work between slices rather than
adding it (S8a 1,800-2,300 + S8b 900-1,200 against S8's 2,550-3,300).

**These are now a range, not a floor.** Revision 6 was the first with no blocking finding and
**no new crossing object**, which was the condition set in revision 5 for retiring the floor
framing; revision 7 adds none either. The enumeration in §2.9(4a) is closed over its stated
domain — sixteen rows plus five reasoned dismissals — and revision 7's one must-fix was an
**ordering error within row 12**, not a seventeenth object. That distinction is what makes the
difference between "the table is incomplete" and "the table is complete and one mechanism using
it was wrong".

**This is a program, not a slice**, and that is the headline. If the total is unacceptable,
the lever is finding 1's option (a) — declare `MacFanoutSupervisor` the Mac signer of record —
removing S5-MAC-RS and most of S8a, ~5,500-7,000 lines (S8b's spawn/shutdown work survives
option (a), because the uid boundary is what makes the key a descriptor at all). **The review priced that trade in plan
terms and the price is higher than revision 2 stated.** Option (a) costs not one thing but
four:

1. **Mandate assertion 3's Mac half**, as revision 2 said.
2. **Plan line 234, directly violated:** "The controller is an untrusted byte courier and
   cannot mint, rewrite, substitute, or authenticate either issuer's records." Under (a) the
   controller process mints one issuer's records at will.
3. **Plan line 238, directly violated:** "the controller never reads either private key", and
   "The Mac controller account must fail `test -r` on the Mac key."
4. **Plan §3.1's bidirectional check, made vacuous:** the authenticator of the rig graph and
   the signer of the admission become one process, so the admission attests that *the
   controller concluded* the graph verified. The offline verifier still repeats the checks, so
   the evidence is not worthless — what is lost is the **independence** of the second issuer,
   which is the only thing bidirectional Ed25519 buys over one-way signing. All five §2.9(5)
   forgery tests become untestable, because verifier and forger are the same process.

So the trade is ~5,500-7,000 lines against three frozen plan clauses and the independence of
the second issuer. **Option (a) is defensible only as an explicitly recorded deviation from
plan §3.1 and plan line 234, not as a scoping choice** — and, given N1, option (b) is not free
either: it needs the uid boundary §2.9(4) now specifies. This remains a maintainer decision.

### The gate (every slice, before it reports done)

1. `bunx tsc -p tsconfig.json` → **0**.
2. `bun test tools/compare/ --timeout 30000` → 0 fail, on a `git archive` clean tree with
   real `node_modules` (`.scratch/rebuild-clean.sh`). The two `r1-entrypoint-red` oracles
   fail on a dirty worktree only; that is expected and is not a pass.
3. `bun tools/compare/check-official-io.ts` → **normalized key set byte-identical** to the
   round-two baseline, except S7, which must show the six-path delta and nothing else.
4. `cargo fmt --all --check` clean; `cargo clippy --workspace --all-targets -- -D warnings`
   → 34 errors, **unchanged** from the round-one baseline (all pre-existing, in `limits.rs` /
   `session.rs` / `session_registry.rs` / `spawn_tracked.rs` / `tests/secure_fs.rs`);
   `cargo test --workspace` green.
5. `scripts/converge-r1-fixture-hashes.ts --check` → `verdict CLEAN`.
6. Every claim in the slice's note established **by execution**; every guard the slice adds
   **mutation-proven**, source restored byte-identical, and said so.
7. **New `.test.ts` files are safe and need no allowlist line** (review 13): 38 of the 112
   `.ts` files under `tools/compare` sit outside the allowlist's 75 classified entries and
   all 38 are tests. What *is* an `ALLOWLIST_EXTRA_FILE` is a new **production** `.ts`; no
   slice above creates one, and no slice may put production code in a `.test.ts` to dodge
   the rule.
8. Every codec the slice owns has its hex conformance vector, asserted from both languages.
9. **Every file a slice touches has exactly one owner in §4.** Revisions 3 and 4 each found a
   file that no slice owned (`server-observation-artifact.ts`, `bin/stage-live-campaign.ts`),
   and in both cases the gap was a codec or a mode the design depended on. A slice that
   discovers it must edit an unlisted file **stops and gets the file assigned** rather than
   editing it. `tools/compare/bin/fanout-role.ts` is the one file named in this design that is
   deliberately **not** edited by any slice — round two verified it already emits every frame
   of the lifecycle — and a slice that finds itself changing it has found a defect in §2.5.

---

## 5. Open questions

Settled and removed: the rung (§3.2, measured); `RigMeasureStartAckV1` (§2.11, decided and
now single-owner); rig readiness (§2.8, review 11 refuted the alternative); nested-record
digests (§1.3, fixed rather than pinned); the Mac signing key's **location** (§2.9(4), plan
238's path) and its **uid boundary** (§2.9(4), `sudo -n -u _wtcompare`, the mechanism plan
2769/2915 already use); the Phase-A Mac field table (§2.10, named and scoped);
`measuredDurationMs` / `messageBytes` (§3.2, chosen with S2 as owner).

1. **The Mac private key is in two processes until the Phase-A Mac codec exists.** §2.9(6):
   this design moves the cohort records into the binary, but
   `mac-execution-grant-receipt/v1` is still signed in the controller process
   (`server-observation-artifact.ts:1159`), and the Phase-A `mac-*` frames have no TS key
   sets at all (`PHASE_A_MAC_*` does not exist). Building that codec and moving the Phase-A
   receipt is a further slice nobody has scoped. **This is the top residual and it partially
   weakens the ruling's symmetry.**
2. **1,010 concurrent QUIC sessions on this host is unmeasured** (§3.2). S0 answers it. If
   the answer is no, the wt arm of mandate assertion 1 becomes rig-only; the invariant that
   would close it is named in §3.4.
2b. **Settled and owned.** The mode question is no longer open: §2.9(4a) enumerates all ten
   crossing objects, §2.9(4b) checks each in the preflight, and **S9 owns
   `bin/stage-live-campaign.ts`** and makes the exact change at **five** sites — `:702-704`,
   `:1555`, `:1556`, `:1560`, `:1698-1699` (revision 4's list omitted `:1556`, the fd 6 object,
   and miscited `:1560` as `:1558`; review NEW-9). What remains genuinely open is only whether
   the *installed* host already satisfies it, which S0's tier probe answers before any slice
   depends on it.
2c. **No descriptor *the design opens* crosses `sudo`; the three standard streams do, by
   construction, and stage 1 depends on that.** Revision 5 said "nothing crosses a sudo
   boundary as an open fd", which was inaccurate as written (review NEW-13). The accurate
   statement has two halves. **(i)** §2.9(4) puts the uid change *before* every `exec N<…`, so
   all eight numbered descriptors (3-8) are opened **by `_wtcompare` itself** — the design
   never asks `sudo` to carry one, and the alternative (opening them as the controller and
   relying on `closefrom` behaviour in the host's sudoers) stays rejected for that reason.
   **(ii)** fds **0, 1 and 2 do cross**, because `sudo` preserves standard I/O and
   `stdio: ["pipe","pipe","pipe"]` (`remote-supervisor.ts:843-845`) is how the frame channel is
   established at all. That is **row 12 of §2.9(4a)**: not a leak but the boundary's interface,
   and the one object stage 1's graceful stop actually operates on. Recorded so neither half is
   reintroduced as a simplification of the other.
3. **`check-official-io` defect (A)** (§2.6) needs a per-bucket import/call policy, which is
   a governance decision. Deliberately excluded from every slice.
4. **The total (14,800-19,300 src) may exceed what round three should be.** The lever is finding
   1's option (a), stated in §4 with its exact cost. A maintainer call.
6. **~~The rig's lifetime mismatch~~ — promoted, not residual (review NEW-8).** Revision 4
   filed this as "not mine to fix … recorded so round five does not discover it as new". The
   diagnosis was right and the classification was wrong: it breaks mandate assertion 1 in this
   design's own e2e at execution 2 of 4. It is now **§2.13**, owned by S5-RIG, with a §3.3
   registry edit — because unlike the Mac's frame, `rig-accept-cohort-request/v1` has no
   acceptance field to reuse. Recording a live blocker as a forward-looking note is itself a
   failure mode, and it is the one this entry now marks.
7. **`crates/native/tests/fanout_supervisor.rs` — owned by S5-MAC-RS (review NEW-10).** Not a
   residual: the S5-MAC-RS row already owns it. Revision 4 carried a stale revision-3 sentence
   asserting it was unowned, which contradicted its own slice table and violated gate item 9 —
   the rule added in the same revision. Kept here only as the reason for the assignment:
   S5-MAC-RS touches `CohortRuntime`'s surface, and that file's fixture at `:129` depends on
   it.
