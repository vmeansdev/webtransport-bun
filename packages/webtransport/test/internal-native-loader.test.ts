import { describe, expect, it } from "bun:test";
import { __TESTING__ } from "../src/index.js";

describe("internal native addon loader", () => {
	it("records candidate-specific root causes when load fails", () => {
		const result = __TESTING__.tryLoadNativeAddonForTests(
			(request: string) => {
				throw new Error(`missing module for ${request}`);
			},
			["/base-a", "/base-b"],
			["addon-a.node", "addon-b.node"],
		);

		expect(result.addon).toBeUndefined();
		expect(result.failures.length).toBe(4);
		expect(result.failures[0]?.request).toBe("/base-a/addon-a.node");
		expect(result.failures[0]?.message).toContain("missing module");
	});

	it("formats a stable diagnostic message with attempts and causes", () => {
		const msg = __TESTING__.buildNativeAddonLoadErrorMessageForTests([
			{ request: "/x/one.node", message: "dlopen failed" },
			{ request: "/x/two.node", message: "wrong architecture" },
		]);

		expect(msg).toContain("Native addon not loaded");
		expect(msg).toContain("/x/one.node");
		expect(msg).toContain("dlopen failed");
		expect(msg).toContain("/x/two.node");
		expect(msg).toContain("wrong architecture");
	});
});
