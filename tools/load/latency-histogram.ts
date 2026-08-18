/**
 * Log-linear latency histogram — 32 sub-buckets per octave, so ~3% relative
 * error at every magnitude from 1 ns to ~9 hours.
 *
 * Recording is allocation-free and branch-light: at 100k datagrams/s the
 * histogram itself must not become the thing being measured. Values below 32 ns
 * get their own exact bucket, which keeps the low end honest without a special
 * case in the percentile reader.
 */

const SUB_BITS = 5;
const SUB = 1 << SUB_BITS; // 32
const MAX_OCTAVE = 45; // 2^45 ns ≈ 9.8 hours
const BUCKETS = (MAX_OCTAVE - SUB_BITS + 1) * SUB + SUB;

export type LatencySummary = {
	count: number;
	minNs: number;
	maxNs: number;
	meanNs: number;
	p50Ns: number;
	p90Ns: number;
	p99Ns: number;
	p999Ns: number;
	p9999Ns: number;
	/** Samples that arrived negative — a shared-clock violation, not a latency. */
	negative: number;
};

export type LatencyHistogramJson = {
	counts: number[];
	count: number;
	negative: number;
	minNs: number;
	maxNs: number;
	sumNs: number;
};

function bucketIndex(ns: number): number {
	if (ns < SUB) return ns | 0;
	const octave = Math.floor(Math.log2(ns));
	if (octave > MAX_OCTAVE) return BUCKETS - 1;
	const scale = 2 ** (octave - SUB_BITS);
	const sub = Math.floor(ns / scale) - SUB;
	return (octave - SUB_BITS + 1) * SUB + sub;
}

/** Representative value of a bucket: the midpoint of the range it covers. */
function bucketValue(index: number): number {
	if (index < SUB) return index;
	const octave = Math.floor((index - SUB) / SUB) + SUB_BITS;
	const sub = (index - SUB) % SUB;
	const scale = 2 ** (octave - SUB_BITS);
	return (SUB + sub) * scale + scale / 2;
}

export class LatencyHistogram {
	private readonly counts = new Uint32Array(BUCKETS);
	private total = 0;
	private negativeCount = 0;
	private min = Number.POSITIVE_INFINITY;
	private max = 0;
	private sum = 0;

	/** Record one sample. Negative samples are counted, never bucketed. */
	record(ns: number): void {
		if (!(ns >= 0)) {
			this.negativeCount += 1;
			return;
		}
		const i = bucketIndex(ns);
		this.counts[i] = (this.counts[i] ?? 0) + 1;
		this.total += 1;
		this.sum += ns;
		if (ns < this.min) this.min = ns;
		if (ns > this.max) this.max = ns;
	}

	get count(): number {
		return this.total;
	}

	get negative(): number {
		return this.negativeCount;
	}

	percentile(q: number): number {
		if (this.total === 0) return 0;
		// Nearest-rank: the value at or above which `q` of the samples sit.
		const rank = Math.max(1, Math.ceil(q * this.total));
		let seen = 0;
		for (let i = 0; i < BUCKETS; i += 1) {
			seen += this.counts[i] ?? 0;
			if (seen >= rank) return bucketValue(i);
		}
		return this.max;
	}

	summary(): LatencySummary {
		return {
			count: this.total,
			minNs: this.total === 0 ? 0 : this.min,
			maxNs: this.max,
			meanNs: this.total === 0 ? 0 : this.sum / this.total,
			p50Ns: this.percentile(0.5),
			p90Ns: this.percentile(0.9),
			p99Ns: this.percentile(0.99),
			p999Ns: this.percentile(0.999),
			p9999Ns: this.percentile(0.9999),
			negative: this.negativeCount,
		};
	}

	/** Sparse-ish JSON form; the counts array is 1.4k slots and compresses well. */
	toJson(): LatencyHistogramJson {
		return {
			counts: Array.from(this.counts),
			count: this.total,
			negative: this.negativeCount,
			minNs: this.total === 0 ? 0 : this.min,
			maxNs: this.max,
			sumNs: this.sum,
		};
	}

	static fromJson(json: LatencyHistogramJson): LatencyHistogram {
		const h = new LatencyHistogram();
		for (let i = 0; i < BUCKETS && i < json.counts.length; i += 1) {
			h.counts[i] = json.counts[i] ?? 0;
		}
		h.total = json.count;
		h.negativeCount = json.negative;
		h.min = json.count === 0 ? Number.POSITIVE_INFINITY : json.minNs;
		h.max = json.maxNs;
		h.sum = json.sumNs;
		return h;
	}

	/** Reset in place — a ladder step reuses one histogram across the run. */
	reset(): void {
		this.counts.fill(0);
		this.total = 0;
		this.negativeCount = 0;
		this.min = Number.POSITIVE_INFINITY;
		this.max = 0;
		this.sum = 0;
	}
}

export const HISTOGRAM_BUCKETS = BUCKETS;
export const __testing = { bucketIndex, bucketValue };
