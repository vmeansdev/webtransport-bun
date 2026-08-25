#!/bin/bash
# The Mac generator's ssh entrypoint.
#
# A gate harness on the runner invokes this over ssh and gets back a load-client
# run plus the provenance needed to believe it. It exists because the off-box
# precedent does not transfer: the h7 sweep built `load-client` on the runner and
# `scp`ed it to the loadgen VM, which worked because both were Linux on the same
# frozen VHDX. This generator is macOS/arm64. A Linux runner cannot build its
# binary, so the Mac builds its own — and the moment it does, "which tree did the
# generator come from" stops being obvious and has to be reported.
#
# Two more things the precedent gets wrong on this host, both fatal rather than
# cosmetic:
#
#   * `timeout(1)` does not exist on macOS. `ssh dest timeout N load-client ...`
#     fails with "command not found" and the harness sees an empty run. The
#     watchdog below is that missing deadline.
#   * a non-interactive ssh shell gets a minimal PATH with no Homebrew and no
#     rustup shims, so `cargo` is not on it. PATH is set explicitly here.
#
# Usage (from the runner, over ssh):
#   ssh mac-gen tools/offbox/mac-generator-entry.sh \
#       --candidate <sha> --deadline 120 [--bin broadcast-client] \
#       -- --url https://10.99.0.1:4433 ...
#
# Contract: everything this prints on stdout that starts with `macgen:` is
# provenance for the harness to fold into its artifact; everything else is the
# selected binary's own stdout (`--bin`, default load-client), verbatim and
# unreordered, so existing parsers keep working. Exit status is the binary's,
# except 3 (provenance/build failure) and 4 (watchdog fired).

set -uo pipefail

CLONE="${WT_MACGEN_CLONE:-$HOME/wt-macgen}"
REMOTE="${WT_MACGEN_REMOTE:-origin}"
# A non-interactive ssh shell does not source a profile. Name the toolchain
# locations rather than hoping the login shell already found them.
# Linux twin of the Mac entry (G2 on rented rigs): same CLI, same provenance
# lines, same exit codes; only the toolchain defaults and the hash tool vary.
export PATH="${WT_MACGEN_PATH:-$HOME/.cargo/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

CANDIDATE=""
DEADLINE=300
PLAN=0
BIN_NAME="load-client"

while [ $# -gt 0 ]; do
  case "$1" in
    --candidate) CANDIDATE="${2:-}"; shift 2 ;;
    --deadline)  DEADLINE="${2:-}"; shift 2 ;;
    --clone)     CLONE="${2:-}"; shift 2 ;;
    --bin)       BIN_NAME="${2:-}"; shift 2 ;;
    --plan)      PLAN=1; shift ;;
    --) shift; break ;;
    *) echo "macgen: unknown argument $1" >&2; exit 3 ;;
  esac
done

# The generator is not one binary anymore: G10's far end is the subscriber
# fleet, not the datagram source. The selector is a closed set — a typo must
# refuse here, not cargo-build whatever string arrived.
case "$BIN_NAME" in
  load-client|broadcast-client) ;;
  *) echo "macgen: --bin must be load-client or broadcast-client, got '$BIN_NAME'" >&2; exit 3 ;;
esac

if [ -z "$CANDIDATE" ]; then
  echo "macgen: --candidate <sha> is required" >&2
  exit 3
fi
# A full 40-character object name, never a ref or an abbreviation. The effort's
# candidate rule is that SHAs come from `git rev-parse`; accepting a branch name
# here would let a generator drift from the tree the gate is stamped against.
case "$CANDIDATE" in
  *[!0-9a-f]* | "") echo "macgen: --candidate must be a full lowercase hex sha" >&2; exit 3 ;;
esac
if [ "${#CANDIDATE}" -ne 40 ]; then
  echo "macgen: --candidate must be a full 40-character sha, got ${#CANDIDATE}" >&2
  exit 3
fi

BIN="$CLONE/target/release/$BIN_NAME"

echo "macgen: host=$(hostname -s) arch=$(uname -m) os=$(uname -s)/$(uname -r)"
echo "macgen: clone=$CLONE candidate=$CANDIDATE bin=$BIN_NAME deadline=${DEADLINE}s"

if [ "$PLAN" -eq 1 ]; then
  echo "macgen: plan git -C $CLONE fetch --quiet $REMOTE"
  echo "macgen: plan git -C $CLONE checkout --detach --quiet $CANDIDATE"
  echo "macgen: plan cargo build --release -p reference --bin $BIN_NAME"
  echo "macgen: plan $BIN $*"
  exit 0
fi

if [ ! -d "$CLONE/.git" ]; then
  echo "macgen: no git clone at $CLONE — provision it first (see the cable runbook)" >&2
  exit 3
fi

BUILD_START=$(date +%s)
if ! git -C "$CLONE" fetch --quiet "$REMOTE" 2>&1; then
  echo "macgen: fetch from $REMOTE failed" >&2
  exit 3
fi
if ! git -C "$CLONE" checkout --detach --quiet "$CANDIDATE" 2>&1; then
  echo "macgen: candidate $CANDIDATE is not reachable in $CLONE" >&2
  exit 3
fi

HEAD=$(git -C "$CLONE" rev-parse HEAD)
if [ "$HEAD" != "$CANDIDATE" ]; then
  echo "macgen: checked out $HEAD but was asked for $CANDIDATE" >&2
  exit 3
fi
# A dirty tree is a different program from the candidate. Say so and stop rather
# than generating load from something no SHA describes.
DIRTY=$(git -C "$CLONE" status --porcelain)
if [ -n "$DIRTY" ]; then
  echo "macgen: clone at $CLONE is dirty; a generator must be exactly the candidate" >&2
  exit 3
fi

if ! ( cd "$CLONE" && cargo build --release -p reference --bin "$BIN_NAME" >&2 ); then
  echo "macgen: cargo build failed" >&2
  exit 3
fi
BUILD_SEC=$(( $(date +%s) - BUILD_START ))

if [ ! -x "$BIN" ]; then
  echo "macgen: $BIN missing after a successful build" >&2
  exit 3
fi

echo "macgen: head=$HEAD dirty=no build=ok buildSec=$BUILD_SEC"
echo "macgen: binary=$BIN sha256=$(sha256sum "$BIN" | awk '{print $1}')"
echo "macgen: rustc=$(rustc --version | awk '{print $2}') argv=$*"

# The watchdog. A dead ssh channel must not orphan a generator on this machine,
# and a generator that wedges must not hold a runner's dispatch open: the same
# reason the loadgen VM's invocation carried `timeout`, implemented locally
# because macOS has no such command.
"$BIN" "$@" &
CHILD=$!
# The watchdog holds NO channel file descriptors: `kill "$WATCHDOG"` below
# kills the subshell but not an already-running `sleep`, and an orphaned sleep
# that inherited stdout keeps the whole ssh channel open until the deadline
# expires — every conductor "linger" and every healthy-rung deadline breach of
# 2026-08-19/20 was this one inherited descriptor.
( sleep "$DEADLINE"; kill -0 "$CHILD" 2>/dev/null && kill -9 "$CHILD" 2>/dev/null ) >/dev/null 2>&1 0</dev/null &
WATCHDOG=$!

wait "$CHILD"
CODE=$?
kill "$WATCHDOG" 2>/dev/null
wait "$WATCHDOG" 2>/dev/null

# SIGKILL surfaces as 137. Distinguish "the deadline fired" from "load-client
# failed", because they route to different places: one is an infra fault the
# rerun policy recognises, the other is a result.
if [ "$CODE" -eq 137 ]; then
  echo "macgen: exit=watchdog deadline=${DEADLINE}s"
  exit 4
fi
echo "macgen: exit=$CODE"
exit "$CODE"
