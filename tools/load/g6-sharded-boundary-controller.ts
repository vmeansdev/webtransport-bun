type PendingBoundary<T> = {
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
};

/** Owns a shard's boundary waits and makes a post-ready failure fail closed. */
export function createShardBoundaryController<T>() {
	const pending: PendingBoundary<T>[] = [];
	let failure: unknown = null;
	return {
		wait: (): Promise<T> => {
			if (failure !== null) return Promise.reject(failure);
			return new Promise<T>((resolve, reject) =>
				pending.push({ resolve, reject }),
			);
		},
		resolve: (value: T): void => {
			pending.shift()?.resolve(value);
		},
		fail: (error: unknown): void => {
			if (failure !== null) return;
			failure = error;
			for (const entry of pending.splice(0)) entry.reject(error);
		},
		finalize: async (
			markers: readonly Promise<unknown>[],
			writeArtifact: () => void,
		): Promise<void> => {
			if (failure !== null) throw failure;
			await Promise.all(markers);
			if (failure !== null) throw failure;
			writeArtifact();
		},
	};
}
