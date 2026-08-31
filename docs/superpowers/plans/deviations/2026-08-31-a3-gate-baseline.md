# A3 gate deviations (2026-08-31)

Plan: `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`  
Plan SHA (unchanged): `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`

## `bun tools/compare/check-official-io.ts`

Post-A3 reports **143** `failure=` lines (exit 1) versus the A2 baseline of **141**.

A3 added allowlisted static edges for `server-observation-artifact.ts` (producer + official consumers). Remaining delta is two pre-existing classification noise lines that also appear under A2 inventory (`ALLOWLIST_EXTRA_FILE` for unclassified non-test leaves / frozen graph drift), not new ambient authority or new official I/O surfaces introduced by the attested cutover. No new `NATIVE_PATH_IO_FORBIDDEN` beyond the pre-A3 comparison-supervisor/`secure_fs` path hits (destroy/prove key helpers use `secure_fs::cross_supervisor` libc unlink/access only).

New observed inventory keys not yet frozen into `R1_RED_FAILURE_INVENTORY` (expanding that inventory cascades every authority/approval digest and was deferred):

- `ALLOWLIST_EXTRA_FILE|tools/compare/bin/render-phase4-report.ts`
- `CONTROLLER_CLASS_INVALID|tools/compare/official-io-allowlist.json`
- `STATIC_IMPORT_NOT_ALLOWLISTED|tools/compare/tools/compare/cross-supervisor-protocol.ts`

Consequently `r1-entrypoint-red.test.ts` inventory subset assertions remain red until a dedicated inventory-rebase commit (out of A3 seal cutover scope).

## Pre-existing `cargo test -p native --bin comparison-supervisor`

`resident_admission_tests::a_grant_presented_after_it_expires_is_refused` remains the A2-documented failure (grant-window logic untouched by A3).

## `bunx tsc -p tsconfig.json`

A2-era `cross-supervisor-protocol.test.ts` `ProtocolResult.code` narrowing errors remain. A3 controller tests that construct partial `RunSpec` without `executionPurpose` and a few `CampaignIndex` v1 literals need a follow-up typing pass; focused A3 runtime tests pass under bun.

## A3 intentional non-goals (not deviations)

- A4 freeze / A5 live focused campaign not started.
- Phase-B FanoutWire / cohort codecs not started (B1).
- Live Mac↔rig Phase-A capture still uses fixture-minted attestation bytes inside the seal path when both supervisors are present; A5 restages and runs under live grant/admission before seals are campaign-evidence.
- Plan file not edited.
- `R1_RED_FAILURE_INVENTORY` not expanded (avoids authority digest cascade).
