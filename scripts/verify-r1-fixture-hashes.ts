/**
 * Task A maintenance tool (not part of the RED bundle): verifies every
 * `<NAME>_BYTES` / `<NAME>_SHA256[S]` export pair in r1-fixtures.ts, plus the
 * known cross-field digest relations, and prints stale→computed hex pairs so
 * the frozen literals can be realigned after a deliberate fixture change.
 * Exits 1 while any mismatch remains.
 */
import { createHash } from "node:crypto";
import * as fx from "../tools/compare/r1-fixtures.ts";

const sha = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

let mismatches = 0;
const report = (label: string, frozen: string, computed: string): void => {
	if (frozen !== computed) {
		mismatches += 1;
		console.log(`FIX ${label}: ${frozen} -> ${computed}`);
	}
};

const exportsMap = fx as Record<string, unknown>;
for (const [name, value] of Object.entries(exportsMap)) {
	if (!name.endsWith("_BYTES")) continue;
	const base = name.slice(0, -"_BYTES".length);
	const single = exportsMap[`${base}_SHA256`];
	const plural = exportsMap[`${base}_SHA256S`];
	if (typeof single === "string" && value instanceof Uint8Array) {
		report(`${base}_SHA256`, single, sha(value));
	}
	if (
		Array.isArray(plural) &&
		Array.isArray(value) &&
		plural.length === value.length
	) {
		for (const [index, bytes] of value.entries()) {
			if (bytes instanceof Uint8Array) {
				report(
					`${base}_SHA256S[${index}]`,
					plural[index] as string,
					sha(bytes),
				);
			}
		}
	}
}

// Cross-field relations the red tests freeze.
const approval = fx.R1_AUTHORITY_APPROVAL as unknown as Record<string, string>;
const recordShas = (fx.R1_EXACT_APPROVAL_RECORD_BYTES as Uint8Array[]).map(sha);
report(
	"R1_AUTHORITY_APPROVAL.finalArchitectApprovalSha256",
	approval.finalArchitectApprovalSha256 ?? "",
	recordShas[0] ?? "",
);
report(
	"R1_AUTHORITY_APPROVAL.finalCriticApprovalSha256",
	approval.finalCriticApprovalSha256 ?? "",
	recordShas[1] ?? "",
);
report(
	"R1_AUTHORITY_APPROVAL.finalVerifierApprovalSha256",
	approval.finalVerifierApprovalSha256 ?? "",
	recordShas[2] ?? "",
);

console.log(
	mismatches === 0 ? "fixture hashes: CLEAN" : `${mismatches} mismatches`,
);
process.exit(mismatches === 0 ? 0 : 1);
