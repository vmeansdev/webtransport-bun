# Deviation — A5 destroy `--expected-public-key-sha256`

**Date:** 2026-08-31  
**Campaign:** `busyms-attested-focused-r1` (candidate `5b077adc…`)  
**Plan:** `docs/superpowers/plans/2026-08-30-busyMs-attested-fanout.md` (unchanged)

## Discovery

Frozen run wrapper §9 cleanup invokes:

```text
comparison-supervisor destroy-signing-key \
  --private-key=… \
  --expected-public-key-sha256=<digest> \
  --missing=ok
```

The staged supervisor binary rejected the expected-digest flag as unknown
(`TRUST_SIGNING_KEY_ARGUMENT_INVALID`), so EXIT cleanup returned 70 even after
the controller failed for unrelated reasons.

## Resolution

Accept `--expected-public-key-sha256=` (64-char lowercase hex), verify the
sibling `.pub` leaf digest before unlink, then destroy. Wrong digest or
non-`.pk8` private path remains `TRUST_SIGNING_KEY_ARGUMENT_INVALID`.

Plan bytes were not edited.
