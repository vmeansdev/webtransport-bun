const DEFAULT_INTEROP_HOST = "127.0.0.1";
const DEFAULT_INTEROP_QUIC_PORT = 4433;
const DEFAULT_INTEROP_HEALTH_PORT = 4434;

export function resolveInteropHost(): string {
	return process.env.WEBTRANSPORT_INTEROP_HOST ?? DEFAULT_INTEROP_HOST;
}

export function resolveInteropQuicPort(): number {
	return Number(
		process.env.WEBTRANSPORT_INTEROP_QUIC_PORT ?? DEFAULT_INTEROP_QUIC_PORT,
	);
}

export function resolveInteropHealthPort(): number {
	return Number(
		process.env.WEBTRANSPORT_INTEROP_HEALTH_PORT ?? DEFAULT_INTEROP_HEALTH_PORT,
	);
}

export function resolveInteropOrigin(): string {
	return `https://${resolveInteropHost()}:${resolveInteropQuicPort()}`;
}

export function resolveInteropHealthUrl(path = "/"): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `http://${resolveInteropHost()}:${resolveInteropHealthPort()}${normalizedPath}`;
}

type IdleDeadline = () => number;

export type MonotonicDeadline = {
	remainingMs: () => number;
	expired: () => boolean;
};

type SharedDeadline = IdleDeadline | MonotonicDeadline;

function monotonicNowMs(): number {
	return performance.now();
}

export function createMonotonicDeadline(
	timeoutMs: number,
	now: () => number = monotonicNowMs,
): MonotonicDeadline {
	const deadlineMs = now() + timeoutMs;
	return {
		remainingMs: () => Math.max(0, deadlineMs - now()),
		expired: () => deadlineMs <= now(),
	};
}

function remainingDeadlineMs(deadline: SharedDeadline): number {
	return typeof deadline === "function"
		? Math.max(0, deadline() - monotonicNowMs())
		: Math.max(0, deadline.remainingMs());
}

function scheduleDeadline(
	timeoutMs: number,
	onTimeout: () => void,
	idleDeadline?: SharedDeadline,
): () => void {
	const operationDeadline = createMonotonicDeadline(timeoutMs);
	const effectiveDelayMs = idleDeadline
		? Math.min(
				operationDeadline.remainingMs(),
				remainingDeadlineMs(idleDeadline),
			)
		: operationDeadline.remainingMs();
	const timer = setTimeout(onTimeout, effectiveDelayMs);
	return () => {
		clearTimeout(timer);
	};
}

export async function nextWithTimeout<T>(
	iter: AsyncIterator<T>,
	timeoutMs: number,
	label: string,
	idleDeadline?: SharedDeadline,
): Promise<IteratorResult<T>> {
	let clearDeadline = () => {};
	try {
		return await Promise.race([
			iter.next(),
			new Promise<never>((_, reject) => {
				clearDeadline = scheduleDeadline(
					timeoutMs,
					() => {
						reject(new Error(`timeout after ${timeoutMs}ms: ${label}`));
						try {
							const close = iter.return?.bind(iter);
							if (close) {
								void Promise.resolve(close()).catch(() => {});
							}
						} catch {
							// Best-effort iterator cleanup only.
						}
					},
					idleDeadline,
				);
			}),
		]);
	} finally {
		clearDeadline();
	}
}

export async function readWithTimeout<T>(
	reader: ReadableStreamDefaultReader<T>,
	timeoutMs: number,
	label: string,
	idleDeadline?: SharedDeadline,
) {
	let clearDeadline = () => {};
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				clearDeadline = scheduleDeadline(
					timeoutMs,
					() => {
						reject(new Error(`timeout after ${timeoutMs}ms: ${label}`));
						try {
							const cancel = reader.cancel?.bind(reader);
							if (cancel) {
								void Promise.resolve(cancel(label)).catch(() => {});
							}
						} catch {
							// Best-effort browser cleanup only.
						}
					},
					idleDeadline,
				);
			}),
		]);
	} finally {
		clearDeadline();
	}
}

export async function promiseWithTimeout<T>(
	promise: PromiseLike<T>,
	timeoutMs: number,
	label: string,
	idleDeadline?: SharedDeadline,
): Promise<T> {
	let clearDeadline = () => {};
	try {
		return await Promise.race([
			Promise.resolve(promise),
			new Promise<never>((_, reject) => {
				clearDeadline = scheduleDeadline(
					timeoutMs,
					() => reject(new Error(`timeout after ${timeoutMs}ms: ${label}`)),
					idleDeadline,
				);
			}),
		]);
	} finally {
		clearDeadline();
	}
}

export async function fetchWithTimeout(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	timeoutMs: number,
	label: string,
	idleDeadline?: SharedDeadline,
): Promise<Response> {
	const controller = new AbortController();
	const externalSignal = init?.signal;
	const onExternalAbort = () => {
		controller.abort(
			externalSignal?.reason ?? new Error(`aborted before ${label}`),
		);
	};
	if (externalSignal?.aborted) {
		onExternalAbort();
	}
	externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	const clearDeadline = scheduleDeadline(
		timeoutMs,
		() => {
			if (!controller.signal.aborted) {
				controller.abort(new Error(`timeout after ${timeoutMs}ms: ${label}`));
			}
		},
		idleDeadline,
	);

	try {
		return await fetch(input, {
			...init,
			signal: controller.signal,
		});
	} catch (error) {
		throw controller.signal.aborted
			? (controller.signal.reason ?? error)
			: error;
	} finally {
		clearDeadline();
		externalSignal?.removeEventListener("abort", onExternalAbort);
	}
}

export const BROWSER_READ_WITH_TIMEOUT_SOURCE = `(() => {
	const monotonicNowMs = ${monotonicNowMs.toString()};
	const createMonotonicDeadline = ${createMonotonicDeadline.toString()};
	const remainingDeadlineMs = ${remainingDeadlineMs.toString()};
	const scheduleDeadline = ${scheduleDeadline.toString()};
	return ${readWithTimeout.toString()};
})()`;
export const BROWSER_PROMISE_WITH_TIMEOUT_SOURCE = `(() => {
	const monotonicNowMs = ${monotonicNowMs.toString()};
	const createMonotonicDeadline = ${createMonotonicDeadline.toString()};
	const remainingDeadlineMs = ${remainingDeadlineMs.toString()};
	const scheduleDeadline = ${scheduleDeadline.toString()};
	return ${promiseWithTimeout.toString()};
})()`;
export const BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT = `
	globalThis.__wtReadWithTimeout = ${BROWSER_READ_WITH_TIMEOUT_SOURCE};
	globalThis.__wtWithTimeout = ${BROWSER_PROMISE_WITH_TIMEOUT_SOURCE};
`;
