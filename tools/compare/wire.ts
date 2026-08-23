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
export const DEFAULT_MAX_WIRE_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_WIRE_BYTES =
	WIRE_FIXED_HEADER_BYTES + 2 * 65_535 + DEFAULT_MAX_WIRE_PAYLOAD_BYTES;

const textEncoder = new TextEncoder();

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

function validateLimit(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		fail("invalid-input", `${name} must be a non-negative safe integer`);
	}
	return value;
}

function validateMessage(
	message: WireMessage,
	options: WireCodecOptions,
): {
	runId: Uint8Array;
	sessionId: Uint8Array;
	sequence: number;
	expiresAtMs: number;
	payload: Uint8Array;
} {
	if (!message || typeof message !== "object") {
		fail("invalid-input", "message must be an object");
	}
	if (typeof message.runId !== "string" || message.runId.length === 0) {
		fail("invalid-input", "runId must be a non-empty string");
	}
	if (typeof message.sessionId !== "string" || message.sessionId.length === 0) {
		fail("invalid-input", "sessionId must be a non-empty string");
	}
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
	const payload = message.payload;
	const maxPayloadBytes =
		options.maxPayloadBytes ?? DEFAULT_MAX_WIRE_PAYLOAD_BYTES;
	validateLimit("maxPayloadBytes", maxPayloadBytes);
	if (payload.byteLength > maxPayloadBytes) {
		fail(
			"oversized",
			`payload is ${payload.byteLength} bytes; maximum is ${maxPayloadBytes}`,
		);
	}
	return { runId, sessionId, sequence, expiresAtMs, payload };
}

function validateWireLimit(options: WireCodecOptions): number {
	const maxWireBytes = options.maxWireBytes ?? DEFAULT_MAX_WIRE_BYTES;
	validateLimit("maxWireBytes", maxWireBytes);
	return maxWireBytes;
}

/** Encode one application message as a strict binary envelope. */
export function encodeWireMessage(
	message: WireMessage,
	options: WireCodecOptions = {},
): Uint8Array {
	const { runId, sessionId, sequence, expiresAtMs, payload } = validateMessage(
		message,
		options,
	);
	const headerBytes =
		WIRE_FIXED_HEADER_BYTES + runId.byteLength + sessionId.byteLength;
	const totalBytes = headerBytes + payload.byteLength;
	if (totalBytes > validateWireLimit(options)) {
		fail(
			"oversized",
			`wire message is ${totalBytes} bytes; maximum is ${options.maxWireBytes}`,
		);
	}
	if (headerBytes > 65_535) {
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
		return new Uint8Array(input);
	}
	if (ArrayBuffer.isView(input)) {
		return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
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
	const bytes = inputBytes(input);
	if (bytes.byteLength < WIRE_FIXED_HEADER_BYTES) {
		fail("truncated", "wire envelope is shorter than its fixed header");
	}
	const maxWireBytes = validateWireLimit(options);
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
		options.maxPayloadBytes ?? DEFAULT_MAX_WIRE_PAYLOAD_BYTES;
	validateLimit("maxPayloadBytes", maxPayloadBytes);
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
	if (options.nowMs !== undefined) {
		if (!Number.isFinite(options.nowMs)) {
			fail("invalid-input", "nowMs must be finite");
		}
		if (
			(options.rejectExpired ?? false) &&
			isWireMessageExpired(message, options.nowMs)
		) {
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
	return nowMs >= message.expiresAtMs;
}

export const encodeMessage = encodeWireMessage;
export const decodeMessage = decodeWireMessage;
export const isExpired = isWireMessageExpired;
