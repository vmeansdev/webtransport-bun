# Fuzzing (Phase 15.2)

Property and fuzz tests for robustness:

- **cargo-fuzz** (Rust): message framing, QUIC packet sequences at native boundary
- **JS boundary**: property tests for lifecycle (close while writing, reset storms) — see packages/webtransport/test/lifecycle.test.ts

To add Rust fuzz targets: `cargo fuzz init` in crates/native, add targets for datagram/stream parsing.
