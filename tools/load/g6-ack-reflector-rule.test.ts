import { describe, expect, test } from "bun:test";
import { applyDatagramReflectorRule } from "../../packages/webtransport/src/datagram-reflector.ts";
import {
	G6_V3_ACK_REFLECTOR_RULE,
	resolveAckReflectorMode,
} from "./g6-ack-reflector-rule.ts";
import {
	CLASS_ACK,
	CLASS_ACTION,
	decodeStamp,
	encodeStamp,
	STAMP_BYTES_V3,
	writeReflection,
} from "./latency-stamp.ts";

describe("G6 v3 ack reflector rule", () => {
	test("reproduces writeReflection byte for byte", () => {
		const datagram = new Uint8Array(64);
		encodeStamp(datagram, {
			version: 3,
			intendedNs: 111,
			actualNs: 222_333,
			sequence: 44,
			klass: CLASS_ACTION,
		});
		const expected = new Uint8Array(STAMP_BYTES_V3);
		expected.set(datagram.subarray(0, STAMP_BYTES_V3));
		expect(
			writeReflection(expected, {
				echoActualNs: 222_333,
				serverSendNs: 999_000,
				holdNs: 5_000,
				klass: CLASS_ACK,
				sequence: 44,
			}),
		).toBe(true);
		const reply = applyDatagramReflectorRule(
			datagram,
			G6_V3_ACK_REFLECTOR_RULE,
			999_000n,
			5_000n,
		);
		expect(reply).not.toBeNull();
		expect(Array.from(reply as Uint8Array)).toEqual(Array.from(expected));
		const stamp = decodeStamp(reply as Uint8Array);
		expect(stamp?.klass).toBe(CLASS_ACK);
		expect(stamp?.echoActualNs).toBe(222_333);
		expect(stamp?.holdNs).toBe(5_000);
	});

	test("does not match snapshots, acks, or version-2 stamps", () => {
		for (const [version, klass] of [
			[3, 3],
			[3, 2],
			[2, CLASS_ACTION],
		] as const) {
			const datagram = new Uint8Array(64);
			encodeStamp(datagram, {
				version,
				intendedNs: 1,
				actualNs: 2,
				sequence: 3,
				klass,
			});
			expect(
				applyDatagramReflectorRule(datagram, G6_V3_ACK_REFLECTOR_RULE, 0n, 0n),
			).toBeNull();
		}
	});

	test("resolves the mode strictly", () => {
		expect(resolveAckReflectorMode(undefined)).toBe("js");
		expect(resolveAckReflectorMode("js")).toBe("js");
		expect(resolveAckReflectorMode("native")).toBe("native");
		expect(() => resolveAckReflectorMode("yes")).toThrow(/SCAN_ACK_REFLECTOR/);
	});
});
