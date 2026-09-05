import { expect, test } from "bun:test";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import {
	workGradeFixture,
	workProbeFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import { parseLinuxProbeJsonl } from "./g6-sharded-diagnostic.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

test("ladder quality PASS with a lost session or receive error is a measured MISS", () => {
	for (const defect of ["session", "receive"] as const) {
		const input = workGradeFixture();
		input.node.kind = "ladder";
		if (defect === "session") {
			const report = JSON.parse(
				requireDefined(input.scan.clientStdout.split("mmo-client: json ")[1]),
			);
			report.windows.steady.sessionsLost = 1;
			input.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
		} else {
			input.diagnostic.serverHostUdp.idle.InErrors += 1;
		}
		expect(gradeWorkCell(input)).toMatchObject({ outcome: "MISS" });
	}
});

test("ladder retains ambiguous send-buffer pressure separately from ingress cleanliness", () => {
	const input = workGradeFixture();
	input.node.kind = "ladder";
	input.diagnostic.serverHostUdp.idle.SndbufErrors += 17;
	const report = JSON.parse(
		requireDefined(input.scan.clientStdout.split("mmo-client: json ")[1]),
	);
	report.hostUdp.idle.SndbufErrors += 31;
	input.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "PASS" });
});

test("online grade rejects reversed or incomplete native phase evidence before any outcome", () => {
	for (const defect of [
		"reversed",
		"missing",
		"censored",
		"unobserved",
	] as const) {
		const input = workGradeFixture();
		if (defect === "reversed") {
			requireDefined(
				input.diagnostic.sendPathDiagnostics.shards[0],
			).boundaries.drain.monoNs = "1";
		} else if (defect === "missing") {
			Reflect.deleteProperty(
				requireDefined(input.diagnostic.sendPathDiagnostics.shards[0])
					.boundaries,
				"steady",
			);
		} else {
			for (const shard of input.diagnostic.sendPathDiagnostics.shards)
				for (const component of shard.final.components)
					for (const phase of component.phases)
						for (const interval of phase.intervals) {
							if (defect === "censored") interval.histogram.censored = 1;
							else {
								interval.histogram.count = 0;
								interval.histogram.buckets.fill(0);
							}
						}
		}
		expect(gradeWorkCell(input)).toMatchObject({ outcome: "INVALID" });
	}
});

test("online grade requires a successful full scan operation even with detailed probe off", () => {
	for (const defect of ["missing", "short", "failed"] as const) {
		const input = workGradeFixture();
		if (defect === "missing") Reflect.deleteProperty(input, "operation");
		if (defect === "short") input.operation.durationMonotonicNs = "50000000";
		if (defect === "failed") input.operation.status.outcome = "FAILED";
		expect(gradeWorkCell(input)).toMatchObject({ outcome: "INVALID" });
	}
});

test("internally valid 50ms Linux probe cannot certify a 120s workload", () => {
	const input = workGradeFixture({
		profile: { ...workProfileFixture, shards: 1 },
	});
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "PASS" });
	input.probe = workProbeFixture(input.operation.startedAt, 1, 50);
	expect(() => parseLinuxProbeJsonl(requireDefined(input.probe))).not.toThrow();
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "INVALID" });
});

test("detailed probe producer and wall interval must bind independently to the scan", () => {
	const input = workGradeFixture({
		profile: { ...workProfileFixture, shards: 1 },
	});
	expect(
		gradeWorkCell({ ...input, probeProducerSha256: "e".repeat(64) }),
	).toMatchObject({ outcome: "INVALID" });
	input.operation.startedAt = "2026-09-05T00:02:12.000Z";
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "INVALID" });
});

test("attribution ACK-only MISS remains a valid DAG step, loss and terminal errors stop", () => {
	const input = workGradeFixture();
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "PASS" });
	const report = JSON.parse(
		requireDefined(input.scan.clientStdout.split("mmo-client: json ")[1]),
	);
	const histogram = new LatencyHistogram();
	histogram.record(100_000_000);
	report.windows.steadyDrain.rtt = histogram.toJson();
	input.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "MISS" });
	input.scan.aggregate.steady.rxTotal = 1;
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "INVALID" });
	const terminal = workGradeFixture();
	const firstShard = requireDefined(terminal.scan.shards[0]);
	const windows = requireDefined(firstShard.windows);
	const lifetime = requireDefined(windows.lifetime);
	const metrics = requireDefined(lifetime.metrics);
	metrics.udpSendBatchErrors = 1;
	expect(gradeWorkCell(terminal)).toMatchObject({ outcome: "INVALID" });
});

test("grade rechecks producer/profile evidence and never trusts stored PASS", () => {
	const input = workGradeFixture();
	input.diagnostic.sendPathDiagnostics.enabled = false;
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "INVALID" });
	const swapped = workGradeFixture();
	swapped.scan.config.udpSendBatch = 64;
	expect(gradeWorkCell(swapped)).toMatchObject({ outcome: "INVALID" });
});

test("online grade rejects ambiguous client reports before selecting another cell", () => {
	const input = workGradeFixture();
	expect(gradeWorkCell(input).outcome).toBe("PASS");
	input.scan.clientStdout += input.scan.clientStdout;
	expect(gradeWorkCell(input).outcome).toBe("INVALID");
});

test("online grade rejects an aggregate that contradicts its retained shards", () => {
	const input = workGradeFixture();
	expect(gradeWorkCell(input).outcome).toBe("PASS");
	input.scan.aggregate.steady.rxTotal -= 1;
	expect(gradeWorkCell(input).outcome).toBe("INVALID");
});

test("online grade rejects a same-sized observed pool outside the registered ports", () => {
	const input = workGradeFixture();
	expect(gradeWorkCell(input).outcome).toBe("PASS");
	const report = JSON.parse(
		requireDefined(input.scan.clientStdout.split("mmo-client: json ")[1]),
	);
	report.client.endpointSourceAddresses = Array.from(
		{ length: input.profile.endpoints },
		(_, index) => `0.0.0.0:${55000 + index}`,
	);
	input.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
	expect(gradeWorkCell(input).outcome).toBe("INVALID");
});

test("attribution retains ambiguous send pressure without censoring an ACK-only MISS", () => {
	const input = workGradeFixture();
	const report = JSON.parse(
		requireDefined(input.scan.clientStdout.split("mmo-client: json ")[1]),
	);
	const histogram = new LatencyHistogram();
	histogram.record(100_000_000);
	report.windows.steadyDrain.rtt = histogram.toJson();
	report.hostUdp.idle.SndbufErrors = report.hostUdp.connect.SndbufErrors + 17;
	input.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
	input.diagnostic.serverHostUdp.idle.SndbufErrors =
		input.diagnostic.serverHostUdp.connect.SndbufErrors + 631798;
	expect(gradeWorkCell(input)).toMatchObject({ outcome: "MISS" });
	for (const [field, value] of [
		["InErrors", 1],
		["RcvbufErrors", 1],
		["SndbufErrors", -1],
		["SndbufErrors", null],
		["SndbufErrors", Number.POSITIVE_INFINITY],
	] as const) {
		const broken = structuredClone(input);
		const idle = broken.diagnostic.serverHostUdp.idle as Record<
			"InErrors" | "RcvbufErrors" | "SndbufErrors",
			number | null
		>;
		idle[field] = value;
		expect(gradeWorkCell(broken)).toMatchObject({ outcome: "INVALID" });
	}
});
