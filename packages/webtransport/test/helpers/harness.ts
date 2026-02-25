type MaybePromise<T> = T | Promise<T>;

type Closeable = {
	close: () => MaybePromise<void>;
};

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
			while (resources.length > 0) {
				const resource = resources.pop();
				if (!resource) continue;
				try {
					await resource.close();
				} catch {
					// Best-effort cleanup to avoid masking test failures.
				}
			}
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
