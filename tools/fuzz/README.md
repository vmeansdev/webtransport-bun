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

## Deep fuzzing (cargo-fuzz, pinned release toolchain)

Release fuzzing now runs through `tools/fuzz/release-smoke.ts` using the
allowlisted `rustNightly` toolchain for cargo-fuzz and AddressSanitizer, while
the stable `rust` toolchain remains the source of truth for parser/property
tests. Both pins are declared in `.github/release-toolchain.json`. The runner
requires `cargo-fuzz` plus `llvm-symbolizer` (the nightly toolchain's
`llvm-tools-preview` when present, otherwise PATH / Homebrew LLVM) so crash
artifacts stay symbolized and actionable. Invocations use `--fuzz-dir .`
because this directory *is* the fuzz package. Stable Rust cannot build with
AddressSanitizer, and `--sanitizer none` still emits sanitizer-coverage hooks
without a runtime, so release smoke deliberately uses nightly + `address`.

## JS boundary

Lifecycle property tests (close while writing, reset storms) plus the Bun-side
`WASM event decoder property harness` live under
`packages/webtransport/test/`.

## Release smoke gate

Task 14 promotes fuzzing from a README-only follow-up into an explicit release
gate:

- `bun run fuzz:release-smoke` verifies the checked-in fixed regression corpus
  under `tools/fuzz/corpora/**` is present and retains both the corpora and the
  crash directory under `.release-evidence/fuzz/`.
- The cargo-fuzz targets cover H3 frames, QPACK/Huffman decoding, DER metadata
  parsing, the client certificate pin policy (14-day validity window and
  P-256/ECDSA-SHA256 gating, with the verification time fuzzed alongside the
  DER), HandleAllocator boundaries, WtEndpoint event dispatch, event encoding,
  and governor boundary arithmetic.
- The stable property-test step covers the hand-rolled H3/QPACK parser tests
  plus the Bun-side `packages/webtransport/test/wasm-limits.test.ts` decoder
  harness.
- When `cargo-fuzz` or `llvm-symbolizer` is missing for the pinned release
  toolchain, the smoke runner fails with an artifacted tooling blocker instead
  of silently claiming fuzz coverage.
- Every spawned command has an outer watchdog; timeout state is artifacted in
  `commandResults`. CI sanitizes the JSON artifact before validation/upload so
  command, stdout, and stderr paths never disclose the runner workspace.

Artifacts default to `.release-evidence/fuzz/release-smoke.json`.
