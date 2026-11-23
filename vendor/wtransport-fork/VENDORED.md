# Vendored wtransport fork

`git archive` of https://github.com/vmeansdev/wtransport at
`c1888a890525ad79b58a3f1970afcfdec60d46f7` (the rev pinned in the root
Cargo.toml), limited to the workspace manifest, licenses and the two crates,
plus the local changes listed below. Vendored so reviewed local changes can be
built from this repository without publishing a new fork revision. Wired in via
the root `[patch."https://github.com/vmeansdev/wtransport"]`, so the build
compiles this tree, not the pinned rev.

## Local changes on top of c1888a89

| Commit | Change | Files |
|---|---|---|
| `1e5281d4` | Datagrams are read in a dedicated per-connection driver task (`WTRANSPORT_DATAGRAM_PUMP=0` restores the inline path); `datagram_driver_stats()` | `wtransport/src/driver/mod.rs`, `wtransport/src/lib.rs`, `wtransport/tests/datagram_*` |
| `7c5ca26a` | A `Cargo.lock` so the vendored crate tests run reproducibly | `Cargo.lock` |
| `1495034f` | `ConnectionClose::is_connection_refused()`, so a refused dial maps to `E_LIMIT_EXCEEDED` by its QUIC error code | `wtransport/src/error.rs` |
| `350f7305` | `ConnectionError::is_tls_handshake_failure()`, so certificate failures map to `E_TLS` by the QUIC TLS error range | `wtransport/src/error.rs` |

Re-vendoring a new fork revision means re-applying these changes, or upstreaming
them to the fork first. The vendored tests need the fork's features:
`cargo test -p wtransport --features dangerous-configuration,self-signed,quinn`
from this directory (without them the integration tests compile to nothing).
