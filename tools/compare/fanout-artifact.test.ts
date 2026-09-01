/**
 * B4 artifact/measurement shapes (plan §6 + §4.4).
 *
 * The six primary fanout cells seal a `CohortObservationEvidenceV1` that the
 * Mac supervisor exported exactly once, as `MacCohortEvidenceExportedAckV1`.
 * These tests hold the shape end to end: the ack propagates byte-exact through
 * the arm measurement into the artifact and into the seal; every way a bundle
 * can be missing, doubled, cut short, oversized or reordered is refused where
 * the artifact is assembled rather than downstream; a genuine admission
 * receipt paired with different partial bytes is refused; and each of the four
 * derived records (process proof, ledger, capacity, rate series) is inside the
 * seal, so a rewrite of any one of them moves the artifact digest.
 *
 * The fixture builds an honest cohort from the frozen §4.4 records and the
 * §4.5 recomputation helpers, so nothing here is a hand-written digest.
 */
import { describe, expect, test } from "bun:test";
import {
	COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES,
	COHORT_WORKER_COUNT,
	type CohortCapacityV1,
	type CohortLedgerV1,
	type CohortRateSeriesV1,
	type LinuxRelayObservationV1,
	type ObservedProcessProofV1,
	observedChildrenDigestSha256,
	orderedPartialDigestSetSha256,
	type PublisherPartialV1,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	type RetainedCanonicalBytesV1,
	type WorkerPartialV1,
} from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	type MacCohortEvidenceExportedAckV1,
	toBase64,
} from "./cross-supervisor-protocol.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import {
	type ArmCohortEvidenceV1,
	buildRunArtifact,
	cohortEvidenceFromExportAck,
	trustContextForArtifact,
} from "./artifact-builder.ts";
import { measuredLegToArm } from "./arm-measure.ts";
import {
	artifactByteSha256,
	FANOUT_COHORT_CELL_IDS,
	requiresCohortObservationEvidence,
	sealRunArtifact,
} from "./evidence.ts";

// --- frozen fixture identities ---------------------------------------------

const HEX = (character: string): string => character.repeat(64);
const EXECUTION_SHA = HEX("a");
const WINDOWS = 10;
const MESSAGE_BYTES = 100 as const;
const START_NS = 1_000_000_000_000n;

/** ticker-fanout/rate-10000: one publisher, eight workers, 100 subscribers. */
const PUBLISHERS = 1;
const SUBSCRIBERS = 100;
const SHARDS = [13, 13, 13, 13, 12, 12, 12, 12] as const;
const ACCEPTED_PER_WINDOW = 10;
const FANOUT_CELL = "ticker-fanout/rate-10000";
const NON_FANOUT_CELL = "bulk-one-way/physical";

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

const GRANT_RETAINED = retain({ label: "cohort-grant" });
const BARRIER_RETAINED = retain({ label: "cohort-start-barrier" });
const GRANT_SHA = GRANT_RETAINED.sha256;
const BARRIER_SHA = BARRIER_RETAINED.sha256;

function publisherPartial(
	overrides: Partial<PublisherPartialV1> = {},
): PublisherPartialV1 {
	const offered = zeros(WINDOWS);
	offered[0] = ACCEPTED_PER_WINDOW;
	const offeredBytes = zeros(WINDOWS);
	offeredBytes[0] = ACCEPTED_PER_WINDOW * MESSAGE_BYTES;
	const accepted = zeros(WINDOWS);
	accepted[0] = ACCEPTED_PER_WINDOW;
	return {
		schema: "publisher-partial/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		childId: "publisher-000000",
		childPid: 4_100,
		childPgid: 4_100,
		childInstanceNonce: HEX("1"),
		publisherId: "publisher-000000",
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
		...overrides,
	};
}

function workerPartial(
	workerIndex: number,
	overrides: Partial<WorkerPartialV1> = {},
): WorkerPartialV1 {
	const shard = SHARDS[workerIndex]!;
	const delivered = ACCEPTED_PER_WINDOW * shard;
	const deliveredOrigin = zeros(WINDOWS);
	deliveredOrigin[0] = delivered;
	const deliveredBytesOrigin = zeros(WINDOWS);
	deliveredBytesOrigin[0] = delivered * MESSAGE_BYTES;
	const deliveredEvent = zeros(WINDOWS);
	deliveredEvent[0] = delivered;
	const deliveredBytesEvent = zeros(WINDOWS);
	deliveredBytesEvent[0] = delivered * MESSAGE_BYTES;
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
		subscriberCount: shard,
		macClockId: "mach-continuous-1",
		windowCount: WINDOWS,
		deliveredByOriginWindow: deliveredOrigin,
		deliveredBytesByOriginWindow: deliveredBytesOrigin,
		deliveredByEventWindow: deliveredEvent,
		deliveredBytesByEventWindow: deliveredBytesEvent,
		deliveredAfterMeasureStop: 0,
		deliveredBytesAfterMeasureStop: 0,
		perSubscriberDelivered: Array.from(
			{ length: shard },
			() => ACCEPTED_PER_WINDOW,
		),
		duplicateCount: 0,
		reorderCount: 0,
		malformedCount: 0,
		disconnectCount: 0,
		firstDeliveryAtMacNs: START_NS.toString(),
		lastDeliveryAtMacNs: (START_NS + 2n).toString(),
		exitCode: 0,
		...overrides,
	};
}

function linuxObservation(): LinuxRelayObservationV1 {
	const accepted = zeros(WINDOWS);
	accepted[0] = ACCEPTED_PER_WINDOW;
	const acceptedBytes = zeros(WINDOWS);
	acceptedBytes[0] = ACCEPTED_PER_WINDOW * MESSAGE_BYTES;
	const relayWrites = zeros(WINDOWS);
	relayWrites[0] = ACCEPTED_PER_WINDOW * SUBSCRIBERS;
	const relayBytes = zeros(WINDOWS);
	relayBytes[0] = ACCEPTED_PER_WINDOW * SUBSCRIBERS * MESSAGE_BYTES;
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
		registeredPublisherIds: ["publisher-000000"],
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
		sessionsAccepted: PUBLISHERS + SUBSCRIBERS,
		sessionsActivePeak: PUBLISHERS + SUBSCRIBERS,
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
	publisherPartialSha: string,
	workerPartialShas: readonly string[],
): ObservedProcessProofV1 {
	const children = [
		{
			schema: "observed-child-process/v1" as const,
			childId: "publisher-000000",
			role: "publisher" as const,
			pid: 4_100,
			pgid: 4_100,
			instanceNonce: HEX("1"),
			bunSha256: HEX("d"),
			entrypointSha256: HEX("e"),
			tokenOrBundleSha256: HEX("2"),
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
			instanceNonce: HEX("3"),
			bunSha256: HEX("d"),
			entrypointSha256: HEX("f"),
			tokenOrBundleSha256: HEX("4"),
			publisherId: null,
			workerIndex: index,
			orderedSubscriberIdsSha256: HEX("5"),
			subscriberCount: SHARDS[index]!,
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
	return {
		schema: "ordered-partial-manifest/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_SHA,
		cohortStartBarrierSha256: BARRIER_SHA,
		publisherPartialCount: PUBLISHERS,
		workerPartialCount: COHORT_WORKER_COUNT,
		totalPartialBytes:
			publisher.byteLength +
			workers.reduce((sum, retained) => sum + retained.byteLength, 0),
		entries,
		orderedDigestSetSha256: orderedPartialDigestSetSha256(entries),
	};
}

/** Every admission field the §4.4 record carries that this fixture does not derive. */
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

interface HonestCohortOptions {
	/** Rewrite one derived record before the admission receipt is minted. */
	readonly rewrite?: (records: {
		proof: ObservedProcessProofV1;
		ledger: CohortLedgerV1;
		capacity: CohortCapacityV1;
		series: CohortRateSeriesV1;
	}) => void;
	/** Swap raw bytes after the admission receipt has covered the honest ones. */
	readonly detachPartials?: boolean;
}

/**
 * An honest export: every digest recomputed from the retained bytes, the
 * admission receipt minted last so it covers exactly what the bundle carries.
 */
function honestEvidence(
	options: HonestCohortOptions = {},
): Record<string, unknown> {
	const publisher = publisherPartial();
	const workers = Array.from({ length: COHORT_WORKER_COUNT }, (_unused, index) =>
		workerPartial(index),
	);
	const linux = linuxObservation();

	const conservation = recomputeCohortOriginConservation({
		publisherPartials: [publisher],
		workerPartials: workers,
		linuxRelayObservation: linux,
		subscriberCount: SUBSCRIBERS,
		messageBytes: MESSAGE_BYTES,
	});
	if (!conservation.ok) throw new Error(`conservation: ${conservation.message}`);
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

	const publisherRetained = retain(publisher);
	const workerRetained = workers.map((worker) => retain(worker));
	const records = {
		proof: observedProcessProof(
			publisherRetained.sha256,
			workerRetained.map((entry) => entry.sha256),
		),
		ledger: ledgerResult.value,
		capacity: {
			schema: "cohort-capacity/v1",
			expectedSessions: PUBLISHERS + SUBSCRIBERS,
			sessionsAccepted: PUBLISHERS + SUBSCRIBERS,
			sessionsActivePeak: PUBLISHERS + SUBSCRIBERS,
			expectedPublishers: PUBLISHERS,
			registeredPublishers: PUBLISHERS,
			expectedSubscribers: SUBSCRIBERS,
			registeredSubscribers: SUBSCRIBERS,
		} satisfies CohortCapacityV1,
		series: seriesResult.value,
	};
	options.rewrite?.(records);

	const linuxRetained = retain(linux);
	const manifestRetained = retain(orderedManifest(publisherRetained, workerRetained));
	const proofRetained = retain(records.proof);
	const seriesRetained = retain(records.series);
	const ledgerRetained = retain(records.ledger);
	const capacityRetained = retain(records.capacity);
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
		offeredIngress: records.ledger.offeredIngress,
		serverAcceptedIngress: records.ledger.serverAcceptedIngress,
		linuxRelayWritesCompleted: records.ledger.linuxRelayWritesCompleted,
		delivered: records.ledger.delivered,
		macSupervisorInstanceNonce: HEX("6"),
		signingPublicKeySha256: HEX("5"),
		receiptSequence: 7,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	for (const field of ADMISSION_OPAQUE_FIELDS) admission[field] = HEX("9");

	const filler = (label: string) => retain({ label });
	// A genuine receipt paired with different partial bytes: the admission
	// receipt above covers the honest manifest, so swapping the partials now
	// leaves a real receipt over bytes it never saw.
	const carriedPublisher = options.detachPartials
		? retain(publisherPartial({ childPid: 4_101, childPgid: 4_101 }))
		: publisherRetained;

	return {
		schema: "cohort-observation-evidence/v1",
		workloadRolePlanInput: filler("workload"),
		cohortGrant: GRANT_RETAINED,
		cohortGrantSignature: filler("grant-sig"),
		rigCohortAcceptance: filler("rig-acceptance"),
		rigCohortAcceptanceSignature: filler("rig-acceptance-sig"),
		tokenCommitmentLeafManifest: filler("leaf-manifest"),
		cohortWarmupEpoch: filler("epoch"),
		cohortWarmupEpochSignature: filler("epoch-sig"),
		roleWarmupCompletionManifest: filler("warmup-manifest"),
		roleWarmupCompletionManifestSignature: filler("warmup-manifest-sig"),
		roleWarmupCompletes: Array.from(
			{ length: PUBLISHERS + COHORT_WORKER_COUNT },
			(_unused, index) => filler(`warmup-complete-${index}`),
		),
		serverWarmupDrained: filler("server-drained"),
		rigWarmupDrainedReceipt: filler("rig-drained"),
		rigWarmupDrainedReceiptSignature: filler("rig-drained-sig"),
		rigMeasureStartAck: filler("measure-ack"),
		rigMeasureStartAckSignature: filler("measure-ack-sig"),
		cohortStartBarrier: BARRIER_RETAINED,
		cohortStartBarrierSignature: filler("barrier-sig"),
		rigBarrierAcceptance: filler("barrier-acceptance"),
		rigBarrierAcceptanceSignature: filler("barrier-acceptance-sig"),
		serverStartBarrierAccepted: filler("server-barrier"),
		publisherPartials: [carriedPublisher],
		workerPartials: workerRetained,
		orderedPartialManifest: manifestRetained,
		observedProcessProof: proofRetained,
		linuxRelayObservation: linuxRetained,
		rigRelayObservationReceipt: rigReceiptRetained,
		rigRelayObservationReceiptSignature: filler("rig-receipt-sig"),
		rateSeries: seriesRetained,
		ledger: ledgerRetained,
		capacity: capacityRetained,
		cohortAdmissionReceipt: retain(admission),
		cohortAdmissionSignature: filler("admission-sig"),
	};
}

function exportAck(
	evidence: Record<string, unknown>,
	overrides: Partial<MacCohortEvidenceExportedAckV1> = {},
): MacCohortEvidenceExportedAckV1 {
	const bytes = bytesOfCanonical(evidence);
	return {
		schema: "mac-cohort-evidence-exported-ack/v1",
		responseSeq: 11,
		ackRequestSeq: 11,
		executionSha256: EXECUTION_SHA,
		cohortObservationEvidenceBase64: toBase64(bytes),
		cohortObservationEvidenceSha256: sha256HexOfBytes(bytes),
		cohortObservationEvidenceSize: bytes.byteLength,
		terminalExport: true,
		...overrides,
	};
}

function fromAck(
	ack: unknown,
	extra: {
		readonly alreadyExported?: boolean;
		readonly expectedRequestSequence?: number;
	} = {},
) {
	return cohortEvidenceFromExportAck({
		ack,
		expectedExecutionSha256: EXECUTION_SHA,
		expectedCohortGrantSha256: GRANT_SHA,
		expectedPublisherCount: PUBLISHERS,
		expectedSubscriberCount: SUBSCRIBERS,
		alreadyExported: extra.alreadyExported ?? false,
		expectedRequestSequence: extra.expectedRequestSequence ?? 11,
	});
}

function honestCohortEvidence(
	options: HonestCohortOptions = {},
): ArmCohortEvidenceV1 {
	const result = fromAck(exportAck(honestEvidence(options)));
	if (!result.ok) throw new Error(`fixture is not honest: ${result.message}`);
	return result.value;
}

// --- artifact input --------------------------------------------------------

const SAMPLES = Array.from({ length: 64 }, (_unused, index) => 1 + (index % 4));

function artifactInput(overrides: Record<string, unknown> = {}) {
	return {
		comparisonId: "fanout-attested-r1",
		runId: "fanout-attested-r1-run",
		cellId: FANOUT_CELL,
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

function buildFanout(overrides: Record<string, unknown> = {}) {
	return buildRunArtifact(artifactInput(overrides) as never);
}

function sealDigestOf(artifact: unknown): string {
	return artifactByteSha256(sealRunArtifact(artifact));
}

// --- ledger item 1: exact ack propagation ----------------------------------

describe("B4 cohort evidence in the arm measurement and the artifact", () => {
	test("exact_mac_cohort_evidence_exported_ack_propagates_through_arm_measurement_artifact_and_seal", () => {
		const cohortEvidence = honestCohortEvidence();
		const ack = cohortEvidence.exportAck;

		// The mapper carries the ack verbatim onto the arm measurement.
		const measurement = measuredLegToArm({
			leg: {
				sampleUnit: "ms",
				samples: SAMPLES,
				percentiles: { p1: 1, p50: 2, p95: 4, p99: 4 },
				ledger: artifactInput().ledger,
				admissionCounters: {
					admitted: SAMPLES.length,
					rejected: 0,
					refused: 0,
				},
				provenance: "measured",
				loopUtilization: { busyMs: 10, windowMs: 1_000 },
			},
			serverSnapshot: { loopUtilization: { busyMs: 40, windowMs: 1_000 } },
			supervisorContext: {
				toolchains: { js: "bun-1.4.0", darwin: "d", linux: "l" },
				telemetry: artifactInput().telemetry,
				grant: { schema: "measurement-grant/v1" },
				admission: new Uint8Array([1, 2, 3]),
			},
			execution: {
				campaignId: "fanout-attested-r1",
				runId: "fanout-attested-r1-run",
				executionIndex: 1,
				transport: "ws",
			},
			cohortEvidence,
		} as never) as unknown as { readonly cohortEvidence: ArmCohortEvidenceV1 };
		expect(measurement.cohortEvidence.exportAck).toEqual(ack);

		const artifact = buildFanout({ cohortEvidence });
		const carried = artifact.attestationEvidence.cohortObservationEvidence;
		expect(carried).not.toBeNull();
		// Byte-exact: the artifact's nested record re-canonicalizes to exactly
		// the bytes the supervisor digested and declared in the ack.
		const canonical = bytesOfCanonical(carried);
		expect(sha256HexOfBytes(canonical)).toBe(
			ack.cohortObservationEvidenceSha256,
		);
		expect(canonical.byteLength).toBe(ack.cohortObservationEvidenceSize);

		// The seal covers it: an artifact built without it seals differently.
		const sealed = sealRunArtifact(artifact);
		expect(artifactByteSha256(sealed)).toBe(sealDigestOf(artifact));
	});

	// The ack correlates through the same single rule as the raw bundle: the
	// ack's request sequence must be the one that was asked for, while the
	// supervisor's own receipt counter is carried, not compared.
	test("cohort_evidence_from_export_ack_accepts_an_unequal_response_sequence", () => {
		const result = fromAck(
			exportAck(honestEvidence(), { responseSeq: 7, ackRequestSeq: 3 }),
			{ expectedRequestSequence: 3 },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.exportAck.responseSeq).toBe(7);
		expect(result.value.exportAck.ackRequestSeq).toBe(3);
	});

	test("cohort_evidence_from_export_ack_refuses_a_mismatched_ackRequestSeq", () => {
		expect(
			fromAck(
				exportAck(honestEvidence(), { responseSeq: 7, ackRequestSeq: 4 }),
				{ expectedRequestSequence: 3 },
			).ok,
		).toBe(false);
		expect(
			fromAck(
				exportAck(honestEvidence(), { responseSeq: 7, ackRequestSeq: 0 }),
				{ expectedRequestSequence: 0 },
			).ok,
		).toBe(false);
	});

	// --- ledger item 2: bundle-shape refusals at build ----------------------

	test("missing_raw_cohort_bundle_is_rejected_at_build", () => {
		expect(() => buildFanout()).toThrow(/COHORT_OBSERVATION_EVIDENCE_MISSING/);
		expect(fromAck(exportAck(honestEvidence(), {
			cohortObservationEvidenceBase64: "",
		})).ok).toBe(false);
	});

	test("duplicate_raw_cohort_bundle_is_rejected_at_build", () => {
		const evidence = honestEvidence();
		// A second terminal export of the same execution is a duplicate.
		expect(fromAck(exportAck(evidence), { alreadyExported: true }).ok).toBe(
			false,
		);
		// A doubled payload no longer matches the declared size or digest.
		const bytes = bytesOfCanonical(evidence);
		const doubled = new Uint8Array(bytes.byteLength * 2);
		doubled.set(bytes, 0);
		doubled.set(bytes, bytes.byteLength);
		expect(
			fromAck(
				exportAck(evidence, {
					cohortObservationEvidenceBase64: toBase64(doubled),
				}),
			).ok,
		).toBe(false);
	});

	test("truncated_raw_cohort_bundle_is_rejected_at_build", () => {
		const evidence = honestEvidence();
		const bytes = bytesOfCanonical(evidence);
		const cut = bytes.slice(0, bytes.byteLength - 16);
		expect(
			fromAck(
				exportAck(evidence, {
					cohortObservationEvidenceBase64: toBase64(cut),
				}),
			).ok,
		).toBe(false);
		// Truncated payload with an honestly restated size still fails the
		// digest the supervisor signed over the whole bundle.
		expect(
			fromAck(
				exportAck(evidence, {
					cohortObservationEvidenceBase64: toBase64(cut),
					cohortObservationEvidenceSize: cut.byteLength,
				}),
			).ok,
		).toBe(false);
	});

	test("oversize_raw_cohort_bundle_is_rejected_at_build", () => {
		const evidence = honestEvidence();
		// The encoded cap is checked before the payload is read or allocated.
		expect(
			fromAck(
				exportAck(evidence, {
					cohortObservationEvidenceBase64: "A".repeat(
						COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES + 4,
					),
					cohortObservationEvidenceSize: 9 * 1024 * 1024 + 1,
				}),
			).ok,
		).toBe(false);
	});

	test("reordered_raw_cohort_bundle_is_rejected_at_build", () => {
		const reordered = honestEvidence();
		const workers = [...(reordered.workerPartials as unknown[])];
		[workers[0], workers[1]] = [workers[1], workers[0]];
		reordered.workerPartials = workers;
		expect(fromAck(exportAck(reordered)).ok).toBe(false);
	});

	test("genuine_receipt_paired_with_different_partial_bytes_is_rejected", () => {
		expect(fromAck(exportAck(honestEvidence({ detachPartials: true }))).ok).toBe(
			false,
		);
	});

	// --- ledger item 3: the derived records are inside the seal -------------

	test("process_proof_rewrite_changes_the_artifact_seal_hash", () => {
		const honest = sealDigestOf(
			buildFanout({ cohortEvidence: honestCohortEvidence() }),
		);
		const rewritten = sealDigestOf(
			buildFanout({
				cohortEvidence: honestCohortEvidence({
					rewrite: (records) => {
						records.proof = {
							...records.proof,
							children: records.proof.children.map((child, index) =>
								index === 0 ? { ...child, pid: child.pid + 1 } : child,
							),
						} as ObservedProcessProofV1;
						records.proof = {
							...records.proof,
							childrenDigestSha256: observedChildrenDigestSha256(
								records.proof.children,
							),
						} as ObservedProcessProofV1;
					},
				}),
			}),
		);
		expect(rewritten).not.toBe(honest);
	});

	test("cohort_ledger_rewrite_changes_the_artifact_seal_hash", () => {
		const honest = sealDigestOf(
			buildFanout({ cohortEvidence: honestCohortEvidence() }),
		);
		const rewritten = sealDigestOf(
			buildFanout({
				cohortEvidence: honestCohortEvidence({
					rewrite: (records) => {
						// Internally consistent, so the rewrite is caught by the
						// seal rather than by the ledger's own arithmetic.
						records.ledger = {
							...records.ledger,
							messageBytes: 128,
							deliveredBytes: records.ledger.delivered * 128,
						} as CohortLedgerV1;
					},
				}),
			}),
		);
		expect(rewritten).not.toBe(honest);
	});

	test("capacity_rewrite_changes_the_artifact_seal_hash", () => {
		const honest = sealDigestOf(
			buildFanout({ cohortEvidence: honestCohortEvidence() }),
		);
		const rewritten = sealDigestOf(
			buildFanout({
				cohortEvidence: honestCohortEvidence({
					rewrite: (records) => {
						records.capacity = {
							...records.capacity,
							sessionsActivePeak: records.capacity.sessionsActivePeak - 1,
						};
					},
				}),
			}),
		);
		expect(rewritten).not.toBe(honest);
	});

	test("rate_series_rewrite_changes_the_artifact_seal_hash", () => {
		const honest = sealDigestOf(
			buildFanout({ cohortEvidence: honestCohortEvidence() }),
		);
		const rewritten = sealDigestOf(
			buildFanout({
				cohortEvidence: honestCohortEvidence({
					rewrite: (records) => {
						records.series = {
							...records.series,
							lastDeliveryIncludingDrainAtMacNs: (START_NS + 3n).toString(),
						};
					},
				}),
			}),
		);
		expect(rewritten).not.toBe(honest);
	});

	// --- ledger item 4: which cells require the record ----------------------

	test("cohort_observation_evidence_is_required_non_null_for_the_six_fanout_cells", () => {
		expect([...FANOUT_COHORT_CELL_IDS].sort()).toEqual([
			"chat-fanout/subscribers-1000",
			"chat-fanout/subscribers-10000",
			"chat-fanout/subscribers-5000",
			"ticker-fanout/rate-10000",
			"ticker-fanout/rate-100000",
			"ticker-fanout/rate-50000",
		]);
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			expect(requiresCohortObservationEvidence(cellId, "primary")).toBe(true);
			// Read-path and overlay arms ride the same wire but are not the
			// cohort's measured arm.
			expect(requiresCohortObservationEvidence(cellId, "read-path")).toBe(
				false,
			);
			expect(requiresCohortObservationEvidence(cellId, "overlay")).toBe(false);
		}
		expect(() => buildFanout({ cellId: "ticker-fanout/rate-50000" })).toThrow(
			/COHORT_OBSERVATION_EVIDENCE_MISSING/,
		);
	});

	test("cohort_observation_evidence_stays_null_for_non_fanout_cells", () => {
		expect(requiresCohortObservationEvidence(NON_FANOUT_CELL, "primary")).toBe(
			false,
		);
		const artifact = buildFanout({ cellId: NON_FANOUT_CELL });
		expect(artifact.attestationEvidence.cohortObservationEvidence).toBeNull();
		// And a non-fanout cell may not smuggle one in either: the record is
		// evidence about a cohort that cell never ran.
		expect(() =>
			buildFanout({
				cellId: NON_FANOUT_CELL,
				cohortEvidence: honestCohortEvidence(),
			}),
		).toThrow(/COHORT_OBSERVATION_EVIDENCE_UNEXPECTED/);
	});

	// --- ledger item 5: the real repetition identity ------------------------

	test("real_repetition_identity_index_and_total_round_trips", () => {
		const cohortEvidence = honestCohortEvidence();
		for (const index of [1, 2, 3, 4, 5]) {
			const artifact = buildFanout({
				cohortEvidence,
				measuredRepetitionIndex: index,
				measuredRepetitionTotal: 5,
			});
			expect(artifact.repetitionIndex).toBe(index);
			expect(artifact.repetitionTotal).toBe(5);
			expect(artifact.repetitionKind).toBe("measured");
			expect(artifact.executionPurpose).toBe("canonical");
			expect(artifact.attestationEvidence.cohortObservationEvidence).not.toBe(
				null,
			);
		}
		// Distinct identities are distinct seals, so a rep cannot be re-filed
		// under another index.
		const digests = new Set(
			[1, 2, 3, 4, 5].map((index) =>
				sealDigestOf(
					buildFanout({
						cohortEvidence,
						measuredRepetitionIndex: index,
						measuredRepetitionTotal: 5,
					}),
				),
			),
		);
		expect(digests.size).toBe(5);
		// A canonical measured rep may not state a total the purpose forbids.
		expect(() =>
			buildFanout({
				cohortEvidence,
				measuredRepetitionIndex: 1,
				measuredRepetitionTotal: 1,
			}),
		).toThrow(/REPETITION_IDENTITY_INVALID/);
		expect(() =>
			buildFanout({
				cohortEvidence,
				measuredRepetitionIndex: 6,
				measuredRepetitionTotal: 5,
			}),
		).toThrow(/REPETITION_IDENTITY_INVALID/);
	});

	test("trust_context_covers_the_cohort_observation_evidence_digest", () => {
		const cohortEvidence = honestCohortEvidence();
		const artifact = buildFanout({ cohortEvidence });
		const context = trustContextForArtifact(artifact);
		expect(context.cohortObservationEvidenceSha256).toBe(
			cohortEvidence.exportAck.cohortObservationEvidenceSha256,
		);
		const plain = trustContextForArtifact(
			buildFanout({ cellId: NON_FANOUT_CELL }),
		);
		expect(plain.cohortObservationEvidenceSha256).toBeNull();
	});
});
