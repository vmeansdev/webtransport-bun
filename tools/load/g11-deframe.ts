/**
 * G11's off-thread upstream deframer: the conductor-side pool, its batch
 * format, and the merge that makes K workers' ledgers read as one record.
 *
 * Why this design and not another (issue 10's verdict, 2026-08-21): at T-100
 * the conductor's single JS thread — the same thread that hosts the product
 * server — ran both the 100 downstream pacers (~26.4k awaited writes/s) and
 * the 100 upstream deframers (~26.8k frames/s decoded, stamped, and
 * histogrammed), sat at 93–95% of one core, and the pacers got the residual:
 * offered-down 0.40 of target while T-50 was exact. The ruled fix direction is
 * "worker-thread emitters", with design latitude. The emitters themselves
 * CANNOT move: every downstream write lands on an env-bound N-API class method
 * (`#[napi] pub async fn write`, `crates/native/src/client_stream.rs:1645` and
 * `:1876`; JS contract `NativeBidiStreamHandle.write`,
 * `packages/webtransport/src/index.ts:1249`) whose handle was created on the
 * main thread's napi env — a Bun Worker has its own env, the handle cannot
 * cross, and the addon's only ThreadsafeFunction surfaces are callbacks INTO
 * JS (`crates/native/src/client.rs:1635`, `lib.rs:354-408`), never a write
 * entry callable from another thread. So the write side stays where it must
 * be, and the OTHER half of the thread's load — deframing, per-frame latency
 * bucketing, per-session byte ledgers — moves to workers, where the payload is
 * plain bytes and everything transfers.
 *
 * What this preserves, clause by clause:
 *
 * - **`offeredBytes.down` is untouched** — it is the pacers' settled writes,
 *   which never left the main thread.
 * - **CLOCK_REALTIME stamping ends where it always did.** The arrival stamp is
 *   taken on the main thread at the read() resolution (`wallNs()` in the
 *   reader loop) and travels with the chunk; the worker only computes
 *   `arrival - frame.sendWallNs`. Deframing later cannot move a latency
 *   number, and V-N still reads the same negative-count it always has.
 * - **Per-session pacing shape is untouched** — the pool is receive-side only.
 * - **Aggregation is populations-first**: workers ship full histogram
 *   snapshots, `mergeLatencySnapshots` sums counts, and the percentile is
 *   taken once downstream. Counters sum; no percentile-of-percentiles.
 * - **A worker failure is a cell failure** (the shard composite's
 *   all-or-nothing rule): one failed worker makes the whole up-side deframe
 *   product absent — `finish()` returns null, never a smaller population that
 *   grades.
 *
 * Batch format: the main thread copies each chunk into a per-worker builder
 * (one memcpy — the native read buffers are not assumed transferable) and
 * posts columnar batches whose five buffers all transfer: payload bytes,
 * stream keys, arrival stamps, offsets, lengths. Ordering per stream is
 * preserved because a stream's chunks always route to one worker and
 * postMessage delivers in order, so the worker-side Deframer sees exactly the
 * byte sequence the inline Deframer saw — frames split across chunk or batch
 * boundaries reassemble identically.
 */

import { mergeLatencySnapshots } from "./g11-shard.ts";
import type { LatencySnapshot } from "./g11-histogram.ts";

/** One flushed batch, as the worker receives it. All five buffers transfer. */
export type DeframeChunkBatch = {
	type: "chunks";
	count: number;
	data: ArrayBuffer;
	streams: ArrayBuffer;
	arrivals: ArrayBuffer;
	offsets: ArrayBuffer;
	lengths: ArrayBuffer;
};

export type DeframeFinish = { type: "finish" };

export type DeframeProgress = { type: "progress"; frames: number };

export type DeframeWorkerSnapshot = {
	type: "snapshot";
	upFrames: number;
	deframeErrors: number;
	latency: LatencySnapshot;
	perSessionUpBytes: [number, number][];
};

/** The merged view of every worker's ledger, shaped for the cell record. */
export type DeframeSnapshot = {
	upFrames: number;
	deframeErrors: number;
	latency: LatencySnapshot;
	perSessionUpBytes: Map<number, number>;
};

/**
 * How many deframe workers a T cell runs.
 *
 * `"auto"` (the default): 0 at or below `sessionsPerWorker`, else
 * ceil(sessions / sessionsPerWorker). The threshold and divisor are both the
 * measured 50-session figure (`G11_SHARD_SESSIONS`' provenance): T-50 sourced
 * both directions exactly with everything inline, so at or below it the cell
 * runs byte-identically to the pre-worker conductor — the default changes
 * nothing that was already correct. Above it, each worker deframes at most 50
 * sessions' upstream, a load the single thread sustained even while also
 * running 50 pacers, so the sizing is an upper allowance rather than a tuning.
 * An explicit integer overrides (0 forces inline at any size).
 */
export function deframeWorkerPlan(
	sessions: number,
	envValue: string,
	sessionsPerWorker: number,
): number {
	if (envValue === "auto") {
		return sessions <= sessionsPerWorker
			? 0
			: Math.ceil(sessions / sessionsPerWorker);
	}
	const n = Number(envValue);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(
			`g11: G11_DEFRAME_WORKERS must be 'auto' or a non-negative integer, got '${envValue}'`,
		);
	}
	return n;
}

const BATCH_ENTRIES = 128;
const BATCH_DATA_BYTES = 256 * 1024;
/**
 * How long a sub-capacity batch may sit before it is posted. Deframe delay
 * cannot move a latency number (the arrival stamp already rode along), so this
 * bounds only the staleness of the progress counter the settle barrier reads.
 */
const FLUSH_AFTER_MS = 2;
const SNAPSHOT_TIMEOUT_MS = 10_000;

class BatchBuilder {
	data = new Uint8Array(BATCH_DATA_BYTES);
	streams = new Uint32Array(BATCH_ENTRIES);
	arrivals = new BigUint64Array(BATCH_ENTRIES);
	offsets = new Uint32Array(BATCH_ENTRIES);
	lengths = new Uint32Array(BATCH_ENTRIES);
	count = 0;
	used = 0;

	fits(bytes: number): boolean {
		return this.count < BATCH_ENTRIES && this.used + bytes <= BATCH_DATA_BYTES;
	}

	push(streamKey: number, arrivalNs: bigint, chunk: Uint8Array): void {
		this.data.set(chunk, this.used);
		this.streams[this.count] = streamKey;
		this.arrivals[this.count] = arrivalNs;
		this.offsets[this.count] = this.used;
		this.lengths[this.count] = chunk.byteLength;
		this.used += chunk.byteLength;
		this.count += 1;
	}

	/** Take the current batch (buffers move to the caller) and start fresh. */
	take(): DeframeChunkBatch {
		const batch: DeframeChunkBatch = {
			type: "chunks",
			count: this.count,
			data: this.data.buffer as ArrayBuffer,
			streams: this.streams.buffer as ArrayBuffer,
			arrivals: this.arrivals.buffer as ArrayBuffer,
			offsets: this.offsets.buffer as ArrayBuffer,
			lengths: this.lengths.buffer as ArrayBuffer,
		};
		this.data = new Uint8Array(BATCH_DATA_BYTES);
		this.streams = new Uint32Array(BATCH_ENTRIES);
		this.arrivals = new BigUint64Array(BATCH_ENTRIES);
		this.offsets = new Uint32Array(BATCH_ENTRIES);
		this.lengths = new Uint32Array(BATCH_ENTRIES);
		this.count = 0;
		this.used = 0;
		return batch;
	}
}

export type DeframePoolOptions = {
	/** Incremental frame counts, as workers report them; feeds the settle barrier. */
	onProgress?: (frames: number) => void;
	/** Called once, at the moment the pool first fails. */
	onFailure?: (reason: string) => void;
	/** Overridable for tests. */
	workerUrl?: string;
};

export class DeframePool {
	readonly workerCount: number;
	#workers: Worker[] = [];
	#builders: BatchBuilder[] = [];
	#snapshotWaiters: ((s: DeframeWorkerSnapshot | null) => void)[] = [];
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	#nextStreamKey = 0;
	#failure: string | null = null;
	#finished = false;
	#opts: DeframePoolOptions;

	constructor(workerCount: number, opts: DeframePoolOptions = {}) {
		if (!Number.isInteger(workerCount) || workerCount < 1)
			throw new Error(`g11: deframe pool of ${workerCount} workers`);
		this.workerCount = workerCount;
		this.#opts = opts;
		const url =
			opts.workerUrl ??
			new URL("./g11-deframe-worker.ts", import.meta.url).href;
		for (let i = 0; i < workerCount; i += 1) {
			const worker = new Worker(url);
			worker.onmessage = (event: MessageEvent) => {
				const msg = event.data as DeframeProgress | DeframeWorkerSnapshot;
				if (msg.type === "progress") this.#opts.onProgress?.(msg.frames);
				else if (msg.type === "snapshot") this.#snapshotWaiters[i]?.(msg);
			};
			worker.onerror = (event: ErrorEvent) => {
				this.#fail(`worker ${i}: ${event.message ?? "error"}`);
			};
			this.#workers.push(worker);
			this.#builders.push(new BatchBuilder());
		}
	}

	get failure(): string | null {
		return this.#failure;
	}

	#fail(reason: string): void {
		if (this.#failure !== null) return;
		this.#failure = reason;
		this.#opts.onFailure?.(reason);
		// A pool that has failed will never produce a usable merge; release any
		// snapshot waiter immediately rather than letting finish() sit out the
		// timeout for a verdict that is already known.
		for (const waiter of this.#snapshotWaiters) waiter?.(null);
	}

	/** A route key for one stream. Every chunk of that stream must carry it. */
	openStream(): number {
		return this.#nextStreamKey++;
	}

	/**
	 * Hand one received chunk to the pool. Copies the bytes immediately (the
	 * caller may reuse or drop its buffer) and posts when the batch fills or
	 * `FLUSH_AFTER_MS` elapses.
	 */
	push(streamKey: number, arrivalNs: bigint, chunk: Uint8Array): void {
		if (this.#failure !== null || this.#finished) return;
		const worker = streamKey % this.workerCount;
		const builder = this.#builders[worker] as BatchBuilder;
		if (chunk.byteLength > BATCH_DATA_BYTES) {
			// Oversize chunk: post it alone, exact-size, after whatever is pending
			// (order within the stream must hold).
			this.#flushWorker(worker);
			const data = chunk.slice().buffer as ArrayBuffer;
			const single: DeframeChunkBatch = {
				type: "chunks",
				count: 1,
				data,
				streams: Uint32Array.of(streamKey).buffer as ArrayBuffer,
				arrivals: BigUint64Array.of(arrivalNs).buffer as ArrayBuffer,
				offsets: Uint32Array.of(0).buffer as ArrayBuffer,
				lengths: Uint32Array.of(chunk.byteLength).buffer as ArrayBuffer,
			};
			this.#post(worker, single);
			return;
		}
		if (!builder.fits(chunk.byteLength)) this.#flushWorker(worker);
		builder.push(streamKey, arrivalNs, chunk);
		if (this.#flushTimer === null) {
			this.#flushTimer = setTimeout(() => {
				this.#flushTimer = null;
				for (let w = 0; w < this.workerCount; w += 1) this.#flushWorker(w);
			}, FLUSH_AFTER_MS);
		}
	}

	#flushWorker(worker: number): void {
		const builder = this.#builders[worker] as BatchBuilder;
		if (builder.count === 0) return;
		this.#post(worker, builder.take());
	}

	#post(worker: number, batch: DeframeChunkBatch): void {
		try {
			(this.#workers[worker] as Worker).postMessage(batch, [
				batch.data,
				batch.streams,
				batch.arrivals,
				batch.offsets,
				batch.lengths,
			]);
		} catch (err) {
			this.#fail(`worker ${worker}: postMessage failed (${String(err)})`);
		}
	}

	/**
	 * Flush everything, collect every worker's ledger, and merge. Returns null
	 * if the pool failed at any point (including a snapshot timeout here) —
	 * all-or-nothing, like the shard composite: a partial worker set must never
	 * read as the cell's upstream.
	 */
	async finish(): Promise<DeframeSnapshot | null> {
		this.#finished = true;
		if (this.#flushTimer !== null) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		if (this.#failure !== null) return null;
		for (let w = 0; w < this.workerCount; w += 1) this.#flushWorker(w);
		const snapshots = await Promise.all(
			this.#workers.map(
				(worker, i) =>
					new Promise<DeframeWorkerSnapshot | null>((resolve) => {
						const timer = setTimeout(() => {
							this.#fail(
								`worker ${i}: no snapshot within ${SNAPSHOT_TIMEOUT_MS} ms`,
							);
							resolve(null);
						}, SNAPSHOT_TIMEOUT_MS);
						this.#snapshotWaiters[i] = (s) => {
							clearTimeout(timer);
							resolve(s);
						};
						try {
							worker.postMessage({ type: "finish" } satisfies DeframeFinish);
						} catch (err) {
							clearTimeout(timer);
							this.#fail(
								`worker ${i}: finish postMessage failed (${String(err)})`,
							);
							resolve(null);
						}
					}),
			),
		);
		if (this.#failure !== null || snapshots.some((s) => s === null))
			return null;
		const usable = snapshots as DeframeWorkerSnapshot[];
		const perSessionUpBytes = new Map<number, number>();
		let upFrames = 0;
		let deframeErrors = 0;
		for (const s of usable) {
			upFrames += s.upFrames;
			deframeErrors += s.deframeErrors;
			for (const [session, bytes] of s.perSessionUpBytes)
				perSessionUpBytes.set(
					session,
					(perSessionUpBytes.get(session) ?? 0) + bytes,
				);
		}
		return {
			upFrames,
			deframeErrors,
			latency: mergeLatencySnapshots(usable.map((s) => s.latency)),
			perSessionUpBytes,
		};
	}

	terminate(): void {
		for (const worker of this.#workers) worker.terminate();
	}
}
