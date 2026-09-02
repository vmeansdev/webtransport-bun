import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCapacityRung } from "./g6-c32-capacity-evaluate.ts";

const counters = (errors = 0) => ({
	connect: { InErrors: 0, RcvbufErrors: 0, SndbufErrors: 0 },
	steady: { InErrors: 0, RcvbufErrors: 0, SndbufErrors: 0 },
	drain: { InErrors: errors, RcvbufErrors: errors, SndbufErrors: 0 },
	idle: { InErrors: errors, RcvbufErrors: errors, SndbufErrors: 0 },
});

const cleanLifecycle = Array.from({ length: 16 }, (_, index) => ({
	serverId: index + 1,
	boundaries: ["connect", "steady", "drain", "idle", "stop"].map((phase) => ({
		phase,
	})),
	exits: [{ code: 0, signal: null }],
}));

const input = () => ({
	rung: 5000,
	producerStatus: 0,
	copyStatus: 0,
	extractMmoStatus: 0,
	extractSteerStatus: 0,
	gradeStatus: 0,
	grade: { rungs: [{ valid: true, gate: "PASS" }] },
	scan: { clientExit: 0 },
	diagnostic: {
		serverHostUdp: counters(),
		bpfPreArm: {
			fresh: true,
			socksEntries: 16,
			receiptValidation: { valid: true, instances: 16 },
			steerStats: { steered: 0, fallback: 0 },
		},
		perShardLifecycle: cleanLifecycle,
	},
	report: {
		sessionsErr: 0,
		hostUdp: counters(),
		windows: { steady: { sessionsLost: 0 } },
	},
});

test("classifies a fully valid zero-error rung as CLEAN", () => {
	const result = evaluateCapacityRung(input());
	expect(result.status).toBe("CLEAN");
	expect(result.lifecycleClean).toBe(true);
}, 15_000);

test("classifies positive generator UDP receive-buffer errors as UNCLEAN_OVERFLOW", () => {
	const candidate = input();
	candidate.report.hostUdp = counters(1);
	expect(evaluateCapacityRung(candidate).status).toBe("UNCLEAN_OVERFLOW");
}, 15_000);

test("refuses a grade that is valid but not PASS as UNCLEAN_QUALITY", () => {
	const candidate = input();
	candidate.grade.rungs[0]!.gate = "MISS";
	expect(evaluateCapacityRung(candidate).status).toBe("UNCLEAN_QUALITY");
}, 15_000);

test("refuses a sampled-only connection success claim through sessionsErr", () => {
	const candidate = input();
	candidate.report.sessionsErr = 1;
	expect(evaluateCapacityRung(candidate).status).toBe("UNCLEAN_QUALITY");
}, 15_000);

test("stops as INCOMPLETE when lifecycle evidence is missing", () => {
	const candidate = input();
	candidate.diagnostic.perShardLifecycle = [];
	expect(evaluateCapacityRung(candidate).status).toBe("INCOMPLETE");
}, 15_000);

test("stops as INCOMPLETE when the remote rung copy failed", () => {
	const candidate = input();
	candidate.copyStatus = 1;
	expect(evaluateCapacityRung(candidate).status).toBe("INCOMPLETE");
}, 15_000);

test("classifies a complete lifecycle with a wrong server ID as UNCLEAN_QUALITY", () => {
	const candidate = input();
	candidate.diagnostic.perShardLifecycle[0]!.serverId = 0;
	expect(evaluateCapacityRung(candidate).status).toBe("UNCLEAN_QUALITY");
}, 15_000);

test("writes an INCOMPLETE decision when an input artifact is malformed", () => {
	const dir = mkdtempSync(join(tmpdir(), "g6-capacity-evaluate-"));
	try {
		const scan = join(dir, "scan.json");
		const diagnostic = join(dir, "diagnostic.json");
		const report = join(dir, "report.json");
		const grade = join(dir, "grade.json");
		const out = join(dir, "decision.json");
		writeFileSync(scan, "{ malformed");
		writeFileSync(diagnostic, JSON.stringify(input().diagnostic));
		writeFileSync(report, JSON.stringify(input().report));
		writeFileSync(grade, JSON.stringify(input().grade));
		const result = Bun.spawnSync([
			process.execPath,
			"tools/load/g6-c32-capacity-evaluate.ts",
			"--rung",
			"5000",
			"--producer-status",
			"0",
			"--copy-status",
			"0",
			"--extract-mmo-status",
			"0",
			"--extract-steer-status",
			"0",
			"--grade-status",
			"0",
			"--scan",
			scan,
			"--diagnostic",
			diagnostic,
			"--report",
			report,
			"--grade",
			grade,
			"--out",
			out,
		]);
		expect(result.exitCode).toBe(0);
		const decision = JSON.parse(readFileSync(out, "utf8"));
		expect(decision.status).toBe("INCOMPLETE");
		expect(decision.reasons).toContain("scan artifact is malformed");
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}, 15_000);

test("writes an INCOMPLETE decision when an input artifact is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "g6-capacity-evaluate-"));
	try {
		const scan = join(dir, "scan.json");
		const diagnostic = join(dir, "diagnostic.json");
		const report = join(dir, "missing-report.json");
		const grade = join(dir, "grade.json");
		const out = join(dir, "decision.json");
		writeFileSync(scan, JSON.stringify(input().scan));
		writeFileSync(diagnostic, JSON.stringify(input().diagnostic));
		writeFileSync(grade, JSON.stringify(input().grade));
		const result = Bun.spawnSync([
			process.execPath,
			"tools/load/g6-c32-capacity-evaluate.ts",
			"--rung",
			"5000",
			"--producer-status",
			"0",
			"--copy-status",
			"0",
			"--extract-mmo-status",
			"0",
			"--extract-steer-status",
			"0",
			"--grade-status",
			"0",
			"--scan",
			scan,
			"--diagnostic",
			diagnostic,
			"--report",
			report,
			"--grade",
			grade,
			"--out",
			out,
		]);
		expect(result.exitCode).toBe(0);
		const decision = JSON.parse(readFileSync(out, "utf8"));
		expect(decision.status).toBe("INCOMPLETE");
		expect(decision.reasons).toContain("report artifact is missing");
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}, 15_000);
