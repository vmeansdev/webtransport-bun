/**
 * Phase-A server observation / arm attestation evidence (plan §3.2, A3).
 *
 * Retains exact Mac/rig receipt bytes + signatures for offline verification.
 * Hash-only or unsigned production paths are refused.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import {
	bytesOfCanonical,
	ed25519Verify,
	fromBase64,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	PHASE_A_DECLARED_MESSAGE_BYTES,
	PHASE_A_DECLARED_MESSAGE_COUNT,
	sha256CanonicalRecord,
	signMacReceipt,
	signRigReceipt,
	toBase64,
	type Base64,
	type CrossSupervisorExecutionDraftV1,
	type CrossSupervisorExecutionV1,
	type Ed25519KeyPairBytes,
	type ExecutionPurpose,
	type MacExecutionGrantReceiptV1,
	type MacReceiptSignatureV1,
	type MeasurementGrantV1Extended,
	type ProtocolResult,
	type RepetitionKind,
	type RigExecutionAcceptanceV1,
	type RigReceiptSignatureV1,
	type Sha256Hex,
	verifyMacReceiptSignature,
	verifyRigReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import { requiresCohortObservationEvidence, type ArmKind } from "./evidence.ts";
import { isHex64 } from "./secure-fs.ts";
import type { CohortObservationEvidenceV1 } from "./cohort-protocol.ts";

export interface RetainedCanonicalBytesV1 {
	readonly schema: "retained-canonical-bytes/v1";
	readonly encoding: "base64";
	readonly mediaType: "application/json";
	readonly bytesBase64: Base64;
	readonly byteLength: number;
	readonly sha256: Sha256Hex;
}

export interface MacMeasurementAdmissionReceiptV1 {
	readonly schema: "mac-measurement-admission/v1";
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSignatureSha256: Sha256Hex;
	readonly admittedClientSeriesSha256: Sha256Hex;
	readonly rigMeasureStartAckSha256: Sha256Hex;
	readonly rigMeasureStartAckSignatureSha256: Sha256Hex;
	readonly rigBarrierAcceptanceSha256: Sha256Hex | null;
	readonly rigBarrierAcceptanceSignatureSha256: Sha256Hex | null;
	readonly rigServerSnapshotReceiptSha256: Sha256Hex;
	readonly rigServerSnapshotReceiptSignatureSha256: Sha256Hex;
	readonly snapshotFrameSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex | null;
	readonly cohortStartBarrierSha256: Sha256Hex | null;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly campaignId: string;
	readonly runId: string;
	readonly executionIndex: number;
	readonly transport: "ws" | "wt";
	readonly sampleUnit: "ms" | "Mbps" | "count";
	readonly sampleCount: number;
	readonly delivered: number;
	readonly firstSampleAtMs: number;
	readonly lastSampleAtMs: number;
	readonly spanMs: number;
	readonly frameAcceptedAtMs: number;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export interface RigMeasureStartAckV1 {
	readonly schema: "rig-measure-start-ack/v1";
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly baselineBusyMs: number;
	readonly baselineAtLinuxNs: string;
	readonly linuxClockId: Sha256Hex;
	readonly warmupCompletionSha256: Sha256Hex | null;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export interface RigServerSnapshotReceiptV1 {
	readonly schema: "rig-server-snapshot-receipt/v1";
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex | null;
	readonly cohortStartBarrierSha256: Sha256Hex | null;
	readonly roleTokenCommitmentRootSha256: Sha256Hex | null;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly rigExecutionIndex: number;
	readonly rigSupervisorInstanceNonce: Sha256Hex;
	readonly snapshotFrameSha256: Sha256Hex;
	readonly snapshotFrameSize: number;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: Sha256Hex;
	readonly serverEntrypointSha256: Sha256Hex;
	readonly bunSha256: Sha256Hex;
	readonly addonSha256: Sha256Hex;
	readonly childResponseSequence: number;
	readonly captureRequestSequence: number;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly frameReceivedAtRigNs: string;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export interface ServerObservationEvidenceV1 {
	readonly schema: "server-observation-evidence/v1";
	readonly provenance: "server-child-observed/rig-supervisor-admitted/mac-supervisor-joined";
	readonly workloadRolePlanInput: RetainedCanonicalBytesV1;
	readonly stagedServerLaunchRecord: RetainedCanonicalBytesV1;
	readonly executionDraftBase64: Base64;
	readonly executionDraftSha256: Sha256Hex;
	readonly executionDraftSize: number;
	readonly measurementGrantBase64: Base64;
	readonly measurementGrantSha256: Sha256Hex;
	readonly measurementGrantSize: number;
	readonly macExecutionGrantReceiptBase64: Base64;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSize: number;
	readonly macExecutionGrantSignatureBase64: Base64;
	readonly macExecutionGrantSignatureSha256: Sha256Hex;
	readonly macExecutionGrantSignatureSize: number;
	readonly macMeasurementAdmissionReceiptBase64: Base64;
	readonly macMeasurementAdmissionReceiptSha256: Sha256Hex;
	readonly macMeasurementAdmissionReceiptSize: number;
	readonly macMeasurementAdmissionSignatureBase64: Base64;
	readonly macMeasurementAdmissionSignatureSha256: Sha256Hex;
	readonly macMeasurementAdmissionSignatureSize: number;
	readonly admittedClientSeriesBase64: Base64;
	readonly admittedClientSeriesSha256: Sha256Hex;
	readonly admittedClientSeriesSize: number;
	readonly rigExecutionAcceptanceBase64: Base64;
	readonly rigExecutionAcceptanceSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSize: number;
	readonly rigExecutionAcceptanceSignatureBase64: Base64;
	readonly rigExecutionAcceptanceSignatureSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSignatureSize: number;
	readonly rigMeasureStartAckBase64: Base64;
	readonly rigMeasureStartAckSha256: Sha256Hex;
	readonly rigMeasureStartAckSize: number;
	readonly rigMeasureStartAckSignatureBase64: Base64;
	readonly rigMeasureStartAckSignatureSha256: Sha256Hex;
	readonly rigMeasureStartAckSignatureSize: number;
	readonly rigBarrierAcceptanceBase64: Base64 | null;
	readonly rigBarrierAcceptanceSha256: Sha256Hex | null;
	readonly rigBarrierAcceptanceSize: number | null;
	readonly rigBarrierAcceptanceSignatureBase64: Base64 | null;
	readonly rigBarrierAcceptanceSignatureSha256: Sha256Hex | null;
	readonly rigBarrierAcceptanceSignatureSize: number | null;
	readonly snapshotFrameBase64: Base64;
	readonly snapshotFrameSha256: Sha256Hex;
	readonly snapshotFrameSize: number;
	readonly rigServerSnapshotReceiptBase64: Base64;
	readonly rigServerSnapshotReceiptSha256: Sha256Hex;
	readonly rigServerSnapshotReceiptSize: number;
	readonly rigServerSnapshotReceiptSignatureBase64: Base64;
	readonly rigServerSnapshotReceiptSignatureSha256: Sha256Hex;
	readonly rigServerSnapshotReceiptSignatureSize: number;
}

export interface ArmAttestationEvidenceV2 {
	readonly schema: "arm-attestation-evidence/v2";
	readonly executionSha256: Sha256Hex;
	readonly serverObservationEvidence: ServerObservationEvidenceV1;
	/**
	 * B4 (§4.4): the exact cohort export the Mac supervisor assembled from its
	 * retained bytes. Phase A shapes have no cohort and set it to `null`; the
	 * six primary fanout cells require it non-null, which
	 * `requiresCohortObservationEvidence` decides and `buildRunArtifact`
	 * enforces. Nothing may synthesize it -- it is either the export or `null`.
	 */
	readonly cohortObservationEvidence: CohortObservationEvidenceV1 | null;
}

export type AttestationVerifyResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: string; readonly message: string };

const FAKE_DIGEST_RE = /^(0{64}|f{64})$/i;

function hexDigest(bytes: Uint8Array): Sha256Hex {
	return createHash("sha256").update(bytes).digest("hex");
}

function digestOfBase64(base64: Base64): ProtocolResult<{
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
	readonly size: number;
}> {
	const bytes = fromBase64(base64);
	if (!bytes) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "invalid base64" };
	}
	return {
		ok: true,
		value: { bytes, sha256: hexDigest(bytes), size: bytes.byteLength },
	};
}

export function retainCanonicalBytes(value: unknown): RetainedCanonicalBytesV1 {
	const bytes = bytesOfCanonical(value);
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: toBase64(bytes),
		byteLength: bytes.byteLength,
		sha256: hexDigest(bytes),
	};
}

export function retainRawBytes(bytes: Uint8Array): {
	readonly base64: Base64;
	readonly sha256: Sha256Hex;
	readonly size: number;
} {
	return {
		base64: toBase64(bytes),
		sha256: hexDigest(bytes),
		size: bytes.byteLength,
	};
}

function decodeCanonicalJson(base64: Base64): ProtocolResult<unknown> {
	const decoded = digestOfBase64(base64);
	if (!decoded.ok) return decoded;
	try {
		return {
			ok: true,
			value: JSON.parse(new TextDecoder().decode(decoded.value.bytes)),
		};
	} catch {
		return { ok: false, code: "TRUST_PROTOCOL", message: "json decode" };
	}
}

function requireMatchingDigest(
	label: string,
	base64: Base64,
	expectedSha: Sha256Hex,
	expectedSize: number,
): AttestationVerifyResult {
	if (FAKE_DIGEST_RE.test(expectedSha)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `${label}: fake digest`,
		};
	}
	const decoded = digestOfBase64(base64);
	if (!decoded.ok) {
		return {
			ok: false,
			code: decoded.code ?? "TRUST_PROTOCOL",
			message: decoded.message ?? "protocol",
		};
	}
	if (decoded.value.sha256 !== expectedSha) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `${label}: sha mismatch`,
		};
	}
	if (decoded.value.size !== expectedSize) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `${label}: size mismatch`,
		};
	}
	return { ok: true };
}

function verifyRetained(
	label: string,
	retained: RetainedCanonicalBytesV1,
): AttestationVerifyResult {
	if (retained.schema !== "retained-canonical-bytes/v1") {
		return { ok: false, code: "TRUST_PROTOCOL", message: `${label} schema` };
	}
	return requireMatchingDigest(
		label,
		retained.bytesBase64,
		retained.sha256,
		retained.byteLength,
	);
}

export interface AttestationTrustMaterial {
	readonly macPublicRaw32: Uint8Array;
	readonly rigPublicRaw32: Uint8Array;
	readonly macPublicKeySha256: Sha256Hex;
	readonly rigPublicKeySha256: Sha256Hex;
}

export function publicKeySha256(raw32: Uint8Array): Sha256Hex {
	return hexDigest(raw32);
}

/**
 * Offline verification of the Phase-A server observation graph.
 * Decodes every retained field, recomputes digests, and verifies Mac/rig
 * signatures against staged public keys.
 */
export function verifyServerObservationEvidence(
	evidence: ServerObservationEvidenceV1,
	trust: AttestationTrustMaterial,
	expected: {
		readonly executionSha256: Sha256Hex;
		readonly executionPurpose?: ExecutionPurpose;
		readonly cellId?: string;
		readonly transport?: "ws" | "wt";
		readonly repetitionKind?: RepetitionKind;
		readonly repetitionIndex?: number;
		readonly repetitionTotal?: number;
		readonly candidate?: string;
		readonly campaignId?: string;
		readonly approvedPlanSha256?: Sha256Hex;
		readonly approvalRecordSha256?: Sha256Hex;
	},
): AttestationVerifyResult {
	if (evidence.schema !== "server-observation-evidence/v1") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "evidence schema" };
	}
	if (
		evidence.provenance !==
		"server-child-observed/rig-supervisor-admitted/mac-supervisor-joined"
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "provenance" };
	}

	const retainedChecks = [
		verifyRetained("workloadRolePlanInput", evidence.workloadRolePlanInput),
		verifyRetained(
			"stagedServerLaunchRecord",
			evidence.stagedServerLaunchRecord,
		),
	];
	for (const check of retainedChecks) {
		if (!check.ok) return check;
	}

	const byteFields: Array<[string, Base64, Sha256Hex, number]> = [
		[
			"executionDraft",
			evidence.executionDraftBase64,
			evidence.executionDraftSha256,
			evidence.executionDraftSize,
		],
		[
			"measurementGrant",
			evidence.measurementGrantBase64,
			evidence.measurementGrantSha256,
			evidence.measurementGrantSize,
		],
		[
			"macExecutionGrantReceipt",
			evidence.macExecutionGrantReceiptBase64,
			evidence.macExecutionGrantReceiptSha256,
			evidence.macExecutionGrantReceiptSize,
		],
		[
			"macExecutionGrantSignature",
			evidence.macExecutionGrantSignatureBase64,
			evidence.macExecutionGrantSignatureSha256,
			evidence.macExecutionGrantSignatureSize,
		],
		[
			"macMeasurementAdmissionReceipt",
			evidence.macMeasurementAdmissionReceiptBase64,
			evidence.macMeasurementAdmissionReceiptSha256,
			evidence.macMeasurementAdmissionReceiptSize,
		],
		[
			"macMeasurementAdmissionSignature",
			evidence.macMeasurementAdmissionSignatureBase64,
			evidence.macMeasurementAdmissionSignatureSha256,
			evidence.macMeasurementAdmissionSignatureSize,
		],
		[
			"admittedClientSeries",
			evidence.admittedClientSeriesBase64,
			evidence.admittedClientSeriesSha256,
			evidence.admittedClientSeriesSize,
		],
		[
			"rigExecutionAcceptance",
			evidence.rigExecutionAcceptanceBase64,
			evidence.rigExecutionAcceptanceSha256,
			evidence.rigExecutionAcceptanceSize,
		],
		[
			"rigExecutionAcceptanceSignature",
			evidence.rigExecutionAcceptanceSignatureBase64,
			evidence.rigExecutionAcceptanceSignatureSha256,
			evidence.rigExecutionAcceptanceSignatureSize,
		],
		[
			"rigMeasureStartAck",
			evidence.rigMeasureStartAckBase64,
			evidence.rigMeasureStartAckSha256,
			evidence.rigMeasureStartAckSize,
		],
		[
			"rigMeasureStartAckSignature",
			evidence.rigMeasureStartAckSignatureBase64,
			evidence.rigMeasureStartAckSignatureSha256,
			evidence.rigMeasureStartAckSignatureSize,
		],
		[
			"snapshotFrame",
			evidence.snapshotFrameBase64,
			evidence.snapshotFrameSha256,
			evidence.snapshotFrameSize,
		],
		[
			"rigServerSnapshotReceipt",
			evidence.rigServerSnapshotReceiptBase64,
			evidence.rigServerSnapshotReceiptSha256,
			evidence.rigServerSnapshotReceiptSize,
		],
		[
			"rigServerSnapshotReceiptSignature",
			evidence.rigServerSnapshotReceiptSignatureBase64,
			evidence.rigServerSnapshotReceiptSignatureSha256,
			evidence.rigServerSnapshotReceiptSignatureSize,
		],
	];
	for (const [label, b64, sha, size] of byteFields) {
		const check = requireMatchingDigest(label, b64, sha, size);
		if (!check.ok) return check;
	}

	if (evidence.rigBarrierAcceptanceBase64 !== null) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "phase-a barrier must be null",
		};
	}

	const draftJson = decodeCanonicalJson(evidence.executionDraftBase64);
	if (!draftJson.ok)
		return {
			ok: false,
			code: draftJson.code ?? "TRUST_PROTOCOL",
			message: draftJson.message ?? "protocol",
		};
	const draft = draftJson.value as CrossSupervisorExecutionDraftV1;
	if (draft.schema !== "cross-supervisor-execution-draft/v1") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "draft schema" };
	}
	if (sha256CanonicalRecord(draft) !== evidence.executionDraftSha256) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "draft digest" };
	}

	const grantJson = decodeCanonicalJson(evidence.measurementGrantBase64);
	if (!grantJson.ok)
		return {
			ok: false,
			code: grantJson.code ?? "TRUST_PROTOCOL",
			message: grantJson.message ?? "protocol",
		};
	const grant = grantJson.value as MeasurementGrantV1Extended;
	if (sha256CanonicalRecord(grant) !== evidence.measurementGrantSha256) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "grant digest" };
	}

	const macReceiptJson = decodeCanonicalJson(
		evidence.macExecutionGrantReceiptBase64,
	);
	if (!macReceiptJson.ok) {
		return {
			ok: false,
			code: macReceiptJson.code ?? "TRUST_PROTOCOL",
			message: macReceiptJson.message ?? "protocol",
		};
	}
	const macReceipt = macReceiptJson.value as MacExecutionGrantReceiptV1;
	if (macReceipt.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "execution sha",
		};
	}
	if (macReceipt.measurementGrantSha256 !== evidence.measurementGrantSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "grant join",
		};
	}

	const macGrantSigJson = decodeCanonicalJson(
		evidence.macExecutionGrantSignatureBase64,
	);
	if (!macGrantSigJson.ok) {
		return {
			ok: false,
			code: macGrantSigJson.code ?? "TRUST_PROTOCOL",
			message: macGrantSigJson.message ?? "protocol",
		};
	}
	const macGrantSig = macGrantSigJson.value as MacReceiptSignatureV1;
	const macGrantVerify = verifyMacReceiptSignature({
		stagedMacPublicRaw32: trust.macPublicRaw32,
		signedBytes: fromBase64(evidence.macExecutionGrantReceiptBase64)!,
		signature: macGrantSig,
	});
	if (!macGrantVerify.ok) {
		return {
			ok: false,
			code: macGrantVerify.code ?? "TRUST_PROTOCOL",
			message: "mac grant sig",
		};
	}

	const rigAcceptJson = decodeCanonicalJson(
		evidence.rigExecutionAcceptanceBase64,
	);
	if (!rigAcceptJson.ok) {
		return {
			ok: false,
			code: rigAcceptJson.code ?? "TRUST_PROTOCOL",
			message: rigAcceptJson.message ?? "protocol",
		};
	}
	const rigAccept = rigAcceptJson.value as RigExecutionAcceptanceV1;
	if (rigAccept.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "rig acceptance execution",
		};
	}
	const rigAcceptSigJson = decodeCanonicalJson(
		evidence.rigExecutionAcceptanceSignatureBase64,
	);
	if (!rigAcceptSigJson.ok) {
		return {
			ok: false,
			code: rigAcceptSigJson.code ?? "TRUST_PROTOCOL",
			message: rigAcceptSigJson.message ?? "protocol",
		};
	}
	const rigAcceptSig = rigAcceptSigJson.value as RigReceiptSignatureV1;
	const rigAcceptVerify = verifyRigReceiptSignature({
		stagedRigPublicRaw32: trust.rigPublicRaw32,
		signedBytes: fromBase64(evidence.rigExecutionAcceptanceBase64)!,
		signature: rigAcceptSig,
	});
	if (!rigAcceptVerify.ok) {
		return {
			ok: false,
			code: rigAcceptVerify.code ?? "TRUST_PROTOCOL",
			message: "rig acceptance sig",
		};
	}

	const baselineJson = decodeCanonicalJson(evidence.rigMeasureStartAckBase64);
	if (!baselineJson.ok) {
		return {
			ok: false,
			code: baselineJson.code ?? "TRUST_PROTOCOL",
			message: baselineJson.message ?? "protocol",
		};
	}
	const baseline = baselineJson.value as RigMeasureStartAckV1;
	if (baseline.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "baseline execution",
		};
	}
	const baselineSigJson = decodeCanonicalJson(
		evidence.rigMeasureStartAckSignatureBase64,
	);
	if (!baselineSigJson.ok) {
		return {
			ok: false,
			code: baselineSigJson.code ?? "TRUST_PROTOCOL",
			message: baselineSigJson.message ?? "protocol",
		};
	}
	const baselineSig = baselineSigJson.value as RigReceiptSignatureV1;
	const baselineVerify = verifyRigReceiptSignature({
		stagedRigPublicRaw32: trust.rigPublicRaw32,
		signedBytes: fromBase64(evidence.rigMeasureStartAckBase64)!,
		signature: baselineSig,
	});
	if (!baselineVerify.ok) {
		return {
			ok: false,
			code: baselineVerify.code ?? "TRUST_PROTOCOL",
			message: "baseline sig",
		};
	}

	const snapReceiptJson = decodeCanonicalJson(
		evidence.rigServerSnapshotReceiptBase64,
	);
	if (!snapReceiptJson.ok) {
		return {
			ok: false,
			code: snapReceiptJson.code ?? "TRUST_PROTOCOL",
			message: snapReceiptJson.message ?? "protocol",
		};
	}
	const snapReceipt = snapReceiptJson.value as RigServerSnapshotReceiptV1;
	if (snapReceipt.snapshotFrameSha256 !== evidence.snapshotFrameSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "snapshot frame join",
		};
	}
	if (snapReceipt.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "snapshot execution",
		};
	}
	const snapSigJson = decodeCanonicalJson(
		evidence.rigServerSnapshotReceiptSignatureBase64,
	);
	if (!snapSigJson.ok) {
		return {
			ok: false,
			code: snapSigJson.code ?? "TRUST_PROTOCOL",
			message: snapSigJson.message ?? "protocol",
		};
	}
	const snapSig = snapSigJson.value as RigReceiptSignatureV1;
	const snapVerify = verifyRigReceiptSignature({
		stagedRigPublicRaw32: trust.rigPublicRaw32,
		signedBytes: fromBase64(evidence.rigServerSnapshotReceiptBase64)!,
		signature: snapSig,
	});
	if (!snapVerify.ok) {
		return {
			ok: false,
			code: snapVerify.code ?? "TRUST_PROTOCOL",
			message: "snapshot sig",
		};
	}

	const admissionJson = decodeCanonicalJson(
		evidence.macMeasurementAdmissionReceiptBase64,
	);
	if (!admissionJson.ok) {
		return {
			ok: false,
			code: admissionJson.code ?? "TRUST_PROTOCOL",
			message: admissionJson.message ?? "protocol",
		};
	}
	const admission = admissionJson.value as MacMeasurementAdmissionReceiptV1;
	if (admission.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "admission execution",
		};
	}
	if (
		admission.admittedClientSeriesSha256 !== evidence.admittedClientSeriesSha256
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "client series join",
		};
	}
	if (admission.snapshotFrameSha256 !== evidence.snapshotFrameSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "admission snapshot join",
		};
	}
	if (
		admission.rigExecutionAcceptanceSha256 !==
			evidence.rigExecutionAcceptanceSha256 ||
		admission.rigMeasureStartAckSha256 !== evidence.rigMeasureStartAckSha256 ||
		admission.rigServerSnapshotReceiptSha256 !==
			evidence.rigServerSnapshotReceiptSha256
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "admission rig joins",
		};
	}
	const admissionSigJson = decodeCanonicalJson(
		evidence.macMeasurementAdmissionSignatureBase64,
	);
	if (!admissionSigJson.ok) {
		return {
			ok: false,
			code: admissionSigJson.code ?? "TRUST_PROTOCOL",
			message: admissionSigJson.message ?? "protocol",
		};
	}
	const admissionSig = admissionSigJson.value as MacReceiptSignatureV1;
	const admissionVerify = verifyMacReceiptSignature({
		stagedMacPublicRaw32: trust.macPublicRaw32,
		signedBytes: fromBase64(evidence.macMeasurementAdmissionReceiptBase64)!,
		signature: admissionSig,
	});
	if (!admissionVerify.ok) {
		return {
			ok: false,
			code: admissionVerify.code ?? "TRUST_PROTOCOL",
			message: "admission sig",
		};
	}

	const execution = macReceipt.execution;
	if (sha256CanonicalRecord(execution) !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "embedded execution digest",
		};
	}
	if (
		expected.executionPurpose !== undefined &&
		execution.executionPurpose !== expected.executionPurpose
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "purpose",
		};
	}
	if (expected.cellId !== undefined && execution.cellId !== expected.cellId) {
		return { ok: false, code: "CROSS_SUPERVISOR_MISMATCH", message: "cellId" };
	}
	if (
		expected.transport !== undefined &&
		execution.transport !== expected.transport
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "transport",
		};
	}
	if (
		expected.repetitionKind !== undefined &&
		execution.repetitionKind !== expected.repetitionKind
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "repetitionKind",
		};
	}
	if (
		expected.repetitionIndex !== undefined &&
		execution.repetitionIndex !== expected.repetitionIndex
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "repetitionIndex",
		};
	}
	if (
		expected.repetitionTotal !== undefined &&
		execution.repetitionTotal !== expected.repetitionTotal
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "repetitionTotal",
		};
	}
	if (
		expected.candidate !== undefined &&
		execution.candidate !== expected.candidate
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "candidate",
		};
	}
	if (
		expected.campaignId !== undefined &&
		execution.campaignId !== expected.campaignId
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "campaignId",
		};
	}
	if (
		expected.approvedPlanSha256 !== undefined &&
		execution.approvedPlanSha256 !== expected.approvedPlanSha256
	) {
		return {
			ok: false,
			code: "APPROVAL_IDENTITY_MISMATCH",
			message: "approvedPlan",
		};
	}
	if (
		expected.approvalRecordSha256 !== undefined &&
		execution.approvalRecordSha256 !== expected.approvalRecordSha256
	) {
		return {
			ok: false,
			code: "APPROVAL_IDENTITY_MISMATCH",
			message: "approvalRecord",
		};
	}

	if (
		snapReceipt.childPid <= 0 ||
		snapReceipt.childPgid <= 0 ||
		!isHex64(snapReceipt.childInstanceNonce)
	) {
		return {
			ok: false,
			code: "CHILD_LIFECYCLE",
			message: "child identity",
		};
	}

	// Phase-A bulk completion: client series and grant declarations must match.
	if (
		grant.declaredMessageCount !== PHASE_A_DECLARED_MESSAGE_COUNT ||
		grant.declaredMessageBytes !== PHASE_A_DECLARED_MESSAGE_BYTES
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "phase-a declaration",
		};
	}
	if (admission.delivered !== PHASE_A_DECLARED_MESSAGE_BYTES) {
		return {
			ok: false,
			code: "MEASUREMENT_WINDOW",
			message: "delivered bytes",
		};
	}
	if (!(admission.spanMs > 0) || admission.sampleCount !== 1) {
		return {
			ok: false,
			code: "MEASUREMENT_WINDOW",
			message: "span/sampleCount",
		};
	}

	return { ok: true };
}

/**
 * Re-derive every retained member of a cohort export.
 *
 * This is a byte-level check only: each `retained-canonical-bytes/v1` member
 * must hash and size to what it claims. Reconstructing the cohort's *meaning*
 * -- token commitment root, ledger, rate series, origin conservation -- is
 * `reconstructCohortEvidenceOffline` in verify-artifact, which owns the
 * frozen-topology rules this module has no business restating.
 */
function verifyRetainedCohortMembers(
	cohort: CohortObservationEvidenceV1,
): AttestationVerifyResult {
	if (cohort.schema !== "cohort-observation-evidence/v1") {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: "cohort evidence schema",
		};
	}
	const checkMember = (
		label: string,
		value: unknown,
	): AttestationVerifyResult => {
		if (typeof value !== "object" || value === null) return { ok: true };
		if (
			(value as { schema?: unknown }).schema !== "retained-canonical-bytes/v1"
		)
			return { ok: true };
		return verifyRetained(label, value as RetainedCanonicalBytesV1);
	};
	for (const [key, value] of Object.entries(cohort)) {
		if (Array.isArray(value)) {
			for (const [i, member] of value.entries()) {
				const check = checkMember(
					`cohortObservationEvidence.${key}[${i}]`,
					member,
				);
				if (!check.ok) return check;
			}
			continue;
		}
		const check = checkMember(`cohortObservationEvidence.${key}`, value);
		if (!check.ok) return check;
	}
	return { ok: true };
}

/**
 * Verify one arm's attestation graph against the staged supervisor keys.
 *
 * The cohort is not a Phase-A/Phase-B toggle the caller may assert: the arm
 * identity decides it through `requiresCohortObservationEvidence`, the one
 * source of truth `buildRunArtifact` and the artifact verifier already use.
 * Both directions refuse -- a cohort cell whose attestation carries none, and
 * a non-cohort arm carrying one.
 */
export function verifyArmAttestationEvidence(
	attestation: ArmAttestationEvidenceV2,
	trust: AttestationTrustMaterial,
	expected: Parameters<typeof verifyServerObservationEvidence>[2] & {
		readonly cellId: string;
		readonly armKind: ArmKind;
	},
): AttestationVerifyResult {
	if (attestation.schema !== "arm-attestation-evidence/v2") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "attestation schema" };
	}
	const cohortRequired = requiresCohortObservationEvidence(
		expected.cellId,
		expected.armKind,
	);
	const cohort = attestation.cohortObservationEvidence;
	if (cohortRequired && cohort === null) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `${expected.cellId}/${expected.armKind} runs a cohort and its attestation carries none`,
		};
	}
	if (!cohortRequired && cohort !== null) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `${expected.cellId}/${expected.armKind} runs no cohort yet its attestation carries one`,
		};
	}
	if (cohort !== null) {
		const cohortCheck = verifyRetainedCohortMembers(cohort);
		if (!cohortCheck.ok) return cohortCheck;
	}
	if (attestation.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "attestation execution",
		};
	}
	return verifyServerObservationEvidence(
		attestation.serverObservationEvidence,
		trust,
		expected,
	);
}

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
		baselineBusyMs: 0,
		baselineAtLinuxNs: "1000",
		linuxClockId: H("linux-clock"),
		warmupCompletionSha256: null,
		signingPublicKeySha256: rigPublicKeySha256,
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

export { canonicalJson, FAKE_DIGEST_RE };
