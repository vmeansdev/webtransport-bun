/**
 * procfs instruments: host CPU, per-process CPU, host-wide UDP counters, and
 * per-socket drop attribution.
 *
 * Provenance: these are the stream axis's instruments (`bench-stream.ts` and
 * `gate-g5.ts` on `probe/stream-throughput-01`), lifted here so G7 measures with
 * the same arithmetic every other axis on this rig used. Two things are
 * G7-specific and are marked where they occur:
 *
 * - the **direction**. G7's server is the sender, so `SndbufErrors` is the
 *   server-side counter and `RcvbufErrors` is the *sink's*. Both are host-wide
 *   in `/proc/net/snmp`, so the receive clause is computed against the sink's
 *   own socket, found by the local port the sink prints.
 * - a **null is never a zero**. Every reader returns null when the counter is
 *   absent, and the classifier refuses to grade an unmeasured drop count.
 */

import { readFileSync } from "node:fs";

export const HAS_PROC = (() => {
	try {
		readFileSync("/proc/stat", "utf8");
		return true;
	} catch {
		return false;
	}
})();

export type CpuSnapshot = { busy: number; total: number };

export function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { busy: total - idle, total };
}

export function hostCpuPct(
	prev: CpuSnapshot | null,
	next: CpuSnapshot | null,
): number | null {
	if (!prev || !next || next.total === prev.total) return null;
	return ((next.busy - prev.busy) / (next.total - prev.total)) * 100;
}

/**
 * utime+stime for a pid, in clock ticks. Null once the process is gone, so a
 * caller keeps its last successful reading as that process's total.
 */
export function readPidCpuTicks(pid: number): number | null {
	if (!HAS_PROC) return null;
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const afterComm = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	const utime = Number(afterComm[11] ?? Number.NaN);
	const stime = Number(afterComm[12] ?? Number.NaN);
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
	return utime + stime;
}

export const CLOCK_TICKS_PER_SEC = 100;

/** Percent of one core, over a window. Never cumulative (spec §Metric definitions). */
export function pidCpuPct(
	prevTicks: number | null,
	nextTicks: number | null,
	windowSec: number,
): number | null {
	if (prevTicks === null || nextTicks === null || windowSec <= 0) return null;
	return ((nextTicks - prevTicks) / CLOCK_TICKS_PER_SEC / windowSec) * 100;
}

export type UdpSnapshot = {
	inDatagrams: number;
	inErrors: number;
	rcvbufErrors: number;
	sndbufErrors: number;
	outDatagrams: number;
};

export function readUdpStats(): UdpSnapshot | null {
	if (!HAS_PROC) return null;
	const lines = readFileSync("/proc/net/snmp", "utf8").split("\n");
	const headerIdx = lines.findIndex((l) => l.startsWith("Udp:"));
	if (headerIdx < 0 || !lines[headerIdx + 1]?.startsWith("Udp:")) return null;
	const keys = (lines[headerIdx] ?? "").trim().split(/\s+/).slice(1);
	const vals = (lines[headerIdx + 1] ?? "").trim().split(/\s+/).slice(1);
	const get = (key: string) => {
		const i = keys.indexOf(key);
		return i >= 0 ? Number(vals[i] ?? 0) : 0;
	};
	return {
		inDatagrams: get("InDatagrams"),
		inErrors: get("InErrors"),
		rcvbufErrors: get("RcvbufErrors"),
		sndbufErrors: get("SndbufErrors"),
		outDatagrams: get("OutDatagrams"),
	};
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

export type SocketDropRow = {
	localPort: number;
	rxQueueBytes: number;
	drops: number;
};

/**
 * Rows of /proc/net/udp{,6} for one local port. A row that does not parse is
 * skipped rather than counted as zero — a silently-zero drop count is the one
 * failure mode this instrument must not have.
 */
export function parseUdpSocketRows(
	text: string,
	localPort: number,
): SocketDropRow[] {
	const out: SocketDropRow[] = [];
	for (const line of text.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 13) continue;
		const local = f[1] ?? "";
		const colon = local.lastIndexOf(":");
		if (colon < 0) continue;
		const port = Number.parseInt(local.slice(colon + 1), 16);
		if (!Number.isFinite(port) || port !== localPort) continue;
		const queues = (f[4] ?? "").split(":");
		const rxQueueBytes = Number.parseInt(queues[1] ?? "", 16);
		const drops = Number.parseInt(f[f.length - 1] ?? "", 10);
		if (!Number.isFinite(drops)) continue;
		out.push({
			localPort: port,
			rxQueueBytes: Number.isFinite(rxQueueBytes) ? rxQueueBytes : 0,
			drops,
		});
	}
	return out;
}

export type SocketSnapshot = {
	drops: number;
	rxQueueBytes: number;
	sockets: number;
};

export function summarizeSockets(rows: SocketDropRow[]): SocketSnapshot {
	return {
		drops: rows.reduce((a, r) => a + r.drops, 0),
		rxQueueBytes: rows.reduce((a, r) => a + r.rxQueueBytes, 0),
		sockets: rows.length,
	};
}

/**
 * Per-socket stats for one local port, or null when procfs is absent or no
 * socket matched. Null, never zero: an unmatched socket is an unmeasured drop
 * count and the classifier treats it as one.
 */
export function socketStatsForPort(port: number): SocketSnapshot | null {
	if (!HAS_PROC) return null;
	const rows: SocketDropRow[] = [];
	for (const path of ["/proc/net/udp", "/proc/net/udp6"]) {
		try {
			rows.push(...parseUdpSocketRows(readFileSync(path, "utf8"), port));
		} catch {
			// A missing udp6 on a v4-only kernel is not a failure; the empty-rows
			// check below catches a missing udp.
		}
	}
	if (rows.length === 0) return null;
	return summarizeSockets(rows);
}
