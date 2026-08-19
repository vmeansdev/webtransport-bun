/**
 * The per-cell deadline every bench conductor waits under.
 *
 * A conductor that awaits `child.exited` with no bound turns one wedged
 * generator into a wedged run: G7 lost a 117-minute dispatch that way, and G11
 * came close. The deadline here is pre-registered in
 * `.scratch/high-load-excellence/issues/01-harness-hardening.md` and is never
 * tuned after results exist.
 *
 *     deadline = drive window + total connect stagger + settle maximum + margin
 *
 * The margin is fixed rather than proportional: nothing the child does outside
 * its drive window (spawn, handshakes, its own drain and close) scales with the
 * length of that window, and a percentage margin would stretch the detection
 * delay exactly on the long cells where a wedge costs the most.
 *
 * A breach is not a slow cell — it is an INVALID cell, and it has to be
 * recorded as one. Killing the child quiesces the server instantly, so a
 * settle barrier polled afterwards passes on a truncated cell every time. The
 * `deadlineBreached` flag this module returns is what keeps that from reading
 * as a measurement.
 */

/** Fixed margin over drive + stagger + settle. Pre-registered; never tuned. */
export const DEADLINE_MARGIN_MS = 60_000;
/** How long SIGTERM gets before SIGKILL. */
export const DEADLINE_KILL_GRACE_MS = 5_000;
/** How long SIGKILL gets before the exit code is given up as unknown. */
export const DEADLINE_REAP_GRACE_MS = 5_000;

export type DeadlineInputs = {
	/** The cell's registered drive window, in milliseconds. */
	driveMs: number;
	/** The *total* connect ramp the child spreads its sessions across, in ms. */
	connectStaggerMs: number;
	/** The settle barrier's maximum, in milliseconds. */
	settleMaxMs: number;
	/**
	 * The child's own registered post-drive work, in milliseconds: its drain
	 * window plus closing its whole fleet. Omitting a registered phase is how
	 * the first G10 control run breached on a healthy rung — 10,000 sessions
	 * take longer to close than the fixed margin. This is an enumerated phase,
	 * not a tunable: it comes from the child's printed contract
	 * ("window Ns + Ms drain") and a per-session close allowance.
	 */
	childTailMs?: number;
	/** Defaults to the pre-registered margin; only tests pass anything else. */
	marginMs?: number;
};

export function cellDeadlineMs(inputs: DeadlineInputs): number {
	const { driveMs, connectStaggerMs, settleMaxMs } = inputs;
	const margin = inputs.marginMs ?? DEADLINE_MARGIN_MS;
	for (const [name, value] of [
		["driveMs", driveMs],
		["connectStaggerMs", connectStaggerMs],
		["settleMaxMs", settleMaxMs],
		["marginMs", margin],
	] as const) {
		if (!Number.isFinite(value) || value < 0)
			throw new Error(`bench deadline: ${name} must be finite and >= 0`);
	}
	const tail = inputs.childTailMs ?? 0;
	if (!Number.isFinite(tail) || tail < 0)
		throw new Error("bench deadline: childTailMs must be finite and >= 0");
	return driveMs + connectStaggerMs + settleMaxMs + tail + margin;
}

/** The part of `Bun.Subprocess` a deadline needs, so tests can stand one in. */
export type DeadlineChild = {
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
};

export type DeadlineWaitOptions = {
	deadlineMs: number;
	/** Sampling cadence; also the granularity at which the deadline is checked. */
	sampleIntervalMs: number;
	/** Called after every wait slice, exactly as the un-deadlined loop did. */
	onSample?: () => void;
	killGraceMs?: number;
	reapGraceMs?: number;
	/** Reports each escalation, for the conductor's log. */
	onBreach?: (phase: "sigterm" | "sigkill" | "unreaped") => void;
};

export type DeadlineWaitResult = {
	/** `null` only when the child never reaped, even after SIGKILL. */
	exitCode: number | null;
	deadlineBreached: boolean;
	waitedMs: number;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `promise`'s value, or `fallback` if it has not settled within `ms`.
 *
 * Only ever used on a cell already known to have breached: a killed child's
 * pipes normally close at once, but a surviving grandchild can hold one open,
 * and a conductor that hangs reading the stdout of a process it just killed
 * would be the same wedge one step further down.
 */
export async function valueOrAfter<T>(
	promise: Promise<T>,
	ms: number,
	fallback: T,
): Promise<T> {
	const sentinel = Symbol("timeout");
	const result = await Promise.race([
		promise.catch(() => fallback),
		sleep(ms).then(() => sentinel),
	]);
	return result === sentinel ? fallback : (result as T);
}

/** Resolves true if `promise` settles within `ms`, false if the timer wins. */
async function settlesWithin(
	promise: Promise<unknown>,
	ms: number,
): Promise<boolean> {
	let won = false;
	const marked = promise.then(
		() => {
			won = true;
		},
		() => {
			won = true;
		},
	);
	await Promise.race([marked, sleep(ms)]);
	return won;
}

/**
 * Wait for `child`, sampling as it goes, and refuse to wait past the deadline.
 *
 * On an un-breached cell this is the same loop the conductors already ran: one
 * `onSample` per slice, including the slice the child exits on. Nothing about
 * a cell that finishes in time is changed by the deadline being there.
 */
export async function waitForChildWithDeadline(
	child: DeadlineChild,
	options: DeadlineWaitOptions,
): Promise<DeadlineWaitResult> {
	const {
		deadlineMs,
		sampleIntervalMs,
		onSample,
		onBreach,
		killGraceMs = DEADLINE_KILL_GRACE_MS,
		reapGraceMs = DEADLINE_REAP_GRACE_MS,
	} = options;

	const startedAt = Date.now();
	let exitCode: number | null = null;
	let done = false;
	// The conductor reads the code off `exitCode`, and this promise never
	// rejects: a child that fails to spawn must not take the run down through an
	// unhandled rejection on a promise we only await for its timing.
	const exited = child.exited.then(
		(code) => {
			exitCode = code;
			done = true;
		},
		() => {
			done = true;
		},
	);

	while (!done && Date.now() - startedAt < deadlineMs) {
		await Promise.race([exited, sleep(sampleIntervalMs)]);
		onSample?.();
	}

	if (done) {
		return {
			exitCode,
			deadlineBreached: false,
			waitedMs: Date.now() - startedAt,
		};
	}

	onBreach?.("sigterm");
	child.kill("SIGTERM");
	if (!(await settlesWithin(exited, killGraceMs))) {
		onBreach?.("sigkill");
		child.kill("SIGKILL");
		if (!(await settlesWithin(exited, reapGraceMs))) onBreach?.("unreaped");
	}

	return { exitCode, deadlineBreached: true, waitedMs: Date.now() - startedAt };
}
