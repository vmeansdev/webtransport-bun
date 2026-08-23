/**
 * Versioned, transport-neutral application message envelope.
 *
 * The envelope deliberately has no transport-specific fields.  Adapters can
 * put the returned bytes on a WebSocket message, datagram, or stream and the
 * receiver gets the same run/session/sequence identity and expiry semantics.
 */

export const WIRE_MAGIC = 0x5754;
export const WIRE_VERSION = 1;
export const WIRE_FIXED_HEADER_BYTES = 38;
export const MAX_WIRE_HEADER_BYTES = 0xffff;
export const MAX_WIRE_PAYLOAD_BYTES = 0xffff_ffff;
export const MAX_WIRE_TOTAL_BYTES =
	MAX_WIRE_HEADER_BYTES + MAX_WIRE_PAYLOAD_BYTES;
export const DEFAULT_MAX_WIRE_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_WIRE_BYTES =
	WIRE_FIXED_HEADER_BYTES + 2 * 65_535 + DEFAULT_MAX_WIRE_PAYLOAD_BYTES;

const textEncoder = new TextEncoder();

type IntrinsicGetter<T> = (this: unknown) => T;

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)?.get as IntrinsicGetter<number> | undefined;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"resizable",
)?.get as IntrinsicGetter<boolean> | undefined;
const arrayBufferMaxByteLengthGetter = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"maxByteLength",
)?.get as IntrinsicGetter<number> | undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get as IntrinsicGetter<ArrayBuffer> | undefined;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteOffset",
)?.get as IntrinsicGetter<number> | undefined;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get as IntrinsicGetter<number> | undefined;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"buffer",
)?.get as IntrinsicGetter<ArrayBuffer> | undefined;
const dataViewByteOffsetGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"byteOffset",
)?.get as IntrinsicGetter<number> | undefined;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"byteLength",
)?.get as IntrinsicGetter<number> | undefined;
const arrayBufferIsView = ArrayBuffer.isView;
const dataViewConstructor = DataView;
const uint8ArraySet = Uint8Array.prototype.set;

export interface WireMessage {
	readonly runId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly expiresAtMs: number;
	readonly payload: Uint8Array;
}

export interface WireCodecOptions {
	readonly maxPayloadBytes?: number;
	readonly maxWireBytes?: number;
	readonly nowMs?: number;
	readonly rejectExpired?: boolean;
}

export type WireErrorCode =
	| "invalid-input"
	| "truncated"
	| "malformed"
	| "oversized"
	| "expired";

export class WireFormatError extends Error {
	readonly code: WireErrorCode;

	constructor(code: WireErrorCode, message: string) {
		super(message);
		this.name = "WireFormatError";
		this.code = code;
	}
}

export const WireDecodeError = WireFormatError;

function fail(code: WireErrorCode, message: string): never {
	throw new WireFormatError(code, message);
}

function callIntrinsic<T>(
	getter: IntrinsicGetter<T> | undefined,
	receiver: unknown,
	label: string,
): T {
	if (!getter) fail("invalid-input", `${label} intrinsic is unavailable`);
	try {
		return getter.call(receiver);
	} catch {
		fail("invalid-input", `${label} is not a supported binary value`);
	}
}

function fixedBackingBytes(buffer: unknown): number {
	const byteLength = callIntrinsic(
		arrayBufferByteLengthGetter,
		buffer,
		"ArrayBuffer backing",
	);
	const resizable = arrayBufferResizableGetter
		? callIntrinsic(arrayBufferResizableGetter, buffer, "ArrayBuffer backing")
		: false;
	const maxByteLength = arrayBufferMaxByteLengthGetter
		? callIntrinsic(
				arrayBufferMaxByteLengthGetter,
				buffer,
				"ArrayBuffer backing",
			)
		: byteLength;
	if (resizable || maxByteLength !== byteLength) {
		fail(
			"invalid-input",
			"binary input cannot use a resizable ArrayBuffer backing",
		);
	}
	return byteLength;
}

function intrinsicViewBytes(value: unknown): {
	readonly buffer: ArrayBuffer;
	readonly byteOffset: number;
	readonly byteLength: number;
} {
	if (!arrayBufferIsView(value)) {
		fail("invalid-input", "input must be an ArrayBuffer or ArrayBufferView");
	}
	const isDataView = value instanceof dataViewConstructor;
	const buffer = callIntrinsic(
		isDataView ? dataViewBufferGetter : typedArrayBufferGetter,
		value,
		"ArrayBuffer view",
	);
	const byteOffset = callIntrinsic(
		isDataView ? dataViewByteOffsetGetter : typedArrayByteOffsetGetter,
		value,
		"ArrayBuffer view",
	);
	const byteLength = callIntrinsic(
		isDataView ? dataViewByteLengthGetter : typedArrayByteLengthGetter,
		value,
		"ArrayBuffer view",
	);
	const backingLength = fixedBackingBytes(buffer);
	if (
		!Number.isSafeInteger(byteOffset) ||
		!Number.isSafeInteger(byteLength) ||
		byteOffset < 0 ||
		byteLength < 0 ||
		byteOffset + byteLength > backingLength
	) {
		fail("invalid-input", "ArrayBuffer view has an invalid byte range");
	}
	return { buffer, byteOffset, byteLength };
}

function snapshotViewBytes(value: unknown, label: string): Uint8Array {
	const view = intrinsicViewBytes(value);
	const source = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	const snapshot = new Uint8Array(view.byteLength);
	uint8ArraySet.call(snapshot, source);
	if (!(value instanceof Uint8Array) && label === "payload") {
		fail("invalid-input", "payload must be a Uint8Array");
	}
	return snapshot;
}

function validateLimit(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		fail("invalid-input", `${name} must be a non-negative safe integer`);
	}
	return value;
}

function validatePayloadLimit(name: string, value: number): number {
	const limit = validateLimit(name, value);
	if (limit > MAX_WIRE_PAYLOAD_BYTES) {
		fail("invalid-input", `${name} must fit in a uint32 payload length`);
	}
	return limit;
}

function assertWellFormedUtf16(value: string, label: string): void {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				fail("invalid-input", `${label} contains an unpaired surrogate`);
			}
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			fail("invalid-input", `${label} contains an unpaired surrogate`);
		}
	}
}

type WireMessageSnapshot = {
	readonly runId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly expiresAtMs: number;
	readonly payload: Uint8Array;
};

type WireCodecSnapshot = {
	readonly maxPayloadBytes: unknown;
	readonly maxWireBytes: unknown;
	readonly nowMs: unknown;
	readonly hasNowMs: boolean;
	readonly rejectExpired: unknown;
};

function ownDescriptors(
	value: unknown,
	label: string,
): Record<string, PropertyDescriptor> {
	if (!value || typeof value !== "object") {
		fail("invalid-input", `${label} must be an object`);
	}
	try {
		return Object.getOwnPropertyDescriptors(value);
	} catch {
		fail("invalid-input", `${label} properties could not be inspected`);
	}
}

function readOwnDescriptor(
	descriptors: Record<string, PropertyDescriptor>,
	owner: object,
	name: string,
	label: string,
): unknown {
	const descriptor = descriptors[name];
	if (!descriptor) fail("invalid-input", `${label}.${name} must be own`);
	try {
		return "value" in descriptor
			? descriptor.value
			: descriptor.get?.call(owner);
	} catch {
		fail("invalid-input", `${label}.${name} could not be read`);
	}
}

function snapshotMessage(message: WireMessage): WireMessageSnapshot {
	const descriptors = ownDescriptors(message, "message");
	const owner = message as unknown as object;
	const runId = readOwnDescriptor(descriptors, owner, "runId", "message");
	const sessionId = readOwnDescriptor(
		descriptors,
		owner,
		"sessionId",
		"message",
	);
	const sequence = readOwnDescriptor(descriptors, owner, "sequence", "message");
	const expiresAtMs = readOwnDescriptor(
		descriptors,
		owner,
		"expiresAtMs",
		"message",
	);
	const payload = readOwnDescriptor(descriptors, owner, "payload", "message");
	return {
		runId: runId as string,
		sessionId: sessionId as string,
		sequence: sequence as number,
		expiresAtMs: expiresAtMs as number,
		payload: payload as Uint8Array,
	};
}

function snapshotCodecOptions(options: WireCodecOptions): WireCodecSnapshot {
	const descriptors = ownDescriptors(options, "codec options");
	const owner = options as unknown as object;
	const maxPayloadDescriptor = descriptors.maxPayloadBytes;
	const maxWireDescriptor = descriptors.maxWireBytes;
	const nowDescriptor = descriptors.nowMs;
	const rejectDescriptor = descriptors.rejectExpired;
	return {
		maxPayloadBytes: maxPayloadDescriptor
			? readOwnDescriptor(
					descriptors,
					owner,
					"maxPayloadBytes",
					"codec options",
				)
			: undefined,
		maxWireBytes: maxWireDescriptor
			? readOwnDescriptor(descriptors, owner, "maxWireBytes", "codec options")
			: undefined,
		nowMs: nowDescriptor
			? readOwnDescriptor(descriptors, owner, "nowMs", "codec options")
			: undefined,
		hasNowMs: nowDescriptor !== undefined,
		rejectExpired: rejectDescriptor
			? readOwnDescriptor(descriptors, owner, "rejectExpired", "codec options")
			: undefined,
	};
}

function validateMessage(
	message: WireMessageSnapshot,
	options: WireCodecSnapshot,
): {
	runId: Uint8Array;
	sessionId: Uint8Array;
	sequence: number;
	expiresAtMs: number;
	payload: Uint8Array;
} {
	if (typeof message.runId !== "string" || message.runId.length === 0) {
		fail("invalid-input", "runId must be a non-empty string");
	}
	if (typeof message.sessionId !== "string" || message.sessionId.length === 0) {
		fail("invalid-input", "sessionId must be a non-empty string");
	}
	assertWellFormedUtf16(message.runId, "runId");
	assertWellFormedUtf16(message.sessionId, "sessionId");
	const runId = textEncoder.encode(message.runId);
	const sessionId = textEncoder.encode(message.sessionId);
	if (runId.byteLength > 65_535 || sessionId.byteLength > 65_535) {
		fail("oversized", "runId and sessionId must each fit in 16-bit lengths");
	}
	const sequence = validateLimit("sequence", message.sequence);
	const expiresAtMs = validateLimit("expiresAtMs", message.expiresAtMs);
	if (!(message.payload instanceof Uint8Array)) {
		fail("invalid-input", "payload must be a Uint8Array");
	}
	const payload = snapshotViewBytes(message.payload, "payload");
	const maxPayloadBytes =
		(options.maxPayloadBytes as number | undefined) ??
		DEFAULT_MAX_WIRE_PAYLOAD_BYTES;
	validatePayloadLimit("maxPayloadBytes", maxPayloadBytes);
	if (payload.byteLength > maxPayloadBytes) {
		fail(
			"oversized",
			`payload is ${payload.byteLength} bytes; maximum is ${maxPayloadBytes}`,
		);
	}
	return { runId, sessionId, sequence, expiresAtMs, payload };
}

function validateWireLimit(options: WireCodecSnapshot): number {
	const maxWireBytes =
		(options.maxWireBytes as number | undefined) ?? DEFAULT_MAX_WIRE_BYTES;
	validateLimit("maxWireBytes", maxWireBytes);
	if (maxWireBytes < WIRE_FIXED_HEADER_BYTES + 2) {
		fail(
			"invalid-input",
			`maxWireBytes must fit the fixed header and both identity fields`,
		);
	}
	if (maxWireBytes > MAX_WIRE_TOTAL_BYTES) {
		fail("invalid-input", "maxWireBytes exceeds the compatible wire limit");
	}
	return maxWireBytes;
}

/** Encode one application message as a strict binary envelope. */
export function encodeWireMessage(
	message: WireMessage,
	options: WireCodecOptions = {},
): Uint8Array {
	const codecOptions = snapshotCodecOptions(options);
	const messageSnapshot = snapshotMessage(message);
	const { runId, sessionId, sequence, expiresAtMs, payload } = validateMessage(
		messageSnapshot,
		codecOptions,
	);
	const headerBytes =
		WIRE_FIXED_HEADER_BYTES + runId.byteLength + sessionId.byteLength;
	const totalBytes = headerBytes + payload.byteLength;
	const maxWireBytes = validateWireLimit(codecOptions);
	if (totalBytes > maxWireBytes) {
		fail(
			"oversized",
			`wire message is ${totalBytes} bytes; maximum is ${maxWireBytes}`,
		);
	}
	if (headerBytes > MAX_WIRE_HEADER_BYTES) {
		fail("oversized", "wire header exceeds its 16-bit length field");
	}

	const encoded = new Uint8Array(totalBytes);
	const view = new DataView(
		encoded.buffer,
		encoded.byteOffset,
		encoded.byteLength,
	);
	view.setUint16(0, WIRE_MAGIC, false);
	view.setUint8(2, WIRE_VERSION);
	view.setUint8(3, 0);
	view.setUint16(4, headerBytes, false);
	view.setUint16(6, runId.byteLength, false);
	view.setUint16(8, sessionId.byteLength, false);
	view.setBigUint64(10, BigInt(sequence), false);
	view.setBigUint64(18, BigInt(expiresAtMs), false);
	view.setBigUint64(26, 0n, false);
	view.setUint32(34, payload.byteLength, false);
	encoded.set(runId, WIRE_FIXED_HEADER_BYTES);
	encoded.set(sessionId, WIRE_FIXED_HEADER_BYTES + runId.byteLength);
	encoded.set(payload, headerBytes);
	return encoded;
}

function inputBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (input instanceof ArrayBuffer) {
		const byteLength = fixedBackingBytes(input);
		const source = new Uint8Array(input, 0, byteLength);
		const snapshot = new Uint8Array(byteLength);
		uint8ArraySet.call(snapshot, source);
		return snapshot;
	}
	if (arrayBufferIsView(input)) {
		const view = intrinsicViewBytes(input);
		const source = new Uint8Array(
			view.buffer,
			view.byteOffset,
			view.byteLength,
		);
		const snapshot = new Uint8Array(view.byteLength);
		uint8ArraySet.call(snapshot, source);
		return snapshot;
	}
	fail("invalid-input", "input must be an ArrayBuffer or ArrayBufferView");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		fail("malformed", `${label} is not valid UTF-8`);
	}
}

function decodeSafeInteger(value: bigint, label: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		fail("malformed", `${label} exceeds JavaScript's safe integer range`);
	}
	return Number(value);
}

/** Decode a strict envelope, honoring a view's byteOffset and byteLength. */
export function decodeWireMessage(
	input: ArrayBuffer | ArrayBufferView,
	options: WireCodecOptions = {},
): WireMessage {
	const codecOptions = snapshotCodecOptions(options);
	const bytes = inputBytes(input);
	if (bytes.byteLength < WIRE_FIXED_HEADER_BYTES) {
		fail("truncated", "wire envelope is shorter than its fixed header");
	}
	const maxWireBytes = validateWireLimit(codecOptions);
	if (bytes.byteLength > maxWireBytes) {
		fail(
			"oversized",
			`wire envelope is ${bytes.byteLength} bytes; maximum is ${maxWireBytes}`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(0, false) !== WIRE_MAGIC) {
		fail("malformed", "wire envelope has an invalid magic value");
	}
	if (view.getUint8(2) !== WIRE_VERSION) {
		fail("malformed", "wire envelope has an unsupported version");
	}
	if (view.getUint8(3) !== 0) {
		fail("malformed", "wire envelope has unsupported flags");
	}
	const headerBytes = view.getUint16(4, false);
	const runIdBytes = view.getUint16(6, false);
	const sessionIdBytes = view.getUint16(8, false);
	if (runIdBytes === 0) {
		fail("malformed", "runId length must be non-zero");
	}
	if (sessionIdBytes === 0) {
		fail("malformed", "sessionId length must be non-zero");
	}
	if (headerBytes < WIRE_FIXED_HEADER_BYTES) {
		fail("malformed", "wire header length is smaller than the fixed header");
	}
	const expectedHeaderBytes =
		WIRE_FIXED_HEADER_BYTES + runIdBytes + sessionIdBytes;
	if (headerBytes !== expectedHeaderBytes) {
		fail("malformed", "wire header length does not match identity lengths");
	}
	if (headerBytes > bytes.byteLength) {
		fail("truncated", "wire envelope ends inside its identity fields");
	}

	const sequence = decodeSafeInteger(view.getBigUint64(10, false), "sequence");
	const expiresAtMs = decodeSafeInteger(
		view.getBigUint64(18, false),
		"expiresAtMs",
	);
	if (view.getBigUint64(26, false) !== 0n) {
		fail("malformed", "wire envelope has non-zero reserved timestamp bytes");
	}
	const payloadBytes = view.getUint32(34, false);
	const maxPayloadBytes =
		(codecOptions.maxPayloadBytes as number | undefined) ??
		DEFAULT_MAX_WIRE_PAYLOAD_BYTES;
	validatePayloadLimit("maxPayloadBytes", maxPayloadBytes);
	if (payloadBytes > maxPayloadBytes) {
		fail(
			"oversized",
			`payload is ${payloadBytes} bytes; maximum is ${maxPayloadBytes}`,
		);
	}
	const expectedTotalBytes = headerBytes + payloadBytes;
	if (expectedTotalBytes > bytes.byteLength) {
		fail("truncated", "wire envelope ends inside its payload");
	}
	if (expectedTotalBytes !== bytes.byteLength) {
		fail("malformed", "wire envelope contains trailing bytes");
	}
	const runId = decodeUtf8(
		bytes.subarray(
			WIRE_FIXED_HEADER_BYTES,
			WIRE_FIXED_HEADER_BYTES + runIdBytes,
		),
		"runId",
	);
	const sessionStart = WIRE_FIXED_HEADER_BYTES + runIdBytes;
	const sessionId = decodeUtf8(
		bytes.subarray(sessionStart, sessionStart + sessionIdBytes),
		"sessionId",
	);
	const payload = bytes.slice(headerBytes);
	const message: WireMessage = {
		runId,
		sessionId,
		sequence,
		expiresAtMs,
		payload,
	};
	const rejectingExpired = codecOptions.rejectExpired === true;
	if (rejectingExpired) {
		if (
			!codecOptions.hasNowMs ||
			typeof codecOptions.nowMs !== "number" ||
			!Number.isFinite(codecOptions.nowMs)
		) {
			fail("invalid-input", "rejectExpired requires an own finite nowMs");
		}
	}
	if (codecOptions.hasNowMs && codecOptions.nowMs !== undefined) {
		if (
			typeof codecOptions.nowMs !== "number" ||
			!Number.isFinite(codecOptions.nowMs)
		) {
			fail("invalid-input", "nowMs must be finite");
		}
		if (rejectingExpired && isWireMessageExpired(message, codecOptions.nowMs)) {
			fail("expired", "wire envelope expired before it was decoded");
		}
	}
	return message;
}

export function isWireMessageExpired(
	message: WireMessage,
	nowMs: number,
): boolean {
	if (!Number.isFinite(nowMs)) {
		throw new RangeError("nowMs must be finite");
	}
	const descriptors = ownDescriptors(message, "message");
	const expiresAtMs = readOwnDescriptor(
		descriptors,
		message as unknown as object,
		"expiresAtMs",
		"message",
	);
	validateLimit("expiresAtMs", expiresAtMs as number);
	return nowMs >= (expiresAtMs as number);
}

export const encodeMessage = encodeWireMessage;
export const decodeMessage = decodeWireMessage;
export const isExpired = isWireMessageExpired;
