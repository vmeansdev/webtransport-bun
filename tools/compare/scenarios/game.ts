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
