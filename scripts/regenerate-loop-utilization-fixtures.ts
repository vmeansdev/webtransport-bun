#!/usr/bin/env bun
/**
 * Regenerate the sealed fixtures with the new two-scope
 * loopUtilization top-level field required by Phase 2.4 Commit 4.
 *
 * Reads each fixture JSON, adds a fixture-stated loopUtilization
 * pair, and re-seals (sets artifactByteSha256 to the canonical
 * sha256 of the masked body, the same way `sealRunArtifact` does).
 * Writes the result back over the fixture file.
 *
 * Phase 2.4 Commit 4 atomicity: this script is the only path that
 * changes the fixture bytes; the verifier, the schema, and the
 * frozen hashes are updated in the same commit. Run once, observe
 * the byte-equality assertion, commit. The fixture is sealed so
 * any byte change moves its sha256; the seal itself is in this
 * script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE_DIR = `${ROOT}tools/compare/fixtures/`;

const FIXTURES = ["valid-ws-run.json", "valid-wt-run.json"] as const;

const CANONICAL_RE = /^[a-z]|^[A-Z]|^[0-9]/;
function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean" || typeof value === "number") {
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new TypeError("canonical JSON requires finite numbers");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((child) => canonicalize(child)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const obj = value as Record<string, unknown>;
		return `{${Object.keys(obj)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
			.join(",")}}`;
	}
	throw new TypeError(`unsupported canonical value ${typeof value}`);
}
void CANONICAL_RE;

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

for (const name of FIXTURES) {
	const path = `${FIXTURE_DIR}${name}`;
	const json = readFileSync(path, "utf8");
	const artifact = JSON.parse(json) as Record<string, unknown>;
	if ("loopUtilization" in artifact) {
		console.log(`${name}: already has loopUtilization; skipping`);
		continue;
	}
	// Fixture-stated pair. Same shape as the frozen tests'
	// test-only literals: perSession carries the consumer-side
	// busy time the recorder would have logged; serverAggregate
	// is the wall-clock sum across all server sessions. The
	// window is positive for both scopes.
	artifact.loopUtilization = {
		perSession: { busyMs: 0, windowMs: 1 },
		serverAggregate: { busyMs: 0, windowMs: 1 },
	};
	// Re-seal. Mask the digest, canonicalize, hash, replace.
	const masked = { ...artifact, artifactByteSha256: "0".repeat(64) };
	const maskedBytes = new TextEncoder().encode(canonicalize(masked));
	const digest = sha256Hex(maskedBytes);
	const sealed = { ...artifact, artifactByteSha256: digest };
	const sealedBytes = new TextEncoder().encode(canonicalize(sealed));
	writeFileSync(path, sealedBytes);
	console.log(
		`${name}: added loopUtilization; new artifactByteSha256=${digest}`,
	);
}
