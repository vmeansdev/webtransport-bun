import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const capacityNote = readFileSync(
	join(
		import.meta.dir,
		"../../docs/research/2026-08-21-bare-metal-capacity.md",
	),
	"utf8",
);

describe("G6 capacity-note evidence boundaries", () => {
	test("leaves all diagnostic-01 causal hypotheses unresolved", () => {
		expect(capacityNote).toContain("D1/D2/D3 remain unresolved");
		expect(capacityNote).toContain("requires a new source-bound rerun");
		expect(capacityNote).not.toContain(
			"D1 (per-shard transient shutdown) and D2 (BPF CID-race) are ruled",
		);
		expect(capacityNote).not.toContain(
			"D3 is the right reading of g6-sharded-diagnostic-01",
		);
	});

	test("does not convert a null error sample into a zero count", () => {
		expect(capacityNote).toContain("null is not zero");
		expect(capacityNote).not.toContain(
			"`connectErrorsSample`\n**null** (0 errors)",
		);
		expect(capacityNote).not.toContain(
			"`connectErrorsSample` **null** (0 errors)",
		);
	});

	test("distinguishes the repaired timeout source from historical evidence", () => {
		expect(capacityNote).toMatch(
			/the current candidate forwards the registered timeout\s+to both layers/i,
		);
		expect(capacityNote).toMatch(
			/does not retroactively repair the\s+historical run/,
		);
	});
});
