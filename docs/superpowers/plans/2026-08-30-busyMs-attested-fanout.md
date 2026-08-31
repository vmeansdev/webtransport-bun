# WS/WT Attested busyMs and Canonical Fanout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Track every checkbox and stop at every stated gate.

**Status:** APPROVED

**Goal:** Make Linux `serverAggregate` artifact-verifiable transparency evidence, then replace all six chat/ticker echo minima with canonical supervisor-owned fanout cohorts.

**Architecture:** Phase A first fixes WT accounting and creates an end-to-end, issuer-authenticated Mac-grant -> rig-owned server -> Mac-admitted client-series receipt graph. Phase B extends the same execution and receipt graph with a Linux-authoritative bounded relay plus Mac-supervisor-owned publishers and eight subscriber workers. Exact canonical bytes, not controller summaries, survive into each artifact and are reverified offline.

**Tech stack:** Bun 1.3.14+, TypeScript, Rust, canonical JSON, SHA-256, Ed25519, the existing `comparison-supervisor-frame/v1` remote codec, bounded `u32be || canonical JSON` child pipes, inherited POSIX FDs, and the R1 secure-filesystem roots.

---

## 0. Review identity, final artifact, and execution authority

- R13 drafting path (non-authorizing): `/tmp/ws-wt-plan-review/2026-08-30-busyMs-attested-fanout-DRAFT-r13.md`. Its required status while drafting is `DRAFT pending approving review (r13).`; no review of this `/tmp` artifact grants execution authority.
- Authorizing review artifact: `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`. After the three remaining R12 findings are closed, copy the complete R13 draft to that repository path, change only the status line to `**Status:** APPROVED.`, compute the resulting repository-file SHA-256, and make no further byte change. Architect then Critic must review that exact repository path and resulting SHA. Execution authority additionally requires the approval record; a review of DRAFT-status bytes is readiness feedback only and is non-authorizing.
- Approval record: `docs/superpowers/plans/approvals/2026-08-30-busyMs-attested-fanout.md`.
- Worktree: `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`.
- R5 source-review HEAD anchor: `a5c7ca53a81183d57155d8ec90b8f3e0546a623e`. The approving round MUST use this exact HEAD; a different HEAD requires a new source spot-check, revised plan identity, new digest, and fresh approving pair.
- Approval is path + bytes + worktree + HEAD bound. A status edit, whitespace edit, relocation, HEAD change before implementation, or review-file edit invalidates both verdicts.
- Required order is unconditional Architect `APPROVED`, then unconditional Critic `APPROVED`, for the same final path, plan SHA-256, worktree, and HEAD. Conditional approval is rejection.

The approval record follows the headings and field style of `docs/superpowers/plans/approvals/2026-08-28-ws-wt-scenario-comparison.md` exactly:

```markdown
# WS/WT Attested busyMs and Canonical Fanout Plan — Approval Record

> **For auditors:** this file is the canonical record of the architect + critic approval of the plan named below.

**Plan file:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`
**Plan file SHA-256:** `<64 lowercase hex>`
**Plan HEAD:** `<40 lowercase hex>` on `codex/ws-scenario-comparison`
**Worktree:** `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`
**Review date:** `<YYYY-MM-DD>`

---

## Architect signature

- **Reviewer:** `<identity and role>`
- **Model:** `<model>`
- **Verdict:** `APPROVED`
- **Verdict iteration:** `<round>`
- **Review artifact:** `<path>`
- **Review artifact SHA-256:** `<64 lowercase hex>`
- **Review timestamp:** `<RFC3339 UTC>`
- **Verbatim verdict text:** `<unconditional verdict>`

## Critic signature

- **Reviewer:** `<identity and role>`
- **Model:** `<model>`
- **Verdict:** `APPROVED`
- **Verdict iteration:** `<round>`
- **Review artifact:** `<path>`
- **Review artifact SHA-256:** `<64 lowercase hex>`
- **Review timestamp:** `<RFC3339 UTC>`
- **Verbatim verdict text:** `<unconditional verdict>`

## Scope of approval

<States that approval covers this final path, exact plan bytes, worktree, and full HEAD; implementation, evidence, publication, and promotion are not approved.>

## Finalization

<States that both durable review artifacts had first line exactly APPROVED and each bound the final plan path, exact plan SHA-256, exact worktree, and exact HEAD. This section is written before the approval record is finalized.>

---

**Auditor note:** <reverification steps and the separately retained final-verification path>
```

Approval finalization is deliberately non-self-mutating:

1. Persist the final plan bytes at the repository path and compute `PLAN_SHA`.
2. Obtain the Architect review, then the Critic review, against that exact path/SHA/worktree/HEAD. Each durable review artifact's first line is exactly `APPROVED` and its review-identity bullets use the exact labels checked below.
3. Write both signature sections, review paths, review digests, scope, and Finalization text into the approval record. Do not include an approval-record self-hash or the later check output.
4. Finalize the approval record, compute `APPROVAL_SHA=$(shasum -a 256 "$APPROVAL" | awk '{print $1}')`, and never edit the record again.
5. Run the no-edit gate below. Retain its stdout, stderr, command SHA-256, exit status, timestamp, `PLAN_SHA`, and `APPROVAL_SHA` in append-only evidence at `.release-evidence/transport-comparison/approval-checks/<APPROVAL_SHA>.json`; that evidence is separately SHA-256 hashed and is not inserted into the approval record.

The gate recomputes the plan and review digests, verifies exact HEAD, checks each review artifact's actual first line, and checks its final plan path/SHA/worktree/HEAD binding. It must print `PLAN_APPROVAL_DIGESTS_OK`; any other result stops implementation.

```bash
set -euo pipefail
PLAN=docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md
APPROVAL=docs/superpowers/plans/approvals/2026-08-30-busyMs-attested-fanout.md
PLAN_SHA=$(sed -n 's/^\*\*Plan file SHA-256:\*\* `\([0-9a-f]\{64\}\)`$/\1/p' "$APPROVAL")
PLAN_HEAD=$(sed -n 's/^\*\*Plan HEAD:\*\* `\([0-9a-f]\{40\}\)`.*/\1/p' "$APPROVAL")
ARCH_PATH=$(sed -n '/^## Architect signature$/,/^## Critic signature$/s/^- \*\*Review artifact:\*\* `\([^`]*\)`$/\1/p' "$APPROVAL")
ARCH_SHA=$(sed -n '/^## Architect signature$/,/^## Critic signature$/s/^- \*\*Review artifact SHA-256:\*\* `\([0-9a-f]\{64\}\)`$/\1/p' "$APPROVAL")
CRIT_PATH=$(sed -n '/^## Critic signature$/,/^## Scope of approval$/s/^- \*\*Review artifact:\*\* `\([^`]*\)`$/\1/p' "$APPROVAL")
CRIT_SHA=$(sed -n '/^## Critic signature$/,/^## Scope of approval$/s/^- \*\*Review artifact SHA-256:\*\* `\([0-9a-f]\{64\}\)`$/\1/p' "$APPROVAL")
WORKTREE=/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison
test -n "$PLAN_SHA" && test -n "$PLAN_HEAD" && test -n "$ARCH_PATH" && test -n "$ARCH_SHA" && test -n "$CRIT_PATH" && test -n "$CRIT_SHA"
test "$(shasum -a 256 "$PLAN" | awk '{print $1}')" = "$PLAN_SHA"
test "$(shasum -a 256 "$ARCH_PATH" | awk '{print $1}')" = "$ARCH_SHA"
test "$(shasum -a 256 "$CRIT_PATH" | awk '{print $1}')" = "$CRIT_SHA"
test "$(git rev-parse HEAD)" = "$PLAN_HEAD"
test "$(sed -n '1p' "$ARCH_PATH")" = APPROVED
test "$(sed -n '1p' "$CRIT_PATH")" = APPROVED
for REVIEW in "$ARCH_PATH" "$CRIT_PATH"; do
  test "$(sed -n 's/^- Plan reviewed: `\([^`]*\)`$/\1/p' "$REVIEW")" = "$PLAN"
  test "$(sed -n 's/^- Verified plan SHA-256: `\([0-9a-f]\{64\}\)`$/\1/p' "$REVIEW")" = "$PLAN_SHA"
  test "$(sed -n 's/^- Worktree: `\([^`]*\)`$/\1/p' "$REVIEW")" = "$WORKTREE"
  test "$(sed -n 's/^- Verified HEAD: `\([0-9a-f]\{40\}\)`$/\1/p' "$REVIEW")" = "$PLAN_HEAD"
done
test "$(sed -n '/^## Architect signature$/,/^## Critic signature$/s/^- \*\*Verdict:\*\* `\([^`]*\)`$/\1/p' "$APPROVAL")" = APPROVED
test "$(sed -n '/^## Critic signature$/,/^## Scope of approval$/s/^- \*\*Verdict:\*\* `\([^`]*\)`$/\1/p' "$APPROVAL")" = APPROVED
printf '%s\n' PLAN_APPROVAL_DIGESTS_OK
```

`approvedPlanSha256` is the SHA-256 of the final repository-plan bytes. `approvalRecordSha256` is computed once after the complete approval record is finalized; it is not embedded in that record because a self-hash is impossible. Both values are embedded in every live execution and receipt below. An approval record or review artifact edit invalidates the retained no-edit check and all staged digests.

## 1. Preserved decisions and non-goals

1. Phase A completes before Phase B begins.
2. `serverAggregate` remains transparency-only aggregate receive-loop work. It never changes ranking, eligibility, comparison, promotion, winner selection, or the Phase 2.4 saturation caveat. It may exceed `windowMs`; only `perSession` controls saturation wording.
3. WT session close transfers busy time exactly once from live to completed accounting; loaded deterministic oracle is exactly `25 + 40 = 65 ms`; idle oracle is `0 ms` with a positive window.
4. Chat is exactly ten dedicated publisher processes plus eight subscriber workers. Ticker is exactly one dedicated publisher process plus eight subscriber workers. The Mac supervisor owns every child, control FD, PID/PGID, nonce, token, lifetime, partial, and reap. There is no controller-owned child or aggregation fallback.
5. Linux owns one bounded reliable relay and is authoritative for accepted role/session registrations, accepted ingress, relay writes, capacity, duplicate/reorder/drop/timeout counts, and end state. Publishers are authoritative only for offered attempts. Subscriber workers are authoritative only for delivered records.
6. Relay bounds remain: 64 items and 64 KiB per subscriber; 2,000,000 items and 256 MiB global; 256 concurrent writes; 5 s write deadline; 10 s drain; ingress-order then subscriber-ID enqueue order. A slow subscriber is closed, counted, and makes the measured execution `FAIL/RELAY_DELIVERY`.
7. Canonical policy remains one unsealed warmup repetition plus five measured repetitions per arm. Each fanout repetition also performs the frozen five-second in-repetition warmup before the measured baseline.
8. No WAN/read-path/overlay fanout promotion, universal winner, budget increase, topology shrink, old unattested carry-forward, or per-delivery-message supervisor IPC.
9. Missing executor is an implementation blocker and creates no index entry. Only pre-traffic environmental preflight can be `REFUSED`; protocol/product/topology/lifecycle/resource faults after launch are `FAIL`.
10. All live children are supervisor-owned. All live waits, reads, writes, connects, drains, captures, and reaps have explicit deadlines.

## 2. Canonical encoding and scalar invariants

All new JSON records use one codec in TS and Rust:

- UTF-8; keys recursively sorted by ASCII code point; no insignificant whitespace; one trailing LF; duplicate keys, unknown keys, non-NFC strings, non-finite numbers, negative zero, unsafe integers, and trailing bytes are rejected.
- SHA-256 is lowercase 64-hex over the exact canonical bytes including the LF.
- Base64 is RFC 4648 standard alphabet with padding; decode before allocation only after the encoded-length cap is checked; decoded size must equal the accompanying size.
- `Sha256Hex` is exactly `/^[0-9a-f]{64}$/`; nonce IDs are exactly 32 random bytes represented as 64 lowercase hex; Ed25519 signatures decode to exactly 64 bytes; the public key is exactly 32 raw bytes.
- `NsString` is `/^(0|[1-9][0-9]{0,19})$/`, converted to unsigned 64-bit with checked arithmetic. Nanoseconds from different `clockId` values are never subtracted or ordered.
- Counts are nonnegative JS safe integers and Rust `u64`; all sum/product operations use checked arithmetic and also refuse results above `Number.MAX_SAFE_INTEGER` before JSON emission.
- Arrays have exact declared cardinality and canonical order. Sets are encoded as sorted arrays; duplicates fail.
- Every interface shown below has the exact expanded key set. `null` is required where shown; omission and additional keys fail.

```ts
type Sha256Hex = string;
type Base64 = string;
type NsString = string;
type ExecutionPurpose = "focused" | "pilot" | "canonical";
type RepetitionKind = "warmup" | "measured";
type CampaignStatus = "PASS" | "FAIL" | "REFUSED";
type CampaignRefusalCode = "RIG_UNREACHABLE" | "HOST_FD_PREFLIGHT" | "STALE_OR_INVALID_STAGING";
type CampaignFailureCode =
  | "MAC_GRANT_SIGNATURE_INVALID"
  | "MAC_SIGNING_KEY_MISMATCH"
  | "APPROVAL_IDENTITY_MISMATCH"
  | "MAC_GRANT_EXPIRED"
  | "MAC_GRANT_REPLAYED"
  | "RIG_RECEIPT_SIGNATURE_INVALID"
  | "RIG_SIGNING_KEY_MISMATCH"
  | "RIG_RECEIPT_EXPIRED"
  | "RIG_RECEIPT_REPLAYED"
  | "TRUST_PROTOCOL"
  | "CROSS_SUPERVISOR_MISMATCH"
  | "COHORT_PROTOCOL"
  | "COHORT_NOT_READY"
  | "WARMUP_PROTOCOL"
  | "MEASUREMENT_WINDOW"
  | "RELAY_DELIVERY"
  | "CHILD_LIFECYCLE"
  | "RUNTIME_RESOURCE_EXHAUSTION";

interface RetainedCanonicalBytesV1 {
  schema: "retained-canonical-bytes/v1";
  encoding: "base64";
  mediaType: "application/json";
  bytesBase64: Base64;
  byteLength: number;
  sha256: Sha256Hex;
}

interface CanonicalScenarioPreimageV1 {
  schema: "canonical-scenario-preimage/v1";
  cellId: string;
  scenarioId: string;
  parameters: Record<string, unknown>;
}

interface CanonicalRolePlanPreimageV1 {
  schema: "canonical-role-plan-preimage/v1";
  serverRole: "bulk-source" | "fanout-relay";
  direction: "linux-to-mac" | "mac-to-linux-to-mac";
  channelMapping:
    | "server-opened-uni"
    | "ws-binary-message-per-frame"
    | "wt-publisher-bidi-subscriber-control-bidi-server-uni";
  publisherCount: 0 | 1 | 10;
  subscriberWorkerCount: 0 | 8;
  subscriberCount: number;
  publisherRatePerSecond: number;
  payloadBytes: 100 | 128 | 65536;
  warmupMessagesPerPublisher: 0 | 10;
  warmupIntervalMs: 0 | 500;
  measuredDurationMs: 0 | 10000 | 30000;
}

interface CanonicalWorkloadRolePlanInputV1 {
  schema: "canonical-workload-role-plan-input/v1";
  scenarioPreimage: CanonicalScenarioPreimageV1;
  scenarioHash: Sha256Hex;
  rolePlanPreimage: CanonicalRolePlanPreimageV1;
  rolePlanHash: Sha256Hex;
}

interface StagedServerLaunchRecordV1 {
  schema: "staged-server-launch-record/v1";
  stageReceiptSha256: Sha256Hex;
  serverEntrypointSha256: Sha256Hex;
  bunSha256: Sha256Hex;
  addonSha256: Sha256Hex;
  bindAddress: "10.99.0.2";
  bindPort: number;
  advertisedHost: "10.99.0.2";
  tlsServerName: "wt-compare.local";
  transport: "ws" | "wt";
  argv: string[];
  allowedEnvironment: { name: string; value: string }[];
}
```

`CanonicalWorkloadRolePlanInputV1` is the one retained canonical launch input for every execution. `scenarioHash` is SHA-256 of the exact canonical `scenarioPreimage` bytes and `rolePlanHash` is SHA-256 of the exact canonical `rolePlanPreimage` bytes; the wrapper's own digest is `workloadRolePlanInputSha256`. The scenario and role-plan bytes are therefore available, not controller-supplied hash assertions. All three records reject unknown fields. Caps are 64 KiB for each nested preimage, 160 KiB for the wrapper, and 64 KiB for `StagedServerLaunchRecordV1`; arrays are capped at 32 argv entries of 1 KiB and 32 environment entries of 4 KiB, sorted by name with duplicates forbidden. The staged launch record is minted by `stage-only`, hashed into `LiveStageReceiptV1`, and its exact digest is bound by the Mac-signed execution receipt before the rig accepts a spawn request.

## 3. Phase A frozen trust contracts

### 3.1 Issuer authentication and staged key ownership

The sole cross-host issuer-authentication mechanism is bidirectional Ed25519. The controller is an untrusted byte courier and cannot mint, rewrite, substitute, or authenticate either issuer's records:

- Mac signs exact canonical `MacExecutionGrantReceiptV1`, `CohortGrantV1`, `CohortWarmupEpochV1`, `RoleWarmupCompletionManifestV1`, and `CohortStartBarrierV1` bytes with RFC 8032 Ed25519, without prehash or context. Rig verifies the relevant signature before acting on any of those bytes. Mac also signs final admission records.
- Rig signs exact canonical `RigExecutionAcceptanceV1`, `RigCohortAcceptanceV1`, `RigWarmupDrainedReceiptV1`, `RigMeasureStartAckV1`, `RigBarrierAcceptanceV1`, `RigServerSnapshotReceiptV1`, and `RigRelayObservationReceiptV1` bytes. Mac authenticates every applicable rig record before final admission; the offline verifier repeats all checks.
- Fresh per-campaign Mac and rig keys are created by `comparison-supervisor keygen-ed25519`. Mac private key: `/var/db/webtransport-bun/comparison/keys/<candidate>/<campaignId>.mac.pk8`, mode `0400`, owner `_wtcompare`, group `staff`. Rig private key: `/var/lib/webtransport-bun/comparison/keys/<candidate>/<campaignId>.rig.pk8`, mode `0400`, owner `_wtcompare`, group `_wtcompare`. Each supervisor creates its own key locally; the controller never reads either private key. The Mac controller account must fail `test -r` on the Mac key, and `hermes-admin` must fail `sudo -n -u hermes-admin test -r` on the rig key.
- The raw 32-byte public keys are cross-staged as `staging-root/mac-supervisor-ed25519.pub` and `staging-root/rig-supervisor-ed25519.pub`. `staged-capability/v2`, authority, manifest, and `LiveStageReceiptV1` bind exact leaf names and SHA-256 values for both keys. Each supervisor opens the other issuer's public leaf through its staged-root directory FD; there is no CLI public-key override.
- Key generation refuses an existing public or private path with `TRUST_SIGNING_KEY_EXISTS`. Rotation under the same campaign is forbidden. A new key requires a new campaign ID, fresh roots, authority/capability/lock/external-trust digests, and fresh exact-staged-artifact review.
- Durable replay ledgers use `O_CREAT|O_EXCL|O_NOFOLLOW`: rig stores Mac signed-record digests under `replay/mac-records/<signedSchema>/<signedBytesSha256>` before acceptance; Mac stores rig signed-record digests under `replay/rig-records/<signedSchema>/<signedBytesSha256>` before admission. Every Mac-signed record contains, directly in its exact signed bytes, `macSupervisorInstanceNonce`, `signingPublicKeySha256`, `receiptSequence`, `issuedAtMs`, and `notAfterMs`; no join is allowed to supply a missing field. Every rig-signed record retains the corresponding rig fields already shown. Acceptance after `min(record.notAfterMs, staged-capability.notAfterMs)`, duplicate digest, or cross-execution substitution fails even after restart.
- The Mac owns one durable contiguous signing sequence per `(campaignId, macSupervisorInstanceNonce, signingPublicKeySha256)`, starting at 0. It appends and fsyncs exactly one `{receiptSequence,signedSchema,signedBytesSha256,stateBefore,stateAfter}` leaf atomically with the signed record, then advances `nextReceiptSequence`; it never reserves a sequence before bytes exist. Phase A transitions are execution receipt then measurement admission. Phase B transitions are execution receipt, cohort grant, warmup epoch, warmup-completion manifest, start barrier, measurement admission, then cohort admission. When `recover-rig-key` succeeds, Mac appends exactly one additional contiguous transition `rig-key-recovery-result/v1` on the durable Mac recovery signing identity (not the ephemeral campaign key), continuing at the prior sequence plus one for that recovery identity. Recovery follows the same no-pre-byte-reservation rule: the recovery identity does not consume/advance `receiptSequence` until the single recovery commit binds the sequence leaf atomically with the already-signed result bytes. The next execution continues at the prior campaign-key sequence plus one. A duplicate, rollback, gap/skip, schema order violation, signature used with a different `signedSchema`, restart replay, issuer-nonce/key change under one campaign, or expired record is `FAIL/TRUST_PROTOCOL` (or the more specific existing key/expiry/replay code). The rig and offline verifier replay the retained ordered signed-record bytes and require the identical contiguous state transition; receipt hashes alone cannot satisfy this audit.
- Mac failures map to the existing `MAC_*` codes. Rig signature, key, expiry, and replay failures map respectively to `FAIL/RIG_RECEIPT_SIGNATURE_INVALID`, `FAIL/RIG_SIGNING_KEY_MISMATCH`, `FAIL/RIG_RECEIPT_EXPIRED`, and `FAIL/RIG_RECEIPT_REPLAYED`. Unknown schema, bad canonical bytes, wrong execution/cohort/barrier, or sequence mismatch is `FAIL/TRUST_PROTOCOL` or `FAIL/CROSS_SUPERVISOR_MISMATCH` as section 7 freezes.

```ts
interface CrossSupervisorExecutionDraftV1 {
  schema: "cross-supervisor-execution-draft/v1";
  authoritySha256: Sha256Hex;
  campaignLockSha256: Sha256Hex;
  stagedCapabilitySha256: Sha256Hex;
  sourceArchiveSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  candidate: string;
  campaignId: string;
  runId: string;
  executionPurpose: ExecutionPurpose;
  cellId: string;
  scenarioHash: Sha256Hex;
  rolePlanHash: Sha256Hex;
  workloadRolePlanInputSha256: Sha256Hex;
  stagedServerLaunchRecordSha256: Sha256Hex;
  armKind: "primary";
  transport: "ws" | "wt";
  repetitionKind: RepetitionKind;
  repetitionIndex: number;
  repetitionTotal: number;
  grantDeclaration: "phase-a-completed-transfer" | "fanout-expanded-deliveries";
  declaredMessageCount: number;
  declaredMessageBytes: number;
  requestedNotAfterMs: number;
}

interface CrossSupervisorExecutionV1 {
  schema: "cross-supervisor-execution/v1";
  draftSha256: Sha256Hex;
  authoritySha256: Sha256Hex;
  campaignLockSha256: Sha256Hex;
  stagedCapabilitySha256: Sha256Hex;
  sourceArchiveSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  candidate: string;
  campaignId: string;
  runId: string;
  executionIndex: number;
  executionPurpose: ExecutionPurpose;
  cellId: string;
  scenarioHash: Sha256Hex;
  rolePlanHash: Sha256Hex;
  workloadRolePlanInputSha256: Sha256Hex;
  stagedServerLaunchRecordSha256: Sha256Hex;
  armKind: "primary";
  transport: "ws" | "wt";
  repetitionKind: RepetitionKind;
  repetitionIndex: number;
  repetitionTotal: number;
  grantDeclaration: "phase-a-completed-transfer" | "fanout-expanded-deliveries";
  declaredMessageCount: number;
  declaredMessageBytes: number;
  measurementGrantSha256: Sha256Hex;
  macSupervisorInstanceNonce: Sha256Hex;
  issuedAtMs: number;
  notAfterMs: number;
}

Exact-key fixture `cross_supervisor_execution_rejects_duplicate_or_missing_keys` encodes one canonical `CrossSupervisorExecutionV1` with exactly one occurrence of each field above, then rejects missing, additional, and duplicate JSON keys.

interface MacExecutionGrantReceiptV1 {
  schema: "mac-execution-grant-receipt/v1";
  execution: CrossSupervisorExecutionV1;
  executionSha256: Sha256Hex;
  measurementGrantSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  macSupervisorExecutableSha256: Sha256Hex;
  macSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}

interface MacReceiptSignatureV1 {
  schema: "mac-receipt-signature/v1";
  algorithm: "Ed25519";
  signedSchema:
    | "mac-execution-grant-receipt/v1"
    | "cohort-grant/v1"
    | "cohort-warmup-epoch/v1"
    | "role-warmup-completion-manifest/v1"
    | "cohort-start-barrier/v1"
    | "mac-measurement-admission/v1"
    | "cohort-admission-receipt/v1";
  signedBytesSha256: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  signatureBase64: Base64;
}

interface RigReceiptSignatureV1 {
  schema: "rig-receipt-signature/v1";
  algorithm: "Ed25519";
  signedSchema:
    | "rig-execution-acceptance/v1"
    | "rig-cohort-acceptance/v1"
    | "rig-measure-start-ack/v1"
    | "rig-warmup-drained-receipt/v1"
    | "rig-barrier-acceptance/v1"
    | "rig-server-snapshot-receipt/v1"
    | "rig-relay-observation-receipt/v1";
  signedBytesSha256: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  signatureBase64: Base64;
}

interface RigExecutionAcceptanceV1 {
  schema: "rig-execution-acceptance/v1";
  executionSha256: Sha256Hex;
  measurementGrantSha256: Sha256Hex;
  macExecutionGrantReceiptSha256: Sha256Hex;
  macReceiptSignatureSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  rigExecutionIndex: number;
  rigSupervisorInstanceNonce: Sha256Hex;
  rigSupervisorExecutableSha256: Sha256Hex;
  replayLedgerLeafSha256: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  acceptedAtMs: number;
  issuedAtMs: number;
  notAfterMs: number;
}
```

`MacOpenExecutionRequestV1` carries only `CrossSupervisorExecutionDraftV1`. The Mac validates the draft, assigns the next durable `executionIndex`, mints `MeasurementGrantV1`, constructs `CrossSupervisorExecutionV1`, and returns the retained draft, grant, final execution receipt, and signature. The controller never supplies `executionIndex`, `measurementGrantSha256`, Mac nonce, `issuedAtMs`, or final `notAfterMs`.

`MeasurementGrantV1` remains the supervisor-minted exact-key record, but A3 adds `approvedPlanSha256`, `approvalRecordSha256`, `executionPurpose`, `cellId`, `scenarioHash`, `armKind`, `repetitionKind`, `repetitionIndex`, `repetitionTotal`, `grantDeclaration`, `declaredMessageCount`, and `declaredMessageBytes`. `MacExecutionGrantReceiptV1.measurementGrantSha256` equals the retained grant digest; there is no parallel controller-authored grant nonce. Declaration equations are exact:

- Phase A `bulk-one-way/physical`: `grantDeclaration="phase-a-completed-transfer"`, `declaredMessageCount=1600`, and `declaredMessageBytes=104857600` (100 MiB / 65,536-byte chunks).
- Every Phase B fanout arm: `grantDeclaration="fanout-expanded-deliveries"`, `declaredMessageCount=CohortGrantV1.expectedExpandedDeliveries`, and `declaredMessageBytes=declaredMessageCount * CohortGrantV1.messageBytes`. `expectedOfferedIngress` is retained separately and MUST NOT be substituted for `declaredMessageCount`.

Wrong ingress-versus-expanded declarations, arithmetic overflow, or a draft/final/grant mismatch fails before traffic with `FAIL/CROSS_SUPERVISOR_MISMATCH`.

### 3.2 Complete Phase A receipt bytes retained in every sealed artifact

```ts
interface MacMeasurementAdmissionReceiptV1 {
  schema: "mac-measurement-admission/v1";
  executionSha256: Sha256Hex;
  measurementGrantSha256: Sha256Hex;
  macExecutionGrantReceiptSha256: Sha256Hex;
  rigExecutionAcceptanceSha256: Sha256Hex;
  rigExecutionAcceptanceSignatureSha256: Sha256Hex;
  admittedClientSeriesSha256: Sha256Hex;
  rigMeasureStartAckSha256: Sha256Hex;
  rigMeasureStartAckSignatureSha256: Sha256Hex;
  rigBarrierAcceptanceSha256: Sha256Hex | null;
  rigBarrierAcceptanceSignatureSha256: Sha256Hex | null;
  rigServerSnapshotReceiptSha256: Sha256Hex;
  rigServerSnapshotReceiptSignatureSha256: Sha256Hex;
  snapshotFrameSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex | null;
  cohortStartBarrierSha256: Sha256Hex | null;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  campaignId: string;
  runId: string;
  executionIndex: number;
  transport: "ws" | "wt";
  sampleUnit: "ms" | "Mbps" | "count";
  sampleCount: number;
  delivered: number;
  firstSampleAtMs: number;
  lastSampleAtMs: number;
  spanMs: number;
  frameAcceptedAtMs: number;
  macSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}

interface RigServerSnapshotReceiptV1 {
  schema: "rig-server-snapshot-receipt/v1";
  executionSha256: Sha256Hex;
  measurementGrantSha256: Sha256Hex;
  macExecutionGrantReceiptSha256: Sha256Hex;
  rigExecutionAcceptanceSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex | null;
  cohortStartBarrierSha256: Sha256Hex | null;
  roleTokenCommitmentRootSha256: Sha256Hex | null;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  rigExecutionIndex: number;
  rigSupervisorInstanceNonce: Sha256Hex;
  snapshotFrameSha256: Sha256Hex;
  snapshotFrameSize: number;
  childPid: number;
  childPgid: number;
  childInstanceNonce: Sha256Hex;
  serverEntrypointSha256: Sha256Hex;
  bunSha256: Sha256Hex;
  addonSha256: Sha256Hex;
  childResponseSequence: number;
  captureRequestSequence: number;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  frameReceivedAtRigNs: NsString;
  issuedAtMs: number;
  notAfterMs: number;
}

interface ServerObservationEvidenceV1 {
  schema: "server-observation-evidence/v1";
  provenance: "server-child-observed/rig-supervisor-admitted/mac-supervisor-joined";
  workloadRolePlanInput: RetainedCanonicalBytesV1;
  stagedServerLaunchRecord: RetainedCanonicalBytesV1;
  executionDraftBase64: Base64;
  executionDraftSha256: Sha256Hex;
  executionDraftSize: number;
  measurementGrantBase64: Base64;
  measurementGrantSha256: Sha256Hex;
  measurementGrantSize: number;
  macExecutionGrantReceiptBase64: Base64;
  macExecutionGrantReceiptSha256: Sha256Hex;
  macExecutionGrantReceiptSize: number;
  macExecutionGrantSignatureBase64: Base64;
  macExecutionGrantSignatureSha256: Sha256Hex;
  macExecutionGrantSignatureSize: number;
  macMeasurementAdmissionReceiptBase64: Base64;
  macMeasurementAdmissionReceiptSha256: Sha256Hex;
  macMeasurementAdmissionReceiptSize: number;
  macMeasurementAdmissionSignatureBase64: Base64;
  macMeasurementAdmissionSignatureSha256: Sha256Hex;
  macMeasurementAdmissionSignatureSize: number;
  admittedClientSeriesBase64: Base64;
  admittedClientSeriesSha256: Sha256Hex;
  admittedClientSeriesSize: number;
  rigExecutionAcceptanceBase64: Base64;
  rigExecutionAcceptanceSha256: Sha256Hex;
  rigExecutionAcceptanceSize: number;
  rigExecutionAcceptanceSignatureBase64: Base64;
  rigExecutionAcceptanceSignatureSha256: Sha256Hex;
  rigExecutionAcceptanceSignatureSize: number;
  rigMeasureStartAckBase64: Base64;
  rigMeasureStartAckSha256: Sha256Hex;
  rigMeasureStartAckSize: number;
  rigMeasureStartAckSignatureBase64: Base64;
  rigMeasureStartAckSignatureSha256: Sha256Hex;
  rigMeasureStartAckSignatureSize: number;
  rigBarrierAcceptanceBase64: Base64 | null;
  rigBarrierAcceptanceSha256: Sha256Hex | null;
  rigBarrierAcceptanceSize: number | null;
  rigBarrierAcceptanceSignatureBase64: Base64 | null;
  rigBarrierAcceptanceSignatureSha256: Sha256Hex | null;
  rigBarrierAcceptanceSignatureSize: number | null;
  snapshotFrameBase64: Base64;
  snapshotFrameSha256: Sha256Hex;
  snapshotFrameSize: number;
  rigServerSnapshotReceiptBase64: Base64;
  rigServerSnapshotReceiptSha256: Sha256Hex;
  rigServerSnapshotReceiptSize: number;
  rigServerSnapshotReceiptSignatureBase64: Base64;
  rigServerSnapshotReceiptSignatureSha256: Sha256Hex;
  rigServerSnapshotReceiptSignatureSize: number;
}
```

Decoded caps are: execution draft 16 KiB; measurement grant 16 KiB; Mac execution receipt 32 KiB; every Mac or rig signature record 4 KiB; Mac measurement admission 32 KiB; admitted client series 256 KiB; rig acceptance/start ack/barrier acceptance/snapshot receipt 32 KiB each; snapshot frame 16 KiB; entire `ServerObservationEvidenceV1` decoded payload 640 KiB and encoded JSON 896 KiB. Each encoded length is checked before decode, each decoded length is charged to the per-execution 1 MiB evidence budget before allocation, and exact size/hash is then checked. Hash-only evidence is invalid.

The Mac supervisor first admits and retains the client-series bytes but does not issue the final measurement admission receipt. After the controller presents the exact rig acceptance, snapshot frame, and rig receipt, the Mac supervisor verifies every join, emits and signs `MacMeasurementAdmissionReceiptV1`, and closes its execution. The artifact builder cannot accept an unsigned or provisional admission.

The offline verifier decodes every field, recomputes every size and digest, verifies every Mac signature against `mac-supervisor-ed25519.pub` and every rig signature against `rig-supervisor-ed25519.pub`, and requires equality across authority, lock, capability, source archive, approved plan, approval record, candidate, campaign, run, execution index, purpose, cell, scenario, arm, transport, repetition kind/index/total, declared workload, grant expiry, rig execution, baseline ack, optional barrier acceptance, child PID/PGID/nonce/binaries, snapshot values, and client series. `rawSidecarDigests.client` equals `admittedClientSeriesSha256`; `.server` equals `snapshotFrameSha256`. Repeated-`f`, controller-zero, unauthenticated-rig, and hash-only production paths are deleted.

### 3.3 Remote control framing: controller to Mac and controller to rig

Remote controller/supervisor traffic continues to use the existing `comparison-supervisor-frame/v1` codec only:

```text
u32be headerLength (1..65536)
canonical header JSON + LF, exact keys {kind,schema}
u64be payloadLength (bounded per kind)
payload bytes
32-byte SHA-256(payload bytes)
```

The payload is one exact canonical interface below. This is not the child-pipe codec. Each physical controller->supervisor direction has `requestSeq` starting at 0; each supervisor->controller direction has independent `responseSeq` starting at 0. Responses echo `ackRequestSeq`. A skipped, repeated, stale, or out-of-state value fails. One remote channel carries one open execution and at most 192 frames; payload cap is 1 MiB except the admitted series (256 KiB), the warmup-manifest export (384 KiB encoded / 256 KiB decoded), and `MacCohortEvidenceExportedAckV1` (14 MiB encoded / 9 MiB decoded, charged against a 20 MiB per-execution evidence budget before allocation). Header kind must match payload schema. The exhaustive remote refusal is:

For every interface in this section, `header.schema` is exactly `comparison-supervisor-frame/v1` and `header.kind` is exactly the payload `schema` with the terminal `/v1` removed; for example `mac-open-execution-request/v1` uses `mac-open-execution-request`. The refusal kind is `remote-supervisor-refusal`. No alias kind is accepted.

```ts
type RemoteSupervisorRefusalCode = CampaignRefusalCode | CampaignFailureCode;

interface RemoteSupervisorRefusalV1 {
  schema: "remote-supervisor-refusal/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex | null;
  code: RemoteSupervisorRefusalCode;
  campaignStatus: "FAIL" | "REFUSED";
  terminal: true;
}
```

Controller -> Mac requests and Mac -> controller acknowledgements are exactly:

```ts
interface MacOpenExecutionRequestV1 {
  schema: "mac-open-execution-request/v1";
  requestSeq: number;
  executionDraftSha256: Sha256Hex;
  executionDraftBase64: Base64;
}
interface MacExecutionOpenedAckV1 {
  schema: "mac-execution-opened-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  executionDraftBase64: Base64;
  measurementGrantBase64: Base64;
  macExecutionGrantReceiptBase64: Base64;
  macExecutionGrantSignatureBase64: Base64;
}
interface MacPresentRigExecutionAcceptanceRequestV1 {
  schema: "mac-present-rig-execution-acceptance-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  rigExecutionAcceptanceBase64: Base64;
  rigExecutionAcceptanceSignatureBase64: Base64;
}
interface MacRigExecutionAcceptanceAckV1 {
  schema: "mac-rig-execution-acceptance-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  rigExecutionAcceptanceSha256: Sha256Hex;
  rigServerMaySpawn: true;
}
interface MacAdmitClientSeriesRequestV1 {
  schema: "mac-admit-client-series-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  admittedClientSeriesBase64: Base64;
}
interface MacClientSeriesAdmittedAckV1 {
  schema: "mac-client-series-admitted-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  admittedClientSeriesSha256: Sha256Hex;
  provisional: true;
}
interface MacOpenCohortRequestV1 {
  schema: "mac-open-cohort-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  scenarioHash: Sha256Hex;
  rolePlanHash: Sha256Hex;
  workloadRolePlanInputBase64: Base64;
  workloadRolePlanInputSha256: Sha256Hex;
  workloadRolePlanInputSize: number;
}
interface MacCohortOpenedAckV1 {
  schema: "mac-cohort-opened-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  cohortGrantBase64: Base64;
  cohortGrantSha256: Sha256Hex;
  cohortGrantSignatureBase64: Base64;
}
interface MacPresentRigCohortAcceptanceRequestV1 {
  schema: "mac-present-rig-cohort-acceptance-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  rigCohortAcceptanceBase64: Base64;
  rigCohortAcceptanceSignatureBase64: Base64;
}
interface MacRigCohortAcceptanceAckV1 {
  schema: "mac-rig-cohort-acceptance-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  rigCohortAcceptanceSha256: Sha256Hex;
}
interface MacIssueWarmupEpochRequestV1 {
  schema: "mac-issue-warmup-epoch-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  rigCohortAcceptanceSha256: Sha256Hex;
}
interface MacWarmupEpochIssuedAckV1 {
  schema: "mac-warmup-epoch-issued-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochBase64: Base64;
  cohortWarmupEpochSignatureBase64: Base64;
}
interface MacExportWarmupCompletionManifestRequestV1 {
  schema: "mac-export-warmup-completion-manifest-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
}
interface MacWarmupCompletionManifestExportedAckV1 {
  schema: "mac-warmup-completion-manifest-exported-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  roleWarmupCompletionManifestBase64: Base64;
  roleWarmupCompletionManifestSha256: Sha256Hex;
  roleWarmupCompletionManifestSize: number;
  roleWarmupCompletionManifestSignatureBase64: Base64;
  roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
  entryCount: number;
  terminalWarmupExport: true;
}
interface MacIssueStartBarrierRequestV1 {
  schema: "mac-issue-start-barrier-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  rigWarmupDrainedReceiptBase64: Base64;
  rigWarmupDrainedReceiptSignatureBase64: Base64;
  rigMeasureStartAckBase64: Base64;
  rigMeasureStartAckSignatureBase64: Base64;
}
interface MacStartBarrierIssuedAckV1 {
  schema: "mac-start-barrier-issued-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierBase64: Base64;
  cohortStartBarrierSha256: Sha256Hex;
  cohortStartBarrierSignatureBase64: Base64;
}
interface MacPresentRigBarrierAcceptanceRequestV1 {
  schema: "mac-present-rig-barrier-acceptance-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  rigBarrierAcceptanceBase64: Base64;
  rigBarrierAcceptanceSignatureBase64: Base64;
}
interface MacRigBarrierAcceptanceAckV1 {
  schema: "mac-rig-barrier-acceptance-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  rigBarrierAcceptanceSha256: Sha256Hex;
  roleChildrenMayArm: true;
}
interface MacPresentRigObservationRequestV1 {
  schema: "mac-present-rig-observation-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  rigExecutionAcceptanceBase64: Base64;
  rigExecutionAcceptanceSignatureBase64: Base64;
  rigMeasureStartAckBase64: Base64;
  rigMeasureStartAckSignatureBase64: Base64;
  rigBarrierAcceptanceBase64: Base64 | null;
  rigBarrierAcceptanceSignatureBase64: Base64 | null;
  serverWarmupDrainedBase64: Base64 | null;
  serverStartBarrierAcceptedBase64: Base64 | null;
  snapshotFrameBase64: Base64;
  rigServerSnapshotReceiptBase64: Base64;
  rigServerSnapshotReceiptSignatureBase64: Base64;
  linuxRelayObservationBase64: Base64 | null;
  rigRelayObservationReceiptBase64: Base64 | null;
  rigRelayObservationReceiptSignatureBase64: Base64 | null;
}
interface MacMeasurementAdmissionIssuedAckV1 {
  schema: "mac-measurement-admission-issued-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  macMeasurementAdmissionReceiptBase64: Base64;
  macMeasurementAdmissionSignatureBase64: Base64;
  cohortAdmissionReceiptBase64: Base64 | null;
  cohortAdmissionSignatureBase64: Base64 | null;
}
interface MacExportCohortEvidenceRequestV1 {
  schema: "mac-export-cohort-evidence-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortAdmissionReceiptSha256: Sha256Hex;
}
interface MacCohortEvidenceExportedAckV1 {
  schema: "mac-cohort-evidence-exported-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  cohortObservationEvidenceBase64: Base64;
  cohortObservationEvidenceSha256: Sha256Hex;
  cohortObservationEvidenceSize: number;
  terminalExport: true;
}
interface MacTeardownExecutionRequestV1 {
  schema: "mac-teardown-execution-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
}
interface MacExecutionStoppedAckV1 {
  schema: "mac-execution-stopped-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  childCount: number;
  allReaped: true;
}
```

Controller -> rig requests and rig -> controller acknowledgements are exactly:

```ts
interface RigAcceptExecutionRequestV1 {
  schema: "rig-accept-execution-request/v1";
  requestSeq: number;
  measurementGrantBase64: Base64;
  macExecutionGrantReceiptBase64: Base64;
  macExecutionGrantSignatureBase64: Base64;
}
interface RigExecutionAcceptedAckV1 {
  schema: "rig-execution-accepted-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  rigExecutionAcceptanceBase64: Base64;
  rigExecutionAcceptanceSignatureBase64: Base64;
}
interface RigAcceptCohortRequestV1 {
  schema: "rig-accept-cohort-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortGrantBase64: Base64;
  cohortGrantSignatureBase64: Base64;
}
interface RigCohortAcceptedAckV1 {
  schema: "rig-cohort-accepted-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  rigCohortAcceptanceBase64: Base64;
  rigCohortAcceptanceSignatureBase64: Base64;
}
interface RigSpawnServerRequestV1 {
  schema: "rig-spawn-server-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex | null;
  serverEntrypointSha256: Sha256Hex;
  bunSha256: Sha256Hex;
  addonSha256: Sha256Hex;
  stagedServerLaunchRecordBase64: Base64;
  stagedServerLaunchRecordSha256: Sha256Hex;
  stagedServerLaunchRecordSize: number;
  bindAddress: "10.99.0.2";
  bindPort: number;
  advertisedHost: "10.99.0.2";
  tlsServerName: "wt-compare.local";
  transport: "ws" | "wt";
  serverArgv: string[];
}
interface RigServerReadyAckV1 {
  schema: "rig-server-ready-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  childPid: number;
  childPgid: number;
  childInstanceNonce: Sha256Hex;
  serverReadyFrameSha256: Sha256Hex;
}
interface RigBeginWarmupRequestV1 {
  schema: "rig-begin-warmup-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochBase64: Base64;
  cohortWarmupEpochSignatureBase64: Base64;
}
interface RigWarmupReadyAckV1 {
  schema: "rig-warmup-ready-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  serverWarmupReadySha256: Sha256Hex;
}
interface RigFinishWarmupRequestV1 {
  schema: "rig-finish-warmup-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  roleWarmupCompletionManifestBase64: Base64;
  roleWarmupCompletionManifestSignatureBase64: Base64;
}
interface RigWarmupDrainedAckV1 {
  schema: "rig-warmup-drained-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  serverWarmupDrainedBase64: Base64;
  serverWarmupDrainedSha256: Sha256Hex;
  serverWarmupDrainedSize: number;
  rigWarmupDrainedReceiptBase64: Base64;
  rigWarmupDrainedReceiptSignatureBase64: Base64;
}
interface RigMeasureStartRequestV1 {
  schema: "rig-measure-start-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex | null;
  warmupCompleteSha256: Sha256Hex | null;
  rigWarmupDrainedReceiptSha256: Sha256Hex | null;
}
interface RigMeasureStartAckV1 {
  schema: "rig-measure-start-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  childResponseSequence: number;
  baselineBusyMs: number;
  baselineAtLinuxNs: NsString;
  linuxClockId: string;
  warmupCompletionAuthoritySha256: Sha256Hex | null;
  rigWarmupDrainedReceiptSha256: Sha256Hex | null;
  signingPublicKeySha256: Sha256Hex;
  rigSupervisorInstanceNonce: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}
interface RigMeasureStartedAckV1 {
  schema: "rig-measure-started-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  rigMeasureStartAckBase64: Base64;
  rigMeasureStartAckSignatureBase64: Base64;
}
interface RigPresentStartBarrierRequestV1 {
  schema: "rig-present-start-barrier-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierBase64: Base64;
  cohortStartBarrierSignatureBase64: Base64;
}
interface RigBarrierAcceptedAckV1 {
  schema: "rig-barrier-accepted-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  serverStartBarrierAcceptedBase64: Base64;
  serverStartBarrierAcceptedSha256: Sha256Hex;
  serverStartBarrierAcceptedSize: number;
  rigBarrierAcceptanceBase64: Base64;
  rigBarrierAcceptanceSignatureBase64: Base64;
}
interface RigStopAndCaptureRequestV1 {
  schema: "rig-stop-and-capture-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex | null;
  macStopIssuedAtNs: NsString;
  drainDeadlineMs: number;
}
interface RigCaptureCompleteAckV1 {
  schema: "rig-capture-complete-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  snapshotFrameBase64: Base64;
  rigServerSnapshotReceiptBase64: Base64;
  rigServerSnapshotReceiptSignatureBase64: Base64;
  linuxRelayObservationBase64: Base64 | null;
  rigRelayObservationReceiptBase64: Base64 | null;
  rigRelayObservationReceiptSignatureBase64: Base64 | null;
}
interface RigTeardownServerRequestV1 {
  schema: "rig-teardown-server-request/v1";
  requestSeq: number;
  executionSha256: Sha256Hex;
}
interface RigServerStoppedAckV1 {
  schema: "rig-server-stopped-ack/v1";
  responseSeq: number;
  ackRequestSeq: number;
  executionSha256: Sha256Hex;
  exitCode: number | null;
  signal: string | null;
  reaped: true;
}

type RemoteSupervisorPayloadV1 =
  | RemoteSupervisorRefusalV1
  | MacOpenExecutionRequestV1
  | MacExecutionOpenedAckV1
  | MacPresentRigExecutionAcceptanceRequestV1
  | MacRigExecutionAcceptanceAckV1
  | MacAdmitClientSeriesRequestV1
  | MacClientSeriesAdmittedAckV1
  | MacOpenCohortRequestV1
  | MacCohortOpenedAckV1
  | MacPresentRigCohortAcceptanceRequestV1
  | MacRigCohortAcceptanceAckV1
  | MacIssueWarmupEpochRequestV1
  | MacWarmupEpochIssuedAckV1
  | MacExportWarmupCompletionManifestRequestV1
  | MacWarmupCompletionManifestExportedAckV1
  | MacIssueStartBarrierRequestV1
  | MacStartBarrierIssuedAckV1
  | MacPresentRigBarrierAcceptanceRequestV1
  | MacRigBarrierAcceptanceAckV1
  | MacPresentRigObservationRequestV1
  | MacMeasurementAdmissionIssuedAckV1
  | MacExportCohortEvidenceRequestV1
  | MacCohortEvidenceExportedAckV1
  | MacTeardownExecutionRequestV1
  | MacExecutionStoppedAckV1
  | RigAcceptExecutionRequestV1
  | RigExecutionAcceptedAckV1
  | RigAcceptCohortRequestV1
  | RigCohortAcceptedAckV1
  | RigSpawnServerRequestV1
  | RigServerReadyAckV1
  | RigBeginWarmupRequestV1
  | RigWarmupReadyAckV1
  | RigFinishWarmupRequestV1
  | RigWarmupDrainedAckV1
  | RigMeasureStartRequestV1
  | RigMeasureStartedAckV1
  | RigPresentStartBarrierRequestV1
  | RigBarrierAcceptedAckV1
  | RigStopAndCaptureRequestV1
  | RigCaptureCompleteAckV1
  | RigTeardownServerRequestV1
  | RigServerStoppedAckV1;
```

The warmup control graph has one legal order: Mac returns the signed epoch; controller delivers that exact epoch to the rig and Mac retains it; Mac delivers `RoleWarmupStartV1` with the same exact epoch and signature to every role child; every child completes; controller requests `MacExportWarmupCompletionManifestRequestV1`; Mac returns the one signed manifest in `MacWarmupCompletionManifestExportedAckV1`; only then may controller construct `RigFinishWarmupRequestV1` with those byte-identical manifest/signature bytes. The export is capped at 256 KiB decoded / 384 KiB encoded, consumes exactly the next remote request/response sequence, is one-shot, and is retained. Missing export, a second export, digest swap, entry reorder, or using a controller-reconstructed manifest fails before Linux drain.

### 3.4 Child-pipe framing, requests, acknowledgements, and refusal

Rig<->server and Mac<->role-child pipes use a distinct codec: `u32be payloadLength || canonical JSON bytes`, with no remote header/digest wrapper. Each direction owns an independent `sequence` starting at 0. Rig/server frames are at most 64 KiB, at most 32 each direction. Role-child control frames are at most 64 KiB, partial frames at most 256 KiB, and the maximum per role direction is `2 * assignedSessionCount + 64` to accommodate the global ramp permit protocol. FD 3 is supervisor->child read-only in the child; FD 4 is child->supervisor write-only in the child. All unused pipe ends are closed before exec. Role children additionally receive no controller FD and no supervisor signing-key FD. Phase B role children receive FD 5 only as the inherited read-only token-bundle descriptor defined in section 4.3; every other unexpected FD fails.

```ts
type ChildPipeRefusalCode =
  | "FRAME_INVALID"
  | "SEQUENCE_INVALID"
  | "STATE_INVALID"
  | "EXECUTION_MISMATCH"
  | "COHORT_MISMATCH"
  | "TOKEN_INVALID"
  | "TOKEN_REPLAY"
  | "BIND_DEADLINE_EXCEEDED"
  | "READY_DEADLINE_EXCEEDED"
  | "WARMUP_DEADLINE_EXCEEDED"
  | "MEASURE_DEADLINE_EXCEEDED"
  | "DRAIN_DEADLINE_EXCEEDED"
  | "TEARDOWN_DEADLINE_EXCEEDED"
  | "UNEXPECTED_EOF"
  | "UNEXPECTED_FD"
  | "RELAY_CAPACITY_EXCEEDED"
  | "PROCESS_RESOURCE_EXHAUSTED"
  | "CHILD_LIFECYCLE";

interface ChildPipeRefusalV1 {
  schema: "child-pipe-refusal/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  code: ChildPipeRefusalCode;
  terminal: true;
}

interface ServerBindExecutionV1 {
  schema: "server-bind-execution/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  rigExecutionAcceptanceSha256: Sha256Hex;
  cohortGrantBase64: Base64 | null;
}
interface ServerReadyV1 {
  schema: "server-ready/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  childPid: number;
  childPgid: number;
  childInstanceNonce: Sha256Hex;
  cohortGrantSha256: Sha256Hex | null;
  listeningAddress: string;
}
interface ServerWarmupStartV1 {
  schema: "server-warmup-start/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochBase64: Base64;
  cohortWarmupEpochSignatureBase64: Base64;
}
interface ServerWarmupReadyV1 {
  schema: "server-warmup-ready/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  warmupCountersZero: true;
}
interface ServerWarmupDrainAndResetV1 {
  schema: "server-warmup-drain-and-reset/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  roleWarmupCompletionManifestSha256: Sha256Hex;
}
interface ServerWarmupDrainedV1 {
  schema: "server-warmup-drained/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  roleWarmupCompletionManifestSha256: Sha256Hex;
  warmupIngress: number;
  warmupDeliveries: number;
  publisherWarmupEndCount: number;
  subscriberWarmupEndCount: number;
  warmupQueuesEmpty: true;
  measuredCountersZero: true;
  drainedAtLinuxNs: NsString;
  linuxClockId: string;
}
interface ServerMeasureStartV1 {
  schema: "server-measure-start/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  warmupCompleteSha256: Sha256Hex | null;
}
interface ServerMeasureStartAckV1 {
  schema: "server-measure-start-ack/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  baselineBusyMs: number;
  baselineAtLinuxNs: NsString;
  linuxClockId: string;
}
interface ServerPresentStartBarrierV1 {
  schema: "server-present-start-barrier/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierBase64: Base64;
  cohortStartBarrierSignatureBase64: Base64;
}
interface ServerStartBarrierAcceptedV1 {
  schema: "server-start-barrier-accepted/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  acceptedAtLinuxNs: NsString;
  linuxClockId: string;
  measuredTrafficAllowed: true;
}
interface ServerStopAndCaptureV1 {
  schema: "server-stop-and-capture/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex | null;
  drainDeadlineMs: number;
}
interface ServerCaptureAckV1 {
  schema: "server-capture-ack/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  snapshotFrame: ServerLoopUtilizationFrameV1;
  linuxRelayObservation: LinuxRelayObservationV1 | null;
}
interface ServerTeardownV1 {
  schema: "server-teardown/v1";
  sequence: number;
  executionSha256: Sha256Hex;
}
interface ServerStoppedV1 {
  schema: "server-stopped/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  exitCode: number;
  allSessionsClosed: true;
}

interface ServerLoopUtilizationFrameV1 {
  schema: "server-loop-utilization/v1";
  executionSha256: Sha256Hex;
  cellId: string;
  scenarioHash: Sha256Hex;
  cohortGrantSha256: Sha256Hex | null;
  cohortStartBarrierSha256: Sha256Hex | null;
  roleTokenCommitmentRootSha256: Sha256Hex | null;
  transport: "ws" | "wt";
  repetitionKind: RepetitionKind;
  repetitionIndex: number;
  repetitionTotal: number;
  childPid: number;
  childPgid: number;
  childInstanceNonce: Sha256Hex;
  baselineBusyMs: number;
  finalBusyMs: number;
  busyMs: number;
  baselineAtLinuxNs: NsString;
  finalSnapshotAtLinuxNs: NsString;
  windowMs: number;
  linuxClockId: string;
  allMeasuredSessionsClosed: true;
  bulkSourceCompletion: BulkSourceCompletionV1 | null;
}

interface BulkSourceCompletionV1 {
  schema: "bulk-source-completion/v1";
  executionSha256: Sha256Hex;
  direction: "linux-to-mac";
  serverRole: "bulk-source";
  channelMapping: "server-opened-uni";
  scheduledChunkCount: 1600;
  chunksWritten: 1600;
  chunkBytes: 65536;
  bytesWritten: 104857600;
  payloadSha256: Sha256Hex;
  firstWriteAtLinuxNs: NsString;
  channelEndedAtLinuxNs: NsString;
  linuxClockId: string;
  channelEnded: true;
}

interface BulkSinkSeriesV1 {
  schema: "bulk-sink-series/v1";
  executionSha256: Sha256Hex;
  direction: "linux-to-mac";
  clientRole: "sink";
  channelMapping: "server-opened-uni";
  scheduledChunkCount: 1600;
  receivedScheduleChunkCount: 1600;
  transportReadCount: number;
  chunkBytes: 65536;
  bytesReceived: 104857600;
  payloadSha256: Sha256Hex;
  sampleUnit: "Mbps";
  samples: [number];
  firstByteAtMacNs: NsString;
  lastByteAtMacNs: NsString;
  spanMs: number;
  channelEofSeen: true;
}
```

`busyMs = finalBusyMs - baselineBusyMs`. `windowMs = (finalSnapshotAtLinuxNs - baselineAtLinuxNs) / 1_000_000` on the same Linux clock. It deliberately includes post-baseline barrier/control latency, measured traffic, drain, and session-close callbacks; it excludes readiness and the five-second in-repetition warmup. WS and WT use this identical bracket. It is aggregate work context, not a saturation percentage.

### 3.5 Deadlines, EOF, and remote/child transitions

| Transition | Deadline | Failure |
|---|---:|---|
| Mac open/sign execution | 5 s | `FAIL/TRUST_PROTOCOL`; a parsed signature/key/approval/expiry/replay refusal retains its typed section 3.1 code instead |
| Rig signature/expiry/replay acceptance | 5 s | typed Mac grant failure |
| Rig child spawn + ready | 15 s Phase A; cell readiness deadline Phase B | `FAIL/CHILD_LIFECYCLE` or `FAIL/COHORT_NOT_READY` |
| Any remote frame write/read | 5 s, except cohort evidence export 20 s | `FAIL/TRUST_PROTOCOL` |
| Any child control write/ack | 5 s | `FAIL/CHILD_LIFECYCLE` |
| In-repetition warmup | exactly 5,000 ms + 1 s ack grace | `FAIL/WARMUP_PROTOCOL` |
| Phase A completed transfer | Linux source writes 1,600 chunks / 104,857,600 bytes to Mac sink; 600 s transfer deadline, then 1 s stop grace | `FAIL/MEASUREMENT_WINDOW` |
| One Phase A execution envelope | 720 s from Mac open through both supervisor teardowns | preserve the first typed failure; envelope expiry is `FAIL/MEASUREMENT_WINDOW` before completion or `FAIL/CHILD_LIFECYCLE` afterward |
| Phase B measured traffic | declared 10,000 or 30,000 ms + 1 s stop grace | `FAIL/MEASUREMENT_WINDOW` |
| Relay drain/session close | 10 s | `FAIL/RELAY_DELIVERY` |
| Snapshot/receipt | 5 s after close | `FAIL/TRUST_PROTOCOL` |
| Graceful child teardown | 10 s | `FAIL/CHILD_LIFECYCLE` |
| SIGTERM grace | 5 s | continue to SIGKILL |
| SIGKILL + waitpid reap | 5 s | `FAIL/CHILD_LIFECYCLE` |

EOF is legal only after the corresponding `*StoppedV1`/`*StoppedAckV1`. EOF before an expected frame, a second snapshot/partial, bytes after terminal, unexpected FD inheritance, wrong state, or deadline is terminal `FAIL`. Remote refusal is `REFUSED` only while still in the preflight state and only for the three environmental codes in the failure table.

The 720 s Phase A envelope is a fail-closed outer bound over the existing inner deadlines: 35 s open/accept/spawn and cross-supervisor presentation, 10 s baseline plus delayed sink arm, 600 s source-to-sink transfer, 1 s stop grace, 10 s close/drain, 10 s snapshot/join, 20 s graceful/SIGTERM/SIGKILL teardown, and 34 s scheduling allowance. Inner deadlines still fire first. A5 schedules exactly four serial executions—WS warmup, WS measured, WT warmup, WT measured—so the execution maximum is `4 * 720 = 2,880 s`. Controller preflight/readiness receives 120 s outside those envelopes, yielding a 3,000 s computed controller worst case; `--campaign-timeout-ms=3600000` provides 600 s fail-closed slack. Recursive success or integrity-only verification gets 180 s, rendering gets 120 s, and two-host cleanup gets 30 s. The frozen focused command therefore has `RUN_TIMEOUT_MS=4200000` (70 minutes), which covers `3,600 + 180 + 120 + 30 = 3,930 s` plus 270 s wrapper slack. The authority preflight requires strictly more than `RUN_TIMEOUT_MS + 5,400,000` ms, so the 20-hour authority remains consistent. Tests advance a fake clock through every inner maximum for all four executions and prove completion at 3,930 s is accepted, 4,200 s is the frozen outer bound, and any direction reversal or 1 ms over an inner/outer deadline fails.

## 4. Phase B frozen fanout contracts

### 4.1 Pre-readiness grant, token commitments, and post-readiness barrier

The Mac supervisor mints tokens with 32 random bytes. Each registration token commitment is a Merkle leaf over canonical `TokenCommitmentLeafV1` bytes. Leaves are ordered by `role` (`publisher` then `subscriber`) and numeric role ID. Leaf node is `SHA256(0x00 || leafSha256Bytes)`; internal node is `SHA256(0x01 || left || right)`; an odd last node is paired with itself. The signed grant carries the manifest digest, root, and count. Registration carries the raw token, leaf index, and sibling array. Linux recomputes the proof, checks role/shard fields, and spends `tokenSha256` once.

```ts
interface PublisherRoleGrantV1 {
  schema: "publisher-role-grant/v1";
  childId: string;
  publisherId: string;
  tokenCommitmentIndex: number;
  tokenSha256: Sha256Hex;
}
interface SubscriberShardV1 {
  schema: "subscriber-shard/v1";
  childId: string;
  workerIndex: number;
  modulus: 8;
  residue: number;
  firstSubscriberIndex: 0;
  lastSubscriberIndexExclusive: number;
  subscriberCount: number;
  orderedSubscriberIdsSha256: Sha256Hex;
  firstTokenCommitmentIndex: number;
  lastTokenCommitmentIndexExclusive: number;
}
interface TokenCommitmentLeafV1 {
  schema: "token-commitment-leaf/v1";
  childId: string;
  cohortId: string;
  role: "publisher" | "subscriber";
  roleId: string;
  tokenSha256: Sha256Hex;
  workerIndex: number | null;
}
interface TokenCommitmentLeafManifestV1 {
  schema: "token-commitment-leaf-manifest/v1";
  executionSha256: Sha256Hex;
  cohortId: string;
  leafCount: number;
  leaves: TokenCommitmentLeafV1[];
  roleTokenCommitmentRootSha256: Sha256Hex;
}
interface CohortGrantV1 {
  schema: "cohort-grant/v1";
  execution: CrossSupervisorExecutionV1;
  executionSha256: Sha256Hex;
  macExecutionGrantReceiptSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  cohortId: string;
  cohortAttempt: number;
  scenarioHash: Sha256Hex;
  rolePlanHash: Sha256Hex;
  workloadRolePlanInputSha256: Sha256Hex;
  transport: "ws" | "wt";
  publisherCount: number;
  subscriberCount: number;
  workerCount: 8;
  expectedProcessCount: number;
  expectedSessionCount: number;
  publishers: PublisherRoleGrantV1[];
  subscriberShards: SubscriberShardV1[];
  tokenCommitmentLeafManifestSha256: Sha256Hex;
  roleTokenCommitmentRootSha256: Sha256Hex;
  roleTokenCommitmentCount: number;
  connectionRatePerSecond: 500;
  maxConnectionsInFlight: 200;
  readinessDeadlineMs: number;
  inRepetitionWarmupMs: 5000;
  sampleWindowMs: 1000;
  measuredDurationMs: 10000 | 30000;
  drainDeadlineMs: 10000;
  messageBytes: 100 | 128;
  expectedOfferedIngress: number;
  expectedExpandedDeliveries: number;
  macSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}
interface RigCohortAcceptanceV1 {
  schema: "rig-cohort-acceptance/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortGrantSignatureSha256: Sha256Hex;
  roleTokenCommitmentRootSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  rigExecutionIndex: number;
  rigSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  acceptedAtMs: number;
  issuedAtMs: number;
  notAfterMs: number;
}
interface CohortWarmupEpochV1 {
  schema: "cohort-warmup-epoch/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortId: string;
  warmupNonce: Sha256Hex;
  durationMs: 5000;
  warmupMessagesPerPublisher: 10;
  warmupIntervalMs: 500;
  expectedWarmupIngress: number;
  expectedWarmupDeliveries: number;
  macSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}
interface RoleWarmupCompletionManifestEntryV1 {
  schema: "role-warmup-completion-manifest-entry/v1";
  order: number;
  childId: string;
  role: "publisher" | "subscriber-worker";
  roleWarmupComplete: RetainedCanonicalBytesV1;
  roleWarmupCompleteSha256: Sha256Hex;
  offeredWarmupIngress: number;
  deliveredWarmupRecords: number;
}
interface RoleWarmupCompletionManifestV1 {
  schema: "role-warmup-completion-manifest/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  entryCount: number;
  entries: RoleWarmupCompletionManifestEntryV1[];
  allRoleChildrenComplete: true;
  completedAtMacNs: NsString;
  macSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}
interface RigWarmupDrainedReceiptV1 {
  schema: "rig-warmup-drained-receipt/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  cohortWarmupEpochSignatureSha256: Sha256Hex;
  roleWarmupCompletionManifestSha256: Sha256Hex;
  roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
  serverWarmupDrainedSha256: Sha256Hex;
  rigSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  receivedAtRigNs: NsString;
  linuxClockId: string;
  issuedAtMs: number;
  notAfterMs: number;
}
interface CohortStartBarrierV1 {
  schema: "cohort-start-barrier/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  rigCohortAcceptanceSha256: Sha256Hex;
  rigMeasureStartAckSha256: Sha256Hex;
  roleWarmupCompletionManifestSha256: Sha256Hex;
  roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
  rigWarmupDrainedReceiptSha256: Sha256Hex;
  cohortId: string;
  barrierNonce: Sha256Hex;
  macClockId: string;
  mintedAtMacNs: NsString;
  warmupStartedAtMacNs: NsString;
  warmupCompletedAtMacNs: NsString;
  measureStartAtMacNs: NsString;
  measureStopAtMacNs: NsString;
  sampleWindowMs: 1000;
  windowCount: 10 | 30;
  measuredDurationMs: 10000 | 30000;
  drainDeadlineMs: 10000;
  macSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}
interface RigBarrierAcceptanceV1 {
  schema: "rig-barrier-acceptance/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  cohortStartBarrierSignatureSha256: Sha256Hex;
  rigMeasureStartAckSha256: Sha256Hex;
  serverStartBarrierAcceptedSha256: Sha256Hex;
  rigSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  acceptedAtLinuxNs: NsString;
  linuxClockId: string;
  issuedAtMs: number;
  notAfterMs: number;
}
```

`CohortGrantV1` is pre-readiness and has no start timestamp. Mac signs its exact bytes. The rig verifies signature/key/expiry/replay before spawning the server and passes the grant in `ServerBindExecutionV1`; server readiness therefore proves the Linux child has the exact role/token root. `CohortWarmupEpochV1` is separately Mac-signed and binds warmup traffic to the grant plus a fresh warmup nonce, never to the not-yet-existing measured barrier. `CohortStartBarrierV1` is minted and Mac-signed only after all role sessions are ready, the exact role warmup manifest and Linux drained/reset ack are retained, and authenticated `RigMeasureStartAckV1` has fixed the Linux baseline. The controller then presents the signed barrier to the rig; the rig presents it to the server child; the child returns `ServerStartBarrierAcceptedV1`; and the rig returns signed `RigBarrierAcceptanceV1`. Mac authenticates that acceptance before it arms role children. No measured `FanoutDataV1` is legal before both Linux barrier acceptance and all role-child start acknowledgements.

Warmup is non-vacuous and identical for every Phase B cell. Each publisher offers exactly 10 ordered warmup messages at offsets `0,500,...,4500 ms` from `startAtMacNs`; no catch-up burst is allowed. Thus `expectedWarmupIngress = publisherCount * 10` and `expectedWarmupDeliveries = expectedWarmupIngress * subscriberCount`, both positive. Each publisher completion has `offeredWarmupIngress=10` and `deliveredWarmupRecords=0`. Worker `w` has `offeredWarmupIngress=0` and `deliveredWarmupRecords = shardSubscriberCount(w) * publisherCount * 10`. The ordered manifest sums must equal the epoch expectations. Linux `ServerWarmupDrainedV1` must satisfy `warmupIngress=expectedWarmupIngress`, `warmupDeliveries=expectedWarmupDeliveries`, and the identical expanded equation `warmupDeliveries=warmupIngress*subscriberCount`, with all end markers received, queues empty, and measured counters/ordinals reset to zero. Zero messages, early/burst pacing, a wrong epoch/nonce, missing/duplicate completion, manifest digest swap, warmup bytes after drain, or any role network traffic before that child has received and verified its exact `RoleWarmupStartV1` is `FAIL/WARMUP_PROTOCOL`.

`readinessDeadlineMs` is fixed by cell: all three ticker cells 30,000; chat 1k 90,000; chat 5k 180,000; chat 10k 300,000. It begins when the Mac supervisor emits the first subscriber connect permit and covers all subscriber and publisher registration/accept frames plus writable-channel readiness.

### 4.2 FanoutWire V1: exact reliable WS and WT mapping

Logical JSON frame bytes use the canonical codec. WS sends one binary WebSocket message containing exactly one logical frame. WT prefixes each logical frame on a reliable stream with `u32be length`; publisher and subscriber control use bidi streams, and each subscriber receives data on one server-opened uni stream. Frame decoded caps are 4 KiB for register/accept/refuse/ack/end and 1 KiB for data. Payload is exactly 100 bytes ticker or 128 bytes chat; its base64 and digest must agree.

```ts
interface FanoutRegisterV1 {
  schema: "fanout-wire/v1";
  kind: "register";
  cohortGrantSha256: Sha256Hex;
  transport: "ws" | "wt";
  role: "publisher" | "subscriber";
  childId: string;
  roleId: string;
  workerIndex: number | null;
  tokenBase64: Base64;
  tokenSha256: Sha256Hex;
  tokenCommitmentIndex: number;
  tokenMerkleProofSha256: Sha256Hex[];
}
interface FanoutAcceptV1 {
  schema: "fanout-wire/v1";
  kind: "accept";
  cohortGrantSha256: Sha256Hex;
  role: "publisher" | "subscriber";
  roleId: string;
  linuxSessionOrdinal: number;
  linuxAcceptedAtNs: NsString;
  linuxClockId: string;
}
interface FanoutRefuseV1 {
  schema: "fanout-wire/v1";
  kind: "refuse";
  cohortGrantSha256: Sha256Hex;
  role: "publisher" | "subscriber";
  roleId: string;
  code: "UNKNOWN_TOKEN" | "TOKEN_REPLAY" | "WRONG_ROLE" | "WRONG_SHARD" | "WRONG_COHORT" | "DUPLICATE_ROLE" | "REGISTRATION_CLOSED" | "FRAME_INVALID";
}
interface FanoutWarmupDataV1 {
  schema: "fanout-wire/v1";
  kind: "warmup-data";
  direction: "publisher-to-relay" | "relay-to-subscriber";
  cohortGrantSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  warmupNonce: Sha256Hex;
  publisherId: string;
  publisherSequence: number;
  subscriberId: string | null;
  linuxAcceptedOrdinal: number | null;
  payloadBase64: Base64;
  payloadSha256: Sha256Hex;
  payloadBytes: 100 | 128;
}
interface FanoutWarmupAckV1 {
  schema: "fanout-wire/v1";
  kind: "warmup-ack";
  cohortGrantSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  warmupNonce: Sha256Hex;
  publisherId: string;
  publisherSequence: number;
  disposition: "accepted";
  linuxAcceptedOrdinal: number;
  linuxAcceptedAtNs: NsString;
}
interface FanoutWarmupEndV1 {
  schema: "fanout-wire/v1";
  kind: "warmup-end";
  cohortGrantSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  warmupNonce: Sha256Hex;
  role: "publisher" | "subscriber";
  roleId: string;
  finalPublisherSequence: number | null;
  reason: "publisher-warmup-complete" | "relay-warmup-drained";
}
interface FanoutDataV1 {
  schema: "fanout-wire/v1";
  kind: "data";
  direction: "publisher-to-relay" | "relay-to-subscriber";
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  windowIndex: number;
  publisherId: string;
  publisherSequence: number;
  subscriberId: string | null;
  linuxAcceptedOrdinal: number | null;
  payloadBase64: Base64;
  payloadSha256: Sha256Hex;
  payloadBytes: 100 | 128;
}
interface FanoutAckCommonV1 {
  schema: "fanout-wire/v1";
  kind: "ack";
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  windowIndex: number;
  publisherId: string;
  publisherSequence: number;
}
interface FanoutAckAcceptedV1 extends FanoutAckCommonV1 {
  disposition: "accepted";
  linuxAcceptedOrdinal: number;
  linuxAcceptedAtNs: NsString;
  code: null;
}
interface FanoutAckDuplicateV1 extends FanoutAckCommonV1 {
  disposition: "duplicate";
  linuxAcceptedOrdinal: null;
  linuxAcceptedAtNs: null;
  code: "DUPLICATE_PUBLISHER_SEQUENCE";
}
interface FanoutAckReorderedV1 extends FanoutAckCommonV1 {
  disposition: "reordered";
  linuxAcceptedOrdinal: null;
  linuxAcceptedAtNs: null;
  code: "REORDERED_PUBLISHER_SEQUENCE";
}
interface FanoutAckClosedV1 extends FanoutAckCommonV1 {
  disposition: "closed";
  linuxAcceptedOrdinal: null;
  linuxAcceptedAtNs: null;
  code:
    | "REGISTRATION_CLOSED"
    | "RELAY_INGRESS_QUEUE_FULL"
    | "SUBSCRIBER_QUEUE_FULL"
    | "RELAY_WRITE_TIMEOUT"
    | "SUBSCRIBER_DISCONNECTED"
    | "MEASUREMENT_WINDOW_CLOSED";
}
type FanoutAckV1 = FanoutAckAcceptedV1 | FanoutAckDuplicateV1 | FanoutAckReorderedV1 | FanoutAckClosedV1;
interface FanoutEndV1 {
  schema: "fanout-wire/v1";
  kind: "end";
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  role: "publisher" | "subscriber";
  roleId: string;
  finalWindowIndex: number;
  finalPublisherSequence: number | null;
  reason: "publisher-complete" | "relay-drained";
}
type FanoutWireV1 =
  | FanoutRegisterV1
  | FanoutAcceptV1
  | FanoutRefuseV1
  | FanoutWarmupDataV1
  | FanoutWarmupAckV1
  | FanoutWarmupEndV1
  | FanoutDataV1
  | FanoutAckV1
  | FanoutEndV1;
```

Warmup and measured frames are discriminated at the codec and state-machine levels. A warmup frame must carry the authenticated grant, warmup epoch digest, and nonce and must not carry a measured barrier. A measured data/ack/end frame must carry the authenticated measured barrier and must not carry a warmup epoch/nonce. At Linux warmup drain, all warmup queues empty, warmup counters are retained only in the warmup completion authority, measured counters are asserted zero, and publisher sequence/accepted-ordinal measured state is reset. Cross-epoch, warmup-as-measured, measured-as-warmup, or any warmup value in a measured partial is `FAIL/WARMUP_PROTOCOL`.

For measured data, Linux defines accepted ingress at the instant a valid, in-order publisher data frame has been assigned `linuxAcceptedOrdinal` and admitted to the bounded global relay ingress queue. It then sends `FanoutAckV1(disposition="accepted")`; fanout to each required subscriber is accounted separately by completed writes or one of the three undelivered counters in section 4.5. Global-ingress queue-full, subscriber queue-full, partial enqueue, timeout, disconnect, duplicate, or reorder is recorded by Linux and makes promotion impossible; publishers never author `serverAcceptedIngress`.

### 4.3 Mac role-child control frames and global ramp

```ts
interface TokenBundleEntryV1 {
  schema: "token-bundle-entry/v1";
  role: "publisher" | "subscriber";
  roleId: string;
  workerIndex: number | null;
  tokenBase64: Base64;
  tokenSha256: Sha256Hex;
  tokenCommitmentIndex: number;
  tokenMerkleProofSha256: Sha256Hex[];
}
interface TokenBundleV1 {
  schema: "token-bundle/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  childId: string;
  entryCount: number;
  entries: TokenBundleEntryV1[];
}
interface RoleSpawnConfigV1 {
  schema: "role-spawn-config/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortGrantBase64: Base64;
  cohortGrantSignatureBase64: Base64;
  workloadRolePlanInputBase64: Base64;
  workloadRolePlanInputSha256: Sha256Hex;
  stagedServerLaunchRecordBase64: Base64;
  stagedServerLaunchRecordSha256: Sha256Hex;
  stagedServerLaunchRecordSize: number;
  childId: string;
  role: "publisher" | "subscriber-worker";
  publisherId: string | null;
  workerIndex: number | null;
  childInstanceNonce: Sha256Hex;
  tokenBundleFd: 5;
  tokenBundleSha256: Sha256Hex;
  tokenBundleSize: number;
  tokenBundleEntryCount: number;
  tokenBundleMaxSize: 2097152;
  transport: "ws" | "wt";
  serverHost: "10.99.0.2";
  serverPort: number;
  tlsServerName: "wt-compare.local";
  messageRatePerSecond: number;
  warmupMessagesPerPublisher: 10;
  warmupIntervalMs: 500;
  warmupDurationMs: 5000;
  measuredDurationMs: 10000 | 30000;
  measuredSampleWindowMs: 1000;
  payloadBytes: 100 | 128;
  channelMapping:
    | "ws-binary-message-per-frame"
    | "wt-publisher-bidi-subscriber-control-bidi-server-uni";
  macSigningPublicKeyBase64: Base64;
  macSigningPublicKeySha256: Sha256Hex;
}
interface RoleReadyV1 {
  schema: "role-ready/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  childId: string;
  childPid: number;
  childPgid: number;
  childInstanceNonce: Sha256Hex;
  registeredSessionCount: number;
}
interface ConnectPermitRequestV1 {
  schema: "connect-permit-request/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  childId: string;
  globalOrdinal: number;
  roleId: string;
}
interface ConnectPermitGrantV1 {
  schema: "connect-permit-grant/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  childId: string;
  globalOrdinal: number;
  notBeforeMacNs: NsString;
  permitNonce: Sha256Hex;
}
interface ConnectPermitCompleteV1 {
  schema: "connect-permit-complete/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  childId: string;
  globalOrdinal: number;
  permitNonce: Sha256Hex;
  startedAtMacNs: NsString;
  completedAtMacNs: NsString;
  outcome: "ready" | "failed";
}
interface RoleWarmupStartV1 {
  schema: "role-warmup-start/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortWarmupEpochBase64: Base64;
  cohortWarmupEpochSha256: Sha256Hex;
  cohortWarmupEpochSignatureBase64: Base64;
  cohortWarmupEpochSignatureSha256: Sha256Hex;
  warmupNonce: Sha256Hex;
  expectedChildOfferedWarmupIngress: number;
  expectedChildDeliveredWarmupRecords: number;
  startAtMacNs: NsString;
  durationMs: 5000;
}
interface RoleWarmupCompleteV1 {
  schema: "role-warmup-complete/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  warmupNonce: Sha256Hex;
  childId: string;
  role: "publisher" | "subscriber-worker";
  startedAtMacNs: NsString;
  completedAtMacNs: NsString;
  offeredWarmupIngress: number;
  deliveredWarmupRecords: number;
}
interface RoleMeasureStartV1 {
  schema: "role-measure-start/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierBase64: Base64;
}
interface RoleMeasureStartAckV1 {
  schema: "role-measure-start-ack/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  childId: string;
  cohortStartBarrierSha256: Sha256Hex;
  armedAtMacNs: NsString;
}
interface RoleStopV1 {
  schema: "role-stop/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  stopAtMacNs: NsString;
}
interface RolePartialV1 {
  schema: "role-partial/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  childId: string;
  partialKind: "publisher" | "worker";
  partialBase64: Base64;
  partialSha256: Sha256Hex;
}
interface RolePartialAcceptedV1 {
  schema: "role-partial-accepted/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  childId: string;
  partialSha256: Sha256Hex;
}
interface RoleExitV1 {
  schema: "role-exit/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  childId: string;
}
interface RoleExitedV1 {
  schema: "role-exited/v1";
  sequence: number;
  executionSha256: Sha256Hex;
  childId: string;
  exitCode: number;
}
```

`RoleSpawnConfigV1` is capped at 512 KiB and delivered once on the private child pipe before FD 5 is read or any network call is legal. The child verifies the embedded Mac signature over the exact cohort grant with the embedded 32-byte public key, verifies that key's digest against the staged digest inherited from the supervisor, recomputes both canonical preimage hashes and the wrapper digest, and requires every endpoint/transport/rate/schedule/payload/channel field to equal the signed grant and role-plan preimage. Publisher `messageRatePerSecond` is the scenario's per-publisher rate; subscriber workers require the same value only as an expected wire-validation input and never originate traffic. `serverPort` is 1..65535 and must equal the embedded `StagedServerLaunchRecordV1.bindPort` decoded from `stagedServerLaunchRecordBase64` after size/digest/cap checks; the child never looks up a path or asks the controller for the preimage. Missing fields, wrong preimage, endpoint, transport, schedule, payload, channel mapping, signature, or staged public-key digest fail before child readiness. `RigSpawnServerRequestV1` receives the same treatment at the rig: exact 64 KiB cap, staged launch digest equality to the Mac execution receipt and stage receipt, transport/endpoint/argv equality, and no environment or argv outside the signed allowlist.

Token delivery uses one supervisor-created inherited read-only FD per role child, not a 64 KiB control frame. For each child the Mac supervisor creates a file beneath its private campaign runtime directory with `open(O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600)`, writes exactly one canonical `TokenBundleV1`, checks the 2,097,152-byte cap before allocation/write, `fsync`s, closes the write FD, reopens `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`, verifies inode/device/digest/size, unlinks the pathname, clears `FD_CLOEXEC` only on the read FD duplicated to child FD 5, and spawns. The child verifies FD 5 is regular, read-only, unlinked, exact size/digest/cap, reads once under a 5 s deadline, closes it before first network connect, and never receives a pathname. The supervisor retains only digest/size/entry count. Raw tokens are destroyed after both role FD load and Linux validation-table initialization; retained `TokenCommitmentLeafManifestV1` contains only token hashes and leaf fields, so the offline verifier recomputes the Merkle root without recovering secrets.

`tokenBundleSha256` is explicitly a destroyed-secret commitment, not a claim that the secret bundle can be reconstructed offline. The artifact retains its digest/size/entry count only to join child/process observations made while the FD existed. Offline root and shard verification uses the complete non-secret `TokenCommitmentLeafManifestV1`; it does not pretend to recompute `tokenBundleSha256`. No other evidence digest receives this exception.

Worst-case chat-10k worker cardinality is 1,250 subscribers. Each bundle entry has one 32-byte raw token (44 base64 characters), one 64-hex token hash, and exactly 14 64-hex Merkle siblings for a 10,010-leaf tree. The maximum canonical JSON is frozen at 1,536 bytes per entry plus 4 KiB envelope: `1250 * 1536 + 4096 = 1,924,096` bytes, below the 2,097,152-byte cap with 173,056 bytes margin. The publisher bundle is below the same cap. A canonical chat-10k fixture MUST encode at or below 1,924,096 bytes; cap+1, short read, digest swap, writable/path-backed FD, FD reuse, post-spawn mutation, unexpected FD, or retained raw token fails.

One global ordinal domain covers all sessions. Ordinals `0..subscriberCount-1` are subscribers: ordinal `o` maps to subscriber ID `subscriber-${o.toString().padStart(6,"0")}` and worker `o mod 8`. Ordinals `subscriberCount..subscriberCount+publisherCount-1` are publishers in ascending publisher ID order: publisher index `p=o-subscriberCount` maps to `publisher-${p.toString().padStart(6,"0")}` and its dedicated publisher child. `CohortGrantV1.expectedSessionCount = subscriberCount + publisherCount`; every total ordinal appears exactly once.

The Mac supervisor owns one `nextOrdinal`, one total in-flight permit map, and one min-heap across all subscriber and publisher requests. It grants ordinal `o` only to the deterministic owner, only after `rampEpochMacNs + floor(o * 1_000_000_000 / 500)`, and only while fewer than 200 total permits are in flight. Completion spends the permit. A wrong owner, early `startedAtMacNs`, more than 200 total in flight, skipped/duplicated ordinal, per-role counter masquerading as global accounting, or completion after the readiness deadline is `FAIL/COHORT_NOT_READY`. This is per-connection control, not per-delivery-message IPC.

### 4.4 Complete partial, manifest, process, Linux, receipt, and artifact schemas

```ts
interface PublisherPartialV1 {
  schema: "publisher-partial/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  childId: string;
  childPid: number;
  childPgid: number;
  childInstanceNonce: Sha256Hex;
  publisherId: string;
  tokenSha256: Sha256Hex;
  macClockId: string;
  windowCount: 10 | 30;
  offeredByOriginWindow: number[];
  offeredBytesByOriginWindow: number[];
  acceptedAckSeenByOriginWindow: number[];
  duplicateAckSeenByOriginWindow: number[];
  reorderedAckSeenByOriginWindow: number[];
  firstOfferAtMacNs: NsString;
  lastAckAtMacNs: NsString;
  exitCode: 0;
}
interface WorkerPartialV1 {
  schema: "worker-partial/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  childId: string;
  childPid: number;
  childPgid: number;
  childInstanceNonce: Sha256Hex;
  workerIndex: number;
  tokenBundleSha256: Sha256Hex;
  orderedSubscriberIdsSha256: Sha256Hex;
  subscriberCount: number;
  macClockId: string;
  windowCount: 10 | 30;
  deliveredByOriginWindow: number[];
  deliveredBytesByOriginWindow: number[];
  deliveredByEventWindow: number[];
  deliveredBytesByEventWindow: number[];
  deliveredAfterMeasureStop: number;
  deliveredBytesAfterMeasureStop: number;
  perSubscriberDelivered: number[];
  duplicateCount: number;
  reorderCount: number;
  malformedCount: number;
  disconnectCount: number;
  firstDeliveryAtMacNs: NsString;
  lastDeliveryAtMacNs: NsString;
  exitCode: 0;
}
interface OrderedPartialManifestEntryV1 {
  schema: "ordered-partial-manifest-entry/v1";
  order: number;
  partialKind: "publisher" | "worker";
  childId: string;
  partialSha256: Sha256Hex;
  partialSize: number;
}
interface OrderedPartialManifestV1 {
  schema: "ordered-partial-manifest/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  publisherPartialCount: number;
  workerPartialCount: 8;
  totalPartialBytes: number;
  entries: OrderedPartialManifestEntryV1[];
  orderedDigestSetSha256: Sha256Hex;
}
interface ObservedChildProcessV1 {
  schema: "observed-child-process/v1";
  childId: string;
  role: "publisher" | "subscriber-worker";
  pid: number;
  pgid: number;
  instanceNonce: Sha256Hex;
  bunSha256: Sha256Hex;
  entrypointSha256: Sha256Hex;
  tokenOrBundleSha256: Sha256Hex;
  publisherId: string | null;
  workerIndex: number | null;
  orderedSubscriberIdsSha256: Sha256Hex | null;
  subscriberCount: number;
  spawnedAtMacNs: NsString;
  readyAtMacNs: NsString;
  warmupCompleteAtMacNs: NsString;
  measureArmedAtMacNs: NsString;
  stoppedAtMacNs: NsString;
  partialSha256: Sha256Hex;
  exitCode: number;
  signal: string | null;
  replacementCount: 0;
}
interface ObservedProcessProofV1 {
  schema: "observed-process-proof/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  expectedProcessCount: number;
  observedProcessCount: number;
  expectedPublisherCount: number;
  observedPublisherCount: number;
  expectedWorkerCount: 8;
  observedWorkerCount: 8;
  expectedSubscriberCount: number;
  observedSubscriberCount: number;
  children: ObservedChildProcessV1[];
  childrenDigestSha256: Sha256Hex;
}
interface LinuxRelayObservationV1 {
  schema: "linux-relay-observation/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  roleTokenCommitmentRootSha256: Sha256Hex;
  serverChildPid: number;
  serverChildPgid: number;
  serverChildInstanceNonce: Sha256Hex;
  linuxClockId: string;
  windowCount: 10 | 30;
  registeredPublisherIds: string[];
  registeredSubscriberIdsSha256: Sha256Hex;
  registeredPublisherCount: number;
  registeredSubscriberCount: number;
  acceptedIngressByOriginWindow: number[];
  acceptedIngressBytesByOriginWindow: number[];
  relayWritesCompletedByOriginWindow: number[];
  relayWriteBytesByOriginWindow: number[];
  duplicateIngressByOriginWindow: number[];
  reorderedIngressByOriginWindow: number[];
  queueDropDeliveriesByOriginWindow: number[];
  writeTimeoutDeliveriesByOriginWindow: number[];
  disconnectUndeliveredByOriginWindow: number[];
  malformedIngressByOriginWindow: number[];
  publisherEndCount: number;
  subscriberEndCount: number;
  sessionsAccepted: number;
  sessionsActivePeak: number;
  publisherSessionsActivePeak: number;
  subscriberSessionsActivePeak: number;
  queueItemsPeak: number;
  queueBytesPeak: number;
  concurrentWritesPeak: number;
  measurementStartedAtLinuxNs: NsString;
  relayDrainedAtLinuxNs: NsString;
  allSessionsClosedAtLinuxNs: NsString;
  allSessionsClosed: true;
}
interface RigRelayObservationReceiptV1 {
  schema: "rig-relay-observation-receipt/v1";
  executionSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  linuxRelayObservationSha256: Sha256Hex;
  rigExecutionAcceptanceSha256: Sha256Hex;
  rigSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  receivedAtRigNs: NsString;
  issuedAtMs: number;
  notAfterMs: number;
}
interface CohortRateSeriesV1 {
  schema: "cohort-rate-series/v1";
  sampleUnit: "count";
  sampleWindowMs: 1000;
  samples: number[];
  measuredWindowDeliveredTotal: number;
  postStopDrainDelivered: number;
  conservationDeliveredTotal: number;
  firstDeliveryAtMacNs: NsString;
  lastMeasuredWindowDeliveryAtMacNs: NsString;
  lastDeliveryIncludingDrainAtMacNs: NsString;
  measuredDurationMs: 10000 | 30000;
  meanNumerator: number;
  meanDenominatorMs: 10000 | 30000;
}
interface CohortLedgerV1 {
  schema: "cohort-ledger/v1";
  offeredIngress: number;
  serverAcceptedIngress: number;
  offeredExpandedDeliveries: number;
  serverAcceptedExpandedDeliveries: number;
  linuxRelayWritesCompleted: number;
  delivered: number;
  deliveredBytes: number;
  messageBytes: 100 | 128;
}
interface CohortCapacityV1 {
  schema: "cohort-capacity/v1";
  expectedSessions: number;
  sessionsAccepted: number;
  sessionsActivePeak: number;
  expectedPublishers: number;
  registeredPublishers: number;
  expectedSubscribers: number;
  registeredSubscribers: number;
}
interface CohortAdmissionReceiptV1 {
  schema: "cohort-admission-receipt/v1";
  executionSha256: Sha256Hex;
  measurementGrantSha256: Sha256Hex;
  macExecutionGrantReceiptSha256: Sha256Hex;
  cohortGrantSha256: Sha256Hex;
  cohortGrantSignatureSha256: Sha256Hex;
  rigCohortAcceptanceSha256: Sha256Hex;
  rigCohortAcceptanceSignatureSha256: Sha256Hex;
  tokenCommitmentLeafManifestSha256: Sha256Hex;
  cohortWarmupEpochSha256: Sha256Hex;
  cohortWarmupEpochSignatureSha256: Sha256Hex;
  roleWarmupCompletionManifestSha256: Sha256Hex;
  roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
  serverWarmupDrainedSha256: Sha256Hex;
  rigWarmupDrainedReceiptSha256: Sha256Hex;
  rigWarmupDrainedReceiptSignatureSha256: Sha256Hex;
  rigMeasureStartAckSha256: Sha256Hex;
  rigMeasureStartAckSignatureSha256: Sha256Hex;
  cohortStartBarrierSha256: Sha256Hex;
  cohortStartBarrierSignatureSha256: Sha256Hex;
  rigBarrierAcceptanceSha256: Sha256Hex;
  rigBarrierAcceptanceSignatureSha256: Sha256Hex;
  serverStartBarrierAcceptedSha256: Sha256Hex;
  orderedPartialManifestSha256: Sha256Hex;
  observedProcessProofSha256: Sha256Hex;
  linuxRelayObservationSha256: Sha256Hex;
  rigRelayObservationReceiptSha256: Sha256Hex;
  rigRelayObservationReceiptSignatureSha256: Sha256Hex;
  rigServerSnapshotReceiptSha256: Sha256Hex;
  rigServerSnapshotReceiptSignatureSha256: Sha256Hex;
  macMeasurementAdmissionReceiptSha256: Sha256Hex;
  macMeasurementAdmissionSignatureSha256: Sha256Hex;
  rateSeriesSha256: Sha256Hex;
  ledgerSha256: Sha256Hex;
  capacitySha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  publisherCount: number;
  workerCount: 8;
  subscriberCount: number;
  offeredIngress: number;
  serverAcceptedIngress: number;
  linuxRelayWritesCompleted: number;
  delivered: number;
  macSupervisorInstanceNonce: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}
interface CohortObservationEvidenceV1 {
  schema: "cohort-observation-evidence/v1";
  workloadRolePlanInput: RetainedCanonicalBytesV1;
  cohortGrant: RetainedCanonicalBytesV1;
  cohortGrantSignature: RetainedCanonicalBytesV1;
  rigCohortAcceptance: RetainedCanonicalBytesV1;
  rigCohortAcceptanceSignature: RetainedCanonicalBytesV1;
  tokenCommitmentLeafManifest: RetainedCanonicalBytesV1;
  cohortWarmupEpoch: RetainedCanonicalBytesV1;
  cohortWarmupEpochSignature: RetainedCanonicalBytesV1;
  roleWarmupCompletionManifest: RetainedCanonicalBytesV1;
  roleWarmupCompletionManifestSignature: RetainedCanonicalBytesV1;
  roleWarmupCompletes: RetainedCanonicalBytesV1[];
  serverWarmupDrained: RetainedCanonicalBytesV1;
  rigWarmupDrainedReceipt: RetainedCanonicalBytesV1;
  rigWarmupDrainedReceiptSignature: RetainedCanonicalBytesV1;
  rigMeasureStartAck: RetainedCanonicalBytesV1;
  rigMeasureStartAckSignature: RetainedCanonicalBytesV1;
  cohortStartBarrier: RetainedCanonicalBytesV1;
  cohortStartBarrierSignature: RetainedCanonicalBytesV1;
  rigBarrierAcceptance: RetainedCanonicalBytesV1;
  rigBarrierAcceptanceSignature: RetainedCanonicalBytesV1;
  serverStartBarrierAccepted: RetainedCanonicalBytesV1;
  publisherPartials: RetainedCanonicalBytesV1[];
  workerPartials: RetainedCanonicalBytesV1[];
  orderedPartialManifest: RetainedCanonicalBytesV1;
  observedProcessProof: RetainedCanonicalBytesV1;
  linuxRelayObservation: RetainedCanonicalBytesV1;
  rigRelayObservationReceipt: RetainedCanonicalBytesV1;
  rigRelayObservationReceiptSignature: RetainedCanonicalBytesV1;
  rateSeries: RetainedCanonicalBytesV1;
  ledger: RetainedCanonicalBytesV1;
  capacity: RetainedCanonicalBytesV1;
  cohortAdmissionReceipt: RetainedCanonicalBytesV1;
  cohortAdmissionSignature: RetainedCanonicalBytesV1;
}
interface ArmAttestationEvidenceV2 {
  schema: "arm-attestation-evidence/v2";
  executionSha256: Sha256Hex;
  serverObservationEvidence: ServerObservationEvidenceV1;
  cohortObservationEvidence: CohortObservationEvidenceV1 | null;
}
```

Producer/cap table:

| Record | Sole producer | Decoded cap / item cap |
|---|---|---|
| `CohortGrantV1` | Mac supervisor | 256 KiB; publishers <= 10; shards exactly 8 |
| `TokenCommitmentLeafManifestV1` | Mac supervisor | 4 MiB; leaves = publishers + subscribers; no raw tokens |
| `CohortWarmupEpochV1` + role completion manifest | Mac supervisor | 16 KiB + 256 KiB; entries exactly publishers + 8 and each retained child frame <= 8 KiB |
| `RoleWarmupCompleteV1[]` | named role children, retained by Mac | exactly publishers + 8; each <= 8 KiB; publisher IDs ascending then workers 0..7 |
| `ServerWarmupDrainedV1` / `ServerStartBarrierAcceptedV1` | Linux server child, retained through rig | 16 KiB each; exactly one each |
| `CohortStartBarrierV1` | Mac supervisor after readiness/warmup/Linux baseline | 16 KiB |
| `PublisherPartialV1` | named publisher child | 64 KiB each; <= 10 |
| `WorkerPartialV1` | named worker child | 256 KiB each; exactly 8; `perSubscriberDelivered` exact shard count |
| `OrderedPartialManifestV1` | Mac supervisor | 64 KiB; entries = publishers + 8 |
| `ObservedProcessProofV1` | Mac supervisor from spawn/FD/waitpid observations | 128 KiB; children = publishers + 8 |
| `LinuxRelayObservationV1` | Linux server child | 128 KiB; every window array length 10 or 30 |
| `RigRelayObservationReceiptV1` | rig supervisor | 32 KiB |
| `CohortAdmissionReceiptV1` + signature | Mac supervisor | 64 KiB + 4 KiB |
| `CohortObservationEvidenceV1` | Mac supervisor export assembled from exact retained bytes | 9 MiB decoded; 14 MiB encoded |

Partials order publisher IDs ascending, then workers 0..7. `OrderedPartialManifestV1.orderedDigestSetSha256` is SHA-256 of canonical `entries.map(({partialKind,childId,partialSha256,partialSize})=>...)`. All records are retained as base64+size+digest through `RetainedCanonicalBytesV1`; the verifier never accepts only the manifest digests.

The sole final raw-evidence egress is `MacCohortEvidenceExportedAckV1`; the earlier warmup-manifest export is a required bounded transition and not a substitute. After final admission, the Mac supervisor constructs the exact `CohortObservationEvidenceV1` from its retained ordered `RoleWarmupCompleteV1` frames, `ServerWarmupDrainedV1`, `ServerStartBarrierAcceptedV1`, role partials/manifests/process proof, authenticated rig records, and Linux observation. Before reading or allocating its base64 payload, the controller checks encoded length <= 14 MiB; decode budget is charged atomically against a 20 MiB per-execution remote-evidence budget; decoded size must be <= 9 MiB and equal the declared size; then digest and every inner retained record are verified. Manifest entries must contain the same child bytes as `roleWarmupCompletes`, and the rig receipt hashes must reproduce the two exact server frames. The response is bound to one `executionSha256`, one request/response sequence, and `terminalExport:true`; missing, duplicate, truncated, reordered-inner-array, rewritten child frame, cross-execution substitution, oversize, or second export fails. `ArmMeasurement` and `RunArtifactV2` each add the exact required field `attestationEvidence: ArmAttestationEvidenceV2`; Phase A sets its cohort member to `null`, Phase B requires it non-null. The identical canonical nested record participates in the artifact seal hash, recursive verifier, fixtures, and command tests. A genuine cohort receipt paired with different raw partial or warmup/barrier child bytes fails offline recomputation.

### 4.5 Offline recomputation equations and fixed cardinalities

Origin-window conservation and actual delivery-time rate are different observations. `originWindowIndex` is immutable in each measured `FanoutDataV1` and is joined with `(publisherId,publisherSequence)`; it never changes when acknowledgement, relay completion, subscriber delivery, or drain occurs. Event window `e` is computed only by a Mac subscriber worker from the actual `deliveredAtMacNs`: `floor((deliveredAtMacNs-measureStartAtMacNs)/1_000_000_000)`. Values with `0 <= e < windowCount` enter `deliveredByEventWindow[e]`; values at or after `measureStopAtMacNs` enter `deliveredAfterMeasureStop` and no measured rate sample. A timestamp before start or after the 10 s drain deadline fails. First/last timestamps are the minima/maxima of the actual event timestamps, with zero-delivery represented by the exact barrier start timestamp.

For every origin window `w`, the verifier recomputes conservation from retained publisher, Linux, and worker partial bytes:

```text
O_origin[w]  = checked_sum(publisher.offeredByOriginWindow[w])
OA_origin[w] = checked_sum(publisher.acceptedAckSeenByOriginWindow[w])
A_origin[w]  = linux.acceptedIngressByOriginWindow[w]
L_origin[w]  = linux.relayWritesCompletedByOriginWindow[w]
D_origin[w]  = checked_sum(worker.deliveredByOriginWindow[w])
DB_origin[w] = checked_sum(worker.deliveredBytesByOriginWindow[w])

OA_origin[w] = A_origin[w]
A_origin[w] <= O_origin[w]
L_origin[w] <= A_origin[w] * subscriberCount
D_origin[w] <= L_origin[w]
DB_origin[w] = D_origin[w] * messageBytes
A_origin[w] * subscriberCount =
  L_origin[w]
  + linux.queueDropDeliveriesByOriginWindow[w]
  + linux.writeTimeoutDeliveriesByOriginWindow[w]
  + linux.disconnectUndeliveredByOriginWindow[w]

ledger.offeredIngress                  = sum(O_origin)
ledger.serverAcceptedIngress           = sum(A_origin)
ledger.offeredExpandedDeliveries       = sum(O_origin) * subscriberCount
ledger.serverAcceptedExpandedDeliveries= sum(A_origin) * subscriberCount
ledger.linuxRelayWritesCompleted       = sum(L_origin)
ledger.delivered                       = sum(D_origin)
ledger.deliveredBytes                  = sum(DB_origin)
series.samples[e]                      = checked_sum(worker.deliveredByEventWindow[e])
series.measuredWindowDeliveredTotal    = sum(series.samples)
series.postStopDrainDelivered          = checked_sum(worker.deliveredAfterMeasureStop)
series.conservationDeliveredTotal      = sum(D_origin)
series.conservationDeliveredTotal      = series.measuredWindowDeliveredTotal + series.postStopDrainDelivered
series.meanNumerator                   = series.measuredWindowDeliveredTotal * 1000
series.meanDenominatorMs               = measuredDurationMs
```

There is intentionally no `OA_origin[w] = acknowledgement-event-window[w]` or `L_origin[w] = delivery-event-window[w]` equation. Honest boundary latency may move acknowledgements/deliveries into a later event window. Promotion requires origin totals/per-origin joins `O_origin=A_origin` and `L_origin=D_origin=A_origin*subscriberCount`, not same-event-window equality. It also requires `series.postStopDrainDelivered=0`, every duplicate/reorder/drop/timeout/disconnect/malformed counter zero, every publisher/subscriber end marker present once, every per-subscriber delivered count equal accepted ingress, exact shard union with no missing/overlap, and capacity `sessionsAccepted = sessionsActivePeak = publishers + subscribers` with separate peaks matching their counts. Deterministic tests place accepted ingress 1 ns before a boundary and delivery 1 ns after it, and place completion after stop during drain; both must preserve origin conservation while moving or excluding the rate event. Relabeling either delivery into its origin rate window fails.

For Phase B, the admitted client series is exactly `CohortRateSeriesV1.samples`: `sampleUnit:"count"`, `sampleCount=windowCount`, `delivered=measuredWindowDeliveredTotal`, first/last actual delivery timestamps from the rate record, and `spanMs=measuredDurationMs`. The cohort ledger retains conservation total including drain separately. Any nonzero post-stop drain makes the arm non-promotable and ultimately `FAIL/RELAY_DELIVERY`; it is never folded backward into measured samples.

| Cell | Publishers | Workers | Subscribers | Sessions | Measured ingress | Expanded deliveries |
|---|---:|---:|---:|---:|---:|---:|
| ticker 10k | 1 | 8 | 100 | 101 | 100,000 | 10,000,000 |
| ticker 50k | 1 | 8 | 100 | 101 | 500,000 | 50,000,000 |
| ticker 100k | 1 | 8 | 100 | 101 | 1,000,000 | 100,000,000 |
| chat 1k | 10 | 8 | 1,000 | 1,010 | 300 | 300,000 |
| chat 5k | 10 | 8 | 5,000 | 5,010 | 300 | 1,500,000 |
| chat 10k | 10 | 8 | 10,000 | 10,010 | 300 | 3,000,000 |

## 5. One ordered lifecycle for Phase A and Phase B

Mac nanoseconds are minted by the Mac supervisor and role children from `mach_continuous_time`, sharing one boot-relative `macClockId`. Linux nanoseconds are minted by rig supervisor/server from `CLOCK_MONOTONIC`, sharing one `linuxClockId`. Unix milliseconds are used only for grant expiry. Mac and Linux monotonic values are joined by frame order/digests, never compared numerically.

The controller schedule is exactly one `WarmupStateV1` followed by measured repetitions. Every warmup execution has `repetitionKind:"warmup"`, `repetitionIndex:0`, `repetitionTotal:1`, and a distinct `runId="<campaignRunId>/<cellId>/<transport>/warmup-0"`; measured run IDs end in `/measured-<1..5>`. The warmup identity is validated through draft, grant, execution, every receipt, controller memory, replay ledger, and child frames. `WarmupStateV1` is never sealed, indexed, resumable, or promotable and must reach `complete` once before measured rep 1. Canonical purpose requires measured indices 1..5; focused and pilot require measured index 1 only. Every Phase B execution, including the unsealed campaign warmup, also runs the five-second in-repetition fanout warmup. No bytes, run ID, grant, receipt, token, cohort ID, nonce, or replay leaf may be reused between warmup and measured executions.

```ts
interface WarmupStateV1 {
  schema: "warmup-state/v1";
  executionPurpose: ExecutionPurpose;
  cellId: string;
  transport: "ws" | "wt";
  runId: string;
  repetitionKind: "warmup";
  repetitionIndex: 0;
  repetitionTotal: 1;
  state: "not-started" | "running" | "complete" | "failed";
  executionSha256: Sha256Hex | null;
}
```

Ordered states:

1. `PREFLIGHT`: validate approval digests, candidate/source/stage/binaries/routes/FD floor; no campaign root exists.
2. `MAC_EXECUTION_OPEN`: controller supplies only `CrossSupervisorExecutionDraftV1`; Mac assigns `executionIndex`, mints measurement grant and final execution, and signs the execution receipt.
3. `RIG_EXECUTION_ACCEPTED`: rig verifies staged Mac key, signature, approval, expiry, and durable replay leaf, signs `RigExecutionAcceptanceV1`, and returns its signature before any server spawn; Mac authenticates it.
4. Phase B only: `COHORT_GRANTED`: Mac spawns role children, mints the token leaf manifest and signed pre-readiness grant; controller transfers exact grant+signature to rig; rig authenticates it, signs its acceptance, and controller presents acceptance+signature back to Mac.
5. `SERVER_READY`: rig passes execution plus optional cohort grant to server child; child binds/listens and acks.
6. Phase B only: `RAMP_AND_READY`: subscribers then publishers register under global ordinal permits; Linux validates every token; server channels are writable; exact role/session counts reach the barrier.
7. Phase B only: `IN_REPETITION_WARMUP`: Mac mints and signs one `CohortWarmupEpochV1`, then sends its exact bytes/signature in `RoleWarmupStartV1` to every role child before any warmup network frame. Exact warmup wire carries grant+epoch+nonce and no measured barrier. Every publisher offers exactly ten paced frames and every subscriber worker proves its exact expanded delivery count. All role children emit one epoch-bound completion; Mac retains the exact ordered frames inside and beside its signed manifest; the controller performs the bounded one-shot manifest export before `RigFinishWarmupRequestV1`; Linux retains `ServerWarmupDrainedV1` only after the nonzero equations hold, queues empty, and measured counters reset to zero. No warmup or barrier child authority is digest-only.
8. `LINUX_BASELINE`: rig issues `ServerMeasureStartV1`; named `RigMeasureStartAckV1` contains the server baseline and warmup-completion digest, is rig-signed, retained, and authenticated by Mac. No measured traffic is legal before this ack.
9. Phase B: `START_BARRIER`: Mac mints/signs `CohortStartBarrierV1` with `measureStartAtMacNs >= mintedAtMacNs + 250,000,000`; rig and server authenticate it and return the exact `ServerStartBarrierAcceptedV1` bytes plus signed `RigBarrierAcceptanceV1`; only then do role children receive and ack the barrier before start. Phase A uses the same 250 ms Mac sink-arm delay without a cohort record; Linux remains the source.
10. `MEASURING`: Phase B traffic starts at the Mac timestamp; origin-window fields are immutable for conservation while actual Mac delivery timestamps alone form rate windows. Duration is exactly 10 or 30 windows.
11. `STOPPING`: Mac stops publishers/client at the declared Mac stop; Linux rejects later ingress.
12. Phase B only: `DRAINING`: Linux sends subscriber end markers, drains bounded queues, closes streams/sessions, and produces its observation after every session close callback.
13. `LINUX_CAPTURE`: rig requests capture; server produces one snapshot plus optional Linux relay observation before `ServerHandle.stop`; rig receipts both.
14. `MAC_JOIN`: controller presents the exact rig receipt(s) to Mac; Mac verifies execution/cohort/child/window joins, aggregates exact child partials, emits signed measurement and optional cohort admission receipts.
15. `ASSEMBLY`: after all I/O is complete, synchronous `measuredLegToArm` consumes immutable validated bytes. Warmup stops here without writing. Measured execution builds and seals one artifact.
16. `TEARDOWN`: Mac and rig close children and prove bounded reap. Next execution gets fresh nonces/tokens/grants.

Phase A deliberately uses the registry's existing completion-based non-fanout `bulk-one-way/physical` cell and preserves its canonical `bulk-source` / `linux-to-mac` / `server-opened-uni` topology. It is not forced into the Phase B duration/window schema. After the authenticated Linux baseline and a Mac sink-arm time at least 250 ms later, the Linux server opens the uni channel and writes exactly 1,600 ordered 65,536-byte schedule chunks (104,857,600 bytes); the Mac client only accepts that uni channel, reads to EOF, hashes, counts, and cancels/closes the session. The 600 s transfer deadline begins when the rig sends `ServerMeasureStartV1`; capture is requested immediately after both the Linux source end and Mac EOF are retained.

The exact Linux child record is `BulkSourceCompletionV1`, nested non-null in `ServerLoopUtilizationFrameV1`; the exact Mac record is the admitted `BulkSinkSeriesV1`. `transportReadCount` is transparency-only because WT may fragment one schedule chunk across reads. Admission recomputes the canonical payload schedule digest and requires:

```text
grant.declaredMessageCount = source.scheduledChunkCount = source.chunksWritten
                           = sink.scheduledChunkCount = sink.receivedScheduleChunkCount = 1600
grant.declaredMessageBytes = source.bytesWritten = sink.bytesReceived = 104857600
source.chunkBytes = sink.chunkBytes = 65536
source.payloadSha256 = sink.payloadSha256 = canonicalBulkPayloadSha256
source.direction = sink.direction = "linux-to-mac"
source.channelMapping = sink.channelMapping = "server-opened-uni"
source.channelEnded = sink.channelEofSeen = true
```

The admitted series projects `sampleUnit:"Mbps"`, `sampleCount:1`, `delivered:104857600`, actual Mac first/last-byte timestamps, `spanMs>0`, and one throughput sample `104857600 * 8 * 1000 / spanMs / 1_000_000`. Phase B requires `bulkSourceCompletion:null`. Phase A has no cohort, fanout windows, or origin/delivery arrays. A Mac-source/Linux-sink configuration, client-opened uni channel, source/sink digest swap, early EOF, extra/short bytes or schedule chunks, missing Linux end, no progress, or deadline is `FAIL/MEASUREMENT_WINDOW`; capture before both source end and sink EOF/session close is `FAIL/CHILD_LIFECYCLE`. Each WS and WT warmup execution uses this same complete authenticated source/sink contract under its distinct frozen warmup identity and is discarded only after full teardown.

Child replacement policy is exact: after `RAMP_AND_READY`/Phase A `SERVER_READY`, any child exit is `FAIL/CHILD_LIFECYCLE`; replacement is forbidden. Before readiness, replacement invalidates all ready state, kills the entire role cohort and server child, increments `cohortAttempt`, mints fresh child/cohort nonces and all fresh tokens, sends the new grant to rig, spawns a fresh server child, and re-runs readiness. Reusing the old grant/token/nonce fails replay tests. At most one pre-readiness cohort replacement is allowed; a second failure is terminal.

## 6. Purpose, index, artifact, resume, promotion, and report contract

CLI adds mandatory `--execution-purpose=focused|pilot|canonical`:

- `focused`: `--reps=1` only; one unsealed warmup + one measured per arm; artifacts/index PASS can verify but `promotable:false`; no flats.
- `pilot`: same scheduling/promotion rules as focused, but report labels workload pilot.
- `canonical`: `--reps=5` only; one unsealed warmup + five distinct measured reps per arm; each eligible PASS has `promotable:true`; promotion occurs only after the complete 5+5 set verifies.

The named migration is `CampaignIndexV2` (`schema: "campaign-index/v2"`) plus `RunArtifactV2` (`schemaVersion: "v2"`). Index status remains exactly `PASS | FAIL | REFUSED`; no fourth status is introduced. Exact additions are `executionPurpose`, `repetitionKind:"measured"`, `repetitionIndex`, `repetitionTotal`, `promotable:boolean`, `failureCode:CampaignFailureCode|null`, `refusalCode:CampaignRefusalCode|null`, `sealedPath:string|null`, and `artifactSha256:string|null`. PASS requires both codes null and a sealed path. FAIL requires one closed `CampaignFailureCode` and `promotable:false`. REFUSED requires one closed `CampaignRefusalCode`, no sealed path, and is legal only pre-traffic. `RunArtifactV2` adds `executionPurpose`, the real repetition identity, and exact `attestationEvidence: ArmAttestationEvidenceV2`; its existing `promotable` must equal purpose/receipt eligibility.

```ts
interface CampaignIndexReadPathV2 {
  schema: "campaign-index-read-path/v2";
  sinkMode: string | null;
  configuredSinkMode: string | null;
  queuedRecordsPeakBytes: number | null;
  droppedByQueue: number | null;
  readerBusyMs: number | null;
}
interface CampaignIndexEntryV2 {
  schema: "campaign-index-entry/v2";
  cellId: string;
  armId: string;
  transport: "ws" | "wt";
  armKind: "primary" | "read-path" | "overlay";
  armTransport: string | null;
  impairment: string;
  executionPurpose: ExecutionPurpose;
  repetitionKind: "measured";
  repetitionIndex: number;
  repetitionTotal: number;
  status: CampaignStatus;
  promotable: boolean;
  failureCode: CampaignFailureCode | null;
  refusalCode: CampaignRefusalCode | null;
  sealedPath: string | null;
  artifactSha256: Sha256Hex | null;
  primaryMetricP50: number | null;
  readPath: CampaignIndexReadPathV2 | null;
}
interface CampaignIndexV2 {
  schema: "campaign-index/v2";
  campaignRunId: string;
  stage: "phase4" | "full";
  candidate: string;
  campaignId: string;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  stagedCapabilitySha256: Sha256Hex;
  executionPurpose: ExecutionPurpose;
  cells: string[];
  arms: ("ws" | "wt")[];
  armKinds: ("primary" | "read-path" | "overlay")[];
  warmupRepetitions: 1;
  measuredRepetitions: 1 | 5;
  scheduledMeasuredArms: number;
  entries: CampaignIndexEntryV2[];
}
```

Fresh-root behavior is fail-closed: without `--resume`, `compare-controller.ts` checks `.release-evidence/transport-comparison/<candidate>/<campaignId>` before any `mkdir`, open, truncate, or network action and exits `CAMPAIGN_ROOT_EXISTS` if it exists. Trust bootstrap lives separately under `.release-evidence/transport-comparison/.trust-staging/<candidate>/<campaignId>`. With `--resume`, index v2, candidate, campaign, purpose, plan/approval digests, and every carried artifact must verify first; focused/pilot entries never carry into canonical. Canonical B6 forbids `--resume`.

Promotion requires exactly five distinct measured PASS entries with indices `{1,2,3,4,5}`, total 5, purpose canonical, `promotable:true`, and complete receipt graphs for WS and WT for the same cell. A sixth, duplicate, missing, warmup, focused, pilot, mixed-purpose, stale-echo, or cross-campaign entry refuses promotion. Selection of a display median occurs only after this set gate. Each promoted cell writes exactly two flats (WS and WT); six cells produce six paired promotions and twelve flats. Focused/pilot write zero flats.

Report rules:

1. Every arm says `attested`, `unattested`, or `not-applicable`; any included unattested primary arm forces a top-level incomplete-attestation caveat.
2. `serverAggregate` is labeled `aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window`; it never changes ranking or saturation prose.
3. Diagnostic rendering reads sealed rep paths recursively from verified campaign-index v2 with `--source=sealed-index`; it does not depend on flats and cannot create flats.
4. Canonical fanout language requires all 60 fresh measured PASS seals and six paired promotions. An echo flat for one of these six cells is stale and rejected.

## 7. Failure/status table

| Condition | Index result/code |
|---|---|
| Rig unreachable before traffic | `REFUSED/RIG_UNREACHABLE` |
| Host FD floor below frozen topology before traffic | `REFUSED/HOST_FD_PREFLIGHT` |
| Missing/stale staged identity before traffic | `REFUSED/STALE_OR_INVALID_STAGING` |
| Missing executor | implementation blocker; no index/root mutation |
| Mac signature/key/approval/expiry/replay failure | `FAIL` with exact code from section 3.1 |
| Rig signature/key/expiry/replay failure | `FAIL` with exact `RIG_*` code from section 3.1 |
| Malformed, unknown-key, oversize, sequence, EOF, digest, cross-run/transport/cohort protocol | `FAIL/TRUST_PROTOCOL` |
| Mac/rig execution or barrier disagreement | `FAIL/CROSS_SUPERVISOR_MISMATCH` |
| Missing/extra/replaced-after-ready child, role, shard, subscriber, publisher, duplicate PID/nonce | `FAIL/COHORT_PROTOCOL` |
| Readiness/global-ramp/permit/partial-connect failure | `FAIL/COHORT_NOT_READY` |
| Warmup leakage, early traffic, start replay, late start/stop | `FAIL/WARMUP_PROTOCOL` or `FAIL/MEASUREMENT_WINDOW` |
| Relay queue drop/write timeout/disconnect/dup/reorder/delivery shortfall | `FAIL/RELAY_DELIVERY` |
| Child death/early EOF/snapshot-before-close/teardown timeout | `FAIL/CHILD_LIFECYCLE` |
| Mid-run OOM or FD exhaustion | `FAIL/RUNTIME_RESOURCE_EXHAUSTION` |
| Focused/pilot successful evidence | `PASS`, `promotable:false` |
| Canonical measured success before complete pair | `PASS`, artifact eligible; no flat yet |
| Canonical exact 5+5 verified pair | `PASS`, promotion writes one WS + one WT flat |

The wire-code mapping is closed and executable:

| Wire surface/code | Required index result/code |
|---|---|
| `RemoteSupervisorRefusalV1`: `RIG_UNREACHABLE`, `HOST_FD_PREFLIGHT`, `STALE_OR_INVALID_STAGING` | `REFUSED/<same code>`; legal only before traffic and before any PASS/FAIL entry is appended |
| `RemoteSupervisorRefusalV1`: `MAC_GRANT_SIGNATURE_INVALID`, `MAC_SIGNING_KEY_MISMATCH`, `APPROVAL_IDENTITY_MISMATCH`, `MAC_GRANT_EXPIRED`, `MAC_GRANT_REPLAYED` | `FAIL/<same code>` |
| `RemoteSupervisorRefusalV1`: `RIG_RECEIPT_SIGNATURE_INVALID`, `RIG_SIGNING_KEY_MISMATCH`, `RIG_RECEIPT_EXPIRED`, `RIG_RECEIPT_REPLAYED` | `FAIL/<same code>` |
| `RemoteSupervisorRefusalV1`: every remaining literal | `FAIL/<same code>` |
| `ChildPipeRefusalV1`: `FRAME_INVALID`, `SEQUENCE_INVALID`, `STATE_INVALID`, `UNEXPECTED_EOF`, `UNEXPECTED_FD` | `FAIL/TRUST_PROTOCOL` |
| `ChildPipeRefusalV1`: `EXECUTION_MISMATCH` | `FAIL/CROSS_SUPERVISOR_MISMATCH` |
| `ChildPipeRefusalV1`: `COHORT_MISMATCH`, `TOKEN_INVALID`, `TOKEN_REPLAY` | `FAIL/COHORT_PROTOCOL` |
| `ChildPipeRefusalV1`: `BIND_DEADLINE_EXCEEDED`, `READY_DEADLINE_EXCEEDED` | `FAIL/COHORT_NOT_READY` |
| `ChildPipeRefusalV1`: `WARMUP_DEADLINE_EXCEEDED` | `FAIL/WARMUP_PROTOCOL` |
| `ChildPipeRefusalV1`: `MEASURE_DEADLINE_EXCEEDED` | `FAIL/MEASUREMENT_WINDOW` |
| `ChildPipeRefusalV1`: `DRAIN_DEADLINE_EXCEEDED`, `RELAY_CAPACITY_EXCEEDED` | `FAIL/RELAY_DELIVERY` |
| `ChildPipeRefusalV1`: `TEARDOWN_DEADLINE_EXCEEDED`, `CHILD_LIFECYCLE` | `FAIL/CHILD_LIFECYCLE` |
| `ChildPipeRefusalV1`: `PROCESS_RESOURCE_EXHAUSTED` | `FAIL/RUNTIME_RESOURCE_EXHAUSTION` |
| `FanoutRefuseV1`: `FRAME_INVALID` | `FAIL/TRUST_PROTOCOL` |
| `FanoutRefuseV1`: all other literals | `FAIL/COHORT_PROTOCOL` |
| `FanoutAckV1`: `DUPLICATE_PUBLISHER_SEQUENCE`, `REORDERED_PUBLISHER_SEQUENCE`, `RELAY_INGRESS_QUEUE_FULL`, `SUBSCRIBER_QUEUE_FULL`, `RELAY_WRITE_TIMEOUT`, `SUBSCRIBER_DISCONNECTED` | `FAIL/RELAY_DELIVERY` |
| `FanoutAckV1`: `REGISTRATION_CLOSED` | `FAIL/COHORT_PROTOCOL` |
| `FanoutAckV1`: `MEASUREMENT_WINDOW_CLOSED` | `FAIL/MEASUREMENT_WINDOW` |

Every producer uses only the literal legal for its current state. Every parser rejects unknown code, illegal status/code pairing, illegal acknowledgement field correlation, and a code emitted outside its named state as `FAIL/TRUST_PROTOCOL`; the verifier repeats the same check offline. Product inability to sustain topology is never relabeled environmental.

## 8. File map and atomic source-commit boundaries

### A1. Fix aggregate conservation

**Modify:** `tools/compare/adapters/wt.ts`, `tools/compare/adapters/wt.test.ts`, `tools/compare/adapters/ws.test.ts`; modify `tools/compare/adapters/ws.ts` only for the same deterministic clock seam.

- [ ] Write failing exact tests `wt_server_busy_transfers_closed_session_once`, `wt_server_busy_repeated_close_is_idempotent`, `wt_server_busy_live_plus_closed_is_65ms`, `ws_server_busy_live_plus_closed_is_65ms`, and both idle-positive-window cases.
- [ ] Run `bun test tools/compare/adapters/wt.test.ts tools/compare/adapters/ws.test.ts --timeout 10000`; expect named failures.
- [ ] Delete WT sessions from the live set before one guarded completed accumulation; keep WS semantics matching the same conservation contract.
- [ ] Re-run focused tests and `bunx tsc -p tsconfig.json`; expect exit 0.
- [ ] Commit `Fix server busy accounting to prevent closed-session double count`.

### A2. Add protocol/codecs and Ed25519 trust primitives only

**Create:** `tools/compare/cross-supervisor-protocol.ts`, `tools/compare/child-pipe-protocol.ts`, `tools/compare/cross-supervisor-protocol.test.ts`, `crates/native/tests/cross_supervisor_protocol.rs`.

**Modify:** `tools/compare/supervisor-protocol.ts`, `tools/compare/server-snapshot-protocol.ts`, `tools/compare/remote-supervisor.ts`, `crates/native/src/secure_fs.rs`, `crates/native/src/bin/comparison-supervisor.rs`, `crates/native/Cargo.toml`, `tools/compare/official-io-allowlist.json`.

- [ ] Implement exact TS/Rust codecs, distinct controller-knowable draft/final execution construction, Mac and rig keygen/sign/verify, two staged public-key fields, both durable replay ledgers, all Phase-A remote/child unions, caps, expiry and refusal codes. A2 includes no Phase-B FanoutWire/token/Merkle codec; B1 owns those.
- [ ] Production controller, `run-campaign.ts`, artifact assembly, live spawn, sealing, campaign index, promotion, and renderer remain byte-for-byte behaviorally unchanged in A2. No production path calls the new protocol; A2 is protocol-only.
- [ ] Named adversarial TS tests: `draft_rejects_controller_supplied_execution_index_or_grant_digest`, `mac_constructs_final_execution_after_grant`, `rejects_wrong_phase_a_declared_count_or_bytes`, `rejects_unsigned_mac_receipt`, `rejects_unsigned_or_controller_invented_rig_acceptance`, `rejects_wrong_mac_or_rig_staged_public_key`, `rejects_plan_or_approval_swap`, `rejects_expired_and_replayed_mac_and_rig_record_after_restart`, `rejects_cross_execution_rig_receipt`, `rejects_hash_only_grant_or_baseline_ack`, `rejects_remote_sequence_per_direction`, `rejects_child_sequence_per_direction`, `rejects_oversize_truncated_trailing_and_early_eof`, `rejects_unknown_remote_and_child_refusal_codes`, `rejects_illegal_remote_status_code_pair`, `maps_every_child_refusal_state_to_one_index_code`.
- [ ] Named Rust tests: `ed25519_mac_and_rig_receipt_round_trip`, `ed25519_wrong_public_key_is_rejected_both_directions`, `mac_and_rig_replay_leaves_are_one_shot_after_restart`, `approval_identity_mismatch_is_rejected`, `rig_key_substitution_and_rotation_same_campaign_are_rejected`, `remote_frame_sequences_are_direction_local`, `child_pipe_exact_keys_and_bounds`.
- [ ] Run:

```bash
bun test tools/compare/cross-supervisor-protocol.test.ts tools/compare/server-snapshot-protocol.test.ts tools/compare/remote-supervisor.test.ts --timeout 20000
cargo test -p native --test cross_supervisor_protocol -- --test-threads=1
cargo test -p native --bin comparison-supervisor
bunx tsc -p tsconfig.json
bun tools/compare/check-official-io.ts
```

- [ ] Expect all exit 0; commit `Add authenticated cross-supervisor codecs without changing seal production`.

### A3. Atomic controller, lifecycle, artifact, verifier, fixture, index, and command cutover

**Create:** `tools/compare/server-observation-artifact.test.ts`, `tools/compare/bin/verify-campaign-index.ts`, `tools/compare/bin/verify-campaign-index.test.ts`, `tools/compare/bin/stage-live-campaign.ts`, `tools/compare/bin/stage-live-campaign.test.ts`, `tools/compare/server-attestation-report.test.ts`.

**Modify atomically:** `tools/compare/bin/compare-controller.ts`, `tools/compare/run-campaign.ts`, `tools/compare/remote-supervisor.ts`, `tools/compare/server.ts`, `tools/compare/evidence.ts`, `tools/compare/arm-measure.ts`, `tools/compare/artifact-builder.ts`, `tools/compare/verify-artifact.ts`, `tools/compare/r1-fixtures.ts`, `tools/compare/output-policy.ts`, `tools/compare/bin/render-campaign-report.ts`, `tools/compare/bin/mint-live-trust-bootstrap.ts`, all corresponding focused tests, `crates/native/src/bin/comparison-supervisor.rs`, `crates/native/src/secure_fs.rs`, and `tools/compare/official-io-allowlist.json`.

- [ ] First write failing tests for: complete bidirectionally signed full-byte graph; real receipt paired with different grant/admission; replacement of every embedded byte field; unsigned/invented/rewritten rig acceptance, baseline ack, snapshot receipt; wrong plan/approval/candidate/source/cell/rep/transport/PID/PGID/nonce; exact Phase-A 1,600-chunk/100-MiB completion, extra/short/timeout/capture-before-close; duplicate/stale snapshot; client-series rewrite; warmup identity exactly kind/index/total `warmup/0/1` with distinct run ID; exact measured repetition 1..5; duplicate/missing/out-of-range rep; warmup/pilot bytes reused; purpose parser; fresh-root untouched; resume filtering; 1/4/5 rep promotion; mixed purpose; stale echo flats; diagnostic render without flats; external-trust-bound recursion; path/index mismatch; index/non-artifact JSON rejection; authority remaining-lifetime margin; idempotent two-key cleanup on PASS/FAIL/REFUSED/SIGINT/SIGTERM.
- [ ] `stage-live-campaign.ts` replaces fixture-pinned live minting for official use. Its closed public operator subcommands are `stage-only`, `abandon`, `freeze-run-command`, `verify-stage-approval`, `cleanup-signing-keys`, and `recover-rig-key`; its closed implementation-internal subcommands, callable only by `stage-only` or the rig-resident staged copy, are `prestage`, `observe-linux`, `mint`, `install-minted`, and `verify-stage`. Any other subcommand is rejected. It writes `.trust-staging/<candidate>/<campaign>/stage-receipt.json` containing authority/capability/lock/archive/public-key/plan/approval/executable/staged-launch digests and `externalTrustBoundSha256`.
- [ ] `mint-live-trust-bootstrap.ts` becomes explicitly fixture-only: its CLI requires `--fixture-only`, rejects candidate/campaign/official-root flags with `TRUST_FIXTURE_ONLY_MINT_FORBIDDEN`, and is unreachable from controller/live staging. `stage-live-campaign.test.ts` pins that refusal.
- [ ] `verify-campaign-index.ts` requires the exact trust flags used in section 9, recursively opens only indexed `*.sealed.json`, proves path-to-entry identity and artifact SHA, supplies `externalTrustBoundSha256` to every artifact verification, verifies expected status/promotable/flat/pair counts, and rejects unindexed seals, index JSON as artifact, symlinks, traversal, duplicates, and stale flats.
- [ ] Switch production atomically: pass both supervisor handles into `realRunBody`; schedule frozen warmup then measured identities; construct final execution only after Mac grant mint; authenticate signed rig acceptance/baseline/snapshot before Mac admission; run the completion-based Phase-A branch; retain all exact bytes/signatures; migrate `RunArtifactV2` and `CampaignIndexV2`; remove zero/fake digests; enable purpose/fresh-root/promotion/report rules; enforce remaining-lifetime preflight and idempotent success/failure/interrupt cleanup for both private keys.
- [ ] No intermediate commit may spawn the new server path while sealing v1/fabricated aggregate, nor expect v2 receipts while a producer/fixture/renderer remains v1.
- [ ] Run focused failures then green command:

```bash
bun test tools/compare/cross-supervisor-protocol.test.ts tools/compare/server-snapshot-protocol.test.ts tools/compare/server-observation-artifact.test.ts tools/compare/server-attestation-report.test.ts tools/compare/bin/compare-controller.test.ts tools/compare/bin/verify-campaign-index.test.ts tools/compare/bin/stage-live-campaign.test.ts --timeout 30000
cargo test -p native --test cross_supervisor_protocol -- --test-threads=1
cargo test -p native --bin comparison-supervisor
bun test tools/compare/ --timeout 30000
bunx tsc -p tsconfig.json
bun tools/compare/check-official-io.ts
```

- [ ] Expect all exit 0; commit `Cut over attested server artifacts so every receipt remains offline verifiable`.

### A4. Freeze the Phase A candidate

No source commit.

- [ ] Run the full gate in section 10.
- [ ] Run `git diff --check`, verify only A1-A3 scoped commits exist, and freeze the candidate HEAD. A4 performs no staged-artifact approval because the per-campaign bytes do not exist yet.

### A5. Rebuild, restage, and run the focused attestation proof

With `CAMPAIGN_ID=busyms-attested-focused-r1`, `EXECUTION_PURPOSE=focused`, and `STAGE_PROFILE=phase-a`, execute stage-only sections 9.1-9.4. Freeze `stage-receipt.json` plus the exact 9.5 command, obtain a fresh unconditional Architect then Critic approval under section 9's exact-staged-artifact record/gate, then execute run-only section 9.5 without rebuilding, reminting, restaging, editing, or changing environment bindings. Phase A staging contains no `fanout-role.ts` leaf and records its digest as `null`; no Phase B source is required. No generated evidence is committed.

**A stop gate:** exactly two indexed measured primary PASS entries, both `promotable:false`; zero FAIL/REFUSED; zero flats; each arm independently verifies the full signed byte graph, real client/server digests, finite `busyMs >= 0`, positive window, and `attested`; no fanout claim. Phase B cannot begin before this gate passes.

### B1. Add every FanoutWire, token, Merkle, warmup, and cohort codec only

**Create:** `tools/compare/scenarios/fanout-wire.ts`, `tools/compare/cohort-protocol.ts`, `tools/compare/cohort-protocol.test.ts`, `crates/native/tests/cohort_protocol.rs`.

**Modify:** `tools/compare/cross-supervisor-protocol.ts`, `tools/compare/child-pipe-protocol.ts`, `tools/compare/supervisor-protocol.ts`, `crates/native/src/secure_fs.rs`, `crates/native/src/bin/comparison-supervisor.rs`, `tools/compare/official-io-allowlist.json`.

- [ ] B1 is the sole owner of every section 4 schema and codec: signed cohort grant/warmup/barrier; rig signatures and barrier acceptance; FanoutWire register/warmup/measured/ack/end unions; token leaf manifest, Merkle tree/proof, inherited-FD token-bundle metadata and parser; total-ordinal permits; partials; separate origin-conservation/event-rate arrays; raw cohort-evidence export; exact caps/equation helpers/refusal parsing.
- [ ] B1 is protocol-only. It does not create `fanout-relay.ts`, modify server/adapters, spawn role children, switch live executors, schedule production, populate artifact v2 fanout fields, promote, or change `run-campaign.ts`.
- [ ] Named TS tests: `cohort_grant_signature_required_before_rig_action`, `warmup_wire_uses_grant_nonce_not_measured_barrier`, `barrier_requires_authenticated_rig_baseline_and_linux_acceptance`, `token_leaf_manifest_recomputes_root_without_raw_tokens`, `chat_10k_token_bundle_is_at_most_1924096_bytes`, `token_bundle_cap_plus_one_refused`, `token_fd_metadata_rejects_writable_path_backed_or_mutated_fd`, `publisher_and_subscriber_total_ordinals_are_contiguous`, `fanout_ack_union_rejects_unknown_code_and_illegal_nulls`, `origin_conservation_is_distinct_from_delivery_event_rate`, `boundary_latency_moves_rate_event_not_origin`, `post_stop_drain_is_not_measured_rate`, `raw_cohort_bundle_rejects_missing_duplicate_truncated_oversize_reordered_or_receipt_swap`.
- [ ] Exact Rust tests: `cohort_grant_v1_round_trips_exact_keys_and_signature`, `cohort_start_barrier_rejects_pre_readiness_issue`, `role_token_merkle_proof_rejects_wrong_role_and_replay`, `token_bundle_read_only_unlinked_fd_obeys_cap`, `linux_relay_observation_rejects_origin_and_capacity_mismatch`, `cohort_partial_manifest_rejects_duplicate_and_oversize`, `cohort_equations_reject_overflow_rewrite_and_event_window_conflation`.
- [ ] Run:

```bash
bun test tools/compare/cohort-protocol.test.ts --timeout 30000
cargo test -p native --test cohort_protocol -- --test-threads=1
bunx tsc -p tsconfig.json
cargo clippy -p native --lib --bin comparison-supervisor -- -D warnings
bun tools/compare/check-official-io.ts
```

- [ ] Expect all exit 0; commit `Add strict fanout and cohort codecs without switching production`.

### B2. Add the bounded two-transport relay using B1 codecs

**Create:** `tools/compare/scenarios/fanout-relay.ts`, `tools/compare/fanout-relay.test.ts`.

**Modify:** `tools/compare/server.ts`, `tools/compare/adapters/ws.ts`, `tools/compare/adapters/wt.ts`, `tools/compare/official-io-allowlist.json`.

- [ ] Import B1's single FanoutWire/token/Merkle definitions; B2 defines no duplicate wire/auth/token schema. Implement the bounded reliable WS/WT relay, Linux accepted-ingress authority, warmup drain/reset, measured barrier enforcement, origin attribution, delivery, end markers, and bounded shutdown behind tests only; no live controller/artifact cutover.
- [ ] Named tests on both transports: `mini_cohort_1_publisher_2_subscribers_ordered`, `registration_rejects_wrong_token_role_shard_and_replay`, `relay_rejects_measured_traffic_before_linux_barrier_acceptance`, `warmup_drain_resets_measured_counters`, `relay_slow_subscriber_is_bounded_failure`, `relay_global_queue_and_write_caps_hold`, `relay_duplicate_and_reorder_fail_promotion`, `relay_partial_connect_and_disconnect_are_counted`, `relay_end_markers_and_bounded_shutdown`, `ws_and_wt_wire_mapping_are_equivalent`.
- [ ] Run `bun test tools/compare/fanout-relay.test.ts --timeout 30000`; expect failures, implement, then expect exit 0 with typecheck and official-I/O check.
- [ ] Commit `Add bounded fanout relay using the frozen protocol codecs`.

### B3. Add supervisor-owned children and Linux-authoritative dataflow

**Create:** `tools/compare/bin/fanout-role.ts`, `tools/compare/fanout-supervisor-integration.test.ts`, `crates/native/tests/fanout_supervisor.rs`.

**Modify:** `tools/compare/remote-supervisor.ts`, `tools/compare/server.ts`, `tools/compare/scenarios/fanout-relay.ts`, `tools/compare/child-pipe-protocol.ts`, `crates/native/src/bin/comparison-supervisor.rs`, `crates/native/src/secure_fs.rs`, `tools/compare/official-io-allowlist.json`.

- [ ] Implement Mac-owned 10+8/1+8 spawn, direct control FDs plus sealed read-only token FD 5, one publisher+subscriber total-ordinal permit scheduler, role child entrypoint, pre-readiness replacement, Linux verification of signed cohort/warmup/barrier before each transition, rig-signed accept/start/barrier/snapshot/relay records, Linux observation, controller-to-Mac authenticated rig receipt presentation, raw evidence export, aggregation, and bounded reap behind a non-production integration entrypoint. `compare-controller.ts` production fanout selection and artifact promotion remain unchanged until B4.
- [ ] Named integration tests: `mac_supervisor_owns_exact_chat_10_plus_8`, `mac_supervisor_owns_exact_ticker_1_plus_8`, `chat_10k_token_fd_fits_and_is_read_only_unlinked`, `publisher_and_subscriber_global_ramp_is_500_per_second_and_200_total_in_flight`, `controller_cannot_invent_rewrite_or_cross_pair_any_rig_record`, `linux_accepts_signed_grant_before_server_ready`, `warmup_wire_completes_and_resets_before_baseline`, `linux_accepts_signed_barrier_before_measured_traffic`, `pre_ready_replacement_mints_new_grant_nonce_and_tokens`, `post_ready_replacement_fails`, `linux_is_authority_for_registration_ingress_capacity_and_faults`, `controller_cannot_inject_or_rewrite_partial_or_evidence_bundle`, `all_pgids_are_reaped_on_every_terminal_path`.
- [ ] Exact Rust test names: `supervisor_accepts_cohort_before_spawning_server`, `supervisor_rejects_cross_cohort_role_token`, `supervisor_receipts_linux_relay_observation_once`, `supervisor_role_child_fds_are_private_and_bounded`, `supervisor_pre_ready_replacement_invalidates_old_tokens`, `supervisor_post_ready_child_exit_is_terminal`, `supervisor_teardown_reaps_entire_process_group`.
- [ ] Exact commands:

```bash
bun test tools/compare/fanout-supervisor-integration.test.ts --timeout 45000
cargo test -p native --test fanout_supervisor -- --test-threads=1
cargo test -p native --bin comparison-supervisor
bunx tsc -p tsconfig.json
cargo clippy -p native --lib --bin comparison-supervisor -- -D warnings
bun tools/compare/check-official-io.ts
```

- [ ] Expect all exit 0; commit `Own fanout children and Linux relay facts so controller cannot rewrite cohorts`.

### B4. Atomic executor, run-campaign, artifact, promotion, and recursive-verifier cutover

**Create:** `tools/compare/fanout-executor.test.ts`, `tools/compare/fanout-artifact.test.ts`, `tools/compare/fanout-promotion.test.ts`.

**Modify atomically:** `tools/compare/client.ts`, `tools/compare/bin/compare-controller.ts`, `tools/compare/run-campaign.ts`, `tools/compare/evidence.ts`, `tools/compare/arm-measure.ts`, `tools/compare/artifact-builder.ts`, `tools/compare/verify-artifact.ts`, `tools/compare/r1-fixtures.ts`, `tools/compare/bin/verify-campaign-index.ts`, `tools/compare/bin/render-campaign-report.ts`, `tools/compare/output-policy.ts`, `tools/compare/defined-leg-executors.test.ts`, `tools/compare/official-io-allowlist.json`, and all affected exact-key fixtures/tests.

- [ ] First fail named tests proving fanout cannot call `executeRateLeg`; exact warmup + rep identities; bidirectional signature graph; Linux-authoritative accepted ingress/capacity; retained token leaf manifest/start ack/barrier acceptance and raw partial recomputation; exact `MacCohortEvidenceExportedAckV1` propagation through `ArmMeasurement`/artifact/seal/verifier; missing/duplicate/truncated/oversize/reordered bundle and genuine receipt/different partial rejection; wrong expanded-delivery grant declaration; wrong grant/token/role/shard; missing subscriber within a present worker; duplicate child/PID/shard; overlapping shard; stale/replayed/late/oversize partial; process/ledger/capacity/series rewrite; origin/event-window boundary latency and post-stop drain; cross-cohort/transport/run swap; controller injection; barrier mismatch; warmup leakage; capture before session close; 1/4/5 rep promotion; six-pair/60-seal completion; focused/pilot zero-flat behavior; recursive external-trust verification; stale echo rejection.
- [ ] Switch only the six primary fanout cells to the cohort executor and simultaneously enable `CohortObservationEvidenceV1`, observed process/capacity/ledger, purpose-aware promotion/report, real repetition propagation through `run-campaign.ts`, and the final recursive verifier/count assertions.
- [ ] Every producer, consumer, fixture, exact-key parser, seal hash, trust context, index, renderer, and promotion selector lands in this one commit; no mixed shape is runnable.
- [ ] Run focused suites and section 10 full gate; expect exit 0.
- [ ] Commit `Switch fanout seals to canonical cohorts so only complete observed topology promotes`.

### B5. Rebuild, restage, review, and run exact pilot

With `CAMPAIGN_ID=fanout-pilot-r1`, `EXECUTION_PURPOSE=pilot`, and `STAGE_PROFILE=phase-b`, execute stage-only sections 9.1-9.4. Freeze its stage receipt and exact 9.6 command, obtain that campaign's fresh unconditional Architect then Critic exact-staged-artifact approval, pass the pre-run gate, then execute run-only section 9.6 without rebuild/remint/restage/edit. No evidence commit.

**B5 stop gate:** exactly two measured PASS entries, `promotable:false`, zero FAIL/REFUSED/flats; exact one publisher, eight workers, 100 subscribers, 101 Linux sessions, 100,000 offered/accepted ingress, and 10,000,000 Linux-written/worker-delivered records for both arms.

### B6. Fresh canonical six-cell campaign

With `CAMPAIGN_ID=fanout-attested-r1`, `EXECUTION_PURPOSE=canonical`, and `STAGE_PROFILE=phase-b`, execute fresh stage-only sections 9.1-9.4; no `--resume`. B6 has its own per-campaign key pair, roots, receipt, digests, 60-seal command, and timeout, so B5 approval cannot authorize it. Freeze the B6 stage receipt and exact 9.7 command, obtain a new unconditional Architect then Critic exact-staged-artifact approval, pass the pre-run gate, then execute run-only 9.7 with no rebuild/remint/restage/edit. Stop on the first non-PASS or count mismatch. Terminal success is exactly 60 fresh measured primary PASS seals, all `promotable:true`, six paired promotions, twelve flats, 12 attested arm summaries, and no promoted echo artifact for these cells.

## 9. Exact stage-only review boundary and run-only commands

Sections 9.1-9.4 specify the internals of one stage-only transaction. The only operator entrypoint is the exact `stage-only` invocation below; the individual shell fragments in 9.2-9.4 are implementation postconditions for its tested subprocesses and MUST NOT be invoked independently. `stage-only` creates immutable bytes and MUST finish before the per-campaign staged-artifact reviews. After review, exactly one generated 9.5/9.6/9.7 wrapper is run-only; it may not call 9.1-9.4, build, keygen, mint, copy, install, or mutate a reviewed root. Any mutation abandons that campaign ID/root and requires fresh staging plus a fresh approval pair.

`stage-live-campaign.ts stage-only` installs Mac INT/TERM/HUP/EXIT handling before either key path or public digest can exist. Before remote rig keygen it starts a rig-resident transaction whose own INT/TERM/HUP/EXIT trap is installed first; on controller EOF/network loss or any pre-commit exit it deletes and absence-checks the rig key locally. Before marking staging committed, the rig arms a `_wtcompare` lease janitor bound to `(candidate,campaignId,rigPublicKeySha256,notAfterMs)`; it deletes the rig key at expiry even with no controller. Stage-only also creates one durable Mac recovery key at `/var/db/webtransport-bun/comparison/keys/<candidate>/<campaignId>.mac-recovery.pk8` (mode `0400`, owner `_wtcompare`) with public leaf `staging-root/mac-recovery-ed25519.pub`; this key is **not** deleted by run-wrapper `cleanup_signing_keys` and is the only signer allowed for `RigKeyRecoveryResultV1`. On any nonzero/interrupt the Mac wrapper independently attempts Mac **campaign** key deletion and rig deletion/recovery-requirement write, verifies campaign-key absences, retains the durable recovery key while a recovery requirement exists, retains build logs/public keys/partial staging for diagnosis, and exits nonzero if either campaign key remains or cannot be proven absent. Exit 0 deliberately retains the two campaign private keys only while awaiting exact-staged-artifact review. If either reviewer rejects, review expires, the authority margin becomes insufficient, or the operator abandons the run, `abandon` invokes campaign-key cleanup and destroys the durable recovery key only after no recovery requirement remains (or after a successful `recover-rig-key`). `recover-rig-key` is the reconnect path: it verifies the exact stage receipt/public digest, asks the rig lease janitor for status, deletes again idempotently, proves absence, and signs with the durable Mac recovery key. Tests inject failure after every keygen/build/copy/mint/install/freeze/verify step plus SIGINT/SIGTERM/HUP and rig disconnect; no locally reachable error path reports cleanup success while a campaign key remains.

These commands are part of the implementation contract and receive command-level tests. They use Bun directly and never invoke the forbidden mise Node binary.

`stage-live-campaign.ts` emits this exact-key receipt and prints the same values as `NAME=value` lines. It derives the candidate tree with `git rev-parse <candidate>^{tree}`, creates `archive-member-inventory.txt` from sorted `tar -tf source.tar`, and hashes the Mac/Linux supervisor, observer, Bun, addon/prebuild manifest, and profile-selected role entrypoints. `phase-a` hashes `server.ts` and `stage-live-campaign.ts` and requires no fanout leaf; `phase-b` additionally hashes `fanout-role.ts`. No digest is operator-entered.

```ts
interface LiveStageReceiptV1 {
  schema: "live-stage-receipt/v1";
  stageProfile: "phase-a" | "phase-b";
  candidate: string;
  candidateHead: string;
  candidateTreeOid: string;
  campaignId: string;
  sourceArchivePath: string;
  archiveSha256: Sha256Hex;
  archiveSize: number;
  archiveMemberCount: number;
  archiveMemberInventorySha256: Sha256Hex;
  authoritySha256: Sha256Hex;
  capabilitySha256: Sha256Hex;
  lockSha256: Sha256Hex;
  manifestSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  macSigningPublicKeyLeaf: "mac-supervisor-ed25519.pub";
  macSigningPublicKeySha256: Sha256Hex;
  rigSigningPublicKeyLeaf: "rig-supervisor-ed25519.pub";
  rigSigningPublicKeySha256: Sha256Hex;
  macBunSha256: Sha256Hex;
  linuxBunSha256: Sha256Hex;
  macSupervisorSha256: Sha256Hex;
  linuxSupervisorSha256: Sha256Hex;
  macObserverSha256: Sha256Hex;
  linuxObserverSha256: Sha256Hex;
  macAddonManifestSha256: Sha256Hex;
  linuxAddonManifestSha256: Sha256Hex;
  serverEntrypointSha256: Sha256Hex;
  fanoutRoleEntrypointSha256: Sha256Hex | null;
  stageToolEntrypointSha256: Sha256Hex;
  stagedServerLaunchRecordSha256: Sha256Hex;
  rigSigningKeyLeaseSha256: Sha256Hex;
  macDirectoryIdentitySha256: Sha256Hex;
  linuxDirectoryIdentitySha256: Sha256Hex;
  externalTrustBoundSha256: Sha256Hex;
  issuedAtMs: number;
  notAfterMs: number;
}

interface RigSigningKeyLeaseV1 {
  schema: "rig-signing-key-lease/v1";
  candidate: string;
  campaignId: string;
  rigPublicKeySha256: Sha256Hex;
  privateKeyPath: "/var/lib/webtransport-bun/comparison/keys/<candidate>/<campaignId>.rig.pk8";
  leasePath: "/var/lib/webtransport-bun/comparison/leases/<candidate>/<campaignId>.lease.json";
  ownerUid: "_wtcompare";
  janitorUnit: "wtcompare-rig-key-janitor@<candidate>-<campaignId>.service";
  state: "armed" | "expired-deleted" | "controller-deleted" | "recover-required";
  armedAtMs: number;
  notAfterMs: number;
  lastTransitionAtMs: number;
  lastTransitionReason:
    | "stage-only-commit"
    | "expiry"
    | "controller-cleanup"
    | "controller-eof"
    | "local-signal"
    | "recover-rig-key";
}

interface RigDisconnectRecoveryRequirementV1 {
  schema: "rig-disconnect-recovery-requirement/v1";
  candidate: string;
  campaignId: string;
  phase: "pre-stage-receipt" | "post-stage-receipt";
  stageReceiptSha256: Sha256Hex | null;
  rigPublicKeySha256: Sha256Hex;
  leaseSnapshotSha256: Sha256Hex | null;
  macCleanupStatus: "destroyed-absent" | "destroy-failed" | "absent-already";
  rigCleanupStatus: "unproven-unreachable" | "destroy-failed" | "absent";
  recordedAtMs: number;
  requiredAction: "recover-rig-key";
  recoveryRequirementPath: ".trust-staging/<candidate>/<campaignId>/recovery/rig-disconnect-requirement.json";
}

interface RigSigningKeyLeaseStatusV1 {
  schema: "rig-signing-key-lease-status/v1";
  leaseSnapshotSha256: Sha256Hex | null;
  state: "armed" | "expired-deleted" | "controller-deleted" | "recover-required";
  lastTransitionAtMs: number;
  lastTransitionReason:
    | "stage-only-commit"
    | "expiry"
    | "controller-cleanup"
    | "controller-eof"
    | "local-signal"
    | "recover-rig-key";
}

interface RigKeyAbsenceProofV1 {
  schema: "rig-key-absence-proof/v1";
  candidate: string;
  campaignId: string;
  rigPublicKeySha256: Sha256Hex;
  privateKeyPath: "/var/lib/webtransport-bun/comparison/keys/<candidate>/<campaignId>.rig.pk8";
  leaseSnapshotSha256: Sha256Hex | null;
  leaseStatusSha256: Sha256Hex;
  priorLeaseState: "armed" | "expired-deleted" | "controller-deleted" | "recover-required";
  finalLeaseState: "controller-deleted" | "expired-deleted";
  destroyResult: "destroyed" | "already-absent";
  observationMethod: "rig-supervisor-stat-absent";
  producerExecutableSha256: Sha256Hex;
  producerInstanceNonce: Sha256Hex;
  observedAtMs: number;
}

interface RigKeyRecoveryResultV1 {
  schema: "rig-key-recovery-result/v1";
  candidate: string;
  campaignId: string;
  recoveryRequirementSha256: Sha256Hex;
  stageReceiptSha256: Sha256Hex | null;
  rigPublicKeySha256: Sha256Hex;
  leaseSnapshotSha256: Sha256Hex | null;
  priorLeaseState: "armed" | "expired-deleted" | "controller-deleted" | "recover-required";
  finalLeaseState: "controller-deleted" | "expired-deleted";
  destroyResult: "destroyed" | "already-absent";
  absenceProven: true;
  absenceProofPath: ".trust-staging/<candidate>/<campaignId>/recovery/absence-proof.json";
  absenceProofSha256: Sha256Hex;
  recoverySigner: "mac-recovery-ed25519";
  macRecoveryPublicKeySha256: Sha256Hex;
  macSupervisorInstanceNonce: Sha256Hex;
  rigProducerExecutableSha256: Sha256Hex;
  rigProducerInstanceNonce: Sha256Hex;
  completedAtMs: number;
  // Contiguous recovery transition is cryptographically bound here (signed bytes), not only on the envelope.
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}

interface RigKeyRecoveryResultSignatureV1 {
  schema: "rig-key-recovery-result-signature/v1";
  algorithm: "Ed25519";
  signedSchema: "rig-key-recovery-result/v1";
  signerRole: "mac-recovery";
  signedBytesSha256: Sha256Hex;
  signingPublicKeySha256: Sha256Hex;
  macSupervisorInstanceNonce: Sha256Hex;
  signatureBase64: Base64;
  receiptSequence: number;
  issuedAtMs: number;
  notAfterMs: number;
}
```

`rigSigningKeyLeaseSha256` is SHA-256 of the exact canonical **immutable lease snapshot** bytes (`RigSigningKeyLeaseV1` with `state:"armed"` only) written once by the rig-resident staged copy and transferred to Mac under `$MAC_TRUST/staging-root/rig-signing-key-lease.armed.json` before stage-only commit. Mutable janitor status lives in a separate side file `$leasePath.status.json` and is never hashed into the stage receipt. The janitor is a `_wtcompare`-owned oneshot/timer unit that loads only that lease path, deletes the private key at `notAfterMs` or on local trap, updates only the status side file, and refuses foreign paths.

Lease state transitions are exact:
- `armed` → `expired-deleted` on janitor expiry
- `armed` → `controller-deleted` on successful controller/recover destroy+absence
- `armed` → `recover-required` on controller EOF/network loss before absence proof
- `recover-required` → `controller-deleted` on successful `recover-rig-key`
- `recover-required` → `expired-deleted` only when the janitor already expired while recover-required was pending (retain expiry reason)
- `expired-deleted` and `controller-deleted` are terminal; further destroy is idempotent already-absent; no writer may overwrite a terminal status with `recover-required` or any other non-identical bytes

Authoritative `$leasePath.status.json` mutations use helper `durable_lease_status_transition(path, newBytes)` only (never remote `tee`/truncating overwrite):
1. If path absent: exclusive durable create (unique temp `O_CREAT|O_EXCL`, write, `fsync(file)`, `link(temp,path)`, `fsync(parent)`, unlink temp).
2. If existing bytes equal `newBytes`: `fsync(parent)` and succeed (validate-and-reuse).
3. Allowed-state transitions (non-identical overwrite via unique temp, `fsync(file)`, atomic `rename(temp,path)`, `fsync(parent)` — the sole documented rename exception, limited to these pairs): `armed`→`recover-required` (install deferred Mac intended bytes), `armed`→`controller-deleted`/`expired-deleted` (direct recover/janitor-terminal), and `recover-required`→`controller-deleted`/`expired-deleted`.
4. If existing `state` is terminal (`expired-deleted`/`controller-deleted`) and new bytes differ: refuse nonzero (never install stale `recover-required` over terminal).
5. Any other from→to pair: refuse nonzero.
After any remote authoritative write, SSH-read exact bytes back and require byte-identity with `newBytes` (plus evidence copy under `$MAC_TRUST/recovery/`). Disconnect cleanup never performs the authoritative write; it is deferred-only (Mac intended bytes) so no partial authoritative file can exist from cleanup.

Early disconnect during 9.3 (before stage receipt) writes exactly one requirement with `phase:"pre-stage-receipt"`, `stageReceiptSha256:null`, `leaseSnapshotSha256` if the armed snapshot already exists else `null`, path `$MAC_TRUST/recovery/rig-disconnect-requirement.json`. Post-receipt disconnect uses `phase:"post-stage-receipt"` and non-null stage receipt digest. Exact recover argv:

```bash
"$MAC_BUN" "$REPO/tools/compare/bin/stage-live-campaign.ts" recover-rig-key \
  --repo="$REPO" --mac-bun="$MAC_BUN" --rig="$RIG" --ssh-key="$SSH_KEY" \
  --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" \
  --recovery-requirement="$MAC_TRUST/recovery/rig-disconnect-requirement.json" \
  --expected-rig-public-key-sha256="$RIG_PUBLIC_KEY_SHA256" \
  --result-out="$MAC_TRUST/recovery/rig-key-recovery-result.json"
```

`recover-rig-key` is crash-safe and ordered. Before minting any recovery artifact bytes, open or create sticky journal `$MAC_TRUST/recovery/recovery-sticky-journal.json` via the exclusive helper below. The journal freezes restart-variable non-sequence fields once: `producerInstanceNonce`, `observedAtMs`, `macSupervisorInstanceNonce`, `completedAtMs`, `issuedAtMs`, and `notAfterMs`. It does **not** pre-consume or pre-reserve a ledger `receiptSequence` (no sequence reservation before signed result bytes exist). Every retry recomputes expected proof bytes from those journaled values plus immutable requirement/stage inputs so validate-and-reuse can be byte-equal after a crash; never remint fresh timestamps/nonces for an in-flight recovery. The recovery `receiptSequence` is chosen only when signed result bytes are first minted (step 4) and is consumed/advanced only inside the single recovery commit (step 5).

Helper `durable_write_exclusive_or_reuse(path, bytes)`: if `path` is absent, create a unique temp `path.tmp.<nonce>` with `O_CREAT|O_EXCL` (never a fixed `path.tmp`), write bytes, `fsync(file)`, then `link(temp, path)` (exclusive finalization: `link` fails with `EEXIST` if `path` already appeared), `fsync(parent dir)`, unlink temp. Do **not** use replacing `rename` onto an existing final path (allowed-state lease status transitions use `durable_lease_status_transition` instead). If `path` already exists (or `link` loses the race), read exact bytes and require byte-identity with the recomputed expected bytes (validate-and-reuse), then `fsync(parent dir)` before returning so reuse proves durable directory completion; else fail nonzero without unlinking the requirement. On retry when `path` is absent but orphan `path.tmp.*` files exist: if any orphan's bytes equal the expected bytes, `fsync(orphan)`, then complete via exclusive `link(orphan, path)` + parent fsync + unlink orphans; otherwise unlink non-matching orphans and recreate with a fresh unique temp. A crash mid-sequence leaves the requirement file untouched and retries from step 1 using journaled sticky fields + validate-and-reuse for any already-durable proof, result, signature, sequence leaf, and commit. Because the ledger advances only after the recovery commit, a crash before commit never leaves a consumed sequence without matching signed bytes; a second sequence leaf for the same signed-result `receiptSequence` is never appended.

1. Idempotent destroy: invoke rig `destroy-signing-key --missing=ok` for the exact private-key path bound to `rigPublicKeySha256`. Record `destroyResult` as `destroyed` or `already-absent` only after the remote absence check returns true. Any other outcome is nonzero failure.
2. Persist lease status via `durable_lease_status_transition` on the authoritative rig path `$leasePath.status.json` (and retain an exact Mac evidence copy), with remote readback required. If Mac-retained intended `recover-required` bytes exist and authoritative status is still absent/`armed`, first transition/install those exact intended bytes (create or refuse if terminal already). Then write terminal `RigSigningKeyLeaseStatusV1` with `state` (`controller-deleted` after recover destroy, or retain `expired-deleted` when the janitor already expired), `leaseSnapshotSha256` equal to the armed snapshot digest or `null` for pre-receipt cases with no snapshot, and `lastTransitionReason:"recover-rig-key"` (except already-expired keeps reason `"expiry"`). The helper enforces the allowed non-identical overwrites listed above (`armed`/`recover-required` → terminal, and deferred `armed`→`recover-required`); terminal bytes are never overwritten with `recover-required`. Never sign or delete the requirement before this terminal status exists and readback matches.
3. Emit absence proof: the rig-resident staged `comparison-supervisor prove-signing-key-absent` produces exact canonical `RigKeyAbsenceProofV1` bytes (one trailing LF) using journaled `producerInstanceNonce`/`observedAtMs`. Mac retains them at `$MAC_TRUST/recovery/absence-proof.json` via durable_write_exclusive_or_reuse, verifies every field against the requirement/stage receipt/public digest/lease status digest, and computes `absenceProofSha256` over those exact bytes. The proof is authenticated by `producerExecutableSha256` + `producerInstanceNonce` matching the staged rig supervisor leaf; it does **not** use the campaign rig private key (already destroyed or already absent).
4. Sign result with the durable Mac recovery signer (still no ledger consume): if `--result-out` and `--result-out.sig` already exist, validate-and-reuse them and adopt the embedded `receiptSequence` as `S`. Otherwise read `S = nextReceiptSequence` for the recovery identity (do **not** advance), build exact canonical `RigKeyRecoveryResultV1` bytes embedding `absenceProofSha256`, journaled `macSupervisorInstanceNonce`/`completedAtMs`, `macRecoveryPublicKeySha256` (SHA-256 of `staging-root/mac-recovery-ed25519.pub`), and contiguous fields `receiptSequence:S`/`issuedAtMs`/`notAfterMs` (same values mirrored on `RigKeyRecoveryResultSignatureV1`), sign with `/var/db/webtransport-bun/comparison/keys/<candidate>/<campaignId>.mac-recovery.pk8` (`signerRole:"mac-recovery"`), and durable_write_exclusive_or_reuse both result and signature. Do **not** append the sequence leaf in this step.
5. Single recovery commit (atomic leaf-plus-signed-record): durable_write_exclusive_or_reuse the recovery-identity sequence leaf for `rig-key-recovery-result/v1` at `S` binding `signedBytesSha256` of the result (validate-and-reuse if leaf already matches; never a second leaf for the same `S`), then durable_write_exclusive_or_reuse `$MAC_TRUST/recovery/recovery-commit.json` binding SHA-256 digests of that sequence leaf, result bytes, and signature bytes for `S`. Only after that commit exists, advance `nextReceiptSequence` to `S+1`, unlink the recovery requirement file, then `fsync` its parent directory. Destroy the durable Mac recovery private key only after this unlink succeeds (or during `abandon` when no requirement remains).

Exit 0 only when `absenceProven:true`, `destroyResult` is `destroyed|already-absent`, result `finalLeaseState` is terminal, the recovery signature verifies against the staged `mac-recovery-ed25519.pub`, and the requirement is gone. `destroyResult:"failed"` and `priorLeaseState:"unknown-unreachable"` are never success outputs; they remain nonzero failures that leave the requirement file untouched. There is no "refresh" outcome. Named tests: reconnect-success, already-expired, already-absent, wrong-receipt, wrong-key, unreachable-again, and failed-absence-proof.

Both prestaged roots have exact directories `bin/`, `campaign-root/`, `incoming/`, `prebuilds/`, `roles/`, `staging-root/`, `replay/mac-records/`, and `replay/rig-records/`. Both staged roots contain both public-key leaves and bind both digests. For `phase-a`, the exact role leaves are `roles/server.ts` and `roles/stage-live-campaign.ts`, and `fanoutRoleEntrypointSha256` must be `null`. For `phase-b`, the exact role leaves are `roles/server.ts`, `roles/fanout-role.ts`, and `roles/stage-live-campaign.ts`, and the fanout digest must be non-null. A mismatched extra/missing role leaf is pre-traffic `REFUSED/STALE_OR_INVALID_STAGING`. `prestage` creates every directory before DirectoryIdentity observation; `mint`/`install-minted` overwrite fixed leaves without adding/removing directories.

After 9.4, `freeze-run-command` writes an immutable `$MAC_TRUST/upcoming-run-command.sh` containing exactly one of sections 9.5/9.6/9.7 with all campaign variables expanded and shell-quoted. The command file begins `set -euo pipefail`, contains the remaining-lifetime preflight and cleanup trap, and has mode `0444`. The staged review binds its SHA-256. The finalized record is `$MAC_TRUST/exact-stage-approval.json`:

```ts
interface ExactStageApprovalV1 {
  schema: "exact-stage-approval/v1";
  campaignId: string;
  executionPurpose: ExecutionPurpose;
  stageProfile: "phase-a" | "phase-b";
  runSection: "9.5" | "9.6" | "9.7";
  worktree: "/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison";
  candidateHead: string;
  stageReceiptSha256: Sha256Hex;
  approvedPlanSha256: Sha256Hex;
  approvalRecordSha256: Sha256Hex;
  upcomingRunCommandSha256: Sha256Hex;
  architectReviewPath: string;
  architectReviewSha256: Sha256Hex;
  criticReviewPath: string;
  criticReviewSha256: Sha256Hex;
  finalizedAtMs: number;
}
```

The Architect review runs first and Critic second. Each durable review artifact's first line is exactly `APPROVED` and exact labels bind `Stage receipt SHA-256`, `Upcoming run command SHA-256`, `Candidate HEAD`, `Worktree`, and `Campaign ID`. After both reviews, finalize `exact-stage-approval.json`, compute its digest without embedding a self-hash, and never edit it. Before traffic, the trap-protected `upcoming-run-command.sh` invokes `stage-live-campaign.ts verify-stage-approval` with exactly `--stage-receipt`, `--upcoming-run-command`, and `--exact-stage-approval`; it recomputes stage receipt, command, record, and both review digests; verifies actual first lines and every binding; verifies the current roots still match DirectoryIdentity; and prints `EXACT_STAGE_APPROVAL_OK`. A label missing/duplicated, digest mismatch, non-APPROVED first line, root mutation, or HEAD mismatch stops before traffic after destroying both private keys.

### 9.1 Common variables and fresh-root check

Set `CAMPAIGN_ID`/`EXECUTION_PURPOSE` to the task-specific values before running. This block is copy-pasteable from the repository worktree.

```bash
set -euo pipefail
REPO=/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison
MAC_BUN=/Users/vmeansdev/.bun/bin/bun
RIG=hermes-admin@10.99.0.2
SSH_KEY=/Users/vmeansdev/.ssh/ubuntu-vm-hermes
CANDIDATE=$(git -C "$REPO" rev-parse HEAD)
PLAN="$REPO/docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md"
APPROVAL="$REPO/docs/superpowers/plans/approvals/2026-08-30-busyMs-attested-fanout.md"
: "${CAMPAIGN_ID:?set CAMPAIGN_ID}"
: "${EXECUTION_PURPOSE:?set EXECUTION_PURPOSE}"
: "${STAGE_PROFILE:?set STAGE_PROFILE to phase-a or phase-b}"
case "$STAGE_PROFILE" in phase-a|phase-b) ;; *) exit 64 ;; esac
OUT="$REPO/.release-evidence/transport-comparison/$CANDIDATE/$CAMPAIGN_ID"
MAC_TRUST="$REPO/.release-evidence/transport-comparison/.trust-staging/$CANDIDATE/$CAMPAIGN_ID"
RIG_STAGE="/home/hermes-admin/ws-wt-stage/$CANDIDATE/$CAMPAIGN_ID"
test ! -e "$OUT"
test ! -e "$MAC_TRUST"
ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" test ! -e "$RIG_STAGE"
```

Expected: exit 0 within 15 s and none of the three roots exists. Any existing path stops; do not delete or overwrite it.

The operator now invokes exactly one transaction; this is the sole copy-pasteable stage flow. It installs cleanup before the Mac keygen and installs the rig-local trap before requesting rig keygen. On success it also runs the internal freeze operation and returns only after `stage-receipt.json` and mode-0444 `upcoming-run-command.sh` exist:

```bash
exec "$MAC_BUN" "$REPO/tools/compare/bin/stage-live-campaign.ts" stage-only \
  --repo="$REPO" --mac-bun="$MAC_BUN" --rig="$RIG" --ssh-key="$SSH_KEY" \
  --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" \
  --execution-purpose="$EXECUTION_PURPOSE" --profile="$STAGE_PROFILE" \
  --plan="$PLAN" --approval="$APPROVAL" --mac-root="$MAC_TRUST" \
  --rig-root="$RIG_STAGE" --authority-lifetime-ms=72000000
```

Expected stage-only exit 0 within 60 minutes. Any failure returns nonzero only after the two-host cleanup aggregate finishes or records a rig-disconnect recovery requirement; an unreachable rig never counts as cleanup success. Sections 9.2-9.4 below freeze the wrapper's internal actions and assertions for tests and reviewers; they are not a second operator path.

### 9.2 Mac source archive, clean archived build, and per-campaign signing key

```bash
set -euo pipefail
MAC_BUILD=$(mktemp -d /tmp/ws-wt-mac-build.XXXXXX)
MAC_RUNTIME="/usr/local/libexec/webtransport-bun/comparison/$CANDIDATE/$CAMPAIGN_ID"
mkdir -m 700 -p "$MAC_TRUST"
git -C "$REPO" archive --format=tar "$CANDIDATE" -o "$MAC_TRUST/source.tar"
tar -xf "$MAC_TRUST/source.tar" -C "$MAC_BUILD"
cd "$MAC_BUILD"
"$MAC_BUN" install --frozen-lockfile
cargo build -p native --release --bin comparison-supervisor --bin observe-directory-identity
"$MAC_BUN" run build:native
"$MAC_BUN" tools/compare/bin/stage-live-campaign.ts prestage --profile="$STAGE_PROFILE" --host=mac --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" --root="$MAC_TRUST"
id _wtcompare
/usr/bin/sudo -n -u _wtcompare true
/usr/bin/sudo -n install -d -o root -g wheel -m 755 "$MAC_RUNTIME"
/usr/bin/sudo -n install -m 0755 "$MAC_BUILD/target/release/comparison-supervisor" "$MAC_RUNTIME/comparison-supervisor"
/usr/bin/sudo -n install -m 0755 "$MAC_BUN" "$MAC_RUNTIME/bun"
/usr/bin/sudo -n install -d -o _wtcompare -g staff -m 700 "/var/db/webtransport-bun/comparison/keys/$CANDIDATE"
/usr/bin/sudo -n -u _wtcompare "$MAC_RUNTIME/comparison-supervisor" keygen-ed25519 --private-out="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8" --public-out="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pub" --overwrite=refuse
/usr/bin/sudo -n chmod 0400 "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
/usr/bin/sudo -n chown _wtcompare:staff "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
/usr/bin/sudo -n install -m 0644 "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pub" "$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub"
chgrp -R staff "$MAC_TRUST"
chmod -R g+rX "$MAC_TRUST"
test ! -r "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
```

Expected: exit 0 within 20 minutes; Mac supervisor and observer binaries plus native addon exist; keygen prints one public-key SHA-256; no existing key is overwritten.

### 9.3 Linux clean archived build and staged DirectoryIdentity

```bash
set -euo pipefail
scp -i "$SSH_KEY" -o ConnectTimeout=10 "$MAC_TRUST/source.tar" "$RIG:/tmp/ws-wt-$CANDIDATE.tar"
scp -i "$SSH_KEY" -o ConnectTimeout=10 "$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub" "$RIG:/tmp/ws-wt-$CANDIDATE.mac.pub"
ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" bash -s -- "$CANDIDATE" "$CAMPAIGN_ID" "$RIG_STAGE" "$STAGE_PROFILE" <<'RIG_BUILD'
set -euo pipefail
CANDIDATE=$1
CAMPAIGN_ID=$2
RIG_STAGE=$3
STAGE_PROFILE=$4
RIG_BUILD=$(mktemp -d /tmp/ws-wt-linux-build.XXXXXX)
tar -xf "/tmp/ws-wt-$CANDIDATE.tar" -C "$RIG_BUILD"
cd "$RIG_BUILD"
/home/hermes-admin/.bun/bin/bun install --frozen-lockfile
cargo build -p native --release --bin comparison-supervisor --bin observe-directory-identity
/home/hermes-admin/.bun/bin/bun run build:native
/home/hermes-admin/.bun/bin/bun tools/compare/bin/stage-live-campaign.ts prestage --profile="$STAGE_PROFILE" --host=linux --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" --root="$RIG_STAGE"
install -m 0755 target/release/comparison-supervisor "$RIG_STAGE/bin/comparison-supervisor"
install -m 0755 target/release/observe-directory-identity "$RIG_STAGE/bin/observe-directory-identity"
sudo -n install -d -o _wtcompare -g _wtcompare -m 700 "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE"
sudo -n -u _wtcompare "$RIG_STAGE/bin/comparison-supervisor" keygen-ed25519 --private-out="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8" --public-out="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pub" --overwrite=refuse
sudo -n chmod 0400 "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
sudo -n chown _wtcompare:_wtcompare "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
install -m 0644 "/tmp/ws-wt-$CANDIDATE.mac.pub" "$RIG_STAGE/staging-root/mac-supervisor-ed25519.pub"
sudo -n install -m 0644 "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pub" "$RIG_STAGE/staging-root/rig-supervisor-ed25519.pub"
sudo -n -u hermes-admin test ! -r "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
install -m 0644 tools/compare/server.ts "$RIG_STAGE/roles/server.ts"
if test "$STAGE_PROFILE" = phase-b; then
  install -m 0644 tools/compare/bin/fanout-role.ts "$RIG_STAGE/roles/fanout-role.ts"
fi
cp -R prebuilds/. "$RIG_STAGE/prebuilds/"
/home/hermes-admin/.bun/bin/bun tools/compare/bin/stage-live-campaign.ts observe-linux --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" --root="$RIG_STAGE" --observer="$RIG_STAGE/bin/observe-directory-identity" --out="$RIG_STAGE/linux-stage-observation.json"
RIG_BUILD
scp -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG:$RIG_STAGE/linux-stage-observation.json" "$MAC_TRUST/linux-stage-observation.json"
scp -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG:$RIG_STAGE/staging-root/rig-supervisor-ed25519.pub" "$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub"
```

Expected: exit 0 within 30 minutes; Linux observation records DirectoryIdentity and SHA-256 for supervisor, observer, Bun, addon/prebuild manifest, `server.ts`, and both public-key leaves; it records `fanoutRoleEntrypointSha256:null` for `phase-a` and the observed `fanout-role.ts` digest for `phase-b`; neither private key is controller-readable and the controller has not started.

### 9.4 Dynamic mint and exact rig restage

```bash
set -euo pipefail
cd "$MAC_BUILD"
"$MAC_BUN" tools/compare/bin/stage-live-campaign.ts mint \
  --profile="$STAGE_PROFILE" \
  --candidate="$CANDIDATE" \
  --campaign-id="$CAMPAIGN_ID" \
  --source-archive="$MAC_TRUST/source.tar" \
  --mac-root="$MAC_TRUST" \
  --linux-observation="$MAC_TRUST/linux-stage-observation.json" \
  --approved-plan="$PLAN" \
  --approval-record="$APPROVAL" \
  --mac-bun="$MAC_RUNTIME/bun" \
  --mac-supervisor="$MAC_RUNTIME/comparison-supervisor" \
  --mac-observer="$MAC_BUILD/target/release/observe-directory-identity" \
  --mac-addon-root="$MAC_BUILD/prebuilds" \
  --mac-public-key="$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub" \
  --rig-public-key="$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub" \
  --not-after-ms="$(( $(date +%s) * 1000 + 72000000 ))"
scp -i "$SSH_KEY" -o ConnectTimeout=10 \
  "$MAC_TRUST/authority.json" \
  "$MAC_TRUST/authority-digest.bin" \
  "$MAC_TRUST/campaign-root/campaign-lock.json" \
  "$MAC_TRUST/campaign-root/manifest.json" \
  "$MAC_TRUST/staging-root/staged-capability.json" \
  "$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub" \
  "$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub" \
  "$MAC_TRUST/stage-receipt.json" \
  "$RIG:$RIG_STAGE/incoming/"
ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" /home/hermes-admin/.bun/bin/bun "$RIG_STAGE/roles/stage-live-campaign.ts" install-minted --profile="$STAGE_PROFILE" --root="$RIG_STAGE" --incoming="$RIG_STAGE/incoming" --expected-receipt-sha256="$(shasum -a 256 "$MAC_TRUST/stage-receipt.json" | awk '{print $1}')"
"$MAC_BUN" tools/compare/bin/stage-live-campaign.ts verify-stage --profile="$STAGE_PROFILE" --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" --mac-root="$MAC_TRUST" --linux-observation="$MAC_TRUST/linux-stage-observation.json"
```

Expected: exit 0 within 5 minutes; `verify-stage` prints `STAGE_OK` and the exact `CAPABILITY_SHA256`, `LOCK_SHA256`, `ARCHIVE_SHA256`, `EXTERNAL_TRUST_BOUND_SHA256`, Mac/Linux executable digests, plan digest, and approval-record digest. The implementer must stage `stage-live-campaign.ts` itself under `roles/` in `prestage`; its omission is a test failure.

Load exact digests and all required runtime bindings:

```bash
set -euo pipefail
CAPABILITY_SHA256=$("$MAC_BUN" -e 'const x=await Bun.file(process.argv[1]).json();process.stdout.write(x.capabilitySha256)' "$MAC_TRUST/stage-receipt.json")
LOCK_SHA256=$("$MAC_BUN" -e 'const x=await Bun.file(process.argv[1]).json();process.stdout.write(x.lockSha256)' "$MAC_TRUST/stage-receipt.json")
ARCHIVE_SHA256=$("$MAC_BUN" -e 'const x=await Bun.file(process.argv[1]).json();process.stdout.write(x.archiveSha256)' "$MAC_TRUST/stage-receipt.json")
EXTERNAL_TRUST_BOUND_SHA256=$("$MAC_BUN" -e 'const x=await Bun.file(process.argv[1]).json();process.stdout.write(x.externalTrustBoundSha256)' "$MAC_TRUST/stage-receipt.json")
export COMPARISON_SUPERVISOR_BINARY="$MAC_RUNTIME/comparison-supervisor"
export COMPARISON_SUPERVISOR_BUN_PATH="$MAC_RUNTIME/bun"
export COMPARISON_MAC_SIGNING_KEY="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
export COMPARISON_MAC_SUPERVISOR_USER=_wtcompare
export COMPARISON_RIG_STAGED_DIR="$RIG_STAGE"
export COMPARISON_RIG_SUPERVISOR_BINARY="$RIG_STAGE/bin/comparison-supervisor"
export COMPARISON_RIG_SIGNING_KEY="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
export COMPARISON_RIG_BUN_PATH=/home/hermes-admin/.bun/bin/bun
export COMPARISON_SSH_IDENTITY="$SSH_KEY"
export COMPARISON_SSH_TARGET="$RIG"
case "$EXECUTION_PURPOSE" in
  focused) RUN_SECTION=9.5; RUN_TIMEOUT_MS=4200000 ;;
  pilot) RUN_SECTION=9.6; RUN_TIMEOUT_MS=2100000 ;;
  canonical) RUN_SECTION=9.7; RUN_TIMEOUT_MS=45000000 ;;
  *) exit 64 ;;
esac
"$MAC_BUN" tools/compare/bin/stage-live-campaign.ts freeze-run-command \
  --section="$RUN_SECTION" --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" \
  --execution-purpose="$EXECUTION_PURPOSE" --stage-receipt="$MAC_TRUST/stage-receipt.json" \
  --output="$MAC_TRUST/upcoming-run-command.sh"
test "$(stat -f '%Lp' "$MAC_TRUST/upcoming-run-command.sh")" = 444
```

Expected stage-only stop: `stage-receipt.json` and `upcoming-run-command.sh` now exist and remain immutable. Do not run traffic yet. Obtain/finalize the exact-staged-artifact approval record described above. The sole operator run command is:

```bash
bash "$MAC_TRUST/upcoming-run-command.sh"
```

That immutable file is the only place `verify-stage-approval` may execute. It installs cleanup traps first, then invokes the sole argv shown inside the trap-protected wrapper below (`--stage-receipt`, `--upcoming-run-command`, `--exact-stage-approval`). Any other flag names (`--command`, `--approval`) are rejected by the parser. A verify-stage-approval failure still destroys both private keys because traps are already installed. Do not display or run a second, out-of-trap verify-stage command.

Every frozen run command includes the trap-first wrapper below before the controller starts. Authority validity is 20 hours from mint, strictly greater than the 12.5-hour maximum frozen command plus a 90-minute verification/cleanup margin (14 hours total). Focused is 70 minutes and pilot is 35 minutes. If review delay consumes the strict margin, the already-installed EXIT trap destroys both private keys, abandons the campaign ID/root, and requires a fresh `stage-only` transaction plus fresh staged review.

`freeze-run-command` expands and shell-quotes every literal below from the already-verified stage receipt; the run file MUST NOT recompute public-key digests before trap installation. Command-level tests fail each public-key leaf read/hash and prove both private keys are deleted (or cleanup returns status 70).

```bash
set -euo pipefail
# freeze-run-command embeds ALL of the following verified literals before any trap body runs:
# REPO, CANDIDATE, CAMPAIGN_ID, EXECUTION_PURPOSE, RUN_TIMEOUT_MS, OUT, MAC_TRUST, MAC_RUNTIME,
# RIG, RIG_STAGE, SSH_KEY, MAC_BUN, MAC_PUBLIC_KEY_SHA256, RIG_PUBLIC_KEY_SHA256, STAGE_NOT_AFTER_MS,
# CAPABILITY_SHA256, LOCK_SHA256, ARCHIVE_SHA256, EXTERNAL_TRUST_BOUND_SHA256
# OUT is always the campaign evidence root and exists as a directory created with mode 0700
# by freeze-run-command before the run file is written; integrity paths never depend on later assignment.
cleanup_signing_keys() {
  # Destroys campaign Mac/rig keys only. Never deletes the durable Mac recovery key
  # (.../$CANDIDATE/$CAMPAIGN_ID.mac-recovery.pk8); recover-rig-key / abandon owns that lifecycle.
  # On post-staging rig unreachability, ALWAYS record recover-required + disconnect requirement
  # before returning 70 so reconnect recover-rig-key has required input.
  set +e
  /usr/bin/sudo -n -u _wtcompare "$MAC_RUNTIME/comparison-supervisor" destroy-signing-key \
    --private-key="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8" \
    --expected-public-key-sha256="$MAC_PUBLIC_KEY_SHA256" --missing=ok
  mac_destroy_rc=$?
  test ! -e "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
  mac_absent_rc=$?
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" \
    sudo -n -u _wtcompare "$RIG_STAGE/bin/comparison-supervisor" destroy-signing-key \
      --private-key="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8" \
      --expected-public-key-sha256="$RIG_PUBLIC_KEY_SHA256" --missing=ok
  rig_destroy_rc=$?
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" \
    test ! -e "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
  rig_absent_rc=$?
  set -e
  if [ "$rig_destroy_rc" -ne 0 ] || [ "$rig_absent_rc" -ne 0 ]; then
    # Explicit disconnect / unproven-absence path (before returning cleanup failure).
    if [ "$mac_destroy_rc" -ne 0 ]; then
      mac_cleanup_status=destroy-failed
    elif [ "$mac_absent_rc" -ne 0 ]; then
      mac_cleanup_status=destroy-failed
    else
      mac_cleanup_status=destroyed-absent
    fi
    if [ "$rig_destroy_rc" -ne 0 ] && [ "$rig_absent_rc" -ne 0 ]; then
      # SSH/unreachable typically fails both destroy and absence probes.
      rig_cleanup_status=unproven-unreachable
    elif [ "$rig_destroy_rc" -ne 0 ]; then
      rig_cleanup_status=destroy-failed
    else
      rig_cleanup_status=unproven-unreachable
    fi
    record_rig_disconnect_recovery_requirement "$mac_cleanup_status" "$rig_cleanup_status" || return 70
  fi
  if [ "$mac_destroy_rc" -ne 0 ] || [ "$mac_absent_rc" -ne 0 ] || [ "$rig_destroy_rc" -ne 0 ] || [ "$rig_absent_rc" -ne 0 ]; then
    echo "CLEANUP_FAILED mac_destroy=$mac_destroy_rc mac_absent=$mac_absent_rc rig_destroy=$rig_destroy_rc rig_absent=$rig_absent_rc" >&2
    return 70
  fi
  return 0
}
record_rig_disconnect_recovery_requirement() {
  # Args: macCleanupStatus rigCleanupStatus. Durable requirement + Mac-intended recover-required.
  # Deferred-only: NEVER remote-tee/write $leasePath.status.json here (no partial authoritative
  # bytes). Mac retains exact intended status bytes; recover-rig-key installs/transitions via
  # durable_lease_status_transition with terminal guards + remote readback.
  mac_cleanup_status="$1"
  rig_cleanup_status="$2"
  mkdir -p "$MAC_TRUST/recovery" || return 1
  export REPO CANDIDATE CAMPAIGN_ID MAC_TRUST RIG_PUBLIC_KEY_SHA256 \
    mac_cleanup_status rig_cleanup_status
  STAGE_RECEIPT="$MAC_TRUST/stage-receipt.json"
  export STAGE_RECEIPT
  "$MAC_BUN" -e "$(cat <<'BUN'
const { parseStrictJsonBytes } = await import(`${process.env.REPO}/tools/compare/secure-fs.ts`);
const { canonicalJson } = await import(`${process.env.REPO}/tools/compare/canonical.ts`);
const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");
const macTrust = process.env.MAC_TRUST;
const recoveryDir = path.join(macTrust, "recovery");
const reqPath = path.join(recoveryDir, "rig-disconnect-requirement.json");
const intendedStatusPath = path.join(recoveryDir, "rig-signing-key-lease.status.intended.json");
const stickyPath = path.join(recoveryDir, "disconnect-requirement-sticky.json");
const stagePath = process.env.STAGE_RECEIPT;
// Authoritative path is documented for recover-rig-key only (deferred-only here):
// `/var/lib/webtransport-bun/comparison/leases/${CANDIDATE}/${CAMPAIGN_ID}.lease.json.status.json`


const fsyncParent = (finalPath) => {
  const dirFd = fs.openSync(path.dirname(finalPath), "r");
  fs.fsyncSync(dirFd); fs.closeSync(dirFd);
};
const writeExcl = (finalPath, bytes) => {
  const expected = Buffer.from(bytes);
  if (fs.existsSync(finalPath)) {
    const existing = fs.readFileSync(finalPath);
    if (Buffer.compare(existing, expected) !== 0) process.exit(3);
    // Reuse must still prove durable directory completion after a crash window.
    fsyncParent(finalPath);
    return;
  }
  const orphans = fs.readdirSync(path.dirname(finalPath))
    .filter((name) => name.startsWith(path.basename(finalPath) + ".tmp."))
    .map((name) => path.join(path.dirname(finalPath), name));
  for (const orphan of orphans) {
    const ob = fs.readFileSync(orphan);
    if (Buffer.compare(ob, expected) === 0) {
      // Orphan bytes are durable before link so a crash after link still has fsynced content.
      const orphanFd = fs.openSync(orphan, "r");
      fs.fsyncSync(orphanFd); fs.closeSync(orphanFd);
      try { fs.linkSync(orphan, finalPath); } catch (e) {
        if (!(e && e.code === "EEXIST")) throw e;
        const existing = fs.readFileSync(finalPath);
        if (Buffer.compare(existing, expected) !== 0) process.exit(3);
      }
      for (const o of orphans) { try { fs.unlinkSync(o); } catch {} }
      fsyncParent(finalPath);
      return;
    }
  }
  for (const orphan of orphans) { try { fs.unlinkSync(orphan); } catch {} }
  const tmp = `${finalPath}.tmp.${crypto.randomBytes(8).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx");
  fs.writeFileSync(fd, expected);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  try {
    fs.linkSync(tmp, finalPath);
  } catch (e) {
    if (e && e.code === "EEXIST") {
      const existing = fs.readFileSync(finalPath);
      if (Buffer.compare(existing, expected) !== 0) process.exit(3);
    } else {
      throw e;
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  fsyncParent(finalPath);
};

let stageReceiptSha256 = null;
let leaseSnapshotSha256 = null;
let phase = "pre-stage-receipt";
if (fs.existsSync(stagePath)) {
  const bytes = new Uint8Array(fs.readFileSync(stagePath));
  const parsed = parseStrictJsonBytes(bytes);
  if (!parsed.ok) process.exit(2);
  const text = new TextDecoder().decode(bytes);
  if (canonicalJson(parsed.value) + "\n" !== text) process.exit(2);
  stageReceiptSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  phase = "post-stage-receipt";
  const snap = parsed.value.rigSigningKeyLeaseSha256;
  if (typeof snap !== "string" || !/^[0-9a-f]{64}$/.test(snap)) process.exit(2);
  leaseSnapshotSha256 = snap;
} else {
  // Pre-receipt: null unless an armed snapshot file already exists locally.
  const armed = path.join(macTrust, "staging-root", "rig-signing-key-lease.armed.json");
  if (fs.existsSync(armed)) {
    leaseSnapshotSha256 = crypto.createHash("sha256").update(fs.readFileSync(armed)).digest("hex");
  }
}

let sticky;
if (fs.existsSync(stickyPath)) {
  sticky = JSON.parse(fs.readFileSync(stickyPath, "utf8"));
  if (!Number.isSafeInteger(sticky.recordedAtMs) || sticky.recordedAtMs < 0) process.exit(2);
} else {
  const recordedAtMs = Date.now();
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) process.exit(2);
  sticky = { recordedAtMs, lastTransitionAtMs: recordedAtMs };
  writeExcl(stickyPath, canonicalJson(sticky) + "\n");
}

const req = {
  schema: "rig-disconnect-recovery-requirement/v1",
  candidate: process.env.CANDIDATE,
  campaignId: process.env.CAMPAIGN_ID,
  phase,
  stageReceiptSha256,
  rigPublicKeySha256: process.env.RIG_PUBLIC_KEY_SHA256,
  leaseSnapshotSha256,
  macCleanupStatus: process.env.mac_cleanup_status,
  rigCleanupStatus: process.env.rig_cleanup_status,
  recordedAtMs: sticky.recordedAtMs,
  requiredAction: "recover-rig-key",
  recoveryRequirementPath: `.trust-staging/${process.env.CANDIDATE}/${process.env.CAMPAIGN_ID}/recovery/rig-disconnect-requirement.json`,
};
const status = {
  schema: "rig-signing-key-lease-status/v1",
  leaseSnapshotSha256,
  state: "recover-required",
  lastTransitionAtMs: sticky.lastTransitionAtMs,
  lastTransitionReason: "controller-cleanup",
};
const reqBytes = canonicalJson(req) + "\n";
const statusBytes = canonicalJson(status) + "\n";
// Deferred-only authoritative status: Mac intended bytes + requirement only (restart-safe).
// recover-rig-key performs durable_lease_status_transition on $leasePath.status.json.
writeExcl(intendedStatusPath, statusBytes);
writeExcl(reqPath, reqBytes);
process.stderr.write("LEASE_STATUS_AUTHORITATIVE_WRITE_DEFERRED_TO_RECOVER\n");
BUN
)" || return 1
}
TERMINAL_KIND=FAIL
CONTROLLER_PID=""
INTEGRITY_DONE=0
ORIGINAL_RC=0
write_wrapper_terminal_substitute() {
  # Exact ControllerTerminalV1 bytes via heredoc; atomic write.
  # CONTROLLER_RC must already be the final nonzero code before this runs (never embed exit 0).
  # TERMINAL_KIND must already be FAIL or INTERRUPTED; substitute kind MUST match integrity terminal kind.
  case "$TERMINAL_KIND" in FAIL|INTERRUPTED) ;; *) return 1 ;; esac
  tmp="$OUT/controller-terminal.wrapper-substitute.json.tmp"
  export REPO CANDIDATE CAMPAIGN_ID EXECUTION_PURPOSE CONTROLLER_RC ORIGINAL_RC TERMINAL_KIND
  "$MAC_BUN" -e "$(cat <<'BUN'
const { canonicalJson } = await import(`${process.env.REPO}/tools/compare/canonical.ts`);
const rc = Number(process.env.CONTROLLER_RC);
if (!Number.isSafeInteger(rc) || rc === 0) process.exit(2);
const kind = process.env.TERMINAL_KIND;
if (kind !== "FAIL" && kind !== "INTERRUPTED") process.exit(2);
const writtenAtMs = Date.now();
if (!Number.isSafeInteger(writtenAtMs) || writtenAtMs < 0) process.exit(2);
const rec = {
  schema: "controller-terminal/v1",
  candidate: process.env.CANDIDATE,
  campaignId: process.env.CAMPAIGN_ID,
  executionPurpose: process.env.EXECUTION_PURPOSE,
  terminalKind: kind,
  campaignStatus: "FAIL",
  refusalCode: null,
  failureCode: "CHILD_LIFECYCLE",
  controllerExitCode: rc,
  trafficStarted: false,
  writtenAtMs,
};
await Bun.write(process.argv[1], canonicalJson(rec) + "\n");
BUN
)" "$tmp" || return 1
  mv -f "$tmp" "$OUT/controller-terminal.wrapper-substitute.json"
}
parse_controller_terminal_record() {
  # Shared full guarded parser for signal + measured paths. Prints terminalKind on success.
  # Enforces exact key set, schema, candidate/campaign/purpose, trafficStarted, closed enums,
  # safe-integer controllerExitCode/writtenAtMs, and kind correlations.
  export REPO CANDIDATE CAMPAIGN_ID CONTROLLER_RC EXECUTION_PURPOSE
  "$MAC_BUN" -e "$(cat <<'BUN'
const { parseStrictJsonBytes } = await import(`${process.env.REPO}/tools/compare/secure-fs.ts`);
const { canonicalJson } = await import(`${process.env.REPO}/tools/compare/canonical.ts`);
const REFUSALS = ["HOST_FD_PREFLIGHT","RIG_UNREACHABLE","STALE_OR_INVALID_STAGING"];
const FAILURES = [
  "APPROVAL_IDENTITY_MISMATCH","CHILD_LIFECYCLE","COHORT_NOT_READY","COHORT_PROTOCOL",
  "CROSS_SUPERVISOR_MISMATCH","MAC_GRANT_EXPIRED","MAC_GRANT_REPLAYED","MAC_GRANT_SIGNATURE_INVALID",
  "MAC_SIGNING_KEY_MISMATCH","MEASUREMENT_WINDOW","RELAY_DELIVERY","RIG_RECEIPT_EXPIRED",
  "RIG_RECEIPT_REPLAYED","RIG_RECEIPT_SIGNATURE_INVALID","RIG_SIGNING_KEY_MISMATCH",
  "RUNTIME_RESOURCE_EXHAUSTION","TRUST_PROTOCOL","WARMUP_PROTOCOL",
];
const bytes = new Uint8Array(await Bun.file(process.argv[1]).arrayBuffer());
const parsed = parseStrictJsonBytes(bytes);
if (!parsed.ok) process.exit(3);
const text = new TextDecoder().decode(bytes);
if (canonicalJson(parsed.value) + "\n" !== text) process.exit(3);
const fs = parsed.value;
if (fs === null || typeof fs !== "object" || Array.isArray(fs)) process.exit(3);
const keys = Object.keys(fs).sort();
const need = ["campaignId","campaignStatus","candidate","controllerExitCode","executionPurpose","failureCode","refusalCode","schema","terminalKind","trafficStarted","writtenAtMs"];
if (JSON.stringify(keys) !== JSON.stringify(need)) process.exit(3);
if (fs.schema !== "controller-terminal/v1") process.exit(3);
if (typeof fs.candidate !== "string" || typeof fs.campaignId !== "string") process.exit(3);
if (fs.candidate !== process.env.CANDIDATE || fs.campaignId !== process.env.CAMPAIGN_ID) process.exit(4);
if (fs.executionPurpose !== process.env.EXECUTION_PURPOSE) process.exit(4);
if (!["PASS","FAIL","REFUSED"].includes(fs.campaignStatus)) process.exit(3);
if (typeof fs.controllerExitCode !== "number" || !Number.isSafeInteger(fs.controllerExitCode)) process.exit(3);
if (typeof fs.trafficStarted !== "boolean") process.exit(3);
if (typeof fs.writtenAtMs !== "number" || !Number.isSafeInteger(fs.writtenAtMs) || fs.writtenAtMs < 0) process.exit(3);
if (fs.refusalCode != null && !REFUSALS.includes(fs.refusalCode)) process.exit(3);
if (fs.failureCode != null && !FAILURES.includes(fs.failureCode)) process.exit(3);
const kind = fs.terminalKind;
if (!["PASS","FAIL","REFUSED","INTERRUPTED"].includes(kind)) process.exit(3);
const rc = Number(process.env.CONTROLLER_RC);
if (!Number.isSafeInteger(rc)) process.exit(3);
if (fs.controllerExitCode !== rc) process.exit(5);
if (kind === "PASS") {
  if (rc !== 0 || fs.campaignStatus !== "PASS" || fs.refusalCode != null || fs.failureCode != null || fs.trafficStarted !== true) process.exit(5);
} else if (kind === "REFUSED") {
  if (rc === 0 || fs.trafficStarted !== false || fs.refusalCode == null || fs.failureCode != null || fs.campaignStatus !== "REFUSED") process.exit(5);
} else if (kind === "FAIL") {
  if (rc === 0 || fs.failureCode == null || fs.refusalCode != null || fs.campaignStatus !== "FAIL") process.exit(5);
} else if (kind === "INTERRUPTED") {
  if (rc === 0 || fs.campaignStatus !== "FAIL" || fs.refusalCode != null || fs.failureCode !== "CHILD_LIFECYCLE" || typeof fs.trafficStarted !== "boolean") process.exit(5);
} else {
  process.exit(3);
}
process.stdout.write(kind);
BUN
)" "$1"
}
finalize_terminal_integrity() {
  if [ "$INTEGRITY_DONE" -eq 1 ]; then
    return 0
  fi
  if [ "${ORIGINAL_RC:-0}" -eq 0 ] && [ "$TERMINAL_KIND" != INTERRUPTED ]; then
    return 0
  fi
  if [ "$TERMINAL_KIND" = PASS ]; then
    TERMINAL_KIND=FAIL
  fi
  case "$TERMINAL_KIND" in FAIL|REFUSED|INTERRUPTED) ;; *) TERMINAL_KIND=FAIL ;; esac
  mkdir -p "$OUT/integrity-only" || return 1
  # This-attempt directory only. Never accept stale immutable stdout/stderr left under integrity-only/.
  ATTEMPT_ID="$$-$(date +%s)-$RANDOM"
  ATTEMPT_DIR="$OUT/integrity-only/attempt-$ATTEMPT_ID"
  mkdir -m 700 "$ATTEMPT_DIR" || return 1
  # Prove attempt dir is empty/fresh (no pre-existing evidence files).
  for f in stdout.txt stderr.txt terminal-kind.txt exit-status.txt attempt-marker.txt; do
    if [ -e "$ATTEMPT_DIR/$f" ]; then
      echo "INTEGRITY_STALE_ATTEMPT_FILE $ATTEMPT_DIR/$f" >&2
      return 1
    fi
  done
  # Drop superseded top-level redirects if present; failure to clear is fail-closed (no || true).
  for f in stdout.txt stderr.txt terminal-kind.txt exit-status.txt attempt-marker.txt current-attempt.txt; do
    if [ -e "$OUT/integrity-only/$f" ]; then
      rm -f "$OUT/integrity-only/$f" || return 1
      if [ -e "$OUT/integrity-only/$f" ]; then
        echo "INTEGRITY_STALE_IMMUTABLE $OUT/integrity-only/$f" >&2
        return 1
      fi
    fi
  done
  : >"$ATTEMPT_DIR/stdout.txt" || return 1
  : >"$ATTEMPT_DIR/stderr.txt" || return 1
  test ! -s "$ATTEMPT_DIR/stdout.txt" || return 1
  test ! -s "$ATTEMPT_DIR/stderr.txt" || return 1
  INTEGRITY_RC=0
  set +e
  "$MAC_BUN" tools/compare/bin/verify-campaign-index.ts \
    --integrity-only --allow-partial --expected-terminal="$TERMINAL_KIND" \
    --candidate "$CANDIDATE" \
    --campaign-id "$CAMPAIGN_ID" \
    --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
    --capability-digest "$CAPABILITY_SHA256" \
    --lock-digest "$LOCK_SHA256" \
    --archive-digest "$ARCHIVE_SHA256" \
    --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
    "$OUT" \
    >"$ATTEMPT_DIR/stdout.txt" 2>"$ATTEMPT_DIR/stderr.txt"
  INTEGRITY_RC=$?
  redirect_ok=1
  test -f "$ATTEMPT_DIR/stdout.txt" && test -f "$ATTEMPT_DIR/stderr.txt" || redirect_ok=0
  printf '%s\n' "$TERMINAL_KIND" >"$ATTEMPT_DIR/terminal-kind.txt"
  kind_write_rc=$?
  printf '%s\n' "$INTEGRITY_RC" >"$ATTEMPT_DIR/exit-status.txt"
  status_write_rc=$?
  printf '%s\n' "integrity-attempt:${TERMINAL_KIND}:${INTEGRITY_RC}:${ATTEMPT_ID}" >"$ATTEMPT_DIR/attempt-marker.txt"
  marker_write_rc=$?
  printf '%s\n' "$ATTEMPT_ID" >"$OUT/integrity-only/current-attempt.txt"
  pointer_write_rc=$?
  set -e
  # INTEGRITY_DONE=1 only after this attempt's mkdir + truncates + every evidence write + pointer succeeded.
  if [ "$redirect_ok" -ne 1 ] || [ "$kind_write_rc" -ne 0 ] || [ "$status_write_rc" -ne 0 ] || [ "$marker_write_rc" -ne 0 ] \
    || [ "$pointer_write_rc" -ne 0 ] \
    || [ ! -f "$ATTEMPT_DIR/terminal-kind.txt" ] || [ ! -f "$ATTEMPT_DIR/exit-status.txt" ] \
    || [ ! -f "$ATTEMPT_DIR/attempt-marker.txt" ] || [ ! -f "$OUT/integrity-only/current-attempt.txt" ]; then
    echo "INTEGRITY_EVIDENCE_WRITE_FAILED" >&2
    return 1
  fi
  # Publish stable names only from this-attempt files (never reuse prior attempt content).
  cp -f "$ATTEMPT_DIR/stdout.txt" "$OUT/integrity-only/stdout.txt" || return 1
  cp -f "$ATTEMPT_DIR/stderr.txt" "$OUT/integrity-only/stderr.txt" || return 1
  cp -f "$ATTEMPT_DIR/terminal-kind.txt" "$OUT/integrity-only/terminal-kind.txt" || return 1
  cp -f "$ATTEMPT_DIR/exit-status.txt" "$OUT/integrity-only/exit-status.txt" || return 1
  cp -f "$ATTEMPT_DIR/attempt-marker.txt" "$OUT/integrity-only/attempt-marker.txt" || return 1
  INTEGRITY_DONE=1
  if [ "$INTEGRITY_RC" -ne 0 ]; then
    echo "INTEGRITY_ONLY_FAILED status=$INTEGRITY_RC terminal=$TERMINAL_KIND" >&2
  fi
  return 0
}
on_signal() {
  sig="$1"
  TERMINAL_KIND=INTERRUPTED
  ORIGINAL_RC=$sig
  CONTROLLER_RC=$sig
  if [ -n "${CONTROLLER_PID}" ] && kill -0 "$CONTROLLER_PID" 2>/dev/null; then
    kill -TERM "$CONTROLLER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$CONTROLLER_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$CONTROLLER_PID" 2>/dev/null || true
    wait "$CONTROLLER_PID" 2>/dev/null || CONTROLLER_RC=$?
    CONTROLLER_PID=""
  fi
  # Signal path must obey nonzero-before-substitute; never leave CONTROLLER_RC at 0.
  if [ "${CONTROLLER_RC:-0}" -eq 0 ]; then CONTROLLER_RC=$sig; fi
  export REPO CANDIDATE CAMPAIGN_ID EXECUTION_PURPOSE CONTROLLER_RC ORIGINAL_RC TERMINAL_KIND
  if [ -f "$OUT/controller-terminal.json" ]; then
    set +e
    PARSED_KIND=$(parse_controller_terminal_record "$OUT/controller-terminal.json")
    TERMINAL_PARSE_RC=$?
    set -e
    if [ "$TERMINAL_PARSE_RC" -ne 0 ] || [ "$PARSED_KIND" != INTERRUPTED ]; then
      # Substitute MUST remain INTERRUPTED (integrity terminal kind); never FAIL while TERMINAL_KIND=INTERRUPTED.
      TERMINAL_KIND=INTERRUPTED
      if ! write_wrapper_terminal_substitute; then
        echo "SIGNAL_TERMINAL_SUBSTITUTE_FAILED" >&2
        exit "$sig"
      fi
    else
      TERMINAL_KIND=$PARSED_KIND
    fi
  else
    TERMINAL_KIND=INTERRUPTED
    if ! write_wrapper_terminal_substitute; then
      echo "SIGNAL_TERMINAL_SUBSTITUTE_FAILED" >&2
      exit "$sig"
    fi
  fi
  finalize_terminal_integrity
  exit "$sig"
}
on_exit() {
  rc=$?
  trap - EXIT INT TERM HUP
  set +e
  if [ "$ORIGINAL_RC" -eq 0 ] && [ "$rc" -ne 0 ]; then
    ORIGINAL_RC=$rc
  fi
  if [ "$rc" -ne 0 ] || [ "$TERMINAL_KIND" = INTERRUPTED ] || [ "$ORIGINAL_RC" -ne 0 ]; then
    finalize_terminal_integrity
  fi
  cleanup_signing_keys
  cleanup_rc=$?
  set -e
  if [ "$cleanup_rc" -ne 0 ]; then
    rc=70
  fi
  exit "$rc"
}
# Install traps only after OUT and all digest/path literals exist in this file.
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP
trap on_exit EXIT
# Post-trap confirmation only: re-hash staged public leaves and compare to frozen literals.
test "$(shasum -a 256 "$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub" | awk '{print $1}')" = "$MAC_PUBLIC_KEY_SHA256"
test "$(shasum -a 256 "$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub" | awk '{print $1}')" = "$RIG_PUBLIC_KEY_SHA256"
NOW_MS=$(( $(date +%s) * 1000 ))
REQUIRED_REMAINING_MS=$(( RUN_TIMEOUT_MS + 5400000 ))
test "$(( STAGE_NOT_AFTER_MS - NOW_MS ))" -gt "$REQUIRED_REMAINING_MS"
# Sole verify-stage-approval invocation (exact argv).
"$MAC_BUN" "$REPO/tools/compare/bin/stage-live-campaign.ts" verify-stage-approval \
  --stage-receipt="$MAC_TRUST/stage-receipt.json" \
  --upcoming-run-command="$MAC_TRUST/upcoming-run-command.sh" \
  --exact-stage-approval="$MAC_TRUST/exact-stage-approval.json"
```

Tests freeze the exact `>` remaining-lifetime boundary: equality fails, one millisecond more passes. Cleanup is idempotent and executes after PASS, indexed FAIL, pre-traffic REFUSED, controller error, verifier error, SIGINT, SIGTERM, and bounded recovery after host restart. It preserves both public keys, replay ledgers, stage receipt, exact-stage approval, partial artifacts, and logs.

### 9.5 A5 exact focused command, recursive verification, and diagnostic render


Exact controller terminal record (atomic write by compare-controller before process exit):

```ts
interface ControllerTerminalV1 {
  schema: "controller-terminal/v1";
  candidate: string;
  campaignId: string;
  executionPurpose: ExecutionPurpose;
  terminalKind: "PASS" | "FAIL" | "REFUSED" | "INTERRUPTED";
  campaignStatus: "PASS" | "FAIL" | "REFUSED";
  refusalCode: CampaignRefusalCode | null;
  failureCode: CampaignFailureCode | null;
  controllerExitCode: number;
  trafficStarted: boolean;
  writtenAtMs: number;
}
```

`compare-controller.ts --write-terminal-record=<path>` writes this record with `O_CREAT|O_EXCL` then rename-after-fsync as exact canonical bytes (one trailing LF). The wrapper parser must decode via `parseStrictJsonBytes` (rejects duplicate keys / invalid JSON), require `canonicalJson(value)+"\n"` byte-identity, enforce the exact key set, require `Number.isSafeInteger` for `controllerExitCode` and nonnegative `writtenAtMs`, and apply closed enums `CampaignRefusalCode` / `CampaignFailureCode`. Correlations: PASS requires exit 0, `campaignStatus:"PASS"`, both codes null, and `trafficStarted:true`; REFUSED requires nonzero exit, `trafficStarted:false`, non-null refusal code, null failure code, and `campaignStatus:"REFUSED"`; FAIL requires nonzero exit, non-null failure code, null refusal code, and `campaignStatus:"FAIL"`; INTERRUPTED requires nonzero exit, `campaignStatus:"FAIL"`, null refusal code, and `failureCode:"CHILD_LIFECYCLE"`. When the controller record is missing or fails that guarded parse, the wrapper first forces `CONTROLLER_RC` to a nonzero code (68 if the observed exit was 0), then writes a full typed substitute under `$OUT/controller-terminal.wrapper-substitute.json` whose `terminalKind` equals the integrity terminal kind already selected (`FAIL` on measured-path parse failure; `INTERRUPTED` on the signal path), with `failureCode:"CHILD_LIFECYCLE"`, `trafficStarted:false`, nonnegative safe-integer `writtenAtMs`, and that nonzero safe-integer `controllerExitCode` (never exit 0). Signal-path substitute failure aborts before integrity verification (no `|| true`). Cross-campaign/candidate records and impossible correlations are rejected as malformed. Integrity-only never receives `--expected-terminal=PASS`. Signal and measured paths share one full guarded parser (`parse_controller_terminal_record`).

Sections 9.5/9.6/9.7 all use one shared run wrapper (`run_measured_campaign` below) that is expanded into each frozen command by `freeze-run-command`. It captures controller, success-verifier, render, and count statuses; derives `FAIL|REFUSED|INTERRUPTED` from the controller's typed terminal record when present (otherwise `FAIL` for nonzero controller without record, `INTERRUPTED` after signal handlers); always runs integrity-only verification after any non-success path; retains integrity stdout/stderr/exit status/selected terminal kind under `$OUT/integrity-only/`; never labels partial evidence verified when the integrity verifier fails; and returns the original nonzero status unless cleanup itself fails with 70.

```bash
run_measured_campaign() {
  # Args via env set by freeze-run-command: CELLS, REPS, PURPOSE, CAMPAIGN_ID,
  # CAMPAIGN_TIMEOUT_MS, EXPECTED_PASS, EXPECTED_PROMOTABLE, EXPECTED_FLATS,
  # EXPECTED_PAIRED_PROMOTIONS, RENDER_MODE (diagnostic|promoted), OUT
  CONTROLLER_RC=0
  "$MAC_BUN" tools/compare/bin/compare-controller.ts \
    --cells="$CELLS" \
    --reps="$REPS" \
    --execution-purpose="$PURPOSE" \
    --candidate="$CANDIDATE" \
    --campaign="$CAMPAIGN_ID" \
    --stage=full \
    --staged-dir="$MAC_TRUST" \
    --arm-kinds=primary \
    --campaign-timeout-ms="$CAMPAIGN_TIMEOUT_MS" \
    --write-terminal-record="$OUT/controller-terminal.json" &
  CONTROLLER_PID=$!
  wait "$CONTROLLER_PID" || CONTROLLER_RC=$?
  CONTROLLER_PID=""
  TERMINAL_PARSE_RC=0
  export CANDIDATE CAMPAIGN_ID CONTROLLER_RC EXECUTION_PURPOSE ORIGINAL_RC TERMINAL_KIND
  if [ -f "$OUT/controller-terminal.json" ]; then
    set +e
    PARSED_KIND=$(parse_controller_terminal_record "$OUT/controller-terminal.json")
    TERMINAL_PARSE_RC=$?
    set -e
    if [ "$TERMINAL_PARSE_RC" -eq 0 ]; then
      TERMINAL_KIND=$PARSED_KIND
    else
      TERMINAL_KIND=FAIL
      if [ "$CONTROLLER_RC" -eq 0 ]; then CONTROLLER_RC=68; fi
      export CONTROLLER_RC TERMINAL_KIND
      write_wrapper_terminal_substitute
    fi
  elif [ "$CONTROLLER_RC" -eq 0 ]; then
    # Missing record after claimed success is terminal failure.
    TERMINAL_KIND=FAIL
    CONTROLLER_RC=68
    export CONTROLLER_RC TERMINAL_KIND
    write_wrapper_terminal_substitute
  elif [ "$TERMINAL_KIND" != INTERRUPTED ]; then
    TERMINAL_KIND=FAIL
    if [ "$CONTROLLER_RC" -eq 0 ]; then CONTROLLER_RC=68; fi
    export CONTROLLER_RC TERMINAL_KIND
    write_wrapper_terminal_substitute
  fi
  SUCCESS_RC=0
  RENDER_RC=0
  COUNT_RC=0
  if [ "$CONTROLLER_RC" -eq 0 ]; then
    "$MAC_BUN" tools/compare/bin/verify-campaign-index.ts \
      --candidate "$CANDIDATE" \
      --campaign-id "$CAMPAIGN_ID" \
      --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
      --capability-digest "$CAPABILITY_SHA256" \
      --lock-digest "$LOCK_SHA256" \
      --archive-digest "$ARCHIVE_SHA256" \
      --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
      --expected-pass "$EXPECTED_PASS" --expected-fail 0 --expected-refused 0 \
      --expected-promotable "$EXPECTED_PROMOTABLE" --expected-flats "$EXPECTED_FLATS" \
      --expected-paired-promotions "$EXPECTED_PAIRED_PROMOTIONS" \
      "$OUT" || SUCCESS_RC=$?
    if [ "$SUCCESS_RC" -eq 0 ]; then
      if [ "$RENDER_MODE" = promoted ]; then
        "$MAC_BUN" tools/compare/bin/render-campaign-report.ts \
          --source=sealed-index --require-promoted-pairs="$EXPECTED_PAIRED_PROMOTIONS" \
          --candidate "$CANDIDATE" --campaign-id "$CAMPAIGN_ID" \
          --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
          --capability-digest "$CAPABILITY_SHA256" --lock-digest "$LOCK_SHA256" \
          --archive-digest "$ARCHIVE_SHA256" --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
          --output "$OUT/campaign-report.md" "$OUT" || RENDER_RC=$?
        test "$(find "$OUT" -type f -name '*.sealed.json' | wc -l | tr -d ' ')" = "$EXPECTED_PASS" || COUNT_RC=$?
        test "$(find "$OUT" -maxdepth 1 -type f -name '*.json' ! -name 'campaign-index.json' ! -name 'manifest.json' | wc -l | tr -d ' ')" = "$EXPECTED_FLATS" || COUNT_RC=$?
        test "$(rg -c '^### (WS|WT) attested arm' "$OUT/campaign-report.md")" = 12 || COUNT_RC=$?
      else
        "$MAC_BUN" tools/compare/bin/render-campaign-report.ts \
          --source=sealed-index --allow-non-promotable \
          --candidate "$CANDIDATE" --campaign-id "$CAMPAIGN_ID" \
          --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
          --capability-digest "$CAPABILITY_SHA256" --lock-digest "$LOCK_SHA256" \
          --archive-digest "$ARCHIVE_SHA256" --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
          --output "$OUT/diagnostic-report.md" "$OUT" || RENDER_RC=$?
      fi
    fi
  fi
  ORIGINAL_RC=0
  if [ "$CONTROLLER_RC" -ne 0 ]; then ORIGINAL_RC=$CONTROLLER_RC
  elif [ "$SUCCESS_RC" -ne 0 ]; then ORIGINAL_RC=$SUCCESS_RC; TERMINAL_KIND=FAIL
  elif [ "$RENDER_RC" -ne 0 ]; then ORIGINAL_RC=$RENDER_RC; TERMINAL_KIND=FAIL
  elif [ "$COUNT_RC" -ne 0 ]; then ORIGINAL_RC=$COUNT_RC; TERMINAL_KIND=FAIL
  else ORIGINAL_RC=0; TERMINAL_KIND=PASS
  fi
  if [ "$ORIGINAL_RC" -ne 0 ]; then
    if [ "$TERMINAL_KIND" = PASS ]; then TERMINAL_KIND=FAIL; fi
    finalize_terminal_integrity
  fi
  return "$ORIGINAL_RC"
}
```

Command tests cover controller FAIL, pre-traffic REFUSED, SIGINT, SIGTERM, HUP, success-verifier failure, render/count failure, missing/malformed/cross-campaign/inconsistent terminal records, and integrity-verifier failure. SIGINT/TERM/HUP each retain integrity stdout/stderr/exit status and `INTERRUPTED` terminal kind before key cleanup; exit statuses 130/143/129 are preserved unless cleanup returns 70.

```bash
set -euo pipefail
test "$CAMPAIGN_ID" = busyms-attested-focused-r1
test "$EXECUTION_PURPOSE" = focused
cd "$REPO"
OUT="$REPO/.release-evidence/transport-comparison/$CANDIDATE/busyms-attested-focused-r1"
CELLS=bulk-one-way/physical
REPS=1
PURPOSE=focused
CAMPAIGN_TIMEOUT_MS=3600000
EXPECTED_PASS=2
EXPECTED_PROMOTABLE=0
EXPECTED_FLATS=0
EXPECTED_PAIRED_PROMOTIONS=0
RENDER_MODE=diagnostic
run_measured_campaign
```

Expected within 70 minutes (`RUN_TIMEOUT_MS=4200000`, controller `--campaign-timeout-ms=3600000`): controller exit 0; `CAMPAIGN VERIFICATION OK: 2 PASS, 0 FAIL, 0 REFUSED, 0 promotable, 0 flats`; report contains two attested arms and `NON-PROMOTABLE FOCUSED EVIDENCE`, and no flat files exist. Any nonzero path runs integrity-only verification with the typed terminal kind, retains its evidence under `$OUT/integrity-only/`, preserves the original nonzero status, and the EXIT trap always destroys both private keys.

### 9.6 B5 exact pilot command, recursive verification, and diagnostic render

```bash
set -euo pipefail
test "$CAMPAIGN_ID" = fanout-pilot-r1
test "$EXECUTION_PURPOSE" = pilot
cd "$REPO"
OUT="$REPO/.release-evidence/transport-comparison/$CANDIDATE/fanout-pilot-r1"
CELLS=ticker-fanout/rate-10000
REPS=1
PURPOSE=pilot
CAMPAIGN_TIMEOUT_MS=1800000
EXPECTED_PASS=2
EXPECTED_PROMOTABLE=0
EXPECTED_FLATS=0
EXPECTED_PAIRED_PROMOTIONS=0
RENDER_MODE=diagnostic
run_measured_campaign
```

Expected within 35 minutes (`RUN_TIMEOUT_MS=2100000`, controller `--campaign-timeout-ms=1800000`): exactly two PASS/non-promotable seals and zero flats; report says `NON-PROMOTABLE PILOT EVIDENCE` and prints the exact ticker topology/cardinalities. Failure paths use the shared integrity-only wrapper and still destroy both private keys.

### 9.7 B6 exact canonical command, recursive verification, promotion, and report

```bash
set -euo pipefail
test "$CAMPAIGN_ID" = fanout-attested-r1
test "$EXECUTION_PURPOSE" = canonical
cd "$REPO"
OUT="$REPO/.release-evidence/transport-comparison/$CANDIDATE/fanout-attested-r1"
CELLS=ticker-fanout/rate-10000,ticker-fanout/rate-50000,ticker-fanout/rate-100000,chat-fanout/subscribers-1000,chat-fanout/subscribers-5000,chat-fanout/subscribers-10000
REPS=5
PURPOSE=canonical
CAMPAIGN_TIMEOUT_MS=43200000
EXPECTED_PASS=60
EXPECTED_PROMOTABLE=60
EXPECTED_FLATS=12
EXPECTED_PAIRED_PROMOTIONS=6
RENDER_MODE=promoted
run_measured_campaign
```

Expected within 12.5 hours (`RUN_TIMEOUT_MS=45000000`, controller `--campaign-timeout-ms=43200000`): `CAMPAIGN VERIFICATION OK: 60 PASS, 0 FAIL, 0 REFUSED, 60 promotable, 12 flats, 6 paired promotions`; exactly 60 nested seals; exactly 12 top-level promoted arm flats; 12 attested arm headings; six canonical cells; no stale echo/focused/pilot entry. Failure paths use the shared integrity-only wrapper and still destroy both private keys.

### 9.8 Terminal integrity verification and cleanup recovery

The shared `finalize_terminal_integrity` function is the only legal integrity path and is idempotent. It is called from `run_measured_campaign` after any non-success controller/verifier/render/count outcome, from `on_signal` after bounded controller termination, and from `on_exit` if a nonzero/interrupted path somehow skipped it. It derives `FAIL|REFUSED|INTERRUPTED` from the exact `ControllerTerminalV1` record or a wrapper substitute after guarded parse failure, never accepts `PASS` as an integrity expected-terminal, retains integrity stdout/stderr/exit/terminal-kind under `$OUT/integrity-only/`, never upgrades status or promotes from integrity-only, and preserves original statuses 130/143/129 unless cleanup returns 70. Integrity-verifier failure is retained and forbids labeling the partial evidence verified.

After any terminal path or recovery login, run `cleanup_signing_keys` again and require:

```bash
set -euo pipefail
cleanup_signing_keys
test ! -e "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" test ! -e "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
```

Expected: idempotent exit 0 within 15 s. Only the two private PKCS#8 files are removed. Public keys, replay ledgers, stage/approval receipts, artifacts, partial evidence, and integrity report remain.

## 10. Full static and regression gate

Run after A3, B4, and immediately before every live candidate review:

```bash
bun test tools/compare/ --timeout 30000
bunx tsc -p tsconfig.json
bun tools/compare/check-official-io.ts
cargo test --workspace
cargo clippy -p native --lib --bin comparison-supervisor -- -D warnings
git diff --check
```

Every command must exit 0. No test may use an unbounded iterator/stream wait. Command-level tests execute the documented argv parsers and assert all required flags, output roots, external trust binding, timeout values, and expected-count options.

## 11. Required adversarial coverage ledger

No task is complete until these named seams have an executable negative test:

- Issuer: recover-rig-key reconnect/already-expired/already-absent/wrong-receipt/wrong-key/unreachable-again/failed-absence-proof; unreadable/wrong owner for both private keys; existing key; wrong/substituted staged Mac or rig public key; invalid Mac or rig signature; altered signed bytes; plan/approval swap; exact expiry-margin boundary; replay after either supervisor restart; cross-execution/cohort pairing; key rotation under same campaign; cleanup after every keygen-stage failure, rejection, PASS/FAIL/REFUSED, SIGINT, SIGTERM, and recovery.
- Receipt bytes: hash-only evidence; controller-invented or rewritten rig acceptance/start/barrier/snapshot/relay receipt; different grant/receipt/admission pairing; each base64/size/digest/signature mutation; client-series substitution; wrong child/source/candidate/cell/rep/purpose/transport; wrong Phase-A count/bytes or fanout ingress-versus-expanded declaration.
- Control: remote versus child codec confusion; per-direction sequence duplicate/skip; missing authenticated `RigMeasureStartAckV1` or `RigBarrierAcceptanceV1`; missing controller->Mac rig presentation; unsigned cohort/warmup/barrier; traffic before Linux barrier acceptance; oversize/truncated/trailing; unexpected FD; early EOF; frame after terminal; every deadline.
- Scheduler: total ordinal wrong subscriber worker or publisher child; publisher bypass; >500/s or >200 total in flight; early/late start; barrier replay; readiness after barrier; cross-clock subtraction; warmup/measured discriminator swap or leakage; zero/two warmups; warmup identity other than kind/index/total `"warmup"/0/1`; 4/6 measured reps; capture before close; Phase-A 1,600-chunk completion timeout/short/extra.
- Replacement: fresh nonce/token/grant before readiness and full re-ready; old token replay; any replacement after readiness fails; second pre-ready replacement fails.
- Fanout wire/token FD: unknown/replayed/wrong-role/wrong-shard token; wrong Merkle proof/cohort; token leaf-manifest reorder/count/root mismatch; chat-10k exact max and cap+1; writable/path-backed/reused/mutated/short token FD; raw-token retention; duplicate role/session; warmup frame with measured barrier or measured frame with warmup nonce; invalid WS/WT mapping; payload size/hash; ack mismatch; duplicate/reorder/end replay.
- Raw fanout evidence: extra/missing publisher; missing subscriber inside otherwise present worker; duplicate child/PID/shard; shard overlap/gap; partial replay/late/oversize; missing/duplicate/truncated/oversize/reordered Mac evidence export; cohort receipt paired with different partial bytes; start-ack/token-manifest/barrier-acceptance omission; aggregate/ledger/series/capacity/process rewrite; origin conservation versus delivery-event boundary latency; delayed post-stop delivery relabeled into measured rate; Linux/publisher/worker equation mismatch.
- Purpose/promotion/root: one/four/five reps; missing/duplicate/out-of-range; mixed purpose; pilot/focused carry-forward; warmup promotion; stale echo flat; 5+4 refusal; 5+5 one promotion; six pairs/60 seals; existing root untouched.
- Recursive verifier/report: campaign-index or arbitrary JSON treated as artifact; unindexed seal; path traversal/symlink; path-to-index mismatch; absent external trust; wrong trust flags; diagnostics from seals with no flats; top-level caveat for mixed attestation; integrity-only partial verification cannot promote or change status.
- Review identity: plan-review artifact first line not `APPROVED`; wrong final plan path/SHA/worktree/HEAD label; review digest mutation; approval-record post-finalization edit; stage review wrong first line/stage receipt/command/campaign/HEAD; rebuild/restage after staged approval.

## 12. Success criteria and stop rules

Success is falsifiable only if all of the following hold:

1. A1 deterministic loaded/idle/idempotence/conservation tests pass for both adapters.
2. A5 creates exactly two fresh, non-promotable, full-byte, bidirectionally signed, independently verified completion-based primary artifacts and no flats.
3. Every artifact digest has retained bytes or a named staged immutable object except the explicitly labeled `tokenBundleSha256` destroyed-secret commitment. Raw tokens/bundles are the sole destroyed secret; their retained non-secret leaf manifest recomputes the Merkle root and shard union. Verifier recomputes all other digests offline and verifies every Mac and rig Ed25519 signature.
4. `serverAggregate` remains transparency-only in source, verifier, promotion, and report; mixed reports retain the caveat.
5. Linux authenticates the signed cohort grant/token root before server ready, the signed warmup authority before warmup, and the signed measured barrier before traffic; it is authoritative for registrations, accepted ingress, relay outcomes, and capacity.
6. Verifier reconstructs the token leaf root, every raw exported partial, shard, process, origin-conservation array, delivery-event rate array, ledger, series, capacity, authenticated baseline/barrier/Linux/snapshot join, and both issuer signature graphs under one execution.
7. B5 proves exact ticker-10k 1+8 process/101-session/100,000-ingress/10,000,000-delivery topology, including publisher+subscriber total-ordinal ramp, for both arms without promotion.
8. B6 has exactly 60 fresh measured primary PASS seals, five distinct reps per arm, six paired promotions, twelve flats, no resume, and no stale echo/pilot/focused promotion.
9. Full TS/Rust/typecheck/clippy/official-I/O/diff gate exits 0, and exact live verification/render/count assertions exit 0.
10. Final plan approval and each later A5/B5/B6 exact-staged-artifact review are distinct, sequential, actual-verdict checked, digest-bound, and invalidated by any post-review mutation.

Stop immediately when:

- final-path plan/approval/HEAD digests do not match;
- A5 fails; Phase B must not start;
- source, archive, Mac/Linux binary, Bun, addon, role entrypoint, staged root, public key, plan, approval, capability, lock, or external-trust digest differs;
- any required Mac or rig signed receipt bytes, raw cohort export, leaf manifest, baseline ack, warmup authority, or barrier acceptance are missing, oversized, unverified, or controller-substituted;
- any child/role/shard/session/total ordinal/origin window/event window/deadline/equation/count differs;
- a fresh official campaign root already exists;
- a focused/pilot/warmup/fewer-than-five/mixed-purpose/incomplete-topology artifact approaches promotion;
- any attempt is made to use `REFUSED` for protocol, product, topology, lifecycle, OOM, mid-run FD, or relay failure;
- any included unattested arm would be reported without the top-level caveat.

Post-approval implementation defects require a separately reviewed deviation. Do not edit the approved plan bytes in place.
