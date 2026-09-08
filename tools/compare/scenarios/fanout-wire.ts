/**
 * FanoutWire V1 (plan §4.2): the one reliable wire union both transports speak.
 *
 * Same shape as the A2 cross-supervisor codecs: exact-key parsers that reject
 * unknown fields, typed refusal codes, named caps as exported constants, and
 * canonical JSON through the existing helpers. Nothing here opens a socket,
 * queues a message, or counts a delivery; callers hand in already-received
 * bytes and receive either a typed frame or a typed refusal.
 *
 * Two invariants are load-bearing and are enforced in the codec rather than
 * left to the relay state machine:
 *
 * 1. Warmup and measured frames are mutually exclusive. A warmup frame carries
 *    the signed warmup epoch digest and nonce and must never carry a measured
 *    barrier; a measured frame carries the signed start barrier and must never
 *    carry a warmup epoch or nonce. Mixing them is `WARMUP_PROTOCOL`, so a
 *    warmup record can never be counted as measured traffic or the reverse.
 * 2. `linuxAcceptedOrdinal` is Linux's alone. A publisher-authored frame must
 *    carry `null` for it and for `subscriberId`; only a relay-to-subscriber
 *    frame names both. A publisher therefore cannot author accepted ingress.
 */
import {
	bytesOfCanonical,
	type Base64,
	type NsString,
	type ProtocolResult,
	type Sha256Hex,
} from "../cross-supervisor-protocol.ts";
import {
	COHORT_MAX_PUBLISHERS,
	COHORT_PROTOCOL_FAILURE_CODE,
	COHORT_WORKER_COUNT,
	decodeStrictBase64,
	DELIVERY_CONTEXT_MISMATCH_FAILURE_CODE,
	TOKEN_BASE64_LENGTH,
	TOKEN_MERKLE_MAX_PROOF_LENGTH,
	TOKEN_RAW_BYTES,
	WARMUP_PROTOCOL_FAILURE_CODE,
} from "../cohort-protocol.ts";
import {
	hasOwn,
	isHex64,
	parseStrictJsonBytes,
	sha256HexOfBytes,
} from "../secure-fs.ts";
import {
	contextTagOfDeliveryContextSha256,
	deliveryContextSha256Of,
	FANOUT_MAX_WINDOW_COUNT,
	FANOUT_PAYLOAD_BYTES_VALUES,
	type FanoutPayloadBytes,
} from "./fanout-delivery.ts";

// The compact relay-to-subscriber frame and the delivery-channel discriminator
// live in their own leaf module; this is the one import site for both halves.
export * from "./fanout-delivery.ts";

// ---------------------------------------------------------------------------
// Caps, kinds, and code sets (exact plan values)
// ---------------------------------------------------------------------------

export const FANOUT_WIRE_SCHEMA = "fanout-wire/v1" as const;

/** §4.2 decoded cap for register/accept/refuse/ack/end. */
export const FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES = 4_096;
/** §4.2 decoded cap for data frames; warmup data is the same shape and cap. */
export const FANOUT_DATA_FRAME_MAX_DECODED_BYTES = 1_024;
/** WT reliable streams prefix each logical frame with a u32 big-endian length. */
export const FANOUT_WT_LENGTH_PREFIX_BYTES = 4;

export const FANOUT_WIRE_KINDS = [
	"accept",
	"ack",
	"data",
	"delivery-context",
	"end",
	"refuse",
	"register",
	"warmup-ack",
	"warmup-data",
	"warmup-end",
] as const;
export type FanoutWireKind = (typeof FANOUT_WIRE_KINDS)[number];

/** Kinds capped at 1 KiB; every other kind is capped at 4 KiB. */
export const FANOUT_DATA_KINDS = ["data", "warmup-data"] as const;

export const FANOUT_REFUSE_CODES = [
	"UNKNOWN_TOKEN",
	"TOKEN_REPLAY",
	"WRONG_ROLE",
	"WRONG_SHARD",
	"WRONG_COHORT",
	"DUPLICATE_ROLE",
	"REGISTRATION_CLOSED",
	"FRAME_INVALID",
] as const;
export type FanoutRefuseCode = (typeof FANOUT_REFUSE_CODES)[number];

export const FANOUT_ACK_DISPOSITIONS = [
	"accepted",
	"closed",
	"duplicate",
	"reordered",
] as const;
export type FanoutAckDisposition = (typeof FANOUT_ACK_DISPOSITIONS)[number];

export const FANOUT_ACK_DUPLICATE_CODE =
	"DUPLICATE_PUBLISHER_SEQUENCE" as const;
export const FANOUT_ACK_REORDERED_CODE =
	"REORDERED_PUBLISHER_SEQUENCE" as const;
export const FANOUT_ACK_CLOSED_CODES = [
	"REGISTRATION_CLOSED",
	"RELAY_INGRESS_QUEUE_FULL",
	"SUBSCRIBER_QUEUE_FULL",
	"RELAY_WRITE_TIMEOUT",
	"SUBSCRIBER_DISCONNECTED",
	"MEASUREMENT_WINDOW_CLOSED",
] as const;
export type FanoutAckClosedCode = (typeof FANOUT_ACK_CLOSED_CODES)[number];

export const FANOUT_DIRECTIONS = [
	"publisher-to-relay",
	"relay-to-subscriber",
] as const;
export type FanoutDirection = (typeof FANOUT_DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface FanoutRegisterV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "register";
	readonly cohortGrantSha256: Sha256Hex;
	readonly transport: "ws" | "wt";
	readonly role: "publisher" | "subscriber";
	readonly childId: string;
	readonly roleId: string;
	readonly workerIndex: number | null;
	readonly tokenBase64: Base64;
	readonly tokenSha256: Sha256Hex;
	readonly tokenCommitmentIndex: number;
	readonly tokenMerkleProofSha256: readonly Sha256Hex[];
}

export interface FanoutAcceptV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "accept";
	readonly cohortGrantSha256: Sha256Hex;
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly linuxSessionOrdinal: number;
	readonly linuxAcceptedAtNs: NsString;
	readonly linuxClockId: string;
}

export interface FanoutRefuseV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "refuse";
	readonly cohortGrantSha256: Sha256Hex;
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly code: FanoutRefuseCode;
}

export interface FanoutWarmupDataV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "warmup-data";
	readonly direction: FanoutDirection;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	readonly publisherId: string;
	readonly publisherSequence: number;
	readonly subscriberId: string | null;
	readonly linuxAcceptedOrdinal: number | null;
	readonly payloadBase64: Base64;
	readonly payloadSha256: Sha256Hex;
	readonly payloadBytes: 100 | 128;
}

export interface FanoutWarmupAckV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "warmup-ack";
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	readonly publisherId: string;
	readonly publisherSequence: number;
	readonly disposition: "accepted";
	readonly linuxAcceptedOrdinal: number;
	readonly linuxAcceptedAtNs: NsString;
}

export interface FanoutWarmupEndV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "warmup-end";
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly finalPublisherSequence: number | null;
	readonly reason: "publisher-warmup-complete" | "relay-warmup-drained";
}

export interface FanoutDataV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "data";
	readonly direction: FanoutDirection;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly windowIndex: number;
	readonly publisherId: string;
	readonly publisherSequence: number;
	readonly subscriberId: string | null;
	readonly linuxAcceptedOrdinal: number | null;
	readonly payloadBase64: Base64;
	readonly payloadSha256: Sha256Hex;
	readonly payloadBytes: 100 | 128;
}

export interface FanoutAckCommonV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "ack";
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly windowIndex: number;
	readonly publisherId: string;
	readonly publisherSequence: number;
}

export interface FanoutAckAcceptedV1 extends FanoutAckCommonV1 {
	readonly disposition: "accepted";
	readonly linuxAcceptedOrdinal: number;
	readonly linuxAcceptedAtNs: NsString;
	readonly code: null;
}

export interface FanoutAckDuplicateV1 extends FanoutAckCommonV1 {
	readonly disposition: "duplicate";
	readonly linuxAcceptedOrdinal: null;
	readonly linuxAcceptedAtNs: null;
	readonly code: typeof FANOUT_ACK_DUPLICATE_CODE;
}

export interface FanoutAckReorderedV1 extends FanoutAckCommonV1 {
	readonly disposition: "reordered";
	readonly linuxAcceptedOrdinal: null;
	readonly linuxAcceptedAtNs: null;
	readonly code: typeof FANOUT_ACK_REORDERED_CODE;
}

export interface FanoutAckClosedV1 extends FanoutAckCommonV1 {
	readonly disposition: "closed";
	readonly linuxAcceptedOrdinal: null;
	readonly linuxAcceptedAtNs: null;
	readonly code: FanoutAckClosedCode;
}

export type FanoutAckV1 =
	| FanoutAckAcceptedV1
	| FanoutAckDuplicateV1
	| FanoutAckReorderedV1
	| FanoutAckClosedV1;

export interface FanoutEndV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "end";
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly finalWindowIndex: number;
	readonly finalPublisherSequence: number | null;
	readonly reason: "publisher-complete" | "relay-drained";
}

/**
 * The one JSON frame on a subscriber's delivery channel, sent once per epoch
 * before any compact frame of that epoch. Its digest is over the frame minus
 * `deliveryContextSha256`; the first four digest bytes are the `contextTag`
 * every compact frame of the epoch carries. The worker recomputes the digest
 * from its own admission facts, so a context can only bind a session to the
 * grant, epoch, index and publisher set the worker was admitted under.
 */
export interface FanoutDeliveryContextMeasuredV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "delivery-context";
	readonly epoch: "measured";
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly subscriberId: string;
	readonly subscriberIndex: number;
	readonly publisherIds: readonly string[];
	readonly windowCount: number;
	readonly messageBytes: FanoutPayloadBytes;
	readonly deliveryContextSha256: Sha256Hex;
}

export interface FanoutDeliveryContextWarmupV1 {
	readonly schema: typeof FANOUT_WIRE_SCHEMA;
	readonly kind: "delivery-context";
	readonly epoch: "warmup";
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	readonly subscriberId: string;
	readonly subscriberIndex: number;
	readonly publisherIds: readonly string[];
	readonly windowCount: number;
	readonly messageBytes: FanoutPayloadBytes;
	readonly deliveryContextSha256: Sha256Hex;
}

export type FanoutDeliveryContextV1 =
	| FanoutDeliveryContextMeasuredV1
	| FanoutDeliveryContextWarmupV1;

export type FanoutDeliveryEpoch = FanoutDeliveryContextV1["epoch"];

/** The admission facts a delivery context binds; the worker holds its own copy. */
export type FanoutDeliveryContextFacts =
	| Omit<
			FanoutDeliveryContextMeasuredV1,
			"schema" | "kind" | "deliveryContextSha256"
	  >
	| Omit<
			FanoutDeliveryContextWarmupV1,
			"schema" | "kind" | "deliveryContextSha256"
	  >;

export type FanoutWireV1 =
	| FanoutRegisterV1
	| FanoutAcceptV1
	| FanoutRefuseV1
	| FanoutWarmupDataV1
	| FanoutWarmupAckV1
	| FanoutWarmupEndV1
	| FanoutDataV1
	| FanoutAckV1
	| FanoutEndV1
	| FanoutDeliveryContextV1;

// ---------------------------------------------------------------------------
// Local strict-parse helpers (mirrors of the A2 / §4.1 codec helpers)
// ---------------------------------------------------------------------------

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

const NS_STRING_RE = /^(0|[1-9][0-9]{0,19})$/;

function isNsString(value: unknown): value is NsString {
	return typeof value === "string" && NS_STRING_RE.test(value);
}

function isOneOf<T extends number | string>(
	value: unknown,
	allowed: readonly T[],
): value is T {
	return allowed.includes(value as T);
}

/** `publisher-000000` / `subscriber-009992`: zero-padded, at least six digits. */
const ROLE_ID_RE = /^(publisher|subscriber)-[0-9]{6,}$/;

function wireFail(message: string): {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
} {
	return { ok: false, code: COHORT_PROTOCOL_FAILURE_CODE, message };
}

function warmupFail(message: string): {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
} {
	return { ok: false, code: WARMUP_PROTOCOL_FAILURE_CODE, message };
}

/** Base64 of `n` raw bytes is exactly `4 * ceil(n / 3)` characters with padding. */
export function base64EncodedLength(byteLength: number): number {
	return 4 * Math.ceil(byteLength / 3);
}

/**
 * Fields a warmup frame may never carry: any of them would let a warmup record
 * be replayed inside the measured window.
 */
const MEASURED_FIELDS_FORBIDDEN_IN_WARMUP = [
	"barrierNonce",
	"cohortStartBarrierSha256",
	"windowIndex",
] as const;

/** Fields a measured frame may never carry, for the symmetric reason. */
const WARMUP_FIELDS_FORBIDDEN_IN_MEASURED = [
	"cohortWarmupEpochSha256",
	"warmupNonce",
] as const;

/**
 * Keyed on the epoch, not the kind: every `warmup-*` kind is a warmup frame,
 * but a delivery context carries either epoch under one kind.
 */
function rejectEpochMixing(
	record: Rec,
	epoch: FanoutDeliveryEpoch,
): ProtocolResult<true> {
	const forbidden =
		epoch === "warmup"
			? MEASURED_FIELDS_FORBIDDEN_IN_WARMUP
			: WARMUP_FIELDS_FORBIDDEN_IN_MEASURED;
	for (const field of forbidden) {
		if (hasOwn(record, field)) {
			return warmupFail(`${epoch} frame must not carry ${field}`);
		}
	}
	return { ok: true, value: true };
}

/** Payload base64, digest, and declared size must all agree before use. */
function validatePayload(record: Rec): ProtocolResult<true> {
	if (!isOneOf(record.payloadBytes, FANOUT_PAYLOAD_BYTES_VALUES)) {
		return wireFail("payloadBytes must be exactly 100 or 128");
	}
	if (typeof record.payloadBase64 !== "string") {
		return wireFail("payloadBase64 must be a string");
	}
	// Encoded length is checked before any decode allocation.
	if (
		record.payloadBase64.length !== base64EncodedLength(record.payloadBytes)
	) {
		return wireFail("payload base64 length does not match payloadBytes");
	}
	const payload = decodeStrictBase64(
		record.payloadBase64,
		FANOUT_DATA_FRAME_MAX_DECODED_BYTES,
	);
	if (payload === null || payload.byteLength !== record.payloadBytes) {
		return wireFail("payload does not decode to exactly payloadBytes");
	}
	if (!isHex64(record.payloadSha256)) {
		return wireFail("payloadSha256 is not 64 lowercase hex");
	}
	if (sha256HexOfBytes(payload) !== record.payloadSha256) {
		return wireFail("payloadSha256 does not commit to the carried payload");
	}
	return { ok: true, value: true };
}

/**
 * Only Linux authors accepted ingress. A publisher-to-relay frame names no
 * subscriber and no accepted ordinal; a relay-to-subscriber frame names both.
 */
function validateDirectionAndOrdinal(record: Rec): ProtocolResult<true> {
	if (!isOneOf(record.direction, FANOUT_DIRECTIONS)) {
		return wireFail("direction");
	}
	if (record.direction === "publisher-to-relay") {
		if (record.subscriberId !== null) {
			return wireFail("publisher-authored frame must carry null subscriberId");
		}
		if (record.linuxAcceptedOrdinal !== null) {
			return wireFail(
				"publisher-authored frame must carry null linuxAcceptedOrdinal",
			);
		}
		return { ok: true, value: true };
	}
	if (!isNonEmptyString(record.subscriberId)) {
		return wireFail("relay-to-subscriber frame must name a subscriber");
	}
	if (!ROLE_ID_RE.test(record.subscriberId)) {
		return wireFail("subscriberId is not a canonical role ID");
	}
	if (!isSafeNonNegInt(record.linuxAcceptedOrdinal)) {
		return wireFail(
			"relay-to-subscriber frame must carry a Linux accepted ordinal",
		);
	}
	return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Per-kind parsers
// ---------------------------------------------------------------------------

const REGISTER_KEYS = [
	"childId",
	"cohortGrantSha256",
	"kind",
	"role",
	"roleId",
	"schema",
	"tokenBase64",
	"tokenCommitmentIndex",
	"tokenMerkleProofSha256",
	"tokenSha256",
	"transport",
	"workerIndex",
] as const;

export function parseFanoutRegister(
	value: unknown,
): ProtocolResult<FanoutRegisterV1> {
	if (!isPlainObject(value) || !exactKeys(value, REGISTER_KEYS)) {
		return wireFail("fanout register keys");
	}
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "register" ||
		!isHex64(value.cohortGrantSha256) ||
		(value.transport !== "ws" && value.transport !== "wt") ||
		(value.role !== "publisher" && value.role !== "subscriber") ||
		!isNonEmptyString(value.childId) ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId) ||
		!value.roleId.startsWith(`${value.role}-`) ||
		!isSafeNonNegInt(value.tokenCommitmentIndex) ||
		!Array.isArray(value.tokenMerkleProofSha256)
	) {
		return wireFail("fanout register fields");
	}
	// A publisher has no shard; a subscriber always names its worker. `null` is
	// required rather than omitted so an absent shard cannot read as shard zero.
	if (value.role === "publisher") {
		if (value.workerIndex !== null) {
			return wireFail("publisher register must carry null workerIndex");
		}
	} else if (
		!isSafeNonNegInt(value.workerIndex) ||
		value.workerIndex >= COHORT_WORKER_COUNT
	) {
		return wireFail("subscriber register workerIndex");
	}
	if (
		typeof value.tokenBase64 !== "string" ||
		value.tokenBase64.length !== TOKEN_BASE64_LENGTH
	) {
		return wireFail("token base64 length");
	}
	const token = decodeStrictBase64(value.tokenBase64, TOKEN_RAW_BYTES);
	if (token === null || token.byteLength !== TOKEN_RAW_BYTES) {
		return wireFail("token does not decode to 32 raw bytes");
	}
	if (!isHex64(value.tokenSha256)) return wireFail("tokenSha256");
	if (sha256HexOfBytes(token) !== value.tokenSha256) {
		return wireFail("tokenSha256 does not commit to the carried token");
	}
	if (
		value.tokenMerkleProofSha256.length === 0 ||
		value.tokenMerkleProofSha256.length > TOKEN_MERKLE_MAX_PROOF_LENGTH
	) {
		return wireFail("token merkle proof length out of range");
	}
	for (const sibling of value.tokenMerkleProofSha256) {
		if (!isHex64(sibling)) return wireFail("token merkle sibling not hex64");
	}
	return { ok: true, value: value as unknown as FanoutRegisterV1 };
}

const ACCEPT_KEYS = [
	"cohortGrantSha256",
	"kind",
	"linuxAcceptedAtNs",
	"linuxClockId",
	"linuxSessionOrdinal",
	"role",
	"roleId",
	"schema",
] as const;

export function parseFanoutAccept(
	value: unknown,
): ProtocolResult<FanoutAcceptV1> {
	if (!isPlainObject(value) || !exactKeys(value, ACCEPT_KEYS)) {
		return wireFail("fanout accept keys");
	}
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "accept" ||
		!isHex64(value.cohortGrantSha256) ||
		(value.role !== "publisher" && value.role !== "subscriber") ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId) ||
		!value.roleId.startsWith(`${value.role}-`) ||
		!isSafeNonNegInt(value.linuxSessionOrdinal) ||
		!isNsString(value.linuxAcceptedAtNs) ||
		!isNonEmptyString(value.linuxClockId)
	) {
		return wireFail("fanout accept fields");
	}
	return { ok: true, value: value as unknown as FanoutAcceptV1 };
}

const REFUSE_KEYS = [
	"code",
	"cohortGrantSha256",
	"kind",
	"role",
	"roleId",
	"schema",
] as const;

export function parseFanoutRefuse(
	value: unknown,
): ProtocolResult<FanoutRefuseV1> {
	if (!isPlainObject(value) || !exactKeys(value, REFUSE_KEYS)) {
		return wireFail("fanout refuse keys");
	}
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "refuse" ||
		!isHex64(value.cohortGrantSha256) ||
		(value.role !== "publisher" && value.role !== "subscriber") ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId) ||
		!value.roleId.startsWith(`${value.role}-`) ||
		!isOneOf(value.code, FANOUT_REFUSE_CODES)
	) {
		return wireFail("fanout refuse fields");
	}
	return { ok: true, value: value as unknown as FanoutRefuseV1 };
}

const WARMUP_DATA_KEYS = [
	"cohortGrantSha256",
	"cohortWarmupEpochSha256",
	"direction",
	"kind",
	"linuxAcceptedOrdinal",
	"payloadBase64",
	"payloadBytes",
	"payloadSha256",
	"publisherId",
	"publisherSequence",
	"schema",
	"subscriberId",
	"warmupNonce",
] as const;

export function parseFanoutWarmupData(
	value: unknown,
): ProtocolResult<FanoutWarmupDataV1> {
	if (!isPlainObject(value)) return wireFail("fanout warmup data");
	const mixing = rejectEpochMixing(value, "warmup");
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, WARMUP_DATA_KEYS)) {
		return wireFail("fanout warmup data keys");
	}
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "warmup-data" ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortWarmupEpochSha256) ||
		!isHex64(value.warmupNonce) ||
		!isNonEmptyString(value.publisherId) ||
		!ROLE_ID_RE.test(value.publisherId) ||
		!value.publisherId.startsWith("publisher-") ||
		!isSafeNonNegInt(value.publisherSequence)
	) {
		return wireFail("fanout warmup data fields");
	}
	const direction = validateDirectionAndOrdinal(value);
	if (!direction.ok) return direction;
	const payload = validatePayload(value);
	if (!payload.ok) return payload;
	return { ok: true, value: value as unknown as FanoutWarmupDataV1 };
}

const WARMUP_ACK_KEYS = [
	"cohortGrantSha256",
	"cohortWarmupEpochSha256",
	"disposition",
	"kind",
	"linuxAcceptedAtNs",
	"linuxAcceptedOrdinal",
	"publisherId",
	"publisherSequence",
	"schema",
	"warmupNonce",
] as const;

export function parseFanoutWarmupAck(
	value: unknown,
): ProtocolResult<FanoutWarmupAckV1> {
	if (!isPlainObject(value)) return wireFail("fanout warmup ack");
	const mixing = rejectEpochMixing(value, "warmup");
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, WARMUP_ACK_KEYS)) {
		return wireFail("fanout warmup ack keys");
	}
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "warmup-ack" ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortWarmupEpochSha256) ||
		!isHex64(value.warmupNonce) ||
		!isNonEmptyString(value.publisherId) ||
		!ROLE_ID_RE.test(value.publisherId) ||
		!value.publisherId.startsWith("publisher-") ||
		!isSafeNonNegInt(value.publisherSequence) ||
		value.disposition !== "accepted" ||
		!isSafeNonNegInt(value.linuxAcceptedOrdinal) ||
		!isNsString(value.linuxAcceptedAtNs)
	) {
		return wireFail("fanout warmup ack fields");
	}
	return { ok: true, value: value as unknown as FanoutWarmupAckV1 };
}

const WARMUP_END_KEYS = [
	"cohortGrantSha256",
	"cohortWarmupEpochSha256",
	"finalPublisherSequence",
	"kind",
	"reason",
	"role",
	"roleId",
	"schema",
	"warmupNonce",
] as const;

const WARMUP_END_REASONS = [
	"publisher-warmup-complete",
	"relay-warmup-drained",
] as const;

export function parseFanoutWarmupEnd(
	value: unknown,
): ProtocolResult<FanoutWarmupEndV1> {
	if (!isPlainObject(value)) return wireFail("fanout warmup end");
	const mixing = rejectEpochMixing(value, "warmup");
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, WARMUP_END_KEYS)) {
		return wireFail("fanout warmup end keys");
	}
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "warmup-end" ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortWarmupEpochSha256) ||
		!isHex64(value.warmupNonce) ||
		(value.role !== "publisher" && value.role !== "subscriber") ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId) ||
		!value.roleId.startsWith(`${value.role}-`) ||
		!isOneOf(value.reason, WARMUP_END_REASONS)
	) {
		return wireFail("fanout warmup end fields");
	}
	if (
		value.reason === "publisher-warmup-complete" &&
		value.role !== "publisher"
	) {
		return wireFail("only a publisher completes its own warmup");
	}
	// A publisher always reports the sequence it finished on; a subscriber has
	// no publisher sequence of its own and must carry `null`.
	if (value.role === "publisher") {
		if (!isSafeNonNegInt(value.finalPublisherSequence)) {
			return wireFail("publisher warmup end must report a final sequence");
		}
	} else if (value.finalPublisherSequence !== null) {
		return wireFail("subscriber warmup end must carry null final sequence");
	}
	return { ok: true, value: value as unknown as FanoutWarmupEndV1 };
}

const DATA_KEYS = [
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"direction",
	"kind",
	"linuxAcceptedOrdinal",
	"payloadBase64",
	"payloadBytes",
	"payloadSha256",
	"publisherId",
	"publisherSequence",
	"schema",
	"subscriberId",
	"windowIndex",
] as const;

export function parseFanoutData(value: unknown): ProtocolResult<FanoutDataV1> {
	if (!isPlainObject(value)) return wireFail("fanout data");
	const mixing = rejectEpochMixing(value, "measured");
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, DATA_KEYS)) return wireFail("fanout data keys");
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "data" ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isSafeNonNegInt(value.windowIndex) ||
		value.windowIndex >= FANOUT_MAX_WINDOW_COUNT ||
		!isNonEmptyString(value.publisherId) ||
		!ROLE_ID_RE.test(value.publisherId) ||
		!value.publisherId.startsWith("publisher-") ||
		!isSafeNonNegInt(value.publisherSequence)
	) {
		return wireFail("fanout data fields");
	}
	const direction = validateDirectionAndOrdinal(value);
	if (!direction.ok) return direction;
	const payload = validatePayload(value);
	if (!payload.ok) return payload;
	return { ok: true, value: value as unknown as FanoutDataV1 };
}

const ACK_KEYS = [
	"code",
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"disposition",
	"kind",
	"linuxAcceptedAtNs",
	"linuxAcceptedOrdinal",
	"publisherId",
	"publisherSequence",
	"schema",
	"windowIndex",
] as const;

export function parseFanoutAck(value: unknown): ProtocolResult<FanoutAckV1> {
	if (!isPlainObject(value)) return wireFail("fanout ack");
	const mixing = rejectEpochMixing(value, "measured");
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, ACK_KEYS)) return wireFail("fanout ack keys");
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "ack" ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isSafeNonNegInt(value.windowIndex) ||
		value.windowIndex >= FANOUT_MAX_WINDOW_COUNT ||
		!isNonEmptyString(value.publisherId) ||
		!ROLE_ID_RE.test(value.publisherId) ||
		!value.publisherId.startsWith("publisher-") ||
		!isSafeNonNegInt(value.publisherSequence)
	) {
		return wireFail("fanout ack common fields");
	}
	if (!isOneOf(value.disposition, FANOUT_ACK_DISPOSITIONS)) {
		return wireFail("unknown ack disposition");
	}
	// Only an accepted ack carries an accepted ordinal and instant, and only an
	// accepted ack has a null code. Every other disposition must null both
	// accepted-ingress fields: a number there would fabricate an acceptance.
	if (value.disposition === "accepted") {
		if (value.code !== null) {
			return wireFail("accepted ack must carry a null code");
		}
		if (!isSafeNonNegInt(value.linuxAcceptedOrdinal)) {
			return wireFail("accepted ack must carry a Linux accepted ordinal");
		}
		if (!isNsString(value.linuxAcceptedAtNs)) {
			return wireFail("accepted ack must carry a Linux accepted instant");
		}
		return { ok: true, value: value as unknown as FanoutAckAcceptedV1 };
	}
	if (value.linuxAcceptedOrdinal !== null) {
		return wireFail(
			`${value.disposition} ack must carry null linuxAcceptedOrdinal`,
		);
	}
	if (value.linuxAcceptedAtNs !== null) {
		return wireFail(
			`${value.disposition} ack must carry null linuxAcceptedAtNs`,
		);
	}
	if (value.disposition === "duplicate") {
		if (value.code !== FANOUT_ACK_DUPLICATE_CODE) {
			return wireFail("duplicate ack code");
		}
		return { ok: true, value: value as unknown as FanoutAckDuplicateV1 };
	}
	if (value.disposition === "reordered") {
		if (value.code !== FANOUT_ACK_REORDERED_CODE) {
			return wireFail("reordered ack code");
		}
		return { ok: true, value: value as unknown as FanoutAckReorderedV1 };
	}
	if (!isOneOf(value.code, FANOUT_ACK_CLOSED_CODES)) {
		return wireFail("unknown closed ack code");
	}
	return { ok: true, value: value as unknown as FanoutAckClosedV1 };
}

const END_KEYS = [
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"finalPublisherSequence",
	"finalWindowIndex",
	"kind",
	"reason",
	"role",
	"roleId",
	"schema",
] as const;

const END_REASONS = ["publisher-complete", "relay-drained"] as const;

export function parseFanoutEnd(value: unknown): ProtocolResult<FanoutEndV1> {
	if (!isPlainObject(value)) return wireFail("fanout end");
	const mixing = rejectEpochMixing(value, "measured");
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, END_KEYS)) return wireFail("fanout end keys");
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "end" ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		(value.role !== "publisher" && value.role !== "subscriber") ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId) ||
		!value.roleId.startsWith(`${value.role}-`) ||
		!isSafeNonNegInt(value.finalWindowIndex) ||
		value.finalWindowIndex >= FANOUT_MAX_WINDOW_COUNT ||
		!isOneOf(value.reason, END_REASONS)
	) {
		return wireFail("fanout end fields");
	}
	if (value.reason === "publisher-complete" && value.role !== "publisher") {
		return wireFail("only a publisher completes its own stream");
	}
	if (value.role === "publisher") {
		if (!isSafeNonNegInt(value.finalPublisherSequence)) {
			return wireFail("publisher end must report a final sequence");
		}
	} else if (value.finalPublisherSequence !== null) {
		return wireFail("subscriber end must carry null final sequence");
	}
	return { ok: true, value: value as unknown as FanoutEndV1 };
}

const DELIVERY_CONTEXT_COMMON_KEYS = [
	"cohortGrantSha256",
	"deliveryContextSha256",
	"epoch",
	"kind",
	"messageBytes",
	"publisherIds",
	"schema",
	"subscriberId",
	"subscriberIndex",
	"windowCount",
] as const;

const DELIVERY_CONTEXT_MEASURED_KEYS = [
	...DELIVERY_CONTEXT_COMMON_KEYS,
	"cohortStartBarrierSha256",
].sort();

const DELIVERY_CONTEXT_WARMUP_KEYS = [
	...DELIVERY_CONTEXT_COMMON_KEYS,
	"cohortWarmupEpochSha256",
	"warmupNonce",
].sort();

/** The header carries `subscriberIndex` as a u32. */
const SUBSCRIBER_INDEX_MAX = 0xffff_ffff;

function isPublisherIdList(value: unknown): value is readonly string[] {
	if (!Array.isArray(value) || value.length === 0) return false;
	if (value.length > COHORT_MAX_PUBLISHERS) return false;
	let previous = "";
	for (const id of value) {
		if (
			!isNonEmptyString(id) ||
			!ROLE_ID_RE.test(id) ||
			!id.startsWith("publisher-") ||
			id <= previous
		) {
			return false;
		}
		previous = id;
	}
	return true;
}

/**
 * Exact keys per epoch, the epoch's forbidden set, and a digest that commits
 * to every other key. A context that fails here never reaches the worker's
 * recompute, and a compact frame can never be bound through it.
 */
export function parseFanoutDeliveryContext(
	value: unknown,
): ProtocolResult<FanoutDeliveryContextV1> {
	if (!isPlainObject(value)) return wireFail("fanout delivery context");
	if (value.epoch !== "warmup" && value.epoch !== "measured") {
		return wireFail("delivery context epoch is not warmup or measured");
	}
	const epoch: FanoutDeliveryEpoch = value.epoch;
	const mixing = rejectEpochMixing(value, epoch);
	if (!mixing.ok) return mixing;
	const keys =
		epoch === "warmup"
			? DELIVERY_CONTEXT_WARMUP_KEYS
			: DELIVERY_CONTEXT_MEASURED_KEYS;
	if (!exactKeys(value, keys)) return wireFail("delivery context keys");
	if (
		value.schema !== FANOUT_WIRE_SCHEMA ||
		value.kind !== "delivery-context" ||
		!isHex64(value.cohortGrantSha256) ||
		!isNonEmptyString(value.subscriberId) ||
		!ROLE_ID_RE.test(value.subscriberId) ||
		!value.subscriberId.startsWith("subscriber-") ||
		!isSafeNonNegInt(value.subscriberIndex) ||
		value.subscriberIndex > SUBSCRIBER_INDEX_MAX ||
		!isPublisherIdList(value.publisherIds) ||
		!isSafeNonNegInt(value.windowCount) ||
		value.windowCount === 0 ||
		value.windowCount > FANOUT_MAX_WINDOW_COUNT ||
		!isOneOf(value.messageBytes, FANOUT_PAYLOAD_BYTES_VALUES) ||
		!isHex64(value.deliveryContextSha256)
	) {
		return wireFail("delivery context fields");
	}
	if (epoch === "warmup") {
		if (
			!isHex64(value.cohortWarmupEpochSha256) ||
			!isHex64(value.warmupNonce)
		) {
			return wireFail("delivery context warmup epoch fields");
		}
	} else if (!isHex64(value.cohortStartBarrierSha256)) {
		return wireFail("delivery context start barrier");
	}
	const { deliveryContextSha256, ...preimage } = value;
	if (deliveryContextSha256Of(preimage) !== deliveryContextSha256) {
		return wireFail("deliveryContextSha256 does not commit to the context");
	}
	return { ok: true, value: value as unknown as FanoutDeliveryContextV1 };
}

/** The relay's builder: digest the facts, then hold the result to the parser. */
export function buildFanoutDeliveryContext(
	facts: FanoutDeliveryContextFacts,
): ProtocolResult<FanoutDeliveryContextV1> {
	const preimage: Rec = {
		...facts,
		schema: FANOUT_WIRE_SCHEMA,
		kind: "delivery-context",
	};
	return parseFanoutDeliveryContext({
		...preimage,
		deliveryContextSha256: deliveryContextSha256Of(preimage),
	});
}

/**
 * The worker's check at consumption: rebuild the context from its own
 * admission facts and require the received digest to be that one. Anything
 * else on the delivery channel in the context's place, or a context bound to
 * another grant, epoch, session or publisher set, is `DELIVERY_CONTEXT_MISMATCH`.
 */
export function verifyFanoutDeliveryContext(
	received: unknown,
	facts: FanoutDeliveryContextFacts,
): ProtocolResult<{
	readonly frame: FanoutDeliveryContextV1;
	readonly contextTag: number;
}> {
	const expected = buildFanoutDeliveryContext(facts);
	if (!expected.ok) return expected;
	const parsed = parseFanoutDeliveryContext(received);
	if (!parsed.ok) {
		return {
			ok: false,
			code: DELIVERY_CONTEXT_MISMATCH_FAILURE_CODE,
			message: `delivery channel did not carry a delivery context: ${parsed.message ?? parsed.code}`,
		};
	}
	if (
		parsed.value.deliveryContextSha256 !== expected.value.deliveryContextSha256
	) {
		return {
			ok: false,
			code: DELIVERY_CONTEXT_MISMATCH_FAILURE_CODE,
			message: `${parsed.value.epoch} delivery context does not match this session's admission`,
		};
	}
	return {
		ok: true,
		value: {
			frame: parsed.value,
			contextTag: contextTagOfDeliveryContextSha256(
				parsed.value.deliveryContextSha256,
			),
		},
	};
}

/** Dispatch on `kind`; an unknown kind is refused before any field is read. */
export function parseFanoutWire(value: unknown): ProtocolResult<FanoutWireV1> {
	if (!isPlainObject(value)) return wireFail("fanout frame is not an object");
	if (value.schema !== FANOUT_WIRE_SCHEMA) return wireFail("fanout schema");
	if (!isOneOf(value.kind, FANOUT_WIRE_KINDS)) {
		return wireFail("unknown fanout frame kind");
	}
	switch (value.kind) {
		case "register":
			return parseFanoutRegister(value);
		case "accept":
			return parseFanoutAccept(value);
		case "refuse":
			return parseFanoutRefuse(value);
		case "warmup-data":
			return parseFanoutWarmupData(value);
		case "warmup-ack":
			return parseFanoutWarmupAck(value);
		case "warmup-end":
			return parseFanoutWarmupEnd(value);
		case "data":
			return parseFanoutData(value);
		case "ack":
			return parseFanoutAck(value);
		case "delivery-context":
			return parseFanoutDeliveryContext(value);
		default:
			return parseFanoutEnd(value);
	}
}

// ---------------------------------------------------------------------------
// Epoch bindings
// ---------------------------------------------------------------------------

export function isWarmupFanoutKind(kind: string): boolean {
	return kind.startsWith("warmup-");
}

/** Every `warmup-*` kind is a warmup frame; a delivery context is its epoch. */
export function isWarmupFanoutFrame(frame: FanoutWireV1): boolean {
	if (frame.kind === "delivery-context") return frame.epoch === "warmup";
	return isWarmupFanoutKind(frame.kind);
}

/**
 * A warmup frame is admissible only against the authenticated grant, warmup
 * epoch digest, and nonce it was minted under. Cross-epoch replay and
 * measured-as-warmup are both `WARMUP_PROTOCOL`.
 */
export function requireWarmupFrameBinding(
	frame: unknown,
	expected: {
		readonly cohortGrantSha256: Sha256Hex;
		readonly cohortWarmupEpochSha256: Sha256Hex;
		readonly warmupNonce: Sha256Hex;
	},
): ProtocolResult<true> {
	const parsed = parseFanoutWire(frame);
	if (!parsed.ok) return parsed;
	if (!isWarmupFanoutFrame(parsed.value)) {
		return warmupFail("measured frame presented as warmup");
	}
	const warmup = parsed.value as
		| FanoutWarmupDataV1
		| FanoutWarmupAckV1
		| FanoutWarmupEndV1
		| FanoutDeliveryContextWarmupV1;
	if (warmup.cohortGrantSha256 !== expected.cohortGrantSha256) {
		return warmupFail("warmup frame names another cohort grant");
	}
	if (warmup.cohortWarmupEpochSha256 !== expected.cohortWarmupEpochSha256) {
		return warmupFail("warmup frame names another warmup epoch");
	}
	if (warmup.warmupNonce !== expected.warmupNonce) {
		return warmupFail("warmup frame names another warmup nonce");
	}
	return { ok: true, value: true };
}

/**
 * A measured frame is admissible only against the authenticated grant and the
 * exact start barrier the rig accepted. Warmup-as-measured is
 * `WARMUP_PROTOCOL`; a foreign barrier is `COHORT_PROTOCOL`.
 */
export function requireMeasuredFrameBinding(
	frame: unknown,
	expected: {
		readonly cohortGrantSha256: Sha256Hex;
		readonly cohortStartBarrierSha256: Sha256Hex;
	},
): ProtocolResult<true> {
	const parsed = parseFanoutWire(frame);
	if (!parsed.ok) return parsed;
	if (isWarmupFanoutFrame(parsed.value)) {
		return warmupFail("warmup frame presented as measured");
	}
	if (
		parsed.value.kind === "register" ||
		parsed.value.kind === "accept" ||
		parsed.value.kind === "refuse"
	) {
		return wireFail("registration frames carry no measured barrier");
	}
	const measured = parsed.value as
		| FanoutDataV1
		| FanoutAckV1
		| FanoutEndV1
		| FanoutDeliveryContextMeasuredV1;
	if (measured.cohortGrantSha256 !== expected.cohortGrantSha256) {
		return wireFail("measured frame names another cohort grant");
	}
	if (measured.cohortStartBarrierSha256 !== expected.cohortStartBarrierSha256) {
		return wireFail("measured frame names another start barrier");
	}
	return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Framing: WS one binary message per frame, WT u32be length prefix
// ---------------------------------------------------------------------------

/** 1 KiB for data-bearing kinds, 4 KiB for control kinds. */
export function fanoutFrameMaxDecodedBytes(kind: string): number {
	return isOneOf(kind, FANOUT_DATA_KINDS)
		? FANOUT_DATA_FRAME_MAX_DECODED_BYTES
		: FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES;
}

/** Canonical bytes of a validated frame, refused if they exceed the kind cap. */
export function encodeFanoutFrameBytes(
	frame: unknown,
): ProtocolResult<Uint8Array> {
	const parsed = parseFanoutWire(frame);
	if (!parsed.ok) return parsed;
	const bytes = bytesOfCanonical(parsed.value);
	const cap = fanoutFrameMaxDecodedBytes(parsed.value.kind);
	if (bytes.byteLength > cap) {
		return wireFail(
			`${parsed.value.kind} frame ${bytes.byteLength} exceeds cap ${cap}`,
		);
	}
	return { ok: true, value: bytes };
}

/** WS sends exactly one logical frame per binary message. */
export function encodeFanoutWsMessage(
	frame: unknown,
): ProtocolResult<Uint8Array> {
	return encodeFanoutFrameBytes(frame);
}

/**
 * The whole binary message must be exactly one canonical frame: trailing bytes
 * are refused rather than ignored, so two concatenated frames never read as one.
 */
export function decodeFanoutWsMessage(
	message: Uint8Array,
): ProtocolResult<FanoutWireV1> {
	if (message.byteLength === 0) return wireFail("empty fanout message");
	if (message.byteLength > FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES) {
		return wireFail(
			`fanout message ${message.byteLength} exceeds cap ${FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES}`,
		);
	}
	const json = parseStrictJsonBytes(message);
	if (!json.ok) return wireFail(`fanout message json ${json.reason}`);
	const parsed = parseFanoutWire(json.value);
	if (!parsed.ok) return parsed;
	const cap = fanoutFrameMaxDecodedBytes(parsed.value.kind);
	if (message.byteLength > cap) {
		return wireFail(
			`${parsed.value.kind} frame ${message.byteLength} exceeds cap ${cap}`,
		);
	}
	// Re-encoding must reproduce the exact bytes: a non-canonical encoding of an
	// otherwise valid frame would carry a different digest than what was signed.
	const canonical = bytesOfCanonical(parsed.value);
	if (canonical.byteLength !== message.byteLength) {
		return wireFail("fanout message bytes are not canonical");
	}
	for (let index = 0; index < canonical.byteLength; index += 1) {
		if (canonical[index] !== message[index]) {
			return wireFail("fanout message bytes are not canonical");
		}
	}
	return parsed;
}

/** WT reliable streams: `u32be length || canonical frame bytes`. */
export function encodeFanoutWtFrame(
	frame: unknown,
): ProtocolResult<Uint8Array> {
	const bytes = encodeFanoutFrameBytes(frame);
	if (!bytes.ok) return bytes;
	const out = new Uint8Array(
		FANOUT_WT_LENGTH_PREFIX_BYTES + bytes.value.byteLength,
	);
	new DataView(out.buffer).setUint32(0, bytes.value.byteLength, false);
	out.set(bytes.value, FANOUT_WT_LENGTH_PREFIX_BYTES);
	return { ok: true, value: out };
}

/**
 * Decode a whole reliable-stream buffer into frames. A short prefix, a length
 * over the control cap, a truncated body, or leftover bytes all refuse: a
 * partially-read stream is never handed back as a shorter valid sequence.
 */
export function decodeFanoutWtStream(
	stream: Uint8Array,
): ProtocolResult<readonly FanoutWireV1[]> {
	const frames: FanoutWireV1[] = [];
	let offset = 0;
	const view = new DataView(
		stream.buffer,
		stream.byteOffset,
		stream.byteLength,
	);
	while (offset < stream.byteLength) {
		if (stream.byteLength - offset < FANOUT_WT_LENGTH_PREFIX_BYTES) {
			return wireFail("truncated fanout length prefix");
		}
		const length = view.getUint32(offset, false);
		offset += FANOUT_WT_LENGTH_PREFIX_BYTES;
		// The declared length is checked against the cap before any slice is
		// taken, so an absurd prefix cannot drive an allocation.
		if (length === 0) return wireFail("zero-length fanout frame");
		if (length > FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES) {
			return wireFail(
				`fanout frame length ${length} exceeds cap ${FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES}`,
			);
		}
		if (stream.byteLength - offset < length) {
			return wireFail("truncated fanout frame body");
		}
		const decoded = decodeFanoutWsMessage(
			stream.subarray(offset, offset + length),
		);
		if (!decoded.ok) return decoded;
		frames.push(decoded.value);
		offset += length;
	}
	if (frames.length === 0) return wireFail("empty fanout stream");
	return { ok: true, value: frames };
}
