import { describe, expect, test } from "bun:test";

import { classify, type ThreadRow, threadRows } from "./thread-profile.ts";

const WORKER = "wt-server#ThreadId(12)";
const JS = "unnamed#ThreadId(1)";

describe("threadRows", () => {
	test("differences the window and converts nanos to fractions of a core", () => {
		const before = {
			[`cpuNanos:${WORKER}`]: 1_000_000_000,
			[`thread:${WORKER}`]: 100,
		};
		const after = {
			[`cpuNanos:${WORKER}`]: 11_000_000_000,
			[`thread:${WORKER}`]: 1_100,
		};
		// 10s of thread CPU over a 20s window is half a core.
		const [row] = threadRows(before, after, 20_000);
		expect(row?.cores).toBeCloseTo(0.5, 6);
		expect(row?.datagrams).toBe(1_000);
	});

	test("a thread absent from the before snapshot counts from zero", () => {
		const [row] = threadRows({}, { [`cpuNanos:${JS}`]: 5_000_000_000 }, 10_000);
		expect(row?.cores).toBeCloseTo(0.5, 6);
	});

	test("drops threads that burned no CPU and carried no datagrams", () => {
		const rows = threadRows(
			{},
			{ [`cpuNanos:${JS}`]: 0, [`thread:${JS}`]: 0 },
			10_000,
		);
		expect(rows).toEqual([]);
	});

	test("sorts hottest first, so the pinned thread is the first row", () => {
		const rows = threadRows(
			{},
			{
				[`cpuNanos:${WORKER}`]: 2_000_000_000,
				[`cpuNanos:${JS}`]: 9_000_000_000,
			},
			10_000,
		);
		expect(rows.map((r) => r.label)).toEqual([JS, WORKER]);
	});

	test("attributes rate-limit time per thread", () => {
		const [row] = threadRows(
			{ [`rateLimitNanos:${WORKER}`]: 1_000_000_000 },
			{
				[`cpuNanos:${WORKER}`]: 10_000_000_000,
				[`rateLimitNanos:${WORKER}`]: 3_000_000_000,
				[`rateLimitCalls:${WORKER}`]: 500,
			},
			10_000,
		);
		expect(row?.rateLimitCores).toBeCloseTo(0.2, 6);
		expect(row?.rateLimitCalls).toBe(500);
	});
});

describe("classify", () => {
	const row = (over: Partial<ThreadRow>): ThreadRow => ({
		label: JS,
		datagrams: 0,
		cores: 1,
		rateLimitCores: 0,
		rateLimitCalls: 0,
		...over,
	});

	test("a thread that polled datagrams is a tokio worker", () => {
		expect(classify(row({ label: WORKER, datagrams: 5 }))).toBe("tokio-worker");
	});

	test("a named wt-server thread is a worker even in a window it polled none", () => {
		expect(classify(row({ label: WORKER, datagrams: 0 }))).toBe("tokio-worker");
	});

	test("a hot thread that never polled a datagram is the JS thread", () => {
		expect(classify(row({}))).toBe("js-thread");
	});
});
