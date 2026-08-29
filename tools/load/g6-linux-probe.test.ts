import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	JsonlBudget,
	parseNetRxSoftirq,
	parseSchedstat,
	parseShards,
	parseSoftnetStat,
	parseSsSocketMemory,
	shardSocketInodeProblem,
} from "./g6-linux-probe.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("g6-linux-probe parsers", () => {
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

	test("requires exactly one unique PID for each server ID 1 through 16", () => {
		const valid = Array.from(
			{ length: 16 },
			(_, index) => `${index + 1}=${100 + index}`,
		).join(",");
		expect(parseShards(valid).map((entry) => entry.serverId)).toEqual(
			Array.from({ length: 16 }, (_, index) => index + 1),
		);
		expect(() => parseShards(valid.replace("16=115", "15=115"))).toThrow();
		expect(() => parseShards("1=100")).toThrow();
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
});
