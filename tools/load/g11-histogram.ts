/**
 * G11's latency histogram, and the percentile taken over it.
 *
 * Provenance: the bucket layout is `g7-histogram.ts` on
 * `probe/g7-stream-egress-01`, copied rather than imported so the two probe
 * branches stay independent (the `latency-clock.ts` precedent). Two things are
 * added here because G11 needs them and G7 did not:
 *
 * - **`percentileMs` lives with the histogram**, because both ends of this gate
 *   produce distributions and the classifier consumes a single number from
 *   each. G7 computed its percentile inside its classifier; here the two ends
 *   are different languages, so the ranking rule has to be one function that
 *   both snapshots pass through.
 * - **The snapshot carries its own edges**, so the Rust generator's histogram
 *   and this one are read by the same code without a shared constant that could
 *   drift across the language boundary.
 *
 * The rule the ranking follows, unchanged from G7 and for the same reason: a
 * non-positive sample is a *sample*. It counts in the denominator and ranks at
 * the bottom. Dropping it silently shrinks the population a p99 is taken over,
 * which is the exact fault G3b's stamp found — and here it would also hide the
 * instrument fault that V-N exists to catch, since V-N reads `negativeCount`.
 */

/** Sub-millisecond resolution, in microseconds. */
const SUB_MS_BUCKET_US = 10;
const SUB_MS_BUCKETS = 100; // 0 .. 1 ms
/** Above 1 ms: 64 buckets per doubling, up to 1024 ms. */
const BUCKETS_PER_DOUBLING = 64;
const DOUBLINGS = 10;

const EDGES: number[] = (() => {
	const edges: number[] = [];
	for (let i = 1; i <= SUB_MS_BUCKETS; i += 1)
		edges.push((i * SUB_MS_BUCKET_US) / 1000);
	for (let d = 0; d < DOUBLINGS; d += 1) {
		const lo = 2 ** d;
		const hi = 2 ** (d + 1);
		for (let i = 1; i <= BUCKETS_PER_DOUBLING; i += 1)
			edges.push(lo + ((hi - lo) * i) / BUCKETS_PER_DOUBLING);
	}
	return edges;
})();

export const HISTOGRAM_CEILING_MS = EDGES[EDGES.length - 1] as number;

export type LatencySnapshot = {
	negativeCount: number;
	bucketUpperMs: number[];
	bucketCounts: number[];
	maxMs: number;
};

export class G11Histogram {
	readonly #counts = new Float64Array(EDGES.length);
	#negative = 0;
	#max = 0;

	record(ms: number): void {
		if (!Number.isFinite(ms)) return;
		if (ms > this.#max) this.#max = ms;
		if (ms <= 0) {
			this.#negative += 1;
			return;
		}
		const idx = indexOf(ms);
		this.#counts[idx] = (this.#counts[idx] ?? 0) + 1;
	}

	/** Record a nanosecond interval, which is what both stamps produce. */
	recordNs(ns: number | bigint): void {
		this.record(Number(ns) / 1e6);
	}

	get negativeCount(): number {
		return this.#negative;
	}

	snapshot(): LatencySnapshot {
		return {
			negativeCount: this.#negative,
			bucketUpperMs: EDGES.slice(),
			bucketCounts: Array.from(this.#counts),
			maxMs: this.#max,
		};
	}

	merge(other: LatencySnapshot): void {
		this.#negative += other.negativeCount;
		if (other.maxMs > this.#max) this.#max = other.maxMs;
		for (let i = 0; i < this.#counts.length; i += 1)
			this.#counts[i] = (this.#counts[i] ?? 0) + (other.bucketCounts[i] ?? 0);
	}
}

function indexOf(ms: number): number {
	if (ms <= 1) {
		const i = Math.ceil((ms * 1000) / SUB_MS_BUCKET_US) - 1;
		return Math.min(Math.max(i, 0), SUB_MS_BUCKETS - 1);
	}
	if (ms >= HISTOGRAM_CEILING_MS) return EDGES.length - 1;
	const d = Math.floor(Math.log2(ms));
	const lo = 2 ** d;
	const hi = 2 ** (d + 1);
	const within = Math.ceil(((ms - lo) / (hi - lo)) * BUCKETS_PER_DOUBLING) - 1;
	const base = SUB_MS_BUCKETS + d * BUCKETS_PER_DOUBLING;
	return Math.min(Math.max(base + Math.max(within, 0), 0), EDGES.length - 1);
}

export function emptySnapshot(): LatencySnapshot {
	return {
		negativeCount: 0,
		bucketUpperMs: EDGES.slice(),
		bucketCounts: new Array(EDGES.length).fill(0),
		maxMs: 0,
	};
}

export function sampleCount(s: LatencySnapshot): number {
	let total = s.negativeCount;
	for (const c of s.bucketCounts) total += c;
	return total;
}

/**
 * The percentile, over a population that includes the non-positive samples.
 *
 * Non-positive samples rank below every bucket, so they are consumed first;
 * a distribution that is *all* non-positive reports 0 ms rather than a
 * fabricated number, and V-N invalidates the cell anyway. A percentile above
 * the last edge reports `maxMs`, which is the only honest answer the buckets
 * can give.
 */
export function percentileMs(s: LatencySnapshot, q: number): number {
	if (q <= 0 || q > 1) throw new Error(`g11: percentile ${q} outside (0, 1]`);
	const total = sampleCount(s);
	if (total === 0) return 0;
	const target = q * total;
	let cumulative = s.negativeCount;
	if (cumulative >= target) return 0;
	for (let i = 0; i < s.bucketCounts.length; i += 1) {
		cumulative += s.bucketCounts[i] ?? 0;
		if (cumulative >= target) return s.bucketUpperMs[i] ?? s.maxMs;
	}
	return s.maxMs;
}
