#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Deps (rcgen/quinn) need rustc >= 1.88. Resolve the exact release toolchain
# from the repository policy instead of following the mutable `stable` alias.
POLICY_PATH="../../.github/release-toolchain.json"
if command -v bun >/dev/null 2>&1; then
  POLICY_VERSIONS="$(bun -e 'const p = await Bun.file(process.argv[1]).json(); const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/; if (!Array.isArray(p.rust) || p.rust.length !== 1 || !exact.test(p.rust[0]) || !Array.isArray(p.wasmBindgen) || p.wasmBindgen.length !== 1 || !exact.test(p.wasmBindgen[0])) process.exit(2); process.stdout.write(`${p.rust[0]}\t${p.wasmBindgen[0]}`);' "$POLICY_PATH")"
elif command -v node >/dev/null 2>&1; then
  POLICY_VERSIONS="$(node -e 'const p = require(process.argv[1]); const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/; if (!Array.isArray(p.rust) || p.rust.length !== 1 || !exact.test(p.rust[0]) || !Array.isArray(p.wasmBindgen) || p.wasmBindgen.length !== 1 || !exact.test(p.wasmBindgen[0])) process.exit(2); process.stdout.write(`${p.rust[0]}\t${p.wasmBindgen[0]}`);' "$POLICY_PATH")"
else
  echo "build-wasm: Bun or Node is required to read $POLICY_PATH" >&2
  exit 1
fi
IFS=$'\t' read -r RELEASE_RUST_TOOLCHAIN EXPECTED_WB_VERSION <<< "$POLICY_VERSIONS"
if [[ ! "$RELEASE_RUST_TOOLCHAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
   [[ ! "$EXPECTED_WB_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "build-wasm: invalid exact Rust or wasm-bindgen toolchain in $POLICY_PATH" >&2
  exit 1
fi
export RUSTUP_TOOLCHAIN="$RELEASE_RUST_TOOLCHAIN"
CARGO=(cargo)
if command -v rustup >/dev/null 2>&1; then
  CARGO=(rustup run "$RELEASE_RUST_TOOLCHAIN" cargo)
fi

# wasm32 C deps (ring) need an LLVM clang that can target wasm32. Respect
# caller-provided env; otherwise fall back to Homebrew LLVM when present
# (macOS), else leave cargo's default toolchain to handle it (Linux/CI set
# these explicitly).
if [ -z "${CC_wasm32_unknown_unknown:-}" ] && [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
  export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
  export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
fi

# Fail fast with actionable errors instead of deep inside cargo/ring — this
# script also runs from `npm publish` (prepublishOnly), where a missing wasm
# toolchain would otherwise surface as an inscrutable build failure.
if ! "${CARGO[@]}" --version >/dev/null 2>&1; then
  echo "build-wasm: no working cargo for Rust $RELEASE_RUST_TOOLCHAIN. Install rustup + 'rustup toolchain install $RELEASE_RUST_TOOLCHAIN'." >&2
  exit 1
fi
if ! rustup target list --installed --toolchain "$RELEASE_RUST_TOOLCHAIN" 2>/dev/null | grep -q wasm32-unknown-unknown; then
  if command -v rustup >/dev/null 2>&1; then
    echo "build-wasm: adding wasm32-unknown-unknown target" >&2
    rustup target add --toolchain "$RELEASE_RUST_TOOLCHAIN" wasm32-unknown-unknown
  fi
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "build-wasm: wasm-bindgen-cli missing. Install: cargo install wasm-bindgen-cli --version $EXPECTED_WB_VERSION --locked" >&2
  exit 1
fi
# SEC-010: Verify wasm-bindgen CLI version matches the expected crate version
# to avoid subtly broken bindings from a mismatched CLI.
ACTUAL_WB_VERSION="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')"
if [ "$ACTUAL_WB_VERSION" != "$EXPECTED_WB_VERSION" ]; then
  echo "build-wasm: wasm-bindgen version mismatch: expected $EXPECTED_WB_VERSION, got ${ACTUAL_WB_VERSION:-unknown}. Install: cargo install wasm-bindgen-cli --version $EXPECTED_WB_VERSION --locked" >&2
  exit 1
fi

# The `pkg` (test) build enables the accept-any client so the wasm test suite
# can dial without pinning. The shipped `dist`/`web` builds do NOT — the
# accept-any code is compiled out, so a production artifact cannot skip cert
# verification.
MODE="${1:-pkg}"
if [ "$MODE" = "pkg" ]; then
  "${CARGO[@]}" build --release --target wasm32-unknown-unknown --features dev-insecure
else
  # Production/dist: never enable dev-insecure. Set wt_ship_production so a
  # mistaken --features dev-insecure becomes a compile_error (inert under
  # cargo test --all-features, which does not set this cfg).
  export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--cfg wt_ship_production"
  "${CARGO[@]}" build --release --target wasm32-unknown-unknown
fi
WASM=target/wasm32-unknown-unknown/release/webtransport_wasm.wasm

# Modes: pkg (default) -> crates/wasm/pkg for tests; web -> the IWA example's
# vendor dir; dist -> the npm package's shipped wasm-dist/{node,web}.
case "$MODE" in
  pkg)
    wasm-bindgen "$WASM" --out-dir pkg --target nodejs --out-name webtransport_wasm
    echo "[build-wasm] done -> pkg/"
    ;;
  web)
    wasm-bindgen "$WASM" --out-dir ../../examples/webtransport-wasm-iwa/vendor \
      --target web --out-name webtransport_wasm
    echo "[build-wasm] done -> examples/webtransport-wasm-iwa/vendor/"
    ;;
  dist)
    wasm-bindgen "$WASM" --out-dir ../../packages/webtransport/wasm-dist/node \
      --target nodejs --out-name webtransport_wasm
    wasm-bindgen "$WASM" --out-dir ../../packages/webtransport/wasm-dist/web \
      --target web --out-name webtransport_wasm
    echo "[build-wasm] done -> packages/webtransport/wasm-dist/{node,web}"
    ;;
  *)
    echo "usage: build-wasm.sh [pkg|web|dist]" >&2
    exit 2
    ;;
esac
