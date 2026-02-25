import { connect, WebTransport } from "../../src/index.js";

const rangeOffsets = new Map<string, number>();
const reservedPorts = new Set<number>();
const seed = ((Date.now() & 0xffff) ^ ((process.pid & 0xffff) << 4)) >>> 0;

export function nextPort(base: number, spread: number): number {
	if (!Number.isInteger(base) || !Number.isInteger(spread) || spread <= 0) {
		throw new Error(`nextPort: invalid range base=${base} spread=${spread}`);
	}

	const key = `${base}:${spread}`;
	let start = rangeOffsets.get(key);
	if (start === undefined) {
		start = seed % spread;
	}

	for (let i = 0; i < spread; i++) {
		const candidate = base + ((start + i) % spread);
		if (!reservedPorts.has(candidate)) {
			reservedPorts.add(candidate);
			rangeOffsets.set(key, (start + i + 1) % spread);
			return candidate;
		}
	}

	// Fallback if a small range is exhausted by long-running stress loops.
	return base + Math.floor(Math.random() * spread);
}

export async function connectWithRetry(
	url: string,
	opts: Parameters<typeof connect>[1],
	timeoutMs = 6000,
	retryDelayMs = 100,
): Promise<Awaited<ReturnType<typeof connect>>> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return await connect(url, opts);
		} catch (err) {
			lastErr = err;
			await Bun.sleep(retryDelayMs);
		}
	}
	throw lastErr ?? new Error("connectWithRetry: timed out");
}

export async function openWTWithRetry(
	url: string,
	opts: ConstructorParameters<typeof WebTransport>[1],
	timeoutMs = 10000,
	retryDelayMs = 100,
): Promise<WebTransport> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		const wt = new WebTransport(url, opts);
		try {
			await wt.ready;
			return wt;
		} catch (err) {
			lastErr = err;
			wt.close();
			await Bun.sleep(retryDelayMs);
		}
	}
	throw lastErr ?? new Error("openWTWithRetry: timed out");
}
