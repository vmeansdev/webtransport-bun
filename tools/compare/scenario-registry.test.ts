import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256Canonical } from "./canonical.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_CONNECTION_SETUP,
	CANONICAL_SCENARIO_REGISTRY,
	SCENARIO_IDS,
	createScenarioRegistry,
	getScenarioCell,
	listScenarioArms,
	listScenarioCells,
	validateScenarioOverride,
} from "./scenario-registry.ts";
import type {
	LinuxRole,
	MacRole,
	ScenarioArm,
	ScenarioCell,
	ScenarioOverride,
	TrafficDirection,
} from "./types.ts";

const EXPECTED_IDS = [
	"chat-fanout",
	"ticker-fanout",
	"game-tick-loss",
	"reconnect-storm",
	"connection-memory",
	"crdt-sync",
	"ai-token-stream",
	"handshake-matrix",
	"bulk-one-way",
	"tail-under-cross-traffic",
] as const;

const EXPECTED_PRIMARY_CELL_IDS: string[] = [
	"chat-fanout/subscribers-1000",
	"chat-fanout/subscribers-5000",
	"chat-fanout/subscribers-10000",
	"ticker-fanout/rate-10000",
	"ticker-fanout/rate-50000",
	"ticker-fanout/rate-100000",
	"game-tick-loss/tick-20-loss-1-delay-20",
	"game-tick-loss/tick-20-loss-1-delay-40",
	"game-tick-loss/tick-20-loss-2.5-delay-20",
	"game-tick-loss/tick-20-loss-2.5-delay-40",
	"game-tick-loss/tick-20-loss-5-delay-20",
	"game-tick-loss/tick-20-loss-5-delay-40",
	"game-tick-loss/tick-60-loss-1-delay-20",
	"game-tick-loss/tick-60-loss-1-delay-40",
	"game-tick-loss/tick-60-loss-2.5-delay-20",
	"game-tick-loss/tick-60-loss-2.5-delay-40",
	"game-tick-loss/tick-60-loss-5-delay-20",
	"game-tick-loss/tick-60-loss-5-delay-40",
	"reconnect-storm/cold-full",
	"reconnect-storm/warm-after-prime",
	"connection-memory/live-1000",
	"connection-memory/live-5000",
	"connection-memory/live-10000",
	"crdt-sync/default",
	"ai-token-stream/chunk-32",
	"ai-token-stream/chunk-64",
	"ai-token-stream/chunk-128",
	"ai-token-stream/chunk-256",
	"handshake-matrix/physical-cold",
	"handshake-matrix/physical-warm-after-prime",
	"handshake-matrix/delay40-cold",
	"handshake-matrix/delay40-warm-after-prime",
	"bulk-one-way/physical",
	"bulk-one-way/delay40-loss1",
	"tail-under-cross-traffic/default",
];

function primaryArmsFor(cellId: string): ScenarioArm[] {
	return listScenarioArms(CANONICAL_SCENARIO_REGISTRY).filter(
		(arm) => arm.cellId === cellId && arm.armKind === "primary",
	);
}

function cell(id: string): ScenarioCell {
	return getScenarioCell(CANONICAL_SCENARIO_REGISTRY, id);
}

describe("frozen v1 comparison scenario registry", () => {
	test("freezes exactly ten scenario IDs and 35 primary workload cells", () => {
		expect(SCENARIO_IDS).toEqual(EXPECTED_IDS);
		expect(listScenarioCells(CANONICAL_SCENARIO_REGISTRY)).toHaveLength(35);
		expect(
			listScenarioCells(CANONICAL_SCENARIO_REGISTRY).map(
				({ cellId }) => cellId,
			),
		).toEqual(EXPECTED_PRIMARY_CELL_IDS);
		expect(
			new Set(
				listScenarioCells(CANONICAL_SCENARIO_REGISTRY).map(
					({ scenarioId }) => scenarioId,
				),
			),
		).toEqual(new Set(EXPECTED_IDS));
	});

	test("creates 35 WS primary, 35 WT primary, and 12 labeled WS overlay arms", () => {
		const arms = listScenarioArms(CANONICAL_SCENARIO_REGISTRY);
		expect(arms).toHaveLength(82);
		expect(
			arms.filter(
				({ armKind, transport }) => armKind === "primary" && transport === "ws",
			),
		).toHaveLength(35);
		expect(
			arms.filter(
				({ armKind, transport }) => armKind === "primary" && transport === "wt",
			),
		).toHaveLength(35);
		const overlays = arms.filter(
			({ armKind }) => armKind === "ws-lossy-overlay",
		);
		expect(overlays).toHaveLength(12);
		expect(
			overlays.every(({ transport }) => transport === "ws-lossy-overlay"),
		).toBe(true);
		expect(
			overlays.every(
				({ label, overlayOf, scenarioId }) =>
					label === "ws-lossy-game-overlay" &&
					overlayOf?.startsWith(`${scenarioId}/`),
			),
		).toBe(true);
	});

	test("freezes the complete capacity and admission profile", () => {
		expect(CANONICAL_CAPACITY_PROFILE).toEqual({
			profileId: "capacity-v1",
			maxSessions: 12_000,
			maxHandshakesInFlight: 512,
			maxStreamsPerSessionBidi: 8,
			maxStreamsPerSessionUni: 8,
			maxStreamsGlobal: 24_000,
			maxDatagramSize: 1_200,
			maxQueuedBytesGlobal: 512 * 1024 * 1024,
			maxQueuedBytesPerSession: 2 * 1024 * 1024,
			maxQueuedBytesPerStream: 256 * 1024,
			backpressureTimeoutMs: 5_000,
			handshakeTimeoutMs: 10_000,
			idleTimeoutMs: 60_000,
			handshakesPerSec: 20_000,
			handshakesBurst: 20_000,
			handshakesBurstPerPrefix: 20_000,
			streamsPerSec: 20_000,
			streamsBurst: 20_000,
			datagramsPerSec: 20_000,
			datagramsBurst: 20_000,
		});
		expect(CANONICAL_CONNECTION_SETUP).toEqual({
			connectionRampPerSecond: 500,
			maxConnectsInFlight: 200,
		});
	});

	test("freezes exact workload parameters for every scenario family", () => {
		expect(cell("chat-fanout/subscribers-1000").parameters).toEqual({
			scenarioId: "chat-fanout",
			subscriberCount: 1_000,
			publisherCount: 10,
			messageBytes: 128,
			messagesPerSecondPerPublisher: 1,
			durationSeconds: 30,
			delivery: "reliable",
		});
		expect(cell("ticker-fanout/rate-100000").parameters).toEqual({
			scenarioId: "ticker-fanout",
			ingressRatePerSecond: 100_000,
			publisherCount: 1,
			subscriberCount: 100,
			recordBytes: 100,
			fanout: 100,
			durationSeconds: 10,
			delivery: "reliable",
		});
		expect(cell("game-tick-loss/tick-60-loss-2.5-delay-40").parameters).toEqual(
			{
				scenarioId: "game-tick-loss",
				tickHz: 60,
				tickBytes: 64,
				receiverCount: 100,
				publisherCount: 1,
				durationSeconds: 30,
				lossPercent: 2.5,
				delayMs: 40,
				delivery: "latest-state",
			},
		);
		expect(cell("reconnect-storm/cold-full").parameters).toEqual({
			scenarioId: "reconnect-storm",
			state: "cold-full",
			clientCount: 100,
			reconnectCycles: 10,
			concurrency: 100,
			firstMessageBytes: 32,
			acknowledged: true,
		});
		expect(cell("reconnect-storm/warm-after-prime").parameters).toEqual({
			scenarioId: "reconnect-storm",
			state: "warm-after-prime",
			clientCount: 100,
			reconnectCycles: 10,
			concurrency: 100,
			firstMessageBytes: 32,
			acknowledged: true,
		});
		expect(cell("connection-memory/live-10000").parameters).toEqual({
			scenarioId: "connection-memory",
			liveConnections: 10_000,
			holdSeconds: 30,
			pooling: false,
		});
		expect(cell("crdt-sync/default").parameters).toEqual({
			scenarioId: "crdt-sync",
			clientCount: 100,
			operationBytes: 96,
			operationsPerSecond: 1_000,
			durationSeconds: 60,
			snapshotSchedule: "periodic-canonical",
			delivery: "reliable",
		});
		expect(cell("ai-token-stream/chunk-256").parameters).toEqual({
			scenarioId: "ai-token-stream",
			chunkBytes: 256,
			sessionCount: 100,
			chunksPerSecondPerSession: 50,
			durationSeconds: 30,
			pauseEverySeconds: 5,
			pauseDurationMs: 500,
		});
		expect(
			cell("handshake-matrix/delay40-warm-after-prime").parameters,
		).toEqual({
			scenarioId: "handshake-matrix",
			path: "delay40",
			state: "warm-after-prime",
			clientCount: 100,
			measuredConnectionsPerWorker: 1,
		});
		expect(cell("bulk-one-way/delay40-loss1").parameters).toEqual({
			scenarioId: "bulk-one-way",
			path: "delay40-loss1",
			bytes: 100 * 1024 * 1024,
			chunkBytes: 64 * 1024,
			delivery: "reliable",
		});
		expect(cell("tail-under-cross-traffic/default").parameters).toEqual({
			scenarioId: "tail-under-cross-traffic",
			controlMessageBytes: 64,
			controlRatePerSecond: 1,
			durationSeconds: 180,
			bulkChunkBytes: 64 * 1024,
			bulkRateMbps: 700,
		});
	});

	test("pins role, direction, and deterministic eight-worker shards for ordinary workloads", () => {
		const ordinaryCases: readonly [
			string,
			TrafficDirection,
			LinuxRole,
			MacRole,
			number,
		][] = [
			[
				"chat-fanout/subscribers-1000",
				"mac-to-linux-to-mac",
				"reliable-relay",
				"subscriber",
				1_000,
			],
			[
				"ticker-fanout/rate-10000",
				"mac-to-linux-to-mac",
				"reliable-relay",
				"subscriber",
				100,
			],
			[
				"game-tick-loss/tick-20-loss-1-delay-20",
				"mac-to-linux-to-mac",
				"datagram-relay",
				"receiver",
				100,
			],
			[
				"connection-memory/live-5000",
				"mac-to-linux",
				"accepting-server",
				"idle-client",
				5_000,
			],
			[
				"crdt-sync/default",
				"mac-to-linux-to-mac",
				"reliable-relay",
				"actor",
				100,
			],
			[
				"ai-token-stream/chunk-32",
				"linux-to-mac",
				"token-source",
				"token-receiver",
				100,
			],
		];

		for (const [cellId, direction, linuxRole, role, count] of ordinaryCases) {
			const rolePlan = cell(cellId).rolePlan;
			expect(rolePlan.direction).toBe(direction);
			expect(rolePlan.linuxRole).toBe(linuxRole);
			const assigned = rolePlan.sharding;
			expect(assigned.workerCount).toBe(8);
			expect(assigned.strategy).toBe("round-robin");
			expect(assigned.role).toBe(role);
			expect(
				assigned.shards.every(({ workerIndex, clientIds }) =>
					clientIds.every((clientId) => clientId % 8 === workerIndex),
				),
			).toBe(true);
			expect(
				assigned.shards
					.flatMap(({ clientIds }) => clientIds)
					.sort((left, right) => left - right),
			).toEqual(Array.from({ length: count }, (_, index) => index));
			expect(assigned.shards.map(({ workerIndex }) => workerIndex)).toEqual(
				Array.from({ length: 8 }, (_, index) => index),
			);
		}
	});

	test("pins the explicit lifecycle process cohorts and barriers", () => {
		const coldReconnect = cell("reconnect-storm/cold-full");
		expect(coldReconnect.rolePlan.sharding).toEqual({
			workerCount: 100,
			strategy: "fresh-child-per-cycle",
			role: "reconnecting-client",
			shards: [],
		});
		expect(coldReconnect.rolePlan.processCohort).toEqual({
			kind: "fresh-child-per-cycle",
			processes: 1,
			primeBeforeMeasurement: false,
			measuredCycles: 10,
		});

		const warmReconnect = cell("reconnect-storm/warm-after-prime");
		expect(warmReconnect.rolePlan.sharding).toEqual({
			workerCount: 100,
			strategy: "fresh-process-cohort",
			role: "reconnecting-client",
			shards: [],
		});
		expect(warmReconnect.rolePlan.processCohort).toEqual({
			kind: "fresh-100-process-cohort-per-repetition",
			processes: 100,
			primeBeforeMeasurement: true,
			measuredCycles: 10,
		});

		for (const id of [
			"handshake-matrix/physical-cold",
			"handshake-matrix/delay40-cold",
		] as const) {
			expect(cell(id).rolePlan.processCohort).toEqual({
				kind: "fresh-child-per-cycle",
				processes: 1,
				primeBeforeMeasurement: false,
				measuredCycles: 1,
			});
		}
		for (const id of [
			"handshake-matrix/physical-warm-after-prime",
			"handshake-matrix/delay40-warm-after-prime",
		] as const) {
			expect(cell(id).rolePlan.processCohort).toEqual({
				kind: "fresh-100-process-cohort-per-repetition",
				processes: 100,
				primeBeforeMeasurement: true,
				measuredCycles: 1,
			});
		}
	});

	test("pins long versus short run repetition policy and setup on every cell", () => {
		for (const scenarioCell of listScenarioCells(CANONICAL_SCENARIO_REGISTRY)) {
			expect(scenarioCell.connectionSetup).toEqual(CANONICAL_CONNECTION_SETUP);
			expect(scenarioCell.capacityProfileHash).toBe(
				CANONICAL_SCENARIO_REGISTRY.capacityProfileHash,
			);
			if (scenarioCell.scenarioId === "handshake-matrix") {
				expect(scenarioCell.runPolicy).toEqual({
					classification: "short",
					warmupRepetitions: 3,
					measuredRepetitions: 15,
				});
			} else {
				expect(scenarioCell.runPolicy).toEqual({
					classification: "long",
					warmupRepetitions: 1,
					measuredRepetitions: 5,
				});
			}
		}
	});

	test("produces stable key ordering and SHA-256 canonical hashes", () => {
		expect(canonicalJson({ z: 3, a: { y: 2, x: 1 }, m: [2, 1] })).toBe(
			'{"a":{"x":1,"y":2},"m":[2,1],"z":3}',
		);
		expect(sha256Canonical({ b: 2, a: 1 })).toBe(
			"43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
		);
		expect(CANONICAL_SCENARIO_REGISTRY.registryHash).toMatch(/^[a-f0-9]{64}$/);
		for (const scenarioCell of listScenarioCells(CANONICAL_SCENARIO_REGISTRY)) {
			expect(scenarioCell.scenarioHash).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	test("marks diagnostic overrides non-canonical and hashes the changed cell", () => {
		const override: ScenarioOverride = {
			cellId: "chat-fanout/subscribers-1000",
			changes: { durationSeconds: 31 },
		};
		const diagnostic = createScenarioRegistry({ overrides: [override] });
		const canonicalCell = cell(override.cellId);
		const diagnosticCell = getScenarioCell(diagnostic, override.cellId);
		expect(diagnostic.canonical).toBe(false);
		expect(diagnosticCell.canonical).toBe(false);
		expect(diagnosticCell.parameters).toMatchObject({ durationSeconds: 31 });
		expect(diagnosticCell.scenarioHash).not.toBe(canonicalCell.scenarioHash);
		expect(diagnostic.registryHash).not.toBe(
			CANONICAL_SCENARIO_REGISTRY.registryHash,
		);
		expect(
			listScenarioArms(diagnostic)
				.filter(({ cellId }) => cellId === override.cellId)
				.every(({ canonical, scenarioHash }) => {
					return !canonical && scenarioHash === diagnosticCell.scenarioHash;
				}),
		).toBe(true);
	});

	test("rejects invalid, unknown, and malformed scenario selections", () => {
		expect(() =>
			getScenarioCell(CANONICAL_SCENARIO_REGISTRY, "unknown"),
		).toThrow(/unknown scenario cell/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{ cellId: "unknown/default", changes: { durationSeconds: 1 } },
				],
			}),
		).toThrow(/unknown scenario cell/i);
		expect(() =>
			validateScenarioOverride({
				cellId: "chat-fanout/subscribers-1000",
				changes: { notAParameter: 1 },
			}),
		).toThrow(/unknown override field/i);
		expect(() =>
			validateScenarioOverride({
				cellId: "chat-fanout/subscribers-1000",
				changes: { durationSeconds: 0 },
			}),
		).toThrow(/positive integer/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "game-tick-loss/tick-20-loss-1-delay-20",
						changes: { lossPercent: Number.NaN },
					},
				],
			}),
		).toThrow(/finite/i);
		expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/i);
		expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(
			/finite/i,
		);
	});

	test("keeps canonical arm ordering and links each arm to its exact cell hash", () => {
		const arms = listScenarioArms(CANONICAL_SCENARIO_REGISTRY);
		for (const scenarioCell of listScenarioCells(CANONICAL_SCENARIO_REGISTRY)) {
			const cellArms = primaryArmsFor(scenarioCell.cellId);
			expect(cellArms.map(({ transport }) => transport)).toEqual(["ws", "wt"]);
			expect(
				cellArms.every(
					({ scenarioHash, capacityProfileHash, connectionSetup }) =>
						scenarioHash === scenarioCell.scenarioHash &&
						capacityProfileHash === scenarioCell.capacityProfileHash &&
						connectionSetup === scenarioCell.connectionSetup,
				),
			).toBe(true);
		}
		expect(arms.slice(0, 2).map(({ armId }) => armId)).toEqual([
			"chat-fanout/subscribers-1000/ws",
			"chat-fanout/subscribers-1000/wt",
		]);
	});
});
