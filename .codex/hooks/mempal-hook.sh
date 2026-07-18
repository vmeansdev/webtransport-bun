#!/usr/bin/env bash
set -euo pipefail

HOOK_NAME="${1:?Usage: mempal-hook.sh <hook-name>}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INPUT_FILE="$(mktemp)"
OUTPUT_FILE="$(mktemp)"
LOG_FILE="$HOME/.mempalace/hook_state/hook.log"

trap 'rm -f "$INPUT_FILE" "$OUTPUT_FILE"' EXIT

cat > "$INPUT_FILE"

export MEMPAL_DIR="$REPO_ROOT"

python3 -m mempalace hook run --hook "$HOOK_NAME" --harness codex < "$INPUT_FILE" > "$OUTPUT_FILE"

if [ "$HOOK_NAME" = "precompact" ] || grep -q '"decision"[[:space:]]*:[[:space:]]*"block"' "$OUTPUT_FILE"; then
  mkdir -p "$(dirname "$LOG_FILE")"
  {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] hook=$HOOK_NAME repo=$REPO_ROOT sync-start"
    "$REPO_ROOT/scripts/mempal-sync-codex-convos.sh"
    python3 -m mempalace mine "$REPO_ROOT"
    python3 -m mempalace mine "$REPO_ROOT/.mempalace/conversations/codex" --mode convos --wing webtransport_bun --agent codex --extract general
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] hook=$HOOK_NAME repo=$REPO_ROOT sync-done"
  } >> "$LOG_FILE" 2>&1 || true
fi

cat "$OUTPUT_FILE"
