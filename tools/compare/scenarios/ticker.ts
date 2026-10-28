/**
 * Task 7: Ticker Fanout Scenario.
 *
 * Workload:
 * - 1 publisher, 100 subscribers.
 * - 100-byte reliable records at 10k / 50k / 100k records/s for 10 seconds.
 * - Broadcast expansion 1:100.
 * - Overload accounting: 100k x 100 = 10,000,000 offered records/broadcasts.
 *   Overload is a measured outcome (drops/backpressure), never silently downscaled.
 */

import { type SampleSummary, sampleSummary } from "../stats.ts";

export interface TickerLedgerOptions {
	readonly runId: string;
	readonly ingressRatePerSecond: number;
	readonly recordBytes: number;
	readonly durationSeconds: number;
	readonly fanout: number;
}

export interface TickerScenarioResult {
	readonly runId: string;
	readonly offeredRecords: number;
	readonly offeredBroadcasts: number;
	readonly deliveredBroadcasts: number;
	readonly deliveredBytes: number;
	readonly completeness: number;
	readonly latenciesMs: readonly number[];
	readonly summary: SampleSummary;
}

export interface TickerLedger {
	readonly expectedOfferedRecords: number;
	readonly expectedOfferedBroadcasts: number;
	recordOffered(sequence: number, timestampMs: number): void;
	recordServerObserved(sequence: number, timestampMs: number): void;
	recordDelivered(
		subscriberId: string,
		sequence: number,
		timestampMs: number,
	): void;
	finalize(): TickerScenarioResult;
}

export function createTickerLedger(opts: TickerLedgerOptions): TickerLedger {
	const expectedOfferedRecords =
		opts.ingressRatePerSecond * opts.durationSeconds;
	const expectedOfferedBroadcasts = expectedOfferedRecords * opts.fanout;

	const offeredTimestamps = new Map<number, number>();
	const latencies: number[] = [];
	let deliveredBroadcasts = 0;

	return {
		expectedOfferedRecords,
		expectedOfferedBroadcasts,

		recordOffered(sequence: number, timestampMs: number) {
			if (!offeredTimestamps.has(sequence)) {
				offeredTimestamps.set(sequence, timestampMs);
			}
		},

		recordServerObserved(_sequence: number, _timestampMs: number) {
			// Observed at Linux server
		},

		recordDelivered(
			_subscriberId: string,
			sequence: number,
			timestampMs: number,
		) {
			deliveredBroadcasts++;
			const sendTime = offeredTimestamps.get(sequence);
			if (sendTime !== undefined) {
				latencies.push(Math.max(0, timestampMs - sendTime));
			}
		},

		finalize(): TickerScenarioResult {
			// Overload accounting: offered total is fixed open-loop
			const completeness =
				expectedOfferedBroadcasts > 0
					? deliveredBroadcasts / expectedOfferedBroadcasts
					: 0;

			const deliveredBytes = deliveredBroadcasts * opts.recordBytes;
			const validLatencies = latencies.length > 0 ? latencies : [0];
			const summary = sampleSummary(validLatencies);

			return {
				runId: opts.runId,
				offeredRecords: expectedOfferedRecords,
				offeredBroadcasts: expectedOfferedBroadcasts,
				deliveredBroadcasts,
				deliveredBytes,
				completeness,
				latenciesMs: latencies,
				summary,
			};
		},
	};
}
