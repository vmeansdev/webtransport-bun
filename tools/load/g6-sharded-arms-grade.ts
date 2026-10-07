/**
 * Grader for pre-registration g6-sharded-arms/1 (plan
 * docs/superpowers/plans/2026-10-06-g6-sharded-arms.md r6, work item 4): the
 * raid hotspot and the reconnect storm on the sharded deployment.
 *
 * An adapter maps the sharded scan's raw evidence (g6-sharded-scan/3 with its
 * `arms` block: the merged and per-process mmo-client reports, the raid and
 * pre-check processes' reports, per-shard windows and boundary echoes) into the
 * shapes `g6-classify.ts` grades. The clause code there is reused unchanged:
 *
 *   - H1, H2 as registered; H4 / V-I with its cadence on shard K's own
 *     publisher arrival gaps;
 *   - H3 and S-C1 are GATED on this deployment's realm contract (sharded S1-S5
 *     with S4 ACK p99 <= 25 ms; S-C1 survivors' ACK p99 <= 25 ms), and G6's
 *     original clauses (C1 >= 0.995, C3 / S-C1 <= 50 ms) are computed by the
 *     unchanged g6-classify functions and reported beside without verdict force;
 *   - S-C2 as registered; S-M is characterization only; V-L strips S-M only.
 *
 * Every falsifier of the plan's table is recomputed here from raw fields
 * (histogram buckets, per-process reports, per-shard windows, raw bpftool
 * text, raw accept instants). The scan's own summary facts (placement.placed,
 * steeringDelta, equal, severSkewMs, ...) are never read as verdicts: where the
 * scan recorded a derived value, the grader recomputes it from the raw field
 * it was derived from and reports both.
 *
 * Nothing here touches hosts or files; the stamp evaluator
 * (g6-sharded-arms-evaluate.ts) and the campaign grader dispatch call it.
 */

import {
	floorReportIsUsable,
	parseGeneratorReport,
} from "../offbox/generator-report.ts";
import { sumPerCpuSteerStats } from "./g6-bpf-map.ts";
import {
	type ClauseResult,
	clauseH1,
	clauseH2,
	clauseH3,
	clauseSC1,
	clauseSC2,
	type FalsifierResult,
	falsifierFloor,
	falsifierGenerator,
	falsifierHistograms,
	falsifierIngestReality,
	falsifierLittle,
	type HistogramFacts,
	type HotspotFacts,
	type SteadyArmFacts,
	type StormFacts,
} from "./g6-classify.ts";
import { evenShare } from "./g6-client-merge.ts";
import {
	floorLagCeilingMs,
	RAID_MEMBERS,
	RAID_PUBLISHER_HZ,
	rttBudgetMs,
	SINK_DELIVERY_FLOOR,
	SINK_HEADROOM_FACTOR,
	SNAPSHOT_HZ,
	snapshotDatagrams,
} from "./g6-plan.ts";
import { G6_SHARDED_CLAUSES } from "./g6-sharded-grade.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
	latencyBucketIndex,
} from "./latency-histogram.ts";

/* ------------------------------------------------------------------------ */
/* Registration (source-encoded; the pre-registration hashes this file)      */
/* ------------------------------------------------------------------------ */

export const SHARDED_ARMS_PREREGISTRATION_ID = "g6-sharded-arms/1" as const;

export type ShardedArm = "hotspot" | "storm";
export type ShardedArmsCellId =
	| "H5k"
	| "H40k"
	| "S1-5k"
	| "S2-5k"
	| "S1-40k"
	| "S2-40k";
export type ShardedArmsCell = Readonly<{
	id: ShardedArmsCellId;
	arm: ShardedArm;
	/** Realm sessions, requested == active (no passive tail). */
	sessions: number;
	/** Severed cohort; 0 for hotspot cells. */
	cohort: number;
	/** gate: verdict force; bridge: H5k, reported beside G6-04; characterization: no verdict force. */
	role: "gate" | "bridge" | "characterization";
	/** Clauses that carry this cell's verdict. */
	gatedClauses: readonly string[];
}>;

/** Registered cells, in the registered run order. */
export const SHARDED_ARMS_CELLS: readonly ShardedArmsCell[] = Object.freeze([
	{
		id: "H5k",
		arm: "hotspot",
		sessions: 5000,
		cohort: 0,
		role: "bridge",
		gatedClauses: ["H1", "H2", "H3"],
	},
	{
		id: "H40k",
		arm: "hotspot",
		sessions: 40000,
		cohort: 0,
		role: "gate",
		gatedClauses: ["H1", "H2", "H3"],
	},
	{
		id: "S1-5k",
		arm: "storm",
		sessions: 5000,
		cohort: 1000,
		role: "gate",
		gatedClauses: ["S-C1", "S-C2"],
	},
	{
		id: "S2-5k",
		arm: "storm",
		sessions: 5000,
		cohort: 5000,
		role: "gate",
		gatedClauses: ["S-C2"],
	},
	{
		id: "S1-40k",
		arm: "storm",
		sessions: 40000,
		cohort: 8000,
		role: "gate",
		gatedClauses: ["S-C1", "S-C2"],
	},
	{
		id: "S2-40k",
		arm: "storm",
		sessions: 40000,
		cohort: 40000,
		role: "characterization",
		gatedClauses: ["S-C2"],
	},
] as const);

export function shardedArmsCell(id: string): ShardedArmsCell {
	const cell = SHARDED_ARMS_CELLS.find((entry) => entry.id === id);
	if (cell === undefined) throw Error(`g6-sharded-arms: unknown cell ${id}`);
	return cell;
}

/** Registered thresholds and shapes (plan r6; frozen with the registration). */
export const SHARDED_ARMS_REGISTERED = Object.freeze({
	/** H3 / S-C1 gated bar: gate-g6-sharded S4. */
	realmAckRttP99CeilingMs: G6_SHARDED_CLAUSES.ackRttP99CeilingMs,
	/** G6's own bar, reported beside H3 / S-C1 without verdict force. */
	g6AckRttBudgetMs: rttBudgetMs(),
	/** Raid instance: slot K; server id K + 1. */
	raidTargetSlot: 0,
	dcidLen: 20,
	hotspotSteadySeconds: 120,
	stormSteadySeconds: 60,
	/** §3.3: the 1 s drain between steady and sever (both kinds). */
	drainSeconds: 1,
	stormReconnectDelayMs: 1000,
	stormWindowSeconds: 120,
	postStormSeconds: 60,
	/** Whole-cell maxima (plan r6 timing). */
	hotspotMaximumSeconds: 480,
	stormMaximumSeconds: 600,
	/** Closeout §3.8 steady-entry skew and V-T sever skew. */
	skewCeilingMs: 100,
	/** V-W. */
	fallbackFractionMax: 0.01,
	/** V-F. */
	floorSessions: 20,
	floorSeconds: 10,
	floorLagCeilingMs: floorLagCeilingMs(),
	/** V-F' per-process generator ceiling. */
	generatorLagCeilingMs: 10,
	/** V-S: 1.5 x 800/s. */
	sinkSeconds: 20,
	sinkArmDownstreamPps: RAID_MEMBERS * RAID_PUBLISHER_HZ,
	/**
	 * V-S originator tolerance: the sink is INVALID only if delivery < 0.995
	 * or the originator's achieved rate < 0.995 x 1,200/s (a skip fraction of
	 * at most 0.5 % is tolerated; the raw skip count is disclosed).
	 */
	sinkOriginatorRateFloor: 0.995,
	/** Boundary wall tolerance (gate-g6-sharded steadyWallMsTolerance). */
	wallToleranceMs: 250,
	/** The forwarder is stopped by the fan-out's SIGTERM after the checks. */
	forwarderStoppedRc: 143,
});

/**
 * V-R's R (ms): fixed before freeze from work item 6's generator
 * characterization (.scratch/bare-metal-campaign/g6-sharded-arms/
 * characterization/v-r-characterization-2026-10-07.md: VM worst case 181 ms
 * at S1-40k's 2,000-per-process cohort; derated projection <= 260 ms).
 * Frozen at 500 ms; a rehearsal R can never replace it (`frozenVR` wins).
 */
export const SHARDED_ARMS_V_R_MS: number | null = 500;

export type VRThreshold = {
	ms: number;
	/** frozen: SHARDED_ARMS_V_R_MS. rehearsal: an explicit dry-stamp value. */
	source: "frozen" | "rehearsal";
};

export function frozenVR(): VRThreshold | null {
	return SHARDED_ARMS_V_R_MS === null
		? null
		: { ms: SHARDED_ARMS_V_R_MS, source: "frozen" };
}

/* ------------------------------------------------------------------------ */
/* Raw access                                                                */
/* ------------------------------------------------------------------------ */

type Row = Record<string, unknown>;

class RawError extends Error {}

function fail(message: string): never {
	throw new RawError(`raw: ${message}`);
}
function obj(value: unknown, label: string): Row {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		fail(`${label} must be an object`);
	return value as Row;
}
function maybeObj(value: unknown): Row | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Row)
		: null;
}
function arr(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value;
}
function num(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		fail(`${label} must be a finite number`);
	return value;
}
function int(value: unknown, label: string): number {
	const n = num(value, label);
	if (!Number.isSafeInteger(n) || n < 0)
		fail(`${label} must be a non-negative integer`);
	return n;
}
function at(value: unknown, path: string): unknown {
	let cur: unknown = value;
	for (const key of path.split(".")) {
		const row = maybeObj(cur);
		if (row === null) fail(`${path} is missing (at ${key})`);
		cur = row[key];
	}
	return cur;
}
const atNum = (value: unknown, path: string) => num(at(value, path), path);
const atInt = (value: unknown, path: string) => int(at(value, path), path);

const REPORT_MARKER = "mmo-client: json ";

/** The single `mmo-client: json` report in a process's stdout lines. */
export function reportFromLines(lines: readonly unknown[], label: string): Row {
	const found = lines.filter(
		(line): line is string =>
			typeof line === "string" && line.startsWith(REPORT_MARKER),
	);
	if (found.length !== 1)
		fail(`${label}: expected exactly one mmo-client report`);
	try {
		return obj(
			JSON.parse((found[0] as string).slice(REPORT_MARKER.length)),
			label,
		);
	} catch (error) {
		if (error instanceof RawError) throw error;
		fail(`${label}: report is not JSON`);
	}
}

/** Merged realm report and the per-process reports from scan.clientStdout. */
export function realmReports(
	scan: Row,
	processes: number,
): { merged: Row; perProcess: Row[] } {
	const stdout = scan.clientStdout;
	if (typeof stdout !== "string") fail("scan.clientStdout must be text");
	const lines = stdout.split(/\r?\n/);
	const merged = reportFromLines(lines, "merged realm report");
	if (processes === 1) return { merged, perProcess: [merged] };
	const perProcess: Row[] = [];
	for (let i = 0; i < processes; i += 1) {
		const prefix = `mmo-client[${i}]: json `;
		const own = lines.filter((line) => line.startsWith(prefix));
		if (own.length !== 1) fail(`realm process ${i}: expected one report`);
		perProcess.push(
			obj(
				JSON.parse((own[0] as string).slice(prefix.length)),
				`realm process ${i}`,
			),
		);
	}
	if (lines.some((line) => /^mmo-client\[(\d+)\]: json /.test(line))) {
		const extra = lines.filter((line) => {
			const m = line.match(/^mmo-client\[(\d+)\]: json /);
			return m !== null && Number(m[1]) >= processes;
		});
		if (extra.length > 0) fail("more realm process reports than registered");
	}
	return { merged, perProcess };
}

/* ------------------------------------------------------------------------ */
/* Histograms                                                                */
/* ------------------------------------------------------------------------ */

function histJson(value: unknown, label: string): LatencyHistogramJson {
	const h = obj(value, label);
	arr(h.buckets, `${label}.buckets`);
	int(h.count, `${label}.count`);
	int(h.recordedTotal, `${label}.recordedTotal`);
	int(h.negative, `${label}.negative`);
	return h as unknown as LatencyHistogramJson;
}

/** Raw bucket sum, never the producer's declared count. */
export function bucketSum(h: LatencyHistogramJson): number {
	let total = 0;
	for (const entry of h.buckets) {
		if (!Array.isArray(entry) || entry.length !== 2)
			fail("histogram bucket must be [index, count]");
		total += int(entry[1], "histogram bucket count");
	}
	return total;
}

function percentileNs(h: LatencyHistogramJson, q: number): number | null {
	if (bucketSum(h) === 0) return null;
	return LatencyHistogram.fromJson(h).percentile(q);
}

/** HistogramFacts for g6-classify, computed from the raw buckets. */
export function histogramFacts(
	name: string,
	value: unknown,
	expectedSamples: number | null,
	unstamped: number,
): HistogramFacts & { p50Ns: number | null; maxNs: number } {
	const h = histJson(value, name);
	const count = bucketSum(h);
	return {
		name,
		count,
		declaredCount: h.count,
		recordedTotal: h.recordedTotal,
		negative: h.negative,
		p99Ns: percentileNs(h, 0.99),
		p50Ns: percentileNs(h, 0.5),
		maxNs: typeof h.maxNs === "number" ? h.maxNs : 0,
		expectedSamples,
		unstamped,
	};
}

/** Bucket-by-bucket sum of fragments (the registered merge rule). */
export function sumBuckets(parts: readonly unknown[]): Map<number, number> {
	const out = new Map<number, number>();
	for (const [i, part] of parts.entries())
		for (const [index, count] of histJson(part, `fragment ${i}`).buckets)
			out.set(index, (out.get(index) ?? 0) + count);
	return out;
}

function sameBuckets(a: Map<number, number>, merged: unknown): boolean {
	const b = sumBuckets([merged]);
	if (a.size !== b.size) return false;
	for (const [index, count] of a) if (b.get(index) !== count) return false;
	return true;
}

function p99Ms(value: unknown, label: string): number | null {
	const p = percentileNs(histJson(value, label), 0.99);
	return p === null ? null : p / 1e6;
}

/* ------------------------------------------------------------------------ */
/* Grade input and output                                                    */
/* ------------------------------------------------------------------------ */

export type ShardedArmsGradeInput = {
	cell: ShardedArmsCell;
	/** The cell's g6-sharded-scan/3 artifact (with `arms`). */
	scan: unknown;
	expectCandidate: string;
	registrationSha256: string;
	/** From the frozen work profile. */
	shards: number;
	clientProcesses: number;
	endpoints: number;
	fixedSourcePortBase: number | null;
	/**
	 * V-C: the campaign's rig qualification and PREPARED_HOST gates on the
	 * exact pair (validateCapacityRawCell), recorded by the caller.
	 */
	rig: { qualified: boolean; reasons: string[] };
	/** V-R threshold; storm cells refuse to grade without it. */
	vR: VRThreshold | null;
	/** Registered raid slot (defaults to SHARDED_ARMS_REGISTERED). */
	raidTargetSlot?: number;
};

export type ArmsClause = Omit<ClauseResult, "verdict"> & {
	verdict: ClauseResult["verdict"] | "INVALID";
	gated: boolean;
	/** V-F' outcome for this clause, when one applies. */
	generatorLimited?: "fired" | "clear" | "not applicable";
};

export type ShardedArmsCellVerdict = {
	schema: "g6-sharded-arms-cell/1";
	preregistrationId: typeof SHARDED_ARMS_PREREGISTRATION_ID;
	cell: ShardedArmsCellId;
	arm: ShardedArm;
	role: ShardedArmsCell["role"];
	verdict: "PASS" | "MISS" | "INVALID" | "INCOMPLETE";
	verdictForce: boolean;
	invalidReasons: string[];
	clauses: ArmsClause[];
	/** G6's original clauses on the same evidence, no verdict force. */
	reportedBeside: ClauseResult[];
	falsifiers: FalsifierResult[];
	characterization: Record<string, unknown>;
	disclosures: string[];
	vR: VRThreshold | null;
};

const DISCLOSURES_COMMON = [
	"Raid co-location makes H1-H3 structurally easier than G6-04's single-instance hotspot; no comparison claim is made against G6-04.",
	"Per-shard harness limits are 2 x the rung: S-C2's limitExceeded/rateLimited deltas are structurally zero on this rig, reported, not evidence.",
	"V-F applies floorReportIsUsable except its host checks (provenance host header and host match): the Linux generator entry prints no host line.",
	"The generator-loopback forwarder is the Rust g6-server on 127.0.0.1; a failed forwarder is recorded by the scan (not aborted) and graded INVALID here (forwarder rc must be the fan-out's SIGTERM, 143).",
	"The scan records facts only; every verdict here is recomputed from raw fields.",
	"mmo-client stamps the hard-coded closeout pre-registration id/path (g6-mmo-closeout/1) beside the sha256 it is given; reports bind to g6-sharded-arms/1 by sha256 only.",
];
const DISCLOSURES_STORM = [
	"Survivors are silent ~2 s before the storm window (60 s steady, existing 1 s drain, sever, 1 s reconnect delay).",
	"V-R uses the quinn DCID-provider call time as the first-Initial issue clock (initialIssueClock dcid-provider-call), not a wire send time.",
	"The server storm window is timed from the scan host's receipt of process 0's sever marker; client survivor windows from each process's own sever instant.",
	"Idle timeout 300 s; S-C2's 120 s window derives from a 60 s default; abrupt application close, not black-hole.",
	"S-C1 survivor upstream at the server = JS-classified survivor datagrams (rxSurvivors: moves; the native ACK reflector consumes actions before the JS loop) + survivor actions whose reflection the survivor received (client stormSurvivors.rxAck), a lower bound. The uncorrected moves-only ratio is reported beside.",
];
const DISCLOSURES_HOTSPOT = [
	"V-S tolerates originator schedule skips: INVALID only if sink delivery < 0.995, the originator's achieved rate < 0.995 x 1,200/s, or the loopback forwarder failed; the raw skip count is disclosed (characterization V-S).",
];
const DISCLOSURES_CHARACTERIZATION_STORM = [
	"V-R on a characterization cell (S2-40k) is reported, not verdict-forcing: an Initial later than R is recorded under 'V-R (reported)'; V-R's raw-integrity checks still force.",
];

/* ------------------------------------------------------------------------ */
/* Adapter                                                                   */
/* ------------------------------------------------------------------------ */

type Ctx = {
	input: ShardedArmsGradeInput;
	scan: Row;
	arms: Row;
	merged: Row;
	perProcess: Row[];
	shards: Row[];
	shardById: Map<number, Row>;
	targetServerId: number;
	publisher: Row | null;
	subscriber: Row | null;
};

function shardEcho(ctx: Ctx, serverId: number, phase: string): Row | null {
	const echoes = arr(ctx.arms.shardEchoes, "arms.shardEchoes");
	const entry = echoes
		.map((e) => maybeObj(e))
		.find((e) => e !== null && e.serverId === serverId);
	return maybeObj(maybeObj(entry?.echoes)?.[phase]);
}

function sumShards(ctx: Ctx, pick: (shard: Row) => number): number {
	return ctx.shards.reduce((total, shard) => total + pick(shard), 0);
}

function window(report: Row, name: string): Row {
	return obj(at(report, `windows.${name}`), `windows.${name}`);
}

function shardWindow(report: Row, serverId: number, name: string): Row {
	return obj(
		at(report, `arms.shards.${serverId}.${name}`),
		`arms.shards.${serverId}.${name}`,
	);
}

function buildContext(input: ShardedArmsGradeInput): Ctx {
	const scan = obj(input.scan, "scan");
	if (scan.schema !== "g6-sharded-scan/3") fail("scan schema");
	const arms = obj(scan.arms, "scan.arms");
	if (arms.schema !== "g6-sharded-arms-scan/1") fail("arms schema");
	const { merged, perProcess } = realmReports(scan, input.clientProcesses);
	const shards = arr(scan.shards, "scan.shards").map((s, i) =>
		obj(s, `shard ${i}`),
	);
	const shardById = new Map<number, Row>();
	for (const shard of shards) {
		const id = int(shard.serverId, "shard serverId");
		if (shardById.has(id)) fail(`duplicate shard ${id}`);
		shardById.set(id, shard);
	}
	const slot = input.raidTargetSlot ?? SHARDED_ARMS_REGISTERED.raidTargetSlot;
	let publisher: Row | null = null;
	let subscriber: Row | null = null;
	if (input.cell.arm === "hotspot") {
		const raid = obj(arms.raid, "arms.raid");
		publisher = reportFromLines(
			arr(raid.publisherStdout, "raid.publisherStdout"),
			"publisher report",
		);
		subscriber = reportFromLines(
			arr(raid.subscriberStdout, "raid.subscriberStdout"),
			"raid-subscriber report",
		);
	}
	return {
		input,
		scan,
		arms,
		merged,
		perProcess,
		shards,
		shardById,
		targetServerId: slot + 1,
		publisher,
		subscriber,
	};
}

/** Realm S1-S5 inputs, realm-wide or on one shard. */
type RealmContractFacts = {
	scope: string;
	sessions: number;
	clientSent: number;
	serverRx: number;
	clientSnapshots: number;
	serverSnapshotsIssued: number;
	steadySeconds: number;
	rtt: unknown;
	sessionsLost: number;
};

/** gate-g6-sharded S1-S5 with its frozen thresholds (S4 ACK p99 <= 25 ms). */
export function realmContractClause(
	id: string,
	f: RealmContractFacts,
): ClauseResult {
	const c = G6_SHARDED_CLAUSES;
	const demand =
		f.sessions * SNAPSHOT_HZ * snapshotDatagrams() * f.steadySeconds;
	const s1 = f.clientSent > 0 ? f.serverRx / f.clientSent : null;
	const s2 =
		f.serverSnapshotsIssued > 0
			? f.clientSnapshots / f.serverSnapshotsIssued
			: null;
	const s3 = demand > 0 ? f.serverSnapshotsIssued / demand : null;
	const s4 = p99Ms(f.rtt, `${f.scope} rtt`);
	const s5 = f.sessions > 0 ? f.sessionsLost / f.sessions : null;
	const reasons: string[] = [];
	if (s1 === null) reasons.push(`${id} S1: no upstream sent`);
	else if (s1 < c.ingestFloor)
		reasons.push(`${id} S1: ingest ${s1.toFixed(5)} < ${c.ingestFloor}`);
	if (s2 === null) reasons.push(`${id} S2: no snapshots issued`);
	else if (s2 < c.deliveryFloor)
		reasons.push(`${id} S2: delivery ${s2.toFixed(5)} < ${c.deliveryFloor}`);
	if (s3 === null) reasons.push(`${id} S3: no demand`);
	else if (s3 < c.dutyFloor)
		reasons.push(`${id} S3: duty ${s3.toFixed(5)} < ${c.dutyFloor}`);
	if (s4 === null) reasons.push(`${id} S4: no ACK RTT samples`);
	else if (s4 > c.ackRttP99CeilingMs)
		reasons.push(
			`${id} S4: ACK RTT p99 ${s4.toFixed(3)} ms > ${c.ackRttP99CeilingMs} ms`,
		);
	if (s5 === null) reasons.push(`${id} S5: no sessions`);
	else if (s5 > c.sessionsLostCap)
		reasons.push(`${id} S5: sessions lost ${s5} > ${c.sessionsLostCap}`);
	const incomplete =
		s1 === null || s2 === null || s3 === null || s4 === null || s5 === null;
	return {
		id,
		verdict: incomplete ? "INCOMPLETE" : reasons.length ? "MISS" : "PASS",
		reasons,
		observed: {
			scope: f.scope,
			S1_ingest: s1,
			S2_delivery: s2,
			S3_duty: s3,
			S4_ackRttP99Ms: s4,
			S5_sessionsLost: s5,
			S4_ceilingMs: c.ackRttP99CeilingMs,
		},
	};
}

function raidIngest(shard: Row, name: string): number {
	const byClass = obj(
		at(shard, `windows.${name}.rxByClass`),
		`windows.${name}.rxByClass`,
	);
	return (
		int(byClass.raid, "rxByClass.raid") + int(byClass.raidJoin, "raidJoin")
	);
}

function hotspotRealmFacts(ctx: Ctx): {
	wide: RealmContractFacts;
	shardK: RealmContractFacts;
} {
	const { merged, cell } = { merged: ctx.merged, cell: ctx.input.cell };
	const K = ctx.targetServerId;
	const shardK = ctx.shardById.get(K) ?? fail(`target shard ${K} missing`);
	const steady = window(merged, "steady");
	const drain = window(merged, "steadyDrain");
	const steadySeconds = SHARDED_ARMS_REGISTERED.hotspotSteadySeconds;
	const wide: RealmContractFacts = {
		scope: "realm-wide",
		sessions: cell.sessions,
		clientSent: int(steady.sent, "realm steady sent"),
		serverRx: sumShards(
			ctx,
			(s) => atInt(s, "windows.steady.rxTotal") - raidIngest(s, "steady"),
		),
		clientSnapshots: int(drain.rxSnapshot, "realm rxSnapshot"),
		serverSnapshotsIssued: sumShards(ctx, (s) =>
			atInt(s, "windows.steadyDrain.emitter.snapshotIssued"),
		),
		steadySeconds,
		rtt: drain.rtt,
		sessionsLost: int(steady.sessionsLost, "realm sessionsLost"),
	};
	const kSteady = shardWindow(merged, K, "steady");
	const kDrain = shardWindow(merged, K, "steadyDrain");
	const kSessions = atInt(merged, `arms.sessionsByShard.steadyEntry.${K}`);
	return {
		wide,
		shardK: {
			scope: `shard ${K} (raid co-resident realm sessions)`,
			sessions: kSessions,
			clientSent: int(kSteady.sent, "shard K steady sent"),
			serverRx:
				atInt(shardK, "windows.steady.rxTotal") - raidIngest(shardK, "steady"),
			clientSnapshots: int(kDrain.rxSnapshot, "shard K rxSnapshot"),
			serverSnapshotsIssued: atInt(
				shardK,
				"windows.steadyDrain.emitter.snapshotIssued",
			),
			steadySeconds,
			rtt: kDrain.rtt,
			sessionsLost: int(kSteady.sessionsLost, "shard K sessionsLost"),
		},
	};
}

function steadyArmFacts(f: RealmContractFacts, rtt: HistogramFacts) {
	return {
		sessions: f.sessions,
		clientEnqueuedUpstream: f.clientSent,
		serverRxUpstream: f.serverRx,
		snapshotServerIssued: f.serverSnapshotsIssued,
		snapshotClientReceived: f.clientSnapshots,
		ackServerIssued: 0,
		ackClientReceived: 0,
		rtt,
		sessionsLost: f.sessionsLost,
		sessionsActiveAtEnd: f.sessions,
		ledger: {
			clientEnqueued: f.clientSent,
			clientWireTx: null,
			kernelDropsSocket: null,
			kernelRcvbufErrors: null,
			serverObserved: null,
			jsDelivered: f.serverRx,
			nativeDropped: null,
			nativeSkippedQueueFull: null,
		},
		emitter: {
			snapshotDue: 0,
			snapshotIssued: 0,
			ackDue: 0,
			ackIssued: 0,
			sendEventsSkipped: 0,
			sendErrors: 0,
			batchPartialCompletions: 0,
		},
	} satisfies SteadyArmFacts;
}

/** H4 inputs: cadence on shard K's own raw publisher arrival gaps. */
export function frameGapFractionOf(gapsNs: readonly number[]): number | null {
	if (gapsNs.length === 0) return null;
	const threshold = 0.5 * (1e9 / RAID_PUBLISHER_HZ);
	return gapsNs.filter((gap) => gap >= threshold).length / gapsNs.length;
}

/* ------------------------------------------------------------------------ */
/* Falsifiers (all recomputed from raw fields)                               */
/* ------------------------------------------------------------------------ */

const run = (id: string, reasons: string[]): FalsifierResult => ({
	id,
	fired: reasons.length > 0,
	reasons,
	scope: "run",
});

/** V-C: the campaign's rig qualification + PREPARED_HOST on the exact pair. */
export function falsifierRig(rig: ShardedArmsGradeInput["rig"]) {
	return run(
		"V-C",
		rig.qualified
			? []
			: rig.reasons.length > 0
				? rig.reasons.map((r) => `V-C: ${r}`)
				: ["V-C: rig not qualified"],
	);
}

/** V-F: generator-host floor, 20 driving sessions to the loopback forwarder. */
function vFloor(ctx: Ctx, runDateIso: string): FalsifierResult {
	const reasons: string[] = [];
	const pre = obj(ctx.arms.precheck, "arms.precheck");
	const forwarder = obj(pre.forwarder, "precheck.forwarder");
	if (forwarder.rc !== SHARDED_ARMS_REGISTERED.forwarderStoppedRc)
		reasons.push(
			`V-F: loopback forwarder rc ${String(forwarder.rc)} — not stopped by the fan-out (${SHARDED_ARMS_REGISTERED.forwarderStoppedRc}); the forwarder failed`,
		);
	if (
		arr(forwarder.stderr ?? [], "forwarder stderr").some(
			(line) =>
				typeof line === "string" &&
				line.includes("precheck: certificate generation failed"),
		)
	)
		reasons.push("V-F: loopback forwarder certificate generation failed");
	const floor = obj(pre.floor, "precheck.floor");
	if (floor.rc !== 0) reasons.push(`V-F: floor rc ${String(floor.rc)}`);
	const transcript = arr(floor.transcript, "floor transcript")
		.filter((l): l is string => typeof l === "string")
		.join("\n");
	const report = parseGeneratorReport(
		transcript,
		ctx.input.expectCandidate,
		ctx.input.registrationSha256,
	);
	// floorReportIsUsable except the host check (plan r6 V-F): the host-match
	// and missing-host-header problems are the host check.
	const usability = floorReportIsUsable(
		report,
		report.provenance.host ?? "",
		ctx.input.registrationSha256,
	);
	for (const reason of usability.reasons)
		if (
			!reason.startsWith("no macgen provenance header") &&
			!reason.startsWith("floor came from")
		)
			reasons.push(`V-F: ${reason}`);
	const root = maybeObj(report.latencyJson);
	let lagP99: number | null = null;
	let lagMax: number | null = null;
	let driving = 0;
	if (root === null) reasons.push("V-F: no floor report");
	else {
		const S = SHARDED_ARMS_REGISTERED.floorSessions;
		if (root.role !== "realm") reasons.push("V-F: floor role is not realm");
		for (const key of [
			"sessionsRequested",
			"sessionsOk",
			"activeWorkloadSessions",
		])
			if (root[key] !== S)
				reasons.push(`V-F: floor ${key} ${String(root[key])}, expected ${S}`);
		if (root.sessionsErr !== 0)
			reasons.push(`V-F: floor sessionsErr ${String(root.sessionsErr)}`);
		if (at(root, "config.steadySec") !== SHARDED_ARMS_REGISTERED.floorSeconds)
			reasons.push("V-F: floor steady window is not the registered 10 s");
		const steady = window(root, "steady");
		const lag = histogramFacts(
			"floor steady scheduleLag",
			steady.scheduleLag,
			int(steady.scheduleTicksFired, "floor ticks fired"),
			0,
		);
		lagP99 = lag.p99Ns === null ? null : lag.p99Ns / 1e6;
		lagMax = lag.maxNs / 1e6;
		driving = int(root.activeWorkloadSessions, "floor driving sessions");
		if (int(steady.sent, "floor sent") <= 0)
			reasons.push("V-F: floor offered no load");
	}
	const base = falsifierFloor({
		scheduleLagP99Ms: lagP99,
		scheduleLagMaxMs: lagMax,
		floorArmDateIso: runDateIso,
		runDateIso,
		generatorHostMatches: true,
		drivingSessions: driving,
	});
	return {
		...base,
		fired: base.fired || reasons.length > 0,
		reasons: [...reasons, ...base.reasons],
	};
}

/**
 * V-S: hotspot cells' 20 s loopback sink at 1,200/s. INVALID only if sink
 * delivery < 0.995, the originator's achieved rate < 0.995 x 1,200/s, or the
 * loopback forwarder failed; a skipped tick never fires on its own (a skip
 * fraction <= 0.5 % is tolerated) and the raw skip count is disclosed.
 */
function vSink(ctx: { arms: Row }): {
	falsifier: FalsifierResult;
	facts: Record<string, unknown>;
} {
	const reasons: string[] = [];
	const R = SHARDED_ARMS_REGISTERED;
	const requiredPps = SINK_HEADROOM_FACTOR * R.sinkArmDownstreamPps;
	const floorPps = R.sinkOriginatorRateFloor * requiredPps;
	// The sink is driven through the loopback forwarder; a failed forwarder
	// (recorded by the scan, not aborted) invalidates the sink check too.
	const forwarder = obj(
		at(ctx.arms, "precheck.forwarder"),
		"precheck.forwarder",
	);
	if (forwarder.rc !== R.forwarderStoppedRc)
		reasons.push(
			`V-S: loopback forwarder rc ${String(forwarder.rc)} — not stopped by the fan-out (${R.forwarderStoppedRc}); the forwarder failed`,
		);
	const sink = obj(at(ctx.arms, "precheck.sink"), "precheck.sink");
	if (at(sink, "rc.subscriber") !== 0 || at(sink, "rc.publisher") !== 0)
		reasons.push("V-S: sink process rc not 0");
	const sub = maybeObj(sink.subscriberReport);
	const pub = maybeObj(sink.publisherReport);
	const facts: Record<string, unknown> = { requiredPps, floorPps };
	if (sub === null || pub === null) reasons.push("V-S: sink reports missing");
	else {
		if (sub.sessionsOk !== RAID_MEMBERS || sub.role !== "raid-subscriber")
			reasons.push("V-S: sink subscriber is not 40 raid-subscriber sessions");
		if (pub.sessionsOk !== 1 || pub.role !== "publisher")
			reasons.push("V-S: sink publisher is not one publisher session");
		const pubSteady = window(pub, "steady");
		const sent = int(pubSteady.sent, "sink publisher sent");
		const due = int(pubSteady.scheduleTicksDue, "sink publisher due");
		const skipped = int(pubSteady.scheduleTicksSkipped, "sink skipped");
		const received = atInt(sub, "windows.steadyDrain.rxRaid");
		const expected = sent * RAID_MEMBERS;
		const achievedPps = expected / R.sinkSeconds;
		const delivery = expected > 0 ? received / expected : null;
		Object.assign(facts, {
			publisherSent: sent,
			publisherTicksDue: due,
			publisherTicksSkipped: skipped,
			skipFraction: due > 0 ? skipped / due : null,
			achievedPps,
			expected,
			received,
			delivery,
		});
		if (delivery === null) reasons.push("V-S: the sink pre-check sent nothing");
		else if (delivery < SINK_DELIVERY_FLOOR)
			reasons.push(
				`V-S: pre-check delivery ${delivery.toFixed(5)} < ${SINK_DELIVERY_FLOOR}`,
			);
		if (achievedPps < floorPps)
			reasons.push(
				`V-S: originator achieved ${achievedPps.toFixed(1)} pps < ${R.sinkOriginatorRateFloor} x ${requiredPps} = ${floorPps.toFixed(1)} pps (${skipped} of ${due} ticks skipped)`,
			);
	}
	return { falsifier: run("V-S", reasons), facts };
}

/** V-N / V-K / V-D over every histogram, per process and per shard, before and after merge. */
function vHistograms(ctx: Ctx): {
	falsifier: FalsifierResult;
	mergeReasons: string[];
} {
	const facts: HistogramFacts[] = [];
	const mergeReasons: string[] = [];
	const storm = ctx.input.cell.arm === "storm";
	const names = storm
		? (["steady", "steadyDrain", "stormSurvivors"] as const)
		: (["steady", "steadyDrain"] as const);
	const shardIds = [...ctx.shardById.keys()];
	const reports: [string, Row][] = [
		["merged", ctx.merged],
		...ctx.perProcess.map((r, i): [string, Row] => [`process ${i}`, r]),
	];
	const windowFacts = (label: string, w: Row) => {
		const unstamped = int(w.rxUnstamped, `${label} rxUnstamped`);
		facts.push(
			histogramFacts(
				`${label} scheduleLag`,
				w.scheduleLag,
				int(w.scheduleTicksFired, `${label} ticks fired`),
				0,
			),
			histogramFacts(
				`${label} rtt`,
				w.rtt,
				int(w.rxAck, `${label} rxAck`),
				unstamped,
			),
		);
	};
	for (const [label, report] of reports) {
		for (const name of names) {
			windowFacts(`${label} ${name}`, window(report, name));
			for (const id of shardIds) {
				const shardW = maybeObj(at(report, "arms.shards")) ?? {};
				if (maybeObj(shardW[String(id)]) === null) continue;
				windowFacts(
					`${label} shard ${id} ${name}`,
					shardWindow(report, id, name),
				);
			}
		}
	}
	// Merge rule: merged = bucket-by-bucket sum of the processes, per window
	// and per shard.
	if (ctx.perProcess.length > 1)
		for (const name of names)
			for (const field of ["scheduleLag", "rtt"] as const) {
				if (
					!sameBuckets(
						sumBuckets(ctx.perProcess.map((r) => window(r, name)[field])),
						window(ctx.merged, name)[field],
					)
				)
					mergeReasons.push(
						`V-K merge: merged ${name}.${field} is not the bucket sum of the processes`,
					);
				for (const id of shardIds) {
					const parts = ctx.perProcess
						.map((r) => maybeObj(maybeObj(at(r, "arms.shards"))?.[String(id)]))
						.filter((s): s is Row => s !== null)
						.map((s) => obj(s[name], `shard ${id} ${name}`)[field]);
					const mergedShard = maybeObj(
						maybeObj(at(ctx.merged, "arms.shards"))?.[String(id)],
					);
					if (mergedShard === null) {
						if (parts.length > 0)
							mergeReasons.push(
								`V-K merge: shard ${id} missing in merged report`,
							);
						continue;
					}
					if (
						!sameBuckets(
							sumBuckets(parts),
							obj(mergedShard[name], `merged shard ${id}`)[field],
						)
					)
						mergeReasons.push(
							`V-K merge: merged shard ${id} ${name}.${field} is not the bucket sum of the processes`,
						);
				}
			}
	if (ctx.input.cell.arm === "hotspot") {
		const sub = ctx.subscriber as Row;
		const subDrain = window(sub, "steadyDrain");
		facts.push(
			histogramFacts(
				"raid-subscriber steadyDrain oneWay",
				subDrain.oneWay,
				int(subDrain.rxRaid, "subscriber rxRaid"),
				int(subDrain.rxUnstamped, "subscriber rxUnstamped"),
			),
		);
		const pubSteady = window(ctx.publisher as Row, "steady");
		facts.push(
			histogramFacts(
				"publisher steady scheduleLag",
				pubSteady.scheduleLag,
				int(pubSteady.scheduleTicksFired, "publisher ticks fired"),
				0,
			),
		);
	} else {
		const stormArms = obj(at(ctx.merged, "arms.storm"), "merged arms.storm");
		facts.push(
			histogramFacts(
				"merged reconnectInitialLate",
				stormArms.reconnectInitialLate,
				int(stormArms.reconnectInitials, "reconnectInitials"),
				0,
			),
		);
	}
	const base = falsifierHistograms(facts);
	return {
		falsifier: {
			...base,
			fired: base.fired || mergeReasons.length > 0,
			reasons: [...base.reasons, ...mergeReasons],
		},
		mergeReasons,
	};
}

/** V-G: upstream offeredRatio, merged across the realm processes. */
function vGenerator(ctx: Ctx): FalsifierResult {
	const names =
		ctx.input.cell.arm === "storm" ? ["steady", "stormSurvivors"] : ["steady"];
	return falsifierGenerator({
		offeredRatioByRung: names.map((name) => {
			const w = window(ctx.merged, name);
			const due = int(w.scheduleTicksDue, `${name} due`);
			return {
				sessions: ctx.input.cell.sessions,
				offeredRatio:
					due > 0
						? int(w.sent, `${name} sent`) / due
						: name === "stormSurvivors"
							? 1
							: null,
			};
		}),
	});
}

/** Server-side per-shard session counts at steady entry (raw shard field). */
function serverSteadyCounts(ctx: Ctx): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [id, shard] of ctx.shardById)
		out[String(id)] = int(
			shard.sessionsAtSteady,
			`shard ${id} sessionsAtSteady`,
		);
	return out;
}

function addCounts(
	parts: readonly Record<string, unknown>[],
	shards: number,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (let id = 1; id <= shards; id += 1) out[String(id)] = 0;
	for (const part of parts)
		for (const [key, value] of Object.entries(part)) {
			if (!(key in out)) fail(`per-shard count for unknown shard ${key}`);
			out[key] = (out[key] as number) + int(value, `count ${key}`);
		}
	return out;
}

function countMismatches(
	label: string,
	client: Record<string, number>,
	server: Record<string, number>,
	shards: number,
): string[] {
	const reasons: string[] = [];
	for (let id = 1; id <= shards; id += 1) {
		const c = client[String(id)];
		const s = server[String(id)];
		if (c === undefined || s === undefined || c !== s)
			reasons.push(
				`V-P ${label}: shard ${id} client-derived ${String(c)} != server-reported ${String(s)}`,
			);
	}
	return reasons;
}

/** V-P: placement / membership / per-shard attribution. */
function vPlacement(ctx: Ctx): FalsifierResult {
	const reasons: string[] = [];
	const N = ctx.input.shards;
	if (ctx.shardById.size !== N)
		reasons.push(`V-P: ${ctx.shardById.size} shards reported, registered ${N}`);
	const K = ctx.targetServerId;
	const armsOf = (report: Row, label: string) => {
		const a = obj(report.arms, `${label} arms`);
		if (a.shardCount !== N)
			reasons.push(`V-P ${label}: shardCount ${String(a.shardCount)} != ${N}`);
		if (a.dcidLen !== SHARDED_ARMS_REGISTERED.dcidLen)
			reasons.push(
				`V-P ${label}: opening DCID length ${String(a.dcidLen)} != 20`,
			);
		if (a.dcidHashPlaced !== true || a.dcidLen === a.serverCidLen)
			reasons.push(
				`V-P ${label}: opening DCIDs are not hash-placed (length == CID_LEN)`,
			);
		return a;
	};
	const realmArms = armsOf(ctx.merged, "realm");
	for (const [i, r] of ctx.perProcess.entries())
		armsOf(r, `realm process ${i}`);
	const realmSteady = obj(
		at(realmArms, "sessionsByShard.steadyEntry"),
		"realm steadyEntry counts",
	);
	const realmTotal = Object.values(realmSteady).reduce(
		(t: number, v) => t + int(v, "realm count"),
		0,
	);
	if (realmTotal !== ctx.input.cell.sessions)
		reasons.push(
			`V-P: realm client-derived sessions at steady entry ${realmTotal} != ${ctx.input.cell.sessions}`,
		);
	// Per-shard attribution covers every realm send exactly once.
	const attributed = Object.keys(
		obj(realmArms.shards, "realm arms.shards"),
	).reduce(
		(t, id) => t + int(at(realmArms, `shards.${id}.steady.sent`), "shard sent"),
		0,
	);
	if (attributed !== atInt(ctx.merged, "windows.steady.sent"))
		reasons.push(
			`V-P: per-shard attributed steady sends ${attributed} != realm ${atInt(ctx.merged, "windows.steady.sent")}`,
		);
	const parts: Record<string, unknown>[] = [realmSteady];
	if (ctx.input.cell.arm === "hotspot") {
		for (const [label, report] of [
			["publisher", ctx.publisher],
			["raid-subscriber", ctx.subscriber],
		] as const) {
			const a = armsOf(report as Row, label);
			if (a.targetSlot !== K - 1 || a.targetServerId !== K)
				reasons.push(
					`V-P ${label}: target slot ${String(a.targetSlot)} != registered ${K - 1}`,
				);
			const counts = obj(
				at(a, "sessionsByShard.steadyEntry"),
				`${label} counts`,
			);
			const expected = label === "publisher" ? 1 : RAID_MEMBERS;
			for (const [id, value] of Object.entries(counts))
				if (int(value, "raid count") !== (Number(id) === K ? expected : 0))
					reasons.push(
						`V-P ${label}: client-derived shard ${id} holds ${String(value)}`,
					);
			parts.push(counts);
		}
		// Server-reported raid membership (drain echo, raw tokens).
		const tokensK: number[] = [];
		for (const id of ctx.shardById.keys()) {
			const echo = shardEcho(ctx, id, "drain");
			if (echo === null) {
				reasons.push(`V-P: shard ${id} has no drain membership echo`);
				continue;
			}
			const tokens = arr(at(echo, "raidMembers.tokens"), "raid tokens").map(
				(t) => int(t, "raid token"),
			);
			const publishers = atInt(echo, "sessionKinds.publisher");
			if (id === K) {
				tokensK.push(...tokens);
				if (publishers !== 1)
					reasons.push(
						`V-P: shard ${K} reports ${publishers} publishers, expected 1`,
					);
			} else if (tokens.length > 0 || publishers > 0)
				reasons.push(
					`V-P: shard ${id} reports raid members (${tokens.length}) or publishers (${publishers}) off the raid shard`,
				);
		}
		const sorted = [...tokensK].sort((a, b) => a - b);
		if (
			sorted.length !== RAID_MEMBERS ||
			sorted.some((token, index) => token !== index + 1)
		)
			reasons.push(
				`V-P: shard ${K} raid member tokens are not exactly 1..${RAID_MEMBERS} (${sorted.length} tokens)`,
			);
	}
	reasons.push(
		...countMismatches(
			"steady entry",
			addCounts(parts, N),
			serverSteadyCounts(ctx),
			N,
		),
	);
	if (ctx.input.cell.arm === "storm") {
		const end = maybeObj(at(realmArms, "sessionsByShard"))?.stormEnd;
		const server = maybeObj(
			maybeObj(at(ctx.arms, "storm.sessionsByShardAtStormEnd"))?.server,
		);
		if (maybeObj(end) === null || server === null)
			reasons.push("V-P storm end: per-shard counts missing");
		else
			reasons.push(
				...countMismatches(
					"storm end",
					addCounts([end as Row], N),
					addCounts([server], N),
					N,
				),
			);
	}
	return run("V-P", reasons);
}

/** V-T: sever-instant skew across the realm processes (raw per-process instants). */
function vSeverSkew(ctx: Ctx): FalsifierResult {
	const reasons: string[] = [];
	// Each process's own sever instant, from its own report (never the
	// merged severSkewMs), and its own sever barrier over every realm process.
	const instants = ctx.perProcess.map((r, i) => {
		const storm = obj(at(r, "arms.storm"), `process ${i} arms.storm`);
		if (at(storm, "severBarrier.parties") !== ctx.input.clientProcesses)
			reasons.push(
				`V-T: process ${i} sever barrier does not cover the ${ctx.input.clientProcesses} realm processes`,
			);
		return int(storm.severUnixMs, `process ${i} severUnixMs`);
	});
	const skew = Math.max(...instants) - Math.min(...instants);
	if (skew > SHARDED_ARMS_REGISTERED.skewCeilingMs)
		reasons.push(
			`V-T: sever-instant skew ${skew} ms > ${SHARDED_ARMS_REGISTERED.skewCeilingMs} ms`,
		);
	return run("V-T", reasons);
}

/** Closeout §3.8: steady-entry skew over every barrier party. */
function vBarrier(ctx: Ctx): FalsifierResult {
	const reasons: string[] = [];
	const parties: [string, Row][] = ctx.perProcess.map((r, i) => [
		`realm process ${i}`,
		r,
	]);
	if (ctx.publisher !== null) parties.push(["publisher", ctx.publisher]);
	if (ctx.subscriber !== null)
		parties.push(["raid-subscriber", ctx.subscriber]);
	const expectedParties =
		ctx.input.clientProcesses + (ctx.input.cell.arm === "hotspot" ? 2 : 0);
	const instants: number[] = [];
	for (const [label, report] of parties) {
		const barrier = maybeObj(report.phaseBarrier);
		if (barrier === null) {
			reasons.push(`V-B: ${label} reports no shared barrier`);
			continue;
		}
		if (barrier.parties !== expectedParties)
			reasons.push(
				`V-B: ${label} barrier has ${String(barrier.parties)} parties, registered ${expectedParties}`,
			);
		instants.push(int(barrier.steadyEnterUnixMs, `${label} steadyEnterUnixMs`));
	}
	if (instants.length > 0) {
		const skew = Math.max(...instants) - Math.min(...instants);
		if (skew > SHARDED_ARMS_REGISTERED.skewCeilingMs)
			reasons.push(
				`V-B: steady-entry skew ${skew} ms > ${SHARDED_ARMS_REGISTERED.skewCeilingMs} ms`,
			);
	}
	return run("V-B", reasons);
}

/**
 * The latest lateness sample (ms), or null when the producer's `maxNs` is
 * missing, not finite, or outside the highest non-empty bucket — a raw
 * integrity finding (it forces INVALID even where lateness is reported only).
 * An empty histogram has no latest sample: 0.
 */
function lateMaxMs(
	h: LatencyHistogramJson,
	label: string,
	reasons: string[],
): number | null {
	if (bucketSum(h) === 0) return 0;
	const top = Math.max(...h.buckets.map((entry) => Number(entry[0])));
	const maxNs = (h as { maxNs?: unknown }).maxNs;
	if (
		typeof maxNs !== "number" ||
		!Number.isFinite(maxNs) ||
		maxNs < 0 ||
		latencyBucketIndex(maxNs) !== top
	) {
		reasons.push(
			`${label}: lateness maxNs ${String(maxNs)} is missing or outside the highest non-empty bucket ${top}`,
		);
		return null;
	}
	return maxNs / 1e6;
}

/**
 * V-R: every cohort reconnect's first Initial within R ms of sever + 1,000 ms.
 * `late` holds the threshold findings (an Initial later than R); `reasons`
 * the raw-integrity ones. On a gate cell both force; on the characterization
 * cell (S2-40k) `late` is reported only.
 */
function vReconnectIssue(ctx: Ctx): { reasons: string[]; late: string[] } {
	const reasons: string[] = [];
	const lateReasons: string[] = [];
	const R = ctx.input.vR;
	if (R === null) {
		reasons.push(
			"V-R: R is not frozen (SHARDED_ARMS_V_R_MS = null); a storm cell is not graded without it",
		);
		return { reasons, late: lateReasons };
	}
	const P = ctx.input.clientProcesses;
	let total = 0;
	for (const [i, r] of ctx.perProcess.entries()) {
		const storm = obj(at(r, "arms.storm"), `process ${i} arms.storm`);
		const share = evenShare(ctx.input.cell.cohort, P, i);
		if (storm.initialIssueClock !== "dcid-provider-call")
			reasons.push(
				`V-R process ${i}: unregistered issue clock ${String(storm.initialIssueClock)}`,
			);
		const initials = int(storm.reconnectInitials, "reconnectInitials");
		total += initials;
		if (initials !== share)
			reasons.push(
				`V-R process ${i}: ${initials} reconnect Initials, cohort share ${share}`,
			);
		const late = histJson(
			storm.reconnectInitialLate,
			`process ${i} reconnectInitialLate`,
		);
		if (bucketSum(late) !== initials)
			reasons.push(
				`V-R process ${i}: lateness samples ${bucketSum(late)} != Initials ${initials}`,
			);
		if (late.negative > 0)
			reasons.push(
				`V-R process ${i}: ${late.negative} Initial(s) issued before sever + 1,000 ms`,
			);
		const maxMs = lateMaxMs(late, `V-R process ${i}`, reasons);
		if (maxMs !== null && maxMs > R.ms)
			lateReasons.push(
				`V-R process ${i}: latest first Initial ${maxMs.toFixed(3)} ms > R ${R.ms} ms`,
			);
	}
	if (total !== ctx.input.cell.cohort)
		reasons.push(
			`V-R: ${total} reconnect Initials, cohort ${ctx.input.cell.cohort}`,
		);
	const merged = histJson(
		at(ctx.merged, "arms.storm.reconnectInitialLate"),
		"merged reconnectInitialLate",
	);
	if (
		!sameBuckets(
			sumBuckets(
				ctx.perProcess.map((r) => at(r, "arms.storm.reconnectInitialLate")),
			),
			merged,
		)
	)
		reasons.push("V-R: merged lateness is not the bucket sum of the processes");
	const mergedMaxMs = lateMaxMs(merged, "V-R merged", reasons);
	if (mergedMaxMs !== null && mergedMaxMs > R.ms)
		lateReasons.push(
			`V-R merged: latest first Initial ${mergedMaxMs.toFixed(3)} ms > R ${R.ms} ms`,
		);
	return { reasons, late: lateReasons };
}

/** V-W: storm-window fallback fraction from the raw steer_stats dumps. */
function vSteering(ctx: Ctx): {
	falsifier: FalsifierResult;
	facts: Record<string, unknown>;
} {
	const reasons: string[] = [];
	const steering = obj(at(ctx.arms, "storm.steering"), "storm.steering");
	const side = (name: "start" | "end") => {
		const snap = maybeObj(steering[name]);
		if (snap === null || typeof snap.steerStatsRaw !== "string") {
			reasons.push(`V-W: no raw steer_stats at storm ${name}`);
			return null;
		}
		const sum = sumPerCpuSteerStats(snap.steerStatsRaw);
		if (sum === null)
			reasons.push(`V-W: storm ${name} steer_stats dump unusable`);
		return sum;
	};
	const start = side("start");
	const end = side("end");
	let fraction: number | null = null;
	let delta: { steered: number; fallback: number } | null = null;
	if (start !== null && end !== null) {
		delta = {
			steered: end.steered - start.steered,
			fallback: end.fallback - start.fallback,
		};
		if (delta.steered < 0 || delta.fallback < 0)
			reasons.push("V-W: steer_stats went backwards across the storm window");
		else if (delta.steered + delta.fallback === 0)
			reasons.push("V-W: no steering decisions in the storm window");
		else {
			fraction = delta.fallback / (delta.steered + delta.fallback);
			if (fraction > SHARDED_ARMS_REGISTERED.fallbackFractionMax)
				reasons.push(
					`V-W: storm-window fallback fraction ${fraction.toFixed(5)} > ${SHARDED_ARMS_REGISTERED.fallbackFractionMax}`,
				);
		}
	}
	return {
		falsifier: run("V-W", reasons),
		facts: {
			steeringDelta: delta,
			fallbackFraction: fraction,
			perSlotDelta: steering.perSlotDelta ?? null,
			disclosureSteeredVsWork: delta
				? {
						steered: delta.steered,
						reconnectAttempts: ctx.input.cell.cohort,
						survivorUpstream: atInt(ctx.merged, "windows.stormSurvivors.sent"),
					}
				: null,
		},
	};
}

/** Per-kind raw-cell expectations (session census, roles, ports, shapes). */
function rawCellExpectations(ctx: Ctx): FalsifierResult {
	const reasons: string[] = [];
	const { cell } = ctx.input;
	const R = SHARDED_ARMS_REGISTERED;
	const cfg = obj(ctx.arms.config, "arms.config");
	const expectCfg: Record<string, unknown> = {
		arm: cell.arm,
		shards: ctx.input.shards,
		...(cell.arm === "hotspot"
			? { raidTargetSlot: ctx.targetServerId - 1 }
			: {}),
		raidDcidLen: R.dcidLen,
		realmNegctlDcidLen: null,
		stormCohort: cell.cohort,
		steadySeconds:
			cell.arm === "storm" ? R.stormSteadySeconds : R.hotspotSteadySeconds,
		stormWindowSeconds: R.stormWindowSeconds,
		postStormSeconds: R.postStormSeconds,
		stormReconnectDelayMs: R.stormReconnectDelayMs,
		durationsOverridden: false,
	};
	for (const [key, value] of Object.entries(expectCfg))
		if (cfg[key] !== value)
			reasons.push(
				`RAW arms.config.${key} ${String(cfg[key])} != registered ${String(value)}`,
			);
	if (ctx.scan.clientExit !== 0)
		reasons.push(`RAW clientExit ${String(ctx.scan.clientExit)}`);
	if (ctx.scan.candidateSha !== ctx.input.expectCandidate)
		reasons.push("RAW scan candidate differs from the registered candidate");
	if (atInt(ctx.scan, "config.clientProcesses") !== ctx.input.clientProcesses)
		reasons.push("RAW scan clientProcesses differs from the profile");
	// Realm census.
	const m = ctx.merged;
	for (const key of [
		"sessionsRequested",
		"sessionsOk",
		"activeWorkloadSessions",
	])
		if (m[key] !== cell.sessions)
			reasons.push(`RAW realm ${key} ${String(m[key])} != ${cell.sessions}`);
	if (m.sessionsErr !== 0)
		reasons.push(`RAW realm sessionsErr ${String(m.sessionsErr)}`);
	if (m.role !== "realm") reasons.push("RAW merged realm role");
	if (at(m, "preRegistration.sha256") !== ctx.input.registrationSha256)
		reasons.push("RAW realm pre-registration differs");
	if (ctx.input.clientProcesses > 1) {
		if (m.clientProcesses !== ctx.input.clientProcesses)
			reasons.push("RAW merged report covers a different process count");
		const ok = ctx.perProcess.reduce(
			(t, r) => t + int(r.sessionsOk, "sessionsOk"),
			0,
		);
		if (ok !== cell.sessions)
			reasons.push(
				`RAW realm processes connected ${ok}, registered ${cell.sessions}`,
			);
		for (const [i, r] of ctx.perProcess.entries())
			if (r.role !== "realm")
				reasons.push(`RAW process ${i} role ${String(r.role)}`);
	}
	if (at(m, "arms.raidJoinsSent") !== 0)
		reasons.push("RAW realm sessions sent RAID_JOIN");
	// Realm source ports: the registered pool only.
	if (ctx.input.fixedSourcePortBase !== null) {
		const base = ctx.input.fixedSourcePortBase;
		const ports = arr(
			at(m, "client.endpointSourceAddresses"),
			"realm addresses",
		).map((a) => Number(String(a).match(/:(\d+)$/)?.[1]));
		if (
			ports.length !== ctx.input.endpoints ||
			new Set(ports).size !== ports.length ||
			ports.some((p) => !(p >= base && p < base + ctx.input.endpoints))
		)
			reasons.push("RAW realm source ports differ from the registered pool");
	}
	// Server session census and windows.
	const steadyMs =
		(cell.arm === "storm" ? R.stormSteadySeconds : R.hotspotSteadySeconds) *
		1000;
	for (const [id, shard] of ctx.shardById) {
		const wall = atNum(shard, "windows.steady.wallMs");
		if (Math.abs(wall - steadyMs) > R.wallToleranceMs)
			reasons.push(
				`RAW shard ${id} steady wall ${wall} ms != ${steadyMs}±${R.wallToleranceMs}`,
			);
	}
	if (cell.arm === "hotspot") {
		const pub = ctx.publisher as Row;
		const sub = ctx.subscriber as Row;
		if (
			pub.role !== "publisher" ||
			pub.sessionsOk !== 1 ||
			pub.sessionsErr !== 0
		)
			reasons.push(
				"RAW publisher process is not one connected publisher session",
			);
		if (
			sub.role !== "raid-subscriber" ||
			sub.sessionsOk !== RAID_MEMBERS ||
			sub.sessionsErr !== 0
		)
			reasons.push("RAW raid-subscriber process is not 40 connected sessions");
		for (const [label, r] of [
			["realm", m],
			["publisher", pub],
			["raid-subscriber", sub],
		] as const)
			if (at(r, "arms.raidMembership") !== "explicit")
				reasons.push(`RAW ${label} raid membership is not explicit`);
		if (at(sub, "arms.raidJoinsSent") !== RAID_MEMBERS)
			reasons.push("RAW raid-subscriber did not send exactly 40 RAID_JOINs");
		if (atInt(pub, "windows.steady.sent") <= 0)
			reasons.push("RAW publisher sent nothing in steady");
		// Raid processes own registered ports right after the realm pool.
		if (ctx.input.fixedSourcePortBase !== null) {
			const after = ctx.input.fixedSourcePortBase + ctx.input.endpoints;
			for (const [label, r, port] of [
				["publisher", pub, after],
				["raid-subscriber", sub, after + 1],
			] as const) {
				const addrs = arr(
					at(r, "client.endpointSourceAddresses"),
					`${label} addresses`,
				);
				if (addrs.length !== 1 || !String(addrs[0]).endsWith(`:${port}`))
					reasons.push(
						`RAW ${label} source port is not the registered ${port}`,
					);
			}
		}
		// Server census at drain (after the publisher's first datagram).
		let player = 0;
		let raid = 0;
		let publisher = 0;
		for (const id of ctx.shardById.keys()) {
			const echo = shardEcho(ctx, id, "drain");
			if (echo === null) continue;
			player += atInt(echo, "sessionKinds.player");
			raid += atInt(echo, "sessionKinds.raid");
			publisher += atInt(echo, "sessionKinds.publisher");
		}
		if (player !== cell.sessions || raid !== RAID_MEMBERS || publisher !== 1)
			reasons.push(
				`RAW server census at drain player/raid/publisher ${player}/${raid}/${publisher}, registered ${cell.sessions}/${RAID_MEMBERS}/1`,
			);
	} else {
		const storm = obj(at(m, "arms.storm"), "realm arms.storm");
		if (storm.timeline !== "anchored")
			reasons.push("RAW storm timeline not anchored");
		if (storm.cohort !== cell.cohort) reasons.push("RAW storm cohort differs");
		if (storm.severedClosed !== cell.cohort)
			reasons.push(
				`RAW severed ${String(storm.severedClosed)} != cohort ${cell.cohort}`,
			);
		if (storm.reconnectDelayMs !== R.stormReconnectDelayMs)
			reasons.push("RAW reconnect delay differs");
		for (const [i, r] of ctx.perProcess.entries()) {
			const own = atInt(r, "arms.storm.cohort");
			if (own !== evenShare(cell.cohort, ctx.input.clientProcesses, i))
				reasons.push(`RAW process ${i} cohort ${own} is not its even share`);
		}
		if (at(m, "storm.concurrency") !== null)
			reasons.push(
				"RAW storm ran with a connect permit pool (registered: none)",
			);
		const st = obj(ctx.arms.storm, "arms.storm");
		const severAt = int(st.severAtMs, "severAtMs");
		const startAt = int(st.stormStartAtMs, "stormStartAtMs");
		const endAt = int(st.stormEndAtMs, "stormEndAtMs");
		if (
			Math.abs(startAt - severAt - R.stormReconnectDelayMs) > R.wallToleranceMs
		)
			reasons.push(
				`RAW storm window opened ${startAt - severAt} ms after sever`,
			);
		if (
			Math.abs(endAt - startAt - R.stormWindowSeconds * 1000) >
			R.wallToleranceMs
		)
			reasons.push(`RAW storm window lasted ${endAt - startAt} ms`);
		const perShard = arr(at(st, "server.perShard"), "storm perShard");
		if (perShard.length !== ctx.input.shards)
			reasons.push("RAW storm per-shard evidence incomplete");
		for (const entry of perShard)
			if (maybeObj(entry)?.severAtMs !== severAt)
				reasons.push("RAW a shard ran a different server-clock sever instant");
		for (const [id, shard] of ctx.shardById) {
			const wall = atNum(shard, "windows.storm.wallMs");
			if (Math.abs(wall - R.stormWindowSeconds * 1000) > R.wallToleranceMs)
				reasons.push(`RAW shard ${id} storm wall ${wall} ms`);
		}
		const steadyTotal = [...ctx.shardById.values()].reduce(
			(t, s) => t + int(s.sessionsAtSteady, "sessionsAtSteady"),
			0,
		);
		if (steadyTotal !== cell.sessions)
			reasons.push(
				`RAW server sessions at steady ${steadyTotal} != ${cell.sessions}`,
			);
	}
	return run("RAW", reasons);
}

/* ------------------------------------------------------------------------ */
/* Clauses                                                                   */
/* ------------------------------------------------------------------------ */

/** Worst-process generator scheduleLag p99 (V-F'); null when no samples anywhere. */
function worstProcessLag(parts: readonly [string, unknown][]): {
	worstMs: number | null;
	byProcess: Record<string, number | null>;
} {
	const byProcess: Record<string, number | null> = {};
	let worst: number | null = null;
	for (const [label, hist] of parts) {
		const p = p99Ms(hist, `${label} scheduleLag`);
		byProcess[label] = p;
		if (p !== null && (worst === null || p > worst)) worst = p;
	}
	return { worstMs: worst, byProcess };
}

export function applyGeneratorLimit(
	clause: ArmsClause,
	lag: { worstMs: number | null; byProcess: Record<string, number | null> },
	histogramName: string,
): ArmsClause {
	const ceiling = SHARDED_ARMS_REGISTERED.generatorLagCeilingMs;
	const observed = {
		...clause.observed,
		vFPrimeHistogram: histogramName,
		vFPrimeWorstProcessP99Ms: lag.worstMs,
	};
	if (lag.worstMs === null)
		return { ...clause, observed, generatorLimited: "not applicable" };
	if (lag.worstMs > ceiling)
		return {
			...clause,
			observed,
			verdict: "INVALID",
			generatorLimited: "fired",
			reasons: [
				`V-F': worst generator process ${histogramName} p99 ${lag.worstMs.toFixed(3)} ms > ${ceiling} ms — generator-limited, never a deployment MISS`,
				...clause.reasons,
			],
		};
	return { ...clause, observed, generatorLimited: "clear" };
}

/** A G6 clause re-gated at the deployment's own ACK ceiling. */
function regateRtt(
	g6: ClauseResult,
	id: string,
	p99: number | null,
	g6Prefix: string,
): ArmsClause {
	const ceiling = SHARDED_ARMS_REGISTERED.realmAckRttP99CeilingMs;
	const reasons = g6.reasons.filter((r) => !r.startsWith(g6Prefix));
	if (p99 !== null && p99 > ceiling)
		reasons.push(
			`${id}: survivor ACK RTT p99 ${p99.toFixed(3)} ms > ${ceiling} ms`,
		);
	const verdict =
		g6.verdict === "INCOMPLETE" || g6.verdict === "N/A"
			? g6.verdict
			: reasons.length > 0
				? "MISS"
				: "PASS";
	return {
		...g6,
		id,
		verdict,
		reasons,
		observed: { ...g6.observed, budgetMs: ceiling, g6BudgetMs: rttBudgetMs() },
		gated: true,
	};
}

/* ------------------------------------------------------------------------ */
/* Cell grader                                                               */
/* ------------------------------------------------------------------------ */

export function gradeShardedArmsCell(
	input: ShardedArmsGradeInput,
	runDateIso: string,
): ShardedArmsCellVerdict {
	const { cell } = input;
	const disclosures = [
		...DISCLOSURES_COMMON,
		...(cell.arm === "storm" ? DISCLOSURES_STORM : DISCLOSURES_HOTSPOT),
		...(cell.arm === "storm" && cell.role === "characterization"
			? DISCLOSURES_CHARACTERIZATION_STORM
			: []),
	];
	const base = {
		schema: "g6-sharded-arms-cell/1" as const,
		preregistrationId: SHARDED_ARMS_PREREGISTRATION_ID,
		cell: cell.id,
		arm: cell.arm,
		role: cell.role,
		verdictForce: cell.role !== "characterization",
		disclosures,
		vR: input.vR,
	};
	let ctx: Ctx;
	try {
		ctx = buildContext(input);
	} catch (error) {
		return {
			...base,
			verdict: "INVALID",
			invalidReasons: [error instanceof Error ? error.message : String(error)],
			clauses: [],
			reportedBeside: [],
			falsifiers: [],
			characterization: {},
		};
	}
	const falsifiers: FalsifierResult[] = [];
	const clauses: ArmsClause[] = [];
	const reportedBeside: ClauseResult[] = [];
	const characterization: Record<string, unknown> = {};
	const guard = (id: string, f: () => FalsifierResult) => {
		try {
			falsifiers.push(f());
		} catch (error) {
			falsifiers.push(
				run(id, [
					`${id}: ${error instanceof Error ? error.message : String(error)}`,
				]),
			);
		}
	};
	guard("V-C", () => falsifierRig(input.rig));
	guard("RAW", () => rawCellExpectations(ctx));
	guard("V-F", () => vFloor(ctx, runDateIso));
	guard("V-N/V-K/V-D", () => vHistograms(ctx).falsifier);
	guard("V-G", () => vGenerator(ctx));
	guard("V-P", () => vPlacement(ctx));
	guard("V-B", () => vBarrier(ctx));
	try {
		if (cell.arm === "hotspot")
			gradeHotspot(ctx, clauses, reportedBeside, guard, characterization);
		else
			gradeStorm(
				ctx,
				clauses,
				reportedBeside,
				falsifiers,
				guard,
				characterization,
			);
	} catch (error) {
		falsifiers.push(
			run("RAW", [error instanceof Error ? error.message : String(error)]),
		);
	}
	const invalidReasons = [
		...falsifiers
			.filter((f) => f.fired && f.scope === "run")
			.flatMap((f) => f.reasons),
		...clauses
			.filter((c) => c.gated && c.verdict === "INVALID")
			.flatMap((c) => c.reasons.filter((r) => r.startsWith("V-F'"))),
	];
	const gated = clauses.filter((c) => c.gated);
	const verdict: ShardedArmsCellVerdict["verdict"] =
		invalidReasons.length > 0
			? "INVALID"
			: gated.some((c) => c.verdict === "MISS")
				? "MISS"
				: gated.some((c) => c.verdict === "INCOMPLETE")
					? "INCOMPLETE"
					: "PASS";
	return {
		...base,
		verdict,
		invalidReasons,
		clauses,
		reportedBeside,
		falsifiers,
		characterization,
	};
}

function gradeHotspot(
	ctx: Ctx,
	clauses: ArmsClause[],
	reportedBeside: ClauseResult[],
	guard: (id: string, f: () => FalsifierResult) => void,
	characterization: Record<string, unknown>,
): void {
	const K = ctx.targetServerId;
	const shardK = ctx.shardById.get(K) ?? fail(`raid shard ${K} missing`);
	const sub = ctx.subscriber as Row;
	const pub = ctx.publisher as Row;
	const subDrain = window(sub, "steadyDrain");
	const oneWay = histogramFacts(
		"raid-subscriber steadyDrain oneWay",
		subDrain.oneWay,
		int(subDrain.rxRaid, "rxRaid"),
		int(subDrain.rxUnstamped, "rxUnstamped"),
	);
	const ingested = raidIngest(shardK, "steadyDrain");
	const stopEcho = shardEcho(ctx, K, "stop");
	const hot = maybeObj(stopEcho?.hotspot);
	const gaps = hot
		? arr(hot.publisherGapsSteadyDrainNs, "publisher gaps").map((g) =>
				num(g, "gap"),
			)
		: [];
	const frameGap = frameGapFractionOf(gaps);
	const pubSteady = window(pub, "steady");
	const fired = int(pubSteady.scheduleTicksFired, "publisher ticks fired");
	const facts: HotspotFacts = {
		subscribers: RAID_MEMBERS,
		oneWay,
		ingested,
		forwarded: atInt(shardK, "windows.steadyDrain.emitter.raidForwarded"),
		subscriberReceived: int(subDrain.rxRaid, "rxRaid"),
		pathP50Ns: oneWay.p50Ns ?? 0,
		serverForwardDwellP50Ns: hot
			? (percentileNs(histJson(hot.ingestToForwardSteadyDrain, "dwell"), 0.5) ??
				0)
			: 0,
		frameGapFraction: frameGap ?? -1,
		datagramsPerTick:
			fired > 0 ? int(pubSteady.sent, "publisher sent") / fired : 0,
		publisherStamped: hot ? int(hot.publisherStampedSteadyDrain, "stamped") : 0,
	};
	// Generator-limited check, named histogram: steady-window scheduleLag of
	// every generator process that drives load (realm processes + publisher).
	const lag = worstProcessLag([
		...ctx.perProcess.map((r, i): [string, unknown] => [
			`realm process ${i}`,
			window(r, "steady").scheduleLag,
		]),
		["publisher", pubSteady.scheduleLag],
	]);
	clauses.push(
		applyGeneratorLimit(
			{ ...clauseH1(facts), gated: true },
			lag,
			"steady scheduleLag",
		),
		{ ...clauseH2(facts), gated: true },
	);
	const { wide, shardK: kFacts } = hotspotRealmFacts(ctx);
	const h3Wide = realmContractClause("H3 realm-wide", wide);
	const h3K = realmContractClause(`H3 shard ${K}`, kFacts);
	const h3Reasons = [...h3Wide.reasons, ...h3K.reasons];
	const parts = [h3Wide.verdict, h3K.verdict];
	const h3: ArmsClause = {
		id: "H3",
		verdict: parts.includes("MISS")
			? "MISS"
			: parts.includes("INCOMPLETE")
				? "INCOMPLETE"
				: "PASS",
		reasons: h3Reasons,
		observed: {
			...Object.fromEntries(
				Object.entries(h3Wide.observed).map(([k, v]) => [`wide.${k}`, v]),
			),
			...Object.fromEntries(
				Object.entries(h3K.observed).map(([k, v]) => [`shardK.${k}`, v]),
			),
		},
		gated: true,
	};
	clauses.push(applyGeneratorLimit(h3, lag, "steady scheduleLag"));
	// G6's original H3 (C1 >= 0.995, C3 <= 50 ms), reported beside.
	const wideRtt = histogramFacts(
		"realm steadyDrain rtt",
		wide.rtt,
		atInt(ctx.merged, "windows.steadyDrain.rxAck"),
		atInt(ctx.merged, "windows.steadyDrain.rxUnstamped"),
	);
	reportedBeside.push({
		...clauseH3(steadyArmFacts(wide, wideRtt)),
		id: "H3 (G6 C1/C3, 50 ms; no verdict force)",
	});
	guard("V-I", () => {
		const reasons: string[] = [];
		if (hot === null)
			reasons.push(
				`V-I: shard ${K} carries no raw publisher arrival record (H4 inputs absent)`,
			);
		else {
			if (int(hot.publisherArrivalsSteadyDrain, "arrivals") !== ingested)
				reasons.push(
					`V-I: shard ${K} publisher arrivals ${String(hot.publisherArrivalsSteadyDrain)} != steady+drain raid ingest ${ingested}`,
				);
			if (frameGap === null)
				reasons.push(`V-I: shard ${K} recorded no publisher arrival gaps`);
		}
		const verdict = falsifierIngestReality(facts);
		return {
			...verdict,
			id: "V-I/H4",
			fired: verdict.fired || reasons.length > 0,
			reasons: [...reasons, ...verdict.reasons],
		};
	});
	guard("V-S", () => {
		const r = vSink(ctx);
		characterization["V-S"] = r.facts;
		return r.falsifier;
	});
}

function gradeStorm(
	ctx: Ctx,
	clauses: ArmsClause[],
	reportedBeside: ClauseResult[],
	falsifiers: FalsifierResult[],
	guard: (id: string, f: () => FalsifierResult) => void,
	characterization: Record<string, unknown>,
): void {
	const { cell } = ctx.input;
	const st = obj(ctx.arms.storm, "arms.storm");
	const severAt = int(st.severAtMs, "severAtMs");
	const endAt = int(st.stormEndAtMs, "stormEndAtMs");
	const surv = window(ctx.merged, "stormSurvivors");
	const survivorSessions = cell.sessions - cell.cohort;
	const survRtt = histogramFacts(
		"realm stormSurvivors rtt",
		surv.rtt,
		int(surv.rxAck, "survivor rxAck"),
		int(surv.rxUnstamped, "survivor rxUnstamped"),
	);
	// Re-accepts from the raw server accept instants, (sever, window close].
	const perShard = arr(at(st, "server.perShard"), "storm perShard").map((e) =>
		obj(e, "perShard"),
	);
	let reAccepted = 0;
	const acceptsAfter: number[] = [];
	for (const entry of perShard) {
		const accepts = arr(entry.acceptMsAfterSever, "acceptMsAfterSever").map(
			(t) => num(t, "accept instant"),
		);
		acceptsAfter.push(...accepts);
		reAccepted += accepts.filter((t) => t > severAt && t <= endAt).length;
	}
	// Survivor upstream at the server. The shards' JS loop classifies the
	// datagrams it sees by accept instant (rxSurvivors), but ACTION datagrams
	// are reflected by the native ACK reflector and never reach that loop, so
	// rxSurvivors holds survivor MOVES only. Survivor actions are counted as
	// ingested only when the survivor received their reflection (client
	// stormSurvivors.rxAck): a conservative lower bound (a reflection lost on
	// the way down counts as an upstream loss). Disclosed; see DISCLOSURES_STORM.
	const survivorMovesJs = sumShards(ctx, (s) =>
		atInt(s, "windows.storm.rxSurvivors"),
	);
	const survivorAcksReflected = int(surv.rxAck, "survivor rxAck");
	const survivorServerRx = survivorMovesJs + survivorAcksReflected;
	// The lower bound can never exceed what the survivors sent: a numerator
	// above survivor `sent` means double counting (raw integrity, INVALID).
	guard("S-C1 accounting", () =>
		run(
			"S-C1 accounting",
			survivorSessions > 0 && survivorServerRx > int(surv.sent, "survivor sent")
				? [
						`S-C1 numerator ${survivorServerRx} (rxSurvivors ${survivorMovesJs} + rxAck ${survivorAcksReflected}) > survivor sent ${int(surv.sent, "survivor sent")}`,
					]
				: [],
		),
	);
	const atClose = maybeObj(at(st, "sessionsByShardAtStormEnd"))?.server;
	const activeAtClose = Object.values(
		obj(atClose, "server counts at storm end"),
	).reduce((t: number, v) => t + int(v, "sessionsActive"), 0);
	const metricDelta = (key: string) =>
		sumShards(ctx, (s) => atNum(s, `windows.storm.metrics.${key}`));
	const facts: StormFacts = {
		cohort: cell.cohort,
		realmSessions: cell.sessions,
		survivors:
			survivorSessions === 0
				? null
				: {
						sessions: survivorSessions,
						rtt: survRtt,
						clientEnqueuedUpstream: int(surv.sent, "survivor sent"),
						serverRxUpstream: survivorServerRx,
						sessionsLost: int(surv.sessionsLost, "survivor sessionsLost"),
					},
		reAcceptedInWindow: reAccepted,
		sessionsActiveAtWindowClose: activeAtClose,
		limitExceededDelta: metricDelta("limitExceededCount"),
		rateLimitedDelta: metricDelta("rateLimitedCount"),
		stormWindowSec: SHARDED_ARMS_REGISTERED.stormWindowSeconds,
	};
	const g6sc1 = clauseSC1(facts);
	const sent = int(surv.sent, "survivor sent");
	const survivorAccounting = {
		survivorMovesJs,
		survivorAcksReflected,
		deliveryUncorrected: sent > 0 ? survivorMovesJs / sent : null,
	};
	g6sc1.observed = { ...g6sc1.observed, ...survivorAccounting };
	reportedBeside.push({ ...g6sc1, id: "S-C1 (G6, 50 ms; no verdict force)" });
	const gatedSc1 = cell.gatedClauses.includes("S-C1");
	const sc1 = regateRtt(
		g6sc1,
		"S-C1",
		survRtt.p99Ns === null ? null : survRtt.p99Ns / 1e6,
		"S-C1: survivor RTT p99",
	);
	const lag = worstProcessLag(
		ctx.perProcess.map((r, i): [string, unknown] => [
			`realm process ${i}`,
			window(r, "stormSurvivors").scheduleLag,
		]),
	);
	clauses.push(
		applyGeneratorLimit(
			{ ...sc1, gated: gatedSc1 },
			lag,
			"storm-window survivor scheduleLag",
		),
	);
	clauses.push({
		...clauseSC2(facts),
		gated: cell.gatedClauses.includes("S-C2"),
	});
	guard("V-T", () => vSeverSkew(ctx));
	const vrReported: FalsifierResult[] = [];
	guard("V-R", () => {
		const r = vReconnectIssue(ctx);
		if (cell.role !== "characterization")
			return run("V-R", [...r.reasons, ...r.late]);
		// S2-40k: an Initial later than R is reported, not verdict-forcing.
		vrReported.push({
			id: "V-R (reported)",
			fired: r.late.length > 0,
			reasons: r.late,
			scope: "characterization",
		});
		return run("V-R", r.reasons);
	});
	falsifiers.push(...vrReported);
	let steeringFacts: Record<string, unknown> = {};
	guard("V-W", () => {
		const r = vSteering(ctx);
		steeringFacts = r.facts;
		return r.falsifier;
	});
	// S-M characterization (no verdict force) and V-L.
	const sorted = [...acceptsAfter].sort((a, b) => a - b);
	const perSecond = new Map<number, number>();
	for (const t of sorted) {
		const k = Math.floor((t - severAt) / 1000);
		perSecond.set(k, (perSecond.get(k) ?? 0) + 1);
	}
	const spanSec =
		sorted.length > 1
			? ((sorted.at(-1) as number) - (sorted[0] as number)) / 1000
			: null;
	const stormSummary = obj(ctx.merged.storm, "merged storm summary");
	const meanMs = stormSummary.reconnectMeanMs;
	const little = falsifierLittle({
		acceptRatePerSec: spanSec && spanSec > 0 ? sorted.length / spanSec : null,
		meanAcceptLatencySec: typeof meanMs === "number" ? meanMs / 1000 : null,
		connectConcurrency:
			typeof stormSummary.concurrency === "number"
				? stormSummary.concurrency
				: null,
	});
	falsifiers.push(little);
	let hsMax = 0;
	for (const entry of perShard)
		for (const s of arr(entry.stormSamples ?? [], "stormSamples")) {
			const v = maybeObj(s)?.handshakesInFlight;
			if (typeof v === "number" && v > hsMax) hsMax = v;
		}
	Object.assign(characterization, {
		"S-M": {
			verdictForce: false,
			strippedByVL: little.fired,
			reAcceptedInWindow: reAccepted,
			firstReAcceptAfterSeverMs: sorted.length
				? (sorted[0] as number) - severAt
				: null,
			lastReAcceptAfterSeverMs: sorted.length
				? (sorted.at(-1) as number) - severAt
				: null,
			peakAcceptsPerSecond: Math.max(0, ...perSecond.values()),
			handshakesInFlightMax: hsMax,
			clientReconnectMs: stormSummary.reconnectMs ?? null,
			clientReconnectMeanMs: meanMs ?? null,
		},
		steering: steeringFacts,
		structurallyZero: {
			limitExceededDelta: facts.limitExceededDelta,
			rateLimitedDelta: facts.rateLimitedDelta,
		},
	});
}
