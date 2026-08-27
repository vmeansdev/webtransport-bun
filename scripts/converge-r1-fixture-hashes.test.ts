import { describe, expect, test } from "bun:test";
import {
	applyReplacements,
	auditApplication,
	countDigestTokens,
	EXIT,
	makeStateGuard,
	parseReport,
	planReplacements,
	type VerifierCheck,
	type VerifierReport,
} from "./converge-r1-fixture-hashes.ts";

const digest = (seed: string): string =>
	seed.repeat(64).slice(0, 64).toLowerCase();

const A = digest("a1");
const B = digest("b2");
const C = digest("c3");
const D = digest("d4");

const check = (
	label: string,
	frozen: string,
	computed: string,
): VerifierCheck => ({ label, frozen, computed, ok: frozen === computed });

const report = (
	checks: VerifierCheck[],
	structural: string[] = [],
): VerifierReport => ({
	clean: checks.every((entry) => entry.ok) && structural.length === 0,
	mismatches: checks.filter((entry) => !entry.ok).length + structural.length,
	checks,
	structural,
});

describe("planReplacements", () => {
	test("plans nothing for a clean report", () => {
		const plan = planReplacements(report([check("x", A, A)]), `"${A}"`);
		expect(plan).toEqual({ ok: true, replacements: [], deferred: [] });
	});

	test("counts every whole-token occurrence of a stale digest", () => {
		const source = `const a = "${A}";\nconst b = ["${A}", "${A}"];\n`;
		const plan = planReplacements(report([check("x", A, B)]), source);
		if (!plan.ok) throw new Error(plan.reasons.join("; "));
		expect(plan.replacements).toHaveLength(1);
		expect(plan.replacements[0]).toMatchObject({
			old: A,
			next: B,
			occurrences: 3,
		});
	});

	test("merges duplicate labels reporting the same pair", () => {
		const plan = planReplacements(
			report([check("x", A, B), check("y", A, B)]),
			`"${A}"`,
		);
		if (!plan.ok) throw new Error(plan.reasons.join("; "));
		expect(plan.replacements).toHaveLength(1);
		expect(plan.replacements[0]?.labels).toEqual(["x", "y"]);
	});

	test("refuses when no reported stale digest exists in the fixture", () => {
		const plan = planReplacements(report([check("x", A, B)]), `"${C}"`);
		expect(plan).toMatchObject({ ok: false, code: EXIT.AMBIGUOUS });
		if (plan.ok) throw new Error("expected refusal");
		expect(plan.reasons.join(" ")).toContain("no other reported digest does");
	});

	// Parts of the DAG are computed at import time, so their stale side has no
	// literal to rewrite; those follow once their inputs are fixed.
	test("defers a derived digest that has no literal, and applies the rest", () => {
		const plan = planReplacements(
			report([check("literal", A, B), check("derived", C, D)]),
			`"${A}"`,
		);
		if (!plan.ok) throw new Error(plan.reasons.join("; "));
		expect(plan.replacements.map((entry) => entry.old)).toEqual([A]);
		expect(plan.deferred.map((entry) => entry.old)).toEqual([C]);
	});

	// The property that makes the driver trustworthy: one ambiguous pair
	// forfeits the whole pass. A driver that applied the unambiguous pair and
	// skipped the ambiguous one would leave the fixture in a state no DAG
	// explains, and the next verify run would read it as ordinary drift.
	test("refuses the whole batch when one pair is ambiguous", () => {
		const source = `"${A}" "${C}"`;
		const plan = planReplacements(
			report([
				check("clean-pair", A, B),
				check("stale", C, D),
				check("correct", C, C),
			]),
			source,
		);
		expect(plan.ok).toBe(false);
		if (plan.ok) throw new Error("expected refusal");
		expect(plan.reasons.join(" ")).toContain("would clobber it");
		// Nothing reaches the file: the applicable pair is forfeited too.
		expect(applyReplacements(source, []).text).toBe(source);
	});

	test("refuses conflicting targets for one stale digest", () => {
		const plan = planReplacements(
			report([check("x", A, B), check("y", A, C)]),
			`"${A}"`,
		);
		expect(plan).toMatchObject({ ok: false, code: EXIT.AMBIGUOUS });
		if (plan.ok) throw new Error("expected refusal");
		expect(plan.reasons.join(" ")).toContain("conflicting targets");
	});

	test("refuses to clobber a digest that is correct elsewhere", () => {
		const plan = planReplacements(
			report([check("stale", A, B), check("correct", A, A)]),
			`"${A}"`,
		);
		expect(plan).toMatchObject({ ok: false, code: EXIT.AMBIGUOUS });
		if (plan.ok) throw new Error("expected refusal");
		expect(plan.reasons.join(" ")).toContain("would clobber it");
	});

	test("refuses non-digest mismatches as a human's problem", () => {
		const plan = planReplacements(
			report([check("twin.host", "mac", "linux")]),
			'const host = "mac";',
		);
		expect(plan).toMatchObject({ ok: false, code: EXIT.UNFIXABLE });
	});

	test("refuses structural mismatches no substitution can fix", () => {
		const plan = planReplacements(
			report([check("x", A, B)], ["X_SHA256S: length 3 != X_BYTES length 4"]),
			`"${A}"`,
		);
		expect(plan).toMatchObject({ ok: false, code: EXIT.UNFIXABLE });
	});
});

describe("applyReplacements", () => {
	test("replaces every occurrence and leaves untouched digests alone", () => {
		const source = `["${A}", "${C}", "${A}"]`;
		const { text, applied } = applyReplacements(source, [
			{ old: A, next: B, occurrences: 2, labels: ["x"] },
		]);
		expect(text).toBe(`["${B}", "${C}", "${B}"]`);
		expect(applied.get(A)).toBe(2);
	});

	test("never rewrites a 64-hex run embedded in a longer hex literal", () => {
		const source = `"ff${A}" "${A}"`;
		const { text } = applyReplacements(source, [
			{ old: A, next: B, occurrences: 1, labels: ["x"] },
		]);
		expect(text).toBe(`"ff${A}" "${B}"`);
	});

	test("applies chained pairs atomically, without cascading", () => {
		const source = `"${A}" "${B}"`;
		const { text } = applyReplacements(source, [
			{ old: A, next: B, occurrences: 1, labels: ["x"] },
			{ old: B, next: C, occurrences: 1, labels: ["y"] },
		]);
		expect(text).toBe(`"${B}" "${C}"`);
	});
});

describe("auditApplication", () => {
	test("passes when every planned occurrence was rewritten", () => {
		const applied = new Map([[A, 2]]);
		expect(
			auditApplication(
				[{ old: A, next: B, occurrences: 2, labels: ["x"] }],
				applied,
			),
		).toEqual([]);
	});

	test("reports a short application rather than accepting it", () => {
		const applied = new Map([[A, 1]]);
		const problems = auditApplication(
			[{ old: A, next: B, occurrences: 2, labels: ["x"] }],
			applied,
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("expected 2 replacement(s)");
	});
});

describe("countDigestTokens", () => {
	test("counts whole tokens only", () => {
		const counts = countDigestTokens(`"${A}" "${A}" "ff${A}" "${A.slice(1)}"`);
		expect(counts.get(A)).toBe(2);
	});
});

describe("parseReport", () => {
	test("reads a verifier payload", () => {
		const parsed = parseReport(
			JSON.stringify({
				clean: false,
				mismatches: 1,
				checks: [check("x", A, B)],
				structural: [],
			}),
		);
		expect(parsed.clean).toBe(false);
		expect(parsed.checks).toHaveLength(1);
	});

	test("rejects a payload without checks", () => {
		expect(() => parseReport(JSON.stringify({ clean: true }))).toThrow();
	});
});

describe("makeStateGuard", () => {
	test("accepts new states and rejects a repeat", () => {
		const guard = makeStateGuard();
		expect(guard.record(A)).toBe(true);
		expect(guard.record(B)).toBe(true);
		expect(guard.record(A)).toBe(false);
	});
});
