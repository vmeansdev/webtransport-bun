#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Deps (rcgen/quinn) need rustc >= 1.88. Setting RUSTUP_TOOLCHAIN alone is not
# enough when `cargo` on PATH is a non-rustup shim (e.g. mise), so invoke the
# toolchain through rustup explicitly whenever rustup is available.
export RUSTUP_TOOLCHAIN=stable
CARGO=(cargo)
if command -v rustup >/dev/null 2>&1; then
  CARGO=(rustup run stable cargo)
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
  echo "build-wasm: no working cargo (need rustc >= 1.88). Install rustup + 'rustup toolchain install stable'." >&2
  exit 1
fi
if ! rustup target list --installed --toolchain stable 2>/dev/null | grep -q wasm32-unknown-unknown; then
  if command -v rustup >/dev/null 2>&1; then
    echo "build-wasm: adding wasm32-unknown-unknown target" >&2
    rustup target add --toolchain stable wasm32-unknown-unknown
  fi
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "build-wasm: wasm-bindgen-cli missing. Install: cargo install wasm-bindgen-cli --version 0.2.121 --locked" >&2
  exit 1
fi

# The `pkg` (test) build enables the accept-any client so the wasm test suite
# can dial without pinning. The shipped `dist`/`web` builds do NOT — the
# accept-any code is compiled out, so a production artifact cannot skip cert
# verification.
MODE="${1:-pkg}"
FEATURES=()
if [ "$MODE" = "pkg" ]; then
  FEATURES=(--features dev-insecure)
fi
"${CARGO[@]}" build --release --target wasm32-unknown-unknown "${FEATURES[@]}"
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
