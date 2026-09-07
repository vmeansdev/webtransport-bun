/**
 * Server-side loop-utilization snapshot protocol.
 *
 * A bounded, length-prefixed canonical-JSON record that the controller
 * consumes from the rig's controller↔supervisor control channel. The
 * codec is pure: it has no I/O, no clock, and no process state. The
 * controller module that owns the actual stream lives in
 * `server-snapshot-sidecar.ts` (controllerOnlyTs); this module is
 * `protocolOnlyTs` so importing it from an official root does not pull
 * process or network capabilities into the official graph.
 *
 * Frame format:
 *   uint32_be payloadLength
 *   payloadLength bytes of canonical JSON
 *
 * The hard cap on payload size is 4096 bytes; records larger than
 * that are rejected by `decodeServerSnapshot` so a corrupt or
 * adversarial frame cannot exhaust the controller's buffer.
 *
 * Correlation tuple:
 *   { campaignId, runId, executionIndex, transport, legId, sequence }
 *
 * The tuple is what binds a snapshot to the same execution the client
 * `MeasuredLeg` was filed under; the controller joins the two records
 * before `measuredLegToArm` runs.
 *
 * A2 also freezes the attested Phase-A `ServerLoopUtilizationFrameV1`
 * shape (plan §3.4) used by child-pipe capture acknowledgements. The
 * legacy `ServerSnapshotRecord` wire remains byte-compatible for the
 * current seal path; A3 cutover joins the attested frame.
 */
import { canonicalJson } from "./canonical.ts";

export const SERVER_SNAPSHOT_SCHEMA = "server-loop-utilization/v1";
export const SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES = 4096;
const FRAME_LENGTH_BYTES = 4;

/**
 * The single record this protocol carries.
 *
 * `busyMs` and `windowMs` are the same `{ busyMs, windowMs }` shape
 * `ServerMetrics.serverLoopUtilization` reports. The protocol is
 * deliberately narrow: it carries the server-aggregate value the
 * client cannot measure itself, and nothing else.
 */
export interface ServerSnapshotRecord {
	readonly schema: typeof SERVER_SNAPSHOT_SCHEMA;
	readonly campaignId: string;
	readonly runId: string;
	readonly executionIndex: number;
	readonly transport: "ws" | "wt";
	readonly legId: string;
	readonly sequence: number;
	readonly capturedAtMs: number;
	readonly loopUtilization: {
		readonly busyMs: number;
		readonly windowMs: number;
	};
}

/**
 * Attested Phase-A child capture frame (plan §3.4). Codec-only in A2.
 *
 * **What `busyMs` on this frame means.** It is the difference of two reads of
 * one accumulator -- `finalBusyMs - baselineBusyMs` -- and that accumulator is
 * `SESSION_LOOP_BUSY_MS_DEFINITION` (`adapters/transport.ts`), summed across
 * the child's sessions: the JavaScript event-loop time the server child spent
 * on this session's transport work, ingest and egress alike, over the window
 * the two `*AtLinuxNs` stamps bound. Egress is the loop time spent framing,
 * scheduling and resuming outbound writes, never the wall time the bytes take
 * to leave.
 *
 * It is **not** process CPU. Native addon time, kernel send and receive work,
 * QUIC and TLS below the JavaScript boundary, and anything the runtime does on
 * another thread are all outside it, as is scenario work the harness does
 * outside the session -- generating and digesting a bulk payload, for one. A
 * reader comparing a WS arm's `busyMs` against a WT arm's is comparing loop
 * occupancy, not machine cost.
 */
export interface ServerLoopUtilizationFrameV1 {
	readonly schema: "server-loop-utilization/v1";
	readonly executionSha256: string;
	readonly cellId: string;
	readonly scenarioHash: string;
	readonly cohortGrantSha256: string | null;
	readonly cohortStartBarrierSha256: string | null;
	readonly roleTokenCommitmentRootSha256: string | null;
	readonly transport: "ws" | "wt";
	readonly repetitionKind: "warmup" | "measured";
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: string;
	readonly baselineBusyMs: number;
	readonly finalBusyMs: number;
	readonly busyMs: number;
	readonly baselineAtLinuxNs: string;
	readonly finalSnapshotAtLinuxNs: string;
	readonly windowMs: number;
	readonly linuxClockId: string;
	readonly allMeasuredSessionsClosed: true;
	readonly bulkSourceCompletion: {
		readonly schema: "bulk-source-completion/v1";
		readonly executionSha256: string;
		readonly direction: "linux-to-mac";
		readonly serverRole: "bulk-source";
		readonly channelMapping: "server-opened-uni";
		readonly scheduledChunkCount: 1600;
		readonly chunksWritten: 1600;
		readonly chunkBytes: 65536;
		readonly bytesWritten: 104857600;
		readonly payloadSha256: string;
		readonly firstWriteAtLinuxNs: string;
		readonly channelEndedAtLinuxNs: string;
		readonly linuxClockId: string;
		readonly channelEnded: true;
	} | null;
}

const SERVER_LOOP_UTILIZATION_FRAME_KEYS = [
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
] as const;

export function isServerLoopUtilizationFrameV1(
	value: unknown,
): value is ServerLoopUtilizationFrameV1 {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (
		keys.length !== SERVER_LOOP_UTILIZATION_FRAME_KEYS.length ||
		SERVER_LOOP_UTILIZATION_FRAME_KEYS.some((key, index) => keys[index] !== key)
	) {
		return false;
	}
	if (record.schema !== SERVER_SNAPSHOT_SCHEMA) return false;
	if (typeof record.executionSha256 !== "string") return false;
	if (
		typeof record.busyMs !== "number" ||
		typeof record.windowMs !== "number"
	) {
		return false;
	}
	if (record.allMeasuredSessionsClosed !== true) return false;
	if (
		typeof record.baselineBusyMs !== "number" ||
		typeof record.finalBusyMs !== "number"
	) {
		return false;
	}
	// Conservation: busyMs = finalBusyMs - baselineBusyMs.
	if (record.busyMs !== record.finalBusyMs - record.baselineBusyMs) {
		return false;
	}
	return true;
}

/**
 * Encode a `ServerSnapshotRecord` to wire bytes.
 *
 * The frame is `uint32_be payloadLength || canonicalJson(record)`.
 * The encoder is deterministic and never throws on a well-typed
 * record; a record whose canonical JSON exceeds the hard cap is
 * rejected because that is a producer bug, not a runtime condition.
 */
export function encodeServerSnapshot(record: ServerSnapshotRecord): Uint8Array {
	const json = canonicalJson(record);
	const payload = new TextEncoder().encode(json);
	if (payload.byteLength > SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES) {
		throw new RangeError(
			`server snapshot payload ${payload.byteLength} bytes exceeds hard cap ${SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES}; producer must shrink the record`,
		);
	}
	const frame = new Uint8Array(FRAME_LENGTH_BYTES + payload.byteLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, payload.byteLength, false);
	frame.set(payload, FRAME_LENGTH_BYTES);
	return frame;
}

/**
 * Decode a complete frame (`uint32_be length || payload`) into a
 * `ServerSnapshotRecord`.
 *
 * Decoding rejects:
 * - frames whose declared length exceeds the hard cap;
 * - non-canonical or unparseable JSON;
 * - records with the wrong `schema` field;
 * - records with finite-violating numeric fields;
 * - records whose correlation tuple is structurally invalid.
 *
 * The decoder is the security boundary between the rig's control
 * channel and the controller's typed join, so every rejection is a
 * typed refusal that the controller can surface rather than a
 * crash.
 */
export function decodeServerSnapshot(frame: Uint8Array): ServerSnapshotRecord {
	if (frame.byteLength < FRAME_LENGTH_BYTES) {
		throw new RangeError(
			`server snapshot frame is ${frame.byteLength} bytes, less than the 4-byte length prefix`,
		);
	}
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const declaredLength = view.getUint32(0, false);
	if (declaredLength > SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES) {
		throw new RangeError(
			`server snapshot declared payload length ${declaredLength} exceeds hard cap ${SERVER_SNAPSHOT_MAX_PAYLOAD_BYTES}`,
		);
	}
	if (frame.byteLength !== FRAME_LENGTH_BYTES + declaredLength) {
		throw new RangeError(
			`server snapshot frame is ${frame.byteLength} bytes; expected ${FRAME_LENGTH_BYTES + declaredLength}`,
		);
	}
	const payload = new TextDecoder().decode(frame.subarray(FRAME_LENGTH_BYTES));
	const parsed: unknown = JSON.parse(payload);
	if (!isServerSnapshotRecord(parsed)) {
		throw new TypeError(
			"server snapshot payload is not a valid ServerSnapshotRecord",
		);
	}
	return parsed;
}

/**
 * Consume exactly one frame from a byte stream.
 *
 * `readServerSnapshotFrame(reader, deadlineMs)` returns a Promise
 * that resolves to a `ServerSnapshotRecord` once a complete frame
 * has been read, or rejects with a typed error on deadline,
 * truncation, oversized payload, or malformed JSON.
 *
 * The reader must yield the frame's raw bytes; partial reads are
 * buffered by the caller. This is the controller-side half of the
 * protocol -- the producer-side framing lives in
 * `encodeServerSnapshot`.
 */
export async function readServerSnapshotFrame(
	readFrame: () => Promise<Uint8Array | null>,
	deadlineMs: number,
	nowMs: () => number,
): Promise<ServerSnapshotRecord> {
	if (!Number.isFinite(deadlineMs)) {
		throw new RangeError(`read deadline must be finite; got ${deadlineMs}`);
	}
	const remaining = deadlineMs - nowMs();
	if (remaining <= 0) {
		throw new Error("E_HANDSHAKE_TIMEOUT: read deadline already expired");
	}
	const frame = await Promise.race([
		readFrame(),
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("E_HANDSHAKE_TIMEOUT: read deadline exceeded")),
				remaining,
			),
		),
	]);
	if (frame === null) {
		throw new Error("E_SESSION_CLOSED: stream closed before frame arrived");
	}
	return decodeServerSnapshot(frame);
}

function isServerSnapshotRecord(value: unknown): value is ServerSnapshotRecord {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record["schema"] !== SERVER_SNAPSHOT_SCHEMA) return false;
	if (typeof record["campaignId"] !== "string") return false;
	if (typeof record["runId"] !== "string") return false;
	if (typeof record["executionIndex"] !== "number") return false;
	if (record["transport"] !== "ws" && record["transport"] !== "wt")
		return false;
	if (typeof record["legId"] !== "string") return false;
	if (typeof record["sequence"] !== "number") return false;
	if (typeof record["capturedAtMs"] !== "number") return false;
	const loop = record["loopUtilization"];
	if (loop === null || typeof loop !== "object") return false;
	const loopRecord = loop as Record<string, unknown>;
	if (typeof loopRecord["busyMs"] !== "number") return false;
	if (typeof loopRecord["windowMs"] !== "number") return false;
	return (
		Number.isFinite(record["executionIndex"]) &&
		Number.isFinite(record["sequence"]) &&
		Number.isFinite(record["capturedAtMs"]) &&
		Number.isFinite(loopRecord["busyMs"]) &&
		Number.isFinite(loopRecord["windowMs"]) &&
		loopRecord["busyMs"] >= 0 &&
		loopRecord["windowMs"] > 0
	);
}
