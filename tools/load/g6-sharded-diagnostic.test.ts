import { describe, expect, test } from "bun:test";
import { parseOwnedUdpSocketTable } from "./g6-sharded-diagnostic.ts";

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
