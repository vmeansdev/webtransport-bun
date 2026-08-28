import { readFileSync, readdirSync, readlinkSync } from "node:fs";

export type UdpSocketCounters = {
	socketCount: number;
	udp4SocketCount: number;
	udp6SocketCount: number;
	txQueueBytes: number;
	rxQueueBytes: number;
	drops: number;
};

type ParsedUdpTable = Omit<UdpSocketCounters, "udp4SocketCount" | "udp6SocketCount">;

export function parseOwnedUdpSocketTable(
	text: string,
	ownedInodes: ReadonlySet<string>,
): ParsedUdpTable {
	const counters: ParsedUdpTable = {
		socketCount: 0,
		txQueueBytes: 0,
		rxQueueBytes: 0,
		drops: 0,
	};
	for (const line of text.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 10 || !ownedInodes.has(fields[9] ?? "")) continue;
		const [txHex, rxHex] = (fields[4] ?? "").split(":");
		if (!txHex || !rxHex) continue;
		const txQueueBytes = Number.parseInt(txHex, 16);
		const rxQueueBytes = Number.parseInt(rxHex, 16);
		const drops = Number.parseInt(fields.at(-1) ?? "", 10);
		if (![txQueueBytes, rxQueueBytes, drops].every(Number.isFinite)) continue;
		counters.socketCount += 1;
		counters.txQueueBytes += txQueueBytes;
		counters.rxQueueBytes += rxQueueBytes;
		counters.drops += drops;
	}
	return counters;
}

function ownedSocketInodes(pid: number): Set<string> {
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

export function readPerProcessUdpSockets(pid: number): UdpSocketCounters | null {
	try {
		const ownedInodes = ownedSocketInodes(pid);
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
