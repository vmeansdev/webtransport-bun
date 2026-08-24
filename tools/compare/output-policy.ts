import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The only repository location where comparison output may be generated. */
export const OFFICIAL_COMPARISON_OUTPUT_ROOT =
	".release-evidence/transport-comparison" as const;

/** Values emitted by the pre-quarantine synthetic campaign. */
export const LEGACY_SYNTHETIC_COMPARISON_ID =
	"comparison-20260823-canonical" as const;
export const LEGACY_SYNTHETIC_SOURCE_SHA =
	"f8cb82d77054a737be2e6f4a3e7ef154f8cb82d7" as const;

/** SHA-256 of an empty byte sequence; never valid provenance for a run. */
export const EMPTY_SHA256 =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

/** Sentinel used by the pre-quarantine producer for uncollected sidecars. */
export const ALL_F_SENTINEL_SHA256 = "f".repeat(64);

export type OutputPolicyRejectionCode =
	| "OUTPUT_PATH_MISSING"
	| "OUTPUT_PATH_LEGACY"
	| "OUTPUT_PATH_TRAVERSAL"
	| "OUTPUT_PATH_OUTSIDE_ROOT"
	| "OUTPUT_PATH_SYMLINK"
	| "OUTPUT_SEGMENT_INVALID"
	| "EXTERNAL_TRUST_BOUND_MISSING"
	| "ARTIFACT_NOT_MEASURED"
	| "ARTIFACT_NOT_PROMOTABLE"
	| "LEGACY_SYNTHETIC_COMPARISON"
	| "LEGACY_SYNTHETIC_SOURCE"
	| "EMPTY_EXECUTABLE_DIGEST"
	| "EMPTY_TOOLCHAIN_DIGEST"
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
}

export interface ComparisonOutputFileInput extends ComparisonOutputPathInput {
	readonly outputFile?: string;
}

export interface PromotionQuarantineInput {
	readonly artifact: unknown;
	/**
	 * An opaque marker supplied by the external run/lock authority.  This
	 * policy deliberately does not define its schema; the evidence contract
	 * owns that concern.
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
	return (
		isNonEmptyString(value) &&
		value !== "." &&
		value !== ".." &&
		!/[\\/]/u.test(value) &&
		Array.from(value).every((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 0x20 && codePoint !== 0x7f;
		})
	);
}

/**
 * Return the first existing path component's real path without creating any
 * directories.  The caller uses this only as a second, read-only containment
 * check after rejecting explicit symlink components.
 */
function realPathWithMissingSuffix(pathname: string): string {
	let existing = pathname;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return resolve(pathname);
		missing.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	return resolve(realpathSync(existing), ...missing);
}

function assertNoSymlinkComponents(cwd: string, target: string): void {
	const lexicalCwd = resolve(cwd);
	const realCwd = realPathWithMissingSuffix(lexicalCwd);
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

	const suffix = relative(current, target);
	if (suffix.startsWith("..") || isAbsolute(suffix))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_OUTSIDE_ROOT",
			"comparison output path escaped its working directory",
		);

	for (const segment of suffix.split(/[\\/]+/u)) {
		if (!segment) continue;
		current = join(current, segment);
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			throw new ComparisonOutputPolicyError(
				"OUTPUT_PATH_SYMLINK",
				`comparison output path contains symbolic link component: ${current}`,
			);
	}

	const realTarget = realPathWithMissingSuffix(target);
	if (realTarget !== realCwd && !realTarget.startsWith(`${realCwd}/`))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_SYMLINK",
			"comparison output path does not remain inside its real working directory",
		);
}

/** Resolve a report file whose parent is the already-validated campaign dir. */
export function resolveOfficialComparisonOutputFile(
	input: ComparisonOutputFileInput,
): string {
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
	const resolvedFile = resolve(
		input.cwd ?? process.cwd(),
		outputFile ?? join(outputDir, "comparison-report.md"),
	);
	if (dirname(resolvedFile) !== outputDir)
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_OUTSIDE_ROOT",
			"comparison report must be written directly inside the official campaign directory",
		);
	if (existsSync(resolvedFile) && lstatSync(resolvedFile).isSymbolicLink())
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
	const cwd = resolve(input.cwd ?? process.cwd());
	if (!validPathSegment(input.candidate) || !validPathSegment(input.campaignId))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_SEGMENT_INVALID",
			"candidate and campaignId must be non-empty path segments",
		);

	const expected = resolve(
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

	const supplied = outputDir === undefined ? expected : resolve(cwd, outputDir);
	if (supplied === resolve(cwd, "evidence") || supplied.endsWith("/evidence"))
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_LEGACY",
			"legacy ./evidence output is quarantined",
		);
	if (supplied !== expected)
		throw new ComparisonOutputPolicyError(
			"OUTPUT_PATH_OUTSIDE_ROOT",
			`comparison output must resolve exactly inside ${OFFICIAL_COMPARISON_OUTPUT_ROOT}/${input.candidate}/${input.campaignId}`,
		);

	assertNoSymlinkComponents(cwd, expected);
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
	const toolchain = record(source?.toolchain);
	const sidecars = record(artifact?.rawSidecarDigests);

	if (!isNonEmptyString(input.externalTrustBound))
		addReason(
			reasons,
			"EXTERNAL_TRUST_BOUND_MISSING",
			"externalTrustBound is required before evidence can be promoted",
			"$.externalTrustBound",
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
	if (toolchain?.sha256 === EMPTY_SHA256)
		addReason(
			reasons,
			"EMPTY_TOOLCHAIN_DIGEST",
			"empty-file toolchain digest cannot prove the measured toolchain",
			"$.source.toolchain.sha256",
		);
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
