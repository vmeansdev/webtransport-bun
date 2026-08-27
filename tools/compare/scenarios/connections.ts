/**
 * Task 8: Connection Lifecycle Scenarios:
 * 1. reconnect-storm (100 clients x 10 cycles, 0-RTT vs cold)
 * 2. handshake-matrix (physical baseline vs delay40, cold vs warm-after-prime)
 * 3. connection-memory (1k / 5k / 10k concurrent idle connections, RSS / socket delta)
 */

import { type SampleSummary, sampleSummary } from "../stats.ts";

// ---------------------------------------------------------------------------
// Reconnect Storm
// ---------------------------------------------------------------------------

export interface ReconnectTruthCounters {
	readonly has0Rtt: boolean;
	readonly accepted0Rtt: boolean;
	readonly handshakeConfirmed: boolean;
}

export interface ReconnectLedgerOptions {
	readonly runId: string;
	readonly clientCount: number;
	readonly reconnectCycles: number;
	readonly concurrency: number;
	readonly state: "cold-full" | "warm-after-prime";
	readonly transportKind: "ws" | "wt";
}

export interface ReconnectScenarioResult {
	readonly runId: string;
	readonly totalCycles: number;
	readonly successfulCycles: number;
	readonly failureCount: number;
	readonly has0RttCount: number;
	readonly accepted0RttCount: number;
	readonly handshakeConfirmedCount: number;
	readonly latenciesMs: readonly number[];
	readonly summary: SampleSummary;
}

export interface ReconnectLedger {
	readonly expectedTotalCycles: number;
	recordCycleStart(clientId: string, cycle: number, timestampMs: number): void;
	recordCycleAck(
		clientId: string,
		cycle: number,
		timestampMs: number,
		truth?: ReconnectTruthCounters,
	): void;
	recordCycleFailure(clientId: string, cycle: number, error: unknown): void;
	finalize(): ReconnectScenarioResult;
}

export function createReconnectLedger(
	opts: ReconnectLedgerOptions,
): ReconnectLedger {
	const expectedTotalCycles = opts.clientCount * opts.reconnectCycles;
	const startTimes = new Map<string, number>(); // "clientId:cycle" -> startMs
	const latencies: number[] = [];
	let successfulCycles = 0;
	let failureCount = 0;
	let has0RttCount = 0;
	let accepted0RttCount = 0;
	let handshakeConfirmedCount = 0;

	const isWt = opts.transportKind === "wt";

	return {
		expectedTotalCycles,

		recordCycleStart(clientId: string, cycle: number, timestampMs: number) {
			startTimes.set(`${clientId}:${cycle}`, timestampMs);
		},

		recordCycleAck(
			clientId: string,
			cycle: number,
			timestampMs: number,
			truth?: ReconnectTruthCounters,
		) {
			const key = `${clientId}:${cycle}`;
			const start = startTimes.get(key);
			if (start !== undefined) {
				successfulCycles++;
				const rtt = Math.max(0, timestampMs - start);
				latencies.push(rtt);
			}

			// WS never receives synthetic 0-RTT labels
			if (isWt && truth) {
				if (truth.has0Rtt) has0RttCount++;
				if (truth.accepted0Rtt) accepted0RttCount++;
				if (truth.handshakeConfirmed) handshakeConfirmedCount++;
			}
		},

		recordCycleFailure(_clientId: string, _cycle: number, _error: unknown) {
			failureCount++;
		},

		finalize(): ReconnectScenarioResult {
			const validLatencies = latencies.length > 0 ? latencies : [0];
			const summary = sampleSummary(validLatencies);

			return {
				runId: opts.runId,
				totalCycles: expectedTotalCycles,
				successfulCycles,
				failureCount,
				has0RttCount,
				accepted0RttCount,
				handshakeConfirmedCount,
				latenciesMs: latencies,
				summary,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Handshake Matrix
// ---------------------------------------------------------------------------

export interface HandshakeLedgerOptions {
	readonly runId: string;
	readonly clientCount: number;
	readonly path: "physical" | "delay40";
	readonly state: "cold" | "warm-after-prime";
	readonly transportKind: "ws" | "wt";
}

export interface HandshakeScenarioResult {
	readonly runId: string;
	readonly totalHandshakes: number;
	readonly successfulHandshakes: number;
	readonly failureCount: number;
	readonly readyLatenciesMs: readonly number[];
	readonly firstMessageLatenciesMs: readonly number[];
	readonly readySummary: SampleSummary;
	readonly firstMessageSummary: SampleSummary;
}

export interface HandshakeLedger {
	readonly expectedHandshakes: number;
	recordHandshakeStart(clientId: string, timestampMs: number): void;
	recordHandshakeReady(clientId: string, timestampMs: number): void;
	recordFirstMessageAck(
		clientId: string,
		timestampMs: number,
		truth?: ReconnectTruthCounters,
	): void;
	recordHandshakeFailure(clientId: string, error: unknown): void;
	finalize(): HandshakeScenarioResult;
}

export function createHandshakeLedger(
	opts: HandshakeLedgerOptions,
): HandshakeLedger {
	const expectedHandshakes = opts.clientCount;
	const startTimes = new Map<string, number>();
	const readyLatencies: number[] = [];
	const firstMessageLatencies: number[] = [];
	let successfulHandshakes = 0;
	let failureCount = 0;

	return {
		expectedHandshakes,

		recordHandshakeStart(clientId: string, timestampMs: number) {
			startTimes.set(clientId, timestampMs);
		},

		recordHandshakeReady(clientId: string, timestampMs: number) {
			const start = startTimes.get(clientId);
			if (start !== undefined) {
				readyLatencies.push(Math.max(0, timestampMs - start));
			}
		},

		recordFirstMessageAck(
			clientId: string,
			timestampMs: number,
			_truth?: ReconnectTruthCounters,
		) {
			const start = startTimes.get(clientId);
			if (start !== undefined) {
				successfulHandshakes++;
				firstMessageLatencies.push(Math.max(0, timestampMs - start));
			}
		},

		recordHandshakeFailure(_clientId: string, _error: unknown) {
			failureCount++;
		},

		finalize(): HandshakeScenarioResult {
			const validReady = readyLatencies.length > 0 ? readyLatencies : [0];
			const validFirst =
				firstMessageLatencies.length > 0 ? firstMessageLatencies : [0];

			return {
				runId: opts.runId,
				totalHandshakes: expectedHandshakes,
				successfulHandshakes,
				failureCount,
				readyLatenciesMs: readyLatencies,
				firstMessageLatenciesMs: firstMessageLatencies,
				readySummary: sampleSummary(validReady),
				firstMessageSummary: sampleSummary(validFirst),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Connection Memory
// ---------------------------------------------------------------------------

export interface HostMetricsSnapshot {
	readonly linuxRssBytes: number;
	readonly macRssBytes: number;
	readonly linuxFdCount: number;
}

export interface ConnectionMemoryLedgerOptions {
	readonly runId: string;
	readonly liveConnections: number;
	readonly holdSeconds: number;
	readonly transportKind: "ws" | "wt";
}

export interface ConnectionMemoryResult {
	readonly runId: string;
	readonly targetLiveConnections: number;
	readonly establishedConnections: number;
	readonly baselineLinuxRssBytes: number;
	readonly peakLinuxRssBytes: number;
	readonly linuxRssDeltaBytes: number;
	readonly bytesPerConnection: number;
	readonly cleanupRecovered: boolean;
}

export interface ConnectionMemoryLedger {
	recordBaseline(snapshot: HostMetricsSnapshot): void;
	recordConnectionEstablished(connId: string, timestampMs: number): void;
	recordPeak(snapshot: HostMetricsSnapshot): void;
	recordConnectionClosed(connId: string, timestampMs: number): void;
	recordPostCleanup(snapshot: HostMetricsSnapshot): void;
	finalize(): ConnectionMemoryResult;
}

export function createConnectionMemoryLedger(
	opts: ConnectionMemoryLedgerOptions,
): ConnectionMemoryLedger {
	let baseline: HostMetricsSnapshot = {
		linuxRssBytes: 0,
		macRssBytes: 0,
		linuxFdCount: 0,
	};
	let peak: HostMetricsSnapshot = {
		linuxRssBytes: 0,
		macRssBytes: 0,
		linuxFdCount: 0,
	};
	let postCleanup: HostMetricsSnapshot = {
		linuxRssBytes: 0,
		macRssBytes: 0,
		linuxFdCount: 0,
	};
	let establishedCount = 0;
	let closedCount = 0;

	return {
		recordBaseline(snapshot: HostMetricsSnapshot) {
			baseline = snapshot;
		},

		recordConnectionEstablished(_connId: string, _timestampMs: number) {
			establishedCount++;
		},

		recordPeak(snapshot: HostMetricsSnapshot) {
			peak = snapshot;
		},

		recordConnectionClosed(_connId: string, _timestampMs: number) {
			closedCount++;
		},

		recordPostCleanup(snapshot: HostMetricsSnapshot) {
			postCleanup = snapshot;
		},

		finalize(): ConnectionMemoryResult {
			const delta = Math.max(0, peak.linuxRssBytes - baseline.linuxRssBytes);
			const bytesPerConn = establishedCount > 0 ? delta / establishedCount : 0;

			// Cleanup recovered if closed equals established and post-cleanup RSS is near baseline
			const cleanupRecovered =
				closedCount === establishedCount &&
				postCleanup.linuxRssBytes <= baseline.linuxRssBytes * 1.15;

			return {
				runId: opts.runId,
				targetLiveConnections: opts.liveConnections,
				establishedConnections: establishedCount,
				baselineLinuxRssBytes: baseline.linuxRssBytes,
				peakLinuxRssBytes: peak.linuxRssBytes,
				linuxRssDeltaBytes: delta,
				bytesPerConnection: bytesPerConn,
				cleanupRecovered,
			};
		},
	};
}
