import { describe, expect, test } from "bun:test";

import { canonicalGeneratorIdentity } from "./host-identity.ts";

describe("canonical generator identity", () => {
	test("matches macOS hostname() to hostname -s without fuzzy comparison", () => {
		expect(canonicalGeneratorIdentity("Nikitas-MacBook-Pro.local")).toBe(
			"Nikitas-MacBook-Pro",
		);
		expect(canonicalGeneratorIdentity("Nikitas-MacBook-Pro")).toBe(
			"Nikitas-MacBook-Pro",
		);
	});

	test("rejects empty or malformed identities", () => {
		expect(() => canonicalGeneratorIdentity("")).toThrow("nonempty");
		expect(() => canonicalGeneratorIdentity("host name.local")).toThrow(
			"hostname",
		);
	});
});
