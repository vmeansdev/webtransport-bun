type MaybePromise<T> = T | Promise<T>;

type Closeable = {
	close: () => MaybePromise<void>;
};

const CLEANUP_CLOSE_TIMEOUT_MS = 1500;

export type TestHarness = {
	track<T extends Closeable>(resource: T): T;
	cleanup: () => Promise<void>;
};

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
						await Promise.race([
							Promise.resolve(resource.close()),
							Bun.sleep(CLEANUP_CLOSE_TIMEOUT_MS),
						]);
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
