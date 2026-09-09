/**
 * Task 7: Chat Fanout Scenario.
 *
 * Workload:
 * - 10 publisher connections, 1,000 / 5,000 / 10,000 subscriber connections.
 * - Each publisher emits one 128-byte reliable message / second for 30 seconds.
 * - Server broadcasts every published message to all active subscribers.
 * - Delivery is "reliable" (virtual channel on WS, reliable stream on WT).
 * - Per-receiver ledgers track delivery, duplicates, reordering, and publish-to-receive latency.
 */

import { type SampleSummary, sampleSummary } from "../stats.ts";

export interface ChatLedgerOptions {
	readonly runId: string;
	readonly publisherCount: number;
	readonly subscriberCount: number;
	readonly messageBytes: number;
	readonly durationSeconds: number;
	readonly messagesPerSecondPerPublisher: number;
}

export interface ChatScenarioResult {
	readonly runId: string;
	readonly offeredPublishMessages: number;
	readonly offeredDeliveredTotal: number;
	readonly deliveredTotal: number;
	readonly duplicateCount: number;
	readonly reorderedCount: number;
	readonly deliveryRatio: number;
	readonly latenciesMs: readonly number[];
	readonly summary: SampleSummary;
	readonly subscriberCounts: Readonly<Record<string, number>>;
}

export interface ChatLedger {
	readonly expectedOfferedPublish: number;
	readonly expectedOfferedDelivered: number;
	recordOffered(
		publisherId: string,
		sequence: number,
		timestampMs: number,
	): void;
	recordAccepted(
		publisherId: string,
		sequence: number,
		timestampMs: number,
	): void;
	recordServerObserved(
		publisherId: string,
		sequence: number,
		timestampMs: number,
	): void;
	recordDelivered(
		subscriberId: string,
		publisherId: string,
		sequence: number,
		timestampMs: number,
	): void;
	finalize(): ChatScenarioResult;
}

export function createChatLedger(opts: ChatLedgerOptions): ChatLedger {
	const expectedOfferedPublish =
		opts.publisherCount *
		opts.messagesPerSecondPerPublisher *
		opts.durationSeconds;
	const expectedOfferedDelivered =
		expectedOfferedPublish * opts.subscriberCount;

	const offeredMap = new Map<string, number>(); // "pubId:seq" -> offeredTime
	const subscriberReceived = new Map<string, Map<string, number[]>>(); // subId -> (pubId -> seqs[])
	const subscriberCounts = new Map<string, number>();
	const latencies: number[] = [];
	let duplicateCount = 0;
	let reorderedCount = 0;
	let deliveredTotal = 0;
	let offeredPublishCount = 0;

	return {
		expectedOfferedPublish,
		expectedOfferedDelivered,

		recordOffered(publisherId: string, sequence: number, timestampMs: number) {
			const key = `${publisherId}:${sequence}`;
			if (!offeredMap.has(key)) {
				offeredPublishCount++;
				offeredMap.set(key, timestampMs);
			}
		},

		recordAccepted(
			_publisherId: string,
			_sequence: number,
			_timestampMs: number,
		) {
			// Tracked for transport admission corroboration
		},

		recordServerObserved(
			_publisherId: string,
			_sequence: number,
			_timestampMs: number,
		) {
			// Tracked for server observation
		},

		recordDelivered(
			subscriberId: string,
			publisherId: string,
			sequence: number,
			timestampMs: number,
		) {
			let pubMap = subscriberReceived.get(subscriberId);
			if (!pubMap) {
				pubMap = new Map();
				subscriberReceived.set(subscriberId, pubMap);
			}

			let seqList = pubMap.get(publisherId);
			if (!seqList) {
				seqList = [];
				pubMap.set(publisherId, seqList);
			}

			// Check duplicate
			if (seqList.includes(sequence)) {
				duplicateCount++;
				return;
			}

			// Check reordered: if previous sequence in seqList is higher than current
			if (seqList.length > 0) {
				const lastSeq = seqList[seqList.length - 1]!;
				if (sequence < lastSeq) {
					reorderedCount++;
				}
			}

			seqList.push(sequence);
			deliveredTotal++;

			const count = (subscriberCounts.get(subscriberId) ?? 0) + 1;
			subscriberCounts.set(subscriberId, count);

			const key = `${publisherId}:${sequence}`;
			const sendTime = offeredMap.get(key);
			if (sendTime !== undefined) {
				latencies.push(Math.max(0, timestampMs - sendTime));
			}
		},

		finalize(): ChatScenarioResult {
			const totalOfferedBroadcast = offeredPublishCount * opts.subscriberCount;
			const ratio =
				totalOfferedBroadcast > 0 ? deliveredTotal / totalOfferedBroadcast : 0;

			const validLatencies = latencies.length > 0 ? latencies : [0];
			const summary = sampleSummary(validLatencies);

			const subCountsObj: Record<string, number> = {};
			for (const [k, v] of subscriberCounts.entries()) {
				subCountsObj[k] = v;
			}

			return {
				runId: opts.runId,
				offeredPublishMessages: offeredPublishCount,
				offeredDeliveredTotal: totalOfferedBroadcast,
				deliveredTotal,
				duplicateCount,
				reorderedCount,
				deliveryRatio: ratio,
				latenciesMs: latencies,
				summary,
				subscriberCounts: Object.freeze(subCountsObj),
			};
		},
	};
}
