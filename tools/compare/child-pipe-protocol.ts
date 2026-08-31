/**
 * Phase-A child-pipe protocol codecs (plan §3.4–3.5, A2).
 *
 * Distinct from remote `comparison-supervisor-frame/v1`: frames are
 * `u32be payloadLength || canonical JSON`, with independent per-direction
 * sequence starting at 0. No Phase-B FanoutWire codecs here (B1).
 */
import { canonicalJson } from "./canonical.ts";
import {
	canonicalRecordBytes,
	isHex64,
	parseStrictJsonBytes,
	sha256HexOfBytes,
} from "./secure-fs.ts";
import type {
	CampaignFailureCode,
	Sha256Hex,
} from "./cross-supervisor-protocol.ts";

export type ChildPipeRefusalCode =
	| "FRAME_INVALID"
	| "SEQUENCE_INVALID"
	| "STATE_INVALID"
	| "EXECUTION_MISMATCH"
	| "COHORT_MISMATCH"
	| "TOKEN_INVALID"
	| "TOKEN_REPLAY"
	| "BIND_DEADLINE_EXCEEDED"
	| "READY_DEADLINE_EXCEEDED"
	| "WARMUP_DEADLINE_EXCEEDED"
	| "MEASURE_DEADLINE_EXCEEDED"
	| "DRAIN_DEADLINE_EXCEEDED"
	| "TEARDOWN_DEADLINE_EXCEEDED"
	| "UNEXPECTED_EOF"
	| "UNEXPECTED_FD"
	| "RELAY_CAPACITY_EXCEEDED"
	| "PROCESS_RESOURCE_EXHAUSTED"
	| "CHILD_LIFECYCLE";

export const CHILD_PIPE_REFUSAL_CODES = [
	"FRAME_INVALID",
	"SEQUENCE_INVALID",
	"STATE_INVALID",
	"EXECUTION_MISMATCH",
	"COHORT_MISMATCH",
	"TOKEN_INVALID",
	"TOKEN_REPLAY",
	"BIND_DEADLINE_EXCEEDED",
	"READY_DEADLINE_EXCEEDED",
	"WARMUP_DEADLINE_EXCEEDED",
	"MEASURE_DEADLINE_EXCEEDED",
	"DRAIN_DEADLINE_EXCEEDED",
	"TEARDOWN_DEADLINE_EXCEEDED",
	"UNEXPECTED_EOF",
	"UNEXPECTED_FD",
	"RELAY_CAPACITY_EXCEEDED",
	"PROCESS_RESOURCE_EXHAUSTED",
	"CHILD_LIFECYCLE",
] as const satisfies readonly ChildPipeRefusalCode[];

export const CHILD_PIPE_CONTROL_MAX_BYTES = 64 * 1024;
export const CHILD_PIPE_PARTIAL_MAX_BYTES = 256 * 1024;
export const CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION = 32;

export type ChildPipeResult<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly code: ChildPipeRefusalCode | "TRUST_PROTOCOL";
			readonly message?: string;
	  };

export interface ChildPipeRefusalV1 {
	readonly schema: "child-pipe-refusal/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly code: ChildPipeRefusalCode;
	readonly terminal: true;
}

export interface ChildSequenceState {
	outbound: number;
	inbound: number;
}

export function createChildSequenceState(): ChildSequenceState {
	return { outbound: 0, inbound: 0 };
}

export function assertChildOutboundSequence(
	state: ChildSequenceState,
	sequence: number,
	maxFrames: number = CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION,
): ChildPipeResult<true> {
	if (sequence !== state.outbound) {
		return {
			ok: false,
			code: "SEQUENCE_INVALID",
			message: `outbound expected ${state.outbound}`,
		};
	}
	if (state.outbound >= maxFrames) {
		return {
			ok: false,
			code: "SEQUENCE_INVALID",
			message: "direction frame cap",
		};
	}
	state.outbound += 1;
	return { ok: true, value: true };
}

export function assertChildInboundSequence(
	state: ChildSequenceState,
	sequence: number,
	maxFrames: number = CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION,
): ChildPipeResult<true> {
	if (sequence !== state.inbound) {
		return {
			ok: false,
			code: "SEQUENCE_INVALID",
			message: `inbound expected ${state.inbound}`,
		};
	}
	if (state.inbound >= maxFrames) {
		return {
			ok: false,
			code: "SEQUENCE_INVALID",
			message: "direction frame cap",
		};
	}
	state.inbound += 1;
	return { ok: true, value: true };
}

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

export function encodeChildPipeFrame(
	payload: Rec & { schema: string },
	maxBytes: number = CHILD_PIPE_CONTROL_MAX_BYTES,
): ChildPipeResult<Uint8Array> {
	const body = canonicalRecordBytes(payload);
	if (body.byteLength > maxBytes) {
		return { ok: false, code: "FRAME_INVALID", message: "oversize" };
	}
	const frame = new Uint8Array(4 + body.byteLength);
	new DataView(frame.buffer).setUint32(0, body.byteLength, false);
	frame.set(body, 4);
	return { ok: true, value: frame };
}

export function decodeChildPipeFrame(
	frame: Uint8Array,
	maxBytes: number = CHILD_PIPE_CONTROL_MAX_BYTES,
): ChildPipeResult<Rec> {
	if (frame.byteLength < 4) {
		return { ok: false, code: "FRAME_INVALID", message: "truncated" };
	}
	const declared = new DataView(
		frame.buffer,
		frame.byteOffset,
		frame.byteLength,
	).getUint32(0, false);
	if (declared > maxBytes) {
		return { ok: false, code: "FRAME_INVALID", message: "oversize" };
	}
	if (frame.byteLength !== 4 + declared) {
		if (frame.byteLength < 4 + declared) {
			return { ok: false, code: "FRAME_INVALID", message: "truncated" };
		}
		return { ok: false, code: "FRAME_INVALID", message: "trailing" };
	}
	const payloadBytes = frame.subarray(4);
	const parsed = parseStrictJsonBytes(payloadBytes);
	if (!parsed.ok) {
		return { ok: false, code: "FRAME_INVALID", message: parsed.reason };
	}
	if (!isPlainObject(parsed.value)) {
		return { ok: false, code: "FRAME_INVALID" };
	}
	// Require canonical re-encode identity.
	const reencoded = new TextEncoder().encode(
		`${canonicalJson(parsed.value)}\n`,
	);
	if (
		reencoded.byteLength !== payloadBytes.byteLength ||
		!reencoded.every((b, i) => b === payloadBytes[i])
	) {
		return { ok: false, code: "FRAME_INVALID", message: "non-canonical" };
	}
	return { ok: true, value: parsed.value };
}

const REFUSAL_KEYS = [
	"code",
	"executionSha256",
	"schema",
	"sequence",
	"terminal",
] as const;

export function parseChildPipeRefusal(
	value: unknown,
): ChildPipeResult<ChildPipeRefusalV1> {
	if (!isPlainObject(value) || !exactKeys(value, REFUSAL_KEYS)) {
		return { ok: false, code: "FRAME_INVALID", message: "refusal keys" };
	}
	if (
		value.schema !== "child-pipe-refusal/v1" ||
		value.terminal !== true ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		typeof value.code !== "string"
	) {
		return { ok: false, code: "FRAME_INVALID" };
	}
	if (!(CHILD_PIPE_REFUSAL_CODES as readonly string[]).includes(value.code)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `unknown child refusal code ${value.code}`,
		};
	}
	return { ok: true, value: value as unknown as ChildPipeRefusalV1 };
}

/** Plan §7: each ChildPipeRefusalCode maps to exactly one index failure code. */
export function mapChildRefusalToIndexCode(
	code: ChildPipeRefusalCode,
): CampaignFailureCode {
	switch (code) {
		case "FRAME_INVALID":
		case "SEQUENCE_INVALID":
		case "STATE_INVALID":
		case "UNEXPECTED_EOF":
		case "UNEXPECTED_FD":
			return "TRUST_PROTOCOL";
		case "EXECUTION_MISMATCH":
			return "CROSS_SUPERVISOR_MISMATCH";
		case "COHORT_MISMATCH":
		case "TOKEN_INVALID":
		case "TOKEN_REPLAY":
			return "COHORT_PROTOCOL";
		case "BIND_DEADLINE_EXCEEDED":
		case "READY_DEADLINE_EXCEEDED":
			return "COHORT_NOT_READY";
		case "WARMUP_DEADLINE_EXCEEDED":
			return "WARMUP_PROTOCOL";
		case "MEASURE_DEADLINE_EXCEEDED":
			return "MEASUREMENT_WINDOW";
		case "DRAIN_DEADLINE_EXCEEDED":
		case "RELAY_CAPACITY_EXCEEDED":
			return "RELAY_DELIVERY";
		case "TEARDOWN_DEADLINE_EXCEEDED":
		case "CHILD_LIFECYCLE":
			return "CHILD_LIFECYCLE";
		case "PROCESS_RESOURCE_EXHAUSTED":
			return "RUNTIME_RESOURCE_EXHAUSTION";
		default: {
			const _exhaustive: never = code;
			return _exhaustive;
		}
	}
}

export function mapsEveryChildRefusalStateToOneIndexCode(): ReadonlyMap<
	ChildPipeRefusalCode,
	CampaignFailureCode
> {
	const map = new Map<ChildPipeRefusalCode, CampaignFailureCode>();
	for (const code of CHILD_PIPE_REFUSAL_CODES) {
		map.set(code, mapChildRefusalToIndexCode(code));
	}
	return map;
}

// Phase-A server child payload schemas (exact-key codecs for bounds tests).
export const PHASE_A_CHILD_SCHEMAS = [
	"child-pipe-refusal/v1",
	"server-bind-execution/v1",
	"server-ready/v1",
	"server-warmup-start/v1",
	"server-warmup-ready/v1",
	"server-warmup-drain-and-reset/v1",
	"server-warmup-drained/v1",
	"server-measure-start/v1",
	"server-measure-start-ack/v1",
	"server-present-start-barrier/v1",
	"server-start-barrier-accepted/v1",
	"server-stop-and-capture/v1",
	"server-capture-ack/v1",
	"server-teardown/v1",
	"server-stopped/v1",
	"server-loop-utilization/v1",
	"bulk-source-completion/v1",
	"bulk-sink-series/v1",
] as const;

const SERVER_BIND_KEYS = [
	"cohortGrantBase64",
	"executionSha256",
	"rigExecutionAcceptanceSha256",
	"schema",
	"sequence",
] as const;

export function parseServerBindExecution(value: unknown): ChildPipeResult<Rec> {
	if (!isPlainObject(value) || !exactKeys(value, SERVER_BIND_KEYS)) {
		return { ok: false, code: "FRAME_INVALID", message: "server-bind keys" };
	}
	if (
		value.schema !== "server-bind-execution/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.rigExecutionAcceptanceSha256) ||
		!(
			value.cohortGrantBase64 === null ||
			typeof value.cohortGrantBase64 === "string"
		)
	) {
		return { ok: false, code: "FRAME_INVALID" };
	}
	return { ok: true, value };
}

export function childPipeExactKeysAndBoundsFixture(): {
	readonly maxControlBytes: number;
	readonly maxPartialBytes: number;
	readonly maxRigServerFrames: number;
	readonly schemas: readonly string[];
} {
	return {
		maxControlBytes: CHILD_PIPE_CONTROL_MAX_BYTES,
		maxPartialBytes: CHILD_PIPE_PARTIAL_MAX_BYTES,
		maxRigServerFrames: CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION,
		schemas: PHASE_A_CHILD_SCHEMAS,
	};
}

export function rejectChildEarlyEof(): ChildPipeResult<true> {
	return { ok: false, code: "UNEXPECTED_EOF", message: "eof before stopped" };
}

export { sha256HexOfBytes };
