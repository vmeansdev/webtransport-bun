/**
 * The facade must let a caller tell "this addon has no pacer" apart from "the
 * pacer knob is off".
 *
 * A current addon answers `"{}"` when the knob is off. If the facade forwarded
 * `"{}"` for a method the addon does not export, a bench run with the knob set
 * against a stale addon would produce an artifact with no pacer stats and
 * nothing saying the composition was wrong. So: present method → forwarded,
 * absent method → absent property.
 */

import { describe, expect, it } from "bun:test";
import { __TESTING__ } from "../src/index.js";

const { pacerStatsForwardsForTests: pacerStatsForwards } = __TESTING__;

describe("pacer stats forwards", () => {
	it("forwards both accessors when the addon exports them", () => {
		const calls: (number | undefined)[] = [];
		const forwards = pacerStatsForwards({
			__pacerStatsSnapshot: () => 7,
			__pacerStatsJson: (token?: number) => {
				calls.push(token);
				return '{"pps":30000}';
			},
		});

		expect(typeof forwards.__pacerStatsSnapshot).toBe("function");
		expect(typeof forwards.__pacerStatsJson).toBe("function");
		expect(forwards.__pacerStatsSnapshot?.()).toBe(7);
		expect(forwards.__pacerStatsJson?.(7)).toBe('{"pps":30000}');
		expect(calls).toEqual([7]);
	});

	it("passes the knob-off sentinel through unchanged", () => {
		const forwards = pacerStatsForwards({
			__pacerStatsSnapshot: () => 0,
			__pacerStatsJson: () => "{}",
		});

		expect(forwards.__pacerStatsJson?.()).toBe("{}");
		expect(forwards.__pacerStatsSnapshot?.()).toBe(0);
	});

	it("omits the properties entirely on an addon without them", () => {
		const forwards = pacerStatsForwards({});

		expect(forwards.__pacerStatsSnapshot).toBeUndefined();
		expect(forwards.__pacerStatsJson).toBeUndefined();
		expect(Object.hasOwn(forwards, "__pacerStatsJson")).toBe(false);
		expect(Object.hasOwn(forwards, "__pacerStatsSnapshot")).toBe(false);
	});

	it("never substitutes the knob-off sentinel for a missing method", () => {
		// The H3 regression: `handle.__pacerStatsJson?.(token) ?? "{}"` made a
		// stale addon and an unpaced run produce the same reading.
		const forwards = pacerStatsForwards({ __pacerStatsSnapshot: () => 0 });

		expect(forwards.__pacerStatsJson).toBeUndefined();
		expect(typeof forwards.__pacerStatsSnapshot).toBe("function");
	});

	it("keeps the accessors bound to their handle", () => {
		const handle = {
			token: 11,
			__pacerStatsSnapshot(this: { token: number }) {
				return this.token;
			},
			__pacerStatsJson(this: { token: number }) {
				return String(this.token);
			},
		};
		const forwards = pacerStatsForwards(handle);

		expect(forwards.__pacerStatsSnapshot?.()).toBe(11);
		expect(forwards.__pacerStatsJson?.()).toBe("11");
	});
});
