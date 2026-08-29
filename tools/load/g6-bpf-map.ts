type BpfMapEntry = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function entries(raw: string): BpfMapEntry[] | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) &&
			parsed.every((entry) => record(entry) !== null)
			? (parsed as BpfMapEntry[])
			: null;
	} catch {
		return null;
	}
}

// `bpftool -j` emits either BTF-decoded numbers (also under `formatted`) or
// raw little-endian octet arrays when BTF association was lost during pinning.
// Accept only those two documented representations.
function decodeBpfInteger(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? value : null;
	}
	if (!Array.isArray(value)) return null;
	let decoded = 0;
	for (let index = 0; index < value.length; index += 1) {
		const byte = value[index];
		if (typeof byte !== "string" || !/^0x[0-9a-f]{2}$/i.test(byte)) {
			return null;
		}
		decoded += Number.parseInt(byte, 16) * 256 ** index;
		if (!Number.isSafeInteger(decoded)) return null;
	}
	return decoded;
}

function formattedOrRaw(entry: BpfMapEntry, property: string): unknown {
	return record(entry.formatted)?.[property] ?? entry[property];
}

export function sumPerCpuSteerStats(
	raw: string,
): { steered: number; fallback: number } | null {
	let steered = 0;
	let fallback = 0;
	let sawSteered = false;
	let sawFallback = false;
	const dump = entries(raw);
	if (dump === null) return null;
	for (const entry of dump) {
		const key = decodeBpfInteger(formattedOrRaw(entry, "key"));
		const values = formattedOrRaw(entry, "values");
		if ((key !== 0 && key !== 1) || !Array.isArray(values)) return null;
		let total = 0;
		for (const cpuValue of values) {
			const value = decodeBpfInteger(record(cpuValue)?.value);
			if (value === null) return null;
			total += value;
			if (!Number.isSafeInteger(total)) return null;
		}
		if (key === 0) {
			steered += total;
			sawSteered = true;
		} else {
			fallback += total;
			sawFallback = true;
		}
	}
	return sawSteered && sawFallback ? { steered, fallback } : null;
}

export function countBpfMapEntries(raw: string): number | null {
	const dump = entries(raw);
	if (dump === null) return null;
	let populated = 0;
	for (const entry of dump) {
		if (decodeBpfInteger(formattedOrRaw(entry, "key")) === null) return null;
		if (decodeBpfInteger(formattedOrRaw(entry, "value")) !== null) {
			populated += 1;
			continue;
		}
		if (typeof record(entry.value)?.error === "string") continue;
		return null;
	}
	return populated;
}
