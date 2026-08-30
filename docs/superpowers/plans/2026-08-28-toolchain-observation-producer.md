# Plan — a producer for the toolchain evidence `1992af77` made mandatory

Status: **awaiting approval.** No code written.

## What is broken

`1992af77` made `ArmMeasurement.toolchains` required and had
`assertMeasuredArmObservedItsToolchain` (`artifact-builder.ts:243`) refuse a measured arm
unless all three of `{js, darwin, linux}` are observed. Nothing produces that value.
`observeLocalToolchain()` has no caller anywhere in production — only three comments name
`toolchain-observation.ts`. So today the campaign cannot assemble a measured arm at all.

Two things stand between here and a producer, and only the first is mechanical.

## Finding 1 — a driver cannot produce this, by construction

A driver process runs on **one** host. `observeLocalToolchain()` reads `process.versions.bun`,
the platform token and a hash of the running executable; `observeNativeAddon(platform)` reads
one platform's addon. From the Mac controller there is no honest way to fill `linux`, and the
guard refuses the whole set if any entry is `UNOBSERVED_TOOLCHAIN`. The missing piece is
therefore a **join across two hosts**, not a function call.

## Finding 2 — the committed docstring conflicts with the trust machinery ⚠️

`run-campaign.ts:356` says the toolchains are *"Stated by whoever measured, because they are
the ones on the host."* That is **child-reported** evidence. The existing trust machinery in
`supervisor-protocol.ts` rules the opposite for facts of exactly this class:

- `ObservationProvenance = "supervisor-measured" | "echo-of-plan" | "child-reported"`, and
  `observationProvenanceIssue` **rejects everything except `supervisor-measured`**. Its own
  comment: *"provenance travels with the facts and an echo is rejected structurally rather
  than detected by comparison."*
- `CHILD_FORBIDDEN_OBSERVATION_FIELDS` lists `uname` — the child may not state host identity.
  A Bun version, a platform token and an executable digest are the same class of fact.

The toolchain is not decoration: it gates promotion. A child stating its own toolchain is
self-attestation, which is the precise defect R1 exists to remove — *"any guard the producing
process can call, it can satisfy."* So the docstring's stance should not survive.

**This is a question for the maintainer, not for me to settle silently.** Option (a) treat the
toolchain as supervisor-measured evidence, consistent with every other host fact; option (b)
keep it child-stated and accept that the promotion gate is self-attested. I recommend (a), and
the next finding says (a) is the cheaper one anyway.

## Finding 3 — the frozen bundle already reserves the shape, so this likely needs no RED cycle

The standing rule is that a frozen edit means a round-9 RED cycle, and that I stop and report
rather than start one. I do not think this triggers it:

- `r1-fixtures.ts:4987` and `:5046` already carry `host-runtime-facts/v1` records, each with a
  `toolchain` sub-record (`bunVersion`, `bunExecutableSha256`, …).
- `r1-fixtures.ts:5117` already carries **`host-runtime-facts-set/v1`** — the two-host join
  already has a reserved schema.
- `validateHostRuntimeFactsV1` already exists in production (`secure-fs.ts:939`) and is
  already asserted by the frozen `r1-authority-red.test.ts` (`:1511`, `:1629`).
- `r1-fixtures.ts:3723` already exposes a toolchain set *"for tests that need a measured arm
  to be buildable."*

So the schema, the validator, the fixtures and the frozen assertions all exist. What is
missing is the producer and the wiring — which is what `toolchain-observation.ts`'s own
docstring says: the full record *"exists as a schema, a validator and a set of fixtures"* with
*"nothing produces that record."* **To be confirmed in phase 0, not assumed.**

## Phases

Each phase ends green (tsc 0, `bun test tools/compare`, both frozen verifiers CLEAN, the
official-I/O audit inventory still matching its pinned reservation) and is committed
separately.

**Phase 0 — freeze probe (no product code).** Prove Finding 3 by executing it: add a
throwaway assertion that builds a `host-runtime-facts-set/v1` from the reserved fixtures and
runs `validateHostRuntimeFactsV1` over it, then confirm both frozen verifiers stay CLEAN and
no `r1-*-red.test.ts` moves. **If any frozen file must change, stop and report** — that is a
round-9 event and not mine to open. Deliverable: a go/no-go, and the throwaway deleted.

**Phase 1 — per-host observation on the supervisor side.** Give the supervisor a
toolchain observation carrying `provenance: "supervisor-measured"`, reusing the
`ObservedPathFacts` pattern (every field optional so omission is a typed failure) and the
per-host receipt shape `validateSupervisorPhysicalReceipts` already uses for mac/linux.
Add `toolchain` to `CHILD_FORBIDDEN_OBSERVATION_FIELDS` so a child stating one is refused
structurally. Files: `supervisor-protocol.ts`, `comparison-supervisor.rs`, + tests.

**Phase 2 — the join, and the frame that carries it.** The supervisor on each host observes
its own; the set is assembled where the admission receipt is already assembled, so the
toolchain rides the channel that is already trusted rather than a new one. Decide there
whether it belongs *inside* the admission receipt (one signed fact) or beside it. Files:
`supervisor-client.ts`, `comparison-supervisor.rs`, `evidence.ts`.

**Phase 3 — retire the child-stated path.** Change `run-campaign.ts:356`'s docstring and the
`ArmMeasurement.toolchains` source to the supervisor-observed set, and add a test that a
child-stated toolchain is refused. This is where Finding 2 actually lands.

**Phase 4 — `executableSha256`.** Still deferred by the maintainer; listed so it is not
forgotten, not scheduled.

## What I need before starting

1. Finding 2: **(a) supervisor-measured** — my recommendation — or (b) keep it child-stated.
2. Confirmation that phase 0's stop condition is right: if a frozen file must move, I stop and
   report rather than opening round 9.
