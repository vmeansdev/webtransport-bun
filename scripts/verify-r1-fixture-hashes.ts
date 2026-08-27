/**
 * Task A maintenance tool (not part of the RED bundle): verifies every
 * `<NAME>_BYTES` / `<NAME>_SHA256[S]` export pair in r1-fixtures.ts, plus the
 * known cross-field digest relations, and prints stale→computed hex pairs so
 * the frozen literals can be realigned after a deliberate fixture change.
 * Exits 1 while any mismatch remains.
 *
 * `--json` prints the verdict as one machine-readable object instead of human
 * lines, so converge-r1-fixture-hashes.ts can drive the realignment loop
 * without scraping prose. The JSON carries *every* check, not just the failing
 * ones: a driver needs the passing computed values to prove that a global
 * digest substitution will not clobber a location that is already correct.
 * `structural` holds the mismatches no substitution can fix (array-length
 * drift, twin type asymmetry).
 */
import { createHash } from "node:crypto";
import * as fx from "../tools/compare/r1-fixtures.ts";

const sha = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

const asJson = process.argv.includes("--json");
const lines: string[] = [];
const checks: {
	label: string;
	frozen: string;
	computed: string;
	ok: boolean;
}[] = [];
const structural: string[] = [];

let mismatches = 0;
const report = (label: string, frozen: string, computed: string): void => {
	const ok = frozen === computed;
	checks.push({ label, frozen, computed, ok });
	if (!ok) {
		mismatches += 1;
		lines.push(`FIX ${label}: ${frozen} -> ${computed}`);
	}
};
const reportStructural = (message: string): void => {
	mismatches += 1;
	structural.push(message);
	lines.push(`FIX ${message}`);
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
		if (Array.isArray(plural) && Array.isArray(value)) {
			if (plural.length !== value.length) {
				reportStructural(
					`${base}${suffix}S: length ${plural.length} != ${base}_BYTES length ${value.length}`,
				);
				continue;
			}
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
	if (typeof frozen === "string" || typeof computed === "string") {
		reportStructural(
			`${path}: twin asymmetry (frozen=${typeof frozen}, computed=${typeof computed})`,
		);
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
// Every embedded digest link a canonical fixture carries must equal the
// computed canonical digest of its target — a stale literal anywhere in the
// digest DAG must be caught mechanically, not by review.
const canonical = (value: unknown): string => sha(fx.canonicalBytes(value));
const submissionShas = (fx.R1_HOST_SUBMISSION_BYTES as Uint8Array[]).map(sha);
const provenanceShas = (fx.R1_HOST_LAUNCH_PROVENANCE_BYTES as Uint8Array[]).map(
	sha,
);
const runtimeFactsShas = (fx.R1_HOST_RUNTIME_FACTS_BYTES as Uint8Array[]).map(
	sha,
);
const stagedReceiptShas = (
	fx.R1_STAGED_ARCHIVE_RECEIPTS as unknown as unknown[]
).map(canonical);
const PARENT_LINKS: Record<string, string> = {
	authoritySha256: sha(fx.R1_CAMPAIGN_AUTHORITY_BYTES),
	lockSha256: sha(fx.R1_CAMPAIGN_LOCK_BYTES),
	capabilitySha256: sha(fx.R1_STAGED_CAPABILITY_V1_BYTES),
	manifestSha256: sha(fx.R1_CAMPAIGN_MANIFEST_V1_BYTES),
	campaignReservationSha256: sha(fx.R1_CAMPAIGN_RESERVATION_BYTES),
	sourceArchiveReceiptSha256: sha(fx.R1_SOURCE_ARCHIVE_RECEIPT_BYTES),
	r1RedApprovalBundleSha256: sha(fx.R1_RED_APPROVAL_BUNDLE_BYTES),
	sshHostReceiptSha256: sha(fx.R1_SSH_HOST_RECEIPT_BYTES),
	macHostSubmissionSha256: submissionShas[0] ?? "",
	linuxHostSubmissionSha256: submissionShas[1] ?? "",
	macLaunchProvenanceSha256: provenanceShas[0] ?? "",
	linuxLaunchProvenanceSha256: provenanceShas[1] ?? "",
	macRuntimeFactsSha256: runtimeFactsShas[0] ?? "",
	linuxRuntimeFactsSha256: runtimeFactsShas[1] ?? "",
	macStagedArchiveReceiptSha256: stagedReceiptShas[0] ?? "",
	linuxStagedArchiveReceiptSha256: stagedReceiptShas[1] ?? "",
};
const walkParentLinks = (
	path: string,
	node: unknown,
	links: Record<string, string>,
): void => {
	if (!node || typeof node !== "object") return;
	for (const [key, value] of Object.entries(node as object)) {
		if (typeof value === "string" && key in links) {
			report(`${path}.${key}`, value, links[key] as string);
			continue;
		}
		// An object embedded next to a `<name>Sha256` claim must hash to that
		// claim (host submissions embed stagedArchiveReceipt, launchProvenance,
		// and runtimeFacts this way).
		if (typeof value === "string" && key.endsWith("Sha256")) {
			const sibling = (node as Record<string, unknown>)[key.slice(0, -6)];
			if (sibling && typeof sibling === "object") {
				report(`${path}.${key}`, value, canonical(sibling));
			}
			continue;
		}
		walkParentLinks(`${path}.${key}`, value, links);
	}
};
const CANONICAL_LINK_ROOTS = [
	"R1_CAMPAIGN_AUTHORITY",
	"R1_EXACT_APPROVAL_EXPECTED_INPUTS",
	"R1_HOST_LAUNCH_PROVENANCE",
	"R1_HOST_SUBMISSIONS",
	"R1_CAMPAIGN_LOCK",
	"R1_STAGED_CAPABILITY_V1",
	"R1_CAMPAIGN_MANIFEST_V1",
	"R1_OBSERVED_ATTESTATION_V1",
	"R1_CAMPAIGN_VERIFIER_RESULT_V1",
	"R1_CAMPAIGN_REPORT_V1",
] as const;
for (const rootName of CANONICAL_LINK_ROOTS) {
	walkParentLinks(rootName, exportsMap[rootName], PARENT_LINKS);
}
// Host-indexed fixtures carry the same links under unprefixed keys.
for (const [index, host] of ["mac", "linux"].entries()) {
	const hostLinks: Record<string, string> = {
		stagedArchiveReceiptSha256: stagedReceiptShas[index] ?? "",
		launchProvenanceSha256: provenanceShas[index] ?? "",
		runtimeFactsSha256: runtimeFactsShas[index] ?? "",
	};
	walkParentLinks(
		`R1_HOST_SUBMISSIONS[${host}]`,
		(fx.R1_HOST_SUBMISSIONS as unknown as unknown[])[index],
		{ ...PARENT_LINKS, ...hostLinks },
	);
	walkParentLinks(
		`R1_HOST_LAUNCH_PROVENANCE[${host}]`,
		(fx.R1_HOST_LAUNCH_PROVENANCE as unknown as unknown[])[index],
		{ ...PARENT_LINKS, ...hostLinks },
	);
}
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

if (asJson) {
	console.log(
		JSON.stringify({
			schema: "r1-fixture-hashes/1",
			clean: mismatches === 0,
			mismatches,
			checks,
			structural,
		}),
	);
} else {
	for (const line of lines) console.log(line);
	console.log(
		mismatches === 0 ? "fixture hashes: CLEAN" : `${mismatches} mismatches`,
	);
}
process.exit(mismatches === 0 ? 0 : 1);
