import { describe, expect, test } from "bun:test";
import {
	parseConnectErrorsSample,
	parseOwnedUdpSocketTable,
	selectMidpointSample,
} from "./g6-sharded-diagnostic.ts";

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
});
