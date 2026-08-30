#!/usr/bin/env bash
# ============================================================================
# G6 sharded-scan BPF bring-up (informal harness, run as root on the runner)
# ============================================================================
#
# Adapts examples/quic-lb/attach.sh.example for the scan: builds
# steer_by_cid.bpf.c, loads + pins program and maps under $PIN_DIR, and
# populates slot_by_server_id for server IDs [00 01]..[00 0N] -> slots 0..N-1.
# The attach step the example calls impossible is done by the servers
# themselves via the `reusePortSteering` option (shard 1 attaches; every
# shard inserts its own socket fd).
#
# Usage: sudo g6-shard-bpf-setup.sh [N-instances, default 4]
set -euo pipefail

INSTANCES=${1:-4}
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
SRC="$REPO_DIR/examples/quic-lb/steer_by_cid.bpf.c"
PIN_DIR=${PIN_DIR:-/sys/fs/bpf/quic-lb}
BPF_OBJ=${BPF_OBJ:-/tmp/steer_by_cid.bpf.o}
READY_RECEIPT=${G6_BPF_READY_RECEIPT:-/var/tmp/g6-shard-bpf-ready.json}

if [[ "$(printf '\1\0\0\0' | od -An -tu4 | tr -d '[:space:]')" != "1" ]]; then
	echo "host is big-endian; reverse the slot value octets" >&2
	exit 70
fi

# Idempotent: tear down any previous pin dir so reruns start clean.
rm -rf "$PIN_DIR"
mkdir -p "$PIN_DIR"

# -target bpf drops the host's multiarch include path, so asm/types.h (a
# x86_64-linux-gnu-only header) vanishes; put it back explicitly.
MULTIARCH=$(gcc -print-multiarch 2>/dev/null || echo x86_64-linux-gnu)
clang -O2 -g -target bpf -D__TARGET_ARCH_x86 \
	-DMAX_INSTANCES="$INSTANCES" \
	-I"/usr/include/$MULTIARCH" -c "$SRC" -o "$BPF_OBJ"
bpftool prog loadall "$BPF_OBJ" "$PIN_DIR" pinmaps "$PIN_DIR"
bpftool prog show pinned "$PIN_DIR/steer_by_cid"
bpftool map show pinned "$PIN_DIR/socks"

for ((i = 1; i <= INSTANCES; i++)); do
	slot=$((i - 1))
	# shellcheck disable=SC2046 — bpftool wants one argv token per byte, so
	# the substitution must word-split (the .example quotes it and fails).
	bpftool map update pinned "$PIN_DIR/slot_by_server_id" \
		key hex 00 "$(printf '%02x' "$i")" 00 00 00 00 00 00 \
		value hex $(printf '%02x %02x %02x %02x' \
			$((slot & 0xff)) $((slot >> 8 & 0xff)) \
			$((slot >> 16 & 0xff)) $((slot >> 24 & 0xff)))
done
bpftool map dump pinned "$PIN_DIR/slot_by_server_id"
created_at_ms=$(date +%s%3N)
recorded_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
receipt_dir=$(dirname "$READY_RECEIPT")
mkdir -p "$receipt_dir"
tmp_receipt="$receipt_dir/.g6-shard-bpf-ready.$$"
printf '{"schema":"g6-shard-bpf-ready/1","recordedAt":"%s","createdAtMs":%s,"instances":%s}\n' \
	"$recorded_at" "$created_at_ms" "$INSTANCES" > "$tmp_receipt"
mv -f "$tmp_receipt" "$READY_RECEIPT"
echo "g6-shard-bpf-setup: OK pin_dir=$PIN_DIR instances=$INSTANCES"
