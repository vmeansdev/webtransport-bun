import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type UdpSocketCounters = {
	socketCount: number;
	udp4SocketCount: number;
	udp6SocketCount: number;
	txQueueBytes: number;
	rxQueueBytes: number;
	drops: number;
};

export type HostUdpCounters = {
	InDatagrams: number;
	NoPorts: number;
	InErrors: number;
	OutDatagrams: number;
	RcvbufErrors: number;
	SndbufErrors: number;
};

const HOST_UDP_COUNTER_FIELDS = [
	"InDatagrams",
	"NoPorts",
	"InErrors",
	"OutDatagrams",
	"RcvbufErrors",
	"SndbufErrors",
] as const;

type ParsedUdpTable = Omit<
	UdpSocketCounters,
	"udp4SocketCount" | "udp6SocketCount"
>;

export function parseHostUdpCounters(text: string): HostUdpCounters | null {
	const udpLines = text
		.split(/\r?\n/)
		.filter((line) => line.trimStart().startsWith("Udp:"));
	const [header, values] = udpLines;
	if (!header || !values) return null;

	const keys = header.trim().split(/\s+/).slice(1);
	const rawValues = values.trim().split(/\s+/).slice(1);
	const counters = {} as HostUdpCounters;
	for (const field of HOST_UDP_COUNTER_FIELDS) {
		const index = keys.indexOf(field);
		if (index < 0 || keys.lastIndexOf(field) !== index) return null;
		const rawValue = rawValues[index];
		if (!rawValue || !/^\d+$/.test(rawValue)) return null;
		const value = Number(rawValue);
		if (!Number.isSafeInteger(value)) return null;
		counters[field] = value;
	}
	return counters;
}

export function deltaHostUdpCounters(
	before: HostUdpCounters | null | undefined,
	after: HostUdpCounters | null | undefined,
): HostUdpCounters | null {
	if (!before || !after) return null;
	const delta = {} as HostUdpCounters;
	for (const field of HOST_UDP_COUNTER_FIELDS) {
		const beforeValue = before[field];
		const afterValue = after[field];
		if (
			!Number.isSafeInteger(beforeValue) ||
			!Number.isSafeInteger(afterValue) ||
			beforeValue < 0 ||
			afterValue < beforeValue
		) {
			return null;
		}
		delta[field] = afterValue - beforeValue;
	}
	return delta;
}

export function selectMidpointSample<T extends { tsMs: number }>(
	samples: readonly T[],
	connectStartTsMs: number,
	connectEndTsMs: number,
): { sample: T; targetTsMs: number; offsetMs: number } | null {
	if (samples.length === 0 || connectEndTsMs < connectStartTsMs) return null;
	const targetTsMs = connectStartTsMs + (connectEndTsMs - connectStartTsMs) / 2;
	let sample = samples[0] as T;
	for (const candidate of samples.slice(1)) {
		if (
			Math.abs(candidate.tsMs - targetTsMs) < Math.abs(sample.tsMs - targetTsMs)
		) {
			sample = candidate;
		}
	}
	return { sample, targetTsMs, offsetMs: sample.tsMs - targetTsMs };
}

export function parseConnectErrorsSample(
	lines: readonly string[],
): string[] | null {
	for (const line of lines.toReversed()) {
		const marker = "mmo-client: json ";
		const markerIndex = line.indexOf(marker);
		if (markerIndex < 0) continue;
		try {
			const parsed = JSON.parse(line.slice(markerIndex + marker.length)) as {
				connectErrorsSample?: unknown;
			};
			if (
				Array.isArray(parsed.connectErrorsSample) &&
				parsed.connectErrorsSample.every((entry) => typeof entry === "string")
			) {
				return parsed.connectErrorsSample;
			}
		} catch {
			return null;
		}
	}
	return null;
}

export function parseOwnedUdpSocketTable(
	text: string,
	ownedInodes: ReadonlySet<string>,
): ParsedUdpTable {
	const byInode = parseUdpSocketTableByInode(text);
	const counters: ParsedUdpTable = {
		socketCount: 0,
		txQueueBytes: 0,
		rxQueueBytes: 0,
		drops: 0,
	};
	for (const inode of ownedInodes) {
		const row = byInode.get(inode);
		if (!row) continue;
		counters.socketCount += row.socketCount;
		counters.txQueueBytes += row.txQueueBytes;
		counters.rxQueueBytes += row.rxQueueBytes;
		counters.drops += row.drops;
	}
	return counters;
}

function parseUdpSocketTableByInode(text: string): Map<string, ParsedUdpTable> {
	const rows = new Map<string, ParsedUdpTable>();
	for (const line of text.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 10) continue;
		const inode = fields[9] ?? "";
		const [txHex, rxHex] = (fields[4] ?? "").split(":");
		if (!inode || !txHex || !rxHex) continue;
		const txQueueBytes = Number.parseInt(txHex, 16);
		const rxQueueBytes = Number.parseInt(rxHex, 16);
		const drops = Number.parseInt(fields.at(-1) ?? "", 10);
		if (![txQueueBytes, rxQueueBytes, drops].every(Number.isFinite)) continue;
		rows.set(inode, {
			socketCount: 1,
			txQueueBytes,
			rxQueueBytes,
			drops,
		});
	}
	return rows;
}

/**
 * Parse the shared network-namespace UDP tables once and attribute rows to
 * their owning shard. All shard workers on the diagnostic server share one
 * network namespace, so rereading /proc/<pid>/net/udp for every shard only
 * repeats identical I/O and can perturb short connect windows.
 */
export function parseOwnedUdpSocketTablesByShard(
	targets: readonly {
		serverId: number;
		pid: number;
		inodes: ReadonlySet<string>;
	}[],
	udp4Text: string,
	udp6Text: string,
): Map<number, UdpSocketCounters> {
	const udp4ByInode = parseUdpSocketTableByInode(udp4Text);
	const udp6ByInode = parseUdpSocketTableByInode(udp6Text);
	const result = new Map<number, UdpSocketCounters>();
	for (const target of targets) {
		const udp4 = sumOwnedSocketRows(udp4ByInode, target.inodes);
		const udp6 = sumOwnedSocketRows(udp6ByInode, target.inodes);
		result.set(target.serverId, {
			socketCount: udp4.socketCount + udp6.socketCount,
			udp4SocketCount: udp4.socketCount,
			udp6SocketCount: udp6.socketCount,
			txQueueBytes: udp4.txQueueBytes + udp6.txQueueBytes,
			rxQueueBytes: udp4.rxQueueBytes + udp6.rxQueueBytes,
			drops: udp4.drops + udp6.drops,
		});
	}
	return result;
}

function sumOwnedSocketRows(
	rows: ReadonlyMap<string, ParsedUdpTable>,
	ownedInodes: ReadonlySet<string>,
): ParsedUdpTable {
	const counters: ParsedUdpTable = {
		socketCount: 0,
		txQueueBytes: 0,
		rxQueueBytes: 0,
		drops: 0,
	};
	for (const inode of ownedInodes) {
		const row = rows.get(inode);
		if (!row) continue;
		counters.socketCount += row.socketCount;
		counters.txQueueBytes += row.txQueueBytes;
		counters.rxQueueBytes += row.rxQueueBytes;
		counters.drops += row.drops;
	}
	return counters;
}

export function ownedSocketInodes(pid: number): Set<string> {
	const inodes = new Set<string>();
	for (const fd of readdirSync(`/proc/${pid}/fd`)) {
		try {
			const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			const match = target.match(/^socket:\[(\d+)\]$/);
			if (match) inodes.add(match[1] as string);
		} catch {
			// The process can close an fd between readdir and readlink.
		}
	}
	return inodes;
}

export function readUdpSocketsForInodes(
	pid: number,
	ownedInodes: ReadonlySet<string>,
): UdpSocketCounters | null {
	try {
		const udp4 = parseOwnedUdpSocketTable(
			readFileSync(`/proc/${pid}/net/udp`, "utf8"),
			ownedInodes,
		);
		let udp6: ParsedUdpTable = {
			socketCount: 0,
			txQueueBytes: 0,
			rxQueueBytes: 0,
			drops: 0,
		};
		try {
			udp6 = parseOwnedUdpSocketTable(
				readFileSync(`/proc/${pid}/net/udp6`, "utf8"),
				ownedInodes,
			);
		} catch {
			// IPv6 can be disabled on the host.
		}
		return {
			socketCount: udp4.socketCount + udp6.socketCount,
			udp4SocketCount: udp4.socketCount,
			udp6SocketCount: udp6.socketCount,
			txQueueBytes: udp4.txQueueBytes + udp6.txQueueBytes,
			rxQueueBytes: udp4.rxQueueBytes + udp6.rxQueueBytes,
			drops: udp4.drops + udp6.drops,
		};
	} catch {
		return null;
	}
}

export function readPerProcessUdpSockets(
	pid: number,
): UdpSocketCounters | null {
	try {
		const ownedInodes = ownedSocketInodes(pid);
		return readUdpSocketsForInodes(pid, ownedInodes);
	} catch {
		return null;
	}
}

export function parseVmRssKb(text: string): number | null {
	const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
	if (!match) return null;
	const kb = Number(match[1]);
	return Number.isSafeInteger(kb) && kb >= 0 ? kb : null;
}

export function parseMeminfoKb(
	text: string,
): { totalKb: number; availableKb: number } | null {
	const grab = (key: string): number | null => {
		const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
		if (!match) return null;
		const kb = Number(match[1]);
		return Number.isSafeInteger(kb) && kb >= 0 ? kb : null;
	};
	const totalKb = grab("MemTotal");
	const availableKb = grab("MemAvailable");
	return totalKb === null || availableKb === null
		? null
		: { totalKb, availableKb };
}

export function readProcessRssKb(pid: number): number | null {
	try {
		return parseVmRssKb(readFileSync(`/proc/${pid}/status`, "utf8"));
	} catch {
		return null;
	}
}

export function readHostMemoryKb(): {
	totalKb: number;
	availableKb: number;
} | null {
	try {
		return parseMeminfoKb(readFileSync("/proc/meminfo", "utf8"));
	} catch {
		return null;
	}
}

// The generator host is sampled over SSH as three sections separated by this
// marker: /proc/loadavg, /proc/meminfo, then the /proc/<pid>/status of every
// mmo-client process (possibly none before the client is spawned).
export const GENERATOR_SAMPLE_SEPARATOR = "---g6-generator-sample---";

export type GeneratorHostSample = {
	loadavg: { "1": number; "5": number; "15": number };
	memoryKb: { totalKb: number; availableKb: number } | null;
	clientRssKb: number | null;
};

export function parseGeneratorHostSample(
	text: string,
): GeneratorHostSample | null {
	const sections = text.split(GENERATOR_SAMPLE_SEPARATOR);
	if (sections.length !== 3) return null;
	const [loadText, meminfoText, statusText] = sections as [
		string,
		string,
		string,
	];
	const fields = loadText.trim().split(/\s+/);
	const loads = fields.slice(0, 3).map(Number);
	if (loads.length !== 3 || loads.some((value) => !Number.isFinite(value))) {
		return null;
	}
	const rssValues = [...statusText.matchAll(/^VmRSS:\s+(\d+)\s+kB$/gm)]
		.map((match) => Number(match[1]))
		.filter((kb) => Number.isSafeInteger(kb) && kb >= 0);
	return {
		loadavg: {
			"1": loads[0] as number,
			"5": loads[1] as number,
			"15": loads[2] as number,
		},
		memoryKb: parseMeminfoKb(meminfoText),
		clientRssKb:
			rssValues.length === 0
				? null
				: rssValues.reduce((sum, kb) => sum + kb, 0),
	};
}
