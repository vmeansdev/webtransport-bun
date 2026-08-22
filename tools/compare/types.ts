export const SCENARIO_IDS = [
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
] as const;

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
	readonly parameters: ScenarioParameters;
	readonly rolePlan: RolePlan;
	readonly connectionSetup: ConnectionSetup;
	readonly capacityProfileHash: string;
	readonly runPolicy: RunPolicy;
	readonly canonical: boolean;
	readonly scenarioHash: string;
}

export type PrimaryTransport = "ws" | "wt";
export type ArmTransport = PrimaryTransport | "ws-lossy-overlay";
export type ArmKind = "primary" | "ws-lossy-overlay";

export interface ScenarioArm {
	readonly armId: string;
	readonly cellId: string;
	readonly scenarioId: ScenarioId;
	readonly transport: ArmTransport;
	readonly armKind: ArmKind;
	readonly label: string;
	readonly overlayOf?: string;
	readonly canonical: boolean;
	readonly scenarioHash: string;
	readonly capacityProfileHash: string;
	readonly connectionSetup: ConnectionSetup;
}

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
