/**
 * The terminal contract for `server.close()`.
 *
 * Closing a server is the point where the process is allowed to end, so the
 * promise has to mean something specific and it has to be bounded. It resolves
 * once, in this order: the native side has stopped accepting, marked every
 * session this server owns closed, and settled the N-API futures those sessions
 * held; then every session's `closed` promise has been resolved for the app;
 * then in-flight `onSession` callbacks have drained or their budget expired.
 *
 * Bounded is the load-bearing word. The native wait has its own grace/abort
 * budget and reports what was still in flight if it runs out; the callback
 * drain here is capped. A close that hangs is worse than a close that reports
 * what it could not finish.
 */

import type { CloseInfo } from "./types.js";

/**
 * Close code and reason a session gets when this server ends it during
 * shutdown. Mirrors `SERVER_CLOSING_CLOSE_CODE` in the native addon so an app
 * sees the same reason whether the event came off the wire or from this
 * fallback, and can tell a reaped session from a lost one.
 */
export const SERVER_CLOSING_CLOSE_CODE = 3993;
export const SERVER_CLOSING_CLOSE_REASON = "E_SERVER_CLOSING";

/** How long the contract waits for in-flight `onSession` callbacks. */
export const ONSESSION_DRAIN_TIMEOUT_MS = 5000;

export type ServerCloseDeps = {
	/** Stops the endpoint and waits out the native drain. Bounded natively. */
	closeNative: () => Promise<void>;
	/** Resolves the `closed` promise of every session this server still owns. */
	resolveOwnedSessions: (info: CloseInfo) => void;
	/** How many `onSession` callbacks have not returned yet. */
	pendingOnSessionCallbacks: () => number;
	/** Resolves once `pendingOnSessionCallbacks()` reaches zero. */
	awaitOnSessionDrain: () => Promise<void>;
	drainTimeoutMs?: number;
};

/**
 * Build the `close` implementation. Calling it more than once returns the same
 * promise: closing twice must not start a second drain, and a caller racing
 * two closes must not get one that resolves before the work is done.
 */
export function createServerCloseContract(
	deps: ServerCloseDeps,
): () => Promise<void> {
	let inFlight: Promise<void> | null = null;
	return () => {
		inFlight ??= runClose(deps);
		return inFlight;
	};
}

async function runClose(deps: ServerCloseDeps): Promise<void> {
	await deps.closeNative();
	deps.resolveOwnedSessions({
		code: SERVER_CLOSING_CLOSE_CODE,
		reason: SERVER_CLOSING_CLOSE_REASON,
	});
	if (deps.pendingOnSessionCallbacks() <= 0) return;
	const budget = deps.drainTimeoutMs ?? ONSESSION_DRAIN_TIMEOUT_MS;
	// Clear the timer if the drain wins the race, so a resolved close does not
	// keep the event loop alive for the rest of the budget.
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			deps.awaitOnSessionDrain(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, budget);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
