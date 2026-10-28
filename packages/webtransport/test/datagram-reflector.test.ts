import { describe, expect, it } from "bun:test";
import type { DatagramReflectorRule } from "../src/datagram-reflector.js";
import {
	applyDatagramReflectorRule,
	datagramReflectorRuleChecked,
	mapReflectorError,
	REFLECTOR_MAX_OPS,
} from "../src/datagram-reflector.js";

const G6_RULE: DatagramReflectorRule = {
	minLength: 48,
	replyLength: 48,
	match: [
		{ offset: 0, bytes: new Uint8Array([0x54, 0x4c]) },
		{ offset: 2, bytes: new Uint8Array([3, 0]) },
		{ offset: 44, bytes: new Uint8Array([1]) },
	],
	rewrite: [
		{ op: "copy", from: 12, to: 28, length: 8 },
		{ op: "zero", at: 4, length: 8 },
		{ op: "nowNs", at: 12 },
		{ op: "holdNs", at: 36 },
		{ op: "set", at: 44, value: 2 },
	],
};

function stamp(actual: bigint, sequence: bigint): Uint8Array {
	const bytes = new Uint8Array(64);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, 0x4c54, true);
	view.setUint16(2, 3, true);
	view.setBigUint64(4, 7n, true);
	view.setBigUint64(12, actual, true);
	view.setBigUint64(20, sequence, true);
	bytes[44] = 1;
	return bytes;
}

describe("datagram reflector rule validation", () => {
	it("accepts the G6 rule and forwards a native-shaped object", () => {
		const seen: unknown[] = [];
		datagramReflectorRuleChecked((native) => seen.push(native), G6_RULE);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ minLength: 48, replyLength: 48 });
		datagramReflectorRuleChecked((native) => seen.push(native), null);
		expect(seen[1]).toBeNull();
	});

	it("throws TypeError for shape errors before calling native", () => {
		const install = () => {
			throw new Error("must not be called");
		};
		expect(() => datagramReflectorRuleChecked(install, {} as never)).toThrow(
			TypeError,
		);
		expect(() =>
			datagramReflectorRuleChecked(install, { ...G6_RULE, match: [] }),
		).toThrow(TypeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				rewrite: [{ op: "xor", at: 0 } as never],
			}),
		).toThrow(TypeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				rewrite: Array.from(
					{ length: REFLECTOR_MAX_OPS + 1 },
					() => ({ op: "set", at: 0, value: 0 }) as const,
				),
			}),
		).toThrow(TypeError);
	});

	it("throws TypeError for a non-Uint8Array match.bytes typed array", () => {
		const install = () => {
			throw new Error("must not be called");
		};
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				match: [{ offset: 0, bytes: new Int16Array([300]) as never }],
			}),
		).toThrow(TypeError);
	});

	it("accepts a Uint8Array match.bytes pattern of length 8 at offset 0", () => {
		const seen: unknown[] = [];
		datagramReflectorRuleChecked((native) => seen.push(native), {
			...G6_RULE,
			match: [{ offset: 0, bytes: new Uint8Array(8) }],
		});
		expect(seen).toHaveLength(1);
	});

	it("throws RangeError for bound errors before calling native", () => {
		const install = () => {
			throw new Error("must not be called");
		};
		expect(() =>
			datagramReflectorRuleChecked(install, { ...G6_RULE, replyLength: 49 }),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				rewrite: [{ op: "nowNs", at: 41 }],
			}),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				match: [{ offset: 47, bytes: new Uint8Array([1, 2]) }],
			}),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				rewrite: [{ op: "set", at: 0, value: 256 }],
			}),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				minLength: 1201,
				replyLength: 1201,
			}),
		).toThrow(RangeError);
	});
});

describe("reference reflector semantics", () => {
	it("reproduces writeReflection for the G6 rule", () => {
		const reply = applyDatagramReflectorRule(
			stamp(123n, 9n),
			G6_RULE,
			500n,
			40n,
		);
		expect(reply).not.toBeNull();
		const view = new DataView(reply!.buffer, reply!.byteOffset);
		expect(reply!.byteLength).toBe(48);
		expect(view.getUint16(0, true)).toBe(0x4c54);
		expect(view.getBigUint64(4, true)).toBe(0n);
		expect(view.getBigUint64(12, true)).toBe(500n);
		expect(view.getBigUint64(20, true)).toBe(9n);
		expect(view.getBigUint64(28, true)).toBe(123n);
		expect(view.getBigUint64(36, true)).toBe(40n);
		expect(reply![44]).toBe(2);
	});

	it("returns null for a non-matching datagram", () => {
		const other = stamp(1n, 2n);
		other[44] = 3;
		expect(applyDatagramReflectorRule(other, G6_RULE, 0n, 0n)).toBeNull();
		expect(
			applyDatagramReflectorRule(new Uint8Array(10), G6_RULE, 0n, 0n),
		).toBeNull();
	});
});

describe("mapReflectorError", () => {
	it("maps a bare prefix and a napi-style prefix", () => {
		const bare = mapReflectorError(new Error("RangeError: at exceeds 48"));
		expect(bare).toBeInstanceOf(RangeError);
		expect((bare as RangeError).message).toBe("at exceeds 48");
		const napi = mapReflectorError(new Error("Failed: TypeError: unknown op"));
		expect(napi).toBeInstanceOf(TypeError);
		expect((napi as TypeError).message).toBe("unknown op");
	});

	it("leaves a message that merely contains a prefix mid-text unchanged", () => {
		const original = new Error("the peer reported RangeError: at exceeds 48");
		expect(mapReflectorError(original)).toBe(original);
	});
});
