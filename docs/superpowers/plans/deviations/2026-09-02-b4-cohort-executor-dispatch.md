# Deviation — B4 cohort executor had no production dispatch

**Date:** 2026-09-02
**Candidate:** `1622c363…` (B5 exact-stage Critic finding, pre-pilot)
**Plan:** unchanged — `2026-08-30-busyMs-attested-fanout.md`, B4 line 2457
item (b), §5 (2153-2211), §6 (2212-2282), §9.6 (3503-3524)

## Discovery

B4's line item (b) says "Switch only the six primary fanout cells to the cohort
executor". The executor was built and the old path was severed, but nothing was
switched: production never reached the executor.

Verified in the non-test tree at `1622c363`:

- `realRun` → `realRunBody` minted `mintPhaseAAttestationFixture` for **every**
  scheduled arm and called `measureSealAndWriteRep` unconditionally
  (`compare-controller.ts` ~2901-2935 at that commit).
- `measureSealAndWriteRep` → `measureLegOverAdapter` states `armKind`, and
  `client.ts:~546-552` throws `CohortExecutorRequiredError` for a fanout primary
  **before connect**. So the six primaries could not be measured at all.
- `rg -n --glob '!*.test.ts' 'driveCohortArm\('` returned **zero** production
  callers; only `fanout-executor.test.ts` drove it.
- `MacFanoutSupervisor` had no production reference either
  (`compare-controller.ts:102` imported it `type`-only).
- A comment at ~1857-1860 claimed "`measureArmRep` routes them to the cohort
  executor". No `measureArmRep` exists anywhere in the tree — the routing it
  named was never written.

The severance plus the missing dispatch is why the B5 pilot could not start: the
only reachable executor for `ticker-fanout/rate-10000` primary was the one that
refuses fanout primaries.

## Resolution

One dispatch seam, in `tools/compare/bin/compare-controller.ts`:

```ts
export async function dispatchArmRepetition(input: {
  readonly arm: Parameters<typeof measureSealAndWriteRep>[0];
  readonly cohortRuntime?: CohortArmRuntimeProvider;
  readonly executors?: {
    readonly measureSealAndWriteRep?: typeof measureSealAndWriteRep;
    readonly driveCohortArm?: typeof driveCohortArm;
  };
}): Promise<ArmRepetitionDispatch>
```

- The router is `cohortCellForArm` from `evidence.ts` — the same frozen six-cell
  map the builder, the verifier, the index, the renderer and the promotion
  selector ask. No second list was added.
- Cohort route → `driveCohortArm` (the default executor, i.e. a real production
  caller) with the runtime's supervisor, binding, bundles, warmup epoch, start
  barrier, clock and validity, then the runtime's `seal` over the terminal
  `CohortArmEvidence`.
- Leg route → the existing `measureSealAndWriteRep`, unchanged.
- A fanout primary is **never** demoted to a leg. With no runtime available it
  is refused with `COHORT_NOT_READY`; every supervisor/rig refusal is forced
  onto §7's closed `CAMPAIGN_FAILURE_CODES` set by `closedCohortFailureCode`,
  and the index entry now records that code instead of a blanket
  `TRUST_PROTOCOL`.
- The unsealed out-of-process fallback asks the same router and refuses a fanout
  primary there too, so the fallback cannot become the way a cohort arm gets
  measured as one session.
- §6 scheduling is untouched and holds for both routes: the seam runs inside the
  existing `armRepetitionSchedule(purpose)` loop, so focused/pilot stay
  1 unsealed warmup + 1 measured and canonical stays 1 + 5, and the warmup is
  still neither sealed nor indexed on either route.
- The phantom `measureArmRep` comment now names `dispatchArmRepetition`.
- `MacFanoutSupervisor` stays a **type-only** import: production supplies the
  supervisor through `CohortArmRuntime`; the controller does not construct one,
  which is the property that keeps it a courier.

## Not done, and why

`cohortRuntimeProvider` in `realRunBody` is `undefined`. Supplying a real one
needs a `CohortRigBinding` over the rig control channel, and no such binding
exists: the Linux cohort peer in `server.ts` (~673) is still reachable only from
B3's *non-production integration entrypoint*, and `FanoutLinuxAuthority` does
not implement `registerRolePeers`, `runWarmupWire`, `measureStartAck` or
`runMeasuredWindow`. Building that binding, and the cohort-evidence→`MeasuredLeg`
sealer it feeds, is the remaining B4 work; it is now one named, typed hole
behind the seam instead of a missing route, and a fanout primary refuses with a
closed code rather than throwing mid-campaign against a live rig.

**B5 is therefore still blocked**, but on a stated gap rather than an unreachable
executor.
