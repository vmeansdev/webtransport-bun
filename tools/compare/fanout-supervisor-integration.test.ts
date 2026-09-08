/**
 * B3 role-child tests.
 *
 * This first block covers the child's pure logic -- what it accepts as its own
 * spawn config, which tokens it will use, and how it books a window -- because
 * those are the decisions that stay wrong silently. A child that mis-books a
 * window still produces a well-formed partial; only recomputation catches it,
 * and by then the cohort is spent. The later blocks in this file drive the whole
 * spawned lifecycle.
 */
import { describe, expect, test } from "bun:test";
import {
	type ChildProcessWithoutNullStreams,
	spawn as nodeSpawn,
} from "node:child_process";
import {
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWebSocketAdapter } from "./adapters/ws.ts";
import {
	assignedGlobalOrdinals,
	COHORT_BARRIER_MIN_ARM_DELAY_NS,
	loadRoleTokenBundle,
	orderedSubscriberIdsSha256,
	PublisherWindowBook,
	type RoleClock,
	selectRoleTokenEntries,
	type TokenBundleFdSource,
	validateRoleSpawnConfigFrame,
	verifyRoleMeasureStart,
	verifyRoleWarmupStart,
	WorkerWindowBook,
} from "./bin/fanout-role.ts";
import {
	decodeChildPipeFrame,
	decodeRoleChildFrame,
	encodeChildPipeFrame,
	encodeRoleChildFrame,
	parseServerStartBarrierAccepted as parseChildServerStartBarrierAccepted,
	parseServerWarmupDrained as parseChildServerWarmupDrained,
	parseServerBindExecution,
	parseServerWarmupReady,
	RoleChildFrameReader,
} from "./child-pipe-protocol.ts";
import {
	type MacWire,
	type ScriptedMacBinaryOptions,
	ScriptedMacCohortBinary,
	serveScriptedMac,
	signCohortExportAck,
} from "./cohort-fixture-signing.ts";
import {
	buildChat10kWorstCaseTokenBundleFixture,
	CHAT_10K_TOKEN_BUNDLE_MARGIN_BYTES,
	CHAT_10K_TOKEN_BUNDLE_MAX_BYTES,
	CHAT_10K_TOKEN_MERKLE_PROOF_LENGTH,
	CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
	COHORT_MAX_CONNECTIONS_IN_FLIGHT,
	COHORT_WORKER_COUNT,
	type CohortGrantV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	type ConnectPermitGrantV1,
	expectedWarmupDeliveries,
	expectedWarmupIngress,
	type PublisherPartialV1,
	parseCohortObservationEvidence,
	parseRigBarrierAcceptance,
	parseRigCohortAcceptance,
	parseRigRelayObservationReceipt,
	parseRigWarmupDrainedReceipt,
	permitNotBeforeMacNs,
	READINESS_DEADLINE_MS_TICKER,
	type RigBarrierAcceptanceV1,
	type RigCohortAcceptanceV1,
	type RigRelayObservationReceiptV1,
	type RigWarmupDrainedReceiptV1,
	type RoleSpawnConfigV1,
	type RoleWarmupCompleteV1,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	resolveGlobalOrdinal,
	type StagedServerLaunchRecordV1,
	SUBSCRIBER_SHARD_MODULUS,
	type SubscriberShardV1,
	subscriberShardCommitmentWindowEnd,
	TOKEN_BUNDLE_MAX_SIZE,
	type TokenBundleV1,
	type TokenCommitmentLeafManifestV1,
	tokenBundleWorstCaseBytes,
	validateNoRoleReplacements,
	validateTokenBundleBytes,
	validateTokenBundleFdMetadata,
	type WorkerPartialV1,
} from "./cohort-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	COHORT_EVIDENCE_DEBIT_FIELDS,
	type CrossSupervisorExecutionDraftV1,
	decodeRemoteSupervisorPayload,
	type Ed25519KeyPairBytes,
	ed25519Sign,
	encodeRegisteredRemotePayload,
	generateEd25519KeyPair,
	type MacCohortOpenedAckV1,
	type MacReceiptSignatureV1,
	macConstructFinalExecution,
	type NsString,
	type ProtocolResult,
	type RigReceiptSignatureV1,
	type Sha256Hex,
	sha256CanonicalRecord,
	signMacReceipt,
	signRigReceipt,
	verifyRigReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import {
	attachSupervisorChildDiagnostics,
	CohortRigChannel,
	createMacFanoutRoleChildHost,
	type MacFanoutRoleChildHost,
	createMemoryReplayLedger,
	MAC_FANOUT_MAX_PRE_READY_REPLACEMENTS,
	MAC_FANOUT_PUBLISHER_COUNT,
	MAC_FANOUT_TERMINAL_PATHS,
	MacCohortChannel,
	type MacExecutionOpenedV1,
	type MacFanoutChildPlanV1,
	type MacFanoutChildSpawner,
	type MacFanoutChildStateV1,
	type MacFanoutProcessControl,
	type MacFanoutScenario,
	type MacFanoutSignal,
	type MacFanoutSpawnRequestV1,
	MacFanoutSupervisor,
	MacPermitScheduler,
	type MacRoleChildControlChannel,
	planMacFanoutTopology,
	sealTokenBundleFd,
} from "./remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import {
	buildFanoutCohortFixture,
	createManualRelayClock,
	type FanoutBarrierAcceptanceResult,
	type FanoutCohortAcceptance,
	type FanoutCohortFixture,
	FanoutLinuxAuthority,
	type FanoutLinuxAuthorityConfig,
	type FanoutMeasureStartAckResultV1,
	type FanoutRelay,
	type FanoutRelayObservationResult,
	type FanoutWarmupDrainedResult,
	fanoutFrameCodecFor,
	fanoutPayload,
	fanoutRoleId,
	type ManualRelayClock,
	RELAY_WRITE_DEADLINE_MS,
	type RelaySessionSink,
} from "./scenarios/fanout-relay.ts";
import {
	decodeFanoutDelivery,
	type FanoutWireV1,
	fanoutDeliveryUnitKind,
} from "./scenarios/fanout-wire.ts";
import { parseStrictJsonBytes, sha256HexOfBytes } from "./secure-fs.ts";
import {
	buildStagedServerLaunchRecord,
	type CohortBindDecisionV1,
	type CohortControlPipeIo,
	type CohortServerBinding,
	decideCohortBind,
	FANOUT_COHORT_CONTROL_READ_FD,
	FANOUT_COHORT_CONTROL_WRITE_FD,
	FANOUT_COHORT_SERVER_ENV_NAMES,
	parseFanoutCohortServerEnvironment,
	parseServerArgs,
	runFanoutCohortServerChild,
	serveFanoutCohortRelay,
	stagedServerLaunchArgv,
	stagedServerLaunchRecordLeaf,
} from "./server.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEX = (character: string): Sha256Hex => character.repeat(64);

/** Small enough to build in a unit test, wide enough to fill all eight shards. */
const PUBLISHER_COUNT = 2;
const SUBSCRIBER_COUNT = 24;
const SHARD_SUBSCRIBERS = SUBSCRIBER_COUNT / SUBSCRIBER_SHARD_MODULUS;
const COHORT_ID = "cohort-b3";
const SERVER_PORT = 44_300;
const MESSAGE_BYTES = 100 as const;
const WINDOW_COUNT = 10 as const;

const base64Of = (bytes: Uint8Array): Base64 =>
	Buffer.from(bytes).toString("base64") as Base64;

function stagedLaunchRecord(
	transport: "ws" | "wt" = "ws",
): StagedServerLaunchRecordV1 {
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
		transport,
		argv: [
			"tools/compare/bin/compare-server.ts",
			"--bind=10.99.0.2",
			"--stage-profile=phase-b",
		],
		allowedEnvironment: [],
	};
}

/**
 * Shards as the grant declares them under the residue layout both producers
 * emit (`buildFanoutCohortFixture`, `scenarios/fanout-relay.ts`): subscriber
 * `n` sits at commitment index `PUBLISHER_COUNT + n` and belongs to worker
 * `n % 8`, so worker `w`'s window starts at `PUBLISHER_COUNT + w` and spans its
 * residue class (`subscriberShardCommitmentWindowEnd`, R-A). The grant-level
 * `parseCohortGrant` checks exactly that window.
 */
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

function buildCohort(overrides: Partial<CohortGrantV1> = {}): CohortFixtures {
	const keys = generateEd25519KeyPair();
	const signingPublicKeySha256 = sha256HexOfBytes(keys.publicRaw32);
	const tokens = buildFanoutCohortFixture({
		cohortId: COHORT_ID,
		publisherCount: PUBLISHER_COUNT,
		subscriberCount: SUBSCRIBER_COUNT,
	});
	const workloadRolePlanInput = { plan: "b3-role-plan", cohortId: COHORT_ID };
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
			runId: "camp/ticker-fanout-250/ws/measured-1",
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-250",
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
			declaredMessageCount: 250_000,
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

	const offeredIngress = 100;
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
		measuredDurationMs: 10_000,
		drainDeadlineMs: 10_000,
		messageBytes: MESSAGE_BYTES,
		expectedOfferedIngress: offeredIngress,
		expectedExpandedDeliveries: offeredIngress * SUBSCRIBER_COUNT,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256,
		receiptSequence: 1,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
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

/** The bundle the supervisor would seal onto FD 5 for one child. */
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
	overrides: Partial<RoleSpawnConfigV1> = {},
): RoleSpawnConfigV1 {
	const bundle = tokenBundleFor(cohort, {
		childId: "publisher-child-0",
		roleIds: ["publisher-000000"],
		role: "publisher",
	});
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
		childId: "publisher-child-0",
		role: "publisher",
		publisherId: "publisher-000000",
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
		messageRatePerSecond: 10,
		warmupMessagesPerPublisher: 10,
		warmupIntervalMs: 500,
		warmupDurationMs: 5_000,
		measuredDurationMs: 10_000,
		measuredSampleWindowMs: 1_000,
		payloadBytes: MESSAGE_BYTES,
		channelMapping: "ws-binary-message-per-frame",
		macSigningPublicKeyBase64: base64Of(cohort.keys.publicRaw32),
		macSigningPublicKeySha256: cohort.signingPublicKeySha256,
		...overrides,
	} as RoleSpawnConfigV1;
}

/** A worker config for shard `workerIndex`, with its own sealed bundle. */
function workerSpawnConfig(
	cohort: CohortFixtures,
	workerIndex: number,
): { config: RoleSpawnConfigV1; bundle: TokenBundleV1 } {
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
	const bundleBytes = bytesOfCanonical(bundle);
	return {
		bundle,
		config: spawnConfig(cohort, {
			childId: `subscriber-worker-${workerIndex}`,
			role: "subscriber-worker",
			publisherId: null,
			workerIndex,
			tokenBundleSha256: sha256HexOfBytes(bundleBytes),
			tokenBundleSize: bundleBytes.byteLength,
			tokenBundleEntryCount: bundle.entryCount,
		}),
	};
}

/** An FD 5 that reports exactly what it holds, unless told to lie. */
function sealedFd(args: {
	readonly bytes: Uint8Array;
	readonly reportedSize?: number;
	readonly reportedSha256?: Sha256Hex;
}): TokenBundleFdSource & { closed: () => boolean; reads: () => number } {
	let closed = false;
	let reads = 0;
	const observation = {
		schema: "token-bundle-fd-observation/v1",
		fd: 5,
		fileKind: "regular",
		accessMode: "read-only",
		appendMode: false,
		hardLinkCount: 0,
		deviceId: "16777232",
		inode: "918273",
		byteSize: args.reportedSize ?? args.bytes.byteLength,
		contentSha256: args.reportedSha256 ?? sha256HexOfBytes(args.bytes),
	};
	return {
		observationAtSpawn: () => ({ ...observation }),
		observationAtRead: () => ({ ...observation }),
		read: async () => {
			reads += 1;
			return args.bytes;
		},
		close: () => {
			closed = true;
		},
		closed: () => closed,
		reads: () => reads,
	};
}

const WARMUP_NONCE = HEX("7");

/** A `RoleWarmupStartV1` carrying a real Mac-signed epoch. */
function warmupStartFrame(
	cohort: CohortFixtures,
	options: {
		readonly signWith?: Ed25519KeyPairBytes;
		readonly cohortId?: string;
	} = {},
): Record<string, unknown> {
	const epoch: CohortWarmupEpochV1 = {
		schema: "cohort-warmup-epoch/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		cohortId: options.cohortId ?? COHORT_ID,
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
	const signature = ed25519Sign(
		(options.signWith ?? cohort.keys).privatePkcs8Der,
		epochBytes,
	);
	return {
		schema: "role-warmup-start/v1",
		sequence: 0,
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		cohortWarmupEpochBase64: base64Of(epochBytes),
		cohortWarmupEpochSha256: sha256HexOfBytes(epochBytes),
		cohortWarmupEpochSignatureBase64: base64Of(signature),
		cohortWarmupEpochSignatureSha256: sha256HexOfBytes(signature),
		warmupNonce: WARMUP_NONCE,
		expectedChildOfferedWarmupIngress: 10,
		expectedChildDeliveredWarmupRecords: 30,
		startAtMacNs: "5000000000",
		durationMs: 5_000,
	};
}

function startBarrier(
	cohort: CohortFixtures,
	overrides: Partial<CohortStartBarrierV1> = {},
): CohortStartBarrierV1 {
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
		macClockId: "mac-clock-b3",
		warmupStartedAtMacNs: "4500000000",
		warmupCompletedAtMacNs: "4900000000",
		mintedAtMacNs: "5000000000",
		measureStartAtMacNs: "5250000000",
		measureStopAtMacNs: "15250000000",
		sampleWindowMs: 1_000,
		windowCount: WINDOW_COUNT,
		measuredDurationMs: 10_000,
		drainDeadlineMs: 10_000,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: cohort.signingPublicKeySha256,
		receiptSequence: 3,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	};
}

function measureStartFrame(
	barrier: CohortStartBarrierV1,
	cohort: CohortFixtures,
): Record<string, unknown> {
	return {
		schema: "role-measure-start/v1",
		sequence: 0,
		executionSha256: cohort.executionSha256,
		cohortStartBarrierBase64: base64Of(bytesOfCanonical(barrier)),
	};
}

const instantClock: RoleClock = {
	nowNs: () => "1000000000",
	sleepUntilNs: async () => {},
};

// ---------------------------------------------------------------------------
// Spawn-config and ordinal derivation
// ---------------------------------------------------------------------------

describe("fanout role child pure logic", () => {
	test("role_spawn_config_is_accepted_only_when_it_matches_the_signed_grant", () => {
		const cohort = buildCohort();
		const accepted = validateRoleSpawnConfigFrame({
			frame: spawnConfig(cohort),
			stagedMacSigningPublicKeySha256: cohort.signingPublicKeySha256,
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.value.grant.cohortId).toBe(COHORT_ID);
		expect(accepted.value.assignedGlobalOrdinals).toEqual([SUBSCRIBER_COUNT]);
		expect(accepted.value.assignedRoleIds).toEqual(["publisher-000000"]);
		// The key comes back as bytes, not as a digest: later Mac-signed records
		// are verified under it rather than compared to it.
		expect(accepted.value.macSigningPublicKey.byteLength).toBe(32);
	});

	test("role_spawn_config_rejects_a_key_that_is_not_the_staged_key", () => {
		const cohort = buildCohort();
		const refused = validateRoleSpawnConfigFrame({
			frame: spawnConfig(cohort),
			stagedMacSigningPublicKeySha256: HEX("b"),
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.code).toBe("COHORT_PROTOCOL");
	});

	test("role_spawn_config_rejects_a_grant_signed_by_another_key", () => {
		const cohort = buildCohort();
		const other = generateEd25519KeyPair();
		const forged = spawnConfig(cohort, {
			cohortGrantSignatureBase64: base64Of(
				ed25519Sign(other.privatePkcs8Der, cohort.grantBytes),
			),
		});
		const refused = validateRoleSpawnConfigFrame({
			frame: forged,
			stagedMacSigningPublicKeySha256: cohort.signingPublicKeySha256,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("signature");
	});

	test("role_spawn_config_rejects_schedule_and_payload_that_differ_from_the_grant", () => {
		const cohort = buildCohort();
		for (const override of [
			{
				transport: "wt" as const,
				channelMapping:
					"wt-publisher-bidi-subscriber-control-bidi-server-uni" as const,
			},
			{ payloadBytes: 128 as const },
			{ measuredDurationMs: 30_000 as const },
		]) {
			const refused = validateRoleSpawnConfigFrame({
				frame: spawnConfig(cohort, override),
				stagedMacSigningPublicKeySha256: cohort.signingPublicKeySha256,
			});
			expect(refused.ok).toBe(false);
		}
	});

	test("role_spawn_config_rejects_a_role_the_grant_assigns_to_another_child", () => {
		const cohort = buildCohort();
		const refused = validateRoleSpawnConfigFrame({
			frame: spawnConfig(cohort, { childId: "publisher-child-9" }),
			stagedMacSigningPublicKeySha256: cohort.signingPublicKeySha256,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("another child");
	});

	test("assigned_global_ordinals_are_derived_from_the_grant_not_received", () => {
		const cohort = buildCohort();
		// Publishers sit above the whole subscriber run, in publisher order.
		for (let index = 0; index < PUBLISHER_COUNT; index += 1) {
			const publisherId = `publisher-${index.toString().padStart(6, "0")}`;
			const derived = assignedGlobalOrdinals(
				spawnConfig(cohort, {
					childId: `publisher-child-${index}`,
					publisherId,
				}),
				cohort.grant,
			);
			expect(derived.ok).toBe(true);
			if (!derived.ok) return;
			expect(derived.value.ordinals).toEqual([SUBSCRIBER_COUNT + index]);
		}

		// Every subscriber ordinal is owned by exactly one worker, and the union
		// of the eight shards is the whole subscriber run with no overlap.
		const union = new Set<number>();
		for (let worker = 0; worker < COHORT_WORKER_COUNT; worker += 1) {
			const derived = assignedGlobalOrdinals(
				workerSpawnConfig(cohort, worker).config,
				cohort.grant,
			);
			expect(derived.ok).toBe(true);
			if (!derived.ok) return;
			for (const ordinal of derived.value.ordinals) {
				expect(ordinal % SUBSCRIBER_SHARD_MODULUS).toBe(worker);
				expect(union.has(ordinal)).toBe(false);
				union.add(ordinal);
			}
			expect(derived.value.roleIds[0]).toBe(
				`subscriber-${worker.toString().padStart(6, "0")}`,
			);
		}
		expect(union.size).toBe(SUBSCRIBER_COUNT);
	});

	// -------------------------------------------------------------------------
	// FD 5 and token lookup
	// -------------------------------------------------------------------------

	test("token_bundle_fd_is_read_once_and_closed_before_any_connect", async () => {
		const cohort = buildCohort();
		const config = spawnConfig(cohort);
		const bundle = tokenBundleFor(cohort, {
			childId: "publisher-child-0",
			roleIds: ["publisher-000000"],
			role: "publisher",
		});
		const fd = sealedFd({ bytes: bytesOfCanonical(bundle) });
		const loaded = await loadRoleTokenBundle({
			source: fd,
			config,
			clock: instantClock,
		});
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.value.bundle.childId).toBe("publisher-child-0");
		expect(loaded.value.contentSha256).toBe(config.tokenBundleSha256);
		expect(fd.reads()).toBe(1);
		expect(fd.closed()).toBe(true);
	});

	test("token_bundle_fd_rejects_a_digest_or_size_that_is_not_the_commitment", async () => {
		const cohort = buildCohort();
		const config = spawnConfig(cohort);
		const bundleBytes = bytesOfCanonical(
			tokenBundleFor(cohort, {
				childId: "publisher-child-0",
				roleIds: ["publisher-000000"],
				role: "publisher",
			}),
		);
		const swapped = await loadRoleTokenBundle({
			source: sealedFd({
				bytes: bundleBytes,
				reportedSha256: HEX("d"),
			}),
			config,
			clock: instantClock,
		});
		expect(swapped.ok).toBe(false);

		const resized = await loadRoleTokenBundle({
			source: sealedFd({
				bytes: bundleBytes,
				reportedSize: bundleBytes.byteLength + 1,
			}),
			config,
			clock: instantClock,
		});
		expect(resized.ok).toBe(false);
	});

	test("token_bundle_from_another_child_is_refused_even_when_it_parses", async () => {
		const cohort = buildCohort();
		const foreign = tokenBundleFor(cohort, {
			childId: "publisher-child-1",
			roleIds: ["publisher-000001"],
			role: "publisher",
		});
		const bytes = bytesOfCanonical(foreign);
		const config = spawnConfig(cohort, {
			tokenBundleSha256: sha256HexOfBytes(bytes),
			tokenBundleSize: bytes.byteLength,
		});
		const refused = await loadRoleTokenBundle({
			source: sealedFd({ bytes }),
			config,
			clock: instantClock,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("another child");
	});

	test("role_token_lookup_requires_a_merkle_proof_that_reaches_the_signed_root", () => {
		const cohort = buildCohort();
		const { config, bundle } = workerSpawnConfig(cohort, 3);
		const assigned = assignedGlobalOrdinals(config, cohort.grant);
		expect(assigned.ok).toBe(true);
		if (!assigned.ok) return;

		const selected = selectRoleTokenEntries({
			bundle,
			config,
			grant: cohort.grant,
			assignedRoleIds: assigned.value.roleIds,
		});
		expect(selected.ok).toBe(true);
		if (!selected.ok) return;
		expect(selected.value.map((entry) => entry.roleId)).toEqual([
			...assigned.value.roleIds,
		]);

		// Break one sibling: the entry still parses and still names the right
		// role, and is still refused, because the root is the only authority.
		const firstEntry = bundle.entries[0] as (typeof bundle.entries)[number];
		const tampered: TokenBundleV1 = {
			...bundle,
			entries: [
				{
					...firstEntry,
					tokenMerkleProofSha256: [
						HEX("e"),
						...firstEntry.tokenMerkleProofSha256.slice(1),
					],
				},
				...bundle.entries.slice(1),
			],
		};
		const refused = selectRoleTokenEntries({
			bundle: tampered,
			config,
			grant: cohort.grant,
			assignedRoleIds: assigned.value.roleIds,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("does not reach the root");
	});

	test("role_token_lookup_rejects_a_token_that_belongs_to_another_shard", () => {
		const cohort = buildCohort();
		const { config } = workerSpawnConfig(cohort, 2);
		const assigned = assignedGlobalOrdinals(config, cohort.grant);
		expect(assigned.ok).toBe(true);
		if (!assigned.ok) return;

		// A genuine cohort token with a genuine proof -- but for worker 5's shard,
		// delivered in worker 2's bundle under worker 2's assigned role IDs.
		const foreign = tokenBundleFor(cohort, {
			childId: "subscriber-worker-2",
			roleIds: assigned.value.roleIds.map(
				(_unused, index) =>
					`subscriber-${(5 + index * SUBSCRIBER_SHARD_MODULUS)
						.toString()
						.padStart(6, "0")}`,
			),
			role: "subscriber",
		});
		const refused = selectRoleTokenEntries({
			bundle: foreign,
			config,
			grant: cohort.grant,
			assignedRoleIds: assigned.value.roleIds,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("missing assigned role");
	});

	// -------------------------------------------------------------------------
	// Window bookkeeping
	// -------------------------------------------------------------------------

	test("publisher_books_every_ack_in_the_immutable_origin_window", () => {
		const book = new PublisherWindowBook({
			windowCount: WINDOW_COUNT,
			messageBytes: MESSAGE_BYTES,
		});
		for (let window = 0; window < WINDOW_COUNT; window += 1) {
			expect(
				book.recordOffer({ originWindowIndex: window, atMacNs: "1" }).ok,
			).toBe(true);
		}
		// The acknowledgement for window 0 arrives while window 7 is being
		// offered. §4.5 forbids relabelling it into the window it arrived in.
		book.recordAck({
			originWindowIndex: 0,
			disposition: "accepted",
			atMacNs: "7000000000",
		});
		book.recordAck({
			originWindowIndex: 1,
			disposition: "duplicate",
			atMacNs: "7000000001",
		});
		book.recordAck({
			originWindowIndex: 2,
			disposition: "reordered",
			atMacNs: "7000000002",
		});

		const partial = book.toPartial({
			executionSha256: HEX("1"),
			cohortGrantSha256: HEX("2"),
			cohortStartBarrierSha256: HEX("3"),
			childId: "publisher-child-0",
			process: { pid: 4242, pgid: 4242 },
			childInstanceNonce: HEX("4"),
			publisherId: "publisher-000000",
			tokenSha256: HEX("5"),
			macClockId: "mac-clock-1",
			measureStartAtMacNs: "1000000000",
		});
		expect(partial.ok).toBe(true);
		if (!partial.ok) return;
		expect(partial.value.offeredByOriginWindow).toEqual(
			new Array(WINDOW_COUNT).fill(1),
		);
		expect(partial.value.offeredBytesByOriginWindow[3]).toBe(MESSAGE_BYTES);
		expect(partial.value.acceptedAckSeenByOriginWindow[0]).toBe(1);
		expect(partial.value.acceptedAckSeenByOriginWindow[7]).toBe(0);
		expect(partial.value.duplicateAckSeenByOriginWindow[1]).toBe(1);
		expect(partial.value.reorderedAckSeenByOriginWindow[2]).toBe(1);
	});

	test("publisher_with_no_offer_reports_the_barrier_start_not_the_current_time", () => {
		const book = new PublisherWindowBook({
			windowCount: WINDOW_COUNT,
			messageBytes: MESSAGE_BYTES,
		});
		const partial = book.toPartial({
			executionSha256: HEX("1"),
			cohortGrantSha256: HEX("2"),
			cohortStartBarrierSha256: HEX("3"),
			childId: "publisher-child-0",
			process: { pid: 1, pgid: 1 },
			childInstanceNonce: HEX("4"),
			publisherId: "publisher-000000",
			tokenSha256: HEX("5"),
			macClockId: "mac-clock-1",
			measureStartAtMacNs: "1000000000",
		});
		expect(partial.ok).toBe(true);
		if (!partial.ok) return;
		expect(partial.value.firstOfferAtMacNs).toBe("1000000000");
		expect(partial.value.lastAckAtMacNs).toBe("1000000000");
	});

	test("worker_event_window_comes_from_delivery_time_and_origin_window_does_not_move", () => {
		const ids = ["subscriber-000000", "subscriber-000008"];
		const book = new WorkerWindowBook({
			windowCount: WINDOW_COUNT,
			messageBytes: MESSAGE_BYTES,
			orderedSubscriberIds: ids,
		});
		const start = 1_000_000_000n;

		// Offered in origin window 0, delivered 1 ns after the window-1 boundary:
		// the origin family keeps window 0, the rate family moves to window 1.
		const delivered = book.recordDelivery({
			subscriberId: "subscriber-000000",
			publisherId: "publisher-000000",
			publisherSequence: 0,
			originWindowIndex: 0,
			deliveredAtMacNs: (start + 1_000_000_001n).toString() as NsString,
			eventWindow: 1,
		});
		expect(delivered.ok).toBe(true);

		const partial = book.toPartial({
			executionSha256: HEX("1"),
			cohortGrantSha256: HEX("2"),
			cohortStartBarrierSha256: HEX("3"),
			childId: "subscriber-worker-0",
			process: { pid: 9, pgid: 9 },
			childInstanceNonce: HEX("4"),
			workerIndex: 0,
			tokenBundleSha256: HEX("5"),
			macClockId: "mac-clock-1",
			measureStartAtMacNs: start.toString() as NsString,
		});
		expect(partial.ok).toBe(true);
		if (!partial.ok) return;
		expect(partial.value.deliveredByOriginWindow[0]).toBe(1);
		expect(partial.value.deliveredByOriginWindow[1]).toBe(0);
		expect(partial.value.deliveredByEventWindow[0]).toBe(0);
		expect(partial.value.deliveredByEventWindow[1]).toBe(1);
		expect(partial.value.deliveredBytesByOriginWindow[0]).toBe(MESSAGE_BYTES);
		expect(partial.value.orderedSubscriberIdsSha256).toBe(
			orderedSubscriberIdsSha256(ids),
		);
	});

	test("worker_post_stop_delivery_leaves_the_measured_windows_and_stays_in_conservation", () => {
		const book = new WorkerWindowBook({
			windowCount: WINDOW_COUNT,
			messageBytes: MESSAGE_BYTES,
			orderedSubscriberIds: ["subscriber-000000"],
		});
		book.recordDelivery({
			subscriberId: "subscriber-000000",
			publisherId: "publisher-000000",
			publisherSequence: 0,
			originWindowIndex: 9,
			deliveredAtMacNs: "2000000000",
			eventWindow: null,
		});
		const partial = book.toPartial({
			executionSha256: HEX("1"),
			cohortGrantSha256: HEX("2"),
			cohortStartBarrierSha256: HEX("3"),
			childId: "subscriber-worker-0",
			process: { pid: 9, pgid: 9 },
			childInstanceNonce: HEX("4"),
			workerIndex: 0,
			tokenBundleSha256: HEX("5"),
			macClockId: "mac-clock-1",
			measureStartAtMacNs: "1000000000",
		});
		expect(partial.ok).toBe(true);
		if (!partial.ok) return;
		// Conservation still sees it; the rate series never does.
		expect(partial.value.deliveredByOriginWindow[9]).toBe(1);
		expect(partial.value.deliveredAfterMeasureStop).toBe(1);
		expect(partial.value.deliveredBytesAfterMeasureStop).toBe(MESSAGE_BYTES);
		expect(
			partial.value.deliveredByEventWindow.reduce((sum, n) => sum + n, 0),
		).toBe(0);
		expect(partial.value.perSubscriberDelivered).toEqual([1]);
	});

	test("worker_counts_duplicate_reordered_and_foreign_deliveries_without_booking_them", () => {
		const book = new WorkerWindowBook({
			windowCount: WINDOW_COUNT,
			messageBytes: MESSAGE_BYTES,
			orderedSubscriberIds: ["subscriber-000000"],
		});
		const delivery = (publisherSequence: number) => ({
			subscriberId: "subscriber-000000",
			publisherId: "publisher-000000",
			publisherSequence,
			originWindowIndex: 0,
			deliveredAtMacNs: "1000000000" as NsString,
			eventWindow: 0,
		});
		expect(book.recordDelivery(delivery(0)).ok).toBe(true);
		// Same (publisher, sequence) twice is a duplicate and is not booked.
		expect(book.recordDelivery(delivery(0)).ok).toBe(false);
		// Sequence 2 before sequence 1 is out of order twice over: the gap when 2
		// arrives early, and the late arrival of 1. Both are still delivered.
		expect(book.recordDelivery(delivery(2)).ok).toBe(true);
		expect(book.recordDelivery(delivery(1)).ok).toBe(true);
		// A subscriber outside this shard is malformed, never a delivery.
		const foreign = book.recordDelivery({
			...delivery(3),
			subscriberId: "subscriber-000001",
		});
		expect(foreign.ok).toBe(false);

		const partial = book.toPartial({
			executionSha256: HEX("1"),
			cohortGrantSha256: HEX("2"),
			cohortStartBarrierSha256: HEX("3"),
			childId: "subscriber-worker-0",
			process: { pid: 9, pgid: 9 },
			childInstanceNonce: HEX("4"),
			workerIndex: 0,
			tokenBundleSha256: HEX("5"),
			macClockId: "mac-clock-1",
			measureStartAtMacNs: "1000000000",
		});
		expect(partial.ok).toBe(true);
		if (!partial.ok) return;
		expect(partial.value.duplicateCount).toBe(1);
		expect(partial.value.reorderCount).toBe(2);
		expect(partial.value.malformedCount).toBe(1);
		expect(partial.value.deliveredByOriginWindow[0]).toBe(3);
		expect(partial.value.perSubscriberDelivered).toEqual([3]);
	});

	test("worker_refuses_an_origin_window_outside_the_barrier_window_count", () => {
		const book = new WorkerWindowBook({
			windowCount: WINDOW_COUNT,
			messageBytes: MESSAGE_BYTES,
			orderedSubscriberIds: ["subscriber-000000"],
		});
		const refused = book.recordDelivery({
			subscriberId: "subscriber-000000",
			publisherId: "publisher-000000",
			publisherSequence: 0,
			originWindowIndex: WINDOW_COUNT,
			deliveredAtMacNs: "1000000000",
			eventWindow: 0,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.code).toBe("MEASUREMENT_WINDOW");
	});

	test("barrier_arm_delay_is_the_frozen_250_ms", () => {
		expect(COHORT_BARRIER_MIN_ARM_DELAY_NS).toBe(250_000_000n);
	});

	// -------------------------------------------------------------------------
	// Transition authority
	// -------------------------------------------------------------------------

	test("warmup_start_authority_is_the_signature_not_the_carried_digest", () => {
		const cohort = buildCohort();
		const config = spawnConfig(cohort);

		const accepted = verifyRoleWarmupStart({
			frame: warmupStartFrame(cohort),
			config,
			grant: cohort.grant,
			macSigningPublicKey: cohort.keys.publicRaw32,
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.value.epoch.cohortId).toBe(COHORT_ID);

		// Every digest in the frame still commits to the bytes it carries -- the
		// frame is internally consistent. Only the signature is another key's.
		const other = generateEd25519KeyPair();
		const forged = warmupStartFrame(cohort, { signWith: other });
		const refused = verifyRoleWarmupStart({
			frame: forged,
			config,
			grant: cohort.grant,
			macSigningPublicKey: cohort.keys.publicRaw32,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.code).toBe("WARMUP_PROTOCOL");
		expect(refused.message).toContain("does not verify");
	});

	test("warmup_start_rejects_an_epoch_bound_to_another_cohort", () => {
		const cohort = buildCohort();
		const refused = verifyRoleWarmupStart({
			frame: warmupStartFrame(cohort, { cohortId: "cohort-other" }),
			config: spawnConfig(cohort),
			grant: cohort.grant,
			macSigningPublicKey: cohort.keys.publicRaw32,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("not bound to this cohort");
	});

	test("measure_start_recomputes_the_barrier_digest_from_the_bytes_it_was_handed", () => {
		const cohort = buildCohort();
		const barrier = startBarrier(cohort);
		const armed = verifyRoleMeasureStart({
			frame: measureStartFrame(barrier, cohort),
			config: spawnConfig(cohort),
			grant: cohort.grant,
		});
		expect(armed.ok).toBe(true);
		if (!armed.ok) return;
		expect(armed.value.cohortStartBarrierSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(barrier)),
		);
		expect(armed.value.barrier.macClockId).toBe("mac-clock-b3");
	});

	test("measure_start_refuses_a_barrier_that_arms_sooner_than_250_ms_after_minting", () => {
		const cohort = buildCohort();
		const config = spawnConfig(cohort);
		const minted = 5_000_000_000n;

		// The measured span itself stays exactly 10 s in both cases, so the only
		// thing that differs is the arming gap.
		const armedAt = (gapNs: bigint) =>
			startBarrier(cohort, {
				mintedAtMacNs: minted.toString() as NsString,
				warmupStartedAtMacNs: minted.toString() as NsString,
				warmupCompletedAtMacNs: minted.toString() as NsString,
				measureStartAtMacNs: (minted + gapNs).toString() as NsString,
				measureStopAtMacNs: (
					minted +
					gapNs +
					10_000_000_000n
				).toString() as NsString,
			});

		// Exactly 250 ms is the boundary and is legal; one nanosecond less is not.
		const onTime = verifyRoleMeasureStart({
			frame: measureStartFrame(armedAt(250_000_000n), cohort),
			config,
			grant: cohort.grant,
		});
		expect(onTime.ok).toBe(true);

		const early = verifyRoleMeasureStart({
			frame: measureStartFrame(armedAt(249_999_999n), cohort),
			config,
			grant: cohort.grant,
		});
		expect(early.ok).toBe(false);
		if (early.ok) return;
		expect(early.code).toBe("COHORT_NOT_READY");
	});

	test("measure_start_refuses_a_barrier_whose_schedule_is_not_the_signed_schedule", () => {
		const cohort = buildCohort();
		const config = spawnConfig(cohort);
		const start = 5_250_000_000n;
		const longer = startBarrier(cohort, {
			measuredDurationMs: 30_000,
			windowCount: 30,
			measureStopAtMacNs: (start + 30_000_000_000n).toString() as NsString,
		});
		const refused = verifyRoleMeasureStart({
			frame: measureStartFrame(longer, cohort),
			config,
			grant: cohort.grant,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("not the signed duration");
	});

	// -------------------------------------------------------------------------
	// Control-pipe reassembly
	// -------------------------------------------------------------------------

	test("role_child_frame_reader_reassembles_across_arbitrary_chunk_boundaries", () => {
		const frames = [
			{ schema: "role-ready/v1", sequence: 0, childId: "publisher-child-0" },
			{ schema: "role-stop/v1", sequence: 1, childId: "publisher-child-0" },
		].map((record) => {
			const encoded = encodeRoleChildFrame(record);
			if (!encoded.ok) throw new Error(`encode: ${encoded.code}`);
			return encoded.value;
		});
		const stream = new Uint8Array(
			frames.reduce((total, frame) => total + frame.byteLength, 0),
		);
		let offset = 0;
		for (const frame of frames) {
			stream.set(frame, offset);
			offset += frame.byteLength;
		}

		// A pipe splits wherever it likes, including inside a length prefix.
		const reader = new RoleChildFrameReader();
		const out: Uint8Array[] = [];
		for (let index = 0; index < stream.byteLength; index += 1) {
			const pushed = reader.push(stream.subarray(index, index + 1));
			expect(pushed.ok).toBe(true);
			if (!pushed.ok) return;
			out.push(...pushed.value);
		}
		expect(out.length).toBe(2);
		expect(reader.pendingBytes).toBe(0);
		expect(reader.endOfStream().ok).toBe(true);
		const decoded = decodeRoleChildFrame(out[0] as Uint8Array, "role-ready/v1");
		expect(decoded.ok).toBe(true);
	});

	test("role_child_frame_reader_refuses_a_lying_length_prefix_before_buffering_it", () => {
		const reader = new RoleChildFrameReader();
		// Declares 16 MiB with four bytes on the wire. Nothing is buffered for it.
		const lying = new Uint8Array(4);
		new DataView(lying.buffer).setUint32(0, 16 * 1024 * 1024, false);
		const refused = reader.push(lying);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.code).toBe("FRAME_INVALID");
		// The stream is terminal, not merely behind: a poisoned reader stays shut.
		expect(reader.push(new Uint8Array([0, 0, 0, 1, 0x7b])).ok).toBe(false);
	});

	test("role_child_frame_reader_treats_a_stream_ending_mid_frame_as_truncation", () => {
		const reader = new RoleChildFrameReader();
		const encoded = encodeRoleChildFrame({
			schema: "role-ready/v1",
			sequence: 0,
			childId: "publisher-child-0",
		});
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) return;
		const partial = encoded.value.subarray(0, encoded.value.byteLength - 1);
		expect(reader.push(partial).ok).toBe(true);
		expect(reader.pendingBytes).toBe(partial.byteLength);
		expect(reader.endOfStream().ok).toBe(false);
	});

	test("measure_start_refuses_a_caller_clock_id_that_replaces_the_barrier_clock", () => {
		const cohort = buildCohort();
		const refused = verifyRoleMeasureStart({
			frame: measureStartFrame(startBarrier(cohort), cohort),
			config: spawnConfig(cohort),
			grant: cohort.grant,
			macClockId: "mac-clock-somewhere-else",
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.message).toContain("barrier's clock");
	});
});

// ---------------------------------------------------------------------------
// The Linux-authoritative side (B3)
//
// The block above proves what a role child will and will not accept. This one
// proves the same thing from the other end of the wire: what the Linux server
// will and will not do without a Mac signature, and that the record it emits
// afterwards is the only place the cohort's registration, ingress, capacity and
// fault numbers come from.
//
// The cohort here is two publishers and eight subscribers -- one per shard --
// the smallest cohort with every worker populated; its shards are the token
// fixture's own (residue-class windows of one member each, R-A).
// ---------------------------------------------------------------------------

const LINUX_SUBSCRIBER_COUNT = COHORT_WORKER_COUNT;
const LINUX_COHORT_ID = "cohort-b3-linux";
const LINUX_CLOCK_ID = "linux-monotonic-b3";
const RECEIPT_VALIDITY_MS = 60_000;

interface LinuxCohortFixtures {
	readonly mac: Ed25519KeyPairBytes;
	readonly rig: Ed25519KeyPairBytes;
	readonly tokens: FanoutCohortFixture;
	readonly grant: CohortGrantV1;
	readonly grantBytes: Uint8Array;
	readonly grantSha256: Sha256Hex;
	readonly grantSignature: MacReceiptSignatureV1;
	readonly executionSha256: Sha256Hex;
}

function buildLinuxCohort(
	overrides: Partial<CohortGrantV1> = {},
	options: { readonly mac?: Ed25519KeyPairBytes } = {},
): LinuxCohortFixtures {
	const mac = options.mac ?? generateEd25519KeyPair();
	const rig = generateEd25519KeyPair();
	const tokens = buildFanoutCohortFixture({
		cohortId: LINUX_COHORT_ID,
		publisherCount: PUBLISHER_COUNT,
		subscriberCount: LINUX_SUBSCRIBER_COUNT,
	});
	const workloadBytes = bytesOfCanonical({
		plan: "b3-linux-role-plan",
		cohortId: LINUX_COHORT_ID,
	});
	const transport = (overrides.transport ?? "ws") as "ws" | "wt";
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
			runId: `camp/ticker-fanout-250/${transport}/measured-1`,
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-250",
			scenarioHash: HEX("5"),
			rolePlanHash: HEX("6"),
			workloadRolePlanInputSha256: sha256HexOfBytes(workloadBytes),
			stagedServerLaunchRecordSha256: sha256HexOfBytes(
				bytesOfCanonical(stagedLaunchRecord(transport)),
			),
			armKind: "primary",
			transport,
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			grantDeclaration: "fanout-expanded-deliveries",
			declaredMessageCount: 250_000,
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

	const offeredIngress = 40;
	const grant: CohortGrantV1 = {
		schema: "cohort-grant/v1",
		execution,
		executionSha256,
		macExecutionGrantReceiptSha256: HEX("9"),
		approvedPlanSha256: execution.approvedPlanSha256,
		approvalRecordSha256: execution.approvalRecordSha256,
		cohortId: LINUX_COHORT_ID,
		cohortAttempt: 1,
		scenarioHash: execution.scenarioHash,
		rolePlanHash: execution.rolePlanHash,
		workloadRolePlanInputSha256: execution.workloadRolePlanInputSha256,
		transport,
		publisherCount: PUBLISHER_COUNT,
		subscriberCount: LINUX_SUBSCRIBER_COUNT,
		workerCount: 8,
		expectedProcessCount: PUBLISHER_COUNT + COHORT_WORKER_COUNT,
		expectedSessionCount: PUBLISHER_COUNT + LINUX_SUBSCRIBER_COUNT,
		publishers: [...tokens.publishers],
		subscriberShards: [...tokens.subscriberShards],
		tokenCommitmentLeafManifestSha256: HEX("0"),
		roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
		roleTokenCommitmentCount: tokens.roleTokenCommitmentCount,
		connectionRatePerSecond: 500,
		maxConnectionsInFlight: 200,
		readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
		inRepetitionWarmupMs: 5_000,
		sampleWindowMs: 1_000,
		measuredDurationMs: 10_000,
		drainDeadlineMs: 10_000,
		messageBytes: MESSAGE_BYTES,
		expectedOfferedIngress: offeredIngress,
		expectedExpandedDeliveries: offeredIngress * LINUX_SUBSCRIBER_COUNT,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
		receiptSequence: 1,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	};
	const grantBytes = bytesOfCanonical(grant);
	return {
		mac,
		rig,
		tokens,
		grant,
		grantBytes,
		grantSha256: sha256HexOfBytes(grantBytes),
		grantSignature: signMacReceipt({
			privatePkcs8Der: mac.privatePkcs8Der,
			publicRaw32: mac.publicRaw32,
			signedSchema: "cohort-grant/v1",
			signedBytes: grantBytes,
		}),
		executionSha256,
	};
}

function linuxAuthority(
	cohort: LinuxCohortFixtures,
	clock: ManualRelayClock,
	overrides: Partial<FanoutLinuxAuthorityConfig> = {},
): FanoutLinuxAuthority {
	return new FanoutLinuxAuthority({
		transport: cohort.grant.transport,
		executionSha256: cohort.executionSha256,
		stagedMacPublicRaw32: cohort.mac.publicRaw32,
		serverIdentity: SERVER_IDENTITY,
		linuxClockId: LINUX_CLOCK_ID,
		clock,
		receiptValidityMs: RECEIPT_VALIDITY_MS,
		...overrides,
	});
}

const SERVER_IDENTITY = {
	serverChildPid: 4_242,
	serverChildPgid: 4_242,
	serverChildInstanceNonce: HEX("d"),
};

// ---------------------------------------------------------------------------
// The scripted rig supervisor
//
// Round three's authority ruling (design §1.1) makes the rig supervisor
// process the sole Linux signer, and takes the five rig records out of the
// server child. The production signer is `cohort::rig` in
// `crates/native/src/secure_fs.rs`; what these tests need is a TS stand-in that
// signs the same five records from the same inputs -- the child's exact frame
// bytes -- so every property this file asserted about those records still has
// something to assert against.
//
// The rule it exists to keep honest is §1.3's: it digests the bytes the child
// handed it, never a record it rebuilt from parsed fields. Every method below
// takes a `frameBytes`/`observationBytes` and hashes that, not its argument's
// parsed twin.
// ---------------------------------------------------------------------------

const RIG_SUPERVISOR_NONCE = HEX("b");
const RIG_EXECUTION_ACCEPTANCE_SHA = HEX("c");
const RIG_EXECUTION_INDEX = 0;

interface RigSigned<T> {
	readonly record: T;
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
	readonly signature: RigReceiptSignatureV1;
}

class ScriptedRigSupervisor {
	private readonly rigKeys: Ed25519KeyPairBytes;
	private readonly clock: ManualRelayClock;
	private readonly linuxClockId: string;
	private readonly receiptValidityMs: number;
	private receiptSequence = 0;

	constructor(
		rigKeys: Ed25519KeyPairBytes,
		clock: ManualRelayClock,
		options: {
			readonly linuxClockId?: string;
			readonly receiptValidityMs?: number;
		} = {},
	) {
		this.rigKeys = rigKeys;
		this.clock = clock;
		this.linuxClockId = options.linuxClockId ?? LINUX_CLOCK_ID;
		this.receiptValidityMs = options.receiptValidityMs ?? RECEIPT_VALIDITY_MS;
	}

	get signingPublicKeySha256(): Sha256Hex {
		return sha256HexOfBytes(this.rigKeys.publicRaw32);
	}

	private next(): number {
		this.receiptSequence += 1;
		return this.receiptSequence;
	}

	private sign<T>(
		signedSchema: RigReceiptSignatureV1["signedSchema"],
		parsed: ProtocolResult<T>,
	): RigSigned<T> {
		if (!parsed.ok) throw new Error(`rig ${signedSchema}: ${parsed.code}`);
		const bytes = bytesOfCanonical(parsed.value);
		return {
			record: parsed.value,
			bytes,
			sha256: sha256HexOfBytes(bytes),
			signature: signRigReceipt({
				privatePkcs8Der: this.rigKeys.privatePkcs8Der,
				publicRaw32: this.rigKeys.publicRaw32,
				signedSchema,
				signedBytes: bytes,
			}),
		};
	}

	/** §5 `COHORT_GRANTED`: `accept_cohort` (`secure_fs.rs:15564`). */
	acceptCohort(
		accepted: FanoutCohortAcceptance,
		nowMs = NOW_MS,
	): RigSigned<RigCohortAcceptanceV1> {
		return this.sign(
			"rig-cohort-acceptance/v1",
			parseRigCohortAcceptance({
				schema: "rig-cohort-acceptance/v1",
				executionSha256: accepted.grant.executionSha256,
				cohortGrantSha256: accepted.cohortGrantSha256,
				cohortGrantSignatureSha256: accepted.cohortGrantSignatureSha256,
				roleTokenCommitmentRootSha256:
					accepted.grant.roleTokenCommitmentRootSha256,
				approvedPlanSha256: accepted.grant.approvedPlanSha256,
				approvalRecordSha256: accepted.grant.approvalRecordSha256,
				rigExecutionIndex: RIG_EXECUTION_INDEX,
				rigSupervisorInstanceNonce: RIG_SUPERVISOR_NONCE,
				signingPublicKeySha256: this.signingPublicKeySha256,
				receiptSequence: this.next(),
				acceptedAtMs: nowMs,
				issuedAtMs: nowMs,
				notAfterMs: nowMs + this.receiptValidityMs,
			}),
		);
	}

	/** §5 `IN_REPETITION_WARMUP`: `finish_warmup` (`secure_fs.rs:15835`). */
	warmupDrained(args: {
		readonly drained: FanoutWarmupDrainedResult;
		readonly cohortGrantSha256: Sha256Hex;
		readonly cohortWarmupEpochSha256: Sha256Hex;
		readonly cohortWarmupEpochSignatureSha256: Sha256Hex;
		readonly roleWarmupCompletionManifestSha256: Sha256Hex;
		readonly roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
		readonly nowMs?: number;
	}): RigSigned<RigWarmupDrainedReceiptV1> {
		const nowMs = args.nowMs ?? NOW_MS;
		return this.sign(
			"rig-warmup-drained-receipt/v1",
			parseRigWarmupDrainedReceipt({
				schema: "rig-warmup-drained-receipt/v1",
				executionSha256: args.drained.frame.executionSha256,
				cohortGrantSha256: args.cohortGrantSha256,
				cohortWarmupEpochSha256: args.cohortWarmupEpochSha256,
				cohortWarmupEpochSignatureSha256: args.cohortWarmupEpochSignatureSha256,
				roleWarmupCompletionManifestSha256:
					args.roleWarmupCompletionManifestSha256,
				roleWarmupCompletionManifestSignatureSha256:
					args.roleWarmupCompletionManifestSignatureSha256,
				// §1.3: the digest of the bytes the child sent.
				serverWarmupDrainedSha256: args.drained.frameSha256,
				rigSupervisorInstanceNonce: RIG_SUPERVISOR_NONCE,
				signingPublicKeySha256: this.signingPublicKeySha256,
				receiptSequence: this.next(),
				receivedAtRigNs: this.clock.nowNs(),
				linuxClockId: this.linuxClockId,
				issuedAtMs: nowMs,
				notAfterMs: nowMs + this.receiptValidityMs,
			}),
		);
	}

	/** §5 `LINUX_BASELINE`: the ack minted in `finish_warmup` (`:16097`). */
	measureStartAck(args: {
		readonly ack: FanoutMeasureStartAckResultV1;
		readonly measurementGrantSha256: Sha256Hex;
		readonly macExecutionGrantReceiptSha256: Sha256Hex;
		readonly approvedPlanSha256: Sha256Hex;
		readonly approvalRecordSha256: Sha256Hex;
		readonly warmupCompletionSha256: Sha256Hex;
		readonly nowMs?: number;
	}): {
		readonly bytes: Uint8Array;
		readonly sha256: Sha256Hex;
		readonly signature: RigReceiptSignatureV1;
	} {
		const nowMs = args.nowMs ?? NOW_MS;
		// `rig-measure-start-ack/v1` has no parser in `cohort-protocol.ts`; its
		// TS owner is `server-observation-artifact.ts` (design §4, S5-RIG). The
		// two child-observed numbers are carried verbatim, which is the whole
		// point of the hand-off.
		const record = {
			schema: "rig-measure-start-ack/v1" as const,
			executionSha256: args.ack.frame.executionSha256,
			measurementGrantSha256: args.measurementGrantSha256,
			macExecutionGrantReceiptSha256: args.macExecutionGrantReceiptSha256,
			rigExecutionAcceptanceSha256: RIG_EXECUTION_ACCEPTANCE_SHA,
			approvedPlanSha256: args.approvedPlanSha256,
			approvalRecordSha256: args.approvalRecordSha256,
			baselineBusyMs: args.ack.frame.baselineBusyMs,
			baselineAtLinuxNs: args.ack.frame.baselineAtLinuxNs,
			linuxClockId: args.ack.frame.linuxClockId,
			warmupCompletionSha256: args.warmupCompletionSha256,
			signingPublicKeySha256: this.signingPublicKeySha256,
			receiptSequence: this.next(),
			issuedAtMs: nowMs,
			notAfterMs: nowMs + this.receiptValidityMs,
		};
		const bytes = bytesOfCanonical(record);
		return {
			bytes,
			sha256: sha256HexOfBytes(bytes),
			signature: signRigReceipt({
				privatePkcs8Der: this.rigKeys.privatePkcs8Der,
				publicRaw32: this.rigKeys.publicRaw32,
				signedSchema: "rig-measure-start-ack/v1",
				signedBytes: bytes,
			}),
		};
	}

	/** §5 `START_BARRIER`: `present_start_barrier` (`secure_fs.rs:16357`). */
	barrierAcceptance(args: {
		readonly accepted: FanoutBarrierAcceptanceResult;
		readonly cohortGrantSha256: Sha256Hex;
		readonly cohortStartBarrierSignature: MacReceiptSignatureV1;
		readonly rigMeasureStartAckSha256: Sha256Hex;
		readonly nowMs?: number;
	}): RigSigned<RigBarrierAcceptanceV1> {
		const nowMs = args.nowMs ?? NOW_MS;
		return this.sign(
			"rig-barrier-acceptance/v1",
			parseRigBarrierAcceptance({
				schema: "rig-barrier-acceptance/v1",
				executionSha256: args.accepted.frame.executionSha256,
				cohortGrantSha256: args.cohortGrantSha256,
				cohortStartBarrierSha256: args.accepted.frame.cohortStartBarrierSha256,
				cohortStartBarrierSignatureSha256: sha256HexOfBytes(
					bytesOfCanonical(args.cohortStartBarrierSignature),
				),
				rigMeasureStartAckSha256: args.rigMeasureStartAckSha256,
				serverStartBarrierAcceptedSha256: args.accepted.frameSha256,
				rigSupervisorInstanceNonce: RIG_SUPERVISOR_NONCE,
				signingPublicKeySha256: this.signingPublicKeySha256,
				receiptSequence: this.next(),
				acceptedAtLinuxNs: args.accepted.frame.acceptedAtLinuxNs,
				linuxClockId: args.accepted.frame.linuxClockId,
				issuedAtMs: nowMs,
				notAfterMs: nowMs + this.receiptValidityMs,
			}),
		);
	}

	/** §5 `LINUX_CAPTURE`: `stop_and_capture`'s observation receipt. */
	relayObservation(args: {
		readonly observation: FanoutRelayObservationResult;
		readonly cohortGrantSha256: Sha256Hex;
		readonly cohortStartBarrierSha256: Sha256Hex;
		readonly nowMs?: number;
	}): RigSigned<RigRelayObservationReceiptV1> {
		const nowMs = args.nowMs ?? NOW_MS;
		return this.sign(
			"rig-relay-observation-receipt/v1",
			parseRigRelayObservationReceipt({
				schema: "rig-relay-observation-receipt/v1",
				executionSha256: args.observation.observation.executionSha256,
				cohortGrantSha256: args.cohortGrantSha256,
				cohortStartBarrierSha256: args.cohortStartBarrierSha256,
				// §1.3 again: the digest of the bytes, not of a rebuild.
				linuxRelayObservationSha256: args.observation.observationSha256,
				rigExecutionAcceptanceSha256: RIG_EXECUTION_ACCEPTANCE_SHA,
				rigSupervisorInstanceNonce: RIG_SUPERVISOR_NONCE,
				signingPublicKeySha256: this.signingPublicKeySha256,
				receiptSequence: this.next(),
				receivedAtRigNs: this.clock.nowNs(),
				issuedAtMs: nowMs,
				notAfterMs: nowMs + this.receiptValidityMs,
			}),
		);
	}
}

const NOW_MS = 1_500;

/** One loopback role session against the relay: no socket, exact frames. */
interface LinuxPeer {
	readonly roleId: string;
	send(frame: FanoutWireV1): ProtocolResult<true>;
	received(): readonly FanoutWireV1[];
	block(): void;
}

/** The register frame a role child sends, built from the cohort's own tokens. */
function registerFrameFor(
	tokens: FanoutCohortFixture,
	grantSha256: Sha256Hex,
	transport: "ws" | "wt",
	role: "publisher" | "subscriber",
	roleId: string,
): FanoutWireV1 {
	return {
		schema: "fanout-wire/v1",
		kind: "register",
		cohortGrantSha256: grantSha256,
		transport,
		role,
		childId: tokens.childIdByRoleId.get(roleId) as string,
		roleId,
		workerIndex: tokens.workerIndexByRoleId.get(roleId) ?? null,
		tokenBase64: tokens.tokenBase64ByRoleId.get(roleId) as Base64,
		tokenSha256: tokens.tokenSha256ByRoleId.get(roleId) as Sha256Hex,
		tokenCommitmentIndex: tokens.commitmentIndexByRoleId.get(roleId) as number,
		tokenMerkleProofSha256: [
			...(tokens.proofByRoleId.get(roleId) as readonly Sha256Hex[]),
		],
	};
}

/** A blockable loopback sink plus the inbox it decodes into. */
function loopbackPeerSink(transport: "ws" | "wt"): {
	readonly sink: RelaySessionSink;
	readonly inbox: FanoutWireV1[];
	block(): void;
} {
	const codec = fanoutFrameCodecFor(transport);
	const inbox: FanoutWireV1[] = [];
	let blocked = false;
	const take = (bytes: Uint8Array): "accepted" | "would-block" => {
		if (blocked) return "would-block";
		// A compact delivery is decoded to prove the relay wrote a well-formed
		// unit; only the JSON frames are kept, which is all these tests read.
		if (fanoutDeliveryUnitKind(bytes, transport) === "compact") {
			const delivery = decodeFanoutDelivery(bytes, MESSAGE_BYTES);
			if (!delivery.ok) throw new Error(`peer delivery: ${delivery.code}`);
			return "accepted";
		}
		const decoded = codec.decode(bytes);
		if (!decoded.ok) throw new Error(`peer decode: ${decoded.code}`);
		inbox.push(decoded.value);
		return "accepted";
	};
	return {
		sink: {
			trySend: take,
			trySendDelivery: take,
			close: () => {},
		},
		inbox,
		block: () => {
			blocked = true;
		},
	};
}

/**
 * Bring a whole cohort's role peers up through the authority's own
 * `registerRolePeers`, in global-ordinal order: every subscriber before any
 * publisher, exactly as `resolveGlobalOrdinal` assigns them. The tests drive
 * the production admission path rather than an ad-hoc copy of it, so a change
 * that loosened the real one would show up here.
 */
function registerRolePeersOn(
	authority: FanoutLinuxAuthority,
	relay: FanoutRelay,
	tokens: FanoutCohortFixture,
	grantSha256: Sha256Hex,
	counts: {
		readonly publisherCount: number;
		readonly subscriberCount: number;
	},
): {
	readonly publishers: readonly LinuxPeer[];
	readonly subscribers: readonly LinuxPeer[];
} {
	const transport = relay.config.transport;
	const built: {
		readonly roleId: string;
		readonly role: "publisher" | "subscriber";
		readonly peer: ReturnType<typeof loopbackPeerSink>;
	}[] = [];
	for (let index = 0; index < counts.subscriberCount; index += 1) {
		built.push({
			roleId: fanoutRoleId("subscriber", index),
			role: "subscriber",
			peer: loopbackPeerSink(transport),
		});
	}
	for (let index = 0; index < counts.publisherCount; index += 1) {
		built.push({
			roleId: fanoutRoleId("publisher", index),
			role: "publisher",
			peer: loopbackPeerSink(transport),
		});
	}
	const registered = authority.registerRolePeers({
		peers: built.map((entry, globalOrdinal) => ({
			globalOrdinal,
			sink: entry.peer.sink,
			register: registerFrameFor(
				tokens,
				grantSha256,
				transport,
				entry.role,
				entry.roleId,
			),
		})),
	});
	if (!registered.ok) {
		throw new Error(`registerRolePeers: ${registered.code}`);
	}
	const peers = built.map((entry, index) => {
		const sessionId = registered.value.registered[index]?.sessionId as string;
		return {
			role: entry.role,
			peer: {
				roleId: entry.roleId,
				send: (frame: FanoutWireV1) => relay.handleInbound(sessionId, frame),
				received: () => entry.peer.inbox,
				block: () => entry.peer.block(),
			} satisfies LinuxPeer,
		};
	});
	return {
		publishers: peers
			.filter((entry) => entry.role === "publisher")
			.map((entry) => entry.peer),
		subscribers: peers
			.filter((entry) => entry.role === "subscriber")
			.map((entry) => entry.peer),
	};
}

const WARMUP_MESSAGES = 10;

function warmupEpochFor(
	cohort: LinuxCohortFixtures,
	overrides: Partial<CohortWarmupEpochV1> = {},
): { epoch: CohortWarmupEpochV1; bytes: Uint8Array; sha256: Sha256Hex } {
	const epoch: CohortWarmupEpochV1 = {
		schema: "cohort-warmup-epoch/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		cohortId: LINUX_COHORT_ID,
		warmupNonce: HEX("e"),
		durationMs: 5_000,
		warmupMessagesPerPublisher: 10,
		warmupIntervalMs: 500,
		expectedWarmupIngress: expectedWarmupIngress(PUBLISHER_COUNT),
		expectedWarmupDeliveries: expectedWarmupDeliveries(
			PUBLISHER_COUNT,
			LINUX_SUBSCRIBER_COUNT,
		),
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(cohort.mac.publicRaw32),
		receiptSequence: 2,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	};
	const bytes = bytesOfCanonical(epoch);
	return { epoch, bytes, sha256: sha256HexOfBytes(bytes) };
}

const MANIFEST_SHA = HEX("2");
const MANIFEST_SIG_SHA = HEX("3");
const MEASURE_START_ACK_SHA = HEX("4");
const MEASUREMENT_GRANT_SHA = HEX("5");

/**
 * The barrier a Mac would mint at this point: its four retained-record bindings
 * name exactly what the *rig* is holding.
 *
 * The Mac checks those bindings against the rig records the controller
 * presented, and the rig re-checks them at `present_start_barrier`
 * (`crates/native/src/secure_fs.rs:16385-16412`). The server child does not, and
 * cannot: since the authority ruling it holds none of the four records.
 */
function linuxStartBarrier(
	cohort: LinuxCohortFixtures,
	retained: {
		readonly rigCohortAcceptanceSha256: Sha256Hex;
		readonly rigWarmupDrainedReceiptSha256: Sha256Hex;
		readonly rigMeasureStartAckSha256?: Sha256Hex;
	},
	overrides: Partial<CohortStartBarrierV1> = {},
): CohortStartBarrierV1 {
	return {
		schema: "cohort-start-barrier/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		rigCohortAcceptanceSha256: retained.rigCohortAcceptanceSha256,
		rigMeasureStartAckSha256:
			retained.rigMeasureStartAckSha256 ?? MEASURE_START_ACK_SHA,
		roleWarmupCompletionManifestSha256: MANIFEST_SHA,
		roleWarmupCompletionManifestSignatureSha256: MANIFEST_SIG_SHA,
		rigWarmupDrainedReceiptSha256: retained.rigWarmupDrainedReceiptSha256,
		cohortId: LINUX_COHORT_ID,
		barrierNonce: HEX("6"),
		macClockId: "mac-clock-b3",
		warmupStartedAtMacNs: "4500000000",
		warmupCompletedAtMacNs: "4900000000",
		mintedAtMacNs: "5000000000",
		measureStartAtMacNs: "5250000000",
		measureStopAtMacNs: "15250000000",
		sampleWindowMs: 1_000,
		windowCount: WINDOW_COUNT,
		measuredDurationMs: 10_000,
		drainDeadlineMs: 10_000,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(cohort.mac.publicRaw32),
		receiptSequence: 3,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	};
}

function macSign(
	cohort: LinuxCohortFixtures,
	signedSchema: MacReceiptSignatureV1["signedSchema"],
	signedBytes: Uint8Array,
	signWith?: Ed25519KeyPairBytes,
): MacReceiptSignatureV1 {
	const keys = signWith ?? cohort.mac;
	return signMacReceipt({
		privatePkcs8Der: keys.privatePkcs8Der,
		publicRaw32: keys.publicRaw32,
		signedSchema,
		signedBytes,
	});
}

/** A whole cohort driven to the point named by `stopAfter`. */
interface LinuxSession {
	readonly cohort: LinuxCohortFixtures;
	readonly authority: FanoutLinuxAuthority;
	readonly relay: FanoutRelay;
	readonly clock: ManualRelayClock;
	readonly publishers: readonly LinuxPeer[];
	readonly subscribers: readonly LinuxPeer[];
	readonly acceptance: FanoutCohortAcceptance;
	readonly rig: ScriptedRigSupervisor;
	readonly rigAcceptance: RigSigned<RigCohortAcceptanceV1>;
	readonly epochSha256: Sha256Hex;
	readonly epochSignatureSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	drained?: FanoutWarmupDrainedResult;
	rigDrained?: RigSigned<RigWarmupDrainedReceiptV1>;
	measureStartAck?: FanoutMeasureStartAckResultV1;
	rigMeasureStartAckSha256?: Sha256Hex;
	barrier?: FanoutBarrierAcceptanceResult;
	rigBarrier?: RigSigned<RigBarrierAcceptanceV1>;
	barrierRecord?: CohortStartBarrierV1;
}

function payloadFor(label: string): {
	payloadBase64: Base64;
	payloadSha256: Sha256Hex;
} {
	return fanoutPayload(MESSAGE_BYTES, label);
}

/** The cohort as far as registration: grant verified, server ready, roles in. */
type LinuxRegistrationSession = Omit<
	LinuxSession,
	"epochSha256" | "epochSignatureSha256" | "warmupNonce"
>;

interface LinuxSessionOptions {
	readonly registerSubscribers?: number;
	readonly authority?: Partial<FanoutLinuxAuthorityConfig>;
}

/** Accept the grant, ready the server, and register every role. */
function openLinuxSessionAtRegistration(
	options: LinuxSessionOptions = {},
): LinuxRegistrationSession {
	const cohort = buildLinuxCohort();
	const clock = createManualRelayClock();
	const authority = linuxAuthority(cohort, clock, options.authority ?? {});
	const accepted = authority.acceptCohortGrant({
		grant: cohort.grant,
		signature: cohort.grantSignature,
		nowMs: NOW_MS,
	});
	if (!accepted.ok) throw new Error(`grant: ${accepted.code}`);
	const started = authority.startServer();
	if (!started.ok) throw new Error(`ready: ${started.code}`);
	const relay = started.value;

	const subscriberCount = options.registerSubscribers ?? LINUX_SUBSCRIBER_COUNT;
	const { publishers, subscribers } = registerRolePeersOn(
		authority,
		relay,
		cohort.tokens,
		cohort.grantSha256,
		{ publisherCount: PUBLISHER_COUNT, subscriberCount },
	);

	const rig = new ScriptedRigSupervisor(cohort.rig, clock);
	return {
		cohort,
		authority,
		relay,
		clock,
		publishers,
		subscribers,
		acceptance: accepted.value,
		rig,
		rigAcceptance: rig.acceptCohort(accepted.value),
	};
}

/** The same cohort, carried through the signed warmup epoch into warmup. */
function openLinuxSession(options: LinuxSessionOptions = {}): LinuxSession {
	const session = openLinuxSessionAtRegistration(options);
	const epoch = warmupEpochFor(session.cohort);
	const opened = session.authority.acceptWarmupEpoch({
		epoch: epoch.epoch,
		signature: macSign(session.cohort, "cohort-warmup-epoch/v1", epoch.bytes),
		nowMs: NOW_MS,
	});
	if (!opened.ok) throw new Error(`warmup epoch: ${opened.code}`);
	return {
		...session,
		epochSha256: epoch.sha256,
		epochSignatureSha256: sha256HexOfBytes(
			bytesOfCanonical(
				macSign(session.cohort, "cohort-warmup-epoch/v1", epoch.bytes),
			),
		),
		warmupNonce: epoch.epoch.warmupNonce,
	};
}

/** Offer the exact ten paced warmup frames per publisher and drain. */
function runWarmupAndDrain(session: LinuxSession): FanoutWarmupDrainedResult {
	for (const publisher of session.publishers) {
		for (let sequence = 0; sequence < WARMUP_MESSAGES; sequence += 1) {
			const sent = publisher.send({
				schema: "fanout-wire/v1",
				kind: "warmup-data",
				direction: "publisher-to-relay",
				cohortGrantSha256: session.cohort.grantSha256,
				cohortWarmupEpochSha256: session.epochSha256,
				warmupNonce: session.warmupNonce,
				publisherId: publisher.roleId,
				publisherSequence: sequence,
				subscriberId: null,
				linuxAcceptedOrdinal: null,
				...payloadFor(`${publisher.roleId}:warmup:${sequence}`),
				payloadBytes: MESSAGE_BYTES,
			});
			if (!sent.ok) throw new Error(`warmup data: ${sent.code}`);
		}
		const ended = publisher.send({
			schema: "fanout-wire/v1",
			kind: "warmup-end",
			cohortGrantSha256: session.cohort.grantSha256,
			cohortWarmupEpochSha256: session.epochSha256,
			warmupNonce: session.warmupNonce,
			role: "publisher",
			roleId: publisher.roleId,
			finalPublisherSequence: WARMUP_MESSAGES - 1,
			reason: "publisher-warmup-complete",
		});
		if (!ended.ok) throw new Error(`warmup end: ${ended.code}`);
	}
	const proven = session.authority.runWarmupWire();
	if (!proven.ok) throw new Error(`warmup wire: ${proven.code}`);
	const drained = session.authority.drainWarmup({
		sequence: 1,
		roleWarmupCompletionManifestSha256: MANIFEST_SHA,
	});
	if (!drained.ok) throw new Error(`drain: ${drained.code}`);
	session.drained = drained.value;
	session.rigDrained = session.rig.warmupDrained({
		drained: drained.value,
		cohortGrantSha256: session.cohort.grantSha256,
		cohortWarmupEpochSha256: session.epochSha256,
		cohortWarmupEpochSignatureSha256: session.epochSignatureSha256,
		roleWarmupCompletionManifestSha256: MANIFEST_SHA,
		roleWarmupCompletionManifestSignatureSha256: MANIFEST_SIG_SHA,
	});
	return drained.value;
}

/** The rig-signed baseline, from the child's own `server-measure-start-ack/v1`. */
function _takeBaseline(session: LinuxSession): Sha256Hex {
	if (session.rigMeasureStartAckSha256 !== undefined) {
		return session.rigMeasureStartAckSha256;
	}
	const ack = session.authority.measureStartAck({ sequence: 2 });
	if (!ack.ok) throw new Error(`measure start ack: ${ack.code}`);
	const signed = session.rig.measureStartAck({
		ack: ack.value,
		measurementGrantSha256: MEASUREMENT_GRANT_SHA,
		macExecutionGrantReceiptSha256:
			session.cohort.grant.macExecutionGrantReceiptSha256,
		approvedPlanSha256: session.cohort.grant.approvedPlanSha256,
		approvalRecordSha256: session.cohort.grant.approvalRecordSha256,
		warmupCompletionSha256: MANIFEST_SHA,
	});
	session.measureStartAck = ack.value;
	session.rigMeasureStartAckSha256 = signed.sha256;
	return signed.sha256;
}

/** Mint, sign and present the barrier the Linux side is entitled to accept. */
function acceptBarrier(
	session: LinuxSession,
	overrides: Partial<CohortStartBarrierV1> = {},
	signWith?: Ed25519KeyPairBytes,
): ProtocolResult<FanoutBarrierAcceptanceResult> {
	const rigDrained = session.rigDrained as RigSigned<RigWarmupDrainedReceiptV1>;
	const rigMeasureStartAckSha256 =
		session.rigMeasureStartAckSha256 ?? MEASURE_START_ACK_SHA;
	const barrier = linuxStartBarrier(
		session.cohort,
		{
			rigCohortAcceptanceSha256: session.rigAcceptance.sha256,
			rigWarmupDrainedReceiptSha256: rigDrained.sha256,
			rigMeasureStartAckSha256,
		},
		overrides,
	);
	const bytes = bytesOfCanonical(barrier);
	const signature = macSign(
		session.cohort,
		"cohort-start-barrier/v1",
		bytes,
		signWith,
	);
	const result = session.authority.acceptStartBarrier({
		barrier,
		signature,
		sequence: 3,
		nowMs: NOW_MS,
	});
	if (result.ok) {
		session.barrier = result.value;
		session.barrierRecord = barrier;
		session.rigBarrier = session.rig.barrierAcceptance({
			accepted: result.value,
			cohortGrantSha256: session.cohort.grantSha256,
			cohortStartBarrierSignature: signature,
			rigMeasureStartAckSha256,
		});
	}
	return result;
}

/** One measured frame from `publisher` in `windowIndex`. */
function measuredFrame(
	session: LinuxSession,
	publisherId: string,
	publisherSequence: number,
	windowIndex: number,
): FanoutWireV1 {
	return {
		schema: "fanout-wire/v1",
		kind: "data",
		direction: "publisher-to-relay",
		cohortGrantSha256: session.cohort.grantSha256,
		cohortStartBarrierSha256: (session.barrier as FanoutBarrierAcceptanceResult)
			.frame.cohortStartBarrierSha256,
		windowIndex,
		publisherId,
		publisherSequence,
		subscriberId: null,
		linuxAcceptedOrdinal: null,
		...payloadFor(`${publisherId}:measured:${publisherSequence}`),
		payloadBytes: MESSAGE_BYTES,
	};
}

describe("linux is the cohort authority", () => {
	test("linux_accepts_signed_grant_before_server_ready", () => {
		const cohort = buildLinuxCohort();
		const clock = createManualRelayClock();
		const authority = linuxAuthority(cohort, clock);

		// Nothing exists before the grant: not the relay, not a servable relay,
		// and not a path to readiness.
		expect(authority.stage).toBe("unbound");
		expect(authority.relay).toBeNull();
		const earlyReady = authority.startServer();
		expect(earlyReady.ok).toBe(false);
		expect(earlyReady.ok === false && earlyReady.code).toBe("COHORT_NOT_READY");
		const earlyServe = authority.relayForServe();
		expect(earlyServe.ok).toBe(false);

		// An unsigned grant is not a grant.
		const unsigned = authority.acceptCohortGrant({
			grant: cohort.grant,
			signature: null,
			nowMs: NOW_MS,
		});
		expect(unsigned.ok).toBe(false);
		expect(unsigned.ok === false && unsigned.code).toBe(
			"MAC_GRANT_SIGNATURE_INVALID",
		);

		// Nor is one signed by a key the rig never staged.
		const foreign = generateEd25519KeyPair();
		const foreignSig = signMacReceipt({
			privatePkcs8Der: foreign.privatePkcs8Der,
			publicRaw32: foreign.publicRaw32,
			signedSchema: "cohort-grant/v1",
			signedBytes: cohort.grantBytes,
		});
		const wrongKey = authority.acceptCohortGrant({
			grant: cohort.grant,
			signature: foreignSig,
			nowMs: NOW_MS,
		});
		expect(wrongKey.ok).toBe(false);
		expect(wrongKey.ok === false && wrongKey.code).toBe(
			"MAC_SIGNING_KEY_MISMATCH",
		);

		// A grant mutated after signing no longer matches the signed bytes.
		const mutated = authority.acceptCohortGrant({
			grant: { ...cohort.grant, cohortAttempt: 2 },
			signature: cohort.grantSignature,
			nowMs: NOW_MS,
		});
		expect(mutated.ok).toBe(false);
		expect(mutated.ok === false && mutated.code).toBe(
			"MAC_GRANT_SIGNATURE_INVALID",
		);

		// An expired grant is refused even though the signature is genuine.
		const expired = authority.acceptCohortGrant({
			grant: cohort.grant,
			signature: cohort.grantSignature,
			nowMs: cohort.grant.notAfterMs + 1,
		});
		expect(expired.ok).toBe(false);
		expect(expired.ok === false && expired.code).toBe("MAC_GRANT_EXPIRED");

		// Every refusal left the server unable to start.
		expect(authority.stage).toBe("unbound");
		expect(authority.startServer().ok).toBe(false);

		// The genuine grant is accepted, and what the child retains is the two
		// digests it recomputed from the bytes it verified -- no signature of
		// its own, because it holds no key.
		const accepted = authority.acceptCohortGrant({
			grant: cohort.grant,
			signature: cohort.grantSignature,
			nowMs: NOW_MS,
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error("unreachable");
		expect(authority.stage).toBe("grant-accepted");
		expect(accepted.value.cohortGrantSha256).toBe(cohort.grantSha256);
		expect(accepted.value.cohortGrantSignatureSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(cohort.grantSignature)),
		);
		expect(accepted.value.grant.roleTokenCommitmentRootSha256).toBe(
			cohort.tokens.roleTokenCommitmentRootSha256,
		);

		// The rig-signed acceptance is the rig supervisor's, over the digests
		// the child recomputed, and it verifies under the rig key.
		const rig = new ScriptedRigSupervisor(cohort.rig, createManualRelayClock());
		const rigAcceptance = rig.acceptCohort(accepted.value);
		expect(rigAcceptance.record.cohortGrantSha256).toBe(cohort.grantSha256);
		expect(rigAcceptance.record.roleTokenCommitmentRootSha256).toBe(
			cohort.tokens.roleTokenCommitmentRootSha256,
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: cohort.rig.publicRaw32,
				signedBytes: rigAcceptance.bytes,
				signature: rigAcceptance.signature,
			}).ok,
		).toBe(true);

		// One grant per cohort: a second, equally genuine, presentation is refused.
		expect(
			authority.acceptCohortGrant({
				grant: cohort.grant,
				signature: cohort.grantSignature,
				nowMs: NOW_MS,
			}).ok,
		).toBe(false);

		// Only now does a relay exist, and it is built from the signed grant.
		const started = authority.startServer();
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("unreachable");
		expect(authority.stage).toBe("server-ready");
		expect(started.value.config.roleTokenCommitmentRootSha256).toBe(
			cohort.tokens.roleTokenCommitmentRootSha256,
		);
		expect(started.value.config.cohortGrantSha256).toBe(cohort.grantSha256);
		expect(started.value.config.windowCount).toBe(WINDOW_COUNT);
		expect(authority.relayForServe().ok).toBe(true);
	});

	test("linux_refuses_a_grant_minted_for_the_other_transport", () => {
		const cohort = buildLinuxCohort({ transport: "wt" });
		const authority = linuxAuthority(cohort, createManualRelayClock(), {
			transport: "ws",
		});
		const result = authority.acceptCohortGrant({
			grant: cohort.grant,
			signature: cohort.grantSignature,
			nowMs: NOW_MS,
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.message).toContain("wt");
		expect(authority.relay).toBeNull();
	});

	test("linux_refuses_registration_for_a_token_outside_the_accepted_cohort", () => {
		const session = openLinuxSessionAtRegistration();
		const foreign = buildFanoutCohortFixture({
			cohortId: "some-other-cohort",
			publisherCount: PUBLISHER_COUNT,
			subscriberCount: LINUX_SUBSCRIBER_COUNT,
		});
		const roleId = fanoutRoleId("subscriber", 0);
		const sessionId = session.relay.openSession({
			trySend: () => "accepted",
			trySendDelivery: () => "accepted",
			close: () => {},
		});
		// A structurally perfect registration whose token opens another cohort's
		// root has nothing to open here.
		const refused = session.relay.handleInbound(sessionId, {
			schema: "fanout-wire/v1",
			kind: "register",
			cohortGrantSha256: session.cohort.grantSha256,
			transport: "ws",
			role: "subscriber",
			childId: foreign.childIdByRoleId.get(roleId) as string,
			roleId,
			workerIndex: foreign.workerIndexByRoleId.get(roleId) ?? null,
			tokenBase64: foreign.tokenBase64ByRoleId.get(roleId) as Base64,
			tokenSha256: foreign.tokenSha256ByRoleId.get(roleId) as Sha256Hex,
			tokenCommitmentIndex: foreign.commitmentIndexByRoleId.get(
				roleId,
			) as number,
			tokenMerkleProofSha256: [
				...(foreign.proofByRoleId.get(roleId) as readonly Sha256Hex[]),
			],
		});
		expect(refused.ok).toBe(false);

		// And a genuine token presented for a shard it does not belong to is
		// refused on the shard, not on the signature.
		const wrongShardRoleId = fanoutRoleId("subscriber", 1);
		const wrongShardSession = session.relay.openSession({
			trySend: () => "accepted",
			trySendDelivery: () => "accepted",
			close: () => {},
		});
		const wrongShard = session.relay.handleInbound(wrongShardSession, {
			schema: "fanout-wire/v1",
			kind: "register",
			cohortGrantSha256: session.cohort.grantSha256,
			transport: "ws",
			role: "subscriber",
			childId: session.cohort.tokens.childIdByRoleId.get(
				wrongShardRoleId,
			) as string,
			roleId: wrongShardRoleId,
			workerIndex: 0,
			tokenBase64: session.cohort.tokens.tokenBase64ByRoleId.get(
				wrongShardRoleId,
			) as Base64,
			tokenSha256: session.cohort.tokens.tokenSha256ByRoleId.get(
				wrongShardRoleId,
			) as Sha256Hex,
			tokenCommitmentIndex: session.cohort.tokens.commitmentIndexByRoleId.get(
				wrongShardRoleId,
			) as number,
			tokenMerkleProofSha256: [
				...(session.cohort.tokens.proofByRoleId.get(
					wrongShardRoleId,
				) as readonly Sha256Hex[]),
			],
		});
		expect(wrongShard.ok).toBe(false);
	});

	test("warmup_wire_completes_and_resets_before_baseline", () => {
		const session = openLinuxSessionAtRegistration();

		// Registration cannot close, and therefore warmup cannot open, while the
		// signed epoch is unbound.
		const early = session.relay.closeRegistration();
		expect(early.ok).toBe(false);
		expect(early.ok === false && early.code).toBe("WARMUP_PROTOCOL");

		const epoch = warmupEpochFor(session.cohort);

		// An unsigned epoch, an epoch signed under the wrong schema, and an epoch
		// bound to another grant are all refused before the phase moves.
		expect(
			session.authority.acceptWarmupEpoch({
				epoch: epoch.epoch,
				signature: null,
				nowMs: NOW_MS,
			}).ok,
		).toBe(false);
		expect(
			session.authority.acceptWarmupEpoch({
				epoch: epoch.epoch,
				signature: macSign(session.cohort, "cohort-grant/v1", epoch.bytes),
				nowMs: NOW_MS,
			}).ok,
		).toBe(false);
		const otherGrantEpoch = warmupEpochFor(session.cohort, {
			cohortGrantSha256: HEX("9"),
		});
		expect(
			session.authority.acceptWarmupEpoch({
				epoch: otherGrantEpoch.epoch,
				signature: macSign(
					session.cohort,
					"cohort-warmup-epoch/v1",
					otherGrantEpoch.bytes,
				),
				nowMs: NOW_MS,
			}).ok,
		).toBe(false);
		expect(session.relay.phase).toBe("registration");
		expect(session.authority.stage).toBe("roles-registered");

		// The genuine epoch opens warmup and nothing else does.
		const opened = session.authority.acceptWarmupEpoch({
			epoch: epoch.epoch,
			signature: macSign(session.cohort, "cohort-warmup-epoch/v1", epoch.bytes),
			nowMs: NOW_MS,
		});
		expect(opened.ok).toBe(true);
		expect(session.relay.phase).toBe("warmup");

		const live: LinuxSession = {
			...session,
			epochSha256: epoch.sha256,
			epochSignatureSha256: sha256HexOfBytes(
				bytesOfCanonical(
					macSign(session.cohort, "cohort-warmup-epoch/v1", epoch.bytes),
				),
			),
			warmupNonce: epoch.epoch.warmupNonce,
		};
		const drained = runWarmupAndDrain(live);

		// The drained frame states the non-vacuous expanded equation §4.1 requires.
		expect(drained.frame.warmupIngress).toBe(PUBLISHER_COUNT * WARMUP_MESSAGES);
		expect(drained.frame.warmupDeliveries).toBe(
			PUBLISHER_COUNT * WARMUP_MESSAGES * LINUX_SUBSCRIBER_COUNT,
		);
		expect(drained.frame.warmupDeliveries).toBe(
			drained.frame.warmupIngress * LINUX_SUBSCRIBER_COUNT,
		);
		expect(drained.frame.publisherWarmupEndCount).toBe(PUBLISHER_COUNT);
		expect(drained.frame.subscriberWarmupEndCount).toBe(LINUX_SUBSCRIBER_COUNT);
		expect(drained.frame.warmupQueuesEmpty).toBe(true);
		expect(drained.frame.measuredCountersZero).toBe(true);

		// The measured counters really are back to zero, not merely declared so.
		const counters = session.relay.counters();
		expect(counters.acceptedIngressByOriginWindow.every((v) => v === 0)).toBe(
			true,
		);
		expect(
			counters.relayWritesCompletedByOriginWindow.every((v) => v === 0),
		).toBe(true);
		expect(counters.queueItemsPeak).toBe(0);

		// The rig receipt covers this exact server frame -- the bytes the child
		// sent, not a re-canonicalisation of them -- and verifies under the rig
		// key. The child produced neither the receipt nor its signature.
		const rigDrained = live.rigDrained as RigSigned<RigWarmupDrainedReceiptV1>;
		expect(rigDrained.record.serverWarmupDrainedSha256).toBe(
			drained.frameSha256,
		);
		expect(drained.frameSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(drained.frame)),
		);
		expect(rigDrained.record.roleWarmupCompletionManifestSha256).toBe(
			MANIFEST_SHA,
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: session.cohort.rig.publicRaw32,
				signedBytes: rigDrained.bytes,
				signature: rigDrained.signature,
			}).ok,
		).toBe(true);
	});

	test("linux_accepts_signed_barrier_before_measured_traffic", () => {
		const session = openLinuxSession();
		runWarmupAndDrain(session);
		expect(session.relay.phase).toBe("warmup-drained");

		const rigDrained =
			session.rigDrained as RigSigned<RigWarmupDrainedReceiptV1>;
		const goodBarrier = linuxStartBarrier(session.cohort, {
			rigCohortAcceptanceSha256: session.rigAcceptance.sha256,
			rigWarmupDrainedReceiptSha256: rigDrained.sha256,
		});
		const goodBytes = bytesOfCanonical(goodBarrier);
		const barrierSha256 = sha256HexOfBytes(goodBytes);

		// Measured traffic before any barrier acceptance is refused outright.
		const premature = session.publishers[0]?.send({
			schema: "fanout-wire/v1",
			kind: "data",
			direction: "publisher-to-relay",
			cohortGrantSha256: session.cohort.grantSha256,
			cohortStartBarrierSha256: barrierSha256,
			windowIndex: 0,
			publisherId: fanoutRoleId("publisher", 0),
			publisherSequence: 0,
			subscriberId: null,
			linuxAcceptedOrdinal: null,
			...payloadFor("premature"),
			payloadBytes: MESSAGE_BYTES,
		}) as ProtocolResult<true>;
		expect(premature.ok).toBe(false);
		expect(
			session.relay
				.counters()
				.acceptedIngressByOriginWindow.every((v) => v === 0),
		).toBe(true);

		// An unsigned barrier does not arm the relay.
		const unsigned = session.authority.acceptStartBarrier({
			barrier: goodBarrier,
			signature: null,
			sequence: 3,
			nowMs: NOW_MS,
		});
		expect(unsigned.ok).toBe(false);
		expect(session.relay.phase).toBe("warmup-drained");

		// Nor does one signed by a key the rig never staged.
		const foreign = generateEd25519KeyPair();
		const foreignSigned = acceptBarrier(session, {}, foreign);
		expect(foreignSigned.ok).toBe(false);
		expect(session.relay.phase).toBe("warmup-drained");

		// A barrier whose retained-record bindings name records the *rig* is not
		// holding is the rig's refusal and not the child's, since the authority
		// ruling: `present_start_barrier` checks all four
		// (`crates/native/src/secure_fs.rs:16385-16412`) before the barrier ever
		// reaches the pipe, and the child holds none of the four. A child that
		// refused here would be refusing on digests a caller stated. Proven on a
		// throwaway session so this one stays unarmed.
		const elsewhere = openLinuxSession();
		runWarmupAndDrain(elsewhere);
		const wrongBinding = acceptBarrier(elsewhere, {
			rigWarmupDrainedReceiptSha256: HEX("a"),
		});
		expect(wrongBinding.ok).toBe(true);
		expect(elsewhere.relay.phase).toBe("measured");

		// Nor one bound to another cohort grant.
		const wrongGrant = acceptBarrier(session, {
			cohortGrantSha256: HEX("b"),
		});
		expect(wrongGrant.ok).toBe(false);
		expect(session.relay.phase).toBe("warmup-drained");

		// Every refusal left measured traffic illegal.
		expect(
			(
				session.publishers[0]?.send({
					schema: "fanout-wire/v1",
					kind: "data",
					direction: "publisher-to-relay",
					cohortGrantSha256: session.cohort.grantSha256,
					cohortStartBarrierSha256: barrierSha256,
					windowIndex: 0,
					publisherId: fanoutRoleId("publisher", 0),
					publisherSequence: 0,
					subscriberId: null,
					linuxAcceptedOrdinal: null,
					...payloadFor("still-premature"),
					payloadBytes: MESSAGE_BYTES,
				}) as ProtocolResult<true>
			).ok,
		).toBe(false);

		// The genuine barrier arms it, and says so in the exact server frame the
		// rig hashes into its acceptance.
		const accepted = acceptBarrier(session);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error("unreachable");
		expect(session.relay.phase).toBe("measured");
		expect(session.authority.stage).toBe("barrier-accepted");
		expect(accepted.value.frame.cohortStartBarrierSha256).toBe(barrierSha256);
		expect(accepted.value.frame.measuredTrafficAllowed).toBe(true);
		expect(accepted.value.frame.linuxClockId).toBe(LINUX_CLOCK_ID);
		expect(accepted.value.frameSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(accepted.value.frame)),
		);

		// The rig's acceptance binds the child's exact frame and verifies under
		// the rig key; the child signed nothing.
		const rigBarrier = session.rigBarrier as RigSigned<RigBarrierAcceptanceV1>;
		expect(rigBarrier.record.serverStartBarrierAcceptedSha256).toBe(
			accepted.value.frameSha256,
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: session.cohort.rig.publicRaw32,
				signedBytes: rigBarrier.bytes,
				signature: rigBarrier.signature,
			}).ok,
		).toBe(true);

		// And now the same frame that was refused four times is accepted.
		const measured = session.publishers[0]?.send(
			measuredFrame(session, fanoutRoleId("publisher", 0), 0, 0),
		) as ProtocolResult<true>;
		expect(measured.ok).toBe(true);
		expect(session.relay.counters().acceptedIngressByOriginWindow[0]).toBe(1);
	});

	test("linux_is_authority_for_registration_ingress_capacity_and_faults", () => {
		const session = openLinuxSession();
		runWarmupAndDrain(session);
		const armed = acceptBarrier(session);
		expect(armed.ok).toBe(true);

		// One publisher offers three frames in window 0; the other offers two.
		const offered = [3, 2];
		for (const [index, publisher] of session.publishers.entries()) {
			const count = offered[index] as number;
			for (let sequence = 0; sequence < count; sequence += 1) {
				const sent = publisher.send(
					measuredFrame(session, publisher.roleId, sequence, 0),
				);
				expect(sent.ok).toBe(true);
			}
			const ended = publisher.send({
				schema: "fanout-wire/v1",
				kind: "end",
				cohortGrantSha256: session.cohort.grantSha256,
				cohortStartBarrierSha256: (
					session.barrier as FanoutBarrierAcceptanceResult
				).frame.cohortStartBarrierSha256,
				role: "publisher",
				roleId: publisher.roleId,
				finalWindowIndex: 0,
				finalPublisherSequence: (offered[index] as number) - 1,
				reason: "publisher-complete",
			});
			expect(ended.ok).toBe(true);
		}
		session.relay.pump();
		const countersBeforeStop = session.relay.counters();
		expect(session.authority.stopMeasurement().ok).toBe(true);

		const observed = session.authority.observe();
		expect(observed.ok).toBe(true);
		if (!observed.ok) throw new Error("unreachable");
		const observation = observed.value.observation;

		// Registration: the observation names exactly the roles that registered.
		expect(observation.registeredPublisherCount).toBe(PUBLISHER_COUNT);
		expect(observation.registeredSubscriberCount).toBe(LINUX_SUBSCRIBER_COUNT);
		expect(observation.registeredPublisherIds).toEqual([
			fanoutRoleId("publisher", 0),
			fanoutRoleId("publisher", 1),
		]);

		// Ingress: window 0 carries what the publishers actually offered, and the
		// relay writes are that ingress expanded across every subscriber.
		const totalOffered = offered[0]! + offered[1]!;
		expect(observation.acceptedIngressByOriginWindow[0]).toBe(totalOffered);
		expect(observation.relayWritesCompletedByOriginWindow[0]).toBe(
			totalOffered * LINUX_SUBSCRIBER_COUNT,
		);
		expect(
			observation.acceptedIngressByOriginWindow.reduce((a, b) => a + b, 0),
		).toBe(totalOffered);

		// Capacity: sessions and peaks come from the relay's own bookkeeping.
		expect(observation.sessionsAccepted).toBe(
			PUBLISHER_COUNT + LINUX_SUBSCRIBER_COUNT,
		);
		expect(observation.sessionsActivePeak).toBe(
			countersBeforeStop.sessionsActivePeak,
		);
		expect(observation.publisherSessionsActivePeak).toBe(PUBLISHER_COUNT);
		expect(observation.subscriberSessionsActivePeak).toBe(
			LINUX_SUBSCRIBER_COUNT,
		);
		expect(observation.queueItemsPeak).toBe(countersBeforeStop.queueItemsPeak);

		// Faults: a clean cohort states zero in every fault window, and the
		// engine agrees it is promotable.
		for (const window of [
			observation.queueDropDeliveriesByOriginWindow,
			observation.writeTimeoutDeliveriesByOriginWindow,
			observation.disconnectUndeliveredByOriginWindow,
			observation.malformedIngressByOriginWindow,
			observation.duplicateIngressByOriginWindow,
			observation.reorderedIngressByOriginWindow,
		]) {
			expect(window).toHaveLength(WINDOW_COUNT);
			expect(window.every((value) => value === 0)).toBe(true);
		}
		expect(observed.value.faults).toHaveLength(0);

		// Identity: the cohort and barrier the observation names are the ones this
		// Linux side verified, and the server child is the one it started.
		expect(observation.cohortGrantSha256).toBe(session.cohort.grantSha256);
		expect(observation.cohortStartBarrierSha256).toBe(
			(session.barrier as FanoutBarrierAcceptanceResult).frame
				.cohortStartBarrierSha256,
		);
		expect(observation.roleTokenCommitmentRootSha256).toBe(
			session.cohort.tokens.roleTokenCommitmentRootSha256,
		);
		expect(observation.serverChildPid).toBe(SERVER_IDENTITY.serverChildPid);
		expect(observation.linuxClockId).toBe(LINUX_CLOCK_ID);
		expect(observation.allSessionsClosed).toBe(true);

		// The rig receipt covers this exact observation -- the bytes the child
		// emitted, which is why `observe` returns them.
		expect(observed.value.observationSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(observation)),
		);
		const rigObservation = session.rig.relayObservation({
			observation: observed.value,
			cohortGrantSha256: session.cohort.grantSha256,
			cohortStartBarrierSha256: observation.cohortStartBarrierSha256,
		});
		expect(rigObservation.record.linuxRelayObservationSha256).toBe(
			observed.value.observationSha256,
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: session.cohort.rig.publicRaw32,
				signedBytes: rigObservation.bytes,
				signature: rigObservation.signature,
			}).ok,
		).toBe(true);

		// Single authority: the observation is emitted once, so there is no second
		// record for a controller to prefer.
		const second = session.authority.observe();
		expect(second.ok).toBe(false);

		// The cohort fields a rig server-snapshot receipt must carry come from
		// the same verified state, so a snapshot cannot name a cohort or barrier
		// this Linux server never accepted.
		const binding = session.authority.snapshotBinding();
		expect(binding.ok).toBe(true);
		if (!binding.ok) throw new Error("unreachable");
		expect(binding.value).toEqual({
			cohortGrantSha256: session.cohort.grantSha256,
			cohortStartBarrierSha256: observation.cohortStartBarrierSha256,
			roleTokenCommitmentRootSha256:
				session.cohort.tokens.roleTokenCommitmentRootSha256,
		});
	});

	test("a_snapshot_cannot_be_bound_before_the_grant_and_barrier_are_accepted", () => {
		const session = openLinuxSession();
		expect(session.authority.snapshotBinding().ok).toBe(false);
		runWarmupAndDrain(session);
		// Warmup drained is still not enough: the barrier is what makes a
		// snapshot a measured-run snapshot.
		expect(session.authority.snapshotBinding().ok).toBe(false);
		expect(acceptBarrier(session).ok).toBe(true);
		expect(session.authority.snapshotBinding().ok).toBe(true);
	});

	test("the_two_server_child_frames_refuse_a_rewritten_or_vacuous_claim", () => {
		const session = openLinuxSession();
		const drained = runWarmupAndDrain(session);
		expect(acceptBarrier(session).ok).toBe(true);
		const accepted = (session.barrier as FanoutBarrierAcceptanceResult).frame;

		// The genuine frames round-trip.
		expect(parseChildServerWarmupDrained(drained.frame).ok).toBe(true);
		expect(parseChildServerStartBarrierAccepted(accepted).ok).toBe(true);

		// A warmup that moved nothing is not a warmup, but that is an
		// observation rule and not a codec rule: the §3.4 key set is what
		// `child-pipe-protocol.ts` owns, and a well-formed zero frame is a
		// well-formed frame. What refuses a vacuous cohort is the wire proof one
		// step earlier -- a cohort that offered nothing cannot prove itself
		// against the signed epoch, so it never reaches the drain at all.
		expect(
			parseChildServerWarmupDrained({
				...drained.frame,
				warmupIngress: 0,
				warmupDeliveries: 0,
			}).ok,
		).toBe(true);
		const vacuous = openLinuxSession();
		const provenNothing = vacuous.authority.runWarmupWire();
		expect(provenNothing.ok).toBe(false);
		expect(provenNothing.ok === false && provenNothing.code).toBe(
			"WARMUP_PROTOCOL",
		);
		const unprovenDrain = vacuous.authority.drainWarmup({
			sequence: 1,
			roleWarmupCompletionManifestSha256: MANIFEST_SHA,
		});
		expect(unprovenDrain.ok).toBe(false);
		expect(unprovenDrain.ok === false && unprovenDrain.message).toContain(
			"not proven against the signed epoch",
		);

		// Neither frame may carry a field the schema does not name, or drop one
		// it does -- that is how a rewritten claim gets smuggled past a digest.
		expect(
			parseChildServerWarmupDrained({
				...drained.frame,
				extra: 1,
			}).ok,
		).toBe(false);
		const { linuxClockId: _dropped, ...withoutClock } = accepted;
		expect(parseChildServerStartBarrierAccepted(withoutClock).ok).toBe(false);

		// The permission the frame grants is not negotiable.
		expect(
			parseChildServerStartBarrierAccepted({
				...accepted,
				measuredTrafficAllowed: false,
			}).ok,
		).toBe(false);
	});

	test("linux_observation_reports_the_faults_it_saw_and_takes_no_counts_from_a_caller", () => {
		const session = openLinuxSession();
		runWarmupAndDrain(session);
		expect(acceptBarrier(session).ok).toBe(true);

		// One subscriber stops taking bytes; its queue fills and the write
		// deadline passes. The relay books that against the origin window.
		session.subscribers[0]?.block();
		const publisher = session.publishers[0] as LinuxPeer;
		for (let sequence = 0; sequence < 5; sequence += 1) {
			publisher.send(measuredFrame(session, publisher.roleId, sequence, 0));
		}
		session.clock.advanceMs(RELAY_WRITE_DEADLINE_MS + 1);
		session.relay.pump();

		const faults = session.relay.promotionFaults();
		expect(faults.length).toBeGreaterThan(0);
		expect(session.relay.isPromotable()).toBe(false);

		const observed = session.authority.observe();
		expect(observed.ok).toBe(true);
		if (!observed.ok) throw new Error("unreachable");

		// The fault the relay saw is in the record, in the origin window it
		// belonged to -- there is no argument on `observe` through which a caller
		// could have stated otherwise.
		expect(
			observed.value.observation.writeTimeoutDeliveriesByOriginWindow[0],
		).toBeGreaterThan(0);
		expect(observed.value.faults.length).toBeGreaterThan(0);
		expect(
			observed.value.observation.relayWritesCompletedByOriginWindow[0],
		).toBeLessThan(5 * LINUX_SUBSCRIBER_COUNT);
	});

	test("no_socket_is_bound_for_a_cohort_the_linux_side_has_not_authorised", async () => {
		const cohort = buildLinuxCohort();
		const authority = linuxAuthority(cohort, createManualRelayClock());

		// Before the grant there is nothing to serve.
		const beforeGrant = await serveFanoutCohortRelay({ authority });
		expect(beforeGrant.ok).toBe(false);
		expect(beforeGrant.ok === false && beforeGrant.code).toBe(
			"COHORT_NOT_READY",
		);

		// After the grant but before readiness there is still nothing to serve:
		// binding the listener is the execution point, so the check lives there
		// too and not only on the transition that precedes it.
		expect(
			authority.acceptCohortGrant({
				grant: cohort.grant,
				signature: cohort.grantSignature,
				nowMs: NOW_MS,
			}).ok,
		).toBe(true);
		const beforeReady = await serveFanoutCohortRelay({ authority });
		expect(beforeReady.ok).toBe(false);

		// Once the server is ready under the verified grant, the peer binds on the
		// transport the grant named -- not one the caller chose.
		expect(authority.startServer().ok).toBe(true);
		const served = await serveFanoutCohortRelay({ authority, port: 0 });
		expect(served.ok).toBe(true);
		if (!served.ok) throw new Error("unreachable");
		expect(served.value.transport).toBe("ws");
		expect(served.value.port).toBeGreaterThan(0);
		await served.value.stop();
	});

	test("the_staged_launch_argv_parses_into_the_fanout_cohort_mode", () => {
		// The staged record is minted before any execution exists and then bound
		// by the Mac-signed execution receipt, so its argv cannot be adjusted at
		// run time. Parsing it by execution is the only way to know the server
		// child the campaign launches is the one the campaign meant.
		const argv = stagedServerLaunchArgv("wt", "fanout-cohort", "phase-b");
		expect([...argv]).toEqual([
			"server.ts",
			"--transport=wt",
			"--mode=fanout-cohort",
			"--stage-profile=phase-b",
			"--bind=10.99.0.2",
		]);
		const parsed = parseServerArgs(argv.slice(1));
		expect(parsed.transport).toBe("wt");
		expect(parsed.mode).toBe("fanout-cohort");

		// The joined form the record uses and the split form a human types are
		// the same flag. Before this, `--transport=wt` was an unknown argument.
		expect(parseServerArgs(["--transport", "ws"]).transport).toBe("ws");
		expect(parseServerArgs(["--transport=ws"]).transport).toBe("ws");

		// Phase A's argv is untouched and still means what it meant: no mode
		// flag, so the scenario decides, and chat-fanout is an echo peer.
		const phaseA = parseServerArgs(["--transport=wt"]);
		expect(phaseA.mode).toBe("echo");
		expect(parseServerArgs(["--scenario=bulk-one-way"]).mode).toBe(
			"bulk-source",
		);

		// A mode the server does not have is not a mode.
		expect(() => parseServerArgs(["--mode=relay"])).toThrow(/Invalid --mode/);
	});

	test("the_fanout_cohort_mode_refuses_a_server_whose_trust_inputs_are_absent", () => {
		const key = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
		const honest = {
			WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: key,
			WS_WT_COHORT_LINUX_CLOCK_ID: LINUX_CLOCK_ID,
			WS_WT_COHORT_RECEIPT_VALIDITY_MS: "60000",
			WS_WT_TLS_CERT_CONTENT:
				"-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
			WS_WT_TLS_KEY_CONTENT:
				"-----BEGIN PRIVATE KEY-----\nZml4dHVyZQ==\n-----END PRIVATE KEY-----\n",
			WS_WT_TLS_SERVER_NAME: "wt-compare.local",
		};
		const parsed = parseFanoutCohortServerEnvironment(honest);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("unreachable");
		expect(parsed.value.stagedMacPublicRaw32.byteLength).toBe(32);
		expect(parsed.value.receiptValidityMs).toBe(60_000);

		// Every input is required. A server that defaulted the Mac key would
		// accept a cohort grant nobody signed.
		for (const name of FANOUT_COHORT_SERVER_ENV_NAMES) {
			const without = { ...honest, [name]: undefined };
			const refused = parseFanoutCohortServerEnvironment(without);
			expect(refused.ok).toBe(false);
			expect(refused.ok === false && refused.code).toBe("COHORT_NOT_READY");
			expect(refused.ok === false && refused.message).toContain(name);
		}

		// A key of the wrong length is not an ed25519 public key.
		expect(
			parseFanoutCohortServerEnvironment({
				...honest,
				WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
					new Uint8Array(31),
				).toString("base64"),
			}).ok,
		).toBe(false);
		expect(
			parseFanoutCohortServerEnvironment({
				...honest,
				WS_WT_COHORT_RECEIPT_VALIDITY_MS: "0",
			}).ok,
		).toBe(false);
	});

	test("linux_admits_role_peers_only_under_the_global_ordinal_permits", () => {
		const cohort = buildLinuxCohort();
		const authority = linuxAuthority(cohort, createManualRelayClock());
		expect(
			authority.acceptCohortGrant({
				grant: cohort.grant,
				signature: cohort.grantSignature,
				nowMs: NOW_MS,
			}).ok,
		).toBe(true);

		// No peer may register before the server exists under the grant.
		const beforeReady = authority.registerRolePeers({ peers: [] });
		expect(beforeReady.ok).toBe(false);
		expect(beforeReady.ok === false && beforeReady.code).toBe(
			"COHORT_NOT_READY",
		);

		const started = authority.startServer();
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("unreachable");
		const relay = started.value;
		const transport = relay.config.transport;
		const admissionFor = (
			globalOrdinal: number,
			role: "publisher" | "subscriber",
			roleId: string,
		) => ({
			globalOrdinal,
			sink: loopbackPeerSink(transport).sink,
			register: registerFrameFor(
				cohort.tokens,
				cohort.grantSha256,
				transport,
				role,
				roleId,
			),
		});
		const honest = () => [
			...Array.from({ length: LINUX_SUBSCRIBER_COUNT }, (_u, index) =>
				admissionFor(index, "subscriber", fanoutRoleId("subscriber", index)),
			),
			...Array.from({ length: PUBLISHER_COUNT }, (_u, index) =>
				admissionFor(
					LINUX_SUBSCRIBER_COUNT + index,
					"publisher",
					fanoutRoleId("publisher", index),
				),
			),
		];

		// A cohort short of the grant's own session count is not this cohort.
		const short = authority.registerRolePeers({ peers: honest().slice(1) });
		expect(short.ok).toBe(false);
		expect(short.ok === false && short.code).toBe("COHORT_NOT_READY");

		// Publishers-first is the wrong ramp: the permit schedule releases every
		// subscriber ordinal before any publisher one, and the ordinals say so.
		const reversed = [...honest()].reverse();
		const outOfOrder = authority.registerRolePeers({ peers: reversed });
		expect(outOfOrder.ok).toBe(false);
		expect(outOfOrder.ok === false && outOfOrder.code).toBe("COHORT_NOT_READY");

		// One ordinal spent twice is one permit spent twice.
		const duplicated = honest();
		const replayed = [...duplicated.slice(0, -1), duplicated[0]!];
		const twice = authority.registerRolePeers({ peers: replayed });
		expect(twice.ok).toBe(false);

		// A role claiming an ordinal that belongs to another role is refused
		// before its token is ever offered to the relay.
		const crossed = honest();
		crossed[0] = admissionFor(0, "publisher", fanoutRoleId("publisher", 0));
		const wrongOwner = authority.registerRolePeers({ peers: crossed });
		expect(wrongOwner.ok).toBe(false);
		expect(wrongOwner.ok === false && wrongOwner.code).toBe("COHORT_NOT_READY");

		// An ordinal outside the accepted cohort's domain has no owner at all.
		const stranger = honest();
		stranger[stranger.length - 1] = {
			...admissionFor(
				LINUX_SUBSCRIBER_COUNT + PUBLISHER_COUNT,
				"publisher",
				fanoutRoleId("publisher", PUBLISHER_COUNT - 1),
			),
		};
		expect(authority.registerRolePeers({ peers: stranger }).ok).toBe(false);

		// Every refusal left the cohort unregistered.
		expect(authority.stage).toBe("server-ready");

		const admitted = authority.registerRolePeers({ peers: honest() });
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) throw new Error("unreachable");
		expect(admitted.value.registeredSubscriberCount).toBe(
			LINUX_SUBSCRIBER_COUNT,
		);
		expect(admitted.value.registeredPublisherCount).toBe(PUBLISHER_COUNT);
		expect(
			admitted.value.registered.map((entry) => entry.globalOrdinal),
		).toEqual(
			Array.from(
				{ length: LINUX_SUBSCRIBER_COUNT + PUBLISHER_COUNT },
				(_u, index) => index,
			),
		);
		expect(authority.stage).toBe("roles-registered");

		// One ramp per cohort.
		expect(authority.registerRolePeers({ peers: honest() }).ok).toBe(false);
	});

	test("linux_proves_the_warmup_wire_per_role_against_the_signed_epoch", () => {
		const uneven = openLinuxSession();
		// Two publishers whose offers sum to the epoch's exact expected ingress,
		// but which are not the ten paced frames each the epoch named.
		const offers = [5, 15];
		for (const [index, publisher] of uneven.publishers.entries()) {
			for (
				let sequence = 0;
				sequence < (offers[index] as number);
				sequence += 1
			) {
				publisher.send({
					schema: "fanout-wire/v1",
					kind: "warmup-data",
					direction: "publisher-to-relay",
					cohortGrantSha256: uneven.cohort.grantSha256,
					cohortWarmupEpochSha256: uneven.epochSha256,
					warmupNonce: uneven.warmupNonce,
					publisherId: publisher.roleId,
					publisherSequence: sequence,
					subscriberId: null,
					linuxAcceptedOrdinal: null,
					...payloadFor(`${publisher.roleId}:uneven:${sequence}`),
					payloadBytes: MESSAGE_BYTES,
				});
			}
			publisher.send({
				schema: "fanout-wire/v1",
				kind: "warmup-end",
				cohortGrantSha256: uneven.cohort.grantSha256,
				cohortWarmupEpochSha256: uneven.epochSha256,
				warmupNonce: uneven.warmupNonce,
				role: "publisher",
				roleId: publisher.roleId,
				finalPublisherSequence: (offers[index] as number) - 1,
				reason: "publisher-warmup-complete",
			});
		}
		// The totals are right; the per-publisher offers are not.
		expect(uneven.relay.counters().warmupIngress).toBe(
			expectedWarmupIngress(PUBLISHER_COUNT),
		);
		const unevenWire = uneven.authority.runWarmupWire();
		expect(unevenWire.ok).toBe(false);
		expect(unevenWire.ok === false && unevenWire.code).toBe("WARMUP_PROTOCOL");

		// And an unproven wire cannot be drained, because the drain is what
		// zeroes the counters the proof reads.
		const unproven = uneven.authority.drainWarmup({
			sequence: 1,
			roleWarmupCompletionManifestSha256: MANIFEST_SHA,
		});
		expect(unproven.ok).toBe(false);
		expect(unproven.ok === false && unproven.code).toBe("WARMUP_PROTOCOL");

		// The honest wire: ten paced frames per publisher, every subscriber
		// worker expanded to the whole ingress.
		const session = openLinuxSession();
		runWarmupAndDrain(session);
		expect(session.authority.warmupWireProven).toBe(true);
	});

	test("linux_warmup_wire_proves_each_subscriber_workers_own_expansion", () => {
		const session = openLinuxSession();
		// One subscriber refuses bytes, so the relay's bounded queue eventually
		// drops records for it while every other worker takes them all. The
		// global expansion equation is what notices; the per-worker proof is
		// what says which worker it was.
		session.subscribers[0]?.block();
		for (const publisher of session.publishers) {
			for (let sequence = 0; sequence < WARMUP_MESSAGES; sequence += 1) {
				publisher.send({
					schema: "fanout-wire/v1",
					kind: "warmup-data",
					direction: "publisher-to-relay",
					cohortGrantSha256: session.cohort.grantSha256,
					cohortWarmupEpochSha256: session.epochSha256,
					warmupNonce: session.warmupNonce,
					publisherId: publisher.roleId,
					publisherSequence: sequence,
					subscriberId: null,
					linuxAcceptedOrdinal: null,
					...payloadFor(`${publisher.roleId}:blocked:${sequence}`),
					payloadBytes: MESSAGE_BYTES,
				});
			}
			publisher.send({
				schema: "fanout-wire/v1",
				kind: "warmup-end",
				cohortGrantSha256: session.cohort.grantSha256,
				cohortWarmupEpochSha256: session.epochSha256,
				warmupNonce: session.warmupNonce,
				role: "publisher",
				roleId: publisher.roleId,
				finalPublisherSequence: WARMUP_MESSAGES - 1,
				reason: "publisher-warmup-complete",
			});
		}
		const proven = session.authority.runWarmupWire();
		expect(proven.ok).toBe(true);
		if (!proven.ok) throw new Error("unreachable");
		// Every publisher offered its exact ten, and the record names each
		// subscriber's own count rather than one total that hides the blocked
		// worker's backlog.
		for (const publisher of session.publishers) {
			expect(proven.value.offersByPublisherId.get(publisher.roleId)).toBe(
				WARMUP_MESSAGES,
			);
		}
		expect(proven.value.deliveriesBySubscriberId.size).toBe(
			LINUX_SUBSCRIBER_COUNT,
		);
		for (const subscriber of session.subscribers) {
			expect(proven.value.deliveriesBySubscriberId.get(subscriber.roleId)).toBe(
				proven.value.warmupIngress,
			);
		}
	});

	test("the_child_states_the_baseline_and_the_rig_binds_it_verbatim", () => {
		const session = openLinuxSession();

		// No baseline before the warmup is drained.
		expect(session.authority.measureStartAck({ sequence: 2 }).ok).toBe(false);
		runWarmupAndDrain(session);

		// The default authority has no loop observer, so it refuses to state a
		// baseline rather than inventing a zero one.
		const unsourced = session.authority.measureStartAck({ sequence: 2 });
		expect(unsourced.ok).toBe(false);
		expect(unsourced.ok === false && unsourced.code).toBe("COHORT_NOT_READY");

		// A fractional reading is refused here rather than at the rig's `as_u64`
		// (`crates/native/src/secure_fs.rs:12112-12117`), where nothing can say
		// which of the three busy fields was wrong.
		const fractional = openLinuxSession({
			authority: { linuxClockId: HEX("a"), loop: { busyMs: () => 17.5 } },
		});
		runWarmupAndDrain(fractional);
		const refused = fractional.authority.measureStartAck({ sequence: 2 });
		expect(refused.ok).toBe(false);
		expect(refused.ok === false && refused.code).toBe("COHORT_PROTOCOL");

		// An authority that can read its loop states the two numbers it read,
		// and signs nothing.
		const attested = openLinuxSession({
			authority: {
				// Production stamps a digest-shaped clock id; the ack requires one.
				linuxClockId: HEX("a"),
				loop: { busyMs: () => 17 },
			},
		});
		const drained = runWarmupAndDrain(attested);
		const ack = attested.authority.measureStartAck({ sequence: 2 });
		expect(ack.ok).toBe(true);
		if (!ack.ok) throw new Error("unreachable");
		expect(ack.value.frame.schema).toBe("server-measure-start-ack/v1");
		expect(ack.value.frame.baselineBusyMs).toBe(17);
		expect(ack.value.frame.linuxClockId).toBe(HEX("a"));
		expect(ack.value.frameSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(ack.value.frame)),
		);

		// One baseline per session: a second read would be a second number for
		// the same window.
		expect(attested.authority.measureStartAck({ sequence: 3 }).ok).toBe(false);

		// §1.3 row 2: the rig carries `baselineBusyMs` and `baselineAtLinuxNs`
		// verbatim into `rig-measure-start-ack/v1`, which is the record that
		// travels north -- and it is the rig's signature on it, not the child's.
		const rigAck = attested.rig.measureStartAck({
			ack: ack.value,
			measurementGrantSha256: MEASUREMENT_GRANT_SHA,
			macExecutionGrantReceiptSha256:
				attested.cohort.grant.macExecutionGrantReceiptSha256,
			approvedPlanSha256: attested.cohort.grant.approvedPlanSha256,
			approvalRecordSha256: attested.cohort.grant.approvalRecordSha256,
			warmupCompletionSha256: MANIFEST_SHA,
		});
		const record = parseStrictJsonBytes(rigAck.bytes);
		expect(record.ok).toBe(true);
		if (!record.ok) throw new Error("unreachable");
		const fields = record.value as { readonly [key: string]: unknown };
		expect(fields.schema).toBe("rig-measure-start-ack/v1");
		expect(fields.baselineBusyMs).toBe(ack.value.frame.baselineBusyMs);
		expect(fields.baselineAtLinuxNs).toBe(ack.value.frame.baselineAtLinuxNs);
		expect(fields.warmupCompletionSha256).toBe(MANIFEST_SHA);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: attested.cohort.rig.publicRaw32,
				signedBytes: rigAck.bytes,
				signature: rigAck.signature,
			}).ok,
		).toBe(true);

		// The barrier's `rigMeasureStartAckSha256` binding is checked by the rig
		// at `present_start_barrier` (`secure_fs.rs:16401-16404`), not by the
		// child, which holds no rig ack to compare against. What the child does
		// check is the Mac signature over the barrier's own bytes -- so a
		// barrier naming another baseline is accepted here and refused there.
		attested.rigMeasureStartAckSha256 = rigAck.sha256;
		const rigDrained =
			attested.rigDrained as RigSigned<RigWarmupDrainedReceiptV1>;
		expect(drained.frameSha256).toBe(
			rigDrained.record.serverWarmupDrainedSha256,
		);
		const armed = acceptBarrier(attested);
		expect(armed.ok).toBe(true);
		const rigBarrier = attested.rigBarrier as RigSigned<RigBarrierAcceptanceV1>;
		expect(rigBarrier.record.rigMeasureStartAckSha256).toBe(rigAck.sha256);
	});

	test("linux_measured_window_drains_to_the_deadline_before_it_observes", () => {
		// The measured window is not open until the barrier is accepted.
		const early = openLinuxSession();
		expect(early.authority.runMeasuredWindow().ok).toBe(false);
		runWarmupAndDrain(early);
		const beforeBarrier = early.authority.runMeasuredWindow();
		expect(beforeBarrier.ok).toBe(false);
		expect(beforeBarrier.ok === false && beforeBarrier.code).toBe(
			"COHORT_NOT_READY",
		);

		// A subscriber that never takes bytes leaves the bounded queue holding
		// records the drain cannot move; that is a refusal, not a wait.
		const stalled = openLinuxSession();
		runWarmupAndDrain(stalled);
		expect(acceptBarrier(stalled).ok).toBe(true);
		stalled.subscribers[0]?.block();
		const stalledPublisher = stalled.publishers[0] as LinuxPeer;
		for (let sequence = 0; sequence < 3; sequence += 1) {
			stalledPublisher.send(
				measuredFrame(stalled, stalledPublisher.roleId, sequence, 0),
			);
		}
		const stuck = stalled.authority.runMeasuredWindow();
		expect(stuck.ok).toBe(false);
		expect(stuck.ok === false && stuck.code).toBe("RELAY_DELIVERY");

		// The honest window: every offer is charged to the window its ingress was
		// accepted in, the drain empties the queues, and only then is there an
		// observation to make.
		const session = openLinuxSession();
		runWarmupAndDrain(session);
		expect(acceptBarrier(session).ok).toBe(true);
		const offered = 4;
		for (const publisher of session.publishers) {
			for (let sequence = 0; sequence < offered; sequence += 1) {
				expect(
					publisher.send(measuredFrame(session, publisher.roleId, sequence, 0))
						.ok,
				).toBe(true);
			}
		}
		const window = session.authority.runMeasuredWindow();
		expect(window.ok).toBe(true);
		if (!window.ok) throw new Error("unreachable");
		const total = offered * PUBLISHER_COUNT;
		expect(window.value.acceptedIngressTotal).toBe(total);
		expect(window.value.relayWritesCompletedTotal).toBe(
			total * LINUX_SUBSCRIBER_COUNT,
		);
		expect(window.value.postStopRelayWrites).toBe(0);
		expect(session.authority.stage).toBe("measurement-stopped");

		// The window closes once.
		expect(session.authority.runMeasuredWindow().ok).toBe(false);

		const observed = session.authority.observe();
		expect(observed.ok).toBe(true);
		if (!observed.ok) throw new Error("unreachable");
		expect(
			observed.value.observation.acceptedIngressByOriginWindow.reduce(
				(sum, value) => sum + value,
				0,
			),
		).toBe(total);
	});
});

describe("the server child observes and the rig receipts what it sent", () => {
	/** A session whose authority can read a loop and stamp a digest clock id. */
	function attestedSession(busy: () => number) {
		return openLinuxSession({
			authority: { linuxClockId: HEX("a"), loop: { busyMs: busy } },
		});
	}

	test("the_server_ready_frame_states_the_childs_own_identity", () => {
		const session = openLinuxSessionAtRegistration();
		// `registerRolePeers` has already moved the stage on, so the frame is
		// taken from a session held at server-ready instead.
		const fresh = openLinuxSession();
		expect(fresh.authority.stage).toBe("warmup-open");

		const bare = buildLinuxCohort();
		const clock = createManualRelayClock();
		const authority = linuxAuthority(bare, clock);
		// No frame before the socket exists.
		expect(
			authority.serverReady({ sequence: 0, listeningAddress: "127.0.0.1:1" })
				.ok,
		).toBe(false);
		const accepted = authority.acceptCohortGrant({
			grant: bare.grant,
			signature: bare.grantSignature,
			nowMs: NOW_MS,
		});
		expect(accepted.ok).toBe(true);
		expect(authority.startServer().ok).toBe(true);

		// A bound server states where it bound; it cannot decline to.
		expect(
			authority.serverReady({ sequence: 0, listeningAddress: "" }).ok,
		).toBe(false);
		const ready = authority.serverReady({
			sequence: 0,
			listeningAddress: "127.0.0.1:44443",
		});
		expect(ready.ok).toBe(true);
		if (!ready.ok) throw new Error("unreachable");
		expect(ready.value.frame.schema).toBe("server-ready/v1");
		expect(ready.value.frame.childPid).toBe(SERVER_IDENTITY.serverChildPid);
		expect(ready.value.frame.childPgid).toBe(SERVER_IDENTITY.serverChildPgid);
		expect(ready.value.frame.childInstanceNonce).toBe(
			SERVER_IDENTITY.serverChildInstanceNonce,
		);
		expect(ready.value.frame.cohortGrantSha256).toBe(bare.grantSha256);
		expect(ready.value.frameSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(ready.value.frame)),
		);
		expect(session.authority.stage).toBe("roles-registered");
	});

	test("the_capture_ack_carries_the_observation_and_the_snapshot_as_base64", () => {
		let busy = 40;
		const session = attestedSession(() => busy);
		runWarmupAndDrain(session);
		const baselineAck = session.authority.measureStartAck({ sequence: 2 });
		expect(baselineAck.ok).toBe(true);
		if (!baselineAck.ok) throw new Error("unreachable");
		expect(acceptBarrier(session).ok).toBe(true);

		const publisher = session.publishers[0] as LinuxPeer;
		for (let sequence = 0; sequence < 3; sequence += 1) {
			expect(
				publisher.send(measuredFrame(session, publisher.roleId, sequence, 0))
					.ok,
			).toBe(true);
		}
		session.relay.pump();
		expect(session.authority.stopMeasurement().ok).toBe(true);
		// Time and the loop both move while the window is open.
		session.clock.advanceMs(2_500);
		busy = 97;

		const capture = session.authority.captureAck({ sequence: 5 });
		expect(capture.ok).toBe(true);
		if (!capture.ok) throw new Error("unreachable");

		// §1.3's registry edit: the two records travel as base64 of the child's
		// exact canonical bytes, so the rig digests what it received.
		expect(capture.value.frame.schema).toBe("server-capture-ack/v1");
		expect(
			Buffer.from(capture.value.frame.snapshotFrameBase64, "base64"),
		).toEqual(Buffer.from(capture.value.snapshot.snapshotBytes));
		expect(
			Buffer.from(
				capture.value.frame.linuxRelayObservationBase64 as string,
				"base64",
			),
		).toEqual(Buffer.from(capture.value.observation.observationBytes));

		// The snapshot's identity fields come off the signed grant, its process
		// identity off the child, and its busy window is a difference of two
		// readings -- there is no argument on `captureAck` for any of them.
		const snapshot = capture.value.snapshot.snapshot;
		expect(snapshot.schema).toBe("server-loop-utilization/v1");
		expect(snapshot.cellId).toBe(session.cohort.grant.execution.cellId);
		expect(snapshot.scenarioHash).toBe(session.cohort.grant.scenarioHash);
		expect(snapshot.transport).toBe(session.cohort.grant.transport);
		expect(snapshot.repetitionKind).toBe(
			session.cohort.grant.execution.repetitionKind,
		);
		expect(snapshot.childPid).toBe(SERVER_IDENTITY.serverChildPid);
		expect(snapshot.baselineBusyMs).toBe(40);
		expect(snapshot.finalBusyMs).toBe(97);
		expect(snapshot.busyMs).toBe(57);
		expect(snapshot.baselineAtLinuxNs).toBe(
			baselineAck.value.frame.baselineAtLinuxNs,
		);
		expect(snapshot.windowMs).toBeGreaterThan(0);
		expect(snapshot.allMeasuredSessionsClosed).toBe(true);
		// A fanout cohort runs no bulk source; the absence is stated, and the
		// rig requires the key to be present (`secure_fs.rs:16783-16785`).
		expect(snapshot.bulkSourceCompletion).toBeNull();
		expect(Object.hasOwn(snapshot, "bulkSourceCompletion")).toBe(true);

		// Both records are emitted exactly once.
		expect(session.authority.captureAck({ sequence: 6 }).ok).toBe(false);
		expect(session.authority.observe().ok).toBe(false);
		expect(session.authority.loopUtilizationSnapshot().ok).toBe(false);
	});

	test("a_snapshot_refuses_a_loop_that_went_backwards_or_never_had_a_baseline", () => {
		// No baseline: nothing to subtract, so nothing is stated.
		const noBaseline = attestedSession(() => 10);
		runWarmupAndDrain(noBaseline);
		expect(acceptBarrier(noBaseline).ok).toBe(true);
		expect(noBaseline.authority.stopMeasurement().ok).toBe(true);
		const capture = noBaseline.authority.captureAck({ sequence: 5 });
		expect(capture.ok).toBe(false);
		expect(capture.ok === false && capture.code).toBe("COHORT_NOT_READY");

		// A loop that went backwards is a broken reading, not a negative window.
		let busy = 100;
		const backwards = attestedSession(() => busy);
		runWarmupAndDrain(backwards);
		expect(backwards.authority.measureStartAck({ sequence: 2 }).ok).toBe(true);
		expect(acceptBarrier(backwards).ok).toBe(true);
		expect(backwards.authority.stopMeasurement().ok).toBe(true);
		backwards.clock.advanceMs(1_000);
		busy = 99;
		const refused = backwards.authority.captureAck({ sequence: 5 });
		expect(refused.ok).toBe(false);
		expect(refused.ok === false && refused.code).toBe("COHORT_PROTOCOL");
	});
});

// ---------------------------------------------------------------------------
// The Mac side owns the cohort (B3)
//
// The two blocks above prove what a role child accepts and what the Linux relay
// will do without a signature. This one proves the third claim the plan makes:
// that the Mac supervisor -- not the controller -- owns the topology, the
// tokens, the connection ramp, the child lifetimes, and the evidence bundle,
// and that a controller which lies about any of those is refused rather than
// believed.
//
// The cohort here is the ticker shape scaled to one subscriber per shard: it is
// the smallest cohort that still exercises all eight workers, one publisher,
// and a full grant-to-export lifecycle against the real relay.
// ---------------------------------------------------------------------------

const MAC_COHORT_ID = "cohort-b3-mac";
const MAC_CLOCK_ID = "mac-clock-b3-owner";
const MAC_SUBSCRIBER_COUNT = COHORT_WORKER_COUNT;
const MAC_PUBLISHER_COUNT = MAC_FANOUT_PUBLISHER_COUNT.ticker;
const MAC_MEASURED_FRAMES = 3;
const MAC_NOW_MS = 1_500;
const MAC_VALIDITY_MS = 60_000;

const MAC_APPROVED_PLAN_SHA256 = HEX("e");
const MAC_APPROVAL_RECORD_SHA256 = HEX("f");
const MAC_INSTANCE_NONCE = HEX("7");
const MAC_RIG_EXECUTABLE_SHA256 = HEX("a");

/** A process table the test can inspect: who was spawned, killed, and reaped. */
interface FakeProcessTable {
	readonly spawns: MacFanoutSpawnRequestV1[];
	readonly signals: { pgid: number; signal: MacFanoutSignal }[];
	readonly reaped: number[];
	readonly control: MacFanoutProcessControl;
	readonly spawner: MacFanoutChildSpawner;
}

function fakeProcessTable(
	options: { readonly survivesSigterm?: boolean } = {},
): FakeProcessTable {
	const spawns: MacFanoutSpawnRequestV1[] = [];
	const signals: { pgid: number; signal: MacFanoutSignal }[] = [];
	const reaped: number[] = [];
	const alive = new Set<number>();
	let nextPid = 9_000;
	return {
		spawns,
		signals,
		reaped,
		control: {
			killPgid: (pgid, signal) => {
				signals.push({ pgid, signal });
				if (signal === "SIGKILL" || options.survivesSigterm !== true) {
					alive.delete(pgid);
				}
			},
			waitPgid: (pgid) => {
				if (alive.has(pgid)) return false;
				reaped.push(pgid);
				return true;
			},
		},
		spawner: (request) => {
			spawns.push(request);
			nextPid += 1;
			alive.add(nextPid);
			return { ok: true, value: { pid: nextPid, pgid: nextPid } };
		},
	};
}

/**
 * One Mac cohort under test: the supervisor, the scripted Mac *process* it
 * talks to over a real pipe pair, and the fixtures the test reads back.
 *
 * `macNowNs` is the scripted binary's clock. The harness moves it, because the
 * barrier's timestamps are the binary's and every partial the test builds has
 * to land inside the measured window the binary declared.
 */
interface MacCohortHarness {
	readonly supervisor: MacFanoutSupervisor;
	readonly channel: MacCohortChannel;
	readonly binary: ScriptedMacCohortBinary;
	readonly wire: MacWire;
	readonly macKeys: Ed25519KeyPairBytes;
	readonly rigKeys: Ed25519KeyPairBytes;
	readonly processes: FakeProcessTable;
	readonly runtimeDir: string;
	readonly executionSha256: Sha256Hex;
	readonly opened: MacExecutionOpenedV1;
	readonly workloadBytes: Uint8Array;
	macNowNs: NsString;
	tokensByAttempt: Map<number, FanoutCohortFixture>;
	manifestByAttempt: Map<number, TokenCommitmentLeafManifestV1>;
}

/** The draft every cohort in this block is opened under. */
function macExecutionDraft(
	workloadBytes: Uint8Array,
	transport: "ws" | "wt" = "ws",
): CrossSupervisorExecutionDraftV1 {
	return {
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: HEX("a"),
		campaignLockSha256: HEX("b"),
		stagedCapabilitySha256: HEX("c"),
		sourceArchiveSha256: HEX("d"),
		approvedPlanSha256: MAC_APPROVED_PLAN_SHA256,
		approvalRecordSha256: MAC_APPROVAL_RECORD_SHA256,
		candidate: "cand",
		campaignId: "camp",
		runId: `camp/ticker-fanout-250/${transport}/measured-1`,
		executionPurpose: "focused",
		cellId: "ticker-fanout/rate-250",
		scenarioHash: HEX("5"),
		rolePlanHash: HEX("6"),
		workloadRolePlanInputSha256: sha256HexOfBytes(workloadBytes),
		stagedServerLaunchRecordSha256: sha256HexOfBytes(
			bytesOfCanonical(stagedLaunchRecord(transport)),
		),
		armKind: "primary",
		transport,
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		grantDeclaration: "fanout-expanded-deliveries",
		declaredMessageCount: 250_000,
		declaredMessageBytes: 100,
		requestedNotAfterMs: 17_000_000_000_000,
	};
}

interface MacHarnessOptions {
	readonly scenario?: MacFanoutScenario;
	readonly subscriberCount?: number;
	readonly survivesSigterm?: boolean;
	/** A dishonest binary: change one honest payload before it is written. */
	readonly mutate?: ScriptedMacBinaryOptions["mutate"];
	/** The staged key the *controller* verifies with; defaults to the binary's. */
	readonly stagedMacPublicRaw32?: Uint8Array;
	/**
	 * Drive the supervisor's three child seams from a real
	 * `MacFanoutRoleChildHost` instead of the fake process table, so a test can
	 * assert against the production channel map and its duplicate-spawn refusal.
	 */
	readonly childHost?: MacFanoutRoleChildHost;
}

/**
 * A supervisor over a scripted Mac process, with the Phase-A execution already
 * opened on the channel: the token minter builds a real fixture per attempt,
 * so a replacement produces genuinely different tokens rather than a relabelled
 * copy of the same tree.
 */
async function macHarness(
	options: MacHarnessOptions = {},
): Promise<MacCohortHarness> {
	const scenario = options.scenario ?? "ticker";
	const subscriberCount = options.subscriberCount ?? MAC_SUBSCRIBER_COUNT;
	const publisherCount = MAC_FANOUT_PUBLISHER_COUNT[scenario];
	const macKeys = generateEd25519KeyPair();
	const rigKeys = generateEd25519KeyPair();
	const processes = fakeProcessTable({
		survivesSigterm: options.survivesSigterm,
	});
	const workloadBytes = bytesOfCanonical({
		plan: "b3-mac-role-plan",
		cohortId: MAC_COHORT_ID,
	});
	const runtimeDir = mkdtempSync(join(tmpdir(), "b3-mac-"));
	const tokensByAttempt = new Map<number, FanoutCohortFixture>();
	const manifestByAttempt = new Map<number, TokenCommitmentLeafManifestV1>();
	const clockState = { nowNs: "1000000000" as NsString };
	const binary = new ScriptedMacCohortBinary({
		keys: macKeys,
		stagedRigPublicRaw32: rigKeys.publicRaw32,
		clock: { nowMs: () => 1_000, nowNs: () => clockState.nowNs },
		receiptValidityMs: MAC_VALIDITY_MS,
		macClockId: MAC_CLOCK_ID,
		instanceNonce: MAC_INSTANCE_NONCE,
		executableSha256: HEX("b"),
		grant: {
			transport: "ws",
			readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
			measuredDurationMs: 10_000,
			messageBytes: MESSAGE_BYTES,
			expectedOfferedIngress: MAC_MEASURED_FRAMES * publisherCount,
		},
		mutate: options.mutate,
	});
	const wire = serveScriptedMac(binary.respond);
	const channel = new MacCohortChannel({
		controllerToMac: wire.controllerToMac,
		macToController: wire.macToController,
		childDiagnostics: undefined,
		stagedMacPublicRaw32: options.stagedMacPublicRaw32 ?? macKeys.publicRaw32,
		deadlineMs: 5_000,
	});
	const opened = await channel.openExecution(
		bytesOfCanonical(macExecutionDraft(workloadBytes)),
	);
	if (!opened.ok) {
		throw new Error(`openExecution: ${opened.code} ${opened.message}`);
	}
	const executionSha256 = opened.value.executionSha256;

	const supervisor = new MacFanoutSupervisor({
		scenario,
		subscriberCount,
		executionSha256,
		channel,
		workloadRolePlanInputBytes: workloadBytes,
		scenarioHash: HEX("5"),
		rolePlanHash: HEX("6"),
		stagedRigPublicRaw32: rigKeys.publicRaw32,
		macClockId: MAC_CLOCK_ID,
		runtimeDir,
		mintCohort: ({ cohortAttempt, grantNonceSha256 }) => {
			// A fresh cohort ID per attempt is what makes the tokens fresh: the
			// fixture derives every token from it.
			const cohortId = `${MAC_COHORT_ID}#${cohortAttempt}:${grantNonceSha256.slice(0, 8)}`;
			const tokens = buildFanoutCohortFixture({
				cohortId,
				publisherCount,
				subscriberCount,
			});
			const leafManifest: TokenCommitmentLeafManifestV1 = {
				schema: "token-commitment-leaf-manifest/v1",
				executionSha256,
				cohortId,
				leafCount: tokens.leaves.length,
				leaves: [...tokens.leaves],
				roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
			};
			manifestByAttempt.set(cohortAttempt, leafManifest);
			tokensByAttempt.set(cohortAttempt, tokens);
			return {
				tokens,
				leafManifestBytes: bytesOfCanonical(leafManifest),
				publishers: tokens.publishers,
				subscriberShards: tokens.subscriberShards,
			};
		},
		spawnChild: options.childHost?.spawnChild ?? processes.spawner,
		processControl: options.childHost?.processControl ?? processes.control,
		...(options.childHost === undefined
			? {}
			: {
					retireChild: (childId: string) => {
						(options.childHost as MacFanoutRoleChildHost).retireChild(childId);
					},
				}),
		ledger: createMemoryReplayLedger(),
		stagedCapabilityNotAfterMs: 17_000_000_000_000,
		bunSha256: HEX("8"),
		entrypointSha256: HEX("9"),
	});
	return {
		supervisor,
		channel,
		binary,
		wire,
		macKeys,
		rigKeys,
		processes,
		runtimeDir,
		executionSha256,
		opened: opened.value,
		workloadBytes,
		get macNowNs() {
			return clockState.nowNs;
		},
		set macNowNs(value: NsString) {
			clockState.nowNs = value;
		},
		tokensByAttempt,
		manifestByAttempt,
	};
}

/** The bundle the supervisor seals for one planned child. */
function macBundleFor(
	harness: MacCohortHarness,
	plan: MacFanoutChildPlanV1,
): TokenBundleV1 {
	const tokens = harness.tokensByAttempt.get(
		harness.supervisor.cohortAttempt,
	) as FanoutCohortFixture;
	const entries = plan.assignedRoleIds.map((roleId) => ({
		schema: "token-bundle-entry/v1" as const,
		role: (plan.role === "publisher" ? "publisher" : "subscriber") as
			| "publisher"
			| "subscriber",
		roleId,
		workerIndex: tokens.workerIndexByRoleId.get(roleId) ?? null,
		tokenBase64: tokens.tokenBase64ByRoleId.get(roleId) as Base64,
		tokenSha256: tokens.tokenSha256ByRoleId.get(roleId) as Sha256Hex,
		tokenCommitmentIndex: tokens.commitmentIndexByRoleId.get(roleId) as number,
		tokenMerkleProofSha256: [
			...(tokens.proofByRoleId.get(roleId) as readonly Sha256Hex[]),
		],
	}));
	return {
		schema: "token-bundle/v1",
		executionSha256: harness.executionSha256,
		cohortGrantSha256: harness.supervisor.cohortGrantSha256 as Sha256Hex,
		childId: plan.childId,
		entryCount: entries.length,
		entries,
	};
}

/** Open the cohort and spawn every child, with real sealed FDs. */
async function macOpenAndSpawn(harness: MacCohortHarness): Promise<void> {
	const opened = await harness.supervisor.openCohort();
	if (!opened.ok)
		throw new Error(`openCohort: ${opened.code} ${opened.message}`);
	const spawned = harness.supervisor.spawnRoleChildren({
		bundleFor: (plan) => macBundleFor(harness, plan),
		spawnedAtMacNs: "1000000000",
	});
	if (!spawned.ok) throw new Error(`spawn: ${spawned.code} ${spawned.message}`);
}

function macReadyAll(harness: MacCohortHarness): void {
	for (const plan of harness.supervisor.topology.children) {
		if (
			harness.supervisor.spawnedChildren.some(
				(child) =>
					child.plan.childId === plan.childId && child.readyAtMacNs !== null,
			)
		) {
			continue;
		}
		const ready = harness.supervisor.markChildReady({
			childId: plan.childId,
			readyAtMacNs: "2000000000",
		});
		if (!ready.ok) throw new Error(`ready ${plan.childId}: ${ready.code}`);
	}
}

/** Decode one signed record the scripted binary returned on an ack. */
function macRecordOf<T>(recordBase64: string): {
	readonly record: T;
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
} {
	const bytes = new Uint8Array(Buffer.from(recordBase64, "base64"));
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) throw new Error("ack record is not canonical JSON");
	return { record: json.value as T, bytes, sha256: sha256HexOfBytes(bytes) };
}

interface MacLifecycle {
	readonly harness: MacCohortHarness;
	readonly authority: FanoutLinuxAuthority;
	readonly relay: FanoutRelay;
	readonly tokens: FanoutCohortFixture;
	readonly grant: CohortGrantV1;
	readonly grantSha256: Sha256Hex;
	readonly acceptance: FanoutCohortAcceptance;
	readonly rig: ScriptedRigSupervisor;
	readonly rigAcceptance: RigSigned<RigCohortAcceptanceV1>;
	readonly warmupEpoch: CohortWarmupEpochV1;
	readonly drained: FanoutWarmupDrainedResult;
	readonly rigDrained: RigSigned<RigWarmupDrainedReceiptV1>;
	readonly barrier: CohortStartBarrierV1;
	readonly barrierSha256: Sha256Hex;
	readonly barrierAcceptance: FanoutBarrierAcceptanceResult;
	readonly rigBarrier: RigSigned<RigBarrierAcceptanceV1>;
	readonly observation: FanoutRelayObservationResult;
	readonly rigObservation: RigSigned<RigRelayObservationReceiptV1>;
	readonly measureStartAckBytes: Uint8Array;
	readonly measureStartAckSignature: RigReceiptSignatureV1;
	readonly publisherPartials: readonly PublisherPartialV1[];
	readonly workerPartials: readonly WorkerPartialV1[];
	readonly phaseA: MacPhaseARigRecords;
}

/** The Phase-A rig records MAC_JOIN presents, rig-signed by the harness's rig. */
interface MacPhaseARigRecords {
	readonly rigExecutionAcceptanceBytes: Uint8Array;
	readonly rigExecutionAcceptanceSignatureBytes: Uint8Array;
	readonly snapshotFrameBytes: Uint8Array;
	readonly rigServerSnapshotReceiptBytes: Uint8Array;
	readonly rigServerSnapshotReceiptSignatureBytes: Uint8Array;
}

function macPhaseARigRecords(
	harness: MacCohortHarness,
	args: {
		readonly cohortGrantSha256: Sha256Hex;
		readonly barrierSha256: Sha256Hex;
	},
): MacPhaseARigRecords {
	const opened = harness.opened;
	const rigSign = (
		signedSchema: RigReceiptSignatureV1["signedSchema"],
		bytes: Uint8Array,
	): Uint8Array =>
		bytesOfCanonical(
			signRigReceipt({
				privatePkcs8Der: harness.rigKeys.privatePkcs8Der,
				publicRaw32: harness.rigKeys.publicRaw32,
				signedSchema,
				signedBytes: bytes,
			}),
		);
	const acceptanceBytes = bytesOfCanonical({
		schema: "rig-execution-acceptance/v1",
		executionSha256: harness.executionSha256,
		measurementGrantSha256: opened.measurementGrantSha256,
		macExecutionGrantReceiptSha256: sha256HexOfBytes(opened.receiptBytes),
		macReceiptSignatureSha256: sha256HexOfBytes(opened.receiptSignatureBytes),
		approvedPlanSha256: MAC_APPROVED_PLAN_SHA256,
		approvalRecordSha256: MAC_APPROVAL_RECORD_SHA256,
		rigExecutionIndex: 0,
		rigSupervisorInstanceNonce: HEX("b"),
		rigSupervisorExecutableSha256: MAC_RIG_EXECUTABLE_SHA256,
		replayLedgerLeafSha256: HEX("c"),
		signingPublicKeySha256: sha256HexOfBytes(harness.rigKeys.publicRaw32),
		receiptSequence: 0,
		acceptedAtMs: MAC_NOW_MS,
		issuedAtMs: MAC_NOW_MS,
		notAfterMs: MAC_NOW_MS + MAC_VALIDITY_MS,
	});
	const snapshotFrameBytes = bytesOfCanonical({
		schema: "server-loop-utilization/v1",
		executionSha256: harness.executionSha256,
		busyMs: 12,
		windowMs: 10_000,
	});
	const snapshotReceiptBytes = bytesOfCanonical({
		schema: "rig-server-snapshot-receipt/v1",
		executionSha256: harness.executionSha256,
		measurementGrantSha256: opened.measurementGrantSha256,
		macExecutionGrantReceiptSha256: sha256HexOfBytes(opened.receiptBytes),
		rigExecutionAcceptanceSha256: sha256HexOfBytes(acceptanceBytes),
		cohortGrantSha256: args.cohortGrantSha256,
		cohortStartBarrierSha256: args.barrierSha256,
		roleTokenCommitmentRootSha256: null,
		approvedPlanSha256: MAC_APPROVED_PLAN_SHA256,
		approvalRecordSha256: MAC_APPROVAL_RECORD_SHA256,
		rigExecutionIndex: 0,
		rigSupervisorInstanceNonce: HEX("b"),
		snapshotFrameSha256: sha256HexOfBytes(snapshotFrameBytes),
		snapshotFrameSize: snapshotFrameBytes.byteLength,
		childPid: SERVER_IDENTITY.serverChildPid,
		childPgid: SERVER_IDENTITY.serverChildPgid,
		childInstanceNonce: SERVER_IDENTITY.serverChildInstanceNonce,
		serverEntrypointSha256: HEX("2"),
		bunSha256: HEX("3"),
		addonSha256: HEX("4"),
		childResponseSequence: 5,
		captureRequestSequence: 5,
		signingPublicKeySha256: sha256HexOfBytes(harness.rigKeys.publicRaw32),
		receiptSequence: 9,
		frameReceivedAtRigNs: "15300000000",
		issuedAtMs: MAC_NOW_MS,
		notAfterMs: MAC_NOW_MS + MAC_VALIDITY_MS,
	});
	return {
		rigExecutionAcceptanceBytes: acceptanceBytes,
		rigExecutionAcceptanceSignatureBytes: rigSign(
			"rig-execution-acceptance/v1",
			acceptanceBytes,
		),
		snapshotFrameBytes,
		rigServerSnapshotReceiptBytes: snapshotReceiptBytes,
		rigServerSnapshotReceiptSignatureBytes: rigSign(
			"rig-server-snapshot-receipt/v1",
			snapshotReceiptBytes,
		),
	};
}

/**
 * Drive one cohort from grant to the point where MAC_JOIN can be presented,
 * against the real relay. Every number in the partials is derived from what
 * the relay actually did, so the conservation the supervisor recomputes is a
 * real reconciliation and not a fixture that agrees with itself. Every Mac
 * record on the way is minted by the scripted binary and taken off its ack.
 */
async function macDriveToExport(
	harness: MacCohortHarness,
): Promise<MacLifecycle> {
	const supervisor = harness.supervisor;
	const opened = await supervisor.openCohort();
	if (!opened.ok)
		throw new Error(`openCohort: ${opened.code} ${opened.message}`);
	const tokens = harness.tokensByAttempt.get(1) as FanoutCohortFixture;
	const grantSha256 = opened.value.grantSha256;

	const clock = createManualRelayClock();
	const authority = new FanoutLinuxAuthority({
		transport: "ws",
		executionSha256: harness.executionSha256,
		stagedMacPublicRaw32: harness.macKeys.publicRaw32,
		serverIdentity: SERVER_IDENTITY,
		linuxClockId: LINUX_CLOCK_ID,
		clock,
		receiptValidityMs: MAC_VALIDITY_MS,
		loop: { busyMs: () => 0 },
	});
	// The rig supervisor is the Linux signer; this stands in for the process
	// `crates/native/src/secure_fs.rs`'s `cohort::rig` runs (design §1.1).
	const rig = new ScriptedRigSupervisor(harness.rigKeys, clock, {
		receiptValidityMs: MAC_VALIDITY_MS,
	});
	const accepted = authority.acceptCohortGrant({
		grant: opened.value.grant,
		signature: opened.value.grantSignature,
		nowMs: MAC_NOW_MS,
	});
	if (!accepted.ok) throw new Error(`linux grant: ${accepted.code}`);
	const started = authority.startServer();
	if (!started.ok) throw new Error(`server ready: ${started.code}`);
	const relay = started.value;

	const spawned = supervisor.spawnRoleChildren({
		bundleFor: (plan) => macBundleFor(harness, plan),
		spawnedAtMacNs: "1000000000",
	});
	if (!spawned.ok) throw new Error(`spawn: ${spawned.code} ${spawned.message}`);

	const rigAcceptance = rig.acceptCohort(accepted.value, MAC_NOW_MS);
	const presented = await supervisor.presentRigCohortAcceptance({
		acceptance: rigAcceptance.record,
		signature: rigAcceptance.signature,
		nowMs: MAC_NOW_MS,
	});
	if (!presented.ok) throw new Error(`acceptance: ${presented.message}`);

	// Ramp: every session gets a permit from the one scheduler before it connects.
	const ramped = supervisor.beginRamp("3000000000");
	if (!ramped.ok) throw new Error(`ramp: ${ramped.code}`);
	macReadyAll(harness);

	const publisherIds = Array.from(
		{ length: MAC_PUBLISHER_COUNT },
		(_unused, index) => fanoutRoleId("publisher", index),
	);
	const { publishers } = registerRolePeersOn(
		authority,
		relay,
		tokens,
		grantSha256,
		{
			publisherCount: MAC_PUBLISHER_COUNT,
			subscriberCount: MAC_SUBSCRIBER_COUNT,
		},
	);

	// Warmup: the Mac process mints and signs the epoch, Linux opens on it,
	// publishers offer the exact ten paced frames, and the Mac retains one
	// completion frame per child.
	harness.macNowNs = "4000000000";
	const issuedEpoch = await supervisor.issueWarmupEpoch();
	if (!issuedEpoch.ok) throw new Error(`warmup epoch: ${issuedEpoch.message}`);
	const epochRecord = macRecordOf<CohortWarmupEpochV1>(
		issuedEpoch.value.cohortWarmupEpochBase64,
	);
	const epochSignature = macRecordOf<MacReceiptSignatureV1>(
		issuedEpoch.value.cohortWarmupEpochSignatureBase64,
	);
	const warmupEpoch = epochRecord.record;
	const epochSha256 = epochRecord.sha256;
	const openedWarmup = authority.acceptWarmupEpoch({
		epoch: warmupEpoch,
		signature: epochSignature.record,
		nowMs: MAC_NOW_MS,
	});
	if (!openedWarmup.ok) throw new Error(`linux warmup: ${openedWarmup.code}`);

	for (const publisher of publishers) {
		for (let sequence = 0; sequence < WARMUP_MESSAGES; sequence += 1) {
			const sent = publisher.send({
				schema: "fanout-wire/v1",
				kind: "warmup-data",
				direction: "publisher-to-relay",
				cohortGrantSha256: grantSha256,
				cohortWarmupEpochSha256: epochSha256,
				warmupNonce: warmupEpoch.warmupNonce,
				publisherId: publisher.roleId,
				publisherSequence: sequence,
				subscriberId: null,
				linuxAcceptedOrdinal: null,
				...payloadFor(`${publisher.roleId}:mac-warmup:${sequence}`),
				payloadBytes: MESSAGE_BYTES,
			});
			if (!sent.ok) throw new Error(`warmup data: ${sent.code}`);
		}
		const ended = publisher.send({
			schema: "fanout-wire/v1",
			kind: "warmup-end",
			cohortGrantSha256: grantSha256,
			cohortWarmupEpochSha256: epochSha256,
			warmupNonce: warmupEpoch.warmupNonce,
			role: "publisher",
			roleId: publisher.roleId,
			finalPublisherSequence: WARMUP_MESSAGES - 1,
			reason: "publisher-warmup-complete",
		});
		if (!ended.ok) throw new Error(`warmup end: ${ended.code}`);
	}

	const orderedChildren = supervisor.topology.children;
	for (const [order, plan] of orderedChildren.entries()) {
		const isPublisher = plan.role === "publisher";
		const frame: RoleWarmupCompleteV1 = {
			schema: "role-warmup-complete/v1",
			sequence: order,
			executionSha256: harness.executionSha256,
			cohortGrantSha256: grantSha256,
			cohortWarmupEpochSha256: epochSha256,
			warmupNonce: warmupEpoch.warmupNonce,
			childId: plan.childId,
			role: plan.role,
			startedAtMacNs: "4000000000",
			completedAtMacNs: "4500000000",
			offeredWarmupIngress: isPublisher ? WARMUP_MESSAGES : 0,
			deliveredWarmupRecords: isPublisher
				? 0
				: WARMUP_MESSAGES * MAC_PUBLISHER_COUNT * plan.assignedRoleIds.length,
		};
		const retained = supervisor.retainRoleWarmupComplete(
			bytesOfCanonical(frame),
		);
		if (!retained.ok) throw new Error(`warmup complete: ${retained.message}`);
	}
	const issuedManifest = await supervisor.issueRoleWarmupCompletionManifest();
	if (!issuedManifest.ok) {
		throw new Error(`warmup manifest: ${issuedManifest.message}`);
	}
	const provenWire = authority.runWarmupWire();
	if (!provenWire.ok) throw new Error(`warmup wire: ${provenWire.code}`);
	const drained = authority.drainWarmup({
		sequence: 1,
		roleWarmupCompletionManifestSha256:
			issuedManifest.value.roleWarmupCompletionManifestSha256,
	});
	if (!drained.ok) throw new Error(`drain: ${drained.code}`);
	const rigDrained = rig.warmupDrained({
		drained: drained.value,
		cohortGrantSha256: grantSha256,
		cohortWarmupEpochSha256: epochSha256,
		cohortWarmupEpochSignatureSha256: epochSignature.sha256,
		roleWarmupCompletionManifestSha256:
			issuedManifest.value.roleWarmupCompletionManifestSha256,
		roleWarmupCompletionManifestSignatureSha256:
			issuedManifest.value.roleWarmupCompletionManifestSignatureSha256,
		nowMs: MAC_NOW_MS,
	});
	const presentedDrain = supervisor.presentRigWarmupDrainedReceipt({
		serverWarmupDrainedBytes: drained.value.frameBytes,
		receipt: rigDrained.record,
		signature: rigDrained.signature,
		nowMs: MAC_NOW_MS,
	});
	if (!presentedDrain.ok)
		throw new Error(`drain receipt: ${presentedDrain.message}`);

	// The Linux baseline ack, rig-signed like every other Linux record.
	const measureStartAckBytes = bytesOfCanonical({
		schema: "rig-measure-start-ack/v1",
		executionSha256: harness.executionSha256,
		baselineAtLinuxNs: "4600000000",
		linuxClockId: LINUX_CLOCK_ID,
	});
	const measureStartAckSignature = signRigReceipt({
		privatePkcs8Der: harness.rigKeys.privatePkcs8Der,
		publicRaw32: harness.rigKeys.publicRaw32,
		signedSchema: "rig-measure-start-ack/v1",
		signedBytes: measureStartAckBytes,
	});
	const presentedAck = supervisor.presentRigMeasureStartAck({
		ackBytes: measureStartAckBytes,
		signature: measureStartAckSignature,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		nowMs: MAC_NOW_MS,
	});
	if (!presentedAck.ok) throw new Error(`measure ack: ${presentedAck.message}`);

	// The barrier is the binary's: minted at its clock, bound to the digests it
	// verified. The harness sets the clock so the measured window is known.
	harness.macNowNs = "5000000000";
	const issuedBarrier = await supervisor.issueStartBarrier();
	if (!issuedBarrier.ok) throw new Error(`barrier: ${issuedBarrier.message}`);
	const barrierRecord = macRecordOf<CohortStartBarrierV1>(
		issuedBarrier.value.cohortStartBarrierBase64,
	);
	const barrierSignature = macRecordOf<MacReceiptSignatureV1>(
		issuedBarrier.value.cohortStartBarrierSignatureBase64,
	);
	const barrier = barrierRecord.record;
	const barrierSha256 = issuedBarrier.value.cohortStartBarrierSha256;
	if (barrier.measureStartAtMacNs !== "5250000000") {
		throw new Error(`barrier window moved: ${barrier.measureStartAtMacNs}`);
	}
	const barrierAcceptance = authority.acceptStartBarrier({
		barrier,
		signature: barrierSignature.record,
		sequence: 3,
		nowMs: MAC_NOW_MS,
	});
	if (!barrierAcceptance.ok)
		throw new Error(`linux barrier: ${barrierAcceptance.code}`);
	const rigBarrier = rig.barrierAcceptance({
		accepted: barrierAcceptance.value,
		cohortGrantSha256: grantSha256,
		cohortStartBarrierSignature: barrierSignature.record,
		rigMeasureStartAckSha256: presentedAck.value.rigMeasureStartAckSha256,
		nowMs: MAC_NOW_MS,
	});
	const presentedBarrier = await supervisor.presentRigBarrierAcceptance({
		serverStartBarrierAcceptedBytes: barrierAcceptance.value.frameBytes,
		acceptance: rigBarrier.record,
		signature: rigBarrier.signature,
		nowMs: MAC_NOW_MS,
	});
	if (!presentedBarrier.ok)
		throw new Error(`barrier ack: ${presentedBarrier.message}`);

	// Measured traffic: every offer is accepted and fans out to all eight shards.
	for (const publisher of publishers) {
		for (let sequence = 0; sequence < MAC_MEASURED_FRAMES; sequence += 1) {
			const sent = publisher.send({
				schema: "fanout-wire/v1",
				kind: "data",
				direction: "publisher-to-relay",
				cohortGrantSha256: grantSha256,
				cohortStartBarrierSha256: barrierSha256,
				windowIndex: 0,
				publisherId: publisher.roleId,
				publisherSequence: sequence,
				subscriberId: null,
				linuxAcceptedOrdinal: null,
				...payloadFor(`${publisher.roleId}:mac-measured:${sequence}`),
				payloadBytes: MESSAGE_BYTES,
			});
			if (!sent.ok) throw new Error(`measured: ${sent.code}`);
		}
		const ended = publisher.send({
			schema: "fanout-wire/v1",
			kind: "end",
			cohortGrantSha256: grantSha256,
			cohortStartBarrierSha256: barrierSha256,
			role: "publisher",
			roleId: publisher.roleId,
			finalWindowIndex: 0,
			finalPublisherSequence: MAC_MEASURED_FRAMES - 1,
			reason: "publisher-complete",
		});
		if (!ended.ok) throw new Error(`publisher end: ${ended.code}`);
	}
	// Subscribers do not end the run; the relay drains to them, and `pump`
	// is what turns queued writes into completions before the stop.
	relay.pump();
	const stopped = authority.stopMeasurement();
	if (!stopped.ok) throw new Error(`stop: ${stopped.code}`);
	const observation = authority.observe();
	if (!observation.ok) throw new Error(`observe: ${observation.code}`);
	const linux = observation.value.observation;

	const rigObservation = rig.relayObservation({
		observation: observation.value,
		cohortGrantSha256: grantSha256,
		cohortStartBarrierSha256: barrierSha256,
		nowMs: MAC_NOW_MS,
	});
	const presentedObservation = supervisor.presentRigRelayObservation({
		observationBytes: observation.value.observationBytes,
		receipt: rigObservation.record,
		signature: rigObservation.signature,
		nowMs: MAC_NOW_MS,
	});
	if (!presentedObservation.ok) {
		throw new Error(`observation: ${presentedObservation.message}`);
	}

	// Partials, built from what the relay actually did.
	const children = new Map(
		supervisor.spawnedChildren.map((child) => [child.plan.childId, child]),
	);
	const zeros = () => Array.from({ length: WINDOW_COUNT }, () => 0);
	const publisherPartials = publisherIds.map((publisherId, index) => {
		const child = children.get(
			`publisher-child-${index}`,
		) as MacFanoutChildStateV1;
		const offered = zeros();
		const offeredBytes = zeros();
		const acks = zeros();
		offered[0] = MAC_MEASURED_FRAMES;
		offeredBytes[0] = MAC_MEASURED_FRAMES * MESSAGE_BYTES;
		acks[0] = linux.acceptedIngressByOriginWindow[0] as number;
		const partial: PublisherPartialV1 = {
			schema: "publisher-partial/v1",
			executionSha256: harness.executionSha256,
			cohortGrantSha256: grantSha256,
			cohortStartBarrierSha256: barrierSha256,
			childId: child.plan.childId,
			childPid: child.pid,
			childPgid: child.pgid,
			childInstanceNonce: child.instanceNonce,
			publisherId,
			tokenSha256: tokens.tokenSha256ByRoleId.get(publisherId) as Sha256Hex,
			macClockId: MAC_CLOCK_ID,
			windowCount: WINDOW_COUNT,
			offeredByOriginWindow: offered,
			offeredBytesByOriginWindow: offeredBytes,
			acceptedAckSeenByOriginWindow: acks,
			duplicateAckSeenByOriginWindow: zeros(),
			reorderedAckSeenByOriginWindow: zeros(),
			firstOfferAtMacNs: "5300000000",
			lastAckAtMacNs: "5400000000",
			exitCode: 0,
		};
		return partial;
	});
	const perWorkerDelivered = MAC_MEASURED_FRAMES * MAC_PUBLISHER_COUNT;
	const workerPartials = Array.from(
		{ length: COHORT_WORKER_COUNT },
		(_unused, workerIndex) => {
			const child = children.get(
				`subscriber-worker-${workerIndex}`,
			) as MacFanoutChildStateV1;
			const shardIds = child.plan.assignedRoleIds;
			const delivered = zeros();
			const deliveredBytes = zeros();
			delivered[0] = perWorkerDelivered * shardIds.length;
			deliveredBytes[0] = delivered[0] * MESSAGE_BYTES;
			const partial: WorkerPartialV1 = {
				schema: "worker-partial/v1",
				executionSha256: harness.executionSha256,
				cohortGrantSha256: grantSha256,
				cohortStartBarrierSha256: barrierSha256,
				childId: child.plan.childId,
				childPid: child.pid,
				childPgid: child.pgid,
				childInstanceNonce: child.instanceNonce,
				workerIndex,
				tokenBundleSha256: child.tokenBundleSha256,
				orderedSubscriberIdsSha256: sha256HexOfBytes(
					bytesOfCanonical([...shardIds]),
				),
				subscriberCount: shardIds.length,
				macClockId: MAC_CLOCK_ID,
				windowCount: WINDOW_COUNT,
				deliveredByOriginWindow: [...delivered],
				deliveredBytesByOriginWindow: [...deliveredBytes],
				deliveredByEventWindow: [...delivered],
				deliveredBytesByEventWindow: [...deliveredBytes],
				deliveredAfterMeasureStop: 0,
				deliveredBytesAfterMeasureStop: 0,
				perSubscriberDelivered: shardIds.map(() => perWorkerDelivered),
				duplicateCount: 0,
				reorderCount: 0,
				malformedCount: 0,
				disconnectCount: 0,
				firstDeliveryAtMacNs: "5350000000",
				lastDeliveryAtMacNs: "5450000000",
				exitCode: 0,
			};
			return partial;
		},
	);

	for (const plan of orderedChildren) {
		const stampsOk = supervisor.markChildLifecycle({
			childId: plan.childId,
			warmupCompleteAtMacNs: "4500000000",
			measureArmedAtMacNs: "5250000000",
			stoppedAtMacNs: "15250000000",
			exitCode: 0,
		});
		if (!stampsOk.ok) throw new Error(`stamps: ${stampsOk.message}`);
	}
	for (const [index, partial] of publisherPartials.entries()) {
		const bytes = bytesOfCanonical(partial);
		const acceptedPartial = supervisor.acceptRolePartial({
			childId: `publisher-child-${index}`,
			frame: {
				schema: "role-partial/v1",
				sequence: index,
				executionSha256: harness.executionSha256,
				childId: `publisher-child-${index}`,
				partialKind: "publisher",
				partialBase64: Buffer.from(bytes).toString("base64"),
				partialSha256: sha256HexOfBytes(bytes),
			},
		});
		if (!acceptedPartial.ok) {
			throw new Error(`publisher partial: ${acceptedPartial.message}`);
		}
	}
	for (const [index, partial] of workerPartials.entries()) {
		const bytes = bytesOfCanonical(partial);
		const acceptedPartial = supervisor.acceptRolePartial({
			childId: `subscriber-worker-${index}`,
			frame: {
				schema: "role-partial/v1",
				sequence: MAC_PUBLISHER_COUNT + index,
				executionSha256: harness.executionSha256,
				childId: `subscriber-worker-${index}`,
				partialKind: "worker",
				partialBase64: Buffer.from(bytes).toString("base64"),
				partialSha256: sha256HexOfBytes(bytes),
			},
		});
		if (!acceptedPartial.ok) {
			throw new Error(`worker partial: ${acceptedPartial.message}`);
		}
	}
	return {
		harness,
		authority,
		relay,
		tokens,
		grant: opened.value.grant,
		grantSha256,
		acceptance: accepted.value,
		rig,
		rigAcceptance,
		warmupEpoch,
		drained: drained.value,
		rigDrained,
		barrier,
		barrierSha256,
		barrierAcceptance: barrierAcceptance.value,
		rigBarrier,
		observation: observation.value,
		rigObservation,
		measureStartAckBytes,
		measureStartAckSignature,
		publisherPartials,
		workerPartials,
		phaseA: macPhaseARigRecords(harness, {
			cohortGrantSha256: grantSha256,
			barrierSha256,
		}),
	};
}

/** MAC_JOIN then the terminal export, through the production channel. */
async function macJoinAndExport(live: MacLifecycle) {
	const supervisor = live.harness.supervisor;
	const admitted = await supervisor.presentRigObservation(live.phaseA);
	if (!admitted.ok)
		throw new Error(`admission: ${admitted.code} ${admitted.message}`);
	const exported = await supervisor.exportCohortEvidence();
	if (!exported.ok)
		throw new Error(`export: ${exported.code} ${exported.message}`);
	return { admitted: admitted.value, exported: exported.value };
}

/** Wrap raw bytes the way every retained record in the export is wrapped. */
function retainedOf(bytes: Uint8Array) {
	return {
		schema: "retained-canonical-bytes/v1" as const,
		encoding: "base64" as const,
		mediaType: "application/json" as const,
		bytesBase64: Buffer.from(bytes).toString("base64") as Base64,
		byteLength: bytes.byteLength,
		sha256: sha256HexOfBytes(bytes),
	};
}

describe("the mac supervisor owns the cohort", () => {
	test("mac_supervisor_owns_exact_chat_10_plus_8", async () => {
		const harness = await macHarness({ scenario: "chat" });
		await macOpenAndSpawn(harness);
		const topology = harness.supervisor.topology;

		// Ten dedicated publisher processes plus eight subscriber workers.
		expect(topology.publisherCount).toBe(10);
		expect(topology.workerCount).toBe(8);
		expect(topology.expectedProcessCount).toBe(18);
		expect(topology.children.length).toBe(18);
		expect(topology.children.filter((c) => c.role === "publisher").length).toBe(
			10,
		);
		expect(
			topology.children.filter((c) => c.role === "subscriber-worker").length,
		).toBe(8);
		expect(harness.supervisor.spawnedChildren.length).toBe(18);
		expect(harness.processes.spawns.length).toBe(18);

		// Exactly those eighteen children, named once each.
		expect(topology.children.map((child) => child.childId)).toEqual([
			...Array.from({ length: 10 }, (_u, i) => `publisher-child-${i}`),
			...Array.from({ length: 8 }, (_u, i) => `subscriber-worker-${i}`),
		]);

		// Every child gets its own PID, PGID, instance nonce and token bundle.
		const children = harness.supervisor.spawnedChildren;
		expect(new Set(children.map((c) => c.pid)).size).toBe(18);
		expect(new Set(children.map((c) => c.pgid)).size).toBe(18);
		expect(new Set(children.map((c) => c.instanceNonce)).size).toBe(18);
		expect(new Set(children.map((c) => c.tokenBundleSha256)).size).toBe(18);

		// Direct control FDs plus the sealed token FD, and nothing else.
		for (const request of harness.processes.spawns) {
			expect(request.inheritedChildFds).toEqual([3, 4, 5]);
			expect(request.plan.controlReadFd).toBe(3);
			expect(request.plan.controlWriteFd).toBe(4);
			expect(request.plan.tokenBundleFd).toBe(5);
		}

		// One global ordinal domain: every session is owned by exactly one child.
		const sessions = 10 + MAC_SUBSCRIBER_COUNT;
		const owned = topology.children.flatMap((c) => c.assignedGlobalOrdinals);
		expect(owned.length).toBe(sessions);
		expect(new Set(owned).size).toBe(sessions);
		expect([...owned].sort((a, b) => a - b)).toEqual(
			Array.from({ length: sessions }, (_u, i) => i),
		);
		expect(topology.expectedSessionCount).toBe(sessions);
		// The subscriber run is sharded by ordinal mod 8, publishers follow it.
		for (const child of topology.children) {
			if (child.role !== "subscriber-worker") continue;
			for (const ordinal of child.assignedGlobalOrdinals) {
				expect(ordinal % 8).toBe(child.workerIndex as number);
			}
		}
		expect(harness.supervisor.teardown("PASS").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("mac_supervisor_owns_exact_ticker_1_plus_8", async () => {
		const harness = await macHarness({ scenario: "ticker" });
		await macOpenAndSpawn(harness);
		const topology = harness.supervisor.topology;

		expect(topology.publisherCount).toBe(1);
		expect(topology.workerCount).toBe(8);
		expect(topology.expectedProcessCount).toBe(9);
		expect(harness.supervisor.spawnedChildren.length).toBe(9);
		expect(topology.children.map((child) => child.childId)).toEqual([
			"publisher-child-0",
			...Array.from({ length: 8 }, (_u, i) => `subscriber-worker-${i}`),
		]);
		expect(topology.children[0]?.assignedRoleIds).toEqual(["publisher-000000"]);
		expect(topology.expectedSessionCount).toBe(1 + MAC_SUBSCRIBER_COUNT);

		// There is no eleventh publisher and no ninth worker to be had: the
		// scenario fixes the count, the caller cannot ask for another shape.
		expect(Object.keys(MAC_FANOUT_PUBLISHER_COUNT).sort()).toEqual([
			"chat",
			"ticker",
		]);
		const tooFewSubscribers = planMacFanoutTopology({
			scenario: "ticker",
			subscriberCount: 7,
		});
		expect(tooFewSubscribers.ok).toBe(false);

		expect(harness.supervisor.teardown("PASS").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("the_controller_obtains_its_grant_only_from_the_opened_ack", async () => {
		// Design §2.9(2g), runtime level. The retained grant is byte-identical
		// to what the binary returned on `mac-cohort-opened-ack/v1`, and nothing
		// the controller sent up the channel carried a grant: every request is
		// on the wire, and none of their carried records is a `cohort-grant/v1`.
		const harness = await macHarness();
		const opened = await harness.supervisor.openCohort();
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("unreachable");
		const ack = harness.binary.lastOpenedAck;
		expect(ack).not.toBeNull();
		if (ack === null) throw new Error("unreachable");
		expect(Buffer.from(opened.value.grantBytes).toString("base64")).toBe(
			ack.cohortGrantBase64,
		);
		expect(opened.value.grantSha256).toBe(ack.cohortGrantSha256);
		expect(harness.supervisor.cohortGrantSha256).toBe(opened.value.grantSha256);
		const carriedSchemas: string[] = [];
		for (const request of harness.wire.seen) {
			for (const [key, value] of Object.entries(request)) {
				if (!key.endsWith("Base64") || typeof value !== "string") continue;
				const json = parseStrictJsonBytes(
					new Uint8Array(Buffer.from(value, "base64")),
				);
				if (json.ok && typeof json.value === "object" && json.value !== null) {
					const schema = (json.value as { schema?: unknown }).schema;
					if (typeof schema === "string") carriedSchemas.push(schema);
				}
			}
		}
		expect(harness.wire.seen.length).toBe(2);
		expect(carriedSchemas).toContain("token-commitment-leaf-manifest/v1");
		expect(carriedSchemas).not.toContain("cohort-grant/v1");
		expect(harness.supervisor.teardown("PASS").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("a_grant_signed_by_another_key_than_the_staged_one_is_refused", async () => {
		// The honest sibling first: the staged key is the binary's, so the
		// opened grant verifies.
		const honest = await macHarness();
		expect((await honest.supervisor.openCohort()).ok).toBe(true);
		rmSync(honest.runtimeDir, { recursive: true, force: true });

		// The same binary, the same bytes, and a controller staged with some
		// other public key: the signature on the opened ack does not verify and
		// the cohort never opens. No key the controller holds can fix that.
		const foreign = generateEd25519KeyPair();
		await expect(
			macHarness({ stagedMacPublicRaw32: foreign.publicRaw32 }),
		).rejects.toThrow(/openExecution: MAC_SIGNING_KEY_MISMATCH/);
	});

	test("chat_10k_token_fd_fits_and_is_read_only_unlinked", () => {
		// The frozen worst case: one worker holding 1,250 of 10,000 subscribers
		// in a 10,010-leaf tree, so every entry carries fourteen siblings.
		const fixture = buildChat10kWorstCaseTokenBundleFixture();
		expect(fixture.leafCount).toBe(10_010);
		expect(fixture.bundle.entryCount).toBe(
			CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
		);
		for (const entry of fixture.bundle.entries) {
			expect(entry.tokenMerkleProofSha256.length).toBe(
				CHAT_10K_TOKEN_MERKLE_PROOF_LENGTH,
			);
		}
		// The size equation B1 froze, and the real bytes underneath it.
		const worstCase = tokenBundleWorstCaseBytes(
			CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
		);
		expect(worstCase.ok).toBe(true);
		expect(worstCase.ok && worstCase.value).toBe(
			CHAT_10K_TOKEN_BUNDLE_MAX_BYTES,
		);
		expect(TOKEN_BUNDLE_MAX_SIZE - CHAT_10K_TOKEN_BUNDLE_MAX_BYTES).toBe(
			CHAT_10K_TOKEN_BUNDLE_MARGIN_BYTES,
		);
		expect(fixture.canonicalBytes.byteLength).toBeLessThanOrEqual(
			CHAT_10K_TOKEN_BUNDLE_MAX_BYTES,
		);

		// And now the FD path itself, with real syscalls.
		const runtimeDir = mkdtempSync(join(tmpdir(), "b3-fd-"));
		const sealed = sealTokenBundleFd({ runtimeDir, bundle: fixture.bundle });
		expect(sealed.ok).toBe(true);
		if (!sealed.ok) throw new Error("unreachable");

		expect(sealed.value.byteSize).toBe(fixture.canonicalBytes.byteLength);
		expect(sealed.value.sha256).toBe(sha256HexOfBytes(fixture.canonicalBytes));
		expect(sealed.value.entryCount).toBe(
			CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
		);
		expect(sealed.value.observation.fd).toBe(5);
		expect(sealed.value.observation.fileKind).toBe("regular");
		expect(sealed.value.observation.accessMode).toBe("read-only");
		expect(sealed.value.observation.appendMode).toBe(false);

		// Unlinked: no name reaches these bytes, and the runtime directory is bare.
		expect(sealed.value.observation.hardLinkCount).toBe(0);
		expect(fstatSync(sealed.value.readFd).nlink).toBe(0);
		expect(readdirSync(runtimeDir)).toEqual([]);

		// Read-only: the descriptor the child inherits cannot mint a token.
		expect(() => writeSync(sealed.value.readFd, Uint8Array.of(0x41))).toThrow();

		// The bytes behind the descriptor are exactly the committed bundle.
		const readBack = new Uint8Array(sealed.value.byteSize);
		let read = 0;
		while (read < readBack.byteLength) {
			const chunk = readSync(
				sealed.value.readFd,
				readBack,
				read,
				readBack.byteLength - read,
				read,
			);
			if (chunk === 0) break;
			read += chunk;
		}
		expect(read).toBe(fixture.canonicalBytes.byteLength);
		expect(sha256HexOfBytes(readBack)).toBe(sealed.value.sha256);

		// The metadata contract a child applies at spawn and at read.
		expect(
			validateTokenBundleFdMetadata({
				atSpawn: sealed.value.observation,
				atRead: sealed.value.observation,
				expectedSha256: sealed.value.sha256,
				expectedSize: sealed.value.byteSize,
			}).ok,
		).toBe(true);
		// A writable or path-backed descriptor is refused by the same contract.
		expect(
			validateTokenBundleFdMetadata({
				atSpawn: { ...sealed.value.observation, accessMode: "read-write" },
				atRead: sealed.value.observation,
				expectedSha256: sealed.value.sha256,
				expectedSize: sealed.value.byteSize,
			}).ok,
		).toBe(false);
		expect(
			validateTokenBundleFdMetadata({
				atSpawn: { ...sealed.value.observation, hardLinkCount: 1 },
				atRead: { ...sealed.value.observation, hardLinkCount: 1 },
				expectedSha256: sealed.value.sha256,
				expectedSize: sealed.value.byteSize,
			}).ok,
		).toBe(false);
		// One byte over the cap never reaches a descriptor at all.
		expect(
			validateTokenBundleBytes(new Uint8Array(TOKEN_BUNDLE_MAX_SIZE + 1)).ok,
		).toBe(false);

		sealed.value.close();
		rmSync(runtimeDir, { recursive: true, force: true });
	});

	test("publisher_and_subscriber_global_ramp_is_500_per_second_and_200_total_in_flight", () => {
		// One domain over both roles, at the scale where the caps actually bind.
		const publisherCount = 10;
		const subscriberCount = 1_000;
		const total = publisherCount + subscriberCount;
		const rampEpochMacNs = "1000000000000" as NsString;
		const childIdForOrdinal = (ordinal: number): string | undefined => {
			const owner = resolveGlobalOrdinal({
				globalOrdinal: ordinal,
				publisherCount,
				subscriberCount,
			});
			if (!owner.ok) return undefined;
			return owner.value.role === "publisher"
				? `publisher-child-${ordinal - subscriberCount}`
				: `subscriber-worker-${owner.value.workerIndex}`;
		};
		const scheduler = new MacPermitScheduler({
			executionSha256: HEX("a"),
			cohortGrantSha256: HEX("b"),
			publisherCount,
			subscriberCount,
			rampEpochMacNs,
			readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
			childIdForOrdinal,
		});
		const requestFor = (ordinal: number) => {
			const owner = resolveGlobalOrdinal({
				globalOrdinal: ordinal,
				publisherCount,
				subscriberCount,
			});
			if (!owner.ok) throw new Error("ordinal");
			return {
				schema: "connect-permit-request/v1" as const,
				sequence: ordinal,
				executionSha256: HEX("a"),
				cohortGrantSha256: HEX("b"),
				childId: childIdForOrdinal(ordinal) as string,
				globalOrdinal: ordinal,
				roleId: owner.value.roleId,
			};
		};

		// Every child asks at once; the scheduler, not the children, paces them.
		for (let ordinal = total - 1; ordinal >= 0; ordinal -= 1) {
			const queued = scheduler.request(requestFor(ordinal));
			expect(queued.ok).toBe(true);
		}
		expect(scheduler.pendingCount).toBe(total);

		// Nothing is due before the ramp epoch.
		const early = scheduler.issueReady("999999999999");
		expect(early.ok && early.value.length).toBe(0);

		// An injectable clock compresses the ramp. The equation is B1's pure
		// permit math, asserted grant by grant rather than restated here.
		const issuedOrdinals: number[] = [];
		const outstanding: ConnectPermitGrantV1[] = [];
		let cursor = BigInt(rampEpochMacNs);
		const step = 300n * (1_000_000_000n / 500n);
		let peak = 0;
		for (let tick = 0; tick < 32; tick += 1) {
			const issued = scheduler.issueReady(cursor.toString());
			expect(issued.ok).toBe(true);
			if (!issued.ok) throw new Error("unreachable");
			for (const grant of issued.value) {
				const due = permitNotBeforeMacNs({
					rampEpochMacNs,
					globalOrdinal: grant.globalOrdinal,
				});
				expect(due.ok).toBe(true);
				expect(grant.notBeforeMacNs).toBe(due.ok ? due.value : "");
				issuedOrdinals.push(grant.globalOrdinal);
				outstanding.push(grant);
			}
			peak = Math.max(peak, scheduler.inFlight);
			expect(scheduler.inFlight).toBeLessThanOrEqual(
				COHORT_MAX_CONNECTIONS_IN_FLIGHT,
			);
			// The children connect and report back, spending their permits.
			while (outstanding.length > 0) {
				const grant = outstanding.shift() as ConnectPermitGrantV1;
				const completed = scheduler.complete({
					schema: "connect-permit-complete/v1",
					sequence: grant.sequence,
					executionSha256: HEX("a"),
					cohortGrantSha256: HEX("b"),
					childId: grant.childId,
					globalOrdinal: grant.globalOrdinal,
					permitNonce: grant.permitNonce,
					startedAtMacNs: grant.notBeforeMacNs,
					completedAtMacNs: cursor.toString(),
					outcome: "ready",
				});
				expect(completed.ok).toBe(true);
			}
			if (scheduler.grantedCount === total) break;
			cursor += step;
		}

		// Every ordinal, once, in ascending order, across both roles.
		expect(scheduler.grantedCount).toBe(total);
		expect(issuedOrdinals.length).toBe(total);
		expect(new Set(issuedOrdinals).size).toBe(total);
		expect(issuedOrdinals).toEqual([...issuedOrdinals].sort((a, b) => a - b));
		expect(issuedOrdinals[0]).toBe(0);
		expect(issuedOrdinals[total - 1]).toBe(total - 1);
		expect(childIdForOrdinal(0)).toBe("subscriber-worker-0");
		expect(childIdForOrdinal(total - 1)).toBe("publisher-child-9");

		// The total in-flight cap bound, and was never crossed: with 300 ordinals
		// due at once the scheduler stopped at exactly 200.
		expect(scheduler.inFlightPeak).toBe(COHORT_MAX_CONNECTIONS_IN_FLIGHT);
		expect(peak).toBe(COHORT_MAX_CONNECTIONS_IN_FLIGHT);
		expect(scheduler.completedCount).toBe(total);
		expect(scheduler.inFlight).toBe(0);

		// A fresh scheduler with nobody completing stops dead at exactly 200.
		const capped = new MacPermitScheduler({
			executionSha256: HEX("a"),
			cohortGrantSha256: HEX("b"),
			publisherCount,
			subscriberCount,
			rampEpochMacNs,
			readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
			childIdForOrdinal,
		});
		for (let ordinal = 0; ordinal < total; ordinal += 1) {
			expect(capped.request(requestFor(ordinal)).ok).toBe(true);
		}
		const far = (BigInt(rampEpochMacNs) + 1_000_000_000_000n).toString();
		const flood = capped.issueReady(far);
		expect(flood.ok && flood.value.length).toBe(
			COHORT_MAX_CONNECTIONS_IN_FLIGHT,
		);
		expect(capped.inFlight).toBe(COHORT_MAX_CONNECTIONS_IN_FLIGHT);
		expect(
			(capped.issueReady(far) as { ok: true; value: unknown[] }).value.length,
		).toBe(0);

		// A per-role counter cannot masquerade as global accounting: the wrong
		// owner, the wrong child, and a repeat of a spent ordinal are all refused.
		const wrongRole = capped.request({
			...requestFor(500),
			roleId: "publisher-000000",
		});
		expect(wrongRole.ok).toBe(false);
		const wrongChild = capped.request({
			...requestFor(999),
			childId: "subscriber-worker-1",
		});
		expect(wrongChild.ok).toBe(false);
		expect(capped.request(requestFor(0)).ok).toBe(false);
	});
});

describe("the controller is only a courier", () => {
	test("controller_cannot_invent_rewrite_or_cross_pair_any_rig_record", async () => {
		const harness = await macHarness();
		const live = await macDriveToExport(harness);
		const supervisor = harness.supervisor;

		// A second supervisor, driven identically, gives us genuine rig records
		// that belong to a *different* cohort -- the cross-pairing material.
		const other = await macHarness();
		const otherLive = await macDriveToExport(other);
		expect(otherLive.grantSha256).not.toBe(live.grantSha256);

		// 1. Invented. The controller signs a record with its own key.
		const forger = generateEd25519KeyPair();
		const inventedAcceptance = {
			...live.rigAcceptance.record,
			receiptSequence: live.rigAcceptance.record.receiptSequence + 1,
		};
		const invented = await supervisor.presentRigCohortAcceptance({
			acceptance: inventedAcceptance,
			signature: signRigReceipt({
				privatePkcs8Der: forger.privatePkcs8Der,
				publicRaw32: forger.publicRaw32,
				signedSchema: "rig-cohort-acceptance/v1",
				signedBytes: bytesOfCanonical(inventedAcceptance),
			}),
			nowMs: MAC_NOW_MS,
		});
		expect(invented.ok).toBe(false);
		expect(invented.ok === false && invented.code).toBe(
			"RIG_SIGNING_KEY_MISMATCH",
		);

		// 2. Unsigned. There is no path that takes a record on its own word.
		const unsigned = await supervisor.presentRigCohortAcceptance({
			acceptance: live.rigAcceptance.record,
			signature: null,
			nowMs: MAC_NOW_MS,
		});
		expect(unsigned.ok).toBe(false);

		// 3. Rewritten. One field changed after the rig signed the bytes.
		const rewritten = supervisor.presentRigRelayObservation({
			observationBytes: bytesOfCanonical({
				...live.observation.observation,
				acceptedIngressByOriginWindow:
					live.observation.observation.acceptedIngressByOriginWindow.map(
						(value, index) => (index === 0 ? value + 1_000 : value),
					),
			}),
			receipt: live.rigObservation.record,
			signature: live.rigObservation.signature,
			nowMs: MAC_NOW_MS,
		});
		expect(rewritten.ok).toBe(false);
		expect(rewritten.ok === false && rewritten.code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);

		// 4. Cross-paired by cohort. A genuine, rig-signed record from the other
		//    cohort, presented here unmodified.
		const crossCohort = await supervisor.presentRigBarrierAcceptance({
			serverStartBarrierAcceptedBytes: otherLive.barrierAcceptance.frameBytes,
			acceptance: otherLive.rigBarrier.record,
			signature: otherLive.rigBarrier.signature,
			nowMs: MAC_NOW_MS,
		});
		expect(crossCohort.ok).toBe(false);
		expect(crossCohort.ok === false && crossCohort.code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);

		// 5. Cross-paired within the cohort. This cohort's genuine relay receipt,
		//    handed the other cohort's genuine observation.
		const crossPaired = supervisor.presentRigRelayObservation({
			observationBytes: bytesOfCanonical(otherLive.observation.observation),
			receipt: live.rigObservation.record,
			signature: live.rigObservation.signature,
			nowMs: MAC_NOW_MS,
		});
		expect(crossPaired.ok).toBe(false);

		// 6. Cross-schema. A genuine signature moved onto another record type.
		const crossSchema = supervisor.presentRigWarmupDrainedReceipt({
			serverWarmupDrainedBytes: live.drained.frameBytes,
			receipt: live.rigDrained.record,
			signature: {
				...live.rigDrained.signature,
				signedSchema: "rig-barrier-acceptance/v1",
			},
			nowMs: MAC_NOW_MS,
		});
		expect(crossSchema.ok).toBe(false);

		// 7. Replayed. The same genuine record a second time.
		const replayed = supervisor.presentRigRelayObservation({
			observationBytes: bytesOfCanonical(live.observation.observation),
			receipt: live.rigObservation.record,
			signature: live.rigObservation.signature,
			nowMs: MAC_NOW_MS,
		});
		expect(replayed.ok).toBe(false);
		expect(replayed.ok === false && replayed.code).toBe("RIG_RECEIPT_REPLAYED");

		// 8. Expired. Held past the staged capability's lifetime.
		const expiredHarness = await macHarness();
		const expiredLive = await macDriveToExport(expiredHarness);
		const expired = await expiredHarness.supervisor.presentRigCohortAcceptance({
			acceptance: expiredLive.rigAcceptance.record,
			signature: expiredLive.rigAcceptance.signature,
			nowMs: 17_000_000_000_001,
		});
		expect(expired.ok).toBe(false);

		// None of the eight moved the supervisor, and nothing has been admitted:
		// the terminal export is not ready rather than a shorter graph.
		const early = await supervisor.exportCohortEvidence();
		expect(early.ok).toBe(false);
		expect(early.ok === false && early.code).toBe("COHORT_NOT_READY");

		for (const each of [harness, other, expiredHarness]) {
			expect(each.supervisor.teardown("FAIL").ok).toBe(true);
			rmSync(each.runtimeDir, { recursive: true, force: true });
		}
	});

	test("controller_cannot_inject_or_rewrite_partial_or_evidence_bundle", async () => {
		const harness = await macHarness();
		const live = await macDriveToExport(harness);
		const supervisor = harness.supervisor;

		// The cohort really does reconcile: publishers, relay and workers agree
		// on the same events counted in three places. That is what makes the
		// rejections below rejections of a path that otherwise works.
		const conservation = recomputeCohortOriginConservation({
			publisherPartials: live.publisherPartials,
			workerPartials: live.workerPartials,
			linuxRelayObservation: live.observation.observation,
			subscriberCount: MAC_SUBSCRIBER_COUNT,
			messageBytes: MESSAGE_BYTES,
		});
		expect(conservation.ok).toBe(true);
		if (!conservation.ok)
			throw new Error(`conservation: ${conservation.message}`);
		const ledger = recomputeCohortLedger({
			conservation: conservation.value,
			subscriberCount: MAC_SUBSCRIBER_COUNT,
			messageBytes: MESSAGE_BYTES,
		});
		expect(ledger.ok).toBe(true);
		if (!ledger.ok) throw new Error("unreachable");
		expect(ledger.value.offeredIngress).toBe(
			MAC_MEASURED_FRAMES * MAC_PUBLISHER_COUNT,
		);
		expect(ledger.value.delivered).toBe(
			MAC_MEASURED_FRAMES * MAC_PUBLISHER_COUNT * MAC_SUBSCRIBER_COUNT,
		);

		// A partial the controller states rather than the child that produced it:
		// right shape, right cohort, wrong channel.
		const stolen = bytesOfCanonical(live.workerPartials[1] as WorkerPartialV1);
		const wrongChannel = supervisor.acceptRolePartial({
			childId: "subscriber-worker-0",
			frame: {
				schema: "role-partial/v1",
				sequence: 99,
				executionSha256: harness.executionSha256,
				childId: "subscriber-worker-1",
				partialKind: "worker",
				partialBase64: Buffer.from(stolen).toString("base64"),
				partialSha256: sha256HexOfBytes(stolen),
			},
		});
		expect(wrongChannel.ok).toBe(false);

		// A second partial from a child that already delivered one.
		const duplicate = supervisor.acceptRolePartial({
			childId: "subscriber-worker-1",
			frame: {
				schema: "role-partial/v1",
				sequence: 100,
				executionSha256: harness.executionSha256,
				childId: "subscriber-worker-1",
				partialKind: "worker",
				partialBase64: Buffer.from(stolen).toString("base64"),
				partialSha256: sha256HexOfBytes(stolen),
			},
		});
		expect(duplicate.ok).toBe(false);

		// A partial whose declared digest is not the digest of its own bytes.
		const rewrittenHarness = await macHarness();
		const rewrittenLive = await macDriveToExport(rewrittenHarness);
		const worker = rewrittenLive.workerPartials[0] as WorkerPartialV1;
		const inflated = bytesOfCanonical({
			...worker,
			deliveredByOriginWindow: worker.deliveredByOriginWindow.map(
				(value, index) => (index === 0 ? value + 500 : value),
			),
		});
		const lyingDigest = rewrittenHarness.supervisor.acceptRolePartial({
			childId: "subscriber-worker-0",
			frame: {
				schema: "role-partial/v1",
				sequence: 101,
				executionSha256: rewrittenHarness.executionSha256,
				childId: "subscriber-worker-0",
				partialKind: "worker",
				partialBase64: Buffer.from(inflated).toString("base64"),
				partialSha256: sha256HexOfBytes(bytesOfCanonical(worker)),
			},
		});
		expect(lyingDigest.ok).toBe(false);

		// MAC_JOIN: the binary mints the admission receipt over the records this
		// supervisor presented and retained, and this side checks every digest
		// it binds is one it holds.
		const { admitted, exported } = await macJoinAndExport(live);
		const admission = supervisor.cohortAdmission;
		expect(admission).not.toBeNull();
		if (admission === null) throw new Error("unreachable");
		expect(admitted.cohortAdmission?.bytes).toEqual(
			new Uint8Array(
				Buffer.from(
					admitted.ack.cohortAdmissionReceiptBase64 as string,
					"base64",
				),
			),
		);
		expect(admission.receipt.offeredIngress).toBe(ledger.value.offeredIngress);
		expect(admission.receipt.delivered).toBe(ledger.value.delivered);
		expect(admission.receipt.signingPublicKeySha256).toBe(
			sha256HexOfBytes(harness.macKeys.publicRaw32),
		);

		// The honest export. The observation is reassembled here from retained
		// bytes, and the binary's signed size and digest are exactly its own.
		expect(exported.ack.terminalExport).toBe(true);
		expect(exported.ack.cohortObservationEvidenceSize).toBe(
			exported.observationBytes.byteLength,
		);
		expect(exported.ack.cohortObservationEvidenceSha256).toBe(
			sha256HexOfBytes(exported.observationBytes),
		);
		expect(exported.observation.workerPartials.length).toBe(8);
		expect(exported.observation.publisherPartials.length).toBe(
			MAC_PUBLISHER_COUNT,
		);
		expect(exported.observation.roleWarmupCompletes.length).toBe(
			MAC_PUBLISHER_COUNT + 8,
		);
		// The exact ack payload bytes the binary wrote are retained, not a
		// re-encoding: they canonicalize to the parsed ack and nothing else.
		expect(sha256HexOfBytes(exported.ackPayloadBytes)).toBe(
			sha256HexOfBytes(bytesOfCanonical(exported.ack)),
		);

		// C3: the artifact consumer verifies the seven-field transcript under the
		// staged Mac key and reassembles the same observation. Loaded here rather
		// than at the top of the file: `artifact-builder.ts` still imports the
		// fixture attestation this amendment moved out of the production module
		// (slice 1 owns that import), and a static import would take this whole
		// suite down with it rather than this one assertion.
		const { cohortEvidenceFromExportAck } = await import(
			"./artifact-builder.ts"
		);
		const consumed = cohortEvidenceFromExportAck({
			ack: exported.ack,
			observation: exported.observation,
			stagedMacPublicRaw32: harness.macKeys.publicRaw32,
			expectedExecutionSha256: harness.executionSha256,
			expectedCohortGrantSha256: live.grantSha256,
			expectedPublisherCount: MAC_PUBLISHER_COUNT,
			expectedSubscriberCount: MAC_SUBSCRIBER_COUNT,
			alreadyExported: false,
			expectedRequestSequence: exported.ack.ackRequestSeq,
		});
		expect(consumed.ok).toBe(true);
		if (!consumed.ok) throw new Error(`consume: ${consumed.message}`);
		expect(consumed.value.ledger.delivered).toBe(ledger.value.delivered);

		// A rewritten bundle -- one worker partial swapped for a fatter one --
		// fails the same parser, so injecting after the export is no better than
		// injecting before it.
		const injected = {
			...exported.observation,
			workerPartials: [
				retainedOf(inflated),
				...exported.observation.workerPartials.slice(1),
			],
		};
		expect(
			parseCohortObservationEvidence({
				evidence: injected,
				expectedPublisherCount: MAC_PUBLISHER_COUNT,
				expectedSubscriberCount: MAC_SUBSCRIBER_COUNT,
			}).ok,
		).toBe(false);
		// And the consumer refuses it against the signed digest.
		expect(
			cohortEvidenceFromExportAck({
				ack: exported.ack,
				observation: injected,
				stagedMacPublicRaw32: harness.macKeys.publicRaw32,
				expectedExecutionSha256: harness.executionSha256,
				expectedCohortGrantSha256: live.grantSha256,
				expectedPublisherCount: MAC_PUBLISHER_COUNT,
				expectedSubscriberCount: MAC_SUBSCRIBER_COUNT,
				alreadyExported: false,
				expectedRequestSequence: exported.ack.ackRequestSeq,
			}).ok,
		).toBe(false);

		// The export is terminal: there is no second one to substitute into,
		// and the channel is closed behind it.
		const second = await supervisor.exportCohortEvidence();
		expect(second.ok).toBe(false);
		expect(harness.channel.isTerminal).toBe(true);

		for (const each of [harness, rewrittenHarness]) {
			expect(each.supervisor.teardown("PASS").ok).toBe(true);
			rmSync(each.runtimeDir, { recursive: true, force: true });
		}
	});

	test("a_null_cohort_admission_receipt_refuses_rather_than_shortening_the_evidence", async () => {
		// §2.9(2f) rows 32-33, review NEW-29. A binary that answers MAC_JOIN with
		// the Phase-A half only is refused at the point of receipt, with a
		// diagnosis, and the export never runs on a 31-field graph.
		const harness = await macHarness({
			mutate: (schema, payload) =>
				schema === "mac-measurement-admission-issued-ack/v1"
					? {
							...payload,
							cohortAdmissionReceiptBase64: null,
							cohortAdmissionSignatureBase64: null,
						}
					: payload,
		});
		const live = await macDriveToExport(harness);
		const admitted = await harness.supervisor.presentRigObservation(
			live.phaseA,
		);
		expect(admitted.ok).toBe(false);
		expect(admitted.ok === false && admitted.code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
		expect(admitted.ok === false && admitted.message).toContain(
			"no cohort admission receipt",
		);
		expect(harness.supervisor.cohortAdmission).toBeNull();
		const exported = await harness.supervisor.exportCohortEvidence();
		expect(exported.ok).toBe(false);
		expect(exported.ok === false && exported.code).toBe("COHORT_NOT_READY");
		expect(harness.supervisor.teardown("FAIL").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("an_admission_receipt_binding_another_digest_is_refused", async () => {
		// A binary that signs an admission over some other barrier digest. The
		// signature is genuine; the receipt still describes a cohort this
		// supervisor did not run.
		const harness = await macHarness({
			mutate: (schema, payload) => {
				if (schema !== "mac-measurement-admission-issued-ack/v1")
					return payload;
				const receipt = JSON.parse(
					Buffer.from(
						payload.cohortAdmissionReceiptBase64 as string,
						"base64",
					).toString("utf8"),
				) as Record<string, unknown>;
				const rebound = bytesOfCanonical({
					...receipt,
					cohortStartBarrierSha256: HEX("d"),
				});
				return {
					...payload,
					cohortAdmissionReceiptBase64: Buffer.from(rebound).toString("base64"),
					cohortAdmissionSignatureBase64: Buffer.from(
						bytesOfCanonical(
							signMacReceipt({
								privatePkcs8Der: harness.macKeys.privatePkcs8Der,
								publicRaw32: harness.macKeys.publicRaw32,
								signedSchema: "cohort-admission-receipt/v1",
								signedBytes: rebound,
							}),
						),
					).toString("base64"),
				};
			},
		});
		const live = await macDriveToExport(harness);
		const admitted = await harness.supervisor.presentRigObservation(
			live.phaseA,
		);
		expect(admitted.ok).toBe(false);
		expect(admitted.ok === false && admitted.message).toContain(
			"binds another cohortStartBarrierSha256",
		);
		expect(harness.supervisor.teardown("FAIL").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("a_terminal_export_ack_signed_by_another_key_is_refused", async () => {
		// Positive sibling: the honest ack verifies (proved by the courier test
		// above and by `cohortEvidenceFromExportAck` there). Here the same binary
		// re-signs its own honest transcript with a key that is not the staged
		// one; every field is intact, only the signature is foreign.
		const forger = generateEd25519KeyPair();
		const harness = await macHarness({
			mutate: (schema, payload) =>
				schema === "mac-cohort-evidence-exported-ack/v1"
					? (signCohortExportAck(
							payload as never,
							forger.privatePkcs8Der,
						) as unknown as Record<string, unknown>)
					: payload,
		});
		const live = await macDriveToExport(harness);
		const admitted = await harness.supervisor.presentRigObservation(
			live.phaseA,
		);
		expect(admitted.ok).toBe(true);
		const exported = await harness.supervisor.exportCohortEvidence();
		expect(exported.ok).toBe(false);
		expect(exported.ok === false && exported.code).toBe(
			"MAC_SIGNING_KEY_MISMATCH",
		);
		// Terminal either way: the channel does not offer a second export.
		expect(harness.channel.isTerminal).toBe(true);
		expect(harness.supervisor.teardown("FAIL").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("a_terminal_export_ack_naming_another_digest_is_refused", async () => {
		// The signature is the binary's and verifies; the digest it signed is
		// not the observation this supervisor can reassemble, so the artifact
		// would retain bytes nobody signed. Refused before assembly.
		const harness = await macHarness({
			mutate: (schema, payload) => {
				if (schema !== "mac-cohort-evidence-exported-ack/v1") return payload;
				const { cohortObservationEvidenceSignatureBase64: _drop, ...unsigned } =
					payload as Record<string, unknown>;
				return signCohortExportAck(
					{ ...unsigned, cohortObservationEvidenceSha256: HEX("c") } as never,
					harness.macKeys.privatePkcs8Der,
				) as unknown as Record<string, unknown>;
			},
		});
		const live = await macDriveToExport(harness);
		expect(
			(await harness.supervisor.presentRigObservation(live.phaseA)).ok,
		).toBe(true);
		const exported = await harness.supervisor.exportCohortEvidence();
		expect(exported.ok).toBe(false);
		expect(exported.ok === false && exported.code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
		expect(harness.supervisor.teardown("FAIL").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("the_mac_channel_charges_the_execution_budget_before_decoding", async () => {
		// §2.9(2d): the three bulk frames debit their decoded lengths, nothing
		// else does, and the total after the terminal export is exactly the sum
		// of what travelled.
		const harness = await macHarness();
		expect(harness.channel.budget.chargedBytes).toBe(0);
		const live = await macDriveToExport(harness);
		await macJoinAndExport(live);
		let expected = 0;
		for (const request of harness.wire.seen) {
			const fields =
				COHORT_EVIDENCE_DEBIT_FIELDS[request.schema as string] ?? [];
			for (const field of fields) {
				const value = request[field];
				if (value === null || value === undefined) continue;
				for (const entry of Array.isArray(value) ? value : [value]) {
					expected += Buffer.from(entry as string, "base64").byteLength;
				}
			}
		}
		expect(expected).toBeGreaterThan(0);
		expect(harness.channel.budget.chargedBytes).toBe(expected);
		expect(harness.channel.budget.openExecutionSha256).toBe(
			harness.executionSha256,
		);
		expect(harness.supervisor.teardown("PASS").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("the_role_child_bundle_carries_the_binarys_exact_keys_bound_to_the_admission_receipt", async () => {
		// The binary reads the bundle under `ROLE_CHILD_EVIDENCE_BUNDLE_FIELDS`
		// (secure_fs.rs, `exact_fields`, then the admission-receipt binding):
		// one key the binary does not list is `UnknownField` -> TRUST_PROTOCOL
		// on the real path, and a bundle bound to the barrier instead of the
		// admission receipt is exactly that key.
		const harness = await macHarness();
		const live = await macDriveToExport(harness);
		await macJoinAndExport(live);
		const request = harness.wire.seen.find(
			(frame) => frame.schema === "mac-export-cohort-evidence-request/v1",
		);
		if (request === undefined) throw new Error("no export request was sent");
		const bundle = JSON.parse(
			Buffer.from(
				request.roleChildEvidenceBundleBase64 as string,
				"base64",
			).toString("utf8"),
		) as Record<string, unknown>;
		expect(Object.keys(bundle).sort()).toEqual(
			[
				"schema",
				"executionSha256",
				"cohortGrantSha256",
				"cohortAdmissionReceiptSha256",
				"roleWarmupCompletes",
				"publisherPartials",
				"workerPartials",
				"orderedPartialManifest",
				"observedProcessProof",
			].sort(),
		);
		const admission = harness.supervisor.cohortAdmission;
		if (admission === null) throw new Error("no admission after the export");
		expect(bundle.cohortAdmissionReceiptSha256).toBe(admission.receiptSha256);
		expect(request.cohortAdmissionReceiptSha256).toBe(admission.receiptSha256);
		expect(harness.supervisor.teardown("PASS").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});
});

describe("cohort replacement and reap", () => {
	test("a_sealed_token_bundle_descriptor_is_released_exactly_once", async () => {
		// The spawn releases every sealed bundle descriptor once the children
		// hold their copies, and the teardown must not release the same numbers
		// again: by then they belong to whatever opened next -- a later
		// execution's pipes, or the process's own stderr -- and a second close
		// lands on that stranger (the cascaded-EBADF signature).
		const harness = await macHarness();
		await macOpenAndSpawn(harness);
		const probes: number[] = [];
		for (let index = 0; index < 32; index += 1) {
			probes.push(openSync("/dev/null", "r"));
		}
		try {
			expect(harness.supervisor.teardown("FAIL").ok).toBe(true);
			for (const fd of probes) {
				expect(() => fstatSync(fd)).not.toThrow();
			}
		} finally {
			for (const fd of probes) {
				try {
					closeSync(fd);
				} catch {
					/* the assertion above reports a stranger's close */
				}
			}
			rmSync(harness.runtimeDir, { recursive: true, force: true });
		}
	});

	test("the_production_child_host_lets_the_replacement_respawn_every_child_id", async () => {
		// The reliability gate proved by execution that it could not: `spawnChild`
		// refuses a childId already in `channels`, `closeAll` deletes nothing, and
		// the replacement asks for the same nine ids, so plan 2210's replacement
		// always ended the arm on the production host
		// (`.scratch/2026-09-05-cohort-completion/notes/reliability-gate.md` §3).
		// `miniHarness`'s array-pushing stub cannot see that, so this drives the
		// real host with only its fork injected.
		let nextPid = 900_000;
		const forked: number[] = [];
		const host = createMacFanoutRoleChildHost({
			bunExecutablePath: process.execPath,
			roleEntrypointPath: join(import.meta.dir, "bin", "fanout-role.ts"),
			transport: "ws",
			stagedMacSigningPublicKeySha256: HEX("a"),
			receiveDeadlineMs: 1_000,
			spawn: () => {
				nextPid += 1;
				forked.push(nextPid);
				return {
					pid: nextPid,
					onStderr: () => {},
					exited: new Promise<number>(() => {}),
				};
			},
		});
		const harness = await macHarness({ childHost: host });
		try {
			await macOpenAndSpawn(harness);
			const firstIds = [...host.channels.keys()].sort();
			expect(firstIds.length).toBe(9);
			expect(host.retired.length).toBe(0);

			const replaced = await harness.supervisor.replaceCohortBeforeReadiness({
				reason: "a role child died during ramp",
			});
			expect(replaced.ok).toBe(true);
			if (!replaced.ok) throw new Error(`replace: ${replaced.message}`);
			// Every id was retired, and nothing was closed to do it.
			expect(host.channels.size).toBe(0);
			expect(host.retired.length).toBe(9);

			// The replacement spawns the same nine ids, which is what used to be
			// impossible.
			const respawned = harness.supervisor.spawnRoleChildren({
				bundleFor: (plan) => macBundleFor(harness, plan),
				spawnedAtMacNs: "2000000000",
			});
			expect(respawned.ok).toBe(true);
			if (!respawned.ok) {
				throw new Error(`respawn: ${respawned.code} ${respawned.message}`);
			}
			expect([...host.channels.keys()].sort()).toEqual(firstIds);
			expect(forked.length).toBe(18);
			expect(new Set(forked).size).toBe(18);
		} finally {
			host.closeAll();
			rmSync(harness.runtimeDir, { recursive: true, force: true });
		}
	});

	test("pre_ready_replacement_mints_new_grant_nonce_and_tokens", async () => {
		const harness = await macHarness();
		await macOpenAndSpawn(harness);
		const supervisor = harness.supervisor;
		const firstAttempt = supervisor.cohortAttempt;
		const firstNonce = supervisor.grantNonceSha256 as Sha256Hex;
		const firstGrantSha256 = supervisor.cohortGrantSha256 as Sha256Hex;
		const firstRoot = (supervisor.grant as CohortGrantV1)
			.roleTokenCommitmentRootSha256;
		const firstTokens = harness.tokensByAttempt.get(1) as FanoutCohortFixture;
		const firstPgids = [...supervisor.ownedPgids];
		expect(firstPgids.length).toBe(9);

		const replaced = await supervisor.replaceCohortBeforeReadiness({
			reason: "a role child died during ramp",
		});
		expect(replaced.ok).toBe(true);
		if (!replaced.ok) throw new Error(`replace: ${replaced.message}`);

		// A whole new cohort, not a patched child.
		expect(replaced.value.cohortAttempt).toBe(firstAttempt + 1);
		expect(replaced.value.grantNonceSha256).not.toBe(firstNonce);
		expect(replaced.value.grantSha256).not.toBe(firstGrantSha256);
		expect(replaced.value.grant.cohortAttempt).toBe(2);
		expect(replaced.value.grant.roleTokenCommitmentRootSha256).not.toBe(
			firstRoot,
		);
		expect(replaced.value.retiredTokenCommitmentRootSha256).toBe(firstRoot);

		// Every token is fresh: no role keeps the secret it held a moment ago.
		const secondTokens = harness.tokensByAttempt.get(2) as FanoutCohortFixture;
		for (const roleId of firstTokens.tokenSha256ByRoleId.keys()) {
			expect(secondTokens.tokenSha256ByRoleId.get(roleId)).not.toBe(
				firstTokens.tokenSha256ByRoleId.get(roleId),
			);
		}

		// The abandoned cohort was killed and reaped before the new one existed.
		expect(replaced.value.reaped.allReaped).toBe(true);
		expect([...replaced.value.reaped.reapedPgids].sort()).toEqual(
			[...firstPgids].sort(),
		);
		expect(supervisor.spawnedChildren.length).toBe(0);

		// A Linux side staged on the new grant refuses the abandoned one.
		const clock = createManualRelayClock();
		const authority = new FanoutLinuxAuthority({
			transport: "ws",
			executionSha256: harness.executionSha256,
			stagedMacPublicRaw32: harness.macKeys.publicRaw32,
			serverIdentity: SERVER_IDENTITY,
			linuxClockId: LINUX_CLOCK_ID,
			clock,
			receiptValidityMs: MAC_VALIDITY_MS,
		});
		const acceptedNew = authority.acceptCohortGrant({
			grant: replaced.value.grant,
			signature: replaced.value.grantSignature,
			nowMs: MAC_NOW_MS,
		});
		expect(acceptedNew.ok).toBe(true);
		const started = authority.startServer();
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("unreachable");
		// An abandoned token replayed against the new relay is not a session.
		const staleRoleId = fanoutRoleId("subscriber", 0);
		const sessionId = started.value.openSession({
			trySend: () => "accepted",
			trySendDelivery: () => "accepted",
			close: () => {},
		});
		const stale = started.value.handleInbound(sessionId, {
			schema: "fanout-wire/v1",
			kind: "register",
			cohortGrantSha256: replaced.value.grantSha256,
			transport: "ws",
			role: "subscriber",
			childId: "subscriber-worker-0",
			roleId: staleRoleId,
			workerIndex: 0,
			tokenBase64: firstTokens.tokenBase64ByRoleId.get(staleRoleId) as Base64,
			tokenSha256: firstTokens.tokenSha256ByRoleId.get(
				staleRoleId,
			) as Sha256Hex,
			tokenCommitmentIndex: firstTokens.commitmentIndexByRoleId.get(
				staleRoleId,
			) as number,
			tokenMerkleProofSha256: [
				...(firstTokens.proofByRoleId.get(staleRoleId) as readonly Sha256Hex[]),
			],
		});
		expect(stale.ok).toBe(false);

		// One replacement is the whole allowance.
		const spawnedAgain = supervisor.spawnRoleChildren({
			bundleFor: (plan) => macBundleFor(harness, plan),
			spawnedAtMacNs: "6000000000",
		});
		expect(spawnedAgain.ok).toBe(true);
		const secondReplacement = await supervisor.replaceCohortBeforeReadiness({
			reason: "a second pre-readiness failure",
		});
		expect(secondReplacement.ok).toBe(false);
		expect(secondReplacement.ok === false && secondReplacement.code).toBe(
			"CHILD_LIFECYCLE",
		);

		expect(supervisor.teardown("REFUSED").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("pre_ready_replacement_returns_grant_bytes_and_retires_the_acceptance", async () => {
		// Two things the caller of a replacement needs and did not get.
		//
		// (1) `openCohort` returns the binary's own canonical grant bytes; the
		//     replacement returned only the parsed grant, so `driveCohortArm`
		//     had to re-canonicalise a record the binary signed in order to
		//     transfer it. Fail-closed, and one byte of drift away from being
		//     the thing §4's two-encoders rule exists to prevent.
		// (2) Attempt 1's rig acceptance survived the replacement in the
		//     supervisor's retention. The binary drops the retired session's rig
		//     retention with the session and answers `COHORT_PROTOCOL` /
		//     "retired cohort grant" to anything naming the superseded grant
		//     (`notes/rust-replacement.md` section 4), so a caller that kept it
		//     would present attempt 1's acceptance digest under attempt 2's
		//     grant and be refused at the binary.
		const harness = await macHarness();
		const supervisor = harness.supervisor;
		const opened = await supervisor.openCohort();
		if (!opened.ok) throw new Error(`openCohort: ${opened.code}`);
		const spawned = supervisor.spawnRoleChildren({
			bundleFor: (plan) => macBundleFor(harness, plan),
			spawnedAtMacNs: "1000000000",
		});
		if (!spawned.ok) throw new Error(`spawn: ${spawned.code}`);
		const clock = createManualRelayClock();
		const authority = new FanoutLinuxAuthority({
			transport: "ws",
			executionSha256: harness.executionSha256,
			stagedMacPublicRaw32: harness.macKeys.publicRaw32,
			serverIdentity: SERVER_IDENTITY,
			linuxClockId: LINUX_CLOCK_ID,
			clock,
			receiptValidityMs: MAC_VALIDITY_MS,
		});
		const accepted = authority.acceptCohortGrant({
			grant: opened.value.grant,
			signature: opened.value.grantSignature,
			nowMs: MAC_NOW_MS,
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error("unreachable");
		const rig = new ScriptedRigSupervisor(harness.rigKeys, clock, {
			receiptValidityMs: MAC_VALIDITY_MS,
		});
		const rigAcceptance = rig.acceptCohort(accepted.value, MAC_NOW_MS);
		const presented = await supervisor.presentRigCohortAcceptance({
			acceptance: rigAcceptance.record,
			signature: rigAcceptance.signature,
			nowMs: MAC_NOW_MS,
		});
		expect(presented.ok).toBe(true);

		const replaced = await supervisor.replaceCohortBeforeReadiness({
			reason: "a role child died during ramp",
		});
		expect(replaced.ok).toBe(true);
		if (!replaced.ok) throw new Error(`replace: ${replaced.message}`);

		// (1) The bytes the binary signed, carried rather than rebuilt.
		expect(sha256HexOfBytes(replaced.value.grantBytes)).toBe(
			replaced.value.grantSha256,
		);
		expect(replaced.value.grantBytes).toEqual(
			bytesOfCanonical(replaced.value.grant),
		);

		// (2) Attempt 1's acceptance went with attempt 1. The next transition
		// says so rather than presenting a digest the binary has retired.
		const early = await supervisor.issueWarmupEpoch();
		expect(early.ok).toBe(false);
		expect(early.ok === false && early.code).toBe("COHORT_NOT_READY");

		expect(supervisor.teardown("REFUSED").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("a_second_pre_readiness_replacement_is_terminal_for_the_supervisor", async () => {
		// Plan 2210: "At most one pre-readiness cohort replacement is allowed; a
		// second failure is terminal." The bound was honoured -- the second
		// replacement was refused -- but nothing was terminal: the supervisor
		// went on answering, so a caller could spawn a fresh cohort on the
		// attempt-2 grant it had just declared unrecoverable.
		const harness = await macHarness();
		await macOpenAndSpawn(harness);
		const supervisor = harness.supervisor;
		expect(supervisor.terminalRefusalCode).toBeNull();

		const first = await supervisor.replaceCohortBeforeReadiness({
			reason: "a role child died during ramp",
		});
		expect(first.ok).toBe(true);
		expect(supervisor.terminalRefusalCode).toBeNull();
		expect(
			supervisor.spawnRoleChildren({
				bundleFor: (plan) => macBundleFor(harness, plan),
				spawnedAtMacNs: "6000000000",
			}).ok,
		).toBe(true);

		const second = await supervisor.replaceCohortBeforeReadiness({
			reason: "a second pre-readiness failure",
		});
		expect(second.ok).toBe(false);
		expect(second.ok === false && second.code).toBe("CHILD_LIFECYCLE");
		expect(supervisor.terminalRefusalCode).toBe("CHILD_LIFECYCLE");

		// Terminal means terminal: no further cohort, and every later attempt
		// answers with the same closed code rather than a new opinion.
		const again = await supervisor.replaceCohortBeforeReadiness({
			reason: "a third try",
		});
		expect(again.ok === false && again.code).toBe("CHILD_LIFECYCLE");
		const respawn = supervisor.spawnRoleChildren({
			bundleFor: (plan) => macBundleFor(harness, plan),
			spawnedAtMacNs: "7000000000",
		});
		expect(respawn.ok).toBe(false);
		expect(respawn.ok === false && respawn.code).toBe("CHILD_LIFECYCLE");
		// Nothing was replaced past the allowance.
		expect(supervisor.replacementCount).toBe(
			MAC_FANOUT_MAX_PRE_READY_REPLACEMENTS,
		);
		expect(supervisor.cohortAttempt).toBe(2);

		// The one thing a terminal supervisor must still do.
		const reaped = supervisor.teardown("FAIL");
		expect(reaped.ok).toBe(true);
		if (!reaped.ok) throw new Error("unreachable");
		expect(reaped.value.allReaped).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("post_ready_replacement_fails", async () => {
		const harness = await macHarness();
		await macOpenAndSpawn(harness);
		const supervisor = harness.supervisor;
		const grantSha256 = supervisor.cohortGrantSha256;

		// One child ready is enough: readiness is a cohort property, and the
		// global ordinal domain is spent from the first accepted session.
		const first = supervisor.topology.children[0] as MacFanoutChildPlanV1;
		expect(
			supervisor.markChildReady({
				childId: first.childId,
				readyAtMacNs: "2000000000",
			}).ok,
		).toBe(true);

		const afterOne = await supervisor.replaceCohortBeforeReadiness({
			reason: "a child exited after its sibling was ready",
		});
		expect(afterOne.ok).toBe(false);
		expect(afterOne.ok === false && afterOne.code).toBe("CHILD_LIFECYCLE");

		macReadyAll(harness);
		expect(supervisor.allChildrenReady).toBe(true);
		const afterAll = await supervisor.replaceCohortBeforeReadiness({
			reason: "a child exited after full readiness",
		});
		expect(afterAll.ok).toBe(false);
		expect(afterAll.ok === false && afterAll.code).toBe("CHILD_LIFECYCLE");

		// Nothing moved: same attempt, same nonce, same grant, same children.
		expect(supervisor.cohortAttempt).toBe(1);
		expect(supervisor.cohortGrantSha256).toBe(grantSha256);
		expect(supervisor.replacementCount).toBe(0);
		expect(supervisor.spawnedChildren.length).toBe(9);
		// And the observed-process contract still says no child was replaced.
		expect(validateNoRoleReplacements(supervisor.replacementCount).ok).toBe(
			true,
		);

		expect(supervisor.teardown("FAIL").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("all_pgids_are_reaped_on_every_terminal_path", async () => {
		for (const terminalPath of MAC_FANOUT_TERMINAL_PATHS) {
			const harness = await macHarness();
			await macOpenAndSpawn(harness);
			const supervisor = harness.supervisor;
			const owned = [...supervisor.ownedPgids];
			expect(owned.length).toBe(9);

			const reaped = supervisor.teardown(terminalPath);
			expect(reaped.ok).toBe(true);
			if (!reaped.ok) throw new Error(`teardown ${terminalPath}`);
			expect(reaped.value.terminalPath).toBe(terminalPath);
			expect(reaped.value.allReaped).toBe(true);
			expect([...reaped.value.reapedPgids].sort()).toEqual([...owned].sort());
			expect(reaped.value.records.every((record) => record.reaped)).toBe(true);
			expect([...harness.processes.reaped].sort()).toEqual([...owned].sort());

			// Idempotent: a signal handler and a normal return both land here.
			const again = supervisor.teardown(terminalPath);
			expect(again.ok).toBe(true);
			expect([...harness.processes.reaped].sort()).toEqual([...owned].sort());
			rmSync(harness.runtimeDir, { recursive: true, force: true });
		}

		// A group that ignores SIGTERM is escalated and still reaped.
		const stubborn = await macHarness({ survivesSigterm: true });
		await macOpenAndSpawn(stubborn);
		const stubbornOwned = [...stubborn.supervisor.ownedPgids];
		const escalated = stubborn.supervisor.teardown("SIGINT");
		expect(escalated.ok).toBe(true);
		if (!escalated.ok) throw new Error("unreachable");
		expect(escalated.value.allReaped).toBe(true);
		for (const record of escalated.value.records) {
			expect(record.signalsSent).toEqual(["SIGTERM", "SIGKILL"]);
		}
		expect([...escalated.value.reapedPgids].sort()).toEqual(
			[...stubbornOwned].sort(),
		);
		rmSync(stubborn.runtimeDir, { recursive: true, force: true });

		// A cohort abandoned before readiness is still reaped by the terminal
		// path that follows it: the replacement's groups are not forgotten.
		const replaced = await macHarness();
		await macOpenAndSpawn(replaced);
		const abandoned = [...replaced.supervisor.ownedPgids];
		const replacement = await replaced.supervisor.replaceCohortBeforeReadiness({
			reason: "pre-readiness failure",
		});
		expect(replacement.ok).toBe(true);
		expect(
			replaced.supervisor.spawnRoleChildren({
				bundleFor: (plan) => macBundleFor(replaced, plan),
				spawnedAtMacNs: "6000000000",
			}).ok,
		).toBe(true);
		const allOwned = [...replaced.supervisor.ownedPgids];
		expect(allOwned.length).toBe(18);
		expect(allOwned).toEqual(expect.arrayContaining(abandoned));
		const finalReap = replaced.supervisor.teardown("PASS");
		expect(finalReap.ok).toBe(true);
		if (!finalReap.ok) throw new Error("unreachable");
		expect([...finalReap.value.reapedPgids].sort()).toEqual(
			[...allOwned].sort(),
		);
		rmSync(replaced.runtimeDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// The production Mac role-child host (B3.5 blockers 3 and 9)
//
// Everything above this line drives the supervisor against a fake process
// table. This block drives the *production* seams against real processes: it
// spawns `bin/fanout-role.ts` under the staged Bun with the three descriptors
// section 3.4 allows, talks to it over the real control pipe, and reaps its
// real process group.
//
// The claim each test makes is about something that cannot be asserted from a
// fake: that FD 5 arrives in the child read-only, unlinked and digest-exact
// (the child refuses otherwise, and its first control frame is the proof it
// did not), that FD 3 and FD 4 are the control pair in the right direction,
// and that a group that ignores SIGTERM is still gone after SIGKILL.
// ---------------------------------------------------------------------------

describe("the production Mac role-child host", () => {
	const roleEntrypoint = join(import.meta.dir, "bin", "fanout-role.ts");

	/** One sealed bundle plus the plan and host that will hand it to a child. */
	function liveChildRig(
		options: { readonly stagedKeyOverride?: Sha256Hex } = {},
	) {
		const cohort = buildCohort();
		const bundle = tokenBundleFor(cohort, {
			childId: "publisher-child-0",
			roleIds: ["publisher-000000"],
			role: "publisher",
		});
		const runtimeDir = mkdtempSync(join(tmpdir(), "b35-live-child-"));
		const sealed = sealTokenBundleFd({ runtimeDir, bundle });
		if (!sealed.ok) throw new Error(`seal: ${sealed.code}: ${sealed.message}`);
		const topology = planMacFanoutTopology({
			scenario: "ticker",
			subscriberCount: SUBSCRIBER_COUNT,
		});
		if (!topology.ok) throw new Error(`topology: ${topology.code}`);
		const plan = topology.value.children.find(
			(child) => child.childId === "publisher-child-0",
		) as MacFanoutChildPlanV1;
		const stderr: string[] = [];
		const host = createMacFanoutRoleChildHost({
			bunExecutablePath: process.execPath,
			roleEntrypointPath: roleEntrypoint,
			transport: "ws",
			stagedMacSigningPublicKeySha256:
				options.stagedKeyOverride ?? cohort.signingPublicKeySha256,
			receiveDeadlineMs: 20_000,
			onChildStderr: (_childId, text) => {
				stderr.push(text);
			},
		});
		return {
			cohort,
			bundle,
			sealed: sealed.value,
			plan,
			host,
			runtimeDir,
			stderr,
		};
	}

	function spawnLive(rig: ReturnType<typeof liveChildRig>) {
		return rig.host.spawnChild({
			plan: rig.plan,
			tokenBundleReadFd: rig.sealed.readFd,
			tokenBundleSha256: rig.sealed.sha256,
			tokenBundleSize: rig.sealed.byteSize,
			tokenBundleEntryCount: rig.sealed.entryCount,
			childInstanceNonce: HEX("c"),
			inheritedChildFds: [3, 4, 5],
		});
	}

	function cleanUp(rig: ReturnType<typeof liveChildRig>): void {
		for (const child of rig.host.spawned) {
			rig.host.processControl.killPgid(child.pgid, "SIGKILL");
			rig.host.processControl.waitPgid(child.pgid, 5_000);
		}
		rig.host.closeAll();
		rig.sealed.close();
		rmSync(rig.runtimeDir, { recursive: true, force: true });
	}

	test("a real role child reads its config on FD 3 and its tokens on FD 5", async () => {
		const rig = liveChildRig();
		try {
			const spawned = spawnLive(rig);
			expect(spawned.ok).toBe(true);
			if (!spawned.ok) throw new Error("unreachable");
			// `setsid` is what makes the group addressable by the recorded number.
			expect(spawned.value.pgid).toBe(spawned.value.pid);

			const channel = rig.host.channel("publisher-child-0");
			expect(channel).toBeDefined();
			if (channel === undefined) throw new Error("unreachable");

			const bundleBytes = bytesOfCanonical(rig.bundle);
			const sent = await channel.send(
				spawnConfig(rig.cohort, {
					tokenBundleSha256: sha256HexOfBytes(bundleBytes),
					tokenBundleSize: bundleBytes.byteLength,
					tokenBundleEntryCount: rig.bundle.entryCount,
				}),
			);
			expect(sent.ok).toBe(true);

			// The child only reaches a permit request after it has verified the
			// grant signature, the staged key digest, and every FD 5 property:
			// regular, read-only, unlinked, exact size and exact digest. This
			// frame is therefore the assertion that all of that held.
			const request = await channel.receive("connect-permit-request/v1", {
				deadlineMs: 20_000,
				deadlineCode: "READY_DEADLINE_EXCEEDED",
			});
			if (!request.ok) {
				throw new Error(
					`${request.code}: ${request.message} :: ${rig.stderr.join("")}`,
				);
			}
			expect(request.value.record.childId).toBe("publisher-child-0");
			expect(request.value.record.roleId).toBe("publisher-000000");
			expect(request.value.record.cohortGrantSha256).toBe(
				rig.cohort.grantSha256,
			);
			// Each direction owns its own sequence, and both started at zero.
			expect(request.value.record.sequence).toBe(0);
			expect(channel.sentCount).toBe(1);
			expect(channel.receivedCount).toBe(1);
		} finally {
			cleanUp(rig);
		}
	}, 40_000);

	test("a child handed the wrong staged key digest refuses before it reads FD 5", async () => {
		// The staged digest is inherited from the supervisor, so a config whose
		// embedded key does not match it is refused with no token read at all.
		const rig = liveChildRig({ stagedKeyOverride: HEX("b") });
		try {
			const spawned = spawnLive(rig);
			expect(spawned.ok).toBe(true);
			if (!spawned.ok) throw new Error("unreachable");
			const channel = rig.host.channel(
				"publisher-child-0",
			) as MacRoleChildControlChannel;
			expect((await channel.send(spawnConfig(rig.cohort))).ok).toBe(true);

			// The child exits rather than answering; the supervisor sees EOF.
			const answered = await channel.receive("connect-permit-request/v1", {
				deadlineMs: 20_000,
				deadlineCode: "READY_DEADLINE_EXCEEDED",
			});
			expect(answered.ok).toBe(false);
			if (answered.ok) throw new Error("unreachable");
			expect(answered.code).toBe("UNEXPECTED_EOF");
			expect(channel.refusal).toContain("UNEXPECTED_EOF");

			// And it is reaped by the production control, on the real group.
			expect(rig.host.processControl.waitPgid(spawned.value.pgid, 10_000)).toBe(
				true,
			);
		} finally {
			cleanUp(rig);
		}
	}, 40_000);

	test("a role child that ignores SIGTERM is still reaped after SIGKILL", async () => {
		const rig = liveChildRig();
		try {
			const spawned = spawnLive(rig);
			if (!spawned.ok) throw new Error("unreachable");
			const control = rig.host.processControl;
			// The child is parked reading FD 3 and has installed no handler, so
			// SIGTERM is enough here; the point of the assertion is that the
			// escalation path ends with a group that no longer exists.
			control.killPgid(spawned.value.pgid, "SIGTERM");
			if (!control.waitPgid(spawned.value.pgid, 3_000)) {
				control.killPgid(spawned.value.pgid, "SIGKILL");
				expect(control.waitPgid(spawned.value.pgid, 5_000)).toBe(true);
			}
			expect(control.waitPgid(spawned.value.pgid, 1_000)).toBe(true);
			// Signalling a group that is already gone is the caller's outcome,
			// not an error the teardown path has to know how to swallow.
			expect(() =>
				control.killPgid(spawned.value.pgid, "SIGKILL"),
			).not.toThrow();
		} finally {
			cleanUp(rig);
		}
	}, 40_000);

	test("a retired child frees its id for the replacement and keeps its pipe open", async () => {
		// Plan 2210's pre-readiness replacement re-spawns the same child ids, so
		// the production host has to be able to forget one -- and must NOT close
		// its parent-held pipe while doing so, because a sibling's blocking read
		// may still be pending on Bun's pool. Proved on a real child, its real
		// pipe and its real group.
		const rig = liveChildRig();
		try {
			const first = spawnLive(rig);
			expect(first.ok).toBe(true);
			if (!first.ok) throw new Error("unreachable");
			const firstChannel = rig.host.channel(
				"publisher-child-0",
			) as MacRoleChildControlChannel;
			expect(firstChannel).toBeDefined();

			expect(rig.host.retireChild("publisher-child-0")).toBe(true);
			expect(rig.host.retireChild("publisher-child-0")).toBe(false);
			expect(rig.host.channel("publisher-child-0")).toBeUndefined();
			expect(rig.host.retired).toEqual([firstChannel]);

			// Nothing was closed: the retired channel still writes to a live
			// child on a live descriptor.
			expect((await firstChannel.send(spawnConfig(rig.cohort))).ok).toBe(true);

			// And the id is free, which is the whole point.
			const second = rig.host.spawnChild({
				plan: rig.plan,
				tokenBundleReadFd: rig.sealed.readFd,
				tokenBundleSha256: rig.sealed.sha256,
				tokenBundleSize: rig.sealed.byteSize,
				tokenBundleEntryCount: rig.sealed.entryCount,
				childInstanceNonce: HEX("d"),
				inheritedChildFds: [3, 4, 5],
			});
			expect(second.ok).toBe(true);
			if (!second.ok) throw new Error(`respawn: ${second.message}`);
			expect(second.value.pid).not.toBe(first.value.pid);
			const secondChannel = rig.host.channel("publisher-child-0");
			expect(secondChannel).toBeDefined();
			expect(secondChannel).not.toBe(firstChannel);

			// `closeAll` closes retired and live alike; the retired one refuses
			// afterwards, which is how we know it was closed then and not before.
			rig.host.closeAll();
			const afterClose = await firstChannel.send(spawnConfig(rig.cohort));
			expect(afterClose.ok).toBe(false);
		} finally {
			cleanUp(rig);
		}
	}, 40_000);

	test("the host refuses a second spawn of one child and a wrong FD triple", async () => {
		const rig = liveChildRig();
		try {
			expect(spawnLive(rig).ok).toBe(true);
			const again = spawnLive(rig);
			expect(again.ok).toBe(false);
			if (again.ok) throw new Error("unreachable");
			expect(again.message).toContain("already spawned");

			const wrongFds = rig.host.spawnChild({
				plan: { ...rig.plan, childId: "publisher-child-9" },
				tokenBundleReadFd: rig.sealed.readFd,
				tokenBundleSha256: rig.sealed.sha256,
				tokenBundleSize: rig.sealed.byteSize,
				tokenBundleEntryCount: rig.sealed.entryCount,
				childInstanceNonce: HEX("c"),
				inheritedChildFds: [3, 4, 4] as unknown as readonly [3, 4, 5],
			});
			expect(wrongFds.ok).toBe(false);
		} finally {
			cleanUp(rig);
		}
	}, 40_000);
});

// ---------------------------------------------------------------------------
// The rig's server child: `server-bind-execution/v1` in, `server-ready/v1` and
// `server-warmup-ready/v1` back
// ---------------------------------------------------------------------------

/**
 * A control pipe with no kernel in it.
 *
 * The production pipe is two descriptors and `node:fs`; what the child's logic
 * actually depends on is a byte stream that ends, which is what this is. The
 * real descriptors are exercised by the spawned-process test in
 * `fanout-production-e2e.test.ts`.
 */
function memoryControlPipe(inbound: readonly Uint8Array[]): {
	readonly io: CohortControlPipeIo;
	readonly written: Uint8Array[];
	push(bytes: Uint8Array): void;
} {
	const queue: Uint8Array[] = [...inbound];
	const written: Uint8Array[] = [];
	let ended = false;
	return {
		io: {
			read: async () => {
				const next = queue.shift();
				if (next !== undefined) return next;
				ended = true;
				return null;
			},
			write: async (bytes) => {
				written.push(bytes);
			},
			close: () => {
				ended = true;
			},
		},
		written,
		push: (bytes) => {
			if (ended) throw new Error("pipe already ended");
			queue.push(bytes);
		},
	};
}

function bindFrame(args: {
	readonly executionSha256: Sha256Hex;
	readonly grantBytes: Uint8Array;
	readonly signature: MacReceiptSignatureV1 | null;
	readonly sequence?: number;
}): Uint8Array {
	const framed = encodeChildPipeFrame({
		schema: "server-bind-execution/v1",
		sequence: args.sequence ?? 0,
		executionSha256: args.executionSha256,
		rigExecutionAcceptanceSha256: HEX("e"),
		cohortGrantBase64: Buffer.from(args.grantBytes).toString("base64"),
		cohortGrantSignatureBase64:
			args.signature === null
				? null
				: Buffer.from(bytesOfCanonical(args.signature)).toString("base64"),
		// The fanout arm's bind. The ordinary A5 arm carries the Mac execution
		// receipt in these two instead (amendment C4 deviation
		// `2026-09-06-ordinary-phase-a-server-spawn.md`).
		macExecutionGrantReceiptBase64: null,
		macExecutionGrantSignatureBase64: null,
	});
	if (!framed.ok) throw new Error(`bind frame: ${framed.code}`);
	return framed.value;
}

describe("the server child's cohort control pipe", () => {
	test("the frozen FD pair is the one section 3.4 names", () => {
		// FD 3 supervisor -> child, FD 4 child -> supervisor. The role children
		// use the same two numbers, and the rig's spawner dup2s onto them.
		expect(FANOUT_COHORT_CONTROL_READ_FD).toBe(3);
		expect(FANOUT_COHORT_CONTROL_WRITE_FD).toBe(4);
	});

	test("no listener exists for a grant the staged Mac key did not sign", () => {
		const cohort = buildLinuxCohort();
		const parsed = parseServerBindExecution({
			schema: "server-bind-execution/v1",
			sequence: 0,
			executionSha256: cohort.executionSha256,
			rigExecutionAcceptanceSha256: HEX("e"),
			cohortGrantBase64: Buffer.from(cohort.grantBytes).toString("base64"),
			cohortGrantSignatureBase64: Buffer.from(
				bytesOfCanonical(cohort.grantSignature),
			).toString("base64"),
			macExecutionGrantReceiptBase64: null,
			macExecutionGrantSignatureBase64: null,
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("unreachable");

		// The honest bind is accepted.
		const honest = decideCohortBind({
			bind: parsed.value,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
		});
		expect(honest.ok).toBe(true);
		if (!honest.ok) throw new Error("unreachable");
		expect(honest.value.cohortGrantSha256).toBe(cohort.grantSha256);
		expect(honest.value.executionSha256).toBe(cohort.executionSha256);

		// A different Mac key: the record still names the digest it was minted
		// with, so this is a key mismatch and not a broken signature.
		const foreign = generateEd25519KeyPair();
		const wrongKey = decideCohortBind({
			bind: parsed.value,
			stagedMacPublicRaw32: foreign.publicRaw32,
		});
		expect(wrongKey.ok).toBe(false);
		expect(wrongKey.ok === false && wrongKey.code).toBe(
			"MAC_SIGNING_KEY_MISMATCH",
		);

		// One byte of the grant moved after signing.
		const tampered = new Uint8Array(cohort.grantBytes);
		const flip = tampered.length - 3;
		tampered.set([(tampered[flip] as number) ^ 0x01], flip);
		const tamperedBind = parseServerBindExecution({
			...parsed.value,
			cohortGrantBase64: Buffer.from(tampered).toString("base64"),
		});
		expect(tamperedBind.ok).toBe(true);
		if (!tamperedBind.ok) throw new Error("unreachable");
		const moved = decideCohortBind({
			bind: tamperedBind.value,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
		});
		expect(moved.ok).toBe(false);
		expect(moved.ok === false && moved.code).toBe(
			"MAC_GRANT_SIGNATURE_INVALID",
		);

		// A signature that verifies over the right bytes while naming another
		// schema is a cross-record substitution, not an authorisation.
		const wrongSchema = signMacReceipt({
			privatePkcs8Der: cohort.mac.privatePkcs8Der,
			publicRaw32: cohort.mac.publicRaw32,
			signedSchema: "cohort-warmup-epoch/v1",
			signedBytes: cohort.grantBytes,
		});
		const substituted = parseServerBindExecution({
			...parsed.value,
			cohortGrantSignatureBase64: Buffer.from(
				bytesOfCanonical(wrongSchema),
			).toString("base64"),
		});
		expect(substituted.ok).toBe(true);
		if (!substituted.ok) throw new Error("unreachable");
		const crossRecord = decideCohortBind({
			bind: substituted.value,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
		});
		expect(crossRecord.ok).toBe(false);
		expect(crossRecord.ok === false && crossRecord.code).toBe(
			"MAC_GRANT_SIGNATURE_INVALID",
		);

		// The frame naming one execution and the signed grant another.
		const mismatched = parseServerBindExecution({
			...parsed.value,
			executionSha256: HEX("d"),
		});
		expect(mismatched.ok).toBe(true);
		if (!mismatched.ok) throw new Error("unreachable");
		const disagree = decideCohortBind({
			bind: mismatched.value,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
		});
		expect(disagree.ok).toBe(false);
		expect(disagree.ok === false && disagree.code).toBe("EXECUTION_MISMATCH");
	});

	test("an unsigned grant is unrepresentable, and a bind with no authority never parses", () => {
		const cohort = buildLinuxCohort();
		// The pairing rule lives in the codec: "a grant with no signature" never
		// parses, so `decideCohortBind` is never asked about it.
		const halfNull = parseServerBindExecution({
			schema: "server-bind-execution/v1",
			sequence: 0,
			executionSha256: cohort.executionSha256,
			rigExecutionAcceptanceSha256: HEX("e"),
			cohortGrantBase64: Buffer.from(cohort.grantBytes).toString("base64"),
			cohortGrantSignatureBase64: null,
			macExecutionGrantReceiptBase64: null,
			macExecutionGrantSignatureBase64: null,
		});
		expect(halfNull.ok).toBe(false);

		// The plan's five-key "Phase-A" bind carried neither authority, and a
		// listener without one is exactly what 4.2 forbids. It is now
		// unrepresentable rather than merely refused: a bind carries the cohort
		// grant or the Mac execution receipt, and exactly one of them.
		const bare = parseServerBindExecution({
			schema: "server-bind-execution/v1",
			sequence: 0,
			executionSha256: cohort.executionSha256,
			rigExecutionAcceptanceSha256: HEX("e"),
			cohortGrantBase64: null,
			cohortGrantSignatureBase64: null,
			macExecutionGrantReceiptBase64: null,
			macExecutionGrantSignatureBase64: null,
		});
		expect(bare.ok).toBe(false);
		expect(bare.ok === false && bare.code).toBe("FRAME_INVALID");

		// And the ordinary A5 arm's bind, which `decideCohortBind` refuses for
		// the reason it always refused a grantless one: this is cohort mode.
		const ordinary = parseServerBindExecution({
			schema: "server-bind-execution/v1",
			sequence: 0,
			executionSha256: cohort.executionSha256,
			rigExecutionAcceptanceSha256: HEX("e"),
			cohortGrantBase64: null,
			cohortGrantSignatureBase64: null,
			macExecutionGrantReceiptBase64: "e30=",
			macExecutionGrantSignatureBase64: "e30=",
		});
		expect(ordinary.ok).toBe(true);
		if (!ordinary.ok) throw new Error("unreachable");
		const refused = decideCohortBind({
			bind: ordinary.value,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
		});
		expect(refused.ok).toBe(false);
		expect(refused.ok === false && refused.code).toBe("COHORT_NOT_READY");
	});

	test("the child binds only after the grant verifies, then answers ready and warmup-ready", async () => {
		const cohort = buildLinuxCohort();
		const epoch = bytesOfCanonical({
			schema: "cohort-warmup-epoch/v1",
			cohortGrantSha256: cohort.grantSha256,
			executionSha256: cohort.executionSha256,
		});
		const warmupStart = encodeChildPipeFrame({
			schema: "server-warmup-start/v1",
			sequence: 1,
			executionSha256: cohort.executionSha256,
			cohortWarmupEpochBase64: Buffer.from(epoch).toString("base64"),
			cohortWarmupEpochSignatureBase64: Buffer.from(
				bytesOfCanonical(
					signMacReceipt({
						privatePkcs8Der: cohort.mac.privatePkcs8Der,
						publicRaw32: cohort.mac.publicRaw32,
						signedSchema: "cohort-warmup-epoch/v1",
						signedBytes: epoch,
					}),
				),
			).toString("base64"),
		});
		if (!warmupStart.ok) throw new Error("warmup start frame");

		const pipe = memoryControlPipe([
			bindFrame({
				executionSha256: cohort.executionSha256,
				grantBytes: cohort.grantBytes,
				signature: cohort.grantSignature,
			}),
			warmupStart.value,
		]);
		const bound: CohortBindDecisionV1[] = [];
		const outcome = await runFanoutCohortServerChild({
			io: pipe.io,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
			bindListener: async (decision): Promise<CohortServerBinding> => {
				bound.push(decision);
				return {
					listeningAddress: "10.99.0.2:4433",
					childPid: 4242,
					childPgid: 4242,
					childInstanceNonce: HEX("a"),
					stop: () => {},
				};
			},
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(`child: ${outcome.code}`);
		expect(bound.length).toBe(1);
		expect(bound[0]?.cohortGrantSha256).toBe(cohort.grantSha256);

		expect(pipe.written.length).toBe(2);
		const ready = decodeChildPipeFrame(pipe.written[0] as Uint8Array);
		expect(ready.ok).toBe(true);
		if (!ready.ok) throw new Error("unreachable");
		expect(ready.value.schema).toBe("server-ready/v1");
		expect(ready.value.sequence).toBe(0);
		expect(ready.value.cohortGrantSha256).toBe(cohort.grantSha256);
		expect(ready.value.childPid).toBe(4242);
		expect(ready.value.listeningAddress).toBe("10.99.0.2:4433");

		const warmupReadyFrame = decodeChildPipeFrame(
			pipe.written[1] as Uint8Array,
		);
		expect(warmupReadyFrame.ok).toBe(true);
		if (!warmupReadyFrame.ok) throw new Error("unreachable");
		const warmupReady = parseServerWarmupReady(warmupReadyFrame.value);
		expect(warmupReady.ok).toBe(true);
		if (!warmupReady.ok) throw new Error("unreachable");
		expect(warmupReady.value.sequence).toBe(1);
		expect(warmupReady.value.warmupCountersZero).toBe(true);
		// The digest is over the epoch's exact bytes as they arrived; a
		// re-encode would name a record the child minted.
		expect(warmupReady.value.cohortWarmupEpochSha256).toBe(
			sha256HexOfBytes(epoch),
		);
		expect(outcome.value.warmupEpochSha256).toBe(sha256HexOfBytes(epoch));
	});

	test("a refused bind never reaches the listener, and a truncated pipe is EOF", async () => {
		const cohort = buildLinuxCohort();
		const foreign = generateEd25519KeyPair();
		const refused = memoryControlPipe([
			bindFrame({
				executionSha256: cohort.executionSha256,
				grantBytes: cohort.grantBytes,
				signature: signMacReceipt({
					privatePkcs8Der: foreign.privatePkcs8Der,
					publicRaw32: foreign.publicRaw32,
					signedSchema: "cohort-grant/v1",
					signedBytes: cohort.grantBytes,
				}),
			}),
		]);
		let bindCalls = 0;
		const outcome = await runFanoutCohortServerChild({
			io: refused.io,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
			bindListener: async () => {
				bindCalls += 1;
				throw new Error("a refused grant must not reach a listener");
			},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.code).toBe(
			"MAC_SIGNING_KEY_MISMATCH",
		);
		expect(bindCalls).toBe(0);
		expect(refused.written.length).toBe(0);

		// A pipe that ends before the bind frame is EOF, not a silent bind.
		const empty = memoryControlPipe([]);
		const eof = await runFanoutCohortServerChild({
			io: empty.io,
			stagedMacPublicRaw32: cohort.mac.publicRaw32,
			bindListener: async () => {
				throw new Error("unreachable");
			},
		});
		expect(eof.ok).toBe(false);
		expect(eof.ok === false && eof.code).toBe("UNEXPECTED_EOF");
	});
});

// ---------------------------------------------------------------------------
// The whole rig side, as processes: the real supervisor binary installs a
// production cohort runtime from its staged inputs, forks the real
// `server.ts --mode=fanout-cohort` child, and the two of them reach
// `server-warmup-ready/v1` over the real §3.3 and §3.4 codecs.
// ---------------------------------------------------------------------------

const RIG_E2E_TIMEOUT_MS = 900_000;
const REPO = resolve(import.meta.dir, "..", "..");

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The staged launch record's TLS material for the spawned server child. */
function selfSignedTls(dir: string): { cert: string; key: string } {
	const certPath = join(dir, "server.crt");
	const keyPath = join(dir, "server.key");
	const made = Bun.spawnSync({
		cmd: [
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"1",
			"-nodes",
			"-subj",
			"/CN=wt-compare.local",
			"-addext",
			"subjectAltName=DNS:wt-compare.local,IP:127.0.0.1",
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (made.exitCode !== 0) {
		throw new Error(`openssl failed: ${made.stderr.toString().slice(-500)}`);
	}
	return {
		cert: readFileSync(certPath, "utf8"),
		key: readFileSync(keyPath, "utf8"),
	};
}

describe("B3.5 e2e: the rig supervisor installs a cohort and spawns the real server child", () => {
	test(
		// Was, and becomes again once S8a sends §2.13's six keys:
		// "accept-cohort, spawn-server and warmup-ready over two real processes".
		"the four-key accept-cohort the production sender builds is refused by the real rig",
		async () => {
			// 1. The binaries the campaign actually ships.
			const built = Bun.spawnSync({
				cmd: [
					"cargo",
					"build",
					"-p",
					"native",
					"--release",
					"--bin",
					"comparison-supervisor",
					"--bin",
					"observe-directory-identity",
				],
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (built.exitCode !== 0) {
				throw new Error(
					`cargo build failed: ${built.stderr.toString().slice(-1500)}`,
				);
			}

			// 2. A trust bootstrap the real binary accepts, plus the staged Mac
			//    public key the cohort install reads out of the staging root.
			const boot = mkdtempSync(join(tmpdir(), "rig-cohort-e2e-"));
			// The rig's own §4.1 codec reads `lastSubscriberIndexExclusive` as the
			// global subscriber range each residue filters, which is why every
			// shard also carries `firstSubscriberIndex: 0`. The TS fixture writes
			// the shard's own membership count there instead. The rig is the
			// party that has to accept this grant, so the grant is shaped the way
			// the rig reads it; the divergence itself is recorded in the b35r2
			// rig-install notes.
			const base = buildLinuxCohort();
			const cohort = buildLinuxCohort(
				{
					subscriberShards: base.grant.subscriberShards.map((shard) => ({
						...shard,
						lastSubscriberIndexExclusive: base.grant.subscriberCount,
					})),
				},
				{ mac: base.mac },
			);
			// Before the mint, not after: APFS counts directory entries in a
			// directory's hard-link count, so a staged leaf added afterwards
			// moves the very identity the authority pins.
			mkdirSync(join(boot, "staging-root"), { recursive: true, mode: 0o700 });
			writeFileSync(
				join(boot, "staging-root", "mac-supervisor-ed25519.pub"),
				Buffer.from(cohort.mac.publicRaw32),
			);
			const minted = Bun.spawnSync({
				cmd: [
					"bun",
					join(REPO, "tools", "compare", "bin", "mint-live-trust-bootstrap.ts"),
					"--fixture-only",
					`--out=${boot}`,
				],
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OBSERVE_DIRECTORY_IDENTITY_BINARY: join(
						REPO,
						"target",
						"release",
						"observe-directory-identity",
					),
				},
			});
			if (minted.exitCode !== 0) {
				throw new Error(
					`mint failed: ${minted.stderr.toString().slice(-1500)}`,
				);
			}

			// 3. The two descriptors the cohort install needs beyond the
			//    bootstrap: the rig's own signing key and the role root.
			//
			//    §2.13 dropped the two per-execution acceptance descriptors --
			//    `rig-execution-acceptance/v1` and its signature now arrive on
			//    `rig-accept-cohort-request/v1` per execution, so there is no
			//    campaign-scoped file to open and no fd 8 or 9 to pass.
			//    `cohort_install_descriptors` resolves exactly two names
			//    (`crates/native/src/bin/comparison-supervisor.rs`).
			const keyPath = join(boot, "rig.pk8");
			writeFileSync(keyPath, Buffer.from(cohort.rig.privatePkcs8Der));

			// 4. Boot the supervisor exactly the way the rig wrapper does: every
			//    input on a descriptor the launcher opened, control on stdio.
			const binary = join(REPO, "target", "release", "comparison-supervisor");
			const roleRoot = join(REPO, "tools", "compare");
			const script = [
				"set -eu",
				`exec 3< <(cat -- ${shellQuote(join(boot, "authority.json"))})`,
				`exec 4<${shellQuote(join(boot, "authority-digest.bin"))}`,
				`exec 5<${shellQuote(join(boot, "campaign-root"))}`,
				`exec 6<${shellQuote(join(boot, "staging-root"))}`,
				`exec 7<${shellQuote(keyPath)}`,
				`exec 10<${shellQuote(roleRoot)}`,
				[
					`exec ${shellQuote(binary)}`,
					"--authority-fd 3",
					"--authority-digest-fd 4",
					"--campaign-root-fd 5",
					"--staging-root-fd 6",
					"--cohort-signing-key-fd 7",
					"--cohort-role-root-fd 10",
					"--control-in-fd 0",
					"--control-out-fd 1",
				].join(" "),
			].join("\n");
			const spawned: ReturnType<typeof nodeSpawn>[] = [];
			const bootSupervisor = () => {
				const proc = nodeSpawn("bash", ["-c", script], {
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						...process.env,
						COMPARISON_SUPERVISOR_BUN_PATH: process.execPath,
					},
				});
				spawned.push(proc);
				return proc;
			};

			try {
				// The production sender, unchanged, at the real rig.
				//
				// §2.13 widened `rig-accept-cohort-request/v1` from four keys to
				// six: the grant and its Mac signature, plus this execution's
				// Phase-A `rig-execution-acceptance/v1` and the rig signature
				// over it. The rig above reads that key set with `exact_fields`
				// (`RIG_ACCEPT_COHORT_FIELDS`, `crates/native/src/secure_fs.rs`).
				// `CohortRigChannel.acceptCohort` (`tools/compare/remote-supervisor.ts`)
				// still builds the four-key form, and `CohortRigChannelConfig`
				// carries no acceptance record and no signature over one, so the
				// sender has nothing to put in the two new fields.
				//
				// CLOSED BY: **S8a, wave 4**, which owns `remote-supervisor.ts`
				// and has to source the acceptance pair before it can send them.
				// `.scratch/b35r3-notes/w12-fixup.md` records exactly what that
				// slice must add. When it lands, this whole test goes back to
				// driving accept-cohort -> spawn-server -> warmup-ready over two
				// real processes, and the two assertions below are what will fail
				// to say so.
				const first = bootSupervisor();
				const channel = new CohortRigChannel({
					controllerToRig: first.stdin as never,
					rigToController: first.stdout as never,
					childDiagnostics: attachSupervisorChildDiagnostics(
						first as unknown as ChildProcessWithoutNullStreams,
					),
					executionSha256: cohort.executionSha256,
					stagedRigPublicRaw32: cohort.rig.publicRaw32,
					deadlines: {
						frameMs: 60_000,
						serverReadyMs: 120_000,
						warmupDrainMs: 60_000,
						captureMs: 60_000,
						teardownMs: 60_000,
					},
				});
				// §5 RIG_EXECUTION_ACCEPTED is the first frame on the channel now;
				// a rig with no cohort runtime refuses it with the same closed
				// code the cohort accept used to draw.
				const accepted = await channel.acceptExecution({
					measurementGrantBytes: new TextEncoder().encode("{}\n"),
					receiptBytes: new TextEncoder().encode("{}\n"),
					receiptSignatureBytes: new TextEncoder().encode("{}\n"),
				});
				expect(accepted.ok).toBe(false);
				if (accepted.ok) throw new Error("unreachable");
				// The §7 code the controller files the arm under -- and it is
				// now the rig's *own* code, carried verbatim. Before the
				// wave-3.5 gate mapped `CohortRefusal::code()` onto §7's closed
				// table the rig answered `TRUST_RECORD_MISSING_FIELD`, which is
				// a member of neither `CAMPAIGN_REFUSAL_CODES` nor
				// `CAMPAIGN_FAILURE_CODES`, so `parseRemoteSupervisorRefusal`
				// refused to carry it and the channel could only report
				// `COHORT_PROTOCOL` / "rig sent an unparsable refusal" -- a code
				// the rig never said. This assertion is what pins that closed.
				expect(accepted.code).toBe("TRUST_PROTOCOL");
				expect(accepted.message).not.toBe("rig sent an unparsable refusal");

				// And the rig's own frame, read directly, so the code S8a has to
				// make go away is pinned rather than described. A fresh process,
				// because §2.7 makes a refused cohort transition terminal: the
				// session above ended when that refusal was written.
				const second = bootSupervisor();
				const request = encodeRegisteredRemotePayload({
					schema: "rig-accept-cohort-request/v1",
					requestSeq: 1,
					executionSha256: cohort.executionSha256,
					cohortGrantBase64: Buffer.from(cohort.grantBytes).toString("base64"),
					cohortGrantSignatureBase64: Buffer.from(
						bytesOfCanonical(cohort.grantSignature),
					).toString("base64"),
				});
				expect(request.ok).toBe(true);
				if (!request.ok) throw new Error("unreachable");
				second.stdin?.write(Buffer.from(request.value));
				const answer = await new Promise<Buffer>((done) => {
					const chunks: Buffer[] = [];
					const timer = setTimeout(() => done(Buffer.concat(chunks)), 30_000);
					second.stdout?.on("data", (chunk: Buffer) =>
						chunks.push(Buffer.from(chunk)),
					);
					second.stdout?.on("end", () => {
						clearTimeout(timer);
						done(Buffer.concat(chunks));
					});
				});
				const refusal = decodeRemoteSupervisorPayload(new Uint8Array(answer));
				expect(refusal.ok).toBe(true);
				if (!refusal.ok) throw new Error("unreachable");
				expect(refusal.value.headerKind).toBe("remote-supervisor-refusal");
				expect(refusal.value.payload.schema).toBe(
					"remote-supervisor-refusal/v1",
				);
				// `exact_fields` against `RIG_ACCEPT_COHORT_FIELDS`: the six-key
				// set minus the two the sender does not have is a missing field,
				// not a malformed frame. When S8a sends the six, this becomes an
				// acceptance and this assertion is the one that says so.
				expect(refusal.value.payload.code).toBe("TRUST_PROTOCOL");
				expect(refusal.value.payload.campaignStatus).toBe("FAIL");
				expect(refusal.value.payload.terminal).toBe(true);
				expect(refusal.value.payload.ackRequestSeq).toBe(1);
			} finally {
				for (const proc of spawned) {
					proc.stdin?.end();
					proc.kill("SIGKILL");
				}
				rmSync(boot, { recursive: true, force: true });
			}
		},
		RIG_E2E_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// The conformance guard: one replacement scenario, two producers.
//
// `ScriptedMacCohortBinary` stands in for `comparison-supervisor` in every
// cheap test in this tree. Nothing held the two together on the one transition
// where they had drifted furthest apart: the fixture accepted an unbounded
// number of `mac-open-cohort-request/v1` frames per execution and incremented
// `cohortAttempt` on each, while the release binary refused the second outright
// ("one cohort per execution"). `pre_ready_replacement_mints_new_grant_nonce_
// and_tokens` therefore passed for years over a path production refuses -- a
// stand-in more permissive than the producer it stands in for.
//
// This drives the *same* frames, in the same order, at the scripted binary and
// at a real spawned release `comparison-supervisor`, and asserts the two answer
// vectors are equal. It is the guard that would have caught the original
// divergence, and it fails on any future one in either direction.
// ---------------------------------------------------------------------------

/** What one open-cohort frame drew, reduced to what conformance means. */
type MacReopenAnswer =
	/** `cohortAttempt` is null for a frame that is not an open. */
	| { readonly ok: true; readonly cohortAttempt: number | null }
	| { readonly ok: false; readonly code: string };

/** One conformance scenario: a name, and the cohort ids it opens in order. */
interface MacReopenScenario {
	readonly name: string;
	readonly cohortIds: readonly string[];
	/** Reach `past-readiness` on the binary's own evidence before the last open. */
	readonly readinessBeforeLastOpen?: boolean;
	/**
	 * After the last open, ask for the warmup epoch over a rig acceptance digest
	 * this session never retained. A replacement drops the retired session's rig
	 * retention, so this is the shape a controller that kept attempt 1's
	 * acceptance would put on the wire.
	 */
	readonly probeUnretainedAcceptance?: boolean;
}

const MAC_REOPEN_SCENARIOS: readonly MacReopenScenario[] = [
	// Plan 2210's bound: attempt 1, the one allowed replacement, and the second
	// replacement that is terminal.
	{ name: "bound", cohortIds: ["reopen-a", "reopen-b", "reopen-c"] },
	// "Reusing the old grant/token/nonce fails replay tests": the same cohort id
	// is the same manifest digest, the same root and the same leaf commitments.
	{ name: "reuse", cohortIds: ["reopen-a", "reopen-a"] },
	// "Before readiness": once the supervisor has minted a warmup epoch it knows
	// readiness happened, and no replacement is legal.
	{
		name: "past-readiness",
		cohortIds: ["reopen-a", "reopen-b"],
		readinessBeforeLastOpen: true,
	},
	// A replacement drops the retired session's rig retention, so the record the
	// next transition names is one this session never saw. Both producers must
	// say that, in the same closed code, rather than dying on a missing key.
	{
		name: "retention-dropped",
		cohortIds: ["reopen-a", "reopen-b"],
		probeUnretainedAcceptance: true,
	},
];

/** The cell both producers are driven at: the smallest fanout cohort there is. */
const MAC_REOPEN_CELL_ID = "ticker-fanout/rate-250";
const MAC_REOPEN_PUBLISHERS = 1;
const MAC_REOPEN_SUBSCRIBERS = 100;

/**
 * The workload role-plan input the release binary parses
 * (`canonical-workload-role-plan-input/v1`, `secure_fs.rs` `parse_workload_
 * role_plan_input`). The scripted binary does not read it, so one shape serves
 * both and the comparison is not weakened by feeding them different bytes.
 */
const MAC_REOPEN_WORKLOAD_BYTES = bytesOfCanonical({
	schema: "canonical-workload-role-plan-input/v1",
	scenarioPreimage: { cellId: MAC_REOPEN_CELL_ID },
	rolePlanPreimage: {
		publisherCount: MAC_REOPEN_PUBLISHERS,
		subscriberWorkerCount: COHORT_WORKER_COUNT,
		subscriberCount: MAC_REOPEN_SUBSCRIBERS,
	},
});

/** The one open-cohort frame, over freshly minted material for `cohortId`. */
function macReopenCohortRequest(
	executionSha256: string,
	cohortId: string,
	scenarioHash: string,
	rolePlanHash: string,
): Record<string, unknown> & { readonly schema: string } {
	const tokens = buildFanoutCohortFixture({
		cohortId,
		publisherCount: MAC_REOPEN_PUBLISHERS,
		subscriberCount: MAC_REOPEN_SUBSCRIBERS,
	});
	const leafManifest = bytesOfCanonical({
		schema: "token-commitment-leaf-manifest/v1",
		executionSha256,
		cohortId,
		leafCount: tokens.leaves.length,
		leaves: [...tokens.leaves],
		roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
	});
	return {
		schema: "mac-open-cohort-request/v1",
		executionSha256,
		scenarioHash,
		rolePlanHash,
		workloadRolePlanInputBase64: Buffer.from(
			MAC_REOPEN_WORKLOAD_BYTES,
		).toString("base64"),
		workloadRolePlanInputSha256: sha256HexOfBytes(MAC_REOPEN_WORKLOAD_BYTES),
		workloadRolePlanInputSize: MAC_REOPEN_WORKLOAD_BYTES.byteLength,
		tokenCommitmentLeafManifestBase64:
			Buffer.from(leafManifest).toString("base64"),
		tokenCommitmentLeafManifestSha256: sha256HexOfBytes(leafManifest),
		publishersBase64: Buffer.from(bytesOfCanonical(tokens.publishers)).toString(
			"base64",
		),
		subscriberShardsBase64: Buffer.from(
			bytesOfCanonical(tokens.subscriberShards),
		).toString("base64"),
	};
}

/**
 * Drive one scenario over an already-opened execution channel and reduce every
 * answer to `MacReopenAnswer`.
 *
 * The readiness leg mints nothing of its own: it presents a rig acceptance the
 * caller signed under the staged rig key and asks for the warmup epoch, which
 * is the first thing either producer does on its own evidence that readiness
 * happened.
 */
async function driveMacReopenScenario(args: {
	readonly channel: MacCohortChannel;
	readonly executionSha256: string;
	readonly scenario: MacReopenScenario;
	readonly scenarioHash: string;
	readonly rolePlanHash: string;
	readonly rigKeys: Ed25519KeyPairBytes;
	readonly nowMs: number;
}): Promise<readonly MacReopenAnswer[]> {
	const answers: MacReopenAnswer[] = [];
	let lastGrantSha256: string | null = null;
	let lastGrantSignatureSha256: string | null = null;
	for (const [index, cohortId] of args.scenario.cohortIds.entries()) {
		const isLast = index === args.scenario.cohortIds.length - 1;
		if (
			args.scenario.readinessBeforeLastOpen === true &&
			isLast &&
			lastGrantSha256 !== null &&
			lastGrantSignatureSha256 !== null
		) {
			const acceptanceBytes = bytesOfCanonical({
				schema: "rig-cohort-acceptance/v1",
				executionSha256: args.executionSha256,
				cohortGrantSha256: lastGrantSha256,
				cohortGrantSignatureSha256: lastGrantSignatureSha256,
				roleTokenCommitmentRootSha256: HEX("3"),
				approvedPlanSha256: HEX("e"),
				approvalRecordSha256: HEX("f"),
				rigExecutionIndex: 0,
				rigSupervisorInstanceNonce: HEX("4"),
				signingPublicKeySha256: sha256HexOfBytes(args.rigKeys.publicRaw32),
				receiptSequence: 1,
				acceptedAtMs: args.nowMs,
				issuedAtMs: args.nowMs,
				notAfterMs: args.nowMs + 600_000,
			});
			const acceptanceSignatureBytes = bytesOfCanonical(
				signRigReceipt({
					privatePkcs8Der: args.rigKeys.privatePkcs8Der,
					publicRaw32: args.rigKeys.publicRaw32,
					signedSchema: "rig-cohort-acceptance/v1",
					signedBytes: acceptanceBytes,
				}),
			);
			const presented = await args.channel.request(
				{
					schema: "mac-present-rig-cohort-acceptance-request/v1",
					executionSha256: args.executionSha256,
					rigCohortAcceptanceBase64:
						Buffer.from(acceptanceBytes).toString("base64"),
					rigCohortAcceptanceSignatureBase64: Buffer.from(
						acceptanceSignatureBytes,
					).toString("base64"),
				},
				"mac-rig-cohort-acceptance-ack/v1",
			);
			if (!presented.ok) {
				throw new Error(
					`readiness leg: acceptance ${presented.code} ${presented.message}`,
				);
			}
			const epoch = await args.channel.request(
				{
					schema: "mac-issue-warmup-epoch-request/v1",
					executionSha256: args.executionSha256,
					cohortGrantSha256: lastGrantSha256,
					rigCohortAcceptanceSha256: sha256HexOfBytes(acceptanceBytes),
				},
				"mac-warmup-epoch-issued-ack/v1",
			);
			if (!epoch.ok) {
				throw new Error(
					`readiness leg: warmup epoch ${epoch.code} ${epoch.message}`,
				);
			}
		}
		const answered = await args.channel.request<MacCohortOpenedAckV1>(
			macReopenCohortRequest(
				args.executionSha256,
				cohortId,
				args.scenarioHash,
				args.rolePlanHash,
			),
			"mac-cohort-opened-ack/v1",
		);
		if (!answered.ok) {
			answers.push({ ok: false, code: answered.code });
			// Both producers make a refusal terminal for the channel, so the
			// scenario is over the moment one refuses.
			break;
		}
		const ack = answered.value.ack;
		lastGrantSha256 = ack.cohortGrantSha256;
		lastGrantSignatureSha256 = sha256HexOfBytes(
			Buffer.from(ack.cohortGrantSignatureBase64, "base64"),
		);
		const grant = JSON.parse(
			Buffer.from(ack.cohortGrantBase64, "base64").toString("utf8"),
		) as { readonly cohortAttempt: number };
		answers.push({ ok: true, cohortAttempt: grant.cohortAttempt });
	}
	if (
		args.scenario.probeUnretainedAcceptance === true &&
		lastGrantSha256 !== null
	) {
		const epoch = await args.channel.request(
			{
				schema: "mac-issue-warmup-epoch-request/v1",
				executionSha256: args.executionSha256,
				cohortGrantSha256: lastGrantSha256,
				rigCohortAcceptanceSha256: HEX("9"),
			},
			"mac-warmup-epoch-issued-ack/v1",
		);
		answers.push(
			epoch.ok
				? { ok: true, cohortAttempt: null }
				: { ok: false, code: epoch.code },
		);
	}
	return answers;
}

/** The draft both producers open the execution from. */
function macReopenDraft(args: {
	readonly authoritySha256: string;
	readonly campaignLockSha256: string;
	readonly stagedCapabilitySha256: string;
	readonly sourceArchiveSha256: string;
	readonly approvedPlanSha256: string;
	readonly approvalRecordSha256: string;
	readonly candidate: string;
	readonly campaignId: string;
	readonly scenarioHash: string;
	readonly rolePlanHash: string;
}): Uint8Array {
	return bytesOfCanonical({
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: args.authoritySha256,
		campaignLockSha256: args.campaignLockSha256,
		stagedCapabilitySha256: args.stagedCapabilitySha256,
		sourceArchiveSha256: args.sourceArchiveSha256,
		approvedPlanSha256: args.approvedPlanSha256,
		approvalRecordSha256: args.approvalRecordSha256,
		candidate: args.candidate,
		campaignId: args.campaignId,
		runId: `${args.campaignId}/ticker-fanout/ws/measured-1`,
		executionPurpose: "focused",
		cellId: MAC_REOPEN_CELL_ID,
		scenarioHash: args.scenarioHash,
		rolePlanHash: args.rolePlanHash,
		workloadRolePlanInputSha256: sha256HexOfBytes(MAC_REOPEN_WORKLOAD_BYTES),
		stagedServerLaunchRecordSha256: HEX("7"),
		armKind: "primary",
		transport: "ws",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		grantDeclaration: "fanout-expanded-deliveries",
		declaredMessageCount: 250_000,
		declaredMessageBytes: 100,
		requestedNotAfterMs: 17_000_000_000_000,
	});
}

describe("B3.5 conformance: the scripted Mac binary answers a cohort re-open as the release binary does", () => {
	test(
		"a_cohort_re_open_is_answered_identically_by_the_scripted_and_the_release_binary",
		async () => {
			// 1. The binary the campaign ships.
			const built = Bun.spawnSync({
				cmd: [
					"cargo",
					"build",
					"-p",
					"native",
					"--release",
					"--bin",
					"comparison-supervisor",
					"--bin",
					"observe-directory-identity",
				],
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (built.exitCode !== 0) {
				throw new Error(
					`cargo build failed: ${built.stderr.toString().slice(-1500)}`,
				);
			}

			// 2. A trust bootstrap the real binary accepts. Every digest the
			//    draft states about the campaign is read back out of it: the
			//    binary compares all eight and refuses on any one
			//    (`ExecutionAuthority::validate`, `bin/comparison-supervisor.rs`).
			const boot = mkdtempSync(join(tmpdir(), "mac-reopen-conformance-"));
			const spawned: ReturnType<typeof nodeSpawn>[] = [];
			try {
				const minted = Bun.spawnSync({
					cmd: [
						"bun",
						join(
							REPO,
							"tools",
							"compare",
							"bin",
							"mint-live-trust-bootstrap.ts",
						),
						"--fixture-only",
						`--out=${boot}`,
					],
					cwd: REPO,
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						OBSERVE_DIRECTORY_IDENTITY_BINARY: join(
							REPO,
							"target",
							"release",
							"observe-directory-identity",
						),
					},
				});
				if (minted.exitCode !== 0) {
					throw new Error(
						`mint failed: ${minted.stderr.toString().slice(-1500)}`,
					);
				}
				const authorityBytes = readFileSync(join(boot, "authority.json"));
				const authority = JSON.parse(authorityBytes.toString("utf8")) as {
					readonly approval: {
						readonly approvedPlanSha256: string;
						readonly approvalRecordSha256: string;
					};
					readonly campaignId: string;
					readonly candidate: string;
					readonly source: { readonly archiveSha256: string };
				};
				const scenarioHash = HEX("5");
				const rolePlanHash = HEX("6");
				const draftBytes = macReopenDraft({
					authoritySha256: sha256HexOfBytes(new Uint8Array(authorityBytes)),
					campaignLockSha256: sha256HexOfBytes(
						new Uint8Array(
							readFileSync(join(boot, "campaign-root", "campaign-lock.json")),
						),
					),
					stagedCapabilitySha256: sha256HexOfBytes(
						new Uint8Array(
							readFileSync(
								join(boot, "staging-root", "staged-capability.json"),
							),
						),
					),
					sourceArchiveSha256: authority.source.archiveSha256,
					approvedPlanSha256: authority.approval.approvedPlanSha256,
					approvalRecordSha256: authority.approval.approvalRecordSha256,
					candidate: authority.candidate,
					campaignId: authority.campaignId,
					scenarioHash,
					rolePlanHash,
				});

				// 3. One release process per scenario: a Mac refusal is terminal
				//    for the channel, so a scenario that ends in one cannot be
				//    followed by another on the same channel.
				const macKeys = generateEd25519KeyPair();
				const rigKeys = generateEd25519KeyPair();
				const macKeyPath = join(boot, "mac-signing.pk8");
				const rigPublicPath = join(boot, "staged-rig.pub");
				writeFileSync(macKeyPath, Buffer.from(macKeys.privatePkcs8Der));
				writeFileSync(rigPublicPath, Buffer.from(rigKeys.publicRaw32));
				const binary = join(REPO, "target", "release", "comparison-supervisor");
				const script = [
					"set -eu",
					"export WS_WT_COHORT_RECEIPT_VALIDITY_MS=600000",
					`exec 3< <(cat -- ${shellQuote(join(boot, "authority.json"))})`,
					`exec 4<${shellQuote(join(boot, "authority-digest.bin"))}`,
					`exec 5<${shellQuote(join(boot, "campaign-root"))}`,
					`exec 6<${shellQuote(join(boot, "staging-root"))}`,
					`exec 7<${shellQuote(macKeyPath)}`,
					`exec 8<${shellQuote(rigPublicPath)}`,
					[
						`exec ${shellQuote(binary)}`,
						"--authority-fd 3",
						"--authority-digest-fd 4",
						"--campaign-root-fd 5",
						"--staging-root-fd 6",
						"--cohort-mac-signing-key-fd 7",
						"--cohort-staged-rig-public-key-fd 8",
						"--control-in-fd 0",
						"--control-out-fd 1",
					].join(" "),
				].join("\n");

				const releaseAnswers = new Map<string, readonly MacReopenAnswer[]>();
				const scriptedAnswers = new Map<string, readonly MacReopenAnswer[]>();
				for (const scenario of MAC_REOPEN_SCENARIOS) {
					const proc = nodeSpawn("bash", ["-c", script], {
						stdio: ["pipe", "pipe", "pipe"],
						env: {
							...process.env,
							COMPARISON_SUPERVISOR_BUN_PATH: process.execPath,
						},
					});
					spawned.push(proc);
					const channel = new MacCohortChannel({
						controllerToMac: proc.stdin as never,
						macToController: proc.stdout as never,
						childDiagnostics: attachSupervisorChildDiagnostics(
							proc as unknown as ChildProcessWithoutNullStreams,
						),
						stagedMacPublicRaw32: macKeys.publicRaw32,
						deadlineMs: 60_000,
					});
					const opened = await channel.openExecution(draftBytes);
					if (!opened.ok) {
						throw new Error(
							`release openExecution: ${opened.code} ${opened.message}`,
						);
					}
					releaseAnswers.set(
						scenario.name,
						await driveMacReopenScenario({
							channel,
							executionSha256: opened.value.executionSha256,
							scenario,
							scenarioHash,
							rolePlanHash,
							rigKeys,
							nowMs: Date.now(),
						}),
					);
				}

				// 4. The same scenarios at the stand-in, over a real pipe pair and
				//    the same production channel.
				for (const scenario of MAC_REOPEN_SCENARIOS) {
					const scriptedMacKeys = generateEd25519KeyPair();
					const scriptedRigKeys = generateEd25519KeyPair();
					const scripted = new ScriptedMacCohortBinary({
						keys: scriptedMacKeys,
						stagedRigPublicRaw32: scriptedRigKeys.publicRaw32,
						clock: { nowMs: () => MAC_NOW_MS, nowNs: () => "1000000000" },
						receiptValidityMs: MAC_VALIDITY_MS,
						macClockId: MAC_CLOCK_ID,
						instanceNonce: MAC_INSTANCE_NONCE,
						executableSha256: HEX("b"),
						grant: {
							transport: "ws",
							readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
							measuredDurationMs: 10_000,
							messageBytes: MESSAGE_BYTES,
							expectedOfferedIngress: MAC_MEASURED_FRAMES,
						},
					});
					const wire = serveScriptedMac(scripted.respond);
					const channel = new MacCohortChannel({
						controllerToMac: wire.controllerToMac,
						macToController: wire.macToController,
						childDiagnostics: undefined,
						stagedMacPublicRaw32: scriptedMacKeys.publicRaw32,
						deadlineMs: 10_000,
					});
					const opened = await channel.openExecution(draftBytes);
					if (!opened.ok) {
						throw new Error(
							`scripted openExecution: ${opened.code} ${opened.message}`,
						);
					}
					scriptedAnswers.set(
						scenario.name,
						await driveMacReopenScenario({
							channel,
							executionSha256: opened.value.executionSha256,
							scenario,
							scenarioHash,
							rolePlanHash,
							rigKeys: scriptedRigKeys,
							nowMs: MAC_NOW_MS,
						}),
					);
				}

				// 5. The whole point: identical answers, scenario by scenario.
				for (const scenario of MAC_REOPEN_SCENARIOS) {
					expect(scriptedAnswers.get(scenario.name)).toEqual(
						releaseAnswers.get(scenario.name) as MacReopenAnswer[],
					);
				}

				// And what those answers are, stated once so a future change to
				// *both* producers cannot pass this test by moving together away
				// from plan 2210.
				expect(releaseAnswers.get("bound")).toEqual([
					{ ok: true, cohortAttempt: 1 },
					{ ok: true, cohortAttempt: 2 },
					{ ok: false, code: "COHORT_PROTOCOL" },
				]);
				expect(releaseAnswers.get("reuse")).toEqual([
					{ ok: true, cohortAttempt: 1 },
					{ ok: false, code: "COHORT_PROTOCOL" },
				]);
				expect(releaseAnswers.get("past-readiness")).toEqual([
					{ ok: true, cohortAttempt: 1 },
					{ ok: false, code: "COHORT_PROTOCOL" },
				]);
				expect(releaseAnswers.get("retention-dropped")).toEqual([
					{ ok: true, cohortAttempt: 1 },
					{ ok: true, cohortAttempt: 2 },
					{ ok: false, code: "CROSS_SUPERVISOR_MISMATCH" },
				]);
			} finally {
				for (const proc of spawned) {
					proc.stdin?.end();
					proc.kill("SIGKILL");
				}
				rmSync(boot, { recursive: true, force: true });
			}
		},
		RIG_E2E_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// A5 e2e: the ordinary arm's signed server lifecycle, as processes.
//
// Amendment C4 line 76: "Ordinary A5 traffic must also follow the base plan's
// signed server lifecycle." The fifth live A5 run failed every arm on
// `rig server spawn (COHORT_NOT_READY)` -- the spawn had been rewired through
// the supervisor channel and the ordinary arm had no legal sender on it. What
// closes that is not a shape check: it is this, the real release
// `comparison-supervisor` forking the real `server.ts --mode=bulk-source`
// child, serving the registered 100 MiB transfer over the staged TLS identity,
// signing a capture over what its own child observed, and reaping the process
// group it forked.
// ---------------------------------------------------------------------------

/**
 * A port the kernel just said was free.
 *
 * The launch record states the port and the client connects to it, so it
 * cannot be an ephemeral bind; asking for one and releasing it is the closest
 * thing to not colliding with whatever else this box is running.
 */
function freeLoopbackPort(): number {
	const probe = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const port = probe.port;
	probe.stop(true);
	return port;
}

describe("A5 e2e: the real rig runs the ordinary arm's signed server lifecycle", () => {
	test(
		"spawns the real bulk-source child, serves the registered transfer, captures and reaps it",
		async () => {
			const built = Bun.spawnSync({
				cmd: [
					"cargo",
					"build",
					"-p",
					"native",
					"--release",
					"--bin",
					"comparison-supervisor",
					"--bin",
					"observe-directory-identity",
				],
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (built.exitCode !== 0) {
				throw new Error(
					`cargo build failed: ${built.stderr.toString().slice(-1500)}`,
				);
			}

			const a5Port = freeLoopbackPort();
			const mac = generateEd25519KeyPair();
			const rigKeys = generateEd25519KeyPair();
			const boot = mkdtempSync(join(tmpdir(), "a5-ordinary-e2e-"));
			const stagingRoot = join(boot, "staging-root");
			mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
			// Everything the staging root will ever hold goes in before the
			// mint: APFS counts directory entries in the link count, so a leaf
			// added afterwards moves the identity the authority pins.
			writeFileSync(
				join(stagingRoot, "mac-supervisor-ed25519.pub"),
				Buffer.from(mac.publicRaw32),
			);
			const tls = selfSignedTls(boot);
			writeFileSync(join(stagingRoot, "staged-server-tls.crt"), tls.cert);
			writeFileSync(join(stagingRoot, "staged-server-tls.key"), tls.key);

			// The staged launch record the rig will exec against: the real
			// entrypoint digest, the real Bun, the real TLS leaves, and the
			// `local-acceptance` profile, whose one host is loopback.
			const roleRoot = join(REPO, "tools", "compare");
			const entrypointSha256 = sha256HexOfBytes(
				new Uint8Array(readFileSync(join(roleRoot, "server.ts"))),
			);
			const launchRecord = buildStagedServerLaunchRecord({
				profile: "local-acceptance",
				transport: "ws",
				mode: "bulk-source",
				serverEntrypointSha256: entrypointSha256,
				bunSha256: HEX("b"),
				addonSha256: HEX("a"),
				bindPort: a5Port,
				tlsCertificateSha256: sha256HexOfBytes(
					new Uint8Array(Buffer.from(tls.cert)),
				),
				tlsPrivateKeySha256: sha256HexOfBytes(
					new Uint8Array(Buffer.from(tls.key)),
				),
			}) as unknown as StagedServerLaunchRecordV1;
			const launchRecordBytes = bytesOfCanonical(launchRecord);
			writeFileSync(
				join(stagingRoot, stagedServerLaunchRecordLeaf("ws", "bulk-source")),
				Buffer.from(launchRecordBytes),
			);

			const minted = Bun.spawnSync({
				cmd: [
					"bun",
					join(REPO, "tools", "compare", "bin", "mint-live-trust-bootstrap.ts"),
					"--fixture-only",
					`--out=${boot}`,
				],
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OBSERVE_DIRECTORY_IDENTITY_BINARY: join(
						REPO,
						"target",
						"release",
						"observe-directory-identity",
					),
				},
			});
			if (minted.exitCode !== 0) {
				throw new Error(
					`mint failed: ${minted.stderr.toString().slice(-1500)}`,
				);
			}

			// The Mac half: a signed execution whose `execution` is what the
			// child reads its cell, scenario hash and repetition identity off.
			const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
				(candidate) => candidate.cellId === "bulk-one-way/physical",
			);
			if (cell === undefined) throw new Error("no bulk-one-way/physical cell");
			const issuedAtMs = Date.now();
			const notAfterMs = issuedAtMs + 900_000;
			const draft: CrossSupervisorExecutionDraftV1 = {
				schema: "cross-supervisor-execution-draft/v1",
				authoritySha256: HEX("1"),
				campaignLockSha256: HEX("2"),
				stagedCapabilitySha256: HEX("3"),
				sourceArchiveSha256: HEX("4"),
				approvedPlanSha256: HEX("5"),
				approvalRecordSha256: HEX("6"),
				candidate: "a5-ordinary",
				campaignId: "a5-ordinary-campaign",
				runId: "a5-ordinary-campaign/bulk-one-way/physical/ws/measured-1",
				executionPurpose: "focused",
				cellId: cell.cellId,
				scenarioHash: cell.scenarioHash,
				rolePlanHash: HEX("7"),
				workloadRolePlanInputSha256: HEX("8"),
				stagedServerLaunchRecordSha256: sha256HexOfBytes(launchRecordBytes),
				armKind: "primary",
				transport: "ws",
				repetitionKind: "measured",
				repetitionIndex: 1,
				repetitionTotal: 1,
				grantDeclaration: "phase-a-completed-transfer",
				declaredMessageCount: 1_600,
				declaredMessageBytes: 104_857_600,
				requestedNotAfterMs: notAfterMs,
			};
			const constructed = macConstructFinalExecution({
				draft,
				executionIndex: 1,
				macSupervisorInstanceNonce: HEX("9"),
				issuedAtMs,
				notAfterMs,
				grantNonceSha256: HEX("c"),
			});
			if (!constructed.ok) throw new Error(`execution: ${constructed.code}`);
			const macReceipt = {
				schema: "mac-execution-grant-receipt/v1" as const,
				execution: constructed.value.execution,
				executionSha256: constructed.value.executionSha256,
				measurementGrantSha256: constructed.value.grantSha256,
				approvedPlanSha256: draft.approvedPlanSha256,
				approvalRecordSha256: draft.approvalRecordSha256,
				macSupervisorExecutableSha256: HEX("d"),
				macSupervisorInstanceNonce: HEX("9"),
				signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
				receiptSequence: 0,
				issuedAtMs,
				notAfterMs,
			};
			const macReceiptBytes = bytesOfCanonical(macReceipt);
			const macReceiptSignature = signMacReceipt({
				privatePkcs8Der: mac.privatePkcs8Der,
				publicRaw32: mac.publicRaw32,
				signedSchema: "mac-execution-grant-receipt/v1",
				signedBytes: macReceiptBytes,
			});

			const keyPath = join(boot, "rig.pk8");
			writeFileSync(keyPath, Buffer.from(rigKeys.privatePkcs8Der));
			const binary = join(REPO, "target", "release", "comparison-supervisor");
			const script = [
				"set -eu",
				`exec 3< <(cat -- ${shellQuote(join(boot, "authority.json"))})`,
				`exec 4<${shellQuote(join(boot, "authority-digest.bin"))}`,
				`exec 5<${shellQuote(join(boot, "campaign-root"))}`,
				`exec 6<${shellQuote(stagingRoot)}`,
				`exec 7<${shellQuote(keyPath)}`,
				`exec 10<${shellQuote(roleRoot)}`,
				[
					`exec ${shellQuote(binary)}`,
					"--authority-fd 3",
					"--authority-digest-fd 4",
					"--campaign-root-fd 5",
					"--staging-root-fd 6",
					"--cohort-signing-key-fd 7",
					"--cohort-role-root-fd 10",
					"--control-in-fd 0",
					"--control-out-fd 1",
				].join(" "),
			].join("\n");
			const rig = nodeSpawn("bash", ["-c", script], {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					COMPARISON_SUPERVISOR_BUN_PATH: process.execPath,
				},
			});
			const rigStderr: string[] = [];
			rig.stderr.on("data", (chunk: Buffer) => {
				rigStderr.push(chunk.toString());
			});

			let childPgid: number | null = null;
			try {
				const channel = new CohortRigChannel({
					controllerToRig: rig.stdin as never,
					rigToController: rig.stdout as never,
					childDiagnostics: attachSupervisorChildDiagnostics(
						rig as unknown as ChildProcessWithoutNullStreams,
					),
					executionSha256: constructed.value.executionSha256,
					stagedRigPublicRaw32: rigKeys.publicRaw32,
					deadlines: {
						frameMs: 60_000,
						serverReadyMs: 180_000,
						warmupDrainMs: 60_000,
						captureMs: 300_000,
						teardownMs: 60_000,
					},
				});

				// §5 RIG_EXECUTION_ACCEPTED, against the real binary.
				const accepted = await channel.acceptExecution({
					measurementGrantBytes: bytesOfCanonical(constructed.value.grant),
					receiptBytes: macReceiptBytes,
					receiptSignatureBytes: bytesOfCanonical(macReceiptSignature),
				});
				if (!accepted.ok) {
					throw new Error(
						`acceptExecution: ${accepted.code}: ${accepted.message}\n${rigStderr.join("")}`,
					);
				}
				expect(channel.stage).toBe("execution-accepted");

				// §5 SERVER_READY: the real fork. `childPid` is a process this
				// test can look for, which is what makes the reap below a
				// measurement rather than a claim.
				const spawned = await channel.spawnServer({
					cohortGrantSha256: null,
					serverEntrypointSha256: entrypointSha256,
					bunSha256: HEX("b"),
					addonSha256: HEX("a"),
					stagedServerLaunchRecordBytes: launchRecordBytes,
					bindPort: a5Port,
					transport: "ws",
					serverArgv: [...launchRecord.argv],
				});
				if (!spawned.ok) {
					throw new Error(
						`spawnServer: ${spawned.code}: ${spawned.message}\n${rigStderr.join("")}`,
					);
				}
				const childPid = spawned.value.childPid;
				childPgid = spawned.value.childPgid;
				expect(childPid).toBeGreaterThan(1);
				expect(childPgid).toBe(childPid);
				// The child is alive: signal 0 probes without delivering.
				expect(() => process.kill(childPid, 0)).not.toThrow();
				// And it is listening where the *signed launch record* says, not
				// on every interface. `listeningAddress` on `server-ready/v1` is
				// built from the bind address the record froze, so a child that
				// reported it while binding the wildcard would be stating an
				// endpoint it does not have -- and on the physical rig that
				// wildcard is the cable address.
				const listening = Bun.spawnSync({
					cmd: [
						"lsof",
						"-nP",
						"-a",
						"-p",
						String(childPid),
						"-iTCP",
						"-sTCP:LISTEN",
					],
				})
					.stdout.toString()
					.split("\n")
					.filter((line) => line.includes("(LISTEN)"));
				expect(listening.length).toBe(1);
				expect(listening[0]).toContain(`127.0.0.1:${a5Port}`);

				// §5 LINUX_BASELINE, before any measured byte crosses.
				const baseline = await channel.measureStart({
					warmupCompleteSha256: null,
					rigWarmupDrainedReceiptSha256: null,
				});
				if (!baseline.ok) {
					throw new Error(
						`measureStart: ${baseline.code}: ${baseline.message}\n${rigStderr.join("")}`,
					);
				}
				const baselineRecord = JSON.parse(
					Buffer.from(baseline.value.ackBytes).toString("utf8"),
				) as Record<string, unknown>;
				expect(baselineRecord.warmupCompletionAuthoritySha256).toBeNull();
				expect(baselineRecord.rigWarmupDrainedReceiptSha256).toBeNull();

				// The measured leg: the registered 100 MiB transfer, over the
				// staged TLS identity, from the child the rig forked.
				const adapter = createWebSocketAdapter();
				const session = await adapter.connect({
					url: `wss://127.0.0.1:${a5Port}`,
					role: "sink",
					deadlineMs: Date.now() + 60_000,
					tls: {
						ca: tls.cert,
						serverName: "wt-compare.local",
						rejectUnauthorized: true,
					},
				});
				const uni = await session.acceptUni(Date.now() + 60_000);
				let received = 0;
				for (;;) {
					const chunk = await uni.read(Date.now() + 120_000);
					if (chunk === null) break;
					received += chunk.byteLength;
				}
				expect(received).toBe(104_857_600);
				await session.close(Date.now() + 10_000);

				// §5 LINUX_CAPTURE: the rig signs a snapshot over what its own
				// child observed, and the child states what it actually wrote.
				const captured = await channel.stopAndCapture({
					macStopIssuedAtNs: `${process.hrtime.bigint()}`,
					drainDeadlineMs: 60_000,
				});
				if (!captured.ok) {
					throw new Error(
						`stopAndCapture: ${captured.code}: ${captured.message}\n${rigStderr.join("")}`,
					);
				}
				const frame = JSON.parse(
					Buffer.from(captured.value.snapshotFrameBytes).toString("utf8"),
				) as Record<string, unknown>;
				expect(frame.schema).toBe("server-loop-utilization/v1");
				expect(frame.cohortGrantSha256).toBeNull();
				expect(frame.cohortStartBarrierSha256).toBeNull();
				expect(frame.roleTokenCommitmentRootSha256).toBeNull();
				// The five identity fields come off the signed execution the
				// bind authenticated, not from anything the child chose.
				expect(frame.cellId).toBe(cell.cellId);
				expect(frame.scenarioHash).toBe(cell.scenarioHash);
				expect(frame.repetitionKind).toBe("measured");
				expect(frame.repetitionIndex).toBe(1);
				expect(frame.repetitionTotal).toBe(1);
				expect(frame.childPid).toBe(childPid);
				const completion = frame.bulkSourceCompletion as Record<
					string,
					unknown
				>;
				expect(completion.bytesWritten).toBe(104_857_600);
				expect(completion.chunksWritten).toBe(1_600);
				expect(completion.channelEnded).toBe(true);
				// The receipt is the rig's own signature over those bytes.
				const receipt = JSON.parse(
					Buffer.from(captured.value.snapshotReceiptBytes).toString("utf8"),
				) as Record<string, unknown>;
				expect(receipt.schema).toBe("rig-server-snapshot-receipt/v1");
				expect(receipt.snapshotFrameSha256).toBe(
					sha256HexOfBytes(captured.value.snapshotFrameBytes),
				);
				expect(receipt.cohortGrantSha256).toBeNull();
				expect(receipt.serverEntrypointSha256).toBe(entrypointSha256);

				// §5 TEARDOWN: `reaped` is a verdict, and this is what it is a
				// verdict about.
				const stopped = await channel.teardownServer();
				if (!stopped.ok) {
					throw new Error(
						`teardownServer: ${stopped.code}: ${stopped.message}\n${rigStderr.join("")}`,
					);
				}
				expect(stopped.value.exitCode).toBe(0);
				let alive = true;
				for (let attempt = 0; attempt < 100 && alive; attempt++) {
					try {
						process.kill(childPid, 0);
						await new Promise((resolve) => setTimeout(resolve, 50));
					} catch {
						alive = false;
					}
				}
				expect(alive).toBe(false);
			} finally {
				// The rig's child leads its own process group; killing only the
				// rig would orphan a listener on `a5Port`.
				if (childPgid !== null) {
					try {
						process.kill(-childPgid, "SIGKILL");
					} catch {
						// Already reaped by the teardown above.
					}
				}
				rig.kill("SIGKILL");
				rmSync(boot, { recursive: true, force: true });
			}
		},
		RIG_E2E_TIMEOUT_MS,
	);

	// The live A5 failure, in the one shape a local run can hold it.
	//
	// On the rig the staged TLS private key is laid by `install-minted`, which
	// runs as the ssh *staging* account, while the supervisor that reads the
	// leaf at every spawn runs as `_wtcompare`: a key at 0600 owned by the
	// stager is EACCES to the reader, and `child_environment` refuses
	// `NotReady("staged tls leaf")` from inside the spawner -- published as
	// `COHORT_NOT_READY`, the same code a wrong stage and a missing session
	// publish, which is why six staged runs said only the code.
	//
	// A local test has one account, so the unreadable leaf is made unreadable
	// the only other way: mode 0. The guard, the refusal and the detail on the
	// wire are the same ones the rig produced.
	test(
		"refuses the ordinary spawn with the leaf it could not read, and forks nothing",
		async () => {
			if (process.getuid?.() === 0) {
				throw new Error(
					"this test distinguishes a readable staged key from an unreadable one; root reads both",
				);
			}
			const built = Bun.spawnSync({
				cmd: [
					"cargo",
					"build",
					"-p",
					"native",
					"--release",
					"--bin",
					"comparison-supervisor",
					"--bin",
					"observe-directory-identity",
				],
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (built.exitCode !== 0) {
				throw new Error(
					`cargo build failed: ${built.stderr.toString().slice(-1500)}`,
				);
			}
			const a5Port = freeLoopbackPort();
			const mac = generateEd25519KeyPair();
			const rigKeys = generateEd25519KeyPair();
			const boot = mkdtempSync(join(tmpdir(), "a5-tls-leaf-"));
			const stagingRoot = join(boot, "staging-root");
			mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(stagingRoot, "mac-supervisor-ed25519.pub"),
				Buffer.from(mac.publicRaw32),
			);
			const tls = selfSignedTls(boot);
			writeFileSync(join(stagingRoot, "staged-server-tls.crt"), tls.cert);
			writeFileSync(join(stagingRoot, "staged-server-tls.key"), tls.key);

			const roleRoot = join(REPO, "tools", "compare");
			const entrypointSha256 = sha256HexOfBytes(
				new Uint8Array(readFileSync(join(roleRoot, "server.ts"))),
			);
			const launchRecord = buildStagedServerLaunchRecord({
				profile: "local-acceptance",
				transport: "ws",
				mode: "bulk-source",
				serverEntrypointSha256: entrypointSha256,
				bunSha256: HEX("b"),
				addonSha256: HEX("a"),
				bindPort: a5Port,
				tlsCertificateSha256: sha256HexOfBytes(
					new Uint8Array(Buffer.from(tls.cert)),
				),
				tlsPrivateKeySha256: sha256HexOfBytes(
					new Uint8Array(Buffer.from(tls.key)),
				),
			}) as unknown as StagedServerLaunchRecordV1;
			const launchRecordBytes = bytesOfCanonical(launchRecord);
			writeFileSync(
				join(stagingRoot, stagedServerLaunchRecordLeaf("ws", "bulk-source")),
				Buffer.from(launchRecordBytes),
			);
			const minted = Bun.spawnSync({
				cmd: [
					"bun",
					join(REPO, "tools", "compare", "bin", "mint-live-trust-bootstrap.ts"),
					"--fixture-only",
					`--out=${boot}`,
				],
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OBSERVE_DIRECTORY_IDENTITY_BINARY: join(
						REPO,
						"target",
						"release",
						"observe-directory-identity",
					),
				},
			});
			if (minted.exitCode !== 0) {
				throw new Error(`mint: ${minted.stderr.toString().slice(-1200)}`);
			}

			const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
				(candidate) => candidate.cellId === "bulk-one-way/physical",
			);
			if (cell === undefined) throw new Error("bulk-one-way/physical");
			const issuedAtMs = Date.now();
			const notAfterMs = issuedAtMs + 900_000;
			const draft = {
				schema: "cross-supervisor-execution-draft/v1" as const,
				authoritySha256: HEX("1"),
				campaignLockSha256: HEX("2"),
				stagedCapabilitySha256: HEX("3"),
				sourceArchiveSha256: HEX("4"),
				approvedPlanSha256: HEX("5"),
				approvalRecordSha256: HEX("6"),
				candidate: "a5-tls-leaf",
				campaignId: "a5-tls-leaf-campaign",
				runId: "a5-tls-leaf-campaign/bulk-one-way/physical/ws/measured-1",
				executionPurpose: "focused" as const,
				cellId: cell.cellId,
				scenarioHash: cell.scenarioHash,
				rolePlanHash: HEX("7"),
				workloadRolePlanInputSha256: HEX("8"),
				stagedServerLaunchRecordSha256: sha256HexOfBytes(launchRecordBytes),
				armKind: "primary" as const,
				transport: "ws" as const,
				repetitionKind: "measured" as const,
				repetitionIndex: 1,
				repetitionTotal: 1,
				grantDeclaration: "phase-a-completed-transfer" as const,
				declaredMessageCount: 1_600,
				declaredMessageBytes: 104_857_600,
				requestedNotAfterMs: notAfterMs,
			};
			const constructed = macConstructFinalExecution({
				draft,
				executionIndex: 1,
				macSupervisorInstanceNonce: HEX("9"),
				issuedAtMs,
				notAfterMs,
				grantNonceSha256: HEX("c"),
			});
			if (!constructed.ok) throw new Error(`execution: ${constructed.code}`);
			const macReceipt = {
				schema: "mac-execution-grant-receipt/v1" as const,
				execution: constructed.value.execution,
				executionSha256: constructed.value.executionSha256,
				measurementGrantSha256: constructed.value.grantSha256,
				approvedPlanSha256: draft.approvedPlanSha256,
				approvalRecordSha256: draft.approvalRecordSha256,
				macSupervisorExecutableSha256: HEX("d"),
				macSupervisorInstanceNonce: HEX("9"),
				signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
				receiptSequence: 0,
				issuedAtMs,
				notAfterMs,
			};
			const macReceiptBytes = bytesOfCanonical(macReceipt);
			const macReceiptSignature = signMacReceipt({
				privatePkcs8Der: mac.privatePkcs8Der,
				publicRaw32: mac.publicRaw32,
				signedSchema: "mac-execution-grant-receipt/v1",
				signedBytes: macReceiptBytes,
			});

			const keyPath = join(boot, "rig.pk8");
			writeFileSync(keyPath, Buffer.from(rigKeys.privatePkcs8Der));
			const binary = join(REPO, "target", "release", "comparison-supervisor");
			const script = [
				"set -eu",
				`exec 3< <(cat -- ${shellQuote(join(boot, "authority.json"))})`,
				`exec 4<${shellQuote(join(boot, "authority-digest.bin"))}`,
				`exec 5<${shellQuote(join(boot, "campaign-root"))}`,
				`exec 6<${shellQuote(stagingRoot)}`,
				`exec 7<${shellQuote(keyPath)}`,
				`exec 10<${shellQuote(roleRoot)}`,
				[
					`exec ${shellQuote(binary)}`,
					"--authority-fd 3",
					"--authority-digest-fd 4",
					"--campaign-root-fd 5",
					"--staging-root-fd 6",
					"--cohort-signing-key-fd 7",
					"--cohort-role-root-fd 10",
					"--control-in-fd 0",
					"--control-out-fd 1",
				].join(" "),
			].join("\n");
			const rig = nodeSpawn("bash", ["-c", script], {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					COMPARISON_SUPERVISOR_BUN_PATH: process.execPath,
				},
			});
			const rigStderr: string[] = [];
			rig.stderr.on("data", (chunk: Buffer) => {
				rigStderr.push(chunk.toString());
			});
			try {
				const channel = new CohortRigChannel({
					controllerToRig: rig.stdin as never,
					rigToController: rig.stdout as never,
					childDiagnostics: attachSupervisorChildDiagnostics(
						rig as unknown as ChildProcessWithoutNullStreams,
					),
					executionSha256: constructed.value.executionSha256,
					stagedRigPublicRaw32: rigKeys.publicRaw32,
					deadlines: {
						frameMs: 60_000,
						serverReadyMs: 180_000,
						warmupDrainMs: 60_000,
						captureMs: 300_000,
						teardownMs: 60_000,
					},
				});
				const accepted = await channel.acceptExecution({
					measurementGrantBytes: bytesOfCanonical(constructed.value.grant),
					receiptBytes: macReceiptBytes,
					receiptSignatureBytes: bytesOfCanonical(macReceiptSignature),
				});
				if (!accepted.ok) {
					throw new Error(
						`acceptExecution: ${accepted.code}: ${accepted.message}\n${rigStderr.join("")}`,
					);
				}
				// The session is at the stage the ordinary spawn is legal from
				// and it retained the Mac receipt: nothing the spawn refuses is
				// about either of them.
				expect(channel.stage).toBe("execution-accepted");

				// Only now, so the acceptance above is unaffected: the leaf the
				// spawner reads becomes unreadable to this process.
				chmodSync(join(stagingRoot, "staged-server-tls.key"), 0o000);

				const spawned = await channel.spawnServer({
					cohortGrantSha256: null,
					serverEntrypointSha256: entrypointSha256,
					bunSha256: HEX("b"),
					addonSha256: HEX("a"),
					stagedServerLaunchRecordBytes: launchRecordBytes,
					bindPort: a5Port,
					transport: "ws",
					serverArgv: [...launchRecord.argv],
				});
				expect(spawned.ok).toBe(false);
				if (spawned.ok)
					throw new Error("the spawn read a key it could not open");
				expect(spawned.code).toBe("COHORT_NOT_READY");
				// The whole point: the sentence names the leaf, so a live run
				// that hits this again does not cost another stage to diagnose.
				expect(spawned.message).toBe(
					"rig refused rig-spawn-server-request/v1 with COHORT_NOT_READY: staged tls leaf",
				);
				// Refused before the fork: nothing is listening on the port the
				// record named.
				const listening = Bun.spawnSync({
					cmd: ["lsof", "-nP", `-iTCP:${a5Port}`, "-sTCP:LISTEN"],
				})
					.stdout.toString()
					.split("\n")
					.filter((line) => line.includes("(LISTEN)"));
				expect(listening.length).toBe(0);
			} finally {
				chmodSync(join(stagingRoot, "staged-server-tls.key"), 0o600);
				rig.kill("SIGKILL");
				rmSync(boot, { recursive: true, force: true });
			}
		},
		RIG_E2E_TIMEOUT_MS,
	);
});
