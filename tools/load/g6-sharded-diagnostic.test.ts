import { describe, expect, test } from "bun:test";
import {
	linuxProbeFixture,
	linuxProbeFixtureText,
} from "./g6-linux-probe-fixture.ts";
import {
	deltaHostUdpCounters,
	GENERATOR_SAMPLE_SEPARATOR,
	INTERFACE_SAMPLE_SEPARATOR,
	parseLinuxProbeJsonl,
	parseConnectErrorsSample,
	parseEthtoolStats,
	parseGeneratorHostSample,
	parseHostUdpCounters,
	parseInterfaceSample,
	parseMeminfoKb,
	parseOwnedUdpSocketTable,
	parseProcNetDev,
	parseVmRssKb,
	selectMidpointSample,
} from "./g6-sharded-diagnostic.ts";

const UDP_SNMP_BEFORE =
	"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors Unknown\n" +
	"Udp: 100 2 3 400 5 6 999\n";

const UDP_SNMP_AFTER =
	"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors Unknown\n" +
	"Udp: 125 4 7 430 8 9 1001\n";

const TABLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  0: 00000000:1151 00000000:0000 07 00000010:00000020 00:00000000 00000000 0 0 101 2 0000000000000000 3
  1: 00000000:1152 00000000:0000 07 00000001:00000002 00:00000000 00000000 0 0 202 2 0000000000000000 7
  2: 00000000:1153 00000000:0000 07 malformed 00:00000000 00000000 0 0 303 2 0000000000000000 9
`;

describe("G6 per-process UDP socket diagnostics", () => {
	test("aggregates only rows whose socket inode belongs to the shard process", () => {
		expect(parseOwnedUdpSocketTable(TABLE, new Set(["101"]))).toEqual({
			socketCount: 1,
			txQueueBytes: 0x10,
			rxQueueBytes: 0x20,
			drops: 3,
		});
	}, 15_000);

	test("sums multiple owned sockets and ignores malformed rows", () => {
		expect(
			parseOwnedUdpSocketTable(TABLE, new Set(["101", "202", "303"])),
		).toEqual({
			socketCount: 2,
			txQueueBytes: 0x11,
			rxQueueBytes: 0x22,
			drops: 10,
		});
	}, 15_000);
});

describe("G6 host UDP counter diagnostics", () => {
	test("parses only the exact allow-listed counters from a complete UDP sample", () => {
		expect(parseHostUdpCounters(UDP_SNMP_BEFORE)).toEqual({
			InDatagrams: 100,
			NoPorts: 2,
			InErrors: 3,
			OutDatagrams: 400,
			RcvbufErrors: 5,
			SndbufErrors: 6,
		});
	}, 15_000);

	test("rejects incomplete or malformed samples instead of fabricating zeroes", () => {
		expect(
			parseHostUdpCounters(
				"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors\n" +
					"Udp: 100 2 malformed 400 5 6\n",
			),
		).toBeNull();
		expect(
			parseHostUdpCounters(
				"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors\n" +
					"Udp: 100 2 3 400 5\n",
			),
		).toBeNull();
	}, 15_000);

	test("returns only nonnegative deltas and refuses missing or decreasing samples", () => {
		expect(
			deltaHostUdpCounters(
				parseHostUdpCounters(UDP_SNMP_BEFORE),
				parseHostUdpCounters(UDP_SNMP_AFTER),
			),
		).toEqual({
			InDatagrams: 25,
			NoPorts: 2,
			InErrors: 4,
			OutDatagrams: 30,
			RcvbufErrors: 3,
			SndbufErrors: 3,
		});
		expect(
			deltaHostUdpCounters(null, parseHostUdpCounters(UDP_SNMP_AFTER)),
		).toBeNull();
		expect(
			deltaHostUdpCounters(undefined, parseHostUdpCounters(UDP_SNMP_AFTER)),
		).toBeNull();
		expect(
			deltaHostUdpCounters(
				parseHostUdpCounters(UDP_SNMP_AFTER),
				parseHostUdpCounters(UDP_SNMP_BEFORE),
			),
		).toBeNull();
	}, 15_000);
});

describe("G6 connect-phase diagnostic semantics", () => {
	test("selects the captured sample nearest the actual wall-clock midpoint", () => {
		const samples = [{ tsMs: 1_300 }, { tsMs: 1_550 }, { tsMs: 1_800 }];
		expect(selectMidpointSample(samples, 1_000, 2_200)).toEqual({
			sample: { tsMs: 1_550 },
			targetTsMs: 1_600,
			offsetMs: -50,
		});
	}, 15_000);

	test("parses connect errors only from the final mmo-client JSON", () => {
		expect(
			parseConnectErrorsSample([
				'mmo-client: phase {"kind":"steady"}',
				'mmo-client: json {"sessionsOk":8,"connectErrorsSample":["tls","timeout"]}',
			]),
		).toEqual(["tls", "timeout"]);
		expect(
			parseConnectErrorsSample(['mmo-client: phase {"kind":"steady"}']),
		).toBeNull();
	}, 15_000);

	test("parses VmRSS from a process status snapshot and refuses malformed text", () => {
		expect(
			parseVmRssKb(
				"Name:\twt-server\nVmPeak:\t 120000 kB\nVmRSS:\t  84212 kB\n",
			),
		).toBe(84_212);
		expect(parseVmRssKb("Name:\twt-server\nVmPeak:\t 120000 kB\n")).toBeNull();
		expect(parseVmRssKb("VmRSS:\tnot-a-number kB\n")).toBeNull();
		expect(parseVmRssKb("")).toBeNull();
	}, 15_000);

	test("parses MemTotal and MemAvailable from meminfo and refuses partial text", () => {
		expect(
			parseMeminfoKb(
				"MemTotal:       65805292 kB\nMemFree:        1203944 kB\nMemAvailable:   58223104 kB\n",
			),
		).toEqual({ totalKb: 65_805_292, availableKb: 58_223_104 });
		expect(parseMeminfoKb("MemTotal:       65805292 kB\n")).toBeNull();
		expect(parseMeminfoKb("MemAvailable:   x kB\nMemTotal: 1 kB\n")).toBeNull();
		expect(parseMeminfoKb("")).toBeNull();
	}, 15_000);

	test("parses the generator host sample: loadavg, meminfo, and the summed client RSS", () => {
		const sample = [
			"3.74 12.54 8.18 5/1234 98765",
			GENERATOR_SAMPLE_SEPARATOR,
			"MemTotal:       98860816 kB\nMemFree:        1203944 kB\nMemAvailable:   92974760 kB\n",
			GENERATOR_SAMPLE_SEPARATOR,
			"Name:\tmmo-client\nVmRSS:\t  512000 kB\n",
			"Name:\tmmo-client\nVmRSS:\t  1024 kB\n",
		].join("\n");
		expect(parseGeneratorHostSample(sample)).toEqual({
			loadavg: { "1": 3.74, "5": 12.54, "15": 8.18 },
			memoryKb: { totalKb: 98_860_816, availableKb: 92_974_760 },
			clientRssKb: 513_024,
		});
		const idle = [
			"0.10 0.20 0.30 1/100 5",
			GENERATOR_SAMPLE_SEPARATOR,
			"MemTotal:       98860816 kB\nMemAvailable:   96561252 kB\n",
			GENERATOR_SAMPLE_SEPARATOR,
			"",
		].join("\n");
		expect(parseGeneratorHostSample(idle)).toEqual({
			loadavg: { "1": 0.1, "5": 0.2, "15": 0.3 },
			memoryKb: { totalKb: 98_860_816, availableKb: 96_561_252 },
			clientRssKb: null,
		});
		expect(parseGeneratorHostSample("")).toBeNull();
		expect(parseGeneratorHostSample("garbage\n---\n---\n")).toBeNull();
		expect(
			parseGeneratorHostSample(
				`1 2 3 1/1 1\n${GENERATOR_SAMPLE_SEPARATOR}\nMemTotal: 1 kB\n${GENERATOR_SAMPLE_SEPARATOR}\n`,
			),
		).toEqual({
			loadavg: { "1": 1, "5": 2, "15": 3 },
			memoryKb: null,
			clientRssKb: null,
		});
	}, 15_000);

	test("parses /proc/net/dev per interface, skipping loopback and malformed rows", () => {
		const text = [
			"Inter-|   Receive                                                |  Transmit",
			" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
			"    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0",
			"  eth0: 123456789 1234567 1 2 3 0 0 5 987654321 7654321 4 5 6 0 0 0",
			"  eth1: 55 44 0 7 0 0 0 0 66 33 0 8 9 0 0 0",
			"  bad0: 1 2 three",
			"",
		].join("\n");
		expect(parseProcNetDev(text)).toEqual({
			eth0: {
				rxBytes: 123_456_789,
				rxPackets: 1_234_567,
				rxErrs: 1,
				rxDrop: 2,
				rxFifo: 3,
				txBytes: 987_654_321,
				txPackets: 7_654_321,
				txErrs: 4,
				txDrop: 5,
				txFifo: 6,
			},
			eth1: {
				rxBytes: 55,
				rxPackets: 44,
				rxErrs: 0,
				rxDrop: 7,
				rxFifo: 0,
				txBytes: 66,
				txPackets: 33,
				txErrs: 0,
				txDrop: 8,
				txFifo: 9,
			},
		});
		expect(parseProcNetDev("")).toEqual({});
	}, 15_000);

	test("parses ethtool -S name: value rows and a composite both-host interface sample", () => {
		const ethtool =
			"NIC statistics:\n     rx_queue_0_packets: 500\n     rx_queue_0_drops: 3\n     tx_queue_0_packets: 7\n     bogus line\n";
		expect(parseEthtoolStats(ethtool)).toEqual({
			rx_queue_0_packets: 500,
			rx_queue_0_drops: 3,
			tx_queue_0_packets: 7,
		});
		const sample = [
			"Inter-| Receive | Transmit",
			" face | ...",
			"  eth1: 55 44 0 7 0 0 0 0 66 33 0 8 9 0 0 0",
			`${INTERFACE_SAMPLE_SEPARATOR} eth1`,
			ethtool,
			`${INTERFACE_SAMPLE_SEPARATOR} eth0`,
			"",
		].join("\n");
		expect(parseInterfaceSample(sample)).toEqual({
			netDev: {
				eth1: {
					rxBytes: 55,
					rxPackets: 44,
					rxErrs: 0,
					rxDrop: 7,
					rxFifo: 0,
					txBytes: 66,
					txPackets: 33,
					txErrs: 0,
					txDrop: 8,
					txFifo: 9,
				},
			},
			ethtool: {
				eth1: {
					rx_queue_0_packets: 500,
					rx_queue_0_drops: 3,
					tx_queue_0_packets: 7,
				},
				eth0: {},
			},
		});
		expect(parseInterfaceSample("")).toBeNull();
		expect(parseInterfaceSample("garbage\n")).toBeNull();
	}, 15_000);
});

describe("G6 Linux probe phase parser", () => {
	test("recomputes phase coverage and preserves a distinct connect-only pressure view", () => {
		const parsed = parseLinuxProbeJsonl(linuxProbeFixtureText());
		expect(parsed).toMatchObject({
			schema: "g6-c32-linux-probe/2",
			producerSha256: "a".repeat(64),
			measurementMode: { detail: "on", phaseAware: true },
			phaseCoverage: {
				connect: { queueSamples: 5, schedSamples: 1 },
				steady: { queueSamples: 5, schedSamples: 1 },
				drain: { queueSamples: 5, schedSamples: 1 },
				idle: { queueSamples: 5, schedSamples: 1 },
			},
			historicalConnectSummary: {
				peakReceiveQueueBytes: 5,
				peakDrops: 0,
				queueSamples: 5,
				schedSamples: 1,
				pressureAlignments: 0,
				drainStallAligned: false,
			},
		});
		expect(parsed.summary.summary).toMatchObject({
			peakReceiveQueueBytes: 9,
			drainStallAligned: true,
		});
	});

	const reject = (
		mutate: (rows: ReturnType<typeof linuxProbeFixture>) => void,
		reason?: RegExp,
	) => {
		const rows = linuxProbeFixture();
		mutate(rows);
		if (reason)
			expect(() => parseLinuxProbeJsonl(linuxProbeFixtureText(rows))).toThrow(
				reason,
			);
		else
			expect(() => parseLinuxProbeJsonl(linuxProbeFixtureText(rows))).toThrow();
	};
	const footer = (rows: ReturnType<typeof linuxProbeFixture>) => rows.at(-1)!;
	const first = (rows: ReturnType<typeof linuxProbeFixture>, kind: string) =>
		rows.find((row) => row.schema === `g6-c32-linux-probe-${kind}/2`)!;

	test("rejects missing, out-of-order, duplicate, and backwards phase boundaries", () => {
		reject((rows) => {
			rows.splice(
				rows.findIndex((row) => row.phase === "steady"),
				1,
			);
		});
		reject((rows) => {
			rows.find((row) => row.phase === "steady")!.phase = "drain";
		});
		reject((rows) => {
			rows.splice(2, 0, { ...rows[1] });
		});
		reject((rows) => {
			rows.find((row) => row.phase === "steady")!.monotonicNs = "1";
		});
		reject((rows) => {
			rows.splice(
				-1,
				0,
				{
					schema: "g6-c32-linux-probe-phase/1",
					phase: "closed",
					monotonicNs: "299000000",
					requestId: 5,
				},
				{
					schema: "g6-c32-linux-probe-phase/1",
					phase: "closed",
					monotonicNs: "299000001",
					requestId: 6,
				},
			);
		});
	});

	test("requires nonempty exact shard membership, PID and inode ownership for every sample", () => {
		for (const kind of ["queue", "sched"]) {
			const field = kind === "queue" ? "shards" : "sched";
			reject((rows) => {
				first(rows, kind)[field] = [];
			});
			reject((rows) => {
				first(rows, kind)[field].push({ ...first(rows, kind)[field][0] });
			});
			reject((rows) => {
				first(rows, kind)[field][0].serverId = 2;
			});
			reject((rows) => {
				first(rows, kind)[field][0].pid = 102;
			});
		}
		reject((rows) => {
			rows[0]!.shards = [];
		});
		reject((rows) => {
			rows[0]!.shards[0].serverId = 2;
		});
		reject((rows) => {
			rows[0]!.shards[0].inodes = [];
		});
		reject((rows) => {
			first(rows, "queue").shards[0].inodes = ["112"];
		});
		reject((rows) => {
			first(rows, "queue").shards[0].socketCount = 0;
		});
		reject((rows) => {
			first(rows, "queue").shards[0].udp4SocketCount = 0;
		});
	});

	test("requires all raw counters and rejects negative or unsafe deltas", () => {
		for (const key of ["drops", "rxQueueBytes", "txQueueBytes", "socketCount"])
			reject((rows) => {
				delete first(rows, "queue").shards[0][key];
			});
		for (const key of ["runtimeNs", "waitNs", "timeslices"])
			reject((rows) => {
				delete first(rows, "sched").sched[0][key];
			});
		reject((rows) => {
			first(rows, "queue").shards[0].drops = 2;
		}, /negative/i);
		reject((rows) => {
			first(rows, "sched").netRx = 100;
		}, /negative/i);
		reject((rows) => {
			first(rows, "sched").sched[0].runtimeNs = 100;
		}, /negative/i);
		reject((rows) => {
			first(rows, "queue").shards[0].rxQueueBytes = Number.MAX_SAFE_INTEGER + 1;
		});
		reject((rows) => {
			first(rows, "queue").monotonicNs = "18446744073709551616";
		});
	});

	test("requires one header first and matching terminal provenance, cadence and mode at EOF", () => {
		reject((rows) => {
			rows.splice(0, 1);
		});
		reject((rows) => {
			rows.splice(1, 0, { ...rows[0] });
		});
		reject((rows) => {
			rows.push({ ...rows[1] });
		});
		reject((rows) => {
			rows.push({ ...footer(rows) });
		});
		reject((rows) => {
			footer(rows).producerSha256 = "b".repeat(64);
		}, /producer/i);
		reject((rows) => {
			footer(rows).queueCadenceMs = 20;
		}, /cadence/i);
		reject((rows) => {
			rows[0]!.queueCadenceMs = 0;
		}, /cadence/i);
		reject((rows) => {
			footer(rows).measurementMode.detail = "off";
		});
		reject((rows) => {
			delete rows[0]!.phaseOrder;
		});
	});

	test("requires complete terminal evidence and recomputes rather than trusts its summaries", () => {
		for (const key of [
			"phaseBoundaries",
			"phaseCoverage",
			"truncated",
			"problems",
			"childExit",
			"historicalConnectSummary",
			"summary",
			"queueSamples",
			"schedSamples",
			"monotonicNs",
			"probeCpuEnd",
		])
			reject((rows) => {
				delete footer(rows)[key];
			});
		reject((rows) => {
			footer(rows).truncated = true;
		}, /truncat/i);
		reject((rows) => {
			footer(rows).complete = false;
		});
		reject((rows) => {
			footer(rows).childExit.signal = "SIGKILL";
		});
		reject((rows) => {
			footer(rows).problems = ["dropped shard"];
		});
		reject((rows) => {
			footer(rows).phaseCoverage.steady.queueSamples++;
		});
		reject((rows) => {
			footer(rows).phaseBoundaries.steady.monotonicNs = "150000001";
		});
		reject((rows) => {
			footer(rows).queueSamples++;
		});
		reject((rows) => {
			footer(rows).historicalConnectSummary.peakReceiveQueueBytes = 9;
		});
		reject((rows) => {
			footer(rows).historicalConnectSummary.drainStallAligned = true;
		});
		for (const key of [
			"peakReceiveQueueBytes",
			"peakDrops",
			"pressureAlignments",
			"effectiveReceiveBufferBytes",
			"effectiveSendBufferBytes",
			"peakProcsRunning",
			"peakLoad1",
			"probeUserSec",
			"probeSysSec",
			"clkTck",
		])
			reject((rows) => {
				footer(rows).summary[key]++;
			});
		reject((rows) => {
			footer(rows).summary.drainStallAligned = false;
		});
		reject((rows) => {
			footer(rows).probeCpuEnd.userJiffies = 19;
		});
		expect(() =>
			parseLinuxProbeJsonl(
				linuxProbeFixtureText().replace(
					/"artifactBytes":\d+/,
					'"artifactBytes":1',
				),
			),
		).toThrow();
	});
});
