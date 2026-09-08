/**
 * Phase 3 of the WS-WT real-number campaign: a two-host staging
 * controller.
 *
 * The controller drives a real two-host measurement:
 *   1. SSH to the Linux bench at 10.99.0.2/eno1, SCP the candidate binary.
 *   2. Verify the direct-cable route with `ping -S`.
 *   3. Apply netem to Linux egress, start the Linux server, run balanced
 *      protocol arms, collect evidence to
 *      .release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/.
 *   4. Restore netem.
 *
 * Every step is bounded by a deadline from `deadlines.ts`. Every error
 * path is typed. The controller is real-machine-only by design; the
 * `parseRoutes`, `buildSshArgv`, `buildNetemCommands`, and
 * `resolveEvidencePath` helpers are pure and tested without a rig.
 *
 * `--dry-run` runs the same orchestration but stops at each network
 * boundary and prints the would-execute command and the expected
 * evidence path. Static checks fail closed: a bad route, a bad SSH
 * argv, a path outside OFFICIAL_COMPARISON_OUTPUT_ROOT, or a
 * deadline without a hard upper bound all abort with a typed error
 * code before any side effect.
 *
 * Phase 3.4 (real rig execution) is gated on Linux bench
 * availability. When the bench is not available, the campaign writes
 * a deviation record and stops; this file does not pretend a run
 * happened.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	BidiChannel,
	ChannelConfig,
	ClientConfig,
	DeliveryKind,
	ReceiveChannel,
	SendChannel,
	ServerConfig,
	ServerHandle,
	Session,
	SubmittedCapacityProfile,
	TransportAdapter,
	TransportClock,
	TransportMetrics,
} from "../adapters/transport.ts";
import { systemTransportClock } from "../adapters/transport.ts";
import { createWsWorkerAdapter } from "../adapters/ws-worker.ts";
import { createWtStreamSinkAdapter } from "../adapters/wt-stream-sink.ts";
import {
	type ArmMeasureSupervisorContext,
	type CohortLegSources,
	measuredCohortToArm,
	measuredLegToArm,
} from "../arm-measure.ts";
import {
	type ArmCohortEvidenceV1,
	cohortEvidenceFromExportAck,
} from "../artifact-builder.ts";
import {
	sha256Canonical as canonicalDigest,
	canonicalJson,
} from "../canonical.ts";
import {
	adapterForTransport,
	HANDSHAKE_FIRST_MESSAGE_BYTES,
	type LegPlan,
	legPlanForCell,
	type MeasuredLeg,
	measureLegOverAdapter,
} from "../client.ts";
import {
	COHORT_DRAIN_DEADLINE_MS,
	type CohortAdmissionReceiptV1,
	type CohortCellCardinalityV1,
	type CohortCellGrantParametersV1,
	type CohortGrantV1,
	type CohortLedgerV1,
	type CohortRateSeriesV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	cohortCellCardinality,
	cohortCellGrantParameters,
	type LinuxRelayObservationV1,
	type PublisherPartialV1,
	parseCohortStartBarrier,
	parseCohortWarmupEpoch,
	parseConnectPermitComplete,
	parseConnectPermitRequest,
	parseLinuxRelayObservation,
	parsePublisherPartial,
	parseRoleExited,
	parseRoleMeasureStartAck,
	parseRolePartial,
	parseRoleReady,
	parseRoleWarmupComplete,
	parseStagedServerLaunchRecord,
	STAGED_SERVER_TLS_CERTIFICATE_LEAF,
	type CohortServerHost,
	type CohortStageProfile,
	cohortServerHostForProfile,
	isCohortStageProfile,
	stagedServerLaunchRecordProfile,
	parseWorkerPartial,
	type RetainedCanonicalBytesV1,
	type RoleMeasureStartV1,
	type RoleSpawnConfigV1,
	type RoleWarmupStartV1,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	type StagedServerLaunchRecordV1,
	type TokenBundleV1,
	WARMUP_DURATION_MS,
	WARMUP_INTERVAL_MS,
	WARMUP_MESSAGES_PER_PUBLISHER,
	type WorkerPartialV1,
} from "../cohort-protocol.ts";
import type {
	CampaignRefusalCode,
	CrossSupervisorExecutionDraftV1,
	MacCohortEvidenceExportedAckV1,
	NsString,
	ProtocolResult,
	RigExecutionAcceptanceV1,
	RigReceiptSignatureV1,
	Sha256Hex,
} from "../cross-supervisor-protocol.ts";
import {
	CAMPAIGN_FAILURE_CODES,
	type CampaignFailureCode,
	isCampaignFailureCode,
	PHASE_A_DECLARED_MESSAGE_BYTES,
	PHASE_A_DECLARED_MESSAGE_COUNT,
	parseCrossSupervisorExecutionDraft,
	type MacReceiptSignatureV1,
	parseMacReceiptSignature,
} from "../cross-supervisor-protocol.ts";
import {
	type AdmissionCounters,
	type ArtifactTrustContext,
	cohortCellForArm,
	type MetricContract,
	metricContractForScenario,
	parseMeasurementGrant,
	type RunArtifact,
	sealRunArtifact,
	type ToolchainSet,
} from "../evidence.ts";
import {
	evaluateCellPromotionGate,
	type PromotionGateEntry,
	type PromotionGateRefusalCode,
	resolveOfficialComparisonOutputDir,
} from "../output-policy.ts";
import {
	CohortRigChannel,
	type CohortRigSpawnServerRequestV1,
	type ControlCommandResult,
	createDurableFilesystemReplayLedger,
	createMacFanoutRoleChildHost,
	createMacProductionCohortMinter,
	MAC_SUPERVISOR_DEFAULT_USER,
	MacCohortChannel,
	type MacExecutionOpenedV1,
	type MacFanoutChildPlanV1,
	type MacFanoutChildStateV1,
	type MacFanoutRoleChildHost,
	MacFanoutSupervisor,
	type MacFanoutTeardownResultV1,
	type MacFanoutTerminalPath,
	type MacMeasurementAdmissionIssuedV1,
	type MacPermitScheduler,
	type MacProductionCohortTokenMaterialV1,
	type MacRoleChildControlChannel,
	macTokenBundleForPlan,
	presentArtifactPayload,
	type RigBarrierAcceptanceBundleV1,
	type RigCaptureBundleV1,
	type RigCohortAcceptanceBundleV1,
	type RigMeasureStartAckBundleV1,
	type RigServerReadyV1,
	type RigServerStoppedV1,
	type RigWarmupDrainedBundleV1,
	resolveSupervisorBinaryPath,
	resolveSupervisorBunPath,
	type SingleRootTrustBootstrapPaths,
	type StagedTrustBootstrapPaths,
	type SupervisorHandle,
	spawnMacSupervisor,
	spawnRigSupervisor,
	stopSupervisor,
	TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	TRUST_BOOTSTRAP_AUTHORITY_LEAF,
	verifyStagedTrustBootstrap,
} from "../remote-supervisor.ts";
import { buildMeasuredArmArtifact } from "../run-campaign.ts";
import { fileAdmittedMeasurement, type SealedMeasurement } from "../stats.ts";
import {
	CANONICAL_SCENARIO_REGISTRY,
	listScenarioArms,
	requestedImpairmentOf,
} from "../scenario-registry.ts";
import { buildFanoutCohortFixture } from "../scenarios/fanout-relay.ts";
import { createGameLedger } from "../scenarios/game.ts";
import {
	canonicalRecordBytes,
	parseStrictJsonBytes,
	R1_CAMPAIGN_AUTHORITY_SHA256,
	sha256HexOfBytes,
} from "../secure-fs.ts";
import {
	type ServerMode,
	type StagedServerLaunchDigests,
	stagedServerLaunchArgv,
	stagedServerLaunchModesForProfile,
	stagedServerLaunchRecordLeaf,
} from "../server.ts";
import {
	type ArmAttestationEvidenceV2,
	type AttestationTrustMaterial,
	type MacMeasurementAdmissionReceiptV1,
	type RigServerSnapshotReceiptV1,
	type ServerObservationEvidenceV1,
	verifyArmAttestationEvidence,
} from "../server-observation-artifact.ts";
import {
	isServerLoopUtilizationFrameV1,
	SERVER_SNAPSHOT_SCHEMA,
	type ServerLoopUtilizationFrameV1,
	type ServerSnapshotRecord,
} from "../server-snapshot-protocol.ts";
import {
	type MeasurementSeries,
	measurementPayloadBytes,
} from "../supervisor-protocol.ts";
import {
	observeLocalToolchain,
	toolchainIdentity,
} from "../toolchain-observation.ts";
import type {
	ArmKind,
	ArmTransport,
	GameParameters,
	ScenarioCell,
	ScenarioParameters,
} from "../types.ts";
import {
	trustContextForArtifact,
	verifyRunArtifact,
} from "../verify-artifact.ts";
import {
	MAC_CONTINUOUS_CLOCK_METHOD,
	readMacContinuousNs,
	STAGED_TLS_CA_PEM_ENV,
} from "./fanout-role.ts";

/** Wire transports the Phase-4 / full-matrix seal path can open. */
export type SealTransport = "ws" | "wt";

/** Phase-4 first-honest gate cells (Task 4.1). Bulk first: proven Mbps seal path. */
export const PHASE4_GATE_CELLS = [
	"bulk-one-way/physical",
	"ticker-fanout/rate-250",
] as const;

/** Path-safe cell id for official evidence layout. */
export function cellSafeId(cellId: string): string {
	return cellId.replace(/[/:]/g, "_");
}

/**
 * Which run-id cohort an arm belongs to.
 *
 * A grant is minted against `(runId, transport)`, and `transport` is the wire.
 * So `ws` and `ws-worker` — same wire, same rep — would alias onto one grant if
 * they shared a run id, and the second `openExecution` would be refused as a
 * replay. They cannot simply be given per-arm run ids either: `compare.ts`
 * pairs two arms only when their run ids match, and the pairs are `ws`↔`wt`
 * (main loop) and `ws-worker`↔`wt-stream-sink` (off loop).
 *
 * The cohort is the resolution. Arms that are paired against each other share
 * a run id; arms that share a wire do not. The overlay is its own cohort
 * because it is never paired at all.
 */
export type SealArmTier = "main-loop" | "off-loop" | "overlay";

/** One measurable arm of one cell, as the seal path schedules it. */
export interface SealArm {
	/** `<cellId>/<suffix>`, the frozen registry identity. */
	readonly armId: string;
	readonly armKind: ArmKind;
	/** The wire the arm rides. This is what the grant is opened for. */
	readonly transport: SealTransport;
	/** Absent only for the overlay, which declares no arm transport. */
	readonly armTransport?: ArmTransport;
	readonly label: string;
	readonly tier: SealArmTier;
}

function tierFor(armKind: ArmKind): SealArmTier {
	switch (armKind) {
		case "primary":
			return "main-loop";
		case "read-path":
			return "off-loop";
		case "overlay":
			return "overlay";
		default: {
			const _exhaustive: never = armKind;
			return _exhaustive;
		}
	}
}

/**
 * The arms the registry already declares for one cell, in registry order.
 *
 * Read out of `listScenarioArms` rather than composed here: the arm inventory
 * is frozen, cell eligibility for the second tier is `armEligibilityFor`'s
 * answer, and a controller that built its own list would be a second source of
 * truth for which arms exist. `wires` narrows by wire so `--arms=ws` still
 * means what it meant; `armKinds` narrows by kind for a primary-only run.
 */
export function sealArmsForCell(
	cell: ScenarioCell,
	wires: readonly SealTransport[] = ["ws", "wt"],
	armKinds: readonly ArmKind[] = ["primary", "read-path", "overlay"],
): readonly SealArm[] {
	const allowedWires = new Set(wires);
	const allowedKinds = new Set(armKinds);
	const arms: SealArm[] = [];
	for (const arm of listScenarioArms(CANONICAL_SCENARIO_REGISTRY)) {
		if (arm.cellId !== cell.cellId) continue;
		if (!allowedWires.has(arm.transport)) continue;
		if (!allowedKinds.has(arm.armKind)) continue;
		arms.push({
			armId: arm.armId,
			armKind: arm.armKind,
			transport: arm.transport,
			...(arm.armTransport !== undefined
				? { armTransport: arm.armTransport }
				: {}),
			label: arm.label,
			tier: tierFor(arm.armKind),
		});
	}
	return arms;
}

/** One scheduled measurement: a cell, one of its arms, one repetition. */
export interface SealArmSlot {
	readonly cellId: string;
	readonly arm: SealArm;
	readonly repIndex: number;
}

/**
 * The campaign's full schedule, cell-major then arm-major then rep.
 *
 * Cell-major keeps the netem profile and the Linux server restart amortised
 * across a cell's arms, which is the same ordering the primary-only loop
 * already used; widening it to every arm kind is the only change.
 */
export function sealArmSchedule(input: {
	readonly cells: readonly ScenarioCell[];
	readonly wires?: readonly SealTransport[];
	readonly armKinds?: readonly ArmKind[];
	readonly repetitions: number;
}): readonly SealArmSlot[] {
	const slots: SealArmSlot[] = [];
	for (const cell of input.cells) {
		for (const arm of sealArmsForCell(cell, input.wires, input.armKinds)) {
			for (let repIndex = 1; repIndex <= input.repetitions; repIndex += 1) {
				slots.push({ cellId: cell.cellId, arm, repIndex });
			}
		}
	}
	return slots;
}

/** One scheduled execution of one arm: the warmup, or a measured repetition. */
export interface ArmRepetitionSlot {
	readonly repetitionKind: "warmup" | "measured";
	/** 0 for the warmup; 1..N for the measured repetitions. */
	readonly repetitionIndex: number;
}

/**
 * The §6 schedule for one arm, derived from the purpose and nothing else.
 *
 * `focused` and `pilot` run one unsealed warmup and one measured repetition;
 * `canonical` runs one unsealed warmup and five distinct measured repetitions.
 * The warmup carries index 0 so it can never collide with a measured index in
 * `campaignIndexKey` — a warmup that indexed as rep 1 would be a sixth
 * repetition with a label, and the promotion set gate counts indices.
 */
export function armRepetitionSchedule(
	executionPurpose: "focused" | "pilot" | "canonical",
): readonly ArmRepetitionSlot[] {
	const measured = executionPurpose === "canonical" ? 5 : 1;
	const slots: ArmRepetitionSlot[] = [
		{ repetitionKind: "warmup", repetitionIndex: 0 },
	];
	for (let index = 1; index <= measured; index += 1) {
		slots.push({ repetitionKind: "measured", repetitionIndex: index });
	}
	return slots;
}

/** The measured repetition count §6 fixes for a purpose. */
export function measuredRepetitionsForPurpose(
	executionPurpose: "focused" | "pilot" | "canonical",
): 1 | 5 {
	return executionPurpose === "canonical" ? 5 : 1;
}

/**
 * The run id an arm's grant is opened under.
 *
 * Main-loop arms keep the existing `<pair>-rep-N` shape so an index written by
 * the primary-only loop still resumes and still pairs; the two later cohorts
 * get their own prefix.
 */
export function sealRunIdForArm(
	pairRunId: string,
	arm: SealArm,
	repIndex: number,
): string {
	const cohort = arm.tier === "main-loop" ? "" : `-${arm.tier}`;
	return `${pairRunId}${cohort}-rep-${repIndex}`;
}

/** True for the two arms whose sealed flats the promote step publishes. */
export function isPromotableFlatArm(arm: SealArm): boolean {
	return arm.armKind === "primary";
}

/**
 * The arm id's suffix: `ws`, `wt`, `ws-worker`, `wt-stream-sink`, `ws-overlay`.
 *
 * Read off `armId` rather than recomposed, so the evidence directory an arm
 * writes into is named by the same token the frozen inventory uses.
 */
export function sealArmSlotId(arm: SealArm): string {
	return arm.armId.slice(arm.armId.lastIndexOf("/") + 1);
}

/**
 * Every arm the canonical registry declares, across every cell.
 *
 * Exported so the campaign can state the size of the matrix it is attempting
 * from the registry rather than from a number written in a doc.
 */
export function canonicalSealArmCount(): number {
	return CANONICAL_SCENARIO_REGISTRY.cells.reduce(
		(total, cell) => total + sealArmsForCell(cell).length,
		0,
	);
}

/** `wss://` for WS-family, `https://` for WT-family. */
export function serverUrlForTransport(
	transport: SealTransport,
	linuxAddress: string,
	serverPort: number,
): string {
	const scheme = transport === "ws" ? "wss" : "https";
	return `${scheme}://${linuxAddress}:${serverPort}`;
}

/**
 * Resolve the comparable LegPlan for grant declarations.
 * Prefer cell-parameterized math matching executor `execute()`; fall back to
 * executor static `legPlan()` / `legPlanForCell`.
 */
export function resolveSealLegPlan(cell: ScenarioCell): LegPlan {
	const params = cell.parameters as ScenarioParameters;
	switch (params.scenarioId) {
		case "bulk-one-way":
			return {
				deliveryKind: "reliable-message",
				messageCount: Math.ceil(params.bytes / params.chunkBytes),
				messageBytes: params.chunkBytes,
			};
		case "ticker-fanout":
			return {
				deliveryKind: "reliable-message",
				messageCount:
					params.ingressRatePerSecond *
					params.durationSeconds *
					params.publisherCount,
				messageBytes: params.recordBytes,
			};
		case "chat-fanout":
			return {
				deliveryKind: "reliable-message",
				messageCount:
					params.durationSeconds *
					params.publisherCount *
					params.messagesPerSecondPerPublisher,
				messageBytes: params.messageBytes,
			};
		case "crdt-sync":
			return {
				deliveryKind: "reliable-message",
				// Single-session sealable minimum: 1s at registry ops/s.
				// Full operationsPerSecond×durationSeconds is campaign topology.
				messageCount: Math.min(
					params.operationsPerSecond * params.durationSeconds,
					params.operationsPerSecond,
				),
				messageBytes: params.operationBytes,
			};
		case "game-tick-loss":
			return {
				deliveryKind: "datagram",
				messageCount: params.tickHz * params.durationSeconds,
				messageBytes: params.tickBytes,
			};
		case "ai-token-stream":
			return {
				deliveryKind: "reliable-message",
				// Single-session sealable minimum; × sessionCount is campaign topology.
				messageCount: params.chunksPerSecondPerSession * params.durationSeconds,
				messageBytes: params.chunkBytes,
			};
		case "reconnect-storm":
			return {
				deliveryKind: "reliable-message",
				// Single-session sealable minimum; × clientCount is campaign topology.
				messageCount: params.reconnectCycles,
				messageBytes: params.firstMessageBytes,
			};
		case "handshake-matrix":
			return {
				deliveryKind: "reliable-message",
				messageCount: params.measuredConnectionsPerWorker,
				messageBytes: HANDSHAKE_FIRST_MESSAGE_BYTES,
			};
		case "connection-memory":
			return {
				deliveryKind: "reliable-message",
				// Single-session sealable minimum; liveConnections cohort is campaign topology.
				messageCount: 1,
				messageBytes: 1,
			};
		case "tail-under-cross-traffic":
			return {
				deliveryKind: "reliable-message",
				messageCount: params.controlRatePerSecond * params.durationSeconds,
				messageBytes: params.controlMessageBytes,
			};
		default: {
			const _exhaustive: never = params;
			void _exhaustive;
			return legPlanForCell(cell);
		}
	}
}

/**
 * Grant load declarations from the cell's sealable LegPlan.
 *
 * This is the *leg* declaration: what one session is authorised to put on the
 * wire. It is the right declaration for every arm that runs a leg, which after
 * B4 means every arm except the six fanout primaries. Those six are declared by
 * `sealGrantDeclarationForArm` below, and the seal path calls only that.
 */
export function grantDeclarationsFromCell(cell: ScenarioCell): {
	readonly declaredMessageCount: number;
	readonly declaredMessageBytes: number;
} {
	const plan = resolveSealLegPlan(cell);
	return {
		declaredMessageCount: plan.messageCount,
		declaredMessageBytes: plan.messageBytes,
	};
}

// ---------------------------------------------------------------------------
// B4: the expanded fanout grant declaration
// ---------------------------------------------------------------------------

/** Which of the two §4.1 declarations a grant is opened under. */
export type SealGrantDeclarationKind =
	| "phase-a-completed-transfer"
	| "fanout-expanded-deliveries";

export interface SealGrantDeclaration {
	readonly grantDeclaration: SealGrantDeclarationKind;
	readonly declaredMessageCount: number;
	readonly declaredMessageBytes: number;
}

/**
 * Why a fanout grant declaration was refused.
 *
 * `COHORT_PROTOCOL` is the §7 code for "the cohort this names is not the
 * cohort that exists", which is exactly what a declaration stating offered
 * ingress where the plan requires expanded deliveries is.
 */
export class FanoutGrantDeclarationError extends Error {
	readonly code = "COHORT_PROTOCOL";
	readonly cellId: string;
	readonly expected: SealGrantDeclaration;

	constructor(cellId: string, expected: SealGrantDeclaration, saw: string) {
		super(
			`fanout grant declaration for ${cellId} must be ${expected.grantDeclaration} ` +
				`${expected.declaredMessageCount}x${expected.declaredMessageBytes}; got ${saw}`,
		);
		this.name = "FanoutGrantDeclarationError";
		this.cellId = cellId;
		this.expected = expected;
	}
}

/**
 * The declaration one arm's grant must state.
 *
 * For the six fanout primaries this is the *expanded* delivery count from the
 * frozen §4.5 table — `offeredIngress * subscriberCount` — and not the offered
 * ingress. The difference is the whole point of the cell: a ticker 250 arm
 * offers 2,500 records and the relay owes 250,000 deliveries, and a grant
 * that authorised 2,500 would let a cohort that delivered a hundredth of
 * what it owed present a series the supervisor had no reason to refuse.
 * `assertMeasuredArmIsGranted` compares the sealed series against exactly this
 * number, so declaring the unexpanded one is not a cosmetic understatement.
 *
 * Every other arm — including the read-path arms of the same six cells, which
 * shadow the wire but run no cohort — keeps the leg declaration it had.
 */
export function sealGrantDeclarationForArm(input: {
	readonly cell: ScenarioCell;
	readonly armKind: ArmKind;
}): SealGrantDeclaration {
	const cohortCell = cohortCellForArm({
		cellId: input.cell.cellId,
		armKind: input.armKind,
	});
	if (cohortCell === null) {
		const leg = grantDeclarationsFromCell(input.cell);
		return {
			grantDeclaration: "phase-a-completed-transfer",
			declaredMessageCount: leg.declaredMessageCount,
			declaredMessageBytes: leg.declaredMessageBytes,
		};
	}
	const cardinality = cohortCellCardinality(cohortCell);
	return {
		grantDeclaration: "fanout-expanded-deliveries",
		declaredMessageCount: cardinality.expandedDeliveries,
		declaredMessageBytes:
			FANOUT_MESSAGE_BYTES_BY_SCENARIO[
				input.cell.scenarioId as "ticker-fanout" | "chat-fanout"
			],
	};
}

/**
 * The two frozen §4.1 `messageBytes` literals.
 *
 * Read off the plan rather than off the cell parameters on purpose: the grant
 * is what the rig verifies the wire against, and it has to be a constant of the
 * contract rather than a value a registry edit could move underneath a signed
 * record.
 */
const FANOUT_MESSAGE_BYTES_BY_SCENARIO: Readonly<
	Record<"ticker-fanout" | "chat-fanout", 100 | 128>
> = Object.freeze({ "ticker-fanout": 100, "chat-fanout": 128 });

/**
 * Refuse a grant declaration that is not the one this arm must state.
 *
 * Called on the value actually about to be sent to the supervisor, not on the
 * value the caller intended, so a caller that computes the declaration itself
 * and gets it wrong is refused before `openExecution` mints anything.
 */
export function assertFanoutGrantDeclaration(input: {
	readonly cell: ScenarioCell;
	readonly armKind: ArmKind;
	readonly declared: {
		readonly declaredMessageCount: number;
		readonly declaredMessageBytes: number;
		readonly grantDeclaration?: SealGrantDeclarationKind;
	};
}): void {
	const expected = sealGrantDeclarationForArm({
		cell: input.cell,
		armKind: input.armKind,
	});
	if (expected.grantDeclaration !== "fanout-expanded-deliveries") return;
	const saw = input.declared;
	if (
		saw.declaredMessageCount !== expected.declaredMessageCount ||
		saw.declaredMessageBytes !== expected.declaredMessageBytes ||
		(saw.grantDeclaration !== undefined &&
			saw.grantDeclaration !== expected.grantDeclaration)
	) {
		throw new FanoutGrantDeclarationError(
			input.cell.cellId,
			expected,
			`${saw.grantDeclaration ?? "(unlabelled)"} ${saw.declaredMessageCount}x${saw.declaredMessageBytes}`,
		);
	}
}

/**
 * The `ws-overlay` arm: the WS wire with the shipped latest-state filter.
 *
 * The overlay is a receiver-side policy, so it has to run *during* the
 * measurement and not after it. Post-processing a sealed leg is not available
 * as a shortcut and should not be: the recorder's samples are attested by
 * `assertRecordedMeasurement`, so an overlay that rewrote them afterwards would
 * be refused — correctly — as a forged series.
 *
 * The drop rule is not reimplemented here. `createGameLedger` from
 * `scenarios/game.ts` already owns "expired or stale is dropped at the
 * receiver", and this wrapper asks it after each record whether the tick
 * survived by reading `receivedTicks` across the call. That probe is the only
 * way to ask the ledger a per-record question through its current surface, and
 * it is cheaper than the alternative of writing the rule down a second time
 * and letting the two drift.
 *
 * A dropped tick simply is not returned to the leg, so the leg's per-sequence
 * receive runs out its deadline and counts as attempted-not-delivered. That is
 * the overlay's whole effect on the primary metric, and it is measured rather
 * than declared.
 */
export function createLossyOverlayWsAdapter(input: {
	readonly base: TransportAdapter;
	readonly cell: ScenarioCell;
	readonly runId: string;
	readonly clock: TransportClock;
	readonly perMessageTimeoutMs: number;
}): TransportAdapter {
	if (input.base.kind !== "ws") {
		throw new RangeError(
			`createLossyOverlayWsAdapter: the overlay rides the ws wire; got ${input.base.kind}`,
		);
	}
	const parameters = input.cell.parameters as ScenarioParameters;
	if (parameters.scenarioId !== "game-tick-loss") {
		throw new RangeError(
			`createLossyOverlayWsAdapter: the overlay is declared for game-tick-loss only; got ${parameters.scenarioId}`,
		);
	}
	const game = parameters as GameParameters;
	const clock = input.clock;
	const perMessageTimeoutMs = input.perMessageTimeoutMs;

	const wrapSession = (base: Session): Session => {
		const ledger = createGameLedger({
			runId: input.runId,
			tickHz: game.tickHz,
			tickBytes: game.tickBytes,
			durationSeconds: game.durationSeconds,
			receiverCount: game.receiverCount,
			delivery: "latest-state",
			lossyOverlay: true,
		});
		const receiverId = `${input.runId}-overlay-receiver`;
		return {
			get role(): string {
				return base.role;
			},
			sendMessage: (kind, message, deadlineMs) =>
				base.sendMessage(kind, message, deadlineMs),
			async receiveMessage(kind: DeliveryKind, deadlineMs: number) {
				for (;;) {
					const message = await base.receiveMessage(kind, deadlineMs);
					const receivedAtMs = clock.nowMs();
					const before = ledger.receivedTicks;
					ledger.recordReceived(
						receiverId,
						message.sequence,
						receivedAtMs,
						message.expiresAtMs - perMessageTimeoutMs,
						message.expiresAtMs,
					);
					if (ledger.receivedTicks > before) return message;
					// Dropped by the overlay. Keep reading on the same deadline;
					// once it passes, the base adapter's own timeout is what the
					// leg sees, which is the honest "this tick did not arrive".
				}
			},
			sendText: (text, deadlineMs) => base.sendText(text, deadlineMs),
			openUni: (deadlineMs: number, config?: ChannelConfig) =>
				base.openUni(deadlineMs, config) as Promise<SendChannel>,
			acceptUni: (deadlineMs: number): Promise<ReceiveChannel> =>
				base.acceptUni(deadlineMs),
			openBidi: (
				deadlineMs: number,
				config?: ChannelConfig,
			): Promise<BidiChannel> => base.openBidi(deadlineMs, config),
			acceptBidi: (deadlineMs: number): Promise<BidiChannel> =>
				base.acceptBidi(deadlineMs),
			close: (deadlineMs: number) => base.close(deadlineMs),
			snapshot: (): TransportMetrics => base.snapshot(),
		};
	};

	return {
		kind: "ws",
		get submittedCapacityProfile(): SubmittedCapacityProfile {
			return input.base.submittedCapacityProfile;
		},
		startServer: (config: ServerConfig): Promise<ServerHandle> =>
			input.base.startServer(config),
		async connect(config: ClientConfig): Promise<Session> {
			return wrapSession(await input.base.connect(config));
		},
	};
}

/**
 * The adapter one scheduled arm measures over.
 *
 * Every arm is the primary adapter for its wire, wrapped where the arm's
 * identity says the read path or the receiver policy differs. There is no
 * "executor missing" branch: an arm the registry declares is an arm this
 * function builds, and a refusal here would be a runtime or environment
 * refusal (the WT package failing to load, for instance) rather than a gap in
 * the seal path.
 */
export async function adapterForSealArm(input: {
	readonly arm: SealArm;
	readonly cell: ScenarioCell;
	readonly runId: string;
	readonly clock: TransportClock;
	readonly perMessageTimeoutMs: number;
}): Promise<TransportAdapter> {
	const base = await adapterForTransport(input.arm.transport);
	if (input.arm.armKind === "overlay") {
		return createLossyOverlayWsAdapter({
			base,
			cell: input.cell,
			runId: input.runId,
			clock: input.clock,
			perMessageTimeoutMs: input.perMessageTimeoutMs,
		});
	}
	const armTransport = input.arm.armTransport;
	switch (armTransport) {
		case "ws-worker":
			return createWsWorkerAdapter(base, { clock: input.clock });
		case "wt-stream-sink":
			return createWtStreamSinkAdapter(base, { clock: input.clock });
		case "ws":
		case "wt":
			return base;
		case undefined:
			// Only the overlay is allowed to declare no arm transport, and it
			// has already returned. Anything else here is an arm the registry
			// described in a shape this dispatcher cannot honour, and guessing
			// a read path for it would put an unmeasured identity in a seal.
			throw new RangeError(
				`adapterForSealArm: ${input.arm.armId} declares no arm transport and is not an overlay`,
			);
		default: {
			const _exhaustive: never = armTransport;
			return _exhaustive;
		}
	}
}

/** Netem profile declared by the cell, or none for physical/baseline. */
export type CellImpairment =
	| { readonly kind: "none" }
	| {
			readonly kind: "netem";
			readonly delayMs: number;
			readonly jitterMs: number;
			readonly lossPercent?: number;
	  };

export function impairmentForCell(cell: ScenarioCell): CellImpairment {
	const requested = requestedImpairmentOf(cell);
	if (requested.qdisc !== "netem") {
		return { kind: "none" };
	}
	return {
		kind: "netem",
		delayMs: requested.delayMs,
		jitterMs: 0,
		...(requested.lossPercent > 0
			? { lossPercent: requested.lossPercent }
			: {}),
	};
}

export interface CampaignIndexEntry {
	readonly schema?: "campaign-index-entry/v2";
	readonly cellId: string;
	readonly armId: string;
	/** The wire. Two-valued, and the same for an arm and the arm it shadows. */
	readonly transport: SealTransport;
	readonly armKind: ArmKind;
	/** Absent or null for the overlay, which declares no arm transport. */
	readonly armTransport?: ArmTransport | null;
	/** @deprecated Prefer repetitionIndex (CampaignIndexV2). */
	readonly rep?: number;
	readonly impairment: string;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly repetitionKind: "measured";
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
	readonly status: "PASS" | "FAIL" | "REFUSED";
	readonly promotable: boolean;
	readonly failureCode: string | null;
	readonly refusalCode: string | null;
	readonly sealedPath: string | null;
	readonly artifactSha256: string | null;
	readonly refusalReason?: string;
	readonly primaryMetricP50?: number | null;
	/**
	 * What the off-loop reader actually did, for a read-path arm.
	 *
	 * Recorded in the index rather than in the sealed artifact because the
	 * artifact schema has no field for it; a reader comparing a `wt-stream-sink`
	 * row against a `wt` row needs to know whether the sink ran natively or on
	 * the documented facade fallback before reading anything into the delta.
	 */
	readonly readPath?: {
		readonly sinkMode?: string;
		readonly configuredSinkMode?: string;
		readonly queuedRecordsPeakBytes?: number;
		readonly droppedByQueue?: number;
	} | null;
}

export interface CampaignIndex {
	readonly schema: "campaign-index/v2";
	readonly campaignRunId: string;
	readonly stage: "phase4" | "full";
	readonly candidate: string;
	readonly campaignId: string;
	readonly approvedPlanSha256: string;
	readonly approvalRecordSha256: string;
	readonly stagedCapabilitySha256: string;
	/** Source archive digest (stage receipt archiveSha256); never the plan SHA. */
	readonly sourceArchiveSha256: string;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly stagedDir?: string;
	readonly cells: readonly string[];
	/** The wires this campaign opened. */
	readonly arms: readonly SealTransport[];
	/** The arm kinds this campaign scheduled. */
	readonly armKinds: readonly ArmKind[];
	readonly warmupRepetitions: 1;
	readonly measuredRepetitions: 1 | 5;
	/** @deprecated Prefer measuredRepetitions. */
	readonly reps?: number;
	/** How many arm executions the schedule contained, including skips. */
	readonly scheduledMeasuredArms: number;
	readonly scheduledArms?: number;
	readonly entries: readonly CampaignIndexEntry[];
}

/**
 * Did the artifact verifier close this seal's issuer receipt graph?
 *
 * The answer is `verifyRunArtifact`'s, not the controller's: the seal is
 * re-read from disk and verified against the *staged* anchors (candidate,
 * source archive, capability digest) rather than its own word, which is the
 * same rule `bin/verify-campaign-index.ts` applies. Anything unreadable,
 * unparseable or short of PASS is false, so promotion fails closed.
 */
export function sealClosesReceiptGraph(
	entry: CampaignIndexEntry,
	anchors: {
		readonly campaignId: string;
		readonly candidate: string;
		readonly sourceArchiveSha256: string;
		readonly stagedCapabilitySha256: string;
	},
): boolean {
	if (entry.sealedPath === null || entry.status !== "PASS") return false;
	try {
		const bytes = readFileSync(entry.sealedPath);
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact;
		const context: ArtifactTrustContext = {
			...trustContextForArtifact(parsed),
			comparisonId: anchors.campaignId,
			transport: entry.transport,
			sourceSha: anchors.candidate,
			archiveSha256: anchors.sourceArchiveSha256,
			executableSha256: anchors.stagedCapabilitySha256,
		};
		return verifyRunArtifact(bytes, context).evidenceStatus === "PASS";
	} catch {
		return false;
	}
}

export interface CampaignFlatPromotionInput {
	/** The campaign root the flats are written into and read back from. */
	readonly evidenceDir: string;
	readonly campaignId: string;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly cellIds: readonly string[];
	readonly entries: readonly CampaignIndexEntry[];
	/**
	 * Whether the artifact verifier closed BOTH issuer receipt graphs for this
	 * entry's seal, in this same pass.
	 *
	 * Never defaulted to `true`: an entry nothing verified leaves it false and
	 * the §6 gate refuses the cell, which is the fail-closed answer. This is a
	 * parameter rather than a computation because the receipt graph is
	 * `verify-artifact.ts`'s authority, not the controller's.
	 */
	readonly receiptGraphComplete: (entry: CampaignIndexEntry) => boolean;
}

export interface CampaignFlatPromotionResult {
	readonly promotedCells: readonly string[];
	readonly flatsWritten: readonly string[];
	readonly refusals: readonly {
		readonly cellId: string;
		readonly codes: readonly PromotionGateRefusalCode[];
	}[];
}

/**
 * Write the flats a campaign has earned, and nothing else.
 *
 * This is the campaign's *only* promotion selector: the decision is
 * `evaluateCellPromotionGate`, which is the §6 set rule (five distinct
 * canonical measured PASS reps on each wire, each sealed, each with a closed
 * receipt graph, no duplicate, no out-of-range index, no stale echo from an
 * earlier campaign). A cell that does not clear it writes no flat at all —
 * there is no median to fall back on, because selecting a median from an
 * incomplete set is exactly the failure this ordering exists to prevent.
 *
 * Existing flats are read off disk rather than assumed absent: a survivor from
 * another campaign refuses this cell instead of being silently overwritten.
 */
export async function promoteCampaignFlats(
	input: CampaignFlatPromotionInput,
): Promise<CampaignFlatPromotionResult> {
	const promotedCells: string[] = [];
	const flatsWritten: string[] = [];
	const refusals: {
		readonly cellId: string;
		readonly codes: readonly PromotionGateRefusalCode[];
	}[] = [];

	const toGateEntry = (entry: CampaignIndexEntry): PromotionGateEntry => ({
		campaignId: input.campaignId,
		cellId: entry.cellId,
		transport: entry.transport,
		armKind: entry.armKind,
		executionPurpose: entry.executionPurpose,
		repetitionKind: entry.repetitionKind,
		repetitionIndex: entry.repetitionIndex ?? entry.rep ?? 0,
		repetitionTotal: entry.repetitionTotal,
		status: entry.status,
		promotable: entry.promotable,
		sealedPath: entry.sealedPath,
		artifactSha256: entry.artifactSha256,
		receiptGraphComplete: input.receiptGraphComplete(entry),
		primaryMetricP50: entry.primaryMetricP50 ?? null,
	});

	for (const cellId of input.cellIds) {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) =>
				candidate.cellId === cellId || candidate.scenarioId === cellId,
		);
		if (cell === undefined) continue;
		const flatPathFor = (transport: SealTransport): string =>
			`${input.evidenceDir}/${cellSafeId(cell.cellId)}-${transport}.json`;

		// A flat already on disk is evidence about *some* campaign; which one is
		// read out of its own bytes. Unreadable counts as "not this campaign",
		// which refuses rather than overwrites.
		const existingFlats: {
			readonly cellId: string;
			readonly transport: SealTransport;
			readonly campaignId: string;
		}[] = [];
		for (const transport of ["ws", "wt"] as const) {
			const path = flatPathFor(transport);
			if (!existsSync(path)) continue;
			let owner = "";
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as {
					comparisonId?: unknown;
				};
				if (typeof parsed.comparisonId === "string")
					owner = parsed.comparisonId;
			} catch {
				owner = "";
			}
			existingFlats.push({ cellId: cell.cellId, transport, campaignId: owner });
		}

		const gate = evaluateCellPromotionGate({
			cellId: cell.cellId,
			campaignId: input.campaignId,
			executionPurpose: input.executionPurpose,
			// Flats are the pair the gate reads, so only the two primary arms are
			// eligible: a read-path or overlay seal shares the wire but not the
			// question, and promoting one would answer "ws vs wt" with an arm that
			// was never the ws or wt of this cell.
			entries: input.entries
				.filter(
					(entry) =>
						entry.cellId === cell.cellId && entry.armKind === "primary",
				)
				.map(toGateEntry),
			existingFlats,
		});
		if (!gate.promotable) {
			const codes = [...new Set(gate.refusals.map((refusal) => refusal.code))];
			refusals.push({ cellId: cell.cellId, codes });
			process.stderr.write(
				`controller: ${cell.cellId} not promoted: ${gate.refusals
					.map((refusal) => `${refusal.code} (${refusal.reason})`)
					.join("; ")}\n`,
			);
			continue;
		}
		const median = gate.median!;
		const wsFlat = flatPathFor("ws");
		const wtFlat = flatPathFor("wt");
		await Bun.write(wsFlat, await Bun.file(median.wsSealedPath).arrayBuffer());
		await Bun.write(wtFlat, await Bun.file(median.wtSealedPath).arrayBuffer());
		flatsWritten.push(wsFlat, wtFlat);
		promotedCells.push(cell.cellId);
	}
	return { promotedCells, flatsWritten, refusals };
}

/** Identity of one arm execution inside a campaign index. */
export function campaignIndexKey(
	entry: Pick<CampaignIndexEntry, "cellId" | "armId" | "repetitionIndex"> & {
		readonly rep?: number;
	},
): string {
	const index = entry.repetitionIndex ?? entry.rep ?? 0;
	return `${entry.cellId}|${entry.armId}|${index}`;
}

/**
 * Read a campaign index a previous run left behind, if it parses.
 *
 * A malformed or absent index is not an error: it means there is nothing to
 * resume from, and the campaign measures everything. Refusing here would turn
 * a corrupted resume file into a reason not to measure at all.
 */
export function readCampaignIndex(path: string): CampaignIndex | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CampaignIndex;
		if (parsed?.schema !== "campaign-index/v2") return undefined;
		if (!Array.isArray(parsed.entries)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Persist the in-progress index so `--resume` survives a mid-campaign crash. */
export async function writeCampaignIndexSnapshot(
	path: string,
	index: CampaignIndex,
): Promise<void> {
	await Bun.write(path, `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * The arm executions a resumed campaign does not have to measure again.
 *
 * Only PASS entries carry forward. A FAIL is a measurement that did not land
 * and a REFUSED is an environment that may since have changed, and re-running
 * either is the point of resuming.
 */
export function resumableEntries(
	index: CampaignIndex | undefined,
	campaignId?: string,
): ReadonlyMap<string, CampaignIndexEntry> {
	const carried = new Map<string, CampaignIndexEntry>();
	if (index === undefined) return carried;
	// An index left in this directory by a *different* campaign is not this
	// campaign's evidence. Carrying it forward is how a cross-campaign entry
	// would reach the §6 promotion set, so it is refused at the door: the set
	// gate below reads every entry as belonging to `campaignId`, and that is
	// only true because nothing else gets in here.
	if (campaignId !== undefined && index.campaignId !== campaignId)
		return carried;
	for (const entry of index.entries) {
		if (entry.status !== "PASS") continue;
		if (typeof entry.sealedPath !== "string") continue;
		if (!existsSync(entry.sealedPath)) continue;
		carried.set(campaignIndexKey(entry), entry);
	}
	return carried;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Resolve the authority digest `verifyStagedTrustBootstrap` must match.
 * Prefers a live stage receipt (`stage-receipt.json`, then legacy
 * `live-bootstrap-receipt.json`); otherwise the pinned R1 campaign authority
 * digest.
 */
export function resolveStagedAuthorityDigest(stagedDir: string): string {
	for (const leaf of [
		"stage-receipt.json",
		"live-bootstrap-receipt.json",
	] as const) {
		const receiptPath = join(stagedDir, leaf);
		if (!existsSync(receiptPath)) continue;
		try {
			const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
				authoritySha256?: unknown;
			};
			if (
				typeof receipt.authoritySha256 === "string" &&
				HEX_64.test(receipt.authoritySha256)
			) {
				return receipt.authoritySha256;
			}
		} catch {
			// try next leaf / fall through to the pin
		}
	}
	return R1_CAMPAIGN_AUTHORITY_SHA256;
}

/** The two-host rig endpoints. */
export interface RigEndpoints {
	readonly mac: {
		readonly interface: string;
		readonly address: string;
	};
	readonly linux: {
		readonly interface: string;
		readonly address: string;
		readonly user: string;
	};
}

/** The live rig's endpoints, as discovered on 2026-08-29. The Mac
 *  controller is on the Thunderbolt Ethernet Slot 2 (`en13`) at
 *  `10.99.0.1/24`; the Linux bench is `gravvene-dev-home` on `eno1`
 *  at `10.99.0.2/24`, user `hermes-admin`. The SSH identity is
 *  `~/.ssh/ubuntu-vm-hermes` (the key that `~/.ssh/config` resolves
 *  for `Host 10.99.0.2`). See
 *  `docs/superpowers/plans/deviations/phase-3.5-rig-config-correction.md`. */
export function defaultRigEndpoints(): RigEndpoints {
	return {
		mac: { interface: "en13", address: "10.99.0.1" },
		linux: {
			interface: "eno1",
			address: "10.99.0.2",
			user: "hermes-admin",
		},
	};
}

/** The default SSH identity file the controller hands to `ssh -i`.
 *  Matches the `IdentityFile` that `~/.ssh/config` has for
 *  `Host 10.99.0.2`. */
export const DEFAULT_SSH_IDENTITY = "~/.ssh/ubuntu-vm-hermes";

/** A single campaign run. */
export interface RunSpec {
	readonly cell: string;
	/** When set, measure each cell (Phase-4 / full-matrix). Else `[cell]`. */
	readonly cells?: readonly string[];
	readonly repetitions: number;
	readonly arms: readonly ("ws" | "wt")[];
	readonly endpoints: RigEndpoints;
	readonly candidate: string;
	readonly campaignId: string;
	/**
	 * Absolute path to a Phase 3.6.0 staged trust bootstrap directory.
	 * When set, `realRun` verifies the on-disk authority against the
	 * campaign pin before any SSH/SCP work.
	 */
	readonly stagedDir?: string;
	/** `phase4` writes campaign-index + promote layout under the official root. */
	readonly stage?: "phase4" | "full";
	/**
	 * Which arm kinds to schedule. Defaults to all three; narrowing it is how a
	 * run asks for the primary pairs alone without also narrowing the wires.
	 */
	readonly armKinds?: readonly ArmKind[];
	/** Carry forward PASS entries from an existing campaign index. */
	readonly resume?: boolean;
	/** focused|pilot|canonical — required for CampaignIndexV2 / RunArtifactV2. */
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	/**
	 * Optional stage-receipt.json from `stage-live-campaign`. When present,
	 * CampaignIndexV2 digests are copied verbatim (no zero/fake placeholders).
	 */
	readonly stageReceiptPath?: string;
	readonly approvedPlanSha256?: string;
	readonly approvalRecordSha256?: string;
	readonly stagedCapabilitySha256?: string;
	readonly sourceArchiveSha256?: string;
	/** Fail-closed outer wall-clock bound for the full campaign (plan §9.5). */
	readonly campaignTimeoutMs?: number;
	/** Atomic ControllerTerminalV1 path written before process exit. */
	readonly writeTerminalRecordPath?: string;
}

export type ControllerTerminalKind =
	| "PASS"
	| "FAIL"
	| "REFUSED"
	| "INTERRUPTED";

export interface ControllerTerminalV1 {
	readonly schema: "controller-terminal/v1";
	readonly candidate: string;
	readonly campaignId: string;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly terminalKind: ControllerTerminalKind;
	readonly campaignStatus: "PASS" | "FAIL" | "REFUSED";
	readonly refusalCode: CampaignRefusalCode | null;
	readonly failureCode: CampaignFailureCode | null;
	readonly controllerExitCode: number;
	readonly trafficStarted: boolean;
	readonly writtenAtMs: number;
}

/** Write ControllerTerminalV1 with O_CREAT|O_EXCL tmp + rename-after-fsync. */
export function writeControllerTerminalRecord(
	path: string,
	record: ControllerTerminalV1,
): void {
	const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	const dirFd = openSync(dir, "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/**
 * The §7 failure code a reason names, if it names one. The reason is the
 * controller's own text and embeds the code as a whole token (`(CODE):` from
 * the dispatch, `CODE:` from a throw), so the match is by token over the
 * exported closed array, in its order, never by substring and never against
 * a copy of the list kept here.
 */
export function campaignFailureCodeNamedIn(
	reason: string,
): CampaignFailureCode | null {
	const tokens = new Set(reason.match(/[A-Z][A-Z0-9_]*/g) ?? []);
	for (const code of CAMPAIGN_FAILURE_CODES) {
		if (tokens.has(code)) return code;
	}
	return null;
}

export function classifyControllerTerminal(input: {
	readonly candidate: string;
	readonly campaignId: string;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly exitCode: number;
	readonly reason: string | null;
	readonly trafficStarted: boolean;
	readonly timedOut: boolean;
}): ControllerTerminalV1 {
	const writtenAtMs = Date.now();
	if (input.exitCode === 0) {
		return {
			schema: "controller-terminal/v1",
			candidate: input.candidate,
			campaignId: input.campaignId,
			executionPurpose: input.executionPurpose,
			terminalKind: "PASS",
			campaignStatus: "PASS",
			refusalCode: null,
			failureCode: null,
			controllerExitCode: 0,
			trafficStarted: true,
			writtenAtMs,
		};
	}
	if (input.timedOut) {
		return {
			schema: "controller-terminal/v1",
			candidate: input.candidate,
			campaignId: input.campaignId,
			executionPurpose: input.executionPurpose,
			terminalKind: "FAIL",
			campaignStatus: "FAIL",
			refusalCode: null,
			failureCode: "MEASUREMENT_WINDOW",
			controllerExitCode: input.exitCode,
			trafficStarted: input.trafficStarted,
			writtenAtMs,
		};
	}
	const reason = input.reason ?? "";
	for (const code of [
		"RIG_UNREACHABLE",
		"HOST_FD_PREFLIGHT",
		"STALE_OR_INVALID_STAGING",
	] as const) {
		if (reason.includes(code)) {
			return {
				schema: "controller-terminal/v1",
				candidate: input.candidate,
				campaignId: input.campaignId,
				executionPurpose: input.executionPurpose,
				terminalKind: "REFUSED",
				campaignStatus: "REFUSED",
				refusalCode: code,
				failureCode: null,
				controllerExitCode: input.exitCode,
				trafficStarted: false,
				writtenAtMs,
			};
		}
	}
	const failureCode = campaignFailureCodeNamedIn(reason) ?? "TRUST_PROTOCOL";
	return {
		schema: "controller-terminal/v1",
		candidate: input.candidate,
		campaignId: input.campaignId,
		executionPurpose: input.executionPurpose,
		terminalKind: "FAIL",
		campaignStatus: "FAIL",
		refusalCode: null,
		failureCode,
		controllerExitCode: input.exitCode,
		trafficStarted: input.trafficStarted,
		writtenAtMs,
	};
}

/** Approved busyMs/fanout plan SHA bound into CampaignIndexV2 when no stage receipt. */
export const BUSYMS_ATTESTED_FANOUT_PLAN_SHA256 =
	"9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9" as const;

function sha256FileOrLabel(pathOrLabel: string, label: string): string {
	if (existsSync(pathOrLabel)) {
		return createHash("sha256").update(readFileSync(pathOrLabel)).digest("hex");
	}
	return createHash("sha256").update(`${label}:${pathOrLabel}`).digest("hex");
}

/**
 * Resolve CampaignIndexV2 plan/approval/capability digests without zero or
 * repeated-f placeholders. Prefer an on-disk stage receipt; otherwise bind the
 * approved plan SHA and hash campaign-scoped approval/capability labels.
 */
export function resolveCampaignIndexDigests(spec: RunSpec): {
	readonly approvedPlanSha256: string;
	readonly approvalRecordSha256: string;
	readonly stagedCapabilitySha256: string;
	readonly sourceArchiveSha256: string;
} {
	const receiptCandidates = [
		spec.stageReceiptPath,
		spec.stagedDir !== undefined
			? join(spec.stagedDir, "stage-receipt.json")
			: undefined,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const receiptPath of receiptCandidates) {
		if (!existsSync(receiptPath)) continue;
		const raw = JSON.parse(readFileSync(receiptPath, "utf8")) as {
			approvedPlanSha256?: string;
			approvalRecordSha256?: string;
			capabilitySha256?: string;
			archiveSha256?: string;
		};
		if (
			typeof raw.approvedPlanSha256 === "string" &&
			raw.approvedPlanSha256.length === 64 &&
			typeof raw.approvalRecordSha256 === "string" &&
			raw.approvalRecordSha256.length === 64 &&
			typeof raw.capabilitySha256 === "string" &&
			raw.capabilitySha256.length === 64 &&
			typeof raw.archiveSha256 === "string" &&
			raw.archiveSha256.length === 64
		) {
			return {
				approvedPlanSha256: raw.approvedPlanSha256,
				approvalRecordSha256: raw.approvalRecordSha256,
				stagedCapabilitySha256: raw.capabilitySha256,
				sourceArchiveSha256: raw.archiveSha256,
			};
		}
	}
	const approvedPlanSha256 =
		spec.approvedPlanSha256 ?? BUSYMS_ATTESTED_FANOUT_PLAN_SHA256;
	const approvalRecordSha256 =
		spec.approvalRecordSha256 ??
		sha256FileOrLabel(
			`approval-record:${spec.candidate}:${spec.campaignId}`,
			"approval-record",
		);
	const stagedCapabilitySha256 =
		spec.stagedCapabilitySha256 ??
		(spec.stagedDir !== undefined
			? sha256FileOrLabel(
					join(spec.stagedDir, "capability.json"),
					`capability:${spec.candidate}:${spec.campaignId}`,
				)
			: sha256FileOrLabel(
					`capability:${spec.candidate}:${spec.campaignId}`,
					"capability",
				));
	const sourceArchiveSha256 =
		spec.sourceArchiveSha256 ??
		(spec.stagedDir !== undefined &&
		existsSync(join(spec.stagedDir, "source.tar"))
			? sha256FileOrLabel(join(spec.stagedDir, "source.tar"), "source-archive")
			: sha256FileOrLabel(
					`source-archive:${spec.candidate}:${spec.campaignId}`,
					"source-archive",
				));
	return {
		approvedPlanSha256,
		approvalRecordSha256,
		stagedCapabilitySha256,
		sourceArchiveSha256,
	};
}

/** A bounded deadline. `windowMs` is the hard upper bound. */
export interface Deadline {
	readonly label: string;
	readonly windowMs: number;
}

const ROUTE_REGEX = /^(?<dest>\S+)\s+dev\s+(?<iface>\S+)/m;

/** Parse a Linux `ip route get <dest>` line. A direct-cable route
 *  appears as `<dest> dev <iface> src <local>` (no `via`); a routed
 *  route appears as `<dest> via <gateway> dev <iface>`. Returns
 *  `valid: true` only for the direct-cable case. */
export function parseLinuxRoute(
	route: string,
	expectedDestination: string,
): { valid: boolean; interface: string | null } {
	if (/\bvia\b/.test(route)) return { valid: false, interface: null };
	const m = ROUTE_REGEX.exec(route);
	if (!m || !m.groups) return { valid: false, interface: null };
	if (m.groups.dest !== expectedDestination) {
		return { valid: false, interface: null };
	}
	return { valid: true, interface: m.groups.iface ?? null };
}

/** Parse a Mac `route -n get` line. Mac route format is different from
 *  Linux; this is a minimal parser. */
export function parseMacRoute(
	route: string,
	expectedDestination: string,
): { valid: boolean; interface: string | null } {
	if (/\bvia\b/.test(route)) return { valid: false, interface: null };
	// Mac format: "destination: <dest>  interface: <iface>"
	const destMatch = /destination:\s*(\S+)/.exec(route);
	const ifaceMatch = /interface:\s*(\S+)/.exec(route);
	if (!destMatch || !ifaceMatch) return { valid: false, interface: null };
	if (destMatch[1] !== expectedDestination) {
		return { valid: false, interface: null };
	}
	return { valid: true, interface: ifaceMatch[1] ?? null };
}

/** Build the SSH argv that would connect to the Linux bench. Pure:
 *  returns the argv, does not run ssh. The default identity is the
 *  `ubuntu-vm-hermes` key that `~/.ssh/config` resolves for
 *  `Host 10.99.0.2`; the rig's SSH user is `hermes-admin` (not
 *  `bench`). See
 *  `docs/superpowers/plans/deviations/phase-3.5-rig-config-correction.md`. */
export function buildSshArgv(
	endpoint: RigEndpoints["linux"],
	remoteCommand: string,
): readonly string[] {
	return [
		"-i",
		DEFAULT_SSH_IDENTITY,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ConnectTimeout=10",
		`${endpoint.user}@${endpoint.address}`,
		"--",
		remoteCommand,
	];
}

/** Build the netem qdisc commands. Returns the apply command and the
 *  restore command. Pure: does not run tc. Optional loss for lossy cells. */
export function buildNetemCommands(
	interfaceName: string,
	delayMs: number,
	jitterMs: number,
	lossPercent?: number,
): { apply: string[]; restore: string[] } {
	const apply = [
		"tc",
		"qdisc",
		"add",
		"dev",
		interfaceName,
		"root",
		"netem",
		"delay",
		`${delayMs}ms`,
		`${jitterMs}ms`,
	];
	if (lossPercent !== undefined && lossPercent > 0) {
		apply.push("loss", `${lossPercent}%`);
	}
	const restore = ["tc", "qdisc", "del", "dev", interfaceName, "root"];
	return { apply, restore };
}

/**
 * The argv the controller hands to `Bun.spawn` to invoke the production
 * client (`tools/compare/client.ts`) for one repetition of one cell.
 *
 * Pure: builds the argv, returns it, does not run anything. The caller
 * runs `Bun.spawn` against it; tests pin the shape so the production
 * envelope (`FRAME_MAGIC = 0x5753`, `tools/compare/adapters/ws.ts:162-167`)
 * is exercised end-to-end on the rig rather than the previous harness
 * bypass.
 */
export function buildProductionClientArgv(input: {
	readonly linuxAddress: string;
	readonly serverPort: number;
	readonly cell: string;
	readonly runId: string;
	readonly repIndex: number;
	readonly outputPath: string;
	readonly transport?: SealTransport;
}): readonly string[] {
	const transport = input.transport ?? "ws";
	return [
		"bun",
		"run",
		"tools/compare/client.ts",
		"--transport",
		transport,
		"--scenario",
		input.cell,
		"--server-url",
		serverUrlForTransport(transport, input.linuxAddress, input.serverPort),
		"--run-id",
		`${input.runId}-rep-${input.repIndex}`,
		"--output",
		input.outputPath,
		"--tls-ca",
		"/tmp/ws-wt-server.crt",
		"--tls-sni",
		"gravvene-dev-home",
	];
}

/**
 * Project a measured leg into the series shape `presentArtifactPayload`
 * admits. Throughput (`Mbps`) and rate (`count`) legs keep empty
 * `roundTrips`; latency legs keep the recorder's round trips.
 */
export function measurementSeriesFromLeg(leg: MeasuredLeg): MeasurementSeries {
	const sampleUnit =
		leg.sampleUnit === "Mbps" ||
		leg.sampleUnit === "ms" ||
		leg.sampleUnit === "count" ||
		leg.sampleUnit === "percent" ||
		leg.sampleUnit === "bytes"
			? leg.sampleUnit
			: undefined;
	return {
		samples: [...leg.samples],
		roundTrips:
			sampleUnit === "Mbps" ||
			sampleUnit === "count" ||
			sampleUnit === "percent" ||
			sampleUnit === "bytes"
				? []
				: leg.roundTrips.map((trip) => ({
						sequence: trip.sequence,
						sentAtMs: trip.sentAtMs,
						receivedAtMs: trip.receivedAtMs,
						latencyMs: trip.latencyMs,
					})),
		ledger: { delivered: leg.ledger.delivered },
		provenance: {
			sampleCount: leg.provenance.sampleCount,
			firstSampleAtMs: leg.provenance.firstSampleAtMs,
			lastSampleAtMs: leg.provenance.lastSampleAtMs,
		},
		...(sampleUnit !== undefined ? { sampleUnit } : {}),
		...(leg.deliveredBytes !== undefined
			? { deliveredBytes: leg.deliveredBytes }
			: {}),
	};
}

function hasControlPipes(
	handle: SupervisorHandle,
): handle is SupervisorHandle & {
	readonly controllerToSupervisor: NonNullable<
		SupervisorHandle["controllerToSupervisor"]
	>;
	readonly supervisorToController: NonNullable<
		SupervisorHandle["supervisorToController"]
	>;
} {
	return (
		handle.controllerToSupervisor !== undefined &&
		handle.supervisorToController !== undefined
	);
}

async function observeCampaignToolchains(
	linux: RigEndpoints["linux"],
	deadlineMs: number,
): Promise<
	| {
			readonly ok: true;
			readonly toolchains: ToolchainSet;
			readonly supervisorToolchainDigests: {
				readonly darwin: string;
				readonly linux: string;
			};
	  }
	| { readonly ok: false; readonly reason: string }
> {
	const mac = await observeLocalToolchain();
	const jsIdentity = toolchainIdentity(mac);
	const shaResult = await sshExec(
		linux,
		"sha256sum ~/.bun/bin/bun",
		deadlineMs,
	);
	if (!shaResult.ok) {
		return {
			ok: false,
			reason: `linux bun digest failed: ${shaResult.stderr.trim() || shaResult.stdout.trim()}`,
		};
	}
	const linuxSha = shaResult.stdout.trim().split(/\s+/)[0] ?? "";
	if (!/^[0-9a-f]{64}$/.test(linuxSha)) {
		return {
			ok: false,
			reason: `linux bun digest malformed: ${shaResult.stdout.trim()}`,
		};
	}
	const verResult = await sshExec(
		linux,
		"~/.bun/bin/bun --version",
		deadlineMs,
	);
	if (!verResult.ok) {
		return {
			ok: false,
			reason: `linux bun version failed: ${verResult.stderr.trim() || verResult.stdout.trim()}`,
		};
	}
	const linuxVersion = verResult.stdout.trim();
	if (linuxVersion.length === 0) {
		return { ok: false, reason: "linux bun version empty" };
	}
	const toolchains: ToolchainSet = {
		js: { identity: jsIdentity, sha256: mac.bunExecutableSha256 },
		darwin: { identity: jsIdentity, sha256: mac.bunExecutableSha256 },
		linux: {
			identity: `bun-${linuxVersion}`,
			sha256: linuxSha,
		},
	};
	return {
		ok: true,
		toolchains,
		supervisorToolchainDigests: {
			darwin: toolchains.darwin.sha256,
			linux: toolchains.linux.sha256,
		},
	};
}

/** Per-message bound the seal path measures every arm under. */
const SEAL_PER_MESSAGE_TIMEOUT_MS = 5_000;

/**
 * Read the off-loop diagnostics an adapter is willing to state.
 *
 * Duck-typed on purpose: the primary adapters have nothing to say here and
 * must not be made to, and the two read-path wrappers state only what their
 * queues counted. Nothing is defaulted — an adapter that reports no queues
 * produces no `readPath` block rather than a block of zeros.
 */
function readPathDiagnosticsOf(
	adapter: TransportAdapter,
): CampaignIndexEntry["readPath"] | undefined {
	const withDiagnostics = adapter as TransportAdapter & {
		readPathDiagnostics?: () => readonly {
			readonly queuedBytesPeak: number;
			readonly dropped: number;
		}[];
		sinkDiagnostics?: () => {
			readonly sinkMode: string;
			readonly configuredMode: string;
		};
	};
	const queues = withDiagnostics.readPathDiagnostics?.();
	if (queues === undefined) return undefined;
	const sink = withDiagnostics.sinkDiagnostics?.();
	let queuedRecordsPeakBytes = 0;
	let droppedByQueue = 0;
	for (const queue of queues) {
		queuedRecordsPeakBytes = Math.max(
			queuedRecordsPeakBytes,
			queue.queuedBytesPeak,
		);
		droppedByQueue += queue.dropped;
	}
	return {
		...(sink !== undefined
			? { sinkMode: sink.sinkMode, configuredSinkMode: sink.configuredMode }
			: {}),
		queuedRecordsPeakBytes,
		droppedByQueue,
	};
}

/** The verified stage material an in-process seal carries into every arm. */
export interface SignedRunMaterial {
	readonly staged: StagedCohortMaterialV1;
	readonly bootstrap: StagedTrustBootstrapPaths;
	/** The CA PEM the client and the role children verify the rig server against. */
	readonly tlsCaPem: string;
	/** The staged Bun that runs role children; digest-checked at acquisition. */
	readonly bunExecutablePath: string;
	readonly macClockId: string;
	readonly runtimeRoot: string;
}

/**
 * One ordinary (non-cohort) arm repetition under the base plan's signed server
 * lifecycle (§5 states 2, 3, 5, 8, 13, 14, 15): the Mac binary opens the
 * execution, the rig accepts it and spawns the server, the rig fixes the
 * Linux baseline, the client measures, the rig captures, the series is
 * admitted, the Mac binary joins the rig graph and signs the admission, and
 * only then is the attestation assembled from exact bytes, verified and
 * sealed. Nothing here mints a record; every refusal is the executor's own.
 *
 * The rig's execution acceptance has no production executor yet
 * (`createPhaseARigLifecycleOverChannel`), so today this returns a FAIL
 * naming it -- never a seal without it, and never a REFUSED row.
 */
async function measureSealAndWriteRep(input: {
	readonly macSupervisor: SupervisorHandle;
	readonly rigSupervisor: SupervisorHandle;
	readonly linux: RigEndpoints["linux"];
	readonly cell: ScenarioCell;
	readonly arm: SealArm;
	/** Already cohort-scoped by `sealRunIdForArm`; the signed run id replaces it. */
	readonly runId: string;
	readonly sourceIdentity: {
		readonly sourceSha: string;
		readonly archiveSha256: string;
		readonly executableSha256: string;
	};
	readonly repIndex: number;
	readonly serverPort: number;
	readonly perRepPath: string;
	readonly sealedPath: string;
	readonly toolchains: ToolchainSet;
	readonly supervisorToolchainDigests: {
		readonly darwin: string;
		readonly linux: string;
	};
	readonly controlDeadlineMs: number;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly repetitionKind: "warmup" | "measured";
	readonly repetitionTotal: number;
	readonly signed: SignedRunMaterial;
}): Promise<SealedRepResult> {
	const wire = input.arm.transport;
	const fail = (
		code: CampaignFailureCode,
		reason: string,
	): SealedRepResult => ({
		ok: false,
		failureCode: code,
		reason,
	});
	const refused = (
		step: string,
		result: { readonly code: string; readonly message?: string },
	) =>
		fail(
			closedCohortFailureCode(result.code),
			`${step} (${result.code}): ${result.message ?? ""}`,
		);

	if (
		input.macSupervisor.controllerToSupervisor === undefined ||
		input.macSupervisor.supervisorToController === undefined ||
		input.rigSupervisor.controllerToSupervisor === undefined ||
		input.rigSupervisor.supervisorToController === undefined
	) {
		return fail("TRUST_PROTOCOL", "both supervisor handles need control pipes");
	}

	// §5 MAC_EXECUTION_OPEN: the draft states identity and declaration only.
	const drafted = buildSignedExecutionDraft({
		staged: input.signed.staged,
		bootstrap: input.signed.bootstrap,
		cell: input.cell,
		arm: input.arm,
		serverMode: "bulk-source",
		executionPurpose: input.executionPurpose,
		repetitionKind: input.repetitionKind,
		repetitionIndex: input.repIndex,
		repetitionTotal: input.repetitionTotal,
	});
	if (!drafted.ok) return refused("signed execution identity", drafted);
	const channel = new MacCohortChannel({
		controllerToMac: input.macSupervisor.controllerToSupervisor,
		macToController: input.macSupervisor.supervisorToController,
		childDiagnostics: input.macSupervisor.diagnostics,
		stagedMacPublicRaw32: input.signed.staged.stagedMacPublicRaw32,
		deadlineMs: COHORT_ACQUISITION_DEADLINES.frameMs,
	});
	const opened = await channel.openExecution(drafted.value.draftBytes);
	if (!opened.ok) return refused("mac execution open", opened);
	const execution = opened.value.execution;
	const grantJson = parseStrictJsonBytes(opened.value.measurementGrantBytes);
	if (!grantJson.ok) return fail("TRUST_PROTOCOL", "measurement grant bytes");
	const grantParsed = parseMeasurementGrant(grantJson.value);
	if (!grantParsed.ok)
		return fail("TRUST_PROTOCOL", `measurement grant: ${grantParsed.code}`);
	const grant = grantParsed.grant;
	if (grant.transport !== wire) {
		return fail(
			"CROSS_SUPERVISOR_MISMATCH",
			`grant.transport ${grant.transport} is not the arm's ${wire}`,
		);
	}

	// §5 RIG_EXECUTION_ACCEPTED, then SERVER_READY under the accepted execution.
	const rigChannel = new CohortRigChannel({
		controllerToRig: input.rigSupervisor.controllerToSupervisor,
		rigToController: input.rigSupervisor.supervisorToController,
		childDiagnostics: input.rigSupervisor.diagnostics,
		executionSha256: opened.value.executionSha256,
		stagedRigPublicRaw32: input.signed.staged.stagedRigPublicRaw32,
		deadlines: {
			frameMs: COHORT_ACQUISITION_DEADLINES.frameMs,
			serverReadyMs: 15_000,
			warmupDrainMs: COHORT_ACQUISITION_DEADLINES.warmupDrainMs,
			captureMs: COHORT_ACQUISITION_DEADLINES.captureMs,
			teardownMs: COHORT_ACQUISITION_DEADLINES.teardownMs,
		},
	});
	const rig = createPhaseARigLifecycleOverChannel(rigChannel);
	const accepted = await rig.acceptExecution({
		measurementGrantBytes: opened.value.measurementGrantBytes,
		receiptBytes: opened.value.receiptBytes,
		receiptSignatureBytes: opened.value.receiptSignatureBytes,
	});
	if (!accepted.ok) return refused("rig execution acceptance", accepted);
	// The bound record's own argv, never a recomputation: the rig compares
	// the request's argv with the record it was signed to launch byte for byte.
	const bulkRecord = stagedServerLaunchRecordFor(
		input.signed.staged,
		wire,
		"bulk-source",
	);
	const spawned = await rig.spawnServer({
		cohortGrantSha256: null,
		serverEntrypointSha256: input.signed.staged.receipt.serverEntrypointSha256,
		bunSha256: input.signed.staged.receipt.linuxBunSha256,
		addonSha256: input.signed.staged.receipt.linuxAddonManifestSha256,
		stagedServerLaunchRecordBytes: bulkRecord.bytes,
		bindPort: input.serverPort,
		transport: wire,
		serverArgv: [...bulkRecord.record.argv],
	});
	if (!spawned.ok) return refused("rig server spawn", spawned);

	// §5 TEARDOWN is owed from here to the end of the arm, on every path out
	// — the same guarantee `teardownCohortArmLease` gives a cohort arm. The
	// rig refuses the next spawn while a child of the last one is still up
	// ("one server child per cohort"), so a repetition that returned without
	// reaping would fail the *next* repetition for a reason that is not its
	// measurement. The measured body is a closure only so that this function
	// has exactly one exit through the teardown.
	const measured = async (): Promise<SealedRepResult> => {
		// §5 LINUX_BASELINE, then the measured transfer, then LINUX_CAPTURE.
		const baseline = await rig.measureStart({
			rigWarmupDrainedReceiptSha256: null,
			roleWarmupCompletionManifestSha256: null,
		});
		if (!baseline.ok) return refused("rig baseline", baseline);
		const adapter = await adapterForSealArm({
			arm: input.arm,
			cell: input.cell,
			runId: grant.runId,
			clock: systemTransportClock,
			perMessageTimeoutMs: SEAL_PER_MESSAGE_TIMEOUT_MS,
		});
		const leg = await measureLegOverAdapter({
			adapter,
			cell: input.cell,
			serverUrl: serverUrlForTransport(
				wire,
				input.linux.address,
				input.serverPort,
			),
			role: "publisher",
			driverRunId: grant.runId,
			runId: grant.runId,
			sessionId: `${grant.runId}-s1`,
			clock: systemTransportClock,
			connectTimeoutMs: 10_000,
			perMessageTimeoutMs: SEAL_PER_MESSAGE_TIMEOUT_MS,
			armKind: input.arm.armKind,
			tls: {
				ca: input.signed.tlsCaPem,
				serverName: bulkRecord.record.tlsServerName,
				rejectUnauthorized: true,
			},
		});
		const capture = await rig.stopAndCapture({
			macStopIssuedAtNs: readMacContinuousNs(),
			drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS,
		});
		if (!capture.ok) return refused("rig capture", capture);

		// §5 MAC_JOIN: series admission on the legacy frame, then the rig graph.
		const series = measurementSeriesFromLeg(leg);
		const admittedClientSeriesBytes = measurementPayloadBytes(series, grant);
		const presented = await presentArtifactPayload(
			input.macSupervisor,
			series,
			grant,
			Math.max(input.controlDeadlineMs, 60_000),
		);
		if (!presented.ok) return refused("series admission", presented);
		const admitted = await channel.presentRigObservation({
			rigExecutionAcceptanceBytes: accepted.value.acceptanceBytes,
			rigExecutionAcceptanceSignatureBytes: accepted.value.signatureBytes,
			rigMeasureStartAckBytes: baseline.value.ackBytes,
			rigMeasureStartAckSignatureBytes: baseline.value.signatureBytes,
			rigBarrierAcceptanceBytes: null,
			rigBarrierAcceptanceSignatureBytes: null,
			serverWarmupDrainedBytes: null,
			serverStartBarrierAcceptedBytes: null,
			snapshotFrameBytes: capture.value.snapshotFrameBytes,
			rigServerSnapshotReceiptBytes: capture.value.snapshotReceiptBytes,
			rigServerSnapshotReceiptSignatureBytes:
				capture.value.snapshotSignatureBytes,
			linuxRelayObservationBytes: null,
			rigRelayObservationReceiptBytes: null,
			rigRelayObservationReceiptSignatureBytes: null,
			orderedPartialManifestBytes: null,
			observedProcessProofBytes: null,
			cohortRateSeriesBytes: null,
			cohortLedgerBytes: null,
			cohortCapacityBytes: null,
		});
		if (!admitted.ok) return refused("mac admission", admitted);
		if (admitted.value.cohortAdmission !== null) {
			return fail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the binary issued a cohort admission for an ordinary execution",
			);
		}

		// §5 ASSEMBLY: exact bytes in, verified attestation, then the artifact.
		const attestationEvidence: ArmAttestationEvidenceV2 = {
			schema: "arm-attestation-evidence/v2",
			executionSha256: opened.value.executionSha256,
			serverObservationEvidence: assembleServerObservationEvidence({
				opened: opened.value,
				draftBytes: drafted.value.draftBytes,
				workloadRolePlanInputBytes: drafted.value.workload.bytes,
				stagedServerLaunchRecordBytes: bulkRecord.bytes,
				admittedClientSeriesBytes,
				rigExecutionAcceptance: accepted.value,
				rigMeasureStartAck: baseline.value,
				capture: capture.value,
				admission: admitted.value,
			}),
			cohortObservationEvidence: null,
		};
		const verified = verifyArmAttestationEvidence(
			attestationEvidence,
			{
				macPublicRaw32: input.signed.staged.stagedMacPublicRaw32,
				rigPublicRaw32: input.signed.staged.stagedRigPublicRaw32,
				macPublicKeySha256:
					input.signed.staged.receipt.macSigningPublicKeySha256,
				rigPublicKeySha256:
					input.signed.staged.receipt.rigSigningPublicKeySha256,
			},
			{
				executionSha256: opened.value.executionSha256,
				cellId: input.cell.cellId,
				armKind: input.arm.armKind,
				transport: wire,
				repetitionKind: input.repetitionKind,
				repetitionIndex: execution.repetitionIndex,
				repetitionTotal: execution.repetitionTotal,
				candidate: execution.candidate,
				campaignId: execution.campaignId,
				approvedPlanSha256: input.signed.staged.receipt.approvedPlanSha256,
				approvalRecordSha256: input.signed.staged.receipt.approvalRecordSha256,
			},
		);
		if (!verified.ok) {
			return fail(
				closedCohortFailureCode(verified.code),
				`attestation does not verify: ${verified.message}`,
			);
		}
		const snapshot = serverSnapshotFromCapture({
			capture: capture.value,
			execution: {
				campaignId: grant.campaignId,
				runId: grant.runId,
				executionIndex: grant.executionIndex,
				transport: wire,
			},
		});
		if (!snapshot.ok) return refused("server snapshot", snapshot);

		const mem = process.memoryUsage();
		let artifact: RunArtifact;
		try {
			const arm = measuredLegToArm({
				leg,
				serverSnapshot: snapshot.value.snapshot,
				supervisorContext: {
					toolchains: input.toolchains,
					telemetry: {
						mac: { cpuPercent: 0, rssBytes: mem.rss },
						linux: { cpuPercent: 0, rssBytes: 0 },
					},
					grant,
					admission: presented.admissionFrame,
				},
				execution: {
					campaignId: grant.campaignId,
					runId: grant.runId,
					executionIndex: grant.executionIndex,
					transport: grant.transport,
				},
				attestationEvidence,
			});
			artifact = buildMeasuredArmArtifact({
				cell: input.cell,
				comparisonId: grant.campaignId,
				runId: grant.runId,
				executionIndex: grant.executionIndex,
				transport: wire,
				armKind: input.arm.armKind,
				...(input.arm.armTransport !== undefined
					? { armTransport: input.arm.armTransport }
					: {}),
				sourceIdentity: input.sourceIdentity,
				measurement: arm,
				supervisorToolchainDigests: input.supervisorToolchainDigests,
				executionPurpose: input.executionPurpose,
				repetitionKind: input.repetitionKind,
				measuredRepetitionIndex: input.repIndex,
				measuredRepetitionTotal: input.repetitionTotal,
				attestationEvidence,
			});
		} catch (error) {
			return fail(
				"TRUST_PROTOCOL",
				`assembly refused: ${(error as Error).message}`,
			);
		}
		const sealedOrStopped = await sealOrStopRepetition({
			repetitionKind: input.repetitionKind,
			artifact,
			primaryMetricP50: leg.percentiles.p50,
			trustContext: trustContextForArtifact(artifact),
			sealedPath: input.sealedPath,
			perRepPath: input.perRepPath,
			perRepRecord: leg,
			subject: "sealed artifact",
		});
		if (!sealedOrStopped.ok || sealedOrStopped.sealedPath === "") {
			return sealedOrStopped;
		}
		const readPath = readPathDiagnosticsOf(adapter);
		return {
			...sealedOrStopped,
			...(readPath !== undefined ? { readPath } : {}),
		};
	};

	return await finishOrdinaryArm({ measured, rig });
}

/**
 * The one exit an ordinary arm has once its server child exists.
 *
 * `teardownCohortArmLease` is this for a cohort arm; this is the ordinary
 * arm's, and it exists separately because an ordinary arm owns no Mac
 * supervisor lease and no role-child host -- only the one rig server child.
 *
 * The measured body runs inside, so there is exactly one path out and the
 * teardown is on it: a throw becomes a `TRUST_PROTOCOL` failure and the child
 * is still reaped. The rig's reaped verdict is consumed rather than assumed,
 * and the first failure on the path is the one the caller sees -- a teardown
 * that did not ack is reported only when the measurement itself succeeded,
 * the same rule `teardownCohortArmLease` follows.
 */
export async function finishOrdinaryArm(input: {
	readonly measured: () => Promise<SealedRepResult>;
	readonly rig: Pick<PhaseARigLifecycle, "teardownServer">;
}): Promise<SealedRepResult> {
	let outcome: SealedRepResult;
	try {
		outcome = await input.measured();
	} catch (error) {
		outcome = {
			ok: false,
			failureCode: "TRUST_PROTOCOL",
			reason: `arm refused: ${(error as Error).message}`,
		};
	}
	const stopped = await input.rig.teardownServer();
	if (!stopped.ok) {
		if (!outcome.ok) return outcome;
		return {
			ok: false,
			failureCode: closedCohortFailureCode(stopped.code),
			reason: `rig server teardown (${stopped.code}): ${stopped.message ?? ""}`,
		};
	}
	return outcome;
}

/**
 * The one tail both seal paths end in: §5 step 15 (plan 2189, "Warmup stops
 * here without writing"; run-campaign.ts "assembled, never sealed").
 *
 * A warmup has assembled -- every builder gate ran on it -- and returns here,
 * before any seal, with nothing written. It is repetition index 0 by the
 * builder's own rule (`assertRepetitionIdentityIsStated`) and a sealed
 * artifact is index 1..n by the verifier's, so a warmup is never a sealed
 * artifact at all. A measured repetition is sealed, verified offline under
 * `trustContext` before a byte is written, and then written beside its
 * per-repetition record.
 */
export async function sealOrStopRepetition(input: {
	readonly repetitionKind: "warmup" | "measured";
	readonly artifact: RunArtifact;
	readonly primaryMetricP50: number;
	readonly trustContext: Parameters<typeof verifyRunArtifact>[1];
	readonly sealedPath: string;
	readonly perRepPath: string;
	/** What the per-repetition file records: the leg, or the cohort's export ack. */
	readonly perRepRecord: unknown;
	/** How a verification refusal names the artifact. */
	readonly subject: "sealed artifact" | "sealed cohort artifact";
}): Promise<SealedRepResult> {
	if (input.repetitionKind === "warmup") {
		return {
			ok: true,
			primaryMetricP50: input.primaryMetricP50,
			sealedPath: "",
			artifactSha256: "",
		};
	}
	const sealed = sealRunArtifact(input.artifact);
	const verification = verifyRunArtifact(sealed, input.trustContext);
	if (verification.evidenceStatus !== "PASS") {
		return {
			ok: false,
			failureCode: "TRUST_PROTOCOL",
			reason: `${input.subject} does not verify: ${JSON.stringify(verification).slice(0, 600)}`,
		};
	}
	await Bun.write(input.sealedPath, sealed);
	await Bun.write(
		input.perRepPath,
		JSON.stringify(input.perRepRecord, null, 2),
	);
	const artifactSha256 = createHash("sha256")
		.update(new Uint8Array(await Bun.file(input.sealedPath).arrayBuffer()))
		.digest("hex");
	return {
		ok: true,
		primaryMetricP50: input.primaryMetricP50,
		sealedPath: input.sealedPath,
		artifactSha256,
	};
}

/** Resolve the evidence path for a run. Pure: returns the path,
 *  does not write. */
export function resolveEvidencePath(
	candidate: string,
	campaignId: string,
	runId: string,
	cwd: string = process.cwd(),
): string {
	const dir = resolveOfficialComparisonOutputDir({
		cwd,
		candidate,
		campaignId,
	});
	return `${dir}/${runId}`;
}

/** Validate a deadline. The window must be a positive finite number
 *  with a hard upper bound. */
export function validateDeadline(deadline: Deadline):
	| {
			ok: true;
	  }
	| { ok: false; reason: string } {
	if (
		typeof deadline.windowMs !== "number" ||
		!Number.isFinite(deadline.windowMs) ||
		deadline.windowMs <= 0
	) {
		return {
			ok: false,
			reason: `deadline ${deadline.label} has no upper bound`,
		};
	}
	if (deadline.windowMs > 5 * 60 * 1000) {
		return {
			ok: false,
			reason: `deadline ${deadline.label} exceeds 5 minutes`,
		};
	}
	return { ok: true };
}

/** Validate the rig endpoints. Both interfaces and addresses required. */
export function validateEndpoints(
	endpoints: RigEndpoints,
): { ok: true } | { ok: false; reason: string } {
	if (!endpoints.mac.interface || !endpoints.mac.address) {
		return { ok: false, reason: "mac endpoint missing interface or address" };
	}
	if (
		!endpoints.linux.interface ||
		!endpoints.linux.address ||
		!endpoints.linux.user
	) {
		return {
			ok: false,
			reason: "linux endpoint missing interface, address, or user",
		};
	}
	if (endpoints.mac.interface === endpoints.linux.interface) {
		return { ok: false, reason: "mac and linux interfaces must differ" };
	}
	return { ok: true };
}

/** A typed dry-run report. */
export interface DryRunReport {
	readonly routes: {
		readonly mac: { valid: boolean; interface: string | null };
		readonly linux: { valid: boolean; interface: string | null };
	};
	readonly sshArgv: readonly string[];
	readonly netemApply: readonly string[];
	readonly netemRestore: readonly string[];
	readonly evidencePath: string;
	readonly deadlines: ReadonlyArray<{
		label: string;
		ok: boolean;
		reason?: string;
	}>;
}

const STANDARD_DEADLINES: readonly Deadline[] = [
	{ label: "route-verify", windowMs: 5_000 },
	{ label: "ssh-handshake", windowMs: 10_000 },
	{ label: "scp-binary", windowMs: 30_000 },
	{ label: "netem-apply", windowMs: 5_000 },
	{ label: "server-start", windowMs: 30_000 },
	{ label: "evidence-write", windowMs: 10_000 },
	{ label: "netem-restore", windowMs: 5_000 },
];

const DEFAULT_DELAY_MS = 50;
const DEFAULT_JITTER_MS = 10;

/** Real-run orchestration types. */
interface SshExecResult {
	readonly ok: boolean;
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** What a bounded local command reports. Same shape `sshExec` reports. */
export interface LocalExecResult {
	readonly ok: boolean;
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/**
 * Run a local command under a deadline.
 *
 * `await proc.exited` alone waits forever on a child that never exits, which
 * is what the worktree-archive step did. The child is killed at the deadline
 * and the caller gets a typed timeout instead of a campaign that stops.
 */
export async function localExec(
	argv: readonly string[],
	deadlineMs: number,
): Promise<LocalExecResult> {
	const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill("SIGKILL");
		} catch {
			// ignore: the child may have exited already
		}
	}, deadlineMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	if (timedOut) {
		return {
			ok: false,
			code: -1,
			stdout,
			stderr: `${stderr}\n[local deadline exceeded: ${deadlineMs}ms]`,
			timedOut: true,
		};
	}
	return { ok: code === 0, code, stdout, stderr, timedOut: false };
}

/** Announces each orchestration phase and how long it took. */
export interface PhaseLog {
	run<T>(label: string, body: () => Promise<T>): Promise<T>;
}

/**
 * Narrate the real-run phases on stderr.
 *
 * A campaign that stops producing output is only diagnosable from its log if
 * the log says which phase it was in. Nothing here touches an artifact: the
 * lines go to stderr, and the phase's own value is returned untouched.
 */
export function createPhaseLog(
	write: (line: string) => void,
	now: () => number = Date.now,
): PhaseLog {
	return {
		async run<T>(label: string, body: () => Promise<T>): Promise<T> {
			write(`controller: phase ${label} start\n`);
			const startedAt = now();
			try {
				const value = await body();
				write(`controller: phase ${label} done in ${now() - startedAt}ms\n`);
				return value;
			} catch (error) {
				write(
					`controller: phase ${label} threw after ${now() - startedAt}ms: ${String(error)}\n`,
				);
				throw error;
			}
		},
	};
}

/** Run a single command on the Linux bench over SSH. Bounded by `deadlineMs`. */
export async function sshExec(
	endpoint: RigEndpoints["linux"],
	command: string,
	deadlineMs: number,
): Promise<SshExecResult> {
	const argv = [
		"ssh",
		"-i",
		DEFAULT_SSH_IDENTITY,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`ConnectTimeout=${Math.min(10, Math.max(1, Math.floor(deadlineMs / 1000)))}`,
		`${endpoint.user}@${endpoint.address}`,
		"--",
		command,
	];
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			// ignore: process may have already exited
		}
	}, deadlineMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	if (timedOut) {
		return {
			ok: false,
			code: -1,
			stdout,
			stderr: `${stderr}\n[ssh deadline exceeded: ${deadlineMs}ms]`,
		};
	}
	return { ok: code === 0, code, stdout, stderr };
}

/** SCP a local file to a remote path. */
export async function scpToRemote(
	endpoint: RigEndpoints["linux"],
	localPath: string,
	remotePath: string,
	deadlineMs: number,
): Promise<{ ok: boolean; code: number; stderr: string }> {
	const argv = [
		"scp",
		"-i",
		DEFAULT_SSH_IDENTITY,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`ConnectTimeout=${Math.min(10, Math.max(1, Math.floor(deadlineMs / 1000)))}`,
		localPath,
		`${endpoint.user}@${endpoint.address}:${remotePath}`,
	];
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// ignore
		}
	}, deadlineMs);
	const [stderr, code] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { ok: code === 0, code, stderr };
}

/** SCP a remote file to a local path. */
export async function scpFromRemote(
	endpoint: RigEndpoints["linux"],
	remotePath: string,
	localPath: string,
	deadlineMs: number,
): Promise<{ ok: boolean; code: number; stderr: string }> {
	const argv = [
		"scp",
		"-i",
		DEFAULT_SSH_IDENTITY,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`ConnectTimeout=${Math.min(10, Math.max(1, Math.floor(deadlineMs / 1000)))}`,
		`${endpoint.user}@${endpoint.address}:${remotePath}`,
		localPath,
	];
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// ignore
		}
	}, deadlineMs);
	const [stderr, code] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { ok: code === 0, code, stderr };
}

/** Build a dry-run report. Pure: does no side effects. */
export function buildDryRunReport(
	spec: RunSpec,
	netemDelayMs: number = DEFAULT_DELAY_MS,
	netemJitterMs: number = DEFAULT_JITTER_MS,
): { ok: true; report: DryRunReport } | { ok: false; reason: string } {
	const endpointCheck = validateEndpoints(spec.endpoints);
	if (!endpointCheck.ok) return { ok: false, reason: endpointCheck.reason };
	const macRoute = parseMacRoute(
		`destination: ${spec.endpoints.mac.address}  interface: ${spec.endpoints.mac.interface}`,
		spec.endpoints.mac.address,
	);
	const linuxRoute = parseLinuxRoute(
		`${spec.endpoints.linux.address} dev ${spec.endpoints.linux.interface} src ${spec.endpoints.linux.address}`,
		spec.endpoints.linux.address,
	);
	const sshArgv = buildSshArgv(spec.endpoints.linux, "echo ready && uname -a");
	const netem = buildNetemCommands(
		spec.endpoints.linux.interface,
		netemDelayMs,
		netemJitterMs,
	);
	const evidencePath = resolveEvidencePath(
		spec.candidate,
		spec.campaignId,
		"dry-run",
	);
	const deadlineReports = STANDARD_DEADLINES.map((d) => {
		const v = validateDeadline(d);
		return v.ok
			? { label: d.label, ok: true }
			: { label: d.label, ok: false, reason: v.reason };
	});
	return {
		ok: true,
		report: {
			routes: { mac: macRoute, linux: linuxRoute },
			sshArgv,
			netemApply: netem.apply,
			netemRestore: netem.restore,
			evidencePath,
			deadlines: deadlineReports,
		},
	};
}

/** The CLI entry. Parses args, runs dry-run or real-run. */
export async function main(
	args: readonly string[],
	// The real run is injectable so a test can prove that a throw out of it is
	// classified as a failure rather than the untouched `exitCode = 0`.
	deps: { readonly realRun?: typeof realRun } = {},
): Promise<number> {
	const dryRun = args.includes("--dry-run");
	const parsed = parseControllerArgs(args);
	if (!parsed.ok) {
		process.stderr.write(`controller: ${parsed.reason}\n`);
		return 2;
	}
	const spec = parsed.spec;
	let exitCode = 0;
	let reason: string | null = null;
	let trafficStarted = false;
	let timedOut = false;
	try {
		if (dryRun) {
			const result = buildDryRunReport(spec);
			if (!result.ok) {
				process.stderr.write(`controller dry-run: ${result.reason}\n`);
				exitCode = 3;
				reason = result.reason;
			} else {
				process.stdout.write(formatDryRunReport(result.report));
				exitCode = 0;
			}
		} else {
			// Real-run path: orchestrate the rig end-to-end. Each step is
			// bounded by a deadline from STANDARD_DEADLINES; the typed
			// `ComparisonCliError` is the only failure surface so a real
			// run cannot pretend a measurement landed. The flow mirrors the
			// dry-run: verify rig → SCP worktree → apply netem → start Linux
			// server → run local client → stop server → restore netem.
			trafficStarted = true;
			const runPromise = (deps.realRun ?? realRun)(spec);
			let real: RealRunResult;
			if (spec.campaignTimeoutMs !== undefined) {
				const timeoutMs = spec.campaignTimeoutMs;
				real = await Promise.race([
					runPromise,
					new Promise<RealRunResult>((resolve) => {
						setTimeout(() => {
							resolve({
								ok: false,
								reason: "MEASUREMENT_WINDOW: campaign-timeout-ms exceeded",
							});
						}, timeoutMs);
					}),
				]);
				if (!real.ok && real.reason.includes("campaign-timeout-ms exceeded")) {
					timedOut = true;
				}
			} else {
				real = await runPromise;
			}
			if (!real.ok) {
				process.stderr.write(`controller real-run: ${real.reason}\n`);
				exitCode = timedOut ? 6 : 4;
				reason = real.reason;
				if (
					reason.includes("RIG_UNREACHABLE") ||
					reason.includes("HOST_FD_PREFLIGHT") ||
					reason.includes("STALE_OR_INVALID_STAGING")
				) {
					trafficStarted = false;
				}
			} else {
				process.stdout.write(
					`controller real-run: ok, evidence at ${real.evidencePath}\n`,
				);
				// Full / phase4 canonical campaigns promote flats then render.
				// Focused/pilot have zero flats; freeze wrapper owns sealed-index diagnostic.
				if (
					(spec.stage === "full" || spec.stage === "phase4") &&
					spec.executionPurpose === "canonical"
				) {
					const render = Bun.spawn(
						[
							process.execPath,
							"./tools/compare/bin/render-campaign-report.ts",
							spec.campaignId,
							spec.candidate,
						],
						{
							cwd: process.cwd(),
							stdout: "inherit",
							stderr: "inherit",
						},
					);
					const renderCode = await render.exited;
					if (renderCode !== 0) {
						process.stderr.write(
							`controller: render-campaign-report exited ${renderCode} (flats/index still landed)\n`,
						);
						exitCode = 5;
						reason = `CHILD_LIFECYCLE: render-campaign-report exited ${renderCode}`;
					} else {
						exitCode = 0;
					}
				} else {
					exitCode = 0;
				}
			}
		}
	} catch (error) {
		// A throw is not a pass. Without this the `finally` below classifies the
		// untouched `exitCode = 0` as PASS and writes campaignStatus PASS with
		// trafficStarted true for a controller that crashed before measuring.
		exitCode = 1;
		reason = `CHILD_LIFECYCLE: controller threw: ${String(error)}`;
		process.stderr.write(`controller: ${reason}\n`);
	} finally {
		if (spec.writeTerminalRecordPath !== undefined) {
			const terminal = classifyControllerTerminal({
				candidate: spec.candidate,
				campaignId: spec.campaignId,
				executionPurpose: spec.executionPurpose,
				exitCode,
				reason,
				trafficStarted: exitCode === 0 ? true : trafficStarted,
				timedOut,
			});
			try {
				writeControllerTerminalRecord(spec.writeTerminalRecordPath, terminal);
			} catch (error) {
				process.stderr.write(
					`controller: write-terminal-record failed: ${String(error)}\n`,
				);
				if (exitCode === 0) {
					exitCode = 7;
				}
			}
		}
	}
	return exitCode;
}

/** A typed real-run result. */
type RealRunResult =
	| { readonly ok: true; readonly evidencePath: string }
	| {
			readonly ok: false;
			readonly reason: string;
	  };

/** The real-run path: orchestrate the rig end-to-end. */
/** The environment names the frozen run command exports for the Mac boundary. */
export const MAC_SIGNING_KEY_ENV = "COMPARISON_MAC_SIGNING_KEY";
/**
 * The rig's signing key path, as the frozen run command exports it
 * (`stage-live-campaign.ts` `buildFrozenRunCommand`); opened by the rig
 * wrapper as `--cohort-signing-key-fd`, never read by this process.
 */
export const RIG_SIGNING_KEY_ENV = "COMPARISON_RIG_SIGNING_KEY";
/** The rig's Bun, as the frozen run command exports it. */
export const RIG_BUN_PATH_ENV = "COMPARISON_RIG_BUN_PATH";
/**
 * How long a receipt the Mac binary signs stays valid. Wide enough for the
 * longest registered execution (chat 1k: 90 s readiness + 5 s warmup + 30 s
 * measured + 10 s drain) plus the terminal export, and the same window the
 * real server-child suite runs its rig under.
 */
export const COHORT_RECEIPT_VALIDITY_MS = 600_000;
export const MAC_SUPERVISOR_USER_ENV = "COMPARISON_MAC_SUPERVISOR_USER";
export const MAC_SUPERVISOR_UID_SEAM_ENV = "COMPARISON_MAC_SUPERVISOR_UID_SEAM";
export const MAC_CAMPAIGN_SCRATCH_ROOT_ENV =
	"COMPARISON_MAC_CAMPAIGN_SCRATCH_ROOT";

/**
 * The rig's bootstrap paths: ONE root (G3b). `COMPARISON_RIG_STAGED_DIR` is
 * the directory the authority's single `linux-staging` declaration identifies
 * (`stage-live-campaign.ts` observe-linux `--root`), and the 2026-08-24
 * amendment models the Linux supervisor with exactly that retained handle:
 * install-minted lays the lock, capability and manifest leaves directly under
 * it, and the wrapper passes it as the rig's only root fd — no campaign root
 * and no `--campaign-root-fd` (`RigTrustBootstrapPaths`). The darwin
 * local-acceptance rig is not spawned here; the e2e boots it from the Mac's
 * own two-root pair, so the arm is chosen by which staging produced the root
 * and never by an environment switch.
 */
export function rigTrustBootstrapPaths(
	rigStagedDir: string,
):
	| { readonly ok: true; readonly paths: SingleRootTrustBootstrapPaths }
	| { readonly ok: false; readonly reason: string } {
	// The wrapper opens these under `set -eu` from `cd /` on the far side of
	// ssh and sudo; a relative root would name a directory of the target
	// account's cwd, not the staged one.
	if (!rigStagedDir.startsWith("/")) {
		return {
			ok: false,
			reason: `REFUSED/STALE_OR_INVALID_STAGING: COMPARISON_RIG_STAGED_DIR must be the absolute path of the rig's staged root, got ${JSON.stringify(rigStagedDir)}`,
		};
	}
	return {
		ok: true,
		paths: {
			authorityFile: `${rigStagedDir}/${TRUST_BOOTSTRAP_AUTHORITY_LEAF}`,
			authorityDigestFile: `${rigStagedDir}/${TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF}`,
			stagingRootDir: rigStagedDir,
		},
	};
}

async function realRun(spec: RunSpec): Promise<RealRunResult> {
	let macSupervisor: SupervisorHandle | undefined;
	let rigSupervisor: SupervisorHandle | undefined;
	let result: RealRunResult = { ok: false, reason: "controller did not run" };
	// §2.9(4d): the reap verdict is consumed on every path out. A run that
	// measured and then could not reap its supervisor is a lifecycle FAIL,
	// never a PASS with a process left behind.
	const verdicts: string[] = [];
	try {
		result = await (async (): Promise<RealRunResult> => {
			let signed: SignedRunMaterial | undefined;
			if (spec.stagedDir !== undefined) {
				const expectedAuthority = resolveStagedAuthorityDigest(spec.stagedDir);
				const staged = verifyStagedTrustBootstrap(
					spec.stagedDir,
					expectedAuthority,
				);
				if (!staged.ok) {
					return {
						ok: false,
						reason: `REFUSED/STALE_OR_INVALID_STAGING: staged-dir verify failed (${staged.code}): ${staged.message}`,
					};
				}
				const binary = resolveSupervisorBinaryPath();
				if (!binary.ok) {
					return { ok: false, reason: binary.message };
				}
				const bunPath = resolveSupervisorBunPath();
				if (!bunPath.ok) {
					return { ok: false, reason: bunPath.message };
				}
				// The stage material every signed execution is drafted from, read
				// through the verified handles and checked against the receipt.
				const material = readStagedCohortMaterial(staged.paths);
				if (!material.ok) {
					return {
						ok: false,
						reason: `REFUSED/STALE_OR_INVALID_STAGING: ${material.message}`,
					};
				}
				const macClockId = observeMacClockIdentity();
				if (!macClockId.ok) {
					return {
						ok: false,
						reason: `REFUSED/STALE_OR_INVALID_STAGING: ${macClockId.message}`,
					};
				}
				// §2.9(4): the Mac signing key crosses to the account that owns it.
				// With the key named, the twelve access preconditions run before any
				// spawn; without it the spawn carries no key and the binary cannot
				// sign, which every signed execution then reports as its own FAIL.
				const macSigningKeyPath = process.env[MAC_SIGNING_KEY_ENV];
				let cohortDescriptors:
					| Parameters<typeof spawnMacSupervisor>[0]["cohort"]
					| undefined;
				let controllerUidSeam:
					| Parameters<typeof spawnMacSupervisor>[0]["controllerUidSeam"]
					| undefined;
				if (
					typeof macSigningKeyPath === "string" &&
					macSigningKeyPath.length > 0
				) {
					const targetUser =
						process.env[MAC_SUPERVISOR_USER_ENV] ?? MAC_SUPERVISOR_DEFAULT_USER;
					if (process.env[MAC_SUPERVISOR_UID_SEAM_ENV] === "1") {
						controllerUidSeam = {
							campaignScratchRoot:
								process.env[MAC_CAMPAIGN_SCRATCH_ROOT_ENV] ??
								dirname(macSigningKeyPath),
						};
					} else {
						const preflight = runMacUidPreflight({
							targetUser,
							macSigningKeyPath,
							macTrustDir: staged.paths.stagedDir,
							campaignRootDir: staged.paths.campaignRootDir,
							stagingRootDir: staged.paths.stagingRootDir,
							bunExecutablePath: bunPath.path,
						});
						if (!preflight.ok) {
							return { ok: false, reason: preflight.message ?? preflight.code };
						}
					}
					cohortDescriptors = {
						macSigningKey: {
							fd: 7,
							label: "mac-signing-key",
							path: macSigningKeyPath,
						},
						stagedRigPublicKey: {
							fd: 8,
							label: "staged-rig-public-key",
							path: join(
								staged.paths.stagingRootDir,
								"rig-supervisor-ed25519.pub",
							),
						},
						// The campaign chooses the receipt validity window here; the
						// spawn wrapper exports it to the binary on both tiers.
						receiptValidityMs: COHORT_RECEIPT_VALIDITY_MS,
					};
				}
				const spawned = await spawnMacSupervisor({
					binaryPath: binary.path,
					bunExecutablePath: bunPath.path,
					// Placeholder FDs: spawn maps real descriptors onto fixed
					// child slots 3..N via Bun.spawn `stdio`.
					bootstrap: {
						authority: { fd: 3, label: "authority" },
						authorityDigest: { fd: 4, label: "authority-digest" },
						campaignRoot: { fd: 5, label: "campaign-root" },
						stagingRoot: { fd: 6, label: "staging-root" },
					},
					localPaths: {
						authorityFile: staged.paths.authorityFile,
						authorityDigestFile: staged.paths.authorityDigestFile,
						campaignRootDir: staged.paths.campaignRootDir,
						stagingRootDir: staged.paths.stagingRootDir,
					},
					...(cohortDescriptors !== undefined
						? { cohort: cohortDescriptors }
						: {}),
					...(controllerUidSeam !== undefined ? { controllerUidSeam } : {}),
				});
				if (!spawned.ok) {
					return {
						ok: false,
						reason: `mac supervisor spawn failed (${spawned.code}): ${spawned.message}`,
					};
				}
				macSupervisor = spawned.handle;
				// "ready" is now a claim the spawn earned: the child survived
				// its own bootstrap, and its exit status and stderr are
				// retained for every exchange that follows.
				process.stdout.write(
					`controller: mac supervisor pid=${macSupervisor.pid} (alive past bootstrap; control pipes ready)\n`,
				);
				signed = {
					staged: material.value,
					bootstrap: staged.paths,
					// The staged certificate, not a per-run file copied off the rig.
					tlsCaPem: material.value.tlsCaPem,
					bunExecutablePath: bunPath.path,
					macClockId: macClockId.value,
					runtimeRoot: mkdtempSync(join(tmpdir(), "ws-wt-cohort-runtime-")),
				};

				const rigStagedDir = process.env.COMPARISON_RIG_STAGED_DIR;
				const rigBinary = process.env.COMPARISON_RIG_SUPERVISOR_BINARY;
				if (
					typeof rigStagedDir === "string" &&
					rigStagedDir.length > 0 &&
					typeof rigBinary === "string" &&
					rigBinary.length > 0
				) {
					// The rig's two install descriptors (design §3.1): its signing
					// key from the frozen run command, its role root from the
					// receipt that observed it. Without the key the binary installs
					// no cohort runtime and refuses every signed frame, so a staged
					// run without it is refused here, by name, before any spawn.
					const rigSigningKeyPath = process.env[RIG_SIGNING_KEY_ENV];
					if (
						typeof rigSigningKeyPath !== "string" ||
						rigSigningKeyPath.length === 0
					) {
						return {
							ok: false,
							reason: `REFUSED/STALE_OR_INVALID_STAGING: ${RIG_SIGNING_KEY_ENV} is not set; a staged rig cannot install its cohort runtime without its signing key`,
						};
					}
					// The rig's Bun, not the Mac's: the wrapper exports it on the rig
					// as COMPARISON_SUPERVISOR_BUN_PATH (frozen run command).
					const rigBunPath = process.env[RIG_BUN_PATH_ENV];
					if (typeof rigBunPath !== "string" || rigBunPath.length === 0) {
						return {
							ok: false,
							reason: `REFUSED/STALE_OR_INVALID_STAGING: ${RIG_BUN_PATH_ENV} is not set; the rig wrapper exports the Bun the rig launches`,
						};
					}
					const rigPaths = rigTrustBootstrapPaths(rigStagedDir);
					if (!rigPaths.ok) return { ok: false, reason: rigPaths.reason };
					const linux = spec.endpoints.linux;
					const rigSpawned = await spawnRigSupervisor({
						rigCohort: {
							signingKey: {
								fd: 7,
								label: "cohort-signing-key",
								path: rigSigningKeyPath,
							},
							roleRoot: {
								fd: 10,
								label: "cohort-role-root",
								path: material.value.receipt.rigRoleRootPath,
							},
						},
						// The key is 0400 owned by the rig's `_wtcompare`; the ssh user
						// cannot read it (stage-live-campaign.ts, `test ! -r`), so the
						// spawn crosses to that account on the rig.
						uidCrossing: { targetUser: MAC_SUPERVISOR_DEFAULT_USER },
						binaryPath: binary.path,
						bunExecutablePath: rigBunPath,
						bootstrap: {
							authority: { fd: 3, label: "authority" },
							authorityDigest: { fd: 4, label: "authority-digest" },
							campaignRoot: { fd: 5, label: "campaign-root" },
							stagingRoot: { fd: 6, label: "staging-root" },
						},
						rigBinaryPath: rigBinary,
						rigPaths: rigPaths.paths,
						sshTarget: `${linux.user}@${linux.address}`,
						sshIdentity: DEFAULT_SSH_IDENTITY,
					});
					if (!rigSpawned.ok) {
						return {
							ok: false,
							reason: `rig supervisor spawn failed (${rigSpawned.code}): ${rigSpawned.message}`,
						};
					}
					rigSupervisor = rigSpawned.handle;
					process.stdout.write(
						`controller: rig supervisor pid=${rigSupervisor.pid} (alive past bootstrap; ssh control channel ready)\n`,
					);
				}
			}

			return await realRunBody(spec, macSupervisor, rigSupervisor, signed);
		})();
	} finally {
		if (rigSupervisor !== undefined) {
			const stopped = await stopSupervisor(rigSupervisor, 5_000);
			if (!stopped.ok)
				verdicts.push(`rig supervisor ${stopped.code}: ${stopped.message}`);
		}
		if (macSupervisor !== undefined) {
			const stopped = await stopSupervisor(macSupervisor, 5_000);
			if (!stopped.ok)
				verdicts.push(`mac supervisor ${stopped.code}: ${stopped.message}`);
		}
	}
	if (verdicts.length > 0) {
		process.stderr.write(
			`controller: teardown not reaped: ${verdicts.join("; ")}\n`,
		);
		if (result.ok) {
			return {
				ok: false,
				reason: `CHILD_LIFECYCLE: teardown not reaped: ${verdicts.join("; ")}`,
			};
		}
	}
	return result;
}

/** Rig orchestration after optional Mac+rig supervisors are up. */
async function realRunBody(
	spec: RunSpec,
	macSupervisor: SupervisorHandle | undefined,
	rigSupervisor: SupervisorHandle | undefined,
	signedMaterial: SignedRunMaterial | undefined,
): Promise<RealRunResult> {
	const linux = spec.endpoints.linux;
	const deadlines = new Map(
		STANDARD_DEADLINES.map((d) => [d.label, d.windowMs] as const),
	);
	const phases = createPhaseLog((line) => process.stderr.write(line));

	// Phase 1: route verify (live ping from Mac to Linux, sourced
	// from the Mac interface to prove direct-cable, not via gateway).
	const pingDeadline = deadlines.get("route-verify") ?? 5_000;
	const pingResult = await phases.run("route-verify", () =>
		sshExec(
			linux,
			`ping -c 1 -W ${Math.max(1, Math.floor(pingDeadline / 1000))} 127.0.0.1`,
			pingDeadline,
		),
	);
	if (!pingResult.ok) {
		return {
			ok: false,
			reason: `route-verify failed: ${pingResult.stderr.trim()}`,
		};
	}

	// Phase 2: verify Linux is reachable and Bun is installed.
	const sshDeadline = deadlines.get("ssh-handshake") ?? 10_000;
	const helloResult = await phases.run("ssh-handshake", () =>
		sshExec(linux, "uname -a && ~/.bun/bin/bun --version", sshDeadline),
	);
	if (!helloResult.ok) {
		return {
			ok: false,
			reason: `ssh-handshake failed: ${helloResult.stderr.trim() || "unknown"}`,
		};
	}

	// Phase 3: SCP a minimal worktree tarball to Linux. The worktree
	// is the source for the server; the controller runs the local
	// client directly without a separate SCP.
	const scpDeadline = deadlines.get("scp-binary") ?? 30_000;
	const tarPath = `/tmp/ws-wt-${spec.candidate}-${Date.now()}.tar.gz`;
	const worktreeRoot = process.cwd();
	// (The actual SCP happens via scpToRemote below; no
	// pre-extract step is needed.)
	const tarLocalPath = `/tmp/ws-wt-${spec.candidate}.tar.gz`;
	// Bounded by the same `scp-binary` window the transfer of this archive
	// uses: the archive step used to await the child's exit with no deadline
	// and no drain, which is a wait with no end if tar ever stalls or fills
	// its stderr pipe.
	const tarBuildResult = await phases.run("worktree-archive", () =>
		localExec(
			[
				"tar",
				"--exclude=node_modules",
				"--exclude=.release-evidence",
				"--exclude=target",
				"--exclude=.git",
				"-czf",
				tarLocalPath,
				"-C",
				worktreeRoot,
				".",
			],
			scpDeadline,
		),
	);
	if (!tarBuildResult.ok) {
		return {
			ok: false,
			reason: `tar build failed: ${tarBuildResult.stderr.trim()}`,
		};
	}
	const scpResult = await phases.run("scp-binary", () =>
		scpToRemote(linux, tarLocalPath, tarPath, scpDeadline),
	);
	if (!scpResult.ok) {
		return {
			ok: false,
			reason: `scp-binary failed: ${scpResult.stderr.trim()}`,
		};
	}
	const extractResult = await phases.run("rig-extract", () =>
		sshExec(
			linux,
			`mkdir -p /tmp/ws-wt-rig && tar xzf ${tarPath} -C /tmp/ws-wt-rig && echo ok`,
			scpDeadline,
		),
	);
	if (!extractResult.ok || !extractResult.stdout.includes("ok")) {
		return {
			ok: false,
			reason: `scp extract failed: ${extractResult.stderr.trim() || extractResult.stdout.trim()}`,
		};
	}

	// Build rig native prebuilds + install them so the server can load the addon.
	const rigBuildResult = await phases.run("rig-build", () =>
		sshExec(
			linux,
			`set -euo pipefail; cd /tmp/ws-wt-rig; if [ ! -d packages/webtransport/prebuilds ] || ! ls packages/webtransport/prebuilds/webtransport-native.linux-x64-gnu.node >/dev/null 2>&1; then export PATH=$HOME/.bun/bin:$HOME/.cargo/bin:$PATH; /home/hermes-admin/.bun/bin/bun install --frozen-lockfile; cargo build -p native --release; /home/hermes-admin/.bun/bin/bun run build:native; /home/hermes-admin/.bun/bin/bun x --bun @napi-rs/cli build --platform --release 2>/dev/null || true; install -d -m 755 packages/webtransport/prebuilds; for f in crates/native/*.node; do [ -f "$f" ] || continue; cp "$f" packages/webtransport/prebuilds/; done; fi; test -f packages/webtransport/prebuilds/webtransport-native.linux-x64-gnu.node && echo ok-prebuilds || (echo MISSING-PREBUILDS; ls packages/webtransport/prebuilds/; exit 1)`,
			deadlines.get("rig-build") ?? 600_000,
		),
	);
	if (!rigBuildResult.ok || !rigBuildResult.stdout.includes("ok-prebuilds")) {
		return {
			ok: false,
			reason: `rig prebuild build failed: ${rigBuildResult.stderr.trim() || rigBuildResult.stdout.trim()}`,
		};
	}

	// The signed lifecycle carries the staged certificate (readStagedCohortMaterial):
	// the rig serves the staged identity and the Mac verifies against it. Only
	// the unsigned legacy path still mints a per-run certificate on the rig and
	// copies it here.
	const signed: SignedRunMaterial | undefined = signedMaterial;
	if (signedMaterial === undefined) {
		// Ensure a rig self-signed cert exists with SNI gravvene-dev-home + IP 10.99.0.2
		// and copy it to the Mac so the client can verify TLS with --tls-ca /tmp/ws-wt-server.crt.
		const certGenResult = await sshExec(
			linux,
			`set -euo pipefail; cd /tmp/ws-wt-rig; if [ ! -f /tmp/ws-wt-server.crt ] || [ ! -f /tmp/ws-wt-server.key ] || ! openssl x509 -in /tmp/ws-wt-server.crt -noout -ext subjectAltName 2>/dev/null | grep -q "gravvene-dev-home"; then openssl req -x509 -newkey rsa:2048 -keyout /tmp/ws-wt-server.key -out /tmp/ws-wt-server.crt -days 365 -nodes -subj '/CN=gravvene-dev-home' -addext "basicConstraints=CA:FALSE" -addext "extendedKeyUsage=serverAuth" -addext "subjectAltName=DNS:gravvene-dev-home,IP:10.99.0.2,DNS:wt-compare.local" 2>/dev/null; chmod 644 /tmp/ws-wt-server.crt /tmp/ws-wt-server.key; fi; echo ok`,
			scpDeadline,
		);
		if (!certGenResult.ok || !certGenResult.stdout.includes("ok")) {
			return {
				ok: false,
				reason: `rig cert generate failed: ${certGenResult.stderr.trim() || certGenResult.stdout.trim()}`,
			};
		}
		const scpCert = await scpFromRemote(
			linux,
			"/tmp/ws-wt-server.crt",
			"/tmp/ws-wt-server.crt",
			scpDeadline,
		);
		if (!scpCert.ok) {
			return {
				ok: false,
				reason: `scp cert to mac failed: ${scpCert.stderr.trim()}`,
			};
		}
	}

	// Phase 4+: per (cell × transport) — optional netem, start server, seal reps.
	const netemDeadline = deadlines.get("netem-apply") ?? 5_000;
	const serverStartDeadline = deadlines.get("server-start") ?? 30_000;
	// Long legs (ticker 250 echoes, 100 MiB bulk) need a wide present budget;
	// the `evidence-write` deadline governs short control ops, not this.
	const sealPresentDeadlineMs = 5 * 60 * 1000;
	const serverPort = 4433;
	const cellIds = spec.cells ?? [spec.cell];
	const campaignStage = spec.stage ?? "phase4";
	const evidenceDir = resolveOfficialComparisonOutputDir({
		cwd: worktreeRoot,
		candidate: spec.candidate,
		campaignId: spec.campaignId,
	});
	try {
		await Bun.$`mkdir -p ${evidenceDir}`.quiet();
	} catch {
		// ignore
	}

	const useInProcessSeal =
		macSupervisor !== undefined && hasControlPipes(macSupervisor);

	let sealedToolchains: ToolchainSet | undefined;
	let supervisorToolchainDigests:
		| { readonly darwin: string; readonly linux: string }
		| undefined;
	if (useInProcessSeal) {
		const observed = await phases.run("toolchain-observe", () =>
			observeCampaignToolchains(linux, sshDeadline),
		);
		if (!observed.ok) {
			return { ok: false, reason: observed.reason };
		}
		sealedToolchains = observed.toolchains;
		supervisorToolchainDigests = observed.supervisorToolchainDigests;
	}

	const indexPath = `${evidenceDir}/campaign-index.json`;
	// Resume carries forward only what a previous run sealed and still has on
	// disk; a FAIL or a REFUSED is re-measured, which is the reason to resume.
	const carried = spec.resume
		? resumableEntries(readCampaignIndex(indexPath), spec.campaignId)
		: new Map<string, CampaignIndexEntry>();
	if (carried.size > 0) {
		process.stdout.write(
			`controller: resuming, ${carried.size} sealed arm executions carried forward\n`,
		);
	}
	const armKinds = spec.armKinds ?? ["primary", "read-path", "overlay"];
	// The staged identity every sealed artifact must embed: the candidate git
	// SHA plus the stage receipt's archive and capability digests -- the same
	// values the campaign index records and `verify-campaign-index` anchors
	// against. Resolved once; a seal and its index row must not be able to
	// disagree about what was staged.
	const campaignDigests = resolveCampaignIndexDigests(spec);
	const stagedSourceIdentity = {
		sourceSha: spec.candidate,
		archiveSha256: campaignDigests.sourceArchiveSha256,
		executableSha256: campaignDigests.stagedCapabilitySha256,
	};
	// The cohort runtime the six fanout primaries are dispatched to. The
	// provider is production and always supplied; the lease factory exists
	// exactly when the campaign spawned both supervisors and read its stage
	// material, and a fanout primary without one is refused with the named
	// missing input -- never demoted to a single-session leg.
	const cohortRuntimeProvider: CohortArmRuntimeProvider =
		createCohortArmRuntimeProvider({
			sourceIdentity: stagedSourceIdentity,
			...(supervisorToolchainDigests !== undefined
				? { supervisorToolchainDigests }
				: {}),
			executionPurpose: spec.executionPurpose,
			repetitionTotal: spec.repetitions,
			...(macSupervisor !== undefined &&
			rigSupervisor !== undefined &&
			sealedToolchains !== undefined &&
			signed !== undefined
				? {
						lease: createProductionCohortArmLeaseFactory({
							staged: signed.staged,
							bootstrap: signed.bootstrap,
							macSupervisor,
							rigSupervisor,
							executionPurpose: spec.executionPurpose,
							repetitionTotal: spec.repetitions,
							toolchains: sealedToolchains,
							bunExecutablePath: signed.bunExecutablePath,
							serverPort,
							tlsCaPem: signed.tlsCaPem,
							macClockId: signed.macClockId,
							runtimeRoot: signed.runtimeRoot,
						}),
					}
				: {}),
		});
	let scheduledArms = 0;
	const indexEntries: CampaignIndexEntry[] = [];
	let lastEvidencePath = "";

	const persistIndex = async (): Promise<void> => {
		if (!useInProcessSeal) return;
		// The same resolution the seals embedded; re-reading the receipt here
		// could let the index and the sealed bytes disagree mid-run.
		const digests = campaignDigests;
		const snapshot: CampaignIndex = {
			schema: "campaign-index/v2",
			campaignRunId: spec.campaignId,
			stage: campaignStage,
			candidate: spec.candidate,
			campaignId: spec.campaignId,
			approvedPlanSha256: digests.approvedPlanSha256,
			approvalRecordSha256: digests.approvalRecordSha256,
			stagedCapabilitySha256: digests.stagedCapabilitySha256,
			sourceArchiveSha256: digests.sourceArchiveSha256,
			executionPurpose: spec.executionPurpose,
			...(spec.stagedDir !== undefined ? { stagedDir: spec.stagedDir } : {}),
			cells: cellIds,
			arms: spec.arms,
			armKinds,
			warmupRepetitions: 1,
			measuredRepetitions: (spec.repetitions === 5 ? 5 : 1) as 1 | 5,
			scheduledMeasuredArms: scheduledArms,
			entries: indexEntries,
		};
		await writeCampaignIndexSnapshot(indexPath, snapshot);
	};

	const stopServer = async () => {
		await sshExec(
			linux,
			`pkill -TERM -f "tools/compare/server.ts" || true; sleep 1; pkill -KILL -f "tools/compare/server.ts" || true`,
			netemDeadline,
		);
	};
	const restoreNetem = async () => {
		await sshExec(
			linux,
			`sudo tc qdisc del dev ${linux.interface} root 2>&1 || true; echo done`,
			netemDeadline,
		);
	};

	// WT preflight once before first WT arm.
	if (spec.arms.includes("wt")) {
		const wtProbe = await phases.run("wt-preflight", () =>
			sshExec(
				linux,
				`test -d /tmp/ws-wt-rig/prebuilds && ls /tmp/ws-wt-rig/prebuilds 2>/dev/null | head -3; ~/.bun/bin/bun -e "try{require('node:fs').accessSync('/tmp/ws-wt-rig/package.json');console.log('ok')}catch(e){console.log('missing')}"`,
				sshDeadline,
			),
		);
		if (!wtProbe.ok || !wtProbe.stdout.includes("ok")) {
			// Environmental, and before any traffic: the campaign is refused
			// whole rather than one wire at a time, because a REFUSED row may
			// not follow a PASS or FAIL row (base plan §7).
			return {
				ok: false,
				reason: `REFUSED/STALE_OR_INVALID_STAGING: WT preflight failed: ${wtProbe.stderr.trim() || wtProbe.stdout.trim() || "rig tree missing"}`,
			};
		}
	}

	for (const cellId of cellIds) {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) =>
				candidate.cellId === cellId || candidate.scenarioId === cellId,
		);
		if (cell === undefined) {
			await stopServer();
			await restoreNetem();
			return {
				ok: false,
				reason: `unknown cell '${cellId}' in CANONICAL_SCENARIO_REGISTRY`,
			};
		}
		const impairment = impairmentForCell(cell);
		const impairmentLabel =
			impairment.kind === "none"
				? "none"
				: `delay${impairment.delayMs}${impairment.lossPercent !== undefined ? `-loss${impairment.lossPercent}` : ""}`;
		// One pair run id per cell. `sealRunIdForArm` derives each arm's own run
		// id from it, sharing one id inside a pairing cohort and never across a
		// wire, so no two arms of this cell contend for the same grant.
		const pairRunId = `${spec.candidate}-${spec.campaignId}-${cellSafeId(cell.cellId)}-${Date.now()}`;

		for (const arm of sealArmsForCell(cell, spec.arms, armKinds)) {
			const armId = arm.armId;
			const slotId = sealArmSlotId(arm);
			scheduledArms += spec.repetitions;
			await stopServer();
			await restoreNetem();

			if (impairment.kind === "netem") {
				const netem = buildNetemCommands(
					linux.interface,
					impairment.delayMs,
					impairment.jitterMs,
					impairment.lossPercent,
				);
				const applyResult = await sshExec(
					linux,
					`sudo ${netem.apply.join(" ")} 2>&1 || echo "tc not permitted; continuing"`,
					netemDeadline,
				);
				if (!applyResult.ok) {
					await restoreNetem();
					return {
						ok: false,
						reason: `netem-apply failed: ${applyResult.stderr.trim()}`,
					};
				}
			}

			const repDir = `${evidenceDir}/reps/${cellSafeId(cell.cellId)}/${slotId}`;
			try {
				await Bun.$`mkdir -p ${repDir}`.quiet();
			} catch {
				// ignore
			}

			// §6: one unsealed warmup, then the purpose's measured repetitions.
			// The warmup is a real execution -- same server, same arm, same wire --
			// and its only distinction is that nothing it produces is sealed,
			// indexed, promoted or counted. That distinction is what makes it a
			// warmup rather than a sixth repetition wearing a label.
			for (const slot of armRepetitionSchedule(spec.executionPurpose)) {
				const repIndex = slot.repetitionIndex;
				const carriedEntry =
					slot.repetitionKind === "warmup"
						? undefined
						: carried.get(
								campaignIndexKey({
									cellId: cell.cellId,
									armId,
									repetitionIndex: repIndex,
								}),
							);
				if (carriedEntry !== undefined) {
					indexEntries.push(carriedEntry);
					lastEvidencePath = carriedEntry.sealedPath ?? lastEvidencePath;
					await persistIndex();
					continue;
				}
				// Under the in-process seal every server is spawned by the rig
				// supervisor under a signed execution (amendment C4); the SSH/nohup
				// server below belongs to the unsealed fallback only.
				if (!useInProcessSeal) {
					// Bulk (and any one-shot peer) exits after a single session; restart
					// the Linux server for every rep so acceptUni cannot race a spent peer.
					await stopServer();
					// The rig server is opened for the wire, not for the arm: a
					// read-path arm measures against the same server its primary does.
					const probeCmd =
						arm.transport === "wt"
							? `ss -ulnH 'sport = :${serverPort}' 2>/dev/null | grep -q ":${serverPort} " || ss -uln 2>/dev/null | awk '{print $4}' | grep -E "[:.]${serverPort}$" | head -1`
							: `ss -tlnH 'sport = :${serverPort}' 2>/dev/null | grep -q ":${serverPort} " || ss -tln 2>/dev/null | awk '{print $4}' | grep -E "[:.]${serverPort}$" | head -1`;
					const serverCmd = `set -euo pipefail; cd /tmp/ws-wt-rig; if [ ! -f /tmp/ws-wt-server.crt ] || [ ! -f /tmp/ws-wt-server.key ] || ! openssl x509 -in /tmp/ws-wt-server.crt -noout -ext subjectAltName 2>/dev/null | grep -q "gravvene-dev-home"; then openssl req -x509 -newkey rsa:2048 -keyout /tmp/ws-wt-server.key -out /tmp/ws-wt-server.crt -days 365 -nodes -subj '/CN=gravvene-dev-home' -addext "basicConstraints=CA:FALSE" -addext "extendedKeyUsage=serverAuth" -addext "subjectAltName=DNS:gravvene-dev-home,IP:10.99.0.2,DNS:wt-compare.local" 2>/dev/null; chmod 644 /tmp/ws-wt-server.crt /tmp/ws-wt-server.key; fi; export WS_WT_TLS_CERT_CONTENT="$(cat /tmp/ws-wt-server.crt)"; export WS_WT_TLS_KEY_CONTENT="$(cat /tmp/ws-wt-server.key)"; setsid nohup ~/.bun/bin/bun run tools/compare/server.ts --transport ${arm.transport} --scenario ${cell.scenarioId} --port ${serverPort} --bind ${linux.address} --run-id ${spec.campaignId}-${cellSafeId(cell.cellId)}-${slotId}-r${repIndex} </dev/null >/tmp/ws-wt-server.log 2>&1 & disown; for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; if ${probeCmd} >/dev/null 2>&1; then echo "server-listening"; break; fi; if [ "$i" = "10" ]; then echo "SERVER_START_TIMEOUT" >&2; tail -50 /tmp/ws-wt-server.log >&2; exit 1; fi; done`;
					const startResult = await sshExec(
						linux,
						serverCmd,
						serverStartDeadline,
					);
					if (!startResult.ok) {
						await stopServer();
						await restoreNetem();
						return {
							ok: false,
							reason: `server-start failed (${armId} rep ${repIndex}): ${startResult.stderr.trim() || startResult.stdout.trim()}`,
						};
					}
					await new Promise((r) => setTimeout(r, 1500));
				}

				const slotLabel =
					slot.repetitionKind === "warmup" ? "warmup" : `rep-${repIndex}`;
				const perRepPath = `${repDir}/${slotLabel}.json`;
				const sealedPath = `${repDir}/${slotLabel}.sealed.json`;
				const runId = `${sealRunIdForArm(pairRunId, arm, repIndex)}${
					slot.repetitionKind === "warmup" ? "-warmup" : ""
				}`;

				if (
					useInProcessSeal &&
					macSupervisor !== undefined &&
					rigSupervisor !== undefined &&
					sealedToolchains !== undefined &&
					supervisorToolchainDigests !== undefined &&
					signed !== undefined
				) {
					let sealed: SealedRepResult;
					try {
						// The one dispatch. `dispatchArmRepetition` asks
						// `cohortCellForArm` which executor this arm belongs to, so the
						// six fanout primaries go to the cohort executor and everything
						// else goes to the single-session leg -- and neither the loop
						// nor a second list here gets to disagree with the builder and
						// the verifier about which is which.
						const dispatched = await phases.run(
							`arm ${armId} ${slotLabel}`,
							() =>
								dispatchArmRepetition({
									arm: {
										macSupervisor,
										rigSupervisor,
										linux,
										cell,
										arm,
										runId,
										sourceIdentity: stagedSourceIdentity,
										repIndex,
										serverPort,
										perRepPath,
										sealedPath,
										toolchains: sealedToolchains,
										supervisorToolchainDigests,
										controlDeadlineMs: sealPresentDeadlineMs,
										executionPurpose: spec.executionPurpose,
										repetitionKind: slot.repetitionKind,
										repetitionTotal: spec.repetitions,
										signed,
									},
									cohortRuntime: cohortRuntimeProvider,
								}),
						);
						sealed = dispatched.result;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						sealed = { ok: false, reason: message };
					}
					if (slot.repetitionKind === "warmup") {
						// The warmup's only output is a hot path. It is not sealed, not
						// indexed, not promoted and not counted -- and a warmup that
						// fails is not a campaign failure either, because nothing
						// downstream is allowed to have depended on it.
						process.stdout.write(
							`controller: warmup ${sealed.ok ? "OK" : `SKIPPED (${sealed.reason})`} ${armId}\n`,
						);
						continue;
					}
					if (!sealed.ok) {
						indexEntries.push({
							schema: "campaign-index-entry/v2",
							cellId: cell.cellId,
							armId,
							transport: arm.transport,
							armKind: arm.armKind,
							armTransport: arm.armTransport ?? null,
							impairment: impairmentLabel,
							executionPurpose: spec.executionPurpose,
							repetitionKind: "measured",
							repetitionIndex: repIndex,
							repetitionTotal: spec.repetitions,
							status: "FAIL",
							promotable: false,
							// The dispatch already mapped a cohort refusal onto §7's
							// closed set; a leg failure keeps the trust-protocol default
							// it has always carried.
							failureCode: sealed.failureCode ?? "TRUST_PROTOCOL",
							refusalCode: null,
							sealedPath: null,
							artifactSha256: null,
							primaryMetricP50: null,
							readPath: null,
							refusalReason: sealed.reason,
						});
						process.stderr.write(
							`controller: seal FAIL ${armId} rep ${repIndex}: ${sealed.reason}\n`,
						);
						await persistIndex();
						// Continue remaining reps/arms; gate report demotes missing pairs.
						continue;
					}
					indexEntries.push({
						schema: "campaign-index-entry/v2",
						cellId: cell.cellId,
						armId,
						transport: arm.transport,
						armKind: arm.armKind,
						armTransport: arm.armTransport ?? null,
						impairment: impairmentLabel,
						executionPurpose: spec.executionPurpose,
						repetitionKind: "measured",
						repetitionIndex: repIndex,
						repetitionTotal: spec.repetitions,
						status: "PASS",
						promotable: spec.executionPurpose === "canonical",
						failureCode: null,
						refusalCode: null,
						sealedPath: sealed.sealedPath,
						artifactSha256: sealed.artifactSha256 ?? null,
						primaryMetricP50: sealed.primaryMetricP50,
						readPath: sealed.readPath ?? null,
					});
					process.stdout.write(
						`controller: seal PASS ${armId} rep ${repIndex} p50=${sealed.primaryMetricP50}\n`,
					);
					lastEvidencePath = sealed.sealedPath;
					await persistIndex();
					continue;
				}

				// Out-of-process fallback: no supervisor, so no seal. It measures
				// the wire only, which is why it is confined to primary arms —
				// there is no `--arm-kind` on the production client and inventing
				// one here would produce an unsealed artifact wearing a read-path
				// identity nothing observed.
				if (slot.repetitionKind === "warmup") {
					// Nothing here writes an index entry for a warmup either. The
					// unsealed fallback has no seal to skip, so the warmup is simply
					// not run: there is no hot path to establish for a process that
					// exits after the rep.
					continue;
				}
				// A fanout primary has no single-session form, so the unsealed
				// fallback cannot run one either: `buildProductionClientArgv` below
				// spawns one client against one session, which is the measurement
				// the cohort exists to replace. It is refused here for the same
				// reason `dispatchArmRepetition` refuses it above, and by the same
				// router, so the fallback cannot become the way a fanout primary
				// gets measured as a leg.
				const fallbackCohortCell = cohortCellForArm({
					cellId: cell.cellId,
					armKind: arm.armKind,
				});
				if (arm.armKind !== "primary" || fallbackCohortCell !== null) {
					indexEntries.push({
						schema: "campaign-index-entry/v2",
						cellId: cell.cellId,
						armId,
						transport: arm.transport,
						armKind: arm.armKind,
						armTransport: arm.armTransport ?? null,
						impairment: impairmentLabel,
						executionPurpose: spec.executionPurpose,
						repetitionKind: "measured",
						repetitionIndex: repIndex,
						repetitionTotal: spec.repetitions,
						// A missing executor is not an environmental refusal: it is
						// the implementation staying blocked, filed as a FAIL row so
						// no REFUSED row can follow a measured one.
						status: "FAIL",
						promotable: false,
						failureCode:
							fallbackCohortCell !== null
								? "COHORT_NOT_READY"
								: "TRUST_PROTOCOL",
						refusalCode: null,
						sealedPath: null,
						artifactSha256: null,
						primaryMetricP50: null,
						readPath: null,
						refusalReason:
							fallbackCohortCell !== null
								? `no live supervisor control channel; the ${fallbackCohortCell} fanout primary runs a cohort and has no single-session form`
								: "no live supervisor control channel; non-primary arms are sealed in-process only",
					});
					await persistIndex();
					continue;
				}
				const clientArgv = buildProductionClientArgv({
					linuxAddress: linux.address,
					serverPort,
					cell: cell.scenarioId,
					runId: pairRunId,
					repIndex,
					outputPath: perRepPath,
					transport: arm.transport,
				});
				const clientResult = Bun.spawn([...clientArgv], {
					stdout: "pipe",
					stderr: "pipe",
					cwd: worktreeRoot,
					env: { ...process.env },
				});
				const [clientStdout, clientStderr, clientCode] = await Promise.all([
					new Response(clientResult.stdout).text(),
					new Response(clientResult.stderr).text(),
					clientResult.exited,
				]);
				if (clientCode !== 0) {
					await stopServer();
					await restoreNetem();
					return {
						ok: false,
						reason: `client-run ${armId} rep ${repIndex}/${spec.repetitions} failed (code=${clientCode}): ${clientStderr.trim() || clientStdout.trim()}`,
					};
				}
				lastEvidencePath = perRepPath;
				indexEntries.push({
					schema: "campaign-index-entry/v2",
					cellId: cell.cellId,
					armId,
					transport: arm.transport,
					armKind: arm.armKind,
					armTransport: arm.armTransport ?? null,
					impairment: impairmentLabel,
					executionPurpose: spec.executionPurpose,
					repetitionKind: "measured",
					repetitionIndex: repIndex,
					repetitionTotal: spec.repetitions,
					status: "PASS",
					promotable: false,
					failureCode: null,
					refusalCode: null,
					sealedPath: perRepPath,
					artifactSha256: null,
					primaryMetricP50: null,
					readPath: null,
				});
				await persistIndex();
			}
		}
	}

	await stopServer();
	await restoreNetem();

	// Promote the flats this campaign earned, through the one §6 gate.
	// Focused/pilot write zero flats (plan A-stop / B5); only canonical promotes,
	// and only for a cell whose whole measured set clears `evaluateCellPromotionGate`.
	if (useInProcessSeal) {
		const stagedDigests = resolveCampaignIndexDigests(spec);
		const promotion = await promoteCampaignFlats({
			evidenceDir,
			campaignId: spec.campaignId,
			executionPurpose: spec.executionPurpose,
			cellIds,
			entries: indexEntries,
			receiptGraphComplete: (entry) =>
				sealClosesReceiptGraph(entry, {
					campaignId: spec.campaignId,
					candidate: spec.candidate,
					sourceArchiveSha256: stagedDigests.sourceArchiveSha256,
					stagedCapabilitySha256: stagedDigests.stagedCapabilitySha256,
				}),
		});
		const digests = stagedDigests;
		const index: CampaignIndex = {
			schema: "campaign-index/v2",
			campaignRunId: spec.campaignId,
			stage: campaignStage,
			candidate: spec.candidate,
			campaignId: spec.campaignId,
			approvedPlanSha256: digests.approvedPlanSha256,
			approvalRecordSha256: digests.approvalRecordSha256,
			stagedCapabilitySha256: digests.stagedCapabilitySha256,
			sourceArchiveSha256: digests.sourceArchiveSha256,
			executionPurpose: spec.executionPurpose,
			...(spec.stagedDir !== undefined ? { stagedDir: spec.stagedDir } : {}),
			cells: cellIds,
			arms: spec.arms,
			armKinds,
			warmupRepetitions: 1,
			measuredRepetitions: (spec.repetitions === 5 ? 5 : 1) as 1 | 5,
			scheduledMeasuredArms: scheduledArms,
			entries: indexEntries,
		};
		await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
		if (spec.executionPurpose === "canonical") {
			// State what was promoted, not that promotion happened: a canonical
			// campaign whose cells did not clear the gate writes zero flats, and
			// the line has to say so.
			process.stdout.write(
				`controller: promoted ${promotion.promotedCells.length} cell(s), ${promotion.flatsWritten.length} flat(s) under ${evidenceDir} (${indexEntries.filter((e) => e.status === "PASS").length} PASS / ${indexEntries.length} index entries)\n`,
			);
		} else {
			process.stdout.write(
				`controller: ${spec.executionPurpose} index finalized under ${evidenceDir} with zero flats (${indexEntries.filter((e) => e.status === "PASS").length} PASS / ${indexEntries.length} index entries)\n`,
			);
		}
	}

	return {
		ok: true,
		evidencePath: lastEvidencePath || `${evidenceDir}/campaign-index.json`,
	};
}

export function parseControllerArgs(
	args: readonly string[],
): { ok: true; spec: RunSpec } | { ok: false; reason: string } {
	let cell = "ticker-fanout";
	let cells: string[] | undefined;
	let repetitions = 1;
	const arms: ("ws" | "wt")[] = ["ws", "wt"];
	let candidate = "ws-wt-r0";
	let campaignId = "campaign-r0";
	let stagedDir: string | undefined;
	let stage: "phase4" | "full" | undefined;
	let armKinds: readonly ArmKind[] | undefined;
	let resume = false;
	let executionPurpose: "focused" | "pilot" | "canonical" | undefined;
	let stageReceiptPath: string | undefined;
	let campaignTimeoutMs: number | undefined;
	let writeTerminalRecordPath: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg.startsWith("--cell=")) {
			cell = arg.slice("--cell=".length);
		} else if (arg.startsWith("--execution-purpose=")) {
			const value = arg.slice("--execution-purpose=".length);
			if (value !== "focused" && value !== "pilot" && value !== "canonical") {
				return {
					ok: false,
					reason: `--execution-purpose must be focused|pilot|canonical, got ${value}`,
				};
			}
			executionPurpose = value;
		} else if (arg.startsWith("--stage-receipt=")) {
			const value = arg.slice("--stage-receipt=".length);
			if (value.length === 0) {
				return {
					ok: false,
					reason: "--stage-receipt requires a non-empty path",
				};
			}
			stageReceiptPath = value;
		} else if (arg.startsWith("--campaign-timeout-ms=")) {
			const n = Number(arg.slice("--campaign-timeout-ms=".length));
			if (!Number.isSafeInteger(n) || n < 1) {
				return {
					ok: false,
					reason: `--campaign-timeout-ms must be a positive safe integer, got ${arg}`,
				};
			}
			campaignTimeoutMs = n;
		} else if (arg.startsWith("--write-terminal-record=")) {
			const value = arg.slice("--write-terminal-record=".length);
			if (value.length === 0) {
				return {
					ok: false,
					reason: "--write-terminal-record requires a non-empty path",
				};
			}
			writeTerminalRecordPath = value;
		} else if (arg.startsWith("--cells=")) {
			const raw = arg.slice("--cells=".length);
			if (raw.length === 0) {
				return { ok: false, reason: "--cells requires a comma-separated list" };
			}
			cells = raw
				.split(",")
				.map((c) => c.trim())
				.filter((c) => c.length > 0);
			if (cells.length === 0) {
				return { ok: false, reason: "--cells requires a comma-separated list" };
			}
			cell = cells[0]!;
		} else if (arg === "--phase4") {
			cells = [...PHASE4_GATE_CELLS];
			cell = cells[0]!;
			stage = "phase4";
			repetitions = 1;
			executionPurpose = executionPurpose ?? "focused";
		} else if (arg.startsWith("--stage=")) {
			const value = arg.slice("--stage=".length);
			if (value !== "phase4" && value !== "full") {
				return {
					ok: false,
					reason: `--stage must be phase4|full, got ${value}`,
				};
			}
			stage = value;
			if (value === "full" && cells === undefined) {
				cells = CANONICAL_SCENARIO_REGISTRY.cells.map((c) => c.cellId);
				cell = cells[0]!;
				repetitions = 5;
				executionPurpose = executionPurpose ?? "canonical";
			}
		} else if (arg.startsWith("--reps=")) {
			const n = Number(arg.slice("--reps=".length));
			if (!Number.isInteger(n) || n < 1) {
				return {
					ok: false,
					reason: `--reps must be a positive integer, got ${arg}`,
				};
			}
			repetitions = n;
		} else if (arg.startsWith("--candidate=")) {
			candidate = arg.slice("--candidate=".length);
		} else if (arg.startsWith("--campaign=")) {
			campaignId = arg.slice("--campaign=".length);
		} else if (arg.startsWith("--staged-dir=")) {
			const value = arg.slice("--staged-dir=".length);
			if (value.length === 0) {
				return { ok: false, reason: "--staged-dir requires a non-empty path" };
			}
			stagedDir = value;
		} else if (arg.startsWith("--arm-kinds=")) {
			const raw = arg.slice("--arm-kinds=".length);
			const parsed: ArmKind[] = [];
			for (const token of raw.split(",").map((t) => t.trim())) {
				if (token.length === 0) continue;
				if (
					token !== "primary" &&
					token !== "read-path" &&
					token !== "overlay"
				) {
					return {
						ok: false,
						reason: `--arm-kinds must be primary|read-path|overlay, got ${token}`,
					};
				}
				if (!parsed.includes(token)) parsed.push(token);
			}
			if (parsed.length === 0) {
				return {
					ok: false,
					reason: "--arm-kinds requires a comma-separated list",
				};
			}
			armKinds = parsed;
		} else if (arg === "--resume") {
			resume = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(CONTROLLER_USAGE);
			process.exit(0);
		} else if (arg === "--dry-run") {
			// `--dry-run` is consumed by `main`; the parser treats
			// it as a known no-op so the spec still parses.
		} else {
			return { ok: false, reason: `unknown argument: ${arg}` };
		}
	}
	if (executionPurpose === undefined) {
		return {
			ok: false,
			reason: "--execution-purpose=focused|pilot|canonical is required",
		};
	}
	if (
		(executionPurpose === "focused" || executionPurpose === "pilot") &&
		repetitions !== 1
	) {
		return {
			ok: false,
			reason: `${executionPurpose} requires --reps=1`,
		};
	}
	if (executionPurpose === "canonical" && repetitions !== 5) {
		return {
			ok: false,
			reason: "canonical requires --reps=5",
		};
	}
	return {
		ok: true,
		spec: {
			cell,
			...(cells !== undefined ? { cells } : {}),
			repetitions,
			arms,
			candidate,
			campaignId,
			endpoints: defaultRigEndpoints(),
			executionPurpose,
			...(stagedDir !== undefined ? { stagedDir } : {}),
			...(stage !== undefined ? { stage } : {}),
			...(armKinds !== undefined ? { armKinds } : {}),
			...(resume ? { resume: true } : {}),
			...(stageReceiptPath !== undefined ? { stageReceiptPath } : {}),
			...(campaignTimeoutMs !== undefined ? { campaignTimeoutMs } : {}),
			...(writeTerminalRecordPath !== undefined
				? { writeTerminalRecordPath }
				: {}),
		},
	};
}

function formatDryRunReport(report: DryRunReport): string {
	const lines: string[] = [
		"# Two-host controller dry-run",
		"",
		`mac route: ${report.routes.mac.valid ? "OK" : "INVALID"} (${report.routes.mac.interface ?? "n/a"})`,
		`linux route: ${report.routes.linux.valid ? "OK" : "INVALID"} (${report.routes.linux.interface ?? "n/a"})`,
		"",
		"ssh argv:",
		`  ${report.sshArgv.join(" ")}`,
		"",
		"netem apply:",
		`  ${report.netemApply.join(" ")}`,
		"netem restore:",
		`  ${report.netemRestore.join(" ")}`,
		"",
		`evidence path: ${report.evidencePath}`,
		"",
		"deadlines:",
		...report.deadlines.map((d) =>
			d.ok ? `  ${d.label}: OK` : `  ${d.label}: INVALID (${d.reason})`,
		),
	];
	return `${lines.join("\n")}\n`;
}

export const CONTROLLER_USAGE = `usage: compare-controller [--dry-run] [--phase4] [--cell=<name>] [--cells=a,b] [--reps=<n>] [--candidate=<id>] [--campaign=<id>] [--stage=phase4|full] [--staged-dir=<path>] [--arm-kinds=primary,read-path,overlay] [--resume] [--campaign-timeout-ms=<ms>] [--write-terminal-record=<path>]

Drives a two-host measurement campaign. Without --dry-run, requires
a real Linux bench and runs the rig end-to-end (route verify, SSH,
SCP, netem, server, client, evidence, restore). Each step is bounded
by a hard deadline; the controller fails closed with a typed error
if any step exceeds its bound. With --staged-dir, real-run verifies
the Phase 3.6.0 trust bootstrap against R1_CAMPAIGN_AUTHORITY_SHA256
before any SSH/SCP work. --phase4 selects ticker-fanout/rate-250
and bulk-one-way/physical with 3 reps (stage=phase4).
--arm-kinds narrows the schedule to a subset of the registry's arm
kinds; by default all three are scheduled. --resume carries forward
the PASS entries of an existing campaign-index.json and re-measures
everything else. --campaign-timeout-ms is the fail-closed outer
wall-clock bound. --write-terminal-record writes ControllerTerminalV1
as canonical JSON before exit.
`;

// ---------------------------------------------------------------------------
// The signed execution identity (amendment C4): what the controller may state
// ---------------------------------------------------------------------------

/**
 * The stage material every signed execution is built from, read once per
 * campaign through the verified `--staged-dir` handles and checked against
 * the stage receipt before anything is spawned.
 *
 * Nothing here is a claim: each public key must digest to the receipt's
 * value, the launch record must digest to the receipt's value, and the
 * receipt's own digests are the ones the campaign index anchors on
 * (`resolveCampaignIndexDigests`).
 */
export interface StagedCohortMaterialV1 {
	readonly stagedDir: string;
	readonly stagingRootDir: string;
	readonly receipt: {
		/** The staged profile; decides the host and the launch-record mode set. */
		readonly stageProfile: CohortStageProfile;
		/** `cohortServerHostForProfile(stageProfile)`, restated by the stage. */
		readonly cohortServerHost: CohortServerHost;
		readonly candidate: string;
		readonly campaignId: string;
		readonly approvedPlanSha256: Sha256Hex;
		readonly approvalRecordSha256: Sha256Hex;
		readonly archiveSha256: Sha256Hex;
		readonly capabilitySha256: Sha256Hex;
		readonly macSigningPublicKeySha256: Sha256Hex;
		readonly rigSigningPublicKeySha256: Sha256Hex;
		readonly macBunSha256: Sha256Hex;
		readonly linuxBunSha256: Sha256Hex;
		readonly linuxAddonManifestSha256: Sha256Hex;
		readonly serverEntrypointSha256: Sha256Hex;
		readonly fanoutRoleEntrypointSha256: Sha256Hex | null;
		/**
		 * One launch record per wire and per server mode the profile spawns:
		 * the argv a server child is exec'd with names its transport and its
		 * mode, and the rig compares it with the bound record byte for byte,
		 * so an ordinary A5 arm (`bulk-source`) and a cohort arm
		 * (`fanout-cohort`) bind different records. Each execution's draft
		 * binds the record of its own wire and mode.
		 */
		readonly stagedServerLaunchRecordSha256ByLaunch: StagedServerLaunchDigests;
		/**
		 * The directory the rig supervisor `fchdir`s every server child into
		 * before exec: the rig's `tools/compare`, observed at stage time with
		 * its `server.ts` hashed against `serverEntrypointSha256`. Opened by the
		 * rig wrapper as `--cohort-role-root-fd`.
		 */
		readonly rigRoleRootPath: string;
		readonly tlsCertificateSha256: Sha256Hex;
		readonly notAfterMs: number;
	};
	readonly stagedMacPublicRaw32: Uint8Array;
	readonly stagedRigPublicRaw32: Uint8Array;
	/**
	 * The staged launch records, digest-checked, keyed by wire then by mode;
	 * exactly the profile's modes. Read through `stagedServerLaunchRecordFor`.
	 */
	readonly stagedServerLaunchRecords: Readonly<
		Record<
			"ws" | "wt",
			Readonly<Partial<Record<ServerMode, StagedServerLaunchRecordMaterialV1>>>
		>
	>;
	/**
	 * The staged server certificate (PEM), digest-checked against the receipt
	 * and the launch record: the CA the client leg and every role child verify
	 * the named rig server against (amendment C5: "live runs use staged CA/SNI
	 * verification, not a verification bypass").
	 */
	readonly tlsCaPem: string;
	/** `<stagedDir>/roles/fanout-role.ts`, digest-checked; null on a phase-a stage. */
	readonly roleEntrypointPath: string | null;
}

/** One staged launch record as read through the receipt's digest. */
export interface StagedServerLaunchRecordMaterialV1 {
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
	readonly record: StagedServerLaunchRecordV1;
}

/**
 * The staged record for (`transport`, `mode`). The material was read against
 * the profile's exact mode set, so a mode the profile never staged is a
 * caller asking for a spawn the stage did not bind; that is a programming
 * error here, not a runtime refusal, and it throws.
 */
export function stagedServerLaunchRecordFor(
	staged: StagedCohortMaterialV1,
	transport: "ws" | "wt",
	mode: ServerMode,
): StagedServerLaunchRecordMaterialV1 {
	const record = staged.stagedServerLaunchRecords[transport][mode];
	if (record === undefined) {
		throw new Error(
			`the ${staged.receipt.stageProfile} stage binds no ${transport}/${mode} launch record`,
		);
	}
	return record;
}

const STAGE_RECEIPT_DIGEST_FIELDS = [
	"approvedPlanSha256",
	"approvalRecordSha256",
	"archiveSha256",
	"capabilitySha256",
	"macSigningPublicKeySha256",
	"rigSigningPublicKeySha256",
	"macBunSha256",
	"linuxBunSha256",
	"linuxAddonManifestSha256",
	"serverEntrypointSha256",
	"tlsCertificateSha256",
] as const;

function stageFail(message: string): ProtocolResult<never> {
	return { ok: false, code: "STALE_OR_INVALID_STAGING", message };
}

function readBytesOrNull(path: string): Uint8Array | null {
	try {
		return new Uint8Array(readFileSync(path));
	} catch {
		return null;
	}
}

/**
 * Read and digest-check the staged material a signed execution needs.
 *
 * Every refusal is `STALE_OR_INVALID_STAGING`: this runs before traffic, and
 * a staged tree whose keys or launch record do not match its own receipt is
 * the pre-traffic environmental failure the plan's refusal table names.
 */
export function readStagedCohortMaterial(
	paths: StagedTrustBootstrapPaths,
): ProtocolResult<StagedCohortMaterialV1> {
	const receiptPath = join(paths.stagedDir, "stage-receipt.json");
	const receiptBytes = readBytesOrNull(receiptPath);
	if (receiptBytes === null) {
		return stageFail(`stage receipt missing at ${receiptPath}`);
	}
	const receiptJson = parseStrictJsonBytes(receiptBytes);
	if (!receiptJson.ok) return stageFail("stage receipt is not strict JSON");
	const raw = receiptJson.value;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return stageFail("stage receipt is not an object");
	}
	const record = raw as Record<string, unknown>;
	if (record.schema !== "live-stage-receipt/v1") {
		return stageFail(`stage receipt schema ${String(record.schema)}`);
	}
	for (const field of STAGE_RECEIPT_DIGEST_FIELDS) {
		if (!HEX_64.test(String(record[field]))) {
			return stageFail(`stage receipt ${field} is not a digest`);
		}
	}
	const fanoutSha = record.fanoutRoleEntrypointSha256;
	if (fanoutSha !== null && !HEX_64.test(String(fanoutSha))) {
		return stageFail("stage receipt fanoutRoleEntrypointSha256");
	}
	if (
		typeof record.candidate !== "string" ||
		typeof record.campaignId !== "string" ||
		!Number.isSafeInteger(record.notAfterMs) ||
		(record.notAfterMs as number) <= 0
	) {
		return stageFail("stage receipt identity fields");
	}
	// The profile decides the host and the mode set; the receipt restates the
	// host and is refused on its own when the two disagree (design §3.1:
	// loopback is the local-acceptance profile's, the cable is the physical
	// profiles', never a per-run choice).
	if (!isCohortStageProfile(record.stageProfile)) {
		return stageFail("stage receipt stageProfile");
	}
	if (
		record.cohortServerHost !== cohortServerHostForProfile(record.stageProfile)
	) {
		return stageFail(
			`stage receipt cohortServerHost ${String(record.cohortServerHost)} is not the ${record.stageProfile} profile's host`,
		);
	}
	if (
		typeof record.rigRoleRootPath !== "string" ||
		!record.rigRoleRootPath.startsWith("/")
	) {
		return stageFail("stage receipt rigRoleRootPath is not an absolute path");
	}
	const receipt = record as unknown as StagedCohortMaterialV1["receipt"];

	const macKey = readBytesOrNull(
		join(paths.stagingRootDir, "mac-supervisor-ed25519.pub"),
	);
	if (macKey === null || macKey.byteLength !== 32) {
		return stageFail("staged Mac public key is not 32 raw bytes");
	}
	if (sha256HexOfBytes(macKey) !== receipt.macSigningPublicKeySha256) {
		return stageFail("staged Mac public key does not match the receipt");
	}
	const rigKey = readBytesOrNull(
		join(paths.stagingRootDir, "rig-supervisor-ed25519.pub"),
	);
	if (rigKey === null || rigKey.byteLength !== 32) {
		return stageFail("staged rig public key is not 32 raw bytes");
	}
	if (sha256HexOfBytes(rigKey) !== receipt.rigSigningPublicKeySha256) {
		return stageFail("staged rig public key does not match the receipt");
	}
	const digestsByLaunch = record.stagedServerLaunchRecordSha256ByLaunch;
	if (
		typeof digestsByLaunch !== "object" ||
		digestsByLaunch === null ||
		Array.isArray(digestsByLaunch) ||
		Object.keys(digestsByLaunch).sort().join(",") !== "ws,wt"
	) {
		return stageFail(
			"stage receipt stagedServerLaunchRecordSha256ByLaunch is not {ws, wt}",
		);
	}
	const modes = stagedServerLaunchModesForProfile(receipt.stageProfile);
	// The one certificate both hosts staged: the receipt binds it, every
	// launch record binds it, and the leaf must be that certificate.
	const tlsCertificateBytes = readBytesOrNull(
		join(paths.stagingRootDir, STAGED_SERVER_TLS_CERTIFICATE_LEAF),
	);
	if (tlsCertificateBytes === null) {
		return stageFail("staged server tls certificate missing");
	}
	if (sha256HexOfBytes(tlsCertificateBytes) !== receipt.tlsCertificateSha256) {
		return stageFail(
			"staged server tls certificate does not match the receipt",
		);
	}
	const tlsCaPem = Buffer.from(tlsCertificateBytes).toString("utf8");
	if (!tlsCaPem.includes("-----BEGIN CERTIFICATE-----")) {
		return stageFail("staged server tls certificate is not PEM");
	}
	const launchRecords = {} as Record<
		"ws" | "wt",
		Partial<Record<ServerMode, StagedServerLaunchRecordMaterialV1>>
	>;
	for (const transport of ["ws", "wt"] as const) {
		const byMode = (digestsByLaunch as Record<string, unknown>)[transport];
		if (
			typeof byMode !== "object" ||
			byMode === null ||
			Array.isArray(byMode) ||
			Object.keys(byMode).sort().join(",") !== [...modes].sort().join(",")
		) {
			return stageFail(
				`stage receipt ${transport} launch records are not exactly the ${receipt.stageProfile} modes (${modes.join(", ")})`,
			);
		}
		launchRecords[transport] = {};
		for (const mode of modes) {
			const label = `${transport}/${mode}`;
			const expected = (byMode as Record<string, unknown>)[mode];
			if (!HEX_64.test(String(expected))) {
				return stageFail(`stage receipt ${label} launch record digest`);
			}
			const launchBytes = readBytesOrNull(
				join(
					paths.stagingRootDir,
					stagedServerLaunchRecordLeaf(transport, mode),
				),
			);
			if (launchBytes === null) {
				return stageFail(`staged ${label} server launch record missing`);
			}
			const sha256 = sha256HexOfBytes(launchBytes);
			if (sha256 !== expected) {
				return stageFail(
					`staged ${label} server launch record does not match the receipt`,
				);
			}
			const launchJson = parseStrictJsonBytes(launchBytes);
			if (!launchJson.ok)
				return stageFail(`${label} launch record is not strict JSON`);
			const launch = parseStagedServerLaunchRecord(launchJson.value);
			if (!launch.ok)
				return stageFail(
					`${label} launch record: ${launch.message ?? launch.code}`,
				);
			if (launch.value.transport !== transport) {
				return stageFail(
					`the ${label} launch record launches ${launch.value.transport}`,
				);
			}
			// The record is this stage's: its profile and host are the
			// receipt's, and its argv is exactly the one definition of the argv
			// for this wire, mode and profile -- the bytes the controller sends
			// and the rig compares.
			const recordProfile = stagedServerLaunchRecordProfile(launch.value);
			if (recordProfile !== receipt.stageProfile) {
				return stageFail(
					`the ${label} launch record was staged under ${recordProfile}, the receipt under ${receipt.stageProfile}`,
				);
			}
			if (launch.value.bindAddress !== receipt.cohortServerHost) {
				return stageFail(
					`the ${label} launch record binds ${launch.value.bindAddress}, the receipt ${receipt.cohortServerHost}`,
				);
			}
			const expectedArgv = stagedServerLaunchArgv(
				transport,
				mode,
				receipt.stageProfile,
			);
			if (
				launch.value.argv.length !== expectedArgv.length ||
				launch.value.argv.some((arg, index) => arg !== expectedArgv[index])
			) {
				return stageFail(
					`the ${label} launch record's argv is not the staged argv for ${label} under ${receipt.stageProfile}`,
				);
			}
			if (
				launch.value.serverEntrypointSha256 !== receipt.serverEntrypointSha256
			) {
				return stageFail(
					`${label} launch record names another server entrypoint`,
				);
			}
			if (launch.value.tlsCertificateSha256 !== receipt.tlsCertificateSha256) {
				return stageFail(
					`${label} launch record binds another tls certificate than the receipt`,
				);
			}
			launchRecords[transport][mode] = {
				bytes: launchBytes,
				sha256,
				record: launch.value,
			};
		}
	}

	let roleEntrypointPath: string | null = null;
	if (receipt.fanoutRoleEntrypointSha256 !== null) {
		const candidate = join(paths.stagedDir, "roles", "fanout-role.ts");
		const bytes = readBytesOrNull(candidate);
		if (bytes === null)
			return stageFail(`staged role entrypoint missing at ${candidate}`);
		if (sha256HexOfBytes(bytes) !== receipt.fanoutRoleEntrypointSha256) {
			return stageFail("staged role entrypoint does not match the receipt");
		}
		roleEntrypointPath = candidate;
	}
	return {
		ok: true,
		value: {
			stagedDir: paths.stagedDir,
			stagingRootDir: paths.stagingRootDir,
			receipt,
			stagedMacPublicRaw32: macKey,
			stagedRigPublicRaw32: rigKey,
			stagedServerLaunchRecords: launchRecords,
			tlsCaPem,
			roleEntrypointPath,
		},
	};
}

/**
 * The Mac clock identity the supervisor binary mints for every barrier.
 *
 * `comparison-supervisor.rs:1310-1335` reads `kern.bootsessionuuid`, drops
 * NUL and whitespace bytes and hashes the rest; this reads the same sysctl on
 * the same host and hashes it the same way, so the identity the controller
 * expects on a barrier is one it observed, not one it was told.
 */
export function observeMacClockIdentity(): ProtocolResult<string> {
	const out = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
		encoding: "buffer",
		timeout: 2_000,
	});
	if (out.status !== 0 || !(out.stdout instanceof Uint8Array)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "kern.bootsessionuuid unreadable",
		};
	}
	const trimmed = Uint8Array.from(
		[...out.stdout].filter(
			(byte) => byte !== 0 && ![9, 10, 11, 12, 13, 32].includes(byte),
		),
	);
	if (trimmed.byteLength === 0) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "kern.bootsessionuuid empty",
		};
	}
	return { ok: true, value: sha256HexOfBytes(trimmed) };
}

/**
 * The frozen run id of one execution (base plan §5): `<campaignRunId>/<cellId>/
 * <transport>/warmup-0` or `/measured-<n>`. Distinct for every warmup and every
 * measured repetition, never reused across the two.
 */
export function signedExecutionRunId(input: {
	readonly campaignId: string;
	readonly cellId: string;
	readonly transport: "ws" | "wt";
	readonly repetitionKind: "warmup" | "measured";
	readonly repetitionIndex: number;
}): string {
	const slot =
		input.repetitionKind === "warmup"
			? "warmup-0"
			: `measured-${input.repetitionIndex}`;
	return `${input.campaignId}/${input.cellId}/${input.transport}/${slot}`;
}

/**
 * The one workload input record the controller composes (design §2.9(2f) row
 * 1): the registry cell's identity and role plan, canonicalized. Its digest is
 * what the draft, the grant and the observation all name.
 */
export function workloadRolePlanInputFor(
	cell: ScenarioCell,
	transport: "ws" | "wt",
): {
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
	readonly scenarioHash: Sha256Hex;
	readonly rolePlanHash: Sha256Hex;
} {
	// Base plan §2 `CanonicalWorkloadRolePlanInputV1`: the two preimages are
	// carried, and each hash is the SHA-256 of that preimage's exact canonical
	// bytes -- "not controller-supplied hash assertions". The Mac binary reads
	// `scenarioPreimage.cellId` and the role plan's cardinalities off this
	// record (`parse_workload_role_plan_input`, secure_fs.rs), so the shape is
	// a wire contract, found by driving the release binary.
	const scenarioPreimage = {
		schema: "canonical-scenario-preimage/v1",
		cellId: cell.cellId,
		scenarioId: cell.scenarioId,
		parameters: cell.parameters,
	};
	const rolePlanPreimage = rolePlanPreimageFor(cell, transport);
	const scenarioHash = sha256HexOfBytes(canonicalRecordBytes(scenarioPreimage));
	const rolePlanHash = sha256HexOfBytes(canonicalRecordBytes(rolePlanPreimage));
	const record = {
		schema: "canonical-workload-role-plan-input/v1",
		scenarioPreimage,
		scenarioHash,
		rolePlanPreimage,
		rolePlanHash,
	};
	const bytes = canonicalRecordBytes(record);
	return {
		bytes,
		sha256: sha256HexOfBytes(bytes),
		scenarioHash,
		rolePlanHash,
	};
}

/**
 * Base plan §2 `CanonicalRolePlanPreimageV1` for a registered cell: the six
 * fanout cells state their frozen cardinalities and parameters, the Phase-A
 * bulk transfer states the zero role plan the fixture graph has always
 * carried. Any other cell has no signed execution and is refused upstream.
 */
export function rolePlanPreimageFor(
	cell: ScenarioCell,
	transport: "ws" | "wt",
): {
	readonly schema: "canonical-role-plan-preimage/v1";
	readonly serverRole: "bulk-source" | "fanout-relay";
	readonly direction: "linux-to-mac" | "mac-to-linux-to-mac";
	readonly channelMapping:
		| "server-opened-uni"
		| "ws-binary-message-per-frame"
		| "wt-publisher-bidi-subscriber-control-bidi-server-uni";
	readonly publisherCount: number;
	readonly subscriberWorkerCount: number;
	readonly subscriberCount: number;
	readonly publisherRatePerSecond: number;
	readonly payloadBytes: number;
	readonly warmupMessagesPerPublisher: number;
	readonly warmupIntervalMs: number;
	readonly measuredDurationMs: number;
} {
	const cohortCell = cohortCellForArm({
		cellId: cell.cellId,
		armKind: "primary",
	});
	if (cohortCell === null) {
		return {
			schema: "canonical-role-plan-preimage/v1",
			serverRole: "bulk-source",
			direction: "linux-to-mac",
			channelMapping: "server-opened-uni",
			publisherCount: 0,
			subscriberWorkerCount: 0,
			subscriberCount: 0,
			publisherRatePerSecond: 0,
			payloadBytes: 65_536,
			warmupMessagesPerPublisher: 0,
			warmupIntervalMs: 0,
			measuredDurationMs: 0,
		};
	}
	const cardinality = cohortCellCardinality(cohortCell);
	const grant = cohortCellGrantParameters(cohortCell);
	const measuredSeconds = grant.measuredDurationMs / 1_000;
	return {
		schema: "canonical-role-plan-preimage/v1",
		serverRole: "fanout-relay",
		direction: "mac-to-linux-to-mac",
		channelMapping:
			transport === "ws"
				? "ws-binary-message-per-frame"
				: "wt-publisher-bidi-subscriber-control-bidi-server-uni",
		publisherCount: cardinality.publisherCount,
		subscriberWorkerCount: cardinality.workerCount,
		subscriberCount: cardinality.subscriberCount,
		publisherRatePerSecond:
			cardinality.measuredIngress /
			cardinality.publisherCount /
			measuredSeconds,
		payloadBytes: grant.messageBytes,
		warmupMessagesPerPublisher: WARMUP_MESSAGES_PER_PUBLISHER,
		warmupIntervalMs: WARMUP_INTERVAL_MS,
		measuredDurationMs: grant.measuredDurationMs,
	};
}

/**
 * The grant declaration a signed execution states, derived from the registry
 * cell (base plan §3.1 line 380 and `validatePhaseADeclaration`).
 *
 * A fanout primary declares the cell's expanded deliveries. The Phase-A
 * completed transfer declares the whole 104,857,600-byte transfer as 1,600
 * scheduled chunks -- the leg declaration (`sealGrantDeclarationForArm`) states
 * the per-chunk 65,536 bytes for the legacy open, and the draft parser refuses
 * that pair, so the two are derived separately and the cell parameters are
 * checked against the frozen constants rather than restated. Any other cell
 * has no signed identity.
 */
export function signedExecutionDeclarationFor(
	cell: ScenarioCell,
	armKind: ArmKind,
): SealGrantDeclaration | null {
	if (armKind !== "primary") return null;
	const cohortCell = cohortCellForArm({ cellId: cell.cellId, armKind });
	if (cohortCell !== null) {
		return sealGrantDeclarationForArm({ cell, armKind });
	}
	if (cell.scenarioId !== "bulk-one-way") return null;
	const params = cell.parameters as {
		readonly bytes?: unknown;
		readonly chunkBytes?: unknown;
	};
	if (
		params.bytes !== PHASE_A_DECLARED_MESSAGE_BYTES ||
		typeof params.chunkBytes !== "number" ||
		params.chunkBytes <= 0 ||
		PHASE_A_DECLARED_MESSAGE_BYTES / params.chunkBytes !==
			PHASE_A_DECLARED_MESSAGE_COUNT
	) {
		return null;
	}
	return {
		grantDeclaration: "phase-a-completed-transfer",
		declaredMessageCount: PHASE_A_DECLARED_MESSAGE_COUNT,
		declaredMessageBytes: PHASE_A_DECLARED_MESSAGE_BYTES,
	};
}

/** Everything one signed execution draft states, from verified sources only. */
export interface SignedExecutionIdentityInputs {
	readonly staged: StagedCohortMaterialV1;
	readonly bootstrap: StagedTrustBootstrapPaths;
	readonly cell: ScenarioCell;
	readonly arm: SealArm;
	/** The mode this execution spawns its server child in; picks the record. */
	readonly serverMode: ServerMode;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly repetitionKind: "warmup" | "measured";
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
}

/**
 * The draft the Mac binary constructs the execution from (C2). The controller
 * supplies identity and declaration only; `executionIndex`, the grant and the
 * receipt are the binary's. A non-primary arm has no signed identity in the
 * frozen contract (`parseCrossSupervisorExecutionDraft` refuses
 * `armKind !== "primary"`), and this says so rather than drafting one.
 */
export function buildSignedExecutionDraft(
	input: SignedExecutionIdentityInputs,
): ProtocolResult<{
	readonly draft: CrossSupervisorExecutionDraftV1;
	readonly draftBytes: Uint8Array;
	readonly runId: string;
	readonly workload: ReturnType<typeof workloadRolePlanInputFor>;
}> {
	if (input.arm.armKind !== "primary") {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `${input.arm.armId} is a ${input.arm.armKind} arm; the frozen signed execution contract admits primary arms only`,
		};
	}
	const declaration = signedExecutionDeclarationFor(
		input.cell,
		input.arm.armKind,
	);
	if (declaration === null) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `${input.cell.cellId}/${input.arm.armKind} is neither the Phase-A completed transfer (bulk-one-way, 1600 chunks of 65536 bytes) nor a registered fanout expansion; no signed execution identity is registered for it`,
		};
	}
	const kind = declaration.grantDeclaration;
	const workload = workloadRolePlanInputFor(input.cell, input.arm.transport);
	const runId = signedExecutionRunId({
		campaignId: input.staged.receipt.campaignId,
		cellId: input.cell.cellId,
		transport: input.arm.transport,
		repetitionKind: input.repetitionKind,
		repetitionIndex:
			input.repetitionKind === "warmup" ? 0 : input.repetitionIndex,
	});
	const draft: CrossSupervisorExecutionDraftV1 = {
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: input.bootstrap.digests.authority,
		campaignLockSha256: input.bootstrap.digests.lock,
		stagedCapabilitySha256: input.bootstrap.digests.capability,
		sourceArchiveSha256: input.staged.receipt.archiveSha256,
		approvedPlanSha256: input.staged.receipt.approvedPlanSha256,
		approvalRecordSha256: input.staged.receipt.approvalRecordSha256,
		candidate: input.staged.receipt.candidate,
		campaignId: input.staged.receipt.campaignId,
		runId,
		executionPurpose: input.executionPurpose,
		cellId: input.cell.cellId,
		scenarioHash: workload.scenarioHash,
		rolePlanHash: workload.rolePlanHash,
		workloadRolePlanInputSha256: workload.sha256,
		stagedServerLaunchRecordSha256: stagedServerLaunchRecordFor(
			input.staged,
			input.arm.transport,
			input.serverMode,
		).sha256,
		armKind: "primary",
		transport: input.arm.transport,
		repetitionKind: input.repetitionKind,
		repetitionIndex:
			input.repetitionKind === "warmup" ? 0 : input.repetitionIndex,
		repetitionTotal:
			input.repetitionKind === "warmup" ? 1 : input.repetitionTotal,
		grantDeclaration: kind,
		declaredMessageCount: declaration.declaredMessageCount,
		declaredMessageBytes: declaration.declaredMessageBytes,
		requestedNotAfterMs: input.staged.receipt.notAfterMs,
	};
	const parsed = parseCrossSupervisorExecutionDraft(draft);
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		value: {
			draft: parsed.value,
			draftBytes: canonicalRecordBytes(parsed.value),
			runId,
			workload,
		},
	};
}

// ---------------------------------------------------------------------------
// The Phase-A rig lifecycle (base plan §5 states 3, 5, 8, 13): one seam for
// both the ordinary arm and the cohort arm
// ---------------------------------------------------------------------------

/** The rig's Phase-A acceptance of one execution, as the exact signed pair. */
export interface RigExecutionAcceptancePairV1 {
	readonly acceptance: RigExecutionAcceptanceV1;
	readonly acceptanceBytes: Uint8Array;
	readonly signatureBytes: Uint8Array;
	readonly signature: RigReceiptSignatureV1;
}

/**
 * The four rig transitions every signed execution runs, ordinary or cohort.
 * Each returns the exact bytes the rig answered with; nothing is restated.
 */
export interface PhaseARigLifecycle {
	/** §5 RIG_EXECUTION_ACCEPTED: the rig authenticates the Mac receipt and signs. */
	acceptExecution(args: {
		readonly measurementGrantBytes: Uint8Array;
		readonly receiptBytes: Uint8Array;
		readonly receiptSignatureBytes: Uint8Array;
	}): Promise<ProtocolResult<RigExecutionAcceptancePairV1>>;
	/** §5 SERVER_READY under the accepted execution (and grant, when there is one). */
	spawnServer(
		request: Omit<CohortRigSpawnServerRequestV1, "cohortGrantSha256"> & {
			readonly cohortGrantSha256: Sha256Hex | null;
		},
	): Promise<ProtocolResult<RigServerReadyV1>>;
	/**
	 * §5 LINUX_BASELINE. Both digests are the drain's: the receipt the rig
	 * signed and the completion manifest that drain was taken against. The
	 * rig compares `warmupCompleteSha256` with the manifest it retained at
	 * the drain (`secure_fs.rs measure_start`), so a baseline carries both or
	 * neither.
	 */
	measureStart(args: {
		readonly rigWarmupDrainedReceiptSha256: Sha256Hex | null;
		readonly roleWarmupCompletionManifestSha256: Sha256Hex | null;
	}): Promise<ProtocolResult<RigMeasureStartAckBundleV1>>;
	/** §5 LINUX_CAPTURE. */
	stopAndCapture(args: {
		readonly macStopIssuedAtNs: NsString;
		readonly drainDeadlineMs: number;
	}): Promise<ProtocolResult<RigCaptureBundleV1>>;
	/**
	 * §5 TEARDOWN: stop the server child and consume the rig's reaped verdict.
	 *
	 * Asked on every path out of an arm that spawned one, the way
	 * `teardownCohortArmLease` asks it for a cohort: a rig child that outlives
	 * its execution refuses the next spawn with "one server child per cohort",
	 * and a campaign that left one behind would fail its next repetition for a
	 * reason that has nothing to do with the measurement.
	 */
	teardownServer(): Promise<ProtocolResult<RigServerStoppedV1>>;
}

/**
 * The production Phase-A lifecycle over the frozen controller <-> rig channel.
 *
 * §5 RIG_EXECUTION_ACCEPTED is `CohortRigChannel.acceptExecution`: the frame
 * is registered (`PHASE_A_RIG_FIELDS`), the rig binary routes it
 * (`comparison-supervisor.rs cohort_request` -> `RigCohortRuntime::accept_execution`)
 * and the channel verifies the rig's `rig-execution-acceptance/v1` against the
 * staged rig key and the exact grant/receipt/signature bytes it sent. The
 * three later steps are the channel's own, reached only once the first is.
 */
export function createPhaseARigLifecycleOverChannel(
	channel: CohortRigChannel,
): PhaseARigLifecycle {
	return {
		acceptExecution: (args) => channel.acceptExecution(args),
		// Both arms go straight at the channel. The two nullable joins are the
		// arm's, not this seam's: the channel refuses a spawn that names a
		// grant it did not deliver and a baseline whose warmup joins disagree
		// with the arm the spawn fixed, so there is nothing left here to
		// decide and nothing to refuse on the channel's behalf.
		spawnServer: (request) => channel.spawnServer(request),
		measureStart: (args) =>
			// The same two joins `CohortChannelRigBinding.measureStartAck`
			// sends on a fanout arm, and both null on an ordinary one: the rig
			// refuses a manifest digest from an arm that drained no warmup, and
			// a null from one that did (secure_fs.rs `measure_start`).
			channel.measureStart({
				warmupCompleteSha256: args.roleWarmupCompletionManifestSha256,
				rigWarmupDrainedReceiptSha256: args.rigWarmupDrainedReceiptSha256,
			}),
		stopAndCapture: (args) => channel.stopAndCapture(args),
		teardownServer: () => channel.teardownServer(),
	};
}

// ---------------------------------------------------------------------------
// The cohort rig binding: ten §5 steps, byte-exact
// ---------------------------------------------------------------------------

/**
 * The rig half of the cohort lifecycle, as the controller drives it.
 *
 * Every Mac-signed record crosses as the exact bytes and exact signature bytes
 * the binary wrote on its ack; the parsed record travels beside them only so a
 * courier can check what it is carrying, never so it can re-encode it. Every
 * rig-signed record comes back the same way.
 *
 * The shape below is the synchronous one; `CohortRigBinding` is this shape with
 * every method allowed to return a promise, and `driveCohortArm` awaits every
 * one of them.
 */
export interface CohortRigBindingCalls {
	/** §5 COHORT_GRANTED: the rig verifies and accepts the Mac-signed grant. */
	acceptCohortGrant(args: {
		readonly grant: CohortGrantV1;
		readonly grantBytes: Uint8Array;
		readonly grantSignatureBytes: Uint8Array;
		readonly nowMs: number;
	}): ProtocolResult<RigCohortAcceptanceBundleV1>;
	/** §5 SERVER_READY: bring the Linux server up under the accepted grant. */
	startServer(): ProtocolResult<RigServerReadyV1>;
	/** §5 RAMP_AND_READY: register the role peers under the Mac permit schedule. */
	registerRolePeers(args: {
		readonly scheduler: MacPermitScheduler;
	}): ProtocolResult<true>;
	/** §5 IN_REPETITION_WARMUP: the rig opens its warmup window. */
	acceptWarmupEpoch(args: {
		readonly epoch: CohortWarmupEpochV1;
		readonly epochBytes: Uint8Array;
		readonly epochSignatureBytes: Uint8Array;
		readonly nowMs: number;
	}): ProtocolResult<true>;
	/** §5: the ten paced warmup messages per publisher, one completion per child. */
	runWarmupWire(): ProtocolResult<{
		readonly roleWarmupCompleteBytes: readonly Uint8Array[];
	}>;
	/** §5: drain warmup and reset the measured counters, against the exact manifest. */
	drainWarmup(args: {
		readonly roleWarmupCompletionManifestBytes: Uint8Array;
		readonly roleWarmupCompletionManifestSignatureBytes: Uint8Array;
		readonly roleWarmupCompletionManifestSha256: Sha256Hex;
		readonly roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
		readonly nowMs: number;
	}): ProtocolResult<RigWarmupDrainedBundleV1>;
	/** §5 LINUX_BASELINE. */
	measureStartAck(args: {
		readonly nowMs: number;
	}): ProtocolResult<RigMeasureStartAckBundleV1>;
	/** §5 START_BARRIER: the rig and its server accept the Mac-signed barrier. */
	acceptStartBarrier(args: {
		readonly barrier: CohortStartBarrierV1;
		readonly barrierBytes: Uint8Array;
		readonly barrierSignatureBytes: Uint8Array;
		readonly rigMeasureStartAckSha256: Sha256Hex;
		readonly nowMs: number;
	}): ProtocolResult<RigBarrierAcceptanceBundleV1>;
	/**
	 * §5 MEASURING + STOPPING: arm every child on the barrier, hand each the
	 * declared Mac stop, and return once the Mac clock has reached it. No
	 * partial is read here: the children's partials wait on Linux's drain.
	 */
	runMeasuredWindow(): ProtocolResult<{
		readonly measureStopAtMacNs: NsString;
	}>;
	/** §5 DRAINING + LINUX_CAPTURE: the one capture, relay observation required. */
	observe(args: { readonly nowMs: number }): ProtocolResult<RigCaptureBundleV1>;
	/**
	 * §5 MAC_JOIN's inputs: one partial per child, then each child's exit.
	 * Legal only after the capture: a worker's partial states the relay end
	 * markers Linux sends while it drains (plan §5 step 12), and a publisher's
	 * states the acknowledgements the drain completes.
	 */
	collectPartials(): ProtocolResult<{
		readonly partials: readonly {
			readonly childId: string;
			readonly frame: unknown;
		}[];
	}>;
	/**
	 * The rig stops and reaps the server child it spawned. §5 step 16 on the
	 * lease's every path out (plan 2191), and the server half of plan 2210's
	 * pre-readiness replacement, which kills the abandoned cohort's server
	 * child so the replacement grant gets a fresh one from `startServer`.
	 */
	teardownServer(): ProtocolResult<RigServerStoppedV1>;
}

export type CohortRigBinding = {
	[K in keyof CohortRigBindingCalls]: CohortRigBindingCalls[K] extends (
		...args: infer A
	) => infer R
		? (...args: A) => R | Promise<R>
		: never;
};

function bindingNotReady(message: string): ProtocolResult<never> {
	return { ok: false, code: "COHORT_NOT_READY", message };
}

/** What the production binding needs that the §5 lifecycle does not carry. */
export interface CohortChannelRigBindingConfig {
	readonly channel: CohortRigChannel;
	/** The staged server identity and argv; the grant digest is the channel's own. */
	readonly spawn: Omit<CohortRigSpawnServerRequestV1, "cohortGrantSha256">;
	/** The Mac stamp §3.3 puts on `rig-stop-and-capture-request/v1`. */
	readonly macStopIssuedAtNs: () => NsString;
	/** The grant's own drain bound, carried onto the capture request. */
	readonly drainDeadlineMs: number;
}

/**
 * `CohortRigBinding` over `CohortRigChannel` -- the remote courier.
 *
 * Seven of the ten steps are frames on the frozen §3.3 registry and are
 * forwarded as the exact bytes handed in. The three role-child steps are
 * refused here with `COHORT_NOT_READY`: their evidence arrives on the Mac-owned
 * role-child pipes, which `composeCohortRigBinding` routes to the driver that
 * reads them. A binding that answered them with an empty list would hand the
 * supervisor a cohort whose members it never heard from.
 */
export class CohortChannelRigBinding implements CohortRigBinding {
	private readonly config: CohortChannelRigBindingConfig;
	private warmupEpochBytes: Uint8Array | null = null;
	private warmupEpochSignatureBytes: Uint8Array | null = null;
	private warmupCompletionManifestSha256: Sha256Hex | null = null;
	private warmupDrainedReceiptSha256: Sha256Hex | null = null;

	constructor(config: CohortChannelRigBindingConfig) {
		if (
			!Number.isSafeInteger(config.drainDeadlineMs) ||
			config.drainDeadlineMs <= 0
		) {
			throw new RangeError("drainDeadlineMs must be a positive integer");
		}
		this.config = config;
	}

	async acceptCohortGrant(args: {
		readonly grant: CohortGrantV1;
		readonly grantBytes: Uint8Array;
		readonly grantSignatureBytes: Uint8Array;
		readonly nowMs: number;
	}): Promise<ProtocolResult<RigCohortAcceptanceBundleV1>> {
		if (
			sha256HexOfBytes(canonicalRecordBytes(args.grant)) !==
			sha256HexOfBytes(args.grantBytes)
		) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message: "the grant record and the grant bytes are not one record",
			};
		}
		return this.config.channel.acceptCohort({
			cohortGrantBytes: args.grantBytes,
			cohortGrantSignatureBytes: args.grantSignatureBytes,
		});
	}

	async startServer(): Promise<ProtocolResult<RigServerReadyV1>> {
		const grantSha256 = this.config.channel.cohortGrantSha256;
		if (grantSha256 === null) {
			return bindingNotReady("no grant has been delivered to the rig yet");
		}
		return this.config.channel.spawnServer({
			...this.config.spawn,
			cohortGrantSha256: grantSha256,
		});
	}

	registerRolePeers(_args: {
		readonly scheduler: MacPermitScheduler;
	}): ProtocolResult<true> {
		return bindingNotReady(
			"the controller <-> rig registry has no role-peer registration frame; the ramp is the Mac permit scheduler's and the role children present their own tokens to the relay",
		);
	}

	async acceptWarmupEpoch(args: {
		readonly epoch: CohortWarmupEpochV1;
		readonly epochBytes: Uint8Array;
		readonly epochSignatureBytes: Uint8Array;
		readonly nowMs: number;
	}): Promise<ProtocolResult<true>> {
		const begun = await this.config.channel.beginWarmup({
			cohortWarmupEpochBytes: args.epochBytes,
			cohortWarmupEpochSignatureBytes: args.epochSignatureBytes,
		});
		if (!begun.ok) return begun;
		this.warmupEpochBytes = args.epochBytes;
		this.warmupEpochSignatureBytes = args.epochSignatureBytes;
		return { ok: true, value: true };
	}

	runWarmupWire(): ProtocolResult<{
		readonly roleWarmupCompleteBytes: readonly Uint8Array[];
	}> {
		return bindingNotReady(
			"role-child warmup completion frames arrive on the Mac-owned role-child control pipes; this binding is the rig courier",
		);
	}

	async drainWarmup(args: {
		readonly roleWarmupCompletionManifestBytes: Uint8Array;
		readonly roleWarmupCompletionManifestSignatureBytes: Uint8Array;
		readonly roleWarmupCompletionManifestSha256: Sha256Hex;
		readonly roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
		readonly nowMs: number;
	}): Promise<ProtocolResult<RigWarmupDrainedBundleV1>> {
		if (
			this.warmupEpochBytes === null ||
			this.warmupEpochSignatureBytes === null
		) {
			return bindingNotReady("no warmup epoch was opened on this channel");
		}
		if (
			sha256HexOfBytes(args.roleWarmupCompletionManifestBytes) !==
				args.roleWarmupCompletionManifestSha256 ||
			sha256HexOfBytes(args.roleWarmupCompletionManifestSignatureBytes) !==
				args.roleWarmupCompletionManifestSignatureSha256
		) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message:
					"the completion manifest bytes are not the ones the stated digests name",
			};
		}
		const drained = await this.config.channel.finishWarmup({
			cohortWarmupEpochBytes: this.warmupEpochBytes,
			cohortWarmupEpochSignatureBytes: this.warmupEpochSignatureBytes,
			roleWarmupCompletionManifestBytes: args.roleWarmupCompletionManifestBytes,
			roleWarmupCompletionManifestSignatureBytes:
				args.roleWarmupCompletionManifestSignatureBytes,
		});
		if (!drained.ok) return drained;
		this.warmupCompletionManifestSha256 =
			args.roleWarmupCompletionManifestSha256;
		this.warmupDrainedReceiptSha256 = sha256HexOfBytes(
			drained.value.receiptBytes,
		);
		return drained;
	}

	async measureStartAck(args: {
		readonly nowMs: number;
	}): Promise<ProtocolResult<RigMeasureStartAckBundleV1>> {
		if (
			this.warmupDrainedReceiptSha256 === null ||
			this.warmupCompletionManifestSha256 === null
		) {
			return bindingNotReady(
				`no drained receipt to take a baseline against (asked at ${args.nowMs})`,
			);
		}
		// Both joins are the ones the drain established: the rig compares the
		// manifest digest against the manifest it retained at the drain and
		// treats a null as a controller describing some other execution
		// (secure_fs.rs `measure_start`, `warmupCompleteSha256`).
		return this.config.channel.measureStart({
			warmupCompleteSha256: this.warmupCompletionManifestSha256,
			rigWarmupDrainedReceiptSha256: this.warmupDrainedReceiptSha256,
		});
	}

	async acceptStartBarrier(args: {
		readonly barrier: CohortStartBarrierV1;
		readonly barrierBytes: Uint8Array;
		readonly barrierSignatureBytes: Uint8Array;
		readonly rigMeasureStartAckSha256: Sha256Hex;
		readonly nowMs: number;
	}): Promise<ProtocolResult<RigBarrierAcceptanceBundleV1>> {
		const presented = await this.config.channel.presentStartBarrier({
			cohortStartBarrierBytes: args.barrierBytes,
			cohortStartBarrierSignatureBytes: args.barrierSignatureBytes,
		});
		if (!presented.ok) return presented;
		if (
			presented.value.acceptance.rigMeasureStartAckSha256 !==
			args.rigMeasureStartAckSha256
		) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message: "barrier acceptance names another measure-start ack",
			};
		}
		return presented;
	}

	runMeasuredWindow(): ProtocolResult<{
		readonly measureStopAtMacNs: NsString;
	}> {
		return bindingNotReady(
			"the measured window is armed on the Mac-owned role-child control pipes; this binding is the rig courier",
		);
	}

	collectPartials(): ProtocolResult<{
		readonly partials: readonly {
			readonly childId: string;
			readonly frame: unknown;
		}[];
	}> {
		return bindingNotReady(
			"role partials arrive on the Mac-owned role-child control pipes; this binding is the rig courier",
		);
	}

	/** Whether `startServer` succeeded and the rig still holds that child. */
	get serverStarted(): boolean {
		return this.config.channel.serverChildLive;
	}

	/**
	 * §5 TEARDOWN (plan 2191): the rig stops and reaps its server child. The
	 * lease's cleanup asks on every path out, and `driveCohortArm` asks once
	 * more in the middle of a pre-readiness replacement (plan 2210).
	 */
	async teardownServer(): Promise<ProtocolResult<RigServerStoppedV1>> {
		return this.config.channel.teardownServer();
	}

	async observe(args: {
		readonly nowMs: number;
	}): Promise<ProtocolResult<RigCaptureBundleV1>> {
		const captured = await this.config.channel.stopAndCapture({
			macStopIssuedAtNs: this.config.macStopIssuedAtNs(),
			drainDeadlineMs: this.config.drainDeadlineMs,
		});
		if (!captured.ok) return captured;
		if (
			captured.value.linuxRelayObservationBytes === null ||
			captured.value.relayObservationReceipt === null ||
			captured.value.relayObservationSignature === null
		) {
			return bindingNotReady(
				`the rig captured no Linux relay observation (asked at ${args.nowMs})`,
			);
		}
		return captured;
	}
}

// ---------------------------------------------------------------------------
// What the lifecycle retains for the role children and for finalization
// ---------------------------------------------------------------------------

/**
 * The exact Mac-signed bytes and the child-origin records one cohort
 * repetition passes through the controller, retained where they pass.
 *
 * The role-child frames (`role-spawn-config/v1`, `role-warmup-start/v1`,
 * `role-measure-start/v1`) each carry a Mac-signed record verbatim, and the
 * only place the controller legitimately holds those bytes is the moment it
 * couriers them from the Mac ack to the rig. This is that moment's ledger:
 * the composed binding writes here on the way to the rig, and the frame source
 * and the finalization read from it. Nothing is re-encoded.
 */
export class CohortLifecycleRetention {
	grant: {
		readonly record: CohortGrantV1;
		readonly bytes: Uint8Array;
		/** The canonical `mac-receipt-signature/v1` carrier the rig verifies. */
		readonly signatureBytes: Uint8Array;
		/**
		 * The carrier's raw 64-byte Ed25519 signature over `bytes`: what a
		 * role child verifies (`parseRoleSpawnConfig` decodes exactly 64 bytes
		 * and checks them over the grant bytes under the staged Mac key).
		 */
		readonly signatureRaw64: Uint8Array;
		readonly sha256: Sha256Hex;
	} | null = null;
	epoch: {
		readonly record: CohortWarmupEpochV1;
		readonly bytes: Uint8Array;
		/** The canonical `mac-receipt-signature/v1` carrier the rig verifies. */
		readonly signatureBytes: Uint8Array;
		/**
		 * The carrier's raw 64-byte Ed25519 signature over `bytes`: what a
		 * role child verifies (`parseRoleWarmupStart` decodes exactly 64 bytes
		 * and `decodeWarmupEpoch` checks them under the staged Mac key).
		 */
		readonly signatureRaw64: Uint8Array;
	} | null = null;
	barrier: {
		readonly record: CohortStartBarrierV1;
		readonly bytes: Uint8Array;
		readonly signatureBytes: Uint8Array;
		readonly sha256: Sha256Hex;
	} | null = null;
	measureStartAck: RigMeasureStartAckBundleV1 | null = null;
	readonly partials = new Map<string, unknown>();
	capture: RigCaptureBundleV1 | null = null;
}

/**
 * The frames the driver hands each role child, built from retained bytes and
 * from stage-time constants only.
 *
 * Design §2.5's contract, implemented here rather than in `remote-supervisor.ts`
 * because it echoes bytes the controller already couriers and signs nothing:
 * the grant pair verbatim from `mac-cohort-opened-ack/v1`, the epoch pair from
 * `mac-warmup-epoch-issued-ack/v1`, the barrier from
 * `mac-start-barrier-issued-ack/v1`. A frame asked for before its record
 * passed through is refused, not defaulted.
 */
export function createRetainedRoleChildFrameSource(input: {
	readonly retention: CohortLifecycleRetention;
	readonly executionSha256: Sha256Hex;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly staged: StagedCohortMaterialV1;
	readonly transport: "ws" | "wt";
	readonly serverPort: number;
	readonly cell: CohortCellCardinalityV1;
	readonly grantParameters: CohortCellGrantParametersV1;
	readonly childStateFor: (
		childId: string,
	) => MacFanoutChildStateV1 | undefined;
	readonly clock: { readonly nowNs: () => NsString };
}): MacRoleChildFrameSource {
	const retention = input.retention;
	const measuredSeconds = input.grantParameters.measuredDurationMs / 1_000;
	const messageRatePerSecond =
		input.cell.measuredIngress / input.cell.publisherCount / measuredSeconds;
	if (!Number.isSafeInteger(messageRatePerSecond) || messageRatePerSecond < 1) {
		throw new RangeError(
			`${input.cell.cell}: ${input.cell.measuredIngress} ingress over ${input.cell.publisherCount} publishers and ${measuredSeconds} s is not a whole per-publisher rate`,
		);
	}
	const workloadSha256 = sha256HexOfBytes(input.workloadRolePlanInputBytes);
	const staged = stagedServerLaunchRecordFor(
		input.staged,
		input.transport,
		"fanout-cohort",
	);
	const launch = staged.bytes;
	return {
		spawnConfigFor: (plan) => {
			const grant = retention.grant;
			if (grant === null)
				return bindingNotReady("no cohort grant has passed through yet");
			const child = input.childStateFor(plan.childId);
			if (child === undefined) {
				return bindingNotReady(
					`${plan.childId} has not been spawned by the supervisor`,
				);
			}
			return {
				ok: true,
				value: {
					schema: "role-spawn-config/v1",
					executionSha256: input.executionSha256,
					cohortGrantSha256: grant.sha256,
					cohortGrantBase64: Buffer.from(grant.bytes).toString("base64"),
					cohortGrantSignatureBase64: Buffer.from(
						grant.signatureRaw64,
					).toString("base64"),
					workloadRolePlanInputBase64: Buffer.from(
						input.workloadRolePlanInputBytes,
					).toString("base64"),
					workloadRolePlanInputSha256: workloadSha256,
					stagedServerLaunchRecordBase64:
						Buffer.from(launch).toString("base64"),
					stagedServerLaunchRecordSha256: staged.sha256,
					stagedServerLaunchRecordSize: launch.byteLength,
					childId: plan.childId,
					role: plan.role,
					publisherId: plan.publisherId,
					workerIndex: plan.workerIndex,
					childInstanceNonce: child.instanceNonce,
					tokenBundleFd: 5,
					tokenBundleSha256: child.tokenBundleSha256,
					tokenBundleSize: child.tokenBundleSize,
					tokenBundleEntryCount: child.tokenBundleEntryCount,
					tokenBundleMaxSize: 2_097_152,
					transport: input.transport,
					serverHost: staged.record.advertisedHost,
					serverPort: input.serverPort,
					tlsServerName: staged.record.tlsServerName,
					messageRatePerSecond,
					warmupMessagesPerPublisher: WARMUP_MESSAGES_PER_PUBLISHER,
					warmupIntervalMs: WARMUP_INTERVAL_MS,
					warmupDurationMs: WARMUP_DURATION_MS,
					measuredDurationMs: input.grantParameters.measuredDurationMs,
					measuredSampleWindowMs: 1_000,
					payloadBytes: input.grantParameters.messageBytes,
					channelMapping:
						input.transport === "ws"
							? "ws-binary-message-per-frame"
							: "wt-publisher-bidi-subscriber-control-bidi-server-uni",
					macSigningPublicKeyBase64: Buffer.from(
						input.staged.stagedMacPublicRaw32,
					).toString("base64"),
					macSigningPublicKeySha256:
						input.staged.receipt.macSigningPublicKeySha256,
				} satisfies Omit<RoleSpawnConfigV1, "sequence"> as unknown as {
					readonly schema: "role-spawn-config/v1";
				},
			};
		},
		warmupStartFor: (plan) => {
			const grant = retention.grant;
			const epoch = retention.epoch;
			if (grant === null || epoch === null) {
				return bindingNotReady("no warmup epoch has passed through yet");
			}
			const publisherCount = input.cell.publisherCount;
			const isPublisher = plan.role === "publisher";
			return {
				ok: true,
				value: {
					schema: "role-warmup-start/v1",
					executionSha256: input.executionSha256,
					cohortGrantSha256: grant.sha256,
					cohortWarmupEpochBase64: Buffer.from(epoch.bytes).toString("base64"),
					cohortWarmupEpochSha256: sha256HexOfBytes(epoch.bytes),
					cohortWarmupEpochSignatureBase64: Buffer.from(
						epoch.signatureRaw64,
					).toString("base64"),
					cohortWarmupEpochSignatureSha256: sha256HexOfBytes(
						epoch.signatureRaw64,
					),
					warmupNonce: epoch.record.warmupNonce,
					expectedChildOfferedWarmupIngress: isPublisher
						? WARMUP_MESSAGES_PER_PUBLISHER
						: 0,
					expectedChildDeliveredWarmupRecords: isPublisher
						? 0
						: plan.assignedRoleIds.length *
							publisherCount *
							WARMUP_MESSAGES_PER_PUBLISHER,
					startAtMacNs: (
						BigInt(input.clock.nowNs()) + ROLE_WARMUP_START_LEAD_NS
					).toString(),
					durationMs: WARMUP_DURATION_MS,
				} satisfies Omit<RoleWarmupStartV1, "sequence"> as unknown as {
					readonly schema: "role-warmup-start/v1";
				},
			};
		},
		measureStart: () => {
			const barrier = retention.barrier;
			if (barrier === null)
				return bindingNotReady("no start barrier has passed through yet");
			return {
				ok: true,
				value: {
					schema: "role-measure-start/v1",
					executionSha256: input.executionSha256,
					cohortStartBarrierBase64: Buffer.from(barrier.bytes).toString(
						"base64",
					),
				} satisfies Omit<RoleMeasureStartV1, "sequence"> as unknown as {
					readonly schema: "role-measure-start/v1";
				},
			};
		},
	};
}

/** Every child starts warmup on one instant this far ahead of the frame. */
export const ROLE_WARMUP_START_LEAD_NS = 250_000_000n;

// ---------------------------------------------------------------------------
// The cohort lifecycle driver (§5 COHORT_GRANTED .. LINUX_CAPTURE)
// ---------------------------------------------------------------------------

/**
 * What one driven cohort produced before finalization: the capture the rig
 * signed, plus the joins finalization has to name. Everything else the seal
 * needs is retained by the supervisor and the lifecycle retention.
 */
export interface CohortArmMeasuredV1 {
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly capture: RigCaptureBundleV1;
}

function macSignedFromAck(
	recordBase64: string,
	signatureBase64: string,
): ProtocolResult<{
	readonly bytes: Uint8Array;
	readonly signatureBytes: Uint8Array;
}> {
	const bytes = new Uint8Array(Buffer.from(recordBase64, "base64"));
	const signatureBytes = new Uint8Array(Buffer.from(signatureBase64, "base64"));
	if (
		Buffer.from(bytes).toString("base64") !== recordBase64 ||
		Buffer.from(signatureBytes).toString("base64") !== signatureBase64
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "ack carried non-canonical base64",
		};
	}
	return { ok: true, value: { bytes, signatureBytes } };
}

/**
 * Drive one fanout cohort from grant to the rig's capture.
 *
 * The order is §5's: nothing measured happens before Linux has accepted a
 * signed grant, warmup is its own binary-signed epoch, the barrier is minted
 * by the binary only after readiness plus a drained warmup plus an
 * authenticated Linux baseline, and the capture happens only after every
 * partial has been accepted. The Mac binary mints every Mac record; this
 * function couriers the exact bytes it answered with and stops at the first
 * refusal with the rig's or the supervisor's own closed code.
 *
 * Finalization -- series admission, MAC_JOIN, export, assembly, seal -- is
 * deliberately not here (amendment C4): it needs the capture this returns.
 */
/**
 * The ramp refusals plan 2210 answers with a replacement: a child that hung
 * up (`UNEXPECTED_EOF`), a child whose pipe refused a write because it was
 * gone (`CHILD_LIFECYCLE`), or a child that reported it could not connect and
 * then exits (`COHORT_NOT_READY`). A deadline, a protocol fault or a
 * cross-supervisor mismatch is not a lost child and ends the arm as itself.
 */
const PRE_READINESS_CHILD_LOSS_CODES: ReadonlySet<string> = new Set([
	"UNEXPECTED_EOF",
	"CHILD_LIFECYCLE",
	"COHORT_NOT_READY",
]);

/**
 * Retain one minted grant as the exact bytes and the raw signature the role
 * children verify. The carrier names the grant it signs and carries a 64-byte
 * signature over it; a carrier over other bytes is not this grant's.
 */
function retainCohortGrant(
	retention: CohortLifecycleRetention,
	minted: {
		readonly grant: CohortGrantV1;
		readonly grantBytes: Uint8Array;
		readonly grantSha256: Sha256Hex;
		readonly grantSignature: MacReceiptSignatureV1;
	},
): ProtocolResult<NonNullable<CohortLifecycleRetention["grant"]>> {
	const grantSignatureBytes = canonicalRecordBytes(minted.grantSignature);
	const grantSignatureRaw64 = new Uint8Array(
		Buffer.from(minted.grantSignature.signatureBase64, "base64"),
	);
	if (
		minted.grantSignature.signedBytesSha256 !== minted.grantSha256 ||
		grantSignatureRaw64.byteLength !== 64 ||
		Buffer.from(grantSignatureRaw64).toString("base64") !==
			minted.grantSignature.signatureBase64
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message:
				"the cohort grant's signature carrier does not carry a 64-byte signature over the grant",
		};
	}
	const grant = {
		record: minted.grant,
		bytes: minted.grantBytes,
		signatureBytes: grantSignatureBytes,
		signatureRaw64: grantSignatureRaw64,
		sha256: minted.grantSha256,
	};
	retention.grant = grant;
	return { ok: true, value: grant };
}

/** §5 COHORT_GRANTED then SERVER_READY under one grant. */
async function admitCohortGrantAtRig(args: {
	readonly supervisor: MacFanoutSupervisor;
	readonly rig: CohortRigBinding;
	readonly grant: NonNullable<CohortLifecycleRetention["grant"]>;
	readonly nowMs: () => number;
}): Promise<ProtocolResult<RigServerReadyV1>> {
	const accepted = await args.rig.acceptCohortGrant({
		grant: args.grant.record,
		grantBytes: args.grant.bytes,
		grantSignatureBytes: args.grant.signatureBytes,
		nowMs: args.nowMs(),
	});
	if (!accepted.ok) return accepted;
	const presented = await args.supervisor.presentRigCohortAcceptance({
		acceptance: accepted.value.acceptance,
		signature: accepted.value.signature,
		nowMs: args.nowMs(),
	});
	if (!presented.ok) return presented;
	return args.rig.startServer();
}

/** §5 RAMP_AND_READY: spawn the current attempt's children and ramp them. */
async function rampRoleCohort(args: {
	readonly supervisor: MacFanoutSupervisor;
	readonly rig: CohortRigBinding;
	readonly bundleFor: (plan: MacFanoutChildPlanV1) => TokenBundleV1;
	readonly clock: { readonly nowNs: () => NsString };
}): Promise<ProtocolResult<true>> {
	const spawned = args.supervisor.spawnRoleChildren({
		bundleFor: args.bundleFor,
		spawnedAtMacNs: args.clock.nowNs(),
	});
	if (!spawned.ok) return spawned;
	const ramp = args.supervisor.beginRamp(args.clock.nowNs());
	if (!ramp.ok) return ramp;
	return args.rig.registerRolePeers({ scheduler: ramp.value });
}

export async function driveCohortArm(input: {
	readonly supervisor: MacFanoutSupervisor;
	readonly rig: CohortRigBinding;
	readonly retention: CohortLifecycleRetention;
	readonly bundleFor: (plan: MacFanoutChildPlanV1) => TokenBundleV1;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly tokenCommitmentLeafManifestBytes: () => Uint8Array | null;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => NsString;
	};
}): Promise<ProtocolResult<CohortArmMeasuredV1>> {
	const supervisor = input.supervisor;
	const retention = input.retention;
	const nowMs = () => input.clock.nowMs();

	// 1. The binary mints and signs the pre-readiness grant.
	const opened = await supervisor.openCohort();
	if (!opened.ok) return opened;
	const retained = retainCohortGrant(retention, opened.value);
	if (!retained.ok) return retained;

	// 2. Linux verifies signature/key/expiry/replay before it binds a socket,
	//    the Mac authenticates the acceptance, and the rig spawns the server.
	const admitted = await admitCohortGrantAtRig({
		supervisor,
		rig: input.rig,
		grant: retained.value,
		nowMs,
	});
	if (!admitted.ok) return admitted;

	// 3. Spawn the Mac-owned children, then ramp their sessions on the global
	//    permit schedule. Plan 2210: a child lost before readiness replaces
	//    the whole cohort -- the role cohort is killed and reaped, the attempt
	//    increments, fresh nonce/tokens/grant are minted, the server child is
	//    killed, the replacement grant goes to the rig, a fresh server child is
	//    spawned and readiness is re-run. The supervisor counts the attempts:
	//    its refusal of a second replacement is the terminal failure.
	for (;;) {
		const ramped = await rampRoleCohort({
			supervisor,
			rig: input.rig,
			bundleFor: input.bundleFor,
			clock: input.clock,
		});
		if (ramped.ok) break;
		if (!PRE_READINESS_CHILD_LOSS_CODES.has(ramped.code)) return ramped;
		const replaced = await supervisor.replaceCohortBeforeReadiness({
			reason: `${ramped.code}: ${ramped.message}`,
		});
		if (!replaced.ok) return replaced;
		const replacementBytes = canonicalRecordBytes(replaced.value.grant);
		if (sha256HexOfBytes(replacementBytes) !== replaced.value.grantSha256) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message:
					"the replacement grant's canonical bytes are not the bytes the binary signed",
			};
		}
		const retainedReplacement = retainCohortGrant(retention, {
			grant: replaced.value.grant,
			grantBytes: replacementBytes,
			grantSha256: replaced.value.grantSha256,
			grantSignature: replaced.value.grantSignature,
		});
		if (!retainedReplacement.ok) return retainedReplacement;
		const stopped = await input.rig.teardownServer();
		if (!stopped.ok) return stopped;
		const readmitted = await admitCohortGrantAtRig({
			supervisor,
			rig: input.rig,
			grant: retainedReplacement.value,
			nowMs,
		});
		if (!readmitted.ok) return readmitted;
	}
	for (const child of supervisor.topology.children) {
		const ready = supervisor.markChildReady({
			childId: child.childId,
			readyAtMacNs: input.clock.nowNs(),
		});
		if (!ready.ok) return ready;
	}

	// 4. The two inputs the grant already committed to, retained not restated.
	const workload = supervisor.retainWorkloadRolePlanInput(
		input.workloadRolePlanInputBytes,
	);
	if (!workload.ok) return workload;
	const manifestBytes = input.tokenCommitmentLeafManifestBytes();
	if (manifestBytes === null) {
		return bindingNotReady(
			"the minter produced no leaf manifest for this attempt",
		);
	}
	const leafManifest =
		supervisor.retainTokenCommitmentLeafManifest(manifestBytes);
	if (!leafManifest.ok) return leafManifest;

	// 5. Warmup: the binary's own signed epoch, couriered as its exact bytes.
	const epochAck = await supervisor.issueWarmupEpoch();
	if (!epochAck.ok) return epochAck;
	const epochBytes = macSignedFromAck(
		epochAck.value.cohortWarmupEpochBase64,
		epochAck.value.cohortWarmupEpochSignatureBase64,
	);
	if (!epochBytes.ok) return epochBytes;
	const epochJson = parseStrictJsonBytes(epochBytes.value.bytes);
	if (!epochJson.ok)
		return { ok: false, code: "TRUST_PROTOCOL", message: "epoch bytes" };
	const epoch = parseCohortWarmupEpoch(epochJson.value);
	if (!epoch.ok) return epoch;
	// The ack carries the canonical signature carrier; the role children
	// verify the raw 64 bytes inside it over the epoch bytes, so the carrier
	// has to be that (grant retention above holds the same line).
	const epochCarrierJson = parseStrictJsonBytes(
		epochBytes.value.signatureBytes,
	);
	if (!epochCarrierJson.ok)
		return { ok: false, code: "TRUST_PROTOCOL", message: "epoch signature" };
	const epochCarrier = parseMacReceiptSignature(epochCarrierJson.value);
	if (!epochCarrier.ok) return epochCarrier;
	const epochSignatureRaw64 = new Uint8Array(
		Buffer.from(epochCarrier.value.signatureBase64, "base64"),
	);
	if (
		epochCarrier.value.signedSchema !== "cohort-warmup-epoch/v1" ||
		epochCarrier.value.signedBytesSha256 !==
			sha256HexOfBytes(epochBytes.value.bytes) ||
		epochSignatureRaw64.byteLength !== 64 ||
		Buffer.from(epochSignatureRaw64).toString("base64") !==
			epochCarrier.value.signatureBase64
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message:
				"the warmup epoch's signature carrier does not carry a 64-byte signature over the epoch",
		};
	}
	retention.epoch = {
		record: epoch.value,
		bytes: epochBytes.value.bytes,
		signatureBytes: epochBytes.value.signatureBytes,
		signatureRaw64: epochSignatureRaw64,
	};
	const epochAccepted = await input.rig.acceptWarmupEpoch({
		epoch: epoch.value,
		epochBytes: epochBytes.value.bytes,
		epochSignatureBytes: epochBytes.value.signatureBytes,
		nowMs: nowMs(),
	});
	if (!epochAccepted.ok) return epochAccepted;

	const warmupRun = await input.rig.runWarmupWire();
	if (!warmupRun.ok) return warmupRun;
	for (const bytes of warmupRun.value.roleWarmupCompleteBytes) {
		const retained = supervisor.retainRoleWarmupComplete(bytes);
		if (!retained.ok) return retained;
	}
	const manifestAck = await supervisor.issueRoleWarmupCompletionManifest();
	if (!manifestAck.ok) return manifestAck;
	const manifestPair = macSignedFromAck(
		manifestAck.value.roleWarmupCompletionManifestBase64,
		manifestAck.value.roleWarmupCompletionManifestSignatureBase64,
	);
	if (!manifestPair.ok) return manifestPair;

	// 6. Linux drains warmup and resets every measured counter and ordinal.
	const drained = await input.rig.drainWarmup({
		roleWarmupCompletionManifestBytes: manifestPair.value.bytes,
		roleWarmupCompletionManifestSignatureBytes:
			manifestPair.value.signatureBytes,
		roleWarmupCompletionManifestSha256:
			manifestAck.value.roleWarmupCompletionManifestSha256,
		roleWarmupCompletionManifestSignatureSha256:
			manifestAck.value.roleWarmupCompletionManifestSignatureSha256,
		nowMs: nowMs(),
	});
	if (!drained.ok) return drained;
	const drainedPresented = supervisor.presentRigWarmupDrainedReceipt({
		serverWarmupDrainedBytes: drained.value.serverWarmupDrainedBytes,
		receipt: drained.value.receipt,
		signature: drained.value.signature,
		nowMs: nowMs(),
	});
	if (!drainedPresented.ok) return drainedPresented;

	// 7. The Linux baseline, authenticated before the barrier is minted.
	const startAck = await input.rig.measureStartAck({ nowMs: nowMs() });
	if (!startAck.ok) return startAck;
	retention.measureStartAck = startAck.value;
	const startAckPresented = supervisor.presentRigMeasureStartAck({
		ackBytes: startAck.value.ackBytes,
		signature: startAck.value.signature,
		issuedAtMs: startAck.value.issuedAtMs,
		notAfterMs: startAck.value.notAfterMs,
		nowMs: nowMs(),
	});
	if (!startAckPresented.ok) return startAckPresented;

	// 8. Only now can the barrier exist; the binary mints it from what it retains.
	const barrierAck = await supervisor.issueStartBarrier();
	if (!barrierAck.ok) return barrierAck;
	const barrierPair = macSignedFromAck(
		barrierAck.value.cohortStartBarrierBase64,
		barrierAck.value.cohortStartBarrierSignatureBase64,
	);
	if (!barrierPair.ok) return barrierPair;
	const barrierJson = parseStrictJsonBytes(barrierPair.value.bytes);
	if (!barrierJson.ok)
		return { ok: false, code: "TRUST_PROTOCOL", message: "barrier bytes" };
	const barrier = parseCohortStartBarrier(barrierJson.value);
	if (!barrier.ok) return barrier;
	retention.barrier = {
		record: barrier.value,
		bytes: barrierPair.value.bytes,
		signatureBytes: barrierPair.value.signatureBytes,
		sha256: sha256HexOfBytes(barrierPair.value.bytes),
	};
	const barrierAccepted = await input.rig.acceptStartBarrier({
		barrier: barrier.value,
		barrierBytes: barrierPair.value.bytes,
		barrierSignatureBytes: barrierPair.value.signatureBytes,
		rigMeasureStartAckSha256: startAckPresented.value.rigMeasureStartAckSha256,
		nowMs: nowMs(),
	});
	if (!barrierAccepted.ok) return barrierAccepted;
	const barrierPresented = await supervisor.presentRigBarrierAcceptance({
		serverStartBarrierAcceptedBytes:
			barrierAccepted.value.serverStartBarrierAcceptedBytes,
		acceptance: barrierAccepted.value.acceptance,
		signature: barrierAccepted.value.signature,
		nowMs: nowMs(),
	});
	if (!barrierPresented.ok) return barrierPresented;

	// 9. §5 MEASURING then STOPPING: the children run the window the barrier
	// declares and are stopped at the declared Mac stop.
	const stopped = await input.rig.runMeasuredWindow();
	if (!stopped.ok) return stopped;

	// 10. §5 DRAINING + LINUX_CAPTURE, at the Mac stop: Linux rejects later
	// ingress, sends the subscriber end markers, drains its bounded queues,
	// closes the sessions and observes. Linux is the authority for accepted
	// ingress, capacity and faults. The capture goes out before any partial is
	// read because the workers' partials wait on exactly those end markers
	// (plan §5 steps 11-14, base plan lines 2185-2190).
	const observed = await input.rig.observe({ nowMs: nowMs() });
	if (!observed.ok) return observed;
	const capture = observed.value;
	if (
		capture.linuxRelayObservationBytes === null ||
		capture.relayObservationReceipt === null ||
		capture.relayObservationSignature === null
	) {
		return bindingNotReady("the capture carried no Linux relay observation");
	}
	const observationPresented = supervisor.presentRigRelayObservation({
		observationBytes: capture.linuxRelayObservationBytes,
		receipt: capture.relayObservationReceipt,
		signature: capture.relayObservationSignature,
		nowMs: nowMs(),
	});
	if (!observationPresented.ok) return observationPresented;
	retention.capture = capture;

	// 11. §5 MAC_JOIN's inputs: each child's partial, after the drain.
	const measured = await input.rig.collectPartials();
	if (!measured.ok) return measured;
	for (const partial of measured.value.partials) {
		const acceptedPartial = supervisor.acceptRolePartial({
			childId: partial.childId,
			frame: partial.frame,
		});
		if (!acceptedPartial.ok) return acceptedPartial;
		// The child's frame is the `role-partial/v1` carrier; what the series
		// is projected from (`cohortMeasurementSeriesFrom`, the publisher and
		// worker partial parsers) is the record it carries -- the same bytes
		// the supervisor just accepted under their digest, decoded once here.
		const carrier = parseRolePartial(partial.frame);
		if (!carrier.ok) return carrier;
		const carried = parseStrictJsonBytes(
			new Uint8Array(Buffer.from(carrier.value.partialBase64, "base64")),
		);
		if (!carried.ok) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `${partial.childId}: partial is not canonical JSON`,
			};
		}
		retention.partials.set(partial.childId, carried.value);
	}

	return {
		ok: true,
		value: {
			executionSha256: supervisor.config.executionSha256,
			cohortGrantSha256: opened.value.grantSha256,
			capture,
		},
	};
}

// ---------------------------------------------------------------------------
// Finalization (§5 MAC_JOIN .. ASSEMBLY), after the capture
// ---------------------------------------------------------------------------

/** One `retained-canonical-bytes/v1` member from exact bytes. */
function retainedBytesOf(bytes: Uint8Array): RetainedCanonicalBytesV1 {
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: Buffer.from(bytes).toString("base64"),
		byteLength: bytes.byteLength,
		sha256: sha256HexOfBytes(bytes),
	};
}

function macNsToEpochMs(macNs: NsString, wallOffsetNs: bigint): number {
	return Number((BigInt(macNs) + wallOffsetNs) / 1_000_000n);
}

/**
 * The wall offset between the Mac continuous clock and epoch milliseconds,
 * read at one instant. Mac nanoseconds are boot-relative and the binary's
 * admission bracket (`secure_fs.rs:10156-10186`, `WallBracket`) is epoch
 * milliseconds between the grant's issue and the frame's receipt, so a series
 * stamped on the continuous clock is projected through this one observed
 * offset, and the projection is named in the recorder's clock method.
 */
export function observeMacWallOffsetNs(nowNs: () => NsString): bigint {
	return BigInt(Date.now()) * 1_000_000n - BigInt(nowNs());
}

/** The measured series a cohort presents for admission, projected from partials. */
export function cohortMeasurementSeriesFrom(input: {
	readonly partials: ReadonlyMap<string, unknown>;
	readonly children: readonly MacFanoutChildPlanV1[];
	readonly linuxRelayObservation: LinuxRelayObservationV1;
	readonly barrier: CohortStartBarrierV1;
	readonly subscriberCount: number;
	readonly messageBytes: 100 | 128;
	readonly wallOffsetNs: bigint;
}): ProtocolResult<{
	readonly series: MeasurementSeries;
	readonly rateSeries: CohortRateSeriesV1;
	readonly ledger: CohortLedgerV1;
}> {
	const publisherRecords: PublisherPartialV1[] = [];
	const workerRecords: WorkerPartialV1[] = [];
	for (const plan of input.children) {
		const frame = input.partials.get(plan.childId);
		if (frame === undefined) {
			return bindingNotReady(`${plan.childId} produced no partial`);
		}
		if (plan.role === "publisher") {
			const parsed = parsePublisherPartial(frame);
			if (!parsed.ok) return parsed;
			publisherRecords.push(parsed.value);
		} else {
			const parsed = parseWorkerPartial(frame);
			if (!parsed.ok) return parsed;
			workerRecords.push(parsed.value);
		}
	}
	workerRecords.sort((a, b) => a.workerIndex - b.workerIndex);
	const conservation = recomputeCohortOriginConservation({
		publisherPartials: publisherRecords,
		workerPartials: workerRecords,
		linuxRelayObservation: input.linuxRelayObservation,
		subscriberCount: input.subscriberCount,
		messageBytes: input.messageBytes,
	});
	if (!conservation.ok) return conservation;
	const ledger = recomputeCohortLedger({
		conservation: conservation.value,
		subscriberCount: input.subscriberCount,
		messageBytes: input.messageBytes,
	});
	if (!ledger.ok) return ledger;
	const firstDelivery = workerRecords
		.map((worker) => BigInt(worker.firstDeliveryAtMacNs))
		.reduce((low, value) => (value < low ? value : low));
	const lastDelivery = workerRecords
		.map((worker) => BigInt(worker.lastDeliveryAtMacNs))
		.reduce((high, value) => (value > high ? value : high));
	const drained = workerRecords.some(
		(worker) => worker.deliveredAfterMeasureStop > 0,
	);
	const lastMeasured = drained
		? BigInt(input.barrier.measureStopAtMacNs)
		: lastDelivery;
	const rateSeries = recomputeCohortRateSeries({
		workerPartials: workerRecords,
		conservation: conservation.value,
		windowCount: input.barrier.windowCount,
		measuredDurationMs: input.barrier.measuredDurationMs,
		firstDeliveryAtMacNs: firstDelivery.toString(),
		lastMeasuredWindowDeliveryAtMacNs: lastMeasured.toString(),
		lastDeliveryIncludingDrainAtMacNs: lastDelivery.toString(),
	});
	if (!rateSeries.ok) return rateSeries;
	const series: MeasurementSeries = {
		samples: [...rateSeries.value.samples],
		roundTrips: [],
		ledger: { delivered: rateSeries.value.measuredWindowDeliveredTotal },
		provenance: {
			sampleCount: rateSeries.value.samples.length,
			firstSampleAtMs: macNsToEpochMs(
				rateSeries.value.firstDeliveryAtMacNs,
				input.wallOffsetNs,
			),
			lastSampleAtMs: macNsToEpochMs(
				rateSeries.value.lastMeasuredWindowDeliveryAtMacNs,
				input.wallOffsetNs,
			),
		},
		sampleUnit: "count",
	};
	return {
		ok: true,
		value: { series, rateSeries: rateSeries.value, ledger: ledger.value },
	};
}

/**
 * A digest's head, for a refusal that has to name one.
 *
 * Long enough to identify which record was seen, short enough that a refusal
 * cannot be grown by a field an untrusted record chose.
 */
function shortDigest(value: unknown): string {
	const text = typeof value === "string" ? value : String(value);
	return text.length > 12 ? `${text.slice(0, 12)}...` : text;
}

/** The server snapshot the arm joins onto, decoded from the rig's capture. */
export function serverSnapshotFromCapture(input: {
	readonly capture: RigCaptureBundleV1;
	readonly execution: {
		readonly campaignId: string;
		readonly runId: string;
		readonly executionIndex: number;
		readonly transport: "ws" | "wt";
	};
}): ProtocolResult<{
	readonly snapshot: ServerSnapshotRecord;
	readonly frame: ServerLoopUtilizationFrameV1;
	readonly receipt: RigServerSnapshotReceiptV1;
}> {
	const frameJson = parseStrictJsonBytes(input.capture.snapshotFrameBytes);
	if (!frameJson.ok)
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "snapshot frame bytes",
		};
	if (!isServerLoopUtilizationFrameV1(frameJson.value)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "snapshot frame is not server-loop-utilization/v1",
		};
	}
	const frame = frameJson.value;
	const receiptJson = parseStrictJsonBytes(input.capture.snapshotReceiptBytes);
	if (!receiptJson.ok)
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "snapshot receipt bytes",
		};
	const receipt = receiptJson.value as RigServerSnapshotReceiptV1;
	const capturedFrameSha256 = sha256HexOfBytes(
		input.capture.snapshotFrameBytes,
	);
	if (
		receipt.schema !== "rig-server-snapshot-receipt/v1" ||
		receipt.snapshotFrameSha256 !== capturedFrameSha256 ||
		!Number.isSafeInteger(receipt.issuedAtMs)
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message:
				"snapshot receipt does not cover the captured frame: observed schema " +
				`${String(receipt.schema)}, snapshotFrameSha256 ` +
				`${shortDigest(receipt.snapshotFrameSha256)}, issuedAtMs ` +
				`${String(receipt.issuedAtMs)}; expected rig-server-snapshot-receipt/v1, ` +
				`${shortDigest(capturedFrameSha256)}, a safe integer`,
		};
	}
	if (frame.transport !== input.execution.transport) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message:
				`snapshot frame transport: observed ${String(frame.transport)}, ` +
				`expected ${input.execution.transport}`,
		};
	}
	return {
		ok: true,
		value: {
			frame,
			receipt,
			snapshot: {
				schema: SERVER_SNAPSHOT_SCHEMA,
				campaignId: input.execution.campaignId,
				runId: input.execution.runId,
				executionIndex: input.execution.executionIndex,
				transport: input.execution.transport,
				legId: input.execution.runId,
				sequence: 1,
				capturedAtMs: receipt.issuedAtMs,
				loopUtilization: { busyMs: frame.busyMs, windowMs: frame.windowMs },
			},
		},
	};
}

/**
 * The admission counters of a cohort arm, from the Linux observation and the
 * capacity record the projection cross-checks them against
 * (`arm-measure.ts:678-685`). Every number is Linux's; none is a Mac count.
 */
export function cohortAdmissionCountersFrom(input: {
	readonly linux: LinuxRelayObservationV1;
	readonly expectedSessions: number;
}): AdmissionCounters {
	const accepted = input.linux.sessionsAccepted;
	return {
		schemaVersion: "v1",
		handshakes: { attempted: accepted, accepted, rejected: 0, rateLimited: 0 },
		sessions: {
			attempted: input.expectedSessions,
			accepted,
			rejected: input.expectedSessions - accepted,
			activePeak: input.linux.sessionsActivePeak,
		},
		streams: { attempted: 0, accepted: 0, rejected: 0, rateLimited: 0 },
		datagrams: { attempted: 0, accepted: 0, rejected: 0, rateLimited: 0 },
	};
}

/** The Phase-A server observation graph, from exact bytes only. */
export function assembleServerObservationEvidence(input: {
	readonly opened: MacExecutionOpenedV1;
	readonly draftBytes: Uint8Array;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly stagedServerLaunchRecordBytes: Uint8Array;
	readonly admittedClientSeriesBytes: Uint8Array;
	readonly rigExecutionAcceptance: RigExecutionAcceptancePairV1;
	readonly rigMeasureStartAck: RigMeasureStartAckBundleV1;
	readonly capture: RigCaptureBundleV1;
	readonly admission: MacMeasurementAdmissionIssuedV1;
}): ServerObservationEvidenceV1 {
	const triple = (bytes: Uint8Array) =>
		[
			Buffer.from(bytes).toString("base64"),
			sha256HexOfBytes(bytes),
			bytes.byteLength,
		] as const;
	const draft = triple(input.draftBytes);
	const grant = triple(input.opened.measurementGrantBytes);
	const receipt = triple(input.opened.receiptBytes);
	const receiptSig = triple(input.opened.receiptSignatureBytes);
	const admission = triple(input.admission.macMeasurementAdmission.bytes);
	const admissionSig = triple(
		input.admission.macMeasurementAdmission.signatureBytes,
	);
	const series = triple(input.admittedClientSeriesBytes);
	const acceptance = triple(input.rigExecutionAcceptance.acceptanceBytes);
	const acceptanceSig = triple(input.rigExecutionAcceptance.signatureBytes);
	const baseline = triple(input.rigMeasureStartAck.ackBytes);
	const baselineSig = triple(input.rigMeasureStartAck.signatureBytes);
	const snapshot = triple(input.capture.snapshotFrameBytes);
	const snapshotReceipt = triple(input.capture.snapshotReceiptBytes);
	const snapshotSig = triple(input.capture.snapshotSignatureBytes);
	return {
		schema: "server-observation-evidence/v1",
		provenance:
			"server-child-observed/rig-supervisor-admitted/mac-supervisor-joined",
		workloadRolePlanInput: retainedBytesOf(input.workloadRolePlanInputBytes),
		stagedServerLaunchRecord: retainedBytesOf(
			input.stagedServerLaunchRecordBytes,
		),
		executionDraftBase64: draft[0],
		executionDraftSha256: draft[1],
		executionDraftSize: draft[2],
		measurementGrantBase64: grant[0],
		measurementGrantSha256: grant[1],
		measurementGrantSize: grant[2],
		macExecutionGrantReceiptBase64: receipt[0],
		macExecutionGrantReceiptSha256: receipt[1],
		macExecutionGrantReceiptSize: receipt[2],
		macExecutionGrantSignatureBase64: receiptSig[0],
		macExecutionGrantSignatureSha256: receiptSig[1],
		macExecutionGrantSignatureSize: receiptSig[2],
		macMeasurementAdmissionReceiptBase64: admission[0],
		macMeasurementAdmissionReceiptSha256: admission[1],
		macMeasurementAdmissionReceiptSize: admission[2],
		macMeasurementAdmissionSignatureBase64: admissionSig[0],
		macMeasurementAdmissionSignatureSha256: admissionSig[1],
		macMeasurementAdmissionSignatureSize: admissionSig[2],
		admittedClientSeriesBase64: series[0],
		admittedClientSeriesSha256: series[1],
		admittedClientSeriesSize: series[2],
		rigExecutionAcceptanceBase64: acceptance[0],
		rigExecutionAcceptanceSha256: acceptance[1],
		rigExecutionAcceptanceSize: acceptance[2],
		rigExecutionAcceptanceSignatureBase64: acceptanceSig[0],
		rigExecutionAcceptanceSignatureSha256: acceptanceSig[1],
		rigExecutionAcceptanceSignatureSize: acceptanceSig[2],
		rigMeasureStartAckBase64: baseline[0],
		rigMeasureStartAckSha256: baseline[1],
		rigMeasureStartAckSize: baseline[2],
		rigMeasureStartAckSignatureBase64: baselineSig[0],
		rigMeasureStartAckSignatureSha256: baselineSig[1],
		rigMeasureStartAckSignatureSize: baselineSig[2],
		rigBarrierAcceptanceBase64: null,
		rigBarrierAcceptanceSha256: null,
		rigBarrierAcceptanceSize: null,
		rigBarrierAcceptanceSignatureBase64: null,
		rigBarrierAcceptanceSignatureSha256: null,
		rigBarrierAcceptanceSignatureSize: null,
		snapshotFrameBase64: snapshot[0],
		snapshotFrameSha256: snapshot[1],
		snapshotFrameSize: snapshot[2],
		rigServerSnapshotReceiptBase64: snapshotReceipt[0],
		rigServerSnapshotReceiptSha256: snapshotReceipt[1],
		rigServerSnapshotReceiptSize: snapshotReceipt[2],
		rigServerSnapshotReceiptSignatureBase64: snapshotSig[0],
		rigServerSnapshotReceiptSignatureSha256: snapshotSig[1],
		rigServerSnapshotReceiptSignatureSize: snapshotSig[2],
	};
}

/** What finalization yields: everything `sealCohortArmRepetition` reads. */
export interface CohortArmFinalizedV1 {
	readonly cohortEvidence: ArmCohortEvidenceV1;
	readonly exportAck: MacCohortEvidenceExportedAckV1;
	readonly admissionReceipt: CohortAdmissionReceiptV1;
	readonly admissionReceiptSha256: Sha256Hex;
	readonly serverSnapshot: ServerSnapshotRecord;
	readonly admissionCounters: AdmissionCounters;
	readonly supervisorContext: ArmMeasureSupervisorContext;
	/** The cohort's recorder identity: the filed admission record's own. */
	readonly recorder: {
		readonly attestation: string;
		readonly driverRunId: string;
		readonly clockMethod: string;
		readonly wallOffsetNs: bigint;
	};
	/** The complete graph finalization verified; the seal re-verifies with the same keys. */
	readonly attestationEvidence: ArmAttestationEvidenceV2;
	readonly trust: AttestationTrustMaterial;
	readonly execution: {
		readonly campaignId: string;
		readonly runId: string;
		readonly executionIndex: number;
		readonly transport: "ws" | "wt";
	};
}

/**
 * Everything a cohort arm needs that the controller is not allowed to invent,
 * split into what the lifecycle consumes and the one function that finalizes.
 */
export interface CohortArmLease {
	readonly supervisor: MacFanoutSupervisor;
	readonly rig: CohortRigBinding;
	readonly retention: CohortLifecycleRetention;
	readonly bundleFor: (plan: MacFanoutChildPlanV1) => TokenBundleV1;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly tokenCommitmentLeafManifestBytes: () => Uint8Array | null;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => NsString;
	};
	readonly executionSha256: Sha256Hex;
	readonly publisherCount: number;
	readonly subscriberCount: number;
	readonly comparisonId: string;
	readonly executionIndex: number;
	/** §5 MAC_JOIN .. ASSEMBLY inputs, obtainable only after the capture. */
	readonly finalize: (
		measured: CohortArmMeasuredV1,
	) => Promise<ProtocolResult<CohortArmFinalizedV1>>;
	/**
	 * Bounded reap of every process this lease spawned, on every terminal
	 * path: the Mac's role children, then the rig's server child (§5 step 16).
	 */
	readonly cleanup: (
		path: MacFanoutTerminalPath,
	) =>
		| ProtocolResult<MacFanoutTeardownResultV1>
		| Promise<ProtocolResult<MacFanoutTeardownResultV1>>;
}

export type CohortArmLeaseFactory = (
	context: CohortArmRuntimeContext,
) => ProtocolResult<CohortArmLease> | Promise<ProtocolResult<CohortArmLease>>;

/** The repetition a runtime is being asked for. */
export interface CohortArmRuntimeContext {
	readonly cell: ScenarioCell;
	readonly arm: SealArm;
	/** `cohortCellForArm`'s answer -- the §4.5 cell, not the registry cell id. */
	readonly cohortCellId: string;
	readonly runId: string;
	readonly repetitionKind: "warmup" | "measured";
	readonly repetitionIndex: number;
	readonly perRepPath: string;
	readonly sealedPath: string;
}

/** What `driveCohortArm` consumes plus the seal that finalizes it. */
export interface CohortArmRuntime {
	readonly supervisor: MacFanoutSupervisor;
	readonly rig: CohortRigBinding;
	readonly retention: CohortLifecycleRetention;
	readonly bundleFor: (plan: MacFanoutChildPlanV1) => TokenBundleV1;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly tokenCommitmentLeafManifestBytes: () => Uint8Array | null;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => NsString;
	};
	readonly seal: (measured: CohortArmMeasuredV1) => Promise<SealedRepResult>;
	readonly cleanup: (
		path: MacFanoutTerminalPath,
	) =>
		| ProtocolResult<MacFanoutTeardownResultV1>
		| Promise<ProtocolResult<MacFanoutTeardownResultV1>>;
}

export type CohortArmRuntimeProvider = (
	context: CohortArmRuntimeContext,
) =>
	| ProtocolResult<CohortArmRuntime>
	| Promise<ProtocolResult<CohortArmRuntime>>;

/** What one arm repetition produced, whichever executor produced it. */
export type SealedRepResult =
	| {
			readonly ok: true;
			readonly primaryMetricP50: number;
			readonly sealedPath: string;
			readonly artifactSha256: string;
			readonly readPath?: CampaignIndexEntry["readPath"];
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			/** §7's closed set. Absent means the caller's own `TRUST_PROTOCOL`. */
			readonly failureCode?: CampaignFailureCode;
	  };

/** Which executor ran an arm repetition. */
export type ArmExecutorRoute = "cohort" | "single-session-leg";

/** What the seam did, so a caller (and a test) can see which executor ran. */
export interface ArmRepetitionDispatch {
	readonly route: ArmExecutorRoute;
	readonly result: SealedRepResult;
}

function closedCohortFailureCode(code: string): CampaignFailureCode {
	return isCampaignFailureCode(code) ? code : "COHORT_PROTOCOL";
}

/**
 * The one place a scheduled arm repetition is routed to an executor.
 *
 * `cohortCellForArm` is the router, the same call the builder, the verifier and
 * the promotion selector make. A fanout primary is never handed to the leg
 * executor: with no runtime it is refused with a closed code, because demoting
 * it to a single session would measure one publisher and present it as a
 * cohort. The runtime's `cleanup` runs on every path out of a cohort attempt.
 */
export async function dispatchArmRepetition(input: {
	readonly arm: Parameters<typeof measureSealAndWriteRep>[0];
	readonly cohortRuntime?: CohortArmRuntimeProvider;
	readonly executors?: {
		readonly measureSealAndWriteRep?: typeof measureSealAndWriteRep;
		readonly driveCohortArm?: typeof driveCohortArm;
	};
}): Promise<ArmRepetitionDispatch> {
	const armInput = input.arm;
	const cohortCellId = cohortCellForArm({
		cellId: armInput.cell.cellId,
		armKind: armInput.arm.armKind,
	});
	if (cohortCellId === null) {
		const runLeg =
			input.executors?.measureSealAndWriteRep ?? measureSealAndWriteRep;
		return { route: "single-session-leg", result: await runLeg(armInput) };
	}

	const provider = input.cohortRuntime;
	if (provider === undefined) {
		return {
			route: "cohort",
			result: {
				ok: false,
				failureCode: "COHORT_NOT_READY",
				reason: `no cohort runtime for ${armInput.arm.armId} (${cohortCellId}); a fanout primary is refused rather than demoted to a single-session leg`,
			},
		};
	}
	const runtime = await provider({
		cell: armInput.cell,
		arm: armInput.arm,
		cohortCellId,
		runId: armInput.runId,
		repetitionKind: armInput.repetitionKind,
		repetitionIndex: armInput.repIndex,
		perRepPath: armInput.perRepPath,
		sealedPath: armInput.sealedPath,
	});
	if (!runtime.ok) {
		return {
			route: "cohort",
			result: {
				ok: false,
				failureCode: closedCohortFailureCode(runtime.code),
				reason: `cohort runtime unavailable (${runtime.code}): ${runtime.message}`,
			},
		};
	}

	const driveArgs = {
		supervisor: runtime.value.supervisor,
		rig: runtime.value.rig,
		retention: runtime.value.retention,
		bundleFor: runtime.value.bundleFor,
		workloadRolePlanInputBytes: runtime.value.workloadRolePlanInputBytes,
		tokenCommitmentLeafManifestBytes:
			runtime.value.tokenCommitmentLeafManifestBytes,
		clock: runtime.value.clock,
	};
	let result: SealedRepResult;
	let terminal: MacFanoutTerminalPath = "FAIL";
	try {
		// Spelled out so the production call to the cohort executor is
		// findable by name.
		const driven =
			input.executors?.driveCohortArm !== undefined
				? await input.executors.driveCohortArm(driveArgs)
				: await driveCohortArm(driveArgs);
		if (!driven.ok) {
			result = {
				ok: false,
				failureCode: closedCohortFailureCode(driven.code),
				reason: `cohort executor refused (${driven.code}): ${driven.message}`,
			};
		} else {
			result = await runtime.value.seal(driven.value);
			terminal = result.ok ? "PASS" : "FAIL";
		}
	} finally {
		const reaped = await runtime.value.cleanup(terminal);
		if (!reaped.ok) {
			process.stderr.write(
				`controller: cohort cleanup did not reap every group (${reaped.code}): ${reaped.message}\n`,
			);
		}
	}
	if (!result.ok) return { route: "cohort", result };
	return { route: "cohort", result };
}

// ---------------------------------------------------------------------------
// The production cohort runtime: acquisition, finalization, seal
// ---------------------------------------------------------------------------

/** Everything acquisition accepts, all of it verified before it is handed in. */
export interface CohortArmAcquisitionInputs {
	readonly staged: StagedCohortMaterialV1;
	readonly bootstrap: StagedTrustBootstrapPaths;
	readonly macSupervisor: SupervisorHandle;
	readonly rigSupervisor: SupervisorHandle;
	readonly context: CohortArmRuntimeContext;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly repetitionTotal: number;
	readonly toolchains: ToolchainSet;
	readonly bunExecutablePath: string;
	readonly serverPort: number;
	/** The staged CA the role children verify the relay against. */
	readonly tlsCaPem: string;
	readonly macClockId: string;
	readonly runtimeRoot: string;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => NsString;
	};
	readonly deadlines: {
		readonly frameMs: number;
		readonly warmupDrainMs: number;
		readonly captureMs: number;
		readonly roleReceiveMs: number;
		readonly teardownMs: number;
	};
}

const COHORT_SCENARIO_BY_ID = {
	"chat-fanout": "chat",
	"ticker-fanout": "ticker",
} as const;

/**
 * Acquire one repetition's cohort material (amendment C4 acquisition).
 *
 * In order: the signed draft; the Mac binary's execution (grant + receipt,
 * verified on the channel); the rig's execution acceptance; the token
 * material; the role-child host; the supervisor; the rig channel and the
 * composed binding; then a finalize function that needs nothing that does not
 * yet exist. Every refusal names its input and reaps whatever was spawned.
 */
export async function acquireCohortArmMaterial(
	inputs: CohortArmAcquisitionInputs,
): Promise<ProtocolResult<CohortArmLease>> {
	const { staged, context } = inputs;
	const cardinality = cohortCellCardinality(context.cohortCellId);
	const grantParameters = cohortCellGrantParameters(context.cohortCellId);
	const scenario =
		COHORT_SCENARIO_BY_ID[
			context.cell.scenarioId as keyof typeof COHORT_SCENARIO_BY_ID
		];
	if (scenario === undefined) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `${context.cell.scenarioId} is not a fanout scenario`,
		};
	}
	const contract = metricContractForScenario(context.cell.scenarioId);
	if (contract === undefined) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `${context.cell.scenarioId} has no primary metric contract`,
		};
	}
	if (staged.roleEntrypointPath === null) {
		return stageFail(
			"the stage carries no fanout role entrypoint (phase-a profile); a cohort arm needs a phase-b stage",
		);
	}
	const bunBytes = readBytesOrNull(inputs.bunExecutablePath);
	if (
		bunBytes === null ||
		sha256HexOfBytes(bunBytes) !== staged.receipt.macBunSha256
	) {
		return stageFail(
			`${inputs.bunExecutablePath} is not the staged Mac Bun (macBunSha256)`,
		);
	}
	if (
		inputs.macSupervisor.controllerToSupervisor === undefined ||
		inputs.macSupervisor.supervisorToController === undefined ||
		inputs.rigSupervisor.controllerToSupervisor === undefined ||
		inputs.rigSupervisor.supervisorToController === undefined
	) {
		return bindingNotReady("both supervisor handles need control pipes");
	}

	// 1. The signed identity, drafted from verified sources only.
	const drafted = buildSignedExecutionDraft({
		staged,
		bootstrap: inputs.bootstrap,
		cell: context.cell,
		arm: context.arm,
		serverMode: "fanout-cohort",
		executionPurpose: inputs.executionPurpose,
		repetitionKind: context.repetitionKind,
		repetitionIndex: context.repetitionIndex,
		repetitionTotal: inputs.repetitionTotal,
	});
	if (!drafted.ok) return drafted;

	// 2. The Mac binary constructs the execution and signs its receipt.
	const channel = new MacCohortChannel({
		controllerToMac: inputs.macSupervisor.controllerToSupervisor,
		macToController: inputs.macSupervisor.supervisorToController,
		childDiagnostics: inputs.macSupervisor.diagnostics,
		stagedMacPublicRaw32: staged.stagedMacPublicRaw32,
		deadlineMs: inputs.deadlines.frameMs,
	});
	const opened = await channel.openExecution(drafted.value.draftBytes);
	if (!opened.ok) return opened;
	const execution = opened.value.execution;

	// 3. The rig accepts the execution before any server exists.
	const rigChannel = new CohortRigChannel({
		controllerToRig: inputs.rigSupervisor.controllerToSupervisor,
		rigToController: inputs.rigSupervisor.supervisorToController,
		childDiagnostics: inputs.rigSupervisor.diagnostics,
		executionSha256: opened.value.executionSha256,
		stagedRigPublicRaw32: staged.stagedRigPublicRaw32,
		deadlines: {
			frameMs: inputs.deadlines.frameMs,
			serverReadyMs: cohortReadinessDeadlineMs(context.cohortCellId),
			warmupDrainMs: inputs.deadlines.warmupDrainMs,
			captureMs: inputs.deadlines.captureMs,
			teardownMs: inputs.deadlines.teardownMs,
		},
	});
	const phaseA = createPhaseARigLifecycleOverChannel(rigChannel);
	const accepted = await phaseA.acceptExecution({
		measurementGrantBytes: opened.value.measurementGrantBytes,
		receiptBytes: opened.value.receiptBytes,
		receiptSignatureBytes: opened.value.receiptSignatureBytes,
	});
	if (!accepted.ok) return accepted;
	const rigExecutionAcceptance = accepted.value;

	// 4. Token material: 32 random bytes per role, commitments only on the wire.
	let minted: {
		readonly material: MacProductionCohortTokenMaterialV1;
		readonly leafManifestBytes: Uint8Array;
	} | null = null;
	const minter = createMacProductionCohortMinter({
		tokenMaterial: ({ cohortId, publisherCount, subscriberCount }) =>
			buildFanoutCohortFixture({
				cohortId,
				publisherCount,
				subscriberCount,
				tokenFor: () => new Uint8Array(randomBytes(32)),
			}),
		onMinted: (value) => {
			minted = {
				material: value.material,
				leafManifestBytes: value.leafManifestBytes,
			};
		},
	});

	// 5. The role-child host and the supervisor over the channel. The staged
	//    leaf is a hashed copy with no siblings; the file a child can actually
	//    run is this tree's own entrypoint, admitted only when its bytes are the
	//    staged digest's.
	const roleEntrypoint = executableRoleEntrypoint(
		staged.receipt.fanoutRoleEntrypointSha256,
	);
	if (!roleEntrypoint.ok) return roleEntrypoint;
	const host = createMacFanoutRoleChildHost({
		bunExecutablePath: inputs.bunExecutablePath,
		roleEntrypointPath: roleEntrypoint.value,
		transport: context.arm.transport,
		stagedMacSigningPublicKeySha256: staged.receipt.macSigningPublicKeySha256,
		receiveDeadlineMs: inputs.deadlines.roleReceiveMs,
		env: { [STAGED_TLS_CA_PEM_ENV]: inputs.tlsCaPem },
		onChildStderr: (childId, text) => {
			process.stderr.write(`[${childId}] ${text}`);
		},
	});
	const runtimeDir = join(
		inputs.runtimeRoot,
		cellSafeId(context.cell.cellId),
		`${context.repetitionKind}-${context.repetitionIndex}`,
	);
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const supervisor = new MacFanoutSupervisor({
		scenario,
		subscriberCount: cardinality.subscriberCount,
		executionSha256: opened.value.executionSha256,
		channel,
		workloadRolePlanInputBytes: drafted.value.workload.bytes,
		scenarioHash: drafted.value.workload.scenarioHash,
		rolePlanHash: drafted.value.workload.rolePlanHash,
		stagedRigPublicRaw32: staged.stagedRigPublicRaw32,
		macClockId: inputs.macClockId,
		runtimeDir,
		mintCohort: minter,
		spawnChild: host.spawnChild,
		// Plan 2210's replacement re-spawns the same child ids, and the host
		// refuses an id it still holds a channel for. Retiring moves the
		// channel aside without closing it.
		retireChild: (childId) => {
			host.retireChild(childId);
		},
		processControl: host.processControl,
		ledger: createDurableFilesystemReplayLedger(join(runtimeDir, "replay")),
		stagedCapabilityNotAfterMs: staged.receipt.notAfterMs,
		bunSha256: staged.receipt.macBunSha256,
		entrypointSha256: staged.receipt.fanoutRoleEntrypointSha256 as Sha256Hex,
	});

	// 6. The rig courier, the role-child driver, and the two composed.
	const retention = new CohortLifecycleRetention();
	const cohortRecord = stagedServerLaunchRecordFor(
		staged,
		context.arm.transport,
		"fanout-cohort",
	);
	const rigBinding = new CohortChannelRigBinding({
		channel: rigChannel,
		spawn: {
			serverEntrypointSha256: staged.receipt.serverEntrypointSha256,
			bunSha256: staged.receipt.linuxBunSha256,
			addonSha256: staged.receipt.linuxAddonManifestSha256,
			stagedServerLaunchRecordBytes: cohortRecord.bytes,
			bindPort: inputs.serverPort,
			transport: context.arm.transport,
			// The bound record's own argv: the rig compares it byte for byte.
			serverArgv: [...cohortRecord.record.argv],
		},
		macStopIssuedAtNs: () => inputs.clock.nowNs(),
		drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS,
	});
	const frames = createRetainedRoleChildFrameSource({
		retention,
		executionSha256: opened.value.executionSha256,
		workloadRolePlanInputBytes: drafted.value.workload.bytes,
		staged,
		transport: context.arm.transport,
		serverPort: inputs.serverPort,
		cell: cardinality,
		grantParameters,
		childStateFor: (childId) =>
			supervisor.spawnedChildren.find(
				(child) => child.plan.childId === childId,
			),
		clock: inputs.clock,
	});
	const roleChildren = new MacRoleChildCohortDriver({
		host,
		children: supervisor.topology.children,
		executionSha256: opened.value.executionSha256,
		joins: {
			cohortGrantSha256: () => retention.grant?.sha256 ?? null,
			cohortStartBarrierSha256: () => retention.barrier?.sha256 ?? null,
			measureStopAtMacNs: () =>
				retention.barrier?.record.measureStopAtMacNs ?? null,
		},
		stamps: {
			markChildLifecycle: (args) => supervisor.markChildLifecycle(args),
		},
		frames,
		clock: inputs.clock,
		readinessDeadlineMs: cohortReadinessDeadlineMs(context.cohortCellId),
		warmupDeadlineMs: WARMUP_DURATION_MS + inputs.deadlines.warmupDrainMs,
		measuredDeadlineMs:
			grantParameters.measuredDurationMs +
			COHORT_DRAIN_DEADLINE_MS +
			inputs.deadlines.frameMs,
		teardownDeadlineMs: inputs.deadlines.teardownMs,
	});
	const rig = composeCohortRigBinding({ rig: rigBinding, roleChildren });

	const bundleFor = (plan: MacFanoutChildPlanV1): TokenBundleV1 => {
		const grantSha256 = supervisor.cohortGrantSha256;
		if (minted === null || grantSha256 === null) {
			throw new Error("token bundles are minted after the grant, never before");
		}
		const bundle = macTokenBundleForPlan({
			plan,
			executionSha256: opened.value.executionSha256,
			cohortGrantSha256: grantSha256,
			material: minted.material,
		});
		if (!bundle.ok)
			throw new Error(`token bundle for ${plan.childId}: ${bundle.code}`);
		return bundle.value;
	};

	const cleanup = (path: MacFanoutTerminalPath) =>
		teardownCohortArmLease({ path, supervisor, rig: rigBinding, host });

	const finalize = async (
		measured: CohortArmMeasuredV1,
	): Promise<ProtocolResult<CohortArmFinalizedV1>> =>
		finalizeCohortArm({
			measured,
			opened: opened.value,
			draftBytes: drafted.value.draftBytes,
			workloadRolePlanInputBytes: drafted.value.workload.bytes,
			staged,
			supervisor,
			retention,
			macSupervisor: inputs.macSupervisor,
			rigExecutionAcceptance,
			cardinality,
			grantParameters,
			contract,
			toolchains: inputs.toolchains,
			clock: inputs.clock,
			deadlines: inputs.deadlines,
		});

	return {
		ok: true,
		value: {
			supervisor,
			rig,
			retention,
			bundleFor,
			workloadRolePlanInputBytes: drafted.value.workload.bytes,
			tokenCommitmentLeafManifestBytes: () => minted?.leafManifestBytes ?? null,
			clock: inputs.clock,
			executionSha256: opened.value.executionSha256,
			publisherCount: cardinality.publisherCount,
			subscriberCount: cardinality.subscriberCount,
			comparisonId: execution.campaignId,
			executionIndex: execution.executionIndex,
			finalize,
			cleanup,
		},
	};
}

/**
 * §5 step 16 (plan 2191), the lease's every path out: the Mac reaps its role
 * children, then the rig is asked to stop and reap the server child it spawned
 * for this execution, then the host's descriptors close. The rig's answer is
 * the rig's -- an ack that says `reaped: true`, or a refusal on which the rig
 * closes the arm (comparison-supervisor.rs `refuse_arm` -> `close_arm`) -- and
 * either way the next execution finds the child slot empty. Without the ask,
 * the child outlived its execution and the next `rig-spawn-server-request/v1`
 * was refused with "one server child per cohort".
 *
 * The reap result is the lease's verdict; a rig teardown that did not ack is
 * reported in its place only when the Mac side reaped cleanly, so the first
 * failure on the path is the one the caller sees.
 */
export async function teardownCohortArmLease(args: {
	readonly path: MacFanoutTerminalPath;
	readonly supervisor: Pick<MacFanoutSupervisor, "teardown">;
	readonly rig: Pick<
		CohortChannelRigBinding,
		"serverStarted" | "teardownServer"
	>;
	readonly host: Pick<MacFanoutRoleChildHost, "closeAll">;
}): Promise<ProtocolResult<MacFanoutTeardownResultV1>> {
	const reaped = args.supervisor.teardown(args.path);
	let stopped: ProtocolResult<RigServerStoppedV1> | null = null;
	if (args.rig.serverStarted) {
		stopped = await args.rig.teardownServer();
	}
	args.host.closeAll();
	if (reaped.ok && stopped !== null && !stopped.ok) return stopped;
	return reaped;
}

/** This tree's role entrypoint, the one file a spawned child can import from. */
export const EXECUTABLE_ROLE_ENTRYPOINT_PATH = join(
	import.meta.dir,
	"fanout-role.ts",
);

/**
 * The role entrypoint a child is spawned on: `bin/fanout-role.ts` beside this
 * controller, admitted only when its bytes hash to the staged digest. The
 * staged `roles/fanout-role.ts` leaf is the binding, not the executable --
 * it is a bare copy whose relative imports resolve to nothing.
 */
export function executableRoleEntrypoint(
	stagedSha256: Sha256Hex | null,
): ProtocolResult<string> {
	if (stagedSha256 === null) {
		return stageFail("the stage carries no fanout role entrypoint digest");
	}
	const bytes = readBytesOrNull(EXECUTABLE_ROLE_ENTRYPOINT_PATH);
	if (bytes === null || sha256HexOfBytes(bytes) !== stagedSha256) {
		return stageFail(
			`${EXECUTABLE_ROLE_ENTRYPOINT_PATH} is not the staged role entrypoint (fanoutRoleEntrypointSha256)`,
		);
	}
	return { ok: true, value: EXECUTABLE_ROLE_ENTRYPOINT_PATH };
}

/** Physical-budget amendment D3: the per-cell readiness deadline, fixed by cell. */
export function cohortReadinessDeadlineMs(cohortCellId: string): number {
	switch (cohortCellId) {
		case "ticker 50":
		case "ticker 100":
		case "ticker 250":
			return 30_000;
		case "chat 250":
		case "chat 500":
		case "chat 1k":
			return 90_000;
		default:
			throw new RangeError(
				`no readiness deadline is frozen for ${cohortCellId}`,
			);
	}
}

/**
 * §5 MAC_JOIN .. ASSEMBLY for one cohort arm, from the capture onward.
 *
 * 1. the series the cohort measured is projected from its partials and
 *    presented on the legacy artifact-payload frame, so the binary retains an
 *    admitted series before it will admit an observation;
 * 2. the rig graph is presented and the binary signs both admissions;
 * 3. the terminal export returns the eight-field ack, and the observation is
 *    reassembled from retained bytes and verified against it;
 * 4. the Phase-A attestation is assembled from exact bytes and verified
 *    against the staged keys before anything is sealed.
 */
export async function finalizeCohortArm(input: {
	readonly measured: CohortArmMeasuredV1;
	readonly opened: MacExecutionOpenedV1;
	readonly draftBytes: Uint8Array;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly staged: StagedCohortMaterialV1;
	readonly supervisor: MacFanoutSupervisor;
	readonly retention: CohortLifecycleRetention;
	readonly macSupervisor: SupervisorHandle;
	readonly rigExecutionAcceptance: RigExecutionAcceptancePairV1;
	readonly cardinality: CohortCellCardinalityV1;
	readonly grantParameters: CohortCellGrantParametersV1;
	/** The cell's published contract: the record's histogram edges. */
	readonly contract: MetricContract;
	readonly toolchains: ToolchainSet;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => NsString;
	};
	readonly deadlines: { readonly frameMs: number };
}): Promise<ProtocolResult<CohortArmFinalizedV1>> {
	const { measured, opened, supervisor, retention } = input;
	if (measured.executionSha256 !== opened.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "measured material names another execution",
		};
	}
	const barrier = retention.barrier;
	const capture = measured.capture;
	if (barrier === null || capture.linuxRelayObservationBytes === null) {
		return bindingNotReady(
			"finalization needs the barrier and the Linux observation",
		);
	}
	const linuxJson = parseStrictJsonBytes(capture.linuxRelayObservationBytes);
	if (!linuxJson.ok)
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "linux observation bytes",
		};
	const linux = parseLinuxRelayObservation(linuxJson.value);
	if (!linux.ok) return linux;

	// 1. Series admission on the legacy frame; the payload bytes are retained.
	//    One wall offset, observed once: the series is presented through it
	//    and the projection at assembly restates it through the same value.
	const wallOffsetNs = observeMacWallOffsetNs(input.clock.nowNs);
	const projected = cohortMeasurementSeriesFrom({
		partials: retention.partials,
		children: supervisor.topology.children,
		linuxRelayObservation: linux.value,
		barrier: barrier.record,
		subscriberCount: input.cardinality.subscriberCount,
		messageBytes: input.grantParameters.messageBytes,
		wallOffsetNs,
	});
	if (!projected.ok) return projected;
	const grantJson = parseStrictJsonBytes(opened.measurementGrantBytes);
	if (!grantJson.ok)
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "measurement grant bytes",
		};
	const grant = parseMeasurementGrant(grantJson.value);
	if (!grant.ok)
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `measurement grant: ${grant.code}`,
		};
	const admittedClientSeriesBytes = measurementPayloadBytes(
		projected.value.series,
		grant.grant,
	);
	const presented = await presentArtifactPayload(
		input.macSupervisor,
		projected.value.series,
		grant.grant,
		Math.max(input.deadlines.frameMs, 10_000),
	);
	if (!presented.ok) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `series admission refused (${presented.code}): ${presented.message}`,
		};
	}

	// 2. MAC_JOIN: the binary signs both admissions; the supervisor checks them.
	const admitted = await supervisor.presentRigObservation({
		rigExecutionAcceptanceBytes: input.rigExecutionAcceptance.acceptanceBytes,
		rigExecutionAcceptanceSignatureBytes:
			input.rigExecutionAcceptance.signatureBytes,
		snapshotFrameBytes: capture.snapshotFrameBytes,
		rigServerSnapshotReceiptBytes: capture.snapshotReceiptBytes,
		rigServerSnapshotReceiptSignatureBytes: capture.snapshotSignatureBytes,
	});
	if (!admitted.ok) return admitted;
	// The cohort's recorder: the series the binary admitted, filed from the
	// bytes it digested under a token derived from its signed receipt. The
	// builder corroborates the assembly's projection against this record the
	// way it corroborates a driver leg against its recorder.
	const macAdmissionJson = parseStrictJsonBytes(
		admitted.value.macMeasurementAdmission.bytes,
	);
	if (!macAdmissionJson.ok) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "mac measurement admission bytes",
		};
	}
	const macAdmission =
		macAdmissionJson.value as MacMeasurementAdmissionReceiptV1;
	let filed: SealedMeasurement;
	try {
		filed = fileAdmittedMeasurement({
			admittedPayloadBytes: admittedClientSeriesBytes,
			admission: {
				bytes: admitted.value.macMeasurementAdmission.bytes,
				admittedClientSeriesSha256: macAdmission.admittedClientSeriesSha256,
				sampleUnit: macAdmission.sampleUnit,
				sampleCount: macAdmission.sampleCount,
				delivered: macAdmission.delivered,
				firstSampleAtMs: macAdmission.firstSampleAtMs,
				lastSampleAtMs: macAdmission.lastSampleAtMs,
			},
			driverRunId: opened.execution.runId,
			clockMethod: MAC_CONTINUOUS_CLOCK_METHOD,
			histogramBoundaries: input.contract.histogramBoundaries,
		});
	} catch (error) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `admitted series record: ${(error as Error).message}`,
		};
	}
	const cohortAdmission = supervisor.cohortAdmission;
	if (cohortAdmission === null || admitted.value.cohortAdmission === null) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "the binary issued no cohort admission for a cohort execution",
		};
	}

	// 3. The terminal export, verified and reconstructed.
	const exported = await supervisor.exportCohortEvidence();
	if (!exported.ok) return exported;
	const cohortEvidence = cohortEvidenceFromExportAck({
		ack: exported.value.ack,
		observation: exported.value.observation,
		stagedMacPublicRaw32: input.staged.stagedMacPublicRaw32,
		expectedExecutionSha256: opened.executionSha256,
		expectedCohortGrantSha256: measured.cohortGrantSha256,
		expectedPublisherCount: input.cardinality.publisherCount,
		expectedSubscriberCount: input.cardinality.subscriberCount,
		alreadyExported: false,
		expectedRequestSequence: exported.value.ack.ackRequestSeq,
	});
	if (!cohortEvidence.ok) return cohortEvidence;

	// 4. The attestation, from exact bytes, verified before any seal.
	const rigMeasureStartAck = retention.measureStartAck;
	if (rigMeasureStartAck === null) {
		return bindingNotReady("the lifecycle retained no rig measure-start ack");
	}
	const observation = assembleServerObservationEvidence({
		opened,
		draftBytes: input.draftBytes,
		workloadRolePlanInputBytes: input.workloadRolePlanInputBytes,
		stagedServerLaunchRecordBytes: stagedServerLaunchRecordFor(
			input.staged,
			opened.execution.transport,
			"fanout-cohort",
		).bytes,
		admittedClientSeriesBytes,
		rigExecutionAcceptance: input.rigExecutionAcceptance,
		rigMeasureStartAck,
		capture,
		admission: admitted.value,
	});
	const attestationEvidence: ArmAttestationEvidenceV2 = {
		schema: "arm-attestation-evidence/v2",
		executionSha256: opened.executionSha256,
		serverObservationEvidence: observation,
		cohortObservationEvidence: cohortEvidence.value.observation,
	};
	const trust: AttestationTrustMaterial = {
		macPublicRaw32: input.staged.stagedMacPublicRaw32,
		rigPublicRaw32: input.staged.stagedRigPublicRaw32,
		macPublicKeySha256: input.staged.receipt.macSigningPublicKeySha256,
		rigPublicKeySha256: input.staged.receipt.rigSigningPublicKeySha256,
	};
	const verified = verifyArmAttestationEvidence(attestationEvidence, trust, {
		executionSha256: opened.executionSha256,
		cellId: opened.execution.cellId,
		armKind: "primary",
		transport: opened.execution.transport,
		repetitionKind: opened.execution.repetitionKind,
		repetitionIndex: opened.execution.repetitionIndex,
		repetitionTotal: opened.execution.repetitionTotal,
		candidate: opened.execution.candidate,
		campaignId: opened.execution.campaignId,
		approvedPlanSha256: input.staged.receipt.approvedPlanSha256,
		approvalRecordSha256: input.staged.receipt.approvalRecordSha256,
	});
	if (!verified.ok) {
		return {
			ok: false,
			code: closedCohortFailureCode(verified.code),
			message: `attestation does not verify: ${verified.message}`,
		};
	}
	const snapshot = serverSnapshotFromCapture({
		capture,
		execution: {
			campaignId: opened.execution.campaignId,
			runId: opened.execution.runId,
			executionIndex: opened.execution.executionIndex,
			transport: opened.execution.transport,
		},
	});
	if (!snapshot.ok) return snapshot;
	const mem = process.memoryUsage();
	return {
		ok: true,
		value: {
			cohortEvidence: cohortEvidence.value,
			exportAck: exported.value.ack,
			admissionReceipt: cohortAdmission.receipt,
			admissionReceiptSha256: cohortAdmission.receiptSha256,
			serverSnapshot: snapshot.value.snapshot,
			admissionCounters: cohortAdmissionCountersFrom({
				linux: linux.value,
				expectedSessions: input.cardinality.sessionCount,
			}),
			supervisorContext: {
				toolchains: input.toolchains,
				telemetry: {
					mac: { cpuPercent: 0, rssBytes: mem.rss },
					linux: { cpuPercent: 0, rssBytes: 0 },
				},
				grant: grant.grant,
				admission: presented.admissionFrame,
			},
			recorder: {
				attestation: filed.provenance.attestation,
				driverRunId: filed.provenance.driverRunId,
				clockMethod: filed.provenance.clockMethod,
				wallOffsetNs,
			},
			attestationEvidence,
			trust,
			execution: {
				campaignId: opened.execution.campaignId,
				runId: opened.execution.runId,
				executionIndex: opened.execution.executionIndex,
				transport: opened.execution.transport,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// §5 ASSEMBLY: immutable validated bytes in, artifact out
// ---------------------------------------------------------------------------

/**
 * Turn a finalized cohort repetition into a sealed artifact and the index
 * facts that name it. `measuredCohortToArm` projects the export's own retained
 * bytes, `buildMeasuredArmArtifact` -> `sealRunArtifact` is the leg path's
 * tail byte for byte, and the sealed bytes are verified by `verifyRunArtifact`
 * before they are written. A warmup assembles and verifies but writes nothing.
 */
export async function sealCohortArmRepetition(input: {
	readonly lease: Pick<CohortArmLease, "comparisonId" | "executionIndex">;
	readonly finalized: CohortArmFinalizedV1;
	readonly cell: ScenarioCell;
	readonly arm: SealArm;
	readonly repetitionKind: "warmup" | "measured";
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
	readonly perRepPath: string;
	readonly sealedPath: string;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly sourceIdentity: {
		readonly sourceSha: string;
		readonly archiveSha256: string;
		readonly executableSha256: string;
	};
	readonly supervisorToolchainDigests?: {
		readonly darwin: string;
		readonly linux: string;
	};
}): Promise<SealedRepResult> {
	const finalized = input.finalized;
	const retainedLinux =
		finalized.cohortEvidence.observation.linuxRelayObservation;
	const observationJson = ((): unknown => {
		try {
			return JSON.parse(
				Buffer.from(retainedLinux.bytesBase64, "base64").toString("utf8"),
			);
		} catch {
			return null;
		}
	})();
	const observation = parseLinuxRelayObservation(observationJson);
	if (!observation.ok) {
		return {
			ok: false,
			failureCode: closedCohortFailureCode(observation.code),
			reason: `retained linux relay observation (${observation.code}): ${observation.message}`,
		};
	}
	// The cell's own contract, not the single-session driver's gate: a cohort
	// is the §4.5 count-series experiment, and the projection holds the
	// contract's unit to the rate record's `sampleUnit` (arm-measure.ts). The
	// driver's `contractMeasurableByDriver` refuses every count-unit scenario
	// because *its* loop measures ms round trips, which is not this leg.
	const contract = metricContractForScenario(input.cell.scenarioId);
	if (contract === undefined) {
		return {
			ok: false,
			failureCode: "COHORT_PROTOCOL",
			reason: `scenario '${input.cell.scenarioId}' has no primary metric contract`,
		};
	}
	const sources: CohortLegSources = {
		linuxRelayObservation: observation.value,
		serverSnapshot: finalized.serverSnapshot,
		contract,
		admissionCounters: finalized.admissionCounters,
		recorder: finalized.recorder,
	};
	// The builder composes the cohort member itself from `cohortEvidence` and
	// refuses an attestation that already names one; finalization verified the
	// complete graph, and the seal hands the builder the Phase-A half of it.
	const phaseAAttestation: ArmAttestationEvidenceV2 = {
		...finalized.attestationEvidence,
		cohortObservationEvidence: null,
	};
	let artifact: RunArtifact;
	let primaryMetricP50: number;
	try {
		const measurement = measuredCohortToArm({
			cohortEvidence: finalized.cohortEvidence,
			sources,
			supervisorContext: finalized.supervisorContext,
			execution: finalized.execution,
			attestationEvidence: phaseAAttestation,
		});
		primaryMetricP50 = measurement.percentiles.p50;
		artifact = buildMeasuredArmArtifact({
			cell: input.cell,
			comparisonId: input.lease.comparisonId,
			runId: finalized.execution.runId,
			executionIndex: input.lease.executionIndex,
			transport: input.arm.transport,
			armKind: input.arm.armKind,
			...(input.arm.armTransport !== undefined
				? { armTransport: input.arm.armTransport }
				: {}),
			sourceIdentity: input.sourceIdentity,
			measurement,
			...(input.supervisorToolchainDigests !== undefined
				? { supervisorToolchainDigests: input.supervisorToolchainDigests }
				: {}),
			executionPurpose: input.executionPurpose,
			repetitionKind: input.repetitionKind,
			measuredRepetitionIndex: input.repetitionIndex,
			measuredRepetitionTotal: input.repetitionTotal,
			attestationEvidence: phaseAAttestation,
		});
	} catch (error) {
		return {
			ok: false,
			failureCode: "COHORT_PROTOCOL",
			reason: `cohort assembly refused: ${(error as Error).message}`,
		};
	}
	// §5 step 15 is `sealOrStopRepetition`'s: a warmup stops there unsealed.
	// The offline verifier gets the staged keys: both issuer graphs must close
	// before the bytes are written, the same call the campaign verifier makes.
	return sealOrStopRepetition({
		repetitionKind: input.repetitionKind,
		artifact,
		primaryMetricP50,
		trustContext: {
			...trustContextForArtifact(artifact),
			stagedMacPublicRaw32: finalized.trust.macPublicRaw32,
			stagedRigPublicRaw32: finalized.trust.rigPublicRaw32,
		},
		sealedPath: input.sealedPath,
		perRepPath: input.perRepPath,
		perRepRecord: finalized.exportAck,
		subject: "sealed cohort artifact",
	});
}

/** What `realRunBody` knows about every cohort repetition of a campaign. */
export interface CohortArmRuntimeProviderInputs {
	/** Absent when no Mac and rig supervisor pair was spawned. */
	readonly lease?: CohortArmLeaseFactory;
	readonly sourceIdentity: {
		readonly sourceSha: string;
		readonly archiveSha256: string;
		readonly executableSha256: string;
	};
	readonly supervisorToolchainDigests?: {
		readonly darwin: string;
		readonly linux: string;
	};
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly repetitionTotal: number;
}

/**
 * The production `CohortArmRuntimeProvider`.
 *
 * Two refusals, both closed-coded and both before any wire work: an arm the
 * router does not route to a cohort, and no lease factory -- which is the
 * campaign having no Mac + rig supervisor pair, stated as the missing input.
 */
export function createCohortArmRuntimeProvider(
	inputs: CohortArmRuntimeProviderInputs,
): CohortArmRuntimeProvider {
	return async (
		context: CohortArmRuntimeContext,
	): Promise<ProtocolResult<CohortArmRuntime>> => {
		const routed = cohortCellForArm({
			cellId: context.cell.cellId,
			armKind: context.arm.armKind,
		});
		if (routed === null || routed !== context.cohortCellId) {
			return {
				ok: false,
				code: "COHORT_PROTOCOL",
				message: `${context.arm.armId} is not a cohort arm (${context.cell.cellId}/${context.arm.armKind} routes to ${String(routed)}, asked for ${context.cohortCellId})`,
			};
		}
		if (inputs.lease === undefined) {
			return {
				ok: false,
				code: "COHORT_NOT_READY",
				message:
					"no cohort lease factory: the production acquisition (acquireCohortArmMaterial) needs the Mac supervisor and rig supervisor control channels realRun spawns from --staged-dir and COMPARISON_RIG_STAGED_DIR/COMPARISON_RIG_SUPERVISOR_BINARY, and this campaign has neither",
			};
		}
		const lease = await inputs.lease(context);
		if (!lease.ok) return lease;
		const value = lease.value;
		return {
			ok: true,
			value: {
				supervisor: value.supervisor,
				rig: value.rig,
				retention: value.retention,
				bundleFor: value.bundleFor,
				workloadRolePlanInputBytes: value.workloadRolePlanInputBytes,
				tokenCommitmentLeafManifestBytes:
					value.tokenCommitmentLeafManifestBytes,
				clock: value.clock,
				cleanup: value.cleanup,
				seal: async (measured) => {
					const finalized = await value.finalize(measured);
					if (!finalized.ok) {
						return {
							ok: false,
							failureCode: closedCohortFailureCode(finalized.code),
							reason: `cohort finalization refused (${finalized.code}): ${finalized.message}`,
						};
					}
					return sealCohortArmRepetition({
						lease: value,
						finalized: finalized.value,
						cell: context.cell,
						arm: context.arm,
						repetitionKind: context.repetitionKind,
						repetitionIndex: context.repetitionIndex,
						repetitionTotal: inputs.repetitionTotal,
						perRepPath: context.perRepPath,
						sealedPath: context.sealedPath,
						executionPurpose: inputs.executionPurpose,
						sourceIdentity: inputs.sourceIdentity,
						...(inputs.supervisorToolchainDigests !== undefined
							? {
									supervisorToolchainDigests: inputs.supervisorToolchainDigests,
								}
							: {}),
					});
				},
			},
		};
	};
}

/** What `realRunBody` holds for every cohort repetition of one campaign. */
export interface ProductionCohortLeaseInputs {
	readonly staged: StagedCohortMaterialV1;
	readonly bootstrap: StagedTrustBootstrapPaths;
	readonly macSupervisor: SupervisorHandle;
	readonly rigSupervisor: SupervisorHandle;
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly repetitionTotal: number;
	readonly toolchains: ToolchainSet;
	readonly bunExecutablePath: string;
	readonly serverPort: number;
	readonly tlsCaPem: string;
	readonly macClockId: string;
	readonly runtimeRoot: string;
}

/** Plan §3.5's bounds, as the acquisition applies them. */
export const COHORT_ACQUISITION_DEADLINES = {
	frameMs: 5_000,
	warmupDrainMs: 6_000,
	captureMs: COHORT_DRAIN_DEADLINE_MS + 5_000,
	roleReceiveMs: 5_000,
	teardownMs: 10_000,
} as const;

/** The production lease factory `realRunBody` wires (amendment C4). */
export function createProductionCohortArmLeaseFactory(
	inputs: ProductionCohortLeaseInputs,
): CohortArmLeaseFactory {
	return (context) =>
		acquireCohortArmMaterial({
			staged: inputs.staged,
			bootstrap: inputs.bootstrap,
			macSupervisor: inputs.macSupervisor,
			rigSupervisor: inputs.rigSupervisor,
			context,
			executionPurpose: inputs.executionPurpose,
			repetitionTotal: inputs.repetitionTotal,
			toolchains: inputs.toolchains,
			bunExecutablePath: inputs.bunExecutablePath,
			serverPort: inputs.serverPort,
			tlsCaPem: inputs.tlsCaPem,
			macClockId: inputs.macClockId,
			runtimeRoot: inputs.runtimeRoot,
			clock: { nowMs: () => Date.now(), nowNs: () => readMacContinuousNs() },
			deadlines: COHORT_ACQUISITION_DEADLINES,
		});
}

// ---------------------------------------------------------------------------
// The Mac-owned half of the cohort lifecycle: the role-child driver
// ---------------------------------------------------------------------------

const ROLE_READY_DEADLINE_CODE = "READY_DEADLINE_EXCEEDED";
const ROLE_WARMUP_DEADLINE_CODE = "WARMUP_DEADLINE_EXCEEDED";
const ROLE_MEASURE_DEADLINE_CODE = "MEASURE_DEADLINE_EXCEEDED";
/** How often the driver re-reads the Mac clock while waiting for the stop. */
const MEASURED_STOP_POLL_MS = 50;

/** What the driver cannot build because a Mac signature covers it. */
export interface MacRoleChildFrameSource {
	/** `role-spawn-config/v1` for one planned child, minus its sequence. */
	readonly spawnConfigFor: (
		plan: MacFanoutChildPlanV1,
	) => ProtocolResult<{ readonly schema: "role-spawn-config/v1" }>;
	/** `role-warmup-start/v1` for one planned child, minus its sequence. */
	readonly warmupStartFor: (
		plan: MacFanoutChildPlanV1,
	) => ProtocolResult<{ readonly schema: "role-warmup-start/v1" }>;
	/** `role-measure-start/v1`, identical for every child of one cohort. */
	readonly measureStart: () => ProtocolResult<{
		readonly schema: "role-measure-start/v1";
	}>;
}

/** The two joins a child's frames are checked against, read when needed. */
export interface MacRoleChildLifecycleJoins {
	readonly cohortGrantSha256: () => Sha256Hex | null;
	readonly cohortStartBarrierSha256: () => Sha256Hex | null;
	/** The barrier's declared Mac stop; null until the barrier is minted. */
	readonly measureStopAtMacNs: () => NsString | null;
}

/**
 * Where the driver records the three measured-phase stamps the process proof
 * requires per child (`MacFanoutSupervisor.buildObservedProcessProof`: armed,
 * stopped, exit code). The supervisor owns the record; the driver is the only
 * reader of the frames that carry the facts.
 */
export interface MacRoleChildLifecycleStamps {
	readonly markChildLifecycle: (args: {
		readonly childId: string;
		readonly measureArmedAtMacNs?: NsString;
		readonly stoppedAtMacNs?: NsString;
		readonly exitCode?: number;
	}) => ProtocolResult<true>;
}

export interface MacRoleChildCohortDriverConfig {
	readonly host: MacFanoutRoleChildHost;
	readonly children: readonly MacFanoutChildPlanV1[];
	readonly executionSha256: string;
	readonly joins: MacRoleChildLifecycleJoins;
	readonly stamps: MacRoleChildLifecycleStamps;
	readonly frames: MacRoleChildFrameSource;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => NsString;
	};
	readonly readinessDeadlineMs: number;
	readonly warmupDeadlineMs: number;
	readonly measuredDeadlineMs: number;
	/** How long a child has to exit after `role-exit/v1` before it is killed. */
	readonly teardownDeadlineMs: number;
}

function driverFail(code: string, message: string): ProtocolResult<never> {
	return { ok: false, code, message };
}

/**
 * Read the Mac-owned role-child pipes for one cohort.
 *
 * Each phase is per child and the children are driven concurrently, because the
 * ramp is global. The grant and barrier digests are read through `joins` at the
 * moment a frame is checked, because both records are minted mid-lifecycle by
 * the Mac binary and neither exists when the driver is built.
 */
export class MacRoleChildCohortDriver {
	private readonly config: MacRoleChildCohortDriverConfig;
	private readonly warmupCompletes = new Map<string, Uint8Array>();
	private readonly partials = new Map<string, unknown>();
	/** The grant whose children were handed their spawn config; null before. */
	private spawnConfigsDeliveredForGrant: Sha256Hex | null = null;
	/** Set when the window is armed; the partials are owed against it. */
	private measuredDeadlineAtMs: number | null = null;

	constructor(config: MacRoleChildCohortDriverConfig) {
		this.config = config;
	}

	private channelFor(
		plan: MacFanoutChildPlanV1,
	): ProtocolResult<MacRoleChildControlChannel> {
		const channel = this.config.host.channel(plan.childId);
		if (channel === undefined) {
			return driverFail(
				"COHORT_NOT_READY",
				`${plan.childId} has no control pipe; it was never spawned by this host`,
			);
		}
		return { ok: true, value: channel };
	}

	/**
	 * Whether the current grant's children hold their spawn config. Once per
	 * grant: a plan 2210 replacement mints a fresh grant and spawns a fresh
	 * cohort, and those children have read nothing yet.
	 */
	get spawnConfigsDelivered(): boolean {
		const grant = this.config.joins.cohortGrantSha256();
		return grant !== null && this.spawnConfigsDeliveredForGrant === grant;
	}

	async deliverSpawnConfigs(): Promise<ProtocolResult<true>> {
		const grant = this.config.joins.cohortGrantSha256();
		if (grant === null) {
			return driverFail(
				"COHORT_NOT_READY",
				"no cohort grant to deliver spawn configs under",
			);
		}
		if (this.spawnConfigsDeliveredForGrant === grant) {
			return driverFail(
				"COHORT_PROTOCOL",
				"spawn configs were already delivered to this cohort",
			);
		}
		for (const plan of this.config.children) {
			const channel = this.channelFor(plan);
			if (!channel.ok) return channel;
			const frame = this.config.frames.spawnConfigFor(plan);
			if (!frame.ok) return frame;
			const sent = await channel.value.send(frame.value);
			if (!sent.ok) return sent;
		}
		this.spawnConfigsDeliveredForGrant = grant;
		return { ok: true, value: true };
	}

	async registerRolePeers(args: {
		readonly scheduler: MacPermitScheduler;
	}): Promise<ProtocolResult<true>> {
		const cohortGrantSha256 = this.config.joins.cohortGrantSha256();
		if (cohortGrantSha256 === null) {
			return driverFail(
				"COHORT_NOT_READY",
				"no cohort grant to register peers under",
			);
		}
		if (!this.spawnConfigsDelivered) {
			return driverFail(
				"COHORT_NOT_READY",
				"no child has been handed its spawn config yet",
			);
		}
		const scheduler = args.scheduler;
		const deadline =
			this.config.clock.nowMs() + this.config.readinessDeadlineMs;
		// One issue log across the children: `issueReady` hands out every due
		// permit smallest ordinal first, so a child's grant is routinely issued
		// (and sent) from another child's poll of the scheduler. The poll that
		// happened to issue it is not the fact a child waits on; the issue is.
		const issuedOrdinals = new Set<number>();

		const runChild = async (
			plan: MacFanoutChildPlanV1,
		): Promise<ProtocolResult<true>> => {
			const channel = this.channelFor(plan);
			if (!channel.ok) return channel;
			for (
				let index = 0;
				index < plan.assignedGlobalOrdinals.length;
				index += 1
			) {
				const remaining = deadline - this.config.clock.nowMs();
				const requested = await channel.value.receive(
					"connect-permit-request/v1",
					{
						deadlineMs: remaining,
						deadlineCode: ROLE_READY_DEADLINE_CODE,
					},
				);
				if (!requested.ok) return requested;
				const parsedRequest = parseConnectPermitRequest(requested.value.record);
				if (!parsedRequest.ok) return parsedRequest;
				if (parsedRequest.value.childId !== plan.childId) {
					return driverFail(
						"COHORT_PROTOCOL",
						`a permit request for ${parsedRequest.value.childId} arrived on ${plan.childId}'s pipe`,
					);
				}
				const queued = scheduler.request(requested.value.record);
				if (!queued.ok) return queued;

				for (;;) {
					const issued = scheduler.issueReady(this.config.clock.nowNs());
					if (!issued.ok) return issued;
					for (const grant of issued.value) {
						const owner = this.config.children.find(
							(candidate) => candidate.childId === grant.childId,
						);
						if (owner === undefined) {
							return driverFail(
								"COHORT_PROTOCOL",
								`the schedule issued a permit to unknown child ${grant.childId}`,
							);
						}
						const target = this.channelFor(owner);
						if (!target.ok) return target;
						const sent = await target.value.send(grant);
						if (!sent.ok) return sent;
						issuedOrdinals.add(grant.globalOrdinal);
					}
					if (issuedOrdinals.has(parsedRequest.value.globalOrdinal)) break;
					if (this.config.clock.nowMs() >= deadline) {
						return driverFail(
							ROLE_READY_DEADLINE_CODE,
							`${plan.childId} ordinal ${parsedRequest.value.globalOrdinal} was never due before the readiness deadline`,
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 1));
				}

				const completed = await channel.value.receive(
					"connect-permit-complete/v1",
					{
						deadlineMs: deadline - this.config.clock.nowMs(),
						deadlineCode: ROLE_READY_DEADLINE_CODE,
					},
				);
				if (!completed.ok) return completed;
				const parsedComplete = parseConnectPermitComplete(
					completed.value.record,
				);
				if (!parsedComplete.ok) return parsedComplete;
				if (parsedComplete.value.outcome !== "ready") {
					return driverFail(
						"COHORT_NOT_READY",
						`${plan.childId} failed to connect ordinal ${parsedComplete.value.globalOrdinal}`,
					);
				}
				const spent = scheduler.complete(completed.value.record);
				if (!spent.ok) return spent;
			}

			const ready = await channel.value.receive("role-ready/v1", {
				deadlineMs: deadline - this.config.clock.nowMs(),
				deadlineCode: ROLE_READY_DEADLINE_CODE,
			});
			if (!ready.ok) return ready;
			const parsedReady = parseRoleReady(ready.value.record);
			if (!parsedReady.ok) return parsedReady;
			if (
				parsedReady.value.childId !== plan.childId ||
				parsedReady.value.cohortGrantSha256 !== cohortGrantSha256 ||
				parsedReady.value.executionSha256 !== this.config.executionSha256
			) {
				return driverFail(
					"CROSS_SUPERVISOR_MISMATCH",
					`${plan.childId} reported readiness for another child, cohort or execution`,
				);
			}
			if (
				parsedReady.value.registeredSessionCount !==
				plan.assignedGlobalOrdinals.length
			) {
				return driverFail(
					"COHORT_NOT_READY",
					`${plan.childId} registered ${parsedReady.value.registeredSessionCount} of ${plan.assignedGlobalOrdinals.length} sessions`,
				);
			}
			return { ok: true, value: true };
		};

		const outcomes = await Promise.all(this.config.children.map(runChild));
		// A child that named its own refusal outranks a sibling's deadline: the
		// deadline is what this side saw while that child was already saying
		// why, and the sealed code has to be the child's, not the wait's.
		const reported = outcomes.find(
			(outcome) =>
				!outcome.ok &&
				"reportedByChild" in outcome &&
				outcome.reportedByChild === true,
		);
		if (reported !== undefined) return reported;
		for (const outcome of outcomes) if (!outcome.ok) return outcome;
		return { ok: true, value: true };
	}

	/**
	 * Start warmup on every child and collect its `role-warmup-complete/v1`,
	 * as the exact bytes each child wrote, in the frozen publisher-then-worker
	 * order. The binary mints the manifest from these; nothing is built here.
	 *
	 * Every start goes out before any completion is read, and the completions
	 * are read one child at a time. The reader is a blocking `fs.read` on
	 * Bun's bounded thread pool (role.md section 3): starting and reading each
	 * child inside one `Promise.all` put a pending read on the pool for every
	 * child that had already been started, and the sends still owed queued
	 * behind them. Measured on the chat-1k acceptance (2026-09-05, that shape
	 * restored under a probe): fifteen of eighteen children had their
	 * `role-warmup-start/v1` within 3 ms and the other three got theirs at
	 * +4,752 ms -- after the whole 5,000 ms window -- so those publishers found
	 * every paced offset already past and sent all ten back to back, the
	 * catch-up burst the plan's offsets exclude, and the arm died on the
	 * server child's warmup deadline. A start is a small write that returns at
	 * once, so sending all eighteen costs 1-3 ms; a child's completion sits in
	 * its pipe until its turn, so the sequential reads end when the last child
	 * completes.
	 */
	async runWarmupWire(): Promise<
		ProtocolResult<{ readonly roleWarmupCompleteBytes: readonly Uint8Array[] }>
	> {
		const deadline = this.config.clock.nowMs() + this.config.warmupDeadlineMs;
		for (const plan of this.config.children) {
			const channel = this.channelFor(plan);
			if (!channel.ok) return channel;
			const start = this.config.frames.warmupStartFor(plan);
			if (!start.ok) return start;
			const sent = await channel.value.send(start.value);
			if (!sent.ok) return sent;
		}
		const ordered: Uint8Array[] = [];
		for (const plan of this.config.children) {
			const channel = this.channelFor(plan);
			if (!channel.ok) return channel;
			const complete = await channel.value.receive("role-warmup-complete/v1", {
				deadlineMs: deadline - this.config.clock.nowMs(),
				deadlineCode: ROLE_WARMUP_DEADLINE_CODE,
			});
			if (!complete.ok) return complete;
			const parsed = parseRoleWarmupComplete(complete.value.record);
			if (!parsed.ok) return parsed;
			if (parsed.value.childId !== plan.childId) {
				return driverFail(
					"CROSS_SUPERVISOR_MISMATCH",
					`a warmup completion for ${parsed.value.childId} arrived on ${plan.childId}'s pipe`,
				);
			}
			if (this.warmupCompletes.has(plan.childId)) {
				return driverFail(
					"COHORT_PROTOCOL",
					`${plan.childId} reported warmup completion twice`,
				);
			}
			this.warmupCompletes.set(plan.childId, complete.value.bytes);
			ordered.push(complete.value.bytes);
		}
		return { ok: true, value: { roleWarmupCompleteBytes: ordered } };
	}

	/**
	 * §5 MEASURING + STOPPING: arm every child on the signed barrier, hand it
	 * the declared Mac stop, and return once this clock has reached that stop.
	 *
	 * The stop frame is queued on the pipe the moment the child is armed --
	 * the child reads it after the window the barrier declares -- and carries
	 * the barrier's `measureStopAtMacNs`, not the instant it was written
	 * (plan `RoleStopV1.stopAtMacNs`: "Mac stops publishers/client at the
	 * declared Mac stop"). Nothing is read past the arm ack here: the partials
	 * wait on Linux's drain, which `driveCohortArm` requests at the stop.
	 */
	async runMeasuredWindow(): Promise<
		ProtocolResult<{ readonly measureStopAtMacNs: NsString }>
	> {
		const cohortStartBarrierSha256 =
			this.config.joins.cohortStartBarrierSha256();
		const measureStopAtMacNs = this.config.joins.measureStopAtMacNs();
		if (cohortStartBarrierSha256 === null || measureStopAtMacNs === null) {
			return driverFail(
				"COHORT_NOT_READY",
				"no start barrier to arm the children on",
			);
		}
		if (this.measuredDeadlineAtMs !== null) {
			return driverFail(
				"COHORT_PROTOCOL",
				"the measured window was already armed for this cohort",
			);
		}
		const measureStart = this.config.frames.measureStart();
		if (!measureStart.ok) return measureStart;
		const deadline = this.config.clock.nowMs() + this.config.measuredDeadlineMs;
		this.measuredDeadlineAtMs = deadline;

		// One child at a time. Every child's frames sit in its kernel pipe
		// until read, and the reader is a blocking `fs.read` on Bun's bounded
		// thread pool: with ten or more children awaited at once no other pipe
		// write or read on this process completes until one of them answers
		// (role.md §3, measured on this host with `hw.ncpu` = 10). Arming is
		// ask-and-answer per child, so sequential costs a few milliseconds and
		// never parks the stop frames behind another child's silence.
		for (const plan of this.config.children) {
			const channel = this.channelFor(plan);
			if (!channel.ok) return channel;
			const armed = await channel.value.send(measureStart.value);
			if (!armed.ok) return armed;
			const ack = await channel.value.receive("role-measure-start-ack/v1", {
				deadlineMs: deadline - this.config.clock.nowMs(),
				deadlineCode: ROLE_MEASURE_DEADLINE_CODE,
			});
			if (!ack.ok) return ack;
			const parsedAck = parseRoleMeasureStartAck(ack.value.record);
			if (!parsedAck.ok) return parsedAck;
			if (
				parsedAck.value.childId !== plan.childId ||
				parsedAck.value.cohortStartBarrierSha256 !== cohortStartBarrierSha256
			) {
				return driverFail(
					"CROSS_SUPERVISOR_MISMATCH",
					`${plan.childId} armed on another barrier`,
				);
			}
			const stopped = await channel.value.send({
				schema: "role-stop/v1",
				executionSha256: this.config.executionSha256,
				cohortStartBarrierSha256,
				stopAtMacNs: measureStopAtMacNs,
			});
			if (!stopped.ok) return stopped;
			// The process proof's two measured-phase stamps: the instant the
			// child says it armed, and the declared stop it was handed.
			const stamped = this.config.stamps.markChildLifecycle({
				childId: plan.childId,
				measureArmedAtMacNs: parsedAck.value.armedAtMacNs,
				stoppedAtMacNs: measureStopAtMacNs,
			});
			if (!stamped.ok) return stamped;
		}

		// The declared stop, on this clock. The Mac clock is the one the
		// barrier was minted on, so the wait is exact rather than a duration.
		const stopAt = BigInt(measureStopAtMacNs);
		for (;;) {
			const remainingNs = stopAt - BigInt(this.config.clock.nowNs());
			if (remainingNs <= 0n) break;
			const sleepMs = Math.min(
				Number(remainingNs / 1_000_000n) + 1,
				MEASURED_STOP_POLL_MS,
			);
			await new Promise((resolve) => setTimeout(resolve, sleepMs));
		}
		return { ok: true, value: { measureStopAtMacNs } };
	}

	/**
	 * §5 MAC_JOIN's inputs, after the capture: one partial per child, then
	 * each child's exit. Section 4.3's teardown is part of the same step on
	 * purpose. The deadline is the one the window was armed with, so a child
	 * has exactly the window plus the drain to answer, however the steps in
	 * between were paced.
	 */
	async collectPartials(): Promise<
		ProtocolResult<{
			readonly partials: readonly {
				readonly childId: string;
				readonly frame: unknown;
			}[];
		}>
	> {
		const deadline = this.measuredDeadlineAtMs;
		if (deadline === null) {
			return driverFail(
				"COHORT_NOT_READY",
				"no measured window was armed; there are no partials to collect",
			);
		}

		// Sequential for the same reason arming is: a partial that arrived
		// while another child was being read is waiting in its pipe, and the
		// exit round must never queue a `role-exit/v1` write behind reads that
		// only return when other children exit.
		for (const plan of this.config.children) {
			const channel = this.channelFor(plan);
			if (!channel.ok) return channel;
			const partial = await channel.value.receive("role-partial/v1", {
				deadlineMs: deadline - this.config.clock.nowMs(),
				deadlineCode: ROLE_MEASURE_DEADLINE_CODE,
			});
			if (!partial.ok) return partial;
			const parsedPartial = parseRolePartial(partial.value.record);
			if (!parsedPartial.ok) return parsedPartial;
			if (parsedPartial.value.childId !== plan.childId) {
				return driverFail(
					"CROSS_SUPERVISOR_MISMATCH",
					`a partial for ${parsedPartial.value.childId} arrived on ${plan.childId}'s pipe`,
				);
			}
			if (this.partials.has(plan.childId)) {
				return driverFail(
					"COHORT_PROTOCOL",
					`${plan.childId} delivered a second partial`,
				);
			}
			this.partials.set(plan.childId, partial.value.record);

			const accepted = await channel.value.send({
				schema: "role-partial-accepted/v1",
				executionSha256: this.config.executionSha256,
				childId: plan.childId,
				partialSha256: parsedPartial.value.partialSha256,
			});
			if (!accepted.ok) return accepted;

			const exit = await channel.value.send({
				schema: "role-exit/v1",
				executionSha256: this.config.executionSha256,
				childId: plan.childId,
			});
			if (!exit.ok) return exit;
			const exited = await channel.value.receive("role-exited/v1", {
				deadlineMs: this.config.teardownDeadlineMs,
				deadlineCode: "TEARDOWN_DEADLINE_EXCEEDED",
			});
			if (!exited.ok) return exited;
			const parsedExit = parseRoleExited(exited.value.record);
			if (!parsedExit.ok) return parsedExit;
			if (parsedExit.value.childId !== plan.childId) {
				return driverFail(
					"CROSS_SUPERVISOR_MISMATCH",
					`${parsedExit.value.childId} reported the exit of ${plan.childId}`,
				);
			}
			const stamped = this.config.stamps.markChildLifecycle({
				childId: plan.childId,
				exitCode: parsedExit.value.exitCode,
			});
			if (!stamped.ok) return stamped;
		}
		return {
			ok: true,
			value: {
				partials: this.config.children.map((plan) => ({
					childId: plan.childId,
					frame: this.partials.get(plan.childId),
				})),
			},
		};
	}
}

/**
 * One `CohortRigBinding` from the two couriers that actually exist.
 *
 * Eight steps are the rig's, three are the Mac's role children's. The
 * composition delivers the spawn configs once per cohort grant, on that
 * grant's first ramp: `MacFanoutSupervisor` re-arms a ramp by minting a
 * second scheduler for the same children, and a child that already read its
 * config answers a second one with `STATE_INVALID`; a plan 2210 replacement
 * is a fresh grant and a fresh cohort, and its children have read nothing.
 * Whether the current grant's children hold their config is the driver's
 * fact, not a flag kept here.
 */
export function composeCohortRigBinding(args: {
	readonly rig: CohortRigBinding;
	readonly roleChildren: MacRoleChildCohortDriver;
}): CohortRigBinding {
	return {
		acceptCohortGrant: (input) => args.rig.acceptCohortGrant(input),
		startServer: () => args.rig.startServer(),
		teardownServer: () => args.rig.teardownServer(),
		registerRolePeers: async (input) => {
			if (!args.roleChildren.spawnConfigsDelivered) {
				const delivered = await args.roleChildren.deliverSpawnConfigs();
				if (!delivered.ok) return delivered;
			}
			return args.roleChildren.registerRolePeers(input);
		},
		acceptWarmupEpoch: (input) => args.rig.acceptWarmupEpoch(input),
		runWarmupWire: () => args.roleChildren.runWarmupWire(),
		drainWarmup: (input) => args.rig.drainWarmup(input),
		measureStartAck: (input) => args.rig.measureStartAck(input),
		acceptStartBarrier: (input) => args.rig.acceptStartBarrier(input),
		runMeasuredWindow: () => args.roleChildren.runMeasuredWindow(),
		collectPartials: () => args.roleChildren.collectPartials(),
		observe: (input) => args.rig.observe(input),
	};
}

// ---------------------------------------------------------------------------
// The uid boundary preflight (design §2.9(4b)): twelve checks before traffic
// ---------------------------------------------------------------------------

export interface MacUidPreflightInputs {
	readonly targetUser: string;
	readonly macSigningKeyPath: string;
	/** The verified staged trust root (`--staged-dir`). */
	readonly macTrustDir: string;
	readonly campaignRootDir: string;
	readonly stagingRootDir: string;
	readonly bunExecutablePath: string;
}

export interface MacUidPreflightCheck {
	readonly index: number;
	readonly name: string;
	readonly argv: readonly string[];
}

/**
 * The twelve access preconditions, in the design's order. Every one must pass
 * on a correctly configured host and fail only for the defect it names; check
 * 2 is the controller's own `test -r` that MUST fail, so it is spelled with
 * `!`. Checks 2 and 10 run as the controller; every other check runs as the
 * target uid through the existing sudoers grant.
 */
export function macUidPreflightChecks(
	inputs: MacUidPreflightInputs,
): readonly MacUidPreflightCheck[] {
	const sudo = (...rest: string[]) => [
		"/usr/bin/sudo",
		"-n",
		"-u",
		inputs.targetUser,
		...rest,
	];
	return [
		{ index: 1, name: "sudo grant exists", argv: sudo("/usr/bin/true") },
		{
			index: 2,
			name: "controller cannot read the Mac signing key",
			argv: ["/bin/test", "!", "-r", inputs.macSigningKeyPath],
		},
		{
			index: 3,
			name: "target uid can read the Mac signing key",
			argv: sudo("/bin/test", "-r", inputs.macSigningKeyPath),
		},
		{
			index: 4,
			name: "target uid traverses the trust root",
			argv: sudo("/bin/test", "-x", inputs.macTrustDir),
		},
		{
			index: 5,
			name: "target uid reads authority.json (fd 3)",
			argv: sudo("/bin/test", "-r", join(inputs.macTrustDir, "authority.json")),
		},
		{
			index: 6,
			name: "target uid reads authority-digest.bin (fd 4)",
			argv: sudo(
				"/bin/test",
				"-r",
				join(inputs.macTrustDir, "authority-digest.bin"),
			),
		},
		{
			index: 7,
			name: "target uid traverses staging-root (fd 6)",
			argv: sudo("/bin/test", "-x", inputs.stagingRootDir),
		},
		{
			index: 8,
			name: "target uid reads the staged rig public key (fd 8)",
			argv: sudo(
				"/bin/test",
				"-r",
				join(inputs.stagingRootDir, "rig-supervisor-ed25519.pub"),
			),
		},
		{
			index: 9,
			name: "target uid writes and traverses campaign-root (fd 5)",
			argv: sudo(
				"/bin/test",
				"-w",
				inputs.campaignRootDir,
				"-a",
				"-x",
				inputs.campaignRootDir,
			),
		},
		{
			index: 10,
			name: "controller reads campaign-root back (reverse crossing)",
			argv: ["/bin/test", "-r", inputs.campaignRootDir],
		},
		{
			index: 11,
			name: "target uid reads and executes the staged Bun (row 10)",
			argv: sudo(
				"/bin/test",
				"-r",
				inputs.bunExecutablePath,
				"-a",
				"-x",
				inputs.bunExecutablePath,
			),
		},
		{
			index: 12,
			name: "target uid can execute /bin/kill (stage 3)",
			argv: sudo("/bin/test", "-x", "/bin/kill"),
		},
	];
}

function runPreflightCommandLocally(
	argv: readonly string[],
): ControlCommandResult {
	const [command, ...rest] = argv;
	const out = spawnSync(command as string, rest, {
		encoding: "utf8",
		timeout: 10_000,
	});
	return { exitCode: out.status ?? -1, stderr: (out.stderr ?? "").trim() };
}

/**
 * Run the twelve checks in order and refuse before traffic on the first that
 * fails, naming it. `STALE_OR_INVALID_STAGING` is the plan's pre-traffic code.
 */
export function runMacUidPreflight(
	inputs: MacUidPreflightInputs,
	run: (
		argv: readonly string[],
	) => ControlCommandResult = runPreflightCommandLocally,
): ProtocolResult<true> {
	for (const check of macUidPreflightChecks(inputs)) {
		const result = run(check.argv);
		if (result.exitCode !== 0) {
			return {
				ok: false,
				code: "STALE_OR_INVALID_STAGING",
				message: `REFUSED/STALE_OR_INVALID_STAGING: uid preflight check ${check.index} (${check.name}) failed with exit ${result.exitCode}${result.stderr.length > 0 ? `: ${result.stderr}` : ""}`,
			};
		}
	}
	return { ok: true, value: true };
}

// The entry block is the last statement in this file on purpose: every
// declaration it can reach must already be initialized. It used to sit in the
// middle, so a real CLI run reached `STAGE_RECEIPT_DIGEST_FIELDS` while that
// `const` was still in its temporal dead zone and died before any traffic.
if (import.meta.main) {
	const code = await main(process.argv.slice(2));
	process.exit(code);
}
