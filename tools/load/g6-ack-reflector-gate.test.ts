import { describe, expect, test } from "bun:test";
import { gradeAckReflectorGate } from "./g6-ack-reflector-gate.ts";

describe("ack reflector kill gate", () => {
	test("passes only when native p99 is at or below a quarter of js p99", () => {
		expect(gradeAckReflectorGate(83.5, 20.0)).toMatchObject({
			pass: true,
			ratio: 20.0 / 83.5,
		});
		expect(gradeAckReflectorGate(83.5, 20.9)).toMatchObject({ pass: true });
		expect(gradeAckReflectorGate(83.5, 21.0)).toMatchObject({ pass: false });
		expect(gradeAckReflectorGate(10, 2.5)).toMatchObject({ pass: true });
	});
	test("refuses non-finite inputs", () => {
		expect(() => gradeAckReflectorGate(Number.NaN, 1)).toThrow(/finite/);
		expect(() => gradeAckReflectorGate(1, -1)).toThrow(/finite|negative/);
	});
});
