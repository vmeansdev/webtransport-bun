# Support policy

## Engine dependency (native)

The native addon is powered by a **fork of `wtransport` 0.7.1**
(`vmeansdev/wtransport` rev `c1888a89`, named in the root `Cargo.toml` and
compiled from the vendored copy in `vendor/wtransport-fork/`; see
`docs/FORK_MAINTENANCE.md`). Upstream `wtransport` is pre-1.0 and
single-maintainer, and this project maintains the fork's delta itself. A 1.0
consumer of `@webtransport-bun/webtransport` inherits that engine risk:
protocol/security fixes may require coordinated upgrades of this package and
the fork together.

## What we support

Support is claimed only after `docs/release-status.json` records
commit-bound `support.tested` tuples. Until then, targets remain candidates.

## Reporting issues

File issues against this repository with reproduction steps, runtime
(Bun/Node/Deno + version), OS/arch, and whether the surface is native or
`/wasm`.
