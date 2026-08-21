/**
 * The mirror-send cap, the failure-code decode table, and the validation that
 * keeps a programming error from ever crossing N-API.
 *
 * The cap is one number in this codebase. Native holds the only other copy, in
 * `crates/native/src/datagram_mirror.rs`, and
 * `packages/webtransport/test/native-datagram-mirror.test.ts` asserts the two
 * agree and that no third has appeared.
 */

import {
	E_INTERNAL,
	E_INVALID_ARGUMENT,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	WebTransportError,
} from "./errors.js";
import type { ErrorCode } from "./types.js";

/**
 * Largest target list one mirror call may carry.
 *
 * Deliberately not {@link DATAGRAM_BATCH_MAX}: that cap bounds payload memory
 * held outside the queue's byte reservation, and a mirror holds one payload
 * whatever the target count is. This one bounds *time*. The call is
 * synchronous, so it stalls the JS thread for its whole duration; a 1 ms stall
 * budget at the worst measured per-target cost of the shipped target shape
 * allows ~11,000 targets, and 10,000 is the round number under it.
 *
 * The wrapper deliberately does **not** chunk past it. Splitting a target list
 * across two calls is observably identical to one call over the union — there
 * is no deadline to divide and no ordering across targets — so a caller
 * broadcasting to more subscribers than this should be the one deciding when to
 * yield the loop. (That is exactly the property `sendDatagramBatch` lacks,
 * which is why *it* chunks and this does not.)
 */
export const DATAGRAM_MIRROR_MAX = 10_000;

/** What native returns: failures only, as two parallel typed arrays. */
export type NativeDatagramMirrorResult = {
	sent: number;
	failed: Uint32Array;
	codes: Uint8Array;
};

/** One target that did not take the payload. */
export type DatagramMirrorFailure = {
	/** The session id, taken from the caller's target list. */
	readonly target: string;
	/** Index of that id in the caller's target list. */
	readonly index: number;
	/** The same error identity every other send path produces. */
	readonly error: WebTransportError;
};

/** What {@link decodeMirrorResult} hands the application. */
export type DatagramMirrorResult = {
	/** Targets that took the payload. */
	readonly sent: number;
	/**
	 * Targets that did not, in target order. Empty — and shared — in the
	 * healthy case, so a successful broadcast to 10,000 subscribers allocates
	 * one small object and nothing else.
	 *
	 * `E_SESSION_CLOSED` entries are the reap list: that subscriber is gone (or
	 * was never this server's). `E_QUEUE_FULL` entries are the retry list: the
	 * mirror never waits, so a target with no queue budget right now lands here
	 * and `session.sendDatagram()` is the parking path for just those.
	 */
	readonly failures: readonly DatagramMirrorFailure[];
};

const NO_FAILURES: readonly DatagramMirrorFailure[] = Object.freeze([]);

/**
 * Native failure code (`u8`) to public error identity.
 *
 * Two native codes share `E_QUEUE_FULL` on purpose. Native distinguishes "this
 * payload is bigger than the target's `maxDatagramSize`" (2) from "the target
 * has no byte budget at this instant" (3), but `E_WOULD_BLOCK` has no public
 * `WebTransportError` identity — it is an internal sentinel of the non-parking
 * send, which `sendDatagram()` consumes and never surfaces — and inventing one
 * would widen the frozen error surface. `E_QUEUE_FULL` is documented as
 * "queue/buffer full (backpressure)", which is what both of them are, and the
 * caller's remedy is the same for both: retry on the parking path, where an
 * oversize payload simply fails again, immediately and terminally.
 *
 * Index 0 is unused: native never emits code 0, and a 0 arriving anyway means
 * an addon/wrapper version skew, which {@link decodeMirrorResult} reports as
 * `E_INTERNAL` rather than silently reading as success.
 */
export const MIRROR_FAILURE_CODES: readonly (ErrorCode | undefined)[] = [
	undefined,
	E_SESSION_CLOSED,
	E_QUEUE_FULL,
	E_QUEUE_FULL,
	E_INVALID_ARGUMENT,
];

/**
 * Turn native's parallel index/code arrays into failures an application can act
 * on: the failing session id rather than an index the caller must resolve back,
 * and the same `WebTransportError` identity as every other send path.
 */
export function decodeMirrorResult(
	targets: readonly string[],
	native: NativeDatagramMirrorResult,
): DatagramMirrorResult {
	if (native.failed.length === 0) {
		return { sent: native.sent, failures: NO_FAILURES };
	}
	const failures: DatagramMirrorFailure[] = [];
	for (let i = 0; i < native.failed.length; i += 1) {
		const index = native.failed[i] as number;
		const target = targets[index] ?? "";
		failures.push({
			target,
			index,
			error: mirrorError(native.codes[i] as number, target, "mirror send to"),
		});
	}
	return { sent: native.sent, failures };
}

/** What native returns from the paced call: refusals only, as parallel arrays. */
export type NativeDatagramMirrorAdmission = {
	/** False when the pacer knob is off and nothing was offered. */
	paced: boolean;
	admitted: number;
	refused: Uint32Array;
	codes: Uint8Array;
};

/**
 * What {@link sendDatagramMirrorPacedChecked} hands the application.
 *
 * This envelope carries no delivery count, and that absence is the design: when
 * a paced call returns, nothing has been resolved, owner-checked or
 * budget-checked — the schedule has taken the targets and the pacer thread will
 * attempt them later. `admitted` says how many it took, and nothing here can be
 * mistaken for how many arrived. Delivery is `admitted` minus the failures that
 * later arrive through `readMirrorReports()`.
 */
export type DatagramMirrorAdmission = {
	/** Targets accepted onto the pacer's schedule. Not a delivery count. */
	readonly admitted: number;
	/**
	 * Targets the schedule refused, in target order, always `E_QUEUE_FULL`:
	 * the queue was already holding its bound of outstanding work.
	 *
	 * A set, not a prefix — each refusal names its own index, so a caller never
	 * has to reconstruct which targets travelled from a boundary. Distinct from
	 * the `E_QUEUE_FULL` *reports* that arrive later, which mean the opposite
	 * end of the path: that target had no byte budget when its turn came.
	 */
	readonly refused: readonly DatagramMirrorFailure[];
};

/** One deferred per-target failure, as native holds it in the ring. */
export type NativeMirrorReport = { target: string; code: number };

/**
 * One deferred failure from a paced broadcast.
 *
 * Failures only: a target that took the payload is never reported, so a healthy
 * broadcast to 10,000 subscribers produces nothing here. `E_SESSION_CLOSED`
 * entries are the reap list and `E_QUEUE_FULL` entries are the retry list,
 * exactly as in the synchronous envelope.
 */
export type MirrorReport = {
	/** The session id, as the caller wrote it in its target list. */
	readonly target: string;
	/** The same error identity every other send path produces. */
	readonly error: WebTransportError;
};

const NO_REPORTS: readonly MirrorReport[] = Object.freeze([]);

/** Shared decode for both envelopes: one native code, one error identity. */
function mirrorError(
	code: number,
	target: string,
	what: string,
): WebTransportError {
	const decoded = MIRROR_FAILURE_CODES[code];
	return new WebTransportError(
		decoded ?? E_INTERNAL,
		decoded
			? `${decoded}: ${what} ${target} failed`
			: `E_INTERNAL: unknown mirror failure code ${code}`,
	);
}

/** Turn native's parallel refusal arrays into the admission envelope. */
export function decodeMirrorAdmission(
	targets: readonly string[],
	native: NativeDatagramMirrorAdmission,
): DatagramMirrorAdmission {
	if (native.refused.length === 0) {
		return { admitted: native.admitted, refused: NO_FAILURES };
	}
	const refused: DatagramMirrorFailure[] = [];
	for (let i = 0; i < native.refused.length; i += 1) {
		const index = native.refused[i] as number;
		const target = targets[index] ?? "";
		refused.push({
			target,
			index,
			error: mirrorError(
				native.codes[i] as number,
				target,
				"paced mirror admission for",
			),
		});
	}
	return { admitted: native.admitted, refused };
}

/** Turn one drained native batch into reports an application can act on. */
export function decodeMirrorReports(
	native: readonly NativeMirrorReport[],
): readonly MirrorReport[] {
	if (native.length === 0) return NO_REPORTS;
	return native.map((entry) => ({
		target: entry.target,
		error: mirrorError(entry.code, entry.target, "paced mirror send to"),
	}));
}

/**
 * Validate the caller's arguments and hand the fan-out to the pacer.
 *
 * The same argument checks as {@link sendDatagramMirrorChecked}, including the
 * same 10,000 cap — but the cap means something different here and the message
 * says so. On the synchronous path it is a JS-thread *stall* budget; a paced
 * call's JS cost is one lock and one gather whatever N is, so here it is an
 * argument-sanity bound. It is kept because a `RangeError` is cheaper to debug
 * than a silent mass refusal, not because the stall derivation still applies.
 */
export function sendDatagramMirrorPacedChecked(
	send: (
		targets: string[],
		payload: Uint8Array,
	) => NativeDatagramMirrorAdmission,
	targets: readonly string[],
	payload: Uint8Array,
): DatagramMirrorAdmission {
	if (!Array.isArray(targets)) {
		throw new TypeError(
			"sendDatagramMirrorPaced expects an array of session ids",
		);
	}
	if (!ArrayBuffer.isView(payload)) {
		throw new TypeError("sendDatagramMirrorPaced expects a Uint8Array payload");
	}
	if (targets.length > DATAGRAM_MIRROR_MAX) {
		throw new RangeError(
			`sendDatagramMirrorPaced accepts at most ${DATAGRAM_MIRROR_MAX} targets; got ${targets.length}. The bound is argument sanity, not a stall budget — a paced call's cost on this thread does not grow with the list.`,
		);
	}
	for (let i = 0; i < targets.length; i += 1) {
		if (typeof targets[i] !== "string") {
			throw new TypeError(
				`sendDatagramMirrorPaced expects string session ids; element ${i} is not one`,
			);
		}
	}
	if (targets.length === 0) return { admitted: 0, refused: NO_FAILURES };
	return decodeMirrorAdmission(targets, send(targets as string[], payload));
}

/**
 * Validate the caller's arguments and send.
 *
 * Deliberately not an `async function` and deliberately throwing: every check
 * here catches a programming error, none of them crosses N-API, and the native
 * call itself is synchronous — so an over-cap list throws `RangeError` before
 * anything is sent, which is the "and sends nothing" half of the cap contract.
 * A transport condition never throws; it lands in `failures`.
 */
export function sendDatagramMirrorChecked(
	send: (targets: string[], payload: Uint8Array) => NativeDatagramMirrorResult,
	targets: readonly string[],
	payload: Uint8Array,
): DatagramMirrorResult {
	if (!Array.isArray(targets)) {
		throw new TypeError("sendDatagramMirror expects an array of session ids");
	}
	if (!ArrayBuffer.isView(payload)) {
		throw new TypeError("sendDatagramMirror expects a Uint8Array payload");
	}
	if (targets.length > DATAGRAM_MIRROR_MAX) {
		throw new RangeError(
			`sendDatagramMirror accepts at most ${DATAGRAM_MIRROR_MAX} targets; got ${targets.length}. Split the list — two calls are observably identical to one call over the union.`,
		);
	}
	for (let i = 0; i < targets.length; i += 1) {
		if (typeof targets[i] !== "string") {
			throw new TypeError(
				`sendDatagramMirror expects string session ids; element ${i} is not one`,
			);
		}
	}
	if (targets.length === 0) return { sent: 0, failures: NO_FAILURES };
	return decodeMirrorResult(targets, send(targets as string[], payload));
}
