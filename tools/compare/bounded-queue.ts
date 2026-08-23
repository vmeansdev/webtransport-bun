export interface ByteBoundedQueueOptions<T> {
	readonly maxBytes: number;
	readonly highWaterMark?: number;
	readonly lowWaterMark?: number;
	readonly sizeOf?: (value: T) => number;
}

export type QueueReadResult<T> =
	| { readonly done: false; readonly value: T }
	| { readonly done: true; readonly reason?: unknown };

type PendingReader<T> = {
	readonly resolve: (result: QueueReadResult<T>) => void;
};

type PendingWatermarkWaiter = {
	readonly resolve: (result: "low" | "closed") => void;
};

function defaultSizeOf(value: unknown): number {
	if (typeof value === "string")
		return new TextEncoder().encode(value).byteLength;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (
		value !== null &&
		typeof value === "object" &&
		"byteLength" in value &&
		typeof value.byteLength === "number"
	) {
		return value.byteLength;
	}
	throw new TypeError("queue item requires sizeOf unless it has byteLength");
}

function validateWatermark(
	name: string,
	value: number,
	maxBytes: number,
): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) {
		throw new RangeError(`${name} must be an integer between 0 and maxBytes`);
	}
	return value;
}

interface QueueEntry<T> {
	readonly value: T;
	readonly bytes: number;
}

/** FIFO queue with an explicit byte budget and hysteresis watermarks. */
export class ByteBoundedQueue<T> {
	readonly maxBytes: number;
	readonly highWaterMark: number;
	readonly lowWaterMark: number;
	private readonly sizeOf: (value: T) => number;
	private readonly entries: QueueEntry<T>[] = [];
	private readonly pendingReaders: PendingReader<T>[] = [];
	private readonly pendingWatermarkWaiters: PendingWatermarkWaiter[] = [];
	private queuedBytes = 0;
	private didClose = false;
	private reason: unknown;

	constructor(options: ByteBoundedQueueOptions<T>) {
		if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
			throw new RangeError("maxBytes must be a positive safe integer");
		}
		this.maxBytes = options.maxBytes;
		this.highWaterMark = validateWatermark(
			"highWaterMark",
			options.highWaterMark ?? options.maxBytes,
			options.maxBytes,
		);
		this.lowWaterMark = validateWatermark(
			"lowWaterMark",
			options.lowWaterMark ?? Math.floor(this.highWaterMark / 2),
			options.maxBytes,
		);
		if (this.lowWaterMark > this.highWaterMark) {
			throw new RangeError("lowWaterMark must not exceed highWaterMark");
		}
		this.sizeOf = options.sizeOf ?? ((value: T) => defaultSizeOf(value));
	}

	get bytes(): number {
		return this.queuedBytes;
	}

	get queuedBytesCount(): number {
		return this.queuedBytes;
	}

	get length(): number {
		return this.entries.length;
	}

	get closed(): boolean {
		return this.didClose;
	}

	get closeReason(): unknown {
		return this.reason;
	}

	get aboveHighWaterMark(): boolean {
		return this.queuedBytes >= this.highWaterMark;
	}

	get belowLowWaterMark(): boolean {
		return this.queuedBytes <= this.lowWaterMark;
	}

	get writable(): boolean {
		return !this.didClose;
	}

	private itemBytes(value: T): number {
		const bytes = this.sizeOf(value);
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new RangeError(
				"queue item size must be a non-negative safe integer",
			);
		}
		if (bytes > this.maxBytes) return bytes;
		return bytes;
	}

	/** Add an item if the queue is open and the byte budget has room. */
	tryPush(value: T): boolean {
		if (this.didClose) return false;
		const bytes = this.itemBytes(value);
		if (bytes > this.maxBytes || this.queuedBytes + bytes > this.maxBytes) {
			return false;
		}
		const reader = this.pendingReaders.shift();
		if (reader) {
			reader.resolve({ done: false, value });
			return true;
		}
		this.entries.push({ value, bytes });
		this.queuedBytes += bytes;
		return true;
	}

	push(value: T): boolean {
		return this.tryPush(value);
	}

	enqueue(value: T): boolean {
		return this.tryPush(value);
	}

	/** Remove the oldest item, if present. */
	shift(): T | undefined {
		const entry = this.entries.shift();
		if (!entry) return undefined;
		this.queuedBytes -= entry.bytes;
		this.resolveWatermarkWaiters();
		return entry.value;
	}

	/** Remove all queued items and return them in FIFO order. */
	drain(): T[] {
		const values = this.entries.map(({ value }) => value);
		this.entries.length = 0;
		this.queuedBytes = 0;
		this.resolveWatermarkWaiters();
		return values;
	}

	/**
	 * Wait for an item or deterministic close.  A closed queue drains existing
	 * entries first; a close with no entries resolves every pending reader.
	 */
	waitForItem(): Promise<QueueReadResult<T>> {
		if (this.entries.length > 0) {
			const value = this.shift() as T;
			return Promise.resolve({ done: false, value });
		}
		if (this.didClose)
			return Promise.resolve({ done: true, reason: this.reason });
		return new Promise<QueueReadResult<T>>((resolve) => {
			this.pendingReaders.push({ resolve });
		});
	}

	/** Wait until queued bytes are at or below the low watermark. */
	waitForLowWaterMark(): Promise<"low" | "closed"> {
		if (this.belowLowWaterMark) return Promise.resolve("low");
		if (this.didClose) return Promise.resolve("closed");
		return new Promise((resolve) => {
			this.pendingWatermarkWaiters.push({ resolve });
		});
	}

	waitForBelowLowWaterMark(): Promise<"low" | "closed"> {
		return this.waitForLowWaterMark();
	}

	private resolveWatermarkWaiters(): void {
		if (!this.belowLowWaterMark) return;
		for (const waiter of this.pendingWatermarkWaiters.splice(0))
			waiter.resolve("low");
	}

	/** Close once, retain queued entries for deterministic draining. */
	close(reason?: unknown): boolean {
		if (this.didClose) return false;
		this.didClose = true;
		this.reason = reason;
		for (const reader of this.pendingReaders.splice(0)) {
			reader.resolve({ done: true, reason });
		}
		for (const waiter of this.pendingWatermarkWaiters.splice(0)) {
			waiter.resolve("closed");
		}
		return true;
	}
}

export const BoundedByteQueue = ByteBoundedQueue;
