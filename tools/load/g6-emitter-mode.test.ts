import { describe, expect, test } from "bun:test";
import { resolveEmitterMode } from "./g6-emitter-mode.ts";

describe("G6 emitter mode", () => {
	test("defaults the legacy unpaced configuration to per-player batches", () => {
		expect(resolveEmitterMode(undefined, false)).toBe("per-player-batch");
	});

	test("allows the explicit native mirror candidate", () => {
		expect(resolveEmitterMode("native-mirror", false)).toBe("native-mirror");
	});

	test("rejects paced disagreement and unknown modes", () => {
		expect(() => resolveEmitterMode("native-mirror", true)).toThrow(
			"does not match --paced",
		);
		expect(() => resolveEmitterMode("not-a-mode", false)).toThrow(
			"G6_EMITTER_MODE",
		);
	});
});
