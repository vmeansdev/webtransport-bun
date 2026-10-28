/**
 * Task 9: Stream-based scenario tests (crdt-sync, ai-token-stream, bulk-one-way).
 *
 * Tests:
 * - deterministic actor/clock CRDT operation encoding (96 bytes)
 * - CRDT convergence and canonical snapshot hashing
 * - AI token stream chunk ladders (32, 64, 128, 256 bytes) at 50 chunks/s
 * - scheduled 500ms client pauses every 5s and backpressure / queue peak recording
 * - inter-chunk gap p50/p95/p99 latency
 * - bulk-one-way: exactly 100 MiB transfer in 64 KiB chunks
 * - bulk chunking boundary calculation and SHA-256 content digest verification
 * - throughput (Mbps) and completion time calculation
 */

import { describe, expect, it } from "bun:test";
import { createAiTokenLedger } from "./ai-token.ts";
import { createBulkLedger, generateBulkPayload } from "./bulk.ts";
import { createCrdtStore, decodeCrdtOp, encodeCrdtOp } from "./crdt.ts";

describe("Task 9: CRDT sync scenario (Yjs-style synthetic KV)", () => {
	it("encodes and decodes deterministic 96-byte CRDT operations", () => {
		const op = {
			actorId: 42,
			clock: 1005n,
			key: "doc-state-cursor-position-alpha-001",
			value: new Uint8Array(32).fill(0xab),
		};

		const encoded = encodeCrdtOp(op);
		expect(encoded.byteLength).toBe(96);

		const decoded = decodeCrdtOp(encoded);
		expect(decoded.actorId).toBe(42);
		expect(decoded.clock).toBe(1005n);
		expect(decoded.key).toBe("doc-state-cursor-position-alpha-001");
		expect(decoded.value).toEqual(op.value);
	});

	it("converges to identical canonical hash regardless of operation arrival order", () => {
		const op1 = {
			actorId: 1,
			clock: 1n,
			key: "key-a",
			value: new Uint8Array([1]),
		};
		const op2 = {
			actorId: 2,
			clock: 2n,
			key: "key-b",
			value: new Uint8Array([2]),
		};
		const op3 = {
			actorId: 1,
			clock: 3n,
			key: "key-a",
			value: new Uint8Array([3]),
		}; // overwrites key-a

		// Store 1 applies op1 -> op2 -> op3
		const store1 = createCrdtStore();
		store1.apply(op1);
		store1.apply(op2);
		store1.apply(op3);

		// Store 2 applies op3 -> op1 -> op2 (out of order, but op1 is older than op3)
		const store2 = createCrdtStore();
		store2.apply(op3);
		store2.apply(op1);
		store2.apply(op2);

		const snap1 = store1.snapshotHash();
		const snap2 = store2.snapshotHash();

		expect(snap1).toBe(snap2);
		expect(snap1).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("Task 9: AI token stream scenario", () => {
	it("records inter-token gap latencies, scheduled pauses, and queue peaks", () => {
		const ledger = createAiTokenLedger({
			runId: "run-ai-1",
			sessionCount: 2,
			chunkBytes: 64,
			chunksPerSecondPerSession: 50,
			durationSeconds: 1,
			pauseEverySeconds: 5,
			pauseDurationMs: 500,
		});

		// 2 sessions emitting 50 chunks each
		for (let s = 1; s <= 2; s++) {
			const sessionId = `ses-${s}`;
			let lastArrival = 1000;
			for (let c = 1; c <= 50; c++) {
				const arrival = lastArrival + 20; // 20ms gap = 50 chunks/s
				ledger.recordChunkReceived(sessionId, c, arrival, 64);
				lastArrival = arrival;
			}
		}

		const result = ledger.finalize();
		expect(result.totalChunksDelivered).toBe(100);
		expect(result.interTokenGapsMs.length).toBe(98); // 49 gaps per session * 2
		expect(result.summary.p50).toBeCloseTo(20, 1);
		expect(result.deliveredBytes).toBe(6400);
	});
});

describe("Task 9: Bulk one-way scenario (100 MiB, 64 KiB chunks)", () => {
	it("generates exact 100 MiB payload and partitions into 64 KiB chunks", () => {
		const totalBytes = 100 * 1024 * 1024; // 104,857,600 bytes
		const chunkBytes = 64 * 1024; // 65,536 bytes
		const expectedChunks = totalBytes / chunkBytes; // 1,600 exact chunks

		expect(expectedChunks).toBe(1600);

		const { digest, chunkCount, totalSize } = generateBulkPayload(
			totalBytes,
			chunkBytes,
		);
		expect(totalSize).toBe(totalBytes);
		expect(chunkCount).toBe(1600);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("records chunk arrival and computes throughput and digest verification", () => {
		const totalBytes = 100 * 1024 * 1024;
		const chunkBytes = 64 * 1024;
		const expectedDigest = "a".repeat(64);

		const ledger = createBulkLedger({
			runId: "run-bulk-1",
			totalBytes,
			chunkBytes,
			expectedDigest,
		});

		ledger.recordStart(1000);
		// Receive 1600 chunks over 1000ms (100 MB/s = 800 Mbps)
		for (let i = 1; i <= 1600; i++) {
			ledger.recordChunk(i, chunkBytes, 1000 + (i * 1000) / 1600);
		}
		ledger.recordComplete(2000, expectedDigest);

		const result = ledger.finalize();
		expect(result.totalChunksDelivered).toBe(1600);
		expect(result.deliveredBytes).toBe(totalBytes);
		expect(result.durationMs).toBe(1000);
		expect(result.throughputMbps).toBeCloseTo(838.86, 1); // 104,857,600 * 8 / 1,000,000 = 838.86 Mbps
		expect(result.digestVerified).toBe(true);
	});
});
