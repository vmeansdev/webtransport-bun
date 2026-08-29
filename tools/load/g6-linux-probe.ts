/** Bounded Linux-only queue, socket-drop, softirq, softnet and schedstat probe. */
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	ownedSocketInodes,
	readUdpSocketsForInodes,
} from "./g6-sharded-diagnostic.ts";

const QUEUE_CADENCE_MS = 10;
const SCHED_CADENCE_MS = 50;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const FINAL_RESERVE_BYTES = 64 * 1024;

function arg(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function requireArg(name: string): string {
	const value = arg(name);
	if (value === null) throw new Error(`g6-linux-probe: --${name} is required`);
	return value;
}

function positiveInteger(name: string, fallback?: number): number {
	const raw = arg(name);
	if (raw === null && fallback !== undefined) return fallback;
	if (raw === null || !/^\d+$/.test(raw))
		throw new Error(`g6-linux-probe: --${name} must be a positive integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`g6-linux-probe: --${name} must be a positive integer`);
	return value;
}

export function parseNetRxSoftirq(text: string): number | null {
	const line = text.split(/\r?\n/).find((entry) => /^\s*NET_RX:/.test(entry));
	if (!line) return null;
	const values = line
		.slice(line.indexOf(":") + 1)
		.trim()
		.split(/\s+/);
	if (values.length === 0 || values.some((value) => !/^\d+$/.test(value)))
		return null;
	const total = values.reduce((sum, value) => sum + Number(value), 0);
	return Number.isSafeInteger(total) ? total : null;
}

export function parseSoftnetStat(text: string): {
	processed: number;
	dropped: number;
	timeSqueeze: number;
} | null {
	let processed = 0;
	let dropped = 0;
	let timeSqueeze = 0;
	const lines = text.trim().split(/\r?\n/).filter(Boolean);
	if (lines.length === 0) return null;
	for (const line of lines) {
		const fields = line.trim().split(/\s+/);
		if (
			fields.length < 3 ||
			fields.slice(0, 3).some((field) => !/^[0-9a-fA-F]+$/.test(field))
		)
			return null;
		processed += Number.parseInt(fields[0] as string, 16);
		dropped += Number.parseInt(fields[1] as string, 16);
		timeSqueeze += Number.parseInt(fields[2] as string, 16);
	}
	if (
		![processed, dropped, timeSqueeze].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		)
	)
		return null;
	return { processed, dropped, timeSqueeze };
}

export function parseSchedstat(text: string): {
	runtimeNs: number;
	waitNs: number;
	timeslices: number;
} | null {
	const fields = text.trim().split(/\s+/);
	if (
		fields.length < 3 ||
		fields.slice(0, 3).some((field) => !/^\d+$/.test(field))
	)
		return null;
	const values = fields.slice(0, 3).map(Number);
	if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
		return null;
	return {
		runtimeNs: values[0] as number,
		waitNs: values[1] as number,
		timeslices: values[2] as number,
	};
}

export function parseSsSocketMemory(
	text: string,
): Map<number, { receiveBufferBytes: number; sendBufferBytes: number }> {
	const result = new Map<
		number,
		{ receiveBufferBytes: number; sendBufferBytes: number }
	>();
	let pids: number[] = [];
	for (const line of text.split(/\r?\n/)) {
		const linePids = [...line.matchAll(/pid=(\d+)/g)].map((match) =>
			Number(match[1]),
		);
		if (/^\S/.test(line)) pids = linePids;
		const memory = line.match(/skmem:\([^)]*\brb(\d+)[^)]*\btb(\d+)/);
		if (!memory) continue;
		const receiveBufferBytes = Number(memory[1]);
		const sendBufferBytes = Number(memory[2]);
		for (const pid of pids) {
			result.set(pid, { receiveBufferBytes, sendBufferBytes });
		}
	}
	return result;
}

export class JsonlBudget {
	readonly path: string;
	readonly maxBytes: number;
	bytes = 0;
	truncated = false;

	constructor(path: string, maxBytes: number) {
		if (maxBytes <= FINAL_RESERVE_BYTES)
			throw new Error(
				"g6-linux-probe: max bytes is too small for final summary",
			);
		this.path = path;
		this.maxBytes = maxBytes;
		writeFileSync(path, "");
	}

	append(value: unknown, final = false): boolean {
		const line = `${JSON.stringify(value)}\n`;
		const size = Buffer.byteLength(line);
		const limit = final ? this.maxBytes : this.maxBytes - FINAL_RESERVE_BYTES;
		if (this.bytes + size > limit) {
			this.truncated = true;
			return false;
		}
		appendFileSync(this.path, line);
		this.bytes += size;
		return true;
	}
}

function read(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function command(command: string, args: string[]): string | null {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 4 * 1024 * 1024,
		});
	} catch {
		return null;
	}
}

function preflight(role: string, out: string): void {
	if (process.platform !== "linux")
		throw new Error("g6-linux-probe: preflight requires Linux");
	const sysctls = Object.fromEntries(
		[
			"/proc/sys/net/core/rmem_max",
			"/proc/sys/net/core/rmem_default",
			"/proc/sys/net/core/wmem_max",
			"/proc/sys/net/core/wmem_default",
			"/proc/sys/net/ipv4/udp_rmem_min",
			"/proc/sys/net/ipv4/udp_wmem_min",
		].map((path) => [basename(path), read(path)?.trim() ?? null]),
	);
	const irqAffinities: Record<string, string | null> = {};
	for (const irq of readdirSync("/proc/irq").filter((entry) =>
		/^\d+$/.test(entry),
	)) {
		irqAffinities[irq] =
			read(join("/proc/irq", irq, "smp_affinity_list"))?.trim() ?? null;
	}
	const interfaces: Record<string, string | null> = {};
	for (const iface of readdirSync("/sys/class/net"))
		interfaces[iface] = command("ethtool", ["-l", iface]);
	const result = {
		schema: "g6-c32-linux-probe-preflight/1",
		complete: true,
		role,
		capturedAt: new Date().toISOString(),
		bootId: read("/proc/sys/kernel/random/boot_id")?.trim() ?? null,
		sysctls,
		ss: command("ss", ["-u", "-n", "-m", "-p", "-a"]),
		irqAffinities,
		interfaces,
		backgroundProcesses: command("ps", ["-eo", "pid,ppid,stat,comm,args"]),
	};
	if (!result.bootId || !result.ss || !result.backgroundProcesses)
		result.complete = false;
	writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
	if (!result.complete) process.exitCode = 2;
}

type ShardTarget = { serverId: number; pid: number; inodes: Set<string> };

export function parseShards(raw: string): ShardTarget[] {
	const targets = raw.split(",").map((entry) => {
		const match = entry.match(/^(\d+)=(\d+)$/);
		if (!match)
			throw new Error(`g6-linux-probe: malformed shard target ${entry}`);
		return {
			serverId: Number(match[1]),
			pid: Number(match[2]),
			inodes: new Set<string>(),
		};
	});
	if (
		targets.length !== 16 ||
		new Set(targets.map((target) => target.serverId)).size !== 16 ||
		targets.some(
			(target) =>
				target.serverId < 1 || target.serverId > 16 || target.pid <= 0,
		)
	)
		throw new Error(
			"g6-linux-probe: connect mode requires exactly server IDs 1..16",
		);
	return targets.toSorted((left, right) => left.serverId - right.serverId);
}

function connectProbe(out: string, shardsRaw: string, maxBytes: number): void {
	if (process.platform !== "linux")
		throw new Error("g6-linux-probe: connect mode requires Linux");
	const writer = new JsonlBudget(out, maxBytes);
	const problems: string[] = [];
	const shards = parseShards(shardsRaw);
	for (const shard of shards) {
		shard.inodes = ownedSocketInodes(shard.pid);
		if (shard.inodes.size !== 1)
			problems.push(
				`server ${shard.serverId} owns ${shard.inodes.size} UDP socket inodes`,
			);
	}
	const ssText = command("ss", ["-u", "-n", "-m", "-p", "-a"]);
	const socketMemory = ssText ? parseSsSocketMemory(ssText) : new Map();
	for (const shard of shards)
		if (!socketMemory.has(shard.pid))
			problems.push(`server ${shard.serverId} has no ss skmem evidence`);
	writer.append({
		schema: "g6-c32-linux-probe-header/1",
		queueCadenceMs: QUEUE_CADENCE_MS,
		schedCadenceMs: SCHED_CADENCE_MS,
		startedAt: new Date().toISOString(),
		shards: shards.map((shard) => ({
			serverId: shard.serverId,
			pid: shard.pid,
			inodes: [...shard.inodes],
			socketMemory: socketMemory.get(shard.pid) ?? null,
		})),
	});
	if (problems.length > 0) {
		writer.append(
			{
				schema: "g6-c32-linux-probe/1",
				complete: false,
				endedAt: new Date().toISOString(),
				queueCadenceMs: QUEUE_CADENCE_MS,
				schedCadenceMs: SCHED_CADENCE_MS,
				queueSamples: 0,
				schedSamples: 0,
				artifactBytes: writer.bytes,
				truncated: writer.truncated,
				problems: [...new Set(problems)],
				summary: null,
			},
			true,
		);
		process.exit(2);
	}
	let queueSamples = 0;
	let schedSamples = 0;
	let peakReceiveQueueBytes = 0;
	let peakDrops = 0;
	let finishStarted = false;
	let tick = 0;
	let previousDrops = 0;
	let previousSoftnet: ReturnType<typeof parseSoftnetStat> = null;
	let previousSchedWait = 0;
	let pressureAlignments = 0;

	const sample = (): void => {
		const monotonicNs = process.hrtime.bigint().toString();
		const rows = shards.map((shard) => {
			const counters = readUdpSocketsForInodes(shard.pid, shard.inodes);
			if (!counters)
				problems.push(`server ${shard.serverId} socket sample failed`);
			return {
				serverId: shard.serverId,
				pid: shard.pid,
				inodes: [...shard.inodes],
				...(counters ?? {
					socketCount: 0,
					txQueueBytes: 0,
					rxQueueBytes: 0,
					drops: 0,
				}),
			};
		});
		const totalQueue = rows.reduce((sum, row) => sum + row.rxQueueBytes, 0);
		const totalDrops = rows.reduce((sum, row) => sum + row.drops, 0);
		peakReceiveQueueBytes = Math.max(peakReceiveQueueBytes, totalQueue);
		peakDrops = Math.max(peakDrops, totalDrops);
		if (
			writer.append({
				schema: "g6-c32-linux-probe-queue/1",
				monotonicNs,
				shards: rows,
			})
		)
			queueSamples += 1;
		if (tick % (SCHED_CADENCE_MS / QUEUE_CADENCE_MS) === 0) {
			const netRx = parseNetRxSoftirq(read("/proc/softirqs") ?? "");
			const softnet = parseSoftnetStat(read("/proc/net/softnet_stat") ?? "");
			const sched = shards.map((shard) => ({
				serverId: shard.serverId,
				pid: shard.pid,
				...parseSchedstat(read(`/proc/${shard.pid}/schedstat`) ?? ""),
			}));
			if (
				netRx === null ||
				softnet === null ||
				sched.some((row) => row.runtimeNs === undefined)
			)
				problems.push("scheduler/softirq sample failed");
			const totalWait = sched.reduce((sum, row) => sum + (row.waitNs ?? 0), 0);
			const dropGrowth = totalDrops > previousDrops;
			const pressureGrowth =
				totalWait > previousSchedWait ||
				(softnet !== null &&
					previousSoftnet !== null &&
					(softnet.dropped > previousSoftnet.dropped ||
						softnet.timeSqueeze > previousSoftnet.timeSqueeze));
			if (dropGrowth && pressureGrowth) pressureAlignments += 1;
			previousSoftnet = softnet;
			previousSchedWait = totalWait;
			if (
				writer.append({
					schema: "g6-c32-linux-probe-sched/1",
					monotonicNs,
					netRx,
					softnet,
					sched,
				})
			)
				schedSamples += 1;
		}
		previousDrops = totalDrops;
		tick += 1;
	};

	const timer = setInterval(sample, QUEUE_CADENCE_MS);
	const finish = (): void => {
		if (finishStarted) return;
		finishStarted = true;
		clearInterval(timer);
		sample();
		const effectiveBuffers = shards.map(
			(shard) => socketMemory.get(shard.pid)?.receiveBufferBytes ?? null,
		);
		const effectiveReceiveBufferBytes =
			effectiveBuffers.every((value) => value !== null) &&
			new Set(effectiveBuffers).size === 1
				? effectiveBuffers[0]
				: null;
		const uniqueProblems = [...new Set(problems)];
		const complete =
			uniqueProblems.length === 0 &&
			!writer.truncated &&
			queueSamples > 0 &&
			schedSamples > 0 &&
			effectiveReceiveBufferBytes !== null;
		const finalWritten = writer.append(
			{
				schema: "g6-c32-linux-probe/1",
				complete,
				endedAt: new Date().toISOString(),
				queueCadenceMs: QUEUE_CADENCE_MS,
				schedCadenceMs: SCHED_CADENCE_MS,
				queueSamples,
				schedSamples,
				artifactBytes: writer.bytes,
				truncated: writer.truncated,
				problems: uniqueProblems,
				summary: {
					peakReceiveQueueBytes,
					peakDrops,
					effectiveReceiveBufferBytes,
					drainStallAligned: pressureAlignments >= 2,
					pressureAlignments,
				},
			},
			true,
		);
		process.exit(complete && finalWritten ? 0 : 2);
	};
	process.on("SIGTERM", finish);
	process.on("SIGINT", finish);
	process.stdout.write("g6-linux-probe: ready\n");
}

if (import.meta.main) {
	const mode = requireArg("mode");
	const out = requireArg("out");
	if (mode === "preflight") preflight(requireArg("role"), out);
	else if (mode === "connect")
		connectProbe(
			out,
			requireArg("shards"),
			positiveInteger("max-bytes", DEFAULT_MAX_BYTES),
		);
	else throw new Error(`g6-linux-probe: unsupported mode ${mode}`);
}
