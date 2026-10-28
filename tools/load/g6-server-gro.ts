/**
 * The server NIC's generic-receive-offload state, carried through the c-32
 * campaign as a frozen input.
 *
 * With UDP GRO on, the kernel coalesces consecutive datagrams that share a
 * 4-tuple into one super-packet before the reuseport program runs. The
 * generator draws 30k sessions from 128 fixed source ports, so a super-packet
 * routinely carries segments belonging to different QUIC connections, and the
 * CID-steering program picks a shard from the first segment's connection ID
 * alone. Every other segment lands on a shard that has never seen its
 * connection and quinn discards it, with no counter anywhere recording a loss.
 * Turning GRO off is the A/B that decides whether that is what r91 measured.
 */

export type ServerGroMode = "on" | "off";

/** `SCAN_SERVER_GRO`: `on` (default, the NIC's own default) or `off`. */
export function resolveServerGroMode(value: string | undefined): ServerGroMode {
	if (value === undefined || value === "on") return "on";
	if (value === "off") return "off";
	throw new Error(
		`SCAN_SERVER_GRO must be on or off, got ${JSON.stringify(value)}`,
	);
}
