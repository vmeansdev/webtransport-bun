export interface SampleSummary {
	readonly samples: readonly number[];
	readonly count: number;
	readonly mean: number;
	readonly min: number;
	readonly max: number;
	readonly stddev: number;
	readonly standardError: number;
	readonly tCritical95: number;
	readonly marginOfError95: number;
	readonly ci95Low: number;
	readonly ci95High: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
}

function finiteSamples(samples: readonly number[]): number[] {
	if (samples.length === 0)
		throw new RangeError("cannot summarize empty samples");
	if (samples.some((sample) => !Number.isFinite(sample))) {
		throw new RangeError("samples must contain only finite numbers");
	}
	return [...samples];
}

/** Linear-interpolated percentile over a sorted copy; p is in [0, 100]. */
export function percentile(samples: readonly number[], p: number): number {
	const values = finiteSamples(samples);
	if (!Number.isFinite(p) || p < 0 || p > 100) {
		throw new RangeError("percentile must be between 0 and 100");
	}
	values.sort((left, right) => left - right);
	if (values.length === 1) return values[0] as number;
	const rank = (p / 100) * (values.length - 1);
	const lowerIndex = Math.floor(rank);
	const upperIndex = Math.ceil(rank);
	const lower = values[lowerIndex] as number;
	const upper = values[upperIndex] as number;
	return lower + (upper - lower) * (rank - lowerIndex);
}

/** Quantile spelling for callers that naturally use a [0, 1] probability. */
export function quantile(samples: readonly number[], q: number): number {
	if (!Number.isFinite(q) || q < 0 || q > 1) {
		throw new RangeError("quantile must be between 0 and 1");
	}
	return percentile(samples, q * 100);
}

const STUDENT_T_95_TWO_SIDED = [
	NaN,
	12.706,
	4.303,
	3.182,
	2.776,
	2.571,
	2.447,
	2.365,
	2.306,
	2.262,
	2.228,
	2.201,
	2.179,
	2.16,
	2.145,
	2.131,
	2.12,
	2.11,
	2.101,
	2.093,
	2.086,
	2.08,
	2.074,
	2.069,
	2.064,
	2.06,
	2.056,
	2.052,
	2.048,
	2.045,
	2.042,
] as const;

function logGamma(value: number): number {
	const coefficients = [
		676.5203681218851, -1259.1392167224028, 771.3234287776531,
		-176.6150291621406, 12.507343278686905, -0.13857109526572012,
		9.984369578019572e-6, 1.5056327351493116e-7,
	];
	if (value < 0.5) {
		return (
			Math.log(Math.PI) -
			Math.log(Math.sin(Math.PI * value)) -
			logGamma(1 - value)
		);
	}
	let x = 0.9999999999998099;
	const shifted = value - 1;
	for (const [index, coefficient] of coefficients.entries()) {
		x += coefficient / (shifted + index + 1);
	}
	const t = shifted + coefficients.length - 0.5;
	return 0.9189385332046727 + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const continuedFraction = (aa: number, bb: number, xx: number): number => {
		const qab = aa + bb;
		const qap = aa + 1;
		const qam = aa - 1;
		let c = 1;
		let d = 1 - (qab * xx) / qap;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		d = 1 / d;
		let h = d;
		for (let m = 1; m <= 200; m += 1) {
			const m2 = 2 * m;
			let numerator = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
			d = 1 + numerator * d;
			if (Math.abs(d) < 1e-30) d = 1e-30;
			c = 1 + numerator / c;
			if (Math.abs(c) < 1e-30) c = 1e-30;
			d = 1 / d;
			h *= d * c;

			numerator = -((aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
			d = 1 + numerator * d;
			if (Math.abs(d) < 1e-30) d = 1e-30;
			c = 1 + numerator / c;
			if (Math.abs(c) < 1e-30) c = 1e-30;
			d = 1 / d;
			const delta = d * c;
			h *= delta;
			if (Math.abs(delta - 1) < 1e-12) break;
		}
		return h;
	};

	const logFront =
		a * Math.log(x) +
		b * Math.log(1 - x) -
		Math.log(a) -
		(logGamma(a) + logGamma(b) - logGamma(a + b));
	const front = Math.exp(logFront);
	if (x < (a + 1) / (a + b + 2)) {
		return front * continuedFraction(a, b, x);
	}
	return 1 - front * continuedFraction(b, a, 1 - x);
}

function studentsTCdf(value: number, degreesOfFreedom: number): number {
	if (!Number.isFinite(value)) return value < 0 ? 0 : 1;
	if (value === 0) return 0.5;
	const x = degreesOfFreedom / (degreesOfFreedom + value * value);
	const tail = 0.5 * regularizedIncompleteBeta(degreesOfFreedom / 2, 0.5, x);
	return value > 0 ? 1 - tail : tail;
}

/** Two-sided 95% Student-t critical value for a sample count. */
export function studentTCritical95(sampleCount: number): number {
	if (!Number.isSafeInteger(sampleCount) || sampleCount <= 1) return 0;
	const degreesOfFreedom = sampleCount - 1;
	if (degreesOfFreedom < STUDENT_T_95_TWO_SIDED.length) {
		return STUDENT_T_95_TWO_SIDED[degreesOfFreedom] ?? 0;
	}
	const target = 0.975;
	let low = 0;
	let high = 2;
	while (studentsTCdf(high, degreesOfFreedom) < target) high *= 2;
	for (let index = 0; index < 80; index += 1) {
		const mid = (low + high) / 2;
		if (studentsTCdf(mid, degreesOfFreedom) >= target) high = mid;
		else low = mid;
	}
	return Number(high.toFixed(6));
}

export function sampleSummary(input: readonly number[]): SampleSummary {
	const samples = finiteSamples(input);
	const count = samples.length;
	const mean = samples.reduce((sum, value) => sum + value, 0) / count;
	const variance =
		count > 1
			? samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
				(count - 1)
			: 0;
	const stddev = Math.sqrt(variance);
	const standardError = count > 1 ? stddev / Math.sqrt(count) : 0;
	const tCritical95 = studentTCritical95(count);
	const marginOfError95 = tCritical95 * standardError;
	return {
		samples,
		count,
		mean,
		min: Math.min(...samples),
		max: Math.max(...samples),
		stddev,
		standardError,
		tCritical95,
		marginOfError95,
		ci95Low: mean - marginOfError95,
		ci95High: mean + marginOfError95,
		p50: percentile(samples, 50),
		p95: percentile(samples, 95),
		p99: percentile(samples, 99),
	};
}

export const summarizeSamples = sampleSummary;
