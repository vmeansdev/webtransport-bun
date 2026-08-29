import { describe, expect, it } from "bun:test";

import {
	bindInProcessServerSnapshotSource,
	sidecarServerSnapshotSource,
} from "./server-snapshot-sidecar.ts";
import {
	encodeServerSnapshot,
	type ServerSnapshotRecord,
	SERVER_SNAPSHOT_SCHEMA,
} from "./server-snapshot-protocol.ts";
import type { ServerHandle, TransportClock } from "./adapters/transport.ts";

function makeServerHandle(busyMs: number, windowMs: number): ServerHandle {
	return {
		async acceptSession() {
			throw new Error("not used in this test");
		},
		async stop() {
			return;
		},
		snapshot() {
			return {
				loopUtilization: { busyMs, windowMs },
				serverLoopUtilization: { busyMs, windowMs },
			} as ReturnType<ServerHandle["snapshot"]>;
		},
	};
}

async function* chunksOf(
	payload: Uint8Array,
	chunkSize: number,
): AsyncIterable<Uint8Array> {
	for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
		yield payload.subarray(
			offset,
			Math.min(offset + chunkSize, payload.byteLength),
		);
	}
}

function sampleRecord(): ServerSnapshotRecord {
	return {
		schema: SERVER_SNAPSHOT_SCHEMA,
		campaignId: "camp-1",
		runId: "run-1",
		executionIndex: 1,
		transport: "ws",
		legId: "leg-1",
		sequence: 1,
		capturedAtMs: 1000,
		loopUtilization: { busyMs: 7, windowMs: 100 },
	};
}

describe("server-snapshot-sidecar: bindInProcessServerSnapshotSource", () => {
	it("returns a record whose serverLoopUtilization is the server handle's value", async () => {
		const handle = makeServerHandle(42, 200);
		const source = bindInProcessServerSnapshotSource(handle, {
			transport: "ws",
			campaignId: "c",
			runId: "r",
			executionIndex: 1,
			legId: "l",
			sequence: 1,
			clock: () => 0,
		});
		const record = await source.readSnapshot(Date.now() + 1000);
		expect(record.loopUtilization).toEqual({ busyMs: 42, windowMs: 200 });
		expect(record.campaignId).toBe("c");
		expect(record.runId).toBe("r");
		expect(record.legId).toBe("l");
	});

	it("is consumed exactly once", async () => {
		const handle = makeServerHandle(1, 10);
		const source = bindInProcessServerSnapshotSource(handle, {
			transport: "ws",
			campaignId: "c",
			runId: "r",
			executionIndex: 1,
			legId: "l",
			sequence: 1,
			clock: () => 0,
		});
		await source.readSnapshot(Date.now() + 1000);
		await expect(source.readSnapshot(Date.now() + 1000)).rejects.toThrow(
			/already consumed/,
		);
	});

	it("rejects when the read deadline has already expired", async () => {
		const handle = makeServerHandle(1, 10);
		const source = bindInProcessServerSnapshotSource(handle, {
			transport: "ws",
			campaignId: "c",
			runId: "r",
			executionIndex: 1,
			legId: "l",
			sequence: 1,
			clock: () => 1000,
		});
		await expect(source.readSnapshot(500)).rejects.toThrow(/deadline/);
	});

	it("rejects a non-finite deadline", async () => {
		const handle = makeServerHandle(1, 10);
		const source = bindInProcessServerSnapshotSource(handle, {
			transport: "ws",
			campaignId: "c",
			runId: "r",
			executionIndex: 1,
			legId: "l",
			sequence: 1,
			clock: () => 0,
		});
		await expect(source.readSnapshot(Number.POSITIVE_INFINITY)).rejects.toThrow(
			/finite/,
		);
	});
});

describe("server-snapshot-sidecar: sidecarServerSnapshotSource", () => {
	const fixedClock: TransportClock = {
		nowMs: () => 1_000_000,
		sleep: (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
	};
	const deadline = fixedClock.nowMs() + 1000;

	it("decodes a single-frame stream into a record", async () => {
		const frame = encodeServerSnapshot(sampleRecord());
		const source = sidecarServerSnapshotSource(
			chunksOf(frame, frame.byteLength),
			fixedClock,
		);
		const record = await source.readSnapshot(deadline);
		expect(record).toEqual(sampleRecord());
	});

	it("reassembles a frame delivered as small chunks", async () => {
		const frame = encodeServerSnapshot(sampleRecord());
		const source = sidecarServerSnapshotSource(chunksOf(frame, 1), fixedClock);
		const record = await source.readSnapshot(deadline);
		expect(record).toEqual(sampleRecord());
	});

	it("is consumed exactly once", async () => {
		const frame = encodeServerSnapshot(sampleRecord());
		const source = sidecarServerSnapshotSource(
			chunksOf(frame, frame.byteLength),
			fixedClock,
		);
		await source.readSnapshot(deadline);
		await expect(source.readSnapshot(deadline)).rejects.toThrow(
			/already consumed/,
		);
	});

	it("rejects a stream that closes mid-frame", async () => {
		async function* truncated(): AsyncIterable<Uint8Array> {
			// Yield only the length prefix (4 bytes), then EOF.
			yield new Uint8Array([0, 0, 0, 10]);
		}
		const source = sidecarServerSnapshotSource(truncated(), fixedClock);
		await expect(source.readSnapshot(deadline)).rejects.toThrow(/mid-frame/);
	});

	it("rejects a non-Uint8Array chunk", async () => {
		async function* bad(): AsyncIterable<Uint8Array> {
			// The first chunk is the length prefix; the second
			// chunk is a non-Uint8Array, which the protocol
			// refuses.
			yield new Uint8Array([0, 0, 0, 5]);
			// The cast is a lie the test makes to assert the
			// runtime rejects it; in practice the iterable's
			// type is `AsyncIterable<Uint8Array>` and any
			// non-Uint8Array is a type-and-runtime violation.
			yield "not-bytes" as unknown as Uint8Array;
		}
		const source = sidecarServerSnapshotSource(bad(), fixedClock);
		await expect(source.readSnapshot(deadline)).rejects.toThrow(
			/non-Uint8Array/,
		);
	});
});
