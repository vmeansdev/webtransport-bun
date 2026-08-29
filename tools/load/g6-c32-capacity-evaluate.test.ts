import { expect, test } from "bun:test";
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
});

test("classifies positive generator UDP receive-buffer errors as UNCLEAN_OVERFLOW", () => {
	const candidate = input();
	candidate.report.hostUdp = counters(1);
	expect(evaluateCapacityRung(candidate).status).toBe("UNCLEAN_OVERFLOW");
});

test("refuses a grade that is valid but not PASS as UNCLEAN_QUALITY", () => {
	const candidate = input();
	candidate.grade.rungs[0]!.gate = "MISS";
	expect(evaluateCapacityRung(candidate).status).toBe("UNCLEAN_QUALITY");
});

test("refuses a sampled-only connection success claim through sessionsErr", () => {
	const candidate = input();
	candidate.report.sessionsErr = 1;
	expect(evaluateCapacityRung(candidate).status).toBe("UNCLEAN_QUALITY");
});

test("stops as INCOMPLETE when lifecycle evidence is missing", () => {
	const candidate = input();
	candidate.diagnostic.perShardLifecycle = [];
	expect(evaluateCapacityRung(candidate).status).toBe("INCOMPLETE");
});

test("stops as INCOMPLETE when a lifecycle omits a required server ID", () => {
	const candidate = input();
	candidate.diagnostic.perShardLifecycle[0]!.serverId = 0;
	expect(evaluateCapacityRung(candidate).status).toBe("INCOMPLETE");
});
