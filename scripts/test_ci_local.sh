#!/usr/bin/env bash
set -euo pipefail

export WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN=1
export WEBTRANSPORT_SUPPRESS_LOG_CALLBACK_WARN=1
export WEBTRANSPORT_SUPPRESS_READY_REJECTION_WARN=1
export WEBTRANSPORT_SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS=1
RUST_VERSION="$(
  node -e "const fs=require('node:fs'); const policy=JSON.parse(fs.readFileSync('.github/release-toolchain.json','utf8')); if (!Array.isArray(policy.rust) || policy.rust.length === 0) throw new Error('missing rust release toolchain'); process.stdout.write(String(policy.rust[0]));"
)"
RUST_TOOLCHAIN="$(
  rustup toolchain list | awk -v version="$RUST_VERSION" '$1 == version || index($1, version "-") == 1 { print $1; exit }'
)"
if [ -z "$RUST_TOOLCHAIN" ]; then
  RUST_TOOLCHAIN="$RUST_VERSION"
fi
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"

echo "[ci-local] cargo fmt --check"
cargo +"$RUST_TOOLCHAIN" fmt --check

echo "[ci-local] cargo clippy"
cargo +"$RUST_TOOLCHAIN" clippy --workspace -- -D clippy::all

echo "[ci-local] cargo test --workspace"
cargo +"$RUST_TOOLCHAIN" test --workspace

echo "[ci-local] build native addon"
rustup run "$RUST_TOOLCHAIN" bun run build:native

echo "[ci-local] install deps"
bun install --frozen-lockfile

echo "[ci-local] typecheck"
bun run typecheck

echo "[ci-local] bounded waits"
bun scripts/check-bounded-waits.ts

echo "[ci-local] unit tests (fresh process x${WEBTRANSPORT_COLD_LOOP_COUNT:-10})"
bun run test:packages:cold-loop

echo "[ci-local] parity"
bun run test:parity

echo "[ci-local] flake guard (critical suites x3)"
for i in 1 2 3; do
  echo "[ci-local] run:$i acceptance P3-10"
  bun test packages/webtransport/test/acceptance.test.ts -t "P3-10: moderate load completes without panic"
  echo "[ci-local] run:$i backpressure P1.2"
  bun test packages/webtransport/test/backpressure.test.ts -t "backpressure counters exist and have correct shape"
done

echo "[ci-local] load-addon"
bun run test:load-addon

echo "[ci-local] load-scale-addon"
LOAD_SCALE_SESSIONS=200 LOAD_SCALE_DURATION=30 bun run test:load-scale-addon

echo "[ci-local] load-profiles-addon"
bun run test:load-profiles-addon

echo "[ci-local] interop (fresh process x${WEBTRANSPORT_COLD_LOOP_COUNT:-10})"
bun run test:interop

echo "[ci-local] completed"
