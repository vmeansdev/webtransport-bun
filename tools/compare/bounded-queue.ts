export const DEFAULT_MAX_QUEUE_ITEMS = 100_000;
export const DEFAULT_MAX_QUEUE_WAITERS = 1_024;

export interface QueueWaitOptions {
	readonly signal?: AbortSignal;
}

export interface ByteBoundedQueueOptions<T> {
	readonly maxBytes: number;
	readonly maxItems?: number;
	readonly maxItemCount?: number;
	readonly maxWaiters?: number;
	readonly maxItemWaiters?: number;
	readonly maxWatermarkWaiters?: number;
	readonly highWaterMark?: number;
	readonly lowWaterMark?: number;
	readonly sizeOf?: (value: T) => number;
}

export type QueueReadResult<T> =
	| { readonly done: false; readonly value: T }
	| { readonly done: true; readonly reason?: unknown };

type QueueWaitArgument = QueueWaitOptions | AbortSignal | undefined;

type PendingReader<T> = {
	readonly resolve: (result: QueueReadResult<T>) => void;
	readonly reject: (reason: unknown) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
};

type PendingWatermarkWaiter = {
	readonly resolve: (result: "low" | "closed") => void;
	readonly reject: (reason: unknown) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
};

type ResizableArrayBuffer = ArrayBuffer & {
	readonly resizable?: boolean;
	readonly maxByteLength?: number;
};

function normalizeSignal(options: QueueWaitArgument): AbortSignal | undefined {
	if (!options) return undefined;
	if (
		typeof options === "object" &&
		"aborted" in options &&
		typeof options.aborted === "boolean"
	) {
		return options as AbortSignal;
	}
	return (options as QueueWaitOptions).signal;
}

function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("queue wait aborted");
	error.name = "AbortError";
	return error;
}

function validateCap(
	name: string,
	value: number | undefined,
	defaultValue: number,
): number {
	const cap = value ?? defaultValue;
	if (!Number.isSafeInteger(cap) || cap <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return cap;
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

function fixedBacking(buffer: ArrayBuffer): void {
	const candidate = buffer as ResizableArrayBuffer;
	if (
		candidate.resizable === true ||
		(candidate.maxByteLength !== undefined &&
			candidate.maxByteLength !== buffer.byteLength)
	) {
		throw new TypeError(
			"queue item cannot use a resizable ArrayBuffer backing",
		);
	}
}

function defaultSizeOf(value: unknown): number {
	if (typeof value === "string") {
		return new TextEncoder().encode(value).byteLength;
	}
	if (value instanceof ArrayBuffer) {
		fixedBacking(value);
		return value.byteLength;
	}
	if (ArrayBuffer.isView(value)) {
		if (!(value.buffer instanceof ArrayBuffer)) {
			throw new TypeError("queue item requires a fixed ArrayBuffer backing");
		}
		fixedBacking(value.buffer);
		return value.byteLength;
	}
	throw new TypeError(
		"queue item requires sizeOf for non-binary and non-string values",
	);
}

interface QueueEntry<T> {
	readonly value: T;
	readonly bytes: number;
}

/** FIFO queue with explicit byte, item-count, and waiter budgets. */
export class ByteBoundedQueue<T> {
	readonly maxBytes: number;
	readonly maxItems: number;
	readonly maxItemCount: number;
	readonly maxWaiters: number;
	readonly maxItemWaiters: number;
	readonly maxWatermarkWaiters: number;
	readonly highWaterMark: number;
	readonly lowWaterMark: number;
	private readonly sizeOf: (value: T) => number;
	private readonly entries: QueueEntry<T>[] = [];
	private readonly pendingReaders: PendingReader<T>[] = [];
	private readonly watermarkWaiters: PendingWatermarkWaiter[] = [];
	private queuedBytes = 0;
	private didClose = false;
	private reason: unknown;

	constructor(options: ByteBoundedQueueOptions<T>) {
		if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
			throw new RangeError("maxBytes must be a positive safe integer");
		}
		this.maxBytes = options.maxBytes;
		if (
			options.maxItems !== undefined &&
			options.maxItemCount !== undefined &&
			options.maxItems !== options.maxItemCount
		) {
			throw new RangeError("maxItems and maxItemCount must agree");
		}
		this.maxItems = validateCap(
			"maxItems",
			options.maxItems ?? options.maxItemCount,
			DEFAULT_MAX_QUEUE_ITEMS,
		);
		this.maxItemCount = this.maxItems;
		this.maxWaiters = validateCap(
			"maxWaiters",
			options.maxWaiters,
			DEFAULT_MAX_QUEUE_WAITERS,
		);
		this.maxItemWaiters = validateCap(
			"maxItemWaiters",
			options.maxItemWaiters,
			this.maxWaiters,
		);
		this.maxWatermarkWaiters = validateCap(
			"maxWatermarkWaiters",
			options.maxWatermarkWaiters,
			this.maxWaiters,
		);
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

	get pendingItemWaiters(): number {
		return this.pendingReaders.length;
	}

	get pendingWatermarkWaiters(): number {
		return this.watermarkWaiters.length;
	}

	get pendingWaiters(): number {
		return this.pendingItemWaiters + this.pendingWatermarkWaiters;
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
		if (!Number.isSafeInteger(bytes) || bytes <= 0) {
			throw new RangeError("queue item size must be a positive safe integer");
		}
		return bytes;
	}

	/** Add an item if the queue is open and all budgets have room. */
	tryPush(value: T): boolean {
		if (this.didClose) return false;
		const bytes = this.itemBytes(value);
		if (
			bytes > this.maxBytes ||
			this.queuedBytes + bytes > this.maxBytes ||
			this.entries.length >= this.maxItems
		) {
			return false;
		}
		const reader = this.pendingReaders.shift();
		if (reader) {
			reader.signal?.removeEventListener("abort", reader.onAbort as () => void);
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

	private removeReader(reader: PendingReader<T>): boolean {
		const index = this.pendingReaders.indexOf(reader);
		if (index < 0) return false;
		this.pendingReaders.splice(index, 1);
		reader.signal?.removeEventListener("abort", reader.onAbort as () => void);
		return true;
	}

	private removeWatermarkWaiter(waiter: PendingWatermarkWaiter): boolean {
		const index = this.watermarkWaiters.indexOf(waiter);
		if (index < 0) return false;
		this.watermarkWaiters.splice(index, 1);
		waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
		return true;
	}

	/** Wait for an item or deterministic close. */
	waitForItem(options?: QueueWaitArgument): Promise<QueueReadResult<T>> {
		const signal = normalizeSignal(options);
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		if (this.entries.length > 0) {
			const value = this.shift() as T;
			return Promise.resolve({ done: false, value });
		}
		if (this.didClose)
			return Promise.resolve({ done: true, reason: this.reason });
		if (
			this.pendingWaiters >= this.maxWaiters ||
			this.pendingReaders.length >= this.maxItemWaiters
		) {
			return Promise.reject(new RangeError("item waiter cap exceeded"));
		}
		return new Promise<QueueReadResult<T>>((resolve, reject) => {
			let reader!: PendingReader<T>;
			const onAbort = () => {
				if (!this.removeReader(reader)) return;
				reject(abortReason(signal as AbortSignal));
			};
			reader = { resolve, reject, signal, onAbort };
			this.pendingReaders.push(reader);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	/** Wait until queued bytes are at or below the low watermark. */
	waitForLowWaterMark(options?: QueueWaitArgument): Promise<"low" | "closed"> {
		const signal = normalizeSignal(options);
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		if (this.belowLowWaterMark) return Promise.resolve("low");
		if (this.didClose) return Promise.resolve("closed");
		if (
			this.pendingWaiters >= this.maxWaiters ||
			this.watermarkWaiters.length >= this.maxWatermarkWaiters
		) {
			return Promise.reject(new RangeError("watermark waiter cap exceeded"));
		}
		return new Promise((resolve, reject) => {
			let waiter!: PendingWatermarkWaiter;
			const onAbort = () => {
				if (!this.removeWatermarkWaiter(waiter)) return;
				reject(abortReason(signal as AbortSignal));
			};
			waiter = { resolve, reject, signal, onAbort };
			this.watermarkWaiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	waitForBelowLowWaterMark(
		options?: QueueWaitArgument,
	): Promise<"low" | "closed"> {
		return this.waitForLowWaterMark(options);
	}

	private resolveWatermarkWaiters(): void {
		if (!this.belowLowWaterMark) return;
		for (const waiter of this.watermarkWaiters.splice(0)) {
			waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
			waiter.resolve("low");
		}
	}

	/** Close once, retain queued entries for deterministic draining. */
	close(reason?: unknown): boolean {
		if (this.didClose) return false;
		this.didClose = true;
		this.reason = reason;
		for (const reader of this.pendingReaders.splice(0)) {
			reader.signal?.removeEventListener("abort", reader.onAbort as () => void);
			reader.resolve({ done: true, reason });
		}
		for (const waiter of this.watermarkWaiters.splice(0)) {
			waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
			waiter.resolve("closed");
		}
		return true;
	}
}

export const BoundedByteQueue = ByteBoundedQueue;
