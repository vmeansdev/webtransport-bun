import { describe, expect, test } from "bun:test";

import {
	type Arm,
	type ArmRun,
	type ArmSummary,
	artifactSuffix,
	dirtyPaths,
	makeRng,
	median,
	proofFailures,
	sessionArms,
	shuffled,
	summarizeSweep,
	workerArms,
} from "./worker-thread-parallelism-probe.ts";

function run(over: Partial<ArmRun> = {}): ArmRun {
	return {
		label: "workers=2",
		round: 1,
		workers: "2",
		sessions: 150,
		ratePerSession: 1000,
		receivedPerSec: 50_000,
		offeredPerSec: 140_000,
		received: 1_000_000,
		receivedBytes: 1_150_000_000,
		clientSent: 3_500_000,
		clientSendErrors: 0,
		sessionsOk: 150,
		sessionsErr: 0,
		windowMs: 20_000,
		saturationRatio: 0.357,
		acceptedStreamsPerSec: 0,
		datagramsOutPerSec: 0,
		drops: {
			datagramsIn: 0,
			datagramsDropped: 0,
			rateLimited: 0,
			backpressureWait: 0,
			backpressureTimeout: 0,
			datagramsDroppedTooLarge: 0,
			datagramsDroppedQueueSession: 0,
			datagramsDroppedQueueGlobal: 0,
			datagramsDroppedRateLimited: 0,
		},
		serverCpuCores: 2.1,
		workerProof: {
			configured: 2,
			availableParallelism: 10,
			datagramThreads: 2,
			perThread: { "wt-server#ThreadId(3)": 600, "wt-server#ThreadId(4)": 400 },
			cpuBefore: {},
			cpuAfter: {},
		},
		...over,
	};
}

function summary(over: Partial<ArmSummary> = {}): ArmSummary {
	return {
		label: "workers=2",
		workers: "2",
		sessions: 150,
		ratePerSession: 1000,
		medianReceivedPerSec: 50_000,
		medianServerCpuCores: 2.1,
		maxSaturationRatio: 0.4,
		minDatagramThreads: 2,
		maxDatagramThreads: 2,
		configuredWorkers: 2,
		runs: [run()],
		...over,
	};
}

describe("sweep design", () => {
	test("the session sweep holds aggregate offered load roughly constant", () => {
		const totals = sessionArms().map((a) => a.sessions * a.rate);
		for (const total of totals) {
			expect(Math.abs(total - 150_000) / 150_000).toBeLessThan(0.01);
		}
	});

	test("the worker sweep varies only the worker count", () => {
		const arms = workerArms();
		expect(new Set(arms.map((a) => a.sessions)).size).toBe(1);
		expect(new Set(arms.map((a) => a.rate)).size).toBe(1);
		expect(arms.map((a) => a.workers)).toEqual(["1", "2", "4", "auto"]);
	});
});

describe("interleaving", () => {
	test("shuffle is a permutation and is seed-reproducible", () => {
		const arms: Arm[] = workerArms();
		const a = shuffled(arms, makeRng(7));
		const b = shuffled(arms, makeRng(7));
		expect(a.map((x) => x.label)).toEqual(b.map((x) => x.label));
		expect(new Set(a.map((x) => x.label))).toEqual(
			new Set(arms.map((x) => x.label)),
		);
	});
});

describe("dirtyPaths", () => {
	test("a clean tree is clean", () => {
		expect(dirtyPaths("")).toEqual([]);
	});

	test("source changes count, the probes' own output directories do not", () => {
		const porcelain = [
			" M crates/native/src/lib.rs",
			"?? .investigation/worker-thread-parallelism-probe.json",
			"?? .investigation/measurement.md",
			"?? .bench-evidence/worker-load-sweep-abc123.json",
		].join("\n");
		expect(dirtyPaths(porcelain)).toEqual(["crates/native/src/lib.rs"]);
	});
});

describe("median", () => {
	test("odd and even lengths", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
});

describe("summarizeSweep", () => {
	test("reports the median rate and the thread-count range per arm", () => {
		const arms = workerArms().slice(0, 1);
		const label = arms[0]?.label as string;
		const runs = [
			run({ label, workers: "1", receivedPerSec: 10, serverCpuCores: 1 }),
			run({ label, workers: "1", receivedPerSec: 30, serverCpuCores: 3 }),
			run({ label, workers: "1", receivedPerSec: 20, serverCpuCores: 2 }),
		];
		const [s] = summarizeSweep(arms, runs);
		expect(s?.medianReceivedPerSec).toBe(20);
		expect(s?.medianServerCpuCores).toBe(2);
	});
});

describe("proofFailures", () => {
	test("a matching, genuinely-parallel arm passes", () => {
		expect(proofFailures([summary()])).toEqual([]);
		expect(
			proofFailures([
				summary({
					label: "workers=1",
					workers: "1",
					configuredWorkers: 1,
					minDatagramThreads: 1,
					maxDatagramThreads: 1,
				}),
			]),
		).toEqual([]);
	});

	test("catches a multi-worker arm that only ever used one thread", () => {
		const failures = proofFailures([
			summary({ minDatagramThreads: 1, maxDatagramThreads: 1 }),
		]);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("indistinguishable");
	});

	test("catches the runtime ignoring the requested worker count", () => {
		const failures = proofFailures([summary({ configuredWorkers: 1 })]);
		expect(failures.some((f) => f.includes("expected 2"))).toBe(true);
	});

	test("resolves auto against the host's reported parallelism", () => {
		const auto = summary({
			label: "workers=auto",
			workers: "auto",
			configuredWorkers: 10,
			maxDatagramThreads: 6,
			minDatagramThreads: 5,
			runs: [run({ workerProof: { ...run().workerProof, configured: 10 } })],
		});
		expect(proofFailures([auto])).toEqual([]);
		expect(proofFailures([{ ...auto, configuredWorkers: 4 }])).toHaveLength(1);
	});

	test("refuses when the addon has no worker probe at all", () => {
		const failures = proofFailures([summary({ configuredWorkers: null })]);
		expect(failures[0]).toContain("no worker-probe snapshot");
	});
});

describe("artifact naming", () => {
	test("the baseline receive-only single-client run keeps the original name", () => {
		expect(
			artifactSuffix({
				clients: 1,
				echo: false,
				discard: false,
				streamsPerSec: 0,
			}),
		).toBe("");
	});

	test("load-shape suffixes do not clobber the baseline artifact", () => {
		expect(
			artifactSuffix({
				clients: 3,
				echo: true,
				discard: false,
				streamsPerSec: 0,
			}),
		).toBe("-c3-echo");
		expect(
			artifactSuffix({
				clients: 3,
				echo: false,
				discard: true,
				streamsPerSec: 0,
			}),
		).toBe("-c3-discard");
		expect(
			artifactSuffix({
				clients: 3,
				echo: false,
				discard: false,
				streamsPerSec: 10,
			}),
		).toBe("-c3-streams10");
	});
});
