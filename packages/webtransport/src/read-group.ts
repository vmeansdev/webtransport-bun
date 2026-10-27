/**
 * Cross-stream batched receive delivery, the JavaScript half (the native half
 * and the reasoning are in crates/native/src/read_group.rs).
 *
 * By default, every server-accepted incoming readable this process builds is
 * fed by one process-level read group: each stream's handle runs a native
 * feeder, one pump awaits the group's `next()` — one crossing for whatever
 * every stream had queued — and demultiplexes the entries into each stream's
 * web readable. The consumer's `read()` resolves
 * on the JS thread exactly as before, so a stamp taken there means what it
 * always meant.
 *
 * The lever is ON by default; `WEBTRANSPORT_STREAM_READ_GROUP=0` turns it
 * off, and then this module builds nothing and every readable pulls the addon
 * directly (native-readable.ts), as does every readable when the addon has
 * no group. Client-side readables always pull directly.
 *
 * Backpressure is demand, exactly as on the direct pull: a feeder may make
 * one read per pull the consumer has outstanding (one byte of credit per
 * pull, re-granted by the next pull), so nothing is read ahead of the
 * consumer. Bytes a stalled reader has not asked for stay in the transport,
 * under QUIC flow control and the native receive budgets
 * (`maxQueuedBytesGlobal` / `PerSession` / `PerStream`); a crossed chunk
 * goes straight to the read that asked for it rather than into a JavaScript
 * queue no budget sees. What the group saves is unchanged: every stream
 * whose read completed while the event loop was busy crosses in one
 * `next()` resolution.
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

/** Credit for one outstanding pull: one byte admits exactly one native read
 * (the feeder reads while its credit is positive; a read spends its length). */
const DEMAND_CREDIT = 1;
/** Entries one `next()` may return. */
const READ_GROUP_MAX_ENTRIES = 4096;
/** Feeder keys are u32; 0 is never used. */
const MAX_KEY = 0xffff_ffff;

/**
 * The read group is on unless the knob is exactly `0` (surrounding
 * whitespace ignored): unset, empty, `1` or anything else keeps it on.
 */
export function parseReadGroupEnabled(raw: string | undefined): boolean {
	return raw?.trim() !== "0";
}

// Read once, like the batch knob: delivery shape never changes mid-process.
const readGroupEnabled = parseReadGroupEnabled(process.env[READ_GROUP_ENV]);

/** The addon's group, as this module needs it. */
export type NativeReadGroup = {
	readonly id: number;
	next(
		maxEntries: number,
	): Promise<Array<number | Uint8Array | string | null> | null>;
	/** Create `key`'s native credit before its feeder is started; throws if
	 * the key is still live. */
	prepare(key: number, credit: number): void;
	grant(key: number, bytes: number): void;
	cancel(key: number): void;
	wake(): void;
	close(): void;
	/** Monotonic count of data entries the batched read produced. */
	readonly batchedEntries?: number;
	/** Monotonic count of every data entry the feeders produced. */
	readonly dataEntries?: number;
	/** Entries / payload bytes queued natively and not yet drained, and keys
	 * prepared or feeding (diagnostics and tests). */
	readonly queued?: number;
	readonly queuedBytes?: number;
	readonly liveKeys?: number;
};

/** A receive handle that can feed a group. */
export type GroupFeedableHandle = {
	feedReadGroup?: (
		groupId: number,
		key: number,
		maxBytes: number,
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
	/** Credit the feeder has been allowed in total, and bytes it delivered:
	 * `granted - delivered > 0` means a read is outstanding. */
	granted: number;
	delivered: number;
	/** Settles the pending pull once its read is answered (data, EOF, error
	 * or detach), so the stream calls pull again for a read still waiting —
	 * the same promise-returning pull the direct readable uses. */
	wake: (() => void) | null;
};

function settlePull(sink: Sink): void {
	const wake = sink.wake;
	sink.wake = null;
	wake?.();
}

function pullAnswered(sink: Sink): Promise<void> {
	return new Promise<void>((resolve) => {
		sink.wake = resolve;
	});
}

export class ReadGroupPump {
	readonly #group: NativeReadGroup;
	readonly #sinks = new Map<number, Sink>();
	/** Keys whose native feeder has not resolved yet (it may outlive its
	 * sink): never reused, and the only keys a cancel is sent for. */
	readonly #feeding = new Set<number>();
	#nextKey = 1;
	#running = false;
	/** Sinks whose feeder has started; the pump runs only while > 0. */
	#active = 0;

	constructor(group: NativeReadGroup) {
		this.#group = group;
	}

	/** Tests: where key allocation resumes (exercises the u32 wrap). */
	setNextKeyForTests(key: number): void {
		this.#nextKey = key;
	}

	/** The next free key, skipping any still attached or still feeding, so a
	 * wrap can never alias a live stream. */
	#allocateKey(): number {
		for (;;) {
			const key = this.#nextKey;
			this.#nextKey = key >= MAX_KEY ? 1 : key + 1;
			if (!this.#sinks.has(key) && !this.#feeding.has(key)) return key;
		}
	}

	/** Bytes crossed into attached readables that no reader has taken yet
	 * (each byte stream's queue). With demand credit this stays at most one
	 * partially consumed chunk per stream (a BYOB read smaller than the
	 * chunk), the same bound as the direct pull. */
	heldBytes(): number {
		let held = 0;
		for (const sink of this.#sinks.values()) {
			const desired = (sink.controller as { desiredSize?: number | null })
				?.desiredSize;
			if (typeof desired === "number" && desired < 0) held -= desired;
		}
		return held;
	}

	/** Keys whose native feeder is still running (tests and diagnostics). */
	get feeding(): number {
		return this.#feeding.size;
	}

	/** The native group's queue and live keys (tests and diagnostics). */
	nativeQueue(): { queued: number; queuedBytes: number; liveKeys: number } {
		return {
			queued: this.#group.queued ?? 0,
			queuedBytes: this.#group.queuedBytes ?? 0,
			liveKeys: this.#group.liveKeys ?? 0,
		};
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
	 * E_SINK_READ_ACTIVE. Once started, the feeder makes one read per pull
	 * the consumer has outstanding and nothing more (see the module docs).
	 *
	 * The pump sets the owner's `released` hook: an owner that releases the
	 * handle (dispose, reset, session close) detaches the stream here, stops
	 * its feeder and settles its readable, read or not.
	 */
	attach(
		handle: GroupFeedableHandle,
		owner: NativeReadableOwner,
	): ReadableStream<Uint8Array> {
		const feed = handle.feedReadGroup;
		if (typeof feed !== "function") return createNativeByteReadable(owner);
		const key = this.#allocateKey();
		const sink: Sink = {
			owner,
			controller: null,
			started: false,
			granted: DEMAND_CREDIT,
			delivered: 0,
			wake: null,
		};
		this.#sinks.set(key, sink);
		owner.released = () => this.#released(key);
		const startFeeder = () => {
			sink.started = true;
			owner.onRead?.();
			this.#active++;
			try {
				// The first pull's demand: one read.
				this.#group.prepare(key, DEMAND_CREDIT);
			} catch (err) {
				this.#fail(key, err);
				return;
			}
			this.#feeding.add(key);
			let fed: Promise<string | null | undefined>;
			try {
				fed = feed.call(
					handle,
					this.#group.id,
					key,
					// The batch knob carries: 0 (off) makes the feeder loop
					// `read()`, a budget makes it loop `readBatch(budget)` — the
					// same chunks the direct readable's `readStreamChunk` would
					// cross.
					streamBatchConfig().batchBytes,
				);
			} catch (err) {
				// Forget the prepared key: no feeder will claim it.
				this.#group.cancel(key);
				this.#feeding.delete(key);
				this.#fail(key, err);
				return;
			}
			fed.then(
				(code) => {
					this.#feeding.delete(key);
					// A feeder that could not start is a stream that cannot read.
					if (typeof code === "string") this.#fail(key, new Error(code));
				},
				(err: unknown) => {
					this.#feeding.delete(key);
					this.#fail(key, err);
				},
			);
			this.#start();
		};
		return new ReadableStream<Uint8Array>(
			{
				type: "bytes",
				start: (controller: ByteController) => {
					sink.controller = controller;
				},
				// A pull means the consumer is waiting on an empty queue. The
				// first one starts the feeder with one read's credit; later ones
				// grant one more read unless the last one is still outstanding.
				pull: (): Promise<void> | undefined => {
					if (!this.#sinks.has(key)) return undefined;
					if (!sink.started) {
						if (sink.owner.current() === null) {
							this.#released(key);
							return undefined;
						}
						const answered = pullAnswered(sink);
						startFeeder();
						return answered;
					}
					const allowed = sink.granted - sink.delivered;
					if (allowed <= 0) {
						const add = DEMAND_CREDIT - allowed;
						sink.granted += add;
						this.#group.grant(key, add);
					}
					return pullAnswered(sink);
				},
				cancel: (reason: unknown) => {
					// Cancel before detaching (which may stop the pump): a prepared
					// key whose feeder has not claimed it yet is forgotten
					// natively, and a running feeder's queued and late entries are
					// dropped there, so nothing is left for a stopped pump.
					if (sink.started) this.#cancelFeeder(key);
					this.#detach(key);
					owner.onCancel(reason);
				},
			} as unknown as object,
			{ highWaterMark: 0 },
		);
	}

	/** Stop a feeder that may still be running. Only keys whose feed has not
	 * resolved are cancelled, so a reused key is never hit. Natively the
	 * cancel also drops the key's queued entries and any its in-flight read
	 * produces later, releasing their reservations (read_group.rs `cancel`),
	 * so a pump that stops because this was its last stream leaves nothing
	 * behind in the group's queue. */
	#cancelFeeder(key: number): void {
		if (this.#feeding.has(key)) this.#group.cancel(key);
	}

	/** The owner released the handle: detach, stop the feeder, settle. */
	#released(key: number): void {
		const sink = this.#sinks.get(key);
		if (!sink) return;
		// Cancel first: see the readable's cancel.
		if (sink.started) this.#cancelFeeder(key);
		this.#detach(key);
		if (sink.controller) closeQuietly(sink.controller);
	}

	#detach(key: number): Sink | undefined {
		const sink = this.#sinks.get(key);
		if (!sink) return undefined;
		this.#sinks.delete(key);
		settlePull(sink);
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
		if (stopFeeder && this.#sinks.get(key)?.started) this.#cancelFeeder(key);
		const sink = this.#detach(key);
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
		// A released stream (an owner without the `released` hook, or one
		// that dropped its handle without releasing) settles a waiting reader
		// the way the direct readable's next pull would — it closes — and its
		// feeder is told to stop (a no-op natively if it already ended).
		if (sink.owner.current() === null) {
			this.#released(key);
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
		if (typeof value === "number") return;
		if (value.byteLength === 0) return;
		sink.delivered += value.byteLength;
		sink.owner.onBytes?.(value.byteLength);
		sink.controller.enqueue(value);
		settlePull(sink);
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
 * The readable for a native-backed incoming stream: group-fed unless the knob
 * is off (`WEBTRANSPORT_STREAM_READ_GROUP=0`) or the addon or handle lacks the
 * group, a direct pull otherwise.
 */
export function createIncomingReadable(
	handle: GroupFeedableHandle,
	owner: NativeReadableOwner,
): ReadableStream<Uint8Array> {
	if (!readGroupEnabled || !groupFactory || !handle.feedReadGroup) {
		return createNativeByteReadable(owner);
	}
	processPump ??= new ReadGroupPump(groupFactory());
	return processPump.attach(handle, owner);
}

export function readGroupConfig(): Readonly<{ enabled: boolean }> {
	return Object.freeze({ enabled: readGroupEnabled });
}

/** The process pump's live state (tests): attached streams, running native
 * feeders, and bytes crossed but not yet taken by a reader. */
export function readGroupStateSnapshot(): {
	attached: number;
	feeding: number;
	heldBytes: number;
	nativeQueued: number;
	nativeQueuedBytes: number;
	nativeLiveKeys: number;
} {
	const native = processPump?.nativeQueue();
	return {
		attached: processPump?.size ?? 0,
		feeding: processPump?.feeding ?? 0,
		heldBytes: processPump?.heldBytes() ?? 0,
		nativeQueued: native?.queued ?? 0,
		nativeQueuedBytes: native?.queuedBytes ?? 0,
		nativeLiveKeys: native?.liveKeys ?? 0,
	};
}
