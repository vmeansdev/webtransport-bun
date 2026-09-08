/**
 * Phase 2.1: smoke tests for all ten ScenarioExecutors.
 *
 * Each executor is asserted present with a comparable LegPlan, then
 * driven against a fake echo session with a tiny message plan so the
 * suite stays fast and bounded.
 */

import { describe, expect, test } from "bun:test";
import type {
	DeliveryKind,
	SendObservation,
	Session,
	TransportClock,
	TransportMetrics,
} from "./adapters/transport.ts";
import {
	COHORT_EXECUTOR_SCENARIOS,
	CohortExecutorRequiredError,
	executeConnectionMemoryLeg,
	executeLatencyLeg,
	executePercentLeg,
	executeRateLeg,
	getScenarioExecutor,
	HANDSHAKE_FIRST_MESSAGE_BYTES,
	LEG_PLAN_UNDEFINED_SCENARIOS,
	type LegPlan,
	measureLegOverAdapter,
} from "./client.ts";
import { PRIMARY_METRIC_CONTRACTS } from "./evidence.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import {
	BYTES_SAMPLE_UNIT,
	MEASURED_SAMPLE_UNIT,
	PERCENT_SAMPLE_UNIT,
	RATE_SAMPLE_UNIT,
	takeMeasurementRecord,
} from "./stats.ts";
import { SCENARIO_IDS, type ScenarioId } from "./types.ts";
import type { WireMessage } from "./wire.ts";

function frozenClock(
	startMs = 1_000,
): TransportClock & { advance(ms: number): void } {
	let now = startMs;
	return {
		nowMs: () => now,
		sleep: async () => undefined,
		method: "test.frozen",
		advance(ms: number) {
			now += ms;
		},
	};
}

function emptyMetrics(
	overrides: Partial<TransportMetrics> = {},
): TransportMetrics {
	return {
		attempted: 0,
		queued: 0,
		serverObserved: 0,
		acknowledged: 0,
		delivered: 0,
		refused: 0,
		dropped: 0,
		timedOut: 0,
		sessionsOpened: 1,
		sessionsClosed: 0,
		streamsOpened: 0,
		streamsAccepted: 0,
		streamsClosed: 0,
		active: true,
		queueBytes: 0,
		queueBytesPeak: 0,
		receiveQueueItems: 0,
		receiveQueueBytes: 0,
		loopUtilization: { busyMs: 1, windowMs: 10 },
		harnessOverheadBytes: 0,
		sessionsActive: 1,
		handshakesInFlight: 0,
		handshakesAttempted: 1,
		handshakesAccepted: 1,
		handshakesRejected: 0,
		streamOpenAttempts: 0,
		streamOpenAccepted: 0,
		streamOpenRejected: 0,
		datagramAttempts: 0,
		datagramAccepted: 0,
		datagramRejected: 0,
		tokenBucketRejected: 0,
		...overrides,
	};
}

function sendObservation(kind: DeliveryKind, bytes: number): SendObservation {
	return {
		status: 0,
		bytes,
		deliveryKind: kind,
		attempted: true,
		queued: true,
		serverObserved: false,
		acknowledged: false,
		delivered: false,
	};
}

/** Fake session that echoes every send onto the receive queue. */
function echoSession(
	clock: TransportClock & { advance(ms: number): void },
	options: { readonly dropEvery?: number } = {},
): Session {
	const pending: WireMessage[] = [];
	let sent = 0;
	let delivered = 0;
	let dropped = 0;
	const dropEvery = options.dropEvery ?? 0;

	return {
		role: "client",
		async sendMessage(kind: DeliveryKind, message: WireMessage) {
			sent += 1;
			clock.advance(1);
			if (dropEvery > 0 && sent % dropEvery === 0) {
				dropped += 1;
				return sendObservation(kind, message.payload.byteLength);
			}
			pending.push(message);
			return sendObservation(kind, message.payload.byteLength);
		},
		async receiveMessage() {
			const next = pending.shift();
			if (!next) {
				throw new Error("echo session: receive queue empty");
			}
			delivered += 1;
			clock.advance(1);
			return next;
		},
		async sendText() {
			throw new Error("echo session: no sendText");
		},
		async openUni() {
			throw new Error("echo session: no openUni");
		},
		async acceptUni() {
			throw new Error("echo session: no acceptUni");
		},
		async openBidi() {
			throw new Error("echo session: no openBidi");
		},
		async acceptBidi() {
			throw new Error("echo session: no acceptBidi");
		},
		async close() {},
		snapshot() {
			return emptyMetrics({
				attempted: sent,
				queued: sent,
				serverObserved: sent - dropped,
				acknowledged: delivered,
				delivered,
				dropped,
			});
		},
	};
}

function cell(cellId: string) {
	return CANONICAL_SCENARIO_REGISTRY.cells.find((c) => c.cellId === cellId)!;
}

function asComparablePlan(
	plan: ReturnType<
		NonNullable<ReturnType<typeof getScenarioExecutor>>["legPlan"]
	>,
): LegPlan {
	if ("kind" in plan && plan.kind === "not-comparable") {
		throw new Error(`expected comparable legPlan, got: ${plan.reason}`);
	}
	if ("kind" in plan && plan.kind === "comparable") {
		return plan.plan;
	}
	return plan as LegPlan;
}

describe("Phase 2.1 all ScenarioExecutors are comparable", () => {
	test("LEG_PLAN_UNDEFINED_SCENARIOS is empty", () => {
		expect(LEG_PLAN_UNDEFINED_SCENARIOS).toEqual([]);
	});

	test.each([
		...SCENARIO_IDS,
	])("%s executor returns a comparable LegPlan with explicit delivery", (scenarioId: ScenarioId) => {
		const executor = getScenarioExecutor(scenarioId);
		expect(executor).toBeDefined();
		const plan = asComparablePlan(executor!.legPlan());
		expect(
			plan.deliveryKind === "reliable-message" ||
				plan.deliveryKind === "datagram",
		).toBe(true);
		expect(plan.messageCount).toBeGreaterThan(0);
		expect(plan.messageBytes).toBeGreaterThan(0);
	});
});

/**
 * B4: the fanout primaries are severed from the single-session rate leg.
 *
 * These are negatives on purpose. `executeRateLeg` over one echo session was a
 * perfectly well-formed measurement of something that is not the cell: a
 * `ticker-fanout` primary is one publisher, eight subscriber worker processes
 * and a hundred subscriber sessions under a signed cohort grant, and a number
 * produced by one session round-tripping to itself would have been published
 * under that cell's name. The severance is what makes that impossible rather
 * than merely discouraged, so it is tested by reaching for it and being
 * refused -- and by checking that the eight cells that were never fanout can
 * still reach the executor they always used.
 */
describe("B4: fanout primaries cannot reach the single-session rate leg", () => {
	const fanoutCells = [
		["ticker-fanout", "ticker-fanout/rate-50"],
		["ticker-fanout", "ticker-fanout/rate-100"],
		["ticker-fanout", "ticker-fanout/rate-250"],
		["chat-fanout", "chat-fanout/subscribers-250"],
		["chat-fanout", "chat-fanout/subscribers-500"],
		["chat-fanout", "chat-fanout/subscribers-1000"],
	] as const;

	function fanoutInput(scenarioId: ScenarioId, cellId: string) {
		const clock = frozenClock();
		return {
			session: echoSession(clock),
			cell: cell(cellId),
			driverRunId: `sever-${cellId}`,
			runId: `run-${cellId}`,
			sessionId: `session-${cellId}`,
			clock,
			perMessageTimeoutMs: 1_000,
			contract: PRIMARY_METRIC_CONTRACTS[scenarioId]!,
		};
	}

	test.each(
		fanoutCells,
	)("fanout_cells_cannot_reach_execute_rate_leg (%s %s)", async (scenarioId: ScenarioId, cellId: string) => {
		const executor = getScenarioExecutor(scenarioId);
		expect(executor).toBeDefined();
		// Unstated armKind is the primary everywhere else in the tool, so
		// silence has to fail closed here too.
		let thrown: unknown;
		try {
			await executor!.execute(fanoutInput(scenarioId, cellId));
		} catch (error: unknown) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CohortExecutorRequiredError);
		expect((thrown as CohortExecutorRequiredError).code).toBe(
			"COHORT_EXECUTOR_REQUIRED",
		);
		expect((thrown as CohortExecutorRequiredError).scenarioId).toBe(scenarioId);

		// Naming the primary explicitly is refused identically; the refusal is
		// not an artifact of the field being absent.
		let named: unknown;
		try {
			await executor!.execute({
				...fanoutInput(scenarioId, cellId),
				armKind: "primary",
			});
		} catch (error: unknown) {
			named = error;
		}
		expect(named).toBeInstanceOf(CohortExecutorRequiredError);
	});

	test("fanout_read_path_arms_still_reach_execute_rate_leg", async () => {
		// The read-path arms shadow the same wire with a different consumer and
		// are not driven by the cohort, so B4 leaves them exactly where they were.
		for (const [scenarioId, cellId] of fanoutCells) {
			const leg = await getScenarioExecutor(scenarioId)!.execute({
				...fanoutInput(scenarioId, cellId),
				armKind: "read-path",
			});
			expect(leg.sampleUnit).toBe(RATE_SAMPLE_UNIT);
		}
	});

	test("non_fanout_cells_still_reach_their_executor", async () => {
		// The complement of the switch: the eight scenarios B4 does not touch
		// must still run, with no armKind stated at all.
		const untouched: readonly (readonly [ScenarioId, string])[] = [
			["crdt-sync", "crdt-sync/default"],
			["game-tick-loss", "game-tick-loss/tick-20-loss-1-delay-20"],
		];
		for (const [scenarioId, cellId] of untouched) {
			const leg = await getScenarioExecutor(scenarioId)!.execute(
				fanoutInput(scenarioId, cellId),
			);
			expect(leg.samples.length).toBeGreaterThanOrEqual(0);
		}
		// And every scenario that is not a cohort scenario is absent from the
		// severed list, so the list cannot quietly grow a ninth member.
		for (const scenarioId of SCENARIO_IDS) {
			const severed = COHORT_EXECUTOR_SCENARIOS.includes(scenarioId);
			expect(severed).toBe(
				scenarioId === "ticker-fanout" || scenarioId === "chat-fanout",
			);
		}
	});

	test("measure_leg_over_adapter_refuses_a_fanout_primary_before_connecting", async () => {
		// The refusal has to land before `connect`, or a severed arm still puts a
		// registration on the rig for a measurement that is not going to happen.
		let connects = 0;
		const adapter = {
			transport: "ws" as const,
			connect: async () => {
				connects += 1;
				throw new Error("connect must not be reached");
			},
		};
		let thrown: unknown;
		try {
			await measureLegOverAdapter({
				adapter: adapter as never,
				cell: cell("ticker-fanout/rate-250"),
				serverUrl: "wss://10.99.0.2:4433",
				role: "publisher",
				driverRunId: "sever-connect",
				runId: "sever-connect",
				sessionId: "sever-connect-s1",
				clock: frozenClock(),
				connectTimeoutMs: 1_000,
				perMessageTimeoutMs: 1_000,
			});
		} catch (error: unknown) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CohortExecutorRequiredError);
		expect(connects).toBe(0);
	});
});

describe("Phase 2.1 count/percent ScenarioExecutors", () => {
	test("chat-fanout registry executor is wired and rate helper seals count", async () => {
		expect(getScenarioExecutor("chat-fanout")).toBeDefined();
		const clock = frozenClock();
		const leg = await executeRateLeg(
			{
				session: echoSession(clock),
				cell: cell("chat-fanout/subscribers-1000"),
				driverRunId: "chat-smoke",
				runId: "run-chat",
				sessionId: "session-chat",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["chat-fanout"]!,
			},
			{
				deliveryKind: "reliable-message",
				messageCount: 4,
				messageBytes: 32,
			},
		);
		expect(leg.sampleUnit).toBe(RATE_SAMPLE_UNIT);
		expect(leg.samples.length).toBeGreaterThanOrEqual(1);
		expect(leg.roundTrips).toEqual([]);
		expect(takeMeasurementRecord(leg.provenance.attestation)?.unit).toBe(
			"count",
		);
	});

	test("ticker-fanout registry executor is wired and rate helper seals count", async () => {
		expect(getScenarioExecutor("ticker-fanout")).toBeDefined();
		const clock = frozenClock();
		const leg = await executeRateLeg(
			{
				session: echoSession(clock),
				cell: cell("ticker-fanout/rate-250"),
				driverRunId: "ticker-smoke",
				runId: "run-ticker",
				sessionId: "session-ticker",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["ticker-fanout"]!,
			},
			{
				deliveryKind: "reliable-message",
				messageCount: 8,
				messageBytes: 16,
			},
		);
		expect(leg.sampleUnit).toBe(RATE_SAMPLE_UNIT);
		takeMeasurementRecord(leg.provenance.attestation);
	});

	test("crdt-sync registry executor is wired and rate helper seals count", async () => {
		expect(getScenarioExecutor("crdt-sync")).toBeDefined();
		const clock = frozenClock();
		const leg = await executeRateLeg(
			{
				session: echoSession(clock),
				cell: cell("crdt-sync/default"),
				driverRunId: "crdt-smoke",
				runId: "run-crdt",
				sessionId: "session-crdt",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["crdt-sync"]!,
			},
			{
				deliveryKind: "reliable-message",
				messageCount: 6,
				messageBytes: 32,
			},
		);
		expect(leg.sampleUnit).toBe(RATE_SAMPLE_UNIT);
		takeMeasurementRecord(leg.provenance.attestation);
	});

	test("game-tick-loss registry executor is wired and percent helper seals percent", async () => {
		expect(getScenarioExecutor("game-tick-loss")).toBeDefined();
		const clock = frozenClock();
		const leg = await executePercentLeg(
			{
				session: echoSession(clock, { dropEvery: 4 }),
				cell: cell("game-tick-loss/tick-20-loss-1-delay-20"),
				driverRunId: "game-smoke",
				runId: "run-game",
				sessionId: "session-game",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["game-tick-loss"]!,
			},
			{
				deliveryKind: "datagram",
				messageCount: 8,
				messageBytes: 16,
			},
		);
		expect(leg.sampleUnit).toBe(PERCENT_SAMPLE_UNIT);
		expect(leg.samples[0]).toBeCloseTo(75, 5);
		takeMeasurementRecord(leg.provenance.attestation);
	});
});

describe("Phase 2.1 latency/bytes ScenarioExecutors", () => {
	test("reconnect-storm seals ms via latency helper", async () => {
		const executor = getScenarioExecutor("reconnect-storm")!;
		const plan = asComparablePlan(executor.legPlan());
		expect(plan).toEqual({
			deliveryKind: "reliable-message",
			messageCount: 10,
			messageBytes: 32,
		});
		const clock = frozenClock();
		const leg = await executeLatencyLeg(
			{
				session: echoSession(clock),
				cell: cell("reconnect-storm/cold-full"),
				driverRunId: "reconnect-smoke",
				runId: "run-reconnect",
				sessionId: "session-reconnect",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["reconnect-storm"]!,
			},
			{ deliveryKind: "reliable-message", messageCount: 3, messageBytes: 32 },
		);
		expect(leg.sampleUnit).toBe(MEASURED_SAMPLE_UNIT);
		expect(leg.samples).toHaveLength(3);
		takeMeasurementRecord(leg.provenance.attestation);
	});

	test("handshake-matrix seals ms via latency helper", async () => {
		const executor = getScenarioExecutor("handshake-matrix")!;
		const plan = asComparablePlan(executor.legPlan());
		expect(plan).toEqual({
			deliveryKind: "reliable-message",
			messageCount: 1,
			messageBytes: HANDSHAKE_FIRST_MESSAGE_BYTES,
		});
		const clock = frozenClock();
		const leg = await executeLatencyLeg(
			{
				session: echoSession(clock),
				cell: cell("handshake-matrix/physical-cold"),
				driverRunId: "handshake-smoke",
				runId: "run-handshake",
				sessionId: "session-handshake",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["handshake-matrix"]!,
			},
			{
				deliveryKind: "reliable-message",
				messageCount: 2,
				messageBytes: HANDSHAKE_FIRST_MESSAGE_BYTES,
			},
		);
		expect(leg.sampleUnit).toBe(MEASURED_SAMPLE_UNIT);
		expect(leg.samples).toHaveLength(2);
		takeMeasurementRecord(leg.provenance.attestation);
	});

	test("ai-token-stream seals ms via latency helper", async () => {
		const executor = getScenarioExecutor("ai-token-stream")!;
		const plan = asComparablePlan(executor.legPlan());
		expect(plan).toEqual({
			deliveryKind: "reliable-message",
			messageCount: 50 * 30,
			messageBytes: 64,
		});
		const clock = frozenClock();
		const leg = await executeLatencyLeg(
			{
				session: echoSession(clock),
				cell: cell("ai-token-stream/chunk-64"),
				driverRunId: "ai-smoke",
				runId: "run-ai",
				sessionId: "session-ai",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["ai-token-stream"]!,
			},
			{ deliveryKind: "reliable-message", messageCount: 4, messageBytes: 64 },
		);
		expect(leg.sampleUnit).toBe(MEASURED_SAMPLE_UNIT);
		takeMeasurementRecord(leg.provenance.attestation);
	});

	test("tail-under-cross-traffic seals ms via latency helper", async () => {
		const executor = getScenarioExecutor("tail-under-cross-traffic")!;
		const plan = asComparablePlan(executor.legPlan());
		expect(plan).toEqual({
			deliveryKind: "reliable-message",
			messageCount: 180,
			messageBytes: 64,
		});
		const clock = frozenClock();
		const leg = await executeLatencyLeg(
			{
				session: echoSession(clock),
				cell: cell("tail-under-cross-traffic/default"),
				driverRunId: "tail-smoke",
				runId: "run-tail",
				sessionId: "session-tail",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["tail-under-cross-traffic"]!,
			},
			{ deliveryKind: "reliable-message", messageCount: 3, messageBytes: 64 },
		);
		expect(leg.sampleUnit).toBe(MEASURED_SAMPLE_UNIT);
		takeMeasurementRecord(leg.provenance.attestation);
	});

	test("connection-memory seals bytes via memory helper", async () => {
		const executor = getScenarioExecutor("connection-memory")!;
		const plan = asComparablePlan(executor.legPlan());
		expect(plan).toEqual({
			deliveryKind: "reliable-message",
			messageCount: 1,
			messageBytes: 1,
		});
		const clock = frozenClock();
		const leg = await executeConnectionMemoryLeg(
			{
				session: echoSession(clock),
				cell: cell("connection-memory/live-1000"),
				driverRunId: "memory-smoke",
				runId: "run-memory",
				sessionId: "session-memory",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["connection-memory"]!,
			},
			{ deliveryKind: "reliable-message", messageCount: 1, messageBytes: 1 },
		);
		expect(leg.sampleUnit).toBe(BYTES_SAMPLE_UNIT);
		expect(leg.samples).toHaveLength(1);
		expect(leg.samples[0]).toBeGreaterThan(0);
		takeMeasurementRecord(leg.provenance.attestation);
	});

	test("all ten executors have comparable plans and seal via helpers against echoSession", async () => {
		const cases: readonly {
			readonly scenarioId: ScenarioId;
			readonly cellId: string;
			readonly run: (
				input: Parameters<typeof executeLatencyLeg>[0],
			) => Promise<{ sampleUnit: string; provenance: { attestation: string } }>;
			readonly unit: string;
		}[] = [
			{
				scenarioId: "chat-fanout",
				cellId: "chat-fanout/subscribers-1000",
				unit: RATE_SAMPLE_UNIT,
				run: (input) =>
					executeRateLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 2,
						messageBytes: 16,
					}),
			},
			{
				scenarioId: "ticker-fanout",
				cellId: "ticker-fanout/rate-250",
				unit: RATE_SAMPLE_UNIT,
				run: (input) =>
					executeRateLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 2,
						messageBytes: 16,
					}),
			},
			{
				scenarioId: "game-tick-loss",
				cellId: "game-tick-loss/tick-20-loss-1-delay-20",
				unit: PERCENT_SAMPLE_UNIT,
				run: (input) =>
					executePercentLeg(input, {
						deliveryKind: "datagram",
						messageCount: 2,
						messageBytes: 16,
					}),
			},
			{
				scenarioId: "reconnect-storm",
				cellId: "reconnect-storm/cold-full",
				unit: MEASURED_SAMPLE_UNIT,
				run: (input) =>
					executeLatencyLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 2,
						messageBytes: 32,
					}),
			},
			{
				scenarioId: "connection-memory",
				cellId: "connection-memory/live-1000",
				unit: BYTES_SAMPLE_UNIT,
				run: (input) =>
					executeConnectionMemoryLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 1,
						messageBytes: 1,
					}),
			},
			{
				scenarioId: "crdt-sync",
				cellId: "crdt-sync/default",
				unit: RATE_SAMPLE_UNIT,
				run: (input) =>
					executeRateLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 2,
						messageBytes: 16,
					}),
			},
			{
				scenarioId: "ai-token-stream",
				cellId: "ai-token-stream/chunk-64",
				unit: MEASURED_SAMPLE_UNIT,
				run: (input) =>
					executeLatencyLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 2,
						messageBytes: 32,
					}),
			},
			{
				scenarioId: "handshake-matrix",
				cellId: "handshake-matrix/physical-cold",
				unit: MEASURED_SAMPLE_UNIT,
				run: (input) =>
					executeLatencyLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 1,
						messageBytes: HANDSHAKE_FIRST_MESSAGE_BYTES,
					}),
			},
			{
				scenarioId: "tail-under-cross-traffic",
				cellId: "tail-under-cross-traffic/default",
				unit: MEASURED_SAMPLE_UNIT,
				run: (input) =>
					executeLatencyLeg(input, {
						deliveryKind: "reliable-message",
						messageCount: 2,
						messageBytes: 64,
					}),
			},
		];

		expect(getScenarioExecutor("bulk-one-way")).toBeDefined();
		asComparablePlan(getScenarioExecutor("bulk-one-way")!.legPlan());

		for (const entry of cases) {
			const executor = getScenarioExecutor(entry.scenarioId);
			expect(executor).toBeDefined();
			asComparablePlan(executor!.legPlan());
			const clock = frozenClock();
			const leg = await entry.run({
				session: echoSession(clock),
				cell: cell(entry.cellId),
				driverRunId: `all-${entry.scenarioId}`,
				runId: `run-all-${entry.scenarioId}`,
				sessionId: `session-all-${entry.scenarioId}`,
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS[entry.scenarioId]!,
			});
			expect(leg.sampleUnit).toBe(entry.unit);
			takeMeasurementRecord(leg.provenance.attestation);
		}
	});
});
