/**
 * A latency histogram that ranks its non-positive samples instead of dropping
 * them.
 *
 * This exists as its own instrument rather than reusing the datagram axes'
 * `LatencyHistogram` for one reason: that one counts a negative sample and does
 * not bucket it, and G3b's stamp found the resulting "p99" was the p99 of the
 * late tail of a subset whose size differed ~5x across the columns being
 * compared. Here a non-positive sample is a sample: it goes into
 * `negativeCount`, it counts in every denominator, and `percentileMs` ranks it
 * at the bottom.
 *
 * Buckets are linear below 1 ms and log-linear above it, which puts the
 * resolution where both G7 bounds live (a 10 ms one-way bound and a sub-ms
 * write settle time) without carrying a fixed 100k-bucket array per stream.
 */

import type { LatencySamples } from "./g7-classify.ts";

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

/** The last edge; samples above it land in the final bucket and move `maxMs`. */
export const HISTOGRAM_CEILING_MS = EDGES[EDGES.length - 1] as number;

export class G7Histogram {
	readonly #counts = new Float64Array(EDGES.length);
	#negative = 0;
	#max = 0;

	/** Record one sample in milliseconds. Non-positive samples are ranked, not dropped. */
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

	recordNs(ns: number): void {
		this.record(ns / 1e6);
	}

	get negativeCount(): number {
		return this.#negative;
	}

	snapshot(): LatencySamples {
		return {
			negativeCount: this.#negative,
			bucketUpperMs: EDGES.slice(),
			bucketCounts: Array.from(this.#counts),
			maxMs: this.#max,
		};
	}

	/** Merge another histogram's snapshot in. Same edges by construction. */
	merge(other: LatencySamples): void {
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

/** An empty distribution, for cells that recorded nothing. */
export function emptySamples(): LatencySamples {
	return {
		negativeCount: 0,
		bucketUpperMs: EDGES.slice(),
		bucketCounts: new Array(EDGES.length).fill(0),
		maxMs: 0,
	};
}
