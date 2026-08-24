import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	basename as hostBasename,
	dirname as hostDirname,
	join as hostJoin,
	resolve as hostResolve,
	posix as posixPath,
	win32 as win32Path,
} from "node:path";

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

const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

let temporaryWriteSequence = 0;

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

function assertSafeOutputLeaf(pathname: string): void {
	try {
		const stat = lstatSync(pathname);
		if (stat.isSymbolicLink())
			throw new ComparisonOutputPolicyError(
				"OUTPUT_PATH_SYMLINK",
				"comparison output file must not be a symbolic link",
			);
		if (!stat.isFile())
			throw new ComparisonOutputPolicyError(
				"OUTPUT_FILE_INVALID",
				"comparison output file must be a regular file",
			);
	} catch (error: unknown) {
		if (error instanceof ComparisonOutputPolicyError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function assertSafeOutputParent(pathname: string): void {
	const parent = hostDirname(pathname);
	try {
		const stat = lstatSync(parent);
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new ComparisonOutputPolicyError(
				"OUTPUT_PATH_SYMLINK",
				"comparison output parent must be a real directory",
			);
		const lexicalParent = hostResolve(parent);
		if (realpathSync(parent) !== lexicalParent)
			throw new ComparisonOutputPolicyError(
				"OUTPUT_PATH_SYMLINK",
				"comparison output parent resolves through a symbolic link",
			);
	} catch (error: unknown) {
		if (error instanceof ComparisonOutputPolicyError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new ComparisonOutputPolicyError(
			"OUTPUT_FILE_INVALID",
			"comparison output parent directory does not exist",
		);
	}
}

/**
 * Read a campaign leaf without following a symbolic link between validation
 * and open.  The no-follow flag is available on the supported Unix hosts;
 * lstat remains the fallback on runtimes that do not expose it.
 */
export function readOfficialComparisonFile(pathname: string): Uint8Array {
	assertSafeOutputLeaf(pathname);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(pathname, constants.O_RDONLY | NO_FOLLOW_FLAG);
		if (realpathSync(pathname) !== hostResolve(pathname))
			throw new ComparisonOutputPolicyError(
				"OUTPUT_PATH_SYMLINK",
				"comparison input became a symbolic link before it was read",
			);
		if (!fstatSync(descriptor).isFile())
			throw new ComparisonOutputPolicyError(
				"OUTPUT_FILE_INVALID",
				"comparison input must be a regular file",
			);
		return new Uint8Array(readFileSync(descriptor));
	} catch (error: unknown) {
		if (error instanceof ComparisonOutputPolicyError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new ComparisonOutputPolicyError(
				"OUTPUT_PATH_SYMLINK",
				"comparison input became a symbolic link before it was opened",
			);
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * Publish a campaign leaf through a same-directory temporary file and atomic
 * rename.  The destination is rechecked before publication and temporary
 * files are always removed on failure.
 */
export function writeOfficialComparisonFile(
	pathname: string,
	contents: Uint8Array | string,
): void {
	assertSafeOutputParent(pathname);
	assertSafeOutputLeaf(pathname);

	const parent = hostDirname(pathname);
	const leaf = hostBasename(pathname);
	let temporaryPath: string | undefined;
	let descriptor: number | undefined;
	try {
		for (let attempt = 0; attempt < 16; attempt++) {
			const sequence = temporaryWriteSequence++;
			const candidate = hostJoin(
				parent,
				`.${leaf}.tmp-${process.pid}-${sequence}`,
			);
			try {
				descriptor = openSync(
					candidate,
					constants.O_WRONLY |
						constants.O_CREAT |
						constants.O_EXCL |
						NO_FOLLOW_FLAG,
					0o600,
				);
				temporaryPath = candidate;
				if (realpathSync(candidate) !== hostResolve(candidate))
					throw new ComparisonOutputPolicyError(
						"OUTPUT_PATH_SYMLINK",
						"comparison temporary file escaped its campaign directory",
					);
				break;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		if (descriptor === undefined || temporaryPath === undefined)
			throw new ComparisonOutputPolicyError(
				"OUTPUT_FILE_INVALID",
				"could not allocate a unique comparison output temporary file",
			);
		writeFileSync(descriptor, contents);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;

		// A destination symlink that appeared after the first check is rejected
		// before rename; rename itself never follows the destination leaf.
		assertSafeOutputParent(pathname);
		assertSafeOutputLeaf(pathname);
		renameSync(temporaryPath, pathname);
		temporaryPath = undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (temporaryPath !== undefined) {
			try {
				unlinkSync(temporaryPath);
			} catch {}
		}
	}
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
	const toolchain = record(source?.toolchain);
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
