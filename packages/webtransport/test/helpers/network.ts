import { connect, WebTransport } from "../../src/index.js";

export function nextPort(base: number, spread: number): number {
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
