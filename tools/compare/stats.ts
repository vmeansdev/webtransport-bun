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
	const fraction = rank - lowerIndex;
	const result =
		lower === upper ? lower : lower * (1 - fraction) + upper * fraction;
	if (!Number.isFinite(result)) {
		throw new RangeError("percentile result is non-finite");
	}
	return result;
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
	if (!Number.isSafeInteger(sampleCount) || sampleCount < 2) {
		throw new RangeError("sample count must be a safe integer of at least 2");
	}
	const degreesOfFreedom = sampleCount - 1;
	if (degreesOfFreedom < STUDENT_T_95_TWO_SIDED.length) {
		return STUDENT_T_95_TWO_SIDED[degreesOfFreedom] ?? 0;
	}
	// The incomplete-beta evaluation is useful for ordinary sample sizes but
	// loses precision when the degrees of freedom approach the safe-integer
	// ceiling.  Use the standard Student-t -> normal expansion in that range;
	// its correction terms remain finite and preserve the six-decimal output
	// contract without pretending that a huge count has exact distribution
	// arithmetic available in JavaScript.
	if (degreesOfFreedom >= 1_000_000) {
		const z = 1.959963984540054;
		const inverseDf = 1 / degreesOfFreedom;
		const inverseDfSquared = inverseDf * inverseDf;
		const inverseDfCubed = inverseDfSquared * inverseDf;
		const approximation =
			z +
			((z ** 3 + z) / 4) * inverseDf +
			((5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96) * inverseDfSquared +
			((3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384) *
				inverseDfCubed;
		if (!Number.isFinite(approximation)) {
			throw new RangeError("Student-t critical value is non-finite");
		}
		return Number(approximation.toFixed(6));
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
	const scale = samples.reduce(
		(current, value) => Math.max(current, Math.abs(value)),
		0,
	);
	const normalizedMean =
		scale === 0
			? 0
			: samples.reduce((sum, value) => sum + value / scale, 0) / count;
	const mean = scale * normalizedMean;
	const normalizedVariance =
		count > 1 && scale > 0
			? samples.reduce(
					(sum, value) => sum + (value / scale - normalizedMean) ** 2,
					0,
				) /
				(count - 1)
			: 0;
	const stddev = scale * Math.sqrt(normalizedVariance);
	const standardError = count > 1 ? stddev / Math.sqrt(count) : 0;
	const tCritical95 = count > 1 ? studentTCritical95(count) : 0;
	const marginOfError95 = tCritical95 * standardError;
	const p50 = percentile(samples, 50);
	const p95 = percentile(samples, 95);
	const p99 = percentile(samples, 99);
	const min = samples.reduce((current, value) => Math.min(current, value));
	const max = samples.reduce((current, value) => Math.max(current, value));
	const result: SampleSummary = {
		samples,
		count,
		mean,
		min,
		max,
		stddev,
		standardError,
		tCritical95,
		marginOfError95,
		ci95Low: mean - marginOfError95,
		ci95High: mean + marginOfError95,
		p50,
		p95,
		p99,
	};
	const numericResults = [
		result.mean,
		result.min,
		result.max,
		result.stddev,
		result.standardError,
		result.tCritical95,
		result.marginOfError95,
		result.ci95Low,
		result.ci95High,
		result.p50,
		result.p95,
		result.p99,
	];
	if (numericResults.some((value) => !Number.isFinite(value))) {
		throw new RangeError("sample summary result is non-finite or overflowed");
	}
	return result;
}

export const summarizeSamples = sampleSummary;
