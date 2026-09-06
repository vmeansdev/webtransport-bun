APPROVED

# Cohort completion amendment — Architect pass

- Plan reviewed: `docs/superpowers/plans/2026-09-05-cohort-completion-amendment.md`
- Verified plan SHA-256: `90d469cb0c54e8e4e34a7edb333156b365d73464099e1d7eb49189234a55e7e1`
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
- Verified HEAD: `35c4cec7e56a3ebba72a780443f505784a8e728c`
- Baseline tracked patch SHA-256: `e29f531ce1292dfd58384e42627d306db8b79fc5f7f54f06aa0800582b2b65ba`
- Reviewer: Codex (GPT-6), lead agent, Architect role pass at the user's explicit request; not an external or independent reviewer.
- Review timestamp: `2026-09-04T23:33:05.887Z`

APPROVED for implementation of the exact amendment and its hash-bound base/design. This approval does not assert implemented correctness or approve a staged live run.

Verified the amended contracts against `MacCohortEvidenceExportedAckV1`, `CohortEvidenceExportReceipt`, `COHORT_EVIDENCE_DEBIT_FIELDS`, the six-field token manifest, existing topology builder, `ResidentLoop::present_artifact_payload`, production controller dispatch, and the fixture attestation producer. The original seven findings are addressed:

1. C1 supplies both missing topology arrays through explicit bounded fields without changing retained manifest/leaf semantics. Rust verifies membership/root and embeds verified arrays; grant construction stays in the signer.
2. C2 assigns the full authority migration and Phase-A retained-state bridge. The sole ordinal/grant owner remains ResidentLoop, and consuming `open` transfers admitted facts instead of losing them.
3. C3 freezes signature bytes and domain/context-bound canonical transcript, names the staged verification key and retains the signature across artifact writing and offline verification.
4. C4 separates acquisition from finalization and explicitly removes the live fixture mint and premature generic server spawn. It assigns actual production channels and exact signed outputs, not optional test seams.
5. The measured chat-10k manifest is 2,713,015 decoded / 3,617,356 encoded bytes. C1's request-specific 7 MiB cap accommodates the existing 4 MiB manifest cap, two 256 KiB topology arrays and 256 KiB role-plan bound after Base64 expansion; 14 MiB outer and 20 MiB cumulative decoded evidence limits remain unchanged. Enforcement and largest-cell tests are required at both ends.
6. C5 assigns the verified WT rate/session-limit and WS TLS defects within benchmark-local configuration, retaining product defaults.
7. Completion requires the actual original zero-error gate, positive production e2e and distinct A5/B5/B6 stage reviews and measurements. It explicitly rejects diagnostic baseline counts and old artifacts as final proof.

The implementation cost is materially larger than closing the 16 type errors because those errors mark a protocol transition, not the whole runtime. The simpler alternative of controller-owned signatures or prefilled seal material violates the preserved independent-issuer and causal evidence contracts. The amendment accepts the integration cost and keeps every required outcome falsifiable through producer-to-offline-verifier and real-process tests.

No closed topology, relay-budget, promotion, purpose or physical-pilot decision is reopened. Scoped implementation defects may be corrected with focused tests; a contract change requires a new reviewed amendment, as stated in the plan.
