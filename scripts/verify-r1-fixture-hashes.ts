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
	for (const suffix of ["_SHA256", "_EXPECTED_SHA256"]) {
		const single = exportsMap[`${base}${suffix}`];
		if (typeof single === "string" && value instanceof Uint8Array) {
			report(`${base}${suffix}`, single, sha(value));
		}
		const plural = exportsMap[`${base}${suffix}S`];
		if (
			Array.isArray(plural) &&
			Array.isArray(value) &&
			plural.length === value.length
		) {
			for (const [index, bytes] of value.entries()) {
				if (bytes instanceof Uint8Array) {
					report(
						`${base}${suffix}S[${index}]`,
						plural[index] as string,
						sha(bytes),
					);
				}
			}
		}
	}
}

// The campaign-lock closure keeps an independently WRITTEN literal twin of
// the derived attestation ("the fixture cannot silently inherit a
// self-derived lock/capability digest"). Independent means separately
// spelled, not divergent: every string field must agree with the derived
// object, the manifest's frozen parent links must equal the frozen authority
// digests, and the final descriptor digest must equal the attestation bytes.
const walkStrings = (
	path: string,
	frozen: unknown,
	computed: unknown,
): void => {
	if (typeof frozen === "string" && typeof computed === "string") {
		report(path, frozen, computed);
		return;
	}
	if (
		frozen &&
		computed &&
		typeof frozen === "object" &&
		typeof computed === "object"
	) {
		const keys = new Set([
			...Object.keys(frozen as object),
			...Object.keys(computed as object),
		]);
		for (const key of keys) {
			walkStrings(
				`${path}.${key}`,
				(frozen as Record<string, unknown>)[key],
				(computed as Record<string, unknown>)[key],
			);
		}
	}
};
walkStrings(
	"observedAttestationTwin",
	exportsMap.R1_CAMPAIGN_LOCK_OBSERVED_ATTESTATION,
	exportsMap.R1_OBSERVED_ATTESTATION_V1,
);
const PARENT_LINKS: Record<string, string> = {
	authoritySha256: (exportsMap.R1_CAMPAIGN_AUTHORITY_SHA256 as string) ?? "",
	lockSha256: (exportsMap.R1_CAMPAIGN_LOCK_SHA256 as string) ?? "",
	capabilitySha256: (exportsMap.R1_STAGED_CAPABILITY_V1_SHA256 as string) ?? "",
};
const walkParentLinks = (path: string, node: unknown): void => {
	if (!node || typeof node !== "object") return;
	for (const [key, value] of Object.entries(node as object)) {
		if (typeof value === "string" && key in PARENT_LINKS) {
			report(`${path}.${key}`, value, PARENT_LINKS[key] as string);
		} else {
			walkParentLinks(`${path}.${key}`, value);
		}
	}
};
walkParentLinks("manifest", exportsMap.R1_CAMPAIGN_MANIFEST_V1);
const manifest = exportsMap.R1_CAMPAIGN_MANIFEST_V1 as {
	descriptors?: { sha256?: string }[];
};
report(
	"manifest.lastDescriptor.sha256",
	manifest.descriptors?.at(-1)?.sha256 ?? "",
	sha(exportsMap.R1_OBSERVED_ATTESTATION_V1_BYTES as Uint8Array),
);

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
