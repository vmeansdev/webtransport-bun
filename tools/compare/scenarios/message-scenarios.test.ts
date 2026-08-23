/**
 * Task 7: Message-based scenario tests (pure-driver, in-memory / fake-backed).
 *
 * Tests:
 * - publisher/subscriber barriers
 * - exact fan counts (e.g. 10 publishers, 100 subscribers)
 * - 1:100 ticker expansion
 * - open-loop offered rates and overload accounting (100k x 100 remains 100,000,000 offered on drops)
 * - per-receiver unique ledgers (duplicate and reordering detection)
 * - raw WS reliability vs labeled WS expiry overlay
 * - WT datagram expiry and latest-state age calculation
 * - reliable control acknowledgements
 * - cross-traffic isolation (tail-under-cross-traffic control vs 700 Mbps bulk)
 */

import { describe, expect, it } from "bun:test";
import {
	type ChatScenarioConfig,
	type ChatScenarioResult,
	createChatLedger,
	runChatFanoutPure,
} from "./fanout.ts";
import {
	createGameLedger,
	type GameScenarioConfig,
	type GameScenarioResult,
	runGameTickLossPure,
} from "./game.ts";
import {
	createTailLedger,
	runTailCrossTrafficPure,
	type TailScenarioConfig,
	type TailScenarioResult,
} from "./tail.ts";
import {
	createTickerLedger,
	runTickerFanoutPure,
	type TickerScenarioConfig,
	type TickerScenarioResult,
} from "./ticker.ts";

describe("Task 7: Chat fanout scenario", () => {
	it("initializes and records offered vs delivered in per-receiver ledgers", () => {
		const ledger = createChatLedger({
			runId: "run-chat-1",
			publisherCount: 2,
			subscriberCount: 3,
			messageBytes: 128,
			durationSeconds: 1,
			messagesPerSecondPerPublisher: 1,
		});

		// Record 2 publisher sends
		ledger.recordOffered("pub-1", 1, 1000);
		ledger.recordAccepted("pub-1", 1, 1001);
		ledger.recordServerObserved("pub-1", 1, 1005);

		ledger.recordOffered("pub-2", 1, 1000);
		ledger.recordAccepted("pub-2", 1, 1001);
		ledger.recordServerObserved("pub-2", 1, 1006);

		// Each message is broadcast to 3 subscribers
		ledger.recordDelivered("sub-1", "pub-1", 1, 1010);
		ledger.recordDelivered("sub-2", "pub-1", 1, 1012);
		ledger.recordDelivered("sub-3", "pub-1", 1, 1015);

		ledger.recordDelivered("sub-1", "pub-2", 1, 1011);
		ledger.recordDelivered("sub-2", "pub-2", 1, 1013);
		// sub-3 misses pub-2 msg 1

		const result = ledger.finalize();
		expect(result.offeredPublishMessages).toBe(2);
		expect(result.offeredDeliveredTotal).toBe(6); // 2 msgs * 3 subs
		expect(result.deliveredTotal).toBe(5);
		expect(result.deliveryRatio).toBeCloseTo(5 / 6, 4);
		expect(result.duplicateCount).toBe(0);
		expect(result.reorderedCount).toBe(0);
		expect(result.latenciesMs.length).toBe(5);
	});

	it("detects duplicate and reordered deliveries per publisher on a subscriber", () => {
		const ledger = createChatLedger({
			runId: "run-chat-dup",
			publisherCount: 1,
			subscriberCount: 1,
			messageBytes: 128,
			durationSeconds: 1,
			messagesPerSecondPerPublisher: 3,
		});

		ledger.recordOffered("pub-1", 1, 1000);
		ledger.recordOffered("pub-1", 2, 1010);
		ledger.recordOffered("pub-1", 3, 1020);

		// sub-1 receives msg 2 before msg 1 (reordered)
		ledger.recordDelivered("sub-1", "pub-1", 2, 1015);
		ledger.recordDelivered("sub-1", "pub-1", 1, 1025);
		// sub-1 receives duplicate of msg 2
		ledger.recordDelivered("sub-1", "pub-1", 2, 1030);

		const result = ledger.finalize();
		expect(result.duplicateCount).toBe(1);
		expect(result.reorderedCount).toBe(1);
	});

	it("runs in-memory chat fanout scenario with publisher and subscriber barriers", async () => {
		let clock = 1000;
		const config: ChatScenarioConfig = {
			runId: "run-chat-test",
			publisherCount: 2,
			subscriberCount: 5,
			messageBytes: 128,
			durationSeconds: 1,
			messagesPerSecondPerPublisher: 2,
			clock: {
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			},
		};

		const result = await runChatFanoutPure(config);
		expect(result.offeredPublishMessages).toBe(4); // 2 publishers * 2 msgs
		expect(result.offeredDeliveredTotal).toBe(20); // 4 * 5 subscribers
		expect(result.deliveredTotal).toBe(20);
		expect(result.deliveryRatio).toBe(1);
		expect(result.summary.count).toBe(20);
		expect(result.summary.p50).toBeGreaterThanOrEqual(0);
	});
});

describe("Task 7: Ticker fanout scenario & overload accounting", () => {
	it("enforces open-loop 1:100 fanout accounting", () => {
		const ledger = createTickerLedger({
			runId: "run-tick-1",
			ingressRatePerSecond: 10_000,
			recordBytes: 100,
			durationSeconds: 10,
			fanout: 100,
		});

		// The offered total is fixed open-loop: 10,000 * 10 * 100 = 10,000,000
		expect(ledger.expectedOfferedBroadcasts).toBe(10_000_000);

		// Record 100 published records
		for (let i = 1; i <= 100; i++) {
			ledger.recordOffered(i, 1000 + i);
			ledger.recordServerObserved(i, 1000 + i + 1);
		}

		// Deliver to 90 subscribers (10 dropped per record)
		for (let i = 1; i <= 100; i++) {
			for (let s = 1; s <= 90; s++) {
				ledger.recordDelivered(`sub-${s}`, i, 1000 + i + 5);
			}
		}

		const result = ledger.finalize();
		// In a 10s run, offered was 10M regardless of how many actually got delivered
		expect(result.offeredBroadcasts).toBe(10_000_000);
		expect(result.deliveredBroadcasts).toBe(9_000);
		expect(result.completeness).toBeCloseTo(9_000 / 10_000_000, 6);
	});

	it("overload accounting: 100k x 100 remains offered workload even on zero delivery", () => {
		const ledger = createTickerLedger({
			runId: "run-tick-overload",
			ingressRatePerSecond: 100_000,
			recordBytes: 100,
			durationSeconds: 10,
			fanout: 100,
		});

		// 100k * 10 * 100 = 100,000,000 offered
		expect(ledger.expectedOfferedBroadcasts).toBe(100_000_000);

		// Server drops everything after 50 records
		for (let i = 1; i <= 50; i++) {
			ledger.recordOffered(i, 1000);
		}

		const result = ledger.finalize();
		expect(result.offeredBroadcasts).toBe(100_000_000);
		expect(result.deliveredBroadcasts).toBe(0);
		expect(result.completeness).toBe(0);
		// No downshifting or reduction of offered target
		expect(result.offeredRecords).toBe(1_000_000);
	});

	it("runs in-memory ticker fanout simulation", async () => {
		let clock = 5000;
		const config: TickerScenarioConfig = {
			runId: "run-ticker-sim",
			ingressRatePerSecond: 10,
			recordBytes: 100,
			durationSeconds: 2,
			fanout: 5,
			dropRatio: 0.1, // simulated 10% drops
			clock: {
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			},
		};

		const result = await runTickerFanoutPure(config);
		expect(result.offeredRecords).toBe(20);
		expect(result.offeredBroadcasts).toBe(100);
		expect(result.deliveredBroadcasts).toBe(90); // 10% dropped
		expect(result.completeness).toBeCloseTo(0.9, 2);
	});
});

describe("Task 7: Game tick loss scenario (latest-state, age, overlays)", () => {
	it("records tick freshness, stale ticks, and expired ticks", () => {
		const ledger = createGameLedger({
			runId: "run-game-1",
			tickHz: 60,
			tickBytes: 64,
			durationSeconds: 1,
			receiverCount: 2,
			delivery: "latest-state",
			lossyOverlay: false,
		});

		// 60 ticks offered
		for (let tick = 1; tick <= 60; tick++) {
			const scheduledAt = 1000 + Math.round((tick * 1000) / 60);
			const expiresAt = scheduledAt + 50; // expires in 50ms
			ledger.recordOffered(tick, scheduledAt, expiresAt);
		}

		// Receiver 1 gets tick 1 on time (age = 10ms)
		ledger.recordReceived("rcv-1", 1, 1016 + 10, 1016, 1066);
		// Receiver 1 gets tick 3 (skips tick 2)
		ledger.recordReceived("rcv-1", 3, 1050 + 10, 1050, 1100);
		// Receiver 1 gets tick 2 late (stale because tick 3 already arrived)
		ledger.recordReceived("rcv-1", 2, 1033 + 40, 1033, 1083);

		// Receiver 2 gets tick 1 after expiry (age = 60ms > 50ms)
		ledger.recordReceived("rcv-2", 1, 1016 + 60, 1016, 1066);

		const result = ledger.finalize();
		expect(result.offeredTicks).toBe(120); // 60 ticks * 2 receivers
		expect(result.receivedTicks).toBe(4);
		expect(result.staleTicks).toBe(1); // tick 2 received after tick 3
		expect(result.expiredTicks).toBe(1); // tick 1 on rcv-2
		expect(result.agesMs.length).toBe(4);
	});

	it("ws-lossy-overlay drops expired updates at receiver while raw WS delivers stale updates", () => {
		// Raw WS ledger
		const rawLedger = createGameLedger({
			runId: "run-game-raw",
			tickHz: 20,
			tickBytes: 64,
			durationSeconds: 1,
			receiverCount: 1,
			delivery: "latest-state",
			lossyOverlay: false,
		});

		// WS Lossy Overlay ledger
		const overlayLedger = createGameLedger({
			runId: "run-game-overlay",
			tickHz: 20,
			tickBytes: 64,
			durationSeconds: 1,
			receiverCount: 1,
			delivery: "latest-state",
			lossyOverlay: true,
		});

		// Ticks 1 and 2
		const t1Sched = 1000,
			t1Exp = 1050;
		const t2Sched = 1050,
			t2Exp = 1100;

		rawLedger.recordOffered(1, t1Sched, t1Exp);
		rawLedger.recordOffered(2, t2Sched, t2Exp);
		overlayLedger.recordOffered(1, t1Sched, t1Exp);
		overlayLedger.recordOffered(2, t2Sched, t2Exp);

		// Suppose tick 1 arrives late (at 1070ms, after expiry 1050)
		// Raw WS counts it as received (but expired/stale)
		rawLedger.recordReceived("rcv-1", 1, 1070, t1Sched, t1Exp);
		// Overlay drops it: not counted as delivered
		overlayLedger.recordReceived("rcv-1", 1, 1070, t1Sched, t1Exp);

		const rawResult = rawLedger.finalize();
		const overlayResult = overlayLedger.finalize();

		expect(rawResult.receivedTicks).toBe(1);
		expect(rawResult.expiredTicks).toBe(1);

		expect(overlayResult.receivedTicks).toBe(0); // dropped by overlay
		expect(overlayResult.expiredTicks).toBe(1);
	});

	it("runs pure game tick simulation computing p50/p95/p99 latest-state age", async () => {
		let clock = 1000;
		const config: GameScenarioConfig = {
			runId: "run-game-pure",
			tickHz: 20,
			tickBytes: 64,
			durationSeconds: 1,
			receiverCount: 4,
			lossPercent: 5,
			delayMs: 20,
			delivery: "latest-state",
			lossyOverlay: false,
			clock: {
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			},
		};

		const result = await runGameTickLossPure(config);
		expect(result.offeredTicks).toBe(80); // 20 ticks * 4 receivers
		expect(result.deliveryPercent).toBeGreaterThan(0);
		expect(result.summary.p50).toBeGreaterThanOrEqual(0);
		expect(result.summary.p95).toBeGreaterThanOrEqual(result.summary.p50);
		expect(result.summary.p99).toBeGreaterThanOrEqual(result.summary.p95);
	});
});

describe("Task 7: Tail-under-cross-traffic scenario (isolation, <=4ms classifier)", () => {
	it("records control ping-ack latencies and classifies <=4ms vs tail", () => {
		const ledger = createTailLedger({
			runId: "run-tail-1",
			controlMessageBytes: 64,
			controlRatePerSecond: 1,
			durationSeconds: 10,
			bulkChunkBytes: 65536,
			bulkRateMbps: 700,
		});

		// Record 10 control ping-pong exchanges with varying latencies
		const latencies = [2.1, 3.4, 1.8, 4.0, 4.2, 12.5, 3.1, 2.9, 150.0, 3.8];
		for (let seq = 1; seq <= 10; seq++) {
			const sendTime = 1000 + seq * 1000;
			const rtt = latencies[seq - 1]!;
			ledger.recordControlOffered(seq, sendTime);
			ledger.recordControlAcknowledged(seq, sendTime + rtt);
		}

		// Record bulk bytes delivered
		ledger.recordBulkDelivered(700 * 1024 * 1024); // 700 MB

		const result = ledger.finalize();
		expect(result.controlOffered).toBe(10);
		expect(result.controlDelivered).toBe(10);
		expect(result.controlLatenciesMs.length).toBe(10);

		// <= 4ms classifier: 2.1, 3.4, 1.8, 4.0, 3.1, 2.9, 3.8 = 7 out of 10
		expect(result.controlUnder4msCount).toBe(7);
		expect(result.controlUnder4msPercent).toBe(70);

		// Summary percentiles
		expect(result.controlP50Ms).toBeGreaterThan(0);
		expect(result.controlP99Ms).toBeGreaterThan(result.controlP50Ms);
		expect(result.bulkAchievedMbps).toBeGreaterThan(0);
	});

	it("runs in-memory tail-under-cross-traffic simulation with stream isolation", async () => {
		let clock = 1000;
		const config: TailScenarioConfig = {
			runId: "run-tail-pure",
			controlMessageBytes: 64,
			controlRatePerSecond: 1,
			durationSeconds: 5,
			bulkChunkBytes: 65536,
			bulkRateMbps: 700,
			transportKind: "wt", // WT uses separate streams -> lower tail latency
			clock: {
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			},
		};

		const result = await runTailCrossTrafficPure(config);
		expect(result.controlOffered).toBe(5);
		expect(result.controlDelivered).toBe(5);
		expect(result.controlUnder4msPercent).toBeGreaterThanOrEqual(0);
		expect(result.bulkAchievedMbps).toBeGreaterThan(0);
	});
});
