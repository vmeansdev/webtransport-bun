/**
 * The bounded record queue both off-loop read-path arms drain through.
 *
 * `ws-worker` and `wt-stream-sink` are the same shape of claim: the bytes are
 * taken off the wire by a reader that is not the loop the scenario's send /
 * measure loop runs on, and the two are joined by a queue with a stated bound.
 * What separates them is what happens when that queue fills, and that is not a
 * choice this module makes -- `ARM_SHEDDING_POLICY` in `evidence.ts` already
 * declares it per arm, so the overflow behaviour here is derived from the arm
 * rather than authored beside it. `ws-worker` drops and counts; the sink parks
 * its reader so the wire throttles the sender.
 *
 * Everything this module reports is something it counted. There is no
 * estimated depth, no modelled busy time, and no default window: `busyMs` is
 * accumulated around the reader's own awaited work and `windowMs` is the
 * wall-clock span from the worker's construction, both read off the clock the
 * caller supplied. A worker that was never used reports zeros, which is the
 * honest answer and is refused downstream by `measuredLegToArm` rather than
 * being papered over here.
 *
 * Single consumer by contract. The queue has one waiter slot because the leg
 * that drains it is one loop; a second concurrent `waitForRecord` would leave
 * the first waiter unresolved until the next offer, so the contract is stated
 * rather than defended with a waiter list nothing needs.
 */
import { ARM_READ_PATH, ARM_SHEDDING_POLICY } from "../evidence.ts";

/** The declared arms this queue can be opened for. Mirrors `ArmTransport`. */
export type SinkWorkerArm = "ws" | "wt" | "ws-worker" | "wt-stream-sink";

/** How a full queue behaves. Derived from the arm's shedding policy. */
export type SinkWorkerOverflowPolicy = "drop-and-count" | "park";

export const SINK_WORKER_DEFAULT_MAX_ITEMS = 1024;
export const SINK_WORKER_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** How long a parked producer waits between capacity checks. */
export const SINK_WORKER_DEFAULT_PARK_POLL_MS = 1;

export interface SinkWorkerOptions {
	readonly armTransport: SinkWorkerArm;
	/** Reads the same clock the leg reads, so busy and window are comparable. */
	readonly nowMs: () => number;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly maxQueuedItems?: number;
	readonly maxQueuedBytes?: number;
	readonly parkPollMs?: number;
}

export interface SinkWorkerStats {
	readonly armTransport: SinkWorkerArm;
	readonly overflowPolicy: SinkWorkerOverflowPolicy;
	readonly offered: number;
	readonly accepted: number;
	readonly dropped: number;
	readonly taken: number;
	readonly queuedItems: number;
	readonly queuedBytes: number;
	readonly queuedBytesPeak: number;
	/** Milliseconds the reader spent inside awaited read work. */
	readonly busyMs: number;
	/** Wall-clock span since the worker was created. */
	readonly windowMs: number;
	readonly closed: boolean;
}

export interface SinkWorker<T> {
	readonly armTransport: SinkWorkerArm;
	readonly readPathThreadModel: (typeof ARM_READ_PATH)[SinkWorkerArm];
	readonly sheddingPolicy: (typeof ARM_SHEDDING_POLICY)[SinkWorkerArm];
	readonly overflowPolicy: SinkWorkerOverflowPolicy;
	/** True while the queue can take another record of `bytes`. */
	hasCapacity(bytes: number): boolean;
	/**
	 * Hand one record to the consumer. Returns false when the record was shed
	 * (`drop-and-count` only); a parking worker refuses to shed and the caller
	 * is expected to have awaited `awaitCapacity` first.
	 */
	offer(value: T, bytes: number): boolean;
	/** Bounded wait for room. Resolves false when the deadline passed first. */
	awaitCapacity(bytes: number, deadlineMs: number): Promise<boolean>;
	take(): T | undefined;
	/** Bounded wait for one record. Resolves undefined at the deadline. */
	waitForRecord(deadlineMs: number): Promise<T | undefined>;
	/** Accumulates reader busy time around one awaited read. */
	measureRead<R>(read: () => Promise<R>): Promise<R>;
	/** Records why the reader stopped, so the consumer reports the same cause. */
	failReader(error: unknown): void;
	/** Takes the recorded reader failure, clearing it. */
	takeReaderFailure(): unknown;
	close(): void;
	stats(): SinkWorkerStats;
}

function overflowPolicyFor(arm: SinkWorkerArm): SinkWorkerOverflowPolicy {
	// Derived, never authored: the sink throttles the wire rather than
	// dropping, and that is already stated once in `ARM_SHEDDING_POLICY`.
	return ARM_SHEDDING_POLICY[arm] === "wire-throttle"
		? "park"
		: "drop-and-count";
}

function positiveBound(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(
			`createSinkWorker: bound must be a finite positive number; got ${value}`,
		);
	}
	return value;
}

export function createSinkWorker<T>(options: SinkWorkerOptions): SinkWorker<T> {
	if (!(options.armTransport in ARM_SHEDDING_POLICY)) {
		throw new RangeError(
			`createSinkWorker: unknown arm transport ${String(options.armTransport)}`,
		);
	}
	const nowMs = options.nowMs;
	const sleep = options.sleep;
	const maxQueuedItems = positiveBound(
		options.maxQueuedItems,
		SINK_WORKER_DEFAULT_MAX_ITEMS,
	);
	const maxQueuedBytes = positiveBound(
		options.maxQueuedBytes,
		SINK_WORKER_DEFAULT_MAX_BYTES,
	);
	const parkPollMs = positiveBound(
		options.parkPollMs,
		SINK_WORKER_DEFAULT_PARK_POLL_MS,
	);
	const overflowPolicy = overflowPolicyFor(options.armTransport);
	const openedAtMs = nowMs();

	const queue: Array<{ readonly value: T; readonly bytes: number }> = [];
	let queuedBytes = 0;
	let queuedBytesPeak = 0;
	let offered = 0;
	let accepted = 0;
	let dropped = 0;
	let taken = 0;
	let busyMs = 0;
	let closed = false;
	let readerFailure: unknown;
	let waiter: (() => void) | undefined;

	const wake = (): void => {
		const pending = waiter;
		waiter = undefined;
		pending?.();
	};

	const hasCapacity = (bytes: number): boolean =>
		queue.length < maxQueuedItems && queuedBytes + bytes <= maxQueuedBytes;

	return {
		armTransport: options.armTransport,
		readPathThreadModel: ARM_READ_PATH[options.armTransport],
		sheddingPolicy: ARM_SHEDDING_POLICY[options.armTransport],
		overflowPolicy,

		hasCapacity,

		offer(value: T, bytes: number): boolean {
			offered += 1;
			if (closed || !hasCapacity(bytes)) {
				dropped += 1;
				return false;
			}
			queue.push({ value, bytes });
			queuedBytes += bytes;
			if (queuedBytes > queuedBytesPeak) queuedBytesPeak = queuedBytes;
			accepted += 1;
			wake();
			return true;
		},

		async awaitCapacity(bytes: number, deadlineMs: number): Promise<boolean> {
			// The park is what makes `wire-throttle` real: the reader stops
			// reading, QUIC's flow control stops the sender, and nothing is
			// silently dropped to keep a queue depth looking healthy.
			while (!closed && !hasCapacity(bytes)) {
				const remaining = deadlineMs - nowMs();
				if (remaining <= 0) return false;
				await sleep(Math.min(parkPollMs, remaining));
			}
			return !closed;
		},

		take(): T | undefined {
			const next = queue.shift();
			if (next === undefined) return undefined;
			queuedBytes -= next.bytes;
			taken += 1;
			return next.value;
		},

		async waitForRecord(deadlineMs: number): Promise<T | undefined> {
			for (;;) {
				const next = queue.shift();
				if (next !== undefined) {
					queuedBytes -= next.bytes;
					taken += 1;
					return next.value;
				}
				if (closed) return undefined;
				// A stopped reader is reported, not waited out: the consumer
				// should see the cause the reader saw rather than the deadline
				// that expired behind it.
				if (readerFailure !== undefined) return undefined;
				const remaining = deadlineMs - nowMs();
				if (remaining <= 0) return undefined;
				await Promise.race([
					new Promise<void>((resolve) => {
						waiter = resolve;
					}),
					sleep(remaining),
				]);
			}
		},

		async measureRead<R>(read: () => Promise<R>): Promise<R> {
			const startedAtMs = nowMs();
			try {
				return await read();
			} finally {
				busyMs += Math.max(0, nowMs() - startedAtMs);
			}
		},

		failReader(error: unknown): void {
			readerFailure = error;
			wake();
		},

		takeReaderFailure(): unknown {
			const failure = readerFailure;
			readerFailure = undefined;
			return failure;
		},

		close(): void {
			closed = true;
			wake();
		},

		stats(): SinkWorkerStats {
			return {
				armTransport: options.armTransport,
				overflowPolicy,
				offered,
				accepted,
				dropped,
				taken,
				queuedItems: queue.length,
				queuedBytes,
				queuedBytesPeak,
				busyMs,
				windowMs: Math.max(0, nowMs() - openedAtMs),
				closed,
			};
		},
	};
}

/**
 * One record the reader pulled off the wire, or `null` for end of stream.
 *
 * `bytes` is what the reader observed, not what the queue assumed: a caller
 * that cannot size a record has measured nothing and should say so with zero
 * rather than substituting a nominal message size.
 */
export interface SinkPumpRecord<T> {
	readonly value: T;
	readonly bytes: number;
}

export interface SinkPumpOptions<T> {
	readonly worker: SinkWorker<T>;
	/** One awaited read off the wire. Resolves null at end of stream. */
	readonly read: (deadlineMs: number) => Promise<SinkPumpRecord<T> | null>;
	readonly nowMs: () => number;
	readonly sleep: (milliseconds: number) => Promise<void>;
	/** Per-read bound. The consumer's own deadline governs the leg. */
	readonly readTimeoutMs: number;
	/** Bound on a parking producer's wait for queue capacity. */
	readonly capacityTimeoutMs?: number;
}

/**
 * Run one reader off the caller's loop.
 *
 * The detaching `sleep(0)` is the whole point and is deliberately the first
 * statement: without it the first read runs synchronously on the turn that
 * started the pump, which is exactly the main-loop read the off-loop arm
 * exists not to be. Everything after it is a separate scheduling unit from
 * the leg's send / measure loop, joined only by the bounded queue.
 *
 * The pump stops on end of stream, on close, and on a read failure, and it
 * records the failure on the worker so the consumer reports the cause the
 * reader saw rather than a generic timeout.
 */
export async function runSinkPump<T>(
	options: SinkPumpOptions<T>,
): Promise<void> {
	const { worker, read, nowMs, sleep, readTimeoutMs } = options;
	const capacityTimeoutMs = options.capacityTimeoutMs ?? readTimeoutMs;
	await sleep(0);
	for (;;) {
		if (worker.stats().closed) return;
		if (worker.overflowPolicy === "park") {
			const admitted = await worker.awaitCapacity(
				0,
				nowMs() + capacityTimeoutMs,
			);
			if (!admitted) return;
		}
		let record: SinkPumpRecord<T> | null;
		try {
			record = await worker.measureRead(() => read(nowMs() + readTimeoutMs));
		} catch (error: unknown) {
			worker.failReader(error);
			return;
		}
		if (record === null) return;
		worker.offer(record.value, record.bytes);
	}
}
