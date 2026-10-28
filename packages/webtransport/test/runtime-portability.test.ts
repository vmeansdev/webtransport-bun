import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createMonotonicDeadline,
	sleep,
	withDeadline,
} from "../src/deadline.js";

describe("runtime-portable deadline helpers", () => {
	const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const originalAbortController = globalThis.AbortController;
	const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
	const clearedTimers = new Set<ReturnType<typeof setTimeout>>();

	function listSourceFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = `${dir}${entry.name}`;
			if (entry.isDirectory()) {
				return listSourceFiles(`${path}/`);
			}
			return entry.isFile() && path.endsWith(".ts") ? [path] : [];
		});
	}

	afterEach(() => {
		for (const timer of pendingTimers) {
			originalClearTimeout(timer);
		}
		pendingTimers.clear();
		clearedTimers.clear();
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		globalThis.AbortController = originalAbortController;
	});

	function installTimerSpies(): void {
		globalThis.setTimeout = ((
			handler: Parameters<typeof setTimeout>[0],
			timeout?: number,
		) => {
			const timer = originalSetTimeout(() => {
				pendingTimers.delete(timer);
				if (typeof handler === "function") {
					handler();
				}
			}, timeout);
			pendingTimers.add(timer);
			return timer;
		}) as typeof setTimeout;

		globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
			clearedTimers.add(timer);
			pendingTimers.delete(timer);
			return originalClearTimeout(timer);
		}) as typeof clearTimeout;
	}

	it("sleep resolves early when aborted and clears its timer", async () => {
		installTimerSpies();
		const controller = new AbortController();
		const sleepPromise = sleep(1_000, controller.signal);

		controller.abort(new Error("stop"));

		await expect(sleepPromise).rejects.toThrow("stop");
		expect(clearedTimers.size).toBe(1);
		expect(pendingTimers.size).toBe(0);
	});

	it("withDeadline returns early results and clears its timeout", async () => {
		installTimerSpies();

		const result = await withDeadline(Promise.resolve("ready"), 1_000, {
			timeoutMessage: "timed out",
		});

		expect(result).toBe("ready");
		expect(clearedTimers.size).toBe(1);
		expect(pendingTimers.size).toBe(0);
	});

	it("withDeadline rejects on timeout and clears its timeout", async () => {
		installTimerSpies();

		await expect(
			withDeadline(new Promise<never>(() => {}), 1, {
				timeoutMessage: "timed out",
			}),
		).rejects.toThrow("timed out");
		expect(clearedTimers.size).toBe(1);
		expect(pendingTimers.size).toBe(0);
	});

	it("withDeadline rejects on abort and clears its timeout", async () => {
		installTimerSpies();
		const controller = new AbortController();
		const pending = new Promise<never>(() => {});
		const deadlinePromise = withDeadline(pending, 1_000, {
			signal: controller.signal,
			timeoutMessage: "timed out",
		});

		controller.abort(new Error("abort requested"));

		await expect(deadlinePromise).rejects.toThrow("abort requested");
		expect(clearedTimers.size).toBe(1);
		expect(pendingTimers.size).toBe(0);
	});

	it("monotonic deadlines ignore wall-clock jumps", () => {
		let monotonicNow = 1_000;
		const deadline = createMonotonicDeadline(100, () => monotonicNow);

		const originalDateNow = Date.now;
		Date.now = () => Number.MAX_SAFE_INTEGER;
		try {
			monotonicNow += 25;
			expect(deadline.remainingMs()).toBe(75);
			expect(deadline.expired()).toBe(false);

			monotonicNow += 75;
			expect(deadline.remainingMs()).toBe(0);
			expect(deadline.expired()).toBe(true);
		} finally {
			Date.now = originalDateNow;
		}
	});

	it("source policy keeps production src free of Bun.sleep", () => {
		const offenders = listSourceFiles(srcRoot).filter((path) =>
			readFileSync(path, "utf8").includes("Bun.sleep"),
		);

		expect(offenders).toEqual([]);
	});
});
