APPROVED

# Cohort completion amendment — Critic pass

- Plan reviewed: `docs/superpowers/plans/2026-09-05-cohort-completion-amendment.md`
- Verified plan SHA-256: `90d469cb0c54e8e4e34a7edb333156b365d73464099e1d7eb49189234a55e7e1`
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
- Verified HEAD: `35c4cec7e56a3ebba72a780443f505784a8e728c`
- Baseline tracked patch SHA-256: `e29f531ce1292dfd58384e42627d306db8b79fc5f7f54f06aa0800582b2b65ba`
- Reviewer: Codex (GPT-6), lead agent, separate Critic role pass after completed Architect review, as requested; no claim of reviewer independence.
- Review timestamp: `2026-09-04T23:33:43.095Z`
- Completed Architect review: `docs/superpowers/plans/reviews/2026-09-05-cohort-completion-architect.md`
- Architect review SHA-256: `96be4de21eb2a15abf982f22491d7f6714cc8b162583ba197d7f05f169a5e935`

APPROVED for implementation of this exact amendment and hash-bound base/design. No conditions are attached to this verdict. Implementation acceptance and live staged-run approval remain separate gates.

The initial rejection is resolved with testable contracts and ownership rather than completion claims:

- C1 names exact non-secret carriers and requires highest-cardinality validation; it preserves the existing manifest rather than changing every historical manifest encoding. Both encoded frame and cumulative decoded bounds are explicit. Budgets still charge repeated evidence before decoding, even where retention reuses immutable bytes.
- C2 makes honest positive mints and retained admitted execution prerequisites. Reusing the consumed `OpenExecution` or accepting controller-supplied approval aliases is expressly forbidden. Multi-execution and restart tests must exercise the actual binary.
- C3 specifies the exact seven-field signing transcript, 64-byte signature and staged public-key source. Stripped signature and forged-signature/honest-carrier tests are required in addition to internal receipt verification. This addresses the prior test blind spot.
- C4 corrects the lease lifecycle inversion, fixture use and pre-dispatch server launch. Finalization collects actual measured/admitted material after the lifecycle; placeholders or fixture-signing paths do not satisfy the acceptance test.
- The maximum control frame correction is justified by a measured actual manifest; it neither shrinks topology nor expands relay/product queue budgets.
- C5 retains actual zero-error final validation and requires adversarial checks after official-I/O policy corrections. There is no acceptance-by-baseline-subtraction, blanket module permission or historical-evidence reuse.
- A5, B5 and B6 remain explicit, independently staged/reviewed outcomes. Four-execution chat-1k integration is not represented as the ticker pilot. A failed or non-promotable outcome cannot satisfy the 60-seal canonical gate.

The ownership table covers the previously missing evidence/authority/runtime consumers, grants the lead responsibility for final audit/e2e integration, and requires a newly reviewed amendment for semantic expansion. The stated risks have discriminating checks and bounded cleanup rather than a fallback that changes the experiment.
