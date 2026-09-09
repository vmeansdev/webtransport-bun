/**
 * The role child's post-stop behaviour, driven in-process.
 *
 * `runFanoutRoleChild` is run against a scripted control pipe, a scripted
 * relay session and a clock the test owns, so the two things the 40-second
 * e2e only shows as a finalization refusal are reproduced here in
 * milliseconds: acks still in flight when the publisher's end marker goes out
 * (plan §4.5, `OA_origin[w] = A_origin[w]`), and the drain deadline that bounds
 * that wait (plan: relay drain 10 s, `DRAIN_DEADLINE_EXCEEDED` ->
 * `FAIL/RELAY_DELIVERY`).
 */
import { describe, expect, test } from "bun:test";
import {
	COHORT_WORKER_COUNT,
	type CohortGrantV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	expectedWarmupDeliveries,
	expectedWarmupIngress,
	type PublisherPartialV1,
	READINESS_DEADLINE_MS_TICKER,
	type RoleSpawnConfigV1,
	type StagedServerLaunchRecordV1,
	SUBSCRIBER_SHARD_MODULUS,
	type SubscriberShardV1,
	subscriberShardCommitmentWindowEnd,
	type TokenBundleV1,
	type WorkerPartialV1,
} from "../cohort-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	type Ed25519KeyPairBytes,
	ed25519Sign,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	type NsString,
	type ProtocolResult,
	type Sha256Hex,
	sha256CanonicalRecord,
} from "../cross-supervisor-protocol.ts";
import {
	buildFanoutCohortFixture,
	type FanoutCohortFixture,
	fanoutPayload,
} from "../scenarios/fanout-relay.ts";
import {
	buildFanoutDeliveryContext,
	contextTagOfDeliveryContextSha256,
	decodeFanoutDelivery,
	decodeFanoutWsMessage,
	encodeFanoutDelivery,
	encodeFanoutWsMessage,
	type FanoutDeliveryContextFacts,
	type FanoutWireV1,
	fanoutDeliveryUnitKind,
} from "../scenarios/fanout-wire.ts";
import { sha256HexOfBytes } from "../secure-fs.ts";
import {
	type FanoutRoleChildOutcome,
	type RoleClock,
	type RoleControlChannel,
	type RoleSessionHandle,
	type RoleTransportConnector,
	runFanoutRoleChild,
	type TokenBundleFdSource,
} from "./fanout-role.ts";

// ---------------------------------------------------------------------------
// Fixtures: the same cohort shape B3's pure-logic tests use
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const HEX = (character: string): Sha256Hex => character.repeat(64);
const PUBLISHER_COUNT = 2;
const SUBSCRIBER_COUNT = 24;
const SHARD_SUBSCRIBERS = SUBSCRIBER_COUNT / SUBSCRIBER_SHARD_MODULUS;
const COHORT_ID = "cohort-role-child";
const SERVER_PORT = 44_301;
const MESSAGE_BYTES = 100 as const;
const WINDOW_COUNT = 10 as const;
const MESSAGE_RATE_PER_SECOND = 10;
const MEASURED_DURATION_MS = 10_000;
const TOTAL_MEASURED_MESSAGES =
	(MESSAGE_RATE_PER_SECOND * MEASURED_DURATION_MS) / 1000;
const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;
const MINTED_AT_NS = 5_000_000_000n;
const MEASURE_START_NS = MINTED_AT_NS + 250n * NS_PER_MS;
const MEASURE_STOP_NS = MEASURE_START_NS + BigInt(WINDOW_COUNT) * NS_PER_S;
const DRAIN_DEADLINE_NS = MEASURE_STOP_NS + 10_000n * NS_PER_MS;
const WARMUP_NONCE = HEX("7");

const base64Of = (bytes: Uint8Array): Base64 =>
	Buffer.from(bytes).toString("base64") as Base64;

/** The cell-sized payload a relay would copy into a compact frame. */
const payloadBytesOf = (label: string): Uint8Array =>
	new Uint8Array(
		Buffer.from(fanoutPayload(MESSAGE_BYTES, label).payloadBase64, "base64"),
	);

function stagedLaunchRecord(): StagedServerLaunchRecordV1 {
	return {
		schema: "staged-server-launch-record/v1",
		stageReceiptSha256: HEX("1"),
		serverEntrypointSha256: HEX("2"),
		bunSha256: HEX("3"),
		addonSha256: HEX("4"),
		bindAddress: "10.99.0.2",
		bindPort: SERVER_PORT,
		advertisedHost: "10.99.0.2",
		tlsServerName: "wt-compare.local",
		tlsCertificateSha256: HEX("5"),
		tlsPrivateKeySha256: HEX("6"),
		transport: "ws",
		argv: [
			"tools/compare/bin/compare-server.ts",
			"--bind=10.99.0.2",
			"--stage-profile=phase-b",
		],
		allowedEnvironment: [],
	};
}

function subscriberShards(): SubscriberShardV1[] {
	return Array.from({ length: COHORT_WORKER_COUNT }, (_unused, worker) => ({
		schema: "subscriber-shard/v1" as const,
		childId: `subscriber-worker-${worker}`,
		workerIndex: worker,
		modulus: SUBSCRIBER_SHARD_MODULUS,
		residue: worker,
		firstSubscriberIndex: 0 as const,
		lastSubscriberIndexExclusive: SUBSCRIBER_COUNT,
		subscriberCount: SHARD_SUBSCRIBERS,
		orderedSubscriberIdsSha256: sha256CanonicalRecord({ worker }),
		firstTokenCommitmentIndex: PUBLISHER_COUNT + worker,
		lastTokenCommitmentIndexExclusive: subscriberShardCommitmentWindowEnd(
			PUBLISHER_COUNT + worker,
			SHARD_SUBSCRIBERS,
		),
	}));
}

interface CohortFixtures {
	readonly keys: Ed25519KeyPairBytes;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly tokens: FanoutCohortFixture;
	readonly grant: CohortGrantV1;
	readonly grantBytes: Uint8Array;
	readonly grantSha256: Sha256Hex;
	readonly grantSignature: Uint8Array;
	readonly executionSha256: Sha256Hex;
	readonly workloadRolePlanInputSha256: Sha256Hex;
	readonly workloadRolePlanInputBase64: Base64;
}

function buildCohort(): CohortFixtures {
	const keys = generateEd25519KeyPair();
	const signingPublicKeySha256 = sha256HexOfBytes(keys.publicRaw32);
	const tokens = buildFanoutCohortFixture({
		cohortId: COHORT_ID,
		publisherCount: PUBLISHER_COUNT,
		subscriberCount: SUBSCRIBER_COUNT,
	});
	const workloadRolePlanInput = {
		plan: "role-child-plan",
		cohortId: COHORT_ID,
	};
	const workloadBytes = bytesOfCanonical(workloadRolePlanInput);
	const workloadRolePlanInputSha256 = sha256HexOfBytes(workloadBytes);

	const built = macConstructFinalExecution({
		draft: {
			schema: "cross-supervisor-execution-draft/v1",
			authoritySha256: HEX("a"),
			campaignLockSha256: HEX("b"),
			stagedCapabilitySha256: HEX("c"),
			sourceArchiveSha256: HEX("d"),
			approvedPlanSha256: HEX("e"),
			approvalRecordSha256: HEX("f"),
			candidate: "cand",
			campaignId: "camp",
			runId: "camp/ticker-fanout-100/ws/measured-1",
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-100",
			scenarioHash: HEX("5"),
			rolePlanHash: HEX("6"),
			workloadRolePlanInputSha256,
			stagedServerLaunchRecordSha256: sha256HexOfBytes(
				bytesOfCanonical(stagedLaunchRecord()),
			),
			armKind: "primary",
			transport: "ws",
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			grantDeclaration: "fanout-expanded-deliveries",
			declaredMessageCount: 100_000,
			declaredMessageBytes: 100,
			requestedNotAfterMs: 17_000_000_000_000,
		},
		executionIndex: 0,
		macSupervisorInstanceNonce: HEX("7"),
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		grantNonceSha256: HEX("8"),
	});
	if (!built.ok) throw new Error(`execution: ${built.code}`);
	const { execution, executionSha256 } = built.value;

	const offeredIngress = PUBLISHER_COUNT * TOTAL_MEASURED_MESSAGES;
	const grant: CohortGrantV1 = {
		schema: "cohort-grant/v1",
		execution,
		executionSha256,
		macExecutionGrantReceiptSha256: HEX("9"),
		approvedPlanSha256: execution.approvedPlanSha256,
		approvalRecordSha256: execution.approvalRecordSha256,
		cohortId: COHORT_ID,
		cohortAttempt: 1,
		scenarioHash: execution.scenarioHash,
		rolePlanHash: execution.rolePlanHash,
		workloadRolePlanInputSha256: execution.workloadRolePlanInputSha256,
		transport: "ws",
		publisherCount: PUBLISHER_COUNT,
		subscriberCount: SUBSCRIBER_COUNT,
		workerCount: 8,
		expectedProcessCount: PUBLISHER_COUNT + COHORT_WORKER_COUNT,
		expectedSessionCount: PUBLISHER_COUNT + SUBSCRIBER_COUNT,
		publishers: tokens.publishers,
		subscriberShards: subscriberShards(),
		tokenCommitmentLeafManifestSha256: HEX("0"),
		roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
		roleTokenCommitmentCount: tokens.roleTokenCommitmentCount,
		connectionRatePerSecond: 500,
		maxConnectionsInFlight: 200,
		readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
		inRepetitionWarmupMs: 5_000,
		sampleWindowMs: 1_000,
		measuredDurationMs: MEASURED_DURATION_MS,
		drainDeadlineMs: 10_000,
		messageBytes: MESSAGE_BYTES,
		expectedOfferedIngress: offeredIngress,
		expectedExpandedDeliveries: offeredIngress * SUBSCRIBER_COUNT,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256,
		receiptSequence: 1,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	const grantBytes = bytesOfCanonical(grant);
	return {
		keys,
		signingPublicKeySha256,
		tokens,
		grant,
		grantBytes,
		grantSha256: sha256HexOfBytes(grantBytes),
		grantSignature: ed25519Sign(keys.privatePkcs8Der, grantBytes),
		executionSha256,
		workloadRolePlanInputSha256,
		workloadRolePlanInputBase64: base64Of(workloadBytes),
	};
}

function tokenBundleFor(
	cohort: CohortFixtures,
	args: {
		readonly childId: string;
		readonly roleIds: readonly string[];
		readonly role: "publisher" | "subscriber";
	},
): TokenBundleV1 {
	const entries = args.roleIds.map((roleId) => ({
		schema: "token-bundle-entry/v1" as const,
		role: args.role,
		roleId,
		workerIndex: cohort.tokens.workerIndexByRoleId.get(roleId) ?? null,
		tokenBase64: cohort.tokens.tokenBase64ByRoleId.get(roleId) as Base64,
		tokenSha256: cohort.tokens.tokenSha256ByRoleId.get(roleId) as Sha256Hex,
		tokenCommitmentIndex: cohort.tokens.commitmentIndexByRoleId.get(
			roleId,
		) as number,
		tokenMerkleProofSha256: [
			...(cohort.tokens.proofByRoleId.get(roleId) as readonly Sha256Hex[]),
		],
	}));
	return {
		schema: "token-bundle/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		childId: args.childId,
		entryCount: entries.length,
		entries,
	};
}

function spawnConfig(
	cohort: CohortFixtures,
	bundle: TokenBundleV1,
	overrides: Partial<RoleSpawnConfigV1>,
): RoleSpawnConfigV1 {
	const bundleBytes = bytesOfCanonical(bundle);
	const launchBytes = bytesOfCanonical(stagedLaunchRecord());
	return {
		schema: "role-spawn-config/v1",
		sequence: 0,
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		cohortGrantBase64: base64Of(cohort.grantBytes),
		cohortGrantSignatureBase64: base64Of(cohort.grantSignature),
		workloadRolePlanInputBase64: cohort.workloadRolePlanInputBase64,
		workloadRolePlanInputSha256: cohort.workloadRolePlanInputSha256,
		stagedServerLaunchRecordBase64: base64Of(launchBytes),
		stagedServerLaunchRecordSha256: sha256HexOfBytes(launchBytes),
		stagedServerLaunchRecordSize: launchBytes.byteLength,
		childId: bundle.childId,
		role: "publisher",
		publisherId: null,
		workerIndex: null,
		childInstanceNonce: HEX("c"),
		tokenBundleFd: 5,
		tokenBundleSha256: sha256HexOfBytes(bundleBytes),
		tokenBundleSize: bundleBytes.byteLength,
		tokenBundleEntryCount: bundle.entryCount,
		tokenBundleMaxSize: 2_097_152,
		transport: "ws",
		serverHost: "10.99.0.2",
		serverPort: SERVER_PORT,
		tlsServerName: "wt-compare.local",
		messageRatePerSecond: MESSAGE_RATE_PER_SECOND,
		warmupMessagesPerPublisher: 10,
		warmupIntervalMs: 500,
		warmupDurationMs: 5_000,
		measuredDurationMs: MEASURED_DURATION_MS,
		measuredSampleWindowMs: 1_000,
		payloadBytes: MESSAGE_BYTES,
		channelMapping: "ws-binary-message-per-frame",
		macSigningPublicKeyBase64: base64Of(cohort.keys.publicRaw32),
		macSigningPublicKeySha256: cohort.signingPublicKeySha256,
		...overrides,
	} as RoleSpawnConfigV1;
}

function publisherChild(cohort: CohortFixtures): {
	readonly config: RoleSpawnConfigV1;
	readonly bundle: TokenBundleV1;
} {
	const bundle = tokenBundleFor(cohort, {
		childId: "publisher-child-0",
		roleIds: ["publisher-000000"],
		role: "publisher",
	});
	return {
		bundle,
		config: spawnConfig(cohort, bundle, {
			role: "publisher",
			publisherId: "publisher-000000",
		}),
	};
}

function workerChild(
	cohort: CohortFixtures,
	workerIndex: number,
): {
	readonly config: RoleSpawnConfigV1;
	readonly bundle: TokenBundleV1;
	readonly roleIds: readonly string[];
} {
	const roleIds: string[] = [];
	for (
		let ordinal = workerIndex;
		ordinal < SUBSCRIBER_COUNT;
		ordinal += SUBSCRIBER_SHARD_MODULUS
	) {
		roleIds.push(`subscriber-${ordinal.toString().padStart(6, "0")}`);
	}
	const bundle = tokenBundleFor(cohort, {
		childId: `subscriber-worker-${workerIndex}`,
		roleIds,
		role: "subscriber",
	});
	return {
		bundle,
		roleIds,
		config: spawnConfig(cohort, bundle, {
			role: "subscriber-worker",
			publisherId: null,
			workerIndex,
		}),
	};
}

function sealedFd(bytes: Uint8Array): TokenBundleFdSource {
	const observation = {
		schema: "token-bundle-fd-observation/v1",
		fd: 5,
		fileKind: "regular",
		accessMode: "read-only",
		appendMode: false,
		hardLinkCount: 0,
		deviceId: "16777232",
		inode: "918273",
		byteSize: bytes.byteLength,
		contentSha256: sha256HexOfBytes(bytes),
	};
	return {
		observationAtSpawn: () => ({ ...observation }),
		observationAtRead: () => ({ ...observation }),
		read: async () => bytes,
		close: () => {},
	};
}

function warmupStartFrame(
	cohort: CohortFixtures,
	role: "publisher" | "subscriber-worker",
): { readonly frame: Rec; readonly epochSha256: Sha256Hex } {
	const epoch: CohortWarmupEpochV1 = {
		schema: "cohort-warmup-epoch/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		cohortId: COHORT_ID,
		warmupNonce: WARMUP_NONCE,
		durationMs: 5_000,
		warmupMessagesPerPublisher: 10,
		warmupIntervalMs: 500,
		expectedWarmupIngress: expectedWarmupIngress(PUBLISHER_COUNT),
		expectedWarmupDeliveries: expectedWarmupDeliveries(
			PUBLISHER_COUNT,
			SUBSCRIBER_COUNT,
		),
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: cohort.signingPublicKeySha256,
		receiptSequence: 2,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	const epochBytes = bytesOfCanonical(epoch);
	const signature = ed25519Sign(cohort.keys.privatePkcs8Der, epochBytes);
	const epochSha256 = sha256HexOfBytes(epochBytes);
	return {
		epochSha256,
		frame: {
			schema: "role-warmup-start/v1",
			sequence: 0,
			executionSha256: cohort.executionSha256,
			cohortGrantSha256: cohort.grantSha256,
			cohortWarmupEpochBase64: base64Of(epochBytes),
			cohortWarmupEpochSha256: epochSha256,
			cohortWarmupEpochSignatureBase64: base64Of(signature),
			cohortWarmupEpochSignatureSha256: sha256HexOfBytes(signature),
			warmupNonce: WARMUP_NONCE,
			expectedChildOfferedWarmupIngress: role === "publisher" ? 10 : 0,
			expectedChildDeliveredWarmupRecords:
				role === "publisher" ? 0 : SHARD_SUBSCRIBERS * PUBLISHER_COUNT * 10,
			startAtMacNs: "1000000000",
			durationMs: 5_000,
		},
	};
}

function startBarrier(cohort: CohortFixtures): CohortStartBarrierV1 {
	return {
		schema: "cohort-start-barrier/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		rigCohortAcceptanceSha256: HEX("1"),
		rigMeasureStartAckSha256: HEX("2"),
		roleWarmupCompletionManifestSha256: HEX("3"),
		roleWarmupCompletionManifestSignatureSha256: HEX("4"),
		rigWarmupDrainedReceiptSha256: HEX("5"),
		cohortId: COHORT_ID,
		barrierNonce: HEX("6"),
		macClockId: "mac-clock-role-child",
		warmupStartedAtMacNs: "1000000000",
		warmupCompletedAtMacNs: "4900000000",
		mintedAtMacNs: MINTED_AT_NS.toString(),
		measureStartAtMacNs: MEASURE_START_NS.toString(),
		measureStopAtMacNs: MEASURE_STOP_NS.toString(),
		sampleWindowMs: 1_000,
		windowCount: WINDOW_COUNT,
		measuredDurationMs: MEASURED_DURATION_MS,
		drainDeadlineMs: 10_000,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: cohort.signingPublicKeySha256,
		receiptSequence: 3,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
}

// ---------------------------------------------------------------------------
// Harness: a clock the test owns, a scripted control pipe, a scripted relay
// ---------------------------------------------------------------------------

/**
 * `sleepUntilNs` jumps the clock instead of waiting, so a 10-second measured
 * window is a loop of a hundred stamps. `advanceTo` is the test's hand on the
 * same clock for what the child does not sleep for.
 */
function manualClock(startNs: bigint): RoleClock & {
	advanceTo(ns: bigint): void;
	now(): bigint;
} {
	let now = startNs;
	return {
		nowNs: () => now.toString() as NsString,
		sleepUntilNs: async (at) => {
			const target = BigInt(at);
			if (target > now) now = target;
		},
		advanceTo: (ns) => {
			if (ns > now) now = ns;
		},
		now: () => now,
	};
}

interface ScriptedControl extends RoleControlChannel {
	readonly sent: readonly Rec[];
	supply(frame: Rec): void;
	/** Called after every frame the child sends, before `send` resolves. */
	onSent(listener: (frame: Rec) => void): void;
}

function scriptedControl(): ScriptedControl {
	const inbound: Rec[] = [];
	const waiters: ((frame: Rec) => void)[] = [];
	const sent: Rec[] = [];
	const listeners: ((frame: Rec) => void)[] = [];
	return {
		sent,
		supply: (frame) => {
			const waiter = waiters.shift();
			if (waiter !== undefined) waiter(frame);
			else inbound.push(frame);
		},
		onSent: (listener) => {
			listeners.push(listener);
		},
		receive: async (expectedSchema) => {
			const frame =
				inbound.shift() ??
				(await new Promise<Rec>((resolve) => {
					waiters.push(resolve);
				}));
			if (frame.schema !== expectedSchema) {
				throw new Error(
					`child expected ${expectedSchema} but the script supplied ${String(frame.schema)}`,
				);
			}
			return frame;
		},
		send: async (frame) => {
			sent.push(frame);
			for (const listener of listeners) listener(frame);
		},
	};
}

interface ScriptedSession {
	readonly roleId: string;
	readonly role: "publisher" | "subscriber";
	readonly outbound: FanoutWireV1[];
	readonly closedAt: () => number | null;
	/** A JSON frame, the way the connector hands one over. */
	deliver(frame: FanoutWireV1): void;
	/** The epoch's delivery context, built from the relay's own facts. */
	deliverContext(epoch: "warmup" | "measured"): void;
	/** One compact frame, tagged for the epoch unless a tag is given. */
	deliverCompact(args: {
		readonly epoch: "warmup" | "measured";
		readonly windowIndex: number;
		readonly publisherIndex: number;
		readonly publisherSequence: number;
		readonly linuxAcceptedOrdinal: number;
		readonly payload: Uint8Array;
		readonly subscriberIndex?: number;
		readonly contextTag?: number;
	}): void;
	/** Raw bytes through the WS discriminator, as the connector routes them. */
	deliverBytes(bytes: Uint8Array): void;
}

interface ScriptedRelay extends RoleTransportConnector {
	readonly sessions: ReadonlyMap<string, ScriptedSession>;
	/** Every `close()` in the order the child made them, as a monotonic count. */
	readonly closeCount: () => number;
	/** Decides, per publisher data frame, whether its ack goes out at once. */
	ackPolicy: (frame: FanoutWireV1) => "now" | "hold";
	/** Acks the policy held, in offer order. */
	releaseHeldAcks(): void;
	readonly heldAckCount: () => number;
	onEnd: (session: ScriptedSession) => void;
	/** Every reason the child's connector callbacks refused a unit. */
	readonly malformed: string[];
	/** The epoch digest the warmup contexts are built from; set by `driveChild`. */
	warmupEpochSha256: Sha256Hex | null;
}

function scriptedRelay(args: {
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	/** What the relay writes its delivery contexts from; the honest facts by default. */
	readonly contextGrantSha256?: Sha256Hex;
}): ScriptedRelay {
	const sessions = new Map<string, ScriptedSession>();
	const held: (() => void)[] = [];
	let closes = 0;
	let ordinal = 0;
	const publisherIds = Array.from(
		{ length: PUBLISHER_COUNT },
		(_u, index) => `publisher-${index.toString().padStart(6, "0")}`,
	);
	const contextFacts = (
		roleId: string,
		epoch: "warmup" | "measured",
	): FanoutDeliveryContextFacts => {
		const common = {
			cohortGrantSha256: args.contextGrantSha256 ?? args.cohortGrantSha256,
			subscriberId: roleId,
			subscriberIndex: Number(roleId.slice("subscriber-".length)),
			publisherIds,
			windowCount: WINDOW_COUNT,
			messageBytes: MESSAGE_BYTES,
		};
		return epoch === "warmup"
			? {
					...common,
					epoch,
					cohortWarmupEpochSha256: relay.warmupEpochSha256 ?? HEX("0"),
					warmupNonce: WARMUP_NONCE,
				}
			: {
					...common,
					epoch,
					cohortStartBarrierSha256: args.cohortStartBarrierSha256,
				};
	};
	const relay: ScriptedRelay = {
		transport: "ws",
		sessions,
		closeCount: () => closes,
		ackPolicy: () => "now",
		heldAckCount: () => held.length,
		releaseHeldAcks: () => {
			for (const release of held.splice(0)) release();
		},
		onEnd: () => {},
		malformed: [],
		warmupEpochSha256: null,
		connect: async (request) => {
			let closedAt: number | null = null;
			const outbound: FanoutWireV1[] = [];
			const tags: { warmup: number | null; measured: number | null } = {
				warmup: null,
				measured: null,
			};
			const onMalformed = (detail: string): void => {
				relay.malformed.push(`${request.roleId}: ${detail}`);
				request.onMalformed(detail);
			};
			const deliverBytes = (bytes: Uint8Array): void => {
				switch (fanoutDeliveryUnitKind(bytes, "ws")) {
					case "compact": {
						const delivery = decodeFanoutDelivery(bytes, request.messageBytes);
						if (delivery.ok) request.onDelivery(delivery.value);
						else onMalformed(delivery.message ?? delivery.code);
						return;
					}
					case "json": {
						const decoded = decodeFanoutWsMessage(bytes);
						if (decoded.ok) request.onFrame(decoded.value);
						else onMalformed(decoded.message ?? decoded.code);
						return;
					}
					default:
						onMalformed("neither compact nor JSON");
				}
			};
			const session: ScriptedSession = {
				roleId: request.roleId,
				role: request.role,
				outbound,
				closedAt: () => closedAt,
				deliver: (frame) => request.onFrame(frame),
				deliverContext: (epoch) => {
					const context = buildFanoutDeliveryContext(
						contextFacts(request.roleId, epoch),
					);
					if (!context.ok) throw new Error(`context: ${context.code}`);
					tags[epoch] = contextTagOfDeliveryContextSha256(
						context.value.deliveryContextSha256,
					);
					const encoded = encodeFanoutWsMessage(context.value);
					if (!encoded.ok) throw new Error(`context encode: ${encoded.code}`);
					deliverBytes(encoded.value);
				},
				deliverCompact: (frame) => {
					const tag = frame.contextTag ?? tags[frame.epoch];
					if (tag === null) throw new Error(`no ${frame.epoch} context yet`);
					const encoded = encodeFanoutDelivery(
						{
							windowIndex: frame.windowIndex,
							publisherIndex: frame.publisherIndex,
							subscriberIndex:
								frame.subscriberIndex ??
								Number(request.roleId.slice("subscriber-".length)),
							publisherSequence: frame.publisherSequence,
							linuxAcceptedOrdinal: frame.linuxAcceptedOrdinal,
							contextTag: tag,
							payloadBytes: MESSAGE_BYTES,
						},
						frame.payload,
					);
					if (!encoded.ok) throw new Error(`compact encode: ${encoded.code}`);
					deliverBytes(encoded.value);
				},
				deliverBytes,
			};
			sessions.set(request.roleId, session);
			const handle: RoleSessionHandle = {
				roleId: request.roleId,
				send: async (frame) => {
					outbound.push(frame);
					if (frame.kind === "register") {
						session.deliver({
							schema: "fanout-wire/v1",
							kind: "accept",
							cohortGrantSha256: args.cohortGrantSha256,
							role: request.role,
							roleId: request.roleId,
							linuxSessionOrdinal: ordinal++,
							linuxAcceptedAtNs: "1" as NsString,
							linuxClockId: "linux-clock",
						});
					} else if (frame.kind === "data") {
						const ack = (): void => {
							session.deliver({
								schema: "fanout-wire/v1",
								kind: "ack",
								cohortGrantSha256: args.cohortGrantSha256,
								cohortStartBarrierSha256: args.cohortStartBarrierSha256,
								windowIndex: frame.windowIndex,
								publisherId: frame.publisherId,
								publisherSequence: frame.publisherSequence,
								disposition: "accepted",
								linuxAcceptedOrdinal: ordinal++,
								linuxAcceptedAtNs: "2" as NsString,
								code: null,
							});
						};
						if (relay.ackPolicy(frame) === "now") ack();
						else held.push(ack);
					} else if (frame.kind === "end") {
						relay.onEnd(session);
					}
					return { ok: true, value: true };
				},
				close: () => {
					closes += 1;
					closedAt ??= closes;
				},
			};
			return handle;
		},
	};
	return relay;
}

interface DrivenChild {
	readonly control: ScriptedControl;
	readonly relay: ScriptedRelay;
	readonly clock: ReturnType<typeof manualClock>;
	readonly barrierSha256: Sha256Hex;
	readonly outcome: Promise<ProtocolResult<FanoutRoleChildOutcome>>;
	/** The partial exactly as the child sent it, decoded. */
	partial(): PublisherPartialV1 | WorkerPartialV1;
}

/**
 * Drive one child through registration, warmup and arming with the frames
 * the Mac supervisor would send, then hand control to the test at the point
 * the controller sends `role-stop/v1` (it sends it right after the arm ack;
 * `MacRoleChildCohortDriver.runMeasuredWindow`).
 */
function driveChild(args: {
	readonly cohort: CohortFixtures;
	readonly config: RoleSpawnConfigV1;
	readonly bundle: TokenBundleV1;
	readonly roleIds: readonly string[];
	readonly relay: ScriptedRelay;
	readonly clock: ReturnType<typeof manualClock>;
	readonly onArmed: (child: {
		readonly control: ScriptedControl;
		readonly relay: ScriptedRelay;
		readonly clock: ReturnType<typeof manualClock>;
	}) => void;
	/**
	 * What the scripted relay puts on each subscriber's delivery channel at
	 * the warmup start; the default is the amended wire.
	 */
	readonly warmupWire?: (session: ScriptedSession, roleId: string) => void;
}): DrivenChild {
	const { cohort, config, relay, clock } = args;
	const control = scriptedControl();
	const barrier = startBarrier(cohort);
	const barrierBytes = bytesOfCanonical(barrier);
	const barrierSha256 = sha256HexOfBytes(barrierBytes);
	const warmup = warmupStartFrame(
		cohort,
		config.role === "publisher" ? "publisher" : "subscriber-worker",
	);
	relay.warmupEpochSha256 ??= warmup.epochSha256;

	control.onSent((frame) => {
		switch (frame.schema) {
			case "connect-permit-request/v1":
				control.supply({
					schema: "connect-permit-grant/v1",
					sequence: 0,
					executionSha256: config.executionSha256,
					cohortGrantSha256: config.cohortGrantSha256,
					childId: config.childId,
					globalOrdinal: frame.globalOrdinal,
					notBeforeMacNs: clock.nowNs(),
					permitNonce: HEX("d"),
				});
				break;
			case "role-ready/v1":
				control.supply(warmup.frame);
				if (config.role === "subscriber-worker") {
					// The relay puts the warmup context first on each channel, then
					// fans every publisher's ten warmup frames to each subscriber
					// this worker owns, every one tagged with that context.
					for (const roleId of args.roleIds) {
						const session = relay.sessions.get(roleId);
						if (session === undefined) throw new Error(`no session ${roleId}`);
						if (args.warmupWire !== undefined) {
							args.warmupWire(session, roleId);
							continue;
						}
						session.deliverContext("warmup");
						let ordinal = 0;
						for (
							let publisher = 0;
							publisher < PUBLISHER_COUNT;
							publisher += 1
						) {
							for (let sequence = 0; sequence < 10; sequence += 1) {
								session.deliverCompact({
									epoch: "warmup",
									windowIndex: 0,
									publisherIndex: publisher,
									publisherSequence: sequence,
									linuxAcceptedOrdinal: ordinal++,
									payload: payloadBytesOf(`w:${sequence}`),
								});
							}
						}
					}
				}
				break;
			case "role-warmup-complete/v1":
				control.supply({
					schema: "role-measure-start/v1",
					sequence: 0,
					executionSha256: config.executionSha256,
					cohortStartBarrierBase64: base64Of(barrierBytes),
				});
				break;
			case "role-measure-start-ack/v1":
				args.onArmed({ control, relay, clock });
				break;
			case "role-partial/v1":
				control.supply({
					schema: "role-partial-accepted/v1",
					sequence: 0,
					executionSha256: config.executionSha256,
					childId: config.childId,
					partialSha256: frame.partialSha256,
				});
				control.supply({
					schema: "role-exit/v1",
					sequence: 0,
					executionSha256: config.executionSha256,
					childId: config.childId,
				});
				break;
			default:
				break;
		}
	});

	control.supply({ ...(config as unknown as Rec) });
	const outcome = runFanoutRoleChild({
		control,
		tokenBundleFd: sealedFd(bytesOfCanonical(args.bundle)),
		clock,
		connector: relay,
		process: { pid: 4242, pgid: 4242 },
		stagedMacSigningPublicKeySha256: cohort.signingPublicKeySha256,
	});
	return {
		control,
		relay,
		clock,
		barrierSha256,
		outcome,
		partial: () => {
			const frame = control.sent.find((f) => f.schema === "role-partial/v1");
			if (frame === undefined) throw new Error("the child sent no partial");
			return JSON.parse(
				Buffer.from(frame.partialBase64 as string, "base64").toString("utf8"),
			) as PublisherPartialV1 | WorkerPartialV1;
		},
	};
}

function roleStop(
	config: RoleSpawnConfigV1,
	barrierSha256: Sha256Hex,
	atNs: NsString,
): Rec {
	return {
		schema: "role-stop/v1",
		sequence: 0,
		executionSha256: config.executionSha256,
		cohortStartBarrierSha256: barrierSha256,
		stopAtMacNs: atNs,
	};
}

const sum = (values: readonly number[]): number =>
	values.reduce((total, value) => total + value, 0);

// ---------------------------------------------------------------------------
// R-F: the publisher's post-stop drain
// ---------------------------------------------------------------------------

describe("the publisher's drain after role-stop", () => {
	test("acks still in flight when the end marker goes out are recorded, not dropped", async () => {
		const cohort = buildCohort();
		const { config, bundle } = publisherChild(cohort);
		const clock = manualClock(0n);
		const barrierSha256 = sha256HexOfBytes(
			bytesOfCanonical(startBarrier(cohort)),
		);
		const relay = scriptedRelay({
			cohortGrantSha256: cohort.grantSha256,
			cohortStartBarrierSha256: barrierSha256,
		});
		// The last origin window's acks are the ones a real relay still has in
		// the socket when the child reads its (already queued) stop frame.
		relay.ackPolicy = (frame) =>
			frame.kind === "data" && frame.windowIndex === WINDOW_COUNT - 1
				? "hold"
				: "now";
		relay.onEnd = () => {
			setTimeout(() => relay.releaseHeldAcks(), 20);
		};

		const child = driveChild({
			cohort,
			config,
			bundle,
			roleIds: ["publisher-000000"],
			relay,
			clock,
			onArmed: ({ control }) => {
				control.supply(roleStop(config, barrierSha256, clock.nowNs()));
			},
		});
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(true);

		const partial = child.partial() as PublisherPartialV1;
		expect(sum(partial.offeredByOriginWindow)).toBe(TOTAL_MEASURED_MESSAGES);
		expect(partial.acceptedAckSeenByOriginWindow[WINDOW_COUNT - 1]).toBe(
			MESSAGE_RATE_PER_SECOND,
		);
		expect(partial.acceptedAckSeenByOriginWindow).toEqual(
			partial.offeredByOriginWindow,
		);
		expect(relay.heldAckCount()).toBe(0);
		// The last ack is the partial's last timestamp: nothing in flight when
		// the end marker went out was left out of the record.
		expect(BigInt(partial.lastAckAtMacNs)).toBeGreaterThanOrEqual(
			BigInt(partial.firstOfferAtMacNs),
		);
	});

	test("the drain deadline is the barrier stop plus ten seconds on the Mac clock and expiring it is DRAIN_DEADLINE_EXCEEDED", async () => {
		const cohort = buildCohort();
		const { config, bundle } = publisherChild(cohort);
		const clock = manualClock(0n);
		const barrierSha256 = sha256HexOfBytes(
			bytesOfCanonical(startBarrier(cohort)),
		);
		const relay = scriptedRelay({
			cohortGrantSha256: cohort.grantSha256,
			cohortStartBarrierSha256: barrierSha256,
		});
		const HELD = 3;
		relay.ackPolicy = (frame) =>
			frame.kind === "data" &&
			frame.publisherSequence >= TOTAL_MEASURED_MESSAGES - HELD
				? "hold"
				: "now";
		// Time passes while nothing arrives; one tick short of the deadline the
		// child is still waiting, at the deadline it is not.
		let ticks = 0;
		relay.onEnd = () => {
			const original = clock.nowNs;
			clock.nowNs = () => {
				ticks += 1;
				if (ticks === 2) clock.advanceTo(DRAIN_DEADLINE_NS - 1n);
				if (ticks === 4) clock.advanceTo(DRAIN_DEADLINE_NS);
				return original();
			};
		};

		const child = driveChild({
			cohort,
			config,
			bundle,
			roleIds: ["publisher-000000"],
			relay,
			clock,
			onArmed: ({ control }) => {
				control.supply(roleStop(config, barrierSha256, clock.nowNs()));
			},
		});
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("DRAIN_DEADLINE_EXCEEDED");
		expect(outcome.message).toContain(`${HELD}`);
		expect(outcome.message).toContain(`${TOTAL_MEASURED_MESSAGES}`);
		expect(relay.heldAckCount()).toBe(HELD);
		// A refused drain is a closed outcome: no partial claims the window.
		expect(
			child.control.sent.some((frame) => frame.schema === "role-partial/v1"),
		).toBe(false);
		// Every session is closed on the refusal path too.
		expect(relay.closeCount()).toBe(1);
	});

	test("an ack of any disposition settles its offer; only unanswered offers hold the drain", async () => {
		const cohort = buildCohort();
		const { config, bundle } = publisherChild(cohort);
		const clock = manualClock(0n);
		const barrierSha256 = sha256HexOfBytes(
			bytesOfCanonical(startBarrier(cohort)),
		);
		const relay = scriptedRelay({
			cohortGrantSha256: cohort.grantSha256,
			cohortStartBarrierSha256: barrierSha256,
		});
		// The relay closes admission on the last two offers: a `closed` ack is
		// still an answer, and the drain must not wait for an `accepted` one
		// that will never come.
		relay.ackPolicy = (frame) =>
			frame.kind === "data" &&
			frame.publisherSequence >= TOTAL_MEASURED_MESSAGES - 2
				? "hold"
				: "now";
		relay.onEnd = (session) => {
			setTimeout(() => {
				for (const sequence of [
					TOTAL_MEASURED_MESSAGES - 2,
					TOTAL_MEASURED_MESSAGES - 1,
				]) {
					session.deliver({
						schema: "fanout-wire/v1",
						kind: "ack",
						cohortGrantSha256: cohort.grantSha256,
						cohortStartBarrierSha256: barrierSha256,
						windowIndex: WINDOW_COUNT - 1,
						publisherId: "publisher-000000",
						publisherSequence: sequence,
						disposition: "closed",
						linuxAcceptedOrdinal: null,
						linuxAcceptedAtNs: null,
						code: "SUBSCRIBER_QUEUE_FULL",
					});
				}
			}, 20);
		};

		const child = driveChild({
			cohort,
			config,
			bundle,
			roleIds: ["publisher-000000"],
			relay,
			clock,
			onArmed: ({ control }) => {
				control.supply(roleStop(config, barrierSha256, clock.nowNs()));
			},
		});
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(true);
		const partial = child.partial() as PublisherPartialV1;
		expect(partial.acceptedAckSeenByOriginWindow[WINDOW_COUNT - 1]).toBe(
			MESSAGE_RATE_PER_SECOND - 2,
		);
		expect(sum(partial.offeredByOriginWindow)).toBe(TOTAL_MEASURED_MESSAGES);
	});
});

// ---------------------------------------------------------------------------
// §4.5: a worker's event window is the actual delivery time
// ---------------------------------------------------------------------------

describe("the worker's deliveries are stamped when they arrive", () => {
	test("a delivery that arrives before the worker reads role-stop keeps its arrival window", async () => {
		const cohort = buildCohort();
		const worker = workerChild(cohort, 3);
		const clock = manualClock(0n);
		const barrierSha256 = sha256HexOfBytes(
			bytesOfCanonical(startBarrier(cohort)),
		);
		const relay = scriptedRelay({
			cohortGrantSha256: cohort.grantSha256,
			cohortStartBarrierSha256: barrierSha256,
		});
		const ARRIVAL_WINDOW = 2;
		const STOP_READ_WINDOW = 7;

		const child = driveChild({
			cohort,
			config: worker.config,
			bundle: worker.bundle,
			roleIds: worker.roleIds,
			relay,
			clock,
			onArmed: ({ control }) => {
				// One measured delivery per subscriber lands in window 2 ...
				clock.advanceTo(
					MEASURE_START_NS +
						BigInt(ARRIVAL_WINDOW) * NS_PER_S +
						500n * NS_PER_MS,
				);
				for (const roleId of worker.roleIds) {
					const session = relay.sessions.get(roleId);
					if (session === undefined) throw new Error(`no session ${roleId}`);
					session.deliverContext("measured");
					session.deliverCompact({
						epoch: "measured",
						windowIndex: ARRIVAL_WINDOW,
						publisherIndex: 0,
						publisherSequence: 0,
						linuxAcceptedOrdinal: 0,
						payload: payloadBytesOf(`m:${roleId}`),
					});
				}
				// ... and the stop frame is read five windows later, as it is when
				// the supervisor's pipe write is delayed behind other children.
				clock.advanceTo(
					MEASURE_START_NS +
						BigInt(STOP_READ_WINDOW) * NS_PER_S +
						500n * NS_PER_MS,
				);
				control.supply(roleStop(worker.config, barrierSha256, clock.nowNs()));
				for (const roleId of worker.roleIds) {
					relay.sessions.get(roleId)?.deliver({
						schema: "fanout-wire/v1",
						kind: "end",
						cohortGrantSha256: cohort.grantSha256,
						cohortStartBarrierSha256: barrierSha256,
						role: "subscriber",
						roleId,
						finalWindowIndex: WINDOW_COUNT - 1,
						finalPublisherSequence: null,
						reason: "relay-drained",
					});
				}
			},
		});
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(true);
		const partial = child.partial() as WorkerPartialV1;
		expect(partial.deliveredByEventWindow[ARRIVAL_WINDOW]).toBe(
			SHARD_SUBSCRIBERS,
		);
		expect(partial.deliveredByEventWindow[STOP_READ_WINDOW]).toBe(0);
		expect(partial.deliveredByOriginWindow[ARRIVAL_WINDOW]).toBe(
			SHARD_SUBSCRIBERS,
		);
		expect(partial.deliveredAfterMeasureStop).toBe(0);
		expect(BigInt(partial.firstDeliveryAtMacNs)).toBe(
			MEASURE_START_NS + BigInt(ARRIVAL_WINDOW) * NS_PER_S + 500n * NS_PER_MS,
		);
	});
});

// ---------------------------------------------------------------------------
// R-L: the exit path
// ---------------------------------------------------------------------------

describe("the child's exit", () => {
	test("role-exit/v1 is answered with role-exited/v1 after every session is closed and before the child returns", async () => {
		const cohort = buildCohort();
		const worker = workerChild(cohort, 1);
		const clock = manualClock(0n);
		const barrierSha256 = sha256HexOfBytes(
			bytesOfCanonical(startBarrier(cohort)),
		);
		const relay = scriptedRelay({
			cohortGrantSha256: cohort.grantSha256,
			cohortStartBarrierSha256: barrierSha256,
		});
		const observed = { closesWhenExitedSent: -1, returned: false };

		const child = driveChild({
			cohort,
			config: worker.config,
			bundle: worker.bundle,
			roleIds: worker.roleIds,
			relay,
			clock,
			onArmed: ({ control }) => {
				control.supply(roleStop(worker.config, barrierSha256, clock.nowNs()));
				for (const roleId of worker.roleIds) {
					relay.sessions.get(roleId)?.deliver({
						schema: "fanout-wire/v1",
						kind: "end",
						cohortGrantSha256: cohort.grantSha256,
						cohortStartBarrierSha256: barrierSha256,
						role: "subscriber",
						roleId,
						finalWindowIndex: WINDOW_COUNT - 1,
						finalPublisherSequence: null,
						reason: "relay-drained",
					});
				}
			},
		});
		child.control.onSent((frame) => {
			if (frame.schema === "role-exited/v1") {
				observed.closesWhenExitedSent = relay.closeCount();
				expect(observed.returned).toBe(false);
			}
		});
		const outcome = await child.outcome;
		observed.returned = true;
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.exitCode).toBe(0);
		expect(observed.closesWhenExitedSent).toBe(worker.roleIds.length);
		const last = child.control.sent.at(-1);
		expect(last?.schema).toBe("role-exited/v1");
		expect(last?.childId).toBe(worker.config.childId);
		expect(last?.exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Physical-budget amendment D2: the worker's delivery channel fails closed
// ---------------------------------------------------------------------------

describe("D2: the worker refuses the delivery channel on the first wrong unit", () => {
	function armWorker(args: {
		readonly cohort: CohortFixtures;
		readonly workerIndex?: number;
		readonly relayArgs?: Partial<Parameters<typeof scriptedRelay>[0]>;
		readonly warmupWire?: (session: ScriptedSession, roleId: string) => void;
		readonly onArmed?: (child: {
			readonly control: ScriptedControl;
			readonly relay: ScriptedRelay;
			readonly clock: ReturnType<typeof manualClock>;
		}) => void;
	}) {
		const worker = workerChild(args.cohort, args.workerIndex ?? 3);
		const clock = manualClock(0n);
		const barrierSha256 = sha256HexOfBytes(
			bytesOfCanonical(startBarrier(args.cohort)),
		);
		const relay = scriptedRelay({
			cohortGrantSha256: args.cohort.grantSha256,
			cohortStartBarrierSha256: barrierSha256,
			...args.relayArgs,
		});
		const child = driveChild({
			cohort: args.cohort,
			config: worker.config,
			bundle: worker.bundle,
			roleIds: worker.roleIds,
			relay,
			clock,
			onArmed:
				args.onArmed ??
				(({ control }) => {
					control.supply(roleStop(worker.config, barrierSha256, clock.nowNs()));
				}),
			...(args.warmupWire === undefined ? {} : { warmupWire: args.warmupWire }),
		});
		return { worker, child, relay, clock, barrierSha256 };
	}

	/** The §4.2 JSON delivery a relay that predates the amendment still writes. */
	function legacyWarmupData(
		cohort: CohortFixtures,
		roleId: string,
	): FanoutWireV1 {
		const payload = fanoutPayload(MESSAGE_BYTES, "legacy");
		return {
			schema: "fanout-wire/v1",
			kind: "warmup-data",
			direction: "relay-to-subscriber",
			cohortGrantSha256: cohort.grantSha256,
			cohortWarmupEpochSha256: warmupStartFrame(cohort, "subscriber-worker")
				.epochSha256,
			warmupNonce: WARMUP_NONCE,
			publisherId: "publisher-000000",
			publisherSequence: 0,
			subscriberId: roleId,
			linuxAcceptedOrdinal: 0,
			payloadBase64: payload.payloadBase64,
			payloadSha256: payload.payloadSha256,
			payloadBytes: MESSAGE_BYTES,
		};
	}

	async function expectMismatch(
		child: DrivenChild,
		worker: { readonly config: RoleSpawnConfigV1 },
		detail: string,
	): Promise<void> {
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.code).toBe("DELIVERY_CONTEXT_MISMATCH");
		expect(outcome.message).toContain(detail);
		// The child said why before exiting: the closed code is on the pipe.
		const last = child.control.sent.at(-1);
		expect(last?.schema).toBe("role-failed/v1");
		expect(last?.code).toBe("DELIVERY_CONTEXT_MISMATCH");
		expect(last?.childId).toBe(worker.config.childId);
		expect(last?.executionSha256).toBe(worker.config.executionSha256);
		expect(
			child.control.sent.some((f) => f.schema === "role-warmup-complete/v1"),
		).toBe(false);
	}

	test("a JSON data frame where the warmup context belongs is DELIVERY_CONTEXT_MISMATCH, not a shortfall", async () => {
		const cohort = buildCohort();
		const { child, worker } = armWorker({
			cohort,
			warmupWire: (session, roleId) => {
				session.deliver(legacyWarmupData(cohort, roleId));
			},
		});
		await expectMismatch(
			child,
			worker,
			"warmup-data frame on the delivery channel",
		);
	});

	test("a compact frame before its context is refused", async () => {
		const cohort = buildCohort();
		const { child, worker } = armWorker({
			cohort,
			warmupWire: (session) => {
				session.deliverCompact({
					epoch: "warmup",
					windowIndex: 0,
					publisherIndex: 0,
					publisherSequence: 0,
					linuxAcceptedOrdinal: 0,
					payload: payloadBytesOf("early"),
					contextTag: 0x1234_5678,
				});
			},
		});
		await expectMismatch(child, worker, "no delivery context on this session");
	});

	test("a context bound to another grant is refused by the worker's own recompute", async () => {
		const cohort = buildCohort();
		const { child, worker } = armWorker({
			cohort,
			relayArgs: { contextGrantSha256: HEX("e") },
		});
		await expectMismatch(
			child,
			worker,
			"does not match this session's admission",
		);
	});

	test("a frame carrying another session's subscriber index is refused", async () => {
		const cohort = buildCohort();
		const { child, worker } = armWorker({
			cohort,
			warmupWire: (session) => {
				session.deliverContext("warmup");
				session.deliverCompact({
					epoch: "warmup",
					windowIndex: 0,
					publisherIndex: 0,
					publisherSequence: 0,
					linuxAcceptedOrdinal: 0,
					payload: payloadBytesOf("elsewhere"),
					subscriberIndex: 1_000,
				});
			},
		});
		await expectMismatch(child, worker, "subscriber index 1000");
	});

	test("a unit the connector cannot decode is counted and, in the warmup epoch, ends the child", async () => {
		const cohort = buildCohort();
		const { child, worker, relay } = armWorker({
			cohort,
			warmupWire: (session) => {
				session.deliverContext("warmup");
				const bytes = new Uint8Array(24 + MESSAGE_BYTES);
				bytes[0] = 0xc1;
				new DataView(bytes.buffer).setUint16(20, MESSAGE_BYTES, true);
				bytes[22] = 1; // the reserved field must be zero
				session.deliverBytes(bytes);
			},
		});
		await expectMismatch(child, worker, "undecodable delivery unit");
		// One bad unit per session was counted; the first of them ended the child.
		expect(relay.malformed.length).toBe(worker.roleIds.length);
		expect(relay.malformed.every((detail) => detail.includes("reserved"))).toBe(
			true,
		);
	});

	test("a warmup-tagged frame after the measured context is refused", async () => {
		const cohort = buildCohort();
		const { child, worker } = armWorker({
			cohort,
			onArmed: ({ relay: scripted, control, clock }) => {
				for (const roleId of worker.roleIds) {
					const session = scripted.sessions.get(roleId);
					if (session === undefined) throw new Error(`no session ${roleId}`);
					session.deliverContext("measured");
					session.deliverCompact({
						epoch: "warmup",
						windowIndex: 0,
						publisherIndex: 0,
						publisherSequence: 11,
						linuxAcceptedOrdinal: 99,
						payload: payloadBytesOf("late"),
					});
					break;
				}
				control.supply(roleStop(worker.config, barrierSha256, clock.nowNs()));
			},
		});
		const barrierSha256 = child.barrierSha256;
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.code).toBe("DELIVERY_CONTEXT_MISMATCH");
		expect(outcome.message).toContain(
			"warmup-tagged frame during the measured epoch",
		);
		expect(child.control.sent.at(-1)?.schema).toBe("role-failed/v1");
		expect(child.control.sent.some((f) => f.schema === "role-partial/v1")).toBe(
			false,
		);
	});

	test("a JSON data frame in the measured window is refused with the same code", async () => {
		const cohort = buildCohort();
		const { child, worker } = armWorker({
			cohort,
			onArmed: ({ relay: scripted, control, clock }) => {
				const roleId = worker.roleIds[0] as string;
				const session = scripted.sessions.get(roleId);
				if (session === undefined) throw new Error(`no session ${roleId}`);
				session.deliverContext("measured");
				const payload = fanoutPayload(MESSAGE_BYTES, "legacy-measured");
				session.deliver({
					schema: "fanout-wire/v1",
					kind: "data",
					direction: "relay-to-subscriber",
					cohortGrantSha256: cohort.grantSha256,
					cohortStartBarrierSha256: child.barrierSha256,
					windowIndex: 0,
					publisherId: "publisher-000000",
					publisherSequence: 0,
					subscriberId: roleId,
					linuxAcceptedOrdinal: 0,
					payloadBase64: payload.payloadBase64,
					payloadSha256: payload.payloadSha256,
					payloadBytes: MESSAGE_BYTES,
				});
				control.supply(
					roleStop(worker.config, child.barrierSha256, clock.nowNs()),
				);
			},
		});
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.code).toBe("DELIVERY_CONTEXT_MISMATCH");
		expect(outcome.message).toContain("data frame on the delivery channel");
		expect(child.control.sent.at(-1)?.code).toBe("DELIVERY_CONTEXT_MISMATCH");
	});

	test("in the measured window an undecodable unit is counted in the partial and the child completes", async () => {
		const cohort = buildCohort();
		const { child, worker, relay } = armWorker({
			cohort,
			onArmed: ({ relay: scripted, control, clock }) => {
				clock.advanceTo(MEASURE_START_NS + 2n * NS_PER_S);
				for (const [index, roleId] of worker.roleIds.entries()) {
					const session = scripted.sessions.get(roleId);
					if (session === undefined) throw new Error(`no session ${roleId}`);
					session.deliverContext("measured");
					if (index === 0) {
						const bytes = new Uint8Array(24 + MESSAGE_BYTES);
						bytes[0] = 0xc1;
						new DataView(bytes.buffer).setUint16(20, MESSAGE_BYTES, true);
						bytes[22] = 1;
						session.deliverBytes(bytes);
					}
					session.deliverCompact({
						epoch: "measured",
						windowIndex: 2,
						publisherIndex: 1,
						publisherSequence: 0,
						linuxAcceptedOrdinal: 0,
						payload: payloadBytesOf(`m:${roleId}`),
					});
				}
				control.supply(
					roleStop(worker.config, child.barrierSha256, clock.nowNs()),
				);
				for (const roleId of worker.roleIds) {
					scripted.sessions.get(roleId)?.deliver({
						schema: "fanout-wire/v1",
						kind: "end",
						cohortGrantSha256: cohort.grantSha256,
						cohortStartBarrierSha256: child.barrierSha256,
						role: "subscriber",
						roleId,
						finalWindowIndex: WINDOW_COUNT - 1,
						finalPublisherSequence: null,
						reason: "relay-drained",
					});
				}
			},
		});
		const outcome = await child.outcome;
		expect(outcome.ok).toBe(true);
		const partial = child.partial() as WorkerPartialV1;
		expect(partial.malformedCount).toBe(1);
		expect(relay.malformed.length).toBe(1);
		expect(sum(partial.deliveredByOriginWindow)).toBe(worker.roleIds.length);
		expect(partial.perSubscriberDelivered).toEqual(worker.roleIds.map(() => 1));
		expect(partial.duplicateCount).toBe(0);
	});
});
