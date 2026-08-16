#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import {
	ABSOLUTE_PATH_PATTERN,
	ENV_SECRET_KEY_PATTERN,
	findPrivacyViolations,
	unsafeStringReason,
} from "./evidence-privacy.ts";

// Kept deliberately in step with `SERVER_ENV_KEYS` in `web-server-env.ts`:
// that list decides what reaches the interop server, this one decides what may
// appear in published evidence. `security-evidence.test.ts` pins both halves.
const ALLOWED_ENV_KEYS = new Set([
	"WT_IDLE_TIMEOUT_MS",
	"WT_QPACK_MAX_TABLE_CAPACITY",
	"WEBTRANSPORT_INTEROP_HOST",
	"WEBTRANSPORT_INTEROP_QUIC_PORT",
	"WEBTRANSPORT_INTEROP_HEALTH_PORT",
	"WEBTRANSPORT_DATAGRAM_BATCH",
]);

function fail(message: string): never {
	throw new Error(`unsafe interop evidence: ${message}`);
}

function inspectEnvironment(value: unknown): void {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return;
	for (const [key, entry] of Object.entries(value)) {
		if (!ALLOWED_ENV_KEYS.has(key) || ENV_SECRET_KEY_PATTERN.test(key)) {
			fail(`unexpected environment key ${JSON.stringify(key)}`);
		}
		if (typeof entry !== "string") {
			fail(`environment value for ${JSON.stringify(key)} is not a string`);
		}
		if (ABSOLUTE_PATH_PATTERN.test(entry) || unsafeStringReason(entry)) {
			fail(`unsafe environment value for ${JSON.stringify(key)}`);
		}
	}
}

/**
 * Schema-independent privacy gate. Applies to every published evidence
 * document, whatever its shape. Diagnostics carry JSON pointers only, never the
 * rejected value.
 */
export function verifyDocumentPrivacy(document: unknown): void {
	const violations = findPrivacyViolations(document);
	if (violations.length === 0) return;
	const shown = violations
		.slice(0, 10)
		.map((violation) => `${violation.pointer}: ${violation.reason}`);
	const suffix =
		violations.length > shown.length
			? ` (+${violations.length - shown.length} more)`
			: "";
	fail(
		`${violations.length} privacy violation(s): ${shown.join("; ")}${suffix}`,
	);
}

/** Interop-report-only structure check: the Playwright web server environment
 * must contain exactly the documented server knobs. */
export function verifyInteropSchema(document: unknown): void {
	if (document === null || typeof document !== "object") {
		fail("document is not an object");
	}
	const config = (document as { config?: unknown }).config;
	if (config === null || typeof config !== "object") {
		fail("missing config");
	}
	const webServer = (config as { webServer?: unknown }).webServer;
	if (webServer === null || typeof webServer !== "object") {
		fail("missing webServer config");
	}
	inspectEnvironment((webServer as { env?: unknown }).env);
}

export function verifyEvidenceDocument(document: unknown): void {
	verifyDocumentPrivacy(document);
	verifyInteropSchema(document);
}

/** The one case `h7-datagram-batch.pw.ts` is allowed to declare. */
export const H7_TEST_TITLE =
	"H7 batch=4 delivers a unique bounded Chromium burst";

function h7Fail(message: string): never {
	throw new Error(`unusable H7 playwright report: ${message}`);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		h7Fail(`${what} is not an object`);
	return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) h7Fail(`${what} is not an array`);
	return value;
}

/** Playwright nests suites arbitrarily deep; a case skipped at suite level is
 * still discovered, so every level has to be collected before counting. */
function collectSpecs(suites: unknown, into: Record<string, unknown>[]): void {
	for (const [index, entry] of asArray(suites, "suites").entries()) {
		const suite = asObject(entry, `suites[${index}]`);
		if (suite.specs !== undefined) {
			for (const [specIndex, spec] of asArray(
				suite.specs,
				`suites[${index}].specs`,
			).entries()) {
				into.push(asObject(spec, `suites[${index}].specs[${specIndex}]`));
			}
		}
		if (suite.suites !== undefined) collectSpecs(suite.suites, into);
	}
}

function requireCount(
	stats: Record<string, unknown>,
	field: string,
	want: number,
): void {
	if (stats[field] !== want)
		h7Fail(
			`stats.${field} is ${JSON.stringify(stats[field])}, expected ${want}`,
		);
}

/**
 * Structural proof that the H7 Chromium case actually ran and passed. The
 * source scan in `security-evidence.test.ts` only stops the file from asking to
 * be skipped; this reporter check is the authoritative executed/skipped count,
 * because a suite-level or runtime skip never shows up in the source at all.
 */
export function verifyH7PlaywrightReport(document: unknown): void {
	const report = asObject(document, "report");

	const errors = asArray(report.errors ?? [], "errors");
	if (errors.length > 0) h7Fail(`reporter recorded ${errors.length} errors`);

	const specs: Record<string, unknown>[] = [];
	collectSpecs(report.suites, specs);
	if (specs.length !== 1)
		h7Fail(`expected exactly one test case, found ${specs.length}`);
	const spec = specs[0] as Record<string, unknown>;

	if (spec.title !== H7_TEST_TITLE)
		h7Fail(
			`test case title is ${JSON.stringify(spec.title)}, expected ${JSON.stringify(H7_TEST_TITLE)}`,
		);
	if (spec.ok !== true) h7Fail(`test case ok is ${JSON.stringify(spec.ok)}`);

	const tests = asArray(spec.tests, "specs[0].tests");
	if (tests.length !== 1)
		h7Fail(`expected exactly one executed test entry, found ${tests.length}`);
	const test = asObject(tests[0], "specs[0].tests[0]");
	if (test.status !== "expected")
		h7Fail(
			`test status is ${JSON.stringify(test.status)}, expected "expected"`,
		);

	const results = asArray(test.results, "specs[0].tests[0].results");
	if (results.length !== 1)
		h7Fail(`expected exactly one executed result, found ${results.length}`);
	const result = asObject(results[0], "specs[0].tests[0].results[0]");
	if (result.status !== "passed")
		h7Fail(
			`result status is ${JSON.stringify(result.status)}, expected "passed"`,
		);

	const stats = asObject(report.stats, "stats");
	requireCount(stats, "expected", 1);
	requireCount(stats, "skipped", 0);
	requireCount(stats, "unexpected", 0);
	requireCount(stats, "flaky", 0);
}

export function verifyH7PlaywrightReportFile(path: string): void {
	if (!existsSync(path)) h7Fail(`missing file ${JSON.stringify(path)}`);
	let document: unknown;
	try {
		document = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) h7Fail("invalid JSON");
		throw error;
	}
	// The published report must clear the same privacy bar as any other
	// evidence document before its contents are trusted.
	verifyDocumentPrivacy(document);
	verifyInteropSchema(document);
	verifyH7PlaywrightReport(document);
}

export type EvidenceMode = "interop" | "privacy-only" | "auto";

/**
 * A Playwright interop report always carries a top-level `config` object;
 * summary records such as the functional-readiness document never do. Only the
 * former gets the interop schema check.
 */
export function isInteropReport(document: unknown): boolean {
	if (document === null || typeof document !== "object") return false;
	const config = (document as { config?: unknown }).config;
	return config !== null && typeof config === "object";
}

export function verifyEvidenceFile(
	path: string,
	mode: EvidenceMode = "auto",
): void {
	if (!existsSync(path)) fail(`missing file ${JSON.stringify(path)}`);
	let document: unknown;
	try {
		document = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) fail("invalid JSON");
		throw error;
	}
	try {
		verifyDocumentPrivacy(document);
		if (mode === "interop" || (mode === "auto" && isInteropReport(document)))
			verifyInteropSchema(document);
	} catch (error) {
		const reason = (
			error instanceof Error ? error.message : String(error)
		).replace(/^unsafe interop evidence: /, "");
		fail(`${JSON.stringify(path)}: ${reason}`);
	}
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	if (argv[0] === "verify-h7-playwright-report") {
		const [, ...reports] = argv;
		if (reports.length !== 1) {
			console.error(
				"usage: bun run verify-evidence.ts verify-h7-playwright-report <json>",
			);
			process.exit(2);
		}
		verifyH7PlaywrightReportFile(reports[0] as string);
		console.log(`H7 playwright report verified: 1 case, 1 passed, 0 skipped`);
		process.exit(0);
	}
	let mode: EvidenceMode = "auto";
	const paths: string[] = [];
	for (const arg of argv) {
		if (arg === "--privacy-only") mode = "privacy-only";
		else if (arg === "--interop") mode = "interop";
		else if (arg === "--auto") mode = "auto";
		else paths.push(arg);
	}
	if (paths.length === 0) {
		console.error(
			"usage: bun run verify-evidence.ts [--auto|--interop|--privacy-only] <json> [...]",
		);
		process.exit(2);
	}
	for (const path of paths) verifyEvidenceFile(path, mode);
	console.log(`validated ${paths.length} evidence file(s) [${mode}]`);
}
