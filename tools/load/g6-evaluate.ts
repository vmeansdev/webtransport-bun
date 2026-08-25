#!/usr/bin/env bun

import { resolve } from "node:path";
import {
	floorReportIsUsable,
	parseGeneratorReport,
} from "../offbox/generator-report.ts";
import { canonicalGeneratorIdentity } from "../offbox/host-identity.ts";
import {
	evaluatePreflight,
	type PreflightArtifact,
	type PreflightVerdict,
} from "../offbox/preflight-lib.ts";
import {
	HOTSPOT_PHASE_BARRIER_PARTIES,
	HOTSPOT_PHASE_BARRIER_ROLES,
	HOTSPOT_PHASE_BARRIER_STEADY_SKEW_MS,
} from "./g6-artifact.ts";
import {
	type ClauseResult,
	clauseH1,
	clauseH2,
	clauseH3,
	clauseSC1,
	clauseSC2,
	type FalsifierResult,
	falsifierCablePreflight,
	falsifierFloor,
	falsifierGenerator,
	falsifierHistograms,
	falsifierIngestReality,
	falsifierLittle,
	falsifierSink,
	type HistogramFacts,
	type HotspotFacts,
	histogramValidity,
	rollUp,
	type SteadyArmFacts,
	type StormFacts,
	steadyArmClauses,
} from "./g6-classify.ts";
import {
	armShape,
	G6_CLOSEOUT_SPEC_ID,
	G6_CLOSEOUT_SPEC_PATH,
	gateRung,
	MOVE_HZ,
	preflightRequirements,
	RAID_MEMBERS,
	RAID_PUBLISHER_HZ,
	REALM_LADDER,
} from "./g6-plan.ts";
import {
	originatorSaturated,
	SINK_PRECHECK_PAYLOAD_BYTES,
	SINK_PRECHECK_SATURATION_BOUNDARY_PPS,
	SINK_PRECHECK_TARGET_BPS,
	SINK_PRECHECK_TARGET_PPS,
	sinkPrecheckRequirement,
} from "./g6-sink-precheck.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";

type JsonObject = Record<string, unknown>;

export type G6EvaluationRequest = {
	artifact: unknown;
	artifactCsvPresent: boolean;
	preflightDown: unknown;
	preflightUp: unknown;
	floorTranscript: string;
	sink: unknown;
	expectedCandidate: string;
	expectedGeneratorHost: string;
	expectedPreregistrationSha256: string;
	trackedPreregistrationSha256: string;
	graderSha: string;
	inputSha256: {
		artifactJson: string;
		artifactCsv: string;
		preflightDown: string;
		preflightUp: string;
		floor: string;
		sink: string;
	};
};

export type G6ClassifiedV2 = {
	schema: "g6-classified/2";
	preRegistration: { id: string; path: string; sha256: string };
	inputSha256: G6EvaluationRequest["inputSha256"];
	source: {
		candidateSha: string;
		graderSha: string;
		generatorHost: string;
	};
	normalizedFacts: Record<string, unknown>;
	publication: {
		steadyRungs: Record<string, unknown>[];
		hotspot: Record<string, unknown> | null;
		storms: Record<string, unknown>[];
	};
	clauses: ClauseResult[];
	falsifiers: FalsifierResult[];
	invalidReasons: string[];
	characterizationOnlyReasons: string[];
	final: { valid: boolean; gate: "PASS" | "MISS" | "INCOMPLETE" | "INVALID" };
};

const EXPECTED_ARMS = [
	"steady-500",
	"steady-2500",
	"steady-5000",
	"hotspot-5000",
	"storm-1000",
	"storm-5000",
] as const;
const G6_STEADY_SECONDS = 120;
const G6_DRAIN_MS = 1_000;
const G6_STORM_WINDOW_SECONDS = 120;
const G6_FLOOR_SESSIONS = 20;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(
	value: unknown,
	path: string,
	reasons: string[],
): JsonObject {
	if (!isObject(value)) {
		reasons.push(`V-A ${path}: expected object`);
		return {};
	}
	return value;
}

function objectAt(
	parent: JsonObject,
	key: string,
	path: string,
	reasons: string[],
): JsonObject {
	return objectValue(parent[key], `${path}.${key}`, reasons);
}

function arrayAt(
	parent: JsonObject,
	key: string,
	path: string,
	reasons: string[],
): unknown[] {
	const value = parent[key];
	if (!Array.isArray(value)) {
		reasons.push(`V-A ${path}.${key}: expected array`);
		return [];
	}
	return value;
}

function numberAt(
	parent: JsonObject,
	key: string,
	path: string,
	reasons: string[],
	options: { integer?: boolean; min?: number; max?: number } = {},
): number {
	const value = parent[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		reasons.push(`V-A ${path}.${key}: expected finite number`);
		return 0;
	}
	if (options.integer && !Number.isInteger(value)) {
		reasons.push(`V-A ${path}.${key}: expected integer, got ${value}`);
	}
	if (options.min !== undefined && value < options.min) {
		reasons.push(`V-A ${path}.${key}: ${value} is below ${options.min}`);
	}
	if (options.max !== undefined && value > options.max) {
		reasons.push(`V-A ${path}.${key}: ${value} exceeds ${options.max}`);
	}
	return value;
}

function nullableNumberAt(
	parent: JsonObject,
	key: string,
	path: string,
	reasons: string[],
	options: { integer?: boolean; min?: number } = {},
): number | null {
	if (parent[key] === null) return null;
	if (!(key in parent)) {
		reasons.push(`V-A ${path}.${key}: missing nullable number`);
		return null;
	}
	return numberAt(parent, key, path, reasons, options);
}

function stringAt(
	parent: JsonObject,
	key: string,
	path: string,
	reasons: string[],
): string {
	const value = parent[key];
	if (typeof value !== "string" || value.length === 0) {
		reasons.push(`V-A ${path}.${key}: expected nonempty string`);
		return "";
	}
	return value;
}

function requiredValue<T>(value: T | null | undefined, description: string): T {
	if (value === null || value === undefined) {
		throw new Error(`g6-evaluate internal invariant: missing ${description}`);
	}
	return value;
}

function requireExact(
	actual: unknown,
	expected: unknown,
	path: string,
	reasons: string[],
): void {
	if (actual !== expected) {
		reasons.push(
			`V-A ${path}: got ${String(actual)}, expected ${String(expected)}`,
		);
	}
}

function nearlyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function isoDay(value: string): string | null {
	if (!value || !Number.isFinite(Date.parse(value))) return null;
	return value.slice(0, 10);
}

function validatePreregistration(
	value: unknown,
	path: string,
	expectedSha: string,
	reasons: string[],
): void {
	const prereg = objectValue(value, path, reasons);
	requireExact(prereg.id, G6_CLOSEOUT_SPEC_ID, `${path}.id`, reasons);
	requireExact(prereg.path, G6_CLOSEOUT_SPEC_PATH, `${path}.path`, reasons);
	requireExact(prereg.sha256, expectedSha, `${path}.sha256`, reasons);
}

function scopedClause(scope: string, clause: ClauseResult): ClauseResult {
	return { ...clause, id: `${scope}/${clause.id}` };
}

function parseHistogram(
	value: unknown,
	name: string,
	expectedSamples: number | null,
	unstamped: number,
	reasons: string[],
	allHistograms: HistogramFacts[],
): HistogramFacts & { p50Ns: number | null; maxNs: number | null } {
	const path = `histogram ${name}`;
	const root = objectValue(value, path, reasons);
	requireExact(root.version, 2, `${path}.version`, reasons);
	const subBits = numberAt(root, "subBits", path, reasons, {
		integer: true,
		min: 0,
	});
	const maxOctave = numberAt(root, "maxOctave", path, reasons, {
		integer: true,
		min: 0,
	});
	const declaredCount = numberAt(root, "count", path, reasons, {
		integer: true,
		min: 0,
	});
	const recordedTotal = numberAt(root, "recordedTotal", path, reasons, {
		integer: true,
		min: 0,
	});
	const negative = numberAt(root, "negative", path, reasons, {
		integer: true,
		min: 0,
	});
	const minNs = numberAt(root, "minNs", path, reasons, { min: 0 });
	const maxNs = numberAt(root, "maxNs", path, reasons, { min: 0 });
	const sumNs = numberAt(root, "sumNs", path, reasons, { min: 0 });
	const rawBuckets = arrayAt(root, "buckets", path, reasons);
	const buckets: [number, number][] = [];
	let previousIndex = -1;
	for (let i = 0; i < rawBuckets.length; i += 1) {
		const entry = rawBuckets[i];
		if (!Array.isArray(entry) || entry.length !== 2) {
			reasons.push(`V-A ${path}.buckets[${i}]: expected [index,count]`);
			continue;
		}
		const [index, count] = entry;
		if (
			typeof index !== "number" ||
			!Number.isInteger(index) ||
			index < 0 ||
			typeof count !== "number" ||
			!Number.isInteger(count) ||
			count <= 0
		) {
			reasons.push(
				`V-A ${path}.buckets[${i}]: index must be a nonnegative integer and count a positive integer`,
			);
			continue;
		}
		if (index <= previousIndex) {
			reasons.push(
				`V-A ${path}.buckets[${i}]: bucket indexes must be unique and ascending`,
			);
		}
		previousIndex = index;
		buckets.push([index, count]);
	}
	const rawCount = buckets.reduce((sum, [, count]) => sum + count, 0);
	let p50Ns: number | null = null;
	let p99Ns: number | null = null;
	try {
		const histogram = LatencyHistogram.fromJson({
			version: 2,
			subBits,
			maxOctave,
			buckets,
			count: declaredCount,
			recordedTotal,
			negative,
			minNs,
			maxNs,
			sumNs,
		} as LatencyHistogramJson);
		if (rawCount > 0) {
			p50Ns = histogram.percentile(0.5);
			p99Ns = histogram.percentile(0.99);
		}
	} catch (error) {
		reasons.push(`V-A ${path}: ${String(error)}`);
	}
	const facts: HistogramFacts & {
		p50Ns: number | null;
		maxNs: number | null;
	} = {
		name,
		count: rawCount,
		declaredCount,
		recordedTotal,
		negative,
		p99Ns,
		expectedSamples,
		unstamped,
		p50Ns,
		maxNs: rawCount > 0 ? maxNs : null,
	};
	allHistograms.push(facts);
	return facts;
}

type ParsedClientWindow = {
	sent: number;
	sendErr: number;
	due: number;
	fired: number;
	skipped: number;
	rxSnapshot: number;
	rxAck: number;
	rxRaid: number;
	rxOther: number;
	rxUnstamped: number;
	ackUnreflected: number;
	sessionsLost: number;
	scheduleLag: ReturnType<typeof parseHistogram> | null;
	rtt: ReturnType<typeof parseHistogram> | null;
	oneWay: ReturnType<typeof parseHistogram> | null;
};

function parseClientWindow(
	report: JsonObject,
	windowName: string,
	scope: string,
	options: {
		schedule: boolean;
		rtt: boolean;
		oneWay: boolean;
		expectedDue?: number;
	},
	reasons: string[],
	allHistograms: HistogramFacts[],
): ParsedClientWindow {
	const windows = objectAt(report, "windows", scope, reasons);
	const path = `${scope}.windows.${windowName}`;
	const window = objectValue(windows[windowName], path, reasons);
	const counter = (key: string) =>
		numberAt(window, key, path, reasons, { integer: true, min: 0 });
	const sent = counter("sent");
	const sendErr = counter("sendErr");
	const due = counter("scheduleTicksDue");
	const fired = counter("scheduleTicksFired");
	const skipped = counter("scheduleTicksSkipped");
	const rxSnapshot = counter("rxSnapshot");
	const rxAck = counter("rxAck");
	const rxRaid = counter("rxRaid");
	const rxOther = counter("rxOther");
	const rxUnstamped = counter("rxUnstamped");
	const ackUnreflected = counter("ackUnreflected");
	const sessionsLost = counter("sessionsLost");

	if (options.schedule) {
		if (window.scheduleTicksReconciled !== true) {
			reasons.push(`V-A ${path}: scheduleTicksReconciled must be true`);
		}
		if (due !== fired + skipped) {
			reasons.push(
				`V-A ${path}: schedule due ${due} != fired ${fired} + skipped ${skipped}`,
			);
		}
		if (sent + sendErr !== fired) {
			reasons.push(
				`V-A ${path}: sent ${sent} + sendErr ${sendErr} != fired ${fired}`,
			);
		}
		if (options.expectedDue !== undefined && due !== options.expectedDue) {
			reasons.push(
				`V-A ${path}: schedule due ${due}, expected registered ${options.expectedDue}`,
			);
		}
	}
	if (ackUnreflected > rxAck) {
		reasons.push(
			`V-A ${path}: ackUnreflected ${ackUnreflected} exceeds rxAck ${rxAck}`,
		);
	}

	return {
		sent,
		sendErr,
		due,
		fired,
		skipped,
		rxSnapshot,
		rxAck,
		rxRaid,
		rxOther,
		rxUnstamped,
		ackUnreflected,
		sessionsLost,
		scheduleLag: options.schedule
			? parseHistogram(
					window.scheduleLag,
					scope === "floor"
						? "floor/scheduleLag"
						: `${scope}/${windowName}/scheduleLag`,
					fired,
					0,
					reasons,
					allHistograms,
				)
			: null,
		rtt: options.rtt
			? parseHistogram(
					window.rtt,
					`${scope}/rtt`,
					Math.max(0, rxAck - ackUnreflected),
					rxUnstamped,
					reasons,
					allHistograms,
				)
			: null,
		oneWay: options.oneWay
			? parseHistogram(
					window.oneWay,
					`${scope}/oneWay`,
					rxRaid,
					rxUnstamped,
					reasons,
					allHistograms,
				)
			: null,
	};
}

function validateClientReport(
	value: unknown,
	input: {
		path: string;
		role: string;
		sessions: number;
		startedAt: string;
		preregistrationSha256: string;
		steadySeconds: number;
	},
	reasons: string[],
): JsonObject {
	const report = objectValue(value, input.path, reasons);
	requireExact(report.schema, "mmo-client/2", `${input.path}.schema`, reasons);
	requireExact(report.role, input.role, `${input.path}.role`, reasons);
	const reportStartedAt = stringAt(report, "startedAt", input.path, reasons);
	if (isoDay(reportStartedAt) !== isoDay(input.startedAt)) {
		reasons.push(
			`V-A ${input.path}.startedAt: arm ran ${isoDay(reportStartedAt) ?? "invalid"}, campaign ran ${isoDay(input.startedAt) ?? "invalid"}`,
		);
	}
	validatePreregistration(
		report.preRegistration,
		`${input.path}.preRegistration`,
		input.preregistrationSha256,
		reasons,
	);
	requireExact(
		report.sessionsRequested,
		input.sessions,
		`${input.path}.sessionsRequested`,
		reasons,
	);
	requireExact(
		report.sessionsOk,
		input.sessions,
		`${input.path}.sessionsOk`,
		reasons,
	);
	requireExact(report.sessionsErr, 0, `${input.path}.sessionsErr`, reasons);
	requireExact(
		report.connectTimedOut,
		false,
		`${input.path}.connectTimedOut`,
		reasons,
	);
	const config = objectAt(report, "config", input.path, reasons);
	requireExact(
		config.steadySec,
		input.steadySeconds,
		`${input.path}.config.steadySec`,
		reasons,
	);
	requireExact(
		config.drainMs,
		G6_DRAIN_MS,
		`${input.path}.config.drainMs`,
		reasons,
	);
	return report;
}

function validateProvenance(
	value: unknown,
	exitValue: unknown,
	path: string,
	expectedHost: string,
	expectedCandidate: string,
	reasons: string[],
): string[] {
	const local: string[] = [];
	if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) {
		local.push(`${path}: expected provenance line array`);
	} else {
		const transcript = value.join("\n");
		if (!transcript.includes(`host=${expectedHost} `)) {
			local.push(`${path}: generator host does not match ${expectedHost}`);
		}
		if (!transcript.includes(`candidate=${expectedCandidate}`)) {
			local.push(
				`${path}: requested candidate does not match ${expectedCandidate}`,
			);
		}
		if (!transcript.includes(`head=${expectedCandidate} dirty=no`)) {
			local.push(`${path}: checked-out head is not exact and clean`);
		}
		if (!/binary=\S+ sha256=[0-9a-f]{64}\b/i.test(transcript)) {
			local.push(`${path}: missing binary SHA-256`);
		}
		if (!/(?:^|\n)macgen: exit=0(?:\n|$)/.test(transcript)) {
			local.push(`${path}: provenance did not record exit=0`);
		}
	}
	if (exitValue !== 0) {
		local.push(
			`${path}: launch-owned exit code was ${String(exitValue)}, expected 0`,
		);
	}
	for (const reason of local) reasons.push(`V-A ${reason}`);
	return local;
}

function emitterFacts(
	value: unknown,
	path: string,
	reasons: string[],
): SteadyArmFacts["emitter"] & { raidForwarded: number } {
	const emitter = objectValue(value, path, reasons);
	const counter = (key: string) =>
		numberAt(emitter, key, path, reasons, { integer: true, min: 0 });
	return {
		snapshotDue: counter("snapshotDue"),
		snapshotIssued: counter("snapshotIssued"),
		ackDue: counter("ackDue"),
		ackIssued: counter("ackIssued"),
		raidForwarded: counter("raidForwarded"),
		sendErrors: counter("sendErrors"),
		sendEventsSkipped: counter("sendEventsSkipped"),
		batchPartialCompletions: counter("batchPartialCompletions"),
	};
}

function serverWindow(
	arm: JsonObject,
	windowName: string,
	path: string,
	reasons: string[],
): {
	rxTotal: number;
	rxSurvivors: number;
	emitter: ReturnType<typeof emitterFacts>;
} {
	const windows = objectAt(arm, "windows", path, reasons);
	const windowPath = `${path}.windows.${windowName}`;
	const window = objectValue(windows[windowName], windowPath, reasons);
	const upstream = objectAt(window, "serverUpstream", windowPath, reasons);
	return {
		rxTotal: numberAt(
			upstream,
			"rxTotal",
			`${windowPath}.serverUpstream`,
			reasons,
			{
				integer: true,
				min: 0,
			},
		),
		rxSurvivors: numberAt(
			upstream,
			"rxSurvivors",
			`${windowPath}.serverUpstream`,
			reasons,
			{ integer: true, min: 0 },
		),
		emitter: emitterFacts(window.emitter, `${windowPath}.emitter`, reasons),
	};
}

type SteadyBuild = {
	facts: SteadyArmFacts;
	offeredRatio: number | null;
	realm: JsonObject;
	steady: ParsedClientWindow;
	steadyDrain: ParsedClientWindow;
};

function buildSteadyFacts(
	arm: JsonObject,
	scope: string,
	sessions: number,
	startedAt: string,
	request: G6EvaluationRequest,
	reasons: string[],
	allHistograms: HistogramFacts[],
): SteadyBuild {
	const path = `artifact.arms.${scope}`;
	const raw = objectAt(arm, "rawReports", path, reasons);
	const realm = validateClientReport(
		raw.realm,
		{
			path: `${path}.rawReports.realm`,
			role: "realm",
			sessions,
			startedAt,
			preregistrationSha256: request.expectedPreregistrationSha256,
			steadySeconds: G6_STEADY_SECONDS,
		},
		reasons,
	);
	validateProvenance(
		raw.realmProvenance,
		raw.realmExitCode,
		`${path}.rawReports.realmProvenance`,
		request.expectedGeneratorHost,
		request.expectedCandidate,
		reasons,
	);
	const expectedUpstream = sessions * MOVE_HZ * G6_STEADY_SECONDS;
	const steady = parseClientWindow(
		realm,
		"steady",
		scope,
		{
			schedule: true,
			rtt: false,
			oneWay: false,
			expectedDue: expectedUpstream,
		},
		reasons,
		allHistograms,
	);
	const steadyDrain = parseClientWindow(
		realm,
		"steadyDrain",
		scope,
		{ schedule: false, rtt: true, oneWay: false },
		reasons,
		allHistograms,
	);
	const server = serverWindow(arm, "steadyDrain", path, reasons);
	const expectedSnapshot =
		sessions * armShape(sessions).snapshotPpsPerSession * G6_STEADY_SECONDS;
	const expectedAck =
		((sessions * armShape(sessions).ackAggregatePps) / sessions) *
		G6_STEADY_SECONDS;
	if (server.emitter.snapshotDue !== expectedSnapshot) {
		reasons.push(
			`V-A ${scope}: snapshot due ${server.emitter.snapshotDue}, expected ${expectedSnapshot}`,
		);
	}
	if (server.emitter.ackDue !== expectedAck) {
		reasons.push(
			`V-A ${scope}: ack due ${server.emitter.ackDue}, expected ${expectedAck}`,
		);
	}
	const stageWindows = objectAt(arm, "stageWindows", path, reasons);
	const stageSteady = objectValue(
		stageWindows.steady,
		`${path}.stageWindows.steady`,
		reasons,
	);
	const cpuWindows = objectAt(arm, "cpuWindows", path, reasons);
	const cpuSteadyDrain = objectValue(
		cpuWindows.steadyDrain,
		`${path}.cpuWindows.steadyDrain`,
		reasons,
	);
	const ledgerPath = `${path}.stageWindows.steady`;
	const rtt = requiredValue(steadyDrain.rtt, `${scope} RTT facts`);
	const facts: SteadyArmFacts = {
		sessions,
		clientEnqueuedUpstream: steady.sent,
		serverRxUpstream: server.rxTotal,
		snapshotServerIssued: server.emitter.snapshotIssued,
		snapshotClientReceived: steadyDrain.rxSnapshot,
		ackServerIssued: server.emitter.ackIssued,
		ackClientReceived: steadyDrain.rxAck,
		rtt,
		sessionsLost: steadyDrain.sessionsLost,
		sessionsActiveAtEnd: numberAt(
			cpuSteadyDrain,
			"sessionsActiveEnd",
			`${path}.cpuWindows.steadyDrain`,
			reasons,
			{ integer: true, min: 0 },
		),
		ledger: {
			clientEnqueued: numberAt(
				stageSteady,
				"clientEnqueued",
				ledgerPath,
				reasons,
				{
					integer: true,
					min: 0,
				},
			),
			clientWireTx: nullableNumberAt(
				stageSteady,
				"clientWireTx",
				ledgerPath,
				reasons,
				{ integer: true, min: 0 },
			),
			kernelDropsSocket: nullableNumberAt(
				stageSteady,
				"kernelDropsSocket",
				ledgerPath,
				reasons,
				{ integer: true, min: 0 },
			),
			kernelRcvbufErrors: nullableNumberAt(
				stageSteady,
				"kernelRcvbufErrors",
				ledgerPath,
				reasons,
				{ integer: true, min: 0 },
			),
			serverObserved: nullableNumberAt(
				stageSteady,
				"serverObserved",
				ledgerPath,
				reasons,
				{ integer: true, min: 0 },
			),
			jsDelivered: numberAt(stageSteady, "jsDelivered", ledgerPath, reasons, {
				integer: true,
				min: 0,
			}),
			nativeDropped: nullableNumberAt(
				stageSteady,
				"nativeDropped",
				ledgerPath,
				reasons,
				{ integer: true, min: 0 },
			),
			nativeSkippedQueueFull: nullableNumberAt(
				stageSteady,
				"nativeSkippedQueueFull",
				ledgerPath,
				reasons,
				{ integer: true, min: 0 },
			),
		},
		emitter: server.emitter,
	};
	return {
		facts,
		offeredRatio: expectedUpstream > 0 ? steady.sent / expectedUpstream : null,
		realm,
		steady,
		steadyDrain,
	};
}

function preflightVerdict(
	value: unknown,
	name: "R-down" | "R-up",
	runDateIso: string,
	expectedHost: string,
	reasons: string[],
): PreflightVerdict {
	const local: string[] = [];
	const root = objectValue(value, `preflight ${name}`, local);
	const startedAt = stringAt(root, "startedAt", `preflight ${name}`, local);
	const generator = objectAt(root, "generator", `preflight ${name}`, local);
	const link = objectAt(root, "link", `preflight ${name}`, local);
	const guards = arrayAt(root, "guards", `preflight ${name}`, local);
	const udpRungs = arrayAt(root, "udpRungs", `preflight ${name}`, local);
	if (generator.hostname !== expectedHost) {
		local.push(
			`V-C ${name}: preflight host ${String(generator.hostname)} did not match ${expectedHost}`,
		);
	}
	if (typeof root.schemaVersion !== "number") {
		local.push(`V-C ${name}: missing numeric schemaVersion`);
	}
	if (!(typeof link.mtuBytes === "number" || link.mtuBytes === null)) {
		local.push(`V-C ${name}: link.mtuBytes must be numeric or null`);
	}
	for (const [index, guardValue] of guards.entries()) {
		const guard = isObject(guardValue) ? guardValue : null;
		if (
			!guard ||
			typeof guard.ok !== "boolean" ||
			typeof guard.detail !== "string"
		) {
			local.push(`V-C ${name}: guard ${index} is malformed`);
		}
	}
	for (const [index, rungValue] of udpRungs.entries()) {
		const rung = isObject(rungValue) ? rungValue : null;
		if (
			!rung ||
			!["payloadBytes", "deliveredPps", "offeredPps", "lossPct"].every(
				(key) =>
					typeof rung[key] === "number" && Number.isFinite(rung[key] as number),
			)
		) {
			local.push(`V-C ${name}: UDP rung ${index} is malformed`);
		}
	}
	if (root.rtt !== null && root.rtt !== undefined) {
		const rtt = isObject(root.rtt) ? root.rtt : null;
		if (!rtt || typeof rtt.p99Ms !== "number" || !Number.isFinite(rtt.p99Ms)) {
			local.push(`V-C ${name}: RTT baseline is malformed`);
		}
	}
	if (isoDay(startedAt) === null) {
		local.push(`V-C ${name}: startedAt is not an ISO instant`);
	}
	if (local.length > 0) {
		for (const reason of local) {
			if (!reason.startsWith("V-C")) reasons.push(`V-A ${reason}`);
		}
		return {
			valid: false,
			reasons: local,
			observed: {
				cleanPpsCeiling: null,
				headroomRatio: null,
				mtuBytes: null,
				idleRttP99Ms: null,
				preflightDate: isoDay(startedAt) ?? "invalid",
			},
		};
	}
	const requirement = requiredValue(
		preflightRequirements().find((item) => item.name === name),
		`${name} preflight requirement`,
	);
	return evaluatePreflight(root as PreflightArtifact, {
		...requirement,
		runDateIso,
	});
}

function evaluateFloor(
	request: G6EvaluationRequest,
	runDateIso: string,
	allHistograms: HistogramFacts[],
): { falsifier: FalsifierResult; facts: Record<string, unknown> } {
	const report = parseGeneratorReport(
		request.floorTranscript,
		request.expectedCandidate,
		request.expectedPreregistrationSha256,
	);
	const usability = floorReportIsUsable(
		report,
		request.expectedGeneratorHost,
		request.expectedPreregistrationSha256,
	);
	const floorReasons = usability.reasons.map((reason) => `V-F: ${reason}`);
	const root = objectValue(report.latencyJson, "floor report", floorReasons);
	const sessionsRequested = numberAt(
		root,
		"sessionsRequested",
		"floor report",
		floorReasons,
		{ integer: true, min: 0 },
	);
	if (sessionsRequested !== G6_FLOOR_SESSIONS) {
		floorReasons.push(
			`V-F: floor sessionsRequested ${sessionsRequested}, expected ${G6_FLOOR_SESSIONS}`,
		);
	}
	const sessionsOk = numberAt(
		root,
		"sessionsOk",
		"floor report",
		floorReasons,
		{ integer: true, min: 0 },
	);
	if (sessionsOk !== G6_FLOOR_SESSIONS) {
		floorReasons.push(
			`V-F: floor sessionsOk ${sessionsOk}, expected ${G6_FLOOR_SESSIONS}`,
		);
	}
	const sessionsErr = numberAt(
		root,
		"sessionsErr",
		"floor report",
		floorReasons,
		{ integer: true, min: 0 },
	);
	if (sessionsErr !== 0) {
		floorReasons.push(`V-F: floor sessionsErr ${sessionsErr}, expected 0`);
	}
	requireExact(
		root.connectTimedOut,
		false,
		"floor report.connectTimedOut",
		floorReasons,
	);
	requireExact(
		root.schema,
		"mmo-client/2",
		"floor report.schema",
		floorReasons,
	);
	requireExact(root.role, "realm", "floor report.role", floorReasons);
	validatePreregistration(
		root.preRegistration,
		"floor report.preRegistration",
		request.expectedPreregistrationSha256,
		floorReasons,
	);
	const config = objectAt(root, "config", "floor report", floorReasons);
	const steadySec = numberAt(
		config,
		"steadySec",
		"floor report.config",
		floorReasons,
		{
			min: 0,
		},
	);
	requireExact(
		config.drainMs,
		G6_DRAIN_MS,
		"floor report.config.drainMs",
		floorReasons,
	);
	const expectedDue = sessionsRequested * MOVE_HZ * steadySec;
	const floorWindow = parseClientWindow(
		root,
		"steady",
		"floor",
		{ schedule: true, rtt: false, oneWay: false, expectedDue },
		floorReasons,
		allHistograms,
	);
	const histogram = requiredValue(
		floorWindow.scheduleLag,
		"floor schedule-lag facts",
	);
	const histogramReasons = histogramValidity(histogram).reasons;
	for (const reason of histogramReasons) {
		floorReasons.push(`V-F: ${reason}`);
	}
	const startedAt = report.startedAt;
	const base = falsifierFloor({
		scheduleLagP99Ms: histogram.p99Ns === null ? null : histogram.p99Ns / 1e6,
		scheduleLagMaxMs: histogram.maxNs === null ? null : histogram.maxNs / 1e6,
		floorArmDateIso: startedAt,
		runDateIso,
		generatorHostMatches:
			report.provenance.host === request.expectedGeneratorHost,
		drivingSessions: report.sessionsDriving ?? 0,
	});
	const combined = [...base.reasons, ...floorReasons];
	return {
		falsifier: {
			id: "V-F",
			fired: combined.length > 0,
			reasons: combined,
			scope: "run",
		},
		facts: {
			usable: usability.usable,
			host: report.provenance.host,
			startedAt,
			sessionsRequested,
			sessionsOk,
			sessionsErr,
			scheduleLagP99Ns: histogram.p99Ns,
			scheduleLagMaxNs: histogram.maxNs,
		},
	};
}

function evaluateSink(
	value: unknown,
	expectedHost: string,
	runDateIso: string,
	validityReasons: string[],
): { falsifier: FalsifierResult; facts: Record<string, unknown> } {
	const path = "sink precheck";
	const root = objectValue(value, path, validityReasons);
	const sinkReasons: string[] = [];
	requireExact(root.kind, "g6-sink-precheck", `${path}.kind`, sinkReasons);
	requireExact(root.host, expectedHost, `${path}.host`, sinkReasons);
	const dateIso = stringAt(root, "dateIso", path, sinkReasons);
	if (isoDay(dateIso) !== isoDay(runDateIso)) {
		sinkReasons.push(
			`V-S: sink ran ${isoDay(dateIso) ?? "invalid"}, gate ran ${isoDay(runDateIso) ?? "invalid"}`,
		);
	}
	const sentPackets = numberAt(root, "sentPackets", path, sinkReasons, {
		integer: true,
		min: 0,
	});
	const lostPackets = numberAt(root, "lostPackets", path, sinkReasons, {
		integer: true,
		min: 0,
	});
	const seconds = numberAt(root, "seconds", path, sinkReasons, { min: 0 });
	if (sentPackets <= 0)
		sinkReasons.push("V-S: sink raw sentPackets must be positive");
	if (seconds <= 0) sinkReasons.push("V-S: sink raw seconds must be positive");
	if (lostPackets > sentPackets) {
		sinkReasons.push("V-S: sink raw lostPackets exceeds sentPackets");
	}
	const offeredPps = seconds > 0 ? sentPackets / seconds : null;
	const deliveryRatio =
		sentPackets > 0 ? (sentPackets - lostPackets) / sentPackets : null;
	const saturated =
		offeredPps === null ? true : originatorSaturated(offeredPps);
	const requirement = sinkPrecheckRequirement();
	const expectedFields: [string, number | boolean][] = [
		["payloadBytes", SINK_PRECHECK_PAYLOAD_BYTES],
		["armDownstreamPps", requirement.armDownstreamPps],
		["headroomFactor", requirement.headroomFactor],
		["requiredPps", requirement.requiredPps],
		["targetPps", SINK_PRECHECK_TARGET_PPS],
		["targetBps", SINK_PRECHECK_TARGET_BPS],
		["saturationBoundaryPps", SINK_PRECHECK_SATURATION_BOUNDARY_PPS],
		["precheckOriginatorSaturated", saturated],
	];
	for (const [key, expected] of expectedFields) {
		if (root[key] !== expected) {
			sinkReasons.push(
				`V-S: sink ${key} ${String(root[key])} did not match recomputed ${String(expected)}`,
			);
		}
	}
	if (
		offeredPps !== null &&
		(typeof root.precheckOfferedPps !== "number" ||
			!nearlyEqual(root.precheckOfferedPps, offeredPps))
	) {
		sinkReasons.push(
			"V-S: sink offered rate summary did not match raw packets/time",
		);
	}
	if (
		deliveryRatio !== null &&
		(typeof root.precheckDeliveryRatio !== "number" ||
			!nearlyEqual(root.precheckDeliveryRatio, deliveryRatio))
	) {
		sinkReasons.push(
			"V-S: sink delivery summary did not match raw packet loss",
		);
	}
	const base = falsifierSink({
		armDownstreamPps: requirement.armDownstreamPps,
		precheckOfferedPps: offeredPps,
		precheckDeliveryRatio: deliveryRatio,
		precheckOriginatorSaturated: saturated,
	});
	const combined = [...base.reasons, ...sinkReasons];
	return {
		falsifier: { ...base, fired: combined.length > 0, reasons: combined },
		facts: { offeredPps, deliveryRatio, originatorSaturated: saturated },
	};
}

function validateBarrier(
	arm: JsonObject,
	reports: { role: string; report: JsonObject }[],
	reasons: string[],
): void {
	const path = "artifact.arms.hotspot-5000.phaseBarrier";
	const summary = objectValue(arm.phaseBarrier, path, reasons);
	const raw: { role: string; evidence: JsonObject }[] = reports.map((item) => ({
		role: item.role,
		evidence: objectValue(
			item.report.phaseBarrier,
			`${path}.${item.role}`,
			reasons,
		),
	}));
	const ids = new Set(raw.map((item) => item.evidence.id));
	const releasesMono = new Set(
		raw.map((item) => item.evidence.releaseMonotonicNs),
	);
	const releasesUnix = new Set(raw.map((item) => item.evidence.releaseUnixMs));
	if (ids.size !== 1 || !ids.has(summary.id)) {
		reasons.push(
			"V-A hotspot phase barrier identity did not agree across roles",
		);
	}
	if (releasesMono.size !== 1 || releasesUnix.size !== 1) {
		reasons.push(
			"V-A hotspot phase barrier release did not agree across roles",
		);
	}
	const seenRoles = new Set<string>();
	const enters: number[] = [];
	for (const item of raw) {
		requireExact(
			item.evidence.parties,
			HOTSPOT_PHASE_BARRIER_PARTIES,
			`${path}.${item.role}.parties`,
			reasons,
		);
		requireExact(
			item.evidence.role,
			item.role,
			`${path}.${item.role}.role`,
			reasons,
		);
		seenRoles.add(String(item.evidence.role));
		const entered = numberAt(
			item.evidence,
			"steadyEnterMonotonicNs",
			`${path}.${item.role}`,
			reasons,
			{ min: 0 },
		);
		enters.push(entered);
	}
	const expectedRoles = [...HOTSPOT_PHASE_BARRIER_ROLES].sort();
	if ([...seenRoles].sort().join(",") !== expectedRoles.join(",")) {
		reasons.push("V-A hotspot phase barrier roles were incomplete");
	}
	const skewMs = (Math.max(...enters) - Math.min(...enters)) / 1e6;
	if (skewMs > HOTSPOT_PHASE_BARRIER_STEADY_SKEW_MS) {
		reasons.push(
			`V-A hotspot phase barrier steady-entry skew ${skewMs} ms exceeded ${HOTSPOT_PHASE_BARRIER_STEADY_SKEW_MS} ms`,
		);
	}
	if (summary.steadyEnterSkewMs !== skewMs) {
		reasons.push(
			`V-A hotspot phase barrier summary skew ${String(summary.steadyEnterSkewMs)} did not match raw ${skewMs}`,
		);
	}
}

function invalidFalsifier(reasons: string[]): FalsifierResult {
	return {
		id: "V-A",
		fired: reasons.length > 0,
		reasons,
		scope: "run",
	};
}

export function evaluateG6(request: G6EvaluationRequest): G6ClassifiedV2 {
	const validityReasons: string[] = [];
	const allHistograms: HistogramFacts[] = [];
	try {
		if (
			canonicalGeneratorIdentity(request.expectedGeneratorHost) !==
			request.expectedGeneratorHost
		) {
			validityReasons.push(
				"V-A expected generator host must use the canonical short hostname",
			);
		}
	} catch (error) {
		validityReasons.push(
			`V-A invalid expected generator host: ${String(error)}`,
		);
	}
	if (!/^[0-9a-f]{40}$/.test(request.expectedCandidate)) {
		validityReasons.push("V-A expected candidate must be lowercase 40-hex");
	}
	if (!/^[0-9a-f]{40}$/.test(request.graderSha)) {
		validityReasons.push("V-A grader SHA must be lowercase 40-hex");
	}
	if (!/^[0-9a-f]{64}$/.test(request.expectedPreregistrationSha256)) {
		validityReasons.push(
			"V-A expected preregistration SHA-256 must be lowercase 64-hex",
		);
	}
	if (
		request.trackedPreregistrationSha256 !==
		request.expectedPreregistrationSha256
	) {
		validityReasons.push(
			`V-A tracked preregistration SHA-256 ${request.trackedPreregistrationSha256} did not match expected ${request.expectedPreregistrationSha256}`,
		);
	}
	for (const [name, hash] of Object.entries(request.inputSha256)) {
		if (!/^[0-9a-f]{64}$/.test(hash)) {
			validityReasons.push(
				`V-A input ${name} SHA-256 must be lowercase 64-hex`,
			);
		}
	}
	if (!request.artifactCsvPresent) {
		validityReasons.push("V-A required nonempty bench-g6 CSV input is missing");
	}

	const artifact = objectValue(request.artifact, "artifact", validityReasons);
	requireExact(artifact.version, 2, "artifact.version", validityReasons);
	requireExact(
		artifact.schema,
		"bench-g6/2",
		"artifact.schema",
		validityReasons,
	);
	requireExact(artifact.complete, true, "artifact.complete", validityReasons);
	requireExact(artifact.aborted, null, "artifact.aborted", validityReasons);
	validatePreregistration(
		artifact.preRegistration,
		"artifact.preRegistration",
		request.expectedPreregistrationSha256,
		validityReasons,
	);
	const startedAt = stringAt(
		artifact,
		"startedAt",
		"artifact",
		validityReasons,
	);
	if (isoDay(startedAt) === null) {
		validityReasons.push("V-A artifact.startedAt is not an ISO instant");
	}
	const source = objectAt(artifact, "source", "artifact", validityReasons);
	requireExact(
		source.candidateSha,
		request.expectedCandidate,
		"artifact.source.candidateSha",
		validityReasons,
	);
	requireExact(source.dirty, false, "artifact.source.dirty", validityReasons);
	requireExact(
		source.coResident,
		false,
		"artifact.source.coResident",
		validityReasons,
	);
	const host = objectAt(artifact, "host", "artifact", validityReasons);
	if (typeof host.offboxSsh !== "string" || host.offboxSsh.length === 0) {
		validityReasons.push(
			"V-A artifact.host.offboxSsh must identify a nonempty off-box SSH destination",
		);
	}
	const config = objectAt(artifact, "config", "artifact", validityReasons);
	const expectedConfig: [string, unknown][] = [
		["movePps", MOVE_HZ],
		["actionPps", 0.5],
		["actionEvery", 8],
		["upstreamPayloadBytes", 64],
		["snapshotHz", 5],
		["snapshotDatagrams", 3],
		["snapshotPayloadBytes", 1150],
		["emitterSliceHz", 50],
		["raidMembers", RAID_MEMBERS],
		["raidPublisherHz", RAID_PUBLISHER_HZ],
		["steadySeconds", G6_STEADY_SECONDS],
		["drainGraceMs", G6_DRAIN_MS],
		["stormWindowSec", G6_STORM_WINDOW_SECONDS],
		["datagramSendSync", null],
	];
	for (const [key, expected] of expectedConfig) {
		requireExact(
			config[key],
			expected,
			`artifact.config.${key}`,
			validityReasons,
		);
	}
	if (
		!Array.isArray(config.ladder) ||
		config.ladder.join(",") !== REALM_LADDER.join(",")
	) {
		validityReasons.push(
			"V-A artifact.config.ladder did not match 500,2500,5000",
		);
	}
	if (
		!Array.isArray(config.stormCohorts) ||
		config.stormCohorts.join(",") !== "1000,5000"
	) {
		validityReasons.push(
			"V-A artifact.config.stormCohorts did not match 1000,5000",
		);
	}

	const armValues = arrayAt(artifact, "arms", "artifact", validityReasons);
	const arms = armValues.filter(isObject);
	if (arms.length !== armValues.length) {
		validityReasons.push("V-A artifact.arms contained a non-object arm");
	}
	const armNames = arms.map((arm) => arm.arm);
	if (
		armNames.length !== EXPECTED_ARMS.length ||
		new Set(armNames).size !== EXPECTED_ARMS.length ||
		EXPECTED_ARMS.some((name) => !armNames.includes(name))
	) {
		validityReasons.push(
			`V-A artifact arms [${armNames.map(String).join(",")}] did not match the registered six-arm set`,
		);
	}
	const findArm = (name: string): JsonObject => {
		const found = arms.find((arm) => arm.arm === name);
		const arm = objectValue(found, `artifact.arms.${name}`, validityReasons);
		if (
			!Array.isArray(arm.degraded) ||
			arm.degraded.some((entry) => typeof entry !== "string")
		) {
			validityReasons.push(
				`V-A ${name} degraded evidence must be a string array`,
			);
		} else if (arm.degraded.length > 0) {
			validityReasons.push(
				`V-A ${name} degraded evidence: ${arm.degraded.join(" | ")}`,
			);
		}
		requireExact(
			arm.clockSource,
			"clock_gettime(CLOCK_MONOTONIC)",
			`${name}.clockSource`,
			validityReasons,
		);
		return arm;
	};

	const clauses: ClauseResult[] = [];
	const steadyRungs: Record<string, unknown>[] = [];
	const offeredRatioByRung: {
		sessions: number;
		offeredRatio: number | null;
	}[] = [];
	for (const sessions of REALM_LADDER) {
		const scope = `steady-${sessions}`;
		const arm = findArm(scope);
		requireExact(arm.sessions, sessions, `${scope}.sessions`, validityReasons);
		const built = buildSteadyFacts(
			arm,
			scope,
			sessions,
			startedAt,
			request,
			validityReasons,
			allHistograms,
		);
		const armClauses = steadyArmClauses(built.facts).map((clause) =>
			scopedClause(scope, clause),
		);
		clauses.push(...armClauses);
		offeredRatioByRung.push({ sessions, offeredRatio: built.offeredRatio });
		steadyRungs.push({
			sessions,
			offeredRatio: built.offeredRatio,
			clientEnqueuedUpstream: built.facts.clientEnqueuedUpstream,
			serverRxUpstream: built.facts.serverRxUpstream,
			rtt: built.facts.rtt,
		});
	}

	const hotspotArm = findArm("hotspot-5000");
	requireExact(
		hotspotArm.sessions,
		gateRung(),
		"hotspot-5000.sessions",
		validityReasons,
	);
	const hotspotSteady = buildSteadyFacts(
		hotspotArm,
		"hotspot-5000",
		gateRung(),
		startedAt,
		request,
		validityReasons,
		allHistograms,
	);
	const hotspotRaw = objectAt(
		hotspotArm,
		"rawReports",
		"artifact.arms.hotspot-5000",
		validityReasons,
	);
	const subscriber = validateClientReport(
		hotspotRaw.subscriber,
		{
			path: "artifact.arms.hotspot-5000.rawReports.subscriber",
			role: "raid-subscriber",
			sessions: RAID_MEMBERS,
			startedAt,
			preregistrationSha256: request.expectedPreregistrationSha256,
			steadySeconds: G6_STEADY_SECONDS,
		},
		validityReasons,
	);
	const subscriberProvenanceProblems = validateProvenance(
		hotspotRaw.subscriberProvenance,
		hotspotRaw.subscriberExitCode,
		"artifact.arms.hotspot-5000.rawReports.subscriberProvenance",
		request.expectedGeneratorHost,
		request.expectedCandidate,
		validityReasons,
	);
	const subscriberWindow = parseClientWindow(
		subscriber,
		"steadyDrain",
		"hotspot-5000",
		{ schedule: false, rtt: false, oneWay: true },
		validityReasons,
		allHistograms,
	);
	const publisher = validateClientReport(
		hotspotRaw.publisher,
		{
			path: "artifact.arms.hotspot-5000.rawReports.publisher",
			role: "publisher",
			sessions: 1,
			startedAt,
			preregistrationSha256: request.expectedPreregistrationSha256,
			steadySeconds: G6_STEADY_SECONDS,
		},
		validityReasons,
	);
	const publisherProvenanceProblems = validateProvenance(
		hotspotRaw.publisherProvenance,
		hotspotRaw.publisherExitCode,
		"artifact.arms.hotspot-5000.rawReports.publisherProvenance",
		request.expectedGeneratorHost,
		request.expectedCandidate,
		validityReasons,
	);
	const expectedPublisherDue = RAID_PUBLISHER_HZ * G6_STEADY_SECONDS;
	const publisherWindow = parseClientWindow(
		publisher,
		"steady",
		"hotspot-5000/publisher",
		{
			schedule: true,
			rtt: false,
			oneWay: false,
			expectedDue: expectedPublisherDue,
		},
		validityReasons,
		allHistograms,
	);
	if (
		hotspotSteady.realm.startedAt !== subscriber.startedAt ||
		hotspotSteady.realm.startedAt !== publisher.startedAt
	) {
		validityReasons.push(
			"V-A hotspot role startedAt values did not agree within the shared arm",
		);
	}
	validateBarrier(
		hotspotArm,
		[
			{ role: "realm", report: hotspotSteady.realm },
			{ role: "raid-subscriber", report: subscriber },
			{ role: "publisher", report: publisher },
		],
		validityReasons,
	);
	const hotspot = objectAt(
		hotspotArm,
		"hotspot",
		"artifact.arms.hotspot-5000",
		validityReasons,
	);
	const hotspotPath = "artifact.arms.hotspot-5000.hotspot";
	const subscribers = numberAt(
		hotspot,
		"subscribers",
		hotspotPath,
		validityReasons,
		{
			integer: true,
			min: 0,
		},
	);
	const ingested = numberAt(hotspot, "ingested", hotspotPath, validityReasons, {
		integer: true,
		min: 0,
	});
	const publisherStamped = numberAt(
		hotspot,
		"publisherStamped",
		hotspotPath,
		validityReasons,
		{ integer: true, min: 0 },
	);
	if (subscribers !== RAID_MEMBERS) {
		validityReasons.push(
			`V-A hotspot subscribers ${subscribers}, expected ${RAID_MEMBERS}`,
		);
	}
	const forwarded = numberAt(
		hotspot,
		"forwarded",
		hotspotPath,
		validityReasons,
		{
			integer: true,
			min: 0,
		},
	);
	const subscriberReceived = subscriberWindow.rxRaid;
	if (hotspot.subscriberReceived !== subscriberReceived) {
		validityReasons.push(
			`V-A hotspot subscriberReceived summary ${String(hotspot.subscriberReceived)} did not match raw ${subscriberReceived}`,
		);
	}
	if (hotspot.publisherSent !== publisherWindow.sent) {
		validityReasons.push(
			`V-A hotspot publisherSent summary ${String(hotspot.publisherSent)} did not match raw ${publisherWindow.sent}`,
		);
	}
	const frameGapFraction = numberAt(
		hotspot,
		"frameGapFraction",
		hotspotPath,
		validityReasons,
		{ min: 0, max: 1 },
	);
	const dwell = parseHistogram(
		hotspot.serverForwardDwell,
		"hotspot-5000/serverForwardDwell",
		ingested,
		0,
		validityReasons,
		allHistograms,
	);
	const oneWay = requiredValue(
		subscriberWindow.oneWay,
		"hotspot subscriber one-way facts",
	);
	const hotspotFacts: HotspotFacts = {
		subscribers,
		oneWay,
		ingested,
		forwarded,
		subscriberReceived,
		pathP50Ns: oneWay.p50Ns ?? 0,
		serverForwardDwellP50Ns: dwell.p50Ns ?? 0,
		frameGapFraction,
		datagramsPerTick:
			publisherWindow.fired > 0
				? publisherWindow.sent / publisherWindow.fired
				: 0,
		publisherStamped,
	};
	const concurrentFacts: SteadyArmFacts = {
		...hotspotSteady.facts,
		serverRxUpstream: Math.max(
			0,
			hotspotSteady.facts.serverRxUpstream - ingested,
		),
	};
	clauses.push(
		scopedClause("hotspot-5000", clauseH1(hotspotFacts)),
		scopedClause("hotspot-5000", clauseH2(hotspotFacts)),
		scopedClause("hotspot-5000", clauseH3(concurrentFacts)),
	);
	const ingestBase = falsifierIngestReality(hotspotFacts);
	const ingestProvenanceReasons = [
		...subscriberProvenanceProblems,
		...publisherProvenanceProblems,
	].map((reason) => `V-I provenance: ${reason}`);
	const ingestFalsifier: FalsifierResult = {
		...ingestBase,
		fired: ingestBase.fired || ingestProvenanceReasons.length > 0,
		reasons: [...ingestBase.reasons, ...ingestProvenanceReasons],
	};

	const storms: Record<string, unknown>[] = [];
	const littleResults: { scope: string; result: FalsifierResult }[] = [];
	for (const cohort of [1000, 5000] as const) {
		const scope = `storm-${cohort}`;
		const arm = findArm(scope);
		requireExact(
			arm.sessions,
			gateRung(),
			`${scope}.sessions`,
			validityReasons,
		);
		const path = `artifact.arms.${scope}`;
		const raw = objectAt(arm, "rawReports", path, validityReasons);
		const realm = validateClientReport(
			raw.realm,
			{
				path: `${path}.rawReports.realm`,
				role: "realm",
				sessions: gateRung(),
				startedAt,
				preregistrationSha256: request.expectedPreregistrationSha256,
				steadySeconds: G6_STEADY_SECONDS,
			},
			validityReasons,
		);
		validateProvenance(
			raw.realmProvenance,
			raw.realmExitCode,
			`${path}.rawReports.realmProvenance`,
			request.expectedGeneratorHost,
			request.expectedCandidate,
			validityReasons,
		);
		const survivorCount = gateRung() - cohort;
		const server = serverWindow(arm, "storm", path, validityReasons);
		let survivors: StormFacts["survivors"] = null;
		if (survivorCount > 0) {
			const survivorWindow = parseClientWindow(
				realm,
				"stormSurvivors",
				scope,
				{
					schedule: true,
					rtt: true,
					oneWay: false,
					expectedDue: survivorCount * MOVE_HZ * G6_STORM_WINDOW_SECONDS,
				},
				validityReasons,
				allHistograms,
			);
			survivors = {
				sessions: survivorCount,
				rtt: requiredValue(survivorWindow.rtt, `${scope} survivor RTT facts`),
				clientEnqueuedUpstream: survivorWindow.sent,
				serverRxUpstream: server.rxSurvivors,
				sessionsLost: survivorWindow.sessionsLost,
			};
		}
		const storm = objectAt(arm, "storm", path, validityReasons);
		const stormPath = `${path}.storm`;
		if (storm.cohort !== cohort) {
			validityReasons.push(
				`V-A ${scope} server cohort ${String(storm.cohort)}, expected ${cohort}`,
			);
		}
		const acceptValues = arrayAt(
			storm,
			"acceptSeries",
			stormPath,
			validityReasons,
		);
		let acceptRatePerSec: number | null = null;
		let priorAcceptBucketMs = Number.NEGATIVE_INFINITY;
		for (const [index, value] of acceptValues.entries()) {
			const bucket = objectValue(
				value,
				`${stormPath}.acceptSeries[${index}]`,
				validityReasons,
			);
			const tMs = numberAt(
				bucket,
				"tMs",
				`${stormPath}.acceptSeries[${index}]`,
				validityReasons,
				{ min: 0 },
			);
			if (tMs <= priorAcceptBucketMs) {
				validityReasons.push(
					`V-A ${scope} acceptSeries timestamps must be strictly ascending`,
				);
			}
			priorAcceptBucketMs = tMs;
			const accepts = numberAt(
				bucket,
				"accepts",
				`${stormPath}.acceptSeries[${index}]`,
				validityReasons,
				{ integer: true, min: 0 },
			);
			acceptRatePerSec = Math.max(acceptRatePerSec ?? 0, accepts);
		}
		const clientStorm = objectAt(
			realm,
			"storm",
			`${path}.rawReports.realm`,
			validityReasons,
		);
		if (clientStorm.cohort !== cohort) {
			validityReasons.push(
				`V-A ${scope} client cohort ${String(clientStorm.cohort)}, expected ${cohort}`,
			);
		}
		if (clientStorm.ran !== true) {
			validityReasons.push(`V-A ${scope} client storm.ran must be true`);
		}
		if (clientStorm.windowSec !== G6_STORM_WINDOW_SECONDS) {
			validityReasons.push(
				`V-A ${scope} client storm window ${String(clientStorm.windowSec)}, expected ${G6_STORM_WINDOW_SECONDS}`,
			);
		}
		const concurrency = nullableNumberAt(
			clientStorm,
			"concurrency",
			`${path}.rawReports.realm.storm`,
			validityReasons,
			{ integer: true, min: 1 },
		);
		const reconnectMeanMs = nullableNumberAt(
			clientStorm,
			"reconnectMeanMs",
			`${path}.rawReports.realm.storm`,
			validityReasons,
			{ min: 0 },
		);
		const facts: StormFacts = {
			cohort,
			realmSessions: gateRung(),
			survivors,
			reAcceptedInWindow: numberAt(
				storm,
				"reAcceptedInWindow",
				stormPath,
				validityReasons,
				{ integer: true, min: 0 },
			),
			sessionsActiveAtWindowClose: numberAt(
				storm,
				"sessionsActiveAtWindowClose",
				stormPath,
				validityReasons,
				{ integer: true, min: 0 },
			),
			limitExceededDelta: numberAt(
				storm,
				"limitExceededDelta",
				stormPath,
				validityReasons,
				{ integer: true, min: 0 },
			),
			rateLimitedDelta: numberAt(
				storm,
				"rateLimitedDelta",
				stormPath,
				validityReasons,
				{ integer: true, min: 0 },
			),
			stormWindowSec: G6_STORM_WINDOW_SECONDS,
		};
		clauses.push(
			scopedClause(scope, clauseSC1(facts)),
			scopedClause(scope, clauseSC2(facts)),
		);
		const little = falsifierLittle({
			acceptRatePerSec,
			meanAcceptLatencySec:
				reconnectMeanMs === null ? null : reconnectMeanMs / 1000,
			connectConcurrency: concurrency,
		});
		littleResults.push({ scope, result: little });
		storms.push({
			cohort,
			survivors,
			reAcceptedInWindow: facts.reAcceptedInWindow,
			acceptRatePerSec,
			meanAcceptLatencyMs: reconnectMeanMs,
			connectConcurrency: concurrency,
		});
	}
	const littleReasons = littleResults.flatMap(({ scope, result }) =>
		result.reasons.map((reason) => `${scope}: ${reason}`),
	);
	const littleFalsifier: FalsifierResult = {
		id: "V-L",
		fired: littleReasons.length > 0,
		reasons: littleReasons,
		scope: "characterization",
	};

	const preflightDown = preflightVerdict(
		request.preflightDown,
		"R-down",
		startedAt,
		request.expectedGeneratorHost,
		validityReasons,
	);
	const preflightUp = preflightVerdict(
		request.preflightUp,
		"R-up",
		startedAt,
		request.expectedGeneratorHost,
		validityReasons,
	);
	const cableFalsifier = falsifierCablePreflight({
		results: [
			{ name: "R-down", verdict: preflightDown },
			{ name: "R-up", verdict: preflightUp },
		],
	});
	const floor = evaluateFloor(request, startedAt, allHistograms);
	const sink = evaluateSink(
		request.sink,
		request.expectedGeneratorHost,
		startedAt,
		validityReasons,
	);
	const generatorFalsifier = falsifierGenerator({ offeredRatioByRung });
	for (const clause of clauses) {
		if (clause.verdict === "INCOMPLETE") {
			validityReasons.push(
				`V-A ${clause.id}: incomplete clause cannot promote a successor gate`,
			);
		}
	}
	const falsifiers: FalsifierResult[] = [
		invalidFalsifier(validityReasons),
		cableFalsifier,
		floor.falsifier,
		sink.falsifier,
		generatorFalsifier,
		ingestFalsifier,
		littleFalsifier,
		falsifierHistograms(allHistograms),
	];
	const rolled = rollUp(clauses, falsifiers);

	return {
		schema: "g6-classified/2",
		preRegistration: {
			id: G6_CLOSEOUT_SPEC_ID,
			path: G6_CLOSEOUT_SPEC_PATH,
			sha256: request.expectedPreregistrationSha256,
		},
		inputSha256: request.inputSha256,
		source: {
			candidateSha: request.expectedCandidate,
			graderSha: request.graderSha,
			generatorHost: request.expectedGeneratorHost,
		},
		normalizedFacts: {
			preflight: { down: preflightDown.observed, up: preflightUp.observed },
			floor: floor.facts,
			sink: sink.facts,
			histograms: allHistograms,
		},
		publication: {
			steadyRungs,
			hotspot: {
				ingested,
				publisherStamped,
				publisherSent: publisherWindow.sent,
				subscriberReceived,
				oneWay,
				serverForwardDwell: dwell,
				frameGapFraction,
			},
			storms,
		},
		clauses: rolled.clauses,
		falsifiers,
		invalidReasons: rolled.invalidReasons,
		characterizationOnlyReasons: rolled.characterizationOnlyReasons,
		final: { valid: rolled.valid, gate: rolled.gate },
	};
}

const CLI_KEYS = new Set([
	"artifact",
	"preflight-down",
	"preflight-up",
	"floor",
	"sink",
	"expected-candidate",
	"expected-generator-host",
	"expected-preregistration-sha256",
	"out",
]);

function parseCliArgs(argv: string[]): Map<string, string> {
	const args = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (
			!flag?.startsWith("--") ||
			value === undefined ||
			value.startsWith("--")
		) {
			throw new Error(`malformed argument near '${flag ?? "<end>"}'`);
		}
		const key = flag.slice(2);
		if (!CLI_KEYS.has(key)) throw new Error(`unknown argument --${key}`);
		if (args.has(key)) throw new Error(`duplicate argument --${key}`);
		args.set(key, value);
	}
	for (const key of CLI_KEYS) {
		if (!args.has(key)) throw new Error(`missing required argument --${key}`);
	}
	return args;
}

async function requiredBytes(path: string, label: string): Promise<Uint8Array> {
	const file = Bun.file(path);
	if (!(await file.exists()))
		throw new Error(`${label} does not exist: ${path}`);
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.byteLength === 0) throw new Error(`${label} is empty: ${path}`);
	return bytes;
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${String(error)}`);
	}
}

function sha256(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

function siblingCsvPath(artifactPath: string): string {
	return artifactPath.endsWith(".json")
		? `${artifactPath.slice(0, -".json".length)}.csv`
		: `${artifactPath}.csv`;
}

export async function runG6EvaluatorCli(argv: string[]): Promise<number> {
	try {
		const args = parseCliArgs(argv);
		const arg = (key: string) => requiredValue(args.get(key), `CLI --${key}`);
		const artifactPath = arg("artifact");
		const csvPath = siblingCsvPath(artifactPath);
		const artifactBytes = await requiredBytes(
			artifactPath,
			"bench-g6 artifact",
		);
		const csvBytes = await requiredBytes(csvPath, "bench-g6 CSV");
		const downBytes = await requiredBytes(
			arg("preflight-down"),
			"R-down preflight",
		);
		const upBytes = await requiredBytes(arg("preflight-up"), "R-up preflight");
		const floorBytes = await requiredBytes(arg("floor"), "floor transcript");
		const sinkBytes = await requiredBytes(arg("sink"), "sink precheck");
		const expectedCandidate = arg("expected-candidate");
		const expectedGeneratorHost = arg("expected-generator-host");
		const expectedPreregistrationSha256 = arg(
			"expected-preregistration-sha256",
		);
		if (!/^[0-9a-f]{40}$/.test(expectedCandidate)) {
			throw new Error("--expected-candidate must be lowercase 40-hex");
		}
		if (!/^[0-9a-f]{64}$/.test(expectedPreregistrationSha256)) {
			throw new Error(
				"--expected-preregistration-sha256 must be lowercase 64-hex",
			);
		}
		if (
			canonicalGeneratorIdentity(expectedGeneratorHost) !==
			expectedGeneratorHost
		) {
			throw new Error(
				"--expected-generator-host must be the canonical short hostname",
			);
		}
		const repoRoot = resolve(import.meta.dir, "../..");
		const trackedPreregistrationBytes = await requiredBytes(
			resolve(repoRoot, G6_CLOSEOUT_SPEC_PATH),
			"tracked G6 preregistration",
		);
		const git = Bun.spawnSync({
			cmd: ["git", "rev-parse", "HEAD"],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (git.exitCode !== 0) {
			throw new Error(
				`could not resolve grader SHA: ${new TextDecoder().decode(git.stderr).trim()}`,
			);
		}
		const graderSha = new TextDecoder().decode(git.stdout).trim();
		if (!/^[0-9a-f]{40}$/.test(graderSha)) {
			throw new Error(`git returned malformed grader SHA '${graderSha}'`);
		}
		const result = evaluateG6({
			artifact: decodeJson(artifactBytes, "bench-g6 artifact"),
			artifactCsvPresent: csvBytes.byteLength > 0,
			preflightDown: decodeJson(downBytes, "R-down preflight"),
			preflightUp: decodeJson(upBytes, "R-up preflight"),
			floorTranscript: new TextDecoder().decode(floorBytes),
			sink: decodeJson(sinkBytes, "sink precheck"),
			expectedCandidate,
			expectedGeneratorHost,
			expectedPreregistrationSha256,
			trackedPreregistrationSha256: sha256(trackedPreregistrationBytes),
			graderSha,
			inputSha256: {
				artifactJson: sha256(artifactBytes),
				artifactCsv: sha256(csvBytes),
				preflightDown: sha256(downBytes),
				preflightUp: sha256(upBytes),
				floor: sha256(floorBytes),
				sink: sha256(sinkBytes),
			},
		});
		await Bun.write(arg("out"), `${JSON.stringify(result, null, 2)}\n`);
		return result.final.valid &&
			(result.final.gate === "PASS" || result.final.gate === "MISS")
			? 0
			: 2;
	} catch (error) {
		console.error(
			`g6-evaluate: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 3;
	}
}

if (import.meta.main) {
	process.exit(await runG6EvaluatorCli(process.argv.slice(2)));
}
