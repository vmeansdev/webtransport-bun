# Deviation — measurement grant expiry is a hard bound

**Date:** 2026-09-01
**Found during:** B3 gate (`cargo test -p native --bin comparison-supervisor`)
**Pre-existing since:** at least `8ada2d1b` (the A5 candidate), proven by bisect
**Plan:** unchanged

## Discovery

The B3 gate's `cargo test -p native --bin comparison-supervisor` run carried one
failure, `resident_admission_tests::a_grant_presented_after_it_expires_is_refused`:
a payload presented at `not_after_ms + 1` was admitted (`Ok(())` where the test
expects `Err(OutsideGrantWindow)`). Bisect shows the same failure at `8ada2d1b`
and `7e7a5ddb`; Phase A gates did not run the bin test suite, so it stayed red
unnoticed.

`GrantRegistry::admit_payload` compared the presentation time against
`not_after_ms + BRACKET_CLOCK_SKEW_MS`. Both sides of that comparison are the
supervisor's own wall clock — the grant's `not_after_ms` is derived from the
supervisor's issue time and `accepted_at_ms` is the supervisor's reading when
the frame arrived. Skew tolerance is justified only where a child's
`performance.timeOrigin`-based timestamp is compared against the supervisor
clock (the `WallBracket` sample checks, which keep it). On a same-clock
comparison it is a fail-open window of `BRACKET_CLOCK_SKEW_MS` past expiry.

## Resolution

The expiry comparison is now a hard bound: any presentation strictly after
`not_after_ms` is refused `OutsideGrantWindow`. The `WallBracket` sample checks
are unchanged. The existing named test pins the behavior; no other test relied
on the slack.

Plan bytes were not edited.
