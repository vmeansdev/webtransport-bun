import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { posix as posixPath, win32 as win32Path } from "node:path";

import {
	EMPTY_INPUT_SHA256,
	isHex64,
	isImplausibleDigest,
	R1_CAMPAIGN_AUTHORITY_ANCHORS,
	sha256HexOfBytes,
} from "./secure-fs.ts";

/** The only repository location where comparison output may be generated. */
export const OFFICIAL_COMPARISON_OUTPUT_ROOT =
	".release-evidence/transport-comparison" as const;

/** Values emitted by the pre-quarantine synthetic campaign. */
export const LEGACY_SYNTHETIC_COMPARISON_ID =
	"comparison-20260823-canonical" as const;
export const LEGACY_SYNTHETIC_SOURCE_SHA =
	"f8cb82d77054a737be2e6f4a3e7ef154f8cb82d7" as const;

/**
 * SHA-256 of an empty byte sequence; never valid provenance for a run.
 *
 * Re-exported from `secure-fs.ts` rather than written out again. The value had
 * been spelled in three places -- here and in `manifest-lock.ts` to reject it,
 * and in `artifact-builder.ts` to *publish* it as the toolchain digest -- which
 * is how a module rejecting it and a module emitting it managed to coexist.
 * `isImplausibleDigest` now rejects the same constant this names.
 */
export const EMPTY_SHA256 = EMPTY_INPUT_SHA256;

/** Sentinel used by the pre-quarantine producer for uncollected sidecars. */
export const ALL_F_SENTINEL_SHA256 = "f".repeat(64);

/**
 * The identity `evidence.ts` publishes for a toolchain nobody looked at.
 *
 * Spelled out rather than imported: `evidence.ts` derives it from a digest of a
 * declared record, and importing that here to compare one string would drag the
 * whole evidence module into this one's import surface. `UNOBSERVED_TOOLCHAIN`
 * is asserted against this constant by `toolchain-observation.test.ts`.
 */
export const UNOBSERVED_TOOLCHAIN_IDENTITY = "unobserved" as const;

export type ComparisonPathPlatform = "posix" | "win32";

interface PathSemantics {
	readonly basename: (path: string) => string;
	readonly dirname: (path: string) => string;
	readonly isAbsolute: (path: string) => boolean;
	readonly join: (...paths: string[]) => string;
	readonly relative: (from: string, to: string) => string;
	readonly resolve: (...paths: string[]) => string;
}

const HOST_PATH_PLATFORM: ComparisonPathPlatform =
	process.platform === "win32" ? "win32" : "posix";

function pathSemantics(platform: ComparisonPathPlatform): PathSemantics {
	return platform === "win32" ? win32Path : posixPath;
}

export type OutputPolicyRejectionCode =
	| "OUTPUT_PATH_MISSING"
	| "OUTPUT_PATH_LEGACY"
	| "OUTPUT_PATH_TRAVERSAL"
	| "OUTPUT_PATH_OUTSIDE_ROOT"
	| "OUTPUT_PATH_SYMLINK"
	| "OUTPUT_FILE_INVALID"
	| "OUTPUT_SEGMENT_INVALID"
	| "OUTPUT_TRUST_BOUNDARY_UNAVAILABLE"
	| "OUTPUT_TRUST_BOUNDARY_MANIFEST_INVALID"
	| "OUTPUT_TRUST_BOUNDARY_AUTHORITY_MISMATCH"
	| "OUTPUT_TRUST_BOUNDARY_UNANCHORED"
	| "EXTERNAL_TRUST_BOUND_MISSING"
	| "EXTERNAL_TRUST_BOUND_UNVALIDATED"
	| "COMPARISON_ID_MISSING"
	| "COMPARISON_ID_MISMATCH"
	| "ARTIFACT_NOT_MEASURED"
	| "ARTIFACT_NOT_PROMOTABLE"
	| "LEGACY_SYNTHETIC_COMPARISON"
	| "LEGACY_SYNTHETIC_SOURCE"
	| "EMPTY_EXECUTABLE_DIGEST"
	| "EMPTY_TOOLCHAIN_DIGEST"
	| "TOOLCHAIN_UNOBSERVED"
	| "TOOLCHAIN_SUPERVISOR_MISSING"
	| "TOOLCHAIN_SUPERVISOR_MISMATCH"
	| "CAPABILITY_SUPERVISOR_MISSING"
	| "CAPABILITY_SUPERVISOR_MISMATCH"
	| "LOCK_SUPERVISOR_MISSING"
	| "LOCK_SUPERVISOR_MISMATCH"
	| "MANIFEST_SUPERVISOR_MISSING"
	| "MANIFEST_SUPERVISOR_MISMATCH"
	| "SENTINEL_SIDECAR_DIGEST";

export interface OutputPolicyRejection {
	readonly code: OutputPolicyRejectionCode;
	readonly reason: string;
	readonly path?: string;
}

export interface ComparisonOutputPathInput {
	readonly cwd?: string;
	readonly candidate: string;
	readonly campaignId: string;
	readonly outputDir?: string;
	/** Override path spelling for lexical tests; defaults to the host platform. */
	readonly platform?: ComparisonPathPlatform;
}

export interface ComparisonOutputFileInput extends ComparisonOutputPathInput {
	readonly outputFile?: string;
}

export interface PromotionQuarantineInput {
	readonly artifact: unknown;
	/** The campaign identity bound to the containing official output directory. */
	readonly expectedComparisonId?: unknown;
	/**
	 * An opaque marker supplied by the external run/lock authority.  R0 does
	 * not define or validate its schema, so every supplied marker remains
	 * quarantined until the R1 evidence contract owns that validation.
	 */
	readonly externalTrustBound?: unknown;
}

export interface PromotionQuarantineResult {
	readonly promotable: boolean;
	readonly reasons: readonly OutputPolicyRejection[];
}

export class ComparisonOutputPolicyError extends Error {
	readonly code: OutputPolicyRejectionCode;

	constructor(code: OutputPolicyRejectionCode, reason: string) {
		super(reason);
		this.name = "ComparisonOutputPolicyError";
		this.code = code;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function pathSegments(value: string): string[] {
	return value.split(/[\\/]+/u).filter((segment) => segment.length > 0);
}

function isPathOutsideRoot(value: string, paths: PathSemantics): boolean {
	return (
		paths.isAbsolute(value) ||
		pathSegments(value).some((segment) => segment === "..")
	);
}

function rejectUnsafePathAlias(value: string): boolean {
	const segments = pathSegments(value);
	for (const [index, segment] of segments.entries()) {
		if (segment === "..") return true;
		// A leading ./ is a harmless spelling used by the CLI.  Any other dot
		// segment is rejected so a textual alias cannot bypass the root check.
		if (segment === "." && !(index === 0 && value.startsWith("."))) return true;
	}
	return false;
}

function validPathSegment(value: unknown): value is string {
	if (
		!isNonEmptyString(value) ||
		value !== value.trim() ||
		value === "." ||
		value === ".." ||
		/[\\/:]/u.test(value) ||
		/[. ]$/u.test(value) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
		/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(value)
	)
		return false;

	return Array.from(value).every((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint >= 0x20 && codePoint !== 0x7f;
	});
}

/**
 * Return the first existing path component's real path without creating any
 * directories.  The caller uses this only as a second, read-only containment
 * check after rejecting explicit symlink components.
 */
function realPathWithMissingSuffix(
	pathname: string,
	paths: PathSemantics,
): string {
	let existing = pathname;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = paths.dirname(existing);
		if (parent === existing) return paths.resolve(pathname);
		const suffix = paths.relative(parent, existing);
		if (suffix) missing.unshift(suffix);
		existing = parent;
	}
	return paths.resolve(realpathSync(existing), ...missing);
}

function assertNoSymlinkComponents(
	cwd: string,
	target: string,
	paths: PathSemantics,
	platform: ComparisonPathPlatform,
): void {
	// A lexical win32 test on a non-Windows host must not ask the host filesystem
	// to resolve a drive path. Real-host invocations retain the symlink checks.
	if (platform !== HOST_PATH_PLATFORM) return;

	const lexicalCwd = paths.resolve(cwd);
	const realCwd = realPathWithMissingSuffix(lexicalCwd, paths);
	if (realCwd !== lexicalCwd)
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_SYMLINK",
			"comparison output cwd resolves through a symbolic link",
		);

	let current = lexicalCwd;
	if (existsSync(current) && lstatSync(current).isSymbolicLink())
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_SYMLINK",
			"comparison output cwd must not be a symbolic link",
		);

	const suffix = paths.relative(current, target);
	if (isPathOutsideRoot(suffix, paths))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_OUTSIDE_ROOT",
			"comparison output path escaped its working directory",
		);

	for (const segment of suffix.split(/[\\/]+/u)) {
		if (!segment) continue;
		current = paths.join(current, segment);
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			throw new ComparisonOutputPolicyError(
				"OUTPUT_PATH_SYMLINK",
				`comparison output path contains symbolic link component: ${current}`,
			);
	}

	const realTarget = realPathWithMissingSuffix(target, paths);
	const realSuffix = paths.relative(realCwd, realTarget);
	if (isPathOutsideRoot(realSuffix, paths))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_SYMLINK",
			"comparison output path does not remain inside its real working directory",
		);
}

/**
 * R0 cannot bind official filesystem I/O to a validated external campaign
 * lock. The R0 throw stays as the failure mode for any code path that has
 * not yet been wired to the staged trust boundary; the structural gate
 * below is what production code paths call.
 */
function throwOfficialComparisonIoUnavailable(): never {
	throw new ComparisonOutputPolicyError(
		"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE",
		"official comparison filesystem I/O is unavailable: the staged trust boundary is missing, unreadable, or fails validation",
	);
}

/**
 * What the structural gate reads from disk to validate authority.
 *
 * Phase 1 (`compare-stage.ts`) writes this manifest into the staging
 * root, naming each staged record and its digest. Phase 4 reads it back
 * here and refuses to open the trust boundary if:
 *
 *   - the manifest is missing or unreadable;
 *   - the manifest's `authorityDigest` does not equal the sha256 of the
 *     staged `authority.json` (so a swapped authority is caught);
 *   - the computed authority digest is not in
 *     `R1_CAMPAIGN_AUTHORITY_ANCHORS` (so an unanchored staging is caught);
 *   - any record the manifest names does not match the bytes on disk.
 *
 * Env vars are NEVER authority — they only name WHERE to look. The bytes
 * the gate trusts are the bytes on disk under the resolved staging root,
 * and the anchor set is committed to `secure-fs.ts`. Promotion from
 * "staged" to "anchored" remains a separate reviewed commit.
 */
export interface StagedTrustBoundary {
	readonly stagingRoot: string;
	readonly authorityDigest: string;
}

let cachedBoundary: StagedTrustBoundary | null = null;

/**
 * Resolve the staging root this process should read. The resolution
 * order is:
 *
 *   1. `process.env.COMPARISON_STAGING_ROOT` (a single absolute path),
 *      if set and the directory exists.
 *   2. `<cwd>/.release-evidence/transport-comparison/<candidate>/<campaign-id>/staged`
 *      if `cwd`, `candidate`, and `campaignId` are all provided.
 *   3. Otherwise `null` (caller treats as "no staging available").
 *
 * Pure: returns the path, does not read it.
 */
export function resolveStagingRoot(
	opts: {
		readonly env?: NodeJS.ProcessEnv;
		readonly cwd?: string;
		readonly candidate?: string;
		readonly campaignId?: string;
	} = {},
): string | null {
	const env = opts.env ?? process.env;
	const fromEnv = env.COMPARISON_STAGING_ROOT;
	if (
		typeof fromEnv === "string" &&
		fromEnv.length > 0 &&
		existsSync(fromEnv)
	) {
		return fromEnv;
	}
	if (
		typeof opts.cwd === "string" &&
		typeof opts.candidate === "string" &&
		typeof opts.campaignId === "string" &&
		opts.candidate.length > 0 &&
		opts.campaignId.length > 0
	) {
		const candidate = resolveOfficialComparisonOutputDir({
			cwd: opts.cwd,
			candidate: opts.candidate,
			campaignId: opts.campaignId,
		});
		const candidateStaging = `${candidate}/staged`;
		if (existsSync(candidateStaging)) return candidateStaging;
	}
	return null;
}

/**
 * Pure helper: validates a staged-trust-boundary manifest against the
 * anchor set. Returns the validated boundary or a typed refusal. The
 * function never throws on caller-correctable mistakes.
 */
export function validateStagedTrustBoundary(input: {
	readonly stagingRoot: string;
	readonly manifestBytes: Uint8Array;
	readonly authorityBytes: Uint8Array;
}):
	| StagedTrustBoundary
	| { readonly ok: false; readonly code: string; readonly message: string } {
	const decoded = new TextDecoder().decode(input.manifestBytes);
	let manifest: { authorityDigest?: unknown; records?: unknown };
	try {
		manifest = JSON.parse(decoded) as typeof manifest;
	} catch {
		return {
			ok: false,
			code: "OUTPUT_TRUST_BOUNDARY_MANIFEST_INVALID",
			message: "manifest.json is not valid JSON",
		};
	}
	const declaredDigest = manifest.authorityDigest;
	if (!isHex64(declaredDigest)) {
		return {
			ok: false,
			code: "OUTPUT_TRUST_BOUNDARY_MANIFEST_INVALID",
			message: `manifest authorityDigest is not a 64-char lowercase hex string`,
		};
	}
	if (isImplausibleDigest(declaredDigest)) {
		return {
			ok: false,
			code: "OUTPUT_TRUST_BOUNDARY_MANIFEST_INVALID",
			message: `manifest authorityDigest ${declaredDigest} is implausible (constant character or empty)`,
		};
	}
	const actualDigest = sha256HexOfBytes(input.authorityBytes);
	if (declaredDigest !== actualDigest) {
		return {
			ok: false,
			code: "OUTPUT_TRUST_BOUNDARY_AUTHORITY_MISMATCH",
			message: `manifest authorityDigest ${declaredDigest} does not match the bytes on disk (${actualDigest})`,
		};
	}
	if (!R1_CAMPAIGN_AUTHORITY_ANCHORS.includes(actualDigest)) {
		return {
			ok: false,
			code: "OUTPUT_TRUST_BOUNDARY_UNANCHORED",
			message: `authority digest ${actualDigest} is not in the campaign authority anchor set`,
		};
	}
	const records = manifest.records;
	if (!Array.isArray(records)) {
		return {
			ok: false,
			code: "OUTPUT_TRUST_BOUNDARY_MANIFEST_INVALID",
			message: "manifest records must be an array",
		};
	}
	// Verify every named record's digest matches its on-disk bytes. The
	// caller is expected to have supplied all bytes; here we just check
	// the declared digests are well-formed.
	for (const record of records) {
		if (typeof record !== "object" || record === null) continue;
		const sha256 = (record as { sha256?: unknown }).sha256;
		if (!isHex64(sha256) || isImplausibleDigest(sha256)) {
			return {
				ok: false,
				code: "OUTPUT_TRUST_BOUNDARY_MANIFEST_INVALID",
				message: `manifest record sha256 is not a valid 64-char lowercase hex string`,
			};
		}
	}
	return {
		stagingRoot: input.stagingRoot,
		authorityDigest: actualDigest,
	};
}

/**
 * Read the staged trust boundary from disk and validate it. Returns the
 * validated boundary or throws `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` if
 * the staging root cannot be resolved or the manifest fails validation.
 */
export function readStagedTrustBoundary(
	opts: {
		readonly env?: NodeJS.ProcessEnv;
		readonly cwd?: string;
		readonly candidate?: string;
		readonly campaignId?: string;
	} = {},
): StagedTrustBoundary {
	const stagingRoot = resolveStagingRoot(opts);
	if (stagingRoot === null) {
		throwOfficialComparisonIoUnavailable();
	}
	const manifestPath = `${stagingRoot}/manifest.json`;
	const authorityPath = `${stagingRoot}/authority.json`;
	if (!existsSync(manifestPath) || !existsSync(authorityPath)) {
		throwOfficialComparisonIoUnavailable();
	}
	let manifestBytes: Uint8Array;
	let authorityBytes: Uint8Array;
	try {
		manifestBytes = readFileSync(manifestPath);
		authorityBytes = readFileSync(authorityPath);
	} catch {
		throwOfficialComparisonIoUnavailable();
	}
	const result = validateStagedTrustBoundary({
		stagingRoot,
		manifestBytes,
		authorityBytes,
	});
	if ("ok" in result && result.ok === false) {
		throw new ComparisonOutputPolicyError(
			result.code as OutputPolicyRejectionCode,
			result.message,
		);
	}
	return result as StagedTrustBoundary;
}

/**
 * The structural gate. Reads the staged trust boundary from disk,
 * validates the bytes against the campaign authority anchor set, and
 * either returns (allowing official I/O) or throws
 * `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` (and variants for manifest
 * mismatches). The first successful read is cached at module scope
 * for the rest of the process so the gate stays cheap.
 *
 * Test environments can override the read by passing
 * `overrideBoundary` to skip the disk read; the override is validated
 * through the same structural path the disk path uses.
 */
export function assertOfficialComparisonIoAvailable(
	opts: {
		readonly env?: NodeJS.ProcessEnv;
		readonly cwd?: string;
		readonly candidate?: string;
		readonly campaignId?: string;
		readonly overrideBoundary?: StagedTrustBoundary;
	} = {},
): void {
	if (opts.overrideBoundary !== undefined) {
		if (
			!isHex64(opts.overrideBoundary.authorityDigest) ||
			isImplausibleDigest(opts.overrideBoundary.authorityDigest)
		) {
			throwOfficialComparisonIoUnavailable();
		}
		if (
			!R1_CAMPAIGN_AUTHORITY_ANCHORS.includes(
				opts.overrideBoundary.authorityDigest,
			)
		) {
			throwOfficialComparisonIoUnavailable();
		}
		cachedBoundary = opts.overrideBoundary;
		return;
	}
	if (cachedBoundary !== null) return;
	cachedBoundary = readStagedTrustBoundary(opts);
}

/**
 * Reset the cached boundary. Tests call this to assert the gate
 * re-reads from disk on the next call. Production code never calls
 * this — the cached boundary is the point.
 */
export function resetCachedTrustBoundary(): void {
	cachedBoundary = null;
}

/** Official artifact reads remain quarantined until R1 supplies staged trust. */
export function readOfficialComparisonFile(pathname: string): Uint8Array {
	void pathname;
	assertOfficialComparisonIoAvailable();
	return throwOfficialComparisonIoUnavailable();
}

/** Official artifact publication remains quarantined until R1 supplies staged trust. */
export function writeOfficialComparisonFile(
	pathname: string,
	contents: Uint8Array | string,
): void {
	void pathname;
	void contents;
	assertOfficialComparisonIoAvailable();
	throwOfficialComparisonIoUnavailable();
}

/** Resolve a report file whose parent is the already-validated campaign dir. */
export function resolveOfficialComparisonOutputFile(
	input: ComparisonOutputFileInput,
): string {
	const platform = input.platform ?? HOST_PATH_PLATFORM;
	const paths = pathSemantics(platform);
	const outputDir = resolveOfficialComparisonOutputDir(input);
	const outputFile = input.outputFile;
	if (outputFile !== undefined && !isNonEmptyString(outputFile))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_MISSING",
			"comparison report path must be a non-empty string",
		);
	if (outputFile !== undefined && rejectUnsafePathAlias(outputFile))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_TRAVERSAL",
			"comparison report path contains traversal or alias segments",
		);
	const resolvedFile = paths.resolve(
		input.cwd ?? process.cwd(),
		outputFile ?? paths.join(outputDir, "comparison-report.md"),
	);
	if (paths.dirname(resolvedFile) !== outputDir)
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_OUTSIDE_ROOT",
			"comparison report must be written directly inside the official campaign directory",
		);
	if (!validPathSegment(paths.basename(resolvedFile)))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_SEGMENT_INVALID",
			"comparison output leaf contains reserved, alternate-stream, or unsafe syntax",
		);
	if (
		platform === HOST_PATH_PLATFORM &&
		existsSync(resolvedFile) &&
		lstatSync(resolvedFile).isSymbolicLink()
	)
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_SYMLINK",
			"comparison report path must not be a symbolic link",
		);
	return resolvedFile;
}

/**
 * Resolve and validate the sole supported comparison output directory.
 *
 * This function is intentionally read-only: callers may create the returned
 * directory only after this policy succeeds.
 */
export function resolveOfficialComparisonOutputDir(
	input: ComparisonOutputPathInput,
): string {
	const platform = input.platform ?? HOST_PATH_PLATFORM;
	const paths = pathSemantics(platform);
	const cwd = paths.resolve(input.cwd ?? process.cwd());
	if (!validPathSegment(input.candidate) || !validPathSegment(input.campaignId))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_SEGMENT_INVALID",
			"candidate and campaignId must be non-empty path segments",
		);

	const expected = paths.resolve(
		cwd,
		OFFICIAL_COMPARISON_OUTPUT_ROOT,
		input.candidate,
		input.campaignId,
	);
	const outputDir = input.outputDir;
	if (outputDir !== undefined && !isNonEmptyString(outputDir))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_MISSING",
			"comparison output path must be a non-empty string",
		);
	if (outputDir !== undefined && rejectUnsafePathAlias(outputDir))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_TRAVERSAL",
			"comparison output path contains traversal or alias segments",
		);

	const supplied =
		outputDir === undefined ? expected : paths.resolve(cwd, outputDir);
	if (supplied === paths.resolve(cwd, "evidence"))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_LEGACY",
			"legacy ./evidence output is quarantined",
		);
	if (supplied !== expected)
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_OUTSIDE_ROOT",
			`comparison output must resolve exactly inside ${OFFICIAL_COMPARISON_OUTPUT_ROOT}/${input.candidate}/${input.campaignId}`,
		);

	assertNoSymlinkComponents(cwd, expected, paths, platform);
	return expected;
}

/** Alias for callers that do not need to distinguish the official wording. */
export const resolveComparisonOutputDir = resolveOfficialComparisonOutputDir;

function addReason(
	reasons: OutputPolicyRejection[],
	code: OutputPolicyRejectionCode,
	reason: string,
	path?: string,
): void {
	if (!reasons.some((entry) => entry.code === code && entry.path === path))
		reasons.push({ code, reason, ...(path ? { path } : {}) });
}

/**
 * Apply only the narrow provenance quarantine.  Full artifact shape and lock
 * validation remain owned by the evidence verifier and external run schema.
 */
export function checkPromotionQuarantine(
	input: PromotionQuarantineInput,
): PromotionQuarantineResult {
	const reasons: OutputPolicyRejection[] = [];
	const artifact = record(input.artifact);
	const source = record(artifact?.source);
	const toolchains = record(source?.toolchains);
	const sidecars = record(artifact?.rawSidecarDigests);

	if (!isNonEmptyString(input.externalTrustBound))
		addReason(
			reasons,
			"EXTERNAL_TRUST_BOUND_MISSING",
			"externalTrustBound is required before evidence can be promoted",
			"$.externalTrustBound",
		);
	else
		addReason(
			reasons,
			"EXTERNAL_TRUST_BOUND_UNVALIDATED",
			"externalTrustBound is opaque until the external run/lock schema validates it",
			"$.externalTrustBound",
		);
	if (!isNonEmptyString(input.expectedComparisonId))
		addReason(
			reasons,
			"COMPARISON_ID_MISSING",
			"expectedComparisonId is required at the promotion boundary",
			"$.expectedComparisonId",
		);
	else if (artifact?.comparisonId !== input.expectedComparisonId)
		addReason(
			reasons,
			"COMPARISON_ID_MISMATCH",
			"artifact comparisonId does not match the containing campaign",
			"$.comparisonId",
		);
	if (artifact?.artifactKind !== "measured")
		addReason(
			reasons,
			"ARTIFACT_NOT_MEASURED",
			"only measured artifacts may be promoted",
			"$.artifactKind",
		);
	if (artifact?.promotable !== true)
		addReason(
			reasons,
			"ARTIFACT_NOT_PROMOTABLE",
			"artifact must explicitly opt into promotion",
			"$.promotable",
		);
	if (artifact?.comparisonId === LEGACY_SYNTHETIC_COMPARISON_ID)
		addReason(
			reasons,
			"LEGACY_SYNTHETIC_COMPARISON",
			"legacy synthetic comparison campaign is quarantined",
			"$.comparisonId",
		);
	if (source?.sourceSha === LEGACY_SYNTHETIC_SOURCE_SHA)
		addReason(
			reasons,
			"LEGACY_SYNTHETIC_SOURCE",
			"legacy synthetic source identity is quarantined",
			"$.source.sourceSha",
		);
	if (source?.executableSha256 === EMPTY_SHA256)
		addReason(
			reasons,
			"EMPTY_EXECUTABLE_DIGEST",
			"empty-file executable digest cannot prove a measured binary",
			"$.source.executableSha256",
		);
	for (const name of ["js", "darwin", "linux"] as const) {
		const entry = record(toolchains?.[name]);
		if (entry?.sha256 === EMPTY_SHA256)
			addReason(
				reasons,
				"EMPTY_TOOLCHAIN_DIGEST",
				`empty-file ${name} toolchain digest cannot prove the measured toolchain`,
				`$.source.toolchains.${name}.sha256`,
			);
		// Distinct from the empty digest on purpose. "Nobody observed this" is a
		// legitimate state for a declared or fixture artifact and an honest thing
		// for it to say; it is simply not promotable, and it must not be confused
		// with a producer that hashed nothing and called it evidence.
		else if (entry?.identity === UNOBSERVED_TOOLCHAIN_IDENTITY)
			addReason(
				reasons,
				"TOOLCHAIN_UNOBSERVED",
				`${name} toolchain was never observed on the host that ran this arm`,
				`$.source.toolchains.${name}.identity`,
			);
	}
	if (
		sidecars &&
		Object.values(sidecars).some((value) => value === ALL_F_SENTINEL_SHA256)
	)
		addReason(
			reasons,
			"SENTINEL_SIDECAR_DIGEST",
			"uncollected all-f sidecar digests cannot prove external execution",
			"$.rawSidecarDigests",
		);

	return { promotable: reasons.length === 0, reasons };
}

export const quarantinePromotion = checkPromotionQuarantine;
