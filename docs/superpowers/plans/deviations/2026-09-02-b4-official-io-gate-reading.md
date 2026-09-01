# Deviation — §10 official-I/O gate line read as "no new findings"

**Date:** 2026-09-02
**Found during:** B4 final gate
**Plan:** unchanged

## Discovery

§10 lists `bun tools/compare/check-official-io.ts` among six commands that must
all exit 0, alongside `bun test tools/compare/`. On the B4 tree these two are
mutually exclusive by contract: the frozen R1 RED bundle
(`tools/compare/r1-entrypoint-red.test.ts:832/:847/:1080`) asserts that the
official-I/O checker reports a non-empty, deterministic, bounded inventory —
`status === "FAIL"`, `observedCheckerKeys.size > 0`, and two reserved
inventory keys present. That is Task A's approved contract for the checker:
it is a bounded inventory audit whose value is determinism and containment,
not emptiness. An empty audit would fail the RED contract.

The checker has never exited 0 at any HEAD since the A phase (151 findings on
a clean tree at `c11fd011`), so the literal "exit 0" reading was unattainable
at the moment the plan was approved. Every Phase B gate (B1, B2, B3) was held
to *delta zero*; B4 improved on it.

## Ruling

The §10 official-I/O line is read as: **the checker's normalized finding set
(`code|file|detail`, line-insensitive) contains no key that is not in the
frozen baseline inventory — observed ⊆ baseline — and the RED oracles pinning
that inventory pass.** Exit status is not the criterion for this one line.

Measured at B4 on a clean tree: baseline 151 → observed 136; zero new keys;
fifteen retired (allowlist hygiene and CLI-entry classification). The
alternative — reopening the R1 red bundle so the checker's contract becomes
"empty" — is a separately reviewed change with an
`R1_CAMPAIGN_AUTHORITY_SHA256` rotation (`bin/compare-stage.ts:49-55`) and is
not part of B4.

The remaining five §10 commands are held to their literal exit-0 reading.

Plan bytes were not edited.
