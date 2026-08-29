import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	cleanScan,
	diagnosticFixture,
	steeringDump,
	TEST_CANDIDATE,
	TEST_REGISTRATION,
} from "./g6-c32-evaluator-fixture.test-helper.ts";
import {
	evaluateCell,
	evaluateInteraction,
	evaluateMatrix,
	evaluateProbeNonInterference,
	evaluateRcaQuality,
	evaluateTransfer,
	selectTransferWinner,
} from "./g6-c32-rca-evaluate.ts";

const baseline = {
	endpoints: 128,
	connectConcurrency: 500,
	connectRatePerSec: 0,
	fixedSourcePortBase: 40_000,
};
const hashShape = { ...baseline, endpoints: 512 };

function cell(cell: string, drops: number, over: Record<string, unknown> = {}) {
	return {
		schema: "g6-c32-rca-cell/1" as const,
		cell,
		complete: true,
		functionalPass: true,
		rcaQualityPass: true,
		connectWallSec: 1,
		connectOwnedSocketDrops: drops,
		connectServerRcvbufErrors: drops,
		generatorConnectErrors: 0,
		postConnectServerRcvbufErrors: 0,
		hostSocketDropEquality: true,
		maxFallbackSessionExcessPerShard: cell.startsWith("C") ? 4 : 10,
		peakReceiveQueueBytes: cell.startsWith("B") ? 50 : 100,
		steadySent: 1_000_000,
		...over,
	};
}

describe("g6-c32-rca-evaluate", () => {
	test("RCA-only quality reuses S1-S5 but accepts the exact 512 endpoint cell", () => {
		const decision = evaluateRcaQuality({
			rung: 5_000,
			scan: cleanScan(5_000, hashShape),
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			expectedEndpoints: 512,
			expectedConnectConcurrency: 500,
			expectedConnectRate: 0,
			expectedFixedSourcePortBase: 40_000,
		});
		expect(decision.schema).toBe("g6-c32-rca-quality/1");
		expect(decision.status).toBe("RCA_QUALITY_PASS");
		expect(decision.historicalGrade).toBe(false);
	});

	test("cell reconciles connect host errors with owned sockets and keeps overflow orthogonal", () => {
		const scan = cleanScan(5_000, baseline);
		const decision = evaluateCell({
			cell: "A1",
			gradeMode: "historical",
			qualityRequest: {
				rung: 5_000,
				scan,
				postRunSteeringText: steeringDump(3_000_000),
				expectCandidate: TEST_CANDIDATE,
				registrationSha256: TEST_REGISTRATION,
				expectedEndpoints: 128,
				expectedConnectConcurrency: 500,
				expectedConnectRate: 0,
				expectedFixedSourcePortBase: 40_000,
			},
			diagnostic: diagnosticFixture({
				sessions: 5_000,
				shape: baseline,
				drops: 100,
				steered: 3_000_000,
			}),
			probe: {
				schema: "g6-c32-linux-probe/1",
				complete: true,
				summary: {
					peakReceiveQueueBytes: 1_000,
					effectiveReceiveBufferBytes: 212_992,
					drainStallAligned: false,
				},
			},
			probeRequired: true,
		});
		expect(decision.complete).toBe(true);
		expect(decision.functionalPass).toBe(true);
		expect(decision.rigCleanPass).toBe(false);
		expect(decision.hostSocketDropEquality).toBe(true);
		expect(decision.postConnectServerRcvbufErrors).toBe(0);
	});

	test("hash metric measures hot-shard excess above the irreducible ideal share", () => {
		const scan = cleanScan(5_000, baseline);
		const distribution = [
			314, 352, 507, 352, 156, 235, 273, 429, 274, 274, 156, 430, 117, 273, 585,
			273,
		];
		for (const [index, sessionsAtSteady] of distribution.entries())
			(scan.shards[index] as (typeof scan.shards)[number]).sessionsAtSteady =
				sessionsAtSteady;
		const decision = evaluateCell({
			cell: "A1",
			gradeMode: "historical",
			qualityRequest: {
				rung: 5_000,
				scan,
				postRunSteeringText: steeringDump(3_000_000),
				expectCandidate: TEST_CANDIDATE,
				registrationSha256: TEST_REGISTRATION,
				expectedEndpoints: 128,
				expectedConnectConcurrency: 500,
				expectedConnectRate: 0,
				expectedFixedSourcePortBase: 40_000,
			},
			diagnostic: diagnosticFixture({
				sessions: 5_000,
				shape: baseline,
				drops: 100,
				steered: 3_000_000,
			}),
			probe: {
				schema: "g6-c32-linux-probe/1",
				complete: true,
				summary: {
					peakReceiveQueueBytes: 1_000,
					effectiveReceiveBufferBytes: 212_992,
					drainStallAligned: false,
				},
			},
			probeRequired: true,
		});
		expect(distribution.reduce((sum, value) => sum + value, 0)).toBe(5_000);
		expect(decision.maxFallbackSessionExcessPerShard).toBe(272);
	});

	test("matrix confirms arrival only with three valid clean B replicates and A reversal", () => {
		const runs = [
			cell("A1", 100),
			cell("B1", 0),
			cell("C1", 80),
			cell("D1", 70),
			cell("A2", 120),
			cell("B2", 0),
			cell("C2", 90),
			cell("D2", 80),
			cell("A3", 110),
			cell("B3", 0),
			cell("C3", 85),
			cell("D3", 75),
			cell("A4", 105),
		];
		const decision = evaluateMatrix(runs);
		expect(decision.terminal).toBe("HIGH_LOAD_FACTOR_CONFIRMED");
		expect(decision.confirmedFactors).toEqual(["B"]);
		expect(decision.runInteraction).toBe(false);
	});

	test("winner uses greatest median reduction with B then C then D tie order", () => {
		const winner = selectTransferWinner({
			B: { confirmed: true, reduction: 0.9 },
			C: { confirmed: true, reduction: 0.9 },
			D: { confirmed: false, reduction: 0.95 },
		});
		expect(winner.factor).toBe("B");
	});

	test("probe comparison rejects timing or classification contamination", () => {
		const decision = evaluateProbeNonInterference([
			cell("P1-off", 10, { connectWallSec: 1 }),
			cell("P1-on", 0, { connectWallSec: 1.2 }),
			cell("P2-off", 10, { connectWallSec: 1 }),
			cell("P2-on", 10, { connectWallSec: 1.01 }),
		]);
		expect(decision.status).toBe("CONTAMINATING");
		expect(decision.reasons.join("\n")).toContain("classification");
	});

	test("interaction requires three E wins and three reproduced reversals", () => {
		const decision = evaluateInteraction(
			[
				cell("E1", 5, { hostSocketDropEquality: true }),
				cell("A5", 100, { hostSocketDropEquality: true }),
				cell("E2", 4, { hostSocketDropEquality: true }),
				cell("A6", 110, { hostSocketDropEquality: true }),
				cell("E3", 3, { hostSocketDropEquality: true }),
				cell("A7", 105, { hostSocketDropEquality: true }),
			],
			"B+C",
			[50, 60],
			100,
		);
		expect(decision.terminal).toBe("RCA_INTERACTION");
	});

	test("transfer requires two of three overflowing baselines, reversal, and all winners", () => {
		const decision = evaluateTransfer([
			cell("A296-1", 10),
			cell("W296-1", 0),
			cell("A296-2", 0),
			cell("W296-2", 0),
			cell("A296-3", 12),
			cell("W296-3", 0),
			cell("A296-reversal", 11),
		]);
		expect(decision.terminal).toBe("RCA_CONFIRMED");
		expect(decision.transferPass).toBe(true);
	});

	test("missing or malformed cell evidence is incomplete, never unresolved", () => {
		const decision = evaluateMatrix([cell("A1", 100)]);
		expect(decision.terminal).toBe("INCOMPLETE");
	});

	test("missing wall time or host/socket equality fails closed", () => {
		const labels = [
			"A1",
			"B1",
			"C1",
			"D1",
			"A2",
			"B2",
			"C2",
			"D2",
			"A3",
			"B3",
			"C3",
			"D3",
			"A4",
		];
		const missingEquality = labels.map((label) =>
			cell(label, label.startsWith("A") ? 100 : 0),
		);
		delete (missingEquality[0] as { hostSocketDropEquality?: boolean })
			.hostSocketDropEquality;
		expect(evaluateMatrix(missingEquality).terminal).toBe("INCOMPLETE");
		const missingWall = [
			cell("P1-off", 1),
			cell("P1-on", 1),
			cell("P2-off", 1),
			cell("P2-on", 1),
		];
		delete (missingWall[1] as { connectWallSec?: number }).connectWallSec;
		expect(evaluateProbeNonInterference(missingWall).status).toBe("INCOMPLETE");
	});

	test("probe CLI rejects a malformed contamination threshold before reading artifacts", () => {
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				join(import.meta.dir, "g6-c32-rca-evaluate.ts"),
				"--mode",
				"probe-non-interference",
				"--max-connect-wall-shift-pct",
				"NaN",
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"max-connect-wall-shift-pct must be a finite nonnegative decimal",
		);
	});
});
