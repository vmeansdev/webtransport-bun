import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	requireDefined,
	validateOperationReceipt,
} from "./g6-c32-freeze-model.ts";
import {
	evaluateProbeCalibration,
	evaluateSendPathAttribution,
	runSendPathEvaluateCli,
} from "./g6-c32-send-path-evaluate.ts";
import {
	cleanupSendPathFixtures,
	resealSendPathFixture,
	sendPathFixture,
} from "./g6-c32-send-path-fixture.test-helper.ts";
import { readWorkCellEvidence } from "./g6-c32-work-execution.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";

afterEach(cleanupSendPathFixtures);

// Adversarial tests deliberately remove, replace, and add fields outside valid schemas.
// biome-ignore lint/suspicious/noExplicitAny: Only callbacks that corrupt synthetic retained JSON use this type.
type MalformedSyntheticJson = any;

function mutateJson(
	root: string,
	path: string,
	change: (value: MalformedSyntheticJson) => void,
) {
	const absolute = join(root, path),
		value = JSON.parse(readFileSync(absolute, "utf8"));
	change(value);
	writeFileSync(absolute, JSON.stringify(value));
}

function mutateClient(
	root: string,
	nodeId: string,
	change: (value: MalformedSyntheticJson) => void,
) {
	mutateJson(root, `work/${nodeId}/g6-sharded-scan.json`, (scan) => {
		const client = JSON.parse(
			scan.clientStdout.slice("mmo-client: json ".length),
		);
		change(client);
		scan.clientStdout = `mmo-client: json ${JSON.stringify(client)}\n`;
	});
}

test("raw eight-cell A evidence yields per-arm medians, not a capacity verdict", () => {
	const input = sendPathFixture({ ackMs: 100 });
	const result = evaluateSendPathAttribution(input);
	expect(result).toMatchObject({
		evidenceValid: true,
		attributionVerdict: "VALID_PAIRED_ATTRIBUTION",
		capacityVerdict: "NOT_CAPACITY_EVIDENCE",
	});
	expect(result.replicates.map((row) => row.nodeId)).toEqual([
		"A0-1",
		"A1-1",
		"B-1",
		"C-1",
		"C-2",
		"B-2",
		"A1-2",
		"A0-2",
	]);
	expect(result.replicates.every((row) => row.rawGate === "MISS")).toBe(true);
	expect(result.arms.A0?.replicateNodeIds).toEqual(["A0-1", "A0-2"]);
	expect(
		result.replicates[0]?.phases.steady.native.intervals.reflectQueueWait
			?.count,
	).toBe(100);
	expect(result.replicates[0]?.phases.steady.linuxProbe).toBeNull();
	expect(
		result.replicates[1]?.phases.steady.linuxProbe
			?.observedSchedstatWaitDeltaNs,
	).toBe(2399);
});

test("online and retained attribution reject the same rehashed raw pool, count, owner and command defects", () => {
	const input = sendPathFixture();
	if (input.policy.schema !== "g6-c32-budget-policy/2")
		throw Error("fixture requires work policy");
	const node = requireDefined(
			input.policy.workPlan.nodes.find((node) => node.id === "A0-1"),
		),
		profile = requireDefined(input.policy.workProfiles[node.profile]),
		readRaw = () =>
			readWorkCellEvidence(input.root, node, profile, input.workAuthority);
	expect(gradeWorkCell(readRaw()).outcome).toBe("PASS");
	for (const [defect, reason] of [
		["ports", /registered pool/],
		["counts", /contradicts raw shard/],
		["owner", /frozen boot\/run\/node/],
		["command", /unregistered workload overrides/],
	] as const) {
		const name =
				defect === "owner"
					? "generator-owner.json"
					: defect === "command"
						? "scan.receipt.json"
						: "g6-sharded-scan.json",
			path = join(input.root, "work", node.id, name),
			before = readFileSync(path);
		if (defect === "ports")
			mutateClient(input.root, node.id, (client) => {
				client.client.endpointSourceAddresses = Array.from(
					{ length: profile.endpoints },
					(_, index) => `0.0.0.0:${55000 + index}`,
				);
			});
		else if (defect === "counts")
			mutateJson(input.root, `work/${node.id}/${name}`, (scan) => {
				scan.aggregate.steady.rxTotal -= 1;
			});
		else if (defect === "owner")
			mutateJson(input.root, `work/${node.id}/${name}`, (owner) => {
				owner.bootId = input.workAuthority.pair.server.bootId;
			});
		else {
			const receipt = validateOperationReceipt(JSON.parse(before.toString()));
			receipt.action.args[3] = `SCAN_UNREGISTERED=1 ${requireDefined(receipt.action.args[3])}`;
			writeFileSync(path, JSON.stringify(receipt));
		}
		const online = gradeWorkCell(readRaw());
		expect(online.outcome).toBe("INVALID");
		expect(online.reasons.join("\n")).toMatch(reason);
		resealSendPathFixture(input);
		const final = evaluateSendPathAttribution(input);
		expect(final.evidenceValid).toBe(false);
		expect(final.reasons.join("\n")).toMatch(reason);
		writeFileSync(path, before);
	}
});

test("calibration is paired, threshold-inclusive, and independently gates CPU ACK offered and delivered parity", () => {
	const control = {
		nodeId: "A0-1",
		cpuCores: 2,
		ackP99Ms: 10,
		clientSteadySent: 20000,
		serverSnapshotIssued: 20000,
		clientSnapshotReceived: 20000,
		nonAckClausePass: {
			S1_ingest: true,
			S2_delivery: true,
			S3_duty: true,
			S5_sessionsLost: true,
		},
	};
	expect(
		evaluateProbeCalibration(control, {
			...control,
			nodeId: "A1-1",
			cpuCores: 2.1,
			ackP99Ms: 10.5,
			clientSteadySent: 20100,
			serverSnapshotIssued: 20100,
			clientSnapshotReceived: 20100,
		}).valid,
	).toBe(true);
	for (const change of [
		{ cpuCores: 2.101 },
		{ ackP99Ms: 10.501 },
		{ clientSteadySent: 20101 },
		{ serverSnapshotIssued: 20101 },
		{ clientSnapshotReceived: 20101 },
		{ nonAckClausePass: { ...control.nonAckClausePass, S1_ingest: false } },
	])
		expect(
			evaluateProbeCalibration(control, {
				...control,
				nodeId: "A1-1",
				...change,
			}).valid,
		).toBe(false);
});

test("failed probe calibration keeps raw evidence and invalidates causal comparison", () => {
	const input = sendPathFixture({ cpuByNode: { "A1-2": 252100 } });
	const result = evaluateSendPathAttribution(input);
	expect(result).toMatchObject({
		evidenceValid: true,
		attributionVerdict: "INVALID_PROBE_INTERFERENCE",
		capacityVerdict: "NOT_CAPACITY_EVIDENCE",
	});
	expect(result.calibration.map((pair) => pair.valid)).toEqual([true, false]);
});

test("missing and reordered final cells cannot become attribution proof", () => {
	const input = sendPathFixture();
	const finalPath = join(input.root, "closeout/work-final.json"),
		final = JSON.parse(readFileSync(finalPath, "utf8"));
	[final.completed[0], final.completed[1]] = [
		final.completed[1],
		final.completed[0],
	];
	writeFileSync(finalPath, JSON.stringify(final));
	expect(evaluateSendPathAttribution(input).evidenceValid).toBe(false);
	[final.completed[0], final.completed[1]] = [
		final.completed[1],
		final.completed[0],
	];
	const second = final.completed[1];
	final.completed[1] = final.completed[0];
	writeFileSync(finalPath, JSON.stringify(final));
	expect(evaluateSendPathAttribution(input).evidenceValid).toBe(false);
	final.completed[1] = second;
	writeFileSync(finalPath, JSON.stringify(final));
	unlinkSync(join(input.root, "work/A0-2/completion.json"));
	expect(evaluateSendPathAttribution(input).evidenceValid).toBe(false);
});

test("same SHA, exact pair boot IDs, and producer hashes are evidence requirements", () => {
	const input = sendPathFixture();
	for (const change of [
		{ nativeProducerSha256: "d".repeat(64) },
		{ probeProducerSha256: "d".repeat(64) },
		{
			boundHostPair: {
				...input.boundHostPair,
				server: {
					...input.boundHostPair.server,
					source: {
						...input.boundHostPair.server.source,
						commit: "d".repeat(40),
					},
				},
			},
		},
	])
		expect(
			evaluateSendPathAttribution({ ...input, ...change }).evidenceValid,
		).toBe(false);
	const path = join(input.root, "work/B-1/scan-owner.json"),
		owner = JSON.parse(readFileSync(path, "utf8"));
	owner.bootId = input.boundHostPair.generator.bootId;
	writeFileSync(path, JSON.stringify(owner));
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).reasons.join(";")).toContain(
		"owner",
	);
});

test("absent explicit A0 probe-off and wrong native phase are rejected even after resealing", () => {
	const input = sendPathFixture();
	const path = join(input.root, "work/A0-1/g6-sharded-diagnostic.json"),
		value = JSON.parse(readFileSync(path, "utf8"));
	value.linuxProbe.out = "/tmp/hidden-probe";
	writeFileSync(path, JSON.stringify(value));
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).reasons.join(";")).toContain(
		"explicit probe-off",
	);
	value.linuxProbe.out = null;
	value.sendPathDiagnostics.shards[0].boundaries.steady.phase = "connect";
	writeFileSync(path, JSON.stringify(value));
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).reasons.join(";")).toContain(
		"stored grade does not match raw evidence",
	);
});

test("booked steady emission uses the frozen steadyDrain denominator, not an early phase snapshot", () => {
	const input = sendPathFixture();
	mutateJson(input.root, "work/A1-1/g6-sharded-scan.json", (scan) => {
		for (const shard of scan.shards)
			shard.windows.steady.emitter.snapshotIssued *= 0.99;
		scan.aggregate.steady.emitter.snapshotIssued *= 0.99;
	});
	resealSendPathFixture(input);
	const result = evaluateSendPathAttribution(input);
	expect(result.attributionVerdict).toBe("VALID_PAIRED_ATTRIBUTION");
	expect(result.replicates[1]?.serverSnapshotIssued).toBe(
		result.replicates[0]?.serverSnapshotIssued,
	);
});

test("raw lifecycle wall phases cannot contradict a valid native/probe steady interval", () => {
	const input = sendPathFixture();
	mutateJson(
		input.root,
		"work/B-1/g6-sharded-diagnostic.json",
		(diagnostic) => {
			diagnostic.perShardLifecycle[0].boundaries[2].tsMs -= 1000;
		},
	);
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).reasons.join(";")).toContain(
		"lifecycle steady",
	);
});

test("observed source ports must be the registered pool, not merely a same-sized unique pool", () => {
	const input = sendPathFixture();
	mutateClient(input.root, "B-1", (client) => {
		client.client.endpointSourceAddresses =
			client.client.endpointSourceAddresses.map(
				(_: string, i: number) => `0.0.0.0:${55000 + i}`,
			);
	});
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).reasons.join(";")).toContain(
		"source ports",
	);
});

test("aggregate clause-driving totals are reconciled with retained raw shards", () => {
	const input = sendPathFixture();
	mutateJson(input.root, "work/B-1/g6-sharded-scan.json", (scan) => {
		scan.aggregate.steady.rxTotal -= 1;
	});
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).reasons.join(";")).toContain(
		"contradicts raw shard counters",
	);
});

test("all-eight offered-work parity is independent of passing safety clauses and paired calibration", () => {
	const input = sendPathFixture();
	mutateClient(input.root, "B-1", (client) => {
		client.windows.steady.sent *= 0.994;
	});
	mutateJson(input.root, "work/B-1/g6-sharded-scan.json", (scan) => {
		for (const phase of ["steady", "steadyDrain", "lifetime"]) {
			for (const shard of scan.shards) shard.windows[phase].rxTotal *= 0.994;
			scan.aggregate[phase].rxTotal *= 0.994;
		}
	});
	resealSendPathFixture(input);
	const result = evaluateSendPathAttribution(input);
	expect(result).toMatchObject({
		evidenceValid: true,
		attributionVerdict: "INVALID_WORK_PARITY",
		capacityVerdict: "NOT_CAPACITY_EVIDENCE",
	});
	expect(result.calibration.every((pair) => pair.valid)).toBe(true);
});

test("raw delivered-work calibration can fail while both unchanged S2 results still pass", () => {
	const input = sendPathFixture();
	mutateClient(input.root, "A0-1", (client) => {
		client.windows.steadyDrain.rxSnapshot *= 0.995;
	});
	resealSendPathFixture(input);
	const result = evaluateSendPathAttribution(input);
	expect(result.attributionVerdict).toBe("INVALID_PROBE_INTERFERENCE");
	expect(result.replicates[0]?.clauses.S2_delivery?.pass).toBe(true);
	expect(result.replicates[1]?.clauses.S2_delivery?.pass).toBe(true);
	expect(result.calibration[0]?.comparisons.clientSnapshotReceived?.pass).toBe(
		false,
	);
});

test("mixed raw source and unregistered profile or command overrides are rejected after resealing", () => {
	const input = sendPathFixture();
	for (const [path, change] of [
		[
			"work/B-1/g6-sharded-diagnostic.json",
			(value: MalformedSyntheticJson) => {
				value.candidateSha = "d".repeat(40);
			},
		],
		[
			"work/B-1/g6-sharded-scan.json",
			(value: MalformedSyntheticJson) => {
				value.config.serverWorkers += 1;
			},
		],
		[
			"work/B-1/scan.receipt.json",
			(value: MalformedSyntheticJson) => {
				value.action.args[3] = `UNREGISTERED_WORKLOAD_OVERRIDE=1 ${value.action.args[3]}`;
			},
		],
	] as const) {
		const original = readFileSync(join(input.root, path), "utf8");
		mutateJson(input.root, path, change);
		resealSendPathFixture(input);
		expect(evaluateSendPathAttribution(input).evidenceValid).toBe(false);
		writeFileSync(join(input.root, path), original);
	}
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).evidenceValid).toBe(true);
});

test("probe-on requires retained raw samples in the exact phase, never an absent or relabeled probe", () => {
	const input = sendPathFixture(),
		path = join(input.root, "work/A1-1/linux-probe.jsonl"),
		original = readFileSync(path, "utf8");
	unlinkSync(path);
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).evidenceValid).toBe(false);
	const rows = original
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	const queue = rows.find(
		(row) =>
			row.schema === "g6-c32-linux-probe-queue/2" && row.phase === "steady",
	);
	queue.phase = "idle";
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).evidenceValid).toBe(false);
});

test("CLI consumes retained paths and emits attribution-only output without trusting an invented authority field", () => {
	const input = sendPathFixture();
	for (const [path, value] of Object.entries({
		"policy.json": input.policy,
		"ledger.json": input.ledger,
		"authority.json": {
			schema: "g6-c32-send-path-authority/1",
			boundHostPair: input.boundHostPair,
			nativeProducerSha256: input.nativeProducerSha256,
			probeProducerSha256: input.probeProducerSha256,
			workAuthority: input.workAuthority,
		},
	}))
		writeFileSync(join(input.root, path), JSON.stringify(value));
	const args = [
		"--root",
		input.root,
		"--policy",
		join(input.root, "policy.json"),
		"--ledger",
		join(input.root, "ledger.json"),
		"--authority",
		join(input.root, "authority.json"),
	];
	const execution = spawnSync(
		process.execPath,
		[join(import.meta.dir, "g6-c32-send-path-evaluate.ts"), ...args],
		{ encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
	);
	expect(execution.status).toBe(0);
	expect(JSON.parse(execution.stdout)).toMatchObject({
		attributionVerdict: "VALID_PAIRED_ATTRIBUTION",
		capacityVerdict: "NOT_CAPACITY_EVIDENCE",
	});
	mutateJson(input.root, "authority.json", (authority) => {
		authority.capacityPass = true;
	});
	expect(() => runSendPathEvaluateCli(args)).toThrow("unknown fields");
});

test("receive-buffer settings require exact per-role producer operations and observed sysctl values", () => {
	const input = sendPathFixture();
	const path = join(input.root, "work/A0-1/apply-buffer-generator.stdout");
	writeFileSync(
		path,
		"net.core.rmem_max = 212992\nnet.core.rmem_default = 212992\nnet.ipv4.udp_rmem_min = 4096\n",
	);
	resealSendPathFixture(input);
	expect(evaluateSendPathAttribution(input).reasons.join(";")).toContain(
		"applied buffer",
	);
});

test("summaries retain uncensored origin-phase evidence and socket scope; censored raw data is invalid", () => {
	const input = sendPathFixture();
	mutateJson(
		input.root,
		"work/B-1/g6-sharded-diagnostic.json",
		(diagnostic) => {
			const interval =
				diagnostic.sendPathDiagnostics.shards[0].final.components[0].phases[1]
					.intervals[0].histogram;
			interval.crossedPhase = 10;
		},
	);
	resealSendPathFixture(input);
	const result = evaluateSendPathAttribution(input),
		row = result.replicates[2];
	expect(result.evidenceValid).toBe(true);
	if (!row) throw Error("missing expected B-1 replicate");
	expect(row.phases.steady.native.intervals.reflectQueueWait).toMatchObject({
		count: 100,
		crossedPhase: 10,
		censored: 0,
		rejected: 0,
		overflow: 0,
		p99UpperBoundNs: 1_024_000,
	});
	expect(row.nativeHistogramBucketUpperBoundsNs).toHaveLength(31);
	expect(row.observedSocketBuffers).toMatchObject({
		scope: "last-observed-socket-per-server-pid",
		shards: [
			{
				serverId: 1,
				pid: 101,
				receiveBufferBytes: 212992,
				sendBufferBytes: 212992,
			},
		],
	});
	expect(result.replicates[0]?.observedSocketBuffers).toBeNull();
	const path = "work/B-1/g6-sharded-diagnostic.json";
	mutateJson(input.root, path, (diagnostic) => {
		const histogram =
			diagnostic.sendPathDiagnostics.shards[0].final.components[0].phases[1]
				.intervals[0].histogram;
		histogram.censored = 2;
		histogram.rejected = 3;
		histogram.buckets[10] = 98;
		histogram.buckets[31] = 2;
		histogram.overflow = 2;
	});
	resealSendPathFixture(input);
	const invalid = evaluateSendPathAttribution(input);
	expect(invalid.evidenceValid).toBe(false);
	expect(invalid.reasons.join(";")).toContain(
		"stored grade does not match raw evidence",
	);
	// Rejection preserves the raw diagnostic counts; it does not erase censoring.
	expect(
		JSON.parse(readFileSync(join(input.root, path), "utf8")).sendPathDiagnostics
			.shards[0].final.components[0].phases[1].intervals[0].histogram,
	).toMatchObject({ censored: 2, rejected: 3, overflow: 2 });
});
