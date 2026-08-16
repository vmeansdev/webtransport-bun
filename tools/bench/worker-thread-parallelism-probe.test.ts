import { describe, expect, test } from "bun:test";

import {
	type Arm,
	type ArmRun,
	type ArmSummary,
	artifactSuffix,
	dirtyPaths,
	makeRng,
	median,
	parseLoadClientSentProgress,
	parseProcNetstatUdp,
	parseProcSnmpUdp,
	procRow,
	proofFailures,
	sessionArms,
	shuffled,
	summarizeSweep,
	windowSentDelta,
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

describe("parseLoadClientSentProgress", () => {
	test("collects load-client progress lines and ignores the summary line", () => {
		const stdout = [
			"load-client: t_ms=0 sent=0",
			"load-client: t_ms=1000 sent=50000",
			"load-client: t_ms=2000 sent=100000",
			"datagrams sent=150000 err=0",
		].join("\n");
		expect(parseLoadClientSentProgress(stdout)).toEqual([
			{ tMs: 0, sent: 0 },
			{ tMs: 1000, sent: 50_000 },
			{ tMs: 2000, sent: 100_000 },
		]);
	});
});

describe("windowSentDelta", () => {
	test("uses the last sample at-or-before warmup and warmup+measure", () => {
		const samples = parseLoadClientSentProgress(
			[
				"load-client: t_ms=0 sent=0",
				"load-client: t_ms=1000 sent=10000",
				"load-client: t_ms=2000 sent=20000",
				"load-client: t_ms=3000 sent=30000",
				"load-client: t_ms=4000 sent=40000",
				"load-client: t_ms=5000 sent=50000",
				"load-client: t_ms=6000 sent=60000",
				"load-client: t_ms=7000 sent=70000",
				"load-client: t_ms=8000 sent=80000",
				"load-client: t_ms=9000 sent=90000",
				"load-client: t_ms=10000 sent=100000",
				"load-client: t_ms=11000 sent=110000",
				"load-client: t_ms=12000 sent=120000",
				"load-client: t_ms=13000 sent=130000",
				"load-client: t_ms=14000 sent=140000",
				"load-client: t_ms=15000 sent=150000",
				"load-client: t_ms=16000 sent=160000",
				"load-client: t_ms=17000 sent=170000",
				"load-client: t_ms=18000 sent=180000",
				"load-client: t_ms=19000 sent=190000",
				"load-client: t_ms=20000 sent=200000",
				"load-client: t_ms=21000 sent=210000",
				"load-client: t_ms=22000 sent=220000",
				"load-client: t_ms=23000 sent=230000",
				"load-client: t_ms=24000 sent=240000",
				"load-client: t_ms=25000 sent=250000",
			].join("\n"),
		);
		expect(windowSentDelta(samples, 5000, 15000)).toEqual({
			sent0: 50_000,
			sent1: 200_000,
			t0: 5000,
			t1: 20_000,
		});
	});

	test("returns null when the measure boundary does not advance past warmup", () => {
		const samples = parseLoadClientSentProgress(
			"load-client: t_ms=0 sent=0\nload-client: t_ms=1000 sent=1000",
		);
		expect(windowSentDelta(samples, 5000, 15_000)).toBeNull();
	});
});

describe("procRow", () => {
	const snmp = [
		"Ip: Forwarding DefaultTTL",
		"Ip: 2 64",
		"Udp: InDatagrams NoPorts InErrors OutDatagrams",
		"Udp: 100 200 300 400",
	].join("\n");

	test("maps header keys to the following values line", () => {
		expect(procRow(snmp, "Udp", ["InDatagrams", "InErrors"])).toEqual({
			InDatagrams: 100,
			InErrors: 300,
		});
	});

	test("returns null when the values line is missing or column counts differ", () => {
		expect(procRow("Udp: InDatagrams\n", "Udp", ["InDatagrams"])).toBeNull();
		expect(
			procRow("Udp: InDatagrams InErrors\nUdp: 1\n", "Udp", ["InDatagrams"]),
		).toBeNull();
	});
});

describe("parseProcSnmpUdp", () => {
	test("reads InDatagrams and InErrors from /proc/net/snmp", () => {
		const text = [
			"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors",
			"Udp: 1234567 89 12 3456789 0 0",
		].join("\n");
		expect(parseProcSnmpUdp(text)).toEqual({
			InDatagrams: 1_234_567,
			InErrors: 12,
		});
	});
});

describe("parseProcNetstatUdp", () => {
	test("reads RcvbufErrors and SndbufErrors from /proc/net/netstat", () => {
		const text = [
			"UdpLite: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors",
			"UdpLite: 1 2 3 4 5 6",
			"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors",
			"Udp: 10 20 30 40 500 600 0 0 0",
		].join("\n");
		expect(parseProcNetstatUdp(text)).toEqual({
			RcvbufErrors: 500,
			SndbufErrors: 600,
		});
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
