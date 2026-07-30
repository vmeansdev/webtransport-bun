# Maintaining the wtransport fork dependency

The native backend depends on a **fork** of `wtransport`, not the crates.io
release, because upstream 0.7.1 has no 0-RTT support and we need it:

- Fork: [`vmeansdev/wtransport`](https://github.com/vmeansdev/wtransport),
  branch `feat/0rtt`, branched from `BiagioFesta/wtransport` `master` at
  `a11e6a8`.
- Consumed as a **Git dependency pinned by revision** through
  `[workspace.dependencies]` in the root `Cargo.toml`:

  ```toml
  wtransport = { git = "https://github.com/vmeansdev/wtransport", rev = "aa45f3719bfb5e443d274c2f3c7784797ac81f52", features = ["dangerous-configuration", "quinn"] }
  ```

  `crates/native` and `crates/reference` both reference it with
  `wtransport = { workspace = true }`. The committed `Cargo.lock` records the
  exact rev (`0.7.1-zerortt.1`).

This document is the standing obligation list that pinning to a Git fork
creates. Read it before touching the dependency, cutting a release, or
triaging a security advisory.

## The rev must stay permanently reachable

`release.yml` builds the native addon **from source** (`bun run build:native`
compiles `crates/native`, which compiles the pinned wtransport rev). There is
no vendored copy and no prebuilt wtransport artifact. If the pinned rev becomes
unreachable, **every release build breaks**, and so does any consumer building
from source.

Therefore, for `vmeansdev/wtransport`:

- The repository must stay **public**.
- The commit `aa45f37` (and any rev this project has ever pinned) must remain
  reachable: **no force-push that orphans it, no history rewrite, no garbage
  collection** of that object. Keep a branch or tag pointing at each pinned rev
  so it is never a dangling commit. `feat/0rtt` currently serves that role for
  `aa45f37`; if the branch is rebased forward, tag the old tip first
  (e.g. `pinned/aa45f37`).
- Bumping the pin is a deliberate change: update `rev` in the workspace
  `Cargo.toml`, regenerate `Cargo.lock`, and keep the old rev reachable anyway
  (older release tags of this project still point at it).

## Security scanning no longer covers wtransport

`cargo audit` (run in CI's `security` job and locally) matches crate versions
against the RustSec advisory database **by crates.io version**. A Git
dependency is not a crates.io release, so:

- **`cargo audit` will not flag advisories against the forked wtransport or any
  dependency it pulls in that differs from the crates.io graph.** A `cargo
  audit` pass is no longer evidence that wtransport is advisory-clean.
- **Dependabot is blind to it** for the same reason — it will not open PRs to
  bump the fork or alert on advisories affecting it.

Mitigation — a manual advisory watch is now part of maintenance:

1. Watch RustSec / GitHub advisories for `wtransport`, `wtransport-proto`,
   `quinn`, `quinn-proto`, and `rustls` directly.
2. When upstream `wtransport` or a shared transitive dep publishes a security
   fix, rebase the fork onto it (see below) and bump the pin.
3. `quinn`/`rustls`/etc. that are still resolved from crates.io **are** covered
   by `cargo audit`; only wtransport itself and anything the fork pins
   differently fall into the blind spot. Keep the fork's transitive graph as
   close to upstream as possible so the blind spot stays small.

## Keeping up with upstream

Track `BiagioFesta/wtransport` as `upstream` on the fork clone and **rebase,
don't merge**:

```sh
git remote add upstream https://github.com/BiagioFesta/wtransport   # once
git fetch upstream
git rebase upstream/master           # rebase feat/0rtt onto master
```

Rebasing keeps the feature commits proposable upstream and keeps the branch a
clean series. Before rebasing away the current tip, tag it so the pinned rev
stays reachable (see above). After a rebase, run the fork's own test suite
locally (`cargo test` in the fork, including `wtransport/tests/zero_rtt.rs`) —
webtransport-bun CI does **not** run the fork's suite.

Cadence: at minimum whenever upstream ships a correctness or security fix that
touches the transport/H3/TLS paths, and opportunistically otherwise so the
delta stays small and MR-able.

## MR-later intent

The fork's feature commits are written to be proposable to upstream as they
stand (conventional-commit subjects, upstream formatting/lints, no
fork-specific naming, no references to this project). See the fork's `FORK.md`
for the suggested MR order. If/when upstream accepts 0-RTT, this project can
drop back to a crates.io release and delete this document. Until then, the
obligations above hold.

## Checklist for bumping the pin

1. Rebase `feat/0rtt` on the fork; tag the old tip so its rev stays reachable.
2. Push the fork (a maintainer action; agents do not push).
3. Update `rev` in the root `Cargo.toml` `[workspace.dependencies]`.
4. `RUSTUP_TOOLCHAIN=stable cargo update -p wtransport` (or `cargo build`) to
   regenerate `Cargo.lock`; commit the lockfile change.
5. Rebuild the native addon and run the canonical suites.
6. Manually re-check advisories for wtransport/quinn/rustls, since `cargo audit`
   will not.
