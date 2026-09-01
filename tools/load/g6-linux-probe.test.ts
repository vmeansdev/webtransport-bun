import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	JsonlBudget,
	parseNetRxSoftirq,
	parseSchedstat,
	parseShards,
	parseSoftnetStat,
	parseSsSocketMemory,
	shardSocketInodeProblem,
	parseProcSelfStatCpu,
	parseLoadavg,
	parseProcsRunning,
	cpuJiffiesToSec,
} from "./g6-linux-probe.ts";
import { parseOwnedUdpSocketTablesByShard } from "./g6-sharded-diagnostic.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("g6-linux-probe parsers", () => {
	test("parses one shared UDP table into each shard without rereading proc per shard", () => {
		const targets = [
			{ serverId: 1, pid: 101, inodes: new Set(["111"]) },
			{ serverId: 2, pid: 102, inodes: new Set(["222"]) },
		];
		const table = [
			"sl local_address rem_address st tx_queue tr tm->when retrnsmt uid timeout inode ref pointer rto",
			"0: 0100007F:11 00000000:00 07 00000000:00000000 00:00000000 00000000 0 0 111 2 00000000 0",
			"1: 0100007F:12 00000000:00 07 00000000:00000000 00:00000000 00000000 0 0 222 2 00000000 3",
		].join("\n");
		expect(parseOwnedUdpSocketTablesByShard(targets, table, "")).toEqual(
			new Map([
				[1, expect.objectContaining({ socketCount: 1, drops: 0 })],
				[2, expect.objectContaining({ socketCount: 1, drops: 3 })],
			]),
		);
	});
	test("sums NET_RX counters across CPUs and fails malformed input closed", () => {
		expect(parseNetRxSoftirq("NET_RX: 1 2 3\n")).toBe(6);
		expect(parseNetRxSoftirq("NET_RX: 1 nope 3\n")).toBeNull();
		expect(parseNetRxSoftirq("TIMER: 1 2\n")).toBeNull();
	});

	test("sums softnet hexadecimal counters and parses schedstat", () => {
		expect(
			parseSoftnetStat(
				"0000000a 00000001 00000002\n0000000b 00000003 00000004\n",
			),
		).toEqual({
			processed: 21,
			dropped: 4,
			timeSqueeze: 6,
		});
		expect(parseSoftnetStat("bad-row\n")).toBeNull();
		expect(parseSchedstat("10 20 30\n")).toEqual({
			runtimeNs: 10,
			waitNs: 20,
			timeslices: 30,
		});
		expect(parseSchedstat("10 -1 30\n")).toBeNull();
	});

	test("associates ss skmem only with the owning socket process", () => {
		const parsed = parseSsSocketMemory(
			[
				'UNCONN 0 0 0.0.0.0:4433 0.0.0.0:* users:(("bun",pid=101,fd=9))',
				" skmem:(r0,rb212992,t0,tb212992,f0,w0,o0,bl0,d0)",
				"UNCONN 0 0 0.0.0.0:4434 0.0.0.0:*",
				" skmem:(r0,rb999999,t0,tb888888,f0,w0,o0,bl0,d0)",
				'UNCONN 0 0 0.0.0.0:4435 0.0.0.0:* users:(("bun",pid=202,fd=10))',
				" skmem:(r0,rb425984,t0,tb425984,f0,w0,o0,bl0,d0)",
			].join("\n"),
		);
		expect(parsed.get(101)).toEqual({
			receiveBufferBytes: 212_992,
			sendBufferBytes: 212_992,
		});
		expect(parsed.get(202)).toEqual({
			receiveBufferBytes: 425_984,
			sendBufferBytes: 425_984,
		});
		expect(parsed.size).toBe(2);
	});

	test("requires exactly one unique PID for each contiguous server ID 1 through N", () => {
		const list = (count: number) =>
			Array.from(
				{ length: count },
				(_, index) => `${index + 1}=${100 + index}`,
			).join(",");
		for (const count of [1, 16, 24, 32, 64]) {
			expect(parseShards(list(count)).map((entry) => entry.serverId)).toEqual(
				Array.from({ length: count }, (_, index) => index + 1),
			);
		}
		expect(() => parseShards(list(16).replace("16=115", "15=115"))).toThrow();
		expect(() => parseShards(list(24).replace("24=123", "25=123"))).toThrow();
		expect(() => parseShards(list(65))).toThrow();
		expect(() => parseShards("")).toThrow();
	});

	test("accepts one to four shard socket inodes and refuses empty or spilled sets", () => {
		expect(shardSocketInodeProblem(1, 1)).toBeNull();
		expect(shardSocketInodeProblem(1, 4)).toBeNull();
		expect(shardSocketInodeProblem(1, 0)).toBe(
			"server 1 owns 0 UDP socket inodes",
		);
		expect(shardSocketInodeProblem(7, 5)).toBe(
			"server 7 owns 5 UDP socket inodes",
		);
	});

	test("parses probe self-CPU and host run-queue from proc text", () => {
		expect(
			parseProcSelfStatCpu(
				"10 (bun --eval) S 1 1 1 0 -1 0 0 0 0 0 40 10 0 0\n",
			),
		).toEqual({ userJiffies: 40, systemJiffies: 10 });
		expect(parseProcSelfStatCpu("bad\n")).toBeNull();
		expect(parseLoadavg("1.25 0.50 0.25 2/180 99\n")).toEqual({
			load1: 1.25,
			load5: 0.5,
			load15: 0.25,
		});
		expect(parseLoadavg("nope\n")).toBeNull();
		expect(parseProcsRunning("cpu 1 2 3\nprocs_running 4\n")).toBe(4);
		expect(parseProcsRunning("cpu 1 2 3\n")).toBeNull();
		expect(cpuJiffiesToSec(250, 100)).toBe(2.5);
		expect(cpuJiffiesToSec(-1, 100)).toBeNull();
	});
});

describe("g6-linux-probe artifact budget", () => {
	test("reserves room for the terminal record and never exceeds the cap", () => {
		const tempBase = process.env.TMPDIR;
		if (!tempBase) throw new Error("test requires worktree-local TMPDIR");
		const root = mkdtempSync(join(tempBase, "g6-linux-probe-"));
		roots.push(root);
		const path = join(root, "probe.jsonl");
		const budget = new JsonlBudget(path, 70 * 1024);
		expect(budget.append({ payload: "x".repeat(7 * 1024) })).toBe(false);
		expect(budget.truncated).toBe(true);
		expect(budget.append({ schema: "g6-c32-linux-probe/1" }, true)).toBe(true);
		const bytes = Buffer.byteLength(readFileSync(path));
		expect(bytes).toBeLessThanOrEqual(70 * 1024);
		expect(readFileSync(path, "utf8")).toContain("g6-c32-linux-probe/1");
	});

	test("the default artifact budget fits the 50k rung's measured emission", () => {
		const measuredBytesPerSecond = 197_000;
		const fiftyKRungCellSeconds = 300;
		expect(DEFAULT_MAX_BYTES).toBeGreaterThanOrEqual(
			2 * measuredBytesPerSecond * fiftyKRungCellSeconds,
		);
	});
});
