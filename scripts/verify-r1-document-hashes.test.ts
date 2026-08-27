import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AUTHORITY_TEST,
	buildReport,
	collectSites,
	DOCUMENT_BINDINGS,
	type DocumentBinding,
	FIXTURES,
	ONLY_ENV,
	resolveOnly,
	sha256,
} from "./verify-r1-document-hashes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const hex = (seed: string): string =>
	seed.repeat(64).slice(0, 64).toLowerCase();

const RIGHT = hex("a1");
const WRONG = hex("b2");

const BINDING: DocumentBinding = {
	field: "amendmentSha256",
	document: "docs/amendment.md",
	sites: { "src/fixtures.ts": 2 },
};

const fixtureSource = (first: string, second: string): string =>
	`export const A = {\n\tamendmentSha256:\n\t\t"${first}",\n};\n` +
	`export const B = {\n\tamendmentSha256: "${second}",\n};\n`;

const inputs = (
	source: string,
	documentDigest: string | null = RIGHT,
): Parameters<typeof buildReport>[0] => ({
	documents: new Map([[BINDING.document, documentDigest]]),
	sources: new Map([["src/fixtures.ts", source]]),
	bindings: [BINDING],
});

describe("collectSites", () => {
	test("finds the value whether or not the formatter wrapped it", () => {
		const sites = collectSites(fixtureSource(RIGHT, WRONG), [
			"amendmentSha256",
		]);
		expect(sites).toEqual([
			{ field: "amendmentSha256", line: 3, digest: RIGHT },
			{ field: "amendmentSha256", line: 6, digest: WRONG },
		]);
	});

	test("reads the assertion spelling the frozen test uses", () => {
		const source = `expect(\n\trecord.amendmentSha256 ===\n\t\t"${RIGHT}",\n);\n`;
		expect(collectSites(source, ["amendmentSha256"])).toEqual([
			{ field: "amendmentSha256", line: 3, digest: RIGHT },
		]);
	});

	test("ignores a field it was not asked for", () => {
		expect(
			collectSites(fixtureSource(RIGHT, RIGHT), ["parentPlanSha256"]),
		).toEqual([]);
	});
});

describe("buildReport", () => {
	test("is clean when every site carries the document's real digest", () => {
		const report = buildReport(inputs(fixtureSource(RIGHT, RIGHT)));
		expect(report.clean).toBe(true);
		expect(report.mismatches).toBe(0);
		expect(report.checks).toHaveLength(2);
		expect(report.structural).toEqual([]);
	});

	// The point of the whole script: a drifted digest must be reported as an
	// old -> new pair, not silently tolerated.
	test("DETECTS a drifted digest and names the old -> new pair", () => {
		const report = buildReport(inputs(fixtureSource(RIGHT, WRONG)));
		expect(report.clean).toBe(false);
		expect(report.mismatches).toBe(1);
		const failing = report.checks.filter((check) => !check.ok);
		expect(failing).toHaveLength(1);
		expect(failing[0]).toMatchObject({
			label: "src/fixtures.ts:6 amendmentSha256",
			frozen: WRONG,
			computed: RIGHT,
		});
	});

	test("reports every drifted site, so a partial realignment cannot pass", () => {
		const report = buildReport(inputs(fixtureSource(WRONG, WRONG)));
		expect(report.mismatches).toBe(2);
		expect(report.checks.every((check) => !check.ok)).toBe(true);
	});

	// A verifier that only checks the sites it happens to find would go green
	// on a fixture that had stopped carrying the binding at all.
	test("a deleted site is structural, not a pass", () => {
		const source = `export const A = { amendmentSha256: "${RIGHT}" };\n`;
		const report = buildReport(inputs(source));
		expect(report.clean).toBe(false);
		expect(report.structural).toEqual([
			"src/fixtures.ts: found 1 amendmentSha256 site(s), expected 2",
		]);
		expect(report.checks).toEqual([]);
	});

	test("an added site is structural too", () => {
		const source = `${fixtureSource(RIGHT, RIGHT)}const C = { amendmentSha256: "${RIGHT}" };\n`;
		const report = buildReport(inputs(source));
		expect(report.structural).toEqual([
			"src/fixtures.ts: found 3 amendmentSha256 site(s), expected 2",
		]);
	});

	test("an unreadable document is structural", () => {
		const report = buildReport(inputs(fixtureSource(RIGHT, RIGHT), null));
		expect(report.clean).toBe(false);
		expect(report.structural).toEqual([
			"docs/amendment.md: document not readable, cannot produce amendmentSha256",
		]);
	});

	test("an unreadable source is structural", () => {
		const report = buildReport({
			documents: new Map([[BINDING.document, RIGHT]]),
			sources: new Map(),
			bindings: [BINDING],
		});
		expect(report.structural).toContain("src/fixtures.ts: source not readable");
	});

	test("--only scopes the report to one source, as a driver run needs", () => {
		const twoSources: DocumentBinding = {
			...BINDING,
			sites: { "src/fixtures.ts": 2, "src/red.test.ts": 1 },
		};
		const report = buildReport({
			documents: new Map([[BINDING.document, RIGHT]]),
			sources: new Map([
				["src/fixtures.ts", fixtureSource(RIGHT, RIGHT)],
				["src/red.test.ts", `amendmentSha256 === "${WRONG}"`],
			]),
			only: "src/fixtures.ts",
			bindings: [twoSources],
		});
		expect(report.clean).toBe(true);
		expect(
			report.checks.every((check) => check.label.startsWith("src/fixtures.ts")),
		).toBe(true);
	});
});

describe("the live tree", () => {
	const documents = new Map<string, string | null>(
		DOCUMENT_BINDINGS.map((binding) => [
			binding.document,
			sha256(readFileSync(join(ROOT, binding.document))),
		]),
	);
	const sources = new Map<string, string>([
		[FIXTURES, readFileSync(join(ROOT, FIXTURES), "utf8")],
		[AUTHORITY_TEST, readFileSync(join(ROOT, AUTHORITY_TEST), "utf8")],
	]);

	test("all fifteen frozen sites match their document on disk", () => {
		const report = buildReport({ documents, sources });
		expect(report.structural).toEqual([]);
		expect(report.checks).toHaveLength(15);
		expect(report.clean).toBe(true);
	});

	// The mutation run: perturb one real frozen byte and require the verifier
	// to name it. A verifier that cannot fail against the live tree is worthless.
	test("a one-character mutation of a real frozen digest is caught", () => {
		const amendment = DOCUMENT_BINDINGS.find(
			(binding) => binding.field === "amendmentSha256",
		) as DocumentBinding;
		const real = documents.get(amendment.document) as string;
		const mutated = `${real.slice(0, 63)}${real.endsWith("0") ? "1" : "0"}`;
		const report = buildReport({
			documents,
			sources: new Map([
				[FIXTURES, (sources.get(FIXTURES) as string).replace(real, mutated)],
				[AUTHORITY_TEST, sources.get(AUTHORITY_TEST) as string],
			]),
		});
		expect(report.clean).toBe(false);
		const failing = report.checks.filter((check) => !check.ok);
		expect(failing).toHaveLength(1);
		expect(failing[0]).toMatchObject({ frozen: mutated, computed: real });
		expect(failing[0]?.label).toContain("amendmentSha256");
	});

	// A document edit must move the digest; if it did not, the binding would be
	// decorative and round 8 could edit the amendment for free.
	test("editing the amendment document moves the digest it is bound to", () => {
		const amendment = DOCUMENT_BINDINGS.find(
			(binding) => binding.field === "amendmentSha256",
		) as DocumentBinding;
		const bytes = readFileSync(join(ROOT, amendment.document));
		const edited = createHash("sha256")
			.update(bytes)
			.update("\nAppended line.\n")
			.digest("hex");
		expect(edited).not.toBe(documents.get(amendment.document));
	});
});

describe("resolveOnly", () => {
	test("takes the scope from the environment, which is how the driver passes it", () => {
		expect(resolveOnly([], { [ONLY_ENV]: FIXTURES })).toEqual({
			only: FIXTURES,
		});
	});

	test("the flag wins over the environment", () => {
		expect(
			resolveOnly(["--only", AUTHORITY_TEST], { [ONLY_ENV]: FIXTURES }),
		).toEqual({ only: AUTHORITY_TEST });
	});

	test("an unscoped run reports every source", () => {
		expect(resolveOnly(["--json"], {})).toEqual({});
	});

	test("a flag with no value is an error, not a silent full run", () => {
		expect(resolveOnly(["--only", "--json"], {}).error).toBeTypeOf("string");
	});
});

describe("the driver contract", () => {
	// converge-r1-fixture-hashes.ts's parseReport requires exactly this shape.
	test("the report is the shape the convergence driver parses", () => {
		const report = buildReport(inputs(fixtureSource(RIGHT, WRONG)));
		const parsed: unknown = JSON.parse(JSON.stringify(report));
		expect(parsed).toBeTypeOf("object");
		const record = parsed as Record<string, unknown>;
		expect(Array.isArray(record.checks)).toBe(true);
		expect(Array.isArray(record.structural)).toBe(true);
		expect(record.clean).toBeTypeOf("boolean");
		expect(record.mismatches).toBeTypeOf("number");
		for (const check of record.checks as Record<string, unknown>[]) {
			expect(check.label).toBeTypeOf("string");
			expect(check.frozen).toBeTypeOf("string");
			expect(check.computed).toBeTypeOf("string");
			expect(check.ok).toBeTypeOf("boolean");
		}
	});
});
