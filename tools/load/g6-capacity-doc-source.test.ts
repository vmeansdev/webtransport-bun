import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const capacityDoc = readFileSync(
	join(
		import.meta.dir,
		"../../docs/research/2026-08-21-bare-metal-capacity.md",
	),
	"utf8",
);

describe("G6 capacity notes stay within the historical evidence", () => {
	test("keeps the diagnostic attribution unresolved", () => {
		expect(capacityDoc).toContain("null is not zero");
		expect(capacityDoc).toContain("D1/D2/D3 remain unresolved");
		expect(capacityDoc).toContain("requires a new source-bound rerun");
		expect(capacityDoc).not.toContain("rule out D1");
		expect(capacityDoc).not.toContain("rule out D2");
		expect(capacityDoc).not.toContain("identify D3");
	});

	test("avoids turning later historical runs into causal proof", () => {
		expect(capacityDoc).toContain("do not close D3");
		expect(capacityDoc).toContain(
			"prove a kernel-only or SO_REUSEPORT-only cause",
		);
		expect(capacityDoc).not.toContain("likely SO_REUSEPORT-group race");
		expect(capacityDoc).not.toContain("clean re-dispatch established");
	});
});
