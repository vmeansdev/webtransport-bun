CHANGES REQUIRED

# Existing cohort plan — Architect pass

- Reviewer: Codex (GPT-6), lead agent, Architect pass requested by the user; no external CLI or model substitution.
- Plan reviewed: `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`
- Verified plan SHA-256: `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`
- Integration design: `docs/superpowers/plans/deviations/2026-09-02-cohort-runtime-integration-design.md`
- Verified integration design SHA-256: `62ea8c4a87ac646e4be4f98dff0948e71f8ff04a2ecc3f660068c243e4f4feab`
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
- Verified HEAD: `35c4cec7e56a3ebba72a780443f505784a8e728c`
- Working-tree baseline: `.scratch/2026-09-05-cohort-completion/baseline.json`

The signed, separately owned supervisor architecture remains appropriate. The existing plan and revision-13 integration design cannot yet authorize executable completion: the already recorded gaps are real producer/consumer discontinuities, not environment refusals.

1. `mac-open-cohort-request/v1` presents a six-member leaf manifest which contains neither publisher grants nor subscriber shards. Rust cannot verify and bind topology it never receives. Add an explicit bounded non-secret topology carrier, exact-key parsers in both languages, and cross-language conformance proof; do not synthesize a second unreviewed topology builder.
2. The binary's `ResidentLoop` retains legacy measurement state but the Mac cohort runtime does not receive full validated Phase-A execution/admission and campaign approval bindings. Specify and implement the entire draft -> grant -> execution -> signed receipt -> admitted series -> signed admission path. Adding two authority fields alone is insufficient. Authority producers, TS/Rust parsers, fixtures and digest regeneration require one atomic migration with explicit ownership.
3. The reduced export ack carries a signature with undefined signed-message semantics. Define exact signature bytes and transcript, retain that signature in artifacts, and verify it against the staged Mac key offline. Assign `evidence.ts`, `artifact-builder.ts`, `verify-artifact.ts` and all affected tests to the same migration.
4. The TypeScript supervisor still signs with a private key and production controller constructs a runtime without `lease`. The remaining S8a/S9 work must replace signing with channels and wire the real Phase-A material, rather than retain test-only success paths.
5. Full-size token manifest/canonical evidence must be measured against existing frame and total retained-byte caps before approving transport changes. Preserve bounded allocations and charge before decode.
6. The local host probe found WT admission limits and WS TLS option translation preventing the promised production e2e. Assign benchmark-local server/role-connector fixes. Do not change product defaults or claim that a session-count probe proves campaign throughput.
7. Revision-13 intermediate gates tolerate official-I/O failures while original section 10 requires zero. The completion amendment must require the actual zero-failure final gate, resolve real import-policy violations without weakening the trust boundary, and restore positive real-process e2e acceptance rather than pass by retaining negative missing-feature tests.

The strongest alternative is to retain controller-owned signing, which would simplify the migration. It contradicts the preserved independent issuer/key-ownership contract and is rejected. Complete the existing architecture, with a narrowly scoped amendment assigning the missing contracts and final gates. Preserve original plan bytes and historical evidence.

This is a rejection of execution readiness, not a claim that earlier implementation or historical reviews did not occur. A corrected final-path amendment and fresh sequential review are required before implementation.
