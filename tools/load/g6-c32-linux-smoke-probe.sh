#!/usr/bin/env bash
set -euo pipefail

fail() {
	printf 'g6-c32-linux-smoke-probe: %s\n' "$*" >&2
	exit 1
}

[[ $# -eq 1 ]] || fail "usage: $0 <fixed-source-port|bounded-probe|steering|bpf|cleanup>"
KIND=$1
BUN_BIN=${G6_C32_BUN_BIN:-/opt/g6/bin/bun}
ROLE=${G6_C32_PROBE_ROLE:-}
STATE_ROOT=${G6_C32_PROBE_STATE_ROOT:-}
PORT=${G6_C32_PROBE_PORT:-45433}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPOSITORY=$(cd "$SCRIPT_DIR/../.." && pwd)
PROBE="$SCRIPT_DIR/g6-c32-linux-smoke-probe.ts"

[[ -x "$BUN_BIN" ]] || fail "Bun binary is missing or not executable: $BUN_BIN"
[[ "$STATE_ROOT" == /* && "$STATE_ROOT" != "/" ]] || fail "G6_C32_PROBE_STATE_ROOT must be an absolute non-root directory"
[[ -f "$PROBE" ]] || fail "probe implementation is missing: $PROBE"

run_probe() {
	"$BUN_BIN" "$PROBE" "$@"
}

stop_daemon() {
	if [[ -d "$STATE_ROOT" ]]; then
		run_probe stop --state-root "$STATE_ROOT"
	fi
}

case "$KIND" in
	fixed-source-port)
		[[ "$ROLE" == "generator" ]] || fail "fixed-source-port requires generator role"
		exec "$BUN_BIN" "$PROBE" fixed-source-port \
			--state-root "$STATE_ROOT" --base 45000 --count 512
		;;
	bounded-probe)
		[[ "$ROLE" == "server" || "$ROLE" == "generator" ]] || fail "bounded-probe requires server or generator role"
		if [[ "$ROLE" == "server" ]]; then
			[[ ! -e "$STATE_ROOT/daemon-ready.json" ]] || fail "reuseport daemon readiness already exists"
			mkdir -p "$STATE_ROOT"
			"$BUN_BIN" "$PROBE" daemon --state-root "$STATE_ROOT" \
				--repository "$REPOSITORY" --port "$PORT" \
				</dev/null >"$STATE_ROOT/daemon.stdout" 2>"$STATE_ROOT/daemon.stderr" &
			daemon_pid=$!
			ready_deadline=$((SECONDS + 45))
			until [[ -f "$STATE_ROOT/daemon-ready.json" ]]; do
				if [[ -f "$STATE_ROOT/daemon-failure.json" ]] || ! kill -0 "$daemon_pid" 2>/dev/null; then
					wait "$daemon_pid" 2>/dev/null || true
					fail "reuseport daemon failed before readiness"
				fi
				(( SECONDS < ready_deadline )) || {
					stop_daemon || true
					fail "reuseport daemon readiness timed out"
				}
				sleep 0.05
			done
		fi
		exec "$BUN_BIN" "$PROBE" bounded-probe --state-root "$STATE_ROOT" \
			--repository "$REPOSITORY" --bun "$BUN_BIN" --role "$ROLE"
		;;
	steering)
		[[ "$ROLE" == "server" ]] || fail "steering requires server role"
		exec "$BUN_BIN" "$PROBE" steering --state-root "$STATE_ROOT"
		;;
	bpf)
		[[ "$ROLE" == "server" ]] || fail "bpf requires server role"
		temporary=$(mktemp "$STATE_ROOT/bpf-output.XXXXXX")
		trap 'stop_daemon >/dev/null 2>&1 || true; rm -f "$temporary"' EXIT INT TERM HUP
		run_probe bpf --state-root "$STATE_ROOT" >"$temporary"
		stop_daemon
		cat "$temporary"
		rm -f "$temporary"
		trap - EXIT INT TERM HUP
		;;
	cleanup)
		stop_daemon
		;;
	*)
		fail "unknown probe kind: $KIND"
		;;
esac
