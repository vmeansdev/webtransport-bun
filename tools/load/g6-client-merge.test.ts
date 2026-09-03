import { describe, expect, test } from "bun:test";
import {
	allocateClientProcesses,
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
