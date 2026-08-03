type MaybePromise<T> = T | Promise<T>;
export type BoundedReadResult<T> =
	| { done: false; value: T }
	| { done: true; value: undefined };
type ReaderLike<T, Args extends unknown[] = []> = {
	read: (...args: Args) => Promise<{ done: boolean; value?: T }>;
	cancel: (reason?: unknown) => PromiseLike<void>;
	releaseLock: () => void;
};
type AsyncSource<T> = AsyncIterable<T> | AsyncIterator<T>;

type Closeable = {
	close: () => MaybePromise<void>;
};

const CLEANUP_CLOSE_TIMEOUT_MS = 1500;
const TIMEOUT_CLEANUP_BUDGET_MS = 250;
const ITERATOR_CLOSE_BUDGET_MS = 2000;
const DEFAULT_WAIT_INTERVAL_MS = 25;

type TimeoutOptions = {
	onTimeout?: () => MaybePromise<void>;
};

export type TestHarness = {
	track<T extends Closeable>(resource: T): T;
	cleanup: () => Promise<void>;
};

export async function sleep(
	delayMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) {
		throw signal.reason ?? new Error("sleep aborted");
	}

	await new Promise<void>((resolve, reject) => {
		const timer = globalThis.setTimeout(() => {
			cleanup();
			resolve();
		}, delayMs);

		const onAbort = () => {
			cleanup();
			reject(signal?.reason ?? new Error("sleep aborted"));
		};

		const cleanup = () => {
			globalThis.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function withTimeout<T>(
	promise: PromiseLike<T>,
	timeoutMs: number,
	label: string,
	options: TimeoutOptions = {},
): Promise<T> {
	let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	const timeoutError = new Error(`timeout after ${timeoutMs}ms: ${label}`);
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = globalThis.setTimeout(() => {
			reject(timeoutError);
			let cleanup: MaybePromise<void> | undefined;
			try {
				cleanup = options.onTimeout?.();
			} catch {
				cleanup = undefined;
			}
			void Promise.race([
				Promise.resolve(cleanup).catch(() => {}),
				sleep(TIMEOUT_CLEANUP_BUDGET_MS).catch(() => {}),
			]).catch(() => {});
		}, timeoutMs);
	});

	try {
		return await Promise.race([Promise.resolve(promise), timeoutPromise]);
	} finally {
		if (timer !== undefined) {
			globalThis.clearTimeout(timer);
		}
	}
}

function monotonicNowMs(): number {
	return globalThis.performance.now();
}

export async function waitFor<T>(
	read: () => T | Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs = 3000,
	pollMs = DEFAULT_WAIT_INTERVAL_MS,
	label = "condition",
): Promise<T> {
	const deadline = monotonicNowMs() + timeoutMs;
	let lastValue!: T;
	while (monotonicNowMs() < deadline) {
		lastValue = await read();
		if (predicate(lastValue)) {
			return lastValue;
		}
		await sleep(pollMs);
	}

	lastValue = await read();
	if (predicate(lastValue)) {
		return lastValue;
	}

	throw new Error(
		`waitFor timed out after ${timeoutMs}ms: ${label} (${String(lastValue)})`,
	);
}

export async function releaseReader<T>(reader: ReaderLike<T>): Promise<void> {
	try {
		reader.releaseLock();
	} catch {
		// Best-effort cleanup only.
	}
}

export async function cancelReader<T>(
	reader: ReaderLike<T>,
	reason = "test timeout",
): Promise<void> {
	try {
		await reader.cancel(reason);
	} catch {
		// Best-effort cleanup only.
	}
}

export async function cleanupReader<T>(
	reader: ReaderLike<T>,
	reason = "test timeout",
): Promise<void> {
	const cancel = cancelReader(reader, reason);
	await releaseReader(reader);
	await cancel;
}

export async function nextWithTimeout<T>(
	iter: AsyncIterator<T>,
	timeoutMs: number,
	label: string,
): Promise<IteratorResult<T>> {
	return withTimeout(iter.next(), timeoutMs, label, {
		onTimeout: async () => {
			try {
				await iter.return?.();
			} catch {
				// Best-effort cleanup only.
			}
		},
	});
}

async function closeIterator(iter: AsyncIterator<unknown>): Promise<void> {
	try {
		await Promise.race([
			Promise.resolve(iter.return?.()),
			sleep(ITERATOR_CLOSE_BUDGET_MS),
		]);
	} catch {
		// Best-effort cleanup only.
	}
}

function toAsyncIterator<T>(source: AsyncSource<T>): AsyncIterator<T> {
	if (Symbol.asyncIterator in source) {
		return source[Symbol.asyncIterator]();
	}
	return source;
}

export async function forEachWithTimeout<T>(
	source: AsyncSource<T>,
	timeoutMs: number,
	label: string,
	visit: (value: T) => MaybePromise<void>,
): Promise<void> {
	const iter = toAsyncIterator(source);
	try {
		while (true) {
			const next = await nextWithTimeout(iter, timeoutMs, label);
			if (next.done || next.value === undefined) {
				return;
			}
			await visit(next.value);
		}
	} finally {
		await closeIterator(iter);
	}
}

export async function collectWithTimeout<T>(
	source: AsyncSource<T>,
	timeoutMs: number,
	label: string,
): Promise<T[]> {
	const values: T[] = [];
	await forEachWithTimeout(source, timeoutMs, label, async (value) => {
		values.push(value);
	});
	return values;
}

export async function readWithTimeout<T, Args extends unknown[] = []>(
	reader: ReaderLike<T, Args>,
	timeoutMs: number,
	label: string,
	...args: Args
): Promise<BoundedReadResult<T>> {
	return (await withTimeout(reader.read(...args), timeoutMs, label, {
		onTimeout: () => cleanupReader(reader, label),
	})) as BoundedReadResult<T>;
}

export function createHarness(): TestHarness {
	const resources: Closeable[] = [];

	return {
		track<T extends Closeable>(resource: T): T {
			resources.push(resource);
			return resource;
		},
		async cleanup(): Promise<void> {
			const pending = resources.splice(0).reverse();
			await Promise.allSettled(
				pending.map(async (resource) => {
					try {
						await withTimeout(
							Promise.resolve(resource.close()),
							CLEANUP_CLOSE_TIMEOUT_MS,
							"resource close during harness cleanup",
						);
					} catch {
						// Best-effort cleanup to avoid masking test failures.
					}
				}),
			);
		},
	};
}

export async function withHarness<T>(
	run: (h: TestHarness) => Promise<T>,
): Promise<T> {
	const h = createHarness();
	try {
		return await run(h);
	} finally {
		await h.cleanup();
	}
}
