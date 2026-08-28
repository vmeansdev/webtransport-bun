import type { G6ServerCoreIntervalScheduler } from "./g6-server-core.ts";

/**
 * Converts a synchronous emitter-timer exception into one caller-owned fatal
 * action. It deliberately does not reinterpret the error as send accounting.
 */
export function createFatalEmitterScheduler(
	base: G6ServerCoreIntervalScheduler,
	onFatal: (error: unknown) => void,
): G6ServerCoreIntervalScheduler {
	let stopped = false;
	let handle: unknown;
	return {
		setInterval: (tick, delayMs) => {
			const guarded = (): void => {
				if (stopped) return;
				try {
					tick();
				} catch (error) {
					stopped = true;
					base.clearInterval(handle);
					onFatal(error);
				}
			};
			handle = base.setInterval(guarded, delayMs);
			return handle;
		},
		clearInterval: (nextHandle) => {
			stopped = true;
			base.clearInterval(nextHandle);
		},
	};
}
