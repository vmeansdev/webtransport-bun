import { describe, expect, test } from "bun:test";
import {
	type ArmSummary,
	armKey,
	collapseFor,
	generatorLimitedRates,
	proofFailures,
} from "./worker-load-sweep.ts";
import { formatGapLine } from "./worker-thread-parallelism-probe.ts";

function arm(over: Partial<ArmSummary> = {}): ArmSummary {
	const base: ArmSummary = {
		key: "w1@20000",
		workers: "1",
		requestedPerSec: 20_000,
		offeredPerSec: 19_800,
		deliveredPerSec: 19_700,
		ingestedPerSec: 19_750,
		droppedPct: 0,
		droppedTooLarge: 0,
		droppedQueueSession: 0,
		droppedQueueGlobal: 0,
		droppedRateLimited: 0,
		processCores: 1.1,
		tokioCores: 0.6,
		jsCores: 0.3,
		datagramThreads: 1,
		configuredWorkers: 1,
		requestMet: true,
		runs: [],
	};
	const merged = { ...base, ...over };
	return { ...merged, key: armKey(merged) };
}

describe("collapseFor", () => {
	test("delivered falling by more than half beyond the peak is a collapse", () => {
		const summaries = [
			arm({
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 78_000,
			}),
			arm({
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 5_000,
			}),
		];
		const result = collapseFor(summaries, "1");
		expect(result.collapsed).toBe(true);
		expect(result.peakPerSec).toBe(78_000);
		expect(result.worstPerSec).toBe(5_000);
	});

	test("a plateau is not a collapse", () => {
		const summaries = [
			arm({
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 60_000,
			}),
			arm({
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 61_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(false);
	});

	test("a modest fall-off short of half is not called a collapse", () => {
		const summaries = [
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 60_000,
			}),
			arm({
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 40_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(false);
	});

	test("only rungs offered more than the peak can show a fall-off", () => {
		// Highest delivered is also the highest offered: nothing beyond it.
		const summaries = [
			arm({
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 5_000,
			}),
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 79_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(false);
	});

	test("separates worker counts", () => {
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				workers: "1",
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 2_000,
			}),
			arm({
				workers: "2",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				workers: "2",
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 155_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(true);
		expect(collapseFor(summaries, "2").collapsed).toBe(false);
	});
});

describe("generatorLimitedRates", () => {
	test("flags a rung whose offered load is pinned and short of the request", () => {
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 160_000,
				offeredPerSec: 65_200,
				requestMet: false,
			}),
			arm({
				workers: "2",
				requestedPerSec: 160_000,
				offeredPerSec: 65_400,
				requestMet: false,
			}),
		];
		expect(generatorLimitedRates(summaries)).toEqual([160_000]);
	});

	test("does not flag a rung whose request was met", () => {
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				requestMet: true,
			}),
			arm({
				workers: "2",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				requestMet: true,
			}),
		];
		expect(generatorLimitedRates(summaries)).toEqual([]);
	});

	test("does not flag when offered load differs by worker count", () => {
		// The server is influencing what the sender achieves, so the shortfall is
		// not simply the generator's own ceiling.
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 160_000,
				offeredPerSec: 70_000,
				requestMet: false,
			}),
			arm({
				workers: "2",
				requestedPerSec: 160_000,
				offeredPerSec: 140_000,
				requestMet: false,
			}),
		];
		expect(generatorLimitedRates(summaries)).toEqual([]);
	});
});

describe("gap print", () => {
	test("omitted UDP rcvbuf prints n/a, not 0", () => {
		expect(
			formatGapLine({
				windowOfferedPerSec: null,
				ingestedPerSec: 99_000,
				packetsLostDelta: null,
				packetsReceivedDelta: null,
				udpInErrorsDelta: null,
				udpRcvbufErrorsDelta: null,
				unexplainedPerSec: 48_000,
				stopBucket: "unexplained",
			}),
		).toBe(
			"gap: windowOffered=n/a ingest=99000 lost=n/a rcvbuf=n/a unexplained=48000 STOP=unexplained",
		);
	});
});

describe("proofFailures", () => {
	test("a matching arm passes", () => {
		expect(proofFailures([arm()])).toEqual([]);
		expect(
			proofFailures([
				arm({ workers: "2", configuredWorkers: 2, datagramThreads: 2 }),
			]),
		).toEqual([]);
	});

	test("catches a two-worker arm whose load landed on one thread", () => {
		const failures = proofFailures([
			arm({ workers: "2", configuredWorkers: 2, datagramThreads: 1 }),
		]);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("one OS thread");
	});

	test("catches the runtime ignoring the requested worker count", () => {
		const failures = proofFailures([
			arm({ workers: "2", configuredWorkers: 1 }),
		]);
		expect(failures.some((f) => f.includes("expected 2"))).toBe(true);
	});

	test("catches a non-finite delivered rate", () => {
		const failures = proofFailures([arm({ deliveredPerSec: Number.NaN })]);
		expect(failures.some((f) => f.includes("non-finite"))).toBe(true);
	});

	test("refuses when the addon has no worker probe", () => {
		expect(proofFailures([arm({ configuredWorkers: null })])[0]).toContain(
			"no worker-probe snapshot",
		);
	});
});
