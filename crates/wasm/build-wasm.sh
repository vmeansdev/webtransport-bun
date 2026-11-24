#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Deps (rcgen/quinn) need rustc >= 1.88. Resolve the exact release toolchain
# from the repository policy instead of following the mutable `stable` alias.
POLICY_PATH="../../.github/release-toolchain.json"
if command -v bun >/dev/null 2>&1; then
  JS_EVAL=(bun -e)
elif command -v node >/dev/null 2>&1; then
  JS_EVAL=(node -e)
else
  echo "build-wasm: Bun or Node is required to read $POLICY_PATH" >&2
  exit 1
fi
POLICY_VERSIONS="$("${JS_EVAL[@]}" 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/; if (!Array.isArray(p.rust) || p.rust.length !== 1 || !exact.test(p.rust[0]) || !Array.isArray(p.wasmBindgen) || p.wasmBindgen.length !== 1 || !exact.test(p.wasmBindgen[0])) process.exit(2); process.stdout.write(`${p.rust[0]}\t${p.wasmBindgen[0]}`);' "$POLICY_PATH")"
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

# wasm32 C deps (ring) need a clang that can target wasm32 and an llvm-ar:
# the system ar (macOS) writes archives without a wasm symbol index, so the
# linker silently drops ring's C objects and the module ends up importing
# them from "env". Respect caller-provided env (CI sets both); otherwise use
# the first Homebrew LLVM (unversioned, then llvm@NN newest first) or clang on
# PATH that has a matching llvm-ar and passes a wasm32 compile probe.
wasm_cc_works() {
  [ -x "$1" ] && [ -x "$2" ] &&
    printf 'int f(void) { return 0; }\n' |
      "$1" --target=wasm32-unknown-unknown -x c -c - -o /dev/null >/dev/null 2>&1
}

find_wasm_cc() {
  local prefix dir clang_path
  for prefix in ${HOMEBREW_PREFIX:+"$HOMEBREW_PREFIX"} /opt/homebrew /usr/local; do
    for dir in "$prefix/opt/llvm" $(ls -d "$prefix"/opt/llvm@* 2>/dev/null | sort -t@ -k2 -n -r); do
      if wasm_cc_works "$dir/bin/clang" "$dir/bin/llvm-ar"; then
        WASM_CC="$dir/bin/clang" WASM_AR="$dir/bin/llvm-ar"
        return 0
      fi
    done
  done
  clang_path="$(command -v clang || true)"
  if [ -n "$clang_path" ]; then
    for WASM_AR in "$(dirname "$clang_path")/llvm-ar" "$(command -v llvm-ar || true)"; do
      if wasm_cc_works "$clang_path" "$WASM_AR"; then
        WASM_CC="$clang_path"
        return 0
      fi
    done
  fi
  return 1
}

if [ -z "${CC_wasm32_unknown_unknown:-}" ]; then
  if find_wasm_cc; then
    export CC_wasm32_unknown_unknown="$WASM_CC"
    export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-$WASM_AR}"
  else
    echo "build-wasm: no clang with the wasm32 target plus llvm-ar found (macOS: brew install llvm); set CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown" >&2
  fi
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
# The target dir follows CARGO_TARGET_DIR and any .cargo/config.toml
# build.target-dir, so ask cargo instead of assuming ./target.
TARGET_DIR="$("${CARGO[@]}" metadata --format-version 1 --no-deps |
  "${JS_EVAL[@]}" 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).target_directory)')"
WASM="$TARGET_DIR/wasm32-unknown-unknown/release/webtransport_wasm.wasm"

# A module that still imports from "env" has unresolved C symbols (ring was
# compiled or archived with the wrong toolchain); its glue would fail to load
# with "Cannot find package 'env'", so refuse to ship it.
ENV_IMPORTS="$("${JS_EVAL[@]}" 'const m = new WebAssembly.Module(require("fs").readFileSync(process.argv[1])); process.stdout.write(WebAssembly.Module.imports(m).filter((i) => i.module === "env").map((i) => i.name).join(" "));' "$WASM")"
if [ -n "$ENV_IMPORTS" ]; then
  read -r -a env_symbols <<< "$ENV_IMPORTS"
  echo "build-wasm: $WASM has ${#env_symbols[@]} unresolved \"env\" imports (first: ${env_symbols[*]:0:5})." >&2
  echo "build-wasm: ring's C objects were not linked; build them with an LLVM clang and llvm-ar by setting CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown (macOS: brew install llvm), then rebuild." >&2
  exit 1
fi

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
    # Scope nodejs glue as CommonJS under the package's root `"type": "module"`.
    printf '%s\n' '{"private":true,"type":"commonjs"}' \
      > ../../packages/webtransport/wasm-dist/node/package.json
    # Provenance marker (eventWireVersion 3 = session_id, SessionClosed tag 9
    # with the peer's close reason, SessionDraining tag 10).
    cat > ../../packages/webtransport/wasm-dist/PRODUCTION_BUILD.json <<'EOF'
{
  "schemaVersion": 1,
  "profile": "release",
  "devInsecure": false,
  "targets": ["nodejs", "web"],
  "eventWireVersion": 3
}
EOF
    echo "[build-wasm] done -> packages/webtransport/wasm-dist/{node,web}"
    ;;
  *)
    echo "usage: build-wasm.sh [pkg|web|dist]" >&2
    exit 2
    ;;
esac
