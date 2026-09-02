CHANGES REQUIRED

# Critic review — cohort runtime integration design

**Reviewed:** `docs/superpowers/plans/deviations/2026-09-02-cohort-runtime-integration-design.md`
**Baseline:** worktree `ws-scenario-comparison`. Revisions 1-7 reviewed at HEAD `172d6f91`;
revision 8 at HEAD `2d9eddc7` with wave-3 work uncommitted in the tree.

---

# Revision 12 review

Every item is closed, the citations are correct against the baseline each one names, and the
gate-item-7 correction fixes a rule **I** gave the design in revision 6 that was right in
general and wrong for the case S8b actually hit.

One MUST-FIX remains, and it is item 11 applied to the record §2.9(2g) just finished cleaning
up: the redundancy sweep over `MacProductionCohortMintSpec` missed `cohortIdFor`, and `cohortId`
has two incompatible provenances in the design as written.

## Verdict drivers

- **NEW-34 MUST-FIX** — `TokenCommitmentLeafManifestV1` carries a required `cohortId`, the
  controller builds and presents that manifest under edit (g), and §2.9(2a) row 1 classifies
  `cohortId` as **(C)** — minted fresh by the binary. Both cannot hold.

---

## Disposition

### NEW-32 — the TS grant encoder → **CLOSED**

§2.9(2g) takes option (i), which was the right one, and states the load-bearing argument rather
than treating the deletion as tidying. All five tree citations verify exactly:

| Cited | Found in the tree |
|---|---|
| `const grant: CohortGrantV1 = {` `:7000` | ✓ |
| `grant,` returns `:7047`, `:7056` | ✓ (the `onMinted` argument and the return) |
| `MacMintedCohortV1 { tokens, grant }` `:3128-3131` | ✓ |
| `MacCohortMinter => MacMintedCohortV1` `:3139-3142` | ✓ |

The baseline is labelled correctly this time — "verified in the tree (the review's line numbers
have moved as wave-3.5 work landed)" — which is the NEW-19 discipline applied without being
asked. My revision-11 numbers were HEAD numbers and both sets are right against their own
baseline.

Making row 1 **OUT conditionally on the deletion** is the correct framing: the walk's headline
result is now contingent on a stated edit with a named owner, rather than on an unstated
assumption. Owning it in S8a (wave 4) is also correctly sequenced — the binary must be minting
and returning the signed grant on `mac-cohort-opened-ack/v1` before the TS half can go, so the
deletion has to land after wave 3.5, not with it.

**The two-level test is the right design.** A grep-level assertion over the non-test tree that
distinguishes a constructed literal from the parser's schema comparison catches the encoder
coming back; the runtime byte-identity assertion against the ack catches the case where a
constructor is reintroduced somewhere the grep does not reach. Mutation-proving them independent
by restoring the constructor is what shows they are two nets rather than one counted twice —
the same discipline §2.9(2)'s five-of-seven invariant established, applied here.

**NEW-34 (MUST-FIX): the redundancy sweep missed `cohortIdFor`, and `cohortId` has two
provenances.** I walked `MacProductionCohortMintSpec` field by field against §2.9(2a). Nineteen
of the twenty-one inputs are genuinely redundant — `execution` and
`macExecutionGrantReceiptSha256` become (C) under §2.9(2c); `approvedPlanSha256` /
`approvalRecordSha256` are (D) via edit (f); `executionSha256`, `scenarioHash`, `rolePlanHash`,
`workloadRolePlanInputSha256` are (A); `transport` is (C); the counts and
`readinessDeadlineMs` / `measuredDurationMs` / `messageBytes` / `expectedOfferedIngress` are (A)
derived; the identity and validity fields are (C). `tokenMaterial` correctly **stays**, per
§2.2(b). That leaves `cohortIdFor`, which the sweep does not mention — and it is not redundant,
because it does not feed only the grant.

At HEAD, `TokenCommitmentLeafManifestV1` is:

```ts
export interface TokenCommitmentLeafManifestV1 {
  readonly schema: "token-commitment-leaf-manifest/v1";
  readonly executionSha256: Sha256Hex;
  readonly cohortId: string;              // ← required
  readonly leafCount: number;
  readonly leaves: readonly TokenCommitmentLeafV1[];
  readonly roleTokenCommitmentRootSha256: Sha256Hex;
}
```

Under §2.9(2e) the **controller** builds this manifest and presents it on
`mac-open-cohort-request/v1` (edit (g)), so it must choose a `cohortId` before the binary has
opened the cohort. Under §2.9(2a) row 1, `cohortId` is source **(C)** — "minted fresh per
attempt and retained" by the binary. If the binary mints `Y` while the presented manifest says
`X`, the signed grant carries `cohortId: Y` **and** a `tokenCommitmentLeafManifestSha256` over
bytes naming `X`. That is not a silent inconsistency — the offline verifier recomputes the
manifest digest (§12 #3), so it fails after a campaign, which is the expensive place.

**Exact change, and it is nearly free.** Reclassify `cohortId` in row 1 from **(C)** to **(A)
via edit (g)**: the manifest already carries it, so the binary takes it from the presented
manifest and **checks** that the grant it mints names the same `cohortId` — a checkable binding
rather than an unchecked coincidence. Nothing is lost:

- tokens are 32 random bytes (§2.4), so a controller-chosen `cohortId` is no oracle — that was
  the property §2.4's guard exists for, and it is unaffected;
- `cohortAttempt` stays **(C)**, the supervisor's own counter, which is the anti-replay property
  row 1 correctly refused to let the controller supply;
- `cohortIdFor` then has a stated role rather than being an unswept survivor of the deletion.

### NEW-33 — the narrowing → **CLOSED**

"The fourteen `MacReceiptSignatureV1` / `RIG_SIGNED_SCHEMAS` records", with
`cohort-observation-evidence/v1` noted as signed through a different carrier and handled as row
#8. Both union counts re-verified as seven each.

### The gate sentences → **CLOSED, adopted verbatim as items 10 and 11**

Both are in §4's gate list word for word, with provenance stated and item 11's derivation walked
across revisions 8-11. The added observation is a good one and not mine: **NEW-32 is item 11
applied to a deletion rather than an addition** — the TS grant becomes an output with no
consumer the moment the signed bytes arrive on the ack, and item 11 is what surfaces an unowned
second encoder before it becomes a signature-parity problem. That is the rule doing work on the
same day it was adopted, which is the best evidence it is the right rule.

### The retroactive wave-3 bookkeeping → **CLOSED**

Verified in the tree: `admitWireRegisteredCohort` at `scenarios/fanout-relay.ts:2842` and
`admissionVerdict` at `:2877`, and the allowlist line at `official-io-allowlist.json:76` is
`"mac-supervisor-spawn.test.ts"`. Recording an S4-fix slice for work that landed outside its
slice's stated scope, and routing the four residuals to the wave-3.5 gate and S9, is the right
disposition — it keeps gate item 9's "every file a slice touches has exactly one owner"
checkable retroactively rather than letting wave-3 drift become invisible.

### Gate item 7 → **CLOSED, and it corrects me**

The correction is right and the rule I gave in revision 6 was incomplete.
`check-official-io.ts:4895-4918` refuses a test that imports a `controllerOnlyTs` module with
`TEST_IMPORT_CONTROLLER_FORBIDDEN` **unless that test is itself classified `controllerTestTs`**.
Verified the chain: `remote-supervisor.ts` is in `controllerOnlyTs`;
`mac-supervisor-spawn.test.ts` is in `controllerTestTs`, which now holds **13** entries where it
held 12. So S8b's new test needed an allowlist line after all.

My revision-6 NOTE — "new `.test.ts` files are safe and need no allowlist line", justified by 38
of 112 files sitting outside the allowlist — was true only for tests that import nothing
controller-only, and false for essentially every test the remaining slices will write: S8b's,
S8a's, S9's and S10's all import controller-only modules. I should have checked the import rule
rather than the file census. Gate item 7 now says so, which is the correction.

---

## The slice table

Disjointness holds and the sequencing is right: wave 3.5 (S3-r8 → S5-MAC-RS-r8) lands the
registry edits and the binary's mint half **before** S8a in wave 4 deletes the TS grant encoder
and routes the senders — which is the only order in which the deletion is safe, because until
the binary mints and the ack returns the signed bytes, deleting the TS grant would leave the
controller with no grant at all. Vector counts unchanged at 9 / 2 / 11. Totals 16,850-22,070 src
/ 15,600-20,320 test; the small drop from revision 11 is consistent with a deletion plus two
assertions.

NEW-34's resolution lands in §2.9(2a)'s row 1 and §2.9(2e)'s step 3 — no ownership change, and
S5-MAC-RS-r8 already owns the manifest verifier that would carry the equality check.

---

## Open items

1. **NEW-34** — reclassify row 1's `cohortId` from (C) to (A) via edit (g), have the binary check
   the grant's `cohortId` against the presented manifest's, and give `cohortIdFor` a stated role
   in §2.9(2g)'s redundancy sweep.

---

# Revision 11 review

The two-encoders rule is right, the IN/OUT walk is sound, and it **corrected me**: most of the
seven records I named in NEW-30 do not need vectors, because TS *parses* them and never
re-encodes — and two of the three sites I leaned on were fixture code, not production. I check
that below and accept it.

One MUST-FIX remains, and it is the same shape as the walk itself: the headline result "zero of
the fourteen are IN" holds only if a deletion the design never states actually happens.
`cohort-grant/v1` still has a production TypeScript encoder at HEAD.

## Verdict drivers

- **NEW-32 MUST-FIX** — `createMacProductionCohortMinter` still constructs a full
  `CohortGrantV1` in TS (`remote-supervisor.ts:6459-6498`, returned as
  `MacMintedCohortV1.grant`). Under the sharpened rule that makes row 1 IN, not OUT, unless the
  design says the grant half is deleted.
- **NEW-33 NOTE** — "all fourteen signed records" excludes a fifteenth record that is also
  signed, and which the walk itself classifies IN.

---

## Disposition

### NEW-30 — the two-encoders rule and the walk → **rule CLOSED, walk CLOSED except row 1**

**The sharpening is correct and it is the right rule.** A parser cannot diverge in a way a hex
vector catches; only two encoders can. Recasting the criterion around that property, rather than
around "signed or verified across a language boundary", is what makes the enumeration checkable.

**I verified every claim the walk rests on, and they hold:**

| Claim | Verified at HEAD `2d9eddc7` |
|---|---|
| `verifyIssuerGraph` verifies over retained bytes, never a re-encoding | `verify-artifact.ts:3448-3462` — takes `SignedPair[]`, reads `retainedJson(pair.record)` / `(pair.signature)`; no canonicalisation in the path ✓ |
| exactly three `canonicalRecordBytes(` re-encode sites | `:3571`, `:3856`, `:3887` — and the file-wide count is **3** ✓ |
| the four rig receipts verified at `:3961`/`:3967`/`:3973`/`:3979` | `rig-cohort-acceptance`, `rig-warmup-drained-receipt`, `rig-barrier-acceptance`, `rig-relay-observation-receipt` ✓ |
| barrier / admission at `:3941`/`:3947` | `cohortStartBarrier`, `cohortAdmissionReceipt` ✓ |

**The self-correction is right and it retracts part of my finding.** `mintPhaseAAttestationFixture`
begins at `:1094` and the next top-level function is `cloneAttestation` at `:1537`, so
`:1145` (`mac-execution-grant-receipt/v1`), `:1192` (`rig-measure-start-ack/v1`) and `:1357`
(`mac-measurement-admission/v1`) are **all inside it**, built with the fake-digest helper `H`
(`:1085`). They are fixture builders, not production encoders. My NEW-30 was right that the old
enumeration was incomplete under its own wording, and wrong about the remedy: I inferred
"handled in TS" from module membership without checking whether the handling was an encode, a
parse, or a fixture. The sharpened rule is what exposes the difference, and the design applied it
where I had not.

**The two records genuinely IN are correctly identified.** `cohort-observation-evidence/v1`:
Rust encodes and the Mac signs its digest; TS re-encodes at `:3571` and compares against
`ack.cohortObservationEvidenceSha256` — two encoders, two languages, a signed digest between
them. `token-commitment-leaf-manifest/v1`: TS builds, Rust recomputes the root from presented
leaves. Both per-cell, both owned by the slice that owns the encoding side. Correct.

**The TS-only pair is correctly diagnosed.** `cohort-ledger/v1` and `cohort-rate-series/v1` are
built by `ensureDerivedRecords` and re-encoded at `:3856`/`:3887` — **both encoders are
TypeScript**, so a build→recompute round-trip assertion is the right guard and a cross-language
hex vector would prove nothing. Their digests are bound into `cohort-admission-receipt/v1`,
which Rust signs, but Rust digests the *received* bytes under edit (d) and never re-encodes, so
Rust is not a second encoder. Sound. Reclassifying S2's grant vector as parser-conformance is
likewise right — it pins that the TS parser accepts the Rust encoder's bytes, which is a
different and still-useful property.

### NEW-32 — MUST-FIX — `cohort-grant/v1` still has a production TypeScript encoder

The walk puts row 1 OUT on the grounds that every one of the fourteen is Rust-encoded and
TS-parsed. At HEAD that is not true of `cohort-grant/v1`.
`createMacProductionCohortMinter` constructs the full 37-field record in TypeScript
(`remote-supervisor.ts:6459-6498`, `const grant: CohortGrantV1 = { schema: "cohort-grant/v1", … }`)
and returns it:

```ts
return { tokens: { … }, grant };          // remote-supervisor.ts:6507-6515
export type MacCohortMinter = (args: {…}) => MacMintedCohortV1;   // :2597-2600
```

§2.2(b) says `createMacProductionCohortMinter` "keeps minting", and scopes that to tokens, the
manifest, the FD 5 bundles and the commitments — which is right — but **never says the grant
half is removed**. If `MacMintedCohortV1.grant` survives, `cohort-grant/v1` has a TS encoder and
a Rust encoder, which is exactly the condition the sharpened rule uses to decide IN. That would
make the headline "zero of the fourteen are IN" false for the one record whose digest anchors the
entire cohort graph — the grant is named by the epoch, the manifest, the barrier, the admission
receipt and every rig receipt.

**Exact change — pick one and write it down:**

- **(i) Delete the grant half.** `MacCohortMinter` returns tokens + `leafManifest` +
  `leafManifestBytes` only; `MacMintedCohortV1` loses `grant`; the authoritative grant exists
  only as the binary's signed bytes. Row 1 is then genuinely OUT, and S2's reclassified
  parser-conformance vector is the right and sufficient artefact. Owner: **S8a**, which owns
  `remote-supervisor.ts` — this is a deletion in a file it already edits, so it costs a line in
  its row, not a new slice.
- **(ii) Keep it** — if the controller needs a local grant view for correlation — and then row 1
  is **IN** with a per-cell two-encoder vector at chat-1k and ticker-10k, because a TS-built
  grant and a Rust-signed grant must agree byte-for-byte at every cell.

(i) is almost certainly right and is consistent with §2.9(2e)'s "the binary verifies and never
builds" symmetry, but the walk cannot claim completeness until the sentence exists.

### NEW-33 — NOTE — "all fourteen signed records" is not all the signed records

The fourteen are the `MacReceiptSignatureV1.signedSchema` union (seven,
`cross-supervisor-protocol.ts:812-818`) and `RIG_SIGNED_SCHEMAS` (seven). Verified both counts.
But `cohort-observation-evidence/v1` is **also signed** — the Mac signs its digest on
`mac-cohort-evidence-exported-ack/v1` under the revision-9 ack shrink — and it is not in either
union. So the sentence "all fourteen signed records … zero are IN" reads as "no signed record
needs a vector", while a fifteenth signed record is the primary reason the vector list is not
empty.

Say "the fourteen `MacReceiptSignatureV1` / `RIG_SIGNED_SCHEMAS` records" and add one line noting
that `cohort-observation-evidence/v1` is signed through a different carrier and is row #8. This
is precision, not correctness — but the walk's value is that it is checkable, and a reader who
takes "all signed records" literally will conclude the vector list should be empty.

### 3b — the §12 #3 rationale → **CLOSED**

The ruling now rests only on §12 #3's retention wording, and the unachievability argument is
deleted. I re-read the plan text: `plan 3598` is a retention criterion on its face ("Every
artifact digest has **retained bytes** … except the explicitly labeled `tokenBundleSha256`
destroyed-secret commitment"), and plan 1768 frames the same property as retention twice ("The
supervisor **retains only** digest/size/entry count"; "**retained**
`TokenCommitmentLeafManifestV1` contains only token hashes"). Closing 3b on the text rather than
escalating it is the correct disposition, and withdrawing a false supporting claim rather than
defending it is the right instinct — a rationale a later reader can disprove is worse than none.

### NEW-29 — the null admission receipt → **CLOSED**

A null is a refusal under `FAIL/CROSS_SUPERVISOR_MISMATCH`, with
`a_null_cohort_admission_receipt_refuses_rather_than_shortening_the_evidence` naming the exact
failure mode — a 31-field reassembly whose digest check fails with no diagnosis. That is the
right code (the ack disagrees with the execution it claims to close) and the right test name.

### NEW-31 — the five-pairs table → **CLOSED**

Enumerated by row number instead of counted.

### Bookkeeping → **CLOSED**

S3-r8 nine, S5-MAC-RS-r8 two (7 → 2 as the walk shrank the list), wave-3.5 total eleven — which
is 9 + 2 and checks. Totals 16,900-22,120 src / 15,500-20,200 test; the test range drops by
~150-220, consistent with five vectors removed and round-trip assertions added.

---

## The slice table

Unchanged from revision 10 and still disjoint: `cross-supervisor-protocol.ts` S3 across wave 1
and S3-r8; `cohort::mac` S5-MAC-RS across waves 3 and 3.5; `remote-supervisor.ts` cohort region
S8a; the two `bin/` files S9. Wave-3.5 ordering S3-r8 → S5-MAC-RS-r8 → S8a stands. NEW-32's
resolution lands in S8a under either option, so it needs no ownership change — only a sentence.

---

## Open items

1. **NEW-32** — state that `MacCohortMinter`'s grant half is deleted (option (i), owner S8a), or
   reclassify `cohort-grant/v1` as IN with a per-cell two-encoder vector.
2. **NEW-33** — narrow "all fourteen signed records" to the two named unions and note that
   `cohort-observation-evidence/v1` is signed through a different carrier and is row #8.

---

## The gate sentences, for when this is approved

The coordinator asked for these on approval; recording them now so the next revision can adopt
them without a further round. The first is unchanged from revision 7:

> **No slice may rely on a property of code it does not own — that a frame exists, that a field
> is registered, that a helper is reusable, that a mode permits access — without having read or
> executed that code at HEAD in the same commit, and cited it by file:line.**

Rounds 8-11 justify a second, and it is the lesson the mint-input/output sequence taught. Every
finding from revision 8 onward was the same omission viewed from a different side: §2.9(2) said
what each transition *verified* and not what each mint *needed* (revision 8); §2.9(2a) said what
each mint needed and not what it *produced* (NEW-22) or which budgets it *charged* (NEW-20); the
vector rule covered frames and not the records inside them (NEW-28). So:

> **For every record the design causes to be minted, state its inputs, its outputs, the carrier
> for each, and the accounting it charges — a mint whose product has no carrier is as incomplete
> as one whose input has no source.**

---

# Revision 10 review

Four of five items are closed, and the fifth is closed on its rule and open on its
enumeration. Revision 10 also caught an error I propagated: the evidence record has **33**
retained-bytes fields, not 30. I counted it at HEAD and the correction is right — revision 8
cited `cohort-protocol.ts:5393-5420`, which stops five fields short, and my revision-8 and
revision-9 reviews repeated "thirty" without re-reading. That is my failure of the gate
sentence, not the design's, and I am recording it as such.

The one remaining defect is the same species as the finding it answers: NEW-28 asked for a
rule and an enumeration, and the rule is right while the enumeration claims a completeness a
grep disproves under the rule's own wording.

## Verdict drivers

- **NEW-30 MUST-FIX** — "all eleven such records" is short by seven under the rule's own
  criterion; every one of the seven is handled in TypeScript production code, four of them in
  the offline verifier §12 #3 makes a success criterion.
- **NEW-29 / NEW-31 NOTE** — two nullable fields the partition treats as unconditional, and a
  count in prose that contradicts the table beside it.

---

## Disposition

### NEW-27 — the 33 retained strings → **CLOSED**

Counted at HEAD: `CohortObservationEvidenceV1` runs `:5393`-`:5428` and holds **33**
`RetainedCanonicalBytesV1` fields (34 `readonly`, less `schema`). The ↺ is correct and the
range in §2.9(2f) (`:5393-5427`) is right.

I checked the partition field-for-field against the interface, in order, and it matches
exactly — `workloadRolePlanInput`(1) through `cohortAdmissionSignature`(33), with the row
ranges summing to 33. Reframing the question from "which is the 30th" to "partition all of
them" was the right move; the answer to the question as I asked it would have been wrong
because the premise was wrong.

The decisive citation holds: `mac-measurement-admission-issued-ack/v1`
(`cross-supervisor-protocol.ts:2870-2877`) does carry `cohortAdmissionReceiptBase64` and
`cohortAdmissionSignatureBase64`, so rows 32-33 — the pair my question was really about — come
back on the ack of the transition that mints them. **Nothing is binary-only**, the ack shrink
is safe, and the ordering guarantee (`terminalExport: true`, so all 33 are retained before the
export runs) is the right thing to state.

**NEW-29 (NOTE): rows 32-33 are `base64OrNull`.** Both fields are `{ kind: "base64OrNull" }`,
not `base64`. The partition presents them as unconditionally returned. For a cohort execution
they must be non-null, and under this program's own rule — no value that reads as evidence may
have a default; refuse instead — a null there is a **refusal**, not an empty field. Say so in
the row, and give it to the same test that proves the reassembly, otherwise a null silently
produces a 31-field reassembly whose digest check fails with no diagnosis.

**NEW-31 (NOTE): a count in the prose contradicts the table above it.** "the six Mac-signed
records on their four acks" — the table shows **five** record+signature pairs (rows 2-3, 7-8,
9-10, 17-18, 32-33) returning on **five** acks. In the revision whose own lesson is "the count
was wrong again, which is the argument for enumerating", this sentence should either cite the
row numbers or be deleted.

### NEW-28 — the extended vector rule → **rule CLOSED, enumeration OPEN (NEW-30)**

The rule is right, and extending it rather than bolting on one vector is the right shape:

> One hex conformance vector per frame, **and per record whose canonical digest is signed or
> verified across a language boundary.**

The per-cell requirement for #8 and #9 at chat-1k and ticker-10k is correct and correctly
reasoned, and giving `cohort-observation-evidence/v1` to S5-MAC-RS-r8 puts the vector with the
slice that owns the signing side.

**NEW-30 (MUST-FIX): the enumeration is not complete under its own criterion.** The table says
"the eleven records that clause covers". Checked against both signed sets at HEAD —
`RIG_SIGNED_SCHEMAS` is **seven** (`secure_fs.rs`, and the design's own §3.3 assertion 4 says
"all seven"), and `MacReceiptSignatureV1.signedSchema` is **seven**
(`cross-supervisor-protocol.ts:812-818`) — **seven signed records are absent**, and every one is
handled in TypeScript production code:

| Absent record | TS production modules that handle it |
|---|---|
| `rig-execution-acceptance/v1` | `server-observation-artifact.ts`, `cross-supervisor-protocol.ts` |
| `rig-cohort-acceptance/v1` | **`verify-artifact.ts`**, `cohort-protocol.ts`, +2 |
| `rig-warmup-drained-receipt/v1` | **`verify-artifact.ts`**, `cohort-protocol.ts`, +2 |
| `rig-barrier-acceptance/v1` | **`verify-artifact.ts`**, `cohort-protocol.ts`, +2 |
| `rig-server-snapshot-receipt/v1` | `server-observation-artifact.ts`, +2 |
| `rig-relay-observation-receipt/v1` | **`verify-artifact.ts`**, `cohort-protocol.ts`, +2 |
| `mac-execution-grant-receipt/v1` | `server-observation-artifact.ts`, `cross-supervisor-protocol.ts` |

Four are handled in `verify-artifact.ts` — the offline verifier that §12 #3 makes a success
criterion ("Verifier recomputes all other digests offline"). And the standard being applied is
the design's own: row #7, `rig-measure-start-ack/v1`, is *in* the list with "TS
(`server-observation-artifact.ts`)" as its boundary — the identical situation as
`rig-server-snapshot-receipt/v1` and `mac-execution-grant-receipt/v1`, which are out.
`mac-execution-grant-receipt/v1` is the sharpest omission: under §2.9(2c) it becomes
Rust-minted, TS parses it, and its digest is bound into `cohort-grant/v1` (#1) and into
`rig-measure-start-ack/v1` (#7, as `macExecutionGrantReceiptSha256`), so a divergence there
breaks the Phase-A/Phase-B join.

**The fix I recommend is not "add seven vectors" — it is to sharpen the criterion.** A *parser*
cannot diverge in a way a hex vector would catch; only two *encoders* can. #8 genuinely has two
encoders (Rust signs, TS reassembles); #9 has TS encoding and Rust recomputing a root from
parsed leaves. Most of the seven above are Rust-encoded and TS-*parsed*, never TS-re-encoded, so
they need no vector — but the rule as written admits them, so it either admits them or must say
why not. Restate it as:

> per record **encoded in one language and re-encoded, or its digest recomputed from parsed
> fields, in the other**

and then walk the seven, marking each in or out with its reason. That converts a completeness
claim a grep disproves into one a grep confirms, which is the whole point of enumerating.

### NEW-25 — the destruction property → **CLOSED**

Four surface assertions plus `no_raw_token_survives_the_fd5_write`, mutation-proven by retaining
the material past `deliverSpawnConfigs`. In-memory zeroing is explicitly not claimed, and the
gap is raised in §5 rather than buried — which is exactly the disposition I asked for. The
supporting evidence is verified: `macTokenBundleForPlan` reads `tokenBase64` from a
`ReadonlyMap<string, Base64>` and canonicalises it into another string, so the bytes exist as
immutable JS strings that cannot be zeroed.

**Testing the orchestrator's provisional ruling: it is defensible, no plan amendment is needed —
but its stated rationale is wrong and should be replaced.**

The ruling's *conclusion* holds on the plan text. §12 #3's subject is artifact retention
throughout: "**Every artifact digest has retained bytes** or a named staged immutable object
**except** the explicitly labeled `tokenBundleSha256` destroyed-secret commitment" (plan 3598).
"Destroyed" is defined there by contrast with "retained" — the preimage is not kept as evidence —
not by any claim about process memory. Plan 1768 frames the same property the same way twice:
"The supervisor **retains only** digest/size/entry count", and "Raw tokens are destroyed after
both role FD load and Linux validation-table initialization; **retained**
`TokenCommitmentLeafManifestV1` contains only token hashes and leaf fields". Nothing in the plan
asks for memory erasure anywhere. So the surface assertion satisfies §12 #3, and open question
3b can be closed on the text rather than escalated.

The ruling's *rationale* does not hold. "In-memory zeroing was never enforceable under the
plan's original TS minter either" — the plan's minter is not TS. Plan 1221 says "**The Mac
supervisor** mints tokens with 32 random bytes", and under plan §3.1 the Mac supervisor is the
`comparison-supervisor` binary, where zeroing *is* achievable. The TS minter
(`createMacProductionCohortMinter`) was already a deviation at HEAD. Resting the ruling on
unachievability therefore rests it on a false premise, and a later reader who checks it will
reopen a question that the §12 #3 reading closes properly.

**Exact change:** in §2.9(2e) and §5's 3b, state the ruling as "§12 #3 is a retention criterion —
what the artifact keeps, not what the heap holds — and the surface property satisfies it",
citing plan 3598 and plan 1768. Drop the unachievability argument.

### NEW-26 — what the budget bounds → **CLOSED**

Stated in the "When" cell: cumulative decoded evidence per execution, not peak memory, with the
reason (the payload is resident twice before any field is inspected) and the correct attribution
of peak-bounding to the per-frame cap.

### Bookkeeping → **CLOSED**

S3-r8's vectors are enumerated by name and the count is **nine**; S5-MAC-RS-r8's **seven**
checks out arithmetically (§4 rows 2-6, one each, plus row 8's two per-cell). "The count was
wrong again, which is the argument for enumerating" is the right lesson to draw from having
been wrong twice. §12 #3's endorsement is added to §2.9(2e) at the right place, citing plan
3598, and the distinction it draws — plan 1221 constrains *who mints*, §12 #3 constrains what is
retained, and only the latter is a falsifiability criterion — is the strongest form of the
argument.

---

## The slice table

Disjointness, sequencing and ownership are unchanged from revision 9 and were verified then:
`cross-supervisor-protocol.ts` is S3's across wave 1 and S3-r8; `cohort::mac` is S5-MAC-RS's
across waves 3 and 3.5; `remote-supervisor.ts`'s cohort region is S8a's; the two `bin/` files are
S9's. The wave-3.5 ordering S3-r8 → S5-MAC-RS-r8 → S8a stands, and the vector ownership added
this round (rows 9-11 to S3-r8, rows 2-6 and 8 to S5-MAC-RS-r8) lands on the slices that own the
encoding side in each case — correct.

**Totals: 16,900-22,120 src / 15,650-20,420 test.** The increment over revision 9 is ~50-100 src,
the smallest of the chain, and consists of test and enumeration work rather than new machinery.
NEW-30 does not necessarily add vectors — under the sharpened criterion it may remove the
question entirely — so I would not expect it to move the range.

---

## Open items

1. **NEW-30** — sharpen the vector rule to "encoded in one language and re-encoded, or its
   digest recomputed from parsed fields, in the other", then walk the seven absent signed
   records and mark each in or out with its reason.
2. **NEW-29** — record that `cohortAdmissionReceiptBase64` / `cohortAdmissionSignatureBase64`
   are `base64OrNull` and that a null is a refusal for a cohort export, not an empty field.
3. **NEW-31** — fix or delete "the six Mac-signed records on their four acks"; the table beside
   it shows five pairs on five acks.
4. **NEW-25 rationale** — restate open question 3b's ruling on §12 #3's retention wording (plan
   3598, plan 1768) and drop the "never enforceable under the plan's original TS minter"
   argument, which is false: plan 1221's minter is the Mac supervisor binary.

---

# Revision 9 review

Both blocking findings are closed, and the token ruling is better than either option I priced —
because §12 #3 turns out to **describe** it rather than merely permit it. No blocking findings
remain. It is rejected on four must-fix items, three of which live on the new return path that
revision 9 opened (reassemble-and-verify) and one on a property §12 makes a success criterion
and the design asserts without a mechanism.

## Verdict drivers

- **NEW-27 / NEW-28 MUST-FIX** — the reassembly scheme names neither the 30th retained string
  nor a conformance vector for the record whose digest it must reproduce byte-exactly.
- **NEW-25 MUST-FIX** — "destroys the raw tokens" is a §12 #3 falsifiability criterion with no
  named mechanism and no named test, in the one process where byte-level destruction is not
  achievable.
- **NEW-26 NOTE** — what the budget actually bounds is not what its refusal code implies.

---

## Disposition

### NEW-19 — citation baseline → **CLOSED**

Every re-citation verifies exactly at `2d9eddc7` via `git show`:

| Cited | Found at HEAD |
|---|---|
| `struct OpenExecution` `:339-342` | `:339 struct OpenExecution {` ✓ |
| `open_execution` `:514` | `:514 fn open_execution(` ✓ |
| `open_next_execution` `:534` | `:534 fn open_next_execution(` ✓ |
| `accept_artifact_payload` `:570` | `:570 fn accept_artifact_payload(` ✓ |
| `present_artifact_payload` `:587` | `:587 fn present_artifact_payload(` ✓ |
| `ResidentLoop` `:286`, fields `:291`/`:292`/`:297` | all four ✓ |
| `ExecutionKey` `secure_fs.rs:10858-10863` | ✓ |
| `mac-cohort-opened-ack/v1` `:1951-1958` | six fields, no token field ✓ (newly cited, and right) |

Stating the baseline once and applying it throughout is the right correction, and the
`secure_fs.rs`-is-unchanged note is accurate — `cohort::rig` is byte-identical in the tree.

### NEW-22 — token minting → **CLOSED, and §12 #3 endorses it**

The ruling is sound and the trust argument is honest about what it gives up. What neither
document says, and what settles the question the coordinator asked about §12, is that **plan
§12 #3 already describes this design**:

> "Raw tokens/bundles are the sole destroyed secret; their **retained non-secret leaf manifest
> recomputes the Merkle root and shard union.**"

That is precisely edit (g) plus the binary's verifier: a non-secret leaf manifest is retained
and carried, and the root and shard union are recomputed from it. So the deviation is narrower
than "deviates from plan 1221" suggests — plan 1221 says *who mints*, while §12 #3, the
falsifiability criterion, constrains only *what is destroyed and what is retained*, and that is
unchanged. The design should say this: it is the strongest argument available for the ruling and
it is currently missing.

Checking the rest of §12 against the ruling:

- **#3** — satisfied, as above; the labelled `tokenBundleSha256` destroyed-secret exception is
  untouched.
- **#5** — "Linux authenticates the signed cohort grant/token root before server ready" is
  preserved, and arguably strengthened: the binary signs a root **it recomputed itself** from
  presented leaves, so a controller that presents one manifest and uses a different token set
  fails at the relay. The design makes this point correctly.
- **#1, #2, #4** — untouched; none concerns token provenance.

The five forgery properties are genuinely unaffected: all five concern **signed records**
verified against the staged rig key inside the binary, and none involves token generation.
Verified — none of the five tests changes.

Two consequential claims I checked and confirmed: `parse_shards`
(`secure_fs.rs:12531-12574`) does implement the shard-union half the binary now needs, so the
Rust side gains a **verifier** and not a builder; and the per-cell vector requirement (chat-1k
*and* ticker-10k, because shard construction differs per cell) is the right shape — it is the
finding I raised in revision 8's review, adopted rather than argued with.

**NEW-25 (MUST-FIX): "destroys the raw tokens" has no mechanism and no test, and §12 makes it a
success criterion.** Step 2 of the ruling reads "writes the FD 5 bundles, where it already does,
and destroys the raw tokens per plan 1768-1770." No mechanism is named, and no test for it
appears anywhere in §4 or §3.3's assertion list.

That matters more here than it would elsewhere, because §12 #3 makes destruction one of the five
conditions under which success is falsifiable — and the controller is the process where
byte-level destruction is least achievable. Verified: `macTokenBundleForPlan` builds
`token-bundle-entry/v1` records carrying `tokenBase64` drawn from
`material.tokenBase64ByRoleId` — **immutable JavaScript strings** — which are then canonicalised
into a JSON string for the FD 5 write. Strings cannot be zeroed, and the encoder may have made
copies. `Uint8Array.fill(0)` on the source bytes does not reach them.

In fairness this is the **status quo**, not something revision 9 introduces: the controller
already writes those bundles at HEAD. What revision 9 does is make the controller the minter as
well, and then assert a destruction property in a document that has spent nine revisions
refusing to let claims stand without producers.

**Exact change:** scope the property honestly and give it a test. Say that byte-level
destruction is not achievable in the controller process, and that the enforced property is a
*surface* one — no raw token on any structure that outlives the FD 5 write, none reaching the
artifact, `tokenSha256ByRoleId` and the retained manifest holding hashes only — asserted by a
named test in S8a or S9, in the shape of `the_server_child_holds_no_signing_key`. If that is
weaker than §12 #3 intends, that is a maintainer question worth asking explicitly rather than
leaving inside the word "destroys".

### NEW-20 — the evidence budget → **CLOSED**

§2.9(2d) is complete: accumulator on both sides keyed per execution, exactly three debiting
frames, the charge point stated in each language, owners split S3 / S5-MAC-RS / S8a, and
`the_budget_refuses_where_the_per_frame_cap_would_not` with a mutation proof that removes the
accumulator and shows only that test goes red. The reasoning for why that test is the load-bearing
one — "without this test the accounting could be absent and every per-frame check would still
pass, which is exactly how the constant reached HEAD with no consumer" — is the right diagnosis
of its own bug.

I re-verified the constant's reference set: declaration at `cross-supervisor-protocol.ts:1761`,
an import at `cohort-protocol.test.ts:3090`, and two assertions at `:3349` and `:3379`. **No
production consumer**, as stated.

**"Before allocation" is achievable, and I checked the mechanism rather than the claim.** The
field kinds validate base64 with `isStrictBase64`, which is a length check plus a **regex on the
string** — no decode. `fromBase64` (`:277`) is a separate function called at the use site. So the
parser can charge the declared size and refuse without ever decoding. ✓

`FAIL/RUNTIME_RESOURCE_EXHAUSTION` verified at plan 2300 — "Mid-run OOM or FD exhaustion". It is
the right choice: §7's closed set has no nearer literal, and the code names the class the guard
exists to prevent. See NEW-26 for the one thing that should be said alongside it.

**NEW-26 (NOTE): the budget does not bound what its code implies.** By the time any field is
inspected, the frame's payload is already resident twice — the wire bytes and the parsed JSON
string. Charging before the decode bounds the **third** allocation only. Two 14 MiB encoded
frames are therefore both fully in memory before the second is refused, and the thing that bounds
peak memory is the per-frame cap, not the budget. The budget bounds **cumulative decoded
evidence**, which is the right thing for it to bound. Say so in the table's "When" cell, because
`RUNTIME_RESOURCE_EXHAUSTION` reads as a memory guard and an implementer may size the accumulator
believing it is one.

### NEW-21 — the cap split → **CLOSED on the split; OPEN on NEW-27 and NEW-28**

The split is right and the reasoning is the best in revision 9: moving the 14/9 pair to the side
that carries the bulk, shrinking the ack to 8 KiB, and having the controller **reassemble and
verify against the Mac-signed digest** rather than trust a returned blob. "The controller can
only produce the bytes the Mac actually digested, or fail the check" is exactly the
records-not-digests principle applied in the return direction. Charged decoded: 9 of 20 MiB,
leaving 11 — and encoded fits too, so the arithmetic is legal under either reading, which
disposes of my NEW-21 cleanly.

**§12 #3's "retained bytes" is preserved**, and for a non-obvious reason worth stating in the
design: the artifact retains the *reassembled* bytes, and the digest check is what proves those
are the bytes the Mac signed. Without the check the property would fail; with it, reassembly is
as strong as carriage. That is the whole justification for the ack shrink and it should be
written down.

**NEW-27 (MUST-FIX): the 30th string is never named.** "it supplied 29 of the 30 retained strings
and holds the rest" occurs exactly once (`:1174`), and no line in the document says which string
the 30th is or where the controller obtains it. The entire reassembly scheme depends on the
controller being able to produce all thirty; if the 30th is something only the binary holds and
no longer returns — the ack having just been shrunk to a digest, a size and a signature — then
reassembly cannot succeed and the export fails at the end of every measured run. Name it, and
name its source.

**NEW-28 (MUST-FIX): reassemble-and-verify makes two canonical encoders load-bearing for a signed
digest, with no conformance vector.** The binary canonically encodes `cohort-observation-evidence/v1`
and signs its digest; the controller must reproduce **those exact bytes** in TypeScript. That is a
cross-language canonical-encoding parity requirement on a signature — the precise class §4's "one
hex conformance vector per frame" rule exists for — and it falls through the rule's gap because
this record is *inside* a frame rather than being one. Grep confirms the only two mentions of
`cohort-observation-evidence/v1` in the design are §2.9(2)'s row and row 8's heading; no vector
is named anywhere.

A one-byte divergence between the encoders makes every export fail **after a full measured run**,
which is the most expensive place in the program to discover an encoder difference. **Exact
change:** pin a hex vector for the canonical `cohort-observation-evidence/v1` bytes, per cell, in
the same shape as edit (g)'s per-cell manifest vectors, and add it to S5-MAC-RS-r8's list;
extend §4's vector rule to say "per frame **and per record whose digest is signed across a
language boundary**."

### NEW-23 — the array kind's union → **CLOSED**

`base64Array` is named for `CohortRemoteFieldKind`, and the six-kind state at `:1899-1905` is
re-verified. Stating that S3 maintains two vocabularies is the right prophylactic — this design
has mis-aimed a field kind twice.

### NEW-24 — the re-entry point → **CLOSED**

Wave 3.5 exists with **S3-r8** and **S5-MAC-RS-r8**, the ordering is stated, and both parent rows
carry explicit scope boundaries ("wave-1 scope only", "wave-3 verification half only; the mint
half is S5-MAC-RS-r8 in wave 3.5") with the mint-half tests listed under the new wave rather than
the old one. The do-not-re-do boundary is exactly what I asked for, and the S5-MAC-RS estimate is
now anchored at one end by a real implementation rather than only by `cohort::rig`'s line count —
which is a genuine improvement in the estimate's basis, not just its number.

One bookkeeping point: S3-r8 says "**ten** hex vectors". The count drifted once already
(five → six between revisions 6 and 7) and I cannot verify it without the enumeration.
**Enumerate the ten by name** in the row, as the tests are enumerated; a count that no one can
check is the same failure mode in miniature.

---

## The slice table

**Disjointness holds.** `cross-supervisor-protocol.ts` stays S3's across both waves (wave 1 and
S3-r8 in wave 3.5 — same owner, so the shared file is never contested);
`secure_fs.rs`'s `cohort::mac` stays S5-MAC-RS's across waves 3 and 3.5; `remote-supervisor.ts`'s
cohort region is S8a's; `bin/compare-controller.ts` and `bin/stage-live-campaign.ts` are S9's.
Edit (f) still splits cleanly across two files with two owners. No file is held by two slices in
the same wave.

**Sequencing is stated and correct**: S3-r8 → S5-MAC-RS-r8 → S8a, which is the same
owner-lands-then-consumer-consumes shape used four times now (S2→S4, S3→S5-RIG, S5-RIG→S5-MAC-RS,
S8b→S8a).

**Codec single ownership holds**, with the one gap NEW-28 names: the rule covers frames, and
revision 9 has just made a non-frame record's canonical encoding load-bearing for a signature.

**Totals: 16,850-22,020 src / 15,400-20,070 test.** The increment over revision 8 is modest and
its composition is credible — the token ruling *removes* the Rust Merkle builder that was the
largest risk in revision 8's estimate, and the additions (budget accounting, edit (g), the ack
shrink) are small and well-bounded. NEW-27 and NEW-28 add little; NEW-25 adds a test, not a
mechanism. I would treat this range as the first one in the chain whose largest line item has
been *removed* by a ruling rather than added by a finding.

---

## Open items

1. **NEW-27** — name the 30th retained string and where the controller obtains it; without it the
   reassembly scheme is unfinished.
2. **NEW-28** — pin a per-cell hex vector for canonical `cohort-observation-evidence/v1` and
   extend §4's vector rule to records whose digest is signed across a language boundary.
3. **NEW-25** — scope "destroys the raw tokens" to the surface property that is actually
   enforceable in a JS heap, name its test, and raise the §12 #3 gap with the maintainer if the
   scoped property is weaker than intended.
4. **NEW-26 (NOTE)** — state that the budget bounds cumulative decoded evidence, not peak memory,
   alongside the `RUNTIME_RESOURCE_EXHAUSTION` code.
5. **Bookkeeping** — enumerate S3-r8's ten vectors by name; add §12 #3's endorsement to §2.9(2e)
   as the strongest argument for the ruling.

---

# Revision 8 review

S5-MAC-RS was right to stop, and revision 8 is right that the finding is the design's rather
than the slice's. I re-read every key set both documents cite. **The slice's blocker is real in
every particular, and §2.9(2a) resolves it correctly** — the (C) discovery is genuine, the (D)
analysis is exact, row 5's push-back is right, and withdrawing §2.9(6) removes a
self-contradiction rather than papering over one.

It is rejected on two blocking findings and four smaller ones. Both blocking findings are the
same species as the one this revision exists to fix — §2.9(2a) enumerates what every mint
**needs**, and never asks what every mint **produces**, or whether the budgets it charges
against exist.

## Verdict drivers

- **NEW-22 BLOCKING** — row 1 now mints the raw registration tokens inside the binary, and
  there is **no carrier** to return them to the controller that must write the FD 5 bundles.
  The "token-bundle side channel" appears once in the document and nowhere in the registry.
- **NEW-20 BLOCKING** — the 20 MiB evidence budget edit (e) charges against is declared once
  and referenced nowhere. Nothing charges anything today.
- **NEW-19 / NEW-21 / NEW-23 / NEW-24 MUST-FIX** — citations mixed across two baselines; the
  budget arithmetic unresolved; (c)'s array kind aimed at the wrong union; the re-entry point
  for the re-running slices unnamed.

---

## Disposition

### (1) The per-row input-source table → **SOUND on substance; citations OPEN (NEW-19)**

Every source I could check is real. Verified at HEAD `2d9eddc7`:

| Claim | Verified |
|---|---|
| `ExecutionKey { campaign_id, run_id, execution_index, transport }` | `secure_fs.rs:10858-10863` ✓ — so (C) for `transport`, `campaignId`, `executionIndex` is real |
| `OpenExecution { key: ExecutionKey, grant_sha256 }` | HEAD `:339-342`, identical in the tree ✓ |
| `AUTHORITY_APPROVAL_FIELDS` — nine digests, exact-checked then discarded | HEAD `:8308-8318`, exactly the nine named ✓ |
| `CampaignAuthorityV1` retains 8 fields, **none** of the nine | HEAD `:8337-8346` ✓ |
| `COHORT_GRANT_FIELDS` = 37 | HEAD `:12252-12291` ✓ |
| `LiveStageReceiptV1.approvedPlanSha256` / `approvalRecordSha256` | `bin/stage-live-campaign.ts:112-113` ✓ exact |
| `mac-present-rig-observation-request/v1` = 16 fields | `cross-supervisor-protocol.ts:2851-2867` ✓ |
| `mac-open-cohort-request/v1` = 7 fields | `:1942-1950` ✓ |

Nothing evidence-shaped is defaulted. Every cell names A, B, C or D with a location. Two
judgements are better than the alternative and worth naming: `cohortAttempt` as *the
supervisor's own counter* — "a controller-supplied value would let a replay present as attempt
1" — and `readinessDeadlineMs` caught as a per-cell constant (plan 1424) that revision 7 had
left silently free.

**NEW-19 (MUST-FIX): the section says "Verified at HEAD `2d9eddc7`" and cites the dirty tree.**
`comparison-supervisor.rs` carries S5-MAC-RS's uncommitted +318 lines, and the citations follow
the tree, not the commit:

| Cited | At HEAD `2d9eddc7` | In the tree |
|---|---|---|
| `OpenExecution` `:348-351`, `.key` `:349`, `grant_sha256` `:350` | **`:339-342`** | `:348-351` |
| `open_next_execution` `:571-599`, sets `:586`, `:596` | **`:534`** | `:571` |
| `accept_artifact_payload` `:607-615` | **`:570`** | `:607` |
| `frameAcceptedAtMs` `:612` | **`:611`** | `:648` |
| `ResidentLoop.campaign_id` `:288`, `candidate` `:289`, `next_execution_index` `:294` | **`:291`, `:292`, `:297`** | same |

The last row of that table is the sharpest: within a single claim, `accept_artifact_payload
(:607-615)` is a **tree** number while `frameAcceptedAtMs (:612)` is approximately a **HEAD**
number. A slice checking out `2d9eddc7` finds `LoopSummary` at `:348` and
`present_artifact_payload` at `:586`.

This is the gate sentence the document adopted at my recommendation — "read or executed that
code at HEAD in the same commit, and cited it by file:line" — failing on the section that
invokes it ("the gate sentence applies to me"). The substance survives; the citations must be
re-taken against `2d9eddc7`, or the section must say plainly that it cites the working tree and
name the wave-3 diff as its baseline.

### (2) The four registry edits → **(d), (f) CLOSED; (c) NOTE; (e) OPEN**

**(f) is correct and is the cheapest of the four.** fd 3 exact-checks nine approval digests and
throws them away; `approvedPlanSha256` / `approvalRecordSha256` are not among the nine, so the
edit genuinely adds two fields rather than merely retaining existing ones — and staging already
computes both, so nothing new is derived. Owners split cleanly across two files (S9 writes,
S5-MAC-RS parses), so it costs no shared-file coordination.

**The refusal to map `parentPlanSha256` → `approvedPlanSha256` is correct, and for the right
reason.** They are different digests over different bytes; the offline verifier recomputes
`approvedPlanSha256` independently, so a mapping would not fail at mint time — it would fail
*after a campaign*, which is the expensive place. That is the same "equivalent re-derivation"
this program refuses in §2.5 and §1.3, applied consistently.

**(d) is sound.** It lands in `PHASE_A_MAC_FIELDS` where `base64` already exists, the 1 MiB cap
is justified with a stated worst case (~10 KB at chat-10k, bounded because
`perSubscriberDelivered` lives in the worker partials), and it carries records rather than
digests.

**The "records, not digests" rule is honoured in all three of (c), (d), (e)**, and row 8's
supporting argument is the right one: every byte string in the bundle is digest-bound to
something already retained — partials to `orderedPartialManifest`, the manifest to row 7's
admission receipt, the warmup completes to row 4's manifest — so a controller substituting a
partial fails a digest it does not control. Frame-carriage does not make them controller-authored.

**(c) — NEW-23 (NOTE): the new array kind is aimed at the wrong union.** Verified: no array
kind exists (`base64Array` / `Base64[]` → 0 hits). The design assigns S3 "an `intOrNull`-style
array kind" without naming the table. But (c) edits
`mac-export-warmup-completion-manifest-request/v1`, which lives in `COHORT_REMOTE_FIELDS`, keyed
by `CohortRemoteFieldKind` (`:1899-1905`) — still exactly six kinds, no nullable, no array —
**not** the shared `PhaseARemoteFieldSpec` that S3's NEW-2b work widened. S3 now maintains two
field-kind vocabularies, and this design has been bitten twice already by "which table does this
go in" (N2, NEW-2b). Name the union.

**(e) — NEW-21 (MUST-FIX): the budget arithmetic is unresolved, and the edit doubles the
largest frame in the execution.** Plan 529 gives 14 MiB encoded / 9 MiB decoded to
`MacCohortEvidenceExportedAckV1` — the **ack**. Edit (e) gives the **request** "the same pair".
One execution can then carry 28 MiB encoded / 18 MiB decoded on this pair alone. Against a
20 MiB per-execution budget: **decoded fits** (18, with 2 MiB spare); **encoded overflows**
(28). Plan 529 does not say which figure is charged, and neither does the design — both just
repeat "charged against the 20 MiB per-execution evidence budget before allocation".

The answer decides whether (e) is legal. If it is decoded, the design must state that this one
pair consumes 90% of the per-execution budget and say what else charges against the remaining
2 MiB. If it is encoded, (e) needs a smaller cap or a different carriage.

### (3) The §2.9(6) withdrawal → **CLOSED, and the check is testable now**

The binary's Phase-A path does supply rows 1 and 7. At HEAD `:607-612`, `accept_artifact_payload`
builds the receipt from `execution: open.key`, `grant_sha256: open.grant_sha256`,
`payload_sha256`, `series`, and `frame_accepted_at_ms` — which covers `campaignId`, `runId`,
`executionIndex`, `transport`, `measurementGrantSha256`, `admittedClientSeriesSha256`,
`sampleUnit`, `sampleCount`, `delivered`, `firstSampleAtMs`, `lastSampleAtMs`, `spanMs` and
`frameAcceptedAtMs`. **Twelve of twelve, none needing a frame.** The claim holds.

Withdrawing §2.9(6) also removes a real self-contradiction rather than a stylistic one: §2.9(6)
said row 7's mint "needs the Phase-A Mac codec built first" while §2.9(2) row 7 assigned that
mint to this binary. S5-MAC-RS found the design arguing with itself, and the withdrawal is the
right resolution — the alternative (deferring row 7) would have left mandate assertion 3's Mac
half unreachable for a second program.

`no_mac_receipt_is_signed_outside_the_binary` is testable now and is the right shape: a
module-surface assertion, like `the_controller_process_holds_no_mac_cohort_private_key`, not a
runtime observation. Residual 1 — the top residual for five revisions — closes.

### (4) Row 5's barrier timings → **CLOSED, and the push-back is correct**

The slice said the timings arrive on no frame; the design agrees and answers that they *should
not*, "which is precisely why the Mac signs the barrier". That is right.
`mintedAtMacNs`, `barrierNonce`, `macClockId` and the `measureStart/StopAtMacNs` schedule are
the signer's own observations and decisions — a barrier whose timings were supplied by the
controller would be a controller decision with a Mac signature on it.
`warmupStartedAtMacNs` / `warmupCompletedAtMacNs` retained from rows 3-4 is legitimate under the
retention discipline the five-of-seven invariant already established, and the four rig digests
come from the barrier request's own frozen key set (`:2002-2009`, verified in round 4). No
registry edit, and row 5 was blocked only transitively. Correct.

### (5) The slice-table delta → **disjoint; sequencing OPEN (NEW-24)**

Ownership holds. S3 remains sole owner of `cross-supervisor-protocol.ts` and takes all three
§3.3 edits plus ten vectors; S5-MAC-RS owns `cohort::mac`, the mac arms and now the
`AUTHORITY_APPROVAL_FIELDS` half of (f); S8a owns the `remote-supervisor.ts` cohort region and
the three new senders plus the bundle builder; S9 owns `compare-controller.ts` and
`bin/stage-live-campaign.ts` and the other half of (f). Edit (f) splits across two files with
two owners — no shared file, so the pattern is the same one used for S2→S4 and S3→S5-RIG.

**NEW-24 (MUST-FIX): the re-entry point is not named.** Three of the four edits are S3's, and
**S3's work is already committed in `2d9eddc7`** — so S3 must re-run before S5-MAC-RS's mint
half, which must re-run before S8a's senders can consume the acks. The totals paragraph
acknowledges this ("S3's three §3.3 edits and four extra vectors") but §4 never says which wave
the re-runs belong to. **"wave 3.5" appears nowhere in the document** — a grep for it matches
only `§3.5`. Name the re-entry wave and its order (S3 → S5-MAC-RS mint → S8a), and say
explicitly that S5-MAC-RS's *verification* half is already in the tree and must not be re-done.

I also read the S5-MAC-RS note's items 3-6 and they are all sound; item 5 in particular
(`receiptSequence` monotonicity is per record kind, found by execution when the honest order
refused) is the kind of finding that only implementation produces, and item 6
(`WS_WT_COHORT_RECEIPT_VALIDITY_MS` required rather than defaulted, currently set only on the
rig's child) is correctly routed to S9/S8b.

---

## New findings

### NEW-22 — BLOCKING — the tokens row 1 now mints have no carrier back to the controller

§2.9(2a) row 1 makes the binary the token minter: `tokenCommitmentLeafManifestSha256`,
`roleTokenCommitmentRootSha256` and `roleTokenCommitmentCount` are "products of the binary's own
token minting (§2.4: 32 random bytes per role, §4.1 leaf order, Merkle root)". §2.2(b) says the
raw tokens come back to the controller "once, in `mac-cohort-opened-ack/v1`'s **token-bundle
side channel** (§2.9 step 1)".

That phrase occurs **exactly once in the whole document** (grep count: 1). It is never defined,
never given a key set, never given a cap, and never assigned an owner. And the frame it names
cannot carry them:

```
"mac-cohort-opened-ack/v1": { responseSeq, ackRequestSeq, executionSha256,
                              cohortGrantBase64, cohortGrantSha256, cohortGrantSignatureBase64 }
```

Six fields, no token field. Meanwhile §4.3 requires the raw tokens to reach role children on
FD 5, and the FD 5 bundles are written by `createMacFanoutRoleChildHost`
(`remote-supervisor.ts:6156`) — **in the controller process**, which does not spawn from the
binary. So the tokens must cross from `_wtcompare` to the controller, and no frame carries them.

This is revision 8's own finding turned around: §2.9(2a) enumerates every mint's **inputs** and
never asks whether every mint's **outputs** have a carrier. Row 1 is the row where that gap
bites, and it bites hardest, because the output in question is the one secret in this system
that §4.3 exists to protect.

**And it is not merely a missing field.** Plan 1768-1770 is the destroyed-secret scheme: raw
tokens are written to an unlinked 0600 file, loaded once, and destroyed. Moving the mint into
the binary means raw secrets must now travel **from `_wtcompare` to the controller** — a secret
crossing the uid boundary in the **reverse** direction, which §2.9(4a)'s sixteen-row table never
contemplated. Row 5 of that table states the principle exactly: the signing key "is the one
object that must *not* be widened". Raw registration tokens are a secret of the same class, and
the design now needs a route for them that the boundary analysis has never covered.

**Exact change:** decide and state where token minting lives. Either (i) it stays in the
controller — which costs §2.4's "the Mac supervisor mints tokens with 32 random bytes" (plan
1221) and must be recorded as a plan deviation, with the grant's three commitment fields then
arriving as (A) inputs on `mac-open-cohort-request/v1` under a fourth registry edit; or (ii) it
moves into the binary and the design adds a registry edit carrying the bundle back, **plus a
seventeenth row** to §2.9(4a) covering a secret crossing outward, with the same care row 5 gets.
(i) is much cheaper and (ii) is more faithful to plan 1221; the design should price both, as it
did for option (a)/(b) in §4.

### NEW-20 — BLOCKING — the evidence budget edit (e) charges against does not exist

Edit (e) and row 8 both say the 14 MiB bundle is "charged against the 20 MiB per-execution
evidence budget **before allocation**". Grepping every reference to that budget across the TS
and Rust trees returns **exactly one line**:

```
tools/compare/cross-supervisor-protocol.ts:1761:
export const COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES = 20 * 1024 * 1024;
```

Its own declaration. No consumer, no accounting, no charge site, in either language. Nothing
charges anything against it today, so (e) assigns work to a mechanism that does not exist and no
slice owns building.

This is the **placeholder-evidence family** the project already has a standing note about — a
constant that reads as an enforced bound, with a plausible name and no producer. It is the third
member found in this codebase, and it is being cited as if it were live machinery, which is
precisely the failure mode the gate sentence targets.

**Exact change:** name the slice that builds the budget accounting (S3 owns the constant's file;
S5-MAC-RS owns the Rust side that must charge before allocation), state where the charge is
taken on each side, and add a test that a second oversized export refuses on the budget rather
than on the per-frame cap — because the per-frame cap alone would let two 9 MiB frames through
and the budget is the only thing that says no.

---

## (6) What a slice implementing against the provisional table will most likely find missing

The Architect flags the table as provisional and asks the question directly. Beyond NEW-22,
which I would expect to be found in the first hour, my answer is **row 1's "A, derived" cells**:

> `publishers`, `subscriberShards`, `expectedOfferedIngress`, `expectedExpandedDeliveries`,
> `expectedProcessCount`, `expectedSessionCount` — "recomputed from `workloadRolePlanInputBase64`
> on the same frame plus §4.1's fixed rules".

That sentence requires a Rust implementation of §4.1's **constructive** half — leaf ordering,
Merkle root, proof construction, publisher grants, shard construction. Today Rust has
`parse_shards`, a *verifier* (`secure_fs.rs:12531-12574`), and the only builder in the repo is
`buildFanoutCohortFixture` (`scenarios/fanout-relay.ts:1879-2010`), in TypeScript. §2.4 is
explicit that a second copy of that builder "would be the exact defect this plan spends §4.1
preventing" — and §2.9(2a) has just required one, in another language, without saying so.

So the most likely finding is: **row 1's derived cells are a second implementation of §4.1's
constructive half, and the single-owner rule needs an answer for it.** A per-frame hex vector is
not sufficient here; it needs a **per-cell** conformance vector — the Rust builder and the TS
builder must produce byte-identical grants for every cell in `COHORT_CELL_CARDINALITIES`, not
just for the one pinned frame — because the shard construction differs per cell and a vector at
ticker-10k would not exercise chat-1k's ten publishers. That is also the largest single risk to
the +1,200-1,600 estimate for S5-MAC-RS's mint half.

Second most likely, and related: `cohortId` and the three token-commitment products depend on
that same builder, so NEW-22 and this finding are the same seam viewed from two sides.

---

## Open items

1. **NEW-22** — decide where token minting lives; if it stays in the binary, add the carrier
   **and** a seventeenth crossing row for a secret moving outward.
2. **NEW-20** — name the slice that builds the 20 MiB budget accounting and where it charges;
   test that the budget, not the per-frame cap, is what refuses.
3. **NEW-21** — state whether the budget charges encoded or decoded; if decoded, say that (e)
   plus its ack consumes 18 of 20 MiB and what else charges.
4. **NEW-19** — re-take §2.9(2a)'s citations against `2d9eddc7`, or declare the working tree as
   the baseline and name the wave-3 diff.
5. **NEW-24** — name the re-entry wave and order (S3 → S5-MAC-RS mint → S8a), and record that
   S5-MAC-RS's verification half is already in the tree.
6. **NEW-23** — name the union (c)'s array kind joins: `CohortRemoteFieldKind`, not the shared
   `PhaseARemoteFieldSpec`.

---

# Revision 7 review

**APPROVED.** All four items are closed. I found two things worth recording and **neither is a
condition** — the design is implementable exactly as written, and a slice following it would
produce correct code whether or not they are fixed. I am stating them as notes, not as a
conditional approval.

Revision 7 is the first version of this document where every claim I checked was true at HEAD
and every mechanism I traced worked for the reason given. That has not been true of any prior
revision.

## Per-item disposition

### NEW-14 — the half-close → **CLOSED**

§2.9(4d) now names the single line stage 1 wants and explicitly excludes the other three, with
the four-line excerpt of `closeOwnedFds` (`remote-supervisor.ts:1115-1128`) annotated
line-by-line. The ordering is right — stage 1, stage 2's reap, **then** `closeOwnedFds()` —
and the reasoning for why the defect would have survived review is the sharpest paragraph in
the document: because Rust ignores `SIGPIPE` the writes return `EPIPE` rather than killing the
process, *so the supervisor still exits and stage 2's proof still holds*, and only the content
of the final frame distinguishes a graceful stop from a severed one. That is exactly why the
test had to change, and it did: `closing_the_control_channel_stops_the_supervisor_without_a_signal`
now asserts the final frame was **received and content-checked**. A test that asserted only
termination would have passed on the broken-pipe path.

The `proc.kill("SIGKILL")` deletion is justified on its own terms rather than as tidying — in
sudo's fork mode it kills the waiter without reaping, orphaning the supervisor and falsifying
`reaped: true` in precisely the case the verdict exists to detect. Correct.

One enumeration is short by one — NEW-17, below, which changes nothing.

### NEW-11 residue — the probe's reading → **CLOSED, and better than what I asked for**

I asked for the exit-status reading and the Darwin rationale to be carried across. §2.9(4e)
does both and then does the thing that actually matters: it explains **why the premise
transfers**. The original helper's correctness rests on its closing sentence — "every PGID this
control is ever addressed at was created by the host beside it, so `EPERM` cannot mean 'a
stranger's group' here" — and (4e) shows that running the probe *as `_wtcompare` against a group
`_wtcompare` owns* makes that sentence true again, so `EPERM` recovers its single meaning. The
reading is therefore inherited legitimately rather than copied, which is the difference between
a rule and a cargo cult, and the document says so in as many words.

`the_liveness_probe_reads_eperm_as_gone` is table-driven over all three outcomes (zero → alive,
`ESRCH` → gone, `EPERM` → gone) and the mutation proof is the right one: flipping the `EPERM`
arm makes the reap test **hang to its deadline** rather than fail cleanly, which is the
observable the original comment predicted.

### NEW-15 — the SIGPIPE row → **CLOSED, and I verified the Rust claim by execution**

The row is rewritten correctly: SIGPIPE is a write-side signal, the `Ok(None)` break at
`comparison-supervisor.rs:604-606` is a read-side event and is disposition-independent, and
`SIG_IGN` protects the supervisor's *outbound* writes — the hazard the half-close now avoids.

I did not take the `lang_start` claim on trust. Compiled and ran a probe that writes to a
closed pipe:

```
$ rustc -O -o sigpipe_probe sigpipe_probe.rs
$ ( ./sigpipe_probe 2>err.txt | head -c 1 >/dev/null ); echo "exit=$?"; cat err.txt
exit=0
KIND=BrokenPipe
```

The process survived and reported `ErrorKind::BrokenPipe` rather than dying by signal, which is
`SIG_IGN` installed before `main`. So sudo resetting dispositions before `exec` is harmless, as
stated. Claim confirmed by execution, not by assertion.

### NEW-16 — the rename → **CLOSED**

`the_mac_supervisor_group_is_disjoint_from_the_controllers`, with the rationale recorded: the
assertion was always correct, `handle.pid` is sudo's, and `-<pgid>` covers the supervisor in
both sudo modes because `detached: true` makes sudo the group leader and a forked supervisor
inherits that group. Recording *why the old name was wrong while the assertion was right* is
the part that prevents the "fix" I was worried about.

### The S8 split → **CLEAN, verified by execution**

I checked the seam rather than reading the claim. Grepping S8b's region (`:466`-`:1160`) for
every S8a symbol (`MacFanoutSupervisor`, `CohortRigChannel`, `MacCohortChannel`,
`createMacFanout*`, `createMacProductionCohortMinter`, `processGroupAlive`) returns **nothing**.
Grepping S8a's region (`:2714`+) for every S8b symbol (`spawnMacSupervisor`,
`spawnRigSupervisor`, `stopSupervisor`, `wrapNodeChild`, `buildRigSupervisorWrapperScript`,
`SupervisorHandle`) returns exactly one hit — `remote-supervisor.ts:6144`, which is a **doc
comment** ("`Bun.spawn` for the same reason `spawnMacSupervisor` uses it"), not a call. So
"nothing in either region calls into the other" is true.

`processGroupAlive` (`:5742`) sits in S8a's region and S8b writes its own uid-correct probe in
its own region rather than editing it — so the "one deliberate non-edit crossing" is accurately
described, and the seam holds without either slice reaching across. S8b in wave 3, S8a in wave
4, matching the S2→S4 and S5-RIG→S5-MAC-RS pattern already used twice. S8b landing first is
also the right order, since S9 and S10 depend on the spawn form rather than on the channels.

---

## New findings — both NOTE, neither a condition

### NEW-17 — NOTE — the terminate-site enumeration is short by one

§2.9(4d) says "**every** failure arm in the serve loop calls `self.terminate(writer, code)`
(`comparison-supervisor.rs:607`, `:617`, `:621`, `:639`)". There are **five**:

```
607: Err(code) => return self.terminate(writer, code),
610: return self.terminate(writer, "FRAME_SESSION_LIMIT");
617: Err(_) => return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID"),
621: Err(_) => return self.terminate(writer, "TRUST_RECORD_MALFORMED"),
639: Err(code) => return self.terminate(writer, code),
```

`:610`, the frame-budget arm, is missing — so the protected set is eight sites, not seven.
**This has no implementation consequence**: the Rust file belongs to S5-RIG and S5-MAC-RS, not
to S8b, and the list is context for *why* the half-close is needed rather than a work list.
I raise it only because this document's authority rests on its enumerations and because the word
"every" is doing load-bearing work in that sentence.

### NEW-18 — NOTE — the `processGroupAlive` trap is recorded where it will be archived, not where it will be read

§2.9(4e) records that reusing the helper across the uid boundary is "the obvious move and it is
wrong". That is the right thing to record, but it is recorded in a deviation document that gets
archived, while the next person to reach for the helper will be reading
`remote-supervisor.ts:5729-5741`. The helper's own comment currently ends with the premise that
makes it correct — which is exactly the sentence a reader will take as permission.

A one-line addition to that doc comment — that the probe is uid-bound and must not be reused
across a uid boundary, with a pointer to the Mac supervisor's own probe — would put the warning
where it is needed. `processGroupAlive` is in **S8a's** region, so S8a can make it without
touching S8b's. Worth doing; not required for correctness.

---

## Final passes

**The sixteen-row table** is unchanged and I found no seventeenth object. I re-checked the two
candidates I rejected last round (supplementary groups, sudoers `secure_path`/`env_keep`) and
both remain covered — the first by row 3 plus preflight checks 9-10 asserting the effect, the
second by rows 10 and 14 eliminating the dependency rather than relying on it. NEW-17 is an
enumeration inside row 12's rationale, not a new object.

**The slice table** — 14,800-19,300 src / 13,000-17,000 test, stated as a range rather than a
floor, which I agree is now the right framing. Disjointness holds in every wave. The three
shared-file sequences are consistent with each other and each uses the same shape — one owner
edits, a later wave consumes: S2→S4 on `fanout-supervisor-integration.test.ts`,
S5-RIG→S5-MAC-RS on `secure_fs.rs` and `comparison-supervisor.rs`, S8b→S8a on
`remote-supervisor.ts`. `cohort-protocol.ts` is S2-only, `server-observation-artifact.ts`
S5-RIG-only, `cross-supervisor-protocol.ts` S3-only with both registry edits and six vectors,
`bin/stage-live-campaign.ts` S9-only. Every cross-language codec has exactly one owner and one
hex vector, and gate item 9 makes the property checkable rather than asserted.

---

## The one sentence the implementation gate must enforce

Asked for the single most load-bearing gate sentence, I would not choose any of the eight
currently listed. The evidence from seven rounds is unambiguous: **every blocking finding in
this chain — the Mac channel that did not exist, the "no legal reduced rung" that misread a
six-row table, the "no TS codec anywhere" for a record that had one, the "already registered on
the TS side" that read a name list as machinery, the field kinds that were not in the union, the
script `sudo` could not read, the env var `sudo` strips, the pgid that was the controller's own,
the helper that inverts across a uid boundary — was a claim about code the author did not own
and had not run.** Not one was a design error in the ordinary sense.

So:

> **No slice may rely on a property of code it does not own — that a frame exists, that a field
> is registered, that a helper is reusable, that a mode permits access — without having read or
> executed that code at HEAD in the same commit, and cited it by file:line.**

Gate item 6 says "every claim established by execution", which is close but is read as applying
to the slice's *own* work. The failures were all about the *neighbourhood*. Making that explicit
is worth more than any other single line in the gate, and it is cheap: it costs a grep and a
citation per assumption.

---

# Revision 6 review

All five items are closed. **This is the first revision with no blocking finding and no new
crossing object** — the sixteen-row table plus its five reasoned dismissals is closed over its
stated domain, which was the bar I set in revision 5 for dropping the floor framing.

The strongest thing in revision 6 is not a fix I asked for. §2.9(4e) reports that
`processGroupAlive` (`remote-supervisor.ts:5742`) cannot be reused across the uid boundary,
and it is right — I verified it and it is a subtle, genuinely dangerous defect that would have
produced the exact false `reaped: true` the whole section exists to eliminate. The Architect
found it while implementing my finding, which is the first time in six rounds that the design
has caught a boundary defect before the review did.

It is still rejected, on one ordering defect and three clarifications. None is structural.

## Verdict drivers

- **NEW-14 MUST-FIX** — stage 1 calls `closeOwnedFds()`, which tears down the supervisor's
  *output* channel at the same instant as its input, so the supervisor's final frames go to a
  broken pipe.
- **NEW-11 residue** — the replacement liveness probe is specified as a command but not as an
  exit-status reading, and the Darwin-zombie rationale that made the original helper correct
  does not carry across.
- **NEW-15 / NEW-16 NOTES** — the SIGPIPE dismissal has the direction backwards; one test name
  asserts something false about sudo's process group.

---

## Disposition of the five items

### NEW-11 — §2.9(4d)/(4e), the process group → **CLOSED**, with one residue

The precedent is verified and the ↺ is right — it is stronger than the one I cited.
`remote-supervisor.ts:6152-6154`, in the same file:

> "`detached: true` is `setsid(2)`: the child's PGID equals its PID and no role child shares a
> group with another, which is what makes `killPgid` able to take down a child and anything it
> forked without touching its siblings."

with `detached: true` at `:6178`, and `createMacFanoutProcessControl` (`:5757`) already
supplying the `killPgid`/`waitPgid` pair. Reusing an established in-file pattern rather than
inventing one is the right move, and it makes the Mac supervisor consistent with both the role
children and the rig's server child.

The three-part change is correct and correctly ordered: `detached: true` for `setsid`, `pgid`
carried on `SupervisorHandle` so stage 3 and the S9 test name the *same* number rather than
each deriving one, and — the part that matters most — **the spawn-time
`handle.pgid !== process.pgid` assertion as the regression guard**. The design's own sentence
is the right framing: "the assertion is the regression guard, not the spawn option." A future
edit dropping `detached` re-arms a campaign-wide self-kill silently, and only the assertion
catches it. `dropping_detached_is_refused_at_spawn` is the mutation proof.

**The `processGroupAlive` finding is real. I verified it and it is a good catch.**
`remote-supervisor.ts:5742-5750` probes with `process.kill(-pgid, 0)` **from the controller**
and returns `code !== "ESRCH" && code !== "EPERM"` — i.e. it reads `EPERM` as **dead**. The
comment at `:5729-5740` records why that is correct for role children, measured rather than
assumed: on Darwin an all-zombie group answers `EPERM` to `kill(-pgid, 0)`, and reading it as
"alive" would make `waitPgid` unbounded because the synchronous poll prevents the `SIGCHLD`
handler from reaping. And it closes with the premise that breaks: *"Every PGID this control is
ever addressed at was created by the host beside it, so `EPERM` cannot mean 'a stranger's group'
here."* A `_wtcompare`-owned group is exactly a stranger's group — the controller gets `EPERM`
from a uid mismatch while the supervisor is running, and the helper reports it reaped. The
replacement — probe **as the target uid**, `sudo -n -u _wtcompare /bin/kill -0 -- -<pgid>` — is
the right shape, and recording it because "reusing the existing helper is the obvious move and
it is wrong" is exactly the kind of trap that should be written down.

**The residue: the probe is specified as a command, not as a reading.** §2.9(4e) gives the
invocation and stops. Run as `_wtcompare` against a `_wtcompare` group, an all-zombie group
still answers `EPERM` on Darwin — the same measured behaviour `:5729-5740` records — so the new
probe has the same three-way exit status and needs the same interpretation rule, for the same
reason. An implementer reading only the command will plausibly write `EPERM = alive`, which
reintroduces precisely the unbounded wait the original comment warns about; and one reading
`code !== "ESRCH"` off the old helper will get it right by accident without knowing why.
**Change:** state the reading — non-zero exit means the group is gone, `EPERM` included,
because as the target uid it cannot be a stranger's group — and carry the Darwin-zombie
rationale into §2.9(4e) rather than leaving it in a comment on a helper this path no longer
uses.

### NEW-12 — preflight check 12 → **CLOSED**

Check 12 is now `sudo -n -u _wtcompare test -x /bin/kill` (`:1104`), which passes on a correct
host and proves the only part check 1 did not already establish. The governing rule it violated
is now stated —

> "Every preflight check must pass on a correctly configured host, and fail only for the defect
> it names."

— which is the right generalisation and is worth more than the fix. The two stronger
alternatives are recorded rather than silently dropped, with a reason for not taking them
(`the_mac_supervisor_is_its_own_process_group_leader` already proves the group-signalling case
at the moment it matters). And the honesty about verification is right: neither of us can run
this here, so **S0 runs all twelve checks on the real host and reports each exit status**, with
S9 adopting the self-targeting form if `test -x` turns out not to predict stage 3. That is
settling a semantics claim by execution rather than by argument, which is what my own gotcha
list demands.

### NEW-13 — the sixteen-row table → **CLOSED**

All four objects added with correct mechanisms:

- **Row 12, fds 0/1/2** — the resolution is better than "add a row". Calling the control channel
  the boundary's *interface* rather than a leak is right: stage 1's graceful stop **is** closing
  fd 0, so this object crossing is load-bearing, not tolerated. Residual 2c is reworded
  accurately at `:1820` — "No descriptor *the design opens* crosses `sudo`; the three standard
  streams do, by construction."
- **Row 13, umask** — correctly identified as sudoers-applied rather than inherited, with an
  explicit `umask 007` line and a post-spawn assertion on a file the supervisor actually
  created. The assertion is the part that matters; the line alone would be unverified.
- **Row 14, PATH** — `/bin/cat`, with the right reason: absolute paths mean the script depends
  on no environment at all, which is consistent with §2.9(4c)'s rejection of host-sudoers
  dependencies rather than a separate style choice.
- **Row 15, cwd** — `cd /` as the first line.

The assembled script is coherent and I can trace every line to its row. The five dismissals are
each reasoned rather than waved away, and two of them are genuinely informative: the resource-limit
row correctly places the 1,010-socket load on the *server child*, on the other side of this
boundary; and the `TMPDIR` row correctly notes it is a property form (iv) bought rather than one
that had to be arranged. One dismissal's reasoning is wrong — NEW-15.

### NEW-7 residue → **CLOSED**

`proc.kill("SIGKILL")` at `:1145` is stated as deleted, not retained as a fourth stage, with
`no_sigkill_is_ever_sent_to_the_sudo_pid` as the guard. That closes the orphaning path that
would have falsified the `reaped` verdict in sudo's fork mode.

### NEW-10 residue → **CLOSED**

The vector count is consistent at six.

---

## New findings

### NEW-14 — MUST-FIX — stage 1 closes the supervisor's output channel at the same instant as its input

§2.9(4d) stage 1 is specified as "`closeOwnedFds()` **first**, not last:
`handle.controllerToSupervisor?.end()` closes the supervisor's fd 0". The named function does
four things (`remote-supervisor.ts:1116-1127`):

```ts
for (const fd of handle.bootstrapFds) safeClose(fd);
for (const fd of handle.controlParentFds) safeClose(fd);
handle.controllerToSupervisor?.end();       // ← the only one stage 1 wants
handle.supervisorToController?.destroy();   // ← tears down the supervisor's output
```

Only the third line is stage 1. The fourth destroys the controller's **read** end of the
supervisor→controller pipe, and the second closes the parent's copies of the control fds — at
the same moment the supervisor is being told to wind down.

The supervisor writes on its way out. Every failure arm in the serve loop calls
`self.terminate(writer, code)` and the loop body has several `m::write_frame(writer, …)` sites
(`comparison-supervisor.rs:604-660`). With the read end destroyed, those writes hit a broken
pipe: with Rust's `SIG_IGN` they return `EPIPE` rather than killing the process, so the
supervisor still exits and **stage 2's proof still holds** — but it exits on a write error
instead of through its teardown path, and the controller discards whatever the supervisor said
last. A "graceful stop" that cuts off the other side's reply is not graceful, and the
distinction is exactly the one §2.9(4d) was written to make.

**Exact change:** stage 1 closes **only** `handle.controllerToSupervisor`. `closeOwnedFds()`
moves to after stage 2 observes sudo's exit, where releasing the bootstrap fds and the parent's
control copies is correct. Add an assertion to
`closing_the_control_channel_stops_the_supervisor_without_a_signal` that the supervisor's final
frame was **received**, not merely that the process ended — otherwise the test passes on the
broken-pipe path and the defect survives its own guard.

### NEW-15 — NOTE — the SIGPIPE dismissal has the direction backwards (right conclusion, wrong mechanism)

The dismissal row reads: "Rust's std sets `SIGPIPE` to `SIG_IGN` at startup — **which is exactly
why stage 1 works**: closing fd 0 surfaces as the `Ok(None)` EOF break at
`comparison-supervisor.rs:604-606` rather than killing the process by signal."

SIGPIPE is raised on **write** to a pipe with no reader. The `Ok(None)` break is a **read**-side
event: reading a pipe whose write end is closed returns zero bytes, never SIGPIPE, whatever the
disposition. So stage 1's break does not depend on `SIG_IGN` at all — it would work with
`SIG_DFL`.

What `SIG_IGN` actually protects is the supervisor's *outbound* writes once the controller's read
end goes away — which is the hazard NEW-14 names. So the row is describing the right protection
against the wrong event. The conclusion (benign) is correct, and correct for a second reason the
row does not give: Rust's std installs the `SIG_IGN` disposition in `lang_start` before user
code, so sudo resetting handlers to default before `exec` is harmless.

**Change:** rewrite the row to say that the EOF break is disposition-independent, and that
`SIG_IGN` is what keeps the supervisor alive long enough to finish its teardown writes once
NEW-14's ordering fix keeps the output channel open.

### NEW-16 — NOTE — one test name asserts something false about sudo's process group

`the_mac_supervisor_is_its_own_process_group_leader` asserts
`handle.pgid === handle.pid && handle.pgid !== process.pgid`. The assertion is correct and the
`-<pgid>` addressing is sound in both sudo modes — with `detached: true`, `sudo` becomes the
session and group leader, and a forked supervisor inherits that group, so the signal reaches it
either way. But `handle.pid` is **sudo's** pid, so in fork mode the Mac supervisor is a group
*member*, not the leader, and the name says otherwise. That matters only because a later reader
who trusts the name may "fix" the assertion toward it and break a correct test.

**Change:** rename to `the_mac_supervisor_group_is_disjoint_from_the_controllers`, or keep the
name and add one line noting that the leader is `sudo` and that this is why `-<pgid>` covers the
supervisor in both exec and fork modes.

---

## Completeness pass over the sixteen rows

Against the stated domain — "everything the child needs and everything that acts on it" — I
walked the set again looking for a seventeenth. **I did not find one.** The five dismissals
cover the remaining POSIX-level inheritance surface (tty, rlimits, signal dispositions, locale,
temp directory); the rows cover the filesystem objects both directions, the environment, the
process group, the control channel, umask, PATH and cwd. Two candidates I checked and rejected
as already covered rather than missing: **supplementary groups** (implied by row 3's `staff`
membership and asserted by preflight checks 9-10, which test the *effect*), and **the sudoers
`secure_path`/`env_keep` policy itself** (row 14 and §2.9(4c) both eliminate the dependency
rather than rely on it — which is the stronger disposition).

NEW-14 is not a seventeenth object. It is an ordering error *within* row 12, which the table
already names. That distinction is why I regard the enumeration as closed and the floor framing
as no longer necessary.

## The slice table

**Disjointness, sequencing and codec ownership: unchanged from revision 5 and still hold.**
S3 (wave 1) owns `cross-supervisor-protocol.ts` with both registry edits and six vectors,
consumed by S5-RIG (wave 2) without touching the file. `secure_fs.rs` splits across waves 1/2/3
by disjoint region; `comparison-supervisor.rs` across 2/3 by disjoint arms; `cohort-protocol.ts`
S2-only; `server-observation-artifact.ts` S5-RIG-only; `bin/stage-live-campaign.ts` S9-only.
Every cross-language codec has one owner and one vector. Gate item 9 makes it checkable.

**S8 is now the busiest slice** at 2,550-3,300 / 1,700-2,150 with twelve named tests, carrying
the spawn form, rows 10 and 13-15, both shutdown sections, and the `MacCohortChannel`. It is
still one file plus its test, so ownership is clean, but it is worth flagging that S8 has
absorbed something from every revision since 3 and is the slice most likely to need splitting
when it is actually written.

**Totals: 14,750-19,200 src / 12,950-16,900 test.** NEW-14/15/16 add perhaps +30-60 src. This is
the second consecutive shrinking increment and the first revision that added **no new object to
the table** — the condition I named in revision 5 for retiring the floor framing. I would now
call the range a range.

---

## Open items

1. **NEW-14** — stage 1 closes only `controllerToSupervisor`; `closeOwnedFds()` moves after
   stage 2; the stage-1 test asserts the final frame was received, not just that the process
   ended.
2. **NEW-11 residue** — state the new probe's exit-status reading (non-zero, `EPERM` included,
   means gone) and carry the Darwin-zombie rationale into §2.9(4e).
3. **NEW-15** — rewrite the SIGPIPE dismissal: the EOF break is disposition-independent;
   `SIG_IGN` protects the outbound writes.
4. **NEW-16** — rename `the_mac_supervisor_is_its_own_process_group_leader`, or note that the
   group leader is `sudo`.

---

# Revision 5 review

Revision 5 closes four of five items cleanly and gets the fifth's mechanism right in two
stages of three. The two enumerations it ran are correct and I re-ran both: there really is
exactly **one** environment read in the supervisor binary, and the rig registry edit really is
needed where the Mac's was not. §2.9(4b)'s new sentence — that checks 4-9 assert the *effect*
of the mode change rather than trusting the line list, so an incomplete S9 edit refuses before
traffic — is the best governance sentence in the document, because it converts the review's
recurring finding into a mechanism that catches the next one.

It is still rejected, and the reason is narrow and specific: **§2.9(4d)'s stage 3 depends on a
process group the design never establishes and the controller does not have**, and preflight
check 12 tests something the kernel will deny on a correctly configured host. The twelve-object
table is also still one object short of its own stated domain, and it is the most important
one — the control channel.

## Verdict drivers

- **NEW-11 BLOCKING** — stage 3's `<pgid>` is undefined; without `detached`, the only pgid the
  controller knows is its own, so the forced stop would signal the controller, the rig
  supervisor and every role child, and S9's reap test can never pass.
- **NEW-12 MUST-FIX** — preflight check 12 (`sudo … /bin/kill -0 $$`) targets a
  controller-owned pid from `_wtcompare`; `kill(2)` denies it, so the check fails on a
  correctly configured host.
- **NEW-13 MUST-FIX** — four objects still outside the twelve: the control-channel fds
  0/1/2 (which contradict residual 2c's wording), umask (required with no mechanism), PATH,
  and cwd.

---

## Disposition of the five items

### NEW-6 — §2.9(4c), the environment → **CLOSED**

The enumeration is exact and I re-ran both greps.

**Every `std::env` in the supervisor binary** is two occurrences, and only one is an
environment *read*: `std::env::args()` at `comparison-supervisor.rs:1772` is argv, and
`std::env::var_os("COMPARISON_SUPERVISOR_BUN_PATH")` at `:1877` is the one read. In
`secure_fs.rs` the three hits (`:3666`, `:9284`, `:9289`) are `std::env::consts::ARCH`/`OS` —
compile-time constants, not reads at all. And the `:3688` claim is exactly right:

```rust
fn addon_requested_specifier(env: &[(String, String)]) -> String {
    env.iter().find(|(key, _)| key == "WT_COMPARISON_STRICT_ADDON_FD")
```

(`secure_fs.rs:3685-3690`) — a **supplied** list, a child's allowlisted environment, not this
process's own. It does not cross. The seven controller-side `COMPARISON_*` are correctly
classified as controller-read.

The mechanism is right. One `export NAME=<shellQuote(path)>` line inside the argv script is
consistent with form (iv)'s own analysis — the value is a path to the Bun executable, and the
existing `the_spawn_argv_carries_paths_and_no_key_material` test extends to cover it. Rejecting
`sudo -E` (forwards the whole environment across a privilege boundary, the opposite of §2.9's
purpose) and `--preserve-env=` / `env_keep` (host-sudoers dependent, the class residual 2c
refused) is consistent reasoning, not preference. Check 11 is the right check —
`test -r -a -x "$BUN_PATH"` **as the target uid**, which is the thing that was actually
unverified. Closed. One residue lands in NEW-13: `PATH` is also reset, and the script does one
PATH lookup.

### NEW-7 — §2.9(4d), shutdown and reap → **CLOSED on stages 1-2, OPEN on stage 3**

**Stage 1 is real and I verified the break.** `comparison-supervisor.rs:603-606`:

```rust
loop {
    let frame = match m::read_frame(reader, m::ARTIFACT_PAYLOAD_MAX_BYTES) {
        Ok(Some(frame)) => frame,
        Ok(None) => break,
```

`Ok(None)` is EOF and it breaks the serve loop, which then falls through to the summary path.
Closing `handle.controllerToSupervisor` needs no uid match, so **the graceful stop is something
the controller can genuinely do across the boundary** — this is the right primitive and it is
the strongest part of §2.9(4d). Reordering `closeOwnedFds()` to run *first* rather than last is
the correct inversion.

**The `stopSupervisor` diagnosis is exact.** `remote-supervisor.ts:1111-1152` returns
`{ ok: true, … }` on all three exits — the already-exited catch (`:1133`), the polled exit
(`:1141`), and the post-`SIGKILL` fall-through (`:1149`, `exitCode: proc.exitCode ?? -1`). It
cannot distinguish signalled from reaped, exactly as stated. Replacing it with a `reaped`
verdict that names the stage that timed out is the right fix, and
`stop_supervisor_reports_not_reaped_when_the_process_survives` is the right mutation proof.

**Stage 2's claim holds in both sudo modes — for a normal exit, which is what stage 2 is for.**
In exec mode there is no sudo process at all, so the observed pid *is* bash→supervisor and its
exit is the supervisor's. In fork mode sudo `waitpid`s its child and exits with its status, so
sudo's exit strictly follows the child's. The `exited` promise (`remote-supervisor.ts:717-723`)
resolves on the `"exit"` event, so it is a real waitpid observation either way. Approved.

**One required change stage 2 does not state.** The claim fails in exactly one case: if `sudo`
is itself `SIGKILL`ed in fork mode, it dies without reaping and the supervisor is orphaned to
launchd — so "sudo exited" would report `reaped: true` about a process that is still running.
The current code does exactly that at `:1145` (`proc.kill("SIGKILL")`). §2.9(4d) replaces the
escalation with `sudo … /bin/kill`, which is right, but it must say explicitly that the
existing `proc.kill("SIGKILL")` path is **deleted, not retained as a fourth stage** — otherwise
the new verdict becomes false precisely when it matters most.

Stage 3 is where it breaks: NEW-11 and NEW-12.

### NEW-8 — §2.13, the rig's lifetime mismatch → **CLOSED**

Promoted out of the residuals, owned by S5-RIG, with §3.4's assertion-1 row corrected. Every
citation verified:

- `rig-accept-cohort-request/v1` at `cross-supervisor-protocol.ts:2046-2051` is exactly
  `{requestSeq, executionSha256, cohortGrantBase64, cohortGrantSignatureBase64}` — no
  acceptance field.
- Plan 775-781 is byte-identical in shape, so the TS is a faithful implementation and the
  absence is the plan's, not a drift.
- Plan 566-572 supplies the field names to copy verbatim —
  `rigExecutionAcceptanceBase64` / `rigExecutionAcceptanceSignatureBase64` from
  `mac-present-rig-execution-acceptance-request/v1`. Copying an existing frozen pair rather
  than inventing names is the right move and makes it registration-shaped.

The ↺ is correct and important: the Mac fix was free because its frame already carried the
inputs; the rig's is not, and calling it a §3.3 registry edit rather than eliding the
difference is the honest framing. Ownership is right too — S3 (wave 1) makes the edit in its
own file, S5-RIG (wave 2) consumes it, so single ownership survives across the two waves.

### NEW-9 — the five mode sites → **CLOSED**

`:702-704`, `:1555`, `:1556`, `:1560`, `:1698-1699` — all five verified at HEAD, including the
two I added (`:1556` is the separate `mkdirSync(args.stagingRoot, {mode: 0o700})`, and the
placeholder write really is `:1560`). The preflight-as-backstop paragraph is the right lesson
to draw and states it correctly: checks 4-9 assert the effect, so a missed site refuses before
traffic rather than failing at spawn.

### NEW-10 — residual hygiene → **CLOSED**

Residual 7 reduced to a note consistent with the S5-MAC-RS row; residual 4's total corrected.
One stale line remains: §2.10 still says "**five** for S3 in total" while the S3 row now says
**six** hex vectors, the sixth being §2.13's. Fix the earlier line.

---

## New findings

### NEW-11 — BLOCKING — stage 3's process group does not exist, and the pgid the controller has is its own

§2.9(4d) stage 3 is `sudo -n -u _wtcompare /bin/kill -TERM -- -<pgid>`, then `-KILL`, and S9's
test asserts "no process remains in the supervisor's process group (`ps -g <pgid>` empty)".
The document mentions `pgid` in exactly two places (`:947`, `:961`) and **never says where it
comes from**. At HEAD it cannot come from anywhere safe:

- `nodeSpawn` is called with only `stdio` and `env` (`remote-supervisor.ts:843-850`) — **no
  `detached: true`**, so no `setsid`. The child inherits the **controller's** process group.
- `handle.pid` is `child.pid` (`:727-729`), which is sudo's pid, not a pgid.

So the only process group the controller can name is its own, and
`kill -TERM -- -<controller pgid>` would signal **the controller itself, the rig supervisor
(`bin/compare-controller.ts:2506`), and every role child** — turning a teardown into a
campaign-wide self-inflicted kill. And S9's `the_campaign_teardown_reaps_the_wtcompare_supervisor`
can never pass, because `ps -g <pgid>` contains the controller.

The design already knows the right shape and uses it one layer down: §1.2's `SERVER_READY` row
says the rig's `spawn_server` "forks into **its own pgid**", and §1.2's `TEARDOWN` row says the
rig "reaps the server pgid". The Mac supervisor needs the same treatment and does not have it.

**Exact change:** spawn with `detached: true` so the child calls `setsid` and becomes a
process-group leader with `pgid === child.pid`, making `-<pgid>` unambiguous and disjoint from
the controller's group. State that `detached` is compatible with `stdio: ["pipe","pipe","pipe"]`
and that it also removes the controlling terminal (see NEW-13). Add the pgid to
`SupervisorHandle` beside `pid` so stage 3 and the S9 test name the same number, and add a
preflight or spawn-time assertion that the supervisor's pgid **differs from the controller's** —
without it, a regression that drops `detached` silently re-arms the self-kill.

### NEW-12 — MUST-FIX — preflight check 12 fails on a correctly configured host

Check 12 is `sudo -n -u _wtcompare /bin/kill -0 $$`. `$$` is the **controller's** shell pid,
owned by the controller account. `kill(2)` permits a signal (including the `0` probe) only when
the sender's real or effective uid matches the target's real or saved uid, or the sender is
privileged. Running as `_wtcompare`, neither holds against a controller-owned process, so the
kernel returns `EPERM`, `/bin/kill` exits non-zero, and the preflight refuses
`REFUSED/STALE_OR_INVALID_STAGING` **on a host where everything is configured correctly** —
the opposite of the check's intent. Worse, it fails for a reason that looks like the sudoers
grant is missing, which is the one thing check 1 already proved.

I could not execute this on the review host — there is no `sudo` grant for `_wtcompare` here,
so an attempt would fail at the sudo layer and prove nothing about `kill`. Stated as a
semantics claim, and it should be settled by execution before S9 writes it.

**Exact change:** the check's real intent is "the grant covers running `/bin/kill`", which
under `${ADMIN_USER} ALL=(_wtcompare) NOPASSWD: ALL` check 1 already establishes. Either drop
check 12, or make it self-targeting — `sudo -n -u _wtcompare /bin/sh -c 'kill -0 $$'` — or
reduce it to `sudo -n -u _wtcompare test -x /bin/kill`. Whichever, add the requirement that
every preflight check must **pass on a correctly configured host**, which is the property this
one violates and which nothing currently states.

### NEW-13 — MUST-FIX — the twelve-object table against its own stated domain

The domain is now "everything the child needs and everything that acts on it", which is the
right domain. Walking it exhaustively, four objects are outside the table and matter, and five
more are outside it and do not. Naming all nine so the next revision does not rediscover them
one at a time:

**Outside and matters:**

1. **The control channel — fds 0, 1, 2.** `stdio: ["pipe","pipe","pipe"]`
   (`remote-supervisor.ts:843-845`) and the wrapper's `--control-in-fd 0 --control-out-fd 1`
   (`:497-503`). These **do** cross the sudo boundary as open descriptors — sudo preserves
   standard I/O — which directly contradicts residual 2c's "nothing crosses a sudo boundary as
   an open fd". The statement is inaccurate as written, and this is not a pedantic point: it is
   the single most important object that crosses, because §2.9(4d) stage 1 *is* closing it.
   **Change:** add it as a row, and reword 2c to "no descriptor **the design opens** crosses;
   the three standard streams do, by construction, and stage 1 depends on that."
2. **umask.** Rows 7-8 and §2.9(4a) *require* `umask 007` so the supervisor's files are
   group-writable for the reverse crossing — but **nothing sets it**. sudo does not preserve the
   caller's umask; it applies the sudoers `umask` (0022 by default), so the supervisor would
   create `0640`/`0750` objects at best and the reverse crossing degrades silently to
   read-only. **Change:** emit `umask 007` as an explicit line in the argv script beside the
   `export`, and add a preflight or post-spawn assertion on a file the supervisor actually
   created.
3. **PATH.** `env_reset` replaces PATH with sudoers' `secure_path`. The wrapper does one PATH
   lookup — `exec 3< <(cat -- …)` (`:490`) — while everything else is absolute, and §2.9(4d)
   already spells `/bin/kill` absolutely. **Change:** spell it `/bin/cat` for consistency; the
   risk is low but the inconsistency is the kind that survives review.
4. **Working directory.** sudo without `-i` does not chdir, so the child inherits the
   controller's cwd — which `_wtcompare` may not be able to traverse. Inheritance itself does
   not fail (the handle is inherited, not re-resolved), but `getcwd()` and any relative open
   would, and the failure would be obscure. **Change:** `cd /` at the top of the script. Free,
   and it makes the child's cwd a stated property rather than an accident.

**Outside and does not matter — named and dismissed:**

5. **Controlling tty.** `sudo -n` fails under `requiretty`; preflight check 1 already catches
   it. `detached: true` (NEW-11) removes the controlling terminal, which is the desired end
   state. Say check 1 covers it.
6. **Resource limits.** Inherited, possibly reset per sudoers. The Mac supervisor holds ~18
   role-child pipes and two descriptors, not the 1,010 sockets — that load is on the server
   child, spawned by the rig, on the controller's side of the boundary. Low risk.
7. **Signal dispositions.** sudo resets handlers to default for the command; Rust's std sets
   `SIGPIPE` to `SIG_IGN` at startup, so stage 1's pipe close surfaces as the `Ok(None)` EOF
   break rather than a signal death. Benign, and worth one sentence because stage 1 depends on
   it.
8. **Locale / `LANG`.** Stripped by `env_reset`. The binary emits canonical JSON and lowercase
   hex; Rust's formatting is locale-independent. Benign.
9. **`TMPDIR`.** Stripped. Nothing on the Mac supervisor path writes temp files now that the
   wrapper is argv. Benign — and worth noting that this is a *consequence* of form (iv),
   i.e. one more thing (iv) bought.

---

## The slice table

**Disjointness and sequencing hold, including the two registry edits.** S3 (wave 1) owns
`cross-supervisor-protocol.ts` exclusively and now carries both edits — §2.10's teardown and
Phase-A Mac tables, and §2.13's `rig-accept-cohort-request/v1` acceptance fields — with six hex
vectors. S5-RIG (wave 2) consumes the second edit without touching the file, so the
cross-language single-owner rule holds across the wave boundary exactly as S2→S4 does for the
shard bound. That is the correct pattern and it is now used consistently three times.

Everything else is unchanged from revision 4 and still holds: `secure_fs.rs` split across
waves 1/2/3 by disjoint region, `comparison-supervisor.rs` across 2/3 by disjoint arms,
`cohort-protocol.ts` S2-only, `server-observation-artifact.ts` S5-RIG-only,
`bin/stage-live-campaign.ts` S9-only. Every file any slice touches has one owner, which gate
item 9 now makes checkable.

**Totals: 14,600-18,900 src / 12,800-16,700 test, as a floor.** NEW-11 (`detached`, a pgid on
the handle, an assertion), NEW-12 (a corrected check), and NEW-13 (three script lines, a table
row, a reworded residual) add perhaps +150-300 src — the smallest increment of the five
revisions, which is the first evidence that the enumeration is converging rather than the
review simply finding a new layer each time. The floor framing should stay until a revision
survives with **zero** new crossing objects.

---

## Open items, in the order they block work

1. **NEW-11** — spawn `detached: true`, carry the pgid on `SupervisorHandle`, assert it differs
   from the controller's; without it stage 3 kills the campaign and the S9 reap test cannot
   pass.
2. **NEW-12** — replace or drop preflight check 12; add the rule that every check must pass on
   a correctly configured host.
3. **NEW-13** — add the control channel (fds 0/1/2) and umask as rows, reword residual 2c, and
   put `umask 007`, `cd /` and `/bin/cat` in the script; name and dismiss the other five.
4. **NEW-7 residue** — state that `proc.kill("SIGKILL")` (`remote-supervisor.ts:1145`) is
   deleted, so the reap verdict cannot be falsified by orphaning in sudo's fork mode.
5. **NEW-10 residue** — §2.10's "five for S3 in total" is stale against the S3 row's six.

---

# Revision 4 review

Revision 4 closes six of the seven items outright and improves on two of them beyond what I
asked for. §2.9(4a) is the right instrument — an enumeration of every crossing object rather
than another one-at-a-time patch — and it found more than my review did: the staged trust
root and *every* subdirectory are `0700`, so fds 3, 4 and 6 were unreadable too, not only
campaign-root. The NEW-3 resolution is better than the fix I proposed: instead of respawning
per execution, it discovered that `mac-open-cohort-request/v1` **already** carries every
per-execution input, dropped two descriptors, and kept the campaign-scoped process — which
also sharpens the restart-refuses test rather than complicating it.

It is still rejected. The enumeration in §2.9(4a) claims to cover "every object that crosses
the uid boundary" and covers every *filesystem* object. Two non-filesystem objects cross and
are not in it, and both break the spawn at run time. One residual is correctly diagnosed and
wrongly classified.

I want to record the pattern honestly, because it now cuts both ways. Four revisions have
each found work one layer below the last, and revision 4 says so itself and asks the reader
to treat its totals as a floor. That is the correct posture. But the same fact means
"enumerate the objects" only helps if the enumeration's *domain* is right, and here it was
scoped to files.

## Verdict drivers

- **NEW-6 BLOCKING** — `sudo`'s `env_reset` strips `COMPARISON_SUPERVISOR_BUN_PATH`, which the
  Mac binary requires. The supervisor fails at startup under form (iv).
- **NEW-7 BLOCKING** — the controller cannot signal a `_wtcompare`-owned process; campaign
  teardown (`stopSupervisor`) crosses the boundary and is not in the table.
- **NEW-8 MUST-FIX** — residual 6 is right on the facts and wrong on the urgency: the rig's
  identical mismatch breaks **this design's own e2e** at execution 2.
- **NEW-9 MUST-FIX** — §2.9(4a)/S9's line list omits `:1556` and miscites `:1558`; working the
  list as written leaves fd 6 unreadable.
- **NEW-10 NOTE** — residual 7 contradicts the S5-MAC-RS row, violating the design's own new
  gate item 9.

---

## Disposition of the seven items

### NEW-1 — the wrapper script as a filesystem object → **CLOSED** (new NEW-6 on the same spawn form)

Form (iv), `sudo -n -u _wtcompare /bin/bash -c <script text>`, is the right choice and the
three rejections are each grounded in something real, not taste:

- **(i) rejected on §9 immutability** — correct. `$MAC_TRUST/upcoming-run-command.sh` is mode
  `0444` (plan 2684) and asserted (plan 2886); the stage receipt binds the tree's digests. A
  per-spawn file in the staged tree breaks staging.
- **(ii) rejected on a concrete conflict** — verified. `remote-supervisor.ts:843-845` wires
  `stdio: ["pipe","pipe","pipe"]` and the wrapper binds `--control-in-fd 0 --control-out-fd 1`
  (`:497-503`). `bash -s` would consume the frame channel. Real conflict, correctly named.
- **(iii) rejected because the six descriptors are shell redirections** — verified. The script
  is `exec 3< <(cat -- …)`, `exec 4<…`, `exec 5<…`, `exec 6<…` (`:490-493`). Only a shell does
  that.

**The argv-exposure claim holds, and I checked it rather than taking it.**
`buildRigSupervisorWrapperScript` (`remote-supervisor.ts:466-504`) interpolates exactly five
values, all through `shellQuote`: `authorityFile`, `authorityDigestFile`, `campaignRootDir`,
`stagingRootDir`, `rigBinaryPath` — plus fd numbers and flag names. **No key material, and no
secret of any kind.** Adding fd 7 (the key *path*) and fd 8 (the rig public leaf) keeps it
paths-only, and every one of those paths is already in the world-readable mode-0444 run
command. The named test asserting argv contains no key bytes is the right guard. Deleting the
three `unlinkSync` sites (`:854`, `:879`, `:891`) rather than relocating them is correct, and
the observation that (iv) *strengthens* residual 2c rather than trading against it is fair:
there is no longer any filesystem object to pin, chmod, or leak.

### §2.9(4a) — the ten-object table → **CLOSED on substance, OPEN on NEW-9 and on its domain**

Every mode claim verified at HEAD:

| Claim | Verified |
|---|---|
| staged trust root **and every subdirectory** created `0700` | `bin/stage-live-campaign.ts:702-704`: `mkdirSync(args.root, {mode: 0o700})` then `for (const dir of PRESTAGE_DIRS) mkdirSync(join(args.root, dir), {mode: 0o700})` ✓ |
| campaign-root created `0700` | `:1555` ✓ |
| leaves written `0600` | `:1560`, `:1698-1699` ✓ |
| key `0400` owner `_wtcompare` — already correct, must not widen | plan 238 ✓ |
| rig public leaf `0644` — already correct | plan 2772 ✓ |

The ↺ is right and my review understated the problem: fds 3, 4 and 6 were unreadable too.

**The target modes are the minimum and are consistent with §9 and plan 2775.** `0750`/`0640`
group-`staff` on the read-only pair grants traverse+read and nothing more. `2770` setgid plus
`umask 007` on campaign-root is the correct answer to the reverse crossing (rows 7-8) and I
could not find a weaker one that works: without setgid, files the supervisor creates land in
`_wtcompare`'s primary group and the controller cannot read them back at assembly. Row 5 —
the key is the one object that must *not* widen, with the preflight asserting its negative —
is the right thing to state explicitly. §9 immutability is untouched because the mode change
happens at *staging* time, in the tool that creates the tree, not at spawn time; and plan
2775's `test ! -r` is not merely preserved but strengthened by preflight check 2, which moves
it to run time. Approved.

**Two problems.** The domain is filesystem-only despite the section title — see NEW-6 and
NEW-7. And the line list S9 will work from is wrong in two places — NEW-9.

### NEW-3 — lifetime → **CLOSED, and better than the fix I asked for**

Verified: `grep -c 'spawnRigSupervisor(' → 1`, `spawnMacSupervisor` likewise, so both
supervisors are campaign-scoped. Choosing per-campaign and moving the per-execution inputs
onto the frame is the right call, and the frame already carries them —
`cross-supervisor-protocol.ts:1942-1950`:

```
"mac-open-cohort-request/v1": { requestSeq, executionSha256, scenarioHash, rolePlanHash,
   workloadRolePlanInputBase64, workloadRolePlanInputSha256, workloadRolePlanInputSize }
```

so `--cohort-execution-binding-fd` and `--cohort-role-plan-fd` were carrying what the frozen
key set already carries. Four → two campaign-scoped descriptors is a genuine simplification,
not a workaround. The per-execution `MacCohortSession` keyed by `executionSha256`, closed at
`mac-cohort-evidence-exported-ack/v1`, plus
`one_process_serves_four_executions_with_distinct_sessions`, closes it. And the consequence
for the restart test is reasoned correctly: campaign-scoped means a mid-campaign restart is
never legitimate, so no respawn discrimination is needed and both nets stand.

### NEW-2 — `server-observation-artifact.ts` → **CLOSED**

The second definition is deleted from the design, the existing module becomes the TS owner of
`rig-measure-start-ack/v1`, and S5-RIG owns it (wave 2, no other slice touches it). One vector.
S8 consumes the owner's type. Correct.

### NEW-2b — union widening → **CLOSED**

§2.10 item 0 widens `PhaseARigFieldSpec` (`:2480-2490`) with the three missing kinds and three
arms in `phaseARigFieldOk` (`:2498`), plus a regression assertion over the existing eleven —
which is what this needed, because the union is the validator every Phase-A rig frame already
depends on. The design also correctly records that both it and my revision-2 review were wrong
about this; I withdrew that claim in revision 3 and it is properly attributed.

### NEW-4 — the cardinality table → **CLOSED**

A separate `COHORT_CELL_GRANT_PARAMETERS`, same owner/slice/test, with
`COHORT_CELL_CARDINALITIES` left byte-identical and a named test
`the_exact_4_5_table_is_unchanged`. That is the stronger of the two options I offered, and the
test makes the property checkable rather than asserted.

### 2b — preflight and staging ownership → **CLOSED on ownership, OPEN on NEW-9**

Ten checks, and check 10 (`test -r "<campaignRoot>"` from the controller) is exactly the
reverse-crossing proof I asked for: it shows assembly cannot fail after measurement.
`bin/stage-live-campaign.ts` is now owned by S9. The remaining open part is correctly narrowed
to "does the installed host already satisfy it", which S0's tier probe answers.

### NEW-5 — citations → **CLOSED**

`bin/` prefix fixed throughout; mode-444 now cites plan 2684 asserted at 2886.

### Gate item 9 — every touched file owned → **good addition, contradicted by residual 7**

The rule is right and the reason for it is stated honestly ("revisions 3 and 4 each found a
file that no slice owned, and in both cases the gap was a codec or a mode the design depended
on"). "A slice that discovers it must edit an unlisted file **stops and gets the file
assigned**" is the correct procedure. The `bin/fanout-role.ts` statement — deliberately
unedited, and a slice that finds itself changing it has found a defect in §2.5 — is the right
shape for a negative ownership claim: it names the file, the reason, and what its violation
means. See NEW-10 for the contradiction.

---

## New findings

### NEW-6 — BLOCKING — `sudo` strips the environment variable the Mac binary requires

Form (iv) changes the spawn to `/usr/bin/sudo -n -u _wtcompare /bin/bash -c <script>` and
leaves the `env` option exactly as it is. At HEAD, `remote-supervisor.ts:845-850`:

```ts
env: { ...process.env, COMPARISON_SUPERVISOR_BUN_PATH: options.bunExecutablePath },
```

and the Mac supervisor **requires** it — `crates/native/src/bin/comparison-supervisor.rs:1877`
does `std::env::var_os("COMPARISON_SUPERVISOR_BUN_PATH")`, with the failure text at `:1913`
telling the operator to "set `COMPARISON_SUPERVISOR_BUN_PATH` to the Bun executable".

`sudo` with the default `env_reset` in sudoers discards the caller's environment apart from a
small `env_keep` list. `COMPARISON_SUPERVISOR_BUN_PATH` is not in any default `env_keep`, so
under (iv) the variable does not reach the binary and **the Mac supervisor fails at startup**,
before any descriptor matters. The frozen run command's own `COMPARISON_*` exports
(`bin/stage-live-campaign.ts:1025-1026`) are stripped by the same mechanism, so anything else
that comes to depend on them inherits the bug.

This is the eleventh crossing object: **the environment**. §2.9(4a) enumerates files and
directories and stops there, which is why it did not catch it.

**Exact change:** §2.9(4a) gains an environment row, and §2.9(4) states the mechanism. The
cheapest one is consistent with what (iv) already does — interpolate it into the script text
as `export COMPARISON_SUPERVISOR_BUN_PATH=<shellQuote(path)>`, since the argv-exposure
analysis already established that paths are safe to expose and the script is already built by
interpolation. `sudo --preserve-env=COMPARISON_SUPERVISOR_BUN_PATH` is the alternative but
depends on sudoers permitting it, which is the class of host dependency residual 2c correctly
refused to rely on. Add a preflight check that the resolved bun path is readable and
executable by `_wtcompare`, and a test asserting the supervisor starts under `sudo` with an
emptied parent environment.

### NEW-7 — BLOCKING — the controller cannot signal the process it spawned

Campaign teardown is `stopSupervisor(macSupervisor, 5_000)`
(`bin/compare-controller.ts:2509`, and `:2506` for the rig), which reaches
`kill(signal) { return child.kill(signal); }` (`remote-supervisor.ts:733-735`) on a handle
whose `pid` is `child.pid` (`:727-729`). Under (iv) two things change and neither is addressed:

1. **The process is owned by another uid.** `kill(2)` requires a matching real or effective
   uid. The controller account cannot signal a `_wtcompare`-owned supervisor at all, so
   `stopSupervisor`'s escalation path silently fails and the 5,000 ms bound expires against a
   process that never receives the signal. §1.2's `TEARDOWN` row and §3.2's 10 s
   "capture + join + seal + teardown" budget both assume it works.
2. **The pid may not be the supervisor.** Whether `sudo` `exec`s the command in place or
   forks and relays signals is version- and configuration-dependent. `child.pid` is the
   `sudo` pid; if sudo forks, killing it need not reap `bash`→supervisor, and the descriptors
   the handle owns are released while the supervisor lives on.

This is the twelfth crossing object: **process control**. It is the same species as NEW-1 —
the design moved the executor across the boundary and left the thing that stops it behind.

**Exact change:** §2.9(4a) gains a process-control row, and §2.9(4) specifies the mechanism.
Options, each with a real cost the design should weigh rather than assume: a graceful stop on
control-channel EOF (the supervisor already owns fd 0/1, so closing the control pipe is a
signal the controller *can* send across the boundary — this is probably the right answer and
it costs a supervisor-side change in S5-MAC-RS); `sudo -n -u _wtcompare /bin/kill` as the
escalation path (costs a second sudo grant and a preflight check); or a supervisor-side
watchdog. Whichever is chosen, `stopSupervisor` needs a test that the supervisor is actually
reaped, not merely signalled — because today's code cannot tell the difference.

### NEW-8 — MUST-FIX — residual 6 is correctly diagnosed and wrongly classified: it breaks this design's e2e

Residual 6 says the rig has the same lifetime mismatch, records it "so round five does not
discover it as new", and states that "no slice above touches it". The diagnosis is verified:
`spawnRigSupervisor` has exactly one call site (`bin/compare-controller.ts:2471`), and
`install_production_cohort_runtime` reads the acceptance **once at process start** —
`read_all_from_fd(descriptors.acceptance_fd, …)` at `comparison-supervisor.rs:1465`, feeding
`read_rig_execution_acceptance` at `:1473`, whose `inputs` become the binding every
`RigCohortSession` checks `executionSha256` against.

But the consequence is not deferrable. §3.2 runs **four executions** (one unsealed warmup plus
one measured, per arm), §3.1 boots the rig with `--cohort-execution-acceptance-fd` and
`--cohort-execution-acceptance-signature-fd`, and mandate assertion 1 needs two *sealed* arms.
One campaign-scoped rig process holding execution 1's acceptance will refuse executions 2, 3
and 4 on the binding check. **S10 cannot pass mandate assertion 1**, which is the whole point
of §3.4's reachability table — and §3.4 currently answers "Yes" for assertion 1.

**Exact change:** promote residual 6 out of the open-questions list into §2.9 or a new §2.13,
give it to **S5-RIG** (it owns `cohort::rig`, the rig dispatch arms, and
`comparison-supervisor.rs`), and apply the symmetric fix the residual itself proposes: the
acceptance and its signature move onto `rig-accept-cohort-request/v1`, leaving the rig with
the signing key and the role root — two campaign-scoped descriptors, exactly as NEW-3 left the
Mac. Then update §3.4's assertion-1 row, S5-RIG's estimate, and add
`one_rig_process_serves_four_executions_with_distinct_bindings` beside the Mac's equivalent.
This is not a round-five note; it is the same defect NEW-3 fixed, on the other supervisor,
inside the same e2e.

### NEW-9 — MUST-FIX — S9's mode-change line list omits one `0700` mkdir and miscites another line

§2.9(4a) and residual 2b specify S9's work as `bin/stage-live-campaign.ts` at `:702-704`,
`:1555`, `:1558`, `:1698`. Read at HEAD:

```
1555  mkdirSync(args.campaignRoot, { recursive: true, mode: 0o700 });
1556  mkdirSync(args.stagingRoot,  { recursive: true, mode: 0o700 });
1557  for (const leaf of MAC_CAMPAIGN_ROOT_FINAL_LEAVES) {
1558    const path = join(args.campaignRoot, leaf);
1559    if (!existsSync(path)) {
1560      writeFileSync(path, "", { mode: 0o600 });
```

- **`:1556` is missing from the list.** It is a *separate* `0700` mkdir of `stagingRoot` — the
  fd 6 object of row 4. The prose says staging-root becomes `0750`, but the line list is what
  S9 will work from, and a slice that changes `:702-704` and `:1555` and stops leaves fd 6
  unreadable. That is precisely the failure mode §2.9(4a) exists to prevent, reintroduced by
  an incomplete citation.
- **`:1558` is `const path = join(...)`**, not a write. The placeholder write is `:1560`.

**Exact change:** the list becomes `:702-704`, `:1555`, `:1556`, `:1560`, `:1698-1699`, and the
preflight's check 7 (`test -x "$MAC_TRUST/staging-root"`) is the assertion that catches it if
S9 still misses one. Worth stating that the preflight is the backstop for exactly this class
of omission — it already is, and saying so makes the ten checks load-bearing rather than
decorative.

### NEW-10 — NOTE — residual 7 contradicts the slice table, violating the design's own gate item 9

Residual 7 reads: "`crates/native/tests/fanout_supervisor.rs` is owned by no slice … Assign it
to S5-MAC-RS if that slice touches the owner type." But the S5-MAC-RS row already owns it:
"`crates/native/tests/mac_cohort_runtime.rs`, `crates/native/tests/fanout_supervisor.rs`
(residual 5)". The table is right and the residual is stale from revision 3. Since gate item 9
now makes single ownership a checkable property, a residual asserting a file is unowned when
the table owns it is exactly the kind of drift the gate is meant to catch. Delete residual 7,
or reduce it to a note that S5-MAC-RS owns it because of `CohortRuntime`'s surface.

Also stale: residual 4 still cites "The total (12.5-16k src)" against the revision-4 total of
14,200-18,300.

---

## The slice table

**Disjointness holds, in every wave.** Wave 1: S0 (`.scratch/` only), S1
(`child-pipe-protocol.ts` + new test), S2 (`cohort-protocol.ts`, the `parse_shards` region,
`cohort_protocol.rs`, two TS test files, and line 210 of a third), S3
(`cross-supervisor-protocol.ts` + test) — no overlap. Wave 2: S4 (`fanout-relay.ts`,
`fanout-relay.test.ts`, `fanout-supervisor-integration.test.ts`) and S5-RIG (`secure_fs.rs`
`cohort::rig`, `comparison-supervisor.rs` rig arms, `rig_cohort_runtime.rs`,
`server-observation-artifact.ts`) — no overlap, and the two files revisions 3 and 4 found
unowned are now each held by exactly one slice. Wave 3: S5-MAC-RS and S6 — no overlap.
Waves 4-6 single- or two-slice.

**Shared-file sequencing holds.** `secure_fs.rs` is touched by S2 (wave 1, `parse_shards`),
S5-RIG (wave 2, `cohort::rig`) and S5-MAC-RS (wave 3, new `cohort::mac`);
`comparison-supervisor.rs` by S5-RIG (wave 2, rig arms) and S5-MAC-RS (wave 3, mac arms);
`cohort-protocol.ts` by S2 (wave 1) alone now that §2.11's TS half moved to
`server-observation-artifact.ts`. Regions are disjoint and the waves are ordered, so no file
is held concurrently. NEW-8 would add rig work to S5-RIG in wave 2 without changing this.

**Codec single ownership: intact for the first time.** `rig-measure-start-ack/v1` now has one
TS home; the teardown frames and the two Phase-A Mac frames are S3's; the child-pipe schemas
are S1's; the §4.1 codecs are S2's. Every cross-language codec names one slice and one vector.

**Totals: 14,200-18,300 src / 12,300-16,000 test, stated as a floor.** The floor framing is
correct and I would keep it. NEW-6 and NEW-7 add supervisor-side and spawn-side work; NEW-8
adds a rig descriptor change with its own vector and test to S5-RIG. None is large
individually — call it +400-700 src — but the pattern the document names about itself holds
for the fifth time, and the honest reading is that the number is not yet converged.
**"This is a program, not a slice" remains the headline**, and option (a)'s price is now
priced correctly in plan terms (line 234, line 238, and §3.1's bidirectional check made
vacuous).

---

## Open items, in the order they block work

1. **NEW-6** — specify how `COMPARISON_SUPERVISOR_BUN_PATH` survives `sudo`'s `env_reset`; add
   the environment row to §2.9(4a) and a preflight check; test startup under an emptied
   parent environment.
2. **NEW-7** — specify how the campaign stops a `_wtcompare`-owned supervisor; add the
   process-control row; test that it is reaped, not merely signalled.
3. **NEW-8** — promote residual 6 to a §2 blocker owned by S5-RIG, move the rig acceptance
   onto `rig-accept-cohort-request/v1`, and correct §3.4's assertion-1 row.
4. **NEW-9** — fix S9's line list: add `:1556`, correct `:1558` → `:1560`.
5. **NEW-10** — delete or rewrite residual 7; refresh residual 4's total.

---

# Revision 3 review

Revision 3 closes six of the seven open items on substance and closes the seventh's *aim*
while getting its premise wrong. The N1 uid design is the best section in the document: it
reuses plan 2769/2915's own `sudo -n -u _wtcompare` form rather than inventing a privilege,
it consumes two frozen-but-unconsumed bindings instead of naming new ones, it moves plan
2775's `test ! -r` from staging time to run time where it protects something, it owns the
campaign-root consequence instead of hiding it, and residual 2c's rejection of fd-passing
across `sudo` is correct reasoning recorded so it is not reintroduced. I verified every
plan line it cites and every claim it makes about HEAD.

It is still rejected. One defect is blocking and I proved it by execution; three more are
must-fix, one of which is my own revision-2 error carried forward, and I correct it here.
The pattern is now legible and worth naming for round four: **each revision moves the named
object across the boundary and leaves an unnamed one behind it.** Revision 2 moved the key
off the heap and left it on a path the opener could not read. Revision 3 moved the opener
across the uid boundary and left the *script it executes* behind, mode 0700 in a directory
the new uid cannot traverse.

## Verdict drivers

- **NEW-1 BLOCKING** — the wrapper script `sudo` is asked to run is mode `0700` in a
  per-user `tmpdir()` the target uid cannot traverse. Proved by execution.
- **NEW-2 MUST-FIX** — F8's premise is false: `RigMeasureStartAckV1` already has a TS
  interface, in a `protocolOnlyTs` module no slice owns. The fix creates a second definition.
- **NEW-2b MUST-FIX** — `intOrNull` / `stringOrNull` and a boolean literal kind do not exist
  in `PhaseARigFieldSpec`. **My revision-2 review said they did; that was wrong.**
- **NEW-3 MUST-FIX** — the Mac supervisor is spawned once per campaign, but fds 8 and 10 are
  per-`<runId>` and §3.2 runs four executions.
- **NEW-4 MUST-FIX (small)** — the two cardinality columns narrow plan 1289/1291's open
  unions inside a constant whose own comment says it is "the exact §4.5 table".

---

## Disposition of the seven open items

### N1 — the Mac signing-key uid boundary → **CLOSED on mechanism, OPEN on NEW-1 and NEW-3**

Everything §2.9(4) asserts about the plan and about HEAD is true. Verified line by line:

| Claim | Verified |
|---|---|
| key at `/var/db/webtransport-bun/comparison/keys/<cand>/<camp>.mac.pk8`, 0400, `_wtcompare` | plan 238 ✓ |
| `staging-root` holds public halves only | plan 2772 (`install -m 0644 … mac-supervisor-ed25519.pub`) ✓ |
| the controller must fail `test -r` | plan 238 and plan 2775 (`test ! -r "…mac.pk8"`) ✓ |
| `sudo -n -u _wtcompare` is already the plan's own form | plan 2769 (keygen), plan 2915 (destroy-signing-key) ✓ |
| `spawnMacSupervisor` does no uid change today | `remote-supervisor.ts:843` `nodeSpawn("bash", [scriptPath], …)` ✓ |

**The Architect's claim about the two env names holds, and it is a real find.** A repo-wide
grep returns exactly two hits each: `tools/compare/bin/stage-live-campaign.ts:1025-1026` and
plan 2868-2869. **No consumer anywhere.** That is the placeholder-evidence family precisely —
two bindings the frozen run command exports and nothing reads — and consuming them rather
than inventing `COMPARISON_MAC_KEY_FD` is the right call.

The four-check preflight is well designed and correctly positioned (plan 2272's pre-`mkdir`
slot, plan 2289's `REFUSED/STALE_OR_INVALID_STAGING`), and the observation that check two —
*the controller must fail* — is the interesting one is exactly right. Tier A / tier B is
honest: it moves the key, not the boundary, skips with a named reason rather than passing
silently, and the two-condition seam guard (`COMPARISON_MAC_SUPERVISOR_UID_SEAM=1` **and**
the key path inside the campaign scratch root) is structurally unreachable from a mode-0444
frozen run command that sets neither. Approved as designed.

**One citation slip:** the mode-444/immutable property of `upcoming-run-command.sh` is plan
**2684** ("has mode `0444`") and plan **2886** (`test "$(stat -f '%Lp' …)" = 444`). Plan 2853
is the `verify-stage` invocation and does not carry that claim.

### N2 — the Phase-A Mac field table → **CLOSED on structure, OPEN on NEW-2b**

`PhaseARigFieldSpec` (`cross-supervisor-protocol.ts:2480-2490`) does carry `base64OrNull`,
so renaming it to a shared `PhaseARemoteFieldSpec` and building `PHASE_A_MAC_FIELDS` /
`PhaseAMacRemoteSchema` / `parsePhaseAMacRemotePayload` beside `PHASE_A_RIG_FIELDS` is the
right shape, and S3 is re-estimated for it.

**The ↺ correction is right and mine was wrong.** Counting plan 705-714:
`rigBarrierAcceptanceBase64`, `rigBarrierAcceptanceSignatureBase64`, `serverWarmupDrainedBase64`,
`serverStartBarrierAcceptedBase64`, `linuxRelayObservationBase64`,
`rigRelayObservationReceiptBase64`, `rigRelayObservationReceiptSignatureBase64` = **seven**
on `mac-present-rig-observation-request/v1`; plus `cohortAdmissionReceiptBase64` and
`cohortAdmissionSignatureBase64` on the ack = **nine**. I said six. Accepted.

### F5 — S2's wave-1 gate-2 violation → **CLOSED**

Verified independently: `grep -n 'lastSubscriberIndexExclusive\|SHARD_SUBSCRIBERS'
tools/compare/fanout-supervisor-integration.test.ts` returns `:170` (the constant), `:210`,
`:211`, `:213`, `:215` (the one fixture block) and `:5529`/`:5541` (already the grant total).
Line 210 is the only shard-local bound in the file. A single-line carve-out is the minimum
correct fix and it makes S2's gate 2 satisfiable. Good.

### F8 — §2.11 to S5-RIG → **aim ACHIEVED, premise FALSE, item OPEN (NEW-2)**

Moving all of §2.11 into one slice does fix what I raised: the vector and both halves now
land together, so gate 8 is satisfiable when S2 reports done. But the justification is wrong
in a way that creates a new defect — see NEW-2.

### N3 — chosen grant parameters and the pilot statement → **CLOSED on the statement, OPEN on NEW-4**

The machinery-vs-pilot distinction is now stated plainly, which is what I asked for, and
`COHORT_CELL_CARDINALITIES`'s interface really is at `cohort-protocol.ts:5235-5243`. Owner
assignment to S2 is correct. The placement of the two columns is not — NEW-4.

### Finding-1 residue — the two nets → **CLOSED**

The nets are genuinely independent and the mutation proof is correctly designed. Net 1 is a
*channel* property: §3.3/plan 529 fails "a skipped, repeated, stale, or out-of-state"
`requestSeq`, a restarted supervisor's direction begins at 0, and the check fires **before
any session state is consulted** → `FAIL/TRUST_PROTOCOL` (plan 2293). Net 2 is a *state*
property: `retained(...)` refuses when the session never held the record →
`FAIL/CROSS_SUPERVISOR_MISMATCH` (plan 2294). Different inputs, different codes, different
layers. Disabling net 1 and deleting the retention check to show the test still goes red on
net 2 alone is the right proof that they are two nets and not one counted twice. Accepted.

**One consequence NEW-3 puts back on the table:** if the Mac supervisor turns out to be
per-execution rather than per-campaign, a restart becomes the *normal* path between
executions, and `a_restarted_mac_supervisor_refuses_to_admit_on_five_of_seven` must
distinguish a legitimate inter-execution respawn from an illegitimate intra-execution one.
The design cannot state that test precisely until it decides the process lifetime.

### N4 / N5 → **CLOSED**

`PROCESS_TEST_TIMEOUT_MS = 900_000` at `fanout-production-e2e.test.ts:163` is per-test and
the 240,000 figure is dropped; `COHORT_REMOTE_PAYLOAD_SCHEMAS` is 22 members; `:4257` is the
declaration and `:4255` the doc comment above it. All three corrections verified.

---

## New findings

### NEW-1 — BLOCKING — `sudo` cannot read the wrapper script it is asked to execute

§2.9(4)'s spawn form is
`nodeSpawn("/usr/bin/sudo", ["-n","-u",USER,"/bin/bash", scriptPath])`. It changes the
*executor*'s uid and the *descriptor* provenance, and never touches the script itself. At
HEAD (`remote-supervisor.ts:827-832`):

```ts
const scriptPath = join(tmpdir(), `wtb-mac-supervisor-${process.pid}-${Date.now()}.sh`);
writeFileSync(scriptPath, wrapper.script, { mode: 0o700 });
```

Executed on this host:

```
$ node -e "console.log(require('os').tmpdir())"
/var/folders/4n/jk5pq5lx1vggn_1vrgs23phr0000gn/T
$ stat -f '%Sp %Su' /var/folders/4n/jk5pq5lx1vggn_1vrgs23phr0000gn/T
drwx------ vmeansdev
```

The directory is `drwx------` owned by the controller account, and the file inside it is
`0700` owned by the controller account. `_wtcompare` cannot traverse the directory, so it
cannot read the script, so **`/bin/bash <scriptPath>` fails at exec — before fd 3 is opened,
before the key is touched, before any of §2.9(4)'s provenance table applies.** Mode alone
would not save it on macOS: `/var/folders/<hash>/T` is per-user by construction.

This is the same species as N1 itself, one object further in. **Exact change:** §2.9(4) must
say where the wrapper lives so the target uid can read it — a mode-0755 path under
`$MAC_TRUST` or a campaign scratch directory created group-`staff` — and must carry the
properties the current site has and would lose: the script is written, executed, and then
`unlinkSync`'d after the alive check (`:854`, `:879`, `:891`), which is a deliberate
no-pathname property. Moving it to a shared directory makes the script a *world-* or
*group-*readable object containing the key's path and the fd layout, so it needs its own
digest pin and its own line in the preflight. S8 owns `remote-supervisor.ts` and must own
this; S9's preflight gains a check. Until this is specified, §2.9(4) does not run.

### NEW-2 — MUST-FIX — F8's premise is false; the fix creates a second definition of `rig-measure-start-ack/v1`

§2.11/F8 states: "Verified `rig-measure-start-ack/v1` has **no TS codec anywhere** — so the
TS half is a new `parseRigMeasureStartAck`, a named carve-out of `cohort-protocol.ts` that
collides with nothing S2 edits."

It has one. `tools/compare/server-observation-artifact.ts:87-105`:

```ts
export interface RigMeasureStartAckV1 {
  readonly schema: "rig-measure-start-ack/v1";
  readonly executionSha256: Sha256Hex;
  readonly measurementGrantSha256: Sha256Hex;
  readonly macExecutionGrantReceiptSha256: Sha256Hex;
  readonly rigExecutionAcceptanceSha256: Sha256Hex;
  readonly approvedPlanSha256: Sha256Hex;
  readonly approvalRecordSha256: Sha256Hex;
  …
  readonly warmupCompletionSha256: Sha256Hex | null;
```

— exactly the Rust key set §2.11 analyses. It is consumed at `:599`
(`baselineJson.value as RigMeasureStartAckV1`) and built at `:1192`, and
`scenarios/fanout-relay.ts:3045`'s own comment already names that module as the record's
owner: "The record's shape is the Phase-A `RigMeasureStartAckV1` in …". The module is in the
allowlist's **`protocolOnlyTs`** bucket, i.e. a protocol owner by classification.

So §2.11's three decisions — add `childResponseSequence`, add `rigSupervisorInstanceNonce`,
split `warmupCompletionSha256` into `warmupCompletionAuthoritySha256` +
`rigWarmupDrainedReceiptSha256` — **change a record whose TS definition lives in a file no
slice owns**, and the design's answer is to write a second definition of the same record in
`cohort-protocol.ts`. That is precisely the defect the cross-language single-owner rule
exists to prevent, and it is the same class as §1.4's "all five are the second
implementation". The verifiers at `remote-supervisor.ts:3608` and `:5385` (S8, wave 4) read
the schema too, so §2.11 currently spans S5-RIG (wave 2), an unowned `protocolOnlyTs` module,
and S8 (wave 4).

**Exact change:** make `server-observation-artifact.ts` the TS owner of
`rig-measure-start-ack/v1`, give that file to S5-RIG as a named carve-out (the interface at
`:87`, the builder at `:1192`, the reader at `:599`), drop the new
`parseRigMeasureStartAck` in `cohort-protocol.ts`, and state that S8's two schema checks
consume the owner's type rather than re-declaring it. F8's *aim* — one slice, both halves,
one vector — survives; only its premise and its target file change.

### NEW-2b — MUST-FIX — three of the field kinds §2.10 names do not exist (and my revision-2 review said they did)

§2.10 item 1 specifies `rig-server-stopped-ack/v1` as
`{… exitCode: intOrNull, signal: stringOrNull, reaped: literalTrue}`. `PhaseARigFieldSpec`
(`cross-supervisor-protocol.ts:2480-2490`) is exactly eleven kinds:

```
seq | positiveInt | sha256 | sha256OrNull | base64 | base64OrNull
| nsString | port | argv | literal{value: string} | oneOf{values: readonly string[]}
```

There is **no `intOrNull`**, **no `stringOrNull`**, and `literal` compares
`value === spec.value` where `spec.value` is typed `string` — so `reaped: true`, a **boolean**
literal, is not expressible either. Three kinds must be added to the union and three arms to
`phaseARigFieldOk` (`:2498`+), and `exitCode: number | null` per plan 929-934 needs a
nullable *integer* validator that does not exist.

**I am the source of this error.** My revision-2 review asserted "the Phase-A rig spec union
already has the kinds the two frames need (`sha256OrNull`, `base64OrNull` and friends), so
`exitCode` / `signal` are expressible there." I read the two nullable kinds and generalised.
Revision 3 reasonably relied on it. Correcting it here: **S3's scope includes widening the
shared field-spec union**, which is a change to the validator every Phase-A rig frame already
depends on, so it needs its own regression assertion that the eleven existing kinds behave
identically after the widening — S3's named test
`the_shared_field_spec_validates_both_tables_identically` covers the table split but not the
kind additions.

### NEW-3 — MUST-FIX — the Mac supervisor's lifetime does not match its per-execution descriptors

§2.9(1) describes `--cohort-execution-binding-fd` as "**this execution's** exact
`CrossSupervisorExecutionV1`", and §2.9(4)'s table sources fd 8 from
`<campaignRoot>/<runId>/execution-binding.json` and fd 10 from
`<campaignRoot>/<runId>/workload-role-plan-input.json`. Both are per-`<runId>`.

`spawnMacSupervisor` is called **once** in the controller
(`grep -c 'spawnMacSupervisor(' tools/compare/bin/compare-controller.ts` → 1, at `:2433`,
assigning `macSupervisor = spawned.handle` at `:2457`), in one-time setup before any
execution exists. §3.2 runs **four** executions per pilot (one unsealed warmup + one measured
per arm). One long-lived process holding one open `execution-binding.json` cannot serve four
`<runId>`s, and the controller cannot have written the first one before the spawn it precedes.

**Exact change:** decide and state the Mac supervisor's lifetime. If per-execution, §2.9(4)
needs four `sudo` spawns in the timing budget (§3.2 currently budgets none), the
restart-refuses invariant must distinguish a legitimate inter-execution respawn from an
illegitimate one (see the Finding-1 disposition above), and `macSupervisor` at
`compare-controller.ts:2457` becomes per-arm state — an S9 change not currently scoped. If
per-campaign, fds 8 and 10 cannot be per-`<runId>` and the binding must arrive on a frame
instead of a descriptor, which changes §2.9(1)'s "all-or-none four descriptors" to three.
Either answer is defensible; leaving it unstated means S5-MAC-RS and S9 will make opposite
assumptions.

### NEW-4 — MUST-FIX (small) — the two cardinality columns narrow a contract inside a table that says it is exact

§3.2 gives S2 two new columns on `COHORT_CELL_CARDINALITIES`. That constant's own comment at
`cohort-protocol.ts:5245` reads: "**The exact §4.5 table; nothing here is derived at runtime
from a knob.**" Plan §4.5's table (2144-2150) has seven columns and contains neither
`measuredDurationMs` nor `messageBytes`; both are grant fields the plan deliberately leaves
as open unions (`10000 | 30000`, `100 | 128` — plan 1289, 1291;
`cohort-protocol.ts:681`, `:683`). Pinning them per cell inside that structure is a **contract
narrowing dressed as a column addition**, and it silently makes the constant no longer the
§4.5 table it claims to be.

**Exact change:** put them in a separate `COHORT_CELL_GRANT_PARAMETERS` table (same owner,
same slice, same test), or keep them where they are and record the narrowing of plan
1289/1291 as an explicit registry edit in §1.2's three-way status list, alongside the
`server-capture-ack/v1` base64 edit. Do not leave `COHORT_CELL_CARDINALITIES`'s comment
asserting a property the edit removes.

### NEW-5 — NOTE — citation hygiene

`stage-live-campaign.ts` is `tools/compare/bin/stage-live-campaign.ts`; the design cites it
without the `bin/` segment at `:114-117`, `:157-170`, `:1025-1026` and in §2.9(4). And plan
2853 is miscited for the mode-444/immutable run command (that is plan 2684 and 2886). Neither
changes a conclusion, but this document's authority rests on its citations and both are the
kind of slip that made revision 1's §2.1 wrong.

---

## The slice table

**Disjointness within waves: holds.** Wave 1 (S0/S1/S2/S3) is disjoint, with S2's line-210
carve-out landing a wave before S4 takes the file. Wave 2 (S4/S5-RIG) is disjoint, and
S5-RIG's `cohort-protocol.ts` carve-out follows S2's wave-1 ownership sequentially. Wave 3
(S5-MAC-RS/S6) is disjoint. Waves 4-6 are single- or two-slice and disjoint.

**Shared Rust files: correctly sequenced.** `secure_fs.rs` and `comparison-supervisor.rs` are
edited by S2 (wave 1, `parse_shards` region), S5-RIG (wave 2, `cohort::rig` + rig arms) and
S5-MAC-RS (wave 3, new `cohort::mac` + mac arms). Regions are disjoint and the waves are
ordered, so no two slices hold the file at once. Residual 5's assignment of
`crates/native/tests/fanout_supervisor.rs` to S5-MAC-RS closes the last unowned Rust file.

**Codec single ownership: one violation, one gap.** `rig-measure-start-ack/v1` has two TS
homes under the current plan (NEW-2). And **two files are still owned by nobody**:
`tools/compare/server-observation-artifact.ts` (NEW-2, and it is `protocolOnlyTs`) and
`tools/compare/bin/stage-live-campaign.ts` (residual 2b names it and does not assign it).

**Hex vectors: satisfiable.** Moving §2.11 wholesale to S5-RIG does make gate 8 satisfiable
for S2, which is what F8 asked for. S3's five vectors and S1's per-schema vectors are
correctly scoped.

**Totals.** 13,900-17,900 src / 11,900-15,500 test on the same 2.75× calibration. The method
is sound and the S5-MAC-RS anchor caveat (`cohort::rig` ≈ 1,600 lines at
`secure_fs.rs:14721`→~`:16300`, so ~2×) is honestly flagged. The four findings above push it
up again — NEW-2b widens S3's validator, NEW-2 adds a third module to §2.11, NEW-1 adds a
wrapper relocation with a digest pin and a preflight check, NEW-3 may add a per-execution
spawn path to S9 — so read 13.9-17.9k as a floor, not a range. **"This is a program, not a
slice" remains the correct headline** and should stay the first thing the maintainer reads.

## The two new residuals

**2b — campaign-root group access: correctly owned, and one check short.** The residual
frames the problem as the supervisor *writing* evidence into a controller-created directory,
and the preflight checks `sudo -n -u _wtcompare test -w "<campaignRoot>"`. But fds **8 and
10** are also campaign-root objects the supervisor must *read*
(`<campaignRoot>/<runId>/execution-binding.json`, `…/workload-role-plan-input.json`), and
`test -w` on the root proves neither traverse nor read on the per-run subdirectory. Add a
fifth check, and note that whether `bin/stage-live-campaign.ts` should create the campaign
root group-`staff` group-writable is a question in a file no slice owns — the residual says
so, which is right; it should be escalated rather than left in a numbered list.

**2c — no fd-passing across sudo: correct, and correctly reasoned.** Putting the uid change
before every `exec N<…` so nothing crosses the boundary as an open descriptor is the right
call, and rejecting the alternative on `closefrom`/sudoers grounds rather than on taste is
the right *kind* of reason. Recorded so it is not reintroduced as a simplification — good.
NEW-1 is the one object this reasoning did not cover: the script is not passed as a
descriptor, it is passed as a **pathname**, and that is why the permission problem survived
the fd analysis.

---

## Open items, in the order they block work

1. **NEW-1** — relocate the wrapper script so `_wtcompare` can read it; restate the
   unlink-after-open property; digest-pin it; add a preflight check. §2.9(4) does not run
   until this is specified.
2. **NEW-3** — decide the Mac supervisor's lifetime (per-campaign or per-execution) and
   reconcile fds 8/10, §3.2's budget, and the restart-refuses test with the answer.
3. **NEW-2** — make `server-observation-artifact.ts` the TS owner of
   `rig-measure-start-ack/v1` and give it to S5-RIG; drop the second definition.
4. **NEW-2b** — widen the shared field-spec union with `intOrNull`, `stringOrNull` and a
   boolean literal kind, with a regression assertion over the eleven existing kinds.
5. **NEW-4** — move the two grant parameters out of `COHORT_CELL_CARDINALITIES`, or record
   the plan 1289/1291 narrowing as an explicit registry edit.
6. **2b** — add the fifth preflight check and escalate the `bin/stage-live-campaign.ts`
   campaign-root mode question to an owner.
7. **NEW-5** — fix the `bin/` path segment and the plan-2853 citation.

---
---

# Revision 2 review (superseded — condensed for the record)

Revision 2 is a serious document. Every one of the fourteen revision-1 findings was
independently re-verified before being acted on, the citations are real this time (I spot
checked ten of them and nine were exact to the line), and the three failures of nerve in
revision 1 — the invented Mac channel, the invented "no reduced rung", the deferred nesting
fix — are all closed by construction rather than by wording. **Twelve of fourteen findings
are CLOSED.**

It is still rejected, on one new blocking defect and four open items. The new defect is the
same species as before, found one layer deeper: §2.9 correctly moves the Mac key onto a
descriptor, and then hands the descriptor to a process that the plan forbids from reading
the key.

## Verdict drivers

- **N1 BLOCKING** — §2.9(4)'s Mac signing-key descriptor cannot be opened by the process
  that opens it.
- **N2 MUST-FIX** — S3 is given two Phase-A Mac key sets with no table to put them in and no
  field kind that can express them.
- **F5 OPEN** — S2 lands in wave 1 and leaves the suite red until S4 lands in wave 2; its own
  gate 2 is unsatisfiable.
- **F8 OPEN** — §2.11 splits one codec across waves 1 and 2, so gate 8's conformance vector
  cannot exist when S2 reports done.
- **N3 MUST-FIX** — the chat-1k grant parameters the timing budget rests on are chosen, not
  frozen, and the §9.6 pilot cell is not chat 1k.

---

## Disposition of the fourteen revision-1 findings

### 1 — Mac signer is a TS class in the controller process → **CLOSED** (superseded by N1)

Option (b) is taken and §2.9 is real work, not a restatement. The decisive question was
whether the Mac binary can *see* the rig records §2.9(2) says it verifies before minting the
barrier. It can: `mac-issue-start-barrier-request/v1`'s frozen key set already carries them —
`cross-supervisor-protocol.ts:2002-2009`:

```
rigWarmupDrainedReceiptBase64 / rigWarmupDrainedReceiptSignatureBase64
rigMeasureStartAckBase64      / rigMeasureStartAckSignatureBase64
```

so the barrier row's "both verify against the staged rig public key" is implementable against
frozen bytes, and the five forgery tests in §2.9(5) become genuinely mutation-provable once
verifier and forger are different processes. That is the property revision 1 could not have.

**One overstatement to correct.** §2.9(2)'s last row says
`mac-present-rig-observation-request/v1` lets the binary verify "the whole rig graph —
execution acceptance, cohort acceptance, drained receipt, measure-start ack, barrier
acceptance, snapshot receipt, relay observation receipt". Plan 697-715 carries only **five**
of those seven: execution acceptance, measure-start ack, barrier acceptance, snapshot
receipt, relay observation receipt (plus the two child records). `rig-cohort-acceptance/v1`
and `rig-warmup-drained-receipt/v1` are **not** in that frame. They are recoverable — the
session retained them from `mac-present-rig-cohort-acceptance-request/v1` and
`mac-issue-start-barrier-request/v1` — but only if it is the *same* `MacCohortSession`.
**Change:** state that two of the seven come from retained session state, and add the
invariant that a Mac supervisor restart between barrier and observation must refuse rather
than admit on five of seven.

### 2 — teardown registry edit → **CLOSED for the rig frames** (new N2 for the Mac frames)

§2.10 item 1's key sets are verbatim from plan 922-935:
`RigTeardownServerRequestV1 {requestSeq, executionSha256}`;
`RigServerStoppedAckV1 {responseSeq, ackRequestSeq, executionSha256, exitCode: number|null, signal: string|null, reaped: true}`.
Membership targets are right: `PHASE_A_RIG_REMOTE_SCHEMAS` (`:2457-2464`, six members),
`PHASE_A_RIG_FIELDS` (`:2585-2602`), `PhaseARigRemotePayloadV1` (`:2677-2684`, six arms),
`parsePhaseARigRemotePayload` (`:2685`). The Phase-A rig spec union already has the kinds the
two frames need (`sha256OrNull`, `base64OrNull` and friends at `:2484`+), so `exitCode` /
`signal` are expressible there. Sender ownership is named (S8, `remote-supervisor.ts`, after
`stopAndCapture` `:5542`) and is a different slice from the codec owner (S3) — correct under
the single-owner rule, since S8 consumes a codec it does not edit.

**The `server-capture-ack/v1` base64 edit is legitimate and correctly attributed.** The plan
freezes the nested shape at 1108-1114, so this is a real §3.4 registry edit; the plan admits
recorded registry edits by precedent (`child-pipe-protocol.ts:314`+ records
`cohortGrantSignatureBase64` as one), the owner is named (S1's key set, S3's matching
`rig-capture-complete-ack/v1` shape), and the edit makes two adjacent frames agree rather
than transcode — `rig-capture-complete-ack/v1` already carries `snapshotFrameBase64` and
`linuxRelayObservationBase64` (`:2592-2601`). Approved.

### 3 — six cells, not three → **CLOSED**

`evidence.ts:152-160` and `cohort-protocol.ts:5246-5299` confirm the six-cell table and the
`chat 1k` row (10 / 8 / 1,000 / 1,010 / 300 / 300,000); plan 2149 carries the same row.

### 4 — the rung is unreachable by measurement → **CLOSED**

S0's delivery probe is deleted, the FULL/SHORT branch with it, and the measurement is used
correctly (195,387 deliveries/s bound; ticker 10k needs 1,000,000/s). I re-derived the
warmup load the design did not state: plan 1422 gives chat 1k a warmup of
`125 × 10 × 10 = 12,500` records per worker × 8 = 100,000 deliveries in 5 s = **20,000/s**,
still ~10× under the bound. The rung choice survives its own warmup, which is the one place
it could have failed.

### 5 — shard fixtures and the missing positional checks → **CLOSED on substance, OPEN on the gate**

The substance is right and the ruling is now argued from the strongest evidence
(`shard_total == subscriber_count`, `secure_fs.rs:12558`/`:12571`, vacuous under the TS
reading). Items 2 and 3 correctly move the positional and eight-entry checks to
`parseCohortGrant`, matching `secure_fs.rs:12540`/`:12553-12555`. S2 now owns
`cohort-protocol.test.ts`, `fanout-promotion.test.ts` and `crates/native/tests/cohort_protocol.rs`.

**OPEN.** §4's S2/S4 note assigns the `fanout-supervisor-integration.test.ts:210` fixture to
S4 in **wave 2**, while S2's rule lands in **wave 1**. Between them the suite is red, so S2's
own gate 2 (`bun test tools/compare/` → 0 fail) is unsatisfiable and the slice cannot report
done. Calling it "a two-line edit, not shared ownership" describes the diff, not the gate.
**Exact change:** either move S2 into wave 2 alongside S4, or give S2 a carve-out that names
the one file and the one line permitted to be red at S2's boundary, with S4's landing as the
condition that closes it. Do not leave gate 2 stated absolutely and violated by design.

Two citation gaps worth one line: `crates/native/src/bin/comparison-supervisor.rs:2885` and
`:3473` also carry shard fixtures. Both are reading-agnostic today and both sit in S5-RIG's
file, so nothing breaks — but §2.3's survey lists only `rig_cohort_runtime.rs:113` and
`fanout_supervisor.rs:129` and should list these too.

### 6 — F3 undercount → **CLOSED**

§2.12's table is exact against `child-pipe-protocol.ts`: `parseChildPipeRefusal` (`:220`),
`parseServerBindExecution` (`:354`), `buildServerWarmupReady` (`:415`),
`parseServerWarmupReady` (`:439`); 18 entries at `:295-314`; one schema with both halves,
two with a parser only, twelve with neither; 14 schemas / 26 bodies. S1 re-scoped accordingly.

### 7 — `createFanoutLinuxAuthority` does not exist → **CLOSED**

Verified: `export class FanoutLinuxAuthority` at `scenarios/fanout-relay.ts:2422`,
`constructor(config: FanoutLinuxAuthorityConfig)` at `:2443`. S4 now owns
`fanout-supervisor-integration.test.ts`, the only consumer of the config type outside the
module.

### 8 — `RigMeasureStartAckV1` key set → **CLOSED on substance, OPEN on ownership**

The plan-defect argument is correct (plan 876-883's `rigMeasureStartAckBase64` proves the
inner receipt cannot carry frame envelope fields), and all three residual fields are decided
with reasons. `cohort-start-barrier/v1` does bind `rigMeasureStartAckSha256`
(`cohort-protocol.ts:743`, `:1599`, `:1638`, `:1663`), so the escalation was right.

**OPEN.** §2.11 assigns the three Rust fields to **S5-RIG (wave 2)** and the barrier-side
check to **S2 (wave 1)**, "with a hex vector across the boundary". A vector pinned on the
Rust side cannot exist while S2 is the slice reporting done, so gate 8 ("a codec change with
no conformance vector is not done") is unsatisfiable for S2. **Exact change:** give the whole
of §2.11 — both halves and the vector — to S5-RIG, and have S2 consume the published vector
the way S4 consumes S2's.

### 9 — per-assertion reachability → **CLOSED, with one wording fix (see N3)**

§3.4's walk is the right artifact and the slice attributions check out. §2.2(c)'s correction
on `admissionCounters` is the honest kind: revision 1 named a frame with no codec, revision 2
says so, falls back to the in-process counter, and books the gap as residual 1.

### 10-14 — **CLOSED**

F1 wording corrected; §2.8 keeps the gate and cites `secure_fs.rs:16106-16110`; §2.6
unchanged and still correct in both halves; gate item 7 corrected (verified: 38 of 112
`tools/compare` `.ts` files sit outside the 75 classified entries, all tests); §1.3 takes the
base64 fix rather than pinning the divergence class.

---

## New findings

### N1 — BLOCKING — the Mac signing-key descriptor is opened by a process the plan forbids to read it

§2.9(4) plumbs `--cohort-mac-signing-key-fd` as
`localPaths.macSigningKeyFile: ${stagedDir}/mac-supervisor-ed25519.key`, opened by
`buildRigSupervisorWrapperScript`'s `exec N<…` form, "the same mechanism the rig's four use".
Three things are wrong, and the third is fatal:

1. **Wrong path.** Plan §3.1 (bullet 3) fixes the Mac private key at
   `/var/db/webtransport-bun/comparison/keys/<candidate>/<campaignId>.mac.pk8`, mode `0400`,
   owner `_wtcompare`, group `staff`. It is not a staging-root leaf.
2. **Wrong directory.** Plan §3.1 (bullet 4): "The raw 32-byte **public** keys are cross-staged
   as `staging-root/mac-supervisor-ed25519.pub` and `staging-root/rig-supervisor-ed25519.pub`."
   `staging-root` holds public halves only. There is no `.key` leaf there to open.
3. **Fatal: the opener cannot read it.** Plan §3.1: "**The Mac controller account must fail
   `test -r` on the Mac key**", and "the controller never reads either private key".
   `spawnMacSupervisor` launches the wrapper with `nodeSpawn("bash", [scriptPath], …)`
   (`remote-supervisor.ts:~843`) — no `sudo`, no uid change — so the wrapper runs as the
   controller's own uid and its `exec 7</…mac.pk8` must fail by design. **The mechanism is
   not "the same as the rig's": the rig's wrapper runs over SSH as a different account on a
   different host, and the Mac has no such separation today.**

This is exactly the round-one/two failure mode one layer deeper: the key is correctly moved
off the controller's heap and then handed over by a path the controller must not be able to
open. **Exact change:** §2.9(4) must name the mechanism that crosses the uid boundary and
scope it — `sudo -n -u _wtcompare` in the wrapper (a privilege boundary nobody has scoped, and
a launcher change), or a setgid/ACL arrangement, or an explicit statement that the local e2e
runs as `_wtcompare` and §3.1's topology says so. Until one is chosen, S5-MAC-RS, S9's
descriptor plumbing, and §3.3 assertions 3 and 5 are all unimplementable, and mandate
assertion 3's Mac half is unreachable — the same conclusion as revision 1, reached by a
different route.

### N2 — MUST-FIX — S3's two Phase-A Mac key sets have no table and no expressible field kinds

§2.10 gives S3 "the `mac-present-rig-observation-request/v1` and
`mac-measurement-admission-issued-ack/v1` key sets from plan 697-725". Verified at HEAD:

- Both schemas exist as **names only**, at `cross-supervisor-protocol.ts:1772-1773`.
- There is **no Phase-A Mac field table**. The only `_FIELDS` tables are `COHORT_REMOTE_FIELDS`
  (keyed by `CohortRemoteSchema`) and `PHASE_A_RIG_FIELDS` (keyed by `PhaseARigRemoteSchema`).
  `PHASE_A_MAC_*` does not exist — §2.9(6) says so itself, then §2.10 assigns the work anyway.
- `CohortRemoteFieldKind` (`:1899-1905`) is exactly `seq | sha256 | base64 | byteSize | count |
  literalTrue` — **no nullable kind**. Plan 705-714 gives
  `mac-present-rig-observation-request/v1` **six** `Base64 | null` fields, so it cannot be
  expressed in that table at all.

**Exact change:** name the table S3 creates (a `PHASE_A_MAC_FIELDS` in the Phase-A rig spec
style, whose union already carries `base64OrNull`), state that creating it is part of S3's
scope, and re-estimate S3 — 500-700 src lines does not cover a new table plus a new parser
plus two frames plus three hex vectors.

### N3 — MUST-FIX — the chat-1k timing budget rests on grant parameters that are chosen, not frozen, and the pilot cell is not chat 1k

§3.2 states "**Exact topology** (`cohort-protocol.ts:5274-5281`): … `messageBytes: 128`;
`readinessDeadlineMs: 90,000` (plan 1424); `measuredDurationMs: 30,000` with `windowCount: 30`."

- `readinessDeadlineMs: 90,000` is correct and frozen (plan 1424, chat 1k).
- `messageBytes` and `measuredDurationMs` are **not** at `:5274-5281` — that range is the
  cardinality row (cell / pubs / workers / subs / sessions / ingress / deliveries) and
  contains neither. Both are open unions on the grant: `measuredDurationMs: 10000 | 30000`
  and `messageBytes: 100 | 128` (`cohort-protocol.ts:681`, `:683`; plan 1289, 1291), and the
  plan pins neither per cell. At `measuredDurationMs: 10000` the budget loses 20 s per
  execution and the delivery rate becomes 30,000/s — still 6.5× under the bound, so the rung
  survives either way, but the 67 s / 155 s / 900 s numbers do not.
- **The pilot cell is ticker-10k, not chat 1k.** Plan §9.6 line 3511 fixes the B5 pilot as
  `CELLS=ticker-fanout/rate-10000` with `EXPECTED_PASS=2`. Mandate assertion 4 —
  `the_index_is_the_pilot_shape` — asserted at chat 1k proves the *index machinery*, not the
  plan's pilot.

**Exact change:** present `measuredDurationMs`/`messageBytes` as chosen grant parameters,
name the slice that chooses them (nothing currently does), and state in §3.3/§3.4 that the
local e2e at chat 1k proves the machinery while §9.6's ticker-10k pilot remains a rig-only
gate. Otherwise round four rediscovers that "pilot shape" was asserted against a cell the
pilot does not run.

### N4 — NOTE — the e2e timeout claim is inverted

§3.2: "The e2e file's timeout is set to **900,000 ms** and each `it` that drives a full
execution to **240,000 ms**." `PROCESS_TEST_TIMEOUT_MS = 900_000`
(`fanout-production-e2e.test.ts:163`) is already the **per-test** value, passed as the third
argument to every `it` (e.g. `:392`). Setting execution tests to 240,000 would *lower* the
existing timeout below the 155 s worst case plus cold Rust build. Gate 2's
`bun test --timeout 30000` is not in conflict: per-test third-argument timeouts override the
CLI default, which is why this file passes today. **Change:** keep `PROCESS_TEST_TIMEOUT_MS`
for execution-driving tests and drop the 240,000 figure.

### N5 — NOTE — two small overcounts in §1.2

"the fourteen cohort mac/rig schemas in `COHORT_REMOTE_PAYLOAD_SCHEMAS` (`:1788-1823`)" —
that constant has **22** members (14 mac + 8 rig). And §2.9(3)'s citation list is exact at
nine of ten sites; `:4255` is a doc comment, not `exportCohortEvidence`. Neither changes a
conclusion; both should be corrected because this document's authority rests on its citations.

---

## Finding 6 answer: what option (a) costs, in plan terms

The coordinator asked for this precisely, so here it is with the plan's own words. Option (a)
is "declare `MacFanoutSupervisor` — a class inside the controller process holding
`macKeys.privatePkcs8Der` (`remote-supervisor.ts:2678`, `:2818`) — the Mac signer of record."
It removes S5-MAC-RS and most of S8, ~5,500-7,000 lines. It costs four things, and only the
first is what §4 currently names:

1. **Mandate assertion 3's Mac half** — as §4 says.
2. **Plan line 234, violated directly:** "The controller is an untrusted byte courier and
   **cannot mint, rewrite, substitute, or authenticate either issuer's records**." Under (a)
   the controller process mints one of the two issuers' records at will. This is not a
   weakening of "the ruling's symmetry"; it is a frozen Phase-A trust contract with the
   opposite content.
3. **Plan §3.1 bullet 3, violated directly:** "**the controller never reads either private
   key**", and "The Mac controller account must fail `test -r` on the Mac key." Under (a) the
   controller process holds the key bytes in its own heap.
4. **Plan §3.1 bullet 2, made vacuous:** "**Mac authenticates every applicable rig record
   before final admission**; the offline verifier repeats all checks." Under (a) the
   authenticator and the signer of the admission are the same process, so the Mac admission
   receipt attests that *the controller concluded* the rig graph verified — not that a second
   issuer independently did. The offline verifier still repeats the checks, so the evidence is
   not worthless; what is lost is the **independence** of the second issuer, which is the only
   thing bidirectional Ed25519 buys over one-way signing. All five §2.9(5) forgery tests
   become untestable, because verifier and forger are one process — which is precisely why
   §2.9(5) is the right way to state the property.

So the maintainer's trade is: ~5,500-7,000 lines against three frozen plan clauses and the
independence of the second issuer. Option (a) is defensible only as an explicitly recorded
deviation from plan §3.1 and line 234, not as a scoping choice — and, given N1, option (b) is
not free either: it needs a uid boundary nobody has scoped.

---

## Assessment of the estimate

12,500-16,000 src / 10,600-13,700 test, on a 2.75× calibration against rounds one and two
(10,900 and 6,300 against ~3,000). The calibration method is sound and the honesty is
welcome. One anchor the document does not give: `cohort::rig` begins at
`crates/native/src/secure_fs.rs:14721` and runs to roughly `:16300`, so the module
S5-MAC-RS mirrors is ~1,600-1,900 lines. Estimating a new `cohort::mac` at 3,000-3,800 src is
~2× its sibling — defensible given eight transitions against the rig's six, four descriptor
installs, token minting and Merkle recomputation, but it is the least constrained number in
the table and should be flagged as such. N2 pushes S3 up. **This is a program, not a slice**
is the correct conclusion and should be the headline the maintainer sees.

---

## Open items, in the order they block work

1. **N1** — decide the Mac signing-key uid boundary; until then S5-MAC-RS, S9 and assertions
   3/5 are unimplementable.
2. **N2** — name and scope the Phase-A Mac field table; re-estimate S3.
3. **F5** — resolve S2's wave-1 gate-2 violation against S4's wave-2 fixture fix.
4. **F8** — move all of §2.11 to S5-RIG so the conformance vector exists when its owner
   reports done.
5. **N3** — pin `measuredDurationMs`/`messageBytes` as chosen parameters with an owner, and
   state the chat-1k / ticker-10k pilot distinction in §3.3 and §3.4.
6. **Finding 1 residue** — state that two of the seven rig records come from retained
   `MacCohortSession` state, and add the restart-refuses invariant.
7. **N4, N5** — correct the timeout description and the two overcounts.

---
---

# Revision 1 review (superseded — condensed for the record)

Verdict was CHANGES REQUIRED on four blocking and five must-fix findings. Retained here in
one line each; the full evidence for each is reproduced in the revision-2 dispositions above.

1. **BLOCKING** — Mac signer was `MacFanoutSupervisor`, a TS class in the controller process
   (`remote-supervisor.ts:2818`, `:2918`); no Rust `mac-*` dispatch arm; no TS sender;
   `spawnMacSupervisor` passed four bootstrap FDs and no key. → closed by §2.9, superseded by N1.
2. **BLOCKING** — `rig-teardown-server-request/v1` / `rig-server-stopped-ack/v1` existed only
   as names at `cross-supervisor-protocol.ts:1784-1785`; "no §3.3 registry edit required" was
   false; the file was owned by no slice. → closed by §2.10.
3. **BLOCKING** — "no legal reduced rung" was false: `evidence.ts:152-160` admits six cells;
   `chat 1k` is a frozen 33× reduction. → closed by §3.2.
4. **BLOCKING (measured)** — raw Bun WS fanout upper bound 195,387 deliveries/s against the
   rung's required 1,000,000/s; only 1,954 of 10,000 ingress/s offered. → closed by §3.2.
5. **MUST-FIX** — shard-bound change broke three unowned fixtures; positional and eight-entry
   checks missing. → closed on substance; gate ordering still OPEN.
6. **MUST-FIX** — F3 undercount: 12 schemas with neither half, not ten. → closed by §2.12.
7. **MUST-FIX** — `createFanoutLinuxAuthority` does not exist; S4's deletion broke an unowned
   5,600-line test file. → closed by §2.1 and S4's ownership.
8. **MUST-FIX** — `RigMeasureStartAckV1` mostly resolvable from plan 876-883. → closed by
   §2.11; ownership split still OPEN.
9. **MUST-FIX** — per-assertion reachability unstated. → closed by §3.4.
10. **NOTE** — F1 overstated (nothing sends the teardown frame). → corrected.
11. **NOTE** — F2/§2.8 sound; keep the gate, cite `secure_fs.rs:16106-16110`. → adopted.
12. **NOTE** — §2.6 correct in both halves. → unchanged.
13. **NOTE** — new `.test.ts` files need no allowlist line. → gate item 7 corrected.
14. **NOTE** — take the base64 fix rather than pinning the divergence class. → adopted.
