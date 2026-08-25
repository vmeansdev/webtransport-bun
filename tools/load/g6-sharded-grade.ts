/**
 * Registered grader for the G6-sharded gate (g6-sharded-01): computes the
 * pre-registered clauses over g6-sharded-scan/1 artifacts, one rung per file.
 *
 * The producer is tools/load/g6-sharded-scan.ts (the sharded conductor), not
 * bench-g6 — this grader is the frozen half that turns its characterization
 * schema into a registered verdict. Thresholds live HERE, in tracked code,
 * pre-committed by the preregistration's hash of this file's constants; a
 * failed rung is diagnosed, never re-thresholded.
 *
 * Usage:
 *   bun tools/load/g6-sharded-grade.ts \
 *     --expect-candidate <sha> --expect-shards 16 \
 *     --steer-stats <bpftool-json> \
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
	/** S2: client-received snapshots (steady+drain) / server-issued (steady). */
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
	pacedEmitter: false,
	sessionsErrMax: 0,
});

type RungVerdict = {
	rung: number;
	valid: boolean;
	invalidReasons: string[];
	clauses: Record<string, { value: number; bound: number; pass: boolean }>;
	gate: "PASS" | "MISS" | null;
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
	scan: {
		candidateSha: string;
		config: {
			shards: number;
			sessions: number;
			paced: boolean;
			steadySeconds: number;
		};
		clientExit: number;
		aggregate: {
			steady: {
				rxTotal: number;
				emitter: { snapshotIssued: number; sendErrors: number };
			};
		};
		clientStdout: string;
	},
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
	if (scan.config.sessions !== rungSessions)
		invalid.push(`sessions ${scan.config.sessions} != rung ${rungSessions}`);
	if (scan.config.paced !== v.pacedEmitter)
		invalid.push(`paced ${scan.config.paced} != registered ${v.pacedEmitter}`);
	if (scan.config.steadySeconds !== v.steadySeconds)
		invalid.push(`steadySeconds ${scan.config.steadySeconds} != 120`);
	if (scan.clientExit !== 0) invalid.push(`clientExit ${scan.clientExit}`);

	let clauses: RungVerdict["clauses"] = {};
	let gate: RungVerdict["gate"] = null;
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
		const sent = report.windows.steady.sent;
		const issued = scan.aggregate.steady.emitter.snapshotIssued;
		const ackP99 = p99Ms(report.windows.steadyDrain.rtt);
		if (ackP99 === null) invalid.push("ack RTT histogram is empty");
		clauses = {
			S1_ingest: {
				value: scan.aggregate.steady.rxTotal / sent,
				bound: c.ingestFloor,
				pass: scan.aggregate.steady.rxTotal / sent >= c.ingestFloor,
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
	return { rung: rungSessions, valid, invalidReasons: invalid, clauses, gate };
}

function steerStatsEngaged(path: string): boolean {
	const dump = JSON.parse(readFileSync(path, "utf8")) as Array<{
		key: number;
		values: Array<{ value: number }>;
	}>;
	const steered = dump
		.filter((row) => row.key === 0)
		.flatMap((row) => row.values)
		.reduce((sum, v) => sum + v.value, 0);
	return steered > 0;
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
	const steering = steerStatsEngaged(steerStatsPath);
	if (!steering) {
		for (const verdict of verdicts) {
			verdict.valid = false;
			verdict.invalidReasons.push("steer_stats shows zero steered packets");
			verdict.gate = null;
		}
	}
	const result = {
		schema: "g6-sharded-grade/1",
		expectCandidate,
		steeringEngaged: steering,
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
