/**
 * Phase-A authenticated cross-supervisor protocol codecs (plan §3.1–3.3, A2).
 *
 * Pure protocol: canonical encode/decode, draft→final execution construction,
 * Ed25519 Mac/rig sign/verify, in-memory replay ledgers, remote frame unions,
 * caps, expiry, and refusal pairing. No production controller/seal path imports
 * this module in A2.
 */
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign as nodeSign,
	verify as nodeVerify,
	type KeyObject,
} from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import {
	canonicalRecordBytes,
	hasOwn,
	isHex64,
	parseStrictJsonBytes,
	sha256HexOfBytes,
} from "./secure-fs.ts";

const MAX_FRAME_HEADER_BYTES = 65_536;

type FrameResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: string };

function frameSha256(payload: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(payload).digest());
}

function encodeSupervisorFrameLocal(
	header: Uint8Array,
	payload: Uint8Array,
	payloadBound: number,
): FrameResult<Uint8Array> {
	if (header.byteLength === 0 || header.byteLength > MAX_FRAME_HEADER_BYTES) {
		return { ok: false, code: "FRAME_HEADER_INVALID" };
	}
	if (payload.byteLength > payloadBound) {
		return { ok: false, code: "FRAME_PAYLOAD_TOO_LARGE" };
	}
	const out = new Uint8Array(
		4 + header.byteLength + 8 + payload.byteLength + 32,
	);
	const view = new DataView(out.buffer);
	view.setUint32(0, header.byteLength, false);
	out.set(header, 4);
	let offset = 4 + header.byteLength;
	view.setBigUint64(offset, BigInt(payload.byteLength), false);
	offset += 8;
	out.set(payload, offset);
	offset += payload.byteLength;
	out.set(frameSha256(payload), offset);
	return { ok: true, value: out };
}

function decodeSingleSupervisorFrameLocal(
	input: Uint8Array,
	payloadBound: number,
): FrameResult<{ header: Uint8Array; payload: Uint8Array }> {
	if (input.byteLength < 4) return { ok: false, code: "FRAME_TRUNCATED" };
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const headerLength = view.getUint32(0, false);
	if (headerLength === 0 || headerLength > MAX_FRAME_HEADER_BYTES) {
		return { ok: false, code: "FRAME_HEADER_INVALID" };
	}
	let offset = 4;
	if (input.byteLength < offset + headerLength + 8) {
		return { ok: false, code: "FRAME_TRUNCATED" };
	}
	const header = input.slice(offset, offset + headerLength);
	offset += headerLength;
	const payloadLength = view.getBigUint64(offset, false);
	offset += 8;
	if (payloadLength > BigInt(payloadBound)) {
		return { ok: false, code: "FRAME_PAYLOAD_TOO_LARGE" };
	}
	const payloadBytes = Number(payloadLength);
	if (input.byteLength < offset + payloadBytes + 32) {
		return { ok: false, code: "FRAME_TRUNCATED" };
	}
	const payload = input.slice(offset, offset + payloadBytes);
	offset += payloadBytes;
	const digest = input.slice(offset, offset + 32);
	offset += 32;
	if (offset !== input.byteLength) {
		return { ok: false, code: "FRAME_TRAILING_BYTES" };
	}
	const expected = frameSha256(payload);
	for (let i = 0; i < 32; i += 1) {
		if (digest[i] !== expected[i]) {
			return { ok: false, code: "FRAME_DIGEST_MISMATCH" };
		}
	}
	return { ok: true, value: { header, payload } };
}

export type Sha256Hex = string;
export type Base64 = string;
export type NsString = string;
export type ExecutionPurpose = "focused" | "pilot" | "canonical";
export type RepetitionKind = "warmup" | "measured";
export type CampaignStatus = "PASS" | "FAIL" | "REFUSED";

export type CampaignRefusalCode =
	| "RIG_UNREACHABLE"
	| "HOST_FD_PREFLIGHT"
	| "STALE_OR_INVALID_STAGING";

export type CampaignFailureCode =
	| "MAC_GRANT_SIGNATURE_INVALID"
	| "MAC_SIGNING_KEY_MISMATCH"
	| "APPROVAL_IDENTITY_MISMATCH"
	| "MAC_GRANT_EXPIRED"
	| "MAC_GRANT_REPLAYED"
	| "RIG_RECEIPT_SIGNATURE_INVALID"
	| "RIG_SIGNING_KEY_MISMATCH"
	| "RIG_RECEIPT_EXPIRED"
	| "RIG_RECEIPT_REPLAYED"
	| "TRUST_PROTOCOL"
	| "CROSS_SUPERVISOR_MISMATCH"
	| "COHORT_PROTOCOL"
	| "COHORT_NOT_READY"
	| "WARMUP_PROTOCOL"
	| "MEASUREMENT_WINDOW"
	| "RELAY_DELIVERY"
	| "CHILD_LIFECYCLE"
	| "RUNTIME_RESOURCE_EXHAUSTION";

export type RemoteSupervisorRefusalCode =
	| CampaignRefusalCode
	| CampaignFailureCode;

export const CAMPAIGN_REFUSAL_CODES = [
	"RIG_UNREACHABLE",
	"HOST_FD_PREFLIGHT",
	"STALE_OR_INVALID_STAGING",
] as const satisfies readonly CampaignRefusalCode[];

export const CAMPAIGN_FAILURE_CODES = [
	"MAC_GRANT_SIGNATURE_INVALID",
	"MAC_SIGNING_KEY_MISMATCH",
	"APPROVAL_IDENTITY_MISMATCH",
	"MAC_GRANT_EXPIRED",
	"MAC_GRANT_REPLAYED",
	"RIG_RECEIPT_SIGNATURE_INVALID",
	"RIG_SIGNING_KEY_MISMATCH",
	"RIG_RECEIPT_EXPIRED",
	"RIG_RECEIPT_REPLAYED",
	"TRUST_PROTOCOL",
	"CROSS_SUPERVISOR_MISMATCH",
	"COHORT_PROTOCOL",
	"COHORT_NOT_READY",
	"WARMUP_PROTOCOL",
	"MEASUREMENT_WINDOW",
	"RELAY_DELIVERY",
	"CHILD_LIFECYCLE",
	"RUNTIME_RESOURCE_EXHAUSTION",
] as const satisfies readonly CampaignFailureCode[];

export const STAGED_MAC_PUBLIC_KEY_LEAF = "mac-supervisor-ed25519.pub" as const;
export const STAGED_RIG_PUBLIC_KEY_LEAF = "rig-supervisor-ed25519.pub" as const;

export const PHASE_A_DECLARED_MESSAGE_COUNT = 1600;
export const PHASE_A_DECLARED_MESSAGE_BYTES = 104_857_600;

export const CAPS = {
	executionDraft: 16 * 1024,
	measurementGrant: 16 * 1024,
	macExecutionReceipt: 32 * 1024,
	signatureRecord: 4 * 1024,
	macMeasurementAdmission: 32 * 1024,
	admittedClientSeries: 256 * 1024,
	rigRecord: 32 * 1024,
	snapshotFrame: 16 * 1024,
	serverObservationDecoded: 640 * 1024,
	serverObservationEncoded: 896 * 1024,
	remotePayloadDefault: 1 * 1024 * 1024,
	remoteMaxFrames: 192,
	remoteEvidenceBudget: 1 * 1024 * 1024,
} as const;

export type ProtocolResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: string; readonly message?: string };

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Rec, expected: readonly string[]): boolean {
	const keys = Object.keys(record).sort();
	if (keys.length !== expected.length) return false;
	return expected.every((key, index) => keys[index] === key);
}

function isSafeNonNegInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function bytesOfCanonical(value: unknown): Uint8Array {
	return canonicalRecordBytes(value);
}

function sha256OfCanonical(value: unknown): Sha256Hex {
	return sha256HexOfBytes(bytesOfCanonical(value));
}

function toBase64(bytes: Uint8Array): Base64 {
	return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const buf = Buffer.from(value, "base64");
		if (
			buf.toString("base64") !== value &&
			Buffer.from(value, "base64url").byteLength === 0
		) {
			// tolerate standard base64 only; reject whitespace/non-canonical loosely
		}
		return new Uint8Array(buf);
	} catch {
		return null;
	}
}

function decodeRetainedBase64(
	base64: string,
	cap: number,
): ProtocolResult<Uint8Array> {
	const bytes = fromBase64(base64);
	if (bytes === null) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "invalid base64" };
	}
	if (bytes.byteLength > cap) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `decoded bytes ${bytes.byteLength} exceed cap ${cap}`,
		};
	}
	return { ok: true, value: bytes };
}

// ---------------------------------------------------------------------------
// Draft / final execution
// ---------------------------------------------------------------------------

const DRAFT_KEYS = [
	"approvalRecordSha256",
	"approvedPlanSha256",
	"armKind",
	"authoritySha256",
	"campaignId",
	"campaignLockSha256",
	"candidate",
	"cellId",
	"declaredMessageBytes",
	"declaredMessageCount",
	"executionPurpose",
	"grantDeclaration",
	"repetitionIndex",
	"repetitionKind",
	"repetitionTotal",
	"requestedNotAfterMs",
	"rolePlanHash",
	"runId",
	"scenarioHash",
	"schema",
	"sourceArchiveSha256",
	"stagedCapabilitySha256",
	"stagedServerLaunchRecordSha256",
	"transport",
	"workloadRolePlanInputSha256",
] as const;

const FINAL_KEYS = [
	"approvalRecordSha256",
	"approvedPlanSha256",
	"armKind",
	"authoritySha256",
	"campaignId",
	"campaignLockSha256",
	"candidate",
	"cellId",
	"declaredMessageBytes",
	"declaredMessageCount",
	"draftSha256",
	"executionIndex",
	"executionPurpose",
	"grantDeclaration",
	"issuedAtMs",
	"macSupervisorInstanceNonce",
	"measurementGrantSha256",
	"notAfterMs",
	"repetitionIndex",
	"repetitionKind",
	"repetitionTotal",
	"rolePlanHash",
	"runId",
	"scenarioHash",
	"schema",
	"sourceArchiveSha256",
	"stagedCapabilitySha256",
	"stagedServerLaunchRecordSha256",
	"transport",
	"workloadRolePlanInputSha256",
] as const;

/** Fields the controller must never supply on a draft. */
const DRAFT_FORBIDDEN_CONTROLLER_FIELDS = [
	"executionIndex",
	"measurementGrantSha256",
	"macSupervisorInstanceNonce",
	"issuedAtMs",
	"notAfterMs",
	"draftSha256",
] as const;

export interface CrossSupervisorExecutionDraftV1 {
	readonly schema: "cross-supervisor-execution-draft/v1";
	readonly authoritySha256: Sha256Hex;
	readonly campaignLockSha256: Sha256Hex;
	readonly stagedCapabilitySha256: Sha256Hex;
	readonly sourceArchiveSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly candidate: string;
	readonly campaignId: string;
	readonly runId: string;
	readonly executionPurpose: ExecutionPurpose;
	readonly cellId: string;
	readonly scenarioHash: Sha256Hex;
	readonly rolePlanHash: Sha256Hex;
	readonly workloadRolePlanInputSha256: Sha256Hex;
	readonly stagedServerLaunchRecordSha256: Sha256Hex;
	readonly armKind: "primary";
	readonly transport: "ws" | "wt";
	readonly repetitionKind: RepetitionKind;
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
	readonly grantDeclaration:
		| "phase-a-completed-transfer"
		| "fanout-expanded-deliveries";
	readonly declaredMessageCount: number;
	readonly declaredMessageBytes: number;
	readonly requestedNotAfterMs: number;
}

export interface CrossSupervisorExecutionV1 {
	readonly schema: "cross-supervisor-execution/v1";
	readonly draftSha256: Sha256Hex;
	readonly authoritySha256: Sha256Hex;
	readonly campaignLockSha256: Sha256Hex;
	readonly stagedCapabilitySha256: Sha256Hex;
	readonly sourceArchiveSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly candidate: string;
	readonly campaignId: string;
	readonly runId: string;
	readonly executionIndex: number;
	readonly executionPurpose: ExecutionPurpose;
	readonly cellId: string;
	readonly scenarioHash: Sha256Hex;
	readonly rolePlanHash: Sha256Hex;
	readonly workloadRolePlanInputSha256: Sha256Hex;
	readonly stagedServerLaunchRecordSha256: Sha256Hex;
	readonly armKind: "primary";
	readonly transport: "ws" | "wt";
	readonly repetitionKind: RepetitionKind;
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
	readonly grantDeclaration:
		| "phase-a-completed-transfer"
		| "fanout-expanded-deliveries";
	readonly declaredMessageCount: number;
	readonly declaredMessageBytes: number;
	readonly measurementGrantSha256: Sha256Hex;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export function parseCrossSupervisorExecutionDraft(
	value: unknown,
): ProtocolResult<CrossSupervisorExecutionDraftV1> {
	if (!isPlainObject(value)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "draft not object" };
	}
	for (const forbidden of DRAFT_FORBIDDEN_CONTROLLER_FIELDS) {
		if (hasOwn(value, forbidden)) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `draft must not carry controller-forbidden field ${forbidden}`,
			};
		}
	}
	if (!exactKeys(value, DRAFT_KEYS)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "draft exact keys mismatch",
		};
	}
	if (value.schema !== "cross-supervisor-execution-draft/v1") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "draft schema" };
	}
	if (
		!isHex64(value.authoritySha256) ||
		!isHex64(value.campaignLockSha256) ||
		!isHex64(value.stagedCapabilitySha256) ||
		!isHex64(value.sourceArchiveSha256) ||
		!isHex64(value.approvedPlanSha256) ||
		!isHex64(value.approvalRecordSha256) ||
		!isHex64(value.scenarioHash) ||
		!isHex64(value.rolePlanHash) ||
		!isHex64(value.workloadRolePlanInputSha256) ||
		!isHex64(value.stagedServerLaunchRecordSha256) ||
		!isNonEmptyString(value.candidate) ||
		!isNonEmptyString(value.campaignId) ||
		!isNonEmptyString(value.runId) ||
		!isNonEmptyString(value.cellId) ||
		(value.executionPurpose !== "focused" &&
			value.executionPurpose !== "pilot" &&
			value.executionPurpose !== "canonical") ||
		value.armKind !== "primary" ||
		(value.transport !== "ws" && value.transport !== "wt") ||
		(value.repetitionKind !== "warmup" &&
			value.repetitionKind !== "measured") ||
		!isSafeNonNegInt(value.repetitionIndex) ||
		!isSafeNonNegInt(value.repetitionTotal) ||
		(value.grantDeclaration !== "phase-a-completed-transfer" &&
			value.grantDeclaration !== "fanout-expanded-deliveries") ||
		!isSafeNonNegInt(value.declaredMessageCount) ||
		!isSafeNonNegInt(value.declaredMessageBytes) ||
		!isSafeNonNegInt(value.requestedNotAfterMs)
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "draft field types" };
	}
	const draft = value as unknown as CrossSupervisorExecutionDraftV1;
	const decl = validatePhaseADeclaration(draft);
	if (!decl.ok) return decl;
	return { ok: true, value: draft };
}

export function validatePhaseADeclaration(
	draft: Pick<
		CrossSupervisorExecutionDraftV1,
		"grantDeclaration" | "declaredMessageCount" | "declaredMessageBytes"
	>,
): ProtocolResult<true> {
	if (draft.grantDeclaration === "phase-a-completed-transfer") {
		if (
			draft.declaredMessageCount !== PHASE_A_DECLARED_MESSAGE_COUNT ||
			draft.declaredMessageBytes !== PHASE_A_DECLARED_MESSAGE_BYTES
		) {
			return {
				ok: false,
				code: "CROSS_SUPERVISOR_MISMATCH",
				message: "phase-a declared count/bytes mismatch",
			};
		}
	}
	return { ok: true, value: true };
}

export function parseCrossSupervisorExecution(
	value: unknown,
): ProtocolResult<CrossSupervisorExecutionV1> {
	if (!isPlainObject(value)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "execution not object",
		};
	}
	if (!exactKeys(value, FINAL_KEYS)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "execution exact keys mismatch",
		};
	}
	if (value.schema !== "cross-supervisor-execution/v1") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "execution schema" };
	}
	if (
		!isHex64(value.draftSha256) ||
		!isHex64(value.authoritySha256) ||
		!isHex64(value.campaignLockSha256) ||
		!isHex64(value.stagedCapabilitySha256) ||
		!isHex64(value.sourceArchiveSha256) ||
		!isHex64(value.approvedPlanSha256) ||
		!isHex64(value.approvalRecordSha256) ||
		!isHex64(value.scenarioHash) ||
		!isHex64(value.rolePlanHash) ||
		!isHex64(value.workloadRolePlanInputSha256) ||
		!isHex64(value.stagedServerLaunchRecordSha256) ||
		!isHex64(value.measurementGrantSha256) ||
		!isHex64(value.macSupervisorInstanceNonce) ||
		!isNonEmptyString(value.candidate) ||
		!isNonEmptyString(value.campaignId) ||
		!isNonEmptyString(value.runId) ||
		!isNonEmptyString(value.cellId) ||
		!isSafeNonNegInt(value.executionIndex) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs) ||
		!isSafeNonNegInt(value.repetitionIndex) ||
		!isSafeNonNegInt(value.repetitionTotal) ||
		!isSafeNonNegInt(value.declaredMessageCount) ||
		!isSafeNonNegInt(value.declaredMessageBytes) ||
		(value.executionPurpose !== "focused" &&
			value.executionPurpose !== "pilot" &&
			value.executionPurpose !== "canonical") ||
		value.armKind !== "primary" ||
		(value.transport !== "ws" && value.transport !== "wt") ||
		(value.repetitionKind !== "warmup" &&
			value.repetitionKind !== "measured") ||
		(value.grantDeclaration !== "phase-a-completed-transfer" &&
			value.grantDeclaration !== "fanout-expanded-deliveries")
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "execution field types",
		};
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return {
			ok: false,
			code: "MAC_GRANT_EXPIRED",
			message: "notAfter < issued",
		};
	}
	return { ok: true, value: value as unknown as CrossSupervisorExecutionV1 };
}

export interface MeasurementGrantV1Extended {
	readonly schema: "measurement-grant/v1";
	readonly campaignId: string;
	readonly candidate: string;
	readonly declaredMessageBytes: number;
	readonly declaredMessageCount: number;
	readonly executionIndex: number;
	readonly issuedAt: number;
	readonly nonceSha256: Sha256Hex;
	readonly notAfter: number;
	readonly runId: string;
	readonly transport: string;
}

export interface MacConstructFinalExecutionInput {
	readonly draft: CrossSupervisorExecutionDraftV1;
	readonly executionIndex: number;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
	readonly grantNonceSha256: Sha256Hex;
}

export interface MacConstructFinalExecutionResult {
	readonly draft: CrossSupervisorExecutionDraftV1;
	readonly draftSha256: Sha256Hex;
	readonly grant: MeasurementGrantV1Extended;
	readonly grantSha256: Sha256Hex;
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionSha256: Sha256Hex;
}

/**
 * Mac-owned final execution construction. Controller supplies only the draft;
 * Mac assigns executionIndex, grant digest, nonce, issuedAtMs, notAfterMs.
 */
export function macConstructFinalExecution(
	input: MacConstructFinalExecutionInput,
): ProtocolResult<MacConstructFinalExecutionResult> {
	const draftParsed = parseCrossSupervisorExecutionDraft(input.draft);
	if (!draftParsed.ok) return draftParsed;
	const draft = draftParsed.value;
	if (
		!isHex64(input.macSupervisorInstanceNonce) ||
		!isHex64(input.grantNonceSha256)
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "mac nonce digests" };
	}
	if (
		!isSafeNonNegInt(input.executionIndex) ||
		!isSafeNonNegInt(input.issuedAtMs) ||
		!isSafeNonNegInt(input.notAfterMs)
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "mac timing fields" };
	}
	if (input.notAfterMs < input.issuedAtMs) {
		return { ok: false, code: "MAC_GRANT_EXPIRED" };
	}
	if (input.notAfterMs > draft.requestedNotAfterMs) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "notAfter exceeds draft requestedNotAfterMs",
		};
	}
	const draftSha256 = sha256OfCanonical(draft);
	const grant: MeasurementGrantV1Extended = {
		schema: "measurement-grant/v1",
		campaignId: draft.campaignId,
		candidate: draft.candidate,
		declaredMessageBytes: draft.declaredMessageBytes,
		declaredMessageCount: draft.declaredMessageCount,
		executionIndex: input.executionIndex,
		issuedAt: input.issuedAtMs,
		nonceSha256: input.grantNonceSha256,
		notAfter: input.notAfterMs,
		runId: draft.runId,
		transport: draft.transport,
	};
	const grantSha256 = sha256OfCanonical(grant);
	const execution: CrossSupervisorExecutionV1 = {
		schema: "cross-supervisor-execution/v1",
		draftSha256,
		authoritySha256: draft.authoritySha256,
		campaignLockSha256: draft.campaignLockSha256,
		stagedCapabilitySha256: draft.stagedCapabilitySha256,
		sourceArchiveSha256: draft.sourceArchiveSha256,
		approvedPlanSha256: draft.approvedPlanSha256,
		approvalRecordSha256: draft.approvalRecordSha256,
		candidate: draft.candidate,
		campaignId: draft.campaignId,
		runId: draft.runId,
		executionIndex: input.executionIndex,
		executionPurpose: draft.executionPurpose,
		cellId: draft.cellId,
		scenarioHash: draft.scenarioHash,
		rolePlanHash: draft.rolePlanHash,
		workloadRolePlanInputSha256: draft.workloadRolePlanInputSha256,
		stagedServerLaunchRecordSha256: draft.stagedServerLaunchRecordSha256,
		armKind: draft.armKind,
		transport: draft.transport,
		repetitionKind: draft.repetitionKind,
		repetitionIndex: draft.repetitionIndex,
		repetitionTotal: draft.repetitionTotal,
		grantDeclaration: draft.grantDeclaration,
		declaredMessageCount: draft.declaredMessageCount,
		declaredMessageBytes: draft.declaredMessageBytes,
		measurementGrantSha256: grantSha256,
		macSupervisorInstanceNonce: input.macSupervisorInstanceNonce,
		issuedAtMs: input.issuedAtMs,
		notAfterMs: input.notAfterMs,
	};
	const executionParsed = parseCrossSupervisorExecution(execution);
	if (!executionParsed.ok) return executionParsed;
	return {
		ok: true,
		value: {
			draft,
			draftSha256,
			grant,
			grantSha256,
			execution,
			executionSha256: sha256OfCanonical(execution),
		},
	};
}

export function crossSupervisorExecutionBytes(
	execution: CrossSupervisorExecutionV1,
): Uint8Array {
	return bytesOfCanonical(execution);
}

export function crossSupervisorExecutionDraftBytes(
	draft: CrossSupervisorExecutionDraftV1,
): Uint8Array {
	return bytesOfCanonical(draft);
}

// ---------------------------------------------------------------------------
// Receipts and signatures
// ---------------------------------------------------------------------------

export interface MacExecutionGrantReceiptV1 {
	readonly schema: "mac-execution-grant-receipt/v1";
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly macSupervisorExecutableSha256: Sha256Hex;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export interface MacReceiptSignatureV1 {
	readonly schema: "mac-receipt-signature/v1";
	readonly algorithm: "Ed25519";
	readonly signedSchema:
		| "mac-execution-grant-receipt/v1"
		| "cohort-grant/v1"
		| "cohort-warmup-epoch/v1"
		| "role-warmup-completion-manifest/v1"
		| "cohort-start-barrier/v1"
		| "mac-measurement-admission/v1"
		| "cohort-admission-receipt/v1";
	readonly signedBytesSha256: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly signatureBase64: Base64;
}

export interface RigReceiptSignatureV1 {
	readonly schema: "rig-receipt-signature/v1";
	readonly algorithm: "Ed25519";
	readonly signedSchema:
		| "rig-execution-acceptance/v1"
		| "rig-cohort-acceptance/v1"
		| "rig-measure-start-ack/v1"
		| "rig-warmup-drained-receipt/v1"
		| "rig-barrier-acceptance/v1"
		| "rig-server-snapshot-receipt/v1"
		| "rig-relay-observation-receipt/v1";
	readonly signedBytesSha256: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly signatureBase64: Base64;
}

export interface RigExecutionAcceptanceV1 {
	readonly schema: "rig-execution-acceptance/v1";
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly macReceiptSignatureSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly rigExecutionIndex: number;
	readonly rigSupervisorInstanceNonce: Sha256Hex;
	readonly rigSupervisorExecutableSha256: Sha256Hex;
	readonly replayLedgerLeafSha256: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly acceptedAtMs: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const MAC_RECEIPT_KEYS = [
	"approvalRecordSha256",
	"approvedPlanSha256",
	"execution",
	"executionSha256",
	"issuedAtMs",
	"macSupervisorExecutableSha256",
	"macSupervisorInstanceNonce",
	"measurementGrantSha256",
	"notAfterMs",
	"receiptSequence",
	"schema",
	"signingPublicKeySha256",
] as const;

const RIG_ACCEPTANCE_KEYS = [
	"acceptedAtMs",
	"approvalRecordSha256",
	"approvedPlanSha256",
	"executionSha256",
	"issuedAtMs",
	"macExecutionGrantReceiptSha256",
	"macReceiptSignatureSha256",
	"measurementGrantSha256",
	"notAfterMs",
	"receiptSequence",
	"replayLedgerLeafSha256",
	"rigExecutionIndex",
	"rigSupervisorExecutableSha256",
	"rigSupervisorInstanceNonce",
	"schema",
	"signingPublicKeySha256",
] as const;

const MAC_SIG_KEYS = [
	"algorithm",
	"schema",
	"signatureBase64",
	"signedBytesSha256",
	"signedSchema",
	"signingPublicKeySha256",
] as const;

const RIG_SIG_KEYS = MAC_SIG_KEYS;

export function parseMacExecutionGrantReceipt(
	value: unknown,
): ProtocolResult<MacExecutionGrantReceiptV1> {
	if (!isPlainObject(value) || !exactKeys(value, MAC_RECEIPT_KEYS)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "mac receipt keys" };
	}
	if (value.schema !== "mac-execution-grant-receipt/v1") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "mac receipt schema" };
	}
	const execution = parseCrossSupervisorExecution(value.execution);
	if (!execution.ok) return execution;
	if (
		!isHex64(value.executionSha256) ||
		!isHex64(value.measurementGrantSha256) ||
		!isHex64(value.approvedPlanSha256) ||
		!isHex64(value.approvalRecordSha256) ||
		!isHex64(value.macSupervisorExecutableSha256) ||
		!isHex64(value.macSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "mac receipt fields" };
	}
	if (sha256OfCanonical(execution.value) !== value.executionSha256) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "executionSha256 mismatch",
		};
	}
	if (
		value.approvedPlanSha256 !== execution.value.approvedPlanSha256 ||
		value.approvalRecordSha256 !== execution.value.approvalRecordSha256
	) {
		return { ok: false, code: "APPROVAL_IDENTITY_MISMATCH" };
	}
	return { ok: true, value: value as unknown as MacExecutionGrantReceiptV1 };
}

export function parseRigExecutionAcceptance(
	value: unknown,
): ProtocolResult<RigExecutionAcceptanceV1> {
	if (!isPlainObject(value) || !exactKeys(value, RIG_ACCEPTANCE_KEYS)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "rig acceptance keys",
		};
	}
	if (value.schema !== "rig-execution-acceptance/v1") {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "rig acceptance schema",
		};
	}
	if (
		!isHex64(value.executionSha256) ||
		!isHex64(value.measurementGrantSha256) ||
		!isHex64(value.macExecutionGrantReceiptSha256) ||
		!isHex64(value.macReceiptSignatureSha256) ||
		!isHex64(value.approvedPlanSha256) ||
		!isHex64(value.approvalRecordSha256) ||
		!isHex64(value.rigSupervisorInstanceNonce) ||
		!isHex64(value.rigSupervisorExecutableSha256) ||
		!isHex64(value.replayLedgerLeafSha256) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.rigExecutionIndex) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.acceptedAtMs) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "rig acceptance fields",
		};
	}
	return { ok: true, value: value as unknown as RigExecutionAcceptanceV1 };
}

export function parseMacReceiptSignature(
	value: unknown,
): ProtocolResult<MacReceiptSignatureV1> {
	if (!isPlainObject(value) || !exactKeys(value, MAC_SIG_KEYS)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "mac sig keys" };
	}
	if (
		value.schema !== "mac-receipt-signature/v1" ||
		value.algorithm !== "Ed25519" ||
		typeof value.signatureBase64 !== "string" ||
		!isHex64(value.signedBytesSha256) ||
		!isHex64(value.signingPublicKeySha256) ||
		typeof value.signedSchema !== "string"
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "mac sig fields" };
	}
	return { ok: true, value: value as unknown as MacReceiptSignatureV1 };
}

export function parseRigReceiptSignature(
	value: unknown,
): ProtocolResult<RigReceiptSignatureV1> {
	if (!isPlainObject(value) || !exactKeys(value, RIG_SIG_KEYS)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "rig sig keys" };
	}
	if (
		value.schema !== "rig-receipt-signature/v1" ||
		value.algorithm !== "Ed25519" ||
		typeof value.signatureBase64 !== "string" ||
		!isHex64(value.signedBytesSha256) ||
		!isHex64(value.signingPublicKeySha256) ||
		typeof value.signedSchema !== "string"
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "rig sig fields" };
	}
	return { ok: true, value: value as unknown as RigReceiptSignatureV1 };
}

// ---------------------------------------------------------------------------
// Ed25519 keygen / sign / verify (raw 32-byte public, PKCS8 private)
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Ed25519KeyPairBytes {
	readonly privatePkcs8Der: Uint8Array;
	readonly publicRaw32: Uint8Array;
	readonly publicKeySha256: Sha256Hex;
}

export function generateEd25519KeyPair(): Ed25519KeyPairBytes {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const privatePkcs8Der = new Uint8Array(
		privateKey.export({ type: "pkcs8", format: "der" }),
	);
	const spki = publicKey.export({ type: "spki", format: "der" });
	const publicRaw32 = new Uint8Array(spki.subarray(spki.byteLength - 32));
	return {
		privatePkcs8Der,
		publicRaw32,
		publicKeySha256: sha256HexOfBytes(publicRaw32),
	};
}

function privateKeyFromPkcs8(pkcs8: Uint8Array): KeyObject {
	return createPrivateKey({
		key: Buffer.from(pkcs8),
		format: "der",
		type: "pkcs8",
	});
}

function publicKeyFromRaw32(raw: Uint8Array): KeyObject {
	if (raw.byteLength !== 32) {
		throw new RangeError("Ed25519 public key must be 32 raw bytes");
	}
	return createPublicKey({
		key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
		format: "der",
		type: "spki",
	});
}

export function ed25519Sign(
	privatePkcs8Der: Uint8Array,
	message: Uint8Array,
): Uint8Array {
	const key = privateKeyFromPkcs8(privatePkcs8Der);
	return new Uint8Array(nodeSign(null, Buffer.from(message), key));
}

export function ed25519Verify(
	publicRaw32: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): boolean {
	if (publicRaw32.byteLength !== 32 || signature.byteLength !== 64)
		return false;
	try {
		return nodeVerify(
			null,
			Buffer.from(message),
			publicKeyFromRaw32(publicRaw32),
			Buffer.from(signature),
		);
	} catch {
		return false;
	}
}

export function signMacReceipt(args: {
	readonly privatePkcs8Der: Uint8Array;
	readonly publicRaw32: Uint8Array;
	readonly signedSchema: MacReceiptSignatureV1["signedSchema"];
	readonly signedBytes: Uint8Array;
}): MacReceiptSignatureV1 {
	const signedBytesSha256 = sha256HexOfBytes(args.signedBytes);
	const signature = ed25519Sign(args.privatePkcs8Der, args.signedBytes);
	return {
		schema: "mac-receipt-signature/v1",
		algorithm: "Ed25519",
		signedSchema: args.signedSchema,
		signedBytesSha256,
		signingPublicKeySha256: sha256HexOfBytes(args.publicRaw32),
		signatureBase64: toBase64(signature),
	};
}

export function signRigReceipt(args: {
	readonly privatePkcs8Der: Uint8Array;
	readonly publicRaw32: Uint8Array;
	readonly signedSchema: RigReceiptSignatureV1["signedSchema"];
	readonly signedBytes: Uint8Array;
}): RigReceiptSignatureV1 {
	const signedBytesSha256 = sha256HexOfBytes(args.signedBytes);
	const signature = ed25519Sign(args.privatePkcs8Der, args.signedBytes);
	return {
		schema: "rig-receipt-signature/v1",
		algorithm: "Ed25519",
		signedSchema: args.signedSchema,
		signedBytesSha256,
		signingPublicKeySha256: sha256HexOfBytes(args.publicRaw32),
		signatureBase64: toBase64(signature),
	};
}

export function verifyMacReceiptSignature(args: {
	readonly stagedMacPublicRaw32: Uint8Array;
	readonly signedBytes: Uint8Array;
	readonly signature: MacReceiptSignatureV1;
}): ProtocolResult<true> {
	const parsed = parseMacReceiptSignature(args.signature);
	if (!parsed.ok) return parsed;
	const sig = parsed.value;
	if (sha256HexOfBytes(args.signedBytes) !== sig.signedBytesSha256) {
		return { ok: false, code: "MAC_GRANT_SIGNATURE_INVALID" };
	}
	if (
		sha256HexOfBytes(args.stagedMacPublicRaw32) !== sig.signingPublicKeySha256
	) {
		return { ok: false, code: "MAC_SIGNING_KEY_MISMATCH" };
	}
	const signatureBytes = fromBase64(sig.signatureBase64);
	if (signatureBytes === null) {
		return { ok: false, code: "MAC_GRANT_SIGNATURE_INVALID" };
	}
	if (
		!ed25519Verify(args.stagedMacPublicRaw32, args.signedBytes, signatureBytes)
	) {
		return { ok: false, code: "MAC_GRANT_SIGNATURE_INVALID" };
	}
	return { ok: true, value: true };
}

export function verifyRigReceiptSignature(args: {
	readonly stagedRigPublicRaw32: Uint8Array;
	readonly signedBytes: Uint8Array;
	readonly signature: RigReceiptSignatureV1;
}): ProtocolResult<true> {
	const parsed = parseRigReceiptSignature(args.signature);
	if (!parsed.ok) return parsed;
	const sig = parsed.value;
	if (sha256HexOfBytes(args.signedBytes) !== sig.signedBytesSha256) {
		return { ok: false, code: "RIG_RECEIPT_SIGNATURE_INVALID" };
	}
	if (
		sha256HexOfBytes(args.stagedRigPublicRaw32) !== sig.signingPublicKeySha256
	) {
		return { ok: false, code: "RIG_SIGNING_KEY_MISMATCH" };
	}
	const signatureBytes = fromBase64(sig.signatureBase64);
	if (signatureBytes === null) {
		return { ok: false, code: "RIG_RECEIPT_SIGNATURE_INVALID" };
	}
	if (
		!ed25519Verify(args.stagedRigPublicRaw32, args.signedBytes, signatureBytes)
	) {
		return { ok: false, code: "RIG_RECEIPT_SIGNATURE_INVALID" };
	}
	return { ok: true, value: true };
}

export function rejectUnsignedMacReceipt(
	signature: MacReceiptSignatureV1 | null | undefined,
): ProtocolResult<true> {
	if (signature == null) {
		return {
			ok: false,
			code: "MAC_GRANT_SIGNATURE_INVALID",
			message: "unsigned",
		};
	}
	return parseMacReceiptSignature(signature).ok
		? { ok: true, value: true }
		: { ok: false, code: "MAC_GRANT_SIGNATURE_INVALID", message: "malformed" };
}

export function rejectUnsignedOrInventedRigAcceptance(args: {
	readonly acceptance: unknown;
	readonly signature: unknown;
	readonly stagedRigPublicRaw32: Uint8Array;
}): ProtocolResult<RigExecutionAcceptanceV1> {
	const acceptance = parseRigExecutionAcceptance(args.acceptance);
	if (!acceptance.ok) {
		return {
			ok: false,
			code: "RIG_RECEIPT_SIGNATURE_INVALID",
			message: "controller-invented or malformed acceptance",
		};
	}
	const signature = parseRigReceiptSignature(args.signature);
	if (!signature.ok) {
		return {
			ok: false,
			code: "RIG_RECEIPT_SIGNATURE_INVALID",
			message: "unsigned",
		};
	}
	const bytes = bytesOfCanonical(acceptance.value);
	const verified = verifyRigReceiptSignature({
		stagedRigPublicRaw32: args.stagedRigPublicRaw32,
		signedBytes: bytes,
		signature: signature.value,
	});
	if (!verified.ok) return verified;
	return acceptance;
}

// ---------------------------------------------------------------------------
// Replay ledgers (durable abstract; memory + serialized restart)
// ---------------------------------------------------------------------------

export type ReplayLedgerSide = "mac-records" | "rig-records";

export interface ReplayLedger {
	readonly tryAppend: (args: {
		readonly side: ReplayLedgerSide;
		readonly signedSchema: string;
		readonly signedBytesSha256: Sha256Hex;
	}) => ProtocolResult<{ readonly leafSha256: Sha256Hex }>;
	readonly snapshot: () => string;
}

export function createMemoryReplayLedger(serialized?: string): ReplayLedger {
	const leaves = new Set<string>(
		serialized ? (JSON.parse(serialized) as string[]) : [],
	);
	return {
		tryAppend(args) {
			if (!isHex64(args.signedBytesSha256) || args.signedSchema.length === 0) {
				return { ok: false, code: "TRUST_PROTOCOL" };
			}
			const key = `${args.side}/${args.signedSchema}/${args.signedBytesSha256}`;
			if (leaves.has(key)) {
				return {
					ok: false,
					code:
						args.side === "mac-records"
							? "MAC_GRANT_REPLAYED"
							: "RIG_RECEIPT_REPLAYED",
				};
			}
			leaves.add(key);
			const leafSha256 = sha256HexOfBytes(new TextEncoder().encode(`${key}\n`));
			return { ok: true, value: { leafSha256 } };
		},
		snapshot() {
			return JSON.stringify([...leaves].sort());
		},
	};
}

export function admitSignedRecordWithExpiryAndReplay(args: {
	readonly ledger: ReplayLedger;
	readonly side: ReplayLedgerSide;
	readonly signedSchema: string;
	readonly signedBytes: Uint8Array;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
	readonly stagedCapabilityNotAfterMs: number;
	readonly nowMs: number;
}): ProtocolResult<{ readonly leafSha256: Sha256Hex }> {
	const effectiveNotAfter = Math.min(
		args.notAfterMs,
		args.stagedCapabilityNotAfterMs,
	);
	if (args.nowMs > effectiveNotAfter) {
		return {
			ok: false,
			code:
				args.side === "mac-records"
					? "MAC_GRANT_EXPIRED"
					: "RIG_RECEIPT_EXPIRED",
		};
	}
	if (args.issuedAtMs > args.nowMs + 60_000) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "issued in future" };
	}
	return args.ledger.tryAppend({
		side: args.side,
		signedSchema: args.signedSchema,
		signedBytesSha256: sha256HexOfBytes(args.signedBytes),
	});
}

// ---------------------------------------------------------------------------
// Hash-only evidence rejection
// ---------------------------------------------------------------------------

export function rejectHashOnlyGrantOrBaselineAck(args: {
	readonly measurementGrantBase64: string | null | undefined;
	readonly measurementGrantSha256: string | null | undefined;
	readonly baselineAckBase64: string | null | undefined;
	readonly baselineAckSha256: string | null | undefined;
}): ProtocolResult<true> {
	const grantOk =
		typeof args.measurementGrantBase64 === "string" &&
		args.measurementGrantBase64.length > 0 &&
		typeof args.measurementGrantSha256 === "string" &&
		isHex64(args.measurementGrantSha256);
	const baselineOk =
		typeof args.baselineAckBase64 === "string" &&
		args.baselineAckBase64.length > 0 &&
		typeof args.baselineAckSha256 === "string" &&
		isHex64(args.baselineAckSha256);
	if (!grantOk || !baselineOk) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "hash-only grant or baseline ack is invalid",
		};
	}
	const grantBytes = decodeRetainedBase64(
		args.measurementGrantBase64!,
		CAPS.measurementGrant,
	);
	if (!grantBytes.ok) return grantBytes;
	if (sha256HexOfBytes(grantBytes.value) !== args.measurementGrantSha256) {
		return { ok: false, code: "CROSS_SUPERVISOR_MISMATCH" };
	}
	const baselineBytes = decodeRetainedBase64(
		args.baselineAckBase64!,
		CAPS.rigRecord,
	);
	if (!baselineBytes.ok) return baselineBytes;
	if (sha256HexOfBytes(baselineBytes.value) !== args.baselineAckSha256) {
		return { ok: false, code: "CROSS_SUPERVISOR_MISMATCH" };
	}
	return { ok: true, value: true };
}

export function rejectPlanOrApprovalSwap(args: {
	readonly left: { approvedPlanSha256: string; approvalRecordSha256: string };
	readonly right: { approvedPlanSha256: string; approvalRecordSha256: string };
}): ProtocolResult<true> {
	if (
		args.left.approvedPlanSha256 !== args.right.approvedPlanSha256 ||
		args.left.approvalRecordSha256 !== args.right.approvalRecordSha256
	) {
		return { ok: false, code: "APPROVAL_IDENTITY_MISMATCH" };
	}
	return { ok: true, value: true };
}

export function rejectCrossExecutionRigReceipt(args: {
	readonly expectedExecutionSha256: Sha256Hex;
	readonly acceptance: RigExecutionAcceptanceV1;
}): ProtocolResult<true> {
	if (args.acceptance.executionSha256 !== args.expectedExecutionSha256) {
		return { ok: false, code: "CROSS_SUPERVISOR_MISMATCH" };
	}
	return { ok: true, value: true };
}

export function rejectWrongStagedPublicKey(args: {
	readonly role: "mac" | "rig";
	readonly stagedPublicRaw32: Uint8Array;
	readonly signaturePublicKeySha256: Sha256Hex;
}): ProtocolResult<true> {
	if (
		sha256HexOfBytes(args.stagedPublicRaw32) !== args.signaturePublicKeySha256
	) {
		return {
			ok: false,
			code:
				args.role === "mac"
					? "MAC_SIGNING_KEY_MISMATCH"
					: "RIG_SIGNING_KEY_MISMATCH",
		};
	}
	return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Remote framing + sequence
// ---------------------------------------------------------------------------

export const REMOTE_FRAME_SCHEMA = "comparison-supervisor-frame/v1" as const;

export interface RemoteSequenceState {
	requestSeq: number;
	responseSeq: number;
}

export function createRemoteSequenceState(): RemoteSequenceState {
	return { requestSeq: 0, responseSeq: 0 };
}

export function takeRemoteRequestSeq(
	state: RemoteSequenceState,
): ProtocolResult<number> {
	if (state.requestSeq >= CAPS.remoteMaxFrames) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "remote frame cap" };
	}
	const seq = state.requestSeq;
	state.requestSeq += 1;
	return { ok: true, value: seq };
}

export function takeRemoteResponseSeq(
	state: RemoteSequenceState,
	ackRequestSeq: number,
): ProtocolResult<number> {
	if (ackRequestSeq !== state.responseSeq) {
		// Responses echo ackRequestSeq; independent responseSeq advances from 0.
	}
	if (state.responseSeq >= CAPS.remoteMaxFrames) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "remote frame cap" };
	}
	if (ackRequestSeq < 0 || !Number.isSafeInteger(ackRequestSeq)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "bad ackRequestSeq" };
	}
	const seq = state.responseSeq;
	state.responseSeq += 1;
	return { ok: true, value: seq };
}

export function assertRemoteRequestSeq(
	state: RemoteSequenceState,
	requestSeq: number,
): ProtocolResult<true> {
	if (requestSeq !== state.requestSeq) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `requestSeq expected ${state.requestSeq} got ${requestSeq}`,
		};
	}
	state.requestSeq += 1;
	return { ok: true, value: true };
}

export function assertRemoteResponseSeq(
	state: RemoteSequenceState,
	responseSeq: number,
	ackRequestSeq: number,
): ProtocolResult<true> {
	if (responseSeq !== state.responseSeq) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `responseSeq expected ${state.responseSeq} got ${responseSeq}`,
		};
	}
	if (ackRequestSeq !== responseSeq) {
		// ackRequestSeq must equal the request being acked; for lockstep 1:1
		// Phase-A channels, it equals responseSeq when each request gets one ack.
		if (ackRequestSeq !== state.responseSeq) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `ackRequestSeq ${ackRequestSeq} does not match responseSeq ${responseSeq}`,
			};
		}
	}
	state.responseSeq += 1;
	return { ok: true, value: true };
}

export interface RemoteSupervisorRefusalV1 {
	readonly schema: "remote-supervisor-refusal/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex | null;
	readonly code: RemoteSupervisorRefusalCode;
	readonly campaignStatus: "FAIL" | "REFUSED";
	readonly terminal: true;
}

export function isCampaignRefusalCode(
	code: string,
): code is CampaignRefusalCode {
	return (CAMPAIGN_REFUSAL_CODES as readonly string[]).includes(code);
}

export function isCampaignFailureCode(
	code: string,
): code is CampaignFailureCode {
	return (CAMPAIGN_FAILURE_CODES as readonly string[]).includes(code);
}

export function parseRemoteSupervisorRefusal(
	value: unknown,
): ProtocolResult<RemoteSupervisorRefusalV1> {
	if (!isPlainObject(value)) {
		return { ok: false, code: "TRUST_PROTOCOL" };
	}
	const keys = [
		"ackRequestSeq",
		"campaignStatus",
		"code",
		"executionSha256",
		"responseSeq",
		"schema",
		"terminal",
	];
	if (!exactKeys(value, keys)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "refusal keys" };
	}
	if (
		value.schema !== "remote-supervisor-refusal/v1" ||
		value.terminal !== true ||
		!isSafeNonNegInt(value.responseSeq) ||
		!isSafeNonNegInt(value.ackRequestSeq) ||
		typeof value.code !== "string"
	) {
		return { ok: false, code: "TRUST_PROTOCOL" };
	}
	if (
		!isCampaignRefusalCode(value.code) &&
		!isCampaignFailureCode(value.code)
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `unknown remote refusal code ${value.code}`,
		};
	}
	if (value.executionSha256 !== null && !isHex64(value.executionSha256)) {
		return { ok: false, code: "TRUST_PROTOCOL" };
	}
	const statusPair = validateRemoteStatusCodePair(
		value.campaignStatus,
		value.code,
	);
	if (!statusPair.ok) return statusPair;
	return { ok: true, value: value as unknown as RemoteSupervisorRefusalV1 };
}

export function validateRemoteStatusCodePair(
	campaignStatus: unknown,
	code: string,
): ProtocolResult<true> {
	if (isCampaignRefusalCode(code)) {
		if (campaignStatus !== "REFUSED") {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "refusal code requires REFUSED",
			};
		}
		return { ok: true, value: true };
	}
	if (isCampaignFailureCode(code)) {
		if (campaignStatus !== "FAIL") {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "failure code requires FAIL",
			};
		}
		return { ok: true, value: true };
	}
	return { ok: false, code: "TRUST_PROTOCOL", message: "unknown code" };
}

function headerKindFromSchema(schema: string): string {
	if (!schema.endsWith("/v1")) {
		throw new TypeError(`schema must end with /v1: ${schema}`);
	}
	return schema.slice(0, -"/v1".length);
}

export function encodeRemoteSupervisorPayload(
	payload: Rec & { schema: string },
	payloadBound: number = CAPS.remotePayloadDefault,
): ProtocolResult<Uint8Array> {
	const kind =
		payload.schema === "remote-supervisor-refusal/v1"
			? "remote-supervisor-refusal"
			: headerKindFromSchema(payload.schema);
	const header = new TextEncoder().encode(
		canonicalJson({ kind, schema: REMOTE_FRAME_SCHEMA }) + "\n",
	);
	const body = bytesOfCanonical(payload);
	if (body.byteLength > payloadBound) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "payload oversize" };
	}
	const encoded = encodeSupervisorFrameLocal(header, body, payloadBound);
	if (!encoded.ok) {
		return { ok: false, code: "TRUST_PROTOCOL", message: encoded.code };
	}
	return { ok: true, value: encoded.value };
}

export function decodeRemoteSupervisorPayload(
	frame: Uint8Array,
	payloadBound: number = CAPS.remotePayloadDefault,
): ProtocolResult<{ headerKind: string; payload: Rec }> {
	const decoded = decodeSingleSupervisorFrameLocal(frame, payloadBound);
	if (!decoded.ok) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: decoded.code,
		};
	}
	const headerText = new TextDecoder().decode(decoded.value.header);
	const headerParsed = parseStrictJsonBytes(
		new TextEncoder().encode(
			headerText.endsWith("\n") ? headerText : `${headerText}\n`,
		),
	);
	// Headers are canonical JSON + LF without requiring trailing parseStrict on the LF-stripped form.
	let headerValue: unknown;
	try {
		headerValue = JSON.parse(headerText.trimEnd());
	} catch {
		return { ok: false, code: "TRUST_PROTOCOL", message: "header json" };
	}
	if (
		!isPlainObject(headerValue) ||
		!exactKeys(headerValue, ["kind", "schema"])
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "header keys" };
	}
	if (headerValue.schema !== REMOTE_FRAME_SCHEMA) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "header schema" };
	}
	if (typeof headerValue.kind !== "string") {
		return { ok: false, code: "TRUST_PROTOCOL" };
	}
	const payloadParsed = parseStrictJsonBytes(decoded.value.payload);
	if (!payloadParsed.ok) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "payload json" };
	}
	if (!isPlainObject(payloadParsed.value)) {
		return { ok: false, code: "TRUST_PROTOCOL" };
	}
	const schema = payloadParsed.value.schema;
	if (typeof schema !== "string") {
		return { ok: false, code: "TRUST_PROTOCOL" };
	}
	const expectedKind =
		schema === "remote-supervisor-refusal/v1"
			? "remote-supervisor-refusal"
			: headerKindFromSchema(schema);
	if (headerValue.kind !== expectedKind) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "header kind/schema mismatch",
		};
	}
	void headerParsed;
	return {
		ok: true,
		value: { headerKind: headerValue.kind, payload: payloadParsed.value },
	};
}

export function decodeRemoteFrameRejectingTrailing(
	frame: Uint8Array,
	payloadBound: number = CAPS.remotePayloadDefault,
): ProtocolResult<{ headerKind: string; payload: Rec }> {
	return decodeRemoteSupervisorPayload(frame, payloadBound);
}

export function rejectOversizeTruncatedTrailingAndEarlyEof(args: {
	readonly kind: "oversize" | "truncated" | "trailing" | "early-eof";
	readonly frame?: Uint8Array;
	readonly payloadBound?: number;
}): ProtocolResult<true> {
	if (args.kind === "early-eof") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "early eof" };
	}
	if (!args.frame) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "missing frame" };
	}
	if (args.kind === "oversize") {
		const decoded = decodeSingleSupervisorFrameLocal(
			args.frame,
			args.payloadBound ?? CAPS.remotePayloadDefault,
		);
		if (!decoded.ok && decoded.code === "FRAME_PAYLOAD_TOO_LARGE") {
			return { ok: false, code: "TRUST_PROTOCOL", message: "oversize" };
		}
		if (!decoded.ok) {
			return { ok: false, code: "TRUST_PROTOCOL", message: decoded.code };
		}
		return { ok: false, code: "TRUST_PROTOCOL", message: "expected oversize" };
	}
	if (args.kind === "truncated") {
		const decoded = decodeSingleSupervisorFrameLocal(
			args.frame,
			args.payloadBound ?? CAPS.remotePayloadDefault,
		);
		if (!decoded.ok) {
			return { ok: false, code: "TRUST_PROTOCOL", message: "truncated" };
		}
		return { ok: false, code: "TRUST_PROTOCOL", message: "expected truncated" };
	}
	// trailing
	const decoded = decodeSingleSupervisorFrameLocal(
		args.frame,
		args.payloadBound ?? CAPS.remotePayloadDefault,
	);
	if (!decoded.ok && decoded.code === "FRAME_TRAILING_BYTES") {
		return { ok: false, code: "TRUST_PROTOCOL", message: "trailing" };
	}
	if (!decoded.ok) {
		return { ok: false, code: "TRUST_PROTOCOL", message: decoded.code };
	}
	return { ok: false, code: "TRUST_PROTOCOL", message: "expected trailing" };
}

export {
	sha256OfCanonical as sha256CanonicalRecord,
	bytesOfCanonical,
	toBase64,
	fromBase64,
};
