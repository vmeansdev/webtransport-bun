import { describe, expect, setDefaultTimeout, test } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: adversarial fixtures deliberately mutate arbitrary JSON fields to invalid types.
type FixtureValue = any;
function requiredFixture<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw Error("synthetic fixture is missing a required value");
	return value;
}

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
import { dirname, join } from "node:path";
import {
	cleanScan,
	diagnosticFixture,
	steeringDump,
	TEST_REGISTRATION,
} from "./g6-c32-evaluator-fixture.test-helper.ts";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
} from "./g6-c32-freeze-model.ts";
import {
	CAPACITY_LINUX_PROOF_TESTS,
	CAPACITY_NATIVE_PROOF_TESTS,
	type CapacityGoalEvaluation,
	capacityLocalProofArgv,
	type LocalReceiptKind,
	validateCapacityGoalContract,
} from "./g6-capacity-goal-evaluate.ts";
import {
	linuxProbeFixture,
	linuxProbeFixtureText,
} from "./g6-linux-probe-fixture.ts";

const SOURCE_SHA = "724ae1f9711f10dcfe1e67381bc47a088e404c6d";
const PLAN_SHA =
	"b2085021e669ce518e8967551c18b4d5047539fdb8e1b8e6295f3bfa8fed33ad";
const SPEC_SHA =
	"5b1f72d99001488bce836abe9914b3807b1b9e9a63b9e27939fbe6e6ffb6ceb3";
const SEMANTIC_FREEZE_AUTHORITY_SHA = "a".repeat(64);
const RUN_ID = "g6-40k-capacity-closure-r1";
const RAW_SHAPE = {
	endpoints: 128,
	connectConcurrency: 50,
	connectRatePerSec: 250,
	fixedSourcePortBase: 20000,
} as const;
const RAW_PROFILE = {
	shards: 24,
	endpoints: RAW_SHAPE.endpoints,
	connectConcurrency: RAW_SHAPE.connectConcurrency,
	connectRatePerSec: RAW_SHAPE.connectRatePerSec,
	fixedSourcePortBase: RAW_SHAPE.fixedSourcePortBase,
	ackReflector: "native",
	serverWorkers: 3,
	serverGro: "off",
	serverRecvRuntime: "shared",
	ackCadence: "default",
	reflectRingBypass: "off",
	serverUdpSendBufferBytes: 0,
	serverUdpSendEagainMode: "wait",
	pacerPps: 0,
	udpSendBatch: 0,
} as const;
type RawRungGate = "PASS" | "MISS";
type CompanionGate = "PASS" | "MISS";
type RawRungSpec = {
	label: string;
	rung: number;
	gate?: RawRungGate;
	mutateScan?: (scan: Record<string, unknown>) => void;
	mutateDiagnostic?: (diagnostic: Record<string, unknown>) => void;
	mutateIdentity?: (identity: Record<string, unknown>) => void;
	steeringText?: string;
};
type RawCompanionSpec = {
	label: "C1" | "C2";
	requestedSessions: number;
	activeWorkloadSessions: number;
	gate?: CompanionGate;
	mutateScan?: (scan: Record<string, unknown>) => void;
	mutateDiagnostic?: (diagnostic: Record<string, unknown>) => void;
	mutateIdentity?: (identity: Record<string, unknown>) => void;
};
type ScenarioOptions = {
	workProducer?: boolean;
	rungs?: RawRungSpec[];
	companions?: RawCompanionSpec[];
	includePendingAdapters?: boolean;
	useLegacyCompanionRoot?: boolean;
	breakExecutionReceipt?: (receipt: Record<string, unknown>) => string;
	breakContract?: (contract: Record<string, unknown>) => void;
	breakLedgerText?: string;
	tamperManifest?: boolean;
};
function writeText(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
function writeJson(path: string, value: unknown): void {
	writeText(path, canonicalJson(value));
}
function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function reviewReceipt(
	role: "architect" | "critic",
	architectArtifactSha256: string | null,
) {
	const authority = {
		semanticFreezeAuthoritySha256: SEMANTIC_FREEZE_AUTHORITY_SHA,
		role,
		verdict: "APPROVE" as const,
		unconditional: true as const,
		afterArchitectReceiptArtifactSha256:
			role === "critic" ? architectArtifactSha256 : null,
	};
	return {
		schema: "g6-c32-review-receipt/1",
		envelope: {
			recordedAt:
				role === "architect"
					? "2026-09-04T10:00:00.000Z"
					: "2026-09-04T10:00:01.000Z",
			sequence: role === "architect" ? 2 : 3,
			runId: "g6-40k-capacity-closure-r1",
			phase: role === "architect" ? "ARCHITECT_REVIEW" : "CRITIC_REVIEW",
			operationId: role === "architect" ? "architect-review" : "critic-review",
			clockSource: "offrunner" as const,
		},
		authoritySha256: canonicalAuthoritySha256(authority),
		authority,
	};
}
function executionOutput(kind: string, argv: readonly string[]): string {
	if (argv[0] === "uname")
		return kind === "candidate-local-linux" ? "Linux\n" : "Darwin\n";
	if (argv[0] === "git") return `${SOURCE_SHA}\n`;
	if (argv[0] === "cargo") {
		const names = [
			...CAPACITY_NATIVE_PROOF_TESTS,
			...(kind === "candidate-local-linux" ? CAPACITY_LINUX_PROOF_TESTS : []),
		];
		return `${names.map((name) => `test ${name} ... ok`).join("\n")}\ntest result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n`;
	}
	return `${argv
		.slice(2)
		.map((file) => `${file}:\n(pass) synthetic fixture\n`)
		.join(
			"\n",
		)}\n${argv.length - 2} pass\n0 fail\n1 expect() calls\nRan ${argv.length - 2} tests across ${argv.length - 2} files.\n`;
}
function executionReceipt(kind: string): Record<string, unknown> {
	return {
		schema: "g6-capacity-execution-receipt/1",
		kind,
		sourceSha: SOURCE_SHA,
		phase: "verification",
		commands: capacityLocalProofArgv(kind as LocalReceiptKind).map(
			(argv, index) => {
				const output = executionOutput(kind, argv);
				return {
					argv,
					exitCode: 0,
					stdoutPath: `evidence/local/${kind}-${index}.stdout`,
					stderrPath: `evidence/local/${kind}-${index}.stderr`,
					stdoutSha256: sha256Text(output),
					stderrSha256: sha256Text(""),
				};
			},
		),
		platform: kind === "candidate-local-linux" ? "Linux" : "Darwin",
		liveEvidence: false,
		note: "fixture",
	};
}
function sealEntry(): Record<string, unknown> {
	return {
		schema: "g6-c32-spend-ledger-entry/1",
		sequence: 1,
		recordedAt: "2026-09-04T10:30:00.000Z",
		campaignId: "g6-40k-capacity-closure",
		runId: "g6-40k-capacity-closure-r1",
		budgetPolicySha256: "c".repeat(64),
		previousEntryArtifactSha256: null,
		rigJournalEventArtifactSha256: null,
		event: "SEAL",
		accruedLifecycleMicrousd: 100,
		prospectiveCellMicrousd: 0,
		teardownReserveMicrousd: 0,
		totalAuthorizedMicrousd: 91351010,
		remainingBudgetMicrousd: 12193156,
		decision: null,
	};
}
function rewriteClientReport(
	scan: Record<string, unknown>,
	mutate: (report: Record<string, unknown>) => void,
): void {
	const marker = "mmo-client: json ";
	const stdout = scan.clientStdout as string;
	const report = JSON.parse(stdout.slice(marker.length)) as Record<
		string,
		unknown
	>;
	mutate(report);
	scan.clientStdout = `${marker}${JSON.stringify(report)}\n`;
}
function applyApprovedProfile(scan: Record<string, unknown>): void {
	scan.candidateSha = SOURCE_SHA;
	const config = scan.config as Record<string, unknown>;
	config.shards = RAW_PROFILE.shards;
	config.endpoints = RAW_PROFILE.endpoints;
	config.connectConcurrency = RAW_PROFILE.connectConcurrency;
	config.connectRatePerSec = RAW_PROFILE.connectRatePerSec;
	config.fixedSourcePortBase = RAW_PROFILE.fixedSourcePortBase;
	config.ackReflector = RAW_PROFILE.ackReflector;
	config.serverWorkers = RAW_PROFILE.serverWorkers;
	config.serverGro = RAW_PROFILE.serverGro;
	config.serverRecvRuntime = RAW_PROFILE.serverRecvRuntime;
	config.ackCadence = RAW_PROFILE.ackCadence;
	config.reflectRingBypass = RAW_PROFILE.reflectRingBypass;
	config.serverUdpSendBufferBytes = 0;
	config.serverUdpSendEagainMode = "wait";
	config.udpSendBatch = 0;
	config.pacerPps = 0;
	config.activeWorkloadSessions = config.sessions;
	rewriteClientReport(scan, (report) => {
		(report.preRegistration as Record<string, unknown>).sha256 =
			TEST_REGISTRATION;
		report.activeWorkloadSessions = config.activeWorkloadSessions;
		report.connectConcurrency = RAW_PROFILE.connectConcurrency;
		report.connectRatePerSec = RAW_PROFILE.connectRatePerSec;
		(report.client as Record<string, unknown>).endpointSourceAddresses =
			Array.from(
				{ length: RAW_PROFILE.endpoints },
				(_, index) => `0.0.0.0:${RAW_PROFILE.fixedSourcePortBase + index}`,
			);
		(report.config as Record<string, unknown>).fixedSourcePortBase =
			RAW_PROFILE.fixedSourcePortBase;
	});
}
function distributeAggregateRxTotal(
	scan: Record<string, unknown>,
	total: number,
): void {
	(
		(scan.aggregate as Record<string, unknown>).steady as Record<
			string,
			unknown
		>
	).rxTotal = total;
	const shards = scan.shards as Array<Record<string, unknown>>;
	const base = Math.floor(total / shards.length);
	const remainder = total % shards.length;
	for (const [index, shard] of shards.entries()) {
		const share = base + (index < remainder ? 1 : 0);
		const windows = shard.windows as Record<string, unknown>;
		(windows.steady as Record<string, unknown>).rxTotal = share;
		(windows.steadyDrain as Record<string, unknown>).rxTotal = share;
		((windows.lifetime as Record<string, unknown>) ?? windows).rxTotal = share;
	}
}
function basePairIdentity(): Record<string, unknown> {
	return Object.fromEntries(
		(["server", "generator"] as const).map((role) => [
			role,
			{
				schema: "g6-c32-host-identity/1",
				envelope: {
					recordedAt: "2026-09-04T10:30:00.000Z",
					sequence: role === "server" ? 1 : 2,
					runId: RUN_ID,
					phase: "BINDING",
					operationId: `collect-identity-${role}`,
					clockSource: role,
				},
				provider: {
					id: role === "server" ? 101 : 202,
					role,
					name: `${RUN_ID}-${role}`,
					tags: ["g6-c32-managed", RUN_ID],
					region: "ric1",
					size: "g5-48vcpu-96gb-80gb",
					image: "ubuntu-24-04-x64",
					vpcUuid: "fixture-vpc",
					projectId: null,
					sshKeyIds: [77],
					vcpus: 48,
					memoryMiB: 98304,
					status: "active",
					createdAt: "2026-09-04T10:00:00.000Z",
					publicIpv4: role === "server" ? "203.0.113.10" : "203.0.113.20",
					privateIpv4: role === "server" ? "10.0.0.10" : "10.0.0.20",
				},
				bootId:
					role === "server"
						? "11111111-1111-4111-8111-111111111111"
						: "22222222-2222-4222-8222-222222222222",
				source: {
					commit: SOURCE_SHA,
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
					kind: role === "server" ? "native-addon" : "mmo-client",
					path: `/opt/g6/source/${role}`,
					sha256: (role === "server" ? "b" : "c").repeat(64),
				},
				clock: {
					requestStartedAt: "2026-09-04T10:29:59.900Z",
					responseFinishedAt: "2026-09-04T10:30:00.100Z",
					remoteWallAt: "2026-09-04T10:30:00.000Z",
					measuredSkewMilliseconds: 0,
				},
			},
		]),
	);
}
function frozenIdentity(
	observed: Record<string, unknown>,
): Record<string, unknown> {
	return {
		schema: "g6-capacity-pair-identity/1",
		...observed,
	};
}
let capacityProbeTemplate: string | undefined;
function capacityProbe(startedAt: string): string {
	const templateStart = "2026-09-04T11:00:00.000Z";
	const templateEnd = "2026-09-04T11:02:00.150Z";
	capacityProbeTemplate ??= buildCapacityProbe(templateStart);
	// Keep one bounded template instead of regenerating 14,400 samples per cell.
	// ISO timestamps have the same byte length, preserving artifactBytes.
	return capacityProbeTemplate
		.replace(`"startedAt":"${templateStart}"`, `"startedAt":"${startedAt}"`)
		.replace(
			`"endedAt":"${templateEnd}"`,
			`"endedAt":"${new Date(Date.parse(startedAt) + 120150).toISOString()}"`,
		);
}
function buildCapacityProbe(startedAt: string): string {
	// Full synthetic 120s steady trace at the producer's fixed 10/50ms cadence.
	// These fixtures prove evaluator semantics, never live capacity/calibration.
	const rows = linuxProbeFixture(RAW_PROFILE.shards);
	const steadyStart = 150000000n;
	const extension = 119950000000n;
	const queue = requiredFixture(
		rows.find(
			(row) =>
				row.phase === "steady" && row.schema === "g6-c32-linux-probe-queue/2",
		),
	);
	const sched = requiredFixture(
		rows.find(
			(row) =>
				row.phase === "steady" && row.schema === "g6-c32-linux-probe-sched/2",
		),
	);
	const generated: Record<string, FixtureValue>[] = [];
	for (let tick = 0; tick < 12000; tick++) {
		const monotonicNs = String(
			steadyStart + 5000000n + BigInt(tick) * 10000000n,
		);
		generated.push({ ...queue, monotonicNs });
		if (tick % 5 === 0) {
			const count = tick / 5;
			generated.push({
				...sched,
				monotonicNs,
				netRx: sched.netRx + count,
				softnet: {
					...sched.softnet,
					processed: sched.softnet.processed + count,
				},
				sched: sched.sched.map((thread: Record<string, number>) => ({
					...thread,
					runtimeNs: requiredFixture(thread.runtimeNs) + count,
					waitNs: requiredFixture(thread.waitNs) + count,
					timeslices: requiredFixture(thread.timeslices) + count,
				})),
			});
		}
	}
	const startIndex = rows.indexOf(queue);
	rows.splice(startIndex, 6, ...generated);
	for (const row of rows) {
		if (
			row.phase === "drain" ||
			row.phase === "idle" ||
			row.schema === "g6-c32-linux-probe/2"
		) {
			row.monotonicNs = String(BigInt(row.monotonicNs) + extension);
			if (row.sched) {
				row.netRx += 2399;
				row.softnet.processed += 2399;
				for (const thread of row.sched) {
					thread.runtimeNs += 2399;
					thread.waitNs += 2399;
					thread.timeslices += 2399;
				}
			}
		}
	}
	requiredFixture(rows[0]).startedAt = startedAt;
	const footer = requiredFixture(rows.at(-1));
	footer.endedAt = new Date(Date.parse(startedAt) + 120150).toISOString();
	footer.queueSamples += 11995;
	footer.schedSamples += 2399;
	footer.phaseCoverage.steady = { queueSamples: 12000, schedSamples: 2400 };
	for (const phase of ["drain", "idle"])
		footer.phaseBoundaries[phase].monotonicNs = String(
			BigInt(footer.phaseBoundaries[phase].monotonicNs) + extension,
		);
	return linuxProbeFixtureText(rows);
}
function ladderScan(rung: number, gate: RawRungGate): Record<string, unknown> {
	const scan = cleanScan(rung, RAW_SHAPE, RAW_PROFILE.shards) as Record<
		string,
		unknown
	>;
	applyApprovedProfile(scan);
	if (gate === "MISS") {
		const report = JSON.parse(
			(scan.clientStdout as string).slice("mmo-client: json ".length),
		) as {
			windows: {
				steady: {
					sent: number;
				};
			};
		};
		distributeAggregateRxTotal(
			scan,
			Math.floor(report.windows.steady.sent * 0.994),
		);
	}
	return scan;
}
function ladderDiagnostic(rung: number): Record<string, unknown> {
	const diagnostic = diagnosticFixture({
		sessions: rung,
		shape: RAW_SHAPE,
		drops: 0,
		steered: rung * 4 * 120,
		shards: RAW_PROFILE.shards,
	}) as Record<string, unknown>;
	diagnostic.candidateSha = SOURCE_SHA;
	const dispatch = diagnostic.dispatch as Record<string, unknown>;
	dispatch.shards = RAW_PROFILE.shards;
	dispatch.sessions = rung;
	dispatch.endpoints = RAW_PROFILE.endpoints;
	dispatch.connectConcurrency = RAW_PROFILE.connectConcurrency;
	dispatch.connectRatePerSec = RAW_PROFILE.connectRatePerSec;
	dispatch.fixedSourcePortBase = RAW_PROFILE.fixedSourcePortBase;
	dispatch.reflectRingBypass = RAW_PROFILE.reflectRingBypass;
	const ladder = diagnostic.ladder as Array<Record<string, unknown>>;
	requiredFixture(ladder[0]).T1 = { hostLoad: { gro: "off" } };
	requiredFixture(ladder[0]).T2 = {
		...(requiredFixture(ladder[0]).T2 as Record<string, unknown>),
		hostLoad: { gro: "off" },
	};
	return diagnostic;
}
function companionScan(
	requestedSessions: number,
	activeWorkloadSessions: number,
	gate: CompanionGate,
): Record<string, unknown> {
	const scan = cleanScan(
		requestedSessions,
		RAW_SHAPE,
		RAW_PROFILE.shards,
	) as Record<string, unknown>;
	applyApprovedProfile(scan);
	rewriteClientReport(scan, (report) => {
		const sent = activeWorkloadSessions * 4 * 120;
		const issued = activeWorkloadSessions * 15 * 120;
		report.activeWorkloadSessions = activeWorkloadSessions;
		(
			(report.windows as Record<string, unknown>).steady as Record<
				string,
				unknown
			>
		).sent = sent;
		(
			(report.windows as Record<string, unknown>).steadyDrain as Record<
				string,
				unknown
			>
		).rxSnapshot = issued;
		if (gate === "MISS") {
			(
				(report.windows as Record<string, unknown>).steadyDrain as Record<
					string,
					unknown
				>
			).rxSnapshot = Math.floor(issued * 0.9);
		}
	});
	const config = scan.config as Record<string, unknown>;
	config.activeWorkloadSessions = activeWorkloadSessions;
	(
		(scan.aggregate as Record<string, unknown>).steady as Record<
			string,
			unknown
		>
	).rxTotal = activeWorkloadSessions * 4 * 120;
	(
		(scan.aggregate as Record<string, unknown>).steadyDrain as Record<
			string,
			unknown
		>
	).emitter = { snapshotIssued: activeWorkloadSessions * 15 * 120 };
	(scan.aggregate as Record<string, unknown>).lifetime = {
		rxByClass: { raidJoin: requestedSessions - activeWorkloadSessions },
		metrics: {
			udpSendBatchCongestionDropped: 0,
			datagramReflectRingBypassMarked: 0,
			datagramReflectRingBypassRefreshed: 0,
			datagramReflectRingBypassRefused: 0,
			datagramReflectRingBypassExpired: 0,
			datagramReflectRingBypassed: 0,
			datagramReflectRingDirectBlocked: 0,
			datagramReflectRingDirectErrors: 0,
			datagramReflectRingGsoFallback: 0,
		},
	};
	for (const [index, shard] of (
		scan.shards as Array<Record<string, unknown>>
	).entries()) {
		shard.sessionsByKindAtSteady = {
			player:
				Math.floor(activeWorkloadSessions / RAW_PROFILE.shards) +
				(index < activeWorkloadSessions % RAW_PROFILE.shards ? 1 : 0),
			raid:
				Math.floor(
					(requestedSessions - activeWorkloadSessions) / RAW_PROFILE.shards,
				) +
				(index <
				(requestedSessions - activeWorkloadSessions) % RAW_PROFILE.shards
					? 1
					: 0),
			publisher: 0,
		};
		for (const phase of ["steady", "steadyDrain", "lifetime"]) {
			const window = (shard.windows as Record<string, FixtureValue>)[phase];
			window.rxTotal = (activeWorkloadSessions * 4 * 120) / RAW_PROFILE.shards;
			window.emitter.snapshotIssued =
				(activeWorkloadSessions * 15 * 120) / RAW_PROFILE.shards;
		}
	}
	return scan;
}
function companionDiagnostic(
	requestedSessions: number,
	activeWorkloadSessions: number,
): Record<string, unknown> {
	const diagnostic = diagnosticFixture({
		sessions: requestedSessions,
		shape: RAW_SHAPE,
		drops: 0,
		steered: activeWorkloadSessions * 4 * 120,
		shards: RAW_PROFILE.shards,
	}) as Record<string, unknown>;
	diagnostic.candidateSha = SOURCE_SHA;
	const dispatch = diagnostic.dispatch as Record<string, unknown>;
	dispatch.shards = RAW_PROFILE.shards;
	dispatch.sessions = requestedSessions;
	dispatch.endpoints = RAW_PROFILE.endpoints;
	dispatch.connectConcurrency = RAW_PROFILE.connectConcurrency;
	dispatch.connectRatePerSec = RAW_PROFILE.connectRatePerSec;
	dispatch.fixedSourcePortBase = RAW_PROFILE.fixedSourcePortBase;
	dispatch.reflectRingBypass = RAW_PROFILE.reflectRingBypass;
	return diagnostic;
}
function legacyCompanionSummary(
	label: "C1" | "C2",
	pass: boolean,
): Record<string, unknown> {
	return {
		schema: "g6-c32-session-scale-evidence/1",
		label,
		complete: true,
		reasons: [],
		requestedSessions: 50000,
		activeWorkloadSessions: 40000,
		sessionsOk: pass ? 50000 : 49000,
		sessionsErr: 0,
		steadySessionsLost: 0,
		lifecycleClean: true,
		hostClean: true,
		passiveJoinCount: 10000,
		ingestRatio: pass ? 0.999 : 0.9,
		deliveryRatio: pass ? 0.999 : 0.9,
		dutyRatio: pass ? 0.999 : 0.9,
	};
}
function scenario(options: ScenarioOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "g6-capacity-goal-"));
	const evidenceRoot = join(root, "evidence");
	const repoRoot = root;
	mkdirSync(evidenceRoot, { recursive: true });
	mkdirSync(join(evidenceRoot, "receipts"), { recursive: true });
	mkdirSync(join(evidenceRoot, "companions"), { recursive: true });
	mkdirSync(join(repoRoot, ".omx/goals/performance/g6-40k-capacity-closure"), {
		recursive: true,
	});
	const architectPath = "evidence/reviews/architect.json";
	const criticPath = "evidence/reviews/critic.json";
	const architect = reviewReceipt("architect", null);
	const architectArtifactSha256 = canonicalArtifactSha256(architect);
	const critic = reviewReceipt("critic", architectArtifactSha256);
	writeJson(join(repoRoot, architectPath), architect);
	writeJson(join(repoRoot, criticPath), critic);
	const executionKinds = [
		"candidate-local-native",
		"candidate-local-linux",
		"harness-lifecycle",
		"bounded-overload",
	];
	for (const kind of executionKinds) {
		const path = join(repoRoot, `evidence/local/${kind}.json`);
		const receipt = executionReceipt(kind);
		for (const command of receipt.commands as Array<Record<string, unknown>>) {
			writeText(
				join(repoRoot, command.stdoutPath as string),
				executionOutput(kind, command.argv as string[]),
			);
			writeText(join(repoRoot, command.stderrPath as string), "");
		}
		if (options.breakExecutionReceipt && kind === "candidate-local-native") {
			writeText(path, options.breakExecutionReceipt(receipt));
		} else {
			writeJson(path, receipt);
		}
	}
	writeJson(
		join(evidenceRoot, "receipts/exact-pair.identity.json"),
		frozenIdentity(basePairIdentity()),
	);
	const defaultRungs: RawRungSpec[] = [
		{ label: "L5000-1", rung: 5000, gate: "PASS" },
		{ label: "L10000-1", rung: 10000, gate: "PASS" },
		{ label: "L20000-1", rung: 20000, gate: "PASS" },
		{ label: "L30000-1", rung: 30000, gate: "PASS" },
	];
	let sequence = 0;
	function writeOperation(
		label: string,
		scan: Record<string, unknown>,
		diagnostic: Record<string, unknown>,
		workNodeId = label,
	): void {
		const operationLabel = options.workProducer ? workNodeId : label;
		const startedAt = new Date(
			Date.parse("2026-09-04T11:00:00.000Z") + sequence * 180000,
		).toISOString();
		const finishedAt = new Date(Date.parse(startedAt) + 121000).toISOString();
		scan.startedAt = startedAt;
		diagnostic.startedAt = startedAt;
		rewriteClientReport(scan, (report) => {
			report.startedAt = startedAt;
		});
		const shardWindows = (scan.shards as FixtureValue[]).map(
			(shard) => shard.windows,
		);
		for (const phase of ["steady", "steadyDrain", "lifetime"]) {
			const aggregate = (scan.aggregate as Record<string, FixtureValue>)[phase];
			aggregate.rxTotal = shardWindows.reduce(
				(sum, windows) => sum + windows[phase].rxTotal,
				0,
			);
			aggregate.emitter ??= {};
			for (const key of ["snapshotIssued", "sendErrors"])
				aggregate.emitter[key] = shardWindows.reduce(
					(sum, windows) => sum + windows[phase].emitter[key],
					0,
				);
		}
		diagnostic.dispatch = { ...(scan.config as Record<string, unknown>) };
		diagnostic.linuxProbe = {
			enabled: true,
			stoppedCleanly: true,
			measurementMode: { detail: "on", phaseAware: true },
			producerSha256: "a".repeat(64),
		};
		for (const [index, shard] of (
			diagnostic.perShardLifecycle as Array<Record<string, unknown>>
		).entries()) {
			shard.pid = 101 + index;
			(shard.boundaries as FixtureValue[]).forEach((boundary, index) => {
				boundary.tsMs =
					Date.parse(startedAt) +
					requiredFixture([0, 50, 120050, 120100, 120200][index]);
			});
			(shard.exits as FixtureValue[])[0].tsMs = Date.parse(startedAt) + 120250;
		}
		(diagnostic.postRunSteering as Record<string, unknown>).capturedAtMs =
			Date.parse(startedAt) + 120150;
		const stdoutPath = options.workProducer
			? `work/${operationLabel}/scan.stdout`
			: `receipts/${label}.scan.stdout`;
		const stderrPath = options.workProducer
			? `work/${operationLabel}/scan.stderr`
			: `receipts/${label}.scan.stderr`;
		const operationRoot = options.workProducer ? "campaign-fixture/" : "";
		const remote = options.workProducer
			? `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${RUN_ID}/cells/work-${operationLabel}`
			: `/opt/g6/cells/ladder-${label}`;
		const config = scan.config as Record<string, unknown>;
		const environment = {
			...(options.workProducer
				? {
						SCAN_NATIVE_SEND_PATH_DIAGNOSTICS: 1,
						G6_OFFBOX_WORK_RUN_ID: RUN_ID,
						G6_OFFBOX_WORK_NODE_ID: operationLabel,
						G6_OFFBOX_WORK_ROOT: `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${RUN_ID}`,
						G6_OFFBOX_WORK_BOOT_ID: "22222222-2222-4222-8222-222222222222",
					}
				: {}),
			SCAN_DIAGNOSTIC: 1,
			SCAN_SHARDS: 24,
			SCAN_SESSIONS: config.sessions,
			SCAN_WORKLOAD_ACTIVE_SESSIONS: config.activeWorkloadSessions,
			SCAN_ENDPOINTS: 128,
			SCAN_CONNECT_CONCURRENCY: 50,
			SCAN_CONNECT_RATE_PER_SEC: 250,
			SCAN_FIXED_SOURCE_PORT_BASE: 20000,
			SCAN_ACK_REFLECTOR: "native",
			SCAN_SERVER_WORKERS: 3,
			SCAN_SERVER_GRO: "off",
			SCAN_SERVER_RECV_RUNTIME: "shared",
			SCAN_ACK_CADENCE: "default",
			SCAN_SERVER_UDP_SNDBUF_BYTES: 0,
			SCAN_UDP_SEND_BATCH: 0,
			SCAN_SERVER_UDP_SEND_EAGAIN_MODE: "wait",
			SCAN_REFLECT_RING_BYPASS: "off",
			G6_BPF_READY_RECEIPT: `${remote}/g6-shard-bpf-ready.json`,
			SCAN_LINUX_PROBE_ENABLED: 1,
			SCAN_LINUX_PROBE_OUT: `${remote}/linux-probe.jsonl`,
			SCAN_POST_RUN_STEERING_OUT: `${remote}/post-run-steering.json`,
			SCAN_OUT: `${remote}/g6-sharded-scan.json`,
			SCAN_DIAGNOSTIC_OUT: `${remote}/g6-sharded-diagnostic.json`,
			G6_OFFBOX_SSH: "root@10.0.0.20",
			G6_OFFBOX_ENTRY_SCRIPT:
				"/opt/g6/source/tools/offbox/linux-generator-entry-g6.sh",
			G6_OFFBOX_CLONE: "/opt/g6/source",
			G6_CANDIDATE_SHA: SOURCE_SHA,
			G6_PREREGISTRATION_SHA256: TEST_REGISTRATION,
			G6_SERVER_ADDRESS: "10.0.0.10",
			G6_EMITTER_MODE: "native-mirror",
		};
		writeText(
			join(evidenceRoot, operationRoot, stdoutPath),
			`g6-sharded-scan: shards=24 sessions=${config.sessions} paced=false url=https://10.0.0.10:4433 started-at=${startedAt}\ng6-sharded-scan: client exited 0\ng6-sharded-scan: wrote ${remote}/g6-sharded-scan.json\ng6-sharded-scan: wrote ${remote}/g6-sharded-diagnostic.json\n`,
		);
		writeText(join(evidenceRoot, operationRoot, stderrPath), "");
		writeText(
			join(evidenceRoot, `receipts/${label}.probe.jsonl`),
			capacityProbe(startedAt),
		);
		writeJson(
			join(
				evidenceRoot,
				options.workProducer
					? `${operationRoot}work/${operationLabel}/scan.receipt.json`
					: `receipts/${label}.operation.json`,
			),
			{
				schema: "g6-c32-operation-receipt/1",
				envelope: {
					recordedAt: finishedAt,
					sequence: ++sequence,
					runId: RUN_ID,
					phase: "RUNNING",
					operationId: `${operationLabel}-scan`,
					clockSource: "offrunner",
				},
				startedAt,
				finishedAt,
				durationMonotonicNs: "121000000000",
				attempt: 1,
				action: {
					command: options.workProducer ? "work_scan" : "g6_ssh",
					args: [
						...(options.workProducer
							? [operationLabel, remote]
							: ["root@203.0.113.10"]),
						"env",
						`${Object.entries(environment)
							.map(([key, value]) => `${key}=${value}`)
							.join(
								" ",
							)} bash -lc "cd '/opt/g6/source' && exec '/opt/g6/bun' tools/load/g6-sharded-scan.ts"`,
					],
					cwd: ".",
					environmentKeys: [],
				},
				status: { exitCode: 0, outcome: "SUCCEEDED", signal: null },
				stdoutPath,
				stderrPath,
				remoteTiming: null,
			},
		);
	}
	for (const rung of options.rungs ?? defaultRungs) {
		const scan = ladderScan(rung.rung, rung.gate ?? "PASS");
		const diagnostic = ladderDiagnostic(rung.rung);
		const identity = frozenIdentity(basePairIdentity());
		writeOperation(rung.label, scan, diagnostic);
		rung.mutateScan?.(scan);
		rung.mutateDiagnostic?.(diagnostic);
		rung.mutateIdentity?.(identity);
		writeJson(join(evidenceRoot, "receipts", `${rung.label}.scan.json`), scan);
		writeJson(
			join(evidenceRoot, "receipts", `${rung.label}.diagnostic.json`),
			diagnostic,
		);
		writeText(
			join(evidenceRoot, "receipts", `${rung.label}.post-run-steering.txt`),
			rung.steeringText ?? steeringDump(rung.rung * 4 * 120),
		);
		writeJson(
			join(evidenceRoot, "receipts", `${rung.label}.identity.json`),
			identity,
		);
	}
	for (const companion of options.companions ?? []) {
		const scan = companionScan(
			companion.requestedSessions,
			companion.activeWorkloadSessions,
			companion.gate ?? "PASS",
		);
		const diagnostic = companionDiagnostic(
			companion.requestedSessions,
			companion.activeWorkloadSessions,
		);
		const identity = frozenIdentity(basePairIdentity());
		writeOperation(
			companion.label,
			scan,
			diagnostic,
			`C${companion.requestedSessions}-${companion.label.slice(1)}`,
		);
		const ladder = diagnostic.ladder as Array<Record<string, unknown>>;
		requiredFixture(ladder[0]).T1 = { hostLoad: { gro: "off" } };
		(requiredFixture(ladder[0]).T2 as Record<string, unknown>).hostLoad = {
			gro: "off",
		};
		companion.mutateScan?.(scan);
		companion.mutateDiagnostic?.(diagnostic);
		companion.mutateIdentity?.(identity);
		writeJson(
			join(evidenceRoot, "receipts", `${companion.label}.scan.json`),
			scan,
		);
		writeJson(
			join(evidenceRoot, "receipts", `${companion.label}.diagnostic.json`),
			diagnostic,
		);
		writeJson(
			join(evidenceRoot, "receipts", `${companion.label}.identity.json`),
			identity,
		);
		writeText(
			join(evidenceRoot, `receipts/${companion.label}.post-run-steering.txt`),
			steeringDump(companion.activeWorkloadSessions * 4 * 120),
		);
	}
	if (options.useLegacyCompanionRoot) {
		for (const label of ["C1", "C2"] as const) {
			writeJson(
				join(evidenceRoot, "companions", label, "summary.json"),
				legacyCompanionSummary(label, true),
			);
		}
	}
	const manifestPayloadPath = "receipts/manifest-payload.json";
	writeJson(join(evidenceRoot, manifestPayloadPath), { value: 1 });
	const payloadText = readFileSync(
		join(evidenceRoot, manifestPayloadPath),
		"utf8",
	);
	const payloadSha = sha256Text(payloadText);
	const manifest = {
		schema: "g6-c32-artifact-manifest/1",
		envelope: {
			recordedAt: "2026-09-04T10:31:00.000Z",
			sequence: 1,
			runId: "g6-40k-capacity-closure-r1",
			phase: "FINAL",
			operationId: "offrunner-artifact-manifest",
			clockSource: "offrunner" as const,
		},
		entries: [
			{
				path: manifestPayloadPath,
				sha256: payloadSha,
				bytes: Buffer.byteLength(payloadText),
				recordedAt: "2026-09-04T10:31:00.000Z",
			},
		],
	};
	writeJson(join(evidenceRoot, "artifact-manifest.json"), manifest);
	if (options.tamperManifest) {
		writeJson(join(evidenceRoot, manifestPayloadPath), { value: 2 });
	}
	const seal = sealEntry();
	if (options.breakLedgerText) {
		writeText(join(evidenceRoot, "spend-ledger.json"), options.breakLedgerText);
	} else {
		writeJson(join(evidenceRoot, "spend-ledger.json"), [seal]);
	}
	writeJson(join(evidenceRoot, "seal-receipt.json"), seal);
	const adapterSchemas = {
		diagnostics: "g6-capacity-diagnostic-coverage/1",
		waiterSafety: "g6-capacity-waiter-safety/1",
		sameHostA: "g6-capacity-same-host-audit/1",
		finalTeardown: "g6-capacity-final-teardown/1",
	};
	for (const [name, schema] of Object.entries(adapterSchemas)) {
		writeJson(join(evidenceRoot, "receipts", `${name}.json`), { schema });
	}
	const contract: Record<string, unknown> = {
		schema: "g6-capacity-goal-contract/2",
		objective: {
			slug: "g6-40k-capacity-closure",
			sourceSha: SOURCE_SHA,
			planSha256: PLAN_SHA,
			specSha256: SPEC_SHA,
			evidenceRoot: "evidence",
			targetSessions: 40000,
			ceilingProbeSessions: 50000,
			aggregateBudgetMicrousd: 103544166,
			sealedPriorSpendMicrousd: 91350910,
			headroomMicrousd: 12193256,
		},
		approvals: {
			semanticFreezeAuthoritySha256: SEMANTIC_FREEZE_AUTHORITY_SHA,
			architectPath,
			criticPath,
		},
		localVerification: {
			receipts: executionKinds.map((kind) => ({
				label: kind,
				receiptKind: kind,
				path: `evidence/local/${kind}.json`,
			})),
		},
		ladder: {
			runId: RUN_ID,
			registrationSha256: TEST_REGISTRATION,
			probeProducerSha256: "a".repeat(64),
			pairIdentityPath: "receipts/exact-pair.identity.json",
			profile: RAW_PROFILE,
			runs: (options.rungs ?? defaultRungs).map(({ label, rung }) => ({
				label,
				rung,
				scanPath: `receipts/${label}.scan.json`,
				diagnosticPath: `receipts/${label}.diagnostic.json`,
				postRunSteeringPath: `receipts/${label}.post-run-steering.txt`,
				identityPath: `receipts/${label}.identity.json`,
				operationReceiptPath: options.workProducer
					? `campaign-fixture/work/${label}/scan.receipt.json`
					: `receipts/${label}.operation.json`,
				probePath: `receipts/${label}.probe.jsonl`,
			})),
			...(options.companions
				? {
						companions: options.companions.map((companion) => ({
							label: companion.label,
							requestedSessions: companion.requestedSessions,
							activeWorkloadSessions: companion.activeWorkloadSessions,
							scanPath: `receipts/${companion.label}.scan.json`,
							diagnosticPath: `receipts/${companion.label}.diagnostic.json`,
							identityPath: `receipts/${companion.label}.identity.json`,
							operationReceiptPath: options.workProducer
								? `campaign-fixture/work/C${companion.requestedSessions}-${companion.label.slice(1)}/scan.receipt.json`
								: `receipts/${companion.label}.operation.json`,
							probePath: `receipts/${companion.label}.probe.jsonl`,
							postRunSteeringPath: `receipts/${companion.label}.post-run-steering.txt`,
						})),
					}
				: {}),
			...(options.useLegacyCompanionRoot
				? { companionRoot: "companions" }
				: {}),
		},
		finalAudit: {
			spendLedgerPath: "spend-ledger.json",
			sealReceiptPath: "seal-receipt.json",
			artifactManifestPath: "artifact-manifest.json",
		},
	};
	if (options.includePendingAdapters !== false) {
		contract.pendingAdapters = {
			diagnostics: {
				schema: adapterSchemas.diagnostics,
				path: "receipts/diagnostics.json",
			},
			waiterSafety: {
				schema: adapterSchemas.waiterSafety,
				path: "receipts/waiterSafety.json",
			},
			sameHostA: {
				schema: adapterSchemas.sameHostA,
				path: "receipts/sameHostA.json",
			},
			finalTeardown: {
				schema: adapterSchemas.finalTeardown,
				path: "receipts/finalTeardown.json",
			},
		};
	}
	options.breakContract?.(contract);
	const contractPath = join(
		repoRoot,
		".omx/goals/performance/g6-40k-capacity-closure/contract.json",
	);
	writeJson(contractPath, contract);
	sealFixtureEvidence(evidenceRoot);
	return { repoRoot, evidenceRoot, contractPath, root };
}
function sealFixtureEvidence(evidenceRoot: string): void {
	const manifestPath = join(evidenceRoot, "artifact-manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const payload = manifest.entries.find(
		(entry: { path: string }) =>
			entry.path === "receipts/manifest-payload.json",
	);
	manifest.entries = readdirSync(evidenceRoot, {
		recursive: true,
		withFileTypes: true,
	})
		.filter(
			(entry) => entry.isFile() && entry.name !== "artifact-manifest.json",
		)
		.map((entry) => {
			const path = join(entry.parentPath, entry.name).slice(
				evidenceRoot.length + 1,
			);
			if (path === payload.path) return payload;
			const bytes = readFileSync(join(evidenceRoot, path));
			return {
				path,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				bytes: bytes.length,
				recordedAt: "2026-09-04T10:31:00.000Z",
			};
		});
	manifest.entries.sort(
		(
			left: {
				path: string;
			},
			right: {
				path: string;
			},
		) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
	);
	writeJson(manifestPath, manifest);
}
function runEvaluator(
	repoRoot: string,
	evidenceRoot: string,
	contractPath: string,
) {
	return Bun.spawnSync({
		cmd: [
			process.execPath,
			join(import.meta.dir, "g6-capacity-goal-evaluate.ts"),
			"--evidence-root",
			evidenceRoot,
			"--contract",
			contractPath,
		],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60000,
	});
}
function parseStdout(stdout: Uint8Array): CapacityGoalEvaluation {
	return JSON.parse(Buffer.from(stdout).toString("utf8"));
}
function cleanLadder(): RawRungSpec[] {
	return [5000, 10000, 20000, 30000, 40000, 40000, 50000, 50000].map(
		(rung, index, all) => ({
			label: `L${rung}-${index > 0 && all[index - 1] === rung ? 2 : 1}`,
			rung,
			gate: "PASS",
		}),
	);
}
function expectOnlyMissingRawAdapterEvidence(
	decision: CapacityGoalEvaluation,
): void {
	expect(decision.status).toBe("INCOMPLETE");
	expect(decision.reasons).toHaveLength(4);
	for (const name of [
		"diagnostics",
		"waiterSafety",
		"sameHostA",
		"finalTeardown",
	])
		expect(
			decision.reasons.some((reason) =>
				reason.startsWith(`${name}: g6-capacity-goal-adapters:`),
			),
		).toBe(true);
}
function checkScenario(
	options: ScenarioOptions,
	check: (
		decision: CapacityGoalEvaluation,
		fixture: ReturnType<typeof scenario>,
	) => void,
): void {
	const fixture = scenario(options);
	try {
		check(
			parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			),
			fixture,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}
describe("g6-capacity-goal-evaluate", () => {
	setDefaultTimeout(60000);
	test("accepts the exact owned work_scan producer receipt shape", () => {
		checkScenario({ workProducer: true, rungs: cleanLadder() }, (decision) => {
			expect(decision.liveTargetStatus).toBe("PASS");
			expectOnlyMissingRawAdapterEvidence(decision);
		});
	});
	test("work_scan companions bind canonical node IDs rather than display labels", () => {
		const rungs = cleanLadder().slice(0, 7);
		requiredFixture(rungs[6]).gate = "MISS";
		checkScenario(
			{
				workProducer: true,
				rungs,
				companions: (["C1", "C2"] as const).map((label) => ({
					label,
					requestedSessions: 50000,
					activeWorkloadSessions: 40000,
					gate: "MISS",
				})),
			},
			(decision, fixture) => {
				const receipt = JSON.parse(
					readFileSync(
						join(
							fixture.evidenceRoot,
							"campaign-fixture/work/C50000-2/scan.receipt.json",
						),
						"utf8",
					),
				);
				expect(receipt.envelope.operationId).toBe("C50000-2-scan");
				expect(receipt.stdoutPath).toBe("work/C50000-2/scan.stdout");
				expect(decision.liveTargetStatus).toBe("PASS");
				expectOnlyMissingRawAdapterEvidence(decision);
			},
		);
	});
	for (const stdoutPath of [
		"work/C50000-1/scan.stdout",
		"campaign-fixture/work/C50000-2/scan.stdout",
		"work/C2/scan.stdout",
	])
		test(`work_scan companion refuses a rehashed wrong node or root: ${stdoutPath}`, () => {
			const rungs = cleanLadder().slice(0, 7);
			requiredFixture(rungs[6]).gate = "MISS";
			checkScenario(
				{
					workProducer: true,
					rungs,
					companions: (["C1", "C2"] as const).map((label) => ({
						label,
						requestedSessions: 50000,
						activeWorkloadSessions: 40000,
					})),
				},
				(_initial, fixture) => {
					const path = join(
						fixture.evidenceRoot,
						"campaign-fixture/work/C50000-2/scan.receipt.json",
					);
					const receipt = JSON.parse(readFileSync(path, "utf8"));
					receipt.stdoutPath = stdoutPath;
					writeJson(path, receipt);
					sealFixtureEvidence(fixture.evidenceRoot);
					const decision = parseStdout(
						runEvaluator(
							fixture.repoRoot,
							fixture.evidenceRoot,
							fixture.contractPath,
						).stdout,
					);
					expect(decision.exitCode).toBe(2);
					expect(decision.reasons.join("\n")).toContain(
						"C2: work scan receipt and output paths do not share the exact cell root",
					);
				},
			);
		});
	for (const stdoutPath of [
		"campaign-fixture/work/L40000-2/scan.stdout",
		"work/L40000-1/scan.stdout",
	])
		test(`work_scan rejects a rehashed output from another root or cell: ${stdoutPath}`, () => {
			checkScenario(
				{ workProducer: true, rungs: cleanLadder() },
				(_initial, fixture) => {
					const path = join(
						fixture.evidenceRoot,
						"campaign-fixture/work/L40000-2/scan.receipt.json",
					);
					const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<
						string,
						unknown
					>;
					receipt.stdoutPath = stdoutPath;
					writeJson(path, receipt);
					sealFixtureEvidence(fixture.evidenceRoot);
					const decision = parseStdout(
						runEvaluator(
							fixture.repoRoot,
							fixture.evidenceRoot,
							fixture.contractPath,
						).stdout,
					);
					expect(decision.liveTargetStatus).not.toBe("PASS");
					expect(
						decision.reasons.some((reason) =>
							reason.includes(
								"work scan receipt and output paths do not share the exact cell root",
							),
						),
					).toBe(true);
				},
			);
		});
	test("two Critic receipts cannot stand in for sequential Architect then Critic", () => {
		checkScenario({ rungs: cleanLadder() }, (_initial, fixture) => {
			const firstCritic = reviewReceipt("critic", "b".repeat(64));
			const secondCritic = reviewReceipt(
				"critic",
				canonicalArtifactSha256(firstCritic),
			);
			writeJson(
				join(fixture.repoRoot, "evidence/reviews/architect.json"),
				firstCritic,
			);
			writeJson(
				join(fixture.repoRoot, "evidence/reviews/critic.json"),
				secondCritic,
			);
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.reasons).toContain(
				"approval receipt roles must be Architect then Critic",
			);
		});
	});
	test("legacy summary contract cannot attest raw evidence", () => {
		checkScenario(
			{
				breakContract(contract) {
					contract.schema = "g6-capacity-goal-contract/1";
				},
			},
			(decision) => {
				expect(decision.status).toBe("INCOMPLETE");
				expect(decision.reasons).toContain("contract is malformed");
			},
		);
	});
	test("raw file omitted from the seal cannot prove a clean repeat", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			const path = join(fixture.evidenceRoot, "artifact-manifest.json");
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifest.entries = manifest.entries.filter(
				(entry: { path: string }) =>
					entry.path !== "receipts/L40000-2.scan.json",
			);
			writeJson(path, manifest);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"L40000-2.scan.json is not hash-verified by the final manifest",
			);
		});
	});
	test("raw scan mutation after sealing invalidates the live target", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			const path = join(fixture.evidenceRoot, "receipts/L40000-2.scan.json");
			const scan = JSON.parse(readFileSync(path, "utf8"));
			scan.aggregate.steady.rxTotal += 1;
			writeJson(path, scan);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"L40000-2.scan.json is not hash-verified by the final manifest",
			);
		});
	});
	test("an earlier repeated operation cannot become independent 40k evidence by relabelling", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			const path = join(
				fixture.evidenceRoot,
				"receipts/L40000-2.operation.json",
			);
			const operation = JSON.parse(readFileSync(path, "utf8"));
			operation.envelope.sequence = 4;
			writeJson(path, operation);
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"operation order is invalid",
			);
		});
	});
	for (const [name, file, mutate, reason] of [
		[
			"stale scan identity",
			"scan.json",
			(value: FixtureValue) => {
				value.startedAt = "2020-01-01T00:00:00.000Z";
			},
			"start",
		],
		[
			"stale client identity",
			"scan.json",
			(value: FixtureValue) => {
				rewriteClientReport(value, (report) => {
					report.startedAt = "2020-01-01T00:00:00.000Z";
				});
			},
			"client startedAt",
		],
		[
			"negative boundary timestamp",
			"diagnostic.json",
			(value: FixtureValue) => {
				value.perShardLifecycle[0].boundaries[0].tsMs = -1;
			},
			"lifecycle",
		],
		[
			"nonnumeric exit timestamp",
			"diagnostic.json",
			(value: FixtureValue) => {
				value.perShardLifecycle[0].exits[0].tsMs = "not-a-timestamp";
			},
			"lifecycle",
		],
		[
			"stale boundary timestamp",
			"diagnostic.json",
			(value: FixtureValue) => {
				value.perShardLifecycle[0].boundaries[1].tsMs = Date.parse(
					"2020-01-01T00:00:00.000Z",
				);
			},
			"lifecycle",
		],
		[
			"unrelated successful command",
			"operation.json",
			(value: FixtureValue) => {
				value.action = {
					command: "true",
					args: [],
					cwd: ".",
					environmentKeys: [],
				};
			},
			"scan command",
		],
		[
			"wrong command host",
			"operation.json",
			(value: FixtureValue) => {
				value.action.args[0] = "root@203.0.113.99";
			},
			"scan command",
		],
		[
			"contradictory shard ingress",
			"scan.json",
			(value: FixtureValue) => {
				for (const shard of value.shards)
					for (const phase of ["steady", "steadyDrain", "lifetime"])
						shard.windows[phase].rxTotal = 0;
			},
			"aggregate.steady.rxTotal",
		],
		[
			"contradictory shard output",
			"scan.json",
			(value: FixtureValue) => {
				value.shards[0].windows.steadyDrain.emitter.snapshotIssued = 0;
			},
			"aggregate.steadyDrain.snapshotIssued",
		],
		[
			"foreign scan shard identities",
			"scan.json",
			(value: FixtureValue) => {
				for (const shard of value.shards) shard.serverId += 100;
			},
			"shard membership",
		],
	] as const) {
		test(`raw consistency rejects ${name}`, () => {
			checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
				const path = join(fixture.evidenceRoot, `receipts/L40000-2.${file}`);
				const value = JSON.parse(readFileSync(path, "utf8"));
				mutate(value);
				writeJson(path, value);
				// A matching old scan/diagnostic pair must not evade the execution clock.
				if (name === "stale scan identity") {
					const diagnosticPath = join(
						fixture.evidenceRoot,
						"receipts/L40000-2.diagnostic.json",
					);
					const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"));
					diagnostic.startedAt = value.startedAt;
					writeJson(diagnosticPath, diagnostic);
				}
				sealFixtureEvidence(fixture.evidenceRoot);
				const decision = parseStdout(
					runEvaluator(
						fixture.repoRoot,
						fixture.evidenceRoot,
						fixture.contractPath,
					).stdout,
				);
				expect(decision.liveTargetStatus).toBe("UNPROVEN");
				expect(decision.reasons.join("\n")).toContain(reason);
			});
		});
	}
	test("raw consistency rejects empty scan stdout even with successful status", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			writeText(
				join(fixture.evidenceRoot, "receipts/L40000-2.scan.stdout"),
				"",
			);
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain("scan stdout");
		});
	});
	test("raw consistency rejects shortened companion workload windows", () => {
		const rungs = cleanLadder().slice(0, 7);
		requiredFixture(rungs[6]).gate = "MISS";
		checkScenario(
			{
				rungs,
				companions: (["C1", "C2"] as const).map((label) => ({
					label,
					requestedSessions: 50000,
					activeWorkloadSessions: 40000,
					gate: "MISS" as const,
					mutateScan(scan) {
						for (const shard of scan.shards as FixtureValue[]) {
							shard.windows.steady.wallMs = 1;
							shard.windows.steadyDrain.wallMs = 1;
						}
					},
				})),
			},
			(decision) => {
				expect(decision.reasons.join("\n")).toContain(
					"C1: shard 0 steady wallMs",
				);
				expect(decision.reasons.join("\n")).toContain(
					"C2: shard 0 steady wallMs",
				);
			},
		);
	});
	test("climbing after the first MISS is refused even with later passing flags", () => {
		const rungs = cleanLadder();
		requiredFixture(rungs[6]).gate = "MISS";
		checkScenario({ rungs }, (decision) => {
			expect(decision.reasons).toContain(
				"full-rate run after first MISS is forbidden",
			);
		});
	});
	test("a legacy probe summary cannot replace phase-aware raw rated-cell proof", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			writeJson(join(fixture.evidenceRoot, "receipts/L40000-2.probe.jsonl"), {
				schema: "g6-c32-linux-probe/1",
				complete: true,
				summary: {},
			});
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain("L40000-2");
		});
	});
	test("a prior-cell raw probe cannot be relabelled as an independent repeat", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			const prior = readFileSync(
				join(fixture.evidenceRoot, "receipts/L40000-1.probe.jsonl"),
				"utf8",
			);
			writeText(
				join(fixture.evidenceRoot, "receipts/L40000-2.probe.jsonl"),
				prior,
			);
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"probe wall timestamps are outside the ordered scan operation",
			);
		});
	});
	test("a pair without raw role identity packets cannot prove the target", () => {
		const rungs = cleanLadder();
		requiredFixture(rungs[5]).mutateIdentity = (identity) => {
			delete identity.server;
		};
		checkScenario({ rungs }, (decision) => {
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"raw role identity packets are required",
			);
		});
	});
	for (const [name, mutate, reason] of [
		[
			"host shape",
			(host: Record<string, FixtureValue>) => {
				host.provider.size = "c-64-intel";
			},
			"identity differs from the approved host shape",
		],
		[
			"host region",
			(host: Record<string, FixtureValue>) => {
				host.provider.region = "nyc3";
			},
			"identity differs from the approved host shape",
		],
		[
			"host source",
			(host: Record<string, FixtureValue>) => {
				host.source.commit = "e".repeat(40);
			},
			"sourceSha differs from candidate",
		],
		[
			"host binary",
			(host: Record<string, FixtureValue>) => {
				host.binary.sha256 = "e".repeat(64);
			},
			"binary differs from exact pair",
		],
		[
			"dirty checkout",
			(host: Record<string, FixtureValue>) => {
				host.source.statusPorcelain = " M crates/native/src/lib.rs";
			},
			"identity source checkout is dirty",
		],
	] as const) {
		test(`raw ${name} cannot be replaced by clean qualification flags`, () => {
			const rungs = [
				{
					label: "L5000-1",
					rung: 5000,
					mutateIdentity(identity: Record<string, unknown>) {
						mutate(identity.server as Record<string, FixtureValue>);
					},
				},
			];
			checkScenario({ rungs }, (decision) => {
				expect(decision.liveTargetStatus).toBe("UNPROVEN");
				expect(decision.reasons.join("\n")).toContain(reason);
			});
		});
	}
	test("overlapping cell operations cannot prove independence", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			const path = join(
				fixture.evidenceRoot,
				"receipts/L40000-2.operation.json",
			);
			const operation = JSON.parse(readFileSync(path, "utf8"));
			operation.startedAt = "2026-09-04T11:13:59.000Z";
			writeJson(path, operation);
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"operation order is invalid",
			);
		});
	});
	test("a first 50k MISS completes only with both raw companions", () => {
		const rungs = cleanLadder().slice(0, 7);
		requiredFixture(rungs[6]).gate = "MISS";
		const companions: RawCompanionSpec[] = ["C1", "C2"].map((label) => ({
			label: label as "C1" | "C2",
			requestedSessions: 50000,
			activeWorkloadSessions: 40000,
			gate: "MISS",
		}));
		checkScenario({ rungs, companions }, (decision) => {
			expect(decision.liveTargetStatus).toBe("PASS");
			expectOnlyMissingRawAdapterEvidence(decision);
		});
		checkScenario({ rungs, companions: companions.slice(0, 1) }, (decision) => {
			expect(decision.reasons).toContain(
				"both ordered raw companion cells C1 and C2 are required",
			);
		});
	});
	test("a changed probe producer cannot prove the repeated target", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			const path = join(fixture.evidenceRoot, "receipts/L40000-2.probe.jsonl");
			const rows = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			rows[0].producerSha256 = "b".repeat(64);
			rows.at(-1).producerSha256 = "b".repeat(64);
			writeText(path, linuxProbeFixtureText(rows));
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"probe producer differs from contract",
			);
		});
	});
	test("probe boundary flags covering less than the rated steady duration fail", () => {
		checkScenario({ rungs: cleanLadder() }, (_decision, fixture) => {
			const rows = linuxProbeFixture();
			writeText(
				join(fixture.evidenceRoot, "receipts/L40000-2.probe.jsonl"),
				linuxProbeFixtureText(rows),
			);
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain("L40000-2");
		});
	});
	for (const missIndex of [3, 4, 5]) {
		test(`first MISS at ladder index ${missIndex} requires a clean lower repeat and both companions`, () => {
			const rungs = cleanLadder().slice(0, missIndex + 1);
			const miss = requiredFixture(rungs.at(-1));
			miss.gate = "MISS";
			const lower = requiredFixture(
				[...rungs].reverse().find((run) => run.rung < miss.rung),
			);
			rungs.push({ label: `L${lower.rung}-2`, rung: lower.rung, gate: "PASS" });
			checkScenario(
				{
					rungs,
					companions: ["C1", "C2"].map((label) => ({
						label: label as "C1" | "C2",
						requestedSessions: miss.rung,
						activeWorkloadSessions: lower.rung,
						gate: "MISS",
					})),
				},
				(decision) => {
					expect(decision.liveTargetStatus).toBe("MISS");
					expectOnlyMissingRawAdapterEvidence(decision);
				},
			);
		});
	}
	test("a 40k MISS with no lower repeat cannot report completed evidence", () => {
		const rungs = cleanLadder().slice(0, 5);
		requiredFixture(rungs[4]).gate = "MISS";
		checkScenario({ rungs }, (decision) => {
			expect(decision.liveTargetStatus).toBe("MISS");
			expect(decision.reasons).toContain(
				"missing required lower-rung repeat L30000-2",
			);
		});
	});
	test("declared fixed ports cannot mask another observed client port pool", () => {
		const rungs = cleanLadder();
		requiredFixture(rungs[5]).mutateScan = (scan) =>
			rewriteClientReport(scan, (report) => {
				(report.client as Record<string, unknown>).endpointSourceAddresses =
					Array.from({ length: 128 }, (_, index) => `0.0.0.0:${40000 + index}`);
			});
		checkScenario({ rungs }, (decision) => {
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
			expect(decision.reasons.join("\n")).toContain(
				"endpoint source ports differ from registered pool",
			);
		});
	});
	test("a missing companion lifecycle exit is incomplete evidence", () => {
		const rungs = cleanLadder().slice(0, 7);
		requiredFixture(rungs[6]).gate = "MISS";
		checkScenario(
			{
				rungs,
				companions: ["C1", "C2"].map((label) => ({
					label: label as "C1" | "C2",
					requestedSessions: 50000,
					activeWorkloadSessions: 40000,
					mutateDiagnostic(diagnostic) {
						delete (diagnostic.perShardLifecycle as FixtureValue[])[0].exits;
					},
				})),
			},
			(decision) => {
				expect(decision.reasons.join("\n")).toContain(
					"lifecycle exits are missing",
				);
			},
		);
	});
	test("a forged companion steering total cannot replace its raw witness", () => {
		const rungs = cleanLadder().slice(0, 7);
		requiredFixture(rungs[6]).gate = "MISS";
		checkScenario(
			{
				rungs,
				companions: ["C1", "C2"].map((label) => ({
					label: label as "C1" | "C2",
					requestedSessions: 50000,
					activeWorkloadSessions: 40000,
					mutateDiagnostic(diagnostic) {
						(diagnostic.postRunSteering as FixtureValue).steerStatsSum.steered =
							0;
					},
				})),
			},
			(decision) => {
				expect(decision.reasons.join("\n")).toContain(
					"diagnostic post-run steering differs from raw witness",
				);
			},
		);
	});
	for (const [name, mutate] of [
		[
			"diagnostic SHA",
			(rung: RawRungSpec) => {
				rung.mutateDiagnostic = (value) => {
					value.candidateSha = "e".repeat(40);
				};
			},
		],
		[
			"missing active workload",
			(rung: RawRungSpec) => {
				rung.mutateScan = (value) => {
					delete (value.config as Record<string, unknown>)
						.activeWorkloadSessions;
				};
			},
		],
		[
			"reduced active workload",
			(rung: RawRungSpec) => {
				rung.mutateScan = (value) => {
					(value.config as Record<string, unknown>).activeWorkloadSessions =
						30000;
				};
			},
		],
		[
			"missing steady wall",
			(rung: RawRungSpec) => {
				rung.mutateScan = (value) => {
					(value.shards as FixtureValue[])[0].windows.steady.wallMs = null;
				};
			},
		],
	] as const) {
		test(`rejects ${name} in raw replicated target evidence`, () => {
			const rungs = cleanLadder();
			mutate(requiredFixture(rungs[5]));
			checkScenario({ rungs }, (decision) => {
				expect(decision.liveTargetStatus).toBe("UNPROVEN");
				expect(
					decision.reasons.some((reason: string) =>
						reason.startsWith("L40000-2"),
					),
				).toBe(true);
			});
		});
	}
	test("omitting required future proof adapters cannot create a completion path", () => {
		const fixture = scenario({
			includePendingAdapters: false,
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "PASS" },
				{ label: "L40000-2", rung: 40000, gate: "PASS" },
				{ label: "L50000-1", rung: 50000, gate: "PASS" },
				{ label: "L50000-2", rung: 50000, gate: "PASS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons).toContain(
				"required adapter diagnostics is missing",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	});
	test("numeric exit zero without retained hash-bound output is not test proof", () => {
		const fixture = scenario({
			breakExecutionReceipt(receipt) {
				return canonicalJson({
					...receipt,
					commands: [{ argv: ["cargo", "test"], exitCode: 0 }],
				});
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(parseStdout(result.stdout).reasons).toContain(
				"local receipt candidate-local-native lacks hash-bound test output",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	});
	test("a tiny aggregate seal below prior spend is invalid, never reinterpreted as a delta", () => {
		const fixture = scenario();
		try {
			const seal = { ...sealEntry(), totalAuthorizedMicrousd: 100 };
			writeJson(join(fixture.evidenceRoot, "spend-ledger.json"), [seal]);
			writeJson(join(fixture.evidenceRoot, "seal-receipt.json"), seal);
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(parseStdout(result.stdout).reasons).toContain(
				"sealed spend is inconsistent with contract prior spend",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	});
	test("reports a proven 40k miss even while required raw adapter evidence is missing", () => {
		const fixture = scenario({
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "MISS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.status).toBe("INCOMPLETE");
			expect(decision.liveTargetStatus).toBe("MISS");
			expect(
				decision.reasons.some((reason) =>
					reason.startsWith("diagnostics: g6-capacity-goal-adapters:"),
				),
			).toBe(true);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("fails closed on unsupported adapter schemas when the live target is not yet resolved", () => {
		const fixture = scenario({
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "PASS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.status).toBe("INCOMPLETE");
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects stale source SHA in a local verification receipt", () => {
		const fixture = scenario({
			breakExecutionReceipt(receipt) {
				return canonicalJson({ ...receipt, sourceSha: "d".repeat(40) });
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"local receipt candidate-local-native sourceSha differs from contract sourceSha",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test.each([
		"prepared",
		"ordinary",
		"extra-output",
	])("handles prepared Linux boot witness without treating stderr as platform: %s", (mode) => {
		const fixture = scenario();
		try {
			const path = join(
				fixture.evidenceRoot,
				"local/candidate-local-linux.json",
			);
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			receipt.phase = mode === "ordinary" ? "verification" : "PREPARED_HOST";
			for (const command of receipt.commands) {
				const output = `g6-prepared-boot-id=22222222-2222-4222-8222-222222222222\n${mode === "extra-output" ? "unexpected output\n" : ""}`;
				writeText(join(fixture.repoRoot, command.stderrPath), output);
				command.stderrSha256 = sha256Text(output);
			}
			writeJson(path, receipt);
			sealFixtureEvidence(fixture.evidenceRoot);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(
				decision.reasons.includes(
					"local receipt candidate-local-linux is malformed",
				),
			).toBe(mode !== "prepared");
			// These synthetic adapter stubs cannot verify the boot origin or complete a goal.
			expect(decision.status).toBe("INCOMPLETE");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 15000);
	test("rejects a local output omitted from the final manifest", () => {
		const fixture = scenario();
		try {
			const path = join(fixture.evidenceRoot, "artifact-manifest.json");
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifest.entries = manifest.entries.filter(
				(entry: { path: string }) =>
					entry.path !== "local/candidate-local-native-0.stdout",
			);
			writeJson(path, manifest);
			const decision = parseStdout(
				runEvaluator(
					fixture.repoRoot,
					fixture.evidenceRoot,
					fixture.contractPath,
				).stdout,
			);
			expect(decision.reasons).toContain(
				"local receipt candidate-local-native is malformed",
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 15000);
	test.each([
		"unrelated-suite",
		"macos-as-linux",
		"missing-linux-tests",
	])("rejects local proof category substitution: %s", (mutation) => {
		const fixture = scenario();
		try {
			const kind =
				mutation === "unrelated-suite"
					? "harness-lifecycle"
					: "candidate-local-linux";
			const path = join(fixture.repoRoot, `evidence/local/${kind}.json`);
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			if (mutation === "unrelated-suite")
				receipt.commands[0].argv = [
					"bun",
					"test",
					"tools/load/example.test.ts",
				];
			else if (mutation === "macos-as-linux") receipt.platform = "Darwin";
			else {
				const output =
					"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n";
				writeText(
					join(fixture.repoRoot, receipt.commands[0].stdoutPath),
					output,
				);
				receipt.commands[0].stdoutSha256 = sha256Text(output);
				receipt.commands[0].passed = 1;
			}
			writeJson(path, receipt);
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(parseStdout(result.stdout).reasons).toContain(
				`local receipt ${kind} is malformed`,
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects forged passing flags without executable command proof", () => {
		const fixture = scenario({
			breakExecutionReceipt(receipt) {
				const { commands, ...rest } = receipt;
				return canonicalJson({ ...rest, passed: true, commands: [] });
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"local receipt candidate-local-native is malformed",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects a raw rung whose scan candidate differs from the contract source", () => {
		const fixture = scenario({
			rungs: [
				{
					label: "L5000-1",
					rung: 5000,
					gate: "PASS",
					mutateScan(scan) {
						scan.candidateSha = "f".repeat(40);
					},
				},
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons.join("\n")).toContain(
				"candidate ffffffffffffffffffffffffffffffffffffffff != registered 724ae1f9711f10dcfe1e67381bc47a088e404c6d",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects a raw rung whose scan profile differs from the approved profile", () => {
		const fixture = scenario({
			rungs: [
				{
					label: "L5000-1",
					rung: 5000,
					gate: "PASS",
					mutateScan(scan) {
						(scan.config as Record<string, unknown>).connectConcurrency = 51;
					},
				},
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons.join("\n")).toContain(
				"scan connectConcurrency differs from registered profile",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects a raw rung whose host identity differs from the exact pair", () => {
		const fixture = scenario({
			rungs: [
				{
					label: "L5000-1",
					rung: 5000,
					gate: "PASS",
					mutateIdentity(identity) {
						(identity.server as Record<string, unknown>).bootId =
							"33333333-3333-4333-8333-333333333333";
					},
				},
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons.join("\n")).toContain(
				"server.bootId differs from exact pair",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects 50k evidence recorded before the required 40k repeat", () => {
		const fixture = scenario({
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "PASS" },
				{ label: "L50000-1", rung: 50000, gate: "PASS" },
				{ label: "L40000-2", rung: 40000, gate: "PASS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons).toContain(
				"contract ladder run order is invalid",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects summary-only companion proof after a 50k miss", () => {
		const fixture = scenario({
			useLegacyCompanionRoot: true,
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "PASS" },
				{ label: "L40000-2", rung: 40000, gate: "PASS" },
				{ label: "L50000-1", rung: 50000, gate: "MISS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons).toContain(
				"raw companion bindings are required; summary-only companionRoot is unsupported",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("accepts a clean-clean 50k ladder as a complete live target even while adapters remain pending", () => {
		const fixture = scenario({
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "PASS" },
				{ label: "L40000-2", rung: 40000, gate: "PASS" },
				{ label: "L50000-1", rung: 50000, gate: "PASS" },
				{ label: "L50000-2", rung: 50000, gate: "PASS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.status).toBe("INCOMPLETE");
			expect(decision.liveTargetStatus).toBe("PASS");
			expect(decision.reasons).not.toContain(
				"missing first measured ceiling miss above replicated 40k",
			);
			expectOnlyMissingRawAdapterEvidence(decision);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("treats a repeated 50k miss plus complete companions as a valid ceiling path", () => {
		const fixture = scenario({
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "PASS" },
				{ label: "L40000-2", rung: 40000, gate: "PASS" },
				{ label: "L50000-1", rung: 50000, gate: "PASS" },
				{ label: "L50000-2", rung: 50000, gate: "MISS" },
			],
			companions: [
				{
					label: "C1",
					requestedSessions: 50000,
					activeWorkloadSessions: 40000,
					gate: "PASS",
				},
				{
					label: "C2",
					requestedSessions: 50000,
					activeWorkloadSessions: 40000,
					gate: "MISS",
				},
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.status).toBe("INCOMPLETE");
			expect(decision.liveTargetStatus).toBe("PASS");
			expect(decision.reasons).not.toContain(
				"raw companion bindings are required; summary-only companionRoot is unsupported",
			);
			expect(decision.reasons).not.toContain(
				"missing required rung receipt L50000-2",
			);
			expectOnlyMissingRawAdapterEvidence(decision);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects local green receipts without live rung proof", () => {
		const fixture = scenario();
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"missing required rung receipt L40000-1",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects tampered final-manifest content", () => {
		const fixture = scenario({
			tamperManifest: true,
			rungs: [
				{ label: "L5000-1", rung: 5000, gate: "PASS" },
				{ label: "L10000-1", rung: 10000, gate: "PASS" },
				{ label: "L20000-1", rung: 20000, gate: "PASS" },
				{ label: "L30000-1", rung: 30000, gate: "PASS" },
				{ label: "L40000-1", rung: 40000, gate: "PASS" },
				{ label: "L40000-2", rung: 40000, gate: "PASS" },
				{ label: "L50000-1", rung: 50000, gate: "PASS" },
				{ label: "L50000-2", rung: 50000, gate: "PASS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"artifact manifest entry receipts/manifest-payload.json hash mismatch",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects Infinity and negative values in final spend evidence", () => {
		const fixture = scenario({
			breakLedgerText:
				'[{"schema":"g6-c32-spend-ledger-entry/1","sequence":1,"recordedAt":"2026-09-04T10:30:00.000Z","campaignId":"g6-40k-capacity-closure","runId":"g6-40k-capacity-closure-r1","budgetPolicySha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","previousEntryArtifactSha256":null,"rigJournalEventArtifactSha256":null,"event":"SEAL","accruedLifecycleMicrousd":1e309,"prospectiveCellMicrousd":0,"teardownReserveMicrousd":0,"totalAuthorizedMicrousd":-1,"remainingBudgetMicrousd":12193156,"decision":null}]',
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain("spend ledger is malformed");
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("rejects zero target sessions in the contract", () => {
		const fixture = scenario({
			breakContract(contract) {
				(contract.objective as Record<string, unknown>).targetSessions = 0;
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain("contract is malformed");
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("treats an unbound semantic freeze digest as an explicit incomplete state", () => {
		const fixture = scenario({
			breakContract(contract) {
				(
					contract.approvals as Record<string, unknown>
				).semanticFreezeAuthoritySha256 = null;
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"approval semantic freeze authority digest is unbound",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
});

describe("r5 contract v2 (budget top-up and pump ladder profile)", () => {
	function contractOf(fixture: ReturnType<typeof scenario>) {
		return JSON.parse(readFileSync(fixture.contractPath, "utf8"));
	}
	test("accepts the 2026-10-01 aggregate, A08 sealed prior spend and exact headroom", () => {
		const fixture = scenario();
		try {
			const contract = contractOf(fixture);
			contract.objective = {
				...contract.objective,
				aggregateBudgetMicrousd: 133_544_166,
				sealedPriorSpendMicrousd: 104_996_710,
				headroomMicrousd: 28_547_456,
			};
			expect(validateCapacityGoalContract(contract).objective).toMatchObject({
				aggregateBudgetMicrousd: 133_544_166,
				sealedPriorSpendMicrousd: 104_996_710,
				headroomMicrousd: 28_547_456,
			});
			contract.objective.headroomMicrousd = 28_547_457;
			expect(() => validateCapacityGoalContract(contract)).toThrow(
				"headroom exceeds aggregate budget",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	});
	test("ladder profile accepts only the pump datagram path, never a default", () => {
		const fixture = scenario();
		try {
			const contract = contractOf(fixture);
			expect(
				validateCapacityGoalContract(contract).ladder.profile,
			).not.toHaveProperty("datagramPump");
			for (const udpSendBatch of [0, 64]) {
				contract.ladder.profile = {
					...RAW_PROFILE,
					udpSendBatch,
					datagramPump: "pump",
				};
				expect(
					validateCapacityGoalContract(contract).ladder.profile,
				).toMatchObject({ datagramPump: "pump", udpSendBatch });
			}
			for (const datagramPump of ["legacy", null, 1]) {
				contract.ladder.profile = { ...RAW_PROFILE, datagramPump };
				expect(() => validateCapacityGoalContract(contract)).toThrow(
					"datagramPump must be the pump candidate",
				);
			}
			contract.ladder.profile = {
				...RAW_PROFILE,
				datagramPump: "pump",
				reflectRingBypass: "on",
			};
			expect(() => validateCapacityGoalContract(contract)).toThrow(
				"reflectRingBypass differs from approved fixed profile",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	});
	test("ladder profile clientProcesses is optional, exact and an integer from 1 to 16", () => {
		const fixture = scenario();
		try {
			const contract = contractOf(fixture);
			expect(
				validateCapacityGoalContract(contract).ladder.profile,
			).not.toHaveProperty("clientProcesses");
			for (const clientProcesses of [1, 4, 16]) {
				contract.ladder.profile = {
					...RAW_PROFILE,
					datagramPump: "pump",
					clientProcesses,
				};
				expect(
					validateCapacityGoalContract(contract).ladder.profile,
				).toMatchObject({ clientProcesses });
			}
			for (const clientProcesses of [0, 17, 1.5, "4", null]) {
				contract.ladder.profile = {
					...RAW_PROFILE,
					datagramPump: "pump",
					clientProcesses,
				};
				expect(() => validateCapacityGoalContract(contract)).toThrow(
					"clientProcesses must be an integer from 1 to 16",
				);
			}
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	});
	test("a fanned-out contract refuses raw rated cells lacking the process echo", () => {
		const fixture = scenario({
			breakContract(contract) {
				(contract.ladder as Record<string, unknown>).profile = {
					...RAW_PROFILE,
					clientProcesses: 4,
				};
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons.join("\n")).toContain(
				"L5000-1: scan command SCAN_CLIENT_PROCESSES differs",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
	test("a pump contract refuses raw rated cells lacking the datagram echo", () => {
		const fixture = scenario({
			breakContract(contract) {
				(contract.ladder as Record<string, unknown>).profile = {
					...RAW_PROFILE,
					datagramPump: "pump",
				};
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			expect(parseStdout(result.stdout).reasons.join("\n")).toContain(
				"L5000-1: scan command SCAN_DATAGRAM_PUMP differs",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15000);
});
