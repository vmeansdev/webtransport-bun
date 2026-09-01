import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	evaluateSessionScaleCell,
	evaluateSuccessorRung,
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
		rigCleanPass: drops === 0,
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

const testTempBase = join(import.meta.dir, "../../.scratch/runtime-tmp/tests");

function tempDir(label: string): string {
	mkdirSync(testTempBase, { recursive: true });
	return mkdtempSync(join(testTempBase, `${label}-`));
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runEvaluator(args: string[]): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [
			process.execPath,
			join(import.meta.dir, "g6-c32-rca-evaluate.ts"),
			...args,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("g6-c32-rca-evaluate", () => {
	test("RCA-only quality reuses S1-S5 but accepts the exact 512 endpoint cell", () => {
		const decision = evaluateRcaQuality({
			rung: 5_000,
			scan: cleanScan(5_000, hashShape),
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			expectedShards: 16,
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
			expectedShards: 16,
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
		expect(decision.ingressCleanPass).toBe(false);
		expect(decision.hostSocketDropEquality).toBe(true);
		expect(decision.postConnectServerRcvbufErrors).toBe(0);
	});

	test("cell evaluates a 24-shard rig against its own expected shard count", () => {
		const decision = evaluateCell({
			cell: "L5000-1",
			gradeMode: "rca-only",
			expectedShards: 24,
			qualityRequest: {
				rung: 5_000,
				scan: cleanScan(5_000, baseline, 24),
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
				drops: 0,
				steered: 3_000_000,
				shards: 24,
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
		expect(decision.reasons).toEqual([]);
		expect(decision.complete).toBe(true);
		expect(decision.functionalPass).toBe(true);
		expect(decision.rigCleanPass).toBe(true);
		expect(decision.maxFallbackSessionExcessPerShard).toBe(0);
	});

	test("cell fails closed when the rig shard count differs from the expected one", () => {
		const decision = evaluateCell({
			cell: "L5000-1",
			gradeMode: "rca-only",
			expectedShards: 16,
			qualityRequest: {
				rung: 5_000,
				scan: cleanScan(5_000, baseline, 24),
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
				drops: 0,
				steered: 3_000_000,
				shards: 24,
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
		expect(decision.complete).toBe(false);
		expect(decision.reasons).toContain(
			"scan shard count differs from the expected shard count",
		);
		expect(decision.reasons).toContain(
			"diagnostic shards differs from registered cell",
		);
		expect(decision.reasons).toContain("16-process lifecycle is not clean");
	});

	test("drain-phase send-buffer errors fail rig-clean but keep ingress clean", () => {
		const scan = cleanScan(5_000, baseline);
		const decision = evaluateCell({
			cell: "L5000-1",
			gradeMode: "historical",
			expectedShards: 16,
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
				drops: 0,
				steered: 3_000_000,
				sndbufErrors: 5,
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
		expect(decision.ingressCleanPass).toBe(true);
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
			expectedShards: 16,
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
		expect(decision.schema).toBe("g6-c32-probe-non-interference/3");
		expect(decision.status).toBe("CONTAMINATING");
		expect(decision.reasons.join("\n")).toContain("classification");
		expect(decision.allowedShiftPct).toBe(5);
	});

	test("probe wall gate keeps the configured 5% maximum despite off-off drift", () => {
		const sealedClockBias = evaluateProbeNonInterference([
			cell("P1-off", 18, { connectWallSec: 0.76 }),
			cell("P1-on", 28, { connectWallSec: 0.742 }),
			cell("P2-off", 27, { connectWallSec: 0.713 }),
			cell("P2-on", 22, { connectWallSec: 0.814 }),
		]);
		expect(sealedClockBias.status).toBe("CONTAMINATING");
		expect(sealedClockBias.offOffShiftPct).toBeCloseTo(
			((0.76 - 0.713) / 0.713) * 100,
		);
		expect(sealedClockBias.maxShiftPct).toBe(5);
		expect(sealedClockBias.allowedShiftPct).toBe(5);
		expect(sealedClockBias.reasons.join("\n")).toContain(
			"probe pair 2 connect wall",
		);

		const withinNoise = evaluateProbeNonInterference([
			cell("P1-off", 18, { connectWallSec: 0.76 }),
			cell("P1-on", 28, { connectWallSec: 0.742 }),
			cell("P2-off", 27, { connectWallSec: 0.713 }),
			cell("P2-on", 22, { connectWallSec: 0.75 }),
		]);
		expect(withinNoise.status).toBe("CONTAMINATING");
		expect(withinNoise.allowedShiftPct).toBe(5);
		expect(withinNoise.reasons.join("\n")).toContain(
			"probe pair 2 connect wall",
		);

		const underCeiling = evaluateProbeNonInterference([
			cell("P1-off", 18, { connectWallSec: 0.76 }),
			cell("P1-on", 28, { connectWallSec: 0.742 }),
			cell("P2-off", 27, { connectWallSec: 0.713 }),
			cell("P2-on", 22, { connectWallSec: 0.747 }),
		]);
		expect(underCeiling.offOffShiftPct).toBeGreaterThan(5);
		expect(underCeiling.status).toBe("PASS");
		expect(underCeiling.reasons).toEqual([]);

		const ceilingBinds = evaluateProbeNonInterference([
			cell("P1-off", 10, { connectWallSec: 1 }),
			cell("P1-on", 10, { connectWallSec: 1.06 }),
			cell("P2-off", 10, { connectWallSec: 1.001 }),
			cell("P2-on", 10, { connectWallSec: 1.002 }),
		]);
		expect(ceilingBinds.status).toBe("CONTAMINATING");
		expect(ceilingBinds.allowedShiftPct).toBe(5);
		expect(ceilingBinds.reasons.join("\n")).toContain(
			"probe pair 1 connect wall",
		);
	});

	test("probe comparison resolves ABBA order by cell label", () => {
		const decision = evaluateProbeNonInterference(
			[
				cell("P1-off", 10, { connectWallSec: 1 }),
				cell("P1-on", 10, { connectWallSec: 1.01 }),
				cell("P2-on", 10, { connectWallSec: 1.01 }),
				cell("P2-off", 10, { connectWallSec: 1 }),
			],
			5,
			["P1-off", "P1-on", "P2-on", "P2-off"],
		);
		expect(decision.status).toBe("PASS");
		if (decision.pairShiftsPct === null) throw new Error("missing pair shifts");
		expect(decision.pairShiftsPct[0]).toBeCloseTo(1);
		expect(decision.pairShiftsPct[1]).toBeCloseTo(1);
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

		const underOffered = evaluateTransfer([
			cell("A296-1", 10),
			cell("W296-1", 0),
			cell("A296-2", 0),
			cell("W296-2", 0, { steadySent: 999_999 }),
			cell("A296-3", 12),
			cell("W296-3", 0),
			cell("A296-reversal", 11),
		]);
		expect(underOffered.terminal).toBe("RCA_UNRESOLVED");
		expect(underOffered.transferPass).toBe(false);
		expect(underOffered.reasons).toContain(
			"steady offered workload changed during transfer",
		);
	});

	test("transfer CLI exits nonzero when causality is unresolved", () => {
		const root = tempDir("g6-rca-transfer-unresolved");
		try {
			for (const label of [
				"A296-1",
				"W296-1",
				"A296-2",
				"W296-2",
				"A296-3",
				"W296-3",
				"A296-reversal",
			]) {
				const dir = join(root, label);
				mkdirSync(dir, { recursive: true });
				writeJson(join(dir, "rca.json"), cell(label, 0));
			}
			const out = join(root, "decision.json");
			const result = runEvaluator([
				"--mode",
				"transfer",
				"--root",
				root,
				"--out",
				out,
			]);
			expect(result.exitCode).toBe(3);
			const decision = JSON.parse(readFileSync(out, "utf8"));
			expect(decision.terminal).toBe("RCA_UNRESOLVED");
			expect(decision.transferPass).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("missing or malformed cell evidence is incomplete, never unresolved", () => {
		const decision = evaluateMatrix([cell("A1", 100)]);
		expect(decision.terminal).toBe("INCOMPLETE");
	});

	test("missing or zero wall time and host/socket equality fail closed", () => {
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
		const zeroWall = [
			cell("P1-off", 1, { connectWallSec: 0 }),
			cell("P1-on", 1),
			cell("P2-off", 1),
			cell("P2-on", 1),
		];
		const zeroWallDecision = evaluateProbeNonInterference(zeroWall);
		expect(zeroWallDecision.status).toBe("INCOMPLETE");
		expect(zeroWallDecision.offOffShiftPct).toBeNull();
		expect(zeroWallDecision.pairShiftsPct).toBeNull();
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

	test("cell CLI refuses to grade without an explicit shard count", () => {
		const missing = runEvaluator([
			"--mode",
			"cell",
			"--grade-mode",
			"rca-only",
			"--expected-endpoints",
			"128",
		]);
		expect(missing.exitCode).not.toBe(0);
		expect(String(missing.stderr ?? "")).toContain(
			"--expected-shards is required",
		);
		const malformed = runEvaluator([
			"--mode",
			"cell",
			"--grade-mode",
			"rca-only",
			"--expected-shards",
			"0",
			"--expected-endpoints",
			"128",
		]);
		expect(malformed.exitCode).not.toBe(0);
		expect(String(malformed.stderr ?? "")).toContain(
			"--expected-shards is out of range",
		);
	});

	test("ladder mode replicates only the highest clean rung after the progressive pass", () => {
		const root = tempDir("g6-rca-ladder");
		try {
			for (const [label, rung, status] of [
				["L5000-1", 5_000, "CLEAN"],
				["L10000-1", 10_000, "CLEAN"],
				["L10000-2", 10_000, "CLEAN"],
				["L20000-1", 20_000, "UNCLEAN"],
			] as const) {
				const dir = join(root, label);
				mkdirSync(dir, { recursive: true });
				writeJson(join(dir, "decision.json"), {
					schema: "g6-c32-successor-rung/1",
					label,
					rung,
					status,
				});
			}
			const out = join(root, "ladder.json");
			const result = runEvaluator([
				"--mode",
				"ladder",
				"--root",
				root,
				"--out",
				out,
			]);
			expect(result.exitCode).toBe(0);
			const decision = JSON.parse(readFileSync(out, "utf8"));
			expect(decision.status).toBe("COMPLETE");
			expect(decision.highestReplicatedCleanRung).toBe(10_000);
			expect(decision.firstUncleanRung).toBe(20_000);
			expect(decision.fullRateWorksAbove5k).toBe(true);
			expect(decision.companionRequired).toBe(true);

			const extraReplicate = join(root, "L5000-2");
			mkdirSync(extraReplicate, { recursive: true });
			writeJson(join(extraReplicate, "decision.json"), {
				schema: "g6-c32-successor-rung/1",
				label: "L5000-2",
				rung: 5_000,
				status: "CLEAN",
			});
			const overCollected = runEvaluator([
				"--mode",
				"ladder",
				"--root",
				root,
				"--out",
				out,
			]);
			expect(overCollected.exitCode).toBe(2);
			expect(JSON.parse(readFileSync(out, "utf8")).status).toBe("INCOMPLETE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("successor rung is clean only when RCA, ingress, function, and successor grade all pass", () => {
		expect(
			evaluateSuccessorRung({
				label: "L10000-1",
				rung: 10_000,
				rca: {
					schema: "g6-c32-rca-cell/1",
					complete: true,
					functionalPass: true,
					rigCleanPass: true,
					ingressCleanPass: true,
				},
				grade: {
					schema: "g6-c32-successor-grade/1",
					valid: true,
					gate: "PASS",
				},
			}).status,
		).toBe("CLEAN");
		expect(
			evaluateSuccessorRung({
				label: "L5000-1",
				rung: 5_000,
				rca: {
					schema: "g6-c32-rca-cell/1",
					complete: true,
					functionalPass: true,
					rigCleanPass: false,
					ingressCleanPass: true,
				},
				grade: {
					schema: "g6-c32-successor-grade/1",
					valid: true,
					gate: "PASS",
				},
			}).status,
		).toBe("CLEAN");
		expect(
			evaluateSuccessorRung({
				label: "L20000-1",
				rung: 20_000,
				rca: {
					schema: "g6-c32-rca-cell/1",
					complete: true,
					functionalPass: true,
					rigCleanPass: false,
					ingressCleanPass: false,
				},
				grade: {
					schema: "g6-c32-successor-grade/1",
					valid: true,
					gate: "PASS",
				},
			}).status,
		).toBe("UNCLEAN");
		expect(
			evaluateSuccessorRung({
				label: "L30000-1",
				rung: 30_000,
				rca: {
					schema: "g6-c32-rca-cell/1",
					complete: true,
					functionalPass: true,
					rigCleanPass: true,
				},
				grade: {
					schema: "g6-c32-successor-grade/1",
					valid: true,
					gate: "PASS",
				},
			}).status,
		).toBe("UNCLEAN");
	});

	test("companion cell proves passive sessions separately from active workload demand", () => {
		const requested = 20_000;
		const active = 10_000;
		const scan = cleanScan(requested, baseline) as ReturnType<
			typeof cleanScan
		> & {
			config: { activeWorkloadSessions: number };
			aggregate: {
				steady: { rxTotal: number };
				steadyDrain: { emitter: { snapshotIssued: number } };
				lifetime: { rxByClass: { raidJoin: number } };
			};
		};
		const report = JSON.parse(
			scan.clientStdout.slice("mmo-client: json ".length),
		);
		const sent = active * 4 * 120;
		const issued = active * 15 * 120;
		report.activeWorkloadSessions = active;
		report.windows.steady.sent = sent;
		report.windows.steadyDrain.rxSnapshot = issued;
		scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
		scan.config.activeWorkloadSessions = active;
		scan.aggregate.steady.rxTotal = sent;
		scan.aggregate.steadyDrain.emitter.snapshotIssued = issued;
		scan.aggregate.lifetime = { rxByClass: { raidJoin: requested - active } };
		for (const [index, shard] of scan.shards.entries()) {
			const companionShard = shard as typeof shard & {
				sessionsByKindAtSteady: {
					player: number;
					raid: number;
					publisher: number;
				};
			};
			companionShard.sessionsByKindAtSteady = {
				player: Math.floor(active / 16) + (index < active % 16 ? 1 : 0),
				raid:
					Math.floor((requested - active) / 16) +
					(index < (requested - active) % 16 ? 1 : 0),
				publisher: 0,
			};
		}
		const evidence = evaluateSessionScaleCell({
			label: "C1",
			scan,
			expectedShards: 16,
			diagnostic: diagnosticFixture({
				sessions: requested,
				shape: baseline,
				drops: 0,
				steered: sent,
			}),
			expectCandidate: TEST_CANDIDATE,
			expectedRequestedSessions: requested,
			expectedActiveWorkloadSessions: active,
		});
		expect(evidence.complete).toBe(true);
		expect(evidence.passiveJoinCount).toBe(requested - active);
		expect(evidence.ingestRatio).toBe(1);
		expect(evidence.deliveryRatio).toBe(1);
		expect(evidence.dutyRatio).toBe(1);

		const firstShard = scan.shards[0] as (typeof scan.shards)[number] & {
			sessionsByKindAtSteady: {
				player: number;
				raid: number;
				publisher: number;
			};
		};
		firstShard.sessionsByKindAtSteady.player += 1;
		firstShard.sessionsByKindAtSteady.raid -= 1;
		const contaminated = evaluateSessionScaleCell({
			label: "C1",
			scan,
			expectedShards: 16,
			diagnostic: diagnosticFixture({
				sessions: requested,
				shape: baseline,
				drops: 0,
				steered: sent,
			}),
			expectCandidate: TEST_CANDIDATE,
			expectedRequestedSessions: requested,
			expectedActiveWorkloadSessions: active,
		});
		expect(contaminated.complete).toBe(false);
		expect(contaminated.reasons).toContain(
			"steady session-kind classification differs from companion cell",
		);
	});

	test("companion mode reports session scale only from two complete clean 0.995 replicates", () => {
		const root = tempDir("g6-rca-companion");
		try {
			const out = join(root, "decision.json");
			for (const label of ["C1", "C2"]) {
				const dir = join(root, label);
				mkdirSync(dir, { recursive: true });
				writeJson(join(dir, "summary.json"), {
					schema: "g6-c32-session-scale-evidence/1",
					label,
					complete: true,
					reasons: [],
					requestedSessions: 20_000,
					activeWorkloadSessions: 10_000,
					sessionsOk: 20_000,
					sessionsErr: 0,
					steadySessionsLost: 0,
					lifecycleClean: true,
					hostClean: true,
					passiveJoinCount: 10_000,
					ingestRatio: 0.999,
					deliveryRatio: 0.998,
					dutyRatio: 0.997,
				});
			}
			const result = runEvaluator([
				"--mode",
				"companion",
				"--root",
				root,
				"--out",
				out,
			]);
			expect(result.exitCode).toBe(0);
			const decision = JSON.parse(readFileSync(out, "utf8"));
			expect(decision.status).toBe("SESSION_SCALE_PASS");

			rmSync(join(root, "C2"), { recursive: true, force: true });
			const incomplete = runEvaluator([
				"--mode",
				"companion",
				"--root",
				root,
				"--out",
				out,
			]);
			expect(incomplete.exitCode).toBe(2);
			expect(JSON.parse(readFileSync(out, "utf8")).status).toBe("INCOMPLETE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("preflight mode rejects a zero-status receipt whose observed freeze differs", () => {
		const root = tempDir("g6-rca-preflight");
		try {
			for (const name of [
				"doctl-server",
				"doctl-generator",
				"server-head",
				"generator-head",
				"server-linux-probe",
				"generator-linux-probe",
				"private-path-sink-bpf",
				"copy-server",
				"copy-generator",
			])
				writeFileSync(join(root, `${name}.status`), "0\n");
			const identity = join(root, "identity.json");
			writeJson(identity, {
				schema: "g6-c32-frozen-preflight/1",
				expected: { server: { bootId: "expected" } },
				observed: { server: { bootId: "different" } },
				qualification: {
					privatePathPass: true,
					sinkPass: true,
					loadedLegPass: true,
					bpfPass: true,
				},
			});
			const out = join(root, "decision.json");
			const result = runEvaluator([
				"--mode",
				"preflight",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--root",
				root,
				"--identity",
				identity,
				"--out",
				out,
			]);
			expect(result.exitCode).toBe(2);
			const decision = JSON.parse(readFileSync(out, "utf8"));
			expect(decision.status).toBe("INCOMPLETE");
			expect(decision.reasons.join("\n")).toContain("server.bootId");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("finalize carries ladder and companion dimensions into closeout", () => {
		const root = tempDir("g6-rca-finalize");
		try {
			for (const dir of [
				"transfer",
				"matrix",
				"ladder",
				"companion",
				"closeout",
			])
				mkdirSync(join(root, dir), { recursive: true });
			writeJson(join(root, "transfer/decision.json"), {
				schema: "g6-c32-rca-transfer/1",
				terminal: "RCA_CONFIRMED",
				transferPass: true,
			});
			writeJson(join(root, "ladder/decision.json"), {
				schema: "g6-c32-successor-ladder/1",
				status: "COMPLETE",
				highestReplicatedCleanRung: 10_000,
				firstUncleanRung: 20_000,
				fullRateWorksAbove5k: true,
				companionRequired: true,
			});
			writeJson(join(root, "companion/decision.json"), {
				schema: "g6-c32-session-scale/1",
				status: "SESSION_SCALE_PASS",
			});
			const out = join(root, "closeout/final.json");
			const statusOut = join(root, "closeout/RUN_STATUS.next");
			const result = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"post-fix-only",
				"--out",
				out,
				"--status-out",
				statusOut,
			]);
			expect(result.exitCode).toBe(0);
			const decision = JSON.parse(readFileSync(out, "utf8"));
			expect(decision.terminal).toBe("RCA_CONFIRMED");
			expect(decision.fullRateWorksAbove5k).toBe(true);
			expect(decision.sessionScalePass).toBe(true);

			rmSync(join(root, "companion/decision.json"));
			const missingCompanion = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"post-fix-only",
				"--out",
				out,
				"--status-out",
				statusOut,
			]);
			expect(missingCompanion.exitCode).toBe(2);
			expect(JSON.parse(readFileSync(out, "utf8")).terminal).toBe("INCOMPLETE");

			rmSync(join(root, "ladder/decision.json"));
			const missingLadder = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"post-fix-only",
				"--out",
				out,
				"--status-out",
				statusOut,
			]);
			expect(missingLadder.exitCode).toBe(2);
			expect(JSON.parse(readFileSync(out, "utf8")).terminal).toBe("INCOMPLETE");

			const rcaOnly = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"rca-only",
				"--out",
				out,
				"--status-out",
				statusOut,
			]);
			expect(rcaOnly.exitCode).toBe(0);
			expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
				lifecycle: "rca-only",
				terminal: "RCA_CONFIRMED",
				ladder: null,
				companion: null,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("finalize renders a ladder-only capacity terminal without transfer evidence", () => {
		const root = tempDir("g6-rca-finalize-ladder-only");
		try {
			for (const dir of ["ladder", "companion", "closeout"])
				mkdirSync(join(root, dir), { recursive: true });
			writeJson(join(root, "ladder/decision.json"), {
				schema: "g6-c32-successor-ladder/1",
				status: "COMPLETE",
				highestReplicatedCleanRung: 20_000,
				firstUncleanRung: 30_000,
				fullRateWorksAbove5k: true,
				companionRequired: true,
			});
			writeJson(join(root, "companion/decision.json"), {
				schema: "g6-c32-session-scale/1",
				status: "SESSION_SCALE_PASS",
			});
			const out = join(root, "closeout/final.json");
			const statusOut = join(root, "closeout/RUN_STATUS.next");
			const result = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"ladder-only",
				"--out",
				out,
				"--status-out",
				statusOut,
			]);
			expect(result.exitCode).toBe(0);
			const decision = JSON.parse(readFileSync(out, "utf8"));
			expect(decision.terminal).toBe("LADDER_COMPLETE");
			expect(decision.transfer).toBe(null);
			expect(decision.fullRateWorksAbove5k).toBe(true);
			expect(decision.sessionScalePass).toBe(true);
			expect(readFileSync(statusOut, "utf8")).toBe("LADDER_COMPLETE\n");

			rmSync(join(root, "ladder/decision.json"));
			const missingLadder = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"ladder-only",
				"--out",
				join(root, "closeout/final-missing.json"),
				"--status-out",
				join(root, "closeout/RUN_STATUS.missing"),
			]);
			expect(missingLadder.exitCode).toBe(2);
			const incomplete = JSON.parse(
				readFileSync(join(root, "closeout/final-missing.json"), "utf8"),
			);
			expect(incomplete.terminal).toBe("INCOMPLETE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("finalize preserves reportable unresolved transfer without a ladder", () => {
		const root = tempDir("g6-rca-finalize-unresolved");
		try {
			for (const dir of ["transfer", "closeout"])
				mkdirSync(join(root, dir), { recursive: true });
			writeJson(join(root, "transfer/decision.json"), {
				schema: "g6-c32-rca-transfer/1",
				terminal: "RCA_UNRESOLVED",
				transferPass: false,
			});
			const out = join(root, "closeout/final.json");
			const statusOut = join(root, "closeout/RUN_STATUS.next");
			const result = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"rca-only",
				"--out",
				out,
				"--status-out",
				statusOut,
			]);
			expect(result.exitCode).toBe(0);
			const decision = JSON.parse(readFileSync(out, "utf8"));
			expect(decision.terminal).toBe("RCA_UNRESOLVED");
			expect(decision.ladder).toBeNull();
			expect(decision.companion).toBeNull();
			expect(decision.fullRateWorksAbove5k).toBe(false);
			expect(decision.sessionScalePass).toBe(false);
			expect(readFileSync(statusOut, "utf8")).toBe("RCA_UNRESOLVED\n");

			writeJson(join(root, "transfer/decision.json"), {
				schema: "wrong-transfer-schema",
				terminal: "RCA_UNRESOLVED",
				transferPass: false,
			});
			const malformed = runEvaluator([
				"--mode",
				"finalize",
				"--registration-sha256",
				TEST_REGISTRATION,
				"--run-root",
				root,
				"--lifecycle",
				"rca-only",
				"--out",
				out,
				"--status-out",
				statusOut,
			]);
			expect(malformed.exitCode).toBe(2);
			expect(JSON.parse(readFileSync(out, "utf8")).terminal).toBe("INCOMPLETE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
