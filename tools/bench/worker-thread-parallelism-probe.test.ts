import { describe, expect, test } from "bun:test";

import {
	type Arm,
	type ArmRun,
	type ArmSummary,
	artifactSuffix,
	classifyIngestGap,
	classifyPipeCap,
	cpuListsEqual,
	cpusSharePhysicalCore,
	dirtyPaths,
	formatGapLine,
	makeRng,
	median,
	parseCpuList,
	parseCpusAllowedListFromStatus,
	parseLoadClientSentProgress,
	parseSsUdpSkmem,
	parseProcNetUdpListenDrops,
	parseAppliedCongestion,
	pickDisjointPhysicalCpus,
	parseProcNetstatUdp,
	parseProcSnmpUdp,
	procRow,
	proofFailures,
	sessionArms,
	shuffled,
	summarizeSweep,
	sumWindowFrameTxPerSec,
	sumWindowOfferedPerSec,
	sumWindowUdpTxPerSec,
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
		gap: {
			windowOfferedPerSec: null,
			ingestedPerSec: 50_000,
			packetsLostDelta: null,
			packetsReceivedDelta: null,
			udpInErrorsDelta: null,
			udpRcvbufErrorsDelta: null,
			frameTxDatagramPerSec: null,
			udpTxPerSec: null,
			unexplainedPerSec: 90_000,
			stopBucket: "unexplained",
		},
		pipeCap: {
			frameTxPerSec: null,
			ingestedPerSec: 50_000,
			predictedPps: null,
			bdpBps: null,
			cwnd: null,
			rttUs: null,
			clientCpuCores: null,
			congPerSec: null,
			bytesPerDatagram: null,
			stopBucket: "incomplete",
		},
		clientTaskset: "",
		clientCpusAllowed: [],
		clientAffinityOk: true,
		skRcvbuf: null,
		skDrops: null,
		skDrops0: null,
		skDrops1: null,
		skDropSampleMs0: null,
		skDropSampleMs1: null,
		skListenMatchCount: null,
		appliedCongestion: "cubic",
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
			{
				tMs: 0,
				sent: 0,
				frameTxDatagram: null,
				udpTx: null,
				udpTxBytes: null,
				cwnd: null,
				rttUs: null,
				cong: null,
				bdpBps: null,
				cpuMs: null,
			},
			{
				tMs: 1000,
				sent: 50_000,
				frameTxDatagram: null,
				udpTx: null,
				udpTxBytes: null,
				cwnd: null,
				rttUs: null,
				cong: null,
				bdpBps: null,
				cpuMs: null,
			},
			{
				tMs: 2000,
				sent: 100_000,
				frameTxDatagram: null,
				udpTx: null,
				udpTxBytes: null,
				cwnd: null,
				rttUs: null,
				cong: null,
				bdpBps: null,
				cpuMs: null,
			},
		]);
	});

	test("parses optional frame_tx_datagram and udp_tx", () => {
		expect(
			parseLoadClientSentProgress(
				"load-client: t_ms=1000 sent=50000 frame_tx_datagram=40000 udp_tx=41000",
			),
		).toEqual([
			{
				tMs: 1000,
				sent: 50_000,
				frameTxDatagram: 40_000,
				udpTx: 41_000,
				udpTxBytes: null,
				cwnd: null,
				rttUs: null,
				cong: null,
				bdpBps: null,
				cpuMs: null,
			},
		]);
	});

	test("parses pipe-cap path and cpu fields", () => {
		expect(
			parseLoadClientSentProgress(
				"load-client: t_ms=1000 sent=50000 frame_tx_datagram=40000 udp_tx=41000 udp_tx_bytes=50000000 cwnd=120000 rtt_us=250 cong=3 bdp_bps=480000000 cpu_ms=900",
			),
		).toEqual([
			{
				tMs: 1000,
				sent: 50_000,
				frameTxDatagram: 40_000,
				udpTx: 41_000,
				udpTxBytes: 50_000_000,
				cwnd: 120_000,
				rttUs: 250,
				cong: 3,
				bdpBps: 480_000_000,
				cpuMs: 900,
			},
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
			frameTx0: null,
			frameTx1: null,
			udpTx0: null,
			udpTx1: null,
			udpTxBytes0: null,
			udpTxBytes1: null,
			cong0: null,
			cong1: null,
			cpuMs0: null,
			cpuMs1: null,
			cwnd1: null,
			rttUs1: null,
			bdpBps1: null,
		});
	});

	test("carries frame_tx and udp_tx when both samples have them", () => {
		const samples = parseLoadClientSentProgress(
			[
				"load-client: t_ms=5000 sent=50000 frame_tx_datagram=40000 udp_tx=41000",
				"load-client: t_ms=20000 sent=200000 frame_tx_datagram=160000 udp_tx=165000",
			].join("\n"),
		);
		expect(windowSentDelta(samples, 5000, 15_000)).toEqual({
			sent0: 50_000,
			sent1: 200_000,
			t0: 5000,
			t1: 20_000,
			frameTx0: 40_000,
			frameTx1: 160_000,
			udpTx0: 41_000,
			udpTx1: 165_000,
			udpTxBytes0: null,
			udpTxBytes1: null,
			cong0: null,
			cong1: null,
			cpuMs0: null,
			cpuMs1: null,
			cwnd1: null,
			rttUs1: null,
			bdpBps1: null,
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
			rcvbufErrors: 0,
		});
	});

	test("reads RcvbufErrors from the snmp Udp line when the column exists", () => {
		const text = [
			"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti",
			"Udp: 10 20 30 40 777 50 0 0",
		].join("\n");
		expect(parseProcSnmpUdp(text)).toEqual({
			InDatagrams: 10,
			InErrors: 30,
			rcvbufErrors: 777,
		});
	});

	test("omits rcvbufErrors when the snmp Udp header has no such column", () => {
		const text = [
			"Udp: InDatagrams NoPorts InErrors OutDatagrams",
			"Udp: 100 200 300 400",
		].join("\n");
		expect(parseProcSnmpUdp(text)).toEqual({
			InDatagrams: 100,
			InErrors: 300,
		});
		expect(parseProcSnmpUdp(text)).not.toHaveProperty("rcvbufErrors");
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

describe("sumWindowOfferedPerSec", () => {
	const client = (sent0: number, sent1: number): string =>
		[
			`load-client: t_ms=5000 sent=${sent0}`,
			`load-client: t_ms=20000 sent=${sent1}`,
		].join("\n");

	test("sums per-client window sent rates instead of parsing concatenated stdout", () => {
		const a = client(50_000, 200_000);
		const b = client(10_000, 160_000);
		expect(sumWindowOfferedPerSec([a, b], 5000, 15_000)).toBe(20_000);
		expect(sumWindowOfferedPerSec([`${a}\n${b}`], 5000, 15_000)).not.toBe(
			20_000,
		);
	});

	test("returns null when no client produced a window", () => {
		expect(
			sumWindowOfferedPerSec(["datagrams sent=100"], 5000, 15_000),
		).toBeNull();
	});
});

describe("sumWindowFrameTxPerSec", () => {
	const client = (
		sent0: number,
		sent1: number,
		frame0: number,
		frame1: number,
	): string =>
		[
			`load-client: t_ms=5000 sent=${sent0} frame_tx_datagram=${frame0} udp_tx=${frame0}`,
			`load-client: t_ms=20000 sent=${sent1} frame_tx_datagram=${frame1} udp_tx=${frame1}`,
		].join("\n");

	test("sums per-client window frame_tx rates", () => {
		const a = client(50_000, 200_000, 40_000, 160_000);
		const b = client(10_000, 160_000, 8_000, 128_000);
		expect(sumWindowFrameTxPerSec([a, b], 5000, 15_000)).toBe(16_000);
		expect(sumWindowUdpTxPerSec([a, b], 5000, 15_000)).toBe(16_000);
	});

	test("returns null when progress lines omit frame_tx", () => {
		expect(
			sumWindowFrameTxPerSec(
				["load-client: t_ms=5000 sent=1\nload-client: t_ms=20000 sent=2"],
				5000,
				15_000,
			),
		).toBeNull();
	});
});

describe("classifyIngestGap", () => {
	const base = {
		windowOfferedPerSec: 147_000 as number | null,
		offeredPerSec: 140_000,
		ingestedPerSec: 99_000,
		packetsLostDelta: 0 as number | null,
		packetsReceivedDelta: 1_500_000 as number | null,
		udpInErrorsDelta: 0 as number | null,
		udpRcvbufErrorsDelta: 0 as number | null,
		windowSec: 15,
	};

	test("ingest near offered is window-accounting", () => {
		const gap = classifyIngestGap({
			...base,
			windowOfferedPerSec: 100_000,
			ingestedPerSec: 99_000,
		});
		expect(gap.stopBucket).toBe("window-accounting");
		expect(gap.windowOfferedPerSec).toBe(100_000);
		expect(gap.ingestedPerSec).toBe(99_000);
	});

	test("gap under 5000/s is window-accounting even if loss is present", () => {
		expect(
			classifyIngestGap({
				...base,
				windowOfferedPerSec: 103_000,
				ingestedPerSec: 99_000,
				packetsLostDelta: 1_000_000,
			}).stopBucket,
		).toBe("window-accounting");
	});

	test("lost rate at least 90% of the gap is quic-loss", () => {
		const gap = classifyIngestGap({
			...base,
			packetsLostDelta: 648_000,
		});
		expect(gap.stopBucket).toBe("quic-loss");
		expect(gap.packetsLostDelta).toBe(648_000);
	});

	test("rcvbuf rate at least 90% of the gap is udp-rcvbuf", () => {
		const gap = classifyIngestGap({
			...base,
			packetsLostDelta: 0,
			udpRcvbufErrorsDelta: 700_000,
		});
		expect(gap.stopBucket).toBe("udp-rcvbuf");
		expect(gap.udpRcvbufErrorsDelta).toBe(700_000);
	});

	test("uses whole-run offered when window offered is absent", () => {
		const gap = classifyIngestGap({
			...base,
			windowOfferedPerSec: null,
			offeredPerSec: 147_000,
			packetsLostDelta: 648_000,
		});
		expect(gap.stopBucket).toBe("quic-loss");
		expect(gap.windowOfferedPerSec).toBeNull();
	});

	test("otherwise the leftover is unexplained", () => {
		const gap = classifyIngestGap({
			...base,
			packetsLostDelta: 1_000,
			udpRcvbufErrorsDelta: 1_000,
		});
		expect(gap.stopBucket).toBe("unexplained");
		expect(gap.unexplainedPerSec).toBeGreaterThan(40_000);
	});

	test("omitted UDP and QUIC counters stay null rather than zero", () => {
		const gap = classifyIngestGap({
			...base,
			packetsLostDelta: null,
			packetsReceivedDelta: null,
			udpInErrorsDelta: null,
			udpRcvbufErrorsDelta: null,
		});
		expect(gap.stopBucket).toBe("unexplained");
		expect(gap.packetsLostDelta).toBeNull();
		expect(gap.udpRcvbufErrorsDelta).toBeNull();
		expect(gap.udpInErrorsDelta).toBeNull();
		expect(gap.frameTxDatagramPerSec).toBeNull();
	});

	test("offered minus frame_tx covering 90% of the gap is client-cc", () => {
		const gap = classifyIngestGap({
			...base,
			frameTxDatagramPerSec: 99_000,
		});
		expect(gap.stopBucket).toBe("client-cc");
		expect(gap.frameTxDatagramPerSec).toBe(99_000);
		expect(gap.unexplainedPerSec).toBe(0);
	});

	test("frame_tx minus ingest covering 90% of the gap is wire", () => {
		const gap = classifyIngestGap({
			...base,
			frameTxDatagramPerSec: 147_000,
		});
		expect(gap.stopBucket).toBe("wire");
		expect(gap.unexplainedPerSec).toBe(0);
	});

	test("partial frame_tx leftover stays unexplained", () => {
		expect(
			classifyIngestGap({
				...base,
				frameTxDatagramPerSec: 123_000,
			}).stopBucket,
		).toBe("unexplained");
	});

	test("omitted frame_tx does not fire client-cc", () => {
		expect(
			classifyIngestGap({
				...base,
				frameTxDatagramPerSec: null,
			}).stopBucket,
		).toBe("unexplained");
	});

	test("quic-loss still wins when it accounts before client-cc", () => {
		expect(
			classifyIngestGap({
				...base,
				packetsLostDelta: 648_000,
				frameTxDatagramPerSec: 99_000,
			}).stopBucket,
		).toBe("quic-loss");
	});
});

describe("formatGapLine", () => {
	test("prints n/a for omitted counters rather than 0", () => {
		expect(
			formatGapLine({
				windowOfferedPerSec: 147_000,
				ingestedPerSec: 99_000,
				packetsLostDelta: 10,
				packetsReceivedDelta: 1_000,
				udpInErrorsDelta: null,
				udpRcvbufErrorsDelta: null,
				frameTxDatagramPerSec: 99_000,
				udpTxPerSec: null,
				unexplainedPerSec: 48_000,
				stopBucket: "unexplained",
			}),
		).toBe(
			"gap: windowOffered=147000 ingest=99000 frameTx=99000 udpTx=n/a lost=10 rcvbuf=n/a unexplained=48000 STOP=unexplained",
		);
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

describe("classifyPipeCap", () => {
	const base = {
		frameTxPerSec: 108_000 as number | null,
		ingestedPerSec: 105_000,
		bdpBps: 500_000_000 as number | null,
		cwnd: 240_000 as number | null,
		rttUs: 1_500 as number | null,
		udpTxBytesPerSec: 130_000_000 as number | null,
		clientCpuCores: 0.8 as number | null,
		congPerSec: 0 as number | null,
	};

	test("ingest short of frame_tx is server-ingest", () => {
		expect(
			classifyPipeCap({ ...base, ingestedPerSec: 80_000 }).stopBucket,
		).toBe("server-ingest");
	});

	test("predicted pps without 15% headroom is cc", () => {
		expect(
			classifyPipeCap({
				...base,
				bdpBps: 120_000_000,
				udpTxBytesPerSec: 130_000_000,
			}).stopBucket,
		).toBe("cc");
	});

	test("bdp headroom plus hot client is client-cpu", () => {
		expect(classifyPipeCap({ ...base, clientCpuCores: 1.8 }).stopBucket).toBe(
			"client-cpu",
		);
	});

	test("bdp headroom without hot client is unexplained", () => {
		expect(classifyPipeCap(base).stopBucket).toBe("unexplained");
	});

	test("missing bdp is incomplete", () => {
		expect(classifyPipeCap({ ...base, bdpBps: null }).stopBucket).toBe(
			"incomplete",
		);
	});
});

describe("cpu list helpers", () => {
	test("parseCpuList expands ranges and singles", () => {
		expect(parseCpuList("0-1")).toEqual([0, 1]);
		expect(parseCpuList("0,2")).toEqual([0, 2]);
		expect(parseCpuList(" 0-1,3 ")).toEqual([0, 1, 3]);
	});

	test("cpuListsEqual is order-sensitive after parse sort", () => {
		expect(cpuListsEqual(parseCpuList("1,0"), parseCpuList("0-1"))).toBe(true);
		expect(cpuListsEqual([0, 1], [0, 2])).toBe(false);
	});

	test("cpusSharePhysicalCore treats self and sibling lists", () => {
		expect(cpusSharePhysicalCore(0, 0, [0, 4])).toBe(true);
		expect(cpusSharePhysicalCore(0, 4, [0, 4])).toBe(true);
		expect(cpusSharePhysicalCore(0, 1, [0, 4])).toBe(false);
	});

	test("parseCpusAllowedListFromStatus reads the proc line", () => {
		expect(
			parseCpusAllowedListFromStatus(
				"Name:\tload-client\nCpus_allowed_list:\t0-1\n",
			),
		).toEqual([0, 1]);
		expect(parseCpusAllowedListFromStatus("Name:\tload-client\n")).toBeNull();
	});

	test("pickDisjointPhysicalCpus skips an HT pair", () => {
		expect(
			pickDisjointPhysicalCpus({
				0: [0, 1],
				1: [0, 1],
				2: [2, 3],
				3: [2, 3],
			}),
		).toEqual([0, 2]);
		expect(
			pickDisjointPhysicalCpus({
				0: [0, 1],
				1: [0, 1],
			}),
		).toBeNull();
		expect(
			pickDisjointPhysicalCpus({
				0: [0],
				1: [1],
				2: [2],
				3: [3],
			}),
		).toEqual([0, 1]);
	});
});

describe("parseSsUdpSkmem", () => {
	const sample = [
		"State Recv-Q Send-Q Local Address:Port Peer Address:Port",
		"UNCONN 0 0 127.0.0.1:50110 0.0.0.0:*",
		"\t skmem:(r0,rb212992,t0,tb212992,f0,w0,o0,bl0,d12)",
	].join("\n");

	test("reads rb and d for the listen port", () => {
		expect(parseSsUdpSkmem(sample, 50110)).toEqual({
			recvbuf: 212_992,
			drops: 12,
		});
	});

	test("returns null for a different port", () => {
		expect(parseSsUdpSkmem(sample, 50111)).toBeNull();
	});
});

describe("parseProcNetUdpListenDrops", () => {
	const header =
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops";
	const unconn =
		" 3508: 0100007F:C3BE 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 123456 2 0000000000000000 42";
	const estab =
		" 3509: 0100007F:C3BE 0100007F:C3AF 01 00000000:00000000 00:00000000 00000000     0        0 123457 2 0000000000000000 99";

	test("reads UNCONN drops for the listen port", () => {
		expect(parseProcNetUdpListenDrops(`${header}\n${unconn}\n`, 50110)).toEqual(
			{
				drops: 42,
				inode: "123456",
				rxQueue: 0,
				matchCount: 1,
			},
		);
	});

	test("ignores ESTAB clones on the same port", () => {
		expect(
			parseProcNetUdpListenDrops(`${header}\n${estab}\n${unconn}\n`, 50110),
		).toEqual({
			drops: 42,
			inode: "123456",
			rxQueue: 0,
			matchCount: 1,
		});
	});

	test("counts two UNCONN rows", () => {
		const second =
			" 3510: 00000000:C3BE 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 123458 2 0000000000000000 7";
		expect(
			parseProcNetUdpListenDrops(`${header}\n${unconn}\n${second}\n`, 50110)
				?.matchCount,
		).toBe(2);
	});

	test("returns null when the port is absent", () => {
		expect(
			parseProcNetUdpListenDrops(`${header}\n${unconn}\n`, 50111),
		).toBeNull();
	});
});

describe("parseAppliedCongestion", () => {
	test("reads matching factory labels", () => {
		expect(
			parseAppliedCongestion([
				"load-client: mode=load url=https://127.0.0.1:1 sessions=50 duration=20s datagrams/s=1600 streams/s=0 payload_bytes=1150 hold_ms=1000 skip_probes=true congestion=bbr budgets(session=50, datagram=1, stream=1)\n",
			]),
		).toBe("bbr");
	});

	test("null when labels disagree", () => {
		expect(
			parseAppliedCongestion([
				"load-client: mode=load congestion=cubic budgets()\n",
				"load-client: mode=load congestion=bbr budgets()\n",
			]),
		).toBeNull();
	});
});
