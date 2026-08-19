/**
 * Server-side UDP socket counters for the egress axis.
 *
 * Registered by `docs/research/preregistrations/egress.md` amendment 9. Every
 * send number this axis reports is a JS-side count of calls that returned;
 * nothing in the artifact said what the kernel did with them, and on a fan-out
 * step that blind spot is the whole forward direction.
 *
 * Diagnostic only: amendment 9 registers no threshold, no bucket and no STOP on
 * any of these, and no gate reads them. They are reported raw.
 *
 * Parsing is separated from the read so the fixture in `egress-socket.test.ts`
 * can exercise it on a host that has no `/proc`.
 */

import { readFileSync } from "node:fs";

export type UdpSnapshot = {
	inDatagrams: number;
	inErrors: number;
	rcvbufErrors: number;
	sndbufErrors: number;
	outDatagrams: number;
};

/**
 * Parse the `Udp:` pair of lines out of `/proc/net/snmp`.
 *
 * Columns are addressed by name, never by position: the kernel has added
 * counters to this table before and reading `IgnoredMulti` as `RcvbufErrors`
 * would be a silent wrong number rather than a missing one.
 */
export function parseUdpSnapshot(text: string): UdpSnapshot | null {
	const lines = text.split("\n");
	const headerIdx = lines.findIndex((l) => l.startsWith("Udp:"));
	if (headerIdx < 0 || !lines[headerIdx + 1]?.startsWith("Udp:")) return null;
	const keys = (lines[headerIdx] ?? "").trim().split(/\s+/).slice(1);
	const vals = (lines[headerIdx + 1] ?? "").trim().split(/\s+/).slice(1);
	const get = (key: string) => {
		const i = keys.indexOf(key);
		if (i < 0) return 0;
		const value = Number(vals[i] ?? 0);
		return Number.isFinite(value) ? value : 0;
	};
	return {
		inDatagrams: get("InDatagrams"),
		inErrors: get("InErrors"),
		rcvbufErrors: get("RcvbufErrors"),
		sndbufErrors: get("SndbufErrors"),
		outDatagrams: get("OutDatagrams"),
	};
}

/** Null off Linux, which is what the local macOS smoke records. */
export function readUdpStats(): UdpSnapshot | null {
	if (process.platform !== "linux") return null;
	try {
		return parseUdpSnapshot(readFileSync("/proc/net/snmp", "utf8"));
	} catch {
		return null;
	}
}

export function udpDelta(
	before: UdpSnapshot | null,
	after: UdpSnapshot | null,
): UdpSnapshot | null {
	if (!before || !after) return null;
	return {
		inDatagrams: after.inDatagrams - before.inDatagrams,
		inErrors: after.inErrors - before.inErrors,
		rcvbufErrors: after.rcvbufErrors - before.rcvbufErrors,
		sndbufErrors: after.sndbufErrors - before.sndbufErrors,
		outDatagrams: after.outDatagrams - before.outDatagrams,
	};
}

/**
 * Datagrams the server handed the socket over the window, divided by the
 * window's `OutDatagrams` delta.
 *
 * A `UDP_SEGMENT` send counts once at the UDP layer whatever the wire carries,
 * so a ratio materially above 1 is GSO amortising syscalls and a ratio at 1 is
 * one syscall per datagram. Null when there is no denominator to divide by.
 */
export function gsoAmortization(
	sent: number,
	delta: UdpSnapshot | null,
): number | null {
	if (!delta || delta.outDatagrams <= 0 || sent <= 0) return null;
	return sent / delta.outDatagrams;
}
