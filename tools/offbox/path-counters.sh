#!/bin/sh
# Snapshot every packet counter along the bench path that can name a drop
# point. Run on either end (auto-detects OS), before and after a burst sweep;
# diffing two snapshots attributes the loss to a hop. Output is plain
# label:value lines, stable enough to diff.
#
#   ./path-counters.sh <tag>     # prints a tagged snapshot to stdout
set -eu

TAG="${1:-snap}"
echo "== path-counters $TAG $(uname -s) $(date -u +%H:%M:%SZ)"

case "$(uname -s)" in
Darwin)
	# The Mac sink: socket-buffer overflows are the receiver's own drops.
	netstat -s -p udp | sed -n 's/^[[:space:]]*//p' | grep -Ei \
		"dropped|full socket|overflow|received|delivered" | sed 's/^/udp: /'
	# The USB NIC's own view, if it exposes one.
	netstat -id 2>/dev/null | awk 'NR==1 || /en[0-9]/' | sed 's/^/if: /'
	sysctl net.inet.udp.recvspace kern.ipc.maxsockbuf 2>/dev/null | sed 's/^/sysctl: /'
	;;
Linux)
	# The runner VM: send-side and receive-side kernel UDP plus the NIC queue.
	grep -E "^Udp:" /proc/net/snmp | sed 's/^/snmp /'
	ip -s -s link show 2>/dev/null | sed -n '/eth0/,/^[0-9]/p' | sed 's/^/link: /'
	tc -s qdisc show dev eth0 2>/dev/null | sed 's/^/qdisc: /'
	ethtool -S eth0 2>/dev/null | grep -Ei "drop|discard|fifo|err" | sed 's/^/nic: /' || true
	;;
esac
