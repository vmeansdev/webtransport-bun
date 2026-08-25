import { describe, expect, test } from "bun:test";
import { SNAPSHOT_HZ, snapshotDatagrams } from "./g6-plan.ts";
import {
	G6_SHARDED_CLAUSES,
	G6_SHARDED_VALIDITY,
	gradeRung,
} from "./g6-sharded-grade.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

const CANDIDATE = "a".repeat(40);

function rttJson(p99ApproxMs: number): unknown {
	const hist = new LatencyHistogram();
	for (let i = 0; i < 1000; i += 1) {
		hist.record(p99ApproxMs * 1e6 * 0.5);
	}
	hist.record(p99ApproxMs * 1e6);
	return hist.toJson();
}

function scanFixture(over: {
	sessions: number;
	rx: number;
	issued: number;
	rxSnapshot: number;
	sent: number;
	sessionsLost?: number;
	sessionsErr?: number;
	candidate?: string;
	paced?: boolean;
	rttP99Ms?: number;
}) {
	const report = {
		schema: "mmo-client/2",
		sessionsOk: over.sessions - (over.sessionsErr ?? 0),
		sessionsErr: over.sessionsErr ?? 0,
		windows: {
			steady: {
				sent: over.sent,
				sessionsLost: over.sessionsLost ?? 0,
			},
			steadyDrain: {
				rxSnapshot: over.rxSnapshot,
				rtt: rttJson(over.rttP99Ms ?? 5),
			},
		},
	};
	return {
		candidateSha: over.candidate ?? CANDIDATE,
		config: {
			shards: 16,
			sessions: over.sessions,
			paced: over.paced ?? false,
			steadySeconds: 120,
		},
		clientExit: 0,
		aggregate: {
			steady: {
				rxTotal: over.rx,
				emitter: { snapshotIssued: over.issued, sendErrors: 0 },
			},
		},
		clientStdout: `noise\nmmo-client: json ${JSON.stringify(report)}\n`,
	};
}

describe("g6-sharded-grade", () => {
	test("thresholds are the preregistered ones", () => {
		expect(G6_SHARDED_CLAUSES.ingestFloor).toBe(0.995);
		expect(G6_SHARDED_CLAUSES.deliveryFloor).toBe(0.995);
		expect(G6_SHARDED_CLAUSES.dutyFloor).toBe(0.99);
		expect(G6_SHARDED_CLAUSES.ackRttP99CeilingMs).toBe(25);
		expect(G6_SHARDED_CLAUSES.sessionsLostCap).toBe(0.001);
		expect(G6_SHARDED_VALIDITY.requiredShards).toBe(16);
		expect(G6_SHARDED_VALIDITY.pacedEmitter).toBe(false);
	});

	test("a clean rung grades valid PASS", () => {
		const sessions = 15000;
		const demand = sessions * SNAPSHOT_HZ * snapshotDatagrams() * 120;
		const sent = sessions * 4 * 120;
		const verdict = gradeRung(
			sessions,
			scanFixture({
				sessions,
				sent,
				rx: sent,
				issued: demand,
				rxSnapshot: demand,
			}),
			CANDIDATE,
		);
		expect(verdict.valid).toBe(true);
		expect(verdict.gate).toBe("PASS");
	});

	test("duty below the floor is a valid MISS, not a refusal", () => {
		const sessions = 20000;
		const demand = sessions * SNAPSHOT_HZ * snapshotDatagrams() * 120;
		const sent = sessions * 4 * 120;
		const issued = Math.floor(demand * 0.968);
		const verdict = gradeRung(
			sessions,
			scanFixture({
				sessions,
				sent,
				rx: sent,
				issued,
				rxSnapshot: issued,
			}),
			CANDIDATE,
		);
		expect(verdict.valid).toBe(true);
		expect(verdict.gate).toBe("MISS");
		expect(verdict.clauses.S3_duty?.pass).toBe(false);
		expect(verdict.clauses.S1_ingest?.pass).toBe(true);
	});

	test("candidate mismatch and paced emitter refuse rather than grade", () => {
		const sessions = 5000;
		const demand = sessions * SNAPSHOT_HZ * snapshotDatagrams() * 120;
		const sent = sessions * 4 * 120;
		const wrongCandidate = gradeRung(
			sessions,
			scanFixture({
				sessions,
				sent,
				rx: sent,
				issued: demand,
				rxSnapshot: demand,
				candidate: "b".repeat(40),
			}),
			CANDIDATE,
		);
		expect(wrongCandidate.valid).toBe(false);
		expect(wrongCandidate.gate).toBe(null);

		const paced = gradeRung(
			sessions,
			scanFixture({
				sessions,
				sent,
				rx: sent,
				issued: demand,
				rxSnapshot: demand,
				paced: true,
			}),
			CANDIDATE,
		);
		expect(paced.valid).toBe(false);
		expect(paced.gate).toBe(null);
	});

	test("connect errors refuse; a lost-session trickle is a clause, not a refusal", () => {
		const sessions = 5000;
		const demand = sessions * SNAPSHOT_HZ * snapshotDatagrams() * 120;
		const sent = sessions * 4 * 120;
		const connectErr = gradeRung(
			sessions,
			scanFixture({
				sessions,
				sent,
				rx: sent,
				issued: demand,
				rxSnapshot: demand,
				sessionsErr: 1,
			}),
			CANDIDATE,
		);
		expect(connectErr.valid).toBe(false);

		const lostTrickle = gradeRung(
			sessions,
			scanFixture({
				sessions,
				sent,
				rx: sent,
				issued: demand,
				rxSnapshot: demand,
				sessionsLost: 20,
			}),
			CANDIDATE,
		);
		expect(lostTrickle.valid).toBe(true);
		expect(lostTrickle.gate).toBe("MISS");
		expect(lostTrickle.clauses.S5_sessionsLost?.pass).toBe(false);
	});
});
