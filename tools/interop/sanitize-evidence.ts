#!/usr/bin/env bun

import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
	isInteropEvidenceDocument,
	verifyEvidenceDocument,
	verifyInteropEvidenceDocument,
} from "./verify-evidence.ts";

const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const EMBEDDED_ABSOLUTE_PATH_PATTERN =
	/(^|[\s"'=(:,])((?:\/(?!\/)[^\s"'`,;\)\]]+|[A-Za-z]:[\\/][^\s"'`,;\)\]]+|\\\\[^\s"'`,;\)\]]+))/g;

type EvidenceObject = Record<string, unknown>;

function normalizeCommand(value: string): string {
	return value
		.replace(
			/(['"])(\/(?:[^'"\\]|\\.)+|[A-Za-z]:[\\/](?:[^'"\\]|\\.)*)\1/g,
			"bun",
		)
		.replace(EMBEDDED_ABSOLUTE_PATH_PATTERN, "$1<redacted>");
}

function redactEmbeddedPaths(value: string): string {
	return value.replace(EMBEDDED_ABSOLUTE_PATH_PATTERN, "$1<redacted>");
}

function normalizeString(value: string, key: string): string {
	if (key === "configFile") return basename(value);
	if (key === "rootDir" || key === "testDir") return "tests";
	if (key === "outputDir") return "test-results";
	if (key === "cwd") return ".";
	if (key === "command") return normalizeCommand(value);
	if (ABSOLUTE_PATH_PATTERN.test(value)) return "<redacted>";
	return redactEmbeddedPaths(value);
}

function sanitizeValue(value: unknown, key = ""): unknown {
	if (typeof value === "string") return normalizeString(value, key);
	if (Array.isArray(value))
		return value.map((entry) => sanitizeValue(entry, key));
	if (value === null || typeof value !== "object") return value;
	const sanitized: EvidenceObject = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		sanitized[childKey] = sanitizeValue(childValue, childKey);
	}
	return sanitized;
}

export function sanitizeEvidenceDocument(document: unknown): unknown {
	return sanitizeValue(document);
}

function validateDocument(document: unknown): void {
	verifyEvidenceDocument(document);
	if (isInteropEvidenceDocument(document)) {
		verifyInteropEvidenceDocument(document);
	}
}

function sanitizeFile(path: string): void {
	const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
	const sanitized = sanitizeEvidenceDocument(document);
	validateDocument(sanitized);
	writeFileSync(path, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
}

const paths = Bun.argv.slice(2);
if (import.meta.main) {
	if (paths.length === 0) {
		console.error("usage: bun run sanitize-evidence.ts <evidence-json> [...]");
		process.exit(2);
	}
	for (const path of paths) sanitizeFile(path);
	console.log(`sanitized ${paths.length} evidence file(s)`);
}
