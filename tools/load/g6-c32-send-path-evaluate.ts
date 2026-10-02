/** Offline campaign-A comparison. This module cannot declare capacity or dispatch work. */
import { readFileSync } from "node:fs";
import {
	type BudgetPolicy,
	type SpendLedgerEntry,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import { makeAttributionWorkPlan } from "./g6-c32-capacity-work.ts";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import { validateHostIdentityPacket } from "./g6-c32-host.ts";
import { gradeSuccessorRung } from "./g6-c32-successor-grade.ts";
import {
	readWorkCellEvidence,
	readWorkExecution,
	verifyWorkFinal,
} from "./g6-c32-work-execution.ts";
import { validateCapacityRawCell } from "./g6-capacity-raw-cell.ts";
import type { RawPairIdentity } from "./g6-capacity-raw-work.ts";
import {
	readWorkAuthority,
	validateWorkAuthority,
	type WorkAuthority,
} from "./g6-capacity-work-authority.ts";
import type {
	NativeHistogram,
	NativeSendPathSnapshot,
} from "./g6-native-send-path.ts";
import type { ParsedLinuxProbeJsonl } from "./g6-sharded-diagnostic.ts";
import type { RungScan } from "./g6-sharded-grade.ts";

const PHASES = ["connect", "steady", "drain", "idle"] as const;
const INTERVALS = [
	"reflectQueueWait",
	"reflectSendCall",
	"ringFull",
	"flusherEagain",
	"udpQueueWait",
] as const;
const GAUGES = [
	"reflectReservedSlots",
	"udpPendingPackets",
	"udpPendingBytes",
	"waiterRegistrations",
] as const;
const NON_ACK = [
	"S1_ingest",
	"S2_delivery",
	"S3_duty",
	"S5_sessionsLost",
] as const;
const ARM_ORDER = ["A0", "A1", "B", "C", "C", "B", "A1", "A0"] as const;
type Phase = (typeof PHASES)[number];
type Arm = (typeof ARM_ORDER)[number];
type RecordValue = Record<string, unknown>;
export type SendPathAttributionInput = {
	root: string;
	policy: BudgetPolicy;
	ledger: readonly SpendLedgerEntry[];
	boundHostPair: unknown;
	workAuthority: WorkAuthority;
	nativeProducerSha256: string;
	probeProducerSha256: string;
};
export type CalibrationValues = {
	nodeId: string;
	cpuCores: number;
	ackP99Ms: number;
	clientSteadySent: number;
	serverSnapshotIssued: number;
	clientSnapshotReceived: number;
	nonAckClausePass: Record<string, boolean>;
};
type IntervalSummary = NativeHistogram & {
	p50UpperBoundNs: number | null;
	p99UpperBoundNs: number | null;
};
type NativePhaseSummary = {
	intervals: Record<(typeof INTERVALS)[number], IntervalSummary>;
	gauges: Record<
		(typeof GAUGES)[number],
		{ summedComponentHighWater: number; maxComponentHighWater: number }
	>;
};
type ProbePhaseSummary = {
	queueSamples: number;
	schedSamples: number;
	peakOwnedRxQueueBytes: number;
	peakOwnedTxQueueBytes: number;
	observedSocketDropsDelta: number;
	observedSchedstatRuntimeDeltaNs: number;
	observedSchedstatWaitDeltaNs: number;
	observedSchedstatTimeslicesDelta: number;
	observedNetRxSoftirqDelta: number;
	observedSoftnetProcessedDelta: number;
	observedSoftnetDroppedDelta: number;
	observedSoftnetTimeSqueezeDelta: number;
	peakProcsRunning: number;
	peakLoad1: number;
	queueSampleExtent: ParsedLinuxProbeJsonl["phaseSampleExtents"]["steady"]["queue"];
	schedSampleExtent: ParsedLinuxProbeJsonl["phaseSampleExtents"]["steady"]["sched"];
};
export type SendPathReplicate = CalibrationValues & {
	arm: Arm;
	rawGate: "PASS" | "MISS";
	cpuMs: number;
	steadyWallMsMax: number;
	serverSteadySnapshotIssued: number;
	clauses: ReturnType<typeof gradeSuccessorRung>["clauses"];
	phases: Record<
		Phase,
		{ native: NativePhaseSummary; linuxProbe: ProbePhaseSummary | null }
	>;
	nativeClockDomains: {
		serverId: number;
		pid: number;
		unit: "process-relative-monotonic-ns";
	}[];
	nativeHistogramBucketUpperBoundsNs: number[];
	observedSocketBuffers: {
		scope: "last-observed-socket-per-server-pid";
		shards: {
			serverId: number;
			pid: number;
			receiveBufferBytes: number;
			sendBufferBytes: number;
		}[];
	} | null;
	probeCpuSeconds: { user: number; system: number } | null;
	counters: Record<string, number>;
};
function fail(message: string): never {
	throw Error(`g6-c32-send-path-evaluate: ${message}`);
}
function object(value: unknown, label: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${label} must be structured evidence`);
	return value as RecordValue;
}
function required<T>(value: T | null | undefined, label: string): T {
	if (value === undefined || value === null) fail(`${label} is missing`);
	return value;
}
function records(value: unknown, label: string): RecordValue[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value.map((row) => object(row, label));
}
function field(value: unknown, ...path: string[]): unknown {
	return path.reduce<unknown>(
		(row, key) => object(row, path.join("."))[key],
		value,
	);
}
function exact(
	value: unknown,
	keys: readonly string[],
	label: string,
): RecordValue {
	const row = object(value, label);
	if (
		Object.keys(row).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(row, key))
	)
		fail(`${label} has missing or unknown fields`);
	return row;
}
function finite(value: unknown, label: string, positive = false): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		(positive && value === 0)
	)
		fail(
			`${label} is not ${positive ? "positive" : "nonnegative"} finite evidence`,
		);
	return value;
}
function count(value: unknown, label: string, positive = false): number {
	const result = finite(value, label, positive);
	if (!Number.isSafeInteger(result)) fail(`${label} must be a safe integer`);
	return result;
}
function sum(values: number[], label: string): number {
	return count(
		values.reduce((total, value) => total + count(value, label), 0),
		label,
	);
}
function sha(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		fail(`${label} must be SHA-256`);
	return value;
}
function closeEnough(left: number, right: number, fraction: number): boolean {
	return (
		Math.abs(right - left) <=
		Math.abs(left) * fraction + Number.EPSILON * Math.max(1, left, right) * 8
	);
}
function median(values: readonly (number | null)[]): number | null {
	const sorted = values.filter((value): value is number => value !== null);
	if (!values.length || sorted.length !== values.length) return null;
	sorted.sort((a, b) => a - b);
	const i = Math.floor(sorted.length / 2);
	const middle = required(sorted[i], "median middle value");
	return sorted.length % 2
		? middle
		: (required(sorted[i - 1], "median lower value") + middle) / 2;
}

/** Relative to the corresponding probe-OFF control; zero/zero is an exact match. */
export function evaluateProbeCalibration(
	control: CalibrationValues,
	observed: CalibrationValues,
) {
	const limits = {
		cpuCores: 0.05,
		ackP99Ms: 0.05,
		clientSteadySent: 0.005,
		serverSnapshotIssued: 0.005,
		clientSnapshotReceived: 0.005,
	} as const;
	const comparisons = Object.fromEntries(
		Object.entries(limits).map(([field, maximumRelativeShift]) => {
			const key = field as keyof typeof limits,
				a = finite(control[key], `control.${key}`),
				b = finite(observed[key], `probe.${key}`);
			return [
				key,
				{
					control: a,
					observed: b,
					relativeShift: a === 0 ? (b === 0 ? 0 : null) : Math.abs(b - a) / a,
					maximumRelativeShift,
					pass: closeEnough(a, b, maximumRelativeShift),
				},
			];
		}),
	);
	const unchangedNonAckClauses = NON_ACK.every(
		(key) =>
			typeof control.nonAckClausePass[key] === "boolean" &&
			control.nonAckClausePass[key] === observed.nonAckClausePass[key],
	);
	return {
		controlNodeId: control.nodeId,
		probeNodeId: observed.nodeId,
		valid:
			Object.values(comparisons).every((item) => item.pass) &&
			unchangedNonAckClauses,
		comparisons,
		unchangedNonAckClauses,
	};
}

function validatePair(
	input: SendPathAttributionInput,
	candidate: string,
	runId: string,
): RawPairIdentity {
	const raw = exact(
		input.boundHostPair,
		["server", "generator"],
		"bound host pair",
	);
	const pair = {
		server: validateHostIdentityPacket(raw.server),
		generator: validateHostIdentityPacket(raw.generator),
	};
	for (const role of ["server", "generator"] as const) {
		const host = pair[role];
		if (
			host.envelope.runId !== runId ||
			host.provider.role !== role ||
			host.source.commit !== candidate ||
			host.source.statusPorcelain !== "" ||
			host.runtime.os !== "Linux" ||
			host.binary.kind !== (role === "server" ? "native-addon" : "mmo-client")
		)
			fail(`${role} source/provenance differs from this frozen run`);
		if (
			host.provider.region !== "lon1" ||
			host.provider.size !== "c-48" ||
			host.provider.vcpus !== 48 ||
			host.provider.memoryMiB !== 98304
		)
			fail(`${role} differs from approved exact host shape`);
	}
	if (
		pair.server.provider.id === pair.generator.provider.id ||
		pair.server.bootId === pair.generator.bootId ||
		pair.server.provider.privateIpv4 === pair.generator.provider.privateIpv4 ||
		pair.server.provider.publicIpv4 === pair.generator.provider.publicIpv4 ||
		pair.server.provider.vpcUuid !== pair.generator.provider.vpcUuid ||
		pair.server.source.tree !== pair.generator.source.tree
	)
		fail("bound identities are not the exact distinct pair");
	return pair;
}

export { validateNative } from "./g6-capacity-diagnostic-coverage.ts";

function quantile(
	hist: NativeHistogram,
	bounds: number[],
	fraction: number,
): number | null {
	if (!hist.count) return null;
	const target = Math.ceil(hist.count * fraction);
	let total = 0;
	for (const [index, count] of hist.buckets.entries()) {
		total += count;
		if (total >= target) return bounds[index] ?? null;
	}
	return null;
}
function nativePhases(
	snapshots: NativeSendPathSnapshot[],
): Record<Phase, NativePhaseSummary> {
	const bucketBounds = required(
		snapshots[0],
		"native snapshot",
	).bucketUpperBoundsNs;
	return Object.fromEntries(
		PHASES.map((phase, phaseIndex) => {
			const components = snapshots.flatMap((snapshot) => snapshot.components);
			const intervals = Object.fromEntries(
				INTERVALS.map((name) => {
					const parts = components.map((comp) => {
						const bank = required(
							comp.phases.find((bank) => bank.phase === phase),
							`native ${phase} bank`,
						);
						return required(
							bank.intervals.find((interval) => interval.name === name),
							`native ${phase}.${name} interval`,
						).histogram;
					});
					const histogram: NativeHistogram = {
						count: sum(
							parts.map((hist) => hist.count),
							name,
						),
						buckets: Array.from({ length: 32 }, (_, index) =>
							sum(
								parts.map((hist) =>
									required(hist.buckets[index], `${name} bucket ${index}`),
								),
								name,
							),
						),
						crossedPhase: sum(
							parts.map((hist) => hist.crossedPhase),
							name,
						),
						outstanding: sum(
							parts.map((hist) => hist.outstanding),
							name,
						),
						censored: sum(
							parts.map((hist) => hist.censored),
							name,
						),
						rejected: sum(
							parts.map((hist) => hist.rejected),
							name,
						),
						overflow: sum(
							parts.map((hist) => hist.overflow),
							name,
						),
					};
					return [
						name,
						{
							...histogram,
							p50UpperBoundNs: quantile(histogram, bucketBounds, 0.5),
							p99UpperBoundNs: quantile(histogram, bucketBounds, 0.99),
						},
					];
				}),
			);
			const gauges = Object.fromEntries(
				GAUGES.map((name) => {
					const values = components.map((comp) => {
						const gauge = required(
							comp.gauges.find((gauge) => gauge.name === name),
							`native ${name} gauge`,
						).gauge;
						return required(
							gauge.phaseHighWater[phaseIndex + 1],
							`${name} ${phase} high water`,
						);
					});
					return [
						name,
						{
							summedComponentHighWater: sum(values, name),
							maxComponentHighWater: Math.max(0, ...values),
						},
					];
				}),
			);
			return [phase, { intervals, gauges }];
		}),
	) as Record<Phase, NativePhaseSummary>;
}
function probePhases(
	text: string,
	parsed: ParsedLinuxProbeJsonl,
): Record<Phase, ProbePhaseSummary> {
	const rows = text
		.trim()
		.split("\n")
		.map((line) => object(JSON.parse(line), "probe record"));
	return Object.fromEntries(
		PHASES.map((phase) => {
			const queue = rows.filter(
					(row) =>
						row.schema === "g6-c32-linux-probe-queue/2" && row.phase === phase,
				),
				sched = rows.filter(
					(row) =>
						row.schema === "g6-c32-linux-probe-sched/2" && row.phase === phase,
				);
			const qsum = (row: RecordValue, field: string) =>
				sum(
					records(row.shards, "probe queue shards").map((shard) =>
						count(shard[field], field),
					),
					field,
				);
			const ssum = (row: RecordValue, field: string) =>
				sum(
					records(row.sched, "probe scheduler shards").map((shard) =>
						count(shard[field], field),
					),
					field,
				);
			const first = required(sched[0], `${phase} first scheduler sample`),
				last = required(sched.at(-1), `${phase} last scheduler sample`);
			const softnetDelta = (key: string) =>
				count(field(last, "softnet", key), `last softnet ${key}`) -
				count(field(first, "softnet", key), `first softnet ${key}`);
			return [
				phase,
				{
					queueSamples: queue.length,
					schedSamples: sched.length,
					peakOwnedRxQueueBytes: Math.max(
						...queue.map((row) => qsum(row, "rxQueueBytes")),
					),
					peakOwnedTxQueueBytes: Math.max(
						...queue.map((row) => qsum(row, "txQueueBytes")),
					),
					observedSocketDropsDelta:
						qsum(
							required(queue.at(-1), `${phase} last queue sample`),
							"drops",
						) -
						qsum(required(queue[0], `${phase} first queue sample`), "drops"),
					observedSchedstatRuntimeDeltaNs:
						ssum(last, "runtimeNs") - ssum(first, "runtimeNs"),
					observedSchedstatWaitDeltaNs:
						ssum(last, "waitNs") - ssum(first, "waitNs"),
					observedSchedstatTimeslicesDelta:
						ssum(last, "timeslices") - ssum(first, "timeslices"),
					observedNetRxSoftirqDelta:
						count(last.netRx, "last netRx") - count(first.netRx, "first netRx"),
					observedSoftnetProcessedDelta: softnetDelta("processed"),
					observedSoftnetDroppedDelta: softnetDelta("dropped"),
					observedSoftnetTimeSqueezeDelta: softnetDelta("timeSqueeze"),
					peakProcsRunning: Math.max(
						...sched.map((row) => count(row.procsRunning, "procsRunning")),
					),
					peakLoad1: Math.max(
						...sched.map((row) => finite(row.load1, "load1")),
					),
					queueSampleExtent: parsed.phaseSampleExtents[phase].queue,
					schedSampleExtent: parsed.phaseSampleExtents[phase].sched,
				},
			];
		}),
	) as Record<Phase, ProbePhaseSummary>;
}

function summarizeArm(rows: SendPathReplicate[]) {
	const first = required(rows[0], "arm replicate");
	const scalarKeys = [
		"cpuMs",
		"cpuCores",
		"steadyWallMsMax",
		"ackP99Ms",
		"clientSteadySent",
		"serverSnapshotIssued",
		"serverSteadySnapshotIssued",
		"clientSnapshotReceived",
	] as const;
	return {
		replicateNodeIds: rows.map((row) => row.nodeId),
		median: Object.fromEntries(
			scalarKeys.map((key) => [key, median(rows.map((row) => row[key]))]),
		),
		countersMedian: Object.fromEntries(
			Object.keys(first.counters).map((key) => [
				key,
				median(
					rows.map((row) => required(row.counters[key], `replicate ${key}`)),
				),
			]),
		),
		phases: Object.fromEntries(
			PHASES.map((phase) => [
				phase,
				{
					native: {
						intervals: Object.fromEntries(
							INTERVALS.map((name) => [
								name,
								Object.fromEntries(
									(
										[
											"count",
											"crossedPhase",
											"outstanding",
											"censored",
											"rejected",
											"overflow",
											"p50UpperBoundNs",
											"p99UpperBoundNs",
										] as const
									).map((key) => [
										key,
										median(
											rows.map(
												(row) => row.phases[phase].native.intervals[name][key],
											),
										),
									]),
								),
							]),
						),
						gauges: Object.fromEntries(
							GAUGES.map((name) => [
								name,
								Object.fromEntries(
									(
										[
											"summedComponentHighWater",
											"maxComponentHighWater",
										] as const
									).map((key) => [
										key,
										median(
											rows.map(
												(row) => row.phases[phase].native.gauges[name][key],
											),
										),
									]),
								),
							]),
						),
					},
					linuxProbe: rows.every((row) => row.phases[phase].linuxProbe !== null)
						? Object.fromEntries(
								Object.entries(
									required(first.phases[phase].linuxProbe, `${phase} probe`),
								)
									.filter(([, value]) => typeof value === "number")
									.map(([key]) => [
										key,
										median(
											rows.map((row) => {
												const value = object(
													row.phases[phase].linuxProbe,
													`${phase} probe`,
												)[key];
												if (typeof value !== "number")
													fail(`probe ${key} is not numeric`);
												return value;
											}),
										),
									]),
							)
						: null,
				},
			]),
		),
	};
}

export function evaluateSendPathAttribution(input: SendPathAttributionInput) {
	const replicates: SendPathReplicate[] = [],
		reasons: string[] = [];
	const base = {
		schema: "g6-c32-send-path-attribution/1" as const,
		capacityVerdict: "NOT_CAPACITY_EVIDENCE" as const,
		measurementNotes: [
			"A is paired attribution, not a rated-capacity completion claim.",
			"Native histogram banks are final origin-phase observations, not deltas; crossed/censored/rejected/overflow counts remain explicit. UDP socket intervals include all accepted transmits, not identified ACK payloads.",
			"Native clocks are process-relative; no absolute native-to-probe timestamp subtraction or inferred wire-hold latency is performed.",
			"Native histogram bucketUpperBoundsNs describes buckets 0..30; bucket 31 is overflow and its quantiles are unbounded (null).",
			"Server offered-work calibration uses aggregate.steadyDrain.emitter.snapshotIssued: the frozen complete booking of steady-window sends. serverSteadySnapshotIssued retains the earlier phase-edge count separately.",
			"Linux schedstat is /proc/<server-pid>/schedstat for the leader task. Observed deltas cover first-to-last samples only, not unobserved phase edges or all Tokio worker threads.",
			"Summed component high-water marks are an upper bound, not a simultaneous global queue maximum; arm medians are medians of replicate summaries, not pooled histograms.",
			"Buffer-setting proof is the exact per-role sysctl operation and its output, not a claim of exact per-socket SO_RCVBUF. Detailed-probe socketMemory is the last ss socket observed per PID; A0 has no detailed socket observation. Linux explicit SO_RCVBUF doubling must not be inferred from a sysctl default.",
			"Positive peer-hint counts and aggregate SndbufErrors alone establish no causal mechanism or identity-safe priority.",
		],
	};
	try {
		const policy = validateBudgetPolicy(input.policy);
		if (
			policy.schema !== "g6-c32-budget-policy/2" ||
			policy.lifecycle !== "attribution-only" ||
			canonicalArtifactSha256(policy.workPlan) !==
				canonicalArtifactSha256(makeAttributionWorkPlan())
		)
			fail("requires exact frozen eight-cell attribution DAG");
		const workAuthority = validateWorkAuthority(input.workAuthority);
		if (
			canonicalArtifactSha256(readWorkAuthority(input.root)) !==
			canonicalArtifactSha256(workAuthority)
		)
			fail("work capsule differs from independent attribution authority");
		const pair = validatePair(input, workAuthority.candidateSha, policy.runId);
		if (
			canonicalArtifactSha256(pair) !==
			canonicalArtifactSha256(workAuthority.pair)
		)
			fail("attribution pair differs from work capsule");
		if (
			workAuthority.nativeProducerSha256 !==
				sha(input.nativeProducerSha256, "native producer authority") ||
			workAuthority.probeProducerSha256 !==
				sha(input.probeProducerSha256, "probe producer authority")
		)
			fail("diagnostic producer is not frozen authority");
		const final = verifyWorkFinal(input);
		if (
			final.terminal !== "ATTRIBUTION_COMPLETE" ||
			final.completed.length !== 8
		)
			fail("attribution sequence is missing, invalid, or incomplete");
		const ledger = validateSpendLedger(input.ledger, {
			requireSeal: false,
		}).entries.filter(
			(entry) =>
				entry.event !== "SEAL" &&
				Date.parse(entry.recordedAt) <= Date.parse(final.recordedAt),
		);
		const progress = readWorkExecution({
			...input,
			ledger,
			now: final.recordedAt,
		});
		for (const [index, completion] of progress.completions.entries()) {
			const node = required(policy.workPlan.nodes[index], `work node ${index}`),
				p = required(
					policy.workProfiles[node.profile],
					`work profile ${node.profile}`,
				);
			if (
				node.id !== completion.nodeId ||
				node.requestedSessions !== 40000 ||
				node.activeWorkloadSessions !== 40000 ||
				p.pacerPps !== 0 ||
				p.nativeDiagnostics !== true
			)
				fail("order, full-workload or common frozen knobs differ");
			const evidence = readWorkCellEvidence(input.root, node, p, workAuthority);
			const {
				scan,
				diagnostic,
				report: client,
				native: snapshots,
				probe: parsedProbe,
			} = validateCapacityRawCell(evidence);
			const native = nativePhases(snapshots);
			let probe: Record<Phase, ProbePhaseSummary> | null = null,
				probeCpuSeconds: { user: number; system: number } | null = null,
				observedSocketBuffers: SendPathReplicate["observedSocketBuffers"] =
					null;
			if (p.detailedProbe) {
				const text = required(evidence.probe, "detailed probe text"),
					parsed = required(parsedProbe, "validated detailed probe");
				const header = object(
					JSON.parse(text.slice(0, text.indexOf("\n"))),
					"probe header",
				);
				observedSocketBuffers = {
					scope: "last-observed-socket-per-server-pid",
					shards: records(header.shards, "probe header shards").map(
						(shard) => ({
							serverId: count(shard.serverId, "probe server ID", true),
							pid: count(shard.pid, "probe PID", true),
							receiveBufferBytes: count(
								field(shard, "socketMemory", "receiveBufferBytes"),
								"socket receive buffer",
							),
							sendBufferBytes: count(
								field(shard, "socketMemory", "sendBufferBytes"),
								"socket send buffer",
							),
						}),
					),
				};
				probe = probePhases(text, parsed);
				const cpu = object(parsed.summary.summary, "probe summary");
				probeCpuSeconds = {
					user: finite(cpu.probeUserSec, "observer user CPU"),
					system: finite(cpu.probeSysSec, "observer system CPU"),
				};
			}
			const grade = gradeSuccessorRung({
				rung: 40000,
				scan: scan as RungScan,
				postRunSteeringText: evidence.postRunSteeringText,
				expectCandidate: progress.state.candidateSha,
				registrationSha256: progress.state.registrationSha256,
				profile: p,
			});
			if (!grade.valid || !grade.gate) fail("raw S1-S5 grade is invalid");
			const shards = records(scan.shards, "scan shards");
			const cpuMs = shards.reduce(
					(total, shard) =>
						total +
						finite(
							field(shard, "windows", "steady", "cpuMs"),
							"steady process CPU",
						),
					0,
				),
				steadyWallMsMax = Math.max(
					...shards.map((shard) =>
						finite(
							field(shard, "windows", "steady", "wallMs"),
							"steady wall time",
							true,
						),
					),
				);
			if (
				!closeEnough(
					finite(field(scan, "aggregate", "steady", "cpuMs"), "aggregate CPU"),
					cpuMs,
					1e-12,
				) ||
				field(scan, "aggregate", "steady", "wallMsMax") !== steadyWallMsMax
			)
				fail("raw CPU aggregate differs from shards");
			const counters: Record<string, number> = {};
			for (const name of [
				"udpSendBatchErrors",
				"udpSendBatchCongestionDropped",
				"datagramReflectRingBypassed",
				"datagramReflectRingBypassMarked",
				"datagramReflectRingDirectBlocked",
				"datagramReflectRingDirectErrors",
				"datagramReflectRingGsoFallback",
			])
				counters[name] = sum(
					shards.map((shard) =>
						count(field(shard, "windows", "lifetime", "metrics", name), name),
					),
					name,
				);
			for (const [role, host] of [
				["server", diagnostic.serverHostUdp],
				["generator", client.hostUdp],
			] as const)
				counters[`${role}LifetimeSndbufErrorsDelta`] =
					count(field(host, "idle", "SndbufErrors"), "SndbufErrors") -
					count(field(host, "connect", "SndbufErrors"), "SndbufErrors");
			replicates.push({
				nodeId: node.id,
				arm: required(ARM_ORDER[index], `arm ${index}`),
				rawGate: grade.gate,
				cpuMs,
				steadyWallMsMax,
				cpuCores: cpuMs / steadyWallMsMax,
				ackP99Ms: finite(grade.clauses.S4_ackRttP99Ms?.value, "ACK p99"),
				clientSteadySent: count(
					field(client, "windows", "steady", "sent"),
					"client offered packets",
					true,
				),
				serverSnapshotIssued: count(
					field(scan, "aggregate", "steadyDrain", "emitter", "snapshotIssued"),
					"server issued snapshots",
					true,
				),
				serverSteadySnapshotIssued: count(
					field(scan, "aggregate", "steady", "emitter", "snapshotIssued"),
					"server phase-edge issued snapshots",
					true,
				),
				clientSnapshotReceived: count(
					field(client, "windows", "steadyDrain", "rxSnapshot"),
					"client delivered snapshots",
					true,
				),
				nonAckClausePass: Object.fromEntries(
					NON_ACK.map((key) => [
						key,
						required(grade.clauses[key], `grade ${key}`).pass,
					]),
				),
				clauses: grade.clauses,
				phases: Object.fromEntries(
					PHASES.map((phase) => [
						phase,
						{ native: native[phase], linuxProbe: probe?.[phase] ?? null },
					]),
				) as SendPathReplicate["phases"],
				nativeClockDomains: records(
					field(diagnostic, "sendPathDiagnostics", "shards"),
					"native shards",
				).map((row) => ({
					serverId: count(row.serverId, "native server ID", true),
					pid: count(row.pid, "native PID", true),
					unit: "process-relative-monotonic-ns",
				})),
				probeCpuSeconds,
				observedSocketBuffers,
				nativeHistogramBucketUpperBoundsNs: required(
					snapshots[0],
					"native snapshot",
				).bucketUpperBoundsNs,
				counters,
			});
		}
		const calibration = [
			evaluateProbeCalibration(
				required(replicates[0], "first A0 replicate"),
				required(replicates[1], "first A1 replicate"),
			),
			evaluateProbeCalibration(
				required(replicates[7], "second A0 replicate"),
				required(replicates[6], "second A1 replicate"),
			),
		];
		const offeredParity = Object.fromEntries(
			(["clientSteadySent", "serverSnapshotIssued"] as const).map((key) => {
				const values = replicates.map((row) => row[key]),
					minimum = Math.min(...values),
					maximum = Math.max(...values);
				return [
					key,
					{
						minimum,
						maximum,
						relativeRange: (maximum - minimum) / minimum,
						maximumRelativeRange: 0.005,
						pass: closeEnough(minimum, maximum, 0.005),
					},
				];
			}),
		);
		const calibrated = calibration.every((pair) => pair.valid),
			parity = Object.values(offeredParity).every((row) => row.pass);
		if (!calibrated)
			reasons.push(
				"paired detailed-probe CPU/ACK/work/delivery calibration failed; causal attribution is invalid",
			);
		if (!parity)
			reasons.push(
				"offered-work parity across all eight cells exceeds 0.5%; comparison is invalid",
			);
		return {
			...base,
			evidenceValid: true,
			attributionVerdict:
				calibrated && parity
					? "VALID_PAIRED_ATTRIBUTION"
					: calibrated
						? "INVALID_WORK_PARITY"
						: "INVALID_PROBE_INTERFERENCE",
			reasons,
			recordedAt: final.recordedAt,
			policySha256: final.policySha256,
			authoritySha256: canonicalArtifactSha256({
				pair,
				nativeProducerSha256: input.nativeProducerSha256,
				probeProducerSha256: input.probeProducerSha256,
			}),
			replicates,
			arms: Object.fromEntries(
				(["A0", "A1", "B", "C"] as const).map((arm) => [
					arm,
					summarizeArm(replicates.filter((row) => row.arm === arm)),
				]),
			),
			calibration,
			offeredParity,
		};
	} catch (error) {
		reasons.push(error instanceof Error ? error.message : String(error));
		return {
			...base,
			evidenceValid: false,
			attributionVerdict: "INVALID_EVIDENCE",
			reasons,
			replicates,
			arms: {} as Record<string, ReturnType<typeof summarizeArm>>,
			calibration: [] as ReturnType<typeof evaluateProbeCalibration>[],
			offeredParity: {},
		};
	}
}

/** All authority inputs are retained paths; stdout is the sole output artifact. */
export function runSendPathEvaluateCli(args: readonly string[]) {
	const allowed = ["--root", "--policy", "--ledger", "--authority"],
		values: Record<string, string> = {};
	if (args.length !== allowed.length * 2)
		fail("expected --root --policy --ledger --authority retained paths");
	for (let i = 0; i < args.length; i += 2) {
		const key = required(args[i], "CLI option"),
			value = required(args[i + 1], "CLI option value");
		if (
			!allowed.includes(key) ||
			values[key] ||
			!value ||
			value.startsWith("--")
		)
			fail("unknown, duplicate or missing CLI option");
		values[key] = value;
	}
	const authority = exact(
		JSON.parse(
			readFileSync(required(values["--authority"], "--authority"), "utf8"),
		),
		[
			"schema",
			"boundHostPair",
			"nativeProducerSha256",
			"probeProducerSha256",
			"workAuthority",
		],
		"retained attribution authority",
	);
	if (authority.schema !== "g6-c32-send-path-authority/1")
		fail("unknown attribution authority schema");
	return evaluateSendPathAttribution({
		root: required(values["--root"], "--root"),
		policy: validateBudgetPolicy(
			JSON.parse(
				readFileSync(required(values["--policy"], "--policy"), "utf8"),
			),
		),
		ledger: validateSpendLedger(
			JSON.parse(
				readFileSync(required(values["--ledger"], "--ledger"), "utf8"),
			),
			{ requireSeal: false },
		).entries,
		boundHostPair: authority.boundHostPair,
		workAuthority: validateWorkAuthority(authority.workAuthority),
		nativeProducerSha256: sha(
			authority.nativeProducerSha256,
			"native producer authority",
		),
		probeProducerSha256: sha(
			authority.probeProducerSha256,
			"probe producer authority",
		),
	});
}
if (import.meta.main) {
	try {
		const result = runSendPathEvaluateCli(process.argv.slice(2));
		console.log(JSON.stringify(result));
		process.exitCode =
			result.attributionVerdict === "VALID_PAIRED_ATTRIBUTION" ? 0 : 2;
	} catch (error) {
		console.error(String(error));
		process.exitCode = 2;
	}
}
