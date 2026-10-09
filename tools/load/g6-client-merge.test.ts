import { describe, expect, test } from "bun:test";
import {
	allocateClientProcesses,
	evenShare,
	mergeClientReports,
	mergeHistograms,
} from "./g6-client-merge.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";

function hist(samplesNs: number[]): LatencyHistogramJson {
	const h = new LatencyHistogram();
	for (const ns of samplesNs) h.record(ns);
	return h.toJson();
}

function report(over: Record<string, unknown>): Record<string, unknown> {
	const window = (sent: number, rtt: LatencyHistogramJson) => ({
		sent,
		sendErr: 0,
		scheduleTicksDue: sent,
		scheduleTicksFired: sent,
		scheduleTicksSkipped: 0,
		scheduleTicksUnpresented: 0,
		scheduleTicksReconciled: true,
		rxSnapshot: sent * 3,
		rxAck: sent,
		rxRaid: 0,
		rxOther: 0,
		rxUnstamped: 0,
		ackUnreflected: 0,
		sessionsLost: 0,
		scheduleLag: hist([1000, 2000]),
		rtt: rtt,
		oneWay: hist([500]),
		serverHold: hist([100]),
	});
	return {
		schema: "mmo-client/2",
		startedAt: "2026-09-03T21:00:00.000Z",
		preRegistration: { id: "g6", path: "p", sha256: "s" },
		role: "realm",
		staggerSends: true,
		sessionsRequested: 10,
		activeWorkloadSessions: 10,
		sessionsOk: 10,
		sessionsErr: 0,
		sessionsLost: 0,
		connectWallSec: 1,
		connectTimedOut: false,
		connectConcurrency: 5,
		connectRatePerSec: 25,
		connectStarts: { offered: 10, achieved: 10, achievedRatePerSec: 25 },
		acceptMs: { p50: 2, p90: 3, p99: 4, max: 8 },
		storm: { ran: false },
		phaseBarrier: null,
		windows: {
			steady: window(100, hist([1_000_000, 2_000_000])),
			steadyDrain: window(110, hist([1_000_000, 3_000_000])),
			stormSurvivors: window(0, hist([])),
		},
		lifetime: window(120, hist([1_000_000])),
		quicSteady: {
			connections: 10,
			frameTxDatagram: 100,
			frameRxDatagram: 300,
			sentPackets: 400,
			lostPackets: 1,
		},
		quicDrive: {
			connections: 10,
			frameTxDatagram: 110,
			frameRxDatagram: 330,
			sentPackets: 440,
			lostPackets: 2,
		},
		client: {
			rssMbSteady: 100,
			rssMbDrive: 101,
			rssMbIdle: 102,
			cpuMsConnect: 10,
			cpuMsSteady: 1000,
			cpuMsDrive: 1010,
			cpuMsIdle: 5,
			endpoints: 2,
			distinctSourceIps: 0,
			endpointSourceAddresses: ["0.0.0.0:20000", "0.0.0.0:20001"],
		},
		config: { fixedSourcePortBase: 20000, bindDefault: false },
		hostUdp: { connect: null, steady: null, drain: null, idle: null },
		connectErrorsSample: [],
		...over,
	};
}

describe("g6 client merge", () => {
	test("splits sessions, endpoints and port ranges without overlap", () => {
		const parts = allocateClientProcesses({
			processes: 2,
			sessions: 3001,
			activeSessions: 3001,
			endpoints: 128,
			fixedSourcePortBase: 20000,
		});
		expect(parts).toEqual([
			{
				index: 0,
				sessions: 1501,
				activeSessions: 1501,
				endpoints: 64,
				fixedSourcePortBase: 20000,
			},
			{
				index: 1,
				sessions: 1500,
				activeSessions: 1500,
				endpoints: 64,
				fixedSourcePortBase: 20064,
			},
		]);
		expect(
			allocateClientProcesses({
				processes: 1,
				sessions: 7,
				activeSessions: 7,
				endpoints: 3,
				fixedSourcePortBase: null,
			}),
		).toEqual([
			{
				index: 0,
				sessions: 7,
				activeSessions: 7,
				endpoints: 3,
				fixedSourcePortBase: null,
			},
		]);
		expect(() =>
			allocateClientProcesses({
				processes: 3,
				sessions: 30,
				activeSessions: 30,
				endpoints: 2,
				fixedSourcePortBase: 20000,
			}),
		).toThrow(/endpoints/);
	});

	test("merges histograms by summing bucket counts and keeping the extremes", () => {
		const a = hist([1_000_000, 2_000_000, 5_000_000]);
		const b = hist([3_000_000, 50_000_000]);
		const merged = mergeHistograms([a, b]);
		expect(merged.count).toBe(5);
		expect(merged.recordedTotal).toBe(5);
		expect(merged.minNs).toBe(1_000_000);
		expect(merged.maxNs).toBe(50_000_000);
		expect(merged.sumNs).toBe(61_000_000);
		const summary = LatencyHistogram.fromJson(merged).summary();
		const all = LatencyHistogram.fromJson(
			hist([1_000_000, 2_000_000, 5_000_000, 3_000_000, 50_000_000]),
		).summary();
		expect(summary).toEqual(all);
		expect(() =>
			mergeHistograms([a, { ...b, subBits: a.subBits + 1 }]),
		).toThrow(/subBits/);
	});

	test("sums counters, merges every histogram, and keeps the report shape the graders read", () => {
		const a = report({});
		const b = report({
			sessionsRequested: 12,
			activeWorkloadSessions: 12,
			sessionsOk: 11,
			sessionsErr: 1,
			connectWallSec: 2.5,
			connectTimedOut: true,
			connectStarts: { offered: 12, achieved: 11, achievedRatePerSec: 30 },
			acceptMs: { p50: 1, p90: 5, p99: 9, max: 20 },
			connectErrorsSample: ["closed by peer: 263"],
			client: {
				...(report({}).client as Record<string, unknown>),
				endpoints: 3,
				endpointSourceAddresses: [
					"0.0.0.0:20064",
					"0.0.0.0:20065",
					"0.0.0.0:20066",
				],
			},
		});
		const m = mergeClientReports([a, b]) as Record<string, unknown>;
		expect(m.schema).toBe("mmo-client/2");
		expect(m.sessionsRequested).toBe(22);
		expect(m.sessionsOk).toBe(21);
		expect(m.sessionsErr).toBe(1);
		expect(m.connectWallSec).toBe(2.5);
		expect(m.connectTimedOut).toBe(true);
		expect(m.connectConcurrency).toBe(10);
		expect(m.connectRatePerSec).toBe(50);
		expect(m.connectStarts).toEqual({
			offered: 22,
			achieved: 21,
			achievedRatePerSec: 55,
		});
		// Percentiles of separate populations cannot be merged; the worst is
		// the honest bound the graders can read.
		expect(m.acceptMs).toEqual({ p50: 2, p90: 5, p99: 9, max: 20 });
		const steady = m.windows as Record<string, Record<string, unknown>>;
		expect(steady.steady?.sent).toBe(200);
		expect(steady.steady?.rxSnapshot).toBe(600);
		expect((steady.steadyDrain?.rtt as LatencyHistogramJson).count).toBe(4);
		expect((steady.steadyDrain?.rtt as LatencyHistogramJson).maxNs).toBe(
			3_000_000,
		);
		expect((m.quicSteady as Record<string, number>).lostPackets).toBe(2);
		const client = m.client as Record<string, unknown>;
		expect(client.cpuMsSteady).toBe(2000);
		expect(client.endpoints).toBe(5);
		expect(client.endpointSourceAddresses).toHaveLength(5);
		expect(m.connectErrorsSample).toEqual(["closed by peer: 263"]);
		expect(m.clientProcesses).toBe(2);
		expect(m.config).toEqual(a.config);
	});

	test("refuses to merge nothing or reports of different schemas", () => {
		expect(() => mergeClientReports([])).toThrow(/no reports/);
		expect(() =>
			mergeClientReports([report({}), report({ schema: "mmo-client/1" })]),
		).toThrow(/schema/);
	});
});

describe("evenShare", () => {
	test("connect shape shares sum to exactly the registered totals", () => {
		for (const [total, n] of [
			[50, 4],
			[250, 4],
			[500, 3],
			[7, 7],
			[0, 4],
		] as const) {
			const shares = Array.from({ length: n }, (_, i) =>
				evenShare(total, n, i),
			);
			expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
			expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
		}
		expect([0, 1, 2, 3].map((i) => evenShare(50, 4, i))).toEqual([
			13, 13, 12, 12,
		]);
		expect([0, 1, 2, 3].map((i) => evenShare(250, 4, i))).toEqual([
			63, 63, 62, 62,
		]);
	});
	test("rejects impossible shares", () => {
		expect(() => evenShare(10, 0, 0)).toThrow();
		expect(() => evenShare(10, 2, 2)).toThrow();
		expect(() => evenShare(-1, 2, 0)).toThrow();
		expect(() => evenShare(1.5, 2, 0)).toThrow();
	});
});

// biome-ignore lint/suspicious/noExplicitAny: the test reads nested report JSON
type Json = any;

describe("sharded arms block merge", () => {
	const armsBlock = (over: {
		steadyEntry: Record<string, number>;
		rtt: LatencyHistogramJson;
		severUnixMs: number;
		late: LatencyHistogramJson;
	}) => ({
		shardCount: 2,
		targetSlot: null,
		targetServerId: null,
		dcidLen: 20,
		serverCidLen: 11,
		dcidHashPlaced: true,
		placement: "fnv1a32-first8-mod-shardCount",
		raidMembership: "legacy",
		raidJoinsSent: 0,
		sessionsByShard: {
			steadyEntry: over.steadyEntry,
			stormEnd: over.steadyEntry,
			idle: null,
		},
		shards: {
			"1": { steadyDrain: { rxAck: 3, rtt: over.rtt } },
			"2": { steadyDrain: { rxAck: 1, rtt: over.rtt } },
		},
		storm: {
			timeline: "anchored",
			cohort: 5,
			reconnectDelayMs: 1000,
			severUnixMs: over.severUnixMs,
			stormStartUnixMs: over.severUnixMs + 1000,
			severedClosed: 5,
			reconnectInitials: 5,
			initialIssueClock: "dcid-provider-call",
			reconnectInitialLate: over.late,
		},
	});

	test("counts sum per shard, histograms merge, storm instants stay per process", () => {
		const a = {
			schema: "mmo-client/2",
			sessionsOk: 3,
			arms: armsBlock({
				steadyEntry: { "1": 2, "2": 1 },
				rtt: hist([1_000_000, 2_000_000]),
				severUnixMs: 10_000,
				late: hist([3_000_000]),
			}),
		};
		const b = {
			schema: "mmo-client/2",
			sessionsOk: 2,
			arms: armsBlock({
				steadyEntry: { "1": 0, "2": 2 },
				rtt: hist([5_000_000]),
				severUnixMs: 10_040,
				late: hist([9_000_000]),
			}),
		};
		const merged = mergeClientReports([a, b]);
		const arms = merged.arms as Record<string, Json>;
		expect(arms.shardCount).toBe(2);
		expect(arms.dcidLen).toBe(20);
		expect(arms.sessionsByShard.steadyEntry).toEqual({ "1": 2, "2": 3 });
		expect(arms.sessionsByShard.idle).toBeNull();
		expect(arms.shards["1"].steadyDrain.rxAck).toBe(6);
		expect(arms.shards["2"].steadyDrain.rtt.count).toBe(3);
		expect(arms.storm.cohort).toBe(10);
		expect(arms.storm.severSkewMs).toBe(40);
		expect(arms.storm.reconnectInitialLate.count).toBe(2);
		expect(arms.storm.processes.map((p: Json) => p.severUnixMs)).toEqual([
			10_000, 10_040,
		]);
		expect(arms.storm.processes[1].reconnectInitialLateMaxNs).toBe(
			hist([9_000_000]).maxNs,
		);
		// A single process still gets the merged shape.
		const single = mergeClientReports([a]).arms as Record<string, Json>;
		expect(single.storm.severSkewMs).toBe(0);
		// Steady-path reports carry no arms block and gain none.
		expect(
			"arms" in
				mergeClientReports([
					{ schema: "mmo-client/2" },
					{ schema: "mmo-client/2" },
				]),
		).toBe(false);
		expect(() => mergeClientReports([a, { schema: "mmo-client/2" }])).toThrow(
			"arms block missing",
		);
		expect(() =>
			mergeClientReports([a, { ...b, arms: { ...b.arms, dcidLen: 11 } }]),
		).toThrow("arms.dcidLen");
	});
});

describe("storm summary merge", () => {
	const summary = (over: Record<string, unknown>) => ({
		concurrency: null,
		cohort: 0,
		ran: false,
		windowSec: 120,
		reconnectOk: 0,
		reconnectErr: 0,
		reconnectTotalMs: 0,
		reconnectMeanMs: null,
		reconnectMs: { p50: null, p90: null, p99: null, max: null },
		...over,
	});
	test("a steady process set keeps the first process's summary verbatim", () => {
		const a = { schema: "mmo-client/2", storm: summary({}) };
		const merged = mergeClientReports([a, { ...a }]);
		expect(JSON.stringify(merged.storm)).toBe(JSON.stringify(a.storm));
	});
	test("a storm sums counts across processes and takes the worst percentile", () => {
		const a = {
			schema: "mmo-client/2",
			storm: summary({
				cohort: 50,
				ran: true,
				reconnectOk: 50,
				reconnectTotalMs: 1000,
				reconnectMeanMs: 20,
				reconnectMs: { p50: 20, p90: 25, p99: 30, max: 31 },
			}),
		};
		const b = {
			schema: "mmo-client/2",
			storm: summary({
				cohort: 50,
				ran: true,
				reconnectOk: 49,
				reconnectErr: 1,
				reconnectTotalMs: 1960,
				reconnectMeanMs: 40,
				reconnectMs: { p50: 40, p90: 45, p99: 50, max: 51 },
			}),
		};
		expect(mergeClientReports([a, b]).storm).toEqual(
			summary({
				cohort: 100,
				ran: true,
				reconnectOk: 99,
				reconnectErr: 1,
				reconnectTotalMs: 2960,
				reconnectMeanMs: 2960 / 99,
				reconnectMs: { p50: 40, p90: 45, p99: 50, max: 51 },
			}),
		);
	});
});
