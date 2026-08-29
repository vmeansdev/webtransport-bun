#!/usr/bin/env bash
# Real two-host WS↔WT comparison on a single heavy Linux runner.
#
# "Real" here means: two processes on the same machine, but in
# separate network namespaces connected by a veth pair. The server
# runs in the `server` namespace on 10.99.0.2, the client runs in
# the `client` namespace on 10.99.0.1. The traffic crosses the veth
# link, which is a real network path with a real kernel routing
# table and a real tc qdisc — not loopback. Netem is applied to
# the server-side veth so the client->server direction is the
# impaired direction.
#
# Usage:
#   bash tools/compare/load/ws-wt-real.sh [--netem=delayMs,jitterMs] [--reps=N] [--samples=N]
#
# Env:
#   NETEM_DELAY_MS    (default 0)   one-way delay applied to client->server
#   NETEM_JITTER_MS   (default 0)   one-way jitter
#   REPS              (default 3)   reps per arm per scenario
#   SAMPLES_PER_REP   (default 50)  samples per rep
#   OUT_DIR           (default .release-evidence/transport-comparison/ws-wt-r0/campaign-r0/heavy-runner-$(date +%Y%m%d))
#   CERT_DIR          (default $HOME/.ws-wt-tls)  cert+key location on the runner
#
# Requires: bash, ip (iproute2), tc, sudo (for tc/netns), bun, openssl.
set -euo pipefail

NETEM_DELAY_MS="${NETEM_DELAY_MS:-0}"
NETEM_JITTER_MS="${NETEM_JITTER_MS:-0}"
REPS="${REPS:-3}"
SAMPLES_PER_REP="${SAMPLES_PER_REP:-50}"
CERT_DIR="${CERT_DIR:-$HOME/.ws-wt-tls}"
SERVER_IP="10.99.0.2"
CLIENT_IP="10.99.0.1"
WS_PORT=4446
WT_PORT=4447
SERVER_NAME="gravvene-dev-home"

OUT_DIR="${OUT_DIR:-.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/heavy-runner-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"

log() { echo "[ws-wt-real] $*" >&2; }

cleanup() {
	set +e
	log "tearing down namespaces"
	if [[ -n "${WT_PID:-}" ]]; then kill "$WT_PID" 2>/dev/null || true; fi
	if [[ -n "${WS_PID:-}" ]]; then kill "$WS_PID" 2>/dev/null || true; fi
	ip netns del server 2>/dev/null || true
	ip netns del client 2>/dev/null || true
}
trap cleanup EXIT

# Sanity: needs CAP_NET_ADMIN for netns + tc. sudo if not root.
if [[ $EUID -ne 0 ]]; then SUDO=sudo; else SUDO=""; fi
$SUDO ip netns add server 2>/dev/null || { log "failed to add server netns (need CAP_NET_ADMIN)"; exit 1; }
$SUDO ip netns add client 2>/dev/null || { log "failed to add client netns"; exit 1; }

log "creating veth pair server-veth <-> client-veth"
$SUDO ip link add server-veth type veth peer name client-veth
$SUDO ip link set server-veth netns server
$SUDO ip link set client-veth netns client

log "addressing server side"
$SUDO ip netns exec server ip addr add "${SERVER_IP}/24" dev server-veth
$SUDO ip netns exec server ip link set server-veth up
$SUDO ip netns exec server ip link set lo up

log "addressing client side"
$SUDO ip netns exec client ip addr add "${CLIENT_IP}/24" dev client-veth
$SUDO ip netns exec client ip link set client-veth up
$SUDO ip netns exec client ip link set lo up
$SUDO ip netns exec client ip route add default via "${SERVER_IP}" dev client-veth 2>/dev/null || true

if [[ "$NETEM_DELAY_MS" != "0" || "$NETEM_JITTER_MS" != "0" ]]; then
	log "applying netem delay=${NETEM_DELAY_MS}ms jitter=${NETEM_JITTER_MS}ms on server-veth (client->server direction)"
	$SUDO ip netns exec server tc qdisc add dev server-veth root netem delay "${NETEM_DELAY_MS}ms" "${NETEM_JITTER_MS}ms"
fi

# Sanity: client can ping server.
log "ping check"
$SUDO ip netns exec client ping -c 1 -W 2 "$SERVER_IP" | tail -2

# Sanity: the cert is present.
if [[ ! -f "$CERT_DIR/server.crt" || ! -f "$CERT_DIR/server.key" ]]; then
	log "generating self-signed cert in $CERT_DIR"
	mkdir -p "$CERT_DIR"
	openssl req -x509 -newkey rsa:2048 -nodes \
		-keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" -days 365 \
		-subj "/CN=${SERVER_NAME}" \
		-addext "subjectAltName=DNS:${SERVER_NAME},IP:${SERVER_IP}" \
		-addext "basicConstraints=CA:FALSE" \
		-addext "extendedKeyUsage=serverAuth" >/dev/null
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Start the WS echo server in the server namespace.
log "starting WS echo server on ${SERVER_IP}:${WS_PORT}"
$SUDO ip netns exec server \
	env RIG_ECHO_PORT="$WS_PORT" RIG_ECHO_BIND="$SERVER_IP" \
	PATH="$HOME/.bun/bin:$PATH" \
		"$REPO_ROOT/scripts/rig-min-echo-server.js" >/tmp/ws-echo.log 2>&1 &
WS_PID=$!

# Start the WT echo server in the server namespace.
log "starting WT echo server on ${SERVER_IP}:${WT_PORT}"
$SUDO ip netns exec server \
	env RIG_WT_ECHO_PORT="$WT_PORT" RIG_WT_ECHO_BIND="$SERVER_IP" \
	PATH="$HOME/.bun/bin:$PATH" \
		"$REPO_ROOT/scripts/rig-min-wt-echo-server.js" >/tmp/wt-echo.log 2>&1 &
WT_PID=$!

sleep 3

# Run the WS client in the client namespace.
log "running WS client"
$SUDO ip netns exec client \
	env SAMPLES_PER_REP="$SAMPLES_PER_REP" \
		"$REPO_ROOT/scripts/rig-measure-client.ts" \
		--server-url="wss://${SERVER_IP}:${WS_PORT}" \
		--scenario=ticker-fanout --reps="$REPS" \
		--out="$OUT_DIR/ws-ticker.json" \
		--deadline-ms=60000 \
		--ca="$CERT_DIR/server.crt" \
		--server-name="$SERVER_NAME" 2>&1 | tail -3 || log "WS ticker failed"

$SUDO ip netns exec client \
	env SAMPLES_PER_REP="$SAMPLES_PER_REP" \
		"$REPO_ROOT/scripts/rig-measure-client.ts" \
		--server-url="wss://${SERVER_IP}:${WS_PORT}" \
		--scenario=bulk-one-way --reps="$REPS" \
		--out="$OUT_DIR/ws-bulk.json" \
		--deadline-ms=120000 \
		--ca="$CERT_DIR/server.crt" \
		--server-name="$SERVER_NAME" 2>&1 | tail -3 || log "WS bulk failed"

# Run the WT client in the client namespace.
log "running WT client"
$SUDO ip netns exec client \
	env SAMPLES_PER_REP="$SAMPLES_PER_REP" \
		"$REPO_ROOT/scripts/rig-measure-wt-client.ts" \
		--server-url="https://${SERVER_IP}:${WT_PORT}" \
		--scenario=ticker-fanout --reps="$REPS" \
		--out="$OUT_DIR/wt-ticker.json" \
		--deadline-ms=60000 \
		--ca="$CERT_DIR/server.crt" \
		--server-name="$SERVER_NAME" 2>&1 | tail -3 || log "WT ticker failed"

$SUDO ip netns exec client \
	env SAMPLES_PER_REP="$SAMPLES_PER_REP" \
		"$REPO_ROOT/scripts/rig-measure-wt-client.ts" \
		--server-url="https://${SERVER_IP}:${WT_PORT}" \
		--scenario=bulk-one-way --reps="$REPS" \
		--out="$OUT_DIR/wt-bulk.json" \
		--deadline-ms=120000 \
		--ca="$CERT_DIR/server.crt" \
		--server-name="$SERVER_NAME" 2>&1 | tail -3 || log "WT bulk failed"

cat >"$OUT_DIR/SUMMARY.md" <<EOF
# WS↔WT real two-host comparison — heavy runner, $(date -u +%Y-%m-%dT%H:%M:%SZ)

| netem (one-way) | transport | scenario | samples | median | p95 | p99 | loss |
| --- | --- | --- | ---:| ---:| ---:| ---:| ---:|
| ${NETEM_DELAY_MS}ms + ${NETEM_JITTER_MS}ms | WebSocket | ticker-fanout | $(jq '.aggregate.count' "$OUT_DIR/ws-ticker.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.median' "$OUT_DIR/ws-ticker.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p95' "$OUT_DIR/ws-ticker.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p99' "$OUT_DIR/ws-ticker.json" 2>/dev/null || echo ?) | n/a |
| ${NETEM_DELAY_MS}ms + ${NETEM_JITTER_MS}ms | WebSocket | bulk-one-way | $(jq '.aggregate.count' "$OUT_DIR/ws-bulk.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.median' "$OUT_DIR/ws-bulk.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p95' "$OUT_DIR/ws-bulk.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p99' "$OUT_DIR/ws-bulk.json" 2>/dev/null || echo ?) | n/a |
| ${NETEM_DELAY_MS}ms + ${NETEM_JITTER_MS}ms | WebTransport | ticker-fanout | $(jq '.aggregate.received' "$OUT_DIR/wt-ticker.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.median' "$OUT_DIR/wt-ticker.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p95' "$OUT_DIR/wt-ticker.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p99' "$OUT_DIR/wt-ticker.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.loss' "$OUT_DIR/wt-ticker.json" 2>/dev/null || echo ?) |
| ${NETEM_DELAY_MS}ms + ${NETEM_JITTER_MS}ms | WebTransport | bulk-one-way | $(jq '.aggregate.received' "$OUT_DIR/wt-bulk.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.median' "$OUT_DIR/wt-bulk.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p95' "$OUT_DIR/wt-bulk.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.p99' "$OUT_DIR/wt-bulk.json" 2>/dev/null || echo ?) | $(jq -r '.aggregate.loss' "$OUT_DIR/wt-bulk.json" 2>/dev/null || echo ?) |

Setup: two Linux network namespaces \`server\` (10.99.0.2) and \`client\` (10.99.0.1) connected by a veth pair. Server processes bind 10.99.0.2; client processes connect to 10.99.0.2 over the veth. Netem applied to server-veth (client->server direction) with delay=${NETEM_DELAY_MS}ms and jitter=${NETEM_JITTER_MS}ms.

Servers: \`scripts/rig-min-echo-server.js\` (WS) and \`scripts/rig-min-wt-echo-server.js\` (WT), both minimal Bun echo servers, both using the same self-signed cert at \`$CERT_DIR/server.crt\` (CN=${SERVER_NAME}, SAN=DNS:${SERVER_NAME},IP:${SERVER_IP}, basicConstraints=CA:FALSE, extendedKeyUsage=serverAuth).

Clients: \`scripts/rig-measure-client.ts\` (WS) and \`scripts/rig-measure-wt-client.ts\` (WT). ${SAMPLES_PER_REP} samples × ${REPS} reps per arm per scenario.
EOF

log "wrote $OUT_DIR/{ws,wt}-{ticker,bulk}.json + SUMMARY.md"
ls -la "$OUT_DIR" | head -10
