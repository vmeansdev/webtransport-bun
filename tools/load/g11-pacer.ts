/**
 * The server-side cumulative-deadline paced writer.
 *
 * Provenance: this is `g7-pacer.ts` from `probe/g7-stream-egress-01`, copied
 * rather than imported so the two probe branches stay independent (the
 * `latency-clock.ts` precedent). The mechanism itself is `run_bulk_stream_worker`
 * in `crates/reference/src/load_client.rs`, ported to JS because G11's
 * downstream emitter runs *in the server*.
 *
 * The three properties ticket 27 established, which clause C1/C2 and falsifier
 * V-P rely on, are the reason it is this shape and not another:
 *
 * 1. **It cannot overshoot.** A write is issued only once its cumulative
 *    deadline has already passed, so the only possible error direction is
 *    under-offering. Under-offering can cause a miss; it can never manufacture
 *    a pass. V-P's upper bound of 1.02 is therefore a falsifier for "the pacer
 *    that ran was not this one", not a tolerance.
 * 2. **Timer error does not accumulate.** The deadline is absolute
 *    (`written / rate` from the step's start), so an over-sleep shortens the
 *    next sleep instead of shifting the whole schedule.
 * 3. **A block is absorbed, not repaid.** `write()` is awaited, so a stream
 *    parked on the per-stream governor falls behind and *stays* behind. There
 *    is no catch-up burst to erase the evidence — which matters more here than
 *    anywhere else on the board, because Arm D exists to make a stream park.
 *
 * Two JS-specific facts, handled rather than hidden:
 *
 * - **Sub-millisecond intervals.** Below timer granularity the writer issues
 *   every write currently due at one wake, capped at `sliceQuantum`. At G11's
 *   rungs the frame interval is 3.739 ms — 3.7x the tick — so the gate's own
 *   cells run at `sliceQuantum` 1 and the cap never binds. It is kept because a
 *   future rung could sit below the tick and would then need it.
 * - **The pacer shares the product's event loop** — it *is* the server. G3b
 *   established that no in-process scheduler escapes that, so it is measured
 *   instead of denied: `lateness` = actual - intended is recorded per write and
 *   travels in the artifact beside the offered rate it explains.
 *
 * The clock and the sleep are injected, so the whole mechanism runs in a unit
 * test with no timers and no transport.
 */

import { G11Histogram } from "./g11-histogram.ts";

/**
 * Deadline tolerance, in milliseconds — one nanosecond.
 *
 * `written / rate` accumulates double-rounding residue on the order of 1e-14 ms,
 * which is enough to make a write that is exactly due look 1e-14 ms early
 * forever: the writer then sleeps a value too small to move any clock and
 * livelocks. (A real timer's 1 ms floor hides this; a fake clock does not, which
 * is why the pacer is tested against one.)
 *
 * A nanosecond of tolerance is 2.7e-7 of the gate arm's 3.739 ms interval —
 * seven orders below the 2% overshoot falsifier — so it cannot manufacture an
 * offer. It is a rounding guard, not a design tolerance.
 */
const DEADLINE_EPSILON_MS = 1e-6;

export type PacedWriteResult = {
	/** Writes issued. Equals settles, by construction, on a clean run. */
	writes: number;
	settles: number;
	bytes: number;
	/** Writes that failed. A failing stream stops rather than hot-looping. */
	errors: number;
	firstError: string | null;
	/** actual − intended, per write. */
	lateness: G11Histogram;
	/** write() call → its promise settling, per write. */
	settle: G11Histogram;
	/** Set when the loop ended because the step's duration elapsed. */
	completedFullDuration: boolean;
};

export type PacedWriterOptions = {
	/** One crossing. Resolves when the addon has accepted the chunk. */
	write: (chunk: Uint8Array) => Promise<void>;
	/** Bytes per write. Fixed for the whole step: the ledger depends on it. */
	writeBytes: number;
	/** This stream's share of the offer. */
	bytesPerSec: number;
	durationMs: number;
	/** Max writes issued at one wake. See `bulkCellPlan().sliceQuantum`. */
	sliceQuantum: number;
	/** Monotonic milliseconds. Injected so tests need no timers. */
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/**
	 * Filled immediately before each write, so a payload can carry its own
	 * stamp. Called with the reusable per-stream buffer and the write's index.
	 */
	fill?: (chunk: Uint8Array, index: number, intendedMs: number) => void;
	/** Called after each write settles; the token arm records arrivals with it. */
	onSettled?: (index: number, actualMs: number, settledMs: number) => void;
	/**
	 * How the per-stream buffer is allocated. The conductor passes
	 * `Buffer.allocUnsafe` so the chunk reaching the addon is already a Buffer
	 * and the Node adapter has nothing to convert; the default keeps this module
	 * runnable in a plain unit test.
	 */
	allocChunk?: (bytes: number) => Uint8Array;
};

/**
 * Run one paced stream for the step.
 *
 * The chunk buffer is allocated once and reused. That is safe **because every
 * write is awaited before the next one on this stream is built** — the addon's
 * write copies the buffer inside an async body, and a pipelined writer sharing
 * one buffer would be the mutate-after-send race ticket 05 found on the
 * datagram path. One buffer per stream, one write in flight per stream.
 */
export async function runPacedStream(
	opts: PacedWriterOptions,
): Promise<PacedWriteResult> {
	const chunk = (opts.allocChunk ?? ((n: number) => new Uint8Array(n)))(
		opts.writeBytes,
	);
	const lateness = new G11Histogram();
	const settle = new G11Histogram();
	const start = opts.now();
	let writes = 0;
	let settles = 0;
	let bytes = 0;
	let errors = 0;
	let firstError: string | null = null;

	const dueMsFor = (writeIndex: number) =>
		((writeIndex * opts.writeBytes) / opts.bytesPerSec) * 1000;

	while (opts.now() - start < opts.durationMs) {
		let issuedThisWake = 0;
		while (issuedThisWake < opts.sliceQuantum) {
			const dueMs = dueMsFor(writes);
			const elapsed = opts.now() - start;
			// The whole no-overshoot property is this comparison: a write that is
			// not yet due is never issued, whatever the loop would otherwise do.
			if (dueMs - elapsed > DEADLINE_EPSILON_MS) break;
			if (elapsed >= opts.durationMs) break;
			const intendedMs = start + dueMs;
			opts.fill?.(chunk, writes, intendedMs);
			const actualMs = opts.now();
			lateness.record(actualMs - intendedMs);
			writes += 1;
			issuedThisWake += 1;
			try {
				await opts.write(chunk);
				const settledMs = opts.now();
				settle.record(settledMs - actualMs);
				settles += 1;
				bytes += opts.writeBytes;
				opts.onSettled?.(writes - 1, actualMs, settledMs);
			} catch (err) {
				errors += 1;
				if (firstError === null)
					firstError = err instanceof Error ? err.message : String(err);
				return {
					writes,
					settles,
					bytes,
					errors,
					firstError,
					lateness,
					settle,
					completedFullDuration: false,
				};
			}
		}
		const waitMs = dueMsFor(writes) - (opts.now() - start);
		if (waitMs > DEADLINE_EPSILON_MS) await opts.sleep(waitMs);
		else await opts.sleep(0);
	}

	return {
		writes,
		settles,
		bytes,
		errors,
		firstError,
		lateness,
		settle,
		completedFullDuration: true,
	};
}
