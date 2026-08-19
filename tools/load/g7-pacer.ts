/**
 * The server-side cumulative-deadline paced writer.
 *
 * G5b's pacer is Rust and lives on the *client*. G7 needs the paced writer on
 * the **server**, in JS, which is new — so the mechanism is re-implemented here
 * rather than reused, and the three properties the gate's honesty rests on are
 * re-established for the port:
 *
 * 1. **It cannot overshoot.** A write is issued only when its cumulative
 *    deadline has already passed, so the only possible error direction is
 *    under-offering. Under-offering can cause a miss; it can never manufacture
 *    a pass.
 * 2. **Timer error does not accumulate.** The deadline is absolute
 *    (`written / rate` from the step's start), so an over-sleep shortens the
 *    next sleep instead of shifting the whole schedule.
 * 3. **A block is absorbed, not repaid.** `write()` is awaited, so a stream
 *    parked on the per-stream governor falls behind and *stays* behind. There
 *    is no catch-up burst to erase the evidence.
 *
 * Two things are different in JS and are handled rather than hidden:
 *
 * - **Sub-millisecond intervals.** Below the timer granularity the writer
 *   issues every write currently due at one wake, capped at `sliceQuantum` =
 *   one timer tick of bytes. The burst is therefore ~1 ms wide at *every* rung
 *   of the ladder, so the rungs stay comparable, and it is disclosed as an
 *   input to any reading of the crossing figures.
 * - **The pacer shares the product's event loop** — it *is* the server. That
 *   coupling is unavoidable (G3b established that no in-process scheduler
 *   escapes it), so it is measured instead of denied: `pacerLateness` =
 *   actual − intended is recorded per write, and the classifier's V2b converts
 *   a shortfall accompanied by large lateness into an ORIGINATOR-BOUND cell
 *   rather than a product miss.
 *
 * The clock and the sleep are injected so the whole mechanism runs in a unit
 * test with no timers and no transport.
 */

import { G7Histogram } from "./g7-histogram.ts";

/**
 * Deadline tolerance, in milliseconds — one nanosecond.
 *
 * `written / rate` accumulates double-rounding residue on the order of 1e-14 ms,
 * which is enough to make a write that is exactly due look 1e-14 ms early
 * forever: the writer then sleeps a value too small to move any clock and
 * livelocks. (A real timer's 1 ms floor hides this; a fake clock does not, which
 * is why the pacer is tested against one.)
 *
 * A nanosecond of tolerance is 1.5e-7 of the gate arm's 6.71 ms interval —
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
	lateness: G7Histogram;
	/** write() call → its promise settling, per write. */
	settle: G7Histogram;
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
	const lateness = new G7Histogram();
	const settle = new G7Histogram();
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

/**
 * The token arm's emitter grid: sessions spread across slices of one
 * inter-token interval instead of all firing on the tick.
 *
 * An aligned emitter would put every session's token in one instant — 1,000
 * writes per 40 ms tick — which is the egress mirror of T02's CONFIRMED
 * synchronized-arrival mechanism, and it would measure the impulse rather than
 * the shape. The aligned case is registered as NOT COVERED.
 */
export function sliceAssignment(sessionIndex: number, slices: number): number {
	return sessionIndex % slices;
}

/**
 * The offset, in milliseconds from the tick, at which a session in `slice`
 * emits. Spreading is by construction and not by jitter, so it is reproducible.
 */
export function sliceOffsetMs(
	slice: number,
	slices: number,
	intervalMs: number,
): number {
	return (slice * intervalMs) / slices;
}
