#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type ClaimStatus = "passed" | "pending" | "failed";
type Stability = "experimental" | "candidate" | "stable";

type EvidenceEntry = {
	id: string;
	path: string;
	commit: string;
	status: "passed" | "failed";
};

type Claim = {
	id: string;
	surface: "native" | "wasm" | "release";
	status: ClaimStatus;
	evidenceIds: string[];
};

type Surface = {
	stability: Stability;
	requiredClaims: string[];
};

type SupportTuple = {
	runtime: string;
	os: string;
	arch: string;
	evidenceIds?: string[];
};

type ReleaseStatus = {
	schemaVersion: number;
	candidate: { commit: string | null; readiness: "pending" | "ready" };
	evidence: EvidenceEntry[];
	claims: Claim[];
	surfaces: { native: Surface; wasm: Surface };
	support: { claimed: SupportTuple[]; tested: SupportTuple[] };
};

const ROOT = resolve(
	process.env.CHECK_DOC_TRUTH_ROOT ?? resolve(import.meta.dir, ".."),
);
const STATUS_PATH = resolve(ROOT, "docs", "release-status.json");
const ARCHITECTURE_PATH = resolve(ROOT, "docs", "ARCHITECTURE.md");
const FAQ_PATH = resolve(ROOT, "docs", "FAQ.md");
const COMPATIBILITY_PATH = resolve(ROOT, "docs", "COMPATIBILITY.md");
const CI_PATH = resolve(ROOT, "docs", "CI.md");
const RELEASE_CHECKLIST_PATH = resolve(ROOT, "docs", "RELEASE_CHECKLIST.md");
const ROOT_README_PATH = resolve(ROOT, "README.md");
const PACKAGE_README_PATH = resolve(
	ROOT,
	"packages",
	"webtransport",
	"README.md",
);
const HISTORICAL_HARDENING_PLAN_PATH = resolve(
	ROOT,
	"docs",
	"RELEASE_1.0_HARDENING_PLAN.md",
);
const RUNTIME_SOURCE_PATH = resolve(ROOT, "crates", "native", "src", "lib.rs");
const SHA40 = /^[0-9a-f]{40}$/;
const EXACT_CONSTRUCTOR = "Builder::new_multi_thread().worker_threads(1)";

type Violation = { location: string; message: string };
const violations: Violation[] = [];

function report(location: string, message: string): void {
	violations.push({ location, message });
}

function readText(path: string): string | undefined {
	if (!existsSync(path)) {
		report(
			relative(ROOT, path),
			"required documentation-truth input is missing",
		);
		return undefined;
	}
	return readFileSync(path, "utf8");
}

function readStatus(): ReleaseStatus | undefined {
	const text = readText(STATUS_PATH);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as ReleaseStatus;
	} catch (error) {
		report(
			relative(ROOT, STATUS_PATH),
			`must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function asArray<T>(value: unknown, location: string): T[] {
	if (!Array.isArray(value)) {
		report(location, "must be an array");
		return [];
	}
	return value as T[];
}

function artifactCommit(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["commit", "sourceCommit", "candidateCommit"]) {
		if (typeof record[key] === "string") return record[key];
	}
	return undefined;
}

function checkEvidence(status: ReleaseStatus): Map<string, EvidenceEntry> {
	const evidence = new Map<string, EvidenceEntry>();
	for (const [index, entry] of asArray<EvidenceEntry>(
		status.evidence,
		"release-status.evidence",
	).entries()) {
		const location = `release-status.evidence[${index}]`;
		if (!entry || typeof entry !== "object") {
			report(location, "must be an object");
			continue;
		}
		if (typeof entry.id !== "string" || entry.id.length === 0) {
			report(location, "must have a non-empty id");
			continue;
		}
		if (evidence.has(entry.id)) {
			report(location, `duplicates evidence id ${entry.id}`);
			continue;
		}
		evidence.set(entry.id, entry);
		if (entry.status !== "passed" && entry.status !== "failed") {
			report(location, "status must be passed or failed");
			continue;
		}
		if (entry.status !== "passed") continue;

		if (!status.candidate?.commit || !SHA40.test(status.candidate.commit)) {
			report(
				location,
				"passed evidence requires a 40-character candidate commit",
			);
		}
		if (!SHA40.test(entry.commit ?? "")) {
			report(location, "passed evidence must name a 40-character commit");
		} else if (entry.commit !== status.candidate?.commit) {
			report(
				location,
				`evidence commit ${entry.commit} differs from candidate commit ${status.candidate?.commit ?? "<unbound>"}`,
			);
		}

		if (typeof entry.path !== "string" || entry.path.length === 0) {
			report(location, "passed evidence must name an artifact path");
			continue;
		}
		const artifactPath = resolve(ROOT, entry.path);
		if (
			isAbsolute(entry.path) ||
			relative(ROOT, artifactPath).startsWith("..")
		) {
			report(location, "evidence path must stay inside the repository root");
			continue;
		}
		const artifactText = readText(artifactPath);
		if (artifactText === undefined) continue;
		try {
			const commit = artifactCommit(JSON.parse(artifactText));
			if (!commit) {
				report(location, "evidence artifact has no commit identity");
			} else if (
				commit !== entry.commit ||
				commit !== status.candidate?.commit
			) {
				report(
					location,
					`evidence artifact commit ${commit} does not match manifest and candidate`,
				);
			}
		} catch (error) {
			report(
				location,
				`evidence artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return evidence;
}

function checkClaims(
	status: ReleaseStatus,
	evidence: Map<string, EvidenceEntry>,
): Map<string, Claim> {
	const claims = new Map<string, Claim>();
	for (const [index, claim] of asArray<Claim>(
		status.claims,
		"release-status.claims",
	).entries()) {
		const location = `release-status.claims[${index}]`;
		if (!claim || typeof claim !== "object" || !claim.id) {
			report(location, "must have a non-empty id");
			continue;
		}
		if (claims.has(claim.id))
			report(location, `duplicates claim id ${claim.id}`);
		claims.set(claim.id, claim);
		if (!(["native", "wasm", "release"] as const).includes(claim.surface)) {
			report(location, "surface must be native, wasm, or release");
		}
		if (!(["passed", "pending", "failed"] as const).includes(claim.status)) {
			report(location, "status must be passed, pending, or failed");
		}
		const evidenceIds = asArray<string>(
			claim.evidenceIds,
			`${location}.evidenceIds`,
		);
		if (claim.status === "passed" && evidenceIds.length === 0) {
			report(location, "passed status claim has no evidence ID");
		}
		for (const evidenceId of evidenceIds) {
			const entry = evidence.get(evidenceId);
			if (!entry)
				report(location, `references unknown evidence ID ${evidenceId}`);
			else if (claim.status === "passed" && entry.status !== "passed") {
				report(
					location,
					`passed claim references non-passing evidence ${evidenceId}`,
				);
			}
		}
	}
	return claims;
}

function checkSurfaces(
	status: ReleaseStatus,
	claims: Map<string, Claim>,
): void {
	for (const name of ["native", "wasm"] as const) {
		const surface = status.surfaces?.[name];
		const location = `release-status.surfaces.${name}`;
		if (!surface) {
			report(location, "surface declaration is missing");
			continue;
		}
		if (
			!(["experimental", "candidate", "stable"] as readonly unknown[]).includes(
				surface.stability,
			)
		) {
			report(location, "stability must be experimental, candidate, or stable");
		}
		const required = asArray<string>(
			surface.requiredClaims,
			`${location}.requiredClaims`,
		);
		if (surface.stability === "stable") {
			if (required.length === 0) {
				report(location, `${name} cannot be stable without required gates`);
			}
			for (const claimId of required) {
				const claim = claims.get(claimId);
				if (!claim || claim.surface !== name || claim.status !== "passed") {
					report(
						location,
						`${name} is called stable before required gate ${claimId} passes`,
					);
				}
			}
		}
	}
}

function supportKey(entry: SupportTuple): string {
	return `${entry.runtime}\u0000${entry.os}\u0000${entry.arch}`;
}

function checkSupport(
	status: ReleaseStatus,
	evidence: Map<string, EvidenceEntry>,
): void {
	const tested = new Map<string, SupportTuple>();
	for (const [index, entry] of asArray<SupportTuple>(
		status.support?.tested,
		"release-status.support.tested",
	).entries()) {
		const location = `release-status.support.tested[${index}]`;
		if (!entry?.runtime || !entry.os || !entry.arch) {
			report(location, "tested support tuple requires runtime, os, and arch");
			continue;
		}
		const ids = asArray<string>(entry.evidenceIds, `${location}.evidenceIds`);
		if (ids.length === 0) {
			report(location, "tested support tuple has no evidence ID");
			continue;
		}
		if (ids.every((id) => evidence.get(id)?.status === "passed")) {
			tested.set(supportKey(entry), entry);
		} else {
			report(location, "tested support tuple lacks passing evidence");
		}
	}

	for (const [index, entry] of asArray<SupportTuple>(
		status.support?.claimed,
		"release-status.support.claimed",
	).entries()) {
		const location = `release-status.support.claimed[${index}]`;
		if (!entry?.runtime || !entry.os || !entry.arch) {
			report(location, "support claim requires runtime, os, and arch");
			continue;
		}
		if (!tested.has(supportKey(entry))) {
			report(
				location,
				`support table exceeds tested matrix at ${entry.runtime}/${entry.os}/${entry.arch}`,
			);
		}
	}
}

function runtimeBlock(
	source: string,
	name: "RUNTIME" | "CLIENT_RUNTIME",
): string {
	const start = source.indexOf(`static ${name}:`);
	if (start < 0) return "";
	const end = source.indexOf("\n});", start);
	return source.slice(start, end < 0 ? source.length : end + 4);
}

function checkRuntimeContract(): void {
	const architecture = readText(ARCHITECTURE_PATH);
	const source = readText(RUNTIME_SOURCE_PATH);
	if (architecture === undefined || source === undefined) return;
	if (!architecture.includes(EXACT_CONSTRUCTOR)) {
		report(
			relative(ROOT, ARCHITECTURE_PATH),
			`must state the exact runtime constructor ${EXACT_CONSTRUCTOR}`,
		);
	}
	for (const [name, threadName] of [
		["RUNTIME", "wt-server"],
		["CLIENT_RUNTIME", "wt-client"],
	] as const) {
		const block = runtimeBlock(source, name);
		if (!block) {
			report(relative(ROOT, RUNTIME_SOURCE_PATH), `missing ${name} runtime`);
			continue;
		}
		if (
			!/Builder::new_multi_thread\(\)\s*\.worker_threads\(1\)/s.test(block) ||
			block.includes("new_current_thread")
		) {
			report(
				relative(ROOT, RUNTIME_SOURCE_PATH),
				`${name} contradicts ${EXACT_CONSTRUCTOR}`,
			);
		}
		if (!block.includes(`.thread_name("${threadName}")`)) {
			report(
				relative(ROOT, RUNTIME_SOURCE_PATH),
				`${name} must retain dedicated thread name ${threadName}`,
			);
		}
	}
}

function checkNarrativeStatusTruth(): void {
	const faq = readText(FAQ_PATH);
	if (faq !== undefined) {
		if (/zero known P[0-4]/i.test(faq)) {
			report(
				relative(ROOT, FAQ_PATH),
				"must not claim zero known P-level findings outside the commit-bound review manifest",
			);
		}
		if (!faq.includes("docs/release-status.json")) {
			report(
				relative(ROOT, FAQ_PATH),
				"production-readiness answer must defer to docs/release-status.json",
			);
		}
	}

	const historicalPlan = readText(HISTORICAL_HARDENING_PLAN_PATH);
	if (historicalPlan !== undefined) {
		if (!historicalPlan.includes("Historical plan (superseded)")) {
			report(
				relative(ROOT, HISTORICAL_HARDENING_PLAN_PATH),
				"superseded native-only plan must carry an explicit historical banner",
			);
		}
		if (!historicalPlan.includes("docs/release-status.json")) {
			report(
				relative(ROOT, HISTORICAL_HARDENING_PLAN_PATH),
				"superseded plan must point to the canonical current status",
			);
		}
	}

	const compatibility = readText(COMPATIBILITY_PATH);
	if (compatibility !== undefined) {
		if (!compatibility.includes("configured 1.0 release targets")) {
			report(
				relative(ROOT, COMPATIBILITY_PATH),
				"compatibility matrices must identify themselves as configured release targets",
			);
		}
		if (!compatibility.includes("docs/release-status.json")) {
			report(
				relative(ROOT, COMPATIBILITY_PATH),
				"compatibility policy must defer support claims to docs/release-status.json",
			);
		}
	}

	for (const path of [CI_PATH, RELEASE_CHECKLIST_PATH]) {
		const releaseDocs = readText(path);
		if (releaseDocs === undefined) continue;
		for (const requiredGate of ["fuzz", "package-consumers"]) {
			if (!releaseDocs.includes(requiredGate)) {
				report(
					relative(ROOT, path),
					`must name the release-blocking ${requiredGate} gate`,
				);
			}
		}
	}

	for (const [path, statusRef, requiredPhrases] of [
		[
			ROOT_README_PATH,
			"docs/release-status.json",
			[
				"candidate surfaces, not stable/GA",
				"Candidate support remains unclaimed",
				"Readiness remains pending",
			],
		],
		[
			PACKAGE_README_PATH,
			"../../docs/release-status.json",
			[
				"current candidate surface, not a stable/GA promise",
				"candidate targets, not current support claims",
				"Support is claimed only after",
			],
		],
	] as const) {
		const readme = readText(path);
		if (readme === undefined) continue;
		const location = relative(ROOT, path);
		if (!readme.includes(statusRef)) {
			report(
				location,
				`release-truth wording must defer support/readiness to ${statusRef}`,
			);
		}
		for (const phrase of requiredPhrases) {
			if (!readme.includes(phrase)) {
				report(location, `must include the release-truth phrase: ${phrase}`);
			}
		}
	}
}

const status = readStatus();
if (status) {
	if (status.schemaVersion !== 1) {
		report("release-status.schemaVersion", "must equal 1");
	}
	if (
		status.candidate?.readiness !== "pending" &&
		status.candidate?.readiness !== "ready"
	) {
		report("release-status.candidate.readiness", "must be pending or ready");
	}
	if (
		status.candidate?.commit !== null &&
		!SHA40.test(status.candidate?.commit ?? "")
	) {
		report(
			"release-status.candidate.commit",
			"must be null or a 40-character commit",
		);
	}
	const evidence = checkEvidence(status);
	const claims = checkClaims(status, evidence);
	checkSurfaces(status, claims);
	checkSupport(status, evidence);
	if (status.candidate?.readiness === "ready") {
		if (!status.candidate.commit || !SHA40.test(status.candidate.commit)) {
			report(
				"release-status.candidate.readiness",
				"ready release must be bound to a 40-character commit",
			);
		}
		for (const claim of claims.values()) {
			if (claim.status !== "passed") {
				report(
					"release-status.candidate.readiness",
					`ready release still has non-passing claim ${claim.id}`,
				);
			}
		}
		const iwa = claims.get("iwa-direct-sockets");
		if (!iwa) {
			report(
				"release-status.candidate.readiness",
				"ready release requires the iwa-direct-sockets claim",
			);
		} else if (iwa.status !== "passed" || iwa.evidenceIds.length === 0) {
			report(
				"release-status.candidate.readiness",
				"ready release requires iwa-direct-sockets to be passed with commit-bound evidence (run-iwa.mjs / iwa.yml artifacts)",
			);
		} else {
			const bound = iwa.evidenceIds.some((id) => {
				const entry = evidence.get(id);
				return (
					entry?.status === "passed" &&
					entry.commit === status.candidate.commit &&
					typeof entry.path === "string" &&
					entry.path.length > 0
				);
			});
			if (!bound) {
				report(
					"release-status.candidate.readiness",
					"ready release requires iwa-direct-sockets evidence bound to the release commit",
				);
			}
		}
	}
}
checkRuntimeContract();
checkNarrativeStatusTruth();

if (violations.length > 0) {
	for (const violation of violations) {
		console.error(`${violation.location}: ${violation.message}`);
	}
	console.error(
		`documentation truth check failed (${violations.length} violation(s))`,
	);
	process.exit(1);
}

console.log("documentation truth check passed");
