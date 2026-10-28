/**
 * The G6 harness's native ack reflector: the one rule that lets a shard answer
 * a version-3 action datagram in native, without the JS loop ever seeing it.
 */
import type { DatagramReflectorRule } from "../../packages/webtransport/src/datagram-reflector.ts";
import {
	CLASS_ACK,
	CLASS_ACTION,
	OFFSET_ACTUAL,
	OFFSET_CLASS,
	OFFSET_ECHO_ACTUAL,
	OFFSET_HOLD,
	OFFSET_INTENDED,
	OFFSET_MAGIC,
	OFFSET_VERSION,
	STAMP_BYTES_V3,
	STAMP_MAGIC,
} from "./latency-stamp.ts";

export type AckReflectorMode = "js" | "native";

/** `SCAN_ACK_REFLECTOR`: `js` (default, every existing profile) or `native`. */
export function resolveAckReflectorMode(
	value: string | undefined,
): AckReflectorMode {
	if (value === undefined || value === "js") return "js";
	if (value === "native") return "native";
	throw new Error(
		`SCAN_ACK_REFLECTOR must be js or native, got ${JSON.stringify(value)}`,
	);
}

/**
 * The version-3 action stamp reflected into an ack, exactly as
 * `writeReflection` in latency-stamp.ts does it: client actual moves into
 * echoActual, intended is zeroed, actual becomes the server send instant,
 * hold is the receive-to-reflection duration, class becomes ACK, sequence
 * stays. The copy is listed before the write that overwrites its source.
 */
export const G6_V3_ACK_REFLECTOR_RULE: DatagramReflectorRule = {
	minLength: STAMP_BYTES_V3,
	replyLength: STAMP_BYTES_V3,
	match: [
		{
			offset: OFFSET_MAGIC,
			bytes: new Uint8Array([STAMP_MAGIC & 0xff, STAMP_MAGIC >> 8]),
		},
		{ offset: OFFSET_VERSION, bytes: new Uint8Array([3, 0]) },
		{ offset: OFFSET_CLASS, bytes: new Uint8Array([CLASS_ACTION]) },
	],
	rewrite: [
		{ op: "copy", from: OFFSET_ACTUAL, to: OFFSET_ECHO_ACTUAL, length: 8 },
		{ op: "zero", at: OFFSET_INTENDED, length: 8 },
		{ op: "nowNs", at: OFFSET_ACTUAL },
		{ op: "holdNs", at: OFFSET_HOLD },
		{ op: "set", at: OFFSET_CLASS, value: CLASS_ACK },
	],
};
