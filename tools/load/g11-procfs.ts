/**
 * procfs instruments: host CPU, per-process CPU, host-wide UDP counters, and
 * per-socket drop attribution.
 *
 * Provenance: these are the stream axis's instruments (`bench-stream.ts` and
 * `gate-g5.ts` on `probe/stream-throughput-01`), by way of `g7-procfs.ts` on
 * `probe/g7-stream-egress-01`, copied here rather than imported so the two
 * probe branches stay independent (the `latency-clock.ts` precedent). G5b's
 * stamp was read through this arithmetic and a second version of it would be a
 * second place for it to drift.
 *
 * Two properties carry unchanged and matter to G11's falsifiers:
 *
 * - **Direction.** This gate's server both sends and receives on every stream,
 *   so both `RcvbufErrors` and `SndbufErrors` are server-side counters here.
 *   `/proc/net/snmp` is host-wide and a loopback rig sums both processes, so
 *   V-B's per-cell drop figure is computed against the *server's own socket*,
 *   found by its known local port.
 * - **A null is never a zero.** Every reader returns null when the counter is
 *   absent, and V-B fires on a null rather than grading it as no drops.
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

/**
 * Host load and thermal state, per the campaign common doc's §3 convention.
 *
 * The rig is a 35 W mobile APU, so a long cell can finish at a clock its first
 * seconds never saw. Reporting a capacity number without saying what the silicon
 * was doing underneath it is how "improvement everywhere" gets claimed on a
 * throttled box. Every field is `null` when its source is absent — a missing
 * sensor is never a zero, and never a cool reading.
 */
export type HostLoadSnapshot = {
	loadavg1: number | null;
	cpuMhzMean: number | null;
	cpuMhzMax: number | null;
	packageTempC: number | null;
	governor: string | null;
};

function readFirstLine(path: string): string | null {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
}

/** Mean and max of every core's current frequency, in MHz. */
export function readCpuMhz(): { mean: number | null; max: number | null } {
	if (!HAS_PROC) return { mean: null, max: null };
	const khz: number[] = [];
	for (let cpu = 0; ; cpu += 1) {
		const raw = readFirstLine(
			`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`,
		);
		if (raw === null) break;
		const value = Number(raw);
		if (Number.isFinite(value)) khz.push(value);
	}
	if (khz.length === 0) {
		// cpufreq is not always present; /proc/cpuinfo carries the same figure on
		// the kernels that lack it.
		const cpuinfo = readFirstLine("/proc/cpuinfo");
		if (cpuinfo === null) return { mean: null, max: null };
		for (const line of readFileSync("/proc/cpuinfo", "utf8").split("\n")) {
			if (!line.startsWith("cpu MHz")) continue;
			const value = Number(line.split(":")[1]?.trim());
			if (Number.isFinite(value)) khz.push(value * 1000);
		}
	}
	if (khz.length === 0) return { mean: null, max: null };
	const mhz = khz.map((k) => k / 1000);
	return {
		mean: mhz.reduce((a, b) => a + b, 0) / mhz.length,
		max: Math.max(...mhz),
	};
}

/**
 * Package temperature in °C. Prefers the AMD `k10temp` hwmon sensor, whose
 * `temp1` is Tctl; falls back to the first `x86_pkg_temp` thermal zone, then to
 * zone 0. Named rather than indexed because the zone numbering is not stable
 * across boots, and reading the wrong zone would report a chipset sensor as the
 * package.
 */
export function readPackageTempC(): number | null {
	if (!HAS_PROC) return null;
	for (let hwmon = 0; hwmon < 16; hwmon += 1) {
		const name = readFirstLine(`/sys/class/hwmon/hwmon${hwmon}/name`);
		if (name === null) continue;
		if (name !== "k10temp" && name !== "coretemp") continue;
		const milli = Number(
			readFirstLine(`/sys/class/hwmon/hwmon${hwmon}/temp1_input`),
		);
		if (Number.isFinite(milli)) return milli / 1000;
	}
	for (let zone = 0; zone < 16; zone += 1) {
		const type = readFirstLine(`/sys/class/thermal/thermal_zone${zone}/type`);
		if (type === null) continue;
		if (type !== "x86_pkg_temp" && type !== "k10temp") continue;
		const milli = Number(
			readFirstLine(`/sys/class/thermal/thermal_zone${zone}/temp`),
		);
		if (Number.isFinite(milli)) return milli / 1000;
	}
	return null;
}

export function readHostLoad(): HostLoadSnapshot {
	const loadavgRaw = HAS_PROC ? readFirstLine("/proc/loadavg") : null;
	const loadavg1 = Number(loadavgRaw?.split(/\s+/)[0]);
	const mhz = readCpuMhz();
	return {
		loadavg1: Number.isFinite(loadavg1) ? loadavg1 : null,
		cpuMhzMean: mhz.mean,
		cpuMhzMax: mhz.max,
		packageTempC: readPackageTempC(),
		governor: HAS_PROC
			? readFirstLine("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
			: null,
	};
}

/**
 * The registered base clock of the campaign rig's CPU (AMD Ryzen 5 3550H,
 * 2.1 GHz base / 3.7 GHz boost). A cell whose median core clock sits below the
 * *base* clock is not merely off boost — it is being held under the frequency
 * the part is specified to sustain, which is what "sustained throttling" means.
 * Registered on the G11 campaign page before the run; never tuned after one.
 */
export const RIG_BASE_CLOCK_MHZ = 2100;

/**
 * Whether a cell's clock samples show sustained throttling.
 *
 * The median, not the minimum: a single dip between two samples is scheduling,
 * not thermal. Null when no clock was readable, and a null is carried as a null
 * — an unmeasured clock is not a cool one.
 */
export function sustainedThrottle(
	cpuMhzSamples: readonly number[],
	baseClockMhz: number = RIG_BASE_CLOCK_MHZ,
): boolean | null {
	const usable = cpuMhzSamples.filter((v) => Number.isFinite(v));
	if (usable.length === 0) return null;
	const sorted = [...usable].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
	if (!Number.isFinite(median)) return null;
	return median < baseClockMhz;
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
