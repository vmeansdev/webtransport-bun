#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";

const ALLOWED_ENV_KEYS = new Set([
	"WT_IDLE_TIMEOUT_MS",
	"WT_QPACK_MAX_TABLE_CAPACITY",
	"WEBTRANSPORT_INTEROP_HOST",
	"WEBTRANSPORT_INTEROP_QUIC_PORT",
	"WEBTRANSPORT_INTEROP_HEALTH_PORT",
]);
const SECRET_KEY_PATTERN =
	/(token|api[_-]?key|secret|password|passwd|credential|auth|ssh|home|path|shell|user|codex|vscode|brew|java|gopath|goroot|tmpdir|pwd|oldpwd|socket)/i;
const SECRET_VALUE_PATTERN =
	/(^|\b)(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\b|$)/;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function fail(message: string): never {
	throw new Error(`unsafe interop evidence: ${message}`);
}

function inspectEnvironment(value: unknown): void {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return;
	for (const [key, entry] of Object.entries(value)) {
		if (!ALLOWED_ENV_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)) {
			fail(`unexpected environment key ${JSON.stringify(key)}`);
		}
		if (typeof entry !== "string") {
			fail(`environment value for ${JSON.stringify(key)} is not a string`);
		}
		if (ABSOLUTE_PATH_PATTERN.test(entry) || SECRET_VALUE_PATTERN.test(entry)) {
			fail(`unsafe environment value for ${JSON.stringify(key)}`);
		}
	}
}

export function verifyEvidenceDocument(document: unknown): void {
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

export function verifyEvidenceFile(path: string): void {
	if (!existsSync(path)) fail(`missing file ${JSON.stringify(path)}`);
	try {
		verifyEvidenceDocument(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if (error instanceof SyntaxError) fail("invalid JSON");
		throw error;
	}
}

if (import.meta.main) {
	const paths = Bun.argv.slice(2);
	if (paths.length === 0) {
		console.error("usage: bun run verify-evidence.ts <interop-json> [...]");
		process.exit(2);
	}
	for (const path of paths) verifyEvidenceFile(path);
	console.log(`validated ${paths.length} interop evidence file(s)`);
}
