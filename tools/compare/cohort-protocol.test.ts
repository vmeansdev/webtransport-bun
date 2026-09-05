/**
 * B1 adversarial cohort tests (plan §4.1 pre-readiness grant, token
 * commitments, post-readiness barrier; §4.3 token-bundle FD contract).
 */
import { describe, expect, test } from "bun:test";
import {
	buildChat10kWorstCaseTokenBundleFixture,
	CHAT_10K_TOKEN_BUNDLE_MARGIN_BYTES,
	CHAT_10K_TOKEN_BUNDLE_MAX_BYTES,
	CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
	COHORT_CONNECTION_RATE_PER_SECOND,
	COHORT_DRAIN_DEADLINE_MS,
	COHORT_GRANT_MAX_BYTES,
	COHORT_IN_REPETITION_WARMUP_MS,
	COHORT_MAX_CONNECTIONS_IN_FLIGHT,
	COHORT_CELL_GRANT_PARAMETERS,
	COHORT_MAX_PUBLISHERS,
	COHORT_MEASURED_DURATION_MS_VALUES,
	COHORT_MESSAGE_BYTES_VALUES,
	COHORT_ROLE_REPLACEMENT_COUNT,
	COHORT_SAMPLE_WINDOW_MS,
	COHORT_SERVER_HOST,
	COHORT_TLS_SERVER_NAME,
	COHORT_WARMUP_EPOCH_MAX_BYTES,
	COHORT_WORKER_COUNT,
	type CohortGrantV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	cohortCellGrantParameters,
	computeTokenCommitmentRoot,
	computeTokenMerkleProof,
	enumerateGlobalOrdinals,
	expectedWarmupDeliveries,
	expectedWarmupIngress,
	globalOrdinalCount,
	orderTokenCommitmentLeaves,
	COHORT_MAX_CONNECTIONS_IN_FLIGHT as PERMIT_MAX_IN_FLIGHT,
	type PublisherRoleGrantV1,
	parseCohortGrant,
	parseCohortStartBarrier,
	parseCohortWarmupEpoch,
	parseConnectPermitComplete,
	parseConnectPermitGrant,
	parseConnectPermitRequest,
	parseRigBarrierAcceptance,
	parseRigCohortAcceptance,
	parseRigWarmupDrainedReceipt,
	parseRoleExit,
	parseRoleExited,
	parseRoleMeasureStart,
	parseRoleMeasureStartAck,
	parseRolePartial,
	parseRolePartialAccepted,
	parseRoleReady,
	parseRoleSpawnConfig,
	parseRoleStop,
	parseRoleWarmupComplete,
	parseRoleWarmupCompletionManifest,
	parseRoleWarmupStart,
	parseStagedServerLaunchRecord,
	parseSubscriberShard,
	parseTokenBundle,
	parseTokenCommitmentLeafManifest,
	permitNotBeforeMacNs,
	READINESS_DEADLINE_MS_CHAT_1K,
	READINESS_DEADLINE_MS_CHAT_5K,
	READINESS_DEADLINE_MS_CHAT_10K,
	READINESS_DEADLINE_MS_TICKER,
	ROLE_CHILD_FRAME_MAX_BYTES,
	ROLE_SPAWN_CONFIG_MAX_BYTES,
	ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES,
	type RoleWarmupCompletionManifestV1,
	recomputeRootFromLeafManifest,
	requireCohortGrantSignatureBeforeRigAction,
	resolveGlobalOrdinal,
	SUBSCRIBER_SHARD_MODULUS,
	type SubscriberShardV1,
	subscriberShardCommitmentWindowEnd,
	TOKEN_BUNDLE_ENVELOPE_BYTES,
	TOKEN_BUNDLE_FD,
	TOKEN_BUNDLE_MAX_ENTRY_BYTES,
	TOKEN_BUNDLE_MAX_SIZE,
	TOKEN_COMMITMENT_LEAF_MANIFEST_MAX_BYTES,
	type TokenBundleFdObservationV1,
	type TokenCommitmentLeafV1,
	tokenCommitmentLeafSha256,
	validateCohortStartBarrierPreconditions,
	verifyPresentedCohortTopology,
	validateConnectPermitCompletion,
	validateConnectPermitGrant,
	validateNoRoleReplacements,
	validateRoleWarmupCompletionManifest,
	validateTokenBundleBytes,
	validateTokenBundleFdMetadata,
	verifyTokenMerkleProof,
	WARMUP_DURATION_MS,
	WARMUP_INTERVAL_MS,
	WARMUP_MESSAGES_PER_PUBLISHER,
	WARMUP_OFFSETS_MS,
} from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	type CrossSupervisorExecutionDraftV1,
	type CrossSupervisorExecutionV1,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	sha256CanonicalRecord,
	signMacReceipt,
	signRigReceipt,
} from "./cross-supervisor-protocol.ts";
import {
	decodeFanoutWsMessage,
	decodeFanoutWtStream,
	encodeFanoutWsMessage,
	encodeFanoutWtFrame,
	FANOUT_ACK_CLOSED_CODES,
	FANOUT_CHAT_PAYLOAD_BYTES,
	FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
	FANOUT_DATA_FRAME_MAX_DECODED_BYTES,
	FANOUT_REFUSE_CODES,
	FANOUT_TICKER_PAYLOAD_BYTES,
	FANOUT_WT_LENGTH_PREFIX_BYTES,
	parseFanoutAck,
	parseFanoutWire,
	requireMeasuredFrameBinding,
	requireWarmupFrameBinding,
} from "./scenarios/fanout-wire.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";

const HEX = (c: string): string => c.repeat(64);
const HEX_A = HEX("a");
const HEX_B = HEX("b");
const HEX_C = HEX("c");
const HEX_D = HEX("d");
const HEX_E = HEX("e");
const HEX_F = HEX("f");
const HEX_1 = HEX("1");
const HEX_2 = HEX("2");
const HEX_3 = HEX("3");
const HEX_4 = HEX("4");
const HEX_5 = HEX("5");
const HEX_6 = HEX("6");
const HEX_7 = HEX("7");
const HEX_8 = HEX("8");
const HEX_9 = HEX("9");

const PUBLISHER_COUNT = 10;
const SUBSCRIBER_COUNT = 1_000;
const SHARD_SUBSCRIBERS = SUBSCRIBER_COUNT / SUBSCRIBER_SHARD_MODULUS;

function fanoutDraft(): CrossSupervisorExecutionDraftV1 {
	return {
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: HEX_A,
		campaignLockSha256: HEX_B,
		stagedCapabilitySha256: HEX_C,
		sourceArchiveSha256: HEX_D,
		approvedPlanSha256: HEX_E,
		approvalRecordSha256: HEX_F,
		candidate: "cand",
		campaignId: "camp",
		runId: "camp/chat-fanout-1k/ws/measured-1",
		executionPurpose: "focused",
		cellId: "chat-fanout/subscribers-1000",
		scenarioHash: HEX_1,
		rolePlanHash: HEX_2,
		workloadRolePlanInputSha256: HEX_3,
		stagedServerLaunchRecordSha256: HEX_4,
		armKind: "primary",
		transport: "ws",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		grantDeclaration: "fanout-expanded-deliveries",
		declaredMessageCount: 300_000,
		declaredMessageBytes: 128,
		requestedNotAfterMs: 17_000_000_000_000,
	};
}

function builtExecution(): {
	execution: CrossSupervisorExecutionV1;
	executionSha256: string;
} {
	const built = macConstructFinalExecution({
		draft: fanoutDraft(),
		executionIndex: 0,
		macSupervisorInstanceNonce: HEX_5,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		grantNonceSha256: HEX_6,
	});
	if (!built.ok) throw new Error("execution construction failed");
	return {
		execution: built.value.execution,
		executionSha256: built.value.executionSha256,
	};
}

function publisherGrants(): PublisherRoleGrantV1[] {
	return Array.from({ length: PUBLISHER_COUNT }, (_unused, index) => ({
		schema: "publisher-role-grant/v1" as const,
		childId: `publisher-${index.toString().padStart(6, "0")}`,
		publisherId: `publisher-${index.toString().padStart(6, "0")}`,
		tokenCommitmentIndex: index,
		tokenSha256: sha256CanonicalRecord({ token: `publisher-${index}` }),
	}));
}

/**
 * Shards derived from the leaves the way both production producers derive
 * them (`scenarios/fanout-relay.ts:2065-2085`, `mac_cohort_runtime.rs:284-305`):
 * a worker's members are the subscriber leaves naming it, its digest is the
 * canonical bytes of their role IDs in leaf order, and its commitment window
 * is the span of that residue class: from the first member's leaf index to one
 * past the last member's (`subscriberShardCommitmentWindowEnd`, R-A).
 */
function shardsFromLeaves(
	leaves: readonly TokenCommitmentLeafV1[],
	subscriberCount: number,
): SubscriberShardV1[] {
	return Array.from({ length: COHORT_WORKER_COUNT }, (_unused, worker) => {
		const members = leaves
			.map((leaf, index) => ({ leaf, index }))
			.filter(({ leaf }) => leaf.workerIndex === worker);
		const first = (members[0] as { index: number }).index;
		return {
			schema: "subscriber-shard/v1" as const,
			childId: `subscriber-worker-${worker}`,
			workerIndex: worker,
			modulus: 8 as const,
			residue: worker,
			firstSubscriberIndex: 0 as const,
			// The grant's subscriber total, not this shard's own count: the eight
			// shards partition one global subscriber run. Mirrors
			// `expect_count(entry, "lastSubscriberIndexExclusive", subscriber_count)`
			// at `crates/native/src/secure_fs.rs:12556`.
			lastSubscriberIndexExclusive: subscriberCount,
			subscriberCount: members.length,
			orderedSubscriberIdsSha256: sha256HexOfBytes(
				bytesOfCanonical(members.map(({ leaf }) => leaf.roleId)),
			),
			firstTokenCommitmentIndex: first,
			lastTokenCommitmentIndexExclusive: subscriberShardCommitmentWindowEnd(
				first,
				members.length,
			),
		};
	});
}

function subscriberShards(): SubscriberShardV1[] {
	return shardsFromLeaves(
		orderTokenCommitmentLeaves(cohortLeaves()),
		SUBSCRIBER_COUNT,
	);
}

function cohortLeaves(): TokenCommitmentLeafV1[] {
	const leaves: TokenCommitmentLeafV1[] = [];
	for (let index = 0; index < PUBLISHER_COUNT; index += 1) {
		leaves.push({
			schema: "token-commitment-leaf/v1",
			childId: `publisher-${index.toString().padStart(6, "0")}`,
			cohortId: "cohort-1",
			role: "publisher",
			roleId: `publisher-${index.toString().padStart(6, "0")}`,
			tokenSha256: sha256CanonicalRecord({ token: `publisher-${index}` }),
			workerIndex: null,
		});
	}
	for (let index = 0; index < SUBSCRIBER_COUNT; index += 1) {
		leaves.push({
			schema: "token-commitment-leaf/v1",
			childId: `subscriber-worker-${index % SUBSCRIBER_SHARD_MODULUS}`,
			cohortId: "cohort-1",
			role: "subscriber",
			roleId: `subscriber-${index.toString().padStart(6, "0")}`,
			tokenSha256: sha256CanonicalRecord({ token: `subscriber-${index}` }),
			workerIndex: index % SUBSCRIBER_SHARD_MODULUS,
		});
	}
	return leaves;
}

function leafManifest(executionSha256: string): RoleTokenManifestFixture {
	const leaves = orderTokenCommitmentLeaves(cohortLeaves());
	const leafHashes = leaves.map((leaf) => tokenCommitmentLeafSha256(leaf));
	const root = computeTokenCommitmentRoot(leafHashes);
	if (!root.ok) throw new Error("root");
	const manifest = {
		schema: "token-commitment-leaf-manifest/v1" as const,
		executionSha256,
		cohortId: "cohort-1",
		leafCount: leaves.length,
		leaves,
		roleTokenCommitmentRootSha256: root.value,
	};
	return { manifest, leafHashes, root: root.value };
}

interface RoleTokenManifestFixture {
	readonly manifest: {
		readonly schema: "token-commitment-leaf-manifest/v1";
		readonly executionSha256: string;
		readonly cohortId: string;
		readonly leafCount: number;
		readonly leaves: readonly TokenCommitmentLeafV1[];
		readonly roleTokenCommitmentRootSha256: string;
	};
	readonly leafHashes: readonly string[];
	readonly root: string;
}

function cohortGrant(overrides: Partial<CohortGrantV1> = {}): CohortGrantV1 {
	const { execution, executionSha256 } = builtExecution();
	const fixture = leafManifest(executionSha256);
	return {
		schema: "cohort-grant/v1",
		execution,
		executionSha256,
		macExecutionGrantReceiptSha256: HEX_7,
		approvedPlanSha256: execution.approvedPlanSha256,
		approvalRecordSha256: execution.approvalRecordSha256,
		cohortId: "cohort-1",
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
		publishers: publisherGrants(),
		subscriberShards: subscriberShards(),
		tokenCommitmentLeafManifestSha256: sha256CanonicalRecord(fixture.manifest),
		roleTokenCommitmentRootSha256: fixture.root,
		roleTokenCommitmentCount: fixture.manifest.leafCount,
		connectionRatePerSecond: 500,
		maxConnectionsInFlight: 200,
		readinessDeadlineMs: READINESS_DEADLINE_MS_CHAT_1K,
		inRepetitionWarmupMs: 5_000,
		sampleWindowMs: 1_000,
		measuredDurationMs: 30_000,
		drainDeadlineMs: 10_000,
		messageBytes: 100,
		expectedOfferedIngress: 300_000,
		expectedExpandedDeliveries: 300_000_000,
		macSupervisorInstanceNonce: HEX_5,
		signingPublicKeySha256: HEX_8,
		receiptSequence: 1,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	};
}

function warmupEpoch(
	grantSha256: string,
	executionSha256: string,
	overrides: Partial<CohortWarmupEpochV1> = {},
): CohortWarmupEpochV1 {
	return {
		schema: "cohort-warmup-epoch/v1",
		executionSha256,
		cohortGrantSha256: grantSha256,
		cohortId: "cohort-1",
		warmupNonce: HEX_9,
		durationMs: 5_000,
		warmupMessagesPerPublisher: 10,
		warmupIntervalMs: 500,
		expectedWarmupIngress: PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER,
		expectedWarmupDeliveries:
			PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER * SUBSCRIBER_COUNT,
		macSupervisorInstanceNonce: HEX_5,
		signingPublicKeySha256: HEX_8,
		receiptSequence: 2,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	};
}

function warmupCompletionManifest(
	executionSha256: string,
	grantSha256: string,
	epochSha256: string,
): RoleWarmupCompletionManifestV1 {
	const entries = [
		...Array.from({ length: PUBLISHER_COUNT }, (_unused, index) => {
			const complete = {
				schema: "role-warmup-complete/v1",
				childId: `publisher-${index.toString().padStart(6, "0")}`,
			};
			const bytes = bytesOfCanonical(complete);
			return {
				schema: "role-warmup-completion-manifest-entry/v1" as const,
				order: index,
				childId: `publisher-${index.toString().padStart(6, "0")}`,
				role: "publisher" as const,
				roleWarmupComplete: {
					schema: "retained-canonical-bytes/v1" as const,
					encoding: "base64" as const,
					mediaType: "application/json" as const,
					bytesBase64: Buffer.from(bytes).toString("base64"),
					byteLength: bytes.byteLength,
					sha256: sha256CanonicalRecord(complete),
				},
				roleWarmupCompleteSha256: sha256CanonicalRecord(complete),
				offeredWarmupIngress: WARMUP_MESSAGES_PER_PUBLISHER,
				deliveredWarmupRecords: 0,
			};
		}),
		...Array.from({ length: COHORT_WORKER_COUNT }, (_unused, worker) => {
			const complete = {
				schema: "role-warmup-complete/v1",
				childId: `subscriber-worker-${worker}`,
			};
			const bytes = bytesOfCanonical(complete);
			return {
				schema: "role-warmup-completion-manifest-entry/v1" as const,
				order: PUBLISHER_COUNT + worker,
				childId: `subscriber-worker-${worker}`,
				role: "subscriber-worker" as const,
				roleWarmupComplete: {
					schema: "retained-canonical-bytes/v1" as const,
					encoding: "base64" as const,
					mediaType: "application/json" as const,
					bytesBase64: Buffer.from(bytes).toString("base64"),
					byteLength: bytes.byteLength,
					sha256: sha256CanonicalRecord(complete),
				},
				roleWarmupCompleteSha256: sha256CanonicalRecord(complete),
				offeredWarmupIngress: 0,
				deliveredWarmupRecords:
					SHARD_SUBSCRIBERS * PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER,
			};
		}),
	];
	return {
		schema: "role-warmup-completion-manifest/v1",
		executionSha256,
		cohortGrantSha256: grantSha256,
		cohortWarmupEpochSha256: epochSha256,
		entryCount: entries.length,
		entries,
		allRoleChildrenComplete: true,
		completedAtMacNs: "1000000000",
		macSupervisorInstanceNonce: HEX_5,
		signingPublicKeySha256: HEX_8,
		receiptSequence: 3,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
}

function startBarrier(
	executionSha256: string,
	grantSha256: string,
	overrides: Partial<CohortStartBarrierV1> = {},
): CohortStartBarrierV1 {
	return {
		schema: "cohort-start-barrier/v1",
		executionSha256,
		cohortGrantSha256: grantSha256,
		rigCohortAcceptanceSha256: HEX_A,
		rigMeasureStartAckSha256: HEX_B,
		roleWarmupCompletionManifestSha256: HEX_C,
		roleWarmupCompletionManifestSignatureSha256: HEX_D,
		rigWarmupDrainedReceiptSha256: HEX_E,
		cohortId: "cohort-1",
		barrierNonce: HEX_9,
		macClockId: "darwin-mach-continuous",
		// Ordered as the binary mints it: warmup started, warmup completed,
		// minted, then the window armed 250 ms ahead (`secure_fs.rs:21160-21188`).
		warmupStartedAtMacNs: "1000000000",
		warmupCompletedAtMacNs: "6000000000",
		mintedAtMacNs: "6100000000",
		measureStartAtMacNs: "6350000000",
		measureStopAtMacNs: "36350000000",
		sampleWindowMs: 1_000,
		windowCount: 30,
		measuredDurationMs: 30_000,
		drainDeadlineMs: 10_000,
		macSupervisorInstanceNonce: HEX_5,
		signingPublicKeySha256: HEX_8,
		receiptSequence: 4,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	};
}

function fdObservation(
	overrides: Partial<TokenBundleFdObservationV1> = {},
): TokenBundleFdObservationV1 {
	return {
		schema: "token-bundle-fd-observation/v1",
		fd: 5,
		fileKind: "regular",
		accessMode: "read-only",
		appendMode: false,
		hardLinkCount: 0,
		deviceId: "16777233",
		inode: "84213756",
		byteSize: 4_096,
		contentSha256: HEX_1,
		...overrides,
	};
}

describe("cohort-protocol B1 §4.1", () => {
	test("cohort_grant_signature_required_before_rig_action", () => {
		const mac = generateEd25519KeyPair();
		const other = generateEd25519KeyPair();
		const grant = cohortGrant({ signingPublicKeySha256: mac.publicKeySha256 });
		const bytes = bytesOfCanonical(grant);

		// No signature at all: the rig must refuse before it spawns anything.
		const unsigned = requireCohortGrantSignatureBeforeRigAction({
			grant,
			signature: null,
			stagedMacPublicRaw32: mac.publicRaw32,
			nowMs: 1_500,
		});
		expect(unsigned.ok).toBe(false);
		if (!unsigned.ok) {
			expect(unsigned.code).toBe("MAC_GRANT_SIGNATURE_INVALID");
		}

		// Signed by a key the rig did not stage.
		const foreign = requireCohortGrantSignatureBeforeRigAction({
			grant,
			signature: signMacReceipt({
				privatePkcs8Der: other.privatePkcs8Der,
				publicRaw32: other.publicRaw32,
				signedSchema: "cohort-grant/v1",
				signedBytes: bytes,
			}),
			stagedMacPublicRaw32: mac.publicRaw32,
			nowMs: 1_500,
		});
		expect(foreign.ok).toBe(false);
		if (!foreign.ok) expect(foreign.code).toBe("MAC_SIGNING_KEY_MISMATCH");

		// A rig receipt signature is not a Mac grant signature.
		const rig = generateEd25519KeyPair();
		const rigSigned = requireCohortGrantSignatureBeforeRigAction({
			grant,
			signature: signRigReceipt({
				privatePkcs8Der: rig.privatePkcs8Der,
				publicRaw32: rig.publicRaw32,
				signedSchema: "rig-cohort-acceptance/v1",
				signedBytes: bytes,
			}),
			stagedMacPublicRaw32: mac.publicRaw32,
			nowMs: 1_500,
		});
		expect(rigSigned.ok).toBe(false);

		const signature = signMacReceipt({
			privatePkcs8Der: mac.privatePkcs8Der,
			publicRaw32: mac.publicRaw32,
			signedSchema: "cohort-grant/v1",
			signedBytes: bytes,
		});

		// Signature over mutated bytes must not authorize the original grant.
		const tampered = requireCohortGrantSignatureBeforeRigAction({
			grant: { ...grant, subscriberCount: SUBSCRIBER_COUNT + 1 },
			signature,
			stagedMacPublicRaw32: mac.publicRaw32,
			nowMs: 1_500,
		});
		expect(tampered.ok).toBe(false);

		// Expired grants never authorize a rig action either.
		const expired = requireCohortGrantSignatureBeforeRigAction({
			grant,
			signature,
			stagedMacPublicRaw32: mac.publicRaw32,
			nowMs: 2_001,
		});
		expect(expired.ok).toBe(false);
		if (!expired.ok) expect(expired.code).toBe("MAC_GRANT_EXPIRED");

		const accepted = requireCohortGrantSignatureBeforeRigAction({
			grant,
			signature,
			stagedMacPublicRaw32: mac.publicRaw32,
			nowMs: 1_500,
		});
		expect(accepted.ok).toBe(true);
	});

	test("token_leaf_manifest_recomputes_root_without_raw_tokens", () => {
		const { executionSha256 } = builtExecution();
		const fixture = leafManifest(executionSha256);
		const parsed = parseTokenCommitmentLeafManifest(fixture.manifest);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		// The retained manifest carries hashes only; no raw token bytes survive.
		const text = new TextDecoder().decode(bytesOfCanonical(parsed.value));
		expect(text.includes("tokenBase64")).toBe(false);

		const recomputed = recomputeRootFromLeafManifest(parsed.value);
		expect(recomputed.ok).toBe(true);
		if (!recomputed.ok) return;
		expect(recomputed.value).toBe(fixture.root);

		// A per-role proof verifies against the recomputed root using only the
		// manifest's leaf hashes.
		const index = 137;
		const proof = computeTokenMerkleProof(fixture.leafHashes, index);
		expect(proof.ok).toBe(true);
		if (!proof.ok) return;
		expect(
			verifyTokenMerkleProof({
				leafSha256: fixture.leafHashes[index] as string,
				tokenCommitmentIndex: index,
				leafCount: fixture.leafHashes.length,
				proof: proof.value,
				rootSha256: recomputed.value,
			}).ok,
		).toBe(true);

		// Wrong index (replay of another role's proof) must not verify.
		expect(
			verifyTokenMerkleProof({
				leafSha256: fixture.leafHashes[index] as string,
				tokenCommitmentIndex: index + 1,
				leafCount: fixture.leafHashes.length,
				proof: proof.value,
				rootSha256: recomputed.value,
			}).ok,
		).toBe(false);

		// A swapped leaf hash must not verify under the same proof.
		expect(
			verifyTokenMerkleProof({
				leafSha256: fixture.leafHashes[index + 1] as string,
				tokenCommitmentIndex: index,
				leafCount: fixture.leafHashes.length,
				proof: proof.value,
				rootSha256: recomputed.value,
			}).ok,
		).toBe(false);

		// A manifest whose declared root drifts from its leaves is refused.
		const drifted = parseTokenCommitmentLeafManifest({
			...fixture.manifest,
			roleTokenCommitmentRootSha256: HEX_F,
		});
		expect(drifted.ok).toBe(false);
	});

	test("chat_10k_token_bundle_is_at_most_1924096_bytes", () => {
		expect(CHAT_10K_TOKEN_BUNDLE_MAX_BYTES).toBe(1_924_096);
		expect(CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS).toBe(1_250);
		expect(
			CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS * TOKEN_BUNDLE_MAX_ENTRY_BYTES +
				TOKEN_BUNDLE_ENVELOPE_BYTES,
		).toBe(CHAT_10K_TOKEN_BUNDLE_MAX_BYTES);
		expect(TOKEN_BUNDLE_MAX_SIZE - CHAT_10K_TOKEN_BUNDLE_MAX_BYTES).toBe(
			CHAT_10K_TOKEN_BUNDLE_MARGIN_BYTES,
		);

		const fixture = buildChat10kWorstCaseTokenBundleFixture();
		expect(fixture.bundle.entryCount).toBe(
			CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
		);
		expect(parseTokenBundle(fixture.bundle).ok).toBe(true);
		expect(fixture.canonicalBytes.byteLength).toBeLessThanOrEqual(
			CHAT_10K_TOKEN_BUNDLE_MAX_BYTES,
		);
		expect(validateTokenBundleBytes(fixture.canonicalBytes).ok).toBe(true);
		for (const entry of fixture.bundle.entries) {
			expect(entry.tokenMerkleProofSha256.length).toBe(14);
			expect(bytesOfCanonical(entry).byteLength).toBeLessThanOrEqual(
				TOKEN_BUNDLE_MAX_ENTRY_BYTES,
			);
		}
	});

	test("token_bundle_cap_plus_one_refused", () => {
		expect(TOKEN_BUNDLE_MAX_SIZE).toBe(2_097_152);
		expect(
			validateTokenBundleBytes(new Uint8Array(TOKEN_BUNDLE_MAX_SIZE)).ok,
		).toBe(true);
		const over = validateTokenBundleBytes(
			new Uint8Array(TOKEN_BUNDLE_MAX_SIZE + 1),
		);
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.code).toBe("COHORT_PROTOCOL");
		expect(validateTokenBundleBytes(new Uint8Array(0)).ok).toBe(false);
	});

	test("token_fd_metadata_rejects_writable_path_backed_or_mutated_fd", () => {
		const atSpawn = fdObservation();
		const good = validateTokenBundleFdMetadata({
			atSpawn,
			atRead: fdObservation(),
			expectedSha256: HEX_1,
			expectedSize: 4_096,
		});
		expect(good.ok).toBe(true);

		const writable = validateTokenBundleFdMetadata({
			atSpawn: fdObservation({ accessMode: "read-write" }),
			atRead: fdObservation({ accessMode: "read-write" }),
			expectedSha256: HEX_1,
			expectedSize: 4_096,
		});
		expect(writable.ok).toBe(false);
		if (!writable.ok) {
			expect(writable.code).toBe("COHORT_PROTOCOL");
			expect(writable.message).toContain("writable");
		}

		const appendable = validateTokenBundleFdMetadata({
			atSpawn: fdObservation({ appendMode: true }),
			atRead: fdObservation({ appendMode: true }),
			expectedSha256: HEX_1,
			expectedSize: 4_096,
		});
		expect(appendable.ok).toBe(false);

		const pathBacked = validateTokenBundleFdMetadata({
			atSpawn: fdObservation({ hardLinkCount: 1 }),
			atRead: fdObservation({ hardLinkCount: 1 }),
			expectedSha256: HEX_1,
			expectedSize: 4_096,
		});
		expect(pathBacked.ok).toBe(false);
		if (!pathBacked.ok) expect(pathBacked.message).toContain("path-backed");

		const mutated = validateTokenBundleFdMetadata({
			atSpawn,
			atRead: fdObservation({ contentSha256: HEX_2 }),
			expectedSha256: HEX_1,
			expectedSize: 4_096,
		});
		expect(mutated.ok).toBe(false);
		if (!mutated.ok) expect(mutated.message).toContain("mutated");

		// FD reuse: a different inode behind the same descriptor number.
		const reused = validateTokenBundleFdMetadata({
			atSpawn,
			atRead: fdObservation({ inode: "99999999" }),
			expectedSha256: HEX_1,
			expectedSize: 4_096,
		});
		expect(reused.ok).toBe(false);

		// Unexpected descriptor number.
		expect(
			validateTokenBundleFdMetadata({
				atSpawn: fdObservation({ fd: 6 as unknown as 5 }),
				atRead: fdObservation({ fd: 6 as unknown as 5 }),
				expectedSha256: HEX_1,
				expectedSize: 4_096,
			}).ok,
		).toBe(false);

		// Not a regular file.
		expect(
			validateTokenBundleFdMetadata({
				atSpawn: fdObservation({ fileKind: "fifo" }),
				atRead: fdObservation({ fileKind: "fifo" }),
				expectedSha256: HEX_1,
				expectedSize: 4_096,
			}).ok,
		).toBe(false);

		// Short read / digest swap against the signed expectation.
		expect(
			validateTokenBundleFdMetadata({
				atSpawn,
				atRead: fdObservation(),
				expectedSha256: HEX_1,
				expectedSize: 4_095,
			}).ok,
		).toBe(false);
		expect(
			validateTokenBundleFdMetadata({
				atSpawn,
				atRead: fdObservation(),
				expectedSha256: HEX_2,
				expectedSize: 4_096,
			}).ok,
		).toBe(false);

		// Over the cap.
		expect(
			validateTokenBundleFdMetadata({
				atSpawn: fdObservation({ byteSize: TOKEN_BUNDLE_MAX_SIZE + 1 }),
				atRead: fdObservation({ byteSize: TOKEN_BUNDLE_MAX_SIZE + 1 }),
				expectedSha256: HEX_1,
				expectedSize: TOKEN_BUNDLE_MAX_SIZE + 1,
			}).ok,
		).toBe(false);
	});

	test("caps and schedule constants are the exact plan values", () => {
		expect(COHORT_GRANT_MAX_BYTES).toBe(262_144);
		expect(TOKEN_COMMITMENT_LEAF_MANIFEST_MAX_BYTES).toBe(4_194_304);
		expect(COHORT_WARMUP_EPOCH_MAX_BYTES).toBe(16_384);
		expect(ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES).toBe(262_144);
		expect(COHORT_MAX_PUBLISHERS).toBe(10);
		expect(COHORT_WORKER_COUNT).toBe(8);
		expect(SUBSCRIBER_SHARD_MODULUS).toBe(8);
		expect(COHORT_CONNECTION_RATE_PER_SECOND).toBe(500);
		expect(COHORT_MAX_CONNECTIONS_IN_FLIGHT).toBe(200);
		expect(COHORT_IN_REPETITION_WARMUP_MS).toBe(5_000);
		expect(COHORT_SAMPLE_WINDOW_MS).toBe(1_000);
		expect(COHORT_DRAIN_DEADLINE_MS).toBe(10_000);
		expect(TOKEN_BUNDLE_FD).toBe(5);
		expect(READINESS_DEADLINE_MS_TICKER).toBe(30_000);
		expect(READINESS_DEADLINE_MS_CHAT_1K).toBe(90_000);
		expect(READINESS_DEADLINE_MS_CHAT_5K).toBe(180_000);
		expect(READINESS_DEADLINE_MS_CHAT_10K).toBe(300_000);
		expect(WARMUP_MESSAGES_PER_PUBLISHER).toBe(10);
		expect(WARMUP_INTERVAL_MS).toBe(500);
		expect(WARMUP_DURATION_MS).toBe(5_000);
		expect(WARMUP_OFFSETS_MS.length).toBe(10);
		expect(WARMUP_OFFSETS_MS[0]).toBe(0);
		expect(WARMUP_OFFSETS_MS[9]).toBe(4_500);
	});

	test("cohort grant round-trips exact keys and rejects unknown or drifted fields", () => {
		const grant = cohortGrant();
		expect(parseCohortGrant(grant).ok).toBe(true);
		expect(
			parseCohortGrant({ ...grant, extra: 1 } as unknown as CohortGrantV1).ok,
		).toBe(false);
		const { schema: _schema, ...missing } = grant;
		expect(parseCohortGrant(missing).ok).toBe(false);
		expect(parseCohortGrant({ ...grant, readinessDeadlineMs: 45_000 }).ok).toBe(
			false,
		);
		expect(parseCohortGrant({ ...grant, workerCount: 4 as 8 }).ok).toBe(false);
		expect(
			parseCohortGrant({
				...grant,
				publishers: [...grant.publishers, ...grant.publishers],
			}).ok,
		).toBe(false);
		expect(
			parseCohortGrant({
				...grant,
				expectedSessionCount: PUBLISHER_COUNT + SUBSCRIBER_COUNT + 1,
			}).ok,
		).toBe(false);
		expect(parseCohortGrant({ ...grant, roleTokenCommitmentCount: 3 }).ok).toBe(
			false,
		);
		// A grant may not carry a measured start timestamp: it is pre-readiness.
		expect(
			parseCohortGrant({
				...grant,
				measureStartAtMacNs: "1",
			} as unknown as CohortGrantV1).ok,
		).toBe(false);
	});

	test("warmup epoch expectations are non-vacuous and manifest sums must match", () => {
		const grant = cohortGrant();
		const grantSha256 = sha256CanonicalRecord(grant);
		const epoch = warmupEpoch(grantSha256, grant.executionSha256);
		expect(parseCohortWarmupEpoch(epoch).ok).toBe(true);
		expect(expectedWarmupIngress(PUBLISHER_COUNT)).toBe(100);
		expect(expectedWarmupDeliveries(PUBLISHER_COUNT, SUBSCRIBER_COUNT)).toBe(
			100_000,
		);
		expect(
			parseCohortWarmupEpoch({ ...epoch, expectedWarmupIngress: 0 }).ok,
		).toBe(false);
		expect(
			parseCohortWarmupEpoch({ ...epoch, warmupIntervalMs: 250 as 500 }).ok,
		).toBe(false);

		const epochSha256 = sha256CanonicalRecord(epoch);
		const manifest = warmupCompletionManifest(
			grant.executionSha256,
			grantSha256,
			epochSha256,
		);
		expect(parseRoleWarmupCompletionManifest(manifest).ok).toBe(true);
		const validated = validateRoleWarmupCompletionManifest({
			manifest,
			epoch,
			publisherCount: PUBLISHER_COUNT,
			subscriberCount: SUBSCRIBER_COUNT,
			shardSubscriberCounts: Array.from(
				{ length: COHORT_WORKER_COUNT },
				() => SHARD_SUBSCRIBERS,
			),
		});
		expect(validated.ok).toBe(true);

		// A missing publisher completion is FAIL/WARMUP_PROTOCOL.
		const dropped = validateRoleWarmupCompletionManifest({
			manifest: {
				...manifest,
				entryCount: manifest.entryCount - 1,
				entries: manifest.entries.slice(1),
			},
			epoch,
			publisherCount: PUBLISHER_COUNT,
			subscriberCount: SUBSCRIBER_COUNT,
			shardSubscriberCounts: Array.from(
				{ length: COHORT_WORKER_COUNT },
				() => SHARD_SUBSCRIBERS,
			),
		});
		expect(dropped.ok).toBe(false);
		if (!dropped.ok) expect(dropped.code).toBe("WARMUP_PROTOCOL");

		// A publisher that offered nothing makes warmup vacuous.
		const vacuous = validateRoleWarmupCompletionManifest({
			manifest: {
				...manifest,
				entries: manifest.entries.map((entry, index) =>
					index === 0 ? { ...entry, offeredWarmupIngress: 0 } : entry,
				),
			},
			epoch,
			publisherCount: PUBLISHER_COUNT,
			subscriberCount: SUBSCRIBER_COUNT,
			shardSubscriberCounts: Array.from(
				{ length: COHORT_WORKER_COUNT },
				() => SHARD_SUBSCRIBERS,
			),
		});
		expect(vacuous.ok).toBe(false);
	});

	test("merkle ordering places publishers first and pairs an odd node with itself", () => {
		const shuffled = [...cohortLeaves()].reverse();
		const ordered = orderTokenCommitmentLeaves(shuffled);
		expect(ordered[0]?.role).toBe("publisher");
		expect(ordered[0]?.roleId).toBe("publisher-000000");
		expect(ordered[PUBLISHER_COUNT]?.role).toBe("subscriber");
		expect(ordered[PUBLISHER_COUNT]?.roleId).toBe("subscriber-000000");

		// Three leaves: the odd last node pairs with itself at every level.
		const hashes = [HEX_1, HEX_2, HEX_3];
		const root = computeTokenCommitmentRoot(hashes);
		expect(root.ok).toBe(true);
		if (!root.ok) return;
		for (let index = 0; index < hashes.length; index += 1) {
			const proof = computeTokenMerkleProof(hashes, index);
			expect(proof.ok).toBe(true);
			if (!proof.ok) return;
			expect(proof.value.length).toBe(2);
			expect(
				verifyTokenMerkleProof({
					leafSha256: hashes[index] as string,
					tokenCommitmentIndex: index,
					leafCount: hashes.length,
					proof: proof.value,
					rootSha256: root.value,
				}).ok,
			).toBe(true);
		}
		expect(computeTokenCommitmentRoot([]).ok).toBe(false);
	});

	test("start barrier requires the retained rig baseline and refuses pre-readiness issue", () => {
		const grant = cohortGrant();
		const grantSha256 = sha256CanonicalRecord(grant);
		const barrier = startBarrier(grant.executionSha256, grantSha256);
		expect(parseCohortStartBarrier(barrier).ok).toBe(true);

		const ok = validateCohortStartBarrierPreconditions({
			barrier,
			rigCohortAcceptanceSha256: HEX_A,
			rigMeasureStartAckSha256: HEX_B,
			roleWarmupCompletionManifestSha256: HEX_C,
			rigWarmupDrainedReceiptSha256: HEX_E,
		});
		expect(ok.ok).toBe(true);

		// The barrier may not be minted before the Linux baseline ack is fixed.
		const swapped = validateCohortStartBarrierPreconditions({
			barrier,
			rigCohortAcceptanceSha256: HEX_A,
			rigMeasureStartAckSha256: HEX_F,
			roleWarmupCompletionManifestSha256: HEX_C,
			rigWarmupDrainedReceiptSha256: HEX_E,
		});
		expect(swapped.ok).toBe(false);
		if (!swapped.ok) expect(swapped.code).toBe("COHORT_NOT_READY");

		// windowCount * sampleWindowMs must equal measuredDurationMs.
		expect(
			parseCohortStartBarrier(
				startBarrier(grant.executionSha256, grantSha256, { windowCount: 10 }),
			).ok,
		).toBe(false);

		// Warmup must complete before the measured window opens: a completion
		// past the window start puts the mint past it too.
		expect(
			validateCohortStartBarrierPreconditions({
				barrier: startBarrier(grant.executionSha256, grantSha256, {
					warmupCompletedAtMacNs: "6400000000",
					mintedAtMacNs: "6400000000",
				}),
				rigCohortAcceptanceSha256: HEX_A,
				rigMeasureStartAckSha256: HEX_B,
				roleWarmupCompletionManifestSha256: HEX_C,
				rigWarmupDrainedReceiptSha256: HEX_E,
			}).ok,
		).toBe(false);
	});

	test("rig-signed cohort records parse with exact keys", () => {
		const grant = cohortGrant();
		const grantSha256 = sha256CanonicalRecord(grant);
		const acceptance = {
			schema: "rig-cohort-acceptance/v1" as const,
			executionSha256: grant.executionSha256,
			cohortGrantSha256: grantSha256,
			cohortGrantSignatureSha256: HEX_1,
			roleTokenCommitmentRootSha256: grant.roleTokenCommitmentRootSha256,
			approvedPlanSha256: grant.approvedPlanSha256,
			approvalRecordSha256: grant.approvalRecordSha256,
			rigExecutionIndex: 0,
			rigSupervisorInstanceNonce: HEX_2,
			signingPublicKeySha256: HEX_3,
			receiptSequence: 1,
			acceptedAtMs: 1_100,
			issuedAtMs: 1_100,
			notAfterMs: 2_000,
		};
		expect(parseRigCohortAcceptance(acceptance).ok).toBe(true);
		expect(parseRigCohortAcceptance({ ...acceptance, extra: 1 }).ok).toBe(
			false,
		);

		const drained = {
			schema: "rig-warmup-drained-receipt/v1" as const,
			executionSha256: grant.executionSha256,
			cohortGrantSha256: grantSha256,
			cohortWarmupEpochSha256: HEX_4,
			cohortWarmupEpochSignatureSha256: HEX_5,
			roleWarmupCompletionManifestSha256: HEX_6,
			roleWarmupCompletionManifestSignatureSha256: HEX_7,
			serverWarmupDrainedSha256: HEX_8,
			rigSupervisorInstanceNonce: HEX_9,
			signingPublicKeySha256: HEX_3,
			receiptSequence: 2,
			receivedAtRigNs: "6100000000",
			linuxClockId: "linux-clock-monotonic-raw",
			issuedAtMs: 1_200,
			notAfterMs: 2_000,
		};
		expect(parseRigWarmupDrainedReceipt(drained).ok).toBe(true);
		expect(
			parseRigWarmupDrainedReceipt({ ...drained, receivedAtRigNs: "-1" }).ok,
		).toBe(false);

		const barrierAcceptance = {
			schema: "rig-barrier-acceptance/v1" as const,
			executionSha256: grant.executionSha256,
			cohortGrantSha256: grantSha256,
			cohortStartBarrierSha256: HEX_A,
			cohortStartBarrierSignatureSha256: HEX_B,
			rigMeasureStartAckSha256: HEX_C,
			serverStartBarrierAcceptedSha256: HEX_D,
			rigSupervisorInstanceNonce: HEX_E,
			signingPublicKeySha256: HEX_3,
			receiptSequence: 3,
			acceptedAtLinuxNs: "6200000000",
			linuxClockId: "linux-clock-monotonic-raw",
			issuedAtMs: 1_300,
			notAfterMs: 2_000,
		};
		expect(parseRigBarrierAcceptance(barrierAcceptance).ok).toBe(true);
		expect(
			parseRigBarrierAcceptance({
				...barrierAcceptance,
				acceptedAtLinuxNs: "01",
			}).ok,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// §4.2 FanoutWire V1 and §4.3 Mac role-child control frames / global ramp
// ---------------------------------------------------------------------------

/** Deterministic payload of exactly `size` bytes with its base64 and digest. */
function payloadFixture(
	size: number,
	seed: number,
): { readonly base64: string; readonly sha256: string } {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index += 1) {
		bytes[index] = (seed + index * 31) % 256;
	}
	return {
		base64: Buffer.from(bytes).toString("base64"),
		sha256: sha256HexOfBytes(bytes),
	};
}

const TICKER_PAYLOAD = payloadFixture(FANOUT_TICKER_PAYLOAD_BYTES, 7);
const CHAT_PAYLOAD = payloadFixture(FANOUT_CHAT_PAYLOAD_BYTES, 11);

const GRANT_SHA = HEX_A;
const EPOCH_SHA = HEX_B;
const BARRIER_SHA = HEX_C;
const WARMUP_NONCE = HEX_9;

function warmupDataFrame(overrides: Record<string, unknown> = {}) {
	return {
		schema: "fanout-wire/v1",
		kind: "warmup-data",
		direction: "publisher-to-relay",
		cohortGrantSha256: GRANT_SHA,
		cohortWarmupEpochSha256: EPOCH_SHA,
		warmupNonce: WARMUP_NONCE,
		publisherId: "publisher-000003",
		publisherSequence: 0,
		subscriberId: null,
		linuxAcceptedOrdinal: null,
		payloadBase64: TICKER_PAYLOAD.base64,
		payloadSha256: TICKER_PAYLOAD.sha256,
		payloadBytes: FANOUT_TICKER_PAYLOAD_BYTES,
		...overrides,
	};
}

function measuredDataFrame(overrides: Record<string, unknown> = {}) {
	return {
		schema: "fanout-wire/v1",
		kind: "data",
		direction: "publisher-to-relay",
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		windowIndex: 0,
		publisherId: "publisher-000003",
		publisherSequence: 4,
		subscriberId: null,
		linuxAcceptedOrdinal: null,
		payloadBase64: CHAT_PAYLOAD.base64,
		payloadSha256: CHAT_PAYLOAD.sha256,
		payloadBytes: FANOUT_CHAT_PAYLOAD_BYTES,
		...overrides,
	};
}

function ackCommon(overrides: Record<string, unknown> = {}) {
	return {
		schema: "fanout-wire/v1",
		kind: "ack",
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		windowIndex: 2,
		publisherId: "publisher-000003",
		publisherSequence: 4,
		...overrides,
	};
}

function acceptedAck(overrides: Record<string, unknown> = {}) {
	return ackCommon({
		disposition: "accepted",
		linuxAcceptedOrdinal: 17,
		linuxAcceptedAtNs: "6200000001",
		code: null,
		...overrides,
	});
}

function registerFrame(overrides: Record<string, unknown> = {}) {
	const token = new Uint8Array(32);
	for (let index = 0; index < 32; index += 1) token[index] = index * 3 + 1;
	return {
		schema: "fanout-wire/v1",
		kind: "register",
		cohortGrantSha256: GRANT_SHA,
		transport: "ws",
		role: "subscriber",
		childId: "subscriber-worker-3",
		roleId: "subscriber-000003",
		workerIndex: 3,
		tokenBase64: Buffer.from(token).toString("base64"),
		tokenSha256: sha256HexOfBytes(token),
		tokenCommitmentIndex: 13,
		tokenMerkleProofSha256: [HEX_1, HEX_2, HEX_3],
		...overrides,
	};
}

const RAMP_EPOCH_MAC_NS = "1000000000000";

function permitRequest(overrides: Record<string, unknown> = {}) {
	return {
		schema: "connect-permit-request/v1",
		sequence: 1,
		executionSha256: HEX_1,
		cohortGrantSha256: GRANT_SHA,
		childId: "subscriber-worker-1",
		globalOrdinal: 9,
		roleId: "subscriber-000009",
		...overrides,
	};
}

function permitGrant(overrides: Record<string, unknown> = {}) {
	return {
		schema: "connect-permit-grant/v1",
		sequence: 2,
		executionSha256: HEX_1,
		cohortGrantSha256: GRANT_SHA,
		childId: "subscriber-worker-1",
		globalOrdinal: 9,
		notBeforeMacNs: "1000018000000",
		permitNonce: HEX_4,
		...overrides,
	};
}

describe("cohort-protocol B1 §4.2/§4.3", () => {
	test("warmup_wire_uses_grant_nonce_not_measured_barrier", () => {
		// A warmup frame is bound to the signed epoch nonce.
		const warmup = parseFanoutWire(warmupDataFrame());
		expect(warmup.ok).toBe(true);

		// Smuggling a measured barrier into a warmup frame is WARMUP_PROTOCOL,
		// not a generic key error: the two epochs must never be conflatable.
		const barriered = parseFanoutWire(
			warmupDataFrame({ cohortStartBarrierSha256: BARRIER_SHA }),
		);
		expect(barriered.ok).toBe(false);
		if (!barriered.ok) expect(barriered.code).toBe("WARMUP_PROTOCOL");

		const windowed = parseFanoutWire(warmupDataFrame({ windowIndex: 0 }));
		expect(windowed.ok).toBe(false);
		if (!windowed.ok) expect(windowed.code).toBe("WARMUP_PROTOCOL");

		// And the reverse: a measured frame may not carry warmup identity.
		expect(parseFanoutWire(measuredDataFrame()).ok).toBe(true);
		const nonced = parseFanoutWire(
			measuredDataFrame({ warmupNonce: WARMUP_NONCE }),
		);
		expect(nonced.ok).toBe(false);
		if (!nonced.ok) expect(nonced.code).toBe("WARMUP_PROTOCOL");
		const epoched = parseFanoutWire(
			measuredDataFrame({ cohortWarmupEpochSha256: EPOCH_SHA }),
		);
		expect(epoched.ok).toBe(false);
		if (!epoched.ok) expect(epoched.code).toBe("WARMUP_PROTOCOL");

		// Binding checks reject a well-formed warmup frame from another epoch.
		expect(
			requireWarmupFrameBinding(warmupDataFrame(), {
				cohortGrantSha256: GRANT_SHA,
				cohortWarmupEpochSha256: EPOCH_SHA,
				warmupNonce: WARMUP_NONCE,
			}).ok,
		).toBe(true);
		const crossEpoch = requireWarmupFrameBinding(warmupDataFrame(), {
			cohortGrantSha256: GRANT_SHA,
			cohortWarmupEpochSha256: EPOCH_SHA,
			warmupNonce: HEX_8,
		});
		expect(crossEpoch.ok).toBe(false);
		if (!crossEpoch.ok) expect(crossEpoch.code).toBe("WARMUP_PROTOCOL");

		// A measured frame is not admissible as warmup and vice versa.
		expect(
			requireWarmupFrameBinding(measuredDataFrame(), {
				cohortGrantSha256: GRANT_SHA,
				cohortWarmupEpochSha256: EPOCH_SHA,
				warmupNonce: WARMUP_NONCE,
			}).ok,
		).toBe(false);
		expect(
			requireMeasuredFrameBinding(warmupDataFrame(), {
				cohortGrantSha256: GRANT_SHA,
				cohortStartBarrierSha256: BARRIER_SHA,
			}).ok,
		).toBe(false);

		// The Mac-side warmup start frame carries the same nonce and no barrier.
		const epochBytes = bytesOfCanonical({ schema: "cohort-warmup-epoch/v1" });
		const epochSignature = new Uint8Array(64).fill(5);
		const warmupStart = {
			schema: "role-warmup-start/v1",
			sequence: 5,
			executionSha256: HEX_1,
			cohortGrantSha256: GRANT_SHA,
			cohortWarmupEpochBase64: Buffer.from(epochBytes).toString("base64"),
			cohortWarmupEpochSha256: sha256HexOfBytes(epochBytes),
			cohortWarmupEpochSignatureBase64:
				Buffer.from(epochSignature).toString("base64"),
			cohortWarmupEpochSignatureSha256: sha256HexOfBytes(epochSignature),
			warmupNonce: WARMUP_NONCE,
			expectedChildOfferedWarmupIngress: 10,
			expectedChildDeliveredWarmupRecords: 0,
			startAtMacNs: "1100000000",
			durationMs: WARMUP_DURATION_MS,
		};
		expect(parseRoleWarmupStart(warmupStart).ok).toBe(true);
		const smuggled = parseRoleWarmupStart({
			...warmupStart,
			cohortStartBarrierSha256: BARRIER_SHA,
		});
		expect(smuggled.ok).toBe(false);
		if (!smuggled.ok) expect(smuggled.code).toBe("WARMUP_PROTOCOL");

		const warmupComplete = {
			schema: "role-warmup-complete/v1",
			sequence: 6,
			executionSha256: HEX_1,
			cohortGrantSha256: GRANT_SHA,
			cohortWarmupEpochSha256: EPOCH_SHA,
			warmupNonce: WARMUP_NONCE,
			childId: "publisher-000003",
			role: "publisher",
			startedAtMacNs: "1100000000",
			completedAtMacNs: "6100000000",
			offeredWarmupIngress: 10,
			deliveredWarmupRecords: 0,
		};
		expect(parseRoleWarmupComplete(warmupComplete).ok).toBe(true);
		expect(
			parseRoleWarmupComplete({
				...warmupComplete,
				completedAtMacNs: "1000000000",
			}).ok,
		).toBe(false);
	});

	test("barrier_requires_authenticated_rig_baseline_and_linux_acceptance", () => {
		const grant = cohortGrant();
		const grantSha256 = sha256CanonicalRecord(grant);
		const barrier = startBarrier(grant.executionSha256, grantSha256);
		const barrierSha256 = sha256CanonicalRecord(barrier);

		// All four retained rig/warmup digests present: the barrier is legal.
		expect(
			validateCohortStartBarrierPreconditions({
				barrier,
				rigCohortAcceptanceSha256: HEX_A,
				rigMeasureStartAckSha256: HEX_B,
				roleWarmupCompletionManifestSha256: HEX_C,
				rigWarmupDrainedReceiptSha256: HEX_E,
			}).ok,
		).toBe(true);

		// Without the authenticated Linux cohort acceptance there is no rig
		// baseline to bind to, so the barrier is COHORT_NOT_READY.
		const unaccepted = validateCohortStartBarrierPreconditions({
			barrier,
			rigCohortAcceptanceSha256: HEX_F,
			rigMeasureStartAckSha256: HEX_B,
			roleWarmupCompletionManifestSha256: HEX_C,
			rigWarmupDrainedReceiptSha256: HEX_E,
		});
		expect(unaccepted.ok).toBe(false);
		if (!unaccepted.ok) expect(unaccepted.code).toBe("COHORT_NOT_READY");

		// The Linux acceptance names the exact barrier digest it accepted.
		const acceptance = {
			schema: "rig-barrier-acceptance/v1" as const,
			executionSha256: grant.executionSha256,
			cohortGrantSha256: grantSha256,
			cohortStartBarrierSha256: barrierSha256,
			cohortStartBarrierSignatureSha256: HEX_B,
			rigMeasureStartAckSha256: HEX_C,
			serverStartBarrierAcceptedSha256: HEX_D,
			rigSupervisorInstanceNonce: HEX_E,
			signingPublicKeySha256: HEX_3,
			receiptSequence: 3,
			acceptedAtLinuxNs: "6200000000",
			linuxClockId: "linux-clock-monotonic-raw",
			issuedAtMs: 1_300,
			notAfterMs: 2_000,
		};
		const parsedAcceptance = parseRigBarrierAcceptance(acceptance);
		expect(parsedAcceptance.ok).toBe(true);
		if (!parsedAcceptance.ok) throw new Error("acceptance");
		expect(parsedAcceptance.value.cohortStartBarrierSha256).toBe(barrierSha256);

		// Measured wire traffic is admissible only against that accepted barrier.
		expect(
			requireMeasuredFrameBinding(
				measuredDataFrame({
					cohortGrantSha256: grantSha256,
					cohortStartBarrierSha256:
						parsedAcceptance.value.cohortStartBarrierSha256,
				}),
				{
					cohortGrantSha256: grantSha256,
					cohortStartBarrierSha256: barrierSha256,
				},
			).ok,
		).toBe(true);
		const foreignBarrier = requireMeasuredFrameBinding(
			measuredDataFrame({ cohortGrantSha256: grantSha256 }),
			{
				cohortGrantSha256: grantSha256,
				cohortStartBarrierSha256: barrierSha256,
			},
		);
		expect(foreignBarrier.ok).toBe(false);
		if (!foreignBarrier.ok) expect(foreignBarrier.code).toBe("COHORT_PROTOCOL");

		// The child's measure-start ack repeats the barrier digest it armed on.
		const measureStart = {
			schema: "role-measure-start/v1",
			sequence: 7,
			executionSha256: grant.executionSha256,
			cohortStartBarrierBase64: Buffer.from(bytesOfCanonical(barrier)).toString(
				"base64",
			),
		};
		expect(parseRoleMeasureStart(measureStart).ok).toBe(true);
		const ack = {
			schema: "role-measure-start-ack/v1",
			sequence: 8,
			executionSha256: grant.executionSha256,
			childId: "publisher-000000",
			cohortStartBarrierSha256: barrierSha256,
			armedAtMacNs: "6200000000",
		};
		expect(parseRoleMeasureStartAck(ack).ok).toBe(true);
		expect(
			parseRoleMeasureStartAck({ ...ack, cohortStartBarrierSha256: "nope" }).ok,
		).toBe(false);

		const stop = {
			schema: "role-stop/v1",
			sequence: 9,
			executionSha256: grant.executionSha256,
			cohortStartBarrierSha256: barrierSha256,
			stopAtMacNs: "36200000000",
		};
		expect(parseRoleStop(stop).ok).toBe(true);
		expect(parseRoleStop({ ...stop, stopAtMacNs: "-1" }).ok).toBe(false);
	});

	test("publisher_and_subscriber_total_ordinals_are_contiguous", () => {
		const publisherCount = 10;
		const subscriberCount = 1_000;
		expect(globalOrdinalCount({ publisherCount, subscriberCount })).toBe(1_010);

		const enumerated = enumerateGlobalOrdinals({
			publisherCount,
			subscriberCount,
		});
		expect(enumerated.ok).toBe(true);
		if (!enumerated.ok) throw new Error("ordinals");
		const assignments = enumerated.value;
		expect(assignments.length).toBe(1_010);

		// One domain, every ordinal exactly once, every role ID exactly once.
		const ordinals = new Set(assignments.map((a) => a.globalOrdinal));
		const roleIds = new Set(assignments.map((a) => a.roleId));
		expect(ordinals.size).toBe(1_010);
		expect(roleIds.size).toBe(1_010);
		for (let index = 0; index < 1_010; index += 1) {
			expect(assignments[index]!.globalOrdinal).toBe(index);
		}

		// Subscribers occupy 0..999, worker = ordinal mod 8.
		expect(assignments[0]!.roleId).toBe("subscriber-000000");
		expect(assignments[0]!.workerIndex).toBe(0);
		expect(assignments[9]!.roleId).toBe("subscriber-000009");
		expect(assignments[9]!.workerIndex).toBe(1);
		expect(assignments[999]!.roleId).toBe("subscriber-000999");
		expect(assignments[999]!.workerIndex).toBe(999 % SUBSCRIBER_SHARD_MODULUS);

		// Publishers follow contiguously with no gap and carry no shard.
		expect(assignments[1_000]!.role).toBe("publisher");
		expect(assignments[1_000]!.roleId).toBe("publisher-000000");
		expect(assignments[1_000]!.workerIndex).toBe(null);
		expect(assignments[1_009]!.roleId).toBe("publisher-000009");

		const resolved = resolveGlobalOrdinal({
			globalOrdinal: 1_005,
			publisherCount,
			subscriberCount,
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) throw new Error("resolve");
		expect(resolved.value.roleId).toBe("publisher-000005");

		// One past the end is not a member of the domain.
		expect(
			resolveGlobalOrdinal({
				globalOrdinal: 1_010,
				publisherCount,
				subscriberCount,
			}).ok,
		).toBe(false);

		// permit time = rampEpochMacNs + floor(ordinal * 1e9 / 500).
		const first = permitNotBeforeMacNs({
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			globalOrdinal: 0,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("permit");
		expect(first.value).toBe(RAMP_EPOCH_MAC_NS);
		const nine = permitNotBeforeMacNs({
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			globalOrdinal: 9,
		});
		if (!nine.ok) throw new Error("permit");
		expect(nine.value).toBe("1000018000000");
		const fiveHundred = permitNotBeforeMacNs({
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			globalOrdinal: COHORT_CONNECTION_RATE_PER_SECOND,
		});
		if (!fiveHundred.ok) throw new Error("permit");
		expect(BigInt(fiveHundred.value) - BigInt(RAMP_EPOCH_MAC_NS)).toBe(
			1_000_000_000n,
		);

		const request = permitRequest();
		expect(parseConnectPermitRequest(request).ok).toBe(true);
		const grantFrame = permitGrant();
		expect(parseConnectPermitGrant(grantFrame).ok).toBe(true);

		const admitted = validateConnectPermitGrant({
			request,
			grant: grantFrame,
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			publisherCount,
			subscriberCount,
			inFlightBefore: 199,
		});
		expect(admitted.ok).toBe(true);

		// A grant to the wrong deterministic owner is COHORT_NOT_READY.
		const wrongOwner = validateConnectPermitGrant({
			request: permitRequest({ roleId: "subscriber-000010" }),
			grant: grantFrame,
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			publisherCount,
			subscriberCount,
			inFlightBefore: 0,
		});
		expect(wrongOwner.ok).toBe(false);
		if (!wrongOwner.ok) expect(wrongOwner.code).toBe("COHORT_NOT_READY");

		// Early grants and a 200th in-flight permit are both refused.
		const early = validateConnectPermitGrant({
			request,
			grant: permitGrant({ notBeforeMacNs: "1000017999999" }),
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			publisherCount,
			subscriberCount,
			inFlightBefore: 0,
		});
		expect(early.ok).toBe(false);
		if (!early.ok) expect(early.code).toBe("COHORT_NOT_READY");
		const saturated = validateConnectPermitGrant({
			request,
			grant: grantFrame,
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			publisherCount,
			subscriberCount,
			inFlightBefore: PERMIT_MAX_IN_FLIGHT,
		});
		expect(saturated.ok).toBe(false);
		if (!saturated.ok) expect(saturated.code).toBe("COHORT_NOT_READY");
		expect(PERMIT_MAX_IN_FLIGHT).toBe(200);

		const complete = {
			schema: "connect-permit-complete/v1",
			sequence: 3,
			executionSha256: HEX_1,
			cohortGrantSha256: GRANT_SHA,
			childId: "subscriber-worker-1",
			globalOrdinal: 9,
			permitNonce: HEX_4,
			startedAtMacNs: "1000018000000",
			completedAtMacNs: "1000019000000",
			outcome: "ready",
		};
		expect(parseConnectPermitComplete(complete).ok).toBe(true);
		expect(
			validateConnectPermitCompletion({
				complete,
				grant: grantFrame,
				readinessDeadlineMs: READINESS_DEADLINE_MS_CHAT_1K,
				rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			}).ok,
		).toBe(true);

		// Starting before the permit time, replaying another nonce, or finishing
		// after the readiness deadline are all COHORT_NOT_READY.
		const earlyStart = validateConnectPermitCompletion({
			complete: { ...complete, startedAtMacNs: "1000017999999" },
			grant: grantFrame,
			readinessDeadlineMs: READINESS_DEADLINE_MS_CHAT_1K,
			rampEpochMacNs: RAMP_EPOCH_MAC_NS,
		});
		expect(earlyStart.ok).toBe(false);
		if (!earlyStart.ok) expect(earlyStart.code).toBe("COHORT_NOT_READY");
		expect(
			validateConnectPermitCompletion({
				complete: { ...complete, permitNonce: HEX_5 },
				grant: grantFrame,
				readinessDeadlineMs: READINESS_DEADLINE_MS_CHAT_1K,
				rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			}).ok,
		).toBe(false);
		expect(
			validateConnectPermitCompletion({
				complete: {
					...complete,
					completedAtMacNs: "1090000000001",
				},
				grant: grantFrame,
				readinessDeadlineMs: READINESS_DEADLINE_MS_CHAT_1K,
				rampEpochMacNs: RAMP_EPOCH_MAC_NS,
			}).ok,
		).toBe(false);

		// No role child is ever replaced.
		expect(COHORT_ROLE_REPLACEMENT_COUNT).toBe(0);
		expect(validateNoRoleReplacements(0).ok).toBe(true);
		const replaced = validateNoRoleReplacements(1);
		expect(replaced.ok).toBe(false);
		if (!replaced.ok) expect(replaced.code).toBe("COHORT_NOT_READY");
	});

	test("fanout_ack_union_rejects_unknown_code_and_illegal_nulls", () => {
		expect(parseFanoutAck(acceptedAck()).ok).toBe(true);

		// An accepted ack carries the Linux ordinal and instant and a null code.
		expect(
			parseFanoutAck(acceptedAck({ code: "REGISTRATION_CLOSED" })).ok,
		).toBe(false);
		expect(parseFanoutAck(acceptedAck({ linuxAcceptedOrdinal: null })).ok).toBe(
			false,
		);
		expect(parseFanoutAck(acceptedAck({ linuxAcceptedAtNs: null })).ok).toBe(
			false,
		);
		expect(parseFanoutAck(acceptedAck({ linuxAcceptedOrdinal: -1 })).ok).toBe(
			false,
		);

		// Every non-accepted disposition must null out both accepted-ingress
		// fields; a number there would fabricate an acceptance.
		const duplicate = ackCommon({
			disposition: "duplicate",
			linuxAcceptedOrdinal: null,
			linuxAcceptedAtNs: null,
			code: "DUPLICATE_PUBLISHER_SEQUENCE",
		});
		expect(parseFanoutAck(duplicate).ok).toBe(true);
		expect(parseFanoutAck({ ...duplicate, linuxAcceptedOrdinal: 17 }).ok).toBe(
			false,
		);
		expect(
			parseFanoutAck({ ...duplicate, linuxAcceptedAtNs: "6200000001" }).ok,
		).toBe(false);
		expect(
			parseFanoutAck({ ...duplicate, code: "REORDERED_PUBLISHER_SEQUENCE" }).ok,
		).toBe(false);

		const reordered = ackCommon({
			disposition: "reordered",
			linuxAcceptedOrdinal: null,
			linuxAcceptedAtNs: null,
			code: "REORDERED_PUBLISHER_SEQUENCE",
		});
		expect(parseFanoutAck(reordered).ok).toBe(true);
		expect(parseFanoutAck({ ...reordered, code: null }).ok).toBe(false);

		for (const code of FANOUT_ACK_CLOSED_CODES) {
			expect(
				parseFanoutAck(
					ackCommon({
						disposition: "closed",
						linuxAcceptedOrdinal: null,
						linuxAcceptedAtNs: null,
						code,
					}),
				).ok,
			).toBe(true);
		}
		const unknown = parseFanoutAck(
			ackCommon({
				disposition: "closed",
				linuxAcceptedOrdinal: null,
				linuxAcceptedAtNs: null,
				code: "SUBSCRIBER_TOO_SLOW",
			}),
		);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.code).toBe("COHORT_PROTOCOL");

		// Unknown dispositions, unknown keys, and missing keys all fail.
		expect(
			parseFanoutAck(
				ackCommon({
					disposition: "maybe",
					linuxAcceptedOrdinal: null,
					linuxAcceptedAtNs: null,
					code: null,
				}),
			).ok,
		).toBe(false);
		expect(parseFanoutAck({ ...acceptedAck(), extra: 1 }).ok).toBe(false);
		const missing: Record<string, unknown> = { ...acceptedAck() };
		delete missing.windowIndex;
		expect(parseFanoutAck(missing).ok).toBe(false);

		// The union dispatcher reaches the same verdicts.
		expect(parseFanoutWire(acceptedAck()).ok).toBe(true);
		expect(parseFanoutWire({ ...acceptedAck(), kind: "acked" }).ok).toBe(false);
	});

	test("fanout wire framing enforces the WS and WT caps exactly", () => {
		expect(FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES).toBe(4_096);
		expect(FANOUT_DATA_FRAME_MAX_DECODED_BYTES).toBe(1_024);
		expect(FANOUT_WT_LENGTH_PREFIX_BYTES).toBe(4);
		expect(FANOUT_TICKER_PAYLOAD_BYTES).toBe(100);
		expect(FANOUT_CHAT_PAYLOAD_BYTES).toBe(128);

		const encoded = encodeFanoutWsMessage(measuredDataFrame());
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) throw new Error("encode");
		expect(encoded.value.byteLength).toBeLessThanOrEqual(
			FANOUT_DATA_FRAME_MAX_DECODED_BYTES,
		);
		const roundTrip = decodeFanoutWsMessage(encoded.value);
		expect(roundTrip.ok).toBe(true);

		// One WS binary message carries exactly one frame: concatenation fails.
		const doubled = new Uint8Array(encoded.value.byteLength * 2);
		doubled.set(encoded.value, 0);
		doubled.set(encoded.value, encoded.value.byteLength);
		expect(decodeFanoutWsMessage(doubled).ok).toBe(false);

		// A data frame over the 1 KiB cap is refused before it is believed.
		const oversize = measuredDataFrame({
			publisherId: `publisher-${"0".repeat(6)}`,
			subscriberId: "s".repeat(500),
			direction: "relay-to-subscriber",
			linuxAcceptedOrdinal: 1,
		});
		expect(encodeFanoutWsMessage(oversize).ok).toBe(false);

		// WT reliable streams are u32be length-prefixed and frame-exact.
		const wtFirst = encodeFanoutWtFrame(registerFrame());
		const wtSecond = encodeFanoutWtFrame(measuredDataFrame());
		expect(wtFirst.ok && wtSecond.ok).toBe(true);
		if (!wtFirst.ok || !wtSecond.ok) throw new Error("wt encode");
		const stream = new Uint8Array(
			wtFirst.value.byteLength + wtSecond.value.byteLength,
		);
		stream.set(wtFirst.value, 0);
		stream.set(wtSecond.value, wtFirst.value.byteLength);
		const decodedStream = decodeFanoutWtStream(stream);
		expect(decodedStream.ok).toBe(true);
		if (!decodedStream.ok) throw new Error("wt decode");
		expect(decodedStream.value.length).toBe(2);
		expect(decodedStream.value[0]!.kind).toBe("register");

		// Truncated bodies and short prefixes are refused, never partially read.
		expect(
			decodeFanoutWtStream(stream.subarray(0, stream.byteLength - 1)).ok,
		).toBe(false);
		expect(decodeFanoutWtStream(new Uint8Array([0, 0, 1])).ok).toBe(false);
		const lying = new Uint8Array(8);
		new DataView(lying.buffer).setUint32(0, 0xffff, false);
		expect(decodeFanoutWtStream(lying).ok).toBe(false);

		// Payload base64, digest, and declared size must all agree.
		expect(
			parseFanoutWire(
				measuredDataFrame({ payloadBytes: FANOUT_TICKER_PAYLOAD_BYTES }),
			).ok,
		).toBe(false);
		expect(
			parseFanoutWire(measuredDataFrame({ payloadSha256: HEX_F })).ok,
		).toBe(false);
		expect(parseFanoutWire(measuredDataFrame({ payloadBytes: 64 })).ok).toBe(
			false,
		);

		// A publisher never authors accepted ingress; the relay always does.
		expect(
			parseFanoutWire(measuredDataFrame({ linuxAcceptedOrdinal: 3 })).ok,
		).toBe(false);
		expect(
			parseFanoutWire(
				measuredDataFrame({
					direction: "relay-to-subscriber",
					subscriberId: "subscriber-000004",
					linuxAcceptedOrdinal: 3,
				}),
			).ok,
		).toBe(true);
		expect(
			parseFanoutWire(
				measuredDataFrame({
					direction: "relay-to-subscriber",
					subscriberId: "subscriber-000004",
					linuxAcceptedOrdinal: null,
				}),
			).ok,
		).toBe(false);

		// Register/refuse/accept/end round-trip with exact codes.
		expect(parseFanoutWire(registerFrame()).ok).toBe(true);
		expect(parseFanoutWire(registerFrame({ workerIndex: null })).ok).toBe(
			false,
		);
		expect(
			parseFanoutWire(registerFrame({ role: "publisher", workerIndex: null }))
				.ok,
		).toBe(false);
		expect(parseFanoutWire(registerFrame({ tokenSha256: HEX_F })).ok).toBe(
			false,
		);
		for (const code of FANOUT_REFUSE_CODES) {
			expect(
				parseFanoutWire({
					schema: "fanout-wire/v1",
					kind: "refuse",
					cohortGrantSha256: GRANT_SHA,
					role: "subscriber",
					roleId: "subscriber-000003",
					code,
				}).ok,
			).toBe(true);
		}
		expect(
			parseFanoutWire({
				schema: "fanout-wire/v1",
				kind: "accept",
				cohortGrantSha256: GRANT_SHA,
				role: "subscriber",
				roleId: "subscriber-000003",
				linuxSessionOrdinal: 3,
				linuxAcceptedAtNs: "6200000000",
				linuxClockId: "linux-clock-monotonic-raw",
			}).ok,
		).toBe(true);
		expect(
			parseFanoutWire({
				schema: "fanout-wire/v1",
				kind: "end",
				cohortGrantSha256: GRANT_SHA,
				cohortStartBarrierSha256: BARRIER_SHA,
				role: "publisher",
				roleId: "publisher-000003",
				finalWindowIndex: 29,
				finalPublisherSequence: 1_000,
				reason: "publisher-complete",
			}).ok,
		).toBe(true);
		expect(
			parseFanoutWire({
				schema: "fanout-wire/v1",
				kind: "end",
				cohortGrantSha256: GRANT_SHA,
				cohortStartBarrierSha256: BARRIER_SHA,
				role: "publisher",
				roleId: "publisher-000003",
				finalWindowIndex: 29,
				finalPublisherSequence: null,
				reason: "publisher-complete",
			}).ok,
		).toBe(false);

		// Warmup end and warmup ack carry the epoch, never the barrier.
		expect(
			parseFanoutWire({
				schema: "fanout-wire/v1",
				kind: "warmup-ack",
				cohortGrantSha256: GRANT_SHA,
				cohortWarmupEpochSha256: EPOCH_SHA,
				warmupNonce: WARMUP_NONCE,
				publisherId: "publisher-000003",
				publisherSequence: 0,
				disposition: "accepted",
				linuxAcceptedOrdinal: 0,
				linuxAcceptedAtNs: "1100000000",
			}).ok,
		).toBe(true);
		expect(
			parseFanoutWire({
				schema: "fanout-wire/v1",
				kind: "warmup-end",
				cohortGrantSha256: GRANT_SHA,
				cohortWarmupEpochSha256: EPOCH_SHA,
				warmupNonce: WARMUP_NONCE,
				role: "subscriber",
				roleId: "subscriber-000003",
				finalPublisherSequence: null,
				reason: "relay-warmup-drained",
			}).ok,
		).toBe(true);
	});

	test("role child control frames parse with exact keys under the 8 KiB cap", () => {
		expect(ROLE_CHILD_FRAME_MAX_BYTES).toBe(8_192);
		expect(ROLE_SPAWN_CONFIG_MAX_BYTES).toBe(524_288);
		expect(COHORT_SERVER_HOST).toBe("10.99.0.2");
		expect(COHORT_TLS_SERVER_NAME).toBe("wt-compare.local");

		const grant = cohortGrant();
		const grantBytes = bytesOfCanonical(grant);
		const grantSha256 = sha256HexOfBytes(grantBytes);
		const launch = {
			schema: "staged-server-launch-record/v1" as const,
			stageReceiptSha256: HEX_1,
			serverEntrypointSha256: HEX_2,
			bunSha256: HEX_3,
			addonSha256: HEX_4,
			bindAddress: "10.99.0.2" as const,
			bindPort: 4_433,
			advertisedHost: "10.99.0.2" as const,
			tlsServerName: "wt-compare.local" as const,
			tlsCertificateSha256: HEX_1,
			tlsPrivateKeySha256: HEX_2,
			transport: "ws" as const,
			argv: [
				"server.ts",
				"--transport=ws",
				"--mode=fanout-cohort",
				"--stage-profile=phase-b",
				"--bind=10.99.0.2",
			],
			allowedEnvironment: [{ name: "PATH", value: "/usr/bin" }],
		};
		expect(parseStagedServerLaunchRecord(launch).ok).toBe(true);
		expect(parseStagedServerLaunchRecord({ ...launch, bindPort: 0 }).ok).toBe(
			false,
		);
		expect(
			parseStagedServerLaunchRecord({
				...launch,
				allowedEnvironment: [
					{ name: "PATH", value: "/usr/bin" },
					{ name: "PATH", value: "/bin" },
				],
			}).ok,
		).toBe(false);
		expect(
			parseStagedServerLaunchRecord({
				...launch,
				allowedEnvironment: [
					{ name: "PATH", value: "/usr/bin" },
					{ name: "HOME", value: "/root" },
				],
			}).ok,
		).toBe(false);

		const launchBytes = bytesOfCanonical(launch);
		const workload = { schema: "canonical-workload-role-plan-input/v1" };
		const workloadBytes = bytesOfCanonical(workload);
		const publicKey = new Uint8Array(32).fill(9);
		const signature = new Uint8Array(64).fill(3);
		const config = {
			schema: "role-spawn-config/v1",
			sequence: 1,
			executionSha256: grant.executionSha256,
			cohortGrantSha256: grantSha256,
			cohortGrantBase64: Buffer.from(grantBytes).toString("base64"),
			cohortGrantSignatureBase64: Buffer.from(signature).toString("base64"),
			workloadRolePlanInputBase64:
				Buffer.from(workloadBytes).toString("base64"),
			workloadRolePlanInputSha256: sha256HexOfBytes(workloadBytes),
			stagedServerLaunchRecordBase64:
				Buffer.from(launchBytes).toString("base64"),
			stagedServerLaunchRecordSha256: sha256HexOfBytes(launchBytes),
			stagedServerLaunchRecordSize: launchBytes.byteLength,
			childId: "publisher-000000",
			role: "publisher",
			publisherId: "publisher-000000",
			workerIndex: null,
			childInstanceNonce: HEX_5,
			tokenBundleFd: TOKEN_BUNDLE_FD,
			tokenBundleSha256: HEX_6,
			tokenBundleSize: 4_096,
			tokenBundleEntryCount: 1,
			tokenBundleMaxSize: TOKEN_BUNDLE_MAX_SIZE,
			transport: "ws",
			serverHost: "10.99.0.2",
			serverPort: 4_433,
			tlsServerName: "wt-compare.local",
			messageRatePerSecond: 30,
			warmupMessagesPerPublisher: WARMUP_MESSAGES_PER_PUBLISHER,
			warmupIntervalMs: WARMUP_INTERVAL_MS,
			warmupDurationMs: WARMUP_DURATION_MS,
			measuredDurationMs: 30_000,
			measuredSampleWindowMs: COHORT_SAMPLE_WINDOW_MS,
			payloadBytes: 100,
			channelMapping: "ws-binary-message-per-frame",
			macSigningPublicKeyBase64: Buffer.from(publicKey).toString("base64"),
			macSigningPublicKeySha256: sha256HexOfBytes(publicKey),
		};
		expect(parseRoleSpawnConfig(config).ok).toBe(true);

		// serverPort must equal the embedded staged launch record's bindPort.
		const driftedPort = parseRoleSpawnConfig({ ...config, serverPort: 4_434 });
		expect(driftedPort.ok).toBe(false);
		if (!driftedPort.ok) expect(driftedPort.code).toBe("COHORT_PROTOCOL");
		expect(
			parseRoleSpawnConfig({ ...config, stagedServerLaunchRecordSize: 1 }).ok,
		).toBe(false);
		expect(
			parseRoleSpawnConfig({ ...config, cohortGrantSha256: HEX_F }).ok,
		).toBe(false);
		expect(
			parseRoleSpawnConfig({ ...config, macSigningPublicKeySha256: HEX_F }).ok,
		).toBe(false);
		expect(parseRoleSpawnConfig({ ...config, tokenBundleFd: 3 }).ok).toBe(
			false,
		);
		expect(
			parseRoleSpawnConfig({
				...config,
				tokenBundleSize: TOKEN_BUNDLE_MAX_SIZE + 1,
			}).ok,
		).toBe(false);
		expect(
			parseRoleSpawnConfig({
				...config,
				role: "subscriber-worker",
				publisherId: "publisher-000000",
			}).ok,
		).toBe(false);
		expect(
			parseRoleSpawnConfig({
				...config,
				role: "subscriber-worker",
				publisherId: null,
				workerIndex: 3,
				childId: "subscriber-worker-3",
			}).ok,
		).toBe(true);
		expect(parseRoleSpawnConfig({ ...config, extra: 1 }).ok).toBe(false);

		const ready = {
			schema: "role-ready/v1",
			sequence: 2,
			executionSha256: grant.executionSha256,
			cohortGrantSha256: grantSha256,
			childId: "publisher-000000",
			childPid: 4_242,
			childPgid: 4_242,
			childInstanceNonce: HEX_5,
			registeredSessionCount: 1,
		};
		expect(parseRoleReady(ready).ok).toBe(true);
		expect(parseRoleReady({ ...ready, childPid: 0 }).ok).toBe(false);

		const partialBytes = bytesOfCanonical({ schema: "publisher-partial/v1" });
		const partial = {
			schema: "role-partial/v1",
			sequence: 3,
			executionSha256: grant.executionSha256,
			childId: "publisher-000000",
			partialKind: "publisher",
			partialBase64: Buffer.from(partialBytes).toString("base64"),
			partialSha256: sha256HexOfBytes(partialBytes),
		};
		expect(parseRolePartial(partial).ok).toBe(true);
		expect(parseRolePartial({ ...partial, partialSha256: HEX_F }).ok).toBe(
			false,
		);
		expect(
			parseRolePartialAccepted({
				schema: "role-partial-accepted/v1",
				sequence: 4,
				executionSha256: grant.executionSha256,
				childId: "publisher-000000",
				partialSha256: partial.partialSha256,
			}).ok,
		).toBe(true);

		const exit = {
			schema: "role-exit/v1",
			sequence: 5,
			executionSha256: grant.executionSha256,
			childId: "publisher-000000",
		};
		expect(parseRoleExit(exit).ok).toBe(true);
		expect(
			parseRoleExited({
				schema: "role-exited/v1",
				sequence: 6,
				executionSha256: grant.executionSha256,
				childId: "publisher-000000",
				exitCode: 0,
			}).ok,
		).toBe(true);
		expect(
			parseRoleExited({
				schema: "role-exited/v1",
				sequence: 6,
				executionSha256: grant.executionSha256,
				childId: "publisher-000000",
				exitCode: -1,
			}).ok,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// §4.4 partial/manifest/process/Linux/receipt/artifact schemas and the §4.5
// offline recomputation equations.
// ---------------------------------------------------------------------------

import {
	COHORT_ADMISSION_RECEIPT_MAX_BYTES,
	COHORT_ADMISSION_SIGNATURE_MAX_BYTES,
	COHORT_CELL_CARDINALITIES,
	COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
	COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES,
	COHORT_REMOTE_EVIDENCE_BUDGET_BYTES,
	type CohortAdmissionReceiptV1,
	cohortCellCardinality,
	computeCohortEventWindow,
	correlateCohortExportSequences,
	decodeRawCohortEvidenceBundle,
	LINUX_RELAY_OBSERVATION_MAX_BYTES,
	type LinuxRelayObservationV1,
	OBSERVED_PROCESS_PROOF_MAX_BYTES,
	ORDERED_PARTIAL_MANIFEST_MAX_BYTES,
	observedChildrenDigestSha256,
	orderedPartialDigestSetSha256,
	PUBLISHER_PARTIAL_MAX_BYTES,
	type PublisherPartialV1,
	parseCohortObservationEvidence,
	parseLinuxRelayObservation,
	parseObservedProcessProof,
	parseOrderedPartialManifest,
	parsePublisherPartial,
	parseWorkerPartial,
	type RetainedCanonicalBytesV1,
	RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	WORKER_PARTIAL_MAX_BYTES,
	type WorkerPartialV1,
} from "./cohort-protocol.ts";
import { toBase64 } from "./cross-supervisor-protocol.ts";

const S44_WINDOWS = 10;
const S44_SUBSCRIBERS = 8;
const S44_MESSAGE_BYTES = 100 as const;
const S44_START_NS = 1_000_000_000_000n;
const S44_STOP_NS = S44_START_NS + 10_000_000_000n;

function s44Zeros(length: number): number[] {
	return Array.from({ length }, () => 0);
}

function s44Retain(value: unknown): RetainedCanonicalBytesV1 {
	const bytes = bytesOfCanonical(value);
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: toBase64(bytes),
		byteLength: bytes.byteLength,
		sha256: sha256HexOfBytes(bytes),
	};
}

// The cohort grant and start barrier are real retained bytes: every partial,
// receipt, and the bundle envelope name their actual digests, so a swap of
// either record is visible rather than a matter of matching placeholders.
const S44_GRANT_RETAINED = s44Retain({ label: "grant" });
const S44_BARRIER_RETAINED = s44Retain({ label: "barrier" });
const S44_GRANT_SHA = S44_GRANT_RETAINED.sha256;
const S44_BARRIER_SHA = S44_BARRIER_RETAINED.sha256;

function s44PublisherPartial(
	overrides: Partial<PublisherPartialV1> = {},
): PublisherPartialV1 {
	const offered = s44Zeros(S44_WINDOWS);
	offered[0] = 10;
	const offeredBytes = s44Zeros(S44_WINDOWS);
	offeredBytes[0] = 1_000;
	const accepted = s44Zeros(S44_WINDOWS);
	accepted[0] = 10;
	return {
		schema: "publisher-partial/v1",
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		cohortStartBarrierSha256: S44_BARRIER_SHA,
		childId: "publisher-000000",
		childPid: 4_100,
		childPgid: 4_100,
		childInstanceNonce: HEX_1,
		publisherId: "publisher-000000",
		tokenSha256: HEX_2,
		macClockId: "mach-continuous-1",
		windowCount: 10,
		offeredByOriginWindow: offered,
		offeredBytesByOriginWindow: offeredBytes,
		acceptedAckSeenByOriginWindow: accepted,
		duplicateAckSeenByOriginWindow: s44Zeros(S44_WINDOWS),
		reorderedAckSeenByOriginWindow: s44Zeros(S44_WINDOWS),
		firstOfferAtMacNs: S44_START_NS.toString(),
		lastAckAtMacNs: (S44_START_NS + 1n).toString(),
		exitCode: 0,
		...overrides,
	};
}

function s44WorkerPartial(
	workerIndex: number,
	overrides: Partial<WorkerPartialV1> = {},
): WorkerPartialV1 {
	const deliveredOrigin = s44Zeros(S44_WINDOWS);
	deliveredOrigin[0] = 10;
	const deliveredBytesOrigin = s44Zeros(S44_WINDOWS);
	deliveredBytesOrigin[0] = 1_000;
	const deliveredEvent = s44Zeros(S44_WINDOWS);
	deliveredEvent[0] = 10;
	const deliveredBytesEvent = s44Zeros(S44_WINDOWS);
	deliveredBytesEvent[0] = 1_000;
	return {
		schema: "worker-partial/v1",
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		cohortStartBarrierSha256: S44_BARRIER_SHA,
		childId: `worker-${workerIndex}`,
		childPid: 4_200 + workerIndex,
		childPgid: 4_200 + workerIndex,
		childInstanceNonce: HEX_3,
		workerIndex,
		tokenBundleSha256: HEX_4,
		orderedSubscriberIdsSha256: HEX_5,
		subscriberCount: 1,
		macClockId: "mach-continuous-1",
		windowCount: 10,
		deliveredByOriginWindow: deliveredOrigin,
		deliveredBytesByOriginWindow: deliveredBytesOrigin,
		deliveredByEventWindow: deliveredEvent,
		deliveredBytesByEventWindow: deliveredBytesEvent,
		deliveredAfterMeasureStop: 0,
		deliveredBytesAfterMeasureStop: 0,
		perSubscriberDelivered: [10],
		duplicateCount: 0,
		reorderCount: 0,
		malformedCount: 0,
		disconnectCount: 0,
		firstDeliveryAtMacNs: S44_START_NS.toString(),
		lastDeliveryAtMacNs: (S44_START_NS + 2n).toString(),
		exitCode: 0,
		...overrides,
	};
}

function s44LinuxObservation(
	overrides: Partial<LinuxRelayObservationV1> = {},
): LinuxRelayObservationV1 {
	const accepted = s44Zeros(S44_WINDOWS);
	accepted[0] = 10;
	const acceptedBytes = s44Zeros(S44_WINDOWS);
	acceptedBytes[0] = 1_000;
	const relayWrites = s44Zeros(S44_WINDOWS);
	relayWrites[0] = 80;
	const relayBytes = s44Zeros(S44_WINDOWS);
	relayBytes[0] = 8_000;
	return {
		schema: "linux-relay-observation/v1",
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		cohortStartBarrierSha256: S44_BARRIER_SHA,
		roleTokenCommitmentRootSha256: HEX_6,
		serverChildPid: 900,
		serverChildPgid: 900,
		serverChildInstanceNonce: HEX_7,
		linuxClockId: "clock-monotonic-1",
		windowCount: 10,
		registeredPublisherIds: ["publisher-000000"],
		registeredSubscriberIdsSha256: HEX_8,
		registeredPublisherCount: 1,
		registeredSubscriberCount: S44_SUBSCRIBERS,
		acceptedIngressByOriginWindow: accepted,
		acceptedIngressBytesByOriginWindow: acceptedBytes,
		relayWritesCompletedByOriginWindow: relayWrites,
		relayWriteBytesByOriginWindow: relayBytes,
		duplicateIngressByOriginWindow: s44Zeros(S44_WINDOWS),
		reorderedIngressByOriginWindow: s44Zeros(S44_WINDOWS),
		queueDropDeliveriesByOriginWindow: s44Zeros(S44_WINDOWS),
		writeTimeoutDeliveriesByOriginWindow: s44Zeros(S44_WINDOWS),
		disconnectUndeliveredByOriginWindow: s44Zeros(S44_WINDOWS),
		malformedIngressByOriginWindow: s44Zeros(S44_WINDOWS),
		publisherEndCount: 1,
		subscriberEndCount: S44_SUBSCRIBERS,
		sessionsAccepted: S44_SUBSCRIBERS + 1,
		sessionsActivePeak: S44_SUBSCRIBERS + 1,
		publisherSessionsActivePeak: 1,
		subscriberSessionsActivePeak: S44_SUBSCRIBERS,
		queueItemsPeak: 16,
		queueBytesPeak: 1_600,
		concurrentWritesPeak: 8,
		measurementStartedAtLinuxNs: "5000000000",
		relayDrainedAtLinuxNs: "5010000000",
		allSessionsClosedAtLinuxNs: "5020000000",
		allSessionsClosed: true,
		...overrides,
	};
}

function s44Workers(
	mutate?: (index: number) => Partial<WorkerPartialV1>,
): WorkerPartialV1[] {
	return Array.from({ length: COHORT_WORKER_COUNT }, (_unused, index) =>
		s44WorkerPartial(index, mutate ? mutate(index) : {}),
	);
}

function s44Conservation(workers: WorkerPartialV1[]) {
	return recomputeCohortOriginConservation({
		publisherPartials: [s44PublisherPartial()],
		workerPartials: workers,
		linuxRelayObservation: s44LinuxObservation(),
		subscriberCount: S44_SUBSCRIBERS,
		messageBytes: S44_MESSAGE_BYTES,
	});
}

function s44Series(workers: WorkerPartialV1[]) {
	const conservation = s44Conservation(workers);
	expect(conservation.ok).toBe(true);
	if (!conservation.ok) throw new Error("conservation");
	return recomputeCohortRateSeries({
		workerPartials: workers,
		conservation: conservation.value,
		windowCount: 10,
		measuredDurationMs: 10_000,
		firstDeliveryAtMacNs: S44_START_NS.toString(),
		lastMeasuredWindowDeliveryAtMacNs: (S44_START_NS + 2n).toString(),
		lastDeliveryIncludingDrainAtMacNs: (S44_START_NS + 2n).toString(),
	});
}

// --- the §4.4 process proof, manifest, receipt, and evidence fixtures -------

function s44ObservedProcessProof(
	publisherPartialSha: string,
	workerPartialShas: readonly string[],
) {
	const children = [
		{
			schema: "observed-child-process/v1" as const,
			childId: "publisher-000000",
			role: "publisher" as const,
			pid: 4_100,
			pgid: 4_100,
			instanceNonce: HEX_1,
			bunSha256: HEX_D,
			entrypointSha256: HEX_E,
			tokenOrBundleSha256: HEX_2,
			publisherId: "publisher-000000",
			workerIndex: null,
			orderedSubscriberIdsSha256: null,
			subscriberCount: 0,
			spawnedAtMacNs: "1",
			readyAtMacNs: "2",
			warmupCompleteAtMacNs: "3",
			measureArmedAtMacNs: "4",
			stoppedAtMacNs: "5",
			partialSha256: publisherPartialSha,
			exitCode: 0,
			signal: null,
			replacementCount: 0 as const,
		},
		...workerPartialShas.map((sha, index) => ({
			schema: "observed-child-process/v1" as const,
			childId: `worker-${index}`,
			role: "subscriber-worker" as const,
			pid: 4_200 + index,
			pgid: 4_200 + index,
			instanceNonce: HEX_3,
			bunSha256: HEX_D,
			entrypointSha256: HEX_F,
			tokenOrBundleSha256: HEX_4,
			publisherId: null,
			workerIndex: index,
			orderedSubscriberIdsSha256: HEX_5,
			subscriberCount: 1,
			spawnedAtMacNs: "1",
			readyAtMacNs: "2",
			warmupCompleteAtMacNs: "3",
			measureArmedAtMacNs: "4",
			stoppedAtMacNs: "5",
			partialSha256: sha,
			exitCode: 0,
			signal: null,
			replacementCount: 0 as const,
		})),
	];
	return {
		schema: "observed-process-proof/v1" as const,
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		cohortStartBarrierSha256: S44_BARRIER_SHA,
		expectedProcessCount: 9,
		observedProcessCount: 9,
		expectedPublisherCount: 1,
		observedPublisherCount: 1,
		expectedWorkerCount: 8 as const,
		observedWorkerCount: 8 as const,
		expectedSubscriberCount: S44_SUBSCRIBERS,
		observedSubscriberCount: S44_SUBSCRIBERS,
		children,
		childrenDigestSha256: observedChildrenDigestSha256(children),
	};
}

function s44OrderedManifest(
	publisher: RetainedCanonicalBytesV1,
	workers: readonly RetainedCanonicalBytesV1[],
) {
	const entries = [
		{
			schema: "ordered-partial-manifest-entry/v1" as const,
			order: 0,
			partialKind: "publisher" as const,
			childId: "publisher-000000",
			partialSha256: publisher.sha256,
			partialSize: publisher.byteLength,
		},
		...workers.map((retained, index) => ({
			schema: "ordered-partial-manifest-entry/v1" as const,
			order: index + 1,
			partialKind: "worker" as const,
			childId: `worker-${index}`,
			partialSha256: retained.sha256,
			partialSize: retained.byteLength,
		})),
	];
	const totalPartialBytes =
		publisher.byteLength +
		workers.reduce((sum, retained) => sum + retained.byteLength, 0);
	return {
		schema: "ordered-partial-manifest/v1" as const,
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		cohortStartBarrierSha256: S44_BARRIER_SHA,
		publisherPartialCount: 1,
		workerPartialCount: 8 as const,
		totalPartialBytes,
		entries,
		orderedDigestSetSha256: orderedPartialDigestSetSha256(entries),
	};
}

const S44_ADMISSION_HASH_FIELDS = [
	"measurementGrantSha256",
	"macExecutionGrantReceiptSha256",
	"cohortGrantSignatureSha256",
	"rigCohortAcceptanceSha256",
	"rigCohortAcceptanceSignatureSha256",
	"tokenCommitmentLeafManifestSha256",
	"cohortWarmupEpochSha256",
	"cohortWarmupEpochSignatureSha256",
	"roleWarmupCompletionManifestSha256",
	"roleWarmupCompletionManifestSignatureSha256",
	"serverWarmupDrainedSha256",
	"rigWarmupDrainedReceiptSha256",
	"rigWarmupDrainedReceiptSignatureSha256",
	"rigMeasureStartAckSha256",
	"rigMeasureStartAckSignatureSha256",
	"cohortStartBarrierSignatureSha256",
	"rigBarrierAcceptanceSha256",
	"rigBarrierAcceptanceSignatureSha256",
	"serverStartBarrierAcceptedSha256",
	"rigRelayObservationReceiptSignatureSha256",
	"rigServerSnapshotReceiptSha256",
	"rigServerSnapshotReceiptSignatureSha256",
	"macMeasurementAdmissionReceiptSha256",
	"macMeasurementAdmissionSignatureSha256",
	"approvedPlanSha256",
	"approvalRecordSha256",
] as const;

interface S44EvidenceOverrides {
	readonly mutate?: (evidence: Record<string, unknown>) => void;
}

function s44Evidence(
	options: S44EvidenceOverrides = {},
): Record<string, unknown> {
	const publisher = s44PublisherPartial();
	const workers = s44Workers();
	const publisherRetained = s44Retain(publisher);
	const workerRetained = workers.map((worker) => s44Retain(worker));
	const linux = s44LinuxObservation();
	const linuxRetained = s44Retain(linux);
	const manifest = s44OrderedManifest(publisherRetained, workerRetained);
	const manifestRetained = s44Retain(manifest);
	const proof = s44ObservedProcessProof(
		publisherRetained.sha256,
		workerRetained.map((retained) => retained.sha256),
	);
	const proofRetained = s44Retain(proof);
	const rigReceipt = {
		schema: "rig-relay-observation-receipt/v1" as const,
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		cohortStartBarrierSha256: S44_BARRIER_SHA,
		linuxRelayObservationSha256: linuxRetained.sha256,
		rigExecutionAcceptanceSha256: HEX_9,
		rigSupervisorInstanceNonce: HEX_8,
		signingPublicKeySha256: HEX_7,
		receiptSequence: 1,
		receivedAtRigNs: "5030000000",
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	const rigReceiptRetained = s44Retain(rigReceipt);
	const seriesResult = s44Series(workers);
	expect(seriesResult.ok).toBe(true);
	if (!seriesResult.ok) throw new Error("series");
	const seriesRetained = s44Retain(seriesResult.value);
	const conservation = s44Conservation(workers);
	if (!conservation.ok) throw new Error("conservation");
	const ledgerResult = recomputeCohortLedger({
		conservation: conservation.value,
		subscriberCount: S44_SUBSCRIBERS,
		messageBytes: S44_MESSAGE_BYTES,
	});
	expect(ledgerResult.ok).toBe(true);
	if (!ledgerResult.ok) throw new Error("ledger");
	const ledgerRetained = s44Retain(ledgerResult.value);
	const capacity = {
		schema: "cohort-capacity/v1" as const,
		expectedSessions: S44_SUBSCRIBERS + 1,
		sessionsAccepted: S44_SUBSCRIBERS + 1,
		sessionsActivePeak: S44_SUBSCRIBERS + 1,
		expectedPublishers: 1,
		registeredPublishers: 1,
		expectedSubscribers: S44_SUBSCRIBERS,
		registeredSubscribers: S44_SUBSCRIBERS,
	};
	const capacityRetained = s44Retain(capacity);
	const admission: Record<string, unknown> = {
		schema: "cohort-admission-receipt/v1",
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		cohortStartBarrierSha256: S44_BARRIER_SHA,
		orderedPartialManifestSha256: manifestRetained.sha256,
		observedProcessProofSha256: proofRetained.sha256,
		linuxRelayObservationSha256: linuxRetained.sha256,
		rigRelayObservationReceiptSha256: rigReceiptRetained.sha256,
		rateSeriesSha256: seriesRetained.sha256,
		ledgerSha256: ledgerRetained.sha256,
		capacitySha256: capacityRetained.sha256,
		publisherCount: 1,
		workerCount: 8,
		subscriberCount: S44_SUBSCRIBERS,
		offeredIngress: ledgerResult.value.offeredIngress,
		serverAcceptedIngress: ledgerResult.value.serverAcceptedIngress,
		linuxRelayWritesCompleted: ledgerResult.value.linuxRelayWritesCompleted,
		delivered: ledgerResult.value.delivered,
		macSupervisorInstanceNonce: HEX_6,
		signingPublicKeySha256: HEX_5,
		receiptSequence: 7,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	for (const field of S44_ADMISSION_HASH_FIELDS) admission[field] = HEX_9;
	const filler = (label: string) => s44Retain({ label });
	const evidence: Record<string, unknown> = {
		schema: "cohort-observation-evidence/v1",
		workloadRolePlanInput: filler("workload"),
		cohortGrant: S44_GRANT_RETAINED,
		cohortGrantSignature: filler("grant-sig"),
		rigCohortAcceptance: filler("rig-acceptance"),
		rigCohortAcceptanceSignature: filler("rig-acceptance-sig"),
		tokenCommitmentLeafManifest: filler("leaf-manifest"),
		cohortWarmupEpoch: filler("epoch"),
		cohortWarmupEpochSignature: filler("epoch-sig"),
		roleWarmupCompletionManifest: filler("warmup-manifest"),
		roleWarmupCompletionManifestSignature: filler("warmup-manifest-sig"),
		roleWarmupCompletes: Array.from({ length: 9 }, (_unused, index) =>
			filler(`warmup-complete-${index}`),
		),
		serverWarmupDrained: filler("server-drained"),
		rigWarmupDrainedReceipt: filler("rig-drained"),
		rigWarmupDrainedReceiptSignature: filler("rig-drained-sig"),
		rigMeasureStartAck: filler("measure-ack"),
		rigMeasureStartAckSignature: filler("measure-ack-sig"),
		cohortStartBarrier: S44_BARRIER_RETAINED,
		cohortStartBarrierSignature: filler("barrier-sig"),
		rigBarrierAcceptance: filler("barrier-acceptance"),
		rigBarrierAcceptanceSignature: filler("barrier-acceptance-sig"),
		serverStartBarrierAccepted: filler("server-barrier"),
		publisherPartials: [publisherRetained],
		workerPartials: workerRetained,
		orderedPartialManifest: manifestRetained,
		observedProcessProof: proofRetained,
		linuxRelayObservation: linuxRetained,
		rigRelayObservationReceipt: rigReceiptRetained,
		rigRelayObservationReceiptSignature: filler("rig-receipt-sig"),
		rateSeries: seriesRetained,
		ledger: ledgerRetained,
		capacity: capacityRetained,
		cohortAdmissionReceipt: s44Retain(admission),
		cohortAdmissionSignature: filler("admission-sig"),
	};
	options.mutate?.(evidence);
	return evidence;
}

function s44Bundle(
	evidence: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const bytes = bytesOfCanonical(evidence);
	return {
		schema: "raw-cohort-evidence-bundle/v1",
		executionSha256: HEX_A,
		cohortGrantSha256: S44_GRANT_SHA,
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: toBase64(bytes),
		byteLength: bytes.byteLength,
		sha256: sha256HexOfBytes(bytes),
		terminalExport: true,
		requestSequence: 1,
		responseSequence: 1,
		...overrides,
	};
}

function s44Decode(
	bundle: unknown,
	extra: {
		readonly alreadyExported?: boolean;
		readonly expectedRequestSequence?: number;
	} = {},
) {
	return decodeRawCohortEvidenceBundle({
		bundle,
		expectedExecutionSha256: HEX_A,
		expectedCohortGrantSha256: S44_GRANT_SHA,
		expectedPublisherCount: 1,
		expectedSubscriberCount: S44_SUBSCRIBERS,
		remoteEvidenceBudgetRemaining: COHORT_REMOTE_EVIDENCE_BUDGET_BYTES,
		alreadyExported: extra.alreadyExported ?? false,
		expectedRequestSequence: extra.expectedRequestSequence ?? 1,
	});
}

describe("cohort-protocol B1 §4.4/§4.5", () => {
	test("caps and the six-cell cardinality table are the exact plan values", () => {
		expect(PUBLISHER_PARTIAL_MAX_BYTES).toBe(65_536);
		expect(WORKER_PARTIAL_MAX_BYTES).toBe(262_144);
		expect(ORDERED_PARTIAL_MANIFEST_MAX_BYTES).toBe(65_536);
		expect(OBSERVED_PROCESS_PROOF_MAX_BYTES).toBe(131_072);
		expect(LINUX_RELAY_OBSERVATION_MAX_BYTES).toBe(131_072);
		expect(RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES).toBe(32_768);
		expect(COHORT_ADMISSION_RECEIPT_MAX_BYTES).toBe(65_536);
		expect(COHORT_ADMISSION_SIGNATURE_MAX_BYTES).toBe(4_096);
		expect(COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES).toBe(9_437_184);
		expect(COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES).toBe(14_680_064);
		expect(COHORT_REMOTE_EVIDENCE_BUDGET_BYTES).toBe(20_971_520);

		expect(COHORT_CELL_CARDINALITIES.length).toBe(6);
		const ticker100k = cohortCellCardinality("ticker 100k");
		expect(ticker100k).toEqual({
			cell: "ticker 100k",
			publisherCount: 1,
			workerCount: 8,
			subscriberCount: 100,
			sessionCount: 101,
			measuredIngress: 1_000_000,
			expandedDeliveries: 100_000_000,
		});
		const chat10k = cohortCellCardinality("chat 10k");
		expect(chat10k).toEqual({
			cell: "chat 10k",
			publisherCount: 10,
			workerCount: 8,
			subscriberCount: 10_000,
			sessionCount: 10_010,
			measuredIngress: 300,
			expandedDeliveries: 3_000_000,
		});
		for (const row of COHORT_CELL_CARDINALITIES) {
			expect(row.workerCount).toBe(COHORT_WORKER_COUNT);
			expect(row.sessionCount).toBe(row.publisherCount + row.subscriberCount);
			expect(row.expandedDeliveries).toBe(
				row.measuredIngress * row.subscriberCount,
			);
		}
	});

	test("partial, manifest, process, and Linux parsers reject unknown keys and wrong cardinality", () => {
		expect(parsePublisherPartial(s44PublisherPartial()).ok).toBe(true);
		expect(
			parsePublisherPartial({
				...s44PublisherPartial(),
				extra: 1,
			}).ok,
		).toBe(false);
		expect(
			parsePublisherPartial(
				s44PublisherPartial({
					offeredByOriginWindow: s44Zeros(9),
				}),
			).ok,
		).toBe(false);
		expect(parseWorkerPartial(s44WorkerPartial(0)).ok).toBe(true);
		expect(
			parseWorkerPartial(
				s44WorkerPartial(0, { perSubscriberDelivered: [10, 10] }),
			).ok,
		).toBe(false);
		expect(parseWorkerPartial(s44WorkerPartial(8)).ok).toBe(false);
		expect(parseLinuxRelayObservation(s44LinuxObservation()).ok).toBe(true);
		expect(
			parseLinuxRelayObservation(
				s44LinuxObservation({ allSessionsClosed: false as unknown as true }),
			).ok,
		).toBe(false);
		expect(
			parseLinuxRelayObservation(
				s44LinuxObservation({ sessionsActivePeak: 10 }),
			).ok,
		).toBe(false);

		const publisherRetained = s44Retain(s44PublisherPartial());
		const workerRetained = s44Workers().map((worker) => s44Retain(worker));
		const manifest = s44OrderedManifest(publisherRetained, workerRetained);
		expect(parseOrderedPartialManifest(manifest).ok).toBe(true);
		expect(
			parseOrderedPartialManifest({
				...manifest,
				entries: [manifest.entries[0], ...manifest.entries.slice(1, 8)],
			}).ok,
		).toBe(false);
		const proof = s44ObservedProcessProof(
			publisherRetained.sha256,
			workerRetained.map((retained) => retained.sha256),
		);
		expect(parseObservedProcessProof(proof).ok).toBe(true);
		expect(
			parseObservedProcessProof({
				...proof,
				children: proof.children.map((child, index) =>
					index === 0 ? { ...child, replacementCount: 1 } : child,
				),
			}).ok,
		).toBe(false);
	});

	test("origin_conservation_is_distinct_from_delivery_event_rate", () => {
		// Worker 0 delivers its ten window-0 messages one event window late.
		const lateEvent = s44Zeros(S44_WINDOWS);
		lateEvent[1] = 10;
		const lateBytes = s44Zeros(S44_WINDOWS);
		lateBytes[1] = 1_000;
		const workers = s44Workers((index) =>
			index === 0
				? {
						deliveredByEventWindow: lateEvent,
						deliveredBytesByEventWindow: lateBytes,
					}
				: {},
		);

		const conservation = s44Conservation(workers);
		expect(conservation.ok).toBe(true);
		if (!conservation.ok) throw new Error(conservation.message);
		// Origin accounting is untouched by the late delivery.
		expect(conservation.value.deliveredByOriginWindow[0]).toBe(80);
		expect(conservation.value.deliveredByOriginWindow[1]).toBe(0);
		expect(conservation.value.deliveredTotal).toBe(80);

		const series = s44Series(workers);
		expect(series.ok).toBe(true);
		if (!series.ok) throw new Error(series.message);
		// The rate series is a different observation and is allowed to differ.
		expect(series.value.samples[0]).toBe(70);
		expect(series.value.samples[1]).toBe(10);
		expect(series.value.samples).not.toEqual(
			conservation.value.deliveredByOriginWindow,
		);
		expect(series.value.measuredWindowDeliveredTotal).toBe(80);
		expect(series.value.conservationDeliveredTotal).toBe(80);
		expect(series.value.postStopDrainDelivered).toBe(0);
		expect(series.value.meanNumerator).toBe(80_000);
		expect(series.value.meanDenominatorMs).toBe(10_000);

		// Relabelling the late delivery back into its origin rate window fails.
		const relabelled = s44Workers();
		const forged = s44Series(relabelled);
		expect(forged.ok).toBe(true);
		if (!forged.ok) throw new Error(forged.message);
		expect(forged.value.samples[0]).toBe(80);
		expect(forged.value.samples).not.toEqual(series.value.samples);
	});

	test("boundary_latency_moves_rate_event_not_origin", () => {
		const args = {
			measureStartAtMacNs: S44_START_NS.toString(),
			measureStopAtMacNs: S44_STOP_NS.toString(),
			windowCount: 10 as const,
		};
		// Accepted ingress 1 ns before the window 0/1 boundary.
		const ingress = computeCohortEventWindow({
			...args,
			deliveredAtMacNs: (S44_START_NS + 1_000_000_000n - 1n).toString(),
		});
		expect(ingress.ok).toBe(true);
		if (!ingress.ok) throw new Error(ingress.message);
		expect(ingress.value).toEqual({
			classification: "measured-window",
			eventWindow: 0,
		});
		// Delivery 1 ns after it: same origin window, later event window.
		const delivery = computeCohortEventWindow({
			...args,
			deliveredAtMacNs: (S44_START_NS + 1_000_000_000n + 1n).toString(),
		});
		expect(delivery.ok).toBe(true);
		if (!delivery.ok) throw new Error(delivery.message);
		expect(delivery.value).toEqual({
			classification: "measured-window",
			eventWindow: 1,
		});
		// A timestamp before the barrier start is a refusal, not window 0.
		expect(
			computeCohortEventWindow({
				...args,
				deliveredAtMacNs: (S44_START_NS - 1n).toString(),
			}).ok,
		).toBe(false);
		// So is one past the 10 s drain deadline.
		expect(
			computeCohortEventWindow({
				...args,
				deliveredAtMacNs: (S44_STOP_NS + 10_000_000_001n).toString(),
			}).ok,
		).toBe(false);
		// A stop that is not start + windowCount seconds is refused outright.
		expect(
			computeCohortEventWindow({
				...args,
				measureStopAtMacNs: (S44_STOP_NS + 1n).toString(),
				deliveredAtMacNs: S44_START_NS.toString(),
			}).ok,
		).toBe(false);
	});

	test("post_stop_drain_is_not_measured_rate", () => {
		// Worker 7 completes its ten deliveries after stop, during the drain.
		const workers = s44Workers((index) =>
			index === 7
				? {
						deliveredByEventWindow: s44Zeros(S44_WINDOWS),
						deliveredBytesByEventWindow: s44Zeros(S44_WINDOWS),
						deliveredAfterMeasureStop: 10,
						deliveredBytesAfterMeasureStop: 1_000,
					}
				: {},
		);
		const conservation = s44Conservation(workers);
		expect(conservation.ok).toBe(true);
		if (!conservation.ok) throw new Error(conservation.message);
		// Conservation still sees all eighty origin-window deliveries.
		expect(conservation.value.deliveredTotal).toBe(80);
		expect(conservation.value.deliveredByOriginWindow[0]).toBe(80);

		const series = s44Series(workers);
		expect(series.ok).toBe(true);
		if (!series.ok) throw new Error(series.message);
		expect(series.value.measuredWindowDeliveredTotal).toBe(70);
		expect(series.value.postStopDrainDelivered).toBe(10);
		expect(series.value.conservationDeliveredTotal).toBe(80);
		expect(series.value.meanNumerator).toBe(70_000);
		// The drained ten are never folded back into a measured sample.
		expect(series.value.samples.reduce((sum, value) => sum + value, 0)).toBe(
			70,
		);

		const drainClassification = computeCohortEventWindow({
			measureStartAtMacNs: S44_START_NS.toString(),
			measureStopAtMacNs: S44_STOP_NS.toString(),
			windowCount: 10,
			deliveredAtMacNs: (S44_STOP_NS + 1n).toString(),
		});
		expect(drainClassification.ok).toBe(true);
		if (!drainClassification.ok) throw new Error(drainClassification.message);
		expect(drainClassification.value).toEqual({
			classification: "after-measure-stop",
			eventWindow: null,
		});
	});

	test("raw_cohort_bundle_rejects_missing_duplicate_truncated_oversize_reordered_or_receipt_swap", () => {
		const honest = s44Bundle(s44Evidence());
		const accepted = s44Decode(honest);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error(accepted.message);
		expect(accepted.value.decodedByteLength).toBe(honest.byteLength as number);
		expect(accepted.value.budgetRemaining).toBe(
			COHORT_REMOTE_EVIDENCE_BUDGET_BYTES - (honest.byteLength as number),
		);

		// missing: an evidence member is absent
		const missing = s44Evidence();
		delete missing.linuxRelayObservation;
		expect(s44Decode(s44Bundle(missing)).ok).toBe(false);
		expect(
			parseCohortObservationEvidence({
				evidence: missing,
				expectedPublisherCount: 1,
				expectedSubscriberCount: S44_SUBSCRIBERS,
			}).ok,
		).toBe(false);

		// missing: a whole worker partial is dropped
		const shortWorkers = s44Evidence({
			mutate: (evidence) => {
				evidence.workerPartials = (evidence.workerPartials as unknown[]).slice(
					0,
					7,
				);
			},
		});
		expect(s44Decode(s44Bundle(shortWorkers)).ok).toBe(false);

		// duplicate: the same worker partial appears twice
		const duplicated = s44Evidence({
			mutate: (evidence) => {
				const workers = evidence.workerPartials as unknown[];
				evidence.workerPartials = [workers[0], ...workers.slice(0, 7)];
			},
		});
		expect(s44Decode(s44Bundle(duplicated)).ok).toBe(false);

		// duplicate: a second terminal export of the same execution
		expect(s44Decode(honest, { alreadyExported: true }).ok).toBe(false);

		// truncated: the declared size no longer matches the payload
		expect(
			s44Decode(
				s44Bundle(s44Evidence(), {
					byteLength: (honest.byteLength as number) - 1,
				}),
			).ok,
		).toBe(false);
		const truncatedBytes = bytesOfCanonical(s44Evidence()).slice(0, 512);
		expect(
			s44Decode({
				...honest,
				bytesBase64: toBase64(truncatedBytes),
				byteLength: truncatedBytes.byteLength,
				sha256: sha256HexOfBytes(truncatedBytes),
			}).ok,
		).toBe(false);

		// oversize: encoded length, decoded length, and budget are all refused
		expect(
			s44Decode({
				...honest,
				bytesBase64: "A".repeat(
					COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES + 4,
				),
			}).ok,
		).toBe(false);
		expect(
			decodeRawCohortEvidenceBundle({
				bundle: honest,
				expectedExecutionSha256: HEX_A,
				expectedCohortGrantSha256: S44_GRANT_SHA,
				expectedPublisherCount: 1,
				expectedSubscriberCount: S44_SUBSCRIBERS,
				remoteEvidenceBudgetRemaining: 16,
				alreadyExported: false,
				expectedRequestSequence: 1,
			}).ok,
		).toBe(false);

		// reordered: the worker partials are no longer 0..7
		const reordered = s44Evidence({
			mutate: (evidence) => {
				const workers = [...(evidence.workerPartials as unknown[])];
				const swap = workers[1];
				workers[1] = workers[2] as unknown;
				workers[2] = swap as unknown;
				evidence.workerPartials = workers;
			},
		});
		expect(s44Decode(s44Bundle(reordered)).ok).toBe(false);

		// receipt-swap: a genuine rig receipt for a different Linux observation
		const swapped = s44Evidence({
			mutate: (evidence) => {
				const linux = s44LinuxObservation({ queueItemsPeak: 17 });
				evidence.linuxRelayObservation = s44Retain(linux);
			},
		});
		expect(s44Decode(s44Bundle(swapped)).ok).toBe(false);

		// receipt-swap: the admission receipt points at other partial bytes
		const rewritten = s44Evidence({
			mutate: (evidence) => {
				const workers = [...(evidence.workerPartials as unknown[])];
				workers[3] = s44Retain(
					s44WorkerPartial(3, { duplicateCount: 1 }),
				) as unknown;
				evidence.workerPartials = workers;
			},
		});
		expect(s44Decode(s44Bundle(rewritten)).ok).toBe(false);

		// cross-execution substitution is refused by the outer binding
		expect(
			decodeRawCohortEvidenceBundle({
				bundle: honest,
				expectedExecutionSha256: HEX_D,
				expectedCohortGrantSha256: S44_GRANT_SHA,
				expectedPublisherCount: 1,
				expectedSubscriberCount: S44_SUBSCRIBERS,
				remoteEvidenceBudgetRemaining: COHORT_REMOTE_EVIDENCE_BUDGET_BYTES,
				alreadyExported: false,
				expectedRequestSequence: 1,
			}).ok,
		).toBe(false);
		expect(
			s44Decode(s44Bundle(s44Evidence(), { terminalExport: false })).ok,
		).toBe(false);
	});

	// One correlation rule: the request sequence must be the one that was asked
	// for; the response sequence is the responder's own receipt counter, so it
	// is bound and carried, never required to equal the request.
	test("decodeRawCohortEvidenceBundle accepts an unequal B3-shaped response sequence", () => {
		const decoded = s44Decode(
			s44Bundle(s44Evidence(), { requestSequence: 3, responseSequence: 7 }),
			{ expectedRequestSequence: 3 },
		);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.requestSequence).toBe(3);
		expect(decoded.value.responseSequence).toBe(7);
	});

	test("decodeRawCohortEvidenceBundle refuses a swapped requestSequence", () => {
		expect(
			s44Decode(
				s44Bundle(s44Evidence(), { requestSequence: 7, responseSequence: 3 }),
				{ expectedRequestSequence: 3 },
			).ok,
		).toBe(false);
		expect(
			s44Decode(
				s44Bundle(s44Evidence(), { requestSequence: 0, responseSequence: 7 }),
				{ expectedRequestSequence: 0 },
			).ok,
		).toBe(false);
	});

	test("correlateCohortExportSequences is the one export correlation rule", () => {
		const bound = correlateCohortExportSequences({
			requestSequence: 3,
			responseSequence: 7,
			expectedRequestSequence: 3,
		});
		expect(bound.ok).toBe(true);
		if (!bound.ok) return;
		expect(bound.value).toEqual({ requestSequence: 3, responseSequence: 7 });

		for (const bad of [
			{ requestSequence: 7, responseSequence: 7, expectedRequestSequence: 3 },
			{ requestSequence: 3, responseSequence: 0, expectedRequestSequence: 3 },
			{ requestSequence: 3.5, responseSequence: 7, expectedRequestSequence: 3 },
			{ requestSequence: "3", responseSequence: 7, expectedRequestSequence: 3 },
			{ requestSequence: 3, responseSequence: 7, expectedRequestSequence: 0 },
		]) {
			expect(correlateCohortExportSequences(bad).ok).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// B1 transport registration: §3.3 remote frames and §3.4 child-pipe frames.
//
// Registration only. These tests pin that the cohort records can *travel* --
// each kind is registered, bounded at its own cap, round-trips through the
// existing codecs byte-for-byte, and an unregistered kind is refused. Nothing
// here exercises a production path; no executor, controller, or artifact
// field is touched by the code under test.
// ---------------------------------------------------------------------------

import {
	CHILD_PIPE_CONTROL_MAX_BYTES,
	CHILD_PIPE_PARTIAL_MAX_BYTES,
	decodeRoleChildFrame,
	encodeRoleChildFrame,
	isRoleChildSchema,
	PHASE_A_CHILD_SCHEMAS,
	PHASE_B_ROLE_CHILD_SCHEMAS,
	ROLE_CHILD_BASE_FRAMES_PER_DIRECTION,
	ROLE_CHILD_FRAMES_PER_SESSION,
	ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES,
	roleChildFrameBoundForSchema,
	roleChildMaxFramesPerDirection,
} from "./child-pipe-protocol.ts";
import {
	COHORT_REMOTE_EVIDENCE_BUDGET_BYTES as B1_EVIDENCE_BUDGET,
	COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES as B1_EVIDENCE_DECODED,
	COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES as B1_EVIDENCE_ENCODED,
	ROLE_SPAWN_CONFIG_MAX_BYTES as B1_SPAWN_CONFIG_CAP,
	ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES as B1_WARMUP_MANIFEST_CAP,
} from "./cohort-protocol.ts";
import {
	COHORT_EVIDENCE_EXPORT_MAX_DECODED_BYTES,
	COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES,
	COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES,
	COHORT_REMOTE_PAYLOAD_BOUNDS,
	COHORT_REMOTE_PAYLOAD_SCHEMAS,
	COHORT_WARMUP_MANIFEST_EXPORT_MAX_DECODED_BYTES,
	COHORT_WARMUP_MANIFEST_EXPORT_MAX_ENCODED_BYTES,
	decodeRegisteredRemotePayload,
	encodeRegisteredRemotePayload,
	isCohortRemoteSchema,
	PHASE_A_REMOTE_PAYLOAD_SCHEMAS,
	parseCohortRemotePayload,
	REMOTE_PAYLOAD_SCHEMAS,
	REMOTE_REGISTERED_MAX_PAYLOAD_BYTES,
	remotePayloadBoundForSchema,
	type CohortRemotePayloadV1,
	type CohortRemoteSchema,
} from "./cross-supervisor-protocol.ts";
import {
	PHASE_B_COHORT_AUTHORITY_SCHEMAS,
	PHASE_B_ROLE_CHILD_ORIGINATED_SCHEMAS,
	roleRecordOrigin,
	validateRoleChildRecordOrigin,
} from "./supervisor-protocol.ts";

const B1_HEX_X = "a".repeat(64);
const B1_HEX_Y = "b".repeat(64);
const B1_HEX_Z = "c".repeat(64);
const B1_B64 = "AAECAwQF";

/**
 * One valid record per registered cohort remote kind, keys spelled out. The
 * `satisfies` is the compile-time half of the pin: a sample that drifts from
 * the exported interface, or a kind with no sample at all, fails `tsc`.
 */
const B1_REMOTE_SAMPLES = {
	"mac-open-cohort-request/v1": {
		schema: "mac-open-cohort-request/v1",
		requestSeq: 4,
		executionSha256: B1_HEX_X,
		scenarioHash: B1_HEX_Y,
		rolePlanHash: B1_HEX_Z,
		workloadRolePlanInputBase64: B1_B64,
		workloadRolePlanInputSha256: B1_HEX_X,
		workloadRolePlanInputSize: 6,
		tokenCommitmentLeafManifestBase64: B1_B64,
		publishersBase64: B1_B64,
		subscriberShardsBase64: B1_B64,
		tokenCommitmentLeafManifestSha256: B1_HEX_Z,
	},
	"mac-cohort-opened-ack/v1": {
		schema: "mac-cohort-opened-ack/v1",
		responseSeq: 4,
		ackRequestSeq: 4,
		executionSha256: B1_HEX_X,
		cohortGrantBase64: B1_B64,
		cohortGrantSha256: B1_HEX_Y,
		cohortGrantSignatureBase64: B1_B64,
	},
	"mac-present-rig-cohort-acceptance-request/v1": {
		schema: "mac-present-rig-cohort-acceptance-request/v1",
		requestSeq: 5,
		executionSha256: B1_HEX_X,
		rigCohortAcceptanceBase64: B1_B64,
		rigCohortAcceptanceSignatureBase64: B1_B64,
	},
	"mac-rig-cohort-acceptance-ack/v1": {
		schema: "mac-rig-cohort-acceptance-ack/v1",
		responseSeq: 5,
		ackRequestSeq: 5,
		executionSha256: B1_HEX_X,
		rigCohortAcceptanceSha256: B1_HEX_Y,
	},
	"mac-issue-warmup-epoch-request/v1": {
		schema: "mac-issue-warmup-epoch-request/v1",
		requestSeq: 6,
		executionSha256: B1_HEX_X,
		cohortGrantSha256: B1_HEX_Y,
		rigCohortAcceptanceSha256: B1_HEX_Z,
	},
	"mac-warmup-epoch-issued-ack/v1": {
		schema: "mac-warmup-epoch-issued-ack/v1",
		responseSeq: 6,
		ackRequestSeq: 6,
		executionSha256: B1_HEX_X,
		cohortWarmupEpochBase64: B1_B64,
		cohortWarmupEpochSignatureBase64: B1_B64,
	},
	"mac-export-warmup-completion-manifest-request/v1": {
		schema: "mac-export-warmup-completion-manifest-request/v1",
		requestSeq: 7,
		executionSha256: B1_HEX_X,
		cohortWarmupEpochSha256: B1_HEX_Y,
		roleWarmupCompletesBase64: [B1_B64, B1_B64],
	},
	"mac-warmup-completion-manifest-exported-ack/v1": {
		schema: "mac-warmup-completion-manifest-exported-ack/v1",
		responseSeq: 7,
		ackRequestSeq: 7,
		executionSha256: B1_HEX_X,
		cohortWarmupEpochSha256: B1_HEX_Y,
		roleWarmupCompletionManifestBase64: B1_B64,
		roleWarmupCompletionManifestSha256: B1_HEX_Z,
		roleWarmupCompletionManifestSize: 6,
		roleWarmupCompletionManifestSignatureBase64: B1_B64,
		roleWarmupCompletionManifestSignatureSha256: B1_HEX_X,
		entryCount: 9,
		terminalWarmupExport: true,
	},
	"mac-issue-start-barrier-request/v1": {
		schema: "mac-issue-start-barrier-request/v1",
		requestSeq: 8,
		executionSha256: B1_HEX_X,
		cohortGrantSha256: B1_HEX_Y,
		rigWarmupDrainedReceiptBase64: B1_B64,
		rigWarmupDrainedReceiptSignatureBase64: B1_B64,
		rigMeasureStartAckBase64: B1_B64,
		rigMeasureStartAckSignatureBase64: B1_B64,
	},
	"mac-start-barrier-issued-ack/v1": {
		schema: "mac-start-barrier-issued-ack/v1",
		responseSeq: 8,
		ackRequestSeq: 8,
		executionSha256: B1_HEX_X,
		cohortStartBarrierBase64: B1_B64,
		cohortStartBarrierSha256: B1_HEX_Y,
		cohortStartBarrierSignatureBase64: B1_B64,
	},
	"mac-present-rig-barrier-acceptance-request/v1": {
		schema: "mac-present-rig-barrier-acceptance-request/v1",
		requestSeq: 9,
		executionSha256: B1_HEX_X,
		rigBarrierAcceptanceBase64: B1_B64,
		rigBarrierAcceptanceSignatureBase64: B1_B64,
	},
	"mac-rig-barrier-acceptance-ack/v1": {
		schema: "mac-rig-barrier-acceptance-ack/v1",
		responseSeq: 9,
		ackRequestSeq: 9,
		executionSha256: B1_HEX_X,
		rigBarrierAcceptanceSha256: B1_HEX_Y,
		roleChildrenMayArm: true,
	},
	"mac-export-cohort-evidence-request/v1": {
		schema: "mac-export-cohort-evidence-request/v1",
		requestSeq: 10,
		executionSha256: B1_HEX_X,
		cohortAdmissionReceiptSha256: B1_HEX_Y,
		roleChildEvidenceBundleBase64: B1_B64,
	},
	"mac-cohort-evidence-exported-ack/v1": {
		schema: "mac-cohort-evidence-exported-ack/v1",
		responseSeq: 10,
		ackRequestSeq: 10,
		executionSha256: B1_HEX_X,
		cohortObservationEvidenceSignatureBase64: B1_B64,
		cohortObservationEvidenceSha256: B1_HEX_Y,
		cohortObservationEvidenceSize: 6,
		terminalExport: true,
	},
	"rig-accept-cohort-request/v1": {
		schema: "rig-accept-cohort-request/v1",
		requestSeq: 2,
		executionSha256: B1_HEX_X,
		cohortGrantBase64: B1_B64,
		cohortGrantSignatureBase64: B1_B64,
		rigExecutionAcceptanceBase64: B1_B64,
		rigExecutionAcceptanceSignatureBase64: B1_B64,
	},
	"rig-cohort-accepted-ack/v1": {
		schema: "rig-cohort-accepted-ack/v1",
		responseSeq: 2,
		ackRequestSeq: 2,
		executionSha256: B1_HEX_X,
		cohortGrantSha256: B1_HEX_Y,
		rigCohortAcceptanceBase64: B1_B64,
		rigCohortAcceptanceSignatureBase64: B1_B64,
	},
	"rig-begin-warmup-request/v1": {
		schema: "rig-begin-warmup-request/v1",
		requestSeq: 3,
		executionSha256: B1_HEX_X,
		cohortWarmupEpochBase64: B1_B64,
		cohortWarmupEpochSignatureBase64: B1_B64,
	},
	"rig-warmup-ready-ack/v1": {
		schema: "rig-warmup-ready-ack/v1",
		responseSeq: 3,
		ackRequestSeq: 3,
		executionSha256: B1_HEX_X,
		serverWarmupReadySha256: B1_HEX_Y,
	},
	"rig-finish-warmup-request/v1": {
		schema: "rig-finish-warmup-request/v1",
		requestSeq: 4,
		executionSha256: B1_HEX_X,
		roleWarmupCompletionManifestBase64: B1_B64,
		roleWarmupCompletionManifestSignatureBase64: B1_B64,
	},
	"rig-warmup-drained-ack/v1": {
		schema: "rig-warmup-drained-ack/v1",
		responseSeq: 4,
		ackRequestSeq: 4,
		executionSha256: B1_HEX_X,
		serverWarmupDrainedBase64: B1_B64,
		serverWarmupDrainedSha256: B1_HEX_Y,
		serverWarmupDrainedSize: 6,
		rigWarmupDrainedReceiptBase64: B1_B64,
		rigWarmupDrainedReceiptSignatureBase64: B1_B64,
	},
	"rig-present-start-barrier-request/v1": {
		schema: "rig-present-start-barrier-request/v1",
		requestSeq: 5,
		executionSha256: B1_HEX_X,
		cohortStartBarrierBase64: B1_B64,
		cohortStartBarrierSignatureBase64: B1_B64,
	},
	"rig-barrier-accepted-ack/v1": {
		schema: "rig-barrier-accepted-ack/v1",
		responseSeq: 5,
		ackRequestSeq: 5,
		executionSha256: B1_HEX_X,
		serverStartBarrierAcceptedBase64: B1_B64,
		serverStartBarrierAcceptedSha256: B1_HEX_Y,
		serverStartBarrierAcceptedSize: 6,
		rigBarrierAcceptanceBase64: B1_B64,
		rigBarrierAcceptanceSignatureBase64: B1_B64,
	},
} satisfies Record<CohortRemoteSchema, CohortRemotePayloadV1>;

/** The sample for one registered kind; missing is a test bug, not a null. */
function b1Remote(
	schema: string,
): Record<string, unknown> & { schema: string } {
	const sample = (B1_REMOTE_SAMPLES as Record<string, unknown>)[schema];
	if (sample === undefined) {
		throw new Error(`no B1 remote sample for ${schema}`);
	}
	return sample as Record<string, unknown> & { schema: string };
}

describe("B1 §3.3 remote frame registration", () => {
	test("cohort kinds are registered once and disjoint from Phase A kinds", () => {
		expect(COHORT_REMOTE_PAYLOAD_SCHEMAS.length).toBe(22);
		expect(PHASE_A_REMOTE_PAYLOAD_SCHEMAS.length).toBe(21);
		expect(REMOTE_PAYLOAD_SCHEMAS.length).toBe(43);
		expect(new Set(REMOTE_PAYLOAD_SCHEMAS).size).toBe(43);
		for (const schema of COHORT_REMOTE_PAYLOAD_SCHEMAS) {
			expect(isCohortRemoteSchema(schema)).toBe(true);
			expect(
				(PHASE_A_REMOTE_PAYLOAD_SCHEMAS as readonly string[]).includes(schema),
			).toBe(false);
		}
		for (const schema of PHASE_A_REMOTE_PAYLOAD_SCHEMAS) {
			expect(isCohortRemoteSchema(schema)).toBe(false);
		}
		// The registry covers exactly the plan's samples, no more and no fewer.
		expect(Object.keys(B1_REMOTE_SAMPLES).sort()).toEqual(
			[...COHORT_REMOTE_PAYLOAD_SCHEMAS].sort(),
		);
	});

	test("registered payload bounds are the exact plan caps", () => {
		expect(COHORT_WARMUP_MANIFEST_EXPORT_MAX_DECODED_BYTES).toBe(262_144);
		expect(COHORT_WARMUP_MANIFEST_EXPORT_MAX_ENCODED_BYTES).toBe(393_216);
		expect(COHORT_EVIDENCE_EXPORT_MAX_DECODED_BYTES).toBe(9_437_184);
		expect(COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES).toBe(14_680_064);
		expect(COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES).toBe(20_971_520);
		expect(REMOTE_REGISTERED_MAX_PAYLOAD_BYTES).toBe(14_680_064);
		expect(
			COHORT_REMOTE_PAYLOAD_BOUNDS[
				"mac-warmup-completion-manifest-exported-ack/v1"
			],
		).toBe(393_216);
		// Registry edit (e) / NEW-21: plan 529's pair follows the bulk onto the
		// request, and the ack shrinks to what a receipt needs.
		expect(
			COHORT_REMOTE_PAYLOAD_BOUNDS["mac-export-cohort-evidence-request/v1"],
		).toBe(14_680_064);
		expect(
			COHORT_REMOTE_PAYLOAD_BOUNDS["mac-cohort-evidence-exported-ack/v1"],
		).toBe(8_192);
		expect(COHORT_REMOTE_PAYLOAD_BOUNDS["mac-open-cohort-request/v1"]).toBe(
			7_340_032,
		);
		expect(
			remotePayloadBoundForSchema("mac-admit-client-series-request/v1"),
		).toBe(262_144);
		expect(remotePayloadBoundForSchema("mac-open-execution-request/v1")).toBe(
			1_048_576,
		);
		expect(remotePayloadBoundForSchema("remote-supervisor-refusal/v1")).toBe(
			1_048_576,
		);
		expect(remotePayloadBoundForSchema("mac-open-cohort-request/v2")).toBe(
			null,
		);
	});

	test("frame-layer caps do not drift from the cohort record caps", () => {
		expect(COHORT_EVIDENCE_EXPORT_MAX_DECODED_BYTES).toBe(B1_EVIDENCE_DECODED);
		expect(COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES).toBe(B1_EVIDENCE_ENCODED);
		expect(COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES).toBe(B1_EVIDENCE_BUDGET);
		expect(COHORT_WARMUP_MANIFEST_EXPORT_MAX_DECODED_BYTES).toBe(
			B1_WARMUP_MANIFEST_CAP,
		);
	});

	test("every cohort remote record round-trips through the frame codec", () => {
		for (const schema of COHORT_REMOTE_PAYLOAD_SCHEMAS) {
			const sample = b1Remote(schema);
			const parsed = parseCohortRemotePayload(sample);
			expect(parsed.ok).toBe(true);
			const encoded = encodeRegisteredRemotePayload(sample);
			expect(encoded.ok).toBe(true);
			if (!encoded.ok) continue;
			const decoded = decodeRegisteredRemotePayload(encoded.value);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) continue;
			expect(decoded.value.headerKind).toBe(schema.slice(0, -"/v1".length));
			expect(decoded.value.payload).toEqual(sample);
			expect(parseCohortRemotePayload(decoded.value.payload).ok).toBe(true);
		}
	});

	test("an unregistered remote kind is refused by encoder and decoder", () => {
		expect(
			encodeRegisteredRemotePayload({ schema: "mac-open-cohort-request/v2" })
				.ok,
		).toBe(false);
		expect(
			encodeRegisteredRemotePayload({ schema: "cohort-grant/v1", a: 1 }).ok,
		).toBe(false);
		// A frame whose header kind is unknown never reaches payload allocation.
		const known = encodeRegisteredRemotePayload(
			b1Remote("mac-open-cohort-request/v1"),
		);
		expect(known.ok).toBe(true);
		if (!known.ok) return;
		const corrupted = new Uint8Array(known.value);
		// Flip the header kind's first character: "mac-" -> "nac-".
		const text = new TextDecoder().decode(corrupted);
		const at = text.indexOf("mac-open-cohort-request");
		expect(at).toBeGreaterThan(0);
		corrupted[at] = "n".charCodeAt(0);
		expect(decodeRegisteredRemotePayload(corrupted).ok).toBe(false);
		expect(decodeRegisteredRemotePayload(new Uint8Array(3)).ok).toBe(false);
	});

	test("each cohort remote payload is bounded by its own registered cap", () => {
		// The evidence export legally exceeds the 1 MiB default; the same byte
		// count on a default-bounded kind is refused. After NEW-21's cap split
		// the frame that legally exceeds it is the *request*, which carries the
		// role-child bundle; the ack is a receipt and is capped at 8 KiB.
		const bigEvidence = {
			...b1Remote("mac-export-cohort-evidence-request/v1"),
			roleChildEvidenceBundleBase64: "A".repeat(2_000_000),
		};
		expect(encodeRegisteredRemotePayload(bigEvidence).ok).toBe(true);
		const fatAck = {
			...b1Remote("mac-cohort-evidence-exported-ack/v1"),
			cohortObservationEvidenceSignatureBase64: "A".repeat(9_000),
		};
		expect(encodeRegisteredRemotePayload(fatAck).ok).toBe(false);
		const bigOpen = {
			...b1Remote("mac-open-cohort-request/v1"),
			workloadRolePlanInputBase64: "A".repeat(2_000_000),
			workloadRolePlanInputSize: 1_500_000,
		};
		expect(encodeRegisteredRemotePayload(bigOpen).ok).toBe(false);
		// Cap + 1 on the warmup-manifest export is refused.
		const overWarmup = {
			...b1Remote("mac-warmup-completion-manifest-exported-ack/v1"),
			roleWarmupCompletionManifestBase64: "A".repeat(
				COHORT_WARMUP_MANIFEST_EXPORT_MAX_ENCODED_BYTES,
			),
		};
		expect(encodeRegisteredRemotePayload(overWarmup).ok).toBe(false);
	});

	test("cohort remote parsers reject unknown, missing, and mistyped fields", () => {
		for (const schema of COHORT_REMOTE_PAYLOAD_SCHEMAS) {
			const sample = b1Remote(schema);
			expect(parseCohortRemotePayload({ ...sample, extra: 1 }).ok).toBe(false);
			for (const key of Object.keys(sample)) {
				const missing = { ...sample };
				delete missing[key];
				expect(parseCohortRemotePayload(missing).ok).toBe(false);
				const nulled = { ...sample, [key]: null };
				expect(parseCohortRemotePayload(nulled).ok).toBe(false);
			}
		}
		expect(parseCohortRemotePayload(null).ok).toBe(false);
		expect(parseCohortRemotePayload([]).ok).toBe(false);
		expect(
			parseCohortRemotePayload({
				...b1Remote("mac-open-cohort-request/v1"),
				requestSeq: -1,
			}).ok,
		).toBe(false);
		expect(
			parseCohortRemotePayload({
				...b1Remote("mac-open-cohort-request/v1"),
				executionSha256: `${B1_HEX_X.slice(0, 63)}Z`,
			}).ok,
		).toBe(false);
		expect(
			parseCohortRemotePayload({
				...b1Remote("mac-open-cohort-request/v1"),
				workloadRolePlanInputBase64: "not base64!!",
			}).ok,
		).toBe(false);
		expect(
			parseCohortRemotePayload({
				...b1Remote("mac-rig-barrier-acceptance-ack/v1"),
				roleChildrenMayArm: false,
			}).ok,
		).toBe(false);
	});
});

describe("B1 §3.4 role-child frame registration", () => {
	test("role-child kinds are registered and disjoint from Phase A kinds", () => {
		expect(PHASE_B_ROLE_CHILD_SCHEMAS.length).toBe(15);
		expect(new Set(PHASE_B_ROLE_CHILD_SCHEMAS).size).toBe(15);
		for (const schema of PHASE_B_ROLE_CHILD_SCHEMAS) {
			expect(isRoleChildSchema(schema)).toBe(true);
		}
		for (const schema of PHASE_A_CHILD_SCHEMAS) {
			if (schema === "child-pipe-refusal/v1") continue;
			expect(isRoleChildSchema(schema)).toBe(false);
		}
		// The refusal frame is the one kind both pipes share.
		expect(
			(PHASE_B_ROLE_CHILD_SCHEMAS as readonly string[]).includes(
				"child-pipe-refusal/v1",
			),
		).toBe(true);
	});

	test("role-child frame bounds are the exact plan caps", () => {
		expect(ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES).toBe(524_288);
		expect(ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES).toBe(B1_SPAWN_CONFIG_CAP);
		expect(CHILD_PIPE_CONTROL_MAX_BYTES).toBe(65_536);
		expect(CHILD_PIPE_PARTIAL_MAX_BYTES).toBe(262_144);
		expect(roleChildFrameBoundForSchema("role-spawn-config/v1")).toBe(524_288);
		expect(roleChildFrameBoundForSchema("role-partial/v1")).toBe(262_144);
		expect(roleChildFrameBoundForSchema("role-ready/v1")).toBe(65_536);
		expect(roleChildFrameBoundForSchema("child-pipe-refusal/v1")).toBe(65_536);
		expect(roleChildFrameBoundForSchema("server-ready/v1")).toBe(null);
	});

	test("role-child direction cap is two frames per session plus sixty-four", () => {
		expect(ROLE_CHILD_FRAMES_PER_SESSION).toBe(2);
		expect(ROLE_CHILD_BASE_FRAMES_PER_DIRECTION).toBe(64);
		expect(roleChildMaxFramesPerDirection(0)).toBe(64);
		expect(roleChildMaxFramesPerDirection(1)).toBe(66);
		expect(roleChildMaxFramesPerDirection(1_250)).toBe(2_564);
		expect(() => roleChildMaxFramesPerDirection(-1)).toThrow();
		expect(() => roleChildMaxFramesPerDirection(1.5)).toThrow();
	});

	test("role-child frames round-trip and unknown kinds are refused", () => {
		for (const schema of PHASE_B_ROLE_CHILD_SCHEMAS) {
			const record = { schema, sequence: 0, executionSha256: B1_HEX_X };
			const encoded = encodeRoleChildFrame(record);
			expect(encoded.ok).toBe(true);
			if (!encoded.ok) continue;
			const decoded = decodeRoleChildFrame(encoded.value);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) continue;
			expect(decoded.value).toEqual(record);
			expect(decodeRoleChildFrame(encoded.value, schema).ok).toBe(true);
			expect(decodeRoleChildFrame(encoded.value, "role-exit/v1").ok).toBe(
				schema === "role-exit/v1",
			);
		}
		expect(
			encodeRoleChildFrame({ schema: "server-ready/v1", sequence: 0 }).ok,
		).toBe(false);
		expect(
			encodeRoleChildFrame({ schema: "role-spawn-config/v2", sequence: 0 }).ok,
		).toBe(false);
	});

	test("each role-child frame is bounded by its own registered cap", () => {
		const pad = (schema: string, bytes: number) => ({
			schema,
			sequence: 0,
			executionSha256: B1_HEX_X,
			filler: "a".repeat(bytes),
		});
		// A 100 KiB spawn config is legal; the same size as a control frame is not.
		expect(encodeRoleChildFrame(pad("role-spawn-config/v1", 100_000)).ok).toBe(
			true,
		);
		expect(encodeRoleChildFrame(pad("role-ready/v1", 100_000)).ok).toBe(false);
		// A 100 KiB partial is legal; 300 KiB is not.
		expect(encodeRoleChildFrame(pad("role-partial/v1", 100_000)).ok).toBe(true);
		expect(encodeRoleChildFrame(pad("role-partial/v1", 300_000)).ok).toBe(
			false,
		);
		expect(
			encodeRoleChildFrame(
				pad("role-spawn-config/v1", ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES),
			).ok,
		).toBe(false);
		// A frame declaring more bytes than its kind allows is refused at decode.
		const big = encodeRoleChildFrame(pad("role-spawn-config/v1", 100_000));
		expect(big.ok).toBe(true);
		if (!big.ok) return;
		expect(decodeRoleChildFrame(big.value, "role-ready/v1").ok).toBe(false);
	});
});

describe("B1 role-record origin registration", () => {
	test("cohort authority records can never be child originated", () => {
		expect(PHASE_B_COHORT_AUTHORITY_SCHEMAS.length).toBeGreaterThan(0);
		for (const schema of PHASE_B_COHORT_AUTHORITY_SCHEMAS) {
			expect(roleRecordOrigin(schema)).toBe("supervisor");
			expect(
				validateRoleChildRecordOrigin({ schema, origin: "supervisor" }).ok,
			).toBe(true);
			expect(
				validateRoleChildRecordOrigin({ schema, origin: "child-reported" }).ok,
			).toBe(false);
		}
		for (const schema of PHASE_B_ROLE_CHILD_ORIGINATED_SCHEMAS) {
			expect(roleRecordOrigin(schema)).toBe("child-reported");
			expect(
				validateRoleChildRecordOrigin({ schema, origin: "child-reported" }).ok,
			).toBe(true);
			expect(
				validateRoleChildRecordOrigin({ schema, origin: "supervisor" }).ok,
			).toBe(false);
		}
	});

	test("every registered role-child kind has exactly one origin", () => {
		const both = [
			...PHASE_B_COHORT_AUTHORITY_SCHEMAS,
			...PHASE_B_ROLE_CHILD_ORIGINATED_SCHEMAS,
		];
		expect(new Set(both).size).toBe(both.length);
		for (const schema of PHASE_B_ROLE_CHILD_SCHEMAS) {
			if (schema === "child-pipe-refusal/v1") continue;
			expect(both.includes(schema)).toBe(true);
		}
		expect(roleRecordOrigin("server-ready/v1")).toBe(null);
		expect(
			validateRoleChildRecordOrigin({
				schema: "server-ready/v1",
				origin: "child-reported",
			}).ok,
		).toBe(false);
	});
});

describe("cohort-protocol B3.5 §4.1 grant vector and per-cell grant parameters", () => {
	/**
	 * The canonical bytes of one `cohort-grant/v1` at the ticker 10k shape:
	 * 1 publisher, 8 shards, 100 subscribers.
	 *
	 * `crates/native/tests/cohort_protocol.rs` holds this same literal as
	 * `RUST_PINNED_TICKER10K_GRANT_HEX` and feeds it to the real
	 * `CohortGrantV1::parse_signed`. A pinned byte string is what the pair
	 * needs: the defect it exists to catch was two correct-looking readings of
	 * `lastSubscriberIndexExclusive`, one the shard's own count and one the
	 * grant's total, and only bytes where the two differ tell them apart. In
	 * these bytes the bound is 100 on all eight shards while `subscriberCount`
	 * is 13 on residues 0..3 and 12 on residues 4..7.
	 *
	 * The commitment windows are residue-class spans (R-A): worker `w` starts
	 * at `1 + w` and ends at `first + (count - 1) * 8 + 1`, so `[1, 98)`,
	 * `[2, 99)`, `[3, 100)`, `[4, 101)`, `[5, 94)`, `[6, 95)`, `[7, 96)`,
	 * `[8, 97)`. A dense `[first, first + count)` is the old placeholder that
	 * held only the first sixteen members of a shard and is refused below.
	 */
	const RUST_PINNED_TICKER10K_GRANT_HEX =
		"7b22617070726f76616c5265636f7264536861323536223a2266666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666222c22617070726f766564506c616e536861323536223a2265656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565222c22636f686f7274417474656d7074223a312c22636f686f72744964223a22636f686f72742d7469636b65722d31306b222c22636f6e6e656374696f6e526174655065725365636f6e64223a3530302c22647261696e446561646c696e654d73223a31303030302c22657865637574696f6e223a7b22617070726f76616c5265636f7264536861323536223a2266666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666222c22617070726f766564506c616e536861323536223a2265656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565222c2261726d4b696e64223a227072696d617279222c22617574686f72697479536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2263616d706169676e4964223a2263616d70222c2263616d706169676e4c6f636b536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c2263616e646964617465223a2263616e64222c2263656c6c4964223a227469636b65722d66616e6f75742f726174652d3130303030222c226465636c617265644d6573736167654279746573223a3130302c226465636c617265644d657373616765436f756e74223a31303030303030302c226472616674536861323536223a2239356334656361363766633931356634373861363461356332663264666665323431343736396236666462306437633236393539303130643832336436306639222c22657865637574696f6e496e646578223a302c22657865637574696f6e507572706f7365223a22666f6375736564222c226772616e744465636c61726174696f6e223a2266616e6f75742d657870616e6465642d64656c69766572696573222c2269737375656441744d73223a313030302c226d616353757065727669736f72496e7374616e63654e6f6e6365223a2235353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535222c226d6561737572656d656e744772616e74536861323536223a2234353037613832366366303139326434356664626164383038396130326533323137363730316537646234646435333563313136366362363161343666316335222c226e6f7441667465724d73223a323030302c2272657065746974696f6e496e646578223a312c2272657065746974696f6e4b696e64223a226d65617375726564222c2272657065746974696f6e546f74616c223a312c22726f6c65506c616e48617368223a2232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232222c2272756e4964223a2263616d702f7469636b65722d66616e6f75742d31306b2f77732f6d656173757265642d31222c227363656e6172696f48617368223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c22736368656d61223a2263726f73732d73757065727669736f722d657865637574696f6e2f7631222c22736f7572636541726368697665536861323536223a2264646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464222c227374616765644361706162696c697479536861323536223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363222c227374616765645365727665724c61756e63685265636f7264536861323536223a2234343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434222c227472616e73706f7274223a227773222c22776f726b6c6f6164526f6c65506c616e496e707574536861323536223a2233333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333227d2c22657865637574696f6e536861323536223a2261316638366665353331316638333536306135626530326237343134313861623264346232336366363830653539353261333434663565353033633834396230222c226578706563746564457870616e64656444656c69766572696573223a31303030303030302c2265787065637465644f666665726564496e6772657373223a3130303030302c22657870656374656450726f63657373436f756e74223a392c22657870656374656453657373696f6e436f756e74223a3130312c22696e52657065746974696f6e5761726d75704d73223a353030302c2269737375656441744d73223a313030302c226d6163457865637574696f6e4772616e7452656365697074536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c226d616353757065727669736f72496e7374616e63654e6f6e6365223a2235353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535222c226d6178436f6e6e656374696f6e73496e466c69676874223a3230302c226d656173757265644475726174696f6e4d73223a31303030302c226d6573736167654279746573223a3130302c226e6f7441667465724d73223a323030302c227075626c6973686572436f756e74223a312c227075626c697368657273223a5b7b226368696c644964223a227075626c69736865722d303030303030222c227075626c69736865724964223a227075626c69736865722d303030303030222c22736368656d61223a227075626c69736865722d726f6c652d6772616e742f7631222c22746f6b656e436f6d6d69746d656e74496e646578223a302c22746f6b656e536861323536223a2231323137643862613839393330343932343337313034653134313033393366623261393135633738373938383036633930343965623765653765363263313236227d5d2c2272656164696e657373446561646c696e654d73223a33303030302c227265636569707453657175656e6365223a312c22726f6c65506c616e48617368223a2232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232222c22726f6c65546f6b656e436f6d6d69746d656e74436f756e74223a3130312c22726f6c65546f6b656e436f6d6d69746d656e74526f6f74536861323536223a2231663431633739343964323963383361626261303435633430373530363539616361616636363765653266336337326339356432623463356631396430623562222c2273616d706c6557696e646f774d73223a313030302c227363656e6172696f48617368223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c22736368656d61223a22636f686f72742d6772616e742f7631222c227369676e696e675075626c69634b6579536861323536223a2262303964343438346239393966666530636362613131666639613639393539333864633562323066323762356564636133376632356563373264353839626232222c2273756273637269626572436f756e74223a3130302c2273756273637269626572536861726473223a5b7b226368696c644964223a22737562736372696265722d776f726b65722d30222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a312c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39382c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2262343833646334633264663965343065353833383465643236646439626439306637373539333762393839663330663435656535323433633663313035653364222c2272657369647565223a302c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a307d2c7b226368696c644964223a22737562736372696265722d776f726b65722d31222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a322c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39392c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2264343763396461646633636165646439636262656265346132343233623161633062303165323935383064323130393861363166346665303139343964373365222c2272657369647565223a312c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a317d2c7b226368696c644964223a22737562736372696265722d776f726b65722d32222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a332c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a3130302c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2234353738623831653538313232303830643766376435643237633933643536666135626237636666393864356532656561393035356134663933316432646435222c2272657369647565223a322c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a327d2c7b226368696c644964223a22737562736372696265722d776f726b65722d33222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a342c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a3130312c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2233646237626662613461386337316266323063333739623738363266393438656430633038343432373663363935636537376334356534356433613563366364222c2272657369647565223a332c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a337d2c7b226368696c644964223a22737562736372696265722d776f726b65722d34222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a352c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39342c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2239346332306562653561616132326633613134656339396430366238376136666136656136343935393237383166303932313035386632646662393038666366222c2272657369647565223a342c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a347d2c7b226368696c644964223a22737562736372696265722d776f726b65722d35222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a362c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39352c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2239356536386162326238393239653430303966393934643136356462633338316465313739313661656130343435313665626638623930363830633334633931222c2272657369647565223a352c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a357d2c7b226368696c644964223a22737562736372696265722d776f726b65722d36222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a372c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39362c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2266313532303330646633626662366236386437333161343163396330396665383630643631333531336631383630356431343632383734376137353763363739222c2272657369647565223a362c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a367d2c7b226368696c644964223a22737562736372696265722d776f726b65722d37222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a382c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39372c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2236613830633262313761666562663861343634343063323964303862653666626261313936653562633134636437613466363838356232616133633130326561222c2272657369647565223a372c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a377d5d2c22746f6b656e436f6d6d69746d656e744c6561664d616e6966657374536861323536223a2266373062313031613033343739663430306364343630613963633733343932306162636234623233383234633835653430303865316461393733306433393965222c227472616e73706f7274223a227773222c22776f726b6572436f756e74223a382c22776f726b6c6f6164526f6c65506c616e496e707574536861323536223a2233333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333227d0a";

	function pinnedGrantBytes(): Uint8Array {
		return new Uint8Array(Buffer.from(RUST_PINNED_TICKER10K_GRANT_HEX, "hex"));
	}

	function pinnedGrantValue(): Record<string, unknown> {
		return JSON.parse(new TextDecoder().decode(pinnedGrantBytes())) as Record<
			string,
			unknown
		>;
	}

	function shardsOf(value: Record<string, unknown>): Record<string, unknown>[] {
		return value.subscriberShards as Record<string, unknown>[];
	}

	test("the_shard_bound_is_the_grants_subscriber_total", () => {
		const bytes = pinnedGrantBytes();
		const value = pinnedGrantValue();
		const parsed = parseCohortGrant(value);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);

		// The hex is canonical, not one serialiser's opinion: re-encoding the
		// record it decodes to reproduces the pinned bytes exactly, which is
		// also what the Rust side asserts against its own encoder.
		expect(Buffer.from(bytesOfCanonical(parsed.value)).toString("hex")).toBe(
			RUST_PINNED_TICKER10K_GRANT_HEX,
		);
		expect(bytes.length).toBe(6_268);

		expect(parsed.value.subscriberCount).toBe(100);
		expect(parsed.value.publisherCount).toBe(1);
		expect(parsed.value.subscriberShards.length).toBe(SUBSCRIBER_SHARD_MODULUS);
		let total = 0;
		for (const [index, shard] of parsed.value.subscriberShards.entries()) {
			expect(shard.workerIndex).toBe(index);
			expect(shard.residue).toBe(index);
			expect(shard.lastSubscriberIndexExclusive).toBe(100);
			// The two readings are visibly different numbers in these bytes.
			expect(shard.subscriberCount).not.toBe(100);
			// R-A: the window is the residue-class span, which for every shard
			// but the first is wider than its count.
			expect(shard.firstTokenCommitmentIndex).toBe(1 + index);
			expect(shard.lastTokenCommitmentIndexExclusive).toBe(
				subscriberShardCommitmentWindowEnd(1 + index, shard.subscriberCount),
			);
			expect(
				shard.lastTokenCommitmentIndexExclusive -
					shard.firstTokenCommitmentIndex,
			).toBeGreaterThan(shard.subscriberCount);
			total += shard.subscriberCount;
		}
		expect(total).toBe(100);

		// The vector also carries this cell's two grant parameters.
		const row = cohortCellGrantParameters("ticker 10k");
		expect(parsed.value.measuredDurationMs).toBe(row.measuredDurationMs);
		expect(parsed.value.messageBytes).toBe(row.messageBytes);
	});

	test("a_shard_bound_to_its_own_count_is_refused_on_both_sides", () => {
		const value = pinnedGrantValue();
		expect(parseCohortGrant(pinnedGrantValue()).ok).toBe(true);
		// Residue 0 carries 13 subscribers; declaring 13 as the bound is
		// exactly the shard-local reading this parser used to accept.
		shardsOf(value)[0]!.lastSubscriberIndexExclusive = 13;
		expect(parseCohortGrant(value).ok).toBe(false);
	});

	test("a_reordered_shard_array_is_refused_on_both_sides", () => {
		const value = pinnedGrantValue();
		const shards = shardsOf(value);
		const left = shards[2]!;
		shards[2] = shards[5]!;
		shards[5] = left;
		// Every entry is still individually well formed and the eight are the
		// same eight; only their positions moved.
		expect(parseCohortGrant(value).ok).toBe(false);
	});

	test("a_seven_shard_grant_is_refused_on_both_sides", () => {
		const value = pinnedGrantValue();
		shardsOf(value).pop();
		expect(parseCohortGrant(value).ok).toBe(false);
	});

	test("every_cell_pins_its_own_duration_and_payload_size", () => {
		expect(COHORT_CELL_GRANT_PARAMETERS.length).toBe(
			COHORT_CELL_CARDINALITIES.length,
		);
		const seen = new Set<string>();
		for (const row of COHORT_CELL_GRANT_PARAMETERS) {
			expect(seen.has(row.cell)).toBe(false);
			seen.add(row.cell);
			// Both values stay inside the frozen unions the grant declares:
			// this table selects, it does not widen or narrow.
			expect(COHORT_MEASURED_DURATION_MS_VALUES).toContain(
				row.measuredDurationMs,
			);
			expect(COHORT_MESSAGE_BYTES_VALUES).toContain(row.messageBytes);

			const cardinality = cohortCellCardinality(row.cell);
			const ticker = row.cell.startsWith("ticker ");
			// Plan §4.2: exactly 100 bytes ticker, 128 bytes chat.
			expect(row.messageBytes).toBe(ticker ? 100 : 128);
			if (ticker) {
				// A ticker cell id names an offered ingress rate, and its §4.5
				// row names an offered ingress count; the window is the
				// quotient, and it is a derivation rather than a choice.
				const perSecond =
					Number(row.cell.slice("ticker ".length).replace("k", "")) * 1_000;
				expect(cardinality.measuredIngress).toBe(
					(perSecond * row.measuredDurationMs) / 1_000,
				);
			} else {
				// A chat cell id names a subscriber count and fixes no rate, so
				// 30 s is chosen: thirty windows for the §4.5 rate series.
				expect(row.measuredDurationMs).toBe(30_000);
			}
			// Every row is a legal window count: an integer number of 1 s
			// sample windows.
			expect(row.measuredDurationMs % COHORT_SAMPLE_WINDOW_MS).toBe(0);
		}
		for (const row of COHORT_CELL_CARDINALITIES) {
			expect(seen.has(row.cell)).toBe(true);
		}
		expect(() => cohortCellGrantParameters("chat 2k")).toThrow(RangeError);
	});

	test("the_exact_4_5_table_is_unchanged", () => {
		// The new table is a second constant, not two more columns here. Plan
		// §4.5 has exactly these seven columns and neither of the two grant
		// parameters, and `COHORT_CELL_CARDINALITIES`'s own comment says it is
		// that table. This pins both the key set and the six rows.
		expect(
			COHORT_CELL_CARDINALITIES.map((row) => Object.keys(row).sort()),
		).toEqual(
			COHORT_CELL_CARDINALITIES.map(() => [
				"cell",
				"expandedDeliveries",
				"measuredIngress",
				"publisherCount",
				"sessionCount",
				"subscriberCount",
				"workerCount",
			]),
		);
		expect(COHORT_CELL_CARDINALITIES).toEqual([
			{
				cell: "ticker 10k",
				publisherCount: 1,
				workerCount: 8,
				subscriberCount: 100,
				sessionCount: 101,
				measuredIngress: 100_000,
				expandedDeliveries: 10_000_000,
			},
			{
				cell: "ticker 50k",
				publisherCount: 1,
				workerCount: 8,
				subscriberCount: 100,
				sessionCount: 101,
				measuredIngress: 500_000,
				expandedDeliveries: 50_000_000,
			},
			{
				cell: "ticker 100k",
				publisherCount: 1,
				workerCount: 8,
				subscriberCount: 100,
				sessionCount: 101,
				measuredIngress: 1_000_000,
				expandedDeliveries: 100_000_000,
			},
			{
				cell: "chat 1k",
				publisherCount: 10,
				workerCount: 8,
				subscriberCount: 1_000,
				sessionCount: 1_010,
				measuredIngress: 300,
				expandedDeliveries: 300_000,
			},
			{
				cell: "chat 5k",
				publisherCount: 10,
				workerCount: 8,
				subscriberCount: 5_000,
				sessionCount: 5_010,
				measuredIngress: 300,
				expandedDeliveries: 1_500_000,
			},
			{
				cell: "chat 10k",
				publisherCount: 10,
				workerCount: 8,
				subscriberCount: 10_000,
				sessionCount: 10_010,
				measuredIngress: 300,
				expandedDeliveries: 3_000_000,
			},
		]);
		for (const row of COHORT_CELL_CARDINALITIES) {
			expect(row.sessionCount).toBe(row.publisherCount + row.subscriberCount);
			expect(row.expandedDeliveries).toBe(
				row.measuredIngress * row.subscriberCount,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Amendment C3, residual R2: the two parser rules under which the TS graph
// parser refuses the binary's own pinned observation vectors
// (cross-supervisor-protocol.test.ts, "the production consumer accepts the
// binary's own terminal ack"). Each test is the minimal positive repro of one
// divergence against the production producers, and is RED until the TS rule
// matches the binary (notes/r2.md).
// ---------------------------------------------------------------------------
describe("amendment C3 residual R2: TS parser rules that refuse the binary's own records", () => {
	// Production shards are residue classes: `workerIndex = index % 8` and
	// commitment indices assigned in leaf order (fanout-relay.ts:2026, :2036;
	// mac_cohort_runtime.rs:284-305), so worker w's window is the span of its
	// residue class, `[publisherCount + w, publisherCount + w + (count - 1) * 8 + 1)`
	// (R-A), and consecutive workers' windows overlap as intervals while never
	// sharing a leaf. The binary checks stride-8 contiguity against the leaves
	// (secure_fs.rs:19199-19205) and nothing about the ranges at the grant
	// level (`parse_shards`, :12646-12683); `parseCohortGrant` used to check
	// interval disjointness and refused every production grant.
	test("parseCohortGrant accepts the shard layout both production producers emit", () => {
		const shards = subscriberShards();
		expect(shards[1]?.firstTokenCommitmentIndex).toBe(PUBLISHER_COUNT + 1);
		expect(shards[0]?.lastTokenCommitmentIndexExclusive).toBe(
			subscriberShardCommitmentWindowEnd(PUBLISHER_COUNT, SHARD_SUBSCRIBERS),
		);
		const parsed = parseCohortGrant(cohortGrant({ subscriberShards: shards }));
		if (!parsed.ok) {
			throw new Error(
				`R2 divergence (2): the production shard layout is refused: ${parsed.message}`,
			);
		}
	});

	test("verifyPresentedCohortTopology accepts the grant against the leaves it was derived from", () => {
		const grant = cohortGrant();
		const leaves = orderTokenCommitmentLeaves(cohortLeaves());
		expect(verifyPresentedCohortTopology({ grant, leaves }).ok).toBe(true);
	});

	// R-A: a shard's window is the exact span of its residue class. Under the
	// old dense `first + count` the window of a 125-member shard held only
	// its first sixteen members (16 * 8 = 128 > 125), which is where the
	// relay refused the seventeenth subscriber of every worker on the real
	// binaries (`WRONG_SHARD`, then `READY_DEADLINE_EXCEEDED`).
	test("a_shard_window_is_the_span_of_its_residue_class_and_holds_every_member", () => {
		const leaves = orderTokenCommitmentLeaves(cohortLeaves());
		const shards = subscriberShards();
		for (const [worker, shard] of shards.entries()) {
			expect(shard.subscriberCount).toBe(SHARD_SUBSCRIBERS);
			expect(shard.firstTokenCommitmentIndex).toBe(PUBLISHER_COUNT + worker);
			expect(shard.lastTokenCommitmentIndexExclusive).toBe(
				PUBLISHER_COUNT + worker + (SHARD_SUBSCRIBERS - 1) * 8 + 1,
			);
			const members = leaves
				.map((leaf, index) => ({ leaf, index }))
				.filter(({ leaf }) => leaf.workerIndex === worker);
			expect(members.length).toBe(SHARD_SUBSCRIBERS);
			// Every member, the seventeenth included, sits inside the window,
			// and the window's last slot is exactly the last member.
			for (const { index } of members) {
				expect(index).toBeGreaterThanOrEqual(shard.firstTokenCommitmentIndex);
				expect(index).toBeLessThan(shard.lastTokenCommitmentIndexExclusive);
				expect((index - shard.firstTokenCommitmentIndex) % 8).toBe(0);
			}
			expect((members[16] as { index: number }).index).toBe(
				PUBLISHER_COUNT + worker + 16 * 8,
			);
			expect((members[members.length - 1] as { index: number }).index).toBe(
				shard.lastTokenCommitmentIndexExclusive - 1,
			);
			expect(parseSubscriberShard(shard, SUBSCRIBER_COUNT).ok).toBe(true);
		}
		expect(parseCohortGrant(cohortGrant({ subscriberShards: shards })).ok).toBe(
			true,
		);
	});

	test("a_dense_window_one_short_of_the_residue_span_is_refused_by_every_parser", () => {
		const leaves = orderTokenCommitmentLeaves(cohortLeaves());
		const honest = subscriberShards();
		// The old formula: `first + count`. For worker 3 that is 138 where the
		// residue span ends at 1006; the seventeenth member (index 141) and
		// every later one fall outside it.
		const dense = honest.map((shard) => ({
			...shard,
			lastTokenCommitmentIndexExclusive:
				shard.firstTokenCommitmentIndex + shard.subscriberCount,
		}));
		for (const shard of dense) {
			const refused = parseSubscriberShard(shard, SUBSCRIBER_COUNT);
			expect(refused.ok).toBe(false);
			if (!refused.ok) {
				expect(refused.code).toBe("COHORT_PROTOCOL");
				expect(refused.message).toBe("subscriber shard fields");
			}
		}
		const grant = parseCohortGrant(cohortGrant({ subscriberShards: dense }));
		expect(grant.ok).toBe(false);
		if (!grant.ok) expect(grant.code).toBe("COHORT_PROTOCOL");
		// One shard dense among seven honest ones is refused by the leaf-aware
		// verifier too, so a grant that slipped past a grant-level parser is
		// still caught against the leaves.
		const oneDense = honest.map((shard, index) =>
			index === 3 ? (dense[3] as SubscriberShardV1) : shard,
		);
		const topology = verifyPresentedCohortTopology({
			grant: cohortGrant({ subscriberShards: oneDense }),
			leaves,
		});
		expect(topology.ok).toBe(false);
		if (!topology.ok) expect(topology.message).toBe("subscriber topology");
		// And one past the span is refused just the same: the window is exact.
		const wide = honest.map((shard) => ({
			...shard,
			lastTokenCommitmentIndexExclusive:
				shard.lastTokenCommitmentIndexExclusive + 1,
		}));
		expect(
			parseSubscriberShard(wide[0] as SubscriberShardV1, SUBSCRIBER_COUNT).ok,
		).toBe(false);
	});

	// The negative sibling: a shard whose members break the residue rule.
	// Subscribers 8 and 9 trade workers (8 names worker 1, 9 names worker 0),
	// and the shards are recomputed from those leaves so every per-shard field
	// is internally consistent (count, digest, first member, window span —
	// both workers keep 125 members and their first member) — only the stride
	// is broken, which is exactly the check at `secure_fs.rs:19199-19205`.
	test("verifyPresentedCohortTopology refuses a shard whose members are not a residue class", () => {
		const leaves = orderTokenCommitmentLeaves(cohortLeaves()).map((leaf) =>
			leaf.roleId === "subscriber-000008"
				? { ...leaf, childId: "subscriber-worker-1", workerIndex: 1 }
				: leaf.roleId === "subscriber-000009"
					? { ...leaf, childId: "subscriber-worker-0", workerIndex: 0 }
					: leaf,
		);
		const shards = shardsFromLeaves(leaves, SUBSCRIBER_COUNT);
		const grant = cohortGrant({ subscriberShards: shards });
		// The grant-level parser has no leaves and cannot see this, just as
		// the binary's `parse_shards` cannot.
		expect(parseCohortGrant(grant).ok).toBe(true);
		const refused = verifyPresentedCohortTopology({ grant, leaves });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.message).toBe("subscriber topology");

		// And the fields the binary recomputes from the members, one at a time
		// against honest leaves.
		const honest = orderTokenCommitmentLeaves(cohortLeaves());
		const honestShards = subscriberShards();
		const mutate = (patch: Partial<SubscriberShardV1>) =>
			verifyPresentedCohortTopology({
				grant: cohortGrant({
					subscriberShards: honestShards.map((shard, index) =>
						index === 3 ? { ...shard, ...patch } : shard,
					),
				}),
				leaves: honest,
			});
		expect(mutate({ orderedSubscriberIdsSha256: HEX_1 }).ok).toBe(false);
		expect(mutate({ firstTokenCommitmentIndex: PUBLISHER_COUNT }).ok).toBe(
			false,
		);
		expect(mutate({ childId: "subscriber-worker-4" }).ok).toBe(false);
		expect(
			mutate({
				subscriberCount: SHARD_SUBSCRIBERS - 1,
				lastTokenCommitmentIndexExclusive:
					(honestShards[3] as SubscriberShardV1)
						.lastTokenCommitmentIndexExclusive - SUBSCRIBER_SHARD_MODULUS,
			}).ok,
		).toBe(false);
		// A publisher grant naming another leaf's token is the publisher half.
		const publishers = publisherGrants().map((publisher, index) =>
			index === 2 ? { ...publisher, tokenSha256: HEX_2 } : publisher,
		);
		expect(
			verifyPresentedCohortTopology({
				grant: cohortGrant({ publishers }),
				leaves: honest,
			}).ok,
		).toBe(false);
	});

	// The binary mints the barrier after warmup completes
	// (`if now_mac_ns < warmup_completed_ns { refuse }`, secure_fs.rs:21160)
	// and its parser requires warmupStarted <= warmupCompleted <= minted <=
	// measureStart (secure_fs.rs:12788-12796). `parseCohortStartBarrier` used
	// to require minted <= warmupStarted, an order no binary-minted barrier
	// satisfies (vector: minted 5000005000000 > warmupStarted 5000003000000).
	test("parseCohortStartBarrier accepts a barrier ordered as the binary mints it", () => {
		const grant = cohortGrant();
		const barrier = startBarrier(
			grant.executionSha256,
			sha256CanonicalRecord(grant),
			{
				warmupStartedAtMacNs: "1100000000",
				warmupCompletedAtMacNs: "6100000000",
				mintedAtMacNs: "6150000000",
				measureStartAtMacNs: "6400000000",
				measureStopAtMacNs: "36400000000",
			},
		);
		const parsed = parseCohortStartBarrier(barrier);
		if (!parsed.ok) {
			throw new Error(
				`R2 divergence (3): the binary's barrier order is refused: ${parsed.message}`,
			);
		}
		// Equalities are allowed on every edge, as in the Rust parser.
		expect(
			parseCohortStartBarrier(
				startBarrier(grant.executionSha256, sha256CanonicalRecord(grant), {
					warmupStartedAtMacNs: "6100000000",
					warmupCompletedAtMacNs: "6100000000",
					mintedAtMacNs: "6100000000",
					measureStartAtMacNs: "6100000000",
					measureStopAtMacNs: "36100000000",
				}),
			).ok,
		).toBe(true);
	});

	test("parseCohortStartBarrier refuses a barrier minted before its own warmup completed", () => {
		const grant = cohortGrant();
		const grantSha256 = sha256CanonicalRecord(grant);
		const refused = (overrides: Partial<CohortStartBarrierV1>) => {
			const parsed = parseCohortStartBarrier(
				startBarrier(grant.executionSha256, grantSha256, overrides),
			);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) {
				expect(parsed.message).toBe(
					"cohort start barrier timestamps are not ordered",
				);
			}
		};
		// minted < warmupCompleted (`secure_fs.rs:12791`) — the order the old
		// TS fixtures minted in.
		refused({ mintedAtMacNs: "5999999999" });
		// warmupStarted > warmupCompleted (`:12788`).
		refused({ warmupStartedAtMacNs: "6000000001" });
		// measureStart < minted (`:12794`).
		refused({
			measureStartAtMacNs: "6099999999",
			measureStopAtMacNs: "36099999999",
		});
	});
});
