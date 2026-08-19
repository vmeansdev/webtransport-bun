/**
 * The bounded shutdown every bench conductor ends under.
 *
 * A conductor that writes its artifact and then falls off the end of `main()`
 * is not finished — it is *hoping* to finish. G11's first invocation sat 18
 * minutes past a complete artifact with no children left, and G10's sat about
 * seven. Nothing was running; the process simply could not exit.
 *
 * The mechanism is documented in the product itself, in
 * `crates/native/src/server.rs`:
 *
 *     `pending_async_ops` is the N-API half of the answer and the reason this
 *     predicate exists in this shape: tracked tokio tasks are abortable, but an
 *     unsettled `Env::spawn_future` promise is not — it keeps the host event
 *     loop referenced until it resolves. A close that ignored them could report
 *     a clean shutdown and still leave the process alive with no sockets open.
 *
 * `server.close()` is bounded natively (5 s grace + 5 s abort) and rejects with
 * `E_BACKPRESSURE_TIMEOUT: ... asyncOpsPending=N` when it cannot reach idle. But
 * a bounded close is not a bounded *process*: the promises it names as still
 * pending are exactly the ones it cannot abort, and each one holds Bun's event
 * loop open until it settles on its own. On a fleet of sessions whose peers
 * were killed off-box — no ICMP, and quinn ships no default idle timeout — some
 * of them never do.
 *
 * So the exit has to be taken, not awaited. This module takes it, in an order
 * that gives the graceful path a fair chance first:
 *
 *   1. kill the generator children, so the drain is not racing live peers;
 *   2. close the server under a budget, and treat a failure as a fact to
 *      report rather than an exception to propagate;
 *   3. exit explicitly, after the artifact is durable on disk.
 *
 * Step 3 is why `writeArtifactDurable` lives here too. `process.exit` with a
 * write still in the page cache would trade a slow run for a lost one.
 *
 * Harness-only. Nothing here changes a product default: whether the *server*
 * should ship an idle timeout so those sessions reap themselves is a
 * maintainer's decision, recorded as a recommendation in
 * `.scratch/high-load-excellence/issues/01-harness-hardening.md`, not taken here.
 */

import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";

/**
 * How long `close()` gets before the conductor stops waiting on it.
 *
 * Twice the native drain's own ceiling (`CloseDrainTiming::production` is 5 s
 * grace + 5 s abort) plus the close contract's 5 s `onSession` drain, rounded
 * up. Chosen for a reason that does not depend on a measured number: if the
 * product's own bounded close has not returned in twice its own budget, it is
 * not going to, and every further second is a second the run is not finished.
 */
export const CLOSE_BUDGET_MS = 30_000;

/** A beat for the last console writes to reach the pipe before `exit`. */
export const EXIT_FLUSH_MS = 100;

export type ShutdownCloseState =
	/** `close()` resolved inside the budget. */
	| "closed"
	/** `close()` rejected inside the budget — usually the drain timing out. */
	| "close-failed"
	/** `close()` had not settled when the budget ran out. */
	| "budget-expired";

export type ShutdownOutcome = {
	closeState: ShutdownCloseState;
	closeMs: number;
	/** The close rejection's message, which names the lane that held the refs. */
	closeError: string | null;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write `contents` to `path` and fsync it, so a later `process.exit` cannot
 * lose the run. The artifact is the whole point of the invocation; an exit that
 * races its own write would be a worse bug than the linger it fixes.
 */
export function writeArtifactDurable(path: string, contents: string): void {
	writeFileSync(path, contents);
	// Opened "r+": fsync on a read-only descriptor is permitted but not
	// universally honoured, and this call is the whole point of the function.
	const fd = openSync(path, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export type CloseBoundedOptions = {
	budgetMs?: number;
	/** Injected only by tests. */
	sleepFn?: (ms: number) => Promise<void>;
	now?: () => number;
};

/**
 * Run `close` under a budget and always return, never throw.
 *
 * A conductor that lets `close()` reject takes the whole run down at the one
 * moment it has nothing left to lose — and in G10's shape that rejection would
 * land after the artifact was already written, turning a finished run into a
 * non-zero exit. The rejection is worth *recording*, because its message names
 * which lane still held N-API references; it is not worth propagating.
 */
export async function closeBounded(
	close: () => Promise<unknown>,
	options: CloseBoundedOptions = {},
): Promise<ShutdownOutcome> {
	const budgetMs = options.budgetMs ?? CLOSE_BUDGET_MS;
	const now = options.now ?? Date.now;
	const sleepFn = options.sleepFn ?? sleep;
	const startedAt = now();

	let state: ShutdownCloseState = "budget-expired";
	let closeError: string | null = null;
	// Derived rather than raced directly: a rejection racing a timer that wins
	// leaves an unhandled rejection behind, which is the failure mode this
	// function exists to prevent.
	let attempt: Promise<void>;
	try {
		attempt = Promise.resolve(close()).then(
			() => {
				state = "closed";
			},
			(err: unknown) => {
				state = "close-failed";
				closeError = err instanceof Error ? err.message : String(err);
			},
		);
	} catch (err) {
		// A `close` that throws synchronously never produced a promise at all.
		return {
			closeState: "close-failed",
			closeMs: now() - startedAt,
			closeError: err instanceof Error ? err.message : String(err),
		};
	}

	await Promise.race([attempt, sleepFn(budgetMs)]);
	return { closeState: state, closeMs: now() - startedAt, closeError };
}

export type FinishRunOptions = {
	/** Closes every server the conductor owns. May reject; that is recorded. */
	closeServer: () => Promise<unknown>;
	/**
	 * Kills the generator children. Runs *before* the close: a drain racing live
	 * peers spends its whole grace period watching `sessionsActive` not fall.
	 */
	killChildren?: () => void;
	/** Reports what the shutdown did, for the conductor's log. */
	onNote?: (note: string) => void;
	budgetMs?: number;
	/** Exit code to take. Non-zero only when the run itself failed. */
	exitCode?: number;
	/** Injected only by tests, which must not exit the test runner. */
	exit?: (code: number) => never;
	sleepFn?: (ms: number) => Promise<void>;
	now?: () => number;
};

/**
 * End the process, bounded, after the artifact is already durable.
 *
 * Returns only in tests, where `exit` is injected; in a conductor the injected
 * default never returns.
 */
export async function finishRun(
	options: FinishRunOptions,
): Promise<ShutdownOutcome> {
	const {
		closeServer,
		killChildren,
		onNote,
		budgetMs,
		exitCode = 0,
		sleepFn = sleep,
		now = Date.now,
	} = options;
	const exit = options.exit ?? ((code: number) => process.exit(code));

	if (killChildren) {
		try {
			killChildren();
		} catch (err) {
			onNote?.(`killing children failed: ${String(err)}`);
		}
	}

	const outcome = await closeBounded(closeServer, {
		budgetMs,
		sleepFn,
		now,
	});
	if (outcome.closeState === "closed")
		onNote?.(`server closed in ${outcome.closeMs} ms`);
	else if (outcome.closeState === "close-failed")
		onNote?.(
			`server close failed after ${outcome.closeMs} ms — exiting anyway: ${outcome.closeError}`,
		);
	else
		onNote?.(
			`server close did not settle within ${outcome.closeMs} ms — exiting anyway; ` +
				"this is the retained-N-API-reference shape, not a slow run",
		);

	await sleepFn(EXIT_FLUSH_MS);
	exit(exitCode);
	return outcome;
}
