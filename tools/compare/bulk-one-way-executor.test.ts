/**
 * Phase 2.1: `bulk-one-way` ScenarioExecutor smoke tests.
 *
 * Drives `executeBulkOneWay` against a fake session that accepts sends and
 * reports counters, so the Mbps path is proven without the two-host rig.
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
	executeBulkOneWay,
	getScenarioExecutor,
	type ScenarioExecutorInput,
} from "./client.ts";
import { PRIMARY_METRIC_CONTRACTS } from "./evidence.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { takeMeasurementRecord, THROUGHPUT_SAMPLE_UNIT } from "./stats.ts";
import type { BulkParameters, ScenarioCell } from "./types.ts";
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

function fakeSendSession(
	clock: TransportClock & { advance(ms: number): void },
): {
	readonly session: Session;
	readonly sent: WireMessage[];
} {
	const sent: WireMessage[] = [];
	const session: Session = {
		role: "client",
		async sendMessage(kind: DeliveryKind, message: WireMessage) {
			sent.push(message);
			// Advance wall clock a little per chunk so the throughput
			// window has a non-zero span on seal.
			clock.advance(10);
			return sendObservation(kind, message.payload.byteLength);
		},
		async receiveMessage() {
			throw new Error("bulk-one-way fake session has no receive path");
		},
		async sendText() {
			throw new Error("bulk-one-way fake session has no sendText");
		},
		async openUni() {
			throw new Error("bulk-one-way fake session has no openUni");
		},
		async acceptUni() {
			throw new Error("bulk-one-way fake session has no acceptUni");
		},
		async openBidi() {
			throw new Error("bulk-one-way fake session has no openBidi");
		},
		async acceptBidi() {
			throw new Error("bulk-one-way fake session has no acceptBidi");
		},
		async close() {},
		snapshot() {
			return emptyMetrics({
				attempted: sent.length,
				queued: sent.length,
				serverObserved: sent.length,
				acknowledged: sent.length,
				delivered: sent.length,
			});
		},
	};
	return { session, sent };
}

function bulkCell(bytes: number, chunkBytes: number): ScenarioCell {
	const base = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(cell) => cell.cellId === "bulk-one-way/physical",
	)!;
	const parameters: BulkParameters = {
		scenarioId: "bulk-one-way",
		path: "physical",
		bytes,
		chunkBytes,
		delivery: "reliable",
	};
	return { ...base, parameters };
}

describe("executeBulkOneWay", () => {
	test("returns an attested Mbps MeasuredLeg for a known byte schedule", async () => {
		const clock = frozenClock(5_000);
		const { session, sent } = fakeSendSession(clock);
		const bytes = 65_536 * 4; // 4 chunks of 64 KiB
		const chunkBytes = 65_536;
		const contract = PRIMARY_METRIC_CONTRACTS["bulk-one-way"]!;
		const input: ScenarioExecutorInput = {
			session,
			cell: bulkCell(bytes, chunkBytes),
			driverRunId: "bulk-smoke",
			runId: "run-bulk-smoke",
			sessionId: "session-bulk-smoke",
			clock,
			perMessageTimeoutMs: 5_000,
			contract,
		};

		const leg = await executeBulkOneWay(input);

		expect(leg.sampleUnit).toBe(THROUGHPUT_SAMPLE_UNIT);
		expect(leg.deliveredBytes).toBe(bytes);
		expect(sent).toHaveLength(4);
		expect(leg.samples.length).toBeGreaterThanOrEqual(1);
		expect(leg.roundTrips).toEqual([]);
		expect(leg.ledger.histogram.unit).toBe("Mbps");
		expect(leg.provenance.driverRunId).toBe("bulk-smoke");
		expect(leg.provenance.sampleCount).toBe(leg.samples.length);
		// Mean of window samples should be near (bytes*8)/span/1000.
		const spanMs = Math.max(
			1,
			leg.provenance.lastSampleAtMs - leg.provenance.firstSampleAtMs,
		);
		const expectedMbps = (bytes * 8) / (spanMs * 1000);
		const mean =
			leg.samples.reduce((sum, value) => sum + value, 0) / leg.samples.length;
		expect(mean).toBeGreaterThan(0);
		expect(Math.abs(mean - expectedMbps) / expectedMbps).toBeLessThan(0.5);
		const taken = takeMeasurementRecord(leg.provenance.attestation);
		expect(taken?.unit).toBe("Mbps");
		expect(taken?.deliveredBytes).toBe(bytes);
	});

	test("the registry executor dispatches to executeBulkOneWay", async () => {
		const executor = getScenarioExecutor("bulk-one-way");
		expect(executor).toBeDefined();
		const clock = frozenClock();
		const { session } = fakeSendSession(clock);
		const leg = await executor!.execute({
			session,
			cell: bulkCell(32_768, 16_384),
			driverRunId: "bulk-dispatch",
			runId: "run-dispatch",
			sessionId: "session-dispatch",
			clock,
			perMessageTimeoutMs: 1_000,
			contract: PRIMARY_METRIC_CONTRACTS["bulk-one-way"]!,
		});
		expect(leg.sampleUnit).toBe("Mbps");
		expect(leg.deliveredBytes).toBe(32_768);
		takeMeasurementRecord(leg.provenance.attestation);
	});
});

describe("assertMeasurementProvenance Mbps unit honesty", () => {
	test("refuses an ms recorder series relabelled as Mbps", async () => {
		const { assertMeasurementProvenance } = await import("./run-campaign.ts");
		const { openMeasurement } = await import("./stats.ts");
		const {
			MEASUREMENT_GRANT_SCHEMA,
			measurementGrantSha256,
			sha256HexOfBytes,
		} = await import("./evidence.ts");
		const { encodeSupervisorFrame } = await import("./supervisor-client.ts");
		const { R1_FIXTURE_TOOLCHAINS } = await import("./r1-fixtures.ts");

		let nowMs = 1_000;
		const recorder = openMeasurement({
			driverRunId: "relabel-ms-as-mbps",
			clock: { nowMs: () => nowMs, method: "test.stepping" },
			histogramBoundaries: [0, 1, 2, 4, 8],
		});
		recorder.markSent();
		nowMs += 5;
		recorder.markReceived(1);
		const sealed = recorder.seal();

		const execution = {
			campaignId: "relabel-guard",
			runId: "relabel-1",
			executionIndex: 1,
			transport: "wt" as const,
		};
		const now = Date.now();
		const grant = {
			schema: MEASUREMENT_GRANT_SCHEMA,
			campaignId: execution.campaignId,
			candidate: "relabel-candidate",
			declaredMessageBytes: 64,
			declaredMessageCount: 1,
			executionIndex: execution.executionIndex,
			issuedAt: now - 60_000,
			nonceSha256: "a".repeat(64),
			notAfter: now + 15 * 60 * 1_000,
			runId: execution.runId,
			transport: execution.transport,
		};
		const admissionPayload = new TextEncoder().encode(
			`${JSON.stringify({
				schema: "measurement-admission/v1",
				campaignId: execution.campaignId,
				delivered: 1,
				executionIndex: execution.executionIndex,
				firstSampleAtMs: sealed.provenance.firstSampleAtMs,
				frameAcceptedAtMs: now,
				grantSha256: measurementGrantSha256(grant),
				lastSampleAtMs: sealed.provenance.lastSampleAtMs,
				latencySumMs: sealed.samples.reduce((a, b) => a + b, 0),
				payloadSha256: sha256HexOfBytes(
					new TextEncoder().encode(JSON.stringify(sealed.samples)),
				),
				runId: execution.runId,
				sampleCount: sealed.samples.length,
				spanMs:
					sealed.provenance.lastSampleAtMs - sealed.provenance.firstSampleAtMs,
				transport: execution.transport,
			})}\n`,
		);
		const header = new TextEncoder().encode(
			'{"kind":"admission-receipt","schema":"comparison-supervisor-frame/v1"}',
		);
		const framed = encodeSupervisorFrame(header, admissionPayload, 65_536);
		if (!framed.ok) throw new Error("admission frame encode failed");

		const measurement = {
			sampleUnit: "Mbps" as const,
			toolchains: R1_FIXTURE_TOOLCHAINS,
			samples: [...sealed.samples],
			percentiles: sealed.percentiles,
			ledger: {
				attempted: 1,
				queued: 1,
				serverObserved: 1,
				acknowledged: 1,
				delivered: 1,
				dropped: 0,
				expired: 0,
			},
			telemetry: {
				mac: { cpuPercent: 1, rssBytes: 1 },
				linux: { cpuPercent: 1, rssBytes: 1 },
			},
			loopUtilization: {
				perSession: { busyMs: 1, windowMs: 10 },
				serverAggregate: { busyMs: 1, windowMs: 10 },
			},
			admissionCounters: {
				schemaVersion: "v1" as const,
				handshakes: {
					attempted: 1,
					accepted: 1,
					rejected: 0,
					rateLimited: 0,
				},
				sessions: {
					attempted: 1,
					accepted: 1,
					rejected: 0,
					activePeak: 1,
				},
				streams: {
					attempted: 0,
					accepted: 0,
					rejected: 0,
					rateLimited: 0,
				},
				datagrams: {
					attempted: 0,
					accepted: 0,
					rejected: 0,
					rateLimited: 0,
				},
			},
			provenance: sealed.provenance,
			grant,
			admission: framed.value,
		};

		expect(() =>
			assertMeasurementProvenance(measurement as never, {
				cellId: "bulk-one-way/physical",
				transport: "wt",
				execution,
			}),
		).toThrow("MEASUREMENT_UNIT_RELABELLED");
	});
});
