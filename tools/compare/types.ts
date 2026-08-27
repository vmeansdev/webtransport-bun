export const SCENARIO_IDS = Object.freeze([
	"chat-fanout",
	"ticker-fanout",
	"game-tick-loss",
	"reconnect-storm",
	"connection-memory",
	"crdt-sync",
	"ai-token-stream",
	"handshake-matrix",
	"bulk-one-way",
	"tail-under-cross-traffic",
] as const);

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export type DeliveryMode = "reliable" | "latest-state";

export interface ChatParameters {
	readonly scenarioId: "chat-fanout";
	readonly subscriberCount: number;
	readonly publisherCount: 10;
	readonly messageBytes: 128;
	readonly messagesPerSecondPerPublisher: 1;
	readonly durationSeconds: 30;
	readonly delivery: "reliable";
}

export interface TickerParameters {
	readonly scenarioId: "ticker-fanout";
	readonly ingressRatePerSecond: 10_000 | 50_000 | 100_000;
	readonly publisherCount: 1;
	readonly subscriberCount: 100;
	readonly recordBytes: 100;
	readonly fanout: 100;
	readonly durationSeconds: 10;
	readonly delivery: "reliable";
}

export interface GameParameters {
	readonly scenarioId: "game-tick-loss";
	readonly tickHz: 20 | 60;
	readonly tickBytes: 64;
	readonly receiverCount: 100;
	readonly publisherCount: 1;
	readonly durationSeconds: 30;
	readonly lossPercent: 1 | 2.5 | 5;
	readonly delayMs: 20 | 40;
	readonly delivery: "latest-state";
}

export interface ReconnectParameters {
	readonly scenarioId: "reconnect-storm";
	readonly state: "cold-full" | "warm-after-prime";
	readonly clientCount: 100;
	readonly reconnectCycles: 10;
	readonly concurrency: 100;
	readonly firstMessageBytes: 32;
	readonly acknowledged: true;
}

export interface ConnectionMemoryParameters {
	readonly scenarioId: "connection-memory";
	readonly liveConnections: 1_000 | 5_000 | 10_000;
	readonly holdSeconds: 30;
	readonly pooling: false;
}

export interface CrdtParameters {
	readonly scenarioId: "crdt-sync";
	readonly clientCount: 100;
	readonly operationBytes: 96;
	readonly operationsPerSecond: 1_000;
	readonly durationSeconds: 60;
	readonly snapshotSchedule: "periodic-canonical";
	readonly delivery: "reliable";
}

export interface AiTokenParameters {
	readonly scenarioId: "ai-token-stream";
	readonly chunkBytes: 32 | 64 | 128 | 256;
	readonly sessionCount: 100;
	readonly chunksPerSecondPerSession: 50;
	readonly durationSeconds: 30;
	readonly pauseEverySeconds: 5;
	readonly pauseDurationMs: 500;
}

export interface HandshakeParameters {
	readonly scenarioId: "handshake-matrix";
	readonly path: "physical" | "delay40";
	readonly state: "cold" | "warm-after-prime";
	readonly clientCount: 100;
	readonly measuredConnectionsPerWorker: 1;
}

export interface BulkParameters {
	readonly scenarioId: "bulk-one-way";
	readonly path: "physical" | "delay40-loss1";
	readonly bytes: number;
	readonly chunkBytes: number;
	readonly delivery: "reliable";
}

export interface TailParameters {
	readonly scenarioId: "tail-under-cross-traffic";
	readonly controlMessageBytes: 64;
	readonly controlRatePerSecond: 1;
	readonly durationSeconds: 180;
	readonly bulkChunkBytes: number;
	readonly bulkRateMbps: 700;
	readonly acknowledged: true;
}

export type ScenarioParameters =
	| ChatParameters
	| TickerParameters
	| GameParameters
	| ReconnectParameters
	| ConnectionMemoryParameters
	| CrdtParameters
	| AiTokenParameters
	| HandshakeParameters
	| BulkParameters
	| TailParameters;

/** Primitive values permitted in a non-canonical diagnostic parameter set. */
export type DiagnosticParameterValue = string | number | boolean;

/**
 * Runtime parameters produced by diagnostic overrides.  Canonical parameter
 * interfaces retain their literal values; this shape makes widened override
 * values explicit instead of hiding them behind an unsafe cast.
 */
export interface DiagnosticScenarioParameters {
	scenarioId: ScenarioId;
	[key: string]: DiagnosticParameterValue;
}

export type RuntimeScenarioParameters =
	| ScenarioParameters
	| DiagnosticScenarioParameters;

export interface CapacityProfile {
	readonly profileId: "capacity-v1";
	readonly maxSessions: number;
	readonly maxHandshakesInFlight: number;
	readonly maxStreamsPerSessionBidi: number;
	readonly maxStreamsPerSessionUni: number;
	readonly maxStreamsGlobal: number;
	readonly maxDatagramSize: number;
	readonly maxQueuedBytesGlobal: number;
	readonly maxQueuedBytesPerSession: number;
	readonly maxQueuedBytesPerStream: number;
	readonly backpressureTimeoutMs: number;
	readonly handshakeTimeoutMs: number;
	readonly idleTimeoutMs: number;
	readonly handshakesPerSec: number;
	readonly handshakesBurst: number;
	readonly handshakesBurstPerPrefix: number;
	readonly streamsPerSec: number;
	readonly streamsBurst: number;
	readonly datagramsPerSec: number;
	readonly datagramsBurst: number;
}

export interface ConnectionSetup {
	readonly connectionRampPerSecond: 500;
	readonly maxConnectsInFlight: 200;
}

export interface RunPolicy {
	readonly classification: "short" | "long";
	readonly warmupRepetitions: 1 | 3;
	readonly measuredRepetitions: 5 | 15;
	/**
	 * Warmup repetitions for the off-loop arms specifically. Held at 1: under
	 * the mandatory one-Worker-per-campaign rule the spawn transient happens
	 * once, so repeating it per arm would measure spawns that no longer happen.
	 * The field exists so raising it later is a value change, not a type change.
	 */
	readonly readPathWarmupRepetitions: 1 | 3;
}

export type MacRole =
	| "publisher"
	| "subscriber"
	| "receiver"
	| "reconnecting-client"
	| "idle-client"
	| "actor"
	| "token-receiver"
	| "connection-initiator"
	| "sink"
	| "control-initiator";

export type LinuxRole =
	| "reliable-relay"
	| "datagram-relay"
	| "acknowledger"
	| "accepting-server"
	| "snapshot-authority"
	| "token-source"
	| "bulk-source"
	| "bulk-source-and-acknowledger";

export type TrafficDirection =
	| "mac-to-linux-to-mac"
	| "mac-to-linux"
	| "linux-to-mac"
	| "bidirectional";

export type MacProcessModel = "dedicated" | "sharded" | "cohort" | "single";

export interface MacRoleSpec {
	readonly role: MacRole;
	readonly count: number;
	readonly processModel: MacProcessModel;
}

export type ShardingStrategy =
	| "round-robin"
	| "fresh-child-per-cycle"
	| "fresh-process-cohort"
	| "single-process";

export interface WorkerShard {
	readonly workerIndex: number;
	readonly clientIds: readonly number[];
}

export interface ShardingPlan {
	readonly workerCount: number;
	readonly strategy: ShardingStrategy;
	readonly role: MacRole;
	readonly shards: readonly WorkerShard[];
}

export type ProcessCohortKind =
	| "persistent"
	| "fresh-child-per-cycle"
	| "fresh-100-process-cohort-per-repetition";

export interface ProcessCohort {
	readonly kind: ProcessCohortKind;
	readonly processes: number;
	readonly primeBeforeMeasurement: boolean;
	readonly measuredCycles: number;
}

export interface RolePlan {
	readonly macRoles: readonly MacRoleSpec[];
	readonly linuxRole: LinuxRole;
	readonly direction: TrafficDirection;
	readonly channels: readonly string[];
	readonly sharding: ShardingPlan;
	readonly processCohort: ProcessCohort;
}

export interface ScenarioCell {
	readonly cellId: string;
	readonly scenarioId: ScenarioId;
	readonly parameters: RuntimeScenarioParameters;
	readonly rolePlan: RolePlan;
	readonly connectionSetup: ConnectionSetup;
	readonly capacityProfileHash: string;
	readonly runPolicy: RunPolicy;
	readonly canonical: boolean;
	readonly scenarioHash: string;
}

/** The wire protocol a primary arm rides.  Stays two-valued (A0-3). */
export type PrimaryTransport = "ws" | "wt";

/**
 * The arm's identity: wire plus read-path strategy.  No longer an alias of
 * `PrimaryTransport` — an off-loop arm rides the same wire as the main-loop
 * arm it is compared against and is distinguished only here.
 */
export type ArmTransport = "ws" | "wt" | "ws-worker" | "wt-stream-sink";

/**
 * `"read-path"` — deliberately not `"sink"`.  `ws-worker` is off-loop but is
 * not a sink; the kind names where the reader runs, not how it reads.
 */
export type ArmKind = "primary" | "read-path" | "overlay";

/** One *emitted* execution slot.  Mirror of `evidence.ts`'s `ArmSlot`; the
 * registry does not import the artifact schema. */
export type ArmSlotKind = ArmTransport | "ws-overlay";

/** One *scheduled* unit.  `"ws+ws-overlay"` expands to two slots at emit time.
 * Mirror of `evidence.ts`'s `ArmUnit`. */
export type ArmUnitKind = ArmTransport | "ws+ws-overlay";

interface ScenarioArmBase {
	readonly armId: string;
	readonly cellId: string;
	readonly scenarioId: ScenarioId;
	readonly label: string;
	readonly canonical: boolean;
	readonly scenarioHash: string;
	readonly capacityProfileHash: string;
	readonly connectionSetup: ConnectionSetup;
}

export interface PrimaryScenarioArm extends ScenarioArmBase {
	readonly transport: PrimaryTransport;
	readonly armTransport: "ws" | "wt";
	readonly armKind: "primary";
	readonly overlayOf?: never;
}

/**
 * An off-loop reader on the same wire as the primary it shadows. It is its own
 * evidence — measured, ranked and promotable — and inherits none of the
 * overlay's exclusions, so it has no `overlayOf`.
 */
export interface ReadPathScenarioArm extends ScenarioArmBase {
	readonly transport: PrimaryTransport;
	readonly armTransport: "ws-worker" | "wt-stream-sink";
	readonly armKind: "read-path";
	readonly overlayOf?: never;
}

/**
 * A lossy game overlay rides the WS transport of the primary arm it shadows,
 * so it is a distinct arm kind and never a distinct transport. Delta and
 * ranking sets key off `armKind === "overlay"` to exclude it.
 */
export interface OverlayScenarioArm extends ScenarioArmBase {
	readonly transport: "ws";
	/** The overlay is not a ranked arm and never enters a pairing. */
	readonly armTransport?: never;
	readonly armKind: "overlay";
	readonly overlayOf: string;
}

export type ScenarioArm =
	| PrimaryScenarioArm
	| ReadPathScenarioArm
	| OverlayScenarioArm;

export interface ScenarioRegistry {
	readonly schemaVersion: "v1";
	readonly canonical: boolean;
	readonly capacityProfile: CapacityProfile;
	readonly capacityProfileHash: string;
	readonly connectionSetup: ConnectionSetup;
	readonly cells: readonly ScenarioCell[];
	readonly arms: readonly ScenarioArm[];
	readonly registryHash: string;
}

export interface ScenarioOverride {
	readonly cellId: string;
	readonly changes: Readonly<Record<string, unknown>>;
}

export interface ScenarioRegistryOptions {
	readonly overrides?: readonly ScenarioOverride[];
}
