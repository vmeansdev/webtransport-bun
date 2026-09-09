/**
 * `fanout-delivery/c1` (physical-budget amendment D2): the compact frame the
 * relay writes to every subscriber.
 *
 * Little-endian, a fixed 24-byte header followed by exactly `messageBytes` of
 * payload. The header carries every field the worker's accounting and the
 * §4.5 equations read, and nothing else; there is no per-frame digest because
 * TLS 1.3 and QUIC already authenticate the bytes in transit and no seal reads
 * one. Warmup and measured deliveries are told apart by `contextTag`, the
 * first four digest bytes of the delivery context the subscriber was admitted
 * under, so a frame can never be counted in an epoch the session did not see.
 *
 *   off size field                       consumer
 *     0    1 magic 0xC1                  routing and decoder version gate
 *     1    1 windowIndex u8              worker deliveredByOriginWindow[w]
 *     2    2 publisherIndex u16          worker duplicate/reorder key
 *     4    4 subscriberIndex u32         worker cross-check against its roleId
 *     8    4 publisherSequence u32       worker duplicate/reorder key
 *    12    4 linuxAcceptedOrdinal u32    Linux authorship (§4.2)
 *    16    4 contextTag u32              binds the frame to grant and epoch
 *    20    2 payloadBytes u16            conservation of bytes
 *    22    2 reserved, must be 0
 *    24    N payload
 *
 * The same bytes are one WS binary message and one WT stream unit: the
 * header states the length, so neither transport adds a prefix. On a delivery
 * channel the first byte is the discriminator: `0xC1` is a compact frame,
 * otherwise the unit is the JSON delivery context (`{` on WS, the `u32be`
 * length prefix's leading `0x00` on WT).
 *
 * This module is a leaf: `fanout-wire.ts` re-exports it and owns the JSON side.
 */
import { sha256Canonical } from "../canonical.ts";
import {
	COHORT_PROTOCOL_FAILURE_CODE,
	DELIVERY_CONTEXT_MISMATCH_FAILURE_CODE,
} from "../cohort-protocol.ts";
import type {
	ProtocolResult,
	Sha256Hex,
} from "../cross-supervisor-protocol.ts";

export const FANOUT_DELIVERY_SCHEMA = "fanout-delivery/c1" as const;
export const FANOUT_DELIVERY_MAGIC = 0xc1;
export const FANOUT_DELIVERY_HEADER_BYTES = 24;

/** A WT JSON unit is `u32be length || body`; every legal body is far below 16 MiB. */
export const FANOUT_WT_JSON_UNIT_FIRST_BYTE = 0x00;
/** A WS JSON message is the canonical frame itself, which always opens an object. */
export const FANOUT_WS_JSON_MESSAGE_FIRST_BYTE = 0x7b;

/** Ticker payloads are exactly 100 bytes; chat payloads exactly 128. */
export const FANOUT_TICKER_PAYLOAD_BYTES = 100;
export const FANOUT_CHAT_PAYLOAD_BYTES = 128;
export const FANOUT_PAYLOAD_BYTES_VALUES = [
	FANOUT_TICKER_PAYLOAD_BYTES,
	FANOUT_CHAT_PAYLOAD_BYTES,
] as const;
export type FanoutPayloadBytes = (typeof FANOUT_PAYLOAD_BYTES_VALUES)[number];

/**
 * Window indices are bounded by the largest declared measured window count
 * (30 one-second windows); a 10-window cell uses a strict prefix of the same
 * domain, so one bound covers both without inventing a per-cell parameter.
 */
export const FANOUT_MAX_WINDOW_COUNT = 30;

const OFFSET_MAGIC = 0;
const OFFSET_WINDOW_INDEX = 1;
const OFFSET_PUBLISHER_INDEX = 2;
const OFFSET_SUBSCRIBER_INDEX = 4;
const OFFSET_PUBLISHER_SEQUENCE = 8;
const OFFSET_LINUX_ACCEPTED_ORDINAL = 12;
const OFFSET_CONTEXT_TAG = 16;
const OFFSET_PAYLOAD_BYTES = 20;
const OFFSET_RESERVED = 22;

const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;

export interface FanoutDeliveryHeaderC1 {
	readonly windowIndex: number;
	readonly publisherIndex: number;
	readonly subscriberIndex: number;
	readonly publisherSequence: number;
	readonly linuxAcceptedOrdinal: number;
	readonly contextTag: number;
	readonly payloadBytes: FanoutPayloadBytes;
}

export interface FanoutDeliveryC1 extends FanoutDeliveryHeaderC1 {
	/** A view over the unit's own bytes, never a copy. */
	readonly payload: Uint8Array;
}

/** What the relay knows per accepted ingress; `subscriberIndex` is patched per clone. */
export interface FanoutDeliveryTemplateInput {
	readonly windowIndex: number;
	readonly publisherIndex: number;
	readonly publisherSequence: number;
	readonly linuxAcceptedOrdinal: number;
	readonly contextTag: number;
	readonly payload: Uint8Array;
}

export type FanoutDeliveryUnitKind = "compact" | "json";

function deliveryFail(message: string): {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
} {
	return { ok: false, code: COHORT_PROTOCOL_FAILURE_CODE, message };
}

function contextFail(message: string): {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
} {
	return { ok: false, code: DELIVERY_CONTEXT_MISMATCH_FAILURE_CODE, message };
}

function isUint(value: unknown, max: number): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= max
	);
}

function isPayloadBytes(value: number): value is FanoutPayloadBytes {
	return (FANOUT_PAYLOAD_BYTES_VALUES as readonly number[]).includes(value);
}

/** `24 + messageBytes`: the exact length of every unit of a cell. */
export function fanoutDeliveryUnitBytes(messageBytes: number): number {
	if (!isPayloadBytes(messageBytes)) {
		throw new RangeError(`messageBytes ${messageBytes} is not a cell constant`);
	}
	return FANOUT_DELIVERY_HEADER_BYTES + messageBytes;
}

/**
 * One template per accepted ingress: the payload is copied exactly once and
 * every header field except `subscriberIndex` is written. Refuses any field
 * the header cannot carry before a byte is written.
 */
export function encodeFanoutDeliveryTemplate(
	input: FanoutDeliveryTemplateInput,
): ProtocolResult<Uint8Array> {
	if (!isUint(input.windowIndex, FANOUT_MAX_WINDOW_COUNT - 1)) {
		return deliveryFail("windowIndex is not below the window bound");
	}
	if (!isUint(input.publisherIndex, U16_MAX)) {
		return deliveryFail("publisherIndex does not fit u16");
	}
	if (!isUint(input.publisherSequence, U32_MAX)) {
		return deliveryFail("publisherSequence does not fit u32");
	}
	if (!isUint(input.linuxAcceptedOrdinal, U32_MAX)) {
		return deliveryFail("linuxAcceptedOrdinal does not fit u32");
	}
	if (!isUint(input.contextTag, U32_MAX)) {
		return deliveryFail("contextTag does not fit u32");
	}
	const payloadBytes = input.payload.byteLength;
	if (!isPayloadBytes(payloadBytes)) {
		return deliveryFail("payload is not exactly 100 or 128 bytes");
	}
	const out = new Uint8Array(FANOUT_DELIVERY_HEADER_BYTES + payloadBytes);
	const view = new DataView(out.buffer);
	out[OFFSET_MAGIC] = FANOUT_DELIVERY_MAGIC;
	out[OFFSET_WINDOW_INDEX] = input.windowIndex;
	view.setUint16(OFFSET_PUBLISHER_INDEX, input.publisherIndex, true);
	view.setUint32(OFFSET_SUBSCRIBER_INDEX, 0, true);
	view.setUint32(OFFSET_PUBLISHER_SEQUENCE, input.publisherSequence, true);
	view.setUint32(
		OFFSET_LINUX_ACCEPTED_ORDINAL,
		input.linuxAcceptedOrdinal,
		true,
	);
	view.setUint32(OFFSET_CONTEXT_TAG, input.contextTag, true);
	view.setUint16(OFFSET_PAYLOAD_BYTES, payloadBytes, true);
	view.setUint16(OFFSET_RESERVED, 0, true);
	out.set(input.payload, FANOUT_DELIVERY_HEADER_BYTES);
	return { ok: true, value: out };
}

/**
 * The per-subscriber hot path: copy the template and patch `subscriberIndex`.
 * The relay is the only author, so a bad argument is a programming error and
 * throws rather than costing a result allocation per delivery.
 */
export function cloneFanoutDeliveryForSubscriber(
	template: Uint8Array,
	subscriberIndex: number,
): Uint8Array {
	if (!isUint(subscriberIndex, U32_MAX)) {
		throw new RangeError(`subscriberIndex ${subscriberIndex} does not fit u32`);
	}
	if (
		template[OFFSET_MAGIC] !== FANOUT_DELIVERY_MAGIC ||
		template.byteLength < FANOUT_DELIVERY_HEADER_BYTES
	) {
		throw new RangeError("not a fanout-delivery/c1 template");
	}
	const out = template.slice();
	new DataView(out.buffer).setUint32(
		OFFSET_SUBSCRIBER_INDEX,
		subscriberIndex,
		true,
	);
	return out;
}

/** Template plus clone in one step, for callers that write a single frame. */
export function encodeFanoutDelivery(
	header: FanoutDeliveryHeaderC1,
	payload: Uint8Array,
): ProtocolResult<Uint8Array> {
	if (payload.byteLength !== header.payloadBytes) {
		return deliveryFail("payload length does not equal payloadBytes");
	}
	if (!isUint(header.subscriberIndex, U32_MAX)) {
		return deliveryFail("subscriberIndex does not fit u32");
	}
	const template = encodeFanoutDeliveryTemplate({ ...header, payload });
	if (!template.ok) return template;
	return {
		ok: true,
		value: cloneFanoutDeliveryForSubscriber(
			template.value,
			header.subscriberIndex,
		),
	};
}

/**
 * Decode one unit of a cell. `messageBytes` is the cell constant, which is
 * the length authority: a unit is exactly `24 + messageBytes` bytes and its
 * `payloadBytes` must say so, so a wrong length is refused at once rather
 * than desynchronising a stream. Every header check is a refusal the worker
 * counts; nothing here is silently dropped.
 */
export function decodeFanoutDelivery(
	unit: Uint8Array,
	messageBytes: number,
): ProtocolResult<FanoutDeliveryC1> {
	if (!isPayloadBytes(messageBytes)) {
		return deliveryFail("messageBytes is not a cell constant");
	}
	const expectedLength = FANOUT_DELIVERY_HEADER_BYTES + messageBytes;
	if (unit.byteLength !== expectedLength) {
		return deliveryFail(
			`delivery unit is ${unit.byteLength} bytes, not ${expectedLength}`,
		);
	}
	if (unit[OFFSET_MAGIC] !== FANOUT_DELIVERY_MAGIC) {
		return deliveryFail("delivery unit magic is not 0xC1");
	}
	const view = new DataView(unit.buffer, unit.byteOffset, unit.byteLength);
	const windowIndex = unit[OFFSET_WINDOW_INDEX] as number;
	if (windowIndex >= FANOUT_MAX_WINDOW_COUNT) {
		return deliveryFail("delivery windowIndex is not below the window bound");
	}
	const payloadBytes = view.getUint16(OFFSET_PAYLOAD_BYTES, true);
	if (payloadBytes !== messageBytes) {
		return deliveryFail(
			`delivery payloadBytes ${payloadBytes} is not the cell's ${messageBytes}`,
		);
	}
	if (view.getUint16(OFFSET_RESERVED, true) !== 0) {
		return deliveryFail("delivery reserved field is not zero");
	}
	return {
		ok: true,
		value: {
			windowIndex,
			publisherIndex: view.getUint16(OFFSET_PUBLISHER_INDEX, true),
			subscriberIndex: view.getUint32(OFFSET_SUBSCRIBER_INDEX, true),
			publisherSequence: view.getUint32(OFFSET_PUBLISHER_SEQUENCE, true),
			linuxAcceptedOrdinal: view.getUint32(OFFSET_LINUX_ACCEPTED_ORDINAL, true),
			contextTag: view.getUint32(OFFSET_CONTEXT_TAG, true),
			payloadBytes: messageBytes,
			payload: unit.subarray(FANOUT_DELIVERY_HEADER_BYTES),
		},
	};
}

/**
 * The first byte of a delivery-channel unit decides its path before any parse.
 * `null` is a unit neither path may take; a caller refuses it.
 */
export function fanoutDeliveryUnitKind(
	unit: Uint8Array,
	transport: "ws" | "wt",
): FanoutDeliveryUnitKind | null {
	if (unit.byteLength === 0) return null;
	const first = unit[0];
	if (first === FANOUT_DELIVERY_MAGIC) return "compact";
	const jsonFirst =
		transport === "wt"
			? FANOUT_WT_JSON_UNIT_FIRST_BYTE
			: FANOUT_WS_JSON_MESSAGE_FIRST_BYTE;
	return first === jsonFirst ? "json" : null;
}

/**
 * `deliveryContextSha256` is the SHA-256 of the canonical JSON text of the
 * context with that one key removed: the JSON itself, not the newline-
 * terminated record line the signed records use.
 */
export function deliveryContextSha256Of(preimage: unknown): Sha256Hex {
	return sha256Canonical(preimage);
}

/** `contextTag` is the first four bytes of the digest read little-endian. */
export function contextTagOfDeliveryContextSha256(digest: Sha256Hex): number {
	if (!/^[0-9a-f]{64}$/.test(digest)) {
		throw new RangeError("deliveryContextSha256 is not 64 lowercase hex");
	}
	const b0 = Number.parseInt(digest.slice(0, 2), 16);
	const b1 = Number.parseInt(digest.slice(2, 4), 16);
	const b2 = Number.parseInt(digest.slice(4, 6), 16);
	const b3 = Number.parseInt(digest.slice(6, 8), 16);
	return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

/**
 * The worker's epoch selection: a compact frame belongs to the epoch whose
 * verified context carries its tag. A tag with no context on this session,
 * or a session whose two contexts share a tag, is `DELIVERY_CONTEXT_MISMATCH`
 * rather than an ambiguous count.
 */
export function resolveDeliveryEpochByTag(
	tag: number,
	tags: { readonly warmup: number | null; readonly measured: number | null },
): ProtocolResult<"warmup" | "measured"> {
	if (tags.warmup !== null && tags.warmup === tags.measured) {
		return contextFail(
			"warmup and measured delivery contexts carry equal tags",
		);
	}
	if (tags.measured !== null && tag === tags.measured) {
		return { ok: true, value: "measured" };
	}
	if (tags.warmup !== null && tag === tags.warmup) {
		return { ok: true, value: "warmup" };
	}
	return contextFail(`no delivery context on this session carries tag ${tag}`);
}
