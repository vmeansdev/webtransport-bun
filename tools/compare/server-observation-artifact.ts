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
	/**
	 * The server child's CPU over the measured window, as the rig read it off
	 * the kernel (physical-budget amendment D6): `/proc/<pid>/stat` for the
	 * process, `/proc/<pid>/task/<pid>/stat` for the main thread, each
	 * differenced between the measure-start ack and the capture ack, over the
	 * rig's own window between those two reads. It sits beside the child's
	 * `busyMs` (the relay's timed spans) so a reader sees how much of the
	 * thread, and of the process, the spans account for.
	 */
	readonly serverChildCpu: ServerChildCpuV1;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export interface ServerChildCpuV1 {
	readonly processMs: number;
	readonly mainThreadMs: number;
	readonly windowMs: number;
}

/** The exact sorted key set, named once beside the Rust mint. */
export const RIG_SERVER_SNAPSHOT_RECEIPT_KEYS: readonly string[] = [
	"addonSha256",
	"approvalRecordSha256",
	"approvedPlanSha256",
	"bunSha256",
	"captureRequestSequence",
	"childInstanceNonce",
	"childPgid",
	"childPid",
	"childResponseSequence",
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"executionSha256",
	"frameReceivedAtRigNs",
	"issuedAtMs",
	"macExecutionGrantReceiptSha256",
	"measurementGrantSha256",
	"notAfterMs",
	"receiptSequence",
	"rigExecutionAcceptanceSha256",
	"rigExecutionIndex",
	"rigSupervisorInstanceNonce",
	"roleTokenCommitmentRootSha256",
	"schema",
	"serverChildCpu",
	"serverEntrypointSha256",
	"signingPublicKeySha256",
	"snapshotFrameSha256",
	"snapshotFrameSize",
];

export const SERVER_CHILD_CPU_KEYS: readonly string[] = [
	"mainThreadMs",
	"processMs",
	"windowMs",
];

/**
 * The three attested figures, or why the object is not one. Each is a delta
 * of two rig readings, so it is a finite whole count of milliseconds; the main
 * thread cannot have spent more than its own process; and a window of no
 * length would make every share below undefined.
 */
export function serverChildCpuIssue(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "serverChildCpu is not an object";
	}
	const keys = Object.keys(value).sort();
	if (
		keys.length !== SERVER_CHILD_CPU_KEYS.length ||
		keys.some((key, index) => key !== SERVER_CHILD_CPU_KEYS[index])
	) {
		return `serverChildCpu keys [${keys.join(",")}]`;
	}
	const cpu = value as Record<string, unknown>;
	for (const key of SERVER_CHILD_CPU_KEYS) {
		const figure = cpu[key];
		if (
			typeof figure !== "number" ||
			!Number.isSafeInteger(figure) ||
			figure < 0
		) {
			return `serverChildCpu.${key} is not a non-negative integer`;
		}
	}
	const { processMs, mainThreadMs, windowMs } =
		cpu as unknown as ServerChildCpuV1;
	if (mainThreadMs > processMs) {
		return `serverChildCpu mainThreadMs ${mainThreadMs} exceeds processMs ${processMs}`;
	}
	if (windowMs === 0) return "serverChildCpu windowMs is 0";
	return null;
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

/**
 * How a refusal in this module states the comparison it lost.
 *
 * Four consecutive live campaigns were lost to a message that named a
 * condition without its values -- "delivered bytes" cannot tell a short
 * transfer apart from a unit confusion, and telling them apart cost another
 * paid run each time. Every comparison below now states what it observed and
 * what it required.
 *
 * Both sides are bounded: a 64-hex digest shows its head, any other string is
 * truncated at `MESSAGE_VALUE_MAX_CHARS`, so no field the evidence carries can
 * make a refusal grow without bound. Nothing rendered here is a path, a host
 * or key material -- the evidence graph carries none, and the public-key
 * digests it does carry are published in the artifact already.
 */
const MESSAGE_VALUE_MAX_CHARS = 40;
const HEX64_MESSAGE_RE = /^[0-9a-f]{64}$/i;

function shownValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "absent";
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : "non-finite";
	}
	if (typeof value === "boolean") return String(value);
	if (typeof value !== "string") return typeof value;
	if (HEX64_MESSAGE_RE.test(value)) return `${value.slice(0, 12)}...`;
	return value.length <= MESSAGE_VALUE_MAX_CHARS
		? value
		: `${value.slice(0, MESSAGE_VALUE_MAX_CHARS)}...`;
}

/** `<label>: observed <a>, expected <b>` -- the shape of every refusal here. */
function saw(label: string, observed: unknown, expected: unknown): string {
	return `${label}: observed ${shownValue(observed)}, expected ${shownValue(expected)}`;
}

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
			message: `${label} sha256: observed the placeholder ${shownValue(expectedSha)}`,
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
			message: saw(`${label} sha256`, decoded.value.sha256, expectedSha),
		};
	}
	if (decoded.value.size !== expectedSize) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(`${label} byteLength`, decoded.value.size, expectedSize),
		};
	}
	return { ok: true };
}

function verifyRetained(
	label: string,
	retained: RetainedCanonicalBytesV1,
): AttestationVerifyResult {
	if (retained.schema !== "retained-canonical-bytes/v1") {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(
				`${label} schema`,
				retained.schema,
				"retained-canonical-bytes/v1",
			),
		};
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
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(
				"evidence schema",
				evidence.schema,
				"server-observation-evidence/v1",
			),
		};
	}
	if (
		evidence.provenance !==
		"server-child-observed/rig-supervisor-admitted/mac-supervisor-joined"
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message:
				`evidence provenance: observed ${shownValue(evidence.provenance)}, ` +
				"expected server-child-observed/rig-supervisor-admitted/" +
				"mac-supervisor-joined",
		};
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
			message:
				"phase-a rigBarrierAcceptance: observed a record, expected null " +
				"(a Phase-A arm crosses no start barrier)",
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
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(
				"execution draft schema",
				draft.schema,
				"cross-supervisor-execution-draft/v1",
			),
		};
	}
	const draftCanonicalSha256 = sha256CanonicalRecord(draft);
	if (draftCanonicalSha256 !== evidence.executionDraftSha256) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(
				"execution draft canonical sha256",
				draftCanonicalSha256,
				evidence.executionDraftSha256,
			),
		};
	}

	const grantJson = decodeCanonicalJson(evidence.measurementGrantBase64);
	if (!grantJson.ok)
		return {
			ok: false,
			code: grantJson.code ?? "TRUST_PROTOCOL",
			message: grantJson.message ?? "protocol",
		};
	const grant = grantJson.value as MeasurementGrantV1Extended;
	const grantCanonicalSha256 = sha256CanonicalRecord(grant);
	if (grantCanonicalSha256 !== evidence.measurementGrantSha256) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(
				"measurement grant canonical sha256",
				grantCanonicalSha256,
				evidence.measurementGrantSha256,
			),
		};
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
			message: saw(
				"mac grant receipt executionSha256",
				macReceipt.executionSha256,
				expected.executionSha256,
			),
		};
	}
	if (macReceipt.measurementGrantSha256 !== evidence.measurementGrantSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"evidence measurementGrantSha256, against the signed mac grant receipt",
				evidence.measurementGrantSha256,
				macReceipt.measurementGrantSha256,
			),
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
			message: `mac grant receipt signature: did not verify under the staged Mac key ${shownValue(trust.macPublicKeySha256)} (${shownValue(macGrantVerify.code)})`,
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
			message: saw(
				"rig acceptance executionSha256",
				rigAccept.executionSha256,
				expected.executionSha256,
			),
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
			message: `rig acceptance signature: did not verify under the staged rig key ${shownValue(trust.rigPublicKeySha256)} (${shownValue(rigAcceptVerify.code)})`,
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
			message: saw(
				"rig baseline key set",
				`${baselineKeys.length} keys [${baselineKeys.join(",")}]`,
				`${RIG_MEASURE_START_ACK_KEYS.length} keys`,
			),
		};
	}
	const baseline = baselineJson.value as RigMeasureStartAckV1;
	if (baseline.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"rig baseline executionSha256",
				baseline.executionSha256,
				expected.executionSha256,
			),
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
			message: `rig baseline signature: did not verify under the staged rig key ${shownValue(trust.rigPublicKeySha256)} (${shownValue(baselineVerify.code)})`,
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
	// The receipt's closed key set, then the attested CPU object inside it:
	// both are what the seal will be read for, so a receipt missing either is
	// refused here as a different record rather than accepted on its
	// signature.
	const snapReceiptKeys = Object.keys(
		snapReceiptJson.value as Record<string, unknown>,
	).sort();
	if (
		snapReceiptKeys.length !== RIG_SERVER_SNAPSHOT_RECEIPT_KEYS.length ||
		snapReceiptKeys.some(
			(key, index) => key !== RIG_SERVER_SNAPSHOT_RECEIPT_KEYS[index],
		)
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(
				"rig snapshot receipt key set",
				`${snapReceiptKeys.length} keys [${snapReceiptKeys.join(",")}]`,
				`${RIG_SERVER_SNAPSHOT_RECEIPT_KEYS.length} keys`,
			),
		};
	}
	const snapReceipt = snapReceiptJson.value as RigServerSnapshotReceiptV1;
	const cpuIssue = serverChildCpuIssue(snapReceipt.serverChildCpu);
	if (cpuIssue !== null) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `rig snapshot receipt: ${cpuIssue}`,
		};
	}
	if (snapReceipt.snapshotFrameSha256 !== evidence.snapshotFrameSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"evidence snapshotFrameSha256, against the signed rig snapshot receipt",
				evidence.snapshotFrameSha256,
				snapReceipt.snapshotFrameSha256,
			),
		};
	}
	if (snapReceipt.executionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"rig snapshot receipt executionSha256",
				snapReceipt.executionSha256,
				expected.executionSha256,
			),
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
			message: `rig snapshot receipt signature: did not verify under the staged rig key ${shownValue(trust.rigPublicKeySha256)} (${shownValue(snapVerify.code)})`,
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
			message: saw(
				"admission executionSha256",
				admission.executionSha256,
				expected.executionSha256,
			),
		};
	}
	if (
		admission.admittedClientSeriesSha256 !== evidence.admittedClientSeriesSha256
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"evidence admittedClientSeriesSha256, against the signed admission",
				evidence.admittedClientSeriesSha256,
				admission.admittedClientSeriesSha256,
			),
		};
	}
	if (admission.snapshotFrameSha256 !== evidence.snapshotFrameSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"evidence snapshotFrameSha256, against the signed admission",
				evidence.snapshotFrameSha256,
				admission.snapshotFrameSha256,
			),
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
			message: [
				saw(
					"evidence rigExecutionAcceptanceSha256, against the signed admission",
					evidence.rigExecutionAcceptanceSha256,
					admission.rigExecutionAcceptanceSha256,
				),
				saw(
					"evidence rigMeasureStartAckSha256, against the signed admission",
					evidence.rigMeasureStartAckSha256,
					admission.rigMeasureStartAckSha256,
				),
				saw(
					"evidence rigServerSnapshotReceiptSha256, against the signed admission",
					evidence.rigServerSnapshotReceiptSha256,
					admission.rigServerSnapshotReceiptSha256,
				),
			].join("; "),
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
			message: `admission receipt signature: did not verify under the staged Mac key ${shownValue(trust.macPublicKeySha256)} (${shownValue(admissionVerify.code)})`,
		};
	}

	const execution = macReceipt.execution;
	const embeddedExecutionSha256 = sha256CanonicalRecord(execution);
	if (embeddedExecutionSha256 !== expected.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"embedded execution canonical sha256",
				embeddedExecutionSha256,
				expected.executionSha256,
			),
		};
	}
	if (
		expected.executionPurpose !== undefined &&
		execution.executionPurpose !== expected.executionPurpose
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"execution executionPurpose",
				execution.executionPurpose,
				expected.executionPurpose,
			),
		};
	}
	if (expected.cellId !== undefined && execution.cellId !== expected.cellId) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw("execution cellId", execution.cellId, expected.cellId),
		};
	}
	if (
		expected.transport !== undefined &&
		execution.transport !== expected.transport
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"execution transport",
				execution.transport,
				expected.transport,
			),
		};
	}
	if (
		expected.repetitionKind !== undefined &&
		execution.repetitionKind !== expected.repetitionKind
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"execution repetitionKind",
				execution.repetitionKind,
				expected.repetitionKind,
			),
		};
	}
	if (
		expected.repetitionIndex !== undefined &&
		execution.repetitionIndex !== expected.repetitionIndex
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"execution repetitionIndex",
				execution.repetitionIndex,
				expected.repetitionIndex,
			),
		};
	}
	if (
		expected.repetitionTotal !== undefined &&
		execution.repetitionTotal !== expected.repetitionTotal
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"execution repetitionTotal",
				execution.repetitionTotal,
				expected.repetitionTotal,
			),
		};
	}
	if (
		expected.candidate !== undefined &&
		execution.candidate !== expected.candidate
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"execution candidate",
				execution.candidate,
				expected.candidate,
			),
		};
	}
	if (
		expected.campaignId !== undefined &&
		execution.campaignId !== expected.campaignId
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"execution campaignId",
				execution.campaignId,
				expected.campaignId,
			),
		};
	}
	if (
		expected.approvedPlanSha256 !== undefined &&
		execution.approvedPlanSha256 !== expected.approvedPlanSha256
	) {
		return {
			ok: false,
			code: "APPROVAL_IDENTITY_MISMATCH",
			message: saw(
				"execution approvedPlanSha256",
				execution.approvedPlanSha256,
				expected.approvedPlanSha256,
			),
		};
	}
	if (
		expected.approvalRecordSha256 !== undefined &&
		execution.approvalRecordSha256 !== expected.approvalRecordSha256
	) {
		return {
			ok: false,
			code: "APPROVAL_IDENTITY_MISMATCH",
			message: saw(
				"execution approvalRecordSha256",
				execution.approvalRecordSha256,
				expected.approvalRecordSha256,
			),
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
			message:
				`server child identity: observed pid ${shownValue(snapReceipt.childPid)}, ` +
				`pgid ${shownValue(snapReceipt.childPgid)}, instance nonce ` +
				`${shownValue(snapReceipt.childInstanceNonce)}; expected a positive ` +
				"pid and pgid and a 64-hex nonce",
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
				message:
					`grantDeclaration for ${shownValue(expected.cellId)}/` +
					`${shownValue(expected.armKind)}, which runs ` +
					`${cohortRequired ? "a cohort" : "no cohort"}: observed ` +
					`${shownValue(execution.grantDeclaration)}, expected ` +
					(cohortRequired
						? "fanout-expanded-deliveries"
						: "phase-a-completed-transfer"),
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
				message: saw(
					"fanout declaration cell",
					`${shownValue(execution.cellId)}/${shownValue(execution.armKind)}`,
					"a cell that runs a cohort",
				),
			};
		}
		const cardinality = cohortCellCardinality(cohortCell);
		const parameters = cohortCellGrantParameters(cohortCell);
		if (grant.declaredMessageCount !== cardinality.expandedDeliveries) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message: saw(
					"fanout grant declaredMessageCount",
					grant.declaredMessageCount,
					cardinality.expandedDeliveries,
				),
			};
		}
		if (grant.declaredMessageBytes !== parameters.messageBytes) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message: saw(
					"fanout grant declaredMessageBytes",
					grant.declaredMessageBytes,
					parameters.messageBytes,
				),
			};
		}
		const expectedWindows = parameters.measuredDurationMs / 1000;
		if (
			admission.sampleUnit !== "count" ||
			admission.sampleCount !== expectedWindows ||
			admission.spanMs !== parameters.measuredDurationMs
		) {
			return {
				ok: false,
				code: "MEASUREMENT_WINDOW",
				message: [
					saw(
						"admitted count series sampleUnit",
						admission.sampleUnit,
						"count",
					),
					saw(
						"admitted count series sampleCount",
						admission.sampleCount,
						expectedWindows,
					),
					saw(
						"admitted count series spanMs",
						admission.spanMs,
						parameters.measuredDurationMs,
					),
				].join("; "),
			};
		}
		if (
			!Number.isSafeInteger(admission.delivered) ||
			admission.delivered <= 0
		) {
			return {
				ok: false,
				code: "MEASUREMENT_WINDOW",
				message: saw(
					"admitted count series ledger.delivered (deliveries)",
					admission.delivered,
					"a positive safe integer",
				),
			};
		}
		if (
			admission.cohortGrantSha256 === null ||
			admission.cohortStartBarrierSha256 === null
		) {
			return {
				ok: false,
				code: "COHORT_PROTOCOL",
				message: [
					saw(
						"admission cohortGrantSha256",
						admission.cohortGrantSha256,
						"a digest",
					),
					saw(
						"admission cohortStartBarrierSha256",
						admission.cohortStartBarrierSha256,
						"a digest",
					),
				].join("; "),
			};
		}
		return { ok: true };
	}

	// Phase-A bulk completion: client series and grant declarations must match.
	if (grant.declaredMessageCount !== PHASE_A_DECLARED_MESSAGE_COUNT) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"phase-a grant declaredMessageCount (chunks)",
				grant.declaredMessageCount,
				PHASE_A_DECLARED_MESSAGE_COUNT,
			),
		};
	}
	if (grant.declaredMessageBytes !== PHASE_A_DECLARED_MESSAGE_BYTES) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"phase-a grant declaredMessageBytes",
				grant.declaredMessageBytes,
				PHASE_A_DECLARED_MESSAGE_BYTES,
			),
		};
	}
	if (
		admission.cohortGrantSha256 !== null ||
		admission.cohortStartBarrierSha256 !== null
	) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: [
				saw(
					"phase-a admission cohortGrantSha256",
					admission.cohortGrantSha256,
					"null",
				),
				saw(
					"phase-a admission cohortStartBarrierSha256",
					admission.cohortStartBarrierSha256,
					"null",
				),
			].join("; "),
		};
	}

	// The completed transfer, asserted on the fields that carry it.
	//
	// `admission.delivered` is the admitted client series' `ledger.delivered`,
	// echoed by the binary untouched (`secure_fs.rs` `admit_throughput_value`:
	// "`ledger.delivered` is the chunk count (independent of sample count)").
	// A bulk leg files the bulk *schedule* there -- 1,600 chunks of 65,536 --
	// and never a byte count (`client.ts` `executeBulkOneWay`). Until
	// 2026-09-07 this block compared that count with the declared 104,857,600
	// BYTES and required `sampleCount === 1`, so no honest arm could pass: the
	// series is Mbps window samples, one per 100 ms of transfer. Both
	// comparisons were wrong about the unit of the field they read, and the
	// refusal named the condition without its values, which cost four live
	// campaigns to tell apart from a short transfer.
	//
	// The declared byte total is still asserted, on the field that is bytes:
	// `deliveredBytes` inside the admitted client series. Those bytes are
	// digest-verified above and the signed admission receipt binds their
	// digest, so reading them here adds no trust the graph did not already
	// carry.
	const seriesJson = decodeCanonicalJson(evidence.admittedClientSeriesBase64);
	if (!seriesJson.ok) {
		return {
			ok: false,
			code: seriesJson.code ?? "TRUST_PROTOCOL",
			message: `admitted client series: ${seriesJson.message ?? "protocol"}`,
		};
	}
	const series = seriesJson.value as {
		readonly ledger?: { readonly delivered?: unknown };
		readonly deliveredBytes?: unknown;
		readonly samples?: unknown;
		readonly sampleUnit?: unknown;
	};
	if (series.sampleUnit !== "Mbps" || admission.sampleUnit !== "Mbps") {
		return {
			ok: false,
			code: "MEASUREMENT_WINDOW",
			message:
				"phase-a sampleUnit: observed " +
				`${shownValue(series.sampleUnit)} on the admitted series and ` +
				`${shownValue(admission.sampleUnit)} on the admission, expected Mbps on both`,
		};
	}
	if (admission.delivered !== PHASE_A_DECLARED_MESSAGE_COUNT) {
		return {
			ok: false,
			code: "MEASUREMENT_WINDOW",
			message: saw(
				"phase-a admission ledger.delivered (scheduled chunks)",
				admission.delivered,
				PHASE_A_DECLARED_MESSAGE_COUNT,
			),
		};
	}
	const seriesDelivered = series.ledger?.delivered;
	if (seriesDelivered !== admission.delivered) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: saw(
				"admitted client series ledger.delivered (scheduled chunks)",
				seriesDelivered,
				admission.delivered,
			),
		};
	}
	if (series.deliveredBytes !== PHASE_A_DECLARED_MESSAGE_BYTES) {
		return {
			ok: false,
			code: "MEASUREMENT_WINDOW",
			message: saw(
				"admitted client series deliveredBytes",
				series.deliveredBytes,
				PHASE_A_DECLARED_MESSAGE_BYTES,
			),
		};
	}
	const seriesSampleCount = Array.isArray(series.samples)
		? series.samples.length
		: undefined;
	if (
		!Number.isSafeInteger(admission.sampleCount) ||
		admission.sampleCount < 1 ||
		admission.sampleCount !== seriesSampleCount
	) {
		return {
			ok: false,
			code: "MEASUREMENT_WINDOW",
			message:
				"phase-a admission sampleCount (Mbps windows): observed " +
				`${shownValue(admission.sampleCount)}, expected ` +
				`${shownValue(seriesSampleCount)}, the admitted series' own ` +
				"sample count, and at least 1",
		};
	}
	if (!(admission.spanMs > 0)) {
		return {
			ok: false,
			code: "MEASUREMENT_WINDOW",
			message: saw("phase-a admission spanMs", admission.spanMs, "> 0"),
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
			message: saw(
				"cohort evidence schema",
				cohort.schema,
				"cohort-observation-evidence/v1",
			),
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
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: saw(
				"attestation schema",
				attestation.schema,
				"arm-attestation-evidence/v2",
			),
		};
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
			message: saw(
				"attestation executionSha256",
				attestation.executionSha256,
				expected.executionSha256,
			),
		};
	}
	return verifyServerObservationEvidence(
		attestation.serverObservationEvidence,
		trust,
		expected,
	);
}

export { canonicalJson, FAKE_DIGEST_RE };
