import { describe, expect, it } from "bun:test";
import { __TESTING__ } from "../src/internal.js";

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

	it("parses an explicit addon override path from env", () => {
		expect(
			__TESTING__.nativeAddonOverrideRequestsFromEnvForTests(
				" /tmp/webtransport-seam.node ",
			),
		).toEqual(["/tmp/webtransport-seam.node"]);
		expect(
			__TESTING__.nativeAddonOverrideRequestsFromEnvForTests("   "),
		).toEqual([]);
	});

	it("does not fall back when an explicit addon override fails", () => {
		const attempts: string[] = [];
		const fallbackAddon = { source: "default-candidate" };
		const result = __TESTING__.tryLoadNativeAddonForTests(
			(request: string) => {
				attempts.push(request);
				if (request === "/tmp/missing-override.node") {
					throw new Error("explicit override missing");
				}
				return fallbackAddon;
			},
			["/base"],
			["fallback.node"],
			["/tmp/missing-override.node"],
		);

		expect(result.addon).toBeUndefined();
		expect(attempts).toEqual(["/tmp/missing-override.node"]);
		expect(result.failures).toEqual([
			{
				request: "/tmp/missing-override.node",
				message: "explicit override missing",
			},
		]);
	});

	it("requires the engine-owned payload ABI before production use", () => {
		expect(() => __TESTING__.assertNativePayloadOwnershipForTests({})).toThrow(
			"E_INTERNAL: native addon payload ownership capability mismatch",
		);
		expect(() =>
			__TESTING__.assertNativePayloadOwnershipForTests({
				payloadOwnershipVersion: () => 2,
			}),
		).toThrow("expected 1, received 2");
		expect(() =>
			__TESTING__.assertNativePayloadOwnershipForTests({
				payloadOwnershipVersion: () => 1,
			}),
		).not.toThrow();
	});
});
