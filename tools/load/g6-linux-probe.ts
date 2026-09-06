/** Bounded Linux-only queue, socket-drop, softirq, softnet and schedstat probe. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
	type ProbeUdpIdentity,
	sampleProbeUdp,
	type UdpSocketCounters,
} from "./g6-sharded-diagnostic.ts";

const QUEUE_CADENCE_MS = 10;
const SCHED_CADENCE_MS = 50;
// Sized for the 50k ladder rung: r72's L20000-1 measured ~197 KB/s of probe
// output and truncated a ~150s cell at the old 16 MiB cap; a 50k cell runs
// ~300s (~60 MB), so 128 MiB keeps >2x margin. Truncation stays fail-closed.
export const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const FINAL_RESERVE_BYTES = 64 * 1024;
const REQUIRED_PHASES = ["connect", "steady", "drain", "idle"] as const;
const OPTIONAL_PHASES = ["closed"] as const;
type ProbePhase =
	| (typeof REQUIRED_PHASES)[number]
	| (typeof OPTIONAL_PHASES)[number];
const MAX_DISTINCT_PROBLEMS = 32;

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

export function parseProcSelfStatCpu(text: string): {
	userJiffies: number;
	systemJiffies: number;
} | null {
	const match = text.match(/^\d+ \((.*)\) (.*)$/s);
	if (!match) return null;
	const rest = (match[2] ?? "").trim().split(/\s+/);
	if (rest.length < 13) return null;
	const userJiffies = Number(rest[11]);
	const systemJiffies = Number(rest[12]);
	if (
		![userJiffies, systemJiffies].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		)
	)
		return null;
	return { userJiffies, systemJiffies };
}

export function parseLoadavg(text: string): {
	load1: number;
	load5: number;
	load15: number;
} | null {
	const fields = text.trim().split(/\s+/);
	if (fields.length < 3) return null;
	const values = fields.slice(0, 3).map(Number);
	if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
	return {
		load1: values[0] as number,
		load5: values[1] as number,
		load15: values[2] as number,
	};
}

export function parseProcsRunning(text: string): number | null {
	const line = text
		.split(/\r?\n/)
		.find((entry) => /^procs_running\s/.test(entry));
	if (!line) return null;
	const value = Number(line.trim().split(/\s+/)[1]);
	if (!Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

export function cpuJiffiesToSec(delta: number, hz: number): number | null {
	if (!Number.isFinite(delta) || delta < 0 || !Number.isFinite(hz) || hz <= 0)
		return null;
	return delta / hz;
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

export function effectiveSocketBufferSummary(
	socketMemory: Map<
		number,
		{ receiveBufferBytes: number; sendBufferBytes: number }
	>,
	shards: ReadonlyArray<{ pid: number }>,
): {
	effectiveReceiveBufferBytes: number | null;
	effectiveSendBufferBytes: number | null;
} {
	const effectiveBuffers = shards.map(
		(shard) => socketMemory.get(shard.pid) ?? null,
	);
	if (effectiveBuffers.some((value) => value === null)) {
		return {
			effectiveReceiveBufferBytes: null,
			effectiveSendBufferBytes: null,
		};
	}
	const uniqueReceive = new Set(
		effectiveBuffers.map((value) => value?.receiveBufferBytes),
	);
	const uniqueSend = new Set(
		effectiveBuffers.map((value) => value?.sendBufferBytes),
	);
	return {
		effectiveReceiveBufferBytes:
			uniqueReceive.size === 1
				? (effectiveBuffers[0]?.receiveBufferBytes ?? null)
				: null,
		effectiveSendBufferBytes:
			uniqueSend.size === 1
				? (effectiveBuffers[0]?.sendBufferBytes ?? null)
				: null,
	};
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

function isSha256Hex(value: string): boolean {
	return /^[0-9a-f]{64}$/i.test(value);
}

export function parseLinuxProbeDetailMode(value: string | null): "on" {
	if (value !== "on")
		throw new Error(
			"g6-linux-probe: active sampler requires --detail-mode on; disable the child with SCAN_LINUX_PROBE_ENABLED=0",
		);
	return "on";
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

export const MIN_SHARD_SOCKET_INODES = 1;
export const MAX_SHARD_SOCKET_INODES = 4;

export function shardSocketInodeProblem(
	serverId: number,
	inodeCount: number,
): string | null {
	if (
		inodeCount < MIN_SHARD_SOCKET_INODES ||
		inodeCount > MAX_SHARD_SOCKET_INODES
	)
		return `server ${serverId} owns ${inodeCount} UDP socket inodes`;
	return null;
}

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
	// The shard count is the list length; the IDs must be exactly 1..N so a
	// dropped or duplicated shard cannot hide behind a matching count.
	const count = targets.length;
	if (
		count < 1 ||
		count > 64 ||
		new Set(targets.map((target) => target.serverId)).size !== count ||
		new Set(targets.map((target) => target.pid)).size !== count ||
		targets.some(
			(target) =>
				!Number.isSafeInteger(target.serverId) ||
				!Number.isSafeInteger(target.pid) ||
				target.serverId < 1 ||
				target.serverId > count ||
				target.pid <= 0,
		)
	)
		throw new Error(
			`g6-linux-probe: connect mode requires exactly server IDs 1..${count || 1}`,
		);
	return targets.toSorted((left, right) => left.serverId - right.serverId);
}

export function linuxProbeProducerSha256(): string {
	return createHash("sha256")
		.update(readFileSync(new URL(import.meta.url)))
		.digest("hex");
}

function connectProbe(out: string, shardsRaw: string, maxBytes: number): void {
	if (process.platform !== "linux")
		throw new Error("g6-linux-probe: connect mode requires Linux");
	const producerSha256 = requireArg("producer-sha256").toLowerCase();
	if (!isSha256Hex(producerSha256))
		throw new Error(
			"g6-linux-probe: --producer-sha256 must be a 64-hex SHA-256",
		);
	if (producerSha256 !== linuxProbeProducerSha256())
		throw new Error(
			"g6-linux-probe: requested producer SHA differs from executing source",
		);
	const measurementMode = {
		detail: parseLinuxProbeDetailMode(arg("detail-mode")),
		phaseAware: true as const,
	};
	const writer = new JsonlBudget(out, maxBytes);
	const problems: string[] = [];
	const problemSet = new Set<string>();
	let omittedProblems = 0;
	const rememberProblem = (message: string): void => {
		if (problemSet.has(message)) return;
		if (problems.length < MAX_DISTINCT_PROBLEMS) {
			problemSet.add(message);
			problems.push(message);
		} else omittedProblems += 1;
	};
	const problemSummary = (): string[] =>
		omittedProblems === 0
			? [...problems]
			: [...problems, `additional problems omitted: ${omittedProblems}`];
	const shards = parseShards(shardsRaw);
	let frozen: ProbeUdpIdentity[] = [];
	try {
		frozen = sampleProbeUdp(shards).identities;
		for (const shard of shards)
			shard.inodes = new Set(
				frozen.find((row) => row.serverId === shard.serverId)?.inodes,
			);
	} catch (error) {
		rememberProblem(`initial UDP socket identity failed: ${String(error)}`);
	}
	for (const shard of shards) {
		const inodeProblem = shardSocketInodeProblem(
			shard.serverId,
			shard.inodes.size,
		);
		if (inodeProblem) rememberProblem(inodeProblem);
	}
	const ssText = command("ss", ["-u", "-n", "-m", "-p", "-a"]);
	const socketMemory = ssText ? parseSsSocketMemory(ssText) : new Map();
	for (const shard of shards)
		if (!socketMemory.has(shard.pid))
			rememberProblem(`server ${shard.serverId} has no ss skmem evidence`);
	const clkTck = Number(command("getconf", ["CLK_TCK"]));
	const cpuStart = parseProcSelfStatCpu(read("/proc/self/stat") ?? "");
	if (!Number.isSafeInteger(clkTck) || clkTck <= 0 || cpuStart === null)
		rememberProblem("probe CPU baseline is unavailable");
	const phaseCoverage = Object.fromEntries(
		REQUIRED_PHASES.map((phase) => [
			phase,
			{ queueSamples: 0, schedSamples: 0 },
		]),
	) as Record<
		(typeof REQUIRED_PHASES)[number],
		{ queueSamples: number; schedSamples: number }
	>;
	const phaseBoundaries: Partial<
		Record<ProbePhase, { monotonicNs: string; requestId: number | null }>
	> = {};
	const phaseStats = Object.fromEntries(
		[...REQUIRED_PHASES, ...OPTIONAL_PHASES].map((phase) => [
			phase,
			{ peakReceiveQueueBytes: 0, peakDrops: 0, pressureAlignments: 0 },
		]),
	) as Record<
		ProbePhase,
		{
			peakReceiveQueueBytes: number;
			peakDrops: number;
			pressureAlignments: number;
		}
	>;
	let currentPhase: ProbePhase | null = null;
	writer.append({
		schema: "g6-c32-linux-probe-header/2",
		queueCadenceMs: QUEUE_CADENCE_MS,
		schedCadenceMs: SCHED_CADENCE_MS,
		startedAt: new Date().toISOString(),
		measurementMode,
		producerSha256,
		phaseOrder: REQUIRED_PHASES,
		clkTck,
		probeCpuStart: cpuStart,
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
				schema: "g6-c32-linux-probe/2",
				complete: false,
				endedAt: new Date().toISOString(),
				queueCadenceMs: QUEUE_CADENCE_MS,
				schedCadenceMs: SCHED_CADENCE_MS,
				queueSamples: 0,
				schedSamples: 0,
				artifactBytes: writer.bytes,
				truncated: writer.truncated,
				measurementMode,
				producerSha256,
				childExit: { code: 2, signal: null },
				phaseBoundaries,
				phaseCoverage,
				problems: problemSummary(),
				summary: null,
				historicalConnectSummary: {
					peakReceiveQueueBytes: 0,
					peakDrops: 0,
					queueSamples: 0,
					schedSamples: 0,
				},
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
	let peakProcsRunning = 0;
	let peakLoad1 = 0;
	let lastPhaseIndex = -1;

	const setPhase = (
		phase: ProbePhase,
		requestId: number | null,
	): { monotonicNs: string; duplicate: boolean; error: string | null } => {
		const monotonicNs = process.hrtime.bigint().toString();
		if (currentPhase === phase) {
			return { monotonicNs, duplicate: true, error: null };
		}
		const nextIndex = [...REQUIRED_PHASES, ...OPTIONAL_PHASES].indexOf(phase);
		if (nextIndex !== lastPhaseIndex + 1) {
			const error = `unsupported phase order ${currentPhase ?? "unarmed"} -> ${phase}`;
			rememberProblem(error);
			return { monotonicNs, duplicate: false, error };
		}
		currentPhase = phase;
		lastPhaseIndex = nextIndex;
		phaseBoundaries[phase] = { monotonicNs, requestId };
		if (
			!writer.append({
				schema: "g6-c32-linux-probe-phase/1",
				phase,
				monotonicNs,
				requestId,
			})
		) {
			rememberProblem(`phase boundary artifact truncated at ${phase}`);
		}
		return { monotonicNs, duplicate: false, error: null };
	};

	const sample = (): void => {
		if (currentPhase === null) return;
		const monotonicNs = process.hrtime.bigint().toString();
		let countersByShard = new Map<number, UdpSocketCounters>();
		try {
			countersByShard = sampleProbeUdp(shards, frozen).counters;
		} catch (error) {
			for (const shard of shards)
				rememberProblem(
					`server ${shard.serverId} socket sample failed: ${String(error)}`,
				);
		}
		const rows = shards.map((shard) => {
			const counters = countersByShard.get(shard.serverId);
			if (!counters || counters.socketCount !== shard.inodes.size)
				rememberProblem(`server ${shard.serverId} socket sample is incomplete`);
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
		phaseStats[currentPhase].peakReceiveQueueBytes = Math.max(
			phaseStats[currentPhase].peakReceiveQueueBytes,
			totalQueue,
		);
		phaseStats[currentPhase].peakDrops = Math.max(
			phaseStats[currentPhase].peakDrops,
			totalDrops,
		);
		if (
			writer.append({
				schema: "g6-c32-linux-probe-queue/2",
				phase: currentPhase,
				monotonicNs,
				shards: rows,
			})
		) {
			queueSamples += 1;
			if (currentPhase !== "closed")
				phaseCoverage[currentPhase].queueSamples += 1;
		}
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
				rememberProblem("scheduler/softirq sample failed");
			const totalWait = sched.reduce((sum, row) => sum + (row.waitNs ?? 0), 0);
			const dropGrowth = totalDrops > previousDrops;
			const pressureGrowth =
				totalWait > previousSchedWait ||
				(softnet !== null &&
					previousSoftnet !== null &&
					(softnet.dropped > previousSoftnet.dropped ||
						softnet.timeSqueeze > previousSoftnet.timeSqueeze));
			if (dropGrowth && pressureGrowth) {
				pressureAlignments += 1;
				phaseStats[currentPhase].pressureAlignments += 1;
			}
			previousSoftnet = softnet;
			previousSchedWait = totalWait;
			const load = parseLoadavg(read("/proc/loadavg") ?? "");
			const procsRunning = parseProcsRunning(read("/proc/stat") ?? "");
			if (load) peakLoad1 = Math.max(peakLoad1, load.load1);
			if (procsRunning !== null)
				peakProcsRunning = Math.max(peakProcsRunning, procsRunning);
			if (
				writer.append({
					schema: "g6-c32-linux-probe-sched/2",
					phase: currentPhase,
					monotonicNs,
					netRx,
					softnet,
					sched,
					load1: load?.load1 ?? null,
					procsRunning,
				})
			) {
				schedSamples += 1;
				if (currentPhase !== "closed")
					phaseCoverage[currentPhase].schedSamples += 1;
			}
		}
		previousDrops = totalDrops;
		tick += 1;
	};

	const timer = setInterval(sample, QUEUE_CADENCE_MS);
	const finish = (forcedCode = 0): void => {
		if (finishStarted) return;
		finishStarted = true;
		clearInterval(timer);
		sample();
		const { effectiveReceiveBufferBytes, effectiveSendBufferBytes } =
			effectiveSocketBufferSummary(socketMemory, shards);
		for (const phase of REQUIRED_PHASES) {
			if (!(phase in phaseBoundaries))
				rememberProblem(`missing required phase boundary ${phase}`);
			if (phaseCoverage[phase].queueSamples === 0)
				rememberProblem(`missing ${phase} queue coverage`);
			if (phaseCoverage[phase].schedSamples === 0)
				rememberProblem(`missing ${phase} sched coverage`);
		}
		const uniqueProblems = problemSummary();
		const cpuEnd = parseProcSelfStatCpu(read("/proc/self/stat") ?? "");
		const probeUserSec =
			cpuStart && cpuEnd
				? cpuJiffiesToSec(cpuEnd.userJiffies - cpuStart.userJiffies, clkTck)
				: null;
		const probeSysSec =
			cpuStart && cpuEnd
				? cpuJiffiesToSec(cpuEnd.systemJiffies - cpuStart.systemJiffies, clkTck)
				: null;
		const complete =
			forcedCode === 0 &&
			uniqueProblems.length === 0 &&
			!writer.truncated &&
			queueSamples > 0 &&
			schedSamples > 0 &&
			probeUserSec !== null &&
			probeSysSec !== null &&
			effectiveReceiveBufferBytes !== null &&
			effectiveSendBufferBytes !== null;
		const exitCode = complete ? 0 : 2;
		const finalWritten = writer.append(
			{
				schema: "g6-c32-linux-probe/2",
				complete,
				endedAt: new Date().toISOString(),
				monotonicNs: process.hrtime.bigint().toString(),
				probeCpuEnd: cpuEnd,
				queueCadenceMs: QUEUE_CADENCE_MS,
				schedCadenceMs: SCHED_CADENCE_MS,
				queueSamples,
				schedSamples,
				artifactBytes: writer.bytes,
				truncated: writer.truncated,
				measurementMode,
				producerSha256,
				childExit: { code: exitCode, signal: null },
				phaseBoundaries,
				phaseCoverage,
				problems: uniqueProblems,
				summary: {
					peakReceiveQueueBytes,
					peakDrops,
					effectiveReceiveBufferBytes,
					effectiveSendBufferBytes,
					drainStallAligned: pressureAlignments >= 2,
					pressureAlignments,
					probeUserSec,
					probeSysSec,
					peakProcsRunning,
					peakLoad1,
					clkTck,
				},
				historicalConnectSummary: {
					peakReceiveQueueBytes: phaseStats.connect.peakReceiveQueueBytes,
					peakDrops: phaseStats.connect.peakDrops,
					queueSamples: phaseCoverage.connect.queueSamples,
					schedSamples: phaseCoverage.connect.schedSamples,
					pressureAlignments: phaseStats.connect.pressureAlignments,
					drainStallAligned: phaseStats.connect.pressureAlignments >= 2,
				},
			},
			true,
		);
		process.exit(complete && finalWritten ? 0 : 2);
	};
	process.on("SIGTERM", () => finish(0));
	process.on("SIGINT", () => finish(0));
	process.stdout.write("g6-linux-probe: ready\n");
	const rl = createInterface({ input: process.stdin });
	(async () => {
		try {
			for await (const raw of rl) {
				const line = raw.trim();
				if (line === "") continue;
				const message = JSON.parse(line) as {
					cmd?: string;
					phase?: ProbePhase;
					requestId?: number;
				};
				if (message.cmd !== "phase" || !message.phase) {
					rememberProblem(`unsupported command ${message.cmd ?? "unknown"}`);
					process.stdout.write(
						`${JSON.stringify({
							ev: "phase-error",
							requestId:
								typeof message.requestId === "number"
									? message.requestId
									: null,
							error: `unsupported command ${message.cmd ?? "unknown"}`,
						})}\n`,
					);
					finish(2);
					return;
				}
				const requestId =
					typeof message.requestId === "number" &&
					Number.isSafeInteger(message.requestId) &&
					message.requestId > 0
						? message.requestId
						: null;
				const ack = setPhase(message.phase, requestId);
				if (ack.error !== null) {
					process.stdout.write(
						`${JSON.stringify({
							ev: "phase-error",
							requestId,
							phase: message.phase,
							error: ack.error,
						})}\n`,
					);
					finish(2);
					return;
				}
				process.stdout.write(
					`${JSON.stringify({
						ev: "phase-ack",
						requestId,
						phase: message.phase,
						monotonicNs: ack.monotonicNs,
						duplicate: ack.duplicate,
					})}\n`,
				);
			}
			finish(0);
		} catch (error) {
			rememberProblem(`command loop failed: ${String(error)}`);
			finish(2);
		}
	})().catch((error) => {
		rememberProblem(`command loop failed: ${String(error)}`);
		finish(2);
	});
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
