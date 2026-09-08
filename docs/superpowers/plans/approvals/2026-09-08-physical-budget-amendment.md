# Physical-Budget Amendment — Approval Record

**Plan file:** `docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`
**Plan file SHA-256:** `c98fdb39f6a05cdd473b88a3dcaac943ed3e6fd809593e1898e9f992d5d6d073`
**Plan revision:** R6 (R1–R5 refused; artifacts under `docs/superpowers/plans/reviews/2026-09-08-physical-budget-*`)
**Plan HEAD:** `efaed8bb0af82a499ca58b2627ea251efced41c5` on `codex/ws-scenario-comparison`
**Worktree:** `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
**Review date:** `2026-09-08`
**User ruling bound:** "measurement has to always respect physical constraints" (option (a) of the B5 Critic's refusal)

## Architect signature

- **Reviewer:** Claude workflow subagent, Architect pass (`wf_f8ca8686-62a`, label `amendment-architect-r6`)
- **Verdict:** `APPROVED`
- **Verdict iteration:** 6
- **Review artifact:** `docs/superpowers/plans/reviews/2026-09-08-physical-budget-architect-r6.md`
- **Review artifact SHA-256:** `32fd673b9f799dd017a2aee81639fbe8a2ca5766f24cb5b904169732fefb75c3`
- **Review timestamp:** `2026-09-08T14:53:16Z`
- **Verbatim verdict text:** `APPROVED`

## Critic signature

- **Reviewer:** Claude workflow subagent, separate subsequent Critic pass (`wf_f8ca8686-62a`, label `amendment-critic-r6`; read the Architect artifact, re-verified independently)
- **Verdict:** `APPROVED`
- **Verdict iteration:** 6
- **Review artifact:** `docs/superpowers/plans/reviews/2026-09-08-physical-budget-critic-r6.md`
- **Review artifact SHA-256:** `533973bece6334731f57a25ecaa412ddcffdbcc4c9fa5d613651310d50502e53`
- **Review timestamp:** `2026-09-08T14:59:23Z`
- **Verbatim verdict text:** `APPROVED`

## Scope of approval

The exact amendment bytes above, the base plan (`9374b747…`), the cohort completion amendment (`90d469cb…`) and the integration design (`62ea8c4a…`) it binds, and the named worktree/HEAD are approved for implementation under the user's ruling. This records plan readiness, not implementation acceptance: every slice still lands under its own tests and the lead gate, the D4 physical preflight runs before any phase-b stage, and each live campaign receives its own exact-stage Architect then Critic review. Phase-b staging after this record uses the plan file above as `approvedPlanSha256` and this record as `approvalRecordSha256`.

## Non-blocking items carried into the slices (from both R6 artifacts)

1. D1's "bursts of 10" is the aggregate warmup shape; per publisher it is one frame per 500 ms at its `WARMUP_OFFSETS_MS` slot.
2. The cell-id test-file counts (19 by id, 22 by id-or-label, "26") are not a completion criterion; slice 3's sweep output is.
3. Slice 5: the 2× pacing is a preflight-only input via the child's `messageRatePerSecond` (500/s ticker; 4/s per chat publisher), the offered rate is recorded per pass, and per-window offered/accepted are origin-window counts, not wall-clock 1 s samples (wall-clock deltas read 498–509 at a 500/s offer and would fail `≥ 500` spuriously); the chat 2× pass is paced while its R3 evidence is the harsher burst shape.
4. Slice 4: the receipt names the CPU instrument; the `CHAT_10K_*` bounds in `secure_fs.rs:12119-12121` stay valid.
5. Revision-identity lines of the amendment are not re-edited after this record.

## Finalization

Architect completed before Critic. Both durable review artifacts start with exactly APPROVED, bind the amendment path, exact SHA, worktree and HEAD, and state that nothing blocking remains. This record contains no self-hash and will not be changed after its separate verification.
