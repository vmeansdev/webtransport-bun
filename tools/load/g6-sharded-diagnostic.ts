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

/** Strict probe-only parser. Generic diagnostic callers retain their old helper. */
function strictUdpRows(
	text: string,
	family: 4 | 6,
): Map<string, UdpSocketCounters> {
	const lines = text.trim().split(/\r?\n/);
	const header = `sl local_address ${family === 4 ? "rem_address" : "remote_address"} st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode ref pointer drops`;
	if (lines[0]?.trim().split(/\s+/).join(" ") !== header)
		throw Error("UDP table header unavailable or malformed");
	const rows = new Map<string, UdpSocketCounters>();
	for (const line of lines.slice(1)) {
		const fields = line.trim().split(/\s+/),
			inode = fields[9];
		const queues = fields[4]?.match(/^([a-fA-F0-9]+):([a-fA-F0-9]+)$/);
		const address = new RegExp(
			`^[a-fA-F0-9]{${family === 4 ? 8 : 32}}:[a-fA-F0-9]{4}$`,
		);
		if (
			fields.length !== 13 ||
			!/^\d+:$/.test(fields[0] ?? "") ||
			!address.test(fields[1] ?? "") ||
			!address.test(fields[2] ?? "") ||
			!/^[a-fA-F0-9]{2}$/.test(fields[3] ?? "") ||
			!/^[a-fA-F0-9]{2}:[a-fA-F0-9]{8}$/.test(fields[5] ?? "") ||
			!/^[a-fA-F0-9]{8}$/.test(fields[6] ?? "") ||
			![7, 8, 10].every((index) => /^\d+$/.test(fields[index] ?? "")) ||
			!/^[a-fA-F0-9]+$/.test(fields[11] ?? "") ||
			!inode ||
			!/^[1-9][0-9]*$/.test(inode) ||
			!queues ||
			!/^\d+$/.test(fields.at(-1) ?? "") ||
			rows.has(inode)
		)
			throw Error("malformed or duplicate UDP identity");
		const txQueueBytes = Number.parseInt(queues[1] as string, 16),
			rxQueueBytes = Number.parseInt(queues[2] as string, 16),
			drops = Number(fields.at(-1));
		if (
			![txQueueBytes, rxQueueBytes, drops].every(
				(value) => Number.isSafeInteger(value) && value >= 0,
			)
		)
			throw Error("invalid UDP counters");
		rows.set(inode, {
			socketCount: 1,
			udp4SocketCount: family === 4 ? 1 : 0,
			udp6SocketCount: family === 6 ? 1 : 0,
			txQueueBytes,
			rxQueueBytes,
			drops,
		});
	}
	return rows;
}
function combinedUdpRows(udp4: string, udp6: string | null) {
	const rows = strictUdpRows(udp4, 4);
	if (udp6 !== null)
		for (const [inode, row] of strictUdpRows(udp6, 6)) {
			if (rows.has(inode)) throw Error("overlapping UDP families");
			rows.set(inode, row);
		}
	return rows;
}
function selectOwnedUdp(
	owned: ReadonlySet<string>,
	rows: ReadonlyMap<string, UdpSocketCounters>,
): Set<string> {
	const selected = new Set([...owned].filter((inode) => rows.has(inode)));
	if (selected.size < 1 || selected.size > 4)
		throw Error(`owned UDP cardinality ${selected.size} outside1..4`);
	return selected;
}
export function discoverOwnedUdpInodes(
	owned: ReadonlySet<string>,
	udp4: string,
	udp6: string | null,
): Set<string> {
	return selectOwnedUdp(owned, combinedUdpRows(udp4, udp6));
}
export type ProbeProcIo = {
	read(path: string): string;
	link(path: string): string;
	list(path: string): string[];
};
const probeProcIo: ProbeProcIo = {
	read: (path) => readFileSync(path, "utf8"),
	link: readlinkSync,
	list: readdirSync,
};
export type ProbeUdpIdentity = {
	serverId: number;
	pid: number;
	startTicks: string;
	namespace: string;
	inodes: Set<string>;
};
function processIdentity(pid: number, io: ProbeProcIo) {
	const stat = io.read(`/proc/${pid}/stat`),
		tail = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/);
	if (
		!stat.startsWith(`${pid} (`) ||
		!/^([RSDTtKWPI])$/.test(tail[0] ?? "") ||
		tail.length < 20 ||
		tail.slice(1, 20).some((field) => !/^[-]?\d+$/.test(field)) ||
		!/^[1-9][0-9]*$/.test(tail[19] ?? "") ||
		tail[0] === "Z" ||
		tail[0] === "X"
	)
		throw Error("process identity disappeared or malformed");
	const namespace = io.link(`/proc/${pid}/ns/net`);
	if (!/^net:\[\d+\]$/.test(namespace))
		throw Error("network namespace identity malformed");
	return { startTicks: tail[19] as string, namespace };
}
/** One namespace-table read per snapshot; every owned FD and process is reattested. */
export function sampleProbeUdp(
	targets: readonly { serverId: number; pid: number }[],
	frozen?: readonly ProbeUdpIdentity[],
	io: ProbeProcIo = probeProcIo,
) {
	const before = targets.map((target) => ({
		...target,
		...processIdentity(target.pid, io),
	}));
	const first = before[0];
	if (!first || before.some((target) => target.namespace !== first.namespace))
		throw Error("probe targets do not share namespace");
	const udp4 = io.read(`/proc/${first.pid}/net/udp`);
	let udp6: string | null;
	try {
		udp6 = io.read(`/proc/${first.pid}/net/udp6`);
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
		// Missing proc table is legitimate only with independently absent/disabled IPv6.
		try {
			if (io.read("/proc/sys/net/ipv6/conf/all/disable_ipv6").trim() !== "1")
				throw Error("IPv6 table missing while enabled");
		} catch (disabled) {
			if ((disabled as { code?: string }).code !== "ENOENT") throw disabled;
		}
		udp6 = null;
	}
	const rows = combinedUdpRows(udp4, udp6),
		seen = new Set<string>(),
		counters = new Map<number, UdpSocketCounters>();
	const identities = before.map((target) => {
		const generic = new Set<string>();
		const fds = io.list(`/proc/${target.pid}/fd`);
		if (
			new Set(fds).size !== fds.length ||
			fds.some((fd) => !/^(0|[1-9][0-9]*)$/.test(fd))
		)
			throw Error("invalid ownership FD inventory");
		for (const fd of fds) {
			const link = io.link(`/proc/${target.pid}/fd/${fd}`),
				match = link.match(/^socket:\[(\d+)\]$/);
			if (match) generic.add(match[1] as string);
		}
		const inodes = selectOwnedUdp(generic, rows),
			after = processIdentity(target.pid, io);
		if (
			after.startTicks !== target.startTicks ||
			after.namespace !== target.namespace
		)
			throw Error("process identity changed during snapshot");
		const prior = frozen?.find((entry) => entry.serverId === target.serverId);
		if (
			frozen &&
			(!prior ||
				prior.pid !== target.pid ||
				prior.startTicks !== target.startTicks ||
				prior.namespace !== target.namespace ||
				[...inodes].sort().join() !== [...prior.inodes].sort().join())
		)
			throw Error("frozen process/UDP socket identity changed");
		const total: UdpSocketCounters = {
			socketCount: 0,
			udp4SocketCount: 0,
			udp6SocketCount: 0,
			txQueueBytes: 0,
			rxQueueBytes: 0,
			drops: 0,
		};
		for (const inode of inodes) {
			if (seen.has(inode)) throw Error("overlapping shard UDP ownership");
			seen.add(inode);
			const row = rows.get(inode) as UdpSocketCounters;
			for (const key of Object.keys(total) as (keyof UdpSocketCounters)[])
				total[key] += row[key];
		}
		counters.set(target.serverId, total);
		return { ...target, inodes };
	});
	if (frozen && frozen.length !== identities.length)
		throw Error("frozen target set changed");
	return { identities, counters };
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

// Per-interface counters below the UDP layer. r82 showed client->server
// datagrams vanishing between the generator's OutDatagrams and the server's
// InDatagrams with every UDP counter clean, so the NIC-level drop, fifo, and
// driver statistics are sampled on both hosts at every phase mark.
export type NetDevCounters = {
	rxBytes: number;
	rxPackets: number;
	rxErrs: number;
	rxDrop: number;
	rxFifo: number;
	txBytes: number;
	txPackets: number;
	txErrs: number;
	txDrop: number;
	txFifo: number;
};

export type InterfaceSample = {
	netDev: Record<string, NetDevCounters>;
	ethtool: Record<string, Record<string, number>>;
};

export const INTERFACE_SAMPLE_SEPARATOR = "---g6-interface-sample---";

export function parseProcNetDev(text: string): Record<string, NetDevCounters> {
	const out: Record<string, NetDevCounters> = {};
	for (const line of text.split("\n")) {
		const match = /^\s*([^\s:]+):\s*(.*)$/.exec(line);
		if (!match) continue;
		const name = match[1] as string;
		if (name === "lo") continue;
		const fields = (match[2] as string).trim().split(/\s+/);
		if (fields.length < 16 || fields.some((field) => !/^\d+$/.test(field))) {
			continue;
		}
		const value = (index: number): number => Number(fields[index]);
		out[name] = {
			rxBytes: value(0),
			rxPackets: value(1),
			rxErrs: value(2),
			rxDrop: value(3),
			rxFifo: value(4),
			txBytes: value(8),
			txPackets: value(9),
			txErrs: value(10),
			txDrop: value(11),
			txFifo: value(12),
		};
	}
	return out;
}

export function parseEthtoolStats(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const match = /^\s+([^:]+):\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		const value = Number(match[2]);
		if (Number.isSafeInteger(value)) out[(match[1] as string).trim()] = value;
	}
	return out;
}

// One sample is /proc/net/dev, then one "<separator> <iface>" header followed
// by that interface's `ethtool -S` output, for every non-loopback interface.
export function parseInterfaceSample(text: string): InterfaceSample | null {
	const sections = text.split(INTERFACE_SAMPLE_SEPARATOR);
	const netDev = parseProcNetDev(sections[0] ?? "");
	if (Object.keys(netDev).length === 0) return null;
	const ethtool: Record<string, Record<string, number>> = {};
	for (const section of sections.slice(1)) {
		const newline = section.indexOf("\n");
		const name = (newline === -1 ? section : section.slice(0, newline)).trim();
		if (!name) continue;
		ethtool[name] = parseEthtoolStats(
			newline === -1 ? "" : section.slice(newline + 1),
		);
	}
	return { netDev, ethtool };
}

export const LINUX_PROBE_PHASES = [
	"connect",
	"steady",
	"drain",
	"idle",
] as const;
export const LINUX_PROBE_OPTIONAL_PHASES = ["closed"] as const;
/** Accepted probe header schemas: /2 is historical uniform 10/50 ms cadence;
 * /3 also declares a 50 ms connect-phase queue cadence. */
export const LINUX_PROBE_HEADER_SCHEMAS: readonly string[] = [
	"g6-c32-linux-probe-header/2",
	"g6-c32-linux-probe-header/3",
];

export type LinuxProbePhase =
	| (typeof LINUX_PROBE_PHASES)[number]
	| (typeof LINUX_PROBE_OPTIONAL_PHASES)[number];

export type LinuxProbeMeasurementMode = {
	detail: "on";
	phaseAware: true;
};

export type ParsedLinuxProbeJsonl = {
	schema: "g6-c32-linux-probe/2";
	measurementMode: LinuxProbeMeasurementMode;
	producerSha256: string;
	shards: { serverId: number; pid: number; inodes: string[] }[];
	phaseBoundaries: Record<
		(typeof LINUX_PROBE_PHASES)[number],
		{ monotonicNs: string; requestId: number | null }
	> & { closed?: { monotonicNs: string; requestId: number | null } };
	phaseCoverage: Record<
		(typeof LINUX_PROBE_PHASES)[number],
		{ queueSamples: number; schedSamples: number }
	>;
	phaseSampleExtents: Record<
		(typeof LINUX_PROBE_PHASES)[number],
		Record<
			"queue" | "sched",
			{ firstNs: string; lastNs: string; maxGapNs: string }
		>
	>;
	historicalConnectSummary: {
		peakReceiveQueueBytes: number;
		peakDrops: number;
		queueSamples: number;
		schedSamples: number;
		pressureAlignments: number;
		drainStallAligned: boolean;
	};
	summary: Record<string, unknown>;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function isNonnegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
	if (!isNonnegativeInteger(value))
		throw new Error(
			`g6-sharded-diagnostic: ${label} must be a nonnegative integer`,
		);
	return value;
}

function parseMonotonicNs(value: unknown, label: string): bigint {
	if (
		typeof value !== "string" ||
		!/^(0|[1-9][0-9]{0,19})$/.test(value) ||
		BigInt(value) > 18446744073709551615n
	)
		throw new Error(
			`g6-sharded-diagnostic: ${label} must be a monotonic-ns string`,
		);
	return BigInt(value);
}

function requirePhase(value: unknown, label: string): LinuxProbePhase {
	if (
		typeof value !== "string" ||
		![...LINUX_PROBE_PHASES, ...LINUX_PROBE_OPTIONAL_PHASES].includes(
			value as LinuxProbePhase,
		)
	) {
		throw new Error(
			`g6-sharded-diagnostic: ${label} is not a supported Linux probe phase`,
		);
	}
	return value as LinuxProbePhase;
}

function requireMeasurementMode(
	value: unknown,
	label: string,
): LinuxProbeMeasurementMode {
	const mode = record(value);
	if (!mode || mode.phaseAware !== true || mode.detail !== "on") {
		throw new Error(
			`g6-sharded-diagnostic: ${label} must explicitly declare detail mode`,
		);
	}
	return { detail: mode.detail, phaseAware: true };
}

function requireProducerSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
		throw new Error(
			`g6-sharded-diagnostic: ${label} must be a 64-hex producer sha`,
		);
	}
	return value.toLowerCase();
}

function zeroPhaseCoverage(): Record<
	(typeof LINUX_PROBE_PHASES)[number],
	{ queueSamples: number; schedSamples: number }
> {
	return Object.fromEntries(
		LINUX_PROBE_PHASES.map((phase) => [
			phase,
			{ queueSamples: 0, schedSamples: 0 },
		]),
	) as Record<
		(typeof LINUX_PROBE_PHASES)[number],
		{ queueSamples: number; schedSamples: number }
	>;
}

function probeAssert(condition: unknown, label: string): asserts condition {
	if (!condition)
		throw new Error(`g6-sharded-diagnostic: Linux probe ${label}`);
}

function probeClaim(actual: unknown, expected: unknown, label: string): void {
	if (Array.isArray(expected)) {
		probeAssert(
			Array.isArray(actual) && actual.length === expected.length,
			`${label} differs from raw evidence`,
		);
		expected.forEach((value, index) => {
			probeClaim(actual[index], value, `${label}[${index}]`);
		});
	} else if (record(expected)) {
		const row = record(actual);
		probeAssert(
			row &&
				Object.keys(row).length === Object.keys(expected as JsonRecord).length,
			`${label} is missing or differs from raw evidence`,
		);
		for (const [key, value] of Object.entries(expected as JsonRecord))
			probeClaim(row[key], value, `${label}.${key}`);
	} else probeAssert(actual === expected, `${label} differs from raw evidence`);
}

function probePositive(value: unknown, label: string): number {
	const number = requireNonnegativeInteger(value, `Linux probe ${label}`);
	probeAssert(number > 0, `${label} must be positive`);
	return number;
}

function probeInodes(value: unknown): string[] {
	probeAssert(
		Array.isArray(value) && value.length >= 1 && value.length <= 4,
		"shard inodes must contain 1..4 owned sockets",
	);
	probeAssert(
		value.every(
			(inode) => typeof inode === "string" && /^[1-9][0-9]{0,19}$/.test(inode),
		),
		"shard inode is invalid",
	);
	probeAssert(
		new Set(value).size === value.length,
		"shard has duplicate inodes",
	);
	return (value as string[]).toSorted();
}

/** Consume raw, bounded JSONL. A terminal 'complete' flag is never sufficient. */
export function parseLinuxProbeJsonl(text: string): ParsedLinuxProbeJsonl {
	probeAssert(
		text.length > 0 && Buffer.byteLength(text) <= 128 * 1024 * 1024,
		"artifact is empty or exceeds its 128 MiB cap",
	);
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	let header: JsonRecord | null = null;
	let summary: JsonRecord | null = null;
	let bytesBeforeLine = 0;
	let currentPhase: LinuxProbePhase | null = null;
	let lastMonotonicNs = -1n;
	let nextPhaseIndex = 0;
	let lastRequestId = 0;
	const phaseCoverage = zeroPhaseCoverage();
	const phaseSampleExtents = Object.fromEntries(
		LINUX_PROBE_PHASES.map((phase) => [
			phase,
			{
				queue: { firstNs: "", lastNs: "", maxGapNs: "0" },
				sched: { firstNs: "", lastNs: "", maxGapNs: "0" },
			},
		]),
	) as ParsedLinuxProbeJsonl["phaseSampleExtents"];
	const observeExtent = (
		phase: LinuxProbePhase,
		kind: "queue" | "sched",
		ns: bigint,
	) => {
		if (phase === "closed") return;
		const extent = phaseSampleExtents[phase][kind];
		if (extent.firstNs === "") extent.firstNs = ns.toString();
		else {
			const gap = ns - BigInt(extent.lastNs);
			if (gap > BigInt(extent.maxGapNs)) extent.maxGapNs = gap.toString();
		}
		extent.lastNs = ns.toString();
	};
	const phaseBoundaries = {} as ParsedLinuxProbeJsonl["phaseBoundaries"];
	const connectObserved = {
		peakReceiveQueueBytes: 0,
		peakDrops: 0,
		queueSamples: 0,
		schedSamples: 0,
		pressureAlignments: 0,
		drainStallAligned: false,
	};
	const targets = new Map<number, { pid: number; inodes: string[] }>();
	let receiveBufferBytes = 0;
	let sendBufferBytes = 0;
	let queueSamples = 0;
	let schedSamples = 0;
	let peakReceiveQueueBytes = 0;
	let peakDrops = 0;
	let peakProcsRunning = 0;
	let peakLoad1 = 0;
	let pressureAlignments = 0;
	let lastTotalDrops = 0;
	let previousSchedWait = 0;
	let pendingSched = false;
	let latestQueue: {
		monotonicNs: bigint;
		drops: number;
		previousDrops: number;
	} | null = null;
	const lastDropByShard = new Map<number, number>();
	const lastSchedByShard = new Map<
		number,
		{ runtimeNs: number; waitNs: number; timeslices: number }
	>();
	let lastNetRx: number | null = null;
	let lastSoftnet: {
		processed: number;
		dropped: number;
		timeSqueeze: number;
	} | null = null;
	const rowsForTargets = (
		value: unknown,
		kind: "queue" | "sched",
	): JsonRecord[] => {
		probeAssert(
			Array.isArray(value) && value.length === targets.size && value.length > 0,
			`${kind} sample lacks complete shard membership`,
		);
		const seen = new Set<number>();
		return value.map((item) => {
			const row = record(item);
			const id = probePositive(row?.serverId, `${kind} serverId`);
			const target = targets.get(id);
			probeAssert(
				row && target && !seen.has(id),
				`${kind} has unknown or duplicate shard ${id}`,
			);
			probeAssert(
				row.pid === target.pid,
				`${kind} shard ${id} PID differs from header`,
			);
			seen.add(id);
			if (kind === "queue") {
				probeClaim(
					probeInodes(row.inodes),
					target.inodes,
					`queue shard ${id} inodes`,
				);
				const count = probePositive(
					row.socketCount,
					`queue shard ${id} socketCount`,
				);
				const v4 = requireNonnegativeInteger(
					row.udp4SocketCount,
					"Linux probe UDP4 socket count",
				);
				const v6 = requireNonnegativeInteger(
					row.udp6SocketCount,
					"Linux probe UDP6 socket count",
				);
				probeAssert(
					count === target.inodes.length && v4 + v6 === count,
					`queue shard ${id} socket coverage is incomplete`,
				);
				requireNonnegativeInteger(row.txQueueBytes, "Linux probe txQueueBytes");
			}
			return row;
		});
	};
	for (const [lineIndex, line] of lines.entries()) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(
				`g6-sharded-diagnostic: Linux probe line ${lineIndex + 1} is not valid JSON`,
			);
		}
		const entry = record(value);
		probeAssert(
			entry && typeof entry.schema === "string",
			"record is missing schema",
		);
		probeAssert(
			summary === null,
			"terminal summary must be unique and last at EOF",
		);
		if (lineIndex === 0)
			probeAssert(
				LINUX_PROBE_HEADER_SCHEMAS.includes(entry.schema as string),
				"header must be first",
			);
		if (pendingSched)
			probeAssert(
				entry.schema === "g6-c32-linux-probe-sched/2",
				"scheduled scheduler sample is missing",
			);
		if (LINUX_PROBE_HEADER_SCHEMAS.includes(entry.schema as string)) {
			probeAssert(
				header === null && lineIndex === 0,
				"has duplicate or late header",
			);
			header = entry;
			requireMeasurementMode(
				entry.measurementMode,
				"Linux probe header measurementMode",
			);
			requireProducerSha256(
				entry.producerSha256,
				"Linux probe header producerSha256",
			);
			// /2 declared one uniform 10/50 ms cadence; /3 additionally declares
			// the connect-only 50 ms queue cadence (sched still pairs every 5th
			// executed queue sample, so connect sched is every 250 ms).
			probeAssert(
				entry.queueCadenceMs === 10 &&
					entry.schedCadenceMs === 50 &&
					(entry.schema === "g6-c32-linux-probe-header/2"
						? !("connectQueueCadenceMs" in entry)
						: entry.connectQueueCadenceMs === 50),
				"cadence differs from the fixed producer",
			);
			probeClaim(entry.phaseOrder, [...LINUX_PROBE_PHASES], "phase order");
			probePositive(entry.clkTck, "clkTck");
			const cpu = record(entry.probeCpuStart);
			requireNonnegativeInteger(
				cpu?.userJiffies,
				"Linux probe CPU start user jiffies",
			);
			requireNonnegativeInteger(
				cpu?.systemJiffies,
				"Linux probe CPU start system jiffies",
			);
			probeAssert(
				typeof entry.startedAt === "string" &&
					Number.isFinite(Date.parse(entry.startedAt)),
				"startedAt is missing",
			);
			const shards = entry.shards;
			probeAssert(
				Array.isArray(shards) && shards.length >= 1 && shards.length <= 64,
				"header requires 1..64 shards",
			);
			const pids = new Set<number>();
			const inodes = new Set<string>();
			for (const item of shards) {
				const row = record(item);
				const id = probePositive(row?.serverId, "header serverId");
				const pid = probePositive(row?.pid, "header PID");
				probeAssert(
					row && id <= shards.length && !targets.has(id) && !pids.has(pid),
					"header requires unique IDs 1..N and PIDs",
				);
				const owned = probeInodes(row.inodes);
				probeAssert(
					owned.every((inode) => !inodes.has(inode)),
					"socket inode is shared between declared shards",
				);
				owned.forEach((inode) => {
					inodes.add(inode);
				});
				pids.add(pid);
				targets.set(id, { pid, inodes: owned });
				const memory = record(row.socketMemory);
				const receive = probePositive(
					memory?.receiveBufferBytes,
					"receive buffer",
				);
				const send = probePositive(memory?.sendBufferBytes, "send buffer");
				probeAssert(
					receiveBufferBytes === 0 || receiveBufferBytes === receive,
					"receive buffers differ across shards",
				);
				probeAssert(
					sendBufferBytes === 0 || sendBufferBytes === send,
					"send buffers differ across shards",
				);
				receiveBufferBytes = receive;
				sendBufferBytes = send;
			}
		} else if (entry.schema === "g6-c32-linux-probe/2") {
			summary = entry;
			probeAssert(
				summary.artifactBytes === bytesBeforeLine,
				"artifactBytes differs from raw prefix",
			);
		} else {
			probeAssert(header, "header is missing");
			const phase = requirePhase(entry.phase, "Linux probe phase");
			const monotonicNs = parseMonotonicNs(
				entry.monotonicNs,
				"Linux probe monotonicNs",
			);
			probeAssert(
				monotonicNs >= lastMonotonicNs,
				"monotonic clock moved backward",
			);
			lastMonotonicNs = monotonicNs;
			if (entry.schema === "g6-c32-linux-probe-phase/1") {
				const expected = [
					...LINUX_PROBE_PHASES,
					...LINUX_PROBE_OPTIONAL_PHASES,
				][nextPhaseIndex];
				probeAssert(
					phase === expected,
					`expected ${expected ?? "no further"} boundary before ${phase}`,
				);
				probeAssert(
					entry.requestId === null ||
						(isNonnegativeInteger(entry.requestId) &&
							entry.requestId > lastRequestId),
					"phase requestId is missing, duplicated or out of order",
				);
				if (entry.requestId !== null) lastRequestId = entry.requestId as number;
				phaseBoundaries[phase] = {
					monotonicNs: monotonicNs.toString(),
					requestId: entry.requestId as number | null,
				};
				currentPhase = phase;
				nextPhaseIndex++;
			} else {
				probeAssert(
					phase === currentPhase,
					`sample phase ${phase} differs from current boundary ${currentPhase}`,
				);
				if (entry.schema === "g6-c32-linux-probe-queue/2") {
					let drops = 0;
					let rx = 0;
					for (const row of rowsForTargets(entry.shards, "queue")) {
						const id = row.serverId as number;
						const current = requireNonnegativeInteger(
							row.drops,
							"Linux probe shard drops",
						);
						probeAssert(
							current >= (lastDropByShard.get(id) ?? 0),
							`negative drop delta at shard ${id}`,
						);
						lastDropByShard.set(id, current);
						drops += current;
						rx += requireNonnegativeInteger(
							row.rxQueueBytes,
							"Linux probe rxQueueBytes",
						);
					}
					requireNonnegativeInteger(drops, "Linux probe total drops");
					requireNonnegativeInteger(rx, "Linux probe total rxQueueBytes");
					latestQueue = { monotonicNs, drops, previousDrops: lastTotalDrops };
					lastTotalDrops = drops;
					peakReceiveQueueBytes = Math.max(peakReceiveQueueBytes, rx);
					peakDrops = Math.max(peakDrops, drops);
					pendingSched = queueSamples % 5 === 0;
					queueSamples++;
					observeExtent(phase, "queue", monotonicNs);
					if (phase !== "closed") phaseCoverage[phase].queueSamples++;
					if (phase === "connect") {
						connectObserved.queueSamples++;
						connectObserved.peakReceiveQueueBytes = Math.max(
							connectObserved.peakReceiveQueueBytes,
							rx,
						);
						connectObserved.peakDrops = Math.max(
							connectObserved.peakDrops,
							drops,
						);
					}
				} else if (entry.schema === "g6-c32-linux-probe-sched/2") {
					probeAssert(
						pendingSched && latestQueue?.monotonicNs === monotonicNs,
						"scheduler sample is unpaired or off cadence",
					);
					pendingSched = false;
					const netRx = requireNonnegativeInteger(
						entry.netRx,
						"Linux probe netRx",
					);
					probeAssert(
						lastNetRx === null || netRx >= lastNetRx,
						"negative NET_RX delta",
					);
					lastNetRx = netRx;
					const softnet = record(entry.softnet);
					const currentSoftnet = {
						processed: requireNonnegativeInteger(
							softnet?.processed,
							"Linux probe softnet processed",
						),
						dropped: requireNonnegativeInteger(
							softnet?.dropped,
							"Linux probe softnet dropped",
						),
						timeSqueeze: requireNonnegativeInteger(
							softnet?.timeSqueeze,
							"Linux probe softnet timeSqueeze",
						),
					};
					const previousSoftnet = lastSoftnet;
					probeAssert(
						!previousSoftnet ||
							Object.entries(currentSoftnet).every(
								([key, count]) =>
									count >= previousSoftnet[key as keyof typeof currentSoftnet],
							),
						"negative softnet delta",
					);
					let totalWait = 0;
					for (const row of rowsForTargets(entry.sched, "sched")) {
						const id = row.serverId as number;
						const current = {
							runtimeNs: requireNonnegativeInteger(
								row.runtimeNs,
								"Linux probe runtimeNs",
							),
							waitNs: requireNonnegativeInteger(
								row.waitNs,
								"Linux probe waitNs",
							),
							timeslices: requireNonnegativeInteger(
								row.timeslices,
								"Linux probe timeslices",
							),
						};
						const previous = lastSchedByShard.get(id);
						probeAssert(
							!previous ||
								Object.entries(current).every(
									([key, count]) =>
										count >= previous[key as keyof typeof current],
								),
							`negative scheduler delta at shard ${id}`,
						);
						lastSchedByShard.set(id, current);
						totalWait += current.waitNs;
					}
					requireNonnegativeInteger(
						totalWait,
						"Linux probe total scheduler wait",
					);
					const pressureGrowth =
						totalWait > previousSchedWait ||
						(lastSoftnet !== null &&
							(currentSoftnet.dropped > lastSoftnet.dropped ||
								currentSoftnet.timeSqueeze > lastSoftnet.timeSqueeze));
					if (latestQueue.drops > latestQueue.previousDrops && pressureGrowth) {
						pressureAlignments++;
						if (phase === "connect") connectObserved.pressureAlignments++;
					}
					lastSoftnet = currentSoftnet;
					previousSchedWait = totalWait;
					const running = requireNonnegativeInteger(
						entry.procsRunning,
						"Linux probe procsRunning",
					);
					probeAssert(
						typeof entry.load1 === "number" &&
							Number.isFinite(entry.load1) &&
							entry.load1 >= 0,
						"load1 is invalid",
					);
					peakProcsRunning = Math.max(peakProcsRunning, running);
					peakLoad1 = Math.max(peakLoad1, entry.load1);
					schedSamples++;
					observeExtent(phase, "sched", monotonicNs);
					if (phase !== "closed") phaseCoverage[phase].schedSamples++;
					if (phase === "connect") connectObserved.schedSamples++;
				} else
					throw new Error(
						`g6-sharded-diagnostic: Linux probe unknown schema ${entry.schema}`,
					);
			}
		}
		bytesBeforeLine +=
			Buffer.byteLength(line) +
			(lineIndex < lines.length - 1 || text.endsWith("\n") ? 1 : 0);
	}
	probeAssert(header && summary, "header or terminal summary is missing");
	const measurementMode = requireMeasurementMode(
		summary.measurementMode,
		"Linux probe summary measurementMode",
	);
	const producerSha256 = requireProducerSha256(
		summary.producerSha256,
		"Linux probe summary producerSha256",
	);
	probeClaim(
		producerSha256,
		requireProducerSha256(
			header.producerSha256,
			"Linux probe header producerSha256",
		),
		"producer identity",
	);
	probeClaim(
		summary.measurementMode,
		header.measurementMode,
		"measurement mode",
	);
	probeClaim(summary.queueCadenceMs, header.queueCadenceMs, "queue cadence");
	probeClaim(
		summary.schedCadenceMs,
		header.schedCadenceMs,
		"scheduler cadence",
	);
	probeClaim(
		summary.connectQueueCadenceMs,
		header.connectQueueCadenceMs,
		"connect queue cadence",
	);
	probeAssert(
		summary.truncated === false,
		"summary reports truncation or lacks explicit no-truncation evidence",
	);
	probeAssert(summary.complete === true, "summary reports child failure");
	probeClaim(summary.childExit, { code: 0, signal: null }, "child exit");
	probeClaim(summary.problems, [], "terminal problems");
	const endNs = parseMonotonicNs(
		summary.monotonicNs,
		"Linux probe terminal monotonicNs",
	);
	probeAssert(endNs >= lastMonotonicNs, "terminal clock moved backward");
	probeAssert(
		typeof summary.endedAt === "string" &&
			Number.isFinite(Date.parse(summary.endedAt)) &&
			Date.parse(summary.endedAt) >= Date.parse(header.startedAt as string),
		"endedAt is invalid",
	);
	for (const phase of LINUX_PROBE_PHASES) {
		probeAssert(phaseBoundaries[phase], `${phase} boundary is missing`);
		probeAssert(
			phaseCoverage[phase].queueSamples > 0 &&
				phaseCoverage[phase].schedSamples > 0,
			`${phase} coverage is incomplete`,
		);
	}
	probeClaim(summary.phaseBoundaries, phaseBoundaries, "phase boundaries");
	probeClaim(summary.phaseCoverage, phaseCoverage, "phase coverage");
	probeClaim(summary.queueSamples, queueSamples, "queue sample total");
	probeClaim(summary.schedSamples, schedSamples, "scheduler sample total");
	connectObserved.drainStallAligned = connectObserved.pressureAlignments >= 2;
	probeClaim(
		summary.historicalConnectSummary,
		connectObserved,
		"historical connect summary",
	);
	const startCpu = record(header.probeCpuStart);
	probeAssert(startCpu, "CPU start is missing");
	const endCpu = record(summary.probeCpuEnd);
	const cpuDelta = (key: string) => {
		const end = requireNonnegativeInteger(
			endCpu?.[key],
			`Linux probe CPU end ${key}`,
		);
		const delta = end - (startCpu[key] as number);
		probeAssert(delta >= 0, "negative probe CPU delta");
		return delta / (header.clkTck as number);
	};
	probeClaim(
		summary.summary,
		{
			peakReceiveQueueBytes,
			peakDrops,
			effectiveReceiveBufferBytes: receiveBufferBytes,
			effectiveSendBufferBytes: sendBufferBytes,
			pressureAlignments,
			drainStallAligned: pressureAlignments >= 2,
			probeUserSec: cpuDelta("userJiffies"),
			probeSysSec: cpuDelta("systemJiffies"),
			peakProcsRunning,
			peakLoad1,
			clkTck: header.clkTck,
		},
		"terminal summary",
	);
	return {
		schema: "g6-c32-linux-probe/2",
		measurementMode,
		producerSha256,
		shards: [...targets.entries()].map(([serverId, target]) => ({
			serverId,
			...target,
		})),
		phaseBoundaries,
		phaseCoverage,
		phaseSampleExtents,
		historicalConnectSummary: connectObserved,
		summary,
	};
}
