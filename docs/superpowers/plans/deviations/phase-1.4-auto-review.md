# Phase 1.4 — Auto-review (F1–F5)

**Date:** 2026-08-29
**Branch:** `codex/ws-scenario-comparison`
**Plan:** `docs/superpowers/plans/2026-08-28-ws-wt-real-number.md` §Phase 1.4
**Baseline:** Phase 1.1–1.3 twelve commits (`8c04e1d0` … `0d695236` / `2ee9e2cd`)

## Verdict: NO_FINDINGS

The F1–F5 auto-review of the capability / lock / manifest reservations
surfaces **no structural F-class gaps** that require a fix commit. The
toolchain precedent gap (`bunVersion` / `bunRevision` /
`bunExecutableSha256` missing from `CHILD_FORBIDDEN_OBSERVATION_FIELDS`)
does **not** recur here: every host-vocabulary field for capability,
lock, and manifest was on the forbidden list from each reservation's
Commit *.1 (Forbid), and the per-sub-phase Commit *.4 F-class tests
already codify that finding.

Zero auto-review fix commits. Phase 1 gate remains green.

## Precedent-gap matrix

| Reservation | Host fields (`Observed*HostFacts`) | On `CHILD_FORBIDDEN_OBSERVATION_FIELDS`? |
|---|---|---|
| capability | `capability`, `capabilityVersion`, `capabilities`, `capabilityDigestSha256` | all present (`supervisor-protocol.ts`) |
| lock | `lock`, `lockVersion`, `locks`, `lockDigestSha256` | all present |
| manifest | `manifest`, `manifestVersion`, `manifests`, `manifestDigestSha256` | all present |

`platform` is shared join vocabulary (same as toolchain) and is
intentionally not forbidden.

Artifact / binding aliases (`capabilitySha256`, `supervisor*Digests`,
etc.) are accepted by the child boundary the same way toolchain
aliases (`toolchainSha256`, `supervisorToolchainDigests`) were left
unbanned by commit `42d9fff8` — they are not `Observed*HostFacts`
fields and do not feed `validateObserved*Facts`.

## F1–F5 checklist

| Class | Result | Notes |
|---|---|---|
| F1 Forbid+validate | PASS | Child smuggling refused; supervisor provenance + field validation live |
| F2 Atomic two-host | PASS | Missing host → `TRUST_OBSERVATION_OMITTED`; set validators exist |
| F3 Retire child / F4 binding | PASS | `assertMeasuredArmObservedIts{Capability,Lock,Manifest}` on `buildRunArtifact` |
| F4 Per-field ban | PASS | Umbrella + all per-host field names forbidden |
| F5 Hardening mirror | PASS | F-class describes in `r1-trust-validators.test.ts` refuse wrapped/unwrapped/alongside/falsy; absence accepted |

## Test-completeness nit (not a finding)

F-class tests exercise `false` on `*Version` but not on every umbrella
key. Mechanism is `field in observation`, so any present forbidden key
is refused regardless of value. No fix commit.

## Gate

- `bunx tsc -p tsconfig.json --noEmit` clean
- `bun scripts/verify-r1-fixture-hashes.ts` → CLEAN
- `bun scripts/verify-r1-document-hashes.ts` → CLEAN
- `bun test tools/compare/` → 766 pass / 0 fail (post Phase 2.4)

## Commits

None. Per plan: "the auto-review commit count is not fixed in
advance"; a zero-commit auto-review is a valid outcome when the review
surfaces no findings. This file is the no-findings report.
