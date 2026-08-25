import {
	actionEveryNthTick,
	armShape,
	exactStaggeredWindowDue,
	exactTicksDueAfter,
	GATE_CLIENT_ENDPOINTS,
	G6_CLOSEOUT_SPEC_ID,
	G6_CLOSEOUT_SPEC_PATH,
	MOVE_HZ,
	SNAPSHOT_HZ,
	SNAPSHOT_PAYLOAD_BYTES,
	UPSTREAM_PAYLOAD_BYTES,
} from "./g6-plan.ts";
import { REGISTERED_G6_SERVER_CORE_PLAN } from "./g6-server-core.ts";
import {
	DEFAULT_LIMITS,
	DEFAULT_RATE_LIMITS,
	type LimitsOptions,
	type RateLimitOptions,
} from "../../packages/webtransport/src/index.ts";

export const G6_ATTRIBUTION_SCHEMA = "g6-attribution/1";

export type AttributionLane = "full-js" | "minimal-js-addon" | "direct-rust";

export type AttributionPreRegistration = {
	id: string;
	path: string;
	sha256: string;
};

export type SharedAttributionPlan = Readonly<{
	sessions: number;
	durationSec: number;
	movePps: number;
	actionPps: number;
	actionEveryNthTick: number;
	upstreamPayloadBytes: number;
	upstreamAggregatePps: number;
	snapshotHz: number;
	snapshotDatagrams: number;
	snapshotPayloadBytes: number;
	snapshotAggregatePps: number;
	ackAggregatePps: number;
	emitterSliceHz: number;
	expectedMoveDue: number;
	expectedSnapshotDue: number;
	expectedAckDue: number;
}>;

export type AttributionServerLimits = Readonly<
	Pick<
		LimitsOptions,
		| "maxSessions"
		| "maxHandshakesInFlight"
		| "maxStreamsPerSessionBidi"
		| "maxStreamsPerSessionUni"
		| "maxStreamsGlobal"
		| "maxDatagramSize"
		| "maxQueuedBytesPerSession"
		| "maxQueuedBytesPerStream"
		| "idleTimeoutMs"
	>
>;

export type AttributionServerRateLimits = Readonly<
	Required<
		Pick<
			RateLimitOptions,
			| "handshakesPerSec"
			| "handshakesBurst"
			| "handshakesBurstPerPrefix"
			| "streamsPerSec"
			| "streamsBurst"
			| "datagramsPerSec"
			| "datagramsBurst"
		>
	>
>;

export type AttributionServerSettings = Readonly<{
	limits: AttributionServerLimits;
	rateLimits: AttributionServerRateLimits;
}>;

export type AttributionSwitchVector = {
	recordClauseLatencyHistograms: boolean;
	retainPerDatagramDiagnosticSamples: boolean;
	emitVerboseProgressLogs: boolean;
	materializeHumanReadableRows: boolean;
};

export type LaneContract = Readonly<{
	lane: AttributionLane;
	runtimeFamily: "js-addon" | "direct-rust";
	serverPlan: {
		snapshotPayloadBytes: number;
		snapshotDatagrams: number;
		snapshotHz: number;
		emitterSliceHz: number;
		sliceMs: number;
		slicesPerTick: number;
	};
	decodeStamps: true;
	reflectsActionAcks: true;
	freshSnapshotAllocation: true;
	usesBatchSendForSnapshots: true;
	emitterScheduleLagEnabled: true;
	rawConnectionStageCounters: true;
	perClassCounters: true;
	switches: AttributionSwitchVector | null;
}>;

export type AttributionIdentityLeg = {
	lane: AttributionLane;
	orderIndex: number;
	preRegistration: AttributionPreRegistration;
	candidateSha: string;
	clientBinarySha256: string;
	hostIdentity: string;
	tlsCertSha256: string;
	sessions: number;
	durationSec: number;
	upstreamPayloadBytes: number;
	movePps: number;
	actionPps: number;
	actionEveryNthTick: number;
	snapshotDatagrams: number;
	snapshotPayloadBytes: number;
	snapshotHz: number;
	emitterSliceHz: number;
	expectedMoveDue: number;
	expectedSnapshotDue: number;
	expectedAckDue: number;
	clientOfferedRatio: number;
	clientScheduleLagNegative: number;
	serverEmitterLagNegative: number;
	phaseMarkers: string[];
	sendErrors: number;
	unclassifiedDatagrams: number;
	rateLimitedDelta: number;
	limitExceededDelta: number;
	clientScheduleTicksDue: number;
	clientEndpoints: number;
	serverSnapshotDue: number;
	serverAckDue: number;
	comparableStageMismatchPct: number;
	issuedRatio: number;
	measurements: AttributionRequiredMeasurements;
	serverSettings: AttributionServerSettings;
};

export type AttributionMeasurementWindow = {
	kind: "steady";
	startPhase: "steady";
	endPhase: "drain";
	wallMs: number;
	synchronized: boolean;
};

export type AttributionScalarMeasurementUnit =
	| "cpu-ms"
	| "host-cpu-pct"
	| "rss-mib";

export type AttributionScalarMeasurement = {
	unit: AttributionScalarMeasurementUnit;
	value: number | null;
};

export type AttributionRawStagesMeasurement = {
	datagramFrameUnit: "quic-datagram-frames";
	udpDatagramUnit: "udp-datagrams";
	datagramFramesSent: number | null;
	datagramFramesReceived: number | null;
	udpDatagramsSent: number | null;
	udpDatagramsReceived: number | null;
	capturedBeforeTeardown: boolean;
};

export type AttributionRequiredMeasurements = {
	window: AttributionMeasurementWindow;
	serverProcessCpu: AttributionScalarMeasurement;
	clientProcessCpu: AttributionScalarMeasurement;
	hostCpu: AttributionScalarMeasurement;
	serverRss: AttributionScalarMeasurement;
	clientRss: AttributionScalarMeasurement;
	rawStages: AttributionRawStagesMeasurement;
};

type ValidationResult = {
	valid: boolean;
	reasons: string[];
};

function exactMoveDue(
	sessions: number,
	durationSec: number,
	movePps: number,
): number {
	if (sessions <= 0 || movePps <= 0) return 0;
	return exactStaggeredWindowDue({
		durationSec,
		intervalSec: 1 / movePps,
		totalSessions: sessions,
		startIndex: 0,
		count: sessions,
	});
}

function exactAckDue(
	sessions: number,
	durationSec: number,
	movePps: number,
	actionEvery: number,
): number {
	if (actionEvery <= 0) return 0;
	const intervalSec = 1 / movePps;
	let total = 0;
	for (let index = 0; index < sessions; index += 1) {
		total += Math.floor(
			exactTicksDueAfter(durationSec, intervalSec, index / sessions) /
				actionEvery,
		);
	}
	return total;
}

export function buildSharedAttributionPlan(
	sessions = 5000,
	durationSec = 120,
): SharedAttributionPlan {
	const shape = armShape(sessions);
	const expectedMoveDue = exactMoveDue(sessions, durationSec, MOVE_HZ);
	const expectedAckDue = exactAckDue(
		sessions,
		durationSec,
		MOVE_HZ,
		actionEveryNthTick(),
	);
	return Object.freeze({
		sessions,
		durationSec,
		movePps: MOVE_HZ,
		actionPps: shape.ackAggregatePps / sessions,
		actionEveryNthTick: actionEveryNthTick(),
		upstreamPayloadBytes: UPSTREAM_PAYLOAD_BYTES,
		upstreamAggregatePps: shape.upstreamAggregatePps,
		snapshotHz: SNAPSHOT_HZ,
		snapshotDatagrams: REGISTERED_G6_SERVER_CORE_PLAN.snapshotDatagrams,
		snapshotPayloadBytes: SNAPSHOT_PAYLOAD_BYTES,
		snapshotAggregatePps: shape.snapshotAggregatePps,
		ackAggregatePps: shape.ackAggregatePps,
		emitterSliceHz: REGISTERED_G6_SERVER_CORE_PLAN.emitterSliceHz,
		expectedMoveDue,
		expectedSnapshotDue: shape.snapshotAggregatePps * durationSec,
		expectedAckDue,
	});
}

export function buildBalancedLaneOrder(): AttributionLane[][] {
	return [
		["full-js", "minimal-js-addon", "direct-rust"],
		["minimal-js-addon", "direct-rust", "full-js"],
		["direct-rust", "full-js", "minimal-js-addon"],
	];
}

export function buildSharedAttributionServerSettings(
	sessions: number,
): AttributionServerSettings {
	const topSessions = Math.max(64, sessions + 8);
	return Object.freeze({
		limits: Object.freeze({
			maxSessions: topSessions * 2,
			maxHandshakesInFlight: topSessions * 2,
			maxStreamsPerSessionBidi: DEFAULT_LIMITS.maxStreamsPerSessionBidi,
			maxStreamsPerSessionUni: DEFAULT_LIMITS.maxStreamsPerSessionUni,
			maxStreamsGlobal: DEFAULT_LIMITS.maxStreamsGlobal,
			maxDatagramSize: REGISTERED_G6_SERVER_CORE_PLAN.snapshotPayloadBytes + 64,
			maxQueuedBytesPerSession: DEFAULT_LIMITS.maxQueuedBytesPerSession,
			maxQueuedBytesPerStream: DEFAULT_LIMITS.maxQueuedBytesPerStream,
			idleTimeoutMs: 300_000,
		}),
		rateLimits: Object.freeze({
			handshakesPerSec: topSessions * 2,
			handshakesBurst: topSessions * 2,
			handshakesBurstPerPrefix: topSessions * 2,
			streamsPerSec: 1000,
			streamsBurst: 2000,
			datagramsPerSec: Math.max(sessions * 64, 200_000),
			datagramsBurst: Math.max(sessions * 128, 400_000),
		}),
	});
}

function fullSwitchVector(): AttributionSwitchVector {
	return {
		recordClauseLatencyHistograms: true,
		retainPerDatagramDiagnosticSamples: true,
		emitVerboseProgressLogs: true,
		materializeHumanReadableRows: true,
	};
}

function minimalSwitchVector(): AttributionSwitchVector {
	return {
		recordClauseLatencyHistograms: false,
		retainPerDatagramDiagnosticSamples: false,
		emitVerboseProgressLogs: false,
		materializeHumanReadableRows: false,
	};
}

export function buildLaneContract(lane: AttributionLane): LaneContract {
	const shared = {
		serverPlan: {
			snapshotPayloadBytes: REGISTERED_G6_SERVER_CORE_PLAN.snapshotPayloadBytes,
			snapshotDatagrams: REGISTERED_G6_SERVER_CORE_PLAN.snapshotDatagrams,
			snapshotHz: REGISTERED_G6_SERVER_CORE_PLAN.snapshotHz,
			emitterSliceHz: REGISTERED_G6_SERVER_CORE_PLAN.emitterSliceHz,
			sliceMs: REGISTERED_G6_SERVER_CORE_PLAN.sliceMs,
			slicesPerTick: REGISTERED_G6_SERVER_CORE_PLAN.slicesPerTick,
		},
		decodeStamps: true as const,
		reflectsActionAcks: true as const,
		freshSnapshotAllocation: true as const,
		usesBatchSendForSnapshots: true as const,
		emitterScheduleLagEnabled: true as const,
		rawConnectionStageCounters: true as const,
		perClassCounters: true as const,
	};
	if (lane === "full-js") {
		return Object.freeze({
			lane,
			runtimeFamily: "js-addon",
			...shared,
			switches: fullSwitchVector(),
		});
	}
	if (lane === "minimal-js-addon") {
		return Object.freeze({
			lane,
			runtimeFamily: "js-addon",
			...shared,
			switches: minimalSwitchVector(),
		});
	}
	return Object.freeze({
		lane,
		runtimeFamily: "direct-rust",
		...shared,
		switches: null,
	});
}

function compareUnknown(
	path: string,
	left: unknown,
	right: unknown,
	reasons: string[],
): void {
	if (
		typeof left === "object" &&
		left !== null &&
		typeof right === "object" &&
		right !== null &&
		!Array.isArray(left) &&
		!Array.isArray(right)
	) {
		const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
		for (const key of keys) {
			compareUnknown(
				path ? `${path}.${key}` : key,
				(left as Record<string, unknown>)[key],
				(right as Record<string, unknown>)[key],
				reasons,
			);
		}
		return;
	}
	if (left !== right) {
		reasons.push(`minimal-js-addon contract mismatch at ${path}`);
	}
}

function sameServerSettings(
	leg: AttributionIdentityLeg,
	settings: AttributionServerSettings,
	reasons: string[],
): void {
	if (!leg.serverSettings) {
		reasons.push(`${leg.lane} missing shared immutable server settings`);
		return;
	}
	const compare = (
		path: string,
		left: Record<string, number>,
		right: Record<string, number>,
	) => {
		for (const key of Object.keys(right)) {
			if (left[key] !== right[key]) {
				reasons.push(
					`${leg.lane} ${path}.${key} drifted from the shared immutable server settings`,
				);
			}
		}
	};
	compare(
		"serverSettings.limits",
		leg.serverSettings.limits as Record<string, number>,
		settings.limits as Record<string, number>,
	);
	compare(
		"serverSettings.rateLimits",
		leg.serverSettings.rateLimits as Record<string, number>,
		settings.rateLimits as Record<string, number>,
	);
}

export function validateMinimalJsAddonContract(
	full: LaneContract,
	minimal: LaneContract,
): ValidationResult {
	const reasons: string[] = [];
	if (full.lane !== "full-js") {
		reasons.push(
			"minimal-js-addon contract requires full-js as the reference lane",
		);
	}
	if (minimal.lane !== "minimal-js-addon") {
		reasons.push(
			"minimal-js-addon contract requires minimal-js-addon as the compared lane",
		);
	}
	const fullWithoutSwitches = { ...full, switches: undefined, lane: undefined };
	const minimalWithoutSwitches = {
		...minimal,
		switches: undefined,
		lane: undefined,
	};
	compareUnknown("", fullWithoutSwitches, minimalWithoutSwitches, reasons);
	const expectedMinimal = minimalSwitchVector();
	compareUnknown("switches", minimal.switches, expectedMinimal, reasons);
	compareUnknown("switches", full.switches, fullSwitchVector(), reasons);
	return { valid: reasons.length === 0, reasons };
}

function sameWorkloadShape(
	anchor: AttributionIdentityLeg,
	leg: AttributionIdentityLeg,
	reasons: string[],
): void {
	const exactChecks: Array<[keyof AttributionIdentityLeg, string]> = [
		["candidateSha", "candidate sha drifted"],
		["clientBinarySha256", "client binary drifted"],
		["hostIdentity", "host identity drifted"],
		["tlsCertSha256", "TLS cert sha drifted"],
		["sessions", "session count drifted"],
		["durationSec", "duration drifted"],
		["upstreamPayloadBytes", "payload bytes drifted"],
		["movePps", "move cadence drifted"],
		["actionPps", "action cadence drifted"],
		["actionEveryNthTick", "action schedule drifted"],
		["snapshotDatagrams", "snapshot shape drifted"],
		["snapshotPayloadBytes", "snapshot payload drifted"],
		["snapshotHz", "snapshot cadence drifted"],
		["emitterSliceHz", "emitter slice cadence drifted"],
		["expectedMoveDue", "expected move due drifted"],
		["expectedSnapshotDue", "expected snapshot due drifted"],
		["expectedAckDue", "expected ack due drifted"],
	];
	for (const [key, message] of exactChecks) {
		if (leg[key] !== anchor[key]) {
			reasons.push(`${leg.lane} ${message}`);
		}
	}
	if (
		leg.preRegistration.id !== anchor.preRegistration.id ||
		leg.preRegistration.path !== anchor.preRegistration.path ||
		leg.preRegistration.sha256 !== anchor.preRegistration.sha256
	) {
		reasons.push(`${leg.lane} preregistration identity drifted`);
	}
}

function missingMarkers(markers: string[]): string[] {
	const required = ["steady", "drain", "idle", "stop"];
	return required.filter((marker) => !markers.includes(marker));
}

function nearlyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function validateScalarMeasurement(
	leg: AttributionIdentityLeg,
	label:
		| "serverProcessCpu"
		| "clientProcessCpu"
		| "hostCpu"
		| "serverRss"
		| "clientRss",
	expectedUnit: AttributionScalarMeasurementUnit,
	reasons: string[],
): void {
	const measurement = leg.measurements[label];
	if (
		!measurement ||
		measurement.value === null ||
		!Number.isFinite(measurement.value)
	) {
		reasons.push(`${leg.lane} required measurements missing ${label}`);
		return;
	}
	if (measurement.value < 0) {
		reasons.push(`${leg.lane} required measurements ${label} was negative`);
	}
	if (measurement.unit !== expectedUnit) {
		reasons.push(
			`${leg.lane} required measurements ${label} used ${measurement.unit} instead of ${expectedUnit}`,
		);
	}
}

function validateRequiredMeasurements(
	leg: AttributionIdentityLeg,
	reasons: string[],
): void {
	const expectedWallMs = leg.durationSec * 1000;
	const window = leg.measurements?.window;
	if (
		!window ||
		window.kind !== "steady" ||
		window.startPhase !== "steady" ||
		window.endPhase !== "drain" ||
		!window.synchronized
	) {
		reasons.push(
			`${leg.lane} required measurements window was not synchronized to steady->drain`,
		);
	} else if (!nearlyEqual(window.wallMs, expectedWallMs)) {
		reasons.push(
			`${leg.lane} required measurements window ${window.wallMs}ms did not match planned ${expectedWallMs}ms`,
		);
	}
	validateScalarMeasurement(leg, "serverProcessCpu", "cpu-ms", reasons);
	validateScalarMeasurement(leg, "clientProcessCpu", "cpu-ms", reasons);
	validateScalarMeasurement(leg, "hostCpu", "host-cpu-pct", reasons);
	validateScalarMeasurement(leg, "serverRss", "rss-mib", reasons);
	validateScalarMeasurement(leg, "clientRss", "rss-mib", reasons);
	const rawStages = leg.measurements?.rawStages;
	if (!rawStages) {
		reasons.push(`${leg.lane} required measurements missing rawStages`);
		return;
	}
	if (rawStages.datagramFrameUnit !== "quic-datagram-frames") {
		reasons.push(
			`${leg.lane} required measurements rawStages.datagramFrameUnit used ${rawStages.datagramFrameUnit} instead of quic-datagram-frames`,
		);
	}
	if (rawStages.udpDatagramUnit !== "udp-datagrams") {
		reasons.push(
			`${leg.lane} required measurements rawStages.udpDatagramUnit used ${rawStages.udpDatagramUnit} instead of udp-datagrams`,
		);
	}
	for (const key of [
		"datagramFramesSent",
		"datagramFramesReceived",
		"udpDatagramsSent",
		"udpDatagramsReceived",
	] as const) {
		const value = rawStages[key];
		if (value === null || !Number.isFinite(value)) {
			reasons.push(
				`${leg.lane} required measurements missing rawStages.${key}`,
			);
			continue;
		}
		if (value < 0) {
			reasons.push(
				`${leg.lane} required measurements rawStages.${key} was negative`,
			);
		}
	}
	if (!rawStages.capturedBeforeTeardown) {
		reasons.push(
			`${leg.lane} required measurements rawStages were captured after teardown`,
		);
	}
}

export function validateAttributionIdentity(
	legs: AttributionIdentityLeg[],
): ValidationResult {
	const reasons: string[] = [];
	const [anchor] = legs;
	if (!anchor)
		return { valid: false, reasons: ["no attribution legs supplied"] };
	for (const leg of legs) {
		sameWorkloadShape(anchor, leg, reasons);
		sameServerSettings(
			leg,
			buildSharedAttributionServerSettings(leg.sessions),
			reasons,
		);
		validateRequiredMeasurements(leg, reasons);
		if (leg.clientOfferedRatio < 0.99) {
			reasons.push(
				`${leg.lane} client offered ratio ${leg.clientOfferedRatio.toFixed(6)} is below 0.99`,
			);
		}
		if (leg.clientScheduleLagNegative > 0 || leg.serverEmitterLagNegative > 0) {
			reasons.push(`${leg.lane} reported negative schedule lag samples`);
		}
		const missing = missingMarkers(leg.phaseMarkers);
		if (missing.length > 0) {
			reasons.push(`${leg.lane} phase markers missing ${missing.join(",")}`);
		}
		if (leg.sendErrors > 0) reasons.push(`${leg.lane} recorded send errors`);
		if (leg.unclassifiedDatagrams > 0) {
			reasons.push(`${leg.lane} recorded unclassified datagrams`);
		}
		if (leg.rateLimitedDelta > 0 || leg.limitExceededDelta > 0) {
			reasons.push(`${leg.lane} rate/limit counters changed`);
		}
		if (!nearlyEqual(leg.clientScheduleTicksDue, leg.expectedMoveDue)) {
			reasons.push(`${leg.lane} client schedule due did not match armShape`);
		}
		if (leg.clientEndpoints !== GATE_CLIENT_ENDPOINTS) {
			reasons.push(
				`${leg.lane} client ran ${leg.clientEndpoints} endpoints, the gate's registered client uses ${GATE_CLIENT_ENDPOINTS}`,
			);
		}
		if (!nearlyEqual(leg.serverSnapshotDue, leg.expectedSnapshotDue)) {
			reasons.push(`${leg.lane} snapshot due did not match armShape`);
		}
		if (!nearlyEqual(leg.serverAckDue, leg.expectedAckDue)) {
			reasons.push(`${leg.lane} ack due did not match armShape`);
		}
		if (leg.comparableStageMismatchPct > 0.001) {
			reasons.push(
				`${leg.lane} comparable raw-stage mismatch ${(leg.comparableStageMismatchPct * 100).toFixed(3)}% exceeded 0.100%`,
			);
		}
	}
	return { valid: reasons.length === 0, reasons };
}

export function evaluateAttributionOutcome(input: {
	identity: ValidationResult;
	legs: AttributionIdentityLeg[];
	commonThroughputReplay: {
		passed: boolean;
		issuedRatioFloor: number;
		issuedRatioCeiling: number;
	} | null;
}): ValidationResult & { cpuAttributionAllowed: boolean } {
	if (!input.identity.valid) {
		return {
			valid: false,
			reasons: [...input.identity.reasons],
			cpuAttributionAllowed: false,
		};
	}
	if (input.legs.length === 0) {
		return {
			valid: false,
			reasons: ["no attribution legs supplied"],
			cpuAttributionAllowed: false,
		};
	}
	const ratios = input.legs.map((leg) => leg.issuedRatio);
	const spread = Math.max(...ratios) - Math.min(...ratios);
	if (spread > 0.005 && !input.commonThroughputReplay?.passed) {
		return {
			valid: true,
			cpuAttributionAllowed: false,
			reasons: [
				`pairwise issued parity diverged by ${(spread * 100).toFixed(3)}% at target shape; retain capacity result but suppress CPU attribution until a common-throughput replay passes`,
			],
		};
	}
	return { valid: true, cpuAttributionAllowed: true, reasons: [] };
}

export function defaultPreRegistration(
	sha256: string,
): AttributionPreRegistration {
	return {
		id: G6_CLOSEOUT_SPEC_ID,
		path: G6_CLOSEOUT_SPEC_PATH,
		sha256,
	};
}
