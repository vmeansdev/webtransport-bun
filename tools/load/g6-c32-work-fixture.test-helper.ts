/** Synthetic local work-plan fixtures. Never a live evidence adapter. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSpendLedgerEntry,
	type BudgetPolicy,
	budgetPolicyArtifactSha256,
	validateBudgetPolicy,
} from "./g6-c32-budget.ts";
import {
	makeAttributionWorkPlan,
	makeCandidateAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
} from "./g6-c32-capacity-work.ts";
import {
	cleanScan,
	diagnosticFixture,
	steeringDump,
	TEST_CANDIDATE,
	TEST_REGISTRATION,
} from "./g6-c32-evaluator-fixture.test-helper.ts";
import {
	type OperationReceipt,
	requireDefined,
} from "./g6-c32-freeze-model.ts";
import { validateHostIdentityPacket } from "./g6-c32-host.ts";
import { initializeWorkExecution } from "./g6-c32-work-execution.ts";
import type { WorkNode } from "./g6-c32-work-plan.ts";
import {
	makeAttributionWorkProfiles,
	makeCandidateAttributionWorkProfiles,
	makeCandidateLadderWorkProfiles,
	type WorkProfile,
} from "./g6-c32-work-profile.ts";
import type { RawPairIdentity } from "./g6-capacity-raw-work.ts";
import {
	validateWorkAuthority,
	type WorkAuthority,
} from "./g6-capacity-work-authority.ts";
import {
	linuxProbeFixture,
	linuxProbeFixtureText,
} from "./g6-linux-probe-fixture.ts";
import {
	NATIVE_PHASES,
	type NativeSendPathSnapshot,
} from "./g6-native-send-path.ts";

/** Explicit synthetic identities; these packets never assert a real prepared host. */
export function workPairFixture(
	runId = "test-work-a",
	candidateSha = TEST_CANDIDATE,
): RawPairIdentity {
	const packet = (role: "server" | "generator", index: number) =>
		validateHostIdentityPacket({
			schema: "g6-c32-host-identity/1",
			envelope: {
				recordedAt: "2026-09-04T00:00:30.000Z",
				sequence: index + 1,
				runId,
				phase: "BINDING",
				operationId: `collect-identity-${role}`,
				clockSource: role,
			},
			provider: {
				id: 101 + index,
				role,
				name: `${runId}-${role}`,
				tags: ["g6-c32-managed", runId],
				region: "ams3",
				size: "c-48-intel",
				image: "ubuntu-24-04-x64",
				vpcUuid: "fixture-vpc",
				projectId: null,
				sshKeyIds: [77],
				vcpus: 48,
				memoryMiB: 98304,
				status: "active",
				createdAt: "2026-09-04T00:00:00.000Z",
				publicIpv4: `203.0.113.${10 + index}`,
				privateIpv4: `10.0.0.${10 + index}`,
			},
			bootId:
				index === 0
					? "11111111-1111-4111-8111-111111111111"
					: "22222222-2222-4222-8222-222222222222",
			source: {
				commit: candidateSha,
				tree: "f".repeat(40),
				statusPorcelain: "",
			},
			runtime: {
				os: "Linux",
				osRelease: "Ubuntu 24.04.4 LTS",
				kernel: "6.8.0-fixture",
				bunVersion: "1.3.14",
				rustcVersion: "rustc fixture",
				cargoVersion: "cargo fixture",
			},
			binary: {
				kind: index === 0 ? "native-addon" : "mmo-client",
				path: `/opt/g6/source/${role}`,
				sha256: (index ? "d" : "e").repeat(64),
			},
			clock: {
				requestStartedAt: "2026-09-04T00:00:29.900Z",
				responseFinishedAt: "2026-09-04T00:00:30.100Z",
				remoteWallAt: "2026-09-04T00:00:30.000Z",
				measuredSkewMilliseconds: 0,
			},
		});
	return { server: packet("server", 0), generator: packet("generator", 1) };
}

/** Unit-only capsule. Full campaign fixtures derive this object from their BIND. */
export function workAuthorityFixture(
	policy: BudgetPolicy = workPolicyFixture(),
): WorkAuthority {
	return validateWorkAuthority({
		schema: "g6-capacity-work-authority/1",
		runId: policy.runId,
		candidateSha: TEST_CANDIDATE,
		registrationSha256: TEST_REGISTRATION,
		nativeProducerSha256: "c".repeat(64),
		probeProducerSha256: "d".repeat(64),
		policySha256: budgetPolicyArtifactSha256(policy),
		pair: workPairFixture(policy.runId),
		semanticFreezeAuthoritySha256: "1".repeat(64),
		semanticFreezeArtifactSha256: "2".repeat(64),
		hostBindingArtifactSha256: "3".repeat(64),
		dispatchFreezeArtifactSha256: "4".repeat(64),
	});
}

export const workProfileFixture: WorkProfile = {
	shards: 24,
	endpoints: 128,
	connectConcurrency: 50,
	connectRatePerSec: 250,
	fixedSourcePortBase: 20_000,
	receiveBufferBytes: 26_214_400,
	gradeMode: "historical",
	ackReflector: "native",
	serverWorkers: 3,
	serverGro: "off",
	serverRecvRuntime: "shared",
	ackCadence: "default",
	pacerPps: 0,
	udpSendBatch: 0,
	serverUdpSendBufferBytes: 0,
	serverUdpSendEagainMode: "wait",
	reflectRingBypass: "off",
	detailedProbe: true,
	nativeDiagnostics: true,
};
type HostUdpSample = {
	InErrors: number;
	RcvbufErrors: number;
	SndbufErrors: number;
};
export type WorkGradeFixtureDiagnostic = {
	schema: string;
	candidateSha: string;
	startedAt: string;
	dispatch: Record<string, unknown>;
	postRunSteering: { capturedAtMs: number };
	ladder: Array<{
		T1: { hostLoad: { gro: string } };
		T2: { hostLoad: { gro: string } };
	}>;
	perShardLifecycle: Array<{
		serverId: number;
		pid?: number;
		boundaries: Array<{ phase: string; tsMs: number }>;
		exits: Array<{ code: number; signal: null; tsMs: number }>;
	}>;
	linuxProbe: {
		enabled: boolean;
		out: string | null;
		maxBytes: number | null;
		measurementMode: { detail: "off" | "on"; phaseAware: boolean };
		producerSha256: string | null;
		stoppedCleanly: boolean;
	};
	sendPathDiagnostics: {
		enabled: boolean;
		measurementMode: "on";
		producerSha256: string;
		shards: Array<{
			serverId: number;
			pid: number;
			boundaries: Record<
				(typeof NATIVE_PHASES)[number] | "stop",
				NativeSendPathSnapshot
			>;
			final: NativeSendPathSnapshot;
		}>;
	};
	serverHostUdp: Record<"connect" | "steady" | "drain" | "idle", HostUdpSample>;
};
export type WorkGradeFixture = {
	runId: string;
	pair: RawPairIdentity;
	node: WorkNode;
	profile: WorkProfile;
	scan: ReturnType<typeof cleanScan> & { startedAt: string };
	diagnostic: WorkGradeFixtureDiagnostic;
	postRunSteeringText: string;
	probe: string | null;
	expectCandidate: typeof TEST_CANDIDATE;
	registrationSha256: typeof TEST_REGISTRATION;
	nativeProducerSha256: string;
	probeProducerSha256: string;
	operation: ReturnType<typeof operationFixture>;
	scanStdout: string;
	scanStderr: string;
	owners: Record<
		"server" | "generator",
		{
			schema: string;
			runId: string;
			nodeId: string;
			role: string;
			pid: number;
			processGroupId: number;
			startTicks: string;
			bootId: string;
		}
	>;
	bufferOperations: Record<
		string,
		{ receipt: OperationReceipt; stdout: string; stderr: string }
	>;
};

/** Canonical producer witness; call again only when a test intentionally changes start identity. */
export function workScanWitness(input: {
	node: WorkNode;
	profile: WorkProfile;
	runId: string;
	pair: RawPairIdentity;
	startedAt: string;
	candidateSha?: string;
	registrationSha256?: string;
}): { action: OperationReceipt["action"]; stdout: string } {
	const { node, profile: p, runId, pair, startedAt } = input;
	const remote = `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${runId}/cells/work-${node.id}`;
	const env = {
		SCAN_DIAGNOSTIC: 1,
		SCAN_NATIVE_SEND_PATH_DIAGNOSTICS: 1,
		SCAN_SHARDS: p.shards,
		SCAN_SESSIONS: node.requestedSessions,
		SCAN_WORKLOAD_ACTIVE_SESSIONS: node.activeWorkloadSessions,
		SCAN_ENDPOINTS: p.endpoints,
		SCAN_CONNECT_CONCURRENCY: p.connectConcurrency,
		SCAN_CONNECT_RATE_PER_SEC: p.connectRatePerSec,
		SCAN_FIXED_SOURCE_PORT_BASE: p.fixedSourcePortBase,
		SCAN_ACK_REFLECTOR: p.ackReflector,
		SCAN_SERVER_WORKERS: p.serverWorkers,
		SCAN_SERVER_GRO: p.serverGro,
		SCAN_SERVER_RECV_RUNTIME: p.serverRecvRuntime,
		SCAN_ACK_CADENCE: p.ackCadence,
		SCAN_SERVER_UDP_SNDBUF_BYTES: p.serverUdpSendBufferBytes,
		SCAN_UDP_SEND_BATCH: p.udpSendBatch,
		SCAN_SERVER_UDP_SEND_EAGAIN_MODE: p.serverUdpSendEagainMode,
		SCAN_REFLECT_RING_BYPASS: p.reflectRingBypass,
		...(p.datagramPump === undefined
			? {}
			: { SCAN_DATAGRAM_PUMP: p.datagramPump }),
		G6_BPF_READY_RECEIPT: `${remote}/g6-shard-bpf-ready.json`,
		SCAN_LINUX_PROBE_ENABLED: p.detailedProbe ? 1 : 0,
		SCAN_LINUX_PROBE_OUT: `${remote}/linux-probe.jsonl`,
		SCAN_POST_RUN_STEERING_OUT: `${remote}/post-run-steering.json`,
		SCAN_OUT: `${remote}/g6-sharded-scan.json`,
		SCAN_DIAGNOSTIC_OUT: `${remote}/g6-sharded-diagnostic.json`,
		G6_OFFBOX_SSH: `root@${pair.generator.provider.privateIpv4}`,
		G6_OFFBOX_ENTRY_SCRIPT:
			"/opt/g6/source/tools/offbox/linux-generator-entry-g6.sh",
		G6_OFFBOX_CLONE: "/opt/g6/source",
		G6_OFFBOX_WORK_RUN_ID: runId,
		G6_OFFBOX_WORK_NODE_ID: node.id,
		G6_OFFBOX_WORK_ROOT: `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${runId}`,
		G6_OFFBOX_WORK_BOOT_ID: pair.generator.bootId,
		G6_CANDIDATE_SHA: input.candidateSha ?? TEST_CANDIDATE,
		G6_PREREGISTRATION_SHA256: input.registrationSha256 ?? TEST_REGISTRATION,
		G6_SERVER_ADDRESS: pair.server.provider.privateIpv4,
		G6_EMITTER_MODE: "native-mirror",
	};
	return {
		action: {
			command: "work_scan",
			args: [
				node.id,
				remote,
				"env",
				`${Object.entries(env)
					.map(([key, value]) => `${key}=${value}`)
					.join(
						" ",
					)} bash -lc "cd '/opt/g6/source' && exec '/usr/local/bin/bun' tools/load/g6-sharded-scan.ts"`,
			],
			cwd: ".",
			environmentKeys: [],
		},
		stdout: `g6-sharded-scan: shards=${p.shards} sessions=${node.requestedSessions} paced=false url=https://${pair.server.provider.privateIpv4}:4433 started-at=${startedAt}\ng6-sharded-scan: client exited 0\ng6-sharded-scan: wrote ${remote}/g6-sharded-scan.json\ng6-sharded-scan: wrote ${remote}/g6-sharded-diagnostic.json\n`,
	};
}
const phaseTimes = [
	1n,
	100_000_000n,
	150_000_000n,
	120_150_000_000n,
	120_200_000_000n,
];
function nativeSnapshot(
	index: number,
	batch: number,
	finalized = false,
): NativeSendPathSnapshot {
	const phase = requireDefined(NATIVE_PHASES[index]);
	return {
		schema: "g6-native-send-path/1",
		enabled: true,
		finalized,
		phase,
		monoNs: String(
			requireDefined(phaseTimes[index]) + (finalized ? 50_000_000n : 1n),
		),
		phaseOrder: [...NATIVE_PHASES],
		bucketUpperBoundsNs: Array.from({ length: 31 }, (_, i) => 1000 * 2 ** i),
		errors: 0,
		components:
			index === 0
				? []
				: (["reflector", ...(batch ? ["udp-socket"] : [])] as const).map(
						(kind) => ({
							kind: kind as "reflector" | "udp-socket",
							phase,
							createdPhase: "connect",
							createdNs: String(phaseTimes[1]),
							errors: 0,
							cuts: NATIVE_PHASES.slice(2, index + 1).map((phase, i) => ({
								phase,
								beginNs: String(phaseTimes[i + 2]),
								endNs: String(phaseTimes[i + 2]),
							})),
							phases: NATIVE_PHASES.slice(1).map((phase) => ({
								phase,
								intervals: [
									"reflectQueueWait",
									"reflectSendCall",
									"ringFull",
									"flusherEagain",
									"udpQueueWait",
								].map((name, i) => {
									const count =
										finalized &&
										phase === "steady" &&
										(kind === "reflector" ? i < 2 : i >= 2)
											? 100
											: 0;
									const buckets: number[] = Array(32).fill(0);
									buckets[10 + i] = count;
									return {
										name,
										histogram: {
											count,
											buckets,
											crossedPhase: 0,
											outstanding: 0,
											censored: 0,
											rejected: 0,
											overflow: 0,
										},
									};
								}),
							})),
							gauges: [
								"reflectReservedSlots",
								"udpPendingPackets",
								"udpPendingBytes",
								"waiterRegistrations",
							].map((name) => ({
								name,
								gauge: {
									current: 0,
									phase: index,
									phaseHighWater: [0, 0, index >= 2 ? 1 : 0, 0, 0],
								},
							})),
						}),
					),
	};
}

/** Full-rate raw fixture: real 10/50 ms sample cadence over a synthetic 120 s steady interval. */
export function workProbeFixture(
	startedAt: string,
	shards = 1,
	steadyMs = 120000,
): string {
	const rows = linuxProbeFixture(shards),
		queue = requireDefined(
			rows.find(
				(row) =>
					row.phase === "steady" && row.schema === "g6-c32-linux-probe-queue/2",
			),
		),
		sched = requireDefined(
			rows.find(
				(row) =>
					row.phase === "steady" && row.schema === "g6-c32-linux-probe-sched/2",
			),
		),
		generated: typeof rows = [],
		queueCount = steadyMs / 10,
		schedCount = steadyMs / 50,
		deltaNs = BigInt(steadyMs - 50) * 1_000_000n;
	if (
		!Number.isInteger(queueCount) ||
		!Number.isInteger(schedCount) ||
		schedCount < 1
	)
		throw Error("invalid synthetic steady interval");
	for (let tick = 0; tick < queueCount; tick++) {
		const monotonicNs = String(
			150_000_000n + 5_000_000n + BigInt(tick) * 10_000_000n,
		);
		generated.push({ ...queue, monotonicNs });
		if (tick % 5 === 0) {
			const delta = tick / 5;
			generated.push({
				...sched,
				monotonicNs,
				netRx: sched.netRx + delta,
				softnet: {
					...sched.softnet,
					processed: sched.softnet.processed + delta,
				},
				sched: sched.sched.map((thread: Record<string, number>) => ({
					...thread,
					runtimeNs: requireDefined(thread.runtimeNs) + delta,
					waitNs: requireDefined(thread.waitNs) + delta,
					timeslices: requireDefined(thread.timeslices) + delta,
				})),
			});
		}
	}
	rows.splice(rows.indexOf(queue), 6, ...generated);
	for (const row of rows)
		if (
			row.phase === "drain" ||
			row.phase === "idle" ||
			row.schema === "g6-c32-linux-probe/2"
		) {
			row.monotonicNs = String(BigInt(row.monotonicNs) + deltaNs);
			if (row.sched) {
				row.netRx += schedCount - 1;
				row.softnet.processed += schedCount - 1;
				for (const thread of row.sched)
					for (const key of ["runtimeNs", "waitNs", "timeslices"])
						thread[key] += schedCount - 1;
			}
		}
	const header = requireDefined(rows[0]),
		footer = requireDefined(rows.at(-1));
	header.startedAt = startedAt;
	header.producerSha256 = "d".repeat(64);
	footer.producerSha256 = header.producerSha256;
	footer.endedAt = new Date(
		Date.parse(startedAt) + steadyMs + 150,
	).toISOString();
	footer.queueSamples += queueCount - 5;
	footer.schedSamples += schedCount - 1;
	footer.phaseCoverage.steady = {
		queueSamples: queueCount,
		schedSamples: schedCount,
	};
	for (const phase of ["drain", "idle"])
		footer.phaseBoundaries[phase].monotonicNs = String(
			BigInt(footer.phaseBoundaries[phase].monotonicNs) + deltaNs,
		);
	return linuxProbeFixtureText(rows);
}

export function workGradeFixture(
	options: {
		node?: WorkNode;
		profile?: WorkProfile;
		startedAt?: string;
		sequence?: number;
		runId?: string;
		pair?: RawPairIdentity;
	} = {},
): WorkGradeFixture {
	const node =
		options.node ?? requireDefined(makeAttributionWorkPlan().nodes[0]);
	const profile =
		options.profile ??
		requireDefined(
			makeAttributionWorkProfiles(workProfileFixture)[node.profile],
		);
	const startedAt = options.startedAt ?? "2026-09-05T00:02:11.000Z",
		startMs = Date.parse(startedAt),
		runId = options.runId ?? "test-work-a",
		pair = options.pair ?? workPairFixture(runId),
		remote = `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${runId}/cells/work-${node.id}`;
	const scan = Object.assign(
		cleanScan(node.requestedSessions, profile, profile.shards),
		{ startedAt },
	);
	Object.assign(scan.config, profile, {
		activeWorkloadSessions: node.activeWorkloadSessions,
		pacerPps: null,
	});
	const client = JSON.parse(
		scan.clientStdout.slice("mmo-client: json ".length),
	);
	client.startedAt = startedAt;
	client.activeWorkloadSessions = node.activeWorkloadSessions;
	client.client.endpointSourceAddresses = Array.from(
		{ length: profile.endpoints },
		(_, index) =>
			`0.0.0.0:${requireDefined(profile.fixedSourcePortBase) + index}`,
	);
	client.windows.steady.sent = node.activeWorkloadSessions * 4 * 120;
	client.windows.steadyDrain.rxSnapshot =
		node.activeWorkloadSessions * 15 * 120;
	// r5 profiles: the generator reports the datagram path it actually ran.
	if (profile.datagramPump !== undefined)
		client.datagramDriver = {
			mode: profile.datagramPump,
			pumpsSpawned:
				profile.datagramPump === "pump" ? node.requestedSessions : 0,
			pumpsLive: 0,
		};
	scan.clientStdout = `mmo-client: json ${JSON.stringify(client)}\n`;
	const share = (total: number, index: number) =>
		Math.floor(total / profile.shards) +
		(index < total % profile.shards ? 1 : 0);
	for (const [index, shard] of scan.shards.entries()) {
		const windows = requireDefined(shard.windows);
		const lifetime = requireDefined(windows.lifetime);
		for (const phase of ["steady", "steadyDrain", "lifetime"] as const) {
			const window = requireDefined(windows[phase]);
			window.rxTotal = share(node.activeWorkloadSessions * 4 * 120, index);
			window.emitter.snapshotIssued = share(
				node.activeWorkloadSessions * 15 * 120,
				index,
			);
		}
		Object.assign(windows.steady, { cpuMs: share(240000, index) });
		if (node.kind === "companion")
			Object.assign(shard, {
				sessionsByKindAtSteady: {
					player: share(node.activeWorkloadSessions, index),
					raid: share(
						node.requestedSessions - node.activeWorkloadSessions,
						index,
					),
					publisher: 0,
				},
			});
		Object.assign(requireDefined(lifetime.metrics), {
			udpSendBatchErrors: 0,
			datagramReflectRingBypassed:
				profile.reflectRingBypass === "on" ? share(100, index) : 0,
		});
	}
	for (const phase of ["steady", "steadyDrain", "lifetime"] as const) {
		const windows = scan.shards.map((shard) =>
			requireDefined(requireDefined(shard.windows)[phase]),
		);
		Object.assign(requireDefined(scan.aggregate[phase]), {
			rxTotal: windows.reduce((sum, window) => sum + window.rxTotal, 0),
			emitter: Object.fromEntries(
				(["snapshotIssued", "sendErrors"] as const).map((key) => [
					key,
					windows.reduce((sum, window) => sum + window.emitter[key], 0),
				]),
			),
		});
	}
	Object.assign(scan.aggregate.steady, { cpuMs: 240000, wallMsMax: 120000 });
	if (node.kind === "companion")
		Object.assign(requireDefined(scan.aggregate.lifetime), {
			rxByClass: {
				raidJoin: node.requestedSessions - node.activeWorkloadSessions,
			},
		});
	Object.assign(
		requireDefined(requireDefined(scan.aggregate.lifetime).metrics),
		{
			udpSendBatchErrors: 0,
			datagramReflectRingBypassed: profile.reflectRingBypass === "on" ? 100 : 0,
			...(profile.datagramPump === undefined
				? {}
				: {
						datagramPumpsSpawned:
							profile.datagramPump === "pump" ? node.requestedSessions : 0,
					}),
		},
	);
	const diagnostic = diagnosticFixture({
		sessions: node.requestedSessions,
		shape: profile,
		shards: profile.shards,
		drops: 0,
		steered: 30_000_000,
	}) as WorkGradeFixtureDiagnostic;
	diagnostic.startedAt = startedAt;
	Object.assign(diagnostic.dispatch, scan.config);
	diagnostic.postRunSteering.capturedAtMs = startMs + 120500;
	for (const row of diagnostic.perShardLifecycle) {
		row.boundaries = ["connect", "steady", "drain", "idle", "stop"].map(
			(phase, index) => ({
				phase,
				tsMs: startMs + requireDefined([0, 50, 120050, 120100, 120200][index]),
			}),
		);
		row.exits = [{ code: 0, signal: null, tsMs: startMs + 120300 }];
	}
	const firstLadder = requireDefined(diagnostic.ladder[0]);
	firstLadder.T1 = { hostLoad: { gro: "off" } };
	firstLadder.T2.hostLoad = { gro: "off" };
	diagnostic.linuxProbe = {
		enabled: profile.detailedProbe,
		out: profile.detailedProbe ? `${remote}/linux-probe.jsonl` : null,
		maxBytes: profile.detailedProbe ? 128 * 1024 * 1024 : null,
		measurementMode: {
			detail: profile.detailedProbe ? "on" : "off",
			phaseAware: true,
		},
		stoppedCleanly: profile.detailedProbe,
		producerSha256: profile.detailedProbe ? "d".repeat(64) : null,
	};
	diagnostic.sendPathDiagnostics = {
		enabled: true,
		measurementMode: "on",
		producerSha256: "c".repeat(64),
		shards: diagnostic.perShardLifecycle.map((row, i) => {
			row.pid = i + 101;
			return {
				serverId: row.serverId,
				pid: row.pid,
				boundaries: Object.fromEntries([
					...NATIVE_PHASES.map((phase, i) => [
						phase,
						nativeSnapshot(i, profile.udpSendBatch),
					]),
					[
						"stop",
						{
							...nativeSnapshot(4, profile.udpSendBatch),
							monoNs: "120225000000",
						},
					],
				]) as WorkGradeFixtureDiagnostic["sendPathDiagnostics"]["shards"][number]["boundaries"],
				final: nativeSnapshot(4, profile.udpSendBatch, true),
			};
		}),
	};
	const operation = operationFixture(
		`${node.id}-scan`,
		options.sequence ?? 7,
		startedAt,
		new Date(startMs + 121000).toISOString(),
	);
	operation.envelope.runId = runId;
	operation.stdoutPath = `work/${node.id}/scan.stdout`;
	operation.stderrPath = `work/${node.id}/scan.stderr`;
	const witness = workScanWitness({ node, profile, runId, pair, startedAt });
	operation.action = witness.action;
	const owner = (role: "server" | "generator", index: number) => ({
		schema: "g6-c32-work-process-owner/1",
		runId,
		nodeId: node.id,
		role,
		pid: 1000 + index,
		processGroupId: 1000 + index,
		startTicks: String(2000 + index),
		bootId: pair[role].bootId,
	});
	const bufferOperations: WorkGradeFixture["bufferOperations"] = {};
	const bufferRequests: Array<{
		name: string;
		role: "server" | "generator";
		settings: Record<string, number>;
	}> = (["server", "generator"] as const).map((role) => ({
		name: role === "server" ? "apply-buffer" : "apply-buffer-generator",
		role,
		settings: Object.fromEntries(
			[
				"net.core.rmem_max",
				"net.core.rmem_default",
				"net.ipv4.udp_rmem_min",
			].map((key) => [key, profile.receiveBufferBytes]),
		),
	}));
	if (profile.serverUdpSendBufferBytes > 0)
		bufferRequests.push({
			name: "apply-server-sndbuf",
			role: "server",
			settings: { "net.core.wmem_max": profile.serverUdpSendBufferBytes },
		});
	for (const [index, request] of bufferRequests.entries()) {
		const receipt = operationFixture(
			`${node.id}-${request.name}`,
			operation.envelope.sequence - bufferRequests.length + index,
			new Date(startMs - 500).toISOString(),
			new Date(startMs - 100).toISOString(),
		);
		receipt.envelope.runId = runId;
		receipt.stdoutPath = `work/${node.id}/${request.name}.stdout`;
		receipt.stderrPath = `work/${node.id}/${request.name}.stderr`;
		receipt.action = {
			command: "g6_ssh",
			args: [
				`root@${pair[request.role].provider.publicIpv4}`,
				`sysctl -w ${Object.entries(request.settings)
					.map(([key, value]) => `${key}=${value}`)
					.join(" ")}`,
			],
			cwd: ".",
			environmentKeys: [],
		};
		bufferOperations[request.name] = {
			receipt,
			stdout: `${Object.entries(request.settings)
				.map(([key, value]) => `${key} = ${value}`)
				.join("\n")}\n`,
			stderr: "",
		};
	}
	return {
		runId,
		pair,
		node,
		profile,
		scan,
		diagnostic,
		postRunSteeringText: steeringDump(30_000_000),
		probe: profile.detailedProbe
			? workProbeFixture(startedAt, profile.shards)
			: null,
		expectCandidate: TEST_CANDIDATE,
		registrationSha256: TEST_REGISTRATION,
		nativeProducerSha256: "c".repeat(64),
		probeProducerSha256: "d".repeat(64),
		operation,
		scanStdout: witness.stdout,
		scanStderr: "",
		owners: { server: owner("server", 0), generator: owner("generator", 1) },
		bufferOperations,
	};
}
const roots: string[] = [];
export function cleanupWorkFixtures() {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
}
export function workPolicyFixture(ladder = false, r5 = false) {
	return validateBudgetPolicy({
		schema: "g6-c32-budget-policy/2",
		campaignId: "test-work",
		runId: "test-work-a",
		currency: "USD",
		lifecycle: ladder ? "ladder-only" : "attribution-only",
		totalBudgetMicrousd: 103544166,
		spentBeforeMicrousd: 91350910,
		maximumRoleHourlyMicrousd: { server: 1949400, generator: 1949400 },
		maximumLifecycleSeconds: ladder ? 7020 : 5520,
		teardownReserveSeconds: 600,
		maximumLifecycleCostMicrousd: ladder ? 8252460 : 6627960,
		cellMaximumSeconds: ladder
			? { ladder: 480, companion: 480 }
			: r5
				? { "attribution-r4": 420 }
				: { attribution: 420 },
		allowedStages: ladder
			? ["ladder", "companion"]
			: r5
				? ["attribution-r4"]
				: ["attribution"],
		priorLedger: {
			path: "prior.json",
			sha256: "b".repeat(64),
			sealedSpentMicrousd: 91350910,
		},
		workPlan: r5
			? ladder
				? makeCapacityLadderWorkPlan("g6-capacity-ladder-b-r5")
				: makeCandidateAttributionWorkPlan()
			: ladder
				? makeCapacityLadderWorkPlan()
				: makeAttributionWorkPlan(),
		workProfiles: r5
			? ladder
				? makeCandidateLadderWorkProfiles(
						{ ...workProfileFixture, shards: 1 },
						{ sendPath: "stock", probe: true },
					)
				: makeCandidateAttributionWorkProfiles(workProfileFixture)
			: ladder
				? { candidate: { ...workProfileFixture, shards: 1 } }
				: makeAttributionWorkProfiles(workProfileFixture),
	});
}
export function operationFixture(
	operationId: string,
	sequence = 1,
	startedAt = "2026-09-05T00:01:00.000Z",
	finishedAt = "2026-09-05T00:02:00.000Z",
): OperationReceipt {
	return {
		schema: "g6-c32-operation-receipt/1",
		envelope: {
			recordedAt: finishedAt,
			sequence,
			runId: "test-work-a",
			phase: "RUNNING",
			operationId,
			clockSource: "offrunner",
		},
		startedAt,
		finishedAt,
		durationMonotonicNs: String(
			BigInt(Date.parse(finishedAt) - Date.parse(startedAt)) * 1_000_000n,
		),
		attempt: 1,
		action: { command: "fake-local", args: [], cwd: ".", environmentKeys: [] },
		status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
		stdoutPath: "qualification/setup.stdout",
		stderrPath: "qualification/setup.stderr",
		remoteTiming: null,
	};
}
export function workClockDomainFixture() {
	return {
		schema: "g6-c32-clock-domain/1" as const,
		clock: "CLOCK_MONOTONIC" as const,
		platform: "darwin" as const,
		hostId: "darwin:fixture",
		bootId: "11111111-2222-3333-4444-555555555555",
	};
}
export function executionFixture(ladder = false, r5 = false) {
	const root = mkdtempSync(join(tmpdir(), "g6-work-execution-"));
	roots.push(root);
	mkdirSync(join(root, "qualification"));
	writeFileSync(
		join(root, "qualification/setup.receipt.json"),
		JSON.stringify(operationFixture("work-setup")),
	);
	for (const stream of ["stdout", "stderr"])
		writeFileSync(join(root, `qualification/setup.${stream}`), "");
	const policy = workPolicyFixture(ladder, r5),
		hash = budgetPolicyArtifactSha256(policy);
	const base = {
		recordedAt: "2026-09-05T00:00:00.000Z",
		campaignId: policy.campaignId,
		runId: policy.runId,
		budgetPolicySha256: hash,
		accruedLifecycleMicrousd: 0,
		prospectiveCellMicrousd: 0,
		teardownReserveMicrousd: 0,
		totalAuthorizedMicrousd: policy.spentBeforeMicrousd,
		remainingBudgetMicrousd:
			policy.totalBudgetMicrousd - policy.spentBeforeMicrousd,
		decision: null,
	};
	const price = appendSpendLedgerEntry(null, {
		...base,
		event: "PRICE_VERIFIED",
	});
	const intent = appendSpendLedgerEntry(price, {
		...base,
		event: "CREATE_INTENT",
		rigJournalEventArtifactSha256: "e".repeat(64),
	});
	const observed = appendSpendLedgerEntry(intent, {
		...base,
		recordedAt: "2026-09-05T00:01:00.000Z",
		event: "CREATE_OBSERVED",
		rigJournalEventArtifactSha256: "f".repeat(64),
	});
	const ledger = [price, intent, observed];
	initializeWorkExecution({
		root,
		policy,
		ledger,
		authority: workAuthorityFixture(policy),
		deadline: "2026-09-05T02:00:00.000Z",
		candidateSha: "a".repeat(40),
		registrationSha256: "b".repeat(64),
		nativeProducerSha256: "c".repeat(64),
		probeProducerSha256: "d".repeat(64),
		setupReceiptPath: "qualification/setup.receipt.json",
		now: "2026-09-05T00:02:00.000Z",
	});
	return { root, policy, ledger, clockDomain: workClockDomainFixture() };
}
