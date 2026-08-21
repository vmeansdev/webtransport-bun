import { describe, expect, test } from "bun:test";
import { emptySnapshot, percentileMs } from "./g11-histogram.ts";
import {
	type ClientSummary,
	compositeShardChild,
	mergeClientSummaries,
	mergeLatencySnapshots,
	shardPlan,
} from "./g11-shard.ts";

describe("shardPlan", () => {
	test("one shard when the fleet fits one process", () => {
		expect(shardPlan(50, 50)).toEqual([{ base: 0, sessions: 50 }]);
		expect(shardPlan(1, 50)).toEqual([{ base: 0, sessions: 1 }]);
	});

	test("T-100 at the measured 50-session ceiling is two even shards", () => {
		expect(shardPlan(100, 50)).toEqual([
			{ base: 0, sessions: 50 },
			{ base: 50, sessions: 50 },
		]);
	});

	test("uneven fleets split contiguously, sizes within one", () => {
		const slices = shardPlan(101, 50);
		expect(slices.map((s) => s.sessions)).toEqual([34, 34, 33]);
		expect(slices.map((s) => s.base)).toEqual([0, 34, 68]);
		expect(slices.reduce((acc, s) => acc + s.sessions, 0)).toBe(101);
	});

	test("refuses a non-positive per-shard cap", () => {
		expect(() => shardPlan(100, 0)).toThrow();
	});
});

function snapshotWith(samplesMs: number[]) {
	const s = emptySnapshot();
	for (const ms of samplesMs) {
		if (ms <= 0) {
			s.negativeCount += 1;
			continue;
		}
		// Place each sample in the first bucket whose upper edge holds it, the
		// way the histogram would.
		const idx = s.bucketUpperMs.findIndex((edge) => ms <= edge);
		const at = idx === -1 ? s.bucketCounts.length - 1 : idx;
		s.bucketCounts[at] = (s.bucketCounts[at] ?? 0) + 1;
		if (ms > s.maxMs) s.maxMs = ms;
	}
	return s;
}

describe("mergeLatencySnapshots", () => {
	test("merges samples, not percentiles", () => {
		// One shard all-fast, one all-slow: a percentile-of-percentiles would
		// average or pick one; the merged population's p99 must rank across both.
		const fast = snapshotWith(new Array(99).fill(1));
		const slow = snapshotWith(new Array(99).fill(64));
		const merged = mergeLatencySnapshots([fast, slow]);
		const p99 = percentileMs(merged, 0.99);
		expect(p99).toBeGreaterThanOrEqual(64);
		const p50 = percentileMs(merged, 0.5);
		expect(p50).toBeLessThanOrEqual(1);
	});

	test("sums negatives and keeps the max", () => {
		const a = snapshotWith([-1, 5]);
		const b = snapshotWith([-1, 200]);
		const merged = mergeLatencySnapshots([a, b]);
		expect(merged.negativeCount).toBe(2);
		expect(merged.maxMs).toBe(200);
	});

	test("single snapshot merges to itself", () => {
		const a = snapshotWith([3, 7, 11]);
		const merged = mergeLatencySnapshots([a]);
		expect(merged).toEqual(a);
	});

	test("refuses mismatched layouts", () => {
		const a = emptySnapshot();
		const b = emptySnapshot();
		b.bucketCounts.push(0);
		b.bucketUpperMs.push(9999);
		expect(() => mergeLatencySnapshots([a, b])).toThrow(/layout/);
	});
});

function shardSummary(overrides: Partial<ClientSummary>): ClientSummary {
	return {
		runId: "run-1",
		host: "rig",
		drivingSessions: 50,
		sessionsOk: 50,
		sessionsErr: 0,
		streamsErr: 0,
		streamsClosedBothHalves: 50,
		framesWritten: 1000,
		bytesWritten: 1_000_000,
		framesRead: 1000,
		bytesRead: 1_000_000,
		perSession: [],
		latency: emptySnapshot(),
		schedulerLag: emptySnapshot(),
		writeSettle: emptySnapshot(),
		...overrides,
	};
}

describe("mergeClientSummaries", () => {
	test("sums counters and concatenates distinct per-session rows", () => {
		const a = shardSummary({
			perSession: [
				{
					index: 0,
					bytesWritten: 10,
					framesWritten: 1,
					bytesRead: 10,
					framesRead: 1,
				},
			],
		});
		const b = shardSummary({
			drivingSessions: 25,
			sessionsOk: 25,
			bytesWritten: 500_000,
			bytesRead: 250_000,
			framesWritten: 500,
			framesRead: 250,
			streamsClosedBothHalves: 25,
			perSession: [
				{
					index: 50,
					bytesWritten: 20,
					framesWritten: 2,
					bytesRead: 20,
					framesRead: 2,
				},
			],
		});
		const merged = mergeClientSummaries([a, b]);
		expect(merged.drivingSessions).toBe(75);
		expect(merged.sessionsOk).toBe(75);
		expect(merged.bytesWritten).toBe(1_500_000);
		expect(merged.bytesRead).toBe(1_250_000);
		expect(merged.framesWritten).toBe(1500);
		expect(merged.framesRead).toBe(1250);
		expect(merged.streamsClosedBothHalves).toBe(75);
		expect(merged.perSession.map((s) => s.index)).toEqual([0, 50]);
	});

	test("a single shard merges to the same numbers (the K=1 identity)", () => {
		const only = shardSummary({
			writeLatencyP99Ms: 4.2,
			peakSessionQueuedBytes: 123,
			perSession: [
				{
					index: 0,
					bytesWritten: 1,
					framesWritten: 1,
					bytesRead: 1,
					framesRead: 1,
				},
			],
		});
		const merged = mergeClientSummaries([only]);
		expect(merged.drivingSessions).toBe(only.drivingSessions);
		expect(merged.bytesWritten).toBe(only.bytesWritten);
		expect(merged.writeLatencyP99Ms).toBe(4.2);
		expect(merged.peakSessionQueuedBytes).toBe(123);
		expect(merged.perSession).toEqual(only.perSession);
	});

	test("refuses overlapping session bases", () => {
		const a = shardSummary({
			perSession: [
				{
					index: 7,
					bytesWritten: 1,
					framesWritten: 1,
					bytesRead: 1,
					framesRead: 1,
				},
			],
		});
		const b = shardSummary({
			perSession: [
				{
					index: 7,
					bytesWritten: 2,
					framesWritten: 2,
					bytesRead: 2,
					framesRead: 2,
				},
			],
		});
		expect(() => mergeClientSummaries([a, b])).toThrow(/overlap/);
	});

	test("refuses shards with mismatched provenance", () => {
		const a = shardSummary({});
		const b = shardSummary({ runId: "run-2" });
		expect(() => mergeClientSummaries([a, b])).toThrow(/provenance/);
	});

	test("multi-shard merges never carry single-process-only instruments", () => {
		const a = shardSummary({ writeLatencyP99Ms: 1 });
		const b = shardSummary({
			writeLatencyP99Ms: 2,
			perSession: [],
		});
		b.drivingSessions = 25;
		const merged = mergeClientSummaries([a, b]);
		expect(merged.writeLatencyP99Ms).toBeUndefined();
	});
});

describe("compositeShardChild", () => {
	function fakeChild(code: number | Promise<number>) {
		const killed: (number | NodeJS.Signals | undefined)[] = [];
		return {
			child: {
				exited: Promise.resolve(code),
				kill(signal?: number | NodeJS.Signals) {
					killed.push(signal);
				},
			},
			killed,
		};
	}

	test("all-zero exits compose to zero", async () => {
		const a = fakeChild(0);
		const b = fakeChild(0);
		const composite = compositeShardChild([a.child, b.child]);
		expect(await composite.exited).toBe(0);
	});

	test("one failing shard fails the composite", async () => {
		const a = fakeChild(0);
		const b = fakeChild(3);
		const composite = compositeShardChild([a.child, b.child]);
		expect(await composite.exited).toBe(3);
	});

	test("a rejected exited (spawn failure) reads as -1", async () => {
		const a = fakeChild(0);
		const bad = {
			exited: Promise.reject(new Error("spawn failed")),
			kill() {},
		};
		const composite = compositeShardChild([a.child, bad]);
		expect(await composite.exited).toBe(-1);
	});

	test("waits for every shard, not the first", async () => {
		let resolveSlow: (code: number) => void = () => {};
		const slow = {
			exited: new Promise<number>((resolve) => {
				resolveSlow = resolve;
			}),
			kill() {},
		};
		const fast = fakeChild(0);
		const composite = compositeShardChild([fast.child, slow]);
		let settled = false;
		void composite.exited.then(() => {
			settled = true;
		});
		await Bun.sleep(20);
		expect(settled).toBe(false);
		resolveSlow(0);
		await composite.exited;
		expect(settled).toBe(true);
	});

	test("kill fans out to every shard", () => {
		const a = fakeChild(0);
		const b = fakeChild(0);
		const composite = compositeShardChild([a.child, b.child]);
		composite.kill("SIGTERM");
		expect(a.killed).toEqual(["SIGTERM"]);
		expect(b.killed).toEqual(["SIGTERM"]);
	});
});
