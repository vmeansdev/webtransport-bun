/**
 * The exported defaults are what every createServer/connect merges under the
 * caller's options, so a write to them would silently change later defaults.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_LIMITS, DEFAULT_RATE_LIMITS } from "../src/index.js";

describe("exported default limits", () => {
	it("are frozen", () => {
		expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
		expect(Object.isFrozen(DEFAULT_RATE_LIMITS)).toBe(true);
	});

	it("reject writes instead of changing later defaults", () => {
		expect(() => {
			(DEFAULT_LIMITS as { maxSessions: number }).maxSessions = 1;
		}).toThrow(TypeError);
		expect(() => {
			(DEFAULT_RATE_LIMITS as { handshakesPerSec: number }).handshakesPerSec =
				0;
		}).toThrow(TypeError);
		expect(DEFAULT_LIMITS.maxSessions).toBe(2000);
		expect(DEFAULT_RATE_LIMITS.handshakesPerSec).toBe(20);
	});
});
