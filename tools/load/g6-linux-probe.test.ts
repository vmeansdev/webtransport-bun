import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	cpuJiffiesToSec,
	DEFAULT_MAX_BYTES,
	effectiveSocketBufferSummary,
	JsonlBudget,
	parseLinuxProbeDetailMode,
	parseLoadavg,
	parseNetRxSoftirq,
	parseProcSelfStatCpu,
	parseProcsRunning,
	parseSchedstat,
	parseShards,
	parseSoftnetStat,
	parseSsSocketMemory,
	shardSocketInodeProblem,
} from "./g6-linux-probe.ts";
import {
	discoverOwnedUdpInodes,
	type ProbeProcIo,
	parseOwnedUdpSocketTablesByShard,
	sampleProbeUdp,
} from "./g6-sharded-diagnostic.ts";

const roots: string[] = [];
const udpHeader =
	"sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode ref pointer drops";
const udpRow = (inode: string) =>
	`0: 0100007F:0011 00000000:0000 07 0000000A:00000014 00:00000000 00000000 0 0 ${inode} 2 00000000 3`;
const udp6Header = udpHeader.replace("rem_address", "remote_address");
const udp6Row = (inode: string) =>
	udpRow(inode)
		.replace("0100007F", "00000000000000000000000001000000")
		.replace("00000000:0000", "00000000000000000000000000000000:0000");
test("mixed FD discovery freezes only owned UDP and rejects ambiguous or missing rows", () => {
	const tables = `${udpHeader}\n${udpRow("111")}\n${udpRow("222")}`;
	expect([
		...discoverOwnedUdpInodes(
			new Set(["111", "900", "901", "902", "903"]),
			tables,
			udp6Header,
		),
	]).toEqual(["111"]);
	expect([
		...discoverOwnedUdpInodes(
			new Set(["111", "222"]),
			`${udpHeader}\n${udpRow("111")}`,
			`${udp6Header}\n${udp6Row("222")}`,
		),
	]).toEqual(["111", "222"]);
	for (const [fds, v4, v6] of [
		[new Set(["900"]), tables, udp6Header],
		[new Set(["111"]), `${tables}\n${udpRow("111")}`, udp6Header],
		[new Set(["111"]), tables, `${udp6Header}\n${udp6Row("111")}`],
		[new Set(["111"]), `${tables}\nmalformed`, udp6Header],
		[new Set(["111"]), tables, ""],
		[
			new Set(["1", "2", "3", "4", "5"]),
			`${udpHeader}\n${[1, 2, 3, 4, 5].map((x) => udpRow(String(x))).join("\n")}`,
			udp6Header,
		],
	] as const)
		expect(() => discoverOwnedUdpInodes(fds, v4, v6)).toThrow();
});
test("probe snapshots preserve counters and reject frozen process, FD and socket changes", () => {
	const stat = `101 (target) ${["S", ...Array(18).fill("0"), "12345", ...Array(5).fill("0")].join(" ")}`;
	const files: Record<string, string> = {
		"/proc/101/stat": stat,
		"/proc/101/net/udp": `${udpHeader}\n${udpRow("111")}`,
		"/proc/101/net/udp6": udp6Header,
	};
	const links: Record<string, string> = {
		"/proc/101/ns/net": "net:[7]",
		"/proc/101/fd/3": "socket:[111]",
		"/proc/101/fd/4": "socket:[900]",
	};
	const io: ProbeProcIo = {
		read: (path) => {
			if (!(path in files))
				throw Object.assign(Error("missing"), { code: "ENOENT" });
			return files[path] as string;
		},
		link: (path) => {
			if (!(path in links)) throw Error("unreadable owner");
			return links[path] as string;
		},
		list: () => ["3", "4"],
	};
	const targets = [{ serverId: 1, pid: 101 }],
		initial = sampleProbeUdp(targets, undefined, io);
	expect(initial.counters.get(1)).toMatchObject({
		rxQueueBytes: 20,
		txQueueBytes: 10,
		drops: 3,
		socketCount: 1,
	});
	for (const mutate of [
		() => {
			files["/proc/101/stat"] = stat.replace("12345", "12346");
		},
		() => {
			delete files["/proc/101/stat"];
		},
		() => {
			files["/proc/101/stat"] = stat.replace(") S ", ") ? ");
		},
		() => {
			files["/proc/101/stat"] = stat.replace(") S 0 ", ") S broken ");
		},
		() => {
			links["/proc/101/ns/net"] = "net:[8]";
		},
		() => {
			links["/proc/101/fd/3"] = "socket:[222]";
			files["/proc/101/net/udp"] = `${udpHeader}\n${udpRow("222")}`;
		},
		() => {
			links["/proc/101/fd/3"] = "socket:[900]";
		},
		() => {
			delete links["/proc/101/fd/3"];
		},
		() => {
			files["/proc/101/net/udp"] =
				`${udpHeader}\n${udpRow("111").replace("0100007F", "garbage")}`;
		},
	]) {
		const fsCopy = { ...files },
			lsCopy = { ...links };
		mutate();
		expect(() => sampleProbeUdp(targets, initial.identities, io)).toThrow();
		for (const key of Object.keys(files)) delete files[key];
		Object.assign(files, fsCopy);
		for (const key of Object.keys(links)) delete links[key];
		Object.assign(links, lsCopy);
	}
	expect(() =>
		sampleProbeUdp(targets, initial.identities, {
			...io,
			list: () => ["3", "3"],
		}),
	).toThrow();
	expect(() =>
		sampleProbeUdp(targets, initial.identities, {
			...io,
			read: (path) => {
				if (path.endsWith("udp6"))
					throw Object.assign(Error("denied"), { code: "EACCES" });
				return io.read(path);
			},
		}),
	).toThrow();
	delete files["/proc/101/net/udp6"];
	files["/proc/sys/net/ipv6/conf/all/disable_ipv6"] = "0";
	expect(() => sampleProbeUdp(targets, initial.identities, io)).toThrow();
	files["/proc/sys/net/ipv6/conf/all/disable_ipv6"] = "1";
	expect(
		sampleProbeUdp(targets, initial.identities, io).counters.get(1)
			?.socketCount,
	).toBe(1);
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("g6-linux-probe parsers", () => {
	test("an active sampler cannot declare itself disabled or an unknown mode", () => {
		expect(parseLinuxProbeDetailMode("on")).toBe("on");
		for (const mode of [null, "off", "garbage", "0", ""]) {
			expect(() => parseLinuxProbeDetailMode(mode)).toThrow();
		}
	});
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
	}, 15_000);
	test("sums NET_RX counters across CPUs and fails malformed input closed", () => {
		expect(parseNetRxSoftirq("NET_RX: 1 2 3\n")).toBe(6);
		expect(parseNetRxSoftirq("NET_RX: 1 nope 3\n")).toBeNull();
		expect(parseNetRxSoftirq("TIMER: 1 2\n")).toBeNull();
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

	test("summarizes effective socket buffers only when every shard reports one uniform value", () => {
		const uniform = effectiveSocketBufferSummary(
			new Map([
				[101, { receiveBufferBytes: 212_992, sendBufferBytes: 26_214_400 }],
				[202, { receiveBufferBytes: 212_992, sendBufferBytes: 26_214_400 }],
			]),
			[{ pid: 101 }, { pid: 202 }],
		);
		expect(uniform).toEqual({
			effectiveReceiveBufferBytes: 212_992,
			effectiveSendBufferBytes: 26_214_400,
		});
		expect(
			effectiveSocketBufferSummary(
				new Map([[101, { receiveBufferBytes: 212_992, sendBufferBytes: 1 }]]),
				[{ pid: 101 }, { pid: 202 }],
			),
		).toEqual({
			effectiveReceiveBufferBytes: null,
			effectiveSendBufferBytes: null,
		});
		expect(
			effectiveSocketBufferSummary(
				new Map([
					[101, { receiveBufferBytes: 212_992, sendBufferBytes: 26_214_400 }],
					[202, { receiveBufferBytes: 425_984, sendBufferBytes: 13_107_200 }],
				]),
				[{ pid: 101 }, { pid: 202 }],
			),
		).toEqual({
			effectiveReceiveBufferBytes: null,
			effectiveSendBufferBytes: null,
		});
	}, 15_000);

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
	}, 15_000);

	test("accepts one to four shard socket inodes and refuses empty or spilled sets", () => {
		expect(shardSocketInodeProblem(1, 1)).toBeNull();
		expect(shardSocketInodeProblem(1, 4)).toBeNull();
		expect(shardSocketInodeProblem(1, 0)).toBe(
			"server 1 owns 0 UDP socket inodes",
		);
		expect(shardSocketInodeProblem(7, 5)).toBe(
			"server 7 owns 5 UDP socket inodes",
		);
	}, 15_000);

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
	}, 15_000);
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
		expect(budget.append({ schema: "g6-c32-linux-probe/2" }, true)).toBe(true);
		const bytes = Buffer.byteLength(readFileSync(path));
		expect(bytes).toBeLessThanOrEqual(70 * 1024);
		expect(readFileSync(path, "utf8")).toContain("g6-c32-linux-probe/2");
	}, 15_000);

	test("the default artifact budget fits the 50k rung's measured emission", () => {
		const measuredBytesPerSecond = 197_000;
		const fiftyKRungCellSeconds = 300;
		expect(DEFAULT_MAX_BYTES).toBeGreaterThanOrEqual(
			2 * measuredBytesPerSecond * fiftyKRungCellSeconds,
		);
	}, 15_000);
});
