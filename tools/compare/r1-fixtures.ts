import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";

export type PhaseKind = "warmup" | "measured";
export type TransportKind = "ws" | "wt";
export type ContractArmKind = "primary" | "overlay";
export type RawKind =
	| "client"
	| "server"
	| "topology"
	| "impairment"
	| "cleanup";
export type SnapshotKind = "snapshot-pre" | "snapshot-post";

export interface CardinalityV1 {
	readonly cellCount: 35;
	readonly armCount: 82;
	readonly wsPrimaryArmCount: 35;
	readonly wtPrimaryArmCount: 35;
	readonly overlayArmCount: 12;
	readonly primaryWarmupCount: 86;
	readonly primaryMeasuredCount: 430;
	readonly overlayWarmupCount: 12;
	readonly overlayMeasuredCount: 60;
	readonly warmupExecutionCount: 98;
	readonly measuredExecutionCount: 490;
	readonly primaryExecutionCount: 516;
	readonly executionCount: 588;
	readonly wsPrimaryExecutionCount: 258;
	readonly wtPrimaryExecutionCount: 258;
	readonly wsOverlayExecutionCount: 72;
	readonly artifactCount: 588;
	readonly rawClientCount: 588;
	readonly rawServerCount: 588;
	readonly rawTopologyCount: 588;
	readonly rawImpairmentCount: 588;
	readonly rawCleanupCount: 588;
	readonly rawDescriptorCount: 2940;
	readonly snapshotPreCount: 35;
	readonly snapshotPostCount: 35;
	readonly snapshotDescriptorCount: 70;
	readonly attestationCount: 1;
	readonly descriptorCount: 3599;
}

export interface EvidenceDescriptorV1 {
	readonly schema: "evidence-descriptor/v1";
	readonly kind:
		| "artifact"
		| "raw-client"
		| "raw-server"
		| "raw-topology"
		| "raw-impairment"
		| "raw-cleanup"
		| "snapshot-pre"
		| "snapshot-post"
		| "attestation";
	readonly components: readonly [string, ...string[]];
	readonly sha256: string;
	readonly size: number;
	readonly candidate: string;
	readonly campaignId: string;
	readonly authoritySha256: string;
	readonly lockSha256: string;
	readonly capabilitySha256: string;
	readonly hostId: string;
	readonly cellId: string;
	readonly runId: string | null;
	readonly executionIndex: number | null;
}

export interface CampaignManifestV1 {
	readonly schema: "campaign-manifest/v1";
	readonly authoritySha256: string;
	readonly lockSha256: string;
	readonly capabilitySha256: string;
	readonly candidate: string;
	readonly campaignId: string;
	readonly registryHash: string;
	readonly scheduleHash: string;
	readonly cardinality: CardinalityV1;
	readonly descriptors: readonly EvidenceDescriptorV1[];
	readonly sealedAt: string;
	/** Non-enumerable schedule projections retained only for legacy RED mutation calls. */
	readonly runEntries: readonly ManifestRunEntry[];
	readonly cellSnapshotBundles: readonly CellSnapshotBundle[];
}

export interface ContractArmDefinition {
	readonly armId: string;
	readonly cellId: string;
	readonly scenarioId: string;
	readonly transport: TransportKind;
	readonly armKind: ContractArmKind;
	readonly overlayOf?: string;
}

export interface RawDescriptor {
	readonly relativePath: string;
	readonly sha256: string;
	readonly kind: RawKind;
	readonly host: "mac" | "linux";
	readonly phase: PhaseKind;
	readonly armId: string;
	readonly repetitionIndex: number;
	readonly candidateId: string;
	readonly campaignId: string;
	readonly lockDigestSha256: string;
}

export interface ArtifactDescriptor {
	readonly relativePath: string;
	readonly sha256: string;
	readonly phase: PhaseKind;
	readonly armId: string;
	readonly transport: TransportKind;
	readonly repetitionIndex: number;
	readonly candidateId: string;
	readonly campaignId: string;
	readonly lockDigestSha256: string;
}

export interface CellSnapshotDescriptor {
	readonly relativePath: string;
	readonly sha256: string;
	readonly kind: SnapshotKind;
	readonly cellId: string;
	readonly candidateId: string;
	readonly campaignId: string;
	readonly lockDigestSha256: string;
}

export interface CellSnapshotBundle {
	readonly cellId: string;
	readonly preCell: CellSnapshotDescriptor;
	readonly postCell: CellSnapshotDescriptor;
}

export interface SharedIdentity {
	readonly candidateId: string;
	readonly campaignId: string;
	readonly lockDigestSha256: string;
	readonly archiveSha256: string;
	readonly stagedArchiveSha256: string;
	readonly registrySha256: string;
	readonly specSha256: string;
	readonly capacitySha256: string;
	readonly reviewedCleanHead: string;
	readonly jsExecutableSha256: string;
	readonly darwinNativeSha256: string;
	readonly linuxNativeSha256: string;
}

export interface ManifestRunEntry {
	readonly runInstanceId: string;
	readonly executionIndex: number;
	readonly phase: PhaseKind;
	readonly excludeFromDelta: boolean;
	readonly excludeFromRanking: boolean;
	readonly excludeFromPromotion: boolean;
	readonly candidateId: string;
	readonly campaignId: string;
	readonly cellId: string;
	readonly scenarioId: string;
	readonly armId: string;
	readonly transport: TransportKind;
	readonly armKind: ContractArmKind;
	readonly overlayOf?: string;
	readonly repetitionIndex: number;
	readonly seed: number;
	readonly phasePrimaryTransportSequence: readonly TransportKind[];
	readonly artifact: ArtifactDescriptor;
	readonly rawDescriptors: readonly [
		RawDescriptor,
		RawDescriptor,
		RawDescriptor,
		RawDescriptor,
		RawDescriptor,
	];
	readonly cellSnapshotBundle: CellSnapshotBundle;
	readonly sharedIdentity: SharedIdentity;
}

export interface RepresentativeFixture {
	readonly candidateId: string;
	readonly campaignId: string;
	readonly archiveBytes: Uint8Array;
	readonly registryBytes: Uint8Array;
	readonly specBytes: Uint8Array;
	readonly capacityBytes: Uint8Array;
	readonly lock: Record<string, unknown>;
	readonly lockBytes: Uint8Array;
	readonly expectedLockDigest: string;
	readonly stagedCapability: Record<string, unknown>;
	readonly stagedCapabilityBytes: Uint8Array;
	readonly expectedCapabilityDigest: string;
	readonly fixtureOnlyCapabilityBytes: Uint8Array;
	readonly observedAttestation: Record<string, unknown>;
	readonly observedAttestationModel: Record<string, unknown>;
	readonly armDefinitions: readonly ContractArmDefinition[];
	readonly runEntries: readonly ManifestRunEntry[];
	readonly cellSnapshotBundles: readonly CellSnapshotBundle[];
	readonly manifest: CampaignManifestV1;
	readonly artifactBytesByPath: Readonly<Record<string, Uint8Array>>;
	readonly rawBytesByPath: Readonly<Record<string, Uint8Array>>;
	readonly snapshotBytesByPath: Readonly<Record<string, Uint8Array>>;
	readonly explicitMeasuredBuildInput: Record<string, unknown>;
	readonly legacyFixtureBytes: Uint8Array;
}

export interface ExpectedCellContract {
	readonly cellId: string;
	readonly scenarioId: string;
	readonly warmupRepetitions: number;
	readonly measuredRepetitions: number;
	readonly expectedStartTransport: TransportKind;
	readonly hasOverlay: boolean;
}

export const EXPECTED_CELL_CONTRACTS = Object.freeze<
	readonly ExpectedCellContract[]
>([
	{
		cellId: "chat-fanout/subscribers-1000",
		scenarioId: "chat-fanout",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "chat-fanout/subscribers-5000",
		scenarioId: "chat-fanout",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "chat-fanout/subscribers-10000",
		scenarioId: "chat-fanout",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "ticker-fanout/rate-10000",
		scenarioId: "ticker-fanout",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "ticker-fanout/rate-50000",
		scenarioId: "ticker-fanout",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "ticker-fanout/rate-100000",
		scenarioId: "ticker-fanout",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "game-tick-loss/tick-20-loss-1-delay-20",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-20-loss-1-delay-40",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-20-loss-2.5-delay-20",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-20-loss-2.5-delay-40",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-20-loss-5-delay-20",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-20-loss-5-delay-40",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-60-loss-1-delay-20",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-60-loss-1-delay-40",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-60-loss-2.5-delay-20",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-60-loss-2.5-delay-40",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-60-loss-5-delay-20",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: true,
	},
	{
		cellId: "game-tick-loss/tick-60-loss-5-delay-40",
		scenarioId: "game-tick-loss",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: true,
	},
	{
		cellId: "reconnect-storm/cold-full",
		scenarioId: "reconnect-storm",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "reconnect-storm/warm-after-prime",
		scenarioId: "reconnect-storm",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "connection-memory/live-1000",
		scenarioId: "connection-memory",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "connection-memory/live-5000",
		scenarioId: "connection-memory",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "connection-memory/live-10000",
		scenarioId: "connection-memory",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "crdt-sync/default",
		scenarioId: "crdt-sync",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "ai-token-stream/chunk-32",
		scenarioId: "ai-token-stream",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "ai-token-stream/chunk-64",
		scenarioId: "ai-token-stream",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "ai-token-stream/chunk-128",
		scenarioId: "ai-token-stream",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "ai-token-stream/chunk-256",
		scenarioId: "ai-token-stream",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "handshake-matrix/physical-cold",
		scenarioId: "handshake-matrix",
		warmupRepetitions: 3,
		measuredRepetitions: 15,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "handshake-matrix/physical-warm-after-prime",
		scenarioId: "handshake-matrix",
		warmupRepetitions: 3,
		measuredRepetitions: 15,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "handshake-matrix/delay40-cold",
		scenarioId: "handshake-matrix",
		warmupRepetitions: 3,
		measuredRepetitions: 15,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "handshake-matrix/delay40-warm-after-prime",
		scenarioId: "handshake-matrix",
		warmupRepetitions: 3,
		measuredRepetitions: 15,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "bulk-one-way/physical",
		scenarioId: "bulk-one-way",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "ws",
		hasOverlay: false,
	},
	{
		cellId: "bulk-one-way/delay40-loss1",
		scenarioId: "bulk-one-way",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
	{
		cellId: "tail-under-cross-traffic/default",
		scenarioId: "tail-under-cross-traffic",
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		expectedStartTransport: "wt",
		hasOverlay: false,
	},
]);

type FixtureShardingSpec = {
	readonly workerCount: number;
	readonly strategy:
		| "round-robin"
		| "fresh-child-per-cycle"
		| "fresh-process-cohort"
		| "single-process";
	readonly role: string;
	readonly count: number;
};

type FixtureCellRow = {
	readonly cellId: string;
	readonly scenarioId: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly macRoles: readonly Readonly<Record<string, unknown>>[];
	readonly linuxRole: string;
	readonly direction: string;
	readonly channels: readonly string[];
	readonly sharding: FixtureShardingSpec;
	readonly processCohort: Readonly<Record<string, unknown>>;
	readonly runPolicy: Readonly<{
		classification: string;
		warmupRepetitions: number;
		measuredRepetitions: number;
	}>;
};

/**
 * Independent test-side oracle for all 35 cells.  Keep this table literal:
 * production registry and scheduling helpers must not be imported to create
 * the RED fixture or its observed role facts.
 */
export const EXPECTED_CELL_TABLE = Object.freeze<readonly FixtureCellRow[]>([
	{
		cellId: "chat-fanout/subscribers-1000",
		scenarioId: "chat-fanout",
		parameters: {
			scenarioId: "chat-fanout",
			subscriberCount: 1000,
			publisherCount: 10,
			messageBytes: 128,
			messagesPerSecondPerPublisher: 1,
			durationSeconds: 30,
			delivery: "reliable",
		},
		macRoles: [
			{ role: "publisher", count: 10, processModel: "dedicated" },
			{ role: "subscriber", count: 1000, processModel: "sharded" },
		],
		linuxRole: "reliable-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-bidi", "server-opened-subscriber-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "subscriber",
			count: 1000,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "chat-fanout/subscribers-5000",
		scenarioId: "chat-fanout",
		parameters: {
			scenarioId: "chat-fanout",
			subscriberCount: 5000,
			publisherCount: 10,
			messageBytes: 128,
			messagesPerSecondPerPublisher: 1,
			durationSeconds: 30,
			delivery: "reliable",
		},
		macRoles: [
			{ role: "publisher", count: 10, processModel: "dedicated" },
			{ role: "subscriber", count: 5000, processModel: "sharded" },
		],
		linuxRole: "reliable-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-bidi", "server-opened-subscriber-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "subscriber",
			count: 5000,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "chat-fanout/subscribers-10000",
		scenarioId: "chat-fanout",
		parameters: {
			scenarioId: "chat-fanout",
			subscriberCount: 10000,
			publisherCount: 10,
			messageBytes: 128,
			messagesPerSecondPerPublisher: 1,
			durationSeconds: 30,
			delivery: "reliable",
		},
		macRoles: [
			{ role: "publisher", count: 10, processModel: "dedicated" },
			{ role: "subscriber", count: 10000, processModel: "sharded" },
		],
		linuxRole: "reliable-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-bidi", "server-opened-subscriber-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "subscriber",
			count: 10000,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "ticker-fanout/rate-10000",
		scenarioId: "ticker-fanout",
		parameters: {
			scenarioId: "ticker-fanout",
			ingressRatePerSecond: 10000,
			publisherCount: 1,
			subscriberCount: 100,
			recordBytes: 100,
			fanout: 100,
			durationSeconds: 10,
			delivery: "reliable",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "subscriber", count: 100, processModel: "sharded" },
		],
		linuxRole: "reliable-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-bidi", "server-opened-subscriber-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "subscriber",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "ticker-fanout/rate-50000",
		scenarioId: "ticker-fanout",
		parameters: {
			scenarioId: "ticker-fanout",
			ingressRatePerSecond: 50000,
			publisherCount: 1,
			subscriberCount: 100,
			recordBytes: 100,
			fanout: 100,
			durationSeconds: 10,
			delivery: "reliable",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "subscriber", count: 100, processModel: "sharded" },
		],
		linuxRole: "reliable-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-bidi", "server-opened-subscriber-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "subscriber",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "ticker-fanout/rate-100000",
		scenarioId: "ticker-fanout",
		parameters: {
			scenarioId: "ticker-fanout",
			ingressRatePerSecond: 100000,
			publisherCount: 1,
			subscriberCount: 100,
			recordBytes: 100,
			fanout: 100,
			durationSeconds: 10,
			delivery: "reliable",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "subscriber", count: 100, processModel: "sharded" },
		],
		linuxRole: "reliable-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-bidi", "server-opened-subscriber-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "subscriber",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-20-loss-1-delay-20",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 20,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 1,
			delayMs: 20,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-20-loss-1-delay-40",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 20,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 1,
			delayMs: 40,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-20-loss-2.5-delay-20",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 20,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 2.5,
			delayMs: 20,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-20-loss-2.5-delay-40",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 20,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 2.5,
			delayMs: 40,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-20-loss-5-delay-20",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 20,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 5,
			delayMs: 20,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-20-loss-5-delay-40",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 20,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 5,
			delayMs: 40,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-60-loss-1-delay-20",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 60,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 1,
			delayMs: 20,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-60-loss-1-delay-40",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 60,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 1,
			delayMs: 40,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-60-loss-2.5-delay-20",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 60,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 2.5,
			delayMs: 20,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-60-loss-2.5-delay-40",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 60,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 2.5,
			delayMs: 40,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-60-loss-5-delay-20",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 60,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 5,
			delayMs: 20,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "game-tick-loss/tick-60-loss-5-delay-40",
		scenarioId: "game-tick-loss",
		parameters: {
			scenarioId: "game-tick-loss",
			tickHz: 60,
			tickBytes: 64,
			receiverCount: 100,
			publisherCount: 1,
			durationSeconds: 30,
			lossPercent: 5,
			delayMs: 40,
			delivery: "latest-state",
		},
		macRoles: [
			{ role: "publisher", count: 1, processModel: "dedicated" },
			{ role: "receiver", count: 100, processModel: "sharded" },
		],
		linuxRole: "datagram-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["publisher-datagram", "receiver-datagram"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "reconnect-storm/cold-full",
		scenarioId: "reconnect-storm",
		parameters: {
			scenarioId: "reconnect-storm",
			state: "cold-full",
			clientCount: 100,
			reconnectCycles: 10,
			concurrency: 100,
			firstMessageBytes: 32,
			acknowledged: true,
		},
		macRoles: [
			{ role: "reconnecting-client", count: 100, processModel: "cohort" },
		],
		linuxRole: "acknowledger",
		direction: "mac-to-linux",
		channels: ["request-ack"],
		sharding: {
			workerCount: 100,
			strategy: "fresh-child-per-cycle",
			role: "reconnecting-client",
			count: 100,
		},
		processCohort: {
			kind: "fresh-child-per-cycle",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 10,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "reconnect-storm/warm-after-prime",
		scenarioId: "reconnect-storm",
		parameters: {
			scenarioId: "reconnect-storm",
			state: "warm-after-prime",
			clientCount: 100,
			reconnectCycles: 10,
			concurrency: 100,
			firstMessageBytes: 32,
			acknowledged: true,
		},
		macRoles: [
			{ role: "reconnecting-client", count: 100, processModel: "cohort" },
		],
		linuxRole: "acknowledger",
		direction: "mac-to-linux",
		channels: ["request-ack"],
		sharding: {
			workerCount: 100,
			strategy: "fresh-process-cohort",
			role: "reconnecting-client",
			count: 100,
		},
		processCohort: {
			kind: "fresh-100-process-cohort-per-repetition",
			processes: 100,
			primeBeforeMeasurement: true,
			measuredCycles: 10,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "connection-memory/live-1000",
		scenarioId: "connection-memory",
		parameters: {
			scenarioId: "connection-memory",
			liveConnections: 1000,
			holdSeconds: 30,
			pooling: false,
		},
		macRoles: [{ role: "idle-client", count: 1000, processModel: "sharded" }],
		linuxRole: "accepting-server",
		direction: "mac-to-linux",
		channels: ["one-session-per-client"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "idle-client",
			count: 1000,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "connection-memory/live-5000",
		scenarioId: "connection-memory",
		parameters: {
			scenarioId: "connection-memory",
			liveConnections: 5000,
			holdSeconds: 30,
			pooling: false,
		},
		macRoles: [{ role: "idle-client", count: 5000, processModel: "sharded" }],
		linuxRole: "accepting-server",
		direction: "mac-to-linux",
		channels: ["one-session-per-client"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "idle-client",
			count: 5000,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "connection-memory/live-10000",
		scenarioId: "connection-memory",
		parameters: {
			scenarioId: "connection-memory",
			liveConnections: 10000,
			holdSeconds: 30,
			pooling: false,
		},
		macRoles: [{ role: "idle-client", count: 10000, processModel: "sharded" }],
		linuxRole: "accepting-server",
		direction: "mac-to-linux",
		channels: ["one-session-per-client"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "idle-client",
			count: 10000,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "crdt-sync/default",
		scenarioId: "crdt-sync",
		parameters: {
			scenarioId: "crdt-sync",
			clientCount: 100,
			operationBytes: 96,
			operationsPerSecond: 1000,
			durationSeconds: 60,
			snapshotSchedule: "periodic-canonical",
			delivery: "reliable",
		},
		macRoles: [{ role: "actor", count: 100, processModel: "sharded" }],
		linuxRole: "reliable-relay",
		direction: "mac-to-linux-to-mac",
		channels: ["actor-bidi", "snapshot-reliable"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "actor",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "ai-token-stream/chunk-32",
		scenarioId: "ai-token-stream",
		parameters: {
			scenarioId: "ai-token-stream",
			chunkBytes: 32,
			sessionCount: 100,
			chunksPerSecondPerSession: 50,
			durationSeconds: 30,
			pauseEverySeconds: 5,
			pauseDurationMs: 500,
		},
		macRoles: [{ role: "token-receiver", count: 100, processModel: "sharded" }],
		linuxRole: "token-source",
		direction: "linux-to-mac",
		channels: ["server-opened-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "token-receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "ai-token-stream/chunk-64",
		scenarioId: "ai-token-stream",
		parameters: {
			scenarioId: "ai-token-stream",
			chunkBytes: 64,
			sessionCount: 100,
			chunksPerSecondPerSession: 50,
			durationSeconds: 30,
			pauseEverySeconds: 5,
			pauseDurationMs: 500,
		},
		macRoles: [{ role: "token-receiver", count: 100, processModel: "sharded" }],
		linuxRole: "token-source",
		direction: "linux-to-mac",
		channels: ["server-opened-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "token-receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "ai-token-stream/chunk-128",
		scenarioId: "ai-token-stream",
		parameters: {
			scenarioId: "ai-token-stream",
			chunkBytes: 128,
			sessionCount: 100,
			chunksPerSecondPerSession: 50,
			durationSeconds: 30,
			pauseEverySeconds: 5,
			pauseDurationMs: 500,
		},
		macRoles: [{ role: "token-receiver", count: 100, processModel: "sharded" }],
		linuxRole: "token-source",
		direction: "linux-to-mac",
		channels: ["server-opened-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "token-receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "ai-token-stream/chunk-256",
		scenarioId: "ai-token-stream",
		parameters: {
			scenarioId: "ai-token-stream",
			chunkBytes: 256,
			sessionCount: 100,
			chunksPerSecondPerSession: 50,
			durationSeconds: 30,
			pauseEverySeconds: 5,
			pauseDurationMs: 500,
		},
		macRoles: [{ role: "token-receiver", count: 100, processModel: "sharded" }],
		linuxRole: "token-source",
		direction: "linux-to-mac",
		channels: ["server-opened-uni"],
		sharding: {
			workerCount: 8,
			strategy: "round-robin",
			role: "token-receiver",
			count: 100,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "handshake-matrix/physical-cold",
		scenarioId: "handshake-matrix",
		parameters: {
			scenarioId: "handshake-matrix",
			path: "physical",
			state: "cold",
			clientCount: 100,
			measuredConnectionsPerWorker: 1,
		},
		macRoles: [
			{ role: "connection-initiator", count: 100, processModel: "cohort" },
		],
		linuxRole: "acknowledger",
		direction: "mac-to-linux",
		channels: ["connect-first-ack"],
		sharding: {
			workerCount: 100,
			strategy: "fresh-child-per-cycle",
			role: "connection-initiator",
			count: 100,
		},
		processCohort: {
			kind: "fresh-child-per-cycle",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "short",
			warmupRepetitions: 3,
			measuredRepetitions: 15,
		},
	},
	{
		cellId: "handshake-matrix/physical-warm-after-prime",
		scenarioId: "handshake-matrix",
		parameters: {
			scenarioId: "handshake-matrix",
			path: "physical",
			state: "warm-after-prime",
			clientCount: 100,
			measuredConnectionsPerWorker: 1,
		},
		macRoles: [
			{ role: "connection-initiator", count: 100, processModel: "cohort" },
		],
		linuxRole: "acknowledger",
		direction: "mac-to-linux",
		channels: ["connect-first-ack"],
		sharding: {
			workerCount: 100,
			strategy: "fresh-process-cohort",
			role: "connection-initiator",
			count: 100,
		},
		processCohort: {
			kind: "fresh-100-process-cohort-per-repetition",
			processes: 100,
			primeBeforeMeasurement: true,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "short",
			warmupRepetitions: 3,
			measuredRepetitions: 15,
		},
	},
	{
		cellId: "handshake-matrix/delay40-cold",
		scenarioId: "handshake-matrix",
		parameters: {
			scenarioId: "handshake-matrix",
			path: "delay40",
			state: "cold",
			clientCount: 100,
			measuredConnectionsPerWorker: 1,
		},
		macRoles: [
			{ role: "connection-initiator", count: 100, processModel: "cohort" },
		],
		linuxRole: "acknowledger",
		direction: "mac-to-linux",
		channels: ["connect-first-ack"],
		sharding: {
			workerCount: 100,
			strategy: "fresh-child-per-cycle",
			role: "connection-initiator",
			count: 100,
		},
		processCohort: {
			kind: "fresh-child-per-cycle",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "short",
			warmupRepetitions: 3,
			measuredRepetitions: 15,
		},
	},
	{
		cellId: "handshake-matrix/delay40-warm-after-prime",
		scenarioId: "handshake-matrix",
		parameters: {
			scenarioId: "handshake-matrix",
			path: "delay40",
			state: "warm-after-prime",
			clientCount: 100,
			measuredConnectionsPerWorker: 1,
		},
		macRoles: [
			{ role: "connection-initiator", count: 100, processModel: "cohort" },
		],
		linuxRole: "acknowledger",
		direction: "mac-to-linux",
		channels: ["connect-first-ack"],
		sharding: {
			workerCount: 100,
			strategy: "fresh-process-cohort",
			role: "connection-initiator",
			count: 100,
		},
		processCohort: {
			kind: "fresh-100-process-cohort-per-repetition",
			processes: 100,
			primeBeforeMeasurement: true,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "short",
			warmupRepetitions: 3,
			measuredRepetitions: 15,
		},
	},
	{
		cellId: "bulk-one-way/physical",
		scenarioId: "bulk-one-way",
		parameters: {
			scenarioId: "bulk-one-way",
			path: "physical",
			bytes: 104857600,
			chunkBytes: 65536,
			delivery: "reliable",
		},
		macRoles: [{ role: "sink", count: 1, processModel: "single" }],
		linuxRole: "bulk-source",
		direction: "linux-to-mac",
		channels: ["server-opened-uni"],
		sharding: {
			workerCount: 1,
			strategy: "single-process",
			role: "sink",
			count: 1,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "bulk-one-way/delay40-loss1",
		scenarioId: "bulk-one-way",
		parameters: {
			scenarioId: "bulk-one-way",
			path: "delay40-loss1",
			bytes: 104857600,
			chunkBytes: 65536,
			delivery: "reliable",
		},
		macRoles: [{ role: "sink", count: 1, processModel: "single" }],
		linuxRole: "bulk-source",
		direction: "linux-to-mac",
		channels: ["server-opened-uni"],
		sharding: {
			workerCount: 1,
			strategy: "single-process",
			role: "sink",
			count: 1,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
	{
		cellId: "tail-under-cross-traffic/default",
		scenarioId: "tail-under-cross-traffic",
		parameters: {
			scenarioId: "tail-under-cross-traffic",
			controlMessageBytes: 64,
			controlRatePerSecond: 1,
			durationSeconds: 180,
			bulkChunkBytes: 65536,
			bulkRateMbps: 700,
			acknowledged: true,
		},
		macRoles: [
			{ role: "sink", count: 1, processModel: "single" },
			{ role: "control-initiator", count: 1, processModel: "dedicated" },
		],
		linuxRole: "bulk-source-and-acknowledger",
		direction: "bidirectional",
		channels: ["server-opened-uni-bulk", "control-bidi"],
		sharding: {
			workerCount: 1,
			strategy: "single-process",
			role: "sink",
			count: 1,
		},
		processCohort: {
			kind: "persistent",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 1,
		},
		runPolicy: {
			classification: "long",
			warmupRepetitions: 1,
			measuredRepetitions: 5,
		},
	},
] as const);

export const TEST_CAPACITY_PROFILE = Object.freeze({
	profileId: "capacity-v1" as const,
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
export const TEST_CAPACITY_PROFILE_HASH =
	"4e0d8cc086ac9ddab43d3c90d524757d9dc86e3e533aa317bce8e46994d63a6e" as const;
export const TEST_CONNECTION_SETUP = Object.freeze({
	connectionRampPerSecond: 500 as const,
	maxConnectsInFlight: 200 as const,
});

function fixtureSharding(spec: FixtureShardingSpec): Record<string, unknown> {
	if (spec.strategy === "round-robin") {
		const shards = Array.from(
			{ length: spec.workerCount },
			(_, workerIndex) => ({
				workerIndex,
				clientIds: Array.from(
					{ length: spec.count },
					(_, clientId) => clientId,
				).filter((clientId) => clientId % spec.workerCount === workerIndex),
			}),
		);
		return { ...spec, shards };
	}
	if (spec.strategy === "single-process") {
		return { ...spec, shards: [{ workerIndex: 0, clientIds: [0] }] };
	}
	return { ...spec, shards: [] };
}

export interface FixtureScenarioCell {
	readonly cellId: string;
	readonly scenarioId: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly rolePlan: Readonly<Record<string, unknown>>;
	readonly connectionSetup: typeof TEST_CONNECTION_SETUP;
	readonly capacityProfileHash: typeof TEST_CAPACITY_PROFILE_HASH;
	readonly runPolicy: Readonly<{
		classification: string;
		warmupRepetitions: number;
		measuredRepetitions: number;
	}>;
	readonly canonical: true;
	readonly scenarioHash: string;
}

export const FIXTURE_SCENARIO_CELLS: readonly FixtureScenarioCell[] =
	Object.freeze(
		EXPECTED_CELL_TABLE.map((row) => ({
			cellId: row.cellId,
			scenarioId: row.scenarioId,
			parameters: row.parameters,
			rolePlan: {
				macRoles: row.macRoles,
				linuxRole: row.linuxRole,
				direction: row.direction,
				channels: row.channels,
				sharding: fixtureSharding(row.sharding),
				processCohort: row.processCohort,
			},
			connectionSetup: TEST_CONNECTION_SETUP,
			capacityProfileHash: TEST_CAPACITY_PROFILE_HASH,
			runPolicy: row.runPolicy,
			canonical: true as const,
			scenarioHash: sha256Hex(
				canonicalBytes({ schema: "r1-fixture-cell/v1", cellId: row.cellId }),
			),
		})),
	);

export const EXPECTED_CELL_IDS = Object.freeze([
	"chat-fanout/subscribers-1000",
	"chat-fanout/subscribers-5000",
	"chat-fanout/subscribers-10000",
	"ticker-fanout/rate-10000",
	"ticker-fanout/rate-50000",
	"ticker-fanout/rate-100000",
	"game-tick-loss/tick-20-loss-1-delay-20",
	"game-tick-loss/tick-20-loss-1-delay-40",
	"game-tick-loss/tick-20-loss-2.5-delay-20",
	"game-tick-loss/tick-20-loss-2.5-delay-40",
	"game-tick-loss/tick-20-loss-5-delay-20",
	"game-tick-loss/tick-20-loss-5-delay-40",
	"game-tick-loss/tick-60-loss-1-delay-20",
	"game-tick-loss/tick-60-loss-1-delay-40",
	"game-tick-loss/tick-60-loss-2.5-delay-20",
	"game-tick-loss/tick-60-loss-2.5-delay-40",
	"game-tick-loss/tick-60-loss-5-delay-20",
	"game-tick-loss/tick-60-loss-5-delay-40",
	"reconnect-storm/cold-full",
	"reconnect-storm/warm-after-prime",
	"connection-memory/live-1000",
	"connection-memory/live-5000",
	"connection-memory/live-10000",
	"crdt-sync/default",
	"ai-token-stream/chunk-32",
	"ai-token-stream/chunk-64",
	"ai-token-stream/chunk-128",
	"ai-token-stream/chunk-256",
	"handshake-matrix/physical-cold",
	"handshake-matrix/physical-warm-after-prime",
	"handshake-matrix/delay40-cold",
	"handshake-matrix/delay40-warm-after-prime",
	"bulk-one-way/physical",
	"bulk-one-way/delay40-loss1",
	"tail-under-cross-traffic/default",
] as const);

export const EXPECTED_ARM_IDS = Object.freeze([
	"chat-fanout/subscribers-1000/ws",
	"chat-fanout/subscribers-1000/wt",
	"chat-fanout/subscribers-5000/ws",
	"chat-fanout/subscribers-5000/wt",
	"chat-fanout/subscribers-10000/ws",
	"chat-fanout/subscribers-10000/wt",
	"ticker-fanout/rate-10000/ws",
	"ticker-fanout/rate-10000/wt",
	"ticker-fanout/rate-50000/ws",
	"ticker-fanout/rate-50000/wt",
	"ticker-fanout/rate-100000/ws",
	"ticker-fanout/rate-100000/wt",
	"game-tick-loss/tick-20-loss-1-delay-20/ws",
	"game-tick-loss/tick-20-loss-1-delay-20/wt",
	"game-tick-loss/tick-20-loss-1-delay-20/ws-overlay",
	"game-tick-loss/tick-20-loss-1-delay-40/ws",
	"game-tick-loss/tick-20-loss-1-delay-40/wt",
	"game-tick-loss/tick-20-loss-1-delay-40/ws-overlay",
	"game-tick-loss/tick-20-loss-2.5-delay-20/ws",
	"game-tick-loss/tick-20-loss-2.5-delay-20/wt",
	"game-tick-loss/tick-20-loss-2.5-delay-20/ws-overlay",
	"game-tick-loss/tick-20-loss-2.5-delay-40/ws",
	"game-tick-loss/tick-20-loss-2.5-delay-40/wt",
	"game-tick-loss/tick-20-loss-2.5-delay-40/ws-overlay",
	"game-tick-loss/tick-20-loss-5-delay-20/ws",
	"game-tick-loss/tick-20-loss-5-delay-20/wt",
	"game-tick-loss/tick-20-loss-5-delay-20/ws-overlay",
	"game-tick-loss/tick-20-loss-5-delay-40/ws",
	"game-tick-loss/tick-20-loss-5-delay-40/wt",
	"game-tick-loss/tick-20-loss-5-delay-40/ws-overlay",
	"game-tick-loss/tick-60-loss-1-delay-20/ws",
	"game-tick-loss/tick-60-loss-1-delay-20/wt",
	"game-tick-loss/tick-60-loss-1-delay-20/ws-overlay",
	"game-tick-loss/tick-60-loss-1-delay-40/ws",
	"game-tick-loss/tick-60-loss-1-delay-40/wt",
	"game-tick-loss/tick-60-loss-1-delay-40/ws-overlay",
	"game-tick-loss/tick-60-loss-2.5-delay-20/ws",
	"game-tick-loss/tick-60-loss-2.5-delay-20/wt",
	"game-tick-loss/tick-60-loss-2.5-delay-20/ws-overlay",
	"game-tick-loss/tick-60-loss-2.5-delay-40/ws",
	"game-tick-loss/tick-60-loss-2.5-delay-40/wt",
	"game-tick-loss/tick-60-loss-2.5-delay-40/ws-overlay",
	"game-tick-loss/tick-60-loss-5-delay-20/ws",
	"game-tick-loss/tick-60-loss-5-delay-20/wt",
	"game-tick-loss/tick-60-loss-5-delay-20/ws-overlay",
	"game-tick-loss/tick-60-loss-5-delay-40/ws",
	"game-tick-loss/tick-60-loss-5-delay-40/wt",
	"game-tick-loss/tick-60-loss-5-delay-40/ws-overlay",
	"reconnect-storm/cold-full/ws",
	"reconnect-storm/cold-full/wt",
	"reconnect-storm/warm-after-prime/ws",
	"reconnect-storm/warm-after-prime/wt",
	"connection-memory/live-1000/ws",
	"connection-memory/live-1000/wt",
	"connection-memory/live-5000/ws",
	"connection-memory/live-5000/wt",
	"connection-memory/live-10000/ws",
	"connection-memory/live-10000/wt",
	"crdt-sync/default/ws",
	"crdt-sync/default/wt",
	"ai-token-stream/chunk-32/ws",
	"ai-token-stream/chunk-32/wt",
	"ai-token-stream/chunk-64/ws",
	"ai-token-stream/chunk-64/wt",
	"ai-token-stream/chunk-128/ws",
	"ai-token-stream/chunk-128/wt",
	"ai-token-stream/chunk-256/ws",
	"ai-token-stream/chunk-256/wt",
	"handshake-matrix/physical-cold/ws",
	"handshake-matrix/physical-cold/wt",
	"handshake-matrix/physical-warm-after-prime/ws",
	"handshake-matrix/physical-warm-after-prime/wt",
	"handshake-matrix/delay40-cold/ws",
	"handshake-matrix/delay40-cold/wt",
	"handshake-matrix/delay40-warm-after-prime/ws",
	"handshake-matrix/delay40-warm-after-prime/wt",
	"bulk-one-way/physical/ws",
	"bulk-one-way/physical/wt",
	"bulk-one-way/delay40-loss1/ws",
	"bulk-one-way/delay40-loss1/wt",
	"tail-under-cross-traffic/default/ws",
	"tail-under-cross-traffic/default/wt",
] as const);

export function canonicalBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function artifactPathFor(runInstanceId: string): string {
	return `official/artifacts/${runInstanceId.replaceAll("/", "__")}.json`;
}

export function rawPathFor(runInstanceId: string, kind: RawKind): string {
	return `official/raw/${runInstanceId.replaceAll("/", "__")}/${kind}.ndjson`;
}

export function snapshotPathFor(cellId: string, kind: SnapshotKind): string {
	const filename = kind === "snapshot-pre" ? "pre.ndjson" : "post.ndjson";
	return `official/cell-snapshots/${cellId.replaceAll("/", "__")}/${filename}`;
}

export function cloneFixture(): RepresentativeFixture {
	return structuredClone(representativeFixture());
}

export function setAtPath<T>(
	value: T,
	path: readonly (string | number)[],
	replacement: unknown,
): T {
	const root = structuredClone(value) as Record<string | number, unknown>;
	let cursor: Record<string | number, unknown> = root;
	for (const key of path.slice(0, -1)) {
		cursor = cursor[key] as Record<string | number, unknown>;
	}
	cursor[path[path.length - 1]!] = replacement;
	return root as T;
}

export function flipHexDigest(digest: string): string {
	return `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
}

export function byteFlip(bytes: Uint8Array): Uint8Array {
	const copy = new Uint8Array(bytes);
	copy[0] = copy[0] === 0 ? 1 : 0;
	return copy;
}

export function makeArmDefinitions(
	cells: readonly FixtureScenarioCell[],
): ContractArmDefinition[] {
	const arms: ContractArmDefinition[] = [];
	for (const cell of cells) {
		arms.push({
			armId: `${cell.cellId}/ws`,
			cellId: cell.cellId,
			scenarioId: cell.scenarioId,
			transport: "ws",
			armKind: "primary",
		});
		arms.push({
			armId: `${cell.cellId}/wt`,
			cellId: cell.cellId,
			scenarioId: cell.scenarioId,
			transport: "wt",
			armKind: "primary",
		});
		if (cell.scenarioId === "game-tick-loss") {
			arms.push({
				armId: `${cell.cellId}/ws-overlay`,
				cellId: cell.cellId,
				scenarioId: cell.scenarioId,
				transport: "ws",
				armKind: "overlay",
				overlayOf: `${cell.cellId}/ws`,
			});
		}
	}
	return arms;
}

export function expandPrimarySequence(
	seed: number,
	repetitions: number,
): Array<{ transport: TransportKind; repetitionIndex: number }> {
	const expectedCell = EXPECTED_CELL_CONTRACTS[seed - 20260824];
	const startsWith: TransportKind =
		expectedCell?.expectedStartTransport ?? "ws";
	const other: TransportKind = startsWith === "ws" ? "wt" : "ws";
	const expanded: Array<{ transport: TransportKind; repetitionIndex: number }> =
		[];
	for (
		let repetitionIndex = 0;
		repetitionIndex < repetitions;
		repetitionIndex += 2
	) {
		if (repetitionIndex + 1 === repetitions) {
			expanded.push({ transport: startsWith, repetitionIndex });
			expanded.push({ transport: other, repetitionIndex });
			continue;
		}
		expanded.push({ transport: startsWith, repetitionIndex });
		expanded.push({ transport: other, repetitionIndex });
		expanded.push({ transport: other, repetitionIndex: repetitionIndex + 1 });
		expanded.push({
			transport: startsWith,
			repetitionIndex: repetitionIndex + 1,
		});
	}
	return expanded;
}

export function independentlyExpectedPhaseSequence(
	seed: number,
	repetitions: number,
): Array<{ transport: TransportKind; repetitionIndex: number }> {
	const startsWith =
		EXPECTED_CELL_CONTRACTS[seed - 20260824]?.expectedStartTransport ?? "ws";
	const alternate: TransportKind = startsWith === "ws" ? "wt" : "ws";
	const expected: Array<{ transport: TransportKind; repetitionIndex: number }> =
		[];
	let repetitionIndex = 0;
	while (repetitionIndex < repetitions) {
		if (repetitionIndex + 1 === repetitions) {
			expected.push({ transport: startsWith, repetitionIndex });
			expected.push({ transport: alternate, repetitionIndex });
			break;
		}
		expected.push({ transport: startsWith, repetitionIndex });
		expected.push({ transport: alternate, repetitionIndex });
		expected.push({
			transport: alternate,
			repetitionIndex: repetitionIndex + 1,
		});
		expected.push({
			transport: startsWith,
			repetitionIndex: repetitionIndex + 1,
		});
		repetitionIndex += 2;
	}
	return expected;
}

/**
 * Frozen role-plan oracle used by the RED receipt assertions.  This is built
 * from the literal test-side cell table above; it deliberately does not call
 * representativeFixture(), the production registry, or any manifest helper.
 */
export const R1_FROZEN_ROLE_PLAN = Object.freeze(
	EXPECTED_CELL_TABLE.map((row, cellIndex) => {
		const expected = EXPECTED_CELL_CONTRACTS[cellIndex];
		if (!expected || expected.cellId !== row.cellId) {
			throw new Error(`R1 frozen role-plan mismatch at cell ${cellIndex}`);
		}
		return Object.freeze({
			cellId: row.cellId,
			scenarioId: row.scenarioId,
			macRoles: row.macRoles,
			linuxRole: row.linuxRole,
			direction: row.direction,
			channels: row.channels,
			sharding: row.sharding,
			processCohort: row.processCohort,
			warmupRepetitions: expected.warmupRepetitions,
			measuredRepetitions: expected.measuredRepetitions,
			expectedStartTransport: expected.expectedStartTransport,
			hasOverlay: expected.hasOverlay,
		});
	}),
);

export interface R1RoleTupleOracleEntry {
	readonly executionIndex: number;
	readonly phase: PhaseKind;
	readonly runId: string;
	readonly cellId: string;
	readonly scenarioId: string;
	readonly armId: string;
	readonly transport: TransportKind;
	readonly armKind: ContractArmKind;
	readonly overlayOf?: string;
	readonly repetitionIndex: number;
	readonly logicalRole: "campaign-child";
	readonly processOrdinal: 0;
}

/**
 * Independent literal/recomputed 588-entry oracle.  The only schedule inputs
 * are R1_FROZEN_ROLE_PLAN and independentlyExpectedPhaseSequence(); actual
 * launch receipts are compared against this projection in the RED suite.
 */
const r1RoleTupleOracleUnindexed = Object.freeze(
	R1_FROZEN_ROLE_PLAN.flatMap((cell, cellIndex) => {
		const entries: R1RoleTupleOracleEntry[] = [];
		for (const [phase, repetitions] of [
			["warmup", cell.warmupRepetitions],
			["measured", cell.measuredRepetitions],
		] as const) {
			for (const slot of independentlyExpectedPhaseSequence(
				20260824 + cellIndex,
				repetitions,
			)) {
				const armId = `${cell.cellId}/${slot.transport}`;
				entries.push({
					executionIndex: 0,
					phase,
					runId: `${phase}/${armId}/rep-${String(slot.repetitionIndex).padStart(2, "0")}`,
					cellId: cell.cellId,
					scenarioId: cell.scenarioId,
					armId,
					transport: slot.transport,
					armKind: "primary",
					repetitionIndex: slot.repetitionIndex,
					logicalRole: "campaign-child",
					processOrdinal: 0,
				});
				if (
					cell.hasOverlay &&
					cell.scenarioId === "game-tick-loss" &&
					slot.transport === "ws"
				) {
					const overlayArmId = `${cell.cellId}/ws-overlay`;
					entries.push({
						executionIndex: 0,
						phase,
						runId: `${phase}/${overlayArmId}/rep-${String(slot.repetitionIndex).padStart(2, "0")}`,
						cellId: cell.cellId,
						scenarioId: cell.scenarioId,
						armId: overlayArmId,
						transport: "ws",
						armKind: "overlay",
						overlayOf: armId,
						repetitionIndex: slot.repetitionIndex,
						logicalRole: "campaign-child",
						processOrdinal: 0,
					});
				}
			}
		}
		return entries;
	}),
);

export const R1_ROLE_TUPLE_ORACLE = Object.freeze(
	r1RoleTupleOracleUnindexed.map((entry, executionIndex) => ({
		...entry,
		executionIndex,
	})),
);
export const R1_ROLE_TUPLE_ORACLE_BYTES = canonicalBytes({
	schema: "r1-role-tuple-oracle/v1",
	tuples: R1_ROLE_TUPLE_ORACLE,
});
export const R1_ROLE_TUPLE_ORACLE_SHA256 =
	"0a1e877980431685b41ce9af3b2100cf0421da194a39031f8e2a2e96ed3df952" as const;

export function measuredArtifactRecordFor(
	entry: ManifestRunEntry,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		runInstanceId: entry.runInstanceId,
		cellId: entry.cellId,
		scenarioId: entry.scenarioId,
		phase: entry.phase,
		transport: entry.transport,
		armKind: entry.armKind,
		...(entry.overlayOf === undefined ? {} : { overlayOf: entry.overlayOf }),
		repetitionIndex: entry.repetitionIndex,
		evidenceStatus: "PASS",
		scenarioVerdict: "PASS",
		promotable: true,
		metricContractId: `${entry.scenarioId}.contract.v1`,
		metricName: "latency_ms",
		metricUnit: "ms",
		metricDirection: "lower",
		samples: [10, 12, 14],
		percentiles: { p50: 12, p95: 14, p99: 14 },
		ledger: { attempted: 3, delivered: 3, dropped: 0 },
		topology: {
			macHostId: "mac-controller-01",
			linuxHostId: "linux-bench-01",
		},
		tls: { sni: "wt-compare.local", compression: "off" },
		telemetry: {
			mac: { cpuPercent: 25, rssBytes: 134_217_728 },
			linux: { cpuPercent: 20, rssBytes: 268_435_456 },
		},
		sharedIdentity: entry.sharedIdentity,
		rawSidecarDigests: Object.fromEntries(
			entry.rawDescriptors.map((descriptor) => [
				descriptor.kind,
				descriptor.sha256,
			]),
		),
		...overrides,
	};
}

export function representativeFixture(): RepresentativeFixture {
	const candidateId = "9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4";
	const campaignId = "campaign-direct-cable-2026-08-24";
	const reviewedCleanHead = "9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4";
	const archiveBytes = canonicalBytes({
		candidateId,
		reviewedCleanHead,
		root: "tools/compare",
	});
	const armDefinitions = makeArmDefinitions(FIXTURE_SCENARIO_CELLS);
	const registryBytes = canonicalBytes({
		schemaVersion: "v1",
		canonical: true,
		capacityProfile: TEST_CAPACITY_PROFILE,
		capacityProfileHash: TEST_CAPACITY_PROFILE_HASH,
		connectionSetup: TEST_CONNECTION_SETUP,
		cells: FIXTURE_SCENARIO_CELLS,
		arms: armDefinitions,
	});
	const specBytes = canonicalBytes({
		specId: "2026-08-22-ws-wt-scenario-comparison-design",
		requiredTopology: {
			mac: "10.99.0.1/en8",
			linux: "10.99.0.2/eno1",
		},
	});
	const capacityBytes = canonicalBytes(TEST_CAPACITY_PROFILE);
	const archiveSha256 = sha256Hex(archiveBytes);
	const registrySha256 = sha256Hex(registryBytes);
	const specSha256 = sha256Hex(specBytes);
	const capacitySha256 = sha256Hex(capacityBytes);
	const jsExecutableSha256 = sha256Hex(
		canonicalBytes({
			entrypoint: "tools/compare/run-campaign.ts",
			candidateId,
		}),
	);
	const darwinNativeSha256 = sha256Hex(
		canonicalBytes({
			binary: "prebuilds/darwin-arm64/webtransport.node",
			candidateId,
		}),
	);
	const linuxNativeSha256 = sha256Hex(
		canonicalBytes({
			binary: "prebuilds/linux-x64/webtransport.node",
			candidateId,
		}),
	);

	const artifactBytesByPath: Record<string, Uint8Array> = {};
	const rawBytesByPath: Record<string, Uint8Array> = {};
	const snapshotBytesByPath: Record<string, Uint8Array> = {};
	const cellSnapshotBundlesPrelock: Array<{
		cellId: string;
		preCellPath: string;
		postCellPath: string;
	}> = [];
	const runEntriesPrelock: Array<
		Omit<
			ManifestRunEntry,
			"artifact" | "rawDescriptors" | "cellSnapshotBundle" | "sharedIdentity"
		> & {
			artifactPath: string;
			artifactBytes: Uint8Array;
			rawPrelock: Array<
				Omit<RawDescriptor, "sha256" | "lockDigestSha256"> & {
					bytes: Uint8Array;
				}
			>;
			cellSnapshotBundlePrelock: Omit<
				CellSnapshotBundle,
				"preCell" | "postCell"
			> & {
				preCellPath: string;
				postCellPath: string;
			};
		}
	> = [];

	for (const [cellIndex, cell] of FIXTURE_SCENARIO_CELLS.entries()) {
		const seed = 20260824 + cellIndex;
		const preCellPath = snapshotPathFor(cell.cellId, "snapshot-pre");
		const postCellPath = snapshotPathFor(cell.cellId, "snapshot-post");
		snapshotBytesByPath[preCellPath] = canonicalBytes({
			cellId: cell.cellId,
			candidateId,
			campaignId,
			kind: "snapshot-pre",
			requiredBeforeQdisc: "fq",
			supervisorPolicy: "dedicated-process-group",
		});
		snapshotBytesByPath[postCellPath] = canonicalBytes({
			cellId: cell.cellId,
			candidateId,
			campaignId,
			kind: "snapshot-post",
			restoredQdisc: "fq",
			dedicatedPgidObserved: 4300 + cellIndex,
			cleanupStatus: "restored-and-released",
		});
		cellSnapshotBundlesPrelock.push({
			cellId: cell.cellId,
			preCellPath,
			postCellPath,
		});

		for (const [phase, repetitions] of [
			["warmup", cell.runPolicy.warmupRepetitions],
			["measured", cell.runPolicy.measuredRepetitions],
		] as const) {
			const primarySequence = expandPrimarySequence(seed, repetitions);
			for (const slot of primarySequence) {
				const armId = `${cell.cellId}/${slot.transport}`;
				const runInstanceId = `${phase}/${armId}/rep-${String(slot.repetitionIndex).padStart(2, "0")}`;
				const artifactPath = artifactPathFor(runInstanceId);
				const artifactBytes = canonicalBytes({
					runInstanceId,
					candidateId,
					campaignId,
					phase,
					armId,
					transport: slot.transport,
					repetitionIndex: slot.repetitionIndex,
					seed,
				});
				artifactBytesByPath[artifactPath] = artifactBytes;
				const rawPrelock = (
					[
						["client", "mac"],
						["server", "linux"],
						["topology", "linux"],
						["impairment", "linux"],
						["cleanup", "linux"],
					] as const
				).map(([kind, host]) => {
					const relativePath = rawPathFor(runInstanceId, kind);
					const bytes = canonicalBytes({
						runInstanceId,
						candidateId,
						campaignId,
						phase,
						armId,
						repetitionIndex: slot.repetitionIndex,
						kind,
						host,
					});
					rawBytesByPath[relativePath] = bytes;
					return {
						relativePath,
						kind,
						host,
						phase,
						armId,
						repetitionIndex: slot.repetitionIndex,
						candidateId,
						campaignId,
						bytes,
					};
				});
				runEntriesPrelock.push({
					runInstanceId,
					executionIndex: 0,
					phase,
					excludeFromDelta: phase !== "measured",
					excludeFromRanking: phase !== "measured",
					excludeFromPromotion: true,
					candidateId,
					campaignId,
					cellId: cell.cellId,
					scenarioId: cell.scenarioId,
					armId,
					transport: slot.transport,
					armKind: "primary",
					repetitionIndex: slot.repetitionIndex,
					seed,
					phasePrimaryTransportSequence: primarySequence.map(
						({ transport }) => transport,
					),
					artifactPath,
					artifactBytes,
					rawPrelock,
					cellSnapshotBundlePrelock: {
						cellId: cell.cellId,
						preCellPath,
						postCellPath,
					},
				});
				if (cell.scenarioId === "game-tick-loss" && slot.transport === "ws") {
					const overlayArmId = `${cell.cellId}/ws-overlay`;
					const overlayRunInstanceId = `${phase}/${overlayArmId}/rep-${String(slot.repetitionIndex).padStart(2, "0")}`;
					const overlayArtifactPath = artifactPathFor(overlayRunInstanceId);
					const overlayArtifactBytes = canonicalBytes({
						runInstanceId: overlayRunInstanceId,
						candidateId,
						campaignId,
						phase,
						armId: overlayArmId,
						transport: "ws",
						repetitionIndex: slot.repetitionIndex,
						overlayOf: armId,
						seed,
					});
					artifactBytesByPath[overlayArtifactPath] = overlayArtifactBytes;
					const overlayRawPrelock = (
						[
							["client", "mac"],
							["server", "linux"],
							["topology", "linux"],
							["impairment", "linux"],
							["cleanup", "linux"],
						] as const
					).map(([kind, host]) => {
						const relativePath = rawPathFor(overlayRunInstanceId, kind);
						const bytes = canonicalBytes({
							runInstanceId: overlayRunInstanceId,
							candidateId,
							campaignId,
							phase,
							armId: overlayArmId,
							repetitionIndex: slot.repetitionIndex,
							overlayOf: armId,
							kind,
							host,
						});
						rawBytesByPath[relativePath] = bytes;
						return {
							relativePath,
							kind,
							host,
							phase,
							armId: overlayArmId,
							repetitionIndex: slot.repetitionIndex,
							candidateId,
							campaignId,
							bytes,
						};
					});
					runEntriesPrelock.push({
						runInstanceId: overlayRunInstanceId,
						executionIndex: 0,
						phase,
						excludeFromDelta: true,
						excludeFromRanking: true,
						excludeFromPromotion: true,
						candidateId,
						campaignId,
						cellId: cell.cellId,
						scenarioId: cell.scenarioId,
						armId: overlayArmId,
						transport: "ws",
						armKind: "overlay",
						overlayOf: armId,
						repetitionIndex: slot.repetitionIndex,
						seed,
						phasePrimaryTransportSequence: primarySequence.map(
							({ transport }) => transport,
						),
						artifactPath: overlayArtifactPath,
						artifactBytes: overlayArtifactBytes,
						rawPrelock: overlayRawPrelock,
						cellSnapshotBundlePrelock: {
							cellId: cell.cellId,
							preCellPath,
							postCellPath,
						},
					});
				}
			}
		}
	}

	const lockCore = {
		lockVersion: "v1",
		candidateId,
		campaignId,
		source: {
			reviewedCleanHead,
			reviewedTreeState: "clean",
			archiveSha256,
			stagedArchiveSha256: archiveSha256,
			jsExecutableSha256,
			darwinNativeSha256,
			linuxNativeSha256,
			toolchains: {
				js: {
					identity: "bun-1.3.14-darwin-arm64",
					sha256: sha256Hex(
						canonicalBytes({ runtime: "bun", version: "1.3.14" }),
					),
				},
				darwin: {
					identity: "darwin-arm64-rust-1.82.0-clang-18.1.8",
					sha256: sha256Hex(canonicalBytes({ os: "darwin", rust: "1.82.0" })),
				},
				linux: {
					identity: "linux-x64-rust-1.82.0-clang-18.1.8",
					sha256: sha256Hex(canonicalBytes({ os: "linux", rust: "1.82.0" })),
				},
			},
		},
		submissions: {
			registrySha256,
			specSha256,
			capacitySha256,
		},
		topology: {
			kind: "direct-cable",
			macHostId: "mac-controller-01",
			linuxHostId: "linux-bench-01",
			macInterface: "en8",
			linuxInterface: "eno1",
			macAddress: "10.99.0.1",
			linuxAddress: "10.99.0.2",
			requiredRoutes: {
				mac: {
					destination: "10.99.0.2/32",
					interface: "en8",
					gateway: null,
					path: "direct-cable",
				},
				linux: {
					destination: "10.99.0.1/32",
					interface: "eno1",
					gateway: null,
					path: "direct-cable",
				},
			},
			expectedPeerRelationship: {
				macPeerHostId: "linux-bench-01",
				linuxPeerHostId: "mac-controller-01",
			},
		},
		hosts: {
			mac: {
				hostId: "mac-controller-01",
				os: "darwin-26.0.0",
				arch: "arm64",
				interface: "en8",
				address: "10.99.0.1",
				mtu: 1500,
				route: {
					destination: "10.99.0.2/32",
					interface: "en8",
					gateway: null,
					path: "direct-cable",
				},
				expectedPeer: {
					hostId: "linux-bench-01",
					address: "10.99.0.2",
					interface: "eno1",
				},
			},
			linux: {
				hostId: "linux-bench-01",
				os: "ubuntu-26.04-x86_64",
				arch: "x86_64",
				interface: "eno1",
				address: "10.99.0.2",
				mtu: 1500,
				route: {
					destination: "10.99.0.1/32",
					interface: "eno1",
					gateway: null,
					path: "direct-cable",
				},
				expectedPeer: {
					hostId: "mac-controller-01",
					address: "10.99.0.1",
					interface: "en8",
				},
			},
		},
		tls: {
			sni: "wt-compare.local",
			certificateSha256: sha256Hex(
				canonicalBytes({ cert: "leaf", campaignId }),
			),
			caSha256: sha256Hex(canonicalBytes({ cert: "ca", campaignId })),
			rejectUnauthorized: true,
			compression: "off",
		},
		resourceContract: {
			mac: {
				fdSoftLimit: 65536,
				ephemeralPortRange: [49152, 65535],
			},
			linux: {
				fdSoftLimit: 65536,
				ephemeralPortRange: [49152, 65535],
			},
		},
		supervisorPolicy: {
			dedicatedProcessGroupRequired: true,
			flockPath: "official/staging/locks/bench.lock",
			leasePath: "official/staging/locks/bench.lease",
			leaseMs: 15000,
		},
		executionPlan: {
			warmupRuns: 98,
			measuredRuns: 490,
			totalRuns: 588,
			cellPhaseSequences: FIXTURE_SCENARIO_CELLS.flatMap((cell, index) =>
				(["warmup", "measured"] as const).map((phase) => ({
					cellId: cell.cellId,
					phase,
					seed: 20260824 + index,
					sequence: expandPrimarySequence(
						20260824 + index,
						phase === "warmup"
							? cell.runPolicy.warmupRepetitions
							: cell.runPolicy.measuredRepetitions,
					).map(
						({ transport, repetitionIndex }) =>
							`${transport}@${repetitionIndex}`,
					),
				})),
			),
		},
	};
	const lock = {
		...lockCore,
		rawBindings: {
			artifactCount: runEntriesPrelock.length,
			rawDescriptorCount: runEntriesPrelock.length * 5,
			cellSnapshotBundleCount: cellSnapshotBundlesPrelock.length,
		},
	};
	const lockBytes = canonicalBytes(lock);
	const expectedLockDigest = sha256Hex(lockBytes);
	const sharedIdentity: SharedIdentity = {
		candidateId,
		campaignId,
		lockDigestSha256: expectedLockDigest,
		archiveSha256,
		stagedArchiveSha256: archiveSha256,
		registrySha256,
		specSha256,
		capacitySha256,
		reviewedCleanHead,
		jsExecutableSha256,
		darwinNativeSha256,
		linuxNativeSha256,
	};
	const cellSnapshotBundles = cellSnapshotBundlesPrelock.map((bundle) => ({
		cellId: bundle.cellId,
		preCell: {
			relativePath: bundle.preCellPath,
			sha256: sha256Hex(snapshotBytesByPath[bundle.preCellPath]!),
			kind: "snapshot-pre" as const,
			cellId: bundle.cellId,
			candidateId,
			campaignId,
			lockDigestSha256: expectedLockDigest,
		},
		postCell: {
			relativePath: bundle.postCellPath,
			sha256: sha256Hex(snapshotBytesByPath[bundle.postCellPath]!),
			kind: "snapshot-post" as const,
			cellId: bundle.cellId,
			candidateId,
			campaignId,
			lockDigestSha256: expectedLockDigest,
		},
	}));
	const cellSnapshotByCellId = new Map(
		cellSnapshotBundles.map((bundle) => [bundle.cellId, bundle]),
	);
	const runEntries = runEntriesPrelock.map(
		(entry, executionIndex): ManifestRunEntry => ({
			runInstanceId: entry.runInstanceId,
			executionIndex,
			phase: entry.phase,
			excludeFromDelta: entry.excludeFromDelta,
			excludeFromRanking: entry.excludeFromRanking,
			excludeFromPromotion: true,
			candidateId,
			campaignId,
			cellId: entry.cellId,
			scenarioId: entry.scenarioId,
			armId: entry.armId,
			transport: entry.transport,
			armKind: entry.armKind,
			overlayOf: entry.overlayOf,
			repetitionIndex: entry.repetitionIndex,
			seed: entry.seed,
			phasePrimaryTransportSequence: entry.phasePrimaryTransportSequence,
			artifact: {
				relativePath: entry.artifactPath,
				sha256: sha256Hex(entry.artifactBytes),
				phase: entry.phase,
				armId: entry.armId,
				transport: entry.transport,
				repetitionIndex: entry.repetitionIndex,
				candidateId,
				campaignId,
				lockDigestSha256: expectedLockDigest,
			},
			rawDescriptors: entry.rawPrelock.map((descriptor) => ({
				relativePath: descriptor.relativePath,
				sha256: sha256Hex(descriptor.bytes),
				kind: descriptor.kind,
				host: descriptor.host,
				phase: descriptor.phase,
				armId: descriptor.armId,
				repetitionIndex: descriptor.repetitionIndex,
				candidateId,
				campaignId,
				lockDigestSha256: expectedLockDigest,
			})) as unknown as ManifestRunEntry["rawDescriptors"],
			cellSnapshotBundle: cellSnapshotByCellId.get(entry.cellId)!,
			sharedIdentity,
		}),
	);
	const observedAttestationModel = {
		lockDigestSha256: expectedLockDigest,
		candidateId,
		campaignId,
		source: {
			reviewedCleanHead,
			reviewedTreeState: "clean",
			jsExecutableSha256,
			darwinNativeSha256,
			linuxNativeSha256,
			toolchains: {
				js: {
					identity: "bun-1.3.14-darwin-arm64",
					sha256: sha256Hex(
						canonicalBytes({ runtime: "bun", version: "1.3.14" }),
					),
				},
				darwin: {
					identity: "darwin-arm64-rust-1.82.0-clang-18.1.8",
					sha256: sha256Hex(canonicalBytes({ os: "darwin", rust: "1.82.0" })),
				},
				linux: {
					identity: "linux-x64-rust-1.82.0-clang-18.1.8",
					sha256: sha256Hex(canonicalBytes({ os: "linux", rust: "1.82.0" })),
				},
			},
		},
		submissions: {
			archive: { bytes: archiveBytes, sha256: archiveSha256 },
			registry: { bytes: registryBytes, sha256: registrySha256 },
			spec: { bytes: specBytes, sha256: specSha256 },
			capacity: { bytes: capacityBytes, sha256: capacitySha256 },
		},
		stagedArchivesByHost: [
			{
				hostId: "mac-controller-01",
				bytes: archiveBytes,
				sha256: archiveSha256,
			},
			{ hostId: "linux-bench-01", bytes: archiveBytes, sha256: archiveSha256 },
		],
		observedCellSnapshots: cellSnapshotBundles,
		observedHostFacts: {
			mac: {
				hostId: "mac-controller-01",
				address: "10.99.0.1",
				interface: "en8",
				mtu: 1500,
				route: {
					destination: "10.99.0.2/32",
					interface: "en8",
					gateway: null,
					path: "direct-cable",
				},
				peer: {
					hostId: "linux-bench-01",
					address: "10.99.0.2",
					interface: "eno1",
				},
			},
			linux: {
				hostId: "linux-bench-01",
				address: "10.99.0.2",
				interface: "eno1",
				mtu: 1500,
				route: {
					destination: "10.99.0.1/32",
					interface: "eno1",
					gateway: null,
					path: "direct-cable",
				},
				peer: {
					hostId: "mac-controller-01",
					address: "10.99.0.1",
					interface: "en8",
				},
			},
		},
		observedSupervisorFacts: {
			dedicatedProcessGroupObserved: 4301,
			lockFileHeld: true,
			leaseFileHeld: true,
			leaseMs: 15000,
			cleanupCompleted: true,
		},
		observedRunFacts: runEntries.map((entry) => ({
			runInstanceId: entry.runInstanceId,
			executionIndex: entry.executionIndex,
			orderHash: sha256Hex(
				canonicalBytes({
					runInstanceId: entry.runInstanceId,
					executionIndex: entry.executionIndex,
				}),
			),
			phase: entry.phase,
			cellId: entry.cellId,
			scenarioId: entry.scenarioId,
			armId: entry.armId,
			transport: entry.transport,
			repetitionIndex: entry.repetitionIndex,
			routePath: "direct-cable",
			macPeerHostId: "linux-bench-01",
			linuxPeerHostId: "mac-controller-01",
			qdiscBefore: "fq",
			qdiscAfter: "fq",
			restored: true,
			dedicatedPgidObserved: 4301,
			cleanupStatus: "restored-and-released",
			rolePlan: {
				direction: FIXTURE_SCENARIO_CELLS.find(
					(cell) => cell.cellId === entry.cellId,
				)!.rolePlan.direction,
				linuxRole: FIXTURE_SCENARIO_CELLS.find(
					(cell) => cell.cellId === entry.cellId,
				)!.rolePlan.linuxRole,
				macRoles: FIXTURE_SCENARIO_CELLS.find(
					(cell) => cell.cellId === entry.cellId,
				)!.rolePlan.macRoles,
				sharding: FIXTURE_SCENARIO_CELLS.find(
					(cell) => cell.cellId === entry.cellId,
				)!.rolePlan.sharding,
				processCohort: FIXTURE_SCENARIO_CELLS.find(
					(cell) => cell.cellId === entry.cellId,
				)!.rolePlan.processCohort,
			},
		})),
		observedWtFacts: runEntries
			.filter((entry) => entry.transport === "wt")
			.map((entry) => ({
				runInstanceId: entry.runInstanceId,
				wtPrimitive:
					entry.scenarioId === "game-tick-loss" ? "datagram" : "stream",
				zeroRttOutcome: "not-attempted",
				resumptionOutcome: "disabled",
			})),
		executionPlan: {
			warmupRuns: 98,
			measuredRuns: 490,
			totalRuns: 588,
			cellPhaseSequences: FIXTURE_SCENARIO_CELLS.flatMap((cell, index) =>
				(["warmup", "measured"] as const).map((phase) => ({
					cellId: cell.cellId,
					phase,
					seed: 20260824 + index,
					sequence: expandPrimarySequence(
						20260824 + index,
						phase === "warmup"
							? cell.runPolicy.warmupRepetitions
							: cell.runPolicy.measuredRepetitions,
					).map(
						({ transport, repetitionIndex }) =>
							`${transport}@${repetitionIndex}`,
					),
				})),
			),
		},
	};
	const stagedCapability = {
		schemaVersion: "v1",
		candidateId,
		campaignId,
		locator: "official/staging/capabilities/campaign-r1.cap",
		stagingId: "staging-2026-08-24-r1",
		stagingRootIdentity:
			"official/staging/root/campaign-direct-cable-2026-08-24",
		lockDigestSha256: expectedLockDigest,
		archiveSha256,
		stagedArchiveSha256: archiveSha256,
		issuedAtMs: Date.UTC(2026, 7, 24, 10, 0, 0),
		notAfterMs: Date.UTC(2026, 7, 24, 22, 0, 0),
		fixtureOnly: false,
		hostSubmissions: [
			{
				hostId: "mac-controller-01",
				platform: "darwin-arm64",
				lockDigestSha256: expectedLockDigest,
				archiveSha256,
				stagedArchiveSha256: archiveSha256,
				stagingRootIdentity:
					"official/staging/root/campaign-direct-cable-2026-08-24",
				osIdentity: {
					system: "Darwin",
					release: "26.0.0",
					architecture: "arm64",
					identitySha256: r1FixtureDigest("mac-os-identity"),
				},
			},
			{
				hostId: "linux-bench-01",
				platform: "linux-x86_64",
				lockDigestSha256: expectedLockDigest,
				archiveSha256,
				stagedArchiveSha256: archiveSha256,
				stagingRootIdentity:
					"official/staging/root/campaign-direct-cable-2026-08-24",
				osIdentity: {
					system: "Linux",
					release: "6.11.0",
					architecture: "x86_64",
					identitySha256: r1FixtureDigest("linux-os-identity"),
				},
			},
		],
	};
	const stagedCapabilityBytes = canonicalBytes(stagedCapability);
	const expectedCapabilityDigest = sha256Hex(stagedCapabilityBytes);
	const fixtureOnlyCapabilityBytes = canonicalBytes({
		...stagedCapability,
		fixtureOnly: true,
	});
	// This is the independently frozen controller authority digest.  The
	// fixture never derives trust from the manifest or its child records.
	const manifestAuthoritySha256 =
		"8197fcb693dbd28504a42a198bff2b497d51540db5a0b56d63a69f09a402aaa8";
	// The canonical manifest is frozen independently of the legacy representative
	// projection above.  Keep its parent links literal so the fixture cannot
	// silently inherit a self-derived lock/capability digest.
	const manifestLockSha256 =
		"bf92c321da208ac5868c3404641e60a427f2de0a6597c6ac63a72c3d29805320";
	const manifestCapabilitySha256 =
		"700ed6ac98785890dd507ff79b0ec35435ea3747793a7cabedfbb4f93a5a217d";
	const manifestScheduleHash = sha256Hex(
		canonicalBytes(
			runEntries.map((entry, cellIndex) => ({
				executionIndex: entry.executionIndex,
				cellIndex: FIXTURE_SCENARIO_CELLS.findIndex(
					(cell) => cell.cellId === entry.cellId,
				),
				cellId: entry.cellId,
				scenarioId: entry.scenarioId,
				phase: entry.phase,
				armId: entry.armId,
				transport: entry.transport,
				armKind: entry.armKind,
				overlayOf: entry.overlayOf ?? null,
				repetitionIndex: entry.repetitionIndex,
				seed: entry.seed,
				macHostId: "mac-controller-01",
				linuxHostId: "linux-bench-01",
				cellOrdinal: cellIndex,
			})),
		),
	);
	const exactCardinality: CardinalityV1 = {
		cellCount: 35,
		armCount: 82,
		wsPrimaryArmCount: 35,
		wtPrimaryArmCount: 35,
		overlayArmCount: 12,
		primaryWarmupCount: 86,
		primaryMeasuredCount: 430,
		overlayWarmupCount: 12,
		overlayMeasuredCount: 60,
		warmupExecutionCount: 98,
		measuredExecutionCount: 490,
		primaryExecutionCount: 516,
		executionCount: 588,
		wsPrimaryExecutionCount: 258,
		wtPrimaryExecutionCount: 258,
		wsOverlayExecutionCount: 72,
		artifactCount: 588,
		rawClientCount: 588,
		rawServerCount: 588,
		rawTopologyCount: 588,
		rawImpairmentCount: 588,
		rawCleanupCount: 588,
		rawDescriptorCount: 2940,
		snapshotPreCount: 35,
		snapshotPostCount: 35,
		snapshotDescriptorCount: 70,
		attestationCount: 1,
		descriptorCount: 3599,
	};
	const observedAttestation = Object.freeze({
		schema: "observed-attestation/v1" as const,
		authoritySha256: manifestAuthoritySha256,
		lockSha256: manifestLockSha256,
		capabilitySha256: manifestCapabilitySha256,
		candidate: candidateId,
		campaignId,
		observedSource: {
			archiveSha256:
				"93d5a67391893c426f84ae4bff6b7ea95204ff7b13b009c7aefe691a8cd6cfcc",
			macStagedArchiveSha256:
				"1a1ead0b8a5b1abd2fa4631888a5a70aca28ba7503526178ffb58b5f2be6fae4",
			linuxStagedArchiveSha256:
				"e9c9e5d8f2ff188c2f07740e8d4fe0d5182b1984187d23b4f6eeac5734e6d312",
			macBunSha256:
				"7700ebfce0959823a7e4c8217ad6a8440337ea2a30b982bd1bc4f9e652c844cc",
			linuxBunSha256:
				"dfe8033d00623450ca82c5ec1e9ac2a84911a65dbec27ad7a1da8ed2e1519c79",
			macSupervisorSha256:
				"d94b9ea5cf5a777bca65b985682206033877fd7868010aa0c20c224c8da222e7",
			linuxSupervisorSha256:
				"b7bd58de6a247e05d29cce307d565859cb1e7ac5916d85385386db9b6008394e",
			macRoleEntrypointsSha256:
				"f2ed579d5e4eb251a81801658d933213060fad52dfaae15ba124c10477bb6682",
			linuxRoleEntrypointsSha256:
				"832af3e5324cd554e31cdd47a175930f385b569c2b63d9e8710e870ab542ebb4",
			macAddonSha256:
				"a71c40e2ad2e5c83bddec8073534627f11c0049ed575ea44b13f4d5d9e55aba5",
			linuxAddonSha256:
				"dd08b3476a16a13fd3a290c0bdc26f8803eae669110850b6b4866f57d235cad9",
		},
		sshHostReceiptSha256:
			"cc19343bae77f29243dd7d23bdfec452c53ff8376f0a94316b6e8b48ae76faf2",
		stagedMetadataReceiptSetSha256:
			"6ef9f98d21a51eccbe49a3b5e60a944524adfdb74010b0b3a43dd05f86a31131",
		supervisorObservationSetSha256:
			"1114d6ee51ad9071cd3926192f5028a42b5542cffd3ee4974b34050fe371d9c5",
		macRouteFactsSha256:
			"d761a600caa50c84b845585badaa7d2939b2b9eb67b98ae318ce02b0faa67962",
		linuxRouteFactsSha256:
			"686e4f8f28063e40fd0078478a1765da5e378d7a382af6d841f987514fd6fd50",
		serverPeerFactsSha256:
			"df5f0dc7dce245991b309b45f4f140f2d0a6bd785722cc7efa815f8e0a4e5040",
		qdiscFactsSha256:
			"1f4714efe8f7286df0e5f4a1f18baec0104a78c0b1478728d30aed29d9d16576",
		tlsFactsSha256:
			"21dbcadc8cae546e9e5633a7128856d88c22dc7f8963ca1fffc8fe189e43c4a9",
		roleFactsSha256:
			"22ee7412a6a434d56cf564bd497e5f70337dd942df21376ec5574b3983d388ad",
		bunRoleLaunchReceiptSetSha256:
			"bbc22875073ab141c194e3e71aba174a80990bb2a960ac7443ec81c4338b6d3c",
		macRuntimeFactsSha256:
			"ab3dd866b16a972a1cca0774177824a1be29ece22843533778ed53b80a3e859c",
		linuxRuntimeFactsSha256:
			"c026dcf1ac1e183615f755b529d193abf21bbce008dc9ff747b64a260aee96dc",
		wtFactsSha256:
			"0ec1aa1bc81851ff6373af6b6c4fbd4da49e5cfabb668d94676b7c414ba07e19",
		telemetryFactsSha256:
			"ff03038fe6ede4b65112df6ccef6773312cc992112c059603b3383a212da5621",
		cleanupFactsSha256:
			"c56b6f4574bfd5434a48827c46ba53eac9edd0683faa1efcb9ab862d1b16988e",
		runFactsSha256:
			"271eb7c786d62a80bd1bf27ecd2c3dd77f45f9a60bb592c65f8d2b0cca6f9d03",
		pathSnapshotCount: 70 as const,
		runNetworkReceiptCount: 588 as const,
		qdiscRunReceiptCount: 588 as const,
		cleanupRunReceiptCount: 588 as const,
		childAuthoredObservationForbidden: true as const,
		observedAt: "2026-08-24T12:35:00.000Z",
	});
	const exactDescriptors: EvidenceDescriptorV1[] = [];
	const pushDescriptor = (
		kind: EvidenceDescriptorV1["kind"],
		components: string[],
		bytes: Uint8Array,
		hostId: string,
		cellId: string,
		runId: string | null,
		executionIndex: number | null,
	) => {
		exactDescriptors.push({
			schema: "evidence-descriptor/v1",
			kind,
			components: components as [string, ...string[]],
			sha256: sha256Hex(bytes),
			size: bytes.byteLength,
			candidate: candidateId,
			campaignId,
			authoritySha256: manifestAuthoritySha256,
			lockSha256: manifestLockSha256,
			capabilitySha256: manifestCapabilitySha256,
			hostId,
			cellId,
			runId,
			executionIndex,
		});
	};
	for (const entry of runEntries) {
		const runToken = entry.runInstanceId.replaceAll("/", "__");
		pushDescriptor(
			"artifact",
			["official", "artifacts", `${runToken}.json`],
			artifactBytesByPath[entry.artifact.relativePath]!,
			"mac-controller-01",
			entry.cellId,
			entry.runInstanceId,
			entry.executionIndex,
		);
		for (const raw of entry.rawDescriptors) {
			pushDescriptor(
				`raw-${raw.kind}` as EvidenceDescriptorV1["kind"],
				["official", "raw", runToken, `${raw.kind}.ndjson`],
				rawBytesByPath[raw.relativePath]!,
				raw.kind === "client" ? "mac-controller-01" : "linux-bench-01",
				entry.cellId,
				entry.runInstanceId,
				entry.executionIndex,
			);
		}
	}
	for (const bundle of cellSnapshotBundles) {
		const cellToken = bundle.cellId.replaceAll("/", "__");
		pushDescriptor(
			"snapshot-pre",
			["official", "cell-snapshots", cellToken, "pre.ndjson"],
			snapshotBytesByPath[bundle.preCell.relativePath]!,
			"mac-controller-01",
			bundle.cellId,
			null,
			null,
		);
		pushDescriptor(
			"snapshot-post",
			["official", "cell-snapshots", cellToken, "post.ndjson"],
			snapshotBytesByPath[bundle.postCell.relativePath]!,
			"mac-controller-01",
			bundle.cellId,
			null,
			null,
		);
	}
	pushDescriptor(
		"attestation",
		["official", "observed-attestation.json"],
		canonicalBytes(observedAttestation),
		"mac-controller-01",
		"campaign",
		null,
		null,
	);
	const manifestEnvelope = {
		schema: "campaign-manifest/v1",
		authoritySha256: manifestAuthoritySha256,
		lockSha256: manifestLockSha256,
		capabilitySha256: manifestCapabilitySha256,
		candidate: candidateId,
		campaignId,
		registryHash: registrySha256,
		scheduleHash: manifestScheduleHash,
		cardinality: exactCardinality,
		descriptors: Object.freeze(exactDescriptors),
		sealedAt: "2026-08-24T12:31:00.000Z",
	};
	const manifest = Object.defineProperties(manifestEnvelope, {
		runEntries: { value: runEntries, enumerable: false },
		cellSnapshotBundles: { value: cellSnapshotBundles, enumerable: false },
	}) as unknown as CampaignManifestV1;

	const measuredPrimaryEntry = runEntries.find(
		(entry) =>
			entry.phase === "measured" &&
			entry.transport === "ws" &&
			entry.armKind === "primary",
	)!;
	const measuredArtifactValue = measuredArtifactRecordFor(
		measuredPrimaryEntry,
		{
			schemaVersion: "r1-measured-artifact/v1",
			artifactKind: "measured",
			lockDigestSha256: expectedLockDigest,
			archiveSha256,
			expectedCapabilityDigest,
			rawBindings: Object.fromEntries(
				measuredPrimaryEntry.rawDescriptors.map((descriptor) => [
					descriptor.kind,
					{
						relativePath: descriptor.relativePath,
						sha256: descriptor.sha256,
					},
				]),
			),
			cellSnapshots: {
				preCell: measuredPrimaryEntry.cellSnapshotBundle.preCell,
				postCell: measuredPrimaryEntry.cellSnapshotBundle.postCell,
			},
		},
	);
	const measuredArtifactBytes = canonicalBytes(measuredArtifactValue);

	return {
		candidateId,
		campaignId,
		archiveBytes,
		registryBytes,
		specBytes,
		capacityBytes,
		lock,
		lockBytes,
		expectedLockDigest,
		stagedCapability,
		stagedCapabilityBytes,
		expectedCapabilityDigest,
		fixtureOnlyCapabilityBytes,
		observedAttestation,
		observedAttestationModel,
		armDefinitions,
		runEntries,
		cellSnapshotBundles,
		manifest,
		artifactBytesByPath,
		rawBytesByPath,
		snapshotBytesByPath,
		explicitMeasuredBuildInput: {
			lock,
			lockBytes,
			expectedLockDigest,
			stagedCapability,
			capabilityBytes: stagedCapabilityBytes,
			expectedCapabilityDigest,
			expectedArchiveDigest: archiveSha256,
			runEntry: measuredPrimaryEntry,
			artifactBytes: measuredArtifactBytes,
			artifactDescriptor: measuredPrimaryEntry.artifact,
			artifactDigestSha256: sha256Hex(measuredArtifactBytes),
			expectedArtifact: measuredArtifactValue,
			rawBytesByPath,
			snapshotBytesByPath,
		},
		legacyFixtureBytes: new Uint8Array(
			readFileSync(join(import.meta.dir, "fixtures", "valid-ws-run.json")),
		),
	};
}

export type CallableExpectedModule = Record<
	string,
	(...args: unknown[]) => unknown
>;

export async function importExpectedModule(
	relativePath: string,
): Promise<CallableExpectedModule> {
	return (await import(relativePath)) as CallableExpectedModule;
}

/**
 * Required RED surface helper. Missing exports are an explicit test failure;
 * callers must not turn an absent production module/API into a passing no-op.
 */
export function requiredExport(
	moduleValue: CallableExpectedModule,
	exportName: string,
): (...args: unknown[]) => unknown {
	const implementation = moduleValue[exportName];
	if (typeof implementation !== "function") {
		throw new Error(`missing required production export: ${exportName}`);
	}
	return implementation;
}

// R1 amendment fixtures are intentionally authored here, rather than copied
// from production validators.  Their bytes and digests are the test-side
// authority inputs that the RED suites require production to validate.
export const R1_CANDIDATE_ID =
	"9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4" as const;
export const R1_CAMPAIGN_ID = "campaign-direct-cable-2026-08-24" as const;
// Representative fixture identifier only.  This is not the final post-RED
// commit HEAD and is never an external approval input.
export const R1_FINAL_CANDIDATE_HEAD =
	"9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4" as const;

export function r1FixtureDigest(label: string): string {
	return sha256Hex(canonicalBytes({ schema: "r1-fixture-digest/v1", label }));
}

export const R1_MAC_DIRECTORY_IDENTITY = Object.freeze({
	platform: "darwin" as const,
	device: "16777235",
	inode: "9007199254740993",
	fsidWord0: "4294967297",
	fsidWord1: "8589934593",
	fileSystemType: "apfs" as const,
	volumeUuid: "0123456789abcdef0123456789abcdef",
	mountTableEntrySha256: r1FixtureDigest("mac-mount-table"),
	canonicalDescriptorPathSha256: r1FixtureDigest("mac-campaign-fpath"),
	ownerUid: 501,
	mode: 0o700,
	hardLinkCount: "1",
});

export const R1_MAC_STAGING_DIRECTORY_IDENTITY = Object.freeze({
	...R1_MAC_DIRECTORY_IDENTITY,
	inode: "9007199254740995",
	mountTableEntrySha256: r1FixtureDigest("mac-staging-mount-table"),
	canonicalDescriptorPathSha256: r1FixtureDigest("mac-staging-fpath"),
});

export const R1_MAC_EXEC_PARENT_DIRECTORY_IDENTITY = Object.freeze({
	...R1_MAC_DIRECTORY_IDENTITY,
	inode: "9007199254740997",
	mountTableEntrySha256: r1FixtureDigest("mac-exec-parent-mount-table"),
	canonicalDescriptorPathSha256: r1FixtureDigest("mac-exec-parent-fpath"),
});

export const R1_LINUX_DIRECTORY_IDENTITY = Object.freeze({
	platform: "linux" as const,
	deviceMajor: "8",
	deviceMinor: "1",
	inode: "9007199254740999",
	mountId: "44123",
	fileSystemType: "ext4" as const,
	fileSystemTypeMagic: "0000ef53",
	fsidWord0: "4294967298",
	fsidWord1: "8589934594",
	ownerUid: 1000,
	mode: 0o700,
	hardLinkCount: "1",
});

export const R1_SOURCE_ARCHIVE_RECEIPT = Object.freeze({
	schema: "source-archive-receipt/v1" as const,
	candidate: R1_CANDIDATE_ID,
	finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
	finalCandidateTreeOid: "0123456789abcdef0123456789abcdef01234567",
	reviewedDiffSha256: r1FixtureDigest("reviewed-diff"),
	cleanTreeProof: {
		statusBytesSha256: r1FixtureDigest("git-status-bytes"),
		statusBytesSize: 0 as const,
		unstagedDiffBytesSha256: r1FixtureDigest("git-unstaged-diff"),
		unstagedDiffBytesSize: 0 as const,
		stagedDiffBytesSha256: r1FixtureDigest("git-staged-diff"),
		stagedDiffBytesSize: 0 as const,
		untrackedFileCount: 0 as const,
		allEmpty: true as const,
	},
	submoduleStatusSha256: r1FixtureDigest("submodule-status"),
	submoduleStatusSize: 0,
	gitVersion: "git version 2.50.1",
	gitExecutableSha256: r1FixtureDigest("git-executable"),
	sourceBuilderExecutableSha256: r1FixtureDigest("source-builder"),
	commandSetSha256: r1FixtureDigest("source-receipt-command-set"),
	archiveRecipe: {
		kind: "git-archive-tar-head/v1" as const,
		prefix: "source/" as const,
		mtimeSource: "commit" as const,
	},
	sourceArchiveSha256: r1FixtureDigest("source-archive"),
	sourceArchiveSize: 123456,
	archiveMemberInventorySha256: r1FixtureDigest("archive-member-inventory"),
	archiveMemberCount: 512,
	producedAt: "2026-08-24T10:00:00.000Z",
});
export const R1_SOURCE_ARCHIVE_RECEIPT_BYTES = canonicalBytes(
	R1_SOURCE_ARCHIVE_RECEIPT,
);
export const R1_SOURCE_ARCHIVE_RECEIPT_SHA256 =
	"dea6b1207de77b4bcacf41b48b91c4aee39b7713e2998ee1a982f57275bb7fc8" as const;

/**
 * Complete, bounded RED inventory for the current source candidate.  This is
 * a test-side expectation, not an observation and not a promotion receipt.
 * The checker result is compared by its own recomputed machine-readable
 * digest; this list is deliberately kept as the independent contract oracle.
 */
export const R1_RED_FAILURE_INVENTORY = Object.freeze([
	{ code: "ALLOWLIST_EXTRA_FILE", file: "tools/compare/remote.ts" },
	{ code: "ALLOWLIST_FILE_MISSING", file: "tools/compare/campaign-lock.ts" },
	{ code: "ALLOWLIST_FILE_MISSING", file: "tools/compare/manifest-lock.ts" },
	{ code: "ALLOWLIST_FILE_MISSING", file: "tools/compare/secure-fs.ts" },
	{
		code: "ALLOWLIST_FILE_MISSING",
		file: "tools/compare/staged-capability.ts",
	},
	{
		code: "ALLOWLIST_FILE_MISSING",
		file: "tools/compare/supervisor-client.ts",
	},
	{
		code: "ALLOWLIST_FILE_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{ code: "AUTHORITY_DAG_UNENFORCED", file: "tools/compare/secure-fs.ts" },
	{
		code: "BUN_ROLE_LAUNCH_CONTRACT_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "CAMPAIGN_LOCK_MODULE_MISSING",
		file: "tools/compare/campaign-lock.ts",
	},
	{
		code: "DESCRIPTOR_ONLY_ROLE_LOAD_UNENFORCED",
		file: "tools/compare/run-campaign.ts",
	},
	{
		code: "ENTRYPOINT_FOUR_ROOTS_UNENFORCED",
		file: "tools/compare/run-campaign.ts",
	},
	{
		code: "ENTRYPOINT_PROMOTION_FLOW_UNENFORCED",
		file: "tools/compare/supervisor-client.ts",
	},
	{
		code: "EXPECTED_NATIVE_SOURCE_MISSING",
		file: "crates/native/src/bin/comparison-supervisor.rs",
	},
	{
		code: "EXPECTED_NATIVE_SOURCE_MISSING",
		file: "crates/native/src/secure_fs.rs",
	},
	{
		code: "FORBIDDEN_ADDON_LOADER",
		file: "packages/webtransport/src/index.ts",
	},
	{
		code: "FORBIDDEN_AMBIENT_AUTHORITY",
		file: "packages/webtransport/src/index.ts",
	},
	{
		code: "FORBIDDEN_AMBIENT_AUTHORITY",
		file: "packages/webtransport/src/stream-chunk-batch.ts",
	},
	{
		code: "FORBIDDEN_AMBIENT_AUTHORITY",
		file: "packages/webtransport/src/streams.ts",
	},
	{
		code: "FORBIDDEN_AMBIENT_AUTHORITY",
		file: "tools/compare/output-policy.ts",
	},
	{
		code: "FORBIDDEN_AMBIENT_AUTHORITY",
		file: "tools/compare/render-report.ts",
	},
	{
		code: "FORBIDDEN_AMBIENT_AUTHORITY",
		file: "tools/compare/run-campaign.ts",
	},
	{
		code: "FORBIDDEN_AMBIENT_AUTHORITY",
		file: "tools/compare/verify-artifact.ts",
	},
	{
		code: "FORBIDDEN_DIRECTORY_ENUMERATION",
		file: "tools/compare/render-report.ts",
	},
	{
		code: "FORBIDDEN_DIRECTORY_ENUMERATION",
		file: "tools/compare/verify-artifact.ts",
	},
	{
		code: "FORBIDDEN_DYNAMIC_IMPORT",
		file: "tools/compare/verify-artifact.ts",
	},
	{
		code: "FORBIDDEN_ENTRYPOINT_WRAPPER",
		file: "tools/compare/render-report.ts",
	},
	{
		code: "FORBIDDEN_ENTRYPOINT_WRAPPER",
		file: "tools/compare/run-campaign.ts",
	},
	{
		code: "FORBIDDEN_ENTRYPOINT_WRAPPER",
		file: "tools/compare/verify-artifact.ts",
	},
	{ code: "FORBIDDEN_IMPORT", file: "tools/compare/output-policy.ts" },
	{ code: "FORBIDDEN_IMPORT", file: "tools/compare/render-report.ts" },
	{ code: "FORBIDDEN_IMPORT", file: "tools/compare/run-campaign.ts" },
	{ code: "FORBIDDEN_OFFICIAL_IO", file: "packages/webtransport/src/index.ts" },
	{
		code: "FORBIDDEN_OFFICIAL_IO",
		file: "packages/webtransport/src/streams.ts",
	},
	{
		code: "FORBIDDEN_OFFICIAL_IO",
		file: "packages/webtransport/src/webtransport-like-native.ts",
	},
	{ code: "FORBIDDEN_OFFICIAL_IO", file: "tools/compare/output-policy.ts" },
	{ code: "FORBIDDEN_OFFICIAL_IO", file: "tools/compare/render-report.ts" },
	{ code: "FORBIDDEN_OFFICIAL_IO", file: "tools/compare/run-campaign.ts" },
	{ code: "FORBIDDEN_OFFICIAL_IO", file: "tools/compare/verify-artifact.ts" },
	{
		code: "FORBIDDEN_SYNTHETIC_EXECUTOR",
		file: "tools/compare/run-campaign.ts",
	},
	{
		code: "HOST_LAUNCH_PROVENANCE_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "HOST_RUNTIME_FACTS_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "LEGACY_OVERLAY_DISCRIMINANT_PRESENT",
		file: "tools/compare/run-campaign.ts",
	},
	{ code: "MANIFEST_MODULE_MISSING", file: "tools/compare/manifest-lock.ts" },
	{ code: "NO_BYPASS_CHECKER_MISSING", file: "tools/compare/output-policy.ts" },
	{
		code: "PACKAGE_LOADER_CONTRACT_MISSING",
		file: "packages/webtransport/src/index.ts",
	},
	{
		code: "PHYSICAL_OBSERVATION_ENVELOPE_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "PHYSICAL_RECEIPT_SCHEMA_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "PRODUCTION_DYNAMIC_MODULE_REACHABILITY",
		file: "tools/compare/r1-fixtures.ts",
	},
	{ code: "REMOTE_RUNTIME_REACHABLE", file: "tools/compare/remote.ts" },
	{
		code: "ROLE_RECEIPT_SET_CARDINALITY_UNENFORCED",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{ code: "SECURE_FS_MODULE_MISSING", file: "tools/compare/secure-fs.ts" },
	{
		code: "STAGED_CAPABILITY_MODULE_MISSING",
		file: "tools/compare/staged-capability.ts",
	},
	{
		code: "STATIC_IMPORT_DUPLICATE_OBSERVED",
		file: "tools/compare/compare.ts",
	},
	{
		code: "SUPERVISOR_CLIENT_MODULE_MISSING",
		file: "tools/compare/supervisor-client.ts",
	},
	{
		code: "SUPERVISOR_ERROR_RECORD_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "SUPERVISOR_INPUT_RECORD_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "SUPERVISOR_OUTPUT_RECORD_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "SUPERVISOR_PROTOCOL_MODULE_MISSING",
		file: "tools/compare/supervisor-protocol.ts",
	},
	{
		code: "TEST_IMPORT_CONTROLLER_FORBIDDEN",
		file: "tools/compare/orchestration.test.ts",
	},
	{
		code: "TEST_IMPORT_UNAPPROVED",
		file: "tools/compare/orchestration.test.ts",
	},
	{ code: "TYPED_CLI_CONTRACT_MISSING", file: "tools/compare/run-campaign.ts" },
	{
		code: "WINDOWS_EARLY_REJECT_UNENFORCED",
		file: "tools/compare/run-campaign.ts",
	},
] as const);
export const R1_RED_FAILURE_INVENTORY_BYTES = canonicalBytes({
	schema: "r1-red-failure-inventory/v1",
	bounded: true,
	failures: R1_RED_FAILURE_INVENTORY,
});
export const R1_RED_FAILURE_INVENTORY_SHA256 =
	"64deb728a58050ad8d0d12ba71aa32fd887d2e4afbcd13297adac1e46668e0c6" as const;

/**
 * Canonical, bounded commands used to collect the RED evidence.  These are
 * command fixtures only: they do not claim that any command has passed or
 * that a post-commit suite digest is known.
 */
export const R1_RED_COMMAND_SET = Object.freeze([
	{
		id: "focused-red",
		argv: ["bun", "test", "tools/compare/r1-*-red.test.ts"],
		network: "none",
	},
	{
		id: "native-secure-fs",
		argv: ["cargo", "test", "-p", "native", "--test", "secure_fs"],
		network: "none",
	},
	{
		id: "official-io-checker",
		argv: ["bun", "tools/compare/check-official-io.ts"],
		network: "none",
	},
	{
		id: "r1-type-diagnostics",
		argv: ["bun", "x", "tsc", "--noEmit"],
		network: "none",
	},
] as const);
export const R1_RED_COMMAND_SET_BYTES = canonicalBytes({
	schema: "r1-red-command-set/v1",
	commands: R1_RED_COMMAND_SET,
});
export const R1_RED_COMMAND_SET_SHA256 =
	"1b2d7f4fecad48d656ac318b986277cad56180688e5f5f6bebab22c3416605ec" as const;
export const R1_RED_COMMAND_BYTES = R1_RED_COMMAND_SET_BYTES;
export const R1_RED_COMMAND_SHA256 = R1_RED_COMMAND_SET_SHA256;

/**
 * Representative approval-shaped snapshot only.  These are seven logical
 * fixture slots with fictional deterministic digests, not source paths, not
 * the current seven-file source set, and not a Rust source digest.  The
 * actual sorted path+byte-digest set is computed externally after the RED
 * files are committed and is never embedded in this immutable fixture.
 */
export const R1_REPRESENTATIVE_SUITE_FILE_DIGESTS = Object.freeze([
	{
		path: "fixture-slot/authority",
		sha256: r1FixtureDigest("representative-authority-test"),
	},
	{
		path: "fixture-slot/entrypoint",
		sha256: r1FixtureDigest("representative-entrypoint-test"),
	},
	{
		path: "fixture-slot/fixtures",
		sha256: r1FixtureDigest("representative-fixtures"),
	},
	{
		path: "fixture-slot/manifest",
		sha256: r1FixtureDigest("representative-manifest-test"),
	},
	{
		path: "fixture-slot/physical-path",
		sha256: r1FixtureDigest("representative-physical-path-test"),
	},
	{
		path: "fixture-slot/rust",
		sha256: r1FixtureDigest("representative-secure-fs-rust"),
	},
	{
		path: "fixture-slot/secure-fs",
		sha256: r1FixtureDigest("representative-secure-fs-test"),
	},
] as const);
export const R1_REPRESENTATIVE_SUITE_FILE_BYTES = Object.freeze(
	R1_REPRESENTATIVE_SUITE_FILE_DIGESTS.map((file) => ({
		path: file.path,
		bytes: canonicalBytes({ schema: "r1-representative-file/v1", ...file }),
	})),
);
export const R1_REPRESENTATIVE_SUITE_FILE_SET_BYTES = canonicalBytes({
	schema: "r1-representative-file-set/v1",
	files: R1_REPRESENTATIVE_SUITE_FILE_DIGESTS,
});
export const R1_REPRESENTATIVE_SUITE_SHA256 =
	"2d00d3354784411081893219345ef50c8e76f9366074afdcfb50af56fd8aad3e" as const;

export const R1_RED_APPROVAL_FIXTURE_METADATA = Object.freeze({
	fixtureOnly: true as const,
	provenance: "representative-test-fixture" as const,
	notExternalApproval: true as const,
	fictionalApprovalRecords: true as const,
	redSuiteMeaning: "representative-command-and-failure-snapshot" as const,
	redSuiteDigestIsCurrentSevenFileSet: false as const,
	rustByteDigestIsCurrent: false as const,
	finalExternalApprovalClaim: false as const,
	actualSuiteDigestLocation: "external-after-red-commit" as const,
	finalExternalApprovalLocation: "external-after-red-commit" as const,
});

/**
 * Representative approval-shaped records for exercising parser/authority
 * rejection paths. They are fictional fixtures: they do not attest the
 * current seven-file suite, a Rust byte digest, or any final external review.
 */
export const R1_RED_APPROVAL_RECORDS = Object.freeze([
	{
		schema: "r1-red-approval/v1" as const,
		role: "spec-reviewer" as const,
		verdict: "APPROVED" as const,
		worktree:
			"/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison",
		redHead: R1_FINAL_CANDIDATE_HEAD,
		redSuiteSha256: R1_REPRESENTATIVE_SUITE_SHA256,
		redFailureInventorySha256: R1_RED_FAILURE_INVENTORY_SHA256,
		issuedAt: "2026-08-24T11:00:00.000Z",
	},
	{
		schema: "r1-red-approval/v1" as const,
		role: "verifier" as const,
		verdict: "APPROVED" as const,
		worktree:
			"/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison",
		redHead: R1_FINAL_CANDIDATE_HEAD,
		redSuiteSha256: R1_REPRESENTATIVE_SUITE_SHA256,
		redFailureInventorySha256: R1_RED_FAILURE_INVENTORY_SHA256,
		issuedAt: "2026-08-24T11:05:00.000Z",
	},
] as const);
export const R1_RED_APPROVAL_BUNDLE = Object.freeze({
	schema: "r1-red-approval-bundle/v1" as const,
	worktree:
		"/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison",
	redHead: R1_FINAL_CANDIDATE_HEAD,
	redSuiteSha256: R1_REPRESENTATIVE_SUITE_SHA256,
	records: R1_RED_APPROVAL_RECORDS,
});
export const R1_RED_APPROVAL_BUNDLE_BYTES = canonicalBytes(
	R1_RED_APPROVAL_BUNDLE,
);
export const R1_RED_APPROVAL_BUNDLE_SHA256 =
	"e78524a98275ec8ecabfd135fd704e91003ccb435cc0634517529ccd39a20214" as const;

export const R1_STAGED_ARCHIVE_RECEIPTS = Object.freeze([
	{
		schema: "staged-archive-receipt/v1" as const,
		candidate: R1_CANDIDATE_ID,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
		hostId: "mac-controller-01",
		platform: "darwin-arm64" as const,
		stagedArchiveSha256: r1FixtureDigest("mac-staged-archive"),
		stagedArchiveSize: "123456",
		stagedMemberInventorySha256: r1FixtureDigest("mac-staged-members"),
		stagedMemberCount: 512,
		symlinkCount: 0 as const,
		hardlinkCount: 0 as const,
		deviceCount: 0 as const,
		stagingIdentity: R1_MAC_STAGING_DIRECTORY_IDENTITY,
		supervisorInstanceNonceSha256: r1FixtureDigest("mac-supervisor-nonce"),
		observedAt: "2026-08-24T11:30:00.000Z",
	},
	{
		schema: "staged-archive-receipt/v1" as const,
		candidate: R1_CANDIDATE_ID,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
		hostId: "linux-bench-01",
		platform: "linux-x86_64" as const,
		stagedArchiveSha256: r1FixtureDigest("linux-staged-archive"),
		stagedArchiveSize: "123456",
		stagedMemberInventorySha256: r1FixtureDigest("linux-staged-members"),
		stagedMemberCount: 512,
		symlinkCount: 0 as const,
		hardlinkCount: 0 as const,
		deviceCount: 0 as const,
		stagingIdentity: R1_LINUX_DIRECTORY_IDENTITY,
		supervisorInstanceNonceSha256: r1FixtureDigest("linux-supervisor-nonce"),
		observedAt: "2026-08-24T11:35:00.000Z",
	},
] as const);
export const R1_STAGED_ARCHIVE_RECEIPT_SHA256S = Object.freeze([
	"0f4a364c1878232c5ebdf64148734093fb14ad7e87069864a9a2f10fbf38608b",
	"26259406cc614bdac1067a52eae79f231eb7ce84c5edcefd966dff3dca50805b",
] as const);
export const R1_STAGED_ARCHIVE_RECEIPT_BYTES = Object.freeze(
	R1_STAGED_ARCHIVE_RECEIPTS.map((receipt) => canonicalBytes(receipt)),
);
export const R1_STAGED_ARCHIVE_RECEIPT_CANONICAL_SHA256S = Object.freeze([
	"0f4a364c1878232c5ebdf64148734093fb14ad7e87069864a9a2f10fbf38608b",
	"26259406cc614bdac1067a52eae79f231eb7ce84c5edcefd966dff3dca50805b",
] as const);
export const R1_STAGED_ARCHIVE_RECEIPT_SET_BYTES = canonicalBytes(
	R1_STAGED_ARCHIVE_RECEIPTS,
);
export const R1_STAGED_ARCHIVE_RECEIPT_SET_SHA256 =
	"8f5484e71c826c067892529dacdcc822784c6bb1a6d3c1a310879ba8bf196e9b" as const;

export const R1_AUTHORITY_APPROVAL = Object.freeze({
	parentPlanSha256:
		"7981f289d7fdb044218a5c7348cc5a1fa755087d48a02acc589d127575983c16",
	parentDesignSha256:
		"0b2b6e9ea38897ee76ea590f25916f39d2f6bce1320c096703ee68b60a4f10b6",
	amendmentSha256:
		"b181325dc3ac558da4c0f44541eb223f6cdb63770ef70b6d1228ce74b0fdf403",
	finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
	sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
	r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
	finalArchitectApprovalSha256:
		"0cde6e45aca2dd6629106af860e14b3f6b6ccef73918bc3693744998103d4efc",
	finalCriticApprovalSha256:
		"d53a20282d978b25068d17fbd1f21ad2f62d6cf2d168d0355ba21c4956ab82be",
	finalVerifierApprovalSha256:
		"71a82d44b7609370e59f9f48e86710978d9f7c8eac87345e31cc56be02539f68",
});

export const R1_AUTHORITY_SOURCE = Object.freeze({
	macHostSubmissionSha256:
		"0f4965036d0f9f989c882ac61d177d50ffb153adc71055993b244a40b979851c",
	linuxHostSubmissionSha256:
		"36bc23fe4e1aea3443a85750f4d30c607bd538010f055fe3eb677c51e1a53dd7",
	macStagedArchiveReceiptSha256: R1_STAGED_ARCHIVE_RECEIPT_SHA256S[0],
	linuxStagedArchiveReceiptSha256: R1_STAGED_ARCHIVE_RECEIPT_SHA256S[1],
	macLaunchProvenanceSha256: r1FixtureDigest("mac-launch-provenance"),
	linuxLaunchProvenanceSha256: r1FixtureDigest("linux-launch-provenance"),
	macRuntimeFactsSha256: r1FixtureDigest("mac-runtime-facts"),
	linuxRuntimeFactsSha256: r1FixtureDigest("linux-runtime-facts"),
	archiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
	macStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[0].stagedArchiveSha256,
	linuxStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[1].stagedArchiveSha256,
	macBunSha256: r1FixtureDigest("mac-bun"),
	linuxBunSha256: r1FixtureDigest("linux-bun"),
	macSupervisorSha256: r1FixtureDigest("mac-supervisor"),
	linuxSupervisorSha256: r1FixtureDigest("linux-supervisor"),
	macRoleEntrypointsSha256: r1FixtureDigest("mac-role-entrypoints"),
	linuxRoleEntrypointsSha256: r1FixtureDigest("linux-role-entrypoints"),
	macAddonSha256: r1FixtureDigest("mac-addon"),
	linuxAddonSha256: r1FixtureDigest("linux-addon"),
	macRouteToolSha256: r1FixtureDigest("mac-route-tool"),
	macIfconfigToolSha256: r1FixtureDigest("mac-ifconfig-tool"),
	linuxIpToolSha256: r1FixtureDigest("linux-ip-tool"),
	linuxTcToolSha256: r1FixtureDigest("linux-tc-tool"),
});

export const R1_EXACT_APPROVAL_EXPECTED_INPUTS = Object.freeze({
	sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
	sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
	macHostSubmissionSha256:
		"0f4965036d0f9f989c882ac61d177d50ffb153adc71055993b244a40b979851c",
	linuxHostSubmissionSha256:
		"36bc23fe4e1aea3443a85750f4d30c607bd538010f055fe3eb677c51e1a53dd7",
	macStagedArchiveReceiptSha256: R1_STAGED_ARCHIVE_RECEIPT_SHA256S[0],
	linuxStagedArchiveReceiptSha256: R1_STAGED_ARCHIVE_RECEIPT_SHA256S[1],
	macLaunchProvenanceSha256: R1_AUTHORITY_SOURCE.macLaunchProvenanceSha256,
	linuxLaunchProvenanceSha256: R1_AUTHORITY_SOURCE.linuxLaunchProvenanceSha256,
	macRuntimeFactsSha256: R1_AUTHORITY_SOURCE.macRuntimeFactsSha256,
	linuxRuntimeFactsSha256: R1_AUTHORITY_SOURCE.linuxRuntimeFactsSha256,
	sshHostReceiptSha256:
		"cc19343bae77f29243dd7d23bdfec452c53ff8376f0a94316b6e8b48ae76faf2",
	macStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[0].stagedArchiveSha256,
	linuxStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[1].stagedArchiveSha256,
	macBunSha256: R1_AUTHORITY_SOURCE.macBunSha256,
	linuxBunSha256: R1_AUTHORITY_SOURCE.linuxBunSha256,
	macSupervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
	linuxSupervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
	macRoleEntrypointsSha256: R1_AUTHORITY_SOURCE.macRoleEntrypointsSha256,
	linuxRoleEntrypointsSha256: R1_AUTHORITY_SOURCE.linuxRoleEntrypointsSha256,
	macAddonSha256: R1_AUTHORITY_SOURCE.macAddonSha256,
	linuxAddonSha256: R1_AUTHORITY_SOURCE.linuxAddonSha256,
	macRouteToolSha256: R1_AUTHORITY_SOURCE.macRouteToolSha256,
	macIfconfigToolSha256: R1_AUTHORITY_SOURCE.macIfconfigToolSha256,
	linuxIpToolSha256: R1_AUTHORITY_SOURCE.linuxIpToolSha256,
	linuxTcToolSha256: R1_AUTHORITY_SOURCE.linuxTcToolSha256,
	macCampaignParentIdentity: R1_MAC_DIRECTORY_IDENTITY,
	macStagingIdentity: R1_MAC_STAGING_DIRECTORY_IDENTITY,
	linuxStagingIdentity: R1_LINUX_DIRECTORY_IDENTITY,
	macExecParentIdentity: R1_MAC_EXEC_PARENT_DIRECTORY_IDENTITY,
});

/**
 * The campaign-staging approvals below are parser/authority fixtures only.
 * They are representative, fictional records and make no claim about the
 * current seven-file RED byte set, a Rust byte digest, or final external
 * approval; those values are collected externally after the RED commit and
 * fresh staging review.
 */
export const R1_STAGED_APPROVAL_FIXTURE_METADATA = Object.freeze({
	fixtureOnly: true as const,
	provenance: "representative-staged-approval-fixture" as const,
	notExternalApproval: true as const,
	fictionalApprovalRecords: true as const,
	redSuiteDigestIsCurrentSevenFileSet: false as const,
	rustByteDigestIsCurrent: false as const,
	finalExternalApprovalClaim: false as const,
	actualSuiteDigestLocation: "external-after-red-commit" as const,
	finalExternalApprovalLocation:
		"external-after-red-commit-and-staging" as const,
});

export const R1_EXACT_APPROVAL_RECORDS = Object.freeze([
	{
		schema: "exact-approval/v1" as const,
		phase: "campaign-staging" as const,
		role: "architect" as const,
		verdict: "APPROVED" as const,
		worktree:
			"/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison",
		finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
		parentPlanSha256:
			"7981f289d7fdb044218a5c7348cc5a1fa755087d48a02acc589d127575983c16",
		parentDesignSha256:
			"0b2b6e9ea38897ee76ea590f25916f39d2f6bce1320c096703ee68b60a4f10b6",
		amendmentSha256:
			"b181325dc3ac558da4c0f44541eb223f6cdb63770ef70b6d1228ce74b0fdf403",
		reviewedDiffSha256: R1_SOURCE_ARCHIVE_RECEIPT.reviewedDiffSha256,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
		expectedCampaignInputs: R1_EXACT_APPROVAL_EXPECTED_INPUTS,
		issuedAt: "2026-08-24T13:00:00.000Z",
	},
	{
		schema: "exact-approval/v1" as const,
		phase: "campaign-staging" as const,
		role: "critic" as const,
		verdict: "APPROVED" as const,
		worktree:
			"/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison",
		finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
		parentPlanSha256:
			"7981f289d7fdb044218a5c7348cc5a1fa755087d48a02acc589d127575983c16",
		parentDesignSha256:
			"0b2b6e9ea38897ee76ea590f25916f39d2f6bce1320c096703ee68b60a4f10b6",
		amendmentSha256:
			"b181325dc3ac558da4c0f44541eb223f6cdb63770ef70b6d1228ce74b0fdf403",
		reviewedDiffSha256: R1_SOURCE_ARCHIVE_RECEIPT.reviewedDiffSha256,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
		expectedCampaignInputs: R1_EXACT_APPROVAL_EXPECTED_INPUTS,
		issuedAt: "2026-08-24T13:01:00.000Z",
	},
	{
		schema: "exact-approval/v1" as const,
		phase: "campaign-staging" as const,
		role: "verifier" as const,
		verdict: "APPROVED" as const,
		worktree:
			"/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison",
		finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
		parentPlanSha256:
			"7981f289d7fdb044218a5c7348cc5a1fa755087d48a02acc589d127575983c16",
		parentDesignSha256:
			"0b2b6e9ea38897ee76ea590f25916f39d2f6bce1320c096703ee68b60a4f10b6",
		amendmentSha256:
			"b181325dc3ac558da4c0f44541eb223f6cdb63770ef70b6d1228ce74b0fdf403",
		reviewedDiffSha256: R1_SOURCE_ARCHIVE_RECEIPT.reviewedDiffSha256,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
		expectedCampaignInputs: R1_EXACT_APPROVAL_EXPECTED_INPUTS,
		issuedAt: "2026-08-24T13:02:00.000Z",
	},
] as const);
export const R1_EXACT_APPROVAL_RECORD_BYTES = Object.freeze(
	R1_EXACT_APPROVAL_RECORDS.map((record) => canonicalBytes(record)),
);
export const R1_EXACT_APPROVAL_RECORD_SHA256S = Object.freeze([
	"0cde6e45aca2dd6629106af860e14b3f6b6ccef73918bc3693744998103d4efc",
	"d53a20282d978b25068d17fbd1f21ad2f62d6cf2d168d0355ba21c4956ab82be",
	"71a82d44b7609370e59f9f48e86710978d9f7c8eac87345e31cc56be02539f68",
] as const);
export const R1_EXACT_APPROVAL_RECORD_SET_BYTES = canonicalBytes(
	R1_EXACT_APPROVAL_RECORDS,
);
export const R1_EXACT_APPROVAL_RECORD_SET_SHA256 =
	"679a0881b7bfc3ca16bf63c85594b1cb414e444972008a4d5f7754a71b811016" as const;

export const R1_AUTHORITY_ROOTS = Object.freeze([
	{
		hostId: "mac-controller-01",
		kind: "mac-campaign" as const,
		identity: R1_MAC_DIRECTORY_IDENTITY,
	},
	{
		hostId: "mac-controller-01",
		kind: "mac-staging" as const,
		identity: R1_MAC_STAGING_DIRECTORY_IDENTITY,
	},
	{
		hostId: "linux-bench-01",
		kind: "linux-staging" as const,
		identity: R1_LINUX_DIRECTORY_IDENTITY,
	},
	{
		hostId: "mac-controller-01",
		kind: "mac-exec-parent" as const,
		identity: R1_MAC_EXEC_PARENT_DIRECTORY_IDENTITY,
	},
] as const);

export const R1_CAMPAIGN_AUTHORITY = Object.freeze({
	schema: "campaign-authority/v1" as const,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	issuedAt: "2026-08-24T12:00:00.000Z",
	notAfter: "2026-08-24T22:00:00.000Z",
	campaignReservationSha256:
		"d2b90c2c0dcc7cff20802c2fe36df02d2136ffb3ea2e0563d70266cfee2893e9",
	approval: R1_AUTHORITY_APPROVAL,
	source: R1_AUTHORITY_SOURCE,
	topology: {
		kind: "direct-cable" as const,
		mac: {
			hostId: "mac-controller-01",
			interface: "en8",
			address: "10.99.0.1",
			mtu: 1500,
		},
		linux: {
			hostId: "linux-bench-01",
			interface: "eno1",
			address: "10.99.0.2",
			mtu: 1500,
		},
		sshControlReceiptSha256:
			"cc19343bae77f29243dd7d23bdfec452c53ff8376f0a94316b6e8b48ae76faf2",
		tailscaleMeasurementForbidden: true as const,
		loopbackForbidden: true as const,
	},
	roots: R1_AUTHORITY_ROOTS,
});
export const R1_CAMPAIGN_AUTHORITY_BYTES = canonicalBytes(
	R1_CAMPAIGN_AUTHORITY,
);
export const R1_CAMPAIGN_AUTHORITY_SHA256 =
	"8197fcb693dbd28504a42a198bff2b497d51540db5a0b56d63a69f09a402aaa8" as const;

export const R1_CAMPAIGN_RESERVATION = Object.freeze({
	schema: "campaign-reservation/v1" as const,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	campaignIdentity: R1_MAC_DIRECTORY_IDENTITY,
	supervisorInstanceNonce: r1FixtureDigest("operator-nonce"),
	state: "RESERVED" as const,
	createdAt: "2026-08-24T11:55:00.000Z",
});
export const R1_CAMPAIGN_RESERVATION_BYTES = canonicalBytes(
	R1_CAMPAIGN_RESERVATION,
);
export const R1_CAMPAIGN_RESERVATION_SHA256 =
	"fb2e841fb146749012883b4762df5f4c93828b5b6795708c0287d336593d376a" as const;

export const R1_MAC_OFFICIAL_FILE_IDENTITY = Object.freeze({
	platform: "darwin" as const,
	device: "16777235",
	inode: "9007199254741001",
	mountIdentitySha256: r1FixtureDigest("mac-file-mount"),
	size: "4096",
	ownerUid: 501,
	mode: 0o500,
	hardLinkCount: "1" as const,
});

export const R1_LINUX_OFFICIAL_FILE_IDENTITY = Object.freeze({
	platform: "linux" as const,
	device: "8:1",
	inode: "9007199254741002",
	mountIdentitySha256: r1FixtureDigest("linux-file-mount"),
	size: "4096",
	ownerUid: 1000,
	mode: 0o500,
	hardLinkCount: "1" as const,
});

export const R1_BUN_ROLE_LAUNCH_CONTRACT = Object.freeze({
	argvTemplate: [
		"bun",
		"--no-install",
		"--no-env-file",
		"/dev/fd/{roleFd}",
	] as const,
	environmentTemplate: [
		"LC_ALL=C",
		"WT_COMPARISON_PROTOCOL_IN_FD={protocolInFd}",
		"WT_COMPARISON_PROTOCOL_OUT_FD={protocolOutFd}",
		"WT_COMPARISON_STARTUP_NONCE_FD={startupNonceFd}",
		"WT_COMPARISON_STRICT_ADDON_FD={addonFd}",
	] as const,
	inheritedLogicalDescriptors: [
		"roleFd",
		"addonFd",
		"protocolInFd",
		"protocolOutFd",
		"startupNonceFd",
	] as const,
	cwd: "sealed-exec-root" as const,
	pathLookup: false as const,
	shell: false as const,
	addonSpecifierTemplate: "/dev/fd/{addonFd}" as const,
	addonLoadAttemptCount: 1 as const,
	addonFallbackAttemptCount: 0 as const,
});
export const R1_BUN_ROLE_LAUNCH_CONTRACT_BYTES = canonicalBytes(
	R1_BUN_ROLE_LAUNCH_CONTRACT,
);
export const R1_BUN_ROLE_LAUNCH_CONTRACT_SHA256 =
	"a3fd3fc308ddbf9ebc19dcf31b51ffcc2961b667724b490ec856fd6000d5e732" as const;

function r1DescriptorBindings(host: "mac" | "linux") {
	const prefix = host === "mac" ? "mac" : "linux";
	return [
		{
			logicalName: "roleFd",
			fd: 31,
			access: "read",
			kind: "executable",
			closeOnExec: false,
			inheritedByChild: true,
			identitySha256: r1FixtureDigest(`${prefix}-role-fd`),
		},
		{
			logicalName: "addonFd",
			fd: 32,
			access: "read",
			kind: "executable",
			closeOnExec: false,
			inheritedByChild: true,
			identitySha256: r1FixtureDigest(`${prefix}-addon-fd`),
		},
		{
			logicalName: "protocolInFd",
			fd: 33,
			access: "read",
			kind: "pipe",
			closeOnExec: false,
			inheritedByChild: true,
			identitySha256: r1FixtureDigest(`${prefix}-protocol-in-fd`),
		},
		{
			logicalName: "protocolOutFd",
			fd: 34,
			access: "write",
			kind: "pipe",
			closeOnExec: false,
			inheritedByChild: true,
			identitySha256: r1FixtureDigest(`${prefix}-protocol-out-fd`),
		},
		{
			logicalName: "startupNonceFd",
			fd: 35,
			access: "read",
			kind: "regular",
			closeOnExec: false,
			inheritedByChild: true,
			identitySha256: r1FixtureDigest(`${prefix}-startup-nonce-fd`),
		},
	] as const;
}

function r1LaunchFiles(host: "mac" | "linux") {
	const mac = host === "mac";
	const identity = mac
		? R1_MAC_OFFICIAL_FILE_IDENTITY
		: R1_LINUX_OFFICIAL_FILE_IDENTITY;
	const prefix = mac ? "mac" : "linux";
	const source = mac
		? R1_AUTHORITY_SOURCE.macBunSha256
		: R1_AUTHORITY_SOURCE.linuxBunSha256;
	const supervisor = mac
		? R1_AUTHORITY_SOURCE.macSupervisorSha256
		: R1_AUTHORITY_SOURCE.linuxSupervisorSha256;
	const roles = mac
		? R1_AUTHORITY_SOURCE.macRoleEntrypointsSha256
		: R1_AUTHORITY_SOURCE.linuxRoleEntrypointsSha256;
	const addon = mac
		? R1_AUTHORITY_SOURCE.macAddonSha256
		: R1_AUTHORITY_SOURCE.linuxAddonSha256;
	const tool = mac
		? R1_AUTHORITY_SOURCE.macRouteToolSha256
		: R1_AUTHORITY_SOURCE.linuxIpToolSha256;
	return [
		{
			kind: "addon" as const,
			role: null,
			components: ["prebuilds", prefix, "webtransport.node"] as const,
			sha256: addon,
			identity,
		},
		{
			kind: "bun" as const,
			role: null,
			components: ["bin", "bun"] as const,
			sha256: source,
			identity,
		},
		{
			kind: "observation-tool" as const,
			role: null,
			components: ["tools", prefix, "observe"] as const,
			sha256: tool,
			identity,
		},
		{
			kind: "role-entrypoint" as const,
			role: "campaign-child",
			components: ["roles", "campaign-child.mjs"] as const,
			sha256: roles,
			identity,
		},
		{
			kind: "role-entrypoint-manifest" as const,
			role: null,
			components: ["roles", "manifest.json"] as const,
			sha256: roles,
			identity,
		},
		{
			kind: "supervisor" as const,
			role: null,
			components: ["bin", "comparison-supervisor"] as const,
			sha256: supervisor,
			identity,
		},
	] as const;
}

type ResidentSupervisorDescriptorDeclaration = readonly [
	string,
	number,
	"read" | "write" | "read-write",
	(
		| "regular-file-or-pipe"
		| "regular-file"
		| "directory"
		| "regular-executable"
		| "bounded-proc-file"
		| "pipe"
		| "seqpacket-socket"
	),
	"O_RDONLY" | "O_WRONLY" | "O_RDWR",
	"S_IFREG|S_IFIFO" | "S_IFREG" | "S_IFDIR" | "S_IFIFO" | "S_IFSOCK",
];

/**
 * Complete descriptor map for the resident supervisor itself.  The five
 * descriptor bindings used by Bun children are intentionally separate: A.4
 * requires this map to account for every inherited CLI/pipe descriptor and
 * to record the exact F_GETFL/fstat assertions for each one.
 */
function r1ResidentSupervisorDescriptorMap(host: "mac" | "linux") {
	const macDeclarations: readonly ResidentSupervisorDescriptorDeclaration[] = [
		[
			"sourceReceiptFd",
			3,
			"read",
			"regular-file-or-pipe",
			"O_RDONLY",
			"S_IFREG|S_IFIFO",
		],
		[
			"redApprovalBundleFd",
			4,
			"read",
			"regular-file-or-pipe",
			"O_RDONLY",
			"S_IFREG|S_IFIFO",
		],
		["sourceArchiveFd", 5, "read", "regular-file", "O_RDONLY", "S_IFREG"],
		["stagedArchiveFd", 6, "read", "regular-file", "O_RDONLY", "S_IFREG"],
		["stagingRootFd", 7, "read", "directory", "O_RDONLY", "S_IFDIR"],
		["bunFd", 8, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
		["selfFd", 9, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
		["roleManifestFd", 10, "read", "regular-file", "O_RDONLY", "S_IFREG"],
		["addonFd", 11, "read", "regular-file", "O_RDONLY", "S_IFREG"],
		["routeToolFd", 12, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
		[
			"interfaceToolFd",
			13,
			"read",
			"regular-executable",
			"O_RDONLY",
			"S_IFREG",
		],
		["rustcFd", 14, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
		["cargoFd", 15, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
		["opensslFd", 16, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
		["execParentFd", 17, "read", "directory", "O_RDONLY", "S_IFDIR"],
		["submissionNonceFd", 18, "read", "pipe", "O_RDONLY", "S_IFIFO"],
		[
			"phaseControlFd",
			19,
			"read-write",
			"seqpacket-socket",
			"O_RDWR",
			"S_IFSOCK",
		],
		["hostSubmissionOutFd", 20, "write", "pipe", "O_WRONLY", "S_IFIFO"],
		["authorityOutFd", 21, "write", "pipe", "O_WRONLY", "S_IFIFO"],
		["authorityDigestOutFd", 22, "write", "pipe", "O_WRONLY", "S_IFIFO"],
	];
	const linuxDeclarations: readonly ResidentSupervisorDescriptorDeclaration[] =
		[
			[
				"sourceReceiptFd",
				3,
				"read",
				"regular-file-or-pipe",
				"O_RDONLY",
				"S_IFREG|S_IFIFO",
			],
			[
				"redApprovalBundleFd",
				4,
				"read",
				"regular-file-or-pipe",
				"O_RDONLY",
				"S_IFREG|S_IFIFO",
			],
			["sourceArchiveFd", 5, "read", "regular-file", "O_RDONLY", "S_IFREG"],
			["stagedArchiveFd", 6, "read", "regular-file", "O_RDONLY", "S_IFREG"],
			["stagingRootFd", 7, "read", "directory", "O_RDONLY", "S_IFDIR"],
			["bunFd", 8, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
			["selfFd", 9, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
			["roleManifestFd", 10, "read", "regular-file", "O_RDONLY", "S_IFREG"],
			["addonFd", 11, "read", "regular-file", "O_RDONLY", "S_IFREG"],
			["ipToolFd", 12, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
			["tcToolFd", 13, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
			["rustcFd", 14, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
			["cargoFd", 15, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
			["opensslFd", 16, "read", "regular-executable", "O_RDONLY", "S_IFREG"],
			["cpuInfoFd", 17, "read", "bounded-proc-file", "O_RDONLY", "S_IFREG"],
			["governorFd", 18, "read", "bounded-proc-file", "O_RDONLY", "S_IFREG"],
			[
				"ephemeralRangeFd",
				19,
				"read",
				"bounded-proc-file",
				"O_RDONLY",
				"S_IFREG",
			],
			["submissionNonceFd", 20, "read", "pipe", "O_RDONLY", "S_IFIFO"],
			["sshChallengeFd", 21, "read", "pipe", "O_RDONLY", "S_IFIFO"],
			["controlInFd", 22, "read", "pipe", "O_RDONLY", "S_IFIFO"],
			["controlOutFd", 23, "write", "pipe", "O_WRONLY", "S_IFIFO"],
			["hostSubmissionOutFd", 24, "write", "pipe", "O_WRONLY", "S_IFIFO"],
		];
	const prefix = host === "mac" ? "mac" : "linux";
	const declarations = host === "mac" ? macDeclarations : linuxDeclarations;
	return declarations.map(
		([logicalName, fd, access, declaredType, fgetflAccessMode, fstatType]) => ({
			logicalName,
			fd,
			access,
			// Keep the plan's stable DescriptorBindingV1 kind alongside the
			// platform-level declared type and raw fcntl/stat assertions below.
			// The latter deliberately preserve the regular-file-or-pipe union for
			// the two receipt inputs; `kind` is the canonical broad category.
			kind:
				declaredType === "regular-executable"
					? "executable"
					: declaredType === "directory"
						? "directory"
						: declaredType === "bounded-proc-file"
							? "observation-file"
							: declaredType === "pipe"
								? "pipe"
								: declaredType === "seqpacket-socket"
									? "seqpacket"
									: "regular",
			declaredType,
			fgetflAccessMode,
			fstatType,
			closeOnExec: false as const,
			inheritedByChild: false as const,
			identitySha256: r1FixtureDigest(`${prefix}-resident-${logicalName}`),
		}),
	);
}

function r1ProcessLaunchReceipt(host: "mac" | "linux") {
	const mac = host === "mac";
	const prefix = mac ? "mac" : "linux";
	const identity = mac
		? R1_MAC_OFFICIAL_FILE_IDENTITY
		: R1_LINUX_OFFICIAL_FILE_IDENTITY;
	const descriptorMap = r1ResidentSupervisorDescriptorMap(host);
	const argv = mac
		? [
				"resident-mac",
				"--platform",
				"darwin-arm64",
				"--candidate",
				R1_CANDIDATE_ID,
				"--campaign-id",
				R1_CAMPAIGN_ID,
				"--source-receipt-fd",
				"3",
				"--red-approval-bundle-fd",
				"4",
				"--source-archive-fd",
				"5",
				"--staged-archive-fd",
				"6",
				"--staging-root-fd",
				"7",
				"--bun-fd",
				"8",
				"--self-fd",
				"9",
				"--role-manifest-fd",
				"10",
				"--addon-fd",
				"11",
				"--route-tool-fd",
				"12",
				"--interface-tool-fd",
				"13",
				"--rustc-fd",
				"14",
				"--cargo-fd",
				"15",
				"--openssl-fd",
				"16",
				"--exec-parent-fd",
				"17",
				"--submission-nonce-fd",
				"18",
				"--phase-control-fd",
				"19",
				"--host-submission-out-fd",
				"20",
				"--authority-out-fd",
				"21",
				"--authority-digest-out-fd",
				"22",
			]
		: [
				"resident-linux",
				"--platform",
				"linux-x86_64",
				"--source-receipt-fd",
				"3",
				"--red-approval-bundle-fd",
				"4",
				"--source-archive-fd",
				"5",
				"--staged-archive-fd",
				"6",
				"--staging-root-fd",
				"7",
				"--bun-fd",
				"8",
				"--self-fd",
				"9",
				"--role-manifest-fd",
				"10",
				"--addon-fd",
				"11",
				"--ip-tool-fd",
				"12",
				"--tc-tool-fd",
				"13",
				"--rustc-fd",
				"14",
				"--cargo-fd",
				"15",
				"--openssl-fd",
				"16",
				"--cpu-info-fd",
				"17",
				"--governor-fd",
				"18",
				"--ephemeral-range-fd",
				"19",
				"--submission-nonce-fd",
				"20",
				"--ssh-challenge-fd",
				"21",
				"--control-in-fd",
				"22",
				"--control-out-fd",
				"23",
				"--host-submission-out-fd",
				"24",
			];
	return {
		executableSha256: mac
			? R1_AUTHORITY_SOURCE.macSupervisorSha256
			: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		executableIdentity: identity,
		argv,
		environment: ["LC_ALL=C"] as const,
		descriptorMap,
		descriptorMapSha256: sha256Hex(canonicalBytes(descriptorMap)),
		startupNonceSha256: r1FixtureDigest(`${prefix}-supervisor-nonce`),
		startupDigestSha256: r1FixtureDigest(`${prefix}-supervisor-startup`),
		launchedAt: mac ? "2026-08-24T12:02:00.000Z" : "2026-08-24T12:02:30.000Z",
	} as const;
}

export const R1_HOST_RUNTIME_FACTS = Object.freeze([
	{
		schema: "host-runtime-facts/v1" as const,
		hostId: "mac-controller-01",
		platform: "darwin-arm64" as const,
		hostnameSha256: r1FixtureDigest("mac-hostname"),
		os: {
			system: "Darwin" as const,
			release: "26.0.0",
			versionSha256: r1FixtureDigest("mac-os-version"),
			architecture: "arm64" as const,
		},
		cpu: {
			modelSha256: r1FixtureDigest("mac-cpu-model"),
			logicalCpuCount: 10,
			availableLogicalCpuCount: 10,
			minimumAvailableLogicalCpuCount: 8 as const,
			frequencyGovernorSha256: "not-applicable-darwin" as const,
		},
		toolchain: {
			bunVersion: "1.3.14" as const,
			bunExecutableSha256: R1_AUTHORITY_SOURCE.macBunSha256,
			bunVersionOutputSha256: r1FixtureDigest("mac-bun-version-output"),
			rustcVersion: "rustc 1.82.0",
			rustcExecutableSha256: r1FixtureDigest("mac-rustc"),
			rustcVersionOutputSha256: r1FixtureDigest("mac-rustc-version-output"),
			cargoVersion: "cargo 1.82.0",
			cargoExecutableSha256: r1FixtureDigest("mac-cargo"),
			cargoVersionOutputSha256: r1FixtureDigest("mac-cargo-version-output"),
			opensslVersion: "OpenSSL 3.3.2",
			opensslExecutableSha256: r1FixtureDigest("mac-openssl"),
			opensslVersionOutputSha256: r1FixtureDigest("mac-openssl-version-output"),
		},
		limits: {
			nofileSoft: "65536",
			nofileHard: "65536",
			effectiveChildNofile: "65536",
			minimumEffectiveChildNofile: "65536" as const,
			ephemeralPortFirst: 49152,
			ephemeralPortLast: 65535,
			occupiedSourcePortsSha256: r1FixtureDigest("mac-occupied-source-ports"),
			freeSourcePortCount: 16384,
			requiredFreeSourcePortCount: 588,
		},
		measurementEndpoint: {
			interface: "en8" as const,
			interfaceIndex: 18,
			address: "10.99.0.1" as const,
			peerAddress: "10.99.0.2" as const,
			mtu: 1500 as const,
			wsTcpPort: 4433,
			wtUdpPort: 4433,
			wsPortFreeAtInspection: true as const,
			wtPortFreeAtInspection: true as const,
			listeningSocketInventorySha256: r1FixtureDigest("mac-listening-sockets"),
		},
		descriptorMapSha256: r1FixtureDigest("mac-runtime-descriptors"),
		commandReceiptsSha256: r1FixtureDigest("mac-runtime-command-receipts"),
		observedAt: "2026-08-24T12:01:00.000Z",
	},
	{
		schema: "host-runtime-facts/v1" as const,
		hostId: "linux-bench-01",
		platform: "linux-x86_64" as const,
		hostnameSha256: r1FixtureDigest("linux-hostname"),
		os: {
			system: "Linux" as const,
			release: "6.11.0",
			versionSha256: r1FixtureDigest("linux-os-version"),
			architecture: "x86_64" as const,
		},
		cpu: {
			modelSha256: r1FixtureDigest("linux-cpu-model"),
			logicalCpuCount: 16,
			availableLogicalCpuCount: 16,
			minimumAvailableLogicalCpuCount: 8 as const,
			frequencyGovernorSha256: r1FixtureDigest("linux-governor"),
		},
		toolchain: {
			bunVersion: "1.3.14" as const,
			bunExecutableSha256: R1_AUTHORITY_SOURCE.linuxBunSha256,
			bunVersionOutputSha256: r1FixtureDigest("linux-bun-version-output"),
			rustcVersion: "rustc 1.82.0",
			rustcExecutableSha256: r1FixtureDigest("linux-rustc"),
			rustcVersionOutputSha256: r1FixtureDigest("linux-rustc-version-output"),
			cargoVersion: "cargo 1.82.0",
			cargoExecutableSha256: r1FixtureDigest("linux-cargo"),
			cargoVersionOutputSha256: r1FixtureDigest("linux-cargo-version-output"),
			opensslVersion: "OpenSSL 3.3.2",
			opensslExecutableSha256: r1FixtureDigest("linux-openssl"),
			opensslVersionOutputSha256: r1FixtureDigest(
				"linux-openssl-version-output",
			),
		},
		limits: {
			nofileSoft: "65536",
			nofileHard: "65536",
			effectiveChildNofile: "65536",
			minimumEffectiveChildNofile: "65536" as const,
			ephemeralPortFirst: 32768,
			ephemeralPortLast: 60999,
			occupiedSourcePortsSha256: r1FixtureDigest("linux-occupied-source-ports"),
			freeSourcePortCount: 28232,
			requiredFreeSourcePortCount: 588,
		},
		measurementEndpoint: {
			interface: "eno1" as const,
			interfaceIndex: 2,
			address: "10.99.0.2" as const,
			peerAddress: "10.99.0.1" as const,
			mtu: 1500 as const,
			wsTcpPort: 4433,
			wtUdpPort: 4433,
			wsPortFreeAtInspection: true as const,
			wtPortFreeAtInspection: true as const,
			listeningSocketInventorySha256: r1FixtureDigest(
				"linux-listening-sockets",
			),
		},
		descriptorMapSha256: r1FixtureDigest("linux-runtime-descriptors"),
		commandReceiptsSha256: r1FixtureDigest("linux-runtime-command-receipts"),
		observedAt: "2026-08-24T12:02:00.000Z",
	},
] as const);
export const R1_HOST_RUNTIME_FACTS_BYTES = Object.freeze(
	R1_HOST_RUNTIME_FACTS.map((facts) => canonicalBytes(facts)),
);
export const R1_HOST_RUNTIME_FACTS_SHA256S = Object.freeze([
	"ab3dd866b16a972a1cca0774177824a1be29ece22843533778ed53b80a3e859c",
	"c026dcf1ac1e183615f755b529d193abf21bbce008dc9ff747b64a260aee96dc",
] as const);
export const R1_HOST_RUNTIME_FACTS_SET_BYTES = canonicalBytes({
	schema: "host-runtime-facts-set/v1",
	facts: R1_HOST_RUNTIME_FACTS,
});
export const R1_HOST_RUNTIME_FACTS_SET_SHA256 =
	"6ffcb3b347abbcb41041f5f27c1140e0b2dcb836be853b276345190bdd560b50" as const;

export const R1_HOST_LAUNCH_PROVENANCE = Object.freeze([
	{
		schema: "host-launch-provenance/v1" as const,
		candidate: R1_CANDIDATE_ID,
		hostId: "mac-controller-01",
		platform: "darwin-arm64" as const,
		stagedArchiveReceiptSha256:
			R1_AUTHORITY_SOURCE.macStagedArchiveReceiptSha256,
		canonicalFileSetSha256: R1_AUTHORITY_SOURCE.macLaunchProvenanceSha256,
		files: r1LaunchFiles("mac"),
		residentSupervisorLaunch: r1ProcessLaunchReceipt("mac"),
		bunRoleLaunchContract: R1_BUN_ROLE_LAUNCH_CONTRACT,
		initialDescriptorMap: r1DescriptorBindings("mac"),
		supervisorInstanceNonceSha256: r1FixtureDigest("mac-supervisor-nonce"),
		observedAt: "2026-08-24T12:03:00.000Z",
	},
	{
		schema: "host-launch-provenance/v1" as const,
		candidate: R1_CANDIDATE_ID,
		hostId: "linux-bench-01",
		platform: "linux-x86_64" as const,
		stagedArchiveReceiptSha256:
			R1_AUTHORITY_SOURCE.linuxStagedArchiveReceiptSha256,
		canonicalFileSetSha256: R1_AUTHORITY_SOURCE.linuxLaunchProvenanceSha256,
		files: r1LaunchFiles("linux"),
		residentSupervisorLaunch: r1ProcessLaunchReceipt("linux"),
		bunRoleLaunchContract: R1_BUN_ROLE_LAUNCH_CONTRACT,
		initialDescriptorMap: r1DescriptorBindings("linux"),
		supervisorInstanceNonceSha256: r1FixtureDigest("linux-supervisor-nonce"),
		observedAt: "2026-08-24T12:04:00.000Z",
	},
] as const);
export const R1_HOST_LAUNCH_PROVENANCE_BYTES = Object.freeze(
	R1_HOST_LAUNCH_PROVENANCE.map((provenance) => canonicalBytes(provenance)),
);
export const R1_HOST_LAUNCH_PROVENANCE_SHA256S = Object.freeze([
	"6de4480543846364c3405a528262a224f8de58aa0d9829f6e028124c8a0d2229",
	"ad44d122b66e88bf4959275c7ce6c884105b69fec40da1eca90f92fd09beba7a",
] as const);
export const R1_HOST_LAUNCH_PROVENANCE_SET_BYTES = canonicalBytes({
	schema: "host-launch-provenance-set/v1",
	provenance: R1_HOST_LAUNCH_PROVENANCE,
});
export const R1_HOST_LAUNCH_PROVENANCE_SET_SHA256 =
	"b81df340bff7f5e43012b45e0e8f7ea782cabc6df090111d013eaccf527c0094" as const;

export const R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS = Object.freeze(
	R1_HOST_LAUNCH_PROVENANCE.map(
		(provenance) => provenance.residentSupervisorLaunch.descriptorMap,
	),
);
export const R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_BYTES = Object.freeze(
	R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS.map((descriptorMap) =>
		canonicalBytes(descriptorMap),
	),
);
export const R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SHA256S = Object.freeze(
	R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_BYTES.map((bytes) => sha256Hex(bytes)),
);
export const R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SET_BYTES = canonicalBytes({
	schema: "resident-supervisor-descriptor-map-set/v1",
	maps: R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS,
});
export const R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SET_SHA256 =
	"cc2740f088e71af7c195b107adcdf14d61e2d700d535b65e502680b7e5f9b1d7" as const;

export const R1_HOST_SUBMISSIONS = Object.freeze([
	{
		schema: "host-submission/v1" as const,
		hostId: "mac-controller-01",
		platform: "darwin-arm64" as const,
		stagingIdentity: R1_MAC_STAGING_DIRECTORY_IDENTITY,
		execParentIdentity: R1_MAC_EXEC_PARENT_DIRECTORY_IDENTITY,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		redApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
		sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
		stagedArchiveReceipt: R1_STAGED_ARCHIVE_RECEIPTS[0],
		stagedArchiveReceiptSha256:
			R1_AUTHORITY_SOURCE.macStagedArchiveReceiptSha256,
		launchProvenance: R1_HOST_LAUNCH_PROVENANCE[0],
		launchProvenanceSha256: R1_AUTHORITY_SOURCE.macLaunchProvenanceSha256,
		runtimeFacts: R1_HOST_RUNTIME_FACTS[0],
		runtimeFactsSha256: r1FixtureDigest("mac-runtime-facts"),
		stagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[0].stagedArchiveSha256,
		bunSha256: R1_AUTHORITY_SOURCE.macBunSha256,
		supervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
		roleEntrypointsSha256: R1_AUTHORITY_SOURCE.macRoleEntrypointsSha256,
		addonSha256: R1_AUTHORITY_SOURCE.macAddonSha256,
		routeToolSha256: R1_AUTHORITY_SOURCE.macRouteToolSha256,
		interfaceToolSha256: R1_AUTHORITY_SOURCE.macIfconfigToolSha256,
		submissionNonceSha256: r1FixtureDigest("mac-submission-nonce"),
		reservedStagingMetadataComponentsAbsent: true as const,
		observedAt: "2026-08-24T12:05:00.000Z",
	},
	{
		schema: "host-submission/v1" as const,
		hostId: "linux-bench-01",
		platform: "linux-x86_64" as const,
		stagingIdentity: R1_LINUX_DIRECTORY_IDENTITY,
		execParentIdentity: null,
		sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		redApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
		sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
		stagedArchiveReceipt: R1_STAGED_ARCHIVE_RECEIPTS[1],
		stagedArchiveReceiptSha256:
			R1_AUTHORITY_SOURCE.linuxStagedArchiveReceiptSha256,
		launchProvenance: R1_HOST_LAUNCH_PROVENANCE[1],
		launchProvenanceSha256: R1_AUTHORITY_SOURCE.linuxLaunchProvenanceSha256,
		runtimeFacts: R1_HOST_RUNTIME_FACTS[1],
		runtimeFactsSha256: r1FixtureDigest("linux-runtime-facts"),
		stagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[1].stagedArchiveSha256,
		bunSha256: R1_AUTHORITY_SOURCE.linuxBunSha256,
		supervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		roleEntrypointsSha256: R1_AUTHORITY_SOURCE.linuxRoleEntrypointsSha256,
		addonSha256: R1_AUTHORITY_SOURCE.linuxAddonSha256,
		routeToolSha256: R1_AUTHORITY_SOURCE.linuxIpToolSha256,
		interfaceToolSha256: R1_AUTHORITY_SOURCE.linuxIpToolSha256,
		submissionNonceSha256: r1FixtureDigest("linux-submission-nonce"),
		reservedStagingMetadataComponentsAbsent: true as const,
		observedAt: "2026-08-24T12:06:00.000Z",
	},
] as const);

export const R1_CARDINALITY: CardinalityV1 = Object.freeze({
	cellCount: 35,
	armCount: 82,
	wsPrimaryArmCount: 35,
	wtPrimaryArmCount: 35,
	overlayArmCount: 12,
	primaryWarmupCount: 86,
	primaryMeasuredCount: 430,
	overlayWarmupCount: 12,
	overlayMeasuredCount: 60,
	warmupExecutionCount: 98,
	measuredExecutionCount: 490,
	primaryExecutionCount: 516,
	executionCount: 588,
	wsPrimaryExecutionCount: 258,
	wtPrimaryExecutionCount: 258,
	wsOverlayExecutionCount: 72,
	artifactCount: 588,
	rawClientCount: 588,
	rawServerCount: 588,
	rawTopologyCount: 588,
	rawImpairmentCount: 588,
	rawCleanupCount: 588,
	rawDescriptorCount: 2940,
	snapshotPreCount: 35,
	snapshotPostCount: 35,
	snapshotDescriptorCount: 70,
	attestationCount: 1,
	descriptorCount: 3599,
});

const r1CampaignLockFixtureSource = representativeFixture();
export const R1_CAMPAIGN_LOCK = Object.freeze({
	schema: "campaign-lock/v1" as const,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
	r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
	sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
	registryHash: sha256Hex(r1CampaignLockFixtureSource.registryBytes),
	scheduleHash: r1CampaignLockFixtureSource.manifest.scheduleHash,
	capacityProfileHash: TEST_CAPACITY_PROFILE_HASH,
	tlsPlanHash: r1FixtureDigest("tls-plan"),
	topologyPlanHash: r1FixtureDigest("topology-plan"),
	executionPlanHash: r1FixtureDigest("execution-plan"),
	cardinality: R1_CARDINALITY,
	createdAt: "2026-08-24T12:00:00.000Z",
});
export const R1_CAMPAIGN_LOCK_BYTES = canonicalBytes(R1_CAMPAIGN_LOCK);
export const R1_CAMPAIGN_LOCK_SHA256 =
	"bf92c321da208ac5868c3404641e60a427f2de0a6597c6ac63a72c3d29805320" as const;

export const R1_HOST_SUBMISSION_BYTES = Object.freeze(
	R1_HOST_SUBMISSIONS.map((submission) => canonicalBytes(submission)),
);
export const R1_HOST_SUBMISSION_SHA256S = Object.freeze(
	R1_HOST_SUBMISSION_BYTES.map((bytes) => sha256Hex(bytes)),
);
export const R1_HOST_SUBMISSION_EXPECTED_SHA256S = Object.freeze([
	"8f52e8778f30f087b00e6d9c871a8a1e596a20b7d6b9e83e257416b818b74a78",
	"a4a8d9f7f6a1b93c6d38a08b89d73059e176deec800c9d69f86c03e760095fc0",
] as const);

export const R1_SSH_HOST_RECEIPT = Object.freeze({
	schema: "ssh-host-receipt/v1" as const,
	linuxHostId: "linux-bench-01",
	knownHostsSha256: r1FixtureDigest("ssh-known-hosts"),
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprintSha256: r1FixtureDigest("ssh-host-key-fingerprint"),
	controlPeerAddress: "10.99.0.2:22",
	sessionNonceSha256: r1FixtureDigest("ssh-session-nonce"),
	linuxChallengeResponseSha256: r1FixtureDigest("ssh-linux-challenge-response"),
	linuxSupervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
	connectedAt: "2026-08-24T11:59:00.000Z",
});
export const R1_SSH_HOST_RECEIPT_BYTES = canonicalBytes(R1_SSH_HOST_RECEIPT);
export const R1_SSH_HOST_RECEIPT_SHA256 =
	"cc19343bae77f29243dd7d23bdfec452c53ff8376f0a94316b6e8b48ae76faf2" as const;
export const R1_SSH_HOST_RECEIPTS = Object.freeze([R1_SSH_HOST_RECEIPT]);
export const R1_SSH_HOST_RECEIPTS_BYTES = canonicalBytes(R1_SSH_HOST_RECEIPTS);
export const R1_SSH_HOST_RECEIPTS_SHA256 =
	"623948ce9c30bc80635579cf8a4b677c6cddccd6c6f99c4e87b626a4ec44173f" as const;

export const R1_STAGED_CAPABILITY_V1 = Object.freeze({
	schema: "staged-capability/v1" as const,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	lockSha256: R1_CAMPAIGN_LOCK_SHA256,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
	r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
	sourceArchiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
	macStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[0].stagedArchiveSha256,
	linuxStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[1].stagedArchiveSha256,
	hostSubmissions: R1_HOST_SUBMISSIONS,
	sshHostReceiptSha256:
		"cc19343bae77f29243dd7d23bdfec452c53ff8376f0a94316b6e8b48ae76faf2",
	macCampaignIdentity: R1_MAC_DIRECTORY_IDENTITY,
	issuedAt: "2026-08-24T12:00:00.000Z",
	notAfter: "2026-08-24T22:00:00.000Z",
	fixtureOnly: false as const,
});
export const R1_STAGED_CAPABILITY_V1_BYTES = canonicalBytes(
	R1_STAGED_CAPABILITY_V1,
);
export const R1_STAGED_CAPABILITY_V1_SHA256 =
	"700ed6ac98785890dd507ff79b0ec35435ea3747793a7cabedfbb4f93a5a217d" as const;

export const R1_STAGED_METADATA_RECEIPTS = Object.freeze([
	{
		schema: "staged-metadata-receipt/v1" as const,
		hostId: "mac-controller-01",
		platform: "darwin-arm64" as const,
		authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
		lockSha256: R1_CAMPAIGN_LOCK_SHA256,
		lockSize: R1_CAMPAIGN_LOCK_BYTES.byteLength,
		lockIdentity: R1_MAC_OFFICIAL_FILE_IDENTITY,
		capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
		capabilitySize: R1_STAGED_CAPABILITY_V1_BYTES.byteLength,
		capabilityIdentity: R1_MAC_OFFICIAL_FILE_IDENTITY,
		hostSubmissionSha256: R1_HOST_SUBMISSION_SHA256S[0],
		stagingIdentity: R1_MAC_STAGING_DIRECTORY_IDENTITY,
		supervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
		supervisorInstanceNonceSha256: r1FixtureDigest("mac-supervisor-nonce"),
		leafAndParentSyncComplete: true as const,
		activatedAt: "2026-08-24T12:10:00.000Z",
	},
	{
		schema: "staged-metadata-receipt/v1" as const,
		hostId: "linux-bench-01",
		platform: "linux-x86_64" as const,
		authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
		lockSha256: R1_CAMPAIGN_LOCK_SHA256,
		lockSize: R1_CAMPAIGN_LOCK_BYTES.byteLength,
		lockIdentity: R1_LINUX_OFFICIAL_FILE_IDENTITY,
		capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
		capabilitySize: R1_STAGED_CAPABILITY_V1_BYTES.byteLength,
		capabilityIdentity: R1_LINUX_OFFICIAL_FILE_IDENTITY,
		hostSubmissionSha256: R1_HOST_SUBMISSION_SHA256S[1],
		stagingIdentity: R1_LINUX_DIRECTORY_IDENTITY,
		supervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		supervisorInstanceNonceSha256: r1FixtureDigest("linux-supervisor-nonce"),
		leafAndParentSyncComplete: true as const,
		activatedAt: "2026-08-24T12:11:00.000Z",
	},
] as const);
export const R1_STAGED_METADATA_RECEIPT_BYTES = Object.freeze(
	R1_STAGED_METADATA_RECEIPTS.map((receipt) => canonicalBytes(receipt)),
);
export const R1_STAGED_METADATA_RECEIPT_SHA256S = Object.freeze(
	R1_STAGED_METADATA_RECEIPT_BYTES.map((bytes) => sha256Hex(bytes)),
);
export const R1_STAGED_METADATA_RECEIPT_EXPECTED_SHA256S = Object.freeze([
	"6a955dd93a9b402e7d6c957ee43951798c9fec18cf5f9fcaac306512aa6827d4",
	"46eda55891bb7550018e6c9cf60e885149ff1bfd9b0db7af75b71af647c8e466",
] as const);
export const R1_STAGED_METADATA_RECEIPT_SET_BYTES = canonicalBytes(
	R1_STAGED_METADATA_RECEIPTS,
);
export const R1_STAGED_METADATA_RECEIPT_SET_SHA256 =
	"6ef9f98d21a51eccbe49a3b5e60a944524adfdb74010b0b3a43dd05f86a31131" as const;

export const R1_DESCRIPTOR_ONLY_ROLE_LOADS = Object.freeze([
	{
		logicalName: "campaign-child",
		roleFd: 31,
		roleEntrypoint: "/dev/fd/31",
		addonFd: 32,
		addonPath: "/dev/fd/32",
	},
	{
		logicalName: "artifact-child",
		roleFd: 33,
		roleEntrypoint: "/dev/fd/33",
		addonFd: 34,
		addonPath: "/dev/fd/34",
	},
	{
		logicalName: "verifier-child",
		roleFd: 35,
		roleEntrypoint: "/dev/fd/35",
		addonFd: 36,
		addonPath: "/dev/fd/36",
	},
	{
		logicalName: "report-child",
		roleFd: 37,
		roleEntrypoint: "/dev/fd/37",
		addonFd: 38,
		addonPath: "/dev/fd/38",
	},
] as const);

const r1RoleReceiptFixture = representativeFixture();
export const R1_BUN_ROLE_LAUNCH_RECEIPTS = Object.freeze(
	r1RoleReceiptFixture.runEntries.map((entry, executionIndex) => {
		const host = executionIndex % 2 === 0 ? "mac" : "linux";
		const mac = host === "mac";
		const prefix = mac ? "mac" : "linux";
		return {
			schema: "bun-role-launch-receipt/v1" as const,
			hostId: mac ? "mac-controller-01" : "linux-bench-01",
			runId: entry.runInstanceId,
			executionIndex,
			logicalRole: "campaign-child" as const,
			processOrdinal: 0 as const,
			bunSha256: mac
				? R1_AUTHORITY_SOURCE.macBunSha256
				: R1_AUTHORITY_SOURCE.linuxBunSha256,
			roleEntrypointSha256: mac
				? R1_AUTHORITY_SOURCE.macRoleEntrypointsSha256
				: R1_AUTHORITY_SOURCE.linuxRoleEntrypointsSha256,
			addonSha256: mac
				? R1_AUTHORITY_SOURCE.macAddonSha256
				: R1_AUTHORITY_SOURCE.linuxAddonSha256,
			argv: ["bun", "--no-install", "--no-env-file", "/dev/fd/31"] as const,
			environment: [
				"LC_ALL=C",
				"WT_COMPARISON_PROTOCOL_IN_FD=33",
				"WT_COMPARISON_PROTOCOL_OUT_FD=34",
				"WT_COMPARISON_STARTUP_NONCE_FD=35",
				"WT_COMPARISON_STRICT_ADDON_FD=32",
			] as const,
			descriptorMap: r1DescriptorBindings(host),
			sealedExecutionIdentity: mac ? R1_MAC_DIRECTORY_IDENTITY : null,
			launchPrimitive: mac
				? ("macos-sealed-relative-posix-spawn" as const)
				: ("linux-execveat-empty-path" as const),
			startupNonceSha256: r1FixtureDigest(`${prefix}-supervisor-nonce`),
			startupDigestSha256: r1FixtureDigest(
				`${prefix}-campaign-child-startup-${executionIndex}`,
			),
			addonRequestedSpecifier: "/dev/fd/32" as const,
			addonLoadAttemptCount: 1 as const,
			addonLoadedSha256: mac
				? R1_AUTHORITY_SOURCE.macAddonSha256
				: R1_AUTHORITY_SOURCE.linuxAddonSha256,
			addonFallbackCandidates: [] as const,
			socketBeforeStartupHandshake: false as const,
			launchedAt: `2026-08-24T12:${String(7 + Math.floor(executionIndex / 60)).padStart(2, "0")}:${String(executionIndex % 60).padStart(2, "0")}.000Z`,
		};
	}),
);
export const R1_BUN_ROLE_LAUNCH_RECEIPTS_BYTES = canonicalBytes(
	R1_BUN_ROLE_LAUNCH_RECEIPTS,
);
export const R1_BUN_ROLE_LAUNCH_RECEIPTS_ORDERED_SHA256 =
	"4b7ade9556f0a8bd405582bb0c164565327f245470a59f57f12c19f92267389a" as const;
export const R1_BUN_ROLE_LAUNCH_RECEIPT_SET = Object.freeze({
	schema: "bun-role-launch-receipt-set/v1" as const,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	lockSha256: R1_CAMPAIGN_LOCK_SHA256,
	capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
	expectedProcessCount: 588 as const,
	receipts: R1_BUN_ROLE_LAUNCH_RECEIPTS,
	orderedReceiptSetSha256: R1_BUN_ROLE_LAUNCH_RECEIPTS_ORDERED_SHA256,
});
export const R1_BUN_ROLE_LAUNCH_RECEIPT_SET_BYTES = canonicalBytes(
	R1_BUN_ROLE_LAUNCH_RECEIPT_SET,
);
export const R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256 =
	"bbc22875073ab141c194e3e71aba174a80990bb2a960ac7443ec81c4338b6d3c" as const;

export const R1_OFFICIAL_CHILD_ROOTS = Object.freeze([
	"tools/compare/run-campaign.ts",
	"tools/compare/artifact-builder.ts",
	"tools/compare/verify-artifact.ts",
	"tools/compare/render-report.ts",
] as const);
export const R1_RECOVERY_MODES = Object.freeze([
	"verify-existing",
	"report-existing",
] as const);
export const R1_NO_BYPASS_FORBIDDEN_SURFACES = Object.freeze([
	"node:fs",
	"node:fs/promises",
	"node:path",
	"node:child_process",
	"node:module",
	"Bun.file",
	"Bun.write",
	"Bun.spawn",
	"readdirSync",
	"glob",
	"readOfficialComparisonFile",
	"writeOfficialComparisonFile",
	"measureCellArm",
	"dynamic-import",
	"pathname-addon-fallback",
] as const);
export const R1_MANIFEST_DESCRIPTOR_EXPECTED_COUNT = 3599 as const;
export const R1_MANIFEST_DESCRIPTOR_ORDER = Object.freeze([
	"artifact",
	"raw-client",
	"raw-server",
	"raw-topology",
	"raw-impairment",
	"raw-cleanup",
	"snapshot-pre",
	"snapshot-post",
	"attestation",
] as const);
export const R1_PUBLICATION_ORDER = Object.freeze([
	"authority",
	"campaign-lock",
	"staged-capability",
	"staged-metadata-receipts",
	"manifest",
	"verifier-result",
	"report",
] as const);
export const R1_RESERVED_OUTPUT_NAMES = Object.freeze([
	"manifest.json",
	"verifier-result.json",
	"report.md",
	"report.json",
] as const);

export const R1_DIRECT_CABLE_RECEIPTS = Object.freeze(
	representativeFixture().runEntries.map((entry) => ({
		schema: "supervisor-run-network-receipt/v1" as const,
		linuxHostId: "linux-bench-01" as const,
		linuxSupervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		runId: entry.runInstanceId,
		executionIndex: entry.executionIndex,
		transport: entry.transport,
		interface: "eno1" as const,
		interfaceIndex: 2,
		macAddress: "10.99.0.1" as const,
		linuxAddress: "10.99.0.2" as const,
		status: "OBSERVED" as const,
		serverPort: 4433 as const,
		protocol: entry.transport === "ws" ? ("tcp" as const) : ("udp" as const),
		peerObservation:
			entry.transport === "ws"
				? ("inet-diag" as const)
				: ("af-packet" as const),
		serverPgid: 5000 + entry.executionIndex,
		packetsMacToLinux: 3,
		packetsLinuxToMac: 3,
		bytesMacToLinux: 384,
		bytesLinuxToMac: 384,
		captureDropCount: 0 as const,
		firstPacketAt: "2026-08-24T12:30:00.000Z",
		lastPacketAt: "2026-08-24T12:30:01.000Z",
		capturedHeaderDigestSha256: r1FixtureDigest(
			`captured-header-${entry.executionIndex}`,
		),
	})),
);
export const R1_DIRECT_CABLE_RECEIPT_BYTES = canonicalBytes(
	R1_DIRECT_CABLE_RECEIPTS,
);
export const R1_DIRECT_CABLE_RECEIPT_SHA256 =
	"271eb7c786d62a80bd1bf27ecd2c3dd77f45f9a60bb592c65f8d2b0cca6f9d03" as const;

const r1PhysicalFixture = representativeFixture();
export const R1_SUPERVISOR_COMMAND_RECEIPTS = Object.freeze([
	{
		schema: "supervisor-command-receipt/v1" as const,
		hostId: "mac-controller-01",
		supervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
		toolSha256: R1_AUTHORITY_SOURCE.macRouteToolSha256,
		argv: ["route", "-n", "get", "10.99.0.2"] as const,
		sanitizedEnvironmentSha256: r1FixtureDigest("mac-command-env"),
		exitCode: 0,
		stdoutSha256: r1FixtureDigest("mac-route-stdout"),
		stdoutSize: 128,
		stderrSha256: r1FixtureDigest("mac-route-stderr"),
		stderrSize: 0,
		startedAt: "2026-08-24T12:20:00.000Z",
		completedAt: "2026-08-24T12:20:00.010Z",
	},
	{
		schema: "supervisor-command-receipt/v1" as const,
		hostId: "mac-controller-01",
		supervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
		toolSha256: R1_AUTHORITY_SOURCE.macIfconfigToolSha256,
		argv: ["ifconfig", "en8"] as const,
		sanitizedEnvironmentSha256: r1FixtureDigest("mac-command-env"),
		exitCode: 0,
		stdoutSha256: r1FixtureDigest("mac-ifconfig-stdout"),
		stdoutSize: 128,
		stderrSha256: r1FixtureDigest("mac-ifconfig-stderr"),
		stderrSize: 0,
		startedAt: "2026-08-24T12:20:01.000Z",
		completedAt: "2026-08-24T12:20:01.010Z",
	},
	{
		schema: "supervisor-command-receipt/v1" as const,
		hostId: "linux-bench-01",
		supervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		toolSha256: R1_AUTHORITY_SOURCE.linuxIpToolSha256,
		argv: [
			"ip",
			"-j",
			"route",
			"get",
			"10.99.0.1",
			"from",
			"10.99.0.2",
		] as const,
		sanitizedEnvironmentSha256: r1FixtureDigest("linux-command-env"),
		exitCode: 0,
		stdoutSha256: r1FixtureDigest("linux-ip-stdout"),
		stdoutSize: 128,
		stderrSha256: r1FixtureDigest("linux-ip-stderr"),
		stderrSize: 0,
		startedAt: "2026-08-24T12:20:02.000Z",
		completedAt: "2026-08-24T12:20:02.010Z",
	},
	{
		schema: "supervisor-command-receipt/v1" as const,
		hostId: "linux-bench-01",
		supervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		toolSha256: R1_AUTHORITY_SOURCE.linuxIpToolSha256,
		argv: ["ip", "-j", "address", "show", "dev", "eno1"] as const,
		sanitizedEnvironmentSha256: r1FixtureDigest("linux-command-env"),
		exitCode: 0,
		stdoutSha256: r1FixtureDigest("linux-address-stdout"),
		stdoutSize: 128,
		stderrSha256: r1FixtureDigest("linux-address-stderr"),
		stderrSize: 0,
		startedAt: "2026-08-24T12:20:03.000Z",
		completedAt: "2026-08-24T12:20:03.010Z",
	},
	{
		schema: "supervisor-command-receipt/v1" as const,
		hostId: "linux-bench-01",
		supervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		toolSha256: R1_AUTHORITY_SOURCE.linuxTcToolSha256,
		argv: ["tc", "-j", "qdisc", "show", "dev", "eno1"] as const,
		sanitizedEnvironmentSha256: r1FixtureDigest("linux-command-env"),
		exitCode: 0,
		stdoutSha256: r1FixtureDigest("linux-tc-stdout"),
		stdoutSize: 128,
		stderrSha256: r1FixtureDigest("linux-tc-stderr"),
		stderrSize: 0,
		startedAt: "2026-08-24T12:20:04.000Z",
		completedAt: "2026-08-24T12:20:04.010Z",
	},
] as const);
export const R1_SUPERVISOR_COMMAND_RECEIPT_BYTES = canonicalBytes(
	R1_SUPERVISOR_COMMAND_RECEIPTS,
);
export const R1_SUPERVISOR_COMMAND_RECEIPT_SHA256 =
	"dbe01b9352c6c9332a1f35dc1d09201effb6d122f2738b7443b7f4f23e50e540" as const;

export const R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S = Object.freeze(
	R1_SUPERVISOR_COMMAND_RECEIPTS.map((receipt) =>
		sha256Hex(canonicalBytes(receipt)),
	),
);

export const R1_SUPERVISOR_PATH_RECEIPTS = Object.freeze(
	r1PhysicalFixture.cellSnapshotBundles.flatMap((bundle) => {
		const cellIndex = EXPECTED_CELL_IDS.indexOf(
			bundle.cellId as (typeof EXPECTED_CELL_IDS)[number],
		);
		return (["pre-cell", "post-cell"] as const).flatMap((phase) => [
			{
				schema: "supervisor-path-receipt/v1" as const,
				hostId: "mac-controller-01" as const,
				platform: "darwin-arm64" as const,
				supervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
				phase,
				cellId: bundle.cellId,
				interface: "en8" as const,
				interfaceIndex: 18,
				sourceAddress: "10.99.0.1" as const,
				destinationAddress: "10.99.0.2" as const,
				mtu: 1500 as const,
				routeCommandReceiptSha256: R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[0]!,
				interfaceCommandReceiptSha256:
					R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[1]!,
				socketRouteProbeSha256: r1FixtureDigest(
					`mac-socket-route-${cellIndex}`,
				),
				capturedAt: `2026-08-24T12:2${String(cellIndex % 10)}:00.000Z`,
			},
			{
				schema: "supervisor-path-receipt/v1" as const,
				hostId: "linux-bench-01" as const,
				platform: "linux-x86_64" as const,
				supervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
				phase,
				cellId: bundle.cellId,
				interface: "eno1" as const,
				interfaceIndex: 2,
				sourceAddress: "10.99.0.2" as const,
				destinationAddress: "10.99.0.1" as const,
				mtu: 1500 as const,
				routeCommandReceiptSha256: R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[2]!,
				interfaceCommandReceiptSha256:
					R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[3]!,
				socketRouteProbeSha256: r1FixtureDigest(
					`linux-socket-route-${cellIndex}`,
				),
				capturedAt: `2026-08-24T12:2${String(cellIndex % 10)}:30.000Z`,
			},
		]);
	}),
);
export const R1_SUPERVISOR_PATH_RECEIPT_BYTES = canonicalBytes(
	R1_SUPERVISOR_PATH_RECEIPTS,
);
export const R1_SUPERVISOR_PATH_RECEIPT_SHA256 =
	"bfef4e52929c4011ad06540f8844a450e9d85b1a4d351dafb73cacced880869d" as const;

export const R1_SUPERVISOR_QDISC_RECEIPTS = Object.freeze(
	r1PhysicalFixture.runEntries.map((entry) => ({
		schema: "supervisor-qdisc-receipt/v1" as const,
		linuxHostId: "linux-bench-01" as const,
		linuxSupervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		runId: entry.runInstanceId,
		executionIndex: entry.executionIndex,
		interface: "eno1" as const,
		expectedProfileHash: TEST_CAPACITY_PROFILE_HASH,
		beforeCommandReceiptSha256: r1FixtureDigest(
			`qdisc-before-${entry.executionIndex}`,
		),
		beforeKind: "fq" as const,
		status: "RESTORED" as const,
		applyCommandReceiptSha256:
			entry.phase === "warmup"
				? null
				: r1FixtureDigest(`qdisc-apply-${entry.executionIndex}`),
		activeCommandReceiptSha256: r1FixtureDigest(
			`qdisc-active-${entry.executionIndex}`,
		),
		restoreCommandReceiptSha256:
			entry.phase === "warmup"
				? null
				: r1FixtureDigest(`qdisc-restore-${entry.executionIndex}`),
		afterCommandReceiptSha256: r1FixtureDigest(
			`qdisc-after-${entry.executionIndex}`,
		),
		activeKind: entry.phase === "warmup" ? ("fq" as const) : ("netem" as const),
		afterKind: "fq" as const,
		restored: true as const,
		completedAt: "2026-08-24T12:30:01.000Z",
	})),
);
export const R1_SUPERVISOR_QDISC_RECEIPT_BYTES = canonicalBytes(
	R1_SUPERVISOR_QDISC_RECEIPTS,
);
export const R1_SUPERVISOR_QDISC_RECEIPT_SHA256 =
	"1f4714efe8f7286df0e5f4a1f18baec0104a78c0b1478728d30aed29d9d16576" as const;

export const R1_SUPERVISOR_CLEANUP_RECEIPTS = Object.freeze(
	r1PhysicalFixture.runEntries.map((entry) => ({
		schema: "supervisor-cleanup-receipt/v1" as const,
		runId: entry.runInstanceId,
		executionIndex: entry.executionIndex,
		macSupervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
		linuxSupervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		macPgid: 4000 + entry.executionIndex,
		linuxPgid: 5000 + entry.executionIndex,
		status: "CLEAN" as const,
		allOwnedChildrenReaped: true as const,
		noOwnedSocketsRemain: true as const,
		tcp4433ListenerAbsent: true as const,
		udp4433ListenerAbsent: true as const,
		qdiscRestored: true as const,
		completedAt: "2026-08-24T12:30:02.000Z",
	})),
);
export const R1_SUPERVISOR_CLEANUP_RECEIPT_BYTES = canonicalBytes(
	R1_SUPERVISOR_CLEANUP_RECEIPTS,
);
export const R1_SUPERVISOR_CLEANUP_RECEIPT_SHA256 =
	"c56b6f4574bfd5434a48827c46ba53eac9edd0683faa1efcb9ab862d1b16988e" as const;

export const R1_CAMPAIGN_MANIFEST_V1 = r1CampaignLockFixtureSource.manifest;
// The closure's independently written attestation twin, exported so tooling
// can prove it stays value-identical to R1_OBSERVED_ATTESTATION_V1.
export const R1_CAMPAIGN_LOCK_OBSERVED_ATTESTATION =
	r1CampaignLockFixtureSource.observedAttestation;
export const R1_CAMPAIGN_MANIFEST_V1_BYTES = canonicalBytes(
	R1_CAMPAIGN_MANIFEST_V1,
);
export const R1_CAMPAIGN_MANIFEST_V1_SHA256 =
	"b3fb5b4072c0739f537010093bed4ac2ff1820f744ea64dd32536a4228bd1fe0" as const;

export const R1_SUPERVISOR_OBSERVATION_SET_SHA256 =
	"1114d6ee51ad9071cd3926192f5028a42b5542cffd3ee4974b34050fe371d9c5" as const;
export const R1_MAC_RUNTIME_FACTS_SHA256 =
	"ab3dd866b16a972a1cca0774177824a1be29ece22843533778ed53b80a3e859c" as const;
export const R1_LINUX_RUNTIME_FACTS_SHA256 =
	"c026dcf1ac1e183615f755b529d193abf21bbce008dc9ff747b64a260aee96dc" as const;

export const R1_OBSERVED_ATTESTATION_V1 = Object.freeze({
	schema: "observed-attestation/v1" as const,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	lockSha256: R1_CAMPAIGN_LOCK_SHA256,
	capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	observedSource: {
		archiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
		macStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[0].stagedArchiveSha256,
		linuxStagedArchiveSha256: R1_STAGED_ARCHIVE_RECEIPTS[1].stagedArchiveSha256,
		macBunSha256: R1_AUTHORITY_SOURCE.macBunSha256,
		linuxBunSha256: R1_AUTHORITY_SOURCE.linuxBunSha256,
		macSupervisorSha256: R1_AUTHORITY_SOURCE.macSupervisorSha256,
		linuxSupervisorSha256: R1_AUTHORITY_SOURCE.linuxSupervisorSha256,
		macRoleEntrypointsSha256: R1_AUTHORITY_SOURCE.macRoleEntrypointsSha256,
		linuxRoleEntrypointsSha256: R1_AUTHORITY_SOURCE.linuxRoleEntrypointsSha256,
		macAddonSha256: R1_AUTHORITY_SOURCE.macAddonSha256,
		linuxAddonSha256: R1_AUTHORITY_SOURCE.linuxAddonSha256,
	},
	sshHostReceiptSha256: R1_SSH_HOST_RECEIPT_SHA256,
	stagedMetadataReceiptSetSha256: R1_STAGED_METADATA_RECEIPT_SET_SHA256,
	supervisorObservationSetSha256: R1_SUPERVISOR_OBSERVATION_SET_SHA256,
	macRouteFactsSha256: r1FixtureDigest("mac-route-facts"),
	linuxRouteFactsSha256: r1FixtureDigest("linux-route-facts"),
	serverPeerFactsSha256: r1FixtureDigest("server-peer-facts"),
	qdiscFactsSha256: R1_SUPERVISOR_QDISC_RECEIPT_SHA256,
	tlsFactsSha256: r1FixtureDigest("tls-facts"),
	roleFactsSha256: r1FixtureDigest("role-facts"),
	bunRoleLaunchReceiptSetSha256: R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256,
	macRuntimeFactsSha256: R1_MAC_RUNTIME_FACTS_SHA256,
	linuxRuntimeFactsSha256: R1_LINUX_RUNTIME_FACTS_SHA256,
	wtFactsSha256: r1FixtureDigest("wt-facts"),
	telemetryFactsSha256: r1FixtureDigest("telemetry-facts"),
	cleanupFactsSha256: R1_SUPERVISOR_CLEANUP_RECEIPT_SHA256,
	runFactsSha256: R1_DIRECT_CABLE_RECEIPT_SHA256,
	pathSnapshotCount: 70 as const,
	runNetworkReceiptCount: 588 as const,
	qdiscRunReceiptCount: 588 as const,
	cleanupRunReceiptCount: 588 as const,
	childAuthoredObservationForbidden: true as const,
	observedAt: "2026-08-24T12:35:00.000Z",
});
export const R1_OBSERVED_ATTESTATION_V1_BYTES = canonicalBytes(
	R1_OBSERVED_ATTESTATION_V1,
);
export const R1_OBSERVED_ATTESTATION_V1_SHA256 =
	"b8e50268c4f72f9928d211ccb68949ddb3aad781af9cbbbcff9bfd7dcc7031e5" as const;

export const R1_CAMPAIGN_VERIFIER_RESULT_V1 = Object.freeze({
	schema: "campaign-verifier-result/v1" as const,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	lockSha256: R1_CAMPAIGN_LOCK_SHA256,
	capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
	manifestSha256: R1_CAMPAIGN_MANIFEST_V1_SHA256,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	evidenceStatus: "FAIL" as const,
	scenarioVerdict: "NO_VERDICT" as const,
	promotable: false as const,
	comparisonRowCount: 0,
	failures: ["R1_RED_FIXTURE_EXPECTED_PRODUCTION_MISSING"] as const,
	verifiedAt: "2026-08-24T12:36:00.000Z",
});
export const R1_CAMPAIGN_VERIFIER_RESULT_V1_BYTES = canonicalBytes(
	R1_CAMPAIGN_VERIFIER_RESULT_V1,
);
export const R1_CAMPAIGN_VERIFIER_RESULT_V1_SHA256 =
	"d950f1424cb90c0dc8279e9a147b1139cd8e1cc0942b981bf2e13e99e63acae6" as const;

export const R1_CAMPAIGN_REPORT_V1 = Object.freeze({
	schema: "campaign-report/v1" as const,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	lockSha256: R1_CAMPAIGN_LOCK_SHA256,
	capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
	manifestSha256: R1_CAMPAIGN_MANIFEST_V1_SHA256,
	verifierResultSha256: R1_CAMPAIGN_VERIFIER_RESULT_V1_SHA256,
	reportMarkdownSha256: r1FixtureDigest("campaign-report-markdown"),
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	comparisonRowCount: 0,
	renderedAt: "2026-08-24T12:37:00.000Z",
});
export const R1_CAMPAIGN_REPORT_V1_BYTES = canonicalBytes(
	R1_CAMPAIGN_REPORT_V1,
);
export const R1_CAMPAIGN_REPORT_V1_SHA256 =
	"36da38f8c19085da0145444c168ca82a85e0c603c0990e6c6745a51eed9f3770" as const;

export const R1_SUPERVISOR_PHYSICAL_OBSERVATION = Object.freeze({
	schema: "supervisor-physical-observation/v1" as const,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	sshHostReceiptSha256: R1_SSH_HOST_RECEIPT_SHA256,
	pathReceiptSetSha256: R1_SUPERVISOR_PATH_RECEIPT_SHA256,
	commandReceiptSetSha256: R1_SUPERVISOR_COMMAND_RECEIPT_SHA256,
	networkReceiptSetSha256: R1_DIRECT_CABLE_RECEIPT_SHA256,
	qdiscReceiptSetSha256: R1_SUPERVISOR_QDISC_RECEIPT_SHA256,
	cleanupReceiptSetSha256: R1_SUPERVISOR_CLEANUP_RECEIPT_SHA256,
	serverPort: 4433 as const,
	protocols: ["tcp", "udp"] as const,
	peerObservations: ["inet-diag", "af-packet"] as const,
	captureDropCount: 0 as const,
	mac: {
		hostId: "mac-controller-01",
		interface: "en8",
		address: "10.99.0.1",
		mtu: 1500,
		route: "10.99.0.2/32 via en8",
		peer: "linux-bench-01",
		qdiscBefore: "fq",
		qdiscAfter: "fq",
		tool: "route",
		toolSha256: R1_AUTHORITY_SOURCE.macRouteToolSha256,
	},
	linux: {
		hostId: "linux-bench-01",
		interface: "eno1",
		address: "10.99.0.2",
		mtu: 1500,
		route: "10.99.0.1/32 via eno1",
		peer: "mac-controller-01",
		qdiscBefore: "fq",
		qdiscAfter: "fq",
		tool: "ip+tc",
		toolSha256: R1_AUTHORITY_SOURCE.linuxIpToolSha256,
	},
	cleanup: {
		allRunsRestored: true,
		allProcessGroupsReleased: true,
		allQdiscRestored: true,
		receiptCount: 588,
	},
});
export const R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES = canonicalBytes(
	R1_SUPERVISOR_PHYSICAL_OBSERVATION,
);
export const R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256 =
	"c482092d4ce62ed3f98cacc66cdb5c337570813e69527207073ed8420fdb05a2" as const;
export const R1_SUPERVISOR_PHYSICAL_OBSERVATION_ENVELOPE_V1 =
	R1_SUPERVISOR_PHYSICAL_OBSERVATION;
export const R1_SUPERVISOR_PHYSICAL_OBSERVATION_ENVELOPE_V1_BYTES =
	R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES;
export const R1_SUPERVISOR_PHYSICAL_OBSERVATION_ENVELOPE_V1_SHA256 =
	R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256;

/**
 * Representative supervisor protocol envelopes.  These are frozen fixture
 * inputs for RED schema/authority tests, not observations from a live host or
 * evidence of a completed campaign.
 */
export const R1_SUPERVISOR_INPUT_V1 = Object.freeze({
	schema: "comparison-supervisor-input/v1" as const,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	lockSha256: R1_CAMPAIGN_LOCK_SHA256,
	capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
	manifestSha256: R1_CAMPAIGN_MANIFEST_V1_SHA256,
	roleTupleOracleSha256: R1_ROLE_TUPLE_ORACLE_SHA256,
	roleReceiptSetSha256: R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256,
	physicalObservationSha256: R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256,
	expectedProcessCount: 588 as const,
	expectedDescriptorCount: 3599 as const,
	hostIds: ["mac-controller-01", "linux-bench-01"] as const,
	measurement: {
		mac: { interface: "en8", address: "10.99.0.1" },
		linux: { interface: "eno1", address: "10.99.0.2" },
		serverPort: 4433,
		loopbackForbidden: true,
	},
	operation: "load-lock-manifest-verify-promote-report" as const,
});
export const R1_SUPERVISOR_INPUT_V1_BYTES = canonicalBytes(
	R1_SUPERVISOR_INPUT_V1,
);
export const R1_SUPERVISOR_INPUT_V1_SHA256 =
	"f5dd5e2f9e2499b731eabc87915e2e11ef5a51d099889fdfe301bb3de783435c" as const;
export const R1_COMPARISON_SUPERVISOR_INPUT_V1 = R1_SUPERVISOR_INPUT_V1;
export const R1_COMPARISON_SUPERVISOR_INPUT_V1_BYTES =
	R1_SUPERVISOR_INPUT_V1_BYTES;
export const R1_COMPARISON_SUPERVISOR_INPUT_V1_SHA256 =
	R1_SUPERVISOR_INPUT_V1_SHA256;

export const R1_SUPERVISOR_OUTPUT_V1 = Object.freeze({
	schema: "comparison-supervisor-output/v1" as const,
	candidate: R1_CANDIDATE_ID,
	campaignId: R1_CAMPAIGN_ID,
	authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
	lockSha256: R1_CAMPAIGN_LOCK_SHA256,
	capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
	manifestSha256: R1_CAMPAIGN_MANIFEST_V1_SHA256,
	verifierResultSha256: R1_CAMPAIGN_VERIFIER_RESULT_V1_SHA256,
	reportSha256: R1_CAMPAIGN_REPORT_V1_SHA256,
	physicalObservationSha256: R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256,
	roleReceiptSetSha256: R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256,
	status: "BLOCKED" as const,
	comparisonRowCount: 0 as const,
	promotable: false as const,
	publicationOrder: R1_PUBLICATION_ORDER,
	operation: "load-lock-manifest-verify-promote-report" as const,
});
export const R1_SUPERVISOR_OUTPUT_V1_BYTES = canonicalBytes(
	R1_SUPERVISOR_OUTPUT_V1,
);
export const R1_SUPERVISOR_OUTPUT_V1_SHA256 =
	"56df23e6789d69c56876b0cb6f94548ce02b33b4d941f66f64f9ec611c477448" as const;
export const R1_COMPARISON_SUPERVISOR_OUTPUT_V1 = R1_SUPERVISOR_OUTPUT_V1;
export const R1_COMPARISON_SUPERVISOR_OUTPUT_V1_BYTES =
	R1_SUPERVISOR_OUTPUT_V1_BYTES;
export const R1_COMPARISON_SUPERVISOR_OUTPUT_V1_SHA256 =
	R1_SUPERVISOR_OUTPUT_V1_SHA256;

export const R1_COMPARISON_SUPERVISOR_ERROR_V1 = Object.freeze({
	schema: "comparison-supervisor-error/v1" as const,
	code: "OUTPUT_TRUST_BOUNDARY_UNAVAILABLE" as const,
	operation: "load-lock-manifest-verify-promote-report" as const,
	osCode: null,
});
export const R1_COMPARISON_SUPERVISOR_ERROR_V1_BYTES = canonicalBytes(
	R1_COMPARISON_SUPERVISOR_ERROR_V1,
);
export const R1_COMPARISON_SUPERVISOR_ERROR_V1_SHA256 =
	"42b53bef87700598a9cb77ad5db6176030068c5cbd3ce9bbdb1d33c3c39d9bfe" as const;
export const R1_SUPERVISOR_ERROR_V1 = R1_COMPARISON_SUPERVISOR_ERROR_V1;
export const R1_SUPERVISOR_ERROR_V1_BYTES =
	R1_COMPARISON_SUPERVISOR_ERROR_V1_BYTES;
export const R1_SUPERVISOR_ERROR_V1_SHA256 =
	R1_COMPARISON_SUPERVISOR_ERROR_V1_SHA256;

export const R1_CHILD_OBSERVATION_FORBIDDEN = Object.freeze({
	role: "campaign-child",
	uname: "Darwin 26.0.0",
	cpuCount: 12,
	fdLimit: 65536,
	route: "10.99.0.2/32 via en8",
	socketList: ["10.99.0.1:4433"],
	launchReceipt: "child-supplied-launch-receipt",
});

export const R1_AUTHORITY_DIGEST_GRAPH = Object.freeze([
	["r1-red-approval-bundle/v1", "campaign-authority/v1"],
	["source-archive-receipt", "campaign-authority/v1"],
	["campaign-reservation/v1", "campaign-authority/v1"],
	["host-submission/v1", "campaign-authority/v1"],
	["campaign-authority/v1", "campaign-lock/v1"],
	["campaign-lock/v1", "staged-capability/v1"],
	["campaign-authority/v1", "run/raw/snapshot"],
	["staged-capability/v1", "run/raw/snapshot"],
	["campaign-lock/v1", "run/raw/snapshot"],
	["run/raw/snapshot", "campaign-manifest/v1"],
	["campaign-authority/v1", "campaign-manifest/v1"],
	["campaign-lock/v1", "campaign-manifest/v1"],
	["staged-capability/v1", "campaign-manifest/v1"],
	["campaign-manifest/v1", "campaign-verifier-result/v1"],
	["campaign-verifier-result/v1", "campaign-report/v1"],
] as const);

export const R1_STREAMING_LIMIT_FIXTURE = Object.freeze({
	maxBytes: 2 * 1024 * 1024,
	underLimitBytes: new Uint8Array(2 * 1024 * 1024),
	overLimitBytes: new Uint8Array(2 * 1024 * 1024 + 1),
});

export const R1_WINDOWS_EARLY_REJECT_EXPECTATION = Object.freeze({
	platform: "windows" as const,
	code: "OUTPUT_PLATFORM_UNSUPPORTED" as const,
	stdout: "",
	ioEvents: [] as const,
	imports: [] as const,
	spawnedChildren: 0,
});

export const R1_SECURE_FS_REJECTION_CASES = Object.freeze([
	["symlink-component", "OUTPUT_PATH_REPARSE"],
	["magic-link-component", "OUTPUT_PATH_REPARSE"],
	["cross-device-component", "OUTPUT_PATH_CROSS_DEVICE"],
	["fifo-leaf", "OUTPUT_FILE_INVALID"],
	["socket-leaf", "OUTPUT_FILE_INVALID"],
	["device-leaf", "OUTPUT_PATH_DEVICE"],
	["alias-path", "OUTPUT_PATH_ALIAS"],
	["group-writable-root", "OUTPUT_FILE_INVALID"],
	["world-writable-root", "OUTPUT_FILE_INVALID"],
	["closed-root-handle", "OUTPUT_HANDLE_CLOSED"],
] as const);

// A.3 requires every inherited root/staging descriptor to carry its complete
// pinned POSIX identity.  These mutations deliberately cover both omission and
// drift for each inherited directory; production must reject all four with one
// stable typed identity failure before opening any declared component.
export const R1_SECURE_FS_IDENTITY_MUTATION_CASES = Object.freeze([
	["missing-root-identity", "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH"],
	["wrong-root-identity", "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH"],
	["missing-staging-identity", "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH"],
	["wrong-staging-identity", "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH"],
] as const);

export const R1_SECURE_FS_SYSCALL_SCRIPT = Object.freeze([
	["open-root", "campaign-root", "read-only-directory"],
	["stat-root-identity", "campaign-root", "pinned-identity"],
	["open-declared-leaf", "manifest.json", "read-only-regular"],
	["read-bounded", "manifest.json", "max-67108864"],
	["hash-exact-bytes", "manifest.json", "sha256"],
	["create-new", "verifier-result.json", "exclusive"],
	["sync-file", "verifier-result.json", "durable"],
	["sync-parent", "campaign-root", "durable"],
	["cleanup-token", "verifier-result.json", "opaque-token"],
] as const);

export const R1_SECURE_FS_RACE_CASES = Object.freeze([
	["intermediate-ancestor-swap", "OUTPUT_PATH_REPARSE"],
	["leaf-ancestor-swap", "OUTPUT_PATH_REPARSE"],
	["rename-after-open", "OUTPUT_PATH_ALIAS"],
	["single-use-recovery", "OUTPUT_CLEANUP_FAILED"],
] as const);
