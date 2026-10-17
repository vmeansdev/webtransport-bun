/**
 * Cross-stream batched receive delivery, the JavaScript half (the native half
 * and the reasoning are in crates/native/src/read_group.rs).
 *
 * With `WEBTRANSPORT_STREAM_READ_GROUP=1`, every native-backed incoming
 * readable this process builds is fed by one process-level read group: each
 * stream's handle runs a native feeder, one pump awaits the group's `next()`
 * — one crossing for whatever every stream had queued — and demultiplexes the
 * entries into each stream's web readable. The consumer's `read()` resolves
 * on the JS thread exactly as before, so a stamp taken there means what it
 * always meant.
 *
 * The lever is OFF by default; with the knob unset this module builds
 * nothing and every readable pulls the addon directly (native-readable.ts).
 *
 * Per-stream backpressure is a byte window: the feeder may run at most one
 * window (plus one batch) ahead of the consumer, and the window is re-granted
 * only when the consumer has drained what was delivered — a stalled reader
 * stalls its feeder and nothing else.
 */

import {
	type ByteController,
	closeByteStream,
	closeQuietly,
	createNativeByteReadable,
	type NativeReadableOwner,
} from "./native-readable.js";
import {
	type StreamBatchDiagnostics,
	streamBatchConfig,
} from "./stream-chunk-batch.js";

const READ_GROUP_ENV = "WEBTRANSPORT_STREAM_READ_GROUP";
const READ_GROUP_WINDOW_ENV = "WEBTRANSPORT_STREAM_READ_GROUP_WINDOW";

/** Default per-stream window: 256 KiB, the Node adapters' highWaterMark. */
export const DEFAULT_READ_GROUP_WINDOW = 256 * 1024;
/** Entries one `next()` may return. */
const READ_GROUP_MAX_ENTRIES = 4096;

export function parseReadGroupWindow(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_READ_GROUP_WINDOW;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return DEFAULT_READ_GROUP_WINDOW;
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_READ_GROUP_WINDOW;
	return Math.min(value, 0xffff_ffff);
}

// Read once, like the batch knob: delivery shape never changes mid-process.
const readGroupEnabled = process.env[READ_GROUP_ENV] === "1";
const readGroupWindow = parseReadGroupWindow(
	process.env[READ_GROUP_WINDOW_ENV],
);

/** The addon's group, as this module needs it. */
export type NativeReadGroup = {
	readonly id: number;
	next(
		maxEntries: number,
	): Promise<Array<number | Uint8Array | string | null> | null>;
	grant(key: number, bytes: number): void;
	cancel(key: number): void;
	wake(): void;
	close(): void;
	/** Monotonic count of data entries the batched read produced. */
	readonly batchedEntries?: number;
	/** Monotonic count of every data entry the feeders produced. */
	readonly dataEntries?: number;
};

/** A receive handle that can feed a group. */
export type GroupFeedableHandle = {
	feedReadGroup?: (
		groupId: number,
		key: number,
		maxBytes: number,
		window: number,
	) => Promise<string | null | undefined>;
};

/**
 * The group's crossing instrument, the read-group twin of the batch
 * diagnostics in stream-chunk-batch.ts: how many `next()` crossings carried
 * entries, and how many entries and bytes they carried. Always on — four
 * additions per crossing — so a harness never has to ask whether it was.
 */
export type ReadGroupDiagnostics = {
	/** `next()` resolutions that carried at least one entry. */
	crossings: number;
	entries: number;
	/** Entries that carried stream bytes (one per feeder batch). */
	dataEntries: number;
	/** EOF and error-code entries. */
	terminalEntries: number;
	bytes: number;
	/** Data entries the native feeders produced with the batched read. */
	batchedEntries: number;
	/** Every data entry the native feeders produced, counted on the same
	 * (native) side and in the same window as `batchedEntries`. */
	nativeDataEntries: number;
	/** The largest single data entry: V-K's bound on a knob-off cell. */
	maxEntryBytes: number;
	maxEntriesPerCrossing: number;
	meanEntriesPerCrossing: number;
};

let batchedBaseline = 0;
let nativeDataBaseline = 0;
let since = 0;

function nativeBatchedEntries(): number {
	return processPump?.nativeBatchedEntries() ?? 0;
}

function nativeDataEntries(): number {
	return processPump?.nativeDataEntries() ?? 0;
}

const diag = {
	crossings: 0,
	entries: 0,
	dataEntries: 0,
	terminalEntries: 0,
	bytes: 0,
	maxEntryBytes: 0,
	maxEntriesPerCrossing: 0,
};

export function readGroupDiagnosticsSnapshot(): ReadGroupDiagnostics {
	return {
		...diag,
		batchedEntries: nativeBatchedEntries() - batchedBaseline,
		nativeDataEntries: nativeDataEntries() - nativeDataBaseline,
		meanEntriesPerCrossing:
			diag.crossings > 0 ? diag.entries / diag.crossings : 0,
	};
}

/**
 * The group's per-stream deliveries in the batch counter's shape, so a
 * harness grades a group-fed cell with the same falsifiers (layer agreement,
 * knob provenance) it grades a direct one with. Each data entry is one
 * stream-level chunk — exactly what one `readStreamChunk` data crossing is on
 * the direct path; only the JS-thread crossing that carries it differs, and
 * that is `crossings` in {@link readGroupDiagnosticsSnapshot}.
 *
 * `batchedCrossings` is decided on one side, in one window: the native
 * feeders count both their batched entries and all their data entries, and
 * only if the two agree exactly (every entry fed in the window was batched)
 * does the shape report every delivered entry as batched; otherwise it
 * reports the native batched count, which a knob-off cell needs to be 0 and
 * a knob-on cell cannot then pass. Comparing the native count with the
 * JS-side dispatch count instead would mix two windows offset by whatever was
 * fed before the reset and dispatched after it.
 */
export function readGroupAsStreamBatchDiagnostics(): StreamBatchDiagnostics {
	const snap = readGroupDiagnosticsSnapshot();
	const elapsedMs = since > 0 ? Math.max(0, performance.now() - since) : 0;
	const everyFedEntryBatched =
		snap.nativeDataEntries > 0 &&
		snap.batchedEntries === snap.nativeDataEntries;
	return {
		dataCrossings: snap.dataEntries,
		terminalCrossings: snap.terminalEntries,
		batchedCrossings: everyFedEntryBatched
			? snap.dataEntries
			: snap.batchedEntries,
		bytes: snap.bytes,
		meanBytesPerCrossing:
			snap.dataEntries > 0 ? snap.bytes / snap.dataEntries : 0,
		maxBatchBytes: snap.maxEntryBytes,
		elapsedMs,
		crossingsPerSecond:
			elapsedMs > 0
				? ((snap.dataEntries + snap.terminalEntries) * 1000) / elapsedMs
				: 0,
	};
}

/** Start a fresh measurement window (a probe calls this at phase start). */
export function resetReadGroupDiagnostics(): void {
	batchedBaseline = nativeBatchedEntries();
	nativeDataBaseline = nativeDataEntries();
	since = performance.now();
	diag.crossings = 0;
	diag.entries = 0;
	diag.dataEntries = 0;
	diag.terminalEntries = 0;
	diag.bytes = 0;
	diag.maxEntryBytes = 0;
	diag.maxEntriesPerCrossing = 0;
}

type Sink = {
	owner: NativeReadableOwner;
	controller: ByteController | null;
	/** The feeder starts on the first pull, never at attach. */
	started: boolean;
	/** Bytes the feeder has been allowed in total, and has delivered. */
	granted: number;
	delivered: number;
};

export class ReadGroupPump {
	readonly #group: NativeReadGroup;
	readonly #window: number;
	readonly #sinks = new Map<number, Sink>();
	#nextKey = 1;
	#running = false;
	/** Sinks whose feeder has started; the pump runs only while > 0. */
	#active = 0;
	/** Released keys to cancel once the current batch is dispatched. */
	readonly #pendingCancels = new Set<number>();
	/** Keys whose terminal entry the current batch carried. */
	readonly #terminalInBatch = new Set<number>();

	constructor(group: NativeReadGroup, window = DEFAULT_READ_GROUP_WINDOW) {
		this.#group = group;
		this.#window = window;
	}

	nativeBatchedEntries(): number {
		return this.#group.batchedEntries ?? 0;
	}

	nativeDataEntries(): number {
		return this.#group.dataEntries ?? 0;
	}

	/** Streams currently attached (tests and diagnostics). */
	get size(): number {
		return this.#sinks.size;
	}

	/**
	 * Build the readable for one stream. The owner's hooks keep the lifecycle
	 * exactly as the direct readable's (native-readable.ts).
	 *
	 * **Lazy.** Nothing is read at attach: the feeder starts on the readable's
	 * first pull — the first `read()` that finds the queue empty — so a stream
	 * the application never reads holds no read-ahead, exactly as the direct
	 * pull holds none, and a native stream sink (`openReadSink`) can still
	 * claim the handle; starting the feeder marks the stream as read (the
	 * owner's `onRead`), after which a sink is refused with
	 * E_SINK_READ_ACTIVE. Once started, a stream holds at
	 * most one window plus one batch ahead of its consumer: the native part is
	 * also inside the stream's own `maxQueuedBytesPerStream` reservation until
	 * it crosses; the crossed part sits in the byte stream's JS queue.
	 */
	attach(
		handle: GroupFeedableHandle,
		owner: NativeReadableOwner,
	): ReadableStream<Uint8Array> {
		const feed = handle.feedReadGroup;
		if (typeof feed !== "function") return createNativeByteReadable(owner);
		const key = this.#nextKey++;
		if (this.#nextKey > 0xffff_ffff) this.#nextKey = 1;
		const sink: Sink = {
			owner,
			controller: null,
			started: false,
			granted: this.#window,
			delivered: 0,
		};
		this.#sinks.set(key, sink);
		const startFeeder = () => {
			sink.started = true;
			owner.onRead?.();
			this.#active++;
			void feed
				.call(
					handle,
					this.#group.id,
					key,
					// The batch knob carries: 0 (off) makes the feeder loop
					// `read()`, a budget makes it loop `readBatch(budget)` — the
					// same chunks the direct readable's `readStreamChunk` would
					// cross.
					streamBatchConfig().batchBytes,
					this.#window,
				)
				.then((code) => {
					// A feeder that could not start is a stream that cannot read.
					if (typeof code === "string") this.#fail(key, new Error(code));
				});
			this.#start();
		};
		return new ReadableStream<Uint8Array>(
			{
				type: "bytes",
				start: (controller: ByteController) => {
					sink.controller = controller;
				},
				// A pull means the consumer is waiting on an empty queue:
				// everything delivered so far has been read. The first one starts
				// the feeder with a full window; later ones top the allowance back
				// up to a full window once half is spent, so a grant crosses once
				// per half window rather than once per read.
				pull: () => {
					if (!this.#sinks.has(key)) return;
					if (!sink.started) {
						if (sink.owner.current() === null) {
							this.#detach(key);
							if (sink.controller) closeQuietly(sink.controller);
							return;
						}
						startFeeder();
						return;
					}
					const allowed = sink.granted - sink.delivered;
					if (allowed < this.#window / 2) {
						const add = this.#window - allowed;
						sink.granted += add;
						this.#group.grant(key, add);
					}
				},
				cancel: (reason: unknown) => {
					const wasStarted = sink.started;
					this.#detach(key);
					// A key whose feeder has not registered yet is remembered as
					// cancelled natively (read_group.rs), so the cancel is never
					// lost to a registration race.
					if (wasStarted) this.#group.cancel(key);
					owner.onCancel(reason);
				},
			} as unknown as object,
			{ highWaterMark: 0 },
		);
	}

	#detach(key: number): Sink | undefined {
		const sink = this.#sinks.get(key);
		if (!sink) return undefined;
		this.#sinks.delete(key);
		if (sink.started) {
			this.#active--;
			// Let a pending `next()` resolve so a pump with no feeders left
			// stops and does not hold the event loop open.
			if (this.#active === 0) this.#group.wake();
		}
		return sink;
	}

	/**
	 * Error one stream's readable. `stopFeeder` is set when the failure did
	 * not come from the feeder's own last entry (a delivery that threw), so a
	 * still-running feeder is cancelled instead of parking on credit forever
	 * and pinning its handle.
	 */
	#fail(key: number, err: unknown, stopFeeder = false): void {
		const sink = this.#detach(key);
		if (stopFeeder && sink?.started) this.#group.cancel(key);
		if (!sink || sink.owner.current() === null) return;
		try {
			sink.controller?.error(sink.owner.onError(err));
		} catch {
			// The stream already settled by another path.
		}
	}

	#start(): void {
		if (this.#running) return;
		this.#running = true;
		void this.#run();
	}

	async #run(): Promise<void> {
		try {
			while (this.#active > 0) {
				const batch = await this.#group.next(READ_GROUP_MAX_ENTRIES);
				if (batch === null) break;
				const entries = batch.length >> 1;
				if (entries > 0) {
					diag.crossings++;
					diag.entries += entries;
					if (entries > diag.maxEntriesPerCrossing)
						diag.maxEntriesPerCrossing = entries;
				}
				this.#pendingCancels.clear();
				this.#terminalInBatch.clear();
				for (let i = 0; i + 1 < batch.length; i += 2) {
					if (!((batch[i + 1] ?? null) instanceof Uint8Array))
						this.#terminalInBatch.add(batch[i] as number);
				}
				for (let i = 0; i + 1 < batch.length; i += 2) {
					const value = batch[i + 1] ?? null;
					if (value instanceof Uint8Array) {
						diag.dataEntries++;
						diag.bytes += value.byteLength;
						if (value.byteLength > diag.maxEntryBytes)
							diag.maxEntryBytes = value.byteLength;
					} else diag.terminalEntries++;
					const key = batch[i] as number;
					// Contain a throwing delivery to its own stream: the rest of
					// the batch belongs to other streams and must still land.
					try {
						this.#dispatch(key, value);
					} catch (err) {
						this.#fail(key, err, value instanceof Uint8Array);
					}
				}
				for (const key of this.#pendingCancels) {
					if (!this.#terminalInBatch.has(key)) this.#group.cancel(key);
				}
			}
		} finally {
			this.#running = false;
			// A feeder started while the last `next()` was resolving.
			if (this.#active > 0) this.#start();
		}
	}

	#dispatch(key: number, value: number | Uint8Array | string | null): void {
		const sink = this.#sinks.get(key);
		// A cancelled stream's late entries are dropped.
		if (!sink || !sink.controller) return;
		// A released stream (the owner disposed or reset it) settles a waiting
		// reader the way the direct readable's next pull would — it closes —
		// and its feeder is told to stop.
		if (sink.owner.current() === null) {
			this.#detach(key);
			// Data means the feeder may still be running; a terminal entry means
			// it already ended. The cancel waits for the end of this batch and is
			// dropped if the same batch also carried the key's terminal entry, so
			// a feeder that already unregistered is never cancelled.
			if (value instanceof Uint8Array) this.#pendingCancels.add(key);
			closeQuietly(sink.controller);
			return;
		}
		if (typeof value === "string") {
			this.#fail(key, new Error(value));
			return;
		}
		if (value === null) {
			this.#detach(key);
			sink.owner.onEnd();
			closeByteStream(sink.controller);
			return;
		}
		if (typeof value === "number" || value.byteLength === 0) return;
		sink.delivered += value.byteLength;
		sink.owner.onBytes?.(value.byteLength);
		sink.controller.enqueue(value);
	}
}

let processPump: ReadGroupPump | null = null;
let groupFactory: (() => NativeReadGroup) | null = null;

/** The addon loader registers the native group constructor here. */
export function configureReadGroup(
	factory: (() => NativeReadGroup) | null,
): void {
	groupFactory = factory;
}

/**
 * The readable for a native-backed incoming stream: group-fed when the knob
 * is on and the addon supports it, a direct pull otherwise.
 */
export function createIncomingReadable(
	handle: GroupFeedableHandle,
	owner: NativeReadableOwner,
): ReadableStream<Uint8Array> {
	if (!readGroupEnabled || !groupFactory || !handle.feedReadGroup) {
		return createNativeByteReadable(owner);
	}
	processPump ??= new ReadGroupPump(groupFactory(), readGroupWindow);
	return processPump.attach(handle, owner);
}

export function readGroupConfig(): Readonly<{
	enabled: boolean;
	window: number;
}> {
	return Object.freeze({ enabled: readGroupEnabled, window: readGroupWindow });
}
