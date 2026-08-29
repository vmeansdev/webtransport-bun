/** Orthogonal RCA evaluator for the registered c-32 G6 campaign. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	| "RCA_UNRESOLVED";

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

export function evaluateProbeNonInterference(
	runs: readonly CellLike[],
	maxShiftPct = 5,
): {
	schema: "g6-c32-probe-non-interference/1";
	status: "PASS" | "INCOMPLETE" | "CONTAMINATING";
	reasons: string[];
} {
	const labels = ["P1-off", "P1-on", "P2-off", "P2-on"];
	if (
		runs.length !== labels.length ||
		labels.some((label, index) => !validCell(runs[index] ?? {}, label))
	)
		return {
			schema: "g6-c32-probe-non-interference/1",
			status: "INCOMPLETE",
			reasons: ["probe comparison requires the exact four valid cells"],
		};
	const checked = runs as RcaCellDecision[];
	const reasons: string[] = [];
	for (const [offIndex, onIndex] of [
		[0, 1],
		[2, 3],
	] as const) {
		const off = checked[offIndex] as RcaCellDecision;
		const on = checked[onIndex] as RcaCellDecision;
		const shift =
			off.connectWallSec === 0
				? Number.POSITIVE_INFINITY
				: (Math.abs(on.connectWallSec - off.connectWallSec) /
						off.connectWallSec) *
					100;
		if (shift > maxShiftPct)
			reasons.push(
				`probe pair ${offIndex / 2 + 1} connect wall shifted ${shift.toFixed(3)}%`,
			);
		if (off.connectOwnedSocketDrops > 0 !== on.connectOwnedSocketDrops > 0)
			reasons.push(
				`probe pair ${offIndex / 2 + 1} changed overflow classification`,
			);
	}
	return {
		schema: "g6-c32-probe-non-interference/1",
		status: reasons.length === 0 ? "PASS" : "CONTAMINATING",
		reasons,
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
		finiteNonnegative(value.connectWallSec) &&
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
	const winnerPass =
		winners.every((run) => run.functionalPass && run.rcaQualityPass) &&
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
				],
	};
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
		writeDecision(
			evaluateTransfer(
				readCells(arg("root"), [
					"A296-1",
					"W296-1",
					"A296-2",
					"W296-2",
					"A296-3",
					"W296-3",
					"A296-reversal",
				]),
			),
		);
	} else if (mode === "run-winner") {
		const winner = readJson(arg("winner"));
		writeDecision({
			schema: "g6-c32-run-winner-request/1",
			label: arg("label"),
			winner,
			root: arg("root"),
		});
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
		const decision = {
			schema: "g6-c32-rca-preflight/1",
			status: reasons.length === 0 ? "PASS" : "INCOMPLETE",
			reasons,
		};
		writeDecision(decision);
		process.exitCode = reasons.length === 0 ? 0 : 2;
	} else if (mode === "finalize") {
		const root = arg("run-root");
		const transfer = readJson(
			join(root, "transfer", "decision.json"),
		) as ReturnType<typeof evaluateTransfer>;
		const interactionPath = join(root, "matrix", "interaction-decision.json");
		const interaction = existsSync(interactionPath)
			? (readJson(interactionPath) as ReturnType<typeof evaluateInteraction>)
			: null;
		const terminal: Terminal =
			transfer.terminal === "RCA_CONFIRMED"
				? interaction?.terminal === "RCA_INTERACTION"
					? "RCA_INTERACTION"
					: "RCA_CONFIRMED"
				: transfer.terminal === "INCOMPLETE"
					? "INCOMPLETE"
					: "RCA_UNRESOLVED";
		const decision = {
			schema: "g6-c32-rca-final/1",
			registrationSha256: arg("registration-sha256"),
			terminal,
			transfer,
			interaction,
		};
		writeDecision(decision);
		writeFileSync(arg("status-out"), `${terminal}\n`);
		process.exitCode = terminal === "INCOMPLETE" ? 2 : 0;
	} else {
		throw new Error(`unsupported --mode ${mode}`);
	}
	void optionalArg;
}
