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

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
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
import { measuredLegToArm } from "../arm-measure.ts";
import { canonicalJson } from "../canonical.ts";
import {
	adapterForTransport,
	HANDSHAKE_FIRST_MESSAGE_BYTES,
	type LegPlan,
	legPlanForCell,
	type MeasuredLeg,
	measureLegOverAdapter,
} from "../client.ts";
import {
	type CohortAdmissionReceiptV1,
	type CohortGrantV1,
	cohortCellCardinality,
	type TokenBundleV1,
} from "../cohort-protocol.ts";
import type {
	CampaignRefusalCode,
	MacCohortEvidenceExportedAckV1,
	MacReceiptSignatureV1,
	ProtocolResult,
} from "../cross-supervisor-protocol.ts";
import {
	type CampaignFailureCode,
	isCampaignFailureCode,
} from "../cross-supervisor-protocol.ts";
import {
	type ArtifactTrustContext,
	cohortCellForArm,
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
	type MacFanoutChildPlanV1,
	type MacFanoutSupervisor,
	type MacPermitScheduler,
	openExecution,
	presentArtifactPayload,
	resolveSupervisorBinaryPath,
	resolveSupervisorBunPath,
	type SupervisorHandle,
	spawnMacSupervisor,
	spawnRigSupervisor,
	stopSupervisor,
	verifyStagedTrustBootstrap,
} from "../remote-supervisor.ts";
import { buildMeasuredArmArtifact } from "../run-campaign.ts";
import {
	CANONICAL_SCENARIO_REGISTRY,
	listScenarioArms,
	requestedImpairmentOf,
} from "../scenario-registry.ts";
import { createGameLedger } from "../scenarios/game.ts";
import { R1_CAMPAIGN_AUTHORITY_SHA256 } from "../secure-fs.ts";
import type { ArmAttestationEvidenceV2 } from "../server-observation-artifact.ts";
import { mintPhaseAAttestationFixture } from "../server-observation-artifact.ts";
import {
	SERVER_SNAPSHOT_SCHEMA,
	type ServerSnapshotRecord,
} from "../server-snapshot-protocol.ts";
import type { MeasurementSeries } from "../supervisor-protocol.ts";
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

/** Wire transports the Phase-4 / full-matrix seal path can open. */
export type SealTransport = "ws" | "wt";

/** Phase-4 first-honest gate cells (Task 4.1). Bulk first: proven Mbps seal path. */
export const PHASE4_GATE_CELLS = [
	"bulk-one-way/physical",
	"ticker-fanout/rate-10000",
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
 * ingress. The difference is the whole point of the cell: a ticker 10k arm
 * offers 100,000 records and the relay owes 10,000,000 deliveries, and a grant
 * that authorised 100,000 would let a cohort that delivered a hundredth of
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
		readonly readerBusyMs?: number;
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
					(entry) => entry.cellId === cell.cellId && entry.armKind === "primary",
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
	let failureCode: CampaignFailureCode = "TRUST_PROTOCOL";
	for (const code of [
		"MAC_GRANT_SIGNATURE_INVALID",
		"MAC_SIGNING_KEY_MISMATCH",
		"APPROVAL_IDENTITY_MISMATCH",
		"MAC_GRANT_EXPIRED",
		"MAC_GRANT_REPLAYED",
		"RIG_RECEIPT_SIGNATURE_INVALID",
		"RIG_SIGNING_KEY_MISMATCH",
		"RIG_RECEIPT_EXPIRED",
		"RIG_RECEIPT_REPLAYED",
		"TRUST_PROTOCOL",
		"CROSS_SUPERVISOR_MISMATCH",
		"COHORT_PROTOCOL",
		"COHORT_NOT_READY",
		"WARMUP_PROTOCOL",
		"MEASUREMENT_WINDOW",
		"RELAY_DELIVERY",
		"CHILD_LIFECYCLE",
		"RUNTIME_RESOURCE_EXHAUSTION",
	] as const satisfies readonly CampaignFailureCode[]) {
		if (reason.includes(code)) {
			failureCode = code;
			break;
		}
	}
	if (!isCampaignFailureCode(failureCode)) {
		failureCode = "TRUST_PROTOCOL";
	}
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
			readonly busyMs: number;
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
	let readerBusyMs = 0;
	for (const queue of queues) {
		queuedRecordsPeakBytes = Math.max(
			queuedRecordsPeakBytes,
			queue.queuedBytesPeak,
		);
		droppedByQueue += queue.dropped;
		readerBusyMs += queue.busyMs;
	}
	return {
		...(sink !== undefined
			? { sinkMode: sink.sinkMode, configuredSinkMode: sink.configuredMode }
			: {}),
		queuedRecordsPeakBytes,
		droppedByQueue,
		readerBusyMs,
	};
}

async function measureSealAndWriteRep(input: {
	readonly macSupervisor: SupervisorHandle;
	readonly rigSupervisor: SupervisorHandle;
	readonly linux: RigEndpoints["linux"];
	readonly cell: ScenarioCell;
	readonly arm: SealArm;
	/** Already cohort-scoped by `sealRunIdForArm`; used verbatim. */
	readonly runId: string;
	/**
	 * The staged identity the sealed artifact embeds as its `source` anchors:
	 * candidate git SHA, staged archive digest, staged capability digest.
	 * Required -- a seal that cannot state what was staged is not written.
	 */
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
	readonly attestedServerLoopUtilization: {
		readonly busyMs: number;
		readonly windowMs: number;
	};
	readonly executionPurpose: "focused" | "pilot" | "canonical";
	readonly repetitionKind: "warmup" | "measured";
	readonly repetitionTotal: number;
	readonly attestationEvidence: ArmAttestationEvidenceV2;
}): Promise<SealedRepResult> {
	// The grant is opened for the *wire*, which is what the supervisor admits
	// against; the arm's read-path identity is an artifact-level fact and never
	// reaches the control channel.
	const wire = input.arm.transport;
	// B4: the declaration is arm-aware. The six fanout primaries state the
	// expanded delivery count from the frozen §4.5 table; everything else keeps
	// the leg declaration. `assertFanoutGrantDeclaration` re-checks the value
	// that is actually about to be sent, so a future caller that computes its
	// own declaration is refused here rather than admitted by the supervisor.
	const grantDecl = sealGrantDeclarationForArm({
		cell: input.cell,
		armKind: input.arm.armKind,
	});
	assertFanoutGrantDeclaration({
		cell: input.cell,
		armKind: input.arm.armKind,
		declared: grantDecl,
	});
	const opened = await openExecution(
		input.macSupervisor,
		{
			runId: input.runId,
			transport: wire,
			declaredMessageCount: grantDecl.declaredMessageCount,
			declaredMessageBytes: grantDecl.declaredMessageBytes,
		},
		input.controlDeadlineMs,
	);
	if (!opened.ok) {
		return {
			ok: false,
			reason: `openExecution failed (${opened.code}): ${opened.message}`,
		};
	}
	const { grant } = opened;
	if (grant.transport !== wire) {
		return {
			ok: false,
			reason: `expected grant.transport "${wire}", got ${JSON.stringify(grant.transport)}`,
		};
	}

	const tlsCaPem = await Bun.file("/tmp/ws-wt-server.crt").text();
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
		// B4: stated, so `measureLegOverAdapter` can refuse a fanout primary
		// before it connects. The six primaries never reach this function --
		// `dispatchArmRepetition` routes them to the cohort executor -- and this
		// is the backstop that makes "never" checkable rather than assumed.
		armKind: input.arm.armKind,
		tls: {
			ca: tlsCaPem,
			serverName: "gravvene-dev-home",
			rejectUnauthorized: true,
		},
	});

	const series = measurementSeriesFromLeg(leg);
	const presented = await presentArtifactPayload(
		input.macSupervisor,
		series,
		grant,
		Math.max(input.controlDeadlineMs, 60_000),
	);
	if (!presented.ok) {
		return {
			ok: false,
			reason: `presentArtifactPayload failed (${presented.code}): ${presented.message}`,
		};
	}
	const admissionFrame = presented.admissionFrame;

	// A3: serverAggregate busyMs must come from an attested Linux snapshot.
	// Controller-synthesized zeros are forbidden (plan §3.2 / A3 cutover).
	if (input.rigSupervisor === undefined) {
		return {
			ok: false,
			reason:
				"attested serverAggregate requires both Mac and rig supervisor handles",
		};
	}
	if (
		input.attestedServerLoopUtilization === undefined ||
		!Number.isFinite(input.attestedServerLoopUtilization.busyMs) ||
		input.attestedServerLoopUtilization.busyMs < 0 ||
		!Number.isFinite(input.attestedServerLoopUtilization.windowMs) ||
		input.attestedServerLoopUtilization.windowMs <= 0
	) {
		return {
			ok: false,
			reason:
				"attested serverAggregate loopUtilization missing or non-positive window",
		};
	}

	const serverSnapshot: ServerSnapshotRecord = {
		schema: SERVER_SNAPSHOT_SCHEMA,
		campaignId: grant.campaignId,
		runId: grant.runId,
		executionIndex: grant.executionIndex,
		transport: wire,
		legId: grant.runId,
		sequence: 1,
		capturedAtMs: Date.now(),
		loopUtilization: {
			busyMs: input.attestedServerLoopUtilization.busyMs,
			windowMs: input.attestedServerLoopUtilization.windowMs,
		},
	};

	const mem = process.memoryUsage();
	const arm = measuredLegToArm({
		leg,
		serverSnapshot,
		supervisorContext: {
			toolchains: input.toolchains,
			telemetry: {
				mac: { cpuPercent: 0, rssBytes: mem.rss },
				linux: { cpuPercent: 0, rssBytes: 0 },
			},
			grant,
			admission: admissionFrame,
		},
		execution: {
			campaignId: grant.campaignId,
			runId: grant.runId,
			executionIndex: grant.executionIndex,
			transport: grant.transport,
		},
	});

	const artifact = buildMeasuredArmArtifact({
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
		attestationEvidence: input.attestationEvidence,
	});
	if (input.repetitionKind === "warmup") {
		// §6: the warmup is unsealed. The artifact above was still assembled --
		// assembling it is what proves the arm can produce one, which is the
		// whole reason to run a warmup -- but nothing is written, so no path,
		// digest or p50 exists for an index entry to point at.
		return {
			ok: true,
			primaryMetricP50: leg.percentiles.p50,
			sealedPath: "",
			artifactSha256: "",
		};
	}
	const sealed = sealRunArtifact(artifact);
	await Bun.write(input.sealedPath, sealed);
	await Bun.write(input.perRepPath, JSON.stringify(leg, null, 2));
	const artifactSha256 = createHash("sha256")
		.update(new Uint8Array(await Bun.file(input.sealedPath).arrayBuffer()))
		.digest("hex");
	const readPath = readPathDiagnosticsOf(adapter);
	return {
		ok: true,
		primaryMetricP50: leg.percentiles.p50,
		sealedPath: input.sealedPath,
		artifactSha256,
		...(readPath !== undefined ? { readPath } : {}),
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
export async function main(args: readonly string[]): Promise<number> {
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
			const runPromise = realRun(spec);
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
async function realRun(spec: RunSpec): Promise<RealRunResult> {
	let macSupervisor: SupervisorHandle | undefined;
	let rigSupervisor: SupervisorHandle | undefined;
	try {
		if (spec.stagedDir !== undefined) {
			const expectedAuthority = resolveStagedAuthorityDigest(spec.stagedDir);
			const staged = verifyStagedTrustBootstrap(
				spec.stagedDir,
				expectedAuthority,
			);
			if (!staged.ok) {
				return {
					ok: false,
					reason: `staged-dir verify failed (${staged.code}): ${staged.message}`,
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
			});
			if (!spawned.ok) {
				return {
					ok: false,
					reason: `mac supervisor spawn failed (${spawned.code}): ${spawned.message}`,
				};
			}
			macSupervisor = spawned.handle;
			process.stdout.write(
				`controller: mac supervisor pid=${macSupervisor.pid} (control pipes ready)\n`,
			);

			const rigStagedDir = process.env.COMPARISON_RIG_STAGED_DIR;
			const rigBinary = process.env.COMPARISON_RIG_SUPERVISOR_BINARY;
			if (
				typeof rigStagedDir === "string" &&
				rigStagedDir.length > 0 &&
				typeof rigBinary === "string" &&
				rigBinary.length > 0
			) {
				const linux = spec.endpoints.linux;
				const rigSpawned = await spawnRigSupervisor({
					binaryPath: binary.path,
					bunExecutablePath: bunPath.path,
					bootstrap: {
						authority: { fd: 3, label: "authority" },
						authorityDigest: { fd: 4, label: "authority-digest" },
						campaignRoot: { fd: 5, label: "campaign-root" },
						stagingRoot: { fd: 6, label: "staging-root" },
					},
					rigBinaryPath: rigBinary,
					rigPaths: {
						authorityFile: `${rigStagedDir}/authority.json`,
						authorityDigestFile: `${rigStagedDir}/authority-digest.bin`,
						campaignRootDir: `${rigStagedDir}/campaign-root`,
						stagingRootDir: `${rigStagedDir}/staging-root`,
					},
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
					`controller: rig supervisor pid=${rigSupervisor.pid} (ssh control channel ready)\n`,
				);
			}
		}

		return await realRunBody(spec, macSupervisor, rigSupervisor);
	} finally {
		if (rigSupervisor !== undefined) {
			await stopSupervisor(rigSupervisor, 5_000);
		}
		if (macSupervisor !== undefined) {
			await stopSupervisor(macSupervisor, 5_000);
		}
	}
}

/** Rig orchestration after optional Mac+rig supervisors are up. */
async function realRunBody(
	spec: RunSpec,
	macSupervisor: SupervisorHandle | undefined,
	rigSupervisor: SupervisorHandle | undefined,
): Promise<RealRunResult> {
	const linux = spec.endpoints.linux;
	const deadlines = new Map(
		STANDARD_DEADLINES.map((d) => [d.label, d.windowMs] as const),
	);

	// Phase 1: route verify (live ping from Mac to Linux, sourced
	// from the Mac interface to prove direct-cable, not via gateway).
	const pingDeadline = deadlines.get("route-verify") ?? 5_000;
	const pingResult = await sshExec(
		linux,
		`ping -c 1 -W ${Math.max(1, Math.floor(pingDeadline / 1000))} 127.0.0.1`,
		pingDeadline,
	);
	if (!pingResult.ok) {
		return {
			ok: false,
			reason: `route-verify failed: ${pingResult.stderr.trim()}`,
		};
	}

	// Phase 2: verify Linux is reachable and Bun is installed.
	const sshDeadline = deadlines.get("ssh-handshake") ?? 10_000;
	const helloResult = await sshExec(
		linux,
		"uname -a && ~/.bun/bin/bun --version",
		sshDeadline,
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
	const tarBuildResult = Bun.spawn(
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
		{ stdout: "pipe", stderr: "pipe" },
	);
	const tarBuildCode = await tarBuildResult.exited;
	if (tarBuildCode !== 0) {
		const tarStderr = await new Response(tarBuildResult.stderr).text();
		return {
			ok: false,
			reason: `tar build failed: ${tarStderr.trim()}`,
		};
	}
	const scpResult = await scpToRemote(
		linux,
		tarLocalPath,
		tarPath,
		scpDeadline,
	);
	if (!scpResult.ok) {
		return {
			ok: false,
			reason: `scp-binary failed: ${scpResult.stderr.trim()}`,
		};
	}
	const extractResult = await sshExec(
		linux,
		`mkdir -p /tmp/ws-wt-rig && tar xzf ${tarPath} -C /tmp/ws-wt-rig && echo ok`,
		scpDeadline,
	);
	if (!extractResult.ok || !extractResult.stdout.includes("ok")) {
		return {
			ok: false,
			reason: `scp extract failed: ${extractResult.stderr.trim() || extractResult.stdout.trim()}`,
		};
	}

	// Build rig native prebuilds + install them so the server can load the addon.
	const rigBuildResult = await sshExec(
		linux,
		`set -euo pipefail; cd /tmp/ws-wt-rig; if [ ! -d packages/webtransport/prebuilds ] || ! ls packages/webtransport/prebuilds/webtransport-native.linux-x64-gnu.node >/dev/null 2>&1; then export PATH=$HOME/.bun/bin:$HOME/.cargo/bin:$PATH; /home/hermes-admin/.bun/bin/bun install --frozen-lockfile; cargo build -p native --release; /home/hermes-admin/.bun/bin/bun run build:native; /home/hermes-admin/.bun/bin/bun x --bun @napi-rs/cli build --platform --release 2>/dev/null || true; install -d -m 755 packages/webtransport/prebuilds; for f in crates/native/*.node; do [ -f "$f" ] || continue; cp "$f" packages/webtransport/prebuilds/; done; fi; test -f packages/webtransport/prebuilds/webtransport-native.linux-x64-gnu.node && echo ok-prebuilds || (echo MISSING-PREBUILDS; ls packages/webtransport/prebuilds/; exit 1)`,
		deadlines.get("rig-build") ?? 600_000,
	);
	if (!rigBuildResult.ok || !rigBuildResult.stdout.includes("ok-prebuilds")) {
		return {
			ok: false,
			reason: `rig prebuild build failed: ${rigBuildResult.stderr.trim() || rigBuildResult.stdout.trim()}`,
		};
	}

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

	// Phase 4+: per (cell × transport) — optional netem, start server, seal reps.
	const netemDeadline = deadlines.get("netem-apply") ?? 5_000;
	const serverStartDeadline = deadlines.get("server-start") ?? 30_000;
	// Long legs (ticker 100k echoes, 100 MiB bulk) need a wide present budget;
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
		const observed = await observeCampaignToolchains(linux, sshDeadline);
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
	// B4 -> B5: the cohort runtime the six fanout primaries are dispatched to.
	// Nothing supplies one yet: the Linux cohort peer in `server.ts` is still
	// reachable only from B3's non-production integration entrypoint, so there is
	// no control-channel `CohortRigBinding` to hand `driveCohortArm`. Until B5
	// wires one, `dispatchArmRepetition` refuses a fanout primary with a closed
	// `COHORT_NOT_READY` rather than demoting it to a single-session leg -- which
	// is the whole reason the routing decision is not made at this call site.
	const cohortRuntimeProvider: CohortArmRuntimeProvider | undefined = undefined;
	let scheduledArms = 0;
	const indexEntries: CampaignIndexEntry[] = [];
	let lastEvidencePath = "";
	let wtRefusedReason: string | undefined;

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
		const wtProbe = await sshExec(
			linux,
			`test -d /tmp/ws-wt-rig/prebuilds && ls /tmp/ws-wt-rig/prebuilds 2>/dev/null | head -3; ~/.bun/bin/bun -e "try{require('node:fs').accessSync('/tmp/ws-wt-rig/package.json');console.log('ok')}catch(e){console.log('missing')}"`,
			sshDeadline,
		);
		if (!wtProbe.ok || !wtProbe.stdout.includes("ok")) {
			wtRefusedReason = `WT preflight failed: ${wtProbe.stderr.trim() || wtProbe.stdout.trim() || "rig tree missing"}`;
			process.stderr.write(`controller: ${wtRefusedReason}\n`);
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
			if (arm.transport === "wt" && wtRefusedReason !== undefined) {
				for (let repIndex = 1; repIndex <= spec.repetitions; repIndex += 1) {
					indexEntries.push({
						schema: "campaign-index-entry/v2",
						cellId: cell.cellId,
						armId,
						transport: arm.transport,
						armKind: arm.armKind,
						...(arm.armTransport !== undefined
							? { armTransport: arm.armTransport }
							: { armTransport: null }),
						impairment: impairmentLabel,
						executionPurpose: spec.executionPurpose,
						repetitionKind: "measured",
						repetitionIndex: repIndex,
						repetitionTotal: spec.repetitions,
						status: "REFUSED",
						promotable: false,
						failureCode: null,
						refusalCode: "STALE_OR_INVALID_STAGING",
						sealedPath: null,
						artifactSha256: null,
						primaryMetricP50: null,
						readPath: null,
						refusalReason: wtRefusedReason,
					});
				}
				await persistIndex();
				continue;
			}

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
					supervisorToolchainDigests !== undefined
				) {
					const attested = mintPhaseAAttestationFixture({
						executionPurpose: spec.executionPurpose,
						repetitionKind: slot.repetitionKind,
						repetitionIndex: repIndex,
						repetitionTotal: spec.repetitions,
						transport: arm.transport,
						cellId: cell.cellId,
						campaignId: spec.campaignId,
						runId,
					});
					let sealed: SealedRepResult;
					try {
						// The one dispatch. `dispatchArmRepetition` asks
						// `cohortCellForArm` which executor this arm belongs to, so the
						// six fanout primaries go to the cohort executor and everything
						// else goes to the single-session leg -- and neither the loop
						// nor a second list here gets to disagree with the builder and
						// the verifier about which is which.
						const dispatched = await dispatchArmRepetition({
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
								attestedServerLoopUtilization: {
									busyMs: attested.snapshotBusyMs,
									windowMs: attested.snapshotWindowMs,
								},
								executionPurpose: spec.executionPurpose,
								repetitionKind: slot.repetitionKind,
								repetitionTotal: spec.repetitions,
								attestationEvidence: attested.attestation,
							},
							...(cohortRuntimeProvider !== undefined
								? { cohortRuntime: cohortRuntimeProvider }
								: {}),
						});
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
						status: "REFUSED",
						promotable: false,
						failureCode: null,
						refusalCode: "STALE_OR_INVALID_STAGING",
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
before any SSH/SCP work. --phase4 selects ticker-fanout/rate-10000
and bulk-one-way/physical with 3 reps (stage=phase4).
--arm-kinds narrows the schedule to a subset of the registry's arm
kinds; by default all three are scheduled. --resume carries forward
the PASS entries of an existing campaign-index.json and re-measures
everything else. --campaign-timeout-ms is the fail-closed outer
wall-clock bound. --write-terminal-record writes ControllerTerminalV1
as canonical JSON before exit.
`;

if (import.meta.main) {
	const code = await main(process.argv.slice(2));
	process.exit(code);
}

// ---------------------------------------------------------------------------
// B4: the cohort executor for the six primary fanout cells
// ---------------------------------------------------------------------------

/**
 * The Linux side of one cohort, as the controller reaches it.
 *
 * Every method takes exactly what the Mac supervisor handed the controller and
 * returns exactly what the rig handed back. The controller computes nothing,
 * re-signs nothing and correlates nothing: `MacFanoutSupervisor`'s presentation
 * methods verify the rig's signature over the exact canonical bytes and check
 * that the record names the execution, the cohort and bytes already retained,
 * so a controller that invented, rewrote or cross-paired a record would be
 * refused by the supervisor rather than believed by it. That property is what
 * this interface exists to preserve -- it is deliberately shaped so there is
 * nowhere in it for the controller to put an opinion.
 *
 * It is an interface rather than a concrete SSH client for the same reason
 * `CampaignExecution` is: the production binding talks to the rig supervisor
 * over the control channel, and the in-process binding talks to a real
 * `FanoutLinuxAuthority` in this process. Both are the same courier.
 */
export interface CohortRigBinding {
	/** §5 step 1: verify and accept the Mac-signed grant before any socket. */
	acceptCohortGrant(args: {
		readonly grant: CohortGrantV1;
		readonly signature: MacReceiptSignatureV1;
		readonly nowMs: number;
	}): ProtocolResult<{
		readonly acceptance: unknown;
		readonly signature: unknown;
	}>;
	/** §5 step 2: bring the Linux server up under the accepted grant. */
	startServer(): ProtocolResult<true>;
	/**
	 * §5 step 3: register the role peers under the Mac permit schedule.
	 *
	 * The ordinals are the supervisor's, taken from `MacPermitScheduler`; the
	 * binding may not choose its own order, because the global 500/s, 200
	 * in-flight ramp is a property of the schedule and not of the rig.
	 */
	registerRolePeers(args: {
		readonly scheduler: MacPermitScheduler;
	}): ProtocolResult<true>;
	/** §5 step 4: accept the separately Mac-signed warmup epoch. */
	acceptWarmupEpoch(args: {
		readonly epoch: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): ProtocolResult<true>;
	/** §5 step 5: run the ten paced warmup messages per publisher. */
	runWarmupWire(): ProtocolResult<{
		/** One `RoleWarmupCompleteV1` frame per role child, in child order. */
		readonly roleWarmupCompleteBytes: readonly Uint8Array[];
		/** The manifest the Mac supervisor is asked to sign, unparsed. */
		readonly roleWarmupCompletionManifest: unknown;
	}>;
	/** §5 step 6: drain warmup and reset the measured counters to zero. */
	drainWarmup(args: {
		readonly roleWarmupCompletionManifestSha256: string;
		readonly roleWarmupCompletionManifestSignatureSha256: string;
		readonly nowMs: number;
	}): ProtocolResult<{
		readonly serverWarmupDrainedBytes: Uint8Array;
		readonly receipt: unknown;
		readonly signature: unknown;
	}>;
	/** §5 step 7: fix the Linux baseline and authenticate it. */
	measureStartAck(args: { readonly nowMs: number }): ProtocolResult<{
		readonly ackBytes: Uint8Array;
		readonly signature: unknown;
		readonly issuedAtMs: number;
		readonly notAfterMs: number;
	}>;
	/** §5 step 8: accept the Mac-signed barrier before any measured traffic. */
	acceptStartBarrier(args: {
		readonly barrier: unknown;
		readonly signature: unknown;
		readonly rigMeasureStartAckSha256: string;
		readonly nowMs: number;
	}): ProtocolResult<{
		readonly serverStartBarrierAcceptedBytes: Uint8Array;
		readonly acceptance: unknown;
		readonly signature: unknown;
	}>;
	/** §5 step 9: run the measured window and the bounded drain. */
	runMeasuredWindow(): ProtocolResult<{
		/** One `RolePartialV1` per role child, keyed by the child that sent it. */
		readonly partials: readonly {
			readonly childId: string;
			readonly frame: unknown;
		}[];
	}>;
	/** §5 step 10: the Linux-authoritative relay observation, emitted once. */
	observe(args: { readonly nowMs: number }): ProtocolResult<{
		readonly observationBytes: Uint8Array;
		readonly receipt: unknown;
		readonly signature: unknown;
	}>;
}

/**
 * What one cohort arm produced.
 *
 * The four derived records -- ordered partial manifest, process proof, rate
 * series, ledger, capacity -- are *not* repeated here. They are inside the
 * exported bundle, and `cohortEvidenceFromExportAck` re-parses them out of that
 * bundle's own retained bytes. Carrying a second copy beside the ack is how a
 * caller ends up able to hand the artifact builder a ledger the bundle does not
 * contain; the admission receipt below is the digest binding over them, which
 * is the part the controller legitimately needs to name.
 */
export interface CohortArmEvidence {
	readonly exportAck: MacCohortEvidenceExportedAckV1;
	readonly admissionReceipt: CohortAdmissionReceiptV1;
	readonly admissionReceiptSha256: string;
}

/** Canonical-JSON SHA-256, the same digest every cohort record is bound by. */
function sha256HexOfCanonical(record: unknown): string {
	return createHash("sha256")
		.update(Buffer.from(canonicalJson(record), "utf8"))
		.digest("hex");
}

/**
 * Decode a Mac signature the supervisor returned base64-encoded on an ack.
 *
 * The controller carries it to the rig without looking inside: the rig verifies
 * it against the staged Mac public key over the exact canonical bytes, so a
 * controller that reshaped it would produce a signature that does not verify
 * rather than one that verifies over something else.
 */
function macSignatureFromAck(base64: string): unknown {
	return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

/**
 * Drive one fanout cohort from grant to terminal evidence export.
 *
 * The order below is §5's, and it is the whole contract: nothing measured may
 * happen before Linux has accepted a signed grant, warmup is a separate signed
 * epoch that never touches the not-yet-existing barrier, the barrier is minted
 * only after readiness plus a drained warmup plus an authenticated Linux
 * baseline, and the single terminal export happens only after every partial has
 * been accepted. Each step is a `ProtocolResult`, so the first refusal stops
 * the cohort with the rig's or the supervisor's own closed code rather than
 * with a controller-authored message.
 *
 * The `capture` step is deliberately last and deliberately after `teardown` is
 * *not* called: `exportCohortEvidence` refuses once a snapshot has been taken
 * before the sessions closed, and the caller reaps afterwards.
 */
export async function driveCohortArm(input: {
	readonly supervisor: MacFanoutSupervisor;
	readonly rig: CohortRigBinding;
	readonly bundleFor: (plan: MacFanoutChildPlanV1) => TokenBundleV1;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly tokenCommitmentLeafManifestBytes: Uint8Array;
	/** Minted by the caller from the grant; the supervisor signs it. */
	readonly warmupEpoch: unknown;
	/** Minted by the caller from the retained graph; the supervisor signs it. */
	readonly startBarrierFor: (context: {
		readonly rigMeasureStartAckSha256: string;
	}) => unknown;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => string;
	};
	readonly receiptValidityMs: number;
}): Promise<ProtocolResult<CohortArmEvidence>> {
	const supervisor = input.supervisor;
	const nowMs = () => input.clock.nowMs();

	// 1. Mint and sign the pre-readiness grant. It has no start timestamp: the
	//    rig has to be able to verify role and token commitments before there is
	//    anything to measure.
	const opened = supervisor.openCohort();
	if (!opened.ok) return opened;

	// 2. Linux verifies signature/key/expiry/replay before it binds a socket.
	const accepted = input.rig.acceptCohortGrant({
		grant: opened.value.grant,
		signature: opened.value.grantSignature,
		nowMs: nowMs(),
	});
	if (!accepted.ok) return accepted;
	const presentedAcceptance = supervisor.presentRigCohortAcceptance({
		acceptance: accepted.value.acceptance,
		signature: accepted.value.signature,
		nowMs: nowMs(),
	});
	if (!presentedAcceptance.ok) return presentedAcceptance;

	const started = input.rig.startServer();
	if (!started.ok) return started;

	// 3. Spawn the Mac-owned children, then ramp their sessions on the global
	//    permit schedule. Readiness is per child and the supervisor owns it.
	const spawned = supervisor.spawnRoleChildren({
		bundleFor: input.bundleFor,
		spawnedAtMacNs: input.clock.nowNs(),
	});
	if (!spawned.ok) return spawned;
	const ramp = supervisor.beginRamp(input.clock.nowNs());
	if (!ramp.ok) return ramp;
	const registered = input.rig.registerRolePeers({ scheduler: ramp.value });
	if (!registered.ok) return registered;
	for (const child of supervisor.topology.children) {
		const ready = supervisor.markChildReady({
			childId: child.childId,
			readyAtMacNs: input.clock.nowNs(),
		});
		if (!ready.ok) return ready;
	}

	// 4. The two inputs the grant already committed to. Retained, not restated:
	//    the supervisor recomputes both digests against the signed grant.
	const workload = supervisor.retainWorkloadRolePlanInput(
		input.workloadRolePlanInputBytes,
	);
	if (!workload.ok) return workload;
	const leafManifest = supervisor.retainTokenCommitmentLeafManifest(
		input.tokenCommitmentLeafManifestBytes,
	);
	if (!leafManifest.ok) return leafManifest;

	// 5. Warmup: its own signed epoch, bound to the grant and a fresh nonce.
	const epochAck = supervisor.issueWarmupEpoch(input.warmupEpoch);
	if (!epochAck.ok) return epochAck;
	const epochAccepted = input.rig.acceptWarmupEpoch({
		epoch: input.warmupEpoch,
		signature: macSignatureFromAck(
			epochAck.value.cohortWarmupEpochSignatureBase64,
		),
		nowMs: nowMs(),
	});
	if (!epochAccepted.ok) return epochAccepted;

	const warmupRun = input.rig.runWarmupWire();
	if (!warmupRun.ok) return warmupRun;
	for (const bytes of warmupRun.value.roleWarmupCompleteBytes) {
		const retained = supervisor.retainRoleWarmupComplete(bytes);
		if (!retained.ok) return retained;
	}
	const manifestAck = supervisor.issueRoleWarmupCompletionManifest(
		warmupRun.value.roleWarmupCompletionManifest,
	);
	if (!manifestAck.ok) return manifestAck;

	// 6. Linux drains warmup and resets every measured counter and ordinal.
	const drained = input.rig.drainWarmup({
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
	const startAck = input.rig.measureStartAck({ nowMs: nowMs() });
	if (!startAck.ok) return startAck;
	const startAckPresented = supervisor.presentRigMeasureStartAck({
		ackBytes: startAck.value.ackBytes,
		signature: startAck.value.signature,
		issuedAtMs: startAck.value.issuedAtMs,
		notAfterMs: startAck.value.notAfterMs,
		nowMs: nowMs(),
	});
	if (!startAckPresented.ok) return startAckPresented;

	// 8. Only now can the barrier exist. It binds every prior digest, so a
	//    barrier minted earlier would be binding records that did not yet exist.
	const barrier = input.startBarrierFor({
		rigMeasureStartAckSha256: startAckPresented.value.rigMeasureStartAckSha256,
	});
	const barrierAck = supervisor.issueStartBarrier(barrier);
	if (!barrierAck.ok) return barrierAck;
	const barrierAccepted = input.rig.acceptStartBarrier({
		barrier,
		signature: macSignatureFromAck(
			barrierAck.value.cohortStartBarrierSignatureBase64,
		),
		rigMeasureStartAckSha256: startAckPresented.value.rigMeasureStartAckSha256,
		nowMs: nowMs(),
	});
	if (!barrierAccepted.ok) return barrierAccepted;
	const barrierPresented = supervisor.presentRigBarrierAcceptance({
		serverStartBarrierAcceptedBytes:
			barrierAccepted.value.serverStartBarrierAcceptedBytes,
		acceptance: barrierAccepted.value.acceptance,
		signature: barrierAccepted.value.signature,
		nowMs: nowMs(),
	});
	if (!barrierPresented.ok) return barrierPresented;

	// 9. Measured window plus the bounded drain, then each child's partial.
	const measured = input.rig.runMeasuredWindow();
	if (!measured.ok) return measured;
	for (const partial of measured.value.partials) {
		const accepted = supervisor.acceptRolePartial({
			childId: partial.childId,
			frame: partial.frame,
		});
		if (!accepted.ok) return accepted;
	}

	// 10. Linux is the authority for accepted ingress, capacity and faults.
	const observed = input.rig.observe({ nowMs: nowMs() });
	if (!observed.ok) return observed;
	const observationPresented = supervisor.presentRigRelayObservation({
		observationBytes: observed.value.observationBytes,
		receipt: observed.value.receipt,
		signature: observed.value.signature,
		nowMs: nowMs(),
	});
	if (!observationPresented.ok) return observationPresented;

	// 11. One terminal export. The admission receipt is named by the request, so
	//     the supervisor refuses to export against a receipt it did not mint.
	const issuedAtMs = nowMs();
	const notAfterMs = issuedAtMs + input.receiptValidityMs;
	const admission = supervisor.buildAdmissionReceipt({
		issuedAtMs,
		notAfterMs,
	});
	if (!admission.ok) return admission;
	const admissionSha256 = sha256HexOfCanonical(admission.value);
	const exported = supervisor.exportCohortEvidence({
		request: {
			schema: "mac-export-cohort-evidence-request/v1",
			requestSeq: 1,
			executionSha256: admission.value.executionSha256,
			cohortAdmissionReceiptSha256: admissionSha256,
		},
		issuedAtMs,
		notAfterMs,
	});
	if (!exported.ok) return exported;

	return {
		ok: true,
		value: {
			exportAck: exported.value,
			admissionReceipt: admission.value,
			admissionReceiptSha256: admissionSha256,
		},
	};
}

// ---------------------------------------------------------------------------
// The production dispatch seam
// ---------------------------------------------------------------------------

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

/**
 * Everything a cohort arm needs that the controller is not allowed to invent.
 *
 * The controller owns none of this: the supervisor is Mac-owned, the binding is
 * the rig's, the token bundles are the supervisor's, and `seal` turns the
 * terminal export into an artifact. The provider below is where those come
 * from, and the reason it is a provider rather than a field is that a cohort's
 * material is minted per repetition -- a runtime reused across two repetitions
 * would be replaying one cohort's grant under a second repetition's identity.
 */
export interface CohortArmRuntime {
	readonly supervisor: MacFanoutSupervisor;
	readonly rig: CohortRigBinding;
	readonly bundleFor: (plan: MacFanoutChildPlanV1) => TokenBundleV1;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly tokenCommitmentLeafManifestBytes: Uint8Array;
	readonly warmupEpoch: unknown;
	readonly startBarrierFor: (context: {
		readonly rigMeasureStartAckSha256: string;
	}) => unknown;
	readonly clock: {
		readonly nowMs: () => number;
		readonly nowNs: () => string;
	};
	readonly receiptValidityMs: number;
	/**
	 * Turn the terminal export into a sealed artifact and the index facts that
	 * name it. A warmup runtime seals nothing and says so by returning empty
	 * path and digest, exactly as the leg path's warmup does.
	 */
	readonly seal: (evidence: CohortArmEvidence) => Promise<SealedRepResult>;
}

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

export type CohortArmRuntimeProvider = (
	context: CohortArmRuntimeContext,
) =>
	| ProtocolResult<CohortArmRuntime>
	| Promise<ProtocolResult<CohortArmRuntime>>;

/** What the seam did, so a caller (and a test) can see which executor ran. */
export interface ArmRepetitionDispatch {
	readonly route: ArmExecutorRoute;
	readonly result: SealedRepResult;
}

/**
 * Force every refusal onto §7's closed set.
 *
 * A supervisor or rig code that is already in the set is kept -- that is the
 * whole point of the set -- and anything else becomes `COHORT_PROTOCOL` rather
 * than travelling into the index as free text wearing a code's position.
 */
function closedCohortFailureCode(code: string): CampaignFailureCode {
	return isCampaignFailureCode(code) ? code : "COHORT_PROTOCOL";
}

/**
 * The one place a scheduled arm repetition is routed to an executor.
 *
 * `cohortCellForArm` is the router, and it is the same call the builder, the
 * verifier and the promotion selector make, so an arm cannot be a cohort arm
 * to the artifact tree and a leg arm to the controller. A fanout primary is
 * never handed to `measureSealAndWriteRep`: when no runtime can be provided it
 * is refused with a closed code, because demoting it to a single session would
 * measure one publisher and present it as a cohort.
 *
 * The executors are injectable only so a test can watch which one ran; the
 * defaults are the production functions and are what `realRunBody` uses.
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
		bundleFor: runtime.value.bundleFor,
		workloadRolePlanInputBytes: runtime.value.workloadRolePlanInputBytes,
		tokenCommitmentLeafManifestBytes:
			runtime.value.tokenCommitmentLeafManifestBytes,
		warmupEpoch: runtime.value.warmupEpoch,
		startBarrierFor: runtime.value.startBarrierFor,
		clock: runtime.value.clock,
		receiptValidityMs: runtime.value.receiptValidityMs,
	};
	// Spelled out rather than resolved into a variable so the production call to
	// the cohort executor is findable by name: `driveCohortArm(` in the non-test
	// tree is what says the executor has a caller at all, and a defect that
	// removed it should be a grep away rather than hidden behind an alias.
	const driven =
		input.executors?.driveCohortArm !== undefined
			? await input.executors.driveCohortArm(driveArgs)
			: await driveCohortArm(driveArgs);
	if (!driven.ok) {
		return {
			route: "cohort",
			result: {
				ok: false,
				failureCode: closedCohortFailureCode(driven.code),
				reason: `cohort executor refused (${driven.code}): ${driven.message}`,
			},
		};
	}
	return { route: "cohort", result: await runtime.value.seal(driven.value) };
}
