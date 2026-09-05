import {
	cohortExportAckSigningBytes,
	ed25519Sign,
	generateEd25519KeyPair,
} from "./cross-supervisor-protocol.ts";

const exportKeys = generateEd25519KeyPair();
const exportObservations = new WeakMap<object, unknown>();

/**
 * B3.5 the cohort -> `MeasuredLeg` projection (plan §4.5, §5 `ASSEMBLY`).
 *
 * Phase B has no single-session driver behind the arm it seals: the numbers
 * come out of the Mac supervisor's terminal cohort export, and the only way
 * they can reach `buildRunArtifact` is as a `MeasuredLeg`. These tests pin
 * every §4.5 identity of that projection, pin the source of every *other*
 * `MeasuredLeg` field the artifact requires, and prove the projection refuses
 * rather than defaults when a source is absent or disagrees with the sealed
 * derived records.
 *
 * The fixture is an honest ticker-10k-shaped cohort built from the frozen
 * §4.4 records and the §4.5 recomputation helpers, so no digest and no total
 * below is hand-written. Losses are injected as whole ingress fan-outs (one
 * message lost to every subscriber at once) so the shard vectors stay exact.
 */
import { describe, expect, test } from "bun:test";
import {
	type CohortLegSources,
	measuredCohortToArm,
	projectCohortEvidenceToMeasuredLeg,
} from "./arm-measure.ts";
import {
	type ArmCohortEvidenceV1,
	buildRunArtifact,
	cohortEvidenceFromExportAck,
} from "./artifact-builder.ts";
import { mintPhaseAAttestationFixture } from "./cohort-fixture-signing.ts";
import {
	COHORT_WORKER_COUNT,
	type CohortCapacityV1,
	type LinuxRelayObservationV1,
	type ObservedProcessProofV1,
	observedChildrenDigestSha256,
	orderedPartialDigestSetSha256,
	type PublisherPartialV1,
	type RetainedCanonicalBytesV1,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	type WorkerPartialV1,
} from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	type MacCohortEvidenceExportedAckV1,
	toBase64,
} from "./cross-supervisor-protocol.ts";
import {
	type AdmissionCounters,
	MEASUREMENT_GRANT_SCHEMA,
	type MeasurementGrantV1,
	PRIMARY_METRIC_CONTRACTS,
	sealRunArtifact,
} from "./evidence.ts";
import { R1_FIXTURE_TOOLCHAINS } from "./r1-fixtures.ts";
import { buildMeasuredArmArtifact } from "./run-campaign.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import type { ServerSnapshotRecord } from "./server-snapshot-protocol.ts";
import { percentile } from "./stats.ts";
import { verifyRunArtifact } from "./verify-artifact.ts";

// --- frozen fixture identities ---------------------------------------------

const HEX = (character: string): string => character.repeat(64);

/** ticker-fanout/rate-10000: one publisher, eight workers, 100 subscribers. */
const FANOUT_CELL = "ticker-fanout/rate-10000";
const EXECUTION = {
	campaignId: "fanout-b3-r1",
	runId: "fanout-b3-r1-run",
	executionIndex: 1,
	transport: "ws",
} as const;

/**
 * The arm's Phase-A attestation graph, minted once.
 *
 * The cohort export is bound to the attestation's execution: the artifact
 * verifier refuses an export receipt that names a different one. Minting the
 * graph here and taking its execution digest as the fixture's own is what
 * makes the seal below an honest single execution rather than two.
 */
const PHASE_A = mintPhaseAAttestationFixture({
	executionPurpose: "focused",
	repetitionKind: "measured",
	repetitionIndex: 1,
	repetitionTotal: 1,
	transport: "ws",
	cellId: FANOUT_CELL,
	campaignId: EXECUTION.campaignId,
	runId: EXECUTION.runId,
});
const EXECUTION_SHA = PHASE_A.attestation.executionSha256;
const WINDOWS = 10;
const MESSAGE_BYTES = 100 as const;
const START_NS = 1_000_000_000_000n;
const LAST_MEASURED_NS = START_NS + 9_500_000_000n;
const LAST_INCLUDING_DRAIN_NS = START_NS + 9_900_000_000n;

const PUBLISHERS = 1;
const SUBSCRIBERS = 100;
const SHARDS = [13, 13, 13, 13, 12, 12, 12, 12] as const;
const CONTRACT = PRIMARY_METRIC_CONTRACTS["ticker-fanout"]!;

/** Ingress the publisher offered, and the relay accepted, in each window. */
const ACCEPTED_PER_WINDOW = Array.from({ length: WINDOWS }, (_u, w) => 10 + w);

/**
 * Losses, expressed per subscriber so a loss removes one whole ingress
 * fan-out. `queueDrop`/`writeTimeout`/`disconnect` are the three relay
 * outcomes §4.5 accounts an expanded delivery to when it is not written.
 */
interface LossShape {
	readonly queueDrop: readonly number[];
	readonly writeTimeout: readonly number[];
	readonly disconnect: readonly number[];
}

function zeros(length: number): number[] {
	return Array.from({ length }, () => 0);
}

function noLoss(): LossShape {
	return {
		queueDrop: zeros(WINDOWS),
		writeTimeout: zeros(WINDOWS),
		disconnect: zeros(WINDOWS),
	};
}

/** One message per subscriber lost in window 3/4/5 to each of the three causes. */
function mixedLoss(): LossShape {
	const queueDrop = zeros(WINDOWS);
	queueDrop[3] = 1;
	const writeTimeout = zeros(WINDOWS);
	writeTimeout[4] = 2;
	const disconnect = zeros(WINDOWS);
	disconnect[5] = 1;
	return { queueDrop, writeTimeout, disconnect };
}

function lostPerSubscriber(loss: LossShape, window: number): number {
	return (
		loss.queueDrop[window]! +
		loss.writeTimeout[window]! +
		loss.disconnect[window]!
	);
}

/** Deliveries each subscriber actually received in one origin window. */
function deliveredPerSubscriber(loss: LossShape, window: number): number {
	return ACCEPTED_PER_WINDOW[window]! - lostPerSubscriber(loss, window);
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

function publisherPartial(): PublisherPartialV1 {
	const offered = [...ACCEPTED_PER_WINDOW];
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
		offeredBytesByOriginWindow: offered.map((count) => count * MESSAGE_BYTES),
		acceptedAckSeenByOriginWindow: [...offered],
		duplicateAckSeenByOriginWindow: zeros(WINDOWS),
		reorderedAckSeenByOriginWindow: zeros(WINDOWS),
		firstOfferAtMacNs: START_NS.toString(),
		lastAckAtMacNs: (START_NS + 1n).toString(),
		exitCode: 0,
	};
}

/**
 * One subscriber worker.
 *
 * `drainPerSubscriber` moves that many of the *last* origin window's
 * deliveries out of the event windows and into `deliveredAfterMeasureStop`:
 * the same deliveries, conserved on the origin axis, excluded from the
 * measured rate series. That is the exact shape §4.5 says must never be
 * folded backward into the samples.
 */
function workerPartial(
	workerIndex: number,
	loss: LossShape,
	drainPerSubscriber = 0,
): WorkerPartialV1 {
	const shard = SHARDS[workerIndex]!;
	const origin = ACCEPTED_PER_WINDOW.map(
		(_u, window) => deliveredPerSubscriber(loss, window) * shard,
	);
	const event = [...origin];
	event[WINDOWS - 1] = event[WINDOWS - 1]! - drainPerSubscriber * shard;
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
		deliveredByOriginWindow: origin,
		deliveredBytesByOriginWindow: origin.map((count) => count * MESSAGE_BYTES),
		deliveredByEventWindow: event,
		deliveredBytesByEventWindow: event.map((count) => count * MESSAGE_BYTES),
		deliveredAfterMeasureStop: drainPerSubscriber * shard,
		deliveredBytesAfterMeasureStop: drainPerSubscriber * shard * MESSAGE_BYTES,
		perSubscriberDelivered: Array.from({ length: shard }, () =>
			origin.reduce(
				(sum, _u, window) => sum + deliveredPerSubscriber(loss, window),
				0,
			),
		),
		duplicateCount: 0,
		reorderCount: 0,
		malformedCount: 0,
		disconnectCount: 0,
		firstDeliveryAtMacNs: START_NS.toString(),
		lastDeliveryAtMacNs: LAST_INCLUDING_DRAIN_NS.toString(),
		exitCode: 0,
	};
}

function linuxObservation(loss: LossShape): LinuxRelayObservationV1 {
	const relayWrites = ACCEPTED_PER_WINDOW.map(
		(_u, window) => deliveredPerSubscriber(loss, window) * SUBSCRIBERS,
	);
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
		acceptedIngressByOriginWindow: [...ACCEPTED_PER_WINDOW],
		acceptedIngressBytesByOriginWindow: ACCEPTED_PER_WINDOW.map(
			(count) => count * MESSAGE_BYTES,
		),
		relayWritesCompletedByOriginWindow: relayWrites,
		// The relay writes a 4-byte record header the scenario never asked for:
		// this is the only measured overhead anywhere in the cohort records.
		relayWriteBytesByOriginWindow: relayWrites.map(
			(count) => count * (MESSAGE_BYTES + 4),
		),
		duplicateIngressByOriginWindow: zeros(WINDOWS),
		reorderedIngressByOriginWindow: zeros(WINDOWS),
		queueDropDeliveriesByOriginWindow: loss.queueDrop.map(
			(count) => count * SUBSCRIBERS,
		),
		writeTimeoutDeliveriesByOriginWindow: loss.writeTimeout.map(
			(count) => count * SUBSCRIBERS,
		),
		disconnectUndeliveredByOriginWindow: loss.disconnect.map(
			(count) => count * SUBSCRIBERS,
		),
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

/** Every §4.4 admission field this fixture does not derive. */
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

interface CohortShape {
	readonly loss: LossShape;
	readonly drainPerSubscriber: number;
}

function honestEvidence(shape: CohortShape): Record<string, unknown> {
	const publisher = publisherPartial();
	const workers = Array.from({ length: COHORT_WORKER_COUNT }, (_u, index) =>
		workerPartial(index, shape.loss, shape.drainPerSubscriber),
	);
	const linux = linuxObservation(shape.loss);

	const conservation = recomputeCohortOriginConservation({
		publisherPartials: [publisher],
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
		lastMeasuredWindowDeliveryAtMacNs: LAST_MEASURED_NS.toString(),
		lastDeliveryIncludingDrainAtMacNs: LAST_INCLUDING_DRAIN_NS.toString(),
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
	const capacity: CohortCapacityV1 = {
		schema: "cohort-capacity/v1",
		expectedSessions: PUBLISHERS + SUBSCRIBERS,
		sessionsAccepted: PUBLISHERS + SUBSCRIBERS,
		sessionsActivePeak: PUBLISHERS + SUBSCRIBERS,
		expectedPublishers: PUBLISHERS,
		registeredPublishers: PUBLISHERS,
		expectedSubscribers: SUBSCRIBERS,
		registeredSubscribers: SUBSCRIBERS,
	};
	const proof = observedProcessProof(
		publisherRetained.sha256,
		workerRetained.map((entry) => entry.sha256),
	);

	const linuxRetained = retain(linux);
	const manifestRetained = retain(
		orderedManifest(publisherRetained, workerRetained),
	);
	const proofRetained = retain(proof);
	const seriesRetained = retain(seriesResult.value);
	const ledgerRetained = retain(ledgerResult.value);
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
		offeredIngress: ledgerResult.value.offeredIngress,
		serverAcceptedIngress: ledgerResult.value.serverAcceptedIngress,
		linuxRelayWritesCompleted: ledgerResult.value.linuxRelayWritesCompleted,
		delivered: ledgerResult.value.delivered,
		macSupervisorInstanceNonce: HEX("6"),
		signingPublicKeySha256: HEX("5"),
		receiptSequence: 7,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
	};
	for (const field of ADMISSION_OPAQUE_FIELDS) admission[field] = HEX("9");

	const filler = (label: string) => retain({ label });
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
			(_u, index) => filler(`warmup-complete-${index}`),
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
		cohortAdmissionReceipt: retain(admission),
		cohortAdmissionSignature: filler("admission-sig"),
	};
}

function exportAck(
	evidence: Record<string, unknown>,
): MacCohortEvidenceExportedAckV1 {
	const bytes = bytesOfCanonical(evidence);
	const ack = {
		schema: "mac-cohort-evidence-exported-ack/v1",
		responseSeq: 11,
		ackRequestSeq: 11,
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

function cohortEvidenceFor(
	shape: CohortShape = { loss: noLoss(), drainPerSubscriber: 0 },
): ArmCohortEvidenceV1 {
	const result = cohortEvidenceFromExportAck({
		ack: exportAck(honestEvidence(shape)),
		observation: honestEvidence(shape),
		stagedMacPublicRaw32: exportKeys.publicRaw32,
		expectedExecutionSha256: EXECUTION_SHA,
		expectedCohortGrantSha256: GRANT_SHA,
		expectedPublisherCount: PUBLISHERS,
		expectedSubscriberCount: SUBSCRIBERS,
		alreadyExported: false,
		expectedRequestSequence: 11,
	});
	if (!result.ok) throw new Error(`fixture is not honest: ${result.message}`);
	return result.value;
}

// --- the non-cohort sources the projection joins ---------------------------

const SERVER_SNAPSHOT: ServerSnapshotRecord = {
	schema: "server-loop-utilization/v1",
	campaignId: "fanout-b3-r1",
	runId: "fanout-b3-r1-run",
	executionIndex: 1,
	transport: "ws",
	legId: "ticker-fanout/rate-10000#ws",
	sequence: 1,
	capturedAtMs: 1_700_000_000_000,
	loopUtilization: { busyMs: 4_210, windowMs: 10_000 },
};

const ADMISSION_COUNTERS: AdmissionCounters = {
	schemaVersion: "v1",
	handshakes: {
		attempted: PUBLISHERS + SUBSCRIBERS,
		accepted: PUBLISHERS + SUBSCRIBERS,
		rejected: 0,
		rateLimited: 0,
	},
	sessions: {
		attempted: PUBLISHERS + SUBSCRIBERS,
		accepted: PUBLISHERS + SUBSCRIBERS,
		rejected: 0,
		activePeak: PUBLISHERS + SUBSCRIBERS,
	},
	streams: {
		attempted: PUBLISHERS + SUBSCRIBERS,
		accepted: PUBLISHERS + SUBSCRIBERS,
		rejected: 0,
		rateLimited: 0,
	},
	datagrams: { attempted: 0, accepted: 0, rejected: 0, rateLimited: 0 },
};

const RECORDER = {
	attestation: `cohort-rate-series:${HEX("a")}`,
	driverRunId: "fanout-b3-r1-run/measured-1",
	clockMethod: "mach_continuous_time",
} as const;

function sourcesFor(
	shape: CohortShape = { loss: noLoss(), drainPerSubscriber: 0 },
	overrides: Partial<CohortLegSources> = {},
): CohortLegSources {
	return {
		linuxRelayObservation: linuxObservation(shape.loss),
		serverSnapshot: SERVER_SNAPSHOT,
		contract: CONTRACT,
		admissionCounters: ADMISSION_COUNTERS,
		recorder: RECORDER,
		...overrides,
	};
}

function project(
	shape: CohortShape = { loss: noLoss(), drainPerSubscriber: 0 },
	overrides: Partial<CohortLegSources> = {},
) {
	return projectCohortEvidenceToMeasuredLeg(
		cohortEvidenceFor(shape),
		sourcesFor(shape, overrides),
	);
}

const NO_LOSS: CohortShape = { loss: noLoss(), drainPerSubscriber: 0 };
const MIXED_LOSS: CohortShape = { loss: mixedLoss(), drainPerSubscriber: 0 };
const DRAINING: CohortShape = { loss: noLoss(), drainPerSubscriber: 3 };

// --- §4.5 identities -------------------------------------------------------

describe("B3.5 the cohort export projects into a MeasuredLeg", () => {
	test("admitted_client_series_is_exactly_the_rate_record_samples", () => {
		const evidence = cohortEvidenceFor(NO_LOSS);
		const leg = projectCohortEvidenceToMeasuredLeg(
			evidence,
			sourcesFor(NO_LOSS),
		);
		expect(leg.samples).toEqual([...evidence.rateSeries.samples]);
		expect(leg.sampleUnit).toBe("count");
		expect(leg.provenance.sampleCount).toBe(evidence.rateSeries.samples.length);
		expect(leg.provenance.sampleCount).toBe(WINDOWS);
		// Every window carries its own ingress rate expanded over 100 subscribers.
		expect(leg.samples).toEqual(
			ACCEPTED_PER_WINDOW.map((count) => count * SUBSCRIBERS),
		);
	});

	test("delivered_is_the_measured_window_total_not_the_conservation_total", () => {
		const evidence = cohortEvidenceFor(DRAINING);
		const leg = projectCohortEvidenceToMeasuredLeg(
			evidence,
			sourcesFor(DRAINING),
		);
		expect(evidence.rateSeries.postStopDrainDelivered).toBeGreaterThan(0);
		expect(leg.ledger.delivered).toBe(
			evidence.rateSeries.measuredWindowDeliveredTotal,
		);
		expect(leg.ledger.delivered).toBeLessThan(
			evidence.rateSeries.conservationDeliveredTotal,
		);
		// The cohort ledger keeps the conservation total; the leg does not.
		expect(evidence.ledger.delivered).toBe(
			evidence.rateSeries.conservationDeliveredTotal,
		);
	});

	test("post_stop_drain_never_enters_the_samples", () => {
		const drained = projectCohortEvidenceToMeasuredLeg(
			cohortEvidenceFor(DRAINING),
			sourcesFor(DRAINING),
		);
		const clean = projectCohortEvidenceToMeasuredLeg(
			cohortEvidenceFor(NO_LOSS),
			sourcesFor(NO_LOSS),
		);
		const drainedPerWindow = 3 * SUBSCRIBERS;
		// Only the last window moves, and it moves *down* by exactly the drain.
		expect(drained.samples.slice(0, WINDOWS - 1)).toEqual(
			clean.samples.slice(0, WINDOWS - 1),
		);
		expect(drained.samples[WINDOWS - 1]).toBe(
			clean.samples[WINDOWS - 1]! - drainedPerWindow,
		);
		expect(drained.samples.reduce((sum, sample) => sum + sample, 0)).toBe(
			clean.ledger.delivered - drainedPerWindow,
		);
	});

	test("first_and_last_sample_timestamps_come_from_the_rate_record", () => {
		const leg = project(DRAINING);
		expect(leg.provenance.firstSampleAtMs).toBe(Number(START_NS) / 1e6);
		// The measured-window last delivery, never the drain's last delivery.
		expect(leg.provenance.lastSampleAtMs).toBe(Number(LAST_MEASURED_NS) / 1e6);
		expect(leg.provenance.lastSampleAtMs).not.toBe(
			Number(LAST_INCLUDING_DRAIN_NS) / 1e6,
		);
	});

	test("the_recorder_identity_is_carried_and_never_invented", () => {
		const leg = project();
		expect(leg.provenance.attestation).toBe(RECORDER.attestation);
		expect(leg.provenance.driverRunId).toBe(RECORDER.driverRunId);
		expect(leg.provenance.clockMethod).toBe(RECORDER.clockMethod);
	});

	// --- ledger stages -----------------------------------------------------

	test("ledger_stages_are_the_cohort_ledger_projection", () => {
		const evidence = cohortEvidenceFor(MIXED_LOSS);
		const leg = projectCohortEvidenceToMeasuredLeg(
			evidence,
			sourcesFor(MIXED_LOSS),
		);
		expect(leg.ledger.attempted).toBe(
			evidence.ledger.offeredExpandedDeliveries,
		);
		expect(leg.ledger.queued).toBe(
			evidence.ledger.serverAcceptedExpandedDeliveries,
		);
		expect(leg.ledger.serverObserved).toBe(
			evidence.ledger.linuxRelayWritesCompleted,
		);
		expect(leg.ledger.acknowledged).toBe(
			evidence.ledger.linuxRelayWritesCompleted,
		);
		// The two monotone chains the artifact verifier enforces.
		expect(leg.ledger.queued).toBeLessThanOrEqual(leg.ledger.attempted);
		expect(leg.ledger.acknowledged).toBeLessThanOrEqual(leg.ledger.queued);
		expect(leg.ledger.delivered).toBeLessThanOrEqual(leg.ledger.serverObserved);
	});

	test("dropped_and_expired_come_from_the_linux_relay_outcome_arrays", () => {
		const loss = mixedLoss();
		const leg = project(MIXED_LOSS);
		// queue drops and disconnects are drops; a write timeout is an expiry.
		expect(leg.ledger.dropped).toBe(
			(loss.queueDrop[3]! + loss.disconnect[5]!) * SUBSCRIBERS,
		);
		expect(leg.ledger.expired).toBe(loss.writeTimeout[4]! * SUBSCRIBERS);
		expect(project(NO_LOSS).ledger.dropped).toBe(0);
		expect(project(NO_LOSS).ledger.expired).toBe(0);
	});

	test("harness_overhead_is_the_relay_write_byte_excess_over_payload", () => {
		const evidence = cohortEvidenceFor(MIXED_LOSS);
		const leg = projectCohortEvidenceToMeasuredLeg(
			evidence,
			sourcesFor(MIXED_LOSS),
		);
		// The fixture's relay writes a 4-byte header per record.
		expect(leg.ledger.harnessOverheadBytes).toBe(
			evidence.ledger.linuxRelayWritesCompleted * 4,
		);
		expect(leg.ledger.harnessOverheadBytes).toBeGreaterThan(0);
	});

	test("percentiles_are_the_shared_stats_percentile_of_the_projected_samples", () => {
		const leg = project(MIXED_LOSS);
		expect(leg.percentiles).toEqual({
			p1: percentile(leg.samples, 1),
			p50: percentile(leg.samples, 50),
			p95: percentile(leg.samples, 95),
			p99: percentile(leg.samples, 99),
		});
	});

	test("histogram_buckets_the_projected_samples_on_the_contract_scale", () => {
		const leg = project(NO_LOSS);
		expect(leg.ledger.histogram.unit).toBe(CONTRACT.unit);
		expect(leg.ledger.histogram.boundaries).toEqual(
			CONTRACT.histogramBoundaries,
		);
		expect(
			leg.ledger.histogram.counts.reduce((sum, count) => sum + count, 0),
		).toBe(leg.samples.length);
		// Every sample is in [1000, 1900): the 1000 bucket holds all ten.
		const bucket = CONTRACT.histogramBoundaries.indexOf(1_000);
		expect(leg.ledger.histogram.counts[bucket]).toBe(WINDOWS);
	});

	test("loop_utilization_is_the_rig_server_snapshot_reading", () => {
		const leg = project();
		expect(leg.loopUtilization).toEqual(SERVER_SNAPSHOT.loopUtilization);
	});

	test("admission_counters_are_carried_and_bound_to_the_capacity_record", () => {
		const leg = project();
		expect(leg.admissionCounters).toEqual(ADMISSION_COUNTERS);
	});

	test("a_cohort_leg_reports_no_round_trips_rather_than_synthetic_ones", () => {
		expect(project().roundTrips).toEqual([]);
	});

	// --- refusals ----------------------------------------------------------

	test("refuses_a_server_snapshot_without_a_measured_loop", () => {
		expect(() =>
			project(NO_LOSS, {
				serverSnapshot: {
					...SERVER_SNAPSHOT,
					loopUtilization: undefined,
				} as unknown as ServerSnapshotRecord,
			}),
		).toThrow(/loopUtilization/);
		expect(() =>
			project(NO_LOSS, {
				serverSnapshot: {
					...SERVER_SNAPSHOT,
					loopUtilization: { busyMs: 1, windowMs: 0 },
				},
			}),
		).toThrow(/windowMs/);
	});

	test("refuses_a_contract_whose_unit_is_not_the_rate_record_unit", () => {
		expect(() =>
			project(NO_LOSS, {
				contract: { ...CONTRACT, unit: "ms" },
			}),
		).toThrow(/unit/);
	});

	test("refuses_an_observation_bound_to_another_execution", () => {
		expect(() =>
			project(NO_LOSS, {
				linuxRelayObservation: {
					...linuxObservation(noLoss()),
					executionSha256: HEX("b"),
				},
			}),
		).toThrow(/execution/);
		expect(() =>
			project(NO_LOSS, {
				linuxRelayObservation: {
					...linuxObservation(noLoss()),
					cohortStartBarrierSha256: HEX("b"),
				},
			}),
		).toThrow(/barrier/);
	});

	test("refuses_an_observation_whose_totals_disagree_with_the_sealed_ledger", () => {
		const observation = linuxObservation(noLoss());
		const acceptedIngress = [...observation.acceptedIngressByOriginWindow];
		acceptedIngress[0] = acceptedIngress[0]! + 1;
		expect(() =>
			project(NO_LOSS, {
				linuxRelayObservation: {
					...observation,
					acceptedIngressByOriginWindow: acceptedIngress,
				},
			}),
		).toThrow(/accepted ingress/);

		const relayWrites = [...observation.relayWritesCompletedByOriginWindow];
		relayWrites[0] = relayWrites[0]! - SUBSCRIBERS;
		expect(() =>
			project(NO_LOSS, {
				linuxRelayObservation: {
					...observation,
					relayWritesCompletedByOriginWindow: relayWrites,
				},
			}),
		).toThrow(/relay writes/);
	});

	test("refuses_an_observation_whose_relay_outcomes_do_not_account_for_the_expansion", () => {
		// Move one window's loss out of the drop counter without moving the
		// writes: the per-window outcome identity no longer closes.
		const observation = linuxObservation(mixedLoss());
		expect(() =>
			projectCohortEvidenceToMeasuredLeg(
				cohortEvidenceFor(MIXED_LOSS),
				sourcesFor(MIXED_LOSS, {
					linuxRelayObservation: {
						...observation,
						queueDropDeliveriesByOriginWindow: zeros(WINDOWS),
					},
				}),
			),
		).toThrow(/outcome/);
	});

	test("refuses_an_observation_whose_registered_population_is_not_the_capacity_record", () => {
		expect(() =>
			project(NO_LOSS, {
				linuxRelayObservation: {
					...linuxObservation(noLoss()),
					sessionsActivePeak: PUBLISHERS + SUBSCRIBERS - 1,
				},
			}),
		).toThrow(/capacity/);
	});

	test("refuses_admission_counters_that_disagree_with_the_capacity_record", () => {
		expect(() =>
			project(NO_LOSS, {
				admissionCounters: {
					...ADMISSION_COUNTERS,
					sessions: { ...ADMISSION_COUNTERS.sessions, accepted: 1 },
				},
			}),
		).toThrow(/sessions/);
	});

	test("refuses_an_unstated_recorder_identity", () => {
		for (const key of ["attestation", "driverRunId", "clockMethod"] as const) {
			expect(() =>
				project(NO_LOSS, { recorder: { ...RECORDER, [key]: "" } }),
			).toThrow(new RegExp(key));
		}
	});

	test("refuses_relay_write_bytes_below_the_payload_they_carried", () => {
		const observation = linuxObservation(noLoss());
		expect(() =>
			project(NO_LOSS, {
				linuxRelayObservation: {
					...observation,
					relayWriteBytesByOriginWindow:
						observation.relayWritesCompletedByOriginWindow.map(
							(count) => count * (MESSAGE_BYTES - 1),
						),
				},
			}),
		).toThrow(/overhead/);
	});

	test("refuses_a_window_cardinality_that_is_not_the_rate_record_cardinality", () => {
		const observation = linuxObservation(noLoss());
		expect(() =>
			project(NO_LOSS, {
				linuxRelayObservation: {
					...observation,
					windowCount: 30,
				} as unknown as LinuxRelayObservationV1,
			}),
		).toThrow(/window/);
	});
});

// --- the production path ---------------------------------------------------

function grantFor(sampleCount: number): MeasurementGrantV1 {
	const issuedAt = 1_700_000_000_000;
	return {
		schema: MEASUREMENT_GRANT_SCHEMA,
		campaignId: EXECUTION.campaignId,
		candidate: "b3-cohort-candidate",
		declaredMessageBytes: MESSAGE_BYTES,
		declaredMessageCount: sampleCount * 1_000,
		executionIndex: EXECUTION.executionIndex,
		issuedAt,
		nonceSha256: HEX("c"),
		notAfter: issuedAt + 15 * 60 * 1_000,
		runId: EXECUTION.runId,
		transport: EXECUTION.transport,
	} as MeasurementGrantV1;
}

/**
 * The two rejections this fixture cannot clear, and why neither is the
 * projection's.
 *
 * `TRUST_CONTEXT_MISSING`: `verifyRunArtifact` is called here without the
 * external source/run/comparison anchors, which a unit test has no staged
 * trust root to supply.
 *
 * `COHORT_GRANT_DECLARATION_INVALID`: the fixture's `cohortGrant` retained
 * member is opaque filler rather than a real `CohortGrantV1`, so §12's
 * offline reconstruction of the *receipt graph* stops at the first record it
 * would replay. That half of the verifier is B4's and is covered end to end
 * by `fanout-promotion.test.ts`; what this test pins is that nothing about
 * the projected numbers -- metrics, percentiles, ledger, provenance, schema
 * shape -- is rejected. Asserting the exact set rather than a filter is
 * deliberate: a new rejection of any kind fails this test.
 */
const EXPECTED_FIXTURE_REJECTIONS = [
	"TRUST_CONTEXT_MISSING",
	"SCHEMA_INVALID_FIELD",
] as const;

describe("B3.5 the projected leg seals as a measured fanout arm", () => {
	test("evidence_to_leg_to_arm_to_artifact_seals_and_verifies_without_a_measurement_rejection", () => {
		const cohortEvidence = cohortEvidenceFor(MIXED_LOSS);
		const sources = sourcesFor(MIXED_LOSS);
		const measurement = measuredCohortToArm({
			cohortEvidence,
			sources,
			supervisorContext: {
				toolchains: R1_FIXTURE_TOOLCHAINS,
				telemetry: {
					mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
					linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
				},
				grant: grantFor(WINDOWS),
				admission: new Uint8Array([1, 2, 3]),
			},
			execution: EXECUTION,
		}) as unknown as Record<string, unknown>;

		// The mapper carried the export ack through untouched.
		expect(measurement.cohortEvidence).toBe(cohortEvidence);

		const artifact = buildRunArtifact({
			comparisonId: EXECUTION.campaignId,
			runId: EXECUTION.runId,
			cellId: FANOUT_CELL,
			transport: "ws",
			armKind: "primary",
			evidenceStatus: "PASS",
			scenarioVerdict: "PASS",
			seed: 42,
			executionPurpose: "focused",
			repetitionKind: "measured",
			measuredRepetitionIndex: 1,
			measuredRepetitionTotal: 1,
			sampleUnit: measurement.sampleUnit,
			samples: measurement.samples,
			percentiles: measurement.percentiles,
			ledger: measurement.ledger,
			admissionCounters: measurement.admissionCounters,
			provenance: measurement.provenance,
			grant: measurement.grant,
			toolchains: measurement.toolchains,
			supervisorToolchainDigests: {
				darwin: R1_FIXTURE_TOOLCHAINS.darwin.sha256,
				linux: R1_FIXTURE_TOOLCHAINS.linux.sha256,
			},
			telemetry: measurement.telemetry,
			loopUtilization: measurement.loopUtilization,
			attestationEvidence: PHASE_A.attestation,
			cohortEvidence,
		} as never);

		const sealed = sealRunArtifact(artifact);
		const verified = verifyRunArtifact(sealed);
		expect(verified.rejections.map(({ code }) => code)).toEqual([
			...EXPECTED_FIXTURE_REJECTIONS,
		]);
		// Nothing about the numbers: no metric, percentile, ledger or
		// provenance rejection, and no rejection anywhere under those paths.
		for (const rejection of verified.rejections) {
			expect(rejection.code.startsWith("METRICS_")).toBe(false);
			expect(rejection.code.startsWith("EVIDENCE_LEDGER_")).toBe(false);
			expect((rejection.path ?? "").startsWith("$.metrics")).toBe(false);
			expect((rejection.path ?? "").startsWith("$.ledger")).toBe(false);
		}
		// No external staged trust keys were supplied: the export must refuse.
		expect(
			verified.rejections.find(({ code }) => code === "SCHEMA_INVALID_FIELD")
				?.reason,
		).toContain("COHORT_EXPORT_RECEIPT_INVALID");

		// The sealed bytes carry the export byte-exactly.
		const readBack = JSON.parse(new TextDecoder().decode(sealed)) as Record<
			string,
			unknown
		>;
		const carried = (readBack.attestationEvidence as Record<string, unknown>)
			.cohortObservationEvidence;
		expect(sha256HexOfBytes(bytesOfCanonical(carried))).toBe(
			cohortEvidence.exportAck.cohortObservationEvidenceSha256,
		);
	});
});

// ---------------------------------------------------------------------------
// B3.5 residual 6: the campaign's own builder had no field for this export.
//
// The test above goes `measuredCohortToArm` -> `buildRunArtifact` directly,
// which is not the path a campaign takes. `sealCohortArmRepetition` goes
// through `buildMeasuredArmArtifact`, and `ArmMeasurement` had no
// `cohortEvidence` field at all -- so that builder forwarded every measurement
// field except the cohort export and threw `COHORT_OBSERVATION_EVIDENCE_MISSING`
// for all six fanout primaries. Producer, consumer, no wire between them.
// ---------------------------------------------------------------------------

describe("B3.5 the campaign builder carries the cohort export", () => {
	function cohortMeasurement() {
		return measuredCohortToArm({
			cohortEvidence: cohortEvidenceFor(MIXED_LOSS),
			sources: sourcesFor(MIXED_LOSS),
			supervisorContext: {
				toolchains: R1_FIXTURE_TOOLCHAINS,
				telemetry: {
					mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
					linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
				},
				grant: grantFor(WINDOWS),
				admission: new Uint8Array([1, 2, 3]),
			},
			execution: EXECUTION,
			attestationEvidence: PHASE_A.attestation,
		});
	}

	test("the_mapper_puts_the_export_on_the_measurement_the_campaign_builder_reads", () => {
		// The field the type did not have. `ArmMeasurement.cohortEvidence` is
		// what `buildMeasuredArmArtifact` forwards; without it the mapper's
		// output and the builder's input were two different shapes.
		const measurement = cohortMeasurement();
		expect(measurement.cohortEvidence).toBeDefined();
		expect(measurement.cohortEvidence?.exportAck.terminalExport).toBe(true);
	});

	test("the_campaign_builders_next_boundary_for_this_fixture_is_the_admission", () => {
		// Executable, and reported as what it is. Building the same arm through
		// the campaign's own builder now gets past the cohort-export field and
		// stops at `MEASUREMENT_OUTSIDE_GRANT_WINDOW`: this fixture's admission
		// is three bytes, not a supervisor receipt. That is the next thing
		// standing between an honest cohort and a sealed artifact, and it is
		// recorded here rather than skipped -- an assertion that merely said
		// "not COHORT_OBSERVATION_EVIDENCE_MISSING" would pass with the
		// pass-through reverted, because the throw happens earlier either way.
		// The pass-through itself is mutation-proven in
		// `r1-flow-hardening.test.ts`, on a fixture that clears these guards.
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.cellId === FANOUT_CELL,
		);
		expect(cell).toBeDefined();
		if (cell === undefined) throw new Error("unreachable");
		expect(() =>
			buildMeasuredArmArtifact({
				cell,
				comparisonId: EXECUTION.campaignId,
				runId: EXECUTION.runId,
				executionIndex: EXECUTION.executionIndex,
				transport: "ws",
				armKind: "primary",
				executionPurpose: "focused",
				repetitionKind: "measured",
				measuredRepetitionIndex: 1,
				measuredRepetitionTotal: 1,
				measurement: cohortMeasurement(),
				attestationEvidence: PHASE_A.attestation,
			}),
		).toThrow("MEASUREMENT_OUTSIDE_GRANT_WINDOW");
	});
});
