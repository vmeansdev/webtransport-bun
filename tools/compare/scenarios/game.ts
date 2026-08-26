/**
 * Task 7: Game Tick Loss Scenario (Latest-State, Lossy Overlay, WT Datagrams).
 *
 * Workload:
 * - 1 publisher, 100 receivers.
 * - 64-byte latest-state ticks at 20 / 60 Hz for 30 seconds.
 * - Netem matrix: 1 / 2.5 / 5% loss x 20 / 40 ms delay.
 * - Arms: raw WS (reliable, in-order TCP HOL), ws-overlay (drops expired/stale at receiver), WT datagrams (native unreliable).
 * - Tracks latest-state age (receiveTime - sendTime), stale, expired, and unique delivered counts.
 */

import { type SampleSummary, sampleSummary } from "../stats.ts";

export interface GameLedgerOptions {
	readonly runId: string;
	readonly tickHz: number;
	readonly tickBytes: number;
	readonly durationSeconds: number;
	readonly receiverCount: number;
	readonly delivery: "latest-state";
	readonly lossyOverlay: boolean;
}

export interface GameScenarioResult {
	readonly runId: string;
	readonly offeredTicks: number;
	readonly receivedTicks: number;
	readonly staleTicks: number;
	readonly expiredTicks: number;
	readonly deliveryPercent: number;
	readonly agesMs: readonly number[];
	readonly summary: SampleSummary;
}

export interface GameLedger {
	readonly expectedOfferedTicks: number;
	recordOffered(
		sequence: number,
		scheduledAtMs: number,
		expiresAtMs: number,
	): void;
	recordReceived(
		receiverId: string,
		sequence: number,
		receivedAtMs: number,
		scheduledAtMs: number,
		expiresAtMs: number,
	): void;
	finalize(): GameScenarioResult;
}

export function createGameLedger(opts: GameLedgerOptions): GameLedger {
	const totalPublishedTicks = opts.tickHz * opts.durationSeconds;
	const expectedOfferedTicks = totalPublishedTicks * opts.receiverCount;

	const highestSeqPerReceiver = new Map<string, number>();
	const agesMs: number[] = [];
	let receivedTicks = 0;
	let staleTicks = 0;
	let expiredTicks = 0;

	return {
		expectedOfferedTicks,

		recordOffered(
			_sequence: number,
			_scheduledAtMs: number,
			_expiresAtMs: number,
		) {
			// Recorded as offered
		},

		recordReceived(
			receiverId: string,
			sequence: number,
			receivedAtMs: number,
			scheduledAtMs: number,
			expiresAtMs: number,
		) {
			const isExpired = receivedAtMs > expiresAtMs;
			if (isExpired) {
				expiredTicks++;
			}

			const highestSeq = highestSeqPerReceiver.get(receiverId) ?? 0;
			const isStale = sequence < highestSeq;
			if (isStale) {
				staleTicks++;
			} else {
				highestSeqPerReceiver.set(receiverId, sequence);
			}

			// ws-overlay drops expired or stale updates at receiver
			if (opts.lossyOverlay && (isExpired || isStale)) {
				return;
			}

			receivedTicks++;
			const age = Math.max(0, receivedAtMs - scheduledAtMs);
			agesMs.push(age);
		},

		finalize(): GameScenarioResult {
			const deliveryPercent =
				expectedOfferedTicks > 0
					? (receivedTicks / expectedOfferedTicks) * 100
					: 0;

			const validAges = agesMs.length > 0 ? agesMs : [0];
			const summary = sampleSummary(validAges);

			return {
				runId: opts.runId,
				offeredTicks: expectedOfferedTicks,
				receivedTicks,
				staleTicks,
				expiredTicks,
				deliveryPercent,
				agesMs,
				summary,
			};
		},
	};
}

export interface GameScenarioConfig {
	readonly runId: string;
	readonly tickHz: number;
	readonly tickBytes: number;
	readonly durationSeconds: number;
	readonly receiverCount: number;
	readonly lossPercent?: number;
	readonly delayMs?: number;
	readonly delivery: "latest-state";
	readonly lossyOverlay: boolean;
	readonly clock?: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
	};
}

/**
 * Pure-driver simulated game tick loss runner.
 */
export async function runGameTickLossPure(
	config: GameScenarioConfig,
): Promise<GameScenarioResult> {
	const clock = config.clock ?? {
		now: () => Date.now(),
		sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
	};

	const ledger = createGameLedger(config);
	const totalTicks = config.tickHz * config.durationSeconds;
	const tickIntervalMs = 1000 / config.tickHz;
	const delayMs = config.delayMs ?? 20;
	const lossRate = (config.lossPercent ?? 0) / 100;

	for (let t = 1; t <= totalTicks; t++) {
		const scheduledAt = clock.now();
		const expiresAt = scheduledAt + tickIntervalMs * 2;
		ledger.recordOffered(t, scheduledAt, expiresAt);

		// Distribute to receivers
		for (let r = 1; r <= config.receiverCount; r++) {
			if (lossRate > 0) {
				const dropStep = Math.round(1 / lossRate);
				if (dropStep > 0 && (t * config.receiverCount + r) % dropStep === 0) {
					continue; // packet loss on network
				}
			}
			const rcvTime = scheduledAt + delayMs + (r % 5);
			ledger.recordReceived(`rcv-${r}`, t, rcvTime, scheduledAt, expiresAt);
		}

		await clock.sleep(tickIntervalMs);
	}

	return ledger.finalize();
}
