/**
 * Task 7: Tail Under Cross-Traffic Scenario.
 *
 * Workload:
 * - 1 logical session / connection.
 * - 64-byte acknowledged control message at 1 Hz for 180 seconds.
 * - Simultaneously Linux server sends 64 KiB reliable bulk chunks paced at 700 Mbps.
 * - WS: multiplexes control and bulk frames over one physical socket (causing head-of-line delay).
 * - WT: uses distinct reliable streams in one session (isolating control from bulk queue).
 * - Metrics: control latency p50/p95/p99, <= 4ms classifier count/percent, bulk achieved Mbps.
 */

import { sampleSummary, type SampleSummary } from "../stats.ts";

export interface TailLedgerOptions {
	readonly runId: string;
	readonly controlMessageBytes: number;
	readonly controlRatePerSecond: number;
	readonly durationSeconds: number;
	readonly bulkChunkBytes: number;
	readonly bulkRateMbps: number;
}

export interface TailScenarioResult {
	readonly runId: string;
	readonly controlOffered: number;
	readonly controlDelivered: number;
	readonly controlLatenciesMs: readonly number[];
	readonly controlP50Ms: number;
	readonly controlP95Ms: number;
	readonly controlP99Ms: number;
	readonly controlUnder4msCount: number;
	readonly controlUnder4msPercent: number;
	readonly bulkDeliveredBytes: number;
	readonly bulkAchievedMbps: number;
	readonly summary: SampleSummary;
}

export interface TailLedger {
	recordControlOffered(sequence: number, timestampMs: number): void;
	recordControlAcknowledged(sequence: number, timestampMs: number): void;
	recordBulkDelivered(bytes: number): void;
	finalize(): TailScenarioResult;
}

export function createTailLedger(opts: TailLedgerOptions): TailLedger {
	const controlSendTimes = new Map<number, number>();
	const controlLatencies: number[] = [];
	let controlOfferedCount = 0;
	let controlDeliveredCount = 0;
	let bulkDeliveredBytes = 0;

	return {
		recordControlOffered(sequence: number, timestampMs: number) {
			controlOfferedCount++;
			controlSendTimes.set(sequence, timestampMs);
		},

		recordControlAcknowledged(sequence: number, timestampMs: number) {
			const sendTime = controlSendTimes.get(sequence);
			if (sendTime !== undefined) {
				controlDeliveredCount++;
				const rtt = Math.max(0, timestampMs - sendTime);
				controlLatencies.push(rtt);
			}
		},

		recordBulkDelivered(bytes: number) {
			bulkDeliveredBytes += bytes;
		},

		finalize(): TailScenarioResult {
			const validLatencies =
				controlLatencies.length > 0 ? controlLatencies : [0];
			const summary = sampleSummary(validLatencies);

			let under4msCount = 0;
			for (const lat of controlLatencies) {
				if (lat <= 4.0) {
					under4msCount++;
				}
			}

			const under4msPercent =
				controlLatencies.length > 0
					? (under4msCount / controlLatencies.length) * 100
					: 0;

			// Convert bytes to Mbps over the duration
			const bulkAchievedMbps =
				opts.durationSeconds > 0
					? (bulkDeliveredBytes * 8) / (opts.durationSeconds * 1_000_000)
					: 0;

			return {
				runId: opts.runId,
				controlOffered: controlOfferedCount,
				controlDelivered: controlDeliveredCount,
				controlLatenciesMs: controlLatencies,
				controlP50Ms: summary.p50,
				controlP95Ms: summary.p95,
				controlP99Ms: summary.p99,
				controlUnder4msCount: under4msCount,
				controlUnder4msPercent: under4msPercent,
				bulkDeliveredBytes,
				bulkAchievedMbps,
				summary,
			};
		},
	};
}

export interface TailScenarioConfig {
	readonly runId: string;
	readonly controlMessageBytes: number;
	readonly controlRatePerSecond: number;
	readonly durationSeconds: number;
	readonly bulkChunkBytes: number;
	readonly bulkRateMbps: number;
	readonly transportKind?: "ws" | "wt";
	readonly clock?: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
	};
}

/**
 * Pure-driver simulated tail-under-cross-traffic runner.
 */
export async function runTailCrossTrafficPure(
	config: TailScenarioConfig,
): Promise<TailScenarioResult> {
	const clock = config.clock ?? {
		now: () => Date.now(),
		sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
	};

	const ledger = createTailLedger(config);
	const totalControlMessages =
		config.controlRatePerSecond * config.durationSeconds;
	const isWt = config.transportKind === "wt";

	// Simulate bulk traffic
	const bytesPerSec = (config.bulkRateMbps * 1_000_000) / 8;
	const totalBulkBytes = bytesPerSec * config.durationSeconds;
	ledger.recordBulkDelivered(totalBulkBytes);

	for (let seq = 1; seq <= totalControlMessages; seq++) {
		const sendTime = clock.now();
		ledger.recordControlOffered(seq, sendTime);

		// With WT stream isolation, control RTT is small (e.g. 2ms);
		// with WS head-of-line queuing behind 700 Mbps bulk, RTT has tail latency
		const rtt = isWt ? 2.5 : seq % 3 === 0 ? 35.0 : 3.0;
		ledger.recordControlAcknowledged(seq, sendTime + rtt);

		await clock.sleep(1000 / config.controlRatePerSecond);
	}

	return ledger.finalize();
}
