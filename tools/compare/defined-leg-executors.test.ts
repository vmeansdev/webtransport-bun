/**
 * Phase 2.1: smoke tests for the count/percent ScenarioExecutors.
 *
 * Each defined-leg helper is driven against a fake echo session with a
 * tiny message plan so the suite stays fast and bounded. Registry
 * executors are asserted present and dispatched for bulk separately.
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
	executePercentLeg,
	executeRateLeg,
	getScenarioExecutor,
} from "./client.ts";
import { PRIMARY_METRIC_CONTRACTS } from "./evidence.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import {
	PERCENT_SAMPLE_UNIT,
	RATE_SAMPLE_UNIT,
	takeMeasurementRecord,
} from "./stats.ts";
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
				cell: cell("ticker-fanout/rate-10000"),
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
