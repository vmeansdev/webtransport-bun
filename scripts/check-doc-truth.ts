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
	/** When false, claim is tracked but does not block readiness=ready. Default true. */
	gaRequired?: boolean;
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

// CHECK_DOC_TRUTH_ROOT is a test-only seam (internal-doc-truth.test.ts points
// the checker at synthetic trees). Honoring it unconditionally would let a CI
// invocation silently validate a different tree, so it requires the explicit
// opt-in flag the test sets alongside it.
const rootOverride =
	process.env.CHECK_DOC_TRUTH_ROOT_UNSAFE_TEST_SEAM === "1"
		? process.env.CHECK_DOC_TRUTH_ROOT
		: undefined;
if (process.env.CHECK_DOC_TRUTH_ROOT && rootOverride === undefined) {
	console.error(
		"check-doc-truth: ignoring CHECK_DOC_TRUTH_ROOT (set CHECK_DOC_TRUTH_ROOT_UNSAFE_TEST_SEAM=1 to honor it in tests)",
	);
}
const ROOT = resolve(rootOverride ?? resolve(import.meta.dir, ".."));
const STATUS_PATH = resolve(ROOT, "docs", "release-status.json");
const ARCHITECTURE_PATH = resolve(ROOT, "docs", "ARCHITECTURE.md");
const FAQ_PATH = resolve(ROOT, "docs", "FAQ.md");
const COMPATIBILITY_PATH = resolve(ROOT, "docs", "COMPATIBILITY.md");
const CI_PATH = resolve(ROOT, "docs", "CI.md");
const RELEASE_CHECKLIST_PATH = resolve(ROOT, "docs", "RELEASE_CHECKLIST.md");
const LOAD_README_PATH = resolve(ROOT, "tools", "load", "README.md");
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
const SESSION_NAPI_SOURCE_PATH = resolve(
	ROOT,
	"crates",
	"native",
	"src",
	"session_napi.rs",
);
// Each runtime pins its own worker count. The server runs two as headroom on
// top of the delivery-path fix; the client is unmeasured and stays at one. See
// the threading-model section of docs/ARCHITECTURE.md.
//
// The server count is no longer a literal in the constructor: a measurement
// campaign needs to A/B another value, so it resolves through
// `server_worker_threads()`. Nothing is loosened by that — the pin moved to
// the resolver, which must still name 2 as the default, must still refuse to
// derive the count from the host, and must still bound the override. The
// client remains a hardcoded literal.
const RUNTIME_CONTRACTS = [
	{
		name: "RUNTIME",
		threadName: "wt-server",
		workers: 2,
		workerExpr: "server_worker_threads()",
	},
	{
		name: "CLIENT_RUNTIME",
		threadName: "wt-client",
		workers: 1,
		workerExpr: "1",
	},
] as const;

// `server_worker_threads()` is the only thing standing between the documented
// default and whatever the environment says, so pin its shape directly.
const SERVER_WORKERS_ENV = "WEBTRANSPORT_NATIVE_SERVER_WORKERS";
const SERVER_WORKERS_REQUIRED_SOURCE = [
	"pub(crate) const DEFAULT_SERVER_WORKER_THREADS: usize = 2;",
	`std::env::var("${SERVER_WORKERS_ENV}")`,
	"(1..=8).contains(&n)",
	"std::process::abort()",
] as const;

function exactConstructor(workers: number): string {
	return `Builder::new_multi_thread().worker_threads(${workers})`;
}
/**
 * The hosted H7 closure lane is a preregistered dispatch: every value below is
 * enforced somewhere in `.github/workflows/soak-long.yml`,
 * `scripts/validate-soak-inputs.sh`, or `verify-h7-hosted` in
 * `tools/load/soak-addon.ts`. Operator docs that disagree with these send a
 * dispatch the validator rejects, or worse, one it accepts for the wrong
 * workload, so all three carry the identical contract.
 */
const H7_REQUIRED_TEXT = [
	"H7 hosted closure lane",
	"duration_hours=2",
	"runner_type=self-hosted",
	"runner_mode=dedicated",
	"datagram_batch=64",
	"rss_ceiling_mb=1750",
	"soak-long-<campaign_seed>",
	"runner_profile=h7-fixed-large",
	"sessions=500",
	"datagrams_per_sec=500",
	"streams_per_sec=5",
	"at least 5 CPUs and 8 GiB",
	"fails closed rather than downscaling",
	"refs/tags/h7-batch-delivery-<candidate-sha>",
	"verify-h7-hosted",
	"does not replace the 24h/72h release soak",
] as const;
/**
 * Numeric dispatch parameters whose wrong value would send an operator into a
 * rejected — or worse, an accepted-but-mislabeled — run. Requiring the right
 * token is not enough: a doc can carry `datagram_batch=64` and offer
 * `datagram_batch=32` in the next sentence. Only these three are pinned this
 * way, because only these three appear as `name=value` dispatch inputs whose
 * value is fixed for the lane; `segment_count` legitimately varies (self-hosted
 * 1 versus GitHub-hosted 5/15). Prose about the ceiling clamp mentions 1024 as
 * a bare number rather than as `rss_ceiling_mb=1024`, so it does not trip.
 */
const H7_PINNED_VALUES = [
	["datagram_batch", "64"],
	["rss_ceiling_mb", "1750"],
	["sessions", "500"],
] as const;
/** Mode lists written before the 2-hour lane existed. */
const STALE_SOAK_MODE_LISTS = [
	"1h/24h/72h",
	"1h, 24h, 72h",
	"1h, 24h, or 72h",
] as const;
/** Self-hosted segmentation the workflow refuses; only `segment_count=1` runs. */
const STALE_SELF_HOSTED_SEGMENTATION = [
	"segment_count=4",
	"segment_count=12",
	"4x6h",
	"12x6h",
] as const;
const LOCAL_DIAGNOSTIC_MARKERS = [
	"soak.ts",
	"30-minute",
	"30 minutes",
	"nightly",
] as const;
const HOSTED_EVIDENCE_WORDS = [
	"H7",
	"release evidence",
	"soak-long evidence",
] as const;

type Violation = { location: string; message: string };
const violations: Violation[] = [];

function report(location: string, message: string): void {
	// Violation locations are repo-relative paths consumed by tests and CI
	// logs; keep them platform-stable (Windows `relative()` yields backslashes).
	violations.push({ location: location.replaceAll("\\", "/"), message });
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

/**
 * Semantic checks on a passed evidence artifact's own body. Commit identity
 * alone proves binding, not outcome: a "passed" manifest entry pointing at an
 * artifact whose recorded run failed (nonzero exit, failed status, failed
 * coverage module) is a false-green and must be reported.
 */
function artifactSemanticFailures(value: unknown): string[] {
	if (typeof value !== "object" || value === null) return [];
	const record = value as Record<string, unknown>;
	const failures: string[] = [];
	if (typeof record.exitCode === "number" && record.exitCode !== 0) {
		failures.push(`artifact records exitCode ${record.exitCode}`);
	}
	if (typeof record.status === "string" && record.status !== "passed") {
		failures.push(`artifact records status ${JSON.stringify(record.status)}`);
	}
	// Coverage floor-results artifacts carry per-module verdicts.
	for (const surface of ["native", "wasm"]) {
		const modules = record[surface];
		if (!Array.isArray(modules)) continue;
		for (const module of modules) {
			if (
				typeof module === "object" &&
				module !== null &&
				(module as { pass?: unknown }).pass === false
			) {
				failures.push(
					`coverage module ${(module as { module?: unknown }).module ?? "<unnamed>"} recorded pass=false`,
				);
			}
		}
	}
	// Multi-run artifacts (e.g. dual-backend parity) record per-run exits.
	if (Array.isArray(record.runs)) {
		for (const [index, run] of record.runs.entries()) {
			if (
				typeof run === "object" &&
				run !== null &&
				typeof (run as { exitCode?: unknown }).exitCode === "number" &&
				(run as { exitCode: number }).exitCode !== 0
			) {
				failures.push(`artifact run[${index}] records a nonzero exitCode`);
			}
		}
	}
	return failures;
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
			const artifact = JSON.parse(artifactText);
			const commit = artifactCommit(artifact);
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
			for (const failure of artifactSemanticFailures(artifact)) {
				report(location, failure);
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
		if (
			claim.gaRequired !== undefined &&
			typeof claim.gaRequired !== "boolean"
		) {
			report(location, "gaRequired must be a boolean when present");
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
	for (const { name, threadName, workers, workerExpr } of RUNTIME_CONTRACTS) {
		const constructor = exactConstructor(workers);
		if (!architecture.includes(constructor)) {
			report(
				relative(ROOT, ARCHITECTURE_PATH),
				`must state the exact runtime constructor ${constructor} for ${name}`,
			);
		}
		const block = runtimeBlock(source, name);
		if (!block) {
			report(relative(ROOT, RUNTIME_SOURCE_PATH), `missing ${name} runtime`);
			continue;
		}
		const escapedExpr = workerExpr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (
			!new RegExp(
				`Builder::new_multi_thread\\(\\)\\s*\\.worker_threads\\(${escapedExpr}\\)`,
				"s",
			).test(block) ||
			block.includes("new_current_thread")
		) {
			report(
				relative(ROOT, RUNTIME_SOURCE_PATH),
				`${name} must build its runtime as Builder::new_multi_thread().worker_threads(${workerExpr})`,
			);
		}
		// Every measured alternative to the documented count was worse, so no
		// runtime may size itself from the host it happens to land on.
		if (/available_parallelism/.test(block)) {
			report(
				relative(ROOT, RUNTIME_SOURCE_PATH),
				`${name} must not derive its worker count from the host`,
			);
		}
		if (!block.includes(`.thread_name("${threadName}")`)) {
			report(
				relative(ROOT, RUNTIME_SOURCE_PATH),
				`${name} must retain dedicated thread name ${threadName}`,
			);
		}
	}
	// The server's literal moved into the resolver, so the resolver carries the
	// contract now: default 2, bounded 1..=8, fail closed on anything else.
	for (const required of SERVER_WORKERS_REQUIRED_SOURCE) {
		if (!source.includes(required)) {
			report(
				relative(ROOT, RUNTIME_SOURCE_PATH),
				`server_worker_threads() must contain ${required}`,
			);
		}
	}
	if (!architecture.includes(SERVER_WORKERS_ENV)) {
		report(
			relative(ROOT, ARCHITECTURE_PATH),
			`must document the ${SERVER_WORKERS_ENV} override of the server worker count`,
		);
	}
}

// Wrapping a per-datagram N-API call in `RUNTIME.spawn` puts it on the server
// runtime's injection queue, which a busy worker services one task per tick —
// the ~5,000/s collapse. The documented contract is that read, send, and
// per-datagram discard stay on the N-API runtime, so policy it at the source
// rather than trusting prose. Bulk `discard_datagrams` is a different site.
const DATAGRAM_NO_HOP_METHODS = [
	{
		fn: "send_datagram",
		signature: "pub fn send_datagram(&self, env: Env",
		label: "sendDatagram",
	},
	{
		fn: "read_datagram",
		signature: "pub fn read_datagram(&self, env: Env)",
		label: "readDatagram",
	},
	{
		fn: "read_datagram_batch",
		signature: "pub fn read_datagram_batch(&self, env: Env",
		label: "readDatagramBatch",
	},
	{
		fn: "discard_datagram",
		signature: "pub fn discard_datagram(&self, env: Env",
		label: "discardDatagram",
	},
] as const;

function methodBody(source: string, signature: string): string | undefined {
	const start = source.indexOf(signature);
	if (start < 0) return undefined;
	const rest = source.slice(start);
	const next = rest.search(/\n    pub fn /);
	return next < 0 ? rest : rest.slice(0, next);
}

function checkDatagramDeliveryPath(): void {
	const architecture = readText(ARCHITECTURE_PATH);
	const source = readText(SESSION_NAPI_SOURCE_PATH);
	if (architecture === undefined || source === undefined) return;

	if (!/must\s+not be wrapped in `RUNTIME\.spawn`/.test(architecture)) {
		report(
			relative(ROOT, ARCHITECTURE_PATH),
			"must document that readDatagram, readDatagramBatch, sendDatagram, and discardDatagram run on the N-API runtime and must not be wrapped in `RUNTIME.spawn`",
		);
	}
	for (const method of DATAGRAM_NO_HOP_METHODS) {
		if (!architecture.includes(method.label)) {
			report(
				relative(ROOT, ARCHITECTURE_PATH),
				`must name ${method.label} in the no-hop delivery contract`,
			);
		}
		const body = methodBody(source, method.signature);
		if (body === undefined) {
			report(
				relative(ROOT, SESSION_NAPI_SOURCE_PATH),
				`missing ${method.fn} entry point`,
			);
			continue;
		}
		if (
			/RUNTIME\s*\.\s*spawn/.test(
				body
					.split("\n")
					.filter((line) => !/^\s*\/\//.test(line))
					.join("\n"),
			)
		) {
			report(
				relative(ROOT, SESSION_NAPI_SOURCE_PATH),
				`${method.fn} must not hop onto the server runtime: RUNTIME.spawn puts the call on the injection queue and caps it near 5,000/s`,
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

/**
 * The three operator-facing soak contracts have to agree on the hosted H7 lane
 * exactly, and none of them may present it as a substitute for the release
 * soak policy it supplements.
 */
function checkHostedH7Contract(): void {
	for (const path of [CI_PATH, RELEASE_CHECKLIST_PATH, LOAD_README_PATH]) {
		const doc = readText(path);
		if (doc === undefined) continue;
		const location = relative(ROOT, path);
		for (const required of H7_REQUIRED_TEXT) {
			if (!doc.includes(required)) {
				report(
					location,
					`H7 hosted closure lane contract is missing required text: ${required}`,
				);
			}
		}
		for (const [parameter, pinned] of H7_PINNED_VALUES) {
			// The leading boundary keeps `sessions=` from matching a longer
			// parameter such as `max_sessions=`, and only digit values are read so
			// placeholder text stays out of it.
			const dispatched = new RegExp(`(?<![\\w-])${parameter}=(\\d+)`, "g");
			const reported = new Set<string>();
			for (const match of doc.matchAll(dispatched)) {
				const found = match[1];
				if (found === undefined || found === pinned || reported.has(found)) {
					continue;
				}
				reported.add(found);
				// The rule is deliberately blunt, so the message has to carry the
				// way out. Someone describing another lane or a past configuration
				// trips this honestly, and without a stated remedy the tempting fix
				// is to weaken the rule that closes the contradiction bypass.
				report(
					location,
					`contradicts the pinned H7 dispatch value ${parameter}=${pinned}: found ${parameter}=${found}. ` +
						`If that value belongs to a different lane or to a past configuration, write it in prose ` +
						`("8 datagrams per batch", "a 900 MB ceiling") instead: the ${parameter}=<value> form is ` +
						`reserved for the pinned H7 dispatch values, so do not relax this rule to make room for it.`,
				);
			}
		}
		if (path === RELEASE_CHECKLIST_PATH) continue;
		for (const stale of STALE_SOAK_MODE_LISTS) {
			if (doc.includes(stale)) {
				report(
					location,
					`soak-long mode list "${stale}" omits the 2-hour H7 hosted closure lane`,
				);
			}
		}
	}

	const checklist = readText(RELEASE_CHECKLIST_PATH);
	if (checklist !== undefined) {
		const location = relative(ROOT, RELEASE_CHECKLIST_PATH);
		for (const stale of STALE_SELF_HOSTED_SEGMENTATION) {
			if (checklist.includes(stale)) {
				report(
					location,
					`contradicts the workflow-enforced self-hosted segmentation: "${stale}"`,
				);
			}
		}
		// Matched against collapsed lowercase text so the required sentence may
		// wrap or start a sentence in prose.
		const normalized = checklist.toLowerCase().replaceAll(/\s+/g, " ");
		if (
			!normalized.includes(
				"self-hosted 24h and 72h campaigns use segment_count=1",
			)
		) {
			report(
				location,
				"must state that self-hosted 24h and 72h campaigns use segment_count=1",
			);
		}
		for (const hosted of ["segment_count=5", "segment_count=15"]) {
			if (!checklist.includes(hosted)) {
				report(
					location,
					`must retain the GitHub-hosted segmentation value ${hosted}`,
				);
			}
		}
	}

	const loadReadme = readText(LOAD_README_PATH);
	if (loadReadme !== undefined) {
		const location = relative(ROOT, LOAD_README_PATH);
		if (!loadReadme.includes("legacy local diagnostic")) {
			report(
				location,
				"must label the 30-minute soak.ts path a legacy local diagnostic",
			);
		}
		for (const line of loadReadme.split("\n")) {
			const isLocalDiagnostic = LOCAL_DIAGNOSTIC_MARKERS.some((marker) =>
				line.includes(marker),
			);
			const claimsHostedEvidence = HOSTED_EVIDENCE_WORDS.some((word) =>
				line.includes(word),
			);
			if (isLocalDiagnostic && claimsHostedEvidence) {
				report(
					location,
					"the local soak.ts diagnostic must not be described as H7, release, or soak-long evidence",
				);
				break;
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
			const blocksGa = claim.gaRequired !== false;
			if (blocksGa && claim.status !== "passed") {
				report(
					"release-status.candidate.readiness",
					`ready release still has non-passing gaRequired claim ${claim.id}`,
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
checkDatagramDeliveryPath();
checkNarrativeStatusTruth();
checkHostedH7Contract();

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
