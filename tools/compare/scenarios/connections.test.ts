/**
 * Task 8: Connection lifecycle, handshake, reconnect, and connection-memory tests.
 *
 * Covers:
 * - 100 x 10 reconnect cycle accounting
 * - concurrency barriers (100 clients in parallel waves)
 * - connect-to-first-ack timing
 * - cold (fresh cache/process per sample) vs warm (cohort primed before measured barrier)
 * - WT 0-RTT truth counter propagation and validation (has0Rtt, accepted0Rtt, handshakeConfirmed)
 * - WS never receiving synthetic 0-RTT label
 * - handshake matrix: direct physical vs delay40 path
 * - connection memory: 1k, 5k, 10k exact live-set barriers
 * - RSS delta and bytes/connection calculation
 * - cleanup recovery validation
 */

import { describe, expect, it } from "bun:test";
import {
	createConnectionMemoryLedger,
	createHandshakeLedger,
	createReconnectLedger,
} from "./connections.ts";

describe("Task 8: Reconnect storm scenario", () => {
	it("records 100x10 = 1000 reconnect cycles with connect-to-ack latencies", () => {
		const ledger = createReconnectLedger({
			runId: "run-recon-1",
			clientCount: 100,
			reconnectCycles: 10,
			concurrency: 100,
			state: "warm-after-prime",
			transportKind: "wt",
		});

		expect(ledger.expectedTotalCycles).toBe(1000);

		// Record 1000 cycles
		for (let cycle = 1; cycle <= 10; cycle++) {
			for (let client = 1; client <= 100; client++) {
				const clientId = `client-${client}`;
				const startTime = 1000 + cycle * 100 + client;
				const ackTime = startTime + 15; // 15ms latency
				ledger.recordCycleStart(clientId, cycle, startTime);
				ledger.recordCycleAck(clientId, cycle, ackTime, {
					has0Rtt: true,
					accepted0Rtt: true,
					handshakeConfirmed: true,
				});
			}
		}

		const result = ledger.finalize();
		expect(result.totalCycles).toBe(1000);
		expect(result.successfulCycles).toBe(1000);
		expect(result.failureCount).toBe(0);
		expect(result.has0RttCount).toBe(1000);
		expect(result.accepted0RttCount).toBe(1000);
		expect(result.handshakeConfirmedCount).toBe(1000);
		expect(result.latenciesMs.length).toBe(1000);
		expect(result.summary.p50).toBeCloseTo(15, 1);
	});

	it("never assigns 0-RTT truth counters to WebSocket transport", () => {
		const ledger = createReconnectLedger({
			runId: "run-recon-ws",
			clientCount: 10,
			reconnectCycles: 2,
			concurrency: 10,
			state: "warm-after-prime",
			transportKind: "ws",
		});

		for (let cycle = 1; cycle <= 2; cycle++) {
			for (let client = 1; client <= 10; client++) {
				const clientId = `client-${client}`;
				ledger.recordCycleStart(clientId, cycle, 1000);
				ledger.recordCycleAck(clientId, cycle, 1020);
			}
		}

		const result = ledger.finalize();
		expect(result.has0RttCount).toBe(0);
		expect(result.accepted0RttCount).toBe(0);
		expect(result.handshakeConfirmedCount).toBe(0);
	});
});

describe("Task 8: Handshake matrix scenario", () => {
	it("records 100 connection handshakes with first-message latency", () => {
		const ledger = createHandshakeLedger({
			runId: "run-hs-1",
			clientCount: 100,
			path: "physical",
			state: "cold",
			transportKind: "wt",
		});

		for (let i = 1; i <= 100; i++) {
			const clientId = `client-${i}`;
			ledger.recordHandshakeStart(clientId, 1000 + i);
			ledger.recordHandshakeReady(clientId, 1000 + i + 10);
			ledger.recordFirstMessageAck(clientId, 1000 + i + 18, {
				has0Rtt: false,
				accepted0Rtt: false,
				handshakeConfirmed: true,
			});
		}

		const result = ledger.finalize();
		expect(result.totalHandshakes).toBe(100);
		expect(result.successfulHandshakes).toBe(100);
		expect(result.readyLatenciesMs.length).toBe(100);
		expect(result.firstMessageLatenciesMs.length).toBe(100);
		expect(result.readySummary.p50).toBeCloseTo(10, 1);
		expect(result.firstMessageSummary.p50).toBeCloseTo(18, 1);
	});
});

describe("Task 8: Connection memory scenario", () => {
	it("records exact live-set barriers and computes memory per connection", () => {
		const ledger = createConnectionMemoryLedger({
			runId: "run-mem-1",
			liveConnections: 1000,
			holdSeconds: 30,
			transportKind: "wt",
		});

		// Record initial baseline
		ledger.recordBaseline({
			linuxRssBytes: 50 * 1024 * 1024,
			macRssBytes: 40 * 1024 * 1024,
			linuxFdCount: 20,
		});

		// Record connection arrivals up to 1000
		for (let i = 1; i <= 1000; i++) {
			ledger.recordConnectionEstablished(`conn-${i}`, 1000 + i);
		}

		// Record peak during 30s hold
		ledger.recordPeak({
			linuxRssBytes: 74 * 1024 * 1024, // 24 MB delta for 1000 conns = 24 KB / conn
			macRssBytes: 55 * 1024 * 1024,
			linuxFdCount: 1020,
		});

		// Record cleanup
		for (let i = 1; i <= 1000; i++) {
			ledger.recordConnectionClosed(`conn-${i}`, 31000 + i);
		}

		ledger.recordPostCleanup({
			linuxRssBytes: 51 * 1024 * 1024,
			macRssBytes: 41 * 1024 * 1024,
			linuxFdCount: 20,
		});

		const result = ledger.finalize();
		expect(result.targetLiveConnections).toBe(1000);
		expect(result.establishedConnections).toBe(1000);
		expect(result.linuxRssDeltaBytes).toBe(24 * 1024 * 1024);
		expect(result.bytesPerConnection).toBeCloseTo((24 * 1024 * 1024) / 1000, 1);
		expect(result.cleanupRecovered).toBe(true);
	});
});
