# Support policy

## Engine dependency (native)

The native addon is powered by **`wtransport =0.7.0`** (pinned in
`crates/native/Cargo.toml`). That crate is pre-1.0 and single-maintainer. A
1.0 consumer of `@webtransport-bun/webtransport` inherits that engine risk:
protocol/security fixes may require coordinated upgrades of this package and
wtransport together.

## What we support

Support is claimed only after `docs/release-status.json` records
commit-bound `support.tested` tuples. Until then, targets remain candidates.

## Reporting issues

File issues against this repository with reproduction steps, runtime
(Bun/Node/Deno + version), OS/arch, and whether the surface is native or
`/wasm`.
