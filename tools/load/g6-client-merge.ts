/**
 * Merge the reports of N mmo-client processes into one `mmo-client/2` report.
 *
 * A single generator process saturates before the box does (P0.0 on the home
 * rig: a 32-session canary saw a 11.6 ms max RTT while the 3000-session client
 * beside it reported a 63 ms p99 through the same server path), so the scan
 * can run the generator as several processes. Every grader reads one client
 * report, so the processes' reports are merged here into exactly that shape:
 * counters are summed, histograms are merged bucket by bucket (same bucketing
 * on both sides, so the merged summary equals the summary of the union),
 * percentiles that cannot be merged take the worst process as the honest
 * bound, and per-run facts (config, preregistration) come from the first
 * process.
 */
import type { LatencyHistogramJson } from "./latency-histogram.ts";

export type ClientProcessPlan = {
	index: number;
	sessions: number;
	activeSessions: number;
	endpoints: number;
	fixedSourcePortBase: number | null;
};

/**
 * The `index`-th of `processes` even shares of `total` (remainders to the
 * lowest indices), so the shares always sum to exactly `total`. The connect
 * shape (concurrency, rate) must be split this way: the merged report sums
 * the per-process values and the grader compares that sum with the frozen
 * profile, so rounding each share would misstate the registered shape.
 */
export function evenShare(
	total: number,
	processes: number,
	index: number,
): number {
	if (
		!Number.isSafeInteger(total) ||
		total < 0 ||
		!Number.isInteger(processes) ||
		processes < 1 ||
		!Number.isInteger(index) ||
		index < 0 ||
		index >= processes
	)
		throw new Error(
			`cannot take share ${index} of ${total} across ${processes} processes`,
		);
	return Math.floor(total / processes) + (index < total % processes ? 1 : 0);
}

/**
 * Split one rung across `processes` generator processes. Sessions and
 * endpoints are divided evenly (remainders go to the lowest indices); with a
 * fixed source-port base each process gets its own contiguous port range so
 * the kernel never sees two sockets on one port.
 */
export function allocateClientProcesses(input: {
	processes: number;
	sessions: number;
	activeSessions: number;
	endpoints: number;
	fixedSourcePortBase: number | null;
}): ClientProcessPlan[] {
	const n = input.processes;
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`client processes must be a positive integer, got ${n}`);
	}
	if (input.endpoints < n) {
		throw new Error(
			`${input.endpoints} endpoints cannot be split across ${n} client processes`,
		);
	}
	const split = (total: number, i: number): number =>
		Math.floor(total / n) + (i < total % n ? 1 : 0);
	const endpointsPer = Math.floor(input.endpoints / n);
	const plans: ClientProcessPlan[] = [];
	for (let i = 0; i < n; i += 1) {
		plans.push({
			index: i,
			sessions: split(input.sessions, i),
			activeSessions: split(input.activeSessions, i),
			endpoints: endpointsPer + (i < input.endpoints % n ? 1 : 0),
			fixedSourcePortBase:
				input.fixedSourcePortBase === null
					? null
					: input.fixedSourcePortBase +
						i * endpointsPer +
						Math.min(i, input.endpoints % n),
		});
	}
	return plans;
}

export function mergeHistograms(
	histograms: LatencyHistogramJson[],
): LatencyHistogramJson {
	const first = histograms[0];
	if (first === undefined) throw new Error("no histograms to merge");
	const counts = new Map<number, number>();
	let count = 0;
	let recordedTotal = 0;
	let negative = 0;
	let sumNs = 0;
	let minNs = Number.POSITIVE_INFINITY;
	let maxNs = 0;
	for (const h of histograms) {
		if (
			h.version !== first.version ||
			h.subBits !== first.subBits ||
			h.maxOctave !== first.maxOctave
		) {
			throw new Error(
				`histogram bucketing differs (version/subBits/maxOctave ${h.version}/${h.subBits}/${h.maxOctave} vs ${first.version}/${first.subBits}/${first.maxOctave})`,
			);
		}
		for (const [index, c] of h.buckets)
			counts.set(index, (counts.get(index) ?? 0) + c);
		count += h.count;
		recordedTotal += h.recordedTotal;
		negative += h.negative;
		sumNs += h.sumNs;
		if (h.count > 0) {
			minNs = Math.min(minNs, h.minNs);
			maxNs = Math.max(maxNs, h.maxNs);
		}
	}
	return {
		version: first.version,
		subBits: first.subBits,
		maxOctave: first.maxOctave,
		buckets: [...counts.entries()].sort((a, b) => a[0] - b[0]),
		count,
		recordedTotal,
		negative,
		minNs: count > 0 ? minNs : 0,
		maxNs,
		sumNs,
	};
}

type Rec = Record<string, unknown>;

function isHistogram(value: unknown): value is LatencyHistogramJson {
	return (
		value !== null &&
		typeof value === "object" &&
		Array.isArray((value as Rec).buckets) &&
		typeof (value as Rec).subBits === "number"
	);
}

/**
 * Merge same-shaped records: numbers sum, histograms merge, booleans OR,
 * arrays concatenate, nested records recurse, anything else keeps the first
 * process's value.
 */
function mergeRecords(records: Rec[]): Rec {
	const out: Rec = {};
	const first = records[0] ?? {};
	for (const key of Object.keys(first)) {
		const values = records.map((r) => r[key]);
		const sample = first[key];
		if (typeof sample === "number") {
			out[key] = values.reduce<number>(
				(acc, v) => acc + (typeof v === "number" ? v : 0),
				0,
			);
		} else if (typeof sample === "boolean") {
			out[key] = values.some((v) => v === true);
		} else if (Array.isArray(sample)) {
			out[key] = values.flatMap((v) => (Array.isArray(v) ? v : []));
		} else if (isHistogram(sample)) {
			out[key] = mergeHistograms(values.filter(isHistogram));
		} else if (sample !== null && typeof sample === "object") {
			out[key] = mergeRecords(
				values.filter((v): v is Rec => v !== null && typeof v === "object"),
			);
		} else {
			out[key] = sample;
		}
	}
	return out;
}

function maxOf(records: Rec[], key: string): number {
	return Math.max(
		...records.map((r) =>
			typeof r[key] === "number" ? (r[key] as number) : 0,
		),
	);
}

function asRec(value: unknown): Rec | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Rec)
		: null;
}

function sumKeyed(parts: unknown[]): Rec | null {
	const out: Record<string, number> = {};
	for (const part of parts) {
		const counts = asRec(part);
		if (counts === null) return null;
		for (const [key, value] of Object.entries(counts)) {
			if (typeof value !== "number") return null;
			out[key] = (out[key] ?? 0) + value;
		}
	}
	return out;
}

/**
 * The sharded arms' block (mmo-client `arms`, present only in hotspot and
 * storm cells). Generic summing would add shard counts and instants, so it
 * is merged by meaning: placement facts from the first process, per-shard
 * session counts summed key by key, per-shard windows merged like the
 * process-wide ones (histograms bucket by bucket), and the anchored storm's
 * per-process instants kept per process with the cross-process sever skew
 * (V-T) and the merged first-Initial lateness (V-R) beside them.
 */
export function mergeArmsBlocks(recs: Rec[]): Rec {
	const blocks = recs.map((r) => asRec(r.arms));
	const first = blocks[0];
	if (first === null || first === undefined || blocks.some((b) => b === null))
		throw new Error("arms block missing from some client processes");
	const present = blocks as Rec[];
	for (const key of ["shardCount", "dcidLen", "raidMembership"]) {
		if (present.some((b) => b[key] !== first[key]))
			throw new Error(`client processes disagree on arms.${key}`);
	}
	const byShard = present.map((b) => asRec(b.sessionsByShard) ?? {});
	const shards =
		first.shards === null
			? null
			: mergeRecords(present.map((b) => (asRec(b.shards) ?? {}) as Rec));
	const storms = present.map((b) => asRec(b.storm));
	const firstStorm = storms[0];
	let storm: Rec | null = null;
	if (firstStorm !== null && firstStorm !== undefined) {
		if (storms.some((s) => s === null))
			throw new Error("storm block missing from some client processes");
		const all = storms as Rec[];
		const sum = (key: string) =>
			all.reduce<number>(
				(acc, s) => acc + (typeof s[key] === "number" ? (s[key] as number) : 0),
				0,
			);
		const lateness = all.map((s) => s.reconnectInitialLate).filter(isHistogram);
		const sever = all.map((s) => s.severUnixMs);
		const severKnown = sever.every((v) => typeof v === "number");
		storm = {
			timeline: firstStorm.timeline,
			cohort: sum("cohort"),
			reconnectDelayMs: firstStorm.reconnectDelayMs,
			severedClosed: sum("severedClosed"),
			reconnectInitials: sum("reconnectInitials"),
			initialIssueClock: firstStorm.initialIssueClock,
			reconnectInitialLate:
				lateness.length === all.length ? mergeHistograms(lateness) : null,
			severSkewMs: severKnown
				? Math.max(...(sever as number[])) - Math.min(...(sever as number[]))
				: null,
			processes: all.map((s) => ({
				cohort: s.cohort,
				severUnixMs: s.severUnixMs,
				severMonotonicNs: s.severMonotonicNs,
				stormStartUnixMs: s.stormStartUnixMs,
				stormEndUnixMs: s.stormEndUnixMs,
				severBarrier: s.severBarrier,
				severedClosed: s.severedClosed,
				reconnectInitials: s.reconnectInitials,
				reconnectInitialLateMaxNs: isHistogram(s.reconnectInitialLate)
					? s.reconnectInitialLate.count > 0
						? s.reconnectInitialLate.maxNs
						: null
					: null,
			})),
		};
	}
	return {
		shardCount: first.shardCount,
		targetSlot: first.targetSlot,
		targetServerId: first.targetServerId,
		dcidLen: first.dcidLen,
		serverCidLen: first.serverCidLen,
		dcidHashPlaced: first.dcidHashPlaced,
		placement: first.placement,
		raidMembership: first.raidMembership,
		raidJoinsSent: present.reduce<number>(
			(acc, b) =>
				acc + (typeof b.raidJoinsSent === "number" ? b.raidJoinsSent : 0),
			0,
		),
		sessionsByShard: {
			steadyEntry: sumKeyed(byShard.map((b) => b.steadyEntry)),
			stormEnd: sumKeyed(byShard.map((b) => b.stormEnd)),
			idle: sumKeyed(byShard.map((b) => b.idle)),
		},
		shards,
		storm,
	};
}

export function mergeClientReports(reports: unknown[]): Rec {
	const recs = reports.filter(
		(r): r is Rec => r !== null && typeof r === "object",
	);
	const first = recs[0];
	if (first === undefined) throw new Error("no reports to merge");
	for (const r of recs) {
		if (r.schema !== first.schema) {
			throw new Error(
				`client report schema differs: ${String(r.schema)} vs ${String(first.schema)}`,
			);
		}
	}
	if (recs.length === 1)
		return {
			...first,
			...(first.arms !== undefined ? { arms: mergeArmsBlocks(recs) } : {}),
			clientProcesses: 1,
		};
	const summed = mergeRecords(recs);
	const acceptMs = recs.map((r) => (r.acceptMs ?? {}) as Rec);
	return {
		...summed,
		schema: first.schema,
		startedAt: recs.map((r) => String(r.startedAt)).sort()[0],
		preRegistration: first.preRegistration,
		role: first.role,
		staggerSends: first.staggerSends,
		// Wall time is the slowest process; timed out if any did.
		connectWallSec: maxOf(recs, "connectWallSec"),
		connectTimedOut: recs.some((r) => r.connectTimedOut === true),
		// Percentiles of separate populations cannot be merged; the worst
		// process is the honest bound the graders can read.
		acceptMs: {
			p50: maxOf(acceptMs, "p50"),
			p90: maxOf(acceptMs, "p90"),
			p99: maxOf(acceptMs, "p99"),
			max: maxOf(acceptMs, "max"),
		},
		storm: first.storm,
		phaseBarrier: first.phaseBarrier,
		config: first.config,
		hostUdp: first.hostUdp,
		...(first.arms !== undefined ? { arms: mergeArmsBlocks(recs) } : {}),
		clientProcesses: recs.length,
	};
}
