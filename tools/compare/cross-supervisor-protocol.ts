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

export interface FanoutExpandedDeclaration {
	readonly declaredMessageCount: number;
	readonly declaredMessageBytes: number;
}

/**
 * The §4.1 fanout declaration each Phase B cell must state on the wire.
 *
 * `declaredMessageCount` is the *expanded* delivery count -- the §4.5 measured
 * ingress multiplied by that cell's subscriber count -- and never the offered
 * ingress: a ticker 10k arm offers 100,000 records and owes 10,000,000
 * deliveries. `declaredMessageBytes` is the frozen per-message size (100 for
 * ticker, 128 for chat), which is what the rig verifies each delivery against.
 *
 * The literals live here rather than being derived from `cohort-protocol.ts`
 * because this module deliberately imports no sibling protocol module; the
 * `fanout_declaration_table_matches_seal_path` test is the gate that keeps this
 * table and `sealGrantDeclarationForArm` from drifting apart.
 */
export const FANOUT_EXPANDED_DECLARATION_BY_CELL_ID: Readonly<
	Record<string, FanoutExpandedDeclaration>
> = Object.freeze({
	"ticker-fanout/rate-10000": Object.freeze({
		declaredMessageCount: 10_000_000,
		declaredMessageBytes: 100,
	}),
	"ticker-fanout/rate-50000": Object.freeze({
		declaredMessageCount: 50_000_000,
		declaredMessageBytes: 100,
	}),
	"ticker-fanout/rate-100000": Object.freeze({
		declaredMessageCount: 100_000_000,
		declaredMessageBytes: 100,
	}),
	"chat-fanout/subscribers-1000": Object.freeze({
		declaredMessageCount: 300_000,
		declaredMessageBytes: 128,
	}),
	"chat-fanout/subscribers-5000": Object.freeze({
		declaredMessageCount: 1_500_000,
		declaredMessageBytes: 128,
	}),
	"chat-fanout/subscribers-10000": Object.freeze({
		declaredMessageCount: 3_000_000,
		declaredMessageBytes: 128,
	}),
});

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

/**
 * Refuse a draft whose grant declaration is not the one §4.1 fixes for its cell.
 *
 * Both branches matter. The Phase A branch pins the completed-transfer literals;
 * the fanout branch pins the expanded delivery count, so a draft that declared
 * the offered ingress -- a hundredth of what the relay owes for ticker 10k --
 * is refused here, on the wire, and not only by the controller that built it
 * and the reconstruction that reads it back.
 */
export function validatePhaseADeclaration(
	draft: Pick<
		CrossSupervisorExecutionDraftV1,
		| "cellId"
		| "grantDeclaration"
		| "declaredMessageCount"
		| "declaredMessageBytes"
	>,
): ProtocolResult<true> {
	const fanoutCell = hasOwn(
		FANOUT_EXPANDED_DECLARATION_BY_CELL_ID,
		draft.cellId,
	)
		? FANOUT_EXPANDED_DECLARATION_BY_CELL_ID[draft.cellId]!
		: null;
	if (draft.grantDeclaration === "phase-a-completed-transfer") {
		// Deliberately not "and the cell must not be a fanout cell": the shared
		// Phase-A attestation fixture mints bulk-shaped records under fanout cell
		// ids, and which declaration a real fanout arm must open is the
		// controller's `sealGrantDeclarationForArm` to decide. What this parser
		// owns is that a declaration *claiming* the expansion states it exactly.
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
		return { ok: true, value: true };
	}
	if (fanoutCell === null) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: `fanout declaration on non-fanout cell ${draft.cellId}`,
		};
	}
	if (
		draft.declaredMessageCount !== fanoutCell.declaredMessageCount ||
		draft.declaredMessageBytes !== fanoutCell.declaredMessageBytes
	) {
		return {
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message:
				`fanout declared count/bytes mismatch for ${draft.cellId}: ` +
				`expected ${fanoutCell.declaredMessageCount}x${fanoutCell.declaredMessageBytes}, ` +
				`got ${draft.declaredMessageCount}x${draft.declaredMessageBytes}`,
		};
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

// ---------------------------------------------------------------------------
// Phase-B cohort remote payload registration (plan §3.3, B1).
//
// The frame codec above is deliberately schema-generic: every Phase-A kind
// shares the 1 MiB default bound, so there was nothing for a registry to say.
// Phase B breaks that -- the warmup-manifest export and the cohort evidence
// export are bounded far away from the default -- so the kinds now carry one.
// The registry is additive: no existing frame's bytes, kind string, or bound
// moves, and nothing here switches a production path. It exists so the cohort
// records can travel and so a kind nobody registered is refused before its
// payload is allocated.
// ---------------------------------------------------------------------------

/** §3.3 warmup-manifest export: 256 KiB decoded, 384 KiB encoded. */
export const COHORT_WARMUP_MANIFEST_EXPORT_MAX_DECODED_BYTES = 256 * 1024;
export const COHORT_WARMUP_MANIFEST_EXPORT_MAX_ENCODED_BYTES = 384 * 1024;
/** §3.3 cohort evidence export: 9 MiB decoded, 14 MiB encoded. */
export const COHORT_EVIDENCE_EXPORT_MAX_DECODED_BYTES = 9 * 1024 * 1024;
export const COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES = 14 * 1024 * 1024;
/** §3.3 per-execution evidence budget charged before allocation. */
export const COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES = 20 * 1024 * 1024;

/** Every Phase-A remote payload schema in the §3.3 union, refusal included. */
export const PHASE_A_REMOTE_PAYLOAD_SCHEMAS = [
	"remote-supervisor-refusal/v1",
	"mac-open-execution-request/v1",
	"mac-execution-opened-ack/v1",
	"mac-present-rig-execution-acceptance-request/v1",
	"mac-rig-execution-acceptance-ack/v1",
	"mac-admit-client-series-request/v1",
	"mac-client-series-admitted-ack/v1",
	"mac-present-rig-observation-request/v1",
	"mac-measurement-admission-issued-ack/v1",
	"mac-teardown-execution-request/v1",
	"mac-execution-stopped-ack/v1",
	"rig-accept-execution-request/v1",
	"rig-execution-accepted-ack/v1",
	"rig-spawn-server-request/v1",
	"rig-server-ready-ack/v1",
	"rig-measure-start-request/v1",
	"rig-measure-started-ack/v1",
	"rig-stop-and-capture-request/v1",
	"rig-capture-complete-ack/v1",
	"rig-teardown-server-request/v1",
	"rig-server-stopped-ack/v1",
] as const;

/** The Phase-B cohort payload schemas added to the same §3.3 union. */
export const COHORT_REMOTE_PAYLOAD_SCHEMAS = [
	"mac-open-cohort-request/v1",
	"mac-cohort-opened-ack/v1",
	"mac-present-rig-cohort-acceptance-request/v1",
	"mac-rig-cohort-acceptance-ack/v1",
	"mac-issue-warmup-epoch-request/v1",
	"mac-warmup-epoch-issued-ack/v1",
	"mac-export-warmup-completion-manifest-request/v1",
	"mac-warmup-completion-manifest-exported-ack/v1",
	"mac-issue-start-barrier-request/v1",
	"mac-start-barrier-issued-ack/v1",
	"mac-present-rig-barrier-acceptance-request/v1",
	"mac-rig-barrier-acceptance-ack/v1",
	"mac-export-cohort-evidence-request/v1",
	"mac-cohort-evidence-exported-ack/v1",
	"rig-accept-cohort-request/v1",
	"rig-cohort-accepted-ack/v1",
	"rig-begin-warmup-request/v1",
	"rig-warmup-ready-ack/v1",
	"rig-finish-warmup-request/v1",
	"rig-warmup-drained-ack/v1",
	"rig-present-start-barrier-request/v1",
	"rig-barrier-accepted-ack/v1",
] as const;

export const REMOTE_PAYLOAD_SCHEMAS = [
	...PHASE_A_REMOTE_PAYLOAD_SCHEMAS,
	...COHORT_REMOTE_PAYLOAD_SCHEMAS,
] as const;

export type PhaseARemoteSchema =
	(typeof PHASE_A_REMOTE_PAYLOAD_SCHEMAS)[number];
export type CohortRemoteSchema = (typeof COHORT_REMOTE_PAYLOAD_SCHEMAS)[number];
export type RemotePayloadSchema = PhaseARemoteSchema | CohortRemoteSchema;

export function isCohortRemoteSchema(
	schema: string,
): schema is CohortRemoteSchema {
	return (COHORT_REMOTE_PAYLOAD_SCHEMAS as readonly string[]).includes(schema);
}

export function isPhaseARemoteSchema(
	schema: string,
): schema is PhaseARemoteSchema {
	return (PHASE_A_REMOTE_PAYLOAD_SCHEMAS as readonly string[]).includes(schema);
}

/**
 * Phase-A kinds that are bounded away from the default. Only the admitted
 * series has ever been; it is named here rather than left implicit so the
 * registry is the one place a bound is read from.
 */
const PHASE_A_REMOTE_PAYLOAD_BOUNDS: Partial<
	Record<PhaseARemoteSchema, number>
> = {
	"mac-admit-client-series-request/v1": CAPS.admittedClientSeries,
};

export const COHORT_REMOTE_PAYLOAD_BOUNDS: Readonly<
	Record<CohortRemoteSchema, number>
> = {
	"mac-open-cohort-request/v1": CAPS.remotePayloadDefault,
	"mac-cohort-opened-ack/v1": CAPS.remotePayloadDefault,
	"mac-present-rig-cohort-acceptance-request/v1": CAPS.remotePayloadDefault,
	"mac-rig-cohort-acceptance-ack/v1": CAPS.remotePayloadDefault,
	"mac-issue-warmup-epoch-request/v1": CAPS.remotePayloadDefault,
	"mac-warmup-epoch-issued-ack/v1": CAPS.remotePayloadDefault,
	"mac-export-warmup-completion-manifest-request/v1": CAPS.remotePayloadDefault,
	"mac-warmup-completion-manifest-exported-ack/v1":
		COHORT_WARMUP_MANIFEST_EXPORT_MAX_ENCODED_BYTES,
	"mac-issue-start-barrier-request/v1": CAPS.remotePayloadDefault,
	"mac-start-barrier-issued-ack/v1": CAPS.remotePayloadDefault,
	"mac-present-rig-barrier-acceptance-request/v1": CAPS.remotePayloadDefault,
	"mac-rig-barrier-acceptance-ack/v1": CAPS.remotePayloadDefault,
	"mac-export-cohort-evidence-request/v1": CAPS.remotePayloadDefault,
	"mac-cohort-evidence-exported-ack/v1":
		COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES,
	"rig-accept-cohort-request/v1": CAPS.remotePayloadDefault,
	"rig-cohort-accepted-ack/v1": CAPS.remotePayloadDefault,
	"rig-begin-warmup-request/v1": CAPS.remotePayloadDefault,
	"rig-warmup-ready-ack/v1": CAPS.remotePayloadDefault,
	"rig-finish-warmup-request/v1": CAPS.remotePayloadDefault,
	"rig-warmup-drained-ack/v1": CAPS.remotePayloadDefault,
	"rig-present-start-barrier-request/v1": CAPS.remotePayloadDefault,
	"rig-barrier-accepted-ack/v1": CAPS.remotePayloadDefault,
};

/** The largest bound any registered kind may claim. */
export const REMOTE_REGISTERED_MAX_PAYLOAD_BYTES =
	COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES;

/** The registered payload bound for a schema, or null if it is not a kind. */
export function remotePayloadBoundForSchema(schema: string): number | null {
	if (isCohortRemoteSchema(schema)) {
		return COHORT_REMOTE_PAYLOAD_BOUNDS[schema];
	}
	if (isPhaseARemoteSchema(schema)) {
		return PHASE_A_REMOTE_PAYLOAD_BOUNDS[schema] ?? CAPS.remotePayloadDefault;
	}
	return null;
}

// --- Exact-key shapes for the cohort remote payloads ------------------------
//
// The field table is the runtime authority and the interfaces below are its
// types; the test asserts one against the other so neither can drift alone.
// A table rather than twenty-two hand-written parsers because every cohort
// remote payload is built from the same six scalar shapes -- a hand-written
// copy of the same six checks twenty-two times is where a missed check hides.

type CohortRemoteFieldKind =
	| "seq"
	| "sha256"
	| "base64"
	| "byteSize"
	| "count"
	| "literalTrue";

const BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isStrictBase64(value: unknown): value is Base64 {
	if (typeof value !== "string" || value.length === 0) return false;
	if (value.length % 4 !== 0) return false;
	return BASE64_PATTERN.test(value);
}

function cohortRemoteFieldOk(
	kind: CohortRemoteFieldKind,
	value: unknown,
): boolean {
	switch (kind) {
		case "seq":
		case "count":
			return isSafeNonNegInt(value);
		case "byteSize":
			return isSafeNonNegInt(value) && value > 0;
		case "sha256":
			return isHex64(value);
		case "base64":
			return isStrictBase64(value);
		case "literalTrue":
			return value === true;
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

const COHORT_REMOTE_FIELDS: Readonly<
	Record<CohortRemoteSchema, Readonly<Record<string, CohortRemoteFieldKind>>>
> = {
	"mac-open-cohort-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		scenarioHash: "sha256",
		rolePlanHash: "sha256",
		workloadRolePlanInputBase64: "base64",
		workloadRolePlanInputSha256: "sha256",
		workloadRolePlanInputSize: "byteSize",
	},
	"mac-cohort-opened-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		cohortGrantBase64: "base64",
		cohortGrantSha256: "sha256",
		cohortGrantSignatureBase64: "base64",
	},
	"mac-present-rig-cohort-acceptance-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		rigCohortAcceptanceBase64: "base64",
		rigCohortAcceptanceSignatureBase64: "base64",
	},
	"mac-rig-cohort-acceptance-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		rigCohortAcceptanceSha256: "sha256",
	},
	"mac-issue-warmup-epoch-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		cohortGrantSha256: "sha256",
		rigCohortAcceptanceSha256: "sha256",
	},
	"mac-warmup-epoch-issued-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		cohortWarmupEpochBase64: "base64",
		cohortWarmupEpochSignatureBase64: "base64",
	},
	"mac-export-warmup-completion-manifest-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		cohortWarmupEpochSha256: "sha256",
	},
	"mac-warmup-completion-manifest-exported-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		cohortWarmupEpochSha256: "sha256",
		roleWarmupCompletionManifestBase64: "base64",
		roleWarmupCompletionManifestSha256: "sha256",
		roleWarmupCompletionManifestSize: "byteSize",
		roleWarmupCompletionManifestSignatureBase64: "base64",
		roleWarmupCompletionManifestSignatureSha256: "sha256",
		entryCount: "count",
		terminalWarmupExport: "literalTrue",
	},
	"mac-issue-start-barrier-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		cohortGrantSha256: "sha256",
		rigWarmupDrainedReceiptBase64: "base64",
		rigWarmupDrainedReceiptSignatureBase64: "base64",
		rigMeasureStartAckBase64: "base64",
		rigMeasureStartAckSignatureBase64: "base64",
	},
	"mac-start-barrier-issued-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		cohortStartBarrierBase64: "base64",
		cohortStartBarrierSha256: "sha256",
		cohortStartBarrierSignatureBase64: "base64",
	},
	"mac-present-rig-barrier-acceptance-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		rigBarrierAcceptanceBase64: "base64",
		rigBarrierAcceptanceSignatureBase64: "base64",
	},
	"mac-rig-barrier-acceptance-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		rigBarrierAcceptanceSha256: "sha256",
		roleChildrenMayArm: "literalTrue",
	},
	"mac-export-cohort-evidence-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		cohortAdmissionReceiptSha256: "sha256",
	},
	"mac-cohort-evidence-exported-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		cohortObservationEvidenceBase64: "base64",
		cohortObservationEvidenceSha256: "sha256",
		cohortObservationEvidenceSize: "byteSize",
		terminalExport: "literalTrue",
	},
	// The two acceptance fields are a recorded §3.3 registry edit, and they are
	// the frame's per-execution binding. One rig process serves a whole
	// campaign, so an acceptance read once at process start pins it to
	// execution 1 and refuses the rest; carrying it here is what makes the
	// binding per execution. Names and types are the ones
	// `mac-present-rig-execution-acceptance-request/v1` already uses
	// (plan 566-572), so the edit moves an existing pair rather than
	// inventing a shape.
	"rig-accept-cohort-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		cohortGrantBase64: "base64",
		cohortGrantSignatureBase64: "base64",
		rigExecutionAcceptanceBase64: "base64",
		rigExecutionAcceptanceSignatureBase64: "base64",
	},
	"rig-cohort-accepted-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		cohortGrantSha256: "sha256",
		rigCohortAcceptanceBase64: "base64",
		rigCohortAcceptanceSignatureBase64: "base64",
	},
	"rig-begin-warmup-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		cohortWarmupEpochBase64: "base64",
		cohortWarmupEpochSignatureBase64: "base64",
	},
	"rig-warmup-ready-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		serverWarmupReadySha256: "sha256",
	},
	"rig-finish-warmup-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		roleWarmupCompletionManifestBase64: "base64",
		roleWarmupCompletionManifestSignatureBase64: "base64",
	},
	"rig-warmup-drained-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		serverWarmupDrainedBase64: "base64",
		serverWarmupDrainedSha256: "sha256",
		serverWarmupDrainedSize: "byteSize",
		rigWarmupDrainedReceiptBase64: "base64",
		rigWarmupDrainedReceiptSignatureBase64: "base64",
	},
	"rig-present-start-barrier-request/v1": {
		requestSeq: "seq",
		executionSha256: "sha256",
		cohortStartBarrierBase64: "base64",
		cohortStartBarrierSignatureBase64: "base64",
	},
	"rig-barrier-accepted-ack/v1": {
		responseSeq: "seq",
		ackRequestSeq: "seq",
		executionSha256: "sha256",
		serverStartBarrierAcceptedBase64: "base64",
		serverStartBarrierAcceptedSha256: "sha256",
		serverStartBarrierAcceptedSize: "byteSize",
		rigBarrierAcceptanceBase64: "base64",
		rigBarrierAcceptanceSignatureBase64: "base64",
	},
};

/** The exact sorted key set a cohort remote payload must present. */
export function cohortRemotePayloadKeys(
	schema: CohortRemoteSchema,
): readonly string[] {
	return ["schema", ...Object.keys(COHORT_REMOTE_FIELDS[schema])].sort();
}

// --- The §3.3 cohort payload interfaces ------------------------------------
//
// One interface per registered kind, exactly the plan's key set. The field
// table above is what runs; these are what callers hold. The round-trip test
// walks one literal sample per kind through both, so a key that exists in only
// one of them fails there rather than in B2.

export interface MacOpenCohortRequestV1 {
	readonly schema: "mac-open-cohort-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly scenarioHash: Sha256Hex;
	readonly rolePlanHash: Sha256Hex;
	readonly workloadRolePlanInputBase64: Base64;
	readonly workloadRolePlanInputSha256: Sha256Hex;
	readonly workloadRolePlanInputSize: number;
}
export interface MacCohortOpenedAckV1 {
	readonly schema: "mac-cohort-opened-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantBase64: Base64;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortGrantSignatureBase64: Base64;
}
export interface MacPresentRigCohortAcceptanceRequestV1 {
	readonly schema: "mac-present-rig-cohort-acceptance-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly rigCohortAcceptanceBase64: Base64;
	readonly rigCohortAcceptanceSignatureBase64: Base64;
}
export interface MacRigCohortAcceptanceAckV1 {
	readonly schema: "mac-rig-cohort-acceptance-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly rigCohortAcceptanceSha256: Sha256Hex;
}
export interface MacIssueWarmupEpochRequestV1 {
	readonly schema: "mac-issue-warmup-epoch-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly rigCohortAcceptanceSha256: Sha256Hex;
}
export interface MacWarmupEpochIssuedAckV1 {
	readonly schema: "mac-warmup-epoch-issued-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortWarmupEpochBase64: Base64;
	readonly cohortWarmupEpochSignatureBase64: Base64;
}
export interface MacExportWarmupCompletionManifestRequestV1 {
	readonly schema: "mac-export-warmup-completion-manifest-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
}
export interface MacWarmupCompletionManifestExportedAckV1 {
	readonly schema: "mac-warmup-completion-manifest-exported-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestBase64: Base64;
	readonly roleWarmupCompletionManifestSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSize: number;
	readonly roleWarmupCompletionManifestSignatureBase64: Base64;
	readonly roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
	readonly entryCount: number;
	readonly terminalWarmupExport: true;
}
export interface MacIssueStartBarrierRequestV1 {
	readonly schema: "mac-issue-start-barrier-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly rigWarmupDrainedReceiptBase64: Base64;
	readonly rigWarmupDrainedReceiptSignatureBase64: Base64;
	readonly rigMeasureStartAckBase64: Base64;
	readonly rigMeasureStartAckSignatureBase64: Base64;
}
export interface MacStartBarrierIssuedAckV1 {
	readonly schema: "mac-start-barrier-issued-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierBase64: Base64;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly cohortStartBarrierSignatureBase64: Base64;
}
export interface MacPresentRigBarrierAcceptanceRequestV1 {
	readonly schema: "mac-present-rig-barrier-acceptance-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly rigBarrierAcceptanceBase64: Base64;
	readonly rigBarrierAcceptanceSignatureBase64: Base64;
}
export interface MacRigBarrierAcceptanceAckV1 {
	readonly schema: "mac-rig-barrier-acceptance-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly rigBarrierAcceptanceSha256: Sha256Hex;
	readonly roleChildrenMayArm: true;
}
export interface MacExportCohortEvidenceRequestV1 {
	readonly schema: "mac-export-cohort-evidence-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortAdmissionReceiptSha256: Sha256Hex;
}
export interface MacCohortEvidenceExportedAckV1 {
	readonly schema: "mac-cohort-evidence-exported-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortObservationEvidenceBase64: Base64;
	readonly cohortObservationEvidenceSha256: Sha256Hex;
	readonly cohortObservationEvidenceSize: number;
	readonly terminalExport: true;
}
export interface RigAcceptCohortRequestV1 {
	readonly schema: "rig-accept-cohort-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantBase64: Base64;
	readonly cohortGrantSignatureBase64: Base64;
	readonly rigExecutionAcceptanceBase64: Base64;
	readonly rigExecutionAcceptanceSignatureBase64: Base64;
}
export interface RigCohortAcceptedAckV1 {
	readonly schema: "rig-cohort-accepted-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly rigCohortAcceptanceBase64: Base64;
	readonly rigCohortAcceptanceSignatureBase64: Base64;
}
export interface RigBeginWarmupRequestV1 {
	readonly schema: "rig-begin-warmup-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortWarmupEpochBase64: Base64;
	readonly cohortWarmupEpochSignatureBase64: Base64;
}
export interface RigWarmupReadyAckV1 {
	readonly schema: "rig-warmup-ready-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly serverWarmupReadySha256: Sha256Hex;
}
export interface RigFinishWarmupRequestV1 {
	readonly schema: "rig-finish-warmup-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestBase64: Base64;
	readonly roleWarmupCompletionManifestSignatureBase64: Base64;
}
export interface RigWarmupDrainedAckV1 {
	readonly schema: "rig-warmup-drained-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly serverWarmupDrainedBase64: Base64;
	readonly serverWarmupDrainedSha256: Sha256Hex;
	readonly serverWarmupDrainedSize: number;
	readonly rigWarmupDrainedReceiptBase64: Base64;
	readonly rigWarmupDrainedReceiptSignatureBase64: Base64;
}
export interface RigPresentStartBarrierRequestV1 {
	readonly schema: "rig-present-start-barrier-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierBase64: Base64;
	readonly cohortStartBarrierSignatureBase64: Base64;
}
export interface RigBarrierAcceptedAckV1 {
	readonly schema: "rig-barrier-accepted-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly serverStartBarrierAcceptedBase64: Base64;
	readonly serverStartBarrierAcceptedSha256: Sha256Hex;
	readonly serverStartBarrierAcceptedSize: number;
	readonly rigBarrierAcceptanceBase64: Base64;
	readonly rigBarrierAcceptanceSignatureBase64: Base64;
}

export type CohortRemotePayloadV1 =
	| MacOpenCohortRequestV1
	| MacCohortOpenedAckV1
	| MacPresentRigCohortAcceptanceRequestV1
	| MacRigCohortAcceptanceAckV1
	| MacIssueWarmupEpochRequestV1
	| MacWarmupEpochIssuedAckV1
	| MacExportWarmupCompletionManifestRequestV1
	| MacWarmupCompletionManifestExportedAckV1
	| MacIssueStartBarrierRequestV1
	| MacStartBarrierIssuedAckV1
	| MacPresentRigBarrierAcceptanceRequestV1
	| MacRigBarrierAcceptanceAckV1
	| MacExportCohortEvidenceRequestV1
	| MacCohortEvidenceExportedAckV1
	| RigAcceptCohortRequestV1
	| RigCohortAcceptedAckV1
	| RigBeginWarmupRequestV1
	| RigWarmupReadyAckV1
	| RigFinishWarmupRequestV1
	| RigWarmupDrainedAckV1
	| RigPresentStartBarrierRequestV1
	| RigBarrierAcceptedAckV1;

/**
 * Exact-key parse of one cohort remote payload. Unknown keys, missing keys,
 * and a null standing in for a required scalar all fail: no cohort remote
 * field is nullable, so `null` is never evidence of anything.
 */
export function parseCohortRemotePayload(
	value: unknown,
): ProtocolResult<CohortRemotePayloadV1> {
	if (!isPlainObject(value)) {
		return { ok: false, code: "COHORT_PROTOCOL", message: "not an object" };
	}
	const schema = value.schema;
	if (typeof schema !== "string" || !isCohortRemoteSchema(schema)) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: "unregistered cohort remote schema",
		};
	}
	const fields = COHORT_REMOTE_FIELDS[schema];
	if (!exactKeys(value, cohortRemotePayloadKeys(schema))) {
		return { ok: false, code: "COHORT_PROTOCOL", message: `${schema} keys` };
	}
	for (const [name, kind] of Object.entries(fields)) {
		if (!cohortRemoteFieldOk(kind, value[name])) {
			return {
				ok: false,
				code: "COHORT_PROTOCOL",
				message: `${schema}.${name} is not a valid ${kind}`,
			};
		}
	}
	return { ok: true, value: value as unknown as CohortRemotePayloadV1 };
}

/** Read only the frame header, so the kind is known before the payload is. */
export function peekRemoteFrameKind(frame: Uint8Array): ProtocolResult<string> {
	if (frame.byteLength < 4) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "FRAME_TRUNCATED" };
	}
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const headerLength = view.getUint32(0, false);
	if (headerLength === 0 || headerLength > MAX_FRAME_HEADER_BYTES) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "FRAME_HEADER_INVALID",
		};
	}
	if (frame.byteLength < 4 + headerLength + 8) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "FRAME_TRUNCATED" };
	}
	const headerText = new TextDecoder().decode(
		frame.subarray(4, 4 + headerLength),
	);
	let headerValue: unknown;
	try {
		headerValue = JSON.parse(headerText.trimEnd());
	} catch {
		return { ok: false, code: "TRUST_PROTOCOL", message: "header json" };
	}
	if (
		!isPlainObject(headerValue) ||
		!exactKeys(headerValue, ["kind", "schema"]) ||
		headerValue.schema !== REMOTE_FRAME_SCHEMA ||
		typeof headerValue.kind !== "string"
	) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "header keys" };
	}
	return { ok: true, value: headerValue.kind };
}

/** Encode a registered remote payload at its own bound. */
export function encodeRegisteredRemotePayload(
	payload: Rec & { schema: string },
): ProtocolResult<Uint8Array> {
	const bound = remotePayloadBoundForSchema(payload.schema);
	if (bound === null) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `unregistered remote schema ${payload.schema}`,
		};
	}
	return encodeRemoteSupervisorPayload(payload, bound);
}

/**
 * Decode a remote frame at the bound of the kind its header declares. The
 * header is read first precisely so an oversized payload for a small kind is
 * refused before it is allocated, and an unregistered kind never is.
 */
export function decodeRegisteredRemotePayload(
	frame: Uint8Array,
): ProtocolResult<{ headerKind: string; payload: Rec }> {
	const kind = peekRemoteFrameKind(frame);
	if (!kind.ok) return kind;
	const bound = remotePayloadBoundForSchema(`${kind.value}/v1`);
	if (bound === null) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `unregistered remote kind ${kind.value}`,
		};
	}
	return decodeRemoteSupervisorPayload(frame, bound);
}

// ---------------------------------------------------------------------------
// Phase-A rig payload shapes (B3.5)
//
// §3.3 registers the rig-side spawn/baseline/capture kinds as remote payload
// schemas, and B1 gave exact-key parsers to the cohort kinds only. The cohort
// rig channel still has to send `rig-spawn-server-request/v1`, take the Linux
// baseline through `rig-measure-start-request/v1`, and collect the snapshot
// and relay observation through `rig-stop-and-capture-request/v1`, so those
// six kinds get the same table-driven exact-key treatment here rather than
// being trusted as unparsed records. Nothing below registers a new kind, moves
// a bound, or changes a byte of an existing frame.
// ---------------------------------------------------------------------------

/**
 * Decoded cap for the staged launch record a spawn request carries. Same bound
 * as `secure_fs::measurement::RIG_SPAWN_SERVER_REQUEST_MAX_BYTES`.
 */
export const RIG_SPAWN_SERVER_REQUEST_MAX_BYTES = 65_536;

/** The Phase-A rig kinds the cohort channel speaks. */
export const PHASE_A_RIG_REMOTE_SCHEMAS = [
	"rig-spawn-server-request/v1",
	"rig-server-ready-ack/v1",
	"rig-measure-start-request/v1",
	"rig-measure-started-ack/v1",
	"rig-stop-and-capture-request/v1",
	"rig-capture-complete-ack/v1",
	"rig-teardown-server-request/v1",
	"rig-server-stopped-ack/v1",
] as const;

export type PhaseARigRemoteSchema = (typeof PHASE_A_RIG_REMOTE_SCHEMAS)[number];

export function isPhaseARigRemoteSchema(
	schema: string,
): schema is PhaseARigRemoteSchema {
	return (PHASE_A_RIG_REMOTE_SCHEMAS as readonly string[]).includes(schema);
}

/**
 * The scalar shapes the Phase-A remote kinds are built from -- rig and Mac
 * alike. The cohort table's six kinds do not cover them: fields are nullable,
 * some are frozen string literals, one is a TCP port, and one is an argv array.
 *
 * Shared rather than duplicated per table because the Phase-A Mac frames
 * (plan 697-725) need `base64OrNull`, which already lives here, and the rig
 * teardown ack (plan 928-934) needs `intOrNull` / `stringOrNull` /
 * `literalBoolean`, which nothing had. Two tables validating through one
 * function is what stops the second table drifting into a second reading of
 * "the same kind".
 *
 * `literalBoolean` is a distinct kind rather than a loosening of `literal`'s
 * `value` to `string | boolean`, so no existing spec's type changes.
 */
export type PhaseARemoteFieldSpec =
	| { readonly kind: "seq" }
	| { readonly kind: "positiveInt" }
	| { readonly kind: "intOrNull" }
	| { readonly kind: "sha256" }
	| { readonly kind: "sha256OrNull" }
	| { readonly kind: "base64" }
	| { readonly kind: "base64OrNull" }
	| { readonly kind: "nsString" }
	| { readonly kind: "stringOrNull" }
	| { readonly kind: "port" }
	| { readonly kind: "argv" }
	| { readonly kind: "literal"; readonly value: string }
	| { readonly kind: "literalBoolean"; readonly value: boolean }
	| { readonly kind: "oneOf"; readonly values: readonly string[] };

/**
 * Every kind the shared union carries, named once so a widening cannot be
 * made silently: the regression test walks this list and an added or removed
 * kind moves the count it asserts.
 */
export const PHASE_A_REMOTE_FIELD_KINDS = [
	"seq",
	"positiveInt",
	"intOrNull",
	"sha256",
	"sha256OrNull",
	"base64",
	"base64OrNull",
	"nsString",
	"stringOrNull",
	"port",
	"argv",
	"literal",
	"literalBoolean",
	"oneOf",
] as const;

const NS_STRING_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
/** §3.3 argv is the staged launch record's, not an unbounded command line. */
const PHASE_A_RIG_MAX_ARGV = 32;
const PHASE_A_RIG_MAX_ARGV_BYTES = 4_096;
/**
 * `signal` (plan 933) is a signal name, not a message. Bounded at the same
 * length one argv entry gets, because an unbounded string on a frame that
 * reports how a process died is the one place a refusal is cheaper than a
 * parse.
 */
const PHASE_A_REMOTE_MAX_STRING_BYTES = 4_096;

export function phaseARemoteFieldOk(
	spec: PhaseARemoteFieldSpec,
	value: unknown,
): boolean {
	switch (spec.kind) {
		case "seq":
			return isSafeNonNegInt(value);
		case "positiveInt":
			return isSafeNonNegInt(value) && value > 0;
		case "intOrNull":
			return value === null || Number.isSafeInteger(value);
		case "sha256":
			return isHex64(value);
		case "sha256OrNull":
			return value === null || isHex64(value);
		case "base64":
			return isStrictBase64(value);
		case "base64OrNull":
			return value === null || isStrictBase64(value);
		case "nsString":
			return typeof value === "string" && NS_STRING_PATTERN.test(value);
		case "stringOrNull":
			return (
				value === null ||
				(typeof value === "string" &&
					value.length > 0 &&
					value.length <= PHASE_A_REMOTE_MAX_STRING_BYTES)
			);
		case "port":
			return isSafeNonNegInt(value) && value >= 1 && value <= 65_535;
		case "argv":
			return (
				Array.isArray(value) &&
				value.length > 0 &&
				value.length <= PHASE_A_RIG_MAX_ARGV &&
				value.every(
					(entry) =>
						typeof entry === "string" &&
						entry.length > 0 &&
						entry.length <= PHASE_A_RIG_MAX_ARGV_BYTES,
				)
			);
		case "literal":
			return value === spec.value;
		case "literalBoolean":
			return value === spec.value;
		case "oneOf":
			return typeof value === "string" && spec.values.includes(value);
		default: {
			const _exhaustive: never = spec;
			return _exhaustive;
		}
	}
}

const PHASE_A_RIG_FIELDS: Readonly<
	Record<PhaseARigRemoteSchema, Readonly<Record<string, PhaseARemoteFieldSpec>>>
> = {
	"rig-spawn-server-request/v1": {
		requestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortGrantSha256: { kind: "sha256OrNull" },
		serverEntrypointSha256: { kind: "sha256" },
		bunSha256: { kind: "sha256" },
		addonSha256: { kind: "sha256" },
		stagedServerLaunchRecordBase64: { kind: "base64" },
		stagedServerLaunchRecordSha256: { kind: "sha256" },
		stagedServerLaunchRecordSize: { kind: "positiveInt" },
		bindAddress: { kind: "literal", value: "10.99.0.2" },
		bindPort: { kind: "port" },
		advertisedHost: { kind: "literal", value: "10.99.0.2" },
		tlsServerName: { kind: "literal", value: "wt-compare.local" },
		transport: { kind: "oneOf", values: ["ws", "wt"] },
		serverArgv: { kind: "argv" },
	},
	"rig-server-ready-ack/v1": {
		responseSeq: { kind: "seq" },
		ackRequestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		childPid: { kind: "positiveInt" },
		childPgid: { kind: "positiveInt" },
		childInstanceNonce: { kind: "sha256" },
		serverReadyFrameSha256: { kind: "sha256" },
	},
	"rig-measure-start-request/v1": {
		requestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortGrantSha256: { kind: "sha256OrNull" },
		warmupCompleteSha256: { kind: "sha256OrNull" },
		rigWarmupDrainedReceiptSha256: { kind: "sha256OrNull" },
	},
	"rig-measure-started-ack/v1": {
		responseSeq: { kind: "seq" },
		ackRequestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		rigMeasureStartAckBase64: { kind: "base64" },
		rigMeasureStartAckSignatureBase64: { kind: "base64" },
	},
	"rig-stop-and-capture-request/v1": {
		requestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortStartBarrierSha256: { kind: "sha256OrNull" },
		macStopIssuedAtNs: { kind: "nsString" },
		drainDeadlineMs: { kind: "positiveInt" },
	},
	"rig-capture-complete-ack/v1": {
		responseSeq: { kind: "seq" },
		ackRequestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		snapshotFrameBase64: { kind: "base64" },
		rigServerSnapshotReceiptBase64: { kind: "base64" },
		rigServerSnapshotReceiptSignatureBase64: { kind: "base64" },
		linuxRelayObservationBase64: { kind: "base64OrNull" },
		rigRelayObservationReceiptBase64: { kind: "base64OrNull" },
		rigRelayObservationReceiptSignatureBase64: { kind: "base64OrNull" },
	},
	// Plan 922-935, verbatim. Registration, not widening: both names were
	// already in `PHASE_A_REMOTE_PAYLOAD_SCHEMAS` with no key set, no
	// interface, no parse arm and no sender behind them.
	"rig-teardown-server-request/v1": {
		requestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
	},
	"rig-server-stopped-ack/v1": {
		responseSeq: { kind: "seq" },
		ackRequestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		exitCode: { kind: "intOrNull" },
		signal: { kind: "stringOrNull" },
		// `reaped` is the frame's whole point: the rig waited for the child and
		// saw it exit. A frame that cannot say `true` is not a stopped ack, so
		// the literal is the check rather than a boolean the reader interprets.
		reaped: { kind: "literalBoolean", value: true },
	},
};

/** The exact sorted key set one Phase-A rig payload must present. */
export function phaseARigRemotePayloadKeys(
	schema: PhaseARigRemoteSchema,
): readonly string[] {
	return ["schema", ...Object.keys(PHASE_A_RIG_FIELDS[schema])].sort();
}

export interface RigSpawnServerRequestV1 {
	readonly schema: "rig-spawn-server-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex | null;
	readonly serverEntrypointSha256: Sha256Hex;
	readonly bunSha256: Sha256Hex;
	readonly addonSha256: Sha256Hex;
	readonly stagedServerLaunchRecordBase64: Base64;
	readonly stagedServerLaunchRecordSha256: Sha256Hex;
	readonly stagedServerLaunchRecordSize: number;
	readonly bindAddress: "10.99.0.2";
	readonly bindPort: number;
	readonly advertisedHost: "10.99.0.2";
	readonly tlsServerName: "wt-compare.local";
	readonly transport: "ws" | "wt";
	readonly serverArgv: readonly string[];
}
export interface RigServerReadyAckV1 {
	readonly schema: "rig-server-ready-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: Sha256Hex;
	readonly serverReadyFrameSha256: Sha256Hex;
}
export interface RigMeasureStartRequestV1 {
	readonly schema: "rig-measure-start-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex | null;
	readonly warmupCompleteSha256: Sha256Hex | null;
	readonly rigWarmupDrainedReceiptSha256: Sha256Hex | null;
}
export interface RigMeasureStartedAckV1 {
	readonly schema: "rig-measure-started-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly rigMeasureStartAckBase64: Base64;
	readonly rigMeasureStartAckSignatureBase64: Base64;
}
export interface RigStopAndCaptureRequestV1 {
	readonly schema: "rig-stop-and-capture-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex | null;
	readonly macStopIssuedAtNs: NsString;
	readonly drainDeadlineMs: number;
}
export interface RigCaptureCompleteAckV1 {
	readonly schema: "rig-capture-complete-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly snapshotFrameBase64: Base64;
	readonly rigServerSnapshotReceiptBase64: Base64;
	readonly rigServerSnapshotReceiptSignatureBase64: Base64;
	readonly linuxRelayObservationBase64: Base64 | null;
	readonly rigRelayObservationReceiptBase64: Base64 | null;
	readonly rigRelayObservationReceiptSignatureBase64: Base64 | null;
}
export interface RigTeardownServerRequestV1 {
	readonly schema: "rig-teardown-server-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
}
export interface RigServerStoppedAckV1 {
	readonly schema: "rig-server-stopped-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly reaped: true;
}

export type PhaseARigRemotePayloadV1 =
	| RigSpawnServerRequestV1
	| RigServerReadyAckV1
	| RigMeasureStartRequestV1
	| RigMeasureStartedAckV1
	| RigStopAndCaptureRequestV1
	| RigCaptureCompleteAckV1
	| RigTeardownServerRequestV1
	| RigServerStoppedAckV1;

/** Exact-key parse of one Phase-A rig payload. */
export function parsePhaseARigRemotePayload(
	value: unknown,
): ProtocolResult<PhaseARigRemotePayloadV1> {
	if (!isPlainObject(value)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "not an object" };
	}
	const schema = value.schema;
	if (typeof schema !== "string" || !isPhaseARigRemoteSchema(schema)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "not a phase-A rig remote schema",
		};
	}
	if (!exactKeys(value, phaseARigRemotePayloadKeys(schema))) {
		return { ok: false, code: "TRUST_PROTOCOL", message: `${schema} keys` };
	}
	for (const [name, spec] of Object.entries(PHASE_A_RIG_FIELDS[schema])) {
		if (!phaseARemoteFieldOk(spec, value[name])) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `${schema}.${name} is not a valid ${spec.kind}`,
			};
		}
	}
	return { ok: true, value: value as unknown as PhaseARigRemotePayloadV1 };
}

// ---------------------------------------------------------------------------
// Phase-A Mac payload shapes (B3.5 R3 §2.10 items 7-9)
//
// Two §3.3 kinds carried the whole MAC_JOIN transition and existed only as
// names at `PHASE_A_REMOTE_PAYLOAD_SCHEMAS`: no key set, no interface, no
// parse arm. They cannot be expressed in `COHORT_REMOTE_FIELDS` at all --
// `CohortRemoteFieldKind` has no nullable kind and these two frames carry nine
// `Base64 | null` fields between them (seven on the observation request, two on
// the admission ack; plan 697-725). The nullable kind they need already exists
// one table over, so this table shares `PhaseARemoteFieldSpec` rather than
// inventing a second reading of "a base64 field that may be absent".
//
// Nullable here is not optional: the key is always present and `null` is the
// frame saying the record does not exist for this execution. A missing key is
// still a refusal.
// ---------------------------------------------------------------------------

/** The Phase-A Mac kinds the cohort channel speaks. */
export const PHASE_A_MAC_REMOTE_SCHEMAS = [
	"mac-present-rig-observation-request/v1",
	"mac-measurement-admission-issued-ack/v1",
] as const;

export type PhaseAMacRemoteSchema = (typeof PHASE_A_MAC_REMOTE_SCHEMAS)[number];

export function isPhaseAMacRemoteSchema(
	schema: string,
): schema is PhaseAMacRemoteSchema {
	return (PHASE_A_MAC_REMOTE_SCHEMAS as readonly string[]).includes(schema);
}

const PHASE_A_MAC_FIELDS: Readonly<
	Record<PhaseAMacRemoteSchema, Readonly<Record<string, PhaseARemoteFieldSpec>>>
> = {
	// Plan 697-715. Five of the seven rig records the Mac binds travel here;
	// the other two come from retained `MacCohortSession` state.
	"mac-present-rig-observation-request/v1": {
		requestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		rigExecutionAcceptanceBase64: { kind: "base64" },
		rigExecutionAcceptanceSignatureBase64: { kind: "base64" },
		rigMeasureStartAckBase64: { kind: "base64" },
		rigMeasureStartAckSignatureBase64: { kind: "base64" },
		rigBarrierAcceptanceBase64: { kind: "base64OrNull" },
		rigBarrierAcceptanceSignatureBase64: { kind: "base64OrNull" },
		serverWarmupDrainedBase64: { kind: "base64OrNull" },
		serverStartBarrierAcceptedBase64: { kind: "base64OrNull" },
		snapshotFrameBase64: { kind: "base64" },
		rigServerSnapshotReceiptBase64: { kind: "base64" },
		rigServerSnapshotReceiptSignatureBase64: { kind: "base64" },
		linuxRelayObservationBase64: { kind: "base64OrNull" },
		rigRelayObservationReceiptBase64: { kind: "base64OrNull" },
		rigRelayObservationReceiptSignatureBase64: { kind: "base64OrNull" },
	},
	// Plan 716-725.
	"mac-measurement-admission-issued-ack/v1": {
		responseSeq: { kind: "seq" },
		ackRequestSeq: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		macMeasurementAdmissionReceiptBase64: { kind: "base64" },
		macMeasurementAdmissionSignatureBase64: { kind: "base64" },
		cohortAdmissionReceiptBase64: { kind: "base64OrNull" },
		cohortAdmissionSignatureBase64: { kind: "base64OrNull" },
	},
};

/** The exact sorted key set one Phase-A Mac payload must present. */
export function phaseAMacRemotePayloadKeys(
	schema: PhaseAMacRemoteSchema,
): readonly string[] {
	return ["schema", ...Object.keys(PHASE_A_MAC_FIELDS[schema])].sort();
}

/** The field spec one Phase-A Mac field is validated against. */
export function phaseAMacRemoteFieldSpec(
	schema: PhaseAMacRemoteSchema,
	field: string,
): PhaseARemoteFieldSpec | null {
	return PHASE_A_MAC_FIELDS[schema][field] ?? null;
}

/** The field spec one Phase-A rig field is validated against. */
export function phaseARigRemoteFieldSpec(
	schema: PhaseARigRemoteSchema,
	field: string,
): PhaseARemoteFieldSpec | null {
	return PHASE_A_RIG_FIELDS[schema][field] ?? null;
}

export interface MacPresentRigObservationRequestV1 {
	readonly schema: "mac-present-rig-observation-request/v1";
	readonly requestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly rigExecutionAcceptanceBase64: Base64;
	readonly rigExecutionAcceptanceSignatureBase64: Base64;
	readonly rigMeasureStartAckBase64: Base64;
	readonly rigMeasureStartAckSignatureBase64: Base64;
	readonly rigBarrierAcceptanceBase64: Base64 | null;
	readonly rigBarrierAcceptanceSignatureBase64: Base64 | null;
	readonly serverWarmupDrainedBase64: Base64 | null;
	readonly serverStartBarrierAcceptedBase64: Base64 | null;
	readonly snapshotFrameBase64: Base64;
	readonly rigServerSnapshotReceiptBase64: Base64;
	readonly rigServerSnapshotReceiptSignatureBase64: Base64;
	readonly linuxRelayObservationBase64: Base64 | null;
	readonly rigRelayObservationReceiptBase64: Base64 | null;
	readonly rigRelayObservationReceiptSignatureBase64: Base64 | null;
}
export interface MacMeasurementAdmissionIssuedAckV1 {
	readonly schema: "mac-measurement-admission-issued-ack/v1";
	readonly responseSeq: number;
	readonly ackRequestSeq: number;
	readonly executionSha256: Sha256Hex;
	readonly macMeasurementAdmissionReceiptBase64: Base64;
	readonly macMeasurementAdmissionSignatureBase64: Base64;
	readonly cohortAdmissionReceiptBase64: Base64 | null;
	readonly cohortAdmissionSignatureBase64: Base64 | null;
}

export type PhaseAMacRemotePayloadV1 =
	| MacPresentRigObservationRequestV1
	| MacMeasurementAdmissionIssuedAckV1;

/** Exact-key parse of one Phase-A Mac payload. */
export function parsePhaseAMacRemotePayload(
	value: unknown,
): ProtocolResult<PhaseAMacRemotePayloadV1> {
	if (!isPlainObject(value)) {
		return { ok: false, code: "TRUST_PROTOCOL", message: "not an object" };
	}
	const schema = value.schema;
	if (typeof schema !== "string" || !isPhaseAMacRemoteSchema(schema)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "not a phase-A mac remote schema",
		};
	}
	if (!exactKeys(value, phaseAMacRemotePayloadKeys(schema))) {
		return { ok: false, code: "TRUST_PROTOCOL", message: `${schema} keys` };
	}
	for (const [name, spec] of Object.entries(PHASE_A_MAC_FIELDS[schema])) {
		if (!phaseARemoteFieldOk(spec, value[name])) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `${schema}.${name} is not a valid ${spec.kind}`,
			};
		}
	}
	return { ok: true, value: value as unknown as PhaseAMacRemotePayloadV1 };
}
