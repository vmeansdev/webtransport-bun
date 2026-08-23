export interface PacerClock {
	readonly now: () => number;
	readonly sleep?: (
		milliseconds: number,
		signal?: AbortSignal,
	) => Promise<void>;
}

export interface OpenLoopPacerOptions {
	readonly ratePerSecond: number;
	readonly now?: () => number;
	readonly sleep?: (
		milliseconds: number,
		signal?: AbortSignal,
	) => Promise<void>;
	/** `none` emits every slot; `skip` explicitly drops slots missed while late. */
	readonly catchUp?: "none" | "skip";
}

export const DEFAULT_OPEN_LOOP_CATCH_UP = "skip" as const;

const capturedPerformanceNow =
	typeof globalThis.performance?.now === "function"
		? globalThis.performance.now.bind(globalThis.performance)
		: undefined;
const capturedDateNow = Date.now.bind(Date);
let defaultClockLastMs = Number.NEGATIVE_INFINITY;

function defaultMonotonicNow(): number {
	const raw = capturedPerformanceNow?.() ?? capturedDateNow();
	if (!Number.isFinite(raw)) {
		throw new RangeError("default clock must be finite");
	}
	const monotonic = Math.max(raw, defaultClockLastMs);
	defaultClockLastMs = monotonic;
	return monotonic;
}

type PacerOptionsSnapshot = {
	readonly ratePerSecond: unknown;
	readonly now: unknown;
	readonly sleep: unknown;
	readonly catchUp: unknown;
};

type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;
const objectHasOwn = Object.hasOwn;

/**
 * JavaScript can represent larger finite numbers, but not as exact millisecond
 * coordinates.  Keep epochs, slot timestamps, and durations in the safe
 * integer range so a schedule cannot silently collapse or overflow.
 */
const MAX_SAFE_TIME_MS = Number.MAX_SAFE_INTEGER;
const MAX_NATIVE_TIMER_MS = 2_147_483_647;

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
	if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE_TIME_MS)
		throw new RangeError("clock.now() must be finite and safely representable");
	return value;
}

function finiteSafeDuration(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0 || value > MAX_SAFE_TIME_MS) {
		throw new RangeError(`${label} must be finite and safely representable`);
	}
	return value;
}

function validateEpoch(epochMs: number, intervalMs: number): number {
	const nextEpochMs = epochMs + intervalMs;
	if (
		!Number.isFinite(nextEpochMs) ||
		Math.abs(nextEpochMs) > MAX_SAFE_TIME_MS ||
		nextEpochMs <= epochMs
	) {
		throw new RangeError(
			"epoch and interval must produce strictly increasing, safely representable slots",
		);
	}
	return epochMs;
}

function snapshotPacerOptions(
	options: OpenLoopPacerOptions,
): PacerOptionsSnapshot {
	if (!options || typeof options !== "object") {
		throw new TypeError("pacer options must be an object");
	}
	let descriptors: DescriptorMap;
	try {
		descriptors = Object.assign(
			Object.create(null) as DescriptorMap,
			Object.getOwnPropertyDescriptors(options),
		);
	} catch {
		throw new TypeError("pacer options properties could not be inspected");
	}
	const allowed = new Set(["ratePerSecond", "now", "sleep", "catchUp"]);
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string" || !allowed.has(key)) {
			throw new TypeError("pacer options contain an unknown own property");
		}
	}
	const read = (name: string): unknown => {
		if (!objectHasOwn(descriptors, name)) return undefined;
		const descriptor = descriptors[name];
		if (!descriptor) return undefined;
		try {
			if (objectHasOwn(descriptor, "value")) return descriptor.value;
			if (!objectHasOwn(descriptor, "get")) return undefined;
			const getter = descriptor.get;
			return typeof getter === "function" ? getter.call(options) : undefined;
		} catch {
			throw new TypeError(`pacer option ${name} could not be read`);
		}
	};
	if (!objectHasOwn(descriptors, "ratePerSecond")) {
		throw new TypeError("pacer options must own ratePerSecond");
	}
	return {
		ratePerSecond: read("ratePerSecond"),
		now: read("now"),
		sleep: read("sleep"),
		catchUp: read("catchUp"),
	};
}

/**
 * An open-loop scheduler. Slot timestamps are always derived from one epoch
 * and a sequence number, so time spent handling an event cannot accumulate as
 * drift. The default `skip` policy drops overdue slots instead of repaying
 * schedule debt as a burst; `none` is available only when every logical slot
 * must be represented explicitly.
 */
export class OpenLoopPacer {
	readonly ratePerSecond: number;
	readonly intervalMs: number;
	readonly catchUp: "none" | "skip";
	private readonly clock: PacerClock;
	private epochMs: number | undefined;
	private nextSequence = 0;
	private lastObservedMs: number | undefined;

	constructor(options: OpenLoopPacerOptions) {
		const snapshot = snapshotPacerOptions(options);
		if (
			typeof snapshot.ratePerSecond !== "number" ||
			!Number.isFinite(snapshot.ratePerSecond) ||
			snapshot.ratePerSecond <= 0
		) {
			throw new RangeError("ratePerSecond must be a positive finite number");
		}
		this.ratePerSecond = snapshot.ratePerSecond;
		this.intervalMs = 1_000 / snapshot.ratePerSecond;
		if (
			!Number.isFinite(this.intervalMs) ||
			this.intervalMs < Number.EPSILON ||
			this.intervalMs > MAX_SAFE_TIME_MS
		) {
			throw new RangeError(
				"ratePerSecond produces an interval that is not safely representable",
			);
		}
		const catchUp =
			snapshot.catchUp === undefined
				? DEFAULT_OPEN_LOOP_CATCH_UP
				: snapshot.catchUp;
		if (catchUp !== "none" && catchUp !== "skip") {
			throw new RangeError("catchUp must be exactly `none` or `skip`");
		}
		// Skipping overdue slots is the safe default: a delayed event loop must
		// never repay a schedule debt as a burst.  Tests and diagnostics can opt
		// into `none` when they need every logical slot represented.
		this.catchUp = catchUp;
		if (snapshot.now !== undefined && typeof snapshot.now !== "function") {
			throw new TypeError("now must be a function");
		}
		if (snapshot.sleep !== undefined && typeof snapshot.sleep !== "function") {
			throw new TypeError("sleep must be a function");
		}
		this.clock = {
			now: (snapshot.now as (() => number) | undefined) ?? defaultMonotonicNow,
			sleep: snapshot.sleep as
				| ((milliseconds: number, signal?: AbortSignal) => Promise<void>)
				| undefined,
		};
	}

	private observeNow(value: number): number {
		const observed = finiteNow(value);
		if (this.lastObservedMs !== undefined && observed < this.lastObservedMs) {
			throw new RangeError("clock moved backward during pacing");
		}
		this.lastObservedMs = observed;
		return observed;
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

	start(atMs?: number): number {
		const observed = this.observeNow(atMs ?? this.clock.now());
		if (this.epochMs === undefined) {
			this.epochMs = validateEpoch(observed, this.intervalMs);
		}
		return this.epochMs;
	}

	reset(atMs?: number): void {
		const observed = this.observeNow(atMs ?? this.clock.now());
		this.epochMs = validateEpoch(observed, this.intervalMs);
		this.nextSequence = 0;
	}

	resetWarmup(atMs = this.clock.now()): void {
		this.reset(atMs);
	}

	dueAt(sequence: number): number {
		if (
			!Number.isSafeInteger(sequence) ||
			sequence < 0 ||
			sequence >= Number.MAX_SAFE_INTEGER
		) {
			throw new RangeError("sequence must be a non-negative safe integer");
		}
		const epochMs = this.start();
		const nextSequence = sequence + 1;
		const offsetMs = sequence * this.intervalMs;
		const nextOffsetMs = nextSequence * this.intervalMs;
		if (
			!Number.isFinite(offsetMs) ||
			Math.abs(offsetMs) > MAX_SAFE_TIME_MS ||
			!Number.isFinite(nextOffsetMs) ||
			Math.abs(nextOffsetMs) > MAX_SAFE_TIME_MS
		) {
			throw new RangeError("slot offset is not safely representable");
		}
		const dueMs = epochMs + offsetMs;
		const nextDueMs = epochMs + nextOffsetMs;
		if (
			!Number.isFinite(dueMs) ||
			Math.abs(dueMs) > MAX_SAFE_TIME_MS ||
			!Number.isFinite(nextDueMs) ||
			Math.abs(nextDueMs) > MAX_SAFE_TIME_MS
		) {
			throw new RangeError("slot timestamp is not safely representable");
		}
		if (nextDueMs <= dueMs) {
			throw new RangeError(
				"adjacent slot timestamps must be strictly increasing",
			);
		}
		return dueMs;
	}

	nextSlot(atMs = this.clock.now()): PacingSlot {
		const emittedAtMs = this.observeNow(atMs);
		const epochMs = this.start(emittedAtMs);
		let sequence = this.nextSequence;
		let skippedSlots = 0;
		if (this.catchUp === "skip" && emittedAtMs >= epochMs) {
			const firstCurrentSlot = Math.floor(
				(emittedAtMs - epochMs) / this.intervalMs,
			);
			if (!Number.isSafeInteger(firstCurrentSlot) || firstCurrentSlot < 0) {
				throw new RangeError(
					"derived slot sequence is not safely representable",
				);
			}
			if (firstCurrentSlot > sequence) {
				skippedSlots = firstCurrentSlot - sequence;
				sequence = firstCurrentSlot;
				this.nextSequence = sequence;
			}
		}
		const scheduledAtMs = this.dueAt(sequence);
		if (sequence >= Number.MAX_SAFE_INTEGER) {
			throw new RangeError("next slot sequence is not safely representable");
		}
		this.nextSequence = sequence + 1;
		const deltaMs = scheduledAtMs - emittedAtMs;
		finiteSafeDuration(Math.abs(deltaMs), "slot delta");
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
		if (Number.isFinite(deadlineMs)) finiteNow(deadlineMs);
		const now = this.observeNow(this.clock.now());
		const due = this.dueAt(this.nextSequence);
		if (due > now) {
			const remaining = deadlineMs - now;
			if (remaining <= 0) throw new PacerDeadlineError();
			if (Number.isFinite(remaining)) {
				finiteSafeDuration(remaining, "deadline remainder");
				if (remaining > MAX_NATIVE_TIMER_MS) {
					throw new RangeError(
						"deadline remainder exceeds the native timer maximum",
					);
				}
			}
			const delay = due - now;
			finiteSafeDuration(delay, "slot delay");
			if (delay > MAX_NATIVE_TIMER_MS) {
				throw new RangeError("slot delay exceeds the native timer maximum");
			}
			if (!this.clock.sleep) {
				throw new PacerDeadlineError(
					"pacer requires a sleep function before the deadline",
				);
			}
			const sleepDelay = Math.min(delay, remaining);
			if (Number.isFinite(remaining)) {
				const sleepController = new AbortController();
				let timer: ReturnType<typeof setTimeout> | undefined;
				let didTimeout = false;
				let rejectDeadline!: (error: unknown) => void;
				const deadline = new Promise<never>((_, reject) => {
					rejectDeadline = reject;
					timer = setTimeout(
						() => {
							didTimeout = true;
							const error = new PacerDeadlineError();
							sleepController.abort(error);
							rejectDeadline(error);
						},
						Math.max(0, remaining),
					);
				});
				try {
					const sleeping = this.clock.sleep(sleepDelay, sleepController.signal);
					await Promise.race([sleeping, deadline]);
					if (didTimeout) throw new PacerDeadlineError();
				} finally {
					if (timer !== undefined) clearTimeout(timer);
					if (!didTimeout) sleepController.abort();
				}
			} else {
				await this.clock.sleep(sleepDelay);
			}
			const afterSleep = this.observeNow(this.clock.now());
			if (afterSleep < due) {
				throw new PacerDeadlineError(
					"pacer sleep returned before the scheduled slot",
				);
			}
		}
		const emittedAtMs = this.observeNow(this.clock.now());
		if (emittedAtMs > deadlineMs) throw new PacerDeadlineError();
		return this.nextSlot(emittedAtMs);
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
		const durationMs = finiteSafeDuration(milliseconds, "advance duration");
		const nextMs = this.currentMs + durationMs;
		if (!Number.isFinite(nextMs) || Math.abs(nextMs) > MAX_SAFE_TIME_MS) {
			throw new RangeError("clock advance would overflow safe time");
		}
		if (durationMs > 0 && nextMs <= this.currentMs) {
			throw new RangeError(
				"clock advance is not safely representable at the current epoch",
			);
		}
		this.currentMs = nextMs;
	}

	sleep = async (milliseconds: number): Promise<void> => {
		this.advance(milliseconds);
	};
}

export const FakeClock = ManualClock;
