# Fuzzing / parser robustness

The wasm backend's hand-rolled QUIC/H3/QPACK parsers are the attacker-facing
surface, so they are exercised two ways.

## Always-on robustness fuzzing (runs in `cargo test` / CI)

Deterministic, dependency-free property tests feed hundreds of thousands of
random **and** structured-adversarial byte sequences to every hand-rolled
parser and assert none panics (a panic in wasm aborts and poisons the whole
endpoint registry). These run on stable in the normal test suite — no nightly,
no separate job:

- `crates/wasm/src/h3.rs`: `parsers_never_panic_on_random_input` (200k inputs
  across `varint::decode`, `qpack_int_decode`, `parse_settings`,
  `decode_literal_headers`, `unwrap_datagram`) and
  `parsers_never_panic_on_structured_adversarial_input` (maximal varints,
  all-continuation QPACK integers, truncations).
- `crates/wasm/src/endpoint.rs`:
  `decode_frame_header_never_panics_on_random_input` (100k inputs) plus the
  oversized-frame and QPACK-overflow regression tests.

## Deep fuzzing (cargo-fuzz, nightly — follow-up)

For coverage-guided libFuzzer runs: `cargo +nightly fuzz init` under
`crates/wasm`, add targets wrapping the same parser entry points, seed a corpus
from real handshakes, and run in a scheduled CI job (nightly toolchain).
Tracked as a follow-up; the always-on robustness tests above are the immediate
regression guard against parser panics/overflows.

## JS boundary

Lifecycle property tests (close while writing, reset storms) —
see `packages/webtransport/test/`.
