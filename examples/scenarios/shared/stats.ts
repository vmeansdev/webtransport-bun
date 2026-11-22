/** Nearest-rank percentile of an unsorted sample, in the sample's unit. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function round(value: number, digits = 2): number {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
}

/** Parse `--name=value` flags; missing flags fall back to the defaults. */
export function flags<T extends Record<string, string | number>>(
	defaults: T,
): T {
	const out: Record<string, string | number> = { ...defaults };
	for (const arg of process.argv.slice(2)) {
		const match = /^--([^=]+)=(.*)$/.exec(arg);
		if (!match) continue;
		const [, key, raw] = match as unknown as [string, string, string];
		if (!(key in defaults)) throw new Error(`unknown flag --${key}`);
		out[key] = typeof defaults[key] === "number" ? Number(raw) : raw;
	}
	return out as T;
}
