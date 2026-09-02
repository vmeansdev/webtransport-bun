import { describe, expect, test } from "bun:test";
import {
	deltaHostUdpCounters,
	GENERATOR_SAMPLE_SEPARATOR,
	parseConnectErrorsSample,
	parseGeneratorHostSample,
	parseHostUdpCounters,
	parseMeminfoKb,
	parseOwnedUdpSocketTable,
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
	});

	test("sums multiple owned sockets and ignores malformed rows", () => {
		expect(
			parseOwnedUdpSocketTable(TABLE, new Set(["101", "202", "303"])),
		).toEqual({
			socketCount: 2,
			txQueueBytes: 0x11,
			rxQueueBytes: 0x22,
			drops: 10,
		});
	});
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
	});

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
	});

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
	});
});

describe("G6 connect-phase diagnostic semantics", () => {
	test("selects the captured sample nearest the actual wall-clock midpoint", () => {
		const samples = [{ tsMs: 1_300 }, { tsMs: 1_550 }, { tsMs: 1_800 }];
		expect(selectMidpointSample(samples, 1_000, 2_200)).toEqual({
			sample: { tsMs: 1_550 },
			targetTsMs: 1_600,
			offsetMs: -50,
		});
	});

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
	});

	test("parses VmRSS from a process status snapshot and refuses malformed text", () => {
		expect(
			parseVmRssKb(
				"Name:\twt-server\nVmPeak:\t 120000 kB\nVmRSS:\t  84212 kB\n",
			),
		).toBe(84_212);
		expect(parseVmRssKb("Name:\twt-server\nVmPeak:\t 120000 kB\n")).toBeNull();
		expect(parseVmRssKb("VmRSS:\tnot-a-number kB\n")).toBeNull();
		expect(parseVmRssKb("")).toBeNull();
	});

	test("parses MemTotal and MemAvailable from meminfo and refuses partial text", () => {
		expect(
			parseMeminfoKb(
				"MemTotal:       65805292 kB\nMemFree:        1203944 kB\nMemAvailable:   58223104 kB\n",
			),
		).toEqual({ totalKb: 65_805_292, availableKb: 58_223_104 });
		expect(parseMeminfoKb("MemTotal:       65805292 kB\n")).toBeNull();
		expect(parseMeminfoKb("MemAvailable:   x kB\nMemTotal: 1 kB\n")).toBeNull();
		expect(parseMeminfoKb("")).toBeNull();
	});

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
	});
});
