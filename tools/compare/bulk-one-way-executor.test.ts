/**
 * Phase 2.1 / 02b: `bulk-one-way` sink-side ScenarioExecutor smoke tests.
 *
 * Drives `executeBulkOneWay` against a fake session that `acceptUni`s a
 * patterned ReceiveChannel, so the Mbps path matches the registry topology
 * (linux source / mac sink / server-opened uni) without the two-host rig.
 */

import { describe, expect, test } from "bun:test";
import type {
	ReceiveChannel,
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
import { generateBulkPayload } from "./scenarios/bulk.ts";
import { takeMeasurementRecord, THROUGHPUT_SAMPLE_UNIT } from "./stats.ts";
import type { BulkParameters, ScenarioCell } from "./types.ts";

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

/** Emit the same patterned chunks `runBulkSourcePeer` / `generateBulkPayload` use. */
function patternedChunks(bytes: number, chunkBytes: number): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let remaining = bytes;
	let sequence = 1;
	while (remaining > 0) {
		const size = Math.min(chunkBytes, remaining);
		const chunk = new Uint8Array(size);
		chunk.fill(sequence & 0xff);
		chunks.push(chunk);
		remaining -= size;
		sequence += 1;
	}
	return chunks;
}

function fakeSinkSession(
	clock: TransportClock & { advance(ms: number): void },
	bytes: number,
	chunkBytes: number,
	advancePerChunkMs = 25,
): {
	readonly session: Session;
	readonly chunkCount: number;
} {
	const chunks = patternedChunks(bytes, chunkBytes);
	let index = 0;
	let cancelled = false;
	const channel: ReceiveChannel = {
		channelId: 1,
		async read() {
			if (cancelled) return null;
			if (index >= chunks.length) return null;
			clock.advance(advancePerChunkMs);
			const chunk = chunks[index]!;
			index += 1;
			return chunk;
		},
		async cancel() {
			cancelled = true;
		},
	};
	const session: Session = {
		role: "client",
		async sendMessage() {
			throw new Error("bulk-one-way sink session has no sendMessage");
		},
		async receiveMessage() {
			throw new Error("bulk-one-way sink session has no receiveMessage");
		},
		async sendText() {
			throw new Error("bulk-one-way sink session has no sendText");
		},
		async openUni() {
			throw new Error("bulk-one-way sink session has no openUni");
		},
		async acceptUni() {
			return channel;
		},
		async openBidi() {
			throw new Error("bulk-one-way sink session has no openBidi");
		},
		async acceptBidi() {
			throw new Error("bulk-one-way sink session has no acceptBidi");
		},
		async close() {},
		snapshot() {
			return emptyMetrics({
				streamsAccepted: 1,
				delivered: chunks.length,
			});
		},
	};
	return { session, chunkCount: chunks.length };
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

describe("executeBulkOneWay (server-opened uni sink)", () => {
	test("returns an attested Mbps MeasuredLeg within ±10% of expected", async () => {
		const clock = frozenClock(5_000);
		const bytes = 65_536 * 4; // 4 chunks of 64 KiB
		const chunkBytes = 65_536;
		const advancePerChunkMs = 25;
		const { session, chunkCount } = fakeSinkSession(
			clock,
			bytes,
			chunkBytes,
			advancePerChunkMs,
		);
		const expected = generateBulkPayload(bytes, chunkBytes);
		const contract = PRIMARY_METRIC_CONTRACTS["bulk-one-way"]!;
		const input: ScenarioExecutorInput = {
			session,
			cell: bulkCell(bytes, chunkBytes),
			driverRunId: "bulk-sink-smoke",
			runId: "run-bulk-sink-smoke",
			sessionId: "session-bulk-sink-smoke",
			clock,
			perMessageTimeoutMs: 5_000,
			contract,
		};

		const leg = await executeBulkOneWay(input);

		expect(leg.sampleUnit).toBe(THROUGHPUT_SAMPLE_UNIT);
		expect(leg.deliveredBytes).toBe(bytes);
		expect(chunkCount).toBe(expected.chunkCount);
		expect(leg.samples.length).toBeGreaterThanOrEqual(1);
		expect(leg.roundTrips).toEqual([]);
		expect(leg.ledger.histogram.unit).toBe("Mbps");
		expect(leg.provenance.driverRunId).toBe("bulk-sink-smoke");
		expect(leg.provenance.sampleCount).toBe(leg.samples.length);

		// First markBytes opens the window after the first chunk advances the
		// clock; seal uses the final clock. Span = (n-1)*advance for n chunks
		// when all land in one throughput window (default 100 ms).
		const spanMs = Math.max(
			1,
			leg.provenance.lastSampleAtMs - leg.provenance.firstSampleAtMs,
		);
		const expectedMbps = (bytes * 8) / (spanMs * 1000);
		const mean =
			leg.samples.reduce((sum, value) => sum + value, 0) / leg.samples.length;
		expect(mean).toBeGreaterThan(0);
		expect(Math.abs(mean - expectedMbps) / expectedMbps).toBeLessThan(0.1);

		const taken = takeMeasurementRecord(leg.provenance.attestation);
		expect(taken?.unit).toBe("Mbps");
		expect(taken?.deliveredBytes).toBe(bytes);
		expect(leg.ledger.attempted).toBe(expected.chunkCount);
		expect(leg.ledger.delivered).toBe(expected.chunkCount);
	});

	test("ledger uses schedule chunkCount even when acceptUni yields fragmented reads", async () => {
		const clock = frozenClock();
		const bytes = 65_536;
		const chunkBytes = 65_536;
		const expected = generateBulkPayload(bytes, chunkBytes);
		const full = patternedChunks(bytes, chunkBytes)[0]!;
		const fragments = [
			full.subarray(0, 16_384),
			full.subarray(16_384, 32_768),
			full.subarray(32_768, 49_152),
			full.subarray(49_152),
		];
		let index = 0;
		let cancelled = false;
		const channel: ReceiveChannel = {
			channelId: 1,
			async read() {
				if (cancelled || index >= fragments.length) return null;
				clock.advance(1);
				const next = fragments[index]!;
				index += 1;
				return next;
			},
			async cancel() {
				cancelled = true;
			},
		};
		const session: Session = {
			role: "client",
			async sendMessage() {
				throw new Error("unused");
			},
			async receiveMessage() {
				throw new Error("unused");
			},
			async sendText() {
				throw new Error("unused");
			},
			async openUni() {
				throw new Error("unused");
			},
			async acceptUni() {
				return channel;
			},
			async openBidi() {
				throw new Error("unused");
			},
			async acceptBidi() {
				throw new Error("unused");
			},
			async close() {},
			snapshot() {
				return emptyMetrics({ serverObserved: 99 });
			},
		};
		const leg = await executeBulkOneWay({
			session,
			cell: bulkCell(bytes, chunkBytes),
			driverRunId: "bulk-frag",
			runId: "run-bulk-frag",
			sessionId: "session-bulk-frag",
			clock,
			perMessageTimeoutMs: 5_000,
			contract: PRIMARY_METRIC_CONTRACTS["bulk-one-way"]!,
		});
		expect(expected.chunkCount).toBe(1);
		expect(leg.ledger.attempted).toBe(1);
		expect(leg.ledger.serverObserved).toBe(1);
		expect(leg.ledger.delivered).toBe(1);
		expect(leg.deliveredBytes).toBe(bytes);
	});

	test("digest must match generateBulkPayload for the same schedule", async () => {
		const clock = frozenClock();
		const bytes = 32_768;
		const chunkBytes = 16_384;
		// Same byte schedule, wrong fill pattern → digest fails after full read.
		const wrong: Uint8Array[] = [];
		let remaining = bytes;
		while (remaining > 0) {
			const size = Math.min(chunkBytes, remaining);
			const chunk = new Uint8Array(size);
			chunk.fill(0xaa);
			wrong.push(chunk);
			remaining -= size;
		}
		let index = 0;
		const session: Session = {
			role: "client",
			async sendMessage() {
				throw new Error("unused");
			},
			async receiveMessage() {
				throw new Error("unused");
			},
			async sendText() {
				throw new Error("unused");
			},
			async openUni() {
				throw new Error("unused");
			},
			async acceptUni() {
				return {
					channelId: 1,
					async read() {
						if (index >= wrong.length) return null;
						clock.advance(10);
						return wrong[index++]!;
					},
					async cancel() {},
				};
			},
			async openBidi() {
				throw new Error("unused");
			},
			async acceptBidi() {
				throw new Error("unused");
			},
			async close() {},
			snapshot() {
				return emptyMetrics();
			},
		};
		await expect(
			executeBulkOneWay({
				session,
				cell: bulkCell(bytes, chunkBytes),
				driverRunId: "bulk-digest-mismatch",
				runId: "run-digest",
				sessionId: "session-digest",
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS["bulk-one-way"]!,
			}),
		).rejects.toThrow(/digest mismatch/);
	});

	test("the registry executor dispatches to executeBulkOneWay", async () => {
		const executor = getScenarioExecutor("bulk-one-way");
		expect(executor).toBeDefined();
		const clock = frozenClock();
		const { session } = fakeSinkSession(clock, 32_768, 16_384);
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
		const evidence = await import("./evidence.ts");
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
		const grant: import("./evidence.ts").MeasurementGrantV1 = {
			schema: evidence.MEASUREMENT_GRANT_SCHEMA,
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
				grantSha256: evidence.measurementGrantSha256(grant),
				lastSampleAtMs: sealed.provenance.lastSampleAtMs,
				latencySumMs: sealed.samples.reduce((a, b) => a + b, 0),
				payloadSha256: evidence.sha256HexOfBytes(
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
				perSession: { busyMs: 1, idleMs: 10 },
				serverAggregate: { busyMs: 1, idleMs: 10 },
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
