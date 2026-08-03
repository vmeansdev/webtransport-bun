#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import {
	ABSOLUTE_PATH_PATTERN,
	ENV_SECRET_KEY_PATTERN,
	findPrivacyViolations,
	unsafeStringReason,
} from "./evidence-privacy.ts";

const ALLOWED_ENV_KEYS = new Set([
	"WT_IDLE_TIMEOUT_MS",
	"WT_QPACK_MAX_TABLE_CAPACITY",
	"WEBTRANSPORT_INTEROP_HOST",
	"WEBTRANSPORT_INTEROP_QUIC_PORT",
	"WEBTRANSPORT_INTEROP_HEALTH_PORT",
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
