/**
 * Registered grader for the G6-sharded gate (g6-sharded-01): computes the
 * pre-registered clauses over g6-sharded-scan/1 artifacts, one rung per file.
 *
 * The producer is tools/load/g6-sharded-scan.ts (the sharded conductor), not
 * bench-g6 — this grader is the frozen half that turns its schema into a
 * registered verdict. Thresholds live HERE, in tracked code, pre-committed by
 * the preregistration's hash of this file's constants; a failed rung is
 * diagnosed, never re-thresholded.
 *
 * Usage:
 *   bun tools/load/g6-sharded-grade.ts \
 *     --expect-candidate <sha> \
 *     --steer-stats <bpftool -j map dump of steer_stats> \
 *     --rung <sessions>=<scan.json> [--rung ...] \
 *     [--out verdict.json]
 *
 * Exit 0: every rung valid (PASS or MISS both count — a MISS is a verdict).
 * Exit 2: any rung invalid (a validity falsifier fired; no verdict exists).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SNAPSHOT_HZ, snapshotDatagrams } from "./g6-plan.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

/** Frozen clause thresholds (preregistration g6-sharded-01 §3). */
export const G6_SHARDED_CLAUSES = Object.freeze({
	/** S1: server-ingested upstream / client-sent upstream, steady window. */
	ingestFloor: 0.995,
	/** S2: client-received snapshots (steady+drain) / server-issued. The
	 * issued figure is the steady+drain emitter counter: emission stops at the
	 * steady edge, so the drain tail holds only late-resolved bookings of
	 * steady-window sends (the .then-at-the-edge undercount the critic proved
	 * against the steady-only counter). */
	deliveryFloor: 0.995,
	/** S3: server-issued snapshots / registered demand (sessions×15×120). */
	dutyFloor: 0.99,
	/** S4: client ack RTT p99 over steady+drain, milliseconds. */
	ackRttP99CeilingMs: 25,
	/** S5: sessions lost during steady, as a fraction of the rung. */
	sessionsLostCap: 0.001,
});

/** Frozen validity rules (§4): these refuse, they never MISS. */
export const G6_SHARDED_VALIDITY = Object.freeze({
	steadySeconds: 120,
	requiredShards: 16,
	requiredEndpoints: 128,
	pacedEmitter: false,
	sessionsErrMax: 0,
	/** Per-shard steady wall-clock tolerance: event-loop-clocked marks stretch
	 * under load; a stretched window inflates S1 (0.083 %/100 ms). */
	steadyWallMsTolerance: 250,
	/** Run-scoped steering floor: steered short-header packets must cover this
	 * fraction of the summed steady upstream — a `> 0` bound would validate a
	 * 99.9 %-kernel-hash run with one steered packet of residue. */
	steeredFloorFractionOfUpstream: 0.9,
});

type ShardEntry = {
	serverId: number;
	sessionsAtSteady: number | null;
	windows: {
		steady: BoundaryLike;
		steadyDrain: BoundaryLike;
	} | null;
};

type BoundaryLike = {
	rxTotal: number;
	wallMs: number;
	emitter: { snapshotIssued: number; sendErrors: number };
};

export type RungScan = {
	candidateSha: string;
	config: {
		shards: number;
		sessions: number;
		paced: boolean;
		steadySeconds: number;
		endpoints: number;
	};
	clientExit: number;
	shards: ShardEntry[];
	aggregate: {
		steady: {
			rxTotal: number;
			emitter: { snapshotIssued: number; sendErrors: number };
		};
		steadyDrain: {
			emitter: { snapshotIssued: number };
		};
	};
	clientStdout: string;
};

type RungVerdict = {
	rung: number;
	valid: boolean;
	invalidReasons: string[];
	clauses: Record<string, { value: number; bound: number; pass: boolean }>;
	gate: "PASS" | "MISS" | null;
	steadySent: number;
};

function arg(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function args(name: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < process.argv.length; i += 1) {
		if (process.argv[i] === `--${name}`) {
			const v = process.argv[i + 1];
			if (v !== undefined) out.push(v);
		}
	}
	return out;
}

function clientReport(scan: { clientStdout: string }): unknown {
	const line = scan.clientStdout
		.split("\n")
		.find((l) => l.includes('"schema":"mmo-client/2"'));
	if (!line) throw new Error("no mmo-client/2 report in clientStdout");
	return JSON.parse(line.slice(line.indexOf("{")));
}

function p99Ms(histJson: unknown): number | null {
	const summary = LatencyHistogram.fromJson(histJson as never).summary();
	return summary.count === 0 ? null : summary.p99Ns / 1e6;
}

export function gradeRung(
	rungSessions: number,
	scan: RungScan,
	expectCandidate: string,
): RungVerdict {
	const invalid: string[] = [];
	const v = G6_SHARDED_VALIDITY;
	if (scan.candidateSha !== expectCandidate)
		invalid.push(
			`candidate ${scan.candidateSha} != registered ${expectCandidate}`,
		);
	if (scan.config.shards !== v.requiredShards)
		invalid.push(`shards ${scan.config.shards} != ${v.requiredShards}`);
	if (scan.config.endpoints !== v.requiredEndpoints)
		invalid.push(
			`endpoints ${scan.config.endpoints} != ${v.requiredEndpoints}`,
		);
	if (scan.config.sessions !== rungSessions)
		invalid.push(`sessions ${scan.config.sessions} != rung ${rungSessions}`);
	if (scan.config.paced !== v.pacedEmitter)
		invalid.push(`paced ${scan.config.paced} != registered ${v.pacedEmitter}`);
	if (scan.config.steadySeconds !== v.steadySeconds)
		invalid.push(`steadySeconds ${scan.config.steadySeconds} != 120`);
	if (scan.clientExit !== 0) invalid.push(`clientExit ${scan.clientExit}`);

	// Shard survival + window completeness: a shard that died mid-steady must
	// refuse, never silently deflate the aggregate into an honest-looking MISS.
	if (scan.shards.length !== v.requiredShards) {
		invalid.push(`shard entries ${scan.shards.length} != ${v.requiredShards}`);
	} else {
		const ids = new Set(scan.shards.map((s) => s.serverId));
		if (ids.size !== v.requiredShards)
			invalid.push("duplicate shard serverIds");
		const steadySessions = scan.shards.reduce(
			(sum, s) => sum + (s.sessionsAtSteady ?? 0),
			0,
		);
		if (steadySessions !== rungSessions)
			invalid.push(
				`sessions at steady ${steadySessions} != rung ${rungSessions}`,
			);
		for (const shard of scan.shards) {
			if (shard.windows === null) {
				invalid.push(`shard ${shard.serverId} has no boundary windows`);
				continue;
			}
			const wall = shard.windows.steady.wallMs;
			const target = v.steadySeconds * 1000;
			if (Math.abs(wall - target) > v.steadyWallMsTolerance)
				invalid.push(
					`shard ${shard.serverId} steady wall ${wall}ms outside ${target}±${v.steadyWallMsTolerance}`,
				);
		}
	}
	if (scan.aggregate.steady.emitter.sendErrors !== 0)
		invalid.push(
			`emitter sendErrors ${scan.aggregate.steady.emitter.sendErrors} != 0`,
		);

	let clauses: RungVerdict["clauses"] = {};
	let gate: RungVerdict["gate"] = null;
	let steadySent = 0;
	try {
		const report = clientReport(scan) as {
			sessionsOk: number;
			sessionsErr: number;
			windows: {
				steady: { sent: number; sessionsLost: number };
				steadyDrain: { rxSnapshot: number; rtt: unknown };
			};
		};
		if (report.sessionsOk !== rungSessions)
			invalid.push(`sessionsOk ${report.sessionsOk} != ${rungSessions}`);
		if (report.sessionsErr > v.sessionsErrMax)
			invalid.push(`sessionsErr ${report.sessionsErr} > ${v.sessionsErrMax}`);

		const c = G6_SHARDED_CLAUSES;
		const demand =
			rungSessions * SNAPSHOT_HZ * snapshotDatagrams() * v.steadySeconds;
		steadySent = report.windows.steady.sent;
		// The steady+drain emitter counter: emission stops at the steady edge,
		// so this is the complete booking of steady-window sends (D1).
		const issued = scan.aggregate.steadyDrain.emitter.snapshotIssued;
		if (issued <= 0) invalid.push("no snapshots issued");
		const ackP99 = p99Ms(report.windows.steadyDrain.rtt);
		if (ackP99 === null) invalid.push("ack RTT histogram is empty");
		clauses = {
			S1_ingest: {
				value: scan.aggregate.steady.rxTotal / steadySent,
				bound: c.ingestFloor,
				pass: scan.aggregate.steady.rxTotal / steadySent >= c.ingestFloor,
			},
			S2_delivery: {
				value: report.windows.steadyDrain.rxSnapshot / issued,
				bound: c.deliveryFloor,
				pass: report.windows.steadyDrain.rxSnapshot / issued >= c.deliveryFloor,
			},
			S3_duty: {
				value: issued / demand,
				bound: c.dutyFloor,
				pass: issued / demand >= c.dutyFloor,
			},
			S4_ackRttP99Ms: {
				value: ackP99 ?? Number.NaN,
				bound: c.ackRttP99CeilingMs,
				pass: ackP99 !== null && ackP99 <= c.ackRttP99CeilingMs,
			},
			S5_sessionsLost: {
				value: report.windows.steady.sessionsLost / rungSessions,
				bound: c.sessionsLostCap,
				pass:
					report.windows.steady.sessionsLost / rungSessions <=
					c.sessionsLostCap,
			},
		};
	} catch (error) {
		invalid.push(`client report unusable: ${String(error)}`);
	}

	const valid = invalid.length === 0;
	if (valid) {
		gate = Object.values(clauses).every((cl) => cl.pass) ? "PASS" : "MISS";
	}
	return {
		rung: rungSessions,
		valid,
		invalidReasons: invalid,
		clauses,
		gate,
		steadySent,
	};
}

/** Total steered short-header packets from a `bpftool -j` percpu dump, or a
 * refusal reason string when the dump is unusable. */
export function steeredTotal(text: string): number | string {
	try {
		const dump = JSON.parse(text) as Array<{
			key: number;
			values: Array<{ value: number }>;
		}>;
		return dump
			.filter((row) => row.key === 0)
			.flatMap((row) => row.values)
			.reduce((sum, entry) => sum + entry.value, 0);
	} catch (error) {
		return `steer_stats dump unusable: ${String(error)}`;
	}
}

async function main(): Promise<void> {
	const expectCandidate = arg("expect-candidate");
	const steerStatsPath = arg("steer-stats");
	const rungSpecs = args("rung");
	if (!expectCandidate || !steerStatsPath || rungSpecs.length === 0) {
		throw new Error(
			"g6-sharded-grade: --expect-candidate, --steer-stats and at least one --rung <sessions>=<scan.json> are required",
		);
	}
	const verdicts: RungVerdict[] = [];
	for (const spec of rungSpecs) {
		const eq = spec.indexOf("=");
		const rung = parseInt(spec.slice(0, eq), 10);
		const scan = JSON.parse(readFileSync(spec.slice(eq + 1), "utf8"));
		verdicts.push(gradeRung(rung, scan, expectCandidate));
	}
	const steered = steeredTotal(readFileSync(steerStatsPath, "utf8"));
	const upstreamSum = verdicts.reduce((sum, v) => sum + v.steadySent, 0);
	const steeredFloor =
		G6_SHARDED_VALIDITY.steeredFloorFractionOfUpstream * upstreamSum;
	const steeringReason =
		typeof steered === "string"
			? steered
			: steered < steeredFloor
				? `steered ${steered} below floor ${Math.round(steeredFloor)} (0.9 × upstream ${upstreamSum})`
				: null;
	if (steeringReason !== null) {
		for (const verdict of verdicts) {
			verdict.valid = false;
			verdict.invalidReasons.push(steeringReason);
			verdict.gate = null;
		}
	}
	const result = {
		schema: "g6-sharded-grade/1",
		expectCandidate,
		steered,
		steeredFloor: Math.round(steeredFloor),
		clauses: G6_SHARDED_CLAUSES,
		validity: G6_SHARDED_VALIDITY,
		rungs: verdicts,
	};
	const out = arg("out");
	const text = JSON.stringify(result, null, 1);
	if (out) writeFileSync(out, text);
	console.log(text);
	process.exit(verdicts.every((verdict) => verdict.valid) ? 0 : 2);
}

if (import.meta.main) {
	await main();
}
