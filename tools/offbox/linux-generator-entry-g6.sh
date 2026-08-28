#!/bin/bash
# Linux generator's ssh entrypoint — G6's variant.
#
# Linux twin of tools/offbox/mac-generator-entry-g6.sh. The mac script is
# pinned by G2's PD-1 pre-flight (sha256 e21c43eb…) and must not be edited;
# a Linux generator (Ubuntu 26.04 on DigitalOcean c-32-intel) needs its own
# entrypoint because:
#
#   * `shasum -a 256` is BSD/macOS; on Linux it's `sha256sum`.
#   * `cargo` lives at $HOME/.cargo/bin, not /opt/homebrew/bin.
#
# Same provenance contract as the mac twin: provenance lines start with
# `macgen:` (kept for harness compatibility — the conductor parses by
# prefix, not by host). Exit codes match: 3 (provenance/build failure),
# 4 (watchdog fired), else the binary's exit code.
#
# Usage (from the runner, over ssh):
#   ssh linux-gen tools/offbox/linux-generator-entry-g6.sh \
#       --candidate <sha> --deadline 300 [--bin mmo-client] \
#       -- --url https://10.99.0.1:4433 ...

set -uo pipefail

CLONE="${WT_LINUXGEN_CLONE:-$HOME/wtb}"
REMOTE="${WT_LINUXGEN_REMOTE:-origin}"
# A non-interactive ssh shell does not source a profile. Name the toolchain
# locations rather than hoping the login shell already found them.
export PATH="${WT_LINUXGEN_PATH:-$HOME/.cargo/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin}"

CANDIDATE=""
DEADLINE=300
PLAN=0
BIN_NAME="load-client"
CONNECT_TIMEOUT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --candidate) CANDIDATE="$2"; shift 2 ;;
        --deadline) DEADLINE="$2"; shift 2 ;;
        --plan) PLAN=1; shift ;;
        --bin) BIN_NAME="$2"; shift 2 ;;
        --rss-limit) export MMO_CLIENT_RSS_LIMIT_MB="$2"; shift 2 ;;
        --connect-timeout) CONNECT_TIMEOUT="$2"; shift 2 ;;
        --) shift; break ;;
        *) echo "macgen: unknown arg $1" >&2; exit 3 ;;
    esac
done

if [ -z "$CANDIDATE" ]; then
    echo "macgen: --candidate is required" >&2
    exit 3
fi
case "$CONNECT_TIMEOUT" in
	""|*[!0-9]*)
		if [ -n "$CONNECT_TIMEOUT" ]; then
			echo "macgen: --connect-timeout must be a positive integer" >&2
			exit 3
		fi
		;;
	0)
		echo "macgen: --connect-timeout must be a positive integer" >&2
		exit 3
		;;
esac

CLIENT_ARGS=("$@")
if [ -n "$CONNECT_TIMEOUT" ]; then
	CLIENT_ARGS+=("--connect-timeout-secs" "$CONNECT_TIMEOUT")
fi

BIN="$CLONE/target/release/$BIN_NAME"

if [ "$PLAN" -eq 1 ]; then
    echo "macgen: plan git -C $CLONE fetch --quiet $REMOTE"
    echo "macgen: plan git -C $CLONE checkout --detach --quiet $CANDIDATE"
    echo "macgen: plan cargo build --release -p reference --bin $BIN_NAME"
    echo "macgen: plan $BIN ${CLIENT_ARGS[*]}"
    exit 0
fi

if [ ! -d "$CLONE/.git" ]; then
    echo "macgen: no git clone at $CLONE — provision it first" >&2
    exit 3
fi

BUILD_START=$(date +%s)
if ! git -C "$CLONE" rev-parse "$CANDIDATE" >/dev/null 2>&1; then
    if ! git -C "$CLONE" fetch --quiet "$REMOTE" 2>&1; then
        echo "macgen: fetch from $REMOTE failed" >&2
        exit 3
    fi
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
# A dirty tree is a different build input from the candidate. Include
# untracked files because .cargo/config.toml and similar inputs can change the
# generated binary without changing HEAD. Ignored build outputs remain ignored.
DIRTY=$(git -C "$CLONE" status --porcelain --untracked-files=all)
if [ -n "$DIRTY" ]; then
	echo "macgen: clone at $CLONE is dirty; a generator must be exactly the candidate" >&2
	printf '%s\n' "$DIRTY" | head -20 >&2
	exit 3
fi

echo "macgen: building $BIN (release)..."
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
echo "macgen: rustc=$(rustc --version | awk '{print $2}') argv=${CLIENT_ARGS[*]}"

# The watchdog. A dead ssh channel must not orphan a generator on this
# machine, and a generator that wedges must not hold a runner's dispatch
# open. Same shape as the mac twin: no inherited FDs.
"$BIN" "${CLIENT_ARGS[@]}" &
CHILD=$!
( sleep "$DEADLINE"; kill -0 "$CHILD" 2>/dev/null && kill -9 "$CHILD" 2>/dev/null ) >/dev/null 2>&1 &
WATCHDOG=$!

wait "$CHILD"
CODE=$?
kill "$WATCHDOG" 2>/dev/null
wait "$WATCHDOG" 2>/dev/null

if [ "$CODE" -eq 137 ]; then
    echo "macgen: exit=watchdog deadline=${DEADLINE}s"
    exit 4
fi
echo "macgen: exit=$CODE"
exit "$CODE"
