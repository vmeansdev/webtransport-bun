# Deviation — both addon manifests digest an empty `prebuilds/`

**Date:** 2026-09-08  
**Candidate:** every stage since the manifest digests were added (A5 and the
phase-b stages alike)  
**Plan:** `2026-08-30-busyMs-attested-fanout.md` §9.3 ("hashes the Mac/Linux
supervisor, observer, Bun, addon/prebuild manifest, and profile-selected role
entrypoints") and `LiveStageReceiptV1.macAddonManifestSha256` /
`linuxAddonManifestSha256`; recorded by the physical-budget amendment D6

## Discovery

`hashAddonManifest(prebuildRoot)` (`stage-live-campaign.ts:956-958`) returns
`sha256("empty-prebuilds:<path>")` when the directory does not exist. The
repository has no `prebuilds/` directory at its root and the staged role root
copies one only `if test -d prebuilds` (`:3140`), so both
`macAddonManifestSha256` (`:2292`, over `<macBuildDir>/prebuilds`) and
`linuxAddonManifestSha256` (`:1388`, over `<roleRoot>/prebuilds` in the
linux-stage-observation) are the digest of the empty marker, on every stage.
The two fields read as evidence of which native addon was measured and bind
nothing about it. This is the placeholder-evidence family already recorded
for `host-runtime-facts/v1` and the empty toolchain digest.

## What binds the addon instead

The addon the server child actually loads is resolved by
`packages/webtransport/src/index.ts` from
`["../../../crates/native", "../prebuilds"]` relative to the package, i.e.
from the staged role root's `crates/native` build output when no `prebuilds/`
exists. That file is inside the role root, and the role root is bound by:

- the `linux-stage-observation/v1` record's `directoryIdentitySha256`
  (the observer's identity over the whole role root, `stage-live-campaign.ts
  :1383-1384`), signed into the stage receipt;
- the rig's `rig-server-snapshot-receipt/v1`, which states the
  `serverEntrypointSha256`, `bunSha256` and `addonSha256` the spawn request
  named, off the spawn and never off the capture frame.

So the measured addon is bound by directory identity and by the spawn's
digest, not by the manifest field, which is honest only in that its value
says "empty".

## Resolution

Recorded, not fixed here: the field stays in the receipt with its empty
marker so no key set moves, and the binding that matters is named above. A
later change may either drop the two manifest fields or make them digest the
addon file the role root actually loads; either is a stage-receipt schema
change with its own re-freeze.
