/** Orthogonal RCA evaluator for the registered c-32 G6 campaign. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_HZ, snapshotDatagrams } from "./g6-plan.ts";
import {
	applySteeringValidity,
	gradeRungForProfile,
	type RungScan,
	steeredTotal,
} from "./g6-sharded-grade.ts";

type Factor = "B" | "C" | "D";
type Terminal =
	| "INCOMPLETE"
	| "HIGH_LOAD_FACTOR_CONFIRMED"
	| "RCA_CONFIRMED"
	| "RCA_INTERACTION"
	| "RCA_UNRESOLVED"
	| "LADDER_COMPLETE";

type JsonRecord = Record<string, unknown>;

export type RcaQualityRequest = {
	rung: number;
	scan: RungScan;
	postRunSteeringText: string;
	expectCandidate: string;
	registrationSha256: string;
	expectedEndpoints: number;
	expectedConnectConcurrency: number;
	expectedConnectRate: number;
	expectedFixedSourcePortBase: number | null;
};

export type RcaQualityDecision = {
	schema: "g6-c32-rca-quality/1";
	status: "RCA_QUALITY_PASS" | "RCA_QUALITY_MISS" | "INCOMPLETE";
	historicalGrade: false;
	valid: boolean;
	gate: "PASS" | "MISS" | null;
	invalidReasons: string[];
	clauses: ReturnType<typeof gradeRungForProfile>["clauses"];
};

export type RcaCellDecision = {
	schema: "g6-c32-rca-cell/1";
	cell: string;
	complete: boolean;
	reasons: string[];
	functionalPass: boolean;
	rcaQualityPass: boolean;
	rigCleanPass: boolean;
	ingressCleanPass: boolean;
	connectWallSec: number;
	connectOwnedSocketDrops: number;
	connectServerRcvbufErrors: number;
	generatorConnectErrors: number;
	postConnectServerRcvbufErrors: number;
	hostSocketDropEquality: boolean;
	maxFallbackSessionExcessPerShard: number | null;
	peakReceiveQueueBytes: number | null;
	effectiveReceiveBufferBytes: number | null;
	steadySent: number;
	drainStallAligned: boolean;
	qualityFamily?: "historical" | "rca-only";
	quality?: RcaQualityDecision;
};

type CellLike = Partial<RcaCellDecision> & { cell?: unknown };

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function nonnegative(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clientEnvelope(scan: RungScan): JsonRecord | null {
	const marker = "mmo-client: json ";
	const line = scan.clientStdout
		.split(/\r?\n/)
		.find((entry) => entry.startsWith(marker));
	if (!line) return null;
	try {
		return record(JSON.parse(line.slice(marker.length)));
	} catch {
		return null;
	}
}

function shapeReasons(request: RcaQualityRequest): string[] {
	const reasons: string[] = [];
	if (!/^[0-9a-f]{64}$/.test(request.registrationSha256))
		reasons.push("registration SHA-256 is malformed");
	const scanConfig = request.scan.config;
	if (scanConfig.connectConcurrency !== request.expectedConnectConcurrency)
		reasons.push("scan connectConcurrency differs from registered cell");
	if (scanConfig.connectRatePerSec !== request.expectedConnectRate)
		reasons.push("scan connectRatePerSec differs from registered cell");
	if (scanConfig.fixedSourcePortBase !== request.expectedFixedSourcePortBase)
		reasons.push("scan fixedSourcePortBase differs from registered cell");
	const report = clientEnvelope(request.scan);
	if (!report)
		return [...reasons, "mmo-client/2 report is missing or malformed"];
	if (report.schema !== "mmo-client/2")
		reasons.push("RCA requires mmo-client/2");
	if (record(report.preRegistration)?.sha256 !== request.registrationSha256)
		reasons.push("client registration digest differs from RCA registration");
	if (report.connectConcurrency !== request.expectedConnectConcurrency)
		reasons.push("client connectConcurrency differs from registered cell");
	if (report.connectRatePerSec !== request.expectedConnectRate)
		reasons.push("client connectRatePerSec differs from registered cell");
	const config = record(report.config);
	if (config?.fixedSourcePortBase !== request.expectedFixedSourcePortBase)
		reasons.push("client fixedSourcePortBase differs from registered cell");
	const starts = record(report.connectStarts);
	if (starts?.offered !== request.rung || starts.achieved !== request.rung)
		reasons.push("connect starts do not attest every requested session");
	const addresses = record(report.client)?.endpointSourceAddresses;
	if (
		!Array.isArray(addresses) ||
		addresses.length !== request.expectedEndpoints ||
		addresses.some((address) => typeof address !== "string") ||
		new Set(addresses).size !== request.expectedEndpoints
	)
		reasons.push(
			"endpoint source addresses do not attest registered endpoints",
		);
	return reasons;
}

export function evaluateRcaQuality(
	request: RcaQualityRequest,
): RcaQualityDecision {
	const verdict = gradeRungForProfile(
		request.rung,
		request.scan,
		request.expectCandidate,
		{ requiredEndpoints: request.expectedEndpoints },
	);
	const shape = shapeReasons(request);
	if (shape.length > 0) {
		verdict.valid = false;
		verdict.gate = null;
		verdict.invalidReasons.push(...shape);
	}
	applySteeringValidity([verdict], [request.postRunSteeringText]);
	return {
		schema: "g6-c32-rca-quality/1",
		status: !verdict.valid
			? "INCOMPLETE"
			: verdict.gate === "PASS"
				? "RCA_QUALITY_PASS"
				: "RCA_QUALITY_MISS",
		historicalGrade: false,
		valid: verdict.valid,
		gate: verdict.gate,
		invalidReasons: verdict.invalidReasons,
		clauses: verdict.clauses,
	};
}

function counterDelta(
	samples: JsonRecord | null,
	start: string,
	end: string,
	field: string,
): number | null {
	const before = record(samples?.[start]);
	const after = record(samples?.[end]);
	const left = before?.[field];
	const right = after?.[field];
	return nonnegative(left) && nonnegative(right) && right >= left
		? right - left
		: null;
}

function perShardDropDelta(diagnostic: JsonRecord | null): number | null {
	const ladder = Array.isArray(diagnostic?.ladder) ? diagnostic.ladder : [];
	if (ladder.length !== 1) return null;
	const rung = record(ladder[0]);
	const before = record(record(rung?.T0)?.perShardUdp);
	const after = record(record(rung?.T2)?.perShardUdp);
	if (!before || !after) return null;
	const keys = Array.from({ length: 16 }, (_, index) => String(index + 1));
	if (
		Object.keys(before).length !== 16 ||
		Object.keys(after).length !== 16 ||
		keys.some((key) => !record(before[key]) || !record(after[key]))
	)
		return null;
	let total = 0;
	for (const key of keys) {
		const start = record(before[key])?.drops;
		const end = record(after[key])?.drops;
		if (!nonnegative(start) || !nonnegative(end) || end < start) return null;
		total += end - start;
	}
	return total;
}

function lifecycleClean(value: unknown): boolean {
	if (!Array.isArray(value) || value.length !== 16) return false;
	const phases = ["connect", "steady", "drain", "idle", "stop"];
	const ids = new Set<number>();
	for (const entry of value) {
		const shard = record(entry);
		if (!nonnegative(shard?.serverId) || shard.serverId === 0) return false;
		ids.add(shard.serverId);
		const boundaries = Array.isArray(shard.boundaries) ? shard.boundaries : [];
		const exits = Array.isArray(shard.exits) ? shard.exits : [];
		if (
			boundaries.length !== phases.length ||
			boundaries.some(
				(boundary, index) => record(boundary)?.phase !== phases[index],
			) ||
			exits.length !== 1 ||
			record(exits[0])?.code !== 0 ||
			record(exits[0])?.signal !== null
		)
			return false;
	}
	return ids.size === 16;
}

function bpfPreArmClean(value: unknown): boolean {
	const preArm = record(value);
	const receipt = record(preArm?.receiptValidation);
	const steering = record(preArm?.steerStats);
	return (
		preArm?.fresh === true &&
		preArm.socksEntries === 16 &&
		receipt?.valid === true &&
		receipt.instances === 16 &&
		steering?.steered === 0 &&
		steering.fallback === 0
	);
}

function probeSummary(value: unknown): {
	complete: boolean;
	peakReceiveQueueBytes: number | null;
	effectiveReceiveBufferBytes: number | null;
	drainStallAligned: boolean;
} {
	const probe = record(value);
	const summary = record(probe?.summary) ?? probe;
	const complete =
		probe?.schema === "g6-c32-linux-probe/1" && probe.complete === true;
	return {
		complete,
		peakReceiveQueueBytes: finiteNonnegative(summary?.peakReceiveQueueBytes)
			? summary.peakReceiveQueueBytes
			: null,
		effectiveReceiveBufferBytes: finiteNonnegative(
			summary?.effectiveReceiveBufferBytes,
		)
			? summary.effectiveReceiveBufferBytes
			: null,
		drainStallAligned: summary?.drainStallAligned === true,
	};
}

function maxFallbackSessionExcessPerShard(scan: RungScan): number | null {
	if (scan.shards.length !== 16) return null;
	const sessions = scan.shards.map((shard) => shard.sessionsAtSteady);
	if (
		sessions.some(
			(value) => !finiteNonnegative(value) || !Number.isSafeInteger(value),
		)
	)
		return null;
	const total = (sessions as number[]).reduce((sum, value) => sum + value, 0);
	return Math.max(...(sessions as number[])) - Math.ceil(total / 16);
}

export function evaluateCell(input: {
	cell: string;
	gradeMode: "historical" | "rca-only";
	qualityRequest: RcaQualityRequest;
	diagnostic: unknown;
	probe: unknown;
	probeRequired: boolean;
}): RcaCellDecision {
	const diagnostic = record(input.diagnostic);
	const report = clientEnvelope(input.qualityRequest.scan);
	const quality = evaluateRcaQuality(input.qualityRequest);
	const reasons = [...quality.invalidReasons];
	const dispatch = record(diagnostic?.dispatch);
	if (diagnostic?.schema !== "g6-sharded-diagnostic/2")
		reasons.push("diagnostic schema must be g6-sharded-diagnostic/2");
	if (diagnostic?.candidateSha !== input.qualityRequest.expectCandidate)
		reasons.push("diagnostic candidate differs from registered candidate");
	for (const [field, expected] of [
		["sessions", input.qualityRequest.rung],
		["endpoints", input.qualityRequest.expectedEndpoints],
		["connectConcurrency", input.qualityRequest.expectedConnectConcurrency],
		["connectRatePerSec", input.qualityRequest.expectedConnectRate],
		["fixedSourcePortBase", input.qualityRequest.expectedFixedSourcePortBase],
	] as const) {
		if (dispatch?.[field] !== expected)
			reasons.push(`diagnostic ${field} differs from registered cell`);
	}
	if (!bpfPreArmClean(diagnostic?.bpfPreArm))
		reasons.push("BPF pre-arm is invalid");
	const postRun = record(diagnostic?.postRunSteering);
	const rawSteered = steeredTotal(input.qualityRequest.postRunSteeringText);
	if (
		!postRun ||
		!finiteNonnegative(postRun.capturedAtMs) ||
		typeof rawSteered !== "number" ||
		record(postRun.steerStatsSum)?.steered !== rawSteered
	)
		reasons.push(
			"diagnostic post-run steering metadata does not match raw witness",
		);
	const ownedDrops = perShardDropDelta(diagnostic);
	if (ownedDrops === null)
		reasons.push("owned socket connect-drop evidence is incomplete");
	const serverSamples = record(diagnostic?.serverHostUdp);
	const generatorSamples = record(report?.hostUdp);
	const serverConnect = counterDelta(
		serverSamples,
		"connect",
		"steady",
		"RcvbufErrors",
	);
	const serverPost = counterDelta(
		serverSamples,
		"steady",
		"idle",
		"RcvbufErrors",
	);
	const generatorConnect = counterDelta(
		generatorSamples,
		"connect",
		"steady",
		"RcvbufErrors",
	);
	for (const [name, value] of [
		["server connect RcvbufErrors", serverConnect],
		["server post-connect RcvbufErrors", serverPost],
		["generator connect RcvbufErrors", generatorConnect],
	] as const)
		if (value === null) reasons.push(`${name} evidence is incomplete`);
	const ladder = Array.isArray(diagnostic?.ladder) ? diagnostic.ladder : [];
	const connectWallSec = record(ladder[0])?.connectWallSec;
	if (!finiteNonnegative(connectWallSec))
		reasons.push("connect wall time is missing");
	const probe = probeSummary(input.probe);
	if (input.probeRequired && !probe.complete)
		reasons.push("Linux probe evidence is incomplete");
	const lifecycle = lifecycleClean(diagnostic?.perShardLifecycle);
	if (!lifecycle) reasons.push("16-process lifecycle is not clean");
	const windows = record(report?.windows);
	const steady = record(windows?.steady);
	const sessionsErr = report?.sessionsErr;
	const sessionsLost = steady?.sessionsLost;
	const functionalPass =
		quality.valid &&
		quality.gate === "PASS" &&
		sessionsErr === 0 &&
		sessionsLost === 0 &&
		lifecycle;
	const hostSocketDropEquality =
		ownedDrops !== null &&
		serverConnect !== null &&
		ownedDrops === serverConnect;
	const totalServer = ["InErrors", "RcvbufErrors", "SndbufErrors"].map(
		(field) => counterDelta(serverSamples, "connect", "idle", field),
	);
	const totalGenerator = ["InErrors", "RcvbufErrors", "SndbufErrors"].map(
		(field) => counterDelta(generatorSamples, "connect", "idle", field),
	);
	const rigCleanPass =
		functionalPass &&
		totalServer.every((value) => value === 0) &&
		totalGenerator.every((value) => value === 0);
	const ingressServer = ["InErrors", "RcvbufErrors"].map((field) =>
		counterDelta(serverSamples, "connect", "idle", field),
	);
	const ingressGenerator = ["InErrors", "RcvbufErrors"].map((field) =>
		counterDelta(generatorSamples, "connect", "idle", field),
	);
	const ingressCleanPass =
		functionalPass &&
		ingressServer.every((value) => value === 0) &&
		ingressGenerator.every((value) => value === 0);
	const maxFallbackSessionExcess = maxFallbackSessionExcessPerShard(
		input.qualityRequest.scan,
	);
	if (maxFallbackSessionExcess === null)
		reasons.push("per-shard fallback-routed session evidence is incomplete");
	const complete = reasons.length === 0;
	return {
		schema: "g6-c32-rca-cell/1",
		cell: input.cell,
		complete,
		reasons,
		functionalPass,
		rcaQualityPass: quality.status === "RCA_QUALITY_PASS",
		rigCleanPass,
		ingressCleanPass,
		connectWallSec: finiteNonnegative(connectWallSec) ? connectWallSec : 0,
		connectOwnedSocketDrops: ownedDrops ?? 0,
		connectServerRcvbufErrors: serverConnect ?? 0,
		generatorConnectErrors: generatorConnect ?? 0,
		postConnectServerRcvbufErrors: serverPost ?? 0,
		hostSocketDropEquality,
		maxFallbackSessionExcessPerShard: maxFallbackSessionExcess,
		peakReceiveQueueBytes: probe.peakReceiveQueueBytes,
		effectiveReceiveBufferBytes: probe.effectiveReceiveBufferBytes,
		steadySent: finiteNonnegative(steady?.sent) ? steady.sent : 0,
		drainStallAligned: probe.drainStallAligned,
		qualityFamily: input.gradeMode,
		quality,
	};
}

export type SessionScaleEvidence = {
	schema: "g6-c32-session-scale-evidence/1";
	label: string;
	complete: boolean;
	reasons: string[];
	requestedSessions: number;
	activeWorkloadSessions: number;
	sessionsOk: number;
	sessionsErr: number;
	steadySessionsLost: number;
	lifecycleClean: boolean;
	hostClean: boolean;
	passiveJoinCount: number;
	ingestRatio: number;
	deliveryRatio: number;
	dutyRatio: number;
};

export function evaluateSessionScaleCell(input: {
	label: string;
	scan: RungScan;
	diagnostic: unknown;
	expectCandidate: string;
	expectedRequestedSessions: number;
	expectedActiveWorkloadSessions: number;
}): SessionScaleEvidence {
	const reasons: string[] = [];
	const scan = input.scan as RungScan & {
		config: RungScan["config"] & { activeWorkloadSessions?: number };
		aggregate: RungScan["aggregate"] & {
			lifetime?: { rxByClass?: { raidJoin?: number } };
		};
	};
	const diagnostic = record(input.diagnostic);
	const report = clientEnvelope(scan);
	const requested = input.expectedRequestedSessions;
	const active = input.expectedActiveWorkloadSessions;
	if (scan.candidateSha !== input.expectCandidate)
		reasons.push("scan candidate differs from registered candidate");
	if (diagnostic?.candidateSha !== input.expectCandidate)
		reasons.push("diagnostic candidate differs from registered candidate");
	if (scan.config.sessions !== requested)
		reasons.push("scan requested sessions differ from companion cell");
	if (scan.config.activeWorkloadSessions !== active)
		reasons.push("scan active workload sessions differ from companion cell");
	if (
		requested <= active ||
		active <= 0 ||
		!Number.isSafeInteger(requested) ||
		!Number.isSafeInteger(active)
	)
		reasons.push("companion requested/active session counts are invalid");
	if (!report) reasons.push("mmo-client/2 report is missing or malformed");
	if (report?.sessionsRequested !== requested)
		reasons.push("client requested sessions differ from companion cell");
	if (report?.activeWorkloadSessions !== active)
		reasons.push("client active workload sessions differ from companion cell");
	if (scan.clientExit !== 0) reasons.push("client did not exit cleanly");
	if (
		scan.shards.length !== 16 ||
		scan.shards.some((shard) => shard.windows === null) ||
		scan.shards.reduce(
			(sum, shard) => sum + (shard.sessionsAtSteady ?? 0),
			0,
		) !== requested
	)
		reasons.push("shard/session steady evidence is incomplete");
	const kinds = scan.shards.map(
		(shard) =>
			(
				shard as typeof shard & {
					sessionsByKindAtSteady?: {
						player: number;
						raid: number;
						publisher: number;
					} | null;
				}
			).sessionsByKindAtSteady,
	);
	if (
		kinds.some(
			(value) =>
				!value ||
				!nonnegative(value.player) ||
				!nonnegative(value.raid) ||
				!nonnegative(value.publisher),
		) ||
		kinds.reduce((sum, value) => sum + (value?.player ?? 0), 0) !== active ||
		kinds.reduce((sum, value) => sum + (value?.raid ?? 0), 0) !==
			requested - active ||
		kinds.reduce((sum, value) => sum + (value?.publisher ?? 0), 0) !== 0
	)
		reasons.push(
			"steady session-kind classification differs from companion cell",
		);
	if (!bpfPreArmClean(diagnostic?.bpfPreArm))
		reasons.push("BPF pre-arm is invalid");

	const lifecycle = lifecycleClean(diagnostic?.perShardLifecycle);
	const serverSamples = record(diagnostic?.serverHostUdp);
	const generatorSamples = record(report?.hostUdp);
	const hostDeltas = [serverSamples, generatorSamples].flatMap((samples) =>
		["InErrors", "RcvbufErrors", "SndbufErrors"].map((field) =>
			counterDelta(samples, "connect", "idle", field),
		),
	);
	if (hostDeltas.some((delta) => delta === null))
		reasons.push("host UDP evidence is incomplete");
	const hostClean =
		hostDeltas.length === 6 && hostDeltas.every((delta) => delta === 0);
	const steady = record(record(report?.windows)?.steady);
	const steadyDrain = record(record(report?.windows)?.steadyDrain);
	const sent = steady?.sent;
	const issued = scan.aggregate.steadyDrain.emitter.snapshotIssued;
	const rxSnapshot = steadyDrain?.rxSnapshot;
	const passiveJoinCount = scan.aggregate.lifetime?.rxByClass?.raidJoin;
	if (!finiteNonnegative(sent) || sent === 0)
		reasons.push("steady sent count is invalid");
	if (!finiteNonnegative(issued) || issued === 0)
		reasons.push("snapshot issued count is invalid");
	if (!finiteNonnegative(rxSnapshot))
		reasons.push("snapshot delivery count is invalid");
	if (!finiteNonnegative(passiveJoinCount))
		reasons.push("passive join count is invalid");
	const demand = active * SNAPSHOT_HZ * snapshotDatagrams() * 120;
	return {
		schema: "g6-c32-session-scale-evidence/1",
		label: input.label,
		complete: reasons.length === 0,
		reasons,
		requestedSessions: requested,
		activeWorkloadSessions: active,
		sessionsOk: nonnegative(report?.sessionsOk) ? report.sessionsOk : 0,
		sessionsErr: nonnegative(report?.sessionsErr) ? report.sessionsErr : 0,
		steadySessionsLost: nonnegative(steady?.sessionsLost)
			? steady.sessionsLost
			: 0,
		lifecycleClean: lifecycle,
		hostClean,
		passiveJoinCount: finiteNonnegative(passiveJoinCount)
			? passiveJoinCount
			: 0,
		ingestRatio:
			finiteNonnegative(sent) && sent > 0
				? scan.aggregate.steady.rxTotal / sent
				: 0,
		deliveryRatio:
			finiteNonnegative(issued) && issued > 0 && finiteNonnegative(rxSnapshot)
				? rxSnapshot / issued
				: 0,
		dutyRatio: demand > 0 && finiteNonnegative(issued) ? issued / demand : 0,
	};
}

function connectWallShiftPct(on: number, off: number): number {
	return (Math.abs(on - off) / off) * 100;
}

export function evaluateProbeNonInterference(
	runs: readonly CellLike[],
	maxShiftPct = 5,
	order: readonly string[] = ["P1-off", "P1-on", "P2-off", "P2-on"],
): {
	schema: "g6-c32-probe-non-interference/3";
	status: "PASS" | "INCOMPLETE" | "CONTAMINATING";
	reasons: string[];
	maxShiftPct: number;
	offOffShiftPct: number | null;
	allowedShiftPct: number | null;
	pairShiftsPct: [number, number] | null;
} {
	const labels = ["P1-off", "P1-on", "P2-off", "P2-on"];
	if (
		runs.length !== labels.length ||
		order.length !== labels.length ||
		new Set(order).size !== labels.length ||
		labels.some((label) => !order.includes(label)) ||
		order.some((label, index) => !validCell(runs[index] ?? {}, label))
	)
		return {
			schema: "g6-c32-probe-non-interference/3",
			status: "INCOMPLETE",
			reasons: ["probe comparison requires the exact four valid cells"],
			maxShiftPct,
			offOffShiftPct: null,
			allowedShiftPct: null,
			pairShiftsPct: null,
		};
	const checked = new Map(
		runs.map((run, index) => [order[index] as string, run as RcaCellDecision]),
	);
	const p1Off = checked.get("P1-off") as RcaCellDecision;
	const p1On = checked.get("P1-on") as RcaCellDecision;
	const p2Off = checked.get("P2-off") as RcaCellDecision;
	const p2On = checked.get("P2-on") as RcaCellDecision;
	const quieterOff = Math.min(p1Off.connectWallSec, p2Off.connectWallSec);
	const offOffShiftPct = connectWallShiftPct(
		Math.max(p1Off.connectWallSec, p2Off.connectWallSec),
		quieterOff,
	);
	const allowedShiftPct = maxShiftPct;
	const pairShiftsPct: [number, number] = [
		connectWallShiftPct(p1On.connectWallSec, p1Off.connectWallSec),
		connectWallShiftPct(p2On.connectWallSec, p2Off.connectWallSec),
	];
	const reasons: string[] = [];
	for (const [pairIndex, off, on, shift] of [
		[1, p1Off, p1On, pairShiftsPct[0]],
		[2, p2Off, p2On, pairShiftsPct[1]],
	] as const) {
		if (shift > allowedShiftPct)
			reasons.push(
				`probe pair ${pairIndex} connect wall shifted ${shift.toFixed(3)}% (maximum ${allowedShiftPct.toFixed(3)}%; off-off diagnostic ${offOffShiftPct.toFixed(3)}%)`,
			);
		if (off.connectOwnedSocketDrops > 0 !== on.connectOwnedSocketDrops > 0)
			reasons.push(`probe pair ${pairIndex} changed overflow classification`);
	}
	return {
		schema: "g6-c32-probe-non-interference/3",
		status: reasons.length === 0 ? "PASS" : "CONTAMINATING",
		reasons,
		maxShiftPct,
		offOffShiftPct,
		allowedShiftPct,
		pairShiftsPct,
	};
}

export function evaluateInteraction(
	runs: readonly CellLike[],
	factorPair: string,
	constituentMedians: readonly [number, number],
	baselineMedian: number,
): {
	schema: "g6-c32-rca-interaction/1";
	terminal: Terminal;
	factorPair: string;
	reduction: number;
	reasons: string[];
} {
	const labels = ["E1", "A5", "E2", "A6", "E3", "A7"];
	if (
		!/^([BCD])\+([BCD])$/.test(factorPair) ||
		runs.length !== labels.length ||
		labels.some((label, index) => !validCell(runs[index] ?? {}, label))
	)
		return {
			schema: "g6-c32-rca-interaction/1",
			terminal: "INCOMPLETE",
			factorPair,
			reduction: 0,
			reasons: ["interaction requires the exact valid E/A reversal sequence"],
		};
	const checked = runs as RcaCellDecision[];
	const eRuns = [checked[0], checked[2], checked[4]] as RcaCellDecision[];
	const reversals = [checked[1], checked[3], checked[5]] as RcaCellDecision[];
	const eMedian = median(eRuns.map((run) => run.connectOwnedSocketDrops));
	const value = reduction(baselineMedian, eMedian);
	const pass =
		reversals.every(
			(run) => run.connectOwnedSocketDrops > 0 && run.hostSocketDropEquality,
		) &&
		value >= 0.9 &&
		eRuns.every((run) =>
			constituentMedians.every(
				(constituentMedian) => run.connectOwnedSocketDrops < constituentMedian,
			),
		) &&
		eRuns.every((run) => run.functionalPass && run.rcaQualityPass) &&
		eRuns.every((run) => run.steadySent === reversals[0]?.steadySent);
	return {
		schema: "g6-c32-rca-interaction/1",
		terminal: pass ? "RCA_INTERACTION" : "RCA_UNRESOLVED",
		factorPair,
		reduction: value,
		reasons: pass
			? []
			: ["interaction did not meet effect, reversal, or quality criteria"],
	};
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: (sorted[middle] ?? 0);
}

function validCell(value: CellLike, label: string): value is RcaCellDecision {
	return (
		value.schema === "g6-c32-rca-cell/1" &&
		value.cell === label &&
		value.complete === true &&
		value.functionalPass === true &&
		value.rcaQualityPass === true &&
		finitePositive(value.connectWallSec) &&
		finiteNonnegative(value.connectOwnedSocketDrops) &&
		finiteNonnegative(value.connectServerRcvbufErrors) &&
		finiteNonnegative(value.generatorConnectErrors) &&
		finiteNonnegative(value.postConnectServerRcvbufErrors) &&
		finiteNonnegative(value.steadySent) &&
		typeof value.hostSocketDropEquality === "boolean"
	);
}

function reduction(baseline: number, intervention: number): number {
	if (baseline <= 0) return 0;
	return Math.max(0, Math.min(1, 1 - intervention / baseline));
}

export type MatrixDecision = {
	schema: "g6-c32-rca-matrix/1";
	terminal: Terminal;
	confirmedFactors: Factor[];
	reductions: Record<Factor, number>;
	runInteraction: boolean;
	factorPair: string | null;
	reasons: string[];
};

export function evaluateMatrix(runs: readonly CellLike[]): MatrixDecision {
	const labels = [
		"A1",
		"B1",
		"C1",
		"D1",
		"A2",
		"B2",
		"C2",
		"D2",
		"A3",
		"B3",
		"C3",
		"D3",
		"A4",
	];
	const reasons: string[] = [];
	if (
		runs.length !== labels.length ||
		labels.some((label, index) => !validCell(runs[index] ?? {}, label))
	) {
		reasons.push("matrix must contain the exact valid A/B/C/D interleaving");
		return {
			schema: "g6-c32-rca-matrix/1",
			terminal: "INCOMPLETE",
			confirmedFactors: [],
			reductions: { B: 0, C: 0, D: 0 },
			runInteraction: false,
			factorPair: null,
			reasons,
		};
	}
	const checked = Object.fromEntries(
		labels.map((label, index) => [label, runs[index] as RcaCellDecision]),
	) as Record<string, RcaCellDecision>;
	const aFirst = [checked.A1, checked.A2, checked.A3] as RcaCellDecision[];
	const aReversal = checked.A4 as RcaCellDecision;
	const baselineReproduced =
		aFirst.filter(
			(run) =>
				run.connectOwnedSocketDrops > 0 &&
				run.hostSocketDropEquality &&
				run.generatorConnectErrors === 0 &&
				run.postConnectServerRcvbufErrors === 0,
		).length >= 2 &&
		aReversal.connectOwnedSocketDrops > 0 &&
		aReversal.hostSocketDropEquality;
	if (!baselineReproduced) {
		return {
			schema: "g6-c32-rca-matrix/1",
			terminal: "RCA_UNRESOLVED",
			confirmedFactors: [],
			reductions: { B: 0, C: 0, D: 0 },
			runInteraction: false,
			factorPair: null,
			reasons: ["baseline overflow did not reproduce with final reversal"],
		};
	}
	const baselineMedian = median(
		aFirst.map((run) => run.connectOwnedSocketDrops),
	);
	const factorRuns = (factor: Factor): RcaCellDecision[] =>
		[1, 2, 3].map(
			(replicate) => checked[`${factor}${replicate}`] as RcaCellDecision,
		);
	const reductions = Object.fromEntries(
		(["B", "C", "D"] as const).map((factor) => [
			factor,
			reduction(
				baselineMedian,
				median(factorRuns(factor).map((run) => run.connectOwnedSocketDrops)),
			),
		]),
	) as Record<Factor, number>;
	const bRuns = factorRuns("B");
	const cRuns = factorRuns("C");
	const dRuns = factorRuns("D");
	const confirmedFactors: Factor[] = [];
	if (
		bRuns.every((run) => run.connectOwnedSocketDrops === 0) &&
		bRuns.every((run, index) =>
			finiteNonnegative(run.peakReceiveQueueBytes)
				? run.peakReceiveQueueBytes <
					((aFirst[index]?.peakReceiveQueueBytes as number | null) ??
						Number.POSITIVE_INFINITY)
				: false,
		) &&
		bRuns.every((run) => run.steadySent === aFirst[0]?.steadySent)
	)
		confirmedFactors.push("B");
	if (
		reductions.C >= 0.9 &&
		cRuns.every(
			(run, index) =>
				finiteNonnegative(run.maxFallbackSessionExcessPerShard) &&
				finiteNonnegative(aFirst[index]?.maxFallbackSessionExcessPerShard) &&
				(run.maxFallbackSessionExcessPerShard as number) <=
					(aFirst[index]?.maxFallbackSessionExcessPerShard as number) * 0.5,
		)
	)
		confirmedFactors.push("C");
	if (
		dRuns.every(
			(run) =>
				run.connectOwnedSocketDrops === 0 &&
				run.effectiveReceiveBufferBytes === 26_214_400 &&
				finiteNonnegative(run.peakReceiveQueueBytes) &&
				(run.peakReceiveQueueBytes as number) >
					Math.max(
						...aFirst.map((baseline) => baseline.peakReceiveQueueBytes ?? 0),
					),
		)
	)
		confirmedFactors.push("D");
	if (confirmedFactors.length > 0) {
		return {
			schema: "g6-c32-rca-matrix/1",
			terminal: "HIGH_LOAD_FACTOR_CONFIRMED",
			confirmedFactors,
			reductions,
			runInteraction: false,
			factorPair: null,
			reasons: [],
		};
	}
	const ordered = (["B", "C", "D"] as const).toSorted(
		(left, right) => reductions[right] - reductions[left],
	);
	return {
		schema: "g6-c32-rca-matrix/1",
		terminal: "RCA_UNRESOLVED",
		confirmedFactors: [],
		reductions,
		runInteraction: true,
		factorPair: `${ordered[0]}+${ordered[1]}`,
		reasons: ["no individual factor met its confirmation rule"],
	};
}

export function selectTransferWinner(
	factors: Record<Factor, { confirmed: boolean; reduction: number }>,
): {
	schema: "g6-c32-transfer-winner/1";
	factor: Factor | null;
	reduction: number;
	profile: {
		endpoints: number;
		connectConcurrency: number;
		connectRatePerSec: number;
		receiveBufferBytes: number;
		gradeMode: "historical" | "rca-only";
	} | null;
} {
	const winner = (["B", "C", "D"] as const)
		.filter((factor) => factors[factor].confirmed)
		.toSorted(
			(left, right) => factors[right].reduction - factors[left].reduction,
		)[0];
	return {
		schema: "g6-c32-transfer-winner/1",
		factor: winner ?? null,
		reduction: winner ? factors[winner].reduction : 0,
		profile:
			winner === "B"
				? {
						endpoints: 128,
						connectConcurrency: 50,
						connectRatePerSec: 250,
						receiveBufferBytes: 0,
						gradeMode: "historical",
					}
				: winner === "C"
					? {
							endpoints: 512,
							connectConcurrency: 500,
							connectRatePerSec: 0,
							receiveBufferBytes: 0,
							gradeMode: "rca-only",
						}
					: winner === "D"
						? {
								endpoints: 128,
								connectConcurrency: 500,
								connectRatePerSec: 0,
								receiveBufferBytes: 26_214_400,
								gradeMode: "historical",
							}
						: null,
	};
}

export function evaluateTransfer(runs: readonly CellLike[]): {
	schema: "g6-c32-rca-transfer/1";
	terminal: Terminal;
	transferPass: boolean;
	reduction: number;
	reasons: string[];
} {
	const labels = [
		"A296-1",
		"W296-1",
		"A296-2",
		"W296-2",
		"A296-3",
		"W296-3",
		"A296-reversal",
	];
	if (
		runs.length !== labels.length ||
		labels.some((label, index) => !validCell(runs[index] ?? {}, label))
	) {
		return {
			schema: "g6-c32-rca-transfer/1",
			terminal: "INCOMPLETE",
			transferPass: false,
			reduction: 0,
			reasons: [
				"transfer must contain the exact seven valid interleaved cells",
			],
		};
	}
	const checked = Object.fromEntries(
		labels.map((label, index) => [label, runs[index] as RcaCellDecision]),
	) as Record<string, RcaCellDecision>;
	const baselines = [
		checked["A296-1"],
		checked["A296-2"],
		checked["A296-3"],
	] as RcaCellDecision[];
	const reversal = checked["A296-reversal"] as RcaCellDecision;
	const winners = [
		checked["W296-1"],
		checked["W296-2"],
		checked["W296-3"],
	] as RcaCellDecision[];
	const overflowing = (run: RcaCellDecision): boolean =>
		run.connectOwnedSocketDrops > 0 &&
		run.connectServerRcvbufErrors === run.connectOwnedSocketDrops &&
		run.generatorConnectErrors === 0 &&
		run.postConnectServerRcvbufErrors === 0;
	const baselinePass =
		baselines.filter(overflowing).length >= 2 && overflowing(reversal);
	const value = reduction(
		median(
			baselines.filter(overflowing).map((run) => run.connectOwnedSocketDrops),
		),
		median(winners.map((run) => run.connectOwnedSocketDrops)),
	);
	const referenceSteadySent = (baselines[0] as RcaCellDecision).steadySent;
	const steadyOfferPass = [...baselines, reversal, ...winners].every(
		(run) => run.steadySent === referenceSteadySent,
	);
	const winnerPass =
		winners.every((run) => run.functionalPass && run.rcaQualityPass) &&
		steadyOfferPass &&
		(winners.every((run) => run.connectOwnedSocketDrops === 0) || value >= 0.9);
	const transferPass = baselinePass && winnerPass;
	return {
		schema: "g6-c32-rca-transfer/1",
		terminal: transferPass ? "RCA_CONFIRMED" : "RCA_UNRESOLVED",
		transferPass,
		reduction: value,
		reasons: transferPass
			? []
			: [
					...(baselinePass ? [] : ["moderate baseline did not reproduce"]),
					...(winnerPass
						? []
						: ["winner did not meet the transfer effect bar"]),
					...(steadyOfferPass
						? []
						: ["steady offered workload changed during transfer"]),
				],
	};
}

type SuccessorRungStatus = "CLEAN" | "UNCLEAN" | "INCOMPLETE";

type SuccessorRungDecision = {
	schema?: unknown;
	label?: unknown;
	rung?: unknown;
	status?: unknown;
};

export function evaluateSuccessorRung(input: {
	label: string;
	rung: number;
	rca: unknown;
	grade: unknown;
}): {
	schema: "g6-c32-successor-rung/1";
	label: string;
	rung: number;
	status: SuccessorRungStatus;
	reasons: string[];
	rca: unknown;
	grade: unknown;
} {
	const rca = record(input.rca);
	const grade = record(input.grade);
	const reasons: string[] = [];
	if (rca?.schema !== "g6-c32-rca-cell/1" || rca.complete !== true)
		reasons.push("RCA cell evidence is incomplete");
	if (grade?.schema !== "g6-c32-successor-grade/1" || grade.valid !== true)
		reasons.push("successor grade is invalid");
	const complete = reasons.length === 0;
	const clean =
		complete &&
		rca?.functionalPass === true &&
		rca.ingressCleanPass === true &&
		grade?.gate === "PASS";
	return {
		schema: "g6-c32-successor-rung/1",
		label: input.label,
		rung: input.rung,
		status: !complete ? "INCOMPLETE" : clean ? "CLEAN" : "UNCLEAN",
		reasons,
		rca: input.rca,
		grade: input.grade,
	};
}

export type SuccessorLadderDecision = {
	schema: "g6-c32-successor-ladder/1";
	status: "COMPLETE" | "INCOMPLETE";
	highestReplicatedCleanRung: number | null;
	firstUncleanRung: number | null;
	fullRateWorksAbove5k: boolean;
	companionRequired: boolean;
	reasons: string[];
};

function validSuccessorRung(
	value: SuccessorRungDecision,
	label: string,
	rung: number,
): value is SuccessorRungDecision & { status: SuccessorRungStatus } {
	return (
		value.schema === "g6-c32-successor-rung/1" &&
		value.label === label &&
		value.rung === rung &&
		["CLEAN", "UNCLEAN", "INCOMPLETE"].includes(String(value.status))
	);
}

export function evaluateSuccessorLadder(root: string): SuccessorLadderDecision {
	const rungs = [5_000, 10_000, 20_000, 30_000, 40_000, 50_000];
	const reasons: string[] = [];
	let firstUncleanRung: number | null = null;
	let stopIndex: number | null = null;
	const cleanRungs: number[] = [];

	const readRung = (
		label: string,
		rung: number,
	): (SuccessorRungDecision & { status: SuccessorRungStatus }) | null => {
		const path = join(root, label, "decision.json");
		if (!existsSync(path)) return null;
		try {
			const value = readJson(path) as SuccessorRungDecision;
			return validSuccessorRung(value, label, rung) ? value : null;
		} catch {
			return null;
		}
	};

	for (const [index, rung] of rungs.entries()) {
		const firstLabel = `L${rung}-1`;
		const firstPath = join(root, firstLabel, "decision.json");
		if (!existsSync(firstPath)) {
			reasons.push(`missing ${firstLabel}/decision.json`);
			stopIndex = index;
			break;
		}
		const first = readRung(firstLabel, rung);
		if (first === null) {
			reasons.push(`${firstLabel} decision is malformed`);
			stopIndex = index;
			break;
		}
		if (first.status === "INCOMPLETE") {
			reasons.push(`${firstLabel} is incomplete`);
			stopIndex = index;
			break;
		}
		if (first.status === "UNCLEAN") {
			firstUncleanRung = rung;
			stopIndex = index;
			break;
		}
		cleanRungs.push(rung);
	}

	if (stopIndex !== null) {
		for (const rung of rungs.slice(stopIndex + 1)) {
			if (existsSync(join(root, `L${rung}-1`, "decision.json")))
				reasons.push(`later rung L${rung}-1 exists after stop`);
		}
	}

	const highestCleanRung = cleanRungs.at(-1) ?? null;
	let highestReplicatedCleanRung: number | null = null;
	if (highestCleanRung === null) {
		reasons.push("no clean rung exists to replicate");
	}

	for (const rung of rungs) {
		const secondLabel = `L${rung}-2`;
		const secondPath = join(root, secondLabel, "decision.json");
		if (rung !== highestCleanRung) {
			if (existsSync(secondPath))
				reasons.push(
					`${secondLabel} exists but is not the highest clean replicate`,
				);
			continue;
		}
		if (!existsSync(secondPath)) {
			reasons.push(
				`missing highest-clean replicate ${secondLabel}/decision.json`,
			);
			continue;
		}
		const second = readRung(secondLabel, rung);
		if (second === null) {
			reasons.push(`${secondLabel} decision is malformed`);
		} else if (second.status !== "CLEAN") {
			reasons.push(`${secondLabel} is ${second.status.toLowerCase()}`);
		} else {
			highestReplicatedCleanRung = rung;
		}
	}
	const status = reasons.length === 0 ? "COMPLETE" : "INCOMPLETE";
	return {
		schema: "g6-c32-successor-ladder/1",
		status,
		highestReplicatedCleanRung,
		firstUncleanRung,
		fullRateWorksAbove5k:
			status === "COMPLETE" &&
			highestReplicatedCleanRung !== null &&
			highestReplicatedCleanRung > 5_000,
		companionRequired:
			status === "COMPLETE" &&
			firstUncleanRung !== null &&
			highestReplicatedCleanRung !== null,
		reasons,
	};
}

export type SessionScaleDecision = {
	schema: "g6-c32-session-scale/1";
	status: "SESSION_SCALE_PASS" | "SESSION_SCALE_MISS" | "INCOMPLETE";
	replicates: Array<{ label: string; pass: boolean; reasons: string[] }>;
	reasons: string[];
};

function evaluateSessionScaleEvidence(
	value: unknown,
	label: string,
): { label: string; complete: boolean; pass: boolean; reasons: string[] } {
	const evidence = record(value);
	const reasons: string[] = [];
	if (evidence?.schema !== "g6-c32-session-scale-evidence/1")
		reasons.push("schema is not g6-c32-session-scale-evidence/1");
	if (evidence?.label !== label) reasons.push(`label is not ${label}`);
	if (evidence?.complete !== true || !Array.isArray(evidence?.reasons))
		reasons.push("cell evidence is not complete");
	const requested = evidence?.requestedSessions;
	const active = evidence?.activeWorkloadSessions;
	if (
		!nonnegative(requested) ||
		requested === 0 ||
		!nonnegative(active) ||
		active === 0 ||
		active >= requested
	)
		reasons.push("requested and active session counts are invalid");
	for (const [name, metric] of [
		["ingestRatio", evidence?.ingestRatio],
		["deliveryRatio", evidence?.deliveryRatio],
		["dutyRatio", evidence?.dutyRatio],
	] as const) {
		if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)
			reasons.push(`${name} is invalid`);
	}
	const complete = reasons.length === 0;
	const pass =
		complete &&
		evidence?.sessionsOk === requested &&
		evidence?.sessionsErr === 0 &&
		evidence?.steadySessionsLost === 0 &&
		evidence?.lifecycleClean === true &&
		evidence?.hostClean === true &&
		evidence?.passiveJoinCount === (requested as number) - (active as number) &&
		(evidence?.ingestRatio as number) >= 0.995 &&
		(evidence?.deliveryRatio as number) >= 0.995 &&
		(evidence?.dutyRatio as number) >= 0.995;
	return { label, complete, pass, reasons };
}

export function evaluateSessionScale(root: string): SessionScaleDecision {
	const replicates = ["C1", "C2"].map((label) => {
		const path = join(root, label, "summary.json");
		return existsSync(path)
			? evaluateSessionScaleEvidence(readJson(path), label)
			: {
					label,
					complete: false,
					pass: false,
					reasons: [`missing ${label}/summary.json`],
				};
	});
	const incomplete = replicates.some((replicate) => !replicate.complete);
	return {
		schema: "g6-c32-session-scale/1",
		status: incomplete
			? "INCOMPLETE"
			: replicates.every((replicate) => replicate.pass)
				? "SESSION_SCALE_PASS"
				: "SESSION_SCALE_MISS",
		replicates: replicates.map(({ label, pass, reasons }) => ({
			label,
			pass,
			reasons,
		})),
		reasons: replicates.flatMap((replicate) => replicate.reasons),
	};
}

function compareFrozenIdentity(
	expected: unknown,
	observed: unknown,
	path = "",
): string[] {
	const expectedRecord = record(expected);
	if (expectedRecord) {
		const observedRecord = record(observed);
		if (!observedRecord) return [`${path || "identity"} is not an object`];
		return Object.entries(expectedRecord).flatMap(([key, value]) =>
			compareFrozenIdentity(
				value,
				observedRecord[key],
				path ? `${path}.${key}` : key,
			),
		);
	}
	if (Array.isArray(expected)) {
		return JSON.stringify(expected) === JSON.stringify(observed)
			? []
			: [`${path} differs from frozen identity`];
	}
	return Object.is(expected, observed)
		? []
		: [`${path} differs from frozen identity`];
}

function arg(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined) throw new Error(`--${name} is required`);
	return value;
}

function optionalArg(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

export function parseNonnegativeDecimal(raw: string, name: string): number {
	if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw))
		throw new Error(`--${name} must be a finite nonnegative decimal`);
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0)
		throw new Error(`--${name} must be a finite nonnegative decimal`);
	return value;
}

function parseIntegerArg(
	name: string,
	options: { zero?: boolean } = {},
): number {
	const raw = arg(name);
	if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be an integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || (!options.zero && value === 0))
		throw new Error(`--${name} is out of range`);
	return value;
}

function parseFixedPortArg(name: string, endpoints: number): number | null {
	const raw = arg(name);
	if (raw === "none") return null;
	if (!/^\d+$/.test(raw))
		throw new Error(`--${name} must be none or an integer`);
	const value = Number(raw);
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > 65_535 ||
		value + endpoints - 1 > 65_535
	)
		throw new Error(`--${name} range is invalid`);
	return value;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function readProbe(path: string): unknown {
	const text = readFileSync(path, "utf8").trim();
	try {
		return JSON.parse(text);
	} catch {
		for (const line of text.split(/\r?\n/).toReversed()) {
			try {
				const value = JSON.parse(line);
				if (record(value)?.schema === "g6-c32-linux-probe/1") return value;
			} catch {
				// Continue to an earlier JSONL record.
			}
		}
		throw new Error(`probe ${path} has no g6-c32-linux-probe/1 summary`);
	}
}

function readCells(root: string, labels: readonly string[]): CellLike[] {
	return labels.map(
		(label) => readJson(join(root, label, "rca.json")) as CellLike,
	);
}

function writeDecision(value: unknown): void {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	writeFileSync(arg("out"), text);
	console.log(text.trim());
}

if (import.meta.main) {
	const mode = arg("mode");
	if (mode === "cell") {
		const gradeMode = arg("grade-mode");
		if (gradeMode !== "historical" && gradeMode !== "rca-only")
			throw new Error("--grade-mode must be historical or rca-only");
		const endpoints = parseIntegerArg("expected-endpoints");
		const fixedSourcePortBase = parseFixedPortArg(
			"expected-fixed-source-port-base",
			endpoints,
		);
		const probePath = arg("probe");
		const cell = arg("cell");
		const decision = evaluateCell({
			cell,
			gradeMode,
			qualityRequest: {
				rung: parseIntegerArg("expected-sessions"),
				scan: readJson(arg("scan")) as RungScan,
				postRunSteeringText: readFileSync(arg("post-run-steering"), "utf8"),
				expectCandidate: arg("expect-candidate"),
				registrationSha256: arg("registration-sha256"),
				expectedEndpoints: endpoints,
				expectedConnectConcurrency: parseIntegerArg(
					"expected-connect-concurrency",
				),
				expectedConnectRate: parseIntegerArg("expected-connect-rate", {
					zero: true,
				}),
				expectedFixedSourcePortBase: fixedSourcePortBase,
			},
			diagnostic: readJson(arg("diagnostic")),
			probe: existsSync(probePath) ? readProbe(probePath) : null,
			probeRequired: !cell.endsWith("-off"),
		});
		writeDecision(decision);
		process.exitCode = decision.complete ? 0 : 2;
	} else if (mode === "probe-non-interference") {
		const maxShiftPct = parseNonnegativeDecimal(
			arg("max-connect-wall-shift-pct"),
			"max-connect-wall-shift-pct",
		);
		const order = arg("order").split(",");
		const root = arg("root");
		const decision = evaluateProbeNonInterference(
			readCells(root, order),
			maxShiftPct,
			order,
		);
		writeDecision(decision);
		process.exitCode = decision.status === "PASS" ? 0 : 2;
	} else if (mode === "matrix") {
		writeDecision(
			evaluateMatrix(
				readCells(arg("root"), [
					"A1",
					"B1",
					"C1",
					"D1",
					"A2",
					"B2",
					"C2",
					"D2",
					"A3",
					"B3",
					"C3",
					"D3",
					"A4",
				]),
			),
		);
	} else if (mode === "interaction") {
		const root = arg("root");
		const factorPair = arg("factor-pair");
		const initial = readCells(root, [
			"A1",
			"B1",
			"C1",
			"D1",
			"A2",
			"B2",
			"C2",
			"D2",
			"A3",
			"B3",
			"C3",
			"D3",
			"A4",
		]) as RcaCellDecision[];
		const byLabel = Object.fromEntries(
			initial.map((cell) => [cell.cell, cell]),
		);
		const baselineMedian = median(
			["A1", "A2", "A3"].map(
				(label) => byLabel[label]?.connectOwnedSocketDrops ?? 0,
			),
		);
		const factors = factorPair.split("+") as Factor[];
		const constituentMedians = factors.map((factor) =>
			median(
				[1, 2, 3].map(
					(replicate) =>
						byLabel[`${factor}${replicate}`]?.connectOwnedSocketDrops ?? 0,
				),
			),
		) as [number, number];
		const decision = evaluateInteraction(
			readCells(root, ["E1", "A5", "E2", "A6", "E3", "A7"]),
			factorPair,
			constituentMedians,
			baselineMedian,
		);
		writeDecision(decision);
		process.exitCode = decision.terminal === "INCOMPLETE" ? 2 : 0;
	} else if (mode === "select-transfer") {
		const matrix = readJson(
			join(arg("root"), "decision.json"),
		) as MatrixDecision;
		const factors = Object.fromEntries(
			(["B", "C", "D"] as const).map((factor) => [
				factor,
				{
					confirmed: matrix.confirmedFactors.includes(factor),
					reduction: matrix.reductions[factor],
				},
			]),
		) as Record<Factor, { confirmed: boolean; reduction: number }>;
		const individual = selectTransferWinner(factors);
		if (individual.factor !== null) {
			writeDecision(individual);
		} else {
			const interactionPath = join(arg("root"), "interaction-decision.json");
			if (!existsSync(interactionPath))
				throw new Error(
					"no confirmed individual factor or interaction decision",
				);
			const interaction = readJson(interactionPath) as ReturnType<
				typeof evaluateInteraction
			>;
			if (interaction.terminal !== "RCA_INTERACTION")
				throw new Error("interaction is not confirmed");
			const profile =
				interaction.factorPair === "B+C"
					? {
							endpoints: 512,
							connectConcurrency: 50,
							connectRatePerSec: 250,
							receiveBufferBytes: 0,
							gradeMode: "rca-only",
						}
					: interaction.factorPair === "B+D"
						? {
								endpoints: 128,
								connectConcurrency: 50,
								connectRatePerSec: 250,
								receiveBufferBytes: 26_214_400,
								gradeMode: "historical",
							}
						: interaction.factorPair === "C+D"
							? {
									endpoints: 512,
									connectConcurrency: 500,
									connectRatePerSec: 0,
									receiveBufferBytes: 26_214_400,
									gradeMode: "rca-only",
								}
							: null;
			if (!profile) throw new Error("unsupported interaction factor pair");
			writeDecision({
				schema: "g6-c32-transfer-winner/1",
				factor: interaction.factorPair,
				reduction: interaction.reduction,
				profile,
			});
		}
	} else if (mode === "transfer") {
		const decision = evaluateTransfer(
			readCells(arg("root"), [
				"A296-1",
				"W296-1",
				"A296-2",
				"W296-2",
				"A296-3",
				"W296-3",
				"A296-reversal",
			]),
		);
		writeDecision(decision);
		process.exitCode = decision.transferPass ? 0 : 3;
	} else if (mode === "run-winner") {
		const winner = readJson(arg("winner"));
		writeDecision({
			schema: "g6-c32-run-winner-request/1",
			label: arg("label"),
			winner,
			root: arg("root"),
		});
	} else if (mode === "ladder") {
		const decision = evaluateSuccessorLadder(arg("root"));
		writeDecision(decision);
		process.exitCode = decision.status === "COMPLETE" ? 0 : 2;
	} else if (mode === "successor-rung") {
		const decision = evaluateSuccessorRung({
			label: arg("label"),
			rung: parseIntegerArg("rung"),
			rca: readJson(arg("rca")),
			grade: readJson(arg("grade")),
		});
		writeDecision(decision);
		process.exitCode = decision.status === "INCOMPLETE" ? 2 : 0;
	} else if (mode === "companion") {
		const decision = evaluateSessionScale(arg("root"));
		writeDecision(decision);
		process.exitCode = decision.status === "INCOMPLETE" ? 2 : 0;
	} else if (mode === "companion-cell") {
		const decision = evaluateSessionScaleCell({
			label: arg("label"),
			scan: readJson(arg("scan")) as RungScan,
			diagnostic: readJson(arg("diagnostic")),
			expectCandidate: arg("expect-candidate"),
			expectedRequestedSessions: parseIntegerArg("expected-sessions"),
			expectedActiveWorkloadSessions: parseIntegerArg(
				"expected-active-sessions",
			),
		});
		writeDecision(decision);
		process.exitCode = decision.complete ? 0 : 2;
	} else if (mode === "preflight") {
		const root = arg("root");
		const required = [
			"doctl-server",
			"doctl-generator",
			"server-head",
			"generator-head",
			"server-linux-probe",
			"generator-linux-probe",
			"private-path-sink-bpf",
			"copy-server",
			"copy-generator",
		];
		const reasons = required.flatMap((name) => {
			const path = join(root, `${name}.status`);
			if (!existsSync(path)) return [`missing ${name}.status`];
			return readFileSync(path, "utf8").trim() === "0"
				? []
				: [`${name}.status is not zero`];
		});
		if (!/^[0-9a-f]{64}$/.test(arg("registration-sha256")))
			reasons.push("registration SHA-256 is malformed");
		const identity = record(readJson(arg("identity")));
		if (identity?.schema !== "g6-c32-frozen-preflight/1") {
			reasons.push("identity schema is not g6-c32-frozen-preflight/1");
		} else {
			reasons.push(
				...compareFrozenIdentity(identity.expected, identity.observed),
			);
			const qualification = record(identity.qualification);
			for (const gate of [
				"privatePathPass",
				"sinkPass",
				"loadedLegPass",
				"bpfPass",
			] as const) {
				if (qualification?.[gate] !== true)
					reasons.push(`qualification.${gate} is not true`);
			}
		}
		const decision = {
			schema: "g6-c32-rca-preflight/1",
			status: reasons.length === 0 ? "PASS" : "INCOMPLETE",
			reasons,
		};
		writeDecision(decision);
		process.exitCode = reasons.length === 0 ? 0 : 2;
	} else if (mode === "finalize") {
		const root = arg("run-root");
		const lifecycle = arg("lifecycle");
		if (
			lifecycle !== "rca-only" &&
			lifecycle !== "post-fix-only" &&
			lifecycle !== "ladder-only"
		) {
			throw new Error(`unsupported lifecycle ${lifecycle}`);
		}
		const transfer =
			lifecycle === "ladder-only"
				? null
				: (readJson(join(root, "transfer", "decision.json")) as ReturnType<
						typeof evaluateTransfer
					>);
		const interactionPath = join(root, "matrix", "interaction-decision.json");
		const interaction = existsSync(interactionPath)
			? (readJson(interactionPath) as ReturnType<typeof evaluateInteraction>)
			: null;
		const ladderPath = join(root, "ladder", "decision.json");
		const ladder = existsSync(ladderPath)
			? (readJson(ladderPath) as SuccessorLadderDecision)
			: null;
		const companionPath = join(root, "companion", "decision.json");
		const companion = existsSync(companionPath)
			? (readJson(companionPath) as SessionScaleDecision)
			: null;
		const ladderComplete =
			ladder?.schema === "g6-c32-successor-ladder/1" &&
			ladder.status === "COMPLETE";
		const companionComplete =
			ladderComplete &&
			(!ladder.companionRequired ||
				(companion?.schema === "g6-c32-session-scale/1" &&
					companion.status !== "INCOMPLETE"));
		const transferConfirmed =
			transfer !== null &&
			transfer.schema === "g6-c32-rca-transfer/1" &&
			transfer.terminal === "RCA_CONFIRMED" &&
			transfer.transferPass === true;
		const transferUnresolved =
			transfer !== null &&
			transfer.schema === "g6-c32-rca-transfer/1" &&
			transfer.terminal === "RCA_UNRESOLVED" &&
			transfer.transferPass === false;
		const transferIncomplete =
			transfer !== null &&
			transfer.schema === "g6-c32-rca-transfer/1" &&
			transfer.terminal === "INCOMPLETE" &&
			transfer.transferPass === false;
		const transferShapeValid =
			transferConfirmed || transferUnresolved || transferIncomplete;
		const causalTerminal: Terminal =
			!transferShapeValid || transferIncomplete
				? "INCOMPLETE"
				: transferConfirmed
					? interaction?.terminal === "RCA_INTERACTION"
						? "RCA_INTERACTION"
						: "RCA_CONFIRMED"
					: "RCA_UNRESOLVED";
		const terminal: Terminal =
			lifecycle === "ladder-only"
				? ladderComplete && companionComplete
					? "LADDER_COMPLETE"
					: "INCOMPLETE"
				: lifecycle !== "rca-only" &&
						transfer?.transferPass === true &&
						(!ladderComplete || !companionComplete)
					? "INCOMPLETE"
					: causalTerminal;
		const decision = {
			schema: "g6-c32-rca-final/1",
			registrationSha256: arg("registration-sha256"),
			lifecycle,
			terminal,
			transfer,
			interaction,
			ladder,
			companion,
			fullRateWorksAbove5k:
				ladderComplete && ladder.fullRateWorksAbove5k === true,
			sessionScalePass:
				companion?.schema === "g6-c32-session-scale/1" &&
				companion.status === "SESSION_SCALE_PASS",
		};
		writeDecision(decision);
		writeFileSync(arg("status-out"), `${terminal}\n`);
		process.exitCode = terminal === "INCOMPLETE" ? 2 : 0;
	} else {
		throw new Error(`unsupported --mode ${mode}`);
	}
	void optionalArg;
}
