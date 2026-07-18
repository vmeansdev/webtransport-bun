#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_ROOT="${CODEX_SESSIONS_ROOT:-$HOME/.codex/sessions}"
DEST_ROOT="${MEMPAL_CONVO_ROOT:-$REPO_ROOT/.mempalace/conversations/codex}"
MATCH_PATTERN="\"cwd\":\"$REPO_ROOT\""

mkdir -p "$DEST_ROOT"

if [ ! -d "$SOURCE_ROOT" ]; then
  exit 0
fi

while IFS= read -r src; do
  [ -n "$src" ] || continue
  cp -f "$src" "$DEST_ROOT/$(basename "$src")"
done < <(rg -l --fixed-strings "$MATCH_PATTERN" "$SOURCE_ROOT" 2>/dev/null || true)
