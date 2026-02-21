#!/bin/sh
# Phase 13.1: Produce checksums for prebuilt .node artifacts.
set -e
cd "$(dirname "$0")/.."
find crates/native -name "*.node" -not -name "*.bak" 2>/dev/null | while read f; do
  echo "$(shasum -a 256 "$f" | cut -d' ' -f1)  $(basename "$f")"
done
