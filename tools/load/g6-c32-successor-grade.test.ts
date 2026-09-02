import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	cleanScan,
	steeringDump,
	TEST_CANDIDATE,
	TEST_REGISTRATION,
} from "./g6-c32-evaluator-fixture.test-helper.ts";
import { gradeSuccessorRung } from "./g6-c32-successor-grade.ts";
import { gradeRung } from "./g6-sharded-grade.ts";

const shape = {
	shards: 16,
	endpoints: 512,
	connectConcurrency: 50,
	connectRatePerSec: 250,
	fixedSourcePortBase: 40_000,
	ackReflector: "js" as const,
	serverWorkers: 2,
};

describe("g6-c32-successor-grade", () => {
	test("fails closed when the scan's serverWorkers differs from the registered profile", () => {
		const scan = cleanScan(5_000, shape);
		scan.config.serverWorkers = 3;
		const decision = gradeSuccessorRung({
			rung: 5_000,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: shape,
		});
		expect(decision.valid).toBe(false);
		expect(decision.invalidReasons).toContain(
			"scan serverWorkers differs from registered profile",
		);
	}, 15_000);

	test("treats a scan without serverWorkers as the default 2", () => {
		const scan = cleanScan(5_000, shape);
		expect(scan.config.serverWorkers).toBeUndefined();
		const decision = gradeSuccessorRung({
			rung: 5_000,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: { ...shape, serverWorkers: 3 },
		});
		expect(decision.invalidReasons).toContain(
			"scan serverWorkers differs from registered profile",
		);
	}, 15_000);

	test("fails closed when the scan's ackReflector differs from the registered profile", () => {
		const scan = cleanScan(5_000, shape);
		scan.config.ackReflector = "native";
		const decision = gradeSuccessorRung({
			rung: 5_000,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: shape,
		});
		expect(decision.valid).toBe(false);
		expect(decision.invalidReasons).toContain(
			"scan ackReflector differs from registered profile",
		);
	}, 15_000);

	test("treats a scan without ackReflector as js", () => {
		const scan = cleanScan(5_000, shape);
		expect(scan.config.ackReflector).toBeUndefined();
		const decision = gradeSuccessorRung({
			rung: 5_000,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: shape,
		});
		expect(decision.invalidReasons).toEqual([]);
		expect(decision.valid).toBe(true);
	}, 15_000);

	test("historical grade refuses 512 endpoints while successor accepts the exact profile", () => {
		const scan = cleanScan(5_000, shape);
		expect(gradeRung(5_000, scan, TEST_CANDIDATE).valid).toBe(false);
		const decision = gradeSuccessorRung({
			rung: 5_000,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: shape,
		});
		expect(decision.schema).toBe("g6-c32-successor-grade/1");
		expect(decision.valid).toBe(true);
		expect(decision.gate).toBe("PASS");
		expect(decision.profileLabel).toBe("successor-g6");
	}, 15_000);

	test("wrong registration, connect shape, or endpoint attestation fails closed", () => {
		const scan = cleanScan(5_000, shape);
		const report = JSON.parse(
			scan.clientStdout.slice(scan.clientStdout.indexOf("{")),
		);
		report.preRegistration.sha256 = "c".repeat(64);
		report.connectConcurrency = 500;
		report.client.endpointSourceAddresses.pop();
		scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
		const decision = gradeSuccessorRung({
			rung: 5_000,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: shape,
		});
		expect(decision.valid).toBe(false);
		expect(decision.gate).toBe(null);
		expect(decision.invalidReasons.join("\n")).toContain("registration");
		expect(decision.invalidReasons.join("\n")).toContain("connectConcurrency");
		expect(decision.invalidReasons.join("\n")).toContain("source addresses");
	}, 15_000);

	test("connect-end-sized steering cannot substitute for post-run coverage", () => {
		const decision = gradeSuccessorRung({
			rung: 5_000,
			scan: cleanScan(5_000, shape),
			postRunSteeringText: steeringDump(100),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: shape,
		});
		expect(decision.valid).toBe(false);
		expect(decision.invalidReasons.join("\n")).toContain("steered delta");
	}, 15_000);

	test("a 24-shard ladder rung grades against its own registered shard count", () => {
		const profile = { ...shape, shards: 24 };
		const scan = cleanScan(4_800, shape, 24);
		const decision = gradeSuccessorRung({
			rung: 4_800,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile,
		});
		expect(decision.invalidReasons).toEqual([]);
		expect(decision.valid).toBe(true);
		expect(decision.gate).toBe("PASS");
		expect(decision.profile.shards).toBe(24);
		const mismatched = gradeSuccessorRung({
			rung: 4_800,
			scan,
			postRunSteeringText: steeringDump(3_000_000),
			expectCandidate: TEST_CANDIDATE,
			registrationSha256: TEST_REGISTRATION,
			profile: shape,
		});
		expect(mismatched.valid).toBe(false);
		expect(mismatched.invalidReasons).toContain("shards 24 != 16");
	}, 15_000);

	test("CLI refuses to grade a ladder rung without an explicit shard count", () => {
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				join(import.meta.dir, "g6-c32-successor-grade.ts"),
				"--expected-fixed-source-port-base",
				"40000",
				"--expected-endpoints",
				"512",
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("--expected-shards is required");
	}, 15_000);

	test("CLI rejects trailing garbage in the frozen fixed-port base", () => {
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				join(import.meta.dir, "g6-c32-successor-grade.ts"),
				"--expected-fixed-source-port-base",
				"40000junk",
				"--expected-endpoints",
				"128",
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"expected-fixed-source-port-base must be none or an integer",
		);
	}, 15_000);
});
