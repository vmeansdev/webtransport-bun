import { describe, expect, test } from "bun:test";
import { createFatalEmitterScheduler } from "./g6-fatal-emitter.ts";

describe("G6 fatal emitter scheduler", () => {
	test("reports a timer throw once and clears its timer", () => {
		const ticks: Array<() => void> = [];
		const cleared: unknown[] = [];
		const fatal: unknown[] = [];
		const scheduler = createFatalEmitterScheduler(
			{
				setInterval: (tick) => {
					ticks.push(tick);
					return 41;
				},
				clearInterval: (handle) => cleared.push(handle),
			},
			(error) => fatal.push(error),
		);

		scheduler.setInterval(() => {
			throw new Error("mirror contract broken");
		}, 20);
		ticks[0]?.();
		ticks[0]?.();

		expect(cleared).toEqual([41]);
		expect(fatal).toHaveLength(1);
		expect(fatal[0]).toBeInstanceOf(Error);
		expect((fatal[0] as Error).message).toBe("mirror contract broken");
	});
});
