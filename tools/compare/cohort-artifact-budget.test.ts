import {
	cohortExportAckSigningBytes,
	ed25519Sign,
	generateEd25519KeyPair,
} from "./cross-supervisor-protocol.ts";

const exportKeys = generateEd25519KeyPair();
const exportObservations = new WeakMap<object, unknown>();

/**
 * R5 — the chat-10k artifact budget.
 *
 * A §4.4 cohort observation evidence bundle is carried *in full* inside the
 * artifact (`attestationEvidence.cohortObservationEvidence`), and §4.4 lets it
 * reach 9 MiB decoded.  `MAX_ARTIFACT_BYTES` was 8 MiB and
 * `MAX_ARTIFACT_STRING_BYTES` — a cumulative budget over every string in the
 * artifact — was 4 MiB, so the largest cell the plan describes could never be
 * sealed at all.
 *
 * These tests prove the budget by execution rather than by restating the
 * constants: they build the largest structurally valid bundle the §4.4
 * schemas admit for the largest registered cell -- chat 1k since the
 * physical-budget amendment retired the 5k and 10k rows (10 publishers, 8
 * workers, 1 000 subscribers, a 1 010 leaf token commitment manifest padded to
 * the retained-member cap, every opaque member grown to its own cap), seal it,
 * and read it back; and they show the raised budget still refuses one byte
 * past the new ceiling.  The caps themselves keep their chat-10k sizing, so
 * the bundle sits under them with room.
 *
 * The fixture is the `fanout-artifact.test.ts` honest-cohort builder scaled
 * from ticker 100 to chat 1k.  Nothing here is a hand-written digest.
 */
import { describe, expect, test } from "bun:test";
import {
	type ArmCohortEvidenceV1,
	buildRunArtifact,
	cohortEvidenceFromExportAck,
} from "./artifact-builder.ts";
import { withFixtureAttestation } from "./cohort-fixture-signing.ts";
import {
	COHORT_ADMISSION_SIGNATURE_MAX_BYTES,
	COHORT_DERIVED_RECORD_MAX_BYTES,
	COHORT_GRANT_MAX_BYTES,
	COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
	COHORT_REMOTE_EVIDENCE_BUDGET_BYTES,
	COHORT_SIGNATURE_RECORD_MAX_BYTES,
	COHORT_WARMUP_EPOCH_MAX_BYTES,
	COHORT_WORKER_COUNT,
	type CohortCapacityV1,
	type CohortLedgerV1,
	type CohortRateSeriesV1,
	cohortCellCardinality,
	type LinuxRelayObservationV1,
	type ObservedProcessProofV1,
	observedChildrenDigestSha256,
	orderedPartialDigestSetSha256,
	type PublisherPartialV1,
	type RetainedCanonicalBytesV1,
	RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	ROLE_CHILD_FRAME_MAX_BYTES,
	ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	TOKEN_COMMITMENT_LEAF_MANIFEST_MAX_BYTES,
	WORKLOAD_ROLE_PLAN_INPUT_MAX_BYTES,
	type WorkerPartialV1,
} from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	type MacCohortEvidenceExportedAckV1,
	toBase64,
} from "./cross-supervisor-protocol.ts";
import {
	MAX_ARTIFACT_BYTES,
	MAX_ARTIFACT_STRING_BYTES,
	MAX_COHORT_RETAINED_BASE64_LENGTH,
	sealRunArtifact,
} from "./evidence.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import { verifyRunArtifact } from "./verify-artifact.ts";

// --- the largest registered cell, straight out of the D3 cardinality table --

const LARGEST_CELL_ID = "chat-fanout/subscribers-1000";
const CARDINALITY = cohortCellCardinality("chat 1k");
const PUBLISHERS = CARDINALITY.publisherCount;
const SUBSCRIBERS = CARDINALITY.subscriberCount;
const SESSIONS = CARDINALITY.sessionCount;
/** 8 equal shards of the 1 000 subscriber population. */
const SHARD = SUBSCRIBERS / COHORT_WORKER_COUNT;
const WINDOWS = 10;
const MESSAGE_BYTES = 100 as const;
/** D3 measuredIngress 300, spread as 30 per publisher in window 0. */
const OFFERED_PER_PUBLISHER = CARDINALITY.measuredIngress / PUBLISHERS;
const ACCEPTED_TOTAL = CARDINALITY.measuredIngress;
const START_NS = 1_000_000_000_000n;

const HEX = (character: string): string => character.repeat(64);
const EXECUTION_SHA = HEX("a");

function zeros(length: number): number[] {
	return Array.from({ length }, () => 0);
}

function retain(value: unknown): RetainedCanonicalBytesV1 {
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

const GRANT_RETAINED = paddedFiller("cohort-grant", COHORT_GRANT_MAX_BYTES);
const BARRIER_RETAINED = paddedFiller(
	"cohort-start-barrier",
	COHORT_DERIVED_RECORD_MAX_BYTES,
);
const GRANT_SHA = GRANT_RETAINED.sha256;
const BARRIER_SHA = BARRIER_RETAINED.sha256;

/** Zero padded so the ten publisher ids sort ascending as strings. */
function publisherId(index: number): string {
	return `publisher-${String(index).padStart(6, "0")}`;
}

function publisherPartial(index: number): PublisherPartialV1 {
	const offered = zeros(WINDOWS);
	offered[0] = OFFERED_PER_PUBLISHER;
	const offeredBytes = zeros(WINDOWS);
	offeredBytes[0] = OFFERED_PER_PUBLISHER * MESSAGE_BYTES;
	const accepted = zeros(WINDOWS);
	accepted[0] = OFFERED_PER_PUBLISHER;
	return {
		schema: "publisher-partial/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		childId: publisherId(index),
		childPid: 4_100 + index,
		childPgid: 4_100 + index,
		childInstanceNonce: HEX("1"),
		publisherId: publisherId(index),
		tokenSha256: HEX("2"),
		macClockId: "mach-continuous-1",
		windowCount: WINDOWS,
		offeredByOriginWindow: offered,
		offeredBytesByOriginWindow: offeredBytes,
		acceptedAckSeenByOriginWindow: accepted,
		duplicateAckSeenByOriginWindow: zeros(WINDOWS),
		reorderedAckSeenByOriginWindow: zeros(WINDOWS),
		firstOfferAtMacNs: START_NS.toString(),
		lastAckAtMacNs: (START_NS + 1n).toString(),
		exitCode: 0,
	};
}

function workerPartial(workerIndex: number): WorkerPartialV1 {
	const delivered = ACCEPTED_TOTAL * SHARD;
	const deliveredOrigin = zeros(WINDOWS);
	deliveredOrigin[0] = delivered;
	const deliveredBytesOrigin = zeros(WINDOWS);
	deliveredBytesOrigin[0] = delivered * MESSAGE_BYTES;
	return {
		schema: "worker-partial/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		childId: `worker-${workerIndex}`,
		childPid: 4_200 + workerIndex,
		childPgid: 4_200 + workerIndex,
		childInstanceNonce: HEX("3"),
		workerIndex,
		tokenBundleSha256: HEX("4"),
		orderedSubscriberIdsSha256: HEX("5"),
		subscriberCount: SHARD,
		macClockId: "mach-continuous-1",
		windowCount: WINDOWS,
		deliveredByOriginWindow: deliveredOrigin,
		deliveredBytesByOriginWindow: deliveredBytesOrigin,
		deliveredByEventWindow: [...deliveredOrigin],
		deliveredBytesByEventWindow: [...deliveredBytesOrigin],
		deliveredAfterMeasureStop: 0,
		deliveredBytesAfterMeasureStop: 0,
		// The shard's exact membership: 125 subscribers, each of which saw
		// every one of the 300 measured messages.
		perSubscriberDelivered: Array.from({ length: SHARD }, () => ACCEPTED_TOTAL),
		duplicateCount: 0,
		reorderCount: 0,
		malformedCount: 0,
		disconnectCount: 0,
		firstDeliveryAtMacNs: START_NS.toString(),
		lastDeliveryAtMacNs: (START_NS + 2n).toString(),
		exitCode: 0,
	};
}

function linuxObservation(): LinuxRelayObservationV1 {
	const accepted = zeros(WINDOWS);
	accepted[0] = ACCEPTED_TOTAL;
	const acceptedBytes = zeros(WINDOWS);
	acceptedBytes[0] = ACCEPTED_TOTAL * MESSAGE_BYTES;
	const relayWrites = zeros(WINDOWS);
	relayWrites[0] = ACCEPTED_TOTAL * SUBSCRIBERS;
	const relayBytes = zeros(WINDOWS);
	relayBytes[0] = ACCEPTED_TOTAL * SUBSCRIBERS * MESSAGE_BYTES;
	return {
		schema: "linux-relay-observation/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		roleTokenCommitmentRootSha256: HEX("6"),
		serverChildPid: 900,
		serverChildPgid: 900,
		serverChildInstanceNonce: HEX("7"),
		linuxClockId: "clock-monotonic-1",
		windowCount: WINDOWS,
		registeredPublisherIds: Array.from(
			{ length: PUBLISHERS },
			(_unused, index) => publisherId(index),
		),
		registeredSubscriberIdsSha256: HEX("8"),
		registeredPublisherCount: PUBLISHERS,
		registeredSubscriberCount: SUBSCRIBERS,
		acceptedIngressByOriginWindow: accepted,
		acceptedIngressBytesByOriginWindow: acceptedBytes,
		relayWritesCompletedByOriginWindow: relayWrites,
		relayWriteBytesByOriginWindow: relayBytes,
		duplicateIngressByOriginWindow: zeros(WINDOWS),
		reorderedIngressByOriginWindow: zeros(WINDOWS),
		queueDropDeliveriesByOriginWindow: zeros(WINDOWS),
		writeTimeoutDeliveriesByOriginWindow: zeros(WINDOWS),
		disconnectUndeliveredByOriginWindow: zeros(WINDOWS),
		malformedIngressByOriginWindow: zeros(WINDOWS),
		publisherEndCount: PUBLISHERS,
		subscriberEndCount: SUBSCRIBERS,
		sessionsAccepted: SESSIONS,
		sessionsActivePeak: SESSIONS,
		publisherSessionsActivePeak: PUBLISHERS,
		subscriberSessionsActivePeak: SUBSCRIBERS,
		queueItemsPeak: 16,
		queueBytesPeak: 1_600,
		concurrentWritesPeak: 8,
		measurementStartedAtLinuxNs: "5000000000",
		relayDrainedAtLinuxNs: "5010000000",
		allSessionsClosedAtLinuxNs: "5020000000",
		allSessionsClosed: true,
	};
}

function observedProcessProof(
	publisherPartialShas: readonly string[],
	workerPartialShas: readonly string[],
): ObservedProcessProofV1 {
	const children = [
		...publisherPartialShas.map((sha, index) => ({
			schema: "observed-child-process/v1" as const,
			childId: publisherId(index),
			role: "publisher" as const,
			pid: 4_100 + index,
			pgid: 4_100 + index,
			instanceNonce: HEX("1"),
			bunSha256: HEX("d"),
			entrypointSha256: HEX("e"),
			tokenOrBundleSha256: HEX("2"),
			publisherId: publisherId(index),
			workerIndex: null,
			orderedSubscriberIdsSha256: null,
			subscriberCount: 0,
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
		...workerPartialShas.map((sha, index) => ({
			schema: "observed-child-process/v1" as const,
			childId: `worker-${index}`,
			role: "subscriber-worker" as const,
			pid: 4_200 + index,
			pgid: 4_200 + index,
			instanceNonce: HEX("3"),
			bunSha256: HEX("d"),
			entrypointSha256: HEX("f"),
			tokenOrBundleSha256: HEX("4"),
			publisherId: null,
			workerIndex: index,
			orderedSubscriberIdsSha256: HEX("5"),
			subscriberCount: SHARD,
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
		schema: "observed-process-proof/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		expectedProcessCount: PUBLISHERS + COHORT_WORKER_COUNT,
		observedProcessCount: PUBLISHERS + COHORT_WORKER_COUNT,
		expectedPublisherCount: PUBLISHERS,
		observedPublisherCount: PUBLISHERS,
		expectedWorkerCount: COHORT_WORKER_COUNT,
		observedWorkerCount: COHORT_WORKER_COUNT,
		expectedSubscriberCount: SUBSCRIBERS,
		observedSubscriberCount: SUBSCRIBERS,
		children,
		childrenDigestSha256: observedChildrenDigestSha256(children),
	};
}

function orderedManifest(
	publishers: readonly RetainedCanonicalBytesV1[],
	workers: readonly RetainedCanonicalBytesV1[],
) {
	const entries = [
		...publishers.map((retained, index) => ({
			schema: "ordered-partial-manifest-entry/v1" as const,
			order: index,
			partialKind: "publisher" as const,
			childId: publisherId(index),
			partialSha256: retained.sha256,
			partialSize: retained.byteLength,
		})),
		...workers.map((retained, index) => ({
			schema: "ordered-partial-manifest-entry/v1" as const,
			order: publishers.length + index,
			partialKind: "worker" as const,
			childId: `worker-${index}`,
			partialSha256: retained.sha256,
			partialSize: retained.byteLength,
		})),
	];
	return {
		schema: "ordered-partial-manifest/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		publisherPartialCount: PUBLISHERS,
		workerPartialCount: COHORT_WORKER_COUNT,
		totalPartialBytes: [...publishers, ...workers].reduce(
			(sum, retained) => sum + retained.byteLength,
			0,
		),
		entries,
		orderedDigestSetSha256: orderedPartialDigestSetSha256(entries),
	};
}

const ADMISSION_OPAQUE_FIELDS = [
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

/**
 * A retained member grown until its base64 is one step short of the cap §4.4
 * gives it.  `parseRetainedCanonicalBytes` caps the *encoded* length, so the
 * decoded payload a member can carry is three quarters of its named cap.
 */
function encodedCapPadding(
	encodedCap: number,
	fixedDecodedBytes: number,
): number {
	return Math.max(0, Math.floor(encodedCap / 4) * 3 - 16 - fixedDecodedBytes);
}

function paddedFiller(
	label: string,
	encodedCap: number,
): RetainedCanonicalBytesV1 {
	const fixed = bytesOfCanonical({ label, pad: "" }).byteLength;
	return retain({
		label,
		pad: "0".repeat(encodedCapPadding(encodedCap, fixed)),
	});
}

/**
 * The chat-1k token commitment leaf manifest: one leaf per session, 1 010 of
 * them, plus enough opaque padding to bring the retained member up against its
 * own cap.  The padding is what pushes the bundle toward the §4.4 decoded
 * ceiling; the leaves are what make it the chat-1k shape rather than a blob.
 */
function tokenLeafManifest(paddingLength: number): Record<string, unknown> {
	const leaves = [
		...Array.from({ length: PUBLISHERS }, (_unused, index) => ({
			schema: "token-commitment-leaf/v1" as const,
			role: "publisher" as const,
			roleId: publisherId(index),
			workerIndex: null,
			tokenSha256: HEX("2"),
			leafSha256: HEX("b"),
		})),
		...Array.from({ length: SUBSCRIBERS }, (_unused, index) => ({
			schema: "token-commitment-leaf/v1" as const,
			role: "subscriber" as const,
			roleId: `subscriber-${String(index).padStart(6, "0")}`,
			workerIndex: Math.floor(index / SHARD),
			tokenSha256: HEX("c"),
			leafSha256: HEX("b"),
		})),
	];
	return {
		schema: "token-commitment-leaf-manifest/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		leafCount: leaves.length,
		leaves,
		retainedOpaquePadding: "0".repeat(paddingLength),
	};
}

/** The 1 010 leaf manifest, grown to its own §4.4 cap. */
function retainedTokenLeafManifest(): RetainedCanonicalBytesV1 {
	const fixed = bytesOfCanonical(tokenLeafManifest(0)).byteLength;
	return retain(
		tokenLeafManifest(
			encodedCapPadding(TOKEN_COMMITMENT_LEAF_MANIFEST_MAX_BYTES, fixed),
		),
	);
}

/** An honest chat-1k export; every digest is recomputed from the bytes. */
function honestEvidence(): Record<string, unknown> {
	const publishers = Array.from({ length: PUBLISHERS }, (_unused, index) =>
		publisherPartial(index),
	);
	const workers = Array.from(
		{ length: COHORT_WORKER_COUNT },
		(_unused, index) => workerPartial(index),
	);
	const linux = linuxObservation();

	const conservation = recomputeCohortOriginConservation({
		publisherPartials: publishers,
		workerPartials: workers,
		linuxRelayObservation: linux,
		subscriberCount: SUBSCRIBERS,
		messageBytes: MESSAGE_BYTES,
	});
	if (!conservation.ok)
		throw new Error(`conservation: ${conservation.message}`);
	const seriesResult = recomputeCohortRateSeries({
		workerPartials: workers,
		conservation: conservation.value,
		windowCount: WINDOWS,
		measuredDurationMs: 10_000,
		firstDeliveryAtMacNs: START_NS.toString(),
		lastMeasuredWindowDeliveryAtMacNs: (START_NS + 2n).toString(),
		lastDeliveryIncludingDrainAtMacNs: (START_NS + 2n).toString(),
	});
	if (!seriesResult.ok) throw new Error(`series: ${seriesResult.message}`);
	const ledgerResult = recomputeCohortLedger({
		conservation: conservation.value,
		subscriberCount: SUBSCRIBERS,
		messageBytes: MESSAGE_BYTES,
	});
	if (!ledgerResult.ok) throw new Error(`ledger: ${ledgerResult.message}`);

	const publisherRetained = publishers.map((publisher) => retain(publisher));
	const workerRetained = workers.map((worker) => retain(worker));
	const proof = observedProcessProof(
		publisherRetained.map((entry) => entry.sha256),
		workerRetained.map((entry) => entry.sha256),
	);
	const capacity: CohortCapacityV1 = {
		schema: "cohort-capacity/v1",
		expectedSessions: SESSIONS,
		sessionsAccepted: SESSIONS,
		sessionsActivePeak: SESSIONS,
		expectedPublishers: PUBLISHERS,
		registeredPublishers: PUBLISHERS,
		expectedSubscribers: SUBSCRIBERS,
		registeredSubscribers: SUBSCRIBERS,
	};
	const ledger: CohortLedgerV1 = ledgerResult.value;
	const series: CohortRateSeriesV1 = seriesResult.value;

	const linuxRetained = retain(linux);
	const manifestRetained = retain(
		orderedManifest(publisherRetained, workerRetained),
	);
	const proofRetained = retain(proof);
	const seriesRetained = retain(series);
	const ledgerRetained = retain(ledger);
	const capacityRetained = retain(capacity);
	const rigReceiptRetained = retain({
		schema: "rig-relay-observation-receipt/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		linuxRelayObservationSha256: linuxRetained.sha256,
		rigExecutionAcceptanceSha256: HEX("9"),
		rigSupervisorInstanceNonce: HEX("8"),
		signingPublicKeySha256: HEX("7"),
		receiptSequence: 1,
		receivedAtRigNs: "5030000000",
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	});

	const admission: Record<string, unknown> = {
		schema: "cohort-admission-receipt/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		orderedPartialManifestSha256: manifestRetained.sha256,
		observedProcessProofSha256: proofRetained.sha256,
		linuxRelayObservationSha256: linuxRetained.sha256,
		rigRelayObservationReceiptSha256: rigReceiptRetained.sha256,
		rateSeriesSha256: seriesRetained.sha256,
		ledgerSha256: ledgerRetained.sha256,
		capacitySha256: capacityRetained.sha256,
		publisherCount: PUBLISHERS,
		workerCount: COHORT_WORKER_COUNT,
		subscriberCount: SUBSCRIBERS,
		offeredIngress: ledger.offeredIngress,
		serverAcceptedIngress: ledger.serverAcceptedIngress,
		linuxRelayWritesCompleted: ledger.linuxRelayWritesCompleted,
		delivered: ledger.delivered,
		macSupervisorInstanceNonce: HEX("6"),
		signingPublicKeySha256: HEX("5"),
		receiptSequence: 7,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	for (const field of ADMISSION_OPAQUE_FIELDS) admission[field] = HEX("9");

	// Every member that §4.4 leaves opaque is grown to its own cap: that is what
	// makes this the largest bundle the frozen schemas admit, rather than the
	// smallest one that happens to parse.
	const sig = (label: string) =>
		paddedFiller(label, COHORT_SIGNATURE_RECORD_MAX_BYTES);
	const rig = (label: string) =>
		paddedFiller(label, RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES);
	const derived = (label: string) =>
		paddedFiller(label, COHORT_DERIVED_RECORD_MAX_BYTES);
	return {
		schema: "cohort-observation-evidence/v1",
		workloadRolePlanInput: paddedFiller(
			"workload",
			WORKLOAD_ROLE_PLAN_INPUT_MAX_BYTES,
		),
		cohortGrant: GRANT_RETAINED,
		cohortGrantSignature: sig("grant-sig"),
		rigCohortAcceptance: rig("rig-acceptance"),
		rigCohortAcceptanceSignature: sig("rig-acceptance-sig"),
		tokenCommitmentLeafManifest: retainedTokenLeafManifest(),
		cohortWarmupEpoch: paddedFiller("epoch", COHORT_WARMUP_EPOCH_MAX_BYTES),
		cohortWarmupEpochSignature: sig("epoch-sig"),
		roleWarmupCompletionManifest: paddedFiller(
			"warmup-manifest",
			ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES,
		),
		roleWarmupCompletionManifestSignature: sig("warmup-manifest-sig"),
		roleWarmupCompletes: Array.from(
			{ length: PUBLISHERS + COHORT_WORKER_COUNT },
			(_unused, index) =>
				paddedFiller(`warmup-complete-${index}`, ROLE_CHILD_FRAME_MAX_BYTES),
		),
		serverWarmupDrained: derived("server-drained"),
		rigWarmupDrainedReceipt: rig("rig-drained"),
		rigWarmupDrainedReceiptSignature: sig("rig-drained-sig"),
		rigMeasureStartAck: rig("measure-ack"),
		rigMeasureStartAckSignature: sig("measure-ack-sig"),
		cohortStartBarrier: BARRIER_RETAINED,
		cohortStartBarrierSignature: sig("barrier-sig"),
		rigBarrierAcceptance: rig("barrier-acceptance"),
		rigBarrierAcceptanceSignature: sig("barrier-acceptance-sig"),
		serverStartBarrierAccepted: derived("server-barrier"),
		publisherPartials: publisherRetained,
		workerPartials: workerRetained,
		orderedPartialManifest: manifestRetained,
		observedProcessProof: proofRetained,
		linuxRelayObservation: linuxRetained,
		rigRelayObservationReceipt: rigReceiptRetained,
		rigRelayObservationReceiptSignature: sig("rig-receipt-sig"),
		rateSeries: seriesRetained,
		ledger: ledgerRetained,
		capacity: capacityRetained,
		cohortAdmissionReceipt: retain(admission),
		cohortAdmissionSignature: paddedFiller(
			"admission-sig",
			COHORT_ADMISSION_SIGNATURE_MAX_BYTES,
		),
	};
}

const EXPORT_REQUEST_SEQ = 11;

function exportAck(
	evidence: Record<string, unknown>,
): MacCohortEvidenceExportedAckV1 {
	const bytes = bytesOfCanonical(evidence);
	const ack = {
		schema: "mac-cohort-evidence-exported-ack/v1",
		responseSeq: EXPORT_REQUEST_SEQ,
		ackRequestSeq: EXPORT_REQUEST_SEQ,
		executionSha256: EXECUTION_SHA,
		cohortObservationEvidenceSignatureBase64: "" as never,
		cohortObservationEvidenceSha256: sha256HexOfBytes(bytes),
		cohortObservationEvidenceSize: bytes.byteLength,
		terminalExport: true,
	} as MacCohortEvidenceExportedAckV1;
	const signed = {
		...ack,
		cohortObservationEvidenceSignatureBase64: toBase64(
			ed25519Sign(exportKeys.privatePkcs8Der, cohortExportAckSigningBytes(ack)),
		),
	};
	exportObservations.set(signed, evidence);
	return signed;
}

function cohortEvidence(
	evidence: Record<string, unknown>,
): ArmCohortEvidenceV1 {
	const result = cohortEvidenceFromExportAck({
		ack: exportAck(evidence),
		observation: evidence,
		stagedMacPublicRaw32: exportKeys.publicRaw32,
		expectedExecutionSha256: EXECUTION_SHA,
		expectedCohortGrantSha256: GRANT_SHA,
		expectedPublisherCount: PUBLISHERS,
		expectedSubscriberCount: SUBSCRIBERS,
		expectedRequestSequence: EXPORT_REQUEST_SEQ,
		alreadyExported: false,
	});
	if (!result.ok) throw new Error(`fixture is not honest: ${result.message}`);
	return result.value;
}

// --- artifact input --------------------------------------------------------

const SAMPLES = Array.from({ length: 64 }, (_unused, index) => 1 + (index % 4));

function artifactInput(overrides: Record<string, unknown> = {}) {
	return {
		comparisonId: "chat-1k-budget",
		runId: "chat-1k-budget-run",
		cellId: LARGEST_CELL_ID,
		transport: "ws",
		armKind: "primary",
		evidenceStatus: "PASS",
		scenarioVerdict: "PASS",
		seed: 42,
		executionPurpose: "canonical",
		repetitionKind: "measured",
		measuredRepetitionIndex: 3,
		measuredRepetitionTotal: 5,
		samples: SAMPLES,
		percentiles: { p1: 1, p50: 2, p95: 4, p99: 4 },
		ledger: {
			attempted: SAMPLES.length,
			queued: SAMPLES.length,
			serverObserved: SAMPLES.length,
			acknowledged: SAMPLES.length,
			delivered: SAMPLES.length,
			dropped: 0,
			expired: 0,
			histogram: { unit: "ms", boundaries: [1, 2, 4], counts: [64, 0, 0] },
		},
		telemetry: {
			mac: { cpuPercent: 15, rssBytes: 14_336 },
			linux: { cpuPercent: 18, rssBytes: 18_432 },
		},
		loopUtilization: {
			perSession: { busyMs: 10, windowMs: 1_000 },
			serverAggregate: { busyMs: 40, windowMs: 1_000 },
		},
		...overrides,
	};
}

function buildLargestCell(evidence: ArmCohortEvidenceV1) {
	return buildRunArtifact(
		withFixtureAttestation(
			artifactInput({ cohortEvidence: evidence }) as never,
		),
	) as unknown as Record<string, unknown>;
}

/** Rejection codes the *size* budgets produce; nothing else is a size refusal. */
const SIZE_REJECTIONS = new Set([
	"ARTIFACT_BYTES_TOO_LARGE",
	"ARTIFACT_BYTES_INVALID",
]);

/**
 * The cumulative string-byte total `snapshotValue` charges against
 * `MAX_ARTIFACT_STRING_BYTES`: every string *value*, keys excluded.
 */
function stringBytesOf(value: unknown): number {
	if (typeof value === "string")
		return new TextEncoder().encode(value).byteLength;
	if (Array.isArray(value)) {
		return value.reduce<number>((sum, entry) => sum + stringBytesOf(entry), 0);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).reduce<number>(
			(sum, entry) => sum + stringBytesOf(entry),
			0,
		);
	}
	return 0;
}

/** A retained-shaped frame carrying exactly `base64Length` bytes of payload. */
function frameOfLength(base64Length: number): Record<string, unknown> {
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: "A".repeat(base64Length),
		byteLength: Math.max(1, Math.floor((base64Length * 3) / 4)),
		sha256: HEX("0"),
	};
}

/** Everything in a frame that is a string other than its payload. */
const FRAME_FIXED_STRING_BYTES = stringBytesOf(frameOfLength(0));

/**
 * Grow an artifact's cohort subtree by appending retained frames to
 * `roleWarmupCompletes` until the whole artifact charges exactly
 * `targetStringBytes` against the cumulative string budget.
 *
 * `roleWarmupCompletes[n].bytesBase64` is on the cohort retained-bytes path, so
 * each frame may carry up to `MAX_COHORT_RETAINED_BASE64_LENGTH`; the last one
 * is trimmed to land on the target rather than past it.
 */
function artifactWithStringBytes(
	artifact: Record<string, unknown>,
	targetStringBytes: number,
): Record<string, unknown> {
	const attestation = artifact.attestationEvidence as Record<string, unknown>;
	const observation = attestation.cohortObservationEvidence as Record<
		string,
		unknown
	>;
	const frames = [...(observation.roleWarmupCompletes as unknown[])];
	let total = stringBytesOf(artifact);
	while (total < targetStringBytes) {
		const remaining = targetStringBytes - total - FRAME_FIXED_STRING_BYTES;
		if (remaining <= 0) break;
		const payload = Math.min(remaining, MAX_COHORT_RETAINED_BASE64_LENGTH);
		frames.push(frameOfLength(payload));
		total += FRAME_FIXED_STRING_BYTES + payload;
	}
	return {
		...artifact,
		attestationEvidence: {
			...attestation,
			cohortObservationEvidence: {
				...observation,
				roleWarmupCompletes: frames,
			},
		},
	};
}

const LARGEST_EVIDENCE = honestEvidence();
const LARGEST_BUNDLE_BYTES = bytesOfCanonical(LARGEST_EVIDENCE).byteLength;
const LARGEST_ARM = cohortEvidence(LARGEST_EVIDENCE);
/** The pre-R5 constants, restated here only so the test can name what changed. */
const PRE_R5_ARTIFACT_BYTES = 8 * 1024 * 1024;
const PRE_R5_STRING_BYTES = 4 * 1024 * 1024;

describe("R5 the largest cohort bundle fits the artifact budget", () => {
	test("the_largest_valid_chat_1k_bundle_seals_into_an_artifact_and_reads_back_byte_exact", () => {
		// It really is the chat-1k shape from the D3 cardinality table.
		expect(LARGEST_ARM.observation.publisherPartials.length).toBe(10);
		expect(LARGEST_ARM.observation.workerPartials.length).toBe(8);
		expect(LARGEST_ARM.processProof.observedSubscriberCount).toBe(1_000);
		expect(LARGEST_BUNDLE_BYTES).toBeLessThanOrEqual(
			COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
		);
		// ~5.15 MiB. A *valid* bundle cannot reach the 9 MiB §4.4 ceiling: the
		// partials, the process proof and the manifest are fully determined by
		// their schemas and land far under their own caps, so only the opaque
		// members can be grown. The next test carries a subtree at the real cap.
		expect(LARGEST_BUNDLE_BYTES).toBeGreaterThan(5 * 1024 * 1024);

		const artifact = buildLargestCell(LARGEST_ARM);
		// The bundle's own base64 already blows the pre-R5 4 MiB *cumulative*
		// string budget: this artifact could not be sealed before R5.
		expect(stringBytesOf(artifact)).toBeGreaterThan(PRE_R5_STRING_BYTES);

		const sealed = sealRunArtifact(artifact);
		expect(sealed.byteLength).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);

		// It reads back: no size refusal, and the bundle survives byte-exactly.
		const verified = verifyRunArtifact(sealed);
		for (const rejection of verified.rejections) {
			expect(SIZE_REJECTIONS.has(rejection.code)).toBe(false);
		}
		const readBack = JSON.parse(new TextDecoder().decode(sealed)) as Record<
			string,
			unknown
		>;
		const carried = (readBack.attestationEvidence as Record<string, unknown>)
			.cohortObservationEvidence;
		expect(sha256HexOfBytes(bytesOfCanonical(carried))).toBe(
			LARGEST_ARM.exportAck.cohortObservationEvidenceSha256,
		);
	});

	test("an_artifact_carrying_a_cohort_subtree_at_the_section_4_4_decoded_cap_seals", () => {
		// §4.4 lets the bundle reach 9 MiB. Sealing an artifact that carries one
		// is the whole point of the raise, and the pre-R5 8 MiB envelope could
		// not have held it.
		const artifact = buildLargestCell(LARGEST_ARM);
		const atCap = artifactWithStringBytes(
			artifact,
			COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
		);
		expect(stringBytesOf(atCap)).toBe(
			COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
		);
		const sealed = sealRunArtifact(atCap);
		expect(sealed.byteLength).toBeGreaterThan(PRE_R5_ARTIFACT_BYTES);
		expect(sealed.byteLength).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
	});

	test("the_raised_string_envelope_admits_exactly_max_artifact_string_bytes_and_refuses_one_more", () => {
		const artifact = buildLargestCell(LARGEST_ARM);
		const atBudget = artifactWithStringBytes(
			artifact,
			MAX_ARTIFACT_STRING_BYTES,
		);
		expect(stringBytesOf(atBudget)).toBe(MAX_ARTIFACT_STRING_BYTES);
		expect(() => sealRunArtifact(atBudget)).not.toThrow();

		const overBudget = artifactWithStringBytes(
			artifact,
			MAX_ARTIFACT_STRING_BYTES + 1,
		);
		expect(stringBytesOf(overBudget)).toBe(MAX_ARTIFACT_STRING_BYTES + 1);
		expect(() => sealRunArtifact(overBudget)).toThrow(/string byte budget/);
	});

	test("the_raised_envelope_admits_exactly_max_artifact_bytes_and_refuses_one_more", () => {
		// The reader's own ceiling, exercised at the boundary in both directions.
		const atCap = verifyRunArtifact(
			new Uint8Array(MAX_ARTIFACT_BYTES).fill(0x20),
		);
		expect(atCap.rejections.map(({ code }) => code)).not.toContain(
			"ARTIFACT_BYTES_TOO_LARGE",
		);
		const overCap = verifyRunArtifact(
			new Uint8Array(MAX_ARTIFACT_BYTES + 1).fill(0x20),
		);
		expect(overCap.evidenceStatus).toBe("FAIL");
		expect(overCap.rejections.map(({ code }) => code)).toEqual([
			"ARTIFACT_BYTES_TOO_LARGE",
		]);
	});

	test("both_artifact_budgets_span_the_section_4_4_cohort_caps", () => {
		expect(MAX_ARTIFACT_BYTES).toBeGreaterThanOrEqual(
			COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
		);
		expect(MAX_ARTIFACT_STRING_BYTES).toBeGreaterThanOrEqual(
			COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
		);
		expect(MAX_ARTIFACT_BYTES).toBeLessThanOrEqual(
			COHORT_REMOTE_EVIDENCE_BUDGET_BYTES,
		);
		expect(MAX_ARTIFACT_STRING_BYTES).toBeLessThanOrEqual(
			COHORT_REMOTE_EVIDENCE_BUDGET_BYTES,
		);
	});
});
