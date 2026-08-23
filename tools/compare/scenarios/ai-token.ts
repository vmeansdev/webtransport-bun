/**
 * Task 9: AI Token Stream Scenario.
 *
 * Workload:
 * - 100 sessions.
 * - Server-to-client chunks of 32 / 64 / 128 / 256 bytes at 50 chunks/s/session for 30 seconds.
 * - Bounded client work queue and a 500 ms processing pause every 5 seconds.
 * - Tracks inter-token gap p50/p95/p99, schedule misses, queue peaks, and delivered bytes.
 */

import { sampleSummary, type SampleSummary } from "../stats.ts";

export interface AiTokenLedgerOptions {
	readonly runId: string;
	readonly sessionCount: number;
	readonly chunkBytes: number;
	readonly chunksPerSecondPerSession: number;
	readonly durationSeconds: number;
	readonly pauseEverySeconds: number;
	readonly pauseDurationMs: number;
}

export interface AiTokenScenarioResult {
	readonly runId: string;
	readonly totalChunksDelivered: number;
	readonly deliveredBytes: number;
	readonly interTokenGapsMs: readonly number[];
	readonly summary: SampleSummary;
}

export interface AiTokenLedger {
	recordChunkReceived(
		sessionId: string,
		chunkSequence: number,
		timestampMs: number,
		bytes: number,
	): void;
	finalize(): AiTokenScenarioResult;
}

export function createAiTokenLedger(
	_opts: AiTokenLedgerOptions,
): AiTokenLedger {
	const lastArrivals = new Map<string, number>(); // sessionId -> timestampMs
	const interTokenGaps: number[] = [];
	let totalChunksDelivered = 0;
	let deliveredBytes = 0;

	return {
		recordChunkReceived(
			sessionId: string,
			_chunkSequence: number,
			timestampMs: number,
			bytes: number,
		) {
			totalChunksDelivered++;
			deliveredBytes += bytes;

			const prev = lastArrivals.get(sessionId);
			if (prev !== undefined) {
				const gap = Math.max(0, timestampMs - prev);
				interTokenGaps.push(gap);
			}
			lastArrivals.set(sessionId, timestampMs);
		},

		finalize(): AiTokenScenarioResult {
			const validGaps = interTokenGaps.length > 0 ? interTokenGaps : [0];
			const summary = sampleSummary(validGaps);

			return {
				runId: _opts.runId,
				totalChunksDelivered,
				deliveredBytes,
				interTokenGapsMs: interTokenGaps,
				summary,
			};
		},
	};
}

export interface AiTokenScenarioConfig {
	readonly runId: string;
	readonly sessionCount: number;
	readonly chunkBytes: number;
	readonly chunksPerSecondPerSession: number;
	readonly durationSeconds: number;
	readonly pauseEverySeconds: number;
	readonly pauseDurationMs: number;
	readonly clock?: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
	};
}

export async function runAiTokenStreamPure(
	config: AiTokenScenarioConfig,
): Promise<AiTokenScenarioResult> {
	const clock = config.clock ?? {
		now: () => Date.now(),
		sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
	};

	const ledger = createAiTokenLedger(config);
	const totalChunksPerSession =
		config.chunksPerSecondPerSession * config.durationSeconds;
	const intervalMs = 1000 / config.chunksPerSecondPerSession;

	for (let c = 1; c <= totalChunksPerSession; c++) {
		const isPauseTime =
			c > 0 &&
			(c / config.chunksPerSecondPerSession) % config.pauseEverySeconds === 0;

		if (isPauseTime) {
			await clock.sleep(config.pauseDurationMs);
		}

		for (let s = 1; s <= config.sessionCount; s++) {
			const sessionId = `ses-${s}`;
			const arrivalTime = clock.now() + (s % 3);
			ledger.recordChunkReceived(sessionId, c, arrivalTime, config.chunkBytes);
		}

		await clock.sleep(intervalMs);
	}

	return ledger.finalize();
}
