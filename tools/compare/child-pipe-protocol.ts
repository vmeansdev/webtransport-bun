/**
 * Phase-A child-pipe protocol codecs (plan §3.4–3.5, A2).
 *
 * Distinct from remote `comparison-supervisor-frame/v1`: frames are
 * `u32be payloadLength || canonical JSON`, with independent per-direction
 * sequence starting at 0. No Phase-B FanoutWire codecs here (B1).
 */
import { canonicalJson } from "./canonical.ts";
import type {
	CampaignFailureCode,
	Sha256Hex,
} from "./cross-supervisor-protocol.ts";
import {
	canonicalRecordBytes,
	isHex64,
	parseStrictJsonBytes,
	sha256HexOfBytes,
} from "./secure-fs.ts";

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

// ---------------------------------------------------------------------------
// The §3.4 server-child lifecycle field table (plan lines 985-1193).
//
// One table, from which the key sets, the strict parsers and the builders are
// all derived, so a key can only be added to this protocol in one place. The
// alternative -- a hand-written key array beside each hand-written parser --
// is what let `server-bind-execution/v1` and its parser drift apart once
// already, and it is the same shape as the `PHASE_A_RIG_FIELDS` table
// (`cross-supervisor-protocol.ts:2537`) the remote codec already uses.
//
// The base64 and ns-string validators are local rather than imported because
// `isStrictBase64` (`cross-supervisor-protocol.ts:1910`) and
// `NS_STRING_PATTERN` (`:2493`) are module-private there. They are copied from
// those two lines verbatim, and their semantics are characterised by test here
// so a later divergence is loud. Exporting one pair from one module is the
// right end state and needs a slice that owns both files.
// ---------------------------------------------------------------------------

const CHILD_BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CHILD_NS_STRING_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
/** Long enough for an address or a clock id, short enough to bound the frame. */
const CHILD_TEXT_MAX_LENGTH = 256;

function isChildBase64(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (value.length % 4 !== 0) return false;
	return CHILD_BASE64_PATTERN.test(value);
}

function isChildNsString(value: unknown): value is string {
	return typeof value === "string" && CHILD_NS_STRING_PATTERN.test(value);
}

function isChildText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= CHILD_TEXT_MAX_LENGTH
	);
}

export type ChildFieldKind =
	| "seq"
	| "sha256"
	| "sha256OrNull"
	| "base64"
	| "base64OrNull"
	| "nsString"
	| "count"
	| "positiveInt"
	| "text"
	| "refusalCode"
	| "literalTrue";

type ChildFieldSpec =
	| { readonly kind: ChildFieldKind }
	| { readonly kind: "schema"; readonly value: string };

function childFieldOk(spec: ChildFieldSpec, value: unknown): boolean {
	switch (spec.kind) {
		case "schema":
			return value === spec.value;
		case "seq":
		case "count":
			return isSafeNonNegInt(value);
		case "positiveInt":
			return isSafeNonNegInt(value) && value > 0;
		case "sha256":
			return isHex64(value);
		case "sha256OrNull":
			return value === null || isHex64(value);
		case "base64":
			return isChildBase64(value);
		case "base64OrNull":
			return value === null || isChildBase64(value);
		case "nsString":
			return isChildNsString(value);
		case "text":
			return isChildText(value);
		case "refusalCode":
			return (
				typeof value === "string" &&
				(CHILD_PIPE_REFUSAL_CODES as readonly string[]).includes(value)
			);
		case "literalTrue":
			return value === true;
		default: {
			const _exhaustive: never = spec;
			return _exhaustive;
		}
	}
}

type ChildFieldTable = Readonly<Record<string, ChildFieldSpec>>;

/** The 15 §3.4 server-child lifecycle schemas. */
export type ServerChildSchema =
	| "child-pipe-refusal/v1"
	| "server-bind-execution/v1"
	| "server-ready/v1"
	| "server-warmup-start/v1"
	| "server-warmup-ready/v1"
	| "server-warmup-drain-and-reset/v1"
	| "server-warmup-drained/v1"
	| "server-measure-start/v1"
	| "server-measure-start-ack/v1"
	| "server-present-start-barrier/v1"
	| "server-start-barrier-accepted/v1"
	| "server-stop-and-capture/v1"
	| "server-capture-ack/v1"
	| "server-teardown/v1"
	| "server-stopped/v1";

/**
 * `server-bind-execution/v1` carries `cohortGrantSignatureBase64`, which §3.4
 * does not freeze. The field is a recorded registry edit, documented on the
 * interface below: a bare `cohortGrantBase64` is a grant the child cannot
 * authenticate, and §4.2 requires it to verify against the staged Mac public
 * key before it binds.
 *
 * `server-capture-ack/v1` carries `snapshotFrameBase64` and
 * `linuxRelayObservationBase64` where the plan freezes nested records. That is
 * design §1.3's registry edit, taken so the rig digests the bytes the child
 * sent rather than a re-canonicalisation it built from parsed fields.
 */
const SERVER_CHILD_FIELDS: Readonly<
	Record<ServerChildSchema, ChildFieldTable>
> = {
	"child-pipe-refusal/v1": {
		schema: { kind: "schema", value: "child-pipe-refusal/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		code: { kind: "refusalCode" },
		terminal: { kind: "literalTrue" },
	},
	"server-bind-execution/v1": {
		schema: { kind: "schema", value: "server-bind-execution/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		rigExecutionAcceptanceSha256: { kind: "sha256" },
		cohortGrantBase64: { kind: "base64OrNull" },
		cohortGrantSignatureBase64: { kind: "base64OrNull" },
		macExecutionGrantReceiptBase64: { kind: "base64OrNull" },
		macExecutionGrantSignatureBase64: { kind: "base64OrNull" },
	},
	"server-ready/v1": {
		schema: { kind: "schema", value: "server-ready/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		childPid: { kind: "positiveInt" },
		childPgid: { kind: "positiveInt" },
		childInstanceNonce: { kind: "sha256" },
		cohortGrantSha256: { kind: "sha256OrNull" },
		listeningAddress: { kind: "text" },
	},
	"server-warmup-start/v1": {
		schema: { kind: "schema", value: "server-warmup-start/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortWarmupEpochBase64: { kind: "base64" },
		cohortWarmupEpochSignatureBase64: { kind: "base64" },
	},
	"server-warmup-ready/v1": {
		schema: { kind: "schema", value: "server-warmup-ready/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortWarmupEpochSha256: { kind: "sha256" },
		warmupCountersZero: { kind: "literalTrue" },
	},
	"server-warmup-drain-and-reset/v1": {
		schema: { kind: "schema", value: "server-warmup-drain-and-reset/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortWarmupEpochSha256: { kind: "sha256" },
		roleWarmupCompletionManifestSha256: { kind: "sha256" },
	},
	"server-warmup-drained/v1": {
		schema: { kind: "schema", value: "server-warmup-drained/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortWarmupEpochSha256: { kind: "sha256" },
		roleWarmupCompletionManifestSha256: { kind: "sha256" },
		warmupIngress: { kind: "count" },
		warmupDeliveries: { kind: "count" },
		publisherWarmupEndCount: { kind: "count" },
		subscriberWarmupEndCount: { kind: "count" },
		warmupQueuesEmpty: { kind: "literalTrue" },
		measuredCountersZero: { kind: "literalTrue" },
		drainedAtLinuxNs: { kind: "nsString" },
		linuxClockId: { kind: "text" },
	},
	"server-measure-start/v1": {
		schema: { kind: "schema", value: "server-measure-start/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		warmupCompleteSha256: { kind: "sha256OrNull" },
	},
	"server-measure-start-ack/v1": {
		schema: { kind: "schema", value: "server-measure-start-ack/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		// D1's ruling: `baselineBusyMs` is a whole-millisecond count, not a
		// real. The shared cohort codec refuses every non-integer number at
		// encode time (`secure_fs::cohort::canonical_bytes`), and §1.3 row 2
		// carries this field verbatim into `rig-measure-start-ack/v1`, so a
		// fractional value here is a record no rig receipt could ever hold.
		baselineBusyMs: { kind: "count" },
		baselineAtLinuxNs: { kind: "nsString" },
		linuxClockId: { kind: "text" },
	},
	"server-present-start-barrier/v1": {
		schema: { kind: "schema", value: "server-present-start-barrier/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortStartBarrierBase64: { kind: "base64" },
		cohortStartBarrierSignatureBase64: { kind: "base64" },
	},
	"server-start-barrier-accepted/v1": {
		schema: { kind: "schema", value: "server-start-barrier-accepted/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortStartBarrierSha256: { kind: "sha256" },
		acceptedAtLinuxNs: { kind: "nsString" },
		linuxClockId: { kind: "text" },
		measuredTrafficAllowed: { kind: "literalTrue" },
	},
	"server-stop-and-capture/v1": {
		schema: { kind: "schema", value: "server-stop-and-capture/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		cohortStartBarrierSha256: { kind: "sha256OrNull" },
		drainDeadlineMs: { kind: "positiveInt" },
	},
	"server-capture-ack/v1": {
		schema: { kind: "schema", value: "server-capture-ack/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		snapshotFrameBase64: { kind: "base64" },
		linuxRelayObservationBase64: { kind: "base64OrNull" },
	},
	"server-teardown/v1": {
		schema: { kind: "schema", value: "server-teardown/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
	},
	"server-stopped/v1": {
		schema: { kind: "schema", value: "server-stopped/v1" },
		sequence: { kind: "seq" },
		executionSha256: { kind: "sha256" },
		exitCode: { kind: "count" },
		allSessionsClosed: { kind: "literalTrue" },
	},
};

/** The 15 §3.4 lifecycle schemas, in §5 transition order. */
export const SERVER_CHILD_LIFECYCLE_SCHEMAS = Object.keys(
	SERVER_CHILD_FIELDS,
) as readonly ServerChildSchema[];

export function isServerChildSchema(
	schema: string,
): schema is ServerChildSchema {
	return Object.hasOwn(SERVER_CHILD_FIELDS, schema);
}

/** Every lifecycle frame sits under the §3.4 control cap. */
export function serverChildFrameBoundForSchema(schema: string): number | null {
	return isServerChildSchema(schema) ? CHILD_PIPE_CONTROL_MAX_BYTES : null;
}

function sortedKeysOf(table: ChildFieldTable): readonly string[] {
	return Object.keys(table).sort();
}

/** Each schema's exact key set, sorted -- derived, never hand-listed twice. */
export const SERVER_CHILD_KEY_SETS = Object.fromEntries(
	Object.entries(SERVER_CHILD_FIELDS).map(([schema, table]) => [
		schema,
		sortedKeysOf(table),
	]),
	// `Object.fromEntries` widens the key back to `string`; the entries come
	// from `SERVER_CHILD_FIELDS` itself, so the narrower type is the true one.
) as Readonly<Record<ServerChildSchema, readonly string[]>>;

/**
 * Strict table-driven validation.
 *
 * The three failure classes are kept apart because they are different events:
 * a wrong key set or a wrong type is a malformed frame (`FRAME_INVALID`); a
 * well-formed frame whose frozen `true` is `false` is a child reporting a
 * state §5 does not have (`STATE_INVALID`, the precedent
 * `parseServerWarmupReady` set); and an unknown refusal code is a protocol
 * this build does not speak (`TRUST_PROTOCOL`).
 */
function parseChildRecordWithTable(
	schema: string,
	value: unknown,
): ChildPipeResult<Rec> {
	if (!isServerChildSchema(schema)) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: `unregistered server-child schema ${schema}`,
		};
	}
	const table = SERVER_CHILD_FIELDS[schema];
	if (
		!isPlainObject(value) ||
		!exactKeys(value, SERVER_CHILD_KEY_SETS[schema])
	) {
		return { ok: false, code: "FRAME_INVALID", message: `${schema} keys` };
	}
	for (const [key, spec] of Object.entries(table)) {
		if (childFieldOk(spec, value[key])) continue;
		if (spec.kind === "literalTrue") {
			return {
				ok: false,
				code: "STATE_INVALID",
				message: `${schema}.${key} is not the one legal value`,
			};
		}
		if (spec.kind === "refusalCode" && typeof value[key] === "string") {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `unknown child refusal code ${String(value[key])}`,
			};
		}
		return { ok: false, code: "FRAME_INVALID", message: `${schema}.${key}` };
	}
	return { ok: true, value };
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

const REFUSAL_KEYS = SERVER_CHILD_KEY_SETS["child-pipe-refusal/v1"];

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

/**
 * §3.4's key set for `server-bind-execution/v1`, plus three fields.
 *
 * `cohortGrantSignatureBase64` is a registry edit, and it is recorded as one.
 * The plan freezes this frame carrying `cohortGrantBase64` and nothing else,
 * which is a grant the server child has no way to authenticate: §4.2 requires
 * the child to verify the grant against the *staged* Mac public key before it
 * binds a listener, and a bare record cannot be verified against any key. The
 * consequence was executable rather than theoretical —
 * `server.ts --mode=fanout-cohort` refuses before binding, saying so in as
 * many words — so the alternative to this field is a server that trusts an
 * unsigned grant, which is the one thing §3.1 forbids everywhere else.
 *
 * Nullable, and null exactly when `cohortGrantBase64` is: a Phase-B bind
 * carries both. The pairing is enforced below rather than left to the reader,
 * because "a grant with no signature" is the precise state this field exists
 * to make unrepresentable.
 *
 * `macExecutionGrantReceiptBase64` / `macExecutionGrantSignatureBase64` are the
 * ordinary A5 arm's half of exactly that, and they are a recorded deviation
 * (`docs/superpowers/plans/deviations/2026-09-06-ordinary-phase-a-server-spawn.md`).
 * Amendment C4 line 76 puts ordinary traffic on the base plan's signed server
 * lifecycle, and the capture frame that lifecycle ends in
 * (`server-loop-utilization/v1`) states `cellId`, `scenarioHash`,
 * `repetitionKind`, `repetitionIndex` and `repetitionTotal`. A fanout child
 * reads all five off the `execution` its cohort grant embeds
 * (`scenarios/fanout-relay.ts` builds the frame from `grant.execution.*`); an
 * ordinary child has no grant, and with the plan's five-key bind frame it
 * would have had to invent them. The Mac-signed record that carries the same
 * embedded `execution` is `mac-execution-grant-receipt/v1`, which the rig has
 * already authenticated against the staged Mac key at §5
 * RIG_EXECUTION_ACCEPTED, so it travels here in the grant's place -- verified
 * by the child against the same staged key, exactly as the grant is.
 *
 * Exactly one of the two pairs is non-null. A bind carrying both would be
 * offering the child two execution identities to choose between; one carrying
 * neither is the bare Phase-A bind, which has no authority at all and is
 * refused by both `decideCohortBind` and `decidePhaseABind`.
 */
const SERVER_BIND_KEYS = SERVER_CHILD_KEY_SETS["server-bind-execution/v1"];

export interface ServerBindExecutionV1 {
	readonly schema: "server-bind-execution/v1";
	readonly sequence: number;
	readonly executionSha256: string;
	readonly rigExecutionAcceptanceSha256: string;
	readonly cohortGrantBase64: string | null;
	/** The Mac's detached `mac-receipt-signature/v1` over the grant bytes. */
	readonly cohortGrantSignatureBase64: string | null;
	/** The ordinary arm's authority: `mac-execution-grant-receipt/v1`. */
	readonly macExecutionGrantReceiptBase64: string | null;
	/** The Mac's detached `mac-receipt-signature/v1` over the receipt bytes. */
	readonly macExecutionGrantSignatureBase64: string | null;
}

export function parseServerBindExecution(
	value: unknown,
): ChildPipeResult<ServerBindExecutionV1> {
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
		) ||
		!(
			value.cohortGrantSignatureBase64 === null ||
			typeof value.cohortGrantSignatureBase64 === "string"
		) ||
		!(
			value.macExecutionGrantReceiptBase64 === null ||
			typeof value.macExecutionGrantReceiptBase64 === "string"
		) ||
		!(
			value.macExecutionGrantSignatureBase64 === null ||
			typeof value.macExecutionGrantSignatureBase64 === "string"
		)
	) {
		return { ok: false, code: "FRAME_INVALID" };
	}
	if (
		(value.cohortGrantBase64 === null) !==
		(value.cohortGrantSignatureBase64 === null)
	) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: "a cohort grant and its Mac signature travel together",
		};
	}
	if (
		(value.macExecutionGrantReceiptBase64 === null) !==
		(value.macExecutionGrantSignatureBase64 === null)
	) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: "a Mac execution receipt and its Mac signature travel together",
		};
	}
	if (
		(value.cohortGrantBase64 === null) ===
		(value.macExecutionGrantReceiptBase64 === null)
	) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message:
				"a bind carries exactly one authority: a cohort grant or a Mac execution receipt",
		};
	}
	return { ok: true, value: value as unknown as ServerBindExecutionV1 };
}

/** §3.4's key set for `server-warmup-ready/v1`, exactly as the plan freezes it. */
const SERVER_WARMUP_READY_KEYS =
	SERVER_CHILD_KEY_SETS["server-warmup-ready/v1"];

export interface ServerWarmupReadyV1 {
	readonly schema: "server-warmup-ready/v1";
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortWarmupEpochSha256: string;
	readonly warmupCountersZero: true;
}

/**
 * The frame the server child answers `server-warmup-start/v1` with.
 *
 * `warmupCountersZero` is a frozen `true` and not a boolean the child gets to
 * choose: §5's IN_REPETITION_WARMUP starts from zeroed counters, so a child
 * that would have to say `false` has nothing to report — it refuses instead.
 * That is why this is a builder rather than a serializer over a caller's
 * object: the one legal value is not the caller's to state.
 */
export function buildServerWarmupReady(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortWarmupEpochSha256: string;
}): ChildPipeResult<ServerWarmupReadyV1> {
	if (
		!isSafeNonNegInt(args.sequence) ||
		!isHex64(args.executionSha256) ||
		!isHex64(args.cohortWarmupEpochSha256)
	) {
		return { ok: false, code: "FRAME_INVALID", message: "warmup-ready inputs" };
	}
	return {
		ok: true,
		value: {
			schema: "server-warmup-ready/v1",
			sequence: args.sequence,
			executionSha256: args.executionSha256,
			cohortWarmupEpochSha256: args.cohortWarmupEpochSha256,
			warmupCountersZero: true,
		},
	};
}

export function parseServerWarmupReady(
	value: unknown,
): ChildPipeResult<ServerWarmupReadyV1> {
	if (!isPlainObject(value) || !exactKeys(value, SERVER_WARMUP_READY_KEYS)) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: "server-warmup-ready keys",
		};
	}
	if (
		value.schema !== "server-warmup-ready/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortWarmupEpochSha256)
	) {
		return { ok: false, code: "FRAME_INVALID" };
	}
	// Separated from the key/shape checks above because it is a different
	// failure: the frame is well formed and the child is declaring that its
	// warmup began dirty. `STATE_INVALID` is the §3.4 literal for that, and the
	// only one legal here — `WARMUP_DEADLINE_EXCEEDED` is the closed set's other
	// warmup code and nothing has timed out.
	if (value.warmupCountersZero !== true) {
		return {
			ok: false,
			code: "STATE_INVALID",
			message: "the child did not declare zeroed warmup counters",
		};
	}
	return { ok: true, value: value as unknown as ServerWarmupReadyV1 };
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

// ---------------------------------------------------------------------------
// The §3.4 lifecycle codecs: one builder and one strict parser per schema.
//
// Builders exist rather than serializers because several of these frames carry
// values that are not the caller's to state -- the frozen `true` literals, and
// the schema tag itself. A builder that refuses bad inputs is the only shape in
// which "no value that reads as evidence has a default" holds: every field is
// supplied or the frame is refused.
// ---------------------------------------------------------------------------

export interface ServerReadyV1 {
	readonly schema: "server-ready/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex | null;
	readonly listeningAddress: string;
}

export interface ServerWarmupStartV1 {
	readonly schema: "server-warmup-start/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortWarmupEpochBase64: string;
	readonly cohortWarmupEpochSignatureBase64: string;
}

export interface ServerWarmupDrainAndResetV1 {
	readonly schema: "server-warmup-drain-and-reset/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSha256: Sha256Hex;
}

export interface ServerWarmupDrainedV1 {
	readonly schema: "server-warmup-drained/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSha256: Sha256Hex;
	readonly warmupIngress: number;
	readonly warmupDeliveries: number;
	readonly publisherWarmupEndCount: number;
	readonly subscriberWarmupEndCount: number;
	readonly warmupQueuesEmpty: true;
	readonly measuredCountersZero: true;
	readonly drainedAtLinuxNs: string;
	readonly linuxClockId: string;
}

export interface ServerMeasureStartV1 {
	readonly schema: "server-measure-start/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly warmupCompleteSha256: Sha256Hex | null;
}

export interface ServerMeasureStartAckV1 {
	readonly schema: "server-measure-start-ack/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly baselineBusyMs: number;
	readonly baselineAtLinuxNs: string;
	readonly linuxClockId: string;
}

export interface ServerPresentStartBarrierV1 {
	readonly schema: "server-present-start-barrier/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierBase64: string;
	readonly cohortStartBarrierSignatureBase64: string;
}

export interface ServerStartBarrierAcceptedV1 {
	readonly schema: "server-start-barrier-accepted/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly acceptedAtLinuxNs: string;
	readonly linuxClockId: string;
	readonly measuredTrafficAllowed: true;
}

export interface ServerStopAndCaptureV1 {
	readonly schema: "server-stop-and-capture/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex | null;
	readonly drainDeadlineMs: number;
}

/**
 * §1.3's registry edit. The plan freezes `snapshotFrame` and
 * `linuxRelayObservation` as nested records; carrying them base64-encoded lets
 * the rig digest the bytes the child sent instead of a re-canonicalisation of
 * fields it parsed, and it matches the shape `rig-capture-complete-ack/v1`
 * already uses one hop later (`cross-supervisor-protocol.ts:2592-2601`).
 */
export interface ServerCaptureAckV1 {
	readonly schema: "server-capture-ack/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly snapshotFrameBase64: string;
	readonly linuxRelayObservationBase64: string | null;
}

export interface ServerTeardownV1 {
	readonly schema: "server-teardown/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
}

export interface ServerStoppedV1 {
	readonly schema: "server-stopped/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly exitCode: number;
	readonly allSessionsClosed: true;
}

function buildWithTable<T>(schema: string, record: Rec): ChildPipeResult<T> {
	const parsed = parseChildRecordWithTable(schema, record);
	if (!parsed.ok) return parsed;
	return { ok: true, value: parsed.value as unknown as T };
}

export function buildChildPipeRefusal(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly code: ChildPipeRefusalCode;
}): ChildPipeResult<ChildPipeRefusalV1> {
	return parseChildPipeRefusal({
		schema: "child-pipe-refusal/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		code: args.code,
		terminal: true,
	});
}

export function buildServerBindExecution(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly rigExecutionAcceptanceSha256: string;
	readonly cohortGrantBase64: string | null;
	readonly cohortGrantSignatureBase64: string | null;
	readonly macExecutionGrantReceiptBase64: string | null;
	readonly macExecutionGrantSignatureBase64: string | null;
}): ChildPipeResult<ServerBindExecutionV1> {
	return parseServerBindExecution({
		schema: "server-bind-execution/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		rigExecutionAcceptanceSha256: args.rigExecutionAcceptanceSha256,
		cohortGrantBase64: args.cohortGrantBase64,
		cohortGrantSignatureBase64: args.cohortGrantSignatureBase64,
		macExecutionGrantReceiptBase64: args.macExecutionGrantReceiptBase64,
		macExecutionGrantSignatureBase64: args.macExecutionGrantSignatureBase64,
	});
}

export function buildServerReady(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: string;
	readonly cohortGrantSha256: string | null;
	readonly listeningAddress: string;
}): ChildPipeResult<ServerReadyV1> {
	return buildWithTable("server-ready/v1", {
		schema: "server-ready/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		childPid: args.childPid,
		childPgid: args.childPgid,
		childInstanceNonce: args.childInstanceNonce,
		cohortGrantSha256: args.cohortGrantSha256,
		listeningAddress: args.listeningAddress,
	});
}

export function parseServerReady(
	value: unknown,
): ChildPipeResult<ServerReadyV1> {
	return buildWithTable("server-ready/v1", value as Rec);
}

export function buildServerWarmupStart(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortWarmupEpochBase64: string;
	readonly cohortWarmupEpochSignatureBase64: string;
}): ChildPipeResult<ServerWarmupStartV1> {
	return buildWithTable("server-warmup-start/v1", {
		schema: "server-warmup-start/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		cohortWarmupEpochBase64: args.cohortWarmupEpochBase64,
		cohortWarmupEpochSignatureBase64: args.cohortWarmupEpochSignatureBase64,
	});
}

export function parseServerWarmupStart(
	value: unknown,
): ChildPipeResult<ServerWarmupStartV1> {
	return buildWithTable("server-warmup-start/v1", value as Rec);
}

export function buildServerWarmupDrainAndReset(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortWarmupEpochSha256: string;
	readonly roleWarmupCompletionManifestSha256: string;
}): ChildPipeResult<ServerWarmupDrainAndResetV1> {
	return buildWithTable("server-warmup-drain-and-reset/v1", {
		schema: "server-warmup-drain-and-reset/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		cohortWarmupEpochSha256: args.cohortWarmupEpochSha256,
		roleWarmupCompletionManifestSha256: args.roleWarmupCompletionManifestSha256,
	});
}

export function parseServerWarmupDrainAndReset(
	value: unknown,
): ChildPipeResult<ServerWarmupDrainAndResetV1> {
	return buildWithTable("server-warmup-drain-and-reset/v1", value as Rec);
}

/**
 * The drain report. `warmupQueuesEmpty` and `measuredCountersZero` are frozen
 * `true` for the reason `warmupCountersZero` is: a child that would have to say
 * `false` has not drained, and §5 has no state for a dirty measured start. It
 * refuses instead of reporting.
 */
export function buildServerWarmupDrained(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortWarmupEpochSha256: string;
	readonly roleWarmupCompletionManifestSha256: string;
	readonly warmupIngress: number;
	readonly warmupDeliveries: number;
	readonly publisherWarmupEndCount: number;
	readonly subscriberWarmupEndCount: number;
	readonly drainedAtLinuxNs: string;
	readonly linuxClockId: string;
}): ChildPipeResult<ServerWarmupDrainedV1> {
	return buildWithTable("server-warmup-drained/v1", {
		schema: "server-warmup-drained/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		cohortWarmupEpochSha256: args.cohortWarmupEpochSha256,
		roleWarmupCompletionManifestSha256: args.roleWarmupCompletionManifestSha256,
		warmupIngress: args.warmupIngress,
		warmupDeliveries: args.warmupDeliveries,
		publisherWarmupEndCount: args.publisherWarmupEndCount,
		subscriberWarmupEndCount: args.subscriberWarmupEndCount,
		warmupQueuesEmpty: true,
		measuredCountersZero: true,
		drainedAtLinuxNs: args.drainedAtLinuxNs,
		linuxClockId: args.linuxClockId,
	});
}

export function parseServerWarmupDrained(
	value: unknown,
): ChildPipeResult<ServerWarmupDrainedV1> {
	return buildWithTable("server-warmup-drained/v1", value as Rec);
}

export function buildServerMeasureStart(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly warmupCompleteSha256: string | null;
}): ChildPipeResult<ServerMeasureStartV1> {
	return buildWithTable("server-measure-start/v1", {
		schema: "server-measure-start/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		warmupCompleteSha256: args.warmupCompleteSha256,
	});
}

export function parseServerMeasureStart(
	value: unknown,
): ChildPipeResult<ServerMeasureStartV1> {
	return buildWithTable("server-measure-start/v1", value as Rec);
}

export function buildServerMeasureStartAck(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly baselineBusyMs: number;
	readonly baselineAtLinuxNs: string;
	readonly linuxClockId: string;
}): ChildPipeResult<ServerMeasureStartAckV1> {
	return buildWithTable("server-measure-start-ack/v1", {
		schema: "server-measure-start-ack/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		baselineBusyMs: args.baselineBusyMs,
		baselineAtLinuxNs: args.baselineAtLinuxNs,
		linuxClockId: args.linuxClockId,
	});
}

export function parseServerMeasureStartAck(
	value: unknown,
): ChildPipeResult<ServerMeasureStartAckV1> {
	return buildWithTable("server-measure-start-ack/v1", value as Rec);
}

export function buildServerPresentStartBarrier(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortStartBarrierBase64: string;
	readonly cohortStartBarrierSignatureBase64: string;
}): ChildPipeResult<ServerPresentStartBarrierV1> {
	return buildWithTable("server-present-start-barrier/v1", {
		schema: "server-present-start-barrier/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		cohortStartBarrierBase64: args.cohortStartBarrierBase64,
		cohortStartBarrierSignatureBase64: args.cohortStartBarrierSignatureBase64,
	});
}

export function parseServerPresentStartBarrier(
	value: unknown,
): ChildPipeResult<ServerPresentStartBarrierV1> {
	return buildWithTable("server-present-start-barrier/v1", value as Rec);
}

export function buildServerStartBarrierAccepted(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortStartBarrierSha256: string;
	readonly acceptedAtLinuxNs: string;
	readonly linuxClockId: string;
}): ChildPipeResult<ServerStartBarrierAcceptedV1> {
	return buildWithTable("server-start-barrier-accepted/v1", {
		schema: "server-start-barrier-accepted/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		cohortStartBarrierSha256: args.cohortStartBarrierSha256,
		acceptedAtLinuxNs: args.acceptedAtLinuxNs,
		linuxClockId: args.linuxClockId,
		measuredTrafficAllowed: true,
	});
}

export function parseServerStartBarrierAccepted(
	value: unknown,
): ChildPipeResult<ServerStartBarrierAcceptedV1> {
	return buildWithTable("server-start-barrier-accepted/v1", value as Rec);
}

export function buildServerStopAndCapture(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly cohortStartBarrierSha256: string | null;
	readonly drainDeadlineMs: number;
}): ChildPipeResult<ServerStopAndCaptureV1> {
	return buildWithTable("server-stop-and-capture/v1", {
		schema: "server-stop-and-capture/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		cohortStartBarrierSha256: args.cohortStartBarrierSha256,
		drainDeadlineMs: args.drainDeadlineMs,
	});
}

export function parseServerStopAndCapture(
	value: unknown,
): ChildPipeResult<ServerStopAndCaptureV1> {
	return buildWithTable("server-stop-and-capture/v1", value as Rec);
}

export function buildServerCaptureAck(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly snapshotFrameBase64: string;
	readonly linuxRelayObservationBase64: string | null;
}): ChildPipeResult<ServerCaptureAckV1> {
	return buildWithTable("server-capture-ack/v1", {
		schema: "server-capture-ack/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		snapshotFrameBase64: args.snapshotFrameBase64,
		linuxRelayObservationBase64: args.linuxRelayObservationBase64,
	});
}

export function parseServerCaptureAck(
	value: unknown,
): ChildPipeResult<ServerCaptureAckV1> {
	return buildWithTable("server-capture-ack/v1", value as Rec);
}

export function buildServerTeardown(args: {
	readonly sequence: number;
	readonly executionSha256: string;
}): ChildPipeResult<ServerTeardownV1> {
	return buildWithTable("server-teardown/v1", {
		schema: "server-teardown/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
	});
}

export function parseServerTeardown(
	value: unknown,
): ChildPipeResult<ServerTeardownV1> {
	return buildWithTable("server-teardown/v1", value as Rec);
}

export function buildServerStopped(args: {
	readonly sequence: number;
	readonly executionSha256: string;
	readonly exitCode: number;
}): ChildPipeResult<ServerStoppedV1> {
	return buildWithTable("server-stopped/v1", {
		schema: "server-stopped/v1",
		sequence: args.sequence,
		executionSha256: args.executionSha256,
		exitCode: args.exitCode,
		allSessionsClosed: true,
	});
}

export function parseServerStopped(
	value: unknown,
): ChildPipeResult<ServerStoppedV1> {
	return buildWithTable("server-stopped/v1", value as Rec);
}

/** The one entry point a reader that knows what it expects should use. */
export function parseServerChildPayload(
	schema: string,
	value: unknown,
): ChildPipeResult<Rec> {
	switch (schema) {
		case "child-pipe-refusal/v1":
			return parseChildPipeRefusal(value) as ChildPipeResult<Rec>;
		case "server-bind-execution/v1":
			return parseServerBindExecution(value) as ChildPipeResult<Rec>;
		case "server-warmup-ready/v1":
			return parseServerWarmupReady(value) as ChildPipeResult<Rec>;
		default:
			return parseChildRecordWithTable(schema, value);
	}
}

/** Encode a lifecycle frame at the §3.4 control cap its schema registers. */
export function encodeServerChildFrame(
	payload: Rec & { schema: string },
): ChildPipeResult<Uint8Array> {
	const bound = serverChildFrameBoundForSchema(payload.schema);
	if (bound === null) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: `unregistered server-child schema ${payload.schema}`,
		};
	}
	return encodeChildPipeFrame(payload, bound);
}

/**
 * Decode a lifecycle frame. `expectedSchema` is the state machine's own
 * expectation; passing it turns a frame of the wrong kind into `STATE_INVALID`
 * at the point that knows the difference, rather than a parse failure later.
 */
export function decodeServerChildFrame(
	frame: Uint8Array,
	expectedSchema?: string,
): ChildPipeResult<Rec> {
	if (expectedSchema !== undefined && !isServerChildSchema(expectedSchema)) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: `unregistered server-child schema ${expectedSchema}`,
		};
	}
	const decoded = decodeChildPipeFrame(frame, CHILD_PIPE_CONTROL_MAX_BYTES);
	if (!decoded.ok) return decoded;
	const schema = decoded.value.schema;
	if (typeof schema !== "string" || !isServerChildSchema(schema)) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: "unregistered server-child schema",
		};
	}
	if (expectedSchema !== undefined && schema !== expectedSchema) {
		return {
			ok: false,
			code: "STATE_INVALID",
			message: `expected ${expectedSchema}, read ${schema}`,
		};
	}
	return parseServerChildPayload(schema, decoded.value);
}

// ---------------------------------------------------------------------------
// The §1.3 lifecycle state machine.
//
// Seven frames each way, in one order, with an independent sequence per
// direction. A refusal is admissible wherever the peer is in the order --
// that is what makes it a refusal rather than an eighth state -- and it ends
// the stream in both directions.
// ---------------------------------------------------------------------------

export const SERVER_CHILD_RIG_TO_CHILD_ORDER = [
	"server-bind-execution/v1",
	"server-warmup-start/v1",
	"server-warmup-drain-and-reset/v1",
	"server-measure-start/v1",
	"server-present-start-barrier/v1",
	"server-stop-and-capture/v1",
	"server-teardown/v1",
] as const;

export const SERVER_CHILD_CHILD_TO_RIG_ORDER = [
	"server-ready/v1",
	"server-warmup-ready/v1",
	"server-warmup-drained/v1",
	"server-measure-start-ack/v1",
	"server-start-barrier-accepted/v1",
	"server-capture-ack/v1",
	"server-stopped/v1",
] as const;

/**
 * The ordinary A5 arm's four frames each way.
 *
 * Amendment C4 line 76 puts ordinary traffic on the base plan's signed server
 * lifecycle, and an ordinary arm has no cohort: no warmup epoch to open, no
 * drain to reset counters that were never fanned out, and no start barrier to
 * release publishers that do not exist. What is left is the §5 spine -- bind,
 * baseline, capture, teardown -- and the nullable joins the frames above
 * already type for it (`cohortGrantBase64`, `warmupCompleteSha256`,
 * `cohortStartBarrierSha256`).
 *
 * It is a separate order rather than a skip rule: the arm is decided once, by
 * the bind frame, and after that each direction is as exact as the cohort's.
 */
export const SERVER_CHILD_RIG_TO_CHILD_ORDINARY_ORDER = [
	"server-bind-execution/v1",
	"server-measure-start/v1",
	"server-stop-and-capture/v1",
	"server-teardown/v1",
] as const;

export const SERVER_CHILD_CHILD_TO_RIG_ORDINARY_ORDER = [
	"server-ready/v1",
	"server-measure-start-ack/v1",
	"server-capture-ack/v1",
	"server-stopped/v1",
] as const;

/** Which arm a child-pipe stream is on. */
export type ServerChildArm = "cohort" | "ordinary";

export type ServerChildDirection = "rigToChild" | "childToRig";

export interface ServerChildDirectionState {
	/** The next legal `sequence` on this direction. */
	sequence: number;
	/** How far along its seven-frame order this direction has come. */
	index: number;
}

export interface ServerChildLifecycle {
	readonly rigToChild: ServerChildDirectionState;
	readonly childToRig: ServerChildDirectionState;
	/**
	 * Which order the two directions are walking. Every stream starts on the
	 * cohort order because the bind frame is index 0 of both, and only the
	 * bind can move it (`narrowServerChildLifecycleToOrdinary`).
	 */
	arm: ServerChildArm;
	terminal: {
		readonly direction: ServerChildDirection;
		readonly schema: string;
	} | null;
}

export function createServerChildLifecycle(): ServerChildLifecycle {
	return {
		rigToChild: { sequence: 0, index: 0 },
		childToRig: { sequence: 0, index: 0 },
		arm: "cohort",
		terminal: null,
	};
}

/**
 * Put this stream on the ordinary order, having read a bind frame that
 * carries no cohort grant.
 *
 * Legal at exactly one point: the bind has been read and nothing has been
 * answered. Anywhere else the two orders have already diverged, and moving
 * between them would let a peer re-choose which frames it owes after it has
 * seen some of them.
 */
export function narrowServerChildLifecycleToOrdinary(
	lifecycle: ServerChildLifecycle,
): ChildPipeResult<true> {
	if (
		lifecycle.terminal !== null ||
		lifecycle.arm !== "cohort" ||
		lifecycle.rigToChild.index !== 1 ||
		lifecycle.childToRig.index !== 0
	) {
		return {
			ok: false,
			code: "STATE_INVALID",
			message: "the arm is fixed by the bind frame and only there",
		};
	}
	lifecycle.arm = "ordinary";
	return { ok: true, value: true };
}

function orderFor(
	direction: ServerChildDirection,
	arm: ServerChildArm,
): readonly string[] {
	if (arm === "ordinary") {
		return direction === "rigToChild"
			? SERVER_CHILD_RIG_TO_CHILD_ORDINARY_ORDER
			: SERVER_CHILD_CHILD_TO_RIG_ORDINARY_ORDER;
	}
	return direction === "rigToChild"
		? SERVER_CHILD_RIG_TO_CHILD_ORDER
		: SERVER_CHILD_CHILD_TO_RIG_ORDER;
}

export function stepServerChildLifecycle(
	lifecycle: ServerChildLifecycle,
	direction: ServerChildDirection,
	frame: { readonly schema: string; readonly sequence: number },
): ChildPipeResult<true> {
	if (lifecycle.terminal !== null) {
		return {
			ok: false,
			code: "STATE_INVALID",
			message: `stream ended at ${lifecycle.terminal.schema}`,
		};
	}
	const state = lifecycle[direction];
	if (!isSafeNonNegInt(frame.sequence) || frame.sequence !== state.sequence) {
		return {
			ok: false,
			code: "SEQUENCE_INVALID",
			message: `${direction} expected ${state.sequence}`,
		};
	}
	if (state.sequence >= CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION) {
		return { ok: false, code: "SEQUENCE_INVALID", message: "direction cap" };
	}
	if (frame.schema === "child-pipe-refusal/v1") {
		state.sequence += 1;
		lifecycle.terminal = { direction, schema: frame.schema };
		return { ok: true, value: true };
	}
	const order = orderFor(direction, lifecycle.arm);
	const expected = order[state.index];
	if (expected === undefined || frame.schema !== expected) {
		return {
			ok: false,
			code: "STATE_INVALID",
			message: `${direction} expected ${expected ?? "no further frame"}, read ${frame.schema}`,
		};
	}
	state.sequence += 1;
	state.index += 1;
	return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Phase-B role-child frame registration (plan §3.4 framing, §4.3 record set).
//
// The Mac<->role-child pipe reuses this codec unchanged: `u32be length ||
// canonical JSON`, independent per-direction sequence. What Phase B adds is a
// second kind set with its own bounds -- `role-spawn-config/v1` is the one
// frame allowed past the 64 KiB control cap, and partials get the 256 KiB
// partial cap -- plus a per-direction frame ceiling that scales with the
// child's assigned sessions because of the global ramp permit protocol.
//
// Registration only. Record-level validation for each kind lives with the
// records themselves in `cohort-protocol.ts` (§4.3); this module deliberately
// does not import it, so the transport layer stays free of the record layer.
// The caps that appear in both places are pinned equal by test.
// ---------------------------------------------------------------------------

/** §4.3: the one frame allowed past the control cap, at 512 KiB. */
export const ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES = 512 * 1024;
/** §3.4: `2 * assignedSessionCount + 64` frames per role direction. */
export const ROLE_CHILD_FRAMES_PER_SESSION = 2;
export const ROLE_CHILD_BASE_FRAMES_PER_DIRECTION = 64;

/** The §4.3 role-child control set, plus the refusal both pipes share. */
export const PHASE_B_ROLE_CHILD_SCHEMAS = [
	"child-pipe-refusal/v1",
	"role-spawn-config/v1",
	"role-ready/v1",
	"connect-permit-request/v1",
	"connect-permit-grant/v1",
	"connect-permit-complete/v1",
	"role-warmup-start/v1",
	"role-warmup-complete/v1",
	"role-measure-start/v1",
	"role-measure-start-ack/v1",
	"role-stop/v1",
	"role-partial/v1",
	"role-partial-accepted/v1",
	"role-exit/v1",
	"role-exited/v1",
	"role-failed/v1",
] as const;

export type RoleChildSchema = (typeof PHASE_B_ROLE_CHILD_SCHEMAS)[number];

export function isRoleChildSchema(schema: string): schema is RoleChildSchema {
	return (PHASE_B_ROLE_CHILD_SCHEMAS as readonly string[]).includes(schema);
}

/** The registered frame bound for a role-child kind, or null if not a kind. */
export function roleChildFrameBoundForSchema(schema: string): number | null {
	if (!isRoleChildSchema(schema)) return null;
	if (schema === "role-spawn-config/v1") {
		return ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES;
	}
	if (schema === "role-partial/v1") return CHILD_PIPE_PARTIAL_MAX_BYTES;
	return CHILD_PIPE_CONTROL_MAX_BYTES;
}

/**
 * The per-direction frame ceiling for one role child. It scales with assigned
 * sessions because each session costs a permit request and a completion; the
 * fixed 64 covers spawn, readiness, warmup, barrier, partials, and teardown.
 */
export function roleChildMaxFramesPerDirection(
	assignedSessionCount: number,
): number {
	if (!Number.isSafeInteger(assignedSessionCount) || assignedSessionCount < 0) {
		throw new TypeError(
			`assignedSessionCount must be a non-negative safe integer: ${assignedSessionCount}`,
		);
	}
	return (
		ROLE_CHILD_FRAMES_PER_SESSION * assignedSessionCount +
		ROLE_CHILD_BASE_FRAMES_PER_DIRECTION
	);
}

/** Encode a role-child frame at the bound its own kind is registered with. */
export function encodeRoleChildFrame(
	payload: Rec & { schema: string },
): ChildPipeResult<Uint8Array> {
	const bound = roleChildFrameBoundForSchema(payload.schema);
	if (bound === null) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: `unregistered role-child schema ${payload.schema}`,
		};
	}
	return encodeChildPipeFrame(payload, bound);
}

/**
 * Decode a role-child frame. `expectedSchema` is the state machine's own
 * expectation: passing it bounds the read at that kind's cap before the
 * payload is parsed, which is the only way this codec can refuse an oversized
 * frame early -- unlike the remote codec it carries no header to peek at.
 * Without it the frame is bounded at the largest registered role-child cap and
 * the kind's own cap is enforced once the schema is known.
 */
export function decodeRoleChildFrame(
	frame: Uint8Array,
	expectedSchema?: string,
): ChildPipeResult<Rec> {
	let bound = ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES;
	if (expectedSchema !== undefined) {
		const expectedBound = roleChildFrameBoundForSchema(expectedSchema);
		if (expectedBound === null) {
			return {
				ok: false,
				code: "FRAME_INVALID",
				message: `unregistered role-child schema ${expectedSchema}`,
			};
		}
		bound = expectedBound;
	}
	const decoded = decodeChildPipeFrame(frame, bound);
	if (!decoded.ok) return decoded;
	const schema = decoded.value.schema;
	if (typeof schema !== "string" || !isRoleChildSchema(schema)) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: "unregistered role-child schema",
		};
	}
	if (expectedSchema !== undefined && schema !== expectedSchema) {
		return {
			ok: false,
			code: "STATE_INVALID",
			message: `expected ${expectedSchema}, read ${schema}`,
		};
	}
	const actualBound = roleChildFrameBoundForSchema(schema);
	if (actualBound !== null && frame.byteLength - 4 > actualBound) {
		return { ok: false, code: "FRAME_INVALID", message: "oversize for kind" };
	}
	return { ok: true, value: decoded.value };
}

/**
 * Reassemble role-child frames from a byte stream (B3).
 *
 * A pipe hands a child arbitrary chunk boundaries, so the length prefix is the
 * only thing that says where one frame ends. This reader keeps the prefix on
 * each frame it yields, so what comes out is exactly what `decodeRoleChildFrame`
 * takes. The declared length is checked against the bound before a single byte
 * is buffered for it, which is what keeps a lying prefix from making the child
 * allocate: an oversize declaration is terminal for the stream rather than a
 * frame the reader waits to fill.
 */
export class RoleChildFrameReader {
	private readonly maxBytes: number;
	private buffer: Uint8Array = new Uint8Array(0);
	private poisoned = false;

	constructor(maxBytes: number = ROLE_CHILD_SPAWN_CONFIG_MAX_BYTES) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
			throw new TypeError(`maxBytes must be a positive safe integer`);
		}
		this.maxBytes = maxBytes;
	}

	/** Bytes held for a frame that has not arrived in full yet. */
	get pendingBytes(): number {
		return this.buffer.byteLength;
	}

	push(chunk: Uint8Array): ChildPipeResult<Uint8Array[]> {
		if (this.poisoned) {
			return { ok: false, code: "FRAME_INVALID", message: "reader poisoned" };
		}
		if (chunk.byteLength > 0) {
			const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
			merged.set(this.buffer, 0);
			merged.set(chunk, this.buffer.byteLength);
			this.buffer = merged;
		}
		const frames: Uint8Array[] = [];
		while (this.buffer.byteLength >= 4) {
			const declared = new DataView(
				this.buffer.buffer,
				this.buffer.byteOffset,
				this.buffer.byteLength,
			).getUint32(0, false);
			if (declared > this.maxBytes) {
				this.poisoned = true;
				return { ok: false, code: "FRAME_INVALID", message: "oversize" };
			}
			const total = 4 + declared;
			if (this.buffer.byteLength < total) break;
			frames.push(this.buffer.slice(0, total));
			this.buffer = this.buffer.slice(total);
		}
		return { ok: true, value: frames };
	}

	/** A stream that ends mid-frame lost bytes; only an empty buffer is clean. */
	endOfStream(): ChildPipeResult<true> {
		if (this.poisoned || this.buffer.byteLength > 0) {
			return { ok: false, code: "FRAME_INVALID", message: "truncated at eof" };
		}
		return { ok: true, value: true };
	}
}
