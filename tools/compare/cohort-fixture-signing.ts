/**
 * Fixture-only signing (amendment C4).
 *
 * Everything in this module holds a private key that production never holds:
 * the offline Phase-A attestation oracle (`mintPhaseAAttestationFixture`) and a
 * scripted stand-in for the Mac supervisor *process* (`ScriptedMacCohortBinary`)
 * that answers the registered `mac-*` frames over a real pipe pair with records
 * signed by test keys. Production modules must not import this file: the
 * only Mac signer a campaign has is `crates/native`'s `comparison-supervisor`,
 * and `remote-supervisor.test.ts` proves by scanning the tree that no
 * non-test module under `tools/compare` reaches here.
 */

import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import {
	COHORT_WORKER_COUNT,
	type CohortAdmissionReceiptV1,
	type CohortGrantV1,
	type CohortObservationEvidenceV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	expectedWarmupDeliveries,
	expectedWarmupIngress,
	type PublisherRoleGrantV1,
	parseCohortAdmissionReceipt,
	parseCohortGrant,
	parseCohortObservationEvidence,
	parseCohortStartBarrier,
	parseCohortWarmupEpoch,
	parsePublisherRoleGrant,
	parseRigCohortAcceptance,
	parseRoleWarmupComplete,
	parseRoleWarmupCompletionManifest,
	parseSubscriberShard,
	parseTokenCommitmentLeafManifest,
	type RetainedCanonicalBytesV1,
	type RoleWarmupCompletionManifestEntryV1,
	type RoleWarmupCompletionManifestV1,
	recomputeRootFromLeafManifest,
	type SubscriberShardV1,
} from "./cohort-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	type CrossSupervisorExecutionDraftV1,
	type CrossSupervisorExecutionV1,
	cohortExportAckSigningBytes,
	decodeRegisteredRemotePayload,
	type Ed25519KeyPairBytes,
	type ExecutionPurpose,
	ed25519Sign,
	ed25519Verify,
	encodeRegisteredRemotePayload,
	fromBase64,
	generateEd25519KeyPair,
	type MacCohortEvidenceExportedAckV1,
	type MacCohortOpenedAckV1,
	type MacExecutionGrantReceiptV1,
	type MacReceiptSignatureV1,
	type MeasurementGrantV1Extended,
	macConstructFinalExecution,
	type NsString,
	PHASE_A_DECLARED_MESSAGE_BYTES,
	PHASE_A_DECLARED_MESSAGE_COUNT,
	parseCohortRemotePayload,
	parseCrossSupervisorExecutionDraft,
	parsePhaseAMacRemotePayload,
	parseRigExecutionAcceptance,
	parseRigReceiptSignature,
	type RepetitionKind,
	type RigExecutionAcceptanceV1,
	type RigReceiptSignatureV1,
	type Sha256Hex,
	sha256CanonicalRecord,
	signMacReceipt,
	signRigReceipt,
	toBase64,
	verifyRigReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import { parseStrictJsonBytes, sha256HexOfBytes } from "./secure-fs.ts";
import {
	type ArmAttestationEvidenceV2,
	type AttestationTrustMaterial,
	type MacMeasurementAdmissionReceiptV1,
	publicKeySha256,
	type RigMeasureStartAckV1,
	type RigServerSnapshotReceiptV1,
	retainCanonicalBytes,
	retainRawBytes,
	type ServerObservationEvidenceV1,
} from "./server-observation-artifact.ts";

function hexDigest(bytes: Uint8Array): Sha256Hex {
	return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// The offline Phase-A attestation oracle
// ---------------------------------------------------------------------------

export interface PhaseAAttestationFixture {
	readonly trust: AttestationTrustMaterial;
	readonly macKey: Ed25519KeyPairBytes;
	readonly rigKey: Ed25519KeyPairBytes;
	readonly draft: CrossSupervisorExecutionDraftV1;
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionSha256: Sha256Hex;
	readonly grant: MeasurementGrantV1Extended;
	readonly attestation: ArmAttestationEvidenceV2;
	readonly observation: ServerObservationEvidenceV1;
	readonly snapshotBusyMs: number;
	readonly snapshotWindowMs: number;
	readonly clientSeriesSha256: Sha256Hex;
	readonly snapshotFrameSha256: Sha256Hex;
}

function H(label: string): Sha256Hex {
	return createHash("sha256").update(label).digest("hex");
}

/**
 * Mint a complete bidirectionally signed Phase-A attestation graph for tests
 * and fixture builders. Production sealing retains live supervisor bytes; this
 * factory is the offline oracle those tests mutate.
 */
export function mintPhaseAAttestationFixture(options?: {
	readonly executionPurpose?: ExecutionPurpose;
	readonly repetitionKind?: RepetitionKind;
	readonly repetitionIndex?: number;
	readonly repetitionTotal?: number;
	readonly transport?: "ws" | "wt";
	readonly cellId?: string;
	readonly campaignId?: string;
	readonly candidate?: string;
	readonly runId?: string;
	readonly childPid?: number;
	readonly childPgid?: number;
	readonly spanMs?: number;
	readonly busyMs?: number;
}): PhaseAAttestationFixture {
	const macKey = generateEd25519KeyPair();
	const rigKey = generateEd25519KeyPair();
	const macPublicKeySha256 = publicKeySha256(macKey.publicRaw32);
	const rigPublicKeySha256 = publicKeySha256(rigKey.publicRaw32);
	const purpose = options?.executionPurpose ?? "focused";
	const repetitionKind = options?.repetitionKind ?? "measured";
	const repetitionIndex =
		options?.repetitionIndex ?? (repetitionKind === "warmup" ? 0 : 1);
	const repetitionTotal =
		options?.repetitionTotal ?? (repetitionKind === "warmup" ? 1 : 1);
	const transport = options?.transport ?? "ws";
	const cellId = options?.cellId ?? "bulk-one-way/physical";
	const campaignId = options?.campaignId ?? "busyms-attested-focused-r1";
	const candidate = options?.candidate ?? "a".repeat(40);
	const runId =
		options?.runId ??
		`${campaignId}/${cellId}/${transport}/${repetitionKind}-${repetitionIndex}`;
	const issuedAtMs = 1_700_000_000_000;
	const notAfterMs = issuedAtMs + 3_600_000;
	const spanMs = options?.spanMs ?? 1_250;
	const busyMs = options?.busyMs ?? 65;
	const windowMs = spanMs;

	const workloadRolePlanInput = {
		schema: "canonical-workload-role-plan-input/v1" as const,
		scenarioPreimage: {
			schema: "canonical-scenario-preimage/v1" as const,
			cellId,
			scenarioId: "bulk-one-way",
			parameters: { direction: "linux-to-mac" },
		},
		scenarioHash: H(`scenario:${cellId}`),
		rolePlanPreimage: {
			schema: "canonical-role-plan-preimage/v1" as const,
			serverRole: "bulk-source" as const,
			direction: "linux-to-mac" as const,
			channelMapping: "server-opened-uni" as const,
			publisherCount: 0 as const,
			subscriberWorkerCount: 0 as const,
			subscriberCount: 0,
			publisherRatePerSecond: 0,
			payloadBytes: 65536 as const,
			warmupMessagesPerPublisher: 0 as const,
			warmupIntervalMs: 0 as const,
			measuredDurationMs: 0 as const,
		},
		rolePlanHash: H(`role:${cellId}`),
	};
	const workloadRetained = retainCanonicalBytes(workloadRolePlanInput);
	const stagedLaunch = {
		schema: "staged-server-launch-record/v1" as const,
		stageReceiptSha256: H("stage-receipt"),
		serverEntrypointSha256: H("server.ts"),
		bunSha256: H("bun"),
		addonSha256: H("addon"),
		bindAddress: "10.99.0.2" as const,
		bindPort: 4433,
		advertisedHost: "10.99.0.2" as const,
		tlsServerName: "wt-compare.local" as const,
		tlsCertificateSha256: H("tls-certificate"),
		tlsPrivateKeySha256: H("tls-private-key"),
		transport,
		argv: ["server.ts", `--transport=${transport}`],
		allowedEnvironment: [{ name: "PATH", value: "/usr/bin" }],
	};
	const stagedRetained = retainCanonicalBytes(stagedLaunch);

	const draft: CrossSupervisorExecutionDraftV1 = {
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: H("authority"),
		campaignLockSha256: H("lock"),
		stagedCapabilitySha256: H("capability"),
		sourceArchiveSha256: H("archive"),
		approvedPlanSha256: H("plan"),
		approvalRecordSha256: H("approval"),
		candidate,
		campaignId,
		runId,
		executionPurpose: purpose,
		cellId,
		scenarioHash: workloadRolePlanInput.scenarioHash,
		rolePlanHash: workloadRolePlanInput.rolePlanHash,
		workloadRolePlanInputSha256: workloadRetained.sha256,
		stagedServerLaunchRecordSha256: stagedRetained.sha256,
		armKind: "primary",
		transport,
		repetitionKind,
		repetitionIndex,
		repetitionTotal,
		grantDeclaration: "phase-a-completed-transfer",
		declaredMessageCount: PHASE_A_DECLARED_MESSAGE_COUNT,
		declaredMessageBytes: PHASE_A_DECLARED_MESSAGE_BYTES,
		requestedNotAfterMs: notAfterMs,
	};

	const constructed = macConstructFinalExecution({
		draft,
		executionIndex: 1,
		macSupervisorInstanceNonce: H("mac-nonce"),
		issuedAtMs,
		notAfterMs,
		grantNonceSha256: H("grant-nonce"),
	});
	if (!constructed.ok) {
		throw new Error(`mint fixture failed: ${constructed.code}`);
	}
	const { grant, grantSha256, execution, executionSha256 } = constructed.value;

	const macReceipt: MacExecutionGrantReceiptV1 = {
		schema: "mac-execution-grant-receipt/v1",
		execution,
		executionSha256,
		measurementGrantSha256: grantSha256,
		approvedPlanSha256: draft.approvedPlanSha256,
		approvalRecordSha256: draft.approvalRecordSha256,
		macSupervisorExecutableSha256: H("mac-supervisor"),
		macSupervisorInstanceNonce: execution.macSupervisorInstanceNonce,
		signingPublicKeySha256: macPublicKeySha256,
		receiptSequence: 0,
		issuedAtMs,
		notAfterMs,
	};
	const macReceiptBytesForSig = bytesOfCanonical(macReceipt);
	const macGrantSig = signMacReceipt({
		privatePkcs8Der: macKey.privatePkcs8Der,
		publicRaw32: macKey.publicRaw32,
		signedSchema: "mac-execution-grant-receipt/v1",
		signedBytes: macReceiptBytesForSig,
	});

	const rigAccept: RigExecutionAcceptanceV1 = {
		schema: "rig-execution-acceptance/v1",
		executionSha256,
		measurementGrantSha256: grantSha256,
		macExecutionGrantReceiptSha256: sha256CanonicalRecord(macReceipt),
		macReceiptSignatureSha256: sha256CanonicalRecord(macGrantSig),
		approvedPlanSha256: draft.approvedPlanSha256,
		approvalRecordSha256: draft.approvalRecordSha256,
		rigExecutionIndex: execution.executionIndex,
		rigSupervisorInstanceNonce: H("rig-nonce"),
		rigSupervisorExecutableSha256: H("rig-supervisor"),
		replayLedgerLeafSha256: H("rig-replay-leaf"),
		signingPublicKeySha256: rigPublicKeySha256,
		receiptSequence: 0,
		acceptedAtMs: issuedAtMs + 1,
		issuedAtMs: issuedAtMs + 1,
		notAfterMs,
	};
	const rigAcceptBytesForSig = bytesOfCanonical(rigAccept);
	const rigAcceptSig = signRigReceipt({
		privatePkcs8Der: rigKey.privatePkcs8Der,
		publicRaw32: rigKey.publicRaw32,
		signedSchema: "rig-execution-acceptance/v1",
		signedBytes: rigAcceptBytesForSig,
	});

	const baseline: RigMeasureStartAckV1 = {
		schema: "rig-measure-start-ack/v1",
		executionSha256,
		measurementGrantSha256: grantSha256,
		macExecutionGrantReceiptSha256: sha256CanonicalRecord(macReceipt),
		rigExecutionAcceptanceSha256: sha256CanonicalRecord(rigAccept),
		approvedPlanSha256: draft.approvedPlanSha256,
		approvalRecordSha256: draft.approvalRecordSha256,
		childResponseSequence: 3,
		baselineBusyMs: 0,
		baselineAtLinuxNs: "1000",
		linuxClockId: H("linux-clock"),
		warmupCompletionAuthoritySha256: null,
		rigWarmupDrainedReceiptSha256: null,
		signingPublicKeySha256: rigPublicKeySha256,
		rigSupervisorInstanceNonce: H("rig-instance"),
		receiptSequence: 1,
		issuedAtMs: issuedAtMs + 2,
		notAfterMs,
	};
	const baselineBytesForSig = bytesOfCanonical(baseline);
	const baselineSig = signRigReceipt({
		privatePkcs8Der: rigKey.privatePkcs8Der,
		publicRaw32: rigKey.publicRaw32,
		signedSchema: "rig-measure-start-ack/v1",
		signedBytes: baselineBytesForSig,
	});

	const payloadSha256 = H("bulk-payload-schedule");
	const snapshotFrame = {
		schema: "server-loop-utilization/v1" as const,
		executionSha256,
		cellId,
		scenarioHash: draft.scenarioHash,
		cohortGrantSha256: null,
		cohortStartBarrierSha256: null,
		roleTokenCommitmentRootSha256: null,
		transport,
		repetitionKind,
		repetitionIndex,
		repetitionTotal,
		childPid: options?.childPid ?? 4242,
		childPgid: options?.childPgid ?? 4242,
		childInstanceNonce: H("child-nonce"),
		baselineBusyMs: 0,
		finalBusyMs: busyMs,
		busyMs,
		baselineAtLinuxNs: "1000",
		finalSnapshotAtLinuxNs: String(1000 + spanMs * 1_000_000),
		windowMs,
		linuxClockId: H("linux-clock"),
		allMeasuredSessionsClosed: true as const,
		bulkSourceCompletion: {
			schema: "bulk-source-completion/v1" as const,
			executionSha256,
			direction: "linux-to-mac" as const,
			serverRole: "bulk-source" as const,
			channelMapping: "server-opened-uni" as const,
			scheduledChunkCount: 1600 as const,
			chunksWritten: 1600 as const,
			chunkBytes: 65536 as const,
			bytesWritten: PHASE_A_DECLARED_MESSAGE_BYTES,
			payloadSha256,
			firstWriteAtLinuxNs: "1100",
			channelEndedAtLinuxNs: String(1000 + spanMs * 1_000_000),
			linuxClockId: H("linux-clock"),
			channelEnded: true as const,
		},
	};
	const snapshotBytes = bytesOfCanonical(snapshotFrame);
	const snapshotRetained = retainRawBytes(snapshotBytes);

	const snapReceipt: RigServerSnapshotReceiptV1 = {
		schema: "rig-server-snapshot-receipt/v1",
		executionSha256,
		measurementGrantSha256: grantSha256,
		macExecutionGrantReceiptSha256: sha256CanonicalRecord(macReceipt),
		rigExecutionAcceptanceSha256: sha256CanonicalRecord(rigAccept),
		cohortGrantSha256: null,
		cohortStartBarrierSha256: null,
		roleTokenCommitmentRootSha256: null,
		approvedPlanSha256: draft.approvedPlanSha256,
		approvalRecordSha256: draft.approvalRecordSha256,
		rigExecutionIndex: execution.executionIndex,
		rigSupervisorInstanceNonce: H("rig-nonce"),
		snapshotFrameSha256: snapshotRetained.sha256,
		snapshotFrameSize: snapshotRetained.size,
		childPid: snapshotFrame.childPid,
		childPgid: snapshotFrame.childPgid,
		childInstanceNonce: snapshotFrame.childInstanceNonce,
		serverEntrypointSha256: stagedLaunch.serverEntrypointSha256,
		bunSha256: stagedLaunch.bunSha256,
		addonSha256: stagedLaunch.addonSha256,
		childResponseSequence: 3,
		captureRequestSequence: 2,
		signingPublicKeySha256: rigPublicKeySha256,
		receiptSequence: 2,
		frameReceivedAtRigNs: String(1000 + spanMs * 1_000_000 + 50),
		issuedAtMs: issuedAtMs + 3,
		notAfterMs,
	};
	const snapReceiptBytesForSig = bytesOfCanonical(snapReceipt);
	const snapSig = signRigReceipt({
		privatePkcs8Der: rigKey.privatePkcs8Der,
		publicRaw32: rigKey.publicRaw32,
		signedSchema: "rig-server-snapshot-receipt/v1",
		signedBytes: snapReceiptBytesForSig,
	});

	const clientSeries = {
		schema: "bulk-sink-series/v1" as const,
		executionSha256,
		direction: "linux-to-mac" as const,
		channelMapping: "server-opened-uni" as const,
		scheduledChunkCount: 1600,
		receivedScheduleChunkCount: 1600,
		chunkBytes: 65536,
		bytesReceived: PHASE_A_DECLARED_MESSAGE_BYTES,
		payloadSha256,
		channelEofSeen: true,
		firstByteAtMacNs: "2000",
		lastByteAtMacNs: String(2000 + spanMs * 1_000_000),
		sampleUnit: "Mbps" as const,
		sampleCount: 1,
		delivered: PHASE_A_DECLARED_MESSAGE_BYTES,
		spanMs,
		samples: [(PHASE_A_DECLARED_MESSAGE_BYTES * 8 * 1000) / spanMs / 1_000_000],
	};
	const clientBytes = bytesOfCanonical(clientSeries);
	const clientRetained = retainRawBytes(clientBytes);

	const admission: MacMeasurementAdmissionReceiptV1 = {
		schema: "mac-measurement-admission/v1",
		executionSha256,
		measurementGrantSha256: grantSha256,
		macExecutionGrantReceiptSha256: sha256CanonicalRecord(macReceipt),
		rigExecutionAcceptanceSha256: sha256CanonicalRecord(rigAccept),
		rigExecutionAcceptanceSignatureSha256: sha256CanonicalRecord(rigAcceptSig),
		admittedClientSeriesSha256: clientRetained.sha256,
		rigMeasureStartAckSha256: sha256CanonicalRecord(baseline),
		rigMeasureStartAckSignatureSha256: sha256CanonicalRecord(baselineSig),
		rigBarrierAcceptanceSha256: null,
		rigBarrierAcceptanceSignatureSha256: null,
		rigServerSnapshotReceiptSha256: sha256CanonicalRecord(snapReceipt),
		rigServerSnapshotReceiptSignatureSha256: sha256CanonicalRecord(snapSig),
		snapshotFrameSha256: snapshotRetained.sha256,
		cohortGrantSha256: null,
		cohortStartBarrierSha256: null,
		approvedPlanSha256: draft.approvedPlanSha256,
		approvalRecordSha256: draft.approvalRecordSha256,
		campaignId,
		runId,
		executionIndex: execution.executionIndex,
		transport,
		sampleUnit: "Mbps",
		sampleCount: 1,
		delivered: PHASE_A_DECLARED_MESSAGE_BYTES,
		firstSampleAtMs: issuedAtMs + 10,
		lastSampleAtMs: issuedAtMs + 10 + spanMs,
		spanMs,
		frameAcceptedAtMs: issuedAtMs + 10 + spanMs + 1,
		macSupervisorInstanceNonce: execution.macSupervisorInstanceNonce,
		signingPublicKeySha256: macPublicKeySha256,
		receiptSequence: 1,
		issuedAtMs: issuedAtMs + 4,
		notAfterMs,
	};
	const admissionBytesForSig = bytesOfCanonical(admission);
	const admissionSig = signMacReceipt({
		privatePkcs8Der: macKey.privatePkcs8Der,
		publicRaw32: macKey.publicRaw32,
		signedSchema: "mac-measurement-admission/v1",
		signedBytes: admissionBytesForSig,
	});

	const draftBytes = bytesOfCanonical(draft);
	const grantBytes = bytesOfCanonical(grant);
	const macReceiptBytes = macReceiptBytesForSig;
	const macGrantSigBytes = bytesOfCanonical(macGrantSig);
	const admissionBytes = admissionBytesForSig;
	const admissionSigBytes = bytesOfCanonical(admissionSig);
	const rigAcceptBytes = rigAcceptBytesForSig;
	const rigAcceptSigBytes = bytesOfCanonical(rigAcceptSig);
	const baselineBytes = baselineBytesForSig;
	const baselineSigBytes = bytesOfCanonical(baselineSig);
	const snapReceiptBytes = snapReceiptBytesForSig;
	const snapSigBytes = bytesOfCanonical(snapSig);

	const observation: ServerObservationEvidenceV1 = {
		schema: "server-observation-evidence/v1",
		provenance:
			"server-child-observed/rig-supervisor-admitted/mac-supervisor-joined",
		workloadRolePlanInput: workloadRetained,
		stagedServerLaunchRecord: stagedRetained,
		executionDraftBase64: toBase64(draftBytes),
		executionDraftSha256: hexDigest(draftBytes),
		executionDraftSize: draftBytes.byteLength,
		measurementGrantBase64: toBase64(grantBytes),
		measurementGrantSha256: grantSha256,
		measurementGrantSize: grantBytes.byteLength,
		macExecutionGrantReceiptBase64: toBase64(macReceiptBytes),
		macExecutionGrantReceiptSha256: hexDigest(macReceiptBytes),
		macExecutionGrantReceiptSize: macReceiptBytes.byteLength,
		macExecutionGrantSignatureBase64: toBase64(macGrantSigBytes),
		macExecutionGrantSignatureSha256: hexDigest(macGrantSigBytes),
		macExecutionGrantSignatureSize: macGrantSigBytes.byteLength,
		macMeasurementAdmissionReceiptBase64: toBase64(admissionBytes),
		macMeasurementAdmissionReceiptSha256: hexDigest(admissionBytes),
		macMeasurementAdmissionReceiptSize: admissionBytes.byteLength,
		macMeasurementAdmissionSignatureBase64: toBase64(admissionSigBytes),
		macMeasurementAdmissionSignatureSha256: hexDigest(admissionSigBytes),
		macMeasurementAdmissionSignatureSize: admissionSigBytes.byteLength,
		admittedClientSeriesBase64: clientRetained.base64,
		admittedClientSeriesSha256: clientRetained.sha256,
		admittedClientSeriesSize: clientRetained.size,
		rigExecutionAcceptanceBase64: toBase64(rigAcceptBytes),
		rigExecutionAcceptanceSha256: hexDigest(rigAcceptBytes),
		rigExecutionAcceptanceSize: rigAcceptBytes.byteLength,
		rigExecutionAcceptanceSignatureBase64: toBase64(rigAcceptSigBytes),
		rigExecutionAcceptanceSignatureSha256: hexDigest(rigAcceptSigBytes),
		rigExecutionAcceptanceSignatureSize: rigAcceptSigBytes.byteLength,
		rigMeasureStartAckBase64: toBase64(baselineBytes),
		rigMeasureStartAckSha256: hexDigest(baselineBytes),
		rigMeasureStartAckSize: baselineBytes.byteLength,
		rigMeasureStartAckSignatureBase64: toBase64(baselineSigBytes),
		rigMeasureStartAckSignatureSha256: hexDigest(baselineSigBytes),
		rigMeasureStartAckSignatureSize: baselineSigBytes.byteLength,
		rigBarrierAcceptanceBase64: null,
		rigBarrierAcceptanceSha256: null,
		rigBarrierAcceptanceSize: null,
		rigBarrierAcceptanceSignatureBase64: null,
		rigBarrierAcceptanceSignatureSha256: null,
		rigBarrierAcceptanceSignatureSize: null,
		snapshotFrameBase64: snapshotRetained.base64,
		snapshotFrameSha256: snapshotRetained.sha256,
		snapshotFrameSize: snapshotRetained.size,
		rigServerSnapshotReceiptBase64: toBase64(snapReceiptBytes),
		rigServerSnapshotReceiptSha256: hexDigest(snapReceiptBytes),
		rigServerSnapshotReceiptSize: snapReceiptBytes.byteLength,
		rigServerSnapshotReceiptSignatureBase64: toBase64(snapSigBytes),
		rigServerSnapshotReceiptSignatureSha256: hexDigest(snapSigBytes),
		rigServerSnapshotReceiptSignatureSize: snapSigBytes.byteLength,
	};

	const attestation: ArmAttestationEvidenceV2 = {
		schema: "arm-attestation-evidence/v2",
		executionSha256,
		serverObservationEvidence: observation,
		cohortObservationEvidence: null,
	};

	return {
		trust: {
			macPublicRaw32: macKey.publicRaw32,
			rigPublicRaw32: rigKey.publicRaw32,
			macPublicKeySha256,
			rigPublicKeySha256,
		},
		macKey,
		rigKey,
		draft,
		execution,
		executionSha256,
		grant,
		attestation,
		observation,
		snapshotBusyMs: busyMs,
		snapshotWindowMs: windowMs,
		clientSeriesSha256: clientRetained.sha256,
		snapshotFrameSha256: snapshotRetained.sha256,
	};
}

/** Deep-clone JSON-compatible attestation for adversarial mutation tests. */
/**
 * The identity fields `buildRunArtifact` used to read when it minted its own
 * fixture attestation. The builder refuses without an attestation now (C4:
 * "zero placeholders ... fixture attestations"), so a test that exercises the
 * verdict/ledger/seal mechanics states one explicitly through this helper,
 * bound to the same run/cell/repetition identity the old default derived.
 */
export interface FixtureAttestationIdentity {
	readonly comparisonId: string;
	readonly runId: string;
	readonly transport: "ws" | "wt" | string;
	readonly cellId?: string;
	readonly cell?: { readonly cellId: string };
	readonly executionPurpose?: ExecutionPurpose;
	readonly repetitionKind?: RepetitionKind;
	readonly repetitionIndex?: number;
	readonly measuredRepetitionIndex?: number;
	readonly totalRepetitions?: number;
	readonly measuredRepetitionTotal?: number;
	readonly attestationEvidence?: ArmAttestationEvidenceV2;
}

export function fixtureAttestationFor(
	input: FixtureAttestationIdentity,
): ArmAttestationEvidenceV2 {
	const cellId = input.cellId ?? input.cell?.cellId;
	if (cellId === undefined) {
		throw new Error("fixtureAttestationFor: a cell identity is required");
	}
	return mintPhaseAAttestationFixture({
		executionPurpose: input.executionPurpose ?? "focused",
		repetitionKind: input.repetitionKind ?? "measured",
		repetitionIndex:
			input.measuredRepetitionIndex ?? input.repetitionIndex ?? 1,
		repetitionTotal:
			input.measuredRepetitionTotal ?? input.totalRepetitions ?? 1,
		transport: input.transport === "wt" ? "wt" : "ws",
		cellId,
		campaignId: input.comparisonId,
		runId: input.runId,
	}).attestation;
}

/** `input` with a fixture attestation added, unless it already states one. */
export function withFixtureAttestation<T extends FixtureAttestationIdentity>(
	input: T,
): T & { readonly attestationEvidence: ArmAttestationEvidenceV2 } {
	return {
		...input,
		attestationEvidence:
			input.attestationEvidence ?? fixtureAttestationFor(input),
	};
}

/**
 * A scripted rig's honest §5 RIG_EXECUTION_ACCEPTED answer, minted from the
 * exact request bytes the way the binary mints it: every digest in the
 * acceptance is computed from what the frame carried, and the record is
 * signed with the test rig key. Tests hand this to a scripted rig; production
 * only ever sees the binary's own.
 */
export function scriptedRigExecutionAcceptedAck(args: {
	readonly rigKeys: Ed25519KeyPairBytes;
	readonly request: Record<string, unknown>;
	readonly executionSha256: Sha256Hex;
	readonly responseSeq: number;
	readonly nowMs: number;
	readonly rigExecutionIndex?: number;
	readonly instanceNonceSha256?: Sha256Hex;
	readonly mutate?: (acceptance: Record<string, unknown>) => void;
}): Record<string, unknown> {
	const decode = (field: string): Uint8Array =>
		new Uint8Array(Buffer.from(args.request[field] as string, "base64"));
	const grant = decode("measurementGrantBase64");
	const receipt = decode("macExecutionGrantReceiptBase64");
	const signature = decode("macExecutionGrantSignatureBase64");
	const receiptRecord = JSON.parse(new TextDecoder().decode(receipt)) as {
		approvedPlanSha256?: string;
		approvalRecordSha256?: string;
		notAfterMs?: number;
	};
	const acceptance: Record<string, unknown> = {
		schema: "rig-execution-acceptance/v1",
		executionSha256: args.executionSha256,
		measurementGrantSha256: sha256HexOfBytes(grant),
		macExecutionGrantReceiptSha256: sha256HexOfBytes(receipt),
		macReceiptSignatureSha256: sha256HexOfBytes(signature),
		approvedPlanSha256: receiptRecord.approvedPlanSha256 ?? "e".repeat(64),
		approvalRecordSha256: receiptRecord.approvalRecordSha256 ?? "f".repeat(64),
		rigExecutionIndex: args.rigExecutionIndex ?? 1,
		rigSupervisorInstanceNonce: args.instanceNonceSha256 ?? "7".repeat(64),
		rigSupervisorExecutableSha256: "8".repeat(64),
		replayLedgerLeafSha256: sha256HexOfBytes(receipt),
		signingPublicKeySha256: args.rigKeys.publicKeySha256,
		receiptSequence: 1,
		acceptedAtMs: args.nowMs,
		issuedAtMs: args.nowMs,
		notAfterMs: receiptRecord.notAfterMs ?? args.nowMs + 600_000,
	};
	args.mutate?.(acceptance);
	const bytes = bytesOfCanonical(acceptance);
	const signed = signRigReceipt({
		privatePkcs8Der: args.rigKeys.privatePkcs8Der,
		publicRaw32: args.rigKeys.publicRaw32,
		signedSchema: "rig-execution-acceptance/v1",
		signedBytes: bytes,
	});
	return {
		schema: "rig-execution-accepted-ack/v1",
		responseSeq: args.responseSeq,
		ackRequestSeq: args.request.requestSeq as number,
		executionSha256: args.executionSha256,
		rigExecutionAcceptanceBase64: Buffer.from(bytes).toString("base64"),
		rigExecutionAcceptanceSignatureBase64: Buffer.from(
			bytesOfCanonical(signed),
		).toString("base64"),
	};
}

export function cloneAttestation(
	attestation: ArmAttestationEvidenceV2,
): ArmAttestationEvidenceV2 {
	return JSON.parse(JSON.stringify(attestation)) as ArmAttestationEvidenceV2;
}

export function replaceEmbeddedBase64Field(
	attestation: ArmAttestationEvidenceV2,
	field:
		| "measurementGrantBase64"
		| "macExecutionGrantReceiptBase64"
		| "admittedClientSeriesBase64"
		| "rigExecutionAcceptanceBase64"
		| "rigMeasureStartAckBase64"
		| "snapshotFrameBase64"
		| "rigServerSnapshotReceiptBase64"
		| "macMeasurementAdmissionReceiptBase64",
	replacementBase64: Base64,
): ArmAttestationEvidenceV2 {
	const next = cloneAttestation(attestation);
	const obs = next.serverObservationEvidence as unknown as Record<
		string,
		unknown
	>;
	const bytes = fromBase64(replacementBase64);
	if (!bytes) throw new Error("replacement base64 invalid");
	obs[field] = replacementBase64;
	const shaField = field.replace(/Base64$/, "Sha256");
	const sizeField = field.replace(/Base64$/, "Size");
	obs[shaField] = hexDigest(bytes);
	obs[sizeField] = bytes.byteLength;
	return next;
}

export function assertEd25519StillVerifies(
	publicRaw32: Uint8Array,
	message: Uint8Array,
	signatureBase64: Base64,
): boolean {
	const sig = fromBase64(signatureBase64);
	if (!sig || sig.byteLength !== 64) return false;
	return ed25519Verify(publicRaw32, message, sig);
}

// ---------------------------------------------------------------------------
// A scripted Mac supervisor process
//
// `MacCohortChannel` is the controller's client of the binary that alone holds
// the Mac key. Tests need something on the other end of the pipe that speaks
// the registered `mac-*` frames byte-for-byte and mints every record the real
// binary mints, from the same inputs, under a key the test generated. This is
// that peer. It is deliberately a *mint*, not a parrot: the grant embeds the
// presented manifest and topology after recomputing the root, the warmup
// manifest is built from the child bytes on the request, the barrier binds the
// digests of the records it was handed, the admission receipt binds what it
// retained, and the export assembles the 33-field observation itself and signs
// the C3 seven-field transcript. A test that wants a dishonest binary uses
// `mutate` to change one payload after the honest one was built.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

export interface ScriptedMacClock {
	readonly nowMs: () => number;
	readonly nowNs: () => NsString;
}

/** The cell parameters the real binary reads from its registry. */
export interface ScriptedMacGrantParameters {
	readonly transport: "ws" | "wt";
	readonly readinessDeadlineMs: number;
	readonly measuredDurationMs: 10000 | 30000;
	readonly messageBytes: 100 | 128;
	readonly expectedOfferedIngress: number;
}

/** The admitted client series the real binary retains from the legacy pipe. */
export interface ScriptedMacAdmittedSeries {
	readonly admittedClientSeriesSha256: Sha256Hex;
	readonly sampleUnit: "ms" | "Mbps" | "count";
	readonly sampleCount: number;
	readonly delivered: number;
	readonly firstSampleAtMs: number;
	readonly lastSampleAtMs: number;
	readonly spanMs: number;
}

export interface ScriptedMacBinaryOptions {
	readonly keys: Ed25519KeyPairBytes;
	readonly stagedRigPublicRaw32: Uint8Array;
	readonly clock: ScriptedMacClock;
	readonly receiptValidityMs: number;
	readonly macClockId: string;
	readonly instanceNonce: Sha256Hex;
	readonly executableSha256: Sha256Hex;
	readonly grant: ScriptedMacGrantParameters;
	readonly admittedSeries?: ScriptedMacAdmittedSeries;
	/** Change one honest payload before it is written; the negative tests' hook. */
	readonly mutate?: (schema: string, payload: Rec) => Rec;
}

export type ScriptedMacReply = Rec | "silence";

export interface MacWire {
	readonly controllerToMac: PassThrough;
	readonly macToController: PassThrough;
	readonly seen: Rec[];
}

/** The byte length of the frame starting at offset 0, or null if incomplete. */
function framedLength(buffer: Uint8Array): number | null {
	if (buffer.byteLength < 4) return null;
	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset,
		buffer.byteLength,
	);
	const headerLength = view.getUint32(0, false);
	if (buffer.byteLength < 4 + headerLength + 8) return null;
	const payloadLength = Number(view.getBigUint64(4 + headerLength, false));
	const total = 4 + headerLength + 8 + payloadLength + 32;
	return buffer.byteLength < total ? null : total;
}

/**
 * Attach a scripted Mac to a pipe pair. `respond` sees the exact decoded
 * request payload and returns the exact payload the Mac writes back.
 */
export function serveScriptedMac(
	respond: (request: Rec) => ScriptedMacReply,
): MacWire {
	const controllerToMac = new PassThrough();
	const macToController = new PassThrough();
	const seen: Rec[] = [];
	let pending = new Uint8Array(0);
	controllerToMac.on("data", (chunk: Buffer) => {
		const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
		merged.set(pending, 0);
		merged.set(new Uint8Array(chunk), pending.byteLength);
		pending = merged;
		for (;;) {
			const length = framedLength(pending);
			if (length === null) return;
			const frame = pending.slice(0, length);
			pending = pending.slice(length);
			const decoded = decodeRegisteredRemotePayload(frame);
			if (!decoded.ok) throw new Error(`scripted mac: ${decoded.code}`);
			seen.push(decoded.value.payload);
			const reply = respond(decoded.value.payload);
			if (reply === "silence") {
				macToController.end();
				return;
			}
			const encoded = encodeRegisteredRemotePayload(
				reply as Rec & { schema: string },
			);
			if (!encoded.ok) throw new Error(`scripted mac encode: ${encoded.code}`);
			macToController.write(Buffer.from(encoded.value));
		}
	});
	return { controllerToMac, macToController, seen };
}

interface RetainedBytes {
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
}

function retainedOf(bytes: Uint8Array): RetainedCanonicalBytesV1 {
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: toBase64(bytes),
		byteLength: bytes.byteLength,
		sha256: hexDigest(bytes),
	};
}

function b64Bytes(value: unknown, what: string): Uint8Array {
	if (typeof value !== "string")
		throw new Error(`scripted mac: ${what} missing`);
	const bytes = fromBase64(value);
	if (bytes === null) throw new Error(`scripted mac: ${what} base64`);
	return bytes;
}

function b64BytesOrNull(value: unknown, what: string): Uint8Array | null {
	return value === null ? null : b64Bytes(value, what);
}

function jsonOf(bytes: Uint8Array, what: string): unknown {
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) throw new Error(`scripted mac: ${what} is not canonical JSON`);
	return json.value;
}

/** One execution's session inside the scripted process. */
interface ScriptedMacSession {
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly receiptBytes: Uint8Array;
	cohortAttempt: number;
	grant: CohortGrantV1 | null;
	retained: Map<string, RetainedBytes>;
	warmupStartedAtMacNs: NsString | null;
	admission: CohortAdmissionReceiptV1 | null;
	exported: boolean;
}

export class ScriptedMacCohortBinary {
	private readonly options: ScriptedMacBinaryOptions;
	private responseSeq = 0;
	private receiptSequence = 0;
	private executionIndex = 0;
	private readonly sessions = new Map<Sha256Hex, ScriptedMacSession>();
	/** The last `mac-cohort-opened-ack/v1` this binary wrote, for tests. */
	lastOpenedAck: MacCohortOpenedAckV1 | null = null;

	constructor(options: ScriptedMacBinaryOptions) {
		this.options = options;
	}

	get publicRaw32(): Uint8Array {
		return this.options.keys.publicRaw32;
	}

	get signingPublicKeySha256(): Sha256Hex {
		return hexDigest(this.options.keys.publicRaw32);
	}

	/** The `respond` function `serveScriptedMac` drives. */
	get respond(): (request: Rec) => ScriptedMacReply {
		return (request) => this.answer(request);
	}

	private nextReceiptSequence(): number {
		this.receiptSequence += 1;
		return this.receiptSequence;
	}

	private sign(
		signedSchema: MacReceiptSignatureV1["signedSchema"],
		bytes: Uint8Array,
	): Uint8Array {
		return bytesOfCanonical(
			signMacReceipt({
				privatePkcs8Der: this.options.keys.privatePkcs8Der,
				publicRaw32: this.options.keys.publicRaw32,
				signedSchema,
				signedBytes: bytes,
			}),
		);
	}

	private session(request: Rec): ScriptedMacSession {
		const session = this.sessions.get(request.executionSha256 as Sha256Hex);
		if (session === undefined) {
			// The real binary keys sessions by execution; a frame naming one it
			// never opened describes another campaign's execution.
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		return session;
	}

	private retain(
		session: ScriptedMacSession,
		key: string,
		bytes: Uint8Array,
	): RetainedBytes {
		const record = { bytes, sha256: hexDigest(bytes) };
		session.retained.set(key, record);
		return record;
	}

	private need(session: ScriptedMacSession, key: string): RetainedBytes {
		const record = session.retained.get(key);
		if (record === undefined)
			throw new Error(`scripted mac: ${key} not retained`);
		return record;
	}

	/** Verify one rig record under the staged rig key and retain it. */
	private admitRig(
		session: ScriptedMacSession,
		key: string,
		signedSchema: RigReceiptSignatureV1["signedSchema"],
		bytes: Uint8Array,
		signatureBytes: Uint8Array,
	): void {
		const signature = parseRigReceiptSignature(
			jsonOf(signatureBytes, `${key} signature`),
		);
		if (!signature.ok || signature.value.signedSchema !== signedSchema) {
			throw new Error(`scripted mac: ${key} signature schema`);
		}
		const verified = verifyRigReceiptSignature({
			stagedRigPublicRaw32: this.options.stagedRigPublicRaw32,
			signedBytes: bytes,
			signature: signature.value,
		});
		if (!verified.ok) throw new Error(`scripted mac: ${key} does not verify`);
		this.retain(session, key, bytes);
		this.retain(session, `${key}Signature`, signatureBytes);
	}

	private reply(schema: string, request: Rec, body: Rec): Rec {
		const seq = this.responseSeq;
		this.responseSeq += 1;
		const honest: Rec = {
			schema,
			responseSeq: seq,
			ackRequestSeq: request.requestSeq as number,
			...body,
		};
		return this.options.mutate?.(schema, honest) ?? honest;
	}

	private refusal(request: Rec, code: string): Rec {
		const seq = this.responseSeq;
		this.responseSeq += 1;
		return {
			schema: "remote-supervisor-refusal/v1",
			responseSeq: seq,
			ackRequestSeq: request.requestSeq as number,
			executionSha256: (request.executionSha256 as string | undefined) ?? null,
			code,
			campaignStatus: "FAIL",
			terminal: true,
		};
	}

	answer(request: Rec): ScriptedMacReply {
		const schema = request.schema as string;
		const parsed =
			schema === "mac-open-execution-request/v1" ||
			schema === "mac-present-rig-observation-request/v1"
				? parsePhaseAMacRemotePayload(request)
				: parseCohortRemotePayload(request);
		if (!parsed.ok)
			throw new Error(
				`scripted mac: ${schema} ${parsed.message ?? parsed.code}`,
			);
		try {
			switch (schema) {
				case "mac-open-execution-request/v1":
					return this.openExecution(request);
				case "mac-open-cohort-request/v1":
					return this.openCohort(request);
				case "mac-present-rig-cohort-acceptance-request/v1":
					return this.presentRigCohortAcceptance(request);
				case "mac-issue-warmup-epoch-request/v1":
					return this.issueWarmupEpoch(request);
				case "mac-export-warmup-completion-manifest-request/v1":
					return this.exportWarmupManifest(request);
				case "mac-issue-start-barrier-request/v1":
					return this.issueStartBarrier(request);
				case "mac-present-rig-barrier-acceptance-request/v1":
					return this.presentRigBarrierAcceptance(request);
				case "mac-present-rig-observation-request/v1":
					return this.presentRigObservation(request);
				case "mac-export-cohort-evidence-request/v1":
					return this.exportCohortEvidence(request);
				default:
					return this.refusal(request, "TRUST_PROTOCOL");
			}
		} catch (error) {
			if (error instanceof ScriptedMacRefusal)
				return this.refusal(request, error.code);
			throw error;
		}
	}

	private openExecution(request: Rec): Rec {
		const draftBytes = b64Bytes(request.executionDraftBase64, "draft");
		if (hexDigest(draftBytes) !== request.executionDraftSha256) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const draft = parseCrossSupervisorExecutionDraft(
			jsonOf(draftBytes, "draft"),
		);
		if (!draft.ok) throw new ScriptedMacRefusal("TRUST_PROTOCOL");
		const issuedAtMs = this.options.clock.nowMs();
		const built = macConstructFinalExecution({
			draft: draft.value,
			executionIndex: this.executionIndex,
			macSupervisorInstanceNonce: this.options.instanceNonce,
			issuedAtMs,
			notAfterMs: issuedAtMs + this.options.receiptValidityMs,
			grantNonceSha256: sha256CanonicalRecord({
				instanceNonce: this.options.instanceNonce,
				executionIndex: this.executionIndex,
			}),
		});
		if (!built.ok) throw new ScriptedMacRefusal("TRUST_PROTOCOL");
		this.executionIndex += 1;
		const grantBytes = bytesOfCanonical(built.value.grant);
		const receipt: MacExecutionGrantReceiptV1 = {
			schema: "mac-execution-grant-receipt/v1",
			execution: built.value.execution,
			executionSha256: built.value.executionSha256,
			measurementGrantSha256: hexDigest(grantBytes),
			approvedPlanSha256: built.value.execution.approvedPlanSha256,
			approvalRecordSha256: built.value.execution.approvalRecordSha256,
			macSupervisorExecutableSha256: this.options.executableSha256,
			macSupervisorInstanceNonce: this.options.instanceNonce,
			signingPublicKeySha256: this.signingPublicKeySha256,
			receiptSequence: this.nextReceiptSequence(),
			issuedAtMs,
			notAfterMs: issuedAtMs + this.options.receiptValidityMs,
		};
		const receiptBytes = bytesOfCanonical(receipt);
		this.sessions.set(built.value.executionSha256, {
			execution: built.value.execution,
			executionSha256: built.value.executionSha256,
			measurementGrantSha256: hexDigest(grantBytes),
			receiptBytes,
			cohortAttempt: 0,
			grant: null,
			retained: new Map(),
			warmupStartedAtMacNs: null,
			admission: null,
			exported: false,
		});
		return this.reply("mac-execution-opened-ack/v1", request, {
			executionSha256: built.value.executionSha256,
			executionDraftBase64: request.executionDraftBase64,
			measurementGrantBase64: toBase64(grantBytes),
			macExecutionGrantReceiptBase64: toBase64(receiptBytes),
			macExecutionGrantSignatureBase64: toBase64(
				this.sign("mac-execution-grant-receipt/v1", receiptBytes),
			),
		});
	}

	private openCohort(request: Rec): Rec {
		const session = this.session(request);
		const manifestBytes = b64Bytes(
			request.tokenCommitmentLeafManifestBase64,
			"manifest",
		);
		if (
			hexDigest(manifestBytes) !== request.tokenCommitmentLeafManifestSha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const manifest = parseTokenCommitmentLeafManifest(
			jsonOf(manifestBytes, "manifest"),
		);
		if (!manifest.ok) throw new ScriptedMacRefusal("COHORT_PROTOCOL");
		const root = recomputeRootFromLeafManifest(manifest.value);
		if (
			!root.ok ||
			root.value !== manifest.value.roleTokenCommitmentRootSha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		if (manifest.value.executionSha256 !== session.executionSha256) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const workloadBytes = b64Bytes(
			request.workloadRolePlanInputBase64,
			"role plan",
		);
		if (
			hexDigest(workloadBytes) !== request.workloadRolePlanInputSha256 ||
			workloadBytes.byteLength !== request.workloadRolePlanInputSize
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const publishersJson = jsonOf(
			b64Bytes(request.publishersBase64, "publishers"),
			"publishers",
		);
		const shardsJson = jsonOf(
			b64Bytes(request.subscriberShardsBase64, "shards"),
			"shards",
		);
		if (!Array.isArray(publishersJson) || !Array.isArray(shardsJson)) {
			throw new ScriptedMacRefusal("COHORT_PROTOCOL");
		}
		const publishers: PublisherRoleGrantV1[] = [];
		for (const entry of publishersJson) {
			const parsedEntry = parsePublisherRoleGrant(entry);
			if (!parsedEntry.ok) throw new ScriptedMacRefusal("COHORT_PROTOCOL");
			publishers.push(parsedEntry.value);
		}
		const subscriberCount = manifest.value.leafCount - publishers.length;
		const subscriberShards: SubscriberShardV1[] = [];
		for (const entry of shardsJson) {
			const parsedEntry = parseSubscriberShard(entry, subscriberCount);
			if (!parsedEntry.ok) throw new ScriptedMacRefusal("COHORT_PROTOCOL");
			subscriberShards.push(parsedEntry.value);
		}
		if (subscriberShards.length !== COHORT_WORKER_COUNT) {
			throw new ScriptedMacRefusal("COHORT_PROTOCOL");
		}
		if (
			subscriberShards.reduce(
				(total, shard) => total + shard.subscriberCount,
				0,
			) !== subscriberCount
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		// The presented identity must be the opened execution's binding.
		if (
			request.scenarioHash !== session.execution.scenarioHash ||
			request.rolePlanHash !== session.execution.rolePlanHash ||
			request.workloadRolePlanInputSha256 !==
				session.execution.workloadRolePlanInputSha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		session.cohortAttempt += 1;
		const issuedAtMs = this.options.clock.nowMs();
		const params = this.options.grant;
		const grant: CohortGrantV1 = {
			schema: "cohort-grant/v1",
			execution: session.execution,
			executionSha256: session.executionSha256,
			macExecutionGrantReceiptSha256: hexDigest(session.receiptBytes),
			approvedPlanSha256: session.execution.approvedPlanSha256,
			approvalRecordSha256: session.execution.approvalRecordSha256,
			cohortId: manifest.value.cohortId,
			cohortAttempt: session.cohortAttempt,
			scenarioHash: request.scenarioHash as Sha256Hex,
			rolePlanHash: request.rolePlanHash as Sha256Hex,
			workloadRolePlanInputSha256:
				request.workloadRolePlanInputSha256 as Sha256Hex,
			transport: params.transport,
			publisherCount: publishers.length,
			subscriberCount,
			workerCount: 8,
			expectedProcessCount: publishers.length + COHORT_WORKER_COUNT,
			expectedSessionCount: publishers.length + subscriberCount,
			publishers,
			subscriberShards,
			tokenCommitmentLeafManifestSha256: hexDigest(manifestBytes),
			roleTokenCommitmentRootSha256:
				manifest.value.roleTokenCommitmentRootSha256,
			roleTokenCommitmentCount: manifest.value.leafCount,
			connectionRatePerSecond: 500,
			maxConnectionsInFlight: 200,
			readinessDeadlineMs: params.readinessDeadlineMs,
			inRepetitionWarmupMs: 5_000,
			sampleWindowMs: 1_000,
			measuredDurationMs: params.measuredDurationMs,
			drainDeadlineMs: 10_000,
			messageBytes: params.messageBytes,
			expectedOfferedIngress: params.expectedOfferedIngress,
			expectedExpandedDeliveries:
				params.expectedOfferedIngress * subscriberCount,
			macSupervisorInstanceNonce: this.options.instanceNonce,
			signingPublicKeySha256: this.signingPublicKeySha256,
			receiptSequence: this.nextReceiptSequence(),
			issuedAtMs,
			notAfterMs: issuedAtMs + this.options.receiptValidityMs,
		};
		const checked = parseCohortGrant(grant);
		if (!checked.ok)
			throw new Error(`scripted mac grant: ${checked.message ?? checked.code}`);
		const grantBytes = bytesOfCanonical(checked.value);
		const signatureBytes = this.sign("cohort-grant/v1", grantBytes);
		session.grant = checked.value;
		session.retained = new Map();
		this.retain(session, "workloadRolePlanInput", workloadBytes);
		this.retain(session, "tokenCommitmentLeafManifest", manifestBytes);
		this.retain(session, "cohortGrant", grantBytes);
		this.retain(session, "cohortGrantSignature", signatureBytes);
		const ack = this.reply("mac-cohort-opened-ack/v1", request, {
			executionSha256: session.executionSha256,
			cohortGrantBase64: toBase64(grantBytes),
			cohortGrantSha256: hexDigest(grantBytes),
			cohortGrantSignatureBase64: toBase64(signatureBytes),
		});
		this.lastOpenedAck = ack as unknown as MacCohortOpenedAckV1;
		return ack;
	}

	private presentRigCohortAcceptance(request: Rec): Rec {
		const session = this.session(request);
		const bytes = b64Bytes(request.rigCohortAcceptanceBase64, "acceptance");
		const acceptance = parseRigCohortAcceptance(jsonOf(bytes, "acceptance"));
		if (!acceptance.ok) throw new ScriptedMacRefusal("COHORT_PROTOCOL");
		const grant = this.need(session, "cohortGrant");
		if (acceptance.value.cohortGrantSha256 !== grant.sha256) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		this.admitRig(
			session,
			"rigCohortAcceptance",
			"rig-cohort-acceptance/v1",
			bytes,
			b64Bytes(
				request.rigCohortAcceptanceSignatureBase64,
				"acceptance signature",
			),
		);
		return this.reply("mac-rig-cohort-acceptance-ack/v1", request, {
			executionSha256: session.executionSha256,
			rigCohortAcceptanceSha256: hexDigest(bytes),
		});
	}

	private issueWarmupEpoch(request: Rec): Rec {
		const session = this.session(request);
		const grant = session.grant;
		if (grant === null) throw new ScriptedMacRefusal("COHORT_NOT_READY");
		if (
			request.cohortGrantSha256 !== this.need(session, "cohortGrant").sha256 ||
			request.rigCohortAcceptanceSha256 !==
				this.need(session, "rigCohortAcceptance").sha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const issuedAtMs = this.options.clock.nowMs();
		const epoch: CohortWarmupEpochV1 = {
			schema: "cohort-warmup-epoch/v1",
			executionSha256: session.executionSha256,
			cohortGrantSha256: this.need(session, "cohortGrant").sha256,
			cohortId: grant.cohortId,
			warmupNonce: sha256CanonicalRecord({
				warmup: this.need(session, "cohortGrant").sha256,
				sequence: this.receiptSequence + 1,
			}),
			durationMs: 5_000,
			warmupMessagesPerPublisher: 10,
			warmupIntervalMs: 500,
			expectedWarmupIngress: expectedWarmupIngress(grant.publisherCount),
			expectedWarmupDeliveries: expectedWarmupDeliveries(
				grant.publisherCount,
				grant.subscriberCount,
			),
			macSupervisorInstanceNonce: this.options.instanceNonce,
			signingPublicKeySha256: this.signingPublicKeySha256,
			receiptSequence: this.nextReceiptSequence(),
			issuedAtMs,
			notAfterMs: issuedAtMs + this.options.receiptValidityMs,
		};
		const checked = parseCohortWarmupEpoch(epoch);
		if (!checked.ok)
			throw new Error(`scripted mac epoch: ${checked.message ?? checked.code}`);
		const bytes = bytesOfCanonical(checked.value);
		const signatureBytes = this.sign("cohort-warmup-epoch/v1", bytes);
		this.retain(session, "cohortWarmupEpoch", bytes);
		this.retain(session, "cohortWarmupEpochSignature", signatureBytes);
		session.warmupStartedAtMacNs = this.options.clock.nowNs();
		return this.reply("mac-warmup-epoch-issued-ack/v1", request, {
			executionSha256: session.executionSha256,
			cohortWarmupEpochBase64: toBase64(bytes),
			cohortWarmupEpochSignatureBase64: toBase64(signatureBytes),
		});
	}

	private exportWarmupManifest(request: Rec): Rec {
		const session = this.session(request);
		const epoch = this.need(session, "cohortWarmupEpoch");
		if (request.cohortWarmupEpochSha256 !== epoch.sha256) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const completes = request.roleWarmupCompletesBase64 as readonly string[];
		const entries: RoleWarmupCompletionManifestEntryV1[] = [];
		let completedAt = 0n;
		for (const [order, base64] of completes.entries()) {
			const bytes = b64Bytes(base64, `warmup complete ${order}`);
			const frame = parseRoleWarmupComplete(
				jsonOf(bytes, `warmup complete ${order}`),
			);
			if (!frame.ok) throw new ScriptedMacRefusal("COHORT_PROTOCOL");
			if (
				frame.value.executionSha256 !== session.executionSha256 ||
				frame.value.cohortWarmupEpochSha256 !== epoch.sha256
			) {
				throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
			}
			const at = BigInt(frame.value.completedAtMacNs);
			if (at > completedAt) completedAt = at;
			entries.push({
				schema: "role-warmup-completion-manifest-entry/v1",
				order,
				childId: frame.value.childId,
				role: frame.value.role,
				roleWarmupComplete: retainedOf(bytes),
				roleWarmupCompleteSha256: hexDigest(bytes),
				offeredWarmupIngress: frame.value.offeredWarmupIngress,
				deliveredWarmupRecords: frame.value.deliveredWarmupRecords,
			});
		}
		const issuedAtMs = this.options.clock.nowMs();
		const manifest: RoleWarmupCompletionManifestV1 = {
			schema: "role-warmup-completion-manifest/v1",
			executionSha256: session.executionSha256,
			cohortGrantSha256: this.need(session, "cohortGrant").sha256,
			cohortWarmupEpochSha256: epoch.sha256,
			entryCount: entries.length,
			entries,
			allRoleChildrenComplete: true,
			completedAtMacNs: (completedAt + 100_000_000n).toString(),
			macSupervisorInstanceNonce: this.options.instanceNonce,
			signingPublicKeySha256: this.signingPublicKeySha256,
			receiptSequence: this.nextReceiptSequence(),
			issuedAtMs,
			notAfterMs: issuedAtMs + this.options.receiptValidityMs,
		};
		const checked = parseRoleWarmupCompletionManifest(manifest);
		if (!checked.ok) {
			throw new Error(
				`scripted mac manifest: ${checked.message ?? checked.code}`,
			);
		}
		const bytes = bytesOfCanonical(checked.value);
		const signatureBytes = this.sign(
			"role-warmup-completion-manifest/v1",
			bytes,
		);
		this.retain(session, "roleWarmupCompletionManifest", bytes);
		this.retain(
			session,
			"roleWarmupCompletionManifestSignature",
			signatureBytes,
		);
		return this.reply(
			"mac-warmup-completion-manifest-exported-ack/v1",
			request,
			{
				executionSha256: session.executionSha256,
				cohortWarmupEpochSha256: epoch.sha256,
				roleWarmupCompletionManifestBase64: toBase64(bytes),
				roleWarmupCompletionManifestSha256: hexDigest(bytes),
				roleWarmupCompletionManifestSize: bytes.byteLength,
				roleWarmupCompletionManifestSignatureBase64: toBase64(signatureBytes),
				roleWarmupCompletionManifestSignatureSha256: hexDigest(signatureBytes),
				entryCount: entries.length,
				terminalWarmupExport: true,
			},
		);
	}

	private issueStartBarrier(request: Rec): Rec {
		const session = this.session(request);
		const grant = session.grant;
		if (grant === null) throw new ScriptedMacRefusal("COHORT_NOT_READY");
		if (
			request.cohortGrantSha256 !== this.need(session, "cohortGrant").sha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		this.admitRig(
			session,
			"rigWarmupDrainedReceipt",
			"rig-warmup-drained-receipt/v1",
			b64Bytes(request.rigWarmupDrainedReceiptBase64, "drained receipt"),
			b64Bytes(
				request.rigWarmupDrainedReceiptSignatureBase64,
				"drained signature",
			),
		);
		this.admitRig(
			session,
			"rigMeasureStartAck",
			"rig-measure-start-ack/v1",
			b64Bytes(request.rigMeasureStartAckBase64, "measure-start ack"),
			b64Bytes(
				request.rigMeasureStartAckSignatureBase64,
				"measure-start signature",
			),
		);
		const manifest = this.need(session, "roleWarmupCompletionManifest");
		const manifestRecord = jsonOf(
			manifest.bytes,
			"manifest",
		) as RoleWarmupCompletionManifestV1;
		// Ordered as the binary mints it: warmup started when the epoch was
		// issued (`secure_fs.rs:21129`, retained at `:20864`), completed when
		// the manifest was minted (`:21133`), and the barrier itself is minted
		// now — which the binary refuses while now is before warmup completed
		// (`:21160`) — with the measured window armed 250 ms ahead (`:21162`).
		if (session.warmupStartedAtMacNs === null) {
			throw new ScriptedMacRefusal("COHORT_NOT_READY");
		}
		const warmupStarted = BigInt(session.warmupStartedAtMacNs);
		const warmupCompleted = BigInt(manifestRecord.completedAtMacNs);
		const mintedAt = BigInt(this.options.clock.nowNs());
		if (mintedAt < warmupCompleted) {
			throw new ScriptedMacRefusal("COHORT_PROTOCOL:mac clock");
		}
		const measureStart = mintedAt + 250_000_000n;
		const measureStop =
			measureStart + BigInt(grant.measuredDurationMs) * 1_000_000n;
		const issuedAtMs = this.options.clock.nowMs();
		const barrier: CohortStartBarrierV1 = {
			schema: "cohort-start-barrier/v1",
			executionSha256: session.executionSha256,
			cohortGrantSha256: this.need(session, "cohortGrant").sha256,
			rigCohortAcceptanceSha256: this.need(session, "rigCohortAcceptance")
				.sha256,
			rigMeasureStartAckSha256: this.need(session, "rigMeasureStartAck").sha256,
			roleWarmupCompletionManifestSha256: manifest.sha256,
			roleWarmupCompletionManifestSignatureSha256: this.need(
				session,
				"roleWarmupCompletionManifestSignature",
			).sha256,
			rigWarmupDrainedReceiptSha256: this.need(
				session,
				"rigWarmupDrainedReceipt",
			).sha256,
			cohortId: grant.cohortId,
			barrierNonce: sha256CanonicalRecord({
				barrier: manifest.sha256,
				completedAtMacNs: manifestRecord.completedAtMacNs,
				sequence: this.receiptSequence + 1,
			}),
			macClockId: this.options.macClockId,
			mintedAtMacNs: mintedAt.toString(),
			warmupStartedAtMacNs: warmupStarted.toString(),
			warmupCompletedAtMacNs: warmupCompleted.toString(),
			measureStartAtMacNs: measureStart.toString(),
			measureStopAtMacNs: measureStop.toString(),
			sampleWindowMs: 1_000,
			windowCount: (grant.measuredDurationMs / 1_000) as 10 | 30,
			measuredDurationMs: grant.measuredDurationMs,
			drainDeadlineMs: 10_000,
			macSupervisorInstanceNonce: this.options.instanceNonce,
			signingPublicKeySha256: this.signingPublicKeySha256,
			receiptSequence: this.nextReceiptSequence(),
			issuedAtMs,
			notAfterMs: issuedAtMs + this.options.receiptValidityMs,
		};
		const checked = parseCohortStartBarrier(barrier);
		if (!checked.ok)
			throw new Error(
				`scripted mac barrier: ${checked.message ?? checked.code}`,
			);
		const bytes = bytesOfCanonical(checked.value);
		const signatureBytes = this.sign("cohort-start-barrier/v1", bytes);
		this.retain(session, "cohortStartBarrier", bytes);
		this.retain(session, "cohortStartBarrierSignature", signatureBytes);
		return this.reply("mac-start-barrier-issued-ack/v1", request, {
			executionSha256: session.executionSha256,
			cohortStartBarrierBase64: toBase64(bytes),
			cohortStartBarrierSha256: hexDigest(bytes),
			cohortStartBarrierSignatureBase64: toBase64(signatureBytes),
		});
	}

	private presentRigBarrierAcceptance(request: Rec): Rec {
		const session = this.session(request);
		const bytes = b64Bytes(
			request.rigBarrierAcceptanceBase64,
			"barrier acceptance",
		);
		this.admitRig(
			session,
			"rigBarrierAcceptance",
			"rig-barrier-acceptance/v1",
			bytes,
			b64Bytes(
				request.rigBarrierAcceptanceSignatureBase64,
				"barrier acceptance signature",
			),
		);
		return this.reply("mac-rig-barrier-acceptance-ack/v1", request, {
			executionSha256: session.executionSha256,
			rigBarrierAcceptanceSha256: hexDigest(bytes),
			roleChildrenMayArm: true,
		});
	}

	private presentRigObservation(request: Rec): Rec {
		const session = this.session(request);
		const grant = session.grant;
		// The two records verified on earlier frames of this session.
		const cohortAcceptance = this.need(session, "rigCohortAcceptance");
		const drained = this.need(session, "rigWarmupDrainedReceipt");
		const acceptanceBytes = b64Bytes(
			request.rigExecutionAcceptanceBase64,
			"execution acceptance",
		);
		this.admitRig(
			session,
			"rigExecutionAcceptance",
			"rig-execution-acceptance/v1",
			acceptanceBytes,
			b64Bytes(
				request.rigExecutionAcceptanceSignatureBase64,
				"execution acceptance signature",
			),
		);
		const executionAcceptance = parseRigExecutionAcceptance(
			jsonOf(acceptanceBytes, "execution acceptance"),
		);
		if (!executionAcceptance.ok) throw new ScriptedMacRefusal("TRUST_PROTOCOL");
		const measureStartAckBytes = b64Bytes(
			request.rigMeasureStartAckBase64,
			"measure-start ack",
		);
		if (
			hexDigest(measureStartAckBytes) !==
			this.need(session, "rigMeasureStartAck").sha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const snapshotFrame = b64Bytes(
			request.snapshotFrameBase64,
			"snapshot frame",
		);
		const snapshotReceiptBytes = b64Bytes(
			request.rigServerSnapshotReceiptBase64,
			"snapshot receipt",
		);
		this.admitRig(
			session,
			"rigServerSnapshotReceipt",
			"rig-server-snapshot-receipt/v1",
			snapshotReceiptBytes,
			b64Bytes(
				request.rigServerSnapshotReceiptSignatureBase64,
				"snapshot receipt signature",
			),
		);
		this.retain(session, "snapshotFrame", snapshotFrame);
		const barrierAcceptance = b64BytesOrNull(
			request.rigBarrierAcceptanceBase64,
			"barrier acceptance",
		);
		if (barrierAcceptance !== null) {
			if (
				hexDigest(barrierAcceptance) !==
				this.need(session, "rigBarrierAcceptance").sha256
			) {
				throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
			}
		}
		const serverWarmupDrained = b64BytesOrNull(
			request.serverWarmupDrainedBase64,
			"server drained",
		);
		const serverStartBarrierAccepted = b64BytesOrNull(
			request.serverStartBarrierAcceptedBase64,
			"server barrier accepted",
		);
		const linuxObservation = b64BytesOrNull(
			request.linuxRelayObservationBase64,
			"linux observation",
		);
		const relayReceipt = b64BytesOrNull(
			request.rigRelayObservationReceiptBase64,
			"relay receipt",
		);
		const relayReceiptSignature = b64BytesOrNull(
			request.rigRelayObservationReceiptSignatureBase64,
			"relay receipt signature",
		);
		const derived = {
			orderedPartialManifest: b64BytesOrNull(
				request.orderedPartialManifestBase64,
				"manifest",
			),
			observedProcessProof: b64BytesOrNull(
				request.observedProcessProofBase64,
				"proof",
			),
			rateSeries: b64BytesOrNull(request.cohortRateSeriesBase64, "rate series"),
			ledger: b64BytesOrNull(request.cohortLedgerBase64, "ledger"),
			capacity: b64BytesOrNull(request.cohortCapacityBase64, "capacity"),
		};
		const issuedAtMs = this.options.clock.nowMs();
		const series = this.options.admittedSeries ?? {
			admittedClientSeriesSha256: sha256CanonicalRecord({
				series: session.executionSha256,
			}),
			sampleUnit: "count" as const,
			sampleCount: 1,
			delivered: 1,
			firstSampleAtMs: issuedAtMs,
			lastSampleAtMs: issuedAtMs,
			spanMs: 0,
		};
		const cohortGrantSha256 =
			grant === null ? null : this.need(session, "cohortGrant").sha256;
		const cohortStartBarrierSha256 =
			grant === null ? null : this.need(session, "cohortStartBarrier").sha256;
		const admission: MacMeasurementAdmissionReceiptV1 = {
			schema: "mac-measurement-admission/v1",
			executionSha256: session.executionSha256,
			measurementGrantSha256: session.measurementGrantSha256,
			macExecutionGrantReceiptSha256: hexDigest(session.receiptBytes),
			rigExecutionAcceptanceSha256: hexDigest(acceptanceBytes),
			rigExecutionAcceptanceSignatureSha256: this.need(
				session,
				"rigExecutionAcceptanceSignature",
			).sha256,
			admittedClientSeriesSha256: series.admittedClientSeriesSha256,
			rigMeasureStartAckSha256: hexDigest(measureStartAckBytes),
			rigMeasureStartAckSignatureSha256: this.need(
				session,
				"rigMeasureStartAckSignature",
			).sha256,
			rigBarrierAcceptanceSha256:
				barrierAcceptance === null ? null : hexDigest(barrierAcceptance),
			rigBarrierAcceptanceSignatureSha256:
				barrierAcceptance === null
					? null
					: this.need(session, "rigBarrierAcceptanceSignature").sha256,
			rigServerSnapshotReceiptSha256: hexDigest(snapshotReceiptBytes),
			rigServerSnapshotReceiptSignatureSha256: this.need(
				session,
				"rigServerSnapshotReceiptSignature",
			).sha256,
			snapshotFrameSha256: hexDigest(snapshotFrame),
			cohortGrantSha256,
			cohortStartBarrierSha256,
			approvedPlanSha256: session.execution.approvedPlanSha256,
			approvalRecordSha256: session.execution.approvalRecordSha256,
			campaignId: session.execution.campaignId,
			runId: session.execution.runId,
			executionIndex: session.execution.executionIndex,
			transport: session.execution.transport,
			sampleUnit: series.sampleUnit,
			sampleCount: series.sampleCount,
			delivered: series.delivered,
			firstSampleAtMs: series.firstSampleAtMs,
			lastSampleAtMs: series.lastSampleAtMs,
			spanMs: series.spanMs,
			frameAcceptedAtMs: issuedAtMs,
			macSupervisorInstanceNonce: this.options.instanceNonce,
			signingPublicKeySha256: this.signingPublicKeySha256,
			receiptSequence: this.nextReceiptSequence(),
			issuedAtMs,
			notAfterMs: issuedAtMs + this.options.receiptValidityMs,
		};
		const admissionBytes = bytesOfCanonical(admission);
		const admissionSignature = this.sign(
			"mac-measurement-admission/v1",
			admissionBytes,
		);
		this.retain(session, "macMeasurementAdmissionReceipt", admissionBytes);
		this.retain(
			session,
			"macMeasurementAdmissionSignature",
			admissionSignature,
		);

		let cohortAdmissionReceiptBase64: string | null = null;
		let cohortAdmissionSignatureBase64: string | null = null;
		if (grant !== null) {
			// A cohort execution: every nullable field must be present, and
			// the derived records are digested over the exact presented bytes.
			for (const [name, bytes] of Object.entries({
				serverWarmupDrained,
				serverStartBarrierAccepted,
				linuxObservation,
				relayReceipt,
				relayReceiptSignature,
				barrierAcceptance,
				...derived,
			})) {
				if (bytes === null) {
					throw new ScriptedMacRefusal(`CROSS_SUPERVISOR_MISMATCH:${name}`);
				}
			}
			this.admitRig(
				session,
				"rigRelayObservationReceipt",
				"rig-relay-observation-receipt/v1",
				relayReceipt as Uint8Array,
				relayReceiptSignature as Uint8Array,
			);
			this.retain(
				session,
				"serverWarmupDrained",
				serverWarmupDrained as Uint8Array,
			);
			this.retain(
				session,
				"serverStartBarrierAccepted",
				serverStartBarrierAccepted as Uint8Array,
			);
			this.retain(
				session,
				"linuxRelayObservation",
				linuxObservation as Uint8Array,
			);
			for (const [name, bytes] of Object.entries(derived)) {
				this.retain(session, name, bytes as Uint8Array);
			}
			const ledger = jsonOf(derived.ledger as Uint8Array, "ledger") as Rec;
			const digest = (key: string): Sha256Hex => this.need(session, key).sha256;
			const receipt: CohortAdmissionReceiptV1 = {
				schema: "cohort-admission-receipt/v1",
				executionSha256: session.executionSha256,
				measurementGrantSha256: session.measurementGrantSha256,
				macExecutionGrantReceiptSha256: hexDigest(session.receiptBytes),
				cohortGrantSha256: digest("cohortGrant"),
				cohortGrantSignatureSha256: digest("cohortGrantSignature"),
				rigCohortAcceptanceSha256: cohortAcceptance.sha256,
				rigCohortAcceptanceSignatureSha256: digest(
					"rigCohortAcceptanceSignature",
				),
				tokenCommitmentLeafManifestSha256: digest(
					"tokenCommitmentLeafManifest",
				),
				cohortWarmupEpochSha256: digest("cohortWarmupEpoch"),
				cohortWarmupEpochSignatureSha256: digest("cohortWarmupEpochSignature"),
				roleWarmupCompletionManifestSha256: digest(
					"roleWarmupCompletionManifest",
				),
				roleWarmupCompletionManifestSignatureSha256: digest(
					"roleWarmupCompletionManifestSignature",
				),
				serverWarmupDrainedSha256: digest("serverWarmupDrained"),
				rigWarmupDrainedReceiptSha256: drained.sha256,
				rigWarmupDrainedReceiptSignatureSha256: digest(
					"rigWarmupDrainedReceiptSignature",
				),
				rigMeasureStartAckSha256: digest("rigMeasureStartAck"),
				rigMeasureStartAckSignatureSha256: digest(
					"rigMeasureStartAckSignature",
				),
				cohortStartBarrierSha256: digest("cohortStartBarrier"),
				cohortStartBarrierSignatureSha256: digest(
					"cohortStartBarrierSignature",
				),
				rigBarrierAcceptanceSha256: digest("rigBarrierAcceptance"),
				rigBarrierAcceptanceSignatureSha256: digest(
					"rigBarrierAcceptanceSignature",
				),
				serverStartBarrierAcceptedSha256: digest("serverStartBarrierAccepted"),
				orderedPartialManifestSha256: digest("orderedPartialManifest"),
				observedProcessProofSha256: digest("observedProcessProof"),
				linuxRelayObservationSha256: digest("linuxRelayObservation"),
				rigRelayObservationReceiptSha256: digest("rigRelayObservationReceipt"),
				rigRelayObservationReceiptSignatureSha256: digest(
					"rigRelayObservationReceiptSignature",
				),
				rigServerSnapshotReceiptSha256: digest("rigServerSnapshotReceipt"),
				rigServerSnapshotReceiptSignatureSha256: digest(
					"rigServerSnapshotReceiptSignature",
				),
				macMeasurementAdmissionReceiptSha256: digest(
					"macMeasurementAdmissionReceipt",
				),
				macMeasurementAdmissionSignatureSha256: digest(
					"macMeasurementAdmissionSignature",
				),
				rateSeriesSha256: digest("rateSeries"),
				ledgerSha256: digest("ledger"),
				capacitySha256: digest("capacity"),
				approvedPlanSha256: session.execution.approvedPlanSha256,
				approvalRecordSha256: session.execution.approvalRecordSha256,
				publisherCount: grant.publisherCount,
				workerCount: 8,
				subscriberCount: grant.subscriberCount,
				offeredIngress: ledger.offeredIngress as number,
				serverAcceptedIngress: ledger.serverAcceptedIngress as number,
				linuxRelayWritesCompleted: ledger.linuxRelayWritesCompleted as number,
				delivered: ledger.delivered as number,
				macSupervisorInstanceNonce: this.options.instanceNonce,
				signingPublicKeySha256: this.signingPublicKeySha256,
				receiptSequence: this.nextReceiptSequence(),
				issuedAtMs,
				notAfterMs: issuedAtMs + this.options.receiptValidityMs,
			};
			const checked = parseCohortAdmissionReceipt(receipt);
			if (!checked.ok) {
				throw new Error(
					`scripted mac admission: ${checked.message ?? checked.code}`,
				);
			}
			const receiptBytes = bytesOfCanonical(checked.value);
			const receiptSignature = this.sign(
				"cohort-admission-receipt/v1",
				receiptBytes,
			);
			this.retain(session, "cohortAdmissionReceipt", receiptBytes);
			this.retain(session, "cohortAdmissionSignature", receiptSignature);
			session.admission = checked.value;
			cohortAdmissionReceiptBase64 = toBase64(receiptBytes);
			cohortAdmissionSignatureBase64 = toBase64(receiptSignature);
		}
		return this.reply("mac-measurement-admission-issued-ack/v1", request, {
			executionSha256: session.executionSha256,
			macMeasurementAdmissionReceiptBase64: toBase64(admissionBytes),
			macMeasurementAdmissionSignatureBase64: toBase64(admissionSignature),
			cohortAdmissionReceiptBase64,
			cohortAdmissionSignatureBase64,
		});
	}

	private exportCohortEvidence(request: Rec): Rec {
		const session = this.session(request);
		const grant = session.grant;
		if (grant === null || session.admission === null || session.exported) {
			throw new ScriptedMacRefusal("COHORT_NOT_READY");
		}
		if (
			request.cohortAdmissionReceiptSha256 !==
			this.need(session, "cohortAdmissionReceipt").sha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const bundle = jsonOf(
			b64Bytes(request.roleChildEvidenceBundleBase64, "role child bundle"),
			"role child bundle",
		) as Rec;
		if (
			bundle.schema !== "role-child-evidence-bundle/v1" ||
			bundle.executionSha256 !== session.executionSha256 ||
			bundle.cohortGrantSha256 !== this.need(session, "cohortGrant").sha256 ||
			bundle.cohortStartBarrierSha256 !==
				this.need(session, "cohortStartBarrier").sha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const retainedMember = (
			value: unknown,
			what: string,
		): RetainedCanonicalBytesV1 => {
			const record = value as RetainedCanonicalBytesV1;
			const bytes = b64Bytes(record.bytesBase64, what);
			if (
				hexDigest(bytes) !== record.sha256 ||
				bytes.byteLength !== record.byteLength
			) {
				throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
			}
			return retainedOf(bytes);
		};
		const members = (
			value: unknown,
			what: string,
		): RetainedCanonicalBytesV1[] =>
			(value as unknown[]).map((entry, index) =>
				retainedMember(entry, `${what} ${index}`),
			);
		const orderedPartialManifest = retainedMember(
			bundle.orderedPartialManifest,
			"manifest",
		);
		const observedProcessProof = retainedMember(
			bundle.observedProcessProof,
			"proof",
		);
		if (
			orderedPartialManifest.sha256 !==
				this.need(session, "orderedPartialManifest").sha256 ||
			observedProcessProof.sha256 !==
				this.need(session, "observedProcessProof").sha256
		) {
			throw new ScriptedMacRefusal("CROSS_SUPERVISOR_MISMATCH");
		}
		const member = (key: string): RetainedCanonicalBytesV1 =>
			retainedOf(this.need(session, key).bytes);
		const evidence: CohortObservationEvidenceV1 = {
			schema: "cohort-observation-evidence/v1",
			workloadRolePlanInput: member("workloadRolePlanInput"),
			cohortGrant: member("cohortGrant"),
			cohortGrantSignature: member("cohortGrantSignature"),
			rigCohortAcceptance: member("rigCohortAcceptance"),
			rigCohortAcceptanceSignature: member("rigCohortAcceptanceSignature"),
			tokenCommitmentLeafManifest: member("tokenCommitmentLeafManifest"),
			cohortWarmupEpoch: member("cohortWarmupEpoch"),
			cohortWarmupEpochSignature: member("cohortWarmupEpochSignature"),
			roleWarmupCompletionManifest: member("roleWarmupCompletionManifest"),
			roleWarmupCompletionManifestSignature: member(
				"roleWarmupCompletionManifestSignature",
			),
			roleWarmupCompletes: members(
				bundle.roleWarmupCompletes,
				"warmup complete",
			),
			serverWarmupDrained: member("serverWarmupDrained"),
			rigWarmupDrainedReceipt: member("rigWarmupDrainedReceipt"),
			rigWarmupDrainedReceiptSignature: member(
				"rigWarmupDrainedReceiptSignature",
			),
			rigMeasureStartAck: member("rigMeasureStartAck"),
			rigMeasureStartAckSignature: member("rigMeasureStartAckSignature"),
			cohortStartBarrier: member("cohortStartBarrier"),
			cohortStartBarrierSignature: member("cohortStartBarrierSignature"),
			rigBarrierAcceptance: member("rigBarrierAcceptance"),
			rigBarrierAcceptanceSignature: member("rigBarrierAcceptanceSignature"),
			serverStartBarrierAccepted: member("serverStartBarrierAccepted"),
			publisherPartials: members(bundle.publisherPartials, "publisher partial"),
			workerPartials: members(bundle.workerPartials, "worker partial"),
			orderedPartialManifest,
			observedProcessProof,
			linuxRelayObservation: member("linuxRelayObservation"),
			rigRelayObservationReceipt: member("rigRelayObservationReceipt"),
			rigRelayObservationReceiptSignature: member(
				"rigRelayObservationReceiptSignature",
			),
			rateSeries: member("rateSeries"),
			ledger: member("ledger"),
			capacity: member("capacity"),
			cohortAdmissionReceipt: member("cohortAdmissionReceipt"),
			cohortAdmissionSignature: member("cohortAdmissionSignature"),
		};
		const validated = parseCohortObservationEvidence({
			evidence,
			expectedPublisherCount: grant.publisherCount,
			expectedSubscriberCount: grant.subscriberCount,
			expectedExecutionSha256: session.executionSha256,
			expectedCohortGrantSha256: this.need(session, "cohortGrant").sha256,
		});
		if (!validated.ok) {
			throw new Error(
				`scripted mac export: ${validated.message ?? validated.code}`,
			);
		}
		const bytes = bytesOfCanonical(evidence);
		session.exported = true;
		const seq = this.responseSeq;
		this.responseSeq += 1;
		const unsigned = {
			schema: "mac-cohort-evidence-exported-ack/v1" as const,
			responseSeq: seq,
			ackRequestSeq: request.requestSeq as number,
			executionSha256: session.executionSha256,
			cohortObservationEvidenceSha256: hexDigest(bytes),
			cohortObservationEvidenceSize: bytes.byteLength,
			terminalExport: true as const,
		};
		const honest: MacCohortEvidenceExportedAckV1 = {
			...unsigned,
			cohortObservationEvidenceSignatureBase64: toBase64(
				ed25519Sign(
					this.options.keys.privatePkcs8Der,
					cohortExportAckSigningBytes(unsigned),
				),
			),
		};
		return (
			this.options.mutate?.(
				"mac-cohort-evidence-exported-ack/v1",
				honest as unknown as Rec,
			) ?? (honest as unknown as Rec)
		);
	}
}

/** A closed-code refusal the scripted binary raises from inside a transition. */
class ScriptedMacRefusal extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code.split(":")[0] as string;
	}
}

/** Sign one export-ack transcript with a caller's key; the forgery tests' tool. */
export function signCohortExportAck(
	unsigned: Omit<
		MacCohortEvidenceExportedAckV1,
		"cohortObservationEvidenceSignatureBase64"
	>,
	privatePkcs8Der: Uint8Array,
): MacCohortEvidenceExportedAckV1 {
	return {
		...unsigned,
		cohortObservationEvidenceSignatureBase64: toBase64(
			ed25519Sign(privatePkcs8Der, cohortExportAckSigningBytes(unsigned)),
		),
	};
}
