import { describe, expect, test } from "bun:test";
import { analyzeOverflowDiscrimination } from "./g6-sharded-overflow-discrimination.ts";

const udp = (rcvbufErrors: number) => ({
	InDatagrams: 100 + rcvbufErrors,
	NoPorts: 0,
	InErrors: rcvbufErrors,
	OutDatagrams: 200,
	RcvbufErrors: rcvbufErrors,
	SndbufErrors: 0,
});

function hostUdp(finalRcvbufErrors: number) {
	return {
		connect: udp(0),
		steady: udp(finalRcvbufErrors),
		drain: udp(finalRcvbufErrors),
		idle: udp(finalRcvbufErrors),
	};
}

function server(overrides: Record<string, unknown> = {}) {
	return {
		schema: "g6-sharded-diagnostic/2",
		serverHostUdp: hostUdp(0),
		bpfPreArm: {
			fresh: true,
			socksEntries: 0,
			steerStats: { steered: 0, fallback: 0 },
		},
		ladder: [
			{
				rung: 50_000,
				T0: { perShardUdp: { 0: { drops: 3 } } },
				T1: { perShardUdp: { 0: { drops: 3 } } },
				T2: { perShardUdp: { 0: { drops: 3 } } },
			},
		],
		perShardLifecycle: [
			{
				serverId: 0,
				boundaries: [
					{ phase: "connect", tsMs: 1 },
					{ phase: "steady", tsMs: 2 },
					{ phase: "drain", tsMs: 3 },
					{ phase: "idle", tsMs: 4 },
					{ phase: "stop", tsMs: 5 },
				],
			},
		],
		...overrides,
	};
}

function generator(hostUdpOverride: unknown = hostUdp(0)) {
	return { schema: "mmo-client/2", hostUdp: hostUdpOverride };
}

describe("G6 sharded overflow discrimination", () => {
	test("classifies generator-only RcvbufErrors growth", () => {
		const verdict = analyzeOverflowDiscrimination(
			server(),
			generator(hostUdp(4)),
		);
		expect(verdict.classification).toBe("GENERATOR_UDP_RECEIVE_OVERFLOW");
		expect(verdict.deltas.generatorHostUdp?.total.RcvbufErrors).toBe(4);
		expect(verdict.deltas.serverHostUdp?.total.RcvbufErrors).toBe(0);
	});

	test("classifies server-only RcvbufErrors growth", () => {
		const verdict = analyzeOverflowDiscrimination(
			server({ serverHostUdp: hostUdp(6) }),
			generator(),
		);
		expect(verdict.classification).toBe("SERVER_UDP_RECEIVE_OVERFLOW");
		expect(verdict.deltas.serverHostUdp?.total.RcvbufErrors).toBe(6);
	});

	test("classifies RcvbufErrors growth on both hosts", () => {
		const verdict = analyzeOverflowDiscrimination(
			server({ serverHostUdp: hostUdp(6) }),
			generator(hostUdp(4)),
		);
		expect(verdict.classification).toBe("BIDIRECTIONAL_UDP_RECEIVE_OVERFLOW");
	});

	test("classifies server socket or steering pressure when host errors stay flat but shard drops grow", () => {
		const verdict = analyzeOverflowDiscrimination(
			server({
				ladder: [
					{
						rung: 50_000,
						T0: { perShardUdp: { 0: { drops: 3 } } },
						T1: { perShardUdp: { 0: { drops: 5 } } },
						T2: { perShardUdp: { 0: { drops: 9 } } },
					},
				],
			}),
			generator(),
		);
		expect(verdict.classification).toBe("SERVER_SOCKET_OR_STEERING_PRESSURE");
		expect(verdict.deltas.perShardSocketDrops[0]?.t0ToT2).toBe(6);
	});

	test("preserves each explicit ladder rung in socket-drop evidence", () => {
		const verdict = analyzeOverflowDiscrimination(
			server({
				ladder: [
					{
						rung: 50_000,
						T0: { perShardUdp: { 0: { drops: 3 } } },
						T1: { perShardUdp: { 0: { drops: 3 } } },
						T2: { perShardUdp: { 0: { drops: 3 } } },
					},
					{
						rung: 75_000,
						T0: { perShardUdp: { 0: { drops: 4 } } },
						T1: { perShardUdp: { 0: { drops: 4 } } },
						T2: { perShardUdp: { 0: { drops: 4 } } },
					},
				],
			}),
			generator(),
		);
		expect(
			verdict.evidence.perShardSocketDrops.map((sample) => sample.rung),
		).toEqual([50_000, 75_000]);
	});

	test.each([
		[
			"missing phase",
			server({
				serverHostUdp: { connect: udp(0), steady: udp(0), idle: udp(0) },
			}),
			generator(),
			"serverHostUdp must contain exactly connect,steady,drain,idle",
		],
		[
			"counter regression",
			server({
				serverHostUdp: {
					connect: udp(3),
					steady: udp(2),
					drain: udp(2),
					idle: udp(2),
				},
			}),
			generator(),
			"serverHostUdp has a missing, invalid, or decreasing counter",
		],
		[
			"invalid phase order",
			server({
				perShardLifecycle: [
					{
						serverId: 0,
						boundaries: [
							{ phase: "connect", tsMs: 1 },
							{ phase: "drain", tsMs: 2 },
						],
					},
				],
			}),
			generator(),
			"server shard 0 phase sequence must be connect,steady,drain,idle,stop",
		],
		[
			"stale BPF pre-arm state",
			server({
				bpfPreArm: {
					fresh: false,
					socksEntries: 1,
					steerStats: { steered: 0, fallback: 0 },
				},
			}),
			generator(),
			"server bpfPreArm.fresh must be true",
		],
	] as const)("refuses %s", (_name, serverArtifact, generatorReport, reason) => {
		const verdict = analyzeOverflowDiscrimination(
			serverArtifact,
			generatorReport,
		);
		expect(verdict.classification).toBe("INCONCLUSIVE");
		expect(verdict.reasons).toContain(reason);
	});
});
