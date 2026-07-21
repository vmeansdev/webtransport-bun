import { E_BACKPRESSURE_TIMEOUT, WebTransportError } from "./errors.js";

export type DeadlineOptions = {
	signal?: AbortSignal;
	timeoutMessage?: string;
	timeoutReason?: unknown;
};

export type MonotonicDeadline = {
	timeoutMs: number;
	expired(): boolean;
	remainingMs(): number;
};

function monotonicNowMs(): number {
	return globalThis.performance.now();
}

export function createMonotonicDeadline(
	timeoutMs: number,
	nowMs: () => number = monotonicNowMs,
): MonotonicDeadline {
	const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
	const deadlineMs = nowMs() + normalizedTimeoutMs;
	const remainingMs = () => Math.max(0, deadlineMs - nowMs());
	return {
		timeoutMs: normalizedTimeoutMs,
		expired: () => remainingMs() === 0,
		remainingMs,
	};
}

function normalizeAbortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Operation aborted");
}

function normalizeTimeoutReason(
	timeoutMs: number,
	options?: Pick<DeadlineOptions, "timeoutMessage" | "timeoutReason">,
): unknown {
	if (options?.timeoutReason !== undefined) {
		return options.timeoutReason;
	}
	return new WebTransportError(
		E_BACKPRESSURE_TIMEOUT,
		options?.timeoutMessage ??
			`E_BACKPRESSURE_TIMEOUT: operation timed out after ${timeoutMs}ms`,
	);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const timeoutMs = Math.max(0, Math.floor(ms));
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(normalizeAbortReason(signal));
			return;
		}

		let settled = false;
		let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

		const cleanup = () => {
			if (timer !== null) {
				globalThis.clearTimeout(timer);
				timer = null;
			}
			signal?.removeEventListener("abort", onAbort);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(normalizeAbortReason(signal as AbortSignal));
		};

		timer = globalThis.setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		}, timeoutMs);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function withDeadline<T>(
	value: Promise<T> | T,
	timeoutMs: number,
	options?: DeadlineOptions,
): Promise<T> {
	const clampedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
	return new Promise<T>((resolve, reject) => {
		if (options?.signal?.aborted) {
			reject(normalizeAbortReason(options.signal));
			return;
		}

		let settled = false;
		let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

		const cleanup = () => {
			if (timer !== null) {
				globalThis.clearTimeout(timer);
				timer = null;
			}
			options?.signal?.removeEventListener("abort", onAbort);
		};

		const settle = (cb: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			cb();
		};

		const onAbort = () => {
			settle(() =>
				reject(normalizeAbortReason(options?.signal as AbortSignal)),
			);
		};

		timer = globalThis.setTimeout(() => {
			settle(() => reject(normalizeTimeoutReason(clampedTimeoutMs, options)));
		}, clampedTimeoutMs);

		options?.signal?.addEventListener("abort", onAbort, { once: true });

		Promise.resolve(value).then(
			(result) => settle(() => resolve(result)),
			(error) => settle(() => reject(error)),
		);
	});
}
