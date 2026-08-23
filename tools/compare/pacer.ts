export interface PacerClock {
	readonly now: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface OpenLoopPacerOptions {
	readonly ratePerSecond: number;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	/** `none` emits every slot; `skip` explicitly drops slots missed while late. */
	readonly catchUp?: "none" | "skip";
}

export interface PacingSlot {
	readonly sequence: number;
	readonly scheduledAtMs: number;
	readonly emittedAtMs: number;
	readonly delayMs: number;
	readonly latenessMs: number;
	readonly skippedSlots: number;
}

export class PacerDeadlineError extends Error {
	constructor(message = "open-loop pacer deadline expired") {
		super(message);
		this.name = "PacerDeadlineError";
	}
}

function finiteNow(value: number): number {
	if (!Number.isFinite(value))
		throw new RangeError("clock.now() must be finite");
	return value;
}

/**
 * An open-loop scheduler.  Slot timestamps are always derived from one epoch
 * and a sequence number, so time spent handling an event cannot accumulate as
 * drift.  The default `none` policy never silently catches up or skips slots.
 */
export class OpenLoopPacer {
	readonly ratePerSecond: number;
	readonly intervalMs: number;
	readonly catchUp: "none" | "skip";
	private readonly clock: PacerClock;
	private epochMs: number | undefined;
	private nextSequence = 0;

	constructor(options: OpenLoopPacerOptions) {
		if (!Number.isFinite(options.ratePerSecond) || options.ratePerSecond <= 0) {
			throw new RangeError("ratePerSecond must be a positive finite number");
		}
		this.ratePerSecond = options.ratePerSecond;
		this.intervalMs = 1_000 / options.ratePerSecond;
		// Skipping overdue slots is the safe default: a delayed event loop must
		// never repay a schedule debt as a burst.  Tests and diagnostics can opt
		// into `none` when they need every logical slot represented.
		this.catchUp = options.catchUp ?? "skip";
		this.clock = {
			now: options.now ?? (() => Date.now()),
			sleep: options.sleep,
		};
	}

	get started(): boolean {
		return this.epochMs !== undefined;
	}

	get epoch(): number | undefined {
		return this.epochMs;
	}

	get sequence(): number {
		return this.nextSequence;
	}

	start(atMs = this.clock.now()): number {
		if (this.epochMs === undefined) this.epochMs = finiteNow(atMs);
		return this.epochMs;
	}

	reset(atMs = this.clock.now()): void {
		this.epochMs = finiteNow(atMs);
		this.nextSequence = 0;
	}

	resetWarmup(atMs = this.clock.now()): void {
		this.reset(atMs);
	}

	dueAt(sequence: number): number {
		if (!Number.isSafeInteger(sequence) || sequence < 0) {
			throw new RangeError("sequence must be a non-negative safe integer");
		}
		return this.start() + sequence * this.intervalMs;
	}

	nextSlot(atMs = this.clock.now()): PacingSlot {
		const emittedAtMs = finiteNow(atMs);
		const epochMs = this.start(emittedAtMs);
		let sequence = this.nextSequence;
		let skippedSlots = 0;
		if (this.catchUp === "skip" && emittedAtMs >= epochMs) {
			const firstCurrentSlot = Math.floor(
				(emittedAtMs - epochMs) / this.intervalMs,
			);
			if (firstCurrentSlot > sequence) {
				skippedSlots = firstCurrentSlot - sequence;
				sequence = firstCurrentSlot;
				this.nextSequence = sequence;
			}
		}
		const scheduledAtMs = epochMs + sequence * this.intervalMs;
		this.nextSequence = sequence + 1;
		return {
			sequence,
			scheduledAtMs,
			emittedAtMs,
			delayMs: Math.max(0, scheduledAtMs - emittedAtMs),
			latenessMs: Math.max(0, emittedAtMs - scheduledAtMs),
			skippedSlots,
		};
	}

	/** Wait for the next due slot with an absolute deadline. */
	async waitNext(deadlineMs = Number.POSITIVE_INFINITY): Promise<PacingSlot> {
		if (
			!Number.isFinite(deadlineMs) &&
			deadlineMs !== Number.POSITIVE_INFINITY
		) {
			throw new RangeError("deadlineMs must be finite or positive infinity");
		}
		const now = finiteNow(this.clock.now());
		const due = this.dueAt(this.nextSequence);
		if (due > now) {
			const remaining = deadlineMs - now;
			if (remaining <= 0) throw new PacerDeadlineError();
			const delay = due - now;
			if (!this.clock.sleep) {
				throw new PacerDeadlineError(
					"pacer requires a sleep function before the deadline",
				);
			}
			await this.clock.sleep(Math.min(delay, remaining));
			const afterSleep = finiteNow(this.clock.now());
			if (afterSleep < due) {
				throw new PacerDeadlineError(
					"pacer sleep returned before the scheduled slot",
				);
			}
		}
		if (this.clock.now() > deadlineMs) throw new PacerDeadlineError();
		return this.nextSlot(this.clock.now());
	}
}

/** Small deterministic clock useful for unit tests and pure drivers. */
export class ManualClock implements PacerClock {
	private currentMs: number;

	constructor(startMs = 0) {
		this.currentMs = finiteNow(startMs);
	}

	now = (): number => this.currentMs;

	advance(milliseconds: number): void {
		if (!Number.isFinite(milliseconds) || milliseconds < 0) {
			throw new RangeError(
				"advance duration must be a non-negative finite number",
			);
		}
		this.currentMs += milliseconds;
	}

	sleep = async (milliseconds: number): Promise<void> => {
		this.advance(milliseconds);
	};
}

export const FakeClock = ManualClock;
