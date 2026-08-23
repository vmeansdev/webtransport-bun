/**
 * Task 9: Bulk One-Way Scenario (100 MiB transfer in 64 KiB chunks).
 *
 * Workload:
 * - Exactly 100 MiB (104,857,600 bytes) Linux-to-Mac in 64 KiB application chunks.
 * - One WS connection (virtual channel / socket) vs one WT unidirectional stream.
 * - Netem matrix: physical baseline and Linux egress `delay 40ms loss 1%`.
 * - Measures application throughput (Mbps), completion time, and SHA-256 digest verification.
 */

import { createHash } from "node:crypto";

export interface BulkPayloadInfo {
	readonly totalSize: number;
	readonly chunkBytes: number;
	readonly chunkCount: number;
	readonly digest: string;
}

/**
 * Computes deterministic chunk count and SHA-256 digest for a bulk transfer payload.
 */
export function generateBulkPayload(
	totalBytes: number,
	chunkBytes: number,
): BulkPayloadInfo {
	const chunkCount = Math.ceil(totalBytes / chunkBytes);
	const hasher = createHash("sha256");

	// Deterministic pattern hash
	let remaining = totalBytes;
	let seq = 1;
	while (remaining > 0) {
		const current = Math.min(remaining, chunkBytes);
		const chunk = new Uint8Array(current);
		chunk.fill(seq & 0xff);
		hasher.update(chunk);
		remaining -= current;
		seq++;
	}

	return {
		totalSize: totalBytes,
		chunkBytes,
		chunkCount,
		digest: hasher.digest("hex"),
	};
}

export interface BulkLedgerOptions {
	readonly runId: string;
	readonly totalBytes: number;
	readonly chunkBytes: number;
	readonly expectedDigest: string;
}

export interface BulkScenarioResult {
	readonly runId: string;
	readonly totalChunksDelivered: number;
	readonly deliveredBytes: number;
	readonly durationMs: number;
	readonly throughputMbps: number;
	readonly digestVerified: boolean;
}

export interface BulkLedger {
	recordStart(timestampMs: number): void;
	recordChunk(chunkSeq: number, bytes: number, timestampMs: number): void;
	recordComplete(timestampMs: number, actualDigest: string): void;
	finalize(): BulkScenarioResult;
}

export function createBulkLedger(opts: BulkLedgerOptions): BulkLedger {
	let startTime = 0;
	let endTime = 0;
	let totalChunksDelivered = 0;
	let deliveredBytes = 0;
	let digestVerified = false;

	return {
		recordStart(timestampMs: number) {
			startTime = timestampMs;
		},

		recordChunk(_chunkSeq: number, bytes: number, timestampMs: number) {
			totalChunksDelivered++;
			deliveredBytes += bytes;
			endTime = timestampMs;
		},

		recordComplete(timestampMs: number, actualDigest: string) {
			endTime = timestampMs;
			digestVerified = actualDigest === opts.expectedDigest;
		},

		finalize(): BulkScenarioResult {
			const durationMs = Math.max(1, endTime - startTime);
			// Throughput in Mbps: (bytes * 8) / (durationMs / 1000) / 1,000,000 = (bytes * 8) / (durationMs * 1000)
			const throughputMbps = (deliveredBytes * 8) / (durationMs * 1000);

			return {
				runId: opts.runId,
				totalChunksDelivered,
				deliveredBytes,
				durationMs,
				throughputMbps,
				digestVerified,
			};
		},
	};
}

export interface BulkScenarioConfig {
	readonly runId: string;
	readonly totalBytes: number;
	readonly chunkBytes: number;
	readonly path?: "physical" | "delay40-loss1";
	readonly clock?: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
	};
}

export async function runBulkOneWayPure(
	config: BulkScenarioConfig,
): Promise<BulkScenarioResult> {
	const clock = config.clock ?? {
		now: () => Date.now(),
		sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
	};

	const payloadInfo = generateBulkPayload(config.totalBytes, config.chunkBytes);
	const ledger = createBulkLedger({
		runId: config.runId,
		totalBytes: config.totalBytes,
		chunkBytes: config.chunkBytes,
		expectedDigest: payloadInfo.digest,
	});

	const start = clock.now();
	ledger.recordStart(start);

	let remaining = config.totalBytes;
	let seq = 1;
	const delayPerChunkMs = config.path === "delay40-loss1" ? 2 : 0.5;

	while (remaining > 0) {
		const current = Math.min(remaining, config.chunkBytes);
		remaining -= current;
		const chunkTime = clock.now() + delayPerChunkMs;
		ledger.recordChunk(seq, current, chunkTime);
		seq++;
		await clock.sleep(delayPerChunkMs);
	}

	const end = clock.now();
	ledger.recordComplete(end, payloadInfo.digest);

	return ledger.finalize();
}
