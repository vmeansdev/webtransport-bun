import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256Canonical } from "./canonical.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_CONNECTION_SETUP,
	CANONICAL_SCENARIO_REGISTRY,
	createScenarioRegistry,
	getScenarioCell,
	listScenarioArms,
	listScenarioCells,
	SCENARIO_IDS,
	type ScenarioRegistryOptions,
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
		const overlays = arms.filter(({ armKind }) => armKind === "overlay");
		expect(overlays).toHaveLength(12);
		expect(overlays.every(({ transport }) => transport === "ws")).toBe(true);
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
			acknowledged: true,
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
		expect(canonicalJson({ "2": "two", "10": "ten", a: "a" })).toBe(
			'{"10":"ten","2":"two","a":"a"}',
		);
		expect(sha256Canonical({ b: 2, a: 1 })).toBe(
			"43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
		);
		expect(CANONICAL_SCENARIO_REGISTRY.registryHash).toMatch(/^[a-f0-9]{64}$/);
		for (const scenarioCell of listScenarioCells(CANONICAL_SCENARIO_REGISTRY)) {
			expect(scenarioCell.scenarioHash).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	test("rejects sparse arrays even when Array.prototype supplies a hole", () => {
		const originalIndex = Object.getOwnPropertyDescriptor(Array.prototype, "0");
		try {
			Object.defineProperty(Array.prototype, "0", {
				configurable: true,
				enumerable: false,
				value: "polluted",
				writable: true,
			});
			const sparse: unknown[] = [];
			sparse.length = 1;
			expect(() => canonicalJson(sparse)).toThrow(/sparse/i);
		} finally {
			if (originalIndex) {
				Object.defineProperty(Array.prototype, "0", originalIndex);
			} else {
				Reflect.deleteProperty(Array.prototype, "0");
			}
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

	test("keeps diagnostic parameters complete under inherited setters", () => {
		const originalDuration = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"durationSeconds",
		);
		let setterCalls = 0;
		try {
			Object.defineProperty(Object.prototype, "durationSeconds", {
				configurable: true,
				set: () => {
					setterCalls += 1;
				},
			});
			const diagnostic = createScenarioRegistry({
				overrides: [
					{
						cellId: "chat-fanout/subscribers-1000",
						changes: { durationSeconds: 31 },
					},
				],
			});
			const parameters = getScenarioCell(
				diagnostic,
				"chat-fanout/subscribers-1000",
			).parameters;
			expect(Object.getPrototypeOf(parameters)).toBeNull();
			expect(Object.keys(parameters)).toEqual(
				Object.keys(cell("chat-fanout/subscribers-1000").parameters),
			);
			expect(Object.hasOwn(parameters, "durationSeconds")).toBe(true);
			expect(
				Object.getOwnPropertyDescriptor(parameters, "durationSeconds")?.value,
			).toBe(31);
			expect(setterCalls).toBe(0);
		} finally {
			if (originalDuration) {
				Object.defineProperty(
					Object.prototype,
					"durationSeconds",
					originalDuration,
				);
			} else {
				Reflect.deleteProperty(Object.prototype, "durationSeconds");
			}
		}
	});

	test("preserves one getter snapshot through validation and application", () => {
		let cellIdReads = 0;
		const getterOverride = Object.defineProperties(
			{},
			{
				cellId: {
					enumerable: true,
					get: () => {
						cellIdReads += 1;
						return cellIdReads === 1
							? "chat-fanout/subscribers-1000"
							: "unknown/default";
					},
				},
				changes: {
					enumerable: true,
					value: { durationSeconds: 31 },
				},
			},
		);

		const diagnostic = createScenarioRegistry([getterOverride] as never);
		expect(cellIdReads).toBe(1);
		expect(
			getScenarioCell(diagnostic, "chat-fanout/subscribers-1000").parameters,
		).toMatchObject({ durationSeconds: 31 });

		let descriptorReads = 0;
		const changingChanges = new Proxy(
			{},
			{
				ownKeys: () => ["durationSeconds"],
				getOwnPropertyDescriptor: () => {
					descriptorReads += 1;
					return {
						configurable: true,
						enumerable: true,
						get: () => (descriptorReads === 1 ? 31 : 32),
					};
				},
			},
		);
		const proxyDiagnostic = createScenarioRegistry([
			{
				cellId: "chat-fanout/subscribers-1000",
				changes: changingChanges,
			},
		] as never);
		expect(descriptorReads).toBe(1);
		expect(
			getScenarioCell(proxyDiagnostic, "chat-fanout/subscribers-1000")
				.parameters,
		).toMatchObject({ durationSeconds: 31 });
	});

	test("returns a detached validated snapshot from accessor-backed overrides", () => {
		let cellIdReads = 0;
		const rawChanges = { durationSeconds: 31 };
		const rawOverride = Object.defineProperties(
			{},
			{
				cellId: {
					configurable: true,
					enumerable: true,
					get: () => {
						cellIdReads += 1;
						return cellIdReads === 1
							? "chat-fanout/subscribers-1000"
							: "unknown/default";
					},
				},
				changes: {
					configurable: true,
					enumerable: true,
					get: () => rawChanges,
				},
			},
		);

		const validated = validateScenarioOverride(rawOverride);
		const typedCellId: string = validated.cellId;
		rawChanges.durationSeconds = 32;
		expect(typedCellId).toBe("chat-fanout/subscribers-1000");
		expect(validated).not.toBe(rawOverride);
		expect(validated.changes).not.toBe(rawChanges);
		expect(validated).toEqual({
			cellId: "chat-fanout/subscribers-1000",
			changes: { durationSeconds: 31 },
		});
		expect(cellIdReads).toBe(1);
	});

	test("ignores inherited descriptor value and get pollution", () => {
		const originalValue = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"value",
		);
		const originalGet = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"get",
		);
		const originalDescriptors = Object.getOwnPropertyDescriptor(
			Object,
			"getOwnPropertyDescriptors",
		);
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				value: "unknown/default",
				writable: true,
			});
			const getterOverride = Object.defineProperties(
				{},
				{
					cellId: {
						configurable: true,
						enumerable: true,
						get: () => "chat-fanout/subscribers-1000",
					},
					changes: {
						configurable: true,
						enumerable: true,
						value: { durationSeconds: 31 },
					},
				},
			);
			expect(() => validateScenarioOverride(getterOverride)).not.toThrow();

			Reflect.deleteProperty(Object.prototype, "value");
			Object.defineProperty(Object.prototype, "get", {
				configurable: true,
				value: () => ({ durationSeconds: 31 }),
				writable: true,
			});
			const descriptorPollutedOverride = {
				cellId: "chat-fanout/subscribers-1000",
				changes: { durationSeconds: 31 },
			};
			const originalGetOwnPropertyDescriptors =
				Object.getOwnPropertyDescriptors;
			Object.getOwnPropertyDescriptors = ((value: object) => {
				const descriptors = originalGetOwnPropertyDescriptors(value);
				if (value !== descriptorPollutedOverride) return descriptors;
				const pollutedDescriptor = Object.create(
					Object.prototype,
				) as PropertyDescriptor;
				pollutedDescriptor.configurable = true;
				pollutedDescriptor.enumerable = true;
				return { ...descriptors, changes: pollutedDescriptor };
			}) as typeof Object.getOwnPropertyDescriptors;
			expect(() =>
				validateScenarioOverride(descriptorPollutedOverride),
			).toThrow(/changes.*object|own property/i);
		} finally {
			if (originalValue) {
				Object.defineProperty(Object.prototype, "value", originalValue);
			} else {
				Reflect.deleteProperty(Object.prototype, "value");
			}
			if (originalGet) {
				Object.defineProperty(Object.prototype, "get", originalGet);
			} else {
				Reflect.deleteProperty(Object.prototype, "get");
			}
			if (originalDescriptors) {
				Object.defineProperty(
					Object,
					"getOwnPropertyDescriptors",
					originalDescriptors,
				);
			} else {
				Reflect.deleteProperty(Object, "getOwnPropertyDescriptors");
			}
		}
	});

	test("rejects empty, no-op, and cancelling diagnostic overrides", () => {
		const cellId = "chat-fanout/subscribers-1000";
		expect(() =>
			createScenarioRegistry({ overrides: [{ cellId, changes: {} }] }),
		).toThrow(/empty|no-op/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [{ cellId, changes: { durationSeconds: 30 } }],
			}),
		).toThrow(/no-op|canonical/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{ cellId, changes: { durationSeconds: 31 } },
					{ cellId, changes: { durationSeconds: 30 } },
				],
			}),
		).toThrow(/no-op|canonical|distinct hash|duplicate.*cell/i);
	});

	test("keeps public registry factory overloads and ignores inherited options", () => {
		const typedOptions: ScenarioRegistryOptions = { overrides: [] };
		const typedOverrides: readonly ScenarioOverride[] = [];
		expect(createScenarioRegistry()).toBe(CANONICAL_SCENARIO_REGISTRY);
		expect(createScenarioRegistry(undefined)).toBe(CANONICAL_SCENARIO_REGISTRY);
		expect(createScenarioRegistry(typedOptions)).toBe(
			CANONICAL_SCENARIO_REGISTRY,
		);
		expect(createScenarioRegistry(typedOverrides)).toBe(
			CANONICAL_SCENARIO_REGISTRY,
		);

		const originalOverrides = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"overrides",
		);
		const originalCellId = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"cellId",
		);
		const originalChanges = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"changes",
		);
		try {
			Object.defineProperty(Object.prototype, "overrides", {
				configurable: true,
				value: [
					{
						cellId: "chat-fanout/subscribers-1000",
						changes: { durationSeconds: 31 },
					},
				],
			});
			expect(createScenarioRegistry({})).toBe(CANONICAL_SCENARIO_REGISTRY);

			Object.defineProperty(Object.prototype, "cellId", {
				configurable: true,
				value: "chat-fanout/subscribers-1000",
			});
			Object.defineProperty(Object.prototype, "changes", {
				configurable: true,
				value: { durationSeconds: 31 },
			});
			expect(() => validateScenarioOverride({})).toThrow(
				/own.*cellId|own property/i,
			);
			expect(() =>
				validateScenarioOverride({
					cellId: "chat-fanout/subscribers-1000",
				}),
			).toThrow(/own.*changes|own property/i);
		} finally {
			if (originalOverrides) {
				Object.defineProperty(Object.prototype, "overrides", originalOverrides);
			} else {
				Reflect.deleteProperty(Object.prototype, "overrides");
			}
			if (originalCellId) {
				Object.defineProperty(Object.prototype, "cellId", originalCellId);
			} else {
				Reflect.deleteProperty(Object.prototype, "cellId");
			}
			if (originalChanges) {
				Object.defineProperty(Object.prototype, "changes", originalChanges);
			} else {
				Reflect.deleteProperty(Object.prototype, "changes");
			}
		}
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

	test("rejects overrides that would stale topology, sharding, or cohort metadata", () => {
		const structuralOverrides: readonly [string, string, unknown][] = [
			["chat-fanout/subscribers-1000", "subscriberCount", 999],
			["chat-fanout/subscribers-1000", "publisherCount", 9],
			["ticker-fanout/rate-10000", "fanout", 99],
			["game-tick-loss/tick-20-loss-1-delay-20", "receiverCount", 99],
			["reconnect-storm/cold-full", "clientCount", 99],
			["ai-token-stream/chunk-32", "sessionCount", 99],
			["connection-memory/live-1000", "liveConnections", 999],
			["connection-memory/live-1000", "pooling", true],
			["reconnect-storm/cold-full", "state", "warm-after-prime"],
			["reconnect-storm/cold-full", "reconnectCycles", 9],
			["reconnect-storm/cold-full", "concurrency", 99],
			["handshake-matrix/physical-cold", "measuredConnectionsPerWorker", 2],
		];
		for (const [cellId, field, value] of structuralOverrides) {
			expect(() =>
				createScenarioRegistry({
					overrides: [{ cellId, changes: { [field]: value } }],
				}),
			).toThrow(/topology|cohort|shard/i);
		}
	});

	test("requires safe bounded integers for diagnostic numeric fields", () => {
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "chat-fanout/subscribers-1000",
						changes: { durationSeconds: Number.MAX_SAFE_INTEGER },
					},
				],
			}),
		).toThrow(/safe integer|at most/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "chat-fanout/subscribers-1000",
						changes: { durationSeconds: 86_401 },
					},
				],
			}),
		).toThrow(/at most/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "bulk-one-way/physical",
						changes: { bytes: Number.MAX_SAFE_INTEGER },
					},
				],
			}),
		).toThrow(/safe integer|at most/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "bulk-one-way/physical",
						changes: { bytes: 1_073_741_825 },
					},
				],
			}),
		).toThrow(/at most/i);
	});

	test("freezes the exported scenario ID tuple at runtime", () => {
		expect(Object.isFrozen(SCENARIO_IDS)).toBe(true);
		expect(() => {
			(SCENARIO_IDS as unknown as string[])[0] = "mutated";
		}).toThrow();
		expect(SCENARIO_IDS[0]).toBe("chat-fanout");
	});

	test("rejects direct missing-field validation and malformed registry options", () => {
		expect(() =>
			validateScenarioOverride({
				cellId: "chat-fanout/subscribers-1000",
				changes: { path: "physical" },
			}),
		).toThrow(/not present.*chat-fanout\/subscribers-1000/i);
		expect(() => createScenarioRegistry(null as never)).toThrow(
			/options.*object|array/i,
		);
		expect(() => createScenarioRegistry({ overrides: null } as never)).toThrow(
			/overrides.*array/i,
		);
		expect(() =>
			createScenarioRegistry({ overrides: "not-an-array" } as never),
		).toThrow(/overrides.*array/i);
		expect(() => createScenarioRegistry({ unexpected: [] } as never)).toThrow(
			/unexpected|option/i,
		);
	});

	test("rejects polluted, oversized, and duplicate override arrays", () => {
		const baseOverride: ScenarioOverride = {
			cellId: "chat-fanout/subscribers-1000",
			changes: { durationSeconds: 31 },
		};
		const extraString = [baseOverride];
		Object.defineProperty(extraString, "unexpected", {
			configurable: true,
			enumerable: false,
			value: true,
		});
		expect(() => createScenarioRegistry(extraString)).toThrow(
			/unexpected.*property|override array/i,
		);

		const extraSymbol = Symbol("unexpected");
		const symbolArray = [baseOverride];
		Object.defineProperty(symbolArray, extraSymbol, {
			configurable: true,
			enumerable: false,
			value: true,
		});
		expect(() => createScenarioRegistry(symbolArray)).toThrow(
			/unexpected.*property|override array/i,
		);

		const oversized = Array.from({ length: 36 }, () => baseOverride);
		expect(() => createScenarioRegistry(oversized)).toThrow(
			/at most|maximum|35/i,
		);

		const duplicate = [
			baseOverride,
			{ cellId: baseOverride.cellId, changes: { durationSeconds: 32 } },
		];
		expect(() => createScenarioRegistry(duplicate)).toThrow(/duplicate.*cell/i);
	});

	test("rejects enum and type overrides outside the selected cell domain", () => {
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "bulk-one-way/physical",
						changes: { path: "delay40" },
					},
				],
			}),
		).toThrow(/path.*physical.*delay40-loss1/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "handshake-matrix/physical-cold",
						changes: { path: "delay40-loss1" },
					},
				],
			}),
		).toThrow(/path.*physical.*delay40/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "reconnect-storm/cold-full",
						changes: { state: "cold" },
					},
				],
			}),
		).toThrow(/state.*cold-full.*warm-after-prime/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "handshake-matrix/physical-cold",
						changes: { state: "cold-full" },
					},
				],
			}),
		).toThrow(/state.*cold.*warm-after-prime/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "crdt-sync/default",
						changes: { snapshotSchedule: "periodic" },
					},
				],
			}),
		).toThrow(/snapshotSchedule.*periodic-canonical/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "bulk-one-way/physical",
						changes: { path: 40 },
					},
				],
			}),
		).toThrow(/path.*string/i);
		expect(() =>
			createScenarioRegistry({
				overrides: [
					{
						cellId: "crdt-sync/default",
						changes: { snapshotSchedule: false },
					},
				],
			}),
		).toThrow(/snapshotSchedule.*periodic-canonical/i);
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

	test("enforces discriminated arm kinds at compile time and runtime", () => {
		const arms = listScenarioArms(CANONICAL_SCENARIO_REGISTRY);
		for (const arm of arms) {
			if (arm.armKind === "primary") {
				expect(["ws", "wt"]).toContain(arm.transport);
				expect(Object.hasOwn(arm, "overlayOf")).toBe(false);
				expect(arm.overlayOf).toBeUndefined();
			} else {
				expect(arm.transport).toBe("ws");
				expect(Object.hasOwn(arm, "overlayOf")).toBe(true);
				expect(arm.overlayOf).toMatch(/\/ws$/);
			}
		}

		const armBase = {
			armId: "chat-fanout/subscribers-1000/ws",
			cellId: "chat-fanout/subscribers-1000",
			scenarioId: "chat-fanout",
			canonical: true,
			scenarioHash: "a".repeat(64),
			capacityProfileHash: "b".repeat(64),
			connectionSetup: {
				connectionRampPerSecond: 500,
				maxConnectsInFlight: 200,
			},
		} as const;
		// @ts-expect-error primary arms cannot carry overlayOf
		const invalidPrimaryArm: ScenarioArm = {
			...armBase,
			transport: "ws",
			armKind: "primary",
			label: "ws-primary",
			overlayOf: "chat-fanout/subscribers-1000/ws",
		};
		// @ts-expect-error lossy overlay arms require overlayOf
		const invalidOverlayArm: ScenarioArm = {
			...armBase,
			transport: "ws",
			armKind: "overlay",
			label: "ws-lossy-game-overlay",
		};
		void invalidPrimaryArm;
		void invalidOverlayArm;
	});
});
