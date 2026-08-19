/**
 * Log-linear latency histogram — 256 sub-buckets per octave, so ≤0.4% relative
 * error at every magnitude from 1 ns to ~9 hours.
 *
 * The resolution is set by what the histogram is asked to resolve, not by
 * taste. The pre-registered H7 A/B calls a `|Δp99|` below 0.2 ms `batch-free`,
 * and Δ is a difference of two independently quantized percentiles, so the
 * bucket width has to stay well under half that band at the percentiles being
 * differenced (tens of ms). At 32 sub-buckets per octave it did not: ~3% of a
 * 15 ms p99 is ±0.45 ms per arm, which is wider than the band it is being
 * compared against. See Amendment 2 in the pre-registration.
 *
 * Recording is allocation-free and branch-light: at 100k datagrams/s the
 * histogram itself must not become the thing being measured. Values below 256
 * ns get their own exact bucket, which keeps the low end honest without a
 * special case in the percentile reader.
 */

const SUB_BITS = 8;
const SUB = 1 << SUB_BITS; // 256
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
	/**
	 * Samples the producer counted but whose buckets this snapshot does not
	 * contain. Non-zero means the snapshot was taken while recording continued;
	 * the percentiles above are of the buckets that were there.
	 */
	skew: number;
};

export type LatencyHistogramJson = {
	/** Bumped when the bucketing or the encoding changes. */
	version: 2;
	/** Bucketing the producer used; a mismatch is a hard read error. */
	subBits: number;
	maxOctave: number;
	/** Non-empty buckets only, `[index, count]`, ascending by index. */
	buckets: [number, number][];
	/** Sum of `buckets`, computed by the producer in the same pass. */
	count: number;
	/**
	 * The producer's running sample counter. Equal to `count` for a quiesced
	 * producer; a gap means the snapshot was taken while recording continued.
	 */
	recordedTotal: number;
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
	/**
	 * What the producer said it recorded. Equal to `total` for a histogram this
	 * process filled; read from the fragment for one another process wrote, where
	 * a gap means its snapshot was taken while recording continued.
	 */
	private recorded = 0;
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
		this.recorded += 1;
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
			skew: this.recorded - this.total,
		};
	}

	/**
	 * Sparse JSON: 9,984 slots of which a latency step fills a few hundred, so
	 * the dense form would be almost all zeros in every artifact.
	 */
	toJson(): LatencyHistogramJson {
		const buckets: [number, number][] = [];
		for (let i = 0; i < BUCKETS; i += 1) {
			const c = this.counts[i] ?? 0;
			if (c > 0) buckets.push([i, c]);
		}
		return {
			version: 2,
			subBits: SUB_BITS,
			maxOctave: MAX_OCTAVE,
			buckets,
			count: this.total,
			recordedTotal: Math.max(this.recorded, this.total),
			negative: this.negativeCount,
			minNs: this.total === 0 ? 0 : this.min,
			maxNs: this.max,
			sumNs: this.sum,
		};
	}

	static fromJson(json: LatencyHistogramJson): LatencyHistogram {
		if (json.subBits !== SUB_BITS || json.maxOctave !== MAX_OCTAVE) {
			throw new Error(
				`histogram bucketing mismatch: fragment has subBits=${json.subBits} maxOctave=${json.maxOctave}, this build reads subBits=${SUB_BITS} maxOctave=${MAX_OCTAVE}`,
			);
		}
		const h = new LatencyHistogram();
		for (const [index, count] of json.buckets) {
			if (index < 0 || index >= BUCKETS) {
				throw new Error(`histogram bucket index out of range: ${index}`);
			}
			h.counts[index] = (h.counts[index] ?? 0) + count;
			h.total += count;
		}
		h.recorded = json.recordedTotal;
		h.negativeCount = json.negative;
		h.min = h.total === 0 ? Number.POSITIVE_INFINITY : json.minNs;
		h.max = json.maxNs;
		h.sum = json.sumNs;
		return h;
	}

	/** Reset in place — a ladder step reuses one histogram across the run. */
	reset(): void {
		this.counts.fill(0);
		this.total = 0;
		this.recorded = 0;
		this.negativeCount = 0;
		this.min = Number.POSITIVE_INFINITY;
		this.max = 0;
		this.sum = 0;
	}
}

export const HISTOGRAM_BUCKETS = BUCKETS;
/**
 * Worst-case absolute quantization error of a reported value: buckets are
 * reported at their midpoint and a bucket is at most `value / SUB` wide.
 */
export function quantizationNs(valueNs: number): number {
	return valueNs / (2 * SUB);
}
export const __testing = { bucketIndex, bucketValue };
