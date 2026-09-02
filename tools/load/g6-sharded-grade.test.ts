import { describe, expect, test } from "bun:test";
import { SNAPSHOT_HZ, snapshotDatagrams } from "./g6-plan.ts";
import {
	applySteeringValidity,
	G6_SHARDED_CLAUSES,
	G6_SHARDED_VALIDITY,
	gradeRung,
	gradeRungForProfile,
	type RungScan,
	steeredTotal,
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
	emitterMode?: "per-player-batch" | "native-mirror" | "paced-mirror" | null;
	shardEmitterMode?:
		| "per-player-batch"
		| "native-mirror"
		| "paced-mirror"
		| null;
	rttP99Ms?: number;
	endpoints?: number;
	shardCount?: number;
	killShard?: number;
	stretchShardWallMs?: number;
	issuedSteadyOnly?: number;
	sendErrors?: number;
}): RungScan {
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
	const shardCount = over.shardCount ?? 16;
	const perShardSessions = over.sessions / shardCount;
	const emitterMode =
		over.emitterMode === undefined ? "native-mirror" : over.emitterMode;
	const shards = Array.from({ length: shardCount }, (_, index) => ({
		serverId: index + 1,
		emitterMode:
			over.shardEmitterMode === undefined ? emitterMode : over.shardEmitterMode,
		sessionsAtSteady: perShardSessions,
		windows:
			over.killShard === index + 1
				? null
				: {
						steady: {
							rxTotal: over.rx / shardCount,
							wallMs:
								120_000 +
								(over.stretchShardWallMs !== undefined && index === 0
									? over.stretchShardWallMs
									: 0),
							emitter: {
								snapshotIssued:
									(over.issuedSteadyOnly ?? over.issued) / shardCount,
								sendErrors: 0,
							},
						},
						steadyDrain: {
							rxTotal: over.rx / shardCount,
							wallMs: 121_000,
							emitter: {
								snapshotIssued: over.issued / shardCount,
								sendErrors: 0,
							},
						},
					},
	}));
	return {
		candidateSha: over.candidate ?? CANDIDATE,
		config: {
			shards: shardCount,
			sessions: over.sessions,
			paced: over.paced ?? false,
			emitterMode,
			steadySeconds: 120,
			endpoints: over.endpoints ?? 128,
		},
		clientExit: 0,
		shards,
		aggregate: {
			steady: {
				rxTotal: over.rx,
				emitter: {
					snapshotIssued: over.issuedSteadyOnly ?? over.issued,
					sendErrors: over.sendErrors ?? 0,
				},
			},
			steadyDrain: {
				emitter: { snapshotIssued: over.issued },
			},
		},
		clientStdout: `noise\nmmo-client: json ${JSON.stringify(report)}\n`,
	};
}

function cleanOver(sessions: number) {
	const demand = sessions * SNAPSHOT_HZ * snapshotDatagrams() * 120;
	const sent = sessions * 4 * 120;
	return { sessions, sent, rx: sent, issued: demand, rxSnapshot: demand };
}

describe("g6-sharded-grade", () => {
	test("thresholds and validity constants are the preregistered ones", () => {
		expect(G6_SHARDED_CLAUSES.ingestFloor).toBe(0.995);
		expect(G6_SHARDED_CLAUSES.deliveryFloor).toBe(0.995);
		expect(G6_SHARDED_CLAUSES.dutyFloor).toBe(0.99);
		expect(G6_SHARDED_CLAUSES.ackRttP99CeilingMs).toBe(25);
		expect(G6_SHARDED_CLAUSES.sessionsLostCap).toBe(0.001);
		expect(G6_SHARDED_VALIDITY.requiredShards).toBe(16);
		expect(G6_SHARDED_VALIDITY.requiredEndpoints).toBe(128);
		expect(G6_SHARDED_VALIDITY.pacedEmitter).toBe(false);
		expect(G6_SHARDED_VALIDITY.emitterMode).toBe("native-mirror");
		expect(G6_SHARDED_VALIDITY.steadyWallMsTolerance).toBe(250);
		expect(G6_SHARDED_VALIDITY.steeredFloorFractionOfUpstream).toBe(0.9);
	}, 15_000);

	test("a clean rung grades valid PASS", () => {
		const verdict = gradeRung(15000, scanFixture(cleanOver(15000)), CANDIDATE);
		expect(verdict.valid).toBe(true);
		expect(verdict.gate).toBe("PASS");
		expect(verdict.steadySent).toBe(15000 * 4 * 120);
	}, 15_000);

	test("a registered profile shard count grades a 24-shard rung", () => {
		const scan = scanFixture({ ...cleanOver(24_000), shardCount: 24 });
		const historical = gradeRung(24_000, scan, CANDIDATE);
		expect(historical.valid).toBe(false);
		expect(historical.invalidReasons).toContain("shards 24 != 16");
		expect(historical.invalidReasons).toContain("shard entries 24 != 16");
		const verdict = gradeRungForProfile(24_000, scan, CANDIDATE, {
			requiredEndpoints: G6_SHARDED_VALIDITY.requiredEndpoints,
			requiredShards: 24,
		});
		expect(verdict.invalidReasons).toEqual([]);
		expect(verdict.valid).toBe(true);
		expect(verdict.gate).toBe("PASS");
	}, 15_000);

	test("duty below the floor is a valid MISS, not a refusal", () => {
		const base = cleanOver(20000);
		const issued = Math.floor(base.issued * 0.968);
		const verdict = gradeRung(
			20000,
			scanFixture({ ...base, issued, rxSnapshot: issued }),
			CANDIDATE,
		);
		expect(verdict.valid).toBe(true);
		expect(verdict.gate).toBe("MISS");
		expect(verdict.clauses.S3_duty?.pass).toBe(false);
		expect(verdict.clauses.S1_ingest?.pass).toBe(true);
	}, 15_000);

	test("S2/S3 read the steady+drain issued counter, absorbing edge-booked sends", () => {
		const base = cleanOver(15000);
		// Steady-only counter is short by in-flight bookings; steadyDrain holds
		// the complete figure. The clauses must grade from the complete one.
		const verdict = gradeRung(
			15000,
			scanFixture({ ...base, issuedSteadyOnly: base.issued - 50_000 }),
			CANDIDATE,
		);
		expect(verdict.valid).toBe(true);
		expect(verdict.clauses.S3_duty?.value).toBe(1);
		expect(verdict.clauses.S2_delivery?.value).toBe(1);
	}, 15_000);

	test("candidate mismatch, paced emitter, and endpoint drift refuse", () => {
		const base = cleanOver(5000);
		for (const over of [
			{ ...base, candidate: "b".repeat(40) },
			{ ...base, paced: true },
			{ ...base, endpoints: 64 },
		]) {
			const verdict = gradeRung(5000, scanFixture(over), CANDIDATE);
			expect(verdict.valid).toBe(false);
			expect(verdict.gate).toBe(null);
		}
	}, 15_000);

	test("missing, mixed, or non-native emitter mode refuses", () => {
		const base = cleanOver(5000);
		for (const over of [
			{ ...base, emitterMode: null },
			{ ...base, emitterMode: "per-player-batch" as const },
			{ ...base, shardEmitterMode: "per-player-batch" as const },
		]) {
			const verdict = gradeRung(5000, scanFixture(over), CANDIDATE);
			expect(verdict.valid).toBe(false);
			expect(verdict.gate).toBe(null);
		}
	}, 15_000);

	test("a dead shard or a stretched shard window refuses rather than deflating", () => {
		const base = cleanOver(16000);
		const dead = gradeRung(
			16000,
			scanFixture({ ...base, killShard: 7 }),
			CANDIDATE,
		);
		expect(dead.valid).toBe(false);
		expect(
			dead.invalidReasons.some((reason) => reason.includes("shard 7")),
		).toBe(true);

		const stretched = gradeRung(
			16000,
			scanFixture({ ...base, stretchShardWallMs: 600 }),
			CANDIDATE,
		);
		expect(stretched.valid).toBe(false);
		expect(
			stretched.invalidReasons.some((reason) => reason.includes("steady wall")),
		).toBe(true);
	}, 15_000);

	test("connect errors refuse; a lost-session trickle is a clause, not a refusal", () => {
		const base = cleanOver(5000);
		const connectErr = gradeRung(
			5000,
			scanFixture({ ...base, sessionsErr: 1 }),
			CANDIDATE,
		);
		expect(connectErr.valid).toBe(false);

		const lostTrickle = gradeRung(
			5000,
			scanFixture({ ...base, sessionsLost: 20, sendErrors: 55 }),
			CANDIDATE,
		);
		expect(lostTrickle.valid).toBe(true);
		expect(lostTrickle.gate).toBe("MISS");
		expect(lostTrickle.clauses.S5_sessionsLost?.pass).toBe(false);
	}, 15_000);

	test("send errors beyond the lost-session explanation refuse; explained ones grade", () => {
		const base = cleanOver(5000);
		const unexplained = gradeRung(
			5000,
			scanFixture({ ...base, sendErrors: 4 }),
			CANDIDATE,
		);
		expect(unexplained.valid).toBe(false);
		expect(
			unexplained.invalidReasons.some((reason) =>
				reason.includes("unexplained error mass"),
			),
		).toBe(true);

		const explained = gradeRung(
			5000,
			scanFixture({ ...base, sessionsLost: 2, sendErrors: 6 }),
			CANDIDATE,
		);
		expect(explained.valid).toBe(true);
	}, 15_000);

	test("steeredTotal sums per-cpu steered and refuses unusable dumps", () => {
		const dump = JSON.stringify([
			{
				key: 0,
				values: [
					{ cpu: 0, value: 100 },
					{ cpu: 1, value: 900 },
				],
			},
			{ key: 1, values: [{ cpu: 0, value: 5 }] },
		]);
		expect(steeredTotal(dump)).toBe(1000);
		expect(typeof steeredTotal("not json")).toBe("string");
	}, 15_000);

	test("steeredTotal decodes the BTF-less hex byte-array dump shape", () => {
		// The registered rig's actual format: little-endian hex byte arrays
		// (0x134859 = 1,263,705 on cpu 1, zero elsewhere).
		const dump = JSON.stringify([
			{
				key: ["0x00", "0x00", "0x00", "0x00"],
				values: [
					{
						cpu: 0,
						value: [
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
						],
					},
					{
						cpu: 1,
						value: [
							"0x59",
							"0x48",
							"0x13",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
						],
					},
				],
			},
			{
				key: ["0x01", "0x00", "0x00", "0x00"],
				values: [
					{
						cpu: 1,
						value: [
							"0x05",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
						],
					},
				],
			},
		]);
		expect(steeredTotal(dump)).toBe(0x134859);
		expect(typeof steeredTotal('[{"key":[true],"values":[]}]')).toBe("string");
	}, 15_000);

	test("rejects a connect-end T2-sized steering dump and accepts the true post-run dump", () => {
		const connectEnd = gradeRung(5000, scanFixture(cleanOver(5000)), CANDIDATE);
		const postRun = gradeRung(5000, scanFixture(cleanOver(5000)), CANDIDATE);
		const dump = (steered: number) =>
			JSON.stringify([
				{ key: 0, values: [{ cpu: 0, value: steered }] },
				{ key: 1, values: [{ cpu: 0, value: 0 }] },
			]);

		const connectEndResult = applySteeringValidity(
			[connectEnd],
			[dump(Math.floor(connectEnd.steadySent * 0.026))],
		);
		const postRunResult = applySteeringValidity(
			[postRun],
			[dump(Math.ceil(postRun.steadySent * 0.95))],
		);

		expect(connectEnd.valid).toBe(false);
		expect(connectEnd.gate).toBeNull();
		expect(connectEnd.invalidReasons).toContainEqual(
			expect.stringContaining("below floor"),
		);
		expect(connectEndResult.steeredDeltas).toEqual([
			Math.floor(connectEnd.steadySent * 0.026),
		]);
		expect(postRun.valid).toBe(true);
		expect(postRun.gate).toBe("PASS");
		expect(postRunResult.steeredDeltas).toEqual([
			Math.ceil(postRun.steadySent * 0.95),
		]);
	}, 15_000);
});
