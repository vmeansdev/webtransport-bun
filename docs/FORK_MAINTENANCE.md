# Maintaining the wtransport fork dependency

The native backend depends on a **fork** of `wtransport`, not the crates.io
release, because upstream 0.7.1 has neither 0-RTT support, the WebTransport
session-lifecycle conformance work, nor dynamic QPACK, and we need all three.
The build does not fetch that fork, though: it compiles a vendored copy of it
from this repository.

- Fork: [`vmeansdev/wtransport`](https://github.com/vmeansdev/wtransport),
  branched from `BiagioFesta/wtransport` `master` at `a11e6a8`. The pinned rev
  is `c1888a89` on branch `fix/cancellation-safe-frame-reads`, which stacks on
  `probe/server-with-runtime` (`afe6528`), `fix/close-capsule-race`
  (`7dc1a03`) and `feat/qpack-dynamic` (`ac515b1`), itself on
  `feat/track1-conformance` and `feat/0rtt`.
- The root `Cargo.toml` names the fork in `[workspace.dependencies]`:

  ```toml
  wtransport = { git = "https://github.com/vmeansdev/wtransport", rev = "c1888a890525ad79b58a3f1970afcfdec60d46f7", features = ["dangerous-configuration", "quinn"] }
  ```

  and then redirects that git source to the vendored tree:

  ```toml
  [patch."https://github.com/vmeansdev/wtransport"]
  wtransport = { path = "vendor/wtransport-fork/wtransport" }
  ```

  `crates/native` and `crates/reference` both use
  `wtransport = { workspace = true }`, so the `[patch]` applies to every
  build. The committed `Cargo.lock` therefore records `wtransport
  0.7.1-zerortt-qpack.1` (and `wtransport-proto`) as **path** packages with no
  `source` line; the git rev is not in the lockfile.
- `vendor/wtransport-fork/` is a `git archive` of the fork at `c1888a89` plus
  local commits made in this repository (see
  `git log -- vendor/wtransport-fork` and
  `vendor/wtransport-fork/VENDORED.md`). At the time of writing those are the
  dedicated per-connection datagram pump (`1e5281d4`) and the
  `ConnectionClose::is_connection_refused` accessor (`1495034f`). Neither
  exists at the pinned rev on GitHub.

This document is the standing obligation list that the fork and its vendored
copy create. Read it before touching the dependency, cutting a release, or
triaging a security advisory.

## What the pinned rev is still for

`release.yml` builds the native addon **from source** (`bun run build:native`
compiles `crates/native`), and that compile reads `vendor/wtransport-fork/`,
not GitHub. A release build does not need the fork repository to be reachable.

The rev still matters:

- It records which fork commit the vendored tree started from, so a bump can
  diff against it and the local commits can be re-applied (see the checklist).
- Older release tags of this project predate the vendored copy (added in
  `1b751014`, 2026-10-01) and build the git rev directly; they break if their
  rev becomes unreachable.

Therefore, for `vmeansdev/wtransport`:

- The repository must stay **public**.
- Every rev this project has ever pinned must remain reachable: `aa45f37`,
  `b0b9f5c`, `d3ff84d`, `ac515b1`, `7dc1a03`, `afe6528` and `c1888a89`. **No
  force-push that orphans one, no history rewrite, no garbage collection.**
  Keep a branch or tag on each: today `feat/0rtt` holds `aa45f37`,
  `feat/track1-conformance` holds `b0b9f5c`, `feat/qpack-dynamic` holds
  `ac515b1` and its ancestor `d3ff84d`, `fix/close-capsule-race` holds
  `7dc1a03`, `probe/server-with-runtime` holds `afe6528`, and
  `fix/cancellation-safe-frame-reads` holds `c1888a89`. If a branch is rebased
  forward, tag the old tip first (e.g. `pinned/c1888a89`).

## Security scanning no longer covers wtransport

`cargo audit` (run in CI's `security` job and locally) matches crate versions
against the RustSec advisory database **by crates.io version**. The vendored
path package (and the git fork behind it) is not a crates.io release, so:

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
git rebase upstream/master           # rebase feat/qpack-dynamic onto master
```

Rebasing keeps the feature commits proposable upstream and keeps the branch a
clean series. Before rebasing away the current tip, tag it so the pinned rev
stays reachable (see above). After a rebase, run the fork's own test suite.
Its integration tests are compiled only with the right features, so a plain
`cargo test` runs the unit tests and **zero** integration tests:

```sh
cargo test --locked -p wtransport --features dangerous-configuration,self-signed,quinn
```

That includes `wtransport/tests/zero_rtt.rs`, `session_close.rs`,
`session_drain.rs`, `qpack_dynamic.rs` and the datagram-pump tests. Run the
same command in `vendor/wtransport-fork/` after changing the vendored tree:
webtransport-bun CI runs **neither** the fork's suite nor the vendored copy's.

Cadence: at minimum whenever upstream ships a correctness or security fix that
touches the transport/H3/TLS paths, and opportunistically otherwise so the
delta stays small and MR-able.

## Known fork limitations (accepted, not yet fixed)

- **Session-command channel can silently drop a terminal command under a
  synchronous flood.** The driver's `session_commands` channel is a bounded
  `mpsc::channel(4)`, and every producer (session close, drain, GOAWAY) enqueues
  with `let _ = try_send(...)`. A JS caller issuing 4+ `drain()`/`goAway()` calls
  in a tight synchronous loop can fill the channel faster than the driver task
  drains it, after which a following `close(code, reason)` is dropped: the peer
  never receives the `CLOSE_WEBTRANSPORT_SESSION` capsule and the connection
  lingers to idle timeout, yet the local session state is already marked closed,
  so JS reports a clean close. This predates the GOAWAY work (drain had the same
  property); GOAWAY only added a second way to fill the queue. Not fixed because
  the honest fixes are design changes (an unbounded channel, or priority delivery
  for terminal commands) that do not belong in a bugfix commit. Reach it only
  with an abnormal synchronous command flood; normal one-shot close/drain/goAway
  is unaffected.

## MR-later intent

The fork's feature commits are written to be proposable to upstream as they
stand (conventional-commit subjects, upstream formatting/lints, no
fork-specific naming, no references to this project). See the fork's `FORK.md`
for the suggested MR order. If/when upstream accepts these features, this
project can drop back to a crates.io release and delete this document. Until
then, the obligations above hold.

## Checklist for bumping the pin

1. Rebase the pinned branch on the fork; tag the old tip so its rev stays
   reachable.
2. Push the fork (a maintainer action; agents do not push).
3. Update `rev` in the root `Cargo.toml` `[workspace.dependencies]`.
4. Re-vendor: replace `vendor/wtransport-fork/` with a `git archive` of the new
   rev (the workspace manifest, licenses, `wtransport/` and
   `wtransport-proto/`), keeping `VENDORED.md`.
5. Re-apply every local commit listed by `git log -- vendor/wtransport-fork`
   since the last vendoring, or upstream them into the fork first and drop
   them here. Update `VENDORED.md` with the new rev and the remaining local
   changes.
6. Run `cargo build` to refresh `Cargo.lock` (the `[patch]` keeps wtransport a
   path package there); commit the lockfile with the re-vendored tree.
7. Run the vendored suite (`cargo test --locked -p wtransport --features
   dangerous-configuration,self-signed,quinn` in `vendor/wtransport-fork/`),
   rebuild the native addon and run the canonical suites.
8. Manually re-check advisories for wtransport/quinn/rustls, since `cargo audit`
   will not.
