import { expect, test } from "bun:test";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import {
	workGradeFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import {
	type CapacityRawCellInput,
	validateCapacityAppliedBuffers,
	validateCapacityOwner,
	validateCapacityRawCell,
} from "./g6-capacity-raw-cell.ts";
import { linuxProbeFixtureText } from "./g6-linux-probe-fixture.ts";
import { parseNativeSendPath } from "./g6-native-send-path.ts";
import { parseLinuxProbeJsonl } from "./g6-sharded-diagnostic.ts";
import { steeredTotal } from "./g6-sharded-grade.ts";

function set(value: unknown, path: string, replacement: unknown) {
	const keys = path.split(".");
	let row = value as Record<string, unknown>;
	for (const key of keys.slice(0, -1))
		row = row[key] as Record<string, unknown>;
	row[requireDefined(keys.at(-1))] = replacement;
}
function client(
	input: CapacityRawCellInput,
	change: (report: Record<string, unknown>) => void,
) {
	const report = JSON.parse(
		input.scan.clientStdout.slice("mmo-client: json ".length),
	);
	change(report);
	input.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
}
function rejected(input: CapacityRawCellInput, expected: RegExp) {
	expect(() => {
		validateCapacityRawCell(input);
	}).toThrow(expected);
	const grade = gradeWorkCell(input);
	expect(grade.outcome).toBe("INVALID");
	expect(grade.reasons.join("; ")).toMatch(expected);
}

test("the complete raw gate accepts coherent synthetic probe-off and probe-on cells", () => {
	for (const detailedProbe of [false, true]) {
		const input = workGradeFixture({
			profile: { ...workProfileFixture, shards: 1, detailedProbe },
		});
		const result = validateCapacityRawCell(input);
		expect(result.scan).toBe(input.scan);
		expect(result.report.startedAt).toBe(input.diagnostic.startedAt);
		expect(result.native).toHaveLength(1);
		expect(result.probe === null).toBe(!detailedProbe);
		expect(gradeWorkCell(input).outcome).toBe("PASS");
	}
});

test("raw authority accepts the same 128-character run ID bound by WorkAuthority", () => {
	const input = workGradeFixture({ runId: `a${"b".repeat(127)}` });
	expect(() => validateCapacityRawCell(input)).not.toThrow();
});

for (const [path, value, reason] of [
	["scan.schema", "g6-sharded-scan/2", /schema, source or timestamp/],
	[
		"diagnostic.schema",
		"g6-sharded-diagnostic/2",
		/schema, source or timestamp/,
	],
	["scan.candidateSha", "e".repeat(40), /schema, source or timestamp/],
	["diagnostic.candidateSha", "e".repeat(40), /schema, source or timestamp/],
	["scan.startedAt", "2026-09-05T00:02:12.000Z", /schema, source or timestamp/],
	[
		"diagnostic.startedAt",
		"2026-09-05T00:02:12.000Z",
		/schema, source or timestamp/,
	],
	["scan.config.activeWorkloadSessions", 39999, /raw activeWorkloadSessions/],
	[
		"diagnostic.dispatch.activeWorkloadSessions",
		39999,
		/raw activeWorkloadSessions/,
	],
	["diagnostic.dispatch.ackCadence", "relaxed", /raw ackCadence/],
	["scan.config.steadySeconds", 119, /raw duration or pacing/],
	["scan.config.pacerPps", "Infinity", /raw duration or pacing/],
	["profile.nativeDiagnostics", false, /frozen cell authority/],
	["nativeProducerSha256", "x".repeat(64), /frozen cell authority/],
	["probeProducerSha256", null, /frozen cell authority/],
	["scanStdout", "", /scan stdout/],
	["scanStderr", undefined, /scan stderr/],
] as const) {
	test(`raw cell rejects ${path} mismatch before online progression`, () => {
		const input = workGradeFixture();
		set(input, path, value);
		rejected(input, reason);
	});
}

for (const [path, value] of [
	["schema", "mmo-client/1"],
	["startedAt", "2026-09-05T00:02:12.000Z"],
	["sessionsRequested", 39999],
	["activeWorkloadSessions", 39999],
	["preRegistration.sha256", "e".repeat(64)],
	["connectConcurrency", 1],
	["connectRatePerSec", 1],
	["config.fixedSourcePortBase", 55000],
	["connectStarts.offered", 39999],
	["connectStarts.achieved", 39999],
] as const) {
	test(`raw client ${path} is not self-declared workload authority`, () => {
		const input = workGradeFixture();
		client(input, (report) => set(report, path, value));
		rejected(input, /raw client differs/);
	});
}

test("raw client cardinality and actual port membership are mandatory", () => {
	for (const defect of ["missing", "duplicate", "ports"] as const) {
		const input = workGradeFixture();
		if (defect === "missing") input.scan.clientStdout = "";
		if (defect === "duplicate")
			input.scan.clientStdout += input.scan.clientStdout;
		if (defect === "ports")
			client(input, (report) =>
				set(
					report,
					"client.endpointSourceAddresses",
					Array.from(
						{ length: input.profile.endpoints },
						(_, i) => `0.0.0.0:${55000 + i}`,
					),
				),
			);
		rejected(
			input,
			defect === "ports"
				? /source ports differ/
				: /missing or duplicate raw client/,
		);
	}
});

for (const [path, value, reason] of [
	["pair.server.source.commit", "e".repeat(40), /source\/provenance/],
	["pair.generator.source.statusPorcelain", " M raw.ts", /checkout is dirty/],
	["pair.server.runtime.os", "Darwin", /source\/provenance/],
	["pair.server.provider.size", "c-32-intel", /host shape/],
	["pair.generator.provider.vpcUuid", "other-vpc", /distinct pair/],
	["pair.generator.source.tree", "e".repeat(40), /distinct pair/],
	["operation.envelope.runId", "other-run", /exact successful bounded work/],
	[
		"operation.envelope.operationId",
		"other-scan",
		/exact successful bounded work/,
	],
	["operation.envelope.phase", "PREPARE", /exact server/],
	["operation.attempt", 2, /exact successful bounded work/],
	["operation.status.outcome", "TIMED_OUT", /exact successful bounded work/],
	["operation.status.exitCode", 1, /exact successful bounded work/],
	["operation.action.command", "g6_ssh", /exact successful bounded work/],
	[
		"operation.stdoutPath",
		"work/other/scan.stdout",
		/exact successful bounded work/,
	],
	[
		"operation.stderrPath",
		"work/other/scan.stderr",
		/exact successful bounded work/,
	],
	[
		"operation.durationMonotonicNs",
		"119000000000",
		/exact successful bounded work/,
	],
	[
		"operation.durationMonotonicNs",
		"421000000000",
		/exact successful bounded work/,
	],
] as const) {
	test(`raw host/operation gate rejects ${path}`, () => {
		const input = workGradeFixture();
		set(input, path, value);
		if (path === "operation.status.outcome")
			input.operation.status.exitCode = null;
		if (path === "operation.status.exitCode")
			input.operation.status.outcome = "FAILED";
		rejected(input, reason);
	});
}

test("the raw operation parser requires exact owner env, profile, paths and stdout", () => {
	for (const defect of [
		"owner",
		"profile",
		"path",
		"unknown-env",
		"duplicate-start",
		"missing-write",
		"wrong-exit",
	] as const) {
		const input = workGradeFixture();
		let fragment = requireDefined(input.operation.action.args[3]);
		if (defect === "owner")
			fragment = fragment.replace(
				`G6_OFFBOX_WORK_BOOT_ID=${input.pair.generator.bootId}`,
				`G6_OFFBOX_WORK_BOOT_ID=${input.pair.server.bootId}`,
			);
		if (defect === "profile")
			fragment = fragment.replace(
				`SCAN_SERVER_WORKERS=${input.profile.serverWorkers}`,
				`SCAN_SERVER_WORKERS=${input.profile.serverWorkers + 1}`,
			);
		if (defect === "path")
			fragment = fragment.replaceAll(
				`/cells/work-${input.node.id}`,
				"/cells/work-other",
			);
		if (defect === "unknown-env") fragment = `UNREGISTERED_FLAG=1 ${fragment}`;
		input.operation.action.args[3] = fragment;
		if (defect === "duplicate-start")
			input.scanStdout = `${requireDefined(input.scanStdout.split("\n")[0])}\n${input.scanStdout}`;
		if (defect === "missing-write")
			input.scanStdout = input.scanStdout.replace(
				/^g6-sharded-scan: wrote .*diagnostic\.json\n/m,
				"",
			);
		if (defect === "wrong-exit")
			input.scanStdout = input.scanStdout.replace(
				"client exited 0",
				"client exited 1",
			);
		rejected(input, /scan (command|stdout)|owned scan outputs/);
	}
});

test("wall lifecycle must cover 120 seconds in its exact enclosing operation", () => {
	for (const defect of [
		"119s",
		"outside",
		"exit",
		"missing",
		"duplicate-id",
	] as const) {
		const input = workGradeFixture();
		const life = requireDefined(input.diagnostic.perShardLifecycle[0]);
		if (defect === "119s") requireDefined(life.boundaries[2]).tsMs -= 1000;
		if (defect === "outside")
			requireDefined(life.boundaries[0]).tsMs =
				Date.parse(input.operation.startedAt) - 1;
		if (defect === "exit")
			requireDefined(life.exits[0]).tsMs =
				Date.parse(input.operation.finishedAt) + 1;
		if (defect === "missing") life.boundaries.pop();
		if (defect === "duplicate-id")
			life.serverId = requireDefined(
				input.diagnostic.perShardLifecycle[1],
			).serverId;
		rejected(input, /lifecycle/);
	}
});

test("every clause-driving aggregate reconciles to finite raw shard counters", () => {
	for (const phase of ["steady", "steadyDrain", "lifetime"])
		for (const key of [
			"rxTotal",
			"emitter.snapshotIssued",
			"emitter.sendErrors",
		])
			for (const defect of ["aggregate", "unsafe"] as const) {
				const input = workGradeFixture();
				set(
					input,
					defect === "aggregate"
						? `scan.aggregate.${phase}.${key}`
						: `scan.shards.0.windows.${phase}.${key}`,
					defect === "aggregate" ? 1 : Number.POSITIVE_INFINITY,
				);
				rejected(input, /contradicts raw shard|safe integer/);
			}
});

test("post-run steering requires the same raw witness within this operation", () => {
	for (const defect of ["missing", "mismatch", "before", "after"] as const) {
		const input = workGradeFixture();
		if (defect === "missing") input.postRunSteeringText = "{}";
		if (defect === "mismatch")
			set(
				input.diagnostic.postRunSteering,
				"steerStatsSum.steered",
				30_000_001,
			);
		if (defect === "before")
			input.diagnostic.postRunSteering.capturedAtMs =
				Date.parse(input.operation.startedAt) - 1;
		if (defect === "after")
			input.diagnostic.postRunSteering.capturedAtMs =
				Date.parse(input.operation.finishedAt) + 1;
		rejected(input, /post-run steering witness/);
	}
});

test("process owner helper rejects unknown or mismatched run/node/boot/incarnation fields", () => {
	for (const [path, value] of [
		["runId", "other"],
		["nodeId", "other"],
		["role", "generator"],
		["bootId", "other"],
		["pid", 1],
		["processGroupId", 1001],
		["startTicks", "0"],
		["extra", true],
	] as const) {
		const input = workGradeFixture();
		const expected = {
			owner: input.owners.server,
			runId: input.runId,
			nodeId: input.node.id,
			role: "server" as const,
			bootId: input.pair.server.bootId,
		};
		expect(() => validateCapacityOwner(expected)).not.toThrow();
		set(input.owners.server, path, value);
		expect(() => validateCapacityOwner(expected)).toThrow(/owner/);
		rejected(input, /owner/);
	}
});

test("applied buffer evidence is exact and cannot be absent, failed, relabeled or post-scan", () => {
	for (const defect of [
		"missing",
		"extra",
		"run",
		"failed",
		"attempt",
		"late",
		"sequence",
		"host",
		"command",
		"stdout",
		"stderr",
		"path",
	] as const) {
		const input = workGradeFixture();
		expect(() => validateCapacityAppliedBuffers(input)).not.toThrow();
		const bundle = requireDefined(
			input.bufferOperations["apply-buffer-generator"],
		);
		if (defect === "missing")
			Reflect.deleteProperty(input.bufferOperations, "apply-buffer-generator");
		if (defect === "extra")
			input.bufferOperations["apply-server-sndbuf"] = bundle;
		if (defect === "run") bundle.receipt.envelope.runId = "other";
		if (defect === "failed") {
			bundle.receipt.status.outcome = "FAILED";
			bundle.receipt.status.exitCode = 1;
		}
		if (defect === "attempt") bundle.receipt.attempt = 2;
		if (defect === "late")
			bundle.receipt.finishedAt = input.operation.finishedAt;
		if (defect === "sequence")
			bundle.receipt.envelope.sequence = input.operation.envelope.sequence;
		if (defect === "host")
			bundle.receipt.action.args[0] = `root@${input.pair.server.provider.publicIpv4}`;
		if (defect === "command")
			bundle.receipt.action.args[1] += " net.core.rmem_max=1";
		if (defect === "stdout") bundle.stdout += "net.core.rmem_max = 1\n";
		if (defect === "stderr") Reflect.deleteProperty(bundle, "stderr");
		if (defect === "path")
			bundle.receipt.stdoutPath = "work/other/apply-buffer.stdout";
		rejected(input, /buffer/);
	}
});

test("raw pacing allows exactly null, numeric zero or string zero, never coercion", () => {
	for (const value of [null, 0, "0"] as const) {
		const input = workGradeFixture();
		set(input, "scan.config.pacerPps", value);
		expect(() => {
			validateCapacityRawCell(input);
		}).not.toThrow();
	}
	for (const value of [false, "", undefined, "00"]) {
		const input = workGradeFixture();
		set(input, "scan.config.pacerPps", value);
		rejected(input, /raw duration or pacing/);
	}
});

test("raw steering cannot be an unsafe numeric total or a matching parser refusal string", () => {
	for (const raw of [
		"{}",
		'[{"key":0,"values":[{"cpu":0,"value":9007199254740992}]}]',
	]) {
		const input = workGradeFixture();
		input.postRunSteeringText = raw;
		set(
			input.diagnostic.postRunSteering,
			"steerStatsSum.steered",
			steeredTotal(raw),
		);
		expect(() => {
			validateCapacityRawCell(input);
		}).toThrow(/post-run steering/);
	}
});

test("requested send buffer requires its own operation without inventing exact receive socket bytes", () => {
	const input = workGradeFixture({
		profile: {
			...workProfileFixture,
			shards: 1,
			detailedProbe: true,
			serverUdpSendBufferBytes: 1024,
		},
	});
	expect(() => validateCapacityRawCell(input)).not.toThrow();
	Reflect.deleteProperty(input.bufferOperations, "apply-server-sndbuf");
	rejected(input, /buffer operations/);
});

test("A0 probe-off is explicit, not a missing measurement mistaken for off", () => {
	for (const [path, value] of [
		["out", "other"],
		["maxBytes", 1],
		["producerSha256", "d".repeat(64)],
		["stoppedCleanly", true],
		["measurementMode.phaseAware", false],
	] as const) {
		const input = workGradeFixture();
		set(input.diagnostic.linuxProbe, path, value);
		rejected(input, /explicit probe-off/);
	}
});

test("A-only CPU arithmetic requires raw finite shard values and exact aggregate inputs", () => {
	for (const [path, value] of [
		["scan.shards.0.windows.steady.cpuMs", Number.POSITIVE_INFINITY],
		["scan.aggregate.steady.cpuMs", 1],
		["scan.aggregate.steady.wallMsMax", 1],
	] as const) {
		const input = workGradeFixture();
		set(input, path, value);
		rejected(input, /CPU/);
		input.node.kind = "ladder";
		expect(gradeWorkCell(input).outcome).toBe("PASS");
	}
});

test("pooled native phase summaries reject overflow even when each snapshot is valid", () => {
	const input = workGradeFixture();
	for (const shard of input.diagnostic.sendPathDiagnostics.shards) {
		const interval = requireDefined(
			requireDefined(requireDefined(shard.final.components[0]).phases[1])
				.intervals[0],
		);
		interval.histogram.count = Number.MAX_SAFE_INTEGER;
		interval.histogram.buckets.fill(0);
		interval.histogram.buckets[0] = Number.MAX_SAFE_INTEGER;
		expect(() =>
			parseNativeSendPath(shard.final, {
				enabled: true,
				finalized: true,
				phase: "idle",
			}),
		).not.toThrow();
	}
	rejected(input, /safe integer/);
});

test("raw gauge bounds keep even pooled high-water arithmetic finite", () => {
	const input = workGradeFixture();
	for (const shard of input.diagnostic.sendPathDiagnostics.shards) {
		requireDefined(
			requireDefined(shard.final.components[0]).gauges[0],
		).gauge.phaseHighWater[2] = 2 ** 30 - 1;
		expect(() => {
			parseNativeSendPath(shard.final, {
				enabled: true,
				finalized: true,
				phase: "idle",
			});
		}).not.toThrow();
	}
	expect(() => {
		validateCapacityRawCell(input);
	}).not.toThrow();
	set(
		input.diagnostic.sendPathDiagnostics,
		"shards.0.final.components.0.gauges.0.gauge.phaseHighWater.2",
		2 ** 30,
	);
	rejected(input, /gauge maximum mismatch/);
});

test("source-valid probe rows cannot overflow later attribution queue or scheduler summaries", () => {
	for (const key of ["txQueueBytes", "runtimeNs", "timeslices"] as const) {
		const input = workGradeFixture({
			profile: { ...workProfileFixture, shards: 2, detailedProbe: true },
		});
		const rows: Record<string, unknown>[] = requireDefined(input.probe)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const row of rows) {
			const array = key === "txQueueBytes" ? "shards" : "sched";
			if (
				row.schema !==
				`g6-c32-linux-probe-${key === "txQueueBytes" ? "queue" : "sched"}/2`
			)
				continue;
			for (const shard of row[array] as Record<string, unknown>[])
				shard[key] = Number.MAX_SAFE_INTEGER;
		}
		input.probe = linuxProbeFixtureText(rows);
		expect(() => {
			parseLinuxProbeJsonl(requireDefined(input.probe));
		}).not.toThrow();
		rejected(input, new RegExp(`${key} must be a safe integer`));
	}
});

test("detailed probe raw PID membership and clean mode are mandatory", () => {
	for (const defect of ["pid", "cleanup", "phase-aware"] as const) {
		const input = workGradeFixture({
			profile: { ...workProfileFixture, shards: 1, detailedProbe: true },
		});
		if (defect === "pid") {
			const rows: Record<string, unknown>[] = requireDefined(input.probe)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			for (const row of rows)
				for (const array of ["shards", "sched"])
					if (Array.isArray(row[array]))
						for (const shard of row[array] as Record<string, unknown>[])
							shard.pid = 999;
			input.probe = linuxProbeFixtureText(rows);
			expect(() => {
				parseLinuxProbeJsonl(requireDefined(input.probe));
			}).not.toThrow();
		}
		if (defect === "cleanup")
			input.diagnostic.linuxProbe.stoppedCleanly = false;
		if (defect === "phase-aware")
			input.diagnostic.linuxProbe.measurementMode.phaseAware = false;
		rejected(input, /Linux probe mode, cleanup or PID/);
	}
});
