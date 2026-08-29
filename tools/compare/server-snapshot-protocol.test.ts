import { describe, expect, it } from "bun:test";

import {
	decodeServerSnapshot,
	encodeServerSnapshot,
	readServerSnapshotFrame,
	SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES,
	SERVER_SNAPSHOT_SCHEMA,
	type ServerSnapshotRecord,
} from "./server-snapshot-protocol.ts";

function sample(
	overrides: Partial<ServerSnapshotRecord> = {},
): ServerSnapshotRecord {
	return {
		schema: SERVER_SNAPSHOT_SCHEMA,
		campaignId: "camp-1",
		runId: "run-1",
		executionIndex: 1,
		transport: "ws",
		legId: "leg-1",
		sequence: 1,
		capturedAtMs: 1000,
		loopUtilization: { busyMs: 12, windowMs: 100 },
		...overrides,
	};
}

describe("server-snapshot-protocol: encodeServerSnapshot", () => {
	it("round-trips a record through encode/decode", () => {
		const record = sample();
		const frame = encodeServerSnapshot(record);
		const decoded = decodeServerSnapshot(frame);
		expect(decoded).toEqual(record);
	});

	it("writes a 4-byte big-endian length prefix before the payload", () => {
		const frame = encodeServerSnapshot(sample());
		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		const declaredLength = view.getUint32(0, false);
		expect(declaredLength).toBe(frame.byteLength - 4);
		expect(declaredLength).toBeGreaterThan(0);
	});

	it("preserves the schema field across the wire", () => {
		const decoded = decodeServerSnapshot(encodeServerSnapshot(sample()));
		expect(decoded.schema).toBe("server-loop-utilization/v1");
	});

	it("rejects an oversized payload at encode time", () => {
		// A record with a very large `legId` (4096 chars) pushes
		// the canonical JSON past the hard cap.
		const huge = sample({
			legId: "x".repeat(SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES),
		});
		expect(() => encodeServerSnapshot(huge)).toThrow(/exceeds hard cap/);
	});

	it("emits deterministic bytes for the same record (canonical key order)", () => {
		const record = sample();
		const a = encodeServerSnapshot(record);
		const b = encodeServerSnapshot(record);
		expect(a).toEqual(b);
	});
});

describe("server-snapshot-protocol: decodeServerSnapshot", () => {
	it("rejects a frame whose declared length exceeds the hard cap", () => {
		const head = new Uint8Array(4);
		new DataView(head.buffer).setUint32(
			0,
			SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES + 1,
			false,
		);
		expect(() => decodeServerSnapshot(head)).toThrow(/exceeds hard cap/);
	});

	it("rejects a frame whose actual byte count disagrees with the declared length", () => {
		const head = new Uint8Array(4);
		new DataView(head.buffer).setUint32(0, 100, false);
		expect(() => decodeServerSnapshot(head)).toThrow(/expected/);
	});

	it("rejects a frame shorter than the length prefix", () => {
		expect(() => decodeServerSnapshot(new Uint8Array(3))).toThrow(
			/less than the 4-byte length prefix/,
		);
	});

	it("rejects a payload with the wrong schema field", () => {
		const wrongSchema = sample({
			schema: "server-loop-utilization/v0" as typeof SERVER_SNAPSHOT_SCHEMA,
		});
		const frame = encodeServerSnapshot(wrongSchema);
		expect(() => decodeServerSnapshot(frame)).toThrow(
			/not a valid ServerSnapshotRecord/,
		);
	});

	it("rejects a payload whose transport is neither 'ws' nor 'wt'", () => {
		const wrong = sample({ transport: "tcp" as "ws" });
		const frame = encodeServerSnapshot(wrong);
		expect(() => decodeServerSnapshot(frame)).toThrow(
			/not a valid ServerSnapshotRecord/,
		);
	});

	it("rejects a payload with a non-positive windowMs", () => {
		const wrong = sample({ loopUtilization: { busyMs: 0, windowMs: 0 } });
		const frame = encodeServerSnapshot(wrong);
		expect(() => decodeServerSnapshot(frame)).toThrow(
			/not a valid ServerSnapshotRecord/,
		);
	});

	it("rejects a payload with a negative busyMs", () => {
		const wrong = sample({ loopUtilization: { busyMs: -1, windowMs: 100 } });
		const frame = encodeServerSnapshot(wrong);
		expect(() => decodeServerSnapshot(frame)).toThrow(
			/not a valid ServerSnapshotRecord/,
		);
	});

	it("rejects a record with a non-finite executionIndex at encode time", () => {
		const wrong = sample({ executionIndex: Number.POSITIVE_INFINITY });
		expect(() => encodeServerSnapshot(wrong)).toThrow(/finite/);
	});
});

describe("server-snapshot-protocol: readServerSnapshotFrame", () => {
	it("resolves with the decoded record on a complete frame", async () => {
		const frame = encodeServerSnapshot(sample());
		const record = await readServerSnapshotFrame(
			async () => frame,
			Date.now() + 1000,
			() => Date.now(),
		);
		expect(record).toEqual(sample());
	});

	it("rejects when the stream closes (returns null) before any frame arrives", async () => {
		await expect(
			readServerSnapshotFrame(
				async () => null,
				Date.now() + 1000,
				() => Date.now(),
			),
		).rejects.toThrow(/stream closed/);
	});

	it("rejects when the read deadline has already expired", async () => {
		await expect(
			readServerSnapshotFrame(
				async () => new Uint8Array(),
				Date.now() - 1,
				() => Date.now(),
			),
		).rejects.toThrow(/deadline/);
	});

	it("rejects when the read deadline is exceeded mid-wait", async () => {
		const start = Date.now();
		await expect(
			readServerSnapshotFrame(
				async () => {
					await Bun.sleep(50);
					return encodeServerSnapshot(sample());
				},
				start + 10,
				() => Date.now(),
			),
		).rejects.toThrow(/deadline/);
	});

	it("rejects when the supplied deadline is non-finite", async () => {
		await expect(
			readServerSnapshotFrame(
				async () => new Uint8Array(),
				Number.POSITIVE_INFINITY,
				() => Date.now(),
			),
		).rejects.toThrow(/finite/);
	});
});
