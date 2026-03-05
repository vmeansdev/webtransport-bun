#!/usr/bin/env sh
# Rollback drill: download release assets, verify checksums, output restore runbook.
# Usage: ./scripts/rollback-drill.sh v0.1.0
# Requires: gh CLI, or GITHUB_REPOSITORY env for curl fallback
set -e

TARGET="${1:?Usage: $0 <release_tag>}"
REPO="${GITHUB_REPOSITORY:-vmeansdev/webtransport-bun}"
DIR="rollback-assets-$$"
trap 'rm -rf "$DIR"' EXIT

mkdir -p "$DIR"
cd "$DIR"

if command -v gh >/dev/null 2>&1; then
  gh release download "$TARGET" --repo "$REPO"
else
  echo "Downloading via curl (gh not found)..."
  BASE="https://github.com/${REPO}/releases/download/${TARGET}"
  for f in webtransport-native.darwin-arm64.node webtransport-native.darwin-x64.node webtransport-native.linux-x64.node webtransport-native.win32-x64-msvc.node SHA256SUMS; do
    curl -fsSL -o "$f" "${BASE}/${f}" 2>/dev/null || true
  done
fi

if [ ! -f SHA256SUMS ]; then
  echo "ERROR: SHA256SUMS not found in release $TARGET. Releases before combined checksum support may not have it."
  exit 1
fi

echo "Verifying checksums..."
shasum -a 256 -c SHA256SUMS

VER_NPM="${TARGET#v}"
echo ""
echo "=== Rollback runbook (validated) ==="
echo "Target: $TARGET"
echo ""
echo "Operator action: Instruct users to pin to known-good version:"
echo "  bun add @webtransport-bun/webtransport@${VER_NPM}"
echo ""
echo "Validation: Artifact checksums verified OK."
