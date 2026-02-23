#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="wt-echo-playground"

cd "$ROOT_DIR"

docker buildx build --load -f examples/echo-playground/Dockerfile -t "$IMAGE_NAME" .

docker run --rm \
  -p 3000:3000/tcp \
  -p 4433:4433/udp \
  "$IMAGE_NAME"
