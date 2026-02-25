#!/usr/bin/env bash
set -euo pipefail

export WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN=1

echo "[ci-local] cargo fmt --check"
cargo fmt --check

echo "[ci-local] cargo clippy"
cargo clippy --workspace -- -D clippy::all

echo "[ci-local] cargo test --workspace"
cargo test --workspace

echo "[ci-local] build native addon"
bun run build:native

echo "[ci-local] install deps"
bun install --frozen-lockfile

echo "[ci-local] typecheck"
bun run typecheck

echo "[ci-local] unit tests"
bun test packages/

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

echo "[ci-local] interop"
bun run test:interop

echo "[ci-local] completed"
