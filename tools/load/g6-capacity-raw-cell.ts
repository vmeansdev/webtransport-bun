/** One raw per-cell boundary for online progression and independent final replay.
 * Callers supply authority from BIND, never from the raw cell being checked.
 * Campaign order, terminal transactions and paired calibration stay with callers.
 */
import {
	requireDefined,
	validateOperationReceipt,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import { validateHostIdentityPacket } from "./g6-c32-host.ts";
import type { WorkNode } from "./g6-c32-work-plan.ts";
import type { WorkProfile } from "./g6-c32-work-profile.ts";
import { validateCapacityDiagnosticCoverage } from "./g6-capacity-diagnostic-coverage.ts";
import {
	type RawPairIdentity,
	validateClientPorts,
	validateRawLifecycle,
	validateRawNumbers,
	validateScanCommand,
} from "./g6-capacity-raw-work.ts";
import type { NativeSendPathSnapshot } from "./g6-native-send-path.ts";
import type { ParsedLinuxProbeJsonl } from "./g6-sharded-diagnostic.ts";
import {
	G6_SHARDED_VALIDITY,
	type RungScan,
	steeredTotal,
} from "./g6-sharded-grade.ts";

export type CapacityBufferOperation = {
	receipt: unknown;
	stdout: string;
	stderr: string;
};
export type CapacityRawCellInput = {
	node: WorkNode;
	profile: WorkProfile;
	scan: RungScan;
	diagnostic: unknown;
	postRunSteeringText: string;
	probe: string | null;
	expectCandidate: string;
	registrationSha256: string;
	nativeProducerSha256: string;
	probeProducerSha256: string;
	operation: unknown;
	runId: string;
	pair: RawPairIdentity;
	scanStdout: string;
	scanStderr: string;
	owners: Record<"server" | "generator", unknown>;
	bufferOperations: Record<string, CapacityBufferOperation>;
};
export type ValidatedCapacityRawCell = {
	scan: RungScan;
	diagnostic: Record<string, unknown>;
	report: Record<string, unknown>;
	native: NativeSendPathSnapshot[];
	probe: ParsedLinuxProbeJsonl | null;
};

type Row = Record<string, unknown>;
function fail(message: string): never {
	throw Error(`g6-capacity-raw-cell: ${message}`);
}
function object(value: unknown, label: string): Row {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${label} must be structured evidence`);
	return value as Row;
}
function exact(value: unknown, keys: readonly string[], label: string): Row {
	const row = object(value, label);
	if (
		Object.keys(row).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(row, key))
	)
		fail(`${label} has missing or unknown fields`);
	return row;
}
function records(value: unknown, label: string): Row[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value.map((row) => object(row, label));
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string") fail(`${label} must be retained text`);
	return value;
}
function finite(value: unknown, label: string, positive = false): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		(positive && value === 0)
	)
		fail(
			`${label} must be ${positive ? "positive" : "nonnegative"} finite evidence`,
		);
	return value;
}
function count(value: unknown, label: string, positive = false): number {
	const result = finite(value, label, positive);
	if (!Number.isSafeInteger(result)) fail(`${label} must be a safe integer`);
	return result;
}
function sum(values: number[], label: string): number {
	return values.reduce((total, value) => count(total + value, label), 0);
}
function field(value: unknown, ...keys: string[]): unknown {
	return keys.reduce<unknown>((row, key) => object(row, key)[key], value);
}
function ms(value: unknown): number {
	return Date.parse(validateRfc3339Millis(value, "raw cell timestamp"));
}

function validatePair(input: CapacityRawCellInput): void {
	const pair = exact(input.pair, ["server", "generator"], "bound host pair");
	for (const role of ["server", "generator"] as const) {
		const host = validateHostIdentityPacket(pair[role]);
		if (
			host.envelope.runId !== input.runId ||
			host.provider.role !== role ||
			host.source.commit !== input.expectCandidate ||
			host.source.statusPorcelain !== "" ||
			host.runtime.os !== "Linux" ||
			host.binary.kind !== (role === "server" ? "native-addon" : "mmo-client")
		)
			fail(`${role} source/provenance differs from this frozen run`);
		if (
			host.provider.region !== "ric1" ||
			host.provider.size !== "g5-48vcpu-96gb-80gb" ||
			host.provider.vcpus !== 48 ||
			host.provider.memoryMiB !== 98304
		)
			fail(`${role} differs from approved exact host shape`);
	}
	const { server, generator } = input.pair;
	if (
		server.provider.id === generator.provider.id ||
		server.bootId === generator.bootId ||
		server.provider.privateIpv4 === generator.provider.privateIpv4 ||
		server.provider.publicIpv4 === generator.provider.publicIpv4 ||
		server.provider.vpcUuid !== generator.provider.vpcUuid ||
		server.source.tree !== generator.source.tree
	)
		fail("bound identities are not the exact distinct pair");
}

export function validateCapacityOwner(input: {
	owner: unknown;
	runId: string;
	nodeId: string;
	role: "server" | "generator";
	bootId: string;
}): void {
	const owner = exact(
		input.owner,
		[
			"schema",
			"runId",
			"nodeId",
			"role",
			"pid",
			"processGroupId",
			"startTicks",
			"bootId",
		],
		"process owner",
	);
	if (
		owner.schema !== "g6-c32-work-process-owner/1" ||
		owner.runId !== input.runId ||
		owner.nodeId !== input.nodeId ||
		owner.role !== input.role ||
		owner.bootId !== input.bootId ||
		count(owner.pid, "owner PID", true) <= 1 ||
		owner.processGroupId !== owner.pid ||
		typeof owner.startTicks !== "string" ||
		!/^[1-9][0-9]*$/.test(owner.startTicks)
	)
		fail(`${input.role} owner differs from frozen boot/run/node`);
}

export function validateCapacityAppliedBuffers(
	input: Pick<
		CapacityRawCellInput,
		"runId" | "node" | "profile" | "pair" | "operation" | "bufferOperations"
	>,
): void {
	const scan = validateOperationReceipt(input.operation);
	const settings = Object.fromEntries(
		["net.core.rmem_max", "net.core.rmem_default", "net.ipv4.udp_rmem_min"].map(
			(key) => [key, input.profile.receiveBufferBytes],
		),
	);
	const requests: {
		role: "server" | "generator";
		name: string;
		settings: Record<string, number>;
	}[] = [
		{ role: "server", name: "apply-buffer", settings },
		{ role: "generator", name: "apply-buffer-generator", settings },
	];
	if (input.profile.serverUdpSendBufferBytes > 0)
		requests.push({
			role: "server",
			name: "apply-server-sndbuf",
			settings: { "net.core.wmem_max": input.profile.serverUdpSendBufferBytes },
		});
	const operations = exact(
		input.bufferOperations,
		requests.map((request) => request.name),
		"buffer operations",
	);
	for (const request of requests) {
		const bundle = exact(
			operations[request.name],
			["receipt", "stdout", "stderr"],
			"buffer operation evidence",
		);
		const receipt = validateOperationReceipt(bundle.receipt);
		const assignments = Object.entries(request.settings);
		const prefix = `work/${input.node.id}/${request.name}`;
		text(bundle.stderr, "buffer stderr");
		if (
			receipt.envelope.runId !== input.runId ||
			receipt.envelope.operationId !== `${input.node.id}-${request.name}` ||
			receipt.envelope.phase !== "RUNNING" ||
			receipt.attempt !== 1 ||
			receipt.status.outcome !== "SUCCEEDED" ||
			receipt.status.exitCode !== 0 ||
			receipt.status.signal !== null ||
			receipt.envelope.sequence >= scan.envelope.sequence ||
			ms(receipt.finishedAt) > ms(scan.startedAt) ||
			receipt.stdoutPath !== `${prefix}.stdout` ||
			receipt.stderrPath !== `${prefix}.stderr` ||
			receipt.action.command !== "g6_ssh" ||
			receipt.action.args.length !== 2 ||
			receipt.action.args[0] !==
				`root@${input.pair[request.role].provider.publicIpv4}` ||
			receipt.action.args[1] !==
				`sysctl -w ${assignments.map(([key, value]) => `${key}=${value}`).join(" ")}` ||
			text(bundle.stdout, "buffer stdout").trimEnd().replace(/\r\n/g, "\n") !==
				assignments.map(([key, value]) => `${key} = ${value}`).join("\n")
		)
			fail(
				`${request.role} applied buffer settings differ from the frozen producer operation`,
			);
	}
	// These sysctls are applied configuration, not an exact per-socket reading.
	// Linux doubles explicit SO_RCVBUF requests; the probe observes one socket/PID.
}

function validateAttributionInputs(
	scan: Row,
	report: Row,
	native: NativeSendPathSnapshot[],
	probeText: string | null,
	probe: ParsedLinuxProbeJsonl | null,
): void {
	const shards = records(scan.shards, "scan shards");
	const cpu = finite(
		shards.reduce(
			(total, shard) =>
				total +
				finite(
					field(shard, "windows", "steady", "cpuMs"),
					"steady process CPU",
				),
			0,
		),
		"summed steady CPU",
	);
	const wall = Math.max(
		...shards.map((shard) =>
			finite(
				field(shard, "windows", "steady", "wallMs"),
				"steady wall time",
				true,
			),
		),
	);
	const aggregateCpu = finite(
		field(scan, "aggregate", "steady", "cpuMs"),
		"aggregate CPU",
	);
	if (
		Math.abs(aggregateCpu - cpu) >
			Math.abs(aggregateCpu) * 1e-12 +
				Number.EPSILON * Math.max(1, aggregateCpu, cpu) * 8 ||
		field(scan, "aggregate", "steady", "wallMsMax") !== wall
	)
		fail("raw CPU aggregate differs from shards");
	for (const name of [
		"udpSendBatchErrors",
		"udpSendBatchCongestionDropped",
		"datagramReflectRingBypassed",
		"datagramReflectRingBypassMarked",
		"datagramReflectRingDirectBlocked",
		"datagramReflectRingDirectErrors",
		"datagramReflectRingGsoFallback",
	])
		sum(
			shards.map((shard) =>
				count(field(shard, "windows", "lifetime", "metrics", name), name),
			),
			name,
		);
	count(
		field(report, "windows", "steadyDrain", "rxSnapshot"),
		"client delivered snapshots",
		true,
	);
	// Final attribution summarizes these banks across components. Validate the
	// sums too: individually safe counters do not imply a safe aggregate.
	const histogramSums = new Map<string, number>();
	const add = (key: string, value: number) => {
		histogramSums.set(key, count((histogramSums.get(key) ?? 0) + value, key));
	};
	for (const snapshot of native)
		for (const component of snapshot.components) {
			for (const bank of component.phases) {
				if (bank.phase === "unarmed") continue;
				for (const { name, histogram } of bank.intervals) {
					for (const field of [
						"count",
						"crossedPhase",
						"outstanding",
						"censored",
						"rejected",
						"overflow",
					] as const)
						add(`${bank.phase}.${name}.${field}`, histogram[field]);
					histogram.buckets.forEach((value, index) => {
						add(`${bank.phase}.${name}.bucket${index}`, value);
					});
				}
			}
			for (const { name, gauge } of component.gauges)
				gauge.phaseHighWater.forEach((value, index) => {
					if (index > 0) add(`${name}.highWater${index}`, value);
				});
		}
	if (probe && probeText !== null) {
		const summary = object(probe.summary.summary, "probe CPU summary");
		finite(summary.probeUserSec, "observer user CPU");
		finite(summary.probeSysSec, "observer system CPU");
		for (const line of probeText.trim().split("\n")) {
			const row = object(JSON.parse(line), "probe record");
			if (row.schema === "g6-c32-linux-probe-queue/2")
				for (const key of ["rxQueueBytes", "txQueueBytes", "drops"])
					sum(
						records(row.shards, "probe queue shards").map((shard) =>
							count(shard[key], key),
						),
						key,
					);
			if (row.schema === "g6-c32-linux-probe-sched/2")
				for (const key of ["runtimeNs", "waitNs", "timeslices"])
					sum(
						records(row.sched, "probe scheduler shards").map((shard) =>
							count(shard[key], key),
						),
						key,
					);
		}
	}
}

export function validateCapacityRawCell(
	input: CapacityRawCellInput,
): ValidatedCapacityRawCell {
	const { node, profile: p } = input;
	if (
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(text(input.runId, "run ID")) ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(text(node.id, "node ID")) ||
		!/^[a-f0-9]{40}$/.test(input.expectCandidate) ||
		[
			input.registrationSha256,
			input.nativeProducerSha256,
			input.probeProducerSha256,
		].some(
			(value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
		) ||
		p.nativeDiagnostics !== true ||
		p.pacerPps !== 0
	)
		fail("missing or invalid frozen cell authority");
	validatePair(input);
	const operation = validateOperationReceipt(input.operation);
	const prefix = `work/${node.id}/scan`;
	if (
		operation.envelope.runId !== input.runId ||
		operation.envelope.operationId !== `${node.id}-scan` ||
		operation.attempt !== 1 ||
		operation.action.command !== "work_scan" ||
		operation.status.outcome !== "SUCCEEDED" ||
		operation.status.exitCode !== 0 ||
		operation.status.signal !== null ||
		operation.stdoutPath !== `${prefix}.stdout` ||
		operation.stderrPath !== `${prefix}.stderr` ||
		BigInt(operation.durationMonotonicNs) <
			BigInt(G6_SHARDED_VALIDITY.steadySeconds) * 1_000_000_000n ||
		BigInt(operation.durationMonotonicNs) >
			BigInt(count(node.maximumSeconds, "cell maximum", true)) * 1_000_000_000n
	)
		fail("scan lacks its exact successful bounded work operation");
	text(input.scanStderr, "scan stderr");
	const scan = object(input.scan, "scan"),
		diagnostic = object(input.diagnostic, "diagnostic");
	if (
		scan.schema !== "g6-sharded-scan/3" ||
		diagnostic.schema !== "g6-sharded-diagnostic/3" ||
		scan.candidateSha !== input.expectCandidate ||
		diagnostic.candidateSha !== input.expectCandidate ||
		diagnostic.startedAt !== scan.startedAt ||
		ms(scan.startedAt) < ms(operation.startedAt) ||
		ms(scan.startedAt) > ms(operation.finishedAt)
	)
		fail("scan/diagnostic schema, source or timestamp differs from this cell");
	validateScanCommand(
		operation,
		text(input.scanStdout, "scan stdout"),
		{
			objective: { sourceSha: input.expectCandidate },
			ladder: { profile: p, registrationSha256: input.registrationSha256 },
		},
		input.pair,
		node.requestedSessions,
		node.activeWorkloadSessions,
		text(scan.startedAt, "scan start"),
		p.detailedProbe,
	);
	const config = object(scan.config, "scan.config"),
		dispatch = object(diagnostic.dispatch, "diagnostic.dispatch");
	const expected = {
		shards: p.shards,
		sessions: node.requestedSessions,
		activeWorkloadSessions: node.activeWorkloadSessions,
		paced: false,
		emitterMode: "native-mirror",
		endpoints: p.endpoints,
		connectConcurrency: p.connectConcurrency,
		connectRatePerSec: p.connectRatePerSec,
		fixedSourcePortBase: p.fixedSourcePortBase,
		ackReflector: p.ackReflector,
		serverWorkers: p.serverWorkers,
		serverGro: p.serverGro,
		serverRecvRuntime: p.serverRecvRuntime,
		ackCadence: p.ackCadence,
		serverUdpSendBufferBytes: p.serverUdpSendBufferBytes,
		udpSendBatch: p.udpSendBatch,
		serverUdpSendEagainMode: p.serverUdpSendEagainMode,
		reflectRingBypass: p.reflectRingBypass,
		...(p.datagramPump === undefined ? {} : { datagramPump: p.datagramPump }),
	};
	for (const [key, value] of Object.entries(expected))
		if (config[key] !== value || dispatch[key] !== value)
			fail(`raw ${key} differs from frozen profile`);
	// The diagnostic dispatch has no process count; the scan config echoes it.
	if (
		p.clientProcesses !== undefined &&
		config.clientProcesses !== p.clientProcesses
	)
		fail("raw clientProcesses differs from frozen profile");
	if (
		config.steadySeconds !== G6_SHARDED_VALIDITY.steadySeconds ||
		![null, 0, "0"].includes(config.pacerPps as null | number | string)
	)
		fail("raw duration or pacing differs from frozen workload");
	const lines = text(scan.clientStdout, "client stdout")
		.split(/\r?\n/)
		.filter((line) => line.startsWith("mmo-client: json "));
	if (lines.length !== 1) fail("missing or duplicate raw client report");
	const report = object(
		JSON.parse(requireDefined(lines[0]).slice("mmo-client: json ".length)),
		"client report",
	);
	if (
		report.schema !== "mmo-client/2" ||
		report.startedAt !== scan.startedAt ||
		report.sessionsRequested !== node.requestedSessions ||
		report.activeWorkloadSessions !== node.activeWorkloadSessions ||
		field(report, "preRegistration", "sha256") !== input.registrationSha256 ||
		report.connectConcurrency !== p.connectConcurrency ||
		report.connectRatePerSec !== p.connectRatePerSec ||
		field(report, "config", "fixedSourcePortBase") !== p.fixedSourcePortBase ||
		field(report, "connectStarts", "offered") !== node.requestedSessions ||
		field(report, "connectStarts", "achieved") !== node.requestedSessions
	)
		fail(
			"raw client differs from frozen source, start, configuration or workload",
		);
	validateClientPorts(report, p);
	validateRawNumbers(scan, report);
	validateRawLifecycle(diagnostic, scan, operation, p.shards);
	const steering = steeredTotal(
		text(input.postRunSteeringText, "post-run steering"),
	);
	const witness = object(
		diagnostic.postRunSteering,
		"post-run steering witness",
	);
	const capturedAt = finite(witness.capturedAtMs, "post-run steering time");
	if (
		typeof steering !== "number" ||
		!Number.isSafeInteger(steering) ||
		steering < 0 ||
		capturedAt < ms(operation.startedAt) ||
		capturedAt > ms(operation.finishedAt) ||
		field(witness, "steerStatsSum", "steered") !== steering
	)
		fail("post-run steering witness differs from this scan operation");
	const owners = exact(input.owners, ["server", "generator"], "process owners");
	for (const role of ["server", "generator"] as const)
		validateCapacityOwner({
			owner: owners[role],
			runId: input.runId,
			nodeId: node.id,
			role,
			bootId: input.pair[role].bootId,
		});
	validateCapacityAppliedBuffers(input);
	const { native, probe } = validateCapacityDiagnosticCoverage({
		diagnostic,
		profile: p,
		nativeProducerSha256: input.nativeProducerSha256,
		probeProducerSha256: input.probeProducerSha256,
		probeText: input.probe,
		operation,
	});
	const binding = object(diagnostic.linuxProbe, "Linux probe binding"),
		mode = object(binding.measurementMode, "Linux probe mode");
	if (p.detailedProbe) {
		if (probe === null) fail("missing validated Linux probe");
		const lifecycle = records(diagnostic.perShardLifecycle, "probe lifecycle");
		if (
			binding.enabled !== true ||
			binding.stoppedCleanly !== true ||
			mode.detail !== "on" ||
			mode.phaseAware !== true ||
			probe.shards.length !== p.shards ||
			probe.shards.some(
				(shard) =>
					lifecycle.filter(
						(row) => row.serverId === shard.serverId && row.pid === shard.pid,
					).length !== 1,
			)
		)
			fail(
				"Linux probe mode, cleanup or PID membership differs from this cell",
			);
	} else if (
		input.probe !== null ||
		binding.enabled !== false ||
		binding.out !== null ||
		binding.maxBytes !== null ||
		binding.producerSha256 !== null ||
		binding.stoppedCleanly !== false ||
		mode.detail !== "off" ||
		mode.phaseAware !== true
	)
		fail("cell lacks explicit probe-off evidence");
	if (node.kind === "attribution" || node.kind === "attribution-r4")
		validateAttributionInputs(scan, report, native, input.probe, probe);
	return { scan: input.scan, diagnostic, report, native, probe };
}
