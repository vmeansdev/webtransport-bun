/** Synthetic offline fixtures only: no process, network, or measured capacity. */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	spendLedgerEntryArtifactSha256,
	validateBudgetPolicy,
} from "./g6-c32-budget.ts";
import { makeAttributionWorkPlan } from "./g6-c32-capacity-work.ts";
import {
	cleanScan,
	diagnosticFixture,
	steeringDump,
} from "./g6-c32-evaluator-fixture.test-helper.ts";
import { validateOperationReceipt } from "./g6-c32-freeze-model.ts";
import {
	operationFixture,
	workAuthorityFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import { makeAttributionWorkProfiles } from "./g6-c32-work-profile.ts";
import {
	linuxProbeFixture,
	linuxProbeFixtureText,
} from "./g6-linux-probe-fixture.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

const roots: string[] = [];
const phases = ["unarmed", "connect", "steady", "drain", "idle"] as const;
const intervals = [
	"reflectQueueWait",
	"reflectSendCall",
	"ringFull",
	"flusherEagain",
	"udpQueueWait",
];
const times = [
	1n,
	100_000_000n,
	150_000_000n,
	120_150_000_000n,
	120_200_000_000n,
] as const;
function required<T>(value: T | null | undefined, label: string): T {
	if (value === undefined || value === null)
		throw Error(`synthetic fixture missing ${label}`);
	return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error(`synthetic fixture ${label} is not an object`);
	return value as Record<string, unknown>;
}
function records(value: unknown, label: string): Record<string, unknown>[] {
	if (!Array.isArray(value))
		throw Error(`synthetic fixture ${label} is not an array`);
	return value.map((row) => object(row, label));
}
function numeric(value: unknown, label: string): number {
	if (typeof value !== "number")
		throw Error(`synthetic fixture ${label} is not numeric`);
	return value;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string")
		throw Error(`synthetic fixture ${label} is not text`);
	return value;
}
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
export function cleanupSendPathFixtures() {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
}
function write(root: string, path: string, value: unknown) {
	writeFileSync(join(root, path), JSON.stringify(value));
}
function binding(root: string, path: string) {
	return { path, sha256: sha(readFileSync(join(root, path))) };
}

function nativeSnapshot(index: number, batch: number, finalized = false) {
	return {
		schema: "g6-native-send-path/1",
		enabled: true,
		finalized,
		phase: phases[index],
		monoNs: String(
			required(times[index], "phase time") + (finalized ? 50_000_000n : 1n),
		),
		phaseOrder: phases,
		bucketUpperBoundsNs: Array.from({ length: 31 }, (_, i) => 1000 * 2 ** i),
		errors: 0,
		components:
			index === 0
				? []
				: ["reflector", ...(batch ? ["udp-socket"] : [])].map((kind) => ({
						kind,
						phase: phases[index],
						createdPhase: "connect",
						createdNs: String(times[1]),
						errors: 0,
						cuts: phases.slice(2, index + 1).map((phase, i) => ({
							phase,
							beginNs: String(times[i + 2]),
							endNs: String(times[i + 2]),
						})),
						phases: phases.slice(1).map((phase) => ({
							phase,
							intervals: intervals.map((name, j) => {
								const count =
									finalized &&
									phase === "steady" &&
									(kind === "reflector" ? j < 2 : j >= 2)
										? 100
										: 0;
								const buckets = Array(32).fill(0);
								buckets[10 + j] = count;
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
					})),
	};
}

let probeTemplate: string | undefined;
function probeText(startedAt: string): string {
	if (!probeTemplate) {
		const rows: Record<string, unknown>[] = linuxProbeFixture(1),
			generated: Record<string, unknown>[] = [];
		const queue = required(
			rows.find(
				(row) =>
					row.phase === "steady" && row.schema === "g6-c32-linux-probe-queue/2",
			),
			"steady probe queue",
		);
		const sched = required(
			rows.find(
				(row) =>
					row.phase === "steady" && row.schema === "g6-c32-linux-probe-sched/2",
			),
			"steady probe scheduler",
		);
		for (let tick = 0; tick < 12000; tick++) {
			const monotonicNs = String(
				times[2] + 5_000_000n + BigInt(tick) * 10_000_000n,
			);
			generated.push({ ...queue, monotonicNs });
			if (tick % 5 === 0) {
				const delta = tick / 5;
				generated.push({
					...sched,
					monotonicNs,
					netRx: numeric(sched.netRx, "scheduler netRx") + delta,
					softnet: {
						...object(sched.softnet, "scheduler softnet"),
						processed:
							numeric(
								object(sched.softnet, "scheduler softnet").processed,
								"softnet processed",
							) + delta,
					},
					sched: records(sched.sched, "scheduler threads").map((row) => ({
						...row,
						runtimeNs: numeric(row.runtimeNs, "runtimeNs") + delta,
						waitNs: numeric(row.waitNs, "waitNs") + delta,
						timeslices: numeric(row.timeslices, "timeslices") + delta,
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
				row.monotonicNs = String(
					BigInt(text(row.monotonicNs, "probe monotonicNs")) + 119_950_000_000n,
				);
				if (row.sched) {
					row.netRx = numeric(row.netRx, "netRx") + 2399;
					const softnet = object(row.softnet, "softnet");
					softnet.processed = numeric(softnet.processed, "processed") + 2399;
					for (const thread of records(row.sched, "scheduler threads"))
						for (const key of ["runtimeNs", "waitNs", "timeslices"])
							thread[key] = numeric(thread[key], key) + 2399;
				}
			}
		const footer = required(rows.at(-1), "probe footer");
		required(rows[0], "probe header").startedAt = "2026-09-04T00:00:00.000Z";
		footer.endedAt = "2026-09-04T00:02:00.150Z";
		footer.queueSamples = numeric(footer.queueSamples, "queueSamples") + 11995;
		footer.schedSamples = numeric(footer.schedSamples, "schedSamples") + 2399;
		object(footer.phaseCoverage, "phase coverage").steady = {
			queueSamples: 12000,
			schedSamples: 2400,
		};
		for (const phase of ["drain", "idle"]) {
			const boundary = object(
				object(footer.phaseBoundaries, "phase boundaries")[phase],
				`${phase} boundary`,
			);
			boundary.monotonicNs = String(
				BigInt(text(boundary.monotonicNs, "boundary monotonicNs")) +
					119_950_000_000n,
			);
		}
		probeTemplate = linuxProbeFixtureText(rows);
	}
	return probeTemplate
		.replace(
			'"startedAt":"2026-09-04T00:00:00.000Z"',
			`"startedAt":"${startedAt}"`,
		)
		.replace(
			'"endedAt":"2026-09-04T00:02:00.150Z"',
			`"endedAt":"${new Date(Date.parse(startedAt) + 120150).toISOString()}"`,
		);
}

export function sendPathFixture(
	options: {
		ackMs?: number;
		cpuByNode?: Record<string, number>;
		ackByNode?: Record<string, number>;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "g6-send-path-"));
	roots.push(root);
	for (const dir of ["qualification", "closeout", "work"])
		mkdirSync(join(root, dir));
	const workPlan = makeAttributionWorkPlan(),
		workProfiles = makeAttributionWorkProfiles({
			...workProfileFixture,
			shards: 1,
		});
	const policy = validateBudgetPolicy({
		schema: "g6-c32-budget-policy/2",
		campaignId: "test-work",
		runId: "test-work-a",
		currency: "USD",
		lifecycle: "attribution-only",
		totalBudgetMicrousd: 103544166,
		spentBeforeMicrousd: 91350910,
		maximumRoleHourlyMicrousd: { server: 1949400, generator: 1949400 },
		maximumLifecycleSeconds: 4260,
		teardownReserveSeconds: 600,
		maximumLifecycleCostMicrousd: 5263380,
		cellMaximumSeconds: { attribution: 420 },
		allowedStages: ["attribution"],
		priorLedger: {
			path: "prior.json",
			sha256: "b".repeat(64),
			sealedSpentMicrousd: 91350910,
		},
		workPlan,
		workProfiles,
	});
	const policySha256 = budgetPolicyArtifactSha256(policy),
		nativeProducerSha256 = "c".repeat(64),
		probeProducerSha256 = "a".repeat(64);
	const workAuthority = {
			...workAuthorityFixture(policy),
			probeProducerSha256,
		},
		pair = workAuthority.pair;
	const base = {
		recordedAt: "2026-09-04T00:00:00.000Z",
		campaignId: policy.campaignId,
		runId: policy.runId,
		budgetPolicySha256: policySha256,
		accruedLifecycleMicrousd: 0,
		prospectiveCellMicrousd: 0,
		teardownReserveMicrousd: 0,
		totalAuthorizedMicrousd: policy.spentBeforeMicrousd,
		remainingBudgetMicrousd: 12193256,
		decision: null,
	};
	const price = appendSpendLedgerEntry(null, {
			...base,
			event: "PRICE_VERIFIED",
		}),
		intent = appendSpendLedgerEntry(price, {
			...base,
			event: "CREATE_INTENT",
			rigJournalEventArtifactSha256: "e".repeat(64),
		});
	const ledger = [
		price,
		intent,
		appendSpendLedgerEntry(intent, {
			...base,
			event: "CREATE_OBSERVED",
			recordedAt: "2026-09-04T00:00:20.000Z",
			rigJournalEventArtifactSha256: "f".repeat(64),
		}),
	];
	const setup = operationFixture(
		"work-setup",
		1,
		"2026-09-04T00:00:30.000Z",
		"2026-09-04T00:02:00.000Z",
	);
	write(root, "qualification/setup.receipt.json", setup);
	write(root, "work-authority.json", workAuthority);
	write(root, "work-execution.json", {
		schema: "g6-c32-work-execution/1",
		policySha256,
		candidateSha: "a".repeat(40),
		registrationSha256: "b".repeat(64),
		nativeProducerSha256,
		probeProducerSha256,
		authority: binding(root, "work-authority.json"),
		deadline: "2026-09-04T02:00:00.000Z",
		setupReceipt: binding(root, "qualification/setup.receipt.json"),
	});
	let previousCompletionSha256: string | null = null,
		sequence = 2;
	const completed = [];
	for (const [index, node] of workPlan.nodes.entries()) {
		const p = required(
				workProfiles[node.profile],
				`work profile ${node.profile}`,
			),
			prefix = `work/${node.id}`,
			startMs = Date.parse(setup.finishedAt) + index * 125000,
			startedAt = new Date(startMs).toISOString(),
			scanAt = new Date(startMs + 1000).toISOString(),
			scanEnd = new Date(startMs + 122000).toISOString(),
			finishedAt = new Date(startMs + 125000).toISOString();
		mkdirSync(join(root, prefix));
		write(root, `${prefix}/start.json`, {
			schema: "g6-c32-work-cell-start/1",
			nodeId: node.id,
			policySha256,
			startedAt,
			startedMonotonicNs: String(BigInt(index) * 125000000000n),
			cutoffAt: new Date(startMs + 420000).toISOString(),
			previousCompletionSha256,
		});
		const admission = appendSpendLedgerEntry(
			required(ledger.at(-1), "previous ledger entry"),
			{
				...base,
				event: "CELL_ADMISSION",
				recordedAt: startedAt,
				decision: "ADMIT",
			},
		);
		ledger.push(admission);
		write(root, `${prefix}/admission.json`, {
			schema: "g6-c32-cell-admission/2",
			decision: "ADMIT",
			nextNodeId: node.id,
			recordedAt: startedAt,
			budgetPolicySha256: policySha256,
			ledgerEntryArtifactSha256: spendLedgerEntryArtifactSha256(admission),
		});
		const scan = Object.assign(cleanScan(40000, p, 1), { startedAt: scanAt }),
			diagnostic = object(
				diagnosticFixture({
					sessions: 40000,
					shape: p,
					shards: 1,
					drops: 0,
					steered: 30000000,
				}),
				"diagnostic",
			);
		diagnostic.startedAt = scanAt;
		Object.assign(scan.config, p, {
			activeWorkloadSessions: 40000,
			pacerPps: null,
		});
		Object.assign(
			object(diagnostic.dispatch, "diagnostic dispatch"),
			scan.config,
		);
		const client = JSON.parse(
			scan.clientStdout.slice("mmo-client: json ".length),
		);
		client.startedAt = scanAt;
		client.activeWorkloadSessions = 40000;
		const sourcePortBase = required(
			p.fixedSourcePortBase,
			"fixed source port base",
		);
		client.client.endpointSourceAddresses = Array.from(
			{ length: p.endpoints },
			(_, i) => `0.0.0.0:${sourcePortBase + i}`,
		);
		const histogram = new LatencyHistogram();
		for (let i = 0; i < 1000; i++)
			histogram.record(
				(options.ackByNode?.[node.id] ?? options.ackMs ?? 1) * 1000000,
			);
		client.windows.steadyDrain.rtt = histogram.toJson();
		scan.clientStdout = `mmo-client: json ${JSON.stringify(client)}\n`;
		for (const shard of scan.shards) {
			const windows = required(shard.windows, "shard windows");
			Object.assign(windows.steady, {
				cpuMs: options.cpuByNode?.[node.id] ?? 240000,
			});
			Object.assign(
				required(
					required(windows.lifetime, "lifetime window").metrics,
					"lifetime metrics",
				),
				{
					udpSendBatchErrors: 0,
					datagramReflectRingBypassed: p.reflectRingBypass === "on" ? 100 : 0,
				},
			);
		}
		for (const phase of ["steady", "steadyDrain", "lifetime"] as const) {
			const windows = scan.shards.map((shard) =>
				required(
					required(shard.windows, "shard windows")[phase],
					`${phase} window`,
				),
			);
			Object.assign(required(scan.aggregate[phase], `${phase} aggregate`), {
				rxTotal: windows.reduce((total, window) => total + window.rxTotal, 0),
				emitter: Object.fromEntries(
					(["snapshotIssued", "sendErrors"] as const).map((key) => [
						key,
						windows.reduce((total, window) => total + window.emitter[key], 0),
					]),
				),
			});
		}
		Object.assign(
			required(
				required(scan.aggregate.lifetime, "lifetime aggregate").metrics,
				"lifetime metrics",
			),
			{
				udpSendBatchErrors: 0,
				datagramReflectRingBypassed: p.reflectRingBypass === "on" ? 100 : 0,
			},
		);
		Object.assign(scan.aggregate.steady, {
			cpuMs: options.cpuByNode?.[node.id] ?? 240000,
			wallMsMax: 120000,
		});
		const rung = required(
			records(diagnostic.ladder, "diagnostic ladder")[0],
			"diagnostic rung",
		);
		rung.T1 = { hostLoad: { gro: "off" } };
		object(rung.T2, "diagnostic T2").hostLoad = { gro: "off" };
		object(diagnostic.postRunSteering, "post-run steering").capturedAtMs =
			startMs + 121500;
		const lifecycle = required(
			records(diagnostic.perShardLifecycle, "shard lifecycle")[0],
			"shard lifecycle",
		);
		lifecycle.pid = 101;
		lifecycle.boundaries = ["connect", "steady", "drain", "idle", "stop"].map(
			(phase, i) => ({
				phase,
				tsMs:
					startMs +
					required(
						[1000, 1050, 121050, 121100, 121200][i],
						"phase wall offset",
					),
			}),
		);
		required(
			records(lifecycle.exits, "lifecycle exits")[0],
			"lifecycle exit",
		).tsMs = startMs + 121300;
		diagnostic.sendPathDiagnostics = {
			enabled: true,
			measurementMode: "on",
			producerSha256: nativeProducerSha256,
			shards: [
				{
					serverId: 1,
					pid: 101,
					boundaries: Object.fromEntries(
						phases.map((phase, i) => [
							phase,
							nativeSnapshot(i, p.udpSendBatch),
						]),
					),
					final: nativeSnapshot(4, p.udpSendBatch, true),
				},
			],
		};
		const remote = `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${policy.runId}/cells/work-${node.id}`;
		diagnostic.linuxProbe = {
			enabled: p.detailedProbe,
			out: p.detailedProbe ? `${remote}/linux-probe.jsonl` : null,
			maxBytes: p.detailedProbe ? 128 * 1024 * 1024 : null,
			measurementMode: {
				detail: p.detailedProbe ? "on" : "off",
				phaseAware: true,
			},
			producerSha256: p.detailedProbe ? probeProducerSha256 : null,
			stoppedCleanly: p.detailedProbe,
		};
		const probe = p.detailedProbe ? probeText(scanAt) : null;
		for (const [path, value] of Object.entries({
			"g6-sharded-scan.json": scan,
			"g6-sharded-diagnostic.json": diagnostic,
		}))
			write(root, `${prefix}/${path}`, value);
		writeFileSync(
			join(root, prefix, "post-run-steering.json"),
			steeringDump(30000000),
		);
		if (probe) writeFileSync(join(root, prefix, "linux-probe.jsonl"), probe);
		for (const [i, role] of (["server", "generator"] as const).entries())
			write(
				root,
				`${prefix}/${role === "server" ? "scan" : "generator"}-owner.json`,
				{
					schema: "g6-c32-work-process-owner/1",
					runId: policy.runId,
					nodeId: node.id,
					role,
					pid: 1000 + index * 2 + i,
					processGroupId: 1000 + index * 2 + i,
					startTicks: String(2000 + index * 2 + i),
					bootId: pair[role].bootId,
				},
			);
		for (const name of [
			"remote-mkdir",
			"apply-buffer",
			"apply-buffer-generator",
			"apply-gro",
			"bpf-repin",
			"prepare-generator-owner",
			"scan",
			"copy",
			"copy-generator-owner",
			"evaluate",
			"restore-buffer",
			"restore-buffer-generator",
			"restore-gro",
			"seal",
		]) {
			const applyingBuffer =
				name === "apply-buffer" || name === "apply-buffer-generator";
			const op = validateOperationReceipt(
				operationFixture(
					`${node.id}-${name}`,
					sequence++,
					applyingBuffer ? new Date(startMs + 500).toISOString() : scanAt,
					applyingBuffer
						? new Date(startMs + 900).toISOString()
						: name === "scan"
							? scanEnd
							: new Date(startMs + 124000).toISOString(),
				),
			);
			op.stdoutPath = `${prefix}/${name}.stdout`;
			op.stderrPath = `${prefix}/${name}.stderr`;
			let stdout = "";
			if (applyingBuffer) {
				const role = name === "apply-buffer" ? "server" : "generator";
				const settings = [
					"net.core.rmem_max",
					"net.core.rmem_default",
					"net.ipv4.udp_rmem_min",
				];
				op.action = {
					command: "g6_ssh",
					args: [
						`root@${pair[role].provider.publicIpv4}`,
						`sysctl -w ${settings.map((key) => `${key}=${p.receiveBufferBytes}`).join(" ")}`,
					],
					cwd: ".",
					environmentKeys: [],
				};
				stdout = `${settings.map((key) => `${key} = ${p.receiveBufferBytes}`).join("\n")}\n`;
			}
			if (name === "scan") {
				op.durationMonotonicNs = "121000000000";
				const env = {
					SCAN_DIAGNOSTIC: 1,
					SCAN_NATIVE_SEND_PATH_DIAGNOSTICS: 1,
					SCAN_SHARDS: p.shards,
					SCAN_SESSIONS: 40000,
					SCAN_WORKLOAD_ACTIVE_SESSIONS: 40000,
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
					G6_OFFBOX_WORK_RUN_ID: policy.runId,
					G6_OFFBOX_WORK_NODE_ID: node.id,
					G6_OFFBOX_WORK_ROOT: `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${policy.runId}`,
					G6_OFFBOX_WORK_BOOT_ID: pair.generator.bootId,
					G6_CANDIDATE_SHA: "a".repeat(40),
					G6_PREREGISTRATION_SHA256: "b".repeat(64),
					G6_SERVER_ADDRESS: pair.server.provider.privateIpv4,
					G6_EMITTER_MODE: "native-mirror",
				};
				op.action = {
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
				};
				stdout = `g6-sharded-scan: shards=${p.shards} sessions=40000 paced=false url=https://${pair.server.provider.privateIpv4}:4433 started-at=${scanAt}\ng6-sharded-scan: client exited 0\ng6-sharded-scan: wrote ${remote}/g6-sharded-scan.json\ng6-sharded-scan: wrote ${remote}/g6-sharded-diagnostic.json\n`;
			}
			write(root, `${prefix}/${name}.receipt.json`, op);
			writeFileSync(join(root, op.stdoutPath), stdout);
			writeFileSync(join(root, op.stderrPath), "");
		}
		const grade = gradeWorkCell({
			runId: policy.runId,
			pair,
			node,
			profile: p,
			scan,
			diagnostic,
			postRunSteeringText: steeringDump(30000000),
			probe,
			operation: JSON.parse(
				readFileSync(join(root, `${prefix}/scan.receipt.json`), "utf8"),
			),
			expectCandidate: "a".repeat(40),
			registrationSha256: "b".repeat(64),
			nativeProducerSha256,
			probeProducerSha256,
			scanStdout: readFileSync(join(root, prefix, "scan.stdout"), "utf8"),
			scanStderr: readFileSync(join(root, prefix, "scan.stderr"), "utf8"),
			owners: {
				server: JSON.parse(
					readFileSync(join(root, prefix, "scan-owner.json"), "utf8"),
				),
				generator: JSON.parse(
					readFileSync(join(root, prefix, "generator-owner.json"), "utf8"),
				),
			},
			bufferOperations: Object.fromEntries(
				["apply-buffer", "apply-buffer-generator"].map((name) => [
					name,
					{
						receipt: JSON.parse(
							readFileSync(join(root, prefix, `${name}.receipt.json`), "utf8"),
						),
						stdout: readFileSync(join(root, prefix, `${name}.stdout`), "utf8"),
						stderr: readFileSync(join(root, prefix, `${name}.stderr`), "utf8"),
					},
				]),
			),
		});
		if (grade.outcome === "INVALID")
			throw Error(`synthetic fixture invalid: ${grade.reasons.join(";")}`);
		write(root, `${prefix}/work-grade.json`, grade);
		completed.push({ nodeId: node.id, outcome: grade.outcome });
		const files = readdirSync(join(root, prefix))
			.sort()
			.map((name) => binding(root, `${prefix}/${name}`));
		write(root, `${prefix}/cell-seal.json`, {
			schema: "g6-c32-work-cell-seal/1",
			nodeId: node.id,
			files: files.filter(
				(file) =>
					!/\/(seal\.stdout|seal\.stderr|seal\.receipt\.json)$/.test(file.path),
			),
		});
		write(root, `${prefix}/completion.json`, {
			schema: "g6-c32-work-cell-completion/1",
			nodeId: node.id,
			policySha256,
			startedAt,
			finishedAt,
			durationMonotonicNs: "125000000000",
			previousCompletionSha256,
			grade,
			files: readdirSync(join(root, prefix))
				.sort()
				.map((name) => binding(root, `${prefix}/${name}`)),
		});
		previousCompletionSha256 = binding(
			root,
			`${prefix}/completion.json`,
		).sha256;
	}
	write(root, "closeout/work-final.json", {
		schema: "g6-c32-work-final/1",
		recordedAt: "2026-09-04T00:18:41.000Z",
		policySha256,
		lifecycle: "attribution-only",
		terminal: "ATTRIBUTION_COMPLETE",
		completed,
		controlUsedSeconds: 1,
		elapsedPaidSeconds: 1121,
	});
	return {
		root,
		policy,
		ledger,
		boundHostPair: pair,
		nativeProducerSha256,
		probeProducerSha256,
		workAuthority,
	};
}

/** Tests may reseal deliberately adversarial raw bytes to exercise semantic checks. */
export function resealSendPathFixture(
	input: ReturnType<typeof sendPathFixture>,
) {
	let previous: string | null = null;
	for (const node of makeAttributionWorkPlan().nodes) {
		const prefix = `work/${node.id}`,
			start = JSON.parse(
				readFileSync(join(input.root, prefix, "start.json"), "utf8"),
			),
			completion = JSON.parse(
				readFileSync(join(input.root, prefix, "completion.json"), "utf8"),
			);
		start.previousCompletionSha256 = previous;
		completion.previousCompletionSha256 = previous;
		write(input.root, `${prefix}/start.json`, start);
		const stable = readdirSync(join(input.root, prefix))
			.sort()
			.filter(
				(name) =>
					![
						"completion.json",
						"cell-seal.json",
						"seal.stdout",
						"seal.stderr",
						"seal.receipt.json",
					].includes(name),
			)
			.map((name) => binding(input.root, `${prefix}/${name}`));
		write(input.root, `${prefix}/cell-seal.json`, {
			schema: "g6-c32-work-cell-seal/1",
			nodeId: node.id,
			files: stable,
		});
		completion.files = readdirSync(join(input.root, prefix))
			.sort()
			.filter((name) => name !== "completion.json")
			.map((name) => binding(input.root, `${prefix}/${name}`));
		write(input.root, `${prefix}/completion.json`, completion);
		previous = binding(input.root, `${prefix}/completion.json`).sha256;
	}
}
