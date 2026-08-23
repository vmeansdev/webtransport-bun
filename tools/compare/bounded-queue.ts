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

type IntrinsicGetter<T> = (this: unknown) => T;

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)?.get as IntrinsicGetter<number> | undefined;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"resizable",
)?.get as IntrinsicGetter<boolean> | undefined;
const arrayBufferMaxByteLengthGetter = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"maxByteLength",
)?.get as IntrinsicGetter<number> | undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get as IntrinsicGetter<ArrayBuffer> | undefined;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteOffset",
)?.get as IntrinsicGetter<number> | undefined;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get as IntrinsicGetter<number> | undefined;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"buffer",
)?.get as IntrinsicGetter<ArrayBuffer> | undefined;
const dataViewByteOffsetGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"byteOffset",
)?.get as IntrinsicGetter<number> | undefined;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"byteLength",
)?.get as IntrinsicGetter<number> | undefined;
const arrayBufferIsView = ArrayBuffer.isView;
const dataViewConstructor = DataView;

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
	AbortSignal.prototype,
	"aborted",
)?.get as IntrinsicGetter<boolean> | undefined;
const abortSignalReasonGetter = Object.getOwnPropertyDescriptor(
	AbortSignal.prototype,
	"reason",
)?.get as IntrinsicGetter<unknown> | undefined;
type EventListenerIntrinsic = (
	this: AbortSignal,
	type: string,
	listener: () => void,
	options?: unknown,
) => void;
const addEventListenerIntrinsic = Object.getOwnPropertyDescriptor(
	EventTarget.prototype,
	"addEventListener",
)?.value as EventListenerIntrinsic | undefined;
const removeEventListenerIntrinsic = Object.getOwnPropertyDescriptor(
	EventTarget.prototype,
	"removeEventListener",
)?.value as EventListenerIntrinsic | undefined;

function callIntrinsic<T>(
	getter: IntrinsicGetter<T> | undefined,
	receiver: unknown,
	label: string,
): T {
	if (!getter) throw new TypeError(`${label} intrinsic is unavailable`);
	try {
		return getter.call(receiver);
	} catch {
		throw new TypeError(`${label} is not a supported binary value`);
	}
}

function fixedBacking(buffer: unknown): number {
	const byteLength = callIntrinsic(
		arrayBufferByteLengthGetter,
		buffer,
		"ArrayBuffer backing",
	);
	const resizable = arrayBufferResizableGetter
		? callIntrinsic(arrayBufferResizableGetter, buffer, "ArrayBuffer backing")
		: false;
	const maxByteLength = arrayBufferMaxByteLengthGetter
		? callIntrinsic(
				arrayBufferMaxByteLengthGetter,
				buffer,
				"ArrayBuffer backing",
			)
		: byteLength;
	if (resizable || maxByteLength !== byteLength) {
		throw new TypeError(
			"queue item cannot use a resizable ArrayBuffer backing",
		);
	}
	return byteLength;
}

function viewBytes(value: unknown):
	| {
			readonly buffer: ArrayBuffer;
			readonly byteOffset: number;
			readonly byteLength: number;
	  }
	| undefined {
	if (!arrayBufferIsView(value)) return undefined;
	const isDataView = value instanceof dataViewConstructor;
	const buffer = callIntrinsic(
		isDataView ? dataViewBufferGetter : typedArrayBufferGetter,
		value,
		"ArrayBuffer view",
	);
	const byteOffset = callIntrinsic(
		isDataView ? dataViewByteOffsetGetter : typedArrayByteOffsetGetter,
		value,
		"ArrayBuffer view",
	);
	const byteLength = callIntrinsic(
		isDataView ? dataViewByteLengthGetter : typedArrayByteLengthGetter,
		value,
		"ArrayBuffer view",
	);
	const backingLength = fixedBacking(buffer);
	if (
		!Number.isSafeInteger(byteOffset) ||
		!Number.isSafeInteger(byteLength) ||
		byteOffset < 0 ||
		byteLength < 0 ||
		byteOffset + byteLength > backingLength
	) {
		throw new TypeError("ArrayBuffer view has an invalid byte range");
	}
	return { buffer, byteOffset, byteLength };
}

function validateBinaryBacking(value: unknown): void {
	if (value instanceof ArrayBuffer) {
		fixedBacking(value);
		return;
	}
	if (arrayBufferIsView(value)) viewBytes(value);
}

function defaultSizeOf(value: unknown): number {
	if (typeof value === "string") {
		return new TextEncoder().encode(value).byteLength;
	}
	if (value instanceof ArrayBuffer) return fixedBacking(value);
	const view = viewBytes(value);
	if (view) return view.byteLength;
	throw new TypeError(
		"queue item requires sizeOf for non-binary and non-string values",
	);
}

function isActualAbortSignal(value: unknown): value is AbortSignal {
	if (!value || typeof value !== "object") return false;
	if (!abortSignalAbortedGetter || !abortSignalReasonGetter) return false;
	if (!addEventListenerIntrinsic || !removeEventListenerIntrinsic) return false;
	try {
		const aborted = abortSignalAbortedGetter.call(value);
		abortSignalReasonGetter.call(value);
		return typeof aborted === "boolean";
	} catch {
		return false;
	}
}

function signalAborted(signal: AbortSignal): boolean {
	return callIntrinsic(abortSignalAbortedGetter, signal, "AbortSignal");
}

function signalReason(signal: AbortSignal): unknown {
	return callIntrinsic(abortSignalReasonGetter, signal, "AbortSignal");
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
	if (!addEventListenerIntrinsic) {
		throw new TypeError("AbortSignal listener support is unavailable");
	}
	addEventListenerIntrinsic.call(signal, "abort", listener, { once: true });
}

function removeAbortListener(
	signal: AbortSignal | undefined,
	listener: (() => void) | undefined,
): void {
	if (!signal || !listener || !removeEventListenerIntrinsic) return;
	try {
		removeEventListenerIntrinsic.call(signal, "abort", listener);
	} catch {
		// Listener cleanup must not reject a resolved or closed waiter.
	}
}

function normalizeSignal(options: QueueWaitArgument): AbortSignal | undefined {
	if (options === undefined) return undefined;
	if (isActualAbortSignal(options)) return options;
	if (!options || typeof options !== "object") {
		throw new TypeError(
			"queue wait argument must be an AbortSignal or { signal }",
		);
	}
	let prototype: object | null;
	try {
		prototype = Object.getPrototypeOf(options);
	} catch {
		throw new TypeError("queue wait options must be a plain object");
	}
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("queue wait options must be a plain object");
	}
	let ownKeys: (string | symbol)[];
	try {
		ownKeys = Reflect.ownKeys(options);
	} catch {
		throw new TypeError("queue wait options could not be inspected");
	}
	for (const key of ownKeys) {
		if (key !== "signal") {
			throw new TypeError("queue wait options contain an unknown property");
		}
	}
	const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
	if (!descriptor) {
		return undefined;
	}
	let signal: unknown;
	try {
		signal =
			"value" in descriptor ? descriptor.value : descriptor.get?.call(options);
	} catch {
		throw new TypeError("queue wait signal could not be read");
	}
	if (signal === undefined) return undefined;
	if (!isActualAbortSignal(signal)) {
		throw new TypeError("queue wait signal must be an AbortSignal");
	}
	return signal;
}

function abortReason(signal: AbortSignal): unknown {
	const reason = signalReason(signal);
	if (reason !== undefined) return reason;
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
		validateBinaryBacking(value);
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
			removeAbortListener(reader.signal, reader.onAbort);
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
		removeAbortListener(reader.signal, reader.onAbort);
		return true;
	}

	private removeWatermarkWaiter(waiter: PendingWatermarkWaiter): boolean {
		const index = this.watermarkWaiters.indexOf(waiter);
		if (index < 0) return false;
		this.watermarkWaiters.splice(index, 1);
		removeAbortListener(waiter.signal, waiter.onAbort);
		return true;
	}

	/** Wait for an item or deterministic close. */
	waitForItem(options?: QueueWaitArgument): Promise<QueueReadResult<T>> {
		const signal = normalizeSignal(options);
		if (signal && signalAborted(signal))
			return Promise.reject(abortReason(signal));
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
			try {
				if (signal) addAbortListener(signal, onAbort);
			} catch (error) {
				this.removeReader(reader);
				reject(error);
				return;
			}
			if (signal && signalAborted(signal)) onAbort();
		});
	}

	/** Wait until queued bytes are at or below the low watermark. */
	waitForLowWaterMark(options?: QueueWaitArgument): Promise<"low" | "closed"> {
		const signal = normalizeSignal(options);
		if (signal && signalAborted(signal))
			return Promise.reject(abortReason(signal));
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
			try {
				if (signal) addAbortListener(signal, onAbort);
			} catch (error) {
				this.removeWatermarkWaiter(waiter);
				reject(error);
				return;
			}
			if (signal && signalAborted(signal)) onAbort();
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
			removeAbortListener(waiter.signal, waiter.onAbort);
			waiter.resolve("low");
		}
	}

	/** Close once, retain queued entries for deterministic draining. */
	close(reason?: unknown): boolean {
		if (this.didClose) return false;
		this.didClose = true;
		this.reason = reason;
		for (const reader of this.pendingReaders.splice(0)) {
			removeAbortListener(reader.signal, reader.onAbort);
			reader.resolve({ done: true, reason });
		}
		for (const waiter of this.watermarkWaiters.splice(0)) {
			removeAbortListener(waiter.signal, waiter.onAbort);
			waiter.resolve("closed");
		}
		return true;
	}
}

export const BoundedByteQueue = ByteBoundedQueue;
