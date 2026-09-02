import { describe, expect, it } from "bun:test";

import { canonicalRecordBytes } from "./secure-fs.ts";
import {
	decodeServerSnapshot,
	encodeServerSnapshot,
	isServerLoopUtilizationFrameV1,
	readServerSnapshotFrame,
	SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES,
	SERVER_SNAPSHOT_SCHEMA,
	type ServerLoopUtilizationFrameV1,
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

/**
 * `ServerLoopUtilizationFrameV1` is one codec with two implementations:
 * `isServerLoopUtilizationFrameV1` here and `SERVER_LOOP_UTILIZATION_FIELDS`
 * in `crates/native/src/secure_fs.rs`, which the rig runs `exact_fields`
 * against before it digests the frame the child sent. The two key sets agreed
 * by inspection and nothing enforced it, which is the shape of defect the
 * design's "a codec change with no conformance vector is not done" rule exists
 * to catch.
 *
 * These are the bytes. The Rust half pins the same literal in
 * `crates/native/tests/rig_cohort_runtime.rs` as
 * `TS_SERVER_LOOP_UTILIZATION_HEX` and asserts its own production constant
 * against them, so a key added, renamed or reordered on either side turns one
 * of the two suites red.
 *
 * The bytes are `canonicalRecordBytes` of the record -- canonical JSON plus one
 * LF -- because that is what `loopUtilizationSnapshot` (`scenarios/fanout-relay.ts`)
 * puts on the wire and what the rig parses and re-digests. It is *not* the
 * `encodeServerSnapshot` framing above, which carries the older
 * `ServerSnapshotRecord` on the controller sidecar.
 */
const TS_SERVER_LOOP_UTILIZATION_HEX =
	"7b22616c6c4d6561737572656453657373696f6e73436c6f736564223a747275652c22626173656c696e6541744c696e75784e73223a22313233343536373839303132343030222c22626173656c696e65427573794d73223a313233342c2262756c6b536f75726365436f6d706c6574696f6e223a6e756c6c2c22627573794d73223a343434342c2263656c6c4964223a2263656c6c2d6233352d77732d30303031222c226368696c64496e7374616e63654e6f6e6365223a2263336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333222c226368696c6450676964223a343234322c226368696c64506964223a343234322c22636f686f72744772616e74536861323536223a2236303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630222c22636f686f7274537461727442617272696572536861323536223a2262356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c2266696e616c427573794d73223a353637382c2266696e616c536e617073686f7441744c696e75784e73223a22313233343536373839303939393939222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c2272657065746974696f6e496e646578223a322c2272657065746974696f6e4b696e64223a226d65617375726564222c2272657065746974696f6e546f74616c223a352c22726f6c65546f6b656e436f6d6d69746d656e74526f6f74536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c227363656e6172696f48617368223a2261316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131222c22736368656d61223a227365727665722d6c6f6f702d7574696c697a6174696f6e2f7631222c227472616e73706f7274223a227773222c2277696e646f774d73223a38387d0a";

const LOOP_UTILIZATION_FIXTURE: ServerLoopUtilizationFrameV1 = {
	schema: "server-loop-utilization/v1",
	executionSha256: "e1".repeat(32),
	cellId: "cell-b35-ws-0001",
	scenarioHash: "a1".repeat(32),
	cohortGrantSha256: "60".repeat(32),
	cohortStartBarrierSha256: "b5".repeat(32),
	roleTokenCommitmentRootSha256: "77".repeat(32),
	transport: "ws",
	repetitionKind: "measured",
	repetitionIndex: 2,
	repetitionTotal: 5,
	childPid: 4242,
	childPgid: 4242,
	childInstanceNonce: "c3".repeat(32),
	baselineBusyMs: 1234,
	finalBusyMs: 5678,
	busyMs: 4444,
	baselineAtLinuxNs: "123456789012400",
	finalSnapshotAtLinuxNs: "123456789099999",
	windowMs: 88,
	linuxClockId: "CLOCK_MONOTONIC",
	allMeasuredSessionsClosed: true,
	bulkSourceCompletion: null,
};

describe("server-snapshot-protocol: ServerLoopUtilizationFrameV1 conformance", () => {
	it("the_pinned_loop_utilization_vector_is_the_one_this_codec_produces", () => {
		expect(isServerLoopUtilizationFrameV1(LOOP_UTILIZATION_FIXTURE)).toBe(true);
		const bytes = canonicalRecordBytes(LOOP_UTILIZATION_FIXTURE);
		expect(Buffer.from(bytes).toString("hex")).toBe(
			TS_SERVER_LOOP_UTILIZATION_HEX,
		);
	});

	it("the_vector_carries_the_frozen_key_set_and_nothing_else", () => {
		const decoded: unknown = JSON.parse(
			Buffer.from(TS_SERVER_LOOP_UTILIZATION_HEX, "hex").toString("utf8"),
		);
		expect(isServerLoopUtilizationFrameV1(decoded)).toBe(true);
		expect(Object.keys(decoded as Record<string, unknown>).sort()).toEqual([
			"allMeasuredSessionsClosed",
			"baselineAtLinuxNs",
			"baselineBusyMs",
			"bulkSourceCompletion",
			"busyMs",
			"cellId",
			"childInstanceNonce",
			"childPgid",
			"childPid",
			"cohortGrantSha256",
			"cohortStartBarrierSha256",
			"executionSha256",
			"finalBusyMs",
			"finalSnapshotAtLinuxNs",
			"linuxClockId",
			"repetitionIndex",
			"repetitionKind",
			"repetitionTotal",
			"roleTokenCommitmentRootSha256",
			"scenarioHash",
			"schema",
			"transport",
			"windowMs",
		]);
	});

	it("a_key_added_or_dropped_moves_the_predicate_off_the_frame", () => {
		const extra = { ...LOOP_UTILIZATION_FIXTURE, extra: 1 };
		expect(isServerLoopUtilizationFrameV1(extra)).toBe(false);
		for (const key of Object.keys(LOOP_UTILIZATION_FIXTURE)) {
			const missing = { ...LOOP_UTILIZATION_FIXTURE } as Record<
				string,
				unknown
			>;
			delete missing[key];
			expect(isServerLoopUtilizationFrameV1(missing)).toBe(false);
		}
	});
});
