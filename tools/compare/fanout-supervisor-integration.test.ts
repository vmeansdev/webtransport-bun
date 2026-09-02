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
	fstatSync,
	mkdtempSync,
	readdirSync,
	readSync,
	rmSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	decodeRoleChildFrame,
	encodeRoleChildFrame,
	RoleChildFrameReader,
} from "./child-pipe-protocol.ts";
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
	permitNotBeforeMacNs,
	READINESS_DEADLINE_MS_TICKER,
	type RoleSpawnConfigV1,
	type RoleWarmupCompleteV1,
	type RoleWarmupCompletionManifestV1,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	resolveGlobalOrdinal,
	type StagedServerLaunchRecordV1,
	SUBSCRIBER_SHARD_MODULUS,
	type SubscriberShardV1,
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
	type CrossSupervisorExecutionV1,
	type Ed25519KeyPairBytes,
	ed25519Sign,
	generateEd25519KeyPair,
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
	createMemoryReplayLedger,
	MAC_FANOUT_PUBLISHER_COUNT,
	MAC_FANOUT_TERMINAL_PATHS,
	type MacFanoutChildPlanV1,
	type MacFanoutChildSpawner,
	type MacFanoutChildStateV1,
	type MacFanoutExecutionJoinsV1,
	type MacFanoutProcessControl,
	type MacFanoutScenario,
	type MacFanoutSignal,
	type MacFanoutSpawnRequestV1,
	MacFanoutSupervisor,
	MacPermitScheduler,
	planMacFanoutTopology,
	sealTokenBundleFd,
} from "./remote-supervisor.ts";
import {
	buildFanoutCohortFixture,
	createManualRelayClock,
	type FanoutBarrierAcceptanceResult,
	type FanoutCohortAcceptance,
	type FanoutCohortFixture,
	FanoutLinuxAuthority,
	type FanoutLinuxAuthorityConfig,
	type FanoutRelay,
	type FanoutRelayObservationResult,
	type FanoutWarmupDrainedResult,
	fanoutFrameCodecFor,
	fanoutPayload,
	fanoutRoleId,
	type ManualRelayClock,
	type RelaySessionSink,
	parseServerStartBarrierAccepted,
	parseServerWarmupDrained,
	RELAY_WRITE_DEADLINE_MS,
} from "./scenarios/fanout-relay.ts";
import type { FanoutWireV1 } from "./scenarios/fanout-wire.ts";
import { parseStrictJsonBytes, sha256HexOfBytes } from "./secure-fs.ts";
import {
	FANOUT_COHORT_SERVER_ENV_NAMES,
	parseFanoutCohortServerEnvironment,
	parseServerArgs,
	serveFanoutCohortRelay,
	stagedServerLaunchArgv,
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
		transport,
		argv: ["tools/compare/bin/compare-server.ts"],
		allowedEnvironment: [],
	};
}

/**
 * Shards as the grant declares them: contiguous commitment blocks that tile the
 * subscriber run, which is what `parseCohortGrant` requires.
 */
function subscriberShards(): SubscriberShardV1[] {
	return Array.from({ length: COHORT_WORKER_COUNT }, (_unused, worker) => ({
		schema: "subscriber-shard/v1" as const,
		childId: `subscriber-worker-${worker}`,
		workerIndex: worker,
		modulus: SUBSCRIBER_SHARD_MODULUS,
		residue: worker,
		firstSubscriberIndex: 0 as const,
		lastSubscriberIndexExclusive: SHARD_SUBSCRIBERS,
		subscriberCount: SHARD_SUBSCRIBERS,
		orderedSubscriberIdsSha256: sha256CanonicalRecord({ worker }),
		firstTokenCommitmentIndex: PUBLISHER_COUNT + worker * SHARD_SUBSCRIBERS,
		lastTokenCommitmentIndexExclusive:
			PUBLISHER_COUNT + (worker + 1) * SHARD_SUBSCRIBERS,
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
			runId: "camp/ticker-fanout-10k/ws/measured-1",
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-10000",
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
			declaredMessageCount: 10_000_000,
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
		mintedAtMacNs: "5000000000",
		warmupStartedAtMacNs: "5000000000",
		warmupCompletedAtMacNs: "5100000000",
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
// because that is the smallest cohort whose commitment ranges both tile the
// subscriber run (what `parseCohortGrant` requires of a real grant) and match
// the interleaved indices the token fixture actually assigns.
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
			runId: `camp/ticker-fanout-10k/${transport}/measured-1`,
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-10000",
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
			declaredMessageCount: 10_000_000,
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
		rig: {
			rigSupervisorInstanceNonce: HEX("b"),
			rigExecutionIndex: 0,
			rigExecutionAcceptanceSha256: HEX("c"),
			privatePkcs8Der: cohort.rig.privatePkcs8Der,
			publicRaw32: cohort.rig.publicRaw32,
		},
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
	return {
		sink: {
			trySend: (bytes) => {
				if (blocked) return "would-block";
				const decoded = codec.decode(bytes);
				if (!decoded.ok) throw new Error(`peer decode: ${decoded.code}`);
				inbox.push(decoded.value);
				return "accepted";
			},
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

/**
 * The barrier a Mac would mint at this point: its four retained-record bindings
 * name exactly what the Linux side is holding, which is what
 * `validateCohortStartBarrierPreconditions` checks.
 */
function linuxStartBarrier(
	cohort: LinuxCohortFixtures,
	retained: {
		readonly rigCohortAcceptanceSha256: Sha256Hex;
		readonly rigWarmupDrainedReceiptSha256: Sha256Hex;
	},
	overrides: Partial<CohortStartBarrierV1> = {},
): CohortStartBarrierV1 {
	return {
		schema: "cohort-start-barrier/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		rigCohortAcceptanceSha256: retained.rigCohortAcceptanceSha256,
		rigMeasureStartAckSha256: MEASURE_START_ACK_SHA,
		roleWarmupCompletionManifestSha256: MANIFEST_SHA,
		roleWarmupCompletionManifestSignatureSha256: MANIFEST_SIG_SHA,
		rigWarmupDrainedReceiptSha256: retained.rigWarmupDrainedReceiptSha256,
		cohortId: LINUX_COHORT_ID,
		barrierNonce: HEX("6"),
		macClockId: "mac-clock-b3",
		mintedAtMacNs: "5000000000",
		warmupStartedAtMacNs: "5000000000",
		warmupCompletedAtMacNs: "5100000000",
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
	readonly epochSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	drained?: FanoutWarmupDrainedResult;
	barrier?: FanoutBarrierAcceptanceResult;
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
	"epochSha256" | "warmupNonce"
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

	return {
		cohort,
		authority,
		relay,
		clock,
		publishers,
		subscribers,
		acceptance: accepted.value,
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
		roleWarmupCompletionManifestSignatureSha256: MANIFEST_SIG_SHA,
		nowMs: NOW_MS,
	});
	if (!drained.ok) throw new Error(`drain: ${drained.code}`);
	session.drained = drained.value;
	return drained.value;
}

/** Mint, sign and present the barrier the Linux side is entitled to accept. */
function acceptBarrier(
	session: LinuxSession,
	overrides: Partial<CohortStartBarrierV1> = {},
	signWith?: Ed25519KeyPairBytes,
): ProtocolResult<FanoutBarrierAcceptanceResult> {
	const drained = session.drained as FanoutWarmupDrainedResult;
	const barrier = linuxStartBarrier(
		session.cohort,
		{
			rigCohortAcceptanceSha256: session.acceptance.acceptanceSha256,
			rigWarmupDrainedReceiptSha256: drained.receiptSha256,
		},
		overrides,
	);
	const bytes = bytesOfCanonical(barrier);
	const result = session.authority.acceptStartBarrier({
		barrier,
		signature: macSign(
			session.cohort,
			"cohort-start-barrier/v1",
			bytes,
			signWith,
		),
		rigMeasureStartAckSha256: MEASURE_START_ACK_SHA,
		sequence: 2,
		nowMs: NOW_MS,
	});
	if (result.ok) {
		session.barrier = result.value;
		session.barrierRecord = barrier;
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
			.serverStartBarrierAccepted.cohortStartBarrierSha256,
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

		// The genuine grant is accepted, and answered by a rig-signed acceptance
		// over its exact bytes.
		const accepted = authority.acceptCohortGrant({
			grant: cohort.grant,
			signature: cohort.grantSignature,
			nowMs: NOW_MS,
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error("unreachable");
		expect(authority.stage).toBe("grant-accepted");
		expect(accepted.value.acceptance.cohortGrantSha256).toBe(
			cohort.grantSha256,
		);
		expect(accepted.value.acceptance.roleTokenCommitmentRootSha256).toBe(
			cohort.tokens.roleTokenCommitmentRootSha256,
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: cohort.rig.publicRaw32,
				signedBytes: bytesOfCanonical(accepted.value.acceptance),
				signature: accepted.value.acceptanceSignature,
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
			warmupNonce: epoch.epoch.warmupNonce,
		};
		const drained = runWarmupAndDrain(live);

		// The drained frame states the non-vacuous expanded equation §4.1 requires.
		expect(drained.serverWarmupDrained.warmupIngress).toBe(
			PUBLISHER_COUNT * WARMUP_MESSAGES,
		);
		expect(drained.serverWarmupDrained.warmupDeliveries).toBe(
			PUBLISHER_COUNT * WARMUP_MESSAGES * LINUX_SUBSCRIBER_COUNT,
		);
		expect(drained.serverWarmupDrained.warmupDeliveries).toBe(
			drained.serverWarmupDrained.warmupIngress * LINUX_SUBSCRIBER_COUNT,
		);
		expect(drained.serverWarmupDrained.publisherWarmupEndCount).toBe(
			PUBLISHER_COUNT,
		);
		expect(drained.serverWarmupDrained.subscriberWarmupEndCount).toBe(
			LINUX_SUBSCRIBER_COUNT,
		);
		expect(drained.serverWarmupDrained.warmupQueuesEmpty).toBe(true);
		expect(drained.serverWarmupDrained.measuredCountersZero).toBe(true);

		// The measured counters really are back to zero, not merely declared so.
		const counters = session.relay.counters();
		expect(counters.acceptedIngressByOriginWindow.every((v) => v === 0)).toBe(
			true,
		);
		expect(
			counters.relayWritesCompletedByOriginWindow.every((v) => v === 0),
		).toBe(true);
		expect(counters.queueItemsPeak).toBe(0);

		// The rig receipt covers this exact server frame and verifies under the
		// rig key.
		expect(drained.receipt.serverWarmupDrainedSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(drained.serverWarmupDrained)),
		);
		expect(drained.receipt.roleWarmupCompletionManifestSha256).toBe(
			MANIFEST_SHA,
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: session.cohort.rig.publicRaw32,
				signedBytes: bytesOfCanonical(drained.receipt),
				signature: drained.receiptSignature,
			}).ok,
		).toBe(true);
	});

	test("linux_accepts_signed_barrier_before_measured_traffic", () => {
		const session = openLinuxSession();
		runWarmupAndDrain(session);
		expect(session.relay.phase).toBe("warmup-drained");

		const drained = session.drained as FanoutWarmupDrainedResult;
		const goodBarrier = linuxStartBarrier(session.cohort, {
			rigCohortAcceptanceSha256: session.acceptance.acceptanceSha256,
			rigWarmupDrainedReceiptSha256: drained.receiptSha256,
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
			rigMeasureStartAckSha256: MEASURE_START_ACK_SHA,
			sequence: 2,
			nowMs: NOW_MS,
		});
		expect(unsigned.ok).toBe(false);
		expect(session.relay.phase).toBe("warmup-drained");

		// Nor does one signed by a key the rig never staged.
		const foreign = generateEd25519KeyPair();
		const foreignSigned = acceptBarrier(session, {}, foreign);
		expect(foreignSigned.ok).toBe(false);
		expect(session.relay.phase).toBe("warmup-drained");

		// Nor one whose retained-record bindings name records this Linux side is
		// not holding: a barrier that claims another warmup receipt is refused
		// even with a perfect Mac signature over its own bytes.
		const wrongBinding = acceptBarrier(session, {
			rigWarmupDrainedReceiptSha256: HEX("a"),
		});
		expect(wrongBinding.ok).toBe(false);
		expect(wrongBinding.ok === false && wrongBinding.code).toBe(
			"COHORT_NOT_READY",
		);
		expect(session.relay.phase).toBe("warmup-drained");

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
		expect(
			accepted.value.serverStartBarrierAccepted.cohortStartBarrierSha256,
		).toBe(barrierSha256);
		expect(
			accepted.value.serverStartBarrierAccepted.measuredTrafficAllowed,
		).toBe(true);
		expect(accepted.value.serverStartBarrierAccepted.linuxClockId).toBe(
			LINUX_CLOCK_ID,
		);
		expect(accepted.value.acceptance.serverStartBarrierAcceptedSha256).toBe(
			sha256HexOfBytes(
				bytesOfCanonical(accepted.value.serverStartBarrierAccepted),
			),
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: session.cohort.rig.publicRaw32,
				signedBytes: bytesOfCanonical(accepted.value.acceptance),
				signature: accepted.value.acceptanceSignature,
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
				).serverStartBarrierAccepted.cohortStartBarrierSha256,
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

		const observed = session.authority.observe({ nowMs: NOW_MS });
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
			(session.barrier as FanoutBarrierAcceptanceResult)
				.serverStartBarrierAccepted.cohortStartBarrierSha256,
		);
		expect(observation.roleTokenCommitmentRootSha256).toBe(
			session.cohort.tokens.roleTokenCommitmentRootSha256,
		);
		expect(observation.serverChildPid).toBe(SERVER_IDENTITY.serverChildPid);
		expect(observation.linuxClockId).toBe(LINUX_CLOCK_ID);
		expect(observation.allSessionsClosed).toBe(true);

		// The rig receipt covers this exact observation.
		expect(observed.value.receipt.linuxRelayObservationSha256).toBe(
			sha256HexOfBytes(bytesOfCanonical(observation)),
		);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: session.cohort.rig.publicRaw32,
				signedBytes: bytesOfCanonical(observed.value.receipt),
				signature: observed.value.receiptSignature,
			}).ok,
		).toBe(true);

		// Single authority: the observation is emitted once, so there is no second
		// record for a controller to prefer.
		const second = session.authority.observe({ nowMs: NOW_MS });
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
		const accepted = (session.barrier as FanoutBarrierAcceptanceResult)
			.serverStartBarrierAccepted;

		// The genuine frames round-trip.
		expect(parseServerWarmupDrained(drained.serverWarmupDrained).ok).toBe(true);
		expect(parseServerStartBarrierAccepted(accepted).ok).toBe(true);

		// A warmup that moved nothing is not a warmup, however well formed.
		expect(
			parseServerWarmupDrained({
				...drained.serverWarmupDrained,
				warmupIngress: 0,
				warmupDeliveries: 0,
			}).ok,
		).toBe(false);

		// Neither frame may carry a field the schema does not name, or drop one
		// it does -- that is how a rewritten claim gets smuggled past a digest.
		expect(
			parseServerWarmupDrained({
				...drained.serverWarmupDrained,
				extra: 1,
			}).ok,
		).toBe(false);
		const { linuxClockId: _dropped, ...withoutClock } = accepted;
		expect(parseServerStartBarrierAccepted(withoutClock).ok).toBe(false);

		// The permission the frame grants is not negotiable.
		expect(
			parseServerStartBarrierAccepted({
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

		const observed = session.authority.observe({ nowMs: NOW_MS });
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
		const argv = stagedServerLaunchArgv("wt", "fanout-cohort");
		expect([...argv]).toEqual([
			"server.ts",
			"--transport=wt",
			"--mode=fanout-cohort",
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
				admissionFor(
					index,
					"subscriber",
					fanoutRoleId("subscriber", index),
				),
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
		crossed[0] = admissionFor(
			0,
			"publisher",
			fanoutRoleId("publisher", 0),
		);
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
		expect(admitted.value.registered.map((entry) => entry.globalOrdinal)).toEqual(
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
			roleWarmupCompletionManifestSignatureSha256: MANIFEST_SIG_SHA,
			nowMs: NOW_MS,
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

	test("linux_mints_the_measure_start_ack_and_the_barrier_must_name_it", () => {
		const session = openLinuxSession();

		// No baseline before the warmup is drained.
		expect(session.authority.measureStartAck({ nowMs: NOW_MS }).ok).toBe(false);
		runWarmupAndDrain(session);

		// The default authority has no measure-start inputs, so it refuses to
		// state a baseline rather than inventing a zero one.
		const unsourced = session.authority.measureStartAck({ nowMs: NOW_MS });
		expect(unsourced.ok).toBe(false);
		expect(unsourced.ok === false && unsourced.code).toBe("COHORT_NOT_READY");

		// An authority that can read its loop baseline mints the rig-signed ack.
		const attested = openLinuxSession({
			authority: {
				// Production stamps a digest-shaped clock id; the ack requires one.
				linuxClockId: HEX("a"),
				measureStart: {
					measurementGrantSha256: HEX("8"),
					macExecutionGrantReceiptSha256: HEX("9"),
					baselineBusyMs: () => 17,
				},
			},
		});
		const drained = runWarmupAndDrain(attested);
		const ack = attested.authority.measureStartAck({ nowMs: NOW_MS });
		expect(ack.ok).toBe(true);
		if (!ack.ok) throw new Error("unreachable");
		const record = parseStrictJsonBytes(ack.value.ackBytes);
		expect(record.ok).toBe(true);
		if (!record.ok) throw new Error("unreachable");
		const fields = record.value as { readonly [key: string]: unknown };
		expect(fields.schema).toBe("rig-measure-start-ack/v1");
		expect(fields.baselineBusyMs).toBe(17);
		// The warmup completion the baseline follows is the one the drain
		// retained, not one the caller named.
		expect(fields.warmupCompletionSha256).toBe(MANIFEST_SHA);
		expect(
			verifyRigReceiptSignature({
				stagedRigPublicRaw32: attested.cohort.rig.publicRaw32,
				signedBytes: ack.value.ackBytes,
				signature: ack.value.signature,
			}).ok,
		).toBe(true);

		// A barrier naming any other baseline is refused: the controller carries
		// this digest, it does not choose it.
		const barrier = linuxStartBarrier(attested.cohort, {
			rigCohortAcceptanceSha256: attested.acceptance.acceptanceSha256,
			rigWarmupDrainedReceiptSha256: drained.receiptSha256,
		});
		const wrongBaseline = attested.authority.acceptStartBarrier({
			barrier,
			signature: macSign(
				attested.cohort,
				"cohort-start-barrier/v1",
				bytesOfCanonical(barrier),
			),
			rigMeasureStartAckSha256: MEASURE_START_ACK_SHA,
			sequence: 2,
			nowMs: NOW_MS,
		});
		expect(wrongBaseline.ok).toBe(false);
		expect(wrongBaseline.ok === false && wrongBaseline.code).toBe(
			"COHORT_NOT_READY",
		);

		const honestBarrier = linuxStartBarrier(
			attested.cohort,
			{
				rigCohortAcceptanceSha256: attested.acceptance.acceptanceSha256,
				rigWarmupDrainedReceiptSha256: drained.receiptSha256,
			},
			{ rigMeasureStartAckSha256: ack.value.ackSha256 },
		);
		const armed = attested.authority.acceptStartBarrier({
			barrier: honestBarrier,
			signature: macSign(
				attested.cohort,
				"cohort-start-barrier/v1",
				bytesOfCanonical(honestBarrier),
			),
			rigMeasureStartAckSha256: ack.value.ackSha256,
			sequence: 2,
			nowMs: NOW_MS,
		});
		expect(armed.ok).toBe(true);
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

		const observed = session.authority.observe({ nowMs: NOW_MS });
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

const macExecutionJoins: MacFanoutExecutionJoinsV1 = {
	measurementGrantSha256: HEX("1"),
	macExecutionGrantReceiptSha256: HEX("9"),
	rigServerSnapshotReceiptSha256: HEX("2"),
	rigServerSnapshotReceiptSignatureSha256: HEX("3"),
	macMeasurementAdmissionReceiptSha256: HEX("4"),
	macMeasurementAdmissionSignatureSha256: HEX("5"),
	approvedPlanSha256: HEX("e"),
	approvalRecordSha256: HEX("f"),
};

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

interface MacCohortHarness {
	readonly supervisor: MacFanoutSupervisor;
	readonly macKeys: Ed25519KeyPairBytes;
	readonly rigKeys: Ed25519KeyPairBytes;
	readonly processes: FakeProcessTable;
	readonly runtimeDir: string;
	readonly executionSha256: Sha256Hex;
	readonly workloadBytes: Uint8Array;
	tokensByAttempt: Map<number, FanoutCohortFixture>;
	grantByAttempt: Map<number, CohortGrantV1>;
	manifestByAttempt: Map<number, TokenCommitmentLeafManifestV1>;
}

/** The execution every cohort in this block is minted under. */
function macExecution(transport: "ws" | "wt" = "ws"): {
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionSha256: Sha256Hex;
	readonly workloadBytes: Uint8Array;
} {
	const workloadBytes = bytesOfCanonical({
		plan: "b3-mac-role-plan",
		cohortId: MAC_COHORT_ID,
	});
	const built = macConstructFinalExecution({
		draft: {
			schema: "cross-supervisor-execution-draft/v1",
			authoritySha256: HEX("a"),
			campaignLockSha256: HEX("b"),
			stagedCapabilitySha256: HEX("c"),
			sourceArchiveSha256: HEX("d"),
			approvedPlanSha256: macExecutionJoins.approvedPlanSha256,
			approvalRecordSha256: macExecutionJoins.approvalRecordSha256,
			candidate: "cand",
			campaignId: "camp",
			runId: `camp/ticker-fanout-10k/${transport}/measured-1`,
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-10000",
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
			declaredMessageCount: 10_000_000,
			declaredMessageBytes: 100,
			requestedNotAfterMs: 17_000_000_000_000,
		},
		executionIndex: 0,
		macSupervisorInstanceNonce: HEX("7"),
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		grantNonceSha256: HEX("8"),
	});
	if (!built.ok) throw new Error(`mac execution: ${built.code}`);
	return {
		execution: built.value.execution,
		executionSha256: built.value.executionSha256,
		workloadBytes,
	};
}

/**
 * A supervisor whose cohort minter builds a real token fixture per attempt, so
 * a replacement produces genuinely different tokens rather than a relabelled
 * copy of the same tree.
 */
function macHarness(
	options: {
		readonly scenario?: MacFanoutScenario;
		readonly subscriberCount?: number;
		readonly survivesSigterm?: boolean;
	} = {},
): MacCohortHarness {
	const scenario = options.scenario ?? "ticker";
	const subscriberCount = options.subscriberCount ?? MAC_SUBSCRIBER_COUNT;
	const publisherCount = MAC_FANOUT_PUBLISHER_COUNT[scenario];
	const macKeys = generateEd25519KeyPair();
	const rigKeys = generateEd25519KeyPair();
	const processes = fakeProcessTable({
		survivesSigterm: options.survivesSigterm,
	});
	const { execution, executionSha256, workloadBytes } = macExecution();
	const runtimeDir = mkdtempSync(join(tmpdir(), "b3-mac-"));
	const tokensByAttempt = new Map<number, FanoutCohortFixture>();
	const grantByAttempt = new Map<number, CohortGrantV1>();
	const manifestByAttempt = new Map<number, TokenCommitmentLeafManifestV1>();

	const supervisor = new MacFanoutSupervisor({
		scenario,
		subscriberCount,
		executionSha256,
		macKeys,
		stagedRigPublicRaw32: rigKeys.publicRaw32,
		macSupervisorInstanceNonce: HEX("7"),
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
			// The grant commits to the leaf manifest's digest, so the manifest is
			// built here rather than restated later by whoever retains it.
			const leafManifest: TokenCommitmentLeafManifestV1 = {
				schema: "token-commitment-leaf-manifest/v1",
				executionSha256,
				cohortId,
				leafCount: tokens.leaves.length,
				leaves: [...tokens.leaves],
				roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
			};
			manifestByAttempt.set(cohortAttempt, leafManifest);
			const offeredIngress = MAC_MEASURED_FRAMES * publisherCount;
			const grant: CohortGrantV1 = {
				schema: "cohort-grant/v1",
				execution,
				executionSha256,
				macExecutionGrantReceiptSha256:
					macExecutionJoins.macExecutionGrantReceiptSha256,
				approvedPlanSha256: execution.approvedPlanSha256,
				approvalRecordSha256: execution.approvalRecordSha256,
				cohortId,
				cohortAttempt,
				scenarioHash: execution.scenarioHash,
				rolePlanHash: execution.rolePlanHash,
				workloadRolePlanInputSha256: execution.workloadRolePlanInputSha256,
				transport: "ws",
				publisherCount,
				subscriberCount,
				workerCount: 8,
				expectedProcessCount: publisherCount + COHORT_WORKER_COUNT,
				expectedSessionCount: publisherCount + subscriberCount,
				publishers: [...tokens.publishers],
				subscriberShards: [...tokens.subscriberShards],
				tokenCommitmentLeafManifestSha256: sha256HexOfBytes(
					bytesOfCanonical(leafManifest),
				),
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
				expectedExpandedDeliveries: offeredIngress * subscriberCount,
				macSupervisorInstanceNonce: HEX("7"),
				signingPublicKeySha256: sha256HexOfBytes(macKeys.publicRaw32),
				receiptSequence: 1,
				issuedAtMs: 1_000,
				notAfterMs: 2_000,
			};
			tokensByAttempt.set(cohortAttempt, tokens);
			grantByAttempt.set(cohortAttempt, grant);
			return { tokens, grant };
		},
		spawnChild: processes.spawner,
		processControl: processes.control,
		ledger: createMemoryReplayLedger(),
		stagedCapabilityNotAfterMs: 17_000_000_000_000,
		executionJoins: macExecutionJoins,
		bunSha256: HEX("8"),
		entrypointSha256: HEX("9"),
		receiptValidityMs: MAC_VALIDITY_MS,
	});
	return {
		supervisor,
		macKeys,
		rigKeys,
		processes,
		runtimeDir,
		executionSha256,
		workloadBytes,
		tokensByAttempt,
		grantByAttempt,
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
function macOpenAndSpawn(harness: MacCohortHarness): void {
	const opened = harness.supervisor.openCohort();
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

interface MacLifecycle {
	readonly harness: MacCohortHarness;
	readonly authority: FanoutLinuxAuthority;
	readonly relay: FanoutRelay;
	readonly tokens: FanoutCohortFixture;
	readonly grant: CohortGrantV1;
	readonly grantSha256: Sha256Hex;
	readonly acceptance: FanoutCohortAcceptance;
	readonly warmupEpoch: CohortWarmupEpochV1;
	readonly drained: FanoutWarmupDrainedResult;
	readonly barrier: CohortStartBarrierV1;
	readonly barrierSha256: Sha256Hex;
	readonly barrierAcceptance: FanoutBarrierAcceptanceResult;
	readonly observation: FanoutRelayObservationResult;
	readonly measureStartAckBytes: Uint8Array;
	readonly measureStartAckSignature: RigReceiptSignatureV1;
	readonly publisherPartials: readonly PublisherPartialV1[];
	readonly workerPartials: readonly WorkerPartialV1[];
}

function macRegisterPeer(
	relay: FanoutRelay,
	tokens: FanoutCohortFixture,
	grantSha256: Sha256Hex,
	role: "publisher" | "subscriber",
	roleId: string,
): LinuxPeer {
	const codec = fanoutFrameCodecFor(relay.config.transport);
	const inbox: FanoutWireV1[] = [];
	const sessionId = relay.openSession({
		trySend: (bytes) => {
			const decoded = codec.decode(bytes);
			if (!decoded.ok) throw new Error(`peer decode: ${decoded.code}`);
			inbox.push(decoded.value);
			return "accepted";
		},
		close: () => {},
	});
	const register = relay.handleInbound(sessionId, {
		schema: "fanout-wire/v1",
		kind: "register",
		cohortGrantSha256: grantSha256,
		transport: relay.config.transport,
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
	});
	if (!register.ok) {
		throw new Error(`register ${roleId}: ${register.code} ${register.message}`);
	}
	return {
		roleId,
		send: (frame) => relay.handleInbound(sessionId, frame),
		received: () => inbox,
		block: () => {},
	};
}

/**
 * Drive one cohort from grant to a signed, exported evidence bundle against the
 * real relay. Every number in the partials is derived from what the relay
 * actually did, so the conservation the supervisor recomputes at export is a
 * real reconciliation and not a fixture that agrees with itself.
 */
function macDriveToExport(harness: MacCohortHarness): MacLifecycle {
	const supervisor = harness.supervisor;
	const opened = supervisor.openCohort();
	if (!opened.ok)
		throw new Error(`openCohort: ${opened.code} ${opened.message}`);
	const tokens = harness.tokensByAttempt.get(1) as FanoutCohortFixture;
	const grantSha256 = opened.value.grantSha256;

	const clock = createManualRelayClock();
	const authority = new FanoutLinuxAuthority({
		transport: "ws",
		executionSha256: harness.executionSha256,
		stagedMacPublicRaw32: harness.macKeys.publicRaw32,
		rig: {
			rigSupervisorInstanceNonce: HEX("b"),
			rigExecutionIndex: 0,
			rigExecutionAcceptanceSha256: HEX("c"),
			privatePkcs8Der: harness.rigKeys.privatePkcs8Der,
			publicRaw32: harness.rigKeys.publicRaw32,
		},
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
	if (!accepted.ok) throw new Error(`linux grant: ${accepted.code}`);
	const started = authority.startServer();
	if (!started.ok) throw new Error(`server ready: ${started.code}`);
	const relay = started.value;

	const spawned = supervisor.spawnRoleChildren({
		bundleFor: (plan) => macBundleFor(harness, plan),
		spawnedAtMacNs: "1000000000",
	});
	if (!spawned.ok) throw new Error(`spawn: ${spawned.code} ${spawned.message}`);
	const planInput = supervisor.retainWorkloadRolePlanInput(
		harness.workloadBytes,
	);
	if (!planInput.ok) throw new Error(`plan input: ${planInput.message}`);

	const presented = supervisor.presentRigCohortAcceptance({
		acceptance: accepted.value.acceptance,
		signature: accepted.value.acceptanceSignature,
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

	// Warmup: Mac signs the epoch, Linux opens on it, publishers offer the exact
	// ten paced frames, and the Mac retains one completion frame per child.
	const warmupEpoch: CohortWarmupEpochV1 = {
		schema: "cohort-warmup-epoch/v1",
		executionSha256: harness.executionSha256,
		cohortGrantSha256: grantSha256,
		cohortId: opened.value.grant.cohortId,
		warmupNonce: HEX("e"),
		durationMs: 5_000,
		warmupMessagesPerPublisher: 10,
		warmupIntervalMs: 500,
		expectedWarmupIngress: expectedWarmupIngress(MAC_PUBLISHER_COUNT),
		expectedWarmupDeliveries: expectedWarmupDeliveries(
			MAC_PUBLISHER_COUNT,
			MAC_SUBSCRIBER_COUNT,
		),
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(harness.macKeys.publicRaw32),
		receiptSequence: 2,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	const issuedEpoch = supervisor.issueWarmupEpoch(warmupEpoch);
	if (!issuedEpoch.ok) throw new Error(`warmup epoch: ${issuedEpoch.message}`);
	const epochBytes = bytesOfCanonical(warmupEpoch);
	const epochSha256 = sha256HexOfBytes(epochBytes);
	const openedWarmup = authority.acceptWarmupEpoch({
		epoch: warmupEpoch,
		signature: signMacReceipt({
			privatePkcs8Der: harness.macKeys.privatePkcs8Der,
			publicRaw32: harness.macKeys.publicRaw32,
			signedSchema: "cohort-warmup-epoch/v1",
			signedBytes: epochBytes,
		}),
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
	const warmupEntries = orderedChildren.map((plan, order) => {
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
		const bytes = bytesOfCanonical(frame);
		const retained = supervisor.retainRoleWarmupComplete(bytes);
		if (!retained.ok) throw new Error(`warmup complete: ${retained.message}`);
		return {
			schema: "role-warmup-completion-manifest-entry/v1" as const,
			order,
			childId: plan.childId,
			role: plan.role,
			roleWarmupComplete: {
				schema: "retained-canonical-bytes/v1" as const,
				encoding: "base64" as const,
				mediaType: "application/json" as const,
				bytesBase64: Buffer.from(bytes).toString("base64") as Base64,
				byteLength: bytes.byteLength,
				sha256: sha256HexOfBytes(bytes),
			},
			roleWarmupCompleteSha256: sha256HexOfBytes(bytes),
			offeredWarmupIngress: frame.offeredWarmupIngress,
			deliveredWarmupRecords: frame.deliveredWarmupRecords,
		};
	});
	const warmupManifest: RoleWarmupCompletionManifestV1 = {
		schema: "role-warmup-completion-manifest/v1",
		executionSha256: harness.executionSha256,
		cohortGrantSha256: grantSha256,
		cohortWarmupEpochSha256: epochSha256,
		entryCount: warmupEntries.length,
		entries: warmupEntries,
		allRoleChildrenComplete: true,
		completedAtMacNs: "4600000000",
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(harness.macKeys.publicRaw32),
		receiptSequence: 3,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	const issuedManifest =
		supervisor.issueRoleWarmupCompletionManifest(warmupManifest);
	if (!issuedManifest.ok) {
		throw new Error(`warmup manifest: ${issuedManifest.message}`);
	}
	const provenWire = authority.runWarmupWire();
	if (!provenWire.ok) throw new Error(`warmup wire: ${provenWire.code}`);
	const drained = authority.drainWarmup({
		sequence: 1,
		roleWarmupCompletionManifestSha256:
			issuedManifest.value.roleWarmupCompletionManifestSha256,
		roleWarmupCompletionManifestSignatureSha256:
			issuedManifest.value.roleWarmupCompletionManifestSignatureSha256,
		nowMs: MAC_NOW_MS,
	});
	if (!drained.ok) throw new Error(`drain: ${drained.code}`);
	const presentedDrain = supervisor.presentRigWarmupDrainedReceipt({
		serverWarmupDrainedBytes: bytesOfCanonical(
			drained.value.serverWarmupDrained,
		),
		receipt: drained.value.receipt,
		signature: drained.value.receiptSignature,
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

	const barrier: CohortStartBarrierV1 = {
		schema: "cohort-start-barrier/v1",
		executionSha256: harness.executionSha256,
		cohortGrantSha256: grantSha256,
		rigCohortAcceptanceSha256: presented.value.rigCohortAcceptanceSha256,
		rigMeasureStartAckSha256: presentedAck.value.rigMeasureStartAckSha256,
		roleWarmupCompletionManifestSha256:
			issuedManifest.value.roleWarmupCompletionManifestSha256,
		roleWarmupCompletionManifestSignatureSha256:
			issuedManifest.value.roleWarmupCompletionManifestSignatureSha256,
		rigWarmupDrainedReceiptSha256:
			presentedDrain.value.rigWarmupDrainedReceiptSha256,
		cohortId: opened.value.grant.cohortId,
		barrierNonce: HEX("6"),
		macClockId: MAC_CLOCK_ID,
		mintedAtMacNs: "5000000000",
		warmupStartedAtMacNs: "5000000000",
		warmupCompletedAtMacNs: "5100000000",
		measureStartAtMacNs: "5250000000",
		measureStopAtMacNs: "15250000000",
		sampleWindowMs: 1_000,
		windowCount: WINDOW_COUNT,
		measuredDurationMs: 10_000,
		drainDeadlineMs: 10_000,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(harness.macKeys.publicRaw32),
		receiptSequence: 4,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	const issuedBarrier = supervisor.issueStartBarrier(barrier);
	if (!issuedBarrier.ok) throw new Error(`barrier: ${issuedBarrier.message}`);
	const barrierSha256 = issuedBarrier.value.cohortStartBarrierSha256;
	const barrierAcceptance = authority.acceptStartBarrier({
		barrier,
		signature: signMacReceipt({
			privatePkcs8Der: harness.macKeys.privatePkcs8Der,
			publicRaw32: harness.macKeys.publicRaw32,
			signedSchema: "cohort-start-barrier/v1",
			signedBytes: bytesOfCanonical(barrier),
		}),
		rigMeasureStartAckSha256: presentedAck.value.rigMeasureStartAckSha256,
		sequence: 2,
		nowMs: MAC_NOW_MS,
	});
	if (!barrierAcceptance.ok)
		throw new Error(`linux barrier: ${barrierAcceptance.code}`);
	const presentedBarrier = supervisor.presentRigBarrierAcceptance({
		serverStartBarrierAcceptedBytes: bytesOfCanonical(
			barrierAcceptance.value.serverStartBarrierAccepted,
		),
		acceptance: barrierAcceptance.value.acceptance,
		signature: barrierAcceptance.value.acceptanceSignature,
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
	const observation = authority.observe({ nowMs: MAC_NOW_MS });
	if (!observation.ok) throw new Error(`observe: ${observation.code}`);
	const linux = observation.value.observation;

	const presentedObservation = supervisor.presentRigRelayObservation({
		observationBytes: bytesOfCanonical(linux),
		receipt: observation.value.receipt,
		signature: observation.value.receiptSignature,
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
	const leafManifestRetained = supervisor.retainTokenCommitmentLeafManifest(
		bytesOfCanonical(
			harness.manifestByAttempt.get(1) as TokenCommitmentLeafManifestV1,
		),
	);
	if (!leafManifestRetained.ok) {
		throw new Error(`leaf manifest: ${leafManifestRetained.message}`);
	}
	return {
		harness,
		authority,
		relay,
		tokens,
		grant: opened.value.grant,
		grantSha256,
		acceptance: accepted.value,
		warmupEpoch,
		drained: drained.value,
		barrier,
		barrierSha256,
		barrierAcceptance: barrierAcceptance.value,
		observation: observation.value,
		measureStartAckBytes,
		measureStartAckSignature,
		publisherPartials,
		workerPartials,
	};
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
	test("mac_supervisor_owns_exact_chat_10_plus_8", () => {
		const harness = macHarness({ scenario: "chat" });
		macOpenAndSpawn(harness);
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

	test("mac_supervisor_owns_exact_ticker_1_plus_8", () => {
		const harness = macHarness({ scenario: "ticker" });
		macOpenAndSpawn(harness);
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
	test("controller_cannot_invent_rewrite_or_cross_pair_any_rig_record", () => {
		const harness = macHarness();
		const live = macDriveToExport(harness);
		const supervisor = harness.supervisor;

		// A second supervisor, driven identically, gives us genuine rig records
		// that belong to a *different* cohort -- the cross-pairing material.
		const other = macHarness();
		const otherLive = macDriveToExport(other);
		expect(otherLive.grantSha256).not.toBe(live.grantSha256);

		// 1. Invented. The controller signs a record with its own key.
		const forger = generateEd25519KeyPair();
		const inventedAcceptance = {
			...live.acceptance.acceptance,
			receiptSequence: live.acceptance.acceptance.receiptSequence + 1,
		};
		const invented = supervisor.presentRigCohortAcceptance({
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
		const unsigned = supervisor.presentRigCohortAcceptance({
			acceptance: live.acceptance.acceptance,
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
			receipt: live.observation.receipt,
			signature: live.observation.receiptSignature,
			nowMs: MAC_NOW_MS,
		});
		expect(rewritten.ok).toBe(false);
		expect(rewritten.ok === false && rewritten.code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);

		// 4. Cross-paired by cohort. A genuine, rig-signed record from the other
		//    cohort, presented here unmodified.
		const crossCohort = supervisor.presentRigBarrierAcceptance({
			serverStartBarrierAcceptedBytes: bytesOfCanonical(
				otherLive.barrierAcceptance.serverStartBarrierAccepted,
			),
			acceptance: otherLive.barrierAcceptance.acceptance,
			signature: otherLive.barrierAcceptance.acceptanceSignature,
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
			receipt: live.observation.receipt,
			signature: live.observation.receiptSignature,
			nowMs: MAC_NOW_MS,
		});
		expect(crossPaired.ok).toBe(false);

		// 6. Cross-schema. A genuine signature moved onto another record type.
		const crossSchema = supervisor.presentRigWarmupDrainedReceipt({
			serverWarmupDrainedBytes: bytesOfCanonical(
				live.drained.serverWarmupDrained,
			),
			receipt: live.drained.receipt,
			signature: {
				...live.drained.receiptSignature,
				signedSchema: "rig-barrier-acceptance/v1",
			},
			nowMs: MAC_NOW_MS,
		});
		expect(crossSchema.ok).toBe(false);

		// 7. Replayed. The same genuine record a second time.
		const replayed = supervisor.presentRigRelayObservation({
			observationBytes: bytesOfCanonical(live.observation.observation),
			receipt: live.observation.receipt,
			signature: live.observation.receiptSignature,
			nowMs: MAC_NOW_MS,
		});
		expect(replayed.ok).toBe(false);
		expect(replayed.ok === false && replayed.code).toBe("RIG_RECEIPT_REPLAYED");

		// 8. Expired. Held past the staged capability's lifetime.
		const expiredHarness = macHarness();
		const expiredLive = macDriveToExport(expiredHarness);
		const expired = expiredHarness.supervisor.presentRigCohortAcceptance({
			acceptance: expiredLive.acceptance.acceptance,
			signature: expiredLive.acceptance.acceptanceSignature,
			nowMs: 17_000_000_000_001,
		});
		expect(expired.ok).toBe(false);

		// None of the eight moved the supervisor: the cohort still holds exactly
		// the records it authenticated the first time.
		expect(
			supervisor.exportCohortEvidence({
				request: {
					schema: "mac-export-cohort-evidence-request/v1",
					requestSeq: 1,
					executionSha256: harness.executionSha256,
					cohortAdmissionReceiptSha256: HEX("f"),
				},
				issuedAtMs: 1_000,
				notAfterMs: 2_000,
			}).ok,
		).toBe(false);

		for (const each of [harness, other, expiredHarness]) {
			expect(each.supervisor.teardown("FAIL").ok).toBe(true);
			rmSync(each.runtimeDir, { recursive: true, force: true });
		}
	});

	test("controller_cannot_inject_or_rewrite_partial_or_evidence_bundle", () => {
		const harness = macHarness();
		const live = macDriveToExport(harness);
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
		const rewrittenHarness = macHarness();
		const rewrittenLive = macDriveToExport(rewrittenHarness);
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

		// The export itself: the request names content it does not control, and
		// an admission receipt this supervisor never minted is refused.
		const admission = supervisor.buildAdmissionReceipt({
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
		});
		expect(admission.ok).toBe(true);
		if (!admission.ok) throw new Error("unreachable");
		const admissionSha256 = sha256HexOfBytes(bytesOfCanonical(admission.value));

		const forgedRequest = supervisor.exportCohortEvidence({
			request: {
				schema: "mac-export-cohort-evidence-request/v1",
				requestSeq: 7,
				executionSha256: harness.executionSha256,
				cohortAdmissionReceiptSha256: HEX("d"),
			},
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
		});
		expect(forgedRequest.ok).toBe(false);

		const crossExecution = supervisor.exportCohortEvidence({
			request: {
				schema: "mac-export-cohort-evidence-request/v1",
				requestSeq: 7,
				executionSha256: HEX("c"),
				cohortAdmissionReceiptSha256: admissionSha256,
			},
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
		});
		expect(crossExecution.ok).toBe(false);

		// The honest export. Every member is a retained byte string, and the
		// bundle parses under the same parser the offline verifier uses.
		const exported = supervisor.exportCohortEvidence({
			request: {
				schema: "mac-export-cohort-evidence-request/v1",
				requestSeq: 7,
				executionSha256: harness.executionSha256,
				cohortAdmissionReceiptSha256: admissionSha256,
			},
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
		});
		expect(exported.ok).toBe(true);
		if (!exported.ok) throw new Error(`export: ${exported.message}`);
		expect(exported.value.terminalExport).toBe(true);
		expect(exported.value.ackRequestSeq).toBe(7);

		const bundleBytes = new Uint8Array(
			Buffer.from(exported.value.cohortObservationEvidenceBase64, "base64"),
		);
		expect(bundleBytes.byteLength).toBe(
			exported.value.cohortObservationEvidenceSize,
		);
		expect(sha256HexOfBytes(bundleBytes)).toBe(
			exported.value.cohortObservationEvidenceSha256,
		);
		const decoded = parseStrictJsonBytes(bundleBytes);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) throw new Error("unreachable");
		const parsedBundle = parseCohortObservationEvidence({
			evidence: decoded.value,
			expectedPublisherCount: MAC_PUBLISHER_COUNT,
			expectedSubscriberCount: MAC_SUBSCRIBER_COUNT,
			expectedExecutionSha256: harness.executionSha256,
			expectedCohortGrantSha256: live.grantSha256,
		});
		expect(parsedBundle.ok).toBe(true);
		if (!parsedBundle.ok) throw new Error(`bundle: ${parsedBundle.message}`);
		expect(parsedBundle.value.workerPartials.length).toBe(8);
		expect(parsedBundle.value.publisherPartials.length).toBe(
			MAC_PUBLISHER_COUNT,
		);
		expect(parsedBundle.value.roleWarmupCompletes.length).toBe(
			MAC_PUBLISHER_COUNT + 8,
		);

		// A rewritten bundle -- one worker partial swapped for a fatter one --
		// fails the same parser, so injecting after the export is no better than
		// injecting before it.
		const injected = {
			...parsedBundle.value,
			workerPartials: [
				retainedOf(inflated),
				...parsedBundle.value.workerPartials.slice(1),
			],
		};
		expect(
			parseCohortObservationEvidence({
				evidence: injected,
				expectedPublisherCount: MAC_PUBLISHER_COUNT,
				expectedSubscriberCount: MAC_SUBSCRIBER_COUNT,
			}).ok,
		).toBe(false);

		// The export is terminal: there is no second one to substitute into.
		const second = supervisor.exportCohortEvidence({
			request: {
				schema: "mac-export-cohort-evidence-request/v1",
				requestSeq: 8,
				executionSha256: harness.executionSha256,
				cohortAdmissionReceiptSha256: admissionSha256,
			},
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
		});
		expect(second.ok).toBe(false);

		for (const each of [harness, rewrittenHarness]) {
			expect(each.supervisor.teardown("PASS").ok).toBe(true);
			rmSync(each.runtimeDir, { recursive: true, force: true });
		}
	});
});

describe("cohort replacement and reap", () => {
	test("pre_ready_replacement_mints_new_grant_nonce_and_tokens", () => {
		const harness = macHarness();
		macOpenAndSpawn(harness);
		const supervisor = harness.supervisor;
		const firstAttempt = supervisor.cohortAttempt;
		const firstNonce = supervisor.grantNonceSha256 as Sha256Hex;
		const firstGrantSha256 = supervisor.cohortGrantSha256 as Sha256Hex;
		const firstRoot = (supervisor.grant as CohortGrantV1)
			.roleTokenCommitmentRootSha256;
		const firstTokens = harness.tokensByAttempt.get(1) as FanoutCohortFixture;
		const firstPgids = [...supervisor.ownedPgids];
		expect(firstPgids.length).toBe(9);

		const replaced = supervisor.replaceCohortBeforeReadiness({
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
			rig: {
				rigSupervisorInstanceNonce: HEX("b"),
				rigExecutionIndex: 0,
				rigExecutionAcceptanceSha256: HEX("c"),
				privatePkcs8Der: harness.rigKeys.privatePkcs8Der,
				publicRaw32: harness.rigKeys.publicRaw32,
			},
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
		const secondReplacement = supervisor.replaceCohortBeforeReadiness({
			reason: "a second pre-readiness failure",
		});
		expect(secondReplacement.ok).toBe(false);
		expect(secondReplacement.ok === false && secondReplacement.code).toBe(
			"CHILD_LIFECYCLE",
		);

		expect(supervisor.teardown("REFUSED").ok).toBe(true);
		rmSync(harness.runtimeDir, { recursive: true, force: true });
	});

	test("post_ready_replacement_fails", () => {
		const harness = macHarness();
		macOpenAndSpawn(harness);
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

		const afterOne = supervisor.replaceCohortBeforeReadiness({
			reason: "a child exited after its sibling was ready",
		});
		expect(afterOne.ok).toBe(false);
		expect(afterOne.ok === false && afterOne.code).toBe("CHILD_LIFECYCLE");

		macReadyAll(harness);
		expect(supervisor.allChildrenReady).toBe(true);
		const afterAll = supervisor.replaceCohortBeforeReadiness({
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

	test("all_pgids_are_reaped_on_every_terminal_path", () => {
		for (const terminalPath of MAC_FANOUT_TERMINAL_PATHS) {
			const harness = macHarness();
			macOpenAndSpawn(harness);
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
		const stubborn = macHarness({ survivesSigterm: true });
		macOpenAndSpawn(stubborn);
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
		const replaced = macHarness();
		macOpenAndSpawn(replaced);
		const abandoned = [...replaced.supervisor.ownedPgids];
		const replacement = replaced.supervisor.replaceCohortBeforeReadiness({
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
