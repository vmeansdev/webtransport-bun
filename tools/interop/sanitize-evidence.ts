#!/usr/bin/env bun

import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
	verifyEvidenceDocument,
	verifyInteropEvidenceDocument,
} from "./verify-evidence.ts";

const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

type EvidenceObject = Record<string, unknown>;

function normalizeCommand(value: string): string {
	return value
		.replace(
			/(['"])(\/(?:[^'"\\]|\\.)+|[A-Za-z]:[\\/](?:[^'"\\]|\\.)*)\1/g,
			"bun",
		)
		.replace(/(^|\s)(\/(?:\S+)|[A-Za-z]:[\\/](?:\S+))/g, "$1<redacted>");
}

function normalizeString(value: string, key: string): string {
	if (key === "configFile") return basename(value);
	if (key === "rootDir" || key === "testDir") return "tests";
	if (key === "outputDir") return "test-results";
	if (key === "cwd") return ".";
	if (key === "command") return normalizeCommand(value);
	return ABSOLUTE_PATH_PATTERN.test(value) ? "<redacted>" : value;
}

function sanitizeValue(value: unknown, key = ""): unknown {
	if (typeof value === "string") return normalizeString(value, key);
	if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
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
	if (
		document !== null &&
		typeof document === "object" &&
		!Array.isArray(document) &&
		"config" in document
	) {
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
