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
	if (recs.length === 1) return { ...first, clientProcesses: 1 };
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
		clientProcesses: recs.length,
	};
}
