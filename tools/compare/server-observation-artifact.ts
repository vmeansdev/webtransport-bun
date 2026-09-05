/**
 * Phase-A server observation / arm attestation evidence (plan §3.2, A3).
 *
 * Retains exact Mac/rig receipt bytes + signatures for offline verification.
 * Hash-only or unsigned production paths are refused.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import {
	type CohortObservationEvidenceV1,
	cohortCellCardinality,
	cohortCellGrantParameters,
} from "./cohort-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	type CrossSupervisorExecutionDraftV1,
	type ExecutionPurpose,
	fromBase64,
	type MacExecutionGrantReceiptV1,
	type MacReceiptSignatureV1,
	type MeasurementGrantV1Extended,
	PHASE_A_DECLARED_MESSAGE_BYTES,
	PHASE_A_DECLARED_MESSAGE_COUNT,
	type ProtocolResult,
	type RepetitionKind,
	type RigExecutionAcceptanceV1,
	type RigReceiptSignatureV1,
	type Sha256Hex,
	sha256CanonicalRecord,
	toBase64,
	verifyMacReceiptSignature,
	verifyRigReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import {
	type ArmKind,
	cohortCellForArm,
	requiresCohortObservationEvidence,
} from "./evidence.ts";
import { isHex64 } from "./secure-fs.ts";

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

/**
 * The rig's signed Linux baseline, and the TS half of a codec whose Rust half
 * is `secure_fs::cohort::rig`'s `finish_warmup` mint.
 *
 * Design §2.11 settled the key set. It is not the plan's literal record:
 * `responseSeq`/`ackRequestSeq` (plan 861-862) are frame envelope fields on a
 * record that travels *inside* `rig-measure-started-ack/v1`, so they are a
 * plan defect and are absent; the five binding digests the Rust adds are what
 * make the receipt joinable offline and are present. Three fields moved:
 *
 * - `childResponseSequence` — the server child's own FD-4 position at the
 *   instant the baseline was read, sourced from the rig's `ServerChildChannel`
 *   counter and never from the child. Without it a baseline from frame 3 and
 *   one from a replayed frame 3' are indistinguishable in the receipt.
 * - `rigSupervisorInstanceNonce` — every other rig receipt carries it; its
 *   absence is the one gap that would let a second rig instance's ack be bound
 *   into a barrier.
 * - `warmupCompletionSha256` split into the plan's two fields. They are not
 *   synonyms: `warmupCompletionAuthoritySha256` is the Mac's signed manifest,
 *   `rigWarmupDrainedReceiptSha256` is the rig's own receipt over the Linux
 *   drain. Collapsing them loses the ability to show that the rig saw the
 *   Linux side drain, which is what `LINUX_BASELINE` asserts.
 *
 * `cohort-start-barrier/v1` binds this record's digest and the offline
 * verifier recomputes it, so every one of these choices is load-bearing.
 */
export interface RigMeasureStartAckV1 {
	readonly schema: "rig-measure-start-ack/v1";
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly childResponseSequence: number;
	readonly baselineBusyMs: number;
	readonly baselineAtLinuxNs: string;
	readonly linuxClockId: Sha256Hex;
	readonly warmupCompletionAuthoritySha256: Sha256Hex | null;
	readonly rigWarmupDrainedReceiptSha256: Sha256Hex | null;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly rigSupervisorInstanceNonce: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

/**
 * The exact sorted key set §2.11 settled, named once so the Rust mint and this
 * interface cannot drift apart silently.
 */
export const RIG_MEASURE_START_ACK_KEYS: readonly string[] = [
	"approvalRecordSha256",
	"approvedPlanSha256",
	"baselineAtLinuxNs",
	"baselineBusyMs",
	"childResponseSequence",
	"executionSha256",
	"issuedAtMs",
	"linuxClockId",
	"macExecutionGrantReceiptSha256",
	"measurementGrantSha256",
	"notAfterMs",
	"receiptSequence",
	"rigExecutionAcceptanceSha256",
	"rigSupervisorInstanceNonce",
	"rigWarmupDrainedReceiptSha256",
	"schema",
	"signingPublicKeySha256",
	"warmupCompletionAuthoritySha256",
];

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
		/**
		 * With `cellId`, decides whether this arm runs a cohort
		 * (`requiresCohortObservationEvidence`) and so which declaration the
		 * execution must have opened under.
		 */
		readonly armKind?: ArmKind;
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
	// §2.11's key set, checked rather than assumed. The cast below is the only
	// place this record enters the verifier, and a record with an extra or a
	// missing key is a different record wearing this one's digest -- which is
	// exactly what `cohort-start-barrier/v1` binds.
	const baselineKeys = Object.keys(
		baselineJson.value as Record<string, unknown>,
	).sort();
	if (
		baselineKeys.length !== RIG_MEASURE_START_ACK_KEYS.length ||
		baselineKeys.some((key, index) => key !== RIG_MEASURE_START_ACK_KEYS[index])
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "baseline key set",
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

	// The execution's declaration names the contract the grant and the admitted
	// series are held to: the Phase-A bulk transfer (plan 2200-2208), or the
	// fanout expansion admitted as a count series over the cell's 1 s windows
	// (plan 2142). Which of the two the arm must have opened under is the arm
	// identity's decision (`cohortCellForArm`), never the record's own word.
	const declaresFanout =
		execution.grantDeclaration === "fanout-expanded-deliveries";
	if (expected.cellId !== undefined && expected.armKind !== undefined) {
		const cohortRequired = requiresCohortObservationEvidence(
			expected.cellId,
			expected.armKind,
		);
		if (cohortRequired !== declaresFanout) {
			return {
				ok: false,
				code: "COHORT_PROTOCOL",
				message: declaresFanout
					? "fanout declaration on an arm that runs no cohort"
					: "phase-a declaration on a cohort arm",
			};
		}
	}
	if (declaresFanout) {
		const cohortCell = cohortCellForArm({
			cellId: execution.cellId,
			armKind: execution.armKind,
		});
		if (cohortCell === null) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message: "fanout declaration",
			};
		}
		const cardinality = cohortCellCardinality(cohortCell);
		const parameters = cohortCellGrantParameters(cohortCell);
		if (
			grant.declaredMessageCount !== cardinality.expandedDeliveries ||
			grant.declaredMessageBytes !== parameters.messageBytes
		) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message: "fanout declaration",
			};
		}
		if (
			admission.sampleUnit !== "count" ||
			admission.sampleCount !== parameters.measuredDurationMs / 1000 ||
			admission.spanMs !== parameters.measuredDurationMs
		) {
			return {
				ok: false,
				code: "MEASUREMENT_WINDOW",
				message: "count series shape",
			};
		}
		if (
			!Number.isSafeInteger(admission.delivered) ||
			admission.delivered <= 0
		) {
			return {
				ok: false,
				code: "MEASUREMENT_WINDOW",
				message: "delivered count",
			};
		}
		if (
			admission.cohortGrantSha256 === null ||
			admission.cohortStartBarrierSha256 === null
		) {
			return { ok: false, code: "COHORT_PROTOCOL", message: "cohort joins" };
		}
		return { ok: true };
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
	if (
		admission.cohortGrantSha256 !== null ||
		admission.cohortStartBarrierSha256 !== null
	) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: "phase-a admission names a cohort",
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

export { canonicalJson, FAKE_DIGEST_RE };
