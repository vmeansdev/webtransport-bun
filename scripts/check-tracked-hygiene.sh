#!/usr/bin/env bash
# Refuse tracked campaign/evidence material. Release and benchmark evidence,
# agent planning scratch and session transcripts are produced locally or by
# workflows and stored outside this repository; none of it may be committed.
#
# Checks every path in the index (`git ls-files`, so files staged for the
# next commit are included). With --stdin, checks newline-separated paths
# from stdin instead (used by the tests).
#
# Refused:
#   .release-evidence/**  .bench-evidence/**  .scratch/**  docs/superpowers/**
#   any *.jsonl outside a test-fixture directory (a path segment named
#   test, tests, testdata, fixtures or __fixtures__)
set -euo pipefail

list_paths() {
  if [ "${1:-}" = "--stdin" ]; then
    cat
  else
    repo_root="$(git rev-parse --show-toplevel)"
    git -C "$repo_root" ls-files
  fi
}

offending="$(
  list_paths "${1:-}" | awk '
    /^\.release-evidence\// || /^\.bench-evidence\// || /^\.scratch\// || /^docs\/superpowers\// { print; next }
    /\.jsonl$/ {
      if ($0 ~ /(^|\/)(test|tests|testdata|fixtures|__fixtures__)\//) next
      print
    }
  '
)"

if [ -n "$offending" ]; then
  count="$(printf '%s\n' "$offending" | wc -l | tr -d ' ')"
  echo "check-tracked-hygiene: $count tracked path(s) are campaign/evidence material that must stay out of the repository:" >&2
  printf '%s\n' "$offending" | head -50 | sed 's/^/  /' >&2
  if [ "$count" -gt 50 ]; then
    echo "  ... ($((count - 50)) more)" >&2
  fi
  echo "Attach evidence to the candidate pre-release with scripts/release-evidence.ts (see docs/RELEASE_CHECKLIST.md) and remove these with 'git rm --cached'." >&2
  exit 1
fi
echo "check-tracked-hygiene: ok"
