# Deviation — A5 disable sccache on Linux stage builds

**Date:** 2026-08-31  
**Candidate:** `2e7e9eb2…` (stage-only failed)  
**Plan:** unchanged

## Discovery

Restage after the zero-flat render fix failed during Linux `aws-lc-sys`
compile: sccache wrote under `/tmp/ws-wt-linux-build.*` on a 6 GiB tmpfs and
exited with `No such file or directory` / status 254, aborting `build:native`.

## Resolution

Linux stage SSH script now stops any sccache server and clears
`RUSTC_WRAPPER` before cargo/native build so compilers write objects
directly. Prior `/tmp` build-tree hygiene remains. Plan bytes were not edited.
