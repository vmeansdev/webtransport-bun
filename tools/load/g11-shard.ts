/**
 * G11's multi-process generator: the shard plan, and the merge that makes K
 * shard summaries read as one fleet.
 *
 * Why this exists: at T-100 the single tunnel-client process could not source
 * the registered offer — ~217% of one core and 0.41 of the downstream target
 * while the host sat at 72% — so the T arm's offered load has to scale past one
 * process's ceiling. T-50 sourced exactly, which is where the default
 * sessions-per-shard figure comes from.
 *
 * Aggregation rules, in order of how easily each is gotten wrong:
 *
 * - **Latency merges samples, never percentiles.** Every shard ships its full
 *   histogram snapshot (bucket edges travel with it), the counts are summed
 *   element-wise, and the percentile is taken once over the merged population.
 * - **Client CPU is the SUM across shard processes.** The ceiling it is checked
 *   against (`clientCpuCeilingPctOfOneCore` = cores × 100) still holds: the
 *   shards run on the same box, so their summed CPU cannot exceed what the box
 *   has, and a sum at the ceiling means the same thing one process at the
 *   ceiling meant — the generator ran out of machine while offering short.
 * - **A shard failure is a cell failure.** One missing or unparseable shard
 *   summary makes the merged summary absent, never a smaller fleet that grades.
 * - **Clock honesty needs no merging at all.** Both ends stamp
 *   CLOCK_REALTIME (`g11-frame.ts`, `tunnel_client.rs` `wall_ns`), which is one
 *   system-wide clock: a frame stamped in shard 2 and received by the server
 *   compares exactly as it did single-process, and V-N still catches any
 *   instrument fault as negative samples.
 *
 * Session identity: shards get contiguous global index ranges via the
 * generator's `--session-base`, so the server's per-session ledger and the
 * merged `perSession` rows stay distinct — two shards both numbering from 0
 * would fold different sessions into one key.
 */

import type { LatencySnapshot } from "./g11-histogram.ts";

export type ShardSlice = { base: number; sessions: number };

/**
 * Split `sessions` into ceil(sessions / maxPerShard) contiguous slices whose
 * sizes differ by at most one. `maxPerShard` at or above `sessions` yields the
 * single-shard plan, which drives exactly the process the cell drove before
 * sharding existed.
 */
export function shardPlan(sessions: number, maxPerShard: number): ShardSlice[] {
	if (!Number.isInteger(sessions) || sessions < 1)
		throw new Error(`g11: shard plan for ${sessions} sessions`);
	if (!Number.isInteger(maxPerShard) || maxPerShard < 1)
		throw new Error(
			`g11: sessions-per-shard must be a positive integer, got ${maxPerShard}`,
		);
	const count = Math.ceil(sessions / maxPerShard);
	const per = Math.floor(sessions / count);
	const extra = sessions % count;
	const slices: ShardSlice[] = [];
	let base = 0;
	for (let i = 0; i < count; i += 1) {
		const size = per + (i < extra ? 1 : 0);
		slices.push({ base, sessions: size });
		base += size;
	}
	return slices;
}

/**
 * Sum two snapshots' populations. Exact, not approximate: every shard buckets
 * with the same edges (the layout is one function in each language), so adding
 * counts index-wise is the same operation as having recorded every sample into
 * one histogram. A layout mismatch is an instrument fault and is refused.
 */
export function mergeLatencySnapshots(
	snapshots: LatencySnapshot[],
): LatencySnapshot {
	if (snapshots.length === 0)
		throw new Error("g11: merging zero latency snapshots");
	const first = snapshots[0] as LatencySnapshot;
	const merged: LatencySnapshot = {
		negativeCount: 0,
		bucketUpperMs: first.bucketUpperMs.slice(),
		bucketCounts: new Array(first.bucketUpperMs.length).fill(0),
		maxMs: 0,
	};
	for (const s of snapshots) {
		if (
			s.bucketUpperMs.length !== merged.bucketUpperMs.length ||
			s.bucketCounts.length !== merged.bucketCounts.length
		) {
			throw new Error(
				`g11: shard histograms disagree on layout (${s.bucketCounts.length} vs ${merged.bucketCounts.length} buckets) — cannot merge honestly`,
			);
		}
		merged.negativeCount += s.negativeCount;
		if (s.maxMs > merged.maxMs) merged.maxMs = s.maxMs;
		for (let i = 0; i < merged.bucketCounts.length; i += 1)
			merged.bucketCounts[i] =
				(merged.bucketCounts[i] ?? 0) + (s.bucketCounts[i] ?? 0);
	}
	return merged;
}

/**
 * The generator summary, exactly as the conductor has always parsed it off one
 * child. Lives here so the merge and the conductor read one declaration.
 */
export type ClientSummary = {
	runId: string;
	host: string;
	drivingSessions: number;
	sessionsOk?: number;
	sessionsErr?: number;
	streamsErr?: number;
	streamErrors?: number;
	streamsClosedBothHalves: number;
	framesWritten?: number;
	bytesWritten: number;
	framesRead?: number;
	bytesRead: number;
	exchangesAttempted?: number;
	exchangesCompleted?: number;
	streamsOpened?: number;
	peakConcurrentBidiPerSession?: number;
	perSession: {
		index: number;
		bytesWritten: number;
		framesWritten: number;
		bytesRead: number;
		framesRead: number;
	}[];
	latency: LatencySnapshot;
	schedulerLag: LatencySnapshot;
	/** Rust generator only: write call → write settled. Disclosure, not a bar. */
	writeSettle?: LatencySnapshot;
	writeLatency?: LatencySnapshot;
	writeLatencyP99Ms?: number;
	backpressureTimeouts?: number;
	peakSessionQueuedBytes?: number | null;
	peakInboundStreamBytes?: number | null;
	peakInboundSessionBytes?: number | null;
	inboundReservedTotalBytes?: number | null;
	inboundReserveTimeouts?: number | null;
	crossings?: {
		dataCrossings: number;
		batchedCrossings: number;
		terminalCrossings: number;
		bytes: number;
		maxBatchBytes: number;
		meanBytesPerCrossing: number;
	};
};

/** Sum an optional counter: absent everywhere stays absent, present anywhere sums. */
function sumOpt(
	shards: ClientSummary[],
	pick: (s: ClientSummary) => number | undefined,
): number | undefined {
	if (shards.every((s) => pick(s) === undefined)) return undefined;
	return shards.reduce((acc, s) => acc + (pick(s) ?? 0), 0);
}

function maxOpt(
	shards: ClientSummary[],
	pick: (s: ClientSummary) => number | undefined,
): number | undefined {
	if (shards.every((s) => pick(s) === undefined)) return undefined;
	return shards.reduce((acc, s) => Math.max(acc, pick(s) ?? 0), 0);
}

/**
 * K shard summaries → the summary one process driving the whole fleet would
 * have printed. With one shard this is the identity (a copied structure with
 * the same numbers), which is what keeps the K=1 path byte-equivalent to the
 * unsharded conductor.
 *
 * Refuses shards that disagree on runId or host: the floor report's provenance
 * check (V-G2) compares those against the cell, and a merged summary must not
 * launder a shard that ran under a different identity.
 */
export function mergeClientSummaries(shards: ClientSummary[]): ClientSummary {
	if (shards.length === 0) throw new Error("g11: merging zero shard summaries");
	const first = shards[0] as ClientSummary;
	for (const s of shards) {
		if (s.runId !== first.runId || s.host !== first.host) {
			throw new Error(
				`g11: shard summaries disagree on provenance (${s.runId}/${s.host} vs ${first.runId}/${first.host})`,
			);
		}
	}
	const perSession = shards
		.flatMap((s) => s.perSession)
		.slice()
		.sort((a, b) => a.index - b.index);
	for (let i = 1; i < perSession.length; i += 1) {
		const a = perSession[i - 1];
		const b = perSession[i];
		if (a && b && a.index === b.index) {
			throw new Error(
				`g11: two shards both report session ${a.index} — session bases overlap and the per-session ledger is corrupt`,
			);
		}
	}

	return {
		runId: first.runId,
		host: first.host,
		drivingSessions: shards.reduce((acc, s) => acc + s.drivingSessions, 0),
		sessionsOk: sumOpt(shards, (s) => s.sessionsOk),
		sessionsErr: sumOpt(shards, (s) => s.sessionsErr),
		streamsErr: sumOpt(shards, (s) => s.streamsErr),
		streamErrors: sumOpt(shards, (s) => s.streamErrors),
		streamsClosedBothHalves: shards.reduce(
			(acc, s) => acc + s.streamsClosedBothHalves,
			0,
		),
		framesWritten: sumOpt(shards, (s) => s.framesWritten),
		bytesWritten: shards.reduce((acc, s) => acc + s.bytesWritten, 0),
		framesRead: sumOpt(shards, (s) => s.framesRead),
		bytesRead: shards.reduce((acc, s) => acc + s.bytesRead, 0),
		exchangesAttempted: sumOpt(shards, (s) => s.exchangesAttempted),
		exchangesCompleted: sumOpt(shards, (s) => s.exchangesCompleted),
		streamsOpened: sumOpt(shards, (s) => s.streamsOpened),
		peakConcurrentBidiPerSession: maxOpt(
			shards,
			(s) => s.peakConcurrentBidiPerSession,
		),
		perSession,
		latency: mergeLatencySnapshots(shards.map((s) => s.latency)),
		schedulerLag: mergeLatencySnapshots(shards.map((s) => s.schedulerLag)),
		writeSettle: shards.every((s) => s.writeSettle)
			? mergeLatencySnapshots(
					shards.map((s) => s.writeSettle as LatencySnapshot),
				)
			: undefined,
		backpressureTimeouts: sumOpt(shards, (s) => s.backpressureTimeouts),
		// JS-client-only instruments (Arm J/D) are never sharded; carrying a
		// merged reading for them would invent numbers the shards did not take.
		// They stay absent unless exactly one shard carried them (the K=1 path).
		...(shards.length === 1
			? {
					writeLatency: first.writeLatency,
					writeLatencyP99Ms: first.writeLatencyP99Ms,
					peakSessionQueuedBytes: first.peakSessionQueuedBytes,
					peakInboundStreamBytes: first.peakInboundStreamBytes,
					peakInboundSessionBytes: first.peakInboundSessionBytes,
					inboundReservedTotalBytes: first.inboundReservedTotalBytes,
					inboundReserveTimeouts: first.inboundReserveTimeouts,
					crossings: first.crossings,
				}
			: {}),
	};
}

/** The slice of `Bun.Subprocess` the composite needs; matches DeadlineChild. */
export type ShardChild = {
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
};

/**
 * K children as one child under the conductor's per-cell deadline.
 *
 * The composite exits when *every* shard has exited, and its exit code is the
 * first non-zero one (a spawn failure reads as -1) — so one dead shard fails
 * the cell the same way the single generator dying always has, and one wedged
 * shard breaches the same deadline. Killing the composite kills every shard.
 */
export function compositeShardChild(children: ShardChild[]): ShardChild {
	if (children.length === 0)
		throw new Error("g11: composite child over zero shards");
	const exited = Promise.all(
		children.map((c) =>
			c.exited.then(
				(code) => code,
				() => -1,
			),
		),
	).then((codes) => codes.find((code) => code !== 0) ?? 0);
	return {
		exited,
		kill(signal?: number | NodeJS.Signals) {
			for (const c of children) c.kill(signal);
		},
	};
}
