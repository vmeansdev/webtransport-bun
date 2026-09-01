import { SNAPSHOT_HZ, snapshotDatagrams } from "./g6-plan.ts";
import type { RungScan } from "./g6-sharded-grade.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

export const TEST_CANDIDATE = "a".repeat(40);
export const TEST_REGISTRATION = "b".repeat(64);

function rttJson(): unknown {
	const histogram = new LatencyHistogram();
	for (let index = 0; index < 1_000; index += 1) histogram.record(1_000_000);
	return histogram.toJson();
}

export function cleanScan(
	sessions: number,
	shape: {
		endpoints: number;
		connectConcurrency: number;
		connectRatePerSec: number;
		fixedSourcePortBase: number | null;
	},
	shards = 16,
): RungScan {
	const sent = sessions * 4 * 120;
	const issued = sessions * SNAPSHOT_HZ * snapshotDatagrams() * 120;
	const addresses = Array.from(
		{ length: shape.endpoints },
		(_, index) => `0.0.0.0:${40_000 + index}`,
	);
	const report = {
		schema: "mmo-client/2",
		preRegistration: {
			id: "g6-c32-rca-closure-01/1",
			path: ".scratch/registration.md",
			sha256: TEST_REGISTRATION,
		},
		sessionsRequested: sessions,
		sessionsOk: sessions,
		sessionsErr: 0,
		connectConcurrency: shape.connectConcurrency,
		connectRatePerSec: shape.connectRatePerSec,
		connectStarts: {
			offered: sessions,
			achieved: sessions,
			achievedRatePerSec:
				shape.connectRatePerSec === 0 ? null : shape.connectRatePerSec,
		},
		windows: {
			steady: {
				sent,
				sessionsLost: 0,
			},
			steadyDrain: { rxSnapshot: issued, rtt: rttJson() },
		},
		client: { endpointSourceAddresses: addresses },
		config: {
			fixedSourcePortBase: shape.fixedSourcePortBase,
			bindDefault: shape.fixedSourcePortBase === null,
		},
		hostUdp: Object.fromEntries(
			["connect", "steady", "drain", "idle"].map((phase) => [
				phase,
				{ InErrors: 0, RcvbufErrors: 0, SndbufErrors: 0 },
			]),
		),
	};
	return {
		candidateSha: TEST_CANDIDATE,
		config: {
			shards,
			sessions,
			paced: false,
			emitterMode: "native-mirror",
			steadySeconds: 120,
			endpoints: shape.endpoints,
			connectConcurrency: shape.connectConcurrency,
			connectRatePerSec: shape.connectRatePerSec,
			fixedSourcePortBase: shape.fixedSourcePortBase,
		},
		clientExit: 0,
		shards: Array.from({ length: shards }, (_, index) => ({
			serverId: index + 1,
			emitterMode: "native-mirror",
			sessionsAtSteady:
				Math.floor(sessions / shards) + (index < sessions % shards ? 1 : 0),
			windows: {
				steady: {
					rxTotal: sent / shards,
					wallMs: 120_000,
					emitter: { snapshotIssued: issued / shards, sendErrors: 0 },
				},
				steadyDrain: {
					rxTotal: sent / shards,
					wallMs: 121_000,
					emitter: { snapshotIssued: issued / shards, sendErrors: 0 },
				},
			},
		})),
		aggregate: {
			steady: {
				rxTotal: sent,
				emitter: { snapshotIssued: issued, sendErrors: 0 },
			},
			steadyDrain: { emitter: { snapshotIssued: issued } },
		},
		clientStdout: `mmo-client: json ${JSON.stringify(report)}\n`,
	};
}

export function diagnosticFixture(input: {
	sessions: number;
	shape: {
		endpoints: number;
		connectConcurrency: number;
		connectRatePerSec: number;
		fixedSourcePortBase: number | null;
	};
	drops: number;
	steered: number;
	sndbufErrors?: number;
	shards?: number;
}): unknown {
	const shards = input.shards ?? 16;
	const host = (rcvbufErrors: number, sndbufErrors = 0) => ({
		InErrors: rcvbufErrors,
		RcvbufErrors: rcvbufErrors,
		SndbufErrors: sndbufErrors,
	});
	const perShard = (drops: number) =>
		Object.fromEntries(
			Array.from({ length: shards }, (_, index) => [
				String(index + 1),
				{ drops: index === 0 ? drops : 0 },
			]),
		);
	return {
		schema: "g6-sharded-diagnostic/2",
		candidateSha: TEST_CANDIDATE,
		dispatch: {
			shards,
			sessions: input.sessions,
			endpoints: input.shape.endpoints,
			connectConcurrency: input.shape.connectConcurrency,
			connectRatePerSec: input.shape.connectRatePerSec,
			fixedSourcePortBase: input.shape.fixedSourcePortBase,
		},
		ladder: [
			{
				rung: input.sessions,
				connectWallSec: 1,
				T0: { perShardUdp: perShard(0) },
				T2: { perShardUdp: perShard(input.drops) },
			},
		],
		serverHostUdp: {
			connect: host(0),
			steady: host(input.drops),
			drain: host(input.drops, input.sndbufErrors ?? 0),
			idle: host(input.drops, input.sndbufErrors ?? 0),
		},
		bpfPreArm: {
			fresh: true,
			socksEntries: shards,
			receiptValidation: { valid: true, instances: shards },
			steerStats: { steered: 0, fallback: 0 },
		},
		postRunSteering: {
			capturedAtMs: 1,
			steerStatsSum: { steered: input.steered, fallback: 0 },
		},
		perShardLifecycle: Array.from({ length: shards }, (_, index) => ({
			serverId: index + 1,
			boundaries: ["connect", "steady", "drain", "idle", "stop"].map(
				(phase) => ({ phase }),
			),
			exits: [{ code: 0, signal: null }],
		})),
	};
}

export function steeringDump(value: number): string {
	return JSON.stringify([{ key: 0, values: [{ cpu: 0, value }] }]);
}
