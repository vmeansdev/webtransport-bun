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
		const code = MIRROR_FAILURE_CODES[native.codes[i] as number];
		const target = targets[index] ?? "";
		failures.push({
			target,
			index,
			error: new WebTransportError(
				code ?? E_INTERNAL,
				code
					? `${code}: mirror send to ${target} failed`
					: `E_INTERNAL: unknown mirror failure code ${native.codes[i]}`,
			),
		});
	}
	return { sent: native.sent, failures };
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
