# A2 gate deviations (2026-08-31)

Plan: `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md`  
Plan SHA (unchanged): `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`

## Pre-existing `cargo test -p native --bin comparison-supervisor`

`resident_admission_tests::a_grant_presented_after_it_expires_is_refused` fails on this worktree **before and after** A2: admission of `not_after_ms + 1.0` returns `Ok(())` instead of `OutsideGrantWindow`. A2 did not touch `secure_fs::measurement` grant-window logic. Left unfixed to keep A2 protocol-only.

## Pre-existing `bun tools/compare/check-official-io.ts`

Baseline (pre-A2 stash) and post-A2 both report **141** `failure=` lines / `status=FAIL` / exit 1. A2 adds no new `ALLOWLIST_EXTRA_FILE` for the new protocol modules and no new `NATIVE_PATH_IO_FORBIDDEN` beyond the pre-existing comparison-supervisor/`secure_fs` path hits. Durable O_CREAT|O_EXCL replay FS proof lives in the integration test target (not ambient `std::fs` inside sealed `secure_fs`); keygen writes via `libc` open/write/fsync.

## A2 intentional non-goals (not deviations)

- No production controller/seal/campaign path calls the new codecs (A3 cutover).
- No Phase-B FanoutWire codecs (B1).
- Plan file not edited.
