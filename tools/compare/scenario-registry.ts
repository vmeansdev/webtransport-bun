import { canonicalJson, sha256Canonical } from "./canonical.ts";
import {
	SCENARIO_IDS as FROZEN_SCENARIO_IDS,
	type AiTokenParameters,
	type ArmKind,
	type ArmTransport,
	type BulkParameters,
	type CapacityProfile,
	type ChatParameters,
	type ConnectionMemoryParameters,
	type ConnectionSetup,
	type CrdtParameters,
	type DiagnosticParameterValue,
	type DiagnosticScenarioParameters,
	type GameParameters,
	type HandshakeParameters,
	type LinuxRole,
	type MacRole,
	type MacRoleSpec,
	type ProcessCohort,
	type ReconnectParameters,
	type RolePlan,
	type RunPolicy,
	type ScenarioArm,
	type ScenarioCell,
	type ScenarioId,
	type ScenarioOverride,
	type ScenarioRegistry,
	type RuntimeScenarioParameters,
	type ShardingPlan,
	type TailParameters,
	type TickerParameters,
	type TrafficDirection,
	type WorkerShard,
} from "./types.ts";

export {
	SCENARIO_IDS,
	type ScenarioArm,
	type ScenarioCell,
	type ScenarioId,
	type ScenarioOverride,
	type ScenarioRegistry,
} from "./types.ts";

export const CANONICAL_CAPACITY_PROFILE: CapacityProfile = Object.freeze({
	profileId: "capacity-v1",
	maxSessions: 12_000,
	maxHandshakesInFlight: 512,
	maxStreamsPerSessionBidi: 8,
	maxStreamsPerSessionUni: 8,
	maxStreamsGlobal: 24_000,
	maxDatagramSize: 1_200,
	maxQueuedBytesGlobal: 536_870_912,
	maxQueuedBytesPerSession: 2_097_152,
	maxQueuedBytesPerStream: 262_144,
	backpressureTimeoutMs: 5_000,
	handshakeTimeoutMs: 10_000,
	idleTimeoutMs: 60_000,
	handshakesPerSec: 20_000,
	handshakesBurst: 20_000,
	handshakesBurstPerPrefix: 20_000,
	streamsPerSec: 20_000,
	streamsBurst: 20_000,
	datagramsPerSec: 20_000,
	datagramsBurst: 20_000,
});

export const CANONICAL_CONNECTION_SETUP: ConnectionSetup = Object.freeze({
	connectionRampPerSecond: 500,
	maxConnectsInFlight: 200,
});

const CAPACITY_PROFILE_HASH = sha256Canonical(CANONICAL_CAPACITY_PROFILE);
const SCENARIO_SCHEMA_VERSION = "v1" as const;

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child);
	}
	return value;
}

function persistentCohort(): ProcessCohort {
	return {
		kind: "persistent",
		processes: 1,
		primeBeforeMeasurement: false,
		measuredCycles: 1,
	};
}

function freshChildCohort(measuredCycles: number): ProcessCohort {
	return {
		kind: "fresh-child-per-cycle",
		processes: 1,
		primeBeforeMeasurement: false,
		measuredCycles,
	};
}

function warmProcessCohort(measuredCycles: number): ProcessCohort {
	return {
		kind: "fresh-100-process-cohort-per-repetition",
		processes: 100,
		primeBeforeMeasurement: true,
		measuredCycles,
	};
}

function roundRobinSharding(role: MacRole, count: number): ShardingPlan {
	const shards: WorkerShard[] = Array.from({ length: 8 }, (_, workerIndex) => ({
		workerIndex,
		clientIds: [],
	}));
	for (let clientId = 0; clientId < count; clientId += 1) {
		const workerIndex = clientId % shards.length;
		const shard = shards[workerIndex];
		if (!shard) throw new Error(`missing shard ${workerIndex}`);
		shards[workerIndex] = {
			...shard,
			clientIds: [...shard.clientIds, clientId],
		};
	}
	return {
		workerCount: 8,
		strategy: "round-robin",
		role,
		shards,
	};
}

function lifecycleSharding(
	role: MacRole,
	strategy: "fresh-child-per-cycle" | "fresh-process-cohort",
): ShardingPlan {
	return {
		workerCount: 100,
		strategy,
		role,
		shards: [],
	};
}

function singleProcessSharding(role: MacRole): ShardingPlan {
	return {
		workerCount: 1,
		strategy: "single-process",
		role,
		shards: [{ workerIndex: 0, clientIds: [0] }],
	};
}

function role(
	macRoles: readonly MacRoleSpec[],
	linuxRole: LinuxRole,
	direction: TrafficDirection,
	channels: readonly string[],
	sharding: ShardingPlan,
	processCohort: ProcessCohort = persistentCohort(),
): RolePlan {
	return {
		macRoles,
		linuxRole,
		direction,
		channels,
		sharding,
		processCohort,
	};
}

function shardedRole(roleName: MacRole, count: number): ShardingPlan {
	return roundRobinSharding(roleName, count);
}

const LONG_RUN_POLICY: RunPolicy = Object.freeze({
	classification: "long",
	warmupRepetitions: 1,
	measuredRepetitions: 5,
});

const SHORT_RUN_POLICY: RunPolicy = Object.freeze({
	classification: "short",
	warmupRepetitions: 3,
	measuredRepetitions: 15,
});

function buildCell<T extends RuntimeScenarioParameters>(
	cellId: string,
	parameters: T,
	rolePlan: RolePlan,
	runPolicy: RunPolicy,
	canonical: boolean,
): ScenarioCell {
	const payload = {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		cellId,
		scenarioId: parameters.scenarioId,
		parameters,
		rolePlan,
		connectionSetup: CANONICAL_CONNECTION_SETUP,
		capacityProfileHash: CAPACITY_PROFILE_HASH,
		runPolicy,
	};
	return deepFreeze({
		...payload,
		canonical,
		scenarioHash: sha256Canonical(payload),
	});
}

function chatCell(subscriberCount: 1_000 | 5_000 | 10_000): ScenarioCell {
	const parameters: ChatParameters = {
		scenarioId: "chat-fanout",
		subscriberCount,
		publisherCount: 10,
		messageBytes: 128,
		messagesPerSecondPerPublisher: 1,
		durationSeconds: 30,
		delivery: "reliable",
	};
	return buildCell(
		`chat-fanout/subscribers-${subscriberCount}`,
		parameters,
		role(
			[
				{ role: "publisher", count: 10, processModel: "dedicated" },
				{ role: "subscriber", count: subscriberCount, processModel: "sharded" },
			],
			"reliable-relay",
			"mac-to-linux-to-mac",
			["publisher-bidi", "server-opened-subscriber-uni"],
			shardedRole("subscriber", subscriberCount),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function tickerCell(
	ingressRatePerSecond: 10_000 | 50_000 | 100_000,
): ScenarioCell {
	const parameters: TickerParameters = {
		scenarioId: "ticker-fanout",
		ingressRatePerSecond,
		publisherCount: 1,
		subscriberCount: 100,
		recordBytes: 100,
		fanout: 100,
		durationSeconds: 10,
		delivery: "reliable",
	};
	return buildCell(
		`ticker-fanout/rate-${ingressRatePerSecond}`,
		parameters,
		role(
			[
				{ role: "publisher", count: 1, processModel: "dedicated" },
				{ role: "subscriber", count: 100, processModel: "sharded" },
			],
			"reliable-relay",
			"mac-to-linux-to-mac",
			["publisher-bidi", "server-opened-subscriber-uni"],
			shardedRole("subscriber", 100),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function gameCell(
	tickHz: 20 | 60,
	lossPercent: 1 | 2.5 | 5,
	delayMs: 20 | 40,
): ScenarioCell {
	const parameters: GameParameters = {
		scenarioId: "game-tick-loss",
		tickHz,
		tickBytes: 64,
		receiverCount: 100,
		publisherCount: 1,
		durationSeconds: 30,
		lossPercent,
		delayMs,
		delivery: "latest-state",
	};
	return buildCell(
		`game-tick-loss/tick-${tickHz}-loss-${lossPercent}-delay-${delayMs}`,
		parameters,
		role(
			[
				{ role: "publisher", count: 1, processModel: "dedicated" },
				{ role: "receiver", count: 100, processModel: "sharded" },
			],
			"datagram-relay",
			"mac-to-linux-to-mac",
			["publisher-datagram", "receiver-datagram"],
			shardedRole("receiver", 100),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function reconnectCell(state: "cold-full" | "warm-after-prime"): ScenarioCell {
	const parameters: ReconnectParameters = {
		scenarioId: "reconnect-storm",
		state,
		clientCount: 100,
		reconnectCycles: 10,
		concurrency: 100,
		firstMessageBytes: 32,
		acknowledged: true,
	};
	const warm = state === "warm-after-prime";
	return buildCell(
		`reconnect-storm/${state}`,
		parameters,
		role(
			[{ role: "reconnecting-client", count: 100, processModel: "cohort" }],
			"acknowledger",
			"mac-to-linux",
			["request-ack"],
			lifecycleSharding(
				"reconnecting-client",
				warm ? "fresh-process-cohort" : "fresh-child-per-cycle",
			),
			warm ? warmProcessCohort(10) : freshChildCohort(10),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function connectionMemoryCell(
	liveConnections: 1_000 | 5_000 | 10_000,
): ScenarioCell {
	const parameters: ConnectionMemoryParameters = {
		scenarioId: "connection-memory",
		liveConnections,
		holdSeconds: 30,
		pooling: false,
	};
	return buildCell(
		`connection-memory/live-${liveConnections}`,
		parameters,
		role(
			[
				{
					role: "idle-client",
					count: liveConnections,
					processModel: "sharded",
				},
			],
			"accepting-server",
			"mac-to-linux",
			["one-session-per-client"],
			shardedRole("idle-client", liveConnections),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function crdtCell(): ScenarioCell {
	const parameters: CrdtParameters = {
		scenarioId: "crdt-sync",
		clientCount: 100,
		operationBytes: 96,
		operationsPerSecond: 1_000,
		durationSeconds: 60,
		snapshotSchedule: "periodic-canonical",
		delivery: "reliable",
	};
	return buildCell(
		"crdt-sync/default",
		parameters,
		role(
			[{ role: "actor", count: 100, processModel: "sharded" }],
			"reliable-relay",
			"mac-to-linux-to-mac",
			["actor-bidi", "snapshot-reliable"],
			shardedRole("actor", 100),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function aiTokenCell(chunkBytes: 32 | 64 | 128 | 256): ScenarioCell {
	const parameters: AiTokenParameters = {
		scenarioId: "ai-token-stream",
		chunkBytes,
		sessionCount: 100,
		chunksPerSecondPerSession: 50,
		durationSeconds: 30,
		pauseEverySeconds: 5,
		pauseDurationMs: 500,
	};
	return buildCell(
		`ai-token-stream/chunk-${chunkBytes}`,
		parameters,
		role(
			[{ role: "token-receiver", count: 100, processModel: "sharded" }],
			"token-source",
			"linux-to-mac",
			["server-opened-uni"],
			shardedRole("token-receiver", 100),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function handshakeCell(
	path: "physical" | "delay40",
	state: "cold" | "warm-after-prime",
): ScenarioCell {
	const parameters: HandshakeParameters = {
		scenarioId: "handshake-matrix",
		path,
		state,
		clientCount: 100,
		measuredConnectionsPerWorker: 1,
	};
	const warm = state === "warm-after-prime";
	return buildCell(
		`handshake-matrix/${path}-${state}`,
		parameters,
		role(
			[{ role: "connection-initiator", count: 100, processModel: "cohort" }],
			"acknowledger",
			"mac-to-linux",
			["connect-first-ack"],
			lifecycleSharding(
				"connection-initiator",
				warm ? "fresh-process-cohort" : "fresh-child-per-cycle",
			),
			warm ? warmProcessCohort(1) : freshChildCohort(1),
		),
		SHORT_RUN_POLICY,
		true,
	);
}

function bulkCell(path: "physical" | "delay40-loss1"): ScenarioCell {
	const parameters: BulkParameters = {
		scenarioId: "bulk-one-way",
		path,
		bytes: 104_857_600,
		chunkBytes: 65_536,
		delivery: "reliable",
	};
	return buildCell(
		`bulk-one-way/${path}`,
		parameters,
		role(
			[{ role: "sink", count: 1, processModel: "single" }],
			"bulk-source",
			"linux-to-mac",
			["server-opened-uni"],
			singleProcessSharding("sink"),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function tailCell(): ScenarioCell {
	const parameters: TailParameters = {
		scenarioId: "tail-under-cross-traffic",
		controlMessageBytes: 64,
		controlRatePerSecond: 1,
		durationSeconds: 180,
		bulkChunkBytes: 65_536,
		bulkRateMbps: 700,
		acknowledged: true,
	};
	return buildCell(
		"tail-under-cross-traffic/default",
		parameters,
		role(
			[
				{ role: "sink", count: 1, processModel: "single" },
				{ role: "control-initiator", count: 1, processModel: "dedicated" },
			],
			"bulk-source-and-acknowledger",
			"bidirectional",
			["server-opened-uni-bulk", "control-bidi"],
			singleProcessSharding("sink"),
		),
		LONG_RUN_POLICY,
		true,
	);
}

function buildCanonicalCells(): ScenarioCell[] {
	const cells: ScenarioCell[] = [];
	for (const subscriberCount of [1_000, 5_000, 10_000] as const) {
		cells.push(chatCell(subscriberCount));
	}
	for (const rate of [10_000, 50_000, 100_000] as const) {
		cells.push(tickerCell(rate));
	}
	for (const tickHz of [20, 60] as const) {
		for (const lossPercent of [1, 2.5, 5] as const) {
			for (const delayMs of [20, 40] as const) {
				cells.push(gameCell(tickHz, lossPercent, delayMs));
			}
		}
	}
	cells.push(reconnectCell("cold-full"));
	cells.push(reconnectCell("warm-after-prime"));
	for (const liveConnections of [1_000, 5_000, 10_000] as const) {
		cells.push(connectionMemoryCell(liveConnections));
	}
	cells.push(crdtCell());
	for (const chunkBytes of [32, 64, 128, 256] as const) {
		cells.push(aiTokenCell(chunkBytes));
	}
	for (const path of ["physical", "delay40"] as const) {
		for (const state of ["cold", "warm-after-prime"] as const) {
			cells.push(handshakeCell(path, state));
		}
	}
	for (const path of ["physical", "delay40-loss1"] as const) {
		cells.push(bulkCell(path));
	}
	cells.push(tailCell());
	return cells;
}

const CANONICAL_CELLS = Object.freeze(buildCanonicalCells());

const KNOWN_OVERRIDE_FIELDS = new Set([
	"subscriberCount",
	"publisherCount",
	"messageBytes",
	"messagesPerSecondPerPublisher",
	"durationSeconds",
	"ingressRatePerSecond",
	"recordBytes",
	"fanout",
	"tickHz",
	"tickBytes",
	"receiverCount",
	"lossPercent",
	"delayMs",
	"state",
	"clientCount",
	"reconnectCycles",
	"concurrency",
	"firstMessageBytes",
	"liveConnections",
	"holdSeconds",
	"pooling",
	"operationBytes",
	"operationsPerSecond",
	"snapshotSchedule",
	"chunkBytes",
	"sessionCount",
	"chunksPerSecondPerSession",
	"pauseEverySeconds",
	"pauseDurationMs",
	"path",
	"bytes",
	"measuredConnectionsPerWorker",
	"controlMessageBytes",
	"controlRatePerSecond",
	"bulkChunkBytes",
	"bulkRateMbps",
]);

const INTEGER_FIELD_LIMITS: Readonly<Record<string, number>> = {
	subscriberCount: 12_000,
	publisherCount: 12_000,
	messageBytes: 1_048_576,
	messagesPerSecondPerPublisher: 1_000_000,
	durationSeconds: 86_400,
	ingressRatePerSecond: 1_000_000,
	recordBytes: 1_048_576,
	fanout: 12_000,
	tickHz: 1_000,
	tickBytes: 1_048_576,
	receiverCount: 12_000,
	delayMs: 60_000,
	clientCount: 12_000,
	reconnectCycles: 1_000,
	concurrency: 12_000,
	firstMessageBytes: 1_048_576,
	liveConnections: 12_000,
	holdSeconds: 86_400,
	operationBytes: 1_048_576,
	operationsPerSecond: 1_000_000,
	chunkBytes: 1_048_576,
	sessionCount: 12_000,
	chunksPerSecondPerSession: 1_000_000,
	pauseEverySeconds: 86_400,
	pauseDurationMs: 60_000,
	measuredConnectionsPerWorker: 8,
	bytes: 1_073_741_824,
	controlMessageBytes: 1_048_576,
	controlRatePerSecond: 1_000,
	bulkChunkBytes: 1_048_576,
	bulkRateMbps: 10_000,
};

const STRUCTURAL_OVERRIDE_FIELDS = new Set([
	"subscriberCount",
	"publisherCount",
	"fanout",
	"receiverCount",
	"clientCount",
	"sessionCount",
	"liveConnections",
	"state",
	"reconnectCycles",
	"concurrency",
	"measuredConnectionsPerWorker",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validateOverrideValue(field: string, value: unknown): void {
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new TypeError(`override field ${field} must be finite`);
	}
	const integerLimit = INTEGER_FIELD_LIMITS[field];
	if (integerLimit !== undefined) {
		if (
			typeof value !== "number" ||
			!Number.isSafeInteger(value) ||
			value <= 0
		) {
			throw new TypeError(
				`override field ${field} must be a positive integer (safe integer)`,
			);
		}
		if (value > integerLimit) {
			throw new RangeError(
				`override field ${field} must be at most ${integerLimit}`,
			);
		}
	}
	if (field === "lossPercent") {
		if (typeof value !== "number" || value < 0 || value > 100) {
			throw new TypeError(
				"override field lossPercent must be between 0 and 100",
			);
		}
	}
	if (field === "pooling" && typeof value !== "boolean") {
		throw new TypeError("override field pooling must be boolean");
	}
}

function validateCellEnum(
	cell: ScenarioCell,
	field: string,
	value: unknown,
): void {
	let allowed: readonly string[] | undefined;
	if (field === "path") {
		if (cell.scenarioId === "handshake-matrix") {
			allowed = ["physical", "delay40"];
		} else if (cell.scenarioId === "bulk-one-way") {
			allowed = ["physical", "delay40-loss1"];
		}
	} else if (field === "state") {
		if (cell.scenarioId === "reconnect-storm") {
			allowed = ["cold-full", "warm-after-prime"];
		} else if (cell.scenarioId === "handshake-matrix") {
			allowed = ["cold", "warm-after-prime"];
		}
	} else if (field === "snapshotSchedule") {
		allowed = ["periodic-canonical"];
	}
	if (!allowed) return;
	if (typeof value !== "string") {
		throw new TypeError(
			`override field ${field} must be a string (allowed: ${allowed.join("|")})`,
		);
	}
	if (!allowed.includes(value)) {
		throw new TypeError(
			`override field ${field} must be one of ${allowed.join("|")}`,
		);
	}
}

export function validateScenarioOverride(
	override: unknown,
): asserts override is ScenarioOverride {
	if (!isPlainRecord(override)) {
		throw new TypeError("scenario override must be an object");
	}
	for (const key of Object.keys(override)) {
		if (key !== "cellId" && key !== "changes") {
			throw new TypeError(`unknown override property ${key}`);
		}
	}
	if (typeof override.cellId !== "string" || override.cellId.length === 0) {
		throw new TypeError("scenario override cellId must be a non-empty string");
	}
	if (!isPlainRecord(override.changes)) {
		throw new TypeError("scenario override changes must be an object");
	}
	const selectedCell = CANONICAL_CELLS.find(
		(candidate) => candidate.cellId === override.cellId,
	);
	if (!selectedCell) {
		throw new RangeError(`unknown scenario cell ${override.cellId}`);
	}
	for (const [field, value] of Object.entries(override.changes)) {
		if (!KNOWN_OVERRIDE_FIELDS.has(field)) {
			throw new TypeError(`unknown override field ${field}`);
		}
		if (!Object.prototype.hasOwnProperty.call(selectedCell.parameters, field)) {
			throw new TypeError(
				`override field ${field} is not present on selected scenario cell ${selectedCell.cellId}`,
			);
		}
		validateOverrideValue(field, value);
		validateCellEnum(selectedCell, field, value);
		if (STRUCTURAL_OVERRIDE_FIELDS.has(field)) {
			throw new TypeError(
				`override field ${field} changes topology, cohort, or sharding metadata and is not diagnostic-overridable`,
			);
		}
	}
}

function isDiagnosticParameterValue(
	value: unknown,
): value is DiagnosticParameterValue {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function overrideParameters(
	cell: ScenarioCell,
	override: ScenarioOverride,
): DiagnosticScenarioParameters {
	const parameters: DiagnosticScenarioParameters = {
		scenarioId: cell.scenarioId,
	};
	for (const [field, value] of Object.entries(cell.parameters)) {
		if (field === "scenarioId") continue;
		if (!isDiagnosticParameterValue(value)) {
			throw new TypeError(
				`scenario parameter ${field} must be a primitive value`,
			);
		}
		parameters[field] = value;
	}
	for (const [field, value] of Object.entries(override.changes)) {
		if (!Object.prototype.hasOwnProperty.call(parameters, field)) {
			throw new TypeError(
				`unknown override field ${field} for ${cell.scenarioId} parameters`,
			);
		}
		if (!isDiagnosticParameterValue(value)) {
			throw new TypeError(
				`scenario override field ${field} must be a primitive value`,
			);
		}
		parameters[field] = value;
	}
	return parameters;
}

function applyOverride(
	cell: ScenarioCell,
	override: ScenarioOverride,
): ScenarioCell {
	const parameters = overrideParameters(cell, override);
	return buildCell(
		cell.cellId,
		parameters,
		cell.rolePlan,
		cell.runPolicy,
		false,
	);
}

function makeArm(
	cell: ScenarioCell,
	transport: ArmTransport,
	armKind: ArmKind,
	overlayOf?: string,
): ScenarioArm {
	const overlay = armKind === "ws-lossy-overlay";
	return deepFreeze({
		armId: `${cell.cellId}/${transport}`,
		cellId: cell.cellId,
		scenarioId: cell.scenarioId,
		transport,
		armKind,
		label: overlay ? "ws-lossy-game-overlay" : `${transport}-primary`,
		...(overlayOf === undefined ? {} : { overlayOf }),
		canonical: cell.canonical,
		scenarioHash: cell.scenarioHash,
		capacityProfileHash: cell.capacityProfileHash,
		connectionSetup: cell.connectionSetup,
	});
}

function buildArms(cells: readonly ScenarioCell[]): ScenarioArm[] {
	const arms: ScenarioArm[] = [];
	for (const cell of cells) {
		arms.push(makeArm(cell, "ws", "primary"));
		arms.push(makeArm(cell, "wt", "primary"));
		if (cell.scenarioId === "game-tick-loss") {
			arms.push(
				makeArm(
					cell,
					"ws-lossy-overlay",
					"ws-lossy-overlay",
					`${cell.cellId}/ws`,
				),
			);
		}
	}
	return arms;
}

function buildRegistry(
	cells: readonly ScenarioCell[],
	canonical: boolean,
): ScenarioRegistry {
	const arms = buildArms(cells);
	const payload = {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		canonical,
		capacityProfile: CANONICAL_CAPACITY_PROFILE,
		capacityProfileHash: CAPACITY_PROFILE_HASH,
		connectionSetup: CANONICAL_CONNECTION_SETUP,
		cells,
		arms,
	};
	return deepFreeze({
		...payload,
		registryHash: sha256Canonical(payload),
	});
}

function normalizeRegistryOptions(options: unknown): readonly unknown[] {
	if (Array.isArray(options)) return options;
	if (!isPlainRecord(options)) {
		throw new TypeError(
			"scenario registry options must be an object or override array",
		);
	}
	for (const key of Object.keys(options)) {
		if (key !== "overrides") {
			throw new TypeError(`unknown scenario registry option ${key}`);
		}
	}
	if (options.overrides === undefined) return [];
	if (!Array.isArray(options.overrides)) {
		throw new TypeError("scenario registry options.overrides must be an array");
	}
	return options.overrides;
}

export function createScenarioRegistry(
	options: unknown = {},
): ScenarioRegistry {
	const overrides = normalizeRegistryOptions(options);
	if (overrides.length === 0) {
		return CANONICAL_SCENARIO_REGISTRY;
	}
	const byCellId = new Map(CANONICAL_CELLS.map((cell) => [cell.cellId, cell]));
	const changed = new Map<string, ScenarioCell>();
	for (const rawOverride of overrides) {
		validateScenarioOverride(rawOverride);
		const override = rawOverride;
		const base = byCellId.get(override.cellId);
		if (!base) {
			throw new RangeError(`unknown scenario cell ${override.cellId}`);
		}
		const current = changed.get(override.cellId) ?? base;
		changed.set(override.cellId, applyOverride(current, override));
	}
	const cells = CANONICAL_CELLS.map((cell) => changed.get(cell.cellId) ?? cell);
	return buildRegistry(cells, false);
}

export function listScenarioCells(registry: ScenarioRegistry): ScenarioCell[] {
	return [...registry.cells];
}

export function listScenarioArms(registry: ScenarioRegistry): ScenarioArm[] {
	return [...registry.arms];
}

export function getScenarioCell(
	registry: ScenarioRegistry,
	cellId: string,
): ScenarioCell {
	const cell = registry.cells.find((candidate) => candidate.cellId === cellId);
	if (!cell) throw new RangeError(`unknown scenario cell ${cellId}`);
	return cell;
}

export const CANONICAL_SCENARIO_REGISTRY: ScenarioRegistry = buildRegistry(
	CANONICAL_CELLS,
	true,
);

// Keep the pure registry's serialized form available to callers that need to
// persist a manifest without deciding their own key-ordering policy.
export function serializeScenarioRegistry(registry: ScenarioRegistry): string {
	return canonicalJson(registry);
}
