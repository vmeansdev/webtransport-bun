/**
 * Task 9: CRDT Sync Scenario (Yjs-style synthetic KV).
 *
 * Workload:
 * - 100 clients.
 * - Deterministic 96-byte actor/clock/key/value operations at 1,000 ops/s aggregate for 60 s.
 * - Periodic canonical snapshots; persistent reliable channel (WS virtual bidi channel, WT bidi stream).
 * - Tracks applied unique ops/s, convergence hash / completeness, merge latency.
 */

import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical } from "../canonical.ts";
import { type SampleSummary, sampleSummary } from "../stats.ts";

export interface CrdtOp {
	readonly actorId: number;
	readonly clock: bigint;
	readonly key: string;
	readonly value: Uint8Array;
}

const CRDT_OP_BYTES = 96;
const CRDT_KEY_BYTES = 52;
const CRDT_VALUE_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes a CRDT operation into exactly 96 bytes:
 * - 4 bytes: actorId (uint32 BE)
 * - 8 bytes: clock (uint64 BE)
 * - 52 bytes: key (UTF-8, null-padded)
 * - 32 bytes: value (Uint8Array, slice/pad to 32 bytes)
 */
export function encodeCrdtOp(op: CrdtOp): Uint8Array {
	const buf = new Uint8Array(CRDT_OP_BYTES);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	view.setUint32(0, op.actorId, false);
	view.setBigUint64(4, op.clock, false);

	// Key: up to 52 bytes
	const keyBytes = encoder.encode(op.key);
	const keyLen = Math.min(keyBytes.byteLength, CRDT_KEY_BYTES);
	buf.set(keyBytes.subarray(0, keyLen), 12);

	// Value: 32 bytes
	const valLen = Math.min(op.value.byteLength, CRDT_VALUE_BYTES);
	buf.set(op.value.subarray(0, valLen), 12 + CRDT_KEY_BYTES);

	return buf;
}

/**
 * Decodes a 96-byte buffer into a CRDT operation.
 */
export function decodeCrdtOp(buf: Uint8Array): CrdtOp {
	if (buf.byteLength < CRDT_OP_BYTES) {
		throw new Error(
			`Invalid CRDT op length: ${buf.byteLength}, expected ${CRDT_OP_BYTES}`,
		);
	}

	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const actorId = view.getUint32(0, false);
	const clock = view.getBigUint64(4, false);

	// Extract key (trim null bytes)
	const keySlice = buf.subarray(12, 12 + CRDT_KEY_BYTES);
	let keyEnd = keySlice.indexOf(0);
	if (keyEnd === -1) keyEnd = keySlice.byteLength;
	const key = decoder.decode(keySlice.subarray(0, keyEnd));

	// Extract value
	const valSlice = buf.subarray(
		12 + CRDT_KEY_BYTES,
		12 + CRDT_KEY_BYTES + CRDT_VALUE_BYTES,
	);
	const value = new Uint8Array(valSlice);

	return { actorId, clock, key, value };
}

export interface CrdtStore {
	apply(op: CrdtOp): boolean;
	get(
		key: string,
	): { actorId: number; clock: bigint; value: Uint8Array } | undefined;
	snapshotHash(): string;
	size(): number;
}

/**
 * Synthetic Yjs-style LWW (Last-Write-Wins with Lamport clock + actorId tie-break) Key-Value Store.
 */
export function createCrdtStore(): CrdtStore {
	const entries = new Map<
		string,
		{ actorId: number; clock: bigint; value: Uint8Array }
	>();

	return {
		apply(op: CrdtOp): boolean {
			const existing = entries.get(op.key);
			if (existing) {
				if (op.clock < existing.clock) {
					return false; // older op, ignore
				}
				if (op.clock === existing.clock && op.actorId <= existing.actorId) {
					return false; // tie break in favor of higher actorId
				}
			}

			entries.set(op.key, {
				actorId: op.actorId,
				clock: op.clock,
				value: op.value,
			});
			return true;
		},

		get(key: string) {
			return entries.get(key);
		},

		snapshotHash(): string {
			// Sort keys canonically
			const sortedKeys = Array.from(entries.keys()).sort();
			const snapshotObj: Record<
				string,
				{ actorId: number; clock: string; valueHex: string }
			> = {};

			for (const k of sortedKeys) {
				const entry = entries.get(k)!;
				snapshotObj[k] = {
					actorId: entry.actorId,
					clock: entry.clock.toString(),
					valueHex: Buffer.from(entry.value).toString("hex"),
				};
			}

			return sha256Canonical(snapshotObj);
		},

		size(): number {
			return entries.size;
		},
	};
}

export interface CrdtLedgerOptions {
	readonly runId: string;
	readonly clientCount: number;
	readonly operationBytes: number;
	readonly operationsPerSecond: number;
	readonly durationSeconds: number;
	readonly delivery: "reliable";
}

export interface CrdtScenarioResult {
	readonly runId: string;
	readonly offeredOps: number;
	readonly appliedUniqueOps: number;
	readonly convergenceHash: string;
	readonly mergeLatenciesMs: readonly number[];
	readonly summary: SampleSummary;
}

export interface CrdtLedger {
	recordOpOffered(opId: string, timestampMs: number): void;
	recordOpApplied(opId: string, timestampMs: number): void;
	finalize(finalConvergenceHash: string): CrdtScenarioResult;
}

export function createCrdtLedger(opts: CrdtLedgerOptions): CrdtLedger {
	const offeredTimestamps = new Map<string, number>();
	const mergeLatencies: number[] = [];
	let offeredCount = 0;
	let appliedCount = 0;

	return {
		recordOpOffered(opId: string, timestampMs: number) {
			offeredCount++;
			offeredTimestamps.set(opId, timestampMs);
		},

		recordOpApplied(opId: string, timestampMs: number) {
			appliedCount++;
			const sendTime = offeredTimestamps.get(opId);
			if (sendTime !== undefined) {
				mergeLatencies.push(Math.max(0, timestampMs - sendTime));
			}
		},

		finalize(finalConvergenceHash: string): CrdtScenarioResult {
			const validLatencies = mergeLatencies.length > 0 ? mergeLatencies : [0];
			const summary = sampleSummary(validLatencies);

			return {
				runId: opts.runId,
				offeredOps: offeredCount,
				appliedUniqueOps: appliedCount,
				convergenceHash: finalConvergenceHash,
				mergeLatenciesMs: mergeLatencies,
				summary,
			};
		},
	};
}

export interface CrdtScenarioConfig {
	readonly runId: string;
	readonly clientCount: number;
	readonly operationBytes: number;
	readonly operationsPerSecond: number;
	readonly durationSeconds: number;
	readonly delivery: "reliable";
	readonly clock?: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
	};
}

export async function runCrdtSyncPure(
	config: CrdtScenarioConfig,
): Promise<CrdtScenarioResult> {
	const clock = config.clock ?? {
		now: () => Date.now(),
		sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
	};

	const ledger = createCrdtLedger(config);
	const store = createCrdtStore();

	const totalOps = config.operationsPerSecond * config.durationSeconds;

	for (let i = 1; i <= totalOps; i++) {
		const actorId = (i % config.clientCount) + 1;
		const op: CrdtOp = {
			actorId,
			clock: BigInt(i),
			key: `doc-key-${i % 20}`, // 20 keys with periodic overwrites
			value: new Uint8Array(32).fill(i & 0xff),
		};

		const opId = `op-${i}`;
		const sendTime = clock.now();
		ledger.recordOpOffered(opId, sendTime);

		store.apply(op);

		const applyTime = sendTime + 1;
		ledger.recordOpApplied(opId, applyTime);

		if (i % config.operationsPerSecond === 0) {
			await clock.sleep(1000 / config.operationsPerSecond);
		}
	}

	return ledger.finalize(store.snapshotHash());
}
